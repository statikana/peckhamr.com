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
	Amount,
	Condition,
	EventPattern,
	Layer,
	LayerMod,
	ObjectFilter,
	ReplacementDef,
	Span,
	StaticDef
} from '../ir.ts';
import type { CounterType, ManaColor, ZoneType } from '../types.ts';
import { parseCost, parseObjectPhrase } from './costs.ts';
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

const KEYWORDS = new Set([
	'changeling',
	'deathtouch',
	'defender',
	'double strike',
	'fear',
	'first strike',
	'flash',
	'flying',
	'haste',
	'hexproof',
	'horsemanship',
	'indestructible',
	'infect',
	'intimidate',
	'lifelink',
	'menace',
	'prowess',
	'reach',
	'shadow',
	'shroud',
	'trample',
	'vigilance',
	'wither'
]);

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
	if (s === '~') return 'self';
	if (/^(?:equipped|enchanted) (?:creature|permanent|land|artifact|planeswalker)$/i.test(s)) return 'attachedTo';
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
	const grave = t.match(/^the number of (.+) cards in all graveyards$/);
	if (grave) {
		const f = parseObjectPhrase(`${grave[1]} card`);
		return f ? { k: 'count', of: { ...f, zone: 'graveyard' } } : null;
	}
	const m = t.match(/^the number of (.+?)( on the battlefield)?$/);
	if (!m) return null;
	const f = parseObjectPhrase(m[1]);
	return f ? { k: 'count', of: { ...f, zone: 'battlefield' } } : null;
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

/** A quoted mana ability: "{T}: Add {C}.", "{T}: Add one mana of any color." Null otherwise. */
function parseGrantedManaAbility(quoted: string): AbilityDef | null {
	const m = quoted.trim().replace(/\.$/, '').match(/^(.+?): Add (.+)$/);
	if (!m) return null;
	const cost = parseCost(m[1]);
	if (cost.unparsed.length > 0) return null;
	const span = { start: 0, end: 0 };
	let params: NonNullable<ActivatedAbility['effect'][number]['params']>;
	let amount = 1;
	if (m[2] === 'one mana of any color') params = { manaChoice: 'any' };
	else if (/^(\{[WUBRGC]\})+$/.test(m[2])) {
		const syms = (m[2].match(/\{([WUBRGC])\}/g) || []).map((s) => s[1] as ManaColor);
		params = { mana: syms };
		amount = syms.length;
	} else return null;
	const colors = params.mana ? [...new Set(params.mana)].join('').toLowerCase() : 'any';
	return {
		kind: 'activated',
		id: `granted_mana_${colors}`,
		cost: cost.defs,
		targets: [],
		effect: [{ verb: 'addMana', subject: { k: 'none' }, amount: n(amount), params, span }],
		timing: 'mana',
		isMana: true,
		span
	};
}

// ---- Productions ----------------------------------------------------------------------------

type Production = (s: string, span: Span) => StaticItem[] | null;

/** "If a card or token would be put into a graveyard from anywhere, exile it instead." etc. */
const replacements: Production = (s, span) => {
	if (/^if a card or token would be put into a graveyard from anywhere, exile it instead$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'exile' } } }];
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
	const entersSelf: EventPattern = { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } };
	if (/^~ enters (?:the battlefield )?tapped$/i.test(s)) {
		return [{ kind: 'replacement', replacement: { replaces: entersSelf, with: { k: 'modify', tapped: true } } }];
	}
	const counters = s.match(/^~ enters (?:the battlefield )?with (\S+) (\S+) counters? on it$/i);
	if (counters) {
		const amount = count(counters[1]);
		const counter = COUNTERS[counters[2].toLowerCase()];
		if (amount && counter) {
			return [{ kind: 'replacement', replacement: { replaces: entersSelf, with: { k: 'modify', counters: { counter, amount } } } }];
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
	[/^(.+?) (?:doesn't|don't) untap during (?:your|its controller's|their controllers') untap steps?$/, 'doesntUntap']
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
	if (low === "you can't lose the game") return [rule('cantLose', 'you')];
	if (low === "your opponents can't win the game") return [rule('opponentsCantWin', 'each_opponent')];
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
		const equip = s.match(/^Equip abilities you activate cost (\{\d+\}) less to activate$/i);
		if (equip) return build({ k: 'ability', keyword: 'equip' }, equip[1], 'less', 'you');
		if (/^Equipment you control have equip \{0\}$/i.test(s)) {
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

/** "<a/an> <color>? <subtypes> <types>": "Insect artifact creature", "green Elk creature", "colorless Forest land". */
function parseTypeDescription(desc: string): { colors?: ManaColor[]; types: string[]; subtypes: string[] } | null {
	const words = desc.trim().split(/\s+/);
	let colors: ManaColor[] | undefined;
	if (words[0] === 'colorless') {
		colors = [];
		words.shift();
	} else if (COLORS[words[0]]) {
		colors = [COLORS[words.shift()!]];
	}
	const types: string[] = [];
	const subtypes: string[] = [];
	for (const w of words) {
		if (CARD_TYPES[w]) types.push(CARD_TYPES[w]);
		else if (/^[A-Z][a-z]+$/.test(w) && types.length === 0) subtypes.push(w);
		else return null;
	}
	return types.length > 0 ? { colors, types, subtypes } : null;
}

/**
 * Attached type changers and ability loss: "Enchanted creature is an Insect artifact creature with
 * base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types,
 * and creature types.", "Enchanted creature loses all abilities and is a green Elk creature with base
 * power and toughness 3/3.", "Enchanted permanent is a colorless Forest land."
 */
const attachedTypeChange: Production = (s) => {
	const m = s.match(/^(?:Enchanted|Equipped) (?:creature|permanent|land|artifact) (.+)$/);
	if (!m) return null;
	let rest = m[1];
	let typeDesc: ReturnType<typeof parseTypeDescription> = null;
	let basePT: [number, number] | undefined;
	let granted: AbilityDef | undefined;
	let keywords: string[] | undefined;
	let losesAll = false;
	let losesTypes = false;
	let sawIs = false;
	const steps: Array<[RegExp, (mm: RegExpMatchArray) => boolean]> = [
		[/^(?:, and it|, and|and it|and|,)(?=\s)/, () => true],
		[/^loses all other abilities, card types, and creature types/, () => ((losesAll = true), (losesTypes = true), true)],
		[/^loses all other card types and creature types/, () => ((losesTypes = true), true)],
		[/^loses all other card types and abilities/, () => ((losesAll = true), (losesTypes = true), true)],
		[/^loses all (?:other )?abilities/, () => ((losesAll = true), true)],
		[/^is an? (.+?)(?= with |,? and |$)/, (mm) => ((typeDesc = parseTypeDescription(mm[1])), (sawIs = true), typeDesc !== null)],
		[/^(?:with|has) base power and toughness (\d+)\/(\d+)/, (mm) => ((basePT = [parseInt(mm[1], 10), parseInt(mm[2], 10)]), true)],
		[/^with "([^"]+)"/, (mm) => ((granted = parseGrantedManaAbility(mm[1]) ?? undefined), granted !== undefined)],
		[/^has (.+?)(?=,? and it |$)/, (mm) => ((keywords = parseKeywordList(mm[1]) ?? undefined), keywords !== undefined)]
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
		// CR 205.1b: "[creature type] artifact creature" keeps prior types unless the text says it loses them.
		if (desc.types.includes('Artifact') && desc.types.includes('Creature') && !losesTypes) return null;
		items.push(continuous('4', 'attachedTo', { k: 'setTypes', types: desc.types, subtypes: desc.subtypes }));
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
		const quoted = s.match(/^(.+?) (?:has|have) "(.+)"$/);
		if (quoted) {
			const affected = parseAffected(quoted[1]);
			const ability = parseGrantedManaAbility(quoted[2]);
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

	const productions: Production[] = [replacements, multipliers, ruleModifiers, costModifiers(), cda, attachedTypeChange, globalChanges, restrictions, keywordRemoval, grants()];
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
		const parsed = parseSentence(sentence.text, sentence.span);
		if (parsed && (parsed.length > 0 || items.length > 0)) items.push(...parsed);
		else unparsed.push(sentence.span);
	}
	return { items, unparsed };
}
