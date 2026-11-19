/**
 * Effect interpreter step-verb dispatcher and step helpers (castNameLock, preventDamageStep,
 * discardHandStep, damage, fight, delayed).
 * Extracted from runtime/effects.ts (depends only on effectsDamageAndMana.ts).
 */
import type {
	Amount,
	Condition,
	// --- Track P7 ---
	CopyModificationSpec,
	// --- End Track P7 ---
	CostDef,
	EffectStep,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	TargetSpec,
	TokenSpec,
	Verb
} from '../ir.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	// --- Track P13 ---
	ChoiceRequest,
	// --- End Track P13 ---
	CompiledDelayedEffect,
	CounterType,
	DelayedTrigger,
	EffectBindingSnapshot,
	EffectResumeFrame,
	GameState,
	LibrarySearchSpec,
	ManaColor,
	PendingPrompt,
	PlayerGameState,
	ScryfallCard,
	SerializedBoundRef,
	StackItem,
	TargetRef,
	TriggerEventLki,
	VfxEvent,
	ZoneType
} from '../types.ts';
import { describeCost } from './costs.ts';
import { addManaToPlayerPool, type AddManaOptions } from './mana.ts';
import { getCardFaces } from '../scryfall.ts';
import {
	activeAbilityDefs,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { legacySearchSpec, predefinedTokenToSpec } from '../compiler/effects.ts';
import { PREDEFINED_TOKEN_DEFS } from '../oracle.ts';
import { getKeywordSpec } from '../keywords.ts';
import { evaluatePermanent, inspectCardContinuousBreakdown } from '../ruleTree.ts';
import { enqueueChoicePrompt } from './choices.ts';
import { emitEvent } from './events.ts';
// --- Track P22b ---
import { recordP22bExcessDamage } from './triggersWave8.ts';
// --- End Track P22b ---
import {
	evaluateKickedCountAmount,
	evaluateKickerCondition,
	getObjectKickerInfo,
	isConditionMetWithKicker,
	isObjectBlitzed,
	isObjectEscaped,
	isObjectEvoked,
	isObjectForetold,
	type KickerTrackingInfo
} from './kicker.ts';
import { scaleCumulativeUpkeepCost } from './orthogonalKeywords.ts';
// --- Track P12 ---
import { evaluateP12Condition, recordPlayerLifeLossWave4 } from './keywordsWave4.ts';
// --- End Track P12 ---
// --- Track P14 ---
import {
	computeDevotionToColors,
	evaluateWave5Amount,
	evaluateWave5Condition
} from './staticsAndCostsWave5.ts';
// --- End Track P14 ---
// --- Track P15 ---
import {
	canExternalEffectTransform,
	evaluateP15Amount,
	evaluateP15Condition,
	increasePlayerSpeed,
	isPermanentBattle,
	onBattleDefenseCountersRemoved,
	onPlayerLostLifeCheckSpeedTrigger,
	setPermanentPrepared,
	staticallyInterpretableP15
} from './framesBattlesAndKeywordsWave5.ts';
// --- End Track P15 ---
// --- Track P16b ---
import {
	doThisOnceKey,
	evaluateP16bCondition,
	isDoThisOnceTakenThisTurn,
	isStackItemTriggerDoThisOnce,
	markDoThisOnceTakenThisTurn,
	matchesP16bObjectFilter
} from './triggersWave6.ts';
// --- End Track P16b ---
// --- Track P17b ---
import { evaluateP17bAmount, evaluateP17bCondition } from './costsWave6.ts';
// --- End Track P17b ---
// --- Track P18b ---
import {
	executeHarnessStep,
	executeMeldStep,
	getPermanentMaxLoyaltyActivationsPerTurn,
	isMeldedPermanent,
	staticallyInterpretableP18b
} from './framesModalsWave6.ts';
// --- End Track P18b ---
// --- Track P16a ---
import {
	buildDoOnceThisTurnKey,
	buildP16aDurationExpiryFields,
	canDoOnceThisTurn,
	evaluateP16aStepCondition,
	executeAssimilate,
	executeCastFree,
	executeConvert,
	executeCopyCountersFrom,
	executeEmpowerJace,
	executeGeneralizedMoveCounters,
	executeHeal,
	executePileSplit,
	executePutPlayerCounters,
	executeRecruit,
	executeRemoveFromCombat,
	getPlayerCounterCount,
	isNegativeArbitraryCounter,
	isSpellUncounterableByP16a,
	latchBrokenP16aSourceConditions,
	markDoneOnceThisTurn,
	resolveChosenBasicLandSubtypeForAnimate,
	resolveChosenCreatureSubtypeForAnimate,
	resolveChosenKeywordFromOptions,
	resolveChosenProtectionKeyword,
	type P16aStepHost
} from './effectsWave6.ts';
// --- End Track P16a ---
// --- Track P22a ---
import {
	filterPlayerCountersGrantedWave8,
	playerImmuneToOpponentForcedDiscardWave8,
	playerImmuneToOpponentForcedSacrificeWave8,
	playerProtectedFromSourceWave8,
	resolveStaticDamageRedirection,
	shouldReplaceDamageWithCountersWave8
} from './staticsWave8.ts';
// --- End Track P22a ---
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	evaluateAmount,
	evaluateCondition,
	matchesObjectFilter,
	objectManaValue,
	objectPower,
	objectToughness,
	playerCommanderCastCount
} from './objectFilter.ts';
// --- Track P8 ---
import {
	countDistinctCardTypesInZone,
	evaluateP8Condition
} from './staticsLayersAndRestrictions.ts';
import {
	activeRuleModifiers,
	applySelfEtbReplacements,
	// --- Track P22c ---
	spellCannotBeCopied,
	// --- End Track P22c ---
	tokenMultiplier
} from './replace.ts';
import {
	applyTokenReplacementsWave9,
	runWithTokenReplacementSuppressedWave9
} from './replaceWave9.ts';
// --- Track P20a ---
import {
	applyChosenPlayerDamageModifiers,
	getGrantedSpellDamageKeywordsForStackItem,
	hasGlobalAllDamageWither,
	shouldDealDamageToPlayerAsInfect,
	shouldReplaceNoncombatDamageWithMinusCounters
} from './staticsWave7.ts';
// --- End Track P20a ---
import {
	flushTriggers,
	withSimultaneousDestroyLki,
	// --- Track P13 ---
	withSimultaneousZoneBatch
	// --- End Track P13 ---
} from './triggers.ts';
import { nextRandom } from './random.ts';
// --- Track P9 ---
import {
	cameUnderControlSinceLastUpkeep,
	isNinjutsuWindowOpen,
	isUnblockedAttackerForPlayer,
	sumEvaluatedToxic
} from './keywordsWave3.ts';
// --- Track P11 ---
import {
	ALL_COUNTER_TYPES,
	applyStaticDamageModifiers,
	applyStaticLifeGainModifiers,
	computeAttachmentsOnCount,
	computeDomainCount,
	computePartyCount,
	NEGATIVE_COUNTER_TYPES,
	playerCantGainLife
} from './staticsDynamicAndCosts.ts';
// --- End Track P11 ---
import {
	applyNextUntapFreeze,
	chooseBotLibraryPlacement,
	computeLibraryInsertIndex,
	exertPermanent,
	expandCombinationBundles,
	formatManaBundle,
	orderBotSimultaneousLibraryCards,
	pickBestBundleForRequirement,
	pickCombinationForRequirement
} from './tuckFreezeChosen.ts';
import {
	allocateTimestamp,
	attachObject,
	// --- Track P10 ---
	captureLki,
	// --- End Track P10 ---
	createEmptyCounters,
	// --- Track P18b ---
	mergeExiledPairOntoBattlefield,
	// --- End Track P18b ---
	moveObject,
	rearrangeLibrary,
	shuffleLibrary,
	syncBattlefieldControllers,
	tapPermanent,
	type MoveResult
} from './zones.ts';
import { PROMPTING_VERBS } from '../compiler/interpretable.ts';
import {
	executeAdapt,
	executeAmass,
	executeBolster,
	executeIncubate,
	executeManifestDread,
	executeManifestOrCloak,
	executeMonstrosity,
	executePopulate,
	type KeywordActionHost
} from './keywordActions.ts';
// --- Track P7 ---
import {
	addDamagePreventionShield,
	applyBecomeCopyEffect,
	applyDamagePreventionShields,
	evaluateP7Condition,
	getEffectiveCardForPermanent,
	getLockedTargetDivisionAmount,
	isDamageUnpreventable,
	recordLifeGainedThisTurn,
	// --- Track P19a ---
	registerEnteredAttackingCombatant,
	// --- End Track P19a ---
	// --- Track P22d ---
	registerDamagePreventedHandler,
	// --- End Track P22d ---
	registerExileInsteadOfDying,
	registerTimedCombatRestriction
} from './copyPreventionAndEffects.ts';
// --- End Track P7 ---
// --- Track P10 ---
import type { ManaSpendingRestrictionSpec } from '../types.ts';
import {
	enqueueReflexiveTriggerForStep,
	evaluateP10Condition,
	executeAttachP10,
	executeBlight,
	executeClash,
	executeCollectEvidence,
	executeDetain,
	executeDiscover,
	executeEndure,
	executeFateseal,
	executeFlipCoin,
	executeForage,
	executeMultiZoneSearchP10,
	executeRollDie,
	executeSuspect,
	executeTimeTravel,
	isExploitTriggerStackItem,
	isP10ExtendedSearch,
	type P10EffectHost
} from './reflexiveManaAndActions.ts';
// --- End Track P10 ---
// --- Track P13 ---
import {
	buildDurationExpiryFields,
	computeColorsAmongPermanents,
	computeDevotionTo,
	computeStatAggregateAmong,
	computeUnlockedDoorsCount,
	evaluateP13Condition,
	executeAirbend,
	executeChooseDesignation,
	executeCouncilVote,
	executeCreateEmblem,
	executeCreateRoleToken,
	executeDoubleOrTriple,
	executeEarthbend,
	executeExchange,
	executeGrantGraveyardCast,
	executeLearn,
	executeTakeInitiative,
	executeTemptWithRing,
	executeTurnFace,
	executeVentureIntoDungeon,
	executeVillainousChoice,
	matchesP13ObjectFilterFields,
	type P13LifeFunnels,
	type P13StepAskFn
} from './effectsWave5.ts';
// --- End Track P13 ---
// --- Track P19a ---
import {
	computeP19aMultiZoneStatAggregate,
	evaluateP19aAmount,
	evaluateP19aCondition,
	executeDelayedNextSpellCopyP19a as executeP19aDelayedNextSpellCopy,
	executeDelayedTapManaTriggerP19a as executeP19aDelayedTapManaTrigger,
	executeExileUntilP19a as executeP19aExileUntil,
	executeP19aExtendedRevealAndDiscard,
	executeRedirectTargetsP19a as executeP19aRedirectTargets,
	executeP19aSetLifeTotal,
	executeSkipTurnP19a as executeP19aSkipTurn,
	executeSkipCombatPhase,
	resolveP19aChosenColorsForAnimate,
	resolveP19aChosenPumpDelta,
	resolveP19aManaChoiceColors,
	type P19aStepHost
} from './effectsWave7.ts';
// --- End Track P19a ---
// --- Track P22d ---
import {
	executeDigWave8,
	executeExileUntilWave8,
	executePreventWave8,
	handleDamagePreventedWave8
} from './effectsWave8.ts';
// --- End Track P22d ---
import {
	executeBenthicAnomalyCloneWave9,
	executePerOpponentTappedAttackingStep,
	executeSearchWave9,
	executeUlalekCopyStackWave9,
	registerWave9DelayedTriggerStep
} from './effectsWave9.ts';
import {
	computeLethalThresholdBefore,
	executeEndCombatPhaseWave10,
	executePreventWave10,
	executeReselectAttackTargetWave10
} from './combatWave10.ts';
import {
	executeCombatDirectivesWave10,
	executeDamageWithExcessToControllerWave10,
	executeDamageWithOrPlaneswalkerWave10,
	executeForEachPlayerLoopWave10,
	executeOpponentChoiceMoveWave10,
	executePartitionKeepByTypesWave10,
	executePunisherChoiceWave10,
	executeSoulfireEruptionWave10,
	recordFightExcessManaWave10
} from './effectsWave10.ts';
// --- Wave 11 ---
import {
	applyWave11ExileMarks,
	applyWave11PhaseOutMark,
	executeConditionalSequenceStep,
	executeRepeatSequenceStep,
	executeSolveCaseStep,
	executeWave11Attach,
	executeWave11CombatRestriction,
	executeWave11Exchange,
	executeWave11GrantExtras,
	executeWave11GrantPlayer
} from './effectsWave11.ts';
import {
	executeWave11AddManaStep,
	executeWave11DoubleOrTriple,
	executeWave11MoveCounters,
	executeWave11PutCountersExtras
} from './manaCountersWave11.ts';
// --- End Wave 11 ---

import {
	compare,
	effectPorts,
	gainPlayerLife,
	manaChoiceColors,
	proliferateCandidates,
	type Bound,
	type EffectRunAccess
} from './effectsDamageAndMana.ts';

export function executeRunStep(run: EffectRunAccess, step: EffectStep): void {
	const s = run.state;
	const p = effectPorts();
	const you = run.you;
	const title = run.ctx.title;
	switch (step.verb) {
		case 'draw': {
			// --- Track P13 ---
			let totalDrawn = 0;
			// --- End Track P13 ---
			for (const pl of run.players(step.subject)) {
				const n = run.amount(step.amount, 1);
				if (n <= 0) continue;
				p.drawCards(s, pl, n);
				// --- Track P13 ---
				totalDrawn += n;
				// --- End Track P13 ---
				p.addLog(s, 'rule', `${pl.username} drew ${n} card(s).`, you.playerId);
			}
			// --- Track P13 ---
			run.recordEffectAmount(totalDrawn);
			// --- End Track P13 ---
			return;
		}
		case 'gainLife':
		case 'loseLife': {
			// --- Track P19a (CR 119.5): Set player life total ---
			if (step.params?.setLifeTotal) {
				executeP19aSetLifeTotal(run.p19aHost(), step);
				return;
			}
			// --- End Track P19a ---
			const n = Math.max(0, run.amount(step.amount));
			const targets =
				step.subject.k === 'none' && step.actor
					? run.players({ k: 'playerRef', ref: step.actor })
					: run.players(step.subject);
			// --- Track P13 ---
			let totalLifeChanged = 0;
			// --- End Track P13 ---
			for (const pl of targets) {
				const delta = step.verb === 'gainLife' ? n : -n;
				if (step.verb === 'gainLife') {
					totalLifeChanged += gainPlayerLife(s, pl, n);
				} else {
					const cantChange =
						Boolean(pl.lifeTotalCannotChangeThisTurn) ||
						activeRuleModifiers(s, 'lifeTotalCantChange', pl.playerId).length > 0;
					if (!cantChange) {
						pl.life += delta;
						totalLifeChanged += n;
						// --- Track P10 ---
						if (n > 0 && !pl.lostLifeThisTurn) {
							pl.lostLifeThisTurn = true;
							noteLayerInputsChanged(s);
						}
						// --- End Track P10 ---
						// --- Track P12 ---
						recordPlayerLifeLossWave4(pl, n);
						// --- End Track P12 ---
						// --- Track P15 ---
						if (n > 0) onPlayerLostLifeCheckSpeedTrigger(s, pl.playerId, n);
						// --- End Track P15 ---
					}
				}
				p.emitVfx(s, {
					kind: delta >= 0 ? 'heal' : 'damage',
					sourceId: you.playerId,
					targetId: pl.playerId,
					amount: n,
					label: `${delta >= 0 ? '+' : '-'}${n} Life`
				});
			}
			// --- Track P13 ---
			run.recordEffectAmount(totalLifeChanged);
			// --- End Track P13 ---
			if (targets.length > 0) {
				const who = targets.length === 1 ? targets[0].username : `${targets.length} players`;
				p.addLog(s, 'life', `${who} ${step.verb === 'gainLife' ? 'gained' : 'lost'} ${n} life from ${title}.`, you.playerId);
			}
			return;
		}
		case 'damage':
			return run.damage(step);
		case 'fight':
			return run.fight(step);
		case 'destroy': {
			const cantRegen = Boolean(step.params?.cantBeRegenerated);
			const batchKey = `batch:${run.stepIndex}`;
			let ids: string[];
			if (run.answers[batchKey]?.kind === 'chooseObjects') {
				ids = run.answers[batchKey].objectIds;
			} else {
				const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
				run.bind(step, objs);
				const toDestroy: CardInstance[] = [];
				for (const o of objs) {
					const ev = evaluatePermanent(s, o);
					if (ev.activeKeywords.some((k) => k.toLowerCase() === 'indestructible')) {
						p.addLog(s, 'rule', `${o.card.name} is Indestructible and was not destroyed.`);
						continue;
					}
					if (p.tryRegenerateInsteadOfDestroy(s, o, !cantRegen)) {
						continue;
					}
					// CR 122.1c: If a permanent with a shield counter on it would be destroyed,
					// instead remove a shield counter from it.
					if ((o.counters.shield || 0) > 0) {
						o.counters.shield = Math.max(0, (o.counters.shield || 0) - 1);
						p.addLog(
							s,
							'rule',
							`A shield counter was removed from ${o.card.name} instead of destroying it (CR 122.1c).`,
							you.playerId
						);
						continue;
					}
					toDestroy.push(o);
				}
				ids = toDestroy.map((o) => o.instanceId);
				if (run.ctx.item) run.ctx.item.w10DestroyedControllerIds = [];
				if (ids.length > 0 && run.canPause) {
					run.answers[batchKey] = { kind: 'chooseObjects', objectIds: ids };
				}
			}
			let paused = false;
			if (ids.length > 0) {
				const remaining = ids
					.slice(run.subStepIndex)
					.map((id) => run.locate(id))
					.filter((f): f is NonNullable<typeof f> => Boolean(f && f.zone === 'battlefield'))
					.map((f) => f.inst);
				withSimultaneousDestroyLki(s, remaining, () => {
					paused = run.runIndexedBatch(
						batchKey,
						() => ids,
						(id) => {
							const f = run.locate(id);
							if (f && f.zone === 'battlefield') {
								// --- Track P10 ---
								const preSnap = run.captureTriggerEventLki(f.inst);
								const preCtrl = f.inst.controllerId;
								const res = p.destroy(s, f.inst, title, you.playerId, !cantRegen);
								if (f.inst.zone !== 'battlefield') {
									run.recordStepActedObject(f.inst, preSnap, f.inst.zone === 'graveyard');
									if (run.ctx.item) {
										(run.ctx.item.w10DestroyedControllerIds ??= []).push(preCtrl);
									}
								}
								return res;
								// --- End Track P10 ---
							}
						}
					).paused;
				});
			}
			if (!paused) {
				// --- Track P19a ---
				run.recordCountedKind('destroyedThisWay', run.stepActedIds.length);
				// --- End Track P19a ---
				if (step.subject.k === 'all') {
					p.addLog(s, 'cast', `${title} destroyed ${ids.length} permanent(s).`, you.playerId);
				}
			}
			return;
		}
		case 'exile': {
			run.exile(step);
			if (step.params?.untilOpponentBecomesMonarch) {
				const bKey = step.bindAs ?? `b${run.stepIndex}`;
				const boundIds = (run.bindings.get(bKey) ?? []).map((r) => r.id);
				const moved = (
					boundIds.length > 0
						? boundIds
								.map((id) => run.locate(id)?.inst)
								.filter((c): c is CardInstance => Boolean(c && c.zone === 'exile'))
						: run.objects(step.subject).filter((c) => c.zone === 'exile')
				);
				applyWave11ExileMarks(run, step, moved);
			}
			return;
		}
		case 'grantPlayFromExile': {
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			const playSpec = step.params?.playFromExile;
			const dur = playSpec?.duration ?? 'thisTurn';
			const expiresAtEndOfTurn = dur === 'thisTurn';
			const objs = run.objects(step.subject).filter((o) => o.zone === 'exile');
			for (const o of objs) {
				o.playableFromExileBy = {
					playerId: actor.playerId,
					spendManaAsAnyColor: Boolean(playSpec?.spendManaAsAnyColor),
					sourceName: run.ctx.sourceCard.name || title,
					duration: dur,
					...(expiresAtEndOfTurn ? { expiresAtEndOfTurn: true } : {}),
					...(dur === 'untilEndOfYourNextTurn'
						? {
								expiresOnCleanupOfPlayerId: actor.playerId,
								grantedOnTurnSerial: s.turnSerial ?? s.turnNumber
							}
						: {}),
					...(dur === 'untilYourNextEndStep'
						? { expiresAtNextEndStepOfPlayerId: actor.playerId }
						: {}),
					...(playSpec?.spellsOnly ? { spellsOnly: true } : {}),
					...(playSpec?.withoutPayingManaCost ? { withoutPayingManaCost: true } : {}),
					...(playSpec?.alternativeManaCost !== undefined
						? { alternativeManaCost: playSpec.alternativeManaCost }
						: {}),
					...(playSpec?.payLifeEqualManaValue ? { payLifeEqualManaValue: true } : {}),
					...(playSpec?.costReductionGeneric !== undefined
						? { costReductionGeneric: playSpec.costReductionGeneric }
						: {}),
					...(playSpec?.plotted
						? { isPlotted: true, grantedOnTurnSerial: s.turnSerial ?? s.turnNumber }
						: {})
				};
				const verbDesc = playSpec?.spellsOnly ? 'cast' : 'play';
				const durDesc =
					dur === 'untilEndOfYourNextTurn'
						? 'until the end of their next turn'
						: dur === 'untilYourNextEndStep'
							? 'until their next end step'
							: dur === 'asLongAsExiled'
								? 'for as long as it remains exiled'
								: 'this turn';
				p.addLog(
					s,
					'cast',
					`${actor.username} may ${verbDesc} ${o.card.name} from exile ${durDesc}${playSpec?.withoutPayingManaCost ? ' without paying its mana cost' : ''} (${title}).`,
					actor.playerId
				);
			}
			return;
		}
		case 'bounce': {
			// --- Track P16a: Non-targeted choice bounce ("Return a/up to N <filter> you control to its owner's hand") ---
			const batchKey = `batch:${run.stepIndex}`;
			if (step.params?.choiceCount !== undefined && !run.answers[batchKey]) {
				const chooser = (step.actor ? run.playerRef(step.actor) : null) ?? you;
				const cands = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
				const want = Math.min(cands.length, Math.max(0, run.amount(step.params.choiceCount, 1)));
				const minPick = step.params.upTo ? 0 : want;
				const choiceKey = `bounce_pick:${run.stepIndex}`;
				if (want <= 0) {
					if (step.params.upTo) run.stepDecisions[run.stepIndex] = false;
					run.bind(step, []);
					run.answers[batchKey] = { kind: 'chooseObjects', objectIds: [] };
					return;
				}
				if (
					!chooser.isBot &&
					run.canPause &&
					(step.params.upTo || cands.length > minPick) &&
					!run.answers[choiceKey]
				) {
					run.pauseForChoice(
						chooser,
						`${title} — Return Permanent(s) to Hand`,
						`Choose ${minPick === want ? want : `up to ${want}`} permanent(s) to return to hand.`,
						cands.map((c) => c.instanceId),
						minPick,
						want,
						'battlefield',
						cands.slice(0, want).map((c) => c.instanceId),
						choiceKey
					);
					return;
				}
				let chosen: CardInstance[];
				if (run.answers[choiceKey]?.kind === 'chooseObjects') {
					chosen = run.answered(choiceKey, cands, minPick, want) ?? [];
				} else if (step.params.upTo && chooser.playerId === you.playerId && cands.every((c) => c.controllerId === you.playerId)) {
					// Prefer tapped lands on bouncelands, else lowest MV
					const sorted = [...cands].sort((a, b) => {
						if (a.tapped !== b.tapped) return a.tapped ? -1 : 1;
						return objectManaValue(s, a) - objectManaValue(s, b);
					});
					chosen = sorted.slice(0, minPick === 0 ? Math.min(1, want) : want);
				} else {
					const sorted = [...cands].sort((a, b) => {
						if (a.tapped !== b.tapped) return a.tapped ? -1 : 1;
						return objectManaValue(s, a) - objectManaValue(s, b);
					});
					chosen = sorted.slice(0, want);
				}
				run.stepDecisions[run.stepIndex] = chosen.length > 0;
				run.bind(step, chosen);
				run.answers[batchKey] = {
					kind: 'chooseObjects',
					objectIds: chosen.map((c) => c.instanceId)
				};
			}
			// --- End Track P16a ---
			// --- Precon Bragos Spirit: CR 115.1 targeted spells on the stack return to their owner's hand ---
			if (step.subject.k === 'target') {
				for (const t of run.targetsForSpecIndex(step.subject.index)) {
					if (t.kind !== 'stack') continue;
					const stk = s.stack.find((x) => x.id === t.id && x.kind === 'spell');
					if (!stk || stk.id === run.ctx.item.id) continue;
					p.moveStackSpellToHand(s, stk);
					p.addLog(s, 'cast', `${title} returned ${stk.title} to its owner's hand.`, you.playerId);
				}
			}
			// --- End Precon Bragos Spirit ---
			run.runIndexedBatch(
				batchKey,
				() => {
					const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
					run.bind(step, objs);
					return objs.map((o) => o.instanceId);
				},
				(id) => {
					const f = run.locate(id);
					if (!f || f.zone !== 'battlefield') return;
					const objLabel = f.inst.isFaceDown ? (f.inst.faceDownLabel || 'Face-Down Permanent') : f.inst.card.name;
					// --- Track P10 ---
					const preSnap = run.captureTriggerEventLki(f.inst);
					const res = p.moveFromBattlefield(s, f.inst, 'hand');
					if (f.inst.zone !== 'battlefield') {
						run.recordStepActedObject(f.inst, preSnap, false);
					}
					// --- End Track P10 ---
					p.addLog(s, 'cast', `${title} returned ${objLabel} to its owner's hand.`, you.playerId);
					return res as MoveResult;
				}
			);
			return;
		}
		case 'move':
			if (executeOpponentChoiceMoveWave10(run, step)) return;
			return run.move(step);
		case 'counterSpell': {
			const ids =
				step.subject.k === 'eventObject' && run.ctx.eventObjectId
					? [run.ctx.eventObjectId]
					: run.ctx.targets.filter((t) => t.kind === 'stack').map((t) => t.id);
			const countered: Bound[] = [];
			// --- Track P19a ---
			let counteredManaMetric = 0;
			// --- End Track P19a ---
			for (const id of ids) {
				const target = s.stack.find((x) => x.id === id || x.sourceInstanceId === id);
				if (!target) continue;
				// --- Track P16a: Turn/next-spell uncounterable protection ---
				if (isSpellUncounterableByP16a(s, target)) {
					p.addLog(
						s,
						'cast',
						`${target.title} can't be countered (${title}).`,
						you.playerId
					);
					continue;
				}
				// --- End Track P16a ---
				const mv = objectManaValue(s, target);
				countered.push({
					id: target.sourceInstanceId,
					lki: {
						controllerId: target.controllerId,
						ownerId: target.ownerId ?? target.controllerId,
						power: 0,
						toughness: 0,
						manaValue: mv
					},
					// --- Track P22d (CR 707.10b) ---
					counteredStackLki: {
						...target,
						targets: target.targets.map((trg) => ({ ...trg })),
						...(target.targetsBySpec
							? {
									targetsBySpec: target.targetsBySpec.map((bucket) =>
										bucket.map((trg) => ({ ...trg }))
									)
								}
							: {})
					}
					// --- End Track P22d ---
				});
				// --- Track P19a ---
				counteredManaMetric += mv;
				// --- End Track P19a ---
				// --- Track P10 ---
				p.counterSpell(s, run.ctx.item, target, you, step.params?.counterReplacementZone);
				// --- End Track P10 ---
			}
			// --- Track P19a ---
			if (countered.length > 0) run.recordEffectAmount(counteredManaMetric);
			// --- End Track P19a ---
			if (step.bindAs) run.bindings.set(step.bindAs, countered);
			return;
		}
		case 'createToken': {
			if (step.params?.benthicAnomalyClone) {
				executeBenthicAnomalyCloneWave9(run, step);
				return;
			}
			// --- Track P22c: Support multi-player createToken when subject is a player selector ---
			const actors = step.actor
				? [run.playerRef(step.actor)].filter((pl): pl is PlayerGameState => Boolean(pl))
				: step.subject.k === 'player' || step.subject.k === 'playerRef'
					? run.players(step.subject)
					: you
						? [you]
						: [];
			const baseSpec = step.params?.token;
			if (actors.length === 0 || !baseSpec) return;
			// --- Track P19a: Dynamic X/X tokens & tapped-and-attacking tokens (CR 508.4) ---
			const enterTapped = Boolean(
				step.params?.tapped || step.params?.tappedAndAttacking || baseSpec.tapped
			);
			const dynPT = step.params?.dynamicTokenPT;
			const spec = {
				...baseSpec,
				...(baseSpec.legendary && !/\bLegendary\b/i.test(baseSpec.typeLine)
					? { typeLine: `Legendary ${baseSpec.typeLine}` }
					: {}),
				...(enterTapped ? { tapped: true } : {}),
				...(dynPT
					? {
							power: Math.max(0, run.amount(dynPT.power, 0)),
							toughness: Math.max(0, run.amount(dynPT.toughness, 0))
						}
					: {})
			};
			// --- End Track P19a ---
			if (
				step.params?.perOpponentTappedAttacking &&
				executePerOpponentTappedAttackingStep(run, step, (tkSpec, ctrl) =>
					p.createToken(s, ctrl, tkSpec)
				)
			) {
				return;
			}
			const temptMult = step.params?.multiplyByOpponentsDidThisWay
				? Math.max(0, run.lastCountedByKind?.opponentsDidThisWay ?? 0)
				: 1;
			const baseAmount = Math.max(0, run.amount(step.amount, 1)) * temptMult;
			const made: CardInstance[] = [];
			const perPlayerCounts: Array<{ actor: PlayerGameState; count: number }> = [];
			// --- Track P13 (CR 603.2c): Simultaneous multi-token batch for "one or more" triggers ---
			withSimultaneousZoneBatch(s, () => {
				for (const actor of actors) {
					const mult =
						tokenMultiplier(s, actor.playerId) * (actor.tokenMultiplierThisTurn ?? 1);
					const n = baseAmount * mult;
					const batches = applyTokenReplacementsWave9(s, actor, spec, n);
					let createdForActor = 0;
					runWithTokenReplacementSuppressedWave9(() => {
						for (const batch of batches) {
							createdForActor += batch.count;
							for (let i = 0; i < batch.count; i++) {
								const tok = p.createToken(s, actor, batch.spec);
								if (run.ctx.sourceId) {
									tok.createdBySource = {
										instanceId: run.ctx.sourceId,
										objectVersion: run.ctx.item.sourceObjectVersion ?? 1
									};
								}
								// --- Track P19a ---
								if (step.params?.tappedAndAttacking) {
									registerEnteredAttackingCombatant(s, actor, tok);
								}
								// --- End Track P19a ---
								made.push(tok);
							}
						}
					});
					perPlayerCounts.push({ actor, count: createdForActor });
					actor.tokensCreatedCountThisTurn = (actor.tokensCreatedCountThisTurn ?? 0) + createdForActor;
				}
			});
			run.recordEffectAmount(made.length);
			// --- End Track P13 ---
			for (const { actor, count } of perPlayerCounts) {
				if (count > 0) p.addLog(s, 'cast', `${actor.username} created ${count}x ${spec.name}.`, actor.playerId);
			}
			run.bind(step, made);
			return;
			// --- End Track P22c ---
		}
		case 'copyPermanent': {
			const actor = step.actor ? run.playerRef(step.actor) : you;
			if (!actor) return;
			// --- Track P7 ---
			const allowOffBattlefieldCopy =
				step.subject.k === 'binding' ||
				step.subject.k === 'eventObject' ||
				Boolean(step.params?.copyMod?.halvePT) ||
				(step.subject.k === 'target' &&
					run.ctx.targetSpecs[step.subject.index]?.filter.zone !== undefined &&
					run.ctx.targetSpecs[step.subject.index]?.filter.zone !== 'battlefield');
			let objs = run.objects(step.subject).filter((o) => {
				if (!allowOffBattlefieldCopy && o.zone !== 'battlefield') return false;
				if (
					step.subject.k === 'self' &&
					run.ctx.item.sourceObjectVersion !== undefined &&
					(o.objectVersion ?? 1) !== run.ctx.item.sourceObjectVersion
				) {
					return false;
				}
				return true;
			});
			// --- End Track P7 ---
			// CR 707.11: If the source of an effect creating a token copy of itself (e.g. Offspring, Squad)
			// left the battlefield before resolution, use its last known copiable characteristics.
			if (objs.length === 0 && step.subject.k === 'self' && run.ctx.item.sourceInstanceId) {
				const lkiSelf = run.syntheticLkiObject(run.ctx.item.sourceInstanceId, actor.playerId);
				if (run.ctx.item.faceIndex !== undefined) {
					lkiSelf.activeFaceIndex = run.ctx.item.faceIndex;
				}
				if (run.ctx.item.sourcePrototyped) {
					lkiSelf.prototyped = true;
				}
				objs = [lkiSelf];
			}
			const copiesPerObj =
				Math.max(0, run.amount(step.amount, 1)) * tokenMultiplier(s, actor.playerId);
			if (copiesPerObj <= 0) return;
			const notLegendary = Boolean(step.params?.notLegendary);
			const exceptPT = step.params?.exceptPT;
			// --- Track P7 ---
			const copyMod = step.params?.copyMod;
			const copyOpts =
				step.params?.tapped || step.params?.tappedAndAttacking
					? {
							tapped: Boolean(step.params?.tapped || step.params?.tappedAndAttacking),
							tappedAndAttacking: Boolean(step.params?.tappedAndAttacking)
						}
					: undefined;
			// --- End Track P7 ---
			const made: CardInstance[] = [];
			// --- Track P13 (CR 603.2c): Simultaneous multi-token batch for "one or more" triggers ---
			withSimultaneousZoneBatch(s, () => {
				for (const o of objs) {
					let effCopyMod = copyMod;
					if (effCopyMod?.halvePT && o.zone !== 'battlefield') {
						let lki: { power: number; toughness: number } | undefined;
						for (const list of run.bindings.values()) {
							const hit = list.find((b) => b.id === o.instanceId && b.lki);
							if (hit?.lki) {
								lki = { power: hit.lki.power, toughness: hit.lki.toughness };
								break;
							}
						}
						if (lki) {
							effCopyMod = {
								...effCopyMod,
								power: Math.ceil(lki.power / 2),
								toughness: Math.ceil(lki.toughness / 2)
							};
						}
					}
					for (let i = 0; i < copiesPerObj; i++) {
						made.push(p.copyPermanentAsToken(s, actor, o, title, notLegendary, exceptPT, effCopyMod, copyOpts));
					}
				}
			});
			run.recordEffectAmount(made.length);
			// --- End Track P13 ---
			run.bind(step, made);
			return;
		}
		case 'putCounters': {
			if (executeWave11PutCountersExtras(run, step, (perm, c, cnt) => p.addCounters(s, perm, c, cnt))) {
				return;
			}
			// --- Track P16a (CR 122.8–9): Copy counters from source/LKI or place multiple counter kinds ---
			if (step.params?.copyCountersFrom) {
				executeCopyCountersFrom(run.p16aHost(), step);
				return;
			}
			const multiSpecs = step.params?.multiCounters;
			// --- End Track P16a ---
			const counter = step.params?.counter ?? '+1/+1';
			const n = run.amount(step.amount, 1);
			// --- Track P7 ---
			const isDivided = Boolean(step.params?.divided);
			// --- End Track P7 ---
			// --- Track P16a: Non-targeted choice counter placement ("Put N counters on a/up to K <filter> you control") ---
			const ctrBatchKey = `batch:${run.stepIndex}`;
			if (step.params?.choiceCount !== undefined && !run.answers[ctrBatchKey]) {
				const chooser = (step.actor ? run.playerRef(step.actor) : null) ?? you;
				const cands = run.objects(step.subject).filter(
					(o) =>
						o.zone === 'battlefield' &&
						(step.subject.k !== 'self' ||
							run.ctx.item.sourceObjectVersion === undefined ||
							(o.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
				);
				const want = Math.min(cands.length, Math.max(0, run.amount(step.params.choiceCount, 1)));
				const minPick = step.params.upTo ? 0 : want;
				const choiceKey = `putctr_pick:${run.stepIndex}`;
				if (want <= 0) {
					if (step.params.upTo) run.stepDecisions[run.stepIndex] = false;
					run.bind(step, []);
					run.answers[ctrBatchKey] = { kind: 'chooseObjects', objectIds: [] };
					return;
				}
				if (
					!chooser.isBot &&
					run.canPause &&
					(step.params.upTo || cands.length > minPick) &&
					!run.answers[choiceKey]
				) {
					run.pauseForChoice(
						chooser,
						`${title} — Choose Permanent(s) for Counter(s)`,
						`Choose ${minPick === want ? want : `up to ${want}`} permanent(s) to put counter(s) on.`,
						cands.map((c) => c.instanceId),
						minPick,
						want,
						'battlefield',
						cands.slice(0, want).map((c) => c.instanceId),
						choiceKey
					);
					return;
				}
				const chosen =
					run.answers[choiceKey]?.kind === 'chooseObjects'
						? (run.answered(choiceKey, cands, minPick, want) ?? [])
						: cands.slice(0, want);
				run.stepDecisions[run.stepIndex] = chosen.length > 0;
				run.bind(step, chosen);
				run.answers[ctrBatchKey] = {
					kind: 'chooseObjects',
					objectIds: chosen.map((c) => c.instanceId)
				};
			}
			// --- End Track P16a ---
			// --- Track P22d ---
			const allowExile = Boolean(step.params?.allowExileCounters);
			// --- End Track P22d ---
			const { total, paused } = run.runIndexedBatch(
				ctrBatchKey,
				() => {
					const objs = run.objects(step.subject).filter(
						(o) =>
							(o.zone === 'battlefield' || (allowExile && o.zone === 'exile')) &&
							(step.subject.k !== 'self' ||
								run.ctx.item.sourceObjectVersion === undefined ||
								(o.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
					);
					run.bind(step, objs);
					return objs.map((o) => o.instanceId);
				},
				(id, idx) => {
					const f = run.locate(id);
					if (!f || (f.zone !== 'battlefield' && !(allowExile && f.zone === 'exile'))) return;
					if (f.zone === 'exile') {
						if (multiSpecs?.length) {
							for (const mc of multiSpecs) {
								const cnt = run.amount(mc.count, 1);
								if (cnt > 0) {
									f.inst.counters[mc.counter] = (f.inst.counters[mc.counter] ?? 0) + cnt;
								}
							}
							return;
						}
						const amt = isDivided
							? getLockedTargetDivisionAmount(run.ctx.item, id, n, idx, Math.max(1, run.ctx.targets.length))
							: n;
						if (amt > 0) {
							f.inst.counters[counter] = (f.inst.counters[counter] ?? 0) + amt;
							p.addLog(s, 'rule', `${title}: put ${amt} ${counter} counter(s) on ${f.inst.card.name} in exile.`, you.playerId);
						}
						return;
					}
					// --- Track P16a ---
					if (multiSpecs?.length) {
						for (const mc of multiSpecs) {
							const cnt = run.amount(mc.count, 1);
							if (cnt > 0) p.addCounters(s, f.inst, mc.counter, cnt);
						}
						return;
					}
					// --- End Track P16a ---
					// --- Track P7 ---
					const amt = isDivided
						? getLockedTargetDivisionAmount(run.ctx.item, id, n, idx, Math.max(1, run.ctx.targets.length))
						: n;
					if (amt > 0) p.addCounters(s, f.inst, counter, amt);
					// --- End Track P7 ---
				}
			);
			if (!paused && step.subject.k === 'all') {
				p.addLog(s, 'cast', `${you.username} put ${n} ${counter} counter(s) on ${total} permanent(s).`, you.playerId);
			}
			return;
		}
		case 'removeCounters': {
			if (
				step.params?.removeAllCountersFromTargetOrPlayer &&
				step.subject.k === 'target' &&
				run.ctx.targets[step.subject.index]?.kind === 'player'
			) {
				const pl = run.player(run.ctx.targets[step.subject.index]!.id);
				let total = 0;
				if (pl) {
					if (pl.poison > 0) {
						total += pl.poison;
						pl.poison = 0;
					}
					if (pl.experienceCounters > 0) {
						total += pl.experienceCounters;
						pl.experienceCounters = 0;
					}
					if (pl.energyCounters > 0) {
						total += pl.energyCounters;
						pl.energyCounters = 0;
					}
					if ((pl.radCounters ?? 0) > 0) {
						total += pl.radCounters!;
						pl.radCounters = 0;
					}
					if ((pl.ticketCounters ?? 0) > 0) {
						total += pl.ticketCounters!;
						pl.ticketCounters = 0;
					}
				}
				run.lastCountersRemoved = total;
				run.ctx.item.lastCountersRemoved = total;
				run.stepDecisions[run.stepIndex] = total > 0;
				return;
			}
			const counter = step.params?.counter ?? '+1/+1';
			const want = Math.max(0, run.amount(step.amount, 1));
			const sacrificeIfUnable = Boolean(step.params?.ifUnableSacrificeSelf);
			// --- Track P16a ---
			let totalRemovedInStep = 0;
			run.lastCountersRemoved = 0;
			run.ctx.item.lastCountersRemoved = 0;
			// --- End Track P16a ---
			run.runIndexedBatch(
				`batch:${run.stepIndex}`,
				() => {
					const objs = run.objects(step.subject).filter(
						(o) =>
							o.zone === 'battlefield' &&
							(step.subject.k !== 'self' ||
								run.ctx.item.sourceObjectVersion === undefined ||
								(o.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
					);
					run.bind(step, objs);
					return objs.map((o) => o.instanceId);
				},
				(id) => {
					const f = run.locate(id);
					if (!f || f.zone !== 'battlefield') return;
					const inst = f.inst;
					// --- Track P10 ---
					const preSnap = run.captureTriggerEventLki(inst);
					// --- End Track P10 ---
					// --- Track P16a: Support `counter === 'any'` ("remove a/N/all counters") ---
					if (counter === 'any') {
						let remainingBudget = want;
						let removedFromInst = 0;
						for (const [cKey, curVal] of Object.entries(inst.counters)) {
							if (!curVal || curVal <= 0 || remainingBudget <= 0) continue;
							const take = Math.min(curVal, remainingBudget);
							const nextVal = curVal - take;
							inst.counters[cKey] = nextVal;
							remainingBudget -= take;
							removedFromInst += take;
							totalRemovedInStep += take;
							run.lastCountersRemoved = totalRemovedInStep;
							run.ctx.item.lastCountersRemoved = totalRemovedInStep;
							noteLayerInputsChanged(s);
							if (!inst.phasedOut) {
								emitEvent(s, {
									kind: 'CounterRemoved',
									objectId: inst.instanceId,
									object: inst,
									counterType: cKey,
									amount: take,
									previousCount: curVal,
									newCount: nextVal
								});
								if (cKey === 'defense') {
									onBattleDefenseCountersRemoved(s, inst, curVal, nextVal);
								}
							}
						}
						if (removedFromInst > 0) {
							run.recordStepActedObject(inst, preSnap, false);
							p.addLog(
								s,
								'cast',
								`Removed ${removedFromInst} counter(s) from ${inst.card.name}.`,
								you.playerId
							);
							if (!inst.phasedOut) flushTriggers(s);
						}
						if (sacrificeIfUnable && removedFromInst < want && inst.zone === 'battlefield') {
							const res = p.moveFromBattlefield(s, inst, 'graveyard', {
								sacrificedByPlayerId: you.playerId
							});
							p.addLog(s, 'cast', `${you.username} sacrificed ${inst.card.name} (${title}).`, you.playerId);
							return res as MoveResult;
						}
						return;
					}
					// --- End Track P16a ---
					const prev = inst.counters[counter] || 0;
					const next = Math.max(0, prev - want);
					const removed = prev - next;
					if (removed > 0) {
						// --- Track P16a ---
						totalRemovedInStep += removed;
						run.lastCountersRemoved = totalRemovedInStep;
						run.ctx.item.lastCountersRemoved = totalRemovedInStep;
						// --- End Track P16a ---
						inst.counters[counter] = next;
						noteLayerInputsChanged(s);
						// --- Track P10 ---
						run.recordStepActedObject(inst, preSnap, false);
						// --- End Track P10 ---
						p.addLog(
							s,
							'cast',
							`Removed ${removed} ${counter} counter(s) from ${inst.card.name} (${next} remaining).`,
							you.playerId
						);
						if (!inst.phasedOut) {
							emitEvent(s, {
								kind: 'CounterRemoved',
								objectId: inst.instanceId,
								object: inst,
								counterType: counter,
								amount: removed,
								previousCount: prev,
								newCount: next
							});
							// --- Track P15 ---
							if (counter === 'defense') {
								onBattleDefenseCountersRemoved(s, inst, prev, next);
							}
							// --- End Track P15 ---
							flushTriggers(s);
						}
					}
					if (sacrificeIfUnable && removed < want && inst.zone === 'battlefield') {
						// --- Track P10 ---
						const res = p.moveFromBattlefield(s, inst, 'graveyard', {
							sacrificedByPlayerId: you.playerId
						});
						// --- End Track P10 ---
						p.addLog(s, 'cast', `${you.username} sacrificed ${inst.card.name} (${title}).`, you.playerId);
						return res as MoveResult;
					}
				}
			);
			// --- Track P16a ---
			run.stepDecisions[run.stepIndex] = totalRemovedInStep > 0;
			// --- End Track P16a ---
			return;
		}
		case 'moveCounters': {
			if (executeWave11MoveCounters(run, step, (perm, c, cnt) => p.addCounters(s, perm, c, cnt))) {
				return;
			}
			// --- Track P16a (CR 122.5): Generalized counter movement between objects ---
			if (step.params?.moveCounterSpec) {
				executeGeneralizedMoveCounters(run.p16aHost(), step);
				return;
			}
			// --- End Track P16a ---
			const counter = step.params?.counter ?? '+1/+1';
			const src = run.sourcePerm;
			if (!src || src.zone !== 'battlefield') return;
			const initialAvailable = src.counters?.[counter] ?? 0;
			if (initialAvailable <= 0) return;
			const filter = step.params?.toFilter ?? { other: true, types: ['Creature'] };
			const cands = run.objects({ k: 'all', filter }).filter(
				(c: CardInstance) => c.instanceId !== src.instanceId && c.zone === 'battlefield'
			);
			if (cands.length === 0) return;

			// Bot AI or non-pausing environment: move all available counters to first candidate
			if (you.isBot || !run.canPause) {
				const dest = cands[0];
				if (dest && dest.zone === 'battlefield') {
					src.counters[counter] -= initialAvailable;
					noteLayerInputsChanged(s);
					p.addCounters(s, dest, counter, initialAvailable);
					p.addLog(
						s,
						'rule',
						`${you.username} moved ${initialAvailable} ${counter} counter(s) from ${src.card.name} to ${dest.card.name}.`,
						you.playerId
					);
				}
				return;
			}

			// Interactive human flow: iterative counter distribution across eligible creatures
			let remaining = initialAvailable;
			let iter = 0;
			for (; ; iter++) {
				const destKey = `move_counters_dest:${run.stepIndex}:${iter}`;
				const countKey = `move_counters_count:${run.stepIndex}:${iter}`;
				const destAns = run.answers[destKey];

				if (destAns?.kind === 'chooseObjects') {
					const pickedIds = destAns.objectIds;
					if (pickedIds.length === 0) {
						break;
					}
					const destId = pickedIds[0];
					const countAns = run.answers[countKey];
					if (countAns?.kind === 'chooseNumber') {
						const chosenCount = Math.max(1, Math.min(remaining, countAns.n));
						remaining -= chosenCount;
						if (remaining <= 0) {
							break;
						}
						continue;
					} else {
						const destPerm = run.locate(destId)?.inst;
						const destName = destPerm?.card?.name ?? 'chosen creature';
						run.pauseForNumber(
							you,
							`${title} — Move ${counter} counters`,
							`Choose how many ${counter} counters to move onto ${destName} (1–${remaining}).`,
							1,
							remaining,
							remaining,
							countKey
						);
						return;
					}
				} else {
					if (remaining <= 0) break;
					const promptReason =
						iter === 0
							? `Choose a creature to move ${counter} counters onto.`
							: `Choose another creature to move remaining ${remaining} ${counter} counter(s) onto (or choose none to finish).`;
					run.pauseForChoice(
						you,
						`${title} — Move ${counter} counters`,
						promptReason,
						cands.map((c: CardInstance) => c.instanceId),
						0,
						1,
						'battlefield',
						undefined,
						destKey
					);
					return;
				}
			}

			// All choices completed: execute counter movements atomically
			for (let i = 0; i <= iter; i++) {
				const dKey = `move_counters_dest:${run.stepIndex}:${i}`;
				const cKey = `move_counters_count:${run.stepIndex}:${i}`;
				const dAns = run.answers[dKey];
				const cAns = run.answers[cKey];
				const destIds = dAns?.kind === 'chooseObjects' ? dAns.objectIds : undefined;
				if (!destIds || destIds.length === 0) continue;
				const destId = destIds[0];
				const moveN = cAns?.kind === 'chooseNumber' ? cAns.n : 0;
				if (moveN <= 0) continue;
				const dest = run.locate(destId)?.inst;
				if (!dest || dest.zone !== 'battlefield') continue;
				// CR 122.5: verify source still has sufficient counters
				const actual = Math.min(moveN, src.counters?.[counter] ?? 0);
				if (actual <= 0) continue;
				src.counters[counter] -= actual;
				noteLayerInputsChanged(s);
				p.addCounters(s, dest, counter, actual);
				p.addLog(
					s,
					'rule',
					`${you.username} moved ${actual} ${counter} counter(s) from ${src.card.name} to ${dest.card.name}.`,
					you.playerId
				);
			}
			return;
		}
		case 'reveal': {
			const objs = run.objects(step.subject);
			run.bind(step, objs);
			if (objs.length > 0) {
				// --- Track P13 ---
				if (step.params?.lookOnly) {
					for (const o of objs) {
						const known = (o.knownToPlayerIds ??= []);
						if (!known.includes(you.playerId)) known.push(you.playerId);
					}
					p.addLog(
						s,
						'rule',
						`${you.username} looked at ${objs.length} card(s) (${title}).`,
						you.playerId
					);
					return;
				}
				// --- End Track P13 ---
				p.addLog(
					s,
					'rule',
					`${you.username} revealed ${objs.map((o) => o.card.name).join(', ')} (${title}).`,
					you.playerId
				);
			}
			return;
		}
		case 'extraCombatPhase': {
			s.additionalCombatPhases = (s.additionalCombatPhases ?? 0) + 1;
			const slotId = p.uid('ec', s);
			(s.extraCombatSlotIds ??= []).push(slotId);
			run.lastExtraCombatSlotId = slotId;
			p.addLog(
				s,
				'rule',
				`There will be an additional combat phase after this phase (${run.ctx.title}).`,
				you.playerId
			);
			return;
		}
		case 'proliferate': {
			const { candidates, defaultIds } = proliferateCandidates(s, you);
			const ans = run.answers[you.playerId];
			if (
				!you.isBot &&
				run.canPause &&
				candidates.length > 0 &&
				!ans
			) {
				run.pauseForChoice(
					you,
					`${title} — Proliferate`,
					'Choose any number of permanents and/or players with counters to proliferate (CR 701.34a).',
					candidates,
					0,
					candidates.length,
					'battlefield',
					defaultIds
				);
				return;
			}
			const chosenIds = ans?.kind === 'chooseObjects' ? ans.objectIds : undefined;
			p.proliferate(s, you, chosenIds);
			return;
		}
		case 'pump': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			let pw = run.amount(step.amount);
			let tg = run.amount(step.params?.toughness);
			// --- Track P19a: Choice-based pump delta ("gets +2/+0 or +0/+2 until end of turn") ---
			if (objs.length > 0 && step.params?.pumpChoices?.length) {
				const chosenDelta = resolveP19aChosenPumpDelta(
					run.p19aHost(),
					step.params.pumpChoices,
					objs[0]
				);
				if (chosenDelta === null) return;
				pw = chosenDelta.power;
				tg = chosenDelta.toughness;
			}
			// --- End Track P19a ---
			// --- Track P13 (CR 611.2b): Cross-turn / permanent P/T modifiers ---
			const dur = step.params?.duration;
			// --- Track P16a (CR 511.2, CR 611.2b) ---
			if (
				dur === 'untilEndOfCombat' ||
				dur === 'forAsLongAsYouControlSelf' ||
				dur === 'forAsLongAsSelfRemainsTapped'
			) {
				if (objs.length === 0 || (pw === 0 && tg === 0)) return;
				const srcVer =
					run.ctx.item.sourceObjectVersion ??
					run.locate(run.ctx.sourceId)?.inst.objectVersion ??
					1;
				const p16Dur = buildP16aDurationExpiryFields(
					s,
					dur,
					run.ctx.sourceId,
					srcVer,
					you.playerId
				);
				if (!p16Dur.ok || !p16Dur.fields) return;
				const ts = allocateTimestamp(s);
				(s.timedContinuousEffects ??= []).push({
					timestamp: ts,
					sourceName: run.ctx.sourceCard.name,
					controllerId: you.playerId,
					affected: objs.map((o) => ({
						instanceId: o.instanceId,
						objectVersion: o.objectVersion ?? 1
					})),
					...p16Dur.fields,
					layer7c: { power: pw, toughness: tg }
				});
				noteLayerInputsChanged(s);
				return;
			}
			// --- End Track P16a ---
			if (
				objs.length > 0 &&
				(pw !== 0 || tg !== 0) &&
				(dur === 'untilYourNextTurn' || dur === 'untilEndOfYourNextTurn' || dur === 'permanent')
			) {
				const ts = allocateTimestamp(s);
				(s.timedContinuousEffects ??= []).push({
					timestamp: ts,
					sourceName: run.ctx.sourceCard.name,
					controllerId: you.playerId,
					affected: objs.map((o) => ({
						instanceId: o.instanceId,
						objectVersion: o.objectVersion ?? 1
					})),
					...buildDurationExpiryFields(s, dur, you.playerId),
					layer7c: { power: pw, toughness: tg }
				});
				noteLayerInputsChanged(s);
				return;
			}
			// --- End Track P13 ---
			for (const o of objs) {
				o.tempPowerMod += pw;
				o.tempToughnessMod += tg;
			}
			if (objs.length > 0 && (pw !== 0 || tg !== 0)) noteLayerInputsChanged(s);
			return;
		}
		case 'grant': {
			if (executeWave11GrantExtras(run, step)) return;
			// --- Track P22d (CR 702.62) ---
			if (step.params?.grantSuspendIfMissing) {
				const exiledObjs = run.objects(step.subject).filter((o) => o.zone === 'exile');
				run.bind(step, exiledObjs);
				for (const o of exiledObjs) {
					const faceView = resolveObjectFaces(o.copiableCard ?? o.card, {
						zone: 'exile',
						faceIndex: o.activeFaceIndex
					});
					const hasSuspend =
						faceView.keywords.includes('Suspend') || o.grantedKeywords.includes('Suspend');
					if (!hasSuspend) {
						o.grantedKeywords.push('Suspend');
						o.isSuspended = true;
						p.addLog(
							s,
							'rule',
							`${title}: ${o.card.name} gained suspend (CR 702.62).`,
							you.playerId
						);
					} else if ((o.counters.time || 0) > 0) {
						o.isSuspended = true;
					}
				}
				return;
			}
			// --- End Track P22d ---
			if (step.params?.gambitCombatDirective) {
				const atkIds = s.combat.attackers.map((a) => a.attackerInstanceId);
				s.gambitNextCombatDirective = {
					casterPlayerId: you.playerId,
					attackerIds: atkIds
				};
				p.addLog(
					s,
					'combat',
					`${title}: ${atkIds.length} attacking creature(s) must attack during the additional combat phase and can't attack ${you.username} or planeswalkers they control (CR 508.1d).`,
					you.playerId
				);
				if (step.subject.k === 'none') return;
			}
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			// --- Track P16a: Choice-based keyword / protection grant & combat flags ---
			let addKws = step.params?.keywords ? [...step.params.keywords] : undefined;
			if (objs.length > 0 && step.params?.chooseKeywordOptions?.length) {
				const chosenKw = resolveChosenKeywordFromOptions(
					run.p16aHost(),
					step.params.chooseKeywordOptions
				);
				if (chosenKw === null) return;
				(addKws ??= []).push(chosenKw);
			}
			if (objs.length > 0 && step.params?.chooseProtectionColor) {
				const chosenProt = resolveChosenProtectionKeyword(run.p16aHost());
				if (chosenProt === null) return;
				(addKws ??= []).push(chosenProt);
			}
			if (step.params?.mustAttackThisTurn) {
				for (const o of objs) o.mustAttackThisTurn = true;
			}
			if (step.params?.mustBeBlockedThisTurn) {
				for (const o of objs) o.mustBeBlockedThisTurn = true;
			}
			if (step.params?.mustBlockThisTurn) {
				for (const o of objs) o.mustBlockThisTurn = true;
			}
			if (step.params?.mustBlockSelfThisTurn || step.params?.cantBlockSelfThisTurn) {
				const srcLoc = run.locate(run.ctx.sourceId);
				const srcValid =
					srcLoc?.zone === 'battlefield' &&
					!srcLoc.inst.phasedOut &&
					(run.ctx.item.sourceObjectVersion === undefined ||
						srcLoc.inst.objectVersion === run.ctx.item.sourceObjectVersion);
				if (srcValid) {
					if (step.params?.mustBlockSelfThisTurn) {
						for (const o of objs) o.provokeMustBlockId = run.ctx.sourceId;
					}
					if (step.params?.cantBlockSelfThisTurn) {
						for (const o of objs) {
							const arr = (o.cantBlockAttackerIdsThisTurn ??= []);
							if (!arr.includes(run.ctx.sourceId)) arr.push(run.ctx.sourceId);
						}
					}
				}
			}
			if (step.params?.assignsNoCombatDamageThisTurn) {
				for (const o of objs) o.assignsNoCombatDamageThisTurn = true;
			}
			// --- End Track P16a ---
			let removeKws = step.params?.removeKeywords ? [...step.params.removeKeywords] : undefined;
			// --- Track P19a: Choice-based lose-keyword ("loses flying or first strike") ---
			if (objs.length > 0 && step.params?.chooseLoseKeywordOptions?.length) {
				const chosenLostKw = resolveChosenKeywordFromOptions(
					run.p16aHost(),
					step.params.chooseLoseKeywordOptions
				);
				if (chosenLostKw === null) return;
				(removeKws ??= []).push(chosenLostKw);
			}
			// --- End Track P19a ---
			const grantedTexts = step.params?.grantedAbilityTexts;
			// --- Track P16a ---
			const remAllAbs = Boolean(step.params?.removeAllAbilities);
			// --- End Track P16a ---
			// --- Track P13 ---
			if (step.params?.canAttackNoDefender) {
				for (const o of objs) {
					o.canAttackAsThoughNoDefenderThisTurn = true;
				}
				if (objs.length > 0) noteLayerInputsChanged(s);
			}
			const dur = step.params?.duration;
			// --- Track P16a (CR 511.2, CR 611.2b) ---
			if (
				dur === 'untilEndOfCombat' ||
				dur === 'forAsLongAsYouControlSelf' ||
				dur === 'forAsLongAsSelfRemainsTapped'
			) {
				if (
					objs.length > 0 &&
					(addKws?.length ||
						removeKws?.length ||
						remAllAbs ||
						step.params?.cantHaveOrGain ||
						grantedTexts?.length)
				) {
					const srcVer =
						run.ctx.item.sourceObjectVersion ??
						run.locate(run.ctx.sourceId)?.inst.objectVersion ??
						1;
					const p16Dur = buildP16aDurationExpiryFields(
						s,
						dur,
						run.ctx.sourceId,
						srcVer,
						you.playerId
					);
					if (!p16Dur.ok || !p16Dur.fields) return;
					const ts = allocateTimestamp(s);
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: run.ctx.sourceCard.name,
						controllerId: you.playerId,
						affected: objs.map((o) => ({
							instanceId: o.instanceId,
							objectVersion: o.objectVersion ?? 1
						})),
						...p16Dur.fields,
						layer6: {
							...(addKws?.length ? { addKeywords: [...addKws] } : {}),
							...(removeKws?.length ? { removeKeywords: [...removeKws] } : {}),
							...(remAllAbs ? { removeAllAbilities: true } : {}),
							...(step.params?.cantHaveOrGain ? { cantHaveOrGain: true } : {}),
							...(grantedTexts?.length ? { grantedAbilityTexts: [...grantedTexts] } : {})
						}
					});
					noteLayerInputsChanged(s);
				}
				return;
			}
			// --- End Track P16a ---
			if (
				objs.length > 0 &&
				(dur === 'untilYourNextTurn' || dur === 'untilEndOfYourNextTurn' || dur === 'permanent') &&
				(addKws?.length ||
					removeKws?.length ||
					remAllAbs ||
					step.params?.cantHaveOrGain ||
					grantedTexts?.length)
			) {
				const ts = allocateTimestamp(s);
				(s.timedContinuousEffects ??= []).push({
					timestamp: ts,
					sourceName: run.ctx.sourceCard.name,
					controllerId: you.playerId,
					affected: objs.map((o) => ({
						instanceId: o.instanceId,
						objectVersion: o.objectVersion ?? 1
					})),
					...buildDurationExpiryFields(s, dur, you.playerId),
					layer6: {
						...(addKws?.length ? { addKeywords: [...addKws] } : {}),
						...(removeKws?.length ? { removeKeywords: [...removeKws] } : {}),
						...(remAllAbs ? { removeAllAbilities: true } : {}),
						...(step.params?.cantHaveOrGain ? { cantHaveOrGain: true } : {}),
						...(grantedTexts?.length ? { grantedAbilityTexts: [...grantedTexts] } : {})
					}
				});
				noteLayerInputsChanged(s);
				return;
			}
			// --- End Track P13 ---
			for (const o of objs) {
				for (const kw of addKws ?? []) {
					const isStackingTriggerKw = getKeywordSpec(kw)?.implementation?.kind === 'trigger';
					if (isStackingTriggerKw || !o.grantedKeywords.includes(kw)) {
						o.grantedKeywords.push(kw);
					}
				}
			}
			if (objs.length > 0 && (addKws?.length || removeKws?.length)) {
				const ts = allocateTimestamp(s);
				(s.timedKeywordEffects ??= []).push({
					timestamp: ts,
					sourceName: run.ctx.sourceCard.name,
					controllerId: you.playerId,
					affected: objs.map((o) => ({
						instanceId: o.instanceId,
						objectVersion: o.objectVersion ?? 1
					})),
					...(addKws?.length ? { addKeywords: [...addKws] } : {}),
					...(removeKws?.length ? { removeKeywords: [...removeKws] } : {}),
					...(step.params?.cantHaveOrGain ? { cantHaveOrGain: true } : {})
				});
				noteLayerInputsChanged(s);
			}
			// --- Track P10 + Track P16a ---
			if (objs.length > 0 && (grantedTexts?.length || remAllAbs)) {
				const ts = allocateTimestamp(s);
				const expires: 'endOfTurn' | 'never' =
					step.params?.duration === 'permanent' ? 'never' : 'endOfTurn';
				(s.timedContinuousEffects ??= []).push({
					timestamp: ts,
					sourceName: run.ctx.sourceCard.name,
					controllerId: you.playerId,
					affected: objs.map((o) => ({
						instanceId: o.instanceId,
						objectVersion: o.objectVersion ?? 1
					})),
					expires,
					layer6: {
						...(grantedTexts?.length ? { grantedAbilityTexts: [...grantedTexts] } : {}),
						...(remAllAbs ? { removeAllAbilities: true } : {})
					}
				});
				noteLayerInputsChanged(s);
			}
			// --- End Track P10 + Track P16a ---
			return;
		}
		case 'grantPlayer': {
			if (executeCombatDirectivesWave10(run, step)) return;
			if (executeWave11GrantPlayer(run, step)) return;
			const rules = step.params?.playerRules ?? [];
			// --- Track P16a: Turn & next-spell cast permissions / restrictions ---
			if (rules.includes('opponentsCantCastThisTurn')) {
				for (const opp of run.apnapPlayers()) {
					if (opp.playerId === you.playerId) continue;
					opp.cantCastSpellsThisTurn = true;
				}
				p.addLog(
					s,
					'rule',
					`${title}: Opponents can't cast spells this turn.`,
					you.playerId
				);
			}
			const nextFilter = step.params?.nextSpellFilter;
			const plainGrant = nextFilter
				? {
						...(nextFilter.types?.length ? { types: [...nextFilter.types] } : {}),
						...(nextFilter.notTypes?.length ? { notTypes: [...nextFilter.notTypes] } : {})
					}
				: {};
			// --- End Track P16a ---
			// --- Track P7 ---
			if (rules.includes('damageCantBePrevented')) {
				s.damageCantBePreventedThisTurn = true;
				p.addLog(s, 'rule', `${title}: Damage can't be prevented this turn (CR 615.12).`, you.playerId);
			}
			if (rules.includes('combatDamageCantBePrevented')) {
				s.combatDamageCantBePreventedThisTurn = true;
				p.addLog(s, 'rule', `${title}: Combat damage can't be prevented this turn (CR 615.12).`, you.playerId);
			}
			// --- End Track P7 ---
			if (step.params?.planarAction) {
				p.addLog(s, 'rule', `${title}: ${step.params.planarAction}.`, you.playerId);
			}
			for (const pl of run.players(step.subject)) {
				// --- Track P22d ---
				if (rules.includes('noMaxHandSizeRestOfGame')) {
					pl.noMaxHandSizeForRestOfGame = true;
					p.addLog(
						s,
						'rule',
						`${pl.username} has no maximum hand size for the rest of the game (${title}).`,
						you.playerId
					);
				}
				// --- End Track P22d ---
				if (rules.includes('lifeTotalCantChange')) pl.lifeTotalCannotChangeThisTurn = true;
				if (rules.includes('protectionFromEverything')) pl.protectionFromEverythingThisTurn = true;
				// --- Track P19a ---
				if (step.params?.spendManaAsAnyColorTopOfLibraryThisTurn) {
					pl.spendManaAsAnyColorFromTopOfLibraryThisTurn = true;
				}
				// --- End Track P19a ---
				// --- Wave 12 ---
				if (step.params?.nextSpellCascade) {
					pl.nextSpellCascadeCount = (pl.nextSpellCascadeCount ?? 0) + step.params.nextSpellCascade;
				}
				// --- End Wave 12 ---
				if (step.params?.extraLoyaltyActivationsThisTurn) {
					pl.extraLoyaltyActivationsThisTurn =
						(pl.extraLoyaltyActivationsThisTurn ?? 0) +
						step.params.extraLoyaltyActivationsThisTurn;
					for (const pw of pl.battlefield) {
						if (pw.phasedOut) continue;
						const evPw = evaluatePermanent(s, pw);
						if (!evPw.typeLine.includes('Planeswalker')) continue;
						const maxLoy = getPermanentMaxLoyaltyActivationsPerTurn(
							s,
							pw,
							evPw.losesAllAbilities
						);
						pw.usedLoyaltyThisTurn = (pw.loyaltyActivationsThisTurn ?? 0) >= maxLoy;
					}
					noteLayerInputsChanged(s);
					p.addLog(
						s,
						'rule',
						`${pl.username} may activate an additional loyalty ability of each planeswalker they control this turn (${title}, CR 606.3).`,
						you.playerId
					);
				}
				// --- Track P13 ---
				if (rules.includes('extraLandPlay')) {
					const addLands = Math.max(1, step.params?.extraLandPlays ?? 1);
					pl.extraLandPlaysThisTurn = (pl.extraLandPlaysThisTurn ?? 0) + addLands;
					p.addLog(
						s,
						'rule',
						`${pl.username} may play ${addLands} additional land(s) this turn (${title}).`,
						you.playerId
					);
				}
				if (rules.includes('cannotLoseGame')) {
					pl.cannotLoseGameThisTurn = true;
					p.addLog(
						s,
						'rule',
						`${pl.username} can't lose the game this turn (${title}).`,
						you.playerId
					);
				}
				if (rules.includes('hexproof')) {
					if (step.params?.duration === 'untilYourNextTurn') {
						pl.hexproofUntilNextTurn = true;
					} else {
						pl.hexproofThisTurn = true;
					}
					p.addLog(
						s,
						'rule',
						`${pl.username} gains hexproof (${title}).`,
						you.playerId
					);
				}
				// --- End Track P13 ---
				// --- Track P16a ---
				if (rules.includes('cantCastSpellsThisTurn')) {
					pl.cantCastSpellsThisTurn = true;
					p.addLog(
						s,
						'rule',
						`${pl.username} can't cast spells this turn (${title}).`,
						you.playerId
					);
				}
				if (rules.includes('spellsCantBeCounteredThisTurn')) {
					pl.spellsCantBeCounteredThisTurn = true;
					p.addLog(
						s,
						'rule',
						`Spells ${pl.username} casts this turn can't be countered (${title}).`,
						you.playerId
					);
				}
				if (rules.includes('castAsThoughFlashThisTurn')) {
					pl.castAsThoughFlashThisTurn = true;
					p.addLog(
						s,
						'rule',
						`${pl.username} may cast spells this turn as though they had flash (${title}).`,
						you.playerId
					);
				}
				if (rules.includes('nextSpellFlash')) {
					(pl.nextSpellFlashGrants ??= []).push({ ...plainGrant });
					p.addLog(
						s,
						'rule',
						`The next matching spell ${pl.username} casts this turn can be cast as though it had flash (${title}).`,
						you.playerId
					);
				}
				if (rules.includes('nextSpellCantBeCountered')) {
					(pl.nextSpellCantBeCounteredGrants ??= []).push({ ...plainGrant });
					p.addLog(
						s,
						'rule',
						`The next matching spell ${pl.username} casts this turn can't be countered (${title}).`,
						you.playerId
					);
				}
				// --- End Track P16a ---
				if (rules.includes('lifeTotalCantChange') || rules.includes('protectionFromEverything')) {
					p.addLog(s, 'rule', `${pl.username}'s life total can't change and they have protection from everything until their next turn.`, you.playerId);
				}
			}
			return;
		}
		// --- Track P7 ---
		case 'preventDamage':
			return run.preventDamageStep(step);
		case 'exileInsteadOfDying': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			for (const o of objs) {
				registerExileInsteadOfDying(s, o);
			}
			return;
		}
		case 'combatRestriction': {
			if (executeCombatDirectivesWave10(run, step)) return;
			if (executeWave11CombatRestriction(run, step)) return;
			const spec = step.params?.combatRestriction;
			if (!spec) return;
			const objs = run.objects(step.subject).filter((o) => {
				if (o.zone !== 'battlefield' || o.phasedOut) return false;
				if (
					step.subject.k === 'self' &&
					run.ctx.item.sourceObjectVersion !== undefined &&
					(o.objectVersion ?? 1) !== run.ctx.item.sourceObjectVersion
				) {
					return false;
				}
				return true;
			});
			run.bind(step, objs);
			for (const o of objs) {
				registerTimedCombatRestriction(s, o, spec);
			}
			return;
		}
		case 'becomeCopy': {
			const copySrcSel = step.params?.copySource;
			if (!copySrcSel) return;
			const affected = run.objects(step.subject).filter((o) => {
				if (o.zone !== 'battlefield' || o.phasedOut) return false;
				if (
					step.subject.k === 'self' &&
					run.ctx.item.sourceObjectVersion !== undefined &&
					(o.objectVersion ?? 1) !== run.ctx.item.sourceObjectVersion
				) {
					return false;
				}
				return true;
			});
			const copySrc = run.objects(copySrcSel)[0];
			if (!copySrc || copySrc.zone !== 'battlefield' || copySrc.phasedOut) {
				run.bind(step, []);
				return;
			}
			const updated = applyBecomeCopyEffect(
				s,
				affected,
				copySrc,
				step.params?.copyMod,
				step.params?.duration,
				you.playerId,
				run.ctx.sourceCard.name || title,
				allocateTimestamp
			);
			run.bind(step, updated);
			if (updated.length > 0) {
				p.addLog(
					s,
					'cast',
					`${updated.length === 1 ? updated[0].card.name : `${updated.length} permanents`} became a copy of ${copySrc.card.name}${step.params?.duration === 'permanent' ? '' : ' until end of turn'}.`,
					you.playerId
				);
			}
			return;
		}
		case 'discardHand':
			return run.discardHandStep(step);
		// --- End Track P7 ---
		case 'addMana': {
			if (executeWave11AddManaStep(run, step)) return;
			// --- Track P19a (CR 605.1b, CR 106.7): Honor `step.actor` (e.g. `eventPlayer` on Mana Flare / Dictate of Karametra) ---
			const recipient = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			if (recipient.lost) return;
			// --- Track P22b: CR 603 / Carpet of Flowers per-turn mana-added flag on triggering source ---
			const noteTriggeredManaAdded = () => {
				if (run.ctx.item.kind === 'triggered') {
					const srcPerm = p.findPermanent(s, run.ctx.sourceId)?.inst;
					if (srcPerm) srcPerm.addedManaThisTurn = true;
				}
			};
			// --- End Track P22b & P19a ---
			const times = Math.max(0, run.amount(step.amount, 1));
			const restriction = step.params?.manaRestriction;
			// --- Track P10 ---
			const rawRestrSpec = step.params?.manaRestrictionSpec;
			const chosenSub = run.sourceChosenSubType();
			const boundRestrSpec: ManaSpendingRestrictionSpec | undefined = rawRestrSpec
				? {
						...rawRestrSpec,
						...(chosenSub && !rawRestrSpec.sourceChosenSubType
							? { sourceChosenSubType: chosenSub }
							: {})
					}
				: undefined;
			const addOpts: AddManaOptions | undefined =
				boundRestrSpec || step.params?.retainManaUntilEndOfTurn
					? {
							...(boundRestrSpec ? { restrictionSpec: boundRestrSpec } : {}),
							...(step.params?.retainManaUntilEndOfTurn ? { retainUntilEndOfTurn: true } : {})
						}
					: undefined;
			// --- End Track P10 ---
			if (step.params?.manaWithChosenColor) {
				for (const c of step.params.manaWithChosenColor) {
					addManaToPlayerPool(recipient, c, 1, restriction, addOpts);
				}
				const chosenCol = run.sourceChosenColor();
				if (chosenCol) {
					addManaToPlayerPool(recipient, chosenCol, 1, restriction, addOpts);
				}
				noteTriggeredManaAdded();
				return;
			}
			// --- Track P16a: "Add {W} or one mana of the chosen color" (Thriving / Gate lands) ---
			if (step.params?.manaOrChosenColor && step.params.manaOrChosenColor.length > 0) {
				const chosenCol = run.sourceChosenColor();
				const candCols: ManaColor[] = [];
				for (const c of step.params.manaOrChosenColor) {
					if (!candCols.includes(c)) candCols.push(c);
				}
				if (chosenCol && !candCols.includes(chosenCol)) candCols.push(chosenCol);
				const orBundles = candCols.map((c) => [c]);
				let chosenBundle =
					orBundles.length === 1
						? orBundles[0]
						: pickBestBundleForRequirement(orBundles, recipient.manaPool, null, run.ctx.preferredColor);
				if (!recipient.isBot && orBundles.length > 1 && run.canPause) {
					const manaKey = `manaorchosen:${run.stepIndex}`;
					const ans = run.answers[manaKey] ?? run.answers[recipient.playerId];
					if (!ans) {
						const item = run.saveFrame(run.stepIndex, run.answers, 'step', run.subStepIndex);
						const modes = orBundles.map((b) => formatManaBundle(b));
						enqueueChoicePrompt(s, {
							id: p.uid('prompt', s),
							kind: 'chooseMode',
							playerId: recipient.playerId,
							title: `${title} — Choose Mana Color`,
							description: `Choose mana to add (${modes.join(', ')}).`,
							continuation: {
								kind: 'effect_choice',
								stackItemId: item.id,
								stepIndex: run.stepIndex,
								answerKey: manaKey
							},
							choice: {
								kind: 'chooseMode',
								modes,
								min: 1,
								max: 1,
								defaultIndices: [0]
							}
						});
						run.result.paused = true;
						return;
					}
					if (ans.kind === 'chooseMode' && orBundles[ans.indices[0] ?? -1]) {
						chosenBundle = orBundles[ans.indices[0]];
					}
				}
				for (const c of chosenBundle) {
					addManaToPlayerPool(recipient, c, 1, restriction, addOpts);
				}
				if (chosenBundle.length > 0) noteTriggeredManaAdded();
				return;
			}
			// --- End Track P16a ---
			if (step.params?.manaBundles && step.params.manaBundles.length > 0) {
				const bundles = step.params.manaBundles;
				let chosenBundle =
					bundles.length === 1
						? bundles[0]
						: pickBestBundleForRequirement(bundles, recipient.manaPool, null, run.ctx.preferredColor);
				if (!recipient.isBot && bundles.length > 1 && run.canPause) {
					const manaKey = `manabundle:${run.stepIndex}`;
					const ans = run.answers[manaKey] ?? run.answers[recipient.playerId];
					if (!ans) {
						const item = run.saveFrame(run.stepIndex, run.answers, 'step', run.subStepIndex);
						const modes = bundles.map((b) => formatManaBundle(b));
						enqueueChoicePrompt(s, {
							id: p.uid('prompt', s),
							kind: 'chooseMode',
							playerId: recipient.playerId,
							title: `${title} — Choose Mana Combination`,
							description: `Choose mana to add (${modes.join(', ')}).`,
							continuation: {
								kind: 'effect_choice',
								stackItemId: item.id,
								stepIndex: run.stepIndex,
								answerKey: manaKey
							},
							choice: {
								kind: 'chooseMode',
								modes,
								min: 1,
								max: 1,
								defaultIndices: [0]
							}
						});
						run.result.paused = true;
						return;
					}
					if (ans.kind === 'chooseMode' && bundles[ans.indices[0] ?? -1]) {
						chosenBundle = bundles[ans.indices[0]];
					}
				}
				for (const c of chosenBundle) {
					addManaToPlayerPool(recipient, c, 1, restriction, addOpts);
				}
				if (chosenBundle.length > 0) noteTriggeredManaAdded();
				return;
			}
			if (step.params?.manaCombinationColors) {
				if (times <= 0) return;
				const allowedCols: ManaColor[] =
					step.params.manaCombinationColors === 'any'
						? ['W', 'U', 'B', 'R', 'G']
						: step.params.manaCombinationColors;
				if (allowedCols.length === 0) return;
				let chosenBundle = pickCombinationForRequirement(
					allowedCols,
					times,
					recipient.manaPool,
					null,
					run.ctx.preferredColor,
					recipient
				);
				if (!recipient.isBot && allowedCols.length > 1 && run.canPause) {
					const bundles = times <= 5 ? expandCombinationBundles(allowedCols, times) : [];
					if (bundles.length > 1) {
						const manaKey = `manacomb:${run.stepIndex}`;
						const ans = run.answers[manaKey] ?? run.answers[recipient.playerId];
						if (!ans) {
							const item = run.saveFrame(run.stepIndex, run.answers, 'step', run.subStepIndex);
							const modes = bundles.map((b) => formatManaBundle(b));
							enqueueChoicePrompt(s, {
								id: p.uid('prompt', s),
								kind: 'chooseMode',
								playerId: recipient.playerId,
								title: `${title} — Choose Mana Combination`,
								description: `Choose ${times} mana in any combination (${allowedCols.map((c) => `{${c}}`).join(', ')}).`,
								continuation: {
									kind: 'effect_choice',
									stackItemId: item.id,
									stepIndex: run.stepIndex,
									answerKey: manaKey
								},
								choice: {
									kind: 'chooseMode',
									modes,
									min: 1,
									max: 1,
									defaultIndices: [0]
								}
							});
							run.result.paused = true;
							return;
						}
						if (ans.kind === 'chooseMode' && bundles[ans.indices[0] ?? -1]) {
							chosenBundle = bundles[ans.indices[0]];
						}
					}
				}
				for (const c of chosenBundle) {
					addManaToPlayerPool(recipient, c, 1, restriction, addOpts);
				}
				if (chosenBundle.length > 0) noteTriggeredManaAdded();
				return;
			}
			if (step.params?.mana) {
				const mana = step.params.mana;
				const loops = mana.length > 1 ? 1 : times;
				for (let i = 0; i < loops; i++) {
					for (const c of mana) {
						addManaToPlayerPool(recipient, c, 1, restriction, addOpts);
						if (step.delayed) {
							(recipient.manaRiders ??= []).push({
								id: p.uid('rider', s),
								color: c,
								sourceInstanceId: run.ctx.sourceId,
								sourceCard: run.ctx.sourceCard,
								condition: { sharesCreatureTypeWithCommander: true },
								scryAmount: 1
							});
						}
					}
				}
				if (loops > 0 && mana.length > 0) noteTriggeredManaAdded();
				return;
			}
			if (step.params?.manaChoice) {
				const allowed = manaChoiceColors(
					s,
					recipient,
					step.params.manaChoice,
					run.sourceChosenColor(),
					run.ctx.eventObjectId
				);
				if (allowed.length === 0 || times <= 0) return;
				const defaultColor =
					run.ctx.preferredColor && allowed.includes(run.ctx.preferredColor)
						? run.ctx.preferredColor
						: allowed[0];
				let chosen = defaultColor;
				if (!recipient.isBot && !run.ctx.preferredColor && allowed.length > 1 && run.canPause) {
					const manaKey = `mana:${run.stepIndex}`;
					const ans = run.answers[manaKey] ?? run.answers[recipient.playerId];
					if (!ans) {
						const item = run.saveFrame(run.stepIndex, run.answers, 'step', run.subStepIndex);
						const defaultIdx = Math.max(0, allowed.indexOf(defaultColor));
						enqueueChoicePrompt(s, {
							id: p.uid('prompt', s),
							kind: 'chooseMode',
							playerId: recipient.playerId,
							title: `${title} — Choose Mana Color`,
							description: `Choose a color of mana to add (${allowed.join(', ')}).`,
							continuation: {
								kind: 'effect_choice',
								stackItemId: item.id,
								stepIndex: run.stepIndex,
								answerKey: manaKey
							},
							choice: {
								kind: 'chooseMode',
								modes: allowed,
								min: 1,
								max: 1,
								defaultIndices: [defaultIdx]
							}
						});
						run.result.paused = true;
						return;
					}
					const picked =
						ans.kind === 'chooseMode'
							? allowed[ans.indices[0] ?? -1]
							: ans.kind === 'chooseObjects'
								? (ans.objectIds[0] as ManaColor)
								: undefined;
					if (picked && allowed.includes(picked)) chosen = picked;
				}
				addManaToPlayerPool(recipient, chosen, times, restriction, addOpts);
				if (times > 0) noteTriggeredManaAdded();
				if (step.delayed) {
					for (let i = 0; i < times; i++) {
						(recipient.manaRiders ??= []).push({
							id: p.uid('rider', s),
							color: chosen,
							sourceInstanceId: run.ctx.sourceId,
							sourceCard: run.ctx.sourceCard,
							condition: { sharesCreatureTypeWithCommander: true },
							scryAmount: 1
						});
					}
				}
			}
			return;
		}
		// --- Track P10 ---
		case 'retainMana': {
			const colors: ManaColor[] =
				step.params?.unemptiedColors === 'all' || !step.params?.unemptiedColors
					? ['W', 'U', 'B', 'R', 'G', 'C']
					: step.params.unemptiedColors;
			const targets =
				step.subject.k === 'player' || step.subject.k === 'playerRef'
					? run.players(step.subject)
					: [you];
			for (const pl of targets) {
				if (pl.lost) continue;
				if (pl.unemptiedManaColorsThisTurn === 'all') continue;
				if (step.params?.unemptiedColors === 'all' || !step.params?.unemptiedColors) {
					pl.unemptiedManaColorsThisTurn = 'all';
					continue;
				}
				const list: ManaColor[] = Array.isArray(pl.unemptiedManaColorsThisTurn)
					? pl.unemptiedManaColorsThisTurn
					: [];
				pl.unemptiedManaColorsThisTurn = list;
				for (const c of colors) {
					if (!list.includes(c)) list.push(c);
				}
			}
			return;
		}
		// --- End Track P10 ---
		case 'attach': {
			if (executeWave11Attach(run, step)) return;
			// --- Track P10 ---
			return executeAttachP10(run.p10Host(), step);
			// --- End Track P10 ---
		}
		case 'phaseOut': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
			// CR 702.26h: If an attachment and its host are both instructed to phase out simultaneously
			// (e.g. "All permanents you control phase out"), the attachment phases out indirectly via its host.
			const batchIds = new Set(objs.map((o) => o.instanceId));
			const hasHostPhasingOut = (obj: CardInstance): boolean => {
				const seen = new Set<string>();
				let cur = obj.attachedToId;
				while (cur && !seen.has(cur)) {
					if (batchIds.has(cur)) return true;
					seen.add(cur);
					const host = p.findPermanent(s, cur);
					if (!host || host.inst.phasedOut) return false;
					cur = host.inst.attachedToId;
				}
				return false;
			};
			for (const o of objs) {
				if (!hasHostPhasingOut(o)) {
					p.phaseOut(s, o);
					applyWave11PhaseOutMark(run, step, o);
				}
			}
			if (objs.length > 0) p.addLog(s, 'rule', `${title} phased out ${objs.length} permanent(s) (CR 702.26).`, you.playerId);
			return;
		}
		case 'switchPT': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			for (const o of objs) {
				o.switchedPTCount = (o.switchedPTCount || 0) + 1;
				p.addLog(s, 'cast', `${title} switched ${o.card.name}'s power and toughness until end of turn (Layer 7d).`, you.playerId);
			}
			return;
		}
		case 'extraTurn':
			for (const pl of run.players(step.subject)) {
				if (!s.extraTurnQueue) s.extraTurnQueue = [];
				// CR 500.7: the most recently created extra turn is taken first.
				s.extraTurnQueue.push(pl.playerId);
				p.addLog(s, 'rule', `${pl.username} will take an extra turn after this one (CR 500.7)!`, you.playerId);
			}
			return;
		case 'endTurn':
			if (step.params?.activePlayerMay) {
				p.activePlayerMayEndTurn(s, you, run.ctx.sourceCard.name);
				if (!s.stack.some((st) => st.id === run.ctx.item.id)) {
					run.result.turnEnded = true;
				}
				return;
			}
			p.endTurn(s, you.playerId);
			run.result.turnEnded = true;
			return;
		case 'win':
		case 'lose': {
			if (step.params?.condition && !run.condition(step.params.condition)) return;
			for (const pl of run.players(step.subject)) {
				if (step.verb === 'win') p.win(s, pl, `${title} win condition`);
				else p.lose(s, pl, `${title} ("you lose the game")`);
			}
			return;
		}
		case 'sacrifice':
			return run.sacrifice(step);
		case 'discard':
			return run.discard(step);
		case 'revealAndDiscard':
			return run.revealAndDiscard(step);
		case 'tap':
		case 'untap':
		case 'tapOrUntap' as Verb: {
			let objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			// --- Track P16a: Non-targeted choice tap/untap ("tap/untap up to N <filter> you control") ---
			if (step.params?.choiceCount !== undefined) {
				const chooser = (step.actor ? run.playerRef(step.actor) : null) ?? you;
				const want = Math.min(objs.length, Math.max(0, run.amount(step.params.choiceCount, 1)));
				const minPick = step.params.upTo ? 0 : want;
				const choiceKey = `tapuntap_pick:${run.stepIndex}`;
				if (want <= 0) {
					if (step.params.upTo) run.stepDecisions[run.stepIndex] = false;
					run.bind(step, []);
					return;
				}
				const sortedForBot = [...objs].sort((a, b) => {
					if (step.verb === 'untap' && a.tapped !== b.tapped) return a.tapped ? -1 : 1;
					if (step.verb === 'tap' && a.tapped !== b.tapped) return !a.tapped ? -1 : 1;
					return objectManaValue(s, b) - objectManaValue(s, a);
				});
				if (
					!chooser.isBot &&
					run.canPause &&
					(step.params.upTo || objs.length > minPick) &&
					!run.answers[choiceKey]
				) {
					const actionWord = step.verb === 'untap' ? 'untap' : 'tap';
					run.pauseForChoice(
						chooser,
						`${title} — Choose Permanent(s) to ${actionWord === 'untap' ? 'Untap' : 'Tap'}`,
						`Choose ${minPick === want ? want : `up to ${want}`} permanent(s) to ${actionWord}.`,
						objs.map((c) => c.instanceId),
						minPick,
						want,
						'battlefield',
						sortedForBot.slice(0, want).map((c) => c.instanceId),
						choiceKey
					);
					return;
				}
				objs =
					run.answers[choiceKey]?.kind === 'chooseObjects'
						? (run.answered(choiceKey, objs, minPick, want) ?? [])
						: sortedForBot.slice(0, step.params.upTo ? sortedForBot.filter((x) => (step.verb === 'untap' ? x.tapped : !x.tapped)).slice(0, want).length : want);
				run.stepDecisions[run.stepIndex] = objs.length > 0;
			}
			// --- End Track P16a ---
			run.bind(step, objs);
			const explicitTap = (step.params as { tap?: boolean } | undefined)?.tap;
			// --- Track P19a ---
			let tappedThisWayCount = 0;
			// --- End Track P19a ---
			for (const o of objs) {
				const shouldTap =
					step.verb === 'tap'
						? true
						: step.verb === 'untap'
							? false
							: explicitTap !== undefined
								? Boolean(explicitTap)
								: !o.tapped;
				if (shouldTap) {
					// --- Track P10 ---
					const preSnap = run.captureTriggerEventLki(o);
					const wasTapped = o.tapped;
					tapPermanent(s, o);
					if (!wasTapped && o.tapped) {
						run.recordStepActedObject(o, preSnap, false);
						// --- Track P19a ---
						tappedThisWayCount++;
						// --- End Track P19a ---
					}
					// --- End Track P10 ---
				} else if (o.tapped) {
					// CR 122.1d: If a permanent with a stun counter on it would become untapped,
					// instead remove a stun counter from it.
					if ((o.counters.stun || 0) > 0) {
						const prevStun = o.counters.stun || 0;
						const nextStun = Math.max(0, prevStun - 1);
						o.counters.stun = nextStun;
						noteLayerInputsChanged(s);
						p.addLog(
							s,
							'rule',
							`A stun counter was removed from ${o.card.name} instead of untapping it (CR 122.1d).`,
							you.playerId
						);
						if (!o.phasedOut) {
							emitEvent(s, {
								kind: 'CounterRemoved',
								objectId: o.instanceId,
								object: o,
								counterType: 'stun',
								amount: 1,
								previousCount: prevStun,
								newCount: nextStun
							});
							flushTriggers(s);
						}
					} else {
						// --- Track P10 ---
						const preSnap = run.captureTriggerEventLki(o);
						o.tapped = false;
						noteLayerInputsChanged(s);
						// --- Track P16a (CR 611.2b): Latch any remains-tapped source conditions ---
						latchBrokenP16aSourceConditions(s);
						// --- End Track P16a ---
						run.recordStepActedObject(o, preSnap, false);
						if (!o.phasedOut) {
							emitEvent(s, {
								kind: 'BecomesUntapped',
								objectId: o.instanceId,
								object: o
							});
							flushTriggers(s);
						}
						// --- End Track P10 ---
					}
				}
			}
			// --- Track P19a ---
			if (step.verb === 'tap' || Boolean(explicitTap)) {
				run.recordCountedKind('tappedThisWay', tappedThisWayCount);
			}
			// --- End Track P19a ---
			return;
		}
		case 'freezeUntap': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			// --- Track P16a (CR 611.2b): Source-conditioned untap locks ---
			const dur = step.params?.duration;
			if (dur === 'forAsLongAsSelfRemainsTapped' || dur === 'forAsLongAsYouControlSelf') {
				const srcVer =
					run.ctx.item.sourceObjectVersion ??
					run.locate(run.ctx.sourceId)?.inst.objectVersion ??
					1;
				const p16Dur = buildP16aDurationExpiryFields(
					s,
					dur,
					run.ctx.sourceId,
					srcVer,
					you.playerId
				);
				if (!p16Dur.ok || !p16Dur.fields?.sourceCondition) return;
				for (const o of objs) {
					(o.doesntUntapWhileSource ??= []).push({ ...p16Dur.fields.sourceCondition });
					const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
					p.addLog(
						s,
						'rule',
						`${objLabel} doesn't untap during its controller's untap step for as long as ${run.ctx.sourceCard.name}'s duration holds (${title}).`,
						you.playerId
					);
				}
				return;
			}
			// --- End Track P16a ---
			for (const o of objs) {
				if (applyNextUntapFreeze(o)) {
					const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
					p.addLog(
						s,
						'rule',
						`${objLabel} won't untap during its controller's next untap step (${title}).`,
						you.playerId
					);
				}
			}
			return;
		}
		case 'exert': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			for (const o of objs) {
				if (exertPermanent(s, o, you.playerId)) {
					run.recordStepActedObject(o);
					const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
					p.addLog(
						s,
						'rule',
						`${you.username} exerted ${objLabel} (${title}).`,
						you.playerId
					);
				}
			}
			flushTriggers(s);
			return;
		}
		case 'transform': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			// --- Track P15 (CR 702.145c,f): Daybound/Nightbound permanents can't transform via external effects ---
			// --- Track P18b (CR 713.1c): Melded permanents cannot transform ---
			for (const o of objs) {
				if (!isMeldedPermanent(o) && canExternalEffectTransform(s, o)) p.transformPermanent(s, o);
			}
			// --- End Track P18b ---
			// --- End Track P15 ---
			return;
		}
		case 'flip': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			for (const o of objs) p.flipPermanent(s, o);
			return;
		}
		case 'copySpell': {
			if (step.params?.copyAllControlledSpellsAndOtherAbilities) {
				executeUlalekCopyStackWave9(run, step);
				return;
			}
			const sel = step.subject;
			let orig: StackItem | undefined;
			if (sel.k === 'target') {
				const t = run.targetsForSpecIndex(sel.index)[0];
				orig =
					t?.kind === 'stack'
						? s.stack.find((item) => item.id === t.id || item.sourceInstanceId === t.id)
						: undefined;
				// --- Track P22d (CR 707.10b): fallback to countered spell LKI in bindings ---
				if (!orig && t?.kind === 'stack') {
					for (const list of run.bindings.values()) {
						const hit = list.find(
							(b) =>
								b.counteredStackLki &&
								(b.counteredStackLki.id === t.id ||
									b.counteredStackLki.sourceInstanceId === t.id)
						);
						if (hit?.counteredStackLki) {
							orig = hit.counteredStackLki;
							break;
						}
					}
				}
				// --- End Track P22d ---
			} else if (sel.k === 'eventObject') {
				orig = step.params?.copyEventAbility
					? (run.ctx.item.triggerEventStackItem ??
						(run.ctx.eventObjectId
							? s.stack.find(
									(item) =>
										item.id !== run.ctx.item.id &&
										(item.sourceInstanceId === run.ctx.eventObjectId ||
											item.id === run.ctx.eventObjectId)
								)
							: undefined))
					: (run.ctx.eventObjectId
						? s.stack.find(
								(item) =>
									item.id !== run.ctx.item.id &&
									(item.sourceInstanceId === run.ctx.eventObjectId ||
										item.id === run.ctx.eventObjectId)
							)
						: undefined) ?? run.ctx.item.triggerEventStackItem;
			} else if (sel.k === 'self') {
				orig =
					s.stack.find(
						(item) =>
							item.id !== run.ctx.item.id &&
							item.kind === 'spell' &&
							(item.sourceInstanceId === run.ctx.sourceId || item.id === run.ctx.sourceId)
					) ??
					run.ctx.item.triggerEventStackItem ??
					(run.ctx.item.kind === 'spell' ? run.ctx.item : undefined);
			} else if (sel.k === 'binding') {
				const boundList = run.bindings.get(sel.name);
				const bId = boundList?.[0]?.id;
				orig = bId
					? s.stack.find(
							(item) =>
								item.id !== run.ctx.item.id &&
								(item.id === bId || item.sourceInstanceId === bId)
						)
					: undefined;
				// --- Track P22d (CR 707.10b): copy countered bound spell using captured LKI ---
				if (!orig && boundList?.[0]?.counteredStackLki) {
					orig = boundList[0].counteredStackLki;
				}
				// --- End Track P22d ---
			}
			if (!orig) return;
			// --- Track P22c ---
			if (spellCannotBeCopied(s, orig)) return;
			// --- End Track P22c ---

			const count = step.params?.count ? Math.max(0, run.amount(step.params.count)) : 1;
			if (count <= 0) return;

			const copyActor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			const sameRefList = (a: TargetRef[], b: TargetRef[]) =>
				a.length === b.length &&
				a.every((x, idx) => x.kind === b[idx]?.kind && x.id === b[idx]?.id);

			const { paused } = run.runIndexedBatch(
				`copy_batch:${run.stepIndex}`,
				() => Array.from({ length: count }, (_, idx) => String(idx)),
				(_batchEntry, k) => {
					let chosenTargets: TargetRef[] = orig.targets.map((trg) => ({ ...trg }));
					let chosenTargetsBySpec: TargetRef[][] | undefined = orig.targetsBySpec
						? orig.targetsBySpec.map((bucket) => bucket.map((trg) => ({ ...trg })))
						: undefined;

					if (step.params?.mayChooseNewTargets && orig.targets.length > 0) {
						const slots = p.getStackItemRetargetSlots(s, orig, copyActor.playerId);
						const hasLegalAlternative =
							slots.length > 0 &&
							slots.some((sl) => {
								if (sl.spec.min === 0 && sl.originalTargets.length > 0) return true;
								if (sl.legalCandidates.length < sl.spec.min) return false;
								if (sl.legalCandidates.length > sl.originalTargets.length) return true;
								return !sameRefList(sl.legalCandidates, sl.originalTargets);
							});

						if (hasLegalAlternative) {
							if (copyActor.isBot || !run.canPause) {
								const botChoice = p.chooseBotStackItemRetarget(s, copyActor, orig, slots, k);
								chosenTargets = botChoice.targets;
								chosenTargetsBySpec = botChoice.targetsBySpec;
							} else {
								const ynKey = `retarget_yn:${run.stepIndex}:${k}`;
								const ynAns = run.answers[ynKey];
								if (!ynAns || ynAns.kind !== 'yesNo') {
									const copyLabel =
										count > 1
											? `copy #${k + 1} of ${orig.card.name}`
											: `the copy of ${orig.card.name}`;
									const curDesc = orig.targets.map((trg) => trg.label).join(', ');
									run.pauseForYesNo(
										copyActor,
										`${run.ctx.title} — Retarget Copy`,
										`Choose new targets for ${copyLabel}? (Current target${orig.targets.length === 1 ? '' : 's'}: ${curDesc})`,
										ynKey,
										{ yesLabel: 'Choose new targets', noLabel: 'Keep current targets' }
									);
									return;
								}

								if (ynAns.yes) {
									const nextBySpec: TargetRef[][] = [];
									for (let sIdx = 0; sIdx < slots.length; sIdx++) {
										const sl = slots[sIdx];
										if (sl.spec.min > 0 && sl.legalCandidates.length < sl.spec.min) {
											nextBySpec.push(sl.originalTargets.map((trg) => ({ ...trg })));
											continue;
										}
										const pool: TargetRef[] = [...sl.legalCandidates];
										if (slots.length > 1) {
											for (const origT of sl.originalTargets) {
												if (!pool.some((c) => c.kind === origT.kind && c.id === origT.id)) {
													pool.push({ ...origT });
												}
											}
										}
										if (pool.length === 0) {
											nextBySpec.push([]);
											continue;
										}
										const maxPick = Math.min(sl.spec.max, pool.length);
										const slotKey = `retarget_slot:${run.stepIndex}:${k}:${sIdx}`;
										const slotAns = run.answers[slotKey];
										if (!slotAns || slotAns.kind !== 'chooseObjects') {
											const altCands = sl.legalCandidates.filter(
												(c) => !sl.originalTargets.some((o) => o.kind === c.kind && o.id === c.id)
											);
											const defaultRefs =
												altCands.length >= sl.spec.min
													? altCands.slice(0, Math.max(1, sl.spec.min))
													: sl.legalCandidates.slice(0, sl.spec.min);
											const copyTitle =
												count > 1
													? `Copy #${k + 1} of ${orig.card.name}`
													: `Copy of ${orig.card.name}`;
											const countDesc =
												sl.spec.min === maxPick ? `${maxPick}` : `${sl.spec.min}–${maxPick}`;
											run.pauseForChoice(
												copyActor,
												`${copyTitle} — Choose New Target`,
												`Choose ${countDesc} target(s) for ${copyTitle}.`,
												pool.map((c) => c.id),
												sl.spec.min,
												maxPick,
												sl.zone === 'player' ? 'battlefield' : sl.zone,
												defaultRefs.map((r) => r.id),
												slotKey,
												'step'
											);
											return;
										}
										const picked = slotAns.objectIds
											.map((id) => pool.find((c) => c.id === id))
											.filter((c): c is TargetRef => Boolean(c));
										for (const c of sl.legalCandidates) {
											if (picked.length >= sl.spec.min) break;
											if (!picked.some((x) => x.kind === c.kind && x.id === c.id)) {
												picked.push(c);
											}
										}
										nextBySpec.push(picked.slice(0, maxPick));
									}
									if (p.validateStackItemRetarget(s, orig, copyActor.playerId, nextBySpec)) {
										chosenTargetsBySpec = nextBySpec;
										chosenTargets = nextBySpec.flat();
									}
								}
							}
						}
					}

					p.pushCopiedStackItem(s, copyActor, orig, chosenTargets, chosenTargetsBySpec, {
						exceptColors: step.params?.exceptColors,
						nonLegendary: step.params?.nonLegendary
					});
				}
			);
			if (paused) return;
			return;
		}
		case 'mill': {
			const batchKey = `batch:${run.stepIndex}:mill`;
			// --- Track P16a: Bind milled cards so "if a <filter> card was milled this way" resolves ---
			const milled: CardInstance[] = [];
			// --- End Track P16a ---
			const { paused } = run.runIndexedBatch(
				batchKey,
				() => {
					const slots: string[] = [];
					for (const pl of run.players(step.subject)) {
						const n = Math.min(run.amount(step.amount), pl.library.length);
						for (let i = 0; i < n; i++) slots.push(pl.playerId);
						if (n > 0) p.addLog(s, 'rule', `${pl.username} milled ${n} card(s).`, you.playerId);
					}
					return slots;
				},
				(playerId) => {
					const pl = run.player(playerId);
					if (!pl || pl.library.length === 0) return;
					const topInst = pl.library[0];
					const res = moveObject(s, topInst, 'graveyard', {
						from: { player: pl, zone: 'library' },
						toPlayer: pl,
						graveyardReplacement: true,
						bumpVersion: true,
						newTimestamp: true
					});
					// --- Track P16a ---
					if (topInst.zone !== 'library') milled.push(topInst);
					// --- End Track P16a ---
					return res;
				}
			);
			if (paused) return;
			// --- Track P16a ---
			run.bind(step, milled);
			// --- End Track P16a ---
			run.recordCountedKind('milledThisWay', milled.length);
			run.recordCountedKind(
				'milledTotalManaValue',
				milled.reduce((sum, c) => sum + objectManaValue(s, c), 0)
			);
			return;
		}
		case 'scry':
		case 'lookAndReorder': {
			const n = run.amount(step.amount);
			for (const pl of run.players(step.subject)) {
				p.scry(s, pl, run.ctx.item, n, step.verb === 'scry' ? 'scry' : 'rearrange', Boolean(step.params?.mayShuffle));
			}
			return;
		}
		case 'surveil': {
			const n = run.amount(step.amount);
			const { paused } = run.runIndexedBatch(
				`surveil:${run.stepIndex}`,
				() => run.players(step.subject).map((pl) => pl.playerId),
				(pid) => {
					const pl = run.player(pid);
					if (!pl || pl.lost) return;
					const promptsBefore = s.pendingPrompts.length;
					p.scry(s, pl, run.ctx.item, n, 'surveil', false);
					if (
						s.pendingPrompts.length > promptsBefore ||
						s.pendingProcedure?.kind === 'surveil_graveyard'
					) {
						return 'pending';
					}
				}
			);
			if (paused) return;
			return;
		}
		case 'investigate': {
			const actor = step.actor ? run.playerRef(step.actor) : you;
			if (!actor || actor.lost) return;
			const n = Math.max(0, run.amount(step.amount, 1));
			const clueSpec = predefinedTokenToSpec(PREDEFINED_TOKEN_DEFS.clue);
			const made: CardInstance[] = [];
			for (let i = 0; i < n; i++) {
				const mult = tokenMultiplier(s, actor.playerId);
				for (let j = 0; j < mult; j++) made.push(p.createToken(s, actor, clueSpec));
				p.addLog(s, 'rule', `${actor.username} investigated.`, actor.playerId);
				emitEvent(s, {
					kind: 'Investigated',
					playerId: actor.playerId,
					count: 1
				});
				flushTriggers(s);
			}
			run.bind(step, made);
			return;
		}
		case 'search': {
			const actor = step.actor ? run.playerRef(step.actor) : you;
			if (!actor || actor.lost) return;
			const rawSearch = step.params?.search;
			if (!rawSearch) return;
			// --- Track P19a: Dynamic `step.amount` on `search` ("up to X basic land cards") ---
			let search = rawSearch;
			if (step.amount && step.amount.k !== 'const') {
				const dynCount = Math.max(0, run.amount(step.amount, rawSearch.count));
				if (dynCount === 0) {
					shuffleLibrary(s, actor);
					p.addLog(
						s,
						'rule',
						`${actor.username} searched their library for 0 cards and shuffled.`,
						actor.playerId
					);
					return;
				}
				const baseDests =
					rawSearch.destinations.length > 0
						? rawSearch.destinations
						: [{ zone: 'hand' as const }];
				const paddedDests =
					dynCount > baseDests.length
						? Array.from(
								{ length: dynCount },
								(_, i) => baseDests[i] ?? { ...baseDests[baseDests.length - 1] }
							)
						: baseDests.slice(0, dynCount);
				search = { ...rawSearch, count: dynCount, destinations: paddedDests };
			}
			const searchStep =
				search === rawSearch
					? step
					: { ...step, params: { ...step.params, search } };
			// --- End Track P19a ---
			if (
				(search.castFree || search.targetControllerAsActor || Boolean(search.filter.anyOf)) &&
				executeSearchWave9(run, searchStep, {
					matches: (inst, filter, zone) => run.matches(inst, filter, zone),
					answered: (key, cands, min, max) => run.answered(key, cands, min, max),
					executeCastFreeStep: (castStep) => executeCastFree(run.p16aHost(), castStep)
				})
			) {
				return;
			}
			// --- Track P10 ---
			if (isP10ExtendedSearch(search)) {
				return executeMultiZoneSearchP10(run.p10Host(), searchStep);
			}
			// --- End Track P10 ---
			p.search(s, actor, legacySearchSpec(search), run.ctx.item);
			return;
		}
		case 'delayedTrigger':
			return run.delayed(step);
		case 'dig':
			return run.dig(step);
		case 'goad':
			return run.goad(step);
		case 'explore':
			return run.explore(step);
		case 'connive':
			return run.connive(step);
		case 'regenerate': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			for (const o of objs) {
				o.regenerationShields = (o.regenerationShields ?? 0) + 1;
				p.addLog(
					s,
					'rule',
					`${title}: created a regeneration shield on ${o.card.name} (CR 701.19a).`,
					you.playerId
				);
			}
			return;
		}
		case 'cantRegenerate': {
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			for (const o of objs) {
				o.cantBeRegeneratedThisTurn = true;
				p.addLog(
					s,
					'rule',
					`${title}: ${o.card.name} can't be regenerated this turn.`,
					you.playerId
				);
			}
			return;
		}
		case 'payCost':
			return;
		case 'animate': {
			const objs = run.objects(step.subject).filter((o) => {
				if (o.zone !== 'battlefield' || o.phasedOut) return false;
				if (
					step.subject.k === 'self' &&
					run.ctx.item.sourceObjectVersion !== undefined &&
					o.objectVersion !== run.ctx.item.sourceObjectVersion
				) {
					return false;
				}
				return true;
			});
			run.bind(step, objs);
			if (objs.length === 0) return;
			const pParams = step.params ?? {};
			const setTypes = pParams.setTypes?.length ? [...pParams.setTypes] : undefined;
			const addTypes = !setTypes
				? pParams.addTypes?.length
					? [...pParams.addTypes]
					: ['Creature']
				: undefined;
			let setSubtypes =
				pParams.setSubtypes !== undefined ? [...pParams.setSubtypes] : undefined;
			let addSubtypes = pParams.addSubtypes?.length ? [...pParams.addSubtypes] : undefined;
			// --- Track P16a: Choice-based creature type / basic land type & non-type-changing Layer 5/7b ---
			const BASIC_LAND_SUBTYPES_SET = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);
			const isPureBasicLandSubtypeShift =
				Boolean(
					pParams.setSubtypes?.some((st) => BASIC_LAND_SUBTYPES_SET.has(st)) ||
						pParams.addSubtypes?.some((st) => BASIC_LAND_SUBTYPES_SET.has(st))
				);
			const suppressDefaultCreatureType =
				!pParams.addTypes?.length &&
				!pParams.setTypes?.length &&
				Boolean(
					pParams.chooseBasicLandType ||
						pParams.chooseCreatureType ||
						pParams.chooseColorForAnimate ||
						pParams.keepExistingTypes ||
						pParams.removeTypes?.length ||
						isPureBasicLandSubtypeShift
				);
			const effectiveAddTypes = suppressDefaultCreatureType ? undefined : addTypes;
			if (pParams.chooseCreatureType) {
				const chosenCreatureSub = resolveChosenCreatureSubtypeForAnimate(run.p16aHost());
				if (chosenCreatureSub === null) return;
				if (pParams.keepExistingTypes) {
					(addSubtypes ??= []).push(chosenCreatureSub);
				} else {
					setSubtypes = [chosenCreatureSub];
				}
			}
			if (pParams.chooseBasicLandType) {
				const chosenLandSub = resolveChosenBasicLandSubtypeForAnimate(run.p16aHost());
				if (chosenLandSub === null) return;
				if (pParams.keepExistingTypes) {
					(addSubtypes ??= []).push(chosenLandSub);
				} else {
					setSubtypes = [chosenLandSub];
				}
			}
			const layer4Raw = {
				...(effectiveAddTypes ? { addTypes: effectiveAddTypes } : {}),
				...(setTypes ? { setTypes } : {}),
				...(pParams.removeTypes?.length ? { removeTypes: [...pParams.removeTypes] } : {}),
				...(addSubtypes ? { addSubtypes } : {}),
				...(setSubtypes !== undefined ? { setSubtypes } : {})
			};
			const layer4 = Object.keys(layer4Raw).length > 0 ? layer4Raw : undefined;
			// --- End Track P16a ---
			// --- Track P19a: Choice-based color change ("becomes the color of your choice" / "in addition to its other colors") ---
			let animSetColors =
				pParams.setColors !== undefined ? [...pParams.setColors] : undefined;
			let animAddColors = pParams.addColors?.length ? [...pParams.addColors] : undefined;
			if (pParams.chooseColorForAnimate) {
				const chosenColRes = resolveP19aChosenColorsForAnimate(
					run.p19aHost(),
					pParams.chooseColorForAnimate
				);
				if (chosenColRes === null) return;
				if (pParams.addColors?.length) {
					animAddColors = [...new Set([...pParams.addColors, ...chosenColRes])];
				} else {
					animSetColors = chosenColRes;
				}
			}
			const layer5 =
				animSetColors !== undefined || animAddColors?.length
					? {
							...(animSetColors !== undefined ? { setColors: animSetColors } : {}),
							...(animAddColors?.length ? { addColors: animAddColors } : {})
						}
					: undefined;
			// --- End Track P19a ---
			const layer6 =
				pParams.addKeywords?.length ||
				pParams.grantedAbilityTexts?.length ||
				pParams.removeAllAbilities
					? {
							...(pParams.addKeywords?.length ? { addKeywords: [...pParams.addKeywords] } : {}),
							...(pParams.grantedAbilityTexts?.length
								? { grantedAbilityTexts: [...pParams.grantedAbilityTexts] }
								: {}),
							...(pParams.removeAllAbilities ? { removeAllAbilities: true } : {})
						}
					: undefined;
			// --- Track P19a: Support `{ k: 'stat', of: { k: 'affected' } }` per animated object (e.g. Sydri, Karn) ---
			const evalAnimAmountFor = (amt: Amount, obj: CardInstance): number => {
				if (amt.k === 'stat' && amt.of.k === 'affected') {
					const snap = run.snapshot(obj);
					return amt.stat === 'power'
						? snap.power
						: amt.stat === 'toughness'
							? snap.toughness
							: snap.manaValue;
				}
				return run.amount(amt);
			};
			// --- End Track P19a ---
			// --- Track P13 + Track P16a ---
			const animDur = pParams.duration ?? 'endOfTurn';
			let expiryFields: ReturnType<typeof buildDurationExpiryFields>;
			if (
				animDur === 'untilEndOfCombat' ||
				animDur === 'forAsLongAsYouControlSelf' ||
				animDur === 'forAsLongAsSelfRemainsTapped'
			) {
				const srcVer =
					run.ctx.item.sourceObjectVersion ??
					run.locate(run.ctx.sourceId)?.inst.objectVersion ??
					1;
				const p16Dur = buildP16aDurationExpiryFields(
					s,
					animDur,
					run.ctx.sourceId,
					srcVer,
					you.playerId
				);
				if (!p16Dur.ok || !p16Dur.fields) return;
				expiryFields = p16Dur.fields;
			} else {
				expiryFields = buildDurationExpiryFields(s, animDur, you.playerId);
			}
			// --- End Track P13 + Track P16a ---
			for (const o of objs) {
				const layer7b =
					pParams.setPower !== undefined && pParams.setToughness !== undefined
						? {
								setPower: evalAnimAmountFor(pParams.setPower, o),
								setToughness: evalAnimAmountFor(pParams.setToughness, o)
							}
						: undefined;
				const ts = allocateTimestamp(s);
				(s.timedContinuousEffects ??= []).push({
					timestamp: ts,
					sourceName: run.ctx.sourceCard.name,
					controllerId: you.playerId,
					affected: [{ instanceId: o.instanceId, objectVersion: o.objectVersion ?? 1 }],
					...expiryFields,
					...(layer4 ? { layer4 } : {}),
					...(layer5 ? { layer5 } : {}),
					...(layer6 ? { layer6 } : {}),
					...(layer7b ? { layer7b } : {})
				});
				noteLayerInputsChanged(s);
				if (run.ctx.item.crewedByIds !== undefined) {
					const prev = o.crewedThisTurnByIds ?? [];
					const merged = [...prev];
					for (const cid of run.ctx.item.crewedByIds) {
						if (!merged.includes(cid)) merged.push(cid);
					}
					o.crewedThisTurnByIds = merged;
					emitEvent(s, {
						kind: 'BecomesCrewed',
						playerId: you.playerId,
						objectId: o.instanceId,
						object: o,
						crewedByIds: [...run.ctx.item.crewedByIds]
					});
				}
			}
			return;
		}
		case 'saddle': {
			const objs = run.objects(step.subject).filter(
				(o) =>
					o.zone === 'battlefield' &&
					!o.phasedOut &&
					(step.subject.k !== 'self' ||
						run.ctx.item.sourceObjectVersion === undefined ||
						(o.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
			);
			run.bind(step, objs);
			for (const o of objs) {
				o.saddledThisTurn = true;
				const saddledBy = run.ctx.item.saddledByIds ?? [];
				const prev = o.saddledThisTurnByIds ?? [];
				const merged = [...prev];
				for (const cid of saddledBy) {
					if (!merged.includes(cid)) merged.push(cid);
				}
				o.saddledThisTurnByIds = merged;
				noteLayerInputsChanged(s);
				p.addLog(
					s,
					'rule',
					`${o.card.name} became saddled until end of turn (CR 702.171a).`,
					you.playerId
				);
				emitEvent(s, {
					kind: 'BecomesSaddled',
					playerId: you.playerId,
					objectId: o.instanceId,
					object: o,
					saddledByIds: [...saddledBy]
				});
			}
			return;
		}
		case 'cumulativeUpkeep': {
			const f = run.locate(run.ctx.sourceId);
			const onBf = Boolean(
				f &&
					f.zone === 'battlefield' &&
					!f.inst.phasedOut &&
					(run.ctx.item.sourceObjectVersion === undefined ||
						(f.inst.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
			);
			const resumingOptionalCost =
				Boolean(run.pendingOptionalCost && run.pendingOptionalCost.stepIndex === run.stepIndex) ||
				run.stepDecisions[run.stepIndex] !== undefined;
			if (!onBf && !resumingOptionalCost) return;
			const ageCounters = onBf && f ? (f.inst.counters.age ?? 0) : 0;
			const scaledCost = scaleCumulativeUpkeepCost(
				step.params?.cumulativeUpkeepCost ?? [],
				ageCounters
			);
			const ephemeralStep: EffectStep = {
				...step,
				verb: 'sacrifice',
				optional: {
					chooser: { k: 'you' },
					cost: scaledCost,
					mode: 'doUnlessPaid'
				}
			};
			const shouldSacrifice = run.resolveOptional(ephemeralStep);
			if (run.result.paused || !shouldSacrifice) return;
			return run.sacrifice(step);
		}
		case 'gainControl': {
			const objs = run.objects(step.subject).filter(
				(o) => o.zone === 'battlefield' && !o.phasedOut
			);
			run.bind(step, objs);
			if (objs.length === 0) return;
			const actorPlayer = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			if (actorPlayer.lost) return;
			const duration = step.params?.duration ?? 'permanent';
			// --- Track P13 + Track P16a ---
			let expiryFields: ReturnType<typeof buildDurationExpiryFields>;
			if (
				duration === 'untilEndOfCombat' ||
				duration === 'forAsLongAsYouControlSelf' ||
				duration === 'forAsLongAsSelfRemainsTapped'
			) {
				const srcVer =
					run.ctx.item.sourceObjectVersion ??
					run.locate(run.ctx.sourceId)?.inst.objectVersion ??
					1;
				const p16Dur = buildP16aDurationExpiryFields(
					s,
					duration,
					run.ctx.sourceId,
					srcVer,
					you.playerId
				);
				if (!p16Dur.ok || !p16Dur.fields) return;
				expiryFields = p16Dur.fields;
			} else {
				expiryFields = buildDurationExpiryFields(s, duration, actorPlayer.playerId);
			}
			const expires = expiryFields.expires;
			// --- End Track P13 + Track P16a ---

			let untilSourceLeavesMeta: { sourceInstanceId: string; sourceObjectVersion: number } | undefined;
			if (expires === 'untilSourceLeaves') {
				const srcFound = run.ctx.sourceId ? p.findPermanent(s, run.ctx.sourceId) : null;
				const expectedVer = run.ctx.item.sourceObjectVersion;
				if (
					!srcFound ||
					(expectedVer !== undefined && (srcFound.inst.objectVersion ?? 1) !== expectedVer)
				) {
					return;
				}
				untilSourceLeavesMeta = {
					sourceInstanceId: srcFound.inst.instanceId,
					sourceObjectVersion: srcFound.inst.objectVersion ?? 1
				};
			}

			for (const o of objs) {
				if (!o.defaultControllerId) {
					o.defaultControllerId = o.controllerId;
				}
				const ts = allocateTimestamp(s);
				(s.timedContinuousEffects ??= []).push({
					timestamp: ts,
					sourceName: run.ctx.sourceCard.name,
					controllerId: actorPlayer.playerId,
					...expiryFields,
					affected: [{ instanceId: o.instanceId, objectVersion: o.objectVersion ?? 1 }],
					layer2: {
						controllerId: actorPlayer.playerId,
						...(untilSourceLeavesMeta ? { untilSourceLeaves: untilSourceLeavesMeta } : {})
					},
					...(step.params?.keywords?.length
						? { layer6: { addKeywords: [...step.params.keywords] } }
						: {})
				});
				if (step.params?.untap && o.tapped) {
					if ((o.counters.stun || 0) > 0) {
						o.counters.stun = Math.max(0, (o.counters.stun || 0) - 1);
					} else {
						o.tapped = false;
						// --- Track P10 ---
						if (!o.phasedOut) {
							emitEvent(s, {
								kind: 'BecomesUntapped',
								objectId: o.instanceId,
								object: o
							});
						}
						// --- End Track P10 ---
					}
				}
				const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
				p.addLog(
					s,
					'rule',
					`${actorPlayer.username} gains control of ${objLabel}${expires === 'endOfTurn' ? ' until end of turn' : ''}.`,
					actorPlayer.playerId
				);
			}
			noteLayerInputsChanged(s);
			syncBattlefieldControllers(s);
			// --- Track P16a ---
			if (step.params?.untap) {
				latchBrokenP16aSourceConditions(s);
			}
			// --- End Track P16a ---
			return;
		}
		case 'gainEnergy': {
			const n = Math.max(0, run.amount(step.amount, 0));
			if (n <= 0) return;
			const targets =
				step.subject.k === 'none' && step.actor
					? run.players({ k: 'playerRef', ref: step.actor })
					: run.players(step.subject);
			for (const pl of targets) {
				if (pl.lost) continue;
				// --- Track P22a ---
				const allowedEnergy = filterPlayerCountersGrantedWave8(s, pl.playerId, 'energy', n);
				if (allowedEnergy <= 0) continue;
				// --- End Track P22a ---
				pl.energyCounters = (pl.energyCounters || 0) + allowedEnergy;
				noteLayerInputsChanged(s);
				p.addLog(
					s,
					'rule',
					`${title}: ${pl.username} gets ${allowedEnergy} {E} (now ${pl.energyCounters} {E}).`,
					you.playerId
				);
			}
			return;
		}
		case 'becomeMonarch': {
			const targets =
				step.subject.k === 'none' && step.actor
					? run.players({ k: 'playerRef', ref: step.actor })
					: run.players(step.subject);
			const chosen = targets.find((pl) => !pl.lost);
			if (chosen) {
				p.setMonarch(s, chosen.playerId);
			}
			return;
		}
		// --- Track P5 ---
		case 'amass':
			return executeAmass(run.keywordHost(), step);
		case 'incubate':
			return executeIncubate(run.keywordHost(), step);
		case 'populate':
			return executePopulate(run.keywordHost(), step);
		case 'manifest':
			return executeManifestOrCloak(run.keywordHost(), step, 'manifest');
		case 'cloak':
			return executeManifestOrCloak(run.keywordHost(), step, 'cloak');
		case 'manifestDread':
			return executeManifestDread(run.keywordHost(), step);
		case 'monstrosity':
			return executeMonstrosity(run.keywordHost(), step);
		case 'bolster':
			return executeBolster(run.keywordHost(), step);
		case 'adapt':
			return executeAdapt(run.keywordHost(), step);
		// --- Track P10 ---
		case 'discover':
			return executeDiscover(run.p10Host(), step);
		case 'clash':
			return executeClash(run.p10Host(), step);
		case 'detain':
			return executeDetain(run.p10Host(), step);
		case 'suspect':
			return executeSuspect(run.p10Host(), step);
		case 'collectEvidence': {
			executeCollectEvidence(run.p10Host(), step);
			// --- Track P16b ---
			if (!run.result.paused && run.stepDecisions[run.stepIndex] !== false) {
				const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
				const evAmt = Math.max(0, run.amount(step.amount, 0));
				emitEvent(s, {
					kind: 'CollectedEvidence',
					playerId: actor.playerId,
					amount: evAmt,
					totalManaValue: evAmt
				});
			}
			// --- End Track P16b ---
			return;
		}
		case 'forage':
			return executeForage(run.p10Host(), step);
		case 'endure':
			return executeEndure(run.p10Host(), step);
		case 'timeTravel':
			return executeTimeTravel(run.p10Host(), step);
		case 'blight':
			return executeBlight(run.p10Host(), step);
		case 'fateseal':
			return executeFateseal(run.p10Host(), step);
		case 'flipCoin':
			return executeFlipCoin(run.p10Host(), step);
		case 'rollDie':
			return executeRollDie(run.p10Host(), step);
		// --- End Track P10 ---
		// --- Track P13 ---
		case 'createEmblem': {
			const recipients =
				step.subject.k === 'none'
					? step.actor
						? run.players({ k: 'playerRef', ref: step.actor })
						: [you]
					: run.players(step.subject);
			executeCreateEmblem(
				s,
				recipients,
				run.ctx.sourceCard.name || title,
				step.params?.emblemAbilities ?? []
			);
			return;
		}
		case 'createRoleToken': {
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			const roleKind = step.params?.roleKind;
			if (!roleKind) return;
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			const created: CardInstance[] = [];
			withSimultaneousZoneBatch(s, () => {
				created.push(...executeCreateRoleToken(s, actor, objs, roleKind));
			});
			run.bind(step, created);
			run.recordEffectAmount(created.length);
			return;
		}
		case 'doubleOrTriple': {
			if (executeWave11DoubleOrTriple(run, step)) return;
			const spec = step.params?.doubleSpec;
			if (!spec) return;
			const objs =
				spec.target === 'life'
					? []
					: run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			const pls =
				spec.target === 'life'
					? step.subject.k === 'none'
						? [you]
						: run.players(step.subject)
					: [];
			if (objs.length > 0) run.bind(step, objs);
			const delta = executeDoubleOrTriple(
				s,
				you,
				run.ctx.sourceCard.name || title,
				objs,
				pls,
				spec,
				run.p13LifeFunnels()
			);
			run.recordEffectAmount(delta);
			return;
		}
		case 'exchange': {
			if (executeWave11Exchange(run, step)) return;
			const spec = step.params?.exchangeSpec;
			if (!spec) return;
			const firstObjs =
				step.subject.k === 'none'
					? []
					: run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			const secondObjs = spec.second
				? run.objects(spec.second).filter((o) => o.zone === 'battlefield')
				: [];
			let pls: PlayerGameState[] = [];
			if (spec.kind === 'lifeTotals' || spec.kind === 'lifeAndPower' || spec.kind === 'lifeAndToughness') {
				pls = run.players(step.subject);
				if (spec.second) {
					for (const extra of run.players(spec.second)) {
						if (!pls.some((pl) => pl.playerId === extra.playerId)) pls.push(extra);
					}
				}
			}
			executeExchange(
				s,
				you,
				run.ctx.sourceCard.name || title,
				firstObjs,
				secondObjs,
				pls,
				spec,
				run.p13LifeFunnels()
			);
			return;
		}
		case 'turnFace': {
			const dir = step.params?.faceDirection ?? 'up';
			// --- Track P18b (CR 713.7): Melded permanents cannot be turned face down ---
			let objs = run.objects(step.subject).filter(
				(o) => o.zone === 'battlefield' && (dir !== 'down' || !isMeldedPermanent(o))
			);
			if (step.params?.choiceCount !== undefined) {
				const want = Math.min(objs.length, Math.max(0, run.amount(step.params.choiceCount, 1)));
				const minPick = step.params.upTo ? 0 : want;
				const pickKey = `turnface_pick:${run.stepIndex}`;
				if (want <= 0) {
					objs = [];
				} else if (!you.isBot && run.canPause && (step.params.upTo || objs.length > minPick) && !run.answers[pickKey]) {
					run.pauseForChoice(
						you,
						`${title} — Choose Permanent(s)`,
						`Choose ${minPick === want ? want : `up to ${want}`} permanent(s) to turn face ${dir}.`,
						objs.map((o) => o.instanceId),
						minPick,
						want,
						'battlefield',
						objs.slice(0, want).map((o) => o.instanceId),
						pickKey
					);
					return;
				} else if (run.answers[pickKey]?.kind === 'chooseObjects') {
					objs = run.answered(pickKey, objs, minPick, want) ?? [];
				} else {
					objs = objs.slice(0, want);
				}
			}
			// --- End Track P18b ---
			run.bind(step, objs);
			executeTurnFace(s, objs, dir);
			return;
		}
		case 'chooseDesignation': {
			const chooseKind = step.params?.chooseKind;
			if (!chooseKind) return;
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			executeChooseDesignation(
				s,
				actor,
				run.sourcePerm,
				chooseKind,
				`p13_desig:${run.stepIndex}`,
				run.p13AskFn(),
				// --- Precon Bragos Spirit ---
				run.ctx.item
				// --- End Precon Bragos Spirit ---
			);
			return;
		}
		case 'grantGraveyardCast': {
			const spec = step.params?.graveyardCastSpec;
			if (!spec) return;
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			const objs = run.objects(step.subject).filter((o) => o.zone === 'graveyard');
			run.bind(step, objs);
			executeGrantGraveyardCast(s, actor, run.ctx.sourceCard.name || title, objs, spec);
			return;
		}
		case 'ventureIntoDungeon': {
			const dungeonKind = step.params?.dungeonKind ?? 'dungeon';
			const players =
				step.subject.k === 'none'
					? step.actor
						? run.players({ k: 'playerRef', ref: step.actor })
						: [you]
					: run.players(step.subject);
			for (let idx = 0; idx < players.length; idx++) {
				const pl = players[idx];
				const doneKey = `p13_vent_done:${run.stepIndex}:${pl.playerId}:${idx}`;
				if (run.answers[doneKey]?.kind === 'yesNo' && run.answers[doneKey].yes) continue;
				const st = executeVentureIntoDungeon(
					s,
					pl,
					dungeonKind,
					`p13_venture:${run.stepIndex}:${pl.playerId}:${idx}`,
					run.p13AskFn()
				);
				if (st === 'PAUSED') return;
				run.answers[doneKey] = { kind: 'yesNo', yes: true };
			}
			return;
		}
		case 'takeInitiative': {
			const players =
				step.subject.k === 'none'
					? step.actor
						? run.players({ k: 'playerRef', ref: step.actor })
						: [you]
					: run.players(step.subject);
			const chosen = players.find((pl) => !pl.lost);
			if (chosen) {
				executeTakeInitiative(
					s,
					chosen,
					`p13_init:${run.stepIndex}`,
					run.p13AskFn()
				);
			}
			return;
		}
		case 'temptWithRing': {
			const players =
				step.subject.k === 'none'
					? step.actor
						? run.players({ k: 'playerRef', ref: step.actor })
						: [you]
					: run.players(step.subject);
			for (let idx = 0; idx < players.length; idx++) {
				const pl = players[idx];
				const doneKey = `p13_ring_done:${run.stepIndex}:${pl.playerId}:${idx}`;
				if (run.answers[doneKey]?.kind === 'yesNo' && run.answers[doneKey].yes) continue;
				const st = executeTemptWithRing(
					s,
					pl,
					`p13_ring:${run.stepIndex}:${pl.playerId}:${idx}`,
					run.p13AskFn()
				);
				if (st === 'PAUSED') return;
				run.answers[doneKey] = { kind: 'yesNo', yes: true };
			}
			return;
		}
		case 'earthbend': {
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
			run.bind(step, objs);
			const n = Math.max(0, run.amount(step.amount, 0));
			executeEarthbend(s, actor, run.ctx.sourceCard.name || title, objs, n);
			return;
		}
		case 'airbend': {
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			if (step.subject.k === 'target') {
				const refs = run.targetsForSpecIndex(step.subject.index);
				for (const ref of refs) {
					if (ref.kind === 'stack') {
						const stItem =
							s.stack.find((x) => x.id === ref.id || x.sourceInstanceId === ref.id) ?? null;
						executeAirbend(s, actor, null, stItem);
					} else if (ref.kind === 'permanent') {
						const perm = run.locate(ref.id)?.inst ?? null;
						executeAirbend(s, actor, perm, null);
					}
				}
			} else {
				const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield');
				run.bind(step, objs);
				for (const o of objs) {
					executeAirbend(s, actor, o, null);
				}
			}
			return;
		}
		case 'learn': {
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			executeLearn(
				s,
				actor,
				`p13_learn:${run.stepIndex}`,
				run.p13AskFn(),
				(pl, cnt) => p.drawCards(s, pl, cnt)
			);
			return;
		}
		case 'villainousChoice': {
			const opts = step.params?.villainousOptions;
			const labels = step.params?.villainousOptionLabels ?? ['Option 1', 'Option 2'];
			if (!opts) return;
			const opponents =
				step.subject.k === 'none'
					? run.apnapPlayers().filter((pl) => pl.playerId !== you.playerId)
					: run.players(step.subject);
			let inlineCursor = 0;
			executeVillainousChoice(
				opponents,
				labels,
				opts,
				`p13_vil:${run.stepIndex}`,
				run.p13AskFn(),
				(branchSteps, facingOpp) => {
					const tag = inlineCursor++;
					return run.runTrackedP13InlineSteps(branchSteps, tag, facingOpp.playerId);
				}
			);
			return;
		}
		case 'vote': {
			const spec = step.params?.voteSpec;
			if (!spec) return;
			const actor = (step.actor ? run.playerRef(step.actor) : null) ?? you;
			let inlineCursor = 0;
			executeCouncilVote(
				s,
				actor,
				spec,
				`p13_vote:${run.stepIndex}`,
				run.p13AskFn(),
				(branchSteps) => {
					const tag = inlineCursor++;
					return run.runTrackedP13InlineSteps(branchSteps, tag);
				}
			);
			return;
		}
		// --- End Track P13 ---
		// --- Track P15 ---
		case 'prepare':
		case 'unprepare': {
			const wantPrepared = step.verb === 'prepare';
			const objs = run.objects(step.subject).filter(
				(o) =>
					o.zone === 'battlefield' &&
					!o.phasedOut &&
					(step.subject.k !== 'self' ||
						run.ctx.item.sourceObjectVersion === undefined ||
						(o.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
			);
			run.bind(step, objs);
			for (const o of objs) {
				if (setPermanentPrepared(s, o, wantPrepared)) {
					p.addLog(
						s,
						'rule',
						`${o.card.name} became ${wantPrepared ? 'prepared' : 'unprepared'} (${title}).`,
						you.playerId
					);
				}
			}
			return;
		}
		case 'increaseSpeed': {
			const targets =
				step.subject.k === 'none'
					? step.actor
						? run.players({ k: 'playerRef', ref: step.actor })
						: [you]
					: run.players(step.subject);
			for (const pl of targets) {
				if (!pl.lost) increasePlayerSpeed(s, pl);
			}
			return;
		}
		// --- End Track P15 ---
		// --- Track P18b & P16a ---
		case 'harness': {
			const objs = run.objects(step.subject).filter(
				(o) =>
					o.zone === 'battlefield' &&
					!o.phasedOut &&
					(step.subject.k !== 'self' ||
						run.ctx.item.sourceObjectVersion === undefined ||
						(o.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
			);
			run.bind(step, objs);
			for (const o of objs) {
				if (executeHarnessStep(s, o)) {
					p.addLog(
						s,
						'rule',
						`${o.card.name} became harnessed (${title}, CR 701.64a).`,
						you.playerId
					);
				}
			}
			return;
		}
		case 'meld': {
			const melded = executeMeldStep(
				s,
				you,
				run.ctx.sourceId,
				run.ctx.item.sourceObjectVersion,
				step.params,
				{
					evaluatePermanentName: (st, perm) => evaluatePermanent(st, perm).effectiveName,
					moveFromBattlefield: (st, perm, dest) => p.moveFromBattlefield(st, perm, dest),
					mergeExiledPairOntoBattlefield,
					addLog: (st, kind, text, actorId) => p.addLog(st, kind, text, actorId)
				}
			);
			if (melded) {
				run.bind(step, [melded]);
			}
			flushTriggers(s);
			return;
		}
		// --- End Track P18b ---
		// --- Track P16a ---
		case 'pileSplit':
			return executePileSplit(run.p16aHost(), step);
		case 'castFree':
			return executeCastFree(run.p16aHost(), step);
		case 'putPlayerCounters':
			return executePutPlayerCounters(run.p16aHost(), step);
		case 'removeFromCombat':
			return executeRemoveFromCombat(run.p16aHost(), step);
		case 'convert':
			return executeConvert(run.p16aHost(), step);
		case 'empowerJace':
			return executeEmpowerJace(run.p16aHost(), step);
		case 'assimilate':
			return executeAssimilate(run.p16aHost(), step);
		case 'recruit':
			return executeRecruit(run.p16aHost(), step);
		case 'heal':
			return executeHeal(run.p16aHost(), step);
		// --- End Track P16a ---
		// --- Track P19a ---
		case 'redirectTargets':
			return executeP19aRedirectTargets(run.p19aHost(), step);
		case 'skipTurn':
			return executeP19aSkipTurn(run.p19aHost(), step);
		// --- Precon Bragos Spirit ---
		case 'skipCombatPhase':
			return executeSkipCombatPhase(run.p19aHost(), step);
		case 'castNameLock':
			return run.castNameLock(step);
		// --- End Precon Bragos Spirit ---
		case 'exileUntil':
			// --- Track P22d ---
			if (
				step.params?.exileUntilSpec?.hitAction === 'stayExiled' ||
				step.params?.exileUntilSpec?.actor
			) {
				return executeExileUntilWave8(run.p19aHost(), step);
			}
			// --- End Track P22d ---
			return executeP19aExileUntil(run.p19aHost(), step);
		case 'delayedTapManaTrigger':
			return executeP19aDelayedTapManaTrigger(run.p19aHost(), step);
		case 'delayedNextSpellCopy':
			return executeP19aDelayedNextSpellCopy(run.p19aHost(), step);
		// --- End Track P19a ---
		// --- Wave 10 ---
		case 'forEachPlayerLoop':
			return executeForEachPlayerLoopWave10(run, step);
		case 'punisherChoice':
			return executePunisherChoiceWave10(run, step);
		case 'partitionKeepByTypes':
			return executePartitionKeepByTypesWave10(run, step);
		case 'reselectAttackTarget':
			return executeReselectAttackTargetWave10(run, step);
		case 'endCombatPhase':
			return executeEndCombatPhaseWave10(run);
		// --- End Wave 10 ---
		// --- Wave 11 ---
		case 'solveCase':
			return executeSolveCaseStep(run, step);
		case 'repeatSequence':
			return executeRepeatSequenceStep(run, step);
		case 'conditionalSequence':
			return executeConditionalSequenceStep(run, step);
		// --- End Wave 11 ---
		default:
			// Not reachable: staticallyInterpretable rejects every other verb.
			p.addLog(s, 'rule', `${title}: the "${step.verb}" step isn't supported yet and did nothing.`, you.playerId);
	}
}

export function executeCastNameLockStep(run: EffectRunAccess, step: EffectStep): void {
	const ref = step.params?.castNameLockRef;
	if (!ref) return;
	const id = run.refId(ref);
	const found = id ? run.locate(id) : null;
	if (!found) return;
	const name =
		found.zone === 'battlefield'
			? evaluatePermanent(run.state, found.inst).effectiveName
			: resolveObjectFaces(found.inst.card, { zone: found.zone }).name || found.inst.card.name;
	if (!name?.trim()) return;
	for (const pl of run.players(step.subject)) {
		if (pl.lost) continue;
		(pl.castNameLocks ??= []).push({
			name,
			untilTurnStartOf: run.ctx.controller.playerId,
			sourceName: run.ctx.sourceCard.name
		});
		effectPorts().addLog(
			run.state,
			'rule',
			`${pl.username} can't cast spells named ${name} until ${run.ctx.controller.username}'s next turn.`,
			pl.playerId
		);
	}
}

export function executePreventDamageStep(run: EffectRunAccess, step: EffectStep): void {
	if (executePreventWave10(run, step, effectPorts().uid)) return;
	// --- Track P22d ---
	if (
		executePreventWave8(run.p19aHost(), step, {
			objects: (sel) => run.objects(sel),
			players: (sel) => run.players(sel),
			targetsForSpecIndex: (idx) => run.targetsForSpecIndex(idx),
			locate: (id) => run.locate(id) ?? undefined,
			matches: (inst, filter, zone) =>
				zone === 'command' || zone === 'stack' ? false : run.matches(inst, filter, zone),
			targetsBecomeEach: Boolean(
				run.ctx.targetsBecomeEach ?? run.ctx.item.spellMods?.targetsBecomeEach
			),
			uid: (prefix) => effectPorts().uid(prefix, run.state)
		})
	) {
		return;
	}
	// --- End Track P22d ---
	const s = run.state;
	const p = effectPorts();
	const you = run.you;
	const spec = step.params?.preventSpec;
	if (!spec) return;
	const remaining: number | 'infinite' =
		spec.mode === 'all' ? 'infinite' : Math.max(0, run.amount(step.amount, 1));
	if (remaining !== 'infinite' && remaining <= 0) return;

	let fromSourceInstanceId: string | undefined;
	let fromSourceObjectVersion: number | undefined;
	let fromSourceTypes: string[] | undefined;
	let fromAttackingOnly: boolean | undefined;

	if (spec.fromSource) {
		if (spec.fromSource.k === 'all') {
			if (spec.fromSource.filter.types?.length) {
				fromSourceTypes = [...spec.fromSource.filter.types];
			}
			if (spec.fromSource.filter.attacking) {
				fromAttackingOnly = true;
			}
		} else {
			const srcObj = run.objects(spec.fromSource)[0];
			if (!srcObj) return;
			fromSourceInstanceId = srcObj.instanceId;
			if (srcObj.zone === 'battlefield') {
				fromSourceObjectVersion = srcObj.objectVersion ?? 1;
			}
		}
	}

	const baseFields = {
		controllerId: you.playerId,
		sourceName: run.ctx.sourceCard.name || run.ctx.title,
		combatOnly: spec.combatOnly,
		remaining,
		...(fromSourceInstanceId !== undefined ? { fromSourceInstanceId } : {}),
		...(fromSourceObjectVersion !== undefined ? { fromSourceObjectVersion } : {}),
		...(fromSourceTypes ? { fromSourceTypes } : {}),
		...(fromAttackingOnly ? { fromAttackingOnly: true } : {})
	};

	if (spec.scope === 'any') {
		addDamagePreventionShield(s, {
			...baseFields,
			id: p.uid('pshield', s),
			targetKind: 'any'
		});
		return;
	}

	if (spec.scope === 'youAndCreaturesYouControl') {
		if (remaining === 'infinite') {
			addDamagePreventionShield(s, {
				...baseFields,
				id: p.uid('pshield', s),
				targetKind: 'playerAndPermanentsControlledBy',
				targetId: you.playerId,
				targetTypes: ['Creature']
			});
		} else {
			addDamagePreventionShield(s, {
				...baseFields,
				id: p.uid('pshield', s),
				targetKind: 'player',
				targetId: you.playerId
			});
			for (const perm of you.battlefield) {
				if (perm.phasedOut || !run.matches(perm, { types: ['Creature'] }, 'battlefield')) continue;
				addDamagePreventionShield(s, {
					...baseFields,
					id: p.uid('pshield', s),
					targetKind: 'permanent',
					targetId: perm.instanceId,
					targetObjectVersion: perm.objectVersion ?? 1
				});
			}
		}
		return;
	}

	const sel = step.subject;
	if (sel.k === 'target' && !(run.ctx.targetsBecomeEach ?? run.ctx.item.spellMods?.targetsBecomeEach)) {
		const refs = run.targetsForSpecIndex(sel.index);
		const boundPerms: CardInstance[] = [];
		for (const t of refs) {
			if (t.kind === 'player') {
				const pl = run.player(t.id);
				if (pl && !pl.lost) {
					addDamagePreventionShield(s, {
						...baseFields,
						id: p.uid('pshield', s),
						targetKind: 'player',
						targetId: pl.playerId
					});
				}
			} else if (t.kind === 'permanent') {
				const perm = run.locate(t.id)?.inst;
				if (perm && perm.zone === 'battlefield' && !perm.phasedOut) {
					boundPerms.push(perm);
					addDamagePreventionShield(s, {
						...baseFields,
						id: p.uid('pshield', s),
						targetKind: 'permanent',
						targetId: perm.instanceId,
						targetObjectVersion: perm.objectVersion ?? 1,
						...(spec.alsoPreventDealtBySubject ? { alsoPreventDealtByTarget: true } : {})
					});
				}
			}
		}
		run.bind(step, boundPerms);
		return;
	}

	if (sel.k === 'player' || sel.k === 'playerRef') {
		for (const pl of run.players(sel)) {
			addDamagePreventionShield(s, {
				...baseFields,
				id: p.uid('pshield', s),
				targetKind: 'player',
				targetId: pl.playerId
			});
		}
		return;
	}

	if (
		sel.k === 'all' &&
		remaining === 'infinite' &&
		!spec.alsoPreventDealtBySubject &&
		sel.filter.controller === 'you' &&
		Object.keys(sel.filter).every((k) => k === 'controller' || k === 'types' || k === 'zone')
	) {
		addDamagePreventionShield(s, {
			...baseFields,
			id: p.uid('pshield', s),
			targetKind: 'permanentsControlledBy',
			targetId: you.playerId,
			...(sel.filter.types?.length ? { targetTypes: [...sel.filter.types] } : {})
		});
		return;
	}

	const objs = run.objects(sel).filter((o) => {
		if (o.zone !== 'battlefield' || o.phasedOut) return false;
		if (
			sel.k === 'self' &&
			run.ctx.item.sourceObjectVersion !== undefined &&
			(o.objectVersion ?? 1) !== run.ctx.item.sourceObjectVersion
		) {
			return false;
		}
		return true;
	});
	run.bind(step, objs);
	for (const o of objs) {
		addDamagePreventionShield(s, {
			...baseFields,
			id: p.uid('pshield', s),
			targetKind: 'permanent',
			targetId: o.instanceId,
			targetObjectVersion: o.objectVersion ?? 1,
			...(spec.alsoPreventDealtBySubject ? { alsoPreventDealtByTarget: true } : {})
		});
	}
}

export function executeDiscardHandStep(run: EffectRunAccess, step: EffectStep): void {
	const s = run.state;
	const p = effectPorts();
	const you = run.you;
	const batchKey = `batch:${run.stepIndex}:discardHand`;
	const countsKey = `discardHandCounts:${run.stepIndex}`;

	if (!run.answers[countsKey]) {
		const actors = step.actor
			? run.players({ k: 'playerRef', ref: step.actor })
			: step.subject.k === 'none'
				? [you]
				: run.players(step.subject);
		const encodedCounts: string[] = [];
		const cardIds: string[] = [];
		const allCards: CardInstance[] = [];
		// --- Track P19a ---
		let maxHandDiscarded = 0;
		// --- End Track P19a ---
		for (const pl of actors) {
			// --- Track P19a ---
			if (pl.hand.length > maxHandDiscarded) maxHandDiscarded = pl.hand.length;
			// --- End Track P19a ---
			encodedCounts.push(`${pl.playerId}|${pl.hand.length}`);
			for (const c of pl.hand) {
				cardIds.push(c.instanceId);
				allCards.push(c);
			}
			p.addLog(
				s,
				'rule',
				`${pl.username} discarded their hand (${pl.hand.length} card(s)).`,
				pl.playerId
			);
		}
		// --- Track P19a ---
		run.recordCountedKind('greatestDiscarded', maxHandDiscarded);
		run.recordCountedKind('discardedThisWay', allCards.length);
		run.recordEffectAmount(allCards.length);
		// --- End Track P19a ---
		run.bind(step, allCards);
		run.answers[countsKey] = { kind: 'chooseObjects', objectIds: encodedCounts };
		run.answers[batchKey] = { kind: 'chooseObjects', objectIds: cardIds };
	}

	const { paused } = run.runIndexedBatch(
		batchKey,
		() => [],
		(id) => {
			const f = run.locate(id);
			if (!f || f.zone !== 'hand') return;
			return moveObject(s, f.inst, 'graveyard', {
				from: { player: f.holder, zone: 'hand' },
				toPlayer: f.holder,
				graveyardReplacement: true,
				bumpVersion: true,
				newTimestamp: true,
				discardReason: 'discard',
				discardPlayerId: f.holder.playerId
			});
		}
	);
	if (paused) return;

	const drawAfter = step.params?.drawAfterDiscardHand;
	if (drawAfter !== undefined) {
		const encoded =
			run.answers[countsKey]?.kind === 'chooseObjects' ? run.answers[countsKey].objectIds : [];
		for (const entry of encoded) {
			const [pid, rawCount] = entry.split('|');
			const pl = run.player(pid);
			if (!pl || pl.lost) continue;
			const prevCount = Number(rawCount) || 0;
			const drawN =
				drawAfter === 'thatMany' ? prevCount : Math.max(0, run.amount(drawAfter, 0));
			if (drawN > 0) {
				p.drawCards(s, pl, drawN);
				p.addLog(s, 'rule', `${pl.username} drew ${drawN} card(s).`, you.playerId);
			}
		}
	}
}
// --- End Track P7 ---

export function executeDamageStep(run: EffectRunAccess, step: EffectStep): void {
	if (executeDamageWithExcessToControllerWave10(run, step)) return;
	if (executeDamageWithOrPlaneswalkerWave10(run, step)) return;
	if (executeSoulfireEruptionWave10(run, step)) return;
	const s = run.state;
	const p = effectPorts();
	const you = run.you;
	const resolvedSrc = run.resolveDamageSource(step.params?.damageSource);
	if (!resolvedSrc) {
		// --- Track P7 ---
		run.bind(step, []);
		// --- End Track P7 ---
		return;
	}
	const n = run.amount(step.amount);
	if (n <= 0) {
		// --- Track P7 ---
		run.bind(step, []);
		// --- End Track P7 ---
		return;
	}
	const sel = step.subject;
	const { srcPerm, srcId, srcCard, srcController } = resolvedSrc;
	const srcInfo = run.sourceDamageInfo(srcPerm, srcCard);
	let totalDealt = 0;
	// --- Track P7 ---
	const damagedPerms: CardInstance[] = [];
	const isDivided = Boolean(step.params?.divided);
	// --- End Track P7 ---

	if (sel.k === 'target' && !(run.ctx.targetsBecomeEach ?? run.ctx.item.spellMods?.targetsBecomeEach)) {
		const targetRefs = run.targetsForSpecIndex(sel.index);
		for (let idx = 0; idx < targetRefs.length; idx++) {
			const t = targetRefs[idx];
			// --- Track P7 ---
			const amt = isDivided
				? getLockedTargetDivisionAmount(run.ctx.item, t.id, n, idx, targetRefs.length)
				: n;
			if (amt <= 0) continue;
			// --- End Track P7 ---
			if (t.kind === 'player') {
				const pl = run.player(t.id);
				if (pl) totalDealt += run.dealDamageToPlayer(pl, amt, srcId, srcInfo);
			} else if (t.kind === 'permanent') {
				const perm = run.locate(t.id)?.inst;
				if (perm && perm.zone === 'battlefield') {
					const permCtrl = run.player(perm.controllerId);
					const dealt = run.dealDamageToPermanent(perm, amt, srcId, srcInfo);
					totalDealt += dealt;
					// --- Track P7 ---
					if (dealt > 0) damagedPerms.push(perm);
					// --- End Track P7 ---
					// --- Track P19a (CR 120.10): Excess damage dealt to that permanent's controller ---
					if (
						step.params?.excessDamageToController &&
						(run.lastExcessDamage ?? 0) > 0 &&
						permCtrl &&
						!permCtrl.lost
					) {
						totalDealt += run.dealDamageToPlayer(
							permCtrl,
							run.lastExcessDamage!,
							srcId,
							srcInfo
						);
					}
					// --- End Track P19a ---
				}
			}
		}
		// --- Track P7 ---
		run.bind(step, damagedPerms);
		// --- End Track P7 ---
		// --- Track P13 ---
		run.recordEffectAmount(totalDealt);
		// --- End Track P13 ---
		run.recordCountedKind(
			'creaturesDealtDamageThisWay',
			damagedPerms.filter((c) => evaluatePermanent(s, c).isCreature).length
		);
		if (srcInfo.hasLifelink) run.applyLifelinkGain(srcController, totalDealt);
		return;
	}
	if (sel.k === 'player' || sel.k === 'playerRef') {
		for (const pl of run.players(sel)) {
			totalDealt += run.dealDamageToPlayer(pl, n, srcId, srcInfo);
		}
		// --- Track P7 ---
		run.bind(step, []);
		// --- End Track P7 ---
		// --- Track P13 ---
		run.recordEffectAmount(totalDealt);
		// --- End Track P13 ---
		if (srcInfo.hasLifelink) run.applyLifelinkGain(srcController, totalDealt);
		return;
	}
	const objs = run.objects(sel).filter((o) => o.zone === 'battlefield');
	for (const o of objs) {
		const dealt = run.dealDamageToPermanent(o, n, srcId, srcInfo);
		totalDealt += dealt;
		// --- Track P7 ---
		if (dealt > 0) damagedPerms.push(o);
		// --- End Track P7 ---
	}
	// --- Track P7 ---
	run.bind(step, damagedPerms);
	// --- End Track P7 ---
	const extraPlayers = step.params?.alsoDamagePlayers
		? run.players({ k: 'player', filter: step.params.alsoDamagePlayers })
		: [];
	for (const pl of extraPlayers) {
		totalDealt += run.dealDamageToPlayer(pl, n, srcId, srcInfo);
	}
	// --- Track P13 ---
	run.recordEffectAmount(totalDealt);
	// --- End Track P13 ---
	run.recordCountedKind(
		'creaturesDealtDamageThisWay',
		damagedPerms.filter((c) => evaluatePermanent(s, c).isCreature).length
	);
	if (srcInfo.hasLifelink) run.applyLifelinkGain(srcController, totalDealt);
	if (sel.k === 'all') {
		p.addLog(s, 'combat', `${run.ctx.title} dealt ${n} damage to ${objs.length} permanent(s)!`, you.playerId);
	}
}

function resolveSingleFighter(run: EffectRunAccess, sel: Selector): CardInstance | null {
	if (sel.k === 'target') {
		const active = run.activeTargetSpecs();
		if (
			!run.ctx.item?.targetsBySpec &&
			active.length > 1 &&
			run.ctx.targets.length < active.filter((entry) => entry.spec.min > 0).length
		) {
			return null;
		}
		const t = run.targetsForSpecIndex(sel.index)[0];
		if (!t || t.kind === 'player' || t.kind === 'stack') return null;
		const inst = run.locate(t.id)?.inst ?? null;
		return inst && !inst.phasedOut ? inst : null;
	}
	if (sel.k === 'self') {
		const inst = run.locate(run.ctx.sourceId)?.inst ?? null;
		if (!inst || inst.phasedOut) return null;
		if (
			run.ctx.item?.sourceObjectVersion !== undefined &&
			inst.objectVersion !== run.ctx.item.sourceObjectVersion
		) {
			return null;
		}
		return inst;
	}
	return run.objects(sel)[0] ?? null;
}

export function executeFightStep(run: EffectRunAccess, step: EffectStep): void {
	const s = run.state;
	const withSel = step.params?.with;
	let fighterA: CardInstance | null = null;
	let fighterB: CardInstance | null = null;
	if (withSel) {
		fighterA = resolveSingleFighter(run, step.subject);
		fighterB = resolveSingleFighter(run, withSel);
	} else if (step.subject.k === 'target' && run.ctx.targets.length >= 2) {
		fighterA = resolveSingleFighter(run, { k: 'target', index: 0 });
		fighterB = resolveSingleFighter(run, { k: 'target', index: 1 });
	}
	// CR 701.14b: If one or both creatures are no longer on the battlefield or no longer creatures,
	// neither of them deals or is dealt damage.
	if (!fighterA || !fighterB) return;
	if (fighterA.zone !== 'battlefield' || fighterB.zone !== 'battlefield') return;
	if (fighterA.phasedOut || fighterB.phasedOut) return;
	const evA = evaluatePermanent(s, fighterA);
	const evB = evaluatePermanent(s, fighterB);
	if (!evA.isCreature || !evB.isCreature) return;

	const powerA = Math.max(0, evA.breakdown.effectivePower ?? 0);
	const powerB = Math.max(0, evB.breakdown.effectivePower ?? 0);
	const infoA = run.sourceDamageInfo(fighterA, fighterA.copiableCard ?? fighterA.card);
	const infoB = run.sourceDamageInfo(fighterB, fighterB.copiableCard ?? fighterB.card);
	const ctrlA = run.player(fighterA.controllerId) ?? run.you;
	const ctrlB = run.player(fighterB.controllerId) ?? run.you;

	// CR 701.14c: If a creature fights itself, it deals damage to itself equal to twice its power.
	if (fighterA.instanceId === fighterB.instanceId) {
		const dealt = run.dealDamageToPermanent(fighterA, powerA * 2, fighterA.instanceId, infoA);
		if (infoA.hasLifelink) run.applyLifelinkGain(ctrlA, dealt);
		return;
	}

	// Simultaneous fight damage (power and source keywords snapshotted before either deals damage)
	const lethalBeforeB = computeLethalThresholdBefore(s, fighterB, infoA.hasDeathtouch);
	const dealtByA = run.dealDamageToPermanent(fighterB, powerA, fighterA.instanceId, infoA);
	const dealtByB = run.dealDamageToPermanent(fighterA, powerB, fighterB.instanceId, infoB);
	if (infoA.hasLifelink) run.applyLifelinkGain(ctrlA, dealtByA);
	if (infoB.hasLifelink) run.applyLifelinkGain(ctrlB, dealtByB);
	recordFightExcessManaWave10(run, step, fighterB, lethalBeforeB, dealtByA);
}

export function executeDelayedStep(run: EffectRunAccess, step: EffectStep): void {
	if (step.params?.registerWave9DelayedTrigger && registerWave9DelayedTriggerStep(run, step)) {
		return;
	}
	const s = run.state;
	const p = effectPorts();
	const d = step.delayed!;
	const e = d.effect[0];
	const thatTurn = d.trigger.scope === 'controller_turn';
	const phase = d.trigger.filter.phase ?? 'end_step';
	const waitAfter = thatTurn ? s.turnNumber : undefined;
	const base = {
		controllerId: run.you.playerId,
		sourceInstanceId: run.ctx.sourceId,
		sourceCard: run.ctx.sourceCard,
		triggerPhase: phase,
		createdAtTurn: s.turnNumber,
		// "That turn's end step" (after an extra turn): the controller's next turn, not this one.
		targetPlayerId: thatTurn ? run.you.playerId : undefined,
		waitUntilAfterTurn: waitAfter,
		// "The next turn's upkeep": not this turn's (turnNumber counts rounds, so name the turn).
		...(d.nextTurn ? { notDuringTurn: `${s.turnNumber}:${s.activePlayerIndex}` } : {})
	};
	if (!s.delayedTriggers) s.delayedTriggers = [];
	const singlePlain = d.effect.length === 1 && !e?.condition && !e?.optional;
	if (singlePlain && phase === 'end_step' && e.verb === 'exile' && e.subject.k === 'binding') {
		for (const b of run.bindings.get(e.subject.name) ?? []) {
			const found = run.locate(b.id);
			const label = found ? found.inst.card.name : 'it';
			const dt: DelayedTrigger = {
				id: p.uid('dtrig', s),
				...base,
				targetInstanceId: b.id,
				title: `${run.ctx.title} — Delayed Exile Trigger`,
				description: `At the beginning of the next end step, exile ${label}.`,
				// CR 400.7: "it" is the object as it is now; if it changes zones again it's a new object.
				delayedEffect: {
					kind: 'exile',
					targetInstanceId: b.id,
					...(found?.zone === 'battlefield' ? { targetObjectVersion: found.inst.objectVersion } : {})
				}
			};
			s.delayedTriggers.push(dt);
		}
		return;
	}
	if (
		singlePlain &&
		phase === 'end_step' &&
		e.verb === 'lose' &&
		e.subject.k === 'player' &&
		e.subject.filter.relation === 'you'
	) {
		s.delayedTriggers.push({
			id: p.uid('dtrig', s),
			...base,
			title: `${run.ctx.title} — Delayed End Step Trigger`,
			description: 'At the beginning of the end step, you lose the game.',
			delayedEffect: { kind: 'lose' }
		});
		return;
	}
	if (d.effect.length === 1 && phase === 'upkeep' && e.verb === 'draw' && !e.condition) {
		const amount = Math.max(0, run.amount(e.amount, 1));
		const upTo = Boolean(e.params?.upTo);
		for (const pl of run.players(e.subject)) {
			s.delayedTriggers.push({
				id: p.uid('dtrig', s),
				...base,
				title: `${run.ctx.title} — Delayed Upkeep Trigger`,
				description: `At the beginning of the next turn's upkeep, ${pl.username} draws ${upTo ? `up to ${amount}` : amount} card(s).`,
				delayedEffect: { kind: 'draw', playerId: pl.playerId, amount, upTo }
			});
		}
		return;
	}

	// CR 603.7: General IR-safe delayed trigger — store only a plain-JSON ability locator and
	// versioned binding/target snapshots, never EffectStep[].
	const item = run.ctx.item;
	const existingLocator =
		item.delayedEffect?.kind === 'compiledDelayed' ? item.delayedEffect : item.reflexiveTrigger;
	const boundRefs: SerializedBoundRef[] = [];
	for (const [key, list] of run.bindings.entries()) {
		for (const b of list) {
			const found = run.locate(b.id);
			if (!found) continue;
			boundRefs.push({
				key,
				id: b.id,
				expectedZone: found.zone,
				objectVersion: found.inst.objectVersion ?? 1,
				lki: { ...b.lki }
			});
		}
	}
	const targetObjectVersions: Record<string, number> = {};
	for (const t of run.ctx.targets) {
		if (t.kind === 'player' || t.kind === 'stack') continue;
		const found = run.locate(t.id);
		if (found) targetObjectVersions[t.id] = found.inst.objectVersion ?? 1;
		else if (item.targetObjectVersions?.[t.id] !== undefined) {
			targetObjectVersions[t.id] = item.targetObjectVersions[t.id];
		}
	}
	const abilityKind: CompiledDelayedEffect['abilityKind'] = existingLocator
		? existingLocator.abilityKind
		: item.kind === 'spell'
			? 'spell'
			: item.kind === 'activated'
				? 'activated'
				: 'triggered';
	const compiledDelayed: CompiledDelayedEffect = {
		kind: 'compiledDelayed',
		sourceCard: existingLocator ? existingLocator.sourceCard : run.ctx.sourceCard,
		...(existingLocator?.faceIndex !== undefined
			? { faceIndex: existingLocator.faceIndex }
			: item.faceIndex !== undefined
				? { faceIndex: item.faceIndex }
				: {}),
		...(existingLocator?.fused ?? item.fused ? { fused: true } : {}),
		abilityKind,
		...(existingLocator?.abilityId ?? item.abilityId
			? { abilityId: existingLocator?.abilityId ?? item.abilityId }
			: {}),
		...(existingLocator?.abilityIndex !== undefined
			? { abilityIndex: existingLocator.abilityIndex }
			: item.triggeredAbilityIndex !== undefined
				? { abilityIndex: item.triggeredAbilityIndex }
				: {}),
		...(existingLocator?.grantSourceCard ?? item.grantSourceCard
			? { grantSourceCard: existingLocator?.grantSourceCard ?? item.grantSourceCard }
			: {}),
		...((existingLocator?.grantFaceIndex ?? item.grantFaceIndex) !== undefined
			? { grantFaceIndex: existingLocator?.grantFaceIndex ?? item.grantFaceIndex }
			: {}),
		...((existingLocator?.grantAbilityIndex ?? item.grantAbilityIndex) !== undefined
			? { grantAbilityIndex: existingLocator?.grantAbilityIndex ?? item.grantAbilityIndex }
			: {}),
		...(existingLocator?.grantedKeyword ?? item.grantedKeyword
			? { grantedKeyword: existingLocator?.grantedKeyword ?? item.grantedKeyword }
			: {}),
		...(existingLocator?.grantedAbilityText ?? item.grantedAbilityText
			? { grantedAbilityText: existingLocator?.grantedAbilityText ?? item.grantedAbilityText }
			: {}),
		...(existingLocator?.chosenModes ?? item.chosenModes
			? { chosenModes: [...(existingLocator?.chosenModes ?? item.chosenModes)!] }
			: {}),
		stepPath: [...(run.ctx.stepPathPrefix ?? []), run.stepIndex],
		boundRefs,
		targets: run.ctx.targets.map((t) => ({ ...t })),
		...(Object.keys(targetObjectVersions).length > 0 ? { targetObjectVersions } : {}),
		...(run.ctx.eventObjectId ? { eventObjectId: run.ctx.eventObjectId } : {}),
		...(run.ctx.eventObjectVersion !== undefined
			? { eventObjectVersion: run.ctx.eventObjectVersion }
			: {}),
		...(run.ctx.eventPlayerId ? { eventPlayerId: run.ctx.eventPlayerId } : {}),
		...(run.ctx.defendingPlayerId ? { defendingPlayerId: run.ctx.defendingPlayerId } : {}),
		...(run.ctx.eventLki ? { eventLki: { ...run.ctx.eventLki } } : {}),
		...(run.ctx.xValue ? { xValue: run.ctx.xValue } : {}),
		...(item.sourceKickedCount !== undefined ? { kickedCount: item.sourceKickedCount } : {}),
		...(item.sourceKickedTags?.length ? { kickedTags: [...item.sourceKickedTags] } : {}),
		...(item.sourceKickedTagCounts ? { kickedTagCounts: { ...item.sourceKickedTagCounts } } : {})
	};
	const phaseTitle =
		phase === 'end_combat'
			? 'Delayed End of Combat Trigger'
			: phase === 'upkeep'
				? 'Delayed Upkeep Trigger'
				: 'Delayed End Step Trigger';
	const phaseDesc =
		phase === 'end_combat'
			? 'At end of combat, resolve delayed trigger.'
			: phase === 'upkeep'
				? "At the beginning of the next turn's upkeep, resolve delayed trigger."
				: 'At the beginning of the next end step, resolve delayed trigger.';
	s.delayedTriggers.push({
		id: p.uid('dtrig', s),
		...base,
		title: `${run.ctx.title} — ${phaseTitle}`,
		description: phaseDesc,
		delayedEffect: compiledDelayed
	});
}
