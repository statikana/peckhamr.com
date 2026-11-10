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
 * Genuine ability words (CR 207.2c). Only these italicised prefixes have no rules meaning and may
 * be stripped; keyword/state prefixes such as "Solved —", "Max speed —", "Boast —", "Exhaust —",
 * and "Power-up —" carry rules conditions or costs and must remain in `body` so unimplemented
 * mechanics compile as unsupported.
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

// "Landfall — Whenever ...". Keyword costs use an unspaced dash ("Ward—Pay 3 life"), so a spaced
// em dash followed by a capital letter or bullet marks an ability-word candidate (CR 207.2c).
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
		const aw = m && ABILITY_WORDS.has(m[1].toLowerCase().replace(/’/g, "'")) ? m : null;
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
