import { scrubFaceDownCard, scrubFaceDownStackItem } from '../scryfall.ts';
import type {
	CardInstance,
	ChoiceRequest,
	GameState,
	PendingPrompt,
	PromptPurpose,
	ZoneType
} from '../types.ts';
import { effectivePromptPurpose } from './choices.ts';
import { findPermanentOnBoard } from './engineHost.ts';
import { getPlayerTopOfLibraryVisibility } from './staticsLayersAndRestrictions.ts';
import {
	isPlayerHandRevealedToViewer,
	isPlayerTopLibraryRevealedByGlobalStatic
} from './staticsWave6.ts';

/**
 * Purposes whose candidate lists and descriptions are already public on the table:
 * - `trigger_targets`: target candidates on the battlefield (CR 603.3d).
 * - `trigger_order`: triggered ability items already placed on the stack (CR 603.3b).
 * All other purposes default to redacted for non-viewing players.
 */
const PUBLIC_PROMPT_PURPOSES: ReadonlySet<PromptPurpose> = new Set<PromptPurpose>([
	'trigger_modes',
	'trigger_targets',
	'trigger_order'
]);

function isPublicPromptForOpponent(pr: PendingPrompt): boolean {
	const purpose = effectivePromptPurpose(pr);
	if (!PUBLIC_PROMPT_PURPOSES.has(purpose)) return false;
	if (purpose === 'trigger_targets') {
		return !pr.choice || (pr.choice.kind === 'chooseObjects' && pr.choice.zone === 'battlefield');
	}
	return true;
}

function redactChoiceForOpponent(choice: ChoiceRequest): ChoiceRequest {
	switch (choice.kind) {
		case 'yesNo':
			return { kind: 'yesNo', question: 'Opponent is choosing…' };
		case 'chooseObjects':
			return {
				kind: 'chooseObjects',
				candidates: [],
				min: choice.min,
				max: choice.max,
				zone: choice.zone,
				reason: 'Opponent is choosing…'
			};
		case 'chooseMode':
			return {
				kind: 'chooseMode',
				modes: [],
				min: choice.min,
				max: choice.max,
				...(choice.allowRepeat ? { allowRepeat: true } : {})
			};
		case 'chooseNumber':
			return {
				kind: 'chooseNumber',
				min: choice.min,
				max: choice.max,
				reason: 'Opponent is choosing…'
			};
		case 'orderObjects':
			return {
				kind: 'orderObjects',
				objectIds: [],
				...(choice.allowSplitBottom !== undefined
					? { allowSplitBottom: choice.allowSplitBottom }
					: {}),
				...(choice.allowShuffle !== undefined ? { allowShuffle: choice.allowShuffle } : {}),
				reason: 'Opponent is choosing…'
			};
		case 'chooseReplacement':
			return { kind: 'chooseReplacement', options: [] };
	}
}

function redactPromptForOpponent(pr: PendingPrompt): PendingPrompt {
	if (isPublicPromptForOpponent(pr)) {
		return {
			id: pr.id,
			playerId: pr.playerId,
			kind: pr.kind,
			...(pr.purpose !== undefined ? { purpose: pr.purpose } : {}),
			title: pr.title,
			description: pr.description,
			...(pr.choice !== undefined ? { choice: pr.choice } : {}),
			...(pr.triggerStackItemId !== undefined
				? { triggerStackItemId: pr.triggerStackItemId }
				: {}),
			...(pr.triggerTargetSpecIndex !== undefined
				? { triggerTargetSpecIndex: pr.triggerTargetSpecIndex }
				: {})
		};
	}
	return {
		id: pr.id,
		playerId: pr.playerId,
		kind: pr.kind,
		...(pr.purpose !== undefined ? { purpose: pr.purpose } : {}),
		title: pr.title,
		description: 'Opponent is choosing…',
		...(pr.choice !== undefined ? { choice: redactChoiceForOpponent(pr.choice) } : {}),
		...(pr.triggerStackItemId !== undefined
			? { triggerStackItemId: pr.triggerStackItemId }
			: {})
	};
}

function scrubFaceDownInstance(
	inst: CardInstance,
	zone: 'battlefield' | 'exile',
	viewerId: string | null
): void {
	if (!inst.isFaceDown) return;
	// CR 708.5: controller and knownToPlayerIds may look at face-down permanents on the battlefield.
	// CR 406.3: face-down exiled cards may only be looked at by players explicitly listed in knownToPlayerIds.
	const known = Boolean(
		viewerId !== null &&
			(inst.knownToPlayerIds?.includes(viewerId) ||
				inst.faceDownSpec?.knownToPlayerIds?.includes(viewerId))
	);
	const canSee =
		zone === 'battlefield' ? (viewerId !== null && viewerId === inst.controllerId) || known : known;
	if (canSee) return;

	delete inst.printedCard;
	delete inst.copiableCard;
	delete inst.copiableState;
	inst.transformed = false;
	delete inst.activeFaceIndex;
	delete inst.unlockedFaces;
	if (inst.faceDownSpec) {
		delete inst.faceDownSpec.turnUpCost;
		delete inst.faceDownSpec.turnUpManaCost;
		delete inst.faceDownSpec.turnUpCostDefs;
	}
	const label =
		inst.faceDownLabel || (zone === 'battlefield' ? 'Face-Down Creature' : 'Face-Down Card');
	inst.card = scrubFaceDownCard(label, zone, inst.faceDownSpec);
}

export function sanitizeGameStateForViewer(state: GameState, viewerId: string | null): GameState {
	// --- Track P8 (CR 401.5): Capture mid-cast/activation flag before deleting pendingCostPayment ---
	const midCastOrActivation = Boolean(state.pendingCostPayment);
	const clone: GameState = JSON.parse(JSON.stringify(state));
	delete clone.rngState;
	delete clone.nextUid;
	delete clone.idSalt;
	delete clone.pendingTriggers;
	delete clone.pendingCostPayment;
	delete clone.pendingProcedure;

	for (const item of clone.stack) {
		delete item.effectResume;
		scrubFaceDownStackItem(item, viewerId);
		if (item.triggerEventStackItem) {
			scrubFaceDownStackItem(item.triggerEventStackItem, viewerId);
		}
	}

	const activeHandCandidateIds = new Set<string>();
	if (viewerId !== null) {
		for (const pr of clone.pendingPrompts) {
			if (
				pr.playerId === viewerId &&
				pr.choice?.kind === 'chooseObjects' &&
				pr.choice.zone === 'hand'
			) {
				for (const cid of pr.choice.candidates) activeHandCandidateIds.add(cid);
			}
		}
	}

	for (const p of clone.players) {
		p.handCount = p.hand.length;
		p.libraryCount = p.library.length;
		if (p.playerId !== viewerId) {
			// --- Track P17a: CR 400.2, 402 static hand reveal ("play with their hands revealed") ---
			const handRevealedByStatic = isPlayerHandRevealedToViewer(state, p.playerId, viewerId);
			// --- End Track P17a ---
			// Hide opponent hand contents unless revealed to viewerId (CR 701.20a) or referenced by an active hand choice prompt
			if (!handRevealedByStatic) {
				p.hand =
					viewerId === null
						? []
						: p.hand.filter(
								(c) =>
									Boolean(c.knownToPlayerIds?.includes(viewerId)) ||
									activeHandCandidateIds.has(c.instanceId)
							);
			}
		}
		for (const perm of p.battlefield) {
			scrubFaceDownInstance(perm, 'battlefield', viewerId);
		}
		for (const ex of p.exile) {
			scrubFaceDownInstance(ex, 'exile', viewerId);
		}
		// Expose full library list if viewer is currently searching this player's library (either their own or an opponent's via Opposition Agent)
		const isSearchingThisLibrary =
			viewerId !== null &&
			clone.pendingPrompts.some(
				(pr) =>
					pr.playerId === viewerId &&
					(effectivePromptPurpose(pr) === 'search_library' ||
						(pr.choice?.kind === 'chooseObjects' && pr.choice.zone === 'library')) &&
					(pr.targetLibraryOwnerId || pr.playerId) === p.playerId
			);
		const scryPrompt =
			p.playerId === viewerId
				? clone.pendingPrompts.find(
						(pr) =>
							pr.playerId === viewerId &&
							(pr.kind === 'scry_choice' || pr.choice?.kind === 'orderObjects')
					)
				: undefined;
		const scryIds =
			scryPrompt?.choice?.kind === 'orderObjects'
				? scryPrompt.choice.objectIds
				: scryPrompt?.candidateInstanceIds;
		if (scryIds) {
			p.library = p.library.filter((c) => scryIds.includes(c.instanceId));
		} else if (!isSearchingThisLibrary) {
			// --- Track P8 + Track P17a (CR 401.5): Top-of-library look / reveal visibility ---
			const topVis = getPlayerTopOfLibraryVisibility(state, p.playerId);
			if (topVis.revealToAll || isPlayerTopLibraryRevealedByGlobalStatic(state, p.playerId)) {
				p.library = p.library.slice(0, 1);
			} else if (
				topVis.lookByController &&
				viewerId === p.playerId &&
				!midCastOrActivation
			) {
				p.library = p.library.slice(0, 1);
			} else {
				p.library = [];
			}
		}
	}

	if (clone.pendingZoneMoves) {
		clone.pendingZoneMoves = clone.pendingZoneMoves.filter((c) => {
			if (c.isFaceDown) return false;
			const promptCont = state.pendingPrompts.find(
				(pr) =>
					pr.continuation?.kind === 'handler' &&
					pr.continuation.data?.objectId === c.instanceId
			)?.continuation;
			const promptData = promptCont?.kind === 'handler' ? promptCont.data : undefined;
			const originZone = (promptData?.fromZone as ZoneType | undefined) ?? c.zone;
			const originPlayerId =
				(promptData?.fromPlayerId as string | undefined) ?? c.ownerId ?? c.controllerId;
			if (
				originZone === 'hand' &&
				originPlayerId !== viewerId &&
				!(viewerId !== null && c.knownToPlayerIds?.includes(viewerId))
			) {
				return false;
			}
			if (originZone === 'library') {
				const isSearchingOriginLibrary =
					viewerId !== null &&
					state.pendingPrompts.some(
						(pr) =>
							pr.playerId === viewerId &&
							(effectivePromptPurpose(pr) === 'search_library' ||
								(pr.choice?.kind === 'chooseObjects' && pr.choice.zone === 'library')) &&
							(pr.targetLibraryOwnerId || pr.playerId) === originPlayerId
					);
				if (!isSearchingOriginLibrary) return false;
			}
			return true;
		});
		if (clone.pendingZoneMoves.length === 0) {
			delete clone.pendingZoneMoves;
		}
	}

	clone.pendingPrompts = clone.pendingPrompts.map((pr) => {
		if (pr.playerId === viewerId) {
			if (pr.stackItem) {
				delete pr.stackItem.effectResume;
				scrubFaceDownStackItem(pr.stackItem, viewerId);
			}
			return pr;
		}
		return redactPromptForOpponent(pr);
	});

	return clone;
}

export function getAttachedCardsOnBoard(
	state: GameState,
	hostInstanceId: string
): CardInstance[] {
	const out: CardInstance[] = [];
	for (const p of state.players) {
		for (const c of p.battlefield) {
			if (!c.phasedOut && c.attachedToId === hostInstanceId) {
				out.push(c);
			}
		}
	}
	return out;
}

export function getHostCardOnBoard(
	state: GameState,
	attachedToId: string | null | undefined
): CardInstance | null {
	if (!attachedToId) return null;
	const found = findPermanentOnBoard(state, attachedToId);
	return found ? found.inst : null;
}
