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

const SELF_REFERENCE =
	/\bthis (?:creature|permanent|spell|card|artifact|enchantment|land|equipment|aura|vehicle|planeswalker|battle|saga|class|case|siege)\b/gi;

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
	'beam me up'
];

const RULES_TERM_BLOCKLIST: ReadonlySet<string> = new Set([
	...RULES_SECTION_701_ACTIONS,
	...RULES_SECTION_702_KEYWORDS
]);

/** Parameterized keyword prefixes that may appear with arguments before ` — `. */
const RULES_PARAM_PREFIXES: readonly string[] = [
	'boast',
	'exhaust',
	'craft',
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
	'embalm',
	'eternalize',
	'encore',
	'transmute',
	'forecast',
	'reinforce'
];

function isAbilityOrFlavorWord(rawPrefix: string): boolean {
	const low = rawPrefix.toLowerCase().replace(/’/g, "'").trim();
	if (ABILITY_WORDS.has(low)) return true;
	if (RULES_TERM_BLOCKLIST.has(low)) return false;
	if (low.endsWith('cycling')) return false;
	for (const p of RULES_PARAM_PREFIXES) {
		if (low.startsWith(`${p} `) || low.startsWith(`${p}—`)) return false;
	}
	return true;
}

// "Landfall — Whenever ...", "Keen Sight — Whenever ...". Keyword costs use an unspaced dash
// ("Ward—Pay 3 life"), so a spaced em dash followed by a capital letter or bullet marks a CR 207.2c
// ability-word or CR 207.2d flavor-word candidate unless the prefix is a rules term (CR 701/702).
const ABILITY_WORD = /^([A-Z][A-Za-z0-9'’ -]*?) — (?=[A-Z•])/;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Names that refer to the card itself: the full name and, for "Name, Title", the short name. */
export function selfNames(name: string): string[] {
	const names = [name];
	const comma = name.indexOf(', ');
	if (comma > 0) names.push(name.slice(0, comma));
	return names;
}

export function stripReminderText(line: string): string {
	return line.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

export function replaceSelfReferences(line: string, name: string): string {
	let out = line;
	for (const n of selfNames(name)) {
		out = out.replace(new RegExp(`\\b${escapeRegex(n)}(?!\\w)`, 'g'), '~');
	}
	return out.replace(SELF_REFERENCE, '~');
}

/** Splits on sentence-ending periods that are outside quotation marks. */
export function splitSentences(text: string, offset: number): NormalizedSentence[] {
	const out: NormalizedSentence[] = [];
	let inQuote = false;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === '“' || ch === '”') inQuote = ch === '“' ? true : ch === '”' ? false : !inQuote;
		if (inQuote) continue;
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

export function normalizeFace(name: string, rulesText: string): NormalizedFace {
	const lines: NormalizedLine[] = [];
	const parts: string[] = [];
	let offset = 0;

	rulesText.split('\n').forEach((raw, rawIndex) => {
		const text = replaceSelfReferences(stripReminderText(raw), name);
		if (!text) return;
		if (parts.length > 0) offset += 1; // the joining newline
		const span = { start: offset, end: offset + text.length };

		const m = text.match(ABILITY_WORD);
		const aw = m && isAbilityOrFlavorWord(m[1]) ? m : null;
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

/** FNV-1a, 32-bit. Only used to key the compile cache; not security-sensitive. */
export function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
