/**
 * Card compiler coverage report (ENGINE_ARCHITECTURE_PLAN.md, Phase 1 step 3).
 *
 * Usage:
 *   node scripts/magic-coverage.ts <oracle-cards.jsonl.gz> [--decks <d1-export.json>]
 *     [--out <report.md>] [--write-precon-fixture <path>]
 *
 * - The bulk file is Scryfall's oracle-cards data as gzipped JSON Lines. It is never committed.
 * - --decks takes the JSON written by
 *     npx wrangler d1 execute cosmo_users --remote --json \
 *       --command "SELECT id, commanders_json, cards_json FROM MagicDecks" > decks.json
 *   The script only reads the file; it never talks to Cloudflare.
 * - --write-precon-fixture writes the Oracle text, type line and mana cost of every precon card,
 *   taken from the bulk file, for the precon integrity test.
 */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { performance } from 'node:perf_hooks';

import { clearCompileCache, compileCard, COMPILER_VERSION } from '../src/lib/magic/compiler/index.ts';
import { clearRuleTreeCache } from '../src/lib/magic/ruleTree.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../src/lib/magic/precons.ts';
import { normalizeScryfallCard } from '../src/lib/magic/scryfall.ts';
import type { CardDefinition, UnsupportedReason } from '../src/lib/magic/ir.ts';
import type { ScryfallCard } from '../src/lib/magic/types.ts';

// Layouts that never appear in a game of Magic.
const NON_GAME_LAYOUTS = new Set([
	'art_series',
	'double_faced_token',
	'emblem',
	'front_card',
	'planar',
	'scheme',
	'token',
	'vanguard'
]);

const TOP_TEMPLATES = 100;
const COLD_START_SAMPLE = 400;

interface Args {
	bulk: string;
	decks?: string;
	out?: string;
	fixture?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Partial<Args> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--decks') args.decks = argv[++i];
		else if (a === '--out') args.out = argv[++i];
		else if (a === '--write-precon-fixture') args.fixture = argv[++i];
		else if (!a.startsWith('--') && !args.bulk) args.bulk = a;
		else throw new Error(`Unknown argument: ${a}`);
	}
	if (!args.bulk) {
		throw new Error(
			'Usage: node scripts/magic-coverage.ts <oracle-cards.jsonl.gz> [--decks <file>] [--out <file>] [--write-precon-fixture <file>]'
		);
	}
	return args as Args;
}

async function* readBulk(path: string): AsyncGenerator<Record<string, any>> {
	const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
	for await (const raw of rl) {
		// Accept JSON Lines and the one-object-per-line JSON array Scryfall also serves.
		const line = raw.trim().replace(/,$/, '');
		if (!line || line === '[' || line === ']') continue;
		yield JSON.parse(line);
	}
}

// ---- Templates ------------------------------------------------------------------------------

const NUMBER_WORDS =
	/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fifteen|twenty)\b/gi;
const IRREGULAR_PLURALS: Record<string, string> = { Elf: 'Elves', Dwarf: 'Dwarves', Wolf: 'Wolves' };

function buildTemplater(subtypes: Set<string>): (text: string) => string {
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

// ---- Stats ----------------------------------------------------------------------------------

interface Stats {
	cards: number;
	fullySupported: number;
	/** Cards whose only unsupported abilities are statics, which Phases 6/7 compile. */
	supportedExceptStatics: number;
	abilities: number;
	supportedAbilities: number;
	byReason: Record<UnsupportedReason, number>;
}

function emptyStats(): Stats {
	return {
		cards: 0,
		fullySupported: 0,
		supportedExceptStatics: 0,
		abilities: 0,
		supportedAbilities: 0,
		byReason: { unparsed: 0, keyword_not_implemented: 0, static_not_compiled: 0, multiface: 0 }
	};
}

function addToStats(stats: Stats, def: CardDefinition): void {
	stats.cards++;
	if (def.fullySupported) stats.fullySupported++;
	let onlyStatics = true;
	for (const face of def.faces) {
		for (const ab of face.abilities) {
			if (ab.kind === 'activated' && ab.intrinsic) continue;
			stats.abilities++;
			if (ab.kind !== 'unsupported') {
				stats.supportedAbilities++;
				continue;
			}
			stats.byReason[ab.reason]++;
			if (ab.reason !== 'static_not_compiled') onlyStatics = false;
		}
	}
	if (onlyStatics) stats.supportedExceptStatics++;
}

function pct(n: number, d: number): string {
	return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

function statsTable(rows: Array<[string, Stats]>): string {
	const out = [
		'| Set | Cards | Fully supported | Fully supported, ignoring statics | Abilities supported |',
		'|---|---:|---:|---:|---:|'
	];
	for (const [label, s] of rows) {
		out.push(
			`| ${label} | ${s.cards} | ${s.fullySupported} (${pct(s.fullySupported, s.cards)}) | ` +
				`${s.supportedExceptStatics} (${pct(s.supportedExceptStatics, s.cards)}) | ` +
				`${s.supportedAbilities}/${s.abilities} (${pct(s.supportedAbilities, s.abilities)}) |`
		);
	}
	return out.join('\n');
}

// ---- Saved decks ----------------------------------------------------------------------------

function readSavedDeckCards(path: string): ScryfallCard[] {
	const json = JSON.parse(readFileSync(path, 'utf8'));
	// `wrangler d1 execute --json` prints an array of result envelopes.
	const envelopes = Array.isArray(json) ? json : [json];
	const rows: Array<Record<string, unknown>> = envelopes.flatMap((e) =>
		Array.isArray(e?.results) ? e.results : Array.isArray(e) ? e : []
	);
	const cards: ScryfallCard[] = [];
	for (const row of rows) {
		const commanders = JSON.parse(String(row.commanders_json ?? '[]')) as ScryfallCard[];
		const entries = JSON.parse(String(row.cards_json ?? '[]')) as Array<{ card: ScryfallCard }>;
		cards.push(...commanders, ...entries.map((e) => e.card));
	}
	return cards;
}

function uniqueCards(cards: ScryfallCard[]): ScryfallCard[] {
	const seen = new Map<string, ScryfallCard>();
	for (const c of cards) seen.set(c.oracleId ?? c.name, c);
	return [...seen.values()];
}

// ---- Precon integrity -----------------------------------------------------------------------

export interface PreconOracleEntry {
	oracleText: string;
	typeLine: string;
	manaCost: string;
}

function preconCards(): ScryfallCard[] {
	const byName = new Map<string, ScryfallCard>();
	for (const c of Object.values(STAPLE_CARDS)) byName.set(c.name, c);
	for (const d of PRECON_DECKS) {
		for (const c of d.commanders) byName.set(c.name, c);
		for (const e of d.cards) byName.set(e.card.name, e.card);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Main -----------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so the cold-start sample is the same every run. */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const started = performance.now();

	const all = emptyStats();
	const skipped = new Map<string, number>();
	const throws: Array<{ name: string; error: string }> = [];
	const subtypes = new Set<string>();
	const gameCards: ScryfallCard[] = [];
	const bulkByName = new Map<string, ScryfallCard>();
	// Unparsed fragments, templated at the end once every subtype is known.
	const fragments: Array<{ text: string; card: string }> = [];

	for await (const raw of readBulk(args.bulk)) {
		const layout = String(raw.layout ?? 'normal');
		if (NON_GAME_LAYOUTS.has(layout)) {
			skipped.set(layout, (skipped.get(layout) ?? 0) + 1);
			continue;
		}
		const card = normalizeScryfallCard(raw);
		bulkByName.set(card.name, card);
		if (String(raw.name).includes(' // ')) bulkByName.set(String(raw.name), card);
		for (const tl of String(raw.type_line ?? '').split(' // ')) {
			const right = tl.split(' — ')[1];
			if (right) for (const s of right.split(/\s+/)) if (s) subtypes.add(s);
		}
		gameCards.push(card);

		let def: CardDefinition;
		try {
			def = compileCard(card);
		} catch (err) {
			throws.push({ name: card.name, error: err instanceof Error ? err.message : String(err) });
			continue;
		}
		addToStats(all, def);
		for (const face of def.faces) {
			for (const ab of face.abilities) {
				if (ab.kind !== 'unsupported' || ab.reason === 'multiface') continue;
				for (const u of ab.unparsed) {
					const text = ab.text.slice(u.start - ab.span.start, u.end - ab.span.start).trim();
					if (text) fragments.push({ text, card: card.name });
				}
			}
		}
	}
	const compileAllMs = performance.now() - started;

	// Templates, ranked by the number of distinct cards affected.
	const templater = buildTemplater(subtypes);
	const clusters = new Map<string, { cards: Set<string>; example: string }>();
	for (const f of fragments) {
		const t = templater(f.text);
		const c = clusters.get(t) ?? { cards: new Set<string>(), example: `${f.card}: ${f.text}` };
		c.cards.add(f.card);
		clusters.set(t, c);
	}
	const ranked = [...clusters.entries()].sort(
		(a, b) => b[1].cards.size - a[1].cards.size || a[0].localeCompare(b[0])
	);

	// Precon decks, compiled from the text in precons.ts (what the game uses), plus integrity.
	const precons = preconCards();
	const preconStats = emptyStats();
	for (const c of precons) addToStats(preconStats, compileCard(c));
	const mismatches: string[] = [];
	const fixture: Record<string, PreconOracleEntry> = {};
	for (const c of precons) {
		const bulk = bulkByName.get(c.name);
		if (!bulk) {
			mismatches.push(`- **${c.name}**: not found in bulk data`);
			continue;
		}
		fixture[c.name] = { oracleText: bulk.oracleText, typeLine: bulk.typeLine, manaCost: bulk.manaCost };
		for (const field of ['oracleText', 'typeLine', 'manaCost'] as const) {
			if (c[field] !== bulk[field]) {
				mismatches.push(`- **${c.name}** \`${field}\`: precons has ${JSON.stringify(c[field])}, Oracle has ${JSON.stringify(bulk[field])}`);
			}
		}
	}
	if (args.fixture) {
		writeFileSync(args.fixture, `${JSON.stringify(fixture, null, '\t')}\n`);
	}

	// Saved decks.
	let deckStats: Stats | undefined;
	if (args.decks) {
		deckStats = emptyStats();
		for (const c of uniqueCards(readSavedDeckCards(args.decks))) addToStats(deckStats, compileCard(c));
	}

	// Cold start: a Commander game with four 100-card decks of distinct cards, both caches empty.
	const next = rng(20261108);
	const sample: ScryfallCard[] = [];
	const used = new Set<number>();
	while (sample.length < Math.min(COLD_START_SAMPLE, gameCards.length)) {
		const i = Math.floor(next() * gameCards.length);
		if (!used.has(i)) {
			used.add(i);
			sample.push(gameCards[i]);
		}
	}
	clearCompileCache();
	clearRuleTreeCache();
	const coldStart = performance.now();
	for (const c of sample) compileCard(c);
	const coldMs = performance.now() - coldStart;

	const skippedTotal = [...skipped.values()].reduce((a, b) => a + b, 0);
	const report = [
		'# Card compiler coverage',
		'',
		`Generated by \`scripts/magic-coverage.ts\` (compiler version ${COMPILER_VERSION}). Regenerate after`,
		'compiler changes; see ENGINE_ARCHITECTURE_PLAN.md, Phase 11+.',
		'',
		'"Ignoring statics" counts cards whose only gaps are static abilities, which Phases 6 and 7',
		'compile. The runtime enforces some of those today by scanning rules text; this report counts',
		'only what reaches the IR.',
		'',
		'## Summary',
		'',
		statsTable([
			['All game cards', all],
			['Precon decks', preconStats],
			...(deckStats ? ([['Saved decks', deckStats]] as Array<[string, Stats]>) : [])
		]),
		'',
		`- Bulk file: \`${args.bulk.replace(/^.*\//, '')}\`. Non-game layouts skipped: ${skippedTotal} (${[...skipped.entries()].sort().map(([k, v]) => `${k} ${v}`).join(', ')}).`,
		`- Compiler errors: ${throws.length}${throws.length ? ` (${throws.slice(0, 10).map((t) => `${t.name}: ${t.error}`).join('; ')})` : ''}.`,
		`- Unsupported abilities by reason: ${Object.entries(all.byReason).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
		`- Cold start (Node ${process.version}, not workerd): ${sample.length} distinct cards compiled in ${coldMs.toFixed(0)} ms (${(coldMs / sample.length).toFixed(2)} ms/card), both caches empty.`,
		`- Whole run: ${(compileAllMs / 1000).toFixed(1)} s for ${all.cards} cards.`,
		...(deckStats ? [] : ['- Saved decks: not measured (pass `--decks`).']),
		'',
		`## Top ${TOP_TEMPLATES} unparsed templates`,
		'',
		'Numbers are `N`, mana and costs are `{COST}`, subtypes are `<SUBTYPE>`, the card itself is `~`.',
		'',
		'| # | Cards | Template | Example |',
		'|---:|---:|---|---|',
		...ranked
			.slice(0, TOP_TEMPLATES)
			.map(([t, c], i) => `| ${i + 1} | ${c.cards.size} | ${escapeCell(t)} | ${escapeCell(c.example)} |`),
		'',
		'## Precon data integrity',
		'',
		mismatches.length === 0
			? 'Every precon card matches the bulk data.'
			: `${mismatches.length} mismatches between \`precons.ts\` and the bulk data:\n\n${mismatches.join('\n')}`,
		''
	].join('\n');

	if (args.out) writeFileSync(args.out, report);
	else process.stdout.write(report);

	console.error(
		`Compiled ${all.cards} cards: ${pct(all.fullySupported, all.cards)} fully supported, ` +
			`${pct(all.supportedExceptStatics, all.cards)} ignoring statics; ${throws.length} errors; ` +
			`cold start ${coldMs.toFixed(0)} ms for ${sample.length} cards.`
	);
	if (throws.length > 0) process.exitCode = 1;
}

function escapeCell(s: string): string {
	return s.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
}

await main();
