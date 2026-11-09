import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import type { AbilityDef } from '../ir.ts';
import type { ScryfallCard, StackItem } from '../types.ts';
import { compileCard, compiledStackItemEffects, compiledTriggerEffect } from './index.ts';
import { staticallyInterpretable } from './interpretable.ts';
import { normalizeFace } from './normalize.ts';
import { cardSupportReport } from './support.ts';
import { runtimeTriggers } from './triggers.ts';

/**
 * Step F (ENGINE_ARCHITECTURE_PLAN.md Phase 10): one answer to "is this ability automated?".
 *
 * 1. No regression: every precon ability that was automated before step F (on the IR interpreter,
 *    on the legacy ParsedEffect fallback, or by engine code: mana abilities and Ward) is automated
 *    now, on the IR. The baseline (automation.baseline.json) was measured on the pre-step-F engine
 *    by scripts/magic-automation.ts.
 * 2. Agreement: for every ability of every precon card, the deck builder / inspector report
 *    (cardSupportReport) and the runtime's decision (the compiled effect the engine resolves on the
 *    interpreter, or none: manual resolution) say the same thing.
 */

interface BaselineRow {
	card: string;
	kind: 'spell' | 'activated' | 'mana' | 'triggered' | 'ward';
	text: string;
	path: 'interpreter' | 'legacy' | 'manual' | 'engine';
}

const BASELINE = JSON.parse(readFileSync(new URL('./automation.baseline.json', import.meta.url), 'utf8')) as BaselineRow[];

function preconCards(): Map<string, ScryfallCard> {
	const byName = new Map<string, ScryfallCard>();
	for (const c of Object.values(STAPLE_CARDS)) byName.set(c.name, c);
	for (const d of PRECON_DECKS) {
		for (const c of d.commanders) byName.set(c.name, c);
		for (const e of d.cards) byName.set(e.card.name, e.card);
	}
	return byName;
}

const CARDS = preconCards();

/** The ability of `card` on the line whose normalised text is `text`. */
function abilityOnLine(card: ScryfallCard, text: string): { ab: AbilityDef; index: number } | undefined {
	const norm = normalizeFace(card.name, card.oracleText);
	const abilities = compileCard(card).faces[0].abilities;
	const index = abilities.findIndex((a) => norm.text.slice(a.span.start, a.span.end) === text);
	return index >= 0 ? { ab: abilities[index], index } : undefined;
}

function automatedNow(row: BaselineRow): boolean {
	const card = CARDS.get(row.card);
	assert.ok(card, `precon card ${row.card}`);
	switch (row.kind) {
		case 'spell':
			return compiledStackItemEffects({ kind: 'spell', card } as StackItem) !== null;
		case 'ward':
			return runtimeTriggers(compileCard(card)).some((t) => t.ward?.costDefs && t.ward.costDefs.length > 0);
		case 'mana': {
			const found = abilityOnLine(card, row.text);
			if (found?.ab.kind === 'activated') return found.ab.isMana;
			// The mana is produced; an unparsed rider (Path of Ancestry's "When that mana is spent ...,
			// scry 1") was never automated, before or after step F.
			return found?.ab.kind === 'unsupported' && Boolean(found.ab.isMana && found.ab.effect?.some((s) => s.verb === 'addMana'));
		}
		case 'activated': {
			const found = abilityOnLine(card, row.text);
			if (found?.ab.kind !== 'activated') return false;
			return compiledStackItemEffects({ kind: 'activated', card, abilityId: found.ab.id } as StackItem) !== null;
		}
		case 'triggered': {
			const found = abilityOnLine(card, row.text);
			return found !== undefined && compiledTriggerEffect(card, found.index) !== null;
		}
	}
}

describe('Step F: precon automation does not regress', () => {
	it('the baseline covers the precon abilities', () => {
		assert.ok(BASELINE.length > 100);
	});
	for (const row of BASELINE.filter((r) => r.path !== 'manual')) {
		it(`${row.card} (${row.kind}, was ${row.path}) is automated on the IR`, () => {
			assert.equal(automatedNow(row), true, row.text);
		});
	}
	it('every precon Equip ability is automated', () => {
		for (const card of CARDS.values()) {
			for (const ab of compileCard(card).faces[0].abilities) {
				if (ab.kind === 'unsupported' && /^equip\b/i.test(ab.text)) assert.fail(`${card.name}: ${ab.text}`);
				if (ab.kind === 'keyword' && ab.keyword.name === 'equip') {
					assert.ok(ab.id, `${card.name}: equip has an id`);
					assert.ok(compiledStackItemEffects({ kind: 'activated', card, abilityId: ab.id } as StackItem), card.name);
				}
			}
		}
	});
});

describe('Step F: the support report and the runtime agree for every precon ability', () => {
	for (const card of CARDS.values()) {
		it(card.name, () => {
			const def = compileCard(card);
			const report = cardSupportReport(card);
			const reported = new Set(report.unsupported.map((u) => `${u.span.start}:${u.span.end}`));
			def.faces[0].abilities.forEach((ab, index) => {
				const key = `${ab.span.start}:${ab.span.end}`;
				let runtime: boolean | undefined;
				if (ab.kind === 'spell' || (ab.kind === 'unsupported' && ab.id === 'cast' && ab.reason === 'unparsed')) {
					runtime = compiledStackItemEffects({ kind: 'spell', card } as StackItem) !== null;
				} else if (ab.kind === 'activated' && !ab.isMana) {
					runtime = compiledStackItemEffects({ kind: 'activated', card, abilityId: ab.id } as StackItem) !== null;
				} else if (ab.kind === 'unsupported' && ab.id && !ab.isMana && ab.id !== 'cast') {
					runtime = compiledStackItemEffects({ kind: 'activated', card, abilityId: ab.id } as StackItem) !== null;
				} else if (ab.kind === 'triggered' || (ab.kind === 'unsupported' && ab.trigger)) {
					runtime = compiledTriggerEffect(card, index) !== null;
				}
				if (runtime === undefined) return;
				assert.equal(runtime, !reported.has(key), `${card.name}: ability ${index} (${ab.kind}) runtime=${runtime}`);
				if (runtime) {
					const eff = ab.kind === 'triggered' ? compiledTriggerEffect(card, index)! : null;
					if (eff) assert.equal(staticallyInterpretable(eff, true), true);
				}
			});
		});
	}
});
