import { chooseBotModalTriggerModes, chooseBotTriggerTargets } from './ai.ts';
import { compileCard, getAbilityModal } from './compiler/index.ts';
import { cardAbilityDisplayText } from './compiler/support.ts';
import type { CostDef, TargetSpec } from './ir.ts';
import { createEmptyManaPool, type ManaCostRequirement, parseManaCost } from './oracle.ts';
import { evaluatePermanent, getSpellTargetRequirement } from './ruleTree.ts';
import {
	autoTapManaAbilities,
	canPayOrAutoTap,
	maybeAskPhyrexianCostChoice,
	payManaWithAutoTap,
	resolveActivatedManaAbility,
	resolveHybridCostChoice,
	TAP_MANA_ABILITY_CHOICE_HANDLER,
	TAP_MANA_BUNDLE_CHOICE_HANDLER,
	TAP_MANA_COLOR_CHOICE_HANDLER
} from './runtime/autoTap.ts';
import {
	activatedAbilitySpendContext,
	askCostChoice,
	canPayManaWithPaymentAids,
	checkActivationRestrictionsOnly,
	compileOptionSpellEffects,
	costContext,
	evaluateSpecDivideTotal,
	executeOrResumePendingCostPayment,
	finalizeCastSpell,
	getDynamicManaProducedAmount,
	getSpellCostRequirementForOption,
	isAbilityActivationConditionMet,
	p10AddManaOptions,
	resolveCastOptionForAction,
	resolveTargetDivisionsForSpecs,
	resumePendingCostPayment,
	spellSpendContext
} from './runtime/castingAndCosts.ts';
import { enqueueChoicePrompt, registerChoicesHost, registerPromptHandler } from './runtime/choices.ts';
import {
	advanceBotBlockerDeclarations,
	applyValidatedDefenderBlockers,
	checkAnyCombatantHasFirstStrike,
	completeUnconfirmedZeroAttackersDeclaration,
	executeBotDeclareAttackersTurnBasedAction,
	executeCombatDamageStep,
	findMandatoryAttackerViolation,
	getPendingCombatDeclarationError,
	isUnconfirmedAttackersStep,
	performDeclareAttackers,
	validateDefenderBlockerAssignments
} from './runtime/combat.ts';
import { getEffectiveCardForPermanent } from './runtime/copyPreventionAndEffects.ts';
import {
	activatedAbilityCost,
	applyCastCostAids,
	canPayCosts,
	costModifiersOf,
	effectiveAbilityManaCost,
	expandOptionalAdditionalCosts,
	hasReturnToHandOptionalCost,
	isCastConditionMet,
	planCosts,
	serializeCostPlanParts,
	spellAdditionalCost,
	validateOptionalCostCounts
} from './runtime/costs.ts';
import { collectActiveAbilityAdditionalCostsWave6, collectSpellPerTargetLifeCostsWave6 } from './runtime/costsWave6.ts';
import {
	cardUsesP20bCostPaidCount,
	computeMaxAvailableP20bPitchCounts,
	computeP20bPitchCountsFromPayment,
	getCommanderTaxLifeCostP20b,
	hasCounterRemovalSerializedPart,
	isPitchPaymentSettledP20b,
	lastRollResultFromSerializedParts,
	totalRemovedCountersFromSerializedParts,
	wasAnyAdditionalCostPaidP20b
} from './runtime/costsWave7.ts';
import { executeEffectSteps, gainPlayerLife, registerEffectPorts } from './runtime/effects.ts';
import { registerP16aRuntimeHost } from './runtime/effectsWave6.ts';
import { registerP19aRuntimeHost } from './runtime/effectsWave7.ts';
import {
	addLog,
	advancePriorityToNextPlayer,
	allocateFaceDownLabel,
	cardHasSupportedMultiFace,
	createCardInstance,
	emitVfx,
	findCardAnywhere,
	findPermanentOnBoard,
	getAttackedDefenderIdsInTurnOrder,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity,
	givePriorityToActiveOrNextPlayer,
	hasKeyword,
	movePermanentToZone,
	optionTargetsBecomeEach,
	registerEngineRuntimeHost,
	resetTriggerLoopTracking
} from './runtime/engineHost.ts';
import { beginAction, emitEvent, endAction } from './runtime/events.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './runtime/faces.ts';
import { registerWave5Host } from './runtime/framesBattlesAndKeywordsWave5.ts';
import {
	checkCompanionSpecialActionLegality,
	findPayableOfferingCandidates,
	getEffectiveUsedModalModes
} from './runtime/framesModalsWave6.ts';
import {
	findCastWhileSearchingLibraryCard,
	registerWave7Host,
	selectCraftShareCardTypeMaterials
} from './runtime/framesWave7.ts';
import { registerWave3Host } from './runtime/keywordsWave3.ts';
import {
	computeModalModeAdditionalCosts,
	findPayableEmergeCandidates,
	findPayableHarmonizeOptions,
	registerWave4Host
} from './runtime/keywordsWave4.ts';
import { registerWave6Host } from './runtime/keywordsWave6.ts';
import { hasChooseAllModesOptionalCost } from './runtime/kicker.ts';
import { noteLayerInputsChanged } from './runtime/layerCache.ts';
import {
	captureTargetObjectVersions,
	checkAbilityActivationLegality,
	checkLandPlayLegality,
	checkSpellCastLegality,
	checkSpellCastOptionLegalityInner,
	checkTurnFaceUpLegality,
	checkUnlockRoomDoorLegality,
	completeTurnFaceUp,
	finalizeTurnFaceUp,
	findActivatedAbilityTarget,
	flipPermanent,
	hasHexproofFromQuality,
	hasProtectionFrom,
	hasXInTurnUpCost,
	isTargetStillValid,
	partitionTargetsBySpecs,
	playerHasHexproofFrom,
	playerHasShroud,
	resolveLandPlayFaceIndex,
	resolveTurnUpManaRequirement,
	transformPermanent,
	validateChosenTargets,
	validateTargetLegality
} from './runtime/legalityAndTargets.ts';
import {
	evaluateCondition,
	matchesObjectFilter,
	objectPower,
	objectToughness
} from './runtime/objectFilter.ts';
import { hasExileKeywordPermission } from './runtime/orthogonalKeywords.ts';
import {
	deriveIdSalt,
	freshRngSeed,
	type RngHolder,
	uid,
	type UidHolder
} from './runtime/random.ts';
import { registerP10RuntimeHost } from './runtime/reflexiveManaAndActions.ts';
import {
	applySelfEtbReplacements,
	checkGlobalAbilityActivationRestrictions,
	matchesPlayerFilter,
	tokenMultiplier
} from './runtime/replace.ts';
import {
	applyDamageToTarget,
	checkStateBasedActions,
	cleanupEliminatedPlayer,
	legalAuraAttachCandidates
} from './runtime/sba.ts';
import {
	activePlayerMayEndTurn,
	addCountersToPermanent,
	canPayOptionalCost,
	chooseBotStackItemRetarget,
	copyPermanentAsToken,
	counterStackItemByEffect,
	destroyPermanentByEffect,
	getStackItemRetargetSlots,
	hasLegalModalCombination,
	initiateLibraryScryOrSurveil,
	modalCandidateModeStatus,
	moveStackSpellToZone,
	payOptionalCost,
	pushCopiedStackItem,
	recordUsedModalModes,
	resolveStackItemCompiledEffects,
	resolveTopOfStack,
	resumeStackItem,
	stackAbilitySourceMatchesFilter,
	stackItemAwaitsPrompt,
	triggerEventContext,
	triggerItemEffect,
	triggerItemModal,
	tryRegenerateInsteadOfDestroy,
	validateDeferredOpponentModalChoice,
	validateModalChoice,
	validateStackItemRetarget
} from './runtime/stackResolution.ts';
import {
	consumeWave5StaticPlaySlot,
	getWave5SlottedLandPlayPermission,
	hasWave5ExilePlayPermission
} from './runtime/staticsAndCostsWave5.ts';
import { boardMayGrantStaticAbility, collectActiveGrantedStaticDefs } from './runtime/staticsDynamicAndCosts.ts';
import {
	getActiveZoneLandPlayPermissionSource,
	markHandCardRevealedToAll
} from './runtime/staticsLayersAndRestrictions.ts';
import {
	adjustCostDefsForCrewSaddleVirtualPower,
	checkWave6CostPaymentLocks,
	createTokenWithWave6Replacements
} from './runtime/staticsWave6.ts';
import { applyCommanderPreGameColorChoices, finalizeCommanderPreGameColorChoice } from './runtime/staticsWave8.ts';
import {
	askTriggerOrder,
	assignOrPromptTriggerTargets,
	beginPhase,
	emitUnblockedAttackersEvents,
	enqueueHumanTriggerModesPrompt,
	executeTriggerEffects,
	perOpponentTargetError,
	pushMonarchInherentTrigger,
	putTriggerOnStack,
	resolveTriggerModalBeforeStack,
	resolveTriggerPrompt,
	setMonarch,
	specTargetCandidates,
	stackSpellMatchesFilterQualifiers,
	triggeredStackItem,
	triggerItemTargetSpecs,
	triggerSourceObject,
	triggerSourcePublicName,
	triggerTargetCandidates,
	triggerTargetStillLegal
} from './runtime/triggerStacking.ts';
import {
	flushTriggers,
	registerTriggerHost,
	withSimultaneousZoneBatch,
	withTriggersDeferred
} from './runtime/triggers.ts';
import { resolveInlineManaRecipientPlayer, withInlineManaResolutionGuard } from './runtime/triggersWave7.ts';
import {
	expandCombinationBundles,
	FIVE_MANA_COLORS,
	formatManaBundle,
	pickBestBundleForRequirement,
	pickCombinationForRequirement
} from './runtime/tuckFreezeChosen.ts';
import {
	advancePhaseOrStep,
	advanceSurveilGraveyardProcedure,
	checkHandSpecialActionLegality,
	checkSuspendLegality,
	clearEndOfTurnAndDamage,
	completeHandSpecialAction,
	createTokenOnBoard,
	drawCards,
	drawSingleCardWithoutDredge,
	endTheTurnImmediately,
	executeDrawTurnBasedAction,
	executeProliferate,
	executeUntapTurnBasedActions,
	finalizeHandSpecialAction,
	finishCombatDamagePhase,
	getHandSpecialActions,
	handleMulliganAction,
	handlePromptResolution,
	initiateLibrarySearch,
	loseTheGame,
	phaseOutPermanent,
	runBeginningOfTurn,
	runSuspendUpkeep,
	winTheGame
} from './runtime/turnAndPrompts.ts';
import {
	allocateTimestamp,
	createEmptyCounters,
	moveObject,
	mulliganRedraw,
	putCompanionIntoHand,
	setZoneOrder,
	shuffleArray,
	shuffleLibrary,
	tapPermanent
} from './runtime/zones.ts';
import { effectiveCardForObject } from './scryfall.ts';
import {
	type CardInstance,
	type EffectiveActivatedAbility,
	ENGINE_VERSION,
	type GameActionPayload,
	type GameState,
	type LobbyRulesConfig,
	type LobbySeat,
	type MagicDeck,
	type MagicLobby,
	type ManaColor,
	type ManaSpendContext,
	type PendingCostPayment,
	type PlayerGameState,
	type SerializedPlannedCost,
	type SpellModifications,
	type TargetRef,
	type TargetRequirementInfo,
	type ZoneType
} from './types.ts';

export {
	checkGlobalCastPermissionsAndRestrictions,
	evaluatePermanent,
	getCardActivatedAbilities,
	getLibrarySearchInterceptor,
	getSpellTargetRequirement,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities,
	playerCannotLoseGame,
	playerCannotWinGame,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent
} from './ruleTree.ts';

export { matchesLibrarySearchSpec, parseLibrarySearchSpec } from './oracle.ts';

export { applyCastCostAids, formatManaRequirement, getSuspendSpec } from './runtime/costs.ts';

export { allocateTimestamp, shuffleArray } from './runtime/zones.ts';

export { ENGINE_VERSION } from './types.ts';

export {
	canPayOrAutoTap,
	payManaWithAutoTap
} from './runtime/autoTap.ts';

export {
	chooseBotAbilityCostPayment,
	chooseBotSpellCostPayment,
	getCastOptions,
	getSpellCostRequirement,
	getSpellOptionCostRequirement,
	planCastCostAids,
	type PlannedCastCostAids,
	spellSpendContext
} from './runtime/castingAndCosts.ts';

export {
	canBlock,
	chooseBotAttackAssignments,
	chooseBotBlockAssignments,
	type CombatAttackerForecast,
	type CombatBlockerForecast,
	type CombatDamageForecast,
	computeCombatDamageForecast,
	isCombatDeclarationPending,
	type PlaneswalkerIncomingForecast,
	type PlayerIncomingForecast
} from './runtime/combat.ts';

export {
	addLog,
	createCardInstance,
	emitVfx,
	enqueueGuidedResolutionPrompt,
	findPermanentOnBoard,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity,
	getSagaFinalChapterNumber,
	hasKeyword,
	LOOP_TRIGGER_THRESHOLD,
	matchesPermanentTypeFilter,
	MAX_STACK_FOR_TRIGGERS,
	MAX_TRIGGERS_PER_TURN,
	movePermanentToZone,
	triggerResolutionCounts
} from './runtime/engineHost.ts';

export {
	checkAbilityActivationLegality,
	checkEndTurnLegality,
	checkLandPlayLegality,
	checkMandatoryAttackersSatisfied,
	checkSpellCastLegality,
	checkTurnFaceUpLegality,
	checkUnlockRoomDoorLegality,
	chooseBotTurnFaceUpPayment,
	flipPermanent,
	getAllLegalTargetsForRequirement,
	getLandPlayOptions,
	getTurnFaceUpDisplay,
	hasHexproofFromQuality,
	hasProtectionFrom,
	hasRequiredLegalTargets,
	playerHasHexproofFrom,
	playerHasShroud,
	transformPermanent,
	type TurnFaceUpDisplayInfo,
	validateChosenTargets,
	validateTargetLegality
} from './runtime/legalityAndTargets.ts';

export {
	checkStateBasedActions,
	cleanupEliminatedPlayer,
	legalAuraAttachCandidates
} from './runtime/sba.ts';

export {
	addCountersToPermanent,
	getModalDisabledIndices,
	moveStackSpellToZone,
	resolveTopOfStack
} from './runtime/stackResolution.ts';

export {
	setMonarch,
	specTargetCandidates
} from './runtime/triggerStacking.ts';

export {
	advancePhaseOrStep,
	checkHandSpecialActionLegality,
	checkSuspendLegality,
	chooseBotHandSpecialActionCostPayment,
	createTokenOnBoard,
	drawCards,
	emptyAllPlayersManaPools,
	endTheTurnImmediately,
	enterEndStep,
	executeProliferate,
	executeSuspendFreeCastFromExile,
	expirePlayerUntilNextTurnEffects,
	getHandSpecialActions,
	loseTheGame,
	phaseOutPermanent,
	runBeginningOfTurn,
	winTheGame
} from './runtime/turnAndPrompts.ts';

export {
	getAttachedCardsOnBoard,
	getHostCardOnBoard,
	sanitizeGameStateForViewer
} from './runtime/viewerRedaction.ts';

export function createInitialGameState(
	lobbyCode: string,
	seats: LobbySeat[],
	decksBySeat: Map<number, MagicDeck>,
	rules: LobbyRulesConfig
): GameState {
	const now = Date.now();
	const activeSeats = seats.filter((s) => s.userId !== null || s.isBot);
	// ENGINE_INVARIANTS.md 7.2: one seed per game; every shuffle and random choice draws from it.
	const initialSeed = freshRngSeed();
	const rng: RngHolder = { rngState: initialSeed };
	const idSalt = deriveIdSalt(initialSeed);
	const uidHolder: UidHolder = { nextUid: 0, idSalt };
	// Starting cards are numbered per game so a new game never depends on what the process created
	// before it. They are all off the battlefield, and every battlefield entry takes a fresh
	// allocateTimestamp, so these values never order layer effects.
	let initialTimestamp = 1;

	const players: PlayerGameState[] = activeSeats.map((seat, idx) => {
		const playerId = seat.userId || `bot_${seat.seatIndex}`;
		const deck = decksBySeat.get(seat.seatIndex)!;

		const command: CardInstance[] = deck.commanders.map((c) =>
			createCardInstance(c, playerId, 'command', true, false, ++initialTimestamp, uidHolder)
		);
		const commanderColorIdentity = Array.from(
			new Set(deck.commanders.flatMap((c) => c.colorIdentity))
		);

		const rawLibrary: CardInstance[] = [];
		for (const entry of deck.cards) {
			for (let q = 0; q < entry.quantity; q++) {
				rawLibrary.push(
					createCardInstance(entry.card, playerId, 'library', false, false, ++initialTimestamp, uidHolder)
				);
			}
		}

		const shuffled = shuffleArray(rng, rawLibrary);
		const hand = shuffled.splice(0, 7).map((c) => ({ ...c, zone: 'hand' as ZoneType }));

		return {
			playerId,
			seatIndex: idx,
			username: seat.username,
			avatarUrl: seat.avatarUrl,
			isBot: seat.isBot,
			life: rules.startingLife,
			poison: 0,
			experienceCounters: 0,
			energyCounters: 0,
			manaPool: createEmptyManaPool(),
			restrictedMana: {},
			landsPlayedThisTurn: 0,
			maxLandsPerTurn: 1,
			mulliganCount: 0,
			hasKeptHand: seat.isBot, // Bots auto-keep opening hand after smart check
			lost: false,
			commanderDamageTaken: {},
			commanderNames: {},
			commanderCastCounts: {},
			commanderColorIdentity,
			autoPassEmptyStack: true,
			fullControl: false,
			stopPhases: [],
			library: shuffled,
			hand,
			battlefield: [],
			graveyard: [],
			exile: [],
			command,
			// --- Track P18b ---
			...(deck.companion ? { companion: deck.companion } : {})
			// --- End Track P18b ---
		};
	});

	// Populate global commander map so every player tracks every commander's name and cast count
	const allCommanders: Array<{ id: string; name: string }> = [];
	for (const p of players) {
		for (const c of p.command) {
			allCommanders.push({ id: c.instanceId, name: c.card.name });
			p.commanderCastCounts[c.instanceId] = 0;
		}
	}
	for (const p of players) {
		for (const cmd of allCommanders) {
			p.commanderDamageTaken[cmd.id] = 0;
			p.commanderNames[cmd.id] = cmd.name;
		}
	}

	const state: GameState = {
		engineVersion: ENGINE_VERSION,
		gameId: uid('game', uidHolder),
		lobbyCode,
		status: 'mulligan',
		winnerPlayerId: null,
		rules,
		turnNumber: 1,
		turnSerial: 1,
		activePlayerIndex: 0,
		priorityPlayerIndex: 0,
		passedPriorityPlayerIds: [],
		phase: 'main1',
		players,
		stack: [],
		combat: {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		},
		pendingPrompts: [],
		rngState: rng.rngState,
		nextUid: uidHolder.nextUid,
		idSalt,
		recentVfxEvents: [],
		log: [],
		turnStartedAt: now,
		priorityUpdatedAt: now,
		nextTimestamp: 200,
		delayedTriggers: [],
		extraTurnQueue: [],
		stackTriggersEnabled: false,
		// --- Track P17b ---
		startingPlayerId: players[0]?.playerId
		// --- End Track P17b ---
	};

	// Smart bot opening hand mulligan
	const freeMulligans =
		rules.mulliganRule === 'free_all' || rules.mulliganRule === 'friendly_unlimited'
			? 7
			: rules.mulliganRule === 'london_standard' || rules.mulliganRule === 'strict_london'
				? 0
				: 1;
	for (const p of state.players) {
		if (p.isBot) {
			const landCount = p.hand.filter((c) =>
				resolveObjectFaces(effectiveCardForObject(c), instanceFaceOptions(c, 'hand')).types.includes(
					'Land'
				)
			).length;
			if (landCount < 2 || landCount > 5) {
				p.mulliganCount += 1;
				mulliganRedraw(state, p, { emit: false });
				const toBottom = Math.max(0, p.mulliganCount - freeMulligans);
				for (let b = 0; b < toBottom && p.hand.length > 0; b++) {
					moveObject(state, p.hand[p.hand.length - 1], 'library', {
						from: { player: p, zone: 'hand' },
						toPlayer: p,
						insert: 'end',
						emit: false,
						bumpVersion: false,
						newTimestamp: false
					});
				}
			}
			p.hasKeptHand = true;
		} else {
			const description =
				rules.mulliganRule === 'friendly_unlimited'
					? 'Friendly Mulligan: You may keep your 7-card hand or take a free 7-card mulligan.'
					: 'London Mulligan: Your first mulligan in Commander is free (7 cards). Subsequent mulligans put 1 card per extra mulligan on the bottom of your library.';
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: p.playerId,
				kind: 'mulligan',
				purpose: 'mulligan',
				title: 'Opening Hand Mulligan',
				description,
				choice: { kind: 'yesNo', question: description }
			});
		}
	}

	addLog(
		state,
		'system',
		`Commander pod started (${players.length} players, ${rules.startingLife} starting life, ${rules.commanderDamageLethal || 'Off'} cmdr lethal).`
	);

	checkIfAllKeptMulligan(state);
	return state;
}

export function checkIfAllKeptMulligan(state: GameState): void {
	if (state.status !== 'mulligan') return;
	const anyMulliganPrompts = state.pendingPrompts.some(
		(pr) => pr.kind === 'mulligan' || pr.kind === 'london_bottom'
	);
	if (anyMulliganPrompts) return;

	if (state.players.every((p) => p.hasKeptHand)) {
		// --- Track P22a: CR 903.4 Commander pre-game color choice before Turn 1 ---
		if (applyCommanderPreGameColorChoices(state, enqueueChoicePrompt, uid)) {
			return;
		}
		// --- End Track P22a ---
		for (const p of state.players) {
			const pregameBattlefieldCards = p.hand.filter((c) => {
				const abilities = activeAbilityDefs(effectiveCardForObject(c));
				return abilities.some(
					(a) => a.kind === 'static' && a.static.k === 'pregameAction' && a.static.action === 'beginOnBattlefield'
				);
			});
			for (const inst of pregameBattlefieldCards) {
				inst.defaultControllerId = p.playerId;
				inst.controllerId = p.playerId;
				moveObject(state, inst, 'battlefield', {
					from: { player: p, zone: 'hand' },
					toPlayer: p,
					controllerId: p.playerId,
					newTimestamp: true,
					bumpVersion: true
				});
				addLog(
					state,
					'rule',
					`${p.username} began the game with ${inst.card.name} on the battlefield (CR 103.6a).`,
					p.playerId
				);
			}
		}
		state.status = 'active';
		state.turnNumber = 1;
		state.turnSerial = 1;
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		addLog(state, 'system', `All players kept their opening hands. Turn 1 begins for ${state.players[0].username}!`);
		runBeginningOfTurn(state);
		if (state.status === 'active' && state.stack.length === 0 && state.pendingPrompts.length === 0) {
			advancePhaseOrStep(state);
		}
		if (state.status === 'active' && state.stack.length === 0 && state.pendingPrompts.length === 0) {
			advancePhaseOrStep(state);
		}
	}
}

// --- Track P22a: CR 903.4 Commander pre-game color choice prompt handler ---
registerPromptHandler('commander_pregame_color', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const playerId = typeof data?.playerId === 'string' ? data.playerId : prompt.playerId;
	const commanderInstanceId =
		typeof data?.commanderInstanceId === 'string' ? data.commanderInstanceId : '';
	const fiveCols: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
	const chosenColor: ManaColor =
		answer.kind === 'chooseMode' ? (fiveCols[answer.indices[0] ?? 0] ?? 'W') : 'W';
	const player = state.players.find((pl) => pl.playerId === playerId);
	const cmd = player?.command.find((c) => c.instanceId === commanderInstanceId);
	if (player && cmd) {
		finalizeCommanderPreGameColorChoice(player, cmd, chosenColor);
		addLog(
			state,
			'rule',
			`${player.username} chose ${chosenColor} for ${cmd.card.name} before the game began (CR 903.4).`,
			player.playerId
		);
		noteLayerInputsChanged(state);
	}
	checkIfAllKeptMulligan(state);
});

/**
 * Applies one player action. Events emitted while it runs are dispatched synchronously and the
 * queue is drained when the outermost call returns (see runtime/events.ts).
 */
export function applyGameAction(
	state: GameState,
	actorId: string,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	beginAction(state);
	try {
		const res = applyGameActionInner(state, actorId, action);
		// Pending triggers live outside GameState (runtime/triggers.ts); none may outlive the action,
		// or the lobby server's JSON round trip would drop them. Normally already flushed.
		flushTriggers(state);
		return res;
	} finally {
		endAction(state);
	}
}

/**
 * Ends an active or mulligan game whose `engineVersion` is missing or mismatches `ENGINE_VERSION`
 * (PLAN §2.6). Returns `true` when it transitioned the game to `'finished'` and appended a system
 * log entry; returns `false` if the version matches or the game was already `'finished'`.
 */
export function enforceEngineVersion(state: GameState): boolean {
	if (state.engineVersion === ENGINE_VERSION) return false;
	if (state.status === 'finished') return false;
	state.status = 'finished';
	addLog(
		state,
		'system',
		`Match ended: game state engineVersion (${state.engineVersion ?? 'missing'}) is incompatible with current engineVersion (${ENGINE_VERSION}).`
	);
	return true;
}

/**
 * Load-time version gate for a `MagicLobby`: if the lobby has an active/mulligan `gameState` with a
 * missing or mismatched `engineVersion`, ends the game and marks the lobby `'finished'`, bumps
 * `lobby.version`, and returns `true` so the caller can persist the ended state before responding.
 */
export function enforceLobbyEngineVersion(lobby: MagicLobby, now = Date.now()): boolean {
	if (!lobby.gameState) return false;
	if (!enforceEngineVersion(lobby.gameState)) return false;
	lobby.status = 'finished';
	lobby.version += 1;
	lobby.updatedAt = now;
	return true;
}

export function applyGameActionInner(
	state: GameState,
	actorId: string,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	if (state.status === 'finished') {
		return { ok: false, error: 'Game has already finished.' };
	}

	if (enforceEngineVersion(state)) {
		return {
			ok: false,
			error: `Match ended due to incompatible engineVersion (${state.engineVersion ?? 'missing'} vs ${ENGINE_VERSION}).`
		};
	}

	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor) {
		return { ok: false, error: 'Player is not seated in this game.' };
	}

	// Handle Concede anytime
	if (action.type === 'concede') {
		actor.lost = true;
		actor.lossReason = 'Conceded the match.';
		addLog(state, 'system', `${actor.username} conceded the game.`, actorId);
		cleanupEliminatedPlayer(state, actor);
		checkStateBasedActions(state);
		return { ok: true };
	}

	// Handle UI toggles anytime
	if (action.type === 'toggle_full_control') {
		actor.fullControl = action.enabled;
		return { ok: true };
	}
	if (action.type === 'toggle_stop_phase') {
		const idx = actor.stopPhases.indexOf(action.phase);
		if (idx >= 0) {
			actor.stopPhases.splice(idx, 1);
		} else {
			actor.stopPhases.push(action.phase);
		}
		return { ok: true };
	}

	// Handle Mulligan Phase actions
	if (state.status === 'mulligan') {
		return handleMulliganAction(state, actor, action);
	}

	// --- Track P21 (CR 601.3e, 701.23g): Allow casting a `castFromLibraryWhileSearching` card mid-search ---
	const isCastWhileSearchingLibrary =
		action.type === 'cast_spell' &&
		Boolean(findCastWhileSearchingLibraryCard(state, actor, action.instanceId));
	// --- End Track P21 ---

	// Check if there is a blocking PendingPrompt for this player
	const promptIdx = state.pendingPrompts.findIndex((p) => p.playerId === actorId);
	if (promptIdx >= 0 && !isCastWhileSearchingLibrary) {
		return handlePromptResolution(state, actor, promptIdx, action);
	}

	if (state.pendingPrompts.length > 0 && !isCastWhileSearchingLibrary) {
		const waitingOn = state.players.find((p) => p.playerId === state.pendingPrompts[0].playerId);
		return {
			ok: false,
			error: `Waiting for ${waitingOn?.username || 'another player'} to resolve ${state.pendingPrompts[0].title}.`
		};
	}

	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];

	switch (action.type) {
		case 'resolve_manually': {
			// Step E2 escape hatch: apply any ability of a card by hand (guided operations). It needs
			// priority and never uses the stack.
			if (priorityPlayer?.playerId !== actor.playerId) {
				return { ok: false, error: 'You can resolve an ability manually only while you have priority.' };
			}
			const found = findCardAnywhere(state, action.instanceId);
			const mine = found && (found.zone === 'battlefield' ? found.inst.controllerId === actor.playerId : found.inst.ownerId === actor.playerId);
			if (!found || !mine) return { ok: false, error: 'Choose a card you control.' };
			const card = found.inst.copiableCard ?? found.inst.card;
			const text = cardAbilityDisplayText(card, action.abilityIndex);
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: actor.playerId,
				kind: 'guided_resolution',
				purpose: 'guided_resolution',
				title: `Resolve Manually: ${card.name}`,
				description: text,
				yesLabel: 'Done',
				cancellable: true,
				continuation: { kind: 'manual_ability', sourceInstanceId: found.inst.instanceId },
				choice: { kind: 'yesNo', question: `Apply ${card.name}'s ability with the operations below.` }
			});
			resetTriggerLoopTracking(state);
			addLog(state, 'rule', `${actor.username} is resolving an ability of ${card.name} manually.`, actor.playerId);
			return { ok: true };
		}
		case 'tap_mana': {
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm || perm.phasedOut) {
				return { ok: false, error: 'Permanent not found on your battlefield.' };
			}
			// --- Track P7 ---
			const permEffCard = getEffectiveCardForPermanent(state, perm);
			// --- End Track P7 ---
			const cmdId = getPlayerCommanderIdentity(actor);
			const manaAbs = getEffectiveActivatedAbilities(state, actor, perm, cmdId).filter((a) => a.isManaAbility);
			if (manaAbs.length === 0) {
				return { ok: false, error: `${perm.card.name} does not have an active mana ability.` };
			}
			const globalAbCheck = checkGlobalAbilityActivationRestrictions(state, actorId, perm, true);
			if (!globalAbCheck.ok) return globalAbCheck;

			const preferred = action.preferredColor;
			const requestedBundle = action.chosenBundle;
			// --- Track P17b ---
			const tapXValue = Math.max(0, Math.floor(action.xValue ?? 0));
			// --- End Track P17b ---
			let ab: EffectiveActivatedAbility | undefined;
			if (action.abilityId) {
				ab = manaAbs.find((a) => a.id === action.abilityId);
				if (!ab) return { ok: false, error: 'Mana ability not found on this permanent.' };
			} else {
				const matchingAbs =
					requestedBundle && requestedBundle.length > 0
						? manaAbs.filter((a) => requestedBundle.every((c) => a.producesMana.includes(c)))
						: preferred
							? manaAbs.filter((a) => a.producesMana.includes(preferred))
							: manaAbs.filter((a) => a.producesMana.length > 0);
				const payableAbs = matchingAbs.filter((candidate) => {
					if (!checkActivationRestrictionsOnly(state, actorId, perm, candidate).ok) return false;
					// --- Track P7 ---
					const cDefs = activatedAbilityCost(permEffCard, candidate).defs;
					// --- End Track P7 ---
					const cReq = parseManaCost(
						candidate.manaCost === '{0}' ? '' : candidate.manaCost,
						tapXValue
					);
					const cCtx = costContext(state, actor, perm, tapXValue, false, cReq);
					return canPayCosts(cCtx, cDefs);
				});
				// Deduplicate functionally identical mana abilities (e.g. two copies of the same granter, or
				// two {T}-only 1-mana abilities when preferredColor already fixes the output color).
				const distinctPayableAbs: EffectiveActivatedAbility[] = [];
				const seenSignatures = new Set<string>();
				for (const candidate of payableAbs) {
					// --- Track P7 ---
					const cDefs = activatedAbilityCost(permEffCard, candidate).defs;
					// --- End Track P7 ---
					const amt = getDynamicManaProducedAmount(
						state,
						actor,
						perm,
						candidate.producesAmount,
						candidate,
						tapXValue
					);
					const colorSig = preferred ? preferred : candidate.producesMana.join(',');
					const sig = `${JSON.stringify(cDefs)}|${JSON.stringify(candidate.activationRestrictions ?? [])}|${JSON.stringify(candidate.activationCondition ?? null)}|${Boolean(candidate.freezesSelfUntap)}|${JSON.stringify(candidate.manaBundles ?? null)}|${JSON.stringify(candidate.manaCombinationColors ?? null)}|${JSON.stringify(candidate.manaRestrictionSpec ?? null)}|${Boolean(candidate.retainManaUntilEndOfTurn)}|${amt}|${colorSig}`;
					if (!seenSignatures.has(sig)) {
						seenSignatures.add(sig);
						distinctPayableAbs.push(candidate);
					}
				}
				if (!actor.isBot && distinctPayableAbs.length > 1) {
					let bestIdx = 0;
					let bestAmt = -1;
					let bestFreezes = 1;
					for (let i = 0; i < distinctPayableAbs.length; i++) {
						const amt = getDynamicManaProducedAmount(
							state,
							actor,
							perm,
							distinctPayableAbs[i].producesAmount,
							distinctPayableAbs[i],
							tapXValue
						);
						const frz = distinctPayableAbs[i].freezesSelfUntap ? 1 : 0;
						if (amt > bestAmt || (amt === bestAmt && frz < bestFreezes)) {
							bestAmt = amt;
							bestFreezes = frz;
							bestIdx = i;
						}
					}
					enqueueChoicePrompt(state, {
						id: uid('prm', state),
						playerId: actor.playerId,
						kind: 'chooseMode',
						purpose: 'generic',
						title: `${perm.card.name} — Choose Mana Ability`,
						description: `Choose which mana ability of ${perm.card.name} to activate.`,
						cancellable: true,
						continuation: {
							kind: 'handler',
							name: TAP_MANA_ABILITY_CHOICE_HANDLER,
							data: {
								instanceId: perm.instanceId,
								abilityIdsCsv: distinctPayableAbs.map((a) => a.id).join('\u001f'),
								preferredColor: preferred ?? null,
								chosenBundleCsv: requestedBundle ? requestedBundle.join(',') : null,
								costPaymentJson: action.costPayment ? JSON.stringify(action.costPayment) : null,
								// --- Track P17b ---
								...(action.xValue !== undefined ? { xValue: tapXValue } : {})
								// --- End Track P17b ---
							}
						},
						choice: {
							kind: 'chooseMode',
							modes: distinctPayableAbs.map((a) => a.label),
							min: 1,
							max: 1,
							defaultIndices: [bestIdx]
						}
					});
					return { ok: true };
				}
				if (payableAbs.length > 0) {
					ab = [...payableAbs].sort((x, y) => {
						const diff =
							getDynamicManaProducedAmount(
								state,
								actor,
								perm,
								y.producesAmount,
								y,
								tapXValue
							) -
							getDynamicManaProducedAmount(
								state,
								actor,
								perm,
								x.producesAmount,
								x,
								tapXValue
							);
						if (diff !== 0) return diff;
						return (x.freezesSelfUntap ? 1 : 0) - (y.freezesSelfUntap ? 1 : 0);
					})[0];
				} else {
					ab =
						(preferred && manaAbs.find((a) => a.producesMana.includes(preferred))) ||
						manaAbs.find((a) => a.producesMana.length > 0) ||
						manaAbs[0];
				}
			}
			const allowedColors = ab.producesMana;
			let chosenColor: ManaColor | undefined =
				preferred && allowedColors.includes(preferred) ? preferred : allowedColors[0];

			if (ab.activationRestrictions?.length || ab.activationCondition) {
				// --- Track P20b ---
				const manaAbLegality = checkAbilityActivationLegality(
					state,
					actorId,
					perm,
					ab,
					action.xValue !== undefined ? tapXValue : undefined
				);
				// --- End Track P20b ---
				if (!manaAbLegality.ok) return manaAbLegality;
			}

			// Phase 4: the ability's whole cost from the IR ({T}, and e.g. "Sacrifice this artifact").
			// --- Track P7 ---
			const cost = activatedAbilityCost(permEffCard, ab);
			// --- End Track P7 ---
			const rawTapMana = parseManaCost(ab.manaCost === '{0}' ? '' : ab.manaCost, tapXValue);
			const hybTapChoice = resolveHybridCostChoice(state, actor, action, rawTapMana, perm.card.name);
			if (hybTapChoice.promptResult) return hybTapChoice.promptResult;
			const ctx = costContext(state, actor, perm, tapXValue, false, hybTapChoice.resolvedReq);
			const plan = planCosts(ctx, cost.defs, action.costPayment);
			if (!plan.ok) return { ok: false, error: plan.error };
			if (plan.question) return askCostChoice(state, actor, action, plan.question, perm.card.name);
			// --- Track P20b ---
			const parts = serializeCostPlanParts(ctx, plan);
			const tapRemovedCounters = totalRemovedCountersFromSerializedParts(parts);
			// --- End Track P20b ---

			const baseAmount = Math.max(0, ab.producesAmount);
			const dynamicAmount = getDynamicManaProducedAmount(
				state,
				actor,
				perm,
				baseAmount,
				ab,
				tapXValue,
				// --- Track P20b ---
				tapRemovedCounters
				// --- End Track P20b ---
			);
			let chosenBundle: ManaColor[] | undefined;

			if ((ab.manaBundles && ab.manaBundles.length > 0) || ab.manaCombinationColors) {
				const combAllowed =
					ab.manaCombinationColors === 'any'
						? [...FIVE_MANA_COLORS]
						: (ab.manaCombinationColors ?? []);
				let candidateBundles: ManaColor[][] = [];
				if (ab.manaBundles && ab.manaBundles.length > 0) {
					candidateBundles = ab.manaBundles.map((b) => [...b]);
				} else if (dynamicAmount > 0 && combAllowed.length > 0) {
					candidateBundles =
						dynamicAmount <= 5
							? expandCombinationBundles(combAllowed, dynamicAmount)
							: combAllowed.map((c) => Array(dynamicAmount).fill(c) as ManaColor[]);
				}
				const canonicalBundleKey = (b: readonly ManaColor[]) => [...b].sort().join(',');
				if (candidateBundles.length === 0) {
					chosenColor = undefined;
				} else if (requestedBundle && requestedBundle.length > 0) {
					const reqKey = canonicalBundleKey(requestedBundle);
					const matched = candidateBundles.find((b) => canonicalBundleKey(b) === reqKey);
					if (matched) {
						chosenBundle = [...matched];
					} else if (
						ab.manaCombinationColors &&
						requestedBundle.length === dynamicAmount &&
						requestedBundle.every((c) => combAllowed.includes(c))
					) {
						chosenBundle = [...requestedBundle];
					} else {
						return { ok: false, error: 'Invalid mana combination choice.' };
					}
				} else if (candidateBundles.length === 1) {
					chosenBundle = [...candidateBundles[0]];
				} else if (
					preferred &&
					ab.manaCombinationColors &&
					combAllowed.includes(preferred) &&
					dynamicAmount > 0
				) {
					chosenBundle = Array(dynamicAmount).fill(preferred) as ManaColor[];
				} else if (actor.isBot) {
					chosenBundle = ab.manaCombinationColors
						? pickCombinationForRequirement(
								combAllowed,
								dynamicAmount,
								actor.manaPool,
								null,
								preferred,
								actor
							)
						: pickBestBundleForRequirement(candidateBundles, actor.manaPool, null, preferred);
				} else {
					const bestDefault = ab.manaCombinationColors
						? pickCombinationForRequirement(
								combAllowed,
								dynamicAmount,
								actor.manaPool,
								null,
								preferred,
								actor
							)
						: pickBestBundleForRequirement(candidateBundles, actor.manaPool, null, preferred);
					const bestKey = canonicalBundleKey(bestDefault);
					const defaultIdx = Math.max(
						0,
						candidateBundles.findIndex((b) => canonicalBundleKey(b) === bestKey)
					);
					enqueueChoicePrompt(state, {
						id: uid('prm', state),
						playerId: actor.playerId,
						kind: 'chooseMode',
						purpose: 'generic',
						title: `${perm.card.name} — Choose Mana Combination`,
						description: `Choose mana to add from ${perm.card.name}.`,
						cancellable: true,
						continuation: {
							kind: 'handler',
							name: TAP_MANA_BUNDLE_CHOICE_HANDLER,
							data: {
								instanceId: perm.instanceId,
								abilityId: ab.id,
								bundlesCsv: candidateBundles.map((b) => b.join(',')).join('|'),
								costPaymentJson: action.costPayment ? JSON.stringify(action.costPayment) : null,
								// --- Track P17b ---
								...(action.xValue !== undefined ? { xValue: tapXValue } : {})
								// --- End Track P17b ---
							}
						},
						choice: {
							kind: 'chooseMode',
							modes: candidateBundles.map((b) => formatManaBundle(b)),
							min: 1,
							max: 1,
							defaultIndices: [defaultIdx]
						}
					});
					return { ok: true };
				}
			} else if (!actor.isBot && !preferred && allowedColors.length > 1) {
				const defaultIdx = chosenColor ? Math.max(0, allowedColors.indexOf(chosenColor)) : 0;
				const reason = `Choose a color of mana to add from ${perm.card.name} (${allowedColors.join(', ')}).`;
				enqueueChoicePrompt(state, {
					id: uid('prm', state),
					playerId: actor.playerId,
					kind: 'chooseMode',
					purpose: 'generic',
					title: `${perm.card.name} — Choose Mana Color`,
					description: reason,
					cancellable: true,
					continuation: {
						kind: 'handler',
						name: TAP_MANA_COLOR_CHOICE_HANDLER,
						data: {
							instanceId: perm.instanceId,
							abilityId: ab.id,
							colorsCsv: allowedColors.join(','),
							costPaymentJson: action.costPayment ? JSON.stringify(action.costPayment) : null,
							// --- Track P17b ---
							...(action.xValue !== undefined ? { xValue: tapXValue } : {})
							// --- End Track P17b ---
						}
					},
					choice: {
						kind: 'chooseMode',
						modes: allowedColors,
						min: 1,
						max: 1,
						defaultIndices: [defaultIdx]
					}
				});
				return { ok: true };
			}

			if (chosenBundle && chosenBundle.length > 0) {
				chosenColor = chosenBundle[0];
			}
			const amount = chosenBundle
				? chosenBundle.length
				: chosenColor
					? dynamicAmount
					: 0;

			const pcp: PendingCostPayment = {
				kind: 'tap_mana',
				actorId,
				sourceInstanceId: perm.instanceId,
				sourceObjectVersion: perm.objectVersion,
				// --- Track P7 ---
				sourceCard: permEffCard,
				// --- End Track P7 ---
				abilityId: ab.id,
				...(ab.faceIndex !== undefined ? { faceIndex: ab.faceIndex } : {}),
				...(ab.grantSourceCard ? { grantSourceCard: ab.grantSourceCard } : {}),
				...(ab.grantFaceIndex !== undefined ? { grantFaceIndex: ab.grantFaceIndex } : {}),
				// --- Track P17b ---
				...(tapXValue > 0 ? { xValue: tapXValue } : {}),
				// --- End Track P17b ---
				chosenColor,
				...(chosenBundle ? { chosenBundle } : {}),
				...(ab.freezesSelfUntap ? { freezesSelfUntap: true } : {}),
				amount,
				...(ab.manaRestriction ? { manaRestriction: ab.manaRestriction } : {}),
				// --- Track P10 ---
				...(ab.manaRestrictionSpec ? { manaRestrictionSpec: ab.manaRestrictionSpec } : {}),
				...(ab.retainManaUntilEndOfTurn ? { retainManaUntilEndOfTurn: true } : {}),
				...(ab.grantedAbilityText ? { grantedAbilityText: ab.grantedAbilityText } : {}),
				// --- End Track P10 ---
				onceEachTurn: Boolean(ab.activationRestrictions?.includes('onceEachTurn')),
				...(ab.activationRestrictions?.includes('oncePerGame') ? { oncePerGame: true } : {}),
				sacrificeSelfInCost: cost.defs.some((d) => d.k === 'sacrifice' && d.filter === 'self'),
				parts,
				manaPaid: plan.mana,
				tapsAndManaDone: false,
				nextPartIndex: 0,
				nextObjectIndex: 0,
				descriptions: []
			};
			return executeOrResumePendingCostPayment(state, pcp, ctx);
		}

		case 'play_land': {
			let landInst: CardInstance | undefined;
			let sourcePlayer: PlayerGameState = actor;
			let sourceZone: 'hand' | 'exile' | 'library' | 'graveyard' = 'hand';

			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx >= 0 && (!action.fromZone || action.fromZone === 'hand')) {
				landInst = actor.hand[handIdx];
				sourcePlayer = actor;
				sourceZone = 'hand';
			} else if (!action.fromZone || action.fromZone === 'exile') {
				for (const p of state.players) {
					const exIdx = p.exile.findIndex(
						(c) =>
							c.instanceId === action.instanceId &&
							(c.playableFromExileBy?.playerId === actorId ||
								// --- Track P14 ---
								(c.ownerId === actorId &&
									getWave5SlottedLandPlayPermission(state, actorId, 'exile', c) !== null))
						// --- End Track P14 ---
					);
					if (exIdx >= 0) {
						landInst = p.exile[exIdx];
						sourcePlayer = p;
						sourceZone = 'exile';
						break;
					}
				}
			}
			// --- Track P8 ---
			if (
				!landInst &&
				(!action.fromZone || action.fromZone === 'library') &&
				actor.library[0]?.instanceId === action.instanceId
			) {
				landInst = actor.library[0];
				sourcePlayer = actor;
				sourceZone = 'library';
			}
			if (!landInst && (!action.fromZone || action.fromZone === 'graveyard')) {
				const gyIdx = actor.graveyard.findIndex((c) => c.instanceId === action.instanceId);
				if (gyIdx >= 0) {
					landInst = actor.graveyard[gyIdx];
					sourcePlayer = actor;
					sourceZone = 'graveyard';
				}
			}

			if (!landInst) {
				return { ok: false, error: 'Land card not found in your hand or playable Exile.' };
			}

			const landLegality = checkLandPlayLegality(
				state,
				actorId,
				landInst,
				sourceZone,
				action.faceIndex
			);
			if (!landLegality.ok) {
				return landLegality;
			}
			const resolvedFace = resolveLandPlayFaceIndex(
				effectiveCardForObject(landInst),
				landInst,
				sourceZone,
				action.faceIndex
			);
			if (!resolvedFace.ok) return resolvedFace;

			// --- Track P14 ---
			const wave5LandSlot =
				sourceZone === 'library' || sourceZone === 'graveyard' || sourceZone === 'exile'
					? getWave5SlottedLandPlayPermission(state, actorId, sourceZone, landInst)
					: null;
			const unlimitedZoneLandSrc =
				sourceZone === 'library' || sourceZone === 'graveyard'
					? getActiveZoneLandPlayPermissionSource(state, actorId, sourceZone, landInst)
					: null;
			// Only consume a turn-slot if an unlimited permission didn't already cover it.
			if (wave5LandSlot && !unlimitedZoneLandSrc && !landInst.playableFromExileBy) {
				consumeWave5StaticPlaySlot(actor, wave5LandSlot.slotKey);
			}
			// --- End Track P14 ---

			const exSourceName =
				sourceZone === 'exile'
					? (landInst.playableFromExileBy?.sourceName ?? wave5LandSlot?.sourceName)
					: sourceZone === 'library' || sourceZone === 'graveyard'
						? (unlimitedZoneLandSrc ?? wave5LandSlot?.sourceName ?? undefined)
						: undefined;
			landInst.playableFromExileBy = undefined;
			landInst.tapped = false;
			landInst.summoningSick = true;
			landInst.defaultControllerId = actorId;
			// --- Track P19b ---
			landInst.castFromZone = sourceZone;
			// --- End Track P19b ---
			if (cardHasSupportedMultiFace(effectiveCardForObject(landInst)) || resolvedFace.faceIndex !== 0) {
				landInst.activeFaceIndex = resolvedFace.faceIndex;
			}
			const playedFaceName = resolveObjectFaces(
				effectiveCardForObject(landInst),
				instanceFaceOptions(landInst, 'battlefield')
			).name;
			applySelfEtbReplacements(state, landInst);
			moveObject(state, landInst, 'battlefield', {
				from: { player: sourcePlayer, zone: sourceZone },
				toPlayer: actor,
				controllerId: actorId,
				newTimestamp: true,
				bumpVersion: true
			});
			actor.landsPlayedThisTurn += 1;
			state.passedPriorityPlayerIds = [];
			// --- Track P16b ---
			emitEvent(state, {
				kind: 'LandPlayed',
				playerId: actorId,
				objectId: landInst.instanceId,
				object: landInst,
				fromZone: sourceZone
			});
			// --- End Track P16b ---

			addLog(
				state,
				'rule',
				`${actor.username} played ${playedFaceName}${sourceZone === 'exile' ? ` from Exile (${exSourceName || 'Exile Permission'})` : sourceZone === 'library' ? ` from Top of Library (${exSourceName || 'Library Permission'})` : sourceZone === 'graveyard' ? ` from Graveyard (${exSourceName || 'Graveyard Permission'})` : ''}.`,
				actorId
			);

			resetTriggerLoopTracking(state);
			flushTriggers(state);

			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'turn_face_up': {
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm) {
				return { ok: false, error: 'Face-down permanent not found on your battlefield.' };
			}
			const xRaw = action.xValue ?? 0;
			const legality = checkTurnFaceUpLegality(state, actorId, perm, xRaw, action.costPayment);
			if (!legality.ok) {
				return legality;
			}
			const spec = perm.faceDownSpec!;
			const turnUpManaCost = spec.turnUpManaCost;
			const turnUpCostDefs = spec.turnUpCostDefs ?? [];
			const choosesX = hasXInTurnUpCost(turnUpManaCost, turnUpCostDefs);
			const effectiveX = choosesX ? Math.max(0, xRaw) : 0;
			const promptName = perm.faceDownLabel || 'Face-Down Permanent';
			const baseReq = resolveTurnUpManaRequirement(turnUpManaCost, effectiveX);
			let effectiveReq = baseReq;
			if (effectiveReq) {
				const phyChoice = maybeAskPhyrexianCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName
				);
				if (phyChoice) return phyChoice;
				const hybChoice = resolveHybridCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName
				);
				if (hybChoice.promptResult) return hybChoice.promptResult;
				effectiveReq = hybChoice.resolvedReq;
			}
			if (turnUpCostDefs.length > 0) {
				const ctx = costContext(
					state,
					actor,
					perm,
					effectiveX,
					false,
					effectiveReq,
					action.costPayment?.phyrexianLifeCount
				);
				const plan = planCosts(ctx, turnUpCostDefs, action.costPayment);
				if (!plan.ok) return { ok: false, error: plan.error };
				if (plan.question) return askCostChoice(state, actor, action, plan.question, promptName);
				const parts = serializeCostPlanParts(ctx, plan);
				const pcp: PendingCostPayment = {
					kind: 'turn_face_up',
					actorId,
					sourceInstanceId: perm.instanceId,
					xValue: effectiveX,
					sourceCard: perm.card,
					parts,
					manaPaid: plan.mana,
					tapsAndManaDone: false,
					nextPartIndex: 0,
					nextObjectIndex: 0,
					descriptions: []
				};
				return executeOrResumePendingCostPayment(state, pcp, ctx);
			}
			if (
				effectiveReq &&
				!payManaWithAutoTap(
					actor,
					effectiveReq,
					state,
					action.costPayment?.phyrexianLifeCount
				)
			) {
				return {
					ok: false,
					error: `Insufficient mana to turn ${promptName} face up (requires ${turnUpManaCost || '{0}'}).`
				};
			}
			completeTurnFaceUp(
				state,
				actor,
				perm,
				effectiveX,
				turnUpManaCost ? [turnUpManaCost] : []
			);
			return { ok: true };
		}

		case 'unlock_room_door': {
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm) {
				return { ok: false, error: 'Room permanent not found on your battlefield.' };
			}
			const legality = checkUnlockRoomDoorLegality(state, actorId, perm, action.faceIndex);
			if (!legality.ok) {
				return legality;
			}
			const effectiveCard = effectiveCardForObject(perm);
			const faceDef = compileCard(effectiveCard).faces[action.faceIndex];
			if (!faceDef) {
				return { ok: false, error: 'Invalid Room door face index.' };
			}
			const unlockReq = parseManaCost(faceDef.characteristics.manaCost);
			const phyUnlockChoice = maybeAskPhyrexianCostChoice(
				state,
				actor,
				action,
				unlockReq,
				faceDef.name
			);
			if (phyUnlockChoice) return phyUnlockChoice;
			const hybUnlockChoice = resolveHybridCostChoice(
				state,
				actor,
				action,
				unlockReq,
				faceDef.name
			);
			if (hybUnlockChoice.promptResult) return hybUnlockChoice.promptResult;
			if (
				!payManaWithAutoTap(
					actor,
					hybUnlockChoice.resolvedReq,
					state,
					action.costPayment?.phyrexianLifeCount
				)
			) {
				return {
					ok: false,
					error: `Insufficient mana to unlock ${faceDef.name} (requires ${faceDef.characteristics.manaCost}).`
				};
			}
			perm.unlockedFaces = Array.from(new Set([...(perm.unlockedFaces ?? []), action.faceIndex])).sort(
				(a, b) => a - b
			);
			noteLayerInputsChanged(state);
			state.passedPriorityPlayerIds = [];
			addLog(
				state,
				'rule',
				`${actor.username} unlocked ${faceDef.name} on ${perm.card.name} (CR 709.5e).`,
				actorId
			);
			// --- Track P13 & P15: Emit DoorUnlocked (CR 709.5h) & RoomFullyUnlocked (CR 709.5i) ---
			emitEvent(state, {
				kind: 'DoorUnlocked',
				playerId: actorId,
				objectId: perm.instanceId,
				object: perm,
				faceIndex: action.faceIndex
			});
			const totalRoomDoors = compileCard(effectiveCardForObject(perm)).faces.filter((f) =>
				f.characteristics.subtypes.includes('Room')
			).length;
			if (totalRoomDoors >= 2 && (perm.unlockedFaces?.length ?? 0) >= totalRoomDoors) {
				emitEvent(state, {
					kind: 'RoomFullyUnlocked',
					playerId: actorId,
					objectId: perm.instanceId,
					object: perm
				});
			}
			// --- End Track P13 & P15 ---
			resetTriggerLoopTracking(state);
			flushTriggers(state);
			checkStateBasedActions(state);
			return { ok: true };
		}

		// --- Track P15: Preparation spell copy cast action (CR 723.3c) ---
		case 'cast_preparation_copy': {
			return applyGameAction(state, actorId, {
				type: 'cast_spell',
				instanceId: action.instanceId,
				fromZone: 'battlefield',
				optionId: 'battlefield:prepare_copy',
				faceIndex: 1,
				targets: action.targets,
				xValue: action.xValue,
				modes: action.modes,
				costPayment: action.costPayment,
				targetDivisions: action.targetDivisions
			});
		}
		// --- End Track P15 ---

		case 'suspend_card': {
			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx < 0) {
				return { ok: false, error: 'Card not found in your hand to Suspend.' };
			}
			const inst = actor.hand[handIdx];
			const legality = checkSuspendLegality(state, actorId, inst, action.xValue);
			if (!legality.ok) {
				return legality;
			}
			const suspInfo = legality.suspendInfo!;
			const req = parseManaCost(suspInfo.cost);
			if (!payManaWithAutoTap(actor, req, state)) {
				return {
					ok: false,
					error: `Insufficient mana to pay Suspend cost ${suspInfo.cost} for ${inst.card.name}.`
				};
			}

			inst.isSuspended = true;
			inst.counters = createEmptyCounters();
			inst.counters.time = suspInfo.timeCounters;
			moveObject(state, inst, 'exile', {
				from: { player: actor, zone: 'hand' },
				toPlayer: actor,
				newTimestamp: true,
				bumpVersion: true
			});
			state.passedPriorityPlayerIds = [];

			addLog(
				state,
				'rule',
				`Suspend (CR 702.62): ${actor.username} exiled ${inst.card.name} from hand with ${suspInfo.timeCounters} time counter(s) for ${suspInfo.cost}.`,
				actorId
			);
			emitVfx(state, {
				kind: 'exile',
				sourceId: actorId,
				targetId: inst.instanceId,
				label: `Suspended (${suspInfo.timeCounters} ⏳)`
			});
			resetTriggerLoopTracking(state);
			checkStateBasedActions(state);
			return { ok: true };
		}

		// --- Track P18b: Companion `{3}` special action (CR 116.2g / CR 702.139a) ---
		case 'companion_to_hand': {
			const legality = checkCompanionSpecialActionLegality(state, actorId);
			if (!legality.ok) {
				return { ok: false, error: legality.reason ?? 'Cannot use Companion right now.' };
			}
			const companionCard = actor.companion!;
			const req = parseManaCost('{3}');
			if (!payManaWithAutoTap(actor, req, state, undefined, { isSpell: false })) {
				return {
					ok: false,
					error: `Insufficient mana to pay {3} to put ${companionCard.name} into your hand (CR 116.2g).`
				};
			}
			actor.companionMovedToHand = true;
			putCompanionIntoHand(state, actor, companionCard);
			state.passedPriorityPlayerIds = [];
			addLog(
				state,
				'rule',
				`Companion (CR 702.139a): ${actor.username} paid {3} and put ${companionCard.name} into their hand from outside the game.`,
				actorId
			);
			resetTriggerLoopTracking(state);
			flushTriggers(state);
			checkStateBasedActions(state);
			return { ok: true };
		}
		// --- End Track P18b ---

		case 'hand_special_action': {
			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx < 0) {
				return { ok: false, error: 'Card not found in your hand.' };
			}
			const inst = actor.hand[handIdx];
			const legality = checkHandSpecialActionLegality(
				state,
				actorId,
				inst,
				action.actionId,
				action.costPayment
			);
			if (!legality.ok) {
				return legality;
			}
			// --- Track P22a ---
			const actionOpt = getHandSpecialActions(state, actorId, inst).find(
				(o) => o.id === action.actionId
			)!;
			// --- End Track P22a ---
			const topManaStr = actionOpt.costDefs
				.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana')
				.map((d) => d.cost)
				.join('');
			const nonManaDefs = actionOpt.costDefs.filter((d) => d.k !== 'mana');
			const promptName =
				actionOpt.id === 'special:foretell' ? 'Foretell' : `${inst.card.name} (${actionOpt.label})`;
			// --- Track P10 ---
			const specialSpendCtx: ManaSpendContext = {
				isSpell: false,
				...(actionOpt.id === 'special:foretell' ? { isForetellAction: true } : {})
			};
			// --- End Track P10 ---
			let effectiveReq = topManaStr ? parseManaCost(topManaStr) : null;
			if (effectiveReq) {
				const phyChoice = maybeAskPhyrexianCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName
				);
				if (phyChoice) return phyChoice;
				const hybChoice = resolveHybridCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName,
					specialSpendCtx
				);
				if (hybChoice.promptResult) return hybChoice.promptResult;
				effectiveReq = hybChoice.resolvedReq;
			}
			if (nonManaDefs.length > 0) {
				const reservedSelf = new Set<string>([inst.instanceId]);
				const ctx = costContext(
					state,
					actor,
					inst,
					0,
					false,
					effectiveReq,
					action.costPayment?.phyrexianLifeCount,
					specialSpendCtx,
					reservedSelf
				);
				const plan = planCosts(ctx, nonManaDefs, action.costPayment);
				if (!plan.ok) return { ok: false, error: plan.error };
				if (plan.question) return askCostChoice(state, actor, action, plan.question, promptName);
				const parts = serializeCostPlanParts(ctx, plan);
				const pcp: PendingCostPayment = {
					kind: 'hand_special_action',
					actorId,
					sourceInstanceId: inst.instanceId,
					specialActionId: actionOpt.id,
					sourceCard: inst.card,
					parts,
					manaPaid: plan.mana,
					tapsAndManaDone: false,
					nextPartIndex: 0,
					nextObjectIndex: 0,
					descriptions: []
				};
				return executeOrResumePendingCostPayment(state, pcp, ctx);
			}
			if (
				effectiveReq &&
				!payManaWithAutoTap(
					actor,
					effectiveReq,
					state,
					action.costPayment?.phyrexianLifeCount,
					specialSpendCtx
				)
			) {
				return {
					ok: false,
					error: `Insufficient mana to pay ${actionOpt.label} (${actionOpt.costDisplay}).`
				};
			}
			completeHandSpecialAction(state, actor, inst, actionOpt.id, []);
			return { ok: true };
		}

		case 'reorder_graveyard': {
			if (!Array.isArray(action.instanceIds)) {
				return { ok: false, error: 'Invalid graveyard order list.' };
			}
			if (action.instanceIds.length !== actor.graveyard.length) {
				return {
					ok: false,
					error: 'Graveyard reorder must include all cards currently in your graveyard.'
				};
			}
			const byId = new Map(actor.graveyard.map((c) => [c.instanceId, c]));
			const reordered: CardInstance[] = [];
			for (const id of action.instanceIds) {
				const found = byId.get(id);
				if (!found) {
					return { ok: false, error: `Card ${id} is not in your graveyard.` };
				}
				byId.delete(id);
				reordered.push(found);
			}
			setZoneOrder(actor, 'graveyard', reordered);
			const topCard = actor.graveyard[actor.graveyard.length - 1];
			addLog(
				state,
				'rule',
				`Graveyard Order (CR 404.2): ${actor.username} ordered their graveyard${topCard ? ` (${topCard.card.name} on top)` : ''}.`,
				actorId
			);
			return { ok: true };
		}

		case 'choice': {
			return { ok: false, error: 'That choice is no longer pending.' };
		}

		case 'cast_spell': {
			if (priorityPlayer.playerId !== actorId && !isCastWhileSearchingLibrary) {
				return { ok: false, error: 'You do not currently hold priority.' };
			}

			// Locate card in hand, command zone, graveyard, playable exile, or top of library
			let inst: CardInstance | undefined;
			let sourcePlayer: PlayerGameState = actor;
			let sourceZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library' | 'battlefield' = 'hand';

			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx >= 0 && (!action.fromZone || action.fromZone === 'hand')) {
				inst = actor.hand[handIdx];
				sourceZone = 'hand';
			} else {
				const cmdIdx = actor.command.findIndex((c) => c.instanceId === action.instanceId);
				if (cmdIdx >= 0 && (!action.fromZone || action.fromZone === 'command')) {
					inst = actor.command[cmdIdx];
					sourceZone = 'command';
				} else {
					const gyIdx = actor.graveyard.findIndex((c) => c.instanceId === action.instanceId);
					if (gyIdx >= 0 && (!action.fromZone || action.fromZone === 'graveyard')) {
						inst = actor.graveyard[gyIdx];
						sourceZone = 'graveyard';
					} else if (!action.fromZone || action.fromZone === 'graveyard') {
						// --- Track P13: Foreign graveyard cast permission ---
						for (const p of state.players) {
							const fGyIdx = p.graveyard.findIndex(
								(c) =>
									c.instanceId === action.instanceId &&
									c.playableFromGraveyardBy?.playerId === actorId
							);
							if (fGyIdx >= 0) {
								inst = p.graveyard[fGyIdx];
								sourcePlayer = p;
								sourceZone = 'graveyard';
								break;
							}
						}
						// --- End Track P13 ---
					}
					if (!inst && (!action.fromZone || action.fromZone === 'exile')) {
						for (const p of state.players) {
							const exIdx = p.exile.findIndex(
								(c) =>
									c.instanceId === action.instanceId &&
									(c.playableFromExileBy?.playerId === actorId ||
										// --- Track P13 ---
										c.airbentCastPermission?.playerId === actorId ||
										// --- End Track P13 ---
										hasExileKeywordPermission(c, actorId) ||
										// --- Track P14 ---
										hasWave5ExilePlayPermission(state, actorId, c))
								// --- End Track P14 ---
							);
							if (exIdx >= 0) {
								inst = p.exile[exIdx];
								sourcePlayer = p;
								sourceZone = 'exile';
								break;
							}
						}
					}
				}
			}
			// --- Track P8 ---
			if (
				!inst &&
				(!action.fromZone || action.fromZone === 'library') &&
				actor.library[0]?.instanceId === action.instanceId
			) {
				inst = actor.library[0];
				sourcePlayer = actor;
				sourceZone = 'library';
			}
			// --- Track P21 (CR 601.3e): Any library card with `castFromLibraryWhileSearching` while searching ---
			if (!inst && (!action.fromZone || action.fromZone === 'library')) {
				const whileSearchingCard = findCastWhileSearchingLibraryCard(
					state,
					actor,
					action.instanceId
				);
				if (whileSearchingCard) {
					inst = whileSearchingCard;
					sourcePlayer = actor;
					sourceZone = 'library';
				}
			}
			// --- End Track P21 ---
			// --- Track P15: Preparation spell copy cast from battlefield (CR 723.3c) ---
			if (
				!inst &&
				action.fromZone === 'battlefield'
			) {
				const bfPrep = actor.battlefield.find(
					(c) => !c.phasedOut && c.instanceId === action.instanceId
				);
				if (bfPrep) {
					inst = bfPrep;
					sourcePlayer = actor;
					sourceZone = 'battlefield';
				}
			}
			// --- End Track P15 ---

			if (!inst) {
				return {
					ok: false,
					error: 'Card not found in your Hand, Command Zone, Graveyard, or playable Exile.'
				};
			}

			const resolvedOpt = resolveCastOptionForAction(
				state,
				actorId,
				inst,
				sourceZone,
				action.optionId,
				action.faceIndex,
				action.fused
			);
			if (!resolvedOpt.ok) {
				return resolvedOpt;
			}
			const castOption = resolvedOpt.option;
			const optCountsValidation = validateOptionalCostCounts(castOption, action.optionalCostCounts);
			if (!optCountsValidation.ok) {
				return { ok: false, error: optCountsValidation.error };
			}
			const normalizedOptCounts = optCountsValidation.normalized;
			const hasOptCounts = Object.keys(normalizedOptCounts).length > 0;
			const { manaCosts: extraManaCosts, nonManaDefs: extraNonManaDefs } = expandOptionalAdditionalCosts(
				castOption,
				normalizedOptCounts
			);
			const castChoosesX =
				castOption.choosesX ||
				extraManaCosts.some((c) => /\{X\}/i.test(c)) ||
				JSON.stringify(extraNonManaDefs).includes('"k":"x"') ||
				// --- Track P14 ---
				extraNonManaDefs.some((d) => d.k === 'waterbend' && /\{X\}/i.test(d.cost));
			// --- End Track P14 ---
			const rawXVal = action.xValue || 0;
			const xVal = castChoosesX ? rawXVal : 0;
			const legality = checkSpellCastLegality(
				state,
				actorId,
				inst,
				sourceZone,
				xVal,
				castOption.id,
				hasOptCounts ? normalizedOptCounts : undefined,
				undefined,
				undefined,
				action.costAidIds,
				action.costAidColorChoices,
				true
			);
			if (!legality.ok) {
				return legality;
			}

			const spellTargetInfo = getSpellTargetRequirement(
				inst.card,
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const targets = action.targets || [];
			const optFaceIdx = castOption.faceIndex ?? 0;
			const optFused = Boolean(castOption.fused);
			// --- Track P15: Cleave / Gift-promised modal lookup ---
			const isOptCleaved = Boolean(castOption.spellMods?.cleaved);
			const isOptGiftPromised = Boolean(
				castOption.spellMods?.giftPromised || (normalizedOptCounts['opt:gift'] ?? 0) > 0
			);
			const compiledModal = castOption.spellMods?.castFaceDown
				? undefined
				: compileOptionSpellEffects(
						inst.card,
						optFaceIdx,
						optFused,
						isOptCleaved,
						isOptGiftPromised
					)?.modal;
			// --- End Track P15 ---
			const activeSpec = (sp: TargetSpec) =>
				!sp.condition || isCastConditionMet(sp.condition, inst.card, normalizedOptCounts, castOption);
			const chooseAllModes = hasChooseAllModesOptionalCost(
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			let chosenModes = action.modes ?? (action as { chosenModes?: number[] }).chosenModes;
			let targetsBySpec: TargetRef[][] | undefined;
			if (compiledModal) {
				// --- Track P18b: Defer mode selection when an opponent chooses ("An opponent chooses one —", CR 700.2e) ---
				if (compiledModal.opponentChooses && !chosenModes && targets.length === 0 && !chooseAllModes) {
					const oppCheck = validateDeferredOpponentModalChoice(
						state,
						actorId,
						inst.card,
						inst,
						compiledModal,
						activeSpec
					);
					if (!oppCheck.ok) return oppCheck;
					targetsBySpec = [];
				} else {
					// --- End Track P18b ---
					const modalVal = validateModalChoice(
						state,
						actorId,
						inst.card,
						inst,
						compiledModal,
						chosenModes,
						targets,
						activeSpec,
						undefined,
						chooseAllModes,
						// --- Track P18b ---
						xVal,
						// --- End Track P18b ---
						// --- Track P22c ---
						(c) =>
							(c.k === 'p20bCondition' &&
								c.kind === 'additionalCostPaid' &&
								wasAnyAdditionalCostPaidP20b(
									castOption.mandatoryAdditionalCosts,
									action.costPayment,
									hasOptCounts ? normalizedOptCounts : undefined
								)) ||
							isCastConditionMet(
								c,
								inst.card,
								hasOptCounts ? normalizedOptCounts : undefined,
								castOption
							) ||
							evaluateCondition(c, {
								state,
								controllerId: actorId,
								source: inst,
								xValue: xVal
							})
						// --- End Track P22c ---
					);
					if (!modalVal.ok) return modalVal;
					chosenModes = modalVal.chosenModes;
					targetsBySpec = modalVal.targetsBySpec;
					// --- Track P18b ---
				}
				// --- End Track P18b ---
			} else {
				const targetValidation = validateChosenTargets(
					state,
					actorId,
					targets,
					spellTargetInfo,
					inst.card,
					inst.instanceId,
					xVal,
					castOption
				);
				if (!targetValidation.ok) {
					return targetValidation;
				}
				if (!optionTargetsBecomeEach(inst.card, castOption)) {
					targetsBySpec = partitionTargetsBySpecs(
						targets,
						spellTargetInfo,
						inst.card,
						state,
						actorId,
						inst.instanceId
					);
				}
			}
			// --- Track P7 ---
			let spellTargetDivisions: Record<string, number> | undefined;
			if (!optionTargetsBecomeEach(inst.card, castOption)) {
				const activeSpellSpecs = compiledModal
					? (chosenModes ?? []).flatMap((mIdx) =>
							(compiledModal.modes[mIdx]?.targets ?? []).filter(activeSpec)
						)
					: spellTargetInfo.targetSpecs?.filter((sp) => sp.max > 0);
				const divRes = resolveTargetDivisionsForSpecs(
					state,
					actorId,
					activeSpellSpecs,
					targets,
					targetsBySpec,
					inst.card,
					inst.instanceId,
					xVal,
					action.targetDivisions
				);
				if (!divRes.ok) return divRes;
				spellTargetDivisions = divRes.targetDivisions;
			}
			// --- End Track P7 ---

			// Check & pay mana cost (including Commander Tax if from Command Zone, or any-color mana if exiled with Opposition Agent!)
			// --- Track P12: Spree / Tiered / Escalate modal per-mode costs ---
			const modalExtraCosts = computeModalModeAdditionalCosts(
				inst.card,
				optFaceIdx,
				compiledModal,
				chosenModes
			);
			const isFaceDownCast = Boolean(castOption.spellMods?.castFaceDown);
			// --- Track P20b ---
			const cmdLifeTax =
				sourceZone === 'command' && !isFaceDownCast
					? getCommanderTaxLifeCostP20b(state, actor, inst, optFaceIdx, optFused, undefined)
					: { applies: false, totalLife: 0 };
			const cmdLifeTaxDefs =
				cmdLifeTax.applies && cmdLifeTax.totalLife > 0
					? [{ k: 'payLife' as const, amount: { k: 'const' as const, n: cmdLifeTax.totalLife } }]
					: [];
			const prePitchDefs = [
				...(castOption.baseCost.kind === 'alternative' ? (castOption.baseCost.costDefs ?? []) : []),
				...(castOption.mandatoryAdditionalCosts ?? []),
				...extraNonManaDefs,
				...modalExtraCosts.costDefs,
				...cmdLifeTaxDefs
			];
			const usesPitchCostRed =
				!isFaceDownCast && cardUsesP20bCostPaidCount(inst, optFaceIdx, optFused);
			const hasExplicitPitchAnswer = isPitchPaymentSettledP20b(prePitchDefs, action.costPayment);
			const p20bPitchCounts = usesPitchCostRed
				? hasExplicitPitchAnswer
					? computeP20bPitchCountsFromPayment(prePitchDefs, action.costPayment)
					: computeMaxAvailableP20bPitchCounts(
							state,
							actor,
							inst,
							prePitchDefs,
							matchesObjectFilter
						)
				: undefined;
			// --- End Track P20b ---
			const costReq = getSpellCostRequirementForOption(
				actor,
				inst,
				state,
				xVal,
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined,
				// --- Track P12 + P11 ---
				chosenModes,
				targets,
				// --- End Track P12 + P11 ---
				// --- Track P20b ---
				p20bPitchCounts
				// --- End Track P20b ---
			);
			// --- End Track P12 ---
			const spendCtx = spellSpendContext(inst, {
				faceIndex: optFaceIdx,
				fused: optFused,
				isFaceDown: isFaceDownCast,
				// --- Track P20b ---
				state,
				xValue: xVal,
				manaCostOverride:
					castOption.baseCost.kind === 'alternative' ? castOption.baseCost.manaCost : undefined
				// --- End Track P20b ---
			});
			const spellPromptName = isFaceDownCast ? 'Face-Down Spell' : inst.card.name;
			const baseManaDisplay =
				castOption.baseCost.kind === 'alternative'
					? (castOption.baseCost.manaCost ?? '')
					: castOption.baseCost.kind === 'free'
						? ''
						: resolveObjectFaces(effectiveCardForObject(inst), {
								zone: 'stack',
								faceIndex: optFaceIdx,
								fused: optFused
							}).manaCost;
			const displayedManaCost =
				`${baseManaDisplay}${extraManaCosts.join('')}` || (castOption.baseCost.kind === 'free' ? '{0}' : '');
			const manaError = `Insufficient mana to cast ${spellPromptName} (requires ${displayedManaCost || '{0}'}${sourceZone === 'command' && inst.commanderCastCount > 0 ? ` + {${inst.commanderCastCount * state.rules.commanderTaxIncrement}} Commander Tax` : ''}).`;
			const canPayCandidateWithAids = (candidateReq: ManaCostRequirement): boolean => {
				if (action.costAidIds && Object.keys(action.costAidIds).length > 0) {
					const r = applyCastCostAids(
						candidateReq,
						castOption,
						action.costAidIds,
						action.costAidColorChoices
					);
					if (!r.ok) return false;
					// --- Track P15: Verify Assist player can pay their generic mana share ---
					if (r.assistPlayerId && (r.assistGenericPaid ?? 0) > 0) {
						const assistPl = state.players.find(
							(p) => p.playerId === r.assistPlayerId && !p.lost
						);
						if (
							!assistPl ||
							!canPayOrAutoTap(assistPl, parseManaCost(`{${r.assistGenericPaid}}`), state)
						) {
							return false;
						}
					}
					// --- End Track P15 ---
					const res = new Set<string>([...r.tapIds, ...r.exileIds]);
					return canPayOrAutoTap(
						actor,
						r.remainingReq,
						state,
						action.costPayment?.phyrexianLifeCount,
						spendCtx,
						res
					);
				}
				return canPayManaWithPaymentAids(
					state,
					actor,
					castOption,
					candidateReq,
					spendCtx,
					action.costPayment?.phyrexianLifeCount
				).ok;
			};
			const phySpellChoice = maybeAskPhyrexianCostChoice(
				state,
				actor,
				action,
				costReq,
				spellPromptName,
				spendCtx,
				castOption.paymentAids?.length ? canPayCandidateWithAids : undefined
			);
			if (phySpellChoice) return phySpellChoice;
			const hybSpellChoice = resolveHybridCostChoice(
				state,
				actor,
				action,
				costReq,
				spellPromptName,
				spendCtx,
				castOption.paymentAids?.length ? canPayCandidateWithAids : undefined
			);
			if (hybSpellChoice.promptResult) return hybSpellChoice.promptResult;
			const effectiveCostReq = hybSpellChoice.resolvedReq;

			const aidResult = applyCastCostAids(
				effectiveCostReq,
				castOption,
				action.costAidIds,
				action.costAidColorChoices
			);
			if (!aidResult.ok) {
				return { ok: false, error: aidResult.error };
			}
			let remainingCostReq = aidResult.remainingReq;
			const aidTapIds = aidResult.tapIds;
			const aidExileIds = aidResult.exileIds;
			const reservedAidIds = new Set<string>([...aidTapIds, ...aidExileIds]);
			// --- Track P15: Assist player verification (CR 702.132a) ---
			const assistPlayerObj =
				aidResult.assistPlayerId && (aidResult.assistGenericPaid ?? 0) > 0
					? state.players.find((p) => p.playerId === aidResult.assistPlayerId && !p.lost)
					: undefined;
			if (aidResult.assistPlayerId && (aidResult.assistGenericPaid ?? 0) > 0) {
				if (
					!assistPlayerObj ||
					!canPayOrAutoTap(
						assistPlayerObj,
						parseManaCost(`{${aidResult.assistGenericPaid}}`),
						state
					)
				) {
					return {
						ok: false,
						error: 'Assisting player has insufficient mana to pay generic mana for Assist.'
					};
				}
			}
			// --- End Track P15 ---
			// --- Track P12: Emerge (CR 702.119a) & Harmonize (CR 702.180a) cost payment ---
			const emergeSacParts: SerializedPlannedCost[] = [];
			if (castOption.id === 'alt:emerge') {
				const allExtraMana = [...extraManaCosts, ...modalExtraCosts.manaCosts];
				const payableEmerge = findPayableEmergeCandidates(
					state,
					actor,
					inst,
					castOption,
					xVal,
					allExtraMana,
					matchesObjectFilter
				);
				if (payableEmerge.length === 0) {
					return { ok: false, error: manaError };
				}
				const explicitId = action.costPayment?.objects?.[0]?.[0];
				let chosenEmerge = explicitId
					? payableEmerge.find((e) => e.perm.instanceId === explicitId)
					: undefined;
				if (!chosenEmerge) {
					if (payableEmerge.length === 1 || actor.isBot) {
						chosenEmerge = [...payableEmerge].sort(
							(a, b) => a.req.generic - b.req.generic
						)[0];
					} else {
						return askCostChoice(
							state,
							actor,
							action,
							{
								kind: 'objects',
								index: 0,
								count: 1,
								label: 'Sacrifice a permanent for Emerge',
								candidateIds: payableEmerge.map((e) => e.perm.instanceId)
							},
							spellPromptName
						);
					}
				}
				remainingCostReq = chosenEmerge.req;
				reservedAidIds.add(chosenEmerge.perm.instanceId);
				emergeSacParts.push({
					def: {
						k: 'sacrifice',
						count: { k: 'const', n: 1 },
						filter: { types: ['Permanent'] }
					},
					objectIds: [chosenEmerge.perm.instanceId],
					objectNames: [chosenEmerge.perm.card.name]
				});
			} else if (castOption.id === 'graveyard:harmonize') {
				const allExtraMana = [...extraManaCosts, ...modalExtraCosts.manaCosts];
				const harmOpts = findPayableHarmonizeOptions(
					state,
					actor,
					inst,
					castOption,
					xVal,
					allExtraMana
				);
				const explicitTapIds = action.costAidIds?.['harmonize'];
				if (explicitTapIds && explicitTapIds.length > 0) {
					const chosenTap = harmOpts.tapCandidates.find(
						(c) => c.perm.instanceId === explicitTapIds[0]
					);
					if (!chosenTap) {
						return { ok: false, error: 'Selected creature cannot be tapped to pay Harmonize.' };
					}
					remainingCostReq = chosenTap.req;
					aidTapIds.push(chosenTap.perm.instanceId);
					reservedAidIds.add(chosenTap.perm.instanceId);
				} else if (harmOpts.noTapReq !== null && (!explicitTapIds || explicitTapIds.length === 0)) {
					remainingCostReq = harmOpts.noTapReq;
				} else if (harmOpts.tapCandidates.length > 0) {
					const chosenTap = harmOpts.tapCandidates[0];
					remainingCostReq = chosenTap.req;
					aidTapIds.push(chosenTap.perm.instanceId);
					reservedAidIds.add(chosenTap.perm.instanceId);
				} else {
					return { ok: false, error: manaError };
				}
			// --- Track P18b: Offering (`CR 702.48a–c`) sacrifice & mana cost reduction ---
			} else if (castOption.id === 'alt:offering') {
				const payableOffering = findPayableOfferingCandidates(
					state,
					actor,
					inst,
					castOption,
					remainingCostReq,
					matchesObjectFilter,
					(candReq, resIds) =>
						canPayOrAutoTap(
							actor,
							candReq,
							state,
							action.costPayment?.phyrexianLifeCount,
							spendCtx,
							new Set<string>([...reservedAidIds, ...resIds])
						)
				);
				if (payableOffering.length === 0) {
					return { ok: false, error: manaError };
				}
				const explicitId = action.costPayment?.objects?.[0]?.[0];
				let chosenOff = explicitId
					? payableOffering.find((e) => e.perm.instanceId === explicitId)
					: undefined;
				if (!chosenOff) {
					if (payableOffering.length === 1 || actor.isBot) {
						chosenOff = [...payableOffering].sort(
							(a, b) => a.req.totalCmc - b.req.totalCmc || a.req.generic - b.req.generic
						)[0];
					} else {
						return askCostChoice(
							state,
							actor,
							action,
							{
								kind: 'objects',
								index: 0,
								count: 1,
								label: `Sacrifice a ${castOption.offeringQuality ?? 'permanent'} for Offering`,
								candidateIds: payableOffering.map((e) => e.perm.instanceId)
							},
							spellPromptName
						);
					}
				}
				remainingCostReq = chosenOff.req;
				reservedAidIds.add(chosenOff.perm.instanceId);
				emergeSacParts.push({
					def: {
						k: 'sacrifice',
						count: { k: 'const', n: 1 },
						filter: chosenOff.filter
					},
					objectIds: [chosenOff.perm.instanceId],
					objectNames: [chosenOff.perm.card.name]
				});
			// --- End Track P18b ---
			}
			// --- End Track P12 ---
			const tapAidParts: SerializedPlannedCost[] =
				aidTapIds.length > 0
					? [
							{
								def: {
									k: 'tapOthers',
									count: { k: 'const', n: aidTapIds.length },
									filter: { types: ['Creature'] }
								},
								objectIds: aidTapIds,
								objectNames: aidTapIds.map(
									(id) => actor.battlefield.find((c) => c.instanceId === id)?.card.name ?? id
								),
								isCostAid: true
							}
						]
					: [];
			const exileAidParts: SerializedPlannedCost[] =
				aidExileIds.length > 0
					? [
							{
								def: {
									k: 'exileFrom',
									zone: 'graveyard',
									count: { k: 'const', n: aidExileIds.length }
								},
								objectIds: aidExileIds,
								objectNames: aidExileIds.map(
									(id) => actor.graveyard.find((c) => c.instanceId === id)?.card.name ?? id
								),
								isCostAid: true
							}
						]
					: [];

			// Phase 4: additional costs (plus any non-mana alternative costDefs and optional additional costs)
			// from the IR, paid together with the mana (nothing is paid unless everything can be).
			const additional = isFaceDownCast ? null : spellAdditionalCost(inst.card, optFaceIdx, optFused);
			const altCostDefs =
				castOption.baseCost.kind === 'alternative' ? (castOption.baseCost.costDefs ?? []) : [];
			const combinedCostDefs = [
				...altCostDefs,
				...(castOption.mandatoryAdditionalCosts ?? []),
				...extraNonManaDefs,
				// --- Track P12: Spree / Tiered / Escalate non-mana per-mode costs ---
				...modalExtraCosts.costDefs,
				// --- End Track P12 ---
				// --- Track P20b ---
				...cmdLifeTaxDefs,
				// --- End Track P20b ---
				// --- Track P17b: Per-target spell life costs (e.g. Phyrexian Purge) ---
				...(isFaceDownCast
					? []
					: collectSpellPerTargetLifeCostsWave6(
							inst,
							optFaceIdx,
							optFused,
							targets,
							costModifiersOf
						))
				// --- End Track P17b ---
			];
			for (const p of state.players) {
				if (p.lost) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (!targets.some((t) => t.id === perm.instanceId)) continue;
					if (!evaluatePermanent(state, perm).losesAllAbilities) {
						const pCard = perm.copiableCard ?? perm.card;
						const abilities = activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'));
						for (const ab of abilities) {
							if (ab.kind !== 'static' || ab.static.k !== 'costModifier') continue;
							const mod = ab.static;
							if (mod.affects.k !== 'spell' || !mod.affects.filter.targetsSelf) continue;
							if (!matchesPlayerFilter(mod.who, perm.controllerId, actor.playerId, state)) continue;
							if (mod.delta.additionalCosts) {
								combinedCostDefs.push(...mod.delta.additionalCosts);
							}
						}
					}
					// --- Track P11: Layer 6 granted costModifier additionalCosts ---
					if (boardMayGrantStaticAbility(state, 'costModifier')) {
						for (const mod of collectActiveGrantedStaticDefs(state, perm)) {
							if (mod.k !== 'costModifier') continue;
							if (mod.affects.k !== 'spell' || !mod.affects.filter.targetsSelf) continue;
							if (!matchesPlayerFilter(mod.who, perm.controllerId, actor.playerId, state)) continue;
							if (mod.delta.additionalCosts) {
								combinedCostDefs.push(...mod.delta.additionalCosts);
							}
						}
					}
					// --- End Track P11 ---
				}
			}
			const paidReturnToHand = hasReturnToHandOptionalCost(castOption, normalizedOptCounts);
			const paidChooseAllModes = hasChooseAllModesOptionalCost(
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const nextSummarySuffix = `${castOption.spellMods?.castSummarySuffix ?? ''}${paidReturnToHand ? ' (Buyback)' : ''}${paidChooseAllModes ? ' (Entwined)' : ''}`;
			const mutateTargetId =
				castOption.spellMods?.mutating && targets[0]?.id ? targets[0].id : undefined;
			// --- Track P20b ---
			const p20bAltCostManaPaid =
				castOption.spellMods?.altCostManaPaid ??
				(castOption.baseCost.kind === 'alternative' && castOption.baseCost.manaCost
					? castOption.baseCost.manaCost
					: undefined);
			const p20bAdditionalPaid = wasAnyAdditionalCostPaidP20b(
				castOption.mandatoryAdditionalCosts,
				action.costPayment,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const hasP20bMods = Boolean(p20bAltCostManaPaid || p20bAdditionalPaid || p20bPitchCounts);
			// --- End Track P20b ---
			const effectiveSpellMods: SpellModifications | undefined =
				paidReturnToHand || paidChooseAllModes || mutateTargetId || hasP20bMods
					? {
							...castOption.spellMods,
							...(paidReturnToHand ? { returnToHandOnResolve: true } : {}),
							...(nextSummarySuffix ? { castSummarySuffix: nextSummarySuffix } : {}),
							// --- Track P18a ---
							...(mutateTargetId ? { mutateTargetId } : {}),
							// --- End Track P18a ---
							// --- Track P20b ---
							...(p20bAltCostManaPaid ? { altCostManaPaid: p20bAltCostManaPaid } : {}),
							...(p20bAdditionalPaid ? { additionalCostPaid: true } : {}),
							...(p20bPitchCounts ? p20bPitchCounts : {})
							// --- End Track P20b ---
						}
					: castOption.spellMods;
			// --- Track P17a: CR 118.3, 601.2h static cost-payment locks (life / sacrifice) ---
			const spellCostLock = checkWave6CostPaymentLocks(
				state,
				actorId,
				combinedCostDefs,
				action.costPayment?.phyrexianLifeCount,
				false
			);
			if (!spellCostLock.ok) {
				return { ok: false, error: spellCostLock.error! };
			}
			// --- End Track P17a ---
			if (
				combinedCostDefs.length > 0 ||
				tapAidParts.length > 0 ||
				exileAidParts.length > 0 ||
				// --- Track P12 ---
				emergeSacParts.length > 0
				// --- End Track P12 ---
			) {
				const ctx = costContext(
					state,
					actor,
					inst,
					xVal,
					true,
					remainingCostReq,
					action.costPayment?.phyrexianLifeCount,
					spendCtx,
					reservedAidIds.size > 0 ? reservedAidIds : undefined,
					undefined,
					targets
				);
				let parts: SerializedPlannedCost[] = [];
				let manaPaid: ManaCostRequirement | null = remainingCostReq;
				if (combinedCostDefs.length > 0) {
					const plan = planCosts(ctx, combinedCostDefs, action.costPayment);
					if (!plan.ok) {
						return { ok: false, error: plan.error.startsWith('Insufficient mana') ? manaError : plan.error };
					}
					if (plan.question) return askCostChoice(state, actor, action, plan.question, spellPromptName);
					parts = serializeCostPlanParts(ctx, plan);
					manaPaid = plan.mana;
				} else if (
					!canPayOrAutoTap(
						actor,
						remainingCostReq,
						state,
						action.costPayment?.phyrexianLifeCount,
						spendCtx,
						reservedAidIds
					)
				) {
					return { ok: false, error: manaError };
				}
				// --- Track P15: Deduct Assist generic mana from assisting player (CR 702.132a) ---
				if (assistPlayerObj && (aidResult.assistGenericPaid ?? 0) > 0) {
					if (
						!payManaWithAutoTap(
							assistPlayerObj,
							parseManaCost(`{${aidResult.assistGenericPaid}}`),
							state
						)
					) {
						return {
							ok: false,
							error: 'Assisting player has insufficient mana to pay generic mana for Assist.'
						};
					}
				}
				// --- End Track P15 ---
				const allParts = [
					...tapAidParts,
					// --- Track P12 ---
					...emergeSacParts,
					// --- End Track P12 ---
					...parts,
					...exileAidParts
				];
				const hasCastCounterRemoval = hasCounterRemovalSerializedPart(allParts);
				const castRemovedCounters = hasCastCounterRemoval
					? totalRemovedCountersFromSerializedParts(allParts)
					: undefined;
				const pcp: PendingCostPayment = {
					kind: 'cast_spell',
					actorId,
					sourceInstanceId: inst.instanceId,
					sourcePlayerId: sourcePlayer.playerId,
					sourceZone,
					targets,
					...(targetsBySpec ? { targetsBySpec } : {}),
					// --- Track P7 ---
					...(spellTargetDivisions ? { targetDivisions: spellTargetDivisions } : {}),
					// --- End Track P7 ---
					...(chosenModes ? { chosenModes: [...chosenModes] } : {}),
					xValue: xVal,
					castOptionId: castOption.id,
					...(castOption.faceIndex !== undefined ? { faceIndex: castOption.faceIndex } : {}),
					...(castOption.fused ? { fused: true } : {}),
					spellMods: effectiveSpellMods,
					...(hasOptCounts ? { optionalCostCounts: normalizedOptCounts } : {}),
					// --- Track P15 ---
					...(action.giftRecipientId ? { giftRecipientId: action.giftRecipientId } : {}),
					// --- End Track P15 ---
					...(inst.playableFromExileBy?.sourceName
						? { exSourceName: inst.playableFromExileBy.sourceName }
						: {}),
					// --- Track P14 ---
					...(castOption.staticPlaySlotKey
						? { staticPlaySlotKey: castOption.staticPlaySlotKey }
						: {}),
					// --- End Track P14 ---
					sourceCard: inst.card,
					additionalIncomplete: Boolean(additional && !additional.complete),
					parts: allParts,
					...(castRemovedCounters !== undefined
						? { removedCounterCount: castRemovedCounters }
						: {}),
					manaPaid,
					tapsAndManaDone: false,
					nextPartIndex: 0,
					nextObjectIndex: 0,
					descriptions: [],
					aidDescriptions: [...aidResult.summaryParts]
				};
				return executeOrResumePendingCostPayment(state, pcp, ctx);
			}
			// --- Track P15: Verify actor can pay before deducting Assist player mana ---
			if (
				assistPlayerObj &&
				(aidResult.assistGenericPaid ?? 0) > 0 &&
				!canPayOrAutoTap(
					actor,
					remainingCostReq,
					state,
					action.costPayment?.phyrexianLifeCount,
					spendCtx,
					reservedAidIds
				)
			) {
				return { ok: false, error: manaError };
			}
			if (assistPlayerObj && (aidResult.assistGenericPaid ?? 0) > 0) {
				if (
					!payManaWithAutoTap(
						assistPlayerObj,
						parseManaCost(`{${aidResult.assistGenericPaid}}`),
						state
					)
				) {
					return {
						ok: false,
						error: 'Assisting player has insufficient mana to pay generic mana for Assist.'
					};
				}
			}
			// --- End Track P15 ---
			if (
				!payManaWithAutoTap(
					actor,
					remainingCostReq,
					state,
					action.costPayment?.phyrexianLifeCount,
					spendCtx,
					reservedAidIds
				)
			) {
				return { ok: false, error: manaError };
			}
			finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, {
				targets,
				targetsBySpec,
				// --- Track P7 ---
				targetDivisions: spellTargetDivisions,
				// --- End Track P7 ---
				chosenModes,
				xValue: xVal,
				castOptionId: castOption.id,
				faceIndex: castOption.faceIndex,
				fused: castOption.fused,
				spellMods: effectiveSpellMods,
				...(hasOptCounts ? { optionalCostCounts: normalizedOptCounts } : {}),
				...(aidResult.summaryParts.length > 0 ? { aidDescriptions: aidResult.summaryParts } : {}),
				additionalIncomplete: Boolean(additional && !additional.complete),
				manaColorsSpent: spendCtx.capturedColorsSpent,
				// --- Track P13 ---
				manaColorsAllSpent: spendCtx.capturedColorsAllSpent,
				// --- End Track P13 ---
				...(spendCtx.spentManaGrantsUncounterable ? { cantBeCounteredByMana: true } : {}),
				...(spendCtx.spentManaCommanderBonusCounters
					? { opalPalaceBonusCounters: spendCtx.spentManaCommanderBonusCounters }
					: {}),
				// --- Track P10 ---
				manaSpentCount: spendCtx.capturedManaSpentCount,
				// --- End Track P10 ---
				// --- Track P14 ---
				staticPlaySlotKey: castOption.staticPlaySlotKey,
				// --- End Track P14 ---
				// --- Track P15 ---
				phyrexianLifePaidCount: spendCtx.capturedPhyrexianLifePaidCount,
				giftRecipientId: action.giftRecipientId
				// --- End Track P15 ---
			});
			return { ok: true };
		}

		case 'activate_ability': {
			// Locate source card across actor's battlefield or hand and verify zone legality
			const foundTarget = findActivatedAbilityTarget(
				state,
				actor,
				action.instanceId,
				action.abilityId
			);
			if (!foundTarget.ok) {
				return foundTarget;
			}
			const { source: perm, ability: ab } = foundTarget;

			if (ab.isManaAbility) {
				if (perm.zone !== 'battlefield') {
					return { ok: false, error: 'Mana abilities can only be tapped on the battlefield.' };
				}
				return applyGameAction(state, actorId, {
					type: 'tap_mana',
					instanceId: perm.instanceId,
					abilityId: ab.id,
					preferredColor:
						ab.producesMana.length === 1 || actor.isBot ? ab.producesMana[0] : undefined,
					costPayment: action.costPayment,
					// --- Track P17b ---
					...(action.xValue !== undefined ? { xValue: action.xValue } : {})
					// --- End Track P17b ---
				});
			}

			// --- Track P20b ---
			const explicitAbX =
				action.xValue !== undefined ? Math.max(0, Math.floor(action.xValue)) : undefined;
			const abLegality = checkAbilityActivationLegality(
				state,
				actorId,
				perm,
				ab,
				explicitAbX,
				action.targets
			);
			// --- End Track P20b ---
			if (!abLegality.ok) {
				return abLegality;
			}

			const abXValue = Math.max(0, Math.floor(action.xValue ?? 0));
			// --- Track P18b (CR 107.3a): Enforce "X can't be 0." on X-cost activated abilities ---
			if (ab.xCantBeZero && abXValue <= 0) {
				return {
					ok: false,
					error: `${perm.card.name}: X can't be 0.`
				};
			}
			// --- End Track P18b ---
			// --- Track P15: Validate -X loyalty activation cost (CR 606.4) ---
			if (ab.loyaltySign === '-' && abXValue > (perm.counters.loyalty ?? 0)) {
				return {
					ok: false,
					error: `${perm.card.name} only has ${perm.counters.loyalty ?? 0} loyalty counter(s); cannot pay -${abXValue} (CR 606.4).`
				};
			}
			// --- End Track P15 ---
			// --- Track P21: Validate explicit Craft material pair shares a card type (CR 702.167) ---
			if (
				ab.costKeyword === 'craft' &&
				action.craftMaterialIds &&
				selectCraftShareCardTypeMaterials(state, actor, perm, action.craftMaterialIds) === null
			) {
				return {
					ok: false,
					error: `${perm.card.name}: Selected Craft materials must be two distinct permanents/graveyard cards that share a card type (CR 702.167).`
				};
			}
			// --- End Track P21 ---
			const abTargetInfo: TargetRequirementInfo = ab.targetInfo;
			// --- Track P7 ---
			const permEffCard =
				perm.zone === 'battlefield' ? getEffectiveCardForPermanent(state, perm) : perm.card;
			// --- End Track P7 ---

			const targets = action.targets || [];
			const abModal =
				// --- Track P7 ---
				ab.modal ??
				getAbilityModal(
					permEffCard,
					ab.id,
					ab.faceIndex ?? 0,
					ab.grantSourceCard,
					ab.grantFaceIndex,
					ab.grantedAbilityText
				);
			// --- End Track P7 ---
			let chosenModes = action.chosenModes;
			let targetsBySpec: TargetRef[][] | undefined;
			if (abModal) {
				// --- Track P18b: Defer mode selection when an opponent chooses (CR 700.2e) ---
				if (abModal.opponentChooses && !chosenModes && targets.length === 0) {
					const oppCheck = validateDeferredOpponentModalChoice(
						state,
						actorId,
						permEffCard,
						perm,
						abModal,
						() => true,
						getEffectiveUsedModalModes(abModal, perm)
					);
					if (!oppCheck.ok) return oppCheck;
					targetsBySpec = [];
				} else {
					// --- End Track P18b ---
					const modalVal = validateModalChoice(
						state,
						actorId,
						// --- Track P7 ---
						permEffCard,
						// --- End Track P7 ---
						perm,
						abModal,
						chosenModes,
						targets,
						() => true,
						// --- Track P18b ---
						getEffectiveUsedModalModes(abModal, perm),
						false,
						abXValue
						// --- End Track P18b ---
					);
					if (!modalVal.ok) return modalVal;
					chosenModes = modalVal.chosenModes;
					targetsBySpec = modalVal.targetsBySpec;
					// --- Track P18b ---
				}
				// --- End Track P18b ---
			} else if (ab.requiresTarget || targets.length > 0) {
				const targetValidation = validateChosenTargets(
					state,
					actorId,
					targets,
					abTargetInfo,
					// --- Track P7 ---
					permEffCard,
					// --- End Track P7 ---
					perm.instanceId,
					abXValue
				);
				if (!targetValidation.ok) {
					return targetValidation;
				}
				// --- Track P7 + Track P16a ---
				targetsBySpec = partitionTargetsBySpecs(
					targets,
					abTargetInfo,
					permEffCard,
					state,
					actorId,
					perm.instanceId
				);
				// --- End Track P7 + Track P16a ---
			}
			// --- Track P7 ---
			const activeAbSpecs = abModal
				? (chosenModes ?? []).flatMap((mIdx) => abModal.modes[mIdx]?.targets ?? [])
				: abTargetInfo.targetSpecs?.filter((sp) => sp.max > 0);
			const abDivRes = resolveTargetDivisionsForSpecs(
				state,
				actorId,
				activeAbSpecs,
				targets,
				targetsBySpec,
				permEffCard,
				perm.instanceId,
				abXValue,
				action.targetDivisions
			);
			if (!abDivRes.ok) return abDivRes;
			const abTargetDivisions = abDivRes.targetDivisions;
			// --- End Track P7 ---

			// Phase 4: pay the whole cost from the IR. Mana comes from effectiveAbilityManaCost (cost
			// modifiers applied); everything else from the ability's CostDefs.
			// --- Track P7 ---
			const abilityCost = activatedAbilityCost(permEffCard, ab);
			// --- End Track P7 ---
			// --- Track P17b ---
			const isLoyaltyAb = ab.loyaltyCost !== null || Boolean(ab.loyaltySign);
			const extraAbilityCostDefs = collectActiveAbilityAdditionalCostsWave6(
				state,
				actorId,
				ab.id,
				ab.costKeyword,
				perm,
				ab.isManaAbility,
				isLoyaltyAb,
				targets,
				matchesObjectFilter,
				costModifiersOf
			);
			const allAbilityCostDefs =
				extraAbilityCostDefs.length > 0
					? [...abilityCost.defs, ...extraAbilityCostDefs]
					: abilityCost.defs;
			// --- End Track P17b ---
			const abilityMana = effectiveAbilityManaCost(
				state,
				actorId,
				ab.id,
				// --- Track P17b ---
				ab.baseManaCost ?? ab.manaCost,
				// --- End Track P17b ---
				ab.costKeyword,
				abXValue,
				// --- Track P11 & P15 ---
				perm,
				ab.isManaAbility,
				ab.powerUpReduction,
				// --- End Track P11 & P15 ---
				// --- Track P17b ---
				targets,
				isLoyaltyAb
				// --- End Track P17b ---
			).requirement;
			const phyAbilityChoice = maybeAskPhyrexianCostChoice(
				state,
				actor,
				action,
				abilityMana,
				perm.card.name
			);
			if (phyAbilityChoice) return phyAbilityChoice;
			// --- Track P10 & P20b ---
			const abilitySpendCtx = activatedAbilitySpendContext(state, perm, ab, abXValue);
			// --- End Track P10 & P20b ---
			const hybAbilityChoice = resolveHybridCostChoice(
				state,
				actor,
				action,
				abilityMana,
				perm.card.name,
				abilitySpendCtx
			);
			if (hybAbilityChoice.promptResult) return hybAbilityChoice.promptResult;
			const abilityCtx = costContext(
				state,
				actor,
				perm,
				abXValue,
				false,
				hybAbilityChoice.resolvedReq,
				action.costPayment?.phyrexianLifeCount,
				abilitySpendCtx
			);
			// --- Track P17a: CR 118.3, 702.122a, 702.171a cost locks & Crew/Saddle virtual power ---
			const abCostLock = checkWave6CostPaymentLocks(
				state,
				actorId,
				allAbilityCostDefs,
				action.costPayment?.phyrexianLifeCount,
				ab.isManaAbility,
				perm
			);
			if (!abCostLock.ok) return { ok: false, error: abCostLock.error! };
			const crewAdjusted = adjustCostDefsForCrewSaddleVirtualPower(
				state,
				actor,
				perm,
				allAbilityCostDefs,
				action.costPayment?.objects
			);
			const effectiveAbilityCostPayment =
				crewAdjusted.chosenObjects !== action.costPayment?.objects &&
				crewAdjusted.chosenObjects !== undefined
					? { ...(action.costPayment ?? {}), objects: crewAdjusted.chosenObjects }
					: action.costPayment;
			const abilityPlan = planCosts(abilityCtx, crewAdjusted.defs, effectiveAbilityCostPayment);
			// --- End Track P17a ---
			if (!abilityPlan.ok) return { ok: false, error: abilityPlan.error };
			if (abilityPlan.question) return askCostChoice(state, actor, action, abilityPlan.question, perm.card.name);
			const preCostEval = perm.zone === 'battlefield' ? evaluatePermanent(state, perm) : null;
			// --- Track P9 ---
			const sourceLkiPower = preCostEval ? preCostEval.power : Math.max(0, objectPower(state, perm) ?? 0);
			const sourceLkiToughness = preCostEval
				? preCostEval.toughness
				: Math.max(0, objectToughness(state, perm) ?? 0);
			// --- End Track P9 ---
			const parts = serializeCostPlanParts(abilityCtx, abilityPlan);
			// --- Track P20b ---
			const hasCounterRemovalPart = hasCounterRemovalSerializedPart(parts);
			const abRemovedCounters = totalRemovedCountersFromSerializedParts(parts);
			const abLastRoll = lastRollResultFromSerializedParts(parts);
			const effectiveAbX =
				abXValue > 0 ? abXValue : !ab.choosesX && hasCounterRemovalPart ? abRemovedCounters : 0;
			// --- End Track P20b ---
			const pcp: PendingCostPayment = {
				kind: 'activate_ability',
				actorId,
				sourceInstanceId: perm.instanceId,
				// --- Track P7 ---
				sourceCard: permEffCard,
				// --- End Track P7 ---
				abilityId: ab.id,
				...(ab.faceIndex !== undefined ? { faceIndex: ab.faceIndex } : {}),
				...(ab.costKeyword ? { costKeyword: ab.costKeyword } : {}),
				...(effectiveAbX > 0 ? { xValue: effectiveAbX } : {}),
				// --- Track P20b ---
				...(hasCounterRemovalPart ? { removedCounterCount: abRemovedCounters } : {}),
				...(abLastRoll !== undefined ? { lastRollResult: abLastRoll } : {}),
				// --- End Track P20b ---
				targets,
				...(targetsBySpec ? { targetsBySpec } : {}),
				// --- Track P7 ---
				...(abTargetDivisions ? { targetDivisions: abTargetDivisions } : {}),
				// --- End Track P7 ---
				...(chosenModes ? { chosenModes: [...chosenModes] } : {}),
				sourceObjectVersion: perm.objectVersion,
				sourceLkiPower,
				sourceLkiToughness,
				...(perm.evoked ? { sourceEvoked: true } : {}),
				...(perm.escaped ? { sourceEscaped: true } : {}),
				...(perm.foretold ? { sourceForetold: true } : {}),
				...(perm.blitzed ? { sourceBlitzed: true } : {}),
				...(perm.exertedThisTurn ? { sourceExertedThisTurn: true } : {}),
				...(perm.chosenSubType ? { sourceChosenSubType: perm.chosenSubType } : {}),
				...(perm.chosenColor ? { sourceChosenColor: perm.chosenColor } : {}),
				onceEachTurn: Boolean(ab.activationRestrictions?.includes('onceEachTurn')),
				// --- Track P15 ---
				...(ab.activationRestrictions?.includes('oncePerGame') ? { oncePerGame: true } : {}),
				...(action.craftMaterialIds ? { craftMaterialIds: [...action.craftMaterialIds] } : {}),
				// --- End Track P15 ---
				effectText: ab.effectText,
				abilityCostIncomplete: !abilityCost.complete,
				...(ab.grantSourceCard ? { grantSourceCard: ab.grantSourceCard } : {}),
				...(ab.grantFaceIndex !== undefined ? { grantFaceIndex: ab.grantFaceIndex } : {}),
				// --- Track P10 ---
				...(ab.grantedAbilityText ? { grantedAbilityText: ab.grantedAbilityText } : {}),
				// --- End Track P10 ---
				parts,
				manaPaid: abilityPlan.mana,
				tapsAndManaDone: false,
				nextPartIndex: 0,
				nextObjectIndex: 0,
				descriptions: []
			};
			return executeOrResumePendingCostPayment(state, pcp, abilityCtx);
		}

		case 'declare_attackers': {
			if (activePlayer.playerId !== actorId) {
				return { ok: false, error: 'Only the active player may declare attackers.' };
			}
			if (state.phase !== 'declare_attackers') {
				return { ok: false, error: 'Attackers can only be declared during the Declare Attackers step.' };
			}
			if (state.stack.length > 0) {
				return { ok: false, error: 'Cannot declare attackers while the Stack is not empty.' };
			}
			if (state.combat.active) {
				return { ok: false, error: 'Attackers have already been declared this combat.' };
			}
			// --- Track P18a: Banding (CR 702.22c) ---
			return performDeclareAttackers(state, actor, action.assignments, false, false, action.bands);
			// --- End Track P18a ---
		}

		case 'declare_blockers': {
			if (state.phase !== 'declare_blockers') {
				return { ok: false, error: 'Blockers can only be declared during the Declare Blockers step.' };
			}
			if (state.stack.length > 0) {
				return { ok: false, error: 'Cannot declare blockers while the Stack is not empty.' };
			}
			if (
				state.combat.blockersDeclared ||
				(state.combat.declaredBlockersPlayerIds &&
					state.combat.declaredBlockersPlayerIds.includes(actorId))
			) {
				return { ok: false, error: 'Blockers have already been declared this step.' };
			}

			const validated = validateDefenderBlockerAssignments(state, actor, action.assignments);
			if (!validated.ok) {
				return { ok: false, error: validated.error };
			}
			// --- Track P17a: CR 509.1d pay block tax ---
			if (
				validated.combinedBlockTaxManaCost &&
				!payManaWithAutoTap(actor, parseManaCost(validated.combinedBlockTaxManaCost), state)
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: Blocking requires paying ${validated.combinedBlockTaxManaCost}, and you have insufficient mana (CR 509.1d).`
				};
			}
			// --- End Track P17a ---

			let allDeclared = false;
			withTriggersDeferred(state, () => {
				applyValidatedDefenderBlockers(state, actor, action.assignments, validated.blockerCountsByAttacker);
				allDeclared = advanceBotBlockerDeclarations(state);
				if (allDeclared) {
					checkStateBasedActions(state);
				}
			});

			if (!allDeclared) {
				const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
				const nextUndecidedDefenderId = defendersInOrder.find(
					(defId) => !state.combat.declaredBlockersPlayerIds.includes(defId)
				);
				const nextDefIdx = nextUndecidedDefenderId
					? state.players.findIndex((p) => p.playerId === nextUndecidedDefenderId)
					: -1;
				if (nextDefIdx >= 0) {
					state.priorityPlayerIndex = nextDefIdx;
				} else {
					givePriorityToActiveOrNextPlayer(state);
				}
				state.passedPriorityPlayerIds = [];
				state.priorityUpdatedAt = Date.now();
				return { ok: true };
			}

			// CR 509.1i, 509.2, 117.5: All attacked defenders have declared blockers; put block/phase-begin
			// triggers on the stack in APNAP order before giving priority to the active player.
			// --- Track P10 ---
			emitUnblockedAttackersEvents(state);
			// --- End Track P10 ---
			emitEvent(state, {
				kind: 'PhaseBegin',
				phase: 'declare_blockers',
				activePlayerId: activePlayer?.playerId ?? null
			});
			flushTriggers(state);
			givePriorityToActiveOrNextPlayer(state);
			state.passedPriorityPlayerIds = [];
			state.priorityUpdatedAt = Date.now();
			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'pass_priority': {
			if (priorityPlayer.playerId !== actorId) {
				return { ok: false, error: 'You do not currently hold priority.' };
			}

			// CR 508.1d / 701.15b / 703.4i: Active player cannot pass out of declare_attackers without declaring attackers
			// if they control a creature that must attack this combat if able.
			if (
				isUnconfirmedAttackersStep(state) &&
				state.stack.length === 0 &&
				actorId === activePlayer.playerId &&
				!actor.isBot
			) {
				const zeroAtkRes = completeUnconfirmedZeroAttackersDeclaration(
					state,
					activePlayer,
					actor
				);
				if (!zeroAtkRes.ok) {
					return zeroAtkRes;
				}
				if (zeroAtkRes.triggeredOrPrompted) {
					state.priorityUpdatedAt = Date.now();
					checkStateBasedActions(state);
					return { ok: true };
				}
			}

			// If an attacked defender passes priority in declare_blockers without having declared blockers yet, record 0 blockers
			if (
				state.phase === 'declare_blockers' &&
				state.stack.length === 0 &&
				!state.combat.blockersDeclared &&
				state.combat.attackers.some((a) => a.defenderPlayerId === actorId)
			) {
				if (!state.combat.declaredBlockersPlayerIds) {
					state.combat.declaredBlockersPlayerIds = [];
				}
				if (!state.combat.declaredBlockersPlayerIds.includes(actorId)) {
					// --- Track P8 (CR 509.1c) ---
					const zeroBlockerCheck = validateDefenderBlockerAssignments(state, actor, []);
					if (!zeroBlockerCheck.ok) {
						return { ok: false, error: zeroBlockerCheck.error };
					}
					let allDeclared = false;
					withTriggersDeferred(state, () => {
						applyValidatedDefenderBlockers(state, actor, [], new Map());
						allDeclared = advanceBotBlockerDeclarations(state);
						if (allDeclared) {
							checkStateBasedActions(state);
						}
					});
					if (!allDeclared) {
						const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
						const nextUndecidedDefenderId = defendersInOrder.find(
							(defId) => !state.combat.declaredBlockersPlayerIds.includes(defId)
						);
						if (nextUndecidedDefenderId) {
							const nextDefIdx = state.players.findIndex((p) => p.playerId === nextUndecidedDefenderId);
							if (nextDefIdx >= 0) {
								state.priorityPlayerIndex = nextDefIdx;
								state.passedPriorityPlayerIds = [];
								state.priorityUpdatedAt = Date.now();
								return { ok: true };
							}
						}
					} else {
						// --- Track P10 ---
						emitUnblockedAttackersEvents(state);
						// --- End Track P10 ---
						emitEvent(state, {
							kind: 'PhaseBegin',
							phase: 'declare_blockers',
							activePlayerId: activePlayer?.playerId ?? null
						});
						flushTriggers(state);
						givePriorityToActiveOrNextPlayer(state);
						state.passedPriorityPlayerIds = [];
						state.priorityUpdatedAt = Date.now();
						checkStateBasedActions(state);
						return { ok: true };
					}
				}
			}

			if (!state.passedPriorityPlayerIds.includes(actorId)) {
				state.passedPriorityPlayerIds.push(actorId);
			}

			const alivePlayers = state.players.filter((p) => !p.lost);
			const allPassed = alivePlayers.every((p) =>
				state.passedPriorityPlayerIds.includes(p.playerId)
			);

			if (allPassed) {
				state.passedPriorityPlayerIds = [];
				if (state.stack.length > 0) {
					resolveTopOfStack(state);
				} else {
					advancePhaseOrStep(state);
				}
			} else {
				checkStateBasedActions(state);
				advancePriorityToNextPlayer(state);
			}

			state.priorityUpdatedAt = Date.now();
			return { ok: true };
		}

		case 'end_turn': {
			if (activePlayer.playerId !== actorId) {
				return { ok: false, error: 'You can only end the turn during your own turn.' };
			}
			if (priorityPlayer.playerId !== actorId) {
				return { ok: false, error: 'You must hold priority to end your turn.' };
			}
			if (state.stack.length > 0) {
				return { ok: false, error: 'Resolve all spells and abilities on the Stack before ending your turn.' };
			}

			// CR 508.1d / 701.15b / 703.4i: Mandatory attack requirements cannot be bypassed by ending the turn
			// before attackers have been declared in combat.
			const preCombatOrUnconfirmedAttackers =
				state.phase === 'upkeep' ||
				state.phase === 'draw' ||
				state.phase === 'main1' ||
				state.phase === 'begin_combat' ||
				isUnconfirmedAttackersStep(state);
			if (preCombatOrUnconfirmedAttackers) {
				const violation = findMandatoryAttackerViolation(state, activePlayer);
				if (violation) {
					return { ok: false, error: violation };
				}
			}

			addLog(state, 'rule', `${actor.username} ended their turn.`, actorId);

			// CR 500.2 / 513.1: Advance step-by-step through remaining phases/steps of the turn, running
			// turn-based actions and step-begin triggers and passing priority around the table in each step.
			const startingTurnNumber = state.turnNumber;
			const startingActiveIndex = state.activePlayerIndex;
			let safety = 0;

			while (
				state.status === 'active' &&
				state.turnNumber === startingTurnNumber &&
				state.activePlayerIndex === startingActiveIndex &&
				state.stack.length === 0 &&
				state.pendingPrompts.length === 0 &&
				safety < 32
			) {
				safety += 1;

				// Re-check mandatory attack requirements before leaving declare_attackers with 0 attackers
				// (e.g. if an intermediate step's trigger created/untapped/goaded a creature).
				if (isUnconfirmedAttackersStep(state)) {
					const zeroAtkRes = completeUnconfirmedZeroAttackersDeclaration(state, activePlayer);
					if (!zeroAtkRes.ok || zeroAtkRes.triggeredOrPrompted) {
						break;
					}
				}

				if (!state.passedPriorityPlayerIds.includes(actorId)) {
					state.passedPriorityPlayerIds.push(actorId);
				}

				let stoppedOnOpponent = false;
				const count = state.players.length;
				for (let step = 1; step < count; step++) {
					const oppIdx = (state.activePlayerIndex + step) % count;
					const opp = state.players[oppIdx];
					if (!opp || opp.lost) continue;
					if (state.passedPriorityPlayerIds.includes(opp.playerId)) continue;

					const isDefendingInBlockers =
						state.phase === 'declare_blockers' &&
						state.combat.attackers.some((a) => a.defenderPlayerId === opp.playerId) &&
						!(state.combat.declaredBlockersPlayerIds || []).includes(opp.playerId);
					const hasExplicitPhaseStop = opp.stopPhases.includes(state.phase);
					const wantsPriority =
						isDefendingInBlockers ||
						(!opp.isBot &&
							(opp.fullControl || !opp.autoPassEmptyStack || hasExplicitPhaseStop));

					if (wantsPriority) {
						state.priorityPlayerIndex = oppIdx;
						stoppedOnOpponent = true;
						break;
					}

					state.passedPriorityPlayerIds.push(opp.playerId);
				}

				if (stoppedOnOpponent) {
					break;
				}

				state.passedPriorityPlayerIds = [];
				advancePhaseOrStep(state);

				if (
					state.status === 'active' &&
					state.turnNumber === startingTurnNumber &&
					state.activePlayerIndex === startingActiveIndex &&
					state.priorityPlayerIndex === state.activePlayerIndex &&
					activePlayer.stopPhases.includes(state.phase)
				) {
					break;
				}
			}

			state.priorityUpdatedAt = Date.now();
			checkStateBasedActions(state);
			return { ok: true };
		}

		default:
			return { ok: false, error: `Action ${action.type} is not valid right now.` };
	}
}

registerTriggerHost({
	executeInline(state, t) {
		const controller = state.players.find((p) => p.playerId === t.controllerId);
		if (!controller) return;
		if (state.triggersPlacedThisTurn) {
			state.triggersPlacedThisTurn.resolutionSerial = (state.triggersPlacedThisTurn.resolutionSerial ?? 0) + 1;
		}
		// --- Track P19b: CR 605.1b, 605.4a stackless mana recipient & recursion guard ---
		const item = triggeredStackItem(state, t, 'trg');
		const compiled = triggerItemEffect(item);
		const recipient = resolveInlineManaRecipientPlayer(
			state,
			controller,
			compiled?.steps,
			t.eventObject,
			t.eventPlayer ?? t.eventPlayerId
		);
		withInlineManaResolutionGuard(() => {
			executeTriggerEffects(state, recipient, item);
		});
		// --- End Track P19b ---
		addLog(
			state,
			'trigger',
			`${triggerSourcePublicName(state, t)} (${t.label}) triggered for ${controller.username}.`,
			controller.playerId
		);
	},
	putOnStack: putTriggerOnStack,
	orderSimultaneous: askTriggerOrder
	// Step E2: no `canExecute` filter. Every matched ability triggers; one the engine can't run is
	// resolved manually (human) or by its legacy effects / skipped (bot) as it resolves.
});

registerEffectPorts({
	uid,
	addLog,
	emitVfx,
	findPermanent: findPermanentOnBoard,
	power: (state, inst) => getCreaturePower(inst, state),
	toughness: (state, inst) => getCreatureToughness(inst, state),
	hasKeyword: (state, inst, kw) => hasKeyword(inst, kw, state),
	drawCards: (state, player, count) => drawCards(state, player, count, true),
	damageTarget: applyDamageToTarget,
	destroy: destroyPermanentByEffect,
	tryRegenerateInsteadOfDestroy,
	canPayOptionalCost,
	payOptionalCost,
	moveFromBattlefield: (state, inst, to, libraryOpts) =>
		movePermanentToZone(state, inst, to, undefined, libraryOpts),
	// --- Precon Bragos Spirit ---
	moveStackSpellToHand: (state, target) => {
		const idx = state.stack.indexOf(target);
		if (idx >= 0) {
			const [removed] = state.stack.splice(idx, 1);
			moveStackSpellToZone(state, removed, 'hand');
		}
	},
	// --- End Precon Bragos Spirit ---
	moveStackSpellToLibrary: (state, target, libraryOpts) => {
		const idx = state.stack.indexOf(target);
		if (idx >= 0) {
			const [removed] = state.stack.splice(idx, 1);
			moveStackSpellToZone(state, removed, 'library', libraryOpts);
		}
	},
	counterSpell: counterStackItemByEffect,
	// --- Track P17a ---
	createToken: (state, controller, spec) =>
		createTokenWithWave6Replacements(state, controller, spec, createTokenOnBoard)[0]!,
	// --- End Track P17a ---
	copyPermanentAsToken,
	triggerOnEtb: (state) => flushTriggers(state),
	triggerOnAttach: (state, _controller, attached, to) => {
		emitEvent(state, {
			kind: 'Attached',
			attachmentId: attached.instanceId,
			attachment: attached,
			hostId: to.instanceId,
			host: to
		});
		flushTriggers(state);
	},
	addCounters: addCountersToPermanent,
	proliferate: executeProliferate,
	scry: (state, player, item, count, mode, mayShuffle) =>
		initiateLibraryScryOrSurveil(state, player, item, count, mode, mayShuffle),
	search: (state, player, spec, item) =>
		initiateLibrarySearch(state, player, spec, item),
	phaseOut: phaseOutPermanent,
	transformPermanent,
	flipPermanent,
	endTurn: endTheTurnImmediately,
	activePlayerMayEndTurn,
	win: (state, player, reason) => void winTheGame(state, player, reason),
	lose: (state, player, reason) => void loseTheGame(state, player, reason),
	legalAuraAttachCandidates,
	getStackItemRetargetSlots,
	validateStackItemRetarget,
	chooseBotStackItemRetarget,
	pushCopiedStackItem,
	setMonarch,
	allocateFaceDownLabel
});

// --- Track P9 ---
registerWave3Host({
	uid,
	addLog,
	canPayOrAutoTap: (player, req, state, phyrexianLifeCount, reservedObjectIds) =>
		canPayOrAutoTap(player, req, state, phyrexianLifeCount, { isSpell: false }, reservedObjectIds),
	payManaWithAutoTap: (player, req, state, phyrexianLifeCount, reservedObjectIds) =>
		payManaWithAutoTap(player, req, state, phyrexianLifeCount, { isSpell: false }, reservedObjectIds),
	costContext: (state, player, source, xValue, isSpell, baseMana) =>
		costContext(state, player, source, xValue, isSpell, baseMana),
	specTargetCandidates: (state, actorId, sourceCard, sourceInst, spec) =>
		specTargetCandidates(state, actorId, sourceCard, sourceInst, spec),
	validateModalChoice: (state, actorId, sourceCard, sourceInst, modal, providedModes, targets) =>
		validateModalChoice(state, actorId, sourceCard, sourceInst, modal, providedModes, targets),
	finalizeCastSpell: (state, actor, inst, sourcePlayer, sourceZone, opts) =>
		finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, opts),
	resumeStackItem,
	shuffleArray,
	gainPlayerLife,
	createTokens: (state, controller, spec, count) => {
		const out: CardInstance[] = [];
		const total = Math.max(0, count) * tokenMultiplier(state, controller.playerId);
		// --- Track P17a ---
		withSimultaneousZoneBatch(state, () => {
			for (let i = 0; i < total; i++) {
				out.push(...createTokenWithWave6Replacements(state, controller, spec, createTokenOnBoard));
			}
		});
		// --- End Track P17a ---
		return out;
	},
	addCountersToPermanent: (state, perm, counterType, amount) => {
		addCountersToPermanent(state, perm, counterType, amount);
		return amount;
	}
});
// --- End Track P22c ---

// --- Track P10 ---
registerP10RuntimeHost({
	uid,
	addLog,
	canPayOrAutoTap: (player, req, state) =>
		canPayOrAutoTap(player, req, state, undefined, { isSpell: false }),
	payManaWithAutoTap: (player, req, state) =>
		payManaWithAutoTap(player, req, state, undefined, { isSpell: false }),
	costContext: (state, player, source, xValue, isSpell, baseMana) =>
		costContext(state, player, source, xValue, isSpell, baseMana),
	specTargetCandidates: (state, actorId, sourceCard, sourceInst, spec) =>
		specTargetCandidates(state, actorId, sourceCard, sourceInst, spec),
	finalizeCastSpell: (state, actor, inst, sourcePlayer, sourceZone, opts) =>
		finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, opts),

	assignOrPromptTriggerTargets: (state, item, specs) => {
		const controller = state.players.find((p) => p.playerId === item.controllerId);
		if (!controller) return 'removed';
		// --- Track P22c: Reflexive modal triggers choose/prompt modes before targets ---
		const reflModal = triggerItemModal(item);
		if (reflModal && !item.chosenModes) {
			const foundSrcPerm = findPermanentOnBoard(state, item.sourceInstanceId);
			const srcObj = triggerSourceObject(state, item);
			const modalOutcome = resolveTriggerModalBeforeStack(
				state,
				controller,
				item,
				reflModal,
				srcObj,
				foundSrcPerm ?? undefined,
				item.sourceObjectVersion
			);
			if (modalOutcome.status === 'removed') {
				const idx = state.stack.indexOf(item);
				if (idx >= 0) state.stack.splice(idx, 1);
				return 'removed';
			}
			if (modalOutcome.status === 'prompt') {
				enqueueHumanTriggerModesPrompt(
					state,
					modalOutcome.modeChooser,
					item,
					reflModal,
					srcObj,
					modalOutcome.disabledIndices
				);
				return 'prompted';
			}
		}
		const effSpecs = reflModal && item.chosenModes ? triggerItemTargetSpecs(item) : specs;
		// --- End Track P22c ---
		const candidates = effSpecs.map((spec) => triggerTargetCandidates(state, item, spec));
		const impossible = effSpecs.findIndex(
			(spec, i) => spec.min > 0 && candidates[i].length < spec.min
		);
		if (impossible >= 0) {
			const idx = state.stack.indexOf(item);
			if (idx >= 0) state.stack.splice(idx, 1);
			addLog(
				state,
				'rule',
				`${item.title} was removed from the Stack: it has no legal targets (CR 603.3d).`,
				item.controllerId
			);
			return 'removed';
		}
		const promptsBefore = state.pendingPrompts.length;
		assignOrPromptTriggerTargets(state, controller, item, effSpecs, candidates);
		return state.pendingPrompts.length > promptsBefore ? 'prompted' : 'ready';
	}
});
// --- End Track P10 ---

// --- Track P16a ---
registerP16aRuntimeHost({
	uid,
	addLog,
	canPayOrAutoTap: (player, req, state) =>
		canPayOrAutoTap(player, req, state, undefined, { isSpell: false }),
	payManaWithAutoTap: (player, req, state) =>
		payManaWithAutoTap(player, req, state, undefined, { isSpell: false }),
	costContext: (state, player, source, xValue, isSpell, baseMana) =>
		costContext(state, player, source, xValue, isSpell, baseMana),
	specTargetCandidates: (state, actorId, sourceCard, sourceInst, spec) =>
		specTargetCandidates(state, actorId, sourceCard, sourceInst, spec),
	finalizeCastSpell: (state, actor, inst, sourcePlayer, sourceZone, opts) =>
		finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, opts)
});
// --- End Track P16a ---

// --- Track P19a ---
registerP19aRuntimeHost({
	uid,
	addLog,
	findPermanent: findPermanentOnBoard,
	triggerOnEtb: (state) => flushTriggers(state),
	getStackItemRetargetSlots,
	validateStackItemRetarget,
	chooseBotStackItemRetarget,
	pushCopiedStackItem,
	captureTargetObjectVersions
});
// --- End Track P19a ---

// --- Track P12 ---
registerWave4Host({
	uid,
	addLog,
	emitEvent,
	flushTriggers,
	canPayOrAutoTap: (player, req, state, phyrexianLifeCount, reservedObjectIds) =>
		canPayOrAutoTap(player, req, state, phyrexianLifeCount, { isSpell: false }, reservedObjectIds),
	payManaWithAutoTap: (player, req, state, phyrexianLifeCount, reservedObjectIds) =>
		payManaWithAutoTap(player, req, state, phyrexianLifeCount, { isSpell: false }, reservedObjectIds),
	costContext: (state, player, source, xValue, isSpell, baseMana) =>
		costContext(state, player, source, xValue, isSpell, baseMana),
	createTokens: (state, controller, spec, count) => {
		const out: CardInstance[] = [];
		const total = Math.max(0, count) * tokenMultiplier(state, controller.playerId);
		// --- Track P17a ---
		withSimultaneousZoneBatch(state, () => {
			for (let i = 0; i < total; i++) {
				out.push(
					...createTokenWithWave6Replacements(
						state,
						controller,
						{
							name: spec.name,
							power: spec.power,
							toughness: spec.toughness,
							colors: [...spec.colors],
							typeLine: spec.typeLine,
							keywords: [...spec.keywords],
							tapped: spec.tapped
						},
						createTokenOnBoard
					)
				);
			}
		});
		// --- End Track P17a ---
		return out;
	},
	copyPermanentAsToken,
	addCountersToPermanent: (state, perm, counterType, amount) => {
		addCountersToPermanent(state, perm, counterType, amount);
		return amount;
	},
	tapPermanent,
	finalizeCastSpell: (state, actor, inst, sourcePlayer, sourceZone, opts) =>
		finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, opts),
	resumeStackItem,
	drawSingleCardWithoutDredge,
	drawCards: (state, player, count, deferSba) => drawCards(state, player, count, deferSba),
	markHandCardRevealedToAll
});
// --- End Track P12 ---

// --- Track P21 ---
registerChoicesHost({
	isLandOnBattlefield: (state, inst) => evaluatePermanent(state, inst).isLand,
	isLandInZone: (inst, zone) =>
		resolveObjectFaces(effectiveCardForObject(inst), instanceFaceOptions(inst, zone)).types.includes(
			'Land'
		)
});
registerWave7Host({
	uid,
	addLog,
	drawCards: (state, player, count) => drawCards(state, player, count),
	addCountersToPermanent: (state, perm, counter, amount) =>
		addCountersToPermanent(state, perm, counter, amount),
	hasKeyword,
	matchesObjectFilter,
	resumeStackItem: (state, stackItemId) => {
		const found = state.stack.find((s) => s.id === stackItemId);
		if (found) resumeStackItem(state, found);
	},
	flushTriggers,
	checkStateBasedActions
});
// --- End Track P21 ---

// --- Track P15 ---
registerWave5Host({
	uid,
	addLog,
	emitEvent,
	flushTriggers,
	canPayOrAutoTap: (player, req, state, phyrexianLifeCount, reservedObjectIds) =>
		canPayOrAutoTap(player, req, state, phyrexianLifeCount, { isSpell: false }, reservedObjectIds),
	payManaWithAutoTap: (player, req, state, phyrexianLifeCount, reservedObjectIds) =>
		payManaWithAutoTap(
			player,
			req,
			state,
			phyrexianLifeCount,
			{ isSpell: false },
			reservedObjectIds
		),
	costContext: (state, player, source, xValue, isSpell, baseMana) =>
		costContext(state, player, source, xValue, isSpell, baseMana),
	createTokens: (state, controller, spec, count) => {
		const out: CardInstance[] = [];
		const total = Math.max(0, count) * tokenMultiplier(state, controller.playerId);
		// --- Track P17a ---
		withSimultaneousZoneBatch(state, () => {
			for (let i = 0; i < total; i++) {
				out.push(...createTokenWithWave6Replacements(state, controller, spec, createTokenOnBoard));
			}
		});
		// --- End Track P17a ---
		return out;
	},
	copyPermanentAsToken,
	copyStackSpell: (state, original, controller, mayChooseNewTargets) => {
		if (mayChooseNewTargets) {
			const slots = getStackItemRetargetSlots(state, original, controller.playerId);
			if (slots.length > 0) {
				const chosen = chooseBotStackItemRetarget(state, controller, original, slots, 0);
				return pushCopiedStackItem(state, controller, original, chosen.targets, chosen.targetsBySpec);
			}
		}
		return pushCopiedStackItem(state, controller, original, original.targets, original.targetsBySpec);
	},
	addCountersToPermanent: (state, perm, counterType, amount) => {
		addCountersToPermanent(state, perm, counterType, amount);
		return amount;
	},
	tapPermanent,
	untapPermanent: (state, perm) => {
		if (!perm.tapped) return;
		if ((perm.counters.stun || 0) > 0) {
			const prevStun = perm.counters.stun || 0;
			const nextStun = Math.max(0, prevStun - 1);
			perm.counters.stun = nextStun;
			emitEvent(state, {
				kind: 'CounterRemoved',
				objectId: perm.instanceId,
				object: perm,
				counterType: 'stun',
				amount: prevStun - nextStun,
				previousCount: prevStun,
				newCount: nextStun
			});
			flushTriggers(state);
			return;
		}
		perm.tapped = false;
		noteLayerInputsChanged(state);
		if (!perm.phasedOut) {
			emitEvent(state, {
				kind: 'BecomesUntapped',
				objectId: perm.instanceId,
				object: perm
			});
			flushTriggers(state);
		}
	},
	finalizeCastSpell: (state, actor, inst, sourcePlayer, sourceZone, opts) =>
		finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, opts),
	resumeStackItem: (state, stackItemId) => {
		const found = state.stack.find((s) => s.id === stackItemId);
		if (found) resumeStackItem(state, found);
	},
	drawCards: (state, player, count) => drawCards(state, player, count, true),
	markHandCardRevealedToAll,
	shuffleLibrary,
	transformPermanentRaw: transformPermanent,
	moveStackSpellToZone: (state, stackItem, dest) => moveStackSpellToZone(state, stackItem, dest)
});
// --- End Track P15 ---

// --- Track P18a ---
registerWave6Host({
	uid,
	addLog,
	emitEvent,
	flushTriggers,
	allocateTimestamp,
	resumeStackItem: (state, stackItemId) => {
		const found = state.stack.find((s) => s.id === stackItemId);
		if (found) resumeStackItem(state, found);
	},
	hasKeyword: (perm, keyword, st) => hasKeyword(perm, keyword, st ?? null!),
	executeSpellCardEffectOnStack: (state, item, controller, spellCard) => {
		const def = compileCard(spellCard);
		const spellAb = def.faces[0]?.abilities.find((a) => a.kind === 'spell');
		if (!spellAb || spellAb.kind !== 'spell') return 'done';
		const result = executeEffectSteps(
			state,
			{
				controller,
				sourceId: item.sourceInstanceId,
				sourceCard: spellCard,
				title: item.title,
				item,
				targets: item.targets,
				targetSpecs: spellAb.targets,
				xValue: item.xValue,
				...triggerEventContext(item, state)
			},
			spellAb.effect,
			item.effectResume
		);
		if (result.paused) return 'paused';
		delete item.effectResume;
		return 'done';
	}
});


registerEngineRuntimeHost({
	activatedAbilitySpendContext,
	addCountersToPermanent,
	advanceBotBlockerDeclarations,
	advancePhaseOrStep,
	advanceSurveilGraveyardProcedure,
	applyDamageToTarget,
	applyGameAction,
	applyGameActionInner,
	autoTapManaAbilities,
	beginPhase,
	canPayManaWithPaymentAids,
	canPayOrAutoTap,
	captureTargetObjectVersions,
	checkActivationRestrictionsOnly,
	checkAnyCombatantHasFirstStrike,
	checkIfAllKeptMulligan,
	checkSpellCastOptionLegalityInner,
	checkStateBasedActions,
	chooseBotModalTriggerModes,
	chooseBotTriggerTargets,
	cleanupEliminatedPlayer,
	clearEndOfTurnAndDamage,
	compileOptionSpellEffects,
	costContext,
	createTokenOnBoard,
	drawCards,
	endTheTurnImmediately,
	evaluateSpecDivideTotal,
	executeBotDeclareAttackersTurnBasedAction,
	executeCombatDamageStep,
	executeDrawTurnBasedAction,
	executeUntapTurnBasedActions,
	finalizeHandSpecialAction,
	finalizeTurnFaceUp,
	findMandatoryAttackerViolation,
	finishCombatDamagePhase,
	getDynamicManaProducedAmount,
	getPendingCombatDeclarationError,
	getSpellCostRequirementForOption,
	hasHexproofFromQuality,
	hasLegalModalCombination,
	hasProtectionFrom,
	initiateLibrarySearch,
	isAbilityActivationConditionMet,
	isTargetStillValid,
	isUnconfirmedAttackersStep,
	legalAuraAttachCandidates,
	loseTheGame,
	modalCandidateModeStatus,
	moveStackSpellToZone,
	p10AddManaOptions,
	payManaWithAutoTap,
	perOpponentTargetError,
	playerHasHexproofFrom,
	playerHasShroud,
	pushMonarchInherentTrigger,
	recordUsedModalModes,
	resolveActivatedManaAbility,
	resolveCastOptionForAction,
	resolveStackItemCompiledEffects,
	resolveTargetDivisionsForSpecs,
	resolveTopOfStack,
	resolveTriggerPrompt,
	resumePendingCostPayment,
	resumeStackItem,
	runSuspendUpkeep,
	setMonarch,
	specTargetCandidates,
	spellSpendContext,
	stackAbilitySourceMatchesFilter,
	stackItemAwaitsPrompt,
	stackSpellMatchesFilterQualifiers,
	triggerEventContext,
	triggerItemEffect,
	triggerItemModal,
	triggerItemTargetSpecs,
	triggerSourceObject,
	triggerTargetCandidates,
	triggerTargetStillLegal,
	tryRegenerateInsteadOfDestroy,
	validateTargetLegality
});

