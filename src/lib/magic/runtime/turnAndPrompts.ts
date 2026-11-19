import { compileSpellEffects } from '../compiler/index.ts';
import type { CostDef, TokenSpec } from '../ir.ts';
import {
	buildTokenScryfallCard,
	describeLibrarySearchDestination,
	matchesLibrarySearchSpec,
	parseManaCost,
	withStackItemText
} from '../oracle.ts';
import {
	checkGlobalCastPermissionsAndRestrictions,
	evaluatePermanent,
	getLibrarySearchInterceptor,
	playerCannotLoseGame,
	playerCannotWinGame
} from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	CostPayment,
	CounterType,
	GameActionPayload,
	GameState,
	GuidedOperation,
	HandSpecialActionOption,
	LibrarySearchDestination,
	LibrarySearchSpec,
	PendingCostPayment,
	PendingPrompt,
	PlayerGameState,
	ProcedureContinuation,
	ScryfallCard,
	StackItem,
	TargetRef,
	ZoneType
} from '../types.ts';
import {
	effectivePromptChoice,
	effectivePromptPurpose,
	enqueueChoicePrompt,
	normalizePromptAction,
	registerPromptHandler,
	runPromptHandler,
	validateChoiceAnswer
} from './choices.ts';
import { clearP7EndOfTurnEffects, resetTurnHistoryAtTurnStart } from './copyPreventionAndEffects.ts';
import { canPayCosts, chooseCostPayment, getSuspendSpec } from './costs.ts';
import { resetP20bPlayerTurnState } from './costsWave7.ts';
import { gainPlayerLife } from './effects.ts';
import { cleanupP13TurnState, expireP13UntilNextTurnEffects } from './effectsWave5.ts';
import {
	cleanupP16aTurnState,
	consumeP16aOnSpellCast,
	expireP16aEndOfCombatEffects,
	isNegativeArbitraryCounter,
	isPermanentFrozenByP16aSourceCondition,
	latchBrokenP16aSourceConditions,
	playerHasP16aFlashGrantForTypes
} from './effectsWave6.ts';
import { cleanupP19aTurnState } from './effectsWave7.ts';
import { clearWave9TurnStartState, runWave9NextCombatDelayedTriggers } from './triggersWave9.ts';
import {
	clearWave10TurnEndState,
	clearWave10YourNextTurnDirectives,
	registerEndCombatHooksWave10
} from './combatWave10.ts';
import { clearWave11TurnEndState, isPhasingInLockedBySource } from './effectsWave11.ts';
import { flushPendingNextMainPhaseMana } from './manaCountersWave11.ts';
import {
	addLog,
	allocateFaceDownLabel,
	createCardInstance,
	emitVfx,
	findCardAnywhere,
	findPermanentOnBoard,
	getAttackedDefenderIdsInTurnOrder,
	givePriorityToActiveOrNextPlayer,
	GUIDED_MAX_AMOUNT,
	GUIDED_ZONES,
	H,
	hasBlockingReplacementOrCommanderPrompt,
	hasKeyword,
	movePermanentToZone,
	resetTriggerLoopTracking,
	revealFaceDownObjects
} from './engineHost.ts';
import { emitEvent } from './events.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { getSuspendXSpec, substituteSuspendXManaCost } from './framesWave7.ts';
import {
	clearWave4StepScopedState,
	noteDrawnCardForMiracle,
	preservedFirebendingRedMana,
	resetWave4TurnStateAtTurnStart,
	tryDredgeBeforeSingleDraw
} from './keywordsWave4.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import { clearPlayerManaPoolAtCleanup } from './mana.ts';
import { matchesObjectFilter } from './objectFilter.ts';
import { enumerateHandSpecialActions } from './orthogonalKeywords.ts';
import { uid } from './random.ts';
import { expireDetainedEffectsForPlayer } from './reflexiveManaAndActions.ts';
import {
	applySelfEtbReplacements,
	hasRestriction,
	playerHasNoMaxHandSize,
	playerLifeTotalCantChange,
	replaceEmptyLibraryDraw
} from './replace.ts';
import {
	ALL_COUNTER_TYPES,
	clampSnowManaToPool,
	clearSnowManaPool,
	computeEffectiveMaxHandSize,
	permanentMayChooseNotToUntap,
	playerSkipsDrawStep
} from './staticsDynamicAndCosts.ts';
import {
	collectOtherPlayerUntapStepPermanents,
	emptyPlayerManaPoolWave6,
	evaluateLibrarySearchLock,
	evaluateSingleDrawWave6,
	getActiveUntapStepCaps,
	scalePlayerCountersPlaced
} from './staticsWave6.ts';
import { shouldPlayerSkipExtraTurn } from './staticsWave7.ts';
import {
	buildGrantedHandForetellActionOptionWave8,
	getActiveGrantedHandForetellCostWave8,
	permanentKeepsDamageInCleanupWave8,
	resetWave8TurnStateAtTurnStart
} from './staticsWave8.ts';
import { flushTriggers } from './triggers.ts';
import {
	capturePlayerEnergySnapshot,
	clearP19bEndOfTurnState,
	clearP19bPlayerManaPoolTracking,
	emitEnergyDiffEvents
} from './triggersWave7.ts';
import { clearP22bEndOfTurnState } from './triggersWave8.ts';
import { consumeNextUntapFreeze } from './tuckFreezeChosen.ts';
import {
	applyTokenReplacementsWave9,
	getProliferateMultiplierWave9,
	isTokenReplacementSuppressedWave9,
	resolveDrawReplacementWave9,
	runWithTokenReplacementSuppressedWave9
} from './replaceWave9.ts';
import {
	allocateTimestamp,
	attachObject,
	moveObject,
	mulliganRedraw,
	placeDeferred,
	rearrangeLibrary,
	shuffleLibrary,
	syncBattlefieldControllers,
	tapPermanent
} from './zones.ts';

export function winTheGame(state: GameState, player: PlayerGameState, reason: string): boolean {
	if (state.status === 'finished' || player.lost) return false;
	const winCheck = playerCannotWinGame(state, player);
	if (winCheck.blocked) {
		addLog(
			state,
			'rule',
			`${player.username}'s win condition (${reason}) was prevented by ${winCheck.sourceName}!`,
			player.playerId
		);
		return false;
	}
	state.status = 'finished';
	state.winnerPlayerId = player.playerId;
	for (const other of state.players) {
		if (other.playerId !== player.playerId) {
			other.lost = true;
			other.lossReason = `${player.username} won the game (${reason}).`;
		}
	}
	addLog(state, 'system', `${player.username} wins the game! (${reason})`, player.playerId);
	revealFaceDownObjects(state);
	emitVfx(state, {
		kind: 'victory',
		sourceId: player.playerId,
		label: `${player.username} Wins!`
	});
	return true;
}

export function loseTheGame(state: GameState, player: PlayerGameState, reason: string): boolean {
	if (player.lost || state.status === 'finished') return false;
	const lossLock = playerCannotLoseGame(state, player);
	if (lossLock.protected) {
		addLog(
			state,
			'rule',
			`${player.username} cannot lose the game (${reason}) due to ${lossLock.sourceName}!`,
			player.playerId
		);
		return false;
	}
	player.lost = true;
	player.lossReason = reason;
	addLog(state, 'sba', `${player.username} loses the game! (${reason})`, player.playerId);
	// --- Track P19b ---
	emitEvent(state, { kind: 'PlayerLostGame', playerId: player.playerId });
	// --- End Track P19b ---
	H().cleanupEliminatedPlayer(state, player);
	H().checkStateBasedActions(state);
	return true;
}

// --- Track P12: Dredge draw replacement (CR 702.52a) & Miracle first-draw tracking (CR 702.94a) ---
export function drawSingleCardWithoutDredge(
	state: GameState,
	player: PlayerGameState,
	deferSba = false
): 'drawn' | 'stopped' {
	// --- Track P17a: CR 121.2, 614.1a Draw locks & single-draw replacement multipliers ---
	let drawsToExecute = 1;
	if (state.status !== 'mulligan') {
		const wave6Draw = evaluateSingleDrawWave6(state, player);
		if (wave6Draw.markFirstDrawStepDraw) {
			player.drewFirstCardInDrawStepThisTurn = true;
		}
		if (wave6Draw.drawCount <= 0) {
			return 'drawn';
		}
		drawsToExecute = Math.min(wave6Draw.drawCount, 64);
	}
	for (let drawIter = 0; drawIter < drawsToExecute; drawIter++) {
		if (state.status !== 'mulligan') {
			const w9Draw = resolveDrawReplacementWave9(state, player, {
				drawSingleForPlayer: (s, tgtPl) => drawSingleCardWithoutDredge(s, tgtPl, deferSba),
				moveCardToHand: (s, c, ow) =>
					moveObject(s, c, 'hand', { from: { player: ow, zone: 'library' }, toPlayer: ow, commanderRedirect: true, newTimestamp: true, bumpVersion: true }),
				moveCardToBattlefield: (s, c, ow) =>
					moveObject(s, c, 'battlefield', { from: { player: ow, zone: 'graveyard' }, toPlayer: ow, controllerId: ow.playerId, newTimestamp: true, bumpVersion: true }),
				markPlayerLost: (s, loser, reason) => loseTheGame(s, loser, reason),
				addLog: (s, kind, msg, pid) => addLog(s, kind, msg, pid)
			});
			if (w9Draw.replaced) {
				if (w9Draw.result === 'stopped') return 'stopped';
				continue;
			}
		}
		if (player.library.length === 0) {
			const replaced = replaceEmptyLibraryDraw(state, player);
			if (replaced.replaced) {
				if (replaced.winsGame) {
					winTheGame(
						state,
						player,
						`${replaced.sourceName ?? 'Replacement Effect'} (drew from an empty library)`
					);
				}
				return 'stopped';
			}
			player.attemptedEmptyLibraryDraw = true;
			if (!deferSba) {
				H().checkStateBasedActions(state);
			}
			return 'stopped';
		}
		const drawnCard = player.library[0];
		moveObject(state, drawnCard, 'hand', {
			from: { player, zone: 'library' },
			toPlayer: player,
			commanderRedirect: true,
			newTimestamp: true,
			bumpVersion: true
		});
		if (state.status !== 'mulligan' && drawnCard.zone === 'hand') {
			const drawnPlayers = state.playersDrawnThisTurn ?? (state.playersDrawnThisTurn = []);
			if (!drawnPlayers.includes(player.playerId)) {
				drawnPlayers.push(player.playerId);
			}
			player.cardsDrawnThisTurn = (player.cardsDrawnThisTurn ?? 0) + 1;
			// --- Track P22b ---
			player.lastDrawnCardIdThisTurn = drawnCard.instanceId;
			let inOwnDrawStepOrdinal: number | undefined;
			if (
				state.phase === 'draw' &&
				state.players[state.activePlayerIndex]?.playerId === player.playerId
			) {
				inOwnDrawStepOrdinal = (player.drawsInYourDrawStepThisTurn ?? 0) + 1;
				player.drawsInYourDrawStepThisTurn = inOwnDrawStepOrdinal;
			}
			// --- End Track P22b ---
			noteDrawnCardForMiracle(state, player, drawnCard);
			emitEvent(state, {
				kind: 'CardDrawn',
				playerId: player.playerId,
				objectId: drawnCard.instanceId,
				object: drawnCard,
				// --- Track P22b ---
				...(inOwnDrawStepOrdinal !== undefined ? { inOwnDrawStepOrdinal } : {})
				// --- End Track P22b ---
			});
		}
	}
	return 'drawn';
	// --- End Track P17a ---
}
// --- End Track P12 ---

export function drawCards(
	state: GameState,
	player: PlayerGameState,
	count: number,
	deferSba = false
): void {
	for (let i = 0; i < count; i++) {
		// --- Track P12 ---
		const dredgeRes = tryDredgeBeforeSingleDraw(state, player, count - i - 1, deferSba);
		if (dredgeRes === 'prompted') {
			if (state.status !== 'mulligan' && !deferSba) {
				flushTriggers(state);
			}
			return;
		}
		if (dredgeRes === 'replaced') {
			continue;
		}
		if (drawSingleCardWithoutDredge(state, player, deferSba) === 'stopped') {
			break;
		}
		// --- End Track P12 ---
	}
	if (state.status !== 'mulligan' && !deferSba) {
		flushTriggers(state);
	}
}

export function emptyAllPlayersManaPools(state: GameState): void {
	for (const p of state.players) {
		// --- Track P12: Firebending red mana persists until end of combat (CR 702.189a) ---
		const origR = p.manaPool.R;
		const keepR = preservedFirebendingRedMana(state, p);
		// --- End Track P12 ---
		// --- Track P10 + Track P17a ---
		emptyPlayerManaPoolWave6(state, p, keepR);
		// --- End Track P10 + Track P17a ---
		// --- Track P12 ---
		if (keepR > 0) {
			p.manaPool.R = Math.min(origR, p.manaPool.R + keepR);
		}
		// --- End Track P12 ---
		// --- Track P11: clamp tracked snow mana to any remaining retained/firebending mana ---
		clampSnowManaToPool(p);
		// --- End Track P11 ---
		// --- Track P19b ---
		clearP19bPlayerManaPoolTracking(p);
		// --- End Track P19b ---
		p.manaRiders = [];
	}
}

// --- Track P11: Optional untap step choice ("You may choose not to untap ~ during your untap step.", CR 502.3) ---
const UNTAP_STEP_CHOICE_HANDLER = 'untap_step_choice';

function enqueueUntapChoicePrompt(
	state: GameState,
	playerId: string,
	perm: CardInstance,
	remainingIds: string[]
): void {
	const name = evaluatePermanent(state, perm).effectiveName;
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId,
		kind: 'chooseMode',
		purpose: 'generic',
		title: `Untap Step — ${name}`,
		description: `You may choose not to untap ${name} during your untap step (CR 502.3).`,
		cancellable: false,
		continuation: {
			kind: 'handler',
			name: UNTAP_STEP_CHOICE_HANDLER,
			data: {
				instanceId: perm.instanceId,
				remainingIdsCsv: remainingIds.join(',')
			}
		},
		choice: {
			kind: 'chooseMode',
			modes: [`Untap ${name}`, `Keep ${name} tapped`],
			min: 1,
			max: 1,
			defaultIndices: [0]
		}
	});
}

function botPrefersKeepingTapped(state: GameState, perm: CardInstance): boolean {
	const card = effectiveCardForObject(perm);
	const abs = activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'));
	for (const ab of abs) {
		if (
			ab.kind === 'static' &&
			ab.static.k === 'continuous' &&
			((ab.static.condition?.k === 'objectState' &&
				ab.static.condition.of === 'self' &&
				ab.static.condition.tapped === true) ||
				(ab.static.condition?.k === 'matchesFilter' &&
					ab.static.condition.filter.tapped === true))
		) {
			return true;
		}
	}
	return false;
}

registerPromptHandler(UNTAP_STEP_CHOICE_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : '';
	const remainingIds =
		typeof data?.remainingIdsCsv === 'string' && data.remainingIdsCsv.length > 0
			? data.remainingIdsCsv.split(',').filter(Boolean)
			: [];
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const activePlayer =
		state.players.find((p) => p.playerId === prompt.playerId) ??
		state.players[state.activePlayerIndex];
	if (!activePlayer || activePlayer.lost) return;

	const perm = activePlayer.battlefield.find((c) => !c.phasedOut && c.instanceId === instanceId);
	if (perm && perm.tapped && idx === 0) {
		if (perm.counters.stun > 0) {
			perm.counters.stun -= 1;
			noteLayerInputsChanged(state);
		} else {
			perm.tapped = false;
			noteLayerInputsChanged(state);
			// --- Track P10 ---
			emitEvent(state, {
				kind: 'BecomesUntapped',
				objectId: perm.instanceId,
				object: perm
			});
			// --- End Track P10 ---
		}
	}

	for (let i = 0; i < remainingIds.length; i++) {
		const nextId = remainingIds[i];
		const nextPerm = activePlayer.battlefield.find(
			(c) => !c.phasedOut && c.tapped && c.instanceId === nextId
		);
		if (nextPerm) {
			enqueueUntapChoicePrompt(state, activePlayer.playerId, nextPerm, remainingIds.slice(i + 1));
			return;
		}
	}

	emitEvent(state, {
		kind: 'PhaseBegin',
		phase: 'untap',
		activePlayerId: activePlayer.playerId
	});
	flushTriggers(state);
	emptyAllPlayersManaPools(state);
	H().beginPhase(state, 'upkeep', activePlayer);
	givePriorityToActiveOrNextPlayer(state);
	state.passedPriorityPlayerIds = [];
	state.turnStartedAt = Date.now();
	state.priorityUpdatedAt = Date.now();
	emitVfx(state, {
		kind: 'phase_change',
		label: `Turn ${state.turnNumber}: ${activePlayer.username} — Upkeep`
	});
	H().checkStateBasedActions(state);
});
// --- End Track P11 ---

export function executeUntapTurnBasedActions(state: GameState, activePlayer: PlayerGameState): boolean {
	activePlayer.landsPlayedThisTurn = 0;
	activePlayer.maxLandsPerTurn = 1;
	// --- Track P14 ---
	activePlayer.usedStaticPlaySlotsThisTurn = undefined;
	// --- End Track P14 ---

	// CR 502.1 & CR 702.26a/g: Before untapping, phasing in and phasing out happen simultaneously!
	// 1. Collect all permanents that will phase in:
	//    - activePlayer's directly phased-out permanents
	//    - any indirectly phased-out attachments across ALL players' battlefields attached to a permanent phasing in (CR 702.26g)
	const phasingInIds = new Set<string>();
	for (const perm of activePlayer.battlefield) {
		if (perm.phasedOut && !perm.phasedOutIndirectly) {
			phasingInIds.add(perm.instanceId);
		}
	}
	let addedPhaseIn = true;
	while (addedPhaseIn) {
		addedPhaseIn = false;
		for (const p of state.players) {
			for (const perm of p.battlefield) {
				if (
					perm.phasedOut &&
					perm.phasedOutIndirectly &&
					perm.attachedToId &&
					phasingInIds.has(perm.attachedToId) &&
					!phasingInIds.has(perm.instanceId)
				) {
					phasingInIds.add(perm.instanceId);
					addedPhaseIn = true;
				}
			}
		}
	}

	// 2. Collect all currently phased-in permanents that will phase out:
	//    - activePlayer's phased-in permanents with the Phasing keyword (CR 702.26a)
	//    - any phased-in attachments across ALL players' battlefields attached to a permanent phasing out (indirectly)
	const phasingOutDirectIds = new Set<string>();
	const phasingOutIndirectIds = new Set<string>();
	// Read-only scan: validate the layer cache once (Phase 6d).
	withStableLayerInputs(state, () => {
		for (const perm of activePlayer.battlefield) {
			if (!perm.phasedOut && hasKeyword(perm, 'Phasing', state)) {
				phasingOutDirectIds.add(perm.instanceId);
			}
		}
	});
	let addedPhaseOut = true;
	while (addedPhaseOut) {
		addedPhaseOut = false;
		for (const p of state.players) {
			for (const perm of p.battlefield) {
				if (
					!perm.phasedOut &&
					perm.attachedToId &&
					(phasingOutDirectIds.has(perm.attachedToId) ||
						phasingOutIndirectIds.has(perm.attachedToId)) &&
					!phasingOutIndirectIds.has(perm.instanceId)
				) {
					// CR 702.26h: If an object would simultaneously phase out directly and indirectly,
					// it just phases out indirectly.
					phasingOutDirectIds.delete(perm.instanceId);
					phasingOutIndirectIds.add(perm.instanceId);
					addedPhaseOut = true;
				}
			}
		}
	}

	// 3. Apply phasing in and phasing out simultaneously
	const phasedInNames: string[] = [];
	const phasedOutNames: string[] = [];
	// --- Track P16b ---
	const phasedInPerms: CardInstance[] = [];
	// --- End Track P16b ---
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (phasingInIds.has(perm.instanceId) && !isPhasingInLockedBySource(state, perm)) {
				perm.phasedOut = false;
				perm.phasedOutIndirectly = false;
				phasedInNames.push(perm.card.name);
				// --- Track P16b ---
				phasedInPerms.push(perm);
				// --- End Track P16b ---
			} else if (phasingOutDirectIds.has(perm.instanceId)) {
				perm.phasedOut = true;
				perm.phasedOutIndirectly = false;
				phasedOutNames.push(perm.card.name);
			} else if (phasingOutIndirectIds.has(perm.instanceId)) {
				perm.phasedOut = true;
				perm.phasedOutIndirectly = true;
				phasedOutNames.push(perm.card.name);
			}
		}
	}
	if (phasedInNames.length > 0 || phasedOutNames.length > 0) {
		noteLayerInputsChanged(state);
		syncBattlefieldControllers(state);
	}
	// --- Track P16b ---
	for (const perm of phasedInPerms) {
		emitEvent(state, {
			kind: 'PhasedIn',
			objectId: perm.instanceId,
			object: perm,
			controllerId: perm.controllerId
		});
	}
	// --- End Track P16b ---
	if (phasedInNames.length > 0) {
		addLog(
			state,
			'rule',
			`Phasing (CR 702.26): ${phasedInNames.join(', ')} phased in for ${activePlayer.username}.`,
			activePlayer.playerId
		);
	}
	if (phasedOutNames.length > 0) {
		addLog(
			state,
			'rule',
			`Phasing (CR 702.26): ${phasedOutNames.join(', ')} phased out for ${activePlayer.username}.`,
			activePlayer.playerId
		);
	}

	// 4. Untap step (CR 502.3 & CR 122.1d stun counter replacement)
	// CR 502.3: the active player's permanents untap simultaneously, so which ones "don't untap" is
	// decided against the board before any of them untaps. Deciding it inside the untap loop made
	// every `perm.tapped = false` invalidate the layer cache for the next permanent's check, a full
	// board re-evaluation per permanent (Phase 6d).
	// --- Track P11 ---
	const { keptTapped, mayChooseNotToUntapIds } = withStableLayerInputs(state, () => {
		const ids = new Set<string>();
		const optionalIds = new Set<string>();
		for (const perm of activePlayer.battlefield) {
			if (perm.phasedOut || !perm.tapped) continue;
			if (hasRestriction(state, perm, 'doesntUntap')) {
				ids.add(perm.instanceId);
			} else if (permanentMayChooseNotToUntap(state, perm)) {
				optionalIds.add(perm.instanceId);
			}
		}
		return { keptTapped: ids, mayChooseNotToUntapIds: optionalIds };
	});
	// --- Track P10 + P11 ---
	const untappedPerms: CardInstance[] = [];
	const humanOptionalCandidates: CardInstance[] = [];
	// --- End Track P10 + P11 ---
	// --- Track P17a: CR 502.3 untap-step caps (e.g. Winter Orb, Static Orb) ---
	const untapCaps = getActiveUntapStepCaps(state, activePlayer.playerId);
	const untapCapUsed = untapCaps.map(() => 0);
	const canUntapUnderCaps = (perm: CardInstance): boolean => {
		for (let ci = 0; ci < untapCaps.length; ci++) {
			const cap = untapCaps[ci]!;
			if (
				!cap.filter ||
				matchesObjectFilter(perm, cap.filter, { state, controllerId: activePlayer.playerId })
			) {
				if (untapCapUsed[ci]! >= cap.max) return false;
			}
		}
		return true;
	};
	const recordUntappedUnderCaps = (perm: CardInstance): void => {
		for (let ci = 0; ci < untapCaps.length; ci++) {
			const cap = untapCaps[ci]!;
			if (
				!cap.filter ||
				matchesObjectFilter(perm, cap.filter, { state, controllerId: activePlayer.playerId })
			) {
				untapCapUsed[ci]! += 1;
			}
		}
	};
	// --- End Track P17a ---
	for (const perm of activePlayer.battlefield) {
		if (perm.phasedOut) continue;
		const frozenNextUntap = consumeNextUntapFreeze(perm);
		// --- Track P16a: Source-conditioned untap lock ("doesn't untap as long as ...") ---
		const frozenBySourceCond = isPermanentFrozenByP16aSourceCondition(state, perm);
		// --- End Track P16a ---
		if (
			!frozenNextUntap &&
			!frozenBySourceCond &&
			perm.tapped &&
			!keptTapped.has(perm.instanceId) &&
			canUntapUnderCaps(perm)
		) {
			if (mayChooseNotToUntapIds.has(perm.instanceId)) {
				if (activePlayer.isBot) {
					if (!botPrefersKeepingTapped(state, perm)) {
						if (perm.counters.stun > 0) {
							perm.counters.stun -= 1;
						} else {
							perm.tapped = false;
							untappedPerms.push(perm);
							recordUntappedUnderCaps(perm);
						}
					}
				} else {
					humanOptionalCandidates.push(perm);
				}
			} else if (perm.counters.stun > 0) {
				perm.counters.stun -= 1;
			} else {
				perm.tapped = false;
				// --- Track P10 ---
				untappedPerms.push(perm);
				// --- End Track P10 ---
				recordUntappedUnderCaps(perm);
			}
		}
		perm.summoningSick = false;
		perm.usedLoyaltyThisTurn = false;
		// --- Track P18b ---
		perm.loyaltyActivationsThisTurn = undefined;
		// --- End Track P18b ---
		perm.activatedAbilityIdsThisTurn = undefined;
		perm.usedModalModesThisTurn = undefined;
	}
	// --- Track P17a: CR 502.3 untap during each other player's untap step (e.g. Seedborn Muse, Murkfiend Liege) ---
	for (const otherPerm of collectOtherPlayerUntapStepPermanents(state, activePlayer.playerId)) {
		if (!otherPerm.tapped || otherPerm.phasedOut) continue;
		if (otherPerm.counters.stun > 0) {
			otherPerm.counters.stun -= 1;
		} else {
			otherPerm.tapped = false;
			untappedPerms.push(otherPerm);
		}
	}
	// --- End Track P17a ---
	// --- Track P10 ---
	if (untappedPerms.length > 0) {
		noteLayerInputsChanged(state);
		// --- Track P16a (CR 611.2b): Permanently latch remainsTapped continuous effects ---
		latchBrokenP16aSourceConditions(state);
		// --- End Track P16a ---
		for (const perm of untappedPerms) {
			emitEvent(state, {
				kind: 'BecomesUntapped',
				objectId: perm.instanceId,
				object: perm
			});
		}
	}
	// --- End Track P10 ---
	// --- Track P12: reset once-per-turn Forecast activations on cards in hand ---
	for (const hc of activePlayer.hand) {
		hc.activatedAbilityIdsThisTurn = undefined;
	}
	// --- End Track P12 ---
	// --- Track P11 ---
	if (humanOptionalCandidates.length > 0) {
		enqueueUntapChoicePrompt(
			state,
			activePlayer.playerId,
			humanOptionalCandidates[0],
			humanOptionalCandidates.slice(1).map((p) => p.instanceId)
		);
		return true;
	}
	return false;
	// --- End Track P11 ---
}

export function executeDrawTurnBasedAction(state: GameState, activePlayer: PlayerGameState): void {
	// --- Track P11: CR 504.1 / 614.10a "Skip your draw step." ---
	if (playerSkipsDrawStep(state, activePlayer.playerId)) {
		addLog(
			state,
			'rule',
			`${activePlayer.username} skips their draw step (static effect).`,
			activePlayer.playerId
		);
		return;
	}
	// --- End Track P11 ---
	const shouldSkipFirstDraw =
		state.turnNumber === 1 &&
		state.activePlayerIndex === 0 &&
		state.players.length === 2 &&
		!state.rules.firstTurnDraw;
	if (!shouldSkipFirstDraw) {
		drawCards(state, activePlayer, 1);
		if (state.status === 'finished') return;
		addLog(
			state,
			'rule',
			`${activePlayer.username} untaps and draws a card for Turn ${state.turnNumber}.`,
			activePlayer.playerId
		);
	} else {
		addLog(
			state,
			'rule',
			`${activePlayer.username} skips the Turn 1 draw step (1v1 rule).`,
			activePlayer.playerId
		);
	}
}

/**
 * Clears "until your next turn" effects created by `playerId`, including protection/prevention flags
 * and goad obligations (CR 701.15a, CR 800.4m).
 */
export function expirePlayerUntilNextTurnEffects(state: GameState, playerId: string): void {
	const player = state.players.find((p) => p.playerId === playerId);
	if (player) {
		player.cannotLoseGameThisTurn = false;
		player.lifeTotalCannotChangeThisTurn = false;
		player.protectionFromEverythingThisTurn = false;
		player.preventAllCombatDamageThisTurn = false;
	}
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (!perm.goadedByPlayerIds) continue;
			const hasEntry = perm.goadedByPlayerIds.includes(playerId);
			const exp = perm.goadExpirations?.[playerId];
			if (!hasEntry && exp === undefined) continue;
			// Only remove goad created by `playerId` when its duration was untilYourNextTurn (or unspecified).
			if (exp === undefined || exp === 'untilYourNextTurn') {
				perm.goadedByPlayerIds = perm.goadedByPlayerIds.filter((id) => id !== playerId);
				if (perm.goadedByPlayerIds.length === 0) perm.goadedByPlayerIds = undefined;
				if (perm.goadExpirations) {
					delete perm.goadExpirations[playerId];
					if (Object.keys(perm.goadExpirations).length === 0) perm.goadExpirations = undefined;
				}
			}
		}
	}
	// --- Track P10 ---
	expireDetainedEffectsForPlayer(state, playerId);
	// --- End Track P10 ---
	// --- Track P13 ---
	expireP13UntilNextTurnEffects(state, playerId);
	// --- End Track P13 ---
	clearWave10YourNextTurnDirectives(state, playerId);
}

export function runBeginningOfTurn(state: GameState): void {
	const activePlayer = state.players[state.activePlayerIndex];
	if (!activePlayer || activePlayer.lost) return;

	// Clear "until your next turn" effects (e.g., Teferi's Protection, goad per CR 701.15a)
	expirePlayerUntilNextTurnEffects(state, activePlayer.playerId);
	// --- Track P22a ---
	resetWave8TurnStateAtTurnStart(state, activePlayer);
	// --- End Track P22a ---
	for (const p of state.players) {
		p.spellsCastThisTurn = 0;
		p.cardsDrawnThisTurn = 0;
		// --- Track P9 ---
		p.damageDealtToThisTurn = 0;
		// --- End Track P9 ---
		// --- Track P15 ---
		delete p.dealtCombatDamageWithSubtypesThisTurn;
		delete p.dealtCombatDamageWithCommanderThisTurn;
		// --- End Track P15 ---
		// --- Track P16b ---
		delete p.committedCrimeThisTurn;
		delete p.cardLeftGraveyardThisTurn;
		// --- End Track P16b ---
		// --- Track P17a ---
		p.drewFirstCardInDrawStepThisTurn = false;
		// --- End Track P17a ---
		// --- Track P20b ---
		resetP20bPlayerTurnState(p);
		// --- End Track P20b ---
	}
	state.playersDrawnThisTurn = [];
	state.triggeredOnceThisTurn = undefined;
	// --- Track P16b ---
	state.doThisOnceTakenThisTurn = undefined;
	state.combatPhasesCountThisTurn = 0;
	// --- End Track P16b ---
	// --- Track P16a (CR 603.2h): Reset "Do this only once each turn" keys ---
	state.doneOnceThisTurnKeys = undefined;
	// --- End Track P16a ---
	// --- Track P15: Day/Night spell history (CR 732.5) & Gravestorm counter (CR 702.69a) ---
	state.prevTurnSpellsCastByActivePlayer = state.spellsCastByActivePlayerThisTurn ?? 0;
	state.spellsCastByActivePlayerThisTurn = 0;
	state.permanentsPutIntoGraveyardFromBattlefieldThisTurn = 0;
	// --- End Track P15 ---
	// --- Track P7 ---
	resetTurnHistoryAtTurnStart(state);
	// --- End Track P7 ---
	// --- Track P12 ---
	resetWave4TurnStateAtTurnStart(state);
	// --- End Track P12 ---
	clearWave9TurnStartState(state, activePlayer.playerId);
	clearWave10YourNextTurnDirectives(state, activePlayer.playerId);

	// 1. Untap step (CR 502): turn-based actions execute before PhaseBegin('untap') triggers (CR 703.3)
	H().beginPhase(state, 'untap', activePlayer);
	// --- Track P11: Pause turn start if human player has an untap-step choice prompt ---
	if (state.pendingPrompts.length > 0 && state.phase === 'untap') {
		return;
	}
	// --- End Track P11 ---
	emptyAllPlayersManaPools(state);

	// 2. Upkeep step (CR 503): active player receives priority in upkeep (CR 503.1a / 500.2)
	H().beginPhase(state, 'upkeep', activePlayer);
	givePriorityToActiveOrNextPlayer(state);
	state.passedPriorityPlayerIds = [];
	state.turnStartedAt = Date.now();
	state.priorityUpdatedAt = Date.now();
	emitVfx(state, {
		kind: 'phase_change',
		label: `Turn ${state.turnNumber}: ${activePlayer.username} — Upkeep`
	});
	H().checkStateBasedActions(state);
}

export function handleMulliganAction(
	state: GameState,
	actor: PlayerGameState,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	const prIdx = state.pendingPrompts.findIndex((p) => p.playerId === actor.playerId);
	if (action.type === 'choice') {
		const pr = state.pendingPrompts.find(
			(p) => p.playerId === actor.playerId && p.id === action.promptId
		);
		if (!pr) {
			return { ok: false, error: 'That choice is no longer pending.' };
		}
		const choice = effectivePromptChoice(pr, state);
		const valid = validateChoiceAnswer(choice, action.answer);
		if (!valid.ok) {
			return { ok: false, error: valid.error };
		}
		if (effectivePromptPurpose(pr) === 'mulligan' && action.answer?.kind === 'yesNo') {
			return handleMulliganAction(state, actor, {
				type: action.answer.yes ? 'mulligan_keep' : 'mulligan_take'
			});
		}
		if (effectivePromptPurpose(pr) === 'london_bottom' && action.answer?.kind === 'chooseObjects') {
			return handleMulliganAction(state, actor, {
				type: 'london_bottom',
				instanceIds: action.answer.objectIds
			});
		}
		// --- Track P22a: CR 903.4 Commander pre-game color choice prompt during pregame ---
		const pregameHandler = pr.continuation?.kind === 'handler' ? pr.continuation.name : undefined;
		if (pregameHandler === 'commander_pregame_color') {
			const cIdx = state.pendingPrompts.indexOf(pr);
			if (cIdx >= 0) {
				return handlePromptResolution(state, actor, cIdx, action);
			}
		}
		// --- End Track P22a ---
		return { ok: false, error: 'Invalid choice for mulligan prompt.' };
	}

	if (action.type === 'mulligan_keep') {
		if (prIdx >= 0) state.pendingPrompts.splice(prIdx, 1);
		const freeMulligans =
			state.rules.mulliganRule === 'friendly_unlimited' || state.rules.mulliganRule === 'free_all'
				? 99
				: state.rules.mulliganRule === 'london_1free'
					? 1
					: 0;
		const cardsToBottom = Math.max(0, actor.mulliganCount - freeMulligans);

		if (cardsToBottom > 0 && actor.hand.length > 0) {
			const countReq = Math.min(cardsToBottom, actor.hand.length);
			const description = `Select ${countReq} card(s) from your hand to place on the bottom of your library.`;
			const candidates = actor.hand.map((c) => c.instanceId);
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: actor.playerId,
				kind: 'london_bottom',
				purpose: 'london_bottom',
				title: `Put ${countReq} Card(s) on Bottom of Library`,
				description,
				countRequired: countReq,
				candidateInstanceIds: candidates,
				choice: {
					kind: 'chooseObjects',
					candidates,
					min: countReq,
					max: countReq,
					zone: 'hand',
					reason: description
				}
			});
			return { ok: true };
		}

		actor.hasKeptHand = true;
		addLog(
			state,
			'rule',
			`${actor.username} kept a ${actor.hand.length}-card opening hand.`,
			actor.playerId
		);
		H().checkIfAllKeptMulligan(state);
		return { ok: true };
	}

	if (action.type === 'mulligan_take') {
		actor.mulliganCount += 1;
		mulliganRedraw(state, actor);
		addLog(
			state,
			'rule',
			`${actor.username} took mulligan #${actor.mulliganCount}.`,
			actor.playerId
		);
		return { ok: true };
	}

	if (action.type === 'london_bottom') {
		const bottomIdx = state.pendingPrompts.findIndex(
			(p) => p.playerId === actor.playerId && p.kind === 'london_bottom'
		);
		const pr = bottomIdx >= 0 ? state.pendingPrompts[bottomIdx] : undefined;
		if (!pr) {
			return { ok: false, error: 'No London Mulligan bottom prompt active.' };
		}
		const required = pr.countRequired ?? 1;
		const ids = Array.isArray(action.instanceIds) ? action.instanceIds : [];
		if (ids.length !== required) {
			return { ok: false, error: `Please select exactly ${required} card(s).` };
		}
		const seen = new Set<string>();
		const allowedCandidates =
			pr.candidateInstanceIds && pr.candidateInstanceIds.length > 0
				? new Set(pr.candidateInstanceIds)
				: pr.choice?.kind === 'chooseObjects'
					? new Set(pr.choice.candidates)
					: null;
		const handIds = new Set(actor.hand.map((c) => c.instanceId));
		for (const id of ids) {
			if (seen.has(id)) {
				return { ok: false, error: 'Duplicate object IDs are not allowed.' };
			}
			seen.add(id);
			if ((allowedCandidates && !allowedCandidates.has(id)) || !handIds.has(id)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: Chosen card is not eligible for London bottom.'
				};
			}
		}
		for (const id of ids) {
			const hIdx = actor.hand.findIndex((c) => c.instanceId === id);
			if (hIdx >= 0) {
				moveObject(state, actor.hand[hIdx], 'library', {
					from: { player: actor, zone: 'hand' },
					toPlayer: actor,
					bumpVersion: false,
					newTimestamp: false
				});
			}
		}
		state.pendingPrompts.splice(bottomIdx, 1);
		actor.hasKeptHand = true;
		addLog(
			state,
			'rule',
			`${actor.username} kept ${actor.hand.length} cards (put ${required} on the bottom).`,
			actor.playerId
		);
		H().checkIfAllKeptMulligan(state);
		return { ok: true };
	}

	return { ok: false, error: 'Please Keep or Mulligan your opening hand first.' };
}

export function handlePromptResolution(
	state: GameState,
	actor: PlayerGameState,
	promptIdx: number,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	if (action.type === 'choice' || action.type === 'cost_choice') {
		const byIdIdx = state.pendingPrompts.findIndex(
			(p) => p.playerId === actor.playerId && p.id === action.promptId
		);
		if (byIdIdx < 0) {
			return {
				ok: false,
				error:
					action.type === 'cost_choice'
						? 'That cost choice is no longer pending.'
						: 'That choice is no longer pending.'
			};
		}
		promptIdx = byIdIdx;
	}

	const prompt = state.pendingPrompts[promptIdx];
	const normalized = normalizePromptAction(prompt, action, state);
	if (!normalized) {
		return { ok: false, error: `Please resolve the active prompt: ${prompt.title}.` };
	}

	const choice = effectivePromptChoice(prompt, state);
	const purpose = effectivePromptPurpose(prompt);

	// Steps C+D: triggered-ability target, order and legacy leading-"you may" prompts.
	// Prompts with a `continuation` (such as IR `effect_choice` optional steps) flow below.
	if (
		!prompt.continuation &&
		(purpose === 'trigger_modes' ||
			purpose === 'trigger_targets' ||
			purpose === 'trigger_order' ||
			purpose === 'trigger_may')
	) {
		return H().resolveTriggerPrompt(state, prompt, promptIdx, normalized.answer);
	}

	// Phase 4/8: a cost choice. The answer is merged into the waiting action's costPayment and the
	// action runs again from scratch (re-checking legality); on failure the prompt is restored.
	if (purpose === 'cost_choice') {
		const pending = prompt.pendingAction;
		if (normalized.cancel) {
			state.pendingPrompts.splice(promptIdx, 1);
			return { ok: true };
		}
		if (
			!pending ||
			(pending.type !== 'cast_spell' &&
				pending.type !== 'activate_ability' &&
				pending.type !== 'tap_mana' &&
				pending.type !== 'turn_face_up' &&
				pending.type !== 'unlock_room_door' &&
				pending.type !== 'hand_special_action')
		) {
			return { ok: false, error: 'Invalid or stale cost choice prompt.' };
		}
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok) {
			return { ok: false, error: valid.error };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const payment: CostPayment = {
			...(pending.costPayment ?? {}),
			options: [...(pending.costPayment?.options ?? [])],
			objects: [...(pending.costPayment?.objects ?? [])],
			...(pending.costPayment?.phyrexianLifeCount !== undefined
				? { phyrexianLifeCount: pending.costPayment.phyrexianLifeCount }
				: {}),
			...(pending.costPayment?.hybridChoices
				? { hybridChoices: [...pending.costPayment.hybridChoices] }
				: {})
		};
		const q = prompt.costQuestion;
		if (q?.kind === 'option' || q?.kind === 'phyrexian' || q?.kind === 'hybrid') {
			const opt =
				normalized.answer?.kind === 'yesNo'
					? normalized.answer.yes
						? 0
						: 1
					: normalized.answer?.kind === 'chooseMode'
						? normalized.answer.indices[0]
						: undefined;
			if (opt === undefined) {
				state.pendingPrompts.splice(promptIdx, 0, prompt);
				return { ok: false, error: 'Choose one of the options.' };
			}
			if (q.kind === 'phyrexian') {
				payment.phyrexianLifeCount = opt;
			} else if (q.kind === 'hybrid') {
				const nextHyb = [...(payment.hybridChoices ?? [])];
				nextHyb[q.index] = opt;
				payment.hybridChoices = nextHyb;
			} else {
				payment.options![q.index] = opt;
			}
		} else if (q?.kind === 'objects' && normalized.answer?.kind === 'chooseObjects') {
			payment.objects![q.index] = normalized.answer.objectIds;
		}
		const result = H().applyGameAction(state, actor.playerId, { ...pending, costPayment: payment });
		if (!result.ok) state.pendingPrompts.splice(promptIdx, 0, prompt);
		return result;
	}

	if (purpose === 'end_turn') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'yesNo') {
			return { ok: false, error: valid.ok ? 'Invalid end-turn choice.' : valid.error };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		resolveEndTurnChoice(state, actor, normalized.answer.yes);
		H().checkStateBasedActions(state);
		resumeAfterPrompt(state, prompt);
		return { ok: true };
	}

	if (purpose === 'legend_rule') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'chooseObjects') {
			return {
				ok: false,
				error: 'Please choose one of the duplicate legendary permanents to keep.'
			};
		}
		const keepInstanceId = normalized.answer.objectIds[0];
		const cands =
			prompt.candidateInstanceIds ??
			(choice.kind === 'chooseObjects' ? choice.candidates : []);
		if (!cands.includes(keepInstanceId)) {
			return {
				ok: false,
				error: 'Please choose one of the duplicate legendary permanents to keep.'
			};
		}
		state.pendingPrompts.splice(promptIdx, 1);
		state.pendingProcedure = {
			kind: 'legend_rule',
			actorId: actor.playerId,
			keepInstanceId,
			remainingInstanceIds: cands.filter((id) => id !== keepInstanceId),
			nextIndex: 0
		};
		advanceLegendRuleProcedure(state);
		return { ok: true };
	}

	if (purpose === 'commander_zone_choice') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'yesNo') {
			return { ok: false, error: valid.ok ? 'Invalid commander zone choice.' : valid.error };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const proc =
			prompt.continuation?.kind === 'procedure' &&
			prompt.continuation.procedure.kind === 'commander_zone_choice'
				? prompt.continuation.procedure
				: undefined;
		const commanderId = proc?.commanderInstanceId ?? prompt.commanderInstanceId;
		const destZone = proc?.destinationZone ?? prompt.destinationZone;
		resolveCommanderZoneChoice(state, actor, normalized.answer.yes, commanderId, destZone);
		H().checkStateBasedActions(state);
		resumeAfterPrompt(state, prompt);
		return { ok: true };
	}

	if (purpose === 'discard_to_hand_size') {
		const req = prompt.countRequired || 1;
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'chooseObjects') {
			return { ok: false, error: `You must discard exactly ${req} card(s).` };
		}
		const chosenIds = normalized.answer.objectIds;
		if (chosenIds.length !== req) {
			return { ok: false, error: `You must discard exactly ${req} card(s).` };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		state.pendingProcedure = {
			kind: 'discard_to_hand_size',
			actorId: actor.playerId,
			chosenIds: [...chosenIds],
			nextIndex: 0,
			discardCount: req
		};
		advanceDiscardToHandSizeProcedure(state);
		return { ok: true };
	}

	if (purpose === 'search_library') {
		if (!normalized.answer || normalized.answer.kind !== 'chooseObjects') {
			return { ok: false, error: 'Library search expects an object choice.' };
		}
		const libraryOwner =
			state.players.find(
				(p) => p.playerId === (prompt.targetLibraryOwnerId || actor.playerId)
			) || actor;
		const pickedIds = normalized.answer.objectIds;
		if (pickedIds.length > 1) {
			return { ok: false, error: 'You may pick at most 1 card per search step.' };
		}
		const pickedId = pickedIds[0] ?? null;

		if (pickedId === null) {
			const availableCount = prompt.candidateInstanceIds
				? prompt.candidateInstanceIds.length
				: libraryOwner.library.length;
			const mustFind =
				prompt.canFailToFind === false ||
				(choice.kind === 'chooseObjects' && choice.min > 0);
			if (mustFind && availableCount > 0) {
				return {
					ok: false,
					error:
						'Strict Rules Violation (CR 701.19b): This search instruction does not state a card quality, so you must find a card if the library is not empty.'
				};
			}
		} else {
			const candidateIds =
				prompt.candidateInstanceIds ??
				(choice.kind === 'chooseObjects' && choice.candidates.length > 0
					? choice.candidates
					: undefined);
			if (candidateIds && !candidateIds.includes(pickedId)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: That card does not match the required search criteria.'
				};
			}
			if (!libraryOwner.library.some((c) => c.instanceId === pickedId)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: Card not found in the searched library.'
				};
			}
		}

		state.pendingPrompts.splice(promptIdx, 1);
		let alreadyShuffledWithTopCard = false;

		if (pickedId) {
			const idx = libraryOwner.library.findIndex((c) => c.instanceId === pickedId);
			if (idx >= 0) {
				const found = libraryOwner.library[idx];
				const fromLibrary = { player: libraryOwner, zone: 'library' as const };
				if (prompt.interceptedBy?.exilesFoundCards) {
					if (prompt.interceptedBy.grantPlayFromExile) {
						found.playableFromExileBy = {
							playerId: prompt.interceptedBy.controllerId,
							spendManaAsAnyColor: prompt.interceptedBy.spendManaAsAnyColor,
							sourceName: prompt.interceptedBy.sourceName
						};
					}
					moveObject(state, found, 'exile', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						newTimestamp: true,
						bumpVersion: true
					});
					emitVfx(state, {
						kind: 'exile',
						sourceId: actor.playerId,
						targetId: found.instanceId,
						label: `${prompt.interceptedBy.sourceName}: Exiled ${found.card.name}`
					});
					addLog(
						state,
						'rule',
						`${actor.username} (controlling ${libraryOwner.username} during their library search via ${prompt.interceptedBy.sourceName}) exiled ${found.card.name} from ${libraryOwner.username}'s library! ${actor.username} may play it from exile${prompt.interceptedBy.spendManaAsAnyColor ? ' spending mana as though it were mana of any color' : ''}.`,
						actor.playerId
					);
				} else if (prompt.destinationZone === 'battlefield') {
					const isAura = resolveObjectFaces(
						effectiveCardForObject(found),
						instanceFaceOptions(found, 'battlefield')
					).subtypes.includes('Aura');
					if (isAura) {
						const attachCands = H().legalAuraAttachCandidates(state, found, libraryOwner);
						if (attachCands.length === 0) {
							addLog(
								state,
								'rule',
								`${found.card.name} remained in ${libraryOwner.username}'s library because there is no legal object or player for it to enchant (CR 303.4g).`,
								libraryOwner.playerId
							);
						} else if (!libraryOwner.isBot) {
							shuffleLibrary(state, libraryOwner);
							enqueueChoicePrompt(state, {
								id: uid('prm', state),
								playerId: libraryOwner.playerId,
								kind: 'chooseObjects',
								purpose: 'generic',
								title: 'Search Library — Choose what Aura will enchant',
								description: `Choose a legal object or player for ${found.card.name} to enchant as it enters the battlefield (CR 303.4f).`,
								continuation: {
									kind: 'procedure',
									procedure: {
										kind: 'aura_library_attach_choice',
										auraId: found.instanceId,
										libraryOwnerId: libraryOwner.playerId,
										enterTapped: Boolean(prompt.enterTapped),
										...(prompt.continuation?.kind === 'effect_resume'
											? {
													resumeStackItemId: prompt.continuation.stackItemId,
													resumeStepIndex: prompt.continuation.stepIndex
												}
											: {})
									}
								},
								choice: {
									kind: 'chooseObjects',
									min: 1,
									max: 1,
									candidates: attachCands,
									defaultObjectIds: [attachCands[0]],
									zone: 'battlefield',
									reason: `Choose a legal object or player for ${found.card.name} to enchant as it enters the battlefield (CR 303.4f).`
								}
							});
							return { ok: true };
						} else {
							attachObject(state, found, attachCands[0]);
						}
					}
					if (!isAura || found.attachedToId) {
						found.tapped = Boolean(prompt.enterTapped);
						found.summoningSick = true;
						found.defaultControllerId = libraryOwner.playerId;
						applySelfEtbReplacements(state, found);
						moveObject(state, found, 'battlefield', {
							from: fromLibrary,
							toPlayer: libraryOwner,
							controllerId: libraryOwner.playerId,
							bumpVersion: true
						});
						if (isAura && found.attachedToId) {
							const attachedTarget = findPermanentOnBoard(state, found.attachedToId);
							if (attachedTarget) {
								emitEvent(state, {
									kind: 'Attached',
									attachmentId: found.instanceId,
									attachment: found,
									hostId: attachedTarget.inst.instanceId,
									host: attachedTarget.inst
								});
							}
						}
						addLog(
							state,
							'rule',
							`${libraryOwner.username} searched their library and put ${found.card.name} onto the battlefield${found.tapped ? ' tapped' : ''}.`,
							libraryOwner.playerId
						);
						flushTriggers(state);
					}
				} else if (prompt.destinationZone === 'library' && prompt.putOnTop) {
					// Put it on top, then shuffle the rest: the same as the old "remove, shuffle, put on top".
					moveObject(state, found, 'library', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						insert: 'start',
						commanderRedirect: true,
						newTimestamp: true,
						bumpVersion: true
					});
					shuffleLibrary(state, libraryOwner, 1);
					alreadyShuffledWithTopCard = true;
					addLog(
						state,
						'rule',
						`${libraryOwner.username} searched their library, shuffled, and put a card on top.`,
						libraryOwner.playerId
					);
				} else {
					moveObject(state, found, 'hand', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						commanderRedirect: true
					});
					addLog(
						state,
						'rule',
						prompt.searchSpec?.reveal
							? `${libraryOwner.username} searched their library, revealed ${found.card.name}, put it into hand, and shuffled.`
							: `${libraryOwner.username} searched their library for a card, put it into hand, and shuffled.`,
						libraryOwner.playerId
					);
				}

				// Check if there are additional cards to find in a multi-card search (e.g. Cultivate, Kodama's Reach, Skyshroud Claim, Myriad Landscape)
				const nextDestinations: LibrarySearchDestination[] = prompt.remainingDestinations
					? [...prompt.remainingDestinations]
					: prompt.secondLandToBattlefield
						? [{ zone: 'battlefield', tapped: true }]
						: prompt.secondLandToHand
							? [{ zone: 'hand' }]
							: [];

				if (nextDestinations.length > 0) {
					const nextDest = nextDestinations.shift()!;
					const remainingCandidates = libraryOwner.library
						.filter((c) => {
							if (prompt.searchSpec) {
								return matchesLibrarySearchSpec(
									c.card,
									prompt.searchSpec,
									resolveObjectFaces(c.card, instanceFaceOptions(c)).colors
								);
							}
							const libView = resolveObjectFaces(
								effectiveCardForObject(c),
								instanceFaceOptions(c, 'library')
							);
							return libView.supertypes.includes('Basic') && libView.types.includes('Land');
						})
						.map((c) => c.instanceId);

					if (remainingCandidates.length > 0) {
						const nextDesc = prompt.interceptedBy
							? `Choose the next matching card from ${libraryOwner.username}'s library to exile via ${prompt.interceptedBy.sourceName}, or Fail to Find.`
							: `Choose the next matching card from your library to put ${describeLibrarySearchDestination(nextDest)}, then shuffle.`;
						const canFailNext = prompt.canFailToFind ?? true;
						state.pendingPrompts.push({
							id: uid('prm', state),
							playerId: actor.playerId,
							targetLibraryOwnerId: libraryOwner.playerId,
							kind: 'search_library',
							purpose: 'search_library',
							title: prompt.interceptedBy
								? `${prompt.interceptedBy.sourceName} — Choose Next Card from ${libraryOwner.username}'s Library`
								: `Search Library — Next Card (${describeLibrarySearchDestination(nextDest)})`,
							description: nextDesc,
							destinationZone: nextDest.zone,
							enterTapped: Boolean(nextDest.tapped),
							putOnTop: Boolean(nextDest.onTop),
							searchSpec: prompt.searchSpec,
							remainingDestinations: nextDestinations,
							canFailToFind: canFailNext,
							interceptedBy: prompt.interceptedBy,
							candidateInstanceIds: remainingCandidates,
							choice: {
								kind: 'chooseObjects',
								candidates: remainingCandidates,
								min: canFailNext ? 0 : 1,
								max: 1,
								zone: 'library',
								reason: nextDesc
							},
							stackItem: prompt.stackItem,
							continuation: prompt.continuation
						});
						return { ok: true };
					}
				}
			}
		} else {
			addLog(
				state,
				'rule',
				prompt.interceptedBy
					? `${actor.username} (controlling ${libraryOwner.username} via ${prompt.interceptedBy.sourceName}) chose not to find a card in ${libraryOwner.username}'s library and shuffled.`
					: `${libraryOwner.username} searched their library (chose not to find a card) and shuffled.`,
				actor.playerId
			);
		}

		if (!alreadyShuffledWithTopCard) {
			shuffleLibrary(state, libraryOwner);
		}
		H().checkStateBasedActions(state);
		resumeAfterPrompt(state, prompt);
		return { ok: true };
	}

	if (prompt.continuation?.kind !== 'effect_choice' && (purpose === 'scry_choice' || choice.kind === 'orderObjects')) {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'orderObjects') {
			return { ok: false, error: valid.ok ? 'Invalid orderObjects answer.' : valid.error };
		}
		const candidateIds =
			prompt.candidateInstanceIds ??
			(choice.kind === 'orderObjects' ? choice.objectIds : []);
		const extracted: CardInstance[] = [];
		for (const cid of candidateIds) {
			const c = actor.library.find((l) => l.instanceId === cid);
			if (c && !extracted.includes(c)) extracted.push(c);
		}
		const byId = new Map(extracted.map((c) => [c.instanceId, c]));
		const usedIds = new Set<string>();
		const topList: CardInstance[] = [];
		const bottomList: CardInstance[] = [];
		const allowBottom =
			choice.kind === 'orderObjects'
				? choice.allowSplitBottom !== false
				: prompt.allowBottom !== false;
		const allowShuffle =
			choice.kind === 'orderObjects'
				? Boolean(choice.allowShuffle)
				: Boolean(prompt.allowShuffle);

		for (const tid of normalized.answer.topIds || []) {
			const card = byId.get(tid);
			if (card && !usedIds.has(tid)) {
				topList.push(card);
				usedIds.add(tid);
			}
		}
		if (allowBottom) {
			for (const bid of normalized.answer.bottomIds || []) {
				const card = byId.get(bid);
				if (card && !usedIds.has(bid)) {
					bottomList.push(card);
					usedIds.add(bid);
				}
			}
		}
		// Any remaining extracted cards not explicitly placed go on top in their original relative order
		for (const c of extracted) {
			if (!usedIds.has(c.instanceId)) {
				topList.push(c);
				usedIds.add(c.instanceId);
			}
		}

		const isGraveyardSplit =
			prompt.splitMode === 'graveyard' ||
			(choice.kind === 'orderObjects' && choice.splitLabel === 'graveyard');

		if (isGraveyardSplit) {
			rearrangeLibrary(actor, topList, topList, []);
			const c = prompt.continuation;
			const resumeStackItemId =
				c?.kind === 'effect_resume'
					? c.stackItemId
					: c?.kind === 'procedure' && 'resumeStackItemId' in c.procedure
						? c.procedure.resumeStackItemId
						: undefined;
			const resumeStepIndex =
				c?.kind === 'effect_resume'
					? c.stepIndex
					: c?.kind === 'procedure' && 'resumeStepIndex' in c.procedure
						? c.procedure.resumeStepIndex
						: undefined;
			state.pendingPrompts.splice(promptIdx, 1);
			state.pendingProcedure = {
				kind: 'surveil_graveyard',
				actorId: actor.playerId,
				remainingIds: bottomList.map((card) => card.instanceId),
				nextIndex: 0,
				surveilCount: extracted.length,
				topCount: topList.length,
				graveyardCount: bottomList.length,
				...(resumeStackItemId ? { resumeStackItemId } : {}),
				...(resumeStepIndex !== undefined ? { resumeStepIndex } : {})
			};
			advanceSurveilGraveyardProcedure(state);
			resumeAfterPrompt(state, prompt);
			return { ok: true };
		}

		rearrangeLibrary(actor, extracted, topList, bottomList);

		if (allowShuffle && normalized.answer.shuffle) {
			shuffleLibrary(state, actor);
			addLog(
				state,
				'rule',
				`${actor.username} looked at the top ${extracted.length} card(s) and chose to shuffle their library.`,
				actor.playerId
			);
		} else if (!allowBottom) {
			addLog(
				state,
				'rule',
				`${actor.username} rearranged the top ${extracted.length} card(s) of their library.`,
				actor.playerId
			);
		} else {
			addLog(
				state,
				'rule',
				`${actor.username} scried ${extracted.length} (${topList.length} on top, ${bottomList.length} on bottom).`,
				actor.playerId
			);
			// --- Track P10 ---
			if (extracted.length > 0) {
				emitEvent(state, {
					kind: 'Scried',
					playerId: actor.playerId,
					amount: extracted.length
				});
				flushTriggers(state);
			}
			// --- End Track P10 ---
		}

		state.pendingPrompts.splice(promptIdx, 1);
		resumeAfterPrompt(state, prompt);
		return { ok: true };
	}

	if (purpose === 'guided_resolution') {
		if (normalized.cancel && prompt.cancellable) {
			state.pendingPrompts.splice(promptIdx, 1);
			return { ok: true };
		}
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'yesNo' || !normalized.answer.yes) {
			return { ok: false, error: valid.ok ? 'Invalid guided resolution answer.' : valid.error };
		}
		const ops = normalized.operations ?? [];
		const opsValid = validateGuidedOperations(state, actor, ops);
		if (!opsValid.ok) return opsValid;
		const c = prompt.continuation;
		const manualItem =
			c?.kind === 'manual_resolution'
				? state.stack.find((s) => s.id === c.stackItemId)
				: undefined;
		if (c?.kind === 'manual_resolution' && !manualItem) {
			return { ok: false, error: 'That spell or ability is no longer on the stack.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		applyGuidedOperations(state, actor, ops);
		if (c?.kind === 'manual_resolution' && manualItem) {
			addLog(state, 'cast', `${actor.username} resolved ${manualItem.title} manually${ops.length > 0 ? ` (${ops.length} operation${ops.length === 1 ? '' : 's'})` : ''}.`, actor.playerId);
			manualItem.manualResolution = 'done';
			H().resumeStackItem(state, manualItem);
			return { ok: true };
		}
		if (c?.kind === 'manual_ability') {
			addLog(state, 'cast', `${actor.username} applied an ability of ${prompt.title.replace(/^Resolve Manually: /, '')} manually${ops.length > 0 ? ` (${ops.length} operation${ops.length === 1 ? '' : 's'})` : ''}.`, actor.playerId);
		} else {
			addLog(state, 'cast', `${actor.username} completed guided resolution for ${prompt.title}.`, actor.playerId);
		}
		H().checkStateBasedActions(state);
		return { ok: true };
	}

	// Step E2 / Track B1: a paused IR resolution waiting for this player's choice (any ChoiceAnswer).
	if (prompt.continuation?.kind === 'effect_choice') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || !normalized.answer) {
			return { ok: false, error: valid.ok ? 'Missing choice answer.' : valid.error };
		}
		const c = prompt.continuation;
		const item = state.stack.find((s) => s.id === c.stackItemId);
		if (!item?.effectResume || item.effectResume.stepIndex !== c.stepIndex) {
			return { ok: false, error: 'That effect choice is no longer pending.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const answerKey = c.answerKey ?? actor.playerId;
		item.effectResume.answers[answerKey] = normalized.answer;
		H().resumeStackItem(state, item);
		return { ok: true };
	}

	// Standalone generic / procedure choice prompt (yesNo, chooseObjects, chooseMode, chooseNumber, chooseReplacement)
	if (normalized.cancel && prompt.cancellable) {
		state.pendingPrompts.splice(promptIdx, 1);
		return { ok: true };
	}
	const valid = validateChoiceAnswer(choice, normalized.answer);
	if (!valid.ok || !normalized.answer) {
		return { ok: false, error: valid.ok ? 'Missing choice answer.' : valid.error };
	}
	if (prompt.continuation?.kind === 'procedure') {
		const procCheck = validateProcedurePrompt(state, prompt.continuation.procedure);
		if (!procCheck.ok) {
			return procCheck;
		}
	}
	state.pendingPrompts.splice(promptIdx, 1);
	if (prompt.continuation?.kind === 'procedure') {
		executeProcedureContinuation(
			state,
			actor,
			prompt,
			prompt.continuation.procedure,
			normalized.answer
		);
	} else if (!runPromptHandler(state, prompt, normalized.answer)) {
		// A generic prompt continues only through a named handler or procedure (plain data).
		// Without one, answering just records the answer in the log.
		addLog(state, 'rule', `${actor.username} answered "${prompt.title}".`, actor.playerId);
	}
	H().checkStateBasedActions(state);
	resumeAfterPrompt(state, prompt);
	return { ok: true };
}

function linkNewlyQueuedReplacements(
	state: GameState,
	promptsBefore: number,
	resumeStackItemId?: string,
	resumeStepIndex?: number
): void {
	if (!resumeStackItemId || resumeStepIndex === undefined) return;
	for (const pr of state.pendingPrompts.slice(promptsBefore)) {
		if (pr.continuation?.kind === 'handler') {
			const data = (pr.continuation.data ??= {});
			data.resumeStackItemId = resumeStackItemId;
			data.resumeStepIndex = resumeStepIndex;
		}
	}
}

function resolveEndTurnChoice(state: GameState, actor: PlayerGameState, yes: boolean): void {
	if (yes) {
		endTheTurnImmediately(state, actor.playerId);
	} else {
		addLog(state, 'rule', `${actor.username} chose not to end the turn.`, actor.playerId);
	}
}

function resolveCommanderZoneChoice(
	state: GameState,
	actor: PlayerGameState,
	yes: boolean,
	commanderInstanceId: string | undefined,
	destinationZone: ZoneType | undefined
): void {
	if (yes) {
		const gIdx = actor.graveyard.findIndex((c) => c.instanceId === commanderInstanceId);
		const eIdx = actor.exile.findIndex((c) => c.instanceId === commanderInstanceId);
		const hIdx = actor.hand.findIndex((c) => c.instanceId === commanderInstanceId);
		const lIdx = actor.library.findIndex((c) => c.instanceId === commanderInstanceId);
		let cmd: CardInstance | undefined;
		let cmdFrom: 'graveyard' | 'exile' | 'hand' | 'library' = 'graveyard';
		if (gIdx >= 0) cmd = actor.graveyard[gIdx];
		else if (eIdx >= 0) {
			cmd = actor.exile[eIdx];
			cmdFrom = 'exile';
		} else if (hIdx >= 0) {
			cmd = actor.hand[hIdx];
			cmdFrom = 'hand';
		} else if (lIdx >= 0) {
			cmd = actor.library[lIdx];
			cmdFrom = 'library';
		}

		if (cmd) {
			cmd.damageMarked = 0;
			cmd.deathtouchDamageMarked = false;
			cmd.tapped = false;
			moveObject(state, cmd, 'command', { from: { player: actor, zone: cmdFrom }, toPlayer: actor });
			const crRule = cmdFrom === 'hand' || cmdFrom === 'library' ? 'CR 903.9b' : 'CR 903.9a';
			addLog(
				state,
				'rule',
				`${actor.username} returned Commander ${cmd.card.name} to the Command Zone (${crRule}).`,
				actor.playerId
			);
		}
		return;
	}
	const cmd =
		actor.graveyard.find((c) => c.instanceId === commanderInstanceId) ??
		actor.exile.find((c) => c.instanceId === commanderInstanceId);
	if (cmd) {
		cmd.commanderSbaDeclinedVersion = cmd.objectVersion ?? 1;
	}
	addLog(
		state,
		'rule',
		`${actor.username} chose to leave Commander in ${destinationZone}.`,
		actor.playerId
	);
}

function advanceLegendRuleProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc || proc.kind !== 'legend_rule') return;
	const actor = state.players.find((p) => p.playerId === proc.actorId);
	while (proc.nextIndex < proc.remainingInstanceIds.length) {
		const cid = proc.remainingInstanceIds[proc.nextIndex];
		proc.nextIndex += 1;
		const found = findPermanentOnBoard(state, cid);
		if (!found) continue;
		const moveRes = movePermanentToZone(state, found.inst, 'graveyard');
		if (moveRes === 'pending' || hasBlockingReplacementOrCommanderPrompt(state)) {
			return;
		}
	}
	state.pendingProcedure = undefined;
	if (actor) {
		addLog(
			state,
			'sba',
			`${actor.username} resolved the Legend Rule (CR 704.5j).`,
			actor.playerId
		);
	}
	H().checkStateBasedActions(state);
	flushTriggers(state);
}

function advanceDiscardToHandSizeProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc || proc.kind !== 'discard_to_hand_size') return;
	const actor = state.players.find((p) => p.playerId === proc.actorId);
	if (!actor) {
		state.pendingProcedure = undefined;
		return;
	}
	while (proc.nextIndex < proc.chosenIds.length) {
		const id = proc.chosenIds[proc.nextIndex];
		proc.nextIndex += 1;
		const idx = actor.hand.findIndex((c) => c.instanceId === id);
		if (idx < 0) continue;
		const moveRes = moveObject(state, actor.hand[idx], 'graveyard', {
			from: { player: actor, zone: 'hand' },
			toPlayer: actor,
			graveyardReplacement: true,
			commanderRedirect: true,
			// --- Track P9 ---
			discardReason: 'discard',
			discardPlayerId: actor.playerId
			// --- End Track P9 ---
		});
		if (moveRes === 'pending' || hasBlockingReplacementOrCommanderPrompt(state)) {
			return;
		}
	}
	state.pendingProcedure = undefined;
	addLog(
		state,
		'rule',
		`${actor.username} discarded ${proc.discardCount} card(s) down to maximum hand size.`,
		actor.playerId
	);
	completeTurnCleanupAndPassTurn(state);
}

export function finishCombatDamagePhase(state: GameState): void {
	if (state.status === 'finished') return;
	const active = state.players[state.activePlayerIndex];
	emitEvent(state, {
		kind: 'PhaseBegin',
		phase: state.phase,
		activePlayerId: active?.playerId ?? null
	});
	flushTriggers(state);
	givePriorityToActiveOrNextPlayer(state);
	state.passedPriorityPlayerIds = [];
	H().checkStateBasedActions(state);
}

function validateProcedurePrompt(
	state: GameState,
	proc: ProcedureContinuation
): { ok: true } | { ok: false; error: string } {
	if (proc.kind === 'clone_copy_choice') {
		if (!state.stack.some((s) => s.id === proc.stackItemId)) {
			return { ok: false, error: 'That copy choice is no longer pending on the stack.' };
		}
	} else if (proc.kind === 'ward_payment_choice') {
		if (!state.stack.some((s) => s.id === proc.wardStackItemId)) {
			return { ok: false, error: 'That Ward payment choice is no longer pending on the stack.' };
		}
	}
	return { ok: true };
}

function executeProcedureContinuation(
	state: GameState,
	actor: PlayerGameState,
	prompt: PendingPrompt,
	proc: ProcedureContinuation,
	answer: ChoiceAnswer
): void {
	switch (proc.kind) {
		case 'ward_payment_choice': {
			const wardItem = state.stack.find((s) => s.id === proc.wardStackItemId);
			const targetItem = state.stack.find((s) => s.id === proc.targetStackItemId);
			const accepted = answer.kind === 'yesNo' ? answer.yes : false;
			if (wardItem) wardItem.optionalAccepted = accepted;
			if (targetItem && !accepted) targetItem.declineWard = true;
			return;
		}
		case 'clone_copy_choice': {
			if (answer.kind !== 'chooseObjects') return;
			const item = state.stack.find((s) => s.id === proc.stackItemId);
			if (!item) return;
			item.cloneCopyChoice = answer.objectIds[0] ?? null;
			return;
		}
		case 'aura_library_attach_choice': {
			if (answer.kind !== 'chooseObjects') return;
			const libraryOwner = state.players.find((p) => p.playerId === proc.libraryOwnerId);
			const found = libraryOwner?.library.find((c) => c.instanceId === proc.auraId);
			const chosenHostId = answer.objectIds[0] ?? null;
			if (!libraryOwner || !found || !chosenHostId) return;
			attachObject(state, found, chosenHostId);
			found.tapped = proc.enterTapped;
			found.summoningSick = true;
			found.defaultControllerId = libraryOwner.playerId;
			applySelfEtbReplacements(state, found);
			const promptsBefore = state.pendingPrompts.length;
			const moveRes = moveObject(state, found, 'battlefield', {
				from: { player: libraryOwner, zone: 'library' },
				toPlayer: libraryOwner,
				controllerId: libraryOwner.playerId,
				bumpVersion: true
			});
			if (moveRes === 'pending') {
				linkNewlyQueuedReplacements(state, promptsBefore, proc.resumeStackItemId, proc.resumeStepIndex);
				return;
			}
			const attachedTarget = findPermanentOnBoard(state, chosenHostId);
			if (attachedTarget) {
				emitEvent(state, {
					kind: 'Attached',
					attachmentId: found.instanceId,
					attachment: found,
					hostId: attachedTarget.inst.instanceId,
					host: attachedTarget.inst
				});
			}
			addLog(
				state,
				'rule',
				`${libraryOwner.username} searched their library and put ${found.card.name} onto the battlefield${found.tapped ? ' tapped' : ''}.`,
				libraryOwner.playerId
			);
			flushTriggers(state);
			return;
		}
		case 'commander_zone_choice': {
			const yes = answer.kind === 'yesNo' ? answer.yes : false;
			resolveCommanderZoneChoice(state, actor, yes, proc.commanderInstanceId, proc.destinationZone);
			return;
		}
		case 'end_turn': {
			const yes = answer.kind === 'yesNo' ? answer.yes : false;
			resolveEndTurnChoice(state, actor, yes);
			return;
		}
		default: {
			runPromptHandler(state, prompt, answer);
		}
	}
}

export function advanceSurveilGraveyardProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc || proc.kind !== 'surveil_graveyard') return;
	const actor = state.players.find((p) => p.playerId === proc.actorId);
	if (!actor) {
		state.pendingProcedure = undefined;
		return;
	}
	while (proc.nextIndex < proc.remainingIds.length) {
		const id = proc.remainingIds[proc.nextIndex];
		proc.nextIndex += 1;
		const idx = actor.library.findIndex((c) => c.instanceId === id);
		if (idx < 0) continue;
		const moveRes = moveObject(state, actor.library[idx], 'graveyard', {
			from: { player: actor, zone: 'library' },
			toPlayer: actor,
			graveyardReplacement: true,
			bumpVersion: true,
			newTimestamp: true,
			...(proc.resumeStackItemId ? { resumeStackItemId: proc.resumeStackItemId } : {}),
			...(proc.resumeStepIndex !== undefined ? { resumeStepIndex: proc.resumeStepIndex } : {})
		});
		if (moveRes === 'pending' || hasBlockingReplacementOrCommanderPrompt(state)) {
			return;
		}
	}
	state.pendingProcedure = undefined;
	addLog(
		state,
		'rule',
		`${actor.username} surveilled ${proc.surveilCount} (${proc.topCount} on top, ${proc.graveyardCount} into graveyard).`,
		actor.playerId
	);
	emitEvent(state, {
		kind: 'Surveilled',
		playerId: actor.playerId,
		count: proc.surveilCount,
		graveyardCount: proc.graveyardCount
	});
	flushTriggers(state);
}

function resumePendingProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc) return;
	if (proc.kind === 'legend_rule') {
		advanceLegendRuleProcedure(state);
		return;
	}
	if (proc.kind === 'discard_to_hand_size') {
		advanceDiscardToHandSizeProcedure(state);
		return;
	}
	if (proc.kind === 'surveil_graveyard') {
		const stackItemId = proc.resumeStackItemId;
		const stepIndex = proc.resumeStepIndex;
		advanceSurveilGraveyardProcedure(state);
		if (!state.pendingProcedure && stackItemId && stepIndex !== undefined) {
			const item = state.stack.find((s) => s.id === stackItemId);
			if (item?.effectResume?.stepIndex === stepIndex && !H().stackItemAwaitsPrompt(state, item)) {
				H().resumeStackItem(state, item);
			}
		}
		return;
	}
	if (proc.kind === 'combat_damage_step') {
		state.pendingProcedure = undefined;
		H().checkStateBasedActions(state);
		finishCombatDamagePhase(state);
	}
}

/**
 * Step E2 / Track B1: resumes any enclosing cost payment, rules procedure, or paused stack item
 * once blocking replacement/commander prompts finish.
 */
function resumeAfterPrompt(state: GameState, prompt: PendingPrompt): void {
	if (hasBlockingReplacementOrCommanderPrompt(state)) {
		return;
	}
	if (state.pendingCostPayment) {
		H().resumePendingCostPayment(state);
		return;
	}
	if (state.pendingProcedure) {
		resumePendingProcedure(state);
		return;
	}
	const c = prompt.continuation;
	if (c?.kind === 'effect_resume') {
		const item = state.stack.find((s) => s.id === c.stackItemId);
		if (!item?.effectResume || item.effectResume.stepIndex !== c.stepIndex) return;
		if (H().stackItemAwaitsPrompt(state, item)) return;
		H().resumeStackItem(state, item);
		return;
	}
	if (c?.kind === 'procedure') {
		const proc = c.procedure;
		if (proc.kind === 'clone_copy_choice') {
			const item = state.stack.find((s) => s.id === proc.stackItemId);
			if (!item || H().stackItemAwaitsPrompt(state, item)) return;
			H().resumeStackItem(state, item);
			return;
		}
		if (proc.kind === 'ward_payment_choice') {
			const item = state.stack.find((s) => s.id === proc.wardStackItemId);
			if (!item || H().stackItemAwaitsPrompt(state, item)) return;
			H().resumeStackItem(state, item);
			return;
		}
		const resumeStackItemId =
			'resumeStackItemId' in proc ? proc.resumeStackItemId : undefined;
		const resumeStepIndex =
			'resumeStepIndex' in proc ? proc.resumeStepIndex : undefined;
		if (resumeStackItemId && resumeStepIndex !== undefined) {
			const item = state.stack.find((s) => s.id === resumeStackItemId);
			if (!item?.effectResume || item.effectResume.stepIndex !== resumeStepIndex) return;
			if (H().stackItemAwaitsPrompt(state, item)) return;
			H().resumeStackItem(state, item);
			return;
		}
	}
	if (c?.kind === 'handler') {
		const resumeStackItemId =
			typeof c.data?.resumeStackItemId === 'string' ? c.data.resumeStackItemId : null;
		const resumeStepIndex =
			typeof c.data?.resumeStepIndex === 'number' ? c.data.resumeStepIndex : null;
		if (resumeStackItemId && resumeStepIndex !== null) {
			const item = state.stack.find((s) => s.id === resumeStackItemId);
			if (!item?.effectResume || item.effectResume.stepIndex !== resumeStepIndex) return;
			if (H().stackItemAwaitsPrompt(state, item)) return;
			H().resumeStackItem(state, item);
			return;
		}
	}
	const activeItem = state.stack.find((s) => Boolean(s.resolutionStarted) && Boolean(s.effectResume));
	if (activeItem && !H().stackItemAwaitsPrompt(state, activeItem)) {
		H().resumeStackItem(state, activeItem);
	}
}

/** Server-side check of a guided resolution's operations (the client is not trusted). */
function validateGuidedOperations(state: GameState, actor: PlayerGameState, ops: GuidedOperation[]): { ok: true } | { ok: false; error: string } {
	if (!Array.isArray(ops)) return { ok: false, error: 'Operations must be a list.' };
	if (ops.length > 50) return { ok: false, error: 'Too many operations.' };
	for (const op of ops) {
		const amount = op.amount ?? 0;
		if (!Number.isInteger(amount) || Math.abs(amount) > GUIDED_MAX_AMOUNT) {
			return { ok: false, error: `Amounts must be whole numbers up to ${GUIDED_MAX_AMOUNT}.` };
		}
		const player = op.targetId ? state.players.find((p) => p.playerId === op.targetId) : undefined;
		const card = op.targetId ? findCardAnywhere(state, op.targetId) : null;
		// Only cards the player can see: public zones and their own hand (never a library or another
		// player's hand).
		if (card && (card.zone === 'library' || (card.zone === 'hand' && card.holder.playerId !== actor.playerId))) {
			return { ok: false, error: 'You can only act on cards you can see.' };
		}
		switch (op.op) {
			case 'draw_cards':
			case 'mill':
				if (amount < 0) return { ok: false, error: 'Card counts cannot be negative.' };
				if (op.targetId && !player) return { ok: false, error: 'Choose a player.' };
				break;
			case 'modify_life':
				if (!player) return { ok: false, error: 'Choose a player whose life changes.' };
				break;
			case 'deal_damage':
				if (amount < 0) return { ok: false, error: 'Damage cannot be negative.' };
				if (!player && card?.zone !== 'battlefield') return { ok: false, error: 'Choose a player or permanent to damage.' };
				break;
			case 'move_zone':
				if (!card) return { ok: false, error: 'Choose a card to move.' };
				if (!op.destinationZone || !GUIDED_ZONES.has(op.destinationZone)) return { ok: false, error: 'Choose a destination zone.' };
				break;
			case 'add_counter':
				if (card?.zone !== 'battlefield') return { ok: false, error: 'Choose a permanent for the counters.' };
				if (!op.counterType || !(op.counterType in card.inst.counters)) return { ok: false, error: 'Choose a counter type.' };
				break;
			case 'tap':
			case 'untap':
				if (card?.zone !== 'battlefield') return { ok: false, error: 'Choose a permanent to tap or untap.' };
				break;
			case 'create_token':
				if (amount < 0 || amount > 20) return { ok: false, error: 'Create between 1 and 20 tokens.' };
				if ((op.tokenPower ?? 0) < 0 || (op.tokenToughness ?? 0) < 0) return { ok: false, error: 'Token power and toughness cannot be negative.' };
				break;
			default:
				return { ok: false, error: 'Unknown operation.' };
		}
	}
	return { ok: true };
}

/**
 * Applies a guided resolution's operations, each through the normal engine primitive (zone moves
 * through moveObject, damage through the damage pipeline, ...), in order. Validated beforehand.
 */
function applyGuidedOperations(state: GameState, actor: PlayerGameState, ops: GuidedOperation[]): void {
	for (const op of ops) {
		const amount = op.amount ?? 0;
		const player = op.targetId ? state.players.find((p) => p.playerId === op.targetId) : undefined;
		const found = op.targetId ? findCardAnywhere(state, op.targetId) : null;
		switch (op.op) {
			case 'draw_cards':
				if (amount > 0) drawCards(state, player ?? actor, amount);
				break;
			case 'mill': {
				const who = player ?? actor;
				const n = Math.min(amount, who.library.length);
				for (let i = 0; i < n; i++) {
					moveObject(state, who.library[0], 'graveyard', {
						from: { player: who, zone: 'library' },
						toPlayer: who,
						graveyardReplacement: true,
						bumpVersion: true,
						newTimestamp: true
					});
				}
				if (n > 0) addLog(state, 'rule', `${who.username} milled ${n} card(s) (manual).`, actor.playerId);
				break;
			}
			case 'modify_life':
				if (player && amount !== 0) {
					if (amount > 0) {
						if (gainPlayerLife(state, player, amount)) {
							addLog(state, 'life', `${player.username} gained ${amount} life (manual).`, actor.playerId);
						}
					} else if (!playerLifeTotalCantChange(state, player)) {
						player.life += amount;
						addLog(state, 'life', `${player.username} lost ${Math.abs(amount)} life (manual).`, actor.playerId);
					}
				}
				break;
			case 'deal_damage':
				if (amount > 0) {
					H().applyDamageToTarget(
						state,
						actor.playerId,
						player
							? { kind: 'player', id: player.playerId, label: player.username }
							: { kind: 'permanent', id: op.targetId!, label: found?.inst.card.name ?? 'target' },
						amount
					);
				}
				break;
			case 'move_zone': {
				if (!found || !op.destinationZone || found.zone === op.destinationZone) break;
				const dest = op.destinationZone;
				if (found.zone === 'battlefield') {
					movePermanentToZone(state, found.inst, dest);
				} else {
					const owner = state.players.find((p) => p.playerId === found.inst.ownerId) ?? found.holder;
					const toPlayer = dest === 'battlefield' ? actor : owner;
					if (dest === 'battlefield') found.inst.summoningSick = true;
					moveObject(state, found.inst, dest, {
						from: { player: found.holder, zone: found.zone as Exclude<ZoneType, 'stack'> },
						toPlayer,
						...(dest === 'battlefield' ? { controllerId: actor.playerId } : {}),
						bumpVersion: true,
						newTimestamp: true
					});
				}
				const isHiddenToHidden =
					(found.zone === 'hand' || found.zone === 'library') &&
					(dest === 'hand' || dest === 'library');
				addLog(
					state,
					'rule',
					`${isHiddenToHidden ? 'A card' : found.inst.card.name} was moved from ${found.zone} to ${dest} (manual).`,
					actor.playerId
				);
				if (dest === 'battlefield') flushTriggers(state);
				break;
			}
			case 'add_counter':
				if (found && op.counterType) {
					if (amount > 0) H().addCountersToPermanent(state, found.inst, op.counterType, amount);
					else if (amount < 0) found.inst.counters[op.counterType] = Math.max(0, (found.inst.counters[op.counterType] ?? 0) + amount);
					addLog(state, 'rule', `${found.inst.card.name}: ${amount > 0 ? '+' : ''}${amount} ${op.counterType} counter(s) (manual).`, actor.playerId);
				}
				break;
			case 'tap':
			case 'untap':
				if (found) {
					if (op.op === 'tap') {
						tapPermanent(state, found.inst);
					} else if (found.inst.tapped) {
						found.inst.tapped = false;
						noteLayerInputsChanged(state);
					}
					addLog(state, 'rule', `${found.inst.card.name} was ${op.op === 'tap' ? 'tapped' : 'untapped'} (manual).`, actor.playerId);
				}
				break;
			case 'create_token':
				for (let i = 0; i < Math.max(1, amount); i++) {
					const power = op.tokenPower ?? 0;
					const toughness = op.tokenToughness ?? 0;
					const isCreature = op.tokenPower !== undefined || op.tokenToughness !== undefined;
					createTokenOnBoard(state, actor, {
						name: (op.tokenName ?? '').trim().slice(0, 40) || 'Token',
						power,
						toughness,
						colors: [],
						typeLine: isCreature ? 'Token Creature' : 'Token Artifact',
						keywords: []
					});
				}
				addLog(state, 'rule', `${actor.username} created ${Math.max(1, amount)} token(s) (manual).`, actor.playerId);
				break;
		}
	}
}

/**
 * CR 702.62a suspend: at the beginning of its owner's upkeep, remove a time counter from each
 * suspended card in exile; when the last is removed, cast it. A keyword rule, run from PhaseBegin
 * before triggered abilities are matched (it was step 2a of the old upkeep loop).
 */
export function runSuspendUpkeep(state: GameState, activePlayer: PlayerGameState): void {
	const suspendedCards = activePlayer.exile.filter(
		(c) => c.isSuspended && (c.counters.time || 0) > 0
	);
	for (const susp of suspendedCards) {
		susp.counters.time = Math.max(0, (susp.counters.time || 0) - 1);
		addLog(
			state,
			'trigger',
			`Suspend (CR 702.62): Removed a time counter from ${susp.card.name} (${susp.counters.time} remaining).`,
			activePlayer.playerId
		);
		if (susp.counters.time === 0) {
			executeSuspendFreeCastFromExile(state, activePlayer, susp);
		}
	}
}
// --- End Track P18a ---

/**
 * CR 702.26: Phasing Out a permanent also indirectly phases out any Auras/Equipment attached to it.
 * Phased-out permanents do not change zones (no LTB/ETB triggers fire!).
 */
export function phaseOutPermanent(state: GameState, perm: CardInstance): void {
	if (perm.phasedOut) return;
	const phasedIds = new Set<string>([perm.instanceId]);
	perm.phasedOut = true;
	perm.phasedOutIndirectly = false;
	// Indirectly phase out any Auras/Equipment/Fortifications attached to this permanent (CR 702.26g)
	let added = true;
	while (added) {
		added = false;
		for (const p of state.players) {
			for (const other of p.battlefield) {
				if (
					!other.phasedOut &&
					other.attachedToId &&
					phasedIds.has(other.attachedToId) &&
					!phasedIds.has(other.instanceId)
				) {
					other.phasedOut = true;
					other.phasedOutIndirectly = true;
					phasedIds.add(other.instanceId);
					added = true;
				}
			}
		}
	}
	noteLayerInputsChanged(state);
	// Remove from combat if attacking, blocking, or being attacked as a planeswalker/battle (CR 506.4, 506.4c)
	state.combat.attackers = state.combat.attackers.filter(
		(a) => !phasedIds.has(a.attackerInstanceId)
	);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((id) => !phasedIds.has(id));
		if (atk.defenderPlaneswalkerId && phasedIds.has(atk.defenderPlaneswalkerId)) {
			atk.defenderPlaneswalkerId = 'removed';
		}
		if (atk.defenderBattleId && phasedIds.has(atk.defenderBattleId)) {
			atk.defenderBattleId = 'removed';
		}
	}
}

/**
 * CR 721: Ending the Turn Prematurely (Obeka, Brute Chronologist / Sundial of the Infinite / Time Stop).
 * 1. All spells and abilities on the stack are exiled.
 * 2. All attacking and blocking creatures are removed from combat.
 * 3. State-based actions are checked.
 * 4. The current phase/step ends and the game skips directly to the Cleanup Step!
 */
export function endTheTurnImmediately(state: GameState, actorId: string): void {
	const exiledCount = state.stack.length;
	while (state.stack.length > 0) {
		const stk = state.stack.pop()!;
		H().moveStackSpellToZone(state, stk, 'exile');
	}

	state.combat.active = false;
	state.combat.attackers = [];
	state.combat.declaredBlockersPlayerIds = [];
	noteLayerInputsChanged(state);

	addLog(
		state,
		'rule',
		`The turn ended immediately (CR 721)! Exiled ${exiledCount} item(s) from the Stack and skipped to Cleanup Step.`,
		actorId
	);

	H().checkStateBasedActions(state);
	runCleanupStep(state);
}

/**
 * Enters the End Step (`end_step`), firing beginning-of-end-step permanent triggers
 * and putting any matching `delayedTriggers` (such as Final Fortune's "you lose the game",
 * Corpse Dance's exile trigger, or Dress Down's sacrifice trigger) onto the Stack in APNAP order.
 * If the Stack is non-empty, priority is given to `activePlayer` so they can respond (e.g. with Obeka or Sundial!).
 */
export function enterEndStep(state: GameState, activePlayer: PlayerGameState): void {
	emptyAllPlayersManaPools(state);
	// --- Track P12 ---
	clearWave4StepScopedState(state, state.phase);
	// --- End Track P12 ---
	emitVfx(state, { kind: 'phase_change', label: 'End Step' });
	// Beginning-of-end-step and delayed end-step triggers run from the PhaseBegin handler
	// (runEndStepTriggers), synchronously.
	H().beginPhase(state, 'end_step', activePlayer);

	givePriorityToActiveOrNextPlayer(state);
	state.passedPriorityPlayerIds = [];
}

/**
 * CR 702.62a: When the last time counter is removed from a suspended card in Exile,
 * its owner casts it without paying its mana cost if able. If it's a creature, it gains
 * haste until its controller loses control of it.
 */
export function executeSuspendFreeCastFromExile(
	state: GameState,
	owner: PlayerGameState,
	suspCard: CardInstance
): void {
	const eIdx = owner.exile.findIndex((c) => c.instanceId === suspCard.instanceId);
	if (eIdx < 0) return;

	// --- Track P18a: CR 702.50a Epic blocks casting spells for the rest of the game ---
	if (owner.cannotCastSpellsForRestOfGame) {
		suspCard.isSuspended = false;
		addLog(
			state,
			'rule',
			`${suspCard.card.name}'s last time counter was removed, but ${owner.username} cannot cast spells for the rest of the game (Epic, CR 702.50a); it remains in Exile.`,
			owner.playerId
		);
		return;
	}
	// --- End Track P18a ---

	// Check if global cast restrictions (like Rule of Law / Drannith Magistrate) block casting from Exile
	const globalCheck = checkGlobalCastPermissionsAndRestrictions(
		state,
		owner.playerId,
		suspCard,
		'exile'
	);
	// --- Track P16a: Turn-scoped cast ban ---
	if (owner.cantCastSpellsThisTurn) {
		suspCard.isSuspended = false;
		addLog(
			state,
			'rule',
			`${suspCard.card.name}'s last time counter was removed, but ${owner.username} can't cast spells this turn; it remains in Exile.`,
			owner.playerId
		);
		return;
	}
	// --- End Track P16a ---
	if (!globalCheck.ok) {
		suspCard.isSuspended = false;
		addLog(
			state,
			'rule',
			`${suspCard.card.name}'s last time counter was removed, but it could not be cast (${globalCheck.error}); it remains in Exile.`,
			owner.playerId
		);
		return;
	}

	// Auto-select a legal target if the spell requires one
	const spec = compileSpellEffects(suspCard.card)?.targets[0];
	const chosenTargets: TargetRef[] = [];
	if (spec && spec.min > 0) {
		const legalTargets = H().specTargetCandidates(state, owner.playerId, suspCard.card, suspCard, spec);
		if (legalTargets.length < spec.min) {
			suspCard.isSuspended = false;
			addLog(
				state,
				'rule',
				`${suspCard.card.name}'s last time counter was removed, but there were no legal targets; it remains in Exile.`,
				owner.playerId
			);
			return;
		}
		// Prefer targeting opponent or opponent's permanent for damage/removal
		const preferred =
			legalTargets.find((t) => t.id !== owner.playerId) || legalTargets[0];
		chosenTargets.push(preferred);
	}

	// Pinned behaviour: `zone` stays 'exile' and there's no objectVersion/timestamp change.
	moveObject(state, suspCard, 'stack', { from: { player: owner, zone: 'exile' }, setZone: false });
	suspCard.isSuspended = false;
	suspCard.castViaSuspend = true;
	owner.spellsCastThisTurn = (owner.spellsCastThisTurn || 0) + 1;

	const stackItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: suspCard.instanceId,
			card: suspCard.card,
			controllerId: owner.playerId,
			kind: 'spell',
			title: `${suspCard.card.name} (Suspended Cast)`,
			targets: chosenTargets,
			targetObjectVersions: H().captureTargetObjectVersions(state, chosenTargets),
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		suspCard.card
	);
	state.stack.push(stackItem);
	// --- Track P16a: Consume next-spell flash / uncounterable grants on suspended spell cast ---
	consumeP16aOnSpellCast(
		owner,
		resolveObjectFaces(suspCard.card, { zone: 'stack' }).types,
		stackItem
	);
	// --- End Track P16a ---
	addLog(
		state,
		'cast',
		`${owner.username} cast ${suspCard.card.name} from Exile without paying its mana cost via Suspend (CR 702.62a)!`,
		owner.playerId
	);
	emitEvent(state, {
		kind: 'Cast',
		playerId: owner.playerId,
		objectId: suspCard.instanceId,
		object: suspCard
	});
	// Resolve immediately if no players are holding interaction or during upkeep automation
	H().resolveTopOfStack(state);
	const suspView = resolveObjectFaces(
		effectiveCardForObject(suspCard),
		instanceFaceOptions(suspCard, 'stack')
	);
	if (suspView.types.includes('Creature')) {
		const onBoard = owner.battlefield.find((c) => c.instanceId === suspCard.instanceId);
		if (onBoard) {
			onBoard.castViaSuspend = true;
			onBoard.summoningSick = false;
		}
	}
}

export function checkSuspendLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	xValue?: number
): { ok: boolean; suspendInfo?: { timeCounters: number; cost: string }; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active.' };
	}
	const suspSpec = getSuspendSpec(inst.card);
	// --- Track P21: "Suspend X—{cost}. X can't be 0." (CR 702.62a) ---
	const suspXSpec = !suspSpec ? getSuspendXSpec(inst.card) : null;
	if (suspXSpec && xValue !== undefined && Math.floor(xValue) <= 0) {
		return {
			ok: false,
			error: `Strict Rules Violation: X can't be 0 when suspending ${inst.card.name} (CR 702.62a).`
		};
	}
	const chosenX = suspXSpec ? Math.max(1, Math.floor(xValue ?? 1)) : 0;
	const suspendInfo = suspSpec
		? { timeCounters: suspSpec.timeCounters, cost: suspSpec.suspendCost }
		: suspXSpec
			? {
					timeCounters: chosenX,
					cost: substituteSuspendXManaCost(suspXSpec.suspendCost, chosenX)
				}
			: null;
	// --- End Track P21 ---
	if (!suspendInfo) {
		return { ok: false, error: `${inst.card.name} does not have Suspend.` };
	}
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to suspend a card.' };
	}
	// CR 702.62a: You can exile a card from your hand with Suspend any time you could begin to cast it
	const activePlayer = state.players[state.activePlayerIndex];
	// --- Track P16a ---
	if (actor.cantCastSpellsThisTurn) {
		return { ok: false, error: 'You cannot cast spells this turn.' };
	}
	const suspTypes = resolveObjectFaces(inst.card, { zone: 'stack' }).types;
	// --- End Track P16a ---
	const globalCheck = checkGlobalCastPermissionsAndRestrictions(state, actorId, inst, 'hand');
	if (!globalCheck.ok) {
		return { ok: false, error: globalCheck.error };
	}
	const isInstantTiming =
		suspTypes.includes('Instant') ||
		hasKeyword(inst, 'Flash', state) ||
		globalCheck.grantsFlash ||
		// --- Track P16a ---
		playerHasP16aFlashGrantForTypes(actor, suspTypes);
		// --- End Track P16a ---
	if (!isInstantTiming) {
		if (
			activePlayer?.playerId !== actorId ||
			(state.phase !== 'main1' && state.phase !== 'main2') ||
			state.stack.length > 0
		) {
			return {
				ok: false,
				error: `${inst.card.name} can only be suspended at Sorcery speed.`
			};
		}
	}
	const costReq = parseManaCost(suspendInfo.cost);
	if (!H().canPayOrAutoTap(actor, costReq, state)) {
		return {
			ok: false,
			error: `Insufficient mana to pay Suspend cost ${suspendInfo.cost}.`
		};
	}
	return { ok: true, suspendInfo };
}

/**
 * Enumerates intrinsic hand special actions (CR 116.2h Foretell, CR 116.2k Plot) on `inst`.
 */
export function getHandSpecialActions(
	// --- Track P22a ---
	state: GameState,
	// --- End Track P22a ---
	actorId: string,
	inst: CardInstance
): HandSpecialActionOption[] {
	if (inst.zone !== 'hand' || inst.ownerId !== actorId) return [];
	// --- Track P22a ---
	const innate = enumerateHandSpecialActions(effectiveCardForObject(inst));
	if (!innate.some((o) => o.id === 'special:foretell')) {
		const grantedForetell = buildGrantedHandForetellActionOptionWave8(state, actorId, inst);
		if (grantedForetell) {
			return [...innate, grantedForetell];
		}
	}
	return innate;
	// --- End Track P22a ---
}

/**
 * Checks whether `actorId` may take the hand special action `actionId` on `inst` (CR 116.2h, CR 116.2k).
 */
export function checkHandSpecialActionLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	actionId: string,
	costPayment?: CostPayment
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => {
		if (state.status !== 'active') {
			return { ok: false, error: 'Game is not currently active.' };
		}
		if (state.pendingPrompts.length > 0) {
			return { ok: false, error: 'Resolve the active prompt first.' };
		}
		const actor = state.players.find((p) => p.playerId === actorId);
		if (!actor || actor.lost) {
			return { ok: false, error: 'Player is not active in this game.' };
		}
		if (inst.zone !== 'hand' || !actor.hand.some((c) => c.instanceId === inst.instanceId)) {
			return { ok: false, error: 'Card must be in your hand.' };
		}
		// --- Track P22a ---
		const actionOpt = getHandSpecialActions(state, actorId, inst).find(
			(o) => o.id === actionId
		);
		// --- End Track P22a ---
		if (!actionOpt) {
			return { ok: false, error: 'Special action is not available on this card.' };
		}
		const pendingCombatErr = H().getPendingCombatDeclarationError(state);
		if (pendingCombatErr) {
			return { ok: false, error: pendingCombatErr };
		}
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		if (priorityPlayer?.playerId !== actorId) {
			return { ok: false, error: 'You do not currently hold priority.' };
		}
		const activePlayer = state.players[state.activePlayerIndex];
		if (activePlayer?.playerId !== actorId) {
			return { ok: false, error: `${actionOpt.label} can only be used during your turn.` };
		}
		if (actionOpt.sorcerySpeedOnly) {
			if (state.phase !== 'main1' && state.phase !== 'main2') {
				return {
					ok: false,
					error: `${actionOpt.label} can only be used during your Main Phase.`
				};
			}
			if (state.stack.length > 0) {
				return {
					ok: false,
					error: `${actionOpt.label} cannot be used while the Stack is not empty.`
				};
			}
		}
		const topManaStr = actionOpt.costDefs
			.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana')
			.map((d) => d.cost)
			.join('');
		const nonManaDefs = actionOpt.costDefs.filter((d) => d.k !== 'mana');
		const req = topManaStr ? parseManaCost(topManaStr) : null;
		if (nonManaDefs.length > 0) {
			const reservedSelf = new Set<string>([inst.instanceId]);
			if (
				!canPayCosts(
					H().costContext(
						state,
						actor,
						inst,
						0,
						false,
						req,
						costPayment?.phyrexianLifeCount,
						undefined,
						reservedSelf
					),
					nonManaDefs
				)
			) {
				return {
					ok: false,
					error: `You can't pay the cost for ${actionOpt.label} (${actionOpt.costDisplay}).`
				};
			}
		} else if (req && !H().canPayOrAutoTap(actor, req, state, costPayment?.phyrexianLifeCount)) {
			return {
				ok: false,
				error: `Insufficient mana for ${actionOpt.label} (requires ${actionOpt.costDisplay}).`
			};
		}
		return { ok: true };
	});
}

export function chooseBotHandSpecialActionCostPayment(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	actionId: string
): CostPayment | undefined {
	// --- Track P22a ---
	const actionOpt = getHandSpecialActions(state, player.playerId, inst).find(
		(o) => o.id === actionId
	);
	// --- End Track P22a ---
	if (!actionOpt) return undefined;
	const topManaStr = actionOpt.costDefs
		.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana')
		.map((d) => d.cost)
		.join('');
	const nonManaDefs = actionOpt.costDefs.filter((d) => d.k !== 'mana');
	if (nonManaDefs.length === 0) return undefined;
	const req = topManaStr ? parseManaCost(topManaStr) : null;
	const reservedSelf = new Set<string>([inst.instanceId]);
	return (
		chooseCostPayment(
			H().costContext(state, player, inst, 0, false, req, undefined, undefined, reservedSelf),
			nonManaDefs
		) ?? undefined
	);
}

export function completeHandSpecialAction(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	actionId: string,
	descriptions: string[]
): void {
	const actorId = actor.playerId;
	const costSuffix = descriptions.length > 0 ? ` (${descriptions.join('; ')})` : '';
	if (actionId === 'special:foretell') {
		// --- Track P22a: Snapshot statically granted Foretell cast cost before leaving hand (CR 702.143a) ---
		const hasInnateForetell = enumerateHandSpecialActions(effectiveCardForObject(inst)).some(
			(o) => o.id === 'special:foretell'
		);
		const grantedForetellCost = hasInnateForetell
			? undefined
			: (getActiveGrantedHandForetellCostWave8(state, actorId, inst) ?? undefined);
		// --- End Track P22a ---
		const faceDownLabel = allocateFaceDownLabel(state);
		inst.isFaceDown = true;
		inst.faceDownLabel = faceDownLabel;
		inst.faceDownSpec = { kind: 'other', knownToPlayerIds: [actorId] };
		moveObject(state, inst, 'exile', {
			from: { player: actor, zone: 'hand' },
			toPlayer: actor,
			newTimestamp: true,
			bumpVersion: true,
			beforeInsert: (moved, dest) => {
				if (dest === 'exile') {
					moved.knownToPlayerIds = [actorId];
					moved.foretoldByPlayerId = actorId;
					moved.foretoldTurnNumber = state.turnNumber;
					// --- Track P22a ---
					if (grantedForetellCost) {
						moved.grantedForetellCost = grantedForetellCost;
					}
					// --- End Track P22a ---
				} else {
					moved.isFaceDown = false;
					moved.faceDownLabel = undefined;
					moved.faceDownSpec = undefined;
				}
			}
		});
		state.passedPriorityPlayerIds = [];
		state.priorityUpdatedAt = Date.now();
		addLog(
			state,
			'rule',
			`${actor.username} exiled a card from hand face down${costSuffix} (CR 116.2h).`,
			actorId
		);
		emitVfx(state, {
			kind: 'exile',
			sourceId: actorId,
			targetId: inst.instanceId,
			label: faceDownLabel
		});
		if (inst.zone === 'exile') {
			emitEvent(state, {
				kind: 'Foretold',
				playerId: actorId,
				objectId: inst.instanceId,
				card: inst
			});
		}
		resetTriggerLoopTracking(state);
		flushTriggers(state);
		H().checkStateBasedActions(state);
		return;
	}

	if (actionId === 'special:plot') {
		moveObject(state, inst, 'exile', {
			from: { player: actor, zone: 'hand' },
			toPlayer: actor,
			newTimestamp: true,
			bumpVersion: true,
			beforeInsert: (moved, dest) => {
				if (dest === 'exile') {
					moved.plottedByPlayerId = actorId;
					moved.plottedTurnNumber = state.turnNumber;
				}
			}
		});
		state.passedPriorityPlayerIds = [];
		state.priorityUpdatedAt = Date.now();
		addLog(
			state,
			'rule',
			`${actor.username} plotted ${inst.card.name}${costSuffix} (CR 116.2k).`,
			actorId
		);
		emitVfx(state, {
			kind: 'exile',
			sourceId: actorId,
			targetId: inst.instanceId,
			label: `${inst.card.name} (Plotted)`
		});
		if (inst.zone === 'exile') {
			emitEvent(state, {
				kind: 'Plotted',
				playerId: actorId,
				objectId: inst.instanceId,
				card: inst
			});
		}
		resetTriggerLoopTracking(state);
		flushTriggers(state);
		H().checkStateBasedActions(state);
	}
}

export function finalizeHandSpecialAction(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const inst = actor.hand.find((c) => c.instanceId === pcp.sourceInstanceId);
	if (!inst || !pcp.specialActionId) return;
	completeHandSpecialAction(state, actor, inst, pcp.specialActionId, pcp.descriptions);
}

/**
 * Unified grammar-driven Library Search execution + `Opposition Agent` interception (CR 701.19).
 */
export function initiateLibrarySearch(
	state: GameState,
	searchingPlayer: PlayerGameState,
	searchSpec: LibrarySearchSpec,
	item: StackItem
): void {
	// --- Track P17a: CR 701.19, 101.2 library search locks ("can't search libraries" / "top N cards instead") ---
	const searchLock = evaluateLibrarySearchLock(state, searchingPlayer.playerId);
	if (searchLock.cantSearch) {
		addLog(
			state,
			'rule',
			`${searchingPlayer.username} cannot search libraries (${searchLock.sourceName ?? 'static restriction'}).`,
			searchingPlayer.playerId
		);
		return;
	}
	const searchablePool =
		searchLock.topN !== undefined
			? searchingPlayer.library.slice(0, Math.max(0, searchLock.topN))
			: searchingPlayer.library;
	const searchableIds =
		searchLock.topN !== undefined ? new Set(searchablePool.map((c) => c.instanceId)) : null;
	// --- End Track P17a ---
	// --- Track P19b: CR 701.19a "Whenever a player / an opponent searches their library" ---
	emitEvent(state, { kind: 'LibrarySearched', playerId: searchingPlayer.playerId });
	// --- End Track P19b ---
	// --- Track P20b ---
	if (!searchingPlayer.searchedLibraryThisTurn) {
		searchingPlayer.searchedLibraryThisTurn = true;
		noteLayerInputsChanged(state);
	}
	// --- End Track P20b ---
	const interceptor = getLibrarySearchInterceptor(state, searchingPlayer.playerId);
	const decisionPlayer = interceptor
		? state.players.find((p) => p.playerId === interceptor.controllerId) || searchingPlayer
		: searchingPlayer;

	const matchingCards = searchablePool.filter((c) =>
		matchesLibrarySearchSpec(
			c.card,
			searchSpec,
			resolveObjectFaces(c.card, instanceFaceOptions(c)).colors
		)
	);
	const canFailToFind =
		searchSpec.statedQuality || searchSpec.upTo || matchingCards.length === 0 || searchableIds !== null;

	if (decisionPlayer.isBot) {
		const topCardsToPlace: CardInstance[] = [];
		for (const dest of searchSpec.destinations) {
			const idx = searchingPlayer.library.findIndex(
				(c) =>
					(!searchableIds || searchableIds.has(c.instanceId)) &&
					matchesLibrarySearchSpec(
						c.card,
						searchSpec,
						resolveObjectFaces(c.card, instanceFaceOptions(c)).colors
					)
			);
			if (idx < 0) break;
			const found = searchingPlayer.library[idx];
			const fromLibrary = { player: searchingPlayer, zone: 'library' as const };

			if (interceptor?.exilesFoundCards) {
				if (interceptor.grantPlayFromExile) {
					found.playableFromExileBy = {
						playerId: interceptor.controllerId,
						spendManaAsAnyColor: interceptor.spendManaAsAnyColor,
						sourceName: interceptor.sourceName
					};
				}
				moveObject(state, found, 'exile', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					newTimestamp: true,
					bumpVersion: true
				});
				addLog(
					state,
					'rule',
					`${decisionPlayer.username} (controlling ${searchingPlayer.username} via ${interceptor.sourceName}) exiled ${found.card.name} from ${searchingPlayer.username}'s library!`,
					decisionPlayer.playerId
				);
			} else if (dest.zone === 'battlefield') {
				const isAura = resolveObjectFaces(
					effectiveCardForObject(found),
					instanceFaceOptions(found, 'battlefield')
				).subtypes.includes('Aura');
				if (isAura) {
					const attachCands = H().legalAuraAttachCandidates(state, found, searchingPlayer);
					if (attachCands.length === 0) {
						addLog(
							state,
							'rule',
							`${found.card.name} remained in ${searchingPlayer.username}'s library because there is no legal object or player for it to enchant (CR 303.4g).`,
							searchingPlayer.playerId
						);
						continue;
					}
					attachObject(state, found, attachCands[0]);
				}
				found.tapped = Boolean(dest.tapped);
				found.summoningSick = true;
				found.defaultControllerId = searchingPlayer.playerId;
				applySelfEtbReplacements(state, found);
				moveObject(state, found, 'battlefield', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					controllerId: searchingPlayer.playerId,
					bumpVersion: true
				});
				if (isAura && found.attachedToId) {
					const attachedTarget = findPermanentOnBoard(state, found.attachedToId);
					if (attachedTarget) {
						emitEvent(state, {
							kind: 'Attached',
							attachmentId: found.instanceId,
							attachment: found,
							hostId: attachedTarget.inst.instanceId,
							host: attachedTarget.inst
						});
					}
				}
				addLog(
					state,
					'rule',
					`${searchingPlayer.username} searched their library for ${found.card.name} and put it onto the battlefield${found.tapped ? ' tapped' : ''}.`,
					searchingPlayer.playerId
				);
				flushTriggers(state);
			} else if (dest.zone === 'library' && dest.onTop) {
				moveObject(state, found, 'library', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					insert: (actual) => (actual === 'library' ? 'deferred' : 'end'),
					commanderRedirect: true,
					newTimestamp: true,
					bumpVersion: true
				});
				if (found.zone === 'library') {
					topCardsToPlace.push(found);
				}
			} else {
				moveObject(state, found, 'hand', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					commanderRedirect: true
				});
				addLog(
					state,
					'rule',
					searchSpec.reveal
						? `${searchingPlayer.username} searched their library, revealed ${found.card.name}, and put it into hand.`
						: `${searchingPlayer.username} searched their library for a card and put it into hand.`,
					searchingPlayer.playerId
				);
			}
		}
		shuffleLibrary(state, searchingPlayer);
		if (topCardsToPlace.length > 0) {
			placeDeferred(searchingPlayer, 'library', topCardsToPlace, 'start');
			addLog(
				state,
				'rule',
				`${searchingPlayer.username} searched their library, shuffled, and put ${topCardsToPlace.length} card(s) on top.`,
				searchingPlayer.playerId
			);
		}
		return;
	}

	if (matchingCards.length === 0 && !interceptor) {
		shuffleLibrary(state, searchingPlayer);
		addLog(
			state,
			'rule',
			`${searchingPlayer.username} searched their library for ${item.card.name} (no matching cards found) and shuffled.`,
			searchingPlayer.playerId
		);
		return;
	}

	const [firstDest, ...restDestinations] =
		searchSpec.destinations.length > 0
			? searchSpec.destinations
			: [{ zone: 'hand' as const }];

	const candidateIds = matchingCards.map((c) => c.instanceId);
	const description = interceptor
		? `You control ${searchingPlayer.username} while they search their library for ${searchSpec.rawCriteriaText}. Choose a matching card to exile (you may play it for as long as it remains exiled${interceptor.spendManaAsAnyColor ? ', spending mana as though it were mana of any color' : ''}).${canFailToFind ? ' Because the search states a card quality, you may also choose to Fail to Find.' : ' Because the search does not state a card quality, you MUST find a card (CR 701.19b).'}`
		: `Choose ${searchSpec.rawCriteriaText} from your library to put ${describeLibrarySearchDestination(firstDest)}${restDestinations.length > 0 ? ` (then ${restDestinations.length} more: ${restDestinations.map(describeLibrarySearchDestination).join(', ')})` : ''}, then shuffle.`;

	state.pendingPrompts.push({
		id: uid('prm', state),
		playerId: decisionPlayer.playerId,
		targetLibraryOwnerId: searchingPlayer.playerId,
		kind: 'search_library',
		purpose: 'search_library',
		title: interceptor
			? `${interceptor.sourceName} — Search ${searchingPlayer.username}'s Library (${item.card.name})`
			: `Search Your Library (${item.card.name})`,
		description,
		destinationZone: firstDest.zone,
		enterTapped: Boolean(firstDest.tapped),
		putOnTop: Boolean(firstDest.onTop),
		searchSpec,
		remainingDestinations: restDestinations,
		canFailToFind,
		interceptedBy: interceptor || undefined,
		candidateInstanceIds: candidateIds,
		stackItem: item,
		choice: {
			kind: 'chooseObjects',
			candidates: candidateIds,
			min: canFailToFind || candidateIds.length === 0 ? 0 : 1,
			max: 1,
			zone: 'library',
			reason: description
		}
	});
}

export function createTokenOnBoard(
	state: GameState,
	controller: PlayerGameState,
	spec: TokenSpec
): CardInstance {
	if (!isTokenReplacementSuppressedWave9()) {
		const batches = applyTokenReplacementsWave9(state, controller, spec, 1);
		if (
			batches.length !== 1 ||
			batches[0]!.count !== 1 ||
			batches[0]!.spec !== spec
		) {
			let firstCreated: CardInstance | undefined;
			runWithTokenReplacementSuppressedWave9(() => {
				for (const b of batches) {
					for (let i = 0; i < b.count; i++) {
						const created = createTokenOnBoard(state, controller, b.spec);
						if (!firstCreated) firstCreated = created;
					}
				}
			});
			if (firstCreated) return firstCreated;
		}
	}
	const tokenCard: ScryfallCard = buildTokenScryfallCard(uid('tok_scry', state), spec);

	const inst = createCardInstance(
		tokenCard,
		controller.playerId,
		'battlefield',
		false,
		true,
		allocateTimestamp(state),
		state
	);
	inst.summoningSick = true;
	if (spec.tapped) inst.tapped = true;
	moveObject(state, inst, 'battlefield', { from: 'none', toPlayer: controller });
	emitEvent(state, {
		kind: 'TokenCreated',
		playerId: controller.playerId,
		objectId: inst.instanceId,
		object: inst
	});
	emitVfx(state, {
		kind: 'token_create',
		sourceId: controller.playerId,
		targetId: inst.instanceId,
		label: spec.name
	});
	flushTriggers(state);
	return inst;
}

export function executeProliferate(
	state: GameState,
	controller: PlayerGameState,
	chosenIds?: string[]
): void {
	// --- Track P19b ---
	const p19bPreEnergy = capturePlayerEnergySnapshot(state);
	// --- End Track P19b ---
	// --- Track P11 + Track P16a: Proliferate all counters including arbitrary & rad/ticket (CR 701.27a) ---
	void ALL_COUNTER_TYPES;
	// --- End Track P11 + Track P16a ---
	const proMult = getProliferateMultiplierWave9(state, controller.playerId);
	for (let proIter = 0; proIter < proMult; proIter++) {
	if (chosenIds) {
		const chosenSet = new Set(chosenIds);
		for (const pl of state.players) {
			for (const perm of pl.battlefield) {
				if (perm.phasedOut || !chosenSet.has(perm.instanceId)) continue;
				for (const [cType, cnt] of Object.entries(perm.counters)) {
					if ((cnt || 0) > 0) {
						H().addCountersToPermanent(state, perm, cType as CounterType, 1);
					}
				}
			}
			if (chosenSet.has(pl.playerId)) {
				// --- Track P17a: CR 122.1, 614.1a scale player counter additions ---
				if (pl.poison > 0) {
					pl.poison += scalePlayerCountersPlaced(state, pl.playerId, 'poison', 1, controller.playerId);
				}
				if ((pl.experienceCounters || 0) > 0) {
					pl.experienceCounters =
						(pl.experienceCounters || 0) +
						scalePlayerCountersPlaced(state, pl.playerId, 'experience', 1, controller.playerId);
				}
				if ((pl.energyCounters || 0) > 0) {
					pl.energyCounters =
						(pl.energyCounters || 0) +
						scalePlayerCountersPlaced(state, pl.playerId, 'energy', 1, controller.playerId);
				}
				// --- Track P16a ---
				if ((pl.radCounters || 0) > 0) {
					pl.radCounters =
						(pl.radCounters || 0) +
						scalePlayerCountersPlaced(state, pl.playerId, 'rad', 1, controller.playerId);
				}
				if ((pl.ticketCounters || 0) > 0) {
					pl.ticketCounters =
						(pl.ticketCounters || 0) +
						scalePlayerCountersPlaced(state, pl.playerId, 'ticket', 1, controller.playerId);
				}
				// --- End Track P16a & P17a ---
			}
		}
	} else {
		// --- Track P11 + Track P16a ---
		const negSet = new Set<string>(['-1/-1', 'stun', 'finality', 'plague', 'blight']);
		// --- End Track P11 + Track P16a ---
		for (const perm of controller.battlefield) {
			if (perm.phasedOut) continue;
			for (const [cType, cnt] of Object.entries(perm.counters)) {
				if ((cnt || 0) > 0 && !negSet.has(cType) && !isNegativeArbitraryCounter(cType)) {
					H().addCountersToPermanent(state, perm, cType as CounterType, 1);
				}
			}
		}
		if (controller.poison === 0 && (controller.radCounters || 0) === 0) {
			// --- Track P17a & P16a ---
			if ((controller.experienceCounters || 0) > 0) {
				controller.experienceCounters =
					(controller.experienceCounters || 0) +
					scalePlayerCountersPlaced(state, controller.playerId, 'experience', 1, controller.playerId);
			}
			if ((controller.energyCounters || 0) > 0) {
				controller.energyCounters =
					(controller.energyCounters || 0) +
					scalePlayerCountersPlaced(state, controller.playerId, 'energy', 1, controller.playerId);
			}
			if ((controller.ticketCounters || 0) > 0) {
				controller.ticketCounters =
					(controller.ticketCounters || 0) +
					scalePlayerCountersPlaced(state, controller.playerId, 'ticket', 1, controller.playerId);
			}
			// --- End Track P17a & P16a ---
		}
		for (const opp of state.players) {
			if (opp.playerId === controller.playerId) continue;
			for (const perm of opp.battlefield) {
				if (perm.phasedOut) continue;
				for (const [cType, cnt] of Object.entries(perm.counters)) {
					if ((cnt || 0) > 0 && (negSet.has(cType) || isNegativeArbitraryCounter(cType))) {
						H().addCountersToPermanent(state, perm, cType as CounterType, 1);
					}
				}
			}
			if (opp.poison > 0 || (opp.radCounters || 0) > 0) {
				// --- Track P17a & P16a ---
				if (opp.poison > 0) {
					opp.poison += scalePlayerCountersPlaced(state, opp.playerId, 'poison', 1, controller.playerId);
				}
				if ((opp.radCounters || 0) > 0) {
					opp.radCounters =
						(opp.radCounters || 0) +
						scalePlayerCountersPlaced(state, opp.playerId, 'rad', 1, controller.playerId);
				}
				if ((opp.experienceCounters || 0) > 0) {
					opp.experienceCounters =
						(opp.experienceCounters || 0) +
						scalePlayerCountersPlaced(state, opp.playerId, 'experience', 1, controller.playerId);
				}
				if ((opp.energyCounters || 0) > 0) {
					opp.energyCounters =
						(opp.energyCounters || 0) +
						scalePlayerCountersPlaced(state, opp.playerId, 'energy', 1, controller.playerId);
				}
				if ((opp.ticketCounters || 0) > 0) {
					opp.ticketCounters =
						(opp.ticketCounters || 0) +
						scalePlayerCountersPlaced(state, opp.playerId, 'ticket', 1, controller.playerId);
				}
				// --- End Track P17a & P16a ---
			}
		}
	}
	}
	noteLayerInputsChanged(state);
	// --- Track P19b ---
	emitEnergyDiffEvents(state, p19bPreEnergy);
	emitEvent(state, { kind: 'Proliferated', playerId: controller.playerId });
	// --- End Track P19b ---
	emitVfx(state, {
		kind: 'proliferate',
		sourceId: controller.playerId,
		label: 'Proliferate!'
	});
}

// --- Precon Bragos Spirit: CR 500.11 skipped combat phases ---
/** Consumes one pending "skip your next combat phase" for the active player; true iff the phase is skipped. */
function consumeSkippedCombatPhase(state: GameState, activePlayer: PlayerGameState): boolean {
	if ((activePlayer.skipNextCombatPhases ?? 0) <= 0) return false;
	activePlayer.skipNextCombatPhases = Math.max(0, (activePlayer.skipNextCombatPhases ?? 0) - 1) || undefined;
	addLog(state, 'rule', `${activePlayer.username} skips their combat phase (CR 500.11).`, activePlayer.playerId);
	return true;
}

/** After a combat phase ends (or is skipped): begin a pending additional combat phase, else the postcombat main phase (or end_step if entered from main2). */
function beginPostCombatOrAdditionalCombat(state: GameState, activePlayer: PlayerGameState): void {
	while ((state.additionalCombatPhases ?? 0) > 0) {
		state.additionalCombatPhases!--;
		const slotId = state.extraCombatSlotIds?.pop();
		if (state.extraCombatSlotIds && state.extraCombatSlotIds.length === 0) {
			delete state.extraCombatSlotIds;
		}
		if (consumeSkippedCombatPhase(state, activePlayer)) {
			runWave9NextCombatDelayedTriggers(state, slotId, true);
			continue;
		}
		runWave9NextCombatDelayedTriggers(state, slotId);
		if (state.gambitNextCombatDirective) {
			state.gambitActiveCombatDirective = state.gambitNextCombatDirective;
			delete state.gambitNextCombatDirective;
		}
		H().beginPhase(state, 'begin_combat', activePlayer);
		emitVfx(state, { kind: 'phase_change', label: 'Combat — Beginning of Additional Combat' });
		addLog(state, 'rule', `${activePlayer.username} begins an additional combat phase.`);
		return;
	}
	if (state.additionalCombatAfterMain2) {
		delete state.additionalCombatAfterMain2;
		enterEndStep(state, activePlayer);
		return;
	}
	H().beginPhase(state, 'main2', activePlayer);
	flushPendingNextMainPhaseMana(state, activePlayer);
	emitVfx(state, { kind: 'phase_change', label: 'Postcombat Main Phase 2' });
}
// --- End Precon Bragos Spirit ---

export function advancePhaseOrStep(state: GameState): void {
	// Drain unspent mana pools at the end of each step/phase (CR 106.4 / 500.4)
	emptyAllPlayersManaPools(state);
	// --- Track P12 ---
	clearWave4StepScopedState(state, state.phase);
	// --- End Track P12 ---

	const activePlayer = state.players[state.activePlayerIndex];

	switch (state.phase) {
		case 'untap':
			H().beginPhase(state, 'upkeep', activePlayer);
			break;
		case 'upkeep':
			H().beginPhase(state, 'draw', activePlayer);
			emitVfx(state, {
				kind: 'phase_change',
				label: `Turn ${state.turnNumber}: ${activePlayer?.username ?? ''} — Draw Step`
			});
			break;
		case 'draw':
			H().beginPhase(state, 'main1', activePlayer);
			flushPendingNextMainPhaseMana(state, activePlayer);
			emitVfx(state, {
				kind: 'phase_change',
				label: `Turn ${state.turnNumber}: ${activePlayer?.username ?? ''} — Main Phase 1`
			});
			break;

		case 'main1':
			// --- Precon Bragos Spirit: CR 500.11 skipped combat phase ---
			if (consumeSkippedCombatPhase(state, activePlayer)) {
				beginPostCombatOrAdditionalCombat(state, activePlayer);
				break;
			}
			// --- End Precon Bragos Spirit ---
			H().beginPhase(state, 'begin_combat', activePlayer);
			emitVfx(state, { kind: 'phase_change', label: 'Combat — Beginning of Combat' });
			break;

		case 'begin_combat':
			emitVfx(state, { kind: 'phase_change', label: 'Combat — Declare Attackers' });
			H().beginPhase(state, 'declare_attackers', activePlayer);
			break;

		case 'declare_attackers':
			if (state.combat.active && state.combat.attackers.length > 0) {
				H().beginPhase(state, 'declare_blockers', activePlayer);
				if (!state.combat.blockersDeclared) {
					const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
					const nextDefenderId =
						defendersInOrder.find(
							(defId) => !state.combat.declaredBlockersPlayerIds.includes(defId)
						) || state.combat.attackers[0].defenderPlayerId;
					const defIdx = state.players.findIndex((p) => p.playerId === nextDefenderId);
					if (defIdx >= 0) {
						state.priorityPlayerIndex = defIdx;
					} else {
						givePriorityToActiveOrNextPlayer(state);
					}
					state.passedPriorityPlayerIds = [];
					H().checkStateBasedActions(state);
					return;
				}
				break;
			} else {
				// CR 508.8: If no creatures are declared as attackers, skip declare_blockers, combat_damage, and end_combat
				state.combat.active = false;
				state.combat.attackers = [];
				// --- Track P18a ---
				delete state.combat.bands;
				// --- End Track P18a ---
				state.combat.declaredBlockersPlayerIds = [];
				state.combat.blockersDeclared = false;
				state.combat.dealtFirstStrikeDamageIds = [];
				// --- Track P16a (CR 511.2): Expire untilEndOfCombat continuous effects ---
				expireP16aEndOfCombatEffects(state);
				// --- End Track P16a ---
				delete state.gambitActiveCombatDirective;
				noteLayerInputsChanged(state);
				beginPostCombatOrAdditionalCombat(state, activePlayer);
			}
			break;

		case 'declare_blockers': {
			// Check if any combatant has First strike or Double strike
			const hasFirstStrike = H().checkAnyCombatantHasFirstStrike(state);
			if (hasFirstStrike) {
				H().beginPhase(state, 'first_strike_damage', activePlayer);
			} else {
				H().beginPhase(state, 'combat_damage', activePlayer);
			}
			break;
		}

		case 'first_strike_damage':
			H().beginPhase(state, 'combat_damage', activePlayer);
			break;

		case 'combat_damage':
			// CR 511.1 / 511.3: Advance to end_combat; creatures remain attacking/blocking until end_combat ends
			H().beginPhase(state, 'end_combat', activePlayer);
			emitVfx(state, { kind: 'phase_change', label: 'Combat — End of Combat' });
			break;

		case 'end_combat':
			// CR 511.3: At the end of the end of combat step, all creatures are removed from combat
			state.combat.active = false;
			state.combat.attackers = [];
			// --- Track P18a ---
			delete state.combat.bands;
			// --- End Track P18a ---
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.blockersDeclared = false;
			state.combat.dealtFirstStrikeDamageIds = [];
			// --- Track P15: Clear Provoke combat blocking requirement ---
			for (const p of state.players) {
				for (const perm of p.battlefield) {
					delete perm.provokeMustBlockId;
				}
			}
			// --- End Track P15 ---
			// --- Track P16a (CR 511.2): Expire untilEndOfCombat continuous effects ---
			expireP16aEndOfCombatEffects(state);
			// --- End Track P16a ---
			delete state.gambitActiveCombatDirective;
			noteLayerInputsChanged(state);
			beginPostCombatOrAdditionalCombat(state, activePlayer);
			break;

		case 'main2':
			if ((state.additionalCombatPhases ?? 0) > 0) {
				state.additionalCombatAfterMain2 = true;
				beginPostCombatOrAdditionalCombat(state, activePlayer);
				break;
			}
			enterEndStep(state, activePlayer);
			break;

		case 'end_step':
			runCleanupStep(state);
			return;

		case 'cleanup':
			runCleanupStep(state);
			return;
	}

	givePriorityToActiveOrNextPlayer(state);
	state.passedPriorityPlayerIds = [];
	H().checkStateBasedActions(state);
}

export function clearEndOfTurnAndDamage(state: GameState): void {
	state.additionalCombatPhases = 0;
	delete state.additionalCombatAfterMain2;
	delete state.extraCombatSlotIds;
	// --- Track P22b ---
	clearP22bEndOfTurnState(state);
	// --- End Track P22b ---
	// --- Track P19b ---
	clearP19bEndOfTurnState(state);
	// --- End Track P19b ---
	// --- Track P13 ---
	cleanupP13TurnState(state, state.players[state.activePlayerIndex]?.playerId ?? '');
	// --- End Track P13 ---
	// --- Track P16a ---
	cleanupP16aTurnState(state);
	// --- End Track P16a ---
	// --- Track P19a ---
	cleanupP19aTurnState(state);
	// --- End Track P19a ---
	clearWave10TurnEndState(state);
	clearWave11TurnEndState(state);
	// --- Track P7 ---
	clearP7EndOfTurnEffects(state);
	// --- End Track P7 ---
	state.timedKeywordEffects = undefined;
	if (state.timedContinuousEffects?.length) {
		const persisting = state.timedContinuousEffects.filter(
			(eff) => eff.expires && eff.expires !== 'endOfTurn'
		);
		state.timedContinuousEffects = persisting.length > 0 ? persisting : undefined;
	}
	for (const p of state.players) {
		// --- Track P10 ---
		clearPlayerManaPoolAtCleanup(p);
		// --- End Track P10 ---
		// --- Track P11 ---
		clearSnowManaPool(p);
		// --- End Track P11 ---
		p.preventAllCombatDamageThisTurn = false;
		// --- Track P9 ---
		p.damageDealtToThisTurn = 0;
		// --- End Track P9 ---
		for (const perm of p.battlefield) {
			// --- Track P22a: CR 514.2 damageNotRemovedInCleanup ---
			if (!permanentKeepsDamageInCleanupWave8(state, perm)) {
				perm.damageMarked = 0;
				perm.deathtouchDamageMarked = false;
			}
			// --- End Track P22a ---
			perm.tempPowerMod = 0;
			perm.tempToughnessMod = 0;
			perm.grantedKeywords = [];
			perm.switchedPTCount = 0;
			perm.activatedAbilityIdsThisTurn = undefined;
			perm.usedModalModesThisTurn = undefined;
			perm.regenerationShields = undefined;
			perm.cantBeRegeneratedThisTurn = undefined;
			perm.crewedThisTurnByIds = undefined;
			perm.saddledThisTurn = undefined;
			perm.saddledThisTurnByIds = undefined;
			perm.exertedThisTurn = undefined;
			delete perm.provokeMustBlockId;
			if (perm.goadExpirations) {
				for (const [goaderId, dur] of Object.entries(perm.goadExpirations)) {
					if (dur === 'endOfTurn') {
						delete perm.goadExpirations[goaderId];
						if (perm.goadedByPlayerIds) {
							perm.goadedByPlayerIds = perm.goadedByPlayerIds.filter((id) => id !== goaderId);
						}
					}
				}
				if (perm.goadedByPlayerIds && perm.goadedByPlayerIds.length === 0) {
					perm.goadedByPlayerIds = undefined;
				}
				if (Object.keys(perm.goadExpirations).length === 0) {
					perm.goadExpirations = undefined;
				}
			}
		}
		const cleanupActivePlayer = state.players[state.activePlayerIndex];
		const currentTurnSerial = state.turnSerial ?? state.turnNumber;
		for (const ex of p.exile) {
			const perm = ex.playableFromExileBy;
			if (!perm) continue;
			if (perm.expiresAtEndOfTurn) {
				ex.playableFromExileBy = undefined;
			} else if (
				perm.duration === 'untilEndOfYourNextTurn' &&
				cleanupActivePlayer?.playerId === perm.expiresOnCleanupOfPlayerId &&
				currentTurnSerial > (perm.grantedOnTurnSerial ?? 0)
			) {
				ex.playableFromExileBy = undefined;
			}
		}
	}
	noteLayerInputsChanged(state);
	syncBattlefieldControllers(state);
}

function runCleanupStep(state: GameState): void {
	emptyAllPlayersManaPools(state);
	const activePlayer = state.players[state.activePlayerIndex];

	// Check if activePlayer has Reliquary Tower / Thought Vessel for unlimited hand size
	const hasNoMaxHandSize =
		state.rules.maxHandSize >= 99 ||
		// --- Track P22d ---
		Boolean(activePlayer.noMaxHandSizeForRestOfGame) ||
		// --- End Track P22d ---
		playerHasNoMaxHandSize(state, activePlayer);

	// --- Track P11: CR 402.2 / 613.10 effective maximum hand size (deltas, setMaxHandSize, noMaxHandSize) ---
	const computedMaxHand = hasNoMaxHandSize
		? null
		: computeEffectiveMaxHandSize(state, activePlayer);
	const maxHand = computedMaxHand === null ? 999 : computedMaxHand;
	// --- End Track P11 ---
	if (!activePlayer.lost && activePlayer.hand.length > maxHand) {
		const excess = activePlayer.hand.length - maxHand;
		if (activePlayer.isBot) {
			for (const c of activePlayer.hand.slice(0, excess)) {
				moveObject(state, c, 'graveyard', {
					from: { player: activePlayer, zone: 'hand' },
					toPlayer: activePlayer,
					graveyardReplacement: true,
					commanderRedirect: true,
					// --- Track P9 ---
					discardReason: 'discard',
					discardPlayerId: activePlayer.playerId
					// --- End Track P9 ---
				});
			}
			H().beginPhase(state, 'cleanup', activePlayer);
			completeTurnCleanupAndPassTurn(state);
		} else {
			H().beginPhase(state, 'cleanup', activePlayer);
			const candidateIds = activePlayer.hand.map((c) => c.instanceId);
			const description = `Cleanup Step: Select ${excess} card(s) from your hand to discard.`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: activePlayer.playerId,
				kind: 'discard_to_hand_size',
				purpose: 'discard_to_hand_size',
				title: `Discard Down to ${maxHand} Cards`,
				description,
				countRequired: excess,
				candidateInstanceIds: candidateIds,
				continuation: {
					kind: 'procedure',
					procedure: {
						kind: 'discard_to_hand_size',
						actorId: activePlayer.playerId,
						chosenIds: [],
						nextIndex: 0,
						discardCount: excess
					}
				},
				choice: {
					kind: 'chooseObjects',
					candidates: candidateIds,
					min: excess,
					max: excess,
					zone: 'hand',
					reason: description
				}
			});
		}
		return;
	}

	H().beginPhase(state, 'cleanup', activePlayer);
	completeTurnCleanupAndPassTurn(state);
}

function completeTurnCleanupAndPassTurn(state: GameState): void {
	// Clear marked damage, temporary EOT buffs, and Layer 7d P/T switches on all permanents (CR 514.2)
	clearEndOfTurnAndDamage(state);

	// CR 514.3a: Check SBAs and flush any triggers that triggered during cleanup
	H().checkStateBasedActions(state);
	flushTriggers(state);
	if (state.status === 'finished') return;
	if (state.stack.length > 0 || state.pendingPrompts.length > 0) {
		state.phase = 'cleanup';
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		return;
	}

	// CR 500.7: Check if there is a queued extra turn in LIFO order
	if (state.extraTurnQueue && state.extraTurnQueue.length > 0) {
		// --- Track P20a & P19a ---
		for (let guard = 0; guard < 64 && state.extraTurnQueue.length > 0; guard++) {
			const extraPlayerId = state.extraTurnQueue.pop()!;
			const extraIdx = state.players.findIndex((p) => p.playerId === extraPlayerId && !p.lost);
			if (extraIdx >= 0) {
				const skipCheck = shouldPlayerSkipExtraTurn(state, extraPlayerId);
				if (skipCheck.skip) {
					addLog(
						state,
						'rule',
						`${state.players[extraIdx].username} skips their extra turn (${skipCheck.sourceName ?? 'Rule modifier'}).`,
						extraPlayerId
					);
					continue;
				}
				const extraCand = state.players[extraIdx];
				if ((extraCand.skipNextTurns ?? 0) > 0) {
					extraCand.skipNextTurns =
						Math.max(0, (extraCand.skipNextTurns ?? 0) - 1) || undefined;
					addLog(
						state,
						'rule',
						`${extraCand.username} skips their extra turn (CR 614.10).`,
						extraPlayerId
					);
					continue;
				}
				// --- End Track P20a & P19a ---
				if (state.lastNormalTurnPlayerIndex === undefined) {
					state.lastNormalTurnPlayerIndex = state.activePlayerIndex;
				}
				state.activePlayerIndex = extraIdx;
				state.turnNumber += 1;
				state.turnSerial = (state.turnSerial ?? state.turnNumber) + 1;
				addLog(
					state,
					'rule',
					`${state.players[extraIdx].username} begins their extra turn (CR 500.7)!`,
					extraPlayerId
				);
				runBeginningOfTurn(state);
				return;
			}
		}
	}

	// Otherwise advance activePlayerIndex to next alive player in normal turn order (CR 500.7)
	const baseIdx = state.lastNormalTurnPlayerIndex ?? state.activePlayerIndex;
	state.lastNormalTurnPlayerIndex = undefined;
	const count = state.players.length;
	// --- Track P19a (CR 614.10, CR 614.10a): Bounded step loop supporting skipped turns ---
	const maxSteps = Math.max(count, count * 16);
	for (let step = 1; step <= maxSteps; step++) {
		const nextIdx = (baseIdx + step) % count;
		if (state.players[nextIdx].lost) {
			// CR 800.4m: "until your next turn" effects created by a player who left the game expire when their next turn would begin.
			expirePlayerUntilNextTurnEffects(state, state.players[nextIdx].playerId);
			continue;
		}
		const candPlayer = state.players[nextIdx];
		if ((candPlayer.skipNextTurns ?? 0) > 0) {
			candPlayer.skipNextTurns = Math.max(0, (candPlayer.skipNextTurns ?? 0) - 1) || undefined;
			addLog(
				state,
				'rule',
				`${candPlayer.username} skips their turn (CR 614.10).`,
				candPlayer.playerId
			);
			continue;
		}
		if (nextIdx <= baseIdx || step > count) {
			state.turnNumber += 1;
		}
		state.turnSerial = (state.turnSerial ?? state.turnNumber) + 1;
		state.activePlayerIndex = nextIdx;
		break;
	}
	// --- End Track P19a ---

	runBeginningOfTurn(state);
}

registerEndCombatHooksWave10({
	expireEndOfCombat: expireP16aEndOfCombatEffects,
	advanceFromEndedCombat: beginPostCombatOrAdditionalCombat
});
