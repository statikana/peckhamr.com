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
	Layer,
	LayerMod,
	ObjectFilter,
	ReplacementDef,
	Span,
	StaticDef,
	Timing
} from '../ir.ts';
import { STATIC_CONTINUOUS_KEYWORDS as KEYWORDS } from '../keywords.ts';
import type { CounterType, ManaColor, ZoneType } from '../types.ts';
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

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

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
	let protection: string | undefined;
	if (prot >= 0) {
		protection = rest.slice(prot).trim().toLowerCase();
		rest = rest.slice(0, prot).replace(/(?:,\s*and|,|\band)\s*$/i, '').trim();
		if (protection === 'protection from each color') {
			protection = 'protection from all colors';
		}
		if (
			!/^protection from (?:[a-z]+(?:,? (?:and )?from [a-z]+)*|everything|all colors)$/.test(
				protection
			)
		) {
			return null;
		}
	}
	if (rest) {
		for (const raw of rest.split(/,\s*(?:and\s+)?|\s+and\s+/)) {
			const kw = raw.trim().toLowerCase();
			if (!kw) continue;
			if (
				KEYWORDS.has(kw) ||
				/^ward \{[^}]+\}$/.test(kw) ||
				/^ward\s*[—-]\s*waterbend \{[^}]+\}$/.test(kw) ||
				/^hexproof from [a-z]+$/.test(kw)
			) {
				out.push(kw);
			} else return null;
		}
	}
	if (protection) out.push(protection);
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
	return COUNTERS[raw.trim().toLowerCase().replace(/−/g, '-')] ?? null;
}

/**
 * The subject of a continuous effect: "~", "equipped creature", "Other Elf creatures you control",
 * "Creatures your opponents control", "All creatures", "Each land", "Nonbasic lands".
 */
export function parseAffected(subject: string): Affected | null {
	const s = subject.trim();
	if (s === '~' || /^it$/i.test(s)) return 'self';
	if (
		/^(?:equipped|enchanted) (?:creature|permanent|land|artifact|enchantment|planeswalker|vehicle|plains|island|swamp|mountain|forest)$/i.test(
			s
		)
	) {
		return 'attachedTo';
	}
	if (/^sources? (?:with|of) the chosen name$/i.test(s)) {
		return { ofChosenName: true };
	}
	let phrase = s.replace(/^(?:all|each) /i, '');
	let controller: ObjectFilter['controller'];
	const opp = phrase.match(/^(.+) (?:your opponents control|an opponent controls)$/i);
	if (opp) {
		phrase = opp[1];
		controller = 'opponent';
	}
	const filter = parseObjectPhrase(phrase, { allowPluralAndDisjunction: true });
	if (!filter) return null;
	if (controller) {
		if (filter.controller) return null;
		filter.controller = controller;
	}
	return filter;
}

/** "the number of creatures you control", "the number of creature cards in all graveyards". */
function parseCountAmount(text: string): Amount | null {
	const t = text.trim();
	// --- Track P8: arithmetic "<Amount> plus <N>" / "<N> plus <Amount>" ---
	const plusRight = t.match(/^(.+?)\s+plus\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/i);
	if (plusRight) {
		const left = parseCountAmount(plusRight[1]);
		const right = count(plusRight[2]);
		if (left && right) return { k: 'sum', args: [left, right] };
	}
	const plusLeft = t.match(/^(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+plus\s+(.+)$/i);
	if (plusLeft) {
		const left = count(plusLeft[1]);
		const right = parseCountAmount(plusLeft[2]);
		if (left && right) return { k: 'sum', args: [left, right] };
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
	if (/^the number of cards? in your graveyard$/i.test(t)) {
		return { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } };
	}
	if (/^the number of cards? in your exile$/i.test(t) || /^the number of cards? you own in exile$/i.test(t)) {
		return { k: 'cardsIn', zone: 'exile', of: { k: 'you' } };
	}
	if (/^the number of cards? in all graveyards$/i.test(t)) {
		return { k: 'count', of: { zone: 'graveyard' } };
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
	const oppCtrl = m[1].match(/^(.+) (?:your opponents control|an opponent controls)$/i);
	if (oppCtrl) {
		const fOpp = parseObjectPhrase(oppCtrl[1].replace(/\s+and\s+/gi, ' or '));
		return fOpp && !fOpp.controller
			? { k: 'count', of: { zone: 'battlefield', ...fOpp, controller: 'opponent' } }
			: null;
	}
	const f = parseObjectPhrase(m[1].replace(/\s+and\s+/gi, ' or '));
	return f ? { k: 'count', of: { zone: 'battlefield', ...f } } : null;
}

const PERMANENT_CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];

function parseGraveyardCardFilter(raw: string): ObjectFilter | null {
	const trimmed = raw.trim();
	if (/^permanents?$/i.test(trimmed)) {
		return { types: [...PERMANENT_CARD_TYPES] };
	}
	const normalized = trimmed.replace(/\s+and\s+/gi, ' or ');
	return parseObjectPhrase(`${normalized} card`);
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
	return null;
}

function parseCopyModifications(raw: string): CopyModificationSpec | null {
	const spec: CopyModificationSpec = {};
	const clauses = raw
		.trim()
		.split(/,\s*(?:and\s+)?|\s+and\s+(?=(?:it(?:'s| is| isn't| has)|its name is)\b)/i)
		.map((c) => c.trim())
		.filter(Boolean);
	if (clauses.length === 0) return null;

	for (const clause of clauses) {
		const nameMatch = clause.match(/^its name is (~|[A-Z][^,]+)$/i);
		if (nameMatch) {
			const rawName = nameMatch[1].trim();
			if (rawName === '~') spec.keepSelfName = true;
			else spec.overrideName = rawName;
			continue;
		}
		if (/^it(?:'s| is) not legendary$/i.test(clause) || /^it isn't legendary$/i.test(clause)) {
			spec.removeSupertypes = [...(spec.removeSupertypes ?? []), 'Legendary'];
			continue;
		}
		if (/^it has no mana cost$/i.test(clause)) {
			spec.noManaCost = true;
			continue;
		}
		const ptOnly = clause.match(/^(?:it(?:'s| is) )?(\d+)\/(\d+)$/i);
		if (ptOnly) {
			spec.power = parseInt(ptOnly[1], 10);
			spec.toughness = parseInt(ptOnly[2], 10);
			continue;
		}
		const addTypesOrSubs = clause.match(/^it(?:'s| is) (?:an? )?(.+?) in addition to its other types$/i);
		if (addTypesOrSubs) {
			const words = addTypesOrSubs[1].trim().split(/\s+/).filter(Boolean);
			const addedTypes: string[] = [];
			const addedSubs: string[] = [];
			let addedCols: ManaColor[] | undefined;
			let ok = true;
			for (const w of words) {
				const low = w.toLowerCase();
				if (CARD_TYPES[low]) addedTypes.push(CARD_TYPES[low]);
				else if (COLORS[low]) (addedCols ??= []).push(COLORS[low]);
				else if (/^[A-Z][A-Za-z'-]*$/.test(w)) addedSubs.push(w);
				else {
					ok = false;
					break;
				}
			}
			if (!ok || (addedTypes.length === 0 && addedSubs.length === 0)) return null;
			if (addedTypes.length > 0) spec.addTypes = [...(spec.addTypes ?? []), ...addedTypes];
			if (addedSubs.length > 0) spec.addSubtypes = [...(spec.addSubtypes ?? []), ...addedSubs];
			if (addedCols) spec.setColors = addedCols;
			continue;
		}
		const addColor = clause.match(/^it(?:'s| is) (white|blue|black|red|green) in addition to its other colors$/i);
		if (addColor) {
			const col = COLORS[addColor[1].toLowerCase()];
			spec.addColors = [...(spec.addColors ?? []), col];
			continue;
		}
		const isColorOnly = clause.match(/^it(?:'s| is) (white|blue|black|red|green|colorless)$/i);
		if (isColorOnly) {
			const low = isColorOnly[1].toLowerCase();
			spec.setColors = low === 'colorless' ? [] : [COLORS[low]];
			continue;
		}
		const isDesc = clause.match(/^it(?:'s| is) an? (.+)$/i);
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
	return null;
}

/** "If a card or token would be put into a graveyard from anywhere, exile it instead." etc. */
const replacements: Production = (s, span) => {
	if (/^if a card(?: or token)? would be put into a graveyard from anywhere, exile it instead$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'exile' } } }];
	}
	if (/^if a card(?: or token)? would be put into a graveyard from anywhere, shuffle it into its owner's library instead$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'library', shuffleIntoLibrary: true } } }];
	}
	// --- Track P11: Opponent / controller graveyard & die-to-exile replacements ---
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
		/^if (?:(?:a|an)\s+|(?=(?:another|other)\b))(.+?) would die, exile (?:it|that card) instead$/i
	);
	if (otherDieExile) {
		let rawSubj = otherDieExile[1].trim();
		let ctrl: 'you' | 'opponent' | undefined;
		const oppCtrl = rawSubj.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
		if (oppCtrl) {
			ctrl = 'opponent';
			rawSubj = oppCtrl[1];
		}
		const filter = parseObjectPhrase(rawSubj);
		if (filter && (!ctrl || !filter.controller)) {
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
						with: { k: 'modify', to: 'exile' }
					}
				}
			];
		}
	}
	// --- Track P11: Static damage modification (CR 614.7a) & life-gain modification (CR 119.6) ---
	const dmgMod = s.match(
		/^if (.+?) would deal (?:(noncombat|combat) )?damage(?: to (a permanent or player|any target|an opponent or a permanent an opponent controls|an opponent))?, it deals (double that damage|triple that damage|that much damage plus (\S+))(?: to that permanent or player| to that player)?(?: instead)?$/i
	);
	if (dmgMod) {
		const sourceSpec = parseDamageSourcePhrase(dmgMod[1]);
		if (sourceSpec !== null) {
			const dmgKind = dmgMod[2]?.toLowerCase();
			const rawTarget = dmgMod[3]?.toLowerCase() ?? '';
			const targetFilter: 'any' | 'opponent' | 'opponentOrOpponentPerm' =
				rawTarget === 'an opponent'
					? 'opponent'
					: rawTarget === 'an opponent or a permanent an opponent controls'
						? 'opponentOrOpponentPerm'
						: 'any';
			const modStr = dmgMod[4].toLowerCase();
			if (modStr.startsWith('double')) {
				return [
					{
						kind: 'replacement',
						replacement: {
							replaces: { event: 'damage', filter: {} },
							with: {
								k: 'modify',
								damageMod: {
									mode: 'double',
									...(dmgKind === 'noncombat' ? { noncombatOnly: true } : {}),
									...(dmgKind === 'combat' ? { combatOnly: true } : {}),
									...(sourceSpec !== undefined ? { sourceFilter: sourceSpec } : {}),
									...(targetFilter !== 'any' ? { targetFilter } : {})
								}
							}
						}
					}
				];
			}
			if (modStr.startsWith('triple')) {
				return [
					{
						kind: 'replacement',
						replacement: {
							replaces: { event: 'damage', filter: {} },
							with: {
								k: 'modify',
								damageMod: {
									mode: 'triple',
									...(dmgKind === 'noncombat' ? { noncombatOnly: true } : {}),
									...(dmgKind === 'combat' ? { combatOnly: true } : {}),
									...(sourceSpec !== undefined ? { sourceFilter: sourceSpec } : {}),
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
					return [
						{
							kind: 'replacement',
							replacement: {
								replaces: { event: 'damage', filter: {} },
								with: {
									k: 'modify',
									damageMod: {
										mode: 'add',
										add: addAmt,
										...(dmgKind === 'noncombat' ? { noncombatOnly: true } : {}),
										...(dmgKind === 'combat' ? { combatOnly: true } : {}),
										...(sourceSpec !== undefined ? { sourceFilter: sourceSpec } : {}),
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

	const lifeDouble = s.match(/^if you would gain life, you gain twice that much life instead$/i);
	if (lifeDouble) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'lifeGain', filter: { player: { relation: 'you' } } },
					with: { k: 'modify', lifeGainMod: { mode: 'double' } }
				}
			}
		];
	}
	const lifePlus = s.match(/^if you would gain life, you gain that much life plus (\S+) instead$/i);
	if (lifePlus) {
		const addAmt = count(lifePlus[1]);
		if (addAmt) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'lifeGain', filter: { player: { relation: 'you' } } },
						with: { k: 'modify', lifeGainMod: { mode: 'add', add: addAmt } }
					}
				}
			];
		}
	}
	// --- End Track P11 ---
	const selfDieOrGy = s.match(
		/^if ~ would (die|be put into a graveyard from anywhere), (?:reveal ~ and )?(exile it|shuffle it into its owner's library|return it to its owner's hand|put it into its owner's hand) instead$/i
	);
	if (selfDieOrGy) {
		const isDie = selfDieOrGy[1].toLowerCase() === 'die';
		const action = selfDieOrGy[2].toLowerCase();
		const to: ZoneType = action.startsWith('exile') ? 'exile' : action.startsWith('shuffle') ? 'library' : 'hand';
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: {
						event: 'zoneChange',
						filter: { object: 'self', ...(isDie ? { from: 'battlefield' } : {}), to: 'graveyard' }
					},
					with: { k: 'modify', to, ...(action.startsWith('shuffle') ? { shuffleIntoLibrary: true } : {}) }
				}
			}
		];
	}
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
			/^~ enters (?:the battlefield )?(tapped )?with X (.+?) counters? on (?:it|him|her|them),?\s+where X is (.+)$/i
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
		// --- End Track P14 ---
		const choiceCounter = body.match(
			/^~ enters (?:the battlefield )?(tapped )?with your choice of (?:either )?(?:a|an) (.+?) counter or (?:a|an) (.+?) counter on (?:it|him|her|them)$/i
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
			/^~ enters (?:the battlefield )?(tapped )?with (\S+) (.+?) counters? on (?:it|him|her|them)(?: for each (.+))?$/i
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
		const chooseCol = body.match(
			/^as (?:~|it) enters(?: the battlefield)?, choose a color(?: other than (white|blue|black|red|green))?$/i
		);
		if (chooseCol) {
			const ex = chooseCol[1] ? COLORS[chooseCol[1].toLowerCase()] : undefined;
			return { k: 'modify', chooseColor: ex ? { exclude: ex } : {} };
		}
		const chooseName = body.match(/^as (?:~|it) enters(?: the battlefield)?, choose a (nonland )?card name$/i);
		if (chooseName) {
			return { k: 'modify', chooseCardName: chooseName[1] ? { nonlandOnly: true } : {} };
		}
		return null;
	};
	const direct = parseSelfEtbModify(s);
	if (direct) {
		const isSelfChoice = Boolean(
			typeof direct === 'object' &&
				!Array.isArray(direct) &&
				direct.k === 'modify' &&
				(direct.chooseSubType || direct.chooseColor || direct.chooseCardName || direct.chooseCounter)
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

	// --- Track P11: External ETB tapped & additional counters (CR 614.12) ---
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

	const extAddCounters = s.match(
		/^(.+?) enters? (?:the battlefield )?with (\S+) additional (.+?) counters? on (?:it|them)$/i
	);
	if (extAddCounters && !/^(?:~|it)$/i.test(extAddCounters[1].trim())) {
		const aff = parseAffected(extAddCounters[1]);
		const amt = count(extAddCounters[2]);
		const ctr = lookupStaticCounter(extAddCounters[3]);
		if (aff && typeof aff === 'object' && amt && ctr) {
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
	// --- End Track P11 ---

	// --- Track P8: Conditional ETB Dual Lands ("~ enters tapped unless <condition>") ---
	const entersTappedUnless = s.match(/^~ enters (?:the battlefield )?tapped unless (.+)$/i);
	if (entersTappedUnless) {
		const unlessCond = parseUnlessEtbCondition(entersTappedUnless[1]);
		if (unlessCond) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: entersSelf,
						with: { k: 'modify', tapped: true },
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
			/^(\S+) (?:additional )?(\S+) counters? on (?:it|her|him)(?: and (?:with )?(.+))?$/i
		);
		if (counterAndKw) {
			const amount = count(counterAndKw[1]);
			const counter = COUNTERS[counterAndKw[2].toLowerCase()];
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
		if (/^you and permanents you control$/i.test(rawTarget)) {
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
		const youAndSub = rawTarget.match(/^you and (.+?) you control$/i);
		if (youAndSub) {
			const f = parseObjectPhrase(youAndSub[1].replace(/\s+and\s+/gi, ' or '));
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
		/^if (any source|a source|.+?) would deal (combat |noncombat )?damage to (~|(?:enchanted|equipped) (?:creature|permanent|planeswalker)|you|you or a permanent you control|a permanent you control|(?:a|an) .+? you control), prevent (\S+) of that damage$/i
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
				const sub = rawTarget.match(/^(?:a|an) (.+?) you control$/i);
				if (sub) {
					const f = parseObjectPhrase(sub[1]);
					if (f && !f.controller) target = { filter: { ...f, controller: 'you' } };
				}
			}
			if (target) {
				return [
					{
						kind: 'static',
						static: {
							k: 'staticDamagePrevention',
							...(kindRaw === 'combat' ? { combatOnly: true } : {}),
							...(kindRaw === 'noncombat' ? { noncombatOnly: true } : {}),
							...(sourceFilter ? { sourceFilter } : {}),
							amount: amt.n,
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
	[/^(.+?) can't attack$/, 'cantAttack'],
	[/^(.+?) can't block$/, 'cantBlock'],
	[/^(.+?) can't be blocked$/, 'cantBeBlocked'],
	[/^(.+?) (?:attacks|attack) each combat if able$/, 'attacksEachCombat'],
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
	if (/^(?:attacks|attack) each combat if able$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'attacksEachCombat' } };
	}
	if (/^(?:blocks|block) each combat if able$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'blocksEachCombat' } };
	}
	if (/^loses? all abilities$/i.test(low)) {
		return continuous('6', affected, { k: 'removeAllAbilities' });
	}
	if (/^must be blocked if able$/i.test(low)) {
		return { kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'mustBeBlockedIfAble' } } };
	}
	if (/^can block an additional creature(?: each combat)?$/i.test(low)) {
		return { kind: 'static', static: { k: 'combatRule', affected, rule: { kind: 'additionalBlockCount', count: 1 } } };
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
		/^((?:Enchanted|Equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker)) (can't attack or block|can't attack|can't block|doesn't untap during its controller's untap step),? and its activated abilities can't be activated( unless they're mana abilities)?$/i
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
		/^((?:Enchanted|Equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker))'s activated abilities can't be activated( unless they're mana abilities)?$/i
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

	const addBlockN = s.match(/^(.+?) can block (?:up to )?(\S+) additional creatures(?: each combat)?$/i);
	if (addBlockN) {
		const affected = parseAffected(addBlockN[1]);
		const amt = count(addBlockN[2]);
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

	// --- Track P11: Untap choice (CR 502.3) & Toughness combat damage (CR 510.1a) ---
	if (/^You may choose not to untap ~ during your untap step$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'mayChooseNotToUntap', affected: 'self' } }];
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
	// --- End Track P11 ---

	return null;
};

// --- Track P8: Top-of-Library Look/Reveal/Play (CR 401.5, 601.3e) & Graveyard Land Play (CR 305.1) ---

function parseSpellFilterForTopLibrary(raw: string): ObjectFilter | null {
	const trimmed = raw.trim();
	const chosenType = trimmed.match(/^(.+?) spells? of the chosen type$/i);
	if (chosenType) {
		const base = parseObjectPhrase(`${chosenType[1]} card`);
		return base ? { ...base, ofChosenType: true } : null;
	}
	if (/^spells? of the chosen type$/i.test(trimmed)) {
		return { ofChosenType: true };
	}
	// --- Track P14: "permanent spell(s) [with ...]" and singular/plural spell filters ---
	const permSpell = trimmed.match(/^(?:(?:a|an)\s+)?permanent spells?(?:\s+with\s+(.+))?$/i);
	if (permSpell) {
		if (!permSpell[1]) return { types: [...PERMANENT_CARD_TYPES] };
		const qual = parseObjectPhrase(`card with ${permSpell[1]}`);
		return qual ? { ...qual, types: [...PERMANENT_CARD_TYPES] } : null;
	}
	const singleOrPlural = trimmed.match(/^(?:(?:a|an)\s+)?(.+?) spells?(\s+with\s+.+)?$/i);
	if (singleOrPlural) {
		const head = singleOrPlural[1].replace(/\s+and(?:\/or)?\s+/gi, ' or ');
		const tail = singleOrPlural[2] ?? '';
		return parseObjectPhrase(`${head} card${tail}`);
	}
	// --- End Track P14 ---
	const spellMatch = trimmed.match(/^(.+?) spells$/i);
	if (!spellMatch) return null;
	return parseObjectPhrase(`${spellMatch[1]} card`);
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
	if (/^You may play lands from your graveyard$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'zonePlayPermission', zone: 'graveyard', allowLands: true } }];
	}
	if (/^You may play lands from the top of your library$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'zonePlayPermission', zone: 'library', allowLands: true } }];
	}
	if (/^You may cast spells from the top of your library$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'zonePlayPermission', zone: 'library', allowSpells: true } }];
	}
	if (/^You may play lands and cast spells from the top of your library$/i.test(s)) {
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

/** Counter, token and trigger doublers. */
const multipliers: Production = (s) => {
	const low = s.toLowerCase();
	const mult = (def: Extract<StaticDef, { k: 'multiplier' }>): StaticItem[] => [{ kind: 'static', static: def }];
	// --- Track P11: Generalized counter & token multipliers ---
	const ctrPlus = s.match(
		/^if one or more (.+?) counters would be put on (?:a |an )?(.+?), that many plus (\S+) (.+?) counters are put on (?:it|that [a-z]+) instead$/i
	);
	if (ctrPlus) {
		const c1 = lookupStaticCounter(ctrPlus[1]);
		const c2 = lookupStaticCounter(ctrPlus[4]);
		const filter = parseObjectPhrase(ctrPlus[2].replace(/\s+and\s+/gi, ' or '));
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
		const filter = parseObjectPhrase(ctrMult[2].replace(/\s+and\s+/gi, ' or '));
		const factor = ctrMult[3].toLowerCase() === 'three times' ? 3 : 2;
		if (c1 && c1 === c2 && filter) {
			return mult({ k: 'multiplier', what: 'counters', factor, filter, counter: c1 });
		}
	}
	const anyCtrPlus = s.match(
		/^if (?:an effect would put )?one or more counters (?:on|would be put on) (?:a |an )?(.+?), (?:it puts )?that many plus (\S+) of each of those kinds of counters (?:on (?:it|that [a-z]+)|are put on (?:it|that [a-z]+)) instead$/i
	);
	if (anyCtrPlus) {
		const rawTarget = anyCtrPlus[1].trim();
		const filter = /^permanent you control$/i.test(rawTarget)
			? { controller: 'you' as const }
			: parseObjectPhrase(rawTarget.replace(/\s+and\s+/gi, ' or '));
		const delta = count(anyCtrPlus[2]);
		if (filter && delta && delta.k === 'const' && delta.n >= 1) {
			return mult({ k: 'multiplier', what: 'counters', factor: 1, delta: delta.n, filter });
		}
	}
	const anyCtrMult = s.match(
		/^if (?:an effect would put )?one or more counters (?:on|would be put on) (?:a |an )?(.+?), (?:it puts )?(twice|three times) that many of each of those kinds of counters (?:on (?:it|that [a-z]+)|are put on (?:it|that [a-z]+)) instead$/i
	);
	if (anyCtrMult) {
		const rawTarget = anyCtrMult[1].trim();
		const filter = /^permanent you control$/i.test(rawTarget)
			? { controller: 'you' as const }
			: parseObjectPhrase(rawTarget.replace(/\s+and\s+/gi, ' or '));
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
	const tokGlobal = low.match(
		/^if an effect would create one or more tokens, it creates (twice|three times) that many of those tokens instead$/
	);
	if (tokGlobal) {
		const factor = tokGlobal[1] === 'three times' ? 3 : 2;
		return mult({ k: 'multiplier', what: 'tokens', factor, filter: {} });
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
	const cause = low.match(/^if (?:an? )?(.+?) (entering(?: the battlefield)?|dying|attacking) causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/);
	if (cause) {
		const object = parseObjectPhrase(cause[1]);
		if (object) {
			const filter: EventPattern['filter'] =
				cause[2] === 'dying'
					? { object, from: 'battlefield', to: 'graveyard' }
					: cause[2] === 'attacking'
						? { object }
						: { object, to: 'battlefield' };
			const event: EventPattern['event'] = cause[2] === 'attacking' ? 'attacks' : 'zoneChange';
			return mult({ k: 'multiplier', what: 'triggers', factor: 2, filter: { controller: 'you' }, cause: { event, filter } });
		}
	}
	return null;
};

/** Player-level rules: hand size, can't lose, hexproof, attack tax, flash, casting restrictions. */
const ruleModifiers: Production = (s) => {
	const low = s.toLowerCase();
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
	if (low === 'you may cast spells as though they had flash') return [rule('castAsThoughFlash', 'you')];
	// --- Track P14: Case-preserved subtype flash grants, global flash, commander & deck designations ---
	if (/^(?:any|each) player may cast spells as though they had flash$/i.test(s)) {
		return [rule('castAsThoughFlash', 'each_player')];
	}
	const flashFor = s.match(/^(You|Any player|Each player) may cast (.+?) spells as though they had flash$/i);
	if (flashFor) {
		const whoRel = flashFor[1].toLowerCase() === 'you' ? 'you' : 'each_player';
		const filter = parseObjectPhrase(`${flashFor[2].replace(/\s+and\s+/gi, ' or ')} card`, {
			allowPluralAndDisjunction: true
		});
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
		const self = s.match(/^~ costs (\{\d+\}) (less|more) to cast(?: for each (.+))?$/);
		if (self) {
			if (!self[3]) return build({ k: 'self' }, self[1], self[2], 'you');
			const times = parseCountAmount(`the number of ${self[3]}`);
			if (times) return build({ k: 'self' }, self[1], self[2], 'you', times);
		}
		const spells = s.match(
			/^(?:(.+?) )?[Ss]pells(?: of the chosen (type|color))?(?: (you|your opponents) cast)?(?: of the chosen (type|color))? cost (\{\d+\}) (less|more) to cast$/
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
			if (chosenA === 'type' || chosenB === 'type') filter = { ...filter, ofChosenType: true };
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
			/^(?:Enchanted|Equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker|Plains|Island|Swamp|Mountain|Forest) (.+)$/
		);
		if (!m) return null;
		let rest = m[1];
		let typeDesc: ReturnType<typeof parseTypeDescription> = null;
		let basePT: [number, number] | undefined;
		let grantedAbilities: AbilityDef[] | undefined;
		let keywords: string[] | undefined;
		let losesAll = false;
		let losesTypes = false;
		let keepTypes = false;
		let sawIs = false;
		const addParsedKeywords = (raw: string): boolean => {
			const parsed = parseKeywordList(raw);
			if (!parsed) return false;
			keywords = keywords ? [...keywords, ...parsed] : parsed;
			return true;
		};
		const addParsedQuotes = (raw: string): boolean => {
			const parsed = parseGrantedAbilities(raw, depth);
			if (!parsed) return false;
			grantedAbilities = grantedAbilities ? [...grantedAbilities, ...parsed] : parsed;
			return true;
		};
		const steps: Array<[RegExp, (mm: RegExpMatchArray) => boolean]> = [
			[/^(?:, and it|, and|and it|and|,)(?=\s)/, () => true],
			[/^loses all other abilities, card types, and creature types/, () => ((losesAll = true), (losesTypes = true), true)],
			[/^loses all other card types and creature types/, () => ((losesTypes = true), true)],
			[/^loses all other card types and abilities/, () => ((losesAll = true), (losesTypes = true), true)],
			// --- Track P14: "loses all other card types" (e.g. One with the Stars) ---
			[/^loses all other card types/, () => ((losesTypes = true), true)],
			// --- End Track P14 ---
			[/^loses all (?:other )?abilities/, () => ((losesAll = true), true)],
			[
				/^is an? (.+?)(?= with | that's still | in addition to |,? and |$)/,
				(mm) => {
					typeDesc = parseTypeDescription(mm[1]);
					sawIs = true;
					if (typeDesc?.basePT) basePT = typeDesc.basePT;
					return typeDesc !== null;
				}
			],
			[/^(?:with|has) base power and toughness (\d+)\/(\d+)/, (mm) => ((basePT = [parseInt(mm[1], 10), parseInt(mm[2], 10)]), true)],
			[/^(?:with|has) (?:"([^"]+)"|'([^']+)')/, (mm) => addParsedQuotes(mm[1] ?? mm[2])],
			[
				/^with ([^"']+?)(?= that's still | in addition to |,? and |$)/,
				(mm) => addParsedKeywords(mm[1])
			],
			[/^(?:that's |it's )?still an? (?:land|artifact|enchantment|planeswalker)/, () => ((keepTypes = true), true)],
			[/^in addition to its other types/, () => ((keepTypes = true), true)],
			[/^has (.+?)(?= that's still | in addition to |,? and it |,? and |$)/, (mm) => addParsedKeywords(mm[1])]
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
			if (desc.colors) items.push(continuous('5', 'attachedTo', { k: 'setColors', colors: desc.colors }));
		}
		// Ability loss applies before grants from the same effect ("has indestructible, and it loses all other abilities").
		if (losesAll) items.push(continuous('6', 'attachedTo', { k: 'removeAllAbilities' }));
		if (grantedAbilities) {
			for (const ability of grantedAbilities) {
				items.push(continuous('6', 'attachedTo', { k: 'grantAbility', ability }));
			}
		}
		if (keywords) items.push(continuous('6', 'attachedTo', { k: 'addKeywords', keywords }));
		if (basePT) items.push(continuous('7b', 'attachedTo', { k: 'setBasePT', power: n(basePT[0]), toughness: n(basePT[1]) }));
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
	const chosenCol = s.match(/^(.+?) (?:is|are) the chosen color$/i);
	if (chosenCol) {
		const affected = parseAffected(chosenCol[1]);
		return affected ? [continuous('5', affected, { k: 'setChosenColor' })] : null;
	}
	if (/^The same is true for creature spells you control and creature cards you own that aren't on the battlefield$/i.test(s)) {
		return [];
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
		/^([^"']+?) (?:is|are) (.+?) in addition to (?:its|their) other (?:land |creature )?types([\s\S]*)$/i
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
		/^([^"']+?) (?:is|are) (.+?) in addition to (?:its|their) other colors$/i
	);
	if (addColsGen) {
		const affected = parseAffected(addColsGen[1]);
		const cols = parseStaticColorWordList(addColsGen[2]);
		if (affected && cols && cols.length > 0) {
			return [continuous('5', affected, { k: 'addColors', colors: cols })];
		}
	}
	const setColsGen = s.match(/^([^"']+?) (?:is|are) (colorless|(?:white|blue|black|red|green)(?:(?:,\s*(?:and\s+)?|\s+and\s+)(?:white|blue|black|red|green))*)$/i);
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
		/^You control (enchanted (?:creature|permanent|land|artifact|planeswalker)|equipped creature)$/i
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
	/^(?:,\s*and\s+|,\s+|\s+and\s+)(?!can't have or gain\b|cannot have or gain\b)((?:has|have|gets|get|is|are|isn't|aren't|assigns|assign|can't|cannot|must|can block|can attack|doesn't untap|don't untap|attacks|attack|blocks|block|loses|lose)(?:\b[\s\S]*))$/i;

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
	if (words.length === 0 || words.includes(',')) return null;
	const rem = words.join(' ');
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
	const getsMatch = c.match(/^gets? (?:an additional )?([+−-]\d+\/[+−-]\d+)$/i);
	if (getsMatch) {
		const d = ptDelta(getsMatch[1]);
		if (d) {
			return [continuous('7c', affected, { k: 'pt', power: n(d[0]), toughness: n(d[1]) }, condition)];
		}
	}
	if (/^(?:is|are) (?:every creature type|all creature types)(?: in addition to (?:its|their) other types)?$/i.test(c)) {
		return [continuous('4', affected, { k: 'allCreatureTypes' }, condition)];
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
	const kwAndQuoted = hasBody.match(/^([^"']+?)(?:,\s*and|\s+and)(?: (?:has|have))? (?:"([^"]+)"|'([^']+)')$/i);
	if (kwAndQuoted) {
		const kws = parseKeywordList(kwAndQuoted[1]);
		const abilities = parseGrantedAbilities(kwAndQuoted[2] ?? kwAndQuoted[3], depth);
		if (kws && abilities) {
			return [
				keywordGrant(affected, kws, condition),
				...abilities.map((ability) =>
					continuous('6', affected, { k: 'grantAbility', ability }, condition)
				)
			];
		}
	}
	const quotedAndKw = hasBody.match(/^(?:"([^"]+)"|'([^']+)')(?:,\s*and|\s+and)(?: (?:has|have))? ([^"']+)$/i);
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
	return (s) => {
		// --- Track P11: Dynamic Layer 7b base P/T & generalized Layer 7c / Layer 6 grants ---
		const basePtX = s.match(
			/^([^"']+?) (?:has|have) base power and (?:base )?toughness X\/X,?\s+where X is (.+)$/i
		);
		if (basePtX) {
			const affected = parseAffected(basePtX[1]);
			const xAmt = parseCountAmount(basePtX[2]);
			if (affected && xAmt) {
				return [continuous('7b', affected, { k: 'setBasePT', power: xAmt, toughness: xAmt }, condition)];
			}
		}
		const basePtEqual = s.match(
			/^([^"']+?) (?:has|have) base power and (?:base )?toughness each equal to (.+)$/i
		);
		if (basePtEqual) {
			const affected = parseAffected(basePtEqual[1]);
			const amt = parseCountAmount(basePtEqual[2]);
			if (affected && amt) {
				return [continuous('7b', affected, { k: 'setBasePT', power: amt, toughness: amt }, condition)];
			}
		}
		const basePtFixed = s.match(
			/^([^"']+?) (?:has|have) base power and (?:base )?toughness (\d+)\/(\d+)([\s\S]*)$/i
		);
		if (basePtFixed) {
			const { modifierPart, tailPart } = splitPtModifierAndTail(basePtFixed[4]);
			if (modifierPart.trim() === '') {
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
		// --- Track P14: Single-axis Layer 7b base power / toughness (e.g. Maha, Its Feathers Night) ---
		const baseSingleAxis = s.match(
			/^([^"']+?) (?:has|have) base (power|toughness) (\d+)([\s\S]*)$/i
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

		const pt = s.match(/^([^"']+?) gets? (?:an additional )?([+−-])(\d+|X)\/([+−-])(\d+|X)([\s\S]*)$/i);
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

		const hasAny = s.match(/^([^"']+?) (?:has|have) (.+)$/);
		if (hasAny) {
			const affected = parseAffected(hasAny[1]);
			if (!affected) return null;
			return parseHasGrantTail(affected, hasAny[2], condition, depth);
		}
		// --- End Track P11 ---
		return null;
	};
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
	// --- End Track P14 ---

	return null;
}

function parseUnlessEtbCondition(clause: string): Condition | null {
	const t = clause.trim();
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
		/^(?:Threshold|Metalcraft|Delirium|Ferocious|Formidable|Spell mastery|Coven|Fateful hour|Hellbent|Domain|Morbid|Raid|Revolt|Undergrowth|Chroma|Constellation|Lieutenant|Descend 4|Descend 8|Fathomless descent|Corrupted)\s*—\s*/i
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

		// --- Track P8: Two-sentence Shocklands & Reveal Lands (CR 614.12, 119.4, 119.8) ---
		if (idx + 1 < sentences.length) {
			const nextTrimmed = sentences[idx + 1].text.replace(/’/g, "'").replace(/\.$/, '').trim();
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
