/**
 * Text normalisation (ENGINE_ARCHITECTURE_PLAN.md section 2.2).
 *
 * Strips reminder text, replaces self-references with `~` and splits a face's rules text into
 * lines and sentences with offsets into the normalised text. Spans in the IR point into that text.
 */
import type { Span } from '../ir.ts';

export interface NormalizedSentence {
	text: string;
	span: Span;
}

export interface NormalizedLine {
	/** Index of the line in the original rules text (split on newlines). */
	rawIndex: number;
	/** The original line, untouched. Legacy parsers need it because they match on the card's name. */
	raw: string;
	text: string;
	span: Span;
	/** Ability word such as "Landfall" (CR 207.2c). It has no rules meaning and is not parsed. */
	abilityWord?: string;
	/** The line without the ability word. */
	body: string;
	bodySpan: Span;
	sentences: NormalizedSentence[];
}

export interface NormalizedFace {
	text: string;
	lines: NormalizedLine[];
}

const SELF_REFERENCE_TYPES =
	'creature|permanent|spell|card|artifact|enchantment|land|equipment|aura|vehicle|mount|spacecraft|planet|planeswalker|battle|saga|class|case|siege|room|omen|token';
const SELF_REFERENCE = new RegExp(`\\bthis (?:${SELF_REFERENCE_TYPES})\\b`, 'gi');

/**
 * Genuine ability words (CR 207.2c). Explicit always-allow set in case an ability word collides
 * with a rules term.
 */
const ABILITY_WORDS: ReadonlySet<string> = new Set([
	'adamant',
	'addendum',
	'alliance',
	'battalion',
	'battlefront',
	'bloodrush',
	'celebration',
	'channel',
	'chroma',
	'cohort',
	'constellation',
	'converge',
	"council's dilemma",
	'coven',
	'delirium',
	'descend 4',
	'descend 8',
	'disappear',
	'domain',
	'eerie',
	'eminence',
	'enrage',
	'fateful hour',
	'fathomless descent',
	'federation',
	'ferocious',
	'flurry',
	'formidable',
	'grandeur',
	'hellbent',
	'heroic',
	'imprint',
	'infusion',
	'inspired',
	'join forces',
	'kinship',
	'landfall',
	'lieutenant',
	'magecraft',
	'metalcraft',
	'morbid',
	'opus',
	'pack tactics',
	'paradox',
	'parley',
	'radiance',
	'raid',
	'rally',
	'renew',
	'repartee',
	'revolt',
	'rulebreaker',
	'secret council',
	'seek out',
	'spell mastery',
	'strange new worlds',
	'strive',
	'survival',
	'sweep',
	'tempting offer',
	'threshold',
	'undergrowth',
	'valiant',
	'vivid',
	'void',
	'will of the council'
]);

/**
 * Keyword actions from `src/lib/rules.txt` section 701 (`701.2`–`701.66`).
 * A `"Word — "` prefix matching a rules term carries rules meaning and must NOT be stripped as a
 * CR 207.2c ability word or CR 207.2d flavor word.
 */
const RULES_SECTION_701_ACTIONS: readonly string[] = [
	'activate',
	'attach',
	'behold',
	'cast',
	'counter',
	'create',
	'destroy',
	'discard',
	'double',
	'triple',
	'exchange',
	'exile',
	'fight',
	'goad',
	'investigate',
	'mill',
	'play',
	'regenerate',
	'reveal',
	'sacrifice',
	'scry',
	'search',
	'shuffle',
	'surveil',
	'tap and untap',
	'tap',
	'untap',
	'transform',
	'convert',
	'fateseal',
	'clash',
	'planeswalk',
	'set in motion',
	'abandon',
	'proliferate',
	'detain',
	'populate',
	'monstrosity',
	'vote',
	'bolster',
	'manifest',
	'support',
	'meld',
	'exert',
	'explore',
	'assemble',
	'adapt',
	'amass',
	'learn',
	'venture into the dungeon',
	'connive',
	'open an attraction',
	'roll to visit your attractions',
	'incubate',
	'the ring tempts you',
	'face a villainous choice',
	'time travel',
	'discover',
	'cloak',
	'collect evidence',
	'suspect',
	'forage',
	'manifest dread',
	'endure',
	'harness',
	'airbend',
	'earthbend',
	'waterbend',
	'blight',
	'heal',
	'recruit',
	'empower jace',
	'assimilate'
];

/**
 * Keyword abilities and state/designation terms from `src/lib/rules.txt` section 702 (`702.2`–`702.196`).
 */
const RULES_SECTION_702_KEYWORDS: readonly string[] = [
	'deathtouch',
	'defender',
	'double strike',
	'enchant',
	'equip',
	'first strike',
	'flash',
	'flying',
	'haste',
	'hexproof',
	'indestructible',
	'intimidate',
	'landwalk',
	'lifelink',
	'protection',
	'reach',
	'shroud',
	'trample',
	'vigilance',
	'ward',
	'banding',
	'rampage',
	'cumulative upkeep',
	'flanking',
	'phasing',
	'buyback',
	'shadow',
	'cycling',
	'typecycling',
	'landcycling',
	'basic landcycling',
	'echo',
	'horsemanship',
	'fading',
	'kicker',
	'multikicker',
	'flashback',
	'madness',
	'fear',
	'morph',
	'megamorph',
	'amplify',
	'provoke',
	'storm',
	'affinity',
	'entwine',
	'modular',
	'sunburst',
	'bushido',
	'soulshift',
	'splice',
	'offering',
	'ninjutsu',
	'epic',
	'convoke',
	'dredge',
	'transmute',
	'bloodthirst',
	'haunt',
	'replicate',
	'forecast',
	'graft',
	'recover',
	'ripple',
	'split second',
	'suspend',
	'vanishing',
	'absorb',
	'aura swap',
	'delve',
	'fortify',
	'frenzy',
	'gravestorm',
	'poisonous',
	'transfigure',
	'champion',
	'changeling',
	'evoke',
	'hideaway',
	'prowl',
	'reinforce',
	'conspire',
	'persist',
	'wither',
	'retrace',
	'devour',
	'exalted',
	'unearth',
	'cascade',
	'annihilator',
	'level up',
	'rebound',
	'umbra armor',
	'totem armor',
	'infect',
	'battle cry',
	'living weapon',
	'undying',
	'miracle',
	'soulbond',
	'overload',
	'scavenge',
	'unleash',
	'cipher',
	'evolve',
	'extort',
	'fuse',
	'bestow',
	'tribute',
	'dethrone',
	'hidden agenda',
	'outlast',
	'prowess',
	'dash',
	'exploit',
	'menace',
	'renown',
	'awaken',
	'devoid',
	'ingest',
	'myriad',
	'surge',
	'skulk',
	'emerge',
	'escalate',
	'melee',
	'crew',
	'fabricate',
	'partner',
	'undaunted',
	'improvise',
	'aftermath',
	'embalm',
	'eternalize',
	'afflict',
	'ascend',
	'assist',
	'jump-start',
	'mentor',
	'afterlife',
	'riot',
	'spectacle',
	'escape',
	'companion',
	'mutate',
	'encore',
	'boast',
	'foretell',
	'demonstrate',
	'daybound and nightbound',
	'daybound',
	'nightbound',
	'disturb',
	'decayed',
	'cleave',
	'training',
	'compleated',
	'reconfigure',
	'blitz',
	'casualty',
	'enlist',
	'read ahead',
	'ravenous',
	'squad',
	'space sculptor',
	'visit',
	'prototype',
	'living metal',
	'more than meets the eye',
	'for mirrodin!',
	'toxic',
	'backup',
	'bargain',
	'craft',
	'disguise',
	'solved',
	'plot',
	'saddle',
	'spree',
	'freerunning',
	'gift',
	'offspring',
	'impending',
	'exhaust',
	'max speed',
	'start your engines!',
	'harmonize',
	'mobilize',
	'job select',
	'tiered',
	'station',
	'warp',
	'∞ (infinity)',
	'mayhem',
	'web-slinging',
	'firebending',
	'sneak',
	'increment',
	'paradigm',
	'power-up',
	'teamwork',
	'storied',
	'beam me up',
	'choose a background',
	"doctor's companion",
	'friends forever'
];

const RULES_TERM_BLOCKLIST: ReadonlySet<string> = new Set([
	...RULES_SECTION_701_ACTIONS,
	...RULES_SECTION_702_KEYWORDS
]);

/** Parameterized keyword prefixes that may appear with arguments before ` — `. */
const RULES_PARAM_PREFIXES: readonly string[] = [
	'boast',
	'exhaust',
	'power-up',
	'craft',
	'splice',
	'cleave',
	'reconfigure',
	'transfigure',
	'aura swap',
	'more than meets the eye',
	'partner',
	'saddle',
	'crew',
	'equip',
	'ward',
	'cycling',
	'typecycling',
	'landcycling',
	'basic landcycling',
	'cumulative upkeep',
	'echo',
	'fading',
	'vanishing',
	'suspend',
	'madness',
	'miracle',
	'overload',
	'flashback',
	'foretell',
	'plot',
	'disguise',
	'morph',
	'megamorph',
	'bestow',
	'dash',
	'blitz',
	'evoke',
	'mutate',
	'ninjutsu',
	'prowl',
	'spectacle',
	'surge',
	'freerunning',
	'gift',
	'impending',
	'offspring',
	'spree',
	'tiered',
	'warp',
	'web-slinging',
	'harmonize',
	'adapt',
	'monstrosity',
	'outlast',
	'scavenge',
	'unearth',
	'buyback',
	'escape',
	'embalm',
	'eternalize',
	'encore',
	'transmute',
	'forecast',
	'reinforce'
];

export function isAbilityOrFlavorWord(rawPrefix: string): boolean {
	const low = rawPrefix.toLowerCase().replace(/’/g, "'").trim();
	if (ABILITY_WORDS.has(low)) return true;
	// Protect Saga chapter prefixes ("I —", "I, II —", "III, IV —") from ability-word stripping.
	if (/^[ivx]+(?:\s*,\s*[ivx]+)*$/.test(low)) return false;
	if (RULES_TERM_BLOCKLIST.has(low)) return false;
	if (low.endsWith('cycling')) return false;
	for (const p of RULES_PARAM_PREFIXES) {
		if (low.startsWith(`${p} `) || low.startsWith(`${p}—`)) return false;
	}
	return true;
}

// "Landfall — Whenever ...", "Keen Sight — Whenever ...", "Channel — {2}{G}, Discard ~: ...".
// Also handles Unicode/digits/commas such as "Githyanki Crèche —", "Pavitr's Sevā —", "10,000 Needles —".
// Keyword costs use an unspaced dash ("Ward—Pay 3 life"), so a spaced em dash followed by a
// capital letter, bullet, or mana symbol marks a CR 207.2c ability-word or CR 207.2d flavor-word
// candidate unless the prefix is a rules term (CR 701/702) or Saga chapter numeral.
const ABILITY_WORD = /^([\p{Lu}0-9][\p{L}0-9'’!, -]*?) — (?=[\p{Lu}•{~])/u;

// Modal bullet flavor words: "• Feed — Target opponent...", "• ~ — You may cast..."
// Excludes Tiered double-dash ("• Blizzard — {0} — ..."), villainous choices, and {P} prefixes.
const BULLET_ABILITY_WORD =
	/^•\s+([\p{L}0-9~][\p{L}0-9'’!?,.~ -]*?) — (?!\{[^}]+\}\s*—)(?=[\p{Lu}0-9{~])/u;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NON_CHARACTER_LEGEND_FIRST_WORDS = new Set([
	'the',
	'lord',
	'lady',
	'king',
	'queen',
	'prince',
	'princess',
	'voice',
	'spirit',
	'avatar',
	'scion',
	'child',
	'son',
	'daughter',
	'champion',
	'patron',
	'warden',
	'keeper',
	'master',
	'guardian',
	'herald',
	'emissary',
	'archon',
	'angel',
	'demon',
	'dragon',
	'elder',
	'beast',
	'elemental',
	'knight',
	'soldier',
	'wizard',
	'god',
	'goddess',
	'bringer',
	'sliver',
	'flash',
	'space',
	'mutagen',
	'time',
	'blood',
	'fire',
	'ice',
	'soul',
	'mind',
	'hand',
	'land',
	'mana',
	'dark',
	'light',
	'shadow',
	'storm',
	'iron',
	'gold',
	'silver',
	'star',
	'sun',
	'moon',
	'night',
	'day',
	'death',
	'life',
	'war',
	'rage',
	'fury',
	'hope',
	'grace',
	'fate',
	'doom',
	'void',
	'chaos',
	'order',
	'wild',
	'true',
	'pure',
	'last',
	'first',
	'high',
	'great',
	'old',
	'new',
	'red',
	'blue',
	'black',
	'white',
	'green',
	'ancient',
	'eternal',
	'prime',
	'grand',
	'tiny',
	'giant',
	'little',
	'big',
	'young',
	'arch',
	'captain',
	'commander',
	'lieutenant',
	'ensign',
	'admiral',
	'general',
	'major',
	'colonel',
	'sergeant',
	'marshal',
	'minister',
	'senator',
	'mayor',
	'duke',
	'baron',
	'count',
	'earl',
	'doctor',
	'professor',
	'saint',
	'father',
	'mother',
	'brother',
	'sister',
	'uncle',
	'aunt'
]);

const CONNECTOR_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'from', 'da', 'de', 'von', 'van']);

const WORD_CHAR_RE = /^[\p{L}\p{N}_]$/u;
const NAMED_BEFORE_RE = /\bnamed\s+$/i;
const CREATE_BEFORE_RE = /\bcreate\s+$/i;
const TOKEN_NAME_POSSESSIVE_AFTER_RE = /^['’]s\s+[\p{Lu}][\p{L}'’-]*,\s*a\b/u;
const VERB_OR_POSS_AFTER_RE =
	/^(?:['’]s\b|\s+(?:enters|leaves|dies|attacks|blocks|becomes|is|deals|can't|can’t|gets|gains|has|loses|costs|remains|stays|transforms|flips)\b)/;
const LEAD_BEFORE_RE =
	/(?:^|\n|[.;:]\s*|\b(?:when|whenever|as|if|unless|until|while|exile|return|put|sacrifice|destroy|tap|untap|transform|flip|on|to|with|from)\s+)$/i;
const LEAD_AFTER_OK_RE =
	/^(?:[\s.,;:!?]|$)(?!\s+(?:token|tokens|card|cards|creature|creatures|spell|spells)\b)/;

function replaceNameOccurrences(text: string, sortedNames: string[], fullName: string): string {
	let out = text;
	for (const n of sortedNames) {
		if (!n || !out.includes(n)) continue;
		let pos = 0;
		let rebuilt = '';
		const checkNamed = n !== fullName;
		for (let guard = 0; guard < 200; guard++) {
			const idx = out.indexOf(n, pos);
			if (idx < 0) {
				rebuilt += out.slice(pos);
				break;
			}
			const before = idx > 0 ? out[idx - 1] : '';
			const afterIdx = idx + n.length;
			const after = afterIdx < out.length ? out[afterIdx] : '';
			const okLeft = !before || !WORD_CHAR_RE.test(before);
			const okRight = !after || !WORD_CHAR_RE.test(after);
			const prefixSlice = checkNamed ? out.slice(Math.max(0, idx - 16), idx) : '';
			const isNamed =
				checkNamed &&
				((idx >= 6 && NAMED_BEFORE_RE.test(prefixSlice)) ||
					(idx >= 7 &&
						CREATE_BEFORE_RE.test(prefixSlice) &&
						TOKEN_NAME_POSSESSIVE_AFTER_RE.test(out.slice(afterIdx, afterIdx + 48))));
			if (okLeft && okRight && !isNamed) {
				rebuilt += out.slice(pos, idx) + '~';
			} else {
				rebuilt += out.slice(pos, afterIdx);
			}
			pos = afterIdx;
		}
		out = rebuilt;
	}
	return out;
}

function addUniqueName(names: string[], candidate: string): void {
	if (candidate && !names.includes(candidate)) names.push(candidate);
}

function hasFallbackSelfContext(remaining: string, cand: string): boolean {
	if (!remaining.includes(cand)) return false;
	let pos = 0;
	for (let guard = 0; guard < 200; guard++) {
		const idx = remaining.indexOf(cand, pos);
		if (idx < 0) return false;
		const afterIdx = idx + cand.length;
		const before = idx > 0 ? remaining[idx - 1] : '';
		const okLeft = !before || !WORD_CHAR_RE.test(before);
		const isNamed =
			idx >= 6 && NAMED_BEFORE_RE.test(remaining.slice(Math.max(0, idx - 16), idx));
		if (okLeft && !isNamed) {
			const tail = remaining.slice(afterIdx, afterIdx + 48);
			const afterChar = afterIdx < remaining.length ? remaining[afterIdx] : '';
			if (!afterChar || !WORD_CHAR_RE.test(afterChar)) {
				if (VERB_OR_POSS_AFTER_RE.test(tail)) return true;
				const head = remaining.slice(Math.max(0, idx - 24), idx);
				if (LEAD_BEFORE_RE.test(head) && LEAD_AFTER_OK_RE.test(tail)) return true;
			}
		}
		pos = afterIdx;
	}
	return false;
}

function addCharacterLegendFallbackNames(
	names: string[],
	name: string,
	faceOracleText: string
): void {
	const stripped = stripReminderText(faceOracleText);
	const remaining = replaceNameOccurrences(
		stripped,
		[...names].sort((a, b) => b.length - a.length),
		name
	);

	const words = name.split(/\s+/);
	if (words.length < 2) return;
	const candidates: string[] = [];
	const w0 = words[0];
	const w1 = words[1];

	if (
		words.length >= 3 &&
		/^\p{Lu}[\p{L}'’-]{2,}$/u.test(w0) &&
		/^\p{Lu}[\p{L}'’-]{2,}$/u.test(w1) &&
		!CONNECTOR_WORDS.has(w0.toLowerCase()) &&
		!CONNECTOR_WORDS.has(w1.toLowerCase()) &&
		!NON_CHARACTER_LEGEND_FIRST_WORDS.has(w0.toLowerCase())
	) {
		candidates.push(`${w0} ${w1}`);
	}

	if (
		/^\p{Lu}[\p{L}'’-]{2,}$/u.test(w0) &&
		!w0.endsWith('.') &&
		!CONNECTOR_WORDS.has(w0.toLowerCase()) &&
		!NON_CHARACTER_LEGEND_FIRST_WORDS.has(w0.toLowerCase())
	) {
		candidates.push(w0);
	}

	for (const cand of candidates) {
		if (names.includes(cand)) continue;
		if (hasFallbackSelfContext(remaining, cand)) {
			addUniqueName(names, cand);
		}
	}
}

/** Names that refer to the card itself: the full name and, for "Name, Title" (or legendary character "Name the/of ..."), the short name. */
export function selfNames(
	name: string,
	isCharacterLegend = false,
	faceOracleText?: string
): string[] {
	const names = [name];
	const comma = name.indexOf(', ');
	if (comma > 0) addUniqueName(names, name.slice(0, comma));

	const nickTitle = name.match(
		/^([\p{Lu}][\p{L}.]+)\s+[\p{L}'’-]+\s+"[^"]+"\s+([\p{Lu}][\p{L}'’-]+)$/u
	);
	if (nickTitle) {
		addUniqueName(names, `${nickTitle[1]} ${nickTitle[2]}`);
	}

	if (isCharacterLegend) {
		const baseName = comma > 0 ? name.slice(0, comma) : name;
		const rankSurname = baseName.match(
			/^(Captain|Commander|Lieutenant|Ensign|Admiral|General|Major|Colonel|Sergeant|Dr\.|Professor)\s+(?:[\p{Lu}][\p{L}.'’-]*\s+)+([\p{Lu}][\p{L}'’-]{2,})$/u
		);
		if (rankSurname) {
			addUniqueName(names, `${rankSurname[1]} ${rankSurname[2]}`);
		}
	}

	if (isCharacterLegend && comma < 0) {
		const roman = name.match(
			/^([\p{Lu}][\p{L}'’-]{2,}(?:\s+[\p{Lu}][\p{L}'’-]{2,})*)\s+(?:II|III|IV|VI|VII|VIII|IX|XI|XII|XL|XLVIII|[IVX]{2,})$/u
		);
		if (roman && !NON_CHARACTER_LEGEND_FIRST_WORDS.has(roman[1].split(/\s+/)[0].toLowerCase())) {
			addUniqueName(names, roman[1]);
		}

		const epithet = name.match(
			/^([\p{Lu}][\p{L}'’-]{2,}(?:\s+[\p{Lu}][\p{L}'’-]{2,})?)\s+(?:the|of(?:\s+(?:the|a))?|and\s+the)\s+[\p{Lu}]/u
		);
		if (epithet) {
			const candidate = epithet[1];
			const words = candidate.split(/\s+/);
			const w0 = words[0].toLowerCase();
			if (!NON_CHARACTER_LEGEND_FIRST_WORDS.has(w0)) {
				addUniqueName(names, candidate);
			}
		}

		if (faceOracleText) {
			addCharacterLegendFallbackNames(names, name, faceOracleText);
		}
	}
	return names;
}

export function stripReminderText(line: string): string {
	return line.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

const SELF_OBJECT_HER_FOLLOW =
	'(?=$|[.,;:!?"”\'’)]|\\s+(?:to|into|onto|from|on|with|under|in|at|by|for|as|until|this|that|instead|transformed|tapped|untapped|flipped|face|deal|and|or|then|unless|if|when|whenever|where|first|second|third|fourth|fifth|alone)\\b)';

const SELF_POSSESSIVE_HER_NOUN =
	'(?=\\s+(?:name|owner(?:\'s|’s)?|controller(?:\'s|’s)?|base\\s+power|base\\s+toughness|power|toughness|mana\\s+value|additional\\s+cost|sneak\\s+cost|colors?|other\\s+types|types|abilities|loyalty)\\b)';

function preserveCaseIt(match: string, lowerReplacement: string): string {
	const first = match[0];
	if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
		return `${lowerReplacement[0].toUpperCase()}${lowerReplacement.slice(1)}`;
	}
	return lowerReplacement;
}

function normalizeSelfPronounsSegment(seg: string): string {
	return seg
		.replace(/\b(?:himself|herself)\b/gi, (m) => preserveCaseIt(m, 'itself'))
		.replace(/\b(?:he|she)(?:'s|’s)\b/gi, (m) => preserveCaseIt(m, "it's"))
		.replace(new RegExp(`\\bher\\b${SELF_POSSESSIVE_HER_NOUN}`, 'gi'), (m) => preserveCaseIt(m, 'its'))
		.replace(new RegExp(`\\bher\\b${SELF_OBJECT_HER_FOLLOW}`, 'gi'), (m) => preserveCaseIt(m, 'it'))
		.replace(/\bhis\b/gi, (m) => preserveCaseIt(m, 'its'))
		.replace(/\bhim\b/gi, (m) => preserveCaseIt(m, 'it'))
		.replace(/\b(?:he|she)\b/gi, (m) => preserveCaseIt(m, 'it'));
}

function normalizeSelfPronounsOutsideQuotes(text: string): string {
	if (!/\b(?:he|she|him|her|his|himself|herself)\b/i.test(text)) return text;
	// Only normalize self-pronouns outside double-quoted ability/speech text.
	const parts = text.split(/("[^"]*"|“[^”]*”)/g);
	for (let i = 0; i < parts.length; i += 2) {
		parts[i] = normalizeSelfPronounsSegment(parts[i]);
	}
	return parts.join('');
}

function replaceSelfReferencesWithNames(
	line: string,
	name: string,
	sortedNames: string[]
): string {
	let out = replaceNameOccurrences(line, sortedNames, name);
	out = out.replace(SELF_REFERENCE, '~');
	return normalizeSelfPronounsOutsideQuotes(out);
}

export function replaceSelfReferences(
	line: string,
	name: string,
	isCharacterLegend = false,
	faceOracleText?: string
): string {
	const sortedNames = selfNames(name, isCharacterLegend, faceOracleText).sort(
		(a, b) => b.length - a.length
	);
	return replaceSelfReferencesWithNames(line, name, sortedNames);
}

/** Splits on sentence-ending periods that are outside quotation marks. */
export function splitSentences(text: string, offset: number): NormalizedSentence[] {
	const out: NormalizedSentence[] = [];
	let inQuote = false;
	let inSingleQuote = false;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!inSingleQuote && (ch === '"' || ch === '“' || ch === '”')) {
			inQuote = ch === '“' ? true : ch === '”' ? false : !inQuote;
		} else if (!inQuote && (ch === "'" || ch === '‘' || ch === '’')) {
			if (!inSingleQuote && (i === 0 || text[i - 1] === ' ')) {
				inSingleQuote = true;
			} else if (inSingleQuote && (i === text.length - 1 || !/[a-zA-Z]/.test(text[i + 1]))) {
				inSingleQuote = false;
			}
		}
		if (inQuote || inSingleQuote) continue;
		const atEnd = i === text.length - 1;
		if ((ch === '.' || ch === '!') && (atEnd || text[i + 1] === ' ')) {
			pushSentence(out, text, start, i + 1, offset);
			start = i + 1;
		}
	}
	pushSentence(out, text, start, text.length, offset);
	return out;
}

function pushSentence(
	out: NormalizedSentence[],
	text: string,
	start: number,
	end: number,
	offset: number
): void {
	let s = start;
	while (s < end && text[s] === ' ') s++;
	if (s >= end) return;
	out.push({ text: text.slice(s, end), span: { start: offset + s, end: offset + end } });
}

export function normalizeFace(
	name: string,
	rulesText: string,
	isCharacterLegend = false
): NormalizedFace {
	const lines: NormalizedLine[] = [];
	const parts: string[] = [];
	let offset = 0;
	const sortedNames = selfNames(name, isCharacterLegend, rulesText).sort(
		(a, b) => b.length - a.length
	);

	rulesText.split('\n').forEach((raw, rawIndex) => {
		const text = replaceSelfReferencesWithNames(stripReminderText(raw), name, sortedNames);
		if (!text) return;
		if (parts.length > 0) offset += 1; // the joining newline
		const span = { start: offset, end: offset + text.length };

		const m = text.match(ABILITY_WORD);
		let aw = m && isAbilityOrFlavorWord(m[1]) ? m : null;
		if (!aw) {
			const bm = text.match(BULLET_ABILITY_WORD);
			if (
				bm &&
				!/\bfaces a villainous choice$/i.test(bm[1]) &&
				!/^\{P\}/i.test(bm[1]) &&
				isAbilityOrFlavorWord(bm[1])
			) {
				aw = bm;
			}
		}
		const bodyOffset = aw ? aw[0].length : 0;
		const body = text.slice(bodyOffset);
		const bodySpan = { start: offset + bodyOffset, end: span.end };

		lines.push({
			rawIndex,
			raw: raw.trim(),
			text,
			span,
			abilityWord: aw ? aw[1] : undefined,
			body,
			bodySpan,
			sentences: splitSentences(body, bodySpan.start)
		});
		parts.push(text);
		offset += text.length;
	});

	return { text: parts.join('\n'), lines };
}

/** Undoes the `~` replacement so legacy parsers, which match on the card's name, can read a piece. */
export function denormalize(text: string, name: string): string {
	return text.replace(/~/g, name);
}

/**
 * A piece of normalized text as the card prints it, for display. `~` stands for both the card's name
 * and "this artifact"-style references, and the two aren't interchangeable: in a granted ability
 * ('Treasures you control have "{T}, Sacrifice this artifact: ..."') the reference is to the object
 * that has the ability, not to the card granting it (CR 201.5). So the wording is looked up in
 * `rulesText`; a piece that isn't found there falls back to the card's name.
 */
export function printedText(text: string, name: string, rulesText: string): string {
	const hasTilde = text.includes('~');
	const hasPronoun = /\b(?:it|its|itself|it's)\b/i.test(text);
	if (!hasTilde && !hasPronoun) return text;
	const selfNamesList = selfNames(name, true, rulesText).sort((a, b) => b.length - a.length);
	const self = `(?:${selfNamesList.map(escapeRegex).join('|')}|[Tt]his (?:${SELF_REFERENCE_TYPES})\\b)`;
	const expandPronouns = (chunk: string) =>
		escapeRegex(chunk)
			.replace(/\b([Ii])tself\b/g, '(?:$1tself|[Hh]imself|[Hh]erself)')
			.replace(/\b([Ii])t\\'s\b/g, "(?:$1t's|[Hh]e's|[Ss]he's|[Hh]e’s|[Ss]he’s)")
			.replace(/\b([Ii])ts\b/g, '(?:$1ts|[Hh]is|[Hh]er)')
			.replace(/\b([Ii])t\b/g, '(?:$1t|[Hh]im|[Hh]er|[Hh]e|[Ss]he)');
	const pattern = new RegExp(text.split('~').map(expandPronouns).join(self));
	const printed = rulesText.split('\n').map(stripReminderText).join('\n');
	return printed.match(pattern)?.[0] ?? denormalize(text, name);
}

/** FNV-1a, 32-bit. Only used to key the compile cache; not security-sensitive. */
export function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
