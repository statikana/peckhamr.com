import { describeModalModes, expandModalEffects } from '../compiler/index.ts';
import { enteringNotices } from '../compiler/support.ts';
import type { ModalDef, ObjectFilter, TargetSpec } from '../ir.ts';
import { buildTokenScryfallCard, withStackItemText } from '../oracle.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	DelayedTrigger,
	DelayedTriggerEffect,
	GamePhase,
	GameState,
	PendingPrompt,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	TargetRef,
	TriggerEventLki,
	ZoneType
} from '../types.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	effectivePromptChoice,
	effectivePromptPurpose,
	enqueueChoicePrompt,
	registerPromptHandler,
	validateChoiceAnswer
} from './choices.ts';
import { validateAndNormalizeTargetDivisions } from './copyPreventionAndEffects.ts';
import { getObjectKickerInfo, isObjectEscaped, isObjectEvoked } from './costs.ts';
import {
	recordP20bCardPutIntoGraveyard,
	recordP20bCreatureDamageToPlayer,
	recordP20bPermanentEnteredBattlefield
} from './costsWave7.ts';
import { releaseExiledUntilOpponentMonarch } from './effectsWave11.ts';
import {
	executeEffectSteps,
	interpretableNow,
	optionalPrefix,
	staticallyInterpretable
} from './effects.ts';
import { pushInitiativeUpkeepTrigger, pushRingEndOfCombatTriggers } from './effectsWave5.ts';
import { matchesP19aStackTargetSpec } from './effectsWave7.ts';
import {
	addLog,
	computeLoopBoardFingerprints,
	enqueueGuidedResolutionPrompt,
	findPermanentOnBoard,
	getSagaFinalChapterNumber,
	H,
	hasBlockingReplacementOrCommanderPrompt,
	hasKeyword,
	LOOP_TRIGGER_THRESHOLD,
	MAX_STACK_FOR_TRIGGERS,
	MAX_TRIGGERS_PER_TURN,
	revealFaceDownObjects,
	triggerPathCounts
} from './engineHost.ts';
import { emitEvent, registerEventHandler } from './events.ts';
import {
	instanceFaceOptions,
	matchesColorFilter,
	resolveObjectFaces,
	stackItemFaceOptions
} from './faces.ts';
import {
	checkDayNightUntapTransition,
	enqueueParadigmMain1Triggers,
	wave5TriggerTargetSpecs
} from './framesBattlesAndKeywordsWave5.ts';
import { getEffectiveUsedModalModes, validatePawprintBudget } from './framesModalsWave6.ts';
import { enqueueP21CleanupDelayedTriggers } from './framesWave7.ts';
import {
	filterTriggerDifferentPlayerCandidates,
	isModalRandomActive,
	resolveWave8ModalEffectiveBounds
} from './framesWave8.ts';
import { recordUpkeepBeginForEcho } from './keywordsWave3.ts';
import { recordDamageSourceWave4, wave4TriggerTargetSpecs } from './keywordsWave4.ts';
import { enqueueEpicUpkeepTriggers, wave6TriggerTargetSpecs } from './keywordsWave6.ts';
import { isObjectBlitzed, isObjectForetold } from './kicker.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	evaluateAmount,
	evaluateCondition,
	type FilterContext,
	matchesObjectFilter,
	objectManaValue
} from './objectFilter.ts';
import { nextRandom, uid } from './random.ts';
import { checkAndEmitCrimeCommitted } from './reflexiveManaAndActions.ts';
import { isGraveyardTargetingBlocked, isPermanentBlockedByCantBeTargetedBy } from './staticsWave7.ts';
import { playerProtectedFromSourceWave8 } from './staticsWave8.ts';
import {
	flushTriggers,
	matchTriggers,
	type PendingTrigger,
	withTriggersDeferred
} from './triggers.ts';
import { rewriteInlineManaStepsP19b, withActiveTapActorId } from './triggersWave7.ts';
import { recordP22bTurnEvent } from './triggersWave8.ts';

/**
 * Delayed end-step triggers created by resolving effects (Final Fortune, Corpse Dance). These are
 * stored in state with their own legacy effects, not compiled from a card's abilities; Phase 3's
 * delayed effects replace them. Pushed after the beginning-of-end-step triggers, as before.
 */
function runDelayedTriggers(state: GameState, phase: GamePhase, activePlayer: PlayerGameState): void {
	if (state.delayedTriggers && state.delayedTriggers.length > 0) {
		const remainingDelayed: DelayedTrigger[] = [];
		for (const dt of state.delayedTriggers) {
			const matchesTurn =
				(!dt.targetPlayerId || dt.targetPlayerId === activePlayer.playerId) &&
				(!dt.waitUntilAfterTurn || state.turnNumber > dt.waitUntilAfterTurn) &&
				dt.notDuringTurn !== `${state.turnNumber}:${state.activePlayerIndex}`;
			if (dt.triggerPhase === phase && matchesTurn) {
				const isCompiled = dt.delayedEffect?.kind === 'compiledDelayed';
				const targets: TargetRef[] = [];
				if (!isCompiled && dt.targetInstanceId) {
					const found = findPermanentOnBoard(state, dt.targetInstanceId);
					if (
						found &&
						(dt.targetObjectVersion === undefined ||
							found.inst.objectVersion === dt.targetObjectVersion)
					) {
						targets.push({
							kind: 'permanent',
							id: found.inst.instanceId,
							label: found.inst.card.name
						});
					}
				}
				const delayedEffect: DelayedTriggerEffect | undefined =
					dt.delayedEffect ??
					(dt.targetInstanceId
						? {
								kind: 'exile',
								targetInstanceId: dt.targetInstanceId,
								targetObjectVersion: dt.targetObjectVersion
							}
						: undefined);
				const compiledMeta =
					delayedEffect?.kind === 'compiledDelayed' ? delayedEffect : undefined;
				const phaseLabel =
					phase === 'upkeep'
						? 'Delayed Upkeep Trigger'
						: phase === 'end_combat'
							? 'Delayed End of Combat Trigger'
							: phase === 'cleanup'
								? 'Delayed Cleanup Step Trigger'
								: 'Delayed End Step Trigger';
				// --- Track P20a ---
				const effControllerId =
					delayedEffect?.kind === 'sacrifice' && delayedEffect.byCurrentController
						? (findPermanentOnBoard(state, delayedEffect.targetInstanceId)?.controller.playerId ??
							dt.controllerId)
						: dt.controllerId;
				// --- End Track P20a ---
				const stkItem: StackItem = withStackItemText(
					{
						id: uid('stk', state),
						sourceInstanceId: compiledMeta ? (dt.sourceInstanceId ?? dt.id) : dt.id,
						card: dt.sourceCard,
						controllerId: effControllerId,
						kind: 'triggered',
						title: `${dt.sourceCard.name} (${phaseLabel})`,
						targets,
						targetObjectVersions: H().captureTargetObjectVersions(state, targets),
						xValue: compiledMeta?.xValue ?? 0,
						...(compiledMeta?.kickedCount !== undefined ? { sourceKickedCount: compiledMeta.kickedCount } : {}),
						...(compiledMeta?.kickedTags?.length ? { sourceKickedTags: [...compiledMeta.kickedTags] } : {}),
						...(compiledMeta?.kickedTagCounts ? { sourceKickedTagCounts: { ...compiledMeta.kickedTagCounts } } : {}),
						...(delayedEffect ? { delayedEffect } : {}),
						requiresGuidedResolution: false,
						createdAt: Date.now()
					},
					dt.description || ''
				);
				state.stack.push(stkItem);
				addLog(
					state,
					'trigger',
					`Delayed trigger from ${dt.sourceCard.name} went onto the Stack: "${dt.description}"`,
					dt.controllerId
				);
			} else {
				remainingDelayed.push(dt);
			}
		}
		state.delayedTriggers = remainingDelayed;
	}
}

/**
 * CR 715.3b: As a player's precombat main phase begins, that player puts a lore counter on each
 * Saga they control with one or more chapter abilities. This turn-based action doesn't use the stack.
 */
function executePrecombatMainSagaLoreTurnBasedAction(
	state: GameState,
	activePlayer: PlayerGameState
): void {
	for (const perm of [...activePlayer.battlefield]) {
		if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
		if (getSagaFinalChapterNumber(state, perm) <= 0) continue;
		H().addCountersToPermanent(state, perm, 'lore', 1);
	}
}

const MONARCH_DESIGNATION_CARD: ScryfallCard = buildTokenScryfallCard('monarch-designation', {
	name: 'The Monarch',
	typeLine: 'Designation',
	power: 0,
	toughness: 0,
	colors: [],
	keywords: []
});

export function pushMonarchInherentTrigger(
	state: GameState,
	monarchPlayer: PlayerGameState,
	inherentTrigger: NonNullable<StackItem['inherentTrigger']>,
	title: string,
	description: string
): void {
	const stkItem: StackItem = withStackItemText(
		{
			id: uid('mtrig', state),
			sourceInstanceId: `designation_monarch_${monarchPlayer.playerId}`,
			card: MONARCH_DESIGNATION_CARD,
			ownerId: monarchPlayer.playerId,
			controllerId: monarchPlayer.playerId,
			kind: 'triggered',
			title,
			targets: [],
			xValue: 0,
			inherentTrigger,
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		description
	);
	state.stack.push(stkItem);
	addLog(
		state,
		'trigger',
		`${title} triggered (${monarchPlayer.username}): "${description}"`,
		monarchPlayer.playerId
	);
}

/**
 * CR 726.1–3: Makes `playerId` the monarch. If that player is already the monarch, nothing
 * changes and no `BecameMonarch` event is emitted (CR 726.3).
 */
export function setMonarch(state: GameState, playerId: string): void {
	const target = state.players.find((p) => p.playerId === playerId && !p.lost);
	if (!target) return;
	const previousMonarchId = state.monarchPlayerId ?? null;
	if (previousMonarchId === playerId) return;
	state.monarchPlayerId = playerId;
	releaseExiledUntilOpponentMonarch(state, playerId);
	noteLayerInputsChanged(state);
	addLog(state, 'rule', `${target.username} became the monarch (CR 726).`, playerId);
	emitEvent(state, {
		kind: 'BecameMonarch',
		playerId,
		previousMonarchId
	});
	flushTriggers(state);
}

/**
 * Sets the current phase/step and emits PhaseBegin. `activePlayer` defaults to the player at
 * `activePlayerIndex`; enterEndStep passes the player it was given.
 */
export function beginPhase(state: GameState, phase: GamePhase, activePlayer?: PlayerGameState): void {
	state.phase = phase;
	const active = activePlayer ?? state.players[state.activePlayerIndex];
	// CR 703.3: Turn-based actions at the beginning of a step happen FIRST, before any
	// "At the beginning of [step]" triggers go onto the stack. Triggers from the turn-based action
	// wait until state-based actions have been checked (CR 704.3, 603.3).
	let stepTurnBasedPaused = false;
	withTriggersDeferred(state, () => {
		if (phase === 'untap' && active && !active.lost) {
			// --- Track P15: Day/Night turn-based transition at start of untap (CR 732.5, CR 502.4) ---
			checkDayNightUntapTransition(state);
			// --- End Track P15 ---
			// --- Track P11 ---
			stepTurnBasedPaused = H().executeUntapTurnBasedActions(state, active);
			// --- End Track P11 ---
		} else if (phase === 'draw' && active && !active.lost) {
			H().executeDrawTurnBasedAction(state, active);
		} else if (phase === 'main1' && active && !active.lost) {
			executePrecombatMainSagaLoreTurnBasedAction(state, active);
		} else if (phase === 'declare_attackers') {
			state.combat.active = false;
			state.combat.attackers = [];
			// --- Track P18a ---
			delete state.combat.bands;
			// --- End Track P18a ---
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.blockersDeclared = false;
			state.combat.damageDealtFirstStrike = false;
			state.combat.damageDealtNormal = false;
			state.combat.dealtFirstStrikeDamageIds = [];
			state.combat.awaitingAttackersDeclaration = false;
			noteLayerInputsChanged(state);
			if (active && !active.lost) {
				if (active.isBot) {
					H().executeBotDeclareAttackersTurnBasedAction(state, active);
				} else {
					state.combat.awaitingAttackersDeclaration = true;
					stepTurnBasedPaused = true;
				}
			}
		} else if (phase === 'declare_blockers') {
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.blockersDeclared = false;
			stepTurnBasedPaused = !H().advanceBotBlockerDeclarations(state);
		} else if (phase === 'first_strike_damage') {
			stepTurnBasedPaused = H().executeCombatDamageStep(state, true);
		} else if (phase === 'combat_damage') {
			stepTurnBasedPaused = H().executeCombatDamageStep(state, false);
		} else if (phase === 'end_step' && active) {
			for (const p of state.players) {
				for (const ex of p.exile) {
					if (ex.playableFromExileBy?.expiresAtNextEndStepOfPlayerId === active.playerId) {
						ex.playableFromExileBy = undefined;
					}
				}
			}
		} else if (phase === 'cleanup') {
			H().clearEndOfTurnAndDamage(state);
		}
		if (
			!stepTurnBasedPaused &&
			(phase === 'first_strike_damage' || phase === 'combat_damage') &&
			hasBlockingReplacementOrCommanderPrompt(state)
		) {
			state.pendingProcedure = {
				kind: 'combat_damage_step',
				phase: 'after_damage',
				isFirstStrikeStep: phase === 'first_strike_damage'
			};
			stepTurnBasedPaused = true;
		}
		if (
			!stepTurnBasedPaused &&
			(phase === 'declare_attackers' ||
				phase === 'declare_blockers' ||
				phase === 'first_strike_damage' ||
				phase === 'combat_damage')
		) {
			H().checkStateBasedActions(state);
		}
	});
	if (stepTurnBasedPaused || state.status === 'finished') return;
	// --- Track P10 ---
	if (phase === 'declare_blockers') {
		emitUnblockedAttackersEvents(state);
	}
	// --- End Track P10 ---
	// --- Track P16b ---
	if (phase === 'begin_combat') {
		state.combatPhasesCountThisTurn = (state.combatPhasesCountThisTurn ?? 0) + 1;
		noteLayerInputsChanged(state);
	}
	// --- End Track P16b ---
	emitEvent(state, {
		kind: 'PhaseBegin',
		phase,
		activePlayerId: active?.playerId ?? null
	});
	// --- Track P16b ---
	if (phase === 'upkeep' && active) {
		active.hadUpkeepThisGame = true;
	}
	// --- End Track P16b ---
	// --- Track P18a: CR 702.50a Epic upkeep delayed triggered abilities ---
	if (phase === 'upkeep' && active && !active.lost) {
		enqueueEpicUpkeepTriggers(state, active);
	}
	// --- End Track P18a ---
	// --- Track P21: CR 514.3a Cleanup-step sacrifice delayed triggers (Necromancy) ---
	if (phase === 'cleanup') {
		enqueueP21CleanupDelayedTriggers(state);
	}
	// --- End Track P21 ---
	// Triggered abilities go on the stack now: the callers check the stack right after this.
	flushTriggers(state);
}

// --- Track P10 ---
export function emitUnblockedAttackersEvents(state: GameState): void {
	if (!state.combat.active || state.combat.attackers.length === 0) return;
	const byDefender = new Map<string, string[]>();
	for (const atk of state.combat.attackers) {
		if (atk.blockerInstanceIds.length > 0 || atk.wasBlocked) continue;
		const permFound = findPermanentOnBoard(state, atk.attackerInstanceId);
		if (!permFound || permFound.inst.phasedOut) continue;
		let arr = byDefender.get(atk.defenderPlayerId);
		if (!arr) {
			arr = [];
			byDefender.set(atk.defenderPlayerId, arr);
		}
		arr.push(atk.attackerInstanceId);
	}
	for (const [defenderPlayerId, attackerIds] of byDefender) {
		if (attackerIds.length > 0) {
			emitEvent(state, {
				kind: 'UnblockedAttackers',
				defenderPlayerId,
				attackerIds
			});
		}
	}
}
// --- End Track P10 ---

// Event dispatch (Phase 5). Every event is matched against compiled triggered abilities
// (runtime/triggers.ts); matches wait for the next flushTriggers. PhaseBegin also runs the suspend
// keyword (before matching, as the old upkeep loop did) and delayed end-step triggers (after the
// beginning-of-end-step triggers are on the stack).
for (const kind of [
	'SpellCopied',
	'AttackDeclared',
	'BlockersDeclared',
	'DamageDealt',
	'CounterPlaced',
	'CounterRemoved',
	'BecameTarget',
	'Attached',
	'TappedForMana',
	'GainLife',
	'CardDrawn',
	'BecomesTapped',
	'CardDiscarded',
	'Transformed',
	'TurnedFaceUp',
	'Investigated',
	'Surveilled',
	'Explored',
	'Connived',
	'BecomesCrewed',
	'BecomesSaddled',
	'Foretold',
	'Plotted',
	'CombatDamageBatchPlayer',
	'BecameMonarch',
	'Exerted',
	'Amassed',
	'ManifestDread',
	'BecameMonstrous',
	// --- Track P10 ---
	'UnblockedAttackers',
	'BecomesUntapped',
	'Scried',
	'CrimeCommitted',
	'Exploited',
	'ManaExpended',
	'Sacrificed',
	'GraveyardLeaveBatch',
	'Discovered',
	'Foraged',
	// --- End Track P10 ---
	// --- Track P12 ---
	'ClassLevelGained',
	'CaseSolved',
	'BecameRenowned',
	// --- End Track P12 ---
	// --- Track P13 & P15 ---
	'DoorUnlocked',
	'RoomFullyUnlocked',
	'RingTempted',
	'DungeonRoomEntered',
	'DungeonCompleted',
	'TookInitiative',
	// --- End Track P13 & P15 ---
	// --- Track P16b & P18a ---
	'Mutated',
	'SoulbondPaired',
	'HauntedCreatureDied',
	'DayNightChanged',
	'FacedDilemma',
	'LifeLost',
	'ExhaustActivated',
	'Unattached',
	'PhasedIn',
	'CollectedEvidence',
	'LandPlayed',
	'PlayerTargeted',
	// --- End Track P16b & P18a ---
	// --- Track P19b ---
	'ManaAddedByLandAbility',
	'LibrarySearched',
	'PlayerLostGame',
	'CoinFlipped',
	'DieRolled',
	'EnergyGained',
	'Proliferated',
	'Evolved',
	'CrewedVehicle',
	// --- End Track P19b ---
	// --- Track P22b ---
	'AbilityActivated',
	'PlayersFinishedVoting',
	'Clash',
	'LibraryShuffled',
	'SpellCountered',
	'SagaChapterResolved',
	'SaddledMount',
	// --- End Track P22b ---
	// --- Wave 9 ---
	'TokenCreated',
	'GiftGiven',
	'AttackTriggered'
	// --- End Wave 9 ---
] as const) {
	registerEventHandler(kind, (state, ev) => {
		// --- Track P22b ---
		recordP22bTurnEvent(state, ev);
		// --- End Track P22b ---
		// --- Track P12 ---
		if (ev.kind === 'DamageDealt') {
			recordDamageSourceWave4(state, ev.sourceId, ev.amount);
			// --- Track P20b ---
			if (ev.targetKind === 'player') {
				recordP20bCreatureDamageToPlayer(state, ev.targetId, ev.sourceId, ev.amount, ev.combat);
				noteLayerInputsChanged(state);
			}
			// --- End Track P20b ---
		}
		// --- End Track P12 ---
		// --- Track P16b ---
		if (ev.kind === 'CrimeCommitted') {
			const actor = state.players.find((p) => p.playerId === ev.playerId);
			if (actor && !actor.committedCrimeThisTurn) {
				actor.committedCrimeThisTurn = true;
				noteLayerInputsChanged(state);
			}
		}
		// --- End Track P16b ---
		matchTriggers(state, ev);
		// --- Track P13: Record per-turn targeting history AFTER matching Valiant triggers ---
		if (ev.kind === 'BecameTarget') {
			const list = (ev.object.targetedByControllerIdsThisTurn ??= []);
			if (!list.includes(ev.controllerId)) {
				list.push(ev.controllerId);
			}
		}
		// --- End Track P13 ---
	});
}
registerEventHandler('Cast', (state, ev) => {
	// --- Track P22b ---
	recordP22bTurnEvent(state, ev);
	// --- End Track P22b ---
	matchTriggers(state, ev);
	noteUnautomatedOnCast(state, ev.object, ev.playerId);
});
registerEventHandler('ZoneChange', (state, ev) => {
	// --- Track P20b ---
	if (!ev.ceasedToExist) {
		if (ev.to === 'battlefield' && ev.from !== 'battlefield') {
			recordP20bPermanentEnteredBattlefield(state, ev.object);
			noteLayerInputsChanged(state);
		}
		if (ev.to === 'graveyard' && ev.from !== 'graveyard') {
			recordP20bCardPutIntoGraveyard(state, ev.object);
			noteLayerInputsChanged(state);
		}
	}
	// --- End Track P20b ---
	matchTriggers(state, ev);
	if (ev.to === 'battlefield' && !ev.ceasedToExist) noteUnautomatedOnEnter(state, ev.object);
});

/**
 * CR 702.85a / 702.88a / Step E2: when an instant or sorcery is cast, log any unsupported keyword
 * or static notices on it once so players know to resolve them manually.
 */
function noteUnautomatedOnCast(state: GameState, obj: CardInstance, playerId: string): void {
	if (obj.isFaceDown) return;
	const card = effectiveCardForObject(obj);
	const view = resolveObjectFaces(card, instanceFaceOptions(obj, 'stack'));
	if (!view.types.includes('Instant') && !view.types.includes('Sorcery')) return;
	for (const n of enteringNotices(card)) {
		addLog(
			state,
			'rule',
			`${view.name}: ${n.text} is not automated — resolve manually.`,
			playerId
		);
	}
}

/**
 * Step E2 (plan section 2.7): when a permanent enters, say once which of its abilities the engine
 * won't act on: statics and replacement effects that aren't enforced, and triggered abilities whose
 * trigger it can't recognise (players apply those by hand, e.g. with "Resolve manually"). Logged on
 * entering only, never from state-based actions or layer evaluation. Display text only.
 */
function noteUnautomatedOnEnter(state: GameState, obj: CardInstance): void {
	if (obj.isFaceDown) return;
	const card = obj.copiableCard ?? obj.card;
	for (const n of enteringNotices(card)) {
		addLog(
			state,
			'rule',
			n.kind === 'triggerUnrecognised'
				? `${card.name} has an ability that isn't automated: ${n.text}`
				: `${card.name}: '${n.text}' is not enforced.`,
			obj.controllerId
		);
	}
}

registerEventHandler('PhaseBegin', (state, ev) => {
	const activePlayer = state.players.find((p) => p.playerId === ev.activePlayerId);
	if (ev.phase === 'upkeep' && activePlayer) {
		// --- Track P9 ---
		recordUpkeepBeginForEcho(state, activePlayer);
		// --- End Track P9 ---
		H().runSuspendUpkeep(state, activePlayer);
	}
	matchTriggers(state, ev);
	// --- Track P15: CR 702.192a / 722 Paradigm precombat main phase trigger ---
	if (ev.phase === 'main1' && activePlayer) {
		enqueueParadigmMain1Triggers(state, activePlayer);
		flushTriggers(state);
	}
	// --- End Track P15 ---
	if (
		(ev.phase === 'end_step' ||
			ev.phase === 'upkeep' ||
			ev.phase === 'end_combat' ||
			// --- Track P20a (CR 514.3a): Delayed cleanup-step triggers ---
			ev.phase === 'cleanup') &&
		activePlayer
	) {
		flushTriggers(state);
		if (ev.phase === 'end_step' && !activePlayer.lost && state.monarchPlayerId === activePlayer.playerId) {
			pushMonarchInherentTrigger(
				state,
				activePlayer,
				{ kind: 'monarchEndStepDraw', drawPlayerId: activePlayer.playerId },
				'The Monarch (End Step)',
				"At the beginning of the monarch's end step, that player draws a card."
			);
		}
		// --- Track P13 (CR 725.2 & CR 701.54c): Initiative upkeep venture & Ring Level 3 end-of-combat triggers ---
		if (ev.phase === 'upkeep' && !activePlayer.lost) {
			pushInitiativeUpkeepTrigger(state, activePlayer);
		}
		if (ev.phase === 'end_combat') {
			pushRingEndOfCombatTriggers(state);
		}
		// --- End Track P13 ---
		runDelayedTriggers(state, ev.phase, activePlayer);
	}
});

/** How the trigger's event object last existed on the battlefield (CR 603.10a, 608.2h). */
function triggerEventLki(state: GameState, t: PendingTrigger): TriggerEventLki | undefined {
	const obj = t.eventObject ?? t.source;
	const onBattlefield = findPermanentOnBoard(state, obj.instanceId);
	if (onBattlefield && onBattlefield.inst.objectVersion === obj.objectVersion) {
		const ev = evaluatePermanent(state, onBattlefield.inst);
		return {
			controllerId: onBattlefield.controller.playerId,
			ownerId: obj.ownerId,
			power: ev.power,
			toughness: ev.toughness,
			manaValue: objectManaValue(state, onBattlefield.inst),
			// --- Track P9 ---
			counters: { ...onBattlefield.inst.counters }
			// --- End Track P9 ---
		};
	}
	const lki = t.eventLki;
	// --- Track P9 ---
	const lkiCounters = lki?.counters ?? obj.lastKnownCounters;
	// --- End Track P9 ---
	return {
		controllerId: lki?.controllerId ?? obj.controllerId,
		ownerId: obj.ownerId,
		power: lki?.power ?? obj.lastKnownPower ?? (parseInt(obj.card.power ?? '0', 10) || 0),
		toughness: lki?.toughness ?? obj.lastKnownToughness ?? (parseInt(obj.card.toughness ?? '0', 10) || 0),
		manaValue: objectManaValue(state, obj),
		// --- Track P9 ---
		...(lkiCounters ? { counters: { ...lkiCounters } } : {})
		// --- End Track P9 ---
	};
}

/**
 * Builds the stack item for a triggered ability (also the "dummy" item an inline trigger resolves
 * with). The event the ability refers to is recorded in the `event*` fields, never in `targets`
 * ("that creature", "that player", "that many"; CR 603.7c); `eventObjectId` defaults to the source
 * ("When ~ enters, ... it ..."). `targets` holds only the targets chosen for the ability.
 */
export function triggerSourcePublicName(state: GameState, t: PendingTrigger): string {
	const foundSource = findPermanentOnBoard(state, t.source.instanceId);
	const src = foundSource?.inst ?? t.source;
	if (src.isFaceDown) {
		return src.faceDownLabel || 'Face-Down Permanent';
	}
	return (t.faceIndex !== undefined ? t.sourceCard.faces?.[t.faceIndex]?.name : undefined) ?? t.sourceCard.name;
}

export function triggeredStackItem(state: GameState, t: PendingTrigger, idPrefix: string): StackItem {
	const foundSource = findPermanentOnBoard(state, t.source.instanceId);
	const sourceEval = foundSource ? evaluatePermanent(state, foundSource.inst) : undefined;
	const sourceLkiPower = sourceEval?.power ?? t.source.lastKnownPower;
	const sourceLkiToughness = sourceEval?.toughness ?? t.source.lastKnownToughness;
	const eventObj = t.eventObject ?? t.source;
	const kickerLki = getObjectKickerInfo(state, t.sourceCard, t.source.instanceId);
	const sourceEvoked = isObjectEvoked(state, t.source.instanceId, undefined, t.source);
	const sourceEscaped = isObjectEscaped(state, t.source.instanceId, undefined, t.source);
	const sourceForetold = t.sourceForetold ?? isObjectForetold(state, t.source.instanceId, undefined, t.source);
	const sourceBlitzed = t.sourceBlitzed ?? isObjectBlitzed(state, t.source.instanceId, undefined, t.source);
	const sourceExertedThisTurn = Boolean(
		t.sourceExertedThisTurn ?? foundSource?.inst.exertedThisTurn ?? t.source.exertedThisTurn
	);
	const sourceChosenSubType =
		t.sourceChosenSubType ?? foundSource?.inst.chosenSubType ?? t.source.chosenSubType;
	const sourceChosenColor =
		t.sourceChosenColor ?? foundSource?.inst.chosenColor ?? t.source.chosenColor;
	// --- Track P11 ---
	const sourceChosenCardName =
		t.sourceChosenCardName ?? foundSource?.inst.chosenCardName ?? t.source.chosenCardName;
	// --- End Track P11 ---
	// --- Track P22a ---
	const sourceChosenCardType =
		foundSource?.inst.chosenCardType ?? t.source.chosenCardType;
	const sourceChosenNumber =
		foundSource?.inst.chosenNumber ?? t.source.chosenNumber;
	// --- End Track P22a ---
	const sourceMonstrous = t.sourceMonstrous ?? Boolean((foundSource?.inst ?? t.source).isMonstrous);
	// --- Track P12 ---
	const sourceIsRenowned = t.sourceIsRenowned ?? Boolean((foundSource?.inst ?? t.source).isRenowned);
	const sourceDevouredCount =
		t.sourceDevouredCount ?? (foundSource?.inst ?? t.source).devouredCount;
	// --- End Track P12 ---
	const sourceObjForProto = foundSource?.inst ?? t.source;
	const sourcePrototyped = Boolean(
		sourceObjForProto.prototyped || sourceObjForProto.copiableState?.prototyped
	);
	// --- Track P7 ---
	const sourceWasCast = Boolean(t.sourceWasCast ?? sourceObjForProto.wasCast);
	const sourceCastFromZone = t.sourceCastFromZone ?? sourceObjForProto.castFromZone;
	// --- End Track P7 ---
	// --- Track P15 ---
	const sourceGiftPromised = Boolean(t.sourceGiftPromised ?? sourceObjForProto.giftPromised);
	const sourceEnteredWithX = t.sourceEnteredWithX ?? sourceObjForProto.enteredWithX;
	const sourceCastWithImpending = Boolean(
		t.sourceCastWithImpending ?? sourceObjForProto.castWithImpending
	);
	// --- End Track P15 ---
	const sourceIsFaceDown = Boolean(foundSource?.inst.isFaceDown);
	const sourceFaceDownLabel = foundSource?.inst.faceDownLabel;
	const sourceFaceDownSpec = foundSource?.inst.faceDownSpec;
	const faceTitleName =
		(t.faceIndex !== undefined ? t.sourceCard.faces?.[t.faceIndex]?.name : undefined) ??
		t.sourceCard.name;
	const titleSource = sourceIsFaceDown ? sourceFaceDownLabel || 'Face-Down Permanent' : faceTitleName;
	const hasKickerInfo =
		kickerLki.count > 0 ||
		kickerLki.tags.length > 0 ||
		Boolean(kickerLki.tagCounts && Object.keys(kickerLki.tagCounts).length > 0);
	return withStackItemText(
		{
			id: uid(idPrefix, state),
			sourceInstanceId: t.source.instanceId,
			sourceObjectVersion: t.source.objectVersion,
			sourceLkiPower,
			sourceLkiToughness,
			...(hasKickerInfo
				? {
						sourceKickedCount: kickerLki.count,
						sourceKickedTags: [...kickerLki.tags],
						...(kickerLki.tagCounts && Object.keys(kickerLki.tagCounts).length > 0
							? { sourceKickedTagCounts: { ...kickerLki.tagCounts } }
							: {})
					}
				: {}),
			...(sourceEvoked ? { sourceEvoked: true } : {}),
			...(sourceEscaped ? { sourceEscaped: true } : {}),
			...(sourceForetold ? { sourceForetold: true } : {}),
			...(sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(sourceChosenSubType ? { sourceChosenSubType } : {}),
			...(sourceChosenColor ? { sourceChosenColor } : {}),
			// --- Track P11 ---
			...(sourceChosenCardName ? { sourceChosenCardName } : {}),
			...(t.grantSourceCard ? { grantSourceCard: t.grantSourceCard } : {}),
			...(t.grantFaceIndex !== undefined ? { grantFaceIndex: t.grantFaceIndex } : {}),
			...(t.grantAbilityIndex !== undefined ? { grantAbilityIndex: t.grantAbilityIndex } : {}),
			// --- End Track P11 ---
			// --- Track P22a ---
			...(sourceChosenCardType ? { sourceChosenCardType } : {}),
			...(sourceChosenNumber !== undefined ? { sourceChosenNumber } : {}),
			// --- End Track P22a ---
			...(sourceMonstrous ? { sourceMonstrous: true } : {}),
			// --- Track P12 ---
			...(sourceIsRenowned ? { sourceIsRenowned: true } : {}),
			...(sourceDevouredCount !== undefined ? { sourceDevouredCount } : {}),
			...(t.wave4Tag ? { wave4Tag: t.wave4Tag } : {}),
			...(t.wave4N !== undefined ? { wave4N: t.wave4N } : {}),
			...(t.wave4CostText !== undefined ? { wave4CostText: t.wave4CostText } : {}),
			// --- End Track P12 ---
			// --- Track P15 ---
			...(sourceGiftPromised ? { sourceGiftPromised: true } : {}),
			...(sourceEnteredWithX !== undefined ? { sourceEnteredWithX } : {}),
			...(sourceCastWithImpending ? { sourceCastWithImpending: true } : {}),
			...(t.gravestormCount !== undefined ? { gravestormCount: t.gravestormCount } : {}),
			...(t.giftKind ? { giftKind: t.giftKind } : {}),
			...(t.giftRecipientId ? { giftRecipientId: t.giftRecipientId } : {}),
			...(t.wave5Tag ? { wave5Tag: t.wave5Tag } : {}),
			...(t.wave5N !== undefined ? { wave5N: t.wave5N } : {}),
			...(t.wave5CostText !== undefined ? { wave5CostText: t.wave5CostText } : {}),
			...(t.wave5Card ? { wave5Card: t.wave5Card } : {}),
			// --- End Track P15 ---
			// --- Track P18a ---
			...(t.wave6Tag ? { wave6Tag: t.wave6Tag } : {}),
			...(t.wave6N !== undefined ? { wave6N: t.wave6N } : {}),
			...(t.wave6Card ? { wave6Card: t.wave6Card } : {}),
			...(t.wave6FaceIndex !== undefined ? { wave6FaceIndex: t.wave6FaceIndex } : {}),
			...(t.sourceTributePaid ? { sourceTributePaid: true } : {}),
			...(t.sourceCounterPutOnThisTurn ? { sourceCounterPutOnThisTurn: true } : {}),
			// --- End Track P18a ---
			...(sourcePrototyped ? { sourcePrototyped: true } : {}),
			// --- Track P7 ---
			...(sourceWasCast ? { sourceWasCast: true } : {}),
			...(sourceCastFromZone ? { sourceCastFromZone } : {}),
			// --- End Track P7 ---
			card: t.sourceCard,
			...(t.faceIndex !== undefined ? { faceIndex: t.faceIndex } : {}),
			...(sourceIsFaceDown
				? {
						isFaceDown: true,
						...(sourceFaceDownSpec ? { faceDownSpec: { ...sourceFaceDownSpec } } : {}),
						...(sourceFaceDownLabel ? { faceDownLabel: sourceFaceDownLabel } : {})
					}
				: {}),
			controllerId: t.controllerId,
			kind: 'triggered',
			title: `${titleSource} (${t.label})`,
			targets: [],
			xValue:
				t.ability.trigger.event === 'turnFaceUp' ||
				t.ability.trigger.event === 'becameMonstrous' ||
				// --- Track P12 ---
				t.ability.trigger.event === 'becameRenowned' ||
				// --- End Track P12 ---
				Boolean(t.isBecameMonstrous)
					? (t.amount ?? 0)
					: 0,
			requiresGuidedResolution: false,
			createdAt: Date.now(),
			lkiPower: t.amount,
			triggeredAbilityIndex: t.ability.abilityIndex,
			...(t.delayedSubStepIndex !== undefined ? { delayedSubStepIndex: t.delayedSubStepIndex } : {}),
			...(t.ability.grantedKeyword ? { grantedKeyword: t.ability.grantedKeyword } : {}),
			// --- Track P10 ---
			...(t.grantedAbilityText ? { grantedAbilityText: t.grantedAbilityText } : {}),
			// --- End Track P10 ---
			eventObjectId: eventObj.instanceId,
			eventObjectVersion: eventObj.objectVersion,
			// --- Track P18a: Forward t.eventPlayerId when t.eventPlayer is omitted (e.g. Poisonous N) ---
			...((t.eventPlayer ?? t.eventPlayerId)
				? { eventPlayerId: t.eventPlayer ?? t.eventPlayerId }
				: {}),
			// --- End Track P18a ---
			...(t.defendingPlayerId ? { defendingPlayerId: t.defendingPlayerId } : {}),
			...(t.amount !== undefined ? { eventAmount: t.amount } : {}),
			...(t.targetStackItemId ? { eventStackItemId: t.targetStackItemId } : {}),
			...(t.triggerEventStackItem ? { triggerEventStackItem: t.triggerEventStackItem } : {}),
			// --- Track P19b ---
			...(t.lastTappedManaColors ? { lastTappedManaColors: [...t.lastTappedManaColors] } : {}),
			...(t.treasureManaSpent ? { treasureManaSpent: true } : {}),
			// --- End Track P19b ---
			...(t.stormCount !== undefined ? { stormCount: t.stormCount } : {}),
			...(t.isChapterAbility || t.ability.trigger.isChapterAbility ? { isChapterAbility: true } : {}),
			...(t.ability.ward ? { wardCost: t.ability.ward.cost } : {}),
			eventLki: triggerEventLki(state, t)
		},
		t.ability.text
	);
}

/**
 * Executes a triggered ability's effect: on the IR interpreter when its compiled effect is
 * interpretable, otherwise on the legacy ParsedEffect path (with the legacy event target, as the
 * pre-IR engine passed it). Used by inline triggers; stacked ones go through resolveTopOfStack,
 * which makes the same choice.
 */
export function executeTriggerEffects(state: GameState, controller: PlayerGameState, item: StackItem): void {
	const compiled = H().triggerItemEffect(item);
	if (compiled && staticallyInterpretable(compiled) && interpretableNow(state, item, compiled, controller, false)) {
		triggerPathCounts.interpreter++;
		// --- Track P19b ---
		const effectiveSteps = rewriteInlineManaStepsP19b(compiled.steps, item.lastTappedManaColors);
		if (effectiveSteps.length === 0) return;
		withActiveTapActorId(controller.playerId, () => {
			executeEffectSteps(
				state,
				{
					controller,
					sourceId: item.sourceInstanceId,
					sourceCard: item.card,
					title: item.title,
					item,
					targets: item.targets,
					targetSpecs: compiled.targets,
					xValue: item.xValue,
					...H().triggerEventContext(item)
				},
				effectiveSteps
			);
		});
		// --- End Track P19b ---
		return;
	}
	// Not automated: an inline trigger (a triggered mana ability) can't be resolved manually.
	triggerPathCounts.manual++;
	addLog(state, 'rule', `${item.title} isn't automated and did nothing.`, controller.playerId);
}

/** Whether a triggered stack item has an optional ("may") choice (CR 731.2b). */
function triggerItemIsOptional(item: StackItem): boolean {
	const compiled = H().triggerItemEffect(item);
	if (!compiled || !staticallyInterpretable(compiled, true)) return false;
	return optionalPrefix(compiled.steps) > 0 || compiled.steps.some((s) => Boolean(s.optional));
}

function handleTriggerBackstopReached(state: GameState, t: PendingTrigger, reason: string): null {
	addLog(state, 'rule', reason, t.controllerId);
	const activePlayers = state.players.filter((p) => !p.lost);
	const human =
		activePlayers.find((p) => !p.isBot && p.playerId === t.controllerId) ??
		activePlayers.find((p) => !p.isBot && p.playerId === state.players[state.activePlayerIndex]?.playerId) ??
		activePlayers.find((p) => !p.isBot);
	if (human) {
		if (!state.pendingPrompts.some((p) => p.purpose === 'guided_resolution')) {
			enqueueGuidedResolutionPrompt(
				state,
				human.playerId,
				`Trigger Safety Cap Reached (${t.sourceCard.name})`,
				reason,
				'The runaway trigger safety cap was reached. Apply any manual adjustments below, then click Done.'
			);
		}
	} else {
		revealFaceDownObjects(state);
		state.status = 'finished';
		state.winnerPlayerId = null;
		state.winnerId = undefined;
		state.pendingPrompts = [];
		state.stack = [];
	}
	return null;
}

const MANDATORY_LOOP_HANDLER = 'mandatory_loop_choice';

registerPromptHandler(MANDATORY_LOOP_HANDLER, (state, prompt, answer) => {
	const mode = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const data = (prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined) as
		| { abilityKey?: string; sourceName?: string; label?: string }
		| undefined;
	if (mode === 0) {
		revealFaceDownObjects(state);
		state.status = 'finished';
		state.winnerPlayerId = null;
		state.winnerId = undefined;
		state.pendingPrompts = [];
		state.stack = [];
		addLog(
			state,
			'rule',
			`CR 104.4b: The game ended in a draw due to an unbreakable mandatory trigger loop${data?.sourceName ? ` (${data.sourceName})` : ''}.`,
			prompt.playerId
		);
		return;
	}
	const byAbility = state.triggersPlacedThisTurn?.byAbility;
	if (byAbility) {
		for (const [k, entry] of Object.entries(byAbility)) {
			const currentLimit = entry.limit ?? LOOP_TRIGGER_THRESHOLD;
			if (k === data?.abilityKey || entry.cycles >= currentLimit) {
				entry.limit = currentLimit + LOOP_TRIGGER_THRESHOLD;
			}
		}
	}
	addLog(
		state,
		'rule',
		`Continuing mandatory trigger loop for ${LOOP_TRIGGER_THRESHOLD} more trigger cycles.`,
		prompt.playerId
	);
});

/** Target specs the trigger target choice supports (zones it can enumerate). */
function triggerSpecsSupported(specs: TargetSpec[]): boolean {
	return specs.every((sp) => {
		if (sp.kind === 'player') return true;
		const z = sp.filter.zone ?? 'battlefield';
		return z === 'battlefield' || z === 'graveyard' || z === 'stack' || z === 'exile';
	});
}

/** The target specs a triggered stack item chooses on the interpreter path (empty: none / legacy). */
export function triggerItemTargetSpecs(item: StackItem): TargetSpec[] {
	// --- Track P12: Backup & Mentor target specs ---
	const w4Specs = wave4TriggerTargetSpecs(item);
	if (w4Specs) return w4Specs;
	// --- End Track P12 ---
	// --- Track P15: Provoke target specs ---
	const w5Specs = wave5TriggerTargetSpecs(item);
	if (w5Specs) return w5Specs;
	// --- End Track P15 ---
	// --- Track P18a: Haunt target specs (CR 702.55a–c) ---
	const w6Specs = wave6TriggerTargetSpecs(item);
	if (w6Specs.length > 0) return w6Specs;
	// --- End Track P18a ---
	const compiled = H().triggerItemEffect(item);
	if (!compiled || !staticallyInterpretable(compiled, true) || !triggerSpecsSupported(compiled.targets)) return [];
	return compiled.targets;
}

/** The object a triggered ability's source is (wherever it is now), for "another" filters. */
export function triggerSourceObject(state: GameState, item: StackItem): CardInstance | undefined {
	for (const p of state.players) {
		for (const zone of [p.battlefield, p.graveyard, p.exile, p.hand, p.command, p.library]) {
			const c = zone.find((x) => x.instanceId === item.sourceInstanceId);
			if (c) return c;
		}
	}
	return undefined;
}

/** Whether a permanent can be targeted by an ability of `controllerId` from `sourceCard` (CR 702.11, 702.18, 702.16). */
function permanentTargetable(
	state: GameState,
	inst: CardInstance,
	controllerId: string,
	owner: string,
	sourceCard: ScryfallCard,
	// --- Track P20a ---
	sourcePerm?: CardInstance,
	sourceKind: 'spell' | 'ability' = 'ability'
	// --- End Track P20a ---
): boolean {
	if (hasKeyword(inst, 'Shroud', state)) return false;
	if (owner !== controllerId && (hasKeyword(inst, 'Hexproof', state) || H().hasHexproofFromQuality(inst, sourceCard, state))) return false;
	// --- Track P20a ---
	if (H().hasProtectionFrom(inst, sourceCard, state, sourcePerm, false, controllerId)) return false;
	if (
		isPermanentBlockedByCantBeTargetedBy(
			state,
			inst,
			controllerId,
			sourceCard,
			sourcePerm,
			sourceKind
		).blocked
	) {
		return false;
	}
	return true;
	// --- End Track P20a ---
}

// --- Track P16a ---
export function stackSpellMatchesFilterQualifiers(
	state: GameState,
	stk: StackItem,
	filter: ObjectFilter,
	ctx: FilterContext
): boolean {
	if (stk.kind !== 'spell' || !stk.card) return true;
	const stkFace = resolveObjectFaces(stk.card, stackItemFaceOptions(stk));
	if (filter.types?.length && !filter.types.some((t) => stkFace.types.includes(t))) return false;
	if (filter.allTypes?.length && !filter.allTypes.every((t) => stkFace.types.includes(t))) return false;
	if (filter.notTypes?.length && filter.notTypes.some((t) => stkFace.types.includes(t))) return false;
	if (filter.supertypes?.length && !filter.supertypes.some((t) => stkFace.supertypes.includes(t))) {
		return false;
	}
	if (filter.notSupertypes?.length && filter.notSupertypes.some((t) => stkFace.supertypes.includes(t))) {
		return false;
	}
	if (filter.subtypes?.length && !filter.subtypes.some((t) => stkFace.subtypes.includes(t))) {
		return false;
	}
	if (filter.colors?.length && !matchesColorFilter(stkFace.colors, filter.colors)) return false;
	if (filter.notColors?.length && matchesColorFilter(stkFace.colors, filter.notColors)) return false;
	if (filter.multicolored !== undefined && (stkFace.colors.length >= 2) !== filter.multicolored) {
		return false;
	}
	if (filter.monocolored !== undefined && (stkFace.colors.length === 1) !== filter.monocolored) {
		return false;
	}
	if (filter.historic !== undefined) {
		const isHist =
			!stk.isFaceDown &&
			(stkFace.supertypes.includes('Legendary') ||
				stkFace.types.includes('Artifact') ||
				stkFace.subtypes.includes('Saga'));
		if (isHist !== filter.historic) return false;
	}
	if (filter.manaValue) {
		const mv = objectManaValue(state, stk);
		const rhs = evaluateAmount(filter.manaValue.value, ctx);
		const op = filter.manaValue.op;
		const ok =
			op === '='
				? mv === rhs
				: op === '<'
					? mv < rhs
					: op === '<='
						? mv <= rhs
						: op === '>'
							? mv > rhs
							: mv >= rhs;
		if (!ok) return false;
	}
	return true;
}
// --- End Track P16a ---

/** Every legal target for one target spec (CR 115, 603.3d). */
export function specTargetCandidates(
	state: GameState,
	controllerId: string,
	sourceCard: ScryfallCard,
	source: CardInstance | undefined,
	spec: TargetSpec,
	excludeStackItemId?: string,
	stackItem?: StackItem
): TargetRef[] {
	const out: TargetRef[] = [];
	if (spec.kind === 'player' || spec.kind === 'objectOrPlayer') {
		const rel = spec.player?.relation ?? 'any';
		for (const p of state.players) {
			if (p.lost) continue;
			if ((rel === 'opponent' || rel === 'each_opponent') && p.playerId === controllerId) continue;
			if (rel === 'you' && p.playerId !== controllerId) continue;
			if (H().playerHasShroud(state, p) || H().playerHasHexproofFrom(state, p, controllerId)) continue;
			// --- Track P22a: CR 702.16j Player protection from chosen card type ---
			if (playerProtectedFromSourceWave8(state, p.playerId, sourceCard, source)) continue;
			// --- End Track P22a ---
			out.push({ kind: 'player', id: p.playerId, label: p.username });
		}
	}
	if (spec.kind === 'player') return out;
	// --- Precon Bragos Spirit: CR 115.1 "target spell or permanent" ---
	if (spec.alsoSpells) {
		const { alsoSpells: _also, ...permSpec } = spec;
		return [
			...specTargetCandidates(
				state,
				controllerId,
				sourceCard,
				source,
				{ ...permSpec, kind: 'object', filter: { zone: 'stack', stackKind: 'spell' } },
				excludeStackItemId,
				stackItem
			),
			...specTargetCandidates(state, controllerId, sourceCard, source, permSpec, excludeStackItemId, stackItem)
		];
	}
	// --- End Precon Bragos Spirit ---
	const ctx: FilterContext = {
		state,
		controllerId,
		source,
		...(stackItem ? { stackItem } : {})
	};
	const zone = spec.filter.zone ?? 'battlefield';
	if (zone === 'stack') {
		const stackKind = spec.filter.stackKind ?? 'spell';
		for (const stk of state.stack) {
			if (excludeStackItemId && stk.id === excludeStackItemId) continue;
			if (stackKind === 'spell' && stk.kind !== 'spell') continue;
			if (stackKind === 'ability' && stk.kind !== 'activated' && stk.kind !== 'triggered') continue;
			if (stackKind === 'activatedAbility' && stk.kind !== 'activated') continue;
			if (stackKind === 'triggeredAbility' && stk.kind !== 'triggered') continue;
			if (
				source &&
				(stk.id === source.instanceId ||
					(stk.kind === 'spell' && stk.sourceInstanceId === source.instanceId))
			) {
				continue;
			}
			if (spec.filter.controller === 'opponent' && stk.controllerId === controllerId) continue;
			if (spec.filter.controller === 'you' && stk.controllerId !== controllerId) continue;
			// --- Track P10 ---
			if (spec.filter.wasNotCast === true && !stk.isCopy) continue;
			if (spec.filter.wasNotCast === false && stk.isCopy) continue;
			if (
				spec.filter.abilitySourceFilter &&
				!H().stackAbilitySourceMatchesFilter(
					state,
					stk,
					controllerId,
					spec.filter.abilitySourceFilter,
					source,
					stackItem
				)
			) {
				continue;
			}
			// --- End Track P10 ---
			if (stk.kind === 'spell' && stk.card) {
				const stkFace = resolveObjectFaces(stk.card, stackItemFaceOptions(stk));
				if (spec.filter.types?.length && !spec.filter.types.some((t) => stkFace.types.includes(t))) {
					continue;
				}
				if (spec.filter.notTypes?.length && spec.filter.notTypes.some((t) => stkFace.types.includes(t))) {
					continue;
				}
				if (spec.filter.colors?.length && !matchesColorFilter(stkFace.colors, spec.filter.colors)) {
					continue;
				}
				// --- Track P16a ---
				if (!stackSpellMatchesFilterQualifiers(state, stk, spec.filter, ctx)) continue;
				// --- End Track P16a ---
			}
			// --- Track P19a (CR 115.9) ---
			if (!matchesP19aStackTargetSpec(state, stk, spec, ctx)) continue;
			// --- End Track P19a ---
			out.push({ kind: 'stack', id: stk.id, label: stk.title });
		}
		return out;
	}
	// --- Track P20a ---
	const sourceKind: 'spell' | 'ability' = stackItem
		? stackItem.kind === 'spell'
			? 'spell'
			: 'ability'
		: source && source.zone !== 'battlefield'
			? 'spell'
			: 'ability';
	// --- End Track P20a ---
	for (const p of state.players) {
		if (p.lost) continue;
		if (zone === 'battlefield') {
			for (const perm of p.battlefield) {
				if (perm.phasedOut || !matchesObjectFilter(perm, spec.filter, ctx)) continue;
				if (!permanentTargetable(state, perm, controllerId, p.playerId, sourceCard, source, sourceKind)) continue;
				out.push({ kind: 'permanent', id: perm.instanceId, label: perm.card.name });
			}
		} else if (zone === 'graveyard') {
			// --- Track P20a ---
			if (isGraveyardTargetingBlocked(state).blocked) continue;
			// --- End Track P20a ---
			for (const c of p.graveyard) {
				if (matchesObjectFilter(c, spec.filter, ctx)) out.push({ kind: 'graveyard_card', id: c.instanceId, label: c.card.name });
			}
		} else if (zone === 'exile') {
			for (const c of p.exile) {
				if (matchesObjectFilter(c, spec.filter, ctx)) out.push({ kind: 'exile_card', id: c.instanceId, label: c.card.name });
			}
		}
	}
	return out;
}

// --- Precon Bragos Spirit: CR 115.1 "For each opponent, ... up to one target ... that player controls" ---
function targetControllerId(state: GameState, t: TargetRef): string | undefined {
	return t.kind === 'permanent' ? findPermanentOnBoard(state, t.id)?.inst.controllerId : undefined;
}

/** Number of distinct opponents controlling a legal candidate (unbounded for other specs). */
function perOpponentTargetCap(state: GameState, spec: TargetSpec, legal: readonly TargetRef[]): number {
	if (!spec.perOpponent && !spec.differentControllers) return Number.POSITIVE_INFINITY;
	return new Set(legal.map((t) => targetControllerId(state, t)).filter(Boolean)).size;
}

/** An error iff two chosen permanents for a `perOpponent` or `differentControllers` spec share a controller. */
export function perOpponentTargetError(state: GameState, spec: TargetSpec, chosen: readonly TargetRef[]): string | null {
	if (!spec.perOpponent && !spec.differentControllers) return null;
	const seen = new Set<string>();
	for (const t of chosen) {
		const ctl = targetControllerId(state, t);
		if (!ctl) continue;
		if (seen.has(ctl)) {
			return spec.differentControllers
				? 'Choose targets controlled by different players (CR 115.1).'
				: 'Choose at most one target controlled by each opponent (CR 115.1).';
		}
		seen.add(ctl);
	}
	return null;
}

/** Keeps the first chosen target per controlling player (bot choices for `perOpponent` / `differentControllers` specs). */
function onePerOpponentTargets(state: GameState, spec: TargetSpec, chosen: TargetRef[]): TargetRef[] {
	if (!spec.perOpponent && !spec.differentControllers) return chosen;
	const seen = new Set<string>();
	return chosen.filter((t) => {
		const ctl = targetControllerId(state, t) ?? t.id;
		if (seen.has(ctl)) return false;
		seen.add(ctl);
		return true;
	});
}
// --- End Precon Bragos Spirit ---

/** Every legal target for one target spec of a triggered ability (CR 115, 603.3d). */
export function triggerTargetCandidates(state: GameState, item: StackItem, spec: TargetSpec): TargetRef[] {
	return specTargetCandidates(
		state,
		item.controllerId,
		item.card,
		triggerSourceObject(state, item),
		spec,
		item.id,
		item
	);
}

/** CR 608.2b for a triggered ability on the interpreter path: is `t` still legal for some spec? */
export function triggerTargetStillLegal(state: GameState, item: StackItem, specs: TargetSpec[], t: TargetRef): boolean {
	return specs.some((spec) => triggerTargetCandidates(state, item, spec).some((c) => c.kind === t.kind && c.id === t.id));
}

/**
 * Puts a triggered ability on the stack (CR 603.3), choosing its targets from the compiled target
 * specs (CR 603.3d): a bot chooses via ai.ts; a human gets a chooseObjects prompt (unless the choice
 * is forced). An ability with a required target and no legal one is removed, with a log line.
 */
export function assignOrPromptTriggerTargets(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	specs: TargetSpec[],
	candidates: TargetRef[][]
): void {
	const steps = H().triggerItemEffect(item)?.steps ?? [];
	const targetsBySpec: TargetRef[][] = specs.map(() => []);
	// --- Track P7 ---
	const srcInstForDiv = triggerSourceObject(state, item);
	const triggerDivisions: Record<string, number> = {};
	// --- End Track P7 ---
	specs.forEach((spec, i) => {
		const priorChosen =
			spec.otherTarget && i > 0
				? new Set(
						targetsBySpec
							.slice(0, i)
							.flat()
							.map((t) => `${t.kind}:${t.id}`)
					)
				: null;
		const baseLegal = priorChosen
			? candidates[i].filter((c) => !priorChosen.has(`${c.kind}:${c.id}`))
			: candidates[i];
		// --- Track P22c ---
		const legal = filterTriggerDifferentPlayerCandidates(
			H().triggerItemModal(item),
			item,
			i,
			targetsBySpec,
			baseLegal
		);
		// --- End Track P22c ---
		// --- Track P7 ---
		const divTotal = H().evaluateSpecDivideTotal(
			state,
			controller.playerId,
			spec,
			srcInstForDiv,
			item.xValue
		);
		const specMax = divTotal !== undefined ? Math.min(spec.max, Math.max(0, divTotal)) : spec.max;
		// --- Precon Bragos Spirit: CR 115.1 one target per opponent ---
		const max = Math.min(specMax, legal.length, perOpponentTargetCap(state, spec, legal));
		// --- End Precon Bragos Spirit ---
		// --- End Track P7 ---
		if (controller.isBot) {
			targetsBySpec[i] = onePerOpponentTargets(
				state,
				spec,
				H().chooseBotTriggerTargets(state, controller, steps, i, spec, legal)
			);
		} else if (legal.length === spec.min && max === spec.min) {
			// Forced: exactly as many legal targets as required.
			targetsBySpec[i] = [...legal];
		} else {
			targetsBySpec[i] = [];
			const reason = `Choose ${spec.min === max ? max : `${spec.min}–${max}`} target(s) for ${item.title}.`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				purpose: 'trigger_targets',
				title: `Choose Targets (${item.card.name})`,
				description: `${reason} (Its text is shown on the stack.)`,
				triggerStackItemId: item.id,
				triggerTargetSpecIndex: i,
				candidateInstanceIds: legal.map((c) => c.id),
				countRequired: spec.min,
				choice: {
					kind: 'chooseObjects',
					candidates: legal.map((c) => c.id),
					min: spec.min,
					max,
					zone: (spec.filter.zone as ZoneType | undefined) ?? 'battlefield',
					reason
				}
			});
		}
		// --- Track P7 ---
		if (divTotal !== undefined && targetsBySpec[i].length > 0) {
			const norm = validateAndNormalizeTargetDivisions(
				targetsBySpec[i],
				divTotal,
				undefined,
				spec.min,
				spec.max,
				item.title
			);
			if (norm.ok) Object.assign(triggerDivisions, norm.divisions);
		}
		// --- End Track P7 ---
	});
	if (specs.length > 0) {
		item.targetsBySpec = targetsBySpec;
		item.targets = targetsBySpec.flat();
		// --- Track P7 ---
		if (Object.keys(triggerDivisions).length > 0) {
			item.targetDivisions = { ...(item.targetDivisions ?? {}), ...triggerDivisions };
		}
		// --- End Track P7 ---
	}
	item.targetObjectVersions = H().captureTargetObjectVersions(state, item.targets);
	// CR 115.1, 603.3d, 702.21a: permanents targeted as a triggered ability goes on the stack trigger Ward / becomes-target abilities.
	for (const t of item.targets) {
		const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
		if (targeted) {
			emitEvent(state, {
				kind: 'BecameTarget',
				objectId: t.id,
				object: targeted.inst,
				by: 'ability',
				controllerId: item.controllerId,
				stackItemId: item.id
			});
		}
		// --- Track P16b ---
		if (t.kind === 'player') {
			emitEvent(state, {
				kind: 'PlayerTargeted',
				targetPlayerId: t.id,
				by: 'ability',
				controllerId: item.controllerId,
				stackItemId: item.id
			});
		}
		// --- End Track P16b ---
	}
	// --- Track P10 ---
	if (
		item.targets.length > 0 &&
		!state.pendingPrompts.some(
			(p) => p.purpose === 'trigger_targets' && p.triggerStackItemId === item.id
		)
	) {
		checkAndEmitCrimeCommitted(state, item.controllerId, item.targets);
	}
	// --- End Track P10 ---
}

export function putTriggerOnStack(state: GameState, t: PendingTrigger): StackItem | null {
	if (state.status === 'finished') return null;
	if (state.stack.length >= MAX_STACK_FOR_TRIGGERS) {
		return handleTriggerBackstopReached(
			state,
			t,
			`${triggerSourcePublicName(state, t)}'s ${t.label} was not put onto the Stack: the stack already holds ${state.stack.length} objects (runaway trigger loop safety cap).`
		);
	}
	const currentTurnKey = state.turnSerial ?? state.turnNumber;
	const placed =
		state.triggersPlacedThisTurn?.turn === currentTurnKey
			? state.triggersPlacedThisTurn
			: { turn: currentTurnKey, count: 0 };
	state.triggersPlacedThisTurn = placed;
	if (placed.count >= MAX_TRIGGERS_PER_TURN) {
		if (placed.count === MAX_TRIGGERS_PER_TURN) {
			placed.count++;
			return handleTriggerBackstopReached(
				state,
				t,
				`Triggered abilities are no longer put onto the Stack this turn: ${MAX_TRIGGERS_PER_TURN} already were (runaway trigger loop safety cap).`
			);
		}
		return null;
	}
	const controller = state.players.find((p) => p.playerId === t.controllerId);
	if (!controller) return null;
	const item = triggeredStackItem(state, t, 'stk');
	const modal = t.ability.effect?.modal ?? H().triggerItemModal(item);
	const foundSrcPerm = findPermanentOnBoard(state, t.source.instanceId);
	const srcObj = triggerSourceObject(state, item);
	// --- Track P18b ---
	const usedModes =
		modal && foundSrcPerm && foundSrcPerm.inst.objectVersion === t.source.objectVersion
			? getEffectiveUsedModalModes(modal, foundSrcPerm.inst)
			: undefined;
	const modeChooser =
		modal?.opponentChooses
			? (state.players.find((p) => !p.lost && p.playerId !== t.controllerId) ?? controller)
			: controller;
	// --- End Track P18b ---

	let needsHumanModePrompt = false;
	let modalDisabledIndices: number[] = [];
	if (modal && !item.chosenModes) {
		const status = H().modalCandidateModeStatus(
			state,
			t.controllerId,
			item.card,
			srcObj,
			modal,
			usedModes
		);
		modalDisabledIndices = status.disabledIndices;
		if (!H().hasLegalModalCombination(modal, status.legalModes)) {
			addLog(
				state,
				'rule',
				`${item.title} was removed from the Stack: no legal modes can be chosen (CR 700.2b / 603.3c).`,
				t.controllerId
			);
			return null;
		}
		// --- Track P18b ---
		const trigModalEvalCtx: FilterContext = {
			state,
			controllerId: t.controllerId,
			source: srcObj,
			xValue: item.xValue
		};
		if (isModalRandomActive(modal, trigModalEvalCtx, evaluateCondition)) {
			const rIdx = Math.floor(nextRandom(state) * status.legalModes.length) % status.legalModes.length;
			item.chosenModes = [status.legalModes[rIdx]];
			H().recordUsedModalModes(foundSrcPerm?.inst, t.source.objectVersion, modal, item.chosenModes);
		} else if (modeChooser.isBot) {
			const picked = H().chooseBotModalTriggerModes(state, modeChooser, item, modal, usedModes);
			if (picked.length === 0) {
				addLog(
					state,
					'rule',
					`${item.title} was removed from the Stack: no mode was chosen (CR 603.3c).`,
					t.controllerId
				);
				return null;
			}
			item.chosenModes = picked;
			H().recordUsedModalModes(foundSrcPerm?.inst, t.source.objectVersion, modal, picked);
		} else if (
			!modal.allowRepeat &&
			!modal.upTo &&
			!modal.conditionalChooseRange &&
			!modal.dynamicMax &&
			modal.pawprintBudget === undefined &&
			status.legalModes.length === modal.min &&
			modal.min === modal.max
		) {
			item.chosenModes = [...status.legalModes];
			H().recordUsedModalModes(foundSrcPerm?.inst, t.source.objectVersion, modal, item.chosenModes);
		} else {
			needsHumanModePrompt = true;
		}
		// --- End Track P18b ---
	}

	const specs = needsHumanModePrompt ? [] : triggerItemTargetSpecs(item);
	const candidates = specs.map((spec) => triggerTargetCandidates(state, item, spec));
	if (!needsHumanModePrompt) {
		const impossible = specs.findIndex((spec, i) => spec.min > 0 && candidates[i].length < spec.min);
		if (impossible >= 0) {
			addLog(
				state,
				'rule',
				`${item.title} was removed from the Stack: it has no legal targets (CR 603.3d).`,
				t.controllerId
			);
			return null;
		}
	}

	// Phase 4 (CR 104.4b, CR 731): detect repeated trigger-resolution cycles for the same
	// `(sourceInstanceId, abilityIndex)` without an intervening voluntary player action.
	const abilityKey = `${t.source.instanceId}:${t.ability.abilityIndex}`;
	const currentResSerial = placed.resolutionSerial ?? 0;
	const byAbility = placed.byAbility ?? (placed.byAbility = {});
	let loopEntry = byAbility[abilityKey];
	if (!loopEntry) {
		const { exactFp, normFp } = computeLoopBoardFingerprints(state);
		loopEntry = {
			cycles: 1,
			lastResolutionSerial: currentResSerial,
			lastExactFp: exactFp,
			lastNormFp: normFp,
			cycled: false
		};
		byAbility[abilityKey] = loopEntry;
	} else if (loopEntry.lastResolutionSerial !== currentResSerial) {
		const { exactFp, normFp } = computeLoopBoardFingerprints(state);
		const cycled =
			exactFp === loopEntry.lastExactFp ||
			normFp === loopEntry.lastNormFp;
		loopEntry.cycles += 1;
		loopEntry.lastResolutionSerial = currentResSerial;
		loopEntry.lastExactFp = exactFp;
		loopEntry.lastNormFp = normFp;
		loopEntry.cycled = cycled;
	}
	const allowedLimit = loopEntry.limit ?? LOOP_TRIGGER_THRESHOLD;
	if (loopEntry.cycles > allowedLimit && loopEntry.cycled) {
		if (triggerItemIsOptional(item)) {
			if (controller.isBot) {
				item.optionalAccepted = false;
				addLog(
					state,
					'rule',
					`CR 731.2b: ${controller.username} (bot) declined the optional trigger ${item.title} after ${allowedLimit} iterations to break a loop (runaway trigger loop safety cap).`,
					controller.playerId
				);
			} else {
				addLog(
					state,
					'rule',
					`CR 731.2b: Optional trigger loop detected on ${item.title} (${allowedLimit} iterations); choose whether to continue or decline when it resolves.`,
					controller.playerId
				);
			}
		} else {
			addLog(
				state,
				'rule',
				`CR 104.4b: Mandatory trigger loop detected on ${item.title} after ${allowedLimit} iterations (runaway trigger loop safety cap).`,
				controller.playerId
			);
			const activePlayers = state.players.filter((p) => !p.lost);
			const human =
				activePlayers.find((p) => !p.isBot && p.playerId === controller.playerId) ??
				activePlayers.find((p) => !p.isBot && p.playerId === state.players[state.activePlayerIndex]?.playerId) ??
				activePlayers.find((p) => !p.isBot);
			if (!human) {
				revealFaceDownObjects(state);
				state.status = 'finished';
				state.winnerPlayerId = null;
				state.winnerId = undefined;
				state.pendingPrompts = [];
				state.stack = [];
				return null;
			}
			const alreadyPrompted = state.pendingPrompts.some(
				(p) => p.continuation?.kind === 'handler' && p.continuation.name === MANDATORY_LOOP_HANDLER
			);
			if (!alreadyPrompted) {
				const reason = `Mandatory trigger loop detected on ${item.title} (${allowedLimit} iterations). Choose how to proceed:`;
				enqueueChoicePrompt(state, {
					id: uid('prm', state),
					playerId: human.playerId,
					kind: 'chooseMode',
					purpose: 'generic',
					title: `Mandatory Trigger Loop (${t.sourceCard.name})`,
					description: reason,
					continuation: {
						kind: 'handler',
						name: MANDATORY_LOOP_HANDLER,
						data: { abilityKey, sourceName: t.sourceCard.name, label: t.label }
					},
					choice: {
						kind: 'chooseMode',
						modes: [
							'End the game in a draw (CR 104.4b)',
							`Let it run ${LOOP_TRIGGER_THRESHOLD} more triggers`
						],
						min: 1,
						max: 1
					}
				});
			}
		}
	}

	state.stack.push(item);
	placed.count++;
	addLog(state, 'trigger', `${triggerSourcePublicName(state, t)}'s ${t.label} was put onto the Stack.`, t.controllerId);
	if (
		state.combat.active &&
		srcObj &&
		t.mode !== 'inline' &&
		!t.ability?.trigger?.or?.some((a) => a.event === 'attackTriggered') &&
		t.ability?.trigger?.event !== 'attackTriggered' &&
		state.combat.attackers.some((a) => a.attackerInstanceId === srcObj.instanceId)
	) {
		emitEvent(state, {
			kind: 'AttackTriggered',
			sourceId: srcObj.instanceId,
			source: srcObj,
			controllerId: t.controllerId,
			triggerStackItemIndex: state.stack.length - 1,
			eventPlayerId: t.controllerId
		});
	}
	// --- Track P16b ---
	if (!needsHumanModePrompt && modal && item.chosenModes && item.chosenModes.length > 0) {
		emitEvent(state, {
			kind: 'FacedDilemma',
			playerId: controller.playerId,
			stackItemId: item.id
		});
	}
	// --- End Track P16b ---

	if (needsHumanModePrompt && modal) {
		const modeLabels = item.grantedAbilityText
			? describeModalModes(item.card, modal, item.faceIndex ?? 0, item.grantedAbilityText)
			: describeModalModes(
					item.grantSourceCard ?? item.card,
					modal,
					item.grantSourceCard ? (item.grantFaceIndex ?? 0) : (item.faceIndex ?? 0)
				);
		// --- Track P18b ---
		const trigBoundsCtx: FilterContext = {
			state,
			controllerId: modeChooser.playerId,
			source: srcObj,
			xValue: item.xValue
		};
		const trigDynMax =
			modal.dynamicMax && modal.dynamicMax.k !== 'x'
				? evaluateAmount(modal.dynamicMax, trigBoundsCtx)
				: undefined;
		const condRangeMet = Boolean(
			modal.conditionalChooseRange &&
				evaluateCondition(modal.conditionalChooseRange.condition, trigBoundsCtx)
		);
		const trigBounds = resolveWave8ModalEffectiveBounds(
			modal,
			false,
			item.xValue,
			trigDynMax,
			condRangeMet
		);
		const reason =
			trigBounds.min === trigBounds.max
				? `Choose ${trigBounds.min} mode(s) for ${item.title}.`
				: `Choose ${trigBounds.min}–${trigBounds.max} mode(s) for ${item.title}.`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: modeChooser.playerId,
			kind: 'chooseMode',
			purpose: 'trigger_modes',
			title: `Choose Mode (${item.card.name})`,
			description: reason,
			triggerStackItemId: item.id,
			choice: {
				kind: 'chooseMode',
				modes: modeLabels,
				min: trigBounds.min,
				max: trigBounds.max,
				...(modal.allowRepeat ? { allowRepeat: true } : {}),
				...(modalDisabledIndices.length > 0 ? { disabledIndices: modalDisabledIndices } : {})
			}
		});
		// --- End Track P18b ---
		return item;
	}

	assignOrPromptTriggerTargets(state, controller, item, specs, candidates);
	return item;
}

/**
 * CR 603.3b: a human who controls several simultaneous triggered abilities chooses their order on
 * the stack (an orderObjects prompt; `topIds[0]` resolves first). Bots keep the match order.
 */
export function askTriggerOrder(state: GameState, controllerId: string, itemIds: string[]): void {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller || controller.isBot) return;
	const topFirst = [...itemIds].reverse();
	const reason = 'Order your triggered abilities: the first one resolves first.';
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId: controllerId,
		kind: 'orderObjects',
		purpose: 'trigger_order',
		title: 'Order Triggered Abilities',
		description: reason,
		candidateInstanceIds: topFirst,
		choice: { kind: 'orderObjects', objectIds: topFirst, allowSplitBottom: false, allowShuffle: false, reason }
	});
}

/** Answers to the trigger prompts (targets, order, "you may"); plain data, no callbacks. */
export function resolveTriggerPrompt(
	state: GameState,
	prompt: PendingPrompt,
	promptIdx: number,
	answer: ChoiceAnswer | undefined
): { ok: boolean; error?: string } {
	const choice = effectivePromptChoice(prompt, state);
	const valid = validateChoiceAnswer(choice, answer);
	if (!valid.ok) return { ok: false, error: valid.error };
	const purpose = effectivePromptPurpose(prompt);
	if (purpose === 'trigger_order') {
		if (answer?.kind !== 'orderObjects') return { ok: false, error: 'Order your triggered abilities.' };
		const ids = choice.kind === 'orderObjects' ? choice.objectIds : [];
		if (answer.topIds.length !== ids.length || (answer.bottomIds?.length ?? 0) > 0) {
			return { ok: false, error: 'Put every triggered ability in order.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const positions = ids
			.map((id) => state.stack.findIndex((s) => s.id === id))
			.filter((i) => i >= 0)
			.sort((a, b) => a - b);
		const byId = new Map(state.stack.map((s) => [s.id, s]));
		// The lowest position resolves last: fill positions bottom-up with the answer reversed.
		const bottomFirst = [...answer.topIds].reverse().map((id) => byId.get(id)).filter((x): x is StackItem => Boolean(x));
		if (bottomFirst.length === positions.length) {
			positions.forEach((pos, k) => (state.stack[pos] = bottomFirst[k]));
			addLog(state, 'trigger', `${state.players.find((p) => p.playerId === prompt.playerId)?.username ?? 'A player'} ordered their triggered abilities (CR 603.3b).`, prompt.playerId);
		}
		return { ok: true };
	}
	const item = state.stack.find((s) => s.id === prompt.triggerStackItemId);
	if (!item) {
		return { ok: false, error: 'That triggered ability is no longer on the stack.' };
	}
	if (purpose === 'trigger_modes') {
		if (answer?.kind !== 'chooseMode') {
			return { ok: false, error: 'Choose the required mode(s).' };
		}
		const modal = H().triggerItemModal(item);
		const controller = state.players.find((p) => p.playerId === item.controllerId);
		if (!modal || !controller) {
			return { ok: false, error: 'That modal trigger is no longer valid.' };
		}
		const foundSrcPerm = findPermanentOnBoard(state, item.sourceInstanceId);
		// --- Track P18b ---
		const usedModes =
			foundSrcPerm && foundSrcPerm.inst.objectVersion === item.sourceObjectVersion
				? getEffectiveUsedModalModes(modal, foundSrcPerm.inst)
				: undefined;
		if ((modal.oncePerTurnUnique || modal.unchosenPermanent) && usedModes?.some((u) => answer.indices.includes(u))) {
			return {
				ok: false,
				error: modal.unchosenPermanent
					? 'A chosen mode has already been chosen.'
					: 'A chosen mode has already been chosen this turn.'
			};
		}
		const pawCheck = validatePawprintBudget(modal, answer.indices);
		if (!pawCheck.ok) {
			return { ok: false, error: pawCheck.reason ?? 'Selected modes exceed pawprint budget.' };
		}
		// --- End Track P18b ---
		const expanded = expandModalEffects(modal, answer.indices);
		if (!expanded) {
			return { ok: false, error: 'Invalid mode selection.' };
		}
		const candidates = expanded.targets.map((spec) => triggerTargetCandidates(state, item, spec));
		const impossible = expanded.targets.findIndex((spec, i) => spec.min > 0 && candidates[i].length < spec.min);
		if (impossible >= 0) {
			return { ok: false, error: 'A chosen mode has no legal targets.' };
		}

		state.pendingPrompts.splice(promptIdx, 1);
		if (answer.indices.length === 0) {
			const idx = state.stack.indexOf(item);
			if (idx >= 0) state.stack.splice(idx, 1);
			addLog(
				state,
				'rule',
				`${item.title} was removed from the Stack (no mode chosen, CR 603.3c).`,
				item.controllerId
			);
			flushTriggers(state);
			return { ok: true };
		}
		item.chosenModes = [...answer.indices];
		H().recordUsedModalModes(foundSrcPerm?.inst, item.sourceObjectVersion, modal, item.chosenModes);
		// --- Track P16b ---
		if (item.chosenModes.length > 0) {
			emitEvent(state, {
				kind: 'FacedDilemma',
				playerId: controller.playerId,
				stackItemId: item.id
			});
		}
		// --- End Track P16b ---
		addLog(
			state,
			'trigger',
			`${controller.username} chose mode(s) ${answer.indices.map((i) => i + 1).join(', ')} for ${item.title}.`,
			item.controllerId
		);
		const specs = triggerItemTargetSpecs(item);
		assignOrPromptTriggerTargets(state, controller, item, specs, candidates);
		flushTriggers(state);
		return { ok: true };
	}
	if (purpose === 'trigger_targets') {
		if (answer?.kind !== 'chooseObjects') {
			return { ok: false, error: 'Choose the required targets.' };
		}
		const specIdx = prompt.triggerTargetSpecIndex ?? 0;
		const specs = triggerItemTargetSpecs(item);
		const spec = specs[specIdx];
		if (!spec) {
			return { ok: false, error: 'That target requirement is no longer valid.' };
		}
		// --- Precon Bragos Spirit: CR 115.1 one target per opponent ---
		const perOppError = perOpponentTargetError(
			state,
			spec,
			answer.objectIds.map((id) => ({ kind: 'permanent', id, label: id }))
		);
		if (perOppError) return { ok: false, error: perOppError };
		// --- End Precon Bragos Spirit ---
		state.pendingPrompts.splice(promptIdx, 1);
		const baseLegal = triggerTargetCandidates(state, item, spec);
		// --- Track P22c ---
		const legal = filterTriggerDifferentPlayerCandidates(
			H().triggerItemModal(item),
			item,
			specIdx,
			item.targetsBySpec ?? [],
			baseLegal
		);
		// --- End Track P22c ---
		const chosen = answer.objectIds
			.map((id) => legal.find((c) => c.id === id))
			.filter((c): c is TargetRef => Boolean(c));
		if (!item.targetsBySpec) {
			item.targetsBySpec = specs.map((_, idx) =>
				idx === specIdx ? [] : idx === 0 ? [...item.targets] : []
			);
		}
		item.targetsBySpec[specIdx] = chosen;
		item.targets = item.targetsBySpec.flat();
		// --- Track P7 ---
		if (spec.divideTotal) {
			const divTotal =
				H().evaluateSpecDivideTotal(
					state,
					item.controllerId,
					spec,
					triggerSourceObject(state, item),
					item.xValue
				) ?? 0;
			const norm = validateAndNormalizeTargetDivisions(
				chosen,
				divTotal,
				undefined,
				spec.min,
				spec.max,
				item.title
			);
			if (norm.ok && Object.keys(norm.divisions).length > 0) {
				item.targetDivisions = { ...(item.targetDivisions ?? {}), ...norm.divisions };
			}
		}
		// --- End Track P7 ---
		item.targetObjectVersions = H().captureTargetObjectVersions(state, item.targets);
		addLog(
			state,
			'trigger',
			`${item.title} targets ${chosen.length > 0 ? chosen.map((c) => c.label).join(', ') : 'nothing'}.`,
			item.controllerId
		);
		for (const t of chosen) {
			const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
			if (targeted) {
				emitEvent(state, {
					kind: 'BecameTarget',
					objectId: t.id,
					object: targeted.inst,
					by: 'ability',
					controllerId: item.controllerId,
					stackItemId: item.id
				});
			}
			// --- Track P16b ---
			if (t.kind === 'player') {
				emitEvent(state, {
					kind: 'PlayerTargeted',
					targetPlayerId: t.id,
					by: 'ability',
					controllerId: item.controllerId,
					stackItemId: item.id
				});
			}
			// --- End Track P16b ---
		}
		// --- Track P10 ---
		if (
			item.targets.length > 0 &&
			!state.pendingPrompts.some(
				(p) => p.purpose === 'trigger_targets' && p.triggerStackItemId === item.id
			)
		) {
			checkAndEmitCrimeCommitted(state, item.controllerId, item.targets);
		}
		// --- End Track P10 ---
		flushTriggers(state);
		return { ok: true };
	}
	// trigger_may: record the answer and finish resolving the ability (it stayed on the stack).
	if (answer?.kind !== 'yesNo') {
		return { ok: false, error: 'Expected a yes/no choice.' };
	}
	state.pendingPrompts.splice(promptIdx, 1);
	item.optionalAccepted = answer.yes;
	// Resume by id: triggers that fired meanwhile may sit above it on the stack.
	H().resumeStackItem(state, item);
	return { ok: true };
}
// --- End Track P9 ---

// --- Track P22c ---
export function enqueueHumanTriggerModesPrompt(
	state: GameState,
	modeChooser: PlayerGameState,
	item: StackItem,
	modal: ModalDef,
	srcObj: CardInstance | undefined,
	modalDisabledIndices: number[]
): void {
	const modeLabels = item.grantedAbilityText
		? describeModalModes(item.card, modal, item.faceIndex ?? 0, item.grantedAbilityText)
		: describeModalModes(
				item.grantSourceCard ?? item.card,
				modal,
				item.grantSourceCard ? (item.grantFaceIndex ?? 0) : (item.faceIndex ?? 0)
			);
	const trigBoundsCtx: FilterContext = {
		state,
		controllerId: modeChooser.playerId,
		source: srcObj,
		xValue: item.xValue
	};
	const trigDynMax =
		modal.dynamicMax && modal.dynamicMax.k !== 'x'
			? evaluateAmount(modal.dynamicMax, trigBoundsCtx)
			: undefined;
	const condRangeMet = Boolean(
		modal.conditionalChooseRange &&
			evaluateCondition(modal.conditionalChooseRange.condition, trigBoundsCtx)
	);
	const trigBounds = resolveWave8ModalEffectiveBounds(
		modal,
		false,
		item.xValue,
		trigDynMax,
		condRangeMet
	);
	const reason =
		trigBounds.min === trigBounds.max
			? `Choose ${trigBounds.min} mode(s) for ${item.title}.`
			: `Choose ${trigBounds.min}–${trigBounds.max} mode(s) for ${item.title}.`;
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId: modeChooser.playerId,
		kind: 'chooseMode',
		purpose: 'trigger_modes',
		title: `Choose Mode (${item.card.name})`,
		description: reason,
		triggerStackItemId: item.id,
		choice: {
			kind: 'chooseMode',
			modes: modeLabels,
			min: trigBounds.min,
			max: trigBounds.max,
			...(modal.allowRepeat ? { allowRepeat: true } : {}),
			...(modalDisabledIndices.length > 0 ? { disabledIndices: modalDisabledIndices } : {})
		}
	});
}

export function resolveTriggerModalBeforeStack(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	modal: ModalDef,
	srcObj: CardInstance | undefined,
	foundSrcPerm: { inst: CardInstance } | undefined,
	sourceVersion: number | undefined
): { status: 'removed' | 'prompt' | 'ready'; modeChooser: PlayerGameState; disabledIndices: number[] } {
	const usedModes =
		foundSrcPerm && foundSrcPerm.inst.objectVersion === sourceVersion
			? getEffectiveUsedModalModes(modal, foundSrcPerm.inst)
			: undefined;
	const modeChooser =
		modal.opponentChooses
			? (state.players.find((p) => !p.lost && p.playerId !== controller.playerId) ?? controller)
			: controller;
	const status = H().modalCandidateModeStatus(
		state,
		controller.playerId,
		item.card,
		srcObj,
		modal,
		usedModes
	);
	if (!H().hasLegalModalCombination(modal, status.legalModes)) {
		addLog(
			state,
			'rule',
			`${item.title} was removed from the Stack: no legal modes can be chosen (CR 700.2b / 603.3c).`,
			controller.playerId
		);
		return { status: 'removed', modeChooser, disabledIndices: status.disabledIndices };
	}
	const trigModalEvalCtx: FilterContext = {
		state,
		controllerId: controller.playerId,
		source: srcObj,
		xValue: item.xValue
	};
	if (isModalRandomActive(modal, trigModalEvalCtx, evaluateCondition)) {
		const rIdx = Math.floor(nextRandom(state) * status.legalModes.length) % status.legalModes.length;
		item.chosenModes = [status.legalModes[rIdx]];
		H().recordUsedModalModes(foundSrcPerm?.inst, sourceVersion, modal, item.chosenModes);
		return { status: 'ready', modeChooser, disabledIndices: status.disabledIndices };
	}
	if (modeChooser.isBot) {
		const picked = H().chooseBotModalTriggerModes(state, modeChooser, item, modal, usedModes);
		if (picked.length === 0) {
			addLog(
				state,
				'rule',
				`${item.title} was removed from the Stack: no mode was chosen (CR 603.3c).`,
				controller.playerId
			);
			return { status: 'removed', modeChooser, disabledIndices: status.disabledIndices };
		}
		item.chosenModes = picked;
		H().recordUsedModalModes(foundSrcPerm?.inst, sourceVersion, modal, picked);
		return { status: 'ready', modeChooser, disabledIndices: status.disabledIndices };
	}
	if (
		!modal.allowRepeat &&
		!modal.upTo &&
		!modal.conditionalChooseRange &&
		!modal.dynamicMax &&
		modal.pawprintBudget === undefined &&
		status.legalModes.length === modal.min &&
		modal.min === modal.max
	) {
		item.chosenModes = [...status.legalModes];
		H().recordUsedModalModes(foundSrcPerm?.inst, sourceVersion, modal, item.chosenModes);
		return { status: 'ready', modeChooser, disabledIndices: status.disabledIndices };
	}
	return { status: 'prompt', modeChooser, disabledIndices: status.disabledIndices };
}
