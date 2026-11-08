/**
 * Shared bucketing and report rendering for the "grammar vs adapter" comparison scripts
 * (magic-costs-diff.ts, magic-triggers-diff.ts).
 *
 * Every compared item lands in one bucket:
 *   agree              both sides understand all of it and produce the same IR
 *   grammarOnly        only the grammar understands it (a gain)
 *   adapterOnly        only the adapter claims it: a grammar gap, or the adapter over-claiming
 *   differ             both claim it but disagree (one of them is wrong)
 *   neither            neither understands it (the grammar's next work)
 *   unclaimedParsed    the legacy parser never claimed the line at all; the grammar parses it
 *   unclaimedUnparsed  the legacy parser never claimed the line; the grammar doesn't parse it
 * Lines the legacy parser never claimed are kept apart so ability-level gaps aren't counted as
 * grammar gains.
 */
export type Bucket =
	| 'agree'
	| 'grammarOnly'
	| 'adapterOnly'
	| 'differ'
	| 'neither'
	| 'unclaimedParsed'
	| 'unclaimedUnparsed';

export const BUCKETS: Bucket[] = [
	'agree',
	'grammarOnly',
	'adapterOnly',
	'differ',
	'neither',
	'unclaimedParsed',
	'unclaimedUnparsed'
];

export interface Side {
	/** True if this side understood every part of the item. */
	complete: boolean;
	/** The IR it produced (compared as canonical JSON). */
	value: unknown;
}

export interface DiffRow {
	card: string;
	kind: string;
	text: string;
	bucket: Bucket;
	grammar: Side;
	adapter?: Side;
	/** Text fragments the grammar didn't understand. */
	fragments: string[];
}

/** Stable JSON: object keys sorted, undefined dropped. Arrays keep their order. */
export function canonical(value: unknown): string {
	return JSON.stringify(value, (_k, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
			: v
	);
}

export function classify(grammar: Side, adapter: Side | undefined, same: (a: unknown, b: unknown) => boolean): Bucket {
	if (!adapter) return grammar.complete ? 'unclaimedParsed' : 'unclaimedUnparsed';
	if (grammar.complete && adapter.complete) return same(grammar.value, adapter.value) ? 'agree' : 'differ';
	if (grammar.complete) return 'grammarOnly';
	if (adapter.complete) return 'adapterOnly';
	return 'neither';
}

function escapeCell(s: string): string {
	return s.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
}

function describe(side: Side | undefined): string {
	if (!side) return '(line not claimed)';
	if (!side.complete) return '(incomplete)';
	return `\`${escapeCell(JSON.stringify(side.value))}\``;
}

export function summaryRow(label: string, rows: DiffRow[]): string {
	const counts = BUCKETS.map((b) => rows.filter((r) => r.bucket === b).length);
	return `| ${label} | ${rows.length} | ${counts.join(' | ')} |`;
}

type Templater = (text: string) => string;

function rank(rows: DiffRow[], texts: (r: DiffRow) => string[], templater: Templater) {
	const clusters = new Map<string, { cards: Set<string>; example: DiffRow; fragment: string }>();
	for (const r of rows) {
		for (const f of texts(r)) {
			const t = templater(f);
			const c = clusters.get(t) ?? { cards: new Set<string>(), example: r, fragment: f };
			c.cards.add(r.card);
			clusters.set(t, c);
		}
	}
	return [...clusters.entries()].sort((a, b) => b[1].cards.size - a[1].cards.size || a[0].localeCompare(b[0]));
}

function listTable(rows: DiffRow[], limit: number): string[] {
	if (rows.length === 0) return ['None.'];
	return [
		'| Card | Kind | Text | Grammar | Adapter |',
		'|---|---|---|---|---|',
		...rows
			.slice(0, limit)
			.map((r) => `| ${escapeCell(r.card)} | ${r.kind} | ${escapeCell(r.text)} | ${describe(r.grammar)} | ${describe(r.adapter)} |`),
		...(rows.length > limit ? [`| … ${rows.length - limit} more | | | | |`] : [])
	];
}

function templateTable(rows: DiffRow[], templater: Templater, limit: number, withValues: boolean, texts: (r: DiffRow) => string[]): string[] {
	const ranked = rank(rows, texts, templater);
	if (ranked.length === 0) return ['None.'];
	return [
		withValues ? '| Cards | Template | Example | Grammar | Adapter |' : '| Cards | Template | Example |',
		withValues ? '|---:|---|---|---|---|' : '|---:|---|---|',
		...ranked.slice(0, limit).map(([t, c]) => {
			const base = `| ${c.cards.size} | ${escapeCell(t)} | ${escapeCell(`${c.example.card}: ${c.fragment}`)} |`;
			return withValues ? `${base} ${describe(c.example.grammar)} | ${describe(c.example.adapter)} |` : base;
		})
	];
}

export function renderReport(opts: {
	title: string;
	intro: string[];
	adapterNote: string[];
	precon: DiffRow[];
	bulk: DiffRow[];
	templater: Templater;
}): string {
	const { precon, bulk, templater } = opts;
	const of = (rows: DiffRow[], ...b: Bucket[]) => rows.filter((r) => b.includes(r.bucket));
	const whole = (r: DiffRow) => [r.text];
	return [
		`# ${opts.title}`,
		'',
		...opts.intro,
		'',
		'"Line not claimed" means the legacy parser didn\'t turn the line into an ability at all, so there',
		'is no adapter result to compare; the grammar parsing it is not by itself a gain.',
		'',
		"| Pool | Items | Agree | Grammar only | Adapter only | Differ | Neither | Line not claimed, grammar parses | Line not claimed, grammar doesn't |",
		'|---|---:|---:|---:|---:|---:|---:|---:|---:|',
		summaryRow('Precon cards', precon),
		summaryRow('All game cards', bulk),
		'',
		'## Adapter only',
		'',
		...opts.adapterNote,
		'',
		...listTable([...of(precon, 'adapterOnly'), ...of(bulk, 'adapterOnly')], 50),
		'',
		'## Differ',
		'',
		'Both sides claim the whole item but produce different IR; one of them is wrong.',
		'',
		'### Precon cards',
		'',
		...listTable(of(precon, 'differ'), 50),
		'',
		'### All game cards, by template',
		'',
		...templateTable(of(bulk, 'differ'), templater, 40, true, whole),
		'',
		'## Grammar only (gains on claimed lines), top templates',
		'',
		...templateTable(of(bulk, 'grammarOnly'), templater, 30, false, whole),
		'',
		'## Not understood by the grammar, top templates',
		'',
		...templateTable(of(bulk, 'neither', 'adapterOnly', 'unclaimedUnparsed'), templater, 50, false, (r) => r.fragments),
		''
	].join('\n');
}
