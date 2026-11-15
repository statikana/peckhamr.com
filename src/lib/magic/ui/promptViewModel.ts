/**
 * Pure, keyword-blind view-model and CR choice state helpers for Arena prompts and future
 * Comprehensive Rules choice widgets (UI Track U3).
 *
 * Upholds ENGINE_INVARIANTS.md §1: zero rules-text reads, zero card-name comparisons, zero direct
 * zone mutations, and explicit `.ts` imports for Node 24 native test execution.
 */
import { effectivePromptPurpose } from '../runtime/choices.ts';
import { instanceFaceOptions, resolveObjectFaces, stackItemFaceOptions } from '../runtime/faces.ts';
import { effectiveCardForObject, scrubFaceDownCard } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type ChoiceAnswer,
	type ChoiceRequest,
	type GameState,
	type PendingPrompt,
	type PlayerGameState,
	type PromptPurpose,
	type ScryfallCard,
	type StackItem,
	type ZoneType
} from '../types.ts';

export const FACE_DOWN_ART_URI =
	'data:image/svg+xml;utf8,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 168"><rect width="120" height="168" rx="8" fill="#1b1824" stroke="#6b5b7b" stroke-width="4"/><circle cx="60" cy="84" r="28" fill="none" stroke="#8a74a8" stroke-width="3"/><text x="60" y="92" text-anchor="middle" fill="#c7b8df" font-family="serif" font-size="28" font-weight="bold">?</text></svg>'
	);

export const ZONE_SHORT_LABELS: Record<ZoneType, string> = {
	battlefield: 'Battlefield',
	hand: 'Hand',
	graveyard: 'Graveyard',
	exile: 'Exile',
	command: 'Command',
	library: 'Library',
	stack: 'Stack'
};

export interface ResolvedPromptCandidate {
	id: string;
	inst: CardInstance;
	displayCard: ScryfallCard;
	imageUrl: string;
	artCropUrl: string;
	ownerId: string;
	ownerName: string;
	controllerId: string;
	controllerName: string;
	zone: ZoneType;
	isYours: boolean;
	isOwnedByViewer: boolean;
	isFaceDownHidden: boolean;
	stackItem?: StackItem;
}

export interface NonCardPromptCandidate {
	id: string;
	kind: 'player' | 'option';
	label: string;
	player?: PlayerGameState;
}

export interface PromptCandidatesResult {
	candidates: ResolvedPromptCandidate[];
	nonCardCandidates: NonCardPromptCandidate[];
}

/**
 * CR 708.5 & CR 406.3: Determines whether `viewerId` may inspect the hidden front face of a
 * face-down object in `zone`.
 *
 * - On the battlefield (CR 708.5), the permanent's controller and any player listed in
 *   `knownToPlayerIds` may look at it.
 * - In exile or any other hidden zone (CR 406.3), only players explicitly listed in
 *   `knownToPlayerIds` may look at it.
 * - If the server already sanitized `inst.card` to the `'face_down'` proxy, the hidden identity
 *   is unavailable on the client regardless.
 */
export function canViewerSeeFaceDownInstance(
	inst: Pick<
		CardInstance,
		'isFaceDown' | 'card' | 'controllerId' | 'knownToPlayerIds' | 'faceDownSpec'
	>,
	zone: ZoneType,
	viewerId: string | null
): boolean {
	if (!inst.isFaceDown) return true;
	if (inst.card.id === 'face_down') return false;
	const known = Boolean(
		viewerId !== null &&
			(inst.knownToPlayerIds?.includes(viewerId) ||
				inst.faceDownSpec?.knownToPlayerIds?.includes(viewerId))
	);
	if (zone === 'battlefield') {
		return (viewerId !== null && viewerId === inst.controllerId) || known;
	}
	return known;
}

/**
 * CR 708.4: Determines whether `viewerId` may inspect the hidden identity of a face-down spell on
 * the stack.
 */
export function canViewerSeeFaceDownStackItem(
	item: Pick<StackItem, 'isFaceDown' | 'card' | 'controllerId' | 'faceDownSpec'>,
	viewerId: string | null
): boolean {
	if (!item.isFaceDown) return true;
	if (item.card.id === 'face_down') return false;
	return Boolean(
		viewerId !== null &&
			(viewerId === item.controllerId ||
				item.faceDownSpec?.knownToPlayerIds?.includes(viewerId))
	);
}

/**
 * Resolves the safe viewer-facing `ScryfallCard` and artwork URLs for any `CardInstance`,
 * honoring Layer 1 copy effects (`effectiveCardForObject`) and face-down secrecy (`scrubFaceDownCard`).
 */
export function resolveCardInstanceDisplay(
	inst: CardInstance,
	zone: ZoneType,
	viewerId: string | null
): {
	displayCard: ScryfallCard;
	imageUrl: string;
	artCropUrl: string;
	isFaceDownHidden: boolean;
} {
	const canSee = canViewerSeeFaceDownInstance(inst, zone, viewerId);
	if (inst.isFaceDown && !canSee) {
		const label =
			inst.faceDownLabel || (zone === 'battlefield' ? 'Face-Down Creature' : 'Face-Down Card');
		const scrubbed =
			inst.card.id === 'face_down'
				? inst.card
				: scrubFaceDownCard(label, zone, inst.faceDownSpec);
		return {
			displayCard: scrubbed,
			imageUrl: FACE_DOWN_ART_URI,
			artCropUrl: FACE_DOWN_ART_URI,
			isFaceDownHidden: true
		};
	}

	const effCard = effectiveCardForObject(inst);
	if (inst.isFaceDown) {
		// Viewer is permitted to peek at this face-down object's true characteristics.
		const img = effCard.imageUrl || FACE_DOWN_ART_URI;
		const crop = effCard.artCropUrl || img;
		return {
			displayCard: effCard,
			imageUrl: img,
			artCropUrl: crop,
			isFaceDownHidden: false
		};
	}

	const view = resolveObjectFaces(effCard, instanceFaceOptions(inst, zone));
	const imageUrl = view.imageUrl || effCard.imageUrl;
	const artCropUrl = view.artCropUrl || effCard.artCropUrl || imageUrl;
	const displayCard: ScryfallCard =
		view.name && view.name !== effCard.name
			? {
					...effCard,
					name: view.name,
					manaCost: view.manaCost,
					typeLine: view.typeLine,
					colors: view.colors,
					keywords: view.keywords,
					...(view.power !== undefined ? { power: String(view.power) } : {}),
					...(view.toughness !== undefined ? { toughness: String(view.toughness) } : {}),
					imageUrl
				}
			: effCard;

	return {
		displayCard,
		imageUrl,
		artCropUrl,
		isFaceDownHidden: false
	};
}

function createSyntheticStackInstance(item: StackItem, displayCard: ScryfallCard): CardInstance {
	const ownerId = item.ownerId || item.controllerId;
	return {
		instanceId: item.id,
		card: displayCard,
		...(item.copiableState ? { copiableState: item.copiableState } : {}),
		ownerId,
		controllerId: item.controllerId,
		zone: 'stack',
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		// --- Track P11 ---
		counters: createEmptyCounterMap(),
		// --- End Track P11 ---
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: item.kind !== 'spell',
		isCommander: false,
		commanderCastCount: item.commanderCastCount ?? 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		...(item.isFaceDown ? { isFaceDown: true } : {}),
		...(item.faceDownSpec ? { faceDownSpec: item.faceDownSpec } : {}),
		...(item.faceDownLabel ? { faceDownLabel: item.faceDownLabel } : {})
	};
}

interface IndexedZoneEntry {
	inst: CardInstance;
	zone: ZoneType;
	zoneHolderId: string;
}

/**
 * Looks up candidate IDs across ALL zones (`battlefield`, `hand`, `graveyard`, `exile`, `command`,
 * `library`, `pendingZoneMoves`, and `stack`) for ALL players, preserving `objectIds` order and
 * enforcing `effectiveCardForObject` + face-down secrecy.
 *
 * Non-card IDs (players or raw string option IDs) are returned in `nonCardCandidates`.
 */
export function resolvePromptCandidates(
	gameState: GameState,
	viewerId: string | null,
	objectIds: readonly string[]
): PromptCandidatesResult {
	const playersById = new Map<string, PlayerGameState>();
	const instancesById = new Map<string, IndexedZoneEntry>();

	const playerZones: ReadonlyArray<{
		zone: Exclude<ZoneType, 'stack'>;
		select: (p: PlayerGameState) => readonly CardInstance[];
	}> = [
		{ zone: 'battlefield', select: (p) => p.battlefield },
		{ zone: 'hand', select: (p) => p.hand },
		{ zone: 'graveyard', select: (p) => p.graveyard },
		{ zone: 'exile', select: (p) => p.exile },
		{ zone: 'command', select: (p) => p.command },
		{ zone: 'library', select: (p) => p.library }
	];

	for (const player of gameState.players) {
		playersById.set(player.playerId, player);
		for (const { zone, select } of playerZones) {
			for (const inst of select(player)) {
				if (!instancesById.has(inst.instanceId)) {
					instancesById.set(inst.instanceId, {
						inst,
						zone,
						zoneHolderId: player.playerId
					});
				}
			}
		}
	}

	for (const pendingInst of gameState.pendingZoneMoves ?? []) {
		if (!instancesById.has(pendingInst.instanceId)) {
			instancesById.set(pendingInst.instanceId, {
				inst: pendingInst,
				zone: pendingInst.zone,
				zoneHolderId: pendingInst.controllerId || pendingInst.ownerId
			});
		}
	}

	const stackById = new Map<string, StackItem>();
	const stackBySourceId = new Map<string, StackItem>();
	for (const item of gameState.stack) {
		stackById.set(item.id, item);
		if (item.sourceInstanceId && !stackBySourceId.has(item.sourceInstanceId)) {
			stackBySourceId.set(item.sourceInstanceId, item);
		}
	}

	const candidates: ResolvedPromptCandidate[] = [];
	const nonCardCandidates: NonCardPromptCandidate[] = [];
	const seen = new Set<string>();

	for (const rawId of objectIds) {
		if (!rawId || seen.has(rawId)) continue;
		seen.add(rawId);

		const found = instancesById.get(rawId);
		if (found) {
			const { inst, zone, zoneHolderId } = found;
			const ownerId = inst.ownerId || zoneHolderId;
			const controllerId =
				zone === 'battlefield' ? inst.controllerId || zoneHolderId : zoneHolderId || ownerId;
			const ownerName = playersById.get(ownerId)?.username ?? ownerId;
			const controllerName = playersById.get(controllerId)?.username ?? controllerId;
			const { displayCard, imageUrl, artCropUrl, isFaceDownHidden } = resolveCardInstanceDisplay(
				inst,
				zone,
				viewerId
			);
			const isOwnedByViewer = viewerId !== null && ownerId === viewerId;
			const isYours =
				viewerId !== null &&
				(zone === 'battlefield' ? controllerId === viewerId : controllerId === viewerId || isOwnedByViewer);

			candidates.push({
				id: rawId,
				inst,
				displayCard,
				imageUrl,
				artCropUrl,
				ownerId,
				ownerName,
				controllerId,
				controllerName,
				zone,
				isYours,
				isOwnedByViewer,
				isFaceDownHidden
			});
			continue;
		}

		const stackItem = stackById.get(rawId) ?? stackBySourceId.get(rawId);
		if (stackItem) {
			const ownerId = stackItem.ownerId || stackItem.controllerId;
			const controllerId = stackItem.controllerId;
			const ownerName = playersById.get(ownerId)?.username ?? ownerId;
			const controllerName = playersById.get(controllerId)?.username ?? controllerId;
			const canSee = canViewerSeeFaceDownStackItem(stackItem, viewerId);

			let displayCard: ScryfallCard;
			let imageUrl: string;
			let artCropUrl: string;
			let isFaceDownHidden = false;

			if (stackItem.isFaceDown && !canSee) {
				const label = stackItem.faceDownLabel || 'Face-Down Spell';
				displayCard =
					stackItem.card.id === 'face_down'
						? stackItem.card
						: scrubFaceDownCard(label, 'stack', stackItem.faceDownSpec);
				imageUrl = FACE_DOWN_ART_URI;
				artCropUrl = FACE_DOWN_ART_URI;
				isFaceDownHidden = true;
			} else {
				const effStackCard = effectiveCardForObject({
					card: stackItem.card,
					copiableState: stackItem.copiableState
				});
				if (stackItem.isFaceDown) {
					displayCard = effStackCard;
					imageUrl = effStackCard.imageUrl || FACE_DOWN_ART_URI;
					artCropUrl = effStackCard.artCropUrl || imageUrl;
				} else {
					const view = resolveObjectFaces(effStackCard, stackItemFaceOptions(stackItem));
					displayCard = effStackCard;
					imageUrl = view.imageUrl || effStackCard.imageUrl;
					artCropUrl = view.artCropUrl || effStackCard.artCropUrl || imageUrl;
				}
			}

			const syntheticInst = createSyntheticStackInstance(stackItem, displayCard);
			const isOwnedByViewer = viewerId !== null && ownerId === viewerId;
			const isYours = viewerId !== null && controllerId === viewerId;

			candidates.push({
				id: rawId,
				inst: syntheticInst,
				displayCard,
				imageUrl,
				artCropUrl,
				ownerId,
				ownerName,
				controllerId,
				controllerName,
				zone: 'stack',
				isYours,
				isOwnedByViewer,
				isFaceDownHidden,
				stackItem
			});
			continue;
		}

		const player = playersById.get(rawId);
		if (player) {
			const youSuffix = viewerId !== null && player.playerId === viewerId ? ' (you)' : '';
			nonCardCandidates.push({
				id: rawId,
				kind: 'player',
				label: `Player: ${player.username}${youSuffix} (${player.life} life)`,
				player
			});
			continue;
		}

		nonCardCandidates.push({
			id: rawId,
			kind: 'option',
			label: rawId
		});
	}

	return { candidates, nonCardCandidates };
}

export interface OrderObjectsInitialLists {
	topIds: string[];
	bottomIds: string[];
	candidates: ResolvedPromptCandidate[];
	candidatesById: Map<string, ResolvedPromptCandidate>;
	nonCardCandidates: NonCardPromptCandidate[];
	inferredZone: ZoneType | 'mixed';
}

/**
 * Generalizes `orderObjects` initialization via `resolvePromptCandidates` across ALL zones
 * (graveyard, exile, battlefield blockers, stack triggers, opponent library, or own library)
 * instead of hardcoding `me.library`, while preserving Scry/Surveil top/bottom/graveyard splits.
 */
export function buildOrderObjectsInitialLists(
	gameState: GameState,
	viewerId: string | null,
	choice: Pick<
		Extract<ChoiceRequest, { kind: 'orderObjects' }>,
		'objectIds' | 'allowSplitBottom' | 'splitLabel' | 'allowShuffle'
	>
): OrderObjectsInitialLists {
	const viewerPlayer =
		viewerId !== null ? gameState.players.find((p) => p.playerId === viewerId) : undefined;
	const sourceIds =
		choice.objectIds.length > 0
			? choice.objectIds
			: (viewerPlayer?.library ?? []).map((c) => c.instanceId);

	const topIds: string[] = [];
	const seen = new Set<string>();
	for (const id of sourceIds) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		topIds.push(id);
	}

	const { candidates, nonCardCandidates } = resolvePromptCandidates(gameState, viewerId, topIds);
	const candidatesById = new Map<string, ResolvedPromptCandidate>(
		candidates.map((c) => [c.id, c])
	);

	let inferredZone: ZoneType | 'mixed' = 'library';
	if (candidates.length > 0) {
		const firstZone = candidates[0].zone;
		inferredZone = candidates.every((c) => c.zone === firstZone) ? firstZone : 'mixed';
	}

	return {
		topIds,
		bottomIds: [],
		candidates,
		candidatesById,
		nonCardCandidates,
		inferredZone
	};
}

/**
 * Immutably shifts `targetId` earlier (`-1`) or later (`+1`) within whichever ordered list
 * (`topIds` or `bottomIds`) currently contains it.
 */
export function shiftOrderedObjects(
	topIds: readonly string[],
	bottomIds: readonly string[],
	targetId: string,
	dir: -1 | 1
): { topIds: string[]; bottomIds: string[] } {
	const topIdx = topIds.indexOf(targetId);
	if (topIdx >= 0) {
		const nextIdx = topIdx + dir;
		if (nextIdx < 0 || nextIdx >= topIds.length) {
			return { topIds: [...topIds], bottomIds: [...bottomIds] };
		}
		const nextTop = [...topIds];
		const tmp = nextTop[topIdx];
		nextTop[topIdx] = nextTop[nextIdx];
		nextTop[nextIdx] = tmp;
		return { topIds: nextTop, bottomIds: [...bottomIds] };
	}

	const botIdx = bottomIds.indexOf(targetId);
	if (botIdx >= 0) {
		const nextIdx = botIdx + dir;
		if (nextIdx < 0 || nextIdx >= bottomIds.length) {
			return { topIds: [...topIds], bottomIds: [...bottomIds] };
		}
		const nextBottom = [...bottomIds];
		const tmp = nextBottom[botIdx];
		nextBottom[botIdx] = nextBottom[nextIdx];
		nextBottom[nextIdx] = tmp;
		return { topIds: [...topIds], bottomIds: nextBottom };
	}

	return { topIds: [...topIds], bottomIds: [...bottomIds] };
}

/**
 * Immutably moves `targetId` between `topIds` and `bottomIds` (for Scry / Surveil splits).
 */
export function moveOrderedObjectSplit(
	topIds: readonly string[],
	bottomIds: readonly string[],
	targetId: string,
	toBottom: boolean
): { topIds: string[]; bottomIds: string[] } {
	if (toBottom) {
		if (!topIds.includes(targetId)) {
			return { topIds: [...topIds], bottomIds: [...bottomIds] };
		}
		return {
			topIds: topIds.filter((id) => id !== targetId),
			bottomIds: bottomIds.includes(targetId) ? [...bottomIds] : [...bottomIds, targetId]
		};
	}

	if (!bottomIds.includes(targetId)) {
		return { topIds: [...topIds], bottomIds: [...bottomIds] };
	}
	return {
		topIds: topIds.includes(targetId) ? [...topIds] : [...topIds, targetId],
		bottomIds: bottomIds.filter((id) => id !== targetId)
	};
}

/**
 * Unified cancellation predicate across ALL 6 `ChoiceKind`s:
 * returns `true` whenever `prompt.cancellable` is set OR the prompt purpose is `'cost_choice'`.
 */
export function isPromptCancellable(
	prompt: Pick<PendingPrompt, 'cancellable' | 'purpose' | 'kind'> | null | undefined,
	purpose?: PromptPurpose | null
): boolean {
	if (!prompt) return false;
	const resolvedPurpose = purpose ?? effectivePromptPurpose(prompt as PendingPrompt);
	return Boolean(prompt.cancellable || resolvedPurpose === 'cost_choice');
}

/**
 * True when a `chooseObjects` request picks exactly 1 object without a subset-sum weight constraint,
 * enabling optional 1-click fast pick UX in `ChoicePromptModal`.
 */
export function isSingleClickObjectChoice(
	choice: Pick<Extract<ChoiceRequest, { kind: 'chooseObjects' }>, 'min' | 'max' | 'minWeightSum'>
): boolean {
	return choice.min === 1 && choice.max === 1 && choice.minWeightSum === undefined;
}

export interface WeightProgress {
	hasWeightConstraint: boolean;
	selectedCount: number;
	minCount: number;
	maxCount: number;
	selectedWeightSum: number;
	requiredWeightSum: number | null;
	remainingWeight: number;
	progressRatio: number;
	weightLabel: string;
	countSatisfied: boolean;
	weightSatisfied: boolean;
	isReady: boolean;
}

/**
 * Computes count and subset-sum weight progress for `chooseObjects` prompts (such as total-power,
 * Station, Improvise, or mana-value-capped multi-picks), matching `validateChoiceAnswer`.
 */
export function computeWeightProgress(
	selectedIds: readonly string[],
	choice: Pick<
		Extract<ChoiceRequest, { kind: 'chooseObjects' }>,
		'min' | 'max' | 'minWeightSum' | 'weightsById' | 'weightLabel' | 'candidates'
	>
): WeightProgress {
	const selectedCount = selectedIds.length;
	const minCount = choice.min;
	const maxCount = choice.max;
	const hasWeightConstraint = choice.minWeightSum !== undefined;
	const requiredWeightSum = choice.minWeightSum ?? null;
	const weightLabel = choice.weightLabel?.toLowerCase() ?? 'total';

	const selectedWeightSum =
		hasWeightConstraint && choice.weightsById
			? selectedIds.reduce((sum, id) => sum + (choice.weightsById?.[id] ?? 0), 0)
			: 0;

	// Matches validateChoiceAnswer: mandatory tutor/choice with 0 candidates allows [] submission.
	const emptyCandidateBypass = choice.candidates.length === 0 && selectedCount === 0;
	const countSatisfied =
		emptyCandidateBypass || (selectedCount >= minCount && selectedCount <= maxCount);
	const weightSatisfied =
		emptyCandidateBypass ||
		requiredWeightSum === null ||
		selectedWeightSum >= requiredWeightSum;

	const remainingWeight =
		requiredWeightSum !== null ? Math.max(0, requiredWeightSum - selectedWeightSum) : 0;
	const progressRatio =
		requiredWeightSum !== null && requiredWeightSum > 0
			? Math.min(1, Math.max(0, selectedWeightSum / requiredWeightSum))
			: countSatisfied
				? 1
				: 0;

	return {
		hasWeightConstraint,
		selectedCount,
		minCount,
		maxCount,
		selectedWeightSum,
		requiredWeightSum,
		remainingWeight,
		progressRatio,
		weightLabel,
		countSatisfied,
		weightSatisfied,
		isReady: countSatisfied && weightSatisfied
	};
}

// ============================================================================
// Forward-Compatible CR Choice Helpers (CR 601.2d, CR 701.23, CR 201.4/205.3)
// ============================================================================

/**
 * CR 601.2d: State model for dividing damage or counters among one or more targets.
 * Under CR 601.2d, if an effect divides damage or counters among multiple targets, each chosen
 * target must receive at least `minPerTarget` (default 1).
 */
export interface AllocationState {
	targetIds: string[];
	amountToDistribute: number;
	minPerTarget: number;
	maxPerTarget?: Record<string, number>;
	allocations: Record<string, number>;
}

export interface CreateAllocationParams {
	targetIds: readonly string[];
	amountToDistribute: number;
	minPerTarget?: number;
	maxPerTarget?: Record<string, number>;
	initial?: Record<string, number>;
}

export function createAllocationState(params: CreateAllocationParams): AllocationState {
	const targetIds: string[] = [];
	const seen = new Set<string>();
	for (const id of params.targetIds) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		targetIds.push(id);
	}

	const amountToDistribute = Math.max(0, Math.trunc(params.amountToDistribute));
	const minPerTarget = Math.max(0, Math.trunc(params.minPerTarget ?? 1));
	const allocations: Record<string, number> = {};

	if (params.initial) {
		for (const id of targetIds) {
			allocations[id] = Math.max(0, Math.trunc(params.initial[id] ?? 0));
		}
	} else if (targetIds.length === 1) {
		const onlyId = targetIds[0];
		const cap = params.maxPerTarget?.[onlyId];
		allocations[onlyId] =
			cap !== undefined ? Math.min(amountToDistribute, Math.max(0, Math.trunc(cap))) : amountToDistribute;
	} else if (targetIds.length > 0 && amountToDistribute >= targetIds.length * minPerTarget) {
		for (const id of targetIds) {
			const cap = params.maxPerTarget?.[id];
			allocations[id] =
				cap !== undefined ? Math.min(minPerTarget, Math.max(0, Math.trunc(cap))) : minPerTarget;
		}
	} else {
		for (const id of targetIds) {
			allocations[id] = 0;
		}
	}

	return {
		targetIds,
		amountToDistribute,
		minPerTarget,
		...(params.maxPerTarget ? { maxPerTarget: { ...params.maxPerTarget } } : {}),
		allocations
	};
}

export function allocatedTotal(state: AllocationState): number {
	return state.targetIds.reduce((sum, id) => sum + (state.allocations[id] ?? 0), 0);
}

export function remainingAllocation(state: AllocationState): number {
	return state.amountToDistribute - allocatedTotal(state);
}

/**
 * Immutably adjusts `targetId`'s allocation by `delta`, clamping within `[0, remainingPoolCap]`
 * (and `maxPerTarget[targetId]` if configured) so total allocations never exceed `amountToDistribute`
 * or drop below `0`.
 */
export function adjustAllocation(
	state: AllocationState,
	targetId: string,
	delta: number
): AllocationState {
	if (!state.targetIds.includes(targetId) || !Number.isFinite(delta)) {
		return {
			...state,
			targetIds: [...state.targetIds],
			allocations: { ...state.allocations }
		};
	}

	const step = Math.trunc(delta);
	const current = state.allocations[targetId] ?? 0;
	const otherSum = allocatedTotal(state) - current;
	const poolCap = Math.max(0, state.amountToDistribute - otherSum);
	const configuredCap = state.maxPerTarget?.[targetId];
	const upperBound =
		configuredCap !== undefined ? Math.min(poolCap, Math.max(0, Math.trunc(configuredCap))) : poolCap;

	const nextValue = Math.max(0, Math.min(upperBound, current + step));
	return {
		...state,
		targetIds: [...state.targetIds],
		allocations: {
			...state.allocations,
			[targetId]: nextValue
		}
	};
}

/**
 * Validates an `AllocationState` against `CR 601.2d`:
 * - Every target must receive an integer amount `>= state.minPerTarget` (and `<= maxPerTarget`).
 * - The sum across all targets must equal `state.amountToDistribute` exactly.
 */
export function isValidAllocation(state: AllocationState): boolean {
	if (!Number.isInteger(state.amountToDistribute) || state.amountToDistribute < 0) return false;
	if (!Number.isInteger(state.minPerTarget) || state.minPerTarget < 0) return false;

	if (state.targetIds.length === 0) {
		return state.amountToDistribute === 0;
	}

	const targetSet = new Set(state.targetIds);
	for (const [key, val] of Object.entries(state.allocations)) {
		if (!targetSet.has(key) && val !== 0) {
			return false;
		}
	}

	let sum = 0;
	for (const id of state.targetIds) {
		const val = state.allocations[id] ?? 0;
		if (!Number.isInteger(val) || val < 0) return false;
		if (val < state.minPerTarget) return false;
		const cap = state.maxPerTarget?.[id];
		if (cap !== undefined && val > cap) return false;
		sum += val;
	}

	return sum === state.amountToDistribute;
}

/**
 * CR 701.23: State model for splitting a set of objects into two piles (Pile A and Pile B).
 * Under CR 701.23b, either pile may legally be empty.
 */
export interface PileSplitState {
	objectIds: string[];
	pileA: string[];
	pileB: string[];
}

export function createPileSplitState(
	objectIds: readonly string[],
	initialPileBIds: readonly string[] = []
): PileSplitState {
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const id of objectIds) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		deduped.push(id);
	}

	const pileBSet = new Set(initialPileBIds);
	const pileA: string[] = [];
	const pileB: string[] = [];
	for (const id of deduped) {
		if (pileBSet.has(id)) {
			pileB.push(id);
		} else {
			pileA.push(id);
		}
	}

	return {
		objectIds: deduped,
		pileA,
		pileB
	};
}

/**
 * Immutably moves `objectId` to Pile `'A'`, Pile `'B'`, or toggles its current pile (`'toggle'`).
 */
export function moveBetweenPiles(
	state: PileSplitState,
	objectId: string,
	destination: 'A' | 'B' | 'toggle' = 'toggle'
): PileSplitState {
	if (!state.objectIds.includes(objectId)) {
		return {
			objectIds: [...state.objectIds],
			pileA: [...state.pileA],
			pileB: [...state.pileB]
		};
	}

	const inA = state.pileA.includes(objectId);
	const targetPile: 'A' | 'B' =
		destination === 'toggle' ? (inA ? 'B' : 'A') : destination;

	if (targetPile === 'A') {
		if (inA) {
			return {
				objectIds: [...state.objectIds],
				pileA: [...state.pileA],
				pileB: state.pileB.filter((id) => id !== objectId)
			};
		}
		return {
			objectIds: [...state.objectIds],
			pileA: [...state.pileA, objectId],
			pileB: state.pileB.filter((id) => id !== objectId)
		};
	}

	if (!inA && state.pileB.includes(objectId)) {
		return {
			objectIds: [...state.objectIds],
			pileA: state.pileA.filter((id) => id !== objectId),
			pileB: [...state.pileB]
		};
	}

	return {
		objectIds: [...state.objectIds],
		pileA: state.pileA.filter((id) => id !== objectId),
		pileB: [...state.pileB, objectId]
	};
}

export function isValidPileSplit(state: PileSplitState): boolean {
	const expected = new Set(state.objectIds);
	if (expected.size !== state.objectIds.length) return false;
	const seen = new Set<string>();
	for (const id of [...state.pileA, ...state.pileB]) {
		if (!expected.has(id) || seen.has(id)) return false;
		seen.add(id);
	}
	return seen.size === expected.size;
}

/**
 * Serializes a 2-pile split into both explicit `{ pileA, pileB }` arrays and the `orderObjects`
 * `ChoiceAnswer` representation (`topIds` = Pile 1, `bottomIds` = Pile 2).
 */
export function serializePileSplit(state: PileSplitState): {
	pileA: string[];
	pileB: string[];
	topIds: string[];
	bottomIds: string[];
	answer: Extract<ChoiceAnswer, { kind: 'orderObjects' }>;
} {
	const pileA = [...state.pileA];
	const pileB = [...state.pileB];
	return {
		pileA,
		pileB,
		topIds: [...pileA],
		bottomIds: [...pileB],
		answer: {
			kind: 'orderObjects',
			topIds: [...pileA],
			bottomIds: [...pileB],
			shuffle: false
		}
	};
}

/**
 * CR 201.4 & CR 205.3: Fast case-insensitive option ranker for creature types, colors, basic land
 * types, or card names.
 *
 * Ranks matches in 4 deterministic tiers (preserving relative input order within each tier):
 * 0. Exact match (`option === query`)
 * 1. Full string prefix match (`option.startsWith(query)`)
 * 2. Word-boundary prefix match (`word.startsWith(query)`)
 * 3. Substring match (`option.includes(query)`)
 */
export function filterStringOptions(
	options: readonly string[],
	query: string,
	limit = 50
): string[] {
	const cap = Math.max(0, Math.trunc(limit));
	if (cap === 0) return [];

	const trimmed = query.trim().toLowerCase();
	if (!trimmed) {
		return options.slice(0, cap);
	}

	const exact: string[] = [];
	const prefix: string[] = [];
	const wordPrefix: string[] = [];
	const substring: string[] = [];

	for (const opt of options) {
		const lower = opt.toLowerCase();
		if (lower === trimmed) {
			exact.push(opt);
		} else if (lower.startsWith(trimmed)) {
			prefix.push(opt);
		} else if (
			lower
				.split(/[\s\-'/,]+/)
				.some((word) => word.length > 0 && word.startsWith(trimmed))
		) {
			wordPrefix.push(opt);
		} else if (lower.includes(trimmed)) {
			substring.push(opt);
		}
	}

	return [...exact, ...prefix, ...wordPrefix, ...substring].slice(0, cap);
}
