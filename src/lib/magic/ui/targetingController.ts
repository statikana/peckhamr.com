import {
	abilityById,
	compileSpellEffects,
	effectOf,
	expandModalEffects,
	grantedAbilityById
} from '../compiler/index.ts';
import {
	checkSpellCastLegality,
	checkTurnFaceUpLegality,
	getCastOptions,
	validateTargetLegality
} from '../engine.ts';
import type { EffectStep, ModalDef, TargetSpec } from '../ir.ts';
import {
	NO_TARGET_REQUIREMENT,
	getSpellTargetRequirement,
	targetRequirementFromSpecs
} from '../ruleTree.ts';
import { activeCharacteristics } from '../runtime/faces.ts';
import { evaluateAmount } from '../runtime/objectFilter.ts';
import type {
	CardInstance,
	CastOption,
	EffectiveActivatedAbility,
	GameActionPayload,
	GameState,
	ManaColor,
	ScryfallCard,
	TargetRef,
	TargetRequirementInfo
} from '../types.ts';
import {
	createAllocationState,
	isValidAllocation,
	type AllocationState
} from './promptViewModel.ts';

export type CastableZone = 'hand' | 'command' | 'exile' | 'graveyard' | 'library' | 'battlefield';

export interface TargetingSession {
	mode: 'spell' | 'ability';
	instanceId: string;
	abilityId?: string;
	card: ScryfallCard;
	slotIndex: number;
	totalSlots: number;
	allSpecs: TargetSpec[];
	currentSpec: TargetSpec;
	currentRequirement: TargetRequirementInfo;
	/** Alias of `currentRequirement` for drop-in UI compatibility. */
	targetInfo: TargetRequirementInfo;
	/** Alias of `currentRequirement.targetKind` for drop-in UI compatibility. */
	targetKind: string;
	/** Locked targets accumulated from completed slots `0 .. slotIndex - 1`. */
	accumulatedTargets: TargetRef[];
	/** Targets currently picked in active slot `slotIndex`. */
	selectedTargets: TargetRef[];
	/** Remaining specs after `currentSpec` (`slotIndex + 1 .. totalSlots - 1`). */
	remainingSpecs: TargetSpec[];
	/** Per-slot chosen targets for completed slots `0 .. slotIndex - 1`. */
	slotTargetHistory: TargetRef[][];
	modes?: number[];
	fromZone?: CastableZone;
	xValue: number;
	optionId?: string;
	faceIndex?: number;
	fused?: boolean;
	optionalCostCounts?: Record<string, number>;
	costAidIds?: Record<string, string[]>;
	costAidColorChoices?: Record<string, ManaColor | 'generic'>;
	isAuraSingleSlot?: boolean;
	auraRequirement?: TargetRequirementInfo;
	/** CR 601.2d: Per-target divided damage/counter allocations accumulated from prior slots. */
	accumulatedDivisions?: Record<string, number>;
	/** Per-slot division history aligned with `slotTargetHistory` (`0 .. slotIndex - 1`). */
	slotDivisionHistory?: Array<Record<string, number>>;
	/** Pre-evaluated `divideTotal` pool per slot (`null` when the slot does not divide). */
	slotDivideAmounts?: Array<number | null>;
	/** Unit label (`'damage'` or `'counters'`) per slot. */
	slotDivideUnitLabels?: string[];
	/** Active slot's `divideTotal` pool (`>= 0`) when the active slot divides, otherwise `null`. */
	currentDivideAmount?: number | null;
	/** Unit label (`'damage'` or `'counters'`) for the active slot's allocation stepper. */
	currentDivideUnitLabel?: string;
	/** True when targets for the active `divideTotal` slot are chosen and awaiting allocation. */
	awaitingDivision?: boolean;
	/** Draft `AllocationState` when `awaitingDivision` is true. */
	draftAllocation?: AllocationState;
}

export interface PendingTargetArrowRef {
	target: TargetRef;
	id: string;
	kind: TargetRef['kind'];
	label: string;
	locked: boolean;
	/** 0-based slot index (`0 .. totalSlots - 1`). */
	slotIndex: number;
	/** 1-based slot number (`1 .. totalSlots`). */
	slotNumber: number;
}

export interface RequiredZoneDrawer {
	playerId: string;
	zone: 'graveyard' | 'exile';
}

export type TargetingTransitionResult =
	| { status: 'targeting'; session: TargetingSession }
	| { status: 'ready_to_submit'; payload: GameActionPayload }
	| { status: 'needs_mode_picker'; modal: ModalDef }
	| { status: 'invalid'; error: string };

export interface BeginSpellTargetingParams {
	inst: CardInstance;
	fromZone: CastableZone;
	gameState?: GameState;
	actorId?: string;
	xValue?: number;
	option?: CastOption;
	modes?: number[];
	optionalCostCounts?: Record<string, number>;
	costAidIds?: Record<string, string[]>;
	costAidColorChoices?: Record<string, ManaColor | 'generic'>;
}

export interface BeginAbilityTargetingParams {
	inst: CardInstance;
	ability: EffectiveActivatedAbility;
	gameState?: GameState;
	actorId?: string;
	chosenModes?: number[];
}

export type BeginModalTargetingParams =
	| {
			kind: 'spell';
			inst: CardInstance;
			modal: ModalDef;
			chosenModes: number[];
			allowAllModes?: boolean;
			fromZone: CastableZone;
			gameState?: GameState;
			actorId?: string;
			xValue?: number;
			option?: CastOption;
			optionalCostCounts?: Record<string, number>;
			costAidIds?: Record<string, string[]>;
			costAidColorChoices?: Record<string, ManaColor | 'generic'>;
	  }
	| {
			kind: 'ability';
			inst: CardInstance;
			ability: EffectiveActivatedAbility;
			modal: ModalDef;
			chosenModes: number[];
			allowAllModes?: boolean;
			gameState?: GameState;
			actorId?: string;
	  };

export interface ComputeMaxAffordableXParams {
	gameState: GameState;
	actorId: string;
	inst: CardInstance;
	fromZone: CastableZone | 'battlefield';
	actionKind?: 'cast_spell' | 'turn_face_up';
	castOption?: CastOption;
	optionalCostCounts?: Record<string, number>;
	costAidIds?: Record<string, string[]>;
	costAidColorChoices?: Record<string, ManaColor | 'generic'>;
}

function normalizeOptionalCounts(
	counts?: Record<string, number>
): Record<string, number> | undefined {
	if (!counts) return undefined;
	const entries = Object.entries(counts).filter(([, v]) => v > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeCostAidIds(
	aidIds?: Record<string, string[]>
): Record<string, string[]> | undefined {
	if (!aidIds) return undefined;
	const entries = Object.entries(aidIds).filter(([, ids]) => ids.length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeAidColors(
	aidColors?: Record<string, ManaColor | 'generic'>,
	aidIds?: Record<string, string[]>
): Record<string, ManaColor | 'generic'> | undefined {
	if (!aidColors) return undefined;
	const allowed = aidIds ? new Set(Object.values(aidIds).flat()) : null;
	const entries = Object.entries(aidColors).filter(
		([id, val]) => Boolean(val) && (!allowed || allowed.has(id))
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function selectsAllModalModes(
	option?: Partial<Pick<CastOption, 'optionalAdditionalCosts'>>,
	optionalCostCounts?: Record<string, number>
): boolean {
	if (!option?.optionalAdditionalCosts || !optionalCostCounts) return false;
	return option.optionalAdditionalCosts.some(
		(oc) => Boolean(oc.chooseAllModes) && (optionalCostCounts[oc.id] ?? 0) > 0
	);
}

function buildFinalPayload(
	base: Pick<
		TargetingSession,
		| 'mode'
		| 'instanceId'
		| 'abilityId'
		| 'modes'
		| 'fromZone'
		| 'xValue'
		| 'optionId'
		| 'faceIndex'
		| 'fused'
		| 'optionalCostCounts'
		| 'costAidIds'
		| 'costAidColorChoices'
	>,
	targets: TargetRef[],
	targetDivisions?: Record<string, number>
): GameActionPayload {
	const hasDivisions = Boolean(targetDivisions && Object.keys(targetDivisions).length > 0);
	if (base.mode === 'ability') {
		return {
			type: 'activate_ability',
			instanceId: base.instanceId,
			abilityId: base.abilityId ?? '',
			...(base.modes ? { chosenModes: base.modes } : {}),
			...(hasDivisions ? { targetDivisions } : {}),
			targets
		};
	}
	const hasOptCounts = Boolean(
		base.optionalCostCounts && Object.keys(base.optionalCostCounts).length > 0
	);
	const hasAidIds = Boolean(base.costAidIds && Object.keys(base.costAidIds).length > 0);
	if (
		base.fromZone === 'battlefield' &&
		base.optionId === 'battlefield:prepare_copy' &&
		!hasOptCounts &&
		!hasAidIds
	) {
		return {
			type: 'cast_preparation_copy',
			instanceId: base.instanceId,
			...(base.xValue > 0 ? { xValue: base.xValue } : {}),
			...(base.modes ? { modes: base.modes } : {}),
			...(hasDivisions ? { targetDivisions } : {}),
			targets
		};
	}
	return {
		type: 'cast_spell',
		instanceId: base.instanceId,
		fromZone: base.fromZone,
		xValue: base.xValue,
		...(base.modes ? { modes: base.modes } : {}),
		...(base.optionId ? { optionId: base.optionId } : {}),
		...(base.faceIndex !== undefined ? { faceIndex: base.faceIndex } : {}),
		...(base.fused ? { fused: true } : {}),
		...(hasOptCounts ? { optionalCostCounts: base.optionalCostCounts } : {}),
		...(hasAidIds ? { costAidIds: base.costAidIds } : {}),
		...(base.costAidColorChoices && Object.keys(base.costAidColorChoices).length > 0
			? { costAidColorChoices: base.costAidColorChoices }
			: {}),
		...(hasDivisions ? { targetDivisions } : {}),
		targets
	};
}

function evaluateSlotDivideAmount(
	spec: TargetSpec | undefined,
	ctx: {
		gameState?: GameState;
		actorId?: string;
		source?: CardInstance;
		xValue: number;
	}
): number | null {
	if (!spec?.divideTotal) return null;
	const amt = spec.divideTotal;
	if (amt.k === 'const') return Math.max(0, Math.trunc(amt.n));
	if (amt.k === 'x') return Math.max(0, Math.trunc(ctx.xValue));
	if (ctx.gameState) {
		return Math.max(
			0,
			Math.trunc(
				evaluateAmount(amt, {
					state: ctx.gameState,
					controllerId: ctx.actorId ?? ctx.source?.controllerId ?? '',
					source: ctx.source,
					xValue: ctx.xValue
				})
			)
		);
	}
	if (amt.k === 'countersOn' && amt.of.k === 'self' && ctx.source) {
		if (amt.counter === 'any') {
			return Object.values(ctx.source.counters).reduce(
				(sum, n) => sum + (n > 0 ? Math.trunc(n) : 0),
				0
			);
		}
		return Math.max(0, Math.trunc(ctx.source.counters[amt.counter] ?? 0));
	}
	return 0;
}

function inferDivideUnitLabel(steps?: readonly EffectStep[]): string {
	if (steps?.some((st) => st.verb === 'putCounters')) return 'counters';
	if (steps?.some((st) => st.verb === 'damage')) return 'damage';
	return 'damage';
}

function requirementForSlot(
	spec: TargetSpec,
	isAuraSingleSlot?: boolean,
	auraRequirement?: TargetRequirementInfo,
	divideAmount?: number | null
): TargetRequirementInfo {
	const base =
		isAuraSingleSlot && auraRequirement ? auraRequirement : targetRequirementFromSpecs([spec]);
	if (divideAmount === null || divideAmount === undefined) {
		return base;
	}
	// CR 601.2d: Each chosen target in a divided distribution must receive at least 1 unit.
	if (divideAmount <= 0) {
		return {
			...base,
			minTargets: 0,
			maxTargets: 0
		};
	}
	const cappedMax = Math.min(base.maxTargets, divideAmount);
	const cappedMin = Math.min(base.minTargets, cappedMax);
	return {
		...base,
		minTargets: cappedMin,
		maxTargets: cappedMax
	};
}

function createSessionFromSpecs(
	specs: TargetSpec[],
	meta: {
		mode: 'spell' | 'ability';
		instanceId: string;
		abilityId?: string;
		card: ScryfallCard;
		sourceInst?: CardInstance;
		gameState?: GameState;
		actorId?: string;
		unitLabel?: string;
		modes?: number[];
		fromZone?: CastableZone;
		xValue: number;
		optionId?: string;
		faceIndex?: number;
		fused?: boolean;
		optionalCostCounts?: Record<string, number>;
		costAidIds?: Record<string, string[]>;
		costAidColorChoices?: Record<string, ManaColor | 'generic'>;
		isAuraSingleSlot?: boolean;
		auraRequirement?: TargetRequirementInfo;
	}
): TargetingSession {
	const slotDivideAmounts = specs.map((sp) =>
		evaluateSlotDivideAmount(sp, {
			gameState: meta.gameState,
			actorId: meta.actorId,
			source: meta.sourceInst,
			xValue: meta.xValue
		})
	);
	const defaultUnit = meta.unitLabel ?? 'damage';
	const slotDivideUnitLabels = specs.map(() => defaultUnit);
	const firstSpec = specs[0];
	const firstDivideAmount = slotDivideAmounts[0] ?? null;
	const firstReq = requirementForSlot(
		firstSpec,
		meta.isAuraSingleSlot,
		meta.auraRequirement,
		firstDivideAmount
	);
	const hasAnyDividedSlot = slotDivideAmounts.some((d) => d !== null);
	return {
		mode: meta.mode,
		instanceId: meta.instanceId,
		...(meta.abilityId !== undefined ? { abilityId: meta.abilityId } : {}),
		card: meta.card,
		slotIndex: 0,
		totalSlots: specs.length,
		allSpecs: specs,
		currentSpec: firstSpec,
		currentRequirement: firstReq,
		targetInfo: firstReq,
		targetKind: firstReq.targetKind,
		accumulatedTargets: [],
		selectedTargets: [],
		remainingSpecs: specs.slice(1),
		slotTargetHistory: [],
		...(hasAnyDividedSlot
			? {
					accumulatedDivisions: {},
					slotDivisionHistory: [],
					slotDivideAmounts,
					slotDivideUnitLabels,
					currentDivideAmount: firstDivideAmount,
					currentDivideUnitLabel: slotDivideUnitLabels[0] ?? defaultUnit,
					awaitingDivision: false
				}
			: {}),
		...(meta.modes ? { modes: meta.modes } : {}),
		...(meta.fromZone ? { fromZone: meta.fromZone } : {}),
		xValue: meta.xValue,
		...(meta.optionId ? { optionId: meta.optionId } : {}),
		...(meta.faceIndex !== undefined ? { faceIndex: meta.faceIndex } : {}),
		...(meta.fused ? { fused: true } : {}),
		...(meta.optionalCostCounts ? { optionalCostCounts: meta.optionalCostCounts } : {}),
		...(meta.costAidIds ? { costAidIds: meta.costAidIds } : {}),
		...(meta.costAidColorChoices ? { costAidColorChoices: meta.costAidColorChoices } : {}),
		...(meta.isAuraSingleSlot ? { isAuraSingleSlot: true } : {}),
		...(meta.auraRequirement ? { auraRequirement: meta.auraRequirement } : {})
	};
}

/**
 * Extracts sequential `TargetSpec[]` for a modal spell or modal activated ability given `chosenModes`,
 * preserving cross-mode target index shifts and conditional cast-time target filters.
 */
export function extractModalTargetSpecs(
	modal: ModalDef,
	chosenModes: number[],
	card?: ScryfallCard,
	option?: Partial<Pick<CastOption, 'faceIndex' | 'fused' | 'optionalAdditionalCosts' | 'spellMods'>>,
	optionalCostCounts?: Record<string, number>
): TargetSpec[] {
	if (option?.spellMods?.castFaceDown || option?.spellMods?.targetsBecomeEach) {
		return [];
	}
	let effectiveModal = modal;
	if (card) {
		const spellReq = getSpellTargetRequirement(card, option, optionalCostCounts);
		if (spellReq.isModal && spellReq.modalBranches) {
			effectiveModal = {
				...modal,
				modes: modal.modes.map((m, idx) => ({
					...m,
					targets: spellReq.modalBranches?.[idx]?.targetSpecs ?? m.targets
				}))
			};
		}
	}
	const expanded = expandModalEffects(effectiveModal, chosenModes);
	if (!expanded) return [];
	return expanded.targets.filter((sp) => sp.max > 0);
}

/**
 * Extracts sequential `TargetSpec[]` for casting `card` with `option` and `optionalCostCounts`.
 */
export function extractSpellTargetSpecs(
	card: ScryfallCard,
	option?: Partial<Pick<CastOption, 'faceIndex' | 'fused' | 'optionalAdditionalCosts' | 'spellMods'>>,
	optionalCostCounts?: Record<string, number>
): {
	specs: TargetSpec[];
	isAuraSingleSlot: boolean;
	auraRequirement?: TargetRequirementInfo;
	modal?: ModalDef;
	autoChosenModes?: number[];
} {
	if (option?.spellMods?.castFaceDown || option?.spellMods?.targetsBecomeEach) {
		return { specs: [], isAuraSingleSlot: false };
	}

	const faceIndex = option?.faceIndex ?? 0;
	const fused = Boolean(option?.fused);
	const compiledSpell = fused ? null : compileSpellEffects(card, faceIndex, false);
	if (compiledSpell?.modal) {
		if (selectsAllModalModes(option, optionalCostCounts)) {
			const allModeIndices = compiledSpell.modal.modes.map((_, idx) => idx);
			const specs = extractModalTargetSpecs(
				compiledSpell.modal,
				allModeIndices,
				card,
				option,
				optionalCostCounts
			);
			return {
				specs,
				isAuraSingleSlot: false,
				modal: compiledSpell.modal,
				autoChosenModes: allModeIndices
			};
		}
		return {
			specs: [],
			isAuraSingleSlot: false,
			modal: compiledSpell.modal
		};
	}

	const chars = activeCharacteristics(card, { zone: 'stack', faceIndex, fused });
	const isAura =
		chars.subtypes.includes('Aura') &&
		!chars.types.includes('Instant') &&
		!chars.types.includes('Sorcery');
	const req = getSpellTargetRequirement(card, option, optionalCostCounts);
	const rawSpecs = (req.targetSpecs ?? []).filter((sp) => sp.max > 0);

	if (isAura && rawSpecs.length > 0) {
		return {
			specs: [rawSpecs[0]],
			isAuraSingleSlot: true,
			auraRequirement: req
		};
	}

	return {
		specs: rawSpecs,
		isAuraSingleSlot: false
	};
}

function synthesizeSpecFromRequirement(info: TargetRequirementInfo): TargetSpec[] {
	if (info.maxTargets <= 0 || info.targetKind === 'none') return [];
	if (info.targetKind === 'player' || info.zone === 'player') {
		const relation =
			info.controllerFilter === 'opponent'
				? 'opponent'
				: info.controllerFilter === 'you'
					? 'you'
					: 'any';
		return [
			{
				kind: 'player',
				filter: {},
				player: { relation },
				min: info.minTargets,
				max: info.maxTargets
			}
		];
	}
	if (info.targetKind === 'any' || info.zone === 'any') {
		return [
			{
				kind: 'objectOrPlayer',
				filter: { zone: 'battlefield' },
				player: { relation: 'any' },
				min: info.minTargets,
				max: info.maxTargets
			}
		];
	}
	const zone =
		info.zone === 'graveyard' || info.zone === 'exile' || info.zone === 'stack'
			? info.zone
			: 'battlefield';
	return [
		{
			kind: 'object',
			filter: {
				zone,
				...(info.controllerFilter !== 'any' ? { controller: info.controllerFilter } : {})
			},
			...(info.sameGraveyard ? { sameOwner: true } : {}),
			min: info.minTargets,
			max: info.maxTargets
		}
	];
}

/**
 * Extracts sequential `TargetSpec[]` for an activated ability (battlefield, graveyard, or hand).
 */
export function extractAbilityTargetSpecs(
	card: ScryfallCard,
	ability: EffectiveActivatedAbility
): TargetSpec[] {
	if (ability.modal) return [];
	const fromTargetInfo = ability.targetInfo?.targetSpecs?.filter((sp) => sp.max > 0);
	if (fromTargetInfo && fromTargetInfo.length > 0) {
		return fromTargetInfo;
	}
	const faceIndex = ability.faceIndex ?? 0;
	const irAb =
		ability.grantSourceCard && ability.id.startsWith('granted:')
			? grantedAbilityById(
					ability.grantSourceCard,
					ability.id.slice(ability.id.lastIndexOf(':') + 1)
				)
			: abilityById(card, ability.id, faceIndex);
	const compiled = effectOf(irAb);
	const fromIr = compiled?.targets.filter((sp) => sp.max > 0);
	if (fromIr && fromIr.length > 0) {
		return fromIr;
	}
	return synthesizeSpecFromRequirement(ability.targetInfo ?? NO_TARGET_REQUIREMENT);
}

function finalizeCreatedSession(session: TargetingSession): TargetingTransitionResult {
	let cur = session;
	for (let guard = 0; guard < 16; guard++) {
		if (
			cur.currentRequirement.minTargets === 0 &&
			cur.currentRequirement.maxTargets === 0
		) {
			const advanced = confirmCurrentSlot(cur);
			if (advanced.status !== 'targeting') return advanced;
			cur = advanced.session;
			continue;
		}
		break;
	}
	return { status: 'targeting', session: cur };
}

/**
 * Starts targeting for casting a spell (non-modal, all-modes modal, pre-selected modal, multi-face, or fused).
 */
export function beginSpellTargeting(params: BeginSpellTargetingParams): TargetingTransitionResult {
	const xValue = params.xValue ?? 0;
	const optionalCostCounts = normalizeOptionalCounts(params.optionalCostCounts);
	const costAidIds = normalizeCostAidIds(params.costAidIds);
	const costAidColorChoices = normalizeAidColors(params.costAidColorChoices, costAidIds);
	const spellCard =
		params.fromZone === 'battlefield'
			? (params.inst.copiableCard ?? params.inst.card)
			: params.inst.card;

	const extracted = extractSpellTargetSpecs(
		spellCard,
		params.option,
		optionalCostCounts
	);

	if (extracted.modal && !extracted.autoChosenModes) {
		if (!params.modes) {
			return { status: 'needs_mode_picker', modal: extracted.modal };
		}
		return beginModalTargeting({
			kind: 'spell',
			inst: params.inst,
			modal: extracted.modal,
			chosenModes: params.modes,
			fromZone: params.fromZone,
			xValue,
			option: params.option,
			optionalCostCounts,
			costAidIds,
			costAidColorChoices,
			gameState: params.gameState,
			actorId: params.actorId
		});
	}

	const compiledSpell = params.option?.fused
		? null
		: compileSpellEffects(spellCard, params.option?.faceIndex ?? 0, false);
	const unitLabel = inferDivideUnitLabel(compiledSpell?.steps);

	const effectiveModes = extracted.autoChosenModes ?? params.modes;
	const baseMeta = {
		mode: 'spell' as const,
		instanceId: params.inst.instanceId,
		card: spellCard,
		sourceInst: params.inst,
		gameState: params.gameState,
		actorId: params.actorId,
		unitLabel,
		modes: effectiveModes,
		fromZone: params.fromZone,
		xValue,
		optionId: params.option?.id,
		faceIndex: params.option?.faceIndex,
		fused: params.option?.fused,
		optionalCostCounts,
		costAidIds,
		costAidColorChoices,
		isAuraSingleSlot: extracted.isAuraSingleSlot,
		auraRequirement: extracted.auraRequirement
	};

	if (extracted.specs.length === 0) {
		return {
			status: 'ready_to_submit',
			payload: buildFinalPayload(baseMeta, [])
		};
	}

	return finalizeCreatedSession(createSessionFromSpecs(extracted.specs, baseMeta));
}

/**
 * Starts targeting for an activated ability (battlefield, graveyard, or hand zone).
 */
export function beginAbilityTargeting(
	params: BeginAbilityTargetingParams
): TargetingTransitionResult {
	if (params.ability.modal) {
		if (!params.chosenModes) {
			return { status: 'needs_mode_picker', modal: params.ability.modal };
		}
		return beginModalTargeting({
			kind: 'ability',
			inst: params.inst,
			ability: params.ability,
			modal: params.ability.modal,
			chosenModes: params.chosenModes,
			gameState: params.gameState,
			actorId: params.actorId
		});
	}

	const abCard = params.inst.copiableCard ?? params.inst.card;
	const specs = extractAbilityTargetSpecs(abCard, params.ability);
	const faceIndex = params.ability.faceIndex ?? 0;
	const irAb =
		params.ability.grantSourceCard && params.ability.id.startsWith('granted:')
			? grantedAbilityById(
					params.ability.grantSourceCard,
					params.ability.id.slice(params.ability.id.lastIndexOf(':') + 1)
				)
			: abilityById(abCard, params.ability.id, faceIndex);
	const unitLabel = inferDivideUnitLabel(effectOf(irAb)?.steps);

	const baseMeta = {
		mode: 'ability' as const,
		instanceId: params.inst.instanceId,
		abilityId: params.ability.id,
		card: abCard,
		sourceInst: params.inst,
		gameState: params.gameState,
		actorId: params.actorId,
		unitLabel,
		xValue: 0
	};

	if (specs.length === 0) {
		return {
			status: 'ready_to_submit',
			payload: buildFinalPayload(baseMeta, [])
		};
	}

	return finalizeCreatedSession(createSessionFromSpecs(specs, baseMeta));
}

/**
 * Starts targeting after mode selection in a modal spell or modal activated ability.
 */
export function beginModalTargeting(params: BeginModalTargetingParams): TargetingTransitionResult {
	const { modal, chosenModes, allowAllModes = false } = params;
	if (
		!allowAllModes &&
		(chosenModes.length < modal.min ||
			chosenModes.length > modal.max ||
			(!modal.allowRepeat && new Set(chosenModes).size !== chosenModes.length))
	) {
		return {
			status: 'invalid',
			error: `Choose ${modal.min === modal.max ? modal.min : `${modal.min}–${modal.max}`} mode(s).`
		};
	}

	const unitLabel = inferDivideUnitLabel(expandModalEffects(modal, chosenModes)?.steps);

	if (params.kind === 'spell') {
		const optionalCostCounts = normalizeOptionalCounts(params.optionalCostCounts);
		const costAidIds = normalizeCostAidIds(params.costAidIds);
		const costAidColorChoices = normalizeAidColors(params.costAidColorChoices, costAidIds);
		const spellCard =
			params.fromZone === 'battlefield'
				? (params.inst.copiableCard ?? params.inst.card)
				: params.inst.card;
		const specs = extractModalTargetSpecs(
			modal,
			chosenModes,
			spellCard,
			params.option,
			optionalCostCounts
		);
		const baseMeta = {
			mode: 'spell' as const,
			instanceId: params.inst.instanceId,
			card: spellCard,
			sourceInst: params.inst,
			gameState: params.gameState,
			actorId: params.actorId,
			unitLabel,
			modes: chosenModes,
			fromZone: params.fromZone,
			xValue: params.xValue ?? 0,
			optionId: params.option?.id,
			faceIndex: params.option?.faceIndex,
			fused: params.option?.fused,
			optionalCostCounts,
			costAidIds,
			costAidColorChoices
		};
		if (specs.length === 0) {
			return {
				status: 'ready_to_submit',
				payload: buildFinalPayload(baseMeta, [])
			};
		}
		return finalizeCreatedSession(createSessionFromSpecs(specs, baseMeta));
	}

	const abCard = params.inst.copiableCard ?? params.inst.card;
	const specs = extractModalTargetSpecs(modal, chosenModes);
	const baseMeta = {
		mode: 'ability' as const,
		instanceId: params.inst.instanceId,
		abilityId: params.ability.id,
		card: abCard,
		sourceInst: params.inst,
		gameState: params.gameState,
		actorId: params.actorId,
		unitLabel,
		modes: chosenModes,
		xValue: 0
	};
	if (specs.length === 0) {
		return {
			status: 'ready_to_submit',
			payload: buildFinalPayload(baseMeta, [])
		};
	}
	return finalizeCreatedSession(createSessionFromSpecs(specs, baseMeta));
}

/**
 * Starts targeting when a card is dragged from `fromZone` and dropped directly onto `droppedTarget`.
 * Validates slot 1 against `droppedTarget`: 1-slot spells submit immediately, while multi-slot spells
 * lock `droppedTarget` into slot 1 and advance cleanly to slot 2.
 */
export function beginDropTargeting(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableZone,
	droppedTarget: TargetRef,
	candidateOptions?: CastOption[]
): TargetingTransitionResult {
	const options = candidateOptions ?? getCastOptions(state, actorId, inst, fromZone);
	for (const opt of options) {
		if (opt.spellMods.targetsBecomeEach || opt.spellMods.castFaceDown || opt.choosesX) continue;
		const legality = checkSpellCastLegality(
			state,
			actorId,
			inst,
			fromZone,
			0,
			opt.id,
			undefined,
			opt.faceIndex,
			opt.fused,
			undefined,
			undefined,
			true
		);
		if (!legality.ok) continue;

		const started = beginSpellTargeting({
			inst,
			fromZone,
			xValue: 0,
			option: opt,
			gameState: state,
			actorId
		});
		if (started.status !== 'targeting') continue;
		if (!isCandidateLegalForCurrentSlot(state, actorId, started.session, droppedTarget)) continue;
		return toggleOrAdvanceTarget(state, actorId, started.session, droppedTarget);
	}
	return {
		status: 'invalid',
		error: 'Dropped target is not legal for the first target slot of any castable option.'
	};
}

/**
 * Checks whether `candidate` is already selected in the active slot (`selectedTargets`).
 */
export function isCandidateSelectedInCurrentSlot(
	session: TargetingSession | null,
	candidateId: string,
	candidateKind?: TargetRef['kind']
): boolean {
	if (!session) return false;
	return session.selectedTargets.some(
		(t) => t.id === candidateId && (candidateKind === undefined || t.kind === candidateKind)
	);
}

/**
 * Checks whether `candidate` was already locked in an earlier slot (`accumulatedTargets`).
 */
export function isCandidateLockedInPriorSlot(
	session: TargetingSession | null,
	candidateId: string,
	candidateKind?: TargetRef['kind']
): boolean {
	if (!session) return false;
	return session.accumulatedTargets.some(
		(t) => t.id === candidateId && (candidateKind === undefined || t.kind === candidateKind)
	);
}

/**
 * Validates whether `candidate` can be newly added to `session`'s current slot.
 * Enforces `CR 115.3` (`otherTarget: true` against `accumulatedTargets` and uniqueness within the active slot),
 * single-graveyard constraints (`sameGraveyard`), slot capacity, and `validateTargetLegality`.
 */
export function validateCandidateForCurrentSlot(
	state: GameState,
	actorId: string,
	session: TargetingSession,
	candidate: TargetRef
): { ok: boolean; error?: string } {
	const req = session.currentRequirement;
	if (req.maxTargets <= 0) {
		return { ok: false, error: 'Current target slot does not accept targets.' };
	}
	if (session.selectedTargets.length >= req.maxTargets) {
		return { ok: false, error: 'Current target slot is already full.' };
	}
	if (session.selectedTargets.some((t) => t.id === candidate.id)) {
		return {
			ok: false,
			error: 'The same object cannot be chosen multiple times for the same target slot (CR 115.3).'
		};
	}
	if (session.currentSpec?.otherTarget && session.accumulatedTargets.some((t) => t.id === candidate.id)) {
		return {
			ok: false,
			error: '"Another target" must be a different object from earlier target(s) (CR 115.3).'
		};
	}
	if (req.zone === 'graveyard' && req.sameGraveyard && session.selectedTargets.length > 0) {
		const firstId = session.selectedTargets[0].id;
		const firstOwner = state.players.find((p) =>
			p.graveyard.some((c) => c.instanceId === firstId)
		);
		const candOwner = state.players.find((p) =>
			p.graveyard.some((c) => c.instanceId === candidate.id)
		);
		if (firstOwner && candOwner && firstOwner.playerId !== candOwner.playerId) {
			return {
				ok: false,
				error: 'All targets in this slot must be in the same single graveyard.'
			};
		}
	}
	return validateTargetLegality(
		state,
		actorId,
		candidate,
		req,
		session.card,
		session.instanceId
	);
}

/**
 * Boolean convenience check for whether `candidate` is a legal new target for `session`'s active slot.
 */
export function isCandidateLegalForCurrentSlot(
	state: GameState,
	actorId: string,
	session: TargetingSession | null,
	candidate: TargetRef
): boolean {
	if (!session) return false;
	return validateCandidateForCurrentSlot(state, actorId, session, candidate).ok;
}

/**
 * Returns true when a UI element representing `candidate` should be clickable during `session`:
 * either it is already selected in the current slot (clicking toggles it off) or it is legal for the current slot.
 */
export function canClickTargetCandidate(
	state: GameState,
	actorId: string,
	session: TargetingSession | null,
	candidate: TargetRef
): boolean {
	if (!session || session.awaitingDivision) return false;
	if (isCandidateSelectedInCurrentSlot(session, candidate.id, candidate.kind)) {
		return true;
	}
	return isCandidateLegalForCurrentSlot(state, actorId, session, candidate);
}

/**
 * Returns true whenever the active slot satisfies `minTargets` (including `minTargets === 0` optional slots).
 */
export function canConfirmCurrentSlot(session: TargetingSession | null): boolean {
	if (!session) return false;
	const { minTargets, maxTargets } = session.currentRequirement;
	return (
		session.selectedTargets.length >= minTargets &&
		session.selectedTargets.length <= maxTargets
	);
}

/**
 * Returns true when the active slot is optional (`minTargets === 0`) and zero targets are currently selected.
 */
export function canSkipOptionalSlot(session: TargetingSession | null): boolean {
	if (!session || session.awaitingDivision) return false;
	return (
		session.currentRequirement.minTargets === 0 && session.selectedTargets.length === 0
	);
}

function advanceOrSubmitSlot(
	session: TargetingSession,
	slotDivisions: Record<string, number>
): TargetingTransitionResult {
	const nextAccumulated = [...session.accumulatedTargets, ...session.selectedTargets];
	const nextHistory = [...session.slotTargetHistory, [...session.selectedTargets]];
	const hasDivTracking = session.slotDivideAmounts !== undefined;
	const nextDivHistory = hasDivTracking
		? [...(session.slotDivisionHistory ?? []), slotDivisions]
		: undefined;
	const nextDivisions = hasDivTracking
		? { ...(session.accumulatedDivisions ?? {}), ...slotDivisions }
		: session.accumulatedDivisions;

	if (session.remainingSpecs.length > 0) {
		const [nextSpec, ...restSpecs] = session.remainingSpecs;
		const nextSlotIndex = session.slotIndex + 1;
		const nextDivideAmount = session.slotDivideAmounts?.[nextSlotIndex] ?? null;
		const nextDivideUnitLabel = session.slotDivideUnitLabels?.[nextSlotIndex] ?? 'damage';
		const nextReq = requirementForSlot(nextSpec, false, undefined, nextDivideAmount);
		return finalizeCreatedSession({
			...session,
			slotIndex: nextSlotIndex,
			currentSpec: nextSpec,
			currentRequirement: nextReq,
			targetInfo: nextReq,
			targetKind: nextReq.targetKind,
			accumulatedTargets: nextAccumulated,
			selectedTargets: [],
			remainingSpecs: restSpecs,
			slotTargetHistory: nextHistory,
			...(hasDivTracking
				? {
						accumulatedDivisions: nextDivisions ?? {},
						slotDivisionHistory: nextDivHistory ?? [],
						currentDivideAmount: nextDivideAmount,
						currentDivideUnitLabel: nextDivideUnitLabel,
						awaitingDivision: false,
						draftAllocation: undefined
					}
				: {})
		});
	}

	return {
		status: 'ready_to_submit',
		payload: buildFinalPayload(session, nextAccumulated, nextDivisions)
	};
}

/**
 * Updates `session.draftAllocation` while in the `awaitingDivision` step.
 */
export function updateSlotDraftAllocation(
	session: TargetingSession,
	allocations: Record<string, number>
): TargetingSession {
	if (!session.awaitingDivision || session.currentDivideAmount === null || session.currentDivideAmount === undefined) {
		return session;
	}
	return {
		...session,
		draftAllocation: createAllocationState({
			targetIds: session.selectedTargets.map((t) => t.id),
			amountToDistribute: session.currentDivideAmount,
			minPerTarget: 1,
			initial: allocations
		})
	};
}

/**
 * Validates and locks per-target integer divisions (`CR 601.2d`: every chosen target receives >= 1
 * and the shares sum exactly to `currentDivideAmount`), then advances to the next slot or submits.
 */
export function confirmSlotDivisions(
	session: TargetingSession,
	divisions: Record<string, number>
): TargetingTransitionResult {
	if (!canConfirmCurrentSlot(session)) {
		return {
			status: 'invalid',
			error: `Select at least ${session.currentRequirement.minTargets} target(s) for slot ${session.slotIndex + 1}.`
		};
	}
	const divideAmount = session.currentDivideAmount;
	if (divideAmount === null || divideAmount === undefined) {
		return {
			status: 'invalid',
			error: 'Current target slot does not divide an amount.'
		};
	}
	if (session.selectedTargets.length === 0) {
		if (Object.values(divisions).some((v) => v !== 0)) {
			return { status: 'invalid', error: 'Cannot allocate units when zero targets are chosen.' };
		}
		return advanceOrSubmitSlot(session, {});
	}

	const targetIds = session.selectedTargets.map((t) => t.id);
	const targetIdSet = new Set(targetIds);
	for (const [k, v] of Object.entries(divisions)) {
		if (!targetIdSet.has(k) && v !== 0) {
			return {
				status: 'invalid',
				error: `Division includes unselected target "${k}".`
			};
		}
	}

	let sum = 0;
	const cleanDivisions: Record<string, number> = {};
	for (const id of targetIds) {
		const share = divisions[id];
		if (share === undefined || !Number.isInteger(share) || share < 1) {
			return {
				status: 'invalid',
				error: 'Each chosen target must receive at least 1 (CR 601.2d).'
			};
		}
		cleanDivisions[id] = share;
		sum += share;
	}
	if (sum !== divideAmount) {
		return {
			status: 'invalid',
			error: `Divided amounts must sum to ${divideAmount} (currently ${sum}).`
		};
	}
	const checkState = createAllocationState({
		targetIds,
		amountToDistribute: divideAmount,
		minPerTarget: 1,
		initial: cleanDivisions
	});
	if (!isValidAllocation(checkState)) {
		return {
			status: 'invalid',
			error: 'Invalid target division allocation.'
		};
	}

	return advanceOrSubmitSlot(session, cleanDivisions);
}

/**
 * Confirms the current slot (including skipping with 0 targets when `minTargets === 0`).
 * For `CR 601.2d` divided slots (`currentDivideAmount !== null`), auto-allocates trivial 0/1/`N`-for-`N`
 * target sets immediately, or transitions into `awaitingDivision: true` for `<AllocationStepperWidget>`.
 */
export function confirmCurrentSlot(session: TargetingSession): TargetingTransitionResult {
	if (!canConfirmCurrentSlot(session)) {
		return {
			status: 'invalid',
			error: `Select at least ${session.currentRequirement.minTargets} target(s) for slot ${session.slotIndex + 1}.`
		};
	}

	const divideAmount = session.currentDivideAmount ?? null;
	if (divideAmount !== null) {
		if (session.awaitingDivision) {
			return confirmSlotDivisions(session, session.draftAllocation?.allocations ?? {});
		}
		const count = session.selectedTargets.length;
		if (count === 0) {
			return advanceOrSubmitSlot(session, {});
		}
		if (count === 1) {
			return advanceOrSubmitSlot(session, {
				[session.selectedTargets[0].id]: divideAmount
			});
		}
		if (count === divideAmount) {
			const unitSplit: Record<string, number> = {};
			for (const t of session.selectedTargets) {
				unitSplit[t.id] = 1;
			}
			return advanceOrSubmitSlot(session, unitSplit);
		}
		const draftAllocation = createAllocationState({
			targetIds: session.selectedTargets.map((t) => t.id),
			amountToDistribute: divideAmount,
			minPerTarget: 1
		});
		return {
			status: 'targeting',
			session: {
				...session,
				awaitingDivision: true,
				draftAllocation
			}
		};
	}

	return advanceOrSubmitSlot(session, {});
}

/**
 * Toggles `candidate` off if already selected in the active slot, or validates & appends `candidate`.
 * Automatically advances/submits when the active slot reaches `maxTargets`.
 */
export function toggleOrAdvanceTarget(
	state: GameState,
	actorId: string,
	session: TargetingSession,
	candidate: TargetRef
): TargetingTransitionResult {
	if (session.awaitingDivision) {
		return {
			status: 'invalid',
			error: 'Step back from division allocation before modifying targets.'
		};
	}
	const existingIdx = session.selectedTargets.findIndex(
		(t) => t.id === candidate.id && t.kind === candidate.kind
	);
	if (existingIdx >= 0) {
		const nextSelected = session.selectedTargets.filter((_, idx) => idx !== existingIdx);
		return {
			status: 'targeting',
			session: {
				...session,
				selectedTargets: nextSelected
			}
		};
	}

	const validation = validateCandidateForCurrentSlot(state, actorId, session, candidate);
	if (!validation.ok) {
		return {
			status: 'invalid',
			error: validation.error ?? 'Illegal target for current slot.'
		};
	}

	const nextSelected = [...session.selectedTargets, candidate];
	const maxReq = Math.max(1, session.currentRequirement.maxTargets);
	const updatedSession: TargetingSession = {
		...session,
		selectedTargets: nextSelected
	};

	if (nextSelected.length >= maxReq) {
		return confirmCurrentSlot(updatedSession);
	}

	return {
		status: 'targeting',
		session: updatedSession
	};
}

/**
 * Rewinds `session` from `awaitingDivision` back to target selection on the active slot,
 * or rewinds to `slotIndex - 1` (restoring the previous slot's `selectedTargets`).
 */
export function stepBackToPreviousSlot(session: TargetingSession): TargetingSession {
	if (session.awaitingDivision) {
		const { draftAllocation: _discarded, ...rest } = session;
		return {
			...rest,
			awaitingDivision: false
		};
	}
	if (session.slotIndex <= 0) return session;
	const prevIndex = session.slotIndex - 1;
	const prevSpec = session.allSpecs[prevIndex];
	if (!prevSpec) return session;
	const prevDivideAmount = session.slotDivideAmounts?.[prevIndex] ?? null;
	const prevDivideUnitLabel = session.slotDivideUnitLabels?.[prevIndex] ?? 'damage';
	const prevReq = requirementForSlot(
		prevSpec,
		session.isAuraSingleSlot,
		session.auraRequirement,
		prevDivideAmount
	);
	const prevHistory = session.slotTargetHistory.slice(0, prevIndex);
	const prevSelected = session.slotTargetHistory[prevIndex] ?? [];
	const prevAccumulated = prevHistory.flat();
	const prevRemaining = session.allSpecs.slice(prevIndex + 1);
	const hasDivTracking = session.slotDivideAmounts !== undefined;
	const prevDivHistory = hasDivTracking
		? (session.slotDivisionHistory ?? []).slice(0, prevIndex)
		: undefined;
	const prevAccumulatedDivisions = hasDivTracking
		? Object.assign({}, ...(prevDivHistory ?? [{}]))
		: undefined;
	const { draftAllocation: _discarded, ...restSession } = session;

	return {
		...restSession,
		slotIndex: prevIndex,
		currentSpec: prevSpec,
		currentRequirement: prevReq,
		targetInfo: prevReq,
		targetKind: prevReq.targetKind,
		accumulatedTargets: prevAccumulated,
		selectedTargets: [...prevSelected],
		remainingSpecs: prevRemaining,
		slotTargetHistory: prevHistory,
		...(hasDivTracking
			? {
					accumulatedDivisions: prevAccumulatedDivisions ?? {},
					slotDivisionHistory: prevDivHistory ?? [],
					currentDivideAmount: prevDivideAmount,
					currentDivideUnitLabel: prevDivideUnitLabel,
					awaitingDivision: false
				}
			: {})
	};
}

/**
 * Returns arrow descriptors for BOTH `accumulatedTargets` (`locked: true`, earlier slots `1..k-1`)
 * and `selectedTargets` (`locked: false`, active slot `k`) so prior slots' targeting arrows remain visible.
 */
export function getPendingTargetArrowRefs(
	session: TargetingSession | null
): PendingTargetArrowRef[] {
	if (!session) return [];
	const out: PendingTargetArrowRef[] = [];

	const historyTargetsCount = session.slotTargetHistory.reduce((sum, list) => sum + list.length, 0);
	if (historyTargetsCount === session.accumulatedTargets.length && session.slotTargetHistory.length > 0) {
		for (let s = 0; s < session.slotTargetHistory.length; s++) {
			for (const target of session.slotTargetHistory[s]) {
				out.push({
					target,
					id: target.id,
					kind: target.kind,
					label: target.label,
					locked: true,
					slotIndex: s,
					slotNumber: s + 1
				});
			}
		}
	} else {
		for (let i = 0; i < session.accumulatedTargets.length; i++) {
			const target = session.accumulatedTargets[i];
			const slotIdx = Math.min(i, Math.max(0, session.slotIndex - 1));
			out.push({
				target,
				id: target.id,
				kind: target.kind,
				label: target.label,
				locked: true,
				slotIndex: slotIdx,
				slotNumber: slotIdx + 1
			});
		}
	}

	for (const target of session.selectedTargets) {
		out.push({
			target,
			id: target.id,
			kind: target.kind,
			label: target.label,
			locked: false,
			slotIndex: session.slotIndex,
			slotNumber: session.slotIndex + 1
		});
	}

	return out;
}

/**
 * Determines whether the active slot requires opening a graveyard or exile zone drawer/modal.
 * Returns `{ playerId, zone: 'graveyard' | 'exile' }` or `null`.
 */
export function requiredZoneDrawerForCurrentSlot(
	session: TargetingSession | null,
	viewerId: string,
	state?: GameState
): RequiredZoneDrawer | null {
	if (!session) return null;
	const req = session.currentRequirement;
	const zone: 'graveyard' | 'exile' | null =
		req.zone === 'graveyard' || req.targetKind === 'graveyard_card'
			? 'graveyard'
			: req.zone === 'exile' || req.targetKind === 'exile_card'
				? 'exile'
				: null;
	if (!zone) return null;

	if (req.controllerFilter === 'you') {
		return { playerId: viewerId, zone };
	}
	if (req.controllerFilter === 'opponent') {
		if (state) {
			const oppWithCards = state.players.find(
				(p) => p.playerId !== viewerId && !p.lost && p[zone].length > 0
			);
			const anyOpp = state.players.find((p) => p.playerId !== viewerId && !p.lost);
			const chosenOpp = oppWithCards ?? anyOpp;
			if (chosenOpp) {
				return { playerId: chosenOpp.playerId, zone };
			}
		}
		return { playerId: 'opponent', zone };
	}
	return { playerId: 'all', zone };
}

/**
 * Builds a concise, human-readable prompt phrase for `session.currentSpec` / `session.currentRequirement`.
 */
export function describeCurrentTargetSlot(session: TargetingSession): string {
	if (session.awaitingDivision && (session.currentDivideAmount ?? 0) > 0) {
		return `Distribute ${session.currentDivideAmount} ${session.currentDivideUnitLabel ?? 'damage'} among ${session.selectedTargets.length} targets`;
	}
	const req = session.currentRequirement;
	const spec = session.currentSpec;
	const min = req.minTargets;
	const max = req.maxTargets;

	const otherWord = spec?.otherTarget ? 'another ' : '';
	let countPhrase: string;
	if (min === 0 && max === 1) {
		countPhrase = `up to 1 ${otherWord}`;
	} else if (min === 0 && max > 1) {
		countPhrase = `up to ${max} ${otherWord}`;
	} else if (min === 1 && max === 1) {
		countPhrase = otherWord ? 'another ' : '1 ';
	} else if (min === max) {
		countPhrase = `${max} ${otherWord}`;
	} else {
		countPhrase = `${min}–${max} ${otherWord}`;
	}

	const plural = max > 1;
	let noun: string;
	if (req.zone === 'graveyard' || req.targetKind === 'graveyard_card') {
		const qual = req.cardTypeFilter ? `${req.cardTypeFilter.toLowerCase()} ` : '';
		const ownerSuffix =
			req.controllerFilter === 'you'
				? ' in your graveyard'
				: req.controllerFilter === 'opponent'
					? " in an opponent's graveyard"
					: req.sameGraveyard && plural
						? ' in a single graveyard'
						: ' in a graveyard';
		noun = `${qual}${plural ? 'cards' : 'card'}${ownerSuffix}`;
	} else if (req.zone === 'exile' || req.targetKind === 'exile_card') {
		const qual = req.cardTypeFilter ? `${req.cardTypeFilter.toLowerCase()} ` : '';
		const ownerSuffix =
			req.controllerFilter === 'you'
				? ' you own in exile'
				: req.controllerFilter === 'opponent'
					? ' an opponent owns in exile'
					: ' in exile';
		noun = `${qual}${plural ? 'cards' : 'card'}${ownerSuffix}`;
	} else if (req.zone === 'stack' || req.targetKind === 'spell' || req.targetKind === 'stack') {
		const base =
			req.stackKind === 'ability'
				? plural
					? 'abilities on the stack'
					: 'ability on the stack'
				: req.stackKind === 'activatedAbility'
					? plural
						? 'activated abilities on the stack'
						: 'activated ability on the stack'
					: req.stackKind === 'triggeredAbility'
						? plural
							? 'triggered abilities on the stack'
							: 'triggered ability on the stack'
						: req.stackKind === 'spellOrAbility'
							? plural
								? 'spells or abilities on the stack'
								: 'spell or ability on the stack'
							: plural
								? 'spells on the stack'
								: 'spell on the stack';
		const ctrlSuffix =
			req.controllerFilter === 'you'
				? ' you control'
				: req.controllerFilter === 'opponent'
					? ' an opponent controls'
					: '';
		noun = `${base}${ctrlSuffix}`;
	} else if (req.targetKind === 'player' || req.zone === 'player') {
		if (req.controllerFilter === 'opponent') {
			noun = plural ? 'opponents' : 'opponent';
		} else if (req.controllerFilter === 'you') {
			noun = 'yourself';
		} else {
			noun = plural ? 'players' : 'player';
		}
	} else if (req.targetKind === 'any' || req.zone === 'any') {
		noun = plural ? 'targets (any target)' : 'target (any target)';
	} else {
		const rawKind = req.targetKind === 'controlled_creature' ? 'creature' : req.targetKind.replace(/_/g, ' ');
		const base = plural && !rawKind.endsWith('s') ? `${rawKind}s` : rawKind;
		const ctrlSuffix =
			req.controllerFilter === 'you' || req.targetKind === 'controlled_creature'
				? ' you control'
				: req.controllerFilter === 'opponent'
					? ' an opponent controls'
					: '';
		noun = `${base}${ctrlSuffix}`;
	}

	const divSuffix =
		session.currentDivideAmount !== null &&
		session.currentDivideAmount !== undefined &&
		session.currentDivideAmount > 0
			? ` (${session.currentDivideAmount} ${session.currentDivideUnitLabel ?? 'damage'} divided)`
			: '';

	return `Select ${countPhrase}${noun}${divSuffix}`;
}

/**
 * Checks whether casting with `option` + `optionalCostCounts` requires choosing a value for X.
 */
export function optionChoosesX(
	option: CastOption,
	optionalCostCounts?: Record<string, number>
): boolean {
	if (option.choosesX) return true;
	if (!optionalCostCounts) return false;
	return (option.optionalAdditionalCosts ?? []).some(
		(oc) =>
			(optionalCostCounts[oc.id] ?? 0) > 0 &&
			(/\{X\}/i.test(oc.costDisplay) || oc.costDefs.some((cd) => cd.k === 'mana' && /\{X\}/i.test(cd.cost)))
	);
}

/**
 * Calculates the highest legal value of X currently affordable by `actorId` for `inst`,
 * or `null` if no non-negative X is currently legal.
 */
export function computeMaxAffordableX(params: ComputeMaxAffordableXParams): number | null {
	const {
		gameState,
		actorId,
		inst,
		fromZone,
		actionKind = 'cast_spell',
		castOption,
		optionalCostCounts,
		costAidIds,
		costAidColorChoices
	} = params;

	const actor = gameState.players.find((p) => p.playerId === actorId);
	if (!actor) return null;

	const hasStrictAids = Boolean((castOption?.paymentAids?.length ?? 0) > 0);
	const isLegalAt = (x: number): boolean => {
		if (actionKind === 'turn_face_up' || (fromZone === 'battlefield' && !castOption)) {
			return checkTurnFaceUpLegality(gameState, actorId, inst, x).ok;
		}
		return checkSpellCastLegality(
			gameState,
			actorId,
			inst,
			fromZone,
			x,
			castOption?.id,
			optionalCostCounts,
			castOption?.faceIndex,
			castOption?.fused,
			costAidIds,
			costAidColorChoices,
			hasStrictAids
		).ok;
	};

	const SCAN_LIMIT = 35;
	let best: number | null = null;
	for (let x = 0; x <= SCAN_LIMIT; x++) {
		if (isLegalAt(x)) {
			best = x;
		}
	}

	if (best === SCAN_LIMIT) {
		const poolSum =
			actor.manaPool.W +
			actor.manaPool.U +
			actor.manaPool.B +
			actor.manaPool.R +
			actor.manaPool.G +
			actor.manaPool.C;
		const aidCount = costAidIds
			? Object.values(costAidIds).reduce((sum, ids) => sum + ids.length, 0)
			: 0;
		let lo = SCAN_LIMIT;
		let hi = Math.min(5000, Math.max(SCAN_LIMIT + 1, poolSum + actor.battlefield.length * 4 + aidCount + 20));
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (isLegalAt(mid)) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		best = lo;
	}

	return best;
}
