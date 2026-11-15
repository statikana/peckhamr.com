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
import { normalizeCounterName, type CounterType, type ManaColor, type ZoneType } from '../types.ts';

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
	forty: 40,
	fifty: 50
};

// CR 700.12: Assassins, Mercenaries, Pirates, Rogues, and Warlocks are outlaws.
const OUTLAW_SUBTYPES = ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'] as const;

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
	'sacrifice|tap|untap|unattach|discard|pay|exile|remove|return|put|reveal|mill|collect|forage|exert|blight|waterbend|behold|have|roll|flip';
const COST_VERB = new RegExp(`^(?:\\{|(?:${COST_VERBS})\\b)`, 'i');
const COST_SEPARATOR = new RegExp(`,\\s*|\\s+and\\s+(?=(?:${COST_VERBS})\\b)`, 'gi');

const DISALLOWED_COUNTER_WORDS = new Set([
	'a',
	'an',
	'all',
	'any',
	'other',
	'another',
	'more',
	'fewer',
	'less',
	'or',
	'and',
	'from',
	'among',
	'on',
	'of',
	'the',
	'your',
	'its',
	'their',
	'no',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine',
	'ten',
	'eleven',
	'twelve',
	'thirteen',
	'fourteen',
	'fifteen',
	'sixteen',
	'seventeen',
	'eighteen',
	'nineteen',
	'twenty',
	'thirty',
	'forty',
	'fifty',
	'x',
	'counter',
	'counters'
]);

function lookupCounterWord(raw: string): CounterType | null {
	const clean = raw.trim().toLowerCase().replace(/−/g, '-').replace(/\s+/g, ' ');
	if (!clean || DISALLOWED_COUNTER_WORDS.has(clean)) return null;
	if (COUNTERS[clean]) return COUNTERS[clean];
	if (/^[+-]\d+\/[+-]\d+$/.test(clean)) return normalizeCounterName(clean);
	if (/^[a-z][a-z'-]*(?: [a-z][a-z'-]*)?$/.test(clean)) {
		const parts = clean.split(' ');
		if (parts.some((p) => DISALLOWED_COUNTER_WORDS.has(p))) return null;
		return normalizeCounterName(clean);
	}
	return null;
}

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
	opts?: { allowPluralAndDisjunction?: boolean; allowPlural?: boolean; depth?: number }
): ObjectFilter | null {
	const filter: ObjectFilter = {};
	let rest = phrase.trim();
	const depth = opts?.depth ?? 0;

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
		// --- Track P17b: explicit card name & spell/exile relational qualifiers ---
		const namedCard = rest.match(
			/^(.+?)\s+named ([A-Z][A-Za-z0-9',-]*(?:\s+(?:[A-Z][A-Za-z0-9',-]*|of|the))*)$/
		);
		if (namedCard && !filter.named && !filter.sameNameAsSource) {
			filter.named = namedCard[2].trim();
			rest = namedCard[1];
			continue;
		}
		const sharesColorSpell = rest.match(/^(.+?)\s+that shares? a color with that spell$/i);
		if (sharesColorSpell && !filter.sharesColorWithSpell) {
			filter.sharesColorWithSpell = true;
			rest = sharesColorSpell[1];
			continue;
		}
		const sharesTypeExiled = rest.match(/^(.+?)\s+that shares? a card type with the exiled card$/i);
		if (sharesTypeExiled && !filter.sharesCardTypeWithExiled) {
			filter.sharesCardTypeWithExiled = true;
			rest = sharesTypeExiled[1];
			continue;
		}
		// --- End Track P17b ---
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
		// --- Track P20b: trailing "other than ~" qualifier ---
		const otherThanSelf = rest.match(/^(.+?)\s+other than ~$/i);
		if (otherThanSelf && !filter.other) {
			filter.other = true;
			rest = otherThanSelf[1];
			continue;
		}
		// --- End Track P20b ---
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
		const withStrictStat = rest.match(
			/^(.+?)\s+with (power|toughness|mana value) (greater|more|less|fewer) than (\S+)$/i
		);
		if (withStrictStat) {
			const value = count(withStrictStat[4]);
			if (!value || (value.k === 'const' && withStrictStat[4].toLowerCase() === 'a')) return null;
			const dir = withStrictStat[3].toLowerCase();
			const cmp: Compare = { op: dir === 'greater' || dir === 'more' ? '>' : '<', value };
			const statKind = withStrictStat[2].toLowerCase();
			const key =
				statKind === 'power' ? 'power' : statKind === 'toughness' ? 'toughness' : 'manaValue';
			if (filter[key]) return null;
			filter[key] = cmp;
			rest = withStrictStat[1];
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
		const enteredTurn = rest.match(/^(.+?)\s+that entered(?: the battlefield)? this turn$/i);
		if (enteredTurn && filter.enteredThisTurn === undefined) {
			filter.enteredThisTurn = true;
			rest = enteredTurn[1];
			continue;
		}
		const wasDamagedTurn = rest.match(/^(.+?)\s+that (?:was|were) dealt damage this turn$/i);
		if (wasDamagedTurn && filter.dealtDamageThisTurn === undefined) {
			filter.dealtDamageThisTurn = true;
			rest = wasDamagedTurn[1];
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
			/^(.+?)\s+with (?:(?:a|an|one or more)\s+)?([+\-−]\d+\/[+\-−]\d+|[a-z][a-z'-]*(?: [a-z][a-z'-]*)?) counters? on (?:it|them)$/i
		);
		if (withTypedCounter && !filter.hasCounters) {
			const c = lookupCounterWord(withTypedCounter[2]);
			if (c) {
				filter.hasCounters = c;
				rest = withTypedCounter[1];
				continue;
			}
		}
		// --- Track P14 & P17b: "that's / that are equipped / enchanted / tapped / untapped / modified / suspected / attacking / blocking" ---
		const thatState = rest.match(
			/^(.+?)\s+that(?:'s| is| are) (equipped|enchanted|tapped|untapped|modified|unmodified|suspected|attacking|blocking|face-down|face-up)$/i
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
			if ((stKind === 'modified' || stKind === 'unmodified') && filter.modified === undefined) {
				filter.modified = stKind === 'modified';
				rest = thatState[1];
				continue;
			}
			if (stKind === 'suspected' && filter.suspected === undefined) {
				filter.suspected = true;
				rest = thatState[1];
				continue;
			}
			if (stKind === 'attacking' && filter.attacking === undefined) {
				filter.attacking = true;
				rest = thatState[1];
				continue;
			}
			if (stKind === 'blocking' && filter.blocking === undefined) {
				filter.blocking = true;
				rest = thatState[1];
				continue;
			}
			if ((stKind === 'face-down' || stKind === 'face-up') && filter.faceDown === undefined) {
				filter.faceDown = stKind === 'face-down';
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
	// --- Track P17b: Full-NP disjunctions where branch 2+ carries its own article/modifier
	// ("another creature or a Treasure", "legendary artifact or legendary creature", "green enchantment or white enchantment") ---
	if (
		depth === 0 &&
		/\s+(?:or|and\/or)\s+/i.test(rest) &&
		!/^attacking\s+or\s+blocking\b/i.test(rest)
	) {
		const rawAlts = rest
			.replace(/,/g, ' ,')
			.split(/\s*(?:,\s*(?:or|and\/or)\b|\bor\b|\band\/or\b)\s*/i)
			.map((a) => a.trim())
			.filter(Boolean);
		const laterHasOwnDetOrMod = rawAlts.slice(1).some((a) => {
			if (/^(?:a|an|another|other)\s+/i.test(a)) return true;
			const stripped = a.replace(/\s+cards?$/i, '').trim();
			return stripped.includes(' ') && !/^Time\s+Lords?$/i.test(stripped) && !/^Eldrazi\s+(?:Scions?|Spawns?)$/i.test(stripped);
		});
		const firstHasMod = rawAlts[0]
			?.replace(/^(?:a|an)\s+/i, '')
			.replace(/\s+cards?$/i, '')
			.trim()
			.includes(' ');
		if (rawAlts.length >= 2 && firstHasMod && laterHasOwnDetOrMod) {
			const trailingCard = /\s+cards?$/i.test(rawAlts[rawAlts.length - 1]);
			const branchFilters = rawAlts.map((a, idx) => {
				const cleanAlt = a.replace(/^(?:a|an)\s+/i, '').trim();
				if (idx === 0) {
					const b0 = parseObjectPhrase(cleanAlt, { ...opts, depth: 1 });
					if (b0 && Object.keys(b0).length > 0) return b0;
					return trailingCard && cleanAlt.includes(' ')
						? parseObjectPhrase(`${cleanAlt} card`, { ...opts, depth: 1 })
						: null;
				}
				const b = parseObjectPhrase(cleanAlt, { ...opts, depth: 1 });
				if (b && Object.keys(b).length > 0) return b;
				return trailingCard ? parseObjectPhrase(`${cleanAlt} card`, { ...opts, depth: 1 }) : null;
			});
			if (branchFilters.every((b): b is ObjectFilter => b !== null && Object.keys(b).length > 0)) {
				filter.anyOf = branchFilters;
				return filter;
			}
		}
	}
	// --- End Track P17b ---

	const words = rest.split(/\s+/).filter(Boolean);

	// Leading modifiers.
	for (let guard = 0; guard < 32 && words.length > 0; guard++) {
		const rawWord = words[0].replace(/,$/, '');
		const low = rawWord.toLowerCase();
		if (
			low === 'attacking' &&
			words.length >= 4 &&
			words[1].toLowerCase() === 'or' &&
			words[2].toLowerCase() === 'blocking'
		) {
			filter.attackingOrBlocking = true;
			words.splice(0, 3);
			continue;
		}
		// Do not hoist a standalone modifier immediately before "or" ("noncreature or Robot", "historic or Dragon").
		if (words.length >= 3 && /^(?:or|and\/or)$/i.test(words[1]) && !COLORS[low]) {
			break;
		}
		if (low === 'another' || low === 'other') filter.other = true;
		else if (low === 'untapped') filter.tapped = false;
		else if (low === 'tapped') filter.tapped = true;
		else if (low === 'saddled') filter.saddled = true;
		else if (low === 'monstrous') filter.monstrous = true;
		else if (low === 'nontoken') filter.token = false;
		else if (low === 'historic') filter.historic = true;
		else if (low === 'nonhistoric') filter.historic = false;
		else if (low === 'commander' || low === 'commanders') filter.isCommander = true;
		// --- Track P17b ---
		else if (low === 'modified') filter.modified = true;
		else if (low === 'unmodified') filter.modified = false;
		else if (low === 'suspected') filter.suspected = true;
		else if (low === 'face-down') filter.faceDown = true;
		else if (low === 'face-up') filter.faceDown = false;
		else if (low === 'kicked') filter.kickedSpell = true;
		else if (low === 'bargained') filter.bargainedSpell = true;
		else if (low === 'outlaw' || low === 'outlaws') {
			if (filter.subtypes) return null;
			filter.subtypes = [...OUTLAW_SUBTYPES];
		} else if (low === 'non-outlaw') {
			const dst = (filter.notSubtypes ??= []);
			for (const s of OUTLAW_SUBTYPES) {
				if (!dst.includes(s)) dst.push(s);
			}
		} else if (
			rawWord === 'non-Time' &&
			words.length >= 2 &&
			/^Lords?,?$/.test(words[1])
		) {
			(filter.notSubtypes ??= []).push('Time Lord');
			words.splice(0, 2);
			continue;
		}
		// --- End Track P17b ---
		else if (low === 'unblocked') filter.unblockedAttacker = true;
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
			// --- Track P20b: Do not consume color before `or <non-color>` ("black or artifact creature") ---
			if (words.length >= 3 && /^(?:or|and\/or)$/i.test(words[1])) {
				break;
			}
			// --- End Track P20b ---
			(filter.colors ??= []).push(COLORS[low]);
		}
		else if (NON_COLORS[low]) (filter.notColors ??= []).push(NON_COLORS[low]);
		else if (/^non[a-z]+$/.test(low) && CARD_TYPES[low.slice(3)]) {
			(filter.notTypes ??= []).push(CARD_TYPES[low.slice(3)]);
		} else if (/^non[a-z]+$/.test(low) && SUPERTYPES[low.slice(3)]) {
			(filter.notSupertypes ??= []).push(SUPERTYPES[low.slice(3)]);
		} else if (/^non-[A-Z][A-Za-z'-]*$/.test(rawWord)) {
			(filter.notSubtypes ??= []).push(rawWord.slice(4));
		} else break;
		words.shift();
	}
	if (words.length === 0) return filter.isCommander || Boolean(filter.subtypes?.length) ? filter : null;

	// "card(s)" after a type ("creature card") adds nothing.
	let hadTrailingCard = false;
	if (words.length > 1 && /^cards?$/i.test(words[words.length - 1])) {
		hadTrailingCard = true;
		words.pop();
	}

	// Disjunction: "artifact or creature", "Elf, Goblin, or Wizard". Prefer flat types/subtypes when all
	// alternatives share a single kind; otherwise fall back to `anyOf` (Track P17b).
	const joined = words.join(' ').replace(/,/g, ' ,');
	if (/\b(?:or|and\/or)\b/.test(joined)) {
		const alts = joined
			.split(/\s*(?:,\s*(?:or|and\/or)?|\bor\b|\band\/or\b)\s*/)
			.map((a) => a.trim().replace(/^(?:a|an)\s+/i, ''))
			.filter(Boolean);
		const nouns = alts.map((a) => (a.includes(' ') ? null : noun(a)));
		if (!nouns.some((n) => !n || n.any || n.token)) {
			const allTypes = nouns.every((n) => n!.types);
			const allSubtypes = nouns.every((n) => n!.subtypes);
			if (allTypes || allSubtypes) {
				if (allTypes) filter.types = nouns.flatMap((n) => n!.types!);
				else filter.subtypes = nouns.flatMap((n) => n!.subtypes!);
				return filter;
			}
		}
		if (depth === 0 && alts.length >= 2) {
			const branchFilters = alts.map((a) => {
				const b = parseObjectPhrase(a, { ...opts, depth: 1 });
				if (b && Object.keys(b).length > 0) return b;
				return hadTrailingCard ? parseObjectPhrase(`${a} card`, { ...opts, depth: 1 }) : null;
			});
			if (branchFilters.every((b): b is ObjectFilter => b !== null && Object.keys(b).length > 0)) {
				filter.anyOf = branchFilters;
				return filter;
			}
			// --- Track P20b: Shared trailing head noun across modifier disjunction ("black or artifact creature") ---
			const lastAltWords = alts[alts.length - 1].split(/\s+/).filter(Boolean);
			if (lastAltWords.length >= 2) {
				const sharedHead = lastAltWords[lastAltWords.length - 1];
				const headExpanded = alts.map((a, idx) => {
					const phraseWithHead =
						idx === alts.length - 1 ? a : `${a} ${sharedHead}`;
					const b = parseObjectPhrase(phraseWithHead, { ...opts, depth: 1 });
					if (b && Object.keys(b).length > 0) return b;
					return hadTrailingCard
						? parseObjectPhrase(`${phraseWithHead} card`, { ...opts, depth: 1 })
						: null;
				});
				if (headExpanded.every((b): b is ObjectFilter => b !== null && Object.keys(b).length > 0)) {
					filter.anyOf = headExpanded;
					return filter;
				}
			}
			// --- End Track P20b ---
		}
		return null;
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

	// --- Track P17b: CR 205.3m Time Lord & explicit compound token/creature subtypes (Eldrazi Scion / Eldrazi Spawn) ---
	for (let i = 0; i + 1 < words.length; i++) {
		if (words[i] === 'Time' && /^Lords?$/.test(words[i + 1])) {
			if (filter.subtypes || filter.allSubtypes) return null;
			filter.subtypes = ['Time Lord'];
			words.splice(i, 2);
			break;
		}
		if (words[i] === 'Eldrazi' && /^(?:Scions?|Spawns?)$/.test(words[i + 1])) {
			if (filter.subtypes || filter.allSubtypes) return null;
			const second = /^Scions?$/.test(words[i + 1]) ? 'Scion' : 'Spawn';
			filter.allSubtypes = ['Eldrazi', second];
			words.splice(i, 2);
			break;
		}
	}
	// --- End Track P17b ---

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
			if (filter.subtypes || filter.allSubtypes) return null;
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

/** "Pay 2 life", "Pay X life", "Pay half your life, rounded up", "Pay life equal to ~'s power". */
const payLife: Production = (part) => {
	if (/^pay half your life, rounded up$/i.test(part)) {
		return [{ k: 'payLife', amount: { k: 'const', n: 0 }, halfLifeRoundedUp: true }];
	}
	if (/^pay life equal to ~'s power$/i.test(part)) {
		return [{ k: 'payLife', amount: { k: 'stat', of: { k: 'self' }, stat: 'power' } }];
	}
	if (/^pay life equal to the number of colors in your commanders?'?s? color identity$/i.test(part)) {
		return [{ k: 'payLife', amount: { k: 'p17bMetric', metric: 'commanderColorIdentityCount' } }];
	}
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

function parseSingleSacrificeItem(rawBody: string): Extract<CostDef, { k: 'sacrifice' }> | null {
	const body = rawBody.trim();
	if (body === '~') return { k: 'sacrifice', count: ONE, filter: 'self' };
	if (/^(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(body)) {
		return { k: 'sacrifice', count: ONE, filter: { controller: 'you' }, attachedCreature: true };
	}
	const allM = body.match(/^all (.+?) you control$/i);
	if (allM) {
		const filter = /^permanents$/i.test(allM[1].trim()) ? {} : parseObjectPhrase(allM[1]);
		if (!filter || filter.controller) return null;
		return {
			k: 'sacrifice',
			count: ONE,
			filter: { ...filter, controller: 'you' },
			sacrificeAll: true
		};
	}
	const halfM = body.match(/^half the (.+?) you control, rounded up$/i);
	if (halfM) {
		const filter = /^permanents$/i.test(halfM[1].trim()) ? {} : parseObjectPhrase(halfM[1]);
		if (!filter || filter.controller) return null;
		return {
			k: 'sacrifice',
			count: ONE,
			filter: { ...filter, controller: 'you' },
			halfRoundedUp: true
		};
	}
	// --- Track P20b: "one or more <phrase>", "up to N <phrase>", "N <phrase> with different names" ---
	const oneOrMoreM = body.match(/^one or more (.+)$/i);
	if (oneOrMoreM) {
		const filter = /^permanents$/i.test(oneOrMoreM[1].trim())
			? {}
			: parseObjectPhrase(oneOrMoreM[1], { allowPluralAndDisjunction: true });
		if (!filter || (filter.controller && filter.controller !== 'you')) return null;
		return {
			k: 'sacrifice',
			count: ONE,
			oneOrMore: true,
			filter: { ...filter, controller: 'you' }
		};
	}
	const upToM = body.match(/^up to (\S+) (.+)$/i);
	if (upToM) {
		const mx = count(upToM[1]);
		if (!mx || mx.k !== 'const' || mx.n < 1) return null;
		const filter = /^permanents$/i.test(upToM[2].trim())
			? {}
			: parseObjectPhrase(upToM[2], { allowPluralAndDisjunction: true });
		if (!filter || (filter.controller && filter.controller !== 'you')) return null;
		return {
			k: 'sacrifice',
			count: { k: 'const', n: 0 },
			upTo: mx.n,
			filter: { ...filter, controller: 'you' }
		};
	}
	const diffNamesM = body.match(/^(.+?) with different names$/i);
	if (diffNamesM) {
		const leadDiff = parseLeadingCostCount(diffNamesM[1], false);
		if (!leadDiff) return null;
		const filter = /^permanents$/i.test(leadDiff.phrase)
			? {}
			: parseObjectPhrase(leadDiff.phrase, { allowPluralAndDisjunction: true });
		if (!filter || (filter.controller && filter.controller !== 'you')) return null;
		return {
			k: 'sacrifice',
			count: leadDiff.count,
			differentNames: true,
			filter: { ...filter, controller: 'you' }
		};
	}
	// --- End Track P20b ---
	const lead = parseLeadingCostCount(body, true);
	if (!lead) return null;
	const filter = parseObjectPhrase(lead.phrase);
	if (!filter || (filter.controller && filter.controller !== 'you')) return null;
	return { k: 'sacrifice', count: lead.count, filter: { ...filter, controller: 'you' } };
}

/** "Sacrifice ~", "Sacrifice a creature", "Sacrifice two Foods", "Sacrifice another creature", "Sacrifice ~ and two lands". */
const sacrifice: Production = (part) => {
	const m = part.match(/^sacrifice (.+)$/i);
	if (!m) return null;
	const single = parseSingleSacrificeItem(m[1]);
	if (single) return [single];
	if (/\band\b/i.test(m[1]) && !/\bor\b/i.test(m[1])) {
		const items = m[1]
			.split(/\s*(?:,\s*and\s+|,\s*|\s+and\s+)\s*/i)
			.map((s) => s.trim())
			.filter(Boolean);
		if (items.length >= 2) {
			const parsed = items.map(parseSingleSacrificeItem);
			if (parsed.every((d): d is Extract<CostDef, { k: 'sacrifice' }> => d !== null)) {
				return parsed;
			}
		}
	}
	return null;
};

/** "Tap ten untapped Elves you control", "Tap an untapped creature you control", "Tap five untapped Elves you control that share a creature type", "Tap enchanted creature". */
const tapOthers: Production = (part) => {
	if (/^tap (?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(part)) {
		return [{ k: 'tapAttached' }];
	}
	const shareType = part.match(
		/^tap (\S+) (other )?untapped (.+?) you control that share a creature type$/i
	);
	if (shareType) {
		const n = count(shareType[1]);
		const filter = parseObjectPhrase(`${shareType[2] ?? ''}${shareType[3]}`);
		if (!n || !filter || filter.controller) return null;
		return [
			{
				k: 'tapOthers',
				count: n,
				filter: { ...filter, controller: 'you', tapped: false },
				shareCreatureType: true
			}
		];
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
	// --- Track P20b: "Tap any number of untapped [other] <phrase> you control [other than ~] with total power N or greater" ---
	const subsetPower = part.match(
		/^tap any number of untapped (.+?) with total power (\S+) or (?:greater|more)$/i
	);
	if (subsetPower) {
		const minTotal = count(subsetPower[2]);
		const filter = parseObjectPhrase(subsetPower[1]);
		if (!minTotal || !filter || filter.controller !== 'you') return null;
		const excludeSelf = Boolean(filter.other);
		const cleanFilter = { ...filter };
		delete cleanFilter.other;
		return [
			{
				k: 'tapSubsetSum',
				minTotal,
				metric: 'power',
				filter: { ...cleanFilter, controller: 'you', tapped: false },
				...(excludeSelf ? { excludeSelf: true } : {})
			}
		];
	}
	// --- End Track P20b ---
	const anotherUntapped = part.match(/^tap (another|other) untapped (.+) you control$/i);
	if (anotherUntapped) {
		const filter = parseObjectPhrase(`other ${anotherUntapped[2]}`);
		if (!filter || filter.controller) return null;
		return [{ k: 'tapOthers', count: ONE, filter: { ...filter, controller: 'you', tapped: false } }];
	}
	const m = part.match(/^tap (\S+) (other )?untapped (.+) you control$/i);
	if (m) {
		const n = count(m[1]);
		const filter = parseObjectPhrase(`${m[2] ?? ''}${m[3]}`);
		if (!n || !filter || filter.controller) return null;
		return [{ k: 'tapOthers', count: n, filter: { ...filter, controller: 'you', tapped: false } }];
	}
	// Fallback when "you control" precedes trailing qualifiers ("Tap five untapped attacking creatures you control named ~", "Tap another untapped creature you control with flying").
	const trailingQual = part.match(/^tap (\S+) (other )?untapped (.+)$/i);
	if (trailingQual) {
		const isAnother = /^(?:another|other)$/i.test(trailingQual[1]);
		const n = isAnother ? ONE : count(trailingQual[1]);
		const filter = parseObjectPhrase(
			`${isAnother ? 'other ' : (trailingQual[2] ?? '')}${trailingQual[3]}`
		);
		if (!n || !filter || filter.controller !== 'you') return null;
		return [{ k: 'tapOthers', count: n, filter: { ...filter, tapped: false } }];
	}
	return null;
};

/** CR 302.6 / 602.2: Spelled-out "Untap ~" (`viaSymbol: false`) or "Untap N tapped <phrase> you control". */
const untapCost: Production = (part) => {
	if (/^untap ~$/i.test(part)) {
		return [{ k: 'untapSelf', viaSymbol: false }];
	}
	const anyTapped = part.match(/^untap any number of tapped (.+) you control$/i);
	if (anyTapped) {
		const filter = parseObjectPhrase(anyTapped[1]);
		if (!filter || filter.controller) return null;
		return [
			{
				k: 'untapOthers',
				count: { k: 'anyNumber' },
				filter: { ...filter, controller: 'you', tapped: true }
			}
		];
	}
	const anotherTapped = part.match(/^untap (another|other) tapped (.+) you control$/i);
	if (anotherTapped) {
		const filter = parseObjectPhrase(`other ${anotherTapped[2]}`);
		if (!filter || filter.controller) return null;
		return [{ k: 'untapOthers', count: ONE, filter: { ...filter, controller: 'you', tapped: true } }];
	}
	const m = part.match(/^untap (\S+) (other )?tapped (.+) you control$/i);
	if (m) {
		const n = count(m[1]);
		const filter = parseObjectPhrase(`${m[2] ?? ''}${m[3]}`);
		if (!n || !filter || filter.controller) return null;
		return [{ k: 'untapOthers', count: n, filter: { ...filter, controller: 'you', tapped: true } }];
	}
	const trailingUntapQual = part.match(/^untap (\S+) (other )?tapped (.+)$/i);
	if (trailingUntapQual) {
		const isAnother = /^(?:another|other)$/i.test(trailingUntapQual[1]);
		const n = isAnother ? ONE : count(trailingUntapQual[1]);
		const filter = parseObjectPhrase(
			`${isAnother ? 'other ' : (trailingUntapQual[2] ?? '')}${trailingUntapQual[3]}`
		);
		if (!n || !filter || filter.controller !== 'you') return null;
		return [{ k: 'untapOthers', count: n, filter: { ...filter, tapped: true } }];
	}
	return null;
};

function parseSingleDiscardBody(bodyRaw: string): Extract<CostDef, { k: 'discard' }> | null {
	const body = bodyRaw.trim();
	// "two [<phrase>] cards with the same name"
	const samePair = body.match(/^two (?:(.+?) )?cards with the same name$/i);
	if (samePair) {
		const f = samePair[1] ? parseObjectPhrase(`${samePair[1]} card`) : {};
		if (!f) return null;
		return {
			k: 'discard',
			count: { k: 'const', n: 2 },
			...(Object.keys(f).length > 0 ? { filter: f } : {}),
			sameNamePair: true
		};
	}
	// --- Track P20b: "N [<phrase>] cards with different names" ---
	const diffNames = body.match(/^(\S+) (?:(.+?) )?cards with different names$/i);
	if (diffNames) {
		const cnt = count(diffNames[1]);
		const f = diffNames[2] ? parseObjectPhrase(`${diffNames[2]} card`) : {};
		if (!cnt || !f) return null;
		return {
			k: 'discard',
			count: cnt,
			...(Object.keys(f).length > 0 ? { filter: f } : {}),
			differentNames: true
		};
	}
	// --- End Track P20b ---
	// "a [<phrase>] card with the same name as a [<ctrlPhrase>] you control"
	const sameControlled = body.match(
		/^(?:a|an|one) (?:(.+?) )?card with the same name as (?:a|an) (.+?) you control$/i
	);
	if (sameControlled) {
		const f = sameControlled[1] ? parseObjectPhrase(`${sameControlled[1]} card`) : {};
		const ctrlF = /^permanent$/i.test(sameControlled[2].trim())
			? {}
			: parseObjectPhrase(sameControlled[2]);
		if (!f || !ctrlF || ctrlF.controller) return null;
		return {
			k: 'discard',
			count: ONE,
			...(Object.keys(f).length > 0 ? { filter: f } : {}),
			sameNameAsControlledFilter: { ...ctrlF, controller: 'you' }
		};
	}
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

/** "Exile ~", "Exile ~ from your graveyard/hand", "Exile two creature cards from your graveyard", "Exile the top three cards of your graveyard". */
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
	// --- Track P20b: Araumi, Say Its Name, Corpseweft, Fabrication Foundry ---
	const eqOpponents = part.match(
		/^exile (?:(.+?) )?cards? from your (graveyard|hand) equal to the number of opponents you have$/i
	);
	if (eqOpponents) {
		const filter = eqOpponents[1] ? parseObjectPhrase(`${eqOpponents[1]} card`) : {};
		if (!filter) return null;
		return [
			{
				k: 'exileFrom',
				zone: eqOpponents[2].toLowerCase() as 'graveyard' | 'hand',
				count: { k: 'opponentCount' },
				...(Object.keys(filter).length > 0 ? { filter } : {})
			}
		];
	}
	const selfAndSameName = part.match(
		/^exile ~ and (\S+) other cards? named ~ from your graveyard$/i
	);
	if (selfAndSameName) {
		const extraCnt = count(selfAndSameName[1]);
		if (!extraCnt) return null;
		return [
			{ k: 'exileFrom', zone: 'graveyard', count: ONE, filter: 'self' },
			{
				k: 'exileFrom',
				zone: 'graveyard',
				count: extraCnt,
				filter: { sameNameAsSource: true, other: true }
			}
		];
	}
	const oneOrMoreZone = part.match(
		/^exile one or more (?:(.+?) )?cards? from your (graveyard|hand)$/i
	);
	if (oneOrMoreZone) {
		const filter = oneOrMoreZone[1] ? parseObjectPhrase(`${oneOrMoreZone[1]} card`) : {};
		if (!filter) return null;
		return [
			{
				k: 'exileFrom',
				zone: oneOrMoreZone[2].toLowerCase() as 'graveyard' | 'hand',
				count: ONE,
				oneOrMore: true,
				...(Object.keys(filter).length > 0 ? { filter } : {})
			}
		];
	}
	const oneOrMoreBfMvX = part.match(
		/^exile one or more (.+?) you control with total mana value X$/i
	);
	if (oneOrMoreBfMvX) {
		const filter = parseObjectPhrase(oneOrMoreBfMvX[1], { allowPluralAndDisjunction: true });
		if (!filter || filter.controller) return null;
		return [
			{
				k: 'exileFrom',
				zone: 'battlefield',
				count: ONE,
				oneOrMore: true,
				totalManaValueEqualsX: true,
				filter: { ...filter, controller: 'you' }
			}
		];
	}
	// --- End Track P20b ---
	// Compound "Exile <N> [<phrase>] cards from your graveyard and ~"
	const gyAndSelf = part.match(/^exile (.+? from your graveyard) and ~$/i);
	if (gyAndSelf) {
		const first = exileFrom(`Exile ${gyAndSelf[1]}`);
		if (first) {
			return [...first, { k: 'exileFrom', zone: 'battlefield', count: ONE, filter: 'self' }];
		}
	}
	// "Exile the top [N] [<phrase>] card(s) of your graveyard/library"
	const topOfZone = part.match(/^exile the top (.+?) of your (graveyard|library)$/i);
	if (topOfZone) {
		const zone = topOfZone[2].toLowerCase() as 'graveyard' | 'library';
		const rawBody = topOfZone[1].trim();
		const lead = parseLeadingCostCount(rawBody, false) ?? { count: ONE, phrase: rawBody };
		const filter = /^cards?$/i.test(lead.phrase) ? {} : parseObjectPhrase(lead.phrase);
		if (!filter) return null;
		return [
			{
				k: 'exileFrom',
				zone,
				count: lead.count,
				...(Object.keys(filter).length > 0 ? { filter } : {}),
				fromTop: true
			}
		];
	}
	// "Exile any number of [<phrase>] cards from your graveyard with total mana value N or greater"
	const totalMvGy = part.match(
		/^exile any number of (?:(.+?) )?cards from your graveyard with total mana value (\S+) or (?:greater|more)$/i
	);
	if (totalMvGy) {
		const minAmt = count(totalMvGy[2]);
		if (!minAmt || minAmt.k !== 'const') return null;
		const filter = totalMvGy[1] ? parseObjectPhrase(`${totalMvGy[1]} card`) : {};
		if (!filter) return null;
		return [
			{
				k: 'exileFrom',
				zone: 'graveyard',
				count: { k: 'anyNumber' },
				...(Object.keys(filter).length > 0 ? { filter } : {}),
				minTotalManaValue: minAmt.n
			}
		];
	}
	// "Exile a(n) [<phrase>] spell you control" (stack)
	const stackSpell = part.match(/^exile (.+?) spells? you control$/i);
	if (stackSpell) {
		const rawSpell = stackSpell[1].trim();
		const cnt = count(rawSpell);
		if (cnt) {
			return [{ k: 'exileFrom', zone: 'stack', count: cnt }];
		}
		const lead = parseLeadingCostCount(`${rawSpell} card`, true);
		if (!lead) return null;
		const filter = parseObjectPhrase(lead.phrase);
		if (!filter || filter.controller) return null;
		return [
			{
				k: 'exileFrom',
				zone: 'stack',
				count: lead.count,
				...(Object.keys(filter).length > 0 ? { filter } : {})
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
	// "Exile <N> [<phrase>] card(s) from a [single] graveyard"
	const anyGy = part.match(/^exile (.+?) from a (single )?graveyard$/i);
	if (anyGy) {
		const lead = parseLeadingCostCount(anyGy[1], true);
		if (!lead || !lead.phrase) return null;
		const filter = /^cards?$/i.test(lead.phrase) ? {} : parseObjectPhrase(lead.phrase);
		if (!filter) return null;
		return [
			{
				k: 'exileFrom',
				zone: 'graveyard',
				count: lead.count,
				filter: Object.keys(filter).length > 0 ? filter : undefined,
				...(anyGy[2] ? { singleGraveyard: true } : { anyGraveyard: true })
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

/** "Remove a +1/+1 counter from ~", "Remove a -0/-1 counter from ~", "Remove X storage counters from ~", "Remove two +1/+1 counters from among creatures you control". */
const removeCounters: Production = (part) => {
	// Choice of counter types: "Remove a +1/+1 counter or a charge counter from ~ / a permanent you control"
	const choiceSelf = part.match(
		/^remove (?:a|an|one) (.+?) counter or (?:a|an|one) (.+?) counter from ~$/i
	);
	if (choiceSelf) {
		const c1 = lookupCounterWord(choiceSelf[1]);
		const c2 = lookupCounterWord(choiceSelf[2]);
		if (c1 && c2) {
			return [
				{
					k: 'choice',
					options: [
						[{ k: 'removeCounters', counter: c1, count: ONE, from: 'self' }],
						[{ k: 'removeCounters', counter: c2, count: ONE, from: 'self' }]
					]
				}
			];
		}
	}
	const choiceCtrl = part.match(
		/^remove (?:a|an|one) (.+?) counter or (?:a|an|one) (.+?) counter from (?:(?:a|an)\s+|(?=(?:another|other)\b))(.+?) you control$/i
	);
	if (choiceCtrl) {
		const c1 = lookupCounterWord(choiceCtrl[1]);
		const c2 = lookupCounterWord(choiceCtrl[2]);
		const filter = parseObjectPhrase(choiceCtrl[3]);
		if (c1 && c2 && filter && !filter.controller) {
			const fromFilter: ObjectFilter = { ...filter, controller: 'you' };
			return [
				{
					k: 'choice',
					options: [
						[{ k: 'removeCounters', counter: c1, count: ONE, from: fromFilter }],
						[{ k: 'removeCounters', counter: c2, count: ONE, from: fromFilter }]
					]
				}
			];
		}
	}
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
	// --- Track P20b: "Remove any number of / one or more [<counter>] counters from ~ / from among ..." ---
	if (/^remove any number of counters? from ~$/i.test(part)) {
		return [{ k: 'removeCounters', counter: 'any', count: { k: 'anyNumber' }, from: 'self' }];
	}
	const anyNumTypedSelf = part.match(/^remove any number of (.+?) counters? from ~$/i);
	if (anyNumTypedSelf) {
		const counter = lookupCounterWord(anyNumTypedSelf[1]);
		return counter
			? [{ k: 'removeCounters', counter, count: { k: 'anyNumber' }, from: 'self' }]
			: null;
	}
	if (/^remove one or more counters? from ~$/i.test(part)) {
		return [{ k: 'removeCounters', counter: 'any', count: ONE, oneOrMore: true, from: 'self' }];
	}
	const oneOrMoreTypedSelf = part.match(/^remove one or more (.+?) counters? from ~$/i);
	if (oneOrMoreTypedSelf) {
		const counter = lookupCounterWord(oneOrMoreTypedSelf[1]);
		return counter
			? [{ k: 'removeCounters', counter, count: ONE, oneOrMore: true, from: 'self' }]
			: null;
	}
	const anyNumAmong = part.match(
		/^remove any number of (?:(.+?) )?counters? from among (.+?) you control$/i
	);
	if (anyNumAmong) {
		const counter = anyNumAmong[1] ? lookupCounterWord(anyNumAmong[1]) : 'any';
		const filter = /^permanents$/i.test(anyNumAmong[2].trim())
			? {}
			: parseObjectPhrase(anyNumAmong[2], { allowPluralAndDisjunction: true });
		return counter && filter && !filter.controller
			? [
					{
						k: 'removeCounters',
						counter,
						count: { k: 'anyNumber' },
						from: { ...filter, controller: 'you' },
						among: true
					}
				]
			: null;
	}
	const oneOrMoreAmong = part.match(
		/^remove one or more (?:(.+?) )?counters? from among (.+?) you control$/i
	);
	if (oneOrMoreAmong) {
		const counter = oneOrMoreAmong[1] ? lookupCounterWord(oneOrMoreAmong[1]) : 'any';
		const filter = /^permanents$/i.test(oneOrMoreAmong[2].trim())
			? {}
			: parseObjectPhrase(oneOrMoreAmong[2], { allowPluralAndDisjunction: true });
		return counter && filter && !filter.controller
			? [
					{
						k: 'removeCounters',
						counter,
						count: ONE,
						oneOrMore: true,
						from: { ...filter, controller: 'you' },
						among: true
					}
				]
			: null;
	}
	// --- End Track P20b ---
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
		const filter = /^permanents$/i.test(anyAmong[2].trim())
			? {}
			: parseObjectPhrase(anyAmong[2], { allowPluralAndDisjunction: true });
		return n && filter && !filter.controller
			? [{ k: 'removeCounters', counter: 'any', count: n, from: { ...filter, controller: 'you' }, among: true }]
			: null;
	}
	const typedAmong = part.match(/^remove (\S+) (.+?) counters? from among (.+?) you control$/i);
	if (typedAmong) {
		const n = count(typedAmong[1]);
		const counter = lookupCounterWord(typedAmong[2]);
		const filter = /^permanents$/i.test(typedAmong[3].trim())
			? {}
			: parseObjectPhrase(typedAmong[3], { allowPluralAndDisjunction: true });
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

/** "Reveal a white card in/from your hand", "Reveal two red cards in/from your hand", "Reveal two cards from your hand that share a color". */
const revealFromHand: Production = (part) => {
	// --- Track P20b: "Reveal N [<phrase>] cards from your hand that share a color" ---
	const shareColorM = part.match(
		/^reveal (.+?) (?:in|from) your hand that share a color$/i
	);
	if (shareColorM) {
		const leadShare = parseLeadingCostCount(shareColorM[1], false);
		if (!leadShare) return null;
		const filterShare = /^cards?$/i.test(leadShare.phrase)
			? {}
			: parseObjectPhrase(leadShare.phrase);
		if (!filterShare) return null;
		return [
			{
				k: 'revealFromHand',
				count: leadShare.count,
				...(Object.keys(filterShare).length > 0 ? { filter: filterShare } : {}),
				shareColor: true
			}
		];
	}
	// --- End Track P20b ---
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

/** CR 701.4a–b: "Behold a Dragon", "Behold an Elemental", "Behold two Dragons", "Behold a Goblin and exile it". */
/** "Behold a Dragon", "Behold an Elemental and exile it" (CR 701.60a). */
const beholdCost: Production = (part) => {
	const m = part.match(/^behold\s+(?:a|an|one)\s+(.+?)(?:\s+and\s+exile\s+it)?$/i);
	if (!m) return null;
	const hasExile = /\s+and\s+exile\s+it$/i.test(part);
	const filter = parseObjectPhrase(m[1]);
	if (!filter || filter.controller) return null;
	return [{ k: 'behold', count: ONE, filter, ...(hasExile ? { exile: true } : {}) }];
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

// --- Track P17b: Forage, Collect Evidence, Blight, Reveal Hand, Opponent Gains Life, Bottom Tuck, Processors ---

/** CR 701.61a: "Forage" — exile three cards from your graveyard or sacrifice a Food (emits `Foraged`). */
const forageCost: Production = (part) =>
	/^forage$/i.test(part)
		? [
				{
					k: 'choice',
					forage: true,
					options: [
						[{ k: 'exileFrom', zone: 'graveyard', count: { k: 'const', n: 3 } }],
						[{ k: 'sacrifice', count: ONE, filter: { subtypes: ['Food'], controller: 'you' } }]
					]
				}
			]
		: null;

/** CR 701.59a: "Collect evidence N" — exile any number of cards from your graveyard with total mana value N or greater. */
const collectEvidenceCost: Production = (part) => {
	const m = part.match(/^collect evidence (\S+)$/i);
	if (!m) return null;
	const n = count(m[1]);
	if (!n || n.k !== 'const' || n.n < 0) return null;
	return [
		{
			k: 'exileFrom',
			zone: 'graveyard',
			count: { k: 'anyNumber' },
			minTotalManaValue: n.n,
			collectEvidence: true
		}
	];
};

/** CR 701.65a: "Blight N" — put N -1/-1 counters on a creature you control. */
const blightCost: Production = (part) => {
	const m = part.match(/^blight (\S+)$/i);
	if (!m) return null;
	const n = count(m[1]);
	if (!n || (n.k === 'const' && n.n < 1)) return null;
	return [
		{
			k: 'putCounters',
			count: n,
			counter: '-1/-1',
			on: { types: ['Creature'], controller: 'you' }
		}
	];
};

/** CR 701.20a: "Reveal your hand". */
const revealHandCost: Production = (part) =>
	/^reveal your hand$/i.test(part) ? [{ k: 'revealHand' }] : null;

/** CR 118.12: "Have an opponent gain N life" / "Have each other player gain N life". */
const opponentGainsLifeCost: Production = (part) => {
	const m = part.match(/^have (an opponent|each other player) gain (\S+) life$/i);
	if (!m) return null;
	const amt = count(m[2]);
	if (!amt) return null;
	const eachOther = m[1].toLowerCase() === 'each other player';
	return [
		{
			k: 'opponentGainsLife',
			amount: amt,
			...(eachOther ? { eachOtherPlayer: true } : {})
		}
	];
};

/** "Put ~ [from your graveyard] on the bottom of your/its owner's library", "Put N cards from your graveyard on the bottom of your library". */
const putOnBottomOfLibraryCost: Production = (part) => {
	const selfGy = part.match(
		/^put ~ from your graveyard on the bottom of (?:your|its owner's) library$/i
	);
	if (selfGy) {
		return [{ k: 'putOnBottomOfLibrary', from: 'graveyard', count: ONE, filter: 'self' }];
	}
	if (/^put ~ on the bottom of (?:your|its owner's) library$/i.test(part)) {
		return [{ k: 'putOnBottomOfLibrary', from: 'battlefield', count: ONE, filter: 'self' }];
	}
	const fromZone = part.match(
		/^put (.+?) from your (graveyard|hand) on the bottom of (?:your|its owner's|their owners') library$/i
	);
	if (fromZone) {
		const lead = parseLeadingCostCount(fromZone[1], true);
		if (!lead) return null;
		const zone = fromZone[2].toLowerCase() as 'graveyard' | 'hand';
		if (/^cards?$/i.test(lead.phrase)) {
			return [{ k: 'putOnBottomOfLibrary', from: zone, count: lead.count }];
		}
		if (!/\bcards?\b/i.test(lead.phrase)) return null;
		const filter = parseObjectPhrase(lead.phrase);
		if (!filter) return null;
		return [
			{
				k: 'putOnBottomOfLibrary',
				from: zone,
				count: lead.count,
				...(Object.keys(filter).length > 0 ? { filter } : {})
			}
		];
	}
	const bfCtrl = part.match(
		/^put (.+?) you control on the bottom of (?:its owner's|their owners'|your) library$/i
	);
	if (bfCtrl) {
		const lead = parseLeadingCostCount(bfCtrl[1], true);
		if (!lead || !lead.phrase) return null;
		const filter = parseObjectPhrase(lead.phrase);
		if (!filter || filter.controller) return null;
		return [
			{
				k: 'putOnBottomOfLibrary',
				from: 'battlefield',
				count: lead.count,
				filter: { ...filter, controller: 'you' }
			}
		];
	}
	return null;
};

/** Eldrazi Processor cost: "Put a card an opponent owns from exile into that player's graveyard". */
const processOpponentExileCost: Production = (part) => {
	const m = part.match(
		/^put (.+?) an opponent owns from exile into that player's graveyard$/i
	);
	if (!m) return null;
	const lead = parseLeadingCostCount(m[1], false);
	if (!lead) return null;
	if (/^cards?$/i.test(lead.phrase)) {
		return [{ k: 'processOpponentExile', count: lead.count }];
	}
	if (!/\bcards?\b/i.test(lead.phrase)) return null;
	const filter = parseObjectPhrase(lead.phrase);
	if (!filter) return null;
	return [
		{
			k: 'processOpponentExile',
			count: lead.count,
			...(Object.keys(filter).length > 0 ? { filter } : {})
		}
	];
};

/** Linked exile cost (CR 607.2a): "Put a [<phrase>] card exiled with ~ into its owner's graveyard". */
const putExiledWithSelfCost: Production = (part) => {
	const m = part.match(
		/^put (.+?) exiled with ~ into (?:its owner's|their owners') graveyards?$/i
	);
	if (!m) return null;
	const lead = parseLeadingCostCount(m[1], false);
	if (!lead) return null;
	if (/^cards?$/i.test(lead.phrase)) {
		return [{ k: 'putExiledWithSelfToGraveyard', count: lead.count }];
	}
	if (!/\bcards?\b/i.test(lead.phrase)) return null;
	const filter = parseObjectPhrase(lead.phrase);
	if (!filter) return null;
	return [
		{
			k: 'putExiledWithSelfToGraveyard',
			count: lead.count,
			...(Object.keys(filter).length > 0 ? { filter } : {})
		}
	];
};

// --- End Track P17b ---

// --- Track P20b: Unattach, Roll Die, & Flip Coin Cost Productions ---

/** CR 701.3d: "Unattach ~", "Unattach an Equipment from ~". */
const unattachCost: Production = (part) => {
	if (/^unattach ~$/i.test(part)) {
		return [{ k: 'unattachSelf' }];
	}
	const otherFromSelf = part.match(/^unattach (.+?) from ~$/i);
	if (otherFromSelf) {
		const lead = parseLeadingCostCount(otherFromSelf[1], false);
		if (!lead) return null;
		const filter = parseObjectPhrase(lead.phrase);
		if (!filter || filter.controller) return null;
		return [{ k: 'unattachOther', count: lead.count, filter, fromSelf: true }];
	}
	return null;
};

/** CR 706.2: "Roll a d8", "Roll a d20". */
const rollDieCost: Production = (part) => {
	const m = part.match(/^roll a d(\d+)$/i);
	if (!m) return null;
	const sides = parseInt(m[1], 10);
	return sides >= 2 ? [{ k: 'rollDie', sides }] : null;
};

/** CR 705.1: "Flip a coin". */
const flipCoinCost: Production = (part) =>
	/^flip a coin$/i.test(part) ? [{ k: 'flipCoin' }] : null;

// --- End Track P20b ---

const PRODUCTIONS: Production[] = [
	manaSymbols,
	payLife,
	payEnergy,
	payMana,
	waterbendCost,
	beholdCost,
	forageCost,
	collectEvidenceCost,
	blightCost,
	revealHandCost,
	opponentGainsLifeCost,
	putCountersCost,
	putOnTopOfLibraryCost,
	putOnBottomOfLibraryCost,
	processOpponentExileCost,
	putExiledWithSelfCost,
	unattachCost,
	rollDieCost,
	flipCoinCost,
	sacrifice,
	tapOthers,
	untapCost,
	discard,
	exileFrom,
	removeCounters,
	returnToHand,
	millCost,
	revealFromHand,
	exertSelf
];

const OR_BEFORE_VERB = new RegExp(`\\s+or\\s+(?=\\{|(?:${COST_VERBS})\\b)`, 'i');

function isDegenerateModifiedSacrificeChoice(options: CostDef[][]): boolean {
	if (options.length !== 2) return false;
	const [a, b] = options;
	if (a.length !== 1 || b.length !== 1) return false;
	const da = a[0];
	const db = b[0];
	if (da.k !== 'sacrifice' || db.k !== 'sacrifice') return false;
	if (da.filter === 'self' || db.filter === 'self') return false;
	const fa = da.filter;
	const fb = db.filter;
	if ((fa.modified === true) === (fb.modified === true)) return false;
	const stripMod = (f: ObjectFilter): string => {
		const copy = { ...f };
		delete copy.modified;
		return JSON.stringify(copy);
	};
	return JSON.stringify(da.count) === JSON.stringify(db.count) && stripMod(fa) === stripMod(fb);
}

function parsePart(text: string): CostDef[] | null {
	const out = PRODUCTIONS.reduce<CostDef[] | null>((acc, p) => acc ?? p(text), null);
	if (out) return out;
	// A choice between costs: "sacrifice a creature or pay {3}{B}", "discard a card or pay 3 life".
	// An "or" inside an object phrase ("an artifact or creature") isn't followed by a cost verb.
	const alts = text.split(new RegExp(OR_BEFORE_VERB.source, 'gi'));
	if (alts.length < 2) return null;
	const options = alts.map((a) => parsePart(a.trim()));
	if (options.some((o) => !o)) return null;
	if (isDegenerateModifiedSacrificeChoice(options as CostDef[][])) return null;
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
		const hasSelfRefPart =
			defs.length > 0 &&
			defs.some(
				(d) =>
					d.k === 'tapSelf' ||
					d.k === 'untapSelf' ||
					(d.k === 'removeCounters' && d.from === 'self') ||
					(d.k === 'putCounters' && d.on === 'self')
			);
		if (/^sacrifice it$/i.test(part.text) && hasSelfRefPart) {
			defs.push({ k: 'sacrifice', count: ONE, filter: 'self' });
			continue;
		}
		// --- Track P20b: Compound pronoun followups ("behold a Goblin and exile it", "... and return it to its owner's hand", "... and exile it") ---
		if (/^exile it$/i.test(part.text) && defs.length > 0) {
			const prevDef = defs[defs.length - 1];
			if (prevDef.k === 'behold' && !prevDef.exile) {
				prevDef.exile = true;
				continue;
			}
			if (hasSelfRefPart) {
				defs.push({ k: 'exileFrom', zone: 'battlefield', count: ONE, filter: 'self' });
				continue;
			}
		}
		if (/^return it to its owner's hand$/i.test(part.text) && hasSelfRefPart) {
			defs.push({ k: 'returnToHand', count: ONE, filter: 'self' });
			continue;
		}
		// --- End Track P20b ---
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
		case 'revealHand':
		case 'opponentGainsLife':
		case 'processOpponentExile':
			return true;
		case 'sacrifice':
		case 'discard':
		case 'tapOthers':
		case 'untapOthers':
		case 'returnToHand':
		case 'revealFromHand':
		case 'putOnBottomOfLibrary':
			return def.filter !== 'self';
		case 'exileFrom':
			return (
				def.filter !== 'self' &&
				(def.zone === 'graveyard' ||
					def.zone === 'hand' ||
					def.zone === 'battlefield' ||
					def.zone === 'library')
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

function normalizeGerundCostPhrase(raw: string): string {
	return raw
		.trim()
		.replace(
			/(^|,\s*|\s+and\s+|\s+or\s+)(paying|sacrificing|discarding|exiling|removing|tapping|untapping|returning|revealing|milling|putting|foraging|blighting|waterbending|beholding)\b/gi,
			(_m, sep: string, verb: string) => {
				const v = verb.toLowerCase();
				const map: Record<string, string> = {
					paying: 'pay',
					sacrificing: 'sacrifice',
					discarding: 'discard',
					exiling: 'exile',
					removing: 'remove',
					tapping: 'tap',
					untapping: 'untap',
					returning: 'return',
					revealing: 'reveal',
					milling: 'mill',
					putting: 'put',
					foraging: 'forage',
					blighting: 'blight',
					waterbending: 'waterbend',
					beholding: 'behold'
				};
				return `${sep}${map[v] ?? verb}`;
			}
		);
}

function buildSelfAltCastStatic(costBodyRaw: string, condition?: Condition): StaticDef | null {
	const normalizedBody = normalizeGerundCostPhrase(costBodyRaw);
	const parsed = parseCost(normalizedBody);
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
	// --- Track P17b: Compound metrics, distinct graveyard/board metrics, turn-history & targeting metrics ---
	const andEach = metric.match(/^(.+?)\s+and\s+each\s+(.+)$/i);
	if (andEach) {
		const a1 = parseCostMetricAmount(andEach[1]);
		const a2 = parseCostMetricAmount(andEach[2]);
		if (a1 && a2) return { k: 'sum', args: [a1, a2] };
	}
	const exileAndGy = metric.match(/^(?:(.+?) )?cards? you own in exile and in your graveyard$/i);
	if (exileAndGy) {
		const f = exileAndGy[1]
			? parseObjectPhrase(`${exileAndGy[1].replace(/\s+and\s+/gi, ' or ')} card`)
			: {};
		if (f && !f.controller) {
			return {
				k: 'sum',
				args: [
					{ k: 'count', of: { ...f, zone: 'exile', owner: 'you' } },
					{ k: 'count', of: { ...f, zone: 'graveyard', owner: 'you' } }
				]
			};
		}
	}
	if (/^targets?$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'targetsCount' };
	}
	const targetMatches = metric.match(/^(.+?) (?:it targets|they target)$/i);
	if (targetMatches) {
		let rawT = targetMatches[1].trim();
		let ctrl: 'you' | 'opponent' | undefined;
		const oppCtrl = rawT.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
		if (oppCtrl) {
			ctrl = 'opponent';
			rawT = oppCtrl[1];
		}
		const tf = parseObjectPhrase(rawT.replace(/\s+and\s+/gi, ' or '));
		if (tf) {
			return {
				k: 'p17bMetric',
				metric: 'targetsMatchingCount',
				filter: { ...tf, ...(ctrl ? { controller: ctrl } : {}) }
			};
		}
	}
	if (/^colors? (?:of (?:that|the) creature(?: it targets)?|among its targets)$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'targetColorsCount' };
	}
	const tgtCounter = metric.match(
		/^(?:(.+?) )?counters? on (?:that|the targeted|the) (?:creature|permanent)(?: it targets)?$/i
	);
	if (tgtCounter) {
		if (!tgtCounter[1]) return { k: 'p17bMetric', metric: 'targetCounterCount', counter: 'any' };
		const c = lookupCounterWord(tgtCounter[1]);
		if (c) return { k: 'p17bMetric', metric: 'targetCounterCount', counter: c };
	}
	const diffMvGy = metric.match(/^different mana values? among (?:(.+?) )?cards in your graveyard$/i);
	if (diffMvGy) {
		const f = diffMvGy[1]
			? parseObjectPhrase(`${diffMvGy[1].replace(/\s+and\s+/gi, ' or ')} card`)
			: {};
		if (f && !f.controller) {
			return {
				k: 'p17bMetric',
				metric: 'distinctManaValuesInGraveyard',
				...(Object.keys(f).length > 0 ? { filter: f } : {})
			};
		}
	}
	if (/^creature types? among creatures you control$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'distinctCreatureTypesControlled' };
	}
	if (/^colors? among permanents you control$/i.test(metric)) {
		return { k: 'colorsAmongPermanents', player: { k: 'you' } };
	}
	const diffNamed = metric.match(/^differently named (.+?) you control$/i);
	if (diffNamed) {
		const f = /^permanents?$/i.test(diffNamed[1].trim())
			? {}
			: parseObjectPhrase(diffNamed[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) {
			return {
				k: 'p17bMetric',
				metric: 'distinctNamesControlled',
				...(Object.keys(f).length > 0 ? { filter: f } : {})
			};
		}
	}
	if (/^counters? among players and permanents$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'countersAmongPlayersAndPermanents' };
	}
	if (/^permanents? put into a graveyard from the battlefield this turn$/i.test(metric)) {
		return { k: 'gravestormCount' };
	}
	if (/^creatures? you attacked with this turn$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'creaturesAttackedWithThisTurn' };
	}
	if (/^creatures? that attacked this turn$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'creaturesAttackedTotalThisTurn' };
	}
	if (/^lands? your opponents control that could produce \{C\}$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'landsOpponentControlsProducingColorless' };
	}
	if (/^opponents? who (?:was|were) dealt damage this turn$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'opponentsDealtDamageThisTurn' };
	}
	if (/^cards? with the same name as (?:that|this) spell in your graveyard$/i.test(metric)) {
		return { k: 'p17bMetric', metric: 'sameNameInGraveyardAsSpell' };
	}
	const itsControllerCtrl = metric.match(/^(.+?) its controller controls$/i);
	if (itsControllerCtrl) {
		const f = parseObjectPhrase(itsControllerCtrl[1].replace(/\s+and\s+/gi, ' or '));
		if (f && !f.controller) {
			return { k: 'count', of: { ...f, controller: 'you', zone: 'battlefield' } };
		}
	}
	const ownInExile = metric.match(/^(?:(.+?) )?cards? you own in exile$/i);
	if (ownInExile) {
		const f = ownInExile[1]
			? parseObjectPhrase(`${ownInExile[1].replace(/\s+and\s+/gi, ' or ')} card`)
			: {};
		if (f && !f.controller) {
			return { k: 'count', of: { ...f, zone: 'exile', owner: 'you' } };
		}
	}
	// --- End Track P17b ---
	// --- Track P14 ---
	if (/^targets? beyond the first$/i.test(metric)) {
		return { k: 'targetsBeyondFirst' };
	}
	if (/^opponents? you have$/i.test(metric)) {
		return { k: 'opponentCount' };
	}
	// --- End Track P14 ---
	// --- Track P20b: Cost-paid count reductions ("card exiled this way", "creature/permanent sacrificed this way", "counter removed this way") ---
	if (/^(?:.+? )?cards? exiled this way$/i.test(metric)) {
		return { k: 'p20bCostPaidCount', kind: 'exiled' };
	}
	if (/^(?:creatures?|permanents?|artifacts?|lands?|nonland permanents?) sacrificed this way$/i.test(metric)) {
		return { k: 'p20bCostPaidCount', kind: 'sacrificed' };
	}
	if (/^(?:.+? )?counters? removed this way$/i.test(metric)) {
		return { k: 'p20bCostPaidCount', kind: 'removedCounters' };
	}
	// --- End Track P20b ---
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
	// --- Track P14 & P17b: "<noun> you control with ..." or combat/tap-qualified battlefield nouns ("attacking creature") ---
	const directCtrl = parseObjectPhrase(metric.replace(/\s+and\s+/gi, ' or '));
	if (directCtrl && directCtrl.controller) {
		return { k: 'count', of: { ...directCtrl, zone: 'battlefield' } };
	}
	if (
		directCtrl &&
		!directCtrl.controller &&
		!directCtrl.zone &&
		(directCtrl.attacking !== undefined ||
			directCtrl.blocking !== undefined ||
			directCtrl.attackingOrBlocking ||
			directCtrl.tapped !== undefined)
	) {
		return { k: 'count', of: { ...directCtrl, zone: 'battlefield' } };
	}
	// --- End Track P14 & P17b ---
	return null;
}

export function parseSelfCostCondition(condRaw: string): Condition | null {
	const c = condRaw.trim();
	// --- Track P17b: Specialized hand/starting-player/combat/bargain/stack-target conditions ---
	const onlyNamedHand = c.match(
		/^you have no other (.+?) cards in (?:your )?hand or if the only other (.+?) cards in your hand are named ~$/i
	);
	if (onlyNamedHand && onlyNamedHand[1].toLowerCase() === onlyNamedHand[2].toLowerCase()) {
		const f = parseObjectPhrase(`${onlyNamedHand[1]} card`);
		if (f && !f.controller) {
			return { k: 'p17bCondition', kind: 'onlyNamedOrNoMatchingInHand', filter: f };
		}
	}
	// --- Track P14: Compound AND/OR conditions, devotion, opponent life/comparison, spells cast ---
	if (/\s+or\s+/i.test(c)) {
		const orParts = c.split(/\s+or\s+(?:if\s+)?/i).map((p) => p.trim());
		if (
			orParts.length >= 2 &&
			orParts.every((p) => /^(?:you|an opponent|it|there|a |an |your |\d+|one|two|three|four)\b/i.test(p))
		) {
			const parsedOr = orParts.map((p) => parseSelfCostCondition(p));
			if (parsedOr.every((x): x is Condition => x !== null)) {
				return { k: 'or', of: parsedOr };
			}
		}
	}
	const youCtrlPair = c.match(/^you control (?:a|an) ([A-Za-z'-]+(?: [A-Za-z'-]+)*) and (?:a|an) ([A-Za-z'-]+(?: [A-Za-z'-]+)*)$/i);
	if (youCtrlPair) {
		const f1 = parseObjectPhrase(youCtrlPair[1]);
		const f2 = parseObjectPhrase(youCtrlPair[2]);
		if (f1 && !f1.controller && f2 && !f2.controller) {
			return {
				k: 'and',
				of: [
					{ k: 'compare', left: { k: 'count', of: { ...f1, controller: 'you', zone: 'battlefield' } }, op: '>=', right: ONE },
					{ k: 'compare', left: { k: 'count', of: { ...f2, controller: 'you', zone: 'battlefield' } }, op: '>=', right: ONE }
				]
			};
		}
	}
	if (/\s+and\s+/i.test(c)) {
		const rawParts = c.split(/\s+and\s+(?:if\s+)?/i).map((p) => p.trim());
		const subParts: string[] = [];
		for (const rp of rawParts) {
			if (
				subParts.length > 0 &&
				/^you control\b/i.test(subParts[subParts.length - 1]) &&
				/^(?:a|an)\s+[A-Za-z'-]+$/i.test(rp)
			) {
				subParts[subParts.length - 1] = `${subParts[subParts.length - 1]} and ${rp}`;
			} else {
				subParts.push(rp);
			}
		}
		if (subParts.length >= 2 && subParts.every((p) => /^(?:you|an opponent|it|there|a |an |your )\b/i.test(p))) {
			const parsedSubs = subParts.map((p) => parseSelfCostCondition(p));
			if (parsedSubs.every((x): x is Condition => x !== null)) {
				return { k: 'and', of: parsedSubs };
			}
		}
	}
	// --- Track P17b ---
	if (/^you weren't the starting player$/i.test(c)) {
		return { k: 'p17bCondition', kind: 'notStartingPlayer' };
	}
	if (/^an opponent gained life this turn$/i.test(c)) {
		return { k: 'p17bCondition', kind: 'opponentGainedLifeThisTurn' };
	}
	const oppCastAtLeast = c.match(/^an opponent cast (\S+) or more spells this turn$/i);
	if (oppCastAtLeast) {
		const min = count(oppCastAtLeast[1]);
		if (min && min.k === 'const') {
			return { k: 'p17bCondition', kind: 'opponentCastSpellsAtLeast', n: min.n };
		}
	}
	const oppAtLeastMore = c.match(/^an opponent controls at least (\S+) more (.+?) than you$/i);
	if (oppAtLeastMore) {
		const min = count(oppAtLeastMore[1]);
		const f = /^permanents?$/i.test(oppAtLeastMore[2].trim())
			? {}
			: parseObjectPhrase(oppAtLeastMore[2].replace(/\s+and\s+/gi, ' or '));
		if (min && min.k === 'const' && f && !f.controller) {
			return {
				k: 'p17bCondition',
				kind: 'opponentControlsAtLeastNMore',
				n: min.n,
				...(Object.keys(f).length > 0 ? { filter: f } : {})
			};
		}
	}
	const yourOppsCtrl = c.match(/^your opponents control (\S+)(?: or more)? (.+)$/i);
	if (yourOppsCtrl) {
		const min = count(yourOppsCtrl[1]);
		const f = parseObjectPhrase(yourOppsCtrl[2].replace(/\s+and\s+/gi, ' or '));
		if (min && f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, controller: 'opponent', zone: 'battlefield' } },
				op: '>=',
				right: min
			};
		}
	}
	const totalTgh = c.match(/^creatures you control have total toughness (\S+) or greater$/i);
	if (totalTgh) {
		const min = count(totalTgh[1]);
		if (min) {
			return {
				k: 'compare',
				left: {
					k: 'totalStatOf',
					stat: 'toughness',
					filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' }
				},
				op: '>=',
				right: min
			};
		}
	}
	const noHandTyped = c.match(
		/^(?:there are no|you have no) (.+?) cards in (?:your )?hand$/i
	);
	if (noHandTyped) {
		const f = parseObjectPhrase(`${noHandTyped[1].replace(/\s+and\s+/gi, ' or ')} card`);
		if (f && !f.controller) {
			return { k: 'p17bCondition', kind: 'noMatchingCardsInHand', filter: f };
		}
	}
	if (/^(?:it's|this spell is) bargained$/i.test(c)) {
		return { k: 'p17bCondition', kind: 'spellWasBargained' };
	}
	const gyAnywhereTurn = c.match(/^(\S+) or more cards were put into graveyards from anywhere this turn$/i);
	if (gyAnywhereTurn) {
		const cnt = count(gyAnywhereTurn[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'cardsPutIntoGraveyardFromAnywhereThisTurn', min: cnt.n, whose: 'any' };
		}
	}
	const atkExact = c.match(/^exactly (\S+) creatures? (?:is|are) attacking$/i);
	if (atkExact) {
		const cnt = count(atkExact[1]);
		if (cnt && cnt.k === 'const') {
			return { k: 'p17bCondition', kind: 'attackingCount', op: '==', n: cnt.n };
		}
	}
	const atkAtLeast = c.match(/^(\S+) or more (.+?) are attacking$/i);
	if (atkAtLeast) {
		const cnt = count(atkAtLeast[1]);
		const f = /^creatures$/i.test(atkAtLeast[2].trim())
			? undefined
			: parseObjectPhrase(atkAtLeast[2]);
		if (cnt && cnt.k === 'const' && (f === undefined || (f !== null && !f.controller))) {
			return {
				k: 'p17bCondition',
				kind: 'attackingCount',
				op: '>=',
				n: cnt.n,
				...(f ? { filter: f } : {})
			};
		}
	}
	const atkYou = c.match(/^(?:a|an) (.+?) is attacking you$/i);
	if (atkYou) {
		const f = /^creature$/i.test(atkYou[1].trim()) ? undefined : parseObjectPhrase(atkYou[1]);
		if (f === undefined || (f !== null && !f.controller)) {
			return {
				k: 'p17bCondition',
				kind: 'attackingYouCount',
				op: '>=',
				n: 1,
				...(f ? { filter: f } : {})
			};
		}
	}
	const atkOne = c.match(/^(?:a|an) (.+?) is attacking$/i);
	if (atkOne) {
		const f = /^creature$/i.test(atkOne[1].trim()) ? undefined : parseObjectPhrase(atkOne[1]);
		if (f === undefined || (f !== null && !f.controller)) {
			return {
				k: 'p17bCondition',
				kind: 'attackingCount',
				op: '>=',
				n: 1,
				...(f ? { filter: f } : {})
			};
		}
	}
	const targetsStackSpell = c.match(/^it targets (?:a|an) (?:(.+?) )?spell(?: (you|an opponent) controls?)?$/i);
	if (targetsStackSpell) {
		const sf = targetsStackSpell[1] ? parseSpellFilterPhrase(targetsStackSpell[1]) : { filter: {}, other: false };
		if (sf && !sf.other) {
			const ctrl =
				targetsStackSpell[2]?.toLowerCase() === 'you'
					? 'you'
					: targetsStackSpell[2]?.toLowerCase() === 'an opponent'
						? 'opponent'
						: undefined;
			return {
				k: 'p17bCondition',
				kind: 'targetsStackSpell',
				filter: { ...sf.filter, ...(ctrl ? { controller: ctrl } : {}) }
			};
		}
	}
	// --- End Track P17b ---
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
	const youCastOne = c.match(/^you(?:'ve)? cast (?:a|an|another) (.+?) spell this turn$/i);
	if (youCastOne) {
		const sf = parseSpellFilterPhrase(youCastOne[1]);
		if (sf && !sf.other) {
			return {
				k: 'spellsCastThisTurnCount',
				min: 1,
				...(Object.keys(sf.filter).length > 0 ? { filter: sf.filter } : {})
			};
		}
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
	// --- Track P20b: Zendikar Trap conditions, Blasphemous Edict, & Mastery/Additional cost checks ---
	const thereAreBf = c.match(/^there are (\S+) or more (.+?) on the battlefield$/i);
	if (thereAreBf) {
		const min = count(thereAreBf[1]);
		const f = /^permanents?$/i.test(thereAreBf[2].trim())
			? {}
			: parseObjectPhrase(thereAreBf[2].replace(/\s+and\s+/gi, ' or '));
		if (min && f && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield' } },
				op: '>=',
				right: min
			};
		}
	}
	const oppPermEntered = c.match(
		/^an opponent had (?:(a|an)|(\S+) or more) (.+?) enter(?: the battlefield)? under their control this turn$/i
	);
	if (oppPermEntered) {
		const minCnt = oppPermEntered[1] ? ONE : count(oppPermEntered[2]);
		const f = /^permanents?$/i.test(oppPermEntered[3].trim())
			? {}
			: parseObjectPhrase(oppPermEntered[3].replace(/\s+and\s+/gi, ' or '));
		if (minCnt && minCnt.k === 'const' && f && !f.controller) {
			return {
				k: 'p20bCondition',
				kind: 'opponentHadPermEnteredThisTurn',
				min: minCnt.n,
				...(Object.keys(f).length > 0 ? { filter: f } : {})
			};
		}
	}
	const oppCastTyped = c.match(
		/^an opponent cast (?:(a|an)|(\S+) or more) (.+?) spells? this turn$/i
	);
	if (oppCastTyped) {
		const minCnt = oppCastTyped[1] ? ONE : count(oppCastTyped[2]);
		const sf = parseSpellFilterPhrase(oppCastTyped[3]);
		if (minCnt && minCnt.k === 'const' && sf && !sf.other) {
			return {
				k: 'p20bCondition',
				kind: 'opponentCastSpellThisTurn',
				min: minCnt.n,
				...(Object.keys(sf.filter).length > 0 ? { filter: sf.filter } : {})
			};
		}
	}
	const oppDrewCnt = c.match(/^an opponent drew (\S+) or more cards this turn$/i);
	if (oppDrewCnt) {
		const minCnt = count(oppDrewCnt[1]);
		if (minCnt && minCnt.k === 'const') {
			return { k: 'p20bCondition', kind: 'opponentDrewCardsAtLeastThisTurn', min: minCnt.n };
		}
	}
	const oppGyTurnCnt = c.match(
		/^an opponent had (\S+) or more cards put into their graveyard from anywhere this turn$/i
	);
	if (oppGyTurnCnt) {
		const minCnt = count(oppGyTurnCnt[1]);
		if (minCnt && minCnt.k === 'const') {
			return {
				k: 'p20bCondition',
				kind: 'opponentCardsPutIntoGraveyardAtLeastThisTurn',
				min: minCnt.n
			};
		}
	}
	if (/^an opponent searched their library this turn$/i.test(c)) {
		return { k: 'p20bCondition', kind: 'opponentSearchedLibraryThisTurn' };
	}
	if (
		/^a creature spell you cast this turn was countered by a spell or ability an opponent controlled$/i.test(
			c
		)
	) {
		return { k: 'p20bCondition', kind: 'yourCreatureSpellCounteredByOpponentThisTurn' };
	}
	if (
		/^a noncreature permanent you controlled was destroyed this turn by a spell or ability an opponent controlled$/i.test(
			c
		)
	) {
		return { k: 'p20bCondition', kind: 'yourNoncreatureDestroyedByOpponentThisTurn' };
	}
	if (/^a creature dealt damage to you this turn$/i.test(c)) {
		return { k: 'p20bCondition', kind: 'dealtDamageByCreaturesAtLeastThisTurn', min: 1 };
	}
	const dealtByCreatures = c.match(
		/^you(?:'ve)? been dealt damage by (\S+) or more creatures this turn$/i
	);
	if (dealtByCreatures) {
		const minCnt = count(dealtByCreatures[1]);
		if (minCnt && minCnt.k === 'const') {
			return {
				k: 'p20bCondition',
				kind: 'dealtDamageByCreaturesAtLeastThisTurn',
				min: minCnt.n
			};
		}
	}
	const altManaPaidM = c.match(/^the ((?:\{[^}]+\})+) cost was paid$/i);
	if (altManaPaidM) {
		return {
			k: 'p20bCondition',
			kind: 'altCostPaid',
			manaCost: altManaPaidM[1].replace(/\s+/g, '')
		};
	}
	if (/^(?:~'s|this spell's|the) additional cost was paid$/i.test(c)) {
		return { k: 'p20bCondition', kind: 'additionalCostPaid' };
	}
	// --- End Track P20b ---
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
	// "creature spells with flying" / "non-Lemur creature spell with flying" -> "creature with flying"
	phrase = phrase.replace(/\bspells?\s+(with\b|without\b|that\b)/gi, '$1');
	phrase = phrase.replace(/\bspells?$/i, '').trim();
	if (!phrase) return { filter: {}, other };
	// "Elemental spells and Warrior spells" -> "Elemental or Warrior"
	phrase = phrase.replace(/\bspells\s+and\s+/gi, 'or ');
	// Split trailing "with/without/that ..." before converting "Instant and sorcery" -> "Instant or sorcery"
	const withSplit = phrase.match(/^(.+?)\s+((?:with|without|that)\s+.+)$/i);
	const headPart = (withSplit ? withSplit[1] : phrase).replace(/\s+and\s+/gi, ' or ').trim();
	const tailPart = withSplit ? ` ${withSplit[2]}` : '';
	if (/^nonpermanents?$/i.test(headPart)) {
		const f = parseObjectPhrase(`instant or sorcery card${tailPart}`);
		if (!f || f.controller || f.other) return null;
		return { filter: f, other };
	}
	const isPermHead = /(?:^|\s)permanents?$/i.test(headPart) && !/\bnonpermanents?$/i.test(headPart);
	const normalizedPhrase = `${headPart}${tailPart}`;
	const baseFilter: ObjectFilter | null =
		parseObjectPhrase(normalizedPhrase) ?? parseObjectPhrase(`${headPart} card${tailPart}`);
	if (!baseFilter || baseFilter.controller || baseFilter.other) return null;
	if (isPermHead && !baseFilter.types && !baseFilter.allTypes) {
		baseFilter.types = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Planeswalker'];
	}
	return { filter: baseFilter, other };
}

function parseWhereXClauseAmount(xClauseRaw: string): Amount | null {
	const xClause = xClauseRaw.trim();
	const greatestMatch = xClause.match(
		/^the greatest (power|toughness|mana value) among (.+)$/i
	);
	if (greatestMatch) {
		const statKind = greatestMatch[1].toLowerCase();
		const stat = statKind === 'power' ? 'power' : statKind === 'toughness' ? 'toughness' : 'manaValue';
		const rawGroup = greatestMatch[2].trim();
		const trailingYouCtrl = rawGroup.match(/^(.+?)\s+you control$/i);
		const f = trailingYouCtrl
			? parseObjectPhrase(trailingYouCtrl[1].replace(/\s+and\s+/gi, ' or '))
			: parseObjectPhrase(rawGroup);
		if (f && (trailingYouCtrl ? !f.controller : f.controller === 'you')) {
			return { k: 'greatestStatAmong', stat, filter: { ...f, controller: 'you', zone: 'battlefield' } };
		}
	}
	const totalMatch = xClause.match(
		/^the total (power|toughness|mana value) of (.+)$/i
	);
	if (totalMatch) {
		const statKind = totalMatch[1].toLowerCase();
		const stat = statKind === 'power' ? 'power' : statKind === 'toughness' ? 'toughness' : 'manaValue';
		const rawGroup = totalMatch[2].trim();
		const trailingYouCtrl = rawGroup.match(/^(.+?)\s+you control$/i);
		const f = trailingYouCtrl
			? parseObjectPhrase(trailingYouCtrl[1].replace(/\s+and\s+/gi, ' or '))
			: parseObjectPhrase(rawGroup);
		if (f && (trailingYouCtrl ? !f.controller : f.controller === 'you')) {
			return { k: 'totalStatOf', stat, filter: { ...f, controller: 'you', zone: 'battlefield' } };
		}
	}
	const devMatch = xClause.match(/^your devotion to (.+)$/i);
	if (devMatch) {
		const cols = parseDevotionColorList(devMatch[1]);
		if (cols) return { k: 'devotion', colors: cols, player: { k: 'you' } };
	}
	if (/^your life total$/i.test(xClause)) {
		return { k: 'life', of: { k: 'you' } };
	}
	const selfStat = xClause.match(/^~'s (power|toughness|mana value)$/i);
	if (selfStat) {
		const sk = selfStat[1].toLowerCase();
		const stat = sk === 'power' ? 'power' : sk === 'toughness' ? 'toughness' : 'manaValue';
		return { k: 'stat', of: { k: 'self' }, stat };
	}
	if (/^the amount of life you(?:'ve)? gained this turn$/i.test(xClause)) {
		return { k: 'p17bMetric', metric: 'lifeGainedThisTurn' };
	}
	if (/^your speed$/i.test(xClause)) {
		return { k: 'playerSpeed', player: { k: 'you' } };
	}
	const numOf = xClause.match(/^the number of (.+)$/i);
	if (numOf) return parseCostMetricAmount(numOf[1]);
	return null;
}

function parseSpellTargetClauseFilter(rawTarget: string): ObjectFilter | null {
	const t = rawTarget.trim();
	if (t === '~') return { targetsSelf: true };
	if (/^(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(t)) {
		return { targetsAttached: true };
	}
	const youOr = t.match(/^you or (?:a|an) (.+?) you control$/i);
	if (youOr) {
		const f = /^permanent$/i.test(youOr[1].trim())
			? {}
			: parseObjectPhrase(youOr[1].replace(/\s+and\s+/gi, ' or '));
		if (!f || f.controller) return null;
		return { targetsYouOrFilter: { ...f, controller: 'you' } };
	}
	let innerTarget = t.replace(/^(?:one or more|a|an)\s+/i, '');
	let ctrl: 'you' | 'opponent' | undefined;
	const oppCtrl = innerTarget.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
	if (oppCtrl) {
		ctrl = 'opponent';
		innerTarget = oppCtrl[1];
	}
	const parsedTarget = /^permanents?$/i.test(innerTarget.trim())
		? {}
		: parseObjectPhrase(innerTarget.replace(/\s+and\s+/gi, ' or '));
	if (!parsedTarget) return null;
	return {
		targetsFilter: {
			...parsedTarget,
			...(ctrl ? { controller: ctrl } : {})
		}
	};
}

/**
 * Parses a static cost-modifying sentence into a `costModifier` StaticDef:
 * - "<object phrase> spells you cast cost {N}/{W} less/more to cast [for each ...]."
 * - "This spell/~ costs {N} less to cast [for each ... | if <condition>]."
 * - "Spells your opponents cast that target ~ / a <filter> you control cost {N} more to cast."
 * - "Activated abilities of <filter> cost {N} less/more to activate."
 * Returns null unless the whole sentence is understood. Input is normalised (`~`, no reminder text).
 */
// --- Track P20b: Helpers for mana-spend restrictions & non-legacy cast-payable additional costs ---
function parseSpendColorWords(raw: string): ManaColor[] | null {
	const parts = raw
		.trim()
		.toLowerCase()
		.split(/\s*(?:,\s*(?:and\/or|or|and)?|\band\/or\b|\bor\b|\band\b)\s*/)
		.filter(Boolean);
	if (parts.length === 0) return null;
	const out: ManaColor[] = [];
	for (const p of parts) {
		const c = COLORS[p];
		if (!c) return null;
		if (!out.includes(c)) out.push(c);
	}
	return out;
}

function isLegacyCardTsCastPayable(d: CostDef): boolean {
	switch (d.k) {
		case 'mana':
		case 'payLife':
		case 'payEnergy':
		case 'tapSubsetSum':
		case 'mill':
			return true;
		case 'sacrifice':
		case 'discard':
		case 'tapOthers':
		case 'returnToHand':
		case 'revealFromHand':
			return d.filter !== 'self';
		case 'exileFrom':
			return (
				d.filter !== 'self' &&
				(d.zone === 'graveyard' || d.zone === 'hand' || d.zone === 'battlefield')
			);
		case 'choice':
			return (
				d.options.length > 0 &&
				d.options.every((opt) => opt.length > 0 && opt.every(isLegacyCardTsCastPayable))
			);
		case 'optional':
			return d.cost.length > 0 && d.cost.every(isLegacyCardTsCastPayable);
		default:
			return false;
	}
}
// --- End Track P20b ---

export function parseCostModifierSentence(sentence: string): StaticDef | null {
	let text = sentence.trim().replace(/\.$/, '');
	// --- Track P20b: Strip optional leading ability word ("Strive — ...") ---
	if (/^[A-Za-z][A-Za-z' -]{0,24}\s*—\s*/.test(text) && !/^\{/.test(text)) {
		text = text.replace(/^[A-Za-z][A-Za-z' -]{0,24}\s*—\s*/, '').trim();
	}
	// --- End Track P20b ---
	if (/^it also costs\b/i.test(text)) {
		text = text.replace(/^it also costs\b/i, '~ costs');
	}
	let coloredOnly = false;
	let minTotalMana: number | undefined;
	let maxReduction: number | undefined;
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
			/^(.+?)\.\s*(?:this effect can't reduce the (?:amount of )?mana (?:in that cost|in that ability's activation cost|that ability costs to activate|(?:~|this spell|it) costs(?: to cast)?) to less than one mana|this cost can't be reduced to less than \{1\})$/i
		);
		if (floorClause) {
			minTotalMana = 1;
			text = floorClause[1].trim();
			continue;
		}
		const maxCapClause = text.match(
			/^(.+?)\.\s*this effect can't reduce the (?:amount of )?mana (?:~|this spell|it) costs(?: to cast)? by more than \{(\d+)\}$/i
		);
		if (maxCapClause) {
			maxReduction = parseInt(maxCapClause[2], 10);
			text = maxCapClause[1].trim();
			continue;
		}
		break;
	}

	const withFloorAndColored = (delta: CostDelta): CostDelta | null => {
		if ((coloredOnly || minTotalMana !== undefined || maxReduction !== undefined) && delta.mode !== 'reduce') {
			return null;
		}
		return {
			...delta,
			...(coloredOnly ? { coloredOnly: true } : {}),
			...(minTotalMana !== undefined ? { minTotalMana } : {}),
			...(maxReduction !== undefined ? { maxReduction } : {})
		};
	};

	const combineCond = (...conds: Array<Condition | undefined>): Condition | undefined => {
		const valid = conds.filter((c): c is Condition => c !== undefined);
		if (valid.length === 0) return undefined;
		return valid.length === 1 ? valid[0] : { k: 'and', of: valid };
	};

	if (/^if you control (?:a|your) commander, you may cast (?:this spell|~) without paying its mana cost$/i.test(text)) {
		if (coloredOnly || minTotalMana !== undefined || maxReduction !== undefined) return null;
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: { mode: 'setZero', generic: 0 },
			who: { relation: 'you' },
			condition: combineCond(turnPrefixCondition, { k: 'controlCommander' })
		};
	}

	// Stack-active spell target cost modifier ("As long as ~ is on the stack, spells [your opponents cast ]that target it/~ cost {N} more/less to cast")
	const stackTargetMod = text.match(
		/^as long as ~ is on the stack,\s*spells (?:(you|your opponents) cast )?that target (?:it|~) cost ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (stackTargetMod) {
		const rawDelta = parseCostManaDelta(
			stackTargetMod[2],
			stackTargetMod[3].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		const who =
			stackTargetMod[1]?.toLowerCase() === 'you'
				? 'you'
				: stackTargetMod[1]?.toLowerCase() === 'your opponents'
					? 'each_opponent'
					: 'each_player';
		return {
			k: 'costModifier',
			affects: { k: 'spell', filter: { targetsSelf: true } },
			delta,
			who: { relation: who },
			activeZones: ['stack'],
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// --- Track P14 & P17b: Deck copy limits, pitch/bounce/conditional/graveyard/external alt-cast permissions ---
	if (!coloredOnly && minTotalMana === undefined && maxReduction === undefined) {
		// --- Track P20b: Defiler cycle, manaSpendRestriction, firstActivationZeroCost, commanderTaxAsLife, combined pitch+reduction, & non-legacy additionalCastCost ---
		const defilerMatch = text.match(
			/^as an additional cost to cast (white|blue|black|red|green) permanent spells,\s*you may pay (\d+) life\.\s*those spells cost \{([WUBRG])\} less to cast if you paid life this way\.\s*this effect reduces only the amount of \1 mana you pay$/i
		);
		if (defilerMatch) {
			const wordCol = COLORS[defilerMatch[1].toLowerCase()];
			const lifeAmount = parseInt(defilerMatch[2], 10);
			const symCol = defilerMatch[3].toUpperCase() as ManaColor;
			if (wordCol && wordCol === symCol && lifeAmount >= 1) {
				return {
					k: 'defilerCostReduction',
					color: symCol,
					lifeAmount,
					filter: {
						colors: [symCol],
						types: ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Planeswalker']
					},
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		const combinedPitchRed = text.match(
			/^(as an additional cost to cast (?:~|this spell), .+?)\.\s*(?:~|this spell) costs ((?:\{[^}]+\})+) less to cast for each (.+)$/i
		);
		if (combinedPitchRed) {
			const addParsed = parseAdditionalCostSentence(combinedPitchRed[1], 0, false);
			const rawDelta = parseCostManaDelta(combinedPitchRed[2], 'reduce');
			const per = parseCostMetricAmount(combinedPitchRed[3]);
			if (
				addParsed &&
				addParsed.unparsed.length === 0 &&
				addParsed.defs.length > 0 &&
				rawDelta &&
				per
			) {
				return {
					k: 'costModifier',
					affects: { k: 'self' },
					delta: {
						...rawDelta,
						per,
						additionalCosts: addParsed.defs
					},
					who: { relation: 'you' },
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		if (/^as an additional cost to cast (?:~|this spell), /i.test(text)) {
			const addParsed = parseAdditionalCostSentence(text, 0, false);
			if (
				addParsed &&
				addParsed.unparsed.length === 0 &&
				addParsed.defs.length > 0 &&
				addParsed.defs.some((d) => !isLegacyCardTsCastPayable(d))
			) {
				return {
					k: 'additionalCastCost',
					costs: addParsed.defs,
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		const spendXColoredOnly = text.match(
			/^spend only colored mana on X(?:\.\s*(no more than one mana of each color may be spent this way))?$/i
		);
		if (spendXColoredOnly) {
			return {
				k: 'manaSpendRestriction',
				scope: 'selfBoth',
				xColoredOnly: true,
				...(spendXColoredOnly[1] ? { xMaxOnePerColor: true } : {}),
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}

		const spendXColors = text.match(/^spend only (.+?) mana on X$/i);
		if (spendXColors) {
			const cols = parseSpendColorWords(spendXColors[1]);
			if (cols) {
				return {
					k: 'manaSpendRestriction',
					scope: 'selfBoth',
					xColors: cols,
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		const spendSourceM = text.match(
			/^spend only mana produced by (creatures|basic lands|snow sources|Treasures|sources of the chosen color) to cast (?:~|this spell)(?:\s+this way)?$/i
		);
		if (spendSourceM) {
			const rawKind = spendSourceM[1].toLowerCase();
			const sourceKind: 'creature' | 'basicLand' | 'snow' | 'treasure' | 'chosenColor' =
				rawKind === 'creatures'
					? 'creature'
					: rawKind === 'basic lands'
						? 'basicLand'
						: rawKind === 'snow sources'
							? 'snow'
							: rawKind === 'treasures'
								? 'treasure'
								: 'chosenColor';
			return {
				k: 'manaSpendRestriction',
				scope: 'selfSpell',
				sourceKind,
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}

		const firstActZero = text.match(
			/^(during your turn,\s*)?you may pay \{0\} rather than pay the (equip|power-up|cycling) cost of the first (?:(equip|power-up) ability you activate|card you cycle) (?:each turn|during each of your turns)$/i
		);
		if (firstActZero) {
			const kw = firstActZero[2].toLowerCase() as 'equip' | 'power-up' | 'cycling';
			const kw2 = firstActZero[3]?.toLowerCase();
			const yourTurnSuffix = /during each of your turns$/i.test(text);
			if (!kw2 || kw === kw2) {
				return {
					k: 'firstActivationZeroCost',
					abilityKeyword: kw,
					...(firstActZero[1] || yourTurnSuffix ? { duringYourTurnOnly: true } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		const liesaMatch = text.match(
			/^rather than pay \{2\} for each previous time you've cast (?:~|this spell) from the command zone this game,\s*pay (\d+) life that many times$/i
		);
		if (liesaMatch) {
			const lifePerCast = parseInt(liesaMatch[1], 10);
			if (lifePerCast >= 1) {
				return {
					k: 'commanderTaxAsLife',
					lifePerCast,
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}
		// --- End Track P20b ---

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

		// "You may cast ~/this spell as though it had flash if you pay {N} more to cast it."
		const selfFlashMana = text.match(
			/^you may cast (?:~|this spell) as though it had flash if you pay ((?:\{[^}]+\})+) more to cast it$/i
		);
		if (selfFlashMana && parseCostManaDelta(selfFlashMana[1], 'increase')) {
			return {
				k: 'altCastPermission',
				affects: 'self',
				manaCost: selfFlashMana[1].replace(/\s+/g, ''),
				additionalOnly: true,
				grantFlash: true,
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}

		// "You may cast ~/this spell as though it had flash if you <cost> as an additional cost to cast it."
		const selfFlashAddCost = text.match(
			/^you may cast (?:~|this spell) as though it had flash if you (.+?) as an additional cost to cast it$/i
		);
		if (selfFlashAddCost) {
			const alt = buildSelfAltCastStatic(selfFlashAddCost[1], turnPrefixCondition);
			if (alt && alt.k === 'altCastPermission') {
				return {
					...alt,
					additionalOnly: true,
					grantFlash: true
				};
			}
		}

		// "You may <cost> rather than pay this spell's/~'s mana cost[ if <condition>]."
		const selfPitchAlt = text.match(
			/^you may (.+?) rather than pay (?:this spell's|~'s) mana cost(?:\s+if\s+(.+))?$/i
		);
		if (selfPitchAlt) {
			const trailingCond = selfPitchAlt[2] ? parseSelfCostCondition(selfPitchAlt[2]) : undefined;
			if (!selfPitchAlt[2] || trailingCond) {
				const alt = buildSelfAltCastStatic(
					selfPitchAlt[1],
					combineCond(turnPrefixCondition, trailingCond ?? undefined)
				);
				if (alt) return alt;
			}
		}

		// "If <condition>, you may <cost> rather than pay this spell's/~'s mana cost."
		const condPitchAlt = text.match(
			/^if (.+?),\s*you may (.+?) rather than pay (?:this spell's|~'s) mana cost$/i
		);
		if (condPitchAlt) {
			const cond = parseSelfCostCondition(condPitchAlt[1]);
			if (cond) {
				const alt = buildSelfAltCastStatic(condPitchAlt[2], combineCond(turnPrefixCondition, cond));
				if (alt) return alt;
			}
		}

		// "If <condition>, rather than pay this spell's/~'s mana cost, you may <cost>."
		const condRatherFirstAlt = text.match(
			/^if (.+?),\s*rather than pay (?:this spell's|~'s) mana cost,\s*you may (.+)$/i
		);
		if (condRatherFirstAlt) {
			const cond = parseSelfCostCondition(condRatherFirstAlt[1]);
			if (cond) {
				const alt = buildSelfAltCastStatic(condRatherFirstAlt[2], combineCond(turnPrefixCondition, cond));
				if (alt) return alt;
			}
		}

		// "If <condition>, you may cast this spell/~ without paying its mana cost[ and as though it had flash]."
		const condFreeAlt = text.match(
			/^if (.+?),\s*you may cast (?:this spell|~) without paying its mana cost( and as though it had flash)?$/i
		);
		if (condFreeAlt) {
			const cond = parseSelfCostCondition(condFreeAlt[1]);
			if (cond) {
				return {
					k: 'altCastPermission',
					affects: 'self',
					manaCost: '{0}',
					condition: combineCond(turnPrefixCondition, cond),
					...(condFreeAlt[2] ? { grantFlash: true } : {})
				};
			}
		}

		// "You may cast ~ from your graveyard by <cost> rather than paying its mana cost[. If you do, it enters with N <c> counters on it]."
		const selfGyAlt = text.match(
			/^you may cast ~ from your graveyard by (.+?) rather than paying its mana cost(?:\.\s*if you do, it enters with (\S+) (.+?) counters? on it)?$/i
		);
		if (selfGyAlt) {
			const alt = buildSelfAltCastStatic(selfGyAlt[1], turnPrefixCondition);
			if (alt && alt.k === 'altCastPermission') {
				let enterCounters: { counter: CounterType; count: number } | undefined;
				if (selfGyAlt[2] && selfGyAlt[3]) {
					const cnt = count(selfGyAlt[2]);
					const cType = lookupCounterWord(selfGyAlt[3]);
					if (!cnt || cnt.k !== 'const' || !cType) return null;
					enterCounters = { counter: cType, count: cnt.n };
				}
				return {
					...alt,
					allowedZones: ['graveyard'],
					...(enterCounters ? { enterCounters } : {})
				};
			}
		}

		// "You may cast ~ from your graveyard by <cost> in addition to paying its other costs[. If you do, it enters with N <c> counters on it]."
		const selfGyAdd = text.match(
			/^you may cast ~ from your graveyard by (.+?) in addition to (?:paying )?its other costs(?:\.\s*if you do, it enters with (\S+) (.+?) counters? on it)?$/i
		);
		if (selfGyAdd) {
			const alt = buildSelfAltCastStatic(selfGyAdd[1], turnPrefixCondition);
			if (alt && alt.k === 'altCastPermission') {
				let enterCounters: { counter: CounterType; count: number } | undefined;
				if (selfGyAdd[2] && selfGyAdd[3]) {
					const cnt = count(selfGyAdd[2]);
					const cType = lookupCounterWord(selfGyAdd[3]);
					if (!cnt || cnt.k !== 'const' || !cType) return null;
					enterCounters = { counter: cType, count: cnt.n };
				}
				return {
					...alt,
					allowedZones: ['graveyard'],
					additionalOnly: true,
					...(enterCounters ? { enterCounters } : {})
				};
			}
		}

		// "You may cast ~ from your graveyard if you pay {N} more to cast it[ for each <metric>]."
		const selfGyMoreMana = text.match(
			/^you may cast ~ from your graveyard if you pay ((?:\{[^}]+\})+) more to cast it(?: for each (.+))?$/i
		);
		if (selfGyMoreMana && parseCostManaDelta(selfGyMoreMana[1], 'increase')) {
			const per = selfGyMoreMana[2] ? parseCostMetricAmount(selfGyMoreMana[2]) : undefined;
			if (!selfGyMoreMana[2] || per) {
				return {
					k: 'altCastPermission',
					affects: 'self',
					allowedZones: ['graveyard'],
					manaCost: selfGyMoreMana[1].replace(/\s+/g, ''),
					additionalOnly: true,
					...(per ? { additionalPerMetric: per } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "Rather than pay the mana cost for a spell, its controller may discard a card that shares a color with that spell"
		if (
			/^rather than pay the mana cost for a spell, its controller may discard a card that shares a color with that spell$/i.test(
				text
			)
		) {
			return {
				k: 'altCastPermission',
				affects: { filter: {} },
				manaCost: '{0}',
				costDefs: [{ k: 'discard', count: ONE, filter: { sharesColorWithSpell: true } }],
				anyPlayer: true
			};
		}

		// External: "You may pay {X} rather than pay the mana cost for <phrase> spells you cast, where X is that spell's mana value"
		const mvAltCast = text.match(
			/^you may pay \{X\} rather than pay the mana cost for (.+?) spells you cast, where X is that spell's mana value$/i
		);
		if (mvAltCast) {
			const sp = parseSpellFilterPhrase(mvAltCast[1]);
			if (sp && !sp.other) {
				return {
					k: 'altCastPermission',
					affects: { filter: sp.filter },
					manaCost: '{0}',
					dynamicManaCostFromMV: true,
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "Any player may cast [<phrase>] spells [with mana value N or less] without paying their mana costs[ and as though they had flash]"
		const anyPlayerFree = text.match(
			/^any player may cast (?:(.+?) )?spells(?: with mana value (\S+) or (?:less|fewer))? without paying their mana costs( and as though they had flash)?$/i
		);
		if (anyPlayerFree) {
			const sp = anyPlayerFree[1] ? parseSpellFilterPhrase(anyPlayerFree[1]) : { filter: {}, other: false };
			const mvMax = anyPlayerFree[2] ? count(anyPlayerFree[2]) : undefined;
			if (sp && !sp.other && (!anyPlayerFree[2] || (mvMax && mvMax.k === 'const'))) {
				const aff: ObjectFilter = {
					...sp.filter,
					...(mvMax ? { manaValue: { op: '<=', value: mvMax } } : {})
				};
				return {
					k: 'altCastPermission',
					affects: { filter: aff },
					manaCost: '{0}',
					anyPlayer: true,
					...(anyPlayerFree[3] ? { grantFlash: true } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "You may cast [<phrase>] spells with mana value less than or equal to the number of <phrase> you control[ from your hand] without paying their mana costs"
		const extMvControlled = text.match(
			/^you may cast (?:(.+?) )?spells with mana value less than or equal to the number of (.+?) you control( from your hand)? without paying their mana costs$/i
		);
		if (extMvControlled) {
			const sp = extMvControlled[1] ? parseSpellFilterPhrase(extMvControlled[1]) : { filter: {}, other: false };
			const ctrlF = /^permanents?$/i.test(extMvControlled[2].trim())
				? {}
				: parseObjectPhrase(extMvControlled[2].replace(/\s+and\s+/gi, ' or '));
			if (sp && !sp.other && ctrlF && !ctrlF.controller) {
				return {
					k: 'altCastPermission',
					affects: { filter: sp.filter },
					manaCost: '{0}',
					maxManaValueByControlledCount: ctrlF,
					...(extMvControlled[3] ? { allowedZones: ['hand'] } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "[During your turn, ]You may cast [<phrase>] spells [with mana value N or less] [from your hand] without paying their mana costs"
		const extFreeCast = text.match(
			/^(during your turn,\s*)?you may cast (?:(.+?) )?spells(?: with mana value (\S+) or (?:less|fewer))?( from your hand)? without paying their mana costs$/i
		);
		if (extFreeCast) {
			const sp = extFreeCast[2] ? parseSpellFilterPhrase(extFreeCast[2]) : { filter: {}, other: false };
			const mvMax = extFreeCast[3] ? count(extFreeCast[3]) : undefined;
			if (sp && !sp.other && (!extFreeCast[3] || (mvMax && mvMax.k === 'const'))) {
				const aff: ObjectFilter = {
					...sp.filter,
					...(mvMax ? { manaValue: { op: '<=', value: mvMax } } : {})
				};
				return {
					k: 'altCastPermission',
					affects: { filter: aff },
					manaCost: '{0}',
					...(extFreeCast[4] ? { allowedZones: ['hand'] } : {}),
					...(extFreeCast[1] ? { duringYourTurnOnly: true } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "Once [during ]each [of your ]turn[s], you may cast a [<phrase>] spell [with mana value ...] [from your hand] without paying its mana cost"
		const onceTurnFree = text.match(
			/^once (?:during )?each (of your )?turns?,\s*you may cast (?:a|an) (?:(.+?) )?spell(?: with mana value (\S+) or (?:less|fewer))?( from your hand)? without paying its mana cost$/i
		);
		if (onceTurnFree) {
			const sp = onceTurnFree[2] ? parseSpellFilterPhrase(onceTurnFree[2]) : { filter: {}, other: false };
			const mvMax = onceTurnFree[3] ? count(onceTurnFree[3]) : undefined;
			if (sp && !sp.other && (!onceTurnFree[3] || (mvMax && mvMax.k === 'const'))) {
				const aff: ObjectFilter = {
					...sp.filter,
					...(mvMax ? { manaValue: { op: '<=', value: mvMax } } : {})
				};
				return {
					k: 'altCastPermission',
					affects: { filter: aff },
					manaCost: '{0}',
					onceEachTurn: true,
					...(onceTurnFree[1] ? { duringYourTurnOnly: true } : {}),
					...(onceTurnFree[4] ? { allowedZones: ['hand'] } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "Once [during ]each [of your ]turn[s], you may cast a [<phrase>] spell[ from your hand] by paying life equal to its mana value rather than paying its mana cost"
		const onceTurnPayLifeMv = text.match(
			/^once (?:during )?each (of your )?turns?,\s*you may cast (?:a|an) (?:(.+?) )?spell( from your hand)? by paying life equal to its mana value rather than paying its mana cost$/i
		);
		if (onceTurnPayLifeMv) {
			const sp = onceTurnPayLifeMv[2]
				? parseSpellFilterPhrase(onceTurnPayLifeMv[2])
				: { filter: {}, other: false };
			if (sp && !sp.other) {
				return {
					k: 'altCastPermission',
					affects: { filter: sp.filter },
					manaCost: '{0}',
					onceEachTurn: true,
					payLifeEqualToSpellMV: true,
					...(onceTurnPayLifeMv[1] ? { duringYourTurnOnly: true } : {}),
					...(onceTurnPayLifeMv[3] ? { allowedZones: ['hand'] } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "Once each turn, you may pay {0} rather than pay the mana cost for a [<phrase>] spell you cast [from your hand | from exile] [with mana value X or less, where X is the number of <c> counters on ~]"
		const onceTurnPayZero = text.match(
			/^once (?:during )?each (of your )?turns?,\s*you may pay \{0\} rather than pay the mana cost for (?:a|an) (?:(.+?) )?spell you cast( from your hand| from exile)?(?: with mana value X or less, where X is the number of (.+?) counters? on ~)?$/i
		);
		if (onceTurnPayZero) {
			const sp = onceTurnPayZero[2] ? parseSpellFilterPhrase(onceTurnPayZero[2]) : { filter: {}, other: false };
			const cType = onceTurnPayZero[4]
				? /^counters?$/i.test(onceTurnPayZero[4].trim())
					? 'any'
					: lookupCounterWord(onceTurnPayZero[4])
				: undefined;
			if (sp && !sp.other && (!onceTurnPayZero[4] || cType)) {
				const isFromExile = Boolean(onceTurnPayZero[3] && /exile/i.test(onceTurnPayZero[3]));
				const isFromHand = Boolean(onceTurnPayZero[3] && /hand/i.test(onceTurnPayZero[3]));
				return {
					k: 'altCastPermission',
					affects: { filter: sp.filter },
					manaCost: '{0}',
					onceEachTurn: true,
					...(onceTurnPayZero[1] ? { duringYourTurnOnly: true } : {}),
					...(isFromHand ? { allowedZones: ['hand'] } : {}),
					...(isFromExile ? { allowedZones: ['exile'], requireZonePermission: true } : {}),
					...(cType ? { maxManaValueBySelfCounters: cType } : {}),
					...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
				};
			}
		}

		// External: "You may cast [<phrase>] spells [with mana value N or less] by <cost> rather than paying their mana costs[. If you cast a spell this way, you may cast it as though it had flash]"
		const extByRather = text.match(
			/^you may cast (?:(.+?) )?spells(?: with mana value (\S+) or (?:less|fewer))? by (.+?) rather than paying their mana costs(?:\.\s*if you cast a spell this way, you may cast it as though it had flash)?$/i
		);
		if (extByRather) {
			const sp = extByRather[1] ? parseSpellFilterPhrase(extByRather[1]) : { filter: {}, other: false };
			const mvMax = extByRather[2] ? count(extByRather[2]) : undefined;
			const baseAlt = buildSelfAltCastStatic(extByRather[3], turnPrefixCondition);
			if (
				sp &&
				!sp.other &&
				baseAlt &&
				baseAlt.k === 'altCastPermission' &&
				(!extByRather[2] || (mvMax && mvMax.k === 'const'))
			) {
				const hasFlashFollowup = /as though it had flash$/i.test(text);
				return {
					...baseAlt,
					affects: {
						filter: {
							...sp.filter,
							...(mvMax ? { manaValue: { op: '<=', value: mvMax } } : {})
						}
					},
					...(hasFlashFollowup ? { grantFlash: true } : {})
				};
			}
		}

		// External: "[Once during each of your turns, | During your turn, ]You may cast [a ]<phrase> spell(s) from your graveyard by <cost> in addition to paying its/their other costs[. If you cast a spell this way, it enters with N <c> counters on it]"
		const extGyInAddition = text.match(
			/^(once (?:during )?each (of your )?turns?,\s*|during your turn,\s*)?you may cast (?:(?:a|an) )?(?:(.+?) )?spells? from your graveyard by (.+?) in addition to (?:paying )?(?:its|their) other costs(?:\.\s*if you cast a spell this way, (?:it|that [a-z]+) enters with (\S+) (.+?) counters? on it)?$/i
		);
		if (extGyInAddition) {
			const sp = extGyInAddition[3] ? parseSpellFilterPhrase(extGyInAddition[3]) : { filter: {}, other: false };
			const baseAlt = buildSelfAltCastStatic(extGyInAddition[4], turnPrefixCondition);
			if (sp && !sp.other && baseAlt && baseAlt.k === 'altCastPermission') {
				let enterCounters: { counter: CounterType; count: number } | undefined;
				if (extGyInAddition[5] && extGyInAddition[6]) {
					const cnt = count(extGyInAddition[5]);
					const cType = lookupCounterWord(extGyInAddition[6]);
					if (!cnt || cnt.k !== 'const' || !cType) return null;
					enterCounters = { counter: cType, count: cnt.n };
				}
				const isOnce = Boolean(extGyInAddition[1] && /^once\b/i.test(extGyInAddition[1]));
				const isDuringTurn =
					Boolean(extGyInAddition[2]) ||
					Boolean(extGyInAddition[1] && /^during your turn/i.test(extGyInAddition[1]));
				return {
					...baseAlt,
					affects: { filter: sp.filter },
					allowedZones: ['graveyard'],
					additionalOnly: true,
					...(isOnce ? { onceEachTurn: true } : {}),
					...(isDuringTurn ? { duringYourTurnOnly: true } : {}),
					...(enterCounters ? { enterCounters } : {})
				};
			}
		}

		// External: "You may <cost> rather than pay the mana cost for [<phrase>] spells [with mana value N or less] [that ]you cast[. If you cast a spell this way, you may cast it as though it had flash]"
		const extPayAlt = text.match(
			/^you may (.+?) rather than pay the mana cost for (?:(.+?) )?spells(?: with mana value (\S+) or (?:less|fewer))? (?:that )?you cast(?:\.\s*if you cast a spell this way, you may cast it as though it had flash)?$/i
		);
		if (extPayAlt) {
			const sp = extPayAlt[2] ? parseSpellFilterPhrase(extPayAlt[2]) : { filter: {}, other: false };
			const mvMax = extPayAlt[3] ? count(extPayAlt[3]) : undefined;
			const baseAlt = buildSelfAltCastStatic(extPayAlt[1], turnPrefixCondition);
			if (
				sp &&
				!sp.other &&
				baseAlt &&
				baseAlt.k === 'altCastPermission' &&
				(!extPayAlt[3] || (mvMax && mvMax.k === 'const'))
			) {
				const hasFlashFollowup = /as though it had flash$/i.test(text);
				return {
					...baseAlt,
					affects: {
						filter: {
							...sp.filter,
							...(mvMax ? { manaValue: { op: '<=', value: mvMax } } : {})
						}
					},
					...(hasFlashFollowup ? { grantFlash: true } : {})
				};
			}
		}
	}

	// "If your life total is less than your starting life total, ~ costs {X} less to cast, where X is the difference"
	if (
		/^if your life total is less than your starting life total, (?:this spell|~) costs \{X\} less to cast, where X is the difference$/i.test(
			text
		)
	) {
		const delta = withFloorAndColored({ mode: 'reduce', generic: 1 });
		if (!delta) return null;
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: { ...delta, per: { k: 'p17bMetric', metric: 'startingLifeDifference' } },
			who: { relation: 'you' },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// "{X} less/more to cast, where X is ..."
	const selfWhereX = text.match(
		/^(?:during your turn,\s*)?(?:this spell|~) costs \{X\} (less|more) to cast,\s*where X is (.+)$/i
	);
	if (selfWhereX) {
		const isDuringYourTurn = /^during your turn,/i.test(text);
		const mode = selfWhereX[1].toLowerCase() === 'less' ? 'reduce' : 'increase';
		const xAmt = parseWhereXClauseAmount(selfWhereX[2]);
		const delta = withFloorAndColored({ mode, generic: 1 });
		if (xAmt && delta) {
			const cond = combineCond(
				turnPrefixCondition,
				isDuringYourTurn ? { k: 'isTurnOf', player: { k: 'you' } } : undefined
			);
			return {
				k: 'costModifier',
				affects: { k: 'self' },
				delta: { ...delta, per: xAmt },
				who: { relation: 'you' },
				...(cond ? { condition: cond } : {})
			};
		}
	}

	// Battlefield spell "{X} less/more to cast, where X is ...":
	// "[<phrase> ]spells [with ...] you cast [with ...] cost {X} less/more to cast, where X is ..."
	const spellWhereX = text.match(
		/^(?:during your turn,\s*)?(?:(.+?) )?spells(?: (with .+?))? (you|your opponents) cast(?: (with .+?))? cost \{X\} (less|more) to cast,\s*where X is (.+)$/i
	);
	if (spellWhereX && !(spellWhereX[2] && spellWhereX[4])) {
		const isDuringYourTurn = /^during your turn,/i.test(text);
		const extraWith = spellWhereX[2] ?? spellWhereX[4];
		const rawSp =
			spellWhereX[1] || extraWith
				? `${spellWhereX[1] || 'card'}${extraWith ? ` ${extraWith}` : ''}`
				: '';
		const sp = rawSp ? parseSpellFilterPhrase(rawSp) : { filter: {}, other: false };
		const mode = spellWhereX[5].toLowerCase() === 'less' ? 'reduce' : 'increase';
		const xAmt = parseWhereXClauseAmount(spellWhereX[6]);
		const delta = withFloorAndColored({ mode, generic: 1 });
		if (sp && xAmt && delta) {
			const who = spellWhereX[3].toLowerCase() === 'you' ? 'you' : 'each_opponent';
			const cond = combineCond(
				turnPrefixCondition,
				isDuringYourTurn ? { k: 'isTurnOf', player: { k: 'you' } } : undefined
			);
			return {
				k: 'costModifier',
				affects: {
					k: 'spell',
					filter: { ...sp.filter, ...(sp.other ? { other: true } : {}) }
				},
				delta: { ...delta, per: xAmt },
				who: { relation: who },
				...(cond ? { condition: cond } : {})
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

	// "If <condition>, this spell/~ costs {N} less/more to cast[ for each <metric>]"
	const prefixIfSelf = text.match(
		/^if (.+?),\s*(?:this spell|~) costs ((?:\{[^}]+\})+) (less|more) to cast(?: for each (.+))?$/i
	);
	if (prefixIfSelf) {
		const cond = parseSelfCostCondition(prefixIfSelf[1]);
		const rawDelta = parseCostManaDelta(
			prefixIfSelf[2],
			prefixIfSelf[3].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const per = prefixIfSelf[4] ? parseCostMetricAmount(prefixIfSelf[4]) : undefined;
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (cond && delta && (!prefixIfSelf[4] || per)) {
			const fullCond = combineCond(turnPrefixCondition, cond)!;
			return {
				k: 'costModifier',
				affects: { k: 'self' },
				delta: { ...delta, ...(per ? { per } : {}) },
				who: { relation: 'you' },
				condition: fullCond
			};
		}
	}

	// "The first/second [<phrase>] spell [with ...] you cast [during ]each [of your ]turn[s] costs {N} less/more to cast"
	const nthSpellMod = text.match(
		/^(?:during your turn,\s*)?the (first|second) (?:(.+?) )?spell(?: (with .+?))? you cast (?:each turn|during each (of your )?turns?)(?: (with .+?))? costs ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (nthSpellMod && !(nthSpellMod[3] && nthSpellMod[5])) {
		const duringTurn = /^during your turn,/i.test(text) || Boolean(nthSpellMod[4]);
		const ordinal: 1 | 2 = nthSpellMod[1].toLowerCase() === 'first' ? 1 : 2;
		const extraWith = nthSpellMod[3] ?? nthSpellMod[5];
		const rawSp =
			nthSpellMod[2] || extraWith
				? `${nthSpellMod[2] || 'card'}${extraWith ? ` ${extraWith}` : ''}`
				: '';
		const sp = rawSp ? parseSpellFilterPhrase(rawSp) : { filter: {}, other: false };
		const rawDelta = parseCostManaDelta(
			nthSpellMod[6],
			nthSpellMod[7].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (sp && !sp.other && delta) {
			const hasFilter = Object.keys(sp.filter).length > 0;
			const nthCond: Condition = {
				k: 'nthMatchingSpellThisTurn',
				ordinal,
				...(hasFilter ? { filter: sp.filter } : {})
			};
			const fullCond = combineCond(
				turnPrefixCondition,
				duringTurn ? { k: 'isTurnOf', player: { k: 'you' } } : undefined,
				nthCond
			)!;
			return {
				k: 'costModifier',
				affects: { k: 'spell', filter: sp.filter },
				delta,
				who: { relation: 'you' },
				condition: fullCond
			};
		}
	}
	// --- End Track P14 ---

	// Self per-target life cost ("~ costs 3 life more to cast for each target")
	const selfPerTargetLife = text.match(
		/^(?:this spell|~) costs (\S+) life more to cast for each target$/i
	);
	if (selfPerTargetLife && !coloredOnly && minTotalMana === undefined && maxReduction === undefined) {
		const lifeAmt = count(selfPerTargetLife[1]);
		if (lifeAmt && lifeAmt.k === 'const' && lifeAmt.n >= 1) {
			return {
				k: 'costModifier',
				affects: { k: 'self' },
				delta: { mode: 'increase', generic: 0, perTargetLife: lifeAmt.n },
				who: { relation: 'you' },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// Self cost modifier with "for each <metric>" or "if <condition>" or unconditional ("during your turn, ~ costs ...").
	const selfTurnPrefix = text.match(/^during your turn,\s*((?:this spell|~) costs .+)$/i);
	const selfBody = selfTurnPrefix ? selfTurnPrefix[1] : text;
	const selfTimingCond = combineCond(
		turnPrefixCondition,
		selfTurnPrefix ? { k: 'isTurnOf', player: { k: 'you' } } : undefined
	);
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
			...(selfTimingCond ? { condition: selfTimingCond } : {})
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
		const fullCond = combineCond(selfTimingCond, cond)!;
		return {
			k: 'costModifier',
			affects: { k: 'self' },
			delta,
			who: { relation: 'you' },
			condition: fullCond
		};
	}

	if (selfTimingCond) {
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
				condition: selfTimingCond
			};
		}
	}

	// Targeting life tax ("Spells your opponents cast that target ~ cost an additional N life to cast").
	const targetLifeTax = text.match(
		/^Spells your opponents cast that target (~|(?:a|an) .+?) cost an additional (\d+) life to cast$/i
	);
	if (targetLifeTax && !coloredOnly && minTotalMana === undefined && maxReduction === undefined) {
		const tf = parseSpellTargetClauseFilter(targetLifeTax[1]);
		if (tf) {
			const life = parseInt(targetLifeTax[2], 10);
			return {
				k: 'costModifier',
				affects: { k: 'spell', filter: tf },
				delta: { mode: 'increase', generic: 0, additionalCosts: [{ k: 'payLife', amount: { k: 'const', n: life } }] },
				who: { relation: 'each_opponent' },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// Targeting mana cost modifier ("Spells [you/your opponents cast/control] that target ~ / enchanted creature / you or a <filter> you control / one or more <filter> you control cost {N} more/less to cast").
	const targetManaMod = text.match(
		/^(?:(.+?) )?spells(?: (you|your opponents) (?:cast|control))? that target (~|enchanted creature|equipped creature|you or (?:a|an) .+? you control|one or more .+?|(?:\ba\b|\ban\b) .+?) cost ((?:\{[^}]+\})+) (less|more) to cast$/i
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
		const rawDelta = parseCostManaDelta(
			targetManaMod[4],
			targetManaMod[5].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		const targetSpecFilter = parseSpellTargetClauseFilter(targetManaMod[3]);
		if (!targetSpecFilter) return null;
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
			who: { relation: who },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// --- Track P17b: Flashback/Dash alt-cost keyword modifiers, per-spell global/target modifiers ---
	const altKwMod = text.match(
		/^(flashback|dash) costs(?: (you|your opponents) pay)? cost ((?:\{[^}]+\})+) (less|more)$/i
	);
	if (altKwMod) {
		const altCostKeyword = altKwMod[1].toLowerCase() as 'flashback' | 'dash';
		const who =
			altKwMod[2]?.toLowerCase() === 'you'
				? 'you'
				: altKwMod[2]?.toLowerCase() === 'your opponents'
					? 'each_opponent'
					: 'each_player';
		const rawDelta = parseCostManaDelta(
			altKwMod[3],
			altKwMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		return {
			k: 'costModifier',
			affects: { k: 'spell', filter: {}, altCostKeyword },
			delta,
			who: { relation: who },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// "Each [<phrase>] spell [you/your opponents cast] costs {N} more/less to cast[ except during its controller's turn][ for each <metric>]"
	const eachSpellMod = text.match(
		/^each (?:(.+?) )?spell(?: (you|your opponents) cast)? costs ((?:\{[^}]+\})+) (less|more) to cast( except during its controller's turn)?(?: for each (.+))?$/i
	);
	if (eachSpellMod) {
		const sp = eachSpellMod[1] ? parseSpellFilterPhrase(eachSpellMod[1]) : { filter: {}, other: false };
		const rawDelta = parseCostManaDelta(
			eachSpellMod[3],
			eachSpellMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const per = eachSpellMod[6] ? parseCostMetricAmount(eachSpellMod[6]) : undefined;
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (sp && !sp.other && delta && (!eachSpellMod[6] || per)) {
			const who =
				eachSpellMod[2]?.toLowerCase() === 'you'
					? 'you'
					: eachSpellMod[2]?.toLowerCase() === 'your opponents'
						? 'each_opponent'
						: 'each_player';
			const cond = combineCond(
				turnPrefixCondition,
				eachSpellMod[5] ? { k: 'p17bCondition', kind: 'notSpellControllerTurn' } : undefined
			);
			return {
				k: 'costModifier',
				affects: { k: 'spell', filter: sp.filter },
				delta: { ...delta, ...(per ? { per } : {}) },
				who: { relation: who },
				...(cond ? { condition: cond } : {})
			};
		}
	}

	// "Each spell you cast that's <phrase> costs {N} less/more to cast"
	const eachSpellThats = text.match(
		/^each spell (you|your opponents) cast that's (.+?) costs ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (eachSpellThats) {
		const f = parseObjectPhrase(`${eachSpellThats[2]} card`);
		const rawDelta = parseCostManaDelta(
			eachSpellThats[3],
			eachSpellThats[4].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (f && !f.controller && delta) {
			const who = eachSpellThats[1].toLowerCase() === 'you' ? 'you' : 'each_opponent';
			return {
				k: 'costModifier',
				affects: { k: 'spell', filter: f },
				delta,
				who: { relation: who },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// "Spells with the chosen name cost {N} more/less to cast"
	const chosenNameSpellMod = text.match(
		/^spells with the chosen name cost ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (chosenNameSpellMod) {
		const rawDelta = parseCostManaDelta(
			chosenNameSpellMod[1],
			chosenNameSpellMod[2].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		return {
			k: 'costModifier',
			affects: { k: 'spell', filter: { ofChosenName: true } },
			delta,
			who: { relation: 'each_player' },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// "Spells you cast that share a card type with the exiled card cost {N} less/more to cast"
	const shareExiledMod = text.match(
		/^(?:(.+?) )?spells (you|your opponents) cast that share a card type with the exiled card cost ((?:\{[^}]+\})+) (less|more) to cast$/i
	);
	if (shareExiledMod) {
		const sp = shareExiledMod[1] ? parseSpellFilterPhrase(shareExiledMod[1]) : { filter: {}, other: false };
		const rawDelta = parseCostManaDelta(
			shareExiledMod[3],
			shareExiledMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (sp && delta) {
			const who = shareExiledMod[2].toLowerCase() === 'you' ? 'you' : 'each_opponent';
			return {
				k: 'costModifier',
				affects: {
					k: 'spell',
					filter: {
						...sp.filter,
						...(sp.other ? { other: true } : {}),
						sharesCardTypeWithExiled: true
					}
				},
				delta,
				who: { relation: who },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// Activated ability cost modifiers (Track P17b generalized):
	// 1. "Activated abilities cost {N} more/less to activate unless they're mana abilities"
	const globalNonManaAbil = text.match(
		/^activated abilities cost ((?:\{[^}]+\})+) (less|more) to activate unless they're mana abilities$/i
	);
	if (globalNonManaAbil) {
		const rawDelta = parseCostManaDelta(
			globalNonManaAbil[1],
			globalNonManaAbil[2].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		return {
			k: 'costModifier',
			affects: { k: 'ability', nonManaOnly: true },
			delta,
			who: { relation: 'each_player' },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// 2. "Loyalty abilities of planeswalkers [you/your opponents control] cost {N} more/less to activate"
	const loyaltyAbilMod = text.match(
		/^loyalty abilities of planeswalkers(?: (you|your opponents) control)? cost ((?:\{[^}]+\})+) (less|more) to activate$/i
	);
	if (loyaltyAbilMod) {
		const ctrl =
			loyaltyAbilMod[1]?.toLowerCase() === 'you'
				? 'you'
				: loyaltyAbilMod[1]?.toLowerCase() === 'your opponents'
					? 'opponent'
					: undefined;
		const who = ctrl === 'you' ? 'you' : ctrl === 'opponent' ? 'each_opponent' : 'each_player';
		const rawDelta = parseCostManaDelta(
			loyaltyAbilMod[2],
			loyaltyAbilMod[3].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		return {
			k: 'costModifier',
			affects: {
				k: 'ability',
				loyaltyOnly: true,
				filter: { types: ['Planeswalker'], ...(ctrl ? { controller: ctrl } : {}) }
			},
			delta,
			who: { relation: who },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// 3. "Enchanted/Equipped <phrase>'s activated abilities cost [up to] {N} less/more to activate"
	const attachedAbilMod = text.match(
		/^(?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)'s activated abilities cost (?:(up to) )?((?:\{[^}]+\})+) (less|more) to activate( unless they're mana abilities)?$/i
	);
	if (attachedAbilMod) {
		const mode = attachedAbilMod[3].toLowerCase() === 'less' ? 'reduce' : 'increase';
		if (attachedAbilMod[1] && mode !== 'reduce') return null;
		const rawDelta = parseCostManaDelta(attachedAbilMod[2], mode);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta || (attachedAbilMod[1] && delta.colored)) return null;
		return {
			k: 'costModifier',
			affects: {
				k: 'ability',
				attachedSourceOnly: true,
				...(attachedAbilMod[4] ? { nonManaOnly: true } : {})
			},
			delta,
			who: { relation: 'each_player' },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// 4. "[As long as <cond>, ]activated abilities of [<phrase> ]cards in your graveyard cost [up to] {N} less/more to activate"
	const gyAbilMod = text.match(
		/^(?:as long as (.+?),\s*)?activated abilities of (?:(.+?) )?cards in your graveyard cost (?:(up to) )?((?:\{[^}]+\})+) (less|more) to activate$/i
	);
	if (gyAbilMod) {
		const asLongCond = gyAbilMod[1] ? (parseSelfCostCondition(gyAbilMod[1]) ?? undefined) : undefined;
		if (gyAbilMod[1] && !asLongCond) return null;
		const f = gyAbilMod[2]
			? parseObjectPhrase(`${gyAbilMod[2].replace(/\s+and\s+/gi, ' or ')} card`)
			: {};
		const mode = gyAbilMod[5].toLowerCase() === 'less' ? 'reduce' : 'increase';
		if (gyAbilMod[3] && mode !== 'reduce') return null;
		const rawDelta = parseCostManaDelta(gyAbilMod[4], mode);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!f || f.controller || !delta || (gyAbilMod[3] && delta.colored)) return null;
		const fullCond = combineCond(turnPrefixCondition, asLongCond);
		return {
			k: 'costModifier',
			affects: {
				k: 'ability',
				sourceZone: 'graveyard',
				...(Object.keys(f).length > 0 ? { filter: f } : {})
			},
			delta,
			who: { relation: 'you' },
			...(fullCond ? { condition: fullCond } : {})
		};
	}

	// 5. "Activated abilities of sources with the chosen name cost {N} more/less to activate"
	const chosenNameAbilMod = text.match(
		/^activated abilities of sources with the chosen name cost ((?:\{[^}]+\})+) (less|more) to activate( unless they're mana abilities)?$/i
	);
	if (chosenNameAbilMod) {
		const rawDelta = parseCostManaDelta(
			chosenNameAbilMod[1],
			chosenNameAbilMod[2].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		return {
			k: 'costModifier',
			affects: {
				k: 'ability',
				filter: { ofChosenName: true },
				...(chosenNameAbilMod[3] ? { nonManaOnly: true } : {})
			},
			delta,
			who: { relation: 'each_player' },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// 6. "Activated abilities of <phrase> cost an additional \"<cost>\" to activate"
	const addCostAbilMod = text.match(
		/^activated abilities of (.+?) cost an additional ["“](.+?)["”] to activate$/i
	);
	if (addCostAbilMod && !coloredOnly && minTotalMana === undefined && maxReduction === undefined) {
		let rawSrc = addCostAbilMod[1].trim();
		let ctrl: 'you' | 'opponent' | undefined;
		const oppCtrl = rawSrc.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
		if (oppCtrl) {
			ctrl = 'opponent';
			rawSrc = oppCtrl[1];
		}
		const srcFilter = parseObjectPhrase(rawSrc.replace(/\s+and\s+/gi, ' or '));
		const parsedCost = parseCost(addCostAbilMod[2]);
		if (srcFilter && parsedCost.unparsed.length === 0 && parsedCost.defs.length > 0) {
			const finalFilter: ObjectFilter = { ...srcFilter, ...(ctrl ? { controller: ctrl } : {}) };
			const who =
				finalFilter.controller === 'you'
					? 'you'
					: finalFilter.controller === 'opponent'
						? 'each_opponent'
						: 'each_player';
			return {
				k: 'costModifier',
				affects: { k: 'ability', filter: finalFilter },
				delta: { mode: 'increase', generic: 0, additionalCosts: parsedCost.defs },
				who: { relation: who },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// 7. "Activated abilities of <phrase> cost {X} less/more to activate, where X is ..."
	const actAbilWhereX = text.match(
		/^activated abilities of (.+?) cost \{X\} (less|more) to activate,\s*where X is (.+)$/i
	);
	if (actAbilWhereX) {
		let rawTarget = actAbilWhereX[1].trim();
		let ctrl: 'you' | 'opponent' | undefined;
		const oppCtrl = rawTarget.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
		if (oppCtrl) {
			ctrl = 'opponent';
			rawTarget = oppCtrl[1];
		}
		const filter = parseObjectPhrase(rawTarget.replace(/\s+and\s+/gi, ' or '));
		const mode = actAbilWhereX[2].toLowerCase() === 'less' ? 'reduce' : 'increase';
		const xAmt = parseWhereXClauseAmount(actAbilWhereX[3]);
		const delta = withFloorAndColored({ mode, generic: 1 });
		if (filter && xAmt && delta) {
			const finalFilter: ObjectFilter = { ...filter, ...(ctrl ? { controller: ctrl } : {}) };
			return {
				k: 'costModifier',
				affects: { k: 'ability', filter: finalFilter },
				delta: { ...delta, per: xAmt },
				who: {
					relation:
						finalFilter.controller === 'you'
							? 'you'
							: finalFilter.controller === 'opponent'
								? 'each_opponent'
								: 'each_player'
				},
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
	}

	// 8. "~'s (equip|boast|exhaust|ninjutsu|power-up) ability/abilities cost(s) {N} less/more to activate [for each ... | if ...]"
	const selfKwAbilMod = text.match(
		/^~'s (equip|boast|exhaust|ninjutsu|power-up) abilit(?:y|ies) costs? (?:(up to) )?((?:\{[^}]+\})+) (less|more) to activate(?: (?:for each (.+)|if (.+)))?$/i
	);
	if (selfKwAbilMod) {
		const keyword = selfKwAbilMod[1].toLowerCase();
		const mode = selfKwAbilMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase';
		if (selfKwAbilMod[2] && mode !== 'reduce') return null;
		const rawDelta = parseCostManaDelta(selfKwAbilMod[3], mode);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta || (selfKwAbilMod[2] && delta.colored)) return null;
		const per = selfKwAbilMod[5] ? parseCostMetricAmount(selfKwAbilMod[5]) : undefined;
		if (selfKwAbilMod[5] && !per) return null;
		let ifCond: Condition | undefined;
		let targetsFilter: ObjectFilter | undefined;
		if (selfKwAbilMod[6]) {
			const ifTargetM = selfKwAbilMod[6].match(/^it targets (?:a|an) (.+)$/i);
			if (ifTargetM) {
				const tf = parseSpellTargetClauseFilter(`a ${ifTargetM[1]}`);
				if (!tf?.targetsFilter) return null;
				targetsFilter = tf.targetsFilter;
			} else {
				const parsedIf = parseSelfCostCondition(selfKwAbilMod[6]);
				if (!parsedIf) return null;
				ifCond = parsedIf;
			}
		}
		const fullCond = combineCond(turnPrefixCondition, ifCond);
		return {
			k: 'costModifier',
			affects: {
				k: 'ability',
				keyword,
				selfSourceOnly: true,
				...(targetsFilter ? { targetsFilter } : {})
			},
			delta: { ...delta, ...(per ? { per } : {}) },
			who: { relation: 'you' },
			...(fullCond ? { condition: fullCond } : {})
		};
	}

	// 9. "(Equip|Boast|Exhaust|Ninjutsu|Power-up) abilities [you/your opponents activate] [of <phrase>] [that target ...] cost [up to] {N} less/more to activate [for each ... | if ...]"
	const kwAbilMod = text.match(
		/^(equip|boast|exhaust|ninjutsu|power-up) abilities(?: (you|your opponents) activate)?(?: of (.+?))?(?: that target (~|enchanted creature|equipped creature|(?:a|an) .+?))? cost (?:(up to) )?((?:\{[^}]+\})+) (less|more) to activate(?: (?:for each (.+)|if (.+)))?$/i
	);
	if (kwAbilMod) {
		const keyword = kwAbilMod[1].toLowerCase();
		const mode = kwAbilMod[7].toLowerCase() === 'less' ? 'reduce' : 'increase';
		if (kwAbilMod[5] && mode !== 'reduce') return null;
		const rawDelta = parseCostManaDelta(kwAbilMod[6], mode);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta || (kwAbilMod[5] && delta.colored)) return null;

		let srcFilter: ObjectFilter | undefined;
		if (kwAbilMod[3]) {
			let rawOf = kwAbilMod[3].trim();
			let ctrl: 'you' | 'opponent' | undefined;
			const oppCtrl = rawOf.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
			if (oppCtrl) {
				ctrl = 'opponent';
				rawOf = oppCtrl[1];
			}
			const parsedOf = /^cards in your hand$/i.test(rawOf)
				? { zone: 'hand' as const, owner: 'you' as const }
				: parseObjectPhrase(rawOf.replace(/\s+and\s+/gi, ' or '));
			if (!parsedOf) return null;
			srcFilter = { ...parsedOf, ...(ctrl ? { controller: ctrl } : {}) };
		}

		let targetsSelf: boolean | undefined;
		let targetsAttached: boolean | undefined;
		let targetsFilter: ObjectFilter | undefined;
		if (kwAbilMod[4]) {
			const tf = parseSpellTargetClauseFilter(kwAbilMod[4]);
			if (!tf) return null;
			if (tf.targetsSelf) targetsSelf = true;
			else if (tf.targetsAttached) targetsAttached = true;
			else if (tf.targetsFilter) targetsFilter = tf.targetsFilter;
			else return null;
		}

		const per = kwAbilMod[8] ? parseCostMetricAmount(kwAbilMod[8]) : undefined;
		if (kwAbilMod[8] && !per) return null;
		const ifCond = kwAbilMod[9] ? (parseSelfCostCondition(kwAbilMod[9]) ?? undefined) : undefined;
		if (kwAbilMod[9] && !ifCond) return null;
		const fullCond = combineCond(turnPrefixCondition, ifCond);

		const who =
			kwAbilMod[2]?.toLowerCase() === 'you' || srcFilter?.controller === 'you' || srcFilter?.owner === 'you'
				? 'you'
				: kwAbilMod[2]?.toLowerCase() === 'your opponents' || srcFilter?.controller === 'opponent'
					? 'each_opponent'
					: 'each_player';

		return {
			k: 'costModifier',
			affects: {
				k: 'ability',
				keyword,
				...(srcFilter?.zone === 'hand' ? { sourceZone: 'hand' as const } : {}),
				...(srcFilter && srcFilter.zone !== 'hand' ? { filter: srcFilter } : {}),
				...(targetsSelf ? { targetsSelf: true } : {}),
				...(targetsAttached ? { targetsAttached: true } : {}),
				...(targetsFilter ? { targetsFilter } : {})
			},
			delta: { ...delta, ...(per ? { per } : {}) },
			who: { relation: who },
			...(fullCond ? { condition: fullCond } : {})
		};
	}

	// 10. "(Activated )?abilities [you/your opponents activate | of <phrase>] that target (~ | enchanted creature | a <phrase>) cost {N} less/more to activate"
	const targetAbilMod = text.match(
		/^(?:activated )?abilities(?: (you|your opponents) activate| of (.+?))? that target (~|enchanted creature|equipped creature|(?:a|an) .+?) cost ((?:\{[^}]+\})+) (less|more) to activate$/i
	);
	if (targetAbilMod) {
		const rawDelta = parseCostManaDelta(
			targetAbilMod[4],
			targetAbilMod[5].toLowerCase() === 'less' ? 'reduce' : 'increase'
		);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta) return null;
		let srcFilter: ObjectFilter | undefined;
		if (targetAbilMod[2]) {
			let rawOf = targetAbilMod[2].trim();
			let ctrl: 'you' | 'opponent' | undefined;
			const oppCtrl = rawOf.match(/^(.+?)\s+(?:an opponent controls|your opponents control)$/i);
			if (oppCtrl) {
				ctrl = 'opponent';
				rawOf = oppCtrl[1];
			}
			const f = parseObjectPhrase(rawOf.replace(/\s+and\s+/gi, ' or '));
			if (!f) return null;
			srcFilter = { ...f, ...(ctrl ? { controller: ctrl } : {}) };
		}
		const tf = parseSpellTargetClauseFilter(targetAbilMod[3]);
		if (!tf || (!tf.targetsSelf && !tf.targetsAttached && !tf.targetsFilter)) return null;
		const who =
			targetAbilMod[1]?.toLowerCase() === 'you' || srcFilter?.controller === 'you'
				? 'you'
				: targetAbilMod[1]?.toLowerCase() === 'your opponents' || srcFilter?.controller === 'opponent'
					? 'each_opponent'
					: 'each_player';
		return {
			k: 'costModifier',
			affects: {
				k: 'ability',
				...(srcFilter ? { filter: srcFilter } : {}),
				...(tf.targetsSelf ? { targetsSelf: true } : {}),
				...(tf.targetsAttached ? { targetsAttached: true } : {}),
				...(tf.targetsFilter ? { targetsFilter: tf.targetsFilter } : {})
			},
			delta,
			who: { relation: who },
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}

	// 11. "Activated abilities of <phrase> cost [up to] {N} less/more to activate [unless they're mana abilities] [for each <metric>]."
	const actAbilMod = text.match(
		/^activated abilities of (.+?) cost (?:(up to) )?((?:\{[^}]+\})+) (less|more) to activate( unless they're mana abilities)?(?: for each (.+))?$/i
	);
	if (actAbilMod) {
		const mode = actAbilMod[4].toLowerCase() === 'less' ? 'reduce' : 'increase';
		if (actAbilMod[2] && mode !== 'reduce') return null;
		const rawDelta = parseCostManaDelta(actAbilMod[3], mode);
		const delta = rawDelta && withFloorAndColored(rawDelta);
		if (!delta || (actAbilMod[2] && delta.colored)) return null;
		const per = actAbilMod[6] ? parseCostMetricAmount(actAbilMod[6]) : undefined;
		if (actAbilMod[6] && !per) return null;
		if (actAbilMod[1].trim() === '~') {
			return {
				k: 'costModifier',
				affects: {
					k: 'ability',
					selfSourceOnly: true,
					...(actAbilMod[5] ? { nonManaOnly: true } : {})
				},
				delta: { ...delta, ...(per ? { per } : {}) },
				who: { relation: 'you' },
				...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
			};
		}
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
			affects: {
				k: 'ability',
				filter: finalFilter,
				...(actAbilMod[5] ? { nonManaOnly: true } : {})
			},
			delta: { ...delta, ...(per ? { per } : {}) },
			who: {
				relation:
					finalFilter.controller === 'you'
						? 'you'
						: finalFilter.controller === 'opponent'
							? 'each_opponent'
							: 'each_player'
			},
			...(turnPrefixCondition ? { condition: turnPrefixCondition } : {})
		};
	}
	// --- End Track P17b ---

	const duringYourTurnGeneral = text.match(/^during your turn,\s*(.+)$/i);
	if (duringYourTurnGeneral && !turnPrefixCondition) {
		turnPrefixCondition = { k: 'isTurnOf', player: { k: 'you' } };
		text = duringYourTurnGeneral[1].trim();
	}

	// General spell cost modifiers:
	// "[As long as ~ is in the command zone or on the battlefield, ][<phrase> ]spells [with <keywords>] [of the chosen type/color] [you/your opponents cast] [with power/toughness/mana value ...] cost <mana> less/more to cast [for each <metric>]"
	const m = text.match(
		/^(as long as ~ is in the command zone or on the battlefield, )?(?:(.+?) )?spells(?: (with (?!power\b|toughness\b|mana value\b)[a-z ,]+|without [a-z ,/]+))?(?: of the chosen (type|color))?(?: (you|your opponents) cast)?(?: of the chosen (type|color))?(?: (with (?:power|toughness|mana value) (?:(?:greater|more|less|fewer) than \S+|\S+(?: or (?:greater|more|less|fewer))?)|with [a-z ,]+|without [a-z ,/]+))? cost ((?:\{[^}]+\})+) (less|more) to cast(?: for each (.+))?$/i
	);
	if (!m) return null;
	const chosenKindA = m[4]?.toLowerCase();
	const whoRaw = m[5]?.toLowerCase();
	const chosenKindB = m[6]?.toLowerCase();
	if (chosenKindA && chosenKindB && chosenKindA === chosenKindB) return null;
	if (m[3] && m[7]) return null;

	const postQual = m[3] ?? m[7];
	const rawSpellPhrase =
		m[2] || postQual ? `${m[2] || 'card'}${postQual ? ` ${postQual}` : ''}` : '';
	const parsedPhrase = parseSpellFilterPhrase(rawSpellPhrase);
	if (!parsedPhrase) return null;
	const { filter: baseFilter, other } = parsedPhrase;

	const rawDelta = parseCostManaDelta(m[8], m[9].toLowerCase() === 'less' ? 'reduce' : 'increase');
	const deltaBase = rawDelta && withFloorAndColored(rawDelta);
	if (!deltaBase) return null;

	let per: Amount | undefined;
	if (m[10]) {
		const parsedPer = parseCostMetricAmount(m[10]);
		if (!parsedPer) return null;
		per = parsedPer;
	}

	const filter: ObjectFilter = {
		...baseFilter,
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
