/**
 * Counts how many triggered abilities resolve on the IR effect interpreter (runtime/effects.ts)
 * rather than the legacy executeParsedEffect path (ENGINE_ARCHITECTURE_PLAN.md Phase 10 steps C+D).
 *
 * Usage:
 *   node scripts/magic-trigger-interpreter.ts [<oracle-cards.jsonl.gz>] [--list]
 *
 * For every triggered ability the runtime matches (compiler/triggers.ts `runtimeTriggers`, minus the
 * ones the engine can't execute at all), it checks whether its compiled effect is statically
 * interpretable (`staticallyInterpretable`). Run-time checks (`interpretableNow`: a human chooser of
 * a prompting verb before the last step) can still send a resolution to the legacy path, so the
 * interpreter counts are an upper bound. `--list` prints the precon abilities on each path.
 */
import { compileCard } from '../src/lib/magic/compiler/index.ts';
import { runtimeTriggers, type RuntimeTrigger } from '../src/lib/magic/compiler/triggers.ts';
import { staticallyInterpretable } from '../src/lib/magic/runtime/effects.ts';
import { normalizeScryfallCard } from '../src/lib/magic/scryfall.ts';
import type { ScryfallCard } from '../src/lib/magic/types.ts';
import { NON_GAME_LAYOUTS, preconCards, readBulk } from './magic-shared.ts';

interface Row {
	card: string;
	clause: string;
	interpreter: boolean;
	targeted: boolean;
}

function rows(card: ScryfallCard): Row[] {
	if (card.backFace || card.oracleText.includes('\n//\n')) return [];
	return runtimeTriggers(compileCard(card))
		.filter((t: RuntimeTrigger) => t.legacy.effects.length > 0 || Boolean(t.effect && staticallyInterpretable(t.effect, true)))
		.map((t) => ({
			card: card.name,
			clause: t.legacy.clause,
			interpreter: Boolean(t.effect && staticallyInterpretable(t.effect, true)),
			targeted: (t.effect?.targets.length ?? 0) > 0
		}));
}

function summary(label: string, rs: Row[]): string {
	const on = rs.filter((r) => r.interpreter);
	return `| ${label} | ${rs.length} | ${on.length} | ${on.filter((r) => r.targeted).length} | ${rs.length - on.length} |`;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const bulkPath = argv.find((a) => !a.startsWith('--'));
	const precon = preconCards().flatMap(rows);
	const lines = [
		'| Pool | Triggered abilities | On the interpreter | (of which targeted) | Legacy path |',
		'|---|---:|---:|---:|---:|',
		summary('Precon cards', precon)
	];
	if (bulkPath) {
		const bulk: Row[] = [];
		for await (const raw of readBulk(bulkPath)) {
			if (NON_GAME_LAYOUTS.has(String(raw.layout ?? 'normal'))) continue;
			bulk.push(...rows(normalizeScryfallCard(raw)));
		}
		lines.push(summary('All game cards', bulk));
	}
	if (argv.includes('--list')) {
		for (const path of [true, false]) {
			lines.push('', path ? '### Precon: interpreter' : '### Precon: legacy path', '');
			for (const r of precon.filter((x) => x.interpreter === path)) lines.push(`- ${r.card}: ${r.clause.replace(/\n/g, ' ')}`);
		}
	}
	process.stdout.write(`${lines.join('\n')}\n`);
}

await main();
