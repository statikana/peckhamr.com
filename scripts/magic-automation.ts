/**
 * Precon automation paths, before step F (ENGINE_ARCHITECTURE_PLAN.md Phase 10, "Step F results").
 *
 * Lists, for every ability of every precon card that does something when it resolves (the spell
 * ability of an instant or sorcery, activated abilities, mana abilities, triggered abilities, Ward),
 * how the engine resolved it before the legacy layer was deleted:
 *   - interpreter: the IR effect interpreter (runtime/effects.ts),
 *   - legacy:      the pre-IR ParsedEffect fallback (bots used it; humans were offered it),
 *   - manual:      neither: a human resolves it with the guided prompt and a bot skips it,
 *   - engine:      the engine implements it itself (Ward; mana abilities, through
 *                  getPermanentManaProduction / parseActivatedAbilities).
 *
 * Abilities are keyed by card name, kind and normalised line text (`~` for the card's name), so the
 * key survives the deletion of the legacy parsers. `--json` writes the baseline checked in as
 * src/lib/magic/compiler/automation.baseline.json; `compiler/automation.test.ts` asserts that every
 * ability automated then (interpreter, legacy or engine) is automated now.
 *
 * Usage: node scripts/magic-automation.ts [--json | --helpers]
 *
 * It reads the legacy parsers, so it only runs on a checkout from before step F3. `--helpers`
 * prints, for every legacy text helper the runtime called, the precon cards for which it returned a
 * non-default answer (the regression net for moving those call sites onto the IR).
 */
import { compileCard } from '../src/lib/magic/compiler/index.ts';
import { compiledStackItemEffects } from '../src/lib/magic/compiler/effects.ts';
import { normalizeFace } from '../src/lib/magic/compiler/normalize.ts';
import { runtimeTriggers } from '../src/lib/magic/compiler/triggers.ts';
import * as oracle from '../src/lib/magic/oracle.ts';
import { staticallyInterpretable } from '../src/lib/magic/runtime/effects.ts';
import type { ScryfallCard, StackItem } from '../src/lib/magic/types.ts';
import { preconCards } from './magic-shared.ts';

type Path = 'interpreter' | 'legacy' | 'manual' | 'engine';
interface Row {
	card: string;
	kind: 'spell' | 'activated' | 'mana' | 'triggered' | 'ward';
	text: string;
	path: Path;
}

const WUBRG = ['W', 'U', 'B', 'R', 'G'] as const;

function rowsFor(card: ScryfallCard): Row[] {
	if (card.backFace || card.oracleText.includes('\n//\n')) return [];
	const out: Row[] = [];
	const norm = normalizeFace(card.name, card.oracleText);
	const legacyAbilities = oracle.parseActivatedAbilities(card, [...WUBRG]);
	const triggers = runtimeTriggers(compileCard(card));
	const isSpell = /\b(?:Instant|Sorcery)\b/.test(card.typeLine);

	if (isSpell) {
		const parse = compiledStackItemEffects({ kind: 'spell', card } as StackItem);
		const legacy = oracle.parseSpellOrAbilityEffects(card);
		const path: Path =
			parse && staticallyInterpretable(parse) ? 'interpreter' : legacy.effects.length > 0 ? 'legacy' : 'manual';
		out.push({ card: card.name, kind: 'spell', text: norm.text, path });
	}

	for (const line of norm.lines) {
		const body = line.body;
		if (/^(?:when|whenever|at)\b/i.test(body)) {
			const t = triggers.find((x) => x.legacy.clause === line.raw);
			const path: Path = !t
				? 'manual'
				: t.effect && staticallyInterpretable(t.effect, true)
					? 'interpreter'
					: t.legacy.effects.length > 0
						? 'legacy'
						: 'manual';
			out.push({ card: card.name, kind: 'triggered', text: line.text, path });
			continue;
		}
		const quote = body.search(/["“]/);
		const colon = body.indexOf(':');
		if (colon <= 0 || (quote >= 0 && quote < colon) || /^choose\b/i.test(body)) continue;
		const effectRaw = line.raw.slice(line.raw.indexOf(':') + 1).trim();
		if (/^Add\b/.test(body.slice(colon + 1).trim())) {
			const prod = oracle.getPermanentManaProduction(card, [...WUBRG]);
			const legacy = legacyAbilities.find((a) => a.isManaAbility && (a.effectText === effectRaw || a.id === 'mana_tap'));
			// Exotic Orchard / Fellwar Stone: getEffectiveActivatedAbilities built their ability at run time.
			const opponentColors = /any color that a land an opponent controls could produce/.test(body);
			out.push({ card: card.name, kind: 'mana', text: line.text, path: legacy || prod.canTapForMana || opponentColors ? 'engine' : 'manual' });
			continue;
		}
		const ab = legacyAbilities.find((a) => a.effectText === effectRaw);
		const parse = compiledStackItemEffects({ kind: 'activated', card, oracleText: effectRaw } as StackItem);
		const legacyEffects = ab ? oracle.parseSpellOrAbilityEffects(card, ab.effectText).effects : [];
		const path: Path =
			ab && parse && staticallyInterpretable(parse) ? 'interpreter' : legacyEffects.length > 0 ? 'legacy' : 'manual';
		out.push({ card: card.name, kind: 'activated', text: line.text, path });
	}

	if (triggers.some((t) => t.legacy.effects.some((e) => e.kind === 'ward_trigger'))) {
		out.push({ card: card.name, kind: 'ward', text: 'Ward', path: 'engine' });
	}
	return out;
}

function helperTable(cards: ScryfallCard[]): string[] {
	const checks: Array<[string, (c: ScryfallCard) => unknown]> = [
		['getPermanentManaProduction', (c) => {
			const p = oracle.getPermanentManaProduction(c, [...WUBRG]);
			return p.canTapForMana ? `${p.colors.join('')} x${p.amount}` : null;
		}],
		['getCardExtraLandPlays', (c) => oracle.getCardExtraLandPlays(c) || null],
		['cardEntersAsCopyOfAnyCreature', (c) => oracle.cardEntersAsCopyOfAnyCreature(c) || null],
		['spellExilesSelfOnResolution', (c) => oracle.spellExilesSelfOnResolution(c) || null],
		['cardHasPrintedUnblockable', (c) => oracle.cardHasPrintedUnblockable(c) || null],
		['parseSuspendClause', (c) => {
			const s = oracle.parseSuspendClause(c);
			return s ? `${s.timeCounters} ${s.suspendCost}` : null;
		}],
		['parseDelayedTriggersFromSpell', (c) => oracle.parseDelayedTriggersFromSpell(c).map((d) => d.oracleText).join(' | ') || null],
		['parseLibrarySearchSpec', (c) => (oracle.parseLibrarySearchSpec(c.oracleText) ? 'spec' : null)],
		['parseAdditionalCostsAndRestrictions', (c) => {
			const a = oracle.parseAdditionalCostsAndRestrictions(c);
			const parts = Object.entries(a).filter(([, v]) => v !== null && v !== false && v !== 0);
			return parts.length ? parts.map(([k, v]) => `${k}=${v}`).join(',') : null;
		}],
		['detectTargetRequirement(spell)', (c) => {
			if (!/\b(?:Instant|Sorcery|Aura)\b/.test(c.typeLine)) return null;
			const t = oracle.detectTargetRequirement(c.oracleText);
			return t.requiresTarget ? `${t.targetKind} ${t.minTargets}-${t.maxTargets}${t.cardTypeFilter ? ` ${t.cardTypeFilter}` : ''}${t.controllerFilter !== 'any' ? ` ${t.controllerFilter}` : ''}` : null;
		}],
		['protection text (hasProtectionFrom)', (c) => (/protection from/i.test(c.oracleText) ? 'yes' : null)]
	];
	const lines: string[] = [];
	for (const [name, fn] of checks) {
		lines.push('', `### ${name}`, '');
		for (const c of cards) {
			const v = fn(c);
			if (v) lines.push(`- ${c.name}: ${v}`);
		}
	}
	return lines;
}

const cards = preconCards();
const rows = cards.flatMap(rowsFor);
if (process.argv.includes('--json')) {
	process.stdout.write(`${JSON.stringify(rows, null, '\t')}\n`);
} else if (process.argv.includes('--helpers')) {
	process.stdout.write(`${helperTable(cards).join('\n')}\n`);
} else {
	const count = (p: Path, k?: Row['kind']) => rows.filter((r) => r.path === p && (!k || r.kind === k)).length;
	const lines = ['| Kind | Interpreter | Legacy | Manual | Engine |', '|---|---:|---:|---:|---:|'];
	for (const k of ['spell', 'activated', 'mana', 'triggered', 'ward'] as const) {
		lines.push(`| ${k} | ${count('interpreter', k)} | ${count('legacy', k)} | ${count('manual', k)} | ${count('engine', k)} |`);
	}
	lines.push(`| total | ${count('interpreter')} | ${count('legacy')} | ${count('manual')} | ${count('engine')} |`);
	for (const p of ['legacy', 'manual'] as const) {
		lines.push('', `### ${p}`, '');
		for (const r of rows.filter((x) => x.path === p)) lines.push(`- ${r.card} (${r.kind}): ${r.text.replace(/\n/g, ' / ')}`);
	}
	process.stdout.write(`${lines.join('\n')}\n`);
}
