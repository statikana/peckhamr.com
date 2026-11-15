/**
 * Static-ability and replacement-effect grammar (ENGINE_ARCHITECTURE_PLAN.md section 2.1; groundwork
 * for Phases 6 and 7).
 *
 * Parses the sentences of a static ability line into StaticDefs (continuous effects with their
 * layer, cost modifiers, rule modifiers, multipliers) and ReplacementDefs. Input is normalised text
 * (self-references are `~`, reminder text and ability words stripped). A sentence is either fully
 * understood or reported as an unparsed span; nothing is approximated.
 *
 * Runs alongside the Phase 1 adapter for now. scripts/magic-statics-diff.ts compares it with the
 * adapter and with what the runtime actually does.
 */
import type {
	AbilityDef,
	ActivatedAbility,
	ActivationRestriction,
	Amount,
	Condition,
	CopyModificationSpec,
	CostDef,
	EffectStep,
	EventPattern,
	KeywordDef,
	Layer,
	LayerMod,
	ObjectFilter,
	ReplacementDef,
	Span,
	StaticDef,
	TargetSpec,
	Timing,
	TokenSpec
} from '../ir.ts';
import {
	buildCrewAbility,
	buildSaddleAbility,
	getKeywordSpec,
	STATIC_CONTINUOUS_KEYWORDS as KEYWORDS
} from '../keywords.ts';
import { normalizeCounterName, type CounterType, type ManaColor, type ZoneType } from '../types.ts';
import {
	COUNTERS,
	parseAdditionalCostSentence,
	parseCost,
	parseCostModifierSentence,
	parseDevotionColorList,
	parseObjectPhrase
} from './costs.ts';
import { parseEffects } from './effects.ts';
import { staticallyInterpretable, triggerTargetsSupported } from './interpretable.ts';
import { splitSentences } from './normalize.ts';
import {
	parseActivatedIfConditionSentence,
	parseCondition,
	parseTriggerHeader,
	runtimeTriggerProblem
} from './triggers.ts';

export type StaticItem =
	| { kind: 'static'; static: StaticDef }
	| { kind: 'replacement'; replacement: ReplacementDef };

export interface StaticParse {
	items: StaticItem[];
	/** Sentences no production understood, as offsets into the caller's text. */
	unparsed: Span[];
}

type Affected = ObjectFilter | 'attachedTo' | 'self';

// ---- Words ----------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
	a: 1,
	an: 1,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
	twenty: 20,
	thirty: 30,
	forty: 40
};

function count(word: string): Amount | null {
	const low = word.toLowerCase();
	if (low === 'x') return { k: 'x' };
	if (/^\d+$/.test(low)) return { k: 'const', n: parseInt(low, 10) };
	return NUMBER_WORDS[low] === undefined ? null : { k: 'const', n: NUMBER_WORDS[low] };
}

const n = (value: number): Amount => ({ k: 'const', n: value });

const COLORS: Record<string, ManaColor> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const CARD_TYPES: Record<string, string> = {
	artifact: 'Artifact',
	creature: 'Creature',
	enchantment: 'Enchantment',
	land: 'Land',
	planeswalker: 'Planeswalker',
	battle: 'Battle'
};
const BASIC_LAND_TYPES: Record<string, string> = {
	plains: 'Plains',
	island: 'Island',
	islands: 'Island',
	swamp: 'Swamp',
	swamps: 'Swamp',
	mountain: 'Mountain',
	mountains: 'Mountain',
	forest: 'Forest',
	forests: 'Forest'
};

/**
 * "flying, first strike, vigilance, trample, haste, and protection from black and from red" ->
 * keywords in lower case. Null unless every item is a keyword.
 */
export function parseKeywordList(text: string): string[] | null {
	let rest = text.trim();
	const out: string[] = [];
	const prot = rest.search(/\bprotection from\b/i);
	const protections: string[] = [];
	if (prot >= 0) {
		const rawProt = rest.slice(prot).trim().toLowerCase();
		rest = rest.slice(0, prot).replace(/(?:,\s*and|,|\band)\s*$/i, '').trim();
		const normalizedProt =
			'protection from ' +
			rawProt
				.slice('protection from '.length)
				.replace(/,?\s*(?:and\s+)?protection from\s+/g, ' and from ');
		let single = normalizedProt;
		if (single === 'protection from each color') {
			single = 'protection from all colors';
		}
		if (
			/^protection from (?:[a-z]+(?:,? (?:and )?from [a-z]+)*|everything|all colors)$/.test(single)
		) {
			protections.push(single);
		} else {
			return null;
		}
	}
	if (rest) {
		for (const raw of rest.split(/,\s*(?:and\s+)?|\s+and\s+/)) {
			const kw = raw.trim().toLowerCase();
			if (!kw) continue;
			if (
				KEYWORDS.has(kw) ||
				/^(?:toxic|afflict|firebending|mobilize|rampage|renown) \d+$/.test(kw) ||
				/^hexproof from [a-z]+$/.test(kw)
			) {
				out.push(kw);
				continue;
			}
			const wardMatch = kw.match(/^ward(?:\s+|\s*[—-]\s*)(.+)$/);
			if (wardMatch) {
				const wardCostRaw = wardMatch[1].trim();
				if (/^\{[^}]+\}$/.test(wardCostRaw) || /^waterbend \{[^}]+\}$/.test(wardCostRaw)) {
					out.push(kw);
					continue;
				}
				const parsedWard = parseCost(wardCostRaw, 0);
				if (parsedWard.unparsed.length === 0 && parsedWard.defs.length > 0) {
					out.push(kw.replace(/\s*-\s*/, '—'));
					continue;
				}
			}
			return null;
		}
	}
	for (const p of protections) out.push(p);
	return out.length > 0 ? out : null;
}

/** "+1/+1", "-3/-0", "+2/+0". */
function ptDelta(text: string): [number, number] | null {
	const m = text.replace(/−/g, '-').match(/^([+-]\d+)\/([+-]\d+)$/);
	return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

function singularType(word: string): string {
	return word.endsWith('s') ? word.slice(0, -1) : word;
}

// ---- Affected objects -----------------------------------------------------------------------

function scaleAmount(factor: number, per: Amount): Amount {
	if (factor === 0) return n(0);
	if (factor === 1) return per;
	if (factor === -1) return { k: 'negate', of: per };
	return { k: 'mul', factor, of: per };
}

function lookupStaticCounter(raw: string): CounterType | null {
	const cleaned = raw.trim().toLowerCase().replace(/−/g, '-');
	return COUNTERS[cleaned] ?? normalizeCounterName(cleaned);
}

const OUTLAW_SUBTYPES = ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'];

function parseObjectPhraseCore(rawPhrase: string): ObjectFilter | null {
	let p = rawPhrase.trim().replace(/^(?:a|an)\s+/i, '');
	if (!p) return null;
	if (/^(other\s+)?commander creatures$/i.test(p)) {
		const isOther = /^other\s+/i.test(p);
		return { types: ['Creature'], isCommander: true, ...(isOther ? { other: true } : {}) };
	}
	if (/^(other\s+)?commanders?$/i.test(p)) {
		const isOther = /^other\s+/i.test(p);
		return { isCommander: true, ...(isOther ? { other: true } : {}) };
	}

	const extra: Partial<ObjectFilter> = {};
	const ownTail = p.match(/^(.+?)\s+you own$/i);
	if (ownTail) {
		p = ownTail[1].trim();
		extra.owner = 'you';
	}
	const midCtrl = p.match(
		/^(.+?)\s+(you control|your opponents control|an opponent controls|you don't control)\s+((?:with|without|that)\b.+)$/i
	);
	if (midCtrl) {
		p = `${midCtrl[1].trim()} ${midCtrl[3].trim()}`;
		extra.controller = midCtrl[2].toLowerCase() === 'you control' ? 'you' : 'opponent';
	}

	// Trailing state clauses
	for (let guard = 0; guard < 6; guard++) {
		const enteredM = p.match(/^(.+?)\s+that entered(?: the battlefield)? this turn$/i);
		if (enteredM) {
			p = enteredM[1].trim();
			extra.enteredThisTurn = true;
			continue;
		}
		const toughGtPow = p.match(/^(.+?)\s+with toughness greater than (?:its|their) power$/i);
		if (toughGtPow) {
			p = toughGtPow[1].trim();
			extra.toughnessGreaterThanPower = true;
			continue;
		}
		const mvParity = p.match(/^(.+?)\s+with (even|odd) mana values?$/i);
		if (mvParity) {
			p = mvParity[1].trim();
			extra.manaValueParity = mvParity[2].toLowerCase() as 'even' | 'odd';
			continue;
		}
		const mvChosen = p.match(/^(.+?)\s+with mana values? of the chosen quality$/i);
		if (mvChosen) {
			p = mvChosen[1].trim();
			extra.manaValueParity = 'chosenQuality';
			continue;
		}
		const mvNotChosen = p.match(/^(.+?)\s+without mana values? of the chosen quality$/i);
		if (mvNotChosen) {
			p = mvNotChosen[1].trim();
			extra.manaValueParity = 'notChosenQuality';
			continue;
		}
		// --- Track P22a: chosen-number MV, chosen-type/name, & linked-exile/nontoken-name qualifiers ---
		const mvEqChosenNum = p.match(/^(.+?)\s+with mana values? equal to the chosen number$/i);
		if (mvEqChosenNum) {
			p = mvEqChosenNum[1].trim();
			extra.manaValueEqualsChosenNumber = true;
			continue;
		}
		const ofChosenTypeQual = p.match(/^(.+?)\s+(?:of|with) the chosen (?:card )?type$/i);
		if (ofChosenTypeQual) {
			p = ofChosenTypeQual[1].trim();
			extra.ofChosenType = true;
			continue;
		}
		const ofChosenNameQual = p.match(/^(.+?)\s+(?:of|with) the chosen name$/i);
		if (ofChosenNameQual) {
			p = ofChosenNameQual[1].trim();
			extra.ofChosenName = true;
			continue;
		}
		const sameNameExile = p.match(
			/^(.+?)\s+with the same name as (?:a card exiled with ~|cards exiled with ~|the exiled card)$/i
		);
		if (sameNameExile) {
			p = sameNameExile[1].trim();
			extra.sameNameAsLinkedExile = true;
			continue;
		}
		const sameNameNontoken = p.match(/^(.+?)\s+with the same name as a nontoken permanent$/i);
		if (sameNameNontoken) {
			p = sameNameNontoken[1].trim();
			extra.sameNameAsNontokenPermanent = true;
			continue;
		}
		// --- End Track P22a ---
		const chosenPlCtrl = p.match(
			/^(.+?)\s+(?:the chosen player controls|controlled by the chosen player)$/i
		);
		if (chosenPlCtrl) {
			p = chosenPlCtrl[1].trim();
			extra.controlledByChosenPlayer = true;
			continue;
		}
		const stateThat = p.match(
			/^(.+?)\s+that (?:is|are) (enchanted|equipped|tapped|untapped)$/i
		);
		if (stateThat) {
			p = stateThat[1].trim();
			const sw = stateThat[2].toLowerCase();
			if (sw === 'enchanted') extra.enchanted = true;
			else if (sw === 'equipped') extra.equipped = true;
			else if (sw === 'tapped') extra.tapped = true;
			else extra.tapped = false;
			continue;
		}
		const noCtr = p.match(/^(.+?)\s+with no counters on (?:it|them)$/i);
		if (noCtr) {
			p = noCtr[1].trim();
			extra.hasAnyCounter = false;
			continue;
		}
		const anyCtr = p.match(/^(.+?)\s+with (?:one or more )?counters on (?:it|them)$/i);
		if (anyCtr) {
			p = anyCtr[1].trim();
			extra.hasAnyCounter = true;
			continue;
		}
		const namedCtr = p.match(
			/^(.+?)\s+with (?:a |an |one or more )?(.+?) counters? on (?:it|them)$/i
		);
		if (namedCtr) {
			const ctr = lookupStaticCounter(namedCtr[2]);
			if (ctr) {
				p = namedCtr[1].trim();
				extra.hasCounters = ctr;
				continue;
			}
		}
		const withoutKw = p.match(
			/^(.+?)\s+without ([a-z]+(?: strike)?)(?:\s+or\s+([a-z]+(?: strike)?))?$/i
		);
		if (withoutKw) {
			const k1 = parseKeywordList(withoutKw[2]);
			const k2 = withoutKw[3] ? parseKeywordList(withoutKw[3]) : [];
			if (k1 && k1.length === 1 && (!withoutKw[3] || (k2 && k2.length === 1))) {
				p = withoutKw[1].trim();
				extra.lacksKeywords = [...k1, ...(k2 ?? [])];
				continue;
			}
		}
		break;
	}

	// Trailing "with <kw1> or <kw2>"
	const withOrKw = p.match(/^(.+?)\s+with ([a-z]+(?: strike)?)\s+or\s+([a-z]+(?: strike)?)$/i);
	if (withOrKw) {
		const k1 = parseKeywordList(withOrKw[2]);
		const k2 = parseKeywordList(withOrKw[3]);
		const base = parseObjectPhraseCore(withOrKw[1]);
		if (k1?.length === 1 && k2?.length === 1 && base && !base.hasKeywords) {
			return {
				...extra,
				anyOf: [
					{ ...base, hasKeywords: k1 },
					{ ...base, hasKeywords: k2 }
				]
			};
		}
	}

	// Ctrl suffix inside p (e.g. "creatures you control with +1/+1 counters on them" -> p is now "creatures you control")
	const oppTail = p.match(/^(.+?)\s+(?:your opponents control|an opponent controls|you don't control)$/i);
	if (oppTail) {
		if (extra.controller) return null;
		p = oppTail[1].trim();
		extra.controller = 'opponent';
	}

	const direct = parseObjectPhrase(p, { allowPluralAndDisjunction: true });
	if (direct) {
		if (extra.controller && direct.controller && direct.controller !== extra.controller) {
			return null;
		}
		if (extra.owner && direct.owner && direct.owner !== extra.owner) return null;
		return { ...direct, ...extra };
	}

	// Leading state adjectives not handled in plural form by parseObjectPhrase
	const leadState = p.match(
		/^(other\s+|another\s+)?(equipped|enchanted|face-down|attacking or blocking|attacking|blocking|tapped|untapped|suspected|prepared|historic)\s+(.+)$/i
	);
	if (leadState) {
		const inner = parseObjectPhraseCore(leadState[3]);
		if (inner) {
			const adj = leadState[2].toLowerCase();
			const stateField: Partial<ObjectFilter> =
				adj === 'equipped'
					? { equipped: true }
					: adj === 'enchanted'
						? { enchanted: true }
						: adj === 'face-down'
							? { faceDown: true }
							: adj === 'attacking or blocking'
								? { attackingOrBlocking: true }
								: adj === 'attacking'
									? { attacking: true }
									: adj === 'blocking'
										? { blocking: true }
										: adj === 'tapped'
											? { tapped: true }
											: adj === 'untapped'
												? { tapped: false }
												: adj === 'suspected'
													? { suspected: true }
													: adj === 'prepared'
														? { isPrepared: true }
														: { historic: true };
			return {
				...inner,
				...(leadState[1] ? { other: true } : {}),
				...stateField,
				...extra
			};
		}
	}

	return null;
}

function parseObjectPhraseWithQualifiers(
	rawPhrase: string,
	allowDisj = true
): ObjectFilter | null {
	const core = parseObjectPhraseCore(rawPhrase);
	if (core) return core;
	if (!allowDisj) return null;

	const trimmed = rawPhrase.trim();
	// Mixed type/subtype disjunctions: "a creature, Spacecraft, or Planet you control",
	// "a land or Bird you control", "another Wolf or battle you control", "enchanted creatures or enchantment creatures"
	let sharedCtrl: ObjectFilter['controller'] | undefined;
	let body = trimmed;
	const sharedCtrlM = body.match(
		/^(.+?)\s+(you control|your opponents control|an opponent controls)$/i
	);
	if (sharedCtrlM && /\s+or\s+/i.test(sharedCtrlM[1])) {
		body = sharedCtrlM[1].trim();
		sharedCtrl = sharedCtrlM[2].toLowerCase() === 'you control' ? 'you' : 'opponent';
	}
	if (/\s+or\s+/i.test(body)) {
		const rawParts = body
			.split(/,\s*or\s+|\s+or\s+|,\s*/)
			.map((x) => x.trim())
			.filter(Boolean);
		if (rawParts.length >= 2 && rawParts.length <= 4) {
			const filters: ObjectFilter[] = [];
			let allOk = true;
			for (const rp of rawParts) {
				const pf = parseObjectPhraseCore(rp);
				if (!pf) {
					allOk = false;
					break;
				}
				filters.push(pf);
			}
			if (allOk && filters.length >= 2) {
				return {
					anyOf: filters,
					...(sharedCtrl ? { controller: sharedCtrl } : {})
				};
			}
		}
	}
	return null;
}

/**
 * The subject of a continuous effect: "~", "equipped creature", "Other Elf creatures you control",
 * "Creatures your opponents control", "All creatures", "Each land", "Nonbasic lands".
 */
export function parseAffected(subject: string): Affected | null {
	const s = subject.trim();
	if (s === '~' || /^(?:it|he|she)$/i.test(s)) return 'self';
	if (/^(?:both creatures|each of those creatures)$/i.test(s)) {
		return { types: ['Creature'], pairedWithSource: true };
	}
	if (
		/^(?:equipped|enchanted) (?:creature|permanent|land|artifact|enchantment|planeswalker|vehicle|mount|spacecraft|equipment|wall|plains|island|swamp|mountain|forest)$/i.test(
			s
		)
	) {
		return 'attachedTo';
	}
	if (/^sources? (?:with|of) the chosen name$/i.test(s)) {
		return { ofChosenName: true };
	}
	// --- Track P22a: "the chosen creature/permanent/..." ---
	if (/^the chosen (?:creature|permanent|artifact|enchantment|land|planeswalker)$/i.test(s)) {
		return { chosenObject: true };
	}
	// --- End Track P22a ---
	const thatIsSub = s.match(
		/^(?:each\s+)?(other\s+)?(creature|permanent)s?\s+(you control|your opponents control|an opponent controls)?\s*that(?:'s| is| are) (?:a |an )?([A-Z][A-Za-z'-]*)(?:,\s*(?:a |an )?([A-Z][A-Za-z'-]*),?)?\s+or (?:a |an )?([A-Z][A-Za-z'-]*)$/i
	);
	if (thatIsSub) {
		const other = Boolean(thatIsSub[1]);
		const baseType = CARD_TYPES[thatIsSub[2].toLowerCase()];
		const rawCtrl = thatIsSub[3]?.toLowerCase();
		const ctrl: ObjectFilter['controller'] | undefined = !rawCtrl
			? undefined
			: rawCtrl === 'you control'
				? 'you'
				: 'opponent';
		const subs = [thatIsSub[4], thatIsSub[5], thatIsSub[6]].filter((x): x is string => Boolean(x));
		if (baseType && subs.every((sub) => /^[A-Z]/.test(sub))) {
			return {
				...(baseType === 'Creature' ? { types: ['Creature'] } : {}),
				subtypes: subs,
				...(other ? { other: true } : {}),
				...(ctrl ? { controller: ctrl } : {})
			};
		}
	}
	let phrase = s.replace(/^(?:all|each) /i, '');
	let controller: ObjectFilter['controller'];
	let owner: ObjectFilter['owner'];
	const ctrlDontOwn = phrase.match(/^(.+) you control but don't own$/i);
	if (ctrlDontOwn) {
		phrase = ctrlDontOwn[1];
		controller = 'you';
		owner = 'opponent';
	} else {
		const bothOwnCtrl = phrase.match(/^(.+) you both own and control$/i);
		if (bothOwnCtrl) {
			phrase = bothOwnCtrl[1];
			controller = 'you';
			owner = 'you';
		} else {
			const opp = phrase.match(
				/^(.+) (?:your opponents control|an opponent controls|you don't control)$/i
			);
			if (opp) {
				phrase = opp[1];
				controller = 'opponent';
			} else {
				const team = phrase.match(/^(.+) your team controls$/i);
				if (team) {
					phrase = team[1];
					controller = 'you';
				} else {
					const ownOnly = phrase.match(/^(.+) you own$/i);
					if (ownOnly) {
						phrase = ownOnly[1];
						owner = 'you';
					}
				}
			}
		}
	}
	let chosenTypeFlag = false;
	let chosenColorFlag = false;
	const ctrlChosen = phrase.match(
		/^(.+?) (you control|your opponents control|an opponent controls) of the chosen (card type|type|color)$/i
	);
	if (ctrlChosen) {
		phrase = `${ctrlChosen[1]} ${ctrlChosen[2]}`;
		if (ctrlChosen[3].toLowerCase() === 'color') chosenColorFlag = true;
		else chosenTypeFlag = true;
	}
	if (/^(other\s+)?outlaws(\s+you control)?$/i.test(phrase)) {
		const mOutlaw = phrase.match(/^(other\s+)?outlaws(\s+you control)?$/i)!;
		const f: ObjectFilter = {
			types: ['Creature'],
			subtypes: [...OUTLAW_SUBTYPES],
			...(mOutlaw[1] ? { other: true } : {}),
			...(mOutlaw[2] ? { controller: 'you' } : {})
		};
		if (controller) {
			if (f.controller) return null;
			f.controller = controller;
		}
		if (owner) f.owner = owner;
		if (chosenTypeFlag) f.ofChosenType = true;
		if (chosenColorFlag) f.ofChosenColor = true;
		return f;
	}
	const filter = parseObjectPhraseWithQualifiers(phrase, true);
	if (!filter) return null;
	if (controller) {
		if (filter.controller) return null;
		filter.controller = controller;
	}
	if (owner) {
		if (filter.owner) return null;
		filter.owner = owner;
	}
	if (chosenTypeFlag) filter.ofChosenType = true;
	if (chosenColorFlag) filter.ofChosenColor = true;
	return filter;
}

/** "the number of creatures you control", "the number of creature cards in all graveyards". */
function parseCountAmount(text: string): Amount | null {
	const t = text.trim();
	// --- Track P8: arithmetic "<Amount> plus <N>" / "<N> plus <Amount>" ---
	const plusRight = t.match(
		/^(.+?)\s+plus\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/i
	);
	if (plusRight) {
		const left = parseCountAmount(plusRight[1]);
		const right = count(plusRight[2]);
		if (left && right) return { k: 'sum', args: [left, right] };
	}
	const plusLeft = t.match(
		/^(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+plus\s+(.+)$/i
	);
	if (plusLeft) {
		const left = count(plusLeft[1]);
		const right = parseCountAmount(plusLeft[2]);
		if (left && right) return { k: 'sum', args: [left, right] };
	}
	const plusTwoAmounts = t.match(
		/^(.+?)\s+plus\s+(the (?:total )?number of .+|your devotion to .+|~'s (?:power|toughness|mana value))$/i
	);
	if (plusTwoAmounts) {
		const left = parseCountAmount(plusTwoAmounts[1]);
		const right = parseCountAmount(plusTwoAmounts[2]);
		if (left && right) return { k: 'sum', args: [left, right] };
	}
	const halfMatch = t.match(/^half (.+?),?\s+rounded (up|down)$/i);
	if (halfMatch) {
		const inner = parseCountAmount(halfMatch[1]);
		if (inner) {
			return { k: 'half', of: inner, round: halfMatch[2].toLowerCase() === 'up' ? 'up' : 'down' };
		}
	}
	// --- Track P11: multiplication, party, domain, energy, stats, attachments ---
	const twiceMatch = t.match(/^twice (.+)$/i);
	if (twiceMatch) {
		const inner = parseCountAmount(twiceMatch[1]);
		if (inner) return { k: 'mul', factor: 2, of: inner };
	}
	if (/^the number of creatures? in your party$/i.test(t)) {
		return { k: 'partyCount', player: { k: 'you' } };
	}
	if (/^the number of basic land types? among lands you control$/i.test(t)) {
		return { k: 'domain', player: { k: 'you' } };
	}
	if (/^(?:the amount of \{E\} you have|the number of energy counters? you have)$/i.test(t)) {
		return { k: 'energyCount', player: { k: 'you' } };
	}
	// --- Track P22a: Player-counter scaling, creatures-died-this-turn, spells-cast-this-turn, & distinct-name counts ---
	const playerCtrsMatch = t.match(
		/^the (?:total )?number of (poison|experience|energy|rad|ticket) counters? (you have|your opponents have|an opponent has|players have|all players have|defending player has)$/i
	);
	if (playerCtrsMatch) {
		const counter = playerCtrsMatch[1].toLowerCase() as
			| 'poison'
			| 'experience'
			| 'energy'
			| 'rad'
			| 'ticket';
		const whoRaw = playerCtrsMatch[2].toLowerCase();
		const players: 'you' | 'opponents' | 'all' | 'defendingPlayer' =
			whoRaw === 'you have'
				? 'you'
				: whoRaw === 'defending player has'
					? 'defendingPlayer'
					: whoRaw === 'players have' || whoRaw === 'all players have'
						? 'all'
						: 'opponents';
		return { k: 'playerCounters', counter, player: { k: 'you' }, players };
	}
	const diedTurnMatch = t.match(
		/^the number of creatures? that died(?: (under your control|under an opponent's control|under your opponents' control))? this turn$/i
	);
	if (diedTurnMatch) {
		const rawScope = diedTurnMatch[1]?.toLowerCase();
		const controller: 'you' | 'opponent' | 'any' = !rawScope
			? 'any'
			: rawScope === 'under your control'
				? 'you'
				: 'opponent';
		return { k: 'creaturesDiedThisTurn', controller };
	}
	const spellsYouCastMatch = t.match(
		/^the number of (?:(.+?) )?spells? you(?:'ve| have) cast this turn$/i
	);
	if (spellsYouCastMatch) {
		if (!spellsYouCastMatch[1]) {
			return { k: 'spellsCastThisTurnCount', who: 'you' };
		}
		const sf = parseObjectPhraseWithQualifiers(
			`${spellsYouCastMatch[1].replace(/\s+and\s+/gi, ' or ')} card`,
			true
		);
		if (sf && !sf.controller) {
			return { k: 'spellsCastThisTurnCount', filter: sf, who: 'you' };
		}
	}
	const diffNamedGy = t.match(
		/^the number of differently named (.+?) cards? in (your graveyard|all graveyards)$/i
	);
	if (diffNamedGy) {
		const f = parseGraveyardCardFilter(diffNamedGy[1]);
		if (f) {
			const isYours = diffNamedGy[2].toLowerCase() === 'your graveyard';
			return {
				k: 'distinctNamesCount',
				of: { ...f, zone: 'graveyard', ...(isYours ? { controller: 'you' } : {}) }
			};
		}
	}
	const diffNamedBf = t.match(
		/^the number of differently named (.+?)(?: on the battlefield)?$/i
	);
	if (diffNamedBf) {
		const rawDiff = diffNamedBf[1].trim();
		const oppDiff = rawDiff.match(/^(.+) (?:your opponents control|an opponent controls)$/i);
		if (oppDiff) {
			const fOpp = parseObjectPhraseWithQualifiers(oppDiff[1].replace(/\s+and\s+/gi, ' or '), true);
			if (fOpp && !fOpp.controller) {
				return {
					k: 'distinctNamesCount',
					of: { zone: 'battlefield', ...fOpp, controller: 'opponent' }
				};
			}
		} else {
			const fBf = parseObjectPhraseWithQualifiers(rawDiff.replace(/\s+and\s+/gi, ' or '), true);
			if (fBf) {
				return { k: 'distinctNamesCount', of: { zone: 'battlefield', ...fBf } };
			}
		}
	}
	// --- End Track P22a ---
	if (/^your speed$/i.test(t)) {
		return { k: 'playerSpeed', player: { k: 'you' } };
	}
	if (/^the number of unlocked doors among Rooms you control$/i.test(t)) {
		return { k: 'unlockedDoorsCount', player: { k: 'you' } };
	}
	if (/^the number of dungeons you(?:'ve| have) completed$/i.test(t)) {
		return { k: 'dungeonsCompleted', player: { k: 'you' } };
	}
	if (/^the number of colors among permanents you control$/i.test(t)) {
		return { k: 'colorsAmongPermanents', player: { k: 'you' } };
	}
	const colsAmongSub = t.match(/^the number of colors among (.+?) you control$/i);
	if (colsAmongSub) {
		const f = parseObjectPhrase(colsAmongSub[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) {
			return { k: 'colorsAmongPermanents', filter: f, player: { k: 'you' } };
		}
	}
	if (/^the number of colors of mana spent to cast (?:~|this spell|it)$/i.test(t)) {
		return { k: 'colorsOfManaSpentToCast' };
	}
	if (/^the amount of mana spent to cast (?:~|this spell|it)$/i.test(t)) {
		return { k: 'manaSpentToCast' };
	}
	if (/^the number of other spells? cast this turn$/i.test(t)) {
		return { k: 'stormCount' };
	}
	if (/^the number of opponents? whose life total is less than half their starting life total$/i.test(t)) {
		return { k: 'opponentsWithLifeLessThanHalfStarting' };
	}
	if (/^the (?:highest|last) number you noted for cards named ~$/i.test(t)) {
		return n(0);
	}
	if (/^the number of cards you removed from the draft with cards named ~$/i.test(t)) {
		return n(0);
	}
	if (/^the number of cards? in (?:the chosen|that) player's hand$/i.test(t)) {
		return { k: 'chosenPlayerZoneCount', zone: 'hand' };
	}
	if (/^the number of cards? in (?:the chosen|that) player's graveyard$/i.test(t)) {
		return { k: 'chosenPlayerZoneCount', zone: 'graveyard' };
	}
	const chosenGyTyped = t.match(
		/^the number of (.+?) cards? in (?:the chosen|that) player's graveyard$/i
	);
	if (chosenGyTyped) {
		const f = parseGraveyardCardFilter(chosenGyTyped[1]);
		if (f) return { k: 'chosenPlayerZoneCount', zone: 'graveyard', filter: f };
	}
	const chosenBfCtrl = t.match(
		/^the number of (.+?) (?:(?:the chosen|that) player controls|controlled by the chosen player)$/i
	);
	if (chosenBfCtrl) {
		const f = parseObjectPhraseWithQualifiers(
			chosenBfCtrl[1].replace(/\s+and\s+/gi, ' or '),
			true
		);
		if (f && !f.controller) {
			return { k: 'chosenPlayerZoneCount', zone: 'battlefield', filter: f };
		}
	}
	if (/^the number of permanents put into (?:a graveyard|graveyards) from the battlefield this turn$/i.test(t)) {
		return { k: 'gravestormCount' };
	}
	if (/^~'s (power|toughness|mana value)$/i.test(t)) {
		const kind = t.slice(4).toLowerCase();
		const stat = kind === 'power' ? 'power' : kind === 'toughness' ? 'toughness' : 'manaValue';
		return { k: 'stat', of: { k: 'self' }, stat };
	}
	const affStat = t.match(
		/^(?:its|(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)'s) (power|toughness|mana value)$/i
	);
	if (affStat) {
		const kind = affStat[1].toLowerCase();
		const stat = kind === 'power' ? 'power' : kind === 'toughness' ? 'toughness' : 'manaValue';
		return { k: 'stat', of: { k: 'affected' }, stat };
	}
	const attachedSelf = t.match(/^the number of (.+?) attached to ~$/i);
	if (attachedSelf) {
		const f = parseObjectPhrase(attachedSelf[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) {
			return {
				k: 'attachmentsOn',
				target: 'self',
				...(Object.keys(f).length > 0 ? { filter: f } : {})
			};
		}
	}
	const attachedHost = t.match(
		/^the number of (.+?) attached to (?:it|enchanted (?:creature|permanent|land|artifact|enchantment|planeswalker)|equipped creature)$/i
	);
	if (attachedHost) {
		const f = parseObjectPhrase(attachedHost[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) {
			return {
				k: 'attachmentsOn',
				target: 'attachedTo',
				...(Object.keys(f).length > 0 ? { filter: f } : {})
			};
		}
	}
	// --- End Track P11 ---
	// --- Track P14: devotion, greatestStatAmong, totalStatOf, opponentCount, colorsOfObject ---
	const devotionMatch = t.match(/^your devotion to (.+)$/i);
	if (devotionMatch) {
		const colors = parseDevotionColorList(devotionMatch[1]);
		if (colors) return { k: 'devotion', colors, player: { k: 'you' } };
	}
	const greatestMatch = t.match(
		/^the greatest (power|toughness|mana value) among (.+?) you control$/i
	);
	if (greatestMatch) {
		const rawStat = greatestMatch[1].toLowerCase();
		const stat =
			rawStat === 'power' ? 'power' : rawStat === 'toughness' ? 'toughness' : 'manaValue';
		const f = parseObjectPhrase(greatestMatch[2].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) {
			return {
				k: 'greatestStatAmong',
				stat,
				filter: { ...f, zone: 'battlefield', controller: 'you' }
			};
		}
	}
	const greatestGraveAny = t.match(
		/^the greatest (power|toughness|mana value) among cards in (your graveyard|all graveyards)$/i
	);
	if (greatestGraveAny) {
		const rawStat = greatestGraveAny[1].toLowerCase();
		const stat =
			rawStat === 'power' ? 'power' : rawStat === 'toughness' ? 'toughness' : 'manaValue';
		const isYours = greatestGraveAny[2].toLowerCase() === 'your graveyard';
		return {
			k: 'greatestStatAmong',
			stat,
			filter: { zone: 'graveyard', ...(isYours ? { controller: 'you' } : {}) }
		};
	}
	const greatestGrave = t.match(
		/^the greatest (power|toughness|mana value) among (.+?) cards? in (your graveyard|all graveyards)$/i
	);
	if (greatestGrave) {
		const rawStat = greatestGrave[1].toLowerCase();
		const stat =
			rawStat === 'power' ? 'power' : rawStat === 'toughness' ? 'toughness' : 'manaValue';
		const f = parseGraveyardCardFilter(greatestGrave[2]);
		if (f) {
			const isYours = greatestGrave[3].toLowerCase() === 'your graveyard';
			return {
				k: 'greatestStatAmong',
				stat,
				filter: { ...f, zone: 'graveyard', ...(isYours ? { controller: 'you' } : {}) }
			};
		}
	}
	const totalGrave = t.match(
		/^the total (power|toughness|mana value) of (.+?) cards? in (your graveyard|all graveyards)$/i
	);
	if (totalGrave) {
		const rawStat = totalGrave[1].toLowerCase();
		const stat =
			rawStat === 'power' ? 'power' : rawStat === 'toughness' ? 'toughness' : 'manaValue';
		const f = parseGraveyardCardFilter(totalGrave[2]);
		if (f) {
			const isYours = totalGrave[3].toLowerCase() === 'your graveyard';
			return {
				k: 'totalStatOf',
				stat,
				filter: { ...f, zone: 'graveyard', ...(isYours ? { controller: 'you' } : {}) }
			};
		}
	}
	const totalMatch = t.match(/^the total (power|toughness|mana value) of (.+?) you control$/i);
	if (totalMatch) {
		const rawStat = totalMatch[1].toLowerCase();
		const stat =
			rawStat === 'power' ? 'power' : rawStat === 'toughness' ? 'toughness' : 'manaValue';
		const f = parseObjectPhrase(totalMatch[2].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) {
			return {
				k: 'totalStatOf',
				stat,
				filter: { ...f, zone: 'battlefield', controller: 'you' }
			};
		}
	}
	if (/^the number of opponents you have$/i.test(t)) {
		return { k: 'opponentCount' };
	}
	if (/^the number of ~'s colors$/i.test(t) || /^the number of colors ~ is$/i.test(t)) {
		return { k: 'colorsOfObject', of: 'self' };
	}
	if (
		/^the number of (?:enchanted|equipped) (?:creature|permanent)'s colors$/i.test(t) ||
		/^the number of colors (?:enchanted|equipped) (?:creature|permanent) is$/i.test(t)
	) {
		return { k: 'colorsOfObject', of: 'attachedTo' };
	}
	// --- End Track P14 ---
	if (/^your life total$/i.test(t)) return { k: 'life', of: { k: 'you' } };
	if (/^the number of cards? in your hand$/i.test(t)) return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	if (/^the number of cards? in your library$/i.test(t)) {
		return { k: 'cardsIn', zone: 'library', of: { k: 'you' } };
	}
	if (/^the (?:total )?number of cards? in all players' hands$/i.test(t)) {
		return { k: 'count', of: { zone: 'hand' } };
	}
	if (/^the (?:total )?number of cards? in your opponents' hands$/i.test(t)) {
		return { k: 'count', of: { zone: 'hand', controller: 'opponent' } };
	}
	if (/^the number of cards? in your graveyard$/i.test(t)) {
		return { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } };
	}
	if (/^the number of cards? in your exile$/i.test(t) || /^the number of cards? you own in exile$/i.test(t)) {
		return { k: 'cardsIn', zone: 'exile', of: { k: 'you' } };
	}
	if (/^the number of cards? in all graveyards$/i.test(t)) {
		return { k: 'count', of: { zone: 'graveyard' } };
	}
	if (/^the (?:total )?number of cards? in your opponents' graveyards$/i.test(t)) {
		return { k: 'count', of: { zone: 'graveyard', controller: 'opponent' } };
	}
	if (/^the number of card types? among cards in your graveyard$/i.test(t)) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' };
	}
	if (/^the number of card types? among cards in all graveyards$/i.test(t)) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'all' };
	}
	if (/^the number of card types? among cards in your opponents' graveyards$/i.test(t)) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'opponents' };
	}
	if (/^the number of times? you've cast (?:your|a) commander from the command zone this game$/i.test(t)) {
		return { k: 'commanderCastCount' };
	}
	if (/^the number of counters? on (?:~|it)$/i.test(t)) {
		return { k: 'countersOn', counter: 'any', of: { k: 'self' } };
	}
	const countersOnSelf = t.match(/^the number of (.+?) counters? on (?:~|it)$/i);
	if (countersOnSelf) {
		const ctr = lookupStaticCounter(countersOnSelf[1]);
		if (ctr) return { k: 'countersOn', counter: ctr, of: { k: 'self' } };
	}
	const countersOnHost = t.match(
		/^the number of (.+?) counters? on (?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i
	);
	if (countersOnHost) {
		const rawC = countersOnHost[1].trim().toLowerCase();
		if (rawC === '') return null;
		const ctr = lookupStaticCounter(rawC);
		if (ctr) return { k: 'countersOn', counter: ctr, of: { k: 'affected' } };
	}
	if (/^the (?:total )?number of cards? you own in exile and in your graveyard$/i.test(t)) {
		return {
			k: 'sum',
			args: [
				{ k: 'cardsIn', zone: 'exile', of: { k: 'you' } },
				{ k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } }
			]
		};
	}
	const exileAndGyTyped = t.match(
		/^the (?:total )?number of (.+?) cards? you own in exile and in your graveyard$/i
	);
	if (exileAndGyTyped) {
		const f = parseGraveyardCardFilter(exileAndGyTyped[1]);
		if (f) {
			return {
				k: 'sum',
				args: [
					{ k: 'count', of: { ...f, zone: 'exile', owner: 'you' } },
					{ k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } }
				]
			};
		}
	}
	if (/^the number of cards? exiled with (?:~|it)$/i.test(t)) {
		return { k: 'count', of: { zone: 'exile', exiledWithSelf: true } };
	}
	const exiledWithTyped = t.match(/^the number of (.+?) cards? exiled with (?:~|it)$/i);
	if (exiledWithTyped) {
		const f = parseGraveyardCardFilter(exiledWithTyped[1]);
		if (f) return { k: 'count', of: { ...f, zone: 'exile', exiledWithSelf: true } };
	}
	const graveAll = t.match(/^the number of (.+?) cards? in all graveyards$/i);
	if (graveAll) {
		const f = parseGraveyardCardFilter(graveAll[1]);
		return f ? { k: 'count', of: { ...f, zone: 'graveyard' } } : null;
	}
	const graveYou = t.match(/^the number of (.+?) cards? in your graveyard$/i);
	if (graveYou) {
		const f = parseGraveyardCardFilter(graveYou[1]);
		return f ? { k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } } : null;
	}
	const graveOpp = t.match(/^the number of (.+?) cards? in your opponents' graveyards$/i);
	if (graveOpp) {
		const f = parseGraveyardCardFilter(graveOpp[1]);
		return f ? { k: 'count', of: { ...f, zone: 'graveyard', controller: 'opponent' } } : null;
	}
	const m = t.match(/^the number of (.+?)( on the battlefield)?$/i);
	if (!m) return null;
	const defCtrl = m[1].match(/^(.+) defending player controls$/i);
	if (defCtrl) {
		const fDef = parseObjectPhraseWithQualifiers(defCtrl[1].replace(/\s+and\s+/gi, ' or '), true);
		return fDef && !fDef.controller
			? { k: 'count', of: { zone: 'battlefield', ...fDef, controllerRef: { k: 'defendingPlayer' } } }
			: null;
	}
	const oppCtrl = m[1].match(/^(.+) (?:your opponents control|an opponent controls)$/i);
	if (oppCtrl) {
		const fOpp = parseObjectPhraseWithQualifiers(oppCtrl[1].replace(/\s+and\s+/gi, ' or '), true);
		return fOpp && !fOpp.controller
			? { k: 'count', of: { zone: 'battlefield', ...fOpp, controller: 'opponent' } }
			: null;
	}
	const f = parseObjectPhraseWithQualifiers(m[1].replace(/\s+and\s+/gi, ' or '), true);
	return f ? { k: 'count', of: { zone: 'battlefield', ...f } } : null;
}

const PERMANENT_CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];

function parseGraveyardCardFilter(raw: string): ObjectFilter | null {
	const trimmed = raw.trim();
	if (/^permanents?$/i.test(trimmed)) {
		return { types: [...PERMANENT_CARD_TYPES] };
	}
	const normalized = trimmed.replace(/\s+and\s+/gi, ' or ');
	return (
		parseObjectPhraseWithQualifiers(`${normalized} cards`, true) ??
		parseObjectPhraseWithQualifiers(`${normalized} card`, true)
	);
}

function parseCombatObjectPhrase(raw: string): ObjectFilter | null {
	const trimmed = raw.trim().replace(/^(?:a|an)\s+/i, '');
	const direct = parseObjectPhrase(trimmed);
	if (direct) return direct;
	// Color disjunction: "white or blue creatures", "black or red creatures"
	const colorOr = trimmed.match(
		/^(white|blue|black|red|green) (?:or|and\/or) (white|blue|black|red|green) (.+)$/i
	);
	if (colorOr) {
		const base = parseObjectPhrase(colorOr[3]);
		if (base && !base.colors) {
			return {
				...base,
				colors: [COLORS[colorOr[1].toLowerCase()], COLORS[colorOr[2].toLowerCase()]]
			};
		}
	}
	return parseObjectPhraseWithQualifiers(trimmed, true);
}

function splitCopyModificationClauses(raw: string): string[] {
	const s = raw.trim();
	const out: string[] = [];
	let start = 0;
	let inQuote = false;
	const nextVerbStartRe =
		/^(?:it(?:'s| is| isn't| has)|its name is|is\b|isn't\b|has\b)\b/i;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (inQuote) continue;
		if (ch === ',') {
			const seg = s.slice(start, i).trim();
			if (seg) out.push(seg);
			let nextIdx = i + 1;
			const afterComma = s.slice(nextIdx);
			const andAfter = afterComma.match(/^\s*and\s+/i);
			if (andAfter) nextIdx += andAfter[0].length;
			start = nextIdx;
			i = nextIdx - 1;
			continue;
		}
		if (/\s/.test(ch)) {
			const andMatch = s.slice(i).match(/^\s+and\s+/i);
			if (andMatch) {
				const afterAnd = s.slice(i + andMatch[0].length).trimStart();
				if (nextVerbStartRe.test(afterAnd)) {
					const seg = s.slice(start, i).trim();
					if (seg) out.push(seg);
					start = i + andMatch[0].length;
					i = start - 1;
				}
			}
		}
	}
	const tail = s.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

function parseCopyModifications(raw: string): CopyModificationSpec | null {
	const spec: CopyModificationSpec = {};
	const clauses = splitCopyModificationClauses(raw);
	if (clauses.length === 0) return null;

	for (const clause of clauses) {
		const nameMatch = clause.match(/^its name is (~|[A-Z][^,"]+)$/i);
		if (nameMatch) {
			const rawName = nameMatch[1].trim();
			if (rawName === '~') spec.keepSelfName = true;
			else spec.overrideName = rawName;
			continue;
		}
		if (
			/^(?:it(?:'s| is) not|it isn't|isn't|is not) legendary$/i.test(clause)
		) {
			spec.removeSupertypes = [...(spec.removeSupertypes ?? []), 'Legendary'];
			continue;
		}
		if (
			/^(?:it(?:'s| is)|is) legendary(?: in addition to its other types)?$/i.test(clause)
		) {
			spec.addSupertypes = [...(spec.addSupertypes ?? []), 'Legendary'];
			continue;
		}
		if (/^(?:it )?has no mana cost$/i.test(clause)) {
			spec.noManaCost = true;
			continue;
		}
		const ptOnly = clause.match(/^(?:it(?:'s| is) |is )?(\d+)\/(\d+)$/i);
		if (ptOnly) {
			spec.power = parseInt(ptOnly[1], 10);
			spec.toughness = parseInt(ptOnly[2], 10);
			continue;
		}
		const addTypesOrSubs = clause.match(
			/^(?:it(?:'s| is)|is) (?:an? )?(.+?) in addition to its other (?:creature |land )?types$/i
		);
		if (addTypesOrSubs) {
			const words = addTypesOrSubs[1].trim().split(/\s+/).filter(Boolean);
			let inlinePt: [number, number] | undefined;
			if (words[0] && /^\d+\/\d+$/.test(words[0])) {
				const [pStr, tStr] = words.shift()!.split('/');
				inlinePt = [parseInt(pStr, 10), parseInt(tStr, 10)];
			}
			const addedTypes: string[] = [];
			const addedSubs: string[] = [];
			const addedSupers: string[] = [];
			let addedCols: ManaColor[] | undefined;
			let ok = true;
			for (const w of words) {
				const low = w.toLowerCase();
				if (low === 'legendary') addedSupers.push('Legendary');
				else if (CARD_TYPES[low]) addedTypes.push(CARD_TYPES[low]);
				else if (COLORS[low]) (addedCols ??= []).push(COLORS[low]);
				else if (/^[A-Z][A-Za-z'-]*$/.test(w)) addedSubs.push(w);
				else {
					ok = false;
					break;
				}
			}
			if (
				!ok ||
				(addedTypes.length === 0 && addedSubs.length === 0 && addedSupers.length === 0)
			) {
				return null;
			}
			if (inlinePt) {
				spec.power = inlinePt[0];
				spec.toughness = inlinePt[1];
			}
			if (addedSupers.length > 0) {
				spec.addSupertypes = [...(spec.addSupertypes ?? []), ...addedSupers];
			}
			if (addedTypes.length > 0) spec.addTypes = [...(spec.addTypes ?? []), ...addedTypes];
			if (addedSubs.length > 0) spec.addSubtypes = [...(spec.addSubtypes ?? []), ...addedSubs];
			if (addedCols) spec.setColors = addedCols;
			continue;
		}
		const addColor = clause.match(
			/^(?:it(?:'s| is)|is) (white|blue|black|red|green) in addition to its other colors$/i
		);
		if (addColor) {
			const col = COLORS[addColor[1].toLowerCase()];
			spec.addColors = [...(spec.addColors ?? []), col];
			continue;
		}
		const isColorOnly = clause.match(/^(?:it(?:'s| is)|is) (white|blue|black|red|green|colorless)$/i);
		if (isColorOnly) {
			const low = isColorOnly[1].toLowerCase();
			spec.setColors = low === 'colorless' ? [] : [COLORS[low]];
			continue;
		}
		const isDesc = clause.match(/^(?:it(?:'s| is)|is) an? (.+)$/i);
		if (isDesc) {
			const td = parseTypeDescription(isDesc[1]);
			if (!td) return null;
			if (td.basePT) {
				spec.power = td.basePT[0];
				spec.toughness = td.basePT[1];
			}
			if (td.colors !== undefined) spec.setColors = td.colors;
			if (td.types.length > 0) spec.setTypes = td.types;
			if (td.subtypes.length > 0) spec.addSubtypes = [...(spec.addSubtypes ?? []), ...td.subtypes];
			continue;
		}
		const hasQuoted = clause.match(/^(?:it )?has "([^"]+)"$/i);
		if (hasQuoted) {
			const rawQuoted = hasQuoted[1].trim();
			const parsedAbs = parseGrantedAbilities(rawQuoted, 0);
			if (!parsedAbs || parsedAbs.length === 0) return null;
			let normLine = normalizeQuotedAbilityText(rawQuoted);
			if (!/[.!?]$/.test(normLine)) normLine += '.';
			spec.addedAbilityTexts = [...(spec.addedAbilityTexts ?? []), normLine];
			continue;
		}
		const hasKw = clause.match(/^(?:it )?has (.+)$/i);
		if (hasKw) {
			const kws = parseKeywordList(hasKw[1]);
			if (!kws) return null;
			spec.addKeywords = [...(spec.addKeywords ?? []), ...kws];
			continue;
		}
		return null;
	}
	return Object.keys(spec).length > 0 ? spec : null;
}

// ---- Builders -------------------------------------------------------------------------------

function continuous(layer: Layer, affected: Affected, mod: LayerMod, condition?: Condition): StaticItem {
	const def: StaticDef = { k: 'continuous', layer, affected, mod };
	if (condition) def.condition = condition;
	return { kind: 'static', static: def };
}

function rule(r: Extract<StaticDef, { k: 'ruleModifier' }>['rule'], relation: 'you' | 'each_opponent' | 'each_player', params?: Record<string, unknown>): StaticItem {
	const def: StaticDef = { k: 'ruleModifier', rule: r, who: { relation } };
	if (params) def.params = params;
	return { kind: 'static', static: def };
}

function keywordGrant(affected: Affected, keywords: string[], condition?: Condition): StaticItem {
	return continuous('6', affected, { k: 'addKeywords', keywords }, condition);
}

function manaStepComplete(step: EffectStep): boolean {
	if (step.verb === 'freezeUntap') {
		return step.subject.k === 'self' && !step.condition && !step.optional;
	}
	return Boolean(
		step.params?.mana ||
			step.params?.manaChoice ||
			step.params?.manaWithChosenColor ||
			step.params?.manaBundles ||
			step.params?.manaCombinationColors
	);
}

const QUOTED_SELF_REF =
	/\bthis (?:creature|permanent|spell|card|artifact|enchantment|land|equipment|aura|vehicle|mount|spacecraft|planet|planeswalker|battle|saga|class|case|siege|token)(?='s\b|\b)/gi;

function normalizeQuotedAbilityText(raw: string): string {
	let out = raw.trim().replace(/,$/, '.').replace(QUOTED_SELF_REF, '~');
	out = out.replace(/^(when|whenever)\s+it\b/i, '$1 ~');
	return out;
}

/**
 * A quoted activated ability granted by a continuous effect (CR 613.1f, 201.5):
 * e.g. "{T}: Add {C}.", "{T}, Sacrifice ~: Add two mana of any one color.", "{1}, {T}: Draw a card."
 * Returns null if not an activated ability or if its cost or effect cannot be fully automated.
 */
function parseGrantedActivatedAbility(quoted: string): ActivatedAbility | null {
	const trimmed = normalizeQuotedAbilityText(quoted);
	const colon = trimmed.indexOf(':');
	if (colon <= 0 || /^(?:when|whenever|at|choose)\b/i.test(trimmed)) return null;

	const costText = trimmed.slice(0, colon).trim();
	const effectText = trimmed.slice(colon + 1);
	if (!costText || !effectText.trim()) return null;

	const cost = parseCost(costText, 0);
	if (cost.unparsed.length > 0) return null;

	const effect = parseEffects(effectText, colon + 1, 'activated');
	const rawSentences = splitSentences(effectText, colon + 1);
	const sentences = rawSentences.map((s) => s.text.toLowerCase());
	const isMana =
		effect.steps.length > 0 &&
		effect.targets.length === 0 &&
		effect.steps.some((s) => s.verb === 'addMana') &&
		effect.steps.every(
			(s) =>
				s.verb === 'addMana' ||
				(s.verb === 'freezeUntap' && s.subject.k === 'self' && !s.condition && !s.optional)
		);
	let sorcery = sentences.some((s) => /^(?:activate|equip) only as a sorcery\.?$/.test(s));

	const activationRestrictions: ActivationRestriction[] = [];
	const addRestriction = (tag: ActivationRestriction) => {
		if (!activationRestrictions.includes(tag)) activationRestrictions.push(tag);
	};
	if (sentences.some((s) => /^activate only once each turn\.?$/.test(s))) {
		addRestriction('onceEachTurn');
	}
	if (sentences.some((s) => /^activate only during your turn\.?$/.test(s))) {
		addRestriction('duringYourTurn');
	}
	if (sentences.some((s) => /^activate only during your upkeep\.?$/.test(s))) {
		addRestriction('duringYourUpkeep');
	}
	if (sentences.some((s) => /^activate only during combat\.?$/.test(s))) {
		addRestriction('duringCombat');
	}
	const activationConditions: Condition[] = [];
	for (const rs of rawSentences) {
		const condSpec = parseActivatedIfConditionSentence(rs.text);
		if (!condSpec) continue;
		activationConditions.push(condSpec.condition);
		if (condSpec.extra === 'as a sorcery') sorcery = true;
		else if (condSpec.extra === 'once each turn') addRestriction('onceEachTurn');
		else if (condSpec.extra === 'during your turn') addRestriction('duringYourTurn');
		else if (condSpec.extra === 'during your upkeep') addRestriction('duringYourUpkeep');
		else if (condSpec.extra === 'during combat') addRestriction('duringCombat');
	}
	const activationCondition: Condition | undefined =
		activationConditions.length === 1
			? activationConditions[0]
			: activationConditions.length > 1
				? { k: 'and', of: activationConditions }
				: undefined;
	const timing: Timing = isMana ? 'mana' : sorcery ? 'sorcery' : 'instant';

	const effectOk = isMana
		? effect.unparsed.length === 0 && effect.steps.every(manaStepComplete)
		: staticallyInterpretable(effect);
	if (!effectOk) return null;

	const span = { start: 0, end: trimmed.length };
	return {
		kind: 'activated',
		id: 'granted_0',
		cost: cost.defs,
		targets: effect.targets,
		effect: effect.steps,
		timing,
		isMana,
		...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
		...(activationCondition ? { activationCondition } : {}),
		text: trimmed,
		span
	};
}

function parseGrantedTriggeredAbility(quoted: string): AbilityDef | null {
	const trimmed = normalizeQuotedAbilityText(quoted);
	if (!/^(?:when|whenever|at)\b/i.test(trimmed)) return null;
	const head = parseTriggerHeader(trimmed, 0);
	if (!head || !head.trigger || head.unparsed.length > 0) return null;
	const { trigger, condition } = head;
	if (runtimeTriggerProblem(trigger)) return null;

	let headerEffectText = trimmed.slice(head.effectStart);
	const headerSentences = splitSentences(headerEffectText, head.effectStart);
	if (
		headerSentences.length >= 2 &&
		/^this ability triggers only once each turn\.?$/i.test(
			headerSentences[headerSentences.length - 1].text.trim()
		)
	) {
		trigger.onlyOncePerTurn = true;
		const lastSentence = headerSentences[headerSentences.length - 1];
		headerEffectText = headerEffectText.slice(0, lastSentence.span.start - head.effectStart).trimEnd();
	}

	const effect = parseEffects(headerEffectText, head.effectStart, 'triggered', trigger);
	if (!staticallyInterpretable(effect, true) || !triggerTargetsSupported(effect.targets)) {
		return null;
	}
	const span = { start: 0, end: trimmed.length };
	return {
		kind: 'triggered',
		trigger,
		...(condition ? { condition } : {}),
		targets: effect.targets,
		effect: effect.steps,
		text: trimmed,
		span
	};
}

/**
 * Generalized quoted ability parser (CR 613.1f, CR 201.5, CR 107.3j):
 * compiles quoted ActivatedAbility, TriggeredAbility, StaticDef, or ReplacementDef.
 */
function parseGrantedAbilities(quoted: string, depth = 0): AbilityDef[] | null {
	const act = parseGrantedActivatedAbility(quoted);
	if (act) return [act];
	const trig = parseGrantedTriggeredAbility(quoted);
	if (trig) return [trig];
	if (depth >= 2) return null;
	const norm = normalizeQuotedAbilityText(quoted);
	if (!norm) return null;
	const span = { start: 0, end: norm.length };
	const costMod = parseCostModifierSentence(norm);
	if (costMod) return [{ kind: 'static', static: costMod, span }];
	const sub = parseStaticAbilityInner(norm, 0, depth + 1);
	if (sub.unparsed.length === 0 && sub.items.length > 0) {
		return sub.items.map((item): AbilityDef =>
			item.kind === 'static'
				? { kind: 'static', static: item.static, span }
				: { kind: 'replacement', replacement: item.replacement, span }
		);
	}
	return null;
}

// ---- Productions ----------------------------------------------------------------------------

type Production = (s: string, span: Span) => StaticItem[] | null;

function parseDamageSourcePhrase(raw: string): ObjectFilter | 'self' | 'attachedTo' | undefined | null {
	const s = raw.trim();
	if (s === '~') return 'self';
	if (/^(?:enchanted|equipped) creature$/i.test(s)) return 'attachedTo';
	if (/^(?:a|any) source$/i.test(s)) return undefined;
	if (/^a source you control$/i.test(s)) return { controller: 'you' };
	if (/^another source you control$/i.test(s)) return { other: true, controller: 'you' };
	const sourceYouCtrl = s.match(/^(?:a|an) (.+?) source you control$/i);
	if (sourceYouCtrl) {
		const f = parseObjectPhrase(`${sourceYouCtrl[1]} card`);
		if (f && !f.controller) return { ...f, controller: 'you' };
		return null;
	}
	const anotherSrcYouCtrl = s.match(/^another (.+?) source you control$/i);
	if (anotherSrcYouCtrl) {
		const f = parseObjectPhrase(`another ${anotherSrcYouCtrl[1]} card`);
		if (f && !f.controller) return { ...f, controller: 'you' };
		return null;
	}
	const permYouCtrl = s.match(/^(?:(?:a|an)\s+|(?=(?:another|other)\b))(.+?) you control$/i);
	if (permYouCtrl) {
		const f = parseObjectPhrase(permYouCtrl[1]);
		if (f && !f.controller) return { ...f, controller: 'you' };
		return null;
	}
	const qualYouCtrl = parseObjectPhraseWithQualifiers(s, true);
	if (qualYouCtrl && qualYouCtrl.controller === 'you') {
		return qualYouCtrl;
	}
	return null;
}

/** "If a card or token would be put into a graveyard from anywhere, exile it instead." etc. */
const replacements: Production = (s, span) => {
	// --- Track P22a: CR 614.9 static damage redirection, CR 614.1a damage-to-counters, & CR 122.2 zone-persistent counters ---
	const redirectDmg = s.match(
		/^all damage that would be dealt to you( and other permanents you control)? is dealt to (~|(?:enchanted|equipped) (?:creature|permanent)) instead$/i
	);
	if (redirectDmg) {
		const from: 'you' | 'youAndOtherControlled' = redirectDmg[1]
			? 'youAndOtherControlled'
			: 'you';
		const to: 'self' | 'attachedTo' = redirectDmg[2].trim() === '~' ? 'self' : 'attachedTo';
		return [{ kind: 'static', static: { k: 'staticDamageRedirection', from, to } }];
	}
	const selfDmgToCounters = s.match(
		/^if damage would be dealt to ~, (?:prevent that damage and )?put that many (.+?) counters? on (?:it|~)(?: instead)?$/i
	);
	if (selfDmgToCounters) {
		const ctr = lookupStaticCounter(selfDmgToCounters[1]);
		if (ctr) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'damage', filter: { object: 'self' } },
						with: { k: 'modify', damageToSelfAsPlusCounters: ctr },
						selfReplacement: true
					}
				}
			];
		}
	}
	if (
		/^counters remain on ~ as it moves to any zone other than a player's hand or library$/i.test(
			s
		)
	) {
		return [{ kind: 'static', static: { k: 'countersRemainInNonHiddenZones' } }];
	}
	// --- End Track P22a ---
	// --- Track P20a: CR 106.12 tap-for-mana multipliers, CR 614.10 extra-turn skip, CR 614.1a discard/damage/exile, CR 701.19 regeneration ---
	const tapManaMult = s.match(
		/^if you tap (?:a|an) (.+?) for mana, it produces (twice|three times) as much of that mana instead$/i
	);
	if (tapManaMult) {
		const rawTarget = tapManaMult[1].trim();
		const filter: ObjectFilter | null = /^permanent$/i.test(rawTarget)
			? {}
			: parseObjectPhrase(rawTarget);
		if (filter && !filter.controller) {
			const factor = tapManaMult[2].toLowerCase() === 'twice' ? 2 : 3;
			return [
				{
					kind: 'static',
					static: { k: 'tapForManaMultiplier', factor, filter, who: 'you' }
				}
			];
		}
	}
	const skipExtraTurn = s.match(
		/^if (a player|an opponent) would begin an extra turn, that player skips that turn instead$/i
	);
	if (skipExtraTurn) {
		const rel = skipExtraTurn[1].toLowerCase() === 'an opponent' ? 'each_opponent' : 'each_player';
		return [rule('skipExtraTurns', rel)];
	}
	if (
		/^if a source (?:you control )?would deal noncombat damage to a creature an opponent controls, put that many -1\/-1 counters on that creature instead$/i.test(
			s
		)
	) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'damage', filter: {} },
					with: { k: 'modify', noncombatDamageToOpponentCreatureAsMinusCounters: true }
				}
			}
		];
	}
	if (/^if a creature dealt damage by ~ this turn would die, exile it instead$/i.test(s)) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'zoneChange', filter: { from: 'battlefield', to: 'graveyard' } },
					with: { k: 'modify', to: 'exile', dealtDamageBySelfExileOnDie: true }
				}
			}
		];
	}
	const dealtCtrlSrcDie = s.match(
		/^if a creature( an opponent controls)? dealt damage this turn by a source you controlled would die, exile it instead$/i
	);
	if (dealtCtrlSrcDie) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'zoneChange', filter: { from: 'battlefield', to: 'graveyard' } },
					with: {
						k: 'modify',
						to: 'exile',
						dealtDamageBySelfExileOnDie: dealtCtrlSrcDie[1]
							? 'controlledSourceOpponentCreature'
							: 'controlledSource'
					}
				}
			}
		];
	}
	const oppDiscardBf = s.match(
		/^if a spell or ability an opponent controls causes you to discard ~, put it onto the battlefield(?: with (\S+) (.+?) counters? on it)? instead of putting it into your graveyard$/i
	);
	if (oppDiscardBf) {
		if (!oppDiscardBf[1]) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'discard', filter: { object: 'self' } },
						with: { k: 'modify', opponentDiscardToBattlefield: {} },
						selfReplacement: true
					}
				}
			];
		}
		const cnt = count(oppDiscardBf[1]);
		const ctr = lookupStaticCounter(oppDiscardBf[2]);
		if (cnt && cnt.k === 'const' && cnt.n >= 1 && ctr) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'discard', filter: { object: 'self' } },
						with: {
							k: 'modify',
							opponentDiscardToBattlefield: { counters: { counter: ctr, count: cnt.n } }
						},
						selfReplacement: true
					}
				}
			];
		}
	}
	if (
		/^if ~ would be put into a graveyard from the battlefield, instead exile it and take an extra turn after this one$/i.test(
			s
		)
	) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: {
						event: 'zoneChange',
						filter: { object: 'self', from: 'battlefield', to: 'graveyard' }
					},
					with: {
						k: 'modify',
						to: 'exile',
						exileAndExtraTurnOnBattlefieldToGraveyard: true
					},
					selfReplacement: true
				}
			}
		];
	}
	if (/^if ~ would be destroyed, regenerate it$/i.test(s)) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: {
						event: 'zoneChange',
						filter: { object: 'self', from: 'battlefield', to: 'graveyard' }
					},
					with: { k: 'modify', regenerateSelfOnDestroy: true },
					selfReplacement: true
				}
			}
		];
	}
	// --- End Track P20a ---
	if (/^if a card(?: or token)? would be put into a graveyard from anywhere, exile it instead$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'exile' } } }];
	}
	if (/^if a card(?: or token)? would be put into a graveyard from anywhere, shuffle it into its owner's library instead$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'library', shuffleIntoLibrary: true } } }];
	}
	// --- Track P11: Opponent / controller graveyard & die-to-exile replacements ---
	const oppOrYouGyWithCtr = s.match(
		/^if a card( or token)? would be put into (an opponent's|your|a) graveyard from anywhere, (?:instead )?exile it with (?:a|an) (.+?) counter on it(?: instead)?$/i
	);
	if (oppOrYouGyWithCtr) {
		const includeTokens = Boolean(oppOrYouGyWithCtr[1]);
		const rawWho = oppOrYouGyWithCtr[2].toLowerCase();
		const rel: 'you' | 'opponent' | undefined =
			rawWho === 'your' ? 'you' : rawWho === "an opponent's" ? 'opponent' : undefined;
		const ctr = lookupStaticCounter(oppOrYouGyWithCtr[3]);
		if (ctr) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: {
							event: 'zoneChange',
							filter: {
								...(includeTokens ? {} : { object: { token: false } }),
								to: 'graveyard',
								...(rel ? { player: { relation: rel } } : {})
							}
						},
						with: { k: 'modify', to: 'exile', exileWithCounter: ctr }
					}
				}
			];
		}
	}
	const filteredGyExile = s.match(
		/^if (?:a|an) (.+?) would be put into (a|your|an opponent's) graveyard(?: from anywhere)?, (exile it|shuffle it into its owner's library) instead$/i
	);
	if (filteredGyExile && !/^card(?: or token)?$/i.test(filteredGyExile[1].trim())) {
		const rawPhrase = filteredGyExile[1].trim();
		const f = /^permanent$/i.test(rawPhrase)
			? { types: [...PERMANENT_CARD_TYPES], zone: 'battlefield' as const }
			: parseGraveyardCardFilter(rawPhrase.replace(/\s+cards?$/i, ''));
		if (f) {
			const rawWho = filteredGyExile[2].toLowerCase();
			const rel: 'you' | 'opponent' | undefined =
				rawWho === 'your' ? 'you' : rawWho === "an opponent's" ? 'opponent' : undefined;
			const isShuffle = filteredGyExile[3].toLowerCase().startsWith('shuffle');
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: {
							event: 'zoneChange',
							filter: {
								object: /^permanent$/i.test(rawPhrase) ? { types: [...PERMANENT_CARD_TYPES] } : f,
								...(/^permanent$/i.test(rawPhrase) ? { from: 'battlefield' } : {}),
								to: 'graveyard',
								...(rel ? { player: { relation: rel } } : {})
							}
						},
						with: isShuffle
							? { k: 'modify', to: 'library', shuffleIntoLibrary: true }
							: { k: 'modify', to: 'exile' }
					}
				}
			];
		}
	}
	const oppOrYouGy = s.match(
		/^if a card( or token)? would be put into (an opponent's|your) graveyard from anywhere, exile it instead$/i
	);
	if (oppOrYouGy) {
		const includeTokens = Boolean(oppOrYouGy[1]);
		const rel = oppOrYouGy[2].toLowerCase() === 'your' ? 'you' : 'opponent';
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: {
						event: 'zoneChange',
						filter: {
							...(includeTokens ? {} : { object: { token: false } }),
							to: 'graveyard',
							player: { relation: rel }
						}
					},
					with: { k: 'modify', to: 'exile' }
				}
			}
		];
	}
	const attachedDie = s.match(
		/^if (?:enchanted|equipped) (?:creature|permanent) would die, (exile it|return it to its owner's hand) instead$/i
	);
	if (attachedDie) {
		const to: ZoneType = attachedDie[1].toLowerCase().startsWith('exile') ? 'exile' : 'hand';
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: {
						event: 'zoneChange',
						filter: { object: 'attachedTo', from: 'battlefield', to: 'graveyard' }
					},
					with: { k: 'modify', to }
				}
			}
		];
	}
	const otherDieExile = s.match(
		/^if (?:(?:a|an)\s+|(?=(?:another|other)\b))(.+?) would die, (?:instead )?exile (?:it|that card)(?: with (?:a|an) (.+?) counter on it)?(?: instead)?$/i
	);
	if (otherDieExile) {
		let rawSubj = otherDieExile[1].trim();
		let ctrl: 'you' | 'opponent' | undefined;
		const oppCtrl = rawSubj.match(/^(.+?)\s+(?:an opponent controls|your opponents control|you don't control)$/i);
		if (oppCtrl) {
			ctrl = 'opponent';
			rawSubj = oppCtrl[1];
		}
		const filter = parseObjectPhrase(rawSubj);
		const exileCtr = otherDieExile[2] ? lookupStaticCounter(otherDieExile[2]) : undefined;
		if (filter && (!ctrl || !filter.controller) && (!otherDieExile[2] || exileCtr)) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: {
							event: 'zoneChange',
							filter: {
								object: { ...filter, ...(ctrl ? { controller: ctrl } : {}) },
								from: 'battlefield',
								to: 'graveyard'
							}
						},
						with: {
							k: 'modify',
							to: 'exile',
							...(exileCtr ? { exileWithCounter: exileCtr } : {})
						}
					}
				}
			];
		}
	}
	// --- Track P11: Static damage modification (CR 614.7a) & life-gain modification (CR 119.6) ---
	const dmgMod = s.match(
		/^if (.+?) would deal (?:(noncombat|combat) )?damage(?: to (a permanent or player|any target|an opponent or a permanent an opponent controls|the chosen player or a permanent they control|an opponent))?, (?:it|that source) deals (double that damage|twice that much damage|triple that damage|that much damage plus (\S+))(?: to that (?:permanent or player|player or permanent|player))?(?: instead)?$/i
	);
	if (dmgMod) {
		const sourceSpec = parseDamageSourcePhrase(dmgMod[1]);
		if (sourceSpec !== null) {
			const dmgKind = dmgMod[2]?.toLowerCase();
			const rawTarget = dmgMod[3]?.toLowerCase() ?? '';
			const isChosenPlayerTarget =
				rawTarget === 'the chosen player or a permanent they control';
			const targetFilter: 'any' | 'opponent' | 'opponentOrOpponentPerm' =
				rawTarget === 'an opponent'
					? 'opponent'
					: rawTarget === 'an opponent or a permanent an opponent controls'
						? 'opponentOrOpponentPerm'
						: 'any';
			const modStr = dmgMod[4].toLowerCase();
			if (modStr.startsWith('double') || modStr.startsWith('twice')) {
				const inner = {
					mode: 'double' as const,
					...(dmgKind === 'noncombat' ? { noncombatOnly: true } : {}),
					...(dmgKind === 'combat' ? { combatOnly: true } : {}),
					...(sourceSpec !== undefined ? { sourceFilter: sourceSpec } : {})
				};
				return [
					{
						kind: 'replacement',
						replacement: {
							replaces: { event: 'damage', filter: {} },
							with: isChosenPlayerTarget
								? { k: 'modify', chosenPlayerDamageMod: inner }
								: {
										k: 'modify',
										damageMod: {
											...inner,
											...(targetFilter !== 'any' ? { targetFilter } : {})
										}
									}
						}
					}
				];
			}
			if (modStr.startsWith('triple')) {
				const inner = {
					mode: 'triple' as const,
					...(dmgKind === 'noncombat' ? { noncombatOnly: true } : {}),
					...(dmgKind === 'combat' ? { combatOnly: true } : {}),
					...(sourceSpec !== undefined ? { sourceFilter: sourceSpec } : {})
				};
				return [
					{
						kind: 'replacement',
						replacement: {
							replaces: { event: 'damage', filter: {} },
							with: isChosenPlayerTarget
								? { k: 'modify', chosenPlayerDamageMod: inner }
								: {
										k: 'modify',
										damageMod: {
											...inner,
											...(targetFilter !== 'any' ? { targetFilter } : {})
										}
									}
						}
					}
				];
			}
			if (dmgMod[5]) {
				const addAmt = count(dmgMod[5]);
				if (addAmt) {
					const inner = {
						mode: 'add' as const,
						add: addAmt,
						...(dmgKind === 'noncombat' ? { noncombatOnly: true } : {}),
						...(dmgKind === 'combat' ? { combatOnly: true } : {}),
						...(sourceSpec !== undefined ? { sourceFilter: sourceSpec } : {})
					};
					return [
						{
							kind: 'replacement',
							replacement: {
								replaces: { event: 'damage', filter: {} },
								with: isChosenPlayerTarget
									? { k: 'modify', chosenPlayerDamageMod: inner }
									: {
											k: 'modify',
											damageMod: {
												...inner,
												...(targetFilter !== 'any' ? { targetFilter } : {})
											}
										}
							}
						}
					];
				}
			}
		}
	}

	const lifeDouble = s.match(
		/^if you would gain life(?: while (.+?))?, you gain twice that much life instead$/i
	);
	if (lifeDouble) {
		const cond = lifeDouble[1] ? parseStaticCondition(lifeDouble[1]) : undefined;
		if (!lifeDouble[1] || cond) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'lifeGain', filter: { player: { relation: 'you' } } },
						...(cond ? { condition: cond } : {}),
						with: { k: 'modify', lifeGainMod: { mode: 'double' } }
					}
				}
			];
		}
	}
	const lifePlus = s.match(
		/^if you would gain life(?: while (.+?))?, you gain that much life plus (\S+) instead$/i
	);
	if (lifePlus) {
		const cond = lifePlus[1] ? parseStaticCondition(lifePlus[1]) : undefined;
		const addAmt = count(lifePlus[2]);
		if (addAmt && (!lifePlus[1] || cond)) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'lifeGain', filter: { player: { relation: 'you' } } },
						...(cond ? { condition: cond } : {}),
						with: { k: 'modify', lifeGainMod: { mode: 'add', add: addAmt } }
					}
				}
			];
		}
	}
	// --- End Track P11 ---
	const selfDieOrGy = s.match(
		/^if ~ would (die|be put into a graveyard from anywhere), (?:reveal ~ and )?(exile it|shuffle it into its owner's library|put (?:it|~) on top of its owner's library|return it to its owner's hand|put it into its owner's hand) instead$/i
	);
	if (selfDieOrGy) {
		const isDie = selfDieOrGy[1].toLowerCase() === 'die';
		const action = selfDieOrGy[2].toLowerCase();
		const to: ZoneType = action.startsWith('exile')
			? 'exile'
			: action.startsWith('shuffle') || action.includes("owner's library")
				? 'library'
				: 'hand';
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: {
						event: 'zoneChange',
						filter: { object: 'self', ...(isDie ? { from: 'battlefield' } : {}), to: 'graveyard' }
					},
					with: {
						k: 'modify',
						to,
						...(action.startsWith('shuffle') ? { shuffleIntoLibrary: true } : {})
					}
				}
			}
		];
	}
	// --- Track P17a: Draw scaling replacements (Teferi's Ageless Insight, Thought Reflection, Phial of Galadriel, etc.) ---
	const drawScaleYou = s.match(
		/^if you would draw a card( except the first one you draw in each of your draw steps)?(?: while (.+?))?, draw (two|three|\d+) cards instead$/i
	);
	if (drawScaleYou) {
		const skipFirst = Boolean(drawScaleYou[1]);
		const cond = drawScaleYou[2] ? parseStaticCondition(drawScaleYou[2]) : undefined;
		const fAmt = count(drawScaleYou[3]);
		if (fAmt && fAmt.k === 'const' && fAmt.n >= 2 && (!drawScaleYou[2] || cond)) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'draw', filter: { player: { relation: 'you' } } },
						...(cond ? { condition: cond } : {}),
						with: {
							k: 'modify',
							drawMod: {
								factor: fAmt.n,
								...(skipFirst ? { skipFirstInYourDrawStep: true } : {})
							}
						}
					}
				}
			];
		}
	}
	const drawScaleAny = s.match(
		/^if a player would draw a card( except the first one they draw in each of their draw steps)?, that player draws (two|three|\d+) cards instead$/i
	);
	if (drawScaleAny) {
		const skipFirst = Boolean(drawScaleAny[1]);
		const fAmt = count(drawScaleAny[2]);
		if (fAmt && fAmt.k === 'const' && fAmt.n >= 2) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'draw', filter: { player: { relation: 'any' } } },
						with: {
							k: 'modify',
							drawMod: {
								factor: fAmt.n,
								...(skipFirst ? { skipFirstInYourDrawStep: true } : {})
							}
						}
					}
				}
			];
		}
	}
	// --- End Track P17a ---
	if (/^if you would draw a card while your library has no cards in it, you win the game instead$/i.test(s)) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'draw', filter: { player: { relation: 'you' } } },
					condition: { k: 'compare', left: { k: 'cardsIn', zone: 'library', of: { k: 'you' } }, op: '=', right: n(0) },
					with: [{ verb: 'win', subject: { k: 'player', filter: { relation: 'you' } }, span }]
				}
			}
		];
	}
	if (/^if you would draw a card while your library has no cards in it, skip that draw instead$/i.test(s)) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'draw', filter: { player: { relation: 'you' } } },
					condition: { k: 'compare', left: { k: 'cardsIn', zone: 'library', of: { k: 'you' } }, op: '=', right: n(0) },
					with: { k: 'skip' }
				}
			}
		];
	}
	const entersSelf: EventPattern = { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } };
	if (/^~ enters (?:the battlefield )?tapped and doesn't untap during your untap step$/i.test(s)) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: entersSelf,
					with: { k: 'modify', tapped: true },
					selfReplacement: true
				}
			},
			{
				kind: 'static',
				static: { k: 'restriction', affected: 'self', restriction: 'doesntUntap' }
			}
		];
	}
	const twoSelfCounters = s.match(
		/^~ enters (?:the battlefield )?(tapped (?:and )?)?with (\S+) (.+?) counters? and (\S+) (.+?) counters? on (?:it|him|her|them)$/i
	);
	if (twoSelfCounters) {
		const entersTapped = Boolean(twoSelfCounters[1]);
		const a1 = count(twoSelfCounters[2]);
		const c1 = lookupStaticCounter(twoSelfCounters[3]);
		const a2 = count(twoSelfCounters[4]);
		const c2 = lookupStaticCounter(twoSelfCounters[5]);
		if (a1 && c1 && a2 && c2) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: entersSelf,
						with: {
							k: 'modify',
							...(entersTapped ? { tapped: true } : {}),
							counters: { counter: c1, amount: a1 }
						}
					}
				},
				{
					kind: 'replacement',
					replacement: {
						replaces: entersSelf,
						with: { k: 'modify', counters: { counter: c2, amount: a2 } }
					}
				}
			];
		}
	}
	const parseSelfEtbModify = (body: string): ReplacementDef['with'] | null => {
		if (/^~ enters (?:the battlefield )?tapped$/i.test(body)) {
			return { k: 'modify', tapped: true };
		}
		// --- Track P14: CR 723.3a "~ enters prepared" & dynamic X ETB counters ---
		const preparedMatch = body.match(/^~ enters (?:the battlefield )?(tapped and )?prepared$/i);
		if (preparedMatch) {
			return {
				k: 'modify',
				...(preparedMatch[1] ? { tapped: true } : {}),
				entersPrepared: true
			};
		}
		const xCountersMatch = body.match(
			/^~ enters (?:the battlefield )?(tapped (?:and )?)?with X (.+?) counters? on (?:it|him|her|them),?\s+where X is (.+)$/i
		);
		if (xCountersMatch) {
			const counter = lookupStaticCounter(xCountersMatch[2]);
			const amount = parseCountAmount(xCountersMatch[3]);
			if (counter && amount) {
				return {
					k: 'modify',
					...(xCountersMatch[1] ? { tapped: true } : {}),
					counters: { counter, amount }
				};
			}
		}
		const numEqualMatch = body.match(
			/^~ enters (?:the battlefield )?(tapped (?:and )?)?with a number of (.+?) counters? on (?:it|him|her|them) equal to (.+)$/i
		);
		if (numEqualMatch) {
			const counter = lookupStaticCounter(numEqualMatch[2]);
			const amount = parseCountAmount(numEqualMatch[3]);
			if (counter && amount) {
				return {
					k: 'modify',
					...(numEqualMatch[1] ? { tapped: true } : {}),
					counters: { counter, amount }
				};
			}
		}
		const twiceXMatch = body.match(
			/^~ enters (?:the battlefield )?(tapped (?:and )?)?with twice X (.+?) counters? on (?:it|him|her|them)$/i
		);
		if (twiceXMatch) {
			const counter = lookupStaticCounter(twiceXMatch[2]);
			if (counter) {
				return {
					k: 'modify',
					...(twiceXMatch[1] ? { tapped: true } : {}),
					counters: { counter, amount: { k: 'mul', factor: 2, of: { k: 'x' } } }
				};
			}
		}
		const xPlusMatch = body.match(
			/^~ enters (?:the battlefield )?(tapped (?:and )?)?with X plus (\S+) (.+?) counters? on (?:it|him|her|them)$/i
		);
		if (xPlusMatch) {
			const extra = count(xPlusMatch[2]);
			const counter = lookupStaticCounter(xPlusMatch[3]);
			if (extra && counter) {
				return {
					k: 'modify',
					...(xPlusMatch[1] ? { tapped: true } : {}),
					counters: { counter, amount: { k: 'sum', args: [{ k: 'x' }, extra] } }
				};
			}
		}
		// --- End Track P14 ---
		const choiceCounter = body.match(
			/^~ enters (?:the battlefield )?(tapped (?:and )?)?with your choice of (?:either )?(?:a|an) (.+?) counter or (?:a|an) (.+?) counter on (?:it|him|her|them)$/i
		);
		if (choiceCounter) {
			const c1 = lookupStaticCounter(choiceCounter[2]);
			const c2 = lookupStaticCounter(choiceCounter[3]);
			if (c1 && c2 && c1 !== c2) {
				return {
					k: 'modify',
					...(choiceCounter[1] ? { tapped: true } : {}),
					chooseCounter: [c1, c2]
				};
			}
		}
		const counters = body.match(
			/^~ enters (?:the battlefield )?(tapped (?:and )?)?with (\S+) (.+?) counters? on (?:it|him|her|them)(?: for each (.+))?$/i
		);
		if (counters) {
			const entersTapped = Boolean(counters[1]);
			const baseAmount = count(counters[2]);
			const counter = lookupStaticCounter(counters[3]);
			if (baseAmount && counter) {
				let amount: Amount | null = baseAmount;
				if (counters[4]) {
					const forEachRaw = counters[4].trim();
					if (/^color of mana spent to cast (?:it|~)$/i.test(forEachRaw)) {
						if (baseAmount.k === 'const' && baseAmount.n === 1) amount = { k: 'colorsOfManaSpentToCast' };
						else if (baseAmount.k === 'const' && baseAmount.n > 1) {
							amount = scaleAmount(baseAmount.n, { k: 'colorsOfManaSpentToCast' });
						} else amount = null;
					} else if (/^mana spent to cast (?:it|~)$/i.test(forEachRaw)) {
						if (baseAmount.k === 'const' && baseAmount.n >= 1) {
							amount = scaleAmount(baseAmount.n, { k: 'manaSpentToCast' });
						} else amount = null;
					} else if (/^time (?:it|~) was kicked$/i.test(forEachRaw)) {
						if (baseAmount.k === 'const' && baseAmount.n === 1) amount = { k: 'kickedCount' };
						else if (baseAmount.k === 'const' && baseAmount.n > 1) {
							amount = { k: 'kickedCount', multiplier: baseAmount.n };
						} else amount = null;
					} else if (baseAmount.k === 'const' && baseAmount.n >= 1) {
						const per = parseCountAmount(`the number of ${forEachRaw}`);
						amount = per ? scaleAmount(baseAmount.n, per) : null;
					} else {
						amount = null;
					}
				}
				if (amount) {
					return {
						k: 'modify',
						...(entersTapped ? { tapped: true } : {}),
						counters: { counter, amount }
					};
				}
			}
		}
		const cloneMatch = body.match(
			/^(you may have )?~ enters? (?:the battlefield )?(tapped )?as a copy of (?:any |a |an )?(.+?)(?: on the battlefield)?(?:, except (.+))?$/i
		);
		if (cloneMatch) {
			const optional = Boolean(cloneMatch[1]);
			const entersTapped = Boolean(cloneMatch[2]);
			const rawPhrase = cloneMatch[3].trim();
			let filter: ObjectFilter | null = null;
			const oppCtrl = rawPhrase.match(/^(.+) an opponent controls$/i);
			if (oppCtrl) {
				const sub = parseObjectPhrase(oppCtrl[1]);
				if (sub && !sub.controller) filter = { ...sub, controller: 'opponent' };
			} else {
				filter = parseObjectPhrase(rawPhrase);
			}
			if (filter) {
				let copyModifications: CopyModificationSpec | undefined;
				if (cloneMatch[4]) {
					const mods = parseCopyModifications(cloneMatch[4]);
					if (!mods) return null;
					copyModifications = mods;
				}
				return {
					k: 'modify',
					copyOf: { ...filter, zone: 'battlefield', other: true },
					...(optional ? {} : { copyOptional: false }),
					...(entersTapped ? { tapped: true } : {}),
					...(copyModifications ? { copyModifications } : {})
				};
			}
		}
		if (/^as (?:~|it) enters(?: the battlefield)?, choose a creature type$/i.test(body)) {
			return { k: 'modify', chooseSubType: 'creature' };
		}
		// --- Track P20a: CR 730.2 becomesDayIfNeither, CR 614.12 player/parity/land-type choices, & opponent-control ETB ---
		if (
			/^if it's neither day nor night, it becomes day as (?:~|it) enters(?: the battlefield)?$/i.test(
				body
			) ||
			/^as (?:~|it) enters(?: the battlefield)?, if it's neither day nor night, it becomes day$/i.test(
				body
			)
		) {
			return { k: 'modify', becomesDayIfNeither: true };
		}
		const choosePl = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, choose (a player|an opponent)$/i
		);
		if (choosePl) {
			return {
				k: 'modify',
				choosePlayer: choosePl[1].toLowerCase() === 'an opponent' ? 'opponent' : 'any'
			};
		}
		if (/^as (?:~|it) enters(?: the battlefield)?, choose odd or even$/i.test(body)) {
			return { k: 'modify', chooseParity: true };
		}
		const chooseLandSub = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, choose a (basic )?land type$/i
		);
		if (chooseLandSub) {
			return { k: 'modify', chooseSubType: chooseLandSub[1] ? 'basicLand' : 'land' };
		}
		const enterOppCtrl = body.match(
			/^~ enters (?:the battlefield )?(tapped )?under (?:the control of an opponent(?: of your choice)?|an opponent's control)$/i
		);
		if (enterOppCtrl) {
			return {
				k: 'modify',
				...(enterOppCtrl[1] ? { tapped: true } : {}),
				enterUnderOpponentControl: true
			};
		}
		// --- End Track P20a ---
		const chooseCol = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, choose a color(?: other than (white|blue|black|red|green))?$/i
		);
		if (chooseCol) {
			const ex = chooseCol[1] ? COLORS[chooseCol[1].toLowerCase()] : undefined;
			return { k: 'modify', chooseColor: ex ? { exclude: ex } : {} };
		}
		const chooseName = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, choose (?:a (nonland )?|any )card name$/i
		);
		if (chooseName) {
			return { k: 'modify', chooseCardName: chooseName[1] ? { nonlandOnly: true } : {} };
		}
		// --- Track P22a: CR 614.12 remaining ETB choices (CardType, Number, TwoColors, TwoPlayers, AnotherCreature, SubtypeOptions, LookHand+CardName) ---
		const ALL_CHOSEN_CARD_TYPES: Record<string, string> = {
			artifact: 'Artifact',
			battle: 'Battle',
			creature: 'Creature',
			enchantment: 'Enchantment',
			instant: 'Instant',
			kindred: 'Kindred',
			tribal: 'Kindred',
			land: 'Land',
			planeswalker: 'Planeswalker',
			sorcery: 'Sorcery'
		};
		const lookThenCardName = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, look at an opponent's hand, then choose (?:a (nonland )?|any )card name$/i
		);
		if (lookThenCardName) {
			return {
				k: 'modify',
				chooseCardName: lookThenCardName[1] ? { nonlandOnly: true } : {},
				lookAtOpponentHandBeforeCardName: true
			};
		}
		const chooseCardTypeM = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, (look at an opponent's hand, then )?choose a card type(?: other than (.+))?$/i
		);
		if (chooseCardTypeM) {
			let exclude: string[] | undefined;
			if (chooseCardTypeM[2]) {
				const rawEx = chooseCardTypeM[2]
					.split(/,\s*or\s+|\s+or\s+|,\s*/)
					.map((x) => x.trim().toLowerCase())
					.filter(Boolean);
				if (rawEx.length === 0 || !rawEx.every((w) => Boolean(ALL_CHOSEN_CARD_TYPES[w]))) {
					return null;
				}
				exclude = rawEx.map((w) => ALL_CHOSEN_CARD_TYPES[w]);
			}
			return {
				k: 'modify',
				chooseCardType: {
					...(exclude ? { exclude } : {}),
					...(chooseCardTypeM[1] ? { lookAtOpponentHand: true } : {})
				}
			};
		}
		const chooseNumberM = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, choose a number(?: between (\S+) and (\S+))?$/i
		);
		if (chooseNumberM) {
			if (!chooseNumberM[1]) return { k: 'modify', chooseNumber: {} };
			const minAmt = count(chooseNumberM[1]);
			const maxAmt = count(chooseNumberM[2]);
			if (minAmt?.k === 'const' && maxAmt?.k === 'const' && maxAmt.n >= minAmt.n) {
				return { k: 'modify', chooseNumber: { min: minAmt.n, max: maxAmt.n } };
			}
			return null;
		}
		if (/^as (?:~|it) enters(?: the battlefield)?, choose two colors$/i.test(body)) {
			return { k: 'modify', chooseTwoColors: true };
		}
		if (/^as (?:~|it) enters(?: the battlefield)?, choose two players$/i.test(body)) {
			return { k: 'modify', chooseTwoPlayers: true };
		}
		if (/^as (?:~|it) enters(?: the battlefield)?, secretly choose an opponent$/i.test(body)) {
			return { k: 'modify', choosePlayer: 'opponent' };
		}
		const chooseAnotherObj = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, (you may )?choose (another .+)$/i
		);
		if (chooseAnotherObj) {
			const objFilter = parseObjectPhraseWithQualifiers(chooseAnotherObj[2], true);
			if (objFilter) {
				return {
					k: 'modify',
					chooseObjectOnBattlefield: {
						filter: { ...objFilter, other: true },
						...(chooseAnotherObj[1] ? { optional: true } : {})
					}
				};
			}
		}
		const chooseDisj = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, choose ([A-Za-z'-]+(?:,\s*[A-Za-z'-]+)*,?\s+or\s+[A-Za-z'-]+)$/i
		);
		if (chooseDisj) {
			const opts = chooseDisj[1]
				.split(/,\s*or\s+|\s+or\s+|,\s*/)
				.map((x) => x.trim())
				.filter(Boolean);
			if (opts.length >= 2 && opts.every((w) => Boolean(ALL_CHOSEN_CARD_TYPES[w.toLowerCase()]))) {
				return {
					k: 'modify',
					chooseCardType: {
						options: opts.map((w) => ALL_CHOSEN_CARD_TYPES[w.toLowerCase()])
					}
				};
			}
			if (
				opts.length >= 3 &&
				opts.every(
					(w) =>
						/^[A-Z][A-Za-z'-]*$/.test(w) &&
						!ALL_CHOSEN_CARD_TYPES[w.toLowerCase()] &&
						!COLORS[w.toLowerCase()]
				)
			) {
				return { k: 'modify', chooseSubTypeOptions: opts };
			}
		}
		// --- End Track P22a ---
		return null;
	};
	const direct = parseSelfEtbModify(s);
	if (direct) {
		const isSelfChoice = Boolean(
			typeof direct === 'object' &&
				!Array.isArray(direct) &&
				direct.k === 'modify' &&
				(direct.chooseSubType ||
					direct.chooseColor ||
					direct.chooseCardName ||
					direct.chooseCounter ||
					direct.becomesDayIfNeither ||
					direct.choosePlayer ||
					direct.chooseParity ||
					direct.enterUnderOpponentControl ||
					direct.chooseCardType ||
					direct.chooseNumber ||
					direct.chooseTwoColors ||
					direct.chooseTwoPlayers ||
					direct.chooseObjectOnBattlefield ||
					direct.chooseSubTypeOptions)
		);
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: entersSelf,
					with: direct,
					...(isSelfChoice ? { selfReplacement: true } : {})
				}
			}
		];
	}

	// --- Track P11 & P20a: External ETB tapped/untapped & additional counters (CR 614.12) ---
	const extEnterUntapped = s.match(/^(.+?) enters? (?:the battlefield )?untapped$/i);
	if (extEnterUntapped && !/^(?:~|it)$/i.test(extEnterUntapped[1].trim())) {
		const singleAff = parseAffected(extEnterUntapped[1].trim());
		if (singleAff && typeof singleAff === 'object') {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'zoneChange', filter: { object: singleAff, to: 'battlefield' } },
						with: { k: 'modify', untapped: true }
					}
				}
			];
		}
	}
	const extEnterTapped = s.match(/^(.+?) enters? (?:the battlefield )?tapped$/i);
	if (extEnterTapped && !/^(?:~|it)$/i.test(extEnterTapped[1].trim())) {
		const rawSubj = extEnterTapped[1].trim();
		const singleAff = parseAffected(rawSubj);
		if (singleAff && typeof singleAff === 'object') {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'zoneChange', filter: { object: singleAff, to: 'battlefield' } },
						with: { k: 'modify', tapped: true }
					}
				}
			];
		}
		const ctrlTail = rawSubj.match(/^(.+?)\s+(your opponents control|an opponent controls|you control)$/i);
		const listBody = ctrlTail ? ctrlTail[1] : rawSubj;
		const ctrlSuffix = ctrlTail ? ` ${ctrlTail[2]}` : '';
		if (/\band\b/i.test(listBody)) {
			const parts = listBody
				.split(/,\s*and\s+|\s+and\s+|,\s*/i)
				.map((p) => p.trim())
				.filter(Boolean);
			if (parts.length >= 2) {
				const filters: ObjectFilter[] = [];
				let allOk = true;
				for (const part of parts) {
					const aff = parseAffected(`${part}${ctrlSuffix}`);
					if (!aff || typeof aff !== 'object') {
						allOk = false;
						break;
					}
					filters.push(aff);
				}
				if (allOk) {
					return filters.map((f) => ({
						kind: 'replacement' as const,
						replacement: {
							replaces: { event: 'zoneChange', filter: { object: f, to: 'battlefield' as const } },
							with: { k: 'modify' as const, tapped: true }
						}
					}));
				}
			}
		}
	}

	const extAddCountersEqual = s.match(
		/^(.+?) enters? (?:the battlefield )?with a number of (?:additional )?(.+?) counters? on (?:it|them) equal to (.+)$/i
	);
	if (extAddCountersEqual && !/^(?:~|it)$/i.test(extAddCountersEqual[1].trim())) {
		const aff = parseAffected(extAddCountersEqual[1]);
		const ctr = lookupStaticCounter(extAddCountersEqual[2]);
		const amt = parseCountAmount(extAddCountersEqual[3]);
		if (aff && typeof aff === 'object' && ctr && amt) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'zoneChange', filter: { object: aff, to: 'battlefield' } },
						with: { k: 'modify', additionalCounters: { counter: ctr, amount: amt } }
					}
				}
			];
		}
	}
	const extAddCounters = s.match(
		/^(.+?) enters? (?:the battlefield )?with (\S+) (?:additional )?(.+?) counters? on (?:it|them)(?: for each (.+))?$/i
	);
	if (extAddCounters && !/^(?:~|it)$/i.test(extAddCounters[1].trim())) {
		const aff = parseAffected(extAddCounters[1]);
		const baseAmt = count(extAddCounters[2]);
		const ctr = lookupStaticCounter(extAddCounters[3]);
		if (aff && typeof aff === 'object' && baseAmt && ctr) {
			let amt: Amount | null = baseAmt;
			if (extAddCounters[4]) {
				const rawForEach = extAddCounters[4].trim().replace(/\byou already control\b/i, 'you control');
				if (baseAmt.k === 'const' && baseAmt.n >= 1) {
					const per = parseCountAmount(`the number of ${rawForEach}`);
					amt = per ? scaleAmount(baseAmt.n, per) : null;
				} else {
					amt = null;
				}
			}
			if (amt) {
				return [
					{
						kind: 'replacement',
						replacement: {
							replaces: { event: 'zoneChange', filter: { object: aff, to: 'battlefield' } },
							with: { k: 'modify', additionalCounters: { counter: ctr, amount: amt } }
						}
					}
				];
			}
		}
	}
	// --- End Track P11 ---

	// --- Track P8 & P17a: Conditional ETB ("~ enters ... unless <condition>") ---
	const entersUnless = s.match(/^(.+?) unless (.+)$/i);
	if (entersUnless && /^~ enters\b/i.test(entersUnless[1])) {
		const mod = parseSelfEtbModify(entersUnless[1]);
		const unlessCond = parseUnlessEtbCondition(entersUnless[2]);
		if (mod && unlessCond) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: entersSelf,
						with: mod,
						selfReplacement: true,
						condition: { k: 'not', of: unlessCond }
					}
				}
			];
		}
	}

	// CR 702.138c / 702.138d: "~ escapes with N [kind] counter(s) on it" and/or "~ escapes with [keyword(s)]"
	// Rejects "instead" overrides (e.g. Polukranos, Unchained) so they aren't miscompiled as additive.
	const escapesWith = s.match(/^(?:~|it) escapes with (.+)$/i);
	if (escapesWith && !/\binstead\b/i.test(escapesWith[1])) {
		const escapeCond: Condition = { k: 'escaped' };
		const body = escapesWith[1].trim();
		const counterAndKw = body.match(
			/^(\S+) (?:additional )?(.+?) counters? on (?:it|her|him)(?: and (?:with )?(.+))?$/i
		);
		if (counterAndKw) {
			const amount = count(counterAndKw[1]);
			const counter = lookupStaticCounter(counterAndKw[2]);
			if (amount && counter) {
				const out: StaticItem[] = [
					{
						kind: 'replacement',
						replacement: {
							replaces: entersSelf,
							with: { k: 'modify', counters: { counter, amount } },
							condition: escapeCond
						}
					}
				];
				if (counterAndKw[3]) {
					const kws = parseKeywordList(counterAndKw[3]);
					if (!kws) return null;
					out.push(keywordGrant('self', kws, escapeCond));
				}
				return out;
			}
		}
		const kwsOnly = parseKeywordList(body);
		if (kwsOnly) {
			return [keywordGrant('self', kwsOnly, escapeCond)];
		}
	}

	const suffixCond = s.match(/^(.+?) (if .+)$/i);
	if (suffixCond) {
		const cond = parseCondition(suffixCond[2]) ?? parseStaticCondition(suffixCond[2].slice(3));
		const mod = parseSelfEtbModify(suffixCond[1]);
		if (cond && mod) {
			return [{ kind: 'replacement', replacement: { replaces: entersSelf, with: mod, condition: cond } }];
		}
	}

	const prefixCond = s.match(/^(if [^,]+),\s*(?:(?:it|~) )?(enters .+)$/i);
	if (prefixCond) {
		const cond = parseCondition(prefixCond[1]) ?? parseStaticCondition(prefixCond[1].slice(3));
		if (cond) {
			const etbBody = `~ ${prefixCond[2]}`;
			const withKeywords = etbBody.match(/^(.+?) and with (.+)$/i);
			if (withKeywords) {
				const mod = parseSelfEtbModify(withKeywords[1]);
				const kws = parseKeywordList(withKeywords[2]);
				if (mod && kws) {
					return [
						{ kind: 'replacement', replacement: { replaces: entersSelf, with: mod, condition: cond } },
						keywordGrant('self', kws, cond)
					];
				}
			}
			const mod = parseSelfEtbModify(etbBody);
			if (mod) {
				return [{ kind: 'replacement', replacement: { replaces: entersSelf, with: mod, condition: cond } }];
			}
		}
	}
	return null;
};

// --- Track P14: Static Damage Prevention & Phantom Counter Removal (CR 615.1, 615.5–6, 615.10, 615.12) ---

function parsePreventionSourceFilter(
	raw: string
): ObjectFilter | 'blockingOrBlockedBySelf' | 'blockingSelf' | 'blockedBySelf' | null {
	const s = raw.trim();
	if (/^(?:(?:a|an)\s+)?creatures? blocking or blocked by (?:~|it)$/i.test(s)) {
		return 'blockingOrBlockedBySelf';
	}
	if (/^(?:(?:a|an)\s+)?creatures? blocking (?:~|it)$/i.test(s)) {
		return 'blockingSelf';
	}
	if (/^(?:(?:a|an)\s+)?creatures? (?:blocked by (?:~|it)|(?:~ is|it's) blocking)$/i.test(s)) {
		return 'blockedBySelf';
	}
	if (/^sources? (?:with|of) the chosen name$/i.test(s)) {
		return { ofChosenName: true };
	}
	// --- Track P22a: "the chosen creature/permanent/..." ---
	if (/^the chosen (?:creature|permanent|artifact|enchantment|land|planeswalker)$/i.test(s)) {
		return { chosenObject: true };
	}
	// --- End Track P22a ---
	if (/^sources? (?:your opponents control|an opponent controls|you don't control)$/i.test(s)) {
		return { controller: 'opponent' };
	}
	if (/^sources? you control$/i.test(s)) {
		return { controller: 'you' };
	}
	if (/^another source you control$/i.test(s)) {
		return { other: true, controller: 'you' };
	}
	let body = s;
	let ctrl: 'you' | 'opponent' | undefined;
	const ctrlMatch = body.match(
		/^(.+?)\s+(you control|your opponents control|an opponent controls|you don't control)$/i
	);
	if (ctrlMatch) {
		body = ctrlMatch[1].trim();
		ctrl = ctrlMatch[2].toLowerCase() === 'you control' ? 'you' : 'opponent';
	}
	const srcMatch = body.match(/^(?:(?:a|an)\s+)?(.+?)\s+sources?$/i);
	if (srcMatch) {
		const q = srcMatch[1].trim();
		const f =
			parseCombatObjectPhrase(`${q} cards`) ??
			parseObjectPhrase(`${q.replace(/\s+and(?:\/or)?\s+/gi, ' or ')} card`);
		if (f && (!ctrl || !f.controller)) {
			return ctrl ? { ...f, controller: ctrl } : f;
		}
		return null;
	}
	const spellNormalized = body
		.replace(/^(?:a|an)\s+/i, '')
		.replace(/\bspells\b/gi, 'cards')
		.replace(/\s+and(?:\/or)?\s+/gi, ' or ');
	const f = parseCombatObjectPhrase(body) ?? parseObjectPhrase(spellNormalized);
	if (f && (!ctrl || !f.controller)) {
		return ctrl ? { ...f, controller: ctrl } : f;
	}
	return null;
}

const damagePrevention: Production = (s) => {
	// --- Track P22a: CR 615.12 source-scoped unpreventable damage & CR 514.2 cleanup damage retention ---
	const unprevDmg = s.match(
		/^(combat )?damage (?:that would be )?dealt by (.+?) can't be prevented$/i
	);
	if (unprevDmg) {
		const combatOnly = Boolean(unprevDmg[1]);
		const rawSrc = unprevDmg[2].trim();
		let sourceFilter: 'self' | 'attachedTo' | ObjectFilter | null = null;
		if (rawSrc === '~' || /^it$/i.test(rawSrc)) {
			sourceFilter = 'self';
		} else if (/^(?:enchanted|equipped) (?:creature|permanent)$/i.test(rawSrc)) {
			sourceFilter = 'attachedTo';
		} else {
			const parsedSrc = parsePreventionSourceFilter(rawSrc);
			if (parsedSrc && typeof parsedSrc === 'object') {
				sourceFilter = parsedSrc;
			}
		}
		if (sourceFilter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'unpreventableDamage',
						...(combatOnly ? { combatOnly: true } : {}),
						sourceFilter
					}
				}
			];
		}
	}
	if (/^combat damage can't be prevented$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'unpreventableDamage', combatOnly: true } }];
	}
	const noCleanupDmg = s.match(/^damage isn't removed from (.+?) during cleanup steps$/i);
	if (noCleanupDmg) {
		const aff = parseAffected(noCleanupDmg[1].trim());
		if (aff) {
			return [{ kind: 'static', static: { k: 'damageNotRemovedInCleanup', affected: aff } }];
		}
	}
	// --- End Track P22a ---
	// 1. Single-sentence Phantom / Oathsworn Knight / Polukranos / Ugin's Conjurant counter-removal prevention
	const phantomOne = s.match(
		/^if (combat |noncombat )?damage would be dealt to ~(?: while it has (?:a|an|one) (.+?) counter on (?:it|~))?, prevent (?:all of )?that damage and remove (a|an|one|that many) (.+?) counters? from (?:it|~)$/i
	);
	if (phantomOne) {
		const kindRaw = phantomOne[1]?.trim().toLowerCase();
		const whileCtr = phantomOne[2] ? lookupStaticCounter(phantomOne[2]) : undefined;
		const modeRaw = phantomOne[3].toLowerCase();
		const remCtr = lookupStaticCounter(phantomOne[4]);
		if (remCtr && (!phantomOne[2] || whileCtr === remCtr)) {
			return [
				{
					kind: 'static',
					static: {
						k: 'staticDamagePrevention',
						...(kindRaw === 'combat' ? { combatOnly: true } : {}),
						...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
						amount: 'all',
						target: 'self',
						phantomCounterRemoval: {
							counter: remCtr,
							mode: modeRaw === 'that many' ? 'thatMany' : 'one',
							...(whileCtr ? { requireCounterPresent: true } : {})
						}
					}
				}
			];
		}
	}

	// 2. "Prevent all [combat/noncombat] damage that would be dealt to and dealt by ~ / enchanted creature"
	const toAndBy = s.match(
		/^prevent all (combat |noncombat )?damage that would be dealt to and dealt by (~|(?:enchanted|equipped) (?:creature|permanent))$/i
	);
	if (toAndBy) {
		const kindRaw = toAndBy[1]?.trim().toLowerCase();
		const isSelf = toAndBy[2].trim() === '~';
		return [
			{
				kind: 'static',
				static: {
					k: 'staticDamagePrevention',
					...(kindRaw === 'combat' ? { combatOnly: true } : {}),
					...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
					amount: 'all',
					target: isSelf ? 'self' : 'attachedTo',
					alsoPreventDealtBy: true
				}
			}
		];
	}

	// 3. "Prevent all [combat/noncombat] damage that would be dealt by ~ / enchanted creature" (or "that ~ would deal")
	const dealtBy =
		s.match(
			/^prevent all (combat |noncombat )?damage that would be dealt by (~|(?:enchanted|equipped) (?:creature|permanent))$/i
		) ??
		s.match(
			/^prevent all (combat |noncombat )?damage (?:that )?(~|(?:enchanted|equipped) (?:creature|permanent)) would deal$/i
		);
	if (dealtBy) {
		const kindRaw = dealtBy[1]?.trim().toLowerCase();
		const isSelf = dealtBy[2].trim() === '~';
		return [
			{
				kind: 'static',
				static: {
					k: 'staticDamagePrevention',
					...(kindRaw === 'combat' ? { combatOnly: true } : {}),
					...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
					amount: 'all',
					target: 'self',
					dealtByOnly: isSelf ? 'self' : 'attachedTo'
				}
			}
		];
	}

	// 3b. "Prevent all [combat/noncombat] damage [that] ~ / enchanted creature would deal to <permanents>"
	const dealtByTo = s.match(
		/^prevent all (combat |noncombat )?damage (?:that )?(~|(?:enchanted|equipped) (?:creature|permanent)) would deal to (.+)$/i
	);
	if (dealtByTo) {
		const kindRaw = dealtByTo[1]?.trim().toLowerCase();
		const isSelf = dealtByTo[2].trim() === '~';
		const aff = parseAffected(dealtByTo[3].trim());
		if (aff && typeof aff === 'object') {
			return [
				{
					kind: 'static',
					static: {
						k: 'staticDamagePrevention',
						...(kindRaw === 'combat' ? { combatOnly: true } : {}),
						...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
						amount: 'all',
						target: 'self',
						dealtByOnly: isSelf ? 'self' : 'attachedTo',
						dealtByTargetFilter: aff
					}
				}
			];
		}
	}

	// 3c. "Prevent all [combat/noncombat] damage that would be dealt [by <source>]" (e.g. Gideon's Intervention, Fog-like statics)
	const dealtAny = s.match(
		/^prevent all (combat |noncombat )?damage that would be dealt(?: by (.+))?$/i
	);
	if (dealtAny) {
		const kindRaw = dealtAny[1]?.trim().toLowerCase();
		const rawBy = dealtAny[2]?.trim();
		let sourceFilter:
			| ObjectFilter
			| 'blockingOrBlockedBySelf'
			| 'blockingSelf'
			| 'blockedBySelf'
			| undefined;
		if (rawBy) {
			const parsedSrc = parsePreventionSourceFilter(rawBy);
			if (!parsedSrc) return null;
			sourceFilter = parsedSrc;
		}
		return [
			{
				kind: 'static',
				static: {
					k: 'staticDamagePrevention',
					...(kindRaw === 'combat' ? { combatOnly: true } : {}),
					...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
					...(sourceFilter ? { sourceFilter } : {}),
					amount: 'all',
					target: 'any'
				}
			}
		];
	}

	// 4. "Prevent all [combat/noncombat] damage that would be dealt to <target> [by <source>]"
	const dealtTo = s.match(
		/^prevent all (combat |noncombat )?damage that would be dealt to (.+?)(?: by (.+))?$/i
	);
	if (dealtTo) {
		const kindRaw = dealtTo[1]?.trim().toLowerCase();
		const rawTarget = dealtTo[2].trim();
		const rawBy = dealtTo[3]?.trim();
		let sourceFilter:
			| ObjectFilter
			| 'blockingOrBlockedBySelf'
			| 'blockingSelf'
			| 'blockedBySelf'
			| undefined;
		if (rawBy) {
			const parsedSrc = parsePreventionSourceFilter(rawBy);
			if (!parsedSrc) return null;
			sourceFilter = parsedSrc;
		}
		const baseFlags = {
			...(kindRaw === 'combat' ? { combatOnly: true } : {}),
			...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
			...(sourceFilter ? { sourceFilter } : {})
		};
		if (rawTarget === '~') {
			return [
				{
					kind: 'static',
					static: { k: 'staticDamagePrevention', ...baseFlags, amount: 'all', target: 'self' }
				}
			];
		}
		if (/^(?:enchanted|equipped) (?:creature|permanent|planeswalker)$/i.test(rawTarget)) {
			return [
				{
					kind: 'static',
					static: {
						k: 'staticDamagePrevention',
						...baseFlags,
						amount: 'all',
						target: 'attachedTo'
					}
				}
			];
		}
		if (/^you$/i.test(rawTarget)) {
			return [
				{
					kind: 'static',
					static: { k: 'staticDamagePrevention', ...baseFlags, amount: 'all', target: 'you' }
				}
			];
		}
		if (/^you (?:and|or) (?:permanents|a permanent) you control$/i.test(rawTarget)) {
			return [
				{
					kind: 'static',
					static: {
						k: 'staticDamagePrevention',
						...baseFlags,
						amount: 'all',
						target: 'youAndControlled'
					}
				}
			];
		}
		const youAndSub = rawTarget.match(/^you (?:and|or) (?:(?:a|an) )?(.+?) you control$/i);
		if (youAndSub) {
			const f = parseObjectPhraseWithQualifiers(youAndSub[1].replace(/\s+and\s+/gi, ' or '), true);
			if (f && !f.controller) {
				return [
					{
						kind: 'static',
						static: { k: 'staticDamagePrevention', ...baseFlags, amount: 'all', target: 'you' }
					},
					{
						kind: 'static',
						static: {
							k: 'staticDamagePrevention',
							...baseFlags,
							amount: 'all',
							target: { filter: { ...f, controller: 'you' } }
						}
					}
				];
			}
		}
		const aff = parseAffected(rawTarget);
		if (aff && typeof aff === 'object') {
			return [
				{
					kind: 'static',
					static: {
						k: 'staticDamagePrevention',
						...baseFlags,
						amount: 'all',
						target: { filter: aff }
					}
				}
			];
		}
	}

	// 5. "If a [quality] source would deal [combat/noncombat] damage to <target>, prevent N of that damage"
	const preventN = s.match(
		/^if (any source|a source|.+?) would deal (combat |noncombat )?damage to (~|(?:enchanted|equipped) (?:creature|permanent|planeswalker)|you|you or (?:a |an |another )?.+? you control|a permanent you control|(?:a|an|another) .+? you control), prevent (\S+) of that damage$/i
	);
	if (preventN) {
		const rawSrc = preventN[1].trim();
		const kindRaw = preventN[2]?.trim().toLowerCase();
		const rawTarget = preventN[3].trim();
		const amt = count(preventN[4]);
		if (amt && amt.k === 'const' && amt.n >= 1) {
			let sourceFilter:
				| ObjectFilter
				| 'blockingOrBlockedBySelf'
				| 'blockingSelf'
				| 'blockedBySelf'
				| undefined;
			if (!/^(?:a|any) source$/i.test(rawSrc)) {
				const parsedSrc = parsePreventionSourceFilter(rawSrc);
				if (!parsedSrc) return null;
				sourceFilter = parsedSrc;
			}
			const baseNFlags = {
				...(kindRaw === 'combat' ? { combatOnly: true } : {}),
				...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
				...(sourceFilter ? { sourceFilter } : {}),
				amount: amt.n
			};
			const youOrSubN = rawTarget.match(/^you or ((?:a |an |another )?.+?) you control$/i);
			if (youOrSubN && !/^a permanent$/i.test(youOrSubN[1].trim())) {
				const f = parseObjectPhraseWithQualifiers(youOrSubN[1], true);
				if (f && !f.controller) {
					return [
						{
							kind: 'static',
							static: { k: 'staticDamagePrevention', ...baseNFlags, target: 'you' }
						},
						{
							kind: 'static',
							static: {
								k: 'staticDamagePrevention',
								...baseNFlags,
								target: { filter: { ...f, controller: 'you' } }
							}
						}
					];
				}
			}
			let target: Extract<StaticDef, { k: 'staticDamagePrevention' }>['target'] | null = null;
			if (rawTarget === '~') target = 'self';
			else if (/^(?:enchanted|equipped) (?:creature|permanent|planeswalker)$/i.test(rawTarget)) {
				target = 'attachedTo';
			} else if (/^you$/i.test(rawTarget)) {
				target = 'you';
			} else if (/^you or a permanent you control$/i.test(rawTarget)) {
				target = 'youAndControlled';
			} else if (/^a permanent you control$/i.test(rawTarget)) {
				target = { filter: { controller: 'you' } };
			} else {
				const sub = rawTarget.match(/^((?:a|an|another) .+?) you control$/i);
				if (sub) {
					const f = parseObjectPhraseWithQualifiers(sub[1], true);
					if (f && !f.controller) target = { filter: { ...f, controller: 'you' } };
				}
			}
			if (target) {
				return [
					{
						kind: 'static',
						static: {
							k: 'staticDamagePrevention',
							...baseNFlags,
							target
						}
					}
				];
			}
		}
	}

	return null;
};
// --- End Track P14 ---

const RESTRICTIONS: Array<[RegExp, Extract<StaticDef, { k: 'restriction' }>['restriction']]> = [
	[/^(.+?) can't attack or block$/, 'cantAttackOrBlock'],
	[/^(.+?) can't attack you or planeswalkers you control$/i, 'cantAttackYouOrPlaneswalkers'],
	[/^(.+?) can't attack you$/i, 'cantAttackYou'],
	[/^(.+?) can't attack$/, 'cantAttack'],
	[/^(.+?) can't block$/, 'cantBlock'],
	[/^(.+?) can't be blocked$/, 'cantBeBlocked'],
	[/^(.+?) (?:attacks|attack) or (?:blocks|block) each combat if able$/i, 'attacksOrBlocksEachCombat'],
	[/^(.+?) (?:attacks|attack) each (?:combat|turn) if able$/, 'attacksEachCombat'],
	[/^(.+?) must attack each (?:combat|turn) if able$/i, 'attacksEachCombat'],
	[/^(.+?) (?:blocks|block) each combat if able$/, 'blocksEachCombat'],
	[/^(.+?) (?:can't|cannot) be countered$/i, 'cantBeCountered'],
	[/^(.+?) (?:doesn't|don't) untap during (?:your|its controller's|their controllers') untap steps?$/, 'doesntUntap'],
	[/^(.+?) (?:can't|cannot) crew Vehicles$/i, 'cantCrewVehicles'],
	[/^counters (?:can't|cannot) be put on (.+?)$/i, 'cantHaveCounters'],
	[/^(.+?) (?:can't|cannot) have counters put on (?:it|them)$/i, 'cantHaveCounters']
];

/** "~ can't block.", "Enchanted creature can't attack or block.", "Creatures your opponents control can't block." */
function restrictions(depth = 0): Production {
	const inner: Production = (s, span) => {
		// --- Track P22a: CR 122.6 specific counter locks ("can't have -1/-1 counters put on them", etc.) ---
		const typedCtrSubj = s.match(
			/^(.+?) (?:can't|cannot) have (.+?) counters? put on (?:it|them)$/i
		);
		if (typedCtrSubj && !/^any$/i.test(typedCtrSubj[2].trim())) {
			const affected = parseAffected(typedCtrSubj[1]);
			const ctr = lookupStaticCounter(typedCtrSubj[2]);
			if (affected && ctr) {
				return [
					{ kind: 'static', static: { k: 'cantHaveCounterType', affected, counter: ctr } }
				];
			}
		}
		const typedCtrPass = s.match(/^(.+?) counters? (?:can't|cannot) be put on (.+)$/i);
		if (typedCtrPass) {
			const ctr = lookupStaticCounter(typedCtrPass[1]);
			const affected = parseAffected(typedCtrPass[2]);
			if (affected && ctr) {
				return [
					{ kind: 'static', static: { k: 'cantHaveCounterType', affected, counter: ctr } }
				];
			}
		}
		// --- End Track P22a ---
		const bothBlock = s.match(/^(.+?) can't block and can't be blocked$/i);
		if (bothBlock) {
			const affected = parseAffected(bothBlock[1]);
			if (!affected) return null;
			return [
				{ kind: 'static', static: { k: 'restriction', affected, restriction: 'cantBlock' } },
				{ kind: 'static', static: { k: 'restriction', affected, restriction: 'cantBeBlocked' } }
			];
		}
		for (const [re, restriction] of RESTRICTIONS) {
			const m = s.match(re);
			if (!m) continue;
			const subj =
				restriction === 'cantBeCountered' ? m[1].replace(/\bspells?\b/gi, 'cards') : m[1];
			const affected = parseAffected(subj);
			if (!affected) return null;
			return [{ kind: 'static', static: { k: 'restriction', affected, restriction } }];
		}
		const withUnless = s.match(/^(.+?)\s+unless\s+(.+)$/i);
		if (withUnless) {
			const unlessCond = parseUnlessEtbCondition(withUnless[2]);
			if (unlessCond) {
				const baseItems = inner(withUnless[1], span);
				if (baseItems && withCondition(baseItems, { k: 'not', of: unlessCond })) {
					return baseItems;
				}
			}
		}
		const withIf = s.match(/^(.+?)\s+if\s+(.+)$/i);
		if (withIf && !/^able$/i.test(withIf[2].trim())) {
			const ifCond = parseStaticCondition(withIf[2]);
			if (ifCond) {
				const baseItems = inner(withIf[1], span);
				if (baseItems && withCondition(baseItems, ifCond)) {
					return baseItems;
				}
			}
		}
		// --- Track P14: Restriction with inline static tail (e.g. "Enchanted creature doesn't untap ... and has '...'") ---
		const { modifierPart, tailPart } = splitPtModifierAndTail(s);
		if (tailPart) {
			const baseItems = inner(modifierPart.trim(), span);
			if (
				baseItems &&
				baseItems.length > 0 &&
				baseItems[0].kind === 'static' &&
				baseItems[0].static.k === 'restriction'
			) {
				const affected = baseItems[0].static.affected;
				const tailItems = parseInlineStaticTail(affected, tailPart, undefined, depth);
				if (tailItems) {
					return [...baseItems, ...tailItems];
				}
			}
		}
		// --- End Track P14 ---
		return null;
	};
	return inner;
}

// --- Track P8: Static Combat Blocking/Evasion Rules (CR 508.1c, 509.1a–c) & Activated-Ability Locks (CR 602.5a) ---

function parseInlineCombatTail(
	affected: Affected,
	tail: string
): StaticItem | null {
	const low = tail.trim();
	if (/^can't be blocked$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'cantBeBlocked' } };
	}
	if (/^can't block$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'cantBlock' } };
	}
	if (/^can't attack$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'cantAttack' } };
	}
	if (/^can't attack or block$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'cantAttackOrBlock' } };
	}
	if (/^can't attack you or planeswalkers you control$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'restriction', affected, restriction: 'cantAttackYouOrPlaneswalkers' }
		};
	}
	if (/^can't attack you$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'cantAttackYou' } };
	}
	if (/^(?:attacks|attack) or (?:blocks|block) each combat if able$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'restriction', affected, restriction: 'attacksOrBlocksEachCombat' }
		};
	}
	if (/^(?:attacks|attack) each (?:combat|turn) if able$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'attacksEachCombat' } };
	}
	if (/^(?:blocks|block) each combat if able$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'blocksEachCombat' } };
	}
	if (/^loses? all abilities except mana abilities$/i.test(low)) {
		return continuous('6', affected, { k: 'removeAllAbilities', keepManaAbilities: true });
	}
	if (/^loses? all abilities$/i.test(low)) {
		return continuous('6', affected, { k: 'removeAllAbilities' });
	}
	if (/^must be blocked if able$/i.test(low)) {
		return { kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'mustBeBlockedIfAble' } } };
	}
	const dynBlkTail = low.match(/^can block an additional creature(?: each combat)? for each (.+)$/i);
	if (dynBlkTail) {
		const amt = parseCountAmount(`the number of ${dynBlkTail[1]}`);
		if (amt) {
			return {
				kind: 'static',
				static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCountDynamic', amount: amt } }
			};
		}
	}
	if (/^can block an additional creature(?: each combat)?$/i.test(low)) {
		return { kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCount', count: 1 } } };
	}
	const addBlkNTail = low.match(/^can block (?:up to )?(\S+) additional creatures(?: each combat)?$/i);
	if (addBlkNTail) {
		const num = count(addBlkNTail[1]);
		if (num && num.k === 'const' && num.n >= 1) {
			return {
				kind: 'static',
				static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCount', count: num.n } }
			};
		}
	}
	if (/^can block as though (?:it|they) had reach$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'combatRule', affected, rule: { kind: 'canBlockAsThoughReach' } }
		};
	}
	const reachFilterTail = low.match(/^can block (.+?) as though (?:it|they) had reach$/i);
	if (reachFilterTail) {
		const f = parseCombatObjectPhrase(reachFilterTail[1]);
		if (f) {
			return {
				kind: 'static',
				static: { k: 'combatRule', affected, rule: { kind: 'canBlockAsThoughReach', filter: f } }
			};
		}
	}
	if (/^can block any number of creatures(?: each combat)?$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCount', count: 'unlimited' } }
		};
	}
	const maxBlk = low.match(/^can't be blocked by more than (\S+) creatures?$/i);
	if (maxBlk) {
		const num = count(maxBlk[1]);
		if (num && num.k === 'const' && num.n >= 1) {
			return { kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'maxBlockers', max: num.n } } };
		}
	}
	// --- Track P14: Inline goad, defender override, untap lock, toughness damage, super-trample, & keyword loss ---
	if (/^(?:is|are) goaded$/i.test(low)) {
		return { kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'isGoaded' } } };
	}
	if (/^can attack as though (?:it|they) didn't have defender$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'combatRule', affected, rule: { kind: 'canAttackDespiteDefender' } }
		};
	}
	if (
		/^assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power$/i.test(
			low
		)
	) {
		return { kind: 'static', static: { k: 'assignCombatDamageByToughness', affected } };
	}
	if (/^assigns? (?:its|their) combat damage as though (?:it|they) weren't blocked$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'combatRule', affected, rule: { kind: 'assignCombatDamageAsThoughUnblocked' } }
		};
	}
	if (/^can't attack alone$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'combatRule', affected, rule: { kind: 'cantAttackAlone' } }
		};
	}
	if (/^can't block alone$/i.test(low)) {
		return {
			kind: 'static',
			static: { k: 'combatRule', affected, rule: { kind: 'cantBlockAlone' } }
		};
	}
	const cantTargetTail = low.match(/^can't be the targets? of (.+)$/i);
	if (cantTargetTail) {
		const item = parseCantBeTargetedByRhs(affected, cantTargetTail[1]);
		if (item) return item;
	}
	const cantBlkExceptByInline = low.match(/^can't be blocked except by (.+)$/i);
	if (cantBlkExceptByInline) {
		const raw = cantBlkExceptByInline[1].trim();
		const f = parseCombatObjectPhrase(raw);
		if (f) {
			return {
				kind: 'static',
				static: { k: 'combatRule', affected, rule: { kind: 'cantBeBlockedExceptBy', filter: f } }
			};
		}
		const split = raw.split(/\s+(?:and\/or|or)\s+/i);
		if (split.length === 2) {
			let rightRaw = split[1];
			const headWith = split[0].match(/^(.+?\bwith)\s+\S+$/i);
			if (headWith && !parseCombatObjectPhrase(rightRaw)) {
				rightRaw = `${headWith[1]} ${rightRaw}`;
			}
			const f1 = parseCombatObjectPhrase(split[0]);
			const f2 = parseCombatObjectPhrase(rightRaw);
			if (f1 && f2) {
				return {
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantBeBlockedExceptBy', filter: f1, orFilter: f2 }
					}
				};
			}
		}
	}
	const cantActTail = low.match(
		/^its activated abilities can't be activated( unless they're mana abilities)?$/i
	);
	if (cantActTail) {
		return {
			kind: 'static',
			static: {
				k: 'cantActivateAbilities',
				affected,
				...(cantActTail[1] ? { allowManaAbilities: true } : {})
			}
		};
	}
	const cantBlkByInline = low.match(/^can't be blocked by (.+)$/i);
	if (cantBlkByInline) {
		const f = parseCombatObjectPhrase(cantBlkByInline[1]);
		if (f) {
			return {
				kind: 'static',
				static: { k: 'combatRule', affected, rule: { kind: 'cantBeBlockedBy', filter: f } }
			};
		}
	}
	const cantBlkInline = low.match(/^can't block (.+)$/i);
	if (cantBlkInline && !/^alone$/i.test(cantBlkInline[1]) && !/^or be blocked\b/i.test(cantBlkInline[1])) {
		const f = parseCombatObjectPhrase(cantBlkInline[1]);
		if (f) {
			return {
				kind: 'static',
				static: { k: 'combatRule', affected, rule: { kind: 'cantBlockFilter', filter: f } }
			};
		}
	}
	if (
		/^(?:doesn't|don't) untap during (?:your|its controller's|their controllers') untap steps?$/i.test(
			low
		)
	) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'doesntUntap' } };
	}
	const loseKw = low.match(/^loses? (.+?)(?: and can't have or gain (.+))?$/i);
	if (loseKw && !/\babilities\b/i.test(loseKw[1])) {
		const kws = parseKeywordList(loseKw[1]);
		if (kws) {
			if (loseKw[2]) {
				const again = parseKeywordList(loseKw[2]);
				if (!again || again.join() !== kws.join()) return null;
			}
			return continuous('6', affected, {
				k: 'removeKeywords',
				keywords: kws,
				...(loseKw[2] ? { cantHaveOrGain: true } : {})
			});
		}
	}
	// --- End Track P14 ---
	return null;
}

const combatAndActivationRules: Production = (s) => {
	// 1. Activated-ability locks (CR 602.5a)
	const auraCombinedLock = s.match(
		/^((?:Enchanted|Equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker|wall|battle|vehicle|spacecraft)) (can't attack or block|can't attack|can't block|doesn't untap during its controller's untap step),? and its activated abilities can't be activated( unless they're mana abilities)?$/i
	);
	if (auraCombinedLock) {
		const affected = parseAffected(auraCombinedLock[1]);
		if (!affected) return null;
		const head = auraCombinedLock[2].toLowerCase();
		const restriction: Extract<StaticDef, { k: 'restriction' }>['restriction'] =
			head === "can't attack or block"
				? 'cantAttackOrBlock'
				: head === "can't attack"
					? 'cantAttack'
					: head === "can't block"
						? 'cantBlock'
						: 'doesntUntap';
		const allowManaAbilities = Boolean(auraCombinedLock[3]);
		return [
			{ kind: 'static', static: { k: 'restriction', affected, restriction } },
			{
				kind: 'static',
				static: {
					k: 'cantActivateAbilities',
					affected,
					...(allowManaAbilities ? { allowManaAbilities: true } : {})
				}
			}
		];
	}

	const auraPossessiveLock = s.match(
		/^((?:Enchanted|Equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker|wall|battle|vehicle|spacecraft))'s activated abilities can't be activated( unless they're mana abilities)?$/i
	);
	if (auraPossessiveLock) {
		const affected = parseAffected(auraPossessiveLock[1]);
		if (!affected) return null;
		const allowManaAbilities = Boolean(auraPossessiveLock[2]);
		return [
			{
				kind: 'static',
				static: {
					k: 'cantActivateAbilities',
					affected,
					...(allowManaAbilities ? { allowManaAbilities: true } : {})
				}
			}
		];
	}

	const globalLock = s.match(
		/^Activated abilities of (.+?) can't be activated( unless they're mana abilities)?$/i
	);
	if (globalLock) {
		const affected = parseAffected(globalLock[1]);
		if (!affected) return null;
		const allowManaAbilities = Boolean(globalLock[2]);
		return [
			{
				kind: 'static',
				static: {
					k: 'cantActivateAbilities',
					affected,
					...(allowManaAbilities ? { allowManaAbilities: true } : {})
				}
			}
		];
	}

	// 2. Static Combat Blocking & Evasion Rules (CR 508.1c, 509.1a–c)
	if (/^Creatures with power less than ~'s power can't block (?:it|~)$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: { k: 'combatRule', affected: 'self', rule: { kind: 'cantBeBlockedByPowerLessThanSelf' } }
			}
		];
	}
	// --- Track P14: Super-trample (CR 510.1c–d), defender override, goad, & Wave 5 block restrictions ---
	if (
		/^Creatures with power greater than (?:~'s|(?:enchanted|equipped) creature's) power can't block (?:it|~|(?:enchanted|equipped) creature)$/i.test(
			s
		)
	) {
		const isAtt = /enchanted|equipped/i.test(s);
		return [
			{
				kind: 'static',
				static: {
					k: 'combatRule',
					affected: isAtt ? 'attachedTo' : 'self',
					rule: { kind: 'cantBeBlockedByPowerGreaterThanSelf' }
				}
			}
		];
	}
	const cantBlkGreaterSelf = s.match(
		/^(.+?) can't be blocked by creatures with (?:power greater than (~'s|its|their) power|greater power)$/i
	);
	if (cantBlkGreaterSelf) {
		const affected = parseAffected(cantBlkGreaterSelf[1]);
		if (affected && (cantBlkGreaterSelf[2]?.toLowerCase() !== "~'s" || affected === 'self')) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantBeBlockedByPowerGreaterThanSelf' }
					}
				}
			];
		}
	}
	const cantBlkLessSelf = s.match(
		/^(.+?) can't be blocked by creatures with (?:power less than (~'s|its|their) power|less power)$/i
	);
	if (cantBlkLessSelf) {
		const affected = parseAffected(cantBlkLessSelf[1]);
		if (affected && (cantBlkLessSelf[2]?.toLowerCase() !== "~'s" || affected === 'self')) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantBeBlockedByPowerLessThanSelf' }
					}
				}
			];
		}
	}
	const cantBlkDefCtrl = s.match(
		/^(.+?) can't be blocked as long as defending player controls (?:a |an )?(.+)$/i
	);
	if (cantBlkDefCtrl) {
		const affected = parseAffected(cantBlkDefCtrl[1]);
		const filter = parseCombatObjectPhrase(cantBlkDefCtrl[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantBeBlockedIfDefenderControls', filter }
					}
				}
			];
		}
	}
	const superTrample = s.match(
		/^You may have (.+?) assign (?:its|their) combat damage as though (?:it|they) weren't blocked$/i
	);
	if (superTrample) {
		const affected = parseAffected(superTrample[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'assignCombatDamageAsThoughUnblocked' }
					}
				}
			];
		}
	}
	const superTrampleEach = s.match(
		/^For each (.+?), you may have that (?:creature|permanent) assign its combat damage as though it weren't blocked$/i
	);
	if (superTrampleEach) {
		const affected = parseAffected(superTrampleEach[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'assignCombatDamageAsThoughUnblocked' }
					}
				}
			];
		}
	}
	const despiteDefender = s.match(
		/^(.+?) can attack as though (?:it|they) didn't have defender$/i
	);
	if (despiteDefender) {
		const affected = parseAffected(despiteDefender[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'canAttackDespiteDefender' } }
				}
			];
		}
	}
	const goadedRule = s.match(/^(.+?) (?:is|are) goaded$/i);
	if (goadedRule) {
		const affected = parseAffected(goadedRule[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'isGoaded' } }
				}
			];
		}
	}

	const cantBlkPwr = s.match(
		/^(.+?) can't block creatures with power (greater|less) than (?:~'s|its|their) power$/i
	);
	if (cantBlkPwr) {
		const affected = parseAffected(cantBlkPwr[1]);
		if (affected) {
			const kind =
				cantBlkPwr[2].toLowerCase() === 'greater'
					? 'cantBlockPowerGreaterThanSelf'
					: 'cantBlockPowerLessThanSelf';
			return [{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind } } }];
		}
	}

	const cantBlkOrBeBlk = s.match(/^(.+?) can't block or be blocked by (.+)$/i);
	if (cantBlkOrBeBlk) {
		const affected = parseAffected(cantBlkOrBeBlk[1]);
		const filter = parseCombatObjectPhrase(cantBlkOrBeBlk[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'cantBlockFilter', filter } }
				},
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'cantBeBlockedBy', filter } }
				}
			];
		}
	}
	// --- End Track P14 ---

	const canBlockOnly = s.match(/^(.+?) can block only (.+)$/i);
	if (canBlockOnly) {
		const affected = parseAffected(canBlockOnly[1]);
		const filter = parseCombatObjectPhrase(canBlockOnly[2]);
		if (affected && filter) {
			return [
				{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'cantBlockExcept', filter } } }
			];
		}
	}

	const addBlockAny = s.match(/^(.+?) can block any number of creatures(?: each combat)?$/i);
	if (addBlockAny) {
		const affected = parseAffected(addBlockAny[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCount', count: 'unlimited' } }
				}
			];
		}
	}

	const addBlockDyn = s.match(
		/^(.+?) can block an additional creature(?: each combat)? for each (.+)$/i
	);
	if (addBlockDyn) {
		const affected = parseAffected(addBlockDyn[1]);
		const amount = parseCountAmount(`the number of ${addBlockDyn[2]}`);
		if (affected && amount) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'additionalBlockCountDynamic', amount }
					}
				}
			];
		}
	}

	const addBlockOne = s.match(/^(.+?) can block an additional creature(?: each combat)?$/i);
	if (addBlockOne) {
		const affected = parseAffected(addBlockOne[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCount', count: 1 } }
				}
			];
		}
	}

	const virtReachAll = s.match(/^(.+?) can block as though (?:it|they) had reach$/i);
	if (virtReachAll) {
		const affected = parseAffected(virtReachAll[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'canBlockAsThoughReach' } }
				}
			];
		}
	}

	const virtReachFiltered = s.match(/^(.+?) can block (.+?) as though (?:it|they) had reach$/i);
	if (virtReachFiltered) {
		const affected = parseAffected(virtReachFiltered[1]);
		const filter = parseCombatObjectPhrase(virtReachFiltered[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'canBlockAsThoughReach', filter } }
				}
			];
		}
	}

	const ignoreSpecificWalk = s.match(
		/^Creatures with (plainswalk|islandwalk|swampwalk|mountainwalk|forestwalk|nonbasic landwalk|snow landwalk) can be blocked as though they didn't have \1$/i
	);
	if (ignoreSpecificWalk) {
		return [
			{
				kind: 'static',
				static: {
					k: 'combatRule',
					affected: { types: ['Creature'] },
					rule: { kind: 'ignoreLandwalk', keyword: ignoreSpecificWalk[1].toLowerCase() }
				}
			}
		];
	}

	if (
		/^Creatures with landwalk abilities can be blocked as though they didn't have those abilities$/i.test(
			s
		)
	) {
		const walks = [
			'plainswalk',
			'islandwalk',
			'swampwalk',
			'mountainwalk',
			'forestwalk',
			'nonbasic landwalk',
			'snow landwalk'
		];
		return walks.map((keyword) => ({
			kind: 'static' as const,
			static: {
				k: 'combatRule' as const,
				affected: { types: ['Creature'] },
				rule: { kind: 'ignoreLandwalk' as const, keyword }
			}
		}));
	}

	const crewDelta = s.match(
		/^(.+?) crews? Vehicles( and saddles? Mounts)? as though (?:its|their) power were (\d+) greater$/i
	);
	if (crewDelta) {
		const affected = parseAffected(crewDelta[1]);
		const delta = parseInt(crewDelta[3], 10);
		if (affected && delta > 0) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: {
							kind: 'crewSaddlePowerMod',
							appliesTo: crewDelta[2] ? 'both' : 'crew',
							delta
						}
					}
				}
			];
		}
	}

	const saddleDelta = s.match(
		/^(.+?) saddles? Mounts( and crews? Vehicles)? as though (?:its|their) power were (\d+) greater$/i
	);
	if (saddleDelta) {
		const affected = parseAffected(saddleDelta[1]);
		const delta = parseInt(saddleDelta[3], 10);
		if (affected && delta > 0) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: {
							kind: 'crewSaddlePowerMod',
							appliesTo: saddleDelta[2] ? 'both' : 'saddle',
							delta
						}
					}
				}
			];
		}
	}

	const crewTough = s.match(
		/^(.+?) crews? Vehicles( and saddles? Mounts)? using (?:its|their) toughness rather than (?:its|their) power$/i
	);
	if (crewTough) {
		const affected = parseAffected(crewTough[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: {
							kind: 'crewSaddlePowerMod',
							appliesTo: crewTough[2] ? 'both' : 'crew',
							useToughness: true
						}
					}
				}
			];
		}
	}

	const addBlockN = s.match(
		/^(.+?) can block (?:(?:up to )?(\S+) additional|an additional (\S+)) creatures?(?: each combat)?$/i
	);
	if (addBlockN) {
		const affected = parseAffected(addBlockN[1]);
		const amt = count(addBlockN[2] ?? addBlockN[3]);
		if (affected && amt && amt.k === 'const' && amt.n >= 1) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCount', count: amt.n } }
				}
			];
		}
	}

	const maxBlockers = s.match(/^(.+?) can't be blocked by more than (\S+) creatures?$/i);
	if (maxBlockers) {
		const affected = parseAffected(maxBlockers[1]);
		const amt = count(maxBlockers[2]);
		if (affected && amt && amt.k === 'const' && amt.n >= 1) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'maxBlockers', max: amt.n } }
				}
			];
		}
	}

	const minBlockers = s.match(/^(.+?) can't be blocked except by (\S+) or more creatures$/i);
	if (minBlockers) {
		const affected = parseAffected(minBlockers[1]);
		const amt = count(minBlockers[2]);
		if (affected && amt && amt.k === 'const' && amt.n >= 2) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'minBlockers', min: amt.n } }
				}
			];
		}
	}

	const exceptBy = s.match(/^(.+?) can't be blocked except by (.+)$/i);
	if (exceptBy) {
		const affected = parseAffected(exceptBy[1]);
		if (affected) {
			const raw = exceptBy[2].trim();
			const single = parseCombatObjectPhrase(raw);
			if (single) {
				return [
					{
						kind: 'static',
						static: { k: 'combatRule', affected, rule: { kind: 'cantBeBlockedExceptBy', filter: single } }
					}
				];
			}
			const split = raw.split(/\s+(?:and\/or|or)\s+/i);
			if (split.length === 2) {
				let rightRaw = split[1];
				const headWith = split[0].match(/^(.+?\bwith)\s+\S+$/i);
				if (headWith && !parseCombatObjectPhrase(rightRaw)) {
					rightRaw = `${headWith[1]} ${rightRaw}`;
				}
				const f1 = parseCombatObjectPhrase(split[0]);
				const f2 = parseCombatObjectPhrase(rightRaw);
				if (f1 && f2) {
					return [
						{
							kind: 'static',
							static: {
								k: 'combatRule',
								affected,
								rule: { kind: 'cantBeBlockedExceptBy', filter: f1, orFilter: f2 }
							}
						}
					];
				}
			}
		}
	}

	const cantBeBlockedBy = s.match(/^(.+?) can't be blocked by (.+)$/i);
	if (cantBeBlockedBy) {
		const affected = parseAffected(cantBeBlockedBy[1]);
		const filter = parseCombatObjectPhrase(cantBeBlockedBy[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'cantBeBlockedBy', filter } }
				}
			];
		}
	}

	const mustBeBlocked = s.match(/^(.+?) must be blocked if able$/i);
	if (mustBeBlocked) {
		const affected = parseAffected(mustBeBlocked[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'mustBeBlockedIfAble' } }
				}
			];
		}
	}

	const allAble = s.match(/^All creatures able to block (.+?) do so$/i);
	if (allAble) {
		const affected = parseAffected(allAble[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'allAbleBlockers' } }
				}
			];
		}
	}

	const cantAttackUnless = s.match(/^(.+?) can't attack unless defending player controls (?:a |an )?(.+)$/i);
	if (cantAttackUnless) {
		const affected = parseAffected(cantAttackUnless[1]);
		const filter = parseCombatObjectPhrase(cantAttackUnless[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantAttackUnlessDefenderControls', filter }
					}
				}
			];
		}
	}

	// --- Track P22a: Port Razer, Veteran Brawlers, & Mogg Toady combat rules ---
	const cantAtkAlready = s.match(
		/^(.+?) can't attack a player (?:it|he|she|they) (?:has|have) already attacked this turn$/i
	);
	if (cantAtkAlready) {
		const affected = parseAffected(cantAtkAlready[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantAttackAlreadyAttackedPlayerThisTurn' }
					}
				}
			];
		}
	}
	const cantAtkIfDef = s.match(/^(.+?) can't attack if defending player controls (?:a |an )?(.+)$/i);
	if (cantAtkIfDef) {
		const affected = parseAffected(cantAtkIfDef[1]);
		const filter = parseCombatObjectPhrase(cantAtkIfDef[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantAttackIfDefenderControls', filter }
					}
				}
			];
		}
	}
	const cantBlkIfYou = s.match(/^(.+?) can't block if you control (?:a |an )?(.+)$/i);
	if (cantBlkIfYou) {
		const affected = parseAffected(cantBlkIfYou[1]);
		const filter = parseCombatObjectPhrase(cantBlkIfYou[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantBlockIfYouControl', filter }
					}
				}
			];
		}
	}
	const cantAtkMoreCreatures = s.match(
		/^(.+?) can't attack unless you control more creatures than defending player$/i
	);
	if (cantAtkMoreCreatures) {
		const affected = parseAffected(cantAtkMoreCreatures[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantAttackUnlessMoreCreaturesThanDefender' }
					}
				}
			];
		}
	}
	const cantBlkMoreCreatures = s.match(
		/^(.+?) can't block unless you control more creatures than attacking player$/i
	);
	if (cantBlkMoreCreatures) {
		const affected = parseAffected(cantBlkMoreCreatures[1]);
		if (affected) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantBlockUnlessMoreCreaturesThanAttacker' }
					}
				}
			];
		}
	}
	// --- End Track P22a ---

	const cantAtkOrBlkAlone = s.match(/^(.+?) can't attack or block alone$/i);
	if (cantAtkOrBlkAlone) {
		const affected = parseAffected(cantAtkOrBlkAlone[1]);
		if (affected) {
			return [
				{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'cantAttackAlone' } } },
				{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'cantBlockAlone' } } }
			];
		}
	}

	const cantAtkAlone = s.match(/^(.+?) can't attack alone$/i);
	if (cantAtkAlone) {
		const affected = parseAffected(cantAtkAlone[1]);
		if (affected) {
			return [
				{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'cantAttackAlone' } } }
			];
		}
	}

	const cantBlkAlone = s.match(/^(.+?) can't block alone$/i);
	if (cantBlkAlone) {
		const affected = parseAffected(cantBlkAlone[1]);
		if (affected) {
			return [
				{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'cantBlockAlone' } } }
			];
		}
	}

	// --- Track P14: Generalized "[affected] can't block <filter>" ---
	const cantBlkFilter = s.match(/^(.+?) can't block (.+)$/i);
	if (
		cantBlkFilter &&
		!/^alone$/i.test(cantBlkFilter[2]) &&
		!/^and can't be blocked$/i.test(cantBlkFilter[2]) &&
		!/^or be blocked\b/i.test(cantBlkFilter[2])
	) {
		const affected = parseAffected(cantBlkFilter[1]);
		const filter = parseCombatObjectPhrase(cantBlkFilter[2]);
		if (affected && filter) {
			return [
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'cantBlockFilter', filter } }
				}
			];
		}
	}
	// --- End Track P14 ---

	const globalMaxAtk = s.match(/^No more than (\S+) creatures? can attack( you)? each combat$/i);
	if (globalMaxAtk) {
		const amt = count(globalMaxAtk[1]);
		if (amt && amt.k === 'const' && amt.n >= 1) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected: 'self',
						rule: {
							kind: 'globalMaxAttackers',
							max: amt.n,
							...(globalMaxAtk[2] ? { againstYouOnly: true } : {})
						}
					}
				}
			];
		}
	}

	const globalMaxBlk = s.match(/^No more than (\S+) creatures? can block each combat$/i);
	if (globalMaxBlk) {
		const amt = count(globalMaxBlk[1]);
		if (amt && amt.k === 'const' && amt.n >= 1) {
			return [
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected: 'self',
						rule: { kind: 'globalMaxBlockers', max: amt.n }
					}
				}
			];
		}
	}

	// --- Track P11 + Track P17a: Untap choice, Seedborn untap during other players' untap steps (CR 502.3), & Toughness combat damage (CR 510.1a) ---
	const mayChooseUntap = s.match(/^You may choose not to untap (.+?) during your untap step$/i);
	if (mayChooseUntap) {
		const affected = parseAffected(mayChooseUntap[1]);
		if (affected) {
			return [{ kind: 'static', static: { k: 'mayChooseNotToUntap', affected } }];
		}
	}
	if (
		/^(?:Enchanted|Equipped) creature's controller may have it assign its combat damage as though it weren't blocked$/i.test(
			s
		)
	) {
		return [
			{
				kind: 'static',
				static: {
					k: 'combatRule',
					affected: 'attachedTo',
					rule: { kind: 'assignCombatDamageAsThoughUnblocked' }
				}
			}
		];
	}
	const cantAtkOrBlkCtrl = s.match(/^(.+?) can't attack you or block creatures you control$/i);
	if (cantAtkOrBlkCtrl) {
		const affected = parseAffected(cantAtkOrBlkCtrl[1]);
		if (affected) {
			return [
				{ kind: 'static', static: { k: 'restriction', affected, restriction: 'cantAttackYou' } },
				{
					kind: 'static',
					static: {
						k: 'combatRule',
						affected,
						rule: { kind: 'cantBlockFilter', filter: { types: ['Creature'], controller: 'you' } }
					}
				}
			];
		}
	}
	const untapOthersAll = s.match(
		/^Untap (?:(?:all|each) (.+?)|(~)) during each other player's untap step$/i
	);
	if (untapOthersAll) {
		const affected = parseAffected(untapOthersAll[1] ?? untapOthersAll[2]);
		if (affected) {
			return [{ kind: 'static', static: { k: 'untapDuringOtherUntapSteps', affected } }];
		}
	}
	const untapOthersSingle = s.match(
		/^(~|(?:Enchanted|Equipped) (?:creature|permanent|artifact|land|planeswalker)) untaps during each other player's untap step$/i
	);
	if (untapOthersSingle) {
		const affected = parseAffected(untapOthersSingle[1]);
		if (affected) {
			return [{ kind: 'static', static: { k: 'untapDuringOtherUntapSteps', affected } }];
		}
	}
	const toughAndDef1 = s.match(
		/^(.+?) assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power and can attack as though (?:it|they) didn't have defender$/i
	);
	const toughAndDef2 = !toughAndDef1
		? s.match(
				/^(.+?) can attack as though (?:it|they) didn't have defender and assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power$/i
			)
		: null;
	const toughAndDefSubj = toughAndDef1?.[1] ?? toughAndDef2?.[1];
	if (toughAndDefSubj) {
		const affected = parseAffected(toughAndDefSubj);
		if (affected) {
			return [
				{ kind: 'static', static: { k: 'assignCombatDamageByToughness', affected } },
				{
					kind: 'static',
					static: { k: 'combatRule', affected, rule: { kind: 'canAttackDespiteDefender' } }
				}
			];
		}
	}
	const toughDmg = s.match(
		/^(.+?) assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power$/i
	);
	if (toughDmg) {
		const affected = parseAffected(toughDmg[1]);
		if (affected) {
			return [{ kind: 'static', static: { k: 'assignCombatDamageByToughness', affected } }];
		}
	}
	const oppCantBlockWith = s.match(/^(?:Your opponents|Each opponent) can't block with (.+)$/i);
	if (oppCantBlockWith) {
		const f = parseObjectPhraseWithQualifiers(oppCantBlockWith[1], true);
		if (f && !f.controller) {
			return [
				{
					kind: 'static',
					static: {
						k: 'restriction',
						affected: { ...f, controller: 'opponent' },
						restriction: 'cantBlock'
					}
				}
			];
		}
	}
	// --- End Track P11 ---

	return null;
};

// --- Track P8: Top-of-Library Look/Reveal/Play (CR 401.5, 601.3e) & Graveyard Land Play (CR 305.1) ---

function parseSpellFilterForTopLibrary(raw: string): ObjectFilter | null {
	const trimmed = raw.trim();
	const chosenType = trimmed.match(/^(.+?) spells? of the chosen type$/i);
	if (chosenType) {
		const base = parseObjectPhraseWithQualifiers(`${chosenType[1]} card`, true);
		return base ? { ...base, ofChosenType: true } : null;
	}
	if (/^spells? of the chosen type$/i.test(trimmed)) {
		return { ofChosenType: true };
	}
	const spellsWithKwOr = trimmed.match(
		/^(?:(?:a|an)\s+)?spells? with ([a-z]+(?: strike)?)\s+or\s+([a-z]+(?: strike)?)$/i
	);
	if (spellsWithKwOr) {
		const k1 = parseKeywordList(spellsWithKwOr[1]);
		const k2 = parseKeywordList(spellsWithKwOr[2]);
		if (k1?.length === 1 && k2?.length === 1) {
			return { anyOf: [{ hasKeywords: k1 }, { hasKeywords: k2 }] };
		}
	}
	const spellsWithQual = trimmed.match(/^(?:(?:a|an)\s+)?spells? with (.+)$/i);
	if (spellsWithQual) {
		return parseObjectPhraseWithQualifiers(`card with ${spellsWithQual[1]}`, true);
	}
	// --- Track P14: "permanent spell(s) [with ...]" and singular/plural spell filters ---
	const permSpell = trimmed.match(/^(?:(?:a|an)\s+)?permanent spells?(?:\s+with\s+(.+))?$/i);
	if (permSpell) {
		if (!permSpell[1]) return { types: [...PERMANENT_CARD_TYPES] };
		const qual = parseObjectPhraseWithQualifiers(`card with ${permSpell[1]}`, true);
		return qual ? { ...qual, types: [...PERMANENT_CARD_TYPES] } : null;
	}
	const singleOrPlural = trimmed.match(/^(?:(?:a|an)\s+)?(.+?) spells?(\s+with\s+.+)?$/i);
	if (singleOrPlural) {
		const head = singleOrPlural[1].replace(/\s+and(?:\/or)?\s+/gi, ' or ');
		const tail = singleOrPlural[2] ?? '';
		return (
			parseObjectPhraseWithQualifiers(`${head} cards${tail}`, true) ??
			parseObjectPhraseWithQualifiers(`${head} card${tail}`, true)
		);
	}
	// --- End Track P14 ---
	const spellMatch = trimmed.match(/^(.+?) spells$/i);
	if (!spellMatch) return null;
	return (
		parseObjectPhraseWithQualifiers(`${spellMatch[1]} cards`, true) ??
		parseObjectPhraseWithQualifiers(`${spellMatch[1]} card`, true)
	);
}

const topOfLibraryAndGraveyardPlay: Production = (s, span) => {
	// --- Track P14: Turn-slotted & self graveyard / exile / top-of-library play permissions ---
	const lookAndPlay = s.match(
		/^You may look at the top card of your library any time,?\s+and (you may (?:play|cast) .+)$/i
	);
	if (lookAndPlay) {
		const tailSentence = lookAndPlay[1].charAt(0).toUpperCase() + lookAndPlay[1].slice(1);
		const sub = topOfLibraryAndGraveyardPlay(tailSentence, span);
		if (sub && sub.length > 0) {
			return [
				{ kind: 'static', static: { k: 'topOfLibraryVisibility', mode: 'look' } },
				...sub
			];
		}
	}
	if (
		/^During each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard$/i.test(
			s
		)
	) {
		return [
			{
				kind: 'static',
				static: {
					k: 'zonePlayPermission',
					zone: 'graveyard',
					allowLands: true,
					allowSpells: true,
					spellFilter: { types: [...PERMANENT_CARD_TYPES] },
					duringYourTurnOnly: true,
					slotMode: 'perPermanentType'
				}
			}
		];
	}
	const onceSlot = s.match(
		/^Once (?:during )?each (of your )?turns?, you may (play a land(?: (and|or) cast (.+?))?|cast (.+?)) from (your graveyard|exile|the top of your library)$/i
	);
	if (onceSlot) {
		const duringYourTurnOnly = Boolean(onceSlot[1]) || /^Once during each of your turns/i.test(s);
		const rawZone = onceSlot[6].toLowerCase();
		const zone: 'graveyard' | 'exile' | 'library' =
			rawZone === 'exile' ? 'exile' : rawZone === 'your graveyard' ? 'graveyard' : 'library';
		const isPlayLand = onceSlot[2].toLowerCase().startsWith('play a land');
		const conj = onceSlot[3]?.toLowerCase();
		const rawSpell = (onceSlot[4] ?? onceSlot[5])?.trim();
		if (isPlayLand && !rawSpell) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone,
						allowLands: true,
						...(duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
						slotMode: 'oncePerTurn'
					}
				}
			];
		}
		let spellFilter: ObjectFilter | undefined;
		let spellOk = false;
		if (rawSpell) {
			if (/^(?:a )?spell$/i.test(rawSpell)) {
				spellOk = true;
			} else {
				const parsed = parseSpellFilterForTopLibrary(rawSpell);
				if (parsed) {
					spellFilter = parsed;
					spellOk = true;
				}
			}
		}
		if (spellOk) {
			if (isPlayLand && conj === 'and') {
				return [
					{
						kind: 'static',
						static: {
							k: 'zonePlayPermission',
							zone,
							allowLands: true,
							...(duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
							slotMode: 'oncePerTurn'
						}
					},
					{
						kind: 'static',
						static: {
							k: 'zonePlayPermission',
							zone,
							allowSpells: true,
							...(spellFilter ? { spellFilter } : {}),
							...(duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
							slotMode: 'oncePerTurn'
						}
					}
				];
			}
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone,
						...(isPlayLand ? { allowLands: true } : {}),
						allowSpells: true,
						...(spellFilter ? { spellFilter } : {}),
						...(duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
						slotMode: 'oncePerTurn'
					}
				}
			];
		}
	}
	const duringEachYourTurnBoth = s.match(
		/^During each of your turns, you may play a land (and|or) cast (.+?) from (your graveyard|exile|the top of your library)$/i
	);
	if (duringEachYourTurnBoth) {
		const conj = duringEachYourTurnBoth[1].toLowerCase();
		const rawSpell = duringEachYourTurnBoth[2].trim();
		const rawZone = duringEachYourTurnBoth[3].toLowerCase();
		const zone: 'graveyard' | 'exile' | 'library' =
			rawZone === 'exile' ? 'exile' : rawZone === 'your graveyard' ? 'graveyard' : 'library';
		const spellFilter = /^(?:a )?spell$/i.test(rawSpell)
			? undefined
			: parseSpellFilterForTopLibrary(rawSpell);
		if (/^(?:a )?spell$/i.test(rawSpell) || spellFilter) {
			if (conj === 'and') {
				return [
					{
						kind: 'static',
						static: {
							k: 'zonePlayPermission',
							zone,
							allowLands: true,
							duringYourTurnOnly: true,
							slotMode: 'oncePerTurn'
						}
					},
					{
						kind: 'static',
						static: {
							k: 'zonePlayPermission',
							zone,
							allowSpells: true,
							...(spellFilter ? { spellFilter } : {}),
							duringYourTurnOnly: true,
							slotMode: 'oncePerTurn'
						}
					}
				];
			}
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone,
						allowLands: true,
						allowSpells: true,
						...(spellFilter ? { spellFilter } : {}),
						duringYourTurnOnly: true,
						slotMode: 'oncePerTurn'
					}
				}
			];
		}
	}
	const selfGyOrExile = s.match(
		/^You may cast ~ from (your graveyard or from exile|your graveyard|exile)(?: if (.+))?$/i
	);
	if (selfGyOrExile) {
		let cond: Condition | undefined;
		if (selfGyOrExile[2]) {
			const parsedCond =
				parseCondition(`if ${selfGyOrExile[2]}`) ?? parseStaticCondition(selfGyOrExile[2]);
			if (!parsedCond) return null;
			cond = parsedCond;
		}
		const where = selfGyOrExile[1].toLowerCase();
		if (where === 'your graveyard or from exile') {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'graveyard',
						allowSpells: true,
						affects: 'self',
						...(cond ? { condition: cond } : {})
					}
				},
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'exile',
						allowSpells: true,
						affects: 'self',
						...(cond ? { condition: cond } : {})
					}
				}
			];
		}
		const zone: 'graveyard' | 'exile' = where === 'exile' ? 'exile' : 'graveyard';
		return [
			{
				kind: 'static',
				static: {
					k: 'zonePlayPermission',
					zone,
					allowSpells: true,
					affects: 'self',
					...(cond ? { condition: cond } : {})
				}
			}
		];
	}
	if (/^You may play lands and cast spells from your graveyard$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: { k: 'zonePlayPermission', zone: 'graveyard', allowLands: true, allowSpells: true }
			}
		];
	}
	// --- Track P22a: Graveyard keyword alt-cast ("using its blitz/dash/bestow/mutate/warp ability") & exiled-with-self look ---
	const selfGyKwCast = s.match(
		/^You may cast ~ from your graveyard using its (blitz|dash|bestow|mutate|warp) ability$/i
	);
	if (selfGyKwCast) {
		const keyword = selfGyKwCast[1].toLowerCase() as 'blitz' | 'dash' | 'bestow' | 'mutate' | 'warp';
		return [{ kind: 'static', static: { k: 'selfGraveyardKeywordCast', keyword } }];
	}
	if (/^You may look at cards exiled with ~$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'mayLookAtExiledWithSelf' } }];
	}
	// --- End Track P22a ---
	const playLandsAndGySpells = s.match(
		/^You may play lands and cast (.+?) from your graveyard$/i
	);
	if (playLandsAndGySpells) {
		const spellFilter = parseSpellFilterForTopLibrary(playLandsAndGySpells[1]);
		if (spellFilter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'graveyard',
						allowLands: true,
						allowSpells: true,
						spellFilter
					}
				}
			];
		}
	}
	if (/^You may cast spells from your graveyard$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'zonePlayPermission', zone: 'graveyard', allowSpells: true } }];
	}
	const castGySpells = s.match(/^You may cast (.+?) from your graveyard$/i);
	if (castGySpells && castGySpells[1].trim() !== '~') {
		const spellFilter = parseSpellFilterForTopLibrary(castGySpells[1]);
		if (spellFilter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'graveyard',
						allowSpells: true,
						spellFilter
					}
				}
			];
		}
	}
	// --- End Track P14 ---
	// --- Track P11: Static alternative cast permissions (CR 118.9) ---
	const selfAltCast = s.match(
		/^You may pay ((?:\{[^}]+\})+) rather than pay (?:~'s|this spell's) mana cost$/i
	);
	if (selfAltCast) {
		return [
			{
				kind: 'static',
				static: { k: 'altCastPermission', affects: 'self', manaCost: selfAltCast[1] }
			}
		];
	}
	const extAltCast = s.match(
		/^You may pay ((?:\{[^}]+\})+) rather than pay the mana cost for (?:(.+?) )?spells(?: that)? you cast$/i
	);
	if (extAltCast) {
		let filter: ObjectFilter = {};
		if (extAltCast[2]) {
			const f = parseObjectPhrase(`${extAltCast[2].replace(/\s+and\s+/gi, ' or ')} card`);
			if (!f) return null;
			filter = f;
		}
		return [
			{
				kind: 'static',
				static: { k: 'altCastPermission', affects: { k: 'spell', filter }, manaCost: extAltCast[1] }
			}
		];
	}
	// --- End Track P11 ---
	if (/^You may look at the top card of your library any time$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'topOfLibraryVisibility', mode: 'look' } }];
	}
	if (/^Play with the top card of your library revealed$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'topOfLibraryVisibility', mode: 'reveal' } }];
	}
	// --- Track P17a: Global top-of-library / hand visibility, Omniscience, pitch alt-casts & spellGrantKeyword ---
	if (/^(?:All )?Players play with the top card of their libraries revealed$/i.test(s)) {
		return [
			{ kind: 'static', static: { k: 'topOfLibraryVisibility', mode: 'reveal', players: 'all' } }
		];
	}
	if (/^Your opponents play with their hands revealed$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'handVisibility', players: 'opponents' } }];
	}
	if (/^(?:All )?Players play with their hands revealed$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'handVisibility', players: 'all' } }];
	}
	if (/^Play with your hand revealed$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'handVisibility', players: 'you' } }];
	}
	const freeMvDynamic = s.match(
		/^You may cast (?:(.+?) )?spells with mana value less than or equal to (.+?)( from your hand)? without paying their mana costs$/i
	);
	if (freeMvDynamic) {
		let baseFilter: ObjectFilter = {};
		if (freeMvDynamic[1]) {
			const f = parseObjectPhraseWithQualifiers(
				`${freeMvDynamic[1].replace(/\s+and\s+/gi, ' or ')} card`,
				true
			);
			if (!f) return null;
			baseFilter = f;
		}
		const mvAmt = count(freeMvDynamic[2]) ?? parseCountAmount(freeMvDynamic[2]);
		if (mvAmt) {
			const allowedZones: ZoneType[] = freeMvDynamic[3]
				? ['hand']
				: ['hand', 'graveyard', 'exile', 'library', 'command'];
			return [
				{
					kind: 'static',
					static: {
						k: 'altCastPermission',
						manaCost: '{0}',
						affects: { filter: { ...baseFilter, manaValue: { op: '<=', value: mvAmt } } },
						allowedZones
					}
				}
			];
		}
	}
	const freeFromHand = s.match(
		/^You may cast (?:(.+?) )?spells( from your hand)? without paying their mana costs$/i
	);
	if (freeFromHand) {
		let filter: ObjectFilter = {};
		if (freeFromHand[1]) {
			const f = parseObjectPhraseWithQualifiers(
				`${freeFromHand[1].replace(/\s+and\s+/gi, ' or ')} card`,
				true
			);
			if (!f) return null;
			filter = f;
		}
		const allowedZones: ZoneType[] = freeFromHand[2]
			? ['hand']
			: ['hand', 'graveyard', 'exile', 'library', 'command'];
		return [
			{
				kind: 'static',
				static: {
					k: 'altCastPermission',
					manaCost: '{0}',
					affects: { filter },
					allowedZones
				}
			}
		];
	}
	const onceLifeCast = s.match(
		/^Once (?:during )?each (of your )?turns?, you may cast (?:a|an) (?:(.+?) )?spell from (your hand|your graveyard|exile|the top of your library) by paying life equal to its mana value rather than paying its mana cost$/i
	);
	if (onceLifeCast) {
		const duringYourTurnOnly = Boolean(onceLifeCast[1]);
		let filter: ObjectFilter = {};
		if (onceLifeCast[2]) {
			const f = parseObjectPhraseWithQualifiers(
				`${onceLifeCast[2].replace(/\s+and\s+/gi, ' or ')} card`,
				true
			);
			if (!f) return null;
			filter = f;
		}
		const rawWhere = onceLifeCast[3].toLowerCase();
		const zone: ZoneType =
			rawWhere === 'your hand'
				? 'hand'
				: rawWhere === 'your graveyard'
					? 'graveyard'
					: rawWhere === 'exile'
						? 'exile'
						: 'library';
		return [
			{
				kind: 'static',
				static: {
					k: 'altCastPermission',
					manaCost: '{0}',
					payLifeEqualToManaValue: true,
					affects: { filter },
					allowedZones: [zone],
					...(duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
					slotMode: 'oncePerTurn'
				}
			}
		];
	}
	const energyAltCast = s.match(
		/^You may pay (\S+) \{E\} rather than pay the mana cost for (?:(.+?) )?spells(?: that)? you cast$/i
	);
	if (energyAltCast) {
		const eAmt = count(energyAltCast[1]);
		if (eAmt && eAmt.k === 'const' && eAmt.n >= 1) {
			let filter: ObjectFilter = {};
			if (energyAltCast[2]) {
				const f = parseObjectPhraseWithQualifiers(
					`${energyAltCast[2].replace(/\s+and\s+/gi, ' or ')} card`,
					true
				);
				if (!f) return null;
				filter = f;
			}
			return [
				{
					kind: 'static',
					static: {
						k: 'altCastPermission',
						manaCost: '{0}',
						costDefs: [{ k: 'payEnergy', count: eAmt }],
						affects: { filter },
						allowedZones: ['hand', 'graveyard', 'exile', 'library', 'command']
					}
				}
			];
		}
	}
	const onceFreeCast = s.match(
		/^Once (?:during )?each (of your )?turns?, you may cast (?:a|an) (?:(.+?) )?spell from (your hand or the top of your library|your hand|your graveyard|exile|the top of your library) without paying its mana cost$/i
	);
	if (onceFreeCast) {
		const duringYourTurnOnly = Boolean(onceFreeCast[1]);
		let filter: ObjectFilter = {};
		if (onceFreeCast[2]) {
			const f = parseObjectPhrase(`${onceFreeCast[2].replace(/\s+and\s+/gi, ' or ')} card`, {
				allowPluralAndDisjunction: true
			});
			if (!f) return null;
			filter = f;
		}
		const rawWhere = onceFreeCast[3].toLowerCase();
		const allowedZones: ZoneType[] =
			rawWhere === 'your hand or the top of your library'
				? ['hand', 'library']
				: rawWhere === 'your hand'
					? ['hand']
					: rawWhere === 'your graveyard'
						? ['graveyard']
						: rawWhere === 'exile'
							? ['exile']
							: ['library'];
		const out: StaticItem[] = [];
		if (allowedZones.includes('library')) {
			out.push({
				kind: 'static',
				static: {
					k: 'zonePlayPermission',
					zone: 'library',
					allowSpells: true,
					...(Object.keys(filter).length > 0 ? { spellFilter: filter } : {}),
					...(duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
					slotMode: 'oncePerTurn'
				}
			});
		}
		out.push({
			kind: 'static',
			static: {
				k: 'altCastPermission',
				manaCost: '{0}',
				affects: { filter },
				allowedZones,
				...(duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
				slotMode: 'oncePerTurn'
			}
		});
		return out;
	}
	const isAltCastPayableDef = (d: CostDef): boolean => {
		switch (d.k) {
			case 'mana':
				return !/\{X\}/i.test(d.cost);
			case 'payLife':
			case 'payEnergy':
			case 'mill':
			case 'discardHand':
			case 'tapSubsetSum':
				return true;
			case 'sacrifice':
			case 'discard':
			case 'returnToHand':
			case 'revealFromHand':
			case 'tapOthers':
				return d.filter !== 'self';
			case 'removeCounters':
				return d.from !== 'self';
			case 'exileFrom':
				return (
					d.filter !== 'self' &&
					(d.zone === 'hand' || d.zone === 'graveyard' || d.zone === 'battlefield')
				);
			default:
				return false;
		}
	};
	const extractAltCastParts = (
		rawCostText: string
	): { manaCost: string; costDefs?: CostDef[] } | null => {
		const normalized = rawCostText
			.trim()
			.replace(/\s+and\s+sacrificing\s+/gi, ', sacrifice ')
			.replace(/\s+and\s+discarding\s+/gi, ', discard ')
			.replace(/\s+and\s+exiling\s+/gi, ', exile ')
			.replace(/\s+and\s+paying\s+/gi, ', pay ');
		const parsed =
			parseCost(rawCostText.trim(), 0).unparsed.length === 0 &&
			parseCost(rawCostText.trim(), 0).defs.length > 0
				? parseCost(rawCostText.trim(), 0)
				: parseCost(normalized, 0);
		if (parsed.unparsed.length > 0 || parsed.defs.length === 0) return null;
		if (!parsed.defs.every(isAltCastPayableDef)) return null;
		let manaCost = '';
		const nonMana: CostDef[] = [];
		for (const d of parsed.defs) {
			if (d.k === 'mana') manaCost += d.cost;
			else nonMana.push(d);
		}
		return {
			manaCost: manaCost || '{0}',
			...(nonMana.length > 0 ? { costDefs: nonMana } : {})
		};
	};
	const selfGyAddCost = s.match(
		/^You may cast ~ from (your graveyard|exile) by (.+?) in addition to paying its other costs$/i
	);
	if (selfGyAddCost) {
		const zone: 'graveyard' | 'exile' =
			selfGyAddCost[1].toLowerCase() === 'exile' ? 'exile' : 'graveyard';
		const normalizedCost = selfGyAddCost[2]
			.trim()
			.replace(/^paying\s+(\{)/i, '$1')
			.replace(/^paying\s+/i, 'pay ')
			.replace(/^exiling\s+/i, 'exile ')
			.replace(/^discarding\s+/i, 'discard ')
			.replace(/^sacrificing\s+/i, 'sacrifice ')
			.replace(/^removing\s+/i, 'remove ');
		const parsed = parseCost(normalizedCost, 0);
		if (
			parsed.unparsed.length === 0 &&
			parsed.defs.length > 0 &&
			parsed.defs.every(isAltCastPayableDef)
		) {
			return [
				{
					kind: 'static',
					static: { k: 'zonePlayPermission', zone, allowSpells: true, affects: 'self' }
				},
				{
					kind: 'static',
					static: {
						k: 'altCastPermission',
						affects: 'self',
						manaCost: '__PRINTED__',
						costDefs: parsed.defs,
						allowedZones: [zone]
					}
				}
			];
		}
	}
	const selfGyByPaying = s.match(
		/^You may cast ~ from (your graveyard|exile|your hand) by paying (.+?) rather than paying its mana cost$/i
	);
	if (selfGyByPaying) {
		const rawZone = selfGyByPaying[1].toLowerCase();
		const zone: 'graveyard' | 'exile' | 'hand' =
			rawZone === 'exile' ? 'exile' : rawZone === 'your hand' ? 'hand' : 'graveyard';
		const parts = extractAltCastParts(selfGyByPaying[2]);
		if (parts) {
			const out: StaticItem[] = [];
			if (zone !== 'hand') {
				out.push({
					kind: 'static',
					static: { k: 'zonePlayPermission', zone, allowSpells: true, affects: 'self' }
				});
			}
			out.push({
				kind: 'static',
				static: {
					k: 'altCastPermission',
					affects: 'self',
					manaCost: parts.manaCost,
					...(parts.costDefs ? { costDefs: parts.costDefs } : {}),
					allowedZones: [zone]
				}
			});
			return out;
		}
	}
	const pitchAlt =
		s.match(/^You may (.+?) rather than pay (?:~'s|this spell's) mana cost$/i) ??
		s.match(/^Rather than pay (?:~'s|this spell's) mana cost, you may (.+)$/i);
	if (pitchAlt) {
		const normalizedCost = pitchAlt[1]
			.trim()
			.replace(/\bexile\s+([^,]+?)\s+cards?\s+from your hand\b/gi, 'exile $1 card from your hand');
		const parts = extractAltCastParts( pitchAlt[1] ) ?? extractAltCastParts(normalizedCost);
		if (parts) {
			return [
				{
					kind: 'static',
					static: {
						k: 'altCastPermission',
						affects: 'self',
						manaCost: parts.manaCost,
						...(parts.costDefs ? { costDefs: parts.costDefs } : {}),
						allowedZones: ['hand']
					}
				}
			];
		}
	}
	const SUPPORTED_SPELL_GRANT_KWS = new Set([
		'convoke',
		'improvise',
		'delve',
		'assist',
		'rebound',
		'cascade',
		'storm',
		'gravestorm',
		'lifelink',
		'deathtouch',
		'wither',
		'infect'
	]);
	const parseSpellKwList = (raw: string): string[] | 'flash' | null => {
		const lowRaw = raw.trim().toLowerCase();
		if (lowRaw === 'flash') return 'flash';
		if (lowRaw === 'cascade, cascade') return ['cascade', 'cascade'];
		const toks = lowRaw.split(/,\s*and\s+|\s+and\s+|,\s*/).map((x) => x.trim()).filter(Boolean);
		if (toks.length === 0) return null;
		if (toks.every((tk) => SUPPORTED_SPELL_GRANT_KWS.has(tk))) return toks;
		return null;
	};
	const nthSpellKw = s.match(
		/^The (first|second) (?:(.+?) )?spell you cast (each turn|during each of your turns) has (.+)$/i
	);
	if (nthSpellKw) {
		const ordinal: 1 | 2 = nthSpellKw[1].toLowerCase() === 'first' ? 1 : 2;
		let filter: ObjectFilter | undefined;
		if (nthSpellKw[2]) {
			const f = parseObjectPhrase(`${nthSpellKw[2].replace(/\s+and\s+/gi, ' or ')} card`, {
				allowPluralAndDisjunction: true
			});
			if (!f) return null;
			filter = f;
		}
		const kws = parseSpellKwList(nthSpellKw[4]);
		if (kws && kws !== 'flash') {
			const nthCond: Condition = {
				k: 'nthMatchingSpellThisTurn',
				ordinal,
				...(filter ? { filter } : {})
			};
			const cond: Condition =
				nthSpellKw[3].toLowerCase() === 'during each of your turns'
					? { k: 'and', of: [{ k: 'isTurnOf', player: { k: 'you' } }, nthCond] }
					: nthCond;
			return [
				{
					kind: 'static',
					static: {
						k: 'spellGrantKeyword',
						filter: filter ?? {},
						keywords: kws,
						condition: cond
					}
				}
			];
		}
	}
	const spellsHaveKw = s.match(
		/^(?:Each )?(?:(.+?) )?spells? you (?:cast|control)( from your hand| from your graveyard| from exile)? (?:have|has) (.+)$/i
	);
	if (spellsHaveKw) {
		let filter: ObjectFilter = {};
		if (spellsHaveKw[1]) {
			const f = parseObjectPhrase(`${spellsHaveKw[1].replace(/\s+and\s+/gi, ' or ')} card`, {
				allowPluralAndDisjunction: true
			});
			if (!f) return null;
			filter = f;
		}
		if (spellsHaveKw[2]) {
			const fromLow = spellsHaveKw[2].trim().toLowerCase();
			const castFromZone: 'hand' | 'graveyard' | 'exile' =
				fromLow === 'from your graveyard'
					? 'graveyard'
					: fromLow === 'from exile'
						? 'exile'
						: 'hand';
			filter = { ...filter, castFromZone };
		}
		const kws = parseSpellKwList(spellsHaveKw[3]);
		if (kws === 'flash' && !spellsHaveKw[2]) {
			return [rule('castAsThoughFlash', 'you', { spells: filter })];
		}
		if (kws && kws !== 'flash') {
			return [
				{
					kind: 'static',
					static: { k: 'spellGrantKeyword', filter, keywords: kws }
				}
			];
		}
	}
	// --- End Track P17a ---
	if (/^You may play lands from your graveyard$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'zonePlayPermission', zone: 'graveyard', allowLands: true } }];
	}
	if (/^You may play lands from the top of your library$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'zonePlayPermission', zone: 'library', allowLands: true } }];
	}
	if (/^You may cast spells from the top of your library$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'zonePlayPermission', zone: 'library', allowSpells: true } }];
	}
	if (
		/^You may play lands and cast spells from the top of your library$/i.test(s) ||
		/^You may play (?:cards from the top|the top card) of your library$/i.test(s)
	) {
		return [
			{
				kind: 'static',
				static: { k: 'zonePlayPermission', zone: 'library', allowLands: true, allowSpells: true }
			}
		];
	}
	const playLandsAndFilteredSpells = s.match(
		/^You may play lands and cast (.+?) from the top of your library$/i
	);
	if (playLandsAndFilteredSpells) {
		const spellFilter = parseSpellFilterForTopLibrary(playLandsAndFilteredSpells[1]);
		if (spellFilter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'library',
						allowLands: true,
						allowSpells: true,
						spellFilter
					}
				}
			];
		}
	}
	const castTwoSpellGroups = s.match(
		/^You may cast (.+? spells) and (.+? spells) from the top of your library$/i
	);
	if (castTwoSpellGroups) {
		const f1 = parseSpellFilterForTopLibrary(castTwoSpellGroups[1]);
		const f2 = parseSpellFilterForTopLibrary(castTwoSpellGroups[2]);
		if (f1 && f2) {
			return [
				{
					kind: 'static',
					static: { k: 'zonePlayPermission', zone: 'library', allowSpells: true, spellFilter: f1 }
				},
				{
					kind: 'static',
					static: { k: 'zonePlayPermission', zone: 'library', allowSpells: true, spellFilter: f2 }
				}
			];
		}
	}
	const castFilteredSpells = s.match(/^You may cast (.+?) from the top of your library$/i);
	if (castFilteredSpells) {
		const spellFilter = parseSpellFilterForTopLibrary(castFilteredSpells[1]);
		if (spellFilter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'library',
						allowSpells: true,
						spellFilter
					}
				}
			];
		}
	}
	return null;
};

function parseCompanionTokenPhrase(raw: string): TokenSpec | null {
	const t = raw.trim().replace(/\s+tokens?$/i, '').trim();
	const low = t.toLowerCase();
	if (low === 'food') {
		return {
			name: 'Food',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Artifact — Food',
			keywords: [],
			quotedAbilities: ['{2}, {T}, Sacrifice this artifact: You gain 3 life.']
		};
	}
	if (low === 'treasure') {
		return {
			name: 'Treasure',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Artifact — Treasure',
			keywords: [],
			quotedAbilities: ['{T}, Sacrifice this artifact: Add one mana of any color.']
		};
	}
	if (low === 'clue') {
		return {
			name: 'Clue',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Artifact — Clue',
			keywords: [],
			quotedAbilities: ['{2}, Sacrifice this artifact: Draw a card.']
		};
	}
	if (low === 'blood') {
		return {
			name: 'Blood',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Artifact — Blood',
			keywords: [],
			quotedAbilities: ['{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.']
		};
	}
	if (low === 'map') {
		return {
			name: 'Map',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Artifact — Map',
			keywords: [],
			quotedAbilities: [
				'{1}, {T}, Sacrifice this artifact: Target creature you control explores. Activate only as a sorcery.'
			]
		};
	}
	const tappedPrefix = /^(tapped\s+)/i.exec(t);
	let body = tappedPrefix ? t.slice(tappedPrefix[0].length).trim() : t;
	let keywords: string[] = [];
	const withKw = body.match(/^(.+?)\s+with\s+(.+)$/i);
	if (withKw) {
		const parsedKws = parseKeywordList(withKw[2]);
		if (!parsedKws) return null;
		body = withKw[1].trim();
		keywords = parsedKws;
	}
	const desc = parseTypeDescription(body);
	if (!desc || !desc.basePT) return null;
	const typePart = desc.types.join(' ');
	const subPart = desc.subtypes.join(' ');
	const name = subPart || typePart || 'Token';
	return {
		name,
		power: desc.basePT[0],
		toughness: desc.basePT[1],
		colors: desc.colors ?? [],
		typeLine: subPart ? `${typePart} — ${subPart}` : typePart,
		keywords,
		...(tappedPrefix ? { tapped: true } : {})
	};
}

/** Counter, token and trigger doublers. */
const multipliers: Production = (s) => {
	const low = s.toLowerCase();
	const mult = (def: Extract<StaticDef, { k: 'multiplier' }>): StaticItem[] => [{ kind: 'static', static: def }];
	// --- Track P17a: Player/placer counter multipliers, filtered/companion token multipliers, & trigger suppressors/doublers ---
	if (
		/^if you would put one or more counters on a permanent or player, put (twice|three times) that many of each of those kinds of counters on that permanent or player instead$/i.test(
			s
		)
	) {
		const factor = /three times/i.test(s) ? 3 : 2;
		return mult({
			k: 'multiplier',
			what: 'counters',
			factor,
			appliesToPlayers: true,
			whoPlaces: 'you'
		});
	}
	if (
		/^if an opponent would put one or more counters on a permanent or player, they put half that many of each of those kinds of counters on that permanent or player instead, rounded (down|up)$/i.test(
			s
		)
	) {
		const round: 'down' | 'up' = /rounded up$/i.test(s) ? 'up' : 'down';
		return mult({
			k: 'multiplier',
			what: 'counters',
			factor: 0.5,
			round,
			appliesToPlayers: true,
			whoPlaces: 'opponents'
		});
	}
	const youGetCtrPlus = s.match(
		/^if you would get one or more counters, you get that many plus (\S+) of each of those kinds of counters instead$/i
	);
	if (youGetCtrPlus) {
		const delta = count(youGetCtrPlus[1]);
		if (delta && delta.k === 'const' && delta.n >= 1) {
			return mult({
				k: 'multiplier',
				what: 'counters',
				factor: 1,
				delta: delta.n,
				appliesToPlayers: true,
				filter: { controller: 'you', types: ['__player_only__'] }
			});
		}
	}
	const youPutCtrOnPerm = s.match(
		/^if you would put one or more (?:(.+?) )?counters on (?:a |an )?(.+?), put (?:(twice|three times) that many|that many plus (\S+)) (?:(.+?) |of each of those kinds of |of those )?counters on (?:it|that [a-z]+|them) instead$/i
	);
	if (youPutCtrOnPerm && !/\bor player\b/i.test(youPutCtrOnPerm[2])) {
		const rawC1 = youPutCtrOnPerm[1]?.trim();
		const rawC2 = youPutCtrOnPerm[5]?.trim();
		const c1 = rawC1 ? lookupStaticCounter(rawC1) : undefined;
		const c2 = rawC2 ? lookupStaticCounter(rawC2) : undefined;
		if ((!rawC1 || c1) && (!rawC2 || !c1 || c1 === c2)) {
			const rawTarget = youPutCtrOnPerm[2].trim();
			const filter: ObjectFilter | null = /^permanent (?:you control|your team controls)$/i.test(
				rawTarget
			)
				? { controller: 'you' }
				: /^permanent$/i.test(rawTarget)
					? {}
					: parseObjectPhraseWithQualifiers(rawTarget.replace(/\s+and\s+/gi, ' or '), true);
			if (filter) {
				if (youPutCtrOnPerm[3]) {
					const factor = youPutCtrOnPerm[3].toLowerCase() === 'three times' ? 3 : 2;
					return mult({
						k: 'multiplier',
						what: 'counters',
						factor,
						filter,
						whoPlaces: 'you',
						...(c1 ? { counter: c1 } : {})
					});
				}
				const delta = count(youPutCtrOnPerm[4]);
				if (delta && delta.k === 'const' && delta.n >= 1) {
					return mult({
						k: 'multiplier',
						what: 'counters',
						factor: 1,
						delta: delta.n,
						filter,
						whoPlaces: 'you',
						...(c1 ? { counter: c1 } : {})
					});
				}
			}
		}
	}
	// --- End Track P17a ---
	// --- Track P11: Generalized counter & token multipliers ---
	const ctrPlus = s.match(
		/^if one or more (.+?) counters would be put on (?:a |an )?(.+?), that many plus (\S+) (.+?) counters are put on (?:it|that [a-z]+) instead$/i
	);
	if (ctrPlus) {
		const c1 = lookupStaticCounter(ctrPlus[1]);
		const c2 = lookupStaticCounter(ctrPlus[4]);
		const filter = parseObjectPhraseWithQualifiers(ctrPlus[2].replace(/\s+and\s+/gi, ' or '), true);
		const delta = count(ctrPlus[3]);
		if (c1 && c1 === c2 && filter && delta && delta.k === 'const' && delta.n >= 1) {
			return mult({ k: 'multiplier', what: 'counters', factor: 1, delta: delta.n, filter, counter: c1 });
		}
	}
	const ctrMult = s.match(
		/^if (?:an effect would put )?one or more (.+?) counters (?:on|would be put on) (?:a |an )?(.+?), (?:it puts )?(twice|three times) that many (.+?) counters (?:on (?:it|that [a-z]+)|are put on (?:it|that [a-z]+)) instead$/i
	);
	if (ctrMult) {
		const c1 = lookupStaticCounter(ctrMult[1]);
		const c2 = lookupStaticCounter(ctrMult[4]);
		const filter = parseObjectPhraseWithQualifiers(ctrMult[2].replace(/\s+and\s+/gi, ' or '), true);
		const factor = ctrMult[3].toLowerCase() === 'three times' ? 3 : 2;
		if (c1 && c1 === c2 && filter) {
			return mult({ k: 'multiplier', what: 'counters', factor, filter, counter: c1 });
		}
	}
	const anyCtrPlus = s.match(
		/^if (?:an effect would put )?one or more counters (?:on|would be put on) (?:a |an )?(.+?), (?:it puts )?that many plus (\S+) (?:of each of those kinds of|of those) counters (?:on (?:it|that [a-z]+)|are put on (?:it|that [a-z]+)) instead$/i
	);
	if (anyCtrPlus) {
		const rawTarget = anyCtrPlus[1].trim();
		const filter = /^permanent (?:you control|your team controls)$/i.test(rawTarget)
			? { controller: 'you' as const }
			: parseObjectPhraseWithQualifiers(rawTarget.replace(/\s+and\s+/gi, ' or '), true);
		const delta = count(anyCtrPlus[2]);
		if (filter && delta && delta.k === 'const' && delta.n >= 1) {
			return mult({ k: 'multiplier', what: 'counters', factor: 1, delta: delta.n, filter });
		}
	}
	const anyCtrMult = s.match(
		/^if (?:an effect would put )?one or more counters (?:on|would be put on) (?:a |an )?(.+?), (?:it puts )?(twice|three times) that many (?:of each of those kinds of|of those) counters (?:on (?:it|that [a-z]+)|are put on (?:it|that [a-z]+)) instead$/i
	);
	if (anyCtrMult) {
		const rawTarget = anyCtrMult[1].trim();
		const filter = /^permanent (?:you control|your team controls)$/i.test(rawTarget)
			? { controller: 'you' as const }
			: /^permanent$/i.test(rawTarget)
				? {}
				: parseObjectPhraseWithQualifiers(rawTarget.replace(/\s+and\s+/gi, ' or '), true);
		const factor = anyCtrMult[2].toLowerCase() === 'three times' ? 3 : 2;
		if (filter) {
			return mult({ k: 'multiplier', what: 'counters', factor, filter });
		}
	}
	const tokUnderYou = low.match(
		/^if (?:an effect would create one or more tokens under your control, it creates|one or more tokens would be created under your control,) (twice|three times) that many of those tokens(?: are created)? instead$/
	);
	if (tokUnderYou) {
		const factor = tokUnderYou[1] === 'three times' ? 3 : 2;
		return mult({ k: 'multiplier', what: 'tokens', factor, filter: { controller: 'you' } });
	}
	const tokFilteredUnderYou = s.match(
		/^if (?:an effect would create one or more (.+?) tokens under your control, it creates|one or more (.+?) tokens would be created under your control,|you would create one or more (.+?) tokens, instead create) (twice|three times) that many of those tokens(?: are created)?(?: instead)?$/i
	);
	if (tokFilteredUnderYou) {
		const rawFilter = (tokFilteredUnderYou[1] ?? tokFilteredUnderYou[2] ?? tokFilteredUnderYou[3]).trim();
		const f = parseObjectPhrase(rawFilter.replace(/\s+and\s+/gi, ' or '), {
			allowPluralAndDisjunction: true
		});
		const factor = tokFilteredUnderYou[4].toLowerCase() === 'three times' ? 3 : 2;
		if (f) {
			return mult({
				k: 'multiplier',
				what: 'tokens',
				factor,
				filter: { ...f, controller: 'you' }
			});
		}
	}
	const tokGlobal = s.match(
		/^if (?:an effect would create one or more (?:(.+?) )?tokens, it creates|one or more (?:(.+?) )?tokens would be created,) (twice|three times) that many of those tokens(?: are created)? instead$/i
	);
	if (tokGlobal) {
		const rawFilter = (tokGlobal[1] ?? tokGlobal[2])?.trim();
		let filter: ObjectFilter = {};
		if (rawFilter) {
			const f = parseObjectPhrase(rawFilter.replace(/\s+and\s+/gi, ' or '), {
				allowPluralAndDisjunction: true
			});
			if (!f) return null;
			filter = f;
		}
		const factor = tokGlobal[3].toLowerCase() === 'three times' ? 3 : 2;
		return mult({ k: 'multiplier', what: 'tokens', factor, whoCreates: 'all', filter });
	}
	const tokPlusSame = s.match(
		/^if (?:you would create one or more (.+?) tokens, instead create|one or more (.+?) tokens would be created under your control,) those tokens plus an additional (.+?) token(?: are created instead)?$/i
	);
	if (tokPlusSame) {
		const rawA = (tokPlusSame[1] ?? tokPlusSame[2]).trim();
		const rawB = tokPlusSame[3].trim();
		if (rawA.toLowerCase() === rawB.toLowerCase()) {
			const f = parseObjectPhrase(rawA, { allowPluralAndDisjunction: true });
			if (f) {
				return mult({
					k: 'multiplier',
					what: 'tokens',
					factor: 1,
					delta: 1,
					filter: { ...f, controller: 'you' }
				});
			}
		}
	}
	const tokCompanion = s.match(
		/^if (?:one or more (?:(.+?) )?tokens would be created under your control,|you would create one or more (?:(.+?) )?tokens, instead create) those tokens plus (that many|(?:a|an)(?:\s+additional)?) (.+?) tokens?(?: are created instead)?$/i
	);
	if (tokCompanion) {
		const rawFilter = (tokCompanion[1] ?? tokCompanion[2])?.trim();
		let filter: ObjectFilter = { controller: 'you' };
		if (rawFilter) {
			const f = parseObjectPhraseWithQualifiers(rawFilter.replace(/\s+and\s+/gi, ' or '), true);
			if (!f) return null;
			filter = { ...f, controller: 'you' };
		}
		const extraTokenCount: 'one' | 'matching' =
			tokCompanion[3].toLowerCase() === 'that many' ? 'matching' : 'one';
		const extraToken = parseCompanionTokenPhrase(tokCompanion[4]);
		if (extraToken) {
			return mult({
				k: 'multiplier',
				what: 'tokens',
				factor: 1,
				filter,
				extraToken,
				extraTokenCount
			});
		}
	}
	// --- End Track P11 ---
	if (low === 'if you casting or copying an instant or sorcery spell causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time') {
		return mult({
			k: 'multiplier',
			what: 'triggers',
			factor: 2,
			filter: { controller: 'you' },
			cause: { event: 'cast', filter: { object: { types: ['Instant', 'Sorcery'] }, player: { relation: 'you' }, orCopy: true } }
		});
	}
	// --- Track P17a: Generalized trigger doublers & ETB/dies trigger suppressors (CR 603.2d, 603.2g) ---
	const parseTriggerSourcePermFilter = (raw: string): ObjectFilter | 'attachedTo' | null => {
		const r = raw.trim();
		if (/^(?:enchanted|equipped) (?:creature|permanent)$/i.test(r)) return 'attachedTo';
		if (/^a permanent you control$/i.test(r)) return { controller: 'you' };
		if (/^permanents you control$/i.test(r)) return { controller: 'you' };
		if (/^permanents your opponents control$/i.test(r)) return { controller: 'opponent' };
		const shamanWizard = r.match(/^a ([A-Z][a-z]+) or another ([A-Z][a-z]+) you control$/);
		if (shamanWizard) {
			return {
				controller: 'you',
				anyOf: [
					{ subtypes: [shamanWizard[1]] },
					{ other: true, subtypes: [shamanWizard[2]] }
				]
			};
		}
		const stripped = r.replace(/^(?:a|an)\s+/i, '');
		const af = parseAffected(stripped);
		return af && typeof af === 'object' ? af : parseObjectPhraseWithQualifiers(stripped, true);
	};
	const unconditionalTrigDouble = s.match(
		/^if (?:a triggered|an) ability of (.+?) triggers(?: while (.+?))?, (?:that ability|it) triggers an additional time$/i
	);
	if (unconditionalTrigDouble) {
		const pf = parseTriggerSourcePermFilter(unconditionalTrigDouble[1]);
		const cond = unconditionalTrigDouble[2]
			? parseStaticCondition(unconditionalTrigDouble[2])
			: undefined;
		if (!unconditionalTrigDouble[2] || cond) {
			if (pf === 'attachedTo') {
				return mult({
					k: 'multiplier',
					what: 'triggers',
					factor: 2,
					triggerSourceAttachedTo: true,
					...(cond ? { condition: cond } : {})
				});
			}
			if (pf) {
				return mult({
					k: 'multiplier',
					what: 'triggers',
					factor: 2,
					filter: pf,
					...(cond ? { condition: cond } : {})
				});
			}
		}
	}
	const drawCardCause = s.match(
		/^if (a player|you|an opponent) drawing a card causes a triggered ability of (.+?) to trigger, (?:that ability|it) triggers an additional time$/i
	);
	if (drawCardCause) {
		const whoDraw = drawCardCause[1].toLowerCase();
		const rel: 'any' | 'you' | 'opponent' =
			whoDraw === 'you' ? 'you' : whoDraw === 'an opponent' ? 'opponent' : 'any';
		const pf = parseTriggerSourcePermFilter(drawCardCause[2]);
		if (pf && pf !== 'attachedTo') {
			return mult({
				k: 'multiplier',
				what: 'triggers',
				factor: 2,
				filter: pf,
				cause: { event: 'drawCard', filter: { player: { relation: rel } } }
			});
		}
	}
	const combatDmgCause = s.match(
		/^if (?:a|an) (.+?) dealing combat damage to a player causes a triggered ability of (.+?) to trigger, (?:that ability|it) triggers an additional time$/i
	);
	if (combatDmgCause) {
		const dealer = parseObjectPhraseWithQualifiers(combatDmgCause[1], true);
		const pf = parseTriggerSourcePermFilter(combatDmgCause[2]);
		if (dealer && pf && pf !== 'attachedTo') {
			return mult({
				k: 'multiplier',
				what: 'triggers',
				factor: 2,
				filter: pf,
				cause: {
					event: 'dealsDamage',
					filter: { object: dealer, combat: true, damageTo: 'player' }
				}
			});
		}
	}
	const enterOrLeaveCause = s.match(
		/^if (?:a|an) (.+?) (entering or leaving the battlefield|entering or dying) causes a triggered ability of (.+?) to trigger, (?:that ability|it) triggers an additional time$/i
	);
	if (enterOrLeaveCause) {
		const rawObj = enterOrLeaveCause[1].replace(/\s+or\s+(?:a|an)\s+/gi, ' or ');
		let objFilter: ObjectFilter | null = parseObjectPhraseWithQualifiers(rawObj, true);
		if (!objFilter && /^legendary permanent or artifact$/i.test(rawObj)) {
			objFilter = { anyOf: [{ supertypes: ['Legendary'] }, { types: ['Artifact'] }] };
		}
		const pf = parseTriggerSourcePermFilter(enterOrLeaveCause[3]);
		if (objFilter && pf && pf !== 'attachedTo') {
			const isDying = /dying$/i.test(enterOrLeaveCause[2]);
			return mult({
				k: 'multiplier',
				what: 'triggers',
				factor: 2,
				filter: pf,
				causeOr: [
					{ event: 'zoneChange', filter: { object: objFilter, to: 'battlefield' } },
					isDying
						? {
								event: 'zoneChange',
								filter: { object: objFilter, from: 'battlefield', to: 'graveyard' }
							}
						: { event: 'zoneChange', filter: { object: objFilter, from: 'battlefield' } }
				]
			});
		}
	}
	const suppressTrig = s.match(
		/^(.+?) (entering(?: the battlefield)?|entering or dying) don't cause abilities(?: of (.+?))? to trigger$/i
	);
	if (suppressTrig) {
		const rawSubj = suppressTrig[1].trim();
		const subjFilter: ObjectFilter | null = /^permanents$/i.test(rawSubj)
			? {}
			: parseObjectPhraseWithQualifiers(rawSubj.replace(/\s+and\s+/gi, ' or '), true);
		const targetFilter = suppressTrig[3] ? parseTriggerSourcePermFilter(suppressTrig[3]) : {};
		if (subjFilter && targetFilter && targetFilter !== 'attachedTo') {
			const isBoth = /or dying$/i.test(suppressTrig[2]);
			if (isBoth) {
				return mult({
					k: 'multiplier',
					what: 'triggers',
					factor: 0,
					...(Object.keys(targetFilter).length > 0 ? { filter: targetFilter } : {}),
					causeOr: [
						{ event: 'zoneChange', filter: { object: subjFilter, to: 'battlefield' } },
						{
							event: 'zoneChange',
							filter: { object: subjFilter, from: 'battlefield', to: 'graveyard' }
						}
					]
				});
			}
			return mult({
				k: 'multiplier',
				what: 'triggers',
				factor: 0,
				...(Object.keys(targetFilter).length > 0 ? { filter: targetFilter } : {}),
				cause: {
					event: 'zoneChange',
					filter: {
						...(Object.keys(subjFilter).length > 0 ? { object: subjFilter } : {}),
						to: 'battlefield'
					}
				}
			});
		}
	}
	// --- End Track P17a ---
	const cause = s.match(
		/^if (?:an? )?(.+?) (entering(?: the battlefield)?|dying|attacking) causes a triggered ability of (.+?) to trigger, (?:that ability|it) triggers an additional time$/i
	);
	if (cause) {
		const object = /^permanent$/i.test(cause[1].trim())
			? {}
			: parseObjectPhraseWithQualifiers(cause[1].replace(/\s+or\s+(?:a|an)\s+/gi, ' or '), true);
		const pf = parseTriggerSourcePermFilter(cause[3]);
		if (object && pf && pf !== 'attachedTo') {
			const verbLow = cause[2].toLowerCase();
			const filter: EventPattern['filter'] =
				verbLow === 'dying'
					? { ...(Object.keys(object).length > 0 ? { object } : {}), from: 'battlefield', to: 'graveyard' }
					: verbLow === 'attacking'
						? { ...(Object.keys(object).length > 0 ? { object } : {}) }
						: { ...(Object.keys(object).length > 0 ? { object } : {}), to: 'battlefield' };
			const event: EventPattern['event'] = verbLow === 'attacking' ? 'attacks' : 'zoneChange';
			return mult({ k: 'multiplier', what: 'triggers', factor: 2, filter: pf, cause: { event, filter } });
		}
	}
	return null;
};

/** Player-level rules: hand size, can't lose, hexproof, attack tax, flash, casting restrictions. */
function isDraftOnlySentence(s: string): boolean {
	return (
		/^Draft ~ face up$/i.test(s) ||
		/^Reveal ~ as you draft it\b/i.test(s) ||
		/^As you draft a (?:[a-z]+ )?card,\s/i.test(s) ||
		/^During the draft,\s/i.test(s) ||
		/^Immediately after the draft,\s/i.test(s) ||
		/^Instead of drafting a card from a booster pack,\s/i.test(s) ||
		/^As long as ~ is face up during the draft,\s/i.test(s) ||
		/^If you removed a creature card with .+ from the draft with cards named ~,/i.test(s)
	);
}

function parseTargetLockSourceFilter(raw: string): ObjectFilter | null {
	const trimmed = raw.trim();
	const twoCol = trimmed.match(/^(white|blue|black|red|green) or (white|blue|black|red|green)$/i);
	if (twoCol) {
		return {
			colors: [COLORS[twoCol[1].toLowerCase()], COLORS[twoCol[2].toLowerCase()]]
		};
	}
	const f = parseObjectPhrase(`${trimmed.replace(/\s+and\s+/gi, ' or ')} card`, {
		allowPluralAndDisjunction: true
	});
	if (!f || f.controller) return null;
	return f;
}

function parseCantBeTargetedByRhs(affected: Affected, rhsRaw: string): StaticItem | null {
	const rhs = rhsRaw.trim();
	if (/\bas long as\b|\bduring (?:your|turns)\b/i.test(rhs)) return null;
	const spellsOrAbs = rhs.match(/^spells or abilities( your opponents control)?$/i);
	if (spellsOrAbs) {
		return {
			kind: 'static',
			static: {
				k: 'cantBeTargetedBy',
				affected,
				...(spellsOrAbs[1] ? { opponentControllerOnly: true } : {})
			}
		};
	}
	const spellsPlain = rhs.match(/^spells( your opponents control)?$/i);
	if (spellsPlain) {
		return {
			kind: 'static',
			static: {
				k: 'cantBeTargetedBy',
				affected,
				spellsOnly: true,
				...(spellsPlain[1] ? { opponentControllerOnly: true } : {})
			}
		};
	}
	const absPlain = rhs.match(/^abilities( your opponents control)?$/i);
	if (absPlain) {
		return {
			kind: 'static',
			static: {
				k: 'cantBeTargetedBy',
				affected,
				abilitiesOnly: true,
				...(absPlain[1] ? { opponentControllerOnly: true } : {})
			}
		};
	}
	const qualBothOpp = rhs.match(
		/^(.+?) spells your opponents control or abilities from (.+?) sources your opponents control$/i
	);
	if (qualBothOpp && qualBothOpp[1].trim().toLowerCase() === qualBothOpp[2].trim().toLowerCase()) {
		const sf = parseTargetLockSourceFilter(qualBothOpp[1]);
		if (sf) {
			return {
				kind: 'static',
				static: {
					k: 'cantBeTargetedBy',
					affected,
					sourceFilter: sf,
					opponentControllerOnly: true
				}
			};
		}
	}
	const qualBoth = rhs.match(/^(.+?) spells or abilities from (.+?) sources$/i);
	if (qualBoth && qualBoth[1].trim().toLowerCase() === qualBoth[2].trim().toLowerCase()) {
		const sf = parseTargetLockSourceFilter(qualBoth[1]);
		if (sf) {
			return {
				kind: 'static',
				static: {
					k: 'cantBeTargetedBy',
					affected,
					sourceFilter: sf
				}
			};
		}
	}
	const qualAbs = rhs.match(/^abilities from (.+?) sources( your opponents control)?$/i);
	if (qualAbs) {
		const sf = parseTargetLockSourceFilter(qualAbs[1]);
		if (sf) {
			return {
				kind: 'static',
				static: {
					k: 'cantBeTargetedBy',
					affected,
					sourceFilter: sf,
					abilitiesOnly: true,
					...(qualAbs[2] ? { opponentControllerOnly: true } : {})
				}
			};
		}
	}
	const qualSpells = rhs.match(/^(.+?) spells( your opponents control)?$/i);
	if (qualSpells) {
		const sf = parseTargetLockSourceFilter(qualSpells[1]);
		if (sf) {
			return {
				kind: 'static',
				static: {
					k: 'cantBeTargetedBy',
					affected,
					sourceFilter: sf,
					spellsOnly: true,
					...(qualSpells[2] ? { opponentControllerOnly: true } : {})
				}
			};
		}
	}
	return null;
}

const ruleModifiers: Production = (s) => {
	const low = s.toLowerCase();
	if (isDraftOnlySentence(s)) return [{ kind: 'static', static: { k: 'draftNoOp' } }];
	if (low === "you don't lose the game for having 0 or less life") {
		return [rule('dontLoseAtZeroOrLessLife', 'you')];
	}
	if (low === "you have no maximum hand size and don't lose the game for having 0 or less life") {
		return [rule('noMaxHandSize', 'you'), rule('dontLoseAtZeroOrLessLife', 'you')];
	}
	if (low === 'all damage is dealt as though its source had wither') {
		return [rule('allDamageHasWither', 'each_player')];
	}
	if (/^(?:all )?damage is dealt to you as though its source had infect$/i.test(s)) {
		return [rule('damageToYouAsInfect', 'you')];
	}
	if (/^cards in graveyards can't be the targets? of spells or abilities$/i.test(s)) {
		return [rule('graveyardCantBeTargeted', 'each_player')];
	}
	if (low === 'you have no maximum hand size') return [rule('noMaxHandSize', 'you')];
	// --- Track P11: Life gain lock, draw step skip, max hand size, & chosen-name cast bans ---
	if (low === 'players have no maximum hand size' || low === 'each player has no maximum hand size') {
		return [rule('noMaxHandSize', 'each_player')];
	}
	if (low === "players can't gain life") return [rule('cantGainLife', 'each_player')];
	if (low === "your opponents can't gain life") return [rule('cantGainLife', 'each_opponent')];
	if (low === "you can't gain life") return [rule('cantGainLife', 'you')];
	if (low === 'skip your draw step') return [rule('skipDrawStep', 'you')];
	if (low === "spells with the chosen name can't be cast") {
		return [rule('cantCastChosenName', 'each_player')];
	}
	if (low === "your opponents can't cast spells with the chosen name") {
		return [rule('cantCastChosenName', 'each_opponent')];
	}
	const setHand = low.match(/^(your|each opponent's|each player's) maximum hand size is (\S+)$/);
	if (setHand) {
		const rel =
			setHand[1] === 'your' ? 'you' : setHand[1] === "each opponent's" ? 'each_opponent' : 'each_player';
		if (setHand[2] === 'zero' || setHand[2] === '0') {
			return [rule('setMaxHandSize', rel, { size: 0 })];
		}
		const sz = count(setHand[2]);
		if (sz && sz.k === 'const') {
			return [rule('setMaxHandSize', rel, { size: sz.n })];
		}
	}
	const deltaHand = low.match(
		/^(your|each opponent's|each player's) maximum hand size is (reduced|increased) by (\S+)$/
	);
	if (deltaHand) {
		const rel =
			deltaHand[1] === 'your'
				? 'you'
				: deltaHand[1] === "each opponent's"
					? 'each_opponent'
					: 'each_player';
		const amt = count(deltaHand[3]);
		if (amt && amt.k === 'const' && amt.n >= 1) {
			const signed = deltaHand[2] === 'reduced' ? -amt.n : amt.n;
			return [rule('maxHandSizeDelta', rel, { delta: signed })];
		}
	}
	// --- End Track P11 ---
	if (low === "you can't lose the game and your opponents can't win the game") {
		return [rule('cantLose', 'you'), rule('opponentsCantWin', 'each_opponent')];
	}
	if (low === "you can't win the game and your opponents can't lose the game") {
		return [rule('opponentsCantWin', 'you'), rule('cantLose', 'each_opponent')];
	}
	if (low === "you can't lose the game") return [rule('cantLose', 'you')];
	if (low === "your opponents can't lose the game") return [rule('cantLose', 'each_opponent')];
	if (low === "you can't win the game") return [rule('opponentsCantWin', 'you')];
	if (low === "your opponents can't win the game") return [rule('opponentsCantWin', 'each_opponent')];
	if (low === "your life total can't change") return [rule('lifeTotalCantChange', 'you')];
	if (low === 'you have hexproof') return [rule('playerHexproof', 'you')];
	if (low === 'you have shroud') return [rule('playerShroud', 'you')];
	const youAndOne = low.match(/^you and (.+?) have (.+)$/);
	if (youAndOne) {
		const kws = parseKeywordList(youAndOne[2]);
		const a = parseAffected(youAndOne[1]);
		if (kws && a && kws.length === 1 && (kws[0] === 'hexproof' || kws[0] === 'shroud')) {
			return [
				rule(kws[0] === 'hexproof' ? 'playerHexproof' : 'playerShroud', 'you'),
				keywordGrant(a, kws)
			];
		}
	}
	const shalai = low.match(/^you, (.+?), and (.+?) have (.+)$/);
	if (shalai) {
		const kws = parseKeywordList(shalai[3]);
		const a = parseAffected(shalai[1]);
		const b = parseAffected(shalai[2]);
		if (kws && a && b && kws.length >= 1) {
			const out: StaticItem[] = [];
			if (kws.includes('hexproof')) out.push(rule('playerHexproof', 'you'));
			if (kws.includes('shroud')) out.push(rule('playerShroud', 'you'));
			out.push(keywordGrant(a, kws), keywordGrant(b, kws));
			return out;
		}
	}
	const tax = s.match(/^Creatures can't attack you unless their controller pays (\{\d+\}) for each creature they control that's attacking you$/);
	if (tax) return [rule('attackTax', 'you', { cost: tax[1] })];
	// --- Track P17a: Generalized attack/block taxes, self flash, mana retention, & global rule locks ---
	const parseTaxSymbolOrDynamic = (
		rawSym: string,
		whereTail?: string
	): { generic?: number; manaSymbol?: string; dynamicAmount?: Amount } | null => {
		const sym = rawSym.trim();
		if (/^\{\d+\}$/.test(sym)) {
			const generic = parseInt(sym.slice(1, -1), 10);
			if (!whereTail) return { generic };
			const forEachM = whereTail.match(/^for each (.+)$/i);
			if (!forEachM) return null;
			const dynamicAmount = parseCountAmount(`the number of ${forEachM[1]}`);
			return dynamicAmount ? { generic, dynamicAmount } : null;
		}
		if (/^\{X\}$/i.test(sym) && whereTail) {
			const whereM = whereTail.match(/^,?\s*where X is (.+)$/i);
			if (!whereM) return null;
			const dynamicAmount = parseCountAmount(whereM[1]);
			return dynamicAmount ? { dynamicAmount } : null;
		}
		if (/^\{(?:[WUBRGC]|[WUBRG]\/P)\}$/i.test(sym) && !whereTail) {
			return { manaSymbol: sym.toUpperCase() };
		}
		return null;
	};
	const genAtkTax = s.match(
		/^(.+?) can't attack (you or planeswalkers you control|you or a planeswalker you control|planeswalkers you control|a planeswalker you control|you) unless their controller pays (\{[^}]+\}) for each (?:creature they control that's attacking (?:you|them|a planeswalker you control|planeswalkers you control)|of those creatures)(.*)$/i
	);
	if (genAtkTax) {
		const rawSubj = genAtkTax[1].trim();
		const affected = /^creatures$/i.test(rawSubj) ? undefined : parseAffected(rawSubj);
		if (/^creatures$/i.test(rawSubj) || affected) {
			const defRaw = genAtkTax[2].toLowerCase();
			const defending: 'you' | 'planeswalkersYouControl' | 'youOrPlaneswalkersYouControl' =
				defRaw.startsWith('you or ')
					? 'youOrPlaneswalkersYouControl'
					: defRaw === 'you'
						? 'you'
						: 'planeswalkersYouControl';
			const taxSpec = parseTaxSymbolOrDynamic(genAtkTax[3], genAtkTax[4].trim() || undefined);
			if (taxSpec) {
				return [
					rule('attackTax', 'each_player', {
						...taxSpec,
						defending,
						...(affected ? { affected } : {})
					})
				];
			}
		}
	}
	const singleCombatTax = s.match(
		/^(.+?) can't (attack or block|attack|block) unless (?:its controller pays|their controller pays|you pay) (\{[^}]+\})(?: for each (?:attacking|blocking) creature(?: they control)?)?(.*)$/i
	);
	if (singleCombatTax) {
		const rawSubj = singleCombatTax[1].trim();
		const affected = /^creatures$/i.test(rawSubj) ? undefined : parseAffected(rawSubj);
		if (/^creatures$/i.test(rawSubj) || affected) {
			const taxSpec = parseTaxSymbolOrDynamic(
				singleCombatTax[3],
				singleCombatTax[4].trim() || undefined
			);
			if (taxSpec) {
				const mode = singleCombatTax[2].toLowerCase();
				const params: Record<string, unknown> = {
					...taxSpec,
					...(affected ? { affected } : { affected: { types: ['Creature'] } })
				};
				if (mode === 'attack or block') {
					return [
						rule('attackTax', 'each_player', params),
						rule('blockTax', 'each_player', params)
					];
				}
				return [rule(mode === 'attack' ? 'attackTax' : 'blockTax', 'each_player', params)];
			}
		}
	}
	if (
		/^You may cast (?:~|this spell) as though it had flash$/i.test(s) ||
		/^(?:~|This spell) has flash$/i.test(s)
	) {
		return [rule('castAsThoughFlash', 'you', { selfOnly: true })];
	}
	const selfFlashIf = s.match(/^You may cast (?:~|this spell) as though it had flash if (.+)$/i);
	if (selfFlashIf) {
		const cond = parseStaticCondition(selfFlashIf[1]);
		if (cond) {
			return [
				{
					kind: 'static',
					static: {
						k: 'ruleModifier',
						rule: 'castAsThoughFlash',
						who: { relation: 'you' },
						params: { selfOnly: true },
						condition: cond
					}
				}
			];
		}
	}
	const retainMana = s.match(
		/^(Players|You) don't lose unspent (?:(white|blue|black|red|green|colorless) )?mana as steps and phases end$/i
	);
	if (retainMana) {
		const players: 'you' | 'all' = retainMana[1].toLowerCase() === 'you' ? 'you' : 'all';
		const colWord = retainMana[2]?.toLowerCase();
		const colors: ManaColor[] | 'all' = !colWord
			? 'all'
			: colWord === 'colorless'
				? ['C']
				: [COLORS[colWord]];
		return [{ kind: 'static', static: { k: 'retainUnspentMana', players, colors } }];
	}
	const convertMana = s.match(
		/^If you would lose unspent mana, that mana becomes (colorless|white|blue|black|red|green) instead$/i
	);
	if (convertMana) {
		const cw = convertMana[1].toLowerCase();
		const convertTo: ManaColor = cw === 'colorless' ? 'C' : COLORS[cw];
		return [
			{ kind: 'static', static: { k: 'retainUnspentMana', players: 'you', colors: [], convertTo } }
		];
	}
	if (low === "players can't draw cards") return [rule('cantDrawCards', 'each_player')];
	if (low === "your opponents can't draw cards") return [rule('cantDrawCards', 'each_opponent')];
	if (low === "you can't draw cards") return [rule('cantDrawCards', 'you')];
	if (low === "each opponent can't draw more than one card each turn") {
		return [rule('cantDrawExtraCards', 'each_opponent')];
	}
	if (low === "each player can't draw more than one card each turn") {
		return [rule('cantDrawExtraCards', 'each_player')];
	}
	if (low === "you can't draw more than one card each turn") {
		return [rule('cantDrawExtraCards', 'you')];
	}
	if (low === "players can't search libraries") return [rule('cantSearchLibraries', 'each_player')];
	if (
		low === "your opponents can't search libraries" ||
		low ===
			"spells and abilities your opponents control can't cause their controller to search their library"
	) {
		return [rule('cantSearchLibraries', 'each_opponent')];
	}
	const topNSearch = s.match(
		/^If an opponent would search a library, that player searches the top (\S+) cards of that library instead$/i
	);
	if (topNSearch) {
		const topN = count(topNSearch[1]);
		if (topN && topN.k === 'const' && topN.n >= 1) {
			return [rule('cantSearchLibraries', 'each_opponent', { topN: topN.n })];
		}
	}
	const costPayLock = s.match(
		/^(Players|Your opponents) can't pay life(?: or sacrifice (.+?))? to cast spells or (?:to )?activate abilities( that aren't mana abilities)?$/i
	);
	if (costPayLock) {
		const whoRel = costPayLock[1].toLowerCase() === 'players' ? 'each_player' : 'each_opponent';
		let sacrificeFilter: ObjectFilter | 'any' | undefined;
		if (costPayLock[2]) {
			const rawSac = costPayLock[2].trim();
			if (/^permanents$/i.test(rawSac)) {
				sacrificeFilter = 'any';
			} else {
				const sf = parseObjectPhrase(rawSac, { allowPluralAndDisjunction: true });
				if (!sf) return null;
				sacrificeFilter = sf;
			}
		}
		return [
			rule('cantPayLifeOrSacrificeForCosts', whoRel, {
				cantPayLife: true,
				...(sacrificeFilter ? { sacrificeFilter } : {}),
				...(costPayLock[3] ? { nonManaAbilitiesOnly: true } : {})
			})
		];
	}
	const untapCap = s.match(
		/^(Players|Your opponents) can't untap more than (\S+) (.+?) during their untap steps$/i
	);
	if (untapCap) {
		const whoRel = untapCap[1].toLowerCase() === 'players' ? 'each_player' : 'each_opponent';
		const maxCnt = count(untapCap[2]);
		const rawTarget = untapCap[3].trim();
		if (maxCnt && maxCnt.k === 'const' && maxCnt.n >= 0) {
			if (/^permanents?$/i.test(rawTarget)) {
				return [rule('untapStepCap', whoRel, { max: maxCnt.n })];
			}
			const f = parseObjectPhrase(rawTarget, { allowPluralAndDisjunction: true });
			if (f) {
				return [rule('untapStepCap', whoRel, { max: maxCnt.n, filter: f })];
			}
		}
	}
	if (/^The "legend rule" doesn't apply$/i.test(s)) {
		return [rule('legendRuleExempt', 'each_player')];
	}
	if (/^The "legend rule" doesn't apply to permanents you control$/i.test(s)) {
		return [rule('legendRuleExempt', 'you')];
	}
	const legendExemptFilter = s.match(/^The "legend rule" doesn't apply to (.+?) you control$/i);
	if (legendExemptFilter) {
		const rawF = legendExemptFilter[1].trim();
		const filter: ObjectFilter | null = /^tokens$/i.test(rawF)
			? { token: true }
			: /^creature tokens$/i.test(rawF)
				? { token: true, types: ['Creature'] }
				: parseObjectPhrase(rawF, { allowPluralAndDisjunction: true });
		if (filter) {
			return [rule('legendRuleExempt', 'you', { filter })];
		}
	}
	if (
		/^While an opponent is choosing targets as part of casting a spell(?: they control)? or activating an ability(?: they control)?, that player must choose at least one Flagbearer on the battlefield if able$/i.test(
			s
		)
	) {
		return [rule('flagbearer', 'each_opponent')];
	}
	const spellCap = s.match(
		/^(Each player|Your opponents|Each opponent|You) can't cast more than (\S+)(?: (.+?))? spells? each turn$/i
	);
	if (spellCap) {
		const whoRaw = spellCap[1].toLowerCase();
		const whoRel =
			whoRaw === 'you' ? 'you' : whoRaw === 'each player' ? 'each_player' : 'each_opponent';
		const maxCnt = count(spellCap[2]);
		if (maxCnt && maxCnt.k === 'const' && maxCnt.n >= 1) {
			if (!spellCap[3]) {
				if (maxCnt.n === 1 && (whoRel === 'you' || whoRel === 'each_player')) {
					return [rule('oneSpellPerTurn', whoRel)];
				}
				return [rule('filteredSpellCapPerTurn', whoRel, { max: maxCnt.n })];
			}
			const f = parseObjectPhrase(`${spellCap[3].replace(/\s+and\s+/gi, ' or ')} card`, {
				allowPluralAndDisjunction: true
			});
			if (f) {
				return [rule('filteredSpellCapPerTurn', whoRel, { max: maxCnt.n, filter: f })];
			}
		}
	}
	const canonistCap = s.match(
		/^Each player who has cast (?:a|an) (.+?) spell this turn can't cast additional (.+?) spells$/i
	);
	if (canonistCap && canonistCap[1].toLowerCase() === canonistCap[2].toLowerCase()) {
		const f = parseObjectPhrase(`${canonistCap[1]} card`, { allowPluralAndDisjunction: true });
		if (f) {
			return [rule('filteredSpellCapPerTurn', 'each_player', { max: 1, filter: f })];
		}
	}
	if (/^Players can't cast spells from graveyards or libraries$/i.test(s)) {
		return [
			rule('cantCastMatchingSpells', 'each_player', { fromZones: ['graveyard', 'library'] })
		];
	}
	if (/^Players can't cast spells from graveyards$/i.test(s)) {
		return [rule('cantCastMatchingSpells', 'each_player', { fromZones: ['graveyard'] })];
	}
	if (low === "your opponents can't cast spells of the chosen color") {
		return [rule('cantCastMatchingSpells', 'each_opponent', { filter: { ofChosenColor: true } })];
	}
	const cantCastActive = s.match(
		/^(Players|Each player|Your opponents|Each opponent|You) can't cast (.+?) spells$/i
	);
	if (cantCastActive && !/\bduring\b|\bfrom\b|\bwith the chosen name\b/i.test(cantCastActive[2])) {
		const whoRaw = cantCastActive[1].toLowerCase();
		const whoRel =
			whoRaw === 'you'
				? 'you'
				: whoRaw === 'players' || whoRaw === 'each player'
					? 'each_player'
					: 'each_opponent';
		const f = parseObjectPhrase(`${cantCastActive[2].replace(/\s+and\s+/gi, ' or ')} card`, {
			allowPluralAndDisjunction: true
		});
		if (f) {
			return [rule('cantCastMatchingSpells', whoRel, { filter: f })];
		}
	}
	const cantCastPassive = s.match(/^(.+?) spells can't be cast$/i);
	if (cantCastPassive && !/\bchosen name\b/i.test(cantCastPassive[1])) {
		const f = parseObjectPhrase(`${cantCastPassive[1].replace(/\s+and\s+/gi, ' or ')} card`, {
			allowPluralAndDisjunction: true
		});
		if (f) {
			return [rule('cantCastMatchingSpells', 'each_player', { filter: f })];
		}
	}
	const cantCastQualActive = s.match(
		/^(Players|Each player|Your opponents|Each opponent|You) can't cast (.*\bspells?\b.+)$/i
	);
	if (
		cantCastQualActive &&
		!/\bduring\b|\bfrom\b|\bchosen name\b|\bchosen color\b|\bsame name\b|\bshare a color\b|\bunless\b|\bmore than\b|\bas long as\b/i.test(
			cantCastQualActive[2]
		)
	) {
		const whoRaw = cantCastQualActive[1].toLowerCase();
		const whoRel =
			whoRaw === 'you'
				? 'you'
				: whoRaw === 'players' || whoRaw === 'each player'
					? 'each_player'
					: 'each_opponent';
		const f =
			parseObjectPhraseWithQualifiers(
				cantCastQualActive[2].replace(/\bspells?\b/i, 'card'),
				true
			) ??
			parseObjectPhraseWithQualifiers(
				cantCastQualActive[2].replace(/\bspells\b/i, 'cards').replace(/\bspell\b/i, 'card'),
				true
			);
		if (f && !f.controller) {
			return [rule('cantCastMatchingSpells', whoRel, { filter: f })];
		}
	}
	const cantCastQualPassive = s.match(/^(.*\bspells?\b.+) can't be cast$/i);
	if (
		cantCastQualPassive &&
		!/\bduring\b|\bfrom\b|\bchosen name\b|\bchosen color\b|\bsame name\b|\bshare a color\b|\bunless\b|\bas long as\b/i.test(
			cantCastQualPassive[1]
		)
	) {
		const f =
			parseObjectPhraseWithQualifiers(
				cantCastQualPassive[1].replace(/\bspells?\b/i, 'card'),
				true
			) ??
			parseObjectPhraseWithQualifiers(
				cantCastQualPassive[1].replace(/\bspells\b/i, 'cards').replace(/\bspell\b/i, 'card'),
				true
			);
		if (f && !f.controller) {
			return [rule('cantCastMatchingSpells', 'each_player', { filter: f })];
		}
	}
	const actHaste = s.match(
		/^You may activate abilities of (.+?) as though (?:those [a-z]+|they|it) had haste$/i
	);
	if (actHaste && !/\bas long as\b|\bduring\b/i.test(actHaste[1])) {
		const aff = parseAffected(actHaste[1]);
		if (aff && typeof aff === 'object') {
			return [{ kind: 'static', static: { k: 'activateAsThoughHaste', filter: aff } }];
		}
	}
	const cantTargetStmt = s.match(/^(.+?) can't be the targets? of (.+)$/i);
	if (cantTargetStmt && !/\bgraveyards?\b/i.test(cantTargetStmt[1])) {
		const aff = parseAffected(cantTargetStmt[1]);
		if (aff) {
			const item = parseCantBeTargetedByRhs(aff, cantTargetStmt[2]);
			if (item) return [item];
		}
	}
	if (/^Cast (?:~|this spell) only if you(?:'ve| have) cast another spell this turn$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'selfCastRestriction',
					castCondition: { k: 'spellsCastThisTurnCount', min: 1 }
				}
			}
		];
	}
	const castOnlyIf = s.match(/^Cast (?:~|this spell) only if (.+)$/i);
	if (castOnlyIf) {
		const cond = parseStaticCondition(castOnlyIf[1]);
		if (cond) {
			return [{ kind: 'static', static: { k: 'selfCastRestriction', castCondition: cond } }];
		}
	}
	const cantCastSelfUnless = s.match(/^You can't cast (?:~|this spell) unless (.+)$/i);
	if (cantCastSelfUnless) {
		const cond = parseStaticCondition(cantCastSelfUnless[1]);
		if (cond) {
			return [{ kind: 'static', static: { k: 'selfCastRestriction', castCondition: cond } }];
		}
	}
	// --- End Track P17a ---
	if (low === 'you may cast spells as though they had flash') return [rule('castAsThoughFlash', 'you')];
	// --- Track P14: Case-preserved subtype flash grants, global flash, commander & deck designations ---
	if (/^(?:any|each) player may cast spells as though they had flash$/i.test(s)) {
		return [rule('castAsThoughFlash', 'each_player')];
	}
	const flashForTwo = s.match(
		/^(You|Any player|Each player) may cast (.+?) spells and (.+?) spells as though they had flash$/i
	);
	if (flashForTwo) {
		const whoRel = flashForTwo[1].toLowerCase() === 'you' ? 'you' : 'each_player';
		const f1 = parseObjectPhraseWithQualifiers(`${flashForTwo[2]} card`, true);
		const f2 = parseObjectPhraseWithQualifiers(`${flashForTwo[3]} card`, true);
		if (f1 && f2) {
			return [rule('castAsThoughFlash', whoRel, { spells: { anyOf: [f1, f2] } })];
		}
	}
	const flashFor = s.match(/^(You|Any player|Each player) may cast (.+?) spells as though they had flash$/i);
	if (flashFor) {
		const whoRel = flashFor[1].toLowerCase() === 'you' ? 'you' : 'each_player';
		const filter = parseObjectPhraseWithQualifiers(
			`${flashFor[2].replace(/\s+and\s+/gi, ' or ')} card`,
			true
		);
		if (filter) return [rule('castAsThoughFlash', whoRel, { spells: filter })];
	}
	const ownHaveFlash = s.match(/^(.+?) cards you own that aren't on the battlefield have flash$/i);
	if (ownHaveFlash) {
		const filter = parseObjectPhrase(`${ownHaveFlash[1].replace(/\s+and\s+/gi, ' or ')} card`, {
			allowPluralAndDisjunction: true
		});
		if (filter) {
			return [rule('castAsThoughFlash', 'you', { spells: { ...filter, owner: 'you' } })];
		}
	}
	if (/^~ can be your commander$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'commanderDesignation' } }];
	}
	if (/^A deck can have any number of cards named ~$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'deckCopyLimit', limit: 'any' } }];
	}
	const upToCards = s.match(/^A deck can have up to (\S+) cards named ~$/i);
	if (upToCards) {
		const lim = count(upToCards[1]);
		if (lim && lim.k === 'const' && lim.n >= 1) {
			return [{ kind: 'static', static: { k: 'deckCopyLimit', limit: lim.n } }];
		}
	}
	if (low === "your opponents can't cast spells during your turn") {
		return [rule('opponentsCantCastDuringYourTurn', 'each_opponent', { spellsOnly: true })];
	}
	if (low === "you can't cast more than one spell each turn") {
		return [rule('oneSpellPerTurn', 'you')];
	}
	if (low === "damage can't be prevented") {
		return [rule('damageCantBePrevented', 'each_player')];
	}
	// --- End Track P14 ---
	if (low === "each player can't cast more than one spell each turn") return [rule('oneSpellPerTurn', 'each_player')];
	if (low === "your opponents can't cast spells from anywhere other than their hands") return [rule('castOnlyFromHand', 'each_opponent')];
	if (low === 'each opponent can cast spells only any time they could cast a sorcery') return [rule('castOnlySorcerySpeed', 'each_opponent')];
	if (
		low === "during your turn, your opponents can't cast spells" ||
		low ===
			"during your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments"
	) {
		return [rule('opponentsCantCastDuringYourTurn', 'each_opponent')];
	}
	if (low === "you control your opponents while they're searching their libraries") return [rule('searchControl', 'each_opponent')];
	if (low === 'while an opponent is searching their library, they exile each card they find') {
		return [rule('searchControl', 'each_opponent', { exilesFoundCards: true })];
	}
	if (
		low ===
		'you may play those cards for as long as they remain exiled, and you may spend mana as though it were mana of any color to cast them'
	) {
		return [rule('searchControl', 'each_opponent', { grantPlayFromExile: true, spendManaAsAnyColor: true })];
	}
	if (low === 'you may play those cards for as long as they remain exiled') {
		return [rule('searchControl', 'each_opponent', { grantPlayFromExile: true })];
	}
	if (low === 'players may spend mana as though it were mana of any color') return [rule('spendManaAsAnyColor', 'each_player')];
	const extraLands = low.match(/^you may play (an?|one|two|three|four|\d+) additional lands?(?: on each of your turns)?$/);
	if (extraLands) {
		const amt = count(extraLands[1]);
		if (amt && amt.k === 'const') return [rule('extraLandPlays', 'you', { count: amt.n })];
	}
	// --- Track P22a: Symmetrical land drops, stax locks, player counter locks, & protection from chosen card type ---
	const symExtraLands = low.match(
		/^(?:each player|players) may play (?:(an?|one|two|three|four|\d+) additional|an additional (one|two|three|four|\d+)) lands?(?: on each of their turns)?$/
	);
	if (symExtraLands) {
		const amt = count(symExtraLands[1] ?? symExtraLands[2]);
		if (amt && amt.k === 'const') return [rule('extraLandPlays', 'each_player', { count: amt.n })];
	}
	if (low === "players can't play lands" || low === "each player can't play lands") {
		return [rule('cantPlayLands', 'each_player')];
	}
	if (low === "your opponents can't play lands") return [rule('cantPlayLands', 'each_opponent')];
	if (low === "you can't play lands") return [rule('cantPlayLands', 'you')];
	if (low === "lands can't enter the battlefield") {
		return [{ kind: 'static', static: { k: 'landsCantEnterBattlefield' } }];
	}
	if (low === "your opponents can't cast spells during combat") {
		return [rule('cantCastDuringCombat', 'each_opponent')];
	}
	if (low === "players can't cast spells during combat" || low === "each player can't cast spells during combat") {
		return [rule('cantCastDuringCombat', 'each_player')];
	}
	if (
		low === 'players can cast spells only any time they could cast a sorcery' ||
		low === 'each player can cast spells only any time they could cast a sorcery'
	) {
		return [rule('castOnlySorcerySpeed', 'each_player')];
	}
	if (
		low === 'players can cast spells only during their own turns' ||
		low === 'each player can cast spells only during their own turn'
	) {
		return [rule('castOnlyDuringOwnTurn', 'each_player')];
	}
	if (low === 'your opponents can cast spells only during their own turns') {
		return [rule('castOnlyDuringOwnTurn', 'each_opponent')];
	}
	if (
		low ===
		"your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments during your turn"
	) {
		return [rule('opponentsCantCastDuringYourTurn', 'each_opponent')];
	}
	const actOwnTurn = s.match(
		/^(Players|Each player|Your opponents) can activate abilities(?: of (.+?))? only (?:during their own turns|any time they could cast a sorcery)$/i
	);
	if (actOwnTurn) {
		const rel = actOwnTurn[1].toLowerCase() === 'your opponents' ? 'each_opponent' : 'each_player';
		const isSorcery = /sorcery$/i.test(s);
		if (!actOwnTurn[2]) {
			return [
				rule('activateOnlyDuringOwnTurn', rel, isSorcery ? { sorceryTiming: true } : undefined)
			];
		}
		const af = parseObjectPhrase(actOwnTurn[2].replace(/\s+and\s+/gi, ' or '), {
			allowPluralAndDisjunction: true
		});
		if (af) {
			return [
				rule('activateOnlyDuringOwnTurn', rel, {
					filter: af,
					...(isSorcery ? { sorceryTiming: true } : {})
				})
			];
		}
	}
	const sameNameExileLock = s.match(
		/^(?:(Your opponents|Players|Each player) can't cast spells|Spells) with the same name as (?:a card exiled with ~|cards exiled with ~|the exiled card)(?: can't be cast)?$/i
	);
	if (sameNameExileLock) {
		const whoRaw = sameNameExileLock[1]?.toLowerCase();
		const rel = whoRaw === 'your opponents' ? 'each_opponent' : 'each_player';
		return [rule('cantCastSameNameAsLinkedExile', rel)];
	}
	const playerCtrLock = s.match(
		/^(Players|Your opponents|You) can't get(?: (poison|experience|energy|rad|ticket))? counters$/i
	);
	if (playerCtrLock) {
		const whoRaw = playerCtrLock[1].toLowerCase();
		const rel =
			whoRaw === 'you' ? 'you' : whoRaw === 'players' ? 'each_player' : 'each_opponent';
		const counter = playerCtrLock[2]?.toLowerCase();
		return [rule('playerCantGetCounters', rel, counter ? { counter } : undefined)];
	}
	if (
		/^Spells and abilities your opponents control can't cause you to sacrifice permanents$/i.test(
			s
		)
	) {
		return [rule('immuneToOpponentForcedSacrifice', 'you')];
	}
	if (
		/^Spells and abilities your opponents control can't cause you to discard cards$/i.test(s)
	) {
		return [rule('immuneToOpponentForcedDiscard', 'you')];
	}
	if (/^You have protection from the chosen (?:card )?type$/i.test(s)) {
		return [rule('playerProtectionFromChosenCardType', 'you')];
	}
	const youAndProtType = s.match(
		/^You and (.+?) have protection from the chosen (?:card )?type$/i
	);
	if (youAndProtType) {
		const aff = parseAffected(youAndProtType[1]);
		if (aff) {
			return [
				rule('playerProtectionFromChosenCardType', 'you'),
				continuous('6', aff, { k: 'protectionFromChosenCardType' })
			];
		}
	}
	if (
		/^You can't cast (?:~|this spell) during your first, second, or third turns of the game$/i.test(
			s
		)
	) {
		return [
			{
				kind: 'static',
				static: {
					k: 'selfCastRestriction',
					castCondition: { k: 'yourTurnsTakenAtLeast', min: 4, onlyDuringYourTurn: true }
				}
			}
		];
	}
	// --- End Track P22a ---
	return null;
};

/** "Dragon spells you cast cost {1} less to cast.", "~ costs {1} less to cast for each creature on the battlefield." */
function costModifiers(activeZones?: ZoneType[]): Production {
	return (s) => {
		const build = (affects: Extract<StaticDef, { k: 'costModifier' }>['affects'], amount: string, dir: string, who: 'you' | 'each_opponent' | 'each_player', times?: Amount): StaticItem[] => {
			const generic = parseInt(amount.slice(1, -1), 10);
			const def: StaticDef = {
				k: 'costModifier',
				affects,
				delta: { mode: dir === 'less' ? 'reduce' : 'increase', generic, ...(times ? { times } : {}) },
				who: { relation: who }
			};
			if (activeZones) def.activeZones = activeZones;
			return [{ kind: 'static', static: def }];
		};
		if (/^if you control (?:a|your) commander, you may cast (?:this spell|~) without paying its mana cost$/i.test(s)) {
			const def: StaticDef = {
				k: 'costModifier',
				affects: { k: 'self' },
				delta: { mode: 'setZero', generic: 0 },
				who: { relation: 'you' },
				condition: { k: 'controlCommander' }
			};
			if (activeZones) def.activeZones = activeZones;
			return [{ kind: 'static', static: def }];
		}
		const targetTax = s.match(
			/^Spells your opponents cast that target ~ cost an additional (\d+) life to cast$/i
		);
		if (targetTax) {
			const life = parseInt(targetTax[1], 10);
			const def: StaticDef = {
				k: 'costModifier',
				affects: { k: 'spell', filter: { targetsSelf: true } },
				delta: {
					mode: 'increase',
					generic: 0,
					additionalCosts: [{ k: 'payLife', amount: n(life) }]
				},
				who: { relation: 'each_opponent' }
			};
			if (activeZones) def.activeZones = activeZones;
			return [{ kind: 'static', static: def }];
		}
		const selfXLess = s.match(/^~ costs \{X\} less to cast,?\s+where X is (.+)$/i);
		if (selfXLess) {
			const times = parseCountAmount(selfXLess[1]);
			if (times) return build({ k: 'self' }, '{1}', 'less', 'you', times);
		}
		const spellsXLess = s.match(
			/^(?:(.+?) )?spells you cast cost \{X\} less to cast,?\s+where X is (.+)$/i
		);
		if (spellsXLess) {
			let filter: ObjectFilter = {};
			if (spellsXLess[1]) {
				const f = parseObjectPhraseWithQualifiers(
					`${spellsXLess[1].replace(/\s+and\s+/gi, ' or ')} card`,
					true
				);
				if (!f) return null;
				filter = f;
			}
			const times = parseCountAmount(spellsXLess[2]);
			if (times) return build({ k: 'spell', filter }, '{1}', 'less', 'you', times);
		}
		const selfIfCond = s.match(/^~ costs (\{\d+\}) (less|more) to cast if (.+)$/i);
		if (selfIfCond) {
			const cond = parseStaticCondition(selfIfCond[3]);
			if (cond) {
				const items = build({ k: 'self' }, selfIfCond[1], selfIfCond[2].toLowerCase(), 'you');
				if (withCondition(items, cond)) return items;
			}
		}
		const chosenNameSpells = s.match(
			/^Spells with the chosen name(?: (you|your opponents) cast)? cost (\{\d+\}) (less|more) to cast$/i
		);
		if (chosenNameSpells) {
			const who =
				chosenNameSpells[1]?.toLowerCase() === 'you'
					? 'you'
					: chosenNameSpells[1]?.toLowerCase() === 'your opponents'
						? 'each_opponent'
						: 'each_player';
			return build(
				{ k: 'spell', filter: { ofChosenName: true } },
				chosenNameSpells[2],
				chosenNameSpells[3].toLowerCase(),
				who
			);
		}
		const gyOrExileSpells = s.match(
			/^Spells you cast from your graveyard or from exile cost (\{\d+\}) (less|more) to cast$/i
		);
		if (gyOrExileSpells) {
			return build(
				{
					k: 'spell',
					filter: { anyOf: [{ castFromZone: 'graveyard' }, { castFromZone: 'exile' }] }
				},
				gyOrExileSpells[1],
				gyOrExileSpells[2].toLowerCase(),
				'you'
			);
		}
		const nthSpellCost = s.match(
			/^The (first|second) (?:(.+?) )?spell you cast (each turn|during each of your turns) costs (\{\d+\}) (less|more) to cast$/i
		);
		if (nthSpellCost) {
			const ordinal: 1 | 2 = nthSpellCost[1].toLowerCase() === 'first' ? 1 : 2;
			let filter: ObjectFilter = {};
			if (nthSpellCost[2]) {
				const f = parseObjectPhraseWithQualifiers(
					`${nthSpellCost[2].replace(/\s+and\s+/gi, ' or ')} card`,
					true
				);
				if (!f) return null;
				filter = f;
			}
			const nthCond: Condition = {
				k: 'nthMatchingSpellThisTurn',
				ordinal,
				...(Object.keys(filter).length > 0 ? { filter } : {})
			};
			const cond: Condition =
				nthSpellCost[3].toLowerCase() === 'during each of your turns'
					? { k: 'and', of: [{ k: 'isTurnOf', player: { k: 'you' } }, nthCond] }
					: nthCond;
			const items = build(
				{ k: 'spell', filter },
				nthSpellCost[4],
				nthSpellCost[5].toLowerCase(),
				'you'
			);
			if (withCondition(items, cond)) return items;
		}
		const self = s.match(/^~ costs (\{\d+\}) (less|more) to cast(?: for each (.+))?$/);
		if (self) {
			if (!self[3]) return build({ k: 'self' }, self[1], self[2], 'you');
			const times = parseCountAmount(`the number of ${self[3]}`);
			if (times) return build({ k: 'self' }, self[1], self[2], 'you', times);
		}
		const spells = s.match(
			/^(?:(.+?) )?[Ss]pells(?: of the chosen (card type|type|color))?(?: (you|your opponents) cast)?(?: of the chosen (card type|type|color))? cost (\{\d+\}) (less|more) to cast$/
		);
		if (spells) {
			const chosenA = spells[2]?.toLowerCase();
			const who = spells[3] === 'you' ? 'you' : spells[3] === 'your opponents' ? 'each_opponent' : 'each_player';
			const chosenB = spells[4]?.toLowerCase();
			if (chosenA && chosenB && chosenA === chosenB) return null;
			let filter: ObjectFilter = {};
			if (spells[1]) {
				// "Instant and sorcery spells" means spells that are either.
				const f = parseObjectPhrase(`${spells[1].replace(/ and /gi, ' or ')} card`);
				if (!f) return null;
				filter = f;
			}
			if (
				chosenA === 'type' ||
				chosenA === 'card type' ||
				chosenB === 'type' ||
				chosenB === 'card type'
			) {
				filter = { ...filter, ofChosenType: true };
			}
			if (chosenA === 'color' || chosenB === 'color') filter = { ...filter, ofChosenColor: true };
			return build({ k: 'spell', filter }, spells[5], spells[6], who);
		}
		const abilityMod = s.match(/^(Equip|Cycling) abilities you activate cost (\{\d+\}) (less|more)(?: to activate)?$/i);
		if (abilityMod) {
			return build(
				{ k: 'ability', keyword: abilityMod[1].toLowerCase() },
				abilityMod[2],
				abilityMod[3].toLowerCase(),
				'you'
			);
		}
		if (/^(?:Equipment you control have equip \{0\}|Equip abilities you activate cost \{0\})$/i.test(s)) {
			const def: StaticDef = { k: 'costModifier', affects: { k: 'ability', keyword: 'equip' }, delta: { mode: 'setZero', generic: 0 }, who: { relation: 'you' } };
			if (activeZones) def.activeZones = activeZones;
			return [{ kind: 'static', static: def }];
		}
		// --- Track P11 & P14: Permanent spell additional costs & generalized cost modifiers ---
		const generalized = parseCostModifierSentence(s);
		if (generalized) {
			if (activeZones && generalized.k !== 'costModifier') return null;
			if (activeZones && generalized.k === 'costModifier') generalized.activeZones = activeZones;
			return [{ kind: 'static', static: generalized }];
		}
		if (!activeZones) {
			const isPermCastPayable = (d: CostDef): boolean => {
				switch (d.k) {
					case 'mana':
					case 'payLife':
					case 'payEnergy':
					case 'tapSubsetSum':
					case 'mill':
					case 'waterbend':
					case 'behold':
					case 'discardHand':
					case 'putFromHandOnTopOfLibrary':
					case 'chooseCreatureType':
					case 'beholdOrChoose':
					case 'chooseNumberBetween':
					case 'repeatableOptionalMana':
						return true;
					case 'sacrifice':
					case 'discard':
					case 'tapOthers':
					case 'returnToHand':
					case 'revealFromHand':
						return d.filter !== 'self';
					case 'removeCounters':
						return d.from !== 'self';
					case 'putCounters':
						return d.on !== 'self';
					case 'exileFrom':
						return (
							d.filter !== 'self' &&
							(d.zone === 'graveyard' || d.zone === 'hand' || d.zone === 'battlefield')
						);
					case 'choice':
						return (
							d.options.length > 0 &&
							d.options.every((opt) => opt.length > 0 && opt.every(isPermCastPayable))
						);
					case 'optional':
						return d.cost.length > 0 && d.cost.every(isPermCastPayable);
					default:
						return false;
				}
			};
			const selfAddCost = parseAdditionalCostSentence(s, 1);
			if (
				selfAddCost &&
				selfAddCost.unparsed.length === 0 &&
				selfAddCost.defs.length > 0 &&
				selfAddCost.defs.every(isPermCastPayable)
			) {
				return [
					{
						kind: 'static',
						static: {
							k: 'additionalCastCost',
							costs: selfAddCost.defs
						}
					}
				];
			}
		}
		// --- End Track P11 & P14 ---
		return null;
	};
}

/** "~'s power and toughness are each equal to ..." / "~'s power is equal to ..." / Tarmogoyf (CR 604.3, 208.2a) */
const cda: Production = (s) => {
	const both = s.match(/^~'s power and toughness are each equal to (.+)$/i);
	if (both) {
		const amount = parseCountAmount(both[1]);
		return amount ? [continuous('7a', 'self', { k: 'setBasePT', power: amount, toughness: amount })] : null;
	}
	// Tarmogoyf / Lhurgoyf: "~'s power is equal to <Amount> and its toughness is equal to that number plus <N>"
	const goyf = s.match(
		/^~'s power is equal to (.+?) and its toughness is equal to that number plus (\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/i
	);
	if (goyf) {
		const power = parseCountAmount(goyf[1]);
		const delta = count(goyf[2]);
		if (power && delta) {
			const toughness: Amount = { k: 'sum', args: [power, delta] };
			return [continuous('7a', 'self', { k: 'setBasePT', power, toughness })];
		}
		return null;
	}
	const powerOnly = s.match(/^~'s power is equal to (.+)$/i);
	if (powerOnly) {
		const power = parseCountAmount(powerOnly[1]);
		return power ? [continuous('7a', 'self', { k: 'setBasePower', power })] : null;
	}
	const toughnessOnly = s.match(/^~'s toughness is equal to (.+)$/i);
	if (toughnessOnly) {
		const toughness = parseCountAmount(toughnessOnly[1]);
		return toughness ? [continuous('7a', 'self', { k: 'setBaseToughness', toughness })] : null;
	}
	const multiSubCda = s.match(
		/^~ is also (?:a |an )?([A-Z][A-Za-z'-]*(?:,\s*[A-Z][A-Za-z'-]*)*,?\s+and\s+[A-Z][A-Za-z'-]*)$/
	);
	if (multiSubCda) {
		const toks = multiSubCda[1]
			.split(/,\s*and\s+|\s+and\s+|,\s*/)
			.map((t) => t.trim())
			.filter(Boolean);
		if (
			toks.length >= 2 &&
			toks.every(
				(tk) =>
					/^[A-Z][A-Za-z'-]*$/.test(tk) &&
					!CARD_TYPES[tk.toLowerCase()] &&
					tk.toLowerCase() !== 'legendary' &&
					tk.toLowerCase() !== 'basic' &&
					tk.toLowerCase() !== 'snow'
			)
		) {
			return [continuous('4', 'self', { k: 'addTypes', types: [], subtypes: toks })];
		}
	}
	return null;
};

/** "<a/an> [N/N] <color(s)>? <subtypes> <types>": "7/7 red Giant creature", "Insect artifact creature", "green Elk creature", "colorless Forest land". */
function parseTypeDescription(
	desc: string
): { basePT?: [number, number]; colors?: ManaColor[]; types: string[]; subtypes: string[] } | null {
	const words = desc
		.trim()
		.replace(/,/g, ' , ')
		.split(/\s+/)
		.filter(Boolean);
	let basePT: [number, number] | undefined;
	if (words[0] && /^\d+\/\d+$/.test(words[0])) {
		const [p, t] = words.shift()!.split('/');
		basePT = [parseInt(p, 10), parseInt(t, 10)];
	}
	let colors: ManaColor[] | undefined;
	if (words[0] === 'colorless') {
		colors = [];
		words.shift();
	} else if (words[0] && COLORS[words[0]]) {
		colors = [COLORS[words.shift()!]];
		for (let guard = 0; guard < 16 && words.length >= 2; guard++) {
			if (words[0] === ',' && words[1] === 'and' && words[2] && COLORS[words[2]]) {
				words.shift();
				words.shift();
				colors.push(COLORS[words.shift()!]);
			} else if (words[0] === ',' && words[1] && COLORS[words[1]]) {
				words.shift();
				colors.push(COLORS[words.shift()!]);
			} else if (words[0] === 'and' && words[1] && COLORS[words[1]]) {
				words.shift();
				colors.push(COLORS[words.shift()!]);
			} else {
				break;
			}
		}
	}
	const types: string[] = [];
	const subtypes: string[] = [];
	for (const w of words) {
		if (CARD_TYPES[w]) types.push(CARD_TYPES[w]);
		else if (/^[A-Z][A-Za-z'-]*$/.test(w) && types.length === 0) subtypes.push(w);
		else return null;
	}
	return types.length > 0 ? { ...(basePT ? { basePT } : {}), colors, types, subtypes } : null;
}

/**
 * Attached type changers and ability loss: "Enchanted creature is an Insect artifact creature with
 * base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types,
 * and creature types.", "Enchanted creature loses all abilities and is a green Elk creature with base
 * power and toughness 3/3.", "Enchanted permanent is a colorless Forest land.",
 * "Enchanted Mountain is a 7/7 red Giant creature with haste. It's still a land."
 */
function attachedTypeChange(depth = 0): Production {
	return (s) => {
		const m = s.match(
			/^((?:Enchanted|Equipped) (creature|permanent|land|artifact|enchantment|planeswalker|Vehicle|Mount|Spacecraft|Equipment|Wall|Plains|Island|Swamp|Mountain|Forest)) (.+)$/
		);
		if (!m) return null;
		const hostIsCreature = m[2].toLowerCase() === 'creature';
		let rest = m[3];
		let typeDesc: ReturnType<typeof parseTypeDescription> = null;
		let subtypeOnlyColors: ManaColor[] | undefined;
		let subtypeOnlyList: string[] | undefined;
		let basePT: [number, number] | undefined;
		let grantedAbilities: AbilityDef[] | undefined;
		let keywords: string[] | undefined;
		let losesAll = false;
		let losesAllKeepMana = false;
		let losesTypes = false;
		let keepTypes = false;
		let keepColors = false;
		let doesntUntap = false;
		let cantAttackOrBlock = false;
		let sawIs = false;
		const addParsedKeywords = (raw: string): boolean => {
			const parsed = parseKeywordList(raw);
			if (parsed) {
				keywords = keywords ? [...keywords, ...parsed] : parsed;
				return true;
			}
			const paramItems = parseParameterizedKeywordList(raw, 'attachedTo', undefined, depth);
			if (!paramItems) return false;
			for (const pi of paramItems) {
				if (pi.kind === 'static' && pi.static.k === 'continuous' && pi.static.layer === '6') {
					if (pi.static.mod.k === 'addKeywords') {
						keywords = keywords ? [...keywords, ...pi.static.mod.keywords] : pi.static.mod.keywords;
					} else if (pi.static.mod.k === 'grantAbility') {
						grantedAbilities = grantedAbilities
							? [...grantedAbilities, pi.static.mod.ability]
							: [pi.static.mod.ability];
					} else {
						return false;
					}
				} else {
					return false;
				}
			}
			return true;
		};
		const addParsedQuotes = (raw: string): boolean => {
			const parsed = parseGrantedAbilities(raw, depth);
			if (!parsed) return false;
			grantedAbilities = grantedAbilities ? [...grantedAbilities, ...parsed] : parsed;
			return true;
		};
		const parseSubtypeOnlyDesc = (
			raw: string
		): { basePT?: [number, number]; colors?: ManaColor[]; subtypes: string[] } | null => {
			const words = raw
				.trim()
				.replace(/,/g, ' , ')
				.split(/\s+/)
				.filter(Boolean);
			let pt: [number, number] | undefined;
			if (words[0] && /^\d+\/\d+$/.test(words[0])) {
				const [p, t] = words.shift()!.split('/');
				pt = [parseInt(p, 10), parseInt(t, 10)];
			}
			let cols: ManaColor[] | undefined;
			if (words[0] === 'colorless') {
				cols = [];
				words.shift();
			} else if (words[0] && COLORS[words[0]]) {
				cols = [COLORS[words.shift()!]];
				for (let guard = 0; guard < 16 && words.length >= 2; guard++) {
					if (words[0] === ',' && words[1] === 'and' && words[2] && COLORS[words[2]]) {
						words.shift();
						words.shift();
						cols.push(COLORS[words.shift()!]);
					} else if (words[0] === ',' && words[1] && COLORS[words[1]]) {
						words.shift();
						cols.push(COLORS[words.shift()!]);
					} else if (words[0] === 'and' && words[1] && COLORS[words[1]]) {
						words.shift();
						cols.push(COLORS[words.shift()!]);
					} else {
						break;
					}
				}
			}
			if (words.length === 0) return null;
			for (const w of words) {
				if (!/^[A-Z][A-Za-z'-]*$/.test(w) || BASIC_LAND_TYPES[w.toLowerCase()]) return null;
			}
			return { ...(pt ? { basePT: pt } : {}), ...(cols !== undefined ? { colors: cols } : {}), subtypes: words };
		};
		const kwEndLookahead =
			'(?=\\s+that\'s still |\\s+in addition to |(?:,?\\s+and|,)(?=\\s+(?:it\\b|loses\\b|is\\b|has\\b|with\\b|doesn\'t\\b|can\'t\\b))|$)';
		const steps: Array<[RegExp, (mm: RegExpMatchArray) => boolean]> = [
			[/^(?:, and it|, and|and it|and|,)(?=\s)/, () => true],
			[/^loses all other abilities, card types, and creature types/, () => ((losesAll = true), (losesTypes = true), true)],
			[/^loses all other card types and creature types/, () => ((losesTypes = true), true)],
			[/^loses all other card types and abilities/, () => ((losesAll = true), (losesTypes = true), true)],
			// --- Track P14: "loses all other card types" (e.g. One with the Stars) ---
			[/^loses all other card types/, () => ((losesTypes = true), true)],
			// --- End Track P14 ---
			// --- Track P17a: "loses all [other] abilities except mana abilities" & "doesn't untap..." ---
			[
				/^loses all (?:other )?abilities except mana abilities/,
				() => ((losesAll = true), (losesAllKeepMana = true), true)
			],
			[
				/^doesn't untap during its controller's untap step/,
				() => ((doesntUntap = true), true)
			],
			[/^can't attack or block/, () => ((cantAttackOrBlock = true), true)],
			// --- End Track P17a ---
			[/^loses all (?:other )?abilities/, () => ((losesAll = true), true)],
			[
				/^is an? (.+?)(?= with | that's still | in addition to |,? and |$)/,
				(mm) => {
					typeDesc = parseTypeDescription(mm[1]);
					if (typeDesc) {
						sawIs = true;
						if (typeDesc.basePT) basePT = typeDesc.basePT;
						return true;
					}
					if (hostIsCreature) {
						const subOnly = parseSubtypeOnlyDesc(mm[1]);
						if (subOnly) {
							sawIs = true;
							subtypeOnlyList = subOnly.subtypes;
							subtypeOnlyColors = subOnly.colors;
							if (subOnly.basePT) basePT = subOnly.basePT;
							return true;
						}
					}
					return false;
				}
			],
			[/^(?:with|has) base power and toughness (\d+)\/(\d+)/, (mm) => ((basePT = [parseInt(mm[1], 10), parseInt(mm[2], 10)]), true)],
			[/^(?:with|has) (?:"([^"]+)"|'([^']+)')/, (mm) => addParsedQuotes(mm[1] ?? mm[2])],
			[
				new RegExp(`^with ([^"]+?)${kwEndLookahead}`),
				(mm) => addParsedKeywords(mm[1])
			],
			[/^(?:that's |it's )?still an? (?:land|artifact|enchantment|planeswalker)/, () => ((keepTypes = true), true)],
			[/^in addition to its other colors and types/, () => ((keepTypes = true), (keepColors = true), true)],
			[/^in addition to its other types/, () => ((keepTypes = true), true)],
			[new RegExp(`^has ([^"]+?)${kwEndLookahead}`), (mm) => addParsedKeywords(mm[1])]
		];
		for (let guard = 0; guard < 32 && (rest = rest.trimStart()).length > 0; guard++) {
			let matched = false;
			for (const [re, apply] of steps) {
				const mm = rest.match(re);
				if (!mm || mm[0].length === 0) continue;
				if (!apply(mm)) return null;
				rest = rest.slice(mm[0].length);
				matched = true;
				break;
			}
			if (!matched) return null;
		}
		if (rest.trimStart().length > 0) return null;
		if (!sawIs && !losesAll && !basePT) return null; // "Enchanted creature gets/has ..." is handled by grants.

		const items: StaticItem[] = [];
		const desc = typeDesc as ReturnType<typeof parseTypeDescription>;
		if (desc) {
			const isArtifactCreature = desc.types.includes('Artifact') && desc.types.includes('Creature');
			// CR 205.1b: "artifact creature" without subtypes keeps all prior card types and subtypes;
			// "[subtype] artifact creature" keeps prior card types unless losesTypes is stated.
			if (isArtifactCreature && !losesTypes && !keepTypes && desc.subtypes.length > 0) return null;
			const additive = keepTypes || (isArtifactCreature && !losesTypes && desc.subtypes.length === 0);
			if (additive) {
				items.push(
					continuous('4', 'attachedTo', {
						k: 'addTypes',
						types: desc.types,
						...(desc.subtypes.length > 0 ? { subtypes: desc.subtypes } : {})
					})
				);
			} else {
				items.push(continuous('4', 'attachedTo', { k: 'setTypes', types: desc.types, subtypes: desc.subtypes }));
			}
			if (desc.colors) {
				items.push(
					continuous('5', 'attachedTo', {
						k: keepColors && desc.colors.length > 0 ? 'addColors' : 'setColors',
						colors: desc.colors
					})
				);
			}
		} else if (subtypeOnlyList) {
			if (keepTypes) {
				items.push(continuous('4', 'attachedTo', { k: 'addTypes', types: [], subtypes: subtypeOnlyList }));
			} else {
				items.push(continuous('4', 'attachedTo', { k: 'setSubtypes', subtypes: subtypeOnlyList }));
			}
			if (subtypeOnlyColors !== undefined) {
				items.push(
					continuous('5', 'attachedTo', {
						k: keepColors && subtypeOnlyColors.length > 0 ? 'addColors' : 'setColors',
						colors: subtypeOnlyColors
					})
				);
			}
		}
		// Ability loss applies before grants from the same effect ("has indestructible, and it loses all other abilities").
		if (losesAll) {
			items.push(
				continuous('6', 'attachedTo', {
					k: 'removeAllAbilities',
					...(losesAllKeepMana ? { keepManaAbilities: true } : {})
				})
			);
		}
		if (grantedAbilities) {
			for (const ability of grantedAbilities) {
				items.push(continuous('6', 'attachedTo', { k: 'grantAbility', ability }));
			}
		}
		if (keywords) items.push(continuous('6', 'attachedTo', { k: 'addKeywords', keywords }));
		if (basePT) items.push(continuous('7b', 'attachedTo', { k: 'setBasePT', power: n(basePT[0]), toughness: n(basePT[1]) }));
		if (doesntUntap) {
			items.push({
				kind: 'static',
				static: { k: 'restriction', affected: 'attachedTo', restriction: 'doesntUntap' }
			});
		}
		if (cantAttackOrBlock) {
			items.push({
				kind: 'static',
				static: { k: 'restriction', affected: 'attachedTo', restriction: 'cantAttackOrBlock' }
			});
		}
		return items;
	};
}

/** Global type and ability changers: Humility, Blood Moon, Urborg, Opalescence, Mycosynth, Maskwood. */
const globalChanges: Production = (s) => {
	if (/^All cards that aren't on the battlefield, spells, and permanents are colorless$/i.test(s)) {
		return [
			continuous('5', {}, { k: 'setColors', colors: [] }),
			{
				kind: 'static',
				static: {
					k: 'ruleModifier',
					rule: 'allOffBattlefieldAndSpellsColorless',
					who: { relation: 'each_player' }
				}
			}
		];
	}
	// --- Track P17a: Painter's Servant, Blood Sun, Living Plane, March of the Machines, all colors, & addChosenColor ---
	if (
		/^All cards that aren't on the battlefield, spells, and permanents are the chosen color in addition to their other colors$/i.test(
			s
		)
	) {
		return [
			continuous('5', {}, { k: 'addChosenColor' }),
			{
				kind: 'static',
				static: {
					k: 'offBattlefieldCharacteristics',
					zones: ['hand', 'graveyard', 'library', 'exile', 'command', 'stack'],
					who: 'all',
					addChosenColor: true
				}
			}
		];
	}
	const loseGen = s.match(
		/^(.+?) loses? all abilities( except mana abilities)?(?: and (?:has|have) base power and (?:base )?toughness (\d+)\/(\d+))?$/i
	);
	if (loseGen) {
		const affected = parseAffected(loseGen[1]);
		if (affected) {
			const items: StaticItem[] = [
				continuous('6', affected, {
					k: 'removeAllAbilities',
					...(loseGen[2] ? { keepManaAbilities: true } : {})
				})
			];
			if (loseGen[3]) {
				items.push(
					continuous('7b', affected, {
						k: 'setBasePT',
						power: n(parseInt(loseGen[3], 10)),
						toughness: n(parseInt(loseGen[4], 10))
					})
				);
			}
			return items;
		}
	}
	const animLands = s.match(
		/^(.+?) (?:is|are) (?:a |an )?(\d+\/\d+.+?) (?:that's|that are) still (?:a |an )?(?:lands?|artifacts?|enchantments?|planeswalkers?)$/i
	);
	if (animLands) {
		const affected = parseAffected(animLands[1]);
		const descText = animLands[2].replace(/\bcreatures\b/gi, 'creature');
		const desc = parseTypeDescription(descText);
		if (affected && desc && desc.basePT) {
			const items: StaticItem[] = [
				continuous('4', affected, {
					k: 'addTypes',
					types: desc.types,
					...(desc.subtypes.length > 0 ? { subtypes: desc.subtypes } : {})
				})
			];
			if (desc.colors !== undefined) {
				items.push(continuous('5', affected, { k: 'setColors', colors: desc.colors }));
			}
			items.push(
				continuous('7b', affected, {
					k: 'setBasePT',
					power: n(desc.basePT[0]),
					toughness: n(desc.basePT[1])
				})
			);
			return items;
		}
	}
	const marchMachines = s.match(
		/^(?:Each|All) (.+?) (?:is|are) (?:a |an )?(.+?) with (?:base )?power and (?:base )?toughness each equal to (?:its|their) mana value$/i
	);
	if (marchMachines) {
		const affected = parseAffected(marchMachines[1]);
		const desc = parseTypeDescription(marchMachines[2].replace(/\bcreatures\b/gi, 'creature'));
		if (affected && typeof affected === 'object' && desc) {
			const mv: Amount = { k: 'stat', of: { k: 'affected' }, stat: 'manaValue' };
			const items: StaticItem[] = [
				continuous('4', affected, {
					k: 'addTypes',
					types: desc.types,
					...(desc.subtypes.length > 0 ? { subtypes: desc.subtypes } : {})
				})
			];
			if (desc.colors !== undefined) {
				items.push(continuous('5', affected, { k: 'setColors', colors: desc.colors }));
			}
			items.push(continuous('7b', affected, { k: 'setBasePT', power: mv, toughness: mv }));
			return items;
		}
	}
	const selfAnim = s.match(
		/^~ is an? (\d+\/\d+\s+.+?|[A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)*)(?:\s+with\s+([\s\S]+))?$/
	);
	if (selfAnim && !/\bin addition to\b/i.test(s)) {
		const rawHead = selfAnim[1].trim();
		const desc = parseTypeDescription(rawHead);
		const subOnly =
			!desc && /^[A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)*$/.test(rawHead) && !BASIC_LAND_TYPES[rawHead.toLowerCase()]
				? rawHead.split(/\s+/)
				: null;
		if ((desc && desc.types.includes('Creature')) || subOnly) {
			let basePT = desc?.basePT;
			let kws: string[] | undefined;
			let grantedAbs: AbilityDef[] | undefined;
			let tailOk = true;
			if (selfAnim[2]) {
				let rem = selfAnim[2].trim();
				const basePtHead = rem.match(/^base power and toughness (\d+)\/(\d+)(?:,\s*|\s+and\s+|$)/i);
				if (basePtHead) {
					basePT = [parseInt(basePtHead[1], 10), parseInt(basePtHead[2], 10)];
					rem = rem.slice(basePtHead[0].length).trim();
				}
				if (rem.length > 0) {
					const parsedTail = parseHasGrantTail('self', rem, undefined, 0);
					if (!parsedTail) {
						tailOk = false;
					} else {
						for (const ti of parsedTail) {
							if (ti.kind === 'static' && ti.static.k === 'continuous' && ti.static.layer === '6') {
								if (ti.static.mod.k === 'addKeywords') {
									kws = [...(kws ?? []), ...ti.static.mod.keywords];
								} else if (ti.static.mod.k === 'grantAbility') {
									grantedAbs = [...(grantedAbs ?? []), ti.static.mod.ability];
								} else {
									tailOk = false;
								}
							} else {
								tailOk = false;
							}
						}
					}
				}
			}
			if (tailOk && (basePT || desc)) {
				const out: StaticItem[] = [];
				if (desc) {
					const isArtCreature = desc.types.includes('Artifact') && desc.types.includes('Creature');
					if (isArtCreature) {
						out.push(
							continuous('4', 'self', {
								k: 'addTypes',
								types: desc.types,
								...(desc.subtypes.length > 0 ? { subtypes: desc.subtypes } : {})
							})
						);
					} else {
						out.push(
							continuous('4', 'self', {
								k: 'setTypes',
								types: desc.types,
								subtypes: desc.subtypes
							})
						);
					}
					if (desc.colors !== undefined) {
						out.push(continuous('5', 'self', { k: 'setColors', colors: desc.colors }));
					}
				} else if (subOnly) {
					out.push(continuous('4', 'self', { k: 'setSubtypes', subtypes: subOnly }));
				}
				if (kws && kws.length > 0) {
					out.push(continuous('6', 'self', { k: 'addKeywords', keywords: kws }));
				}
				if (grantedAbs) {
					for (const ability of grantedAbs) {
						out.push(continuous('6', 'self', { k: 'grantAbility', ability }));
					}
				}
				if (basePT) {
					out.push(
						continuous('7b', 'self', {
							k: 'setBasePT',
							power: n(basePT[0]),
							toughness: n(basePT[1])
						})
					);
				}
				return out;
			}
		}
	}
	const allColorsMatch = s.match(/^([^"]+?)\s+(?:is|are) all colors$/i);
	if (allColorsMatch) {
		const affected = parseAffected(allColorsMatch[1]);
		if (affected) {
			return [continuous('5', affected, { k: 'setColors', colors: ['W', 'U', 'B', 'R', 'G'] })];
		}
	}
	const addChosenCol = s.match(
		/^(.+?) (?:is|are) the chosen color in addition to (?:its|their) other colors$/i
	);
	if (addChosenCol) {
		const affected = parseAffected(addChosenCol[1]);
		if (affected) {
			return [continuous('5', affected, { k: 'addChosenColor' })];
		}
	}
	// --- End Track P17a ---
	const lose = s.match(/^(All creatures|Creatures) lose all abilities(?: and have base power and toughness (\d+)\/(\d+))?$/);
	if (lose) {
		const affected: ObjectFilter = { types: ['Creature'] };
		const items = [continuous('6', affected, { k: 'removeAllAbilities' })];
		if (lose[2]) items.push(continuous('7b', affected, { k: 'setBasePT', power: n(parseInt(lose[2], 10)), toughness: n(parseInt(lose[3], 10)) }));
		return items;
	}
	const nonbasic = s.match(/^Nonbasic lands are (Plains|Islands|Swamps|Mountains|Forests)$/);
	if (nonbasic) {
		return [continuous('4', { types: ['Land'], notSupertypes: ['Basic'] }, { k: 'setSubtypes', subtypes: [BASIC_LAND_TYPES[nonbasic[1].toLowerCase()]] })];
	}
	const enchLandBasic = s.match(
		/^Enchanted land is an? (Plains|Island|Swamp|Mountain|Forest)$/i
	);
	if (enchLandBasic) {
		return [
			continuous('4', 'attachedTo', {
				k: 'setSubtypes',
				subtypes: [BASIC_LAND_TYPES[enchLandBasic[1].toLowerCase()]]
			})
		];
	}
	const allBasicTypes = s.match(
		/^(.+?) are every basic land type in addition to their other types$/i
	);
	if (allBasicTypes) {
		const affected = parseAffected(allBasicTypes[1]);
		if (affected) {
			return [
				continuous('4', affected, {
					k: 'addTypes',
					types: [],
					subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']
				})
			];
		}
	}
	const eachLand = s.match(
		/^(?:Each|All) lands? (?:is|are) (?:an? )?(Plains|Islands?|Swamps?|Mountains?|Forests?) in addition to (?:its|their) other(?: land)? types$/i
	);
	if (eachLand) {
		const basicSub = BASIC_LAND_TYPES[eachLand[1].toLowerCase()];
		if (basicSub) {
			return [continuous('4', { types: ['Land'] }, { k: 'addTypes', types: [], subtypes: [basicSub] })];
		}
	}
	const addType = s.match(/^(?:Each|All) (.+?) (?:is|are) (?:an? )?([a-z]+?)s? in addition to (?:its|their) other types( and (?:has|have) base power and (?:base )?toughness each equal to (?:its|their) mana value)?$/);
	if (addType && CARD_TYPES[addType[2]]) {
		const affected = parseAffected(addType[1]);
		if (!affected || typeof affected !== 'object') return null;
		const items = [continuous('4', affected, { k: 'addTypes', types: [CARD_TYPES[addType[2]]] })];
		if (addType[3]) {
			const mv: Amount = { k: 'stat', of: { k: 'affected' }, stat: 'manaValue' };
			items.push(continuous('7b', affected, { k: 'setBasePT', power: mv, toughness: mv }));
		}
		return items;
	}
	const every = s.match(
		/^(.+?) (?:is|are) (?:every creature type|all creature types)(?: in addition to (?:its|their) other types)?$/i
	);
	if (every) {
		const affected = parseAffected(every[1]);
		return affected ? [continuous('4', affected, { k: 'allCreatureTypes' })] : null;
	}
	const chosenType = s.match(/^(.+?) (?:is|are) the chosen type in addition to (?:its|their) other types$/i);
	if (chosenType) {
		const affected = parseAffected(chosenType[1]);
		return affected ? [continuous('4', affected, { k: 'addChosenSubtype' })] : null;
	}
	const setChosenType = s.match(/^(.+?) (?:is|are) the chosen type$/i);
	if (setChosenType) {
		const affected = parseAffected(setChosenType[1]);
		return affected ? [continuous('4', affected, { k: 'setChosenSubtype' })] : null;
	}
	const chosenCol = s.match(/^(.+?) (?:is|are) the chosen color$/i);
	if (chosenCol) {
		const affected = parseAffected(chosenCol[1]);
		return affected ? [continuous('5', affected, { k: 'setChosenColor' })] : null;
	}
	// --- Track P14: Layer 4 type removal & generalized additive types/colors (CR 105.3, 205.1a–b, 613.1d, 700.5) ---
	const isntUnless = s.match(
		/^(.+?) (?:isn't|aren't|is not|are not) (?:a |an )?(creatures?|artifacts?|enchantments?|lands?|planeswalkers?) unless (.+)$/i
	);
	if (isntUnless) {
		const affected = parseAffected(isntUnless[1]);
		const tKey = singularType(isntUnless[2].toLowerCase());
		const cardType = CARD_TYPES[tKey];
		const unlessCond = parseUnlessEtbCondition(isntUnless[3]);
		if (affected && cardType && unlessCond) {
			return [
				continuous(
					'4',
					affected,
					{ k: 'removeTypes', types: [cardType] },
					{ k: 'not', of: unlessCond }
				)
			];
		}
	}
	const isntType = s.match(
		/^(.+?) (?:isn't|aren't|is not|are not) (?:a |an )?(creatures?|artifacts?|enchantments?|lands?|planeswalkers?)([\s\S]*)$/i
	);
	if (isntType) {
		const { modifierPart, tailPart } = splitPtModifierAndTail(isntType[3]);
		if (modifierPart.trim() === '') {
			const affected = parseAffected(isntType[1]);
			const tKey = singularType(isntType[2].toLowerCase());
			const cardType = CARD_TYPES[tKey];
			if (affected && cardType) {
				const out: StaticItem[] = [continuous('4', affected, { k: 'removeTypes', types: [cardType] })];
				if (tailPart) {
					const tailItems = parseInlineStaticTail(affected, tailPart, undefined, 0);
					if (!tailItems) return null;
					out.push(...tailItems);
				}
				return out;
			}
		}
	}
	const addTypesGen = s.match(
		/^([^"]+?)\s+(?:is|are) (.+?) in addition to (?:its|their) other (?:land |creature )?types([\s\S]*)$/i
	);
	if (addTypesGen) {
		const { modifierPart, tailPart } = splitPtModifierAndTail(addTypesGen[3]);
		if (modifierPart.trim() === '') {
			const affected = parseAffected(addTypesGen[1]);
			const desc = parseAdditiveTypesAndColors(addTypesGen[2]);
			if (affected && desc) {
				const out: StaticItem[] = [
					continuous('4', affected, {
						k: 'addTypes',
						types: desc.types,
						...(desc.subtypes.length > 0 ? { subtypes: desc.subtypes } : {})
					})
				];
				if (desc.colors !== undefined) {
					out.push(continuous('5', affected, { k: 'setColors', colors: desc.colors }));
				}
				if (tailPart) {
					const tailItems = parseInlineStaticTail(affected, tailPart, undefined, 0);
					if (!tailItems) return null;
					out.push(...tailItems);
				}
				return out;
			}
		}
	}
	const addColsGen = s.match(
		/^([^"]+?)\s+(?:is|are) (.+?) in addition to (?:its|their) other colors$/i
	);
	if (addColsGen) {
		const affected = parseAffected(addColsGen[1]);
		const cols = parseStaticColorWordList(addColsGen[2]);
		if (affected && cols && cols.length > 0) {
			return [continuous('5', affected, { k: 'addColors', colors: cols })];
		}
	}
	const setColsGen = s.match(/^([^"]+?)\s+(?:is|are) (colorless|(?:white|blue|black|red|green)(?:(?:,\s*(?:and\s+)?|\s+and\s+)(?:white|blue|black|red|green))*)$/i);
	if (setColsGen) {
		const affected = parseAffected(setColsGen[1]);
		const cols = parseStaticColorWordList(setColsGen[2]);
		if (affected && cols !== null) {
			return [continuous('5', affected, { k: 'setColors', colors: cols })];
		}
	}
	// --- End Track P14 ---
	return null;
};

/** Layer 2 control-changing statics ("You control enchanted creature."). */
const controlChange: Production = (s) => {
	const m = s.match(
		/^You control (?:enchanted|equipped) (?:creature|artifact creature|permanent|land|artifact|enchantment|planeswalker|vehicle|mount|equipment|spacecraft|battle|wall|plains|island|swamp|mountain|forest)$/i
	);
	if (m) {
		return [continuous('2', 'attachedTo', { k: 'setController', controller: { k: 'you' } })];
	}
	return null;
};

/** "Creatures your opponents control lose flying and can't have or gain flying." */
const keywordRemoval: Production = (s) => {
	const m = s.match(/^(.+?) loses? (.+?)(?: and can't have or gain (.+))?$/);
	if (!m || /\babilities\b/.test(m[2])) return null;
	const affected = parseAffected(m[1]);
	const kws = parseKeywordList(m[2]);
	if (!affected || !kws) return null;
	if (m[3]) {
		const again = parseKeywordList(m[3]);
		if (!again || again.join() !== kws.join()) return null;
	}
	return [continuous('6', affected, { k: 'removeKeywords', keywords: kws, ...(m[3] ? { cantHaveOrGain: true } : {}) })];
};

// --- Track P11: Quote-aware grant tail splitting & quoted/dynamic Layer 6/7b/7c helpers ---

const INLINE_TAIL_CLAUSE_START_RE =
	/^(?:,\s*and\s+|,\s+|\s+and\s+)(?!can't have or gain\b|cannot have or gain\b)((?:has|have|gets|get|is|are|isn't|aren't|assigns|assign|can't|cannot|must|can block|can attack|doesn't untap|don't untap|attacks|attack|blocks|block|loses|lose|its activated abilities|you control it)(?:\b[\s\S]*))$/i;

function splitPtModifierAndTail(rest: string): { modifierPart: string; tailPart?: string } {
	let inQuote: '"' | "'" | null = null;
	for (let i = 0; i < rest.length; i++) {
		const ch = rest[i];
		if (inQuote === '"') {
			if (ch === '"') inQuote = null;
			continue;
		}
		if (inQuote === "'") {
			if (ch === "'" && (i + 1 === rest.length || /[\s.,;]/.test(rest[i + 1]))) {
				inQuote = null;
			}
			continue;
		}
		if (ch === '"') {
			inQuote = '"';
			continue;
		}
		if (ch === "'" && (i === 0 || /\s/.test(rest[i - 1]))) {
			inQuote = "'";
			continue;
		}
		const tailMatch = rest.slice(i).match(INLINE_TAIL_CLAUSE_START_RE);
		if (tailMatch) {
			return { modifierPart: rest.slice(0, i), tailPart: tailMatch[1].trim() };
		}
	}
	return { modifierPart: rest };
}

// --- Track P14: Color/type additive helpers & multi-clause inline static tail parser ---
function parseStaticColorWordList(raw: string): ManaColor[] | null {
	const t = raw.trim().toLowerCase();
	if (t === 'colorless') return [];
	const parts = t.split(/,\s*and\s+|\s+and\s+|,\s*/);
	const out: ManaColor[] = [];
	for (const p of parts) {
		const c = COLORS[p.trim()];
		if (!c) return null;
		if (!out.includes(c)) out.push(c);
	}
	return out.length > 0 ? out : null;
}

function parseAdditiveTypesAndColors(
	raw: string
): { colors?: ManaColor[]; types: string[]; subtypes: string[] } | null {
	const words = raw
		.trim()
		.replace(/^(?:a|an)\s+/i, '')
		.replace(/,/g, ' , ')
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return null;
	let colors: ManaColor[] | undefined;
	if (words[0].toLowerCase() === 'colorless') {
		colors = [];
		words.shift();
	} else if (COLORS[words[0].toLowerCase()]) {
		colors = [COLORS[words.shift()!.toLowerCase()]];
		for (let guard = 0; guard < 16 && words.length >= 2; guard++) {
			const w0 = words[0].toLowerCase();
			const w1 = words[1].toLowerCase();
			const w2 = words[2]?.toLowerCase();
			if (w0 === ',' && w1 === 'and' && w2 && COLORS[w2]) {
				words.shift();
				words.shift();
				colors.push(COLORS[words.shift()!.toLowerCase()]);
			} else if (w0 === ',' && COLORS[w1]) {
				words.shift();
				colors.push(COLORS[words.shift()!.toLowerCase()]);
			} else if (w0 === 'and' && COLORS[w1]) {
				words.shift();
				colors.push(COLORS[words.shift()!.toLowerCase()]);
			} else {
				break;
			}
		}
	}
	if (words.length === 0) return null;
	const rem = words
		.join(' ')
		.replace(/\s*,\s*and\s+/gi, ' or ')
		.replace(/\s*,\s*/g, ' or ')
		.replace(/\s+and\s+/gi, ' or ');
	const basicSub = BASIC_LAND_TYPES[rem.toLowerCase()];
	if (basicSub) {
		return { ...(colors !== undefined ? { colors } : {}), types: [], subtypes: [basicSub] };
	}
	const f = parseObjectPhrase(rem, { allowPluralAndDisjunction: true });
	if (!f) return null;
	const keys = Object.keys(f);
	if (!keys.every((k) => k === 'types' || k === 'subtypes')) return null;
	const types = f.types ?? [];
	const subtypes = f.subtypes ?? [];
	if (types.length === 0 && subtypes.length === 0) return null;
	return { ...(colors !== undefined ? { colors } : {}), types, subtypes };
}

function parseSingleInlineStaticClause(
	affected: Affected,
	clauseRaw: string,
	condition: Condition | undefined,
	depth: number
): StaticItem[] | null {
	const c = clauseRaw.trim();
	const basePt = c.match(/^(?:has|have) base power and (?:base )?toughness (\d+)\/(\d+)$/i);
	if (basePt) {
		return [
			continuous(
				'7b',
				affected,
				{
					k: 'setBasePT',
					power: n(parseInt(basePt[1], 10)),
					toughness: n(parseInt(basePt[2], 10))
				},
				condition
			)
		];
	}
	const baseP = c.match(/^(?:has|have) base power (\d+)$/i);
	if (baseP) {
		return [
			continuous('7b', affected, { k: 'setBasePower', power: n(parseInt(baseP[1], 10)) }, condition)
		];
	}
	const baseT = c.match(/^(?:has|have) base toughness (\d+)$/i);
	if (baseT) {
		return [
			continuous(
				'7b',
				affected,
				{ k: 'setBaseToughness', toughness: n(parseInt(baseT[1], 10)) },
				condition
			)
		];
	}
	const hasMatch = c.match(/^(?:has|have) ([\s\S]+)$/i);
	if (hasMatch) {
		return parseHasGrantTail(affected, hasMatch[1], condition, depth);
	}
	const losesAllInline = c.match(/^loses? all (?:other )?abilities( except mana abilities)?$/i);
	if (losesAllInline) {
		return [
			continuous(
				'6',
				affected,
				{ k: 'removeAllAbilities', ...(losesAllInline[1] ? { keepManaAbilities: true } : {}) },
				condition
			)
		];
	}
	const getsMatch = c.match(
		/^gets? (?:an additional )?([+−-])(\d+|X)\/([+−-])(\d+|X)(?:\s*(,?\s*where X is .+|for each .+))?$/i
	);
	if (getsMatch) {
		const pSign = getsMatch[1] === '+' ? 1 : -1;
		const pTok = getsMatch[2].toUpperCase();
		const tSign = getsMatch[3] === '+' ? 1 : -1;
		const tTok = getsMatch[4].toUpperCase();
		const modTail = getsMatch[5]?.trim() ?? '';
		if (pTok === 'X' || tTok === 'X') {
			const wm = modTail.match(/^,?\s*where X is (.+)$/i);
			if (wm) {
				const xAmt = parseCountAmount(wm[1]);
				if (xAmt) {
					const power = pTok === 'X' ? scaleAmount(pSign, xAmt) : n(pSign * parseInt(pTok, 10));
					const toughness = tTok === 'X' ? scaleAmount(tSign, xAmt) : n(tSign * parseInt(tTok, 10));
					return [continuous('7c', affected, { k: 'pt', power, toughness }, condition)];
				}
			}
		} else if (!modTail) {
			return [
				continuous(
					'7c',
					affected,
					{ k: 'pt', power: n(pSign * parseInt(pTok, 10)), toughness: n(tSign * parseInt(tTok, 10)) },
					condition
				)
			];
		} else {
			const fm = modTail.match(/^for each (.+)$/i);
			if (fm) {
				const per = parseCountAmount(`the number of ${fm[1].trim()}`);
				if (per) {
					return [
						continuous(
							'7c',
							affected,
							{
								k: 'pt',
								power: scaleAmount(pSign * parseInt(pTok, 10), per),
								toughness: scaleAmount(tSign * parseInt(tTok, 10), per)
							},
							condition
						)
					];
				}
			}
		}
	}
	if (/^(?:is|are) (?:every creature type|all creature types)(?: in addition to (?:its|their) other types)?$/i.test(c)) {
		return [continuous('4', affected, { k: 'allCreatureTypes' }, condition)];
	}
	if (/^(?:is|are) the chosen type in addition to (?:its|their) other types$/i.test(c)) {
		return [continuous('4', affected, { k: 'addChosenSubtype' }, condition)];
	}
	if (/^(?:is|are) the chosen type$/i.test(c)) {
		return [continuous('4', affected, { k: 'setChosenSubtype' }, condition)];
	}
	if (affected === 'attachedTo' && /^you control it$/i.test(c)) {
		return [
			continuous('2', 'attachedTo', { k: 'setController', controller: { k: 'you' } }, condition)
		];
	}
	if (/^(?:is|are) all colors$/i.test(c)) {
		return [continuous('5', affected, { k: 'setColors', colors: ['W', 'U', 'B', 'R', 'G'] }, condition)];
	}
	if (/^(?:is|are) the chosen color in addition to (?:its|their) other colors$/i.test(c)) {
		return [continuous('5', affected, { k: 'addChosenColor' }, condition)];
	}
	if (/^(?:is|are) the chosen color$/i.test(c)) {
		return [continuous('5', affected, { k: 'setChosenColor' }, condition)];
	}
	const addTypesM = c.match(
		/^(?:is|are) (.+?) in addition to (?:its|their) other (?:land |creature )?types$/i
	);
	if (addTypesM) {
		const desc = parseAdditiveTypesAndColors(addTypesM[1]);
		if (desc) {
			const out: StaticItem[] = [
				continuous(
					'4',
					affected,
					{
						k: 'addTypes',
						types: desc.types,
						...(desc.subtypes.length > 0 ? { subtypes: desc.subtypes } : {})
					},
					condition
				)
			];
			if (desc.colors !== undefined) {
				out.push(continuous('5', affected, { k: 'setColors', colors: desc.colors }, condition));
			}
			return out;
		}
	}
	const addColsM = c.match(/^(?:is|are) (.+?) in addition to (?:its|their) other colors$/i);
	if (addColsM) {
		const cols = parseStaticColorWordList(addColsM[1]);
		if (cols && cols.length > 0) {
			return [continuous('5', affected, { k: 'addColors', colors: cols }, condition)];
		}
	}
	const setColsM = c.match(
		/^(?:is|are) (colorless|(?:white|blue|black|red|green)(?:(?:,\s*(?:and\s+)?|\s+and\s+)(?:white|blue|black|red|green))*)$/i
	);
	if (setColsM) {
		const cols = parseStaticColorWordList(setColsM[1]);
		if (cols !== null) {
			return [continuous('5', affected, { k: 'setColors', colors: cols }, condition)];
		}
	}
	const isntM = c.match(
		/^(?:isn't|aren't|is not|are not) (?:a |an )?(creatures?|artifacts?|enchantments?|lands?|planeswalkers?)$/i
	);
	if (isntM) {
		const cardType = CARD_TYPES[singularType(isntM[1].toLowerCase())];
		if (cardType) {
			return [continuous('4', affected, { k: 'removeTypes', types: [cardType] }, condition)];
		}
	}
	if (/^can't attack or block alone$/i.test(c)) {
		const items: StaticItem[] = [
			{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'cantAttackAlone' } } },
			{ kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'cantBlockAlone' } } }
		];
		if (condition && !withCondition(items, condition)) return null;
		return items;
	}
	const combatItem = parseInlineCombatTail(affected, c);
	if (combatItem) {
		if (condition && !withCondition([combatItem], condition)) return null;
		return [combatItem];
	}
	return null;
}

function parseInlineStaticTail(
	affected: Affected,
	tail: string,
	condition: Condition | undefined,
	depth: number
): StaticItem[] | null {
	const direct = parseSingleInlineStaticClause(affected, tail, condition, depth);
	if (direct) return direct;
	const { modifierPart, tailPart } = splitPtModifierAndTail(tail);
	if (!tailPart || !modifierPart.trim()) return null;
	const headItems = parseSingleInlineStaticClause(affected, modifierPart, condition, depth);
	if (!headItems) return null;
	const restItems = parseInlineStaticTail(affected, tailPart, condition, depth);
	if (!restItems) return null;
	return [...headItems, ...restItems];
}
// --- End Track P14 ---

function parseSingleParamKeywordGrant(
	raw: string,
	affected: Affected,
	condition: Condition | undefined
): StaticItem[] | null {
	const hasBody = raw.trim();
	const zeroSpan: Span = { start: 0, end: 0 };
	const crewGrant = hasBody.match(/^crew (\d+)$/i);
	if (crewGrant) {
		const nVal = parseInt(crewGrant[1], 10);
		if (nVal >= 0) {
			const built = buildCrewAbility({ name: 'crew', n: nVal }, 'granted_0', zeroSpan);
			if (built) {
				return [continuous('6', affected, { k: 'grantAbility', ability: built.ability }, condition)];
			}
		}
	}
	const saddleGrant = hasBody.match(/^saddle (\d+)$/i);
	if (saddleGrant) {
		const nVal = parseInt(saddleGrant[1], 10);
		if (nVal >= 0) {
			const built = buildSaddleAbility({ name: 'saddle', n: nVal }, 'granted_0', zeroSpan);
			if (built) {
				return [
					continuous('6', affected, { k: 'grantAbility', ability: built.ability }, condition)
				];
			}
		}
	}
	const equipGrant = hasBody.match(/^equip(?:\s*—\s*|\s+)(.+)$/i);
	if (equipGrant) {
		const eqCost = parseCost(equipGrant[1].trim(), 0);
		if (
			eqCost.unparsed.length === 0 &&
			eqCost.defs.length > 0 &&
			eqCost.defs.every((d) => !(d.k === 'mana' && /\{X\}/i.test(d.cost)))
		) {
			const builtEq = parseGrantedActivatedAbility(
				`${equipGrant[1].trim()}: Attach ~ to target creature you control. Equip only as a sorcery.`
			);
			if (builtEq) {
				builtEq.costKeyword = 'equip';
				builtEq.text = `Equip ${equipGrant[1].trim()}`;
				return [continuous('6', affected, { k: 'grantAbility', ability: builtEq }, condition)];
			}
		}
	}
	const paramTrigKw = hasBody.match(
		/^(annihilator|bushido|afterlife|soulshift|frenzy|poisonous) (\d+)$/i
	);
	if (paramTrigKw) {
		const kwBase = paramTrigKw[1].toLowerCase();
		const kwN = parseInt(paramTrigKw[2], 10);
		const spec = getKeywordSpec(kwBase);
		if (
			kwN >= 1 &&
			spec &&
			spec.status === 'implemented' &&
			spec.implementation?.kind === 'trigger'
		) {
			const rts = spec.implementation.buildTriggers({ name: kwBase, n: kwN }, 0, zeroSpan);
			if (rts.length > 0 && rts.every((rt) => rt.effectSupported && Boolean(rt.effect))) {
				return rts.map((rt) =>
					continuous(
						'6',
						affected,
						{
							k: 'grantAbility',
							ability: {
								kind: 'triggered',
								trigger: rt.trigger,
								...(rt.condition ? { condition: rt.condition } : {}),
								targets: rt.effect!.targets,
								effect: rt.effect!.steps,
								...(rt.effect!.modal ? { modal: rt.effect!.modal } : {}),
								text: `${spec.displayLabel ?? kwBase} ${kwN}`,
								span: zeroSpan
							}
						},
						condition
					)
				);
			}
		}
	}
	return null;
}

function parseParameterizedKeywordList(
	raw: string,
	affected: Affected,
	condition: Condition | undefined,
	_depth: number
): StaticItem[] | null {
	const single = parseSingleParamKeywordGrant(raw, affected, condition);
	if (single) return single;
	const parts = raw
		.trim()
		.split(/,\s*and\s+|\s+and\s+|,\s*/)
		.map((x) => x.trim())
		.filter(Boolean);
	if (parts.length < 2 || parts.length > 6) return null;
	const regularKws: string[] = [];
	const grantedItems: StaticItem[] = [];
	for (const part of parts) {
		const kws = parseKeywordList(part);
		if (kws) {
			regularKws.push(...kws);
			continue;
		}
		const param = parseSingleParamKeywordGrant(part, affected, condition);
		if (param) {
			grantedItems.push(...param);
			continue;
		}
		return null;
	}
	if (grantedItems.length === 0) return null;
	const out: StaticItem[] = [];
	if (regularKws.length > 0) out.push(keywordGrant(affected, regularKws, condition));
	out.push(...grantedItems);
	return out;
}

function parseHasGrantTail(
	affected: Affected,
	hasBodyRaw: string,
	condition: Condition | undefined,
	depth: number
): StaticItem[] | null {
	const hasBody = hasBodyRaw.trim();
	if (/^protection from the chosen color$/i.test(hasBody)) {
		return [continuous('6', affected, { k: 'protectionFromChosenColor' }, condition)];
	}
	if (/^protection from the chosen player$/i.test(hasBody)) {
		return [continuous('6', affected, { k: 'protectionFromChosenPlayer' }, condition)];
	}
	// --- Track P22a: protectionFromChosenCardType & dynamicWardMana ---
	if (/^protection from the chosen (?:card )?type$/i.test(hasBody)) {
		return [continuous('6', affected, { k: 'protectionFromChosenCardType' }, condition)];
	}
	const dynWard = hasBody.match(/^ward \{X\},?\s+where X is (.+)$/i);
	if (dynWard) {
		const generic = parseCountAmount(dynWard[1]);
		if (generic) {
			return [
				{
					kind: 'static',
					static: {
						k: 'dynamicWardMana',
						affected,
						generic,
						...(condition ? { condition } : {})
					}
				}
			];
		}
	}
	// --- End Track P22a ---
	const singleQuoted = hasBody.match(/^(?:"([^"]+)"|'([^']+)')$/);
	if (singleQuoted) {
		const abilities = parseGrantedAbilities(singleQuoted[1] ?? singleQuoted[2], depth);
		return abilities
			? abilities.map((ability) => continuous('6', affected, { k: 'grantAbility', ability }, condition))
			: null;
	}
	const twoQuoted = hasBody.match(
		/^(?:"([^"]+)"|'([^']+)')(?:,\s*and|\s+and)(?: (?:has|have))? (?:"([^"]+)"|'([^']+)')$/i
	);
	if (twoQuoted) {
		const a1 = parseGrantedAbilities(twoQuoted[1] ?? twoQuoted[2], depth);
		const a2 = parseGrantedAbilities(twoQuoted[3] ?? twoQuoted[4], depth);
		if (!a1 || !a2) return null;
		return [...a1, ...a2].map((ability) =>
			continuous('6', affected, { k: 'grantAbility', ability }, condition)
		);
	}
	const kwAndQuoted = hasBody.match(/^([^"]+?)(?:,\s*and|\s+and)(?: (?:has|have))? (?:"([^"]+)"|'([^']+)')$/i);
	if (kwAndQuoted) {
		const kws = parseKeywordList(kwAndQuoted[1]);
		const paramMix = !kws
			? parseParameterizedKeywordList(kwAndQuoted[1], affected, condition, depth)
			: null;
		const abilities = parseGrantedAbilities(kwAndQuoted[2] ?? kwAndQuoted[3], depth);
		if ((kws || paramMix) && abilities) {
			return [
				...(kws ? [keywordGrant(affected, kws, condition)] : paramMix!),
				...abilities.map((ability) =>
					continuous('6', affected, { k: 'grantAbility', ability }, condition)
				)
			];
		}
	}
	const quotedAndKw = hasBody.match(/^(?:"([^"]+)"|'([^']+)')(?:,\s*and|\s+and)(?: (?:has|have))? ([^"]+)$/i);
	if (quotedAndKw) {
		const abilities = parseGrantedAbilities(quotedAndKw[1] ?? quotedAndKw[2], depth);
		const kws = parseKeywordList(quotedAndKw[3]);
		if (abilities && kws) {
			return [
				...abilities.map((ability) =>
					continuous('6', affected, { k: 'grantAbility', ability }, condition)
				),
				keywordGrant(affected, kws, condition)
			];
		}
	}
	const kwsDirect = parseKeywordList(hasBody);
	if (kwsDirect) return [keywordGrant(affected, kwsDirect, condition)];
	// --- Track P17a: Parameterized keyword abilities granted via Layer 6 grantAbility (crew N, saddle N, equip <cost>, annihilator/bushido/afterlife/soulshift/frenzy/poisonous N) ---
	const paramGrants = parseParameterizedKeywordList(hasBody, affected, condition, depth);
	if (paramGrants) return paramGrants;
	// --- End Track P17a ---
	const { modifierPart, tailPart } = splitPtModifierAndTail(hasBody);
	if (tailPart && modifierPart.trim()) {
		const headHas = parseHasGrantTail(affected, modifierPart, condition, depth);
		const tailItems = parseInlineStaticTail(affected, tailPart, condition, depth);
		if (headHas && tailItems) {
			return [...headHas, ...tailItems];
		}
	}
	return null;
}

// --- End Track P11 ---

/**
 * Anthems, lords and attached grants: "Other Elf creatures you control get +1/+1.", "Equipped
 * creature gets +1/+1 and has trample and lifelink.", "Creatures you control have flying.",
 * "~ gets +1/+0 for each artifact you control.", 'Lands you control have "{T}: Add one mana of any color."'
 */
function grants(condition?: Condition, depth = 0): Production {
	const inner: Production = (s, span) => {
		const selfAndOther = s.match(/^~ and (other .+?) ((?:get|have)\b[\s\S]+)$/i);
		if (selfAndOther) {
			const otherAff = parseAffected(selfAndOther[1]);
			if (otherAff && typeof otherAff === 'object') {
				const verbRest = selfAndOther[2];
				const selfVerbRest = verbRest
					.replace(/^get\b/i, 'gets')
					.replace(/^have\b/i, 'has');
				const selfItems = inner(`~ ${selfVerbRest}`, span);
				const otherItems = inner(`${selfAndOther[1]} ${verbRest}`, span);
				if (selfItems && otherItems) {
					return [...selfItems, ...otherItems];
				}
			}
		}
		// --- Track P11: Dynamic Layer 7b base P/T & generalized Layer 7c / Layer 6 grants ---
		const basePtX = s.match(
			/^([^"]+?)\s+(?:has|have) base power and (?:base )?toughness X\/X,?\s+where X is (.+)$/i
		);
		if (basePtX) {
			const affected = parseAffected(basePtX[1]);
			const xAmt = parseCountAmount(basePtX[2]);
			if (affected && xAmt) {
				return [continuous('7b', affected, { k: 'setBasePT', power: xAmt, toughness: xAmt }, condition)];
			}
		}
		const basePtEqual = s.match(
			/^([^"]+?)\s+(?:has|have) base power and (?:base )?toughness each equal to (.+)$/i
		);
		if (basePtEqual) {
			const affected = parseAffected(basePtEqual[1]);
			const amt = parseCountAmount(basePtEqual[2]);
			if (affected && amt) {
				return [continuous('7b', affected, { k: 'setBasePT', power: amt, toughness: amt }, condition)];
			}
		}
		const basePtFixed = s.match(
			/^([^"]+?)\s+(?:has|have) base power and (?:base )?toughness (\d+)\/(\d+)([\s\S]*)$/i
		);
		if (basePtFixed) {
			const { modifierPart, tailPart } = splitPtModifierAndTail(basePtFixed[4]);
			const bareKwTailMatch =
				!tailPart && modifierPart.trim() !== ''
					? modifierPart.match(/^(?:,\s*and\s+|,\s*|\s+and\s+)([\s\S]+)$/i)
					: null;
			if (modifierPart.trim() === '' || bareKwTailMatch) {
				const affected = parseAffected(basePtFixed[1]);
				if (affected) {
					const out: StaticItem[] = [
						continuous(
							'7b',
							affected,
							{
								k: 'setBasePT',
								power: n(parseInt(basePtFixed[2], 10)),
								toughness: n(parseInt(basePtFixed[3], 10))
							},
							condition
						)
					];
					if (bareKwTailMatch) {
						const bareGrants = parseHasGrantTail(
							affected,
							bareKwTailMatch[1].trim(),
							condition,
							depth
						);
						if (!bareGrants) return null;
						out.push(...bareGrants);
					} else if (tailPart) {
						const tailItems = parseInlineStaticTail(affected, tailPart, condition, depth);
						if (tailItems) {
							out.push(...tailItems);
						} else {
							const kws = parseKeywordList(tailPart);
							if (!kws) return null;
							out.push(keywordGrant(affected, kws, condition));
						}
					}
					return out;
				}
			}
		}
		// --- Track P14: Single-axis Layer 7b base power / toughness (e.g. Maha, Its Feathers Night) ---
		const baseSingleAxis = s.match(
			/^([^"]+?)\s+(?:has|have) base (power|toughness) (\d+)([\s\S]*)$/i
		);
		if (baseSingleAxis) {
			const { modifierPart, tailPart } = splitPtModifierAndTail(baseSingleAxis[4]);
			if (modifierPart.trim() === '') {
				const affected = parseAffected(baseSingleAxis[1]);
				if (affected) {
					const val = n(parseInt(baseSingleAxis[3], 10));
					const mod: LayerMod =
						baseSingleAxis[2].toLowerCase() === 'power'
							? { k: 'setBasePower', power: val }
							: { k: 'setBaseToughness', toughness: val };
					const out: StaticItem[] = [continuous('7b', affected, mod, condition)];
					if (tailPart) {
						const tailItems = parseInlineStaticTail(affected, tailPart, condition, depth);
						if (tailItems) {
							out.push(...tailItems);
						} else {
							const kws = parseKeywordList(tailPart);
							if (!kws) return null;
							out.push(keywordGrant(affected, kws, condition));
						}
					}
					return out;
				}
			}
		}
		// --- End Track P14 ---

		const pt = s.match(/^([^"]+?)\s+gets? (?:an additional )?([+−-])(\d+|X)\/([+−-])(\d+|X)([\s\S]*)$/i);
		if (pt) {
			const affected = parseAffected(pt[1]);
			if (!affected) return null;
			const pSign = pt[2] === '+' ? 1 : -1;
			const pTok = pt[3].toUpperCase();
			const tSign = pt[4] === '+' ? 1 : -1;
			const tTok = pt[5].toUpperCase();
			const { modifierPart, tailPart } = splitPtModifierAndTail(pt[6]);
			const modTrimmed = modifierPart.trim();

			let power: Amount | null = null;
			let toughness: Amount | null = null;

			if (pTok === 'X' || tTok === 'X') {
				const whereMatch = modTrimmed.match(/^,?\s*where X is (.+)$/i);
				if (!whereMatch) return null;
				const xAmt = parseCountAmount(whereMatch[1]);
				if (!xAmt) return null;
				power = pTok === 'X' ? scaleAmount(pSign, xAmt) : n(pSign * parseInt(pTok, 10));
				toughness = tTok === 'X' ? scaleAmount(tSign, xAmt) : n(tSign * parseInt(tTok, 10));
			} else {
				const d0 = pSign * parseInt(pTok, 10);
				const d1 = tSign * parseInt(tTok, 10);
				if (modTrimmed === '') {
					power = n(d0);
					toughness = n(d1);
				} else {
					const forEach = modTrimmed.match(/^for each (.+)$/i);
					if (!forEach) return null;
					const forEachBody = forEach[1].trim();
					// --- Track P14: "for each of its colors" / "for each opponent you have" ---
					let per: Amount | null = null;
					if (/^of its colors$/i.test(forEachBody)) {
						per = {
							k: 'colorsOfObject',
							of: affected === 'self' || affected === 'attachedTo' ? affected : 'affected'
						};
					} else if (/^of ~'s colors$/i.test(forEachBody)) {
						per = { k: 'colorsOfObject', of: 'self' };
					} else if (
						/^of (?:enchanted|equipped) (?:creature|permanent)'s colors$/i.test(forEachBody)
					) {
						per = { k: 'colorsOfObject', of: 'attachedTo' };
					} else if (/^opponent you have$/i.test(forEachBody)) {
						per = { k: 'opponentCount' };
					} else {
						per = parseCountAmount(`the number of ${forEachBody}`);
					}
					// --- End Track P14 ---
					if (!per) return null;
					power = scaleAmount(d0, per);
					toughness = scaleAmount(d1, per);
				}
			}

			const items: StaticItem[] = [continuous('7c', affected, { k: 'pt', power, toughness }, condition)];
			if (tailPart) {
				const tailItems = parseInlineStaticTail(affected, tailPart, condition, depth);
				if (!tailItems) return null;
				items.push(...tailItems);
			}
			return items;
		}

		const hasAny = s.match(/^([^"]+?)\s+(?:has|have) (.+)$/);
		if (hasAny) {
			const affected = parseAffected(hasAny[1]);
			if (!affected) return null;
			return parseHasGrantTail(affected, hasAny[2], condition, depth);
		}
		// --- End Track P11 ---
		return null;
	};
	return inner;
}

// ---- Entry point ----------------------------------------------------------------------------

const EMINENCE = /^As long as ~ is in the command zone or on the battlefield, /;
const AS_LONG_AS_PREFIX = /^As long as ([^,]+), /i;
const AS_LONG_AS_SUFFIX = /(?<!\bfor) as long as (.+)$/i;

/** Attaches a condition to items whose StaticDef supports one. Returns false if any can't take it. */
function withCondition(items: StaticItem[], condition: Condition): boolean {
	const combine = (prev: Condition | undefined, next: Condition): Condition =>
		prev ? { k: 'and', of: [prev, next] } : next;
	for (const item of items) {
		if (item.kind === 'replacement') {
			item.replacement.condition = combine(item.replacement.condition, condition);
		} else {
			if (item.static.k === 'commanderDesignation' || item.static.k === 'deckCopyLimit') {
				return false;
			}
			item.static.condition = combine(item.static.condition, condition);
		}
	}
	return true;
}

function parseObjectStateWord(
	of: 'self' | 'attachedTo',
	word: string
): Condition | null {
	const low = word.trim().toLowerCase();
	switch (low) {
		case 'tapped':
			return { k: 'objectState', of, tapped: true };
		case 'untapped':
			return { k: 'objectState', of, tapped: false };
		case 'attacking':
			return { k: 'objectState', of, attacking: true };
		case 'blocking':
			return { k: 'objectState', of, blocking: true };
		case 'equipped':
			return { k: 'objectState', of, equipped: true };
		case 'enchanted':
			return { k: 'objectState', of, enchanted: true };
		case 'monstrous':
			return of === 'self' ? { k: 'monstrous' } : { k: 'objectState', of, monstrous: true };
		case 'saddled':
			return of === 'self' ? { k: 'saddled' } : { k: 'objectState', of, saddled: true };
		default:
			return null;
	}
}

function parseStaticCondition(
	clause: string,
	defaultSubject: 'self' | 'attachedTo' = 'self'
): Condition | null {
	const t = clause.trim();

	// --- Track P22a: Above-starting-life, attacking-alone, hasn't-dealt-damage, & entered-under-your-control conditions ---
	const lifeAboveStart = t.match(
		/^you have at least (\S+) life more than your starting life total$/i
	);
	if (lifeAboveStart) {
		const cnt = count(lifeAboveStart[1]);
		if (cnt && cnt.k === 'const' && cnt.n >= 1) {
			return { k: 'lifeAtLeastAboveStarting', delta: cnt.n };
		}
	}
	const atkAlone = t.match(
		/^(~|it|(?:enchanted|equipped) (?:creature|permanent))(?:'s| is) attacking alone$/i
	);
	if (atkAlone) {
		const rawWho = atkAlone[1].toLowerCase();
		const of: 'self' | 'attachedTo' =
			rawWho === '~' ? 'self' : rawWho === 'it' ? defaultSubject : 'attachedTo';
		return { k: 'isAttackingAlone', of };
	}
	const notDealtDmg = t.match(
		/^(~|it|(?:enchanted|equipped) (?:creature|permanent)) hasn't dealt damage(?: yet)?$/i
	);
	if (notDealtDmg) {
		const rawWho = notDealtDmg[1].toLowerCase();
		const of: 'self' | 'attachedTo' =
			rawWho === '~' ? 'self' : rawWho === 'it' ? defaultSubject : 'attachedTo';
		return { k: 'hasntDealtDamageYet', of };
	}
	const enteredCtrlTurn = t.match(
		/^(?:a|an|another) (.+?) entered(?: the battlefield)? under your control this turn$/i
	);
	if (enteredCtrlTurn) {
		const isAnother = /^another\b/i.test(t);
		const f = parseObjectPhraseWithQualifiers(enteredCtrlTurn[1], true);
		if (f && !f.controller) {
			return {
				k: 'enteredBattlefieldUnderYourControlThisTurn',
				filter: isAnother ? { ...f, other: true } : f
			};
		}
	}
	// --- End Track P22a ---

	// --- Track P20a: Half-starting-life, most-common-color, & empty-library conditions ---
	const mapHalfOp = (
		phrase: string
	): '<=' | '<' | '>=' | '>' => {
		const p = phrase.toLowerCase();
		if (p === 'less than or equal to' || p === 'less') return '<=';
		if (p === 'less than') return '<';
		if (p === 'greater than or equal to' || p === 'more') return '>=';
		return '>';
	};
	const youHalfLife = t.match(
		/^(?:your life total is (less than or equal to|less than|greater than or equal to|greater than) half your starting life total|you have (less than or equal to|less than|greater than or equal to|greater than) half your starting life total|you have half your starting life total or (less|more))$/i
	);
	if (youHalfLife) {
		const opRaw = youHalfLife[1] ?? youHalfLife[2] ?? youHalfLife[3];
		return { k: 'lifeCompareHalfStarting', who: 'you', op: mapHalfOp(opRaw) };
	}
	const oppHalfLife = t.match(
		/^(?:an opponent's life total is (less than or equal to|less than|greater than or equal to|greater than) half their starting life total|an opponent has (less than or equal to|less than|greater than or equal to|greater than) half their starting life total|an opponent has half their starting life total or (less|more))$/i
	);
	if (oppHalfLife) {
		const opRaw = oppHalfLife[1] ?? oppHalfLife[2] ?? oppHalfLife[3];
		return { k: 'lifeCompareHalfStarting', who: 'anyOpponent', op: mapHalfOp(opRaw) };
	}
	const mostCommonCol = t.match(
		/^(white|blue|black|red|green) is the most common color among all permanents( or is tied for most common)?$/i
	);
	if (mostCommonCol) {
		return {
			k: 'mostCommonColorAmongPermanents',
			color: COLORS[mostCommonCol[1].toLowerCase()],
			allowTie: Boolean(mostCommonCol[2])
		};
	}
	if (/^(?:there are no cards in your library|you have no cards in your library)$/i.test(t)) {
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'library', of: { k: 'you' } },
			op: '=',
			right: n(0)
		};
	}
	// --- End Track P20a ---

	// --- Track P17a: Day/Night, Soulbond paired, Monarch, Dungeon/Initiative/Blessing/MaxSpeed/Corrupted, & battlefield presence ---
	if (/^it's day$/i.test(t)) return { k: 'isDay' };
	if (/^it's night$/i.test(t)) return { k: 'isNight' };
	if (/^(?:~ is|it is|it's) paired with another creature$/i.test(t)) return { k: 'isPaired' };
	if (/^(?:~|it|he|she) entered(?: the battlefield)? this turn$/i.test(t)) {
		return { k: 'objectState', of: 'self', filter: { enteredThisTurn: true } };
	}
	if (/^(?:~|it|he|she) attacked this turn$/i.test(t)) {
		return { k: 'boastAttackedThisTurn' };
	}
	if (/^(?:~|it) is renowned$/i.test(t)) return { k: 'isRenowned' };
	if (/^(?:~|it) is prepared$/i.test(t)) return { k: 'selfPrepared' };
	if (/^~ is attached to a creature$/i.test(t)) {
		return { k: 'objectState', of: 'attachedTo', filter: { types: ['Creature'] } };
	}
	if (/^you have a full party$/i.test(t)) {
		return { k: 'compare', left: { k: 'partyCount', player: { k: 'you' } }, op: '>=', right: n(4) };
	}
	if (/^you control a permanent of each color$/i.test(t)) {
		return { k: 'colorsAmongControlledPermanents', min: 5 };
	}
	if (/^a player has no cards in hand$/i.test(t)) {
		return {
			k: 'or',
			of: [
				{ k: 'compare', left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } }, op: '=', right: n(0) },
				{ k: 'anyOpponentMetric', metric: 'hand', op: '=', count: 0 }
			]
		};
	}
	const speedAtLeast = t.match(/^your speed is (\S+) or (?:higher|greater|more)$/i);
	if (speedAtLeast) {
		const cnt = count(speedAtLeast[1]);
		if (cnt && cnt.k === 'const' && cnt.n >= 1) {
			return {
				k: 'compare',
				left: { k: 'playerSpeed', player: { k: 'you' } },
				op: '>=',
				right: cnt
			};
		}
	}
	const celebrationM = t.match(
		/^(\S+) or more nonland permanents entered(?: the battlefield)? under your control this turn$/i
	);
	if (celebrationM) {
		const cnt = count(celebrationM[1]);
		if (cnt && cnt.k === 'const' && cnt.n >= 1) {
			return { k: 'nonlandEnteredThisTurn', min: cnt.n };
		}
	}
	const enchantedByAuras = t.match(/^~ is enchanted by (exactly )?(\S+)( or more)? Auras?$/i);
	if (enchantedByAuras) {
		const cnt = count(enchantedByAuras[2]);
		if (cnt && cnt.k === 'const' && cnt.n >= 1) {
			const op = enchantedByAuras[3] ? '>=' : '=';
			return {
				k: 'compare',
				left: { k: 'attachmentsOn', target: 'self', filter: { subtypes: ['Aura'] } },
				op,
				right: cnt
			};
		}
	}
	if (/^you(?:'ve| have) completed a dungeon$/i.test(t)) return { k: 'hasCompletedDungeon' };
	if (/^you have the initiative$/i.test(t)) return { k: 'hasInitiative' };
	if (/^you have the city's blessing$/i.test(t)) return { k: 'hasCitysBlessing' };
	if (/^you have max speed$/i.test(t)) return { k: 'hasMaxSpeed' };
	if (/^you(?:'re| are) the monarch$/i.test(t)) return { k: 'isMonarch', relation: 'you' };
	if (/^an opponent is poisoned$/i.test(t)) return { k: 'opponentPoisonAtLeast', min: 1 };
	const oppPoison = t.match(/^an opponent has (\S+) or more poison counters$/i);
	if (oppPoison) {
		const cnt = count(oppPoison[1]);
		if (cnt && cnt.k === 'const' && cnt.n >= 1) {
			return { k: 'opponentPoisonAtLeast', min: cnt.n };
		}
	}
	const noOppCtrl = t.match(
		/^(?:no opponent controls (?:a |an )?|your opponents control no )(.+)$/i
	);
	if (noOppCtrl) {
		const f = parseObjectPhrase(noOppCtrl[1], { allowPluralAndDisjunction: true });
		if (f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'opponent' } },
				op: '=',
				right: n(0)
			};
		}
	}
	const youCtrlNo = t.match(/^you control no (.+)$/i);
	if (youCtrlNo) {
		const f = parseObjectPhrase(youCtrlNo[1], { allowPluralAndDisjunction: true });
		if (f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'you' } },
				op: '=',
				right: n(0)
			};
		}
	}
	const onBfCond = t.match(
		/^there (?:is|are) (?:(?:a|an)|(\S+)(?: or more)?) (.+?) on the battlefield$/i
	);
	if (onBfCond) {
		const cnt = onBfCond[1] ? count(onBfCond[1]) : n(1);
		const f = parseObjectPhrase(onBfCond[2], { allowPluralAndDisjunction: true });
		if (cnt && cnt.k === 'const' && f) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield' } },
				op: '>=',
				right: cnt
			};
		}
	}
	// --- End Track P17a ---

	// --- Track P14: Check explicit self/attached state & controller predicates before `parseCondition` ---
	const youCtrlAtt = t.match(
		/^you control (?:(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)|(it))$/i
	);
	if (youCtrlAtt && (!youCtrlAtt[1] || defaultSubject === 'attachedTo')) {
		return { k: 'objectState', of: 'attachedTo', filter: { controller: 'you' } };
	}
	const oppCtrlAtt = t.match(
		/^(?:(?:an opponent|another player) controls|you don't control) (?:(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)|(it))$/i
	);
	if (oppCtrlAtt && (!oppCtrlAtt[1] || defaultSubject === 'attachedTo')) {
		return { k: 'objectState', of: 'attachedTo', filter: { controller: 'opponent' } };
	}

	const pronounState = t.match(/^(?:(~|it) (is|isn't|is not)|(it's)) (.+)$/i);
	if (pronounState && !/^it's (?:your|not your) turn$/i.test(t)) {
		const isSelfTilde = pronounState[1] === '~';
		const isNeg = Boolean(pronounState[2] && /^(?:isn't|is not)$/i.test(pronounState[2]));
		const rhs = pronounState[4].trim();
		const subjOf: 'self' | 'attachedTo' = isSelfTilde ? 'self' : defaultSubject;
		const stWord = parseObjectStateWord(subjOf, rhs);
		if (stWord) {
			return isNeg ? { k: 'not', of: stWord } : stWord;
		}
		const qual = rhs.replace(/^(?:a|an)\s+/i, '');
		const filter =
			parseObjectPhrase(qual, { allowPluralAndDisjunction: true }) ??
			parseObjectPhrase(`${qual} permanent`);
		if (filter) {
			const objCond: Condition = { k: 'objectState', of: subjOf, filter };
			return isNeg ? { k: 'not', of: objCond } : objCond;
		}
	}
	// --- End Track P14 ---

	const cond = parseCondition(`if ${t}`);
	if (cond && cond.k !== 'matchesFilter') return cond;

	const twoColor = t.match(
		/^you control (?:a|an) (white|blue|black|red|green) or (white|blue|black|red|green) permanent$/i
	);
	if (twoColor) {
		return {
			k: 'compare',
			left: {
				k: 'count',
				of: {
					colors: [COLORS[twoColor[1].toLowerCase()], COLORS[twoColor[2].toLowerCase()]],
					controller: 'you'
				}
			},
			op: '>=',
			right: n(1)
		};
	}

	// Threshold: "seven or more cards are in your graveyard" / "there are seven or more cards in your graveyard"
	const gyCards = t.match(/^(?:there are )?(\S+) or more cards(?: are)? in your graveyard$/i);
	if (gyCards) {
		const cnt = count(gyCards[1]);
		if (cnt && cnt.k === 'const') {
			return {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } },
				op: '>=',
				right: cnt
			};
		}
	}

	// Delirium: "there are four or more card types among cards in your graveyard"
	const delirium = t.match(/^(?:there are )?(\S+) or more card types(?: are)? among cards in your graveyard$/i);
	if (delirium) {
		const cnt = count(delirium[1]);
		if (cnt && cnt.k === 'const') {
			return {
				k: 'compare',
				left: { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' },
				op: '>=',
				right: cnt
			};
		}
	}

	// Spell mastery / Descend: "there are two or more instant and/or sorcery cards in your graveyard"
	const gyTyped = t.match(/^(?:there are )?(\S+) or more (.+?) cards(?: are)? in your graveyard$/i);
	if (gyTyped) {
		const cnt = count(gyTyped[1]);
		const f = parseGraveyardCardFilter(gyTyped[2]);
		if (cnt && cnt.k === 'const' && f) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } },
				op: '>=',
				right: cnt
			};
		}
	}

	// Coven: "you control three or more creatures with different powers"
	const coven = t.match(/^you control (\S+) or more creatures with different powers$/i);
	if (coven) {
		const cnt = count(coven[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'distinctControlledCreaturePowers', count: cnt.n };
		}
	}

	// Fateful hour / Life thresholds
	const lifeOrLess = t.match(/^you have (\S+) or less life$/i);
	if (lifeOrLess) {
		const cnt = count(lifeOrLess[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'compare', left: { k: 'life', of: { k: 'you' } }, op: '<=', right: cnt };
		}
	}
	const anyPlayerLife = t.match(/^a player has (\S+) or less life$/i);
	if (anyPlayerLife) {
		const cnt = count(anyPlayerLife[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'anyPlayerLife', op: '<=', count: cnt.n };
		}
	}

	// Counter presence: "~ / it / enchanted creature / equipped creature has a/+1/+1/divinity/N or more ... counter(s) on it"
	const hasCounters = t.match(
		/^(~|it|(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)) has (\S+)(?: or more)? (.+?) counters? on (?:~|it)$/i
	);
	if (hasCounters) {
		const cnt = count(hasCounters[2]);
		const ctr = lookupStaticCounter(hasCounters[3]);
		if (cnt && cnt.k === 'const' && ctr) {
			const ofTarget =
				hasCounters[1] === '~' || /^it$/i.test(hasCounters[1])
					? ({ k: 'self' } as const)
					: ({ k: 'affected' } as const);
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: ctr, of: ofTarget },
				op: '>=',
				right: cnt
			};
		}
	}

	// Self state: "~ is tapped / untapped / equipped / enchanted / attacking / blocking / monstrous / saddled"
	const selfState = t.match(/^(?:(?:~|it) is|it's) ([a-z]+)$/i);
	if (selfState) {
		const st = parseObjectStateWord('self', selfState[1]);
		if (st) return st;
	}

	// Attached state: "enchanted creature is/isn't tapped / white / a Human / ..."
	const attState = t.match(
		/^(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker) (is|isn't|is not) (.+)$/i
	);
	if (attState) {
		const isNeg = /^(?:isn't|is not)$/i.test(attState[1]);
		const st = parseObjectStateWord('attachedTo', attState[2]);
		if (st) return isNeg ? { k: 'not', of: st } : st;
		const qual = attState[2].trim().replace(/^(?:a|an)\s+/i, '');
		const filter =
			parseObjectPhrase(qual, { allowPluralAndDisjunction: true }) ??
			parseObjectPhrase(`${qual} permanent`);
		if (filter) {
			const objCond: Condition = { k: 'objectState', of: 'attachedTo', filter };
			return isNeg ? { k: 'not', of: objCond } : objCond;
		}
	}

	// --- Track P14: Devotion comparisons (CR 700.5a–b), opponent controls, & counter absence/presence ---
	const devLess = t.match(/^your devotion to (.+?) is less than (\S+)$/i);
	if (devLess) {
		const colors = parseDevotionColorList(devLess[1]);
		const cnt = count(devLess[2]);
		if (colors && cnt && cnt.k === 'const') {
			return {
				k: 'compare',
				left: { k: 'devotion', colors, player: { k: 'you' } },
				op: '<',
				right: cnt
			};
		}
	}
	const devAtLeast =
		t.match(/^your devotion to (.+?) is (\S+) or (?:more|greater)$/i) ??
		t.match(/^your devotion to (.+?) is at least (\S+)$/i);
	if (devAtLeast) {
		const colors = parseDevotionColorList(devAtLeast[1]);
		const cnt = count(devAtLeast[2]);
		if (colors && cnt && cnt.k === 'const') {
			return {
				k: 'compare',
				left: { k: 'devotion', colors, player: { k: 'you' } },
				op: '>=',
				right: cnt
			};
		}
	}
	const devAtMost = t.match(/^your devotion to (.+?) is (\S+) or (?:less|fewer)$/i);
	if (devAtMost) {
		const colors = parseDevotionColorList(devAtMost[1]);
		const cnt = count(devAtMost[2]);
		if (colors && cnt && cnt.k === 'const') {
			return {
				k: 'compare',
				left: { k: 'devotion', colors, player: { k: 'you' } },
				op: '<=',
				right: cnt
			};
		}
	}

	const oppControls = t.match(
		/^(?:an opponent controls|your opponents control) (?:(?:a|an)|(\S+)(?: or more)?) (.+)$/i
	);
	if (oppControls) {
		const cnt = oppControls[1] ? count(oppControls[1]) : n(1);
		const rawObj = oppControls[2].trim();
		const f =
			parseCombatObjectPhrase(rawObj) ??
			parseObjectPhrase(rawObj.replace(/\s+and\s+/gi, ' or '));
		if (cnt && cnt.k === 'const' && f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'opponent' } },
				op: '>=',
				right: cnt
			};
		}
	}

	const noCounters = t.match(
		/^(~|it|(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)) has no counters on (?:~|it)$/i
	);
	if (noCounters) {
		const ofTarget =
			noCounters[1] === '~' || /^it$/i.test(noCounters[1])
				? ({ k: 'self' } as const)
				: ({ k: 'affected' } as const);
		return {
			k: 'compare',
			left: { k: 'countersOn', counter: 'any', of: ofTarget },
			op: '=',
			right: n(0)
		};
	}
	const anyNOrMoreCounters = t.match(
		/^(~|it|(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)) has (\S+) or more counters on (?:~|it)$/i
	);
	if (anyNOrMoreCounters) {
		const cnt = count(anyNOrMoreCounters[2]);
		if (cnt && cnt.k === 'const' && cnt.n >= 1) {
			const ofTarget =
				anyNOrMoreCounters[1] === '~' || /^it$/i.test(anyNOrMoreCounters[1])
					? ({ k: 'self' } as const)
					: ({ k: 'affected' } as const);
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: 'any', of: ofTarget },
				op: '>=',
				right: cnt
			};
		}
	}
	const anyCounters = t.match(
		/^(~|it|(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)) has (?:a|one or more) counters? on (?:~|it)$/i
	);
	if (anyCounters) {
		const ofTarget =
			anyCounters[1] === '~' || /^it$/i.test(anyCounters[1])
				? ({ k: 'self' } as const)
				: ({ k: 'affected' } as const);
		return {
			k: 'compare',
			left: { k: 'countersOn', counter: 'any', of: ofTarget },
			op: '>=',
			right: n(1)
		};
	}
	const thereAreCtrs = t.match(
		/^there (?:is|are) (\S+)(?: or more)? (.+?) counters? on (~|it|(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker))$/i
	);
	if (thereAreCtrs) {
		const cnt = count(thereAreCtrs[1]);
		const ctr = lookupStaticCounter(thereAreCtrs[2]);
		if (cnt && cnt.k === 'const' && ctr) {
			const ofTarget =
				thereAreCtrs[3] === '~' || /^it$/i.test(thereAreCtrs[3])
					? ({ k: 'self' } as const)
					: ({ k: 'affected' } as const);
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: ctr, of: ofTarget },
				op: '>=',
				right: cnt
			};
		}
	}
	const thereAreNoCtrs = t.match(
		/^there are no (.+?) counters on (~|it|(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker))$/i
	);
	if (thereAreNoCtrs) {
		const ctr = lookupStaticCounter(thereAreNoCtrs[1]);
		if (ctr) {
			const ofTarget =
				thereAreNoCtrs[2] === '~' || /^it$/i.test(thereAreNoCtrs[2])
					? ({ k: 'self' } as const)
					: ({ k: 'affected' } as const);
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: ctr, of: ofTarget },
				op: '=',
				right: n(0)
			};
		}
	}

	const lifeOrMore = t.match(/^you have (\S+) or more life$/i);
	if (lifeOrMore) {
		const cnt = count(lifeOrMore[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'compare', left: { k: 'life', of: { k: 'you' } }, op: '>=', right: cnt };
		}
	}

	if (/^you have no cards in hand$/i.test(t)) {
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
			op: '=',
			right: n(0)
		};
	}
	const youHandCmp = t.match(/^you have (\S+) or (fewer|less|more) cards in hand$/i);
	if (youHandCmp) {
		const cnt = count(youHandCmp[1]);
		if (cnt && cnt.k === 'const') {
			const op = youHandCmp[2].toLowerCase() === 'more' ? '>=' : '<=';
			return {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
				op,
				right: cnt
			};
		}
	}
	if (/^an opponent has no cards in hand$/i.test(t)) {
		return { k: 'anyOpponentMetric', metric: 'hand', op: '=', count: 0 };
	}
	const oppHandCmp = t.match(/^an opponent has (\S+) or (fewer|less|more) cards in hand$/i);
	if (oppHandCmp) {
		const cnt = count(oppHandCmp[1]);
		if (cnt && cnt.k === 'const') {
			const op = oppHandCmp[2].toLowerCase() === 'more' ? '>=' : '<=';
			return { k: 'anyOpponentMetric', metric: 'hand', op, count: cnt.n };
		}
	}
	const oppLifeCmp = t.match(/^an opponent has (\S+) or (less|fewer|more) life$/i);
	if (oppLifeCmp) {
		const cnt = count(oppLifeCmp[1]);
		if (cnt && cnt.k === 'const') {
			const op = oppLifeCmp[2].toLowerCase() === 'more' ? '>=' : '<=';
			return { k: 'anyOpponentMetric', metric: 'life', op, count: cnt.n };
		}
	}
	const oppGyCmp = t.match(
		/^(?:an opponent has (\S+) or more cards in their graveyard|there are (\S+) or more cards in an opponent's graveyard)$/i
	);
	if (oppGyCmp) {
		const cnt = count(oppGyCmp[1] ?? oppGyCmp[2]);
		if (cnt && cnt.k === 'const') {
			return { k: 'anyOpponentMetric', metric: 'graveyard', op: '>=', count: cnt.n };
		}
	}

	const drawnTurn = t.match(/^you(?:'ve| have) drawn (\S+) or more cards this turn$/i);
	if (drawnTurn) {
		const cnt = count(drawnTurn[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'cardsDrawnThisTurnAtLeast', min: cnt.n };
		}
	}
	if (/^you(?:'ve| have) cast (?:a |one or more )?spells? this turn$/i.test(t)) {
		return { k: 'spellsCastThisTurnCount', min: 1 };
	}
	const castSpellsTurn = t.match(/^you(?:'ve| have) cast (\S+) or more spells this turn$/i);
	if (castSpellsTurn) {
		const cnt = count(castSpellsTurn[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'spellsCastThisTurnCount', min: cnt.n };
		}
	}
	const castFilteredTurn = t.match(
		/^you(?:'ve| have) cast (?:(a|an|one or more)|(\S+) or more) (.+?) spells? this turn$/i
	);
	if (castFilteredTurn) {
		const minAmt = castFilteredTurn[1] ? n(1) : count(castFilteredTurn[2]);
		const f = parseObjectPhraseWithQualifiers(
			`${castFilteredTurn[3].replace(/\s+and\s+/gi, ' or ')} card`,
			true
		);
		if (minAmt && minAmt.k === 'const' && f) {
			return { k: 'spellsCastThisTurnCount', min: minAmt.n, filter: f };
		}
	}

	const gySingleTyped = t.match(/^there is (?:a|an) (.+?) card in your graveyard$/i);
	if (gySingleTyped) {
		const f = parseGraveyardCardFilter(gySingleTyped[1]);
		if (f) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } },
				op: '>=',
				right: n(1)
			};
		}
	}
	const allGyCards = t.match(
		/^(?:there are )?(\S+) or more (?:(.+?) )?cards(?: total)?(?: are)? in all graveyards$/i
	);
	if (allGyCards) {
		const cnt = count(allGyCards[1]);
		if (cnt && cnt.k === 'const') {
			if (!allGyCards[2]) {
				return {
					k: 'compare',
					left: { k: 'count', of: { zone: 'graveyard' } },
					op: '>=',
					right: cnt
				};
			}
			const f = parseGraveyardCardFilter(allGyCards[2]);
			if (f) {
				return {
					k: 'compare',
					left: { k: 'count', of: { ...f, zone: 'graveyard' } },
					op: '>=',
					right: cnt
				};
			}
		}
	}
	const ctrlExactOne = t.match(/^you control (?:exactly one|only one) (.+)$/i);
	if (ctrlExactOne) {
		const f = parseObjectPhrase(ctrlExactOne[1], { allowPluralAndDisjunction: true });
		if (f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'you' } },
				op: '=',
				right: n(1)
			};
		}
	}
	const anyPlayerCtrl = t.match(/^(?:a|any) player controls (?:a |an )?(.+)$/i);
	if (anyPlayerCtrl) {
		const f = parseObjectPhrase(anyPlayerCtrl[1], { allowPluralAndDisjunction: true });
		if (f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield' } },
				op: '>=',
				right: n(1)
			};
		}
	}

	if (/\s+and\s+/i.test(t)) {
		const andParts = t.split(/\s+and\s+/i);
		if (andParts.length === 2) {
			const c1 = parseStaticCondition(andParts[0], defaultSubject);
			const c2 = parseStaticCondition(andParts[1], defaultSubject);
			if (c1 && c2) return { k: 'and', of: [c1, c2] };
		}
	}
	if (/\s+or\s+/i.test(t)) {
		const orParts = t.split(/\s+or\s+/i);
		if (orParts.length === 2) {
			const c1 = parseStaticCondition(orParts[0], defaultSubject);
			const c2 = parseStaticCondition(orParts[1], defaultSubject);
			if (c1 && c2) return { k: 'or', of: [c1, c2] };
		}
	}
	// --- End Track P14 ---

	return null;
}

function parseUnlessEtbCondition(clause: string): Condition | null {
	const t = clause.trim();
	const selfStatCmp = t.match(
		/^(?:its|~'s) (power|toughness) is (\d+) or (greater|more|less|fewer)$/i
	);
	if (selfStatCmp) {
		const stat = selfStatCmp[1].toLowerCase() === 'power' ? 'power' : 'toughness';
		const val = parseInt(selfStatCmp[2], 10);
		const op: '>=' | '<=' = /^(?:greater|more)$/i.test(selfStatCmp[3]) ? '>=' : '<=';
		return {
			k: 'objectState',
			of: 'self',
			filter: { [stat]: { op, value: n(val) } }
		};
	}
	// Fastlands: "you control two or fewer other lands"
	const orFewer = t.match(/^you control (\S+) or fewer (.+)$/i);
	if (orFewer) {
		const cnt = count(orFewer[1]);
		const filter = parseObjectPhrase(orFewer[2]);
		if (cnt && cnt.k === 'const' && filter && !filter.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...filter, controller: 'you' } },
				op: '<=',
				right: cnt
			};
		}
	}
	// Checklands: "you control a Plains or an Island" / "you control a Plains or Island"
	const checkLand = t.match(/^you control (?:a|an) ([A-Z][a-z]+) or (?:(?:a|an) )?([A-Z][a-z]+)$/i);
	if (checkLand) {
		const f = parseObjectPhrase(`${checkLand[1]} or ${checkLand[2]}`);
		if (f && f.subtypes && f.subtypes.length === 2) {
			return {
				k: 'compare',
				left: { k: 'count', of: { subtypes: f.subtypes, controller: 'you' } },
				op: '>=',
				right: n(1)
			};
		}
	}
	// Crowdlands: "you have two or more opponents"
	const opponents = t.match(/^you have (\S+) or more opponents$/i);
	if (opponents) {
		const cnt = count(opponents[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'opponentCount', op: '>=', count: cnt.n };
		}
	}
	// Town / multiplayer lands: "your opponents control eight or more lands"
	const oppControl = t.match(/^your opponents control (\S+) or more (.+)$/i);
	if (oppControl) {
		const cnt = count(oppControl[1]);
		const filter = parseObjectPhrase(oppControl[2]);
		if (cnt && cnt.k === 'const' && filter && !filter.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...filter, controller: 'opponent' } },
				op: '>=',
				right: cnt
			};
		}
	}
	return parseStaticCondition(t);
}

function parseSentence(sentence: string, span: Span, depth = 0): StaticItem[] | null {
	let s = sentence.replace(/’/g, "'").replace(/\.$/, '').trim();
	// Strip optional raw CR 207.2c ability-word prefix if caller bypassed normalize.ts
	const abilityWordPrefix = s.match(
		/^(?:Threshold|Metalcraft|Delirium|Ferocious|Formidable|Spell mastery|Coven|Fateful hour|Hellbent|Domain|Morbid|Raid|Revolt|Undergrowth|Chroma|Constellation|Lieutenant|Descend 4|Descend 8|Fathomless descent|Corrupted|Ascend|Max speed|Void|Celebration|Adamant|Valiant|Speed)\s*—\s*/i
	);
	if (abilityWordPrefix) {
		s = s.slice(abilityWordPrefix[0].length).trim();
	}
	if (/^if ~ is in your opening hand, you may begin the game with it on the battlefield$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'pregameAction', action: 'beginOnBattlefield' } }];
	}

	const eminence = s.match(EMINENCE);
	if (eminence) {
		const rest = s.slice(eminence[0].length);
		return costModifiers(['battlefield', 'command'])(rest.charAt(0).toUpperCase() + rest.slice(1), span);
	}

	// --- Track P14: CR 113.6b Graveyard Incarnation statics ("As long as ~ is in your graveyard [and ...], ...") ---
	const gyStatic = s.match(/^As long as ~ is in your graveyard(?: and (.+?))?,\s+(.+)$/i);
	if (gyStatic) {
		let extraCond: Condition | undefined;
		if (gyStatic[1]) {
			const parsedExtra = parseStaticCondition(gyStatic[1]);
			if (!parsedExtra) return null;
			extraCond = parsedExtra;
		}
		const restBody = gyStatic[2].charAt(0).toUpperCase() + gyStatic[2].slice(1);
		const subItems = parseSentence(restBody, span, depth);
		if (
			!subItems ||
			subItems.length === 0 ||
			!subItems.every(
				(it) =>
					it.kind === 'static' &&
					it.static.k === 'continuous' &&
					it.static.affected !== 'self' &&
					it.static.affected !== 'attachedTo'
			)
		) {
			return null;
		}
		for (const it of subItems) {
			if (it.kind === 'static' && it.static.k === 'continuous') {
				it.static.activeInZone = 'graveyard';
			}
		}
		if (extraCond && !withCondition(subItems, extraCond)) return null;
		return subItems;
	}
	// --- End Track P14 ---

	// Preserve exact multi-part ruleModifiers like "During your turn, your opponents can't cast spells"
	const directRule = ruleModifiers(s, span);
	if (directRule) return directRule;

	let condition: Condition | undefined;
	const addCond = (next: Condition) => {
		condition = condition ? { k: 'and', of: [condition, next] } : next;
	};

	const duringTurnPrefix = s.match(/^During your turn,\s+(.+)$/i);
	if (duringTurnPrefix) {
		addCond({ k: 'isTurnOf', player: { k: 'you' } });
		s = duringTurnPrefix[1].charAt(0).toUpperCase() + duringTurnPrefix[1].slice(1);
	} else {
		const duringOtherTurnPrefix = s.match(/^During turns other than yours,\s+(.+)$/i);
		if (duringOtherTurnPrefix) {
			addCond({ k: 'not', of: { k: 'isTurnOf', player: { k: 'you' } } });
			s = duringOtherTurnPrefix[1].charAt(0).toUpperCase() + duringOtherTurnPrefix[1].slice(1);
		} else {
			const duringTurnSuffix = s.match(/^(.+?)(?<!untap)\s+during your turn$/i);
			if (duringTurnSuffix && !/^you may play\b/i.test(duringTurnSuffix[1])) {
				addCond({ k: 'isTurnOf', player: { k: 'you' } });
				s = duringTurnSuffix[1];
			} else {
				const duringOtherTurnSuffix = s.match(/^(.+?)(?<!untap)\s+during turns other than yours$/i);
				if (duringOtherTurnSuffix) {
					addCond({ k: 'not', of: { k: 'isTurnOf', player: { k: 'you' } } });
					s = duringOtherTurnSuffix[1];
				}
			}
		}
	}

	// Guard AS_LONG_AS_SUFFIX so "as long as ..." inside quoted abilities is not stripped off the outer sentence
	// (contractions/possessives like `it's`, `can't`, `~'s`, `players'` are NOT quotes).
	const hasQuotes = /"|(?:^|\s)'/.test(s);
	const prefix = s.match(AS_LONG_AS_PREFIX);
	const suffix = !prefix && !hasQuotes ? s.match(AS_LONG_AS_SUFFIX) : null;
	if (prefix) {
		const prefixMentionsAttached =
			/\b(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)\b/i.test(
				prefix[1]
			);
		const cond = parseStaticCondition(
			prefix[1],
			prefixMentionsAttached ? 'attachedTo' : 'self'
		);
		if (!cond) return null;
		addCond(cond);
		s = s.slice(prefix[0].length);
		if (prefixMentionsAttached) {
			if (/^it's\b/i.test(s)) {
				s = `Enchanted permanent is${s.slice(4)}`;
			} else if (/^it\s+/i.test(s)) {
				s = `Enchanted permanent ${s.slice(3)}`;
			}
		}
		s = s.charAt(0).toUpperCase() + s.slice(1);
	} else if (suffix) {
		const suffixAttached =
			/^(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker|vehicle|plains|island|swamp|mountain|forest)\b/i.test(
				s
			);
		const cond = parseStaticCondition(suffix[1], suffixAttached ? 'attachedTo' : 'self');
		if (cond) {
			addCond(cond);
			s = s.slice(0, suffix.index);
			s = s.charAt(0).toUpperCase() + s.slice(1);
		}
	}

	const productions: Production[] = [
		replacements,
		// --- Track P14 ---
		damagePrevention,
		// --- End Track P14 ---
		multipliers,
		ruleModifiers,
		topOfLibraryAndGraveyardPlay,
		costModifiers(),
		cda,
		attachedTypeChange(depth),
		globalChanges,
		controlChange,
		combatAndActivationRules,
		restrictions(depth),
		keywordRemoval,
		grants(undefined, depth)
	];
	for (const p of productions) {
		const items = p(s, span);
		if (!items) continue;
		if (condition && !withCondition(items, condition)) return null;
		return items;
	}

	// --- Track P17a: Conditional "If <cond>, <rest>" fallback (e.g. Force of Negation, Snuff Out, conditional Flash/grants) ---
	const ifPrefix = !/\binstead$/i.test(s) ? s.match(/^If ([^,]+),\s+(.+)$/i) : null;
	if (ifPrefix && depth < 3) {
		const ifMentionsAttached =
			/\b(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)\b/i.test(
				ifPrefix[1]
			);
		const ifCond = parseStaticCondition(
			ifPrefix[1],
			ifMentionsAttached ? 'attachedTo' : 'self'
		);
		if (ifCond) {
			let restBody = ifPrefix[2].trim();
			if (ifMentionsAttached) {
				if (/^it's\b/i.test(restBody)) {
					restBody = `Enchanted permanent is${restBody.slice(4)}`;
				} else if (/^it\s+/i.test(restBody)) {
					restBody = `Enchanted permanent ${restBody.slice(3)}`;
				}
			}
			restBody = restBody.charAt(0).toUpperCase() + restBody.slice(1);
			const subItems = parseSentence(restBody, span, depth + 1);
			if (subItems && subItems.length > 0) {
				const mergedCond: Condition = condition
					? { k: 'and', of: [condition, ifCond] }
					: ifCond;
				if (withCondition(subItems, mergedCond)) return subItems;
			}
		}
	}
	// --- End Track P17a ---

	return null;
}

function parseStaticAbilityInner(text: string, offset = 0, depth = 0): StaticParse {
	const items: StaticItem[] = [];
	const unparsed: Span[] = [];
	const sentences = splitSentences(text, offset);
	const entersSelf: EventPattern = { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } };

	for (let idx = 0; idx < sentences.length; idx++) {
		const sentence = sentences[idx];
		const trimmed = sentence.text.replace(/’/g, "'").replace(/\.$/, '').trim();

		// --- Track P20a: Multi-sentence Conspiracy draft paragraphs & 3-sentence choose-land + shockland ---
		if (idx === 0 && isDraftOnlySentence(trimmed)) {
			items.push({ kind: 'static', static: { k: 'draftNoOp' } });
			break;
		}
		if (idx + 2 < sentences.length) {
			const next1 = sentences[idx + 1].text.replace(/’/g, "'").replace(/\.$/, '').trim();
			const next2 = sentences[idx + 2].text.replace(/’/g, "'").replace(/\.$/, '').trim();
			const chooseLandM = trimmed.match(
				/^As (?:~|it) enters(?: the battlefield)?, choose a (basic )?land type$/i
			);
			const thenPayM = next1.match(/^Then you may pay (\d+) life$/i);
			if (
				chooseLandM &&
				thenPayM &&
				/^If you don't, (?:it|~) enters(?: the battlefield)? tapped$/i.test(next2)
			) {
				const payLife = parseInt(thenPayM[1], 10);
				if (payLife > 0) {
					items.push(
						{
							kind: 'replacement',
							replacement: {
								replaces: entersSelf,
								with: {
									k: 'modify',
									chooseSubType: chooseLandM[1] ? 'basicLand' : 'land'
								},
								selfReplacement: true
							}
						},
						{
							kind: 'replacement',
							replacement: {
								replaces: entersSelf,
								with: { k: 'modify', payLifeOrEnterTapped: payLife },
								selfReplacement: true
							}
						}
					);
					idx += 2;
					continue;
				}
			}
		}
		// --- End Track P20a ---

		// --- Track P8: Two-sentence Shocklands & Reveal Lands (CR 614.12, 119.4, 119.8) ---
		if (idx + 1 < sentences.length) {
			const nextTrimmed = sentences[idx + 1].text.replace(/’/g, "'").replace(/\.$/, '').trim();
			// --- Track P22a: Commander pre-game color choice, Graveyard Escape/Scavenge/Unearth grants, & Hand Foretell grants ---
			if (
				/^If ~ is your commander, choose a color before the game begins$/i.test(trimmed) &&
				/^~ is the chosen color$/i.test(nextTrimmed)
			) {
				items.push(
					{ kind: 'static', static: { k: 'commanderPreGameColorChoice' } },
					continuous('5', 'self', { k: 'setChosenColor' })
				);
				idx += 1;
				continue;
			}
			const gyEscapeHead = trimmed.match(
				/^Each (.+?) card in your graveyard has escape$/i
			);
			const gyEscapeTail = nextTrimmed.match(
				/^The escape cost is equal to (?:the card's|its) mana cost plus exile (\S+) other cards? from your graveyard$/i
			);
			if (gyEscapeHead && gyEscapeTail) {
				const filter = parseGraveyardCardFilter(gyEscapeHead[1]);
				const exAmt = count(gyEscapeTail[1]);
				if (filter && exAmt && exAmt.k === 'const' && exAmt.n >= 1) {
					items.push({
						kind: 'static',
						static: { k: 'grantGraveyardEscape', filter, exileCount: exAmt.n }
					});
					idx += 1;
					continue;
				}
			}
			const gyKwHead = trimmed.match(
				/^Each (.+?) card in your graveyard has (scavenge|unearth)$/i
			);
			const gyKwTail = nextTrimmed.match(
				/^The (scavenge|unearth) cost is equal to (?:the card's|its) mana cost$/i
			);
			if (gyKwHead && gyKwTail && gyKwHead[2].toLowerCase() === gyKwTail[1].toLowerCase()) {
				const filter = parseGraveyardCardFilter(gyKwHead[1]);
				if (filter) {
					const keyword = gyKwHead[2].toLowerCase() as 'scavenge' | 'unearth';
					items.push({
						kind: 'static',
						static: { k: 'grantGraveyardKeywordAbility', keyword, filter }
					});
					idx += 1;
					continue;
				}
			}
			const handForetellHead = trimmed.match(
				/^Each (?:(.+?) )?card in your hand(?: without foretell)? has foretell$/i
			);
			const handForetellTail = nextTrimmed.match(
				/^Its foretell cost is equal to its mana cost reduced by \{(\d+)\}$/i
			);
			if (handForetellHead && handForetellTail) {
				let filter: ObjectFilter | null = {};
				if (handForetellHead[1]) {
					filter = parseGraveyardCardFilter(handForetellHead[1]);
				}
				const reduceGeneric = parseInt(handForetellTail[1], 10);
				if (filter && reduceGeneric >= 0) {
					items.push({
						kind: 'static',
						static: { k: 'grantHandForetell', filter, reduceGeneric }
					});
					idx += 1;
					continue;
				}
			}
			// --- End Track P22a ---
			if (
				/^You may cast (?:~|this spell) as though it had flash$/i.test(trimmed) &&
				/^If you cast it any time a sorcery couldn't have been cast, the controller of the permanent it becomes sacrifices it at the beginning of the next cleanup step$/i.test(
					nextTrimmed
				)
			) {
				items.push(
					rule('castAsThoughFlash', 'you', {
						selfOnly: true,
						sacrificeAtNextCleanupIfNonSorcery: true
					})
				);
				idx += 1;
				continue;
			}
			if (/^If you don't, (?:it|~) enters(?: the battlefield)? tapped$/i.test(nextTrimmed)) {
				const shockMatch = trimmed.match(/^As (?:~|it) enters(?: the battlefield)?, you may pay (\d+) life$/i);
				if (shockMatch) {
					const payLife = parseInt(shockMatch[1], 10);
					if (payLife > 0) {
						items.push({
							kind: 'replacement',
							replacement: {
								replaces: entersSelf,
								with: { k: 'modify', payLifeOrEnterTapped: payLife },
								selfReplacement: true
							}
						});
						idx += 1;
						continue;
					}
				}
				const revealMatch = trimmed.match(
					/^As (?:~|it) enters(?: the battlefield)?, you may reveal (?:a |an )?(.+?) from your hand$/i
				);
				if (revealMatch) {
					const filter = parseObjectPhrase(revealMatch[1]);
					if (filter) {
						items.push({
							kind: 'replacement',
							replacement: {
								replaces: entersSelf,
								with: { k: 'modify', revealFromHandOrEnterTapped: filter },
								selfReplacement: true
							}
						});
						idx += 1;
						continue;
					}
				}
			}

			// --- Track P11: Two-sentence cost modifiers (coloredOnly / minTotalMana: 1) ---
			if (
				/^This effect reduces only the amount of colored mana you pay$/i.test(nextTrimmed) ||
				/^This effect can't reduce the (?:amount of )?mana (?:in that cost |that ability costs to activate )?to less than one mana$/i.test(
					nextTrimmed
				) ||
				/^This cost can't be reduced to less than \{1\}$/i.test(nextTrimmed)
			) {
				const fused = `${trimmed}. ${nextTrimmed}.`;
				const fusedCostMod = parseCostModifierSentence(fused);
				if (fusedCostMod) {
					items.push({ kind: 'static', static: fusedCostMod });
					idx += 1;
					continue;
				}
			}
			// --- End Track P11 ---

			// --- Track P14: Self-safe Aura protection (CR 702.16n, 702.16p), 2-sentence Phantom prevention, & Kess exile ---
			const auraExempt = nextTrimmed.match(
				/^This effect doesn't remove (~|Auras|Auras you control|Auras and Equipment you control)(?: that are already attached to (?:it|~|that creature|enchanted creature))?$/i
			);
			if (auraExempt) {
				const headParsed = parseSentence(sentence.text, sentence.span, depth);
				if (headParsed && headParsed.length > 0) {
					const rawKind = auraExempt[1].toLowerCase();
					const exMode:
						| 'self'
						| 'allAuras'
						| 'controlledAuras'
						| 'controlledAttachments' =
						rawKind === '~'
							? 'self'
							: rawKind === 'auras'
								? 'allAuras'
								: rawKind === 'auras you control'
									? 'controlledAuras'
									: 'controlledAttachments';
					let attachedAny = false;
					for (const hi of headParsed) {
						if (hi.kind === 'static' && hi.static.k === 'continuous' && hi.static.layer === '6') {
							if (
								hi.static.mod.k === 'addKeywords' &&
								hi.static.mod.keywords.some((kw) => kw.includes('protection from'))
							) {
								hi.static.mod.protectionAttachmentExemption = exMode;
								attachedAny = true;
							} else if (hi.static.mod.k === 'protectionFromChosenColor') {
								hi.static.mod.protectionAttachmentExemption = exMode;
								attachedAny = true;
							}
						}
					}
					if (attachedAny) {
						items.push(...headParsed);
						idx += 1;
						continue;
					}
				}
			}

			const phantomHead = trimmed.match(
				/^If (combat |noncombat )?damage would be dealt to ~(?: while it has (?:a|an|one) (.+?) counter on (?:it|~))?, prevent (?:all of )?that damage$/i
			);
			const phantomTail = nextTrimmed.match(
				/^Remove (a|an|one|that many) (.+?) counters? from (?:~|it)$/i
			);
			if (phantomHead && phantomTail) {
				const kindRaw = phantomHead[1]?.trim().toLowerCase();
				const whileCtr = phantomHead[2] ? lookupStaticCounter(phantomHead[2]) : undefined;
				const modeRaw = phantomTail[1].toLowerCase();
				const remCtr = lookupStaticCounter(phantomTail[2]);
				if (remCtr && (!phantomHead[2] || whileCtr === remCtr)) {
					items.push({
						kind: 'static',
						static: {
							k: 'staticDamagePrevention',
							...(kindRaw === 'combat' ? { combatOnly: true } : {}),
							...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
							amount: 'all',
							target: 'self',
							phantomCounterRemoval: {
								counter: remCtr,
								mode: modeRaw === 'that many' ? 'thatMany' : 'one',
								...(whileCtr ? { requireCounterPresent: true } : {})
							}
						}
					});
					idx += 1;
					continue;
				}
			}

			if (
				/^If a spell cast this way would be put into (?:your|a) graveyard, exile it instead$/i.test(
					nextTrimmed
				)
			) {
				const headParsed = parseSentence(sentence.text, sentence.span, depth);
				if (
					headParsed &&
					headParsed.length > 0 &&
					headParsed.every(
						(hi) =>
							hi.kind === 'static' &&
							hi.static.k === 'zonePlayPermission' &&
							Boolean(hi.static.allowSpells)
					)
				) {
					for (const hi of headParsed) {
						if (hi.kind === 'static' && hi.static.k === 'zonePlayPermission') {
							hi.static.exileIfPutIntoGraveyard = true;
						}
					}
					items.push(...headParsed);
					idx += 1;
					continue;
				}
			}

			// --- Track P17a: Bolas's Citadel life-for-mana cast & self graveyard/exile cast with finality/ETB counter ---
			if (
				/^If you cast a spell this way, (?:you )?pay life equal to its mana value rather than pay(?:ing)? its mana cost$/i.test(
					nextTrimmed
				)
			) {
				const headParsed = parseSentence(sentence.text, sentence.span, depth);
				if (
					headParsed &&
					headParsed.length > 0 &&
					headParsed.every(
						(hi) =>
							hi.kind === 'static' &&
							hi.static.k === 'zonePlayPermission' &&
							Boolean(hi.static.allowSpells) &&
							hi.static.affects !== 'self'
					)
				) {
					for (const hi of headParsed) {
						if (hi.kind === 'static' && hi.static.k === 'zonePlayPermission') {
							const zp = hi.static;
							if (zp.allowLands) {
								items.push({
									kind: 'static',
									static: { ...zp, allowSpells: false }
								});
							}
							items.push({
								kind: 'static',
								static: {
									k: 'altCastPermission',
									manaCost: '{0}',
									payLifeEqualToManaValue: true,
									affects: { filter: zp.spellFilter ?? {} },
									allowedZones: [zp.zone],
									...(zp.duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
									...(zp.slotMode === 'oncePerTurn' ? { slotMode: 'oncePerTurn' } : {}),
									...(zp.condition ? { condition: zp.condition } : {})
								}
							});
						}
					}
					idx += 1;
					continue;
				}
			}

			const entersCtrTail = nextTrimmed.match(
				/^If you do, (?:it|~) enters(?: the battlefield)? with (a|an|\S+) (.+?) counters? on (?:it|~)$/i
			);
			if (entersCtrTail) {
				const cnt = count(entersCtrTail[1]);
				const ctr = lookupStaticCounter(entersCtrTail[2]);
				if (cnt && cnt.k === 'const' && cnt.n > 0 && ctr) {
					const headParsed = parseSentence(sentence.text, sentence.span, depth);
					if (headParsed && headParsed.length > 0 && headParsed.every((hi) => hi.kind === 'static')) {
						const altItem = headParsed.find(
							(hi) =>
								hi.kind === 'static' &&
								hi.static.k === 'altCastPermission' &&
								hi.static.affects === 'self'
						);
						if (altItem && altItem.kind === 'static' && altItem.static.k === 'altCastPermission') {
							altItem.static.entersWithCounters = {
								...(altItem.static.entersWithCounters ?? {}),
								[ctr]: cnt.n
							};
							items.push(...headParsed);
							idx += 1;
							continue;
						}
						if (headParsed.length === 1 && headParsed[0].kind === 'static') {
							const hs = headParsed[0].static;
							if (
								hs.k === 'zonePlayPermission' &&
								hs.affects === 'self' &&
								hs.allowSpells !== false &&
								(hs.zone === 'graveyard' || hs.zone === 'exile')
							) {
								items.push(
									headParsed[0],
									{
										kind: 'static',
										static: {
											k: 'altCastPermission',
											manaCost: '__PRINTED__',
											affects: 'self',
											allowedZones: [hs.zone],
											...(hs.duringYourTurnOnly ? { duringYourTurnOnly: true } : {}),
											...(hs.condition ? { condition: hs.condition } : {}),
											entersWithCounters: { [ctr]: cnt.n }
										}
									}
								);
								idx += 1;
								continue;
							}
						}
					}
				}
			}
			// --- End Track P17a ---

			const otherwiseMatch = nextTrimmed.match(/^Otherwise,\s+(.+)$/i);
			if (otherwiseMatch) {
				const headParsed = parseSentence(sentence.text, sentence.span, depth);
				if (
					headParsed &&
					headParsed.length > 0 &&
					headParsed.every(
						(hi) =>
							hi.kind === 'static' &&
							'condition' in hi.static &&
							Boolean(hi.static.condition)
					)
				) {
					const firstStatic = (headParsed[0] as Extract<StaticItem, { kind: 'static' }>).static;
					const headCond =
						'condition' in firstStatic ? firstStatic.condition : undefined;
					const condJson = headCond ? JSON.stringify(headCond) : '';
					const sameCond =
						Boolean(headCond) &&
						headParsed.every(
							(hi) =>
								hi.kind === 'static' &&
								'condition' in hi.static &&
								JSON.stringify(hi.static.condition) === condJson
						);
					if (sameCond && headCond) {
						const allAttached = headParsed.every(
							(hi) =>
								hi.kind === 'static' &&
								'affected' in hi.static &&
								hi.static.affected === 'attachedTo'
						);
						let tailBody = otherwiseMatch[1].trim();
						if (allAttached) {
							if (/^it's\b/i.test(tailBody)) {
								tailBody = `Enchanted permanent is${tailBody.slice(4)}`;
							} else if (/^it\s+/i.test(tailBody)) {
								tailBody = `Enchanted permanent ${tailBody.slice(3)}`;
							}
						}
						tailBody = tailBody.charAt(0).toUpperCase() + tailBody.slice(1);
						const tailParsed = parseSentence(
							`${tailBody}.`,
							sentences[idx + 1].span,
							depth
						);
						if (
							tailParsed &&
							tailParsed.length > 0 &&
							tailParsed.every((ti) =>
								ti.kind === 'replacement'
									? !ti.replacement.condition
									: !('condition' in ti.static && ti.static.condition)
							) &&
							withCondition(tailParsed, { k: 'not', of: headCond })
						) {
							items.push(...headParsed, ...tailParsed);
							idx += 1;
							continue;
						}
					}
				}
			}
			// --- End Track P14 ---
		}

		// --- Track P17a: Off-battlefield characteristics sentence fusion, color-identity reminder skip, & 2-sentence pronoun anaphora ---
		if (
			items.length > 0 &&
			/^This ability doesn't affect its color identity$/i.test(trimmed)
		) {
			continue;
		}
		const offBfSame = trimmed.match(
			/^The same is true for (creature|permanent|nonland permanent) spells you control and (creature|nonland permanent|permanent) cards you own that aren't on the battlefield$/i
		);
		if (offBfSame) {
			let fusedOffBf = false;
			for (let i = items.length - 1; i >= 0; i--) {
				const it = items[i];
				if (
					it.kind === 'static' &&
					it.static.k === 'continuous' &&
					(it.static.layer === '4' || it.static.layer === '5')
				) {
					const mod = it.static.mod;
					const cardScope = offBfSame[2].toLowerCase();
					const filter: ObjectFilter =
						cardScope === 'creature'
							? { types: ['Creature'] }
							: cardScope === 'nonland permanent'
								? { notTypes: ['Land', 'Instant', 'Sorcery'] }
								: { notTypes: ['Instant', 'Sorcery'] };
					if (
						mod.k === 'allCreatureTypes' ||
						mod.k === 'addChosenSubtype' ||
						(mod.k === 'addTypes' &&
							(mod.types.length > 0 || Boolean(mod.subtypes && mod.subtypes.length > 0))) ||
						mod.k === 'setChosenColor' ||
						mod.k === 'addChosenColor' ||
						((mod.k === 'addColors' || mod.k === 'setColors') && mod.colors.length > 0)
					) {
						items.push({
							kind: 'static',
							static: {
								k: 'offBattlefieldCharacteristics',
								zones: ['hand', 'graveyard', 'library', 'exile', 'command', 'stack'],
								filter,
								who: 'you',
								...(mod.k === 'allCreatureTypes' ? { addAllCreatureTypes: true } : {}),
								...(mod.k === 'addChosenSubtype' ? { addChosenSubType: true } : {}),
								...(mod.k === 'addTypes' && mod.types.length > 0
									? { addTypes: mod.types }
									: {}),
								...(mod.k === 'addTypes' && mod.subtypes?.length
									? { addSubtypes: mod.subtypes }
									: {}),
								...(mod.k === 'setChosenColor' || mod.k === 'addChosenColor'
									? { addChosenColor: true }
									: {}),
								...((mod.k === 'addColors' || mod.k === 'setColors') && mod.colors.length > 0
									? { addColors: mod.colors }
									: {}),
								...(it.static.condition ? { condition: it.static.condition } : {})
							}
						});
						fusedOffBf = true;
						break;
					}
				}
			}
			if (fusedOffBf) continue;
		}
		if (items.length > 0) {
			let lastAffected: Affected | undefined;
			for (let i = items.length - 1; i >= 0; i--) {
				const it = items[i];
				if (
					it.kind === 'static' &&
					(it.static.k === 'continuous' ||
						it.static.k === 'restriction' ||
						it.static.k === 'combatRule')
				) {
					lastAffected = it.static.affected;
					break;
				}
			}
			if (
				lastAffected === 'attachedTo' &&
				!/^(?:it's|it is) still\b/i.test(trimmed)
			) {
				let rewritten: string | null = null;
				if (/^it's\b/i.test(trimmed)) {
					rewritten = `Enchanted permanent is${trimmed.slice(4)}.`;
				} else if (/^it is\b/i.test(trimmed)) {
					rewritten = `Enchanted permanent is${trimmed.slice(5)}.`;
				} else if (/^it\s+(?:has|gets|loses|can't|can|must|doesn't|isn't)\b/i.test(trimmed)) {
					rewritten = `Enchanted permanent ${trimmed.slice(3)}.`;
				}
				if (rewritten) {
					const parsedAtt = parseSentence(rewritten, sentence.span, depth);
					if (parsedAtt && parsedAtt.length > 0) {
						items.push(...parsedAtt);
						continue;
					}
				}
			}
			if (lastAffected && typeof lastAffected === 'object') {
				const theyFollow = trimmed.match(
					/^(?:As long as ([^,]+),\s+|(During your turn),\s+)?they (?:also )?((?:have|get|are|lose|can't|can|must|assign|attack|block)\b[\s\S]+)$/i
				);
				if (theyFollow) {
					let cond: Condition | undefined;
					let condOk = true;
					if (theyFollow[1]) {
						const parsedCond = parseStaticCondition(theyFollow[1]);
						if (parsedCond) cond = parsedCond;
						else condOk = false;
					} else if (theyFollow[2]) {
						cond = { k: 'isTurnOf', player: { k: 'you' } };
					}
					if (condOk) {
						const tailItems = parseInlineStaticTail(lastAffected, theyFollow[3], cond, depth);
						if (tailItems && tailItems.length > 0) {
							items.push(...tailItems);
							continue;
						}
					}
				}
			}
		}
		// --- End Track P17a ---

		if (/^(?:it's|they're|it is) still (?:a |an )?(?:lands?|artifacts?|enchantments?|planeswalkers?)$/i.test(trimmed)) {
			let converted = false;
			for (let i = items.length - 1; i >= 0; i--) {
				const it = items[i];
				if (
					it.kind === 'static' &&
					it.static.k === 'continuous' &&
					it.static.layer === '4' &&
					it.static.affected === 'attachedTo' &&
					it.static.mod.k === 'setTypes'
				) {
					const prev = it.static.mod;
					it.static.mod = {
						k: 'addTypes',
						types: prev.types,
						...(prev.subtypes && prev.subtypes.length > 0 ? { subtypes: prev.subtypes } : {})
					};
					converted = true;
					break;
				}
			}
			if (converted) continue;
		}
		const parsed = parseSentence(sentence.text, sentence.span, depth);
		if (parsed && (parsed.length > 0 || items.length > 0)) items.push(...parsed);
		else unparsed.push(sentence.span);
	}
	let grantIdx = 0;
	for (const item of items) {
		if (
			item.kind === 'static' &&
			item.static.k === 'continuous' &&
			item.static.mod.k === 'grantAbility' &&
			item.static.mod.ability.kind === 'activated'
		) {
			item.static.mod.ability.id = `granted_${grantIdx++}`;
		}
	}
	return { items, unparsed };
}

/** Parses a static ability line (normalised body text). `offset` is its position in the caller's text. */
export function parseStaticAbility(text: string, offset = 0): StaticParse {
	return parseStaticAbilityInner(text, offset, 0);
}
