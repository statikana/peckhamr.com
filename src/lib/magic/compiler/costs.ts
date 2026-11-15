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
import type { Amount, Compare, Condition, CostDef, CostDelta, ObjectFilter, Span, StaticDef } from '../ir.ts';
import type { CounterType, ManaColor, ZoneType } from '../types.ts';

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
	kindred: 'Kindred',
	tribal: 'Kindred',
	land: 'Land',
	planeswalker: 'Planeswalker',
	sorcery: 'Sorcery'
};

const SUPERTYPES: Record<string, string> = { basic: 'Basic', legendary: 'Legendary', snow: 'Snow' };

const COLORS: Record<string, ManaColor> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G',
	colorless: 'C'
};

// --- Track P8 ---
const NON_COLORS: Record<string, ManaColor> = {
	nonwhite: 'W',
	nonblue: 'U',
	nonblack: 'B',
	nonred: 'R',
	nongreen: 'G'
};

const FILTER_KEYWORDS = new Set([
	'flying',
	'first strike',
	'double strike',
	'deathtouch',
	'defender',
	'flash',
	'haste',
	'hexproof',
	'indestructible',
	'lifelink',
	'menace',
	'reach',
	'shroud',
	'trample',
	'vigilance',
	'ward',
	'fear',
	'intimidate',
	'shadow',
	'horsemanship',
	'skulk',
	'flanking',
	'infect',
	'wither',
	'changeling',
	'prowess',
	'toxic',
	'undying',
	'persist',
	'devoid',
	'islandwalk',
	'swampwalk',
	'mountainwalk',
	'forestwalk',
	'plainswalk'
]);

function parseKeywordList(raw: string, allowOr: boolean): string[] | null {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return null;
	if (!allowOr && /\bor\b/.test(trimmed)) return null;
	const sep = allowOr
		? /\s*(?:,\s*(?:or|and\/or|and)?|\bor\b|\band\/or\b|\band\b)\s*/
		: /\s*(?:,\s*(?:and\s+)?|\band\b)\s*/;
	const parts = trimmed.split(sep).filter(Boolean);
	if (parts.length === 0) return null;
	for (const p of parts) {
		if (!FILTER_KEYWORDS.has(p)) return null;
	}
	return parts;
}

const IRREGULAR_PLURALS: Record<string, string> = {
	Elves: 'Elf',
	Dwarves: 'Dwarf',
	Wolves: 'Wolf',
	Werewolves: 'Werewolf',
	Zombies: 'Zombie',
	Faeries: 'Faerie',
	Valkyries: 'Valkyrie',
	Mice: 'Mouse',
	Fungi: 'Fungus',
	Allies: 'Ally',
	Mercenaries: 'Mercenary',
	Heroes: 'Hero',
	Loci: 'Locus',
	Octopuses: 'Octopus',
	Sorceries: 'Sorcery',
	sorceries: 'sorcery'
};

// Subtypes whose singular ends in "s".
const SINGULAR_S = new Set([
	'Plains',
	'Fungus',
	'Octopus',
	'Homunculus',
	'Atog',
	'Nephilim',
	'Astartes',
	'Cyclops',
	'Sphinx',
	'Locus'
]);

export const COUNTERS: Record<string, CounterType> = {
	'+1/+1': '+1/+1',
	'-1/-1': '-1/-1',
	'−1/−1': '-1/-1',
	loyalty: 'loyalty',
	charge: 'charge',
	shield: 'shield',
	stun: 'stun',
	lore: 'lore',
	time: 'time',
	age: 'age',
	level: 'level',
	fade: 'fade',
	// --- Track P11: 12 keyword counters (CR 122.1b), finality (CR 122.1d), and 13 named counters ---
	flying: 'flying',
	'first strike': 'first strike',
	'double strike': 'double strike',
	deathtouch: 'deathtouch',
	haste: 'haste',
	hexproof: 'hexproof',
	indestructible: 'indestructible',
	lifelink: 'lifelink',
	menace: 'menace',
	reach: 'reach',
	trample: 'trample',
	vigilance: 'vigilance',
	finality: 'finality',
	oil: 'oil',
	ki: 'ki',
	quest: 'quest',
	storage: 'storage',
	verse: 'verse',
	spore: 'spore',
	divinity: 'divinity',
	feather: 'feather',
	gold: 'gold',
	plague: 'plague',
	blight: 'blight',
	stash: 'stash',
	vitality: 'vitality'
};

const COST_VERBS =
	'sacrifice|tap|untap|discard|pay|exile|remove|return|put|reveal|mill|collect|forage|exert|blight|waterbend|behold';
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

/** Singularizes a capitalized creature subtype token (e.g. "Zombies" -> "Zombie", "Orcs" -> "Orc", "Elves" -> "Elf"). */
export function singularSubtype(word: string): string | null {
	const trimmed = word.trim();
	if (!/^[A-Z][A-Za-z'-]*$/.test(trimmed)) return null;
	const s = singular(trimmed);
	if (CARD_TYPES[s.toLowerCase()] || SUPERTYPES[s.toLowerCase()]) return null;
	return s;
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
	if (/^[A-Z][A-Za-z'-]*$/.test(s)) return { subtypes: [s] };
	return null;
}

/**
 * Parses a disjunctive color prefix from `words` ("white or blue ...", "white, blue, or black ...")
 * when an `or` / `and/or` connector joins color words before the remaining phrase.
 * Never consumes `and` so conjunctions like "white and blue creature" stay distinct from OR filters.
 */
function consumeLeadingColorDisjunction(words: string[]): ManaColor[] | null {
	if (words.length < 3) return null;
	const firstClean = words[0].replace(/,$/, '').toLowerCase();
	if (!COLORS[firstClean] || firstClean === 'colorless') return null;
	const colors: ManaColor[] = [COLORS[firstClean]];
	let idx = 1;
	let sawOr = false;
	for (let guard = 0; guard < 8 && idx < words.length; guard++) {
		const tok = words[idx].toLowerCase();
		if (tok === 'or' || tok === 'and/or') {
			if (idx + 1 >= words.length) return null;
			const nextClean = words[idx + 1].replace(/,$/, '').toLowerCase();
			if (!COLORS[nextClean] || nextClean === 'colorless') return null;
			const col = COLORS[nextClean];
			if (!colors.includes(col)) colors.push(col);
			sawOr = true;
			idx += 2;
			break;
		}
		// Comma-separated color in a 3+ list ("white, blue, or black ...")
		if (words[idx - 1].endsWith(',')) {
			const clean = tok.replace(/,$/, '');
			if (COLORS[clean] && clean !== 'colorless') {
				const col = COLORS[clean];
				if (!colors.includes(col)) colors.push(col);
				idx += 1;
				continue;
			}
		}
		break;
	}
	if (!sawOr || idx >= words.length) return null;
	words.splice(0, idx);
	return colors;
}

/**
 * Parses an object phrase such as "untapped Elves you control", "another creature",
 * "artifact or creature", "nonland permanent", "basic land card", "Goblin creature".
 * Returns null unless the whole phrase is understood.
 */
export function parseObjectPhrase(
	phrase: string,
	opts?: { allowPluralAndDisjunction?: boolean; allowPlural?: boolean }
): ObjectFilter | null {
	const filter: ObjectFilter = {};
	let rest = phrase.trim();

	// Trailing qualifiers, in either order: "creature you control with power 4 or greater".
	for (let guard = 0; guard < 24; guard++) {
		// --- Track P14 ---
		const onBfSuffix = rest.match(/^(.+?)\s+on the battlefield$/i);
		if (onBfSuffix && !filter.zone) {
			filter.zone = 'battlefield';
			rest = onBfSuffix[1];
			continue;
		}
		const namedSelf = rest.match(/^(.+?)\s+named ~$/i);
		if (namedSelf && !filter.sameNameAsSource) {
			filter.sameNameAsSource = true;
			rest = namedSelf[1];
			continue;
		}
		const sharesColor = rest.match(/^(.+?)\s+that shares? a color with ~$/i);
		if (sharesColor && !filter.sharesColorWithSelf) {
			filter.sharesColorWithSelf = true;
			rest = sharesColor[1];
			continue;
		}
		const noCounters = rest.match(/^(.+?)\s+with no counters on (?:it|them)$/i);
		if (noCounters && filter.hasAnyCounter === undefined && !filter.hasCounters) {
			filter.hasAnyCounter = false;
			rest = noCounters[1];
			continue;
		}
		// --- End Track P14 ---
		const exiledWithSelf = rest.match(/^(.+?)\s+exiled with ~$/i);
		if (exiledWithSelf && !filter.exiledWithSelf) {
			filter.zone = 'exile';
			filter.exiledWithSelf = true;
			rest = exiledWithSelf[1];
			continue;
		}
		const ofChosenType = rest.match(/^(.+?)\s+of the chosen type$/i);
		if (ofChosenType && !filter.ofChosenType) {
			filter.ofChosenType = true;
			rest = ofChosenType[1];
			continue;
		}
		const ofChosenColor = rest.match(/^(.+?)\s+of the chosen color$/i);
		if (ofChosenColor && !filter.ofChosenColor) {
			filter.ofChosenColor = true;
			rest = ofChosenColor[1];
			continue;
		}
		// --- Track P11 ---
		const ofChosenName = rest.match(/^(.+?)\s+(?:of|with) the chosen name$/i);
		if (ofChosenName && !filter.ofChosenName) {
			filter.ofChosenName = true;
			rest = ofChosenName[1];
			continue;
		}
		const attachedSelf = rest.match(/^(.+?)\s+attached to ~$/i);
		if (attachedSelf && !filter.attachedToRef) {
			filter.attachedToRef = 'self';
			rest = attachedSelf[1];
			continue;
		}
		const attachedHost = rest.match(
			/^(.+?)\s+attached to (?:it|enchanted (?:creature|permanent|land|artifact|enchantment|planeswalker)|equipped creature)$/i
		);
		if (attachedHost && !filter.attachedToRef) {
			filter.attachedToRef = 'attachedTo';
			rest = attachedHost[1];
			continue;
		}
		// --- End Track P11 ---
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
		const withStat = rest.match(/^(.+?)\s+with (power|toughness|mana value) (\S+)(?: or (greater|more|less|fewer))?$/i);
		if (withStat) {
			const value = count(withStat[3]);
			if (!value || value.k === 'const' && withStat[3].toLowerCase() === 'a') return null;
			const dir = withStat[4]?.toLowerCase();
			const cmp: Compare = { op: !dir ? '=' : dir === 'greater' || dir === 'more' ? '>=' : '<=', value };
			const statKind = withStat[2].toLowerCase();
			const key =
				statKind === 'power' ? 'power' : statKind === 'toughness' ? 'toughness' : 'manaValue';
			if (filter[key]) return null;
			filter[key] = cmp;
			rest = withStat[1];
			continue;
		}
		// --- Track P8: counters, keywords, and lacksKeywords ---
		const withAnyCounters = rest.match(
			/^(.+?)\s+with (?:(?:a|an|one or more)\s+)?counters? on (?:it|them)$/i
		);
		if (withAnyCounters && !filter.hasCounters) {
			filter.hasCounters = 'any';
			rest = withAnyCounters[1];
			continue;
		}
		const withTypedCounter = rest.match(
			/^(.+?)\s+with (?:(?:a|an|one or more)\s+)?([+\-−]\d+\/[+\-−]\d+|first strike|double strike|[a-z]+) counters? on (?:it|them)$/i
		);
		if (withTypedCounter && !filter.hasCounters) {
			const rawCounter = withTypedCounter[2].toLowerCase().replace(/−/g, '-');
			if (!/^(?:a|an|one|or|more|no|any)$/.test(rawCounter)) {
				filter.hasCounters = COUNTERS[rawCounter] ?? rawCounter;
				rest = withTypedCounter[1];
				continue;
			}
		}
		// --- Track P14: "that's / that are equipped / enchanted / tapped / untapped / <subtypes>" ---
		const thatState = rest.match(
			/^(.+?)\s+that(?:'s| is| are) (equipped|enchanted|tapped|untapped)$/i
		);
		if (thatState) {
			const stKind = thatState[2].toLowerCase();
			if (stKind === 'equipped' && filter.equipped === undefined) {
				filter.equipped = true;
				rest = thatState[1];
				continue;
			}
			if (stKind === 'enchanted' && filter.enchanted === undefined) {
				filter.enchanted = true;
				rest = thatState[1];
				continue;
			}
			if ((stKind === 'tapped' || stKind === 'untapped') && filter.tapped === undefined) {
				filter.tapped = stKind === 'tapped';
				rest = thatState[1];
				continue;
			}
		}
		const thatSubtypes = rest.match(/^(.+?)\s+that(?:'s| is| are)\s+(.+)$/i);
		if (
			thatSubtypes &&
			!filter.subtypes &&
			!/\bthat(?:'s| is| are)\b/i.test(thatSubtypes[2])
		) {
			const rhs = thatSubtypes[2].trim().replace(/^(?:a|an)\s+/i, '');
			const subF = parseObjectPhrase(rhs, { allowPluralAndDisjunction: true });
			if (subF && Object.keys(subF).length === 1 && subF.subtypes?.length) {
				filter.subtypes = subF.subtypes;
				rest = thatSubtypes[1];
				continue;
			}
		}
		// --- End Track P14 ---
		const withoutKw = rest.match(/^(.+?)\s+without ([a-z ,/]+)$/i);
		if (withoutKw) {
			const kws = parseKeywordList(withoutKw[2], true);
			if (kws) {
				const existing = filter.lacksKeywords ?? [];
				filter.lacksKeywords = [...existing, ...kws.filter((k) => !existing.includes(k))];
				rest = withoutKw[1];
				continue;
			}
		}
		const withKw = rest.match(/^(.+?)\s+with ([a-z ,]+)$/i);
		if (withKw) {
			const kws = parseKeywordList(withKw[2], false);
			if (kws) {
				const existing = filter.hasKeywords ?? [];
				filter.hasKeywords = [...existing, ...kws.filter((k) => !existing.includes(k))];
				rest = withKw[1];
				continue;
			}
		}
		break;
	}
	const words = rest.split(/\s+/).filter(Boolean);

	// Leading modifiers.
	for (let guard = 0; guard < 32 && words.length > 0; guard++) {
		const rawWord = words[0].replace(/,$/, '');
		const low = rawWord.toLowerCase();
		if (low === 'another' || low === 'other') filter.other = true;
		else if (low === 'untapped') filter.tapped = false;
		else if (low === 'tapped') filter.tapped = true;
		else if (low === 'saddled') filter.saddled = true;
		else if (low === 'monstrous') filter.monstrous = true;
		else if (low === 'nontoken') filter.token = false;
		else if (low === 'historic') filter.historic = true;
		else if (low === 'nonhistoric') filter.historic = false;
		else if (low === 'commander' || low === 'commanders') filter.isCommander = true;
		else if (low === 'attacking') filter.attacking = true;
		else if (low === 'blocking') filter.blocking = true;
		else if (low === 'multicolored') filter.multicolored = true;
		else if (low === 'monocolored') filter.monocolored = true;
		// --- Track P14: Plural "equipped creatures" / "enchanted creatures" ---
		else if (
			low === 'equipped' &&
			words.length >= 2 &&
			/^(?:creatures|permanents|artifacts|lands)$/i.test(words[words.length - 1])
		) {
			filter.equipped = true;
		} else if (
			low === 'enchanted' &&
			words.length >= 2 &&
			/^(?:creatures|permanents|artifacts|lands)$/i.test(words[words.length - 1])
		) {
			filter.enchanted = true;
		}
		// --- End Track P14 ---
		else if (SUPERTYPES[low]) (filter.supertypes ??= []).push(SUPERTYPES[low]);
		else if (COLORS[low]) {
			const disjColors = consumeLeadingColorDisjunction(words);
			if (disjColors) {
				const dst = (filter.colors ??= []);
				for (const c of disjColors) {
					if (!dst.includes(c)) dst.push(c);
				}
				continue;
			}
			(filter.colors ??= []).push(COLORS[low]);
		}
		else if (NON_COLORS[low]) (filter.notColors ??= []).push(NON_COLORS[low]);
		else if (/^non[a-z]+$/.test(low) && CARD_TYPES[low.slice(3)]) {
			(filter.notTypes ??= []).push(CARD_TYPES[low.slice(3)]);
		} else if (/^non[a-z]+$/.test(low) && SUPERTYPES[low.slice(3)]) {
			(filter.notSupertypes ??= []).push(SUPERTYPES[low.slice(3)]);
		} else if (/^non-[A-Z][a-z]+$/.test(rawWord)) {
			(filter.notSubtypes ??= []).push(rawWord.slice(4));
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
			.map((a) => a.trim().replace(/^(?:a|an)\s+/i, ''))
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

	// --- Track P14: Plural union subjects in static affected clauses ("Other Spiders, Boars, ... and Squirrels", "Other Elf and Warrior creatures") ---
	if (opts?.allowPluralAndDisjunction && /\band\b/i.test(joined)) {
		const copyWords = [...words];
		let trailingType: string | undefined;
		if (copyWords.length >= 4 && /^creatures$/i.test(copyWords[copyWords.length - 1])) {
			trailingType = 'Creature';
			copyWords.pop();
		} else if (copyWords.length >= 4 && /^permanents$/i.test(copyWords[copyWords.length - 1])) {
			copyWords.pop();
		}
		const copyJoined = copyWords.join(' ').replace(/,/g, ' ,');
		if (/\band\b/i.test(copyJoined)) {
			const alts = copyJoined
				.split(/\s*(?:,\s*(?:and\b)?|\band\b)\s*/i)
				.map((a) => a.trim())
				.filter(Boolean);
			if (alts.length >= 2) {
				const nouns = alts.map((a) => (a.includes(' ') ? null : noun(a)));
				if (!nouns.some((n) => !n || n.any || n.token)) {
					const allTypes = nouns.every((n) => n!.types);
					const allSubtypes = nouns.every((n) => n!.subtypes);
					if (allTypes && !trailingType) {
						filter.types = nouns.flatMap((n) => n!.types!);
						return filter;
					}
					if (allSubtypes) {
						filter.subtypes = nouns.flatMap((n) => n!.subtypes!);
						if (trailingType) filter.types = [trailingType];
						return filter;
					}
				}
			}
		}
	}
	// --- End Track P14 ---

	// Conjunction: "Goblin creature", "Elf Warrior", "artifact creature" (all must hold).
	const matchedTypes: string[] = [];
	for (const w of words) {
		const n = noun(w);
		if (!n) return null;
		if (n.types) {
			for (const t of n.types) {
				if (!matchedTypes.includes(t)) matchedTypes.push(t);
			}
		}
		if (n.subtypes) {
			// "Elf Warrior" means both subtypes; likewise not expressible as any-of.
			if (filter.subtypes) return null;
			filter.subtypes = n.subtypes;
		}
		if (n.token) filter.token = true;
		if (n.isCommander) filter.isCommander = true;
	}
	if (matchedTypes.length === 1) {
		filter.types = matchedTypes;
	} else if (matchedTypes.length >= 2) {
		// CR 205.2b: "artifact creature", "enchantment creature", "land creature" require ALL listed card types.
		filter.allTypes = matchedTypes;
	}
	return filter;
}

// ---- Productions ----------------------------------------------------------------------------

type Production = (part: string) => CostDef[] | null;

const ONE: Amount = { k: 'const', n: 1 };

/** "{2}{U}", "{T}", "{Q}", "{2}{T}", "{S}" (some older cards combine symbols). */
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

/** "Pay {E}", "Pay {E}{E}{E}", "Pay six {E}", "Pay 6 {E}", "Pay X {E}". */
const payEnergy: Production = (part) => {
	const sym = part.match(/^pay\s+((?:\{E\}\s*)+)$/i);
	if (sym) {
		const eCount = (sym[1].match(/\{E\}/gi) ?? []).length;
		return eCount > 0 ? [{ k: 'payEnergy', count: { k: 'const', n: eCount } }] : null;
	}
	const m = part.match(/^pay\s+(\S+)\s*\{E\}$/i);
	const amount = m && count(m[1]);
	return amount ? [{ k: 'payEnergy', count: amount }] : null;
};

/** "Pay {3}{B}", "Pay {S}" (an option of a choice between costs). */
const payMana: Production = (part) => {
	const m = part.match(/^pay ((?:\{[^}]+\})+)$/i);
	if (!m) return null;
	const symbols = m[1].match(/\{[^}]+\}/g)!;
	if (symbols.some((s) => /^\{(?:T|Q|E|TK|P)\}$/i.test(s))) return null;
	return [{ k: 'mana', cost: m[1] }];
};

/** Parses a leading count token (`a`, `two`, `X`, `3`, `any number of`, or implicit `another`/`other`). */
function parseLeadingCostCount(
	raw: string,
	allowImplicitAnother = true
): { count: Amount; phrase: string } | null {
	const trimmed = raw.trim();
	const anyNum = trimmed.match(/^any number of\s+(.+)$/i);
	if (anyNum) return { count: { k: 'anyNumber' }, phrase: anyNum[1].trim() };
	const [first, ...rest] = trimmed.split(/\s+/);
	if (!first) return null;
	const n = count(first);
	if (n && rest.length > 0) return { count: n, phrase: rest.join(' ') };
	if (allowImplicitAnother && /^(?:another|other)\b/i.test(trimmed)) {
		return { count: ONE, phrase: trimmed };
	}
	return null;
}

/** "Sacrifice ~", "Sacrifice a creature", "Sacrifice two Foods", "Sacrifice another creature", "Sacrifice any number of creatures". */
const sacrifice: Production = (part) => {
	const m = part.match(/^sacrifice (.+)$/i);
	if (!m) return null;
	if (m[1] === '~') return [{ k: 'sacrifice', count: ONE, filter: 'self' }];
	const lead = parseLeadingCostCount(m[1], true);
	if (!lead) return null;
	const filter = parseObjectPhrase(lead.phrase);
	if (!filter || filter.controller) return null;
	return [{ k: 'sacrifice', count: lead.count, filter: { ...filter, controller: 'you' } }];
};

/** "Tap ten untapped Elves you control", "Tap an untapped creature you control", "Tap another untapped creature you control", "Tap enchanted creature". */
const tapOthers: Production = (part) => {
	if (/^tap (?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(part)) {
		return [{ k: 'tapAttached' }];
	}
	const anyUntapped = part.match(/^tap any number of untapped (.+) you control$/i);
	if (anyUntapped) {
		const filter = parseObjectPhrase(anyUntapped[1]);
		if (!filter || filter.controller) return null;
		return [
			{
				k: 'tapOthers',
				count: { k: 'anyNumber' },
				filter: { ...filter, controller: 'you', tapped: false }
			}
		];
	}
	const anotherUntapped = part.match(/^tap (another|other) untapped (.+) you control$/i);
	if (anotherUntapped) {
		const filter = parseObjectPhrase(`other ${anotherUntapped[2]}`);
		if (!filter || filter.controller) return null;
		return [{ k: 'tapOthers', count: ONE, filter: { ...filter, controller: 'you', tapped: false } }];
	}
	const m = part.match(/^tap (\S+) (other )?untapped (.+) you control$/i);
	if (!m) return null;
	const n = count(m[1]);
	const filter = parseObjectPhrase(`${m[2] ?? ''}${m[3]}`);
	if (!n || !filter || filter.controller) return null;
	return [{ k: 'tapOthers', count: n, filter: { ...filter, controller: 'you', tapped: false } }];
};

function parseSingleDiscardBody(bodyRaw: string): Extract<CostDef, { k: 'discard' }> | null {
	const body = bodyRaw.trim();
	const randMatch = body.match(/^(.+?)( at random)?$/i);
	if (!randMatch) return null;
	const random = randMatch[2] ? true : undefined;
	const lead = parseLeadingCostCount(randMatch[1], true);
	if (!lead) return null;
	if (/^cards?$/i.test(lead.phrase)) {
		return { k: 'discard', count: lead.count, random };
	}
	if (!/\bcards?\b/i.test(lead.phrase)) return null;
	const filter = parseObjectPhrase(lead.phrase);
	if (!filter) return null;
	return {
		k: 'discard',
		count: lead.count,
		...(Object.keys(filter).length > 0 ? { filter } : {}),
		random
	};
}

/** "Discard ~", "Discard your hand", "Discard a card", "Discard another card named ~", "Discard an Island card and another card". */
const discard: Production = (part) => {
	if (/^discard ~$/i.test(part)) return [{ k: 'discard', count: ONE, filter: 'self' }];
	if (/^discard your hand$/i.test(part)) return [{ k: 'discardHand' }];
	const m = part.match(/^discard (.+)$/i);
	if (!m) return null;
	const single = parseSingleDiscardBody(m[1]);
	if (single) return [single];
	// Compound single-verb discard ("discard an Island card and another card" — Foil).
	const splitAnd = m[1].match(/^(.+?\bcards?)\s+and\s+(.+)$/i);
	if (splitAnd) {
		const d1 = parseSingleDiscardBody(splitAnd[1]);
		const d2 = parseSingleDiscardBody(splitAnd[2]);
		if (d1 && d2) return [d1, d2];
	}
	return null;
};

/** "Exile ~", "Exile ~ from your graveyard/hand", "Exile two creature cards from your graveyard", "Exile an artifact you control". */
const exileFrom: Production = (part) => {
	if (/^exile ~$/i.test(part)) return [{ k: 'exileFrom', zone: 'battlefield', count: ONE, filter: 'self' }];
	const selfZone = part.match(/^exile ~ from your (graveyard|hand)$/i);
	if (selfZone) {
		return [
			{
				k: 'exileFrom',
				zone: selfZone[1].toLowerCase() as 'graveyard' | 'hand',
				count: ONE,
				filter: 'self'
			}
		];
	}
	const bf = part.match(/^exile (.+?) you control$/i);
	if (bf) {
		const lead = parseLeadingCostCount(bf[1], true);
		if (!lead || !lead.phrase) return null;
		const filter = parseObjectPhrase(lead.phrase);
		if (!filter || filter.controller) return null;
		return [
			{
				k: 'exileFrom',
				zone: 'battlefield',
				count: lead.count,
				filter: { ...filter, controller: 'you' }
			}
		];
	}
	const m = part.match(/^exile (.+?) from your (graveyard|hand)$/i);
	if (!m) return null;
	const lead = parseLeadingCostCount(m[1], true);
	if (!lead || !lead.phrase) return null;
	const filter = /^cards?$/i.test(lead.phrase) ? {} : parseObjectPhrase(lead.phrase);
	if (!filter) return null;
	return [
		{
			k: 'exileFrom',
			zone: m[2].toLowerCase() as 'graveyard' | 'hand',
			count: lead.count,
			filter: Object.keys(filter).length > 0 ? filter : undefined
		}
	];
};

function lookupCounterWord(raw: string): CounterType | null {
	return COUNTERS[raw.trim().toLowerCase().replace(/−/g, '-')] ?? null;
}

/** "Remove a +1/+1 counter from ~", "Remove a counter from ~", "Remove all charge counters from ~", "Remove two +1/+1 counters from among creatures you control". */
const removeCounters: Production = (part) => {
	if (/^remove all counters? from ~$/i.test(part)) {
		return [
			{ k: 'removeCounters', counter: 'any', count: { k: 'const', n: 0 }, removeAll: true, from: 'self' }
		];
	}
	const allTypedSelf = part.match(/^remove all (.+?) counters? from ~$/i);
	if (allTypedSelf) {
		const counter = lookupCounterWord(allTypedSelf[1]);
		return counter
			? [{ k: 'removeCounters', counter, count: { k: 'const', n: 0 }, removeAll: true, from: 'self' }]
			: null;
	}
	const anySelf = part.match(/^remove (\S+) counters? from ~$/i);
	if (anySelf) {
		const n = count(anySelf[1]);
		return n ? [{ k: 'removeCounters', counter: 'any', count: n, from: 'self' }] : null;
	}
	const typedSelf = part.match(/^remove (\S+) (.+?) counters? from ~$/i);
	if (typedSelf) {
		const n = count(typedSelf[1]);
		const counter = lookupCounterWord(typedSelf[2]);
		return n && counter ? [{ k: 'removeCounters', counter, count: n, from: 'self' }] : null;
	}
	const anyAmong = part.match(/^remove (\S+) counters? from among (.+?) you control$/i);
	if (anyAmong) {
		const n = count(anyAmong[1]);
		const filter = parseObjectPhrase(anyAmong[2]);
		return n && filter && !filter.controller
			? [{ k: 'removeCounters', counter: 'any', count: n, from: { ...filter, controller: 'you' }, among: true }]
			: null;
	}
	const typedAmong = part.match(/^remove (\S+) (.+?) counters? from among (.+?) you control$/i);
	if (typedAmong) {
		const n = count(typedAmong[1]);
		const counter = lookupCounterWord(typedAmong[2]);
		const filter = parseObjectPhrase(typedAmong[3]);
		return n && counter && filter && !filter.controller
			? [{ k: 'removeCounters', counter, count: n, from: { ...filter, controller: 'you' }, among: true }]
			: null;
	}
	const anyCtrl = part.match(/^remove (\S+) counters? from (?:(?:a|an)\s+|(?=(?:another|other)\b))(.+?) you control$/i);
	if (anyCtrl) {
		const n = count(anyCtrl[1]);
		const filter = parseObjectPhrase(anyCtrl[2]);
		return n && filter && !filter.controller
			? [{ k: 'removeCounters', counter: 'any', count: n, from: { ...filter, controller: 'you' } }]
			: null;
	}
	const typedCtrl = part.match(
		/^remove (\S+) (.+?) counters? from (?:(?:a|an)\s+|(?=(?:another|other)\b))(.+?) you control$/i
	);
	if (typedCtrl) {
		const n = count(typedCtrl[1]);
		const counter = lookupCounterWord(typedCtrl[2]);
		const filter = parseObjectPhrase(typedCtrl[3]);
		return n && counter && filter && !filter.controller
			? [{ k: 'removeCounters', counter, count: n, from: { ...filter, controller: 'you' } }]
			: null;
	}
	return null;
};

/** "Return ~ to its owner's hand", "Return a land you control to its owner's hand", "Return two Islands you control to their owners' hands". */
const returnToHand: Production = (part) => {
	if (/^return ~ to its owner's hand$/i.test(part)) {
		return [{ k: 'returnToHand', count: ONE, filter: 'self' }];
	}
	const m = part.match(/^return (.+?) you control to (?:its|their) (?:owner's|owners') hands?$/i);
	if (!m) return null;
	const [first, ...rest] = m[1].trim().split(/\s+/);
	const n = count(first);
	const phrase = n ? rest.join(' ') : m[1].trim();
	if (!n && !/^(?:another|other)\b/i.test(phrase)) return null;
	if (!phrase) return null;
	const filter = parseObjectPhrase(phrase);
	if (!filter || filter.controller) return null;
	return [{ k: 'returnToHand', count: n ?? ONE, filter: { ...filter, controller: 'you' } }];
};

/** "Mill a card", "Mill three cards", "Mill X cards". */
const millCost: Production = (part) => {
	const m = part.match(/^mill (\S+) cards?$/i);
	if (!m) return null;
	const n = count(m[1]);
	return n ? [{ k: 'mill', count: n }] : null;
};

/** "Reveal a white card in/from your hand", "Reveal two red cards in/from your hand", "Reveal another Dragon card from your hand". */
const revealFromHand: Production = (part) => {
	const m = part.match(/^reveal (.+?) (?:in|from) your hand$/i);
	if (!m) return null;
	const lead = parseLeadingCostCount(m[1], true);
	if (!lead) return null;
	const filter = /^cards?$/i.test(lead.phrase) ? {} : parseObjectPhrase(lead.phrase);
	if (!filter) return null;
	return [
		{
			k: 'revealFromHand',
			count: lead.count,
			...(Object.keys(filter).length > 0 ? { filter } : {})
		}
	];
};

/** "Exert ~" (CR 701.43a). */
const exertSelf: Production = (part) => (/^exert ~$/i.test(part) ? [{ k: 'exertSelf' }] : null);

// --- Track P14: Waterbend, Behold, Put Counters, & Put From Hand on Top of Library ---

/** CR 701.67a–b: "Waterbend {4}", "Waterbend {X}", "Waterbend {2}{U}". */
const waterbendCost: Production = (part) => {
	const m = part.match(/^waterbend\s+((?:\{[^}]+\})+)$/i);
	if (!m) return null;
	const symbols = m[1].match(/\{[^}]+\}/g);
	if (!symbols || symbols.some((s) => /^\{(?:T|Q|E|TK|P)\}$/i.test(s))) return null;
	return [{ k: 'waterbend', cost: m[1] }];
};

/** CR 701.4a–b: "Behold a Dragon", "Behold an Elemental", "Behold a Dragon creature". */
const beholdCost: Production = (part) => {
	const m = part.match(/^behold\s+(?:a|an|one)\s+(.+)$/i);
	if (!m) return null;
	const filter = parseObjectPhrase(m[1]);
	if (!filter || filter.controller) return null;
	return [{ k: 'behold', count: ONE, filter }];
};

/** "Put a -1/-1 counter on ~", "Put two +1/+1 counters on ~", "Put a -1/-1 counter on a creature you control". */
const putCountersCost: Production = (part) => {
	const selfMatch = part.match(/^put (\S+) (.+?) counters? on ~$/i);
	if (selfMatch) {
		const cnt = count(selfMatch[1]);
		const counter = lookupCounterWord(selfMatch[2]);
		return cnt && counter ? [{ k: 'putCounters', count: cnt, counter, on: 'self' }] : null;
	}
	const ctrlMatch = part.match(
		/^put (\S+) (.+?) counters? on (?:(?:a|an)\s+|(?=(?:another|other)\b))(.+?) you control$/i
	);
	if (ctrlMatch) {
		const cnt = count(ctrlMatch[1]);
		const counter = lookupCounterWord(ctrlMatch[2]);
		const filter = parseObjectPhrase(ctrlMatch[3]);
		return cnt && counter && filter && !filter.controller
			? [{ k: 'putCounters', count: cnt, counter, on: { ...filter, controller: 'you' } }]
			: null;
	}
	return null;
};

/** "Put a card from your hand on top of your library", "Put two cards from your hand on top of your library". */
const putOnTopOfLibraryCost: Production = (part) => {
	const m = part.match(/^put (.+?) from your hand on top of your library$/i);
	if (!m) return null;
	const lead = parseLeadingCostCount(m[1], true);
	if (!lead) return null;
	if (/^cards?$/i.test(lead.phrase)) {
		return [{ k: 'putFromHandOnTopOfLibrary', count: lead.count }];
	}
	if (!/\bcards?\b/i.test(lead.phrase)) return null;
	const filter = parseObjectPhrase(lead.phrase);
	if (!filter) return null;
	return [
		{
			k: 'putFromHandOnTopOfLibrary',
			count: lead.count,
			...(Object.keys(filter).length > 0 ? { filter } : {})
		}
	];
};

// --- End Track P14 ---

const PRODUCTIONS: Production[] = [
	manaSymbols,
	payLife,
	payEnergy,
	payMana,
	waterbendCost,
	beholdCost,
	putCountersCost,
	putOnTopOfLibraryCost,
	sacrifice,
	tapOthers,
	discard,
	exileFrom,
	removeCounters,
	returnToHand,
	millCost,
	revealFromHand,
	exertSelf
];

const OR_BEFORE_VERB = new RegExp(`\\s+or\\s+(?=\\{|(?:${COST_VERBS})\\b)`, 'i');

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
 *
 * Also returns `{ defs: [], unparsed: [] }` when `offset === 0` (`parseSpellFace` effect-sentence filter)
 * and `sentence` is a compiled spell-face static (`costModifier`, `altCastPermission`, or `deckCopyLimit`),
 * so `parseSpellFace` skips non-effect static sentences already collected by `spellAbilityCore`.
 */
export function parseAdditionalCostSentence(sentence: string, offset = 0, _fromSpellCheck = true): CostParse | null {
	const m = sentence.match(/^as an additional cost to cast (?:~|this spell), (.+?)\.?$/i);
	if (!m) {
		// --- Track P14: Skip compiled spell-face static sentences inside parseSpellFace (offset === 0) ---
		if (offset === 0 && _fromSpellCheck && !/^draw\b/i.test(sentence.trim())) {
			const spellStatic = parseCostModifierSentence(sentence);
			if (spellStatic) {
				return { defs: [], unparsed: [] };
			}
		}
		// --- End Track P14 ---
		return null;
	}
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

const COLOR_SYMBOLS = new Set<ManaColor>(['W', 'U', 'B', 'R', 'G', 'C']);
const HYBRID_COLOR_SET = new Set<ManaColor>(['W', 'U', 'B', 'R', 'G']);

export function parseCostManaDelta(costStr: string, mode: 'reduce' | 'increase'): CostDelta | null {
	const clean = costStr.replace(/\s+/g, '');
	const symbols = clean.match(/\{[^}]+\}/g);
	if (!symbols || symbols.join('') !== clean) return null;
	let generic = 0;
	const colored: Partial<Record<ManaColor, number>> = {};
	let hasColored = false;
	const hybridColored: Array<[ManaColor, ManaColor]> = [];

	for (const rawSym of symbols) {
		const inner = rawSym.slice(1, -1).toUpperCase();
		if (/^\d+$/.test(inner)) {
			generic += parseInt(inner, 10);
			continue;
		}
		if (COLOR_SYMBOLS.has(inner as ManaColor)) {
			const c = inner as ManaColor;
			colored[c] = (colored[c] ?? 0) + 1;
			hasColored = true;
			continue;
		}
		const hyb = inner.match(/^([WUBRG])\/([WUBRG])$/);
		if (hyb && mode === 'reduce' && HYBRID_COLOR_SET.has(hyb[1] as ManaColor) && HYBRID_COLOR_SET.has(hyb[2] as ManaColor)) {
			hybridColored.push([hyb[1] as ManaColor, hyb[2] as ManaColor]);
			continue;
		}
		return null;
	}

	return {
		mode,
		generic,
		...(hasColored ? { colored } : {}),
		...(hybridColored.length > 0 ? { hybridColored } : {})
	};
}

// --- Track P14: Devotion color list parser ("white", "white and blue", "white, blue, and black") ---
export function parseDevotionColorList(raw: string): ManaColor[] | null {
	const parts = raw
		.trim()
		.toLowerCase()
		.split(/\s*(?:,\s*(?:and\s+)?|\band\b)\s*/)
		.filter(Boolean);
	if (parts.length === 0) return null;
	const out: ManaColor[] = [];
	for (const p of parts) {
		const col = COLORS[p];
		if (!col || col === 'C') return null;
		if (!out.includes(col)) out.push(col);
	}
	return out;
}

function isSpellAltCostCompatible(def: CostDef): boolean {
	switch (def.k) {
		case 'mana':
		case 'payLife':
		case 'payEnergy':
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
			return def.filter !== 'self';
		case 'exileFrom':
			return (
				def.filter !== 'self' &&
				(def.zone === 'graveyard' || def.zone === 'hand' || def.zone === 'battlefield')
			);
		case 'removeCounters':
			return def.from !== 'self';
		case 'putCounters':
			return def.on !== 'self';
		case 'choice':
			return def.options.length > 0 && def.options.every((opt) => opt.length > 0 && opt.every(isSpellAltCostCompatible));
		default:
			return false;
	}
}

function buildSelfAltCastStatic(costBodyRaw: string, condition?: Condition): StaticDef | null {
	const parsed = parseCost(costBodyRaw.trim());
	if (parsed.unparsed.length > 0 || parsed.defs.length === 0) return null;
	if (!parsed.defs.every(isSpellAltCostCompatible)) return null;
	const manaParts = parsed.defs.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana');
	const nonManaDefs = parsed.defs.filter((d) => d.k !== 'mana');
	const manaCost = manaParts.length > 0 ? manaParts.map((m) => m.cost).join('') : '{0}';
	return {
		k: 'altCastPermission',
		affects: 'self',
		manaCost,
		...(nonManaDefs.length > 0 ? { costDefs: nonManaDefs } : {}),
		...(condition ? { condition } : {})
	};
}
// --- End Track P14 ---

export function parseCostMetricAmount(metricRaw: string): Amount | null {
	const metric = metricRaw.trim().replace(/^(?:a|an)\s+/i, '');
	// --- Track P14 ---
	if (/^targets? beyond the first$/i.test(metric)) {
		return { k: 'targetsBeyondFirst' };
	}
	if (/^opponents? you have$/i.test(metric)) {
		return { k: 'opponentCount' };
	}
	// --- End Track P14 ---
	if (/^time you've cast (?:your|a) commander from the command zone this game$/i.test(metric)) {
		return { k: 'commanderCastCount' };
	}
	if (/^creatures? in your party$/i.test(metric)) {
		return { k: 'partyCount', player: { k: 'you' } };
	}
	if (/^basic land types? among lands you control$/i.test(metric)) {
		return { k: 'domain', player: { k: 'you' } };
	}
	if (/^cards? in your graveyard$/i.test(metric)) {
		return { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } };
	}
	if (/^cards? in your hand$/i.test(metric)) {
		return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	}
	if (/^cards? in all graveyards$/i.test(metric)) {
		return { k: 'count', of: { zone: 'graveyard' } };
	}
	if (/^card types? among cards in your graveyard$/i.test(metric)) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' };
	}
	if (/^counters? on ~$/i.test(metric)) {
		return { k: 'countersOn', counter: 'any', of: { k: 'self' } };
	}
	const counterOnSelf = metric.match(/^(.+?) counters? on ~$/i);
	if (counterOnSelf) {
		const c = lookupCounterWord(counterOnSelf[1]);
		if (c) return { k: 'countersOn', counter: c, of: { k: 'self' } };
	}
	const gyCard = metric.match(/^(.+?) cards? in your graveyard$/i);
	if (gyCard) {
		const f = parseObjectPhrase(`${gyCard[1].replace(/\s+and\s+/gi, ' or ')} card`);
		if (f && !f.controller) return { k: 'count', of: { ...f, zone: 'graveyard', owner: 'you' } };
	}
	const allGyCard = metric.match(/^(.+?) cards? in all graveyards$/i);
	if (allGyCard) {
		const f = parseObjectPhrase(`${allGyCard[1].replace(/\s+and\s+/gi, ' or ')} card`);
		if (f && !f.controller) return { k: 'count', of: { ...f, zone: 'graveyard' } };
	}
	const attachedSelf = metric.match(/^(.+?) attached to ~$/i);
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
	const youCtrl = metric.match(/^(.+?) you control$/i);
	if (youCtrl) {
		const f = parseObjectPhrase(youCtrl[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) return { k: 'count', of: { ...f, controller: 'you', zone: 'battlefield' } };
	}
	const oppCtrl = metric.match(/^(.+?) (?:your opponents control|an opponent controls)$/i);
	if (oppCtrl) {
		const f = parseObjectPhrase(oppCtrl[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) return { k: 'count', of: { ...f, controller: 'opponent', zone: 'battlefield' } };
	}
	const onBf = metric.match(/^(.+?) on the battlefield$/i);
	if (onBf) {
		const f = parseObjectPhrase(onBf[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) return { k: 'count', of: { ...f, zone: 'battlefield' } };
	}
	// --- Track P14: "<noun> you control with ..." where `you control` precedes trailing qualifiers ---
	const directCtrl = parseObjectPhrase(metric.replace(/\s+and\s+/gi, ' or '));
	if (directCtrl && directCtrl.controller) {
		return { k: 'count', of: { ...directCtrl, zone: 'battlefield' } };
	}
	// --- End Track P14 ---
	return null;
}

export function parseSelfCostCondition(condRaw: string): Condition | null {
	const c = condRaw.trim();
	// --- Track P14: Compound AND/OR conditions, devotion, opponent life/comparison, spells cast ---
	if (/\s+and\s+/i.test(c)) {
		const subParts = c.split(/\s+and\s+/i).map((p) => p.trim());
		if (subParts.length >= 2 && subParts.every((p) => /^(?:you|an opponent|it|there|a |your )\b/i.test(p))) {
			const parsedSubs = subParts.map((p) => parseSelfCostCondition(p));
			if (parsedSubs.every((x): x is Condition => x !== null)) {
				return { k: 'and', of: parsedSubs };
			}
		}
	}
	const devAtLeast = c.match(/^your devotion to (.+?) is (\S+) or more$/i);
	if (devAtLeast) {
		const colors = parseDevotionColorList(devAtLeast[1]);
		const min = count(devAtLeast[2]);
		if (colors && min) {
			return {
				k: 'compare',
				left: { k: 'devotion', colors, player: { k: 'you' } },
				op: '>=',
				right: min
			};
		}
	}
	const devLess = c.match(/^your devotion to (.+?) is less than (\S+)$/i);
	if (devLess) {
		const colors = parseDevotionColorList(devLess[1]);
		const max = count(devLess[2]);
		if (colors && max) {
			return {
				k: 'compare',
				left: { k: 'devotion', colors, player: { k: 'you' } },
				op: '<',
				right: max
			};
		}
	}
	if (/^an opponent lost life this turn$/i.test(c)) return { k: 'opponentLostLifeThisTurn' };
	if (/^a permanent card was put into your graveyard from anywhere this turn$/i.test(c)) {
		return { k: 'descendedThisTurn' };
	}
	if (/^an opponent controls more lands than you$/i.test(c)) {
		return { k: 'opponentComparison', metric: 'lands' };
	}
	if (/^an opponent controls more creatures than you$/i.test(c)) {
		return { k: 'opponentComparison', metric: 'creatures' };
	}
	if (/^an opponent has more life than you$/i.test(c)) {
		return { k: 'opponentComparison', metric: 'life' };
	}
	if (/^an opponent has more cards in hand than you$/i.test(c)) {
		return { k: 'opponentComparison', metric: 'hand' };
	}
	if (/^you(?:'ve)? cast another spell this turn$/i.test(c)) {
		return { k: 'spellsCastThisTurnCount', min: 1 };
	}
	const oppCastCnt = c.match(/^an opponent cast (\S+) or more spells this turn$/i);
	const youCastCnt = c.match(/^you(?:'ve)? cast (\S+) or more (?:(.+?) )?spells this turn$/i);
	if (youCastCnt && !oppCastCnt) {
		const min = count(youCastCnt[1]);
		const sf = youCastCnt[2] ? parseSpellFilterPhrase(youCastCnt[2]) : { filter: {}, other: false };
		if (min && min.k === 'const' && sf && !sf.other) {
			return {
				k: 'spellsCastThisTurnCount',
				min: min.n,
				...(Object.keys(sf.filter).length > 0 ? { filter: sf.filter } : {})
			};
		}
	}
	const totalPwr = c.match(/^creatures you control have total power (\S+) or greater$/i);
	if (totalPwr) {
		const min = count(totalPwr[1]);
		if (min && min.k === 'const') return { k: 'totalPowerControlled', min: min.n };
	}
	const drawnN = c.match(/^you(?:'ve)? drawn (\S+) or more cards this turn$/i);
	if (drawnN) {
		const min = count(drawnN[1]);
		if (min && min.k === 'const') return { k: 'cardsDrawnThisTurnAtLeast', min: min.n };
	}
	if (/^an opponent has no cards in (?:their )?hand$/i.test(c)) {
		return { k: 'anyOpponentMetric', metric: 'hand', op: '=', count: 0 };
	}
	const oppHandMax = c.match(/^an opponent has (\S+) or (?:fewer|less) cards? in (?:their )?hand$/i);
	if (oppHandMax) {
		const mx = count(oppHandMax[1]);
		if (mx && mx.k === 'const') {
			return { k: 'anyOpponentMetric', metric: 'hand', op: '<=', count: mx.n };
		}
	}
	const oppLifeMax = c.match(/^an opponent has (\S+) or (?:less|fewer) life$/i);
	if (oppLifeMax) {
		const mx = count(oppLifeMax[1]);
		if (mx && mx.k === 'const') {
			return { k: 'anyOpponentMetric', metric: 'life', op: '<=', count: mx.n };
		}
	}
	const oppGyMin = c.match(/^an opponent has (\S+) or more cards in (?:their|a) graveyard$/i);
	if (oppGyMin) {
		const mn = count(oppGyMin[1]);
		if (mn && mn.k === 'const') {
			return { k: 'anyOpponentMetric', metric: 'graveyard', op: '>=', count: mn.n };
		}
	}
	if (/^you have no cards in (?:your )?hand$/i.test(c)) {
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
			op: '=',
			right: { k: 'const', n: 0 }
		};
	}
	const youHandCmp = c.match(/^you have (\S+) or (fewer|less|more) cards? in (?:your )?hand$/i);
	if (youHandCmp) {
		const cnt = count(youHandCmp[1]);
		if (cnt) {
			return {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
				op: youHandCmp[2].toLowerCase() === 'more' ? '>=' : '<=',
				right: cnt
			};
		}
	}
	const youLifeMin = c.match(/^you have (\S+) or more life$/i);
	if (youLifeMin) {
		const mn = count(youLifeMin[1]);
		if (mn) {
			return { k: 'compare', left: { k: 'life', of: { k: 'you' } }, op: '>=', right: mn };
		}
	}
	const youLifeMax = c.match(/^you have (\S+) or less life$/i);
	if (youLifeMax) {
		const mx = count(youLifeMax[1]);
		if (mx) {
			return { k: 'compare', left: { k: 'life', of: { k: 'you' } }, op: '<=', right: mx };
		}
	}
	const singleGy = c.match(/^there is (?:a|an) (.+?) card in your graveyard$/i);
	if (singleGy) {
		const f = parseObjectPhrase(`${singleGy[1].replace(/\s+and\s+/gi, ' or ')} card`);
		if (f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard', owner: 'you' } },
				op: '>=',
				right: { k: 'const', n: 1 }
			};
		}
	}
	const allGyTotal = c.match(/^there are (\S+) or more (?:(.+?) )?cards(?: total)? in all graveyards$/i);
	if (allGyTotal) {
		const mn = count(allGyTotal[1]);
		const f = allGyTotal[2]
			? parseObjectPhrase(`${allGyTotal[2].replace(/\s+and\s+/gi, ' or ')} card`)
			: {};
		if (mn && f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard' } },
				op: '>=',
				right: mn
			};
		}
	}
	// --- End Track P14 ---
	if (/^you control (?:a|your) commander$/i.test(c)) return { k: 'controlCommander' };
	if (/^a creature died this turn$/i.test(c)) return { k: 'creatureDiedThisTurn' };
	if (/^you attacked(?: with a creature)? this turn$/i.test(c)) return { k: 'attackedThisTurn' };
	if (/^a permanent you controlled left the battlefield this turn$/i.test(c)) {
		return { k: 'permanentLeftBattlefieldThisTurn' };
	}
	if (/^you gained life this turn$/i.test(c)) return { k: 'gainedLifeThisTurn' };
	const gainedN = c.match(/^you gained (\S+) or more life this turn$/i);
	if (gainedN) {
		const min = count(gainedN[1]);
		if (min) return { k: 'gainedLifeThisTurn', min };
	}
	if (/^you have a full party$/i.test(c)) {
		return { k: 'compare', left: { k: 'partyCount', player: { k: 'you' } }, op: '>=', right: { k: 'const', n: 4 } };
	}
	if (/^it's your turn$/i.test(c)) return { k: 'isTurnOf', player: { k: 'you' } };
	if (/^it's not your turn$/i.test(c)) return { k: 'not', of: { k: 'isTurnOf', player: { k: 'you' } } };
	if (/^you're the monarch$/i.test(c)) return { k: 'isMonarch', relation: 'you' };

	const targetsPhrase = c.match(/^it targets (?:a|an) (.+)$/i);
	if (targetsPhrase) {
		let rawTarget = targetsPhrase[1].trim();
		let ctrl: 'you' | 'opponent' | undefined;
		const oppCtrl = rawTarget.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
		if (oppCtrl) {
			ctrl = 'opponent';
			rawTarget = oppCtrl[1];
		}
		const tf = parseObjectPhrase(rawTarget);
		if (tf) {
			return {
				k: 'matchesFilter',
				filter: { targetsFilter: { ...tf, ...(ctrl ? { controller: ctrl } : {}) } }
			};
		}
	}

	const youCtrl = c.match(/^you control (\S+)(?: or more)? (.+)$/i);
	if (youCtrl) {
		const min = count(youCtrl[1]);
		const f = parseObjectPhrase(youCtrl[2].replace(/\s+and\s+/gi, ' or '));
		if (min && f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, controller: 'you', zone: 'battlefield' } },
				op: '>=',
				right: min
			};
		}
	}
	const oppCtrl = c.match(/^an opponent controls (\S+)(?: or more)? (.+)$/i);
	if (oppCtrl) {
		const min = count(oppCtrl[1]);
		const f = parseObjectPhrase(oppCtrl[2].replace(/\s+and\s+/gi, ' or '));
		if (min && f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, controller: 'opponent', zone: 'battlefield' } },
				op: '>=',
				right: min
			};
		}
	}
	const gyCards = c.match(/^there are (\S+) or more cards in your graveyard$/i);
	if (gyCards) {
		const min = count(gyCards[1]);
		if (min) {
			return {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } },
				op: '>=',
				right: min
			};
		}
	}
	const gyTyped = c.match(/^there are (\S+) or more (.+?) cards in your graveyard$/i);
	if (gyTyped) {
		const min = count(gyTyped[1]);
		const f = parseObjectPhrase(`${gyTyped[2].replace(/\s+and\s+/gi, ' or ')} card`);
		if (min && f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard', owner: 'you' } },
				op: '>=',
				right: min
			};
		}
	}
	const delirium = c.match(/^there are (\S+) or more card types among cards in your graveyard$/i);
	if (delirium) {
		const min = count(delirium[1]);
		if (min) {
			return {
				k: 'compare',
				left: { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' },
				op: '>=',
				right: min
			};
		}
	}
	return null;
}

function parseSpellFilterPhrase(rawPhrase: string): { filter: ObjectFilter; other: boolean } | null {
	let phrase = rawPhrase.trim();
	let other = false;
	if (!phrase) return { filter: {}, other: false };
	const otherMatch = phrase.match(/^other (.+)$/i);
	if (otherMatch) {
		other = true;
		phrase = otherMatch[1].trim();
	}
	// "Elemental spells and Warrior spells" -> "Elemental or Warrior"
	phrase = phrase.replace(/\bspells\s+and\s+/gi, 'or ');
	// "Instant and sorcery spells" -> "Instant or sorcery"
	phrase = phrase.replace(/\s+and\s+/gi, ' or ');
	const baseFilter: ObjectFilter | null =
		parseObjectPhrase(phrase) ?? parseObjectPhrase(`${phrase} card`);
	if (!baseFilter || baseFilter.controller || baseFilter.other) return null;
	return { filter: baseFilter, other };
}

/**
 * Parses a static cost-modifying sentence into a `costModifier` StaticDef:
 * - "<object phrase> spells you cast cost {N}/{W} less/more to cast [for each ...]."
 * - "This spell/~ costs {N} less to cast [for each ... | if <condition>]."
 * - "Spells your opponents cast that target ~ / a <filter> you control cost {N} more to cast."
 * - "Activated abilities of <filter> cost {N} less/more to activate."
 * Returns null unless the whole sentence is understood. Input is normalised (`~`, no reminder text).
 */
export function parseCostModifierSentence(sentence: string): StaticDef | null {
	let text = sentence.trim().replace(/\.$/, '');
	let coloredOnly = false;
	let minTotalMana: number | undefined;
	// --- Track P14: Turn-timing prefix ("During your turn, ..." / "During turns other than yours, ...") ---
	let turnPrefixCondition: Condition | undefined;
	const otherTurnsPrefix = text.match(/^during turns other than yours,\s*(.+)$/i);
	if (otherTurnsPrefix) {
		turnPrefixCondition = { k: 'not', of: { k: 'isTurnOf', player: { k: 'you' } } };
		text = otherTurnsPrefix[1].trim();
	}
	// --- End Track P14 ---

	for (let guard = 0; guard < 4; guard++) {
		const coloredClause = text.match(/^(.+?)\.\s*this effect reduces only the amount of colored mana you pay$/i);
		if (coloredClause) {
			coloredOnly = true;
			text = coloredClause[1].trim();
			continue;
		}
		const floorClause = text.match(
			/^(.+?)\.\s*(?:this effect can't reduce the (?:amount of )?mana (?:in that cost|that ability costs to activate) to less than one mana|this cost can't be reduced to less than \{1\})$/i
		);
		if (floorClause) {
			minTotalMana = 1;
			text = floorClause[1].trim();
			continue;
		}
		break;
	}

	const withFloorAndColored = (delta: CostDelta): CostDelta | null => {
		if ((coloredOnly || minTotalMana !== undefined) && delta.mode !== 'reduce') return null;
		return {
			...delta,
			...(coloredOnly ? { coloredOnly: true } : {}),
			...(minTotalMana !== undefined ? { minTotalMana } : {})
		};
	};

	if (/^if you control (?:a|your) commander, you may cast (?:this spell|~) without paying its mana cost$/i.test(text)) {
		if (coloredOnly || minTotalMana !== undefined) return null;
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: { mode: 'setZero', generic: 0 },
			who: { relation: 'you' },
			condition: { k: 'controlCommander' }
		};
	}

	// --- Track P14: Deck copy limits, pitch/bounce/conditional self alt-cast permissions, `{X} less` stat reductions, and non-hand spell modifiers ---
	if (!coloredOnly && minTotalMana === undefined) {
		if (/^a deck can have any number of cards named ~$/i.test(text)) {
			return { k: 'deckCopyLimit', limit: 'any' };
		}
		const upToCopies = text.match(/^a deck can have up to (\S+) cards named ~$/i);
		if (upToCopies) {
			const lim = count(upToCopies[1]);
			if (lim && lim.k === 'const' && lim.n >= 1) {
				return { k: 'deckCopyLimit', limit: lim.n };
			}
		}

		// "You may <cost> rather than pay this spell's/~'s mana cost." (Force of Will, Foil, Daze, Gush, Borderposts, Flares, Allosaurus Rider, ...)
		const selfPitchAlt = text.match(
			/^you may (.+?) rather than pay (?:this spell's|~'s) mana cost$/i
		);
		if (selfPitchAlt) {
			const alt = buildSelfAltCastStatic(selfPitchAlt[1]);
			if (alt) return alt;
		}

		// "If <condition>, you may <cost> rather than pay this spell's/~'s mana cost." (Force of Negation/Vigor/Despair, Snuff Out, Traps, ...)
		const condPitchAlt = text.match(
			/^if (.+?),\s*you may (.+?) rather than pay (?:this spell's|~'s) mana cost$/i
		);
		if (condPitchAlt) {
			const cond = parseSelfCostCondition(condPitchAlt[1]);
			if (cond) {
				const alt = buildSelfAltCastStatic(condPitchAlt[2], cond);
				if (alt) return alt;
			}
		}

		// "If <condition>, you may cast this spell/~ without paying its mana cost." (Submerge, Mogg Salvage, Massacre, Once Upon a Time partial, ...)
		const condFreeAlt = text.match(
			/^if (.+?),\s*you may cast (?:this spell|~) without paying its mana cost$/i
		);
		if (condFreeAlt) {
			const cond = parseSelfCostCondition(condFreeAlt[1]);
			if (cond) {
				return {
					k: 'altCastPermission',
					affects: 'self',
					manaCost: '{0}',
					condition: cond
				};
			}
		}
	}

	// "{X} less to cast, where X is ..." (The Great Henge, Ghalta, Pride of Hull Clade, devotion, ...)
	const selfWhereX = text.match(
		/^(?:during your turn,\s*)?(?:this spell|~) costs \{X\} less to cast,\s*where X is (.+)$/i
	);
	if (selfWhereX) {
		const isDuringYourTurn = /^during your turn,/i.test(text);
		const xClause = selfWhereX[1].trim();
		let xAmt: Amount | null = null;
		const greatestMatch = xClause.match(
			/^the greatest (power|toughness|mana value) among (.+?) you control$/i
		);
		if (greatestMatch) {
			const statKind = greatestMatch[1].toLowerCase();
			const stat = statKind === 'power' ? 'power' : statKind === 'toughness' ? 'toughness' : 'manaValue';
			const f = parseObjectPhrase(greatestMatch[2].replace(/\s+and\s+/gi, ' or '));
			if (f && !f.controller) {
				xAmt = { k: 'greatestStatAmong', stat, filter: { ...f, controller: 'you', zone: 'battlefield' } };
			}
		}
		if (!xAmt) {
			const totalMatch = xClause.match(
				/^the total (power|toughness|mana value) of (.+?) you control$/i
			);
			if (totalMatch) {
				const statKind = totalMatch[1].toLowerCase();
				const stat = statKind === 'power' ? 'power' : statKind === 'toughness' ? 'toughness' : 'manaValue';
				const f = parseObjectPhrase(totalMatch[2].replace(/\s+and\s+/gi, ' or '));
				if (f && !f.controller) {
					xAmt = { k: 'totalStatOf', stat, filter: { ...f, controller: 'you', zone: 'battlefield' } };
				}
			}
		}
		if (!xAmt) {
			const devMatch = xClause.match(/^your devotion to (.+)$/i);
			if (devMatch) {
				const cols = parseDevotionColorList(devMatch[1]);
				if (cols) xAmt = { k: 'devotion', colors: cols, player: { k: 'you' } };
			}
		}
		if (!xAmt && /^your life total$/i.test(xClause)) {
			xAmt = { k: 'life', of: { k: 'you' } };
		}
		if (!xAmt) {
			const numOf = xClause.match(/^the number of (.+)$/i);
			if (numOf) xAmt = parseCostMetricAmount(numOf[1]);
		}
		const delta = withFloorAndColored({ mode: 'reduce', generic: 1 });
		if (xAmt && delta) {
			return {
				k: 'costModifier',
				affects: { k: 'self' },
				delta: { ...delta, per: xAmt },
				who: { relation: 'you' },
				...(isDuringYourTurn ? { condition: { k: 'isTurnOf', player: { k: 'you' } } } : {})
			};
		}
	}

	// "[<phrase> ]spells you/your opponents cast from anywhere other than your/their hand(s) cost {N} less/more to cast"
	const outsideHandMod = text.match(
		/^(?:(.+?) )?spells (you|your opponents) cast from anywhere other than (?:your|their|a player's) hands? cost ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (outsideHandMod) {
		const sp = outsideHandMod[1] ? parseSpellFilterPhrase(outsideHandMod[1]) : { filter: {}, other: false };
		const rawDelta = parseCostManaDelta(
			outsideHandMod[3],
			outsideHandMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (sp && delta) {
			const who = outsideHandMod[2].toLowerCase() === 'you' ? 'you' : 'each_opponent';
			return {
				k: 'costModifier',
				affects: {
					k: 'spell',
					filter: {
						...sp.filter,
						...(sp.other ? { other: true } : {}),
						castFromOutsideHand: true
					}
				},
				delta,
				who: { relation: who },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// "[<phrase> ]spells you/your opponents cast from your graveyard / exile cost {N} less/more to cast"
	const fromZoneMod = text.match(
		/^(?:(.+?) )?spells (you|your opponents) cast from (your graveyard|their graveyards|a graveyard|exile) cost ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (fromZoneMod) {
		const sp = fromZoneMod[1] ? parseSpellFilterPhrase(fromZoneMod[1]) : { filter: {}, other: false };
		const rawDelta = parseCostManaDelta(
			fromZoneMod[4],
			fromZoneMod[5].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (sp && delta) {
			const who = fromZoneMod[2].toLowerCase() === 'you' ? 'you' : 'each_opponent';
			const castFromZone: ZoneType = /exile/i.test(fromZoneMod[3]) ? 'exile' : 'graveyard';
			return {
				k: 'costModifier',
				affects: {
					k: 'spell',
					filter: {
						...sp.filter,
						...(sp.other ? { other: true } : {}),
						castFromZone
					}
				},
				delta,
				who: { relation: who },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// "If <condition>, this spell/~ costs {N} less/more to cast" (Avatar of Will/Woe/Fury/Might/Hope, etc.)
	const prefixIfSelf = text.match(
		/^if (.+?),\s*(?:this spell|~) costs ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (prefixIfSelf) {
		const cond = parseSelfCostCondition(prefixIfSelf[1]);
		const rawDelta = parseCostManaDelta(
			prefixIfSelf[2],
			prefixIfSelf[3].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (cond && delta) {
			const fullCond: Condition = turnPrefixCondition
				? { k: 'and', of: [turnPrefixCondition, cond] }
				: cond;
			return {
				k: 'costModifier',
				affects: { k: 'self' },
				delta,
				who: { relation: 'you' },
				condition: fullCond
			};
		}
	}

	// "The first/second [<phrase>] spell you cast each turn costs {N} less/more to cast"
	const nthSpellMod = text.match(
		/^(?:during your turn,\s*)?the (first|second) (?:(.+?) )?spell you cast each turn costs ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (nthSpellMod) {
		const duringTurn = /^during your turn,/i.test(text);
		const ordinal: 1 | 2 = nthSpellMod[1].toLowerCase() === 'first' ? 1 : 2;
		const sp = nthSpellMod[2] ? parseSpellFilterPhrase(nthSpellMod[2]) : { filter: {}, other: false };
		const rawDelta = parseCostManaDelta(
			nthSpellMod[3],
			nthSpellMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (sp && !sp.other && delta) {
			const hasFilter = Object.keys(sp.filter).length > 0;
			const nthCond: Condition = {
				k: 'nthMatchingSpellThisTurn',
				ordinal,
				...(hasFilter ? { filter: sp.filter } : {})
			};
			const extraConds: Condition[] = [];
			if (turnPrefixCondition) extraConds.push(turnPrefixCondition);
			if (duringTurn) extraConds.push({ k: 'isTurnOf', player: { k: 'you' } });
			extraConds.push(nthCond);
			return {
				k: 'costModifier',
				affects: { k: 'spell', filter: sp.filter },
				delta,
				who: { relation: 'you' },
				condition: extraConds.length === 1 ? extraConds[0] : { k: 'and', of: extraConds }
			};
		}
	}
	// --- End Track P14 ---

	// Self cost modifier with "for each <metric>" or "if <condition>" or unconditional ("during your turn, ~ costs ...").
	const selfTurnPrefix = text.match(/^during your turn,\s*((?:this spell|~) costs .+)$/i);
	const selfBody = selfTurnPrefix ? selfTurnPrefix[1] : text;
	const selfForEach = selfBody.match(
		/^(?:this spell|~) costs ((?:\{[^}]+\})+) (less|more) to cast for each (.+)$/i
	);
	if (selfForEach) {
		const rawDelta = parseCostManaDelta(selfForEach[1], selfForEach[2].toLowerCase() === 'less' ? 'reduce' : 'increase');
		const per = parseCostMetricAmount(selfForEach[3]);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta || !per) return null;
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: { ...delta, per },
			who: { relation: 'you' },
			...(selfTurnPrefix ? { condition: { k: 'isTurnOf', player: { k: 'you' } } } : {})
		};
	}

	const selfIf = selfBody.match(
		/^(?:this spell|~) costs ((?:\{[^}]+\})+) (less|more) to cast if (.+)$/i
	);
	if (selfIf) {
		const rawDelta = parseCostManaDelta(selfIf[1], selfIf[2].toLowerCase() === 'less' ? 'reduce' : 'increase');
		const cond = parseSelfCostCondition(selfIf[3]);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta || !cond) return null;
		const fullCond: Condition = selfTurnPrefix
			? { k: 'and', of: [{ k: 'isTurnOf', player: { k: 'you' } }, cond] }
			: cond;
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta,
			who: { relation: 'you' },
			condition: fullCond
		};
	}

	if (selfTurnPrefix) {
		const selfPlain = selfBody.match(/^(?:this spell|~) costs ((?:\{[^}]+\})+) (less|more) to cast$/i);
		if (selfPlain) {
			const rawDelta = parseCostManaDelta(selfPlain[1], selfPlain[2].toLowerCase() === 'less' ? 'reduce' : 'increase');
			const delta = rawDelta && withFloorAndColored(rawDelta);
			if (!delta) return null;
			return {
				k: 'costModifier',
				affects: { k: 'self' },
				delta,
				who: { relation: 'you' },
				condition: { k: 'isTurnOf', player: { k: 'you' } }
			};
		}
	}

	// Targeting life tax ("Spells your opponents cast that target ~ cost an additional N life to cast").
	const targetLifeTax = text.match(
		/^Spells your opponents cast that target ~ cost an additional (\d+) life to cast$/i
	);
	if (targetLifeTax && !coloredOnly && minTotalMana === undefined) {
		const life = parseInt(targetLifeTax[1], 10);
		return {
			k: 'costModifier',
			affects: { k: 'spell', filter: { targetsSelf: true } },
			delta: { mode: 'increase', generic: 0, additionalCosts: [{ k: 'payLife', amount: { k: 'const', n: life } }] },
			who: { relation: 'each_opponent' }
		};
	}

	// Targeting mana cost modifier ("Spells [you/your opponents cast] that target ~ / a <filter> you control cost {N} more/less to cast").
	const targetManaMod = text.match(
		/^(?:(.+?) )?spells(?: (you|your opponents) cast)? that target (~|(?:a|an) .+?) cost ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (targetManaMod) {
		const spellPrefix = targetManaMod[1] ? parseSpellFilterPhrase(targetManaMod[1]) : { filter: {}, other: false };
		if (!spellPrefix) return null;
		const whoRawTgt = targetManaMod[2]?.toLowerCase();
		const who =
			whoRawTgt === 'you'
				? 'you'
				: whoRawTgt === 'your opponents'
					? 'each_opponent'
					: 'each_player';
		const rawTarget = targetManaMod[3].trim();
		const rawDelta = parseCostManaDelta(
			targetManaMod[4],
			targetManaMod[5].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;

		let targetSpecFilter: ObjectFilter | null = null;
		if (rawTarget === '~') {
			targetSpecFilter = { targetsSelf: true };
		} else {
			let innerTarget = rawTarget.replace(/^(?:a|an)\s+/i, '');
			let ctrl: 'you' | 'opponent' | undefined;
			const oppCtrl = innerTarget.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
			if (oppCtrl) {
				ctrl = 'opponent';
				innerTarget = oppCtrl[1];
			}
			const parsedTarget = parseObjectPhrase(innerTarget.replace(/\s+and\s+/gi, ' or '));
			if (!parsedTarget) return null;
			targetSpecFilter = {
				targetsFilter: {
					...parsedTarget,
					...(ctrl ? { controller: ctrl } : {})
				}
			};
		}
		return {
			k: 'costModifier',
			affects: {
				k: 'spell',
				filter: {
					...spellPrefix.filter,
					...(spellPrefix.other ? { other: true } : {}),
					...targetSpecFilter
				}
			},
			delta,
			who: { relation: who }
		};
	}

	// Activated ability cost modifiers:
	// "Activated abilities of <phrase> cost [up to] {N} less/more to activate."
	const actAbilMod = text.match(
		/^activated abilities of (.+?) cost (?:(up to) )?((?:\{[^}]+\})+) (less|more) to activate$/i
	);
	if (actAbilMod) {
		const mode = actAbilMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase';
		if (actAbilMod[2] && mode !== 'reduce') return null;
		const rawDelta = parseCostManaDelta(actAbilMod[3], mode);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		if (actAbilMod[2] && delta.colored) return null;
		let rawTarget = actAbilMod[1].trim();
		let ctrl: 'you' | 'opponent' | undefined;
		const oppCtrl = rawTarget.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
		if (oppCtrl) {
			ctrl = 'opponent';
			rawTarget = oppCtrl[1];
		}
		const filter = parseObjectPhrase(rawTarget.replace(/\s+and\s+/gi, ' or '));
		if (!filter) return null;
		const finalFilter: ObjectFilter = {
			...filter,
			...(ctrl ? { controller: ctrl } : {})
		};
		return {
			k: 'costModifier',
			affects: { k: 'ability', filter: finalFilter },
			delta,
			who: {
				relation:
					finalFilter.controller === 'you'
						? 'you'
						: finalFilter.controller === 'opponent'
							? 'each_opponent'
							: 'each_player'
			}
		};
	}

	const equipAbilMod = text.match(
		/^equip abilities you activate cost (?:(up to) )?((?:\{[^}]+\})+) (less|more) to activate$/i
	);
	if (equipAbilMod) {
		const mode = equipAbilMod[3].toLowerCase() === 'less' ? 'reduce' : 'increase';
		if (equipAbilMod[1] && mode !== 'reduce') return null;
		const rawDelta = parseCostManaDelta(equipAbilMod[2], mode);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		return {
			k: 'costModifier',
			affects: { k: 'ability', keyword: 'equip' },
			delta,
			who: { relation: 'you' }
		};
	}

	const duringYourTurnGeneral = text.match(/^during your turn,\s*(.+)$/i);
	if (duringYourTurnGeneral && !turnPrefixCondition) {
		turnPrefixCondition = { k: 'isTurnOf', player: { k: 'you' } };
		text = duringYourTurnGeneral[1].trim();
	}

	// General spell cost modifiers:
	// "[As long as ~ is in the command zone or on the battlefield, ][<phrase> ]spells [of the chosen type/color] [you/your opponents cast] [with power/toughness/mana value ...] cost <mana> less/more to cast [for each <metric>]"
	const m = text.match(
		/^(as long as ~ is in the command zone or on the battlefield, )?(?:(.+?) )?spells(?: of the chosen (type|color))?(?: (you|your opponents) cast)?(?: of the chosen (type|color))?(?: with (power|toughness|mana value) (\S+)(?: or (greater|more|less|fewer))?)? cost ((?:\{[^}]+\})+) (less|more) to cast(?: for each (.+))?$/i
	);
	if (!m) return null;
	const chosenKindA = m[3]?.toLowerCase();
	const whoRaw = m[4]?.toLowerCase();
	const chosenKindB = m[5]?.toLowerCase();
	if (chosenKindA && chosenKindB && chosenKindA === chosenKindB) return null;

	const parsedPhrase = parseSpellFilterPhrase(m[2] ?? '');
	if (!parsedPhrase) return null;
	const { filter: baseFilter, other } = parsedPhrase;

	let extraStatFilter: Partial<ObjectFilter> = {};
	if (m[6] && m[7]) {
		const statVal = count(m[7]);
		if (!statVal || (statVal.k === 'const' && m[7].toLowerCase() === 'a')) return null;
		const dir = m[8]?.toLowerCase();
		const cmp: Compare = { op: !dir ? '=' : dir === 'greater' || dir === 'more' ? '>=' : '<=', value: statVal };
		const statKind = m[6].toLowerCase();
		const key = statKind === 'power' ? 'power' : statKind === 'toughness' ? 'toughness' : 'manaValue';
		if (baseFilter[key]) return null;
		extraStatFilter = { [key]: cmp };
	}

	const rawDelta = parseCostManaDelta(m[9], m[10].toLowerCase() === 'less' ? 'reduce' : 'increase');
	const deltaBase = rawDelta && withFloorAndColored(rawDelta);
	if (!deltaBase) return null;

	let per: Amount | undefined;
	if (m[11]) {
		const parsedPer = parseCostMetricAmount(m[11]);
		if (!parsedPer) return null;
		per = parsedPer;
	}

	const filter: ObjectFilter = {
		...baseFilter,
		...extraStatFilter,
		...(other ? { other: true } : {}),
		...(chosenKindA === 'type' || chosenKindB === 'type' ? { ofChosenType: true } : {}),
		...(chosenKindA === 'color' || chosenKindB === 'color' ? { ofChosenColor: true } : {})
	};
	const who = whoRaw === 'you' ? 'you' : whoRaw === 'your opponents' ? 'each_opponent' : 'each_player';
	return {
		k: 'costModifier',
		affects: { k: 'spell', filter },
		delta: {
			...deltaBase,
			...(per ? { per } : {})
		},
		who: { relation: who },
		activeZones: m[1] ? ['battlefield', 'command'] : undefined,
		...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
	};
}
