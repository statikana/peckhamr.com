/** Helpers shared by the magic engine scripts (coverage report, cost grammar diff). */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

import { PRECON_DECKS, STAPLE_CARDS } from '../src/lib/magic/precons.ts';
import type { ScryfallCard } from '../src/lib/magic/types.ts';

// Layouts that never appear in a game of Magic.
export const NON_GAME_LAYOUTS = new Set([
	'art_series',
	'double_faced_token',
	'emblem',
	'front_card',
	'planar',
	'scheme',
	'token',
	'vanguard'
]);

export async function* readBulk(path: string): AsyncGenerator<Record<string, any>> {
	const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
	for await (const raw of rl) {
		// Accept JSON Lines and the one-object-per-line JSON array Scryfall also serves.
		const line = raw.trim().replace(/,$/, '');
		if (!line || line === '[' || line === ']') continue;
		yield JSON.parse(line);
	}
}


const NUMBER_WORDS =
	/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fifteen|twenty)\b/gi;
const IRREGULAR_PLURALS: Record<string, string> = { Elf: 'Elves', Dwarf: 'Dwarves', Wolf: 'Wolves' };

export function buildTemplater(subtypes: Set<string>): (text: string) => string {
	const words = new Set<string>();
	for (const s of subtypes) {
		words.add(s);
		words.add(IRREGULAR_PLURALS[s] ?? `${s}s`);
		if (/(?:s|x|ch|sh)$/.test(s)) words.add(`${s}es`);
	}
	return (text: string) =>
		text
			.replace(/(\{[^}]+\})+/g, '{COST}')
			.replace(/[+\-−]?\b\d+\b/g, 'N')
			.replace(NUMBER_WORDS, 'N')
			.replace(/\b[A-Z][a-z]+(?:-[A-Z][a-z]+)?\b/g, (w) => (words.has(w) ? '<SUBTYPE>' : w));
}

export function preconCards(): ScryfallCard[] {
	const byName = new Map<string, ScryfallCard>();
	for (const c of Object.values(STAPLE_CARDS)) byName.set(c.name, c);
	for (const d of PRECON_DECKS) {
		for (const c of d.commanders) byName.set(c.name, c);
		for (const e of d.cards) byName.set(e.card.name, e.card);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
