/**
 * Compares the cost grammar (compiler/costs.ts) with the Phase 1 adapter's cost handling.
 *
 * Usage:
 *   node scripts/magic-costs-diff.ts <oracle-cards.jsonl.gz> [--out <report.md>]
 *
 * Every activated-ability cost and every "As an additional cost to cast ~, ..." sentence in the
 * precon cards and the bulk file is parsed both ways and put in one bucket:
 *   agree        both understand every part and produce the same CostDefs
 *   grammarOnly  only the grammar understands it (a gain)
 *   adapterOnly  only the adapter claims it: a grammar gap, or the adapter over-claiming
 *   differ       both claim it but disagree (one of them is wrong)
 *   neither      neither understands it (the grammar's next work)
 *
 * Lines the legacy parser never claimed as an ability at all (e.g. a second "{T}: Add" line) have no
 * adapter cost to compare against; they go in `unclaimedParsed` / `unclaimedUnparsed` instead, so
 * ability-level gaps aren't counted as cost-grammar gains.
 */
import { writeFileSync } from 'node:fs';

import { adaptCard, type LegacyCostClaim } from '../src/lib/magic/compiler/adapter.ts';
import { parseAdditionalCostSentence, parseCost, type CostParse } from '../src/lib/magic/compiler/costs.ts';
import { normalizeFace } from '../src/lib/magic/compiler/normalize.ts';
import { normalizeScryfallCard } from '../src/lib/magic/scryfall.ts';
import type { CostDef } from '../src/lib/magic/ir.ts';
import type { ScryfallCard } from '../src/lib/magic/types.ts';
import { buildTemplater, NON_GAME_LAYOUTS, preconCards, readBulk } from './magic-shared.ts';

type Bucket =
	| 'agree'
	| 'grammarOnly'
	| 'adapterOnly'
	| 'differ'
	| 'neither'
	| 'unclaimedParsed'
	| 'unclaimedUnparsed';
const BUCKETS: Bucket[] = [
	'agree',
	'grammarOnly',
	'adapterOnly',
	'differ',
	'neither',
	'unclaimedParsed',
	'unclaimedUnparsed'
];

interface Row {
	card: string;
	kind: 'activated' | 'additional';
	text: string;
	bucket: Bucket;
	grammar: CostParse;
	adapter?: LegacyCostClaim;
	/** The grammar's unparsed fragments. */
	fragments: string[];
}

function key(defs: CostDef[]): string {
	return defs
		.map((d) => JSON.stringify(d))
		.sort()
		.join(' + ');
}

function classify(grammar: CostParse, adapter: LegacyCostClaim | undefined): Bucket {
	const g = grammar.unparsed.length === 0;
	if (!adapter) return g ? 'unclaimedParsed' : 'unclaimedUnparsed';
	const a = adapter.complete;
	if (g && a) return key(grammar.defs) === key(adapter!.defs) ? 'agree' : 'differ';
	if (g) return 'grammarOnly';
	if (a) return 'adapterOnly';
	return 'neither';
}

function costRows(card: ScryfallCard): Row[] {
	if (card.backFace || card.oracleText.includes('\n//\n')) return [];
	const log: LegacyCostClaim[] = [];
	adaptCard(card, log);
	const norm = normalizeFace(card.name, card.oracleText);
	const rows: Row[] = [];

	const push = (kind: Row['kind'], text: string, offset: number, grammar: CostParse, adapter?: LegacyCostClaim) => {
		rows.push({
			card: card.name,
			kind,
			text,
			bucket: classify(grammar, adapter),
			grammar,
			adapter,
			fragments: grammar.unparsed.map((s) => text.slice(s.start - offset, s.end - offset))
		});
	};

	for (const line of norm.lines) {
		const body = line.body;
		const quote = body.search(/["“]/);
		const colon = body.indexOf(':');
		const isActivated =
			colon > 0 &&
			(quote < 0 || colon < quote) &&
			!/^(when|whenever|at)\b/i.test(body) &&
			!/^choose\b/i.test(body) &&
			!/^[+−-]?[\dX]+:/.test(body); // loyalty abilities
		if (isActivated) {
			const text = body.slice(0, colon).trim();
			const adapter = log.find((c) => c.kind === 'activated' && c.rawIndex === line.rawIndex);
			push('activated', text, 0, parseCost(text), adapter);
		}
		for (const s of line.sentences) {
			const grammar = parseAdditionalCostSentence(s.text);
			if (!grammar) continue;
			const adapter = log.find((c) => c.kind === 'additional' && c.text === s.text);
			push('additional', s.text, 0, grammar, adapter);
		}
	}
	return rows;
}

function summary(label: string, rows: Row[]): string {
	const counts = Object.fromEntries(BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]));
	return `| ${label} | ${rows.length} | ${BUCKETS.map((b) => counts[b]).join(' | ')} |`;
}

function escapeCell(s: string): string {
	return s.replace(/\|/g, '\\|');
}

function describe(defs: CostDef[] | undefined): string {
	return defs ? `\`${escapeCell(JSON.stringify(defs))}\`` : '(not claimed)';
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const bulkPath = argv.find((a) => !a.startsWith('--'));
	const outIdx = argv.indexOf('--out');
	const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
	if (!bulkPath) throw new Error('Usage: node scripts/magic-costs-diff.ts <oracle-cards.jsonl.gz> [--out <file>]');

	const precon = preconCards().flatMap(costRows);
	const bulk: Row[] = [];
	const subtypes = new Set<string>();
	for await (const raw of readBulk(bulkPath)) {
		if (NON_GAME_LAYOUTS.has(String(raw.layout ?? 'normal'))) continue;
		for (const tl of String(raw.type_line ?? '').split(' // ')) {
			const right = tl.split(' — ')[1];
			if (right) for (const s of right.split(/\s+/)) if (s) subtypes.add(s);
		}
		bulk.push(...costRows(normalizeScryfallCard(raw)));
	}
	const templater = buildTemplater(subtypes);

	const rank = (rows: Row[], text: (r: Row) => string[]) => {
		const clusters = new Map<string, { cards: Set<string>; example: Row; fragment: string }>();
		for (const r of rows) {
			for (const f of text(r)) {
				const t = templater(f);
				const c = clusters.get(t) ?? { cards: new Set<string>(), example: r, fragment: f };
				c.cards.add(r.card);
				clusters.set(t, c);
			}
		}
		return [...clusters.entries()].sort((a, b) => b[1].cards.size - a[1].cards.size || a[0].localeCompare(b[0]));
	};

	const listed = (rows: Row[], limit: number) =>
		rows.slice(0, limit).map(
			(r) =>
				`| ${escapeCell(r.card)} | ${r.kind} | ${escapeCell(r.text)} | ${describe(r.grammar.unparsed.length ? undefined : r.grammar.defs)} | ${describe(r.adapter?.complete ? r.adapter.defs : undefined)} |`
		);
	const table = (rows: Row[], limit: number) => [
		'| Card | Kind | Cost | Grammar | Adapter |',
		'|---|---|---|---|---|',
		...listed(rows, limit),
		...(rows.length > limit ? [`| … ${rows.length - limit} more | | | | |`] : [])
	];
	const differ = (rows: Row[]) => rows.filter((r) => r.bucket === 'differ');
	const adapterOnly = (rows: Row[]) => rows.filter((r) => r.bucket === 'adapterOnly');
	const differTemplates = rank(differ(bulk), (r) => [r.text]);

	const report = [
		'# Cost grammar vs adapter',
		'',
		'Generated by `scripts/magic-costs-diff.ts`. Each activated-ability cost and each "As an additional',
		'cost to cast ~, ..." sentence is parsed by the cost grammar (`compiler/costs.ts`) and by the',
		'Phase 1 adapter. A side "understands" a cost only if it consumes every part of it.',
		'',
		'"Line not claimed" means the legacy parser didn\'t turn the line into an ability at all, so there',
		'is no adapter cost to compare; the grammar parsing those costs is not by itself a gain.',
		'',
		'| Pool | Costs | Agree | Grammar only | Adapter only | Differ | Neither | Line not claimed, grammar parses | Line not claimed, grammar doesn\'t |',
		'|---|---:|---:|---:|---:|---:|---:|---:|---:|',
		summary('Precon cards', precon),
		summary('All game cards', bulk),
		'',
		'## Adapter only',
		'',
		'Either a gap in the grammar or the adapter claiming more than it understood. The adapter\'s',
		'additional-cost handling is the engine\'s own `parseAdditionalCostsAndRestrictions`, so an',
		'over-claim here is also what the engine enforces at cast time.',
		'',
		...(adapterOnly(bulk).length === 0 && adapterOnly(precon).length === 0
			? ['None.']
			: table([...adapterOnly(precon), ...adapterOnly(bulk)], 50)),
		'',
		'## Differ',
		'',
		'Both sides claim the whole cost but produce different CostDefs; one of them is wrong.',
		'',
		'### Precon cards',
		'',
		...(differ(precon).length === 0 ? ['None.'] : table(differ(precon), 50)),
		'',
		'### All game cards, by template',
		'',
		...(differTemplates.length === 0
			? ['None.']
			: [
					'| Cards | Template | Example | Grammar | Adapter |',
					'|---:|---|---|---|---|',
					...differTemplates
						.slice(0, 40)
						.map(
							([t, c]) =>
								`| ${c.cards.size} | ${escapeCell(t)} | ${escapeCell(`${c.example.card}: ${c.example.text}`)} | ${describe(c.example.grammar.defs)} | ${describe(c.example.adapter?.defs)} |`
						)
				]),
		'',
		'## Grammar only (gains on claimed lines), top templates',
		'',
		'| Cards | Template | Example |',
		'|---:|---|---|',
		...rank(
			bulk.filter((r) => r.bucket === 'grammarOnly'),
			(r) => [r.text]
		)
			.slice(0, 30)
			.map(([t, c]) => `| ${c.cards.size} | ${escapeCell(t)} | ${escapeCell(`${c.example.card}: ${c.example.text}`)} |`),
		'',
		'## Neither: unparsed cost parts, top templates',
		'',
		'| Cards | Template | Example |',
		'|---:|---|---|',
		...rank(
			bulk.filter((r) => r.bucket === 'neither' || r.bucket === 'adapterOnly' || r.bucket === 'unclaimedUnparsed'),
			(r) => r.fragments
		)
			.slice(0, 50)
			.map(([t, c]) => `| ${c.cards.size} | ${escapeCell(t)} | ${escapeCell(`${c.example.card}: ${c.fragment}`)} |`),
		''
	].join('\n');

	if (out) writeFileSync(out, report);
	else process.stdout.write(report);
	console.error(`${summary('precon', precon)}\n${summary('bulk', bulk)}`);
}

await main();
