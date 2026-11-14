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
import { parseCondition } from './triggers.ts';

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
	time: 'time'
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
	if (t === 'the number of cards in your hand') return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	if (/^the number of times? you've cast (?:your|a) commander from the command zone this game$/i.test(t)) {
		return { k: 'commanderCastCount' };
	}
	const grave = t.match(/^the number of (.+) cards in all graveyards$/);
	if (grave) {
		const f = parseObjectPhrase(`${grave[1]} card`);
		return f ? { k: 'count', of: { ...f, zone: 'graveyard' } } : null;
	}
	const m = t.match(/^the number of (.+?)( on the battlefield)?$/);
	if (!m) return null;
	const f = parseObjectPhrase(m[1]);
	return f ? { k: 'count', of: { zone: 'battlefield', ...f } } : null;
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
	return Boolean(step.params?.mana || step.params?.manaChoice);
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
	const sentences = splitSentences(effectText, colon + 1).map((s) => s.text.toLowerCase());
	const isMana =
		effect.steps.length > 0 &&
		effect.targets.length === 0 &&
		effect.steps.every((s) => s.verb === 'addMana');
	const sorcery = sentences.some((s) => /^(?:activate|equip) only as a sorcery\.?$/.test(s));
	const timing: Timing = isMana ? 'mana' : sorcery ? 'sorcery' : 'instant';

	const activationRestrictions: ActivationRestriction[] = [];
	if (sentences.some((s) => /^activate only once each turn\.?$/.test(s))) {
		activationRestrictions.push('onceEachTurn');
	}
	if (sentences.some((s) => /^activate only during your turn\.?$/.test(s))) {
		activationRestrictions.push('duringYourTurn');
	}
	if (sentences.some((s) => /^activate only during your upkeep\.?$/.test(s))) {
		activationRestrictions.push('duringYourUpkeep');
	}
	if (sentences.some((s) => /^activate only during combat\.?$/.test(s))) {
		activationRestrictions.push('duringCombat');
	}

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
		if (/^(?:you may have )?~ enters? (?:the battlefield )?as a copy of any creature(?: on the battlefield)?$/i.test(body)) {
			return { k: 'modify', copyOf: { types: ['Creature'], zone: 'battlefield' } };
		}
		return null;
	};
	const direct = parseSelfEtbModify(s);
	if (direct) return [{ kind: 'replacement', replacement: { replaces: entersSelf, with: direct } }];

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
		/^(.+?) (if (?:(?:it|~) (?:was(?:n't| not)? kicked(?: with its .+? kicker| twice| \S+ times?)?|escaped|(?:didn't|did not) escape|was(?:n't| not)? evoked)|its evoke cost was(?:n't| not)? paid))$/i
	);
	if (suffixKicked) {
		const cond = parseCondition(suffixKicked[2]);
		const mod = parseSelfEtbModify(suffixKicked[1]);
		if (cond && mod) {
			return [{ kind: 'replacement', replacement: { replaces: entersSelf, with: mod, condition: cond } }];
		}
	}

	const prefixKicked = s.match(
		/^(if (?:(?:it|~) (?:was(?:n't| not)? kicked(?: with its .+? kicker| twice| \S+ times?)?|escaped|(?:didn't|did not) escape|was(?:n't| not)? evoked)|its evoke cost was(?:n't| not)? paid)), (?:it )?(enters .+)$/i
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
	[/^(.+?) (?:can't|cannot) crew Vehicles$/i, 'cantCrewVehicles']
];

/** "~ can't block.", "Enchanted creature can't attack or block.", "Creatures your opponents control can't block." */
const restrictions: Production = (s) => {
	for (const [re, restriction] of RESTRICTIONS) {
		const m = s.match(re);
		if (!m) continue;
		const subj = restriction === 'cantBeCountered' ? m[1].replace(/\bspells?\b/gi, 'cards') : m[1];
		const affected = parseAffected(subj);
		if (!affected) return null;
		return [{ kind: 'static', static: { k: 'restriction', affected, restriction } }];
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
		const spells = s.match(/^(.*?)\s*[Ss]pells(?: (you|your opponents) cast)? cost (\{\d+\}) (less|more) to cast$/);
		if (spells) {
			const who = spells[2] === 'you' ? 'you' : spells[2] === 'your opponents' ? 'each_opponent' : 'each_player';
			let filter: ObjectFilter = {};
			if (spells[1]) {
				// "Instant and sorcery spells" means spells that are either.
				const f = parseObjectPhrase(`${spells[1].replace(/ and /gi, ' or ')} card`);
				if (!f) return null;
				filter = f;
			}
			return build({ k: 'spell', filter }, spells[3], spells[4], who);
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

/** "~'s power and toughness are each equal to the number of creatures you control." (CR 604.3) */
const cda: Production = (s) => {
	const m = s.match(/^~'s power and toughness are each equal to (.+)$/);
	if (!m) return null;
	const amount = parseCountAmount(m[1]);
	return amount ? [continuous('7a', 'self', { k: 'setBasePT', power: amount, toughness: amount })] : null;
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
		const pt = s.match(/^(.+?) gets? ([+−-]\d+\/[+−-]\d+)(?: for each (.+?))?(?: and (?:has|have) (.+))?$/);
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
			const items = [continuous('7c', affected, { k: 'pt', power, toughness }, condition)];
			if (pt[4]) {
				const kws = parseKeywordList(pt[4]);
				if (!kws) return null;
				items.push(keywordGrant(affected, kws, condition));
			}
			return items;
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
const AS_LONG_AS_PREFIX = /^As long as ([^,]+), /;
const AS_LONG_AS_SUFFIX = /(?<!\bfor) as long as (.+)$/;

/** Attaches a condition to items whose StaticDef supports one. Returns false if any can't take it. */
function withCondition(items: StaticItem[], condition: Condition): boolean {
	for (const item of items) {
		if (item.kind === 'replacement') item.replacement.condition = condition;
		else if (item.static.k === 'continuous' || item.static.k === 'costModifier' || item.static.k === 'ruleModifier' || item.static.k === 'multiplier' || item.static.k === 'restriction') {
			item.static.condition = condition;
		} else return false;
	}
	return true;
}

function parseStaticCondition(clause: string): Condition | null {
	const cond = parseCondition(`if ${clause}`);
	if (cond) return cond;
	const twoColor = clause.trim().match(/^you control (?:a|an) (white|blue|black|red|green) or (white|blue|black|red|green) permanent$/i);
	if (twoColor) {
		return {
			k: 'compare',
			left: { k: 'count', of: { colors: [COLORS[twoColor[1].toLowerCase()], COLORS[twoColor[2].toLowerCase()]], controller: 'you' } },
			op: '>=',
			right: n(1)
		};
	}
	return null;
}

function parseSentence(sentence: string, span: Span): StaticItem[] | null {
	let s = sentence.replace(/’/g, "'").replace(/\.$/, '');

	const eminence = s.match(EMINENCE);
	if (eminence) {
		const rest = s.slice(eminence[0].length);
		return costModifiers(['battlefield', 'command'])(rest.charAt(0).toUpperCase() + rest.slice(1), span);
	}

	let condition: Condition | undefined;
	const prefix = s.match(AS_LONG_AS_PREFIX);
	const suffix = !prefix ? s.match(AS_LONG_AS_SUFFIX) : null;
	if (prefix || suffix) {
		const cond = parseStaticCondition((prefix ?? suffix)![1]);
		if (!cond) return null;
		condition = cond;
		s = prefix ? s.slice(prefix[0].length) : s.slice(0, suffix!.index);
		s = s.charAt(0).toUpperCase() + s.slice(1);
	}

	const productions: Production[] = [replacements, multipliers, ruleModifiers, costModifiers(), cda, attachedTypeChange, globalChanges, controlChange, restrictions, keywordRemoval, grants()];
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
	for (const sentence of splitSentences(text, offset)) {
		const trimmed = sentence.text.replace(/’/g, "'").replace(/\.$/, '').trim();
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
