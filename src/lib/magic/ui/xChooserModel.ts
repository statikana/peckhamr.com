/**
 * Shared pure model helpers for MTG `{X}` spell/ability value pickers and
 * bounded `chooseNumber` prompts.
 */

export interface XQuickPreset {
	label: string;
	value: number;
	kind: 'value' | 'min' | 'half' | 'max';
	testIdSuffix: string;
}

export interface XChooserSliderBounds {
	min: number;
	max: number | null;
	sliderMax: number;
	percent: number;
}

export function normalizeBoundedInt(min: number, max?: number | null): { min: number; max: number | null } {
	const safeMin = Number.isFinite(min) ? Math.floor(min) : 0;
	const safeMax =
		max !== undefined && max !== null && Number.isFinite(max)
			? Math.max(safeMin, Math.floor(max))
			: null;
	return { min: safeMin, max: safeMax };
}

export function clampXChooserValue(value: number, min: number, max?: number | null): number {
	const bounds = normalizeBoundedInt(min, max);
	const intVal = Number.isFinite(value) ? Math.floor(value) : bounds.min;
	const aboveMin = Math.max(bounds.min, intVal);
	return bounds.max !== null ? Math.min(bounds.max, aboveMin) : aboveMin;
}

export function parseXChooserText(raw: string, min: number, max?: number | null): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const bounds = normalizeBoundedInt(min, max);
	if (!/^-?\d+$/.test(trimmed)) return null;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed)) return null;
	return clampXChooserValue(parsed, bounds.min, bounds.max);
}

export function computeXChooserSliderBounds(params: {
	value: number;
	min: number;
	max?: number | null;
	suggestedMax?: number | null;
}): XChooserSliderBounds {
	const { min, max } = normalizeBoundedInt(params.min, params.max);
	const clampedVal = clampXChooserValue(params.value, min, max);
	const safeSuggested =
		params.suggestedMax !== undefined && params.suggestedMax !== null && Number.isFinite(params.suggestedMax)
			? Math.max(min, Math.floor(params.suggestedMax))
			: null;

	let sliderMax: number;
	if (max !== null) {
		sliderMax = max;
	} else if (safeSuggested !== null && safeSuggested > min) {
		sliderMax = Math.max(safeSuggested, clampedVal);
	} else {
		sliderMax = Math.max(min + 5, clampedVal);
	}

	const span = sliderMax - min;
	const percent = span > 0 ? Math.min(100, Math.max(0, ((clampedVal - min) / span) * 100)) : 0;
	return { min, max, sliderMax, percent };
}

export function buildXQuickPresets(params: {
	min: number;
	max?: number | null;
	suggestedMax?: number | null;
	spellQuickPicks?: readonly number[];
}): XQuickPreset[] {
	const { min, max } = normalizeBoundedInt(params.min, params.max);
	const safeSuggested =
		params.suggestedMax !== undefined && params.suggestedMax !== null && Number.isFinite(params.suggestedMax)
			? Math.max(min, Math.floor(params.suggestedMax))
			: null;

	// Bounded integer range mode (`chooseNumber`)
	if (max !== null) {
		const span = max - min;
		if (span === 0) {
			return [{ label: `${min}`, value: min, kind: 'min', testIdSuffix: `${min}` }];
		}
		if (span <= 6) {
			const presets: XQuickPreset[] = [];
			for (let v = min; v <= max; v++) {
				presets.push({
					label: v === max ? `Max (${v})` : `${v}`,
					value: v,
					kind: v === max ? 'max' : v === min ? 'min' : 'value',
					testIdSuffix: v === max ? 'max' : `${v}`
				});
			}
			return presets;
		}
		const presets: XQuickPreset[] = [
			{ label: `Min (${min})`, value: min, kind: 'min', testIdSuffix: 'min' }
		];
		const seen = new Set<number>([min, max]);
		if (1 > min && 1 < max) {
			presets.push({ label: '1', value: 1, kind: 'value', testIdSuffix: '1' });
			seen.add(1);
		}
		const half = Math.floor((min + max) / 2);
		if (!seen.has(half)) {
			presets.push({ label: `Half (${half})`, value: half, kind: 'half', testIdSuffix: 'half' });
			seen.add(half);
		}
		presets.push({ label: `Max (${max})`, value: max, kind: 'max', testIdSuffix: 'max' });
		return presets;
	}

	// Open-ended spell / activation X mode (`XCostModal`)
	const picks = params.spellQuickPicks ?? [0, 1, 2, 3, 5];
	const presets: XQuickPreset[] = [];
	for (const p of picks) {
		if (p >= min) {
			presets.push({
				label: `${p}`,
				value: p,
				kind: 'value',
				testIdSuffix: `${p}`
			});
		}
	}
	if (safeSuggested !== null) {
		presets.push({
			label: `Max (${safeSuggested})`,
			value: safeSuggested,
			kind: 'max',
			testIdSuffix: 'max'
		});
	}
	return presets;
}
