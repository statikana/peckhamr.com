import {
	checkEndTurnLegality,
	checkMandatoryAttackersSatisfied
} from '../engine.ts';
import type {
	GameActionPayload,
	GamePhase,
	GameState,
	PlayerGameState
} from '../types.ts';
import type { BoardViewModel, PermanentView } from './boardViewModel.ts';

export interface CombatDraftState {
	draftAttackers: Record<string, string>;
	draftAttackerWalkers: Record<string, string | null>;
	draftBlockers: Record<string, string>;
	selectedBlockerId: string | null;
}

export const TURN_PHASE_GROUPS = [
	{ id: 'beginning', label: 'Beginning' },
	{ id: 'main1', label: 'Main 1' },
	{ id: 'combat', label: 'Combat' },
	{ id: 'main2', label: 'Main 2' },
	{ id: 'ending', label: 'Ending' }
] as const;

export type TurnPhaseGroupId = (typeof TURN_PHASE_GROUPS)[number]['id'];

export interface PhaseStepDetail {
	group: TurnPhaseGroupId;
	groupIndex: number;
	phaseTitle: string;
	stepTitle: string;
	nextLabel: string;
}

export const PHASE_STEP_DETAILS: Record<GamePhase, PhaseStepDetail> = {
	untap: { group: 'beginning', groupIndex: 0, phaseTitle: 'Beginning', stepTitle: 'Untap', nextLabel: 'Next: Upkeep' },
	upkeep: { group: 'beginning', groupIndex: 0, phaseTitle: 'Beginning', stepTitle: 'Upkeep', nextLabel: 'Next: Draw' },
	draw: { group: 'beginning', groupIndex: 0, phaseTitle: 'Beginning', stepTitle: 'Draw', nextLabel: 'Next: Main 1' },
	main1: { group: 'main1', groupIndex: 1, phaseTitle: 'Main 1', stepTitle: 'Precombat', nextLabel: 'Next: Combat' },
	begin_combat: { group: 'combat', groupIndex: 2, phaseTitle: 'Combat', stepTitle: 'Begin Combat', nextLabel: 'Next: Attackers' },
	declare_attackers: { group: 'combat', groupIndex: 2, phaseTitle: 'Combat', stepTitle: 'Attackers', nextLabel: 'Next: Blockers' },
	declare_blockers: { group: 'combat', groupIndex: 2, phaseTitle: 'Combat', stepTitle: 'Blockers', nextLabel: 'Next: Damage' },
	first_strike_damage: { group: 'combat', groupIndex: 2, phaseTitle: 'Combat', stepTitle: 'First Strike', nextLabel: 'Next: Damage' },
	combat_damage: { group: 'combat', groupIndex: 2, phaseTitle: 'Combat', stepTitle: 'Damage', nextLabel: 'Next: End Combat' },
	end_combat: { group: 'combat', groupIndex: 2, phaseTitle: 'Combat', stepTitle: 'End Combat', nextLabel: 'Next: Main 2' },
	main2: { group: 'main2', groupIndex: 3, phaseTitle: 'Main 2', stepTitle: 'Postcombat', nextLabel: 'Next: End Step' },
	end_step: { group: 'ending', groupIndex: 4, phaseTitle: 'Ending', stepTitle: 'End Step', nextLabel: 'Next: Cleanup' },
	cleanup: { group: 'ending', groupIndex: 4, phaseTitle: 'Ending', stepTitle: 'Cleanup', nextLabel: 'Pass Priority' }
};

export interface TurnControlView {
	phaseDetail: PhaseStepDetail;
	isConfirmingAttackers: boolean;
	isConfirmingBlockers: boolean;
	canAdvanceOrPass: boolean;
	primaryStepLabel: string;
	primaryStepTitle: string;
	canPassToEndOfTurn: boolean;
	endTurnTitle: string;
}

export function deriveTurnControlView(
	gameState: GameState,
	viewer: PlayerGameState | undefined,
	draft: CombatDraftState,
	isTargeting: boolean
): TurnControlView {
	const phaseDetail = PHASE_STEP_DETAILS[gameState.phase];
	const activePlayer = gameState.players[gameState.activePlayerIndex];
	const priorityPlayer = gameState.players[gameState.priorityPlayerIndex];
	const isMyTurn = Boolean(viewer && activePlayer?.playerId === viewer.playerId);
	const hasPriority = Boolean(viewer && priorityPlayer?.playerId === viewer.playerId);

	const isConfirmingAttackers = Boolean(
		viewer &&
			gameState.stack.length === 0 &&
			gameState.phase === 'declare_attackers' &&
			isMyTurn &&
			!gameState.combat.active
	);

	const isConfirmingBlockers = Boolean(
		viewer &&
			gameState.stack.length === 0 &&
			gameState.phase === 'declare_blockers' &&
			!isMyTurn &&
			gameState.combat.attackers.some((a) => a.defenderPlayerId === viewer.playerId) &&
			!(gameState.combat.declaredBlockersPlayerIds || []).includes(viewer.playerId)
	);

	const mandatoryCheck =
		viewer && isConfirmingAttackers
			? checkMandatoryAttackersSatisfied(
					gameState,
					viewer.playerId,
					Object.keys(draft.draftAttackers)
				)
			: { ok: true as boolean, error: undefined as string | undefined };

	const canAdvanceOrPass = Boolean(
		viewer &&
			!viewer.lost &&
			gameState.status === 'active' &&
			hasPriority &&
			gameState.pendingPrompts.length === 0 &&
			!isTargeting &&
			mandatoryCheck.ok
	);

	let primaryStepLabel: string;
	if (gameState.stack.length > 0) {
		primaryStepLabel = `Resolve Stack (${gameState.stack.length})`;
	} else if (isConfirmingAttackers) {
		const count = Object.keys(draft.draftAttackers).length;
		primaryStepLabel =
			count > 0 ? `Attack with ${count}` : !mandatoryCheck.ok ? 'Must Attack' : 'No Attacks';
	} else if (isConfirmingBlockers) {
		const count = Object.keys(draft.draftBlockers).length;
		primaryStepLabel =
			count > 0 ? `Confirm ${count} Block${count > 1 ? 's' : ''}` : 'No Blocks';
	} else if (isMyTurn) {
		primaryStepLabel =
			gameState.phase === 'declare_attackers' &&
			gameState.combat.active &&
			gameState.combat.attackers.length === 0
				? 'Next: Main 2'
				: phaseDetail.nextLabel;
	} else {
		primaryStepLabel = 'Pass Priority';
	}

	let primaryStepTitle: string;
	if (!viewer || viewer.lost || gameState.status !== 'active') {
		primaryStepTitle = 'Game is not currently active.';
	} else if (isTargeting) {
		primaryStepTitle = 'Finish or cancel target selection first.';
	} else if (gameState.pendingPrompts.length > 0) {
		primaryStepTitle = 'Resolve the active prompt first.';
	} else if (!hasPriority) {
		primaryStepTitle = `Waiting for priority (${priorityPlayer?.username ?? 'opponent'}).`;
	} else if (!mandatoryCheck.ok) {
		primaryStepTitle =
			mandatoryCheck.error ?? 'A creature you control must attack this combat if able.';
	} else if (gameState.stack.length > 0) {
		primaryStepTitle = 'Pass priority to resolve the top item on the Stack.';
	} else if (isConfirmingAttackers) {
		primaryStepTitle =
			Object.keys(draft.draftAttackers).length > 0
				? 'Confirm declared attackers.'
				: 'Declare no attackers and advance to Main Phase 2.';
	} else if (isConfirmingBlockers) {
		primaryStepTitle =
			Object.keys(draft.draftBlockers).length > 0
				? 'Confirm declared blockers.'
				: 'Declare no blockers.';
	} else {
		primaryStepTitle = isMyTurn
			? `Pass priority to advance from ${phaseDetail.phaseTitle} (${phaseDetail.stepTitle}).`
			: 'Pass priority.';
	}

	const endTurnLegality = !viewer
		? { ok: false, error: 'Player is not active in this game.' }
		: isTargeting
			? { ok: false, error: 'Finish or cancel target selection first.' }
			: checkEndTurnLegality(gameState, viewer.playerId);

	return {
		phaseDetail,
		isConfirmingAttackers,
		isConfirmingBlockers,
		canAdvanceOrPass,
		primaryStepLabel,
		primaryStepTitle,
		canPassToEndOfTurn: endTurnLegality.ok,
		endTurnTitle: endTurnLegality.ok
			? 'Pass priority through remaining phases and steps to end your turn.'
			: (endTurnLegality.error ?? 'Cannot pass to end of turn right now.')
	};
}

export function createEmptyCombatDraft(): CombatDraftState {
	return {
		draftAttackers: {},
		draftAttackerWalkers: {},
		draftBlockers: {},
		selectedBlockerId: null
	};
}

export function isCombatDraftEmpty(draft: CombatDraftState): boolean {
	return (
		Object.keys(draft.draftAttackers).length === 0 &&
		Object.keys(draft.draftAttackerWalkers).length === 0 &&
		Object.keys(draft.draftBlockers).length === 0 &&
		draft.selectedBlockerId === null
	);
}

export function findDefaultDefendingPlayer(
	gameState: GameState,
	viewerId: string
): PlayerGameState | undefined {
	return gameState.players.find((p) => p.playerId !== viewerId && !p.lost);
}

export function canViewerSelectAllAttackers(
	boardVM: BoardViewModel,
	gameState: GameState,
	viewerId: string,
	options: {
		isConfirmingAttackers: boolean;
		hasPriority: boolean;
		interactionBlocked: boolean;
	}
): boolean {
	if (
		!options.isConfirmingAttackers ||
		!options.hasPriority ||
		options.interactionBlocked ||
		gameState.pendingPrompts.length > 0
	) {
		return false;
	}
	if (!findDefaultDefendingPlayer(gameState, viewerId)) return false;
	return (
		boardVM.frontRow.some((v) => v.actableSummary.canAttackNow) ||
		boardVM.backRow.some((v) => v.actableSummary.canAttackNow)
	);
}

export function toggleDraftAttacker(
	draft: CombatDraftState,
	permView: PermanentView,
	gameState: GameState,
	viewerId: string
): CombatDraftState {
	const id = permView.instanceId;
	if (draft.draftAttackers[id]) {
		const nextAtk = { ...draft.draftAttackers };
		const nextWalkers = { ...draft.draftAttackerWalkers };
		delete nextAtk[id];
		delete nextWalkers[id];
		return {
			...draft,
			draftAttackers: nextAtk,
			draftAttackerWalkers: nextWalkers
		};
	}
	if (!permView.actableSummary.canAttackNow) {
		return draft;
	}
	const defaultDef = findDefaultDefendingPlayer(gameState, viewerId);
	if (!defaultDef) return draft;
	return {
		...draft,
		draftAttackers: {
			...draft.draftAttackers,
			[id]: defaultDef.playerId
		}
	};
}

export function selectAllEligibleAttackers(
	draft: CombatDraftState,
	boardVM: BoardViewModel,
	gameState: GameState,
	viewerId: string
): CombatDraftState {
	const defaultDef = findDefaultDefendingPlayer(gameState, viewerId);
	if (!defaultDef) return draft;
	const nextAtk: Record<string, string> = {};
	const nextWalkers: Record<string, string | null> = {};
	for (const row of [boardVM.frontRow, boardVM.backRow]) {
		for (const pView of row) {
			if (!pView.actableSummary.canAttackNow) continue;
			nextAtk[pView.instanceId] = draft.draftAttackers[pView.instanceId] || defaultDef.playerId;
			if (draft.draftAttackerWalkers[pView.instanceId]) {
				nextWalkers[pView.instanceId] = draft.draftAttackerWalkers[pView.instanceId];
			}
		}
	}
	return {
		...draft,
		draftAttackers: nextAtk,
		draftAttackerWalkers: nextWalkers
	};
}

export function retargetDraftAttackersToPlayer(
	draft: CombatDraftState,
	targetPlayer: PlayerGameState,
	viewerId: string
): CombatDraftState {
	if (targetPlayer.playerId === viewerId || targetPlayer.lost) return draft;
	const attackerIds = Object.keys(draft.draftAttackers);
	if (attackerIds.length === 0) return draft;
	const updated: Record<string, string> = {};
	for (const atkId of attackerIds) {
		updated[atkId] = targetPlayer.playerId;
	}
	return {
		...draft,
		draftAttackers: updated,
		draftAttackerWalkers: {}
	};
}

export function retargetDraftAttackersToPlaneswalker(
	draft: CombatDraftState,
	walkerView: PermanentView,
	ownerPlayerId: string,
	viewerId: string
): CombatDraftState {
	if (ownerPlayerId === viewerId || !walkerView.isPlaneswalker) return draft;
	const attackerIds = Object.keys(draft.draftAttackers);
	if (attackerIds.length === 0) return draft;
	const updatedDef: Record<string, string> = {};
	const updatedWalkers: Record<string, string | null> = {};
	for (const atkId of attackerIds) {
		updatedDef[atkId] = ownerPlayerId;
		updatedWalkers[atkId] = walkerView.instanceId;
	}
	return {
		...draft,
		draftAttackers: updatedDef,
		draftAttackerWalkers: updatedWalkers
	};
}

export function toggleOrSelectBlocker(
	draft: CombatDraftState,
	blockerView: PermanentView,
	gameState: GameState,
	viewerId: string
): CombatDraftState {
	const id = blockerView.instanceId;
	if (draft.draftBlockers[id]) {
		const nextBlk = { ...draft.draftBlockers };
		delete nextBlk[id];
		return {
			...draft,
			draftBlockers: nextBlk,
			selectedBlockerId: draft.selectedBlockerId === id ? null : draft.selectedBlockerId
		};
	}
	if (draft.selectedBlockerId === id) {
		return {
			...draft,
			selectedBlockerId: null
		};
	}
	if (!blockerView.actableSummary.canBlockNow) {
		return draft;
	}
	const attackersOnViewer = gameState.combat.attackers.filter(
		(a) => a.defenderPlayerId === viewerId
	);
	if (attackersOnViewer.length === 1) {
		return {
			...draft,
			draftBlockers: {
				...draft.draftBlockers,
				[id]: attackersOnViewer[0].attackerInstanceId
			},
			selectedBlockerId: null
		};
	}
	return {
		...draft,
		selectedBlockerId: id
	};
}

export function assignSelectedBlockerToAttacker(
	draft: CombatDraftState,
	attackerInstanceId: string,
	gameState: GameState
): CombatDraftState {
	if (!draft.selectedBlockerId) return draft;
	const isAttacker = gameState.combat.attackers.some(
		(a) => a.attackerInstanceId === attackerInstanceId
	);
	if (!isAttacker) return draft;
	return {
		...draft,
		draftBlockers: {
			...draft.draftBlockers,
			[draft.selectedBlockerId]: attackerInstanceId
		},
		selectedBlockerId: null
	};
}

export function pruneStaleCombatDraft(
	draft: CombatDraftState,
	gameState: GameState,
	viewerId: string
): CombatDraftState {
	const activePlayer = gameState.players[gameState.activePlayerIndex];
	const isMyTurn = activePlayer?.playerId === viewerId;
	const canDraftAttackers =
		gameState.phase === 'declare_attackers' && isMyTurn && !gameState.combat.active;
	const canDraftBlockers = gameState.phase === 'declare_blockers' && !isMyTurn;

	const hasAtk =
		Object.keys(draft.draftAttackers).length > 0 ||
		Object.keys(draft.draftAttackerWalkers).length > 0;
	const hasBlk =
		Object.keys(draft.draftBlockers).length > 0 || draft.selectedBlockerId !== null;

	const clearAtk = hasAtk && !canDraftAttackers;
	const clearBlk = hasBlk && !canDraftBlockers;
	if (!clearAtk && !clearBlk) {
		return draft;
	}
	return {
		draftAttackers: clearAtk ? {} : draft.draftAttackers,
		draftAttackerWalkers: clearAtk ? {} : draft.draftAttackerWalkers,
		draftBlockers: clearBlk ? {} : draft.draftBlockers,
		selectedBlockerId: clearBlk ? null : draft.selectedBlockerId
	};
}

export function buildDeclareAttackersPayload(
	draft: CombatDraftState
): Extract<GameActionPayload, { type: 'declare_attackers' }> {
	return {
		type: 'declare_attackers',
		assignments: Object.entries(draft.draftAttackers).map(
			([attackerInstanceId, defenderPlayerId]) => ({
				attackerInstanceId,
				defenderPlayerId,
				defenderPlaneswalkerId: draft.draftAttackerWalkers[attackerInstanceId] || null
			})
		)
	};
}

export function buildDeclareBlockersPayload(
	draft: CombatDraftState
): Extract<GameActionPayload, { type: 'declare_blockers' }> {
	return {
		type: 'declare_blockers',
		assignments: Object.entries(draft.draftBlockers).map(
			([blockerInstanceId, attackerInstanceId]) => ({
				blockerInstanceId,
				attackerInstanceId
			})
		)
	};
}
