/**
 * Trigger-condition grammar (ENGINE_ARCHITECTURE_PLAN.md section 2.2, CR 603.1).
 *
 * Parses the head of a triggered ability ("When ~ enters", "Whenever a land you control enters",
 * "At the beginning of your upkeep") and its intervening-if clause (CR 603.4) into a TriggerDef and a
 * Condition, and says where the effect text starts. Input is normalised text (self-references are
 * `~`, ability words already stripped). Anything not understood is reported as an unparsed span.
 *
 * compiler/card.ts uses it for every "When/Whenever/At" line.
 */
import type { Amount, CardDefinition, Compare, Condition, CostDef, EffectStep, EventFilter, ModalDef, ObjectFilter, PlayerFilter, PlayerRef, Span, TargetSpec, TriggerDef } from '../ir.ts';
import { getKeywordSpec } from '../keywords.ts';
import { normalizeCounterName, type CounterType, type GamePhase, type ManaColor, type TriggerScope, type ZoneType } from '../types.ts';
import { COUNTERS, singularSubtype } from './costs.ts';
import { parseExtendedObjectPhrase, type ExtendedObjectPhraseOptions } from './effectsWave5.ts';

export interface TriggerParse {
	trigger?: TriggerDef;
	condition?: Condition;
	/** Offset (in the caller's coordinates) where the effect text starts. */
	effectStart: number;
	/** Parts of the trigger head or condition no production understood. */
	unparsed: Span[];
}

const NUMBER_WORDS: Record<string, number> = {
	zero: 0,
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
	twenty: 20,
	thirty: 30,
	forty: 40,
	fifty: 50
};

function number(word: string): number | null {
	const low = word.toLowerCase();
	if (/^\d+$/.test(low)) return parseInt(low, 10);
	return NUMBER_WORDS[low] ?? null;
}

const n = (value: number): Amount => ({ k: 'const', n: value });

// ---- Phases ---------------------------------------------------------------------------------

const STEPS: Record<string, GamePhase> = {
	upkeep: 'upkeep',
	'draw step': 'draw',
	'end step': 'end_step',
	'precombat main phase': 'main1',
	'first main phase': 'main1',
	'postcombat main phase': 'main2',
	'second main phase': 'main2'
};

// --- Track P19b ---
const EXTENDED_ORDINAL_WORDS: Record<string, number> = {
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	sixth: 6,
	seventh: 7,
	eighth: 8,
	ninth: 9,
	tenth: 10
};

function parseExtendedOrdinal(raw: string): number | null {
	const low = raw.trim().toLowerCase();
	if (EXTENDED_ORDINAL_WORDS[low] !== undefined) return EXTENDED_ORDINAL_WORDS[low];
	const numM = low.match(/^(\d+)(?:st|nd|rd|th)$/);
	if (numM) {
		const val = parseInt(numM[1], 10);
		return val >= 1 ? val : null;
	}
	return null;
}

const COLOR_WORD_TO_MANA: Record<string, ManaColor> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G'
};
// --- End Track P19b ---

/** "your upkeep", "each opponent's end step", "combat on your turn", "each combat". */
function phaseBegin(rest: string): TriggerDef | null {
	// --- Track P19b: spell-created delayed next-upkeep trigger (CR 603.7a) ---
	if (rest === 'your next upkeep') {
		return {
			event: 'phaseBegin',
			filter: { phase: 'upkeep' },
			scope: 'controller_turn',
			spellDelayed: 'nextUpkeep'
		};
	}
	// --- End Track P19b ---
	if (rest === 'combat on your turn' || rest === 'your combat step') {
		return { event: 'phaseBegin', filter: { phase: 'begin_combat' }, scope: 'controller_turn' };
	}
	if (rest === 'each combat') return { event: 'phaseBegin', filter: { phase: 'begin_combat' }, scope: 'each_turn' };
	// --- Track P16b ---
	if (rest === "combat on each opponent's turn" || rest === "combat on an opponent's turn") {
		return { event: 'phaseBegin', filter: { phase: 'begin_combat' }, scope: 'opponent_turn' };
	}
	if (rest === 'your first upkeep') {
		return {
			event: 'phaseBegin',
			filter: { phase: 'upkeep', phaseTurnFilter: 'yourFirstUpkeep' },
			scope: 'controller_turn'
		};
	}
	if (rest === "each other player's first upkeep" || rest === "each opponent's first upkeep") {
		return {
			event: 'phaseBegin',
			filter: { phase: 'upkeep', phaseTurnFilter: 'firstOfGame' },
			scope: 'opponent_turn'
		};
	}
	if (rest === 'the first upkeep') {
		return {
			event: 'phaseBegin',
			filter: { phase: 'upkeep', phaseTurnFilter: 'firstOfGame' },
			scope: 'each_turn'
		};
	}
	if (rest === "the monarch's end step") {
		return {
			event: 'phaseBegin',
			filter: { phase: 'end_step', phaseTurnFilter: 'monarch' },
			scope: 'each_turn'
		};
	}
	if (rest === 'each of your postcombat main phases' || rest === 'each of your second main phases') {
		return { event: 'phaseBegin', filter: { phase: 'main2' }, scope: 'controller_turn' };
	}
	if (rest === 'each of your precombat main phases' || rest === 'each of your first main phases') {
		return { event: 'phaseBegin', filter: { phase: 'main1' }, scope: 'controller_turn' };
	}
	// --- End Track P16b ---
	// --- Track P10 ---
	const enchCtrl = rest.match(
		/^the (upkeep|draw step|end step) of (?:enchanted|equipped) (creature|permanent|land|artifact|enchantment|planeswalker)'s controller$/
	);
	if (enchCtrl) {
		const phase = STEPS[enchCtrl[1]];
		if (!phase) return null;
		const mappedType = ATTACHED_SUBJ_TYPES[enchCtrl[2]];
		return {
			event: 'phaseBegin',
			filter: {
				phase,
				enchantedControllerUpkeep: true,
				...(mappedType ? { attachedFilter: { types: [mappedType] } } : {})
			},
			scope: 'each_turn'
		};
	}
	const enchPlayer = rest.match(/^enchanted player's (upkeep|draw step|end step)$/);
	if (enchPlayer) {
		const phase = STEPS[enchPlayer[1]];
		if (!phase) return null;
		return {
			event: 'phaseBegin',
			filter: { phase, enchantedPlayerUpkeep: true },
			scope: 'each_turn'
		};
	}
	// --- End Track P10 ---
	const m = rest.match(/^(each other player's|each opponent's|each player's|each|your|the) (.+)$/);
	if (!m) return null;
	const phase = STEPS[m[2]];
	if (!phase) return null;
	const scope: TriggerScope =
		m[1] === 'your' ? 'controller_turn' : m[1] === "each opponent's" || m[1] === "each other player's" ? 'opponent_turn' : 'each_turn';
	// "the end step" only means "each" outside a delayed trigger ("the next end step" is delayed).
	return { event: 'phaseBegin', filter: { phase }, scope };
}

// ---- Subjects -------------------------------------------------------------------------------

// --- Track P16b ---
const COUNTER_STOP_WORDS = new Set([
	'a',
	'an',
	'the',
	'no',
	'any',
	'more',
	'other',
	'that',
	'those',
	'these',
	'each',
	'all',
	'another'
]);

function parseTriggerCounter(raw: string): CounterType | null {
	const cleaned = raw.trim().toLowerCase().replace(/−/g, '-').replace(/\s+/g, ' ');
	if (!cleaned || COUNTER_STOP_WORDS.has(cleaned)) return null;
	if (COUNTERS[cleaned]) return COUNTERS[cleaned];
	if (/^[+-]\d+\/[+-]\d+$/.test(cleaned)) return normalizeCounterName(cleaned);
	if (/^[a-z][a-z -]*$/.test(cleaned)) return normalizeCounterName(cleaned);
	return null;
}

function mergeP16bFilter(base: ObjectFilter, extra: ObjectFilter): ObjectFilter {
	const out: ObjectFilter = { ...base };
	for (const [k, v] of Object.entries(extra) as Array<[keyof ObjectFilter, unknown]>) {
		if (v === undefined) continue;
		const prev = out[k];
		if (Array.isArray(prev) && Array.isArray(v)) {
			const arr = prev as unknown[];
			(out as Record<string, unknown>)[k] = [...arr, ...v.filter((item) => !arr.includes(item))];
		} else {
			(out as Record<string, unknown>)[k] = v;
		}
	}
	return out;
}

function parseP16bObjectPhrase(
	phrase: string,
	opts?: ExtendedObjectPhraseOptions
): ObjectFilter | null {
	let rest = phrase.trim();
	if (!rest) return null;

	// Special compound subject: "enchanted creature or enchantment creature you control"
	if (/^enchanted creature or enchantment creature you control$/i.test(rest)) {
		return {
			anyOf: [
				{ types: ['Creature'], enchanted: true, controller: 'you' },
				{
					types: ['Enchantment', 'Creature'],
					allTypes: ['Enchantment', 'Creature'],
					controller: 'you'
				}
			]
		};
	}

	const outer: ObjectFilter = {};

	for (let guard = 0; guard < 16; guard++) {
		const enchPlCtrl = rest.match(/^(.+?)\s+enchanted player controls$/i);
		if (enchPlCtrl && outer.controlledByEnchantedPlayer === undefined && !outer.controller) {
			outer.controlledByEnchantedPlayer = true;
			rest = enchPlCtrl[1].trim();
			continue;
		}
		const youCtrl = rest.match(/^(.+?)\s+you control$/i);
		if (youCtrl && !outer.controller && !outer.controllerRef && !outer.controlledByEnchantedPlayer) {
			outer.controller = 'you';
			rest = youCtrl[1].trim();
			continue;
		}
		const oppCtrl = rest.match(
			/^(.+?)\s+(?:an opponent controls|your opponents control|opponents control|you don't control)$/i
		);
		if (oppCtrl && !outer.controller && !outer.controllerRef && !outer.controlledByEnchantedPlayer) {
			outer.controller = 'opponent';
			rest = oppCtrl[1].trim();
			continue;
		}
		const namedSelf = rest.match(/^(.+?)\s+(?:named ~|with the same name as ~)$/i);
		if (namedSelf && outer.sameNameAsSource === undefined) {
			outer.sameNameAsSource = true;
			rest = namedSelf[1].trim();
			continue;
		}
		// --- Track P19b: linked-exile same-name & explicit card-name qualifiers ---
		const sameExiled = rest.match(
			/^(.+?)\s+with the same name as (?:the exiled card|(?:the|a|an) card exiled with ~)$/i
		);
		if (sameExiled && outer.sameNameAsLinkedExile === undefined) {
			outer.sameNameAsLinkedExile = true;
			rest = sameExiled[1].trim();
			continue;
		}
		const namedExplicit = rest.match(
			/^(.+?)\s+named ([A-Z][A-Za-z0-9',-]*(?:\s+(?:[A-Z][A-Za-z0-9',-]*|of|the))*)$/
		);
		if (namedExplicit && outer.named === undefined && outer.sameNameAsSource === undefined) {
			outer.named = namedExplicit[2].trim();
			rest = namedExplicit[1].trim();
			continue;
		}
		// --- End Track P19b ---
		const otherSelf = rest.match(/^(.+?)\s+other than ~$/i);
		if (otherSelf) {
			outer.other = true;
			rest = otherSelf[1].trim();
			continue;
		}
		const oppOwned = rest.match(/^(.+?)\s+owned by another player$/i);
		if (oppOwned && !outer.owner) {
			outer.owner = 'opponent';
			rest = oppOwned[1].trim();
			continue;
		}
		const youOwned = rest.match(/^(.+?)\s+owned by you$/i);
		if (youOwned && !outer.owner) {
			outer.owner = 'you';
			rest = youOwned[1].trim();
			continue;
		}
		const thatsEnch = rest.match(/^(.+?)\s+that(?:'s| is) enchanted$/i);
		if (thatsEnch && outer.enchanted === undefined) {
			outer.enchanted = true;
			rest = thatsEnch[1].trim();
			continue;
		}
		const thatsEq = rest.match(/^(.+?)\s+that(?:'s| is) equipped$/i);
		if (thatsEq && outer.equipped === undefined) {
			outer.equipped = true;
			rest = thatsEq[1].trim();
			continue;
		}
		const hasAdv = rest.match(/^(.+?)\s+(?:that has|with) an Adventure$/i);
		if (hasAdv && outer.hasAdventure === undefined) {
			outer.hasAdventure = true;
			rest = hasAdv[1].trim();
			continue;
		}
		const hasX = rest.match(/^(.+?)\s+with \{X\} in its mana cost$/i);
		if (hasX && outer.hasXInManaCost === undefined) {
			outer.hasXInManaCost = true;
			rest = hasX[1].trim();
			continue;
		}
		const pwrGtBase = rest.match(
			/^(.+?)\s+(?:each )?with power greater than its base power$/i
		);
		if (pwrGtBase && outer.powerGreaterThanBase === undefined) {
			outer.powerGreaterThanBase = true;
			rest = pwrGtBase[1].trim();
			continue;
		}
		const pwrEqTgh = rest.match(/^(.+?)\s+with power equal to its toughness$/i);
		if (pwrEqTgh && outer.powerEqualsToughness === undefined) {
			outer.powerEqualsToughness = true;
			rest = pwrEqTgh[1].trim();
			continue;
		}
		const mvEqSelfPwr = rest.match(/^(.+?)\s+with mana value equal to ~'s power$/i);
		if (mvEqSelfPwr && outer.manaValueEqualsSourcePower === undefined) {
			outer.manaValueEqualsSourcePower = true;
			rest = mvEqSelfPwr[1].trim();
			continue;
		}
		const dealtDmg = rest.match(/^(.+?)\s+that (?:has|have) been dealt damage this turn$/i);
		if (dealtDmg && outer.dealtDamageThisTurn === undefined) {
			outer.dealtDamageThisTurn = true;
			rest = dealtDmg[1].trim();
			continue;
		}
		// --- Track P19b: "that's both <colorA> and <colorB>" ---
		const thatsBothColors = rest.match(
			/^(.+?)\s+that(?:'s| is) both (white|blue|black|red|green) and (white|blue|black|red|green)$/i
		);
		if (thatsBothColors && !outer.allColors && !outer.colors) {
			const c1 = COLOR_WORD_TO_MANA[thatsBothColors[2].toLowerCase()];
			const c2 = COLOR_WORD_TO_MANA[thatsBothColors[3].toLowerCase()];
			if (c1 && c2 && c1 !== c2) {
				outer.colors = [c1, c2];
				outer.allColors = [c1, c2];
				rest = thatsBothColors[1].trim();
				continue;
			}
		}
		// --- End Track P19b ---
		const thatsColors = rest.match(
			/^(.+?)\s+that(?:'s| is)\s+((?:white|blue|black|red|green|colorless)(?:(?:\s*,\s*|\s*,?\s+or\s+)(?:white|blue|black|red|green|colorless))*)$/i
		);
		if (thatsColors) {
			rest = `${thatsColors[2]} ${thatsColors[1]}`;
			continue;
		}
		break;
	}

	for (let guard = 0; guard < 16; guard++) {
		const otherLead = rest.match(/^(?:another|other)\s+(.+)$/i);
		if (otherLead) {
			outer.other = true;
			rest = otherLead[1].trim();
			continue;
		}
		const modLead = rest.match(/^modified\s+(.+)$/i);
		if (modLead && outer.modified === undefined) {
			outer.modified = true;
			rest = modLead[1].trim();
			continue;
		}
		const unmodLead = rest.match(/^unmodified\s+(.+)$/i);
		if (unmodLead && outer.modified === undefined) {
			outer.modified = false;
			rest = unmodLead[1].trim();
			continue;
		}
		const renLead = rest.match(/^renowned\s+(.+)$/i);
		if (renLead && outer.renowned === undefined) {
			outer.renowned = true;
			rest = renLead[1].trim();
			continue;
		}
		const goadLead = rest.match(/^goaded\s+(.+)$/i);
		if (goadLead && outer.goaded === undefined) {
			outer.goaded = true;
			rest = goadLead[1].trim();
			continue;
		}
		const enchLead = rest.match(/^enchanted\s+(.+)$/i);
		if (enchLead && outer.enchanted === undefined) {
			outer.enchanted = true;
			rest = enchLead[1].trim();
			continue;
		}
		const eqLead = rest.match(/^equipped\s+(.+)$/i);
		if (eqLead && outer.equipped === undefined) {
			outer.equipped = true;
			rest = eqLead[1].trim();
			continue;
		}
		const ptLead = rest.match(/^(\d+)\/(\d+)\s+(.+)$/);
		if (ptLead && !outer.power && !outer.toughness) {
			outer.power = { op: '=', value: n(parseInt(ptLead[1], 10)) };
			outer.toughness = { op: '=', value: n(parseInt(ptLead[2], 10)) };
			rest = ptLead[3].trim();
			continue;
		}
		break;
	}

	if (/^outlaws?(?:\s+creatures?)?$/i.test(rest)) {
		return mergeP16bFilter({ outlaw: true }, outer);
	}
	if (/^sources?$/i.test(rest)) {
		return Object.keys(outer).length > 0 ? outer : {};
	}
	if (/\s+sources?$/i.test(rest)) {
		rest = rest.replace(/\s+sources?$/i, ' permanent');
	}
	if (/^snow lands?$/i.test(rest)) {
		return mergeP16bFilter({ supertypes: ['Snow'], types: ['Land'] }, outer);
	}
	if (/^permanents? of the chosen color$/i.test(rest)) {
		return mergeP16bFilter({ ofChosenColor: true }, outer);
	}

	const normalizedAndOr = rest.replace(/,\s*and\/or\s+/gi, ', or ').replace(/\s+and\/or\s+/gi, ' or ');
	const parsed = parseExtendedObjectPhrase(normalizedAndOr, opts);
	if (parsed) {
		const merged = mergeP16bFilter(parsed, outer);
		return hasSupplementaryDeckSubtype(merged) ? null : merged;
	}

	if (/^[A-Z][A-Za-z'-]*$/.test(rest)) {
		const sub = singularSubtype(rest);
		if (sub && !SUPPLEMENTARY_DECK_SUBTYPES.has(sub)) {
			return mergeP16bFilter({ subtypes: [sub] }, outer);
		}
	}
	return null;
}

const SUPPLEMENTARY_DECK_SUBTYPES: ReadonlySet<string> = new Set(['Contraption', 'Attraction']);

function hasSupplementaryDeckSubtype(f: ObjectFilter): boolean {
	if (f.subtypes?.some((s) => SUPPLEMENTARY_DECK_SUBTYPES.has(s))) return true;
	if (f.anyOf?.some((sub) => hasSupplementaryDeckSubtype(sub))) return true;
	return false;
}
// --- End Track P16b ---

interface Subject {
	object?: EventFilter['object'];
	attachedFilter?: ObjectFilter;
	orSelf?: boolean;
	orAttachedToSelf?: boolean;
	oneOrMore?: boolean;
	isCardNoun?: boolean;
	player?: EventFilter['player'];
}

const ATTACHED_SUBJ_TYPES: Record<string, string> = {
	creature: 'Creature',
	land: 'Land',
	artifact: 'Artifact',
	enchantment: 'Enchantment',
	planeswalker: 'Planeswalker'
};

function objectSubject(text: string): Subject | null {
	if (
		text === '~' ||
		/^this (?:creature|permanent|artifact|enchantment|land|planeswalker|room|vehicle|aura|equipment)$/i.test(
			text
		)
	) {
		return { object: 'self' };
	}
	if (text === 'equipped creature') {
		return { object: 'attachedTo', attachedFilter: { types: ['Creature'] } };
	}
	const enchSubj = text.match(/^enchanted (creature|permanent|land|artifact|enchantment|planeswalker)$/);
	if (enchSubj) {
		const mappedType = ATTACHED_SUBJ_TYPES[enchSubj[1]];
		return {
			object: 'attachedTo',
			...(mappedType ? { attachedFilter: { types: [mappedType] } } : {})
		};
	}
	// --- Track P19b: subtype-qualified enchanted object ("enchanted Forest", "enchanted Plains") ---
	const enchSub = text.match(/^enchanted ([A-Z][A-Za-z'-]*)$/);
	if (enchSub) {
		const sub = singularSubtype(enchSub[1]);
		if (sub) {
			return { object: 'attachedTo', attachedFilter: { subtypes: [sub] } };
		}
	}
	const selfOrEnchSub = text.match(/^~ or enchanted ([A-Z][A-Za-z'-]*)$/);
	if (selfOrEnchSub) {
		const sub = singularSubtype(selfOrEnchSub[1]);
		if (sub) {
			return {
				object: 'attachedTo',
				orAttachedToSelf: true,
				attachedFilter: { subtypes: [sub] }
			};
		}
	}
	// --- End Track P19b ---
	// --- Track P16b ---
	if (/^~ or equipped creature$/i.test(text)) {
		return {
			object: 'attachedTo',
			orAttachedToSelf: true,
			attachedFilter: { types: ['Creature'] }
		};
	}
	const selfOrEnch = text.match(
		/^~ or enchanted (creature|permanent|land|artifact|enchantment|planeswalker)$/i
	);
	if (selfOrEnch) {
		const mappedType = ATTACHED_SUBJ_TYPES[selfOrEnch[1].toLowerCase()];
		return {
			object: 'attachedTo',
			orAttachedToSelf: true,
			...(mappedType ? { attachedFilter: { types: [mappedType] } } : {})
		};
	}
	if (/^your commander$/i.test(text)) {
		return { object: { isCommander: true, controller: 'you' } };
	}
	// --- End Track P16b ---
	const orSelf = text.match(/^~ or (another .+)$/);
	if (orSelf) {
		const s = objectSubject(orSelf[1]);
		return s && typeof s.object === 'object' ? { ...s, orSelf: true } : null;
	}
	let phrase = text;
	let oneOrMore: true | undefined;
	if (/^one or more /.test(phrase)) {
		phrase = phrase.slice('one or more '.length);
		oneOrMore = true;
	} else if (/^(?:a|an) /.test(phrase)) {
		phrase = phrase.replace(/^(?:a|an) /, '');
	} else if (!/^another /.test(phrase)) {
		return null;
	}
	const isCardNoun = /\bcards?\b/i.test(phrase);
	// "a creature an opponent controls" / "a creature you don't control" / "with toughness N [or greater/less]".
	let controller: ObjectFilter['controller'];
	let toughnessCmp: Compare | undefined;
	for (let guard = 0; guard < 16; guard++) {
		const opp = phrase.match(/^(.+?)\s+(?:an opponent controls|your opponents control|you don't control)$/i);
		if (opp && !controller) {
			phrase = opp[1];
			controller = 'opponent';
			continue;
		}
		const withToughness = phrase.match(/^(.+?)\s+with toughness (\S+)(?: or (greater|more|less|fewer))?$/i);
		if (withToughness && !toughnessCmp) {
			const rawVal = withToughness[2];
			if (rawVal.toLowerCase() === 'a' || rawVal.toLowerCase() === 'an') return null;
			const numVal = number(rawVal);
			if (numVal === null) return null;
			const dir = withToughness[3]?.toLowerCase();
			toughnessCmp = { op: !dir ? '=' : dir === 'greater' || dir === 'more' ? '>=' : '<=', value: n(numVal) };
			phrase = withToughness[1];
			continue;
		}
		break;
	}
	const filter = parseP16bObjectPhrase(phrase);
	if (!filter) return null;
	if (controller) {
		if (filter.controller && filter.controller !== controller) return null;
		filter.controller = controller;
	}
	if (toughnessCmp) {
		if (filter.toughness) return null;
		filter.toughness = toughnessCmp;
	}
	return { object: filter, oneOrMore, ...(isCardNoun ? { isCardNoun: true } : {}) };
}

function playerSubject(text: string): EventFilter['player'] | null {
	if (text === 'you') return { relation: 'you' };
	if (text === 'a player') return { relation: 'any' };
	if (text === 'an opponent') return { relation: 'opponent' };
	return null;
}

// ---- Events ---------------------------------------------------------------------------------

/** One object event: "enters", "dies", "attacks", "deals combat damage to a player", ... */
function objectEvent(verb: string, subject: Subject): TriggerDef | null {
	const base: EventFilter = {};
	if (subject.object !== undefined) base.object = subject.object;
	if (subject.orSelf) base.orSelf = true;
	if (subject.orAttachedToSelf) {
		base.orAttachedToSelf = true;
		if (subject.attachedFilter) base.attachedFilter = subject.attachedFilter;
	}
	if (subject.oneOrMore) base.oneOrMore = true;
	const def = (event: TriggerDef['event'], extra: EventFilter = {}): TriggerDef => ({
		event,
		filter: { ...base, ...extra }
	});

	switch (verb) {
		case 'enters':
		case 'enter':
		case 'enters the battlefield':
			return def('zoneChange', { to: 'battlefield' });
		case 'enters untapped':
		case 'enter untapped':
		case 'enters the battlefield untapped':
		case 'enter the battlefield untapped':
			return def('zoneChange', { to: 'battlefield', entersUntapped: true });
		case 'enters from a graveyard':
		case 'enter from a graveyard':
		case 'enters the battlefield from a graveyard':
			return def('zoneChange', { from: 'graveyard', to: 'battlefield' });
		case 'enters from your graveyard':
		case 'enter from your graveyard':
		case 'enters the battlefield from your graveyard': {
			if (subject.object === 'self') {
				return def('zoneChange', { from: 'graveyard', to: 'battlefield' });
			}
			if (typeof base.object !== 'object') return null;
			return {
				event: 'zoneChange',
				filter: {
					...base,
					object: { ...base.object, owner: 'you' },
					from: 'graveyard',
					to: 'battlefield'
				}
			};
		}
		case 'enters during your turn':
		case 'enter during your turn':
			return def('zoneChange', { to: 'battlefield', duringTurn: 'your' });
		case 'enters from anywhere other than your hand':
		case 'enter from anywhere other than your hand':
			return def('zoneChange', { to: 'battlefield', notFromZone: 'hand' });
		case 'enters the battlefield under your control':
		case 'enters under your control': {
			if (typeof base.object !== 'object') return null;
			return { event: 'zoneChange', filter: { ...base, object: { ...base.object, controller: 'you' }, to: 'battlefield' } };
		}
		case 'dies':
		case 'die':
		case 'is put into a graveyard from the battlefield':
		case 'are put into a graveyard from the battlefield':
		case "is put into a player's graveyard from the battlefield":
		case "are put into a player's graveyard from the battlefield":
			return def('zoneChange', {
				from: 'battlefield',
				to: 'graveyard',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'is put into a graveyard':
		case 'are put into a graveyard':
			if (subject.object !== 'attachedTo' && subject.object !== 'self') return null;
			return def('zoneChange', {
				from: 'battlefield',
				to: 'graveyard',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'is put into exile from the battlefield':
		case 'are put into exile from the battlefield':
			return def('zoneChange', {
				from: 'battlefield',
				to: 'exile',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'is put into exile':
		case 'are put into exile':
			if (subject.object !== 'attachedTo' && subject.object !== 'self') return null;
			return def('zoneChange', {
				from: 'battlefield',
				to: 'exile',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'leaves the battlefield':
		case 'leave the battlefield':
			return def('zoneChange', {
				from: 'battlefield',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'attacks':
		case 'attack':
			return def('attacks');
		case 'attacks while saddled':
		case 'attack while saddled':
			return def('attacks', { saddled: true });
		case 'blocks':
		case 'block':
			return def('blocks');
		case 'becomes blocked':
		case 'become blocked':
			return subject.oneOrMore ? null : def('becomesBlocked');
		case 'becomes tapped':
			return def('becomesTapped');
		case 'becomes crewed':
			return def('becomesCrewed');
		case 'becomes saddled':
			return def('becomesSaddled');
		case 'is exerted':
		case 'are exerted':
			return def('exert');
		case 'is dealt damage':
		case 'are dealt damage':
			return subject.oneOrMore ? null : def('dealtDamage');
		case 'is dealt combat damage':
		case 'are dealt combat damage':
			return subject.oneOrMore ? null : def('dealtDamage', { combat: true });
		case 'is dealt noncombat damage':
		case 'are dealt noncombat damage':
			return subject.oneOrMore ? null : def('dealtDamage', { noncombatOnly: true });
		case 'deals combat damage to a player':
		case 'deal combat damage to a player':
			return subject.oneOrMore
				? def('combatDamageBatchPlayer', { player: { relation: 'any' } })
				: def('dealsDamage', { combat: true, damageTo: 'player' });
		case 'deals combat damage to an opponent':
		case 'deals combat damage to one of your opponents':
		case 'deal combat damage to an opponent':
		case 'deal combat damage to one of your opponents':
			return subject.oneOrMore
				? def('combatDamageBatchPlayer', { player: { relation: 'opponent' } })
				: def('dealsDamage', { combat: true, damageTo: 'player', player: { relation: 'opponent' } });
		case 'deals combat damage to you':
		case 'deal combat damage to you':
			return subject.oneOrMore
				? def('combatDamageBatchPlayer', { player: { relation: 'you' } })
				: def('dealsDamage', { combat: true, damageTo: 'player', player: { relation: 'you' } });
		case 'deals combat damage to a creature':
		case 'deal combat damage to a creature':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: true, damageTo: 'creature' });
		case 'deals combat damage to a player or planeswalker':
		case 'deal combat damage to a player or planeswalker':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: true, damageTo: 'playerOrPlaneswalker' });
		case 'deals combat damage to a player or battle':
		case 'deal combat damage to a player or battle':
			return subject.oneOrMore
				? null
				: def('dealsDamage', {
						combat: true,
						damageTargetKind: 'playerOrBattle',
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
		case 'deals combat damage to a planeswalker':
		case 'deal combat damage to a planeswalker':
			return subject.oneOrMore
				? null
				: def('dealsDamage', { combat: true, damageTargetKind: 'planeswalker' });
		case 'deals combat damage':
		case 'deal combat damage':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: true, damageTo: 'any' });
		case 'deals damage to a player':
		case 'deal damage to a player':
			return subject.oneOrMore ? null : def('dealsDamage', { damageTo: 'player' });
		case 'deals damage to a creature':
		case 'deal damage to a creature':
			return subject.oneOrMore
				? null
				: def('dealsDamage', {
						damageTo: 'creature',
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
		case 'deals damage to a planeswalker':
		case 'deal damage to a planeswalker':
			return subject.oneOrMore ? null : def('dealsDamage', { damageTargetKind: 'planeswalker' });
		case 'deals damage to an opponent':
		case 'deals damage to one of your opponents':
		case 'deal damage to an opponent':
		case 'deal damage to one of your opponents':
			return subject.oneOrMore
				? null
				: def('dealsDamage', { damageTo: 'player', player: { relation: 'opponent' } });
		case 'deals damage to you':
		case 'deal damage to you':
			return subject.oneOrMore
				? null
				: def('dealsDamage', { damageTo: 'player', player: { relation: 'you' } });
		case 'deals damage':
		case 'deal damage':
			return subject.oneOrMore ? null : def('dealsDamage', { damageTo: 'any' });
		case 'becomes the target of a spell or ability':
			return subject.oneOrMore ? null : def('becomesTarget', { targetedBy: 'spellOrAbility' });
		case 'becomes the target of a spell':
			return subject.oneOrMore ? null : def('becomesTarget', { targetedBy: 'spell' });
		case 'becomes the target of an ability':
			return subject.oneOrMore ? null : def('becomesTarget', { targetedBy: 'ability' });
		case 'is tapped for mana':
			return def(
				'tappedForMana',
				subject.attachedFilter?.subtypes ? { attachedFilter: subject.attachedFilter } : {}
			);
		// --- Track P19b ---
		case 'is tapped for mana of the chosen color':
			return def('tappedForMana', {
				tappedManaChosenColor: true,
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'enters during the declare attackers step':
		case 'enter during the declare attackers step':
		case 'enters the battlefield during the declare attackers step':
		case 'enter the battlefield during the declare attackers step':
			return def('zoneChange', { to: 'battlefield', duringStep: 'declare_attackers' });
		case 'enters during combat':
		case 'enter during combat':
		case 'enters the battlefield during combat':
		case 'enter the battlefield during combat':
			return def('zoneChange', { to: 'battlefield', duringCombat: true });
		case 'dies during combat':
		case 'die during combat':
			return def('zoneChange', {
				from: 'battlefield',
				to: 'graveyard',
				duringCombat: true,
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'deals combat damage to enchanted player':
		case 'deal combat damage to enchanted player':
			return subject.oneOrMore
				? null
				: def('dealsDamage', {
						combat: true,
						damageTo: 'player',
						damageTargetEnchantedPlayer: true,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
		case 'deals damage to enchanted player':
		case 'deal damage to enchanted player':
			return subject.oneOrMore
				? null
				: def('dealsDamage', {
						damageTo: 'player',
						damageTargetEnchantedPlayer: true,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
		case 'becomes plotted':
			return subject.object === 'self'
				? { event: 'plot', filter: { object: 'self' }, fromZone: 'exile' }
				: null;
		case 'evolves':
		case 'evolve':
			return subject.oneOrMore ? null : def('evolved');
		case 'becomes crewed for the first time each turn':
			return subject.oneOrMore ? null : def('becomesCrewed', { firstTimeEachTurn: true });
		case 'crews a vehicle':
		case 'crews a Vehicle':
		case 'crew a vehicle':
		case 'crew a Vehicle':
			return subject.oneOrMore ? null : def('crewedVehicle');
		case 'attacks this turn':
		case 'attack this turn':
			return { ...def('attacks'), spellDelayed: 'thisTurn' };
		case 'blocks this turn':
		case 'block this turn':
			return { ...def('blocks'), spellDelayed: 'thisTurn' };
		case 'dies this turn':
		case 'die this turn':
			return {
				...def('zoneChange', {
					from: 'battlefield',
					to: 'graveyard',
					...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
				}),
				spellDelayed: 'thisTurn'
			};
		// --- End Track P19b ---
		case 'becomes attached to a creature':
			return def('attached', { host: { types: ['Creature'] } });
		case 'becomes attached to a creature you control':
			return def('attached', { host: { types: ['Creature'], controller: 'you' } });
		case 'transforms':
		case 'transform':
			return def(
				'transforms',
				subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
			);
		case 'is turned face up':
		case 'are turned face up':
			return def(
				'turnFaceUp',
				subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
			);
		case 'explores':
		case 'explore':
			return def('explore');
		case 'connives':
		case 'connive':
			return def('connive');
		// --- Track P5 ---
		case 'becomes monstrous':
		case 'become monstrous':
			return def('becameMonstrous');
		// --- Track P10 ---
		case "attacks and isn't blocked":
		case "attack and aren't blocked":
		case 'attacks and is not blocked':
		case 'attack and are not blocked':
			return def(
				'attackedAndUnblocked',
				subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
			);
		case 'attacks alone':
		case 'attack alone':
			return subject.oneOrMore
				? null
				: def('attacks', {
						alone: true,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
		case 'becomes untapped':
		case 'become untapped':
			return subject.oneOrMore
				? null
				: def(
						'becomesUntapped',
						subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
					);
		case 'deals noncombat damage to a player':
		case 'deal noncombat damage to a player':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: false, damageTo: 'player' });
		case 'deals noncombat damage to an opponent':
		case 'deals noncombat damage to one of your opponents':
		case 'deal noncombat damage to an opponent':
		case 'deal noncombat damage to one of your opponents':
			return subject.oneOrMore
				? null
				: def('dealsDamage', {
						combat: false,
						damageTo: 'player',
						player: { relation: 'opponent' }
					});
		case 'deals noncombat damage to you':
		case 'deal noncombat damage to you':
			return subject.oneOrMore
				? null
				: def('dealsDamage', { combat: false, damageTo: 'player', player: { relation: 'you' } });
		case 'deals noncombat damage to a creature':
		case 'deal noncombat damage to a creature':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: false, damageTo: 'creature' });
		case 'deals noncombat damage':
		case 'deal noncombat damage':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: false, damageTo: 'any' });
		case 'exploits a creature':
		case 'exploit a creature':
			return subject.oneOrMore ? null : def('exploited');
		case 'blocks or becomes blocked':
		case 'block or become blocked':
			return subject.oneOrMore
				? null
				: def(
						'blocksOrBecomesBlocked',
						subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
					);
		// --- End Track P10 ---
		// --- Track P16b ---
		case 'mutates':
		case 'mutate':
			return subject.oneOrMore ? null : def('mutates');
		case 'phases in':
		case 'phase in':
			return subject.oneOrMore ? null : def('phasedIn');
		case 'becomes unattached':
		case 'becomes unattached from a permanent':
		case 'becomes unattached from a creature':
			return subject.oneOrMore ? null : def('unattached');
		case 'becomes paired with another creature':
			return subject.object === 'self' ? def('soulbondPaired') : null;
		case 'attacks a planeswalker':
		case 'attack a planeswalker':
			return def('attacks', { attackedTarget: 'planeswalker' });
		case 'attacks a battle':
		case 'attack a battle':
			return def('attacks', { attackedTarget: 'battle' });
		// --- End Track P16b ---
		default: {
			// --- Track P16b ---
			// CR 603.6c: "is/are put into [your/an opponent's/a] graveyard from anywhere [other than the battlefield] [during your turn]"
			const gyAnywhere = verb.match(
				/^(?:is|are) put into (your|an opponent's|a|a player's) graveyard from anywhere( other than the battlefield)?( during your turn)?$/i
			);
			if (gyAnywhere) {
				const whose = gyAnywhere[1].toLowerCase();
				const extra: EventFilter = {
					to: 'graveyard',
					fromAnywhere: true,
					...(gyAnywhere[2] ? { notFromZone: 'battlefield' } : {}),
					...(gyAnywhere[3] ? { duringTurn: 'your' } : {})
				};
				if (subject.object === 'self') {
					return { event: 'zoneChange', filter: { ...base, ...extra }, fromZone: 'graveyard' };
				}
				if (typeof base.object === 'object') {
					const objFilter: ObjectFilter = {
						...base.object,
						...(subject.isCardNoun && base.object.token === undefined ? { token: false } : {}),
						...(whose === 'your'
							? { owner: 'you' }
							: whose === "an opponent's"
								? { owner: 'opponent' }
								: {})
					};
					return { event: 'zoneChange', filter: { ...base, object: objFilter, ...extra } };
				}
			}
			// "is/are put into [your/an opponent's] graveyard from the battlefield"
			const gyFromBf = verb.match(
				/^(?:is|are) put into (your|an opponent's) graveyard from the battlefield$/i
			);
			if (gyFromBf) {
				const whose = gyFromBf[1].toLowerCase();
				if (subject.object === 'self') {
					if (whose !== 'your') return null;
					return def('zoneChange', { from: 'battlefield', to: 'graveyard' });
				}
				if (typeof base.object === 'object') {
					const owner: ObjectFilter['owner'] = whose === 'your' ? 'you' : 'opponent';
					return {
						event: 'zoneChange',
						filter: {
							...base,
							object: { ...base.object, owner },
							from: 'battlefield',
							to: 'graveyard'
						}
					};
				}
			}
			// "is/are put into [your/an opponent's/a] graveyard from [your/their/its owner's/a] library"
			const gyFromLib = verb.match(
				/^(?:is|are) put into (your|an opponent's|a) graveyard from (?:your|their|its owner's|a) library$/i
			);
			if (gyFromLib) {
				const whose = gyFromLib[1].toLowerCase();
				if (subject.object === 'self') {
					if (whose === "an opponent's") return null;
					return {
						event: 'zoneChange',
						filter: { ...base, from: 'library', to: 'graveyard' },
						fromZone: 'graveyard'
					};
				}
				if (typeof base.object === 'object') {
					const objFilter: ObjectFilter = {
						...base.object,
						...(whose === 'your'
							? { owner: 'you' }
							: whose === "an opponent's"
								? { owner: 'opponent' }
								: {})
					};
					return {
						event: 'zoneChange',
						filter: { ...base, object: objFilter, from: 'library', to: 'graveyard' }
					};
				}
			}
			// Attacks against specific player/planeswalker targets (never matching "~ attacks a player")
			if (typeof base.object === 'object' || base.object === 'self') {
				if (/^attacks? you$/i.test(verb)) {
					return def('attacks', { attackedTarget: 'you' });
				}
				if (/^attacks? you or a planeswalker you control$/i.test(verb)) {
					return def('attacks', { attackedTarget: 'youOrPlaneswalkerYouControl' });
				}
				if (/^attacks? enchanted player$/i.test(verb)) {
					return def('attacks', { attackedTarget: 'enchantedPlayer' });
				}
			}
			if (typeof base.object === 'object') {
				if (/^attacks? (?:an opponent|one of your opponents)$/i.test(verb)) {
					return def('attacks', { attackedTarget: 'opponent' });
				}
				if (
					/^attacks? (?:an opponent|one of your opponents) or a planeswalker an opponent controls$/i.test(
						verb
					)
				) {
					return def('attacks', {
						attackedTarget: 'opponentOrPlaneswalkerOpponentControls'
					});
				}
			}
			// --- End Track P16b ---
			// --- Track P19b ---
			const tappedColorObj = verb.match(/^is tapped for \{([WUBRGC])\}$/i);
			if (tappedColorObj) {
				return def('tappedForMana', {
					tappedManaColor: tappedColorObj[1].toUpperCase() as ManaColor,
					...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
				});
			}
			const atkNthTurn = verb.match(/^attacks? for the (\S+) time each turn$/i);
			if (atkNthTurn && !subject.oneOrMore) {
				const ord = parseExtendedOrdinal(atkNthTurn[1]);
				if (ord !== null) {
					return def('attacks', {
						...(ord === 1 ? { firstTimeEachTurn: true } : { nthEventThisTurn: ord }),
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			const firstTimeTgt = verb.match(
				/^becomes? the target of (a spell or ability|a spell|an ability)(?: (an opponent controls|your opponents control|you don't control))? for the first time each turn$/i
			);
			if (firstTimeTgt && !subject.oneOrMore) {
				const rawBy = firstTimeTgt[1].toLowerCase();
				const targetedBy: EventFilter['targetedBy'] =
					rawBy === 'a spell' ? 'spell' : rawBy === 'an ability' ? 'ability' : 'spellOrAbility';
				const player: EventFilter['player'] = firstTimeTgt[2] ? { relation: 'opponent' } : undefined;
				return def('becomesTarget', {
					targetedBy,
					firstTimeEachTurn: true,
					...(player ? { player } : {}),
					...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
				});
			}
			const dmgToFiltered = verb.match(/^deals? (combat |noncombat )?damage to (?:a|an) (.+)$/i);
			if (
				dmgToFiltered &&
				!subject.oneOrMore &&
				!/\b(?:player|opponent)\b/i.test(dmgToFiltered[2])
			) {
				const tgtFilter = parseP16bObjectPhrase(dmgToFiltered[2]);
				if (tgtFilter) {
					const rawKind = dmgToFiltered[1]?.trim().toLowerCase();
					return def('dealsDamage', {
						...(rawKind === 'combat'
							? { combat: true }
							: rawKind === 'noncombat'
								? { combat: false }
								: {}),
						damageTargetKind: 'permanent',
						damageTargetFilter: tgtFilter,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			// --- End Track P19b ---
			// --- Track P10 ---
			const bobb = verb.match(/^blocks? or becomes? blocked by (?:a|an) (.+)$/i);
			if (bobb && !subject.oneOrMore) {
				const host = parseP16bObjectPhrase(bobb[1]);
				if (host) {
					return def('blocksOrBecomesBlocked', {
						host,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			const blocksHost = verb.match(/^blocks? (?:a|an) (.+)$/i);
			if (blocksHost && !subject.oneOrMore) {
				const host = parseP16bObjectPhrase(blocksHost[1]);
				if (host) {
					return def('blocks', {
						host,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			const blockedByHost = verb.match(/^becomes? blocked by (?:a|an) (.+)$/i);
			if (blockedByHost && !subject.oneOrMore) {
				const host = parseP16bObjectPhrase(blockedByHost[1]);
				if (host) {
					return def('becomesBlocked', {
						host,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			// --- End Track P10 ---
			// --- Track P13 ---
			if (/^transforms? into ~$/i.test(verb) && subject.object === 'self') {
				return def('transforms');
			}
			const becomesAttached = verb.match(/^becomes? attached to (?:a|an) (.+)$/i);
			if (becomesAttached && !subject.oneOrMore) {
				const host = parseP16bObjectPhrase(becomesAttached[1]);
				if (host) return def('attached', { host });
			}
			const valiantTgt = verb.match(
				/^becomes? the target of (a spell or ability|a spell|an ability) you control for the first time each turn$/i
			);
			if (valiantTgt && !subject.oneOrMore) {
				const rawBy = valiantTgt[1].toLowerCase();
				const targetedBy: EventFilter['targetedBy'] =
					rawBy === 'a spell' ? 'spell' : rawBy === 'an ability' ? 'ability' : 'spellOrAbility';
				return def('becomesTarget', {
					targetedBy,
					player: { relation: 'you' },
					firstTimeTargetedByYouThisTurn: true
				});
			}
			// --- End Track P13 ---
			const transInto = verb.match(/^transforms? into (.+)$/i);
			if (transInto) {
				const phrase = transInto[1].replace(/^(?:a|an)\s+/i, '').trim();
				const qual = parseP16bObjectPhrase(phrase);
				if (qual) return def('transforms', { toFaceFilter: qual });
			}
			const becomesTgt = verb.match(
				/^becomes? the target of (a spell or ability|a spell|an ability)(?: (an opponent controls|your opponents control|you don't control|you control))?$/i
			);
			if (becomesTgt && !subject.oneOrMore) {
				const rawBy = becomesTgt[1].toLowerCase();
				const targetedBy: EventFilter['targetedBy'] =
					rawBy === 'a spell' ? 'spell' : rawBy === 'an ability' ? 'ability' : 'spellOrAbility';
				const rawCtrl = becomesTgt[2]?.toLowerCase();
				const player: EventFilter['player'] = !rawCtrl
					? undefined
					: rawCtrl === 'you control'
						? { relation: 'you' }
						: { relation: 'opponent' };
				return def('becomesTarget', { targetedBy, ...(player ? { player } : {}) });
			}
			// --- Track P16b: filtered targeting source ("becomes the target of an instant or sorcery spell / Aura spell") ---
			const becomesFilteredTgt = verb.match(
				/^becomes? the target of (?:a|an) (.+?) (spell or ability|spell|ability)(?: (an opponent controls|your opponents control|you don't control|you control))?$/i
			);
			if (becomesFilteredTgt && !subject.oneOrMore && !/\bbackup\b/i.test(becomesFilteredTgt[1])) {
				const rawKind = becomesFilteredTgt[2].toLowerCase();
				const targetedBy: EventFilter['targetedBy'] =
					rawKind === 'spell' ? 'spell' : rawKind === 'ability' ? 'ability' : 'spellOrAbility';
				const srcFilter = parseP16bObjectPhrase(
					targetedBy === 'spell' ? `${becomesFilteredTgt[1]} spell` : becomesFilteredTgt[1],
					{ allowSpellNoun: targetedBy !== 'ability' }
				);
				if (srcFilter && Object.keys(srcFilter).length > 0) {
					const rawCtrl = becomesFilteredTgt[3]?.toLowerCase();
					const player: EventFilter['player'] = !rawCtrl
						? undefined
						: rawCtrl === 'you control'
							? { relation: 'you' }
							: { relation: 'opponent' };
					return def('becomesTarget', {
						targetedBy,
						targetingSourceFilter: srcFilter,
						...(player ? { player } : {})
					});
				}
			}
			// --- End Track P16b ---
			return null;
		}
	}
}

/** "Whenever ~ enters or attacks", "Whenever ~ attacks or blocks", "When ~ enters, attacks, or dies". */
function objectEvents(verbs: string, subject: Subject): TriggerDef | null {
	const whole = objectEvent(verbs, subject);
	if (whole) return whole;
	// --- Track P16b ---
	if (
		subject.object === 'self' &&
		/^enters(?: the battlefield)? or the creature (?:it|~) haunts dies$/i.test(verbs)
	) {
		return {
			event: 'zoneChange',
			filter: { object: 'self', to: 'battlefield' },
			or: [{ event: 'hauntedCreatureDies', filter: { object: 'self' }, fromZone: 'exile' }]
		};
	}
	if (!/\bor\b/i.test(verbs)) return null;
	// --- End Track P16b ---
	const parts = verbs.split(/,? or |, /);
	if (parts.length < 2) return null;
	const defs = parts.map((v) => objectEvent(v.trim(), subject));
	if (defs.some((d) => !d)) return null;
	return { ...defs[0]!, or: defs.slice(1) as TriggerDef[] };
}

/** The spell part of "you cast a creature spell": "a spell", "an instant or sorcery spell", "~". */
function spellFilter(text: string): EventFilter['object'] | null {
	if (text === '~') return 'self';
	const m = text.match(/^(?:(another)\s+|(?:a|an)\s+)(.+)$/i);
	if (!m) return null;
	const core = m[1] ? `another ${m[2]}` : m[2];
	if (/^spell$/i.test(core)) return {};
	if (/^another spell$/i.test(core)) return { other: true };
	if (!/\bspell\b/i.test(core)) return null;
	const parsed = parseP16bObjectPhrase(core, { allowSpellNoun: true });
	return parsed ?? null;
}

function discardedCardFilter(text: string): { object: ObjectFilter; oneOrMore?: true } | null {
	if (text === '~') return null;
	if (/^another card$/i.test(text)) return { object: { other: true } };
	const anotherM = text.match(/^another (.+)$/i);
	if (anotherM) {
		const inner = anotherM[1].trim();
		if (!/\bcards?$/i.test(inner)) return null;
		const parsed = parseP16bObjectPhrase(`another ${inner}`);
		return parsed ? { object: parsed } : null;
	}
	const batchM = text.match(/^one or more (.+)$/i);
	if (batchM) {
		const inner = batchM[1].trim();
		if (/^cards$/i.test(inner)) return { object: {}, oneOrMore: true };
		if (!/\bcards$/i.test(inner)) return null;
		const parsed = parseP16bObjectPhrase(inner);
		return parsed ? { object: parsed, oneOrMore: true } : null;
	}
	const m = text.match(/^(?:a|an) (.+)$/i);
	if (!m) return null;
	const inner = m[1].trim();
	if (/^card$/i.test(inner)) return { object: {} };
	if (!/\bcard$/i.test(inner)) return null;
	const parsed = parseP16bObjectPhrase(inner);
	return parsed ? { object: parsed } : null;
}

const ORDINAL_WORDS: Record<string, 1 | 2 | 3> = {
	first: 1,
	second: 2,
	third: 3
};

function playerEvent(player: EventFilter['player'], rest: string): TriggerDef | null {
	if (player?.relation === 'you' && rest === 'cycle ~') {
		return { event: 'cycle', filter: { object: 'self', player }, fromZone: 'any' };
	}
	// --- Track P16b ---
	if (player?.relation === 'you' && /^cast or cycle ~$/i.test(rest)) {
		return {
			event: 'cast',
			filter: { object: 'self', player },
			or: [{ event: 'cycle', filter: { object: 'self', player }, fromZone: 'any' }]
		};
	}
	if (rest === 'discard ~' || rest === 'discards ~') {
		return { event: 'discard', filter: { object: 'self', player }, fromZone: 'any' };
	}
	// --- End Track P16b ---
	const cycleOrDiscard = rest.match(/^(?:cycle or discard|cycles or discards) (.+)$/);
	if (cycleOrDiscard) {
		const dc = discardedCardFilter(cycleOrDiscard[1]);
		if (dc) {
			return {
				event: 'discard',
				filter: { player, object: dc.object, ...(dc.oneOrMore ? { oneOrMore: true } : {}) }
			};
		}
	}
	const cycle = rest.match(/^cycles? (.+)$/);
	if (cycle) {
		const dc = discardedCardFilter(cycle[1]);
		if (dc && !dc.oneOrMore) return { event: 'cycle', filter: { player, object: dc.object } };
	}
	const discard = rest.match(/^discards? (.+)$/);
	if (discard) {
		const dc = discardedCardFilter(discard[1]);
		if (dc) {
			return {
				event: 'discard',
				filter: { player, object: dc.object, ...(dc.oneOrMore ? { oneOrMore: true } : {}) }
			};
		}
	}
	const nthCast = rest.match(/^casts? (your|their) (first|second|third) spell (?:each turn|in a turn)$/);
	if (nthCast) {
		if ((nthCast[1] === 'your') !== (player?.relation === 'you')) return null;
		return { event: 'cast', filter: { object: {}, player, nthThisTurn: ORDINAL_WORDS[nthCast[2]] } };
	}
	// --- Track P16b: filtered & timing-scoped ordinal cast triggers ---
	const ordCast = rest.match(
		/^casts? (your|their) (first|second|third) (?:(.+?) )?spell(s?)(?: (.+?))? (?:from (?:your |their |a )?(graveyard|exile) )?(each turn|in a turn|during each opponent's turn|during an opponent's turn|during each of your turns|during your turn|during their turn)$/i
	);
	if (ordCast && !ordCast[4]) {
		if ((ordCast[1].toLowerCase() === 'your') !== (player?.relation === 'you')) return null;
		const ord = ORDINAL_WORDS[ordCast[2].toLowerCase()];
		if (ord) {
			const preMod = ordCast[3]?.trim();
			const postMod = ordCast[5]?.trim();
			let objFilter: ObjectFilter = {};
			if (preMod || postMod) {
				const rawSpellPhrase = `a ${preMod ? `${preMod} ` : ''}spell${postMod ? ` ${postMod}` : ''}`;
				const sf = spellFilter(rawSpellPhrase);
				if (!sf || sf === 'self' || sf === 'attachedTo') return null;
				objFilter = sf;
			}
			const zoneWord = ordCast[6]?.toLowerCase();
			const castFromZone: ZoneType | undefined =
				zoneWord === 'exile' ? 'exile' : zoneWord === 'graveyard' ? 'graveyard' : undefined;
			const timingRaw = ordCast[7].toLowerCase();
			const duringTurn: EventFilter['duringTurn'] =
				timingRaw === "during each opponent's turn" || timingRaw === "during an opponent's turn"
					? 'opponent'
					: timingRaw === 'during each of your turns' || timingRaw === 'during your turn'
						? 'your'
						: timingRaw === 'during their turn'
							? 'eventPlayer'
							: undefined;
			return {
				event: 'cast',
				filter: {
					object: objFilter,
					player,
					spellOrdinal: ord,
					...(castFromZone ? { castFromZone } : {}),
					...(duringTurn ? { duringTurn } : {})
				}
			};
		}
	}
	const notFirstCast = rest.match(
		/^casts? a (?:(.+?) )?spell (?:during (your|their) turn )?other than (?:your|their|the) first (?:(.+?) )?spell(?: (?:they|that player|you) casts?)? (?:each|that) turn$/i
	);
	if (notFirstCast) {
		const mod1 = (notFirstCast[1] ?? '').trim().toLowerCase();
		const mod2 = (notFirstCast[3] ?? '').trim().toLowerCase();
		if (mod1 === mod2) {
			let objFilter: ObjectFilter = {};
			if (notFirstCast[1]) {
				const sf = spellFilter(`a ${notFirstCast[1].trim()} spell`);
				if (!sf || sf === 'self' || sf === 'attachedTo') return null;
				objFilter = sf;
			}
			const turnWord = notFirstCast[2]?.toLowerCase();
			const duringTurn: EventFilter['duringTurn'] =
				turnWord === 'your' ? 'your' : turnWord === 'their' ? 'eventPlayer' : undefined;
			return {
				event: 'cast',
				filter: {
					object: objFilter,
					player,
					spellOrdinal: -1,
					...(duringTurn ? { duringTurn } : {})
				}
			};
		}
	}
	const castYourTurn = rest.match(/^(cast or copy|casts or copies|casts?) (.+?) during your turn$/i);
	if (castYourTurn) {
		const object = spellFilter(castYourTurn[2]);
		if (object === null) return null;
		const filter: EventFilter = { object, player, duringTurn: 'your' };
		if (/copy|copies/i.test(castYourTurn[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	// --- End Track P16b ---
	const castTargetsSelf = rest.match(/^(cast or copy|casts or copies|casts?) (.+?) that targets ~$/);
	if (castTargetsSelf) {
		const object = spellFilter(castTargetsSelf[2]);
		if (object === null || object === 'self') return null;
		const filter: EventFilter = { object, player, targetsSelf: true };
		if (/copy|copies/.test(castTargetsSelf[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	// --- Track P13: Cast qualifiers (opponent's turn, Paradox, from graveyard/exile, kicked) ---
	const castOppTurn = rest.match(
		/^(cast or copy|casts or copies|casts?) (.+?) during an opponent's turn$/i
	);
	if (castOppTurn) {
		const object = spellFilter(castOppTurn[2]);
		if (object === null) return null;
		const filter: EventFilter = { object, player, duringOpponentTurn: true };
		if (/copy|copies/i.test(castOppTurn[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	const castNotHand = rest.match(
		/^(cast or copy|casts or copies|casts?) (.+?) from anywhere other than (?:your|their|its owner's) hand$/i
	);
	if (castNotHand) {
		const object = spellFilter(castNotHand[2]);
		if (object === null) return null;
		const filter: EventFilter = { object, player, castFromNotHand: true };
		if (/copy|copies/i.test(castNotHand[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	const castZone = rest.match(
		/^(cast or copy|casts or copies|casts?) (.+?) from (?:your |a |their )?(graveyard|exile|library|hand)$/i
	);
	if (castZone) {
		const object = spellFilter(castZone[2]);
		if (object === null) return null;
		const zLow = castZone[3].toLowerCase();
		const castFromZone: ZoneType =
			zLow === 'exile'
				? 'exile'
				: zLow === 'library'
					? 'library'
					: zLow === 'hand'
						? 'hand'
						: 'graveyard';
		const filter: EventFilter = { object, player, castFromZone };
		if (/copy|copies/i.test(castZone[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	// --- End Track P13 ---
	// --- Track P19b: spell-created delayed cast triggers ("When you next cast ... this turn" / "Whenever you cast ... this turn") ---
	if (player?.relation === 'you') {
		const nextCast = rest.match(/^next cast (.+?) this turn$/i);
		if (nextCast) {
			const object = spellFilter(nextCast[1]);
			if (object !== null && object !== 'self' && object !== 'attachedTo') {
				return { event: 'cast', filter: { object, player }, spellDelayed: 'nextThisTurn' };
			}
		}
	}
	const castThisTurn = rest.match(/^(cast or copy|casts or copies|casts?) (.+?) this turn$/i);
	if (castThisTurn) {
		const object = spellFilter(castThisTurn[2]);
		if (object !== null && object !== 'self' && object !== 'attachedTo') {
			const filter: EventFilter = { object, player };
			if (/copy|copies/i.test(castThisTurn[1])) filter.orCopy = true;
			return { event: 'cast', filter, spellDelayed: 'thisTurn' };
		}
	}
	// --- End Track P19b ---
	const cast = rest.match(/^(cast or copy|casts or copies|casts?) (.+)$/);
	if (cast) {
		const object = spellFilter(cast[2]);
		if (object === null) return null;
		const filter: EventFilter = { object, player };
		if (/copy|copies/.test(cast[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	if (player?.relation === 'you' && rest === 'attack') {
		return { event: 'attacks', filter: { player, oneOrMore: true } };
	}
	// --- Track P16b: player-subject attack triggers ("Whenever a player/an opponent attacks [you ...]") ---
	if (rest === 'attack' || rest === 'attacks') {
		return { event: 'attacks', filter: { player, oneOrMore: true } };
	}
	if (/^attacks? you$/i.test(rest)) {
		return { event: 'attacks', filter: { player, oneOrMore: true, attackedTarget: 'you' } };
	}
	if (/^attacks? you(?: and\/)?or (?:a|one or more) planeswalkers? you control$/i.test(rest)) {
		return {
			event: 'attacks',
			filter: { player, oneOrMore: true, attackedTarget: 'youOrPlaneswalkerYouControl' }
		};
	}
	if (player?.relation === 'you' && /^attack an opponent$/i.test(rest)) {
		return { event: 'attacks', filter: { player, oneOrMore: true, attackedTarget: 'opponent' } };
	}
	// --- End Track P16b ---
	// --- Track P19b: CR 508.3e per-attacked-player & Curse enchanted-player attack triggers ---
	if (player?.relation === 'you' && /^attack a player$/i.test(rest)) {
		return { event: 'attacks', filter: { player, oneOrMore: true, perAttackedPlayer: true } };
	}
	if (/^attacks? enchanted player$/i.test(rest)) {
		return { event: 'attacks', filter: { player, oneOrMore: true, attackedTarget: 'enchantedPlayer' } };
	}
	const atkEnchPlWith = rest.match(/^attacks? enchanted player with (\S+) or more creatures$/i);
	if (atkEnchPlWith) {
		const minN = number(atkEnchPlWith[1]);
		if (minN !== null && minN >= 1) {
			return {
				event: 'attacks',
				filter: { player, oneOrMore: true, minAttackers: minN, attackedTarget: 'enchantedPlayer' }
			};
		}
	}
	if (player?.relation === 'you') {
		const atkTargetWith = rest.match(
			/^attacks? (a player|an opponent) with (?:(\S+) or more |(?:a|an) )(.+)$/i
		);
		if (atkTargetWith) {
			const minN = atkTargetWith[2] ? number(atkTargetWith[2]) : 1;
			const object = parseP16bObjectPhrase(atkTargetWith[3]);
			if (minN !== null && minN >= 1 && object) {
				const isPerPlayer = /^a player$/i.test(atkTargetWith[1]);
				return {
					event: 'attacks',
					filter: {
						player,
						oneOrMore: true,
						minAttackers: minN,
						object,
						...(isPerPlayer ? { perAttackedPlayer: true } : { attackedTarget: 'opponent' })
					}
				};
			}
		}
	}
	// --- End Track P19b ---
	if (rest === 'gain life' || rest === 'gains life') return { event: 'gainLife', filter: { player } };
	// --- Track P19b: ordinal life gain / life loss triggers ---
	const gainLifeNth = rest.match(/^gains? life for the (\S+) time each turn$/i);
	if (gainLifeNth) {
		const ord = parseExtendedOrdinal(gainLifeNth[1]);
		if (ord !== null) {
			return {
				event: 'gainLife',
				filter: {
					player,
					...(ord === 1 ? { firstTimeEachTurn: true } : { nthEventThisTurn: ord })
				}
			};
		}
	}
	const loseLifeNth = rest.match(/^loses? life for the (\S+) time each turn$/i);
	if (loseLifeNth) {
		const ord = parseExtendedOrdinal(loseLifeNth[1]);
		if (ord !== null) {
			return {
				event: 'loseLife',
				filter: {
					player,
					...(ord === 1 ? { firstTimeEachTurn: true } : { nthEventThisTurn: ord })
				}
			};
		}
	}
	// --- End Track P19b ---
	// --- Track P16b: life loss, timing-qualified life gain/loss, scry/surveil, landPlayed, dilemma, exhaust, evidence, put counters ---
	if (rest === 'lose life' || rest === 'loses life') {
		return { event: 'loseLife', filter: { player } };
	}
	const loseLifeTurn = rest.match(/^loses? life during (your|their) turn$/i);
	if (loseLifeTurn) {
		const duringTurn: EventFilter['duringTurn'] =
			loseLifeTurn[1].toLowerCase() === 'your' ? 'your' : 'eventPlayer';
		return { event: 'loseLife', filter: { player, duringTurn } };
	}
	const gainLifeTurn = rest.match(/^gains? life during (your|their) turn$/i);
	if (gainLifeTurn) {
		const duringTurn: EventFilter['duringTurn'] =
			gainLifeTurn[1].toLowerCase() === 'your' ? 'your' : 'eventPlayer';
		return { event: 'gainLife', filter: { player, duringTurn } };
	}
	const gainOrLoseLife = rest.match(
		/^(?:gain or lose|gains or loses) life(?: during (your|their) turn)?$/i
	);
	if (gainOrLoseLife) {
		const duringTurn: EventFilter['duringTurn'] = !gainOrLoseLife[1]
			? undefined
			: gainOrLoseLife[1].toLowerCase() === 'your'
				? 'your'
				: 'eventPlayer';
		const f: EventFilter = { player, ...(duringTurn ? { duringTurn } : {}) };
		return { event: 'gainLife', filter: f, or: [{ event: 'loseLife', filter: { ...f } }] };
	}
	if (/^(?:scry or surveil|scries or surveils)$/i.test(rest)) {
		return {
			event: 'scry',
			filter: { player },
			or: [{ event: 'surveil', filter: { player } }]
		};
	}
	if (/^faces? a (?:dilemma|villainous choice)$/i.test(rest)) {
		return { event: 'facedDilemma', filter: { player } };
	}
	if (/^activates? an exhaust ability$/i.test(rest)) {
		return { event: 'exhaustActivated', filter: { player } };
	}
	if (/^collects? evidence$/i.test(rest)) {
		return { event: 'collectEvidence', filter: { player } };
	}
	if (/^plays? a land$/i.test(rest)) {
		return { event: 'landPlayed', filter: { player } };
	}
	// --- Track P19b: play land / card from exile ---
	if (/^plays? a land from exile$/i.test(rest)) {
		return { event: 'landPlayed', filter: { player, castFromZone: 'exile' } };
	}
	if (/^plays? a land from anywhere other than (?:your|their) hand$/i.test(rest)) {
		return { event: 'landPlayed', filter: { player, castFromNotHand: true } };
	}
	if (/^plays? a card from exile$/i.test(rest)) {
		return {
			event: 'landPlayed',
			filter: { player, castFromZone: 'exile' },
			or: [{ event: 'cast', filter: { object: {}, player, castFromZone: 'exile' } }]
		};
	}
	if (/^plays? a card from anywhere other than (?:your|their) hand$/i.test(rest)) {
		return {
			event: 'landPlayed',
			filter: { player, castFromNotHand: true },
			or: [{ event: 'cast', filter: { object: {}, player, castFromNotHand: true } }]
		};
	}
	// --- End Track P19b ---
	const playFilteredLand = rest.match(/^plays? (?:a|an) (.+?\bland\b.*)$/i);
	if (playFilteredLand) {
		const object = parseP16bObjectPhrase(playFilteredLand[1]);
		if (object) return { event: 'landPlayed', filter: { player, object } };
	}
	if (/^commits? a crime during your turn$/i.test(rest)) {
		return { event: 'committedCrime', filter: { player, duringTurn: 'your' } };
	}
	if (rest === 'tap ~ for mana' || rest === 'taps ~ for mana') {
		return { event: 'tappedForMana', filter: { object: 'self', player } };
	}
	const putCounters = rest.match(
		/^puts? (one or more|(?:a|an)) (?:([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z][a-z -]*?) )?counters? on (~|.+)$/i
	);
	if (putCounters && player?.relation) {
		const rawCtr = putCounters[2];
		const ctr = rawCtr ? parseTriggerCounter(rawCtr) : undefined;
		if (!rawCtr || ctr) {
			const putByPlayer: EventFilter['putByPlayer'] =
				player.relation === 'you'
					? 'you'
					: player.relation === 'opponent'
						? 'opponent'
						: 'any';
			const targetRaw = putCounters[3].trim();
			if (targetRaw === '~') {
				return {
					event: 'counterPlaced',
					filter: {
						object: 'self',
						putByPlayer,
						...(ctr ? { counter: ctr } : {})
					}
				};
			}
			const subj = objectSubject(targetRaw);
			if (subj && typeof subj.object === 'object') {
				const oneOrMore = /^one or more$/i.test(putCounters[1]) || Boolean(subj.oneOrMore);
				return {
					event: 'counterPlaced',
					filter: {
						object: subj.object,
						putByPlayer,
						...(ctr ? { counter: ctr } : {}),
						...(oneOrMore ? { oneOrMore: true } : {})
					}
				};
			}
		}
	}
	if (player?.relation === 'you') {
		const atkWithSelfAnd = rest.match(/^attacks? with ~ and (?:(another .+?)|(?:a|an) (.+))$/i);
		if (atkWithSelfAnd) {
			const coFilter = parseP16bObjectPhrase(atkWithSelfAnd[1] ?? atkWithSelfAnd[2]);
			if (coFilter) {
				return {
					event: 'attacks',
					filter: { object: 'self', coAttackerFilter: coFilter, coAttackerMin: 1 }
				};
			}
		}
	}
	const sacSelfOr = rest.match(/^sacrifices? ~ or (another .+)$/i);
	if (sacSelfOr) {
		const object = parseP16bObjectPhrase(sacSelfOr[1]);
		if (object) {
			return { event: 'sacrificed', filter: { player, object, orSelf: true } };
		}
	}
	// --- End Track P16b ---
	// "Whenever you tap a land for mana" / "Whenever a player taps a Forest for mana".
	const tap = rest.match(/^taps? (?:a|an) (.+) for mana$/);
	if (tap) {
		const object = parseP16bObjectPhrase(tap[1]);
		if (object) return { event: 'tappedForMana', filter: { object, player } };
	}
	// --- Track P19b: CR 605.1b color-qualified mana taps & draw "in a turn" ---
	const tapSelfColor = rest.match(/^taps? ~ for \{([WUBRGC])\}$/i);
	if (tapSelfColor) {
		return {
			event: 'tappedForMana',
			filter: {
				object: 'self',
				player,
				tappedManaColor: tapSelfColor[1].toUpperCase() as ManaColor
			}
		};
	}
	if (/^taps? ~ for mana of the chosen color$/i.test(rest)) {
		return {
			event: 'tappedForMana',
			filter: { object: 'self', player, tappedManaChosenColor: true }
		};
	}
	const tapColor = rest.match(/^taps? (?:a|an) (.+) for \{([WUBRGC])\}$/i);
	if (tapColor) {
		const object = /^permanents?$/i.test(tapColor[1].trim())
			? ({} as ObjectFilter)
			: parseP16bObjectPhrase(tapColor[1]);
		if (object) {
			return {
				event: 'tappedForMana',
				filter: {
					object,
					player,
					tappedManaColor: tapColor[2].toUpperCase() as ManaColor
				}
			};
		}
	}
	const tapChosen = rest.match(/^taps? (?:a|an) (.+) for mana of the chosen color$/i);
	if (tapChosen) {
		const object = /^permanents?$/i.test(tapChosen[1].trim())
			? ({} as ObjectFilter)
			: parseP16bObjectPhrase(tapChosen[1]);
		if (object) {
			return {
				event: 'tappedForMana',
				filter: { object, player, tappedManaChosenColor: true }
			};
		}
	}
	// --- End Track P19b ---
	const nthDraw = rest.match(/^draws? (your|their) (first|second|third) card (?:each turn|in a turn)$/);
	if (nthDraw) {
		if ((nthDraw[1] === 'your') !== (player?.relation === 'you')) return null;
		return { event: 'drawCard', filter: { player, nthThisTurn: ORDINAL_WORDS[nthDraw[2]] } };
	}
	if (rest === 'draw a card' || rest === 'draws a card') return { event: 'drawCard', filter: { player } };
	if (rest === 'investigate' || rest === 'investigates') return { event: 'investigate', filter: { player } };
	if (rest === 'surveil' || rest === 'surveils') return { event: 'surveil', filter: { player } };
	// --- Track P5 ---
	if (rest === 'amass' || rest === 'amasses') return { event: 'amass', filter: { player } };
	const amassSub = rest.match(/^amass(?:es)? ([A-Z][A-Za-z'-]*)$/);
	if (amassSub) {
		const sub = singularSubtype(amassSub[1]);
		if (sub) return { event: 'amass', filter: { player, amassSubtype: sub } };
	}
	if (rest === 'manifest dread' || rest === 'manifests dread') {
		return { event: 'manifestDread', filter: { player } };
	}
	if (/^becomes? the monarch$/i.test(rest)) return { event: 'becameMonarch', filter: { player } };
	const turnUp = rest.match(/^turns? (?:a|an) (.+) face up$/);
	if (turnUp) {
		const object = parseP16bObjectPhrase(turnUp[1]);
		if (object) return { event: 'turnFaceUp', filter: { object, player } };
	}
	const foretell = rest.match(/^foretells? (.+)$/);
	if (foretell) {
		const dc = discardedCardFilter(foretell[1]);
		if (dc && !dc.oneOrMore) return { event: 'foretell', filter: { object: dc.object, player } };
	}
	const plot = rest.match(/^plots? (.+)$/);
	if (plot) {
		const dc = discardedCardFilter(plot[1]);
		if (dc && !dc.oneOrMore) return { event: 'plot', filter: { object: dc.object, player } };
	}
	const exert = rest.match(/^exerts? (?:(another .+?)|(?:a|an) (.+))$/);
	if (exert) {
		const object = parseP16bObjectPhrase(exert[1] ?? exert[2]);
		if (object) return { event: 'exert', filter: { object, player } };
	}
	// --- Track P10 ---
	if (player?.relation === 'you') {
		const atkMin = rest.match(/^attacks? with (\S+) or more (.+)$/i);
		if (atkMin) {
			const minN = number(atkMin[1]);
			const object = parseP16bObjectPhrase(atkMin[2]);
			if (minN !== null && minN >= 1 && object) {
				return { event: 'attacks', filter: { player, oneOrMore: true, minAttackers: minN, object } };
			}
		}
		const atkOne = rest.match(/^attacks? with (?:a|an) (.+)$/i);
		if (atkOne && !/\balone$/i.test(atkOne[1])) {
			const object = parseP16bObjectPhrase(atkOne[1]);
			if (object) {
				return { event: 'attacks', filter: { player, oneOrMore: true, minAttackers: 1, object } };
			}
		}
	}
	if (rest === 'sacrifice ~' || rest === 'sacrifices ~') {
		return { event: 'sacrificed', filter: { player, object: 'self' } };
	}
	const sac = rest.match(/^sacrifices? (one or more |another |(?:a|an) )(.+)$/i);
	if (sac) {
		const oneOrMore = /^one or more /i.test(sac[1]);
		const phrase = /^another /i.test(sac[1]) ? `another ${sac[2]}` : sac[2];
		const object = parseP16bObjectPhrase(phrase);
		if (object) {
			return {
				event: 'sacrificed',
				filter: { player, object, ...(oneOrMore ? { oneOrMore: true } : {}) }
			};
		}
	}
	if (rest === 'scry' || rest === 'scries') return { event: 'scry', filter: { player } };
	if (rest === 'commit a crime' || rest === 'commits a crime') {
		return { event: 'committedCrime', filter: { player } };
	}
	const exp = rest.match(/^expends? (\S+)$/i);
	if (exp) {
		const thresh = number(exp[1]);
		if (thresh !== null && thresh >= 1) {
			return { event: 'expended', filter: { player, expendThreshold: thresh } };
		}
	}
	if (rest === 'discover' || rest === 'discovers') return { event: 'discover', filter: { player } };
	if (rest === 'forage' || rest === 'forages') return { event: 'forage', filter: { player } };
	// --- End Track P10 ---
	// --- Track P13: Room doors, Dungeons, Initiative ---
	if (player?.relation === 'you' && /^unlock this door$/i.test(rest)) {
		return {
			event: 'doorUnlocked',
			filter: { object: 'self', player, thisDoorFaceIndex: -1 }
		};
	}
	if (/^unlocks? a door(?: of a room you control)?$/i.test(rest)) {
		return { event: 'doorUnlocked', filter: { player } };
	}
	if (/^fully unlocks? a room$/i.test(rest)) {
		return { event: 'roomFullyUnlocked', filter: { player } };
	}
	if (/^ventures? into (?:the )?(?:dungeon|undercity)$/i.test(rest)) {
		return { event: 'dungeonRoomEntered', filter: { player } };
	}
	if (/^completes? a dungeon$/i.test(rest)) {
		return { event: 'dungeonCompleted', filter: { player } };
	}
	if (/^takes? the initiative$/i.test(rest)) {
		return { event: 'tookInitiative', filter: { player } };
	}
	// --- End Track P13 ---
	// --- Track P19b: mill, dice, coin flips, tap untapped, search library, lose game, energy, proliferate ---
	const plMill = rest.match(/^mills? (one or more|(?:a|an)) (?:(.+?) )?cards?$/i);
	if (plMill) {
		const oneOrMore = /^one or more$/i.test(plMill[1]);
		const objFilter = parseGraveyardLeaveCardFilter(plMill[2]);
		if (objFilter) {
			return {
				event: 'zoneChange',
				filter: {
					player,
					object: objFilter,
					from: 'library',
					to: 'graveyard',
					...(oneOrMore ? { oneOrMore: true } : {})
				}
			};
		}
	}
	if (/^rolls? (?:one or more dice|a die)$/i.test(rest)) {
		return { event: 'dieRolled', filter: { player } };
	}
	const rollMin = rest.match(/^rolls? (?:a )?(\d+) or higher(?: on a die)?$/i);
	if (rollMin) {
		return {
			event: 'dieRolled',
			filter: { player, dieRollMin: parseInt(rollMin[1], 10) }
		};
	}
	const rollVals = rest.match(/^rolls? (?:a )?(\d+(?:(?:\s*,\s*|\s*,?\s+or\s+)\d+)*)(?: on a die)?$/i);
	if (rollVals) {
		const vals = rollVals[1]
			.split(/(?:\s*,\s*or\s+|\s+or\s+|\s*,\s*)/i)
			.map((v) => parseInt(v.trim(), 10))
			.filter((v) => Number.isFinite(v));
		if (vals.length > 0) {
			return { event: 'dieRolled', filter: { player, dieRollValues: vals } };
		}
	}
	if (/^wins? a coin flip$/i.test(rest)) {
		return { event: 'coinFlipped', filter: { player, wonCoinFlip: true } };
	}
	if (/^loses? a coin flip$/i.test(rest)) {
		return { event: 'coinFlipped', filter: { player, wonCoinFlip: false } };
	}
	if (/^flips? a coin$/i.test(rest)) {
		return { event: 'coinFlipped', filter: { player } };
	}
	const tapUntapped = rest.match(/^taps? (?:a|an) untapped (.+)$/i);
	if (tapUntapped && player?.relation) {
		const objFilter = parseP16bObjectPhrase(tapUntapped[1]);
		if (objFilter) {
			const tappedByPlayer: EventFilter['tappedByPlayer'] =
				player.relation === 'you' ? 'you' : player.relation === 'opponent' ? 'opponent' : 'any';
			return {
				event: 'becomesTapped',
				filter: { object: objFilter, tappedByPlayer }
			};
		}
	}
	if (/^search(?:es)? (?:your|their|a) library$/i.test(rest)) {
		return { event: 'librarySearched', filter: { player } };
	}
	if (/^loses the game$/i.test(rest)) {
		return { event: 'playerLostGame', filter: { player } };
	}
	if (/^gets? (?:one or more )?\{E\}$/i.test(rest)) {
		return { event: 'energyGained', filter: { player } };
	}
	if (/^proliferates?$/i.test(rest)) {
		return { event: 'proliferated', filter: { player } };
	}
	if (/^plays? a card$/i.test(rest)) {
		return mergeCompoundTriggerDefs(
			{ event: 'landPlayed', filter: { player, object: {} } },
			{ event: 'cast', filter: { player, object: {} } }
		);
	}
	// --- End Track P19b ---
	return null;
}

const PERMANENT_TYPES_LIST = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];

function parseGraveyardLeaveCardFilter(raw: string | undefined): ObjectFilter | null {
	if (!raw) return {};
	const trimmed = raw.trim();
	if (/^permanents?$/i.test(trimmed)) return { types: [...PERMANENT_TYPES_LIST] };
	const normalized = trimmed.replace(/\s+(?:and\/or|and)\s+/gi, ' or ');
	return parseP16bObjectPhrase(`${normalized} card`);
}

/** "a +1/+1 counter is put on ~", "one or more +1/+1 counters are put on a creature you control", "the last time counter is removed from ~". */
function counterEvent(head: string): TriggerDef | null {
	// Counter removed: "a +1/+1 counter is removed from ~", "the last time counter is removed from ~ while it's exiled"
	const rem = head.match(
		/^(?:(the last)|one or more|(?:a|an)) (?:([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z][a-z -]*?) )?counters? (?:is|are) removed from (~|.+?)( while it's exiled)?$/i
	);
	if (rem) {
		const lastCounter = Boolean(rem[1]);
		const rawCtr = rem[2];
		const ctr = rawCtr ? parseTriggerCounter(rawCtr) : undefined;
		if (rawCtr && !ctr) return null;
		const targetRaw = rem[3].trim();
		const whileExiled = Boolean(rem[4]);
		if (targetRaw === '~') {
			return {
				event: 'counterRemoved',
				filter: {
					object: 'self',
					...(ctr ? { counter: ctr } : {}),
					...(lastCounter ? { lastCounter: true } : {})
				},
				...(whileExiled ? { fromZone: 'exile' } : {})
			};
		}
		if (!whileExiled) {
			const subj = objectSubject(targetRaw);
			if (subj && typeof subj.object === 'object') {
				return {
					event: 'counterRemoved',
					filter: {
						object: subj.object,
						...(ctr ? { counter: ctr } : {}),
						...(lastCounter ? { lastCounter: true } : {})
					}
				};
			}
		}
	}

	// --- Track P19b: ordinal counter placed on self ("the fourth plan counter is put on ~") ---
	const nthOnSelf = head.match(
		/^the (\S+) (?:([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z][a-z -]*?) )?counter is (?:put|placed) on ~$/i
	);
	if (nthOnSelf) {
		const ord = parseExtendedOrdinal(nthOnSelf[1]);
		const rawCtr = nthOnSelf[2];
		const ctr = rawCtr ? parseTriggerCounter(rawCtr) : undefined;
		if (ord !== null && (!rawCtr || ctr)) {
			return {
				event: 'counterPlaced',
				filter: {
					object: 'self',
					...(ctr ? { counter: ctr } : {}),
					nthCounterOnSelf: ord
				}
			};
		}
	}
	// --- End Track P19b ---

	// Counter placed: "a +1/+1 counter is put on ~", "one or more +1/+1 counters are put on another creature you control"
	const m = head.match(
		/^(one or more|(?:a|an)) (?:([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z][a-z -]*?) )?counters? (?:is|are) (?:put|placed) on (~|.+)$/i
	);
	if (!m) return null;
	const rawCtr = m[2];
	const ctr = rawCtr ? parseTriggerCounter(rawCtr) : undefined;
	if (rawCtr && !ctr) return null;
	const targetRaw = m[3].trim();
	if (targetRaw === '~') {
		return {
			event: 'counterPlaced',
			filter: { object: 'self', ...(ctr ? { counter: ctr } : {}) }
		};
	}
	const subj = objectSubject(targetRaw);
	if (subj && typeof subj.object === 'object') {
		const oneOrMore = /^one or more$/i.test(m[1]) || Boolean(subj.oneOrMore);
		return {
			event: 'counterPlaced',
			filter: {
				object: subj.object,
				...(ctr ? { counter: ctr } : {}),
				...(oneOrMore ? { oneOrMore: true } : {})
			}
		};
	}
	return null;
}

// --- Track P16b: CR 603.8 State-Triggered Ability Heads ---
function parseStateTriggerBody(body: string): TriggerDef | null {
	const noCtrlAndEmptyHand = body.match(/^you control no (.+?)\s+and have no cards in hand$/i);
	if (noCtrlAndEmptyHand) {
		const c1 = parseCondition(`if you control no ${noCtrlAndEmptyHand[1].trim()}`);
		if (c1) {
			const c2: Condition = {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
				op: '=',
				right: n(0)
			};
			return {
				event: 'stateTriggered',
				isStateTrigger: true,
				filter: { stateCondition: { k: 'and', of: [c1, c2] } }
			};
		}
	}
	const noCtrl = body.match(/^you control no (.+)$/i);
	if (noCtrl) {
		const cond = parseCondition(`if you control no ${noCtrl[1].trim()}`);
		if (cond) {
			return { event: 'stateTriggered', isStateTrigger: true, filter: { stateCondition: cond } };
		}
	}
	if (/^a player other than ~'s owner controls (?:it|~)$/i.test(body)) {
		return {
			event: 'stateTriggered',
			isStateTrigger: true,
			filter: { stateCondition: { k: 'controlledByOtherThanOwner' } }
		};
	}
	const ctrAtLeast =
		body.match(/^there are (\S+) or more (.+?) counters on ~$/i) ??
		body.match(/^~ has (\S+) or more (.+?) counters on it$/i);
	if (ctrAtLeast) {
		const cnt = number(ctrAtLeast[1]);
		const ctr = parseTriggerCounter(ctrAtLeast[2]);
		if (cnt !== null && cnt >= 1 && ctr) {
			return {
				event: 'stateTriggered',
				isStateTrigger: true,
				filter: {
					stateCondition: {
						k: 'compare',
						left: { k: 'countersOn', counter: ctr, of: { k: 'self' } },
						op: '>=',
						right: n(cnt)
					}
				}
			};
		}
	}
	const ctrNone =
		body.match(/^there are no (.+?) counters on ~$/i) ??
		body.match(/^~ has no (.+?) counters on it$/i);
	if (ctrNone) {
		const ctr = parseTriggerCounter(ctrNone[1]);
		if (ctr) {
			return {
				event: 'stateTriggered',
				isStateTrigger: true,
				filter: {
					stateCondition: {
						k: 'compare',
						left: { k: 'countersOn', counter: ctr, of: { k: 'self' } },
						op: '=',
						right: n(0)
					}
				}
			};
		}
	}
	const lifeAtMost =
		body.match(/^you have (\S+) or (?:less|fewer) life$/i) ??
		body.match(/^your life total is (\S+) or (?:less|fewer)$/i);
	if (lifeAtMost) {
		const val = number(lifeAtMost[1]);
		if (val !== null) {
			return {
				event: 'stateTriggered',
				isStateTrigger: true,
				filter: {
					stateCondition: {
						k: 'compare',
						left: { k: 'life', of: { k: 'you' } },
						op: '<=',
						right: n(val)
					}
				}
			};
		}
	}
	if (/^you have no cards in hand$/i.test(body)) {
		return {
			event: 'stateTriggered',
			isStateTrigger: true,
			filter: {
				stateCondition: {
					k: 'compare',
					left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
					op: '=',
					right: n(0)
				}
			}
		};
	}
	return null;
}

function normalizeCompoundRightPronoun(left: TriggerDef, rightRaw: string): string {
	if (left.filter.object !== 'self') return rightRaw;
	if (/^(?:when|whenever)\s+you\s+sacrifice\s+it$/i.test(rightRaw)) {
		return rightRaw.replace(/\bit$/i, '~');
	}
	if (/^(?:when|whenever)\s+it\b/i.test(rightRaw)) {
		return rightRaw.replace(/^((?:when|whenever)\s+)it\b/i, '$1~');
	}
	return rightRaw;
}

function mergeCompoundTriggerDefs(left: TriggerDef, right: TriggerDef): TriggerDef {
	const rightAlts = right.or ? [{ ...right, or: undefined }, ...right.or] : [right];
	return {
		...left,
		or: [...(left.or ?? []), ...rightAlts]
	};
}
// --- End Track P16b ---

function triggerHead(head: string, depth = 0): TriggerDef | null {
	if (depth < 3) {
		// --- Track P16b: mixed event + phaseBegin ("When ~ enters and at the beginning of your upkeep") ---
		const mixedAt = head.match(
			/^((?:when|whenever) .+?)\s+(?:and|or)\s+(at (?:the beginning of .+|(?:the )?end of combat))$/i
		);
		if (mixedAt) {
			const left = triggerHead(mixedAt[1].trim(), depth + 1);
			const right = triggerHead(mixedAt[2].trim(), depth + 1);
			if (left && right) return mergeCompoundTriggerDefs(left, right);
		}
		// --- End Track P16b ---
		// --- Track P19b: CR 603.1b compound step + event ("At the beginning of <step> and/or whenever/when <event>") ---
		const atThenEvent = head.match(
			/^(at (?:the beginning of .+|(?:the )?end of combat))\s+(?:and|or)\s+((?:when|whenever) .+)$/i
		);
		if (atThenEvent) {
			const left = triggerHead(atThenEvent[1].trim(), depth + 1);
			const right = triggerHead(atThenEvent[2].trim(), depth + 1);
			if (left && right) return mergeCompoundTriggerDefs(left, right);
		}
		const twoAts = head.match(
			/^(at (?:the beginning of .+|(?:the )?end of combat))\s+(?:and|or)\s+(at (?:the beginning of .+|(?:the )?end of combat))$/i
		);
		if (twoAts) {
			const left = triggerHead(twoAts[1].trim(), depth + 1);
			const right = triggerHead(twoAts[2].trim(), depth + 1);
			if (left && right) return mergeCompoundTriggerDefs(left, right);
		}
		// --- End Track P19b ---
		const compound = head.match(/^((?:when|whenever) .+?)\s+(?:and|or)\s+((?:when|whenever) .+)$/i);
		if (compound) {
			const left = triggerHead(compound[1].trim(), depth + 1);
			if (left) {
				const normRight = normalizeCompoundRightPronoun(left, compound[2].trim());
				const right = triggerHead(normRight, depth + 1);
				if (right) return mergeCompoundTriggerDefs(left, right);
			}
		}
	}
	const at = head.match(/^at the beginning of (.+)$/i);
	if (at) return phaseBegin(at[1].toLowerCase());
	if (/^at (?:the )?end of combat$/i.test(head)) {
		return { event: 'phaseBegin', filter: { phase: 'end_combat' }, scope: 'each_turn' };
	}

	const ww = head.match(/^(when|whenever) (.+)$/i);
	if (!ww) return null;
	const kwWord = ww[1];
	const body = ww[2];

	// --- Track P16b: CR 603.8 state triggers ("When you control no Islands", etc.) ---
	if (/^when$/i.test(kwWord)) {
		const stateTrig = parseStateTriggerBody(body);
		if (stateTrig) return stateTrig;
	}
	if (/^day becomes night or night becomes day$/i.test(body)) {
		return { event: 'dayNightChanged', filter: { dayNightDirection: 'dayNightFlip' } };
	}
	if (/^it becomes day$/i.test(body)) {
		return { event: 'dayNightChanged', filter: { dayNightDirection: 'toDay' } };
	}
	if (/^it becomes night$/i.test(body)) {
		return { event: 'dayNightChanged', filter: { dayNightDirection: 'toNight' } };
	}
	if (/^it becomes day or night$/i.test(body)) {
		return { event: 'dayNightChanged', filter: { dayNightDirection: 'any' } };
	}
	if (/^the creature ~ haunts dies$/i.test(body)) {
		return { event: 'hauntedCreatureDies', filter: { object: 'self' }, fromZone: 'exile' };
	}
	const oppCausesDiscard = body.match(
		/^a spell or ability an opponent controls causes you to discard (~|.+)$/i
	);
	if (oppCausesDiscard) {
		const tgt = oppCausesDiscard[1].trim();
		if (tgt === '~') {
			return {
				event: 'discard',
				filter: { object: 'self', player: { relation: 'you' }, causedByOpponent: true },
				fromZone: 'any'
			};
		}
		const dc = discardedCardFilter(tgt);
		if (dc) {
			return {
				event: 'discard',
				filter: {
					object: dc.object,
					player: { relation: 'you' },
					causedByOpponent: true,
					...(dc.oneOrMore ? { oneOrMore: true } : {})
				}
			};
		}
	}
	const youDealtDmg = body.match(/^(?:you're|you are) dealt (?:(combat|noncombat) )?damage$/i);
	if (youDealtDmg) {
		const kindMod = youDealtDmg[1]?.toLowerCase();
		return {
			event: 'dealtDamage',
			filter: {
				damagedPlayer: 'you',
				...(kindMod === 'combat'
					? { combat: true }
					: kindMod === 'noncombat'
						? { noncombatOnly: true }
						: {})
			}
		};
	}
	const oppDealtDmg = body.match(
		/^(?:an opponent is|your opponents are) dealt (?:(combat|noncombat) )?damage$/i
	);
	if (oppDealtDmg) {
		const kindMod = oppDealtDmg[1]?.toLowerCase();
		return {
			event: 'dealtDamage',
			filter: {
				damagedPlayer: 'opponent',
				...(kindMod === 'combat'
					? { combat: true }
					: kindMod === 'noncombat'
						? { noncombatOnly: true }
						: {})
			}
		};
	}
	const youBecomeTgt = body.match(
		/^you become the target of (a spell or ability|a spell|an ability)(?: (an opponent controls|your opponents control|you don't control|you control))?$/i
	);
	if (youBecomeTgt) {
		const rawBy = youBecomeTgt[1].toLowerCase();
		const targetedBy: EventFilter['targetedBy'] =
			rawBy === 'a spell' ? 'spell' : rawBy === 'an ability' ? 'ability' : 'spellOrAbility';
		const rawCtrl = youBecomeTgt[2]?.toLowerCase();
		const player: EventFilter['player'] = !rawCtrl
			? undefined
			: rawCtrl === 'you control'
				? { relation: 'you' }
				: { relation: 'opponent' };
		return {
			event: 'becomesTarget',
			filter: { targetPlayer: 'you', targetedBy, ...(player ? { player } : {}) }
		};
	}
	const srcDealsDmgSelf = body.match(/^a source deals (combat |noncombat )?damage to ~$/i);
	if (srcDealsDmgSelf) {
		const kind = srcDealsDmgSelf[1]?.trim().toLowerCase();
		return {
			event: 'dealtDamage',
			filter: {
				object: 'self',
				...(kind === 'combat'
					? { combat: true }
					: kind === 'noncombat'
						? { noncombatOnly: true }
						: {})
			}
		};
	}
	// --- End Track P16b ---

	const counter = counterEvent(body);
	if (counter) return counter;

	// --- Track P13: The Ring tempts you ---
	if (/^the ring tempts you$/i.test(body)) {
		return { event: 'ringTempted', filter: { player: { relation: 'you' } } };
	}
	// --- End Track P13 ---

	// --- Track P10 ---
	const dealtDmgDies = body.match(
		/^(?:a )?creature dealt (?:combat )?damage by ~ this turn (?:dies|is put into a graveyard from the battlefield)$/i
	);
	if (dealtDmgDies) {
		return {
			event: 'zoneChange',
			filter: {
				object: { types: ['Creature'] },
				from: 'battlefield',
				to: 'graveyard',
				dealtDamageBySelfThisTurn: true
			}
		};
	}
	const gyLeave = body.match(
		/^(one or more|(?:a|an)) (?:(.+?) )?cards? leaves? your graveyard( during your turn)?$/i
	);
	if (gyLeave) {
		const oneOrMore = /^one or more$/i.test(gyLeave[1]);
		const object = parseGraveyardLeaveCardFilter(gyLeave[2]);
		if (object) {
			return {
				event: 'graveyardLeaveBatch',
				filter: {
					player: { relation: 'you' },
					object,
					...(oneOrMore ? { oneOrMore: true } : {}),
					...(gyLeave[3] ? { duringTurn: 'your' } : {})
				}
			};
		}
	}
	const battalion = body.match(/^~ and at least (\S+) other creatures? attack$/i);
	if (battalion) {
		const nOther = number(battalion[1]);
		if (nOther !== null && nOther >= 1) {
			return {
				event: 'attacks',
				filter: { object: 'self', minAttackers: nOther + 1 }
			};
		}
	}
	// --- End Track P10 ---
	// --- Track P16b: generalized co-attacker heads ---
	const eqBattalion = body.match(/^equipped creature and at least (\S+) other creatures? attack$/i);
	if (eqBattalion) {
		const nOther = number(eqBattalion[1]);
		if (nOther !== null && nOther >= 1) {
			return {
				event: 'attacks',
				filter: { object: 'attachedTo', minAttackers: nOther + 1 }
			};
		}
	}
	const typedCoAtk = body.match(/^~ and at least (\S+) (.+?) attack$/i);
	if (typedCoAtk) {
		const minCo = number(typedCoAtk[1]);
		const coFilter = parseP16bObjectPhrase(typedCoAtk[2]);
		if (minCo !== null && minCo >= 1 && coFilter) {
			return {
				event: 'attacks',
				filter: { object: 'self', coAttackerFilter: coFilter, coAttackerMin: minCo }
			};
		}
	}
	// --- End Track P16b ---
	// --- Track P19b ---
	if (/^enchanted player is attacked$/i.test(body)) {
		return {
			event: 'attacks',
			filter: { player: { relation: 'any' }, oneOrMore: true, attackedTarget: 'enchantedPlayer' }
		};
	}
	const manaAddedHead = body.match(
		/^a (.+?)'s ability causes (you|a player|an opponent) to add (?:one or more )?(?:mana of the chosen color|\{([WUBRGC])\})$/i
	);
	if (manaAddedHead) {
		const subj = objectSubject(`a ${manaAddedHead[1]}`);
		const pl = playerSubject(manaAddedHead[2].toLowerCase());
		if (subj && typeof subj.object === 'object' && !objectFilterProblem(subj.object) && pl) {
			return {
				event: 'manaAddedByLandAbility',
				filter: {
					object: subj.object,
					player: pl,
					...(manaAddedHead[3]
						? { tappedManaColor: manaAddedHead[3].toUpperCase() as ManaColor }
						: { tappedManaChosenColor: true })
				}
			};
		}
	}
	const youOrPermTarget = body.match(
		/^you or (a|an|another) (.+?) you control becomes? the target of (a spell or ability|a spell|an ability)(?: (an opponent controls|your opponents control|you don't control|you control))?( for the first time each turn)?$/i
	);
	if (youOrPermTarget) {
		const permSubj = objectSubject(`${youOrPermTarget[1]} ${youOrPermTarget[2]} you control`);
		if (permSubj && typeof permSubj.object === 'object' && !objectFilterProblem(permSubj.object)) {
			const rawBy = youOrPermTarget[3].toLowerCase();
			const targetedBy: 'spell' | 'ability' | 'spellOrAbility' =
				rawBy === 'a spell' ? 'spell' : rawBy === 'an ability' ? 'ability' : 'spellOrAbility';
			const rawCtrl = youOrPermTarget[4]?.toLowerCase();
			const player: PlayerFilter | undefined = !rawCtrl
				? undefined
				: rawCtrl === 'you control'
					? { relation: 'you' }
					: { relation: 'opponent' };
			const firstTime = Boolean(youOrPermTarget[5]);
			return mergeCompoundTriggerDefs(
				{
					event: 'becomesTarget',
					filter: {
						targetPlayer: 'you',
						targetedBy,
						...(player ? { player } : {}),
						...(firstTime ? { firstTimeEachTurn: true } : {})
					}
				},
				{
					event: 'becomesTarget',
					filter: {
						object: permSubj.object,
						targetedBy,
						...(player ? { player } : {}),
						...(firstTime ? { firstTimeEachTurn: true } : {})
					}
				}
			);
		}
	}
	if (/^~ is milled$/i.test(body)) {
		return {
			event: 'zoneChange',
			filter: { object: 'self', from: 'library', to: 'graveyard' },
			fromZone: 'graveyard'
		};
	}
	const cardsMilled = body.match(
		/^(one or more|(?:a|an)) (?:(.+?) )?cards? (?:is|are) milled( during your turn)?$/i
	);
	if (cardsMilled) {
		const oneOrMore = /^one or more$/i.test(cardsMilled[1]);
		const object = parseGraveyardLeaveCardFilter(cardsMilled[2]);
		if (object) {
			return {
				event: 'zoneChange',
				filter: {
					object,
					from: 'library',
					to: 'graveyard',
					...(oneOrMore ? { oneOrMore: true } : {}),
					...(cardsMilled[3] ? { duringTurn: 'your' } : {})
				}
			};
		}
	}
	const nOrMoreAttack = body.match(
		/^(\S+) or more (.+?) attack( a player| an opponent| enchanted player)?$/i
	);
	if (nOrMoreAttack) {
		const minN = number(nOrMoreAttack[1]);
		const obj = parseP16bObjectPhrase(nOrMoreAttack[2]);
		const suffix = nOrMoreAttack[3]?.trim().toLowerCase();
		if (
			minN !== null &&
			(suffix ? minN >= 1 : minN >= 2) &&
			obj &&
			!objectFilterProblem(obj) &&
			(!obj.controller || obj.controller === 'you' || obj.controller === 'opponent')
		) {
			return {
				event: 'attacks',
				filter: {
					...(obj.controller === 'you' ? { player: { relation: 'you' } } : {}),
					oneOrMore: true,
					...(minN >= 2 ? { minAttackers: minN } : {}),
					object: obj,
					...(suffix === 'a player'
						? { perAttackedPlayer: true }
						: suffix === 'an opponent'
							? { attackedTarget: 'opponent' }
							: suffix === 'enchanted player'
								? { attackedTarget: 'enchantedPlayer' }
								: {})
				}
			};
		}
	}
	// --- End Track P19b ---

	// Player subjects first ("you cast", "an opponent draws a card").
	const ps = body.match(/^(you|a player|an opponent) (.+)$/);
	if (ps) {
		const ev = playerEvent(playerSubject(ps[1])!, ps[2]);
		if (ev) return ev;
	}

	// Object subjects: try every split point between subject and verb, longest subject first.
	const words = body.split(' ');
	for (let i = words.length - 1; i >= 1; i--) {
		const subject = objectSubject(words.slice(0, i).join(' '));
		if (!subject) continue;
		const ev = objectEvents(words.slice(i).join(' '), subject);
		if (ev) return ev;
	}

	// --- Track P16b: shared When/Whenever across two distinct event clauses joined by "or" ---
	if (depth < 2 && /\s+or\s+/i.test(body)) {
		const orRegex = /\s+or\s+/gi;
		let match: RegExpExecArray | null;
		for (let guard = 0; guard < 12; guard++) {
			match = orRegex.exec(body);
			if (!match) break;
			const leftBody = body.slice(0, match.index).trim();
			const rightBody = body.slice(match.index + match[0].length).trim();
			if (!leftBody || !rightBody) continue;
			const left = triggerHead(`${kwWord} ${leftBody}`, depth + 1);
			if (!left) continue;
			let right = triggerHead(`${kwWord} ${rightBody}`, depth + 1);
			if (!right) {
				const leadPl = leftBody.match(/^(you|a player|an opponent)\s+/i);
				if (leadPl) {
					right = triggerHead(`${kwWord} ${leadPl[1]} ${rightBody}`, depth + 1);
				}
			}
			if (right) return mergeCompoundTriggerDefs(left, right);
		}
	}
	// --- End Track P16b ---
	return null;
}

// ---- Intervening-if conditions --------------------------------------------------------------

export function canonicalKickerTag(raw: string): string {
	const t = raw.trim();
	if (/^(?:\{[^}]+\})+$/i.test(t)) {
		return t.replace(/\{([^}]+)\}/g, (_, inner: string) => `{${inner.trim().toUpperCase()}}`);
	}
	return t.toLowerCase();
}

export function parseCondition(
	text: string,
	opts?: { allowDungeonCompletion?: boolean }
): Condition | null {
	const t = text.trim();
	if (/^if (?:it|~) was kicked$/i.test(t)) {
		return { k: 'kicked' };
	}
	if (/^if (?:it|~) was(?:n't| not) kicked$/i.test(t)) {
		return { k: 'not', of: { k: 'kicked' } };
	}
	if (/^if (?:it|~) was kicked twice$/i.test(t)) {
		return { k: 'kicked', minCount: 2 };
	}
	const kickedTimes = t.match(/^if (?:it|~) was kicked (\S+) times?$/i);
	if (kickedTimes) {
		const rawWord = kickedTimes[1].toLowerCase();
		const minCount = rawWord === 'once' ? 1 : number(rawWord);
		if (minCount !== null && minCount >= 1) {
			return { k: 'kicked', minCount };
		}
	}
	const kickedWithTag = t.match(/^if (?:it|~) was kicked with its (.+?) kicker$/i);
	if (kickedWithTag) {
		return { k: 'kicked', tag: canonicalKickerTag(kickedWithTag[1]) };
	}
	if (/^if (?:it|~) escaped$/i.test(t)) {
		return { k: 'escaped' };
	}
	if (/^if (?:it|~) (?:didn't|did not) escape$/i.test(t)) {
		return { k: 'not', of: { k: 'escaped' } };
	}
	if (/^if (?:its evoke cost was paid|(?:it|~) was evoked)$/i.test(t)) {
		return { k: 'evoked' };
	}
	if (/^if (?:its evoke cost was(?:n't| not) paid|(?:it|~) was(?:n't| not) evoked)$/i.test(t)) {
		return { k: 'not', of: { k: 'evoked' } };
	}
	if (/^if (?:it|~) was foretold$/i.test(t)) {
		return { k: 'foretold' };
	}
	if (/^if (?:it|~) was(?:n't| not) foretold$/i.test(t)) {
		return { k: 'not', of: { k: 'foretold' } };
	}
	if (/^if (?:(?:~|it) is|it's) saddled$/i.test(t)) {
		return { k: 'saddled' };
	}
	if (/^if (?:(?:~|it) is(?:n't| not)|it's not) saddled$/i.test(t)) {
		return { k: 'not', of: { k: 'saddled' } };
	}
	// --- Track P5 ---
	if (/^if (?:(?:~|it) (?:is|was)|it's) monstrous$/i.test(t)) {
		return { k: 'monstrous' };
	}
	if (/^if (?:(?:~|it) (?:is(?:n't| not)|was(?:n't| not))|it's not) monstrous$/i.test(t)) {
		return { k: 'not', of: { k: 'monstrous' } };
	}
	if (/^if (?:its blitz cost was paid|(?:it|~) was blitzed)$/i.test(t)) {
		return { k: 'blitzed' };
	}
	if (/^if (?:its blitz cost was(?:n't| not) paid|(?:it|~) was(?:n't| not) blitzed)$/i.test(t)) {
		return { k: 'not', of: { k: 'blitzed' } };
	}
	if (
		/^if (?:~|it|he|she|they) (?:is|are|was|were|has been|have been) exerted(?: this turn)?$/i.test(
			t
		)
	) {
		return { k: 'exertedThisTurn' };
	}
	if (
		/^if (?:(?:~|it|he|she|they) (?:is(?:n't| not)|are(?:n't| not)|was(?:n't| not)|were(?:n't| not)|has(?:n't| not) been|have(?:n't| not) been)|it's not) exerted(?: this turn)?$/i.test(
			t
		)
	) {
		return { k: 'not', of: { k: 'exertedThisTurn' } };
	}
	if (/^if you control (?:a|your) commander$/i.test(t)) {
		return { k: 'controlCommander' };
	}
	let m = t.match(/^if you have (\S+) or more life$/);
	if (m && number(m[1]) !== null) {
		return { k: 'compare', left: { k: 'life', of: { k: 'you' } }, op: '>=', right: n(number(m[1])!) };
	}
	m = t.match(/^if you control (\S+) or more (.+)$/);
	if (m && number(m[1]) !== null) {
		const filter = parseP16bObjectPhrase(m[2]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '>=', right: n(number(m[1])!) };
		}
	}
	m = t.match(/^if you control (?:(?:a|an) (.+)|(another .+))$/i);
	if (m) {
		const filter = parseP16bObjectPhrase(m[1] ?? m[2]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '>=', right: n(1) };
		}
	}
	m = t.match(/^if you control no (.+)$/);
	if (m) {
		const filter = parseP16bObjectPhrase(m[1]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '=', right: n(0) };
		}
	}
	m = t.match(/^if ~ is in your graveyard with (\S+) or more creature cards above it$/);
	if (m && number(m[1]) !== null) {
		return { k: 'graveyardAbove', filter: { types: ['Creature'] }, count: number(m[1])! };
	}
	if (t === 'if you have no cards in hand') {
		return { k: 'compare', left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } }, op: '=', right: n(0) };
	}
	if (t === "if it's your turn") return { k: 'isTurnOf', player: { k: 'you' } };
	if (t === "if it's not your turn") return { k: 'not', of: { k: 'isTurnOf', player: { k: 'you' } } };
	if (/^if you(?:'re| are) the monarch$/i.test(t)) return { k: 'isMonarch', player: { k: 'you' } };
	if (/^if you(?:'re not| aren't| are not) the monarch$/i.test(t)) {
		return { k: 'not', of: { k: 'isMonarch', player: { k: 'you' } } };
	}
	if (/^if an opponent is the monarch$/i.test(t)) return { k: 'isMonarch', relation: 'opponent' };
	if (/^if a player is the monarch$/i.test(t)) return { k: 'isMonarch', relation: 'any' };
	if (/^if there is no monarch$/i.test(t)) return { k: 'not', of: { k: 'isMonarch', relation: 'any' } };
	// --- Track P7 ---
	if (/^if a creature died this turn$/i.test(t)) return { k: 'creatureDiedThisTurn' };
	if (/^if (?:no creatures? died|a creature didn't die|a creature did not die) this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'creatureDiedThisTurn' } };
	}
	if (/^if you attacked(?: with a creature)? this turn$/i.test(t)) return { k: 'attackedThisTurn' };
	if (/^if you (?:didn't|did not) attack(?: with a creature)? this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'attackedThisTurn' } };
	}
	if (
		/^if a permanent (?:you controlled left the battlefield|left the battlefield under your control) this turn$/i.test(
			t
		)
	) {
		return { k: 'permanentLeftBattlefieldThisTurn' };
	}
	if (
		/^if no permanents? (?:you controlled left the battlefield|left the battlefield under your control) this turn$/i.test(
			t
		)
	) {
		return { k: 'not', of: { k: 'permanentLeftBattlefieldThisTurn' } };
	}
	if (/^if you(?:'ve| have)? gained life this turn$/i.test(t)) return { k: 'gainedLifeThisTurn' };
	const gainedMin = t.match(/^if you(?:'ve| have)? gained (\S+) or more life this turn$/i);
	if (gainedMin && number(gainedMin[1]) !== null) {
		return { k: 'gainedLifeThisTurn', min: n(number(gainedMin[1])!) };
	}
	if (/^if you (?:didn't gain|did not gain|haven't gained|have not gained) life this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'gainedLifeThisTurn' } };
	}
	if (/^if you cast (?:it|~) from your hand$/i.test(t)) return { k: 'wasCast', fromHand: true };
	if (/^if you (?:didn't|did not) cast (?:it|~) from your hand$/i.test(t)) {
		return { k: 'not', of: { k: 'wasCast', fromHand: true } };
	}
	if (/^if (?:you cast (?:it|~)|(?:it|~) was cast)$/i.test(t)) return { k: 'wasCast' };
	if (/^if (?:you (?:didn't|did not) cast (?:it|~)|(?:it|~) was(?:n't| not) cast)$/i.test(t)) {
		return { k: 'not', of: { k: 'wasCast' } };
	}
	// --- End Track P7 ---
	// --- Track P10 ---
	if (/^if an opponent lost life this turn$/i.test(t)) {
		return { k: 'opponentLostLifeThisTurn' };
	}
	if (/^if no opponents? lost life this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'opponentLostLifeThisTurn' } };
	}
	if (/^if you(?:'ve| have)? descended this turn$/i.test(t)) {
		return { k: 'descendedThisTurn' };
	}
	if (/^if you (?:didn't descend|did not descend|haven't descended|have not descended) this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'descendedThisTurn' } };
	}
	const hadCtr = t.match(
		/^if (?:it|~|that (?:creature|permanent)) had (?:(?:a|an|one or more) )?(?:(.+?) )?counters? on it$/i
	);
	if (hadCtr) {
		const rawCtr = hadCtr[1]?.trim();
		if (!rawCtr) return { k: 'hadCounterOnIt', counter: 'any' };
		const mapped = parseTriggerCounter(rawCtr);
		if (mapped) return { k: 'hadCounterOnIt', counter: mapped };
	}
	const hadNoCtr = t.match(
		/^if (?:it|~|that (?:creature|permanent)) (?:had no|didn't have (?:a|an|any)|did not have (?:a|an|any)) (?:(.+?) )?counters? on it$/i
	);
	if (hadNoCtr) {
		const rawCtr = hadNoCtr[1]?.trim();
		if (!rawCtr) return { k: 'not', of: { k: 'hadCounterOnIt', counter: 'any' } };
		const mapped = parseTriggerCounter(rawCtr);
		if (mapped) return { k: 'not', of: { k: 'hadCounterOnIt', counter: mapped } };
	}
	const singleSpent = t.match(/^if \{([WUBRG])\} was spent to cast (?:it|~)$/i);
	if (singleSpent) {
		return { k: 'manaColorSpentToCast', color: singleSpent[1].toUpperCase() as ManaColor };
	}
	const orSpent = t.match(/^if \{([WUBRG])\} or \{([WUBRG])\} was spent to cast (?:it|~)$/i);
	if (orSpent) {
		return {
			k: 'or',
			of: [
				{ k: 'manaColorSpentToCast', color: orSpent[1].toUpperCase() as ManaColor },
				{ k: 'manaColorSpentToCast', color: orSpent[2].toUpperCase() as ManaColor }
			]
		};
	}
	const andSpent = t.match(
		/^if (?:both )?\{([WUBRG])\} and \{([WUBRG])\} were spent to cast (?:it|~)$/i
	);
	if (andSpent) {
		return {
			k: 'and',
			of: [
				{ k: 'manaColorSpentToCast', color: andSpent[1].toUpperCase() as ManaColor },
				{ k: 'manaColorSpentToCast', color: andSpent[2].toUpperCase() as ManaColor }
			]
		};
	}
	if (/^if an opponent controls more lands than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'lands' };
	}
	if (/^if an opponent controls more creatures than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'creatures' };
	}
	if (/^if an opponent has more life than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'life' };
	}
	if (/^if an opponent has more cards in hand than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'hand' };
	}
	const gyThreshold = t.match(
		/^if (?:there are |you have )?(\S+) or more cards(?: are)? in your graveyard$/i
	);
	if (gyThreshold && number(gyThreshold[1]) !== null) {
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } },
			op: '>=',
			right: n(number(gyThreshold[1])!)
		};
	}
	const delirium = t.match(
		/^if (?:there are )?(\S+) or more card types(?: are)? among cards in your graveyard$/i
	);
	if (delirium && number(delirium[1]) !== null) {
		return {
			k: 'compare',
			left: { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' },
			op: '>=',
			right: n(number(delirium[1])!)
		};
	}
	const gyTypedCond = t.match(
		/^if (?:there are |you have )?(\S+) or more (.+?) cards(?: are)? in your graveyard$/i
	);
	if (gyTypedCond && number(gyTypedCond[1]) !== null) {
		const f = parseGraveyardLeaveCardFilter(gyTypedCond[2]);
		if (f) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } },
				op: '>=',
				right: n(number(gyTypedCond[1])!)
			};
		}
	}
	// --- End Track P10 ---
	// --- Track P13: Unified Trigger & Resolution Conditions ---
	if (/^if ~ is in your graveyard$/i.test(t)) return { k: 'selfInZone', zone: 'graveyard' };
	if (/^if ~ is in exile$/i.test(t)) return { k: 'selfInZone', zone: 'exile' };
	if (/^if ~ is on the battlefield$/i.test(t)) return { k: 'selfInZone', zone: 'battlefield' };
	if (/^if no spells were cast last turn$/i.test(t)) {
		return { k: 'spellsCastLastTurn', mode: 'none', count: 0 };
	}
	const spellsLastTurn = t.match(/^if a player cast (\S+) or more spells last turn$/i);
	if (spellsLastTurn && number(spellsLastTurn[1]) !== null) {
		return {
			k: 'spellsCastLastTurn',
			mode: 'singlePlayerAtLeast',
			count: number(spellsLastTurn[1])!
		};
	}
	if (opts?.allowDungeonCompletion) {
		if (/^if you(?:'ve| have) completed a dungeon$/i.test(t)) return { k: 'hasCompletedDungeon' };
		if (/^if you (?:haven't|have not) completed a dungeon$/i.test(t)) {
			return { k: 'not', of: { k: 'hasCompletedDungeon' } };
		}
	}
	if (/^if you have the initiative$/i.test(t)) return { k: 'hasInitiative' };
	if (/^if you have the city's blessing$/i.test(t)) return { k: 'hasCitysBlessing' };
	if (/^if you (?:don't|do not) have the city's blessing$/i.test(t)) {
		return { k: 'not', of: { k: 'hasCitysBlessing' } };
	}
	if (/^if you have max speed$/i.test(t)) return { k: 'hasMaxSpeed' };
	const poisonCond = t.match(/^if an opponent has (\S+) or more poison counters$/i);
	if (poisonCond && number(poisonCond[1]) !== null) {
		return { k: 'opponentPoisonAtLeast', min: number(poisonCond[1])! };
	}
	const celebCond = t.match(
		/^if (\S+) or more nonland permanents entered(?: the battlefield)? under your control this turn$/i
	);
	if (celebCond && number(celebCond[1]) !== null) {
		return { k: 'nonlandEnteredThisTurn', min: number(celebCond[1])! };
	}
	if (
		/^if a nonland permanent left the battlefield this turn or a spell was warped this turn$/i.test(
			t
		)
	) {
		return { k: 'voidThisTurn' };
	}
	const adamantAny = t.match(
		/^if at least (\S+) mana of the same color was spent to cast (?:it|~|this spell)$/i
	);
	if (adamantAny && number(adamantAny[1]) !== null) {
		return { k: 'sameColorManaSpentAtLeast', min: number(adamantAny[1])! };
	}
	const adamantCol = t.match(
		/^if at least (\S+) (white|blue|black|red|green) mana was spent to cast (?:it|~|this spell)$/i
	);
	if (adamantCol && number(adamantCol[1]) !== null) {
		const colMap: Record<string, ManaColor> = {
			white: 'W',
			blue: 'U',
			black: 'B',
			red: 'R',
			green: 'G'
		};
		return {
			k: 'sameColorManaSpentAtLeast',
			min: number(adamantCol[1])!,
			color: colMap[adamantCol[2].toLowerCase()]
		};
	}
	const covenCond = t.match(
		/^if you control (\S+) or more creatures with different powers$/i
	);
	if (covenCond && number(covenCond[1]) !== null) {
		return { k: 'distinctControlledCreaturePowers', count: number(covenCond[1])! };
	}
	const totalPwrCond = t.match(
		/^if creatures you control have total power (\S+) or (?:greater|more)$/i
	);
	if (totalPwrCond && number(totalPwrCond[1]) !== null) {
		return { k: 'totalPowerControlled', min: number(totalPwrCond[1])! };
	}
	const spellsThisTurn = t.match(/^if you(?:'ve| have) cast (\S+) or more spells this turn$/i);
	if (spellsThisTurn && number(spellsThisTurn[1]) !== null) {
		return { k: 'spellsCastThisTurnCount', min: number(spellsThisTurn[1])! };
	}
	const typedSpellsThisTurn = t.match(
		/^if you(?:'ve| have) cast (?:(?:a|an)|(\S+) or more) (.+?) spells? this turn$/i
	);
	if (typedSpellsThisTurn) {
		const min = typedSpellsThisTurn[1] ? number(typedSpellsThisTurn[1]) : 1;
		const sf = spellFilter(`a ${typedSpellsThisTurn[2]} spell`);
		if (min !== null && sf && sf !== 'self' && sf !== 'attachedTo') {
			return { k: 'spellsCastThisTurnCount', min, filter: sf };
		}
	}
	const gyCardsTurn = t.match(
		/^if (\S+) or more cards were put into your graveyard from anywhere this turn$/i
	);
	if (gyCardsTurn && number(gyCardsTurn[1]) !== null) {
		return {
			k: 'cardsPutIntoGraveyardFromAnywhereThisTurn',
			min: number(gyCardsTurn[1])!
		};
	}
	if (/^if ~ attacked this turn$/i.test(t)) return { k: 'boastAttackedThisTurn' };
	const selfStatCond = t.match(
		/^if ~'s (power|toughness) is (\S+) or (greater|more|less|fewer)$/i
	);
	if (selfStatCond && number(selfStatCond[2]) !== null) {
		const stat: 'power' | 'toughness' =
			selfStatCond[1].toLowerCase() === 'power' ? 'power' : 'toughness';
		const dir = selfStatCond[3].toLowerCase();
		const op = dir === 'greater' || dir === 'more' ? '>=' : '<=';
		return {
			k: 'compare',
			left: { k: 'stat', stat, of: { k: 'self' } },
			op,
			right: n(number(selfStatCond[2])!)
		};
	}
	const selfStateCond = t.match(
		/^if (?:(?:~|it) is(n't| not)?|it's( not)?) (tapped|untapped|attacking|blocking|enchanted|equipped|saddled|monstrous|modified|renowned|harnessed)$/i
	);
	if (selfStateCond) {
		const neg = Boolean(selfStateCond[1] || selfStateCond[2]);
		const st = selfStateCond[3].toLowerCase();
		const baseCond: Condition =
			st === 'tapped'
				? { k: 'objectState', of: 'self', tapped: true }
				: st === 'untapped'
					? { k: 'objectState', of: 'self', tapped: false }
					: st === 'attacking'
						? { k: 'objectState', of: 'self', attacking: true }
						: st === 'blocking'
							? { k: 'objectState', of: 'self', blocking: true }
							: st === 'enchanted'
								? { k: 'objectState', of: 'self', enchanted: true }
								: st === 'equipped'
									? { k: 'objectState', of: 'self', equipped: true }
									: st === 'saddled'
										? { k: 'objectState', of: 'self', saddled: true }
										: st === 'monstrous'
											? { k: 'objectState', of: 'self', monstrous: true }
											: st === 'modified'
												? { k: 'matchesFilter', target: { k: 'self' }, filter: { modified: true } }
												: st === 'renowned'
													? { k: 'isRenowned' }
													: { k: 'isHarnessed' };
		return neg ? { k: 'not', of: baseCond } : baseCond;
	}
	// --- Track P16b ---
	const ctrlBoth = t.match(/^if you control (?:a|an) (.+?) and (?:a|an) (.+)$/i);
	if (ctrlBoth) {
		const f1 = parseP16bObjectPhrase(ctrlBoth[1]);
		const f2 = parseP16bObjectPhrase(ctrlBoth[2]);
		if (f1 && !f1.controller && !objectFilterProblem(f1) && f2 && !f2.controller && !objectFilterProblem(f2)) {
			return {
				k: 'and',
				of: [
					{ k: 'compare', left: { k: 'count', of: { ...f1, controller: 'you' } }, op: '>=', right: n(1) },
					{ k: 'compare', left: { k: 'count', of: { ...f2, controller: 'you' } }, op: '>=', right: n(1) }
				]
			};
		}
	}
	const beholdOr = t.match(
		/^if you control (?:a|an) (.+?) or there is (?:a|an) (.+?) card in your graveyard$/i
	);
	if (beholdOr) {
		const bfFilter = parseP16bObjectPhrase(beholdOr[1]);
		const gyFilter = parseP16bObjectPhrase(`${beholdOr[2]} card`);
		if (bfFilter && !bfFilter.controller && gyFilter) {
			return {
				k: 'or',
				of: [
					{
						k: 'compare',
						left: { k: 'count', of: { ...bfFilter, controller: 'you' } },
						op: '>=',
						right: n(1)
					},
					{
						k: 'compare',
						left: { k: 'count', of: { ...gyFilter, zone: 'graveyard', controller: 'you' } },
						op: '>=',
						right: n(1)
					}
				]
			};
		}
	}
	if (/^if (?:~|it) is paired with (?:another|a) creature$/i.test(t)) return { k: 'isPaired' };
	if (/^if (?:(?:~|it) is(?:n't| not)|it's not) paired with (?:another|a) creature$/i.test(t)) {
		return { k: 'not', of: { k: 'isPaired' } };
	}
	if (/^if tribute was paid$/i.test(t)) return { k: 'tributePaid' };
	if (/^if tribute was(?:n't| not) paid$/i.test(t)) return { k: 'not', of: { k: 'tributePaid' } };
	if (/^if (?:~|it) has an enduring story$/i.test(t)) return { k: 'hasEnduringStory' };
	if (/^if (?:~|it) (?:doesn't|does not) have an enduring story$/i.test(t)) {
		return { k: 'not', of: { k: 'hasEnduringStory' } };
	}
	if (/^if (?:(?:~|it) is(?:n't| not)|it's not) harnessed$/i.test(t)) {
		return { k: 'not', of: { k: 'isHarnessed' } };
	}
	if (/^if (?:(?:~|it) (?:is(?:n't| not)|was(?:n't| not))|it's not) renowned$/i.test(t)) {
		return { k: 'not', of: { k: 'isRenowned' } };
	}
	if (/^if (?:~|it) was renowned$/i.test(t)) return { k: 'isRenowned' };
	if (/^if (?:it's|it is) day$/i.test(t)) return { k: 'isDay' };
	if (/^if (?:it's|it is) night$/i.test(t)) return { k: 'isNight' };
	if (/^if (?:it's|it is) neither day nor night$/i.test(t)) {
		return { k: 'and', of: [{ k: 'not', of: { k: 'isDay' } }, { k: 'not', of: { k: 'isNight' } }] };
	}
	if (/^if the gift was promised$/i.test(t)) return { k: 'giftPromised' };
	if (/^if the gift was(?:n't| not) promised$/i.test(t)) {
		return { k: 'not', of: { k: 'giftPromised' } };
	}
	const minTotalSpent = t.match(
		/^if at least (\S+) mana was spent to cast (?:it|~|this spell)$/i
	);
	if (minTotalSpent && number(minTotalSpent[1]) !== null) {
		return { k: 'manaColorSpentToCast', minTotal: number(minTotalSpent[1])! };
	}
	if (/^if no mana was spent to cast (?:it|~|this spell)$/i.test(t)) {
		return { k: 'not', of: { k: 'manaColorSpentToCast', minTotal: 1 } };
	}
	const doubleColorSpent = t.match(
		/^if \{([WUBRG])\}\{\1\} was spent to cast (?:it|~|this spell)$/i
	);
	if (doubleColorSpent) {
		return {
			k: 'sameColorManaSpentAtLeast',
			min: 2,
			color: doubleColorSpent[1].toUpperCase() as ManaColor
		};
	}
	const tripleColorSpent = t.match(
		/^if \{([WUBRG])\}\{\1\}\{\1\} was spent to cast (?:it|~|this spell)$/i
	);
	if (tripleColorSpent) {
		return {
			k: 'sameColorManaSpentAtLeast',
			min: 3,
			color: tripleColorSpent[1].toUpperCase() as ManaColor
		};
	}
	if (/^if (?:it's|this is) the first combat phase of the turn$/i.test(t)) {
		return { k: 'firstCombatPhaseOfTurn' };
	}
	const atkTotalPower = t.match(
		/^if you attacked with creatures with total power (\S+) or (?:greater|more)(?: this (?:combat|turn))?$/i
	);
	if (atkTotalPower && number(atkTotalPower[1]) !== null) {
		return { k: 'attackingTotalPowerAtLeast', min: number(atkTotalPower[1])! };
	}
	const atkCountTurn = t.match(/^if (\S+) or more creatures attacked this turn$/i);
	if (atkCountTurn && number(atkCountTurn[1]) !== null) {
		return { k: 'creaturesAttackedCountThisTurn', min: number(atkCountTurn[1])! };
	}
	if (/^if (?:it's not|it isn't|it is not) (?:their|that player's|its controller's) turn$/i.test(t)) {
		return { k: 'notEventPlayerTurn' };
	}
	if (/^if that player has no cards in hand$/i.test(t)) {
		return { k: 'eventPlayerHandCount', op: '=', count: 0 };
	}
	const evPlayerHand = t.match(
		/^if that player has (\S+) or (fewer|less|more|greater) cards? in hand$/i
	);
	if (evPlayerHand && number(evPlayerHand[1]) !== null) {
		const dir = evPlayerHand[2].toLowerCase();
		const op = dir === 'fewer' || dir === 'less' ? '<=' : '>=';
		return { k: 'eventPlayerHandCount', op, count: number(evPlayerHand[1])! };
	}
	const yourHandCmp = t.match(
		/^if you have (\S+) or (fewer|less|more|greater) cards? in hand$/i
	);
	if (yourHandCmp && number(yourHandCmp[1]) !== null) {
		const dir = yourHandCmp[2].toLowerCase();
		const op = dir === 'fewer' || dir === 'less' ? '<=' : '>=';
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
			op,
			right: n(number(yourHandCmp[1])!)
		};
	}
	const yourHandLt = t.match(/^if you have fewer than (\S+) cards? in hand$/i);
	if (yourHandLt && number(yourHandLt[1]) !== null) {
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
			op: '<',
			right: n(number(yourHandLt[1])!)
		};
	}
	if (/^if you have more cards in hand than each opponent$/i.test(t)) {
		return { k: 'moreCardsInHandThanEachOpponent' };
	}
	const yourLifeLe = t.match(/^if you have (\S+) or (?:less|fewer) life$/i);
	if (yourLifeLe && number(yourLifeLe[1]) !== null) {
		return {
			k: 'compare',
			left: { k: 'life', of: { k: 'you' } },
			op: '<=',
			right: n(number(yourLifeLe[1])!)
		};
	}
	const yourLifeEq = t.match(/^if you have (?:exactly )?(\S+) life$/i);
	if (yourLifeEq && number(yourLifeEq[1]) !== null) {
		return {
			k: 'compare',
			left: { k: 'life', of: { k: 'you' } },
			op: '=',
			right: n(number(yourLifeEq[1])!)
		};
	}
	const anyPlayerLifeM = t.match(
		/^if a player has (\S+) or (less|fewer|more|greater) life$/i
	);
	if (anyPlayerLifeM && number(anyPlayerLifeM[1]) !== null) {
		const dir = anyPlayerLifeM[2].toLowerCase();
		const op = dir === 'less' || dir === 'fewer' ? '<=' : '>=';
		return { k: 'anyPlayerLife', op, count: number(anyPlayerLifeM[1])! };
	}
	const oppMetricM = t.match(
		/^if an opponent has (\S+) or (fewer|less|more|greater) (life|cards in hand|cards in their graveyard)$/i
	);
	if (oppMetricM && number(oppMetricM[1]) !== null) {
		const dir = oppMetricM[2].toLowerCase();
		const op = dir === 'fewer' || dir === 'less' ? '<=' : '>=';
		const metricRaw = oppMetricM[3].toLowerCase();
		const metric: 'life' | 'hand' | 'graveyard' =
			metricRaw === 'life' ? 'life' : metricRaw === 'cards in hand' ? 'hand' : 'graveyard';
		return { k: 'anyOpponentMetric', metric, op, count: number(oppMetricM[1])! };
	}
	const drawnTurnM = t.match(/^if you(?:'ve| have) drawn (\S+) or more cards this turn$/i);
	if (drawnTurnM && number(drawnTurnM[1]) !== null) {
		return { k: 'cardsDrawnThisTurnAtLeast', min: number(drawnTurnM[1])! };
	}
	if (/^if you have a full party$/i.test(t)) {
		return {
			k: 'compare',
			left: { k: 'partyCount', player: { k: 'you' } },
			op: '>=',
			right: n(4)
		};
	}
	if (/^if no creatures are on the battlefield$/i.test(t)) {
		return {
			k: 'compare',
			left: { k: 'count', of: { types: ['Creature'] } },
			op: '=',
			right: n(0)
		};
	}
	const selfCtrsGe = t.match(
		/^if (?:there (?:is|are) (\S+) or more|(?:~|it) has (\S+) or more) (.+?) counters? on (?:~|it)$/i
	);
	if (selfCtrsGe) {
		const cnt = number(selfCtrsGe[1] ?? selfCtrsGe[2]);
		const ctr = parseTriggerCounter(selfCtrsGe[3]);
		if (cnt !== null && ctr) {
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: ctr, of: { k: 'self' } },
				op: '>=',
				right: n(cnt)
			};
		}
	}
	const selfCtrsLe = t.match(
		/^if (?:there (?:is|are) (\S+) or (?:fewer|less)|(?:~|it) has (\S+) or (?:fewer|less)) (.+?) counters? on (?:~|it)$/i
	);
	if (selfCtrsLe) {
		const cnt = number(selfCtrsLe[1] ?? selfCtrsLe[2]);
		const ctr = parseTriggerCounter(selfCtrsLe[3]);
		if (cnt !== null && ctr) {
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: ctr, of: { k: 'self' } },
				op: '<=',
				right: n(cnt)
			};
		}
	}
	if (/^if (?:there are no|(?:~|it) has no) counters on (?:~|it)$/i.test(t)) {
		return {
			k: 'compare',
			left: { k: 'countersOn', counter: 'any', of: { k: 'self' } },
			op: '=',
			right: n(0)
		};
	}
	const selfNoCtr = t.match(
		/^if (?:there are no|(?:~|it) has no) (.+?) counters? on (?:~|it)$/i
	);
	if (selfNoCtr) {
		const ctr = parseTriggerCounter(selfNoCtr[1]);
		if (ctr) {
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: ctr, of: { k: 'self' } },
				op: '=',
				right: n(0)
			};
		}
	}
	if (/^if (?:~|it) has (?:one or more )?counters on it$/i.test(t)) {
		return {
			k: 'compare',
			left: { k: 'countersOn', counter: 'any', of: { k: 'self' } },
			op: '>=',
			right: n(1)
		};
	}
	const selfHasCtr = t.match(
		/^if (?:~|it) has (?:a|an|one or more) (.+?) counters? on it$/i
	);
	if (selfHasCtr) {
		const ctr = parseTriggerCounter(selfHasCtr[1]);
		if (ctr) {
			return {
				k: 'compare',
				left: { k: 'countersOn', counter: ctr, of: { k: 'self' } },
				op: '>=',
				right: n(1)
			};
		}
	}
	if (/^if a card left your graveyard this turn$/i.test(t)) {
		return { k: 'cardLeftYourGraveyardThisTurn' };
	}
	if (/^if you(?:'ve| have)? committed a crime this turn$/i.test(t)) {
		return { k: 'committedCrimeThisTurn' };
	}
	if (/^if you(?:'ve| have)? lost life this turn$/i.test(t)) {
		return { k: 'youLostLifeThisTurn' };
	}
	if (/^if you(?:'ve| have)? gained or lost life this turn$/i.test(t)) {
		return {
			k: 'or',
			of: [{ k: 'gainedLifeThisTurn' }, { k: 'youLostLifeThisTurn' }]
		};
	}
	const playerLostLifeM = t.match(
		/^if (a player|an opponent) lost (\S+) or more life this turn$/i
	);
	if (playerLostLifeM && number(playerLostLifeM[2]) !== null) {
		const opponentOnly = /^an opponent$/i.test(playerLostLifeM[1]);
		return {
			k: 'playerLostLifeAtLeastThisTurn',
			min: number(playerLostLifeM[2])!,
			...(opponentOnly ? { opponentOnly: true } : {})
		};
	}
	if (/^if you (?:haven't|have not|didn't|did not) cast a spell this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'spellsCastThisTurnCount', min: 1 } };
	}
	if (/^if a player other than ~'s owner controls (?:it|~)$/i.test(t)) {
		return { k: 'controlledByOtherThanOwner' };
	}
	// --- End Track P16b ---
	const selfFilterCond = t.match(/^if (?:(?:~|it) is(n't| not)?|it's( not)?) (?:a|an) (.+)$/i);
	if (selfFilterCond) {
		const neg = Boolean(selfFilterCond[1] || selfFilterCond[2]);
		const f = parseP16bObjectPhrase(selfFilterCond[3]);
		if (f && !objectFilterProblem(f)) {
			const baseCond: Condition = { k: 'matchesFilter', target: { k: 'self' }, filter: f };
			return neg ? { k: 'not', of: baseCond } : baseCond;
		}
	}
	// --- End Track P13 ---
	// --- Track P16b: LKI characteristic check on event object ("if it was a creature / Human") ---
	const lkiMatched = t.match(
		/^if (?:it|that (?:creature|permanent)) was (not )?(?:a|an) (.+)$/i
	);
	if (lkiMatched) {
		const neg = Boolean(lkiMatched[1]);
		const f = parseP16bObjectPhrase(lkiMatched[2]);
		if (f && !objectFilterProblem(f)) {
			const baseCond: Condition = { k: 'eventObjectMatchedLki', filter: f };
			return neg ? { k: 'not', of: baseCond } : baseCond;
		}
	}
	// --- End Track P16b ---
	// --- Track P19b ---
	if (/^if a creature died under your control this turn$/i.test(t)) {
		return { k: 'creatureDiedUnderYourControlThisTurn' };
	}
	if (
		/^if (?:no creatures? died|a creature didn't die|a creature did not die) under your control this turn$/i.test(
			t
		)
	) {
		return { k: 'not', of: { k: 'creatureDiedUnderYourControlThisTurn' } };
	}
	if (/^if mana from a treasure was spent to cast (?:it|~|this spell)$/i.test(t)) {
		return { k: 'treasureManaSpentToCast' };
	}
	if (/^if mana from a treasure was(?:n't| not) spent to cast (?:it|~|this spell)$/i.test(t)) {
		return { k: 'not', of: { k: 'treasureManaSpentToCast' } };
	}
	if (
		/^if you (?:haven't|have not|didn't|did not) cast a spell from your hand this turn$/i.test(t)
	) {
		return { k: 'noSpellCastFromHandThisTurn' };
	}
	if (/^if you(?:'ve| have)? cast a spell from your hand this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'noSpellCastFromHandThisTurn' } };
	}
	if (/^if (?:(?:~|it) is|it's) suspended$/i.test(t)) {
		return { k: 'isSuspended' };
	}
	if (/^if (?:(?:~|it) is(?:n't| not)|it's not) suspended$/i.test(t)) {
		return { k: 'not', of: { k: 'isSuspended' } };
	}
	if (/^if you chose a creature other than ~ as your ring-bearer$/i.test(t)) {
		return { k: 'choseOtherRingBearer' };
	}
	const altCostPaidM = t.match(/^if (?:its|the) (surge|prowl|spectacle) cost was paid$/i);
	if (altCostPaidM) {
		return {
			k: 'paidAltCost',
			kind: altCostPaidM[1].toLowerCase() as 'surge' | 'prowl' | 'spectacle'
		};
	}
	const altCostNotPaidM = t.match(
		/^if (?:its|the) (surge|prowl|spectacle) cost was(?:n't| not) paid$/i
	);
	if (altCostNotPaidM) {
		return {
			k: 'not',
			of: {
				k: 'paidAltCost',
				kind: altCostNotPaidM[1].toLowerCase() as 'surge' | 'prowl' | 'spectacle'
			}
		};
	}
	const enteredUnderYouM = t.match(
		/^if (?:(?:a|an|one or more) (.+?)|(another .+?)) entered(?: the battlefield)? under your control this turn$/i
	);
	if (enteredUnderYouM) {
		const f = parseP16bObjectPhrase(enteredUnderYouM[1] ?? enteredUnderYouM[2]);
		if (f && !f.controller && !objectFilterProblem(f)) {
			return { k: 'enteredUnderYourControlThisTurn', filter: f };
		}
	}
	const youHadEnterM = t.match(
		/^if you had (?:a|an) (.+?) enter(?: the battlefield)? under your control this turn$/i
	);
	if (youHadEnterM) {
		const f = parseP16bObjectPhrase(youHadEnterM[1]);
		if (f && !f.controller && !objectFilterProblem(f)) {
			return { k: 'enteredUnderYourControlThisTurn', filter: f };
		}
	}
	const noEnteredUnderYouM = t.match(
		/^if no (.+?) entered(?: the battlefield)? under your control this turn$/i
	);
	if (noEnteredUnderYouM) {
		const f = parseP16bObjectPhrase(noEnteredUnderYouM[1]);
		if (f && !f.controller && !objectFilterProblem(f)) {
			return { k: 'not', of: { k: 'enteredUnderYourControlThisTurn', filter: f } };
		}
	}
	const gyOneCardM = t.match(
		/^if (?:there's|there is|there are|you have) (?:a|an|one or more) (.+?) cards? in your graveyard$/i
	);
	if (gyOneCardM) {
		const f =
			parseGraveyardLeaveCardFilter(gyOneCardM[1]) ??
			parseP16bObjectPhrase(`${gyOneCardM[1]} card`);
		if (f && !objectFilterProblem(f)) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } },
				op: '>=',
				right: n(1)
			};
		}
	}
	const gyMvThresholdM = t.match(
		/^if there are (\S+) or more mana values among cards in your graveyard$/i
	);
	if (gyMvThresholdM && number(gyMvThresholdM[1]) !== null) {
		return {
			k: 'distinctManaValuesInGraveyardAtLeast',
			min: number(gyMvThresholdM[1])!
		};
	}
	const ctrlExactM = t.match(/^if you control exactly (\S+) (.+)$/i);
	if (ctrlExactM && number(ctrlExactM[1]) !== null) {
		const f = parseP16bObjectPhrase(ctrlExactM[2]);
		if (f && !f.controller && !objectFilterProblem(f)) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, controller: 'you' } },
				op: '=',
				right: n(number(ctrlExactM[1])!)
			};
		}
	}
	const dontCtrlM = t.match(/^if you (?:don't|do not) control (?:a|an|any) (.+)$/i);
	if (dontCtrlM) {
		const f = parseP16bObjectPhrase(dontCtrlM[1]);
		if (f && !f.controller && !objectFilterProblem(f)) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, controller: 'you' } },
				op: '=',
				right: n(0)
			};
		}
	}
	const oppCtrlNoneM = t.match(/^if (?:your opponents control|an opponent controls) no (.+)$/i);
	if (oppCtrlNoneM) {
		const f = parseP16bObjectPhrase(oppCtrlNoneM[1]);
		if (f && !f.controller && !objectFilterProblem(f)) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, controller: 'opponent' } },
				op: '=',
				right: n(0)
			};
		}
	}
	const oppCtrlSomeM = t.match(
		/^if (?:your opponents control|an opponent controls) (?:(?:a|an)|(\S+) or more) (.+)$/i
	);
	if (oppCtrlSomeM) {
		const cnt = oppCtrlSomeM[1] ? number(oppCtrlSomeM[1]) : 1;
		const f = parseP16bObjectPhrase(oppCtrlSomeM[2]);
		if (cnt !== null && f && !f.controller && !objectFilterProblem(f)) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, controller: 'opponent' } },
				op: '>=',
				right: n(cnt)
			};
		}
	}
	if (/^if (?:~|it) entered(?: the battlefield)? this turn$/i.test(t)) {
		return { k: 'selfEnteredThisTurn' };
	}
	if (/^if (?:~|it) (?:didn't|did not) enter(?: the battlefield)? this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'selfEnteredThisTurn' } };
	}
	if (/^if that (?:creature|permanent) entered(?: the battlefield)? this turn$/i.test(t)) {
		return { k: 'eventObjectEnteredThisTurn' };
	}
	if (
		/^if that (?:creature|permanent) (?:didn't|did not) enter(?: the battlefield)? this turn$/i.test(
			t
		)
	) {
		return { k: 'not', of: { k: 'eventObjectEnteredThisTurn' } };
	}
	if (/^if (?:(?:~|it) is(?:n't| not)|it's not) being declared as an attacker$/i.test(t)) {
		return { k: 'notBeingDeclaredAsAttacker' };
	}
	const dmgToSelfTurnM = t.match(
		/^if (?:~ was dealt (\S+) or more damage|(\S+) or more damage was dealt to (?:it|~)) this turn$/i
	);
	if (dmgToSelfTurnM) {
		const min = number(dmgToSelfTurnM[1] ?? dmgToSelfTurnM[2]);
		if (min !== null) {
			return { k: 'damageDealtToSelfThisTurnAtLeast', min };
		}
	}
	if (/^if ~ (?:didn't|did not) attack or come under your control this turn$/i.test(t)) {
		return {
			k: 'and',
			of: [
				{ k: 'not', of: { k: 'boastAttackedThisTurn' } },
				{ k: 'not', of: { k: 'selfEnteredThisTurn' } }
			]
		};
	}
	const onlyCardInGyM = t.match(/^if ~ is the only (.+?) card in your graveyard$/i);
	if (onlyCardInGyM) {
		const f =
			parseGraveyardLeaveCardFilter(onlyCardInGyM[1]) ??
			parseP16bObjectPhrase(`${onlyCardInGyM[1]} card`);
		if (f && !objectFilterProblem(f)) {
			return {
				k: 'and',
				of: [
					{ k: 'selfInZone', zone: 'graveyard' },
					{
						k: 'compare',
						left: { k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } },
						op: '=',
						right: n(1)
					}
				]
			};
		}
	}
	if (/^if ~ dealt (?:combat )?damage to (?:a player|an opponent) this turn$/i.test(t)) {
		return { k: 'selfDealtDamageToOpponentThisTurn' };
	}
	if (
		/^if ~ (?:didn't|did not) deal (?:combat )?damage to (?:a player|an opponent) this turn$/i.test(
			t
		)
	) {
		return { k: 'not', of: { k: 'selfDealtDamageToOpponentThisTurn' } };
	}
	// --- End Track P19b ---
	return null;
}

export type ActivatedExtraRestriction =
	| 'as a sorcery'
	| 'once each turn'
	| 'during your turn'
	| 'during your upkeep'
	| 'during combat';

/**
 * CR 602.5b: Parses `"Activate only if <condition>[ and only <timing/restriction>]."` while
 * preserving subtype capitalization (e.g. `"Swamp"`, `"Plains"`). Excludes zone-only restrictions
 * (`~ is in your hand|graveyard`) handled separately by `ACTIVATED_ZONE_RESTRICTION_SENTENCE`.
 */
export function parseActivatedIfConditionSentence(
	raw: string
): { condition: Condition; extra?: ActivatedExtraRestriction } | null {
	const t = raw.trim().replace(/\.$/, '').trim();
	if (/~ is in your (?:hand|graveyard)\b|~ is in exile\b|~ is suspended\b/i.test(t)) return null;
	const ifFirst = t.match(
		/^activate only if (.+?)(?: and only (as a sorcery|once each turn|during your turn|during your upkeep|during combat))?$/i
	);
	if (ifFirst) {
		const condition = parseCondition(`if ${ifFirst[1].trim()}`, { allowDungeonCompletion: true });
		if (!condition) return null;
		const extra = ifFirst[2]?.toLowerCase() as ActivatedExtraRestriction | undefined;
		return { condition, ...(extra ? { extra } : {}) };
	}
	const extraFirst = t.match(
		/^activate only (as a sorcery|once each turn|during your turn|during your upkeep|during combat) and only if (.+)$/i
	);
	if (extraFirst) {
		const condition = parseCondition(`if ${extraFirst[2].trim()}`, { allowDungeonCompletion: true });
		if (!condition) return null;
		const extra = extraFirst[1].toLowerCase() as ActivatedExtraRestriction;
		return { condition, extra };
	}
	return null;
}

// ---- Entry point ----------------------------------------------------------------------------

function triggerHeadWithInlineWhile(
	rawHead: string
): { trigger: TriggerDef; inlineCondition?: Condition } | null {
	const direct = triggerHead(rawHead);
	if (direct) return { trigger: direct };
	if (!/\s+while\s+/i.test(rawHead)) return null;
	const matches: Array<{ index: number; len: number }> = [];
	const whileRe = /\s+while\s+/gi;
	for (let guard = 0; guard < 8; guard++) {
		const m = whileRe.exec(rawHead);
		if (!m) break;
		matches.push({ index: m.index, len: m[0].length });
	}
	for (let i = matches.length - 1; i >= 0; i--) {
		const leftText = rawHead.slice(0, matches[i].index).trim();
		const rightClause = rawHead.slice(matches[i].index + matches[i].len).trim();
		if (!leftText || !rightClause) continue;
		const inlineCondition = parseCondition(`if ${rightClause}`, { allowDungeonCompletion: true });
		if (!inlineCondition) continue;
		const leftTrigger = triggerHead(leftText);
		if (leftTrigger) return { trigger: leftTrigger, inlineCondition };
	}
	return null;
}

function conditionImpliesSuspendedExile(cond: Condition | undefined): boolean {
	if (!cond) return false;
	if (cond.k === 'isSuspended') return true;
	if (cond.k === 'and') return cond.of.some((c) => conditionImpliesSuspendedExile(c));
	return false;
}

function conditionImpliesGraveyard(cond: Condition | undefined): boolean {
	if (!cond) return false;
	if (cond.k === 'graveyardAbove') return true;
	if (cond.k === 'selfInZone' && cond.zone === 'graveyard') return true;
	if (cond.k === 'and') return cond.of.some((c) => conditionImpliesGraveyard(c));
	return false;
}

function candidateSentenceCommas(body: string): number[] {
	const commas: number[] = [];
	let inQuotes = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (inQuotes) continue;
		if (ch === '.' && (i + 1 === body.length || /\s/.test(body[i + 1]))) {
			break;
		}
		if (ch === ',') commas.push(i);
	}
	return commas;
}

/**
 * Parses the head of a triggered ability. Returns null if `body` isn't a triggered ability (doesn't
 * start with When/Whenever/At). `offset` is the position of `body` in the caller's text.
 */
export function parseTriggerHeader(body: string, offset = 0): TriggerParse | null {
	if (!/^(?:when|whenever|at)\b/i.test(body)) return null;
	const commas = candidateSentenceCommas(body);
	let comma = -1;
	let trigger: TriggerDef | undefined;
	let inlineCondition: Condition | undefined;
	if (commas.length > 0) {
		for (let i = commas.length - 1; i >= 0; i--) {
			const candidate = triggerHeadWithInlineWhile(body.slice(0, commas[i]));
			if (candidate) {
				comma = commas[i];
				trigger = candidate.trigger;
				inlineCondition = candidate.inlineCondition;
				break;
			}
		}
		if (comma < 0) comma = commas[0];
	} else {
		comma = body.indexOf(',');
		if (comma < 0) {
			return {
				effectStart: offset + body.length,
				unparsed: [{ start: offset, end: offset + body.length }]
			};
		}
		const candidate = triggerHeadWithInlineWhile(body.slice(0, comma));
		trigger = candidate?.trigger;
		inlineCondition = candidate?.inlineCondition;
	}

	const unparsed: Span[] = [];
	const head = body.slice(0, comma);
	if (!trigger) unparsed.push({ start: offset, end: offset + head.length });

	let effectStart = comma + 1;
	let condition: Condition | undefined = inlineCondition;
	const rest = body.slice(effectStart);
	const lead = rest.length - rest.trimStart().length;
	if (/^if\b/i.test(rest.trimStart())) {
		const condStart = effectStart + lead;
		const condCommas = commas.filter((c) => c > condStart);
		let condEnd = -1;
		let postCommaCondition: Condition | undefined;
		if (condCommas.length > 0) {
			for (let i = condCommas.length - 1; i >= 0; i--) {
				const parsedCond = parseCondition(body.slice(condStart, condCommas[i]), {
					allowDungeonCompletion: true
				});
				if (parsedCond) {
					condEnd = condCommas[i];
					postCommaCondition = parsedCond;
					break;
				}
			}
			if (condEnd < 0) condEnd = condCommas[0];
		} else {
			condEnd = body.indexOf(',', condStart);
			if (condEnd >= 0) {
				postCommaCondition =
					parseCondition(body.slice(condStart, condEnd), {
						allowDungeonCompletion: true
					}) ?? undefined;
			}
		}
		if (condEnd < 0) {
			unparsed.push({ start: offset + condStart, end: offset + body.length });
			return { trigger, effectStart: offset + body.length, unparsed };
		}
		if (!postCommaCondition) {
			unparsed.push({ start: offset + condStart, end: offset + condEnd });
			condition = undefined;
		} else {
			condition = inlineCondition
				? { k: 'and', of: [inlineCondition, postCommaCondition] }
				: postCommaCondition;
		}
		effectStart = condEnd + 1;
	}
	if (trigger && conditionImpliesGraveyard(condition)) {
		trigger.fromZone = 'graveyard';
		for (const alt of trigger.or ?? []) {
			if (!alt.fromZone) alt.fromZone = 'graveyard';
		}
	} else if (
		trigger &&
		condition &&
		((condition.k === 'selfInZone' && condition.zone === 'exile') ||
			conditionImpliesSuspendedExile(condition)) &&
		!trigger.fromZone
	) {
		trigger.fromZone = 'exile';
		for (const alt of trigger.or ?? []) {
			if (!alt.fromZone) alt.fromZone = 'exile';
		}
	}

	const after = body.slice(effectStart);
	effectStart += after.length - after.trimStart().length;
	return { trigger, condition, effectStart: offset + effectStart, unparsed };
}

// ---- What the runtime can match (Phase 5) ----------------------------------------------------

/** Phases the engine emits PhaseBegin for (beginPhase). */
const RUNTIME_PHASES: ReadonlySet<GamePhase> = new Set<GamePhase>([
	'upkeep',
	'draw',
	'main1',
	'begin_combat',
	'end_combat',
	'main2',
	'end_step'
]);

/** ObjectFilter fields runtime/triggers.ts checks. A filter using any other field never matches. */
const RUNTIME_OBJECT_FIELDS: ReadonlySet<string> = new Set([
	'types',
	'subtypes',
	'supertypes',
	'notTypes',
	'notSupertypes',
	'notSubtypes',
	'controller',
	'owner',
	'token',
	'other',
	'colors',
	'tapped',
	'isCommander',
	'saddled',
	// --- Track P4 ---
	'ofChosenType',
	'ofChosenColor',
	// --- Track P5 ---
	'monstrous',
	// --- Track P7 ---
	'power',
	'toughness',
	'manaValue',
	// --- Track P10 ---
	'suspected',
	'allTypes',
	'notColors',
	'multicolored',
	'monocolored',
	// --- Track P13 ---
	'anyOf',
	'historic',
	'ofChosenName',
	'attachedToRef',
	'targetsSelf',
	'targetsFilter',
	'hasKeywords',
	'lacksKeywords',
	'hasCounters',
	'attacking',
	'blocking',
	'attackingOrBlocking',
	'dealtDamageThisTurn',
	'enteredThisTurn',
	'faceDown',
	'kickedSpell',
	'castNotFromHand',
	'castFromZoneFilter',
	'controllerRef',
	// --- End Track P13 ---
	// --- Track P16b ---
	'sameNameAsSource',
	'sharesColorWithSelf',
	'sharesCreatureTypeWithSelf',
	'hasAnyCounter',
	'isPrepared',
	'enchanted',
	'equipped',
	'modified',
	'outlaw',
	'hasAdventure',
	'hasXInManaCost',
	'powerGreaterThanBase',
	'powerEqualsToughness',
	'manaValueEqualsSourcePower',
	'controlledByEnchantedPlayer',
	'renowned',
	'goaded',
	// --- End Track P16b ---
	// --- Track P19b ---
	'named',
	'allColors',
	'sameNameAsLinkedExile',
	'exiledWithSelf',
	'sharesTypeWithCommander',
	'unblockedAttacker',
	'wasNotCast',
	'abilitySourceFilter',
	'artifactEnchantmentOrToken',
	'powerLessThanSource',
	'untappedNonattackingSummoningReady',
	'castFromZone',
	'castFromOutsideHand',
	'sameOwnerAsSource',
	'bargainedSpell',
	'targetsAttached',
	'targetsYouOrFilter',
	'sharesCardTypeWithExiled',
	'allSubtypes'
	// --- End Track P19b ---
]);

/** EventFilter fields each event kind's matcher checks (runtime/triggers.ts). */
const RUNTIME_EVENT_FIELDS: Partial<Record<TriggerDef['event'], ReadonlySet<string>>> = {
	zoneChange: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'from',
		'to',
		'fromAnywhere',
		'notFromZone',
		'entersUntapped',
		'duringTurn',
		'attachedFilter',
		'dealtDamageBySelfThisTurn',
		'oneOrMore',
		'player',
		'duringStep',
		'duringCombat'
	]),
	cast: new Set([
		'object',
		'player',
		'orCopy',
		'nthThisTurn',
		'spellOrdinal',
		'targetsSelf',
		'duringOpponentTurn',
		'duringTurn',
		'castFromNotHand',
		'castFromZone',
		'wasKicked'
	]),
	attacks: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'oneOrMore',
		'player',
		'saddled',
		'alone',
		'minAttackers',
		'attachedFilter',
		'attackedTarget',
		'coAttackerFilter',
		'coAttackerMin',
		'perAttackedPlayer',
		'firstTimeEachTurn',
		'nthEventThisTurn'
	]),
	combatDamageBatchPlayer: new Set(['object', 'oneOrMore', 'player']),
	blocks: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'oneOrMore',
		'host',
		'attachedFilter',
		'blockedAttackerFilter'
	]),
	becomesBlocked: new Set(['object', 'orSelf', 'orAttachedToSelf', 'host', 'attachedFilter']),
	dealsDamage: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'combat',
		'noncombatOnly',
		'damageTo',
		'damageTargetKind',
		'player',
		'attachedFilter',
		'damageTargetFilter',
		'damageTargetEnchantedPlayer'
	]),
	dealtDamage: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'combat',
		'noncombatOnly',
		'damagedPlayer',
		'attachedFilter'
	]),
	phaseBegin: new Set([
		'phase',
		'enchantedControllerUpkeep',
		'enchantedPlayerUpkeep',
		'attachedFilter',
		'phaseTurnFilter'
	]),
	counterPlaced: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'counter',
		'oneOrMore',
		'putByPlayer',
		'duringTurn',
		'nthCounterOnSelf'
	]),
	becomesTarget: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'targetedBy',
		'targetingSourceFilter',
		'targetPlayer',
		'player',
		'firstTimeTargetedByYouThisTurn',
		'attachedFilter',
		'firstTimeEachTurn'
	]),
	attached: new Set(['object', 'host']),
	tappedForMana: new Set([
		'object',
		'player',
		'attachedFilter',
		'tappedManaColor',
		'tappedManaChosenColor'
	]),
	gainLife: new Set(['player', 'duringTurn', 'firstTimeEachTurn', 'nthEventThisTurn']),
	drawCard: new Set(['player', 'nthThisTurn']),
	becomesTapped: new Set([
		'object',
		'orSelf',
		'orAttachedToSelf',
		'attachedFilter',
		'tappedByPlayer'
	]),
	cycle: new Set(['object', 'player', 'duringTurn']),
	discard: new Set(['object', 'player', 'oneOrMore', 'causedByOpponent', 'duringTurn']),
	transforms: new Set(['object', 'orSelf', 'orAttachedToSelf', 'toFaceFilter', 'attachedFilter']),
	turnFaceUp: new Set(['object', 'orSelf', 'orAttachedToSelf', 'player', 'attachedFilter']),
	investigate: new Set(['player']),
	surveil: new Set(['player', 'duringTurn']),
	explore: new Set(['object', 'orSelf']),
	connive: new Set(['object', 'orSelf']),
	becomesCrewed: new Set(['object', 'orSelf', 'firstTimeEachTurn']),
	becameMonarch: new Set(['player', 'duringTurn']),
	becomesSaddled: new Set(['object', 'orSelf']),
	foretell: new Set(['object', 'player']),
	plot: new Set(['object', 'player']),
	// --- Track P4 ---
	exert: new Set(['object', 'orSelf', 'player']),
	// --- Track P5 ---
	amass: new Set(['player', 'amassSubtype']),
	manifestDread: new Set(['player', 'duringTurn']),
	becameMonstrous: new Set(['object', 'orSelf']),
	// --- Track P6 ---
	counterRemoved: new Set(['object', 'counter', 'lastCounter']),
	// --- Track P10 ---
	attackedAndUnblocked: new Set(['object', 'orSelf', 'orAttachedToSelf', 'oneOrMore', 'attachedFilter']),
	becomesUntapped: new Set(['object', 'orSelf', 'orAttachedToSelf', 'attachedFilter']),
	scry: new Set(['player', 'duringTurn']),
	committedCrime: new Set(['player', 'duringTurn']),
	exploited: new Set(['object', 'orSelf']),
	expended: new Set(['player', 'expendThreshold']),
	sacrificed: new Set(['object', 'orSelf', 'orAttachedToSelf', 'player', 'oneOrMore']),
	blocksOrBecomesBlocked: new Set(['object', 'orSelf', 'orAttachedToSelf', 'host', 'attachedFilter']),
	graveyardLeaveBatch: new Set(['object', 'player', 'oneOrMore', 'duringTurn']),
	discover: new Set(['player', 'duringTurn']),
	forage: new Set(['player', 'duringTurn']),
	// --- Track P13 ---
	doorUnlocked: new Set(['object', 'player', 'thisDoorFaceIndex']),
	roomFullyUnlocked: new Set(['object', 'player']),
	ringTempted: new Set(['player']),
	dungeonRoomEntered: new Set(['player']),
	dungeonCompleted: new Set(['player']),
	tookInitiative: new Set(['player']),
	// --- End Track P13 ---
	// --- Track P16b ---
	stateTriggered: new Set(['stateCondition']),
	dayNightChanged: new Set(['dayNightDirection']),
	facedDilemma: new Set(['player']),
	loseLife: new Set(['player', 'duringTurn', 'firstTimeEachTurn', 'nthEventThisTurn']),
	exhaustActivated: new Set(['object', 'player']),
	unattached: new Set(['object', 'orSelf', 'orAttachedToSelf']),
	phasedIn: new Set(['object', 'orSelf', 'orAttachedToSelf']),
	collectEvidence: new Set(['player']),
	landPlayed: new Set(['object', 'player', 'duringTurn', 'castFromZone', 'castFromNotHand']),
	mutates: new Set(['object', 'orSelf', 'orAttachedToSelf', 'player']),
	soulbondPaired: new Set(['object']),
	hauntedCreatureDies: new Set(['object']),
	// --- End Track P16b ---
	// --- Track P19b ---
	manaAddedByLandAbility: new Set([
		'object',
		'player',
		'tappedManaColor',
		'tappedManaChosenColor'
	]),
	librarySearched: new Set(['player']),
	playerLostGame: new Set(['player']),
	coinFlipped: new Set(['player', 'wonCoinFlip', 'oneOrMore']),
	dieRolled: new Set(['player', 'dieRollMin', 'dieRollValues', 'oneOrMore']),
	energyGained: new Set(['player']),
	proliferated: new Set(['player']),
	evolved: new Set(['object', 'orSelf']),
	crewedVehicle: new Set(['object', 'orSelf'])
	// --- End Track P19b ---
};

function objectFilterProblem(f: ObjectFilter | undefined): string | null {
	if (!f) return null;
	for (const key of Object.keys(f)) {
		if (!RUNTIME_OBJECT_FIELDS.has(key)) return `object filter field "${key}"`;
	}
	if (f.power && f.power.value.k !== 'const') return 'non-constant power filter';
	if (f.toughness && f.toughness.value.k !== 'const') return 'non-constant toughness filter';
	if (f.manaValue && f.manaValue.value.k !== 'const') return 'non-constant manaValue filter';
	// --- Track P13 ---
	if (f.anyOf) {
		for (const branch of f.anyOf) {
			const bp = objectFilterProblem(branch);
			if (bp) return bp;
		}
	}
	if (f.targetsFilter) {
		const tp = objectFilterProblem(f.targetsFilter);
		if (tp) return tp;
	}
	if (f.abilitySourceFilter) {
		const ap = objectFilterProblem(f.abilitySourceFilter);
		if (ap) return ap;
	}
	if (f.targetsYouOrFilter) {
		const typ = objectFilterProblem(f.targetsYouOrFilter);
		if (typ) return typ;
	}
	if (
		f.controllerRef &&
		f.controllerRef.k !== 'you' &&
		f.controllerRef.k !== 'activePlayer' &&
		!(f.controllerRef.k === 'controllerOf' && f.controllerRef.of.k === 'attachedTo')
	) {
		return `controllerRef "${f.controllerRef.k}"`;
	}
	// --- End Track P13 ---
	return null;
}

/**
 * Why the runtime can't honour this trigger, or null if it can. A trigger the runtime can't check
 * exactly must never fire (it would fire on the wrong events), so the compiler marks the ability
 * unsupported (`event_not_implemented`).
 */
export function runtimeTriggerProblem(def: TriggerDef): string | null {
	const fields = RUNTIME_EVENT_FIELDS[def.event];
	if (!fields) return `event "${def.event}" is not emitted`;
	for (const key of Object.keys(def.filter)) {
		if (!fields.has(key)) return `${def.event} filter field "${key}"`;
	}
	const f = def.filter;
	if (typeof f.object === 'object') {
		const p = objectFilterProblem(f.object);
		if (p) return p;
	}
	const p =
		objectFilterProblem(f.host) ??
		objectFilterProblem(f.toFaceFilter) ??
		objectFilterProblem(f.attachedFilter) ??
		objectFilterProblem(f.blockedAttackerFilter) ??
		objectFilterProblem(f.targetingSourceFilter) ??
		objectFilterProblem(f.coAttackerFilter) ??
		objectFilterProblem(f.damageTargetFilter);
	if (p) return p;
	if (
		f.object === 'attachedTo' &&
		![
			'attacks',
			'blocks',
			'becomesBlocked',
			'dealsDamage',
			'dealtDamage',
			'becomesTarget',
			'tappedForMana',
			'becomesTapped',
			'attackedAndUnblocked',
			'becomesUntapped',
			'blocksOrBecomesBlocked',
			'transforms',
			'turnFaceUp',
			'mutates',
			'phasedIn',
			'counterPlaced'
		].includes(def.event) &&
		!(def.event === 'zoneChange' && f.from === 'battlefield')
	) {
		return `"${def.event}" of the attached-to object`;
	}
	if (def.event === 'phaseBegin' && (!f.phase || !RUNTIME_PHASES.has(f.phase))) return `phase "${f.phase}"`;
	if (
		(def.event === 'becomesTarget' || def.event === 'dealsDamage') &&
		f.player &&
		!['you', 'opponent', 'any'].includes(f.player.relation)
	) {
		return `player "${f.player.relation}"`;
	}
	if (def.event === 'cast' && f.player && !['you', 'opponent', 'any'].includes(f.player.relation)) {
		return `caster "${f.player.relation}"`;
	}
	if (
		def.event === 'attacks' &&
		f.player &&
		(f.object !== undefined
			? f.player.relation !== 'you'
			: !['you', 'opponent', 'any'].includes(f.player.relation))
	) {
		return 'attacking player';
	}
	if (
		def.event === 'combatDamageBatchPlayer' &&
		(!f.oneOrMore || !f.player || !['you', 'opponent', 'any'].includes(f.player.relation))
	) {
		return 'combatDamageBatchPlayer filter';
	}
	if (
		def.fromZone &&
		def.fromZone !== 'graveyard' &&
		def.fromZone !== 'exile' &&
		!(def.fromZone === 'any' && (def.event === 'cycle' || def.event === 'discard'))
	) {
		return `functions from ${def.fromZone}`;
	}
	for (const alt of def.or ?? []) {
		const q = runtimeTriggerProblem(alt);
		if (q) return q;
	}
	return null;
}

// ---- Runtime view ---------------------------------------------------------------------------

/** One triggered ability as the runtime matches it. */
export interface RuntimeTrigger {
	/** Index in compileCard(card).faces[faceIndex].abilities (stored on stack items, CR 603.4 re-check). */
	abilityIndex: number;
	trigger: TriggerDef;
	condition?: Condition;
	/** Existence condition for striated frames (CR 711.5 Leveler, CR 722.2 Station). */
	grantCondition?: Condition;
	/** The IR effect is fully understood and interpretable (kind 'triggered'). */
	effectSupported: boolean;
	/** The ability's normalised text (`~` for the card's name), shown on the stack. Display only. */
	text: string;
	/**
	 * The compiled effect (steps and target specs) when the ability is automated. Absent for an
	 * ability whose effect the compiler marked unsupported: it still triggers and goes on the stack,
	 * and is resolved manually (plan section 2.7).
	 */
	effect?: { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef; unparsed: [] };
	/**
	 * Ward (CR 702.21a), a keyword the engine implements itself: "Whenever this permanent becomes the
	 * target of a spell or ability an opponent controls, counter it unless that player pays [cost]."
	 */
	ward?: { cost: string; costDefs?: CostDef[] };
	/** Set for triggers emitted from a Layer 6 granted trigger keyword (e.g. prowess, battle cry). */
	grantedKeyword?: string;
}

const RUNTIME_TRIGGERS = new WeakMap<CardDefinition, Map<number, RuntimeTrigger[]>>();

function synthesizeTriggeredManaEffect(
	text: string,
	trigger: TriggerDef
): { steps: EffectStep[]; targets: TargetSpec[]; unparsed: [] } | null {
	if (trigger.event !== 'tappedForMana' && trigger.event !== 'manaAddedByLandAbility') {
		return null;
	}
	const hdr = parseTriggerHeader(text);
	if (!hdr || hdr.unparsed.length > 0) return null;
	const rawTail = text.slice(hdr.effectStart).trim().replace(/\.$/, '').trim();
	const clauseM = rawTail.match(
		/^(?:(its controller|that land's controller|that permanent's controller|that player|you)\s+adds?\s+|add\s+)(.+)$/i
	);
	if (!clauseM) return null;
	const rawActor = clauseM[1]?.toLowerCase();
	const actor: PlayerRef | undefined =
		rawActor === 'that player'
			? { k: 'eventPlayer' }
			: rawActor && rawActor !== 'you'
				? {
						k: 'controllerOf',
						of:
							trigger.filter.object === 'attachedTo'
								? { k: 'attachedTo' }
								: { k: 'eventObject' }
					}
				: undefined;
	const rest = clauseM[2].trim();
	const span: Span = { start: hdr.effectStart, end: text.length };

	const thatColorM = rest.match(
		/^(?:an additional\s+)?(one|1|two|2)\s+(?:additional\s+)?mana of (?:that|the chosen) color$/i
	);
	if (thatColorM) {
		const amtN = /^(?:two|2)$/i.test(thatColorM[1]) ? 2 : 1;
		const params: EffectStep['params'] = trigger.filter.tappedManaChosenColor
			? { manaChoice: 'chosenColor' }
			: trigger.filter.tappedManaColor
				? { mana: [trigger.filter.tappedManaColor] }
				: { manaChoice: 'any', manaFromProducedEvent: true };
		return {
			steps: [
				{
					verb: 'addMana',
					subject: { k: 'none' },
					amount: n(amtN),
					...(actor ? { actor } : {}),
					params,
					span
				}
			],
			targets: [],
			unparsed: []
		};
	}

	const producedTypeM = rest.match(
		/^(?:an additional\s+)?(one|1|two|2)\s+(?:additional\s+)?mana of any (?:type|color) that (?:land|permanent|creature|artifact) produced$/i
	);
	if (producedTypeM) {
		const amtN = /^(?:two|2)$/i.test(producedTypeM[1]) ? 2 : 1;
		return {
			steps: [
				{
					verb: 'addMana',
					subject: { k: 'none' },
					amount: n(amtN),
					...(actor ? { actor } : {}),
					params: { manaChoice: 'any', manaFromProducedEvent: true },
					span
				}
			],
			targets: [],
			unparsed: []
		};
	}

	return null;
}

/**
 * The triggered abilities the runtime matches for a compiled card:
 * - abilities of kind 'triggered' (trigger, condition and effect understood and interpretable),
 * - unsupported abilities whose trigger head is understood but whose effect isn't. Step E2 (plan
 *   section 2.7): they trigger and go on the stack like any other; a human controller resolves them
 *   manually and a bot skips them, and
 * - triggered keyword abilities declared in KEYWORD_REGISTRY (Ward, Prowess, Battle cry, Afterlife,
 *   Bushido, Living weapon, For Mirrodin!, Exploit, etc.).
 * Abilities whose trigger head isn't understood (or names an event the engine never emits) can't
 * be matched; the engine mentions them when the permanent enters (compiler/support.ts).
 */
function resolveDoorFaceTrigger(def: TriggerDef, faceIndex: number): TriggerDef {
	const needsSelf = def.filter.thisDoorFaceIndex === -1;
	const needsOr = def.or?.some((alt) => alt.filter.thisDoorFaceIndex === -1);
	if (!needsSelf && !needsOr) return def;
	return {
		...def,
		...(needsSelf ? { filter: { ...def.filter, thisDoorFaceIndex: faceIndex } } : {}),
		...(def.or ? { or: def.or.map((alt) => resolveDoorFaceTrigger(alt, faceIndex)) } : {})
	};
}

export function runtimeTriggers(def: CardDefinition, faceIndex = 0): RuntimeTrigger[] {
	let byFace = RUNTIME_TRIGGERS.get(def);
	const cached = byFace?.get(faceIndex);
	if (cached) return cached;
	const out: RuntimeTrigger[] = [];
	(def.faces[faceIndex]?.abilities ?? []).forEach((ab, abilityIndex) => {
		if (ab.kind === 'keyword') {
			const spec = getKeywordSpec(ab.keyword.name);
			if (
				spec?.status === 'implemented' &&
				(spec.implementation?.kind === 'trigger' ||
					(spec.implementation?.kind === 'castOption' && spec.implementation.buildTriggers))
			) {
				out.push(...spec.implementation.buildTriggers!(ab.keyword, abilityIndex, ab.span));
			}
			return;
		}
		if (ab.kind === 'triggered') {
			out.push({
				abilityIndex,
				trigger: resolveDoorFaceTrigger(ab.trigger, faceIndex),
				condition: ab.condition,
				...(ab.grantCondition ? { grantCondition: ab.grantCondition } : {}),
				effectSupported: true,
				text: ab.text ?? '',
				effect: { steps: ab.effect, targets: ab.targets, ...(ab.modal ? { modal: ab.modal } : {}), unparsed: [] }
			});
		} else if (ab.kind === 'unsupported' && ab.reason === 'unparsed' && ab.trigger) {
			// An unparsed intervening-if leaves `condition` undefined: such abilities are 'unparsed' via
			// the trigger head (no ab.trigger), so they never get here.
			const resolvedTrigger = resolveDoorFaceTrigger(ab.trigger, faceIndex);
			const synthMana = synthesizeTriggeredManaEffect(ab.text, resolvedTrigger);
			out.push({
				abilityIndex,
				trigger: resolvedTrigger,
				condition: ab.condition,
				...(ab.grantCondition ? { grantCondition: ab.grantCondition } : {}),
				effectSupported: Boolean(synthMana),
				text: ab.text,
				...(synthMana ? { effect: synthMana } : {})
			});
		}
	});
	if (!byFace) {
		byFace = new Map();
		RUNTIME_TRIGGERS.set(def, byFace);
	}
	byFace.set(faceIndex, out);
	return out;
}
