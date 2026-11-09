/**
 * Compares the effect grammar (compiler/effects.ts) with the Phase 1 adapter.
 *
 * Usage:
 *   node scripts/magic-effects-diff.ts <oracle-cards.jsonl.gz> [--out <report.md>]
 *
 * Every ability with an effect (instant/sorcery spell text, activated abilities, triggered
 * abilities) in the precon cards and the bulk file has its effect parsed both ways and bucketed (see
 * magic-diff.ts). Steps are compared without spans. The report also lists which verbs resolve on the
 * Phase 3 interpreter and which still fall back to the legacy executeParsedEffect path.
 */
import { writeFileSync } from 'node:fs';

import { adaptCard, type AdapterLog } from '../src/lib/magic/compiler/adapter.ts';
import { parseEffects, parseSpellText, type EffectParse } from '../src/lib/magic/compiler/effects.ts';
import { normalizeFace } from '../src/lib/magic/compiler/normalize.ts';
import { parseTriggerHeader } from '../src/lib/magic/compiler/triggers.ts';
import type { EffectStep } from '../src/lib/magic/ir.ts';
import { INTERPRETED_VERBS, staticallyInterpretable } from '../src/lib/magic/runtime/effects.ts';
import { normalizeScryfallCard } from '../src/lib/magic/scryfall.ts';
import type { ScryfallCard } from '../src/lib/magic/types.ts';
import { canonical, classify, renderReport, summaryRow, type DiffRow, type Side } from './magic-diff.ts';
import { buildTemplater, NON_GAME_LAYOUTS, preconCards, readBulk } from './magic-shared.ts';

const stripSpans = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'span' ? undefined : x)));
const same = (a: unknown, b: unknown) => canonical(stripSpans(a)) === canonical(stripSpans(b));

interface EffectRow extends DiffRow {
	/** Only for spells and activated abilities: whether resolution would run on the interpreter. */
	interpreter?: boolean;
	verbs: string[];
}

function grammarSide(parse: EffectParse): Side {
	return {
		complete: parse.unparsed.length === 0 && (parse.steps.length > 0 || Boolean(parse.modal)),
		value: parse.modal ? { modes: parse.modal.modes.map((m) => m.effect) } : parse.steps
	};
}

function verbsOf(steps: EffectStep[]): string[] {
	return steps.flatMap((s) => [s.verb, ...(s.delayed ? verbsOf(s.delayed.effect) : [])]);
}

function effectRows(card: ScryfallCard): EffectRow[] {
	if (card.backFace || card.oracleText.includes('\n//\n')) return [];
	const log: AdapterLog = { costs: [], triggers: [], effects: [] };
	adaptCard(card, log);
	const norm = normalizeFace(card.name, card.oracleText);
	const rows: EffectRow[] = [];
	const fragments = (parse: EffectParse) => parse.unparsed.map((s) => norm.text.slice(s.start, s.end));
	const push = (kind: EffectRow['kind'], text: string, parse: EffectParse, rawIndex: number, interp?: boolean) => {
		const grammar = grammarSide(parse);
		const claim = log.effects!.find((e) => e.kind === kind && (kind === 'spell' || e.rawIndex === rawIndex));
		const adapter: Side | undefined = claim && {
			complete: claim.complete,
			value: claim.modal ? { modes: claim.modal.modes.map((m) => m.effect) } : claim.steps
		};
		rows.push({
			card: card.name,
			kind,
			text,
			bucket: classify(grammar, adapter, same),
			grammar,
			adapter,
			fragments: fragments(parse),
			interpreter: interp,
			verbs: verbsOf(parse.modal ? parse.modal.modes.flatMap((m) => m.effect) : parse.steps)
		});
	};

	if (/\b(?:Instant|Sorcery)\b/.test(card.typeLine)) {
		const parse = parseSpellText(card.name, card.oracleText);
		push('spell', norm.text, parse, 0, staticallyInterpretable(parse));
	}
	for (const line of norm.lines) {
		const trig = parseTriggerHeader(line.body);
		if (trig) {
			const rel = trig.effectStart;
			const parse = parseEffects(line.body.slice(rel), line.bodySpan.start + rel, 'triggered');
			push('triggered', line.body, parse, line.rawIndex);
			continue;
		}
		const quote = line.body.search(/["“]/);
		const colon = line.body.indexOf(':');
		if (colon <= 0 || (quote >= 0 && quote < colon) || /^choose\b/i.test(line.body)) continue;
		const effText = line.body.slice(colon + 1);
		const lead = effText.length - effText.trimStart().length;
		const parse = parseEffects(effText.trim(), line.bodySpan.start + colon + 1 + lead, 'activated');
		const isMana = parse.steps.length > 0 && parse.steps.every((s) => s.verb === 'addMana');
		push('activated', line.body, parse, line.rawIndex, isMana ? undefined : staticallyInterpretable(parse));
	}
	return rows;
}

function interpreterSection(precon: EffectRow[], bulk: EffectRow[]): string[] {
	const count = (rows: EffectRow[], verb: string) => {
		const withVerb = rows.filter((r) => r.grammar.complete && r.verbs.includes(verb));
		return `${withVerb.length}`;
	};
	const allVerbs = [...new Set([...precon, ...bulk].filter((r) => r.grammar.complete).flatMap((r) => r.verbs))].sort();
	const resolvable = (rows: EffectRow[]) => rows.filter((r) => r.interpreter !== undefined);
	const on = (rows: EffectRow[]) => resolvable(rows).filter((r) => r.interpreter).length;
	return [
		'## Resolution path (Phase 3 switch-over)',
		'',
		'Instant/sorcery spells and non-mana activated abilities resolve on the IR interpreter',
		'(`runtime/effects.ts`) when the grammar understands the whole ability, every verb is interpreted and',
		'the targets line up with the legacy targeting; otherwise on the legacy `executeParsedEffect` path.',
		'Triggered abilities all stay on the legacy path until Phase 5. Some checks only happen at',
		'resolution (a human chooser for a prompting verb that is not the last step), so these counts are an',
		'upper bound.',
		'',
		'| Pool | Spells + activated abilities | On the interpreter | Legacy path |',
		'|---|---:|---:|---:|',
		`| Precon cards | ${resolvable(precon).length} | ${on(precon)} | ${resolvable(precon).length - on(precon)} |`,
		`| All game cards | ${resolvable(bulk).length} | ${on(bulk)} | ${resolvable(bulk).length - on(bulk)} |`,
		'',
		'| Verb | Interpreted | Abilities using it (precon) | Abilities using it (all) |',
		'|---|---|---:|---:|',
		...allVerbs.map((v) => `| ${v} | ${INTERPRETED_VERBS.has(v as EffectStep['verb']) ? 'yes' : '**no (legacy)**'} | ${count(precon, v)} | ${count(bulk, v)} |`),
		'',
		'### Precon spells and activated abilities on the legacy path',
		'',
		...(resolvable(precon).filter((r) => !r.interpreter).length === 0
			? ['None.']
			: [
					'| Card | Kind | Text | Grammar complete |',
					'|---|---|---|---|',
					...resolvable(precon)
						.filter((r) => !r.interpreter)
						.map((r) => `| ${r.card} | ${r.kind} | ${r.text.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ')} | ${r.grammar.complete ? 'yes' : 'no'} |`)
				]),
		''
	];
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const bulkPath = argv.find((a) => !a.startsWith('--'));
	const outIdx = argv.indexOf('--out');
	const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
	if (!bulkPath) throw new Error('Usage: node scripts/magic-effects-diff.ts <oracle-cards.jsonl.gz> [--out <file>]');

	const precon = preconCards().flatMap(effectRows);
	const bulk: EffectRow[] = [];
	const subtypes = new Set<string>();
	for await (const raw of readBulk(bulkPath)) {
		if (NON_GAME_LAYOUTS.has(String(raw.layout ?? 'normal'))) continue;
		for (const tl of String(raw.type_line ?? '').split(' // ')) {
			const right = tl.split(' — ')[1];
			if (right) for (const s of right.split(/\s+/)) if (s) subtypes.add(s);
		}
		bulk.push(...effectRows(normalizeScryfallCard(raw)));
	}

	const report = renderReport({
		title: 'Effect grammar vs adapter',
		intro: [
			'Generated by `scripts/magic-effects-diff.ts`. The effect of every instant/sorcery, activated',
			'ability and triggered ability is parsed by the effect grammar (`compiler/effects.ts`) and by the',
			'Phase 1 adapter (the legacy `parseSpellOrAbilityEffects` the engine resolves with, translated to IR).',
			'Steps are compared without spans, in order: the adapter loses sentence order, so an order',
			'difference is a "differ". Bindings (`bindAs`, `binding` selectors) exist only in the grammar, so',
			'every effect that refers back to an earlier object ("its controller", "that creature") differs.'
		],
		adapterNote: [
			'Either a gap in the grammar, or the adapter claiming a sentence because the legacy parser found',
			'some effect in it (the legacy parser often drops part of a sentence).'
		],
		precon,
		bulk,
		templater: buildTemplater(subtypes)
	});

	const full = `${report}\n${interpreterSection(precon, bulk).join('\n')}`;
	if (out) writeFileSync(out, full);
	else process.stdout.write(full);
	console.error(`${summaryRow('precon', precon)}\n${summaryRow('bulk', bulk)}`);
}

await main();
