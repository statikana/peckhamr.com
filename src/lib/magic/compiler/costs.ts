/**
 * Cost grammar (ENGINE_ARCHITECTURE_PLAN.md section 2.2; first production of the real grammar).
 *
 * Parses the cost of an activated ability ("{2}, {T}, Sacrifice ~") or the body of an additional
 * cost ("As an additional cost to cast ~, sacrifice a creature.") into CostDefs. Input is
 * normalised text (self-references are `~`). Every cost part is either consumed by a production or
 * reported as an unparsed span; nothing is skipped silently.
 *
 * Runs alongside the Phase 1 adapter for now. scripts/magic-costs-diff.ts compares the two.
 */
import type { Amount, Compare, CostDef, ObjectFilter, Span, StaticDef } from '../ir.ts';
import type { CounterType } from '../types.ts';

export interface CostParse {
	defs: CostDef[];
	/** Cost parts no production consumed, as offsets into the caller's text. */
	unparsed: Span[];
}

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
	ten: 10
};

const CARD_TYPES: Record<string, string> = {
	artifact: 'Artifact',
	battle: 'Battle',
	creature: 'Creature',
	enchantment: 'Enchantment',
	instant: 'Instant',
	land: 'Land',
	planeswalker: 'Planeswalker',
	sorcery: 'Sorcery'
};

const SUPERTYPES: Record<string, string> = { basic: 'Basic', legendary: 'Legendary', snow: 'Snow' };

const COLORS: Record<string, 'W' | 'U' | 'B' | 'R' | 'G'> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G'
};

const IRREGULAR_PLURALS: Record<string, string> = {
	Elves: 'Elf',
	Dwarves: 'Dwarf',
	Wolves: 'Wolf',
	Sorceries: 'Sorcery',
	sorceries: 'sorcery'
};

// Subtypes whose singular ends in "s".
const SINGULAR_S = new Set(['Plains', 'Fungus', 'Octopus', 'Homunculus', 'Atog', 'Nephilim']);

const COUNTERS: Record<string, CounterType> = {
	'+1/+1': '+1/+1',
	'-1/-1': '-1/-1',
	'−1/−1': '-1/-1',
	loyalty: 'loyalty',
	charge: 'charge',
	shield: 'shield',
	stun: 'stun',
	lore: 'lore',
	time: 'time'
};

const COST_VERBS =
	'sacrifice|tap|untap|discard|pay|exile|remove|return|put|reveal|mill|collect|forage|exert|blight|waterbend';
const COST_VERB = new RegExp(`^(?:\\{|(?:${COST_VERBS})\\b)`, 'i');
const COST_SEPARATOR = new RegExp(`,\\s*|\\s+and\\s+(?=(?:${COST_VERBS})\\b)`, 'gi');

function count(word: string): Amount | null {
	const low = word.toLowerCase();
	if (low === 'x') return { k: 'x' };
	if (/^\d+$/.test(low)) return { k: 'const', n: parseInt(low, 10) };
	const n = NUMBER_WORDS[low];
	return n === undefined ? null : { k: 'const', n };
}

function singular(word: string): string {
	if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
	if (SINGULAR_S.has(word)) return word;
	if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
	if (/(?:ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
	return word.endsWith('s') ? word.slice(0, -1) : word;
}

// ---- Object phrases -------------------------------------------------------------------------

/** One noun of a type group: a card type ("creature"), a subtype ("Elf") or a placeholder. */
type Noun = { types?: string[]; subtypes?: string[]; token?: true; isCommander?: true; any?: true };

function noun(word: string): Noun | null {
	const s = singular(word);
	const low = s.toLowerCase();
	if (CARD_TYPES[low]) return { types: [CARD_TYPES[low]] };
	if (low === 'permanent' || low === 'card') return { any: true };
	if (low === 'token') return { token: true };
	if (low === 'commander') return { isCommander: true };
	if (/^[A-Z][a-z'-]+$/.test(s)) return { subtypes: [s] };
	return null;
}

/**
 * Parses an object phrase such as "untapped Elves you control", "another creature",
 * "artifact or creature", "nonland permanent", "basic land card", "Goblin creature".
 * Returns null unless the whole phrase is understood.
 */
export function parseObjectPhrase(phrase: string): ObjectFilter | null {
	const filter: ObjectFilter = {};
	let rest = phrase.trim();

	// Trailing qualifiers, in either order: "creature you control with power 4 or greater".
	for (;;) {
		const youControl = rest.match(/^(.+?)\s+you control$/i);
		if (youControl && !filter.controller) {
			filter.controller = 'you';
			rest = youControl[1];
			continue;
		}
		const youOwn = rest.match(/^(.+?)\s+you own$/i);
		if (youOwn && !filter.owner) {
			filter.owner = 'you';
			rest = youOwn[1];
			continue;
		}
		const withStat = rest.match(/^(.+?)\s+with (power|mana value) (\S+)(?: or (greater|more|less|fewer))?$/i);
		if (withStat) {
			const value = count(withStat[3]);
			if (!value || value.k === 'const' && withStat[3].toLowerCase() === 'a') return null;
			const dir = withStat[4]?.toLowerCase();
			const cmp: Compare = { op: !dir ? '=' : dir === 'greater' || dir === 'more' ? '>=' : '<=', value };
			const key = withStat[2].toLowerCase() === 'power' ? 'power' : 'manaValue';
			if (filter[key]) return null;
			filter[key] = cmp;
			rest = withStat[1];
			continue;
		}
		break;
	}
	const words = rest.split(/\s+/).filter(Boolean);

	// Leading modifiers.
	while (words.length > 0) {
		const low = words[0].toLowerCase();
		if (low === 'another' || low === 'other') filter.other = true;
		else if (low === 'untapped') filter.tapped = false;
		else if (low === 'tapped') filter.tapped = true;
		else if (low === 'nontoken') filter.token = false;
		else if (low === 'commander' || low === 'commanders') filter.isCommander = true;
		else if (SUPERTYPES[low]) (filter.supertypes ??= []).push(SUPERTYPES[low]);
		else if (COLORS[low]) (filter.colors ??= []).push(COLORS[low]);
		else if (/^non[a-z]+$/.test(low) && CARD_TYPES[low.slice(3)]) {
			(filter.notTypes ??= []).push(CARD_TYPES[low.slice(3)]);
		} else if (/^non[a-z]+$/.test(low) && SUPERTYPES[low.slice(3)]) {
			(filter.notSupertypes ??= []).push(SUPERTYPES[low.slice(3)]);
		} else if (/^non-[A-Z][a-z]+$/.test(words[0])) {
			(filter.notSubtypes ??= []).push(words[0].slice(4));
		} else break;
		words.shift();
	}
	if (words.length === 0) return filter.isCommander ? filter : null;

	// "card(s)" after a type ("creature card") adds nothing.
	if (words.length > 1 && /^cards?$/i.test(words[words.length - 1])) words.pop();

	// Disjunction: "artifact or creature", "Elf, Goblin, or Wizard". Each alternative is one noun of
	// the same kind, since ObjectFilter can't express OR across different fields.
	const joined = words.join(' ').replace(/,/g, ' ,');
	if (/\b(?:or|and\/or)\b/.test(joined)) {
		const alts = joined
			.split(/\s*(?:,\s*(?:or|and\/or)?|\bor\b|\band\/or\b)\s*/)
			.map((a) => a.trim())
			.filter(Boolean);
		const nouns = alts.map((a) => (a.includes(' ') ? null : noun(a)));
		if (nouns.some((n) => !n || n.any || n.token)) return null;
		const allTypes = nouns.every((n) => n!.types);
		const allSubtypes = nouns.every((n) => n!.subtypes);
		if (!allTypes && !allSubtypes) return null;
		if (allTypes) filter.types = nouns.flatMap((n) => n!.types!);
		else filter.subtypes = nouns.flatMap((n) => n!.subtypes!);
		return filter;
	}

	// Conjunction: "Goblin creature", "Elf Warrior", "artifact creature" (all must hold).
	for (const w of words) {
		const n = noun(w);
		if (!n) return null;
		if (n.types) {
			// "artifact creature" means both types; ObjectFilter.types is any-of, so it isn't expressible.
			if (filter.types) return null;
			filter.types = n.types;
		}
		if (n.subtypes) {
			// "Elf Warrior" means both subtypes; likewise not expressible as any-of.
			if (filter.subtypes) return null;
			filter.subtypes = n.subtypes;
		}
		if (n.token) filter.token = true;
		if (n.isCommander) filter.isCommander = true;
	}
	return filter;
}

// ---- Productions ----------------------------------------------------------------------------

type Production = (part: string) => CostDef[] | null;

const ONE: Amount = { k: 'const', n: 1 };

/** "{2}{U}", "{T}", "{Q}", "{2}{T}" (some older cards combine symbols). */
const manaSymbols: Production = (part) => {
	const symbols = part.replace(/\s+/g, '').match(/\{[^}]+\}/g);
	if (!symbols || symbols.join('') !== part.replace(/\s+/g, '')) return null;
	const defs: CostDef[] = [];
	let mana = '';
	for (const s of symbols) {
		const up = s.toUpperCase();
		if (up === '{T}') defs.push({ k: 'tapSelf' });
		else if (up === '{Q}') defs.push({ k: 'untapSelf' });
		else if (up === '{E}' || up === '{TK}' || up === '{P}') return null; // energy, tickets, pawprints
		else mana += s;
	}
	if (mana) defs.push({ k: 'mana', cost: mana });
	return defs;
};

/** "Pay 2 life", "Pay X life". */
const payLife: Production = (part) => {
	const m = part.match(/^pay (\S+) life$/i);
	const amount = m && count(m[1]);
	return amount ? [{ k: 'payLife', amount }] : null;
};

/** "Pay {3}{B}" (an option of a choice between costs). */
const payMana: Production = (part) => {
	const m = part.match(/^pay ((?:\{[^}]+\})+)$/i);
	if (!m) return null;
	const symbols = m[1].match(/\{[^}]+\}/g)!;
	if (symbols.some((s) => /^\{(?:T|Q|E|TK|P)\}$/i.test(s))) return null;
	return [{ k: 'mana', cost: m[1] }];
};

/** "Sacrifice ~", "Sacrifice a creature", "Sacrifice two Foods", "Sacrifice another creature". */
const sacrifice: Production = (part) => {
	const m = part.match(/^sacrifice (.+)$/i);
	if (!m) return null;
	if (m[1] === '~') return [{ k: 'sacrifice', count: ONE, filter: 'self' }];
	const [first, ...rest] = m[1].split(' ');
	const n = count(first);
	const phrase = n ? rest.join(' ') : m[1];
	if (!n && !/^(?:another|other)\b/i.test(phrase)) return null;
	const filter = parseObjectPhrase(phrase);
	if (!filter || filter.controller) return null;
	return [{ k: 'sacrifice', count: n ?? ONE, filter: { ...filter, controller: 'you' } }];
};

/** "Tap ten untapped Elves you control", "Tap an untapped creature you control". */
const tapOthers: Production = (part) => {
	const m = part.match(/^tap (\S+) untapped (.+) you control$/i);
	if (!m) return null;
	const n = count(m[1]);
	const filter = parseObjectPhrase(m[2]);
	if (!n || !filter) return null;
	return [{ k: 'tapOthers', count: n, filter: { ...filter, controller: 'you', tapped: false } }];
};

/** "Discard a card", "Discard two cards", "Discard a creature card", "Discard a card at random". */
const discard: Production = (part) => {
	const m = part.match(/^discard (\S+) (.+?)( at random)?$/i);
	if (!m) return null;
	const n = count(m[1]);
	if (!n) return null;
	const random = m[3] ? true : undefined;
	if (/^cards?$/i.test(m[2])) return [{ k: 'discard', count: n, random }];
	if (!/\bcards?$/i.test(m[2])) return null;
	const filter = parseObjectPhrase(m[2]);
	return filter ? [{ k: 'discard', count: n, filter, random }] : null;
};

/** "Exile ~", "Exile ~ from your graveyard", "Exile two creature cards from your graveyard". */
const exileFrom: Production = (part) => {
	if (/^exile ~$/i.test(part)) return [{ k: 'exileFrom', zone: 'battlefield', count: ONE, filter: 'self' }];
	if (/^exile ~ from your graveyard$/i.test(part)) {
		return [{ k: 'exileFrom', zone: 'graveyard', count: ONE, filter: 'self' }];
	}
	const m = part.match(/^exile (\S+) (.+?) from your (graveyard|hand)$/i);
	if (!m) return null;
	const n = count(m[1]);
	const filter = /^cards?$/i.test(m[2]) ? {} : parseObjectPhrase(m[2]);
	if (!n || !filter) return null;
	return [
		{
			k: 'exileFrom',
			zone: m[3].toLowerCase() as 'graveyard' | 'hand',
			count: n,
			filter: Object.keys(filter).length > 0 ? filter : undefined
		}
	];
};

/** "Remove a +1/+1 counter from ~", "Remove X charge counters from ~". */
const removeCounters: Production = (part) => {
	const m = part.match(/^remove (\S+) (\S+) counters? from ~$/i);
	if (!m) return null;
	const n = count(m[1]);
	const counter = COUNTERS[m[2].toLowerCase()];
	return n && counter ? [{ k: 'removeCounters', counter, count: n, from: 'self' }] : null;
};

const PRODUCTIONS: Production[] = [
	manaSymbols,
	payLife,
	payMana,
	sacrifice,
	tapOthers,
	discard,
	exileFrom,
	removeCounters
];

const OR_BEFORE_VERB = new RegExp(`\\s+or\\s+(?=(?:${COST_VERBS})\\b)`, 'i');

function parsePart(text: string): CostDef[] | null {
	const out = PRODUCTIONS.reduce<CostDef[] | null>((acc, p) => acc ?? p(text), null);
	if (out) return out;
	// A choice between costs: "sacrifice a creature or pay {3}{B}", "discard a card or pay 3 life".
	// An "or" inside an object phrase ("an artifact or creature") isn't followed by a cost verb.
	const alts = text.split(new RegExp(OR_BEFORE_VERB.source, 'gi'));
	if (alts.length < 2) return null;
	const options = alts.map((a) => parsePart(a.trim()));
	if (options.some((o) => !o)) return null;
	return [{ k: 'choice', options: options as CostDef[][] }];
}

// ---- Entry points ---------------------------------------------------------------------------

/**
 * Splits a cost into parts at commas and at "and" before a cost verb ("discard a card and sacrifice a
 * creature"). A piece that doesn't start with a cost verb continues the previous part, which keeps
 * lists inside a part together ("Elf, Goblin, or Wizard").
 */
export function splitCostParts(text: string, offset = 0): Array<{ text: string; span: Span }> {
	const parts: Array<{ text: string; span: Span }> = [];
	let last = 0;
	const pieces: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(COST_SEPARATOR)) {
		pieces.push({ start: last, end: m.index });
		last = m.index + m[0].length;
	}
	pieces.push({ start: last, end: text.length });

	for (const piece of pieces) {
		const raw = text.slice(piece.start, piece.end);
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const start = offset + piece.start + (raw.length - raw.trimStart().length);
		const prev = parts[parts.length - 1];
		if (prev && !COST_VERB.test(trimmed)) {
			prev.span = { start: prev.span.start, end: start + trimmed.length };
			prev.text = text.slice(prev.span.start - offset, prev.span.end - offset);
		} else {
			parts.push({ text: trimmed, span: { start, end: start + trimmed.length } });
		}
	}
	return parts;
}

/** Parses the cost before the colon of an activated ability. */
export function parseCost(text: string, offset = 0): CostParse {
	const defs: CostDef[] = [];
	const unparsed: Span[] = [];
	for (const part of splitCostParts(text, offset)) {
		const out = parsePart(part.text);
		if (out) defs.push(...out);
		else unparsed.push(part.span);
	}
	return { defs, unparsed };
}

/**
 * Parses an additional-cost sentence: "As an additional cost to cast ~, <cost>." Returns null if the
 * sentence isn't one. "<cost> or <cost>" is a `choice`; "you may <cost>" is `optional`.
 */
export function parseAdditionalCostSentence(sentence: string, offset = 0): CostParse | null {
	const m = sentence.match(/^as an additional cost to cast (?:~|this spell), (.+?)\.?$/i);
	if (!m) return null;
	const start = offset + sentence.indexOf(m[1]);
	const may = m[1].match(/^you may (.+)$/i);
	if (may) {
		const inner = parseCost(may[1], start + m[1].length - may[1].length);
		if (inner.unparsed.length > 0 || inner.defs.length === 0) {
			return { defs: [], unparsed: [{ start, end: start + m[1].length }] };
		}
		return { defs: [{ k: 'optional', cost: inner.defs }], unparsed: [] };
	}
	// The cost starts lower-case after the comma; productions match case-insensitively.
	return parseCost(m[1], start);
}

// ---- Cost modifiers -------------------------------------------------------------------------

/**
 * Parses a static cost-modifying sentence into a `costModifier` StaticDef:
 * - "<object phrase> spells you cast cost {N} less/more to cast." (any type or subtype; "other" excludes
 *   the source; "As long as ~ is in the command zone or on the battlefield, ..." also works from the
 *   command zone)
 * - "This spell costs {N} less to cast for each <object phrase> on the battlefield."
 * Returns null unless the whole sentence is understood. Input is normalised (`~`, no reminder text).
 */
export function parseCostModifierSentence(sentence: string): StaticDef | null {
	const text = sentence.trim().replace(/\.$/, '');
	if (/^if you control (?:a|your) commander, you may cast (?:this spell|~) without paying its mana cost$/i.test(text)) {
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: { mode: 'setZero', generic: 0 },
			who: { relation: 'you' },
			condition: { k: 'controlCommander' }
		};
	}
	const selfCmd = text.match(
		/^(?:this spell|~) costs \{(\d+)\} (less|more) to cast for each time you've cast (?:your|a) commander from the command zone this game$/i
	);
	if (selfCmd) {
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: {
				mode: selfCmd[2].toLowerCase() === 'less' ? 'reduce' : 'increase',
				generic: parseInt(selfCmd[1], 10),
				per: { k: 'commanderCastCount' }
			},
			who: { relation: 'you' }
		};
	}
	const self = text.match(/^(?:this spell|~) costs \{(\d+)\} (less|more) to cast for each (.+?) on the battlefield$/i);
	if (self) {
		const per = parseObjectPhrase(self[3]);
		if (!per || per.controller) return null;
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: {
				mode: self[2].toLowerCase() === 'less' ? 'reduce' : 'increase',
				generic: parseInt(self[1], 10),
				per: { k: 'count', of: { ...per, zone: 'battlefield' } }
			},
			who: { relation: 'you' }
		};
	}

	const m = text.match(
		/^(as long as ~ is in the command zone or on the battlefield, )?(.+?) spells you cast cost \{(\d+)\} (less|more) to cast$/i
	);
	if (!m) return null;
	let phrase = m[2];
	let other = false;
	const otherMatch = phrase.match(/^other (.+)$/i);
	if (otherMatch) {
		other = true;
		phrase = otherMatch[1];
	}
	// "Instant and sorcery spells" means instant spells and sorcery spells: any of them.
	phrase = phrase.replace(/\s+and\s+/gi, ' or ');
	// "Noncreature spells": only modifiers, so the noun is the spell itself (any card).
	const filter = parseObjectPhrase(phrase) ?? parseObjectPhrase(`${phrase} card`);
	if (!filter || filter.controller || filter.other) return null;
	return {
		k: 'costModifier',
		affects: { k: 'spell', filter: other ? { ...filter, other: true } : filter },
		delta: { mode: m[4].toLowerCase() === 'less' ? 'reduce' : 'increase', generic: parseInt(m[3], 10) },
		who: { relation: 'you' },
		activeZones: m[1] ? ['battlefield', 'command'] : undefined
	};
}
