/**
 * Wave 8 Track P22c modal bounds, conditional random-mode override, and
 * distinct-player-per-mode targeting runtime helpers.
 *
 * Pure IR and GameState metadata only — zero card-name literal comparisons,
 * zero runtime printed-text reads, and zero direct zone array mutations.
 */
import type { Condition, ModalDef } from '../ir.ts';
import type { StackItem, TargetRef } from '../types.ts';
import { resolveModalEffectiveBounds } from './framesModalsWave6.ts';
import type { FilterContext } from './objectFilter.ts';

export function resolveWave8ModalEffectiveBounds(
	modal: ModalDef,
	chooseAllActive: boolean,
	xValue: number | undefined,
	evaluatedDynamicMax: number | undefined,
	condChooseRangeMet: boolean
): { min: number; max: number } {
	const base = resolveModalEffectiveBounds(modal, chooseAllActive, xValue, evaluatedDynamicMax);
	if (!chooseAllActive && condChooseRangeMet && modal.conditionalChooseRange) {
		const min = Math.max(0, Math.min(modal.conditionalChooseRange.min, modal.modes.length));
		const max = Math.max(min, Math.min(modal.conditionalChooseRange.max, modal.modes.length));
		return { min, max };
	}
	return base;
}

export function isModalRandomActive(
	modal: ModalDef,
	evalCtx: FilterContext,
	evaluateCond: (c: Condition, ctx: FilterContext) => boolean
): boolean {
	if (!modal.randomMode) return false;
	if (modal.conditionalNotRandom && evaluateCond(modal.conditionalNotRandom, evalCtx)) {
		return false;
	}
	return true;
}

export function validateDifferentPlayerTargetsPerMode(
	modal: ModalDef,
	allSpecs: readonly { modeIndex: number; active: boolean }[],
	targetsBySpec: readonly TargetRef[][]
): { ok: boolean; error?: string } {
	if (!modal.differentPlayerTargetsPerMode) return { ok: true };
	const seenPlayers = new Set<string>();
	const playersByMode = new Map<number, Set<string>>();
	for (let i = 0; i < allSpecs.length; i++) {
		const entry = allSpecs[i]!;
		if (!entry.active) continue;
		const refs = targetsBySpec[i] ?? [];
		let modeSet = playersByMode.get(entry.modeIndex);
		if (!modeSet) {
			modeSet = new Set<string>();
			playersByMode.set(entry.modeIndex, modeSet);
		}
		for (const ref of refs) {
			if (ref.kind !== 'player') continue;
			if (seenPlayers.has(ref.id)) {
				return {
					ok: false,
					error: 'Each chosen mode must target a different player.'
				};
			}
			modeSet.add(ref.id);
		}
		// Flush only once modeIndex changes, or flush after loop:
		const nextEntry = allSpecs[i + 1];
		if (!nextEntry || nextEntry.modeIndex !== entry.modeIndex) {
			for (const pid of modeSet) seenPlayers.add(pid);
		}
	}
	return { ok: true };
}

export function buildTriggerModalSpecModeIndices(
	modal: ModalDef,
	item: StackItem
): number[] {
	const chosenModes = item.chosenModes ?? [];
	const modeOfSpec: number[] = [];
	for (let modePos = 0; modePos < chosenModes.length; modePos++) {
		const modeIdx = chosenModes[modePos]!;
		const mode = modal.modes[modeIdx];
		if (!mode) continue;
		for (let t = 0; t < mode.targets.length; t++) {
			modeOfSpec.push(modePos);
		}
	}
	return modeOfSpec;
}

export function filterTriggerDifferentPlayerCandidates(
	modal: ModalDef | undefined,
	item: StackItem,
	specIdx: number,
	priorTargetsBySpec: readonly TargetRef[][],
	candidates: readonly TargetRef[]
): TargetRef[] {
	if (!modal?.differentPlayerTargetsPerMode || specIdx <= 0) {
		return [...candidates];
	}
	const modeOfSpec = buildTriggerModalSpecModeIndices(modal, item);
	const curModePos = modeOfSpec[specIdx];
	if (curModePos === undefined) return [...candidates];

	const excluded = new Set<string>();
	for (let i = 0; i < priorTargetsBySpec.length; i++) {
		if (i === specIdx) continue;
		if (modeOfSpec[i] === curModePos) continue;
		for (const ref of priorTargetsBySpec[i] ?? []) {
			if (ref.kind === 'player') excluded.add(ref.id);
		}
	}
	if (excluded.size === 0) return [...candidates];
	return candidates.filter((c) => c.kind !== 'player' || !excluded.has(c.id));
}
