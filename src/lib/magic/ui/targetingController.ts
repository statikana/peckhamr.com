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
import type { ModalDef, TargetSpec } from '../ir.ts';
import {
	NO_TARGET_REQUIREMENT,
	getSpellTargetRequirement,
	targetRequirementFromSpecs
} from '../ruleTree.ts';
import { activeCharacteristics } from '../runtime/faces.ts';
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

export type CastableZone = 'hand' | 'command' | 'exile' | 'graveyard';

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
	targets: TargetRef[]
): GameActionPayload {
	if (base.mode === 'ability') {
		return {
			type: 'activate_ability',
			instanceId: base.instanceId,
			abilityId: base.abilityId ?? '',
			...(base.modes ? { chosenModes: base.modes } : {}),
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
		...(base.optionalCostCounts && Object.keys(base.optionalCostCounts).length > 0
			? { optionalCostCounts: base.optionalCostCounts }
			: {}),
		...(base.costAidIds && Object.keys(base.costAidIds).length > 0
			? { costAidIds: base.costAidIds }
			: {}),
		...(base.costAidColorChoices && Object.keys(base.costAidColorChoices).length > 0
			? { costAidColorChoices: base.costAidColorChoices }
			: {}),
		targets
	};
}

function requirementForSlot(
	spec: TargetSpec,
	isAuraSingleSlot?: boolean,
	auraRequirement?: TargetRequirementInfo
): TargetRequirementInfo {
	if (isAuraSingleSlot && auraRequirement) {
		return auraRequirement;
	}
	return targetRequirementFromSpecs([spec]);
}

function createSessionFromSpecs(
	specs: TargetSpec[],
	meta: {
		mode: 'spell' | 'ability';
		instanceId: string;
		abilityId?: string;
		card: ScryfallCard;
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
	const firstSpec = specs[0];
	const firstReq = requirementForSlot(firstSpec, meta.isAuraSingleSlot, meta.auraRequirement);
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

/**
 * Starts targeting for casting a spell (non-modal, all-modes modal, pre-selected modal, multi-face, or fused).
 */
export function beginSpellTargeting(params: BeginSpellTargetingParams): TargetingTransitionResult {
	const xValue = params.xValue ?? 0;
	const optionalCostCounts = normalizeOptionalCounts(params.optionalCostCounts);
	const costAidIds = normalizeCostAidIds(params.costAidIds);
	const costAidColorChoices = normalizeAidColors(params.costAidColorChoices, costAidIds);

	const extracted = extractSpellTargetSpecs(
		params.inst.card,
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
			costAidColorChoices
		});
	}

	const effectiveModes = extracted.autoChosenModes ?? params.modes;
	const baseMeta = {
		mode: 'spell' as const,
		instanceId: params.inst.instanceId,
		card: params.inst.card,
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

	return {
		status: 'targeting',
		session: createSessionFromSpecs(extracted.specs, baseMeta)
	};
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
			chosenModes: params.chosenModes
		});
	}

	const specs = extractAbilityTargetSpecs(params.inst.card, params.ability);
	const baseMeta = {
		mode: 'ability' as const,
		instanceId: params.inst.instanceId,
		abilityId: params.ability.id,
		card: params.inst.card,
		xValue: 0
	};

	if (specs.length === 0) {
		return {
			status: 'ready_to_submit',
			payload: buildFinalPayload(baseMeta, [])
		};
	}

	return {
		status: 'targeting',
		session: createSessionFromSpecs(specs, baseMeta)
	};
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

	if (params.kind === 'spell') {
		const optionalCostCounts = normalizeOptionalCounts(params.optionalCostCounts);
		const costAidIds = normalizeCostAidIds(params.costAidIds);
		const costAidColorChoices = normalizeAidColors(params.costAidColorChoices, costAidIds);
		const specs = extractModalTargetSpecs(
			modal,
			chosenModes,
			params.inst.card,
			params.option,
			optionalCostCounts
		);
		const baseMeta = {
			mode: 'spell' as const,
			instanceId: params.inst.instanceId,
			card: params.inst.card,
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
		return {
			status: 'targeting',
			session: createSessionFromSpecs(specs, baseMeta)
		};
	}

	const specs = extractModalTargetSpecs(modal, chosenModes);
	const baseMeta = {
		mode: 'ability' as const,
		instanceId: params.inst.instanceId,
		abilityId: params.ability.id,
		card: params.inst.card,
		modes: chosenModes,
		xValue: 0
	};
	if (specs.length === 0) {
		return {
			status: 'ready_to_submit',
			payload: buildFinalPayload(baseMeta, [])
		};
	}
	return {
		status: 'targeting',
		session: createSessionFromSpecs(specs, baseMeta)
	};
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
			option: opt
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
	if (!session) return false;
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
	if (!session) return false;
	return (
		session.currentRequirement.minTargets === 0 && session.selectedTargets.length === 0
	);
}

/**
 * Confirms the current slot (including skipping with 0 targets when `minTargets === 0`).
 * Merges `selectedTargets` into `accumulatedTargets` and either advances to `remainingSpecs[0]`
 * or returns `{ status: 'ready_to_submit', payload }` once the final slot finishes.
 */
export function confirmCurrentSlot(session: TargetingSession): TargetingTransitionResult {
	if (!canConfirmCurrentSlot(session)) {
		return {
			status: 'invalid',
			error: `Select at least ${session.currentRequirement.minTargets} target(s) for slot ${session.slotIndex + 1}.`
		};
	}

	const nextAccumulated = [...session.accumulatedTargets, ...session.selectedTargets];
	const nextHistory = [...session.slotTargetHistory, [...session.selectedTargets]];

	if (session.remainingSpecs.length > 0) {
		const [nextSpec, ...restSpecs] = session.remainingSpecs;
		const nextReq = targetRequirementFromSpecs([nextSpec]);
		return {
			status: 'targeting',
			session: {
				...session,
				slotIndex: session.slotIndex + 1,
				currentSpec: nextSpec,
				currentRequirement: nextReq,
				targetInfo: nextReq,
				targetKind: nextReq.targetKind,
				accumulatedTargets: nextAccumulated,
				selectedTargets: [],
				remainingSpecs: restSpecs,
				slotTargetHistory: nextHistory
			}
		};
	}

	return {
		status: 'ready_to_submit',
		payload: buildFinalPayload(session, nextAccumulated)
	};
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
 * Rewinds `session` to `slotIndex - 1` (restoring the previous slot's `selectedTargets`),
 * or returns `session` unchanged if already at slot 0.
 */
export function stepBackToPreviousSlot(session: TargetingSession): TargetingSession {
	if (session.slotIndex <= 0) return session;
	const prevIndex = session.slotIndex - 1;
	const prevSpec = session.allSpecs[prevIndex];
	if (!prevSpec) return session;
	const prevReq = requirementForSlot(prevSpec, session.isAuraSingleSlot, session.auraRequirement);
	const prevHistory = session.slotTargetHistory.slice(0, prevIndex);
	const prevSelected = session.slotTargetHistory[prevIndex] ?? [];
	const prevAccumulated = prevHistory.flat();
	const prevRemaining = session.allSpecs.slice(prevIndex + 1);

	return {
		...session,
		slotIndex: prevIndex,
		currentSpec: prevSpec,
		currentRequirement: prevReq,
		targetInfo: prevReq,
		targetKind: prevReq.targetKind,
		accumulatedTargets: prevAccumulated,
		selectedTargets: [...prevSelected],
		remainingSpecs: prevRemaining,
		slotTargetHistory: prevHistory
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

	return `Select ${countPhrase}${noun}`;
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
		if (actionKind === 'turn_face_up' || fromZone === 'battlefield') {
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
