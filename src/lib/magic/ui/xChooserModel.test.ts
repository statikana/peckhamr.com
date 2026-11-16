import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	buildXQuickPresets,
	clampXChooserValue,
	computeXChooserSliderBounds,
	parseXChooserText
} from './xChooserModel.ts';

describe('xChooserModel', () => {
	it('clamps values within bounded and unbounded integer ranges', () => {
		assert.equal(clampXChooserValue(3.8, 0, null), 3);
		assert.equal(clampXChooserValue(-4, 0, null), 0);
		assert.equal(clampXChooserValue(Number.NaN, 1, 5), 1);
		assert.equal(clampXChooserValue(99, 1, 5), 5);
		assert.equal(clampXChooserValue(0, 1, 5), 1);
	});

	it('parses direct numeric text strictly without accepting partial junk', () => {
		assert.equal(parseXChooserText('', 0, 10), null);
		assert.equal(parseXChooserText('abc', 0, 10), null);
		assert.equal(parseXChooserText('7', 0, 10), 7);
		assert.equal(parseXChooserText('42', 0, 10), 10);
		assert.equal(parseXChooserText('-2', 1, 10), 1);
		assert.equal(parseXChooserText('42', 0, null), 42);
	});

	it('computes slider bounds for bounded ranges, affordable spell X, and unbounded fallbacks', () => {
		const bounded = computeXChooserSliderBounds({ value: 2, min: 1, max: 5 });
		assert.deepEqual(bounded, { min: 1, max: 5, sliderMax: 5, percent: 25 });

		const spellAffordable = computeXChooserSliderBounds({
			value: 3,
			min: 0,
			max: null,
			suggestedMax: 6
		});
		assert.deepEqual(spellAffordable, { min: 0, max: null, sliderMax: 6, percent: 50 });

		const manualOverBudget = computeXChooserSliderBounds({
			value: 9,
			min: 0,
			max: null,
			suggestedMax: 6
		});
		assert.deepEqual(manualOverBudget, { min: 0, max: null, sliderMax: 9, percent: 100 });

		const zeroBudgetFallback = computeXChooserSliderBounds({
			value: 0,
			min: 0,
			max: null,
			suggestedMax: 0
		});
		assert.deepEqual(zeroBudgetFallback, { min: 0, max: null, sliderMax: 5, percent: 0 });
	});

	it('builds compact clickable presets for small ranges, wide ranges, and spell X', () => {
		const smallRange = buildXQuickPresets({ min: 1, max: 4 });
		assert.deepEqual(
			smallRange.map((p) => [p.label, p.value]),
			[
				['1', 1],
				['2', 2],
				['3', 3],
				['Max (4)', 4]
			]
		);

		const wideRange = buildXQuickPresets({ min: 0, max: 12 });
		assert.deepEqual(
			wideRange.map((p) => [p.label, p.value]),
			[
				['Min (0)', 0],
				['1', 1],
				['Half (6)', 6],
				['Max (12)', 12]
			]
		);

		const spellX = buildXQuickPresets({ min: 0, max: null, suggestedMax: 4 });
		assert.deepEqual(
			spellX.map((p) => [p.testIdSuffix, p.value]),
			[
				['0', 0],
				['1', 1],
				['2', 2],
				['3', 3],
				['5', 5],
				['max', 4]
			]
		);
	});

	it('replaces native browser number spinbuttons with shared XValueChooser in gameplay X modals', () => {
		const uiDir = path.resolve('src/lib/magic/ui');
		for (const file of ['XValueChooser.svelte', 'XCostModal.svelte', 'ChoicePromptModal.svelte']) {
			const src = fs.readFileSync(path.join(uiDir, file), 'utf8');
			assert.equal(
				src.includes('type="number"'),
				false,
				`${file} should not render a native type="number" spinner input`
			);
		}

		const xModalSrc = fs.readFileSync(path.join(uiDir, 'XCostModal.svelte'), 'utf8');
		const choiceModalSrc = fs.readFileSync(path.join(uiDir, 'ChoicePromptModal.svelte'), 'utf8');
		assert.match(xModalSrc, /<XValueChooser[\s\S]*testIdPrefix="x"/);
		assert.match(choiceModalSrc, /<XValueChooser[\s\S]*max=\{choice\.max\}/);
	});
});
