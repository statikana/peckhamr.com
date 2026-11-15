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
import { parseCost, parseObjectPhrase } from './costs.ts';
import { parseEffects } from './effects.ts';
import { staticallyInterpretable } from './interpretable.ts';
import { splitSentences } from './normalize.ts';
import { parseActivatedIfConditionSentence, parseCondition } from './triggers.ts';

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
const COUNTERS: Record<string, CounterType> = {
	'+1/+1': '+1/+1',
	'-1/-1': '-1/-1',
	'−1/−1': '-1/-1',
	charge: 'charge',
	loyalty: 'loyalty',
	shield: 'shield',
	stun: 'stun',
	lore: 'lore',
	time: 'time',
	age: 'age',
	level: 'level',
	fade: 'fade'
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
		if (!/^protection from (?:[a-z]+(?:,? (?:and )?from [a-z]+)*|everything)$/.test(protection)) return null;
	}
	if (rest) {
		for (const raw of rest.split(/,\s*(?:and\s+)?|\s+and\s+/)) {
			const kw = raw.trim().toLowerCase();
			if (!kw) continue;
			if (KEYWORDS.has(kw) || /^ward \{[^}]+\}$/.test(kw) || /^hexproof from [a-z]+$/.test(kw)) out.push(kw);
			else return null;
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

/**
 * The subject of a continuous effect: "~", "equipped creature", "Other Elf creatures you control",
 * "Creatures your opponents control", "All creatures", "Each land", "Nonbasic lands".
 */
export function parseAffected(subject: string): Affected | null {
	const s = subject.trim();
	if (s === '~' || /^it$/i.test(s)) return 'self';
	if (/^(?:equipped|enchanted) (?:creature|permanent|land|artifact|enchantment|planeswalker|plains|island|swamp|mountain|forest)$/i.test(s)) {
		return 'attachedTo';
	}
	let phrase = s.replace(/^(?:all|each) /i, '');
	let controller: ObjectFilter['controller'];
	const opp = phrase.match(/^(.+) your opponents control$/i);
	if (opp) {
		phrase = opp[1];
		controller = 'opponent';
	}
	const filter = parseObjectPhrase(phrase);
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
	if (/^your life total$/i.test(t)) return { k: 'life', of: { k: 'you' } };
	if (/^the number of cards in your hand$/i.test(t)) return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	if (/^the number of cards in your graveyard$/i.test(t)) {
		return { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } };
	}
	if (/^the number of cards in all graveyards$/i.test(t)) {
		return { k: 'count', of: { zone: 'graveyard' } };
	}
	if (/^the number of card types among cards in your graveyard$/i.test(t)) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' };
	}
	if (/^the number of card types among cards in all graveyards$/i.test(t)) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'all' };
	}
	if (/^the number of card types among cards in your opponents' graveyards$/i.test(t)) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'opponents' };
	}
	if (/^the number of times? you've cast (?:your|a) commander from the command zone this game$/i.test(t)) {
		return { k: 'commanderCastCount' };
	}
	const countersOnSelf = t.match(/^the number of (\S+) counters on (?:~|it)$/i);
	if (countersOnSelf) {
		const ctr = COUNTERS[countersOnSelf[1].toLowerCase().replace(/−/g, '-')];
		if (ctr) return { k: 'countersOn', counter: ctr, of: { k: 'self' } };
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
	const oppCtrl = m[1].match(/^(.+) your opponents control$/i);
	if (oppCtrl) {
		const fOpp = parseObjectPhrase(oppCtrl[1]);
		return fOpp && !fOpp.controller
			? { k: 'count', of: { zone: 'battlefield', ...fOpp, controller: 'opponent' } }
			: null;
	}
	const f = parseObjectPhrase(m[1]);
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

/**
 * A quoted activated ability granted by a continuous effect (CR 613.1f, 201.5):
 * e.g. "{T}: Add {C}.", "{T}, Sacrifice ~: Add two mana of any one color.", "{1}, {T}: Draw a card."
 * Returns null if not an activated ability or if its cost or effect cannot be fully automated.
 */
function parseGrantedActivatedAbility(quoted: string): ActivatedAbility | null {
	const trimmed = quoted.trim();
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

// ---- Productions ----------------------------------------------------------------------------

type Production = (s: string, span: Span) => StaticItem[] | null;

/** "If a card or token would be put into a graveyard from anywhere, exile it instead." etc. */
const replacements: Production = (s, span) => {
	if (/^if a card(?: or token)? would be put into a graveyard from anywhere, exile it instead$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'exile' } } }];
	}
	if (/^if a card(?: or token)? would be put into a graveyard from anywhere, shuffle it into its owner's library instead$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'library', shuffleIntoLibrary: true } } }];
	}
	const selfDieOrGy = s.match(
		/^if ~ would (die|be put into a graveyard from anywhere), (exile it|shuffle it into its owner's library|return it to its owner's hand|put it into its owner's hand) instead$/i
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
		const counters = body.match(
			/^~ enters (?:the battlefield )?with (\S+) (\S+) counters? on it( for each time (?:it|~) was kicked)?$/i
		);
		if (counters) {
			const baseAmount = count(counters[1]);
			const counter = COUNTERS[counters[2].toLowerCase()];
			if (baseAmount && counter) {
				let amount: Amount | null = baseAmount;
				if (counters[3]) {
					if (baseAmount.k === 'const' && baseAmount.n === 1) amount = { k: 'kickedCount' };
					else if (baseAmount.k === 'const' && baseAmount.n > 1) amount = { k: 'kickedCount', multiplier: baseAmount.n };
					else amount = null;
				}
				if (amount) return { k: 'modify', counters: { counter, amount } };
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
		return null;
	};
	const direct = parseSelfEtbModify(s);
	if (direct) {
		const isSelfChoice = Boolean(
			typeof direct === 'object' && !Array.isArray(direct) && direct.k === 'modify' && (direct.chooseSubType || direct.chooseColor)
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

	const suffixKicked = s.match(
		/^(.+?) (if (?:(?:it|~) (?:was(?:n't| not)? (?:kicked(?: with its .+? kicker| twice| \S+ times?)?|evoked|foretold|blitzed)|escaped|(?:didn't|did not) escape)|its (?:evoke|blitz) cost was(?:n't| not)? paid))$/i
	);
	if (suffixKicked) {
		const cond = parseCondition(suffixKicked[2]);
		const mod = parseSelfEtbModify(suffixKicked[1]);
		if (cond && mod) {
			return [{ kind: 'replacement', replacement: { replaces: entersSelf, with: mod, condition: cond } }];
		}
	}

	const prefixKicked = s.match(
		/^(if (?:(?:it|~) (?:was(?:n't| not)? (?:kicked(?: with its .+? kicker| twice| \S+ times?)?|evoked|foretold|blitzed)|escaped|(?:didn't|did not) escape)|its (?:evoke|blitz) cost was(?:n't| not)? paid)), (?:it )?(enters .+)$/i
	);
	if (prefixKicked) {
		const cond = parseCondition(prefixKicked[1]);
		if (cond) {
			const etbBody = `~ ${prefixKicked[2]}`;
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
const restrictions: Production = (s, span) => {
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
		const subj = restriction === 'cantBeCountered' ? m[1].replace(/\bspells?\b/gi, 'cards') : m[1];
		const affected = parseAffected(subj);
		if (!affected) return null;
		return [{ kind: 'static', static: { k: 'restriction', affected, restriction } }];
	}
	const withUnless = s.match(/^(.+?)\s+unless\s+(.+)$/i);
	if (withUnless) {
		const unlessCond = parseUnlessEtbCondition(withUnless[2]);
		if (unlessCond) {
			const baseItems = restrictions(withUnless[1], span);
			if (baseItems && withCondition(baseItems, { k: 'not', of: unlessCond })) {
				return baseItems;
			}
		}
	}
	return null;
};

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
	if (/^can't attack or block$/i.test(low)) {
		return { kind: 'static', static: { k: 'restriction', affected, restriction: 'cantAttackOrBlock' } };
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
				const f1 = parseCombatObjectPhrase(split[0]);
				const f2 = parseCombatObjectPhrase(split[1]);
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

	return null;
};

// --- Track P8: Top-of-Library Look/Reveal/Play (CR 401.5, 601.3e) & Graveyard Land Play (CR 305.1) ---

function parseSpellFilterForTopLibrary(raw: string): ObjectFilter | null {
	const trimmed = raw.trim();
	const chosenType = trimmed.match(/^(.+?) spells of the chosen type$/i);
	if (chosenType) {
		const base = parseObjectPhrase(`${chosenType[1]} card`);
		return base ? { ...base, ofChosenType: true } : null;
	}
	if (/^spells of the chosen type$/i.test(trimmed)) {
		return { ofChosenType: true };
	}
	const spellMatch = trimmed.match(/^(.+?) spells$/i);
	if (!spellMatch) return null;
	return parseObjectPhrase(`${spellMatch[1]} card`);
}

const topOfLibraryAndGraveyardPlay: Production = (s) => {
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
	if (low === 'if one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead') {
		return mult({ k: 'multiplier', what: 'counters', factor: 1, delta: 1, filter: { types: ['Creature'], controller: 'you' }, counter: '+1/+1' });
	}
	if (low === 'if one or more +1/+1 counters would be put on a creature you control, twice that many +1/+1 counters are put on it instead') {
		return mult({ k: 'multiplier', what: 'counters', factor: 2, filter: { types: ['Creature'], controller: 'you' }, counter: '+1/+1' });
	}
	if (low === 'if an effect would put one or more counters on a permanent you control, it puts twice that many of each of those kinds of counters on that permanent instead') {
		return mult({ k: 'multiplier', what: 'counters', factor: 2, filter: { controller: 'you' } });
	}
	if (low === 'if an effect would create one or more tokens under your control, it creates twice that many of those tokens instead' || low === 'if one or more tokens would be created under your control, twice that many of those tokens are created instead') {
		return mult({ k: 'multiplier', what: 'tokens', factor: 2, filter: { controller: 'you' } });
	}
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
	const flashFor = low.match(/^you may cast (.+) spells as though they had flash$/);
	if (flashFor) {
		const filter = parseObjectPhrase(`${flashFor[1].replace(/ and /g, ' or ')} card`);
		if (filter) return [rule('castAsThoughFlash', 'you', { spells: filter })];
	}
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
		const self = s.match(/^~ costs (\{\d+\}) (less|more) to cast(?: for each (.+))?$/);
		if (self) {
			if (!self[3]) return build({ k: 'self' }, self[1], self[2], 'you');
			const times = parseCountAmount(`the number of ${self[3]}`);
			return times ? build({ k: 'self' }, self[1], self[2], 'you', times) : null;
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
			return [{ kind: 'static', static: def }];
		}
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
		while (words.length >= 2) {
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
const attachedTypeChange: Production = (s) => {
	const m = s.match(
		/^(?:Enchanted|Equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker|Plains|Island|Swamp|Mountain|Forest) (.+)$/
	);
	if (!m) return null;
	let rest = m[1];
	let typeDesc: ReturnType<typeof parseTypeDescription> = null;
	let basePT: [number, number] | undefined;
	let granted: AbilityDef | undefined;
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
	const steps: Array<[RegExp, (mm: RegExpMatchArray) => boolean]> = [
		[/^(?:, and it|, and|and it|and|,)(?=\s)/, () => true],
		[/^loses all other abilities, card types, and creature types/, () => ((losesAll = true), (losesTypes = true), true)],
		[/^loses all other card types and creature types/, () => ((losesTypes = true), true)],
		[/^loses all other card types and abilities/, () => ((losesAll = true), (losesTypes = true), true)],
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
		[/^with (?:"([^"]+)"|'([^']+)')/, (mm) => ((granted = parseGrantedActivatedAbility(mm[1] ?? mm[2]) ?? undefined), granted !== undefined)],
		[
			/^with ([^"']+?)(?= that's still | in addition to |,? and |$)/,
			(mm) => addParsedKeywords(mm[1])
		],
		[/^(?:that's |it's )?still an? (?:land|artifact|enchantment|planeswalker)/, () => ((keepTypes = true), true)],
		[/^in addition to its other types/, () => ((keepTypes = true), true)],
		[/^has (.+?)(?= that's still | in addition to |,? and it |,? and |$)/, (mm) => addParsedKeywords(mm[1])]
	];
	while ((rest = rest.trimStart()).length > 0) {
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
	if (granted) items.push(continuous('6', 'attachedTo', { k: 'grantAbility', ability: granted }));
	if (keywords) items.push(continuous('6', 'attachedTo', { k: 'addKeywords', keywords }));
	if (basePT) items.push(continuous('7b', 'attachedTo', { k: 'setBasePT', power: n(basePT[0]), toughness: n(basePT[1]) }));
	return items;
};

/** Global type and ability changers: Humility, Blood Moon, Urborg, Opalescence, Mycosynth, Maskwood. */
const globalChanges: Production = (s) => {
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
	const eachLand = s.match(/^Each land is an? (Plains|Island|Swamp|Mountain|Forest) in addition to its other land types$/);
	if (eachLand) return [continuous('4', { types: ['Land'] }, { k: 'addTypes', types: [], subtypes: [eachLand[1]] })];
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
	const every = s.match(/^(.+?) are every creature type$/);
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

/**
 * Anthems, lords and attached grants: "Other Elf creatures you control get +1/+1.", "Equipped
 * creature gets +1/+1 and has trample and lifelink.", "Creatures you control have flying.",
 * "~ gets +1/+0 for each artifact you control.", 'Lands you control have "{T}: Add one mana of any color."'
 */
function grants(condition?: Condition): Production {
	return (s) => {
		const quoted = s.match(/^(.+?) (?:has|have) (?:"([^"]+)"|'([^']+)')$/);
		if (quoted) {
			const affected = parseAffected(quoted[1]);
			const ability = parseGrantedActivatedAbility(quoted[2] ?? quoted[3]);
			return affected && ability ? [continuous('6', affected, { k: 'grantAbility', ability }, condition)] : null;
		}
		const pt = s.match(/^(.+?) gets? ([+−-]\d+\/[+−-]\d+)(?: for each (.+?))?(?: and (.+))?$/);
		if (pt) {
			const affected = parseAffected(pt[1]);
			const delta = ptDelta(pt[2]);
			if (!affected || !delta) return null;
			let power: Amount = n(delta[0]);
			let toughness: Amount = n(delta[1]);
			if (pt[3]) {
				// Only "+1/+0 for each": Amount has no multiplication yet.
				const per = parseCountAmount(`the number of ${pt[3]}`);
				if (!per || ![0, 1].includes(Math.abs(delta[0])) || ![0, 1].includes(Math.abs(delta[1])) || delta[0] < 0 || delta[1] < 0) return null;
				power = delta[0] ? per : n(0);
				toughness = delta[1] ? per : n(0);
			}
			const items: StaticItem[] = [continuous('7c', affected, { k: 'pt', power, toughness }, condition)];
			if (pt[4]) {
				const tail = pt[4].trim();
				const hasMatch = tail.match(/^(?:has|have) (.+)$/i);
				if (hasMatch) {
					const hasBody = hasMatch[1].trim();
					if (/^protection from the chosen color$/i.test(hasBody)) {
						items.push(continuous('6', affected, { k: 'protectionFromChosenColor' }, condition));
					} else {
						const kws = parseKeywordList(hasBody);
						if (!kws) return null;
						items.push(keywordGrant(affected, kws, condition));
					}
				} else {
					const combatTail = parseInlineCombatTail(affected, tail);
					if (!combatTail) return null;
					if (condition) withCondition([combatTail], condition);
					items.push(combatTail);
				}
			}
			return items;
		}
		const protChosen = s.match(/^(.+?) (?:has|have) protection from the chosen color$/i);
		if (protChosen) {
			const affected = parseAffected(protChosen[1]);
			return affected
				? [continuous('6', affected, { k: 'protectionFromChosenColor' }, condition)]
				: null;
		}
		const kwWithCombat = s.match(/^(.+?) (?:has|have) (.+?) and ((?:can't|cannot|must|can block)\b.+)$/i);
		if (kwWithCombat) {
			const affected = parseAffected(kwWithCombat[1]);
			const kws = parseKeywordList(kwWithCombat[2]);
			const combatTail = affected ? parseInlineCombatTail(affected, kwWithCombat[3]) : null;
			if (affected && kws && combatTail) {
				if (condition) withCondition([combatTail], condition);
				return [keywordGrant(affected, kws, condition), combatTail];
			}
		}
		const kw = s.match(/^(.+?) (?:has|have) (.+)$/);
		if (kw) {
			const affected = parseAffected(kw[1]);
			const kws = parseKeywordList(kw[2]);
			return affected && kws ? [keywordGrant(affected, kws, condition)] : null;
		}
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

function parseStaticCondition(clause: string): Condition | null {
	const t = clause.trim();
	const cond = parseCondition(`if ${t}`);
	if (cond) return cond;

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

	// Self state: "~ is tapped / untapped / equipped / enchanted / attacking / blocking / monstrous / saddled"
	const selfState = t.match(/^(?:(?:~|it) is|it's) ([a-z]+)$/i);
	if (selfState) {
		const st = parseObjectStateWord('self', selfState[1]);
		if (st) return st;
	}

	// Attached state: "enchanted creature is tapped / white / a Human / ..."
	const attState = t.match(
		/^(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker) is (.+)$/i
	);
	if (attState) {
		const st = parseObjectStateWord('attachedTo', attState[1]);
		if (st) return st;
		const qual = attState[1].trim().replace(/^(?:a|an)\s+/i, '');
		const filter = parseObjectPhrase(qual) ?? parseObjectPhrase(`${qual} permanent`);
		if (filter) {
			return { k: 'objectState', of: 'attachedTo', filter };
		}
	}

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

function parseSentence(sentence: string, span: Span): StaticItem[] | null {
	let s = sentence.replace(/’/g, "'").replace(/\.$/, '').trim();
	// Strip optional raw CR 207.2c ability-word prefix if caller bypassed normalize.ts
	const abilityWordPrefix = s.match(
		/^(?:Threshold|Metalcraft|Delirium|Ferocious|Formidable|Spell mastery|Coven|Fateful hour|Hellbent)\s*—\s*/i
	);
	if (abilityWordPrefix) {
		s = s.slice(abilityWordPrefix[0].length).trim();
	}

	const eminence = s.match(EMINENCE);
	if (eminence) {
		const rest = s.slice(eminence[0].length);
		return costModifiers(['battlefield', 'command'])(rest.charAt(0).toUpperCase() + rest.slice(1), span);
	}

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
		const duringTurnSuffix = s.match(/^(.+?)(?<!untap)\s+during your turn$/i);
		if (duringTurnSuffix && !/^you may play\b/i.test(duringTurnSuffix[1])) {
			addCond({ k: 'isTurnOf', player: { k: 'you' } });
			s = duringTurnSuffix[1];
		}
	}

	const prefix = s.match(AS_LONG_AS_PREFIX);
	const suffix = !prefix ? s.match(AS_LONG_AS_SUFFIX) : null;
	if (prefix || suffix) {
		const cond = parseStaticCondition((prefix ?? suffix)![1]);
		if (!cond) return null;
		addCond(cond);
		s = prefix ? s.slice(prefix[0].length) : s.slice(0, suffix!.index);
		s = s.charAt(0).toUpperCase() + s.slice(1);
	}

	const productions: Production[] = [
		replacements,
		multipliers,
		ruleModifiers,
		topOfLibraryAndGraveyardPlay,
		costModifiers(),
		cda,
		attachedTypeChange,
		globalChanges,
		controlChange,
		combatAndActivationRules,
		restrictions,
		keywordRemoval,
		grants()
	];
	for (const p of productions) {
		const items = p(s, span);
		if (!items) continue;
		if (condition && !withCondition(items, condition)) return null;
		return items;
	}
	return null;
}

/** Parses a static ability line (normalised body text). `offset` is its position in the caller's text. */
export function parseStaticAbility(text: string, offset = 0): StaticParse {
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
		const parsed = parseSentence(sentence.text, sentence.span);
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
