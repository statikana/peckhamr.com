/**
 * Effect interpreter amount, selector, filter, and condition evaluators.
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
import { effectiveCardForObject, getCardFaces } from '../scryfall.ts';
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
	playerCommanderCastCount,
	splitTypeLine
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
// --- Wave 10 ---
import { hasWave10ObjectFilterFields, matchesObjectFilterWave10 } from './combatWave10.ts';
import {
	evaluateWave10Amount,
	evaluateWave10Condition,
	resolveWave10PlayerRef
} from './effectsWave10.ts';
// --- End Wave 10 ---
// --- Wave 11 ---
import { evaluateWave11ObjectFilter, evaluateWave11PlayerRef } from './effectsWave11.ts';
import { evaluateWave11Amount, evaluateWave11Condition } from './manaCountersWave11.ts';
// --- End Wave 11 ---

import {
	compare,
	effectPorts,
	targetRefMatchesSpec,
	type EffectRunAccess,
	type Snapshot
} from './effectsDamageAndMana.ts';

export function evaluateEffectAmount(run: EffectRunAccess, a: Amount | undefined, fallback = 0): number {
	if (!a) return fallback;
	switch (a.k) {
		case 'const':
			return a.n;
		case 'x':
			return run.ctx.xValue;
		case 'negate':
			return -run.amount(a.of);
		case 'sum':
			return a.args.reduce((s, x) => s + run.amount(x), 0);
		case 'min':
			return Math.min(...a.args.map((x) => run.amount(x)));
		case 'max':
			return Math.max(...a.args.map((x) => run.amount(x)));
		case 'count':
			return run.objects({ k: 'all', filter: a.of }).length;
		case 'resultCount':
			return run.bindings.get(a.of)?.length ?? 0;
		case 'eventAmount':
			return run.ctx.eventAmount ?? 0;
		case 'life': {
			const p = run.playerRef(a.of);
			return p ? p.life : 0;
		}
		case 'energyCount': {
			const p = run.playerRef(a.player);
			return p ? (p.energyCounters ?? 0) : 0;
		}
		case 'cardsIn': {
			const p = run.playerRef(a.of);
			return p ? p[a.zone === 'stack' ? 'hand' : (a.zone as 'hand')].length : 0;
		}
		case 'devotion': {
			// --- Track P13 + Track P14 ---
			if (a.player) {
				const p = run.playerRef(a.player);
				return p ? computeDevotionToColors(run.state, p.playerId, a.colors) : 0;
			}
			return computeDevotionTo(run.state, run.you.playerId, a.colors);
			// --- End Track P13 + Track P14 ---
		}
		case 'commanderCastCount':
			return playerCommanderCastCount(run.state, run.you.playerId);
		case 'stormCount':
			return run.ctx.item.stormCount ?? 0;
		case 'colorsOfManaSpentToCast':
			return run.sourcePerm?.manaColorsSpent?.length ?? run.ctx.item.manaColorsSpent?.length ?? 0;
		case 'kickedCount':
			return evaluateKickedCountAmount(a, run.kickerInfo());
		case 'tappedCostPower': {
			const tappedId = run.ctx.item.stationTappedId;
			if (tappedId) {
				const found = run.locate(tappedId);
				if (
					found &&
					found.zone === 'battlefield' &&
					!found.inst.phasedOut &&
					(run.ctx.item.stationTappedVersion === undefined ||
						(found.inst.objectVersion ?? 1) === run.ctx.item.stationTappedVersion)
				) {
					return Math.max(0, effectPorts().power(run.state, found.inst));
				}
			}
			return Math.max(0, run.ctx.item.tappedCostPower ?? 0);
		}
		case 'countersOn': {
			const id = run.refId(a.of);
			const found = id ? run.locate(id) : null;
			if (!found || found.zone !== 'battlefield' || found.inst.phasedOut) return 0;
			if (
				a.of.k === 'self' &&
				run.ctx.item.sourceObjectVersion !== undefined &&
				(found.inst.objectVersion ?? 1) !== run.ctx.item.sourceObjectVersion
			) {
				return 0;
			}
			// --- Track P8 ---
			if (a.counter === 'any') {
				return Object.values(found.inst.counters).reduce((acc, n) => acc + (n > 0 ? n : 0), 0);
			}
			return found.inst.counters[a.counter] ?? 0;
		}
		case 'stat': {
			const snap = run.refSnapshot(a.of, Boolean(a.lki));
			if (!snap) return 0;
			return a.stat === 'power' ? snap.power : a.stat === 'toughness' ? snap.toughness : snap.manaValue;
		}
		// --- Track P8 ---
		case 'distinctCardTypesInZone':
			return countDistinctCardTypesInZone(run.state, run.you.playerId, a.zone, a.whose);
		// --- Track P9 ---
		case 'lkiCounterCount':
			return run.ctx.eventLki?.counters?.[a.counter] ?? 0;
		// --- Track P10 ---
		case 'lastRollResult':
			return run.lastRollResult ?? run.ctx.item.lastRollResult ?? 0;
		// --- End Track P10 ---
		// --- Track P12 ---
		case 'devouredCount':
			return run.ctx.item?.sourceDevouredCount ?? run.sourcePerm?.devouredCount ?? 0;
		case 'opponentCount':
			return run.state.players.filter((p) => !p.lost && p.playerId !== run.you.playerId).length;
		// --- End Track P12 ---
		// --- Track P11 ---
		case 'mul':
			return a.factor * run.amount(a.of);
		case 'domain': {
			const p = run.playerRef(a.player);
			return p ? computeDomainCount(run.state, p.playerId) : 0;
		}
		case 'partyCount': {
			const p = run.playerRef(a.player);
			return p ? computePartyCount(run.state, p.playerId) : 0;
		}
		case 'attachmentsOn': {
			const src = run.sourcePerm ?? undefined;
			const hostId =
				a.target === 'self'
					? (src?.instanceId ?? run.ctx.sourceId)
					: src?.attachedToId;
			return computeAttachmentsOnCount(
				run.state,
				hostId,
				a.filter,
				run.you.playerId,
				src
			);
		}
		// --- End Track P11 ---
		// --- Track P13 ---
		case 'unlockedDoorsCount': {
			const p = run.playerRef(a.player);
			return p ? computeUnlockedDoorsCount(run.state, p.playerId) : 0;
		}
		case 'excessDamage':
			return run.lastExcessDamage ?? run.ctx.item.lastExcessDamage ?? 0;
		case 'lastEffectAmount':
			return run.lastEffectAmount ?? run.ctx.item.lastEffectAmount ?? 0;
		case 'colorsAmongPermanents': {
			const p = run.playerRef(a.player);
			const pid = p ? p.playerId : run.you.playerId;
			return computeColorsAmongPermanents(run.state, pid, a.filter, (inst, f) =>
				run.matches(inst, f, 'battlefield')
			);
		}
		case 'half': {
			const v = run.amount(a.of);
			return a.round === 'up' ? Math.ceil(v / 2) : Math.floor(v / 2);
		}
		case 'dungeonsCompleted': {
			const p = run.playerRef(a.player);
			return p ? (p.dungeonsCompletedCount ?? 0) : 0;
		}
		case 'greatestStatAmong': {
			// --- Track P19a ---
			if (Array.isArray(a.filter.zone)) {
				const srcFound = run.locate(run.ctx.sourceId);
				return computeP19aMultiZoneStatAggregate(run.state, a.filter, a.stat, 'greatest', {
					state: run.state,
					controllerId: run.you.playerId,
					source: srcFound?.inst,
					stackItem: run.ctx.item,
					xValue: run.ctx.xValue
				});
			}
			// --- End Track P19a ---
			const z = (Array.isArray(a.filter.zone) ? a.filter.zone[0] : (a.filter.zone ?? 'battlefield')) as
				| 'battlefield'
				| 'graveyard'
				| 'hand'
				| 'library'
				| 'exile';
			return computeStatAggregateAmong(run.state, a.filter, a.stat, 'greatest', (inst, f) =>
				run.matches(inst, f, z)
			);
		}
		case 'totalStatAmong': {
			// --- Track P19a ---
			if (Array.isArray(a.filter.zone) || (a.filter.zone && a.filter.zone !== 'battlefield')) {
				const srcFound = run.locate(run.ctx.sourceId);
				return computeP19aMultiZoneStatAggregate(run.state, a.filter, a.stat, 'total', {
					state: run.state,
					controllerId: run.you.playerId,
					source: srcFound?.inst,
					stackItem: run.ctx.item,
					xValue: run.ctx.xValue
				});
			}
			// --- End Track P19a ---
			const z = (Array.isArray(a.filter.zone) ? a.filter.zone[0] : (a.filter.zone ?? 'battlefield')) as
				| 'battlefield'
				| 'graveyard'
				| 'hand'
				| 'library'
				| 'exile';
			return computeStatAggregateAmong(run.state, a.filter, a.stat, 'total', (inst, f) =>
				run.matches(inst, f, z)
			);
		}
		// --- End Track P13 ---
		// --- Track P14 ---
		case 'targetsBeyondFirst':
		case 'colorsOfObject':
		case 'totalStatOf':
		case 'anyNumber': {
			const srcFound = run.locate(run.ctx.sourceId);
			return (
				evaluateWave5Amount(a, {
					state: run.state,
					controllerId: run.you.playerId,
					source: srcFound?.inst,
					stackItem: run.ctx.item,
					xValue: run.ctx.xValue
				}) ?? 0
			);
		}
		// --- End Track P14 ---
		// --- Track P15 ---
		case 'playerSpeed':
		case 'gravestormCount':
			return (
				evaluateP15Amount(a, run.state, run.you.playerId, {
					resolvePlayer: (r) => run.playerRef(r) ?? undefined,
					gravestormOverride: run.ctx.item.gravestormCount
				}) ?? fallback
			);
		// --- End Track P15 ---
		// --- Track P17b ---
		case 'p17bMetric': {
			const srcFound = run.locate(run.ctx.sourceId);
			return evaluateP17bAmount(
				a,
				{
					state: run.state,
					controllerId: run.you.playerId,
					source: srcFound?.inst,
					stackItem: run.ctx.item,
					xValue: run.ctx.xValue
				},
				matchesObjectFilter
			);
		}
		// --- End Track P17b ---
		// --- Track P16a ---
		case 'countersRemovedThisWay':
			return (
				run.lastCountersRemoved ??
				run.ctx.item.lastCountersRemoved ??
				run.ctx.item.removedCounterCount ??
				0
			);
		case 'playerCounters': {
			const p = run.playerRef(a.player);
			return getPlayerCounterCount(p, a.counter);
		}
		// --- End Track P16a ---
		// --- Track P20a ---
		case 'manaSpentToCast':
		case 'opponentsWithLifeLessThanHalfStarting':
		case 'chosenPlayerZoneCount':
		// --- End Track P20a ---
		// --- Track P22a ---
		case 'distinctNamesCount':
		case 'creaturesDiedThisTurn':
		case 'spellsCastThisTurnCount': {
		// --- End Track P22a ---
			const srcFound = run.locate(run.ctx.sourceId);
			return evaluateAmount(a, {
				state: run.state,
				controllerId: run.you.playerId,
				source: srcFound?.inst ?? {
					...(run.ctx.item as unknown as CardInstance),
					manaSpentCount:
						run.ctx.item.manaColorsSpent?.length ?? 0
				},
				xValue: run.ctx.xValue
			});
		}
		// --- Track P22c ---
		case 'conditional':
			return run.condition(a.condition) ? run.amount(a.then) : run.amount(a.else);
		// --- End Track P22c ---
		// --- Track P19a ---
		case 'countedThisWay':
			if (a.kind === 'destroyedControlledByPlayerThisWay') {
				return evaluateWave10Amount(run, a) ?? 0;
			}
			return run.lastCountedByKind?.[a.kind] ?? run.ctx.item.lastCountedByKind?.[a.kind] ?? 0;
		case 'difference':
			return Math.max(0, run.amount(a.left) - run.amount(a.right));
		case 'sacrificedCostStat':
		case 'leastStatAmong': {
			const srcFound = run.locate(run.ctx.sourceId);
			return (
				evaluateP19aAmount(
					a,
					{
						state: run.state,
						controllerId: run.you.playerId,
						source: srcFound?.inst,
						stackItem: run.ctx.item,
						xValue: run.ctx.xValue
					},
					(sub) => run.amount(sub)
				) ?? 0
			);
		}
		// --- End Track P19a ---
		// --- Wave 10 ---
		case 'opponentsControllingMoreCount':
		case 'opponentsWithHandMaxCount':
		case 'opponentsDealtCombatDamageBySelfOrSubtypeThisTurn':
		case 'attackingCountToPlayer':
		case 'fractionalLifeLoss':
		case 'totalManaValueOfTargetSpec':
			return evaluateWave10Amount(run, a) ?? fallback;
		// --- End Wave 10 ---
		default: {
			const w11Amt = evaluateWave11Amount(run, a);
			if (w11Amt !== null) return w11Amt;
			const srcFound = run.locate(run.ctx.sourceId);
			return evaluateAmount(a, {
				state: run.state,
				controllerId: run.you.playerId,
				source: srcFound?.inst,
				stackItem: run.ctx.item,
				xValue: run.ctx.xValue
			});
		}
	}
}

export function runRefSnapshot(run: EffectRunAccess, ref: Ref, lki: boolean): Snapshot | null {
	if (ref.k === 'binding') {
		const b = run.bindings.get(ref.name)?.[0];
		if (!b) return null;
		if (lki) return b.lki;
		const now = run.locate(b.id);
		return now ? run.snapshot(now.inst) : b.lki;
	}
	const id = run.refId(ref);
	const found = id ? run.locate(id) : null;
	if (ref.k === 'eventObject') {
		// CR 608.2h / 400.7: the event object as it is now if it's still the same object on the
		// battlefield; otherwise (it died, or a "dies" trigger) as it last existed there.
		const same =
			found &&
			found.zone === 'battlefield' &&
			(run.ctx.eventObjectVersion === undefined || found.inst.objectVersion === run.ctx.eventObjectVersion);
		if (same) return run.snapshot(found.inst);
		if (run.ctx.eventLki) return { ...run.ctx.eventLki };
		if (found) return run.snapshot(found.inst);
		// CR 603.2 / 701.47 / 701.53: for 'cast' triggers ("Whenever you cast a noncreature spell,
		// amass Orcs X, where X is that spell's mana value"), fall back to the triggering stack item.
		const trigSpell =
			run.ctx.item?.triggerEventStackItem ??
			(id
				? run.state.stack.find(
						(st) => st.id !== run.ctx.item?.id && (st.id === id || st.sourceInstanceId === id)
					)
				: undefined);
		if (trigSpell) {
			return {
				controllerId: trigSpell.controllerId,
				ownerId: trigSpell.ownerId ?? trigSpell.controllerId,
				power: 0,
				toughness: 0,
				manaValue: objectManaValue(run.state, trigSpell)
			};
		}
		return null;
	}
	if (ref.k === 'self') {
		const expectedVer = run.ctx.item?.sourceObjectVersion;
		const stillOnBattlefield =
			found &&
			found.zone === 'battlefield' &&
			(expectedVer === undefined || found.inst.objectVersion === expectedVer);
		if (stillOnBattlefield) {
			return run.snapshot(found.inst);
		}
		const lkiPower =
			run.ctx.item?.sourceLkiPower ??
			found?.inst.lastKnownPower ??
			run.ctx.item?.lkiPower ??
			(parseInt(run.ctx.sourceCard.power ?? '0', 10) || 0);
		const lkiToughness =
			run.ctx.item?.sourceLkiToughness ??
			found?.inst.lastKnownToughness ??
			run.ctx.item?.lkiToughness ??
			(parseInt(run.ctx.sourceCard.toughness ?? '0', 10) || 0);
		return {
			controllerId: run.ctx.controller.playerId,
			ownerId: found?.inst.ownerId ?? run.ctx.controller.playerId,
			power: lkiPower,
			toughness: lkiToughness,
			manaValue: found
				? objectManaValue(run.state, found.inst)
				: run.ctx.item
					? objectManaValue(run.state, run.ctx.item)
					: run.ctx.sourceCard.cmc
		};
	}
	if (found) return run.snapshot(found.inst);
	if (id) {
		const stackTarget = run.state.stack.find((x) => x.id === id || x.sourceInstanceId === id);
		if (stackTarget) {
			return {
				controllerId: stackTarget.controllerId,
				ownerId: stackTarget.ownerId ?? stackTarget.controllerId,
				power: 0,
				toughness: 0,
				manaValue: objectManaValue(run.state, stackTarget)
			};
		}
		for (const [_, bList] of run.bindings) {
			const b = bList.find((x) => x.id === id);
			if (b) return { ...b.lki };
		}
		const initSnap = run.initialSnapshots.get(id);
		if (initSnap) return { ...initSnap };
	}
	return null;
}

export function runKickerInfo(run: EffectRunAccess): KickerTrackingInfo {
	return getObjectKickerInfo(run.state, run.ctx.item.card, run.ctx.sourceId, run.ctx.item);
}

export function runActiveTargetSpecs(run: EffectRunAccess): Array<{ spec: TargetSpec; specIndex: number }> {
	const out: Array<{ spec: TargetSpec; specIndex: number }> = [];
	for (let i = 0; i < run.ctx.targetSpecs.length; i++) {
		const spec = run.ctx.targetSpecs[i];
		if (!spec.condition || run.condition(spec.condition)) {
			out.push({ spec, specIndex: i });
		}
	}
	return out;
}

export function runTargetsForSpecIndex(run: EffectRunAccess, specIndex: number): TargetRef[] {
	if (run.ctx.item?.targetsBySpec && specIndex < run.ctx.item.targetsBySpec.length) {
		return run.ctx.item.targetsBySpec[specIndex] ?? [];
	}
	if (run.ctx.targetSpecs.length === 0) {
		return specIndex === 0 ? run.ctx.targets : [];
	}
	const active = run.activeTargetSpecs();
	const pos = active.findIndex((entry) => entry.specIndex === specIndex);
	if (pos < 0) return [];
	if (active.length <= 1) return run.ctx.targets;
	if (run.ctx.targets.length === active.length) {
		const ref = run.ctx.targets[pos];
		return ref ? [ref] : [];
	}
	const spec = active[pos].spec;
	return run.ctx.targets.filter((t) => targetRefMatchesSpec(t, spec));
}

export function runRefId(run: EffectRunAccess, ref: Ref): string | null {
	switch (ref.k) {
		case 'self':
			return run.ctx.sourceId;
		case 'target':
			return run.targetsForSpecIndex(ref.index)[0]?.id ?? null;
		case 'binding':
			return run.bindings.get(ref.name)?.[0]?.id ?? null;
		case 'eventObject':
			return run.ctx.eventObjectId ?? null;
		case 'attachedTo': {
			const src = run.locate(run.ctx.sourceId)?.inst;
			return src && src.zone === 'battlefield' && !src.phasedOut ? (src.attachedToId ?? null) : null;
		}
		case 'affected':
			return null;
		// --- Precon Bragos Spirit: CR 607.2a the card exiled with this object ---
		case 'linkedExile': {
			const linked = (x: CardInstance): boolean => {
				if (run.matches(x, { zone: 'exile', exiledWithSelf: true }, 'exile')) return true;
				// A leaves-the-battlefield ability looks back at the permanent as it last existed on the
				// battlefield (CR 603.10a): the source has since become a new object (one version later).
				if (!x.exiledBy || x.exiledBy.sourceInstanceId !== run.ctx.sourceId) return false;
				const src = run.locate(run.ctx.sourceId);
				if (src?.zone === 'battlefield') return false;
				const nowVer = run.ctx.item.sourceObjectVersion ?? src?.inst.objectVersion ?? 1;
				return x.exiledBy.sourceObjectVersion === nowVer - 1;
			};
			for (const pl of run.state.players) {
				const c = pl.exile.find(linked);
				if (c) return c.instanceId;
			}
			return null;
		}
		// --- End Precon Bragos Spirit ---
	}
}

export function runPlayerRef(run: EffectRunAccess, ref: PlayerRef): PlayerGameState | null {
	switch (ref.k) {
		case 'you':
			return run.you;
		case 'activePlayer':
			return run.state.players[run.state.activePlayerIndex] ?? null;
		case 'eventPlayer':
			return run.ctx.eventPlayerId ? (run.player(run.ctx.eventPlayerId) ?? null) : null;
		case 'defendingPlayer': {
			const pl = run.ctx.defendingPlayerId ? (run.player(run.ctx.defendingPlayerId) ?? null) : null;
			return pl && !pl.lost ? pl : null;
		}
		case 'target': {
			const t = run.targetsForSpecIndex(ref.index)[0];
			return t?.kind === 'player' ? (run.player(t.id) ?? null) : null;
		}
		case 'controllerOf':
		case 'ownerOf': {
			const snap = run.refSnapshot(ref.of, true);
			if (!snap) return null;
			return run.player(ref.k === 'controllerOf' ? snap.controllerId : snap.ownerId) ?? null;
		}
		// --- Wave 10 ---
		case 'chosenOpponent':
		case 'eachLoopPlayer':
			return resolveWave10PlayerRef(run, ref.k);
		// --- End Wave 10 ---
		// --- Wave 11 ---
		case 'playerToYourRight':
		case 'controllerOrControllerOfPlaneswalker':
			return evaluateWave11PlayerRef(run, ref);
		// --- End Wave 11 ---
	}
}

// ---- Selectors

/** CR 101.4: Active Player, Non-Active Player (APNAP) turn order starting from `state.activePlayerIndex`. */
export function runApnapPlayers(run: EffectRunAccess): PlayerGameState[] {
	const n = run.state.players.length;
	if (n === 0) return [];
	const start = (((run.state.activePlayerIndex ?? 0) % n) + n) % n;
	const out: PlayerGameState[] = [];
	for (let i = 0; i < n; i++) {
		const pl = run.state.players[(start + i) % n];
		if (pl && !pl.lost) out.push(pl);
	}
	return out;
}

export function runPlayers(run: EffectRunAccess, sel: Selector): PlayerGameState[] {
	if (sel.k === 'playerRef') {
		const p = run.playerRef(sel.ref);
		return p && !p.lost ? [p] : [];
	}
	if (sel.k === 'target') {
		const refs = run.targetsForSpecIndex(sel.index);
		return refs
			.filter((t): t is TargetRef => Boolean(t && t.kind === 'player'))
			.map((t) => run.player(t.id))
			.filter((p): p is PlayerGameState => Boolean(p && !p.lost));
	}
	if (sel.k !== 'player') return [];
	switch (sel.filter.relation) {
		case 'you':
			return [run.you];
		case 'each_opponent':
		case 'opponent':
			return run.apnapPlayers().filter((p) => p.playerId !== run.you.playerId);
		case 'each_player':
		case 'any':
			return run.apnapPlayers();
		case 'target':
			return run.players({ k: 'target', index: 0 });
	}
}

/** Objects a selector refers to, in their current zones. */
export function runObjects(run: EffectRunAccess, sel: Selector): CardInstance[] {
	switch (sel.k) {
		case 'self': {
			const f = run.locate(run.ctx.sourceId);
			return f ? [f.inst] : [];
		}
		case 'binding':
			return (run.bindings.get(sel.name) ?? [])
				.map((b) => run.locate(b.id)?.inst)
				.filter((c): c is CardInstance => Boolean(c && !(c.zone === 'battlefield' && c.phasedOut)));
		case 'target': {
			if (run.ctx.targetsBecomeEach ?? run.ctx.item.spellMods?.targetsBecomeEach) {
				const spec = run.ctx.targetSpecs[sel.index];
				if (spec?.condition && !run.condition(spec.condition)) return [];
				return spec ? run.objects({ k: 'all', filter: spec.filter }) : [];
			}
			const refs = run.targetsForSpecIndex(sel.index);
			return refs
				.filter((t) => t.kind !== 'player' && t.kind !== 'stack')
				.map((t) => run.locate(t.id)?.inst)
				.filter((c): c is CardInstance => Boolean(c && !c.phasedOut));
		}
		case 'eventObject': {
			// CR 400.7: once the event object changes zones again it's a new object.
			const f = run.ctx.eventObjectId ? run.locate(run.ctx.eventObjectId) : null;
			if (!f || f.inst.phasedOut) return [];
			if (run.ctx.eventObjectVersion !== undefined && f.inst.objectVersion !== run.ctx.eventObjectVersion) return [];
			return [f.inst];
		}
		case 'attachedTo': {
			const src = run.locate(run.ctx.sourceId)?.inst;
			if (!src || src.zone !== 'battlefield' || src.phasedOut || !src.attachedToId) return [];
			const host = run.locate(src.attachedToId)?.inst;
			return host && host.zone === 'battlefield' && !host.phasedOut ? [host] : [];
		}
		case 'all': {
			const zone = sel.filter.zone ?? 'battlefield';
			const out: CardInstance[] = [];
			for (const p of run.apnapPlayers()) {
				if (zone === 'battlefield') {
					for (const c of p.battlefield) if (!c.phasedOut && run.matches(c, sel.filter, 'battlefield')) out.push(c);
				} else if (zone === 'graveyard') {
					for (const c of p.graveyard) if (run.matches(c, sel.filter, 'graveyard')) out.push(c);
				} else if (zone === 'hand') {
					for (const c of p.hand) if (run.matches(c, sel.filter, 'hand')) out.push(c);
				} else if (zone === 'exile') {
					for (const c of p.exile) if (run.matches(c, sel.filter, 'exile')) out.push(c);
				}
			}
			return out;
		}
		case 'libraryTop': {
			const pl = (sel.player ? run.playerRef(sel.player) : null) ?? run.you;
			return pl && pl.library.length > 0 ? [pl.library[0]] : [];
		}
		default:
			return [];
	}
}

export function sourceChosenSubType(run: EffectRunAccess): string | undefined {
	const src = run.locate(run.ctx.sourceId)?.inst;
	return src?.chosenSubType ?? run.ctx.item.sourceChosenSubType;
}

export function sourceChosenColor(run: EffectRunAccess): ManaColor | undefined {
	const src = run.locate(run.ctx.sourceId)?.inst;
	return src?.chosenColor ?? run.ctx.item.sourceChosenColor;
}

export function runMatches(run: EffectRunAccess, c: CardInstance, f: ObjectFilter, zone: 'battlefield' | 'graveyard' | 'hand' | 'library' | 'exile'): boolean {
	// --- Track P13 ---
	if (f.anyOf && !f.anyOf.some((branch) => run.matches(c, branch, zone))) return false;
	// --- End Track P13 ---
	const ev = zone === 'battlefield' ? evaluatePermanent(run.state, c) : null;
	const view = ev ? null : resolveObjectFaces(effectiveCardForObject(c), instanceFaceOptions(c, zone));
	const typeWords = ev ? splitTypeLine(ev.typeLine).types : [...view!.supertypes, ...view!.types];
	const hasTypeWord = (t: string) => typeWords.some((w) => w.toLowerCase() === t.toLowerCase());
	const hasSub = (s: string) =>
		ev
			? ev.hasSubType(s)
			: matchesObjectFilter(c, { subtypes: [s] }, { state: run.state, controllerId: run.you.playerId, zone });
	if (f.types && !f.types.some(hasTypeWord)) return false;
	// --- Track P8 + Track P9 ---
	if (f.allTypes && !f.allTypes.every(hasTypeWord)) return false;
	if (
		f.unblockedAttacker !== undefined &&
		isUnblockedAttackerForPlayer(run.state, c, run.you.playerId) !== f.unblockedAttacker
	) {
		return false;
	}
	if (f.subtypes && !f.subtypes.some(hasSub)) return false;
	if (f.notSubtypes && f.notSubtypes.some(hasSub)) return false;
	if (f.ofChosenType) {
		const chosenSub = sourceChosenSubType(run);
		if (!chosenSub || !hasSub(chosenSub)) return false;
	}
	if (f.notTypes && f.notTypes.some(hasTypeWord)) return false;
	if (f.supertypes && !f.supertypes.every(hasTypeWord)) return false;
	if (f.notSupertypes && f.notSupertypes.some(hasTypeWord)) return false;
	const you = run.you.playerId;
	const controllerId = zone === 'battlefield' ? c.controllerId : c.ownerId;
	if (f.controller === 'you' && controllerId !== you) return false;
	if (f.controller === 'opponent' && controllerId === you) return false;
	if (f.controllerRef) {
		const refPlayer = run.playerRef(f.controllerRef);
		if (!refPlayer || controllerId !== refPlayer.playerId) return false;
	}
	if (f.owner === 'you' && c.ownerId !== you) return false;
	if (f.owner === 'opponent' && c.ownerId === you) return false;
	if (f.ownerRef) {
		const refOwner = run.playerRef(f.ownerRef);
		if (!refOwner || c.ownerId !== refOwner.playerId) return false;
	}
	if (f.tapped !== undefined && c.tapped !== f.tapped) return false;
	if (f.saddled !== undefined && Boolean(c.saddledThisTurn) !== f.saddled) return false;
	if (f.monstrous !== undefined && Boolean(c.isMonstrous) !== f.monstrous) return false;
	// --- Track P10 ---
	if (f.suspected !== undefined && Boolean(c.isSuspected) !== f.suspected) return false;
	// --- End Track P10 ---
	if (f.token !== undefined && c.isToken !== f.token) return false;
	if (f.isCommander !== undefined && Boolean(c.isCommander) !== f.isCommander) return false;
	if (f.exiledWithSelf) {
		if (zone !== 'exile' || !c.exiledBy) return false;
		const srcInst = run.locate(run.ctx.sourceId)?.inst;
		const expectedVer = run.ctx.item.sourceObjectVersion ?? srcInst?.objectVersion ?? 1;
		if (
			c.exiledBy.sourceInstanceId !== run.ctx.sourceId ||
			c.exiledBy.sourceObjectVersion !== expectedVer
		) {
			return false;
		}
	}
	// --- Track P16a (CR 701.72, CR 607.2a) ---
	if (f.assimilatedWithSelf) {
		if (!c.assimilatedBy) return false;
		const srcInst = run.locate(run.ctx.sourceId)?.inst;
		const expectedVer = run.ctx.item.sourceObjectVersion ?? srcInst?.objectVersion ?? 1;
		if (
			c.assimilatedBy.sourceInstanceId !== run.ctx.sourceId ||
			c.assimilatedBy.sourceObjectVersion !== expectedVer
		) {
			return false;
		}
	}
	// --- End Track P16a ---
	if (f.other && c.instanceId === run.ctx.sourceId) return false;
	if (f.named !== undefined) {
		const name = c.isFaceDown ? '' : ev ? ev.effectiveName : view!.name;
		if (name.toLowerCase() !== f.named.toLowerCase()) return false;
	}
	const cols = c.isFaceDown ? [] : ev ? ev.colors : view!.colors;
	if (f.colors && !f.colors.some((col) => (col === 'C' ? cols.length === 0 : cols.includes(col)))) return false;
	// --- Track P8 ---
	if (f.notColors?.length && f.notColors.some((col) => (col === 'C' ? cols.length === 0 : cols.includes(col)))) {
		return false;
	}
	if (f.multicolored !== undefined && (cols.length >= 2) !== f.multicolored) return false;
	if (f.monocolored !== undefined && (cols.length === 1) !== f.monocolored) return false;
	if (f.hasKeywords?.length || f.lacksKeywords?.length) {
		if (
			!matchesObjectFilter(
				c,
				{
					...(f.hasKeywords ? { hasKeywords: f.hasKeywords } : {}),
					...(f.lacksKeywords ? { lacksKeywords: f.lacksKeywords } : {})
				},
				{ state: run.state, controllerId: you }
			)
		) {
			return false;
		}
	}
	if (f.hasCounters !== undefined) {
		if (f.hasCounters === 'any') {
			if (!Object.values(c.counters).some((n) => n > 0)) return false;
		} else if (((c.counters as Record<string, number>)[f.hasCounters] ?? 0) <= 0) {
			return false;
		}
	}
	if (f.notHasCounters !== undefined) {
		if (f.notHasCounters === 'any') {
			if (Object.values(c.counters).some((n) => n > 0)) return false;
		} else if (((c.counters as Record<string, number>)[f.notHasCounters] ?? 0) > 0) {
			return false;
		}
	}
	if (f.power) {
		const p = objectPower(run.state, c);
		if (p === null || !compare(p, f.power.op, run.amount(f.power.value))) return false;
	}
	if (f.toughness) {
		const t = objectToughness(run.state, c);
		if (t === null || !compare(t, f.toughness.op, run.amount(f.toughness.value))) return false;
	}
	if (f.blocking !== undefined) {
		const blocking = run.state.combat.attackers.some((a) => a.blockerInstanceIds.includes(c.instanceId));
		if (blocking !== f.blocking) return false;
	}
	if (f.ofChosenColor) {
		const chosenCol = sourceChosenColor(run);
		if (!chosenCol || !cols.includes(chosenCol)) return false;
	}
	if (
		f.manaValue &&
		!compare(
			objectManaValue(run.state, c),
			f.manaValue.op,
			run.amount(f.manaValue.value)
		)
	) {
		return false;
	}
	if (f.attacking !== undefined) {
		const attacking = run.state.combat.attackers.some((a) => a.attackerInstanceId === c.instanceId);
		if (attacking !== f.attacking) return false;
	}
	// --- Track P13 ---
	if (
		f.historic !== undefined ||
		f.artifactEnchantmentOrToken !== undefined ||
		f.powerLessThanSource !== undefined ||
		f.untappedNonattackingSummoningReady !== undefined ||
		f.ofChosenName !== undefined ||
		f.attachedToRef !== undefined
	) {
		const srcInst = run.locate(run.ctx.sourceId)?.inst;
		if (
			!matchesObjectFilter(
				c,
				{
					...(f.historic !== undefined ? { historic: f.historic } : {}),
					...(f.artifactEnchantmentOrToken !== undefined
						? { artifactEnchantmentOrToken: f.artifactEnchantmentOrToken }
						: {}),
					...(f.powerLessThanSource !== undefined
						? { powerLessThanSource: f.powerLessThanSource }
						: {}),
					...(f.untappedNonattackingSummoningReady !== undefined
						? { untappedNonattackingSummoningReady: f.untappedNonattackingSummoningReady }
						: {}),
					...(f.ofChosenName !== undefined ? { ofChosenName: f.ofChosenName } : {}),
					...(f.attachedToRef !== undefined ? { attachedToRef: f.attachedToRef } : {})
				},
				{ state: run.state, controllerId: you, source: srcInst }
			)
		) {
			return false;
		}
	}
	if (!matchesP13ObjectFilterFields(c, f, { state: run.state, zone, stackItem: run.ctx.item })) {
		return false;
	}
	// --- End Track P13 ---
	// --- Track P16b ---
	if (
		f.sameNameAsSource !== undefined ||
		f.sharesColorWithSelf !== undefined ||
		f.hasAnyCounter !== undefined ||
		f.equipped !== undefined ||
		f.enchanted !== undefined ||
		f.toughnessGreaterThanPower !== undefined ||
		f.manaValueParity !== undefined ||
		f.controlledByChosenPlayer !== undefined ||
		f.pairedWithSource !== undefined
	) {
		const srcInst = run.locate(run.ctx.sourceId)?.inst;
		if (
			!matchesObjectFilter(
				c,
				{
					...(f.sameNameAsSource !== undefined ? { sameNameAsSource: f.sameNameAsSource } : {}),
					...(f.sharesColorWithSelf !== undefined
						? { sharesColorWithSelf: f.sharesColorWithSelf }
						: {}),
					...(f.hasAnyCounter !== undefined ? { hasAnyCounter: f.hasAnyCounter } : {}),
					...(f.equipped !== undefined ? { equipped: f.equipped } : {}),
					...(f.enchanted !== undefined ? { enchanted: f.enchanted } : {}),
					...(f.toughnessGreaterThanPower !== undefined
						? { toughnessGreaterThanPower: f.toughnessGreaterThanPower }
						: {}),
					...(f.manaValueParity !== undefined ? { manaValueParity: f.manaValueParity } : {}),
					...(f.controlledByChosenPlayer !== undefined
						? { controlledByChosenPlayer: f.controlledByChosenPlayer }
						: {}),
					...(f.pairedWithSource !== undefined ? { pairedWithSource: f.pairedWithSource } : {})
				},
				{ state: run.state, controllerId: you, source: srcInst }
			)
		) {
			return false;
		}
	}
	if (
		!matchesP16bObjectFilter(c, f, {
			state: run.state,
			controllerId: you,
			source: run.locate(run.ctx.sourceId)?.inst,
			zone,
			stackItem: run.ctx.item
		})
	) {
		return false;
	}
	// --- End Track P16b ---
	// --- Wave 9 & Wave 10 ---
	if (f.powerOrToughness) {
		const p = objectPower(run.state, c);
		const t = objectToughness(run.state, c);
		const rhs = run.amount(f.powerOrToughness.value);
		const pOk = p !== null && compare(p, f.powerOrToughness.op, rhs);
		const tOk = t !== null && compare(t, f.powerOrToughness.op, rhs);
		if (!pOk && !tOk) return false;
	}
	if (f.manaValueCompare && !compare(objectManaValue(run.state, c), f.manaValueCompare.op, run.amount(f.manaValueCompare.value))) {
		return false;
	}
	if (hasWave10ObjectFilterFields(f)) {
		const srcInst = run.locate(run.ctx.sourceId)?.inst;
		let bindingTypes: string[] | undefined;
		if (f.sharesCardTypeWithBinding !== undefined) {
			const bList = run.bindings.get(f.sharesCardTypeWithBinding) ?? [];
			const bFound = bList[0] ? run.locate(bList[0].id) : null;
			if (bFound) {
				const bCard = effectiveCardForObject(bFound.inst);
				const bView = resolveObjectFaces(bCard, instanceFaceOptions(bFound.inst, bFound.zone));
				bindingTypes = [...bView.types];
			}
		}
		if (
			!matchesObjectFilterWave10(
				run.state,
				c,
				f,
				{
					controllerId: you,
					source: srcInst,
					targets: run.ctx.targets,
					evalAmount: (a) => run.amount(a),
					bindingTypes,
					initialSnapshots: run.initialSnapshots,
					readStat: {
						manaValue: objectManaValue,
						power: objectPower,
						toughness: objectToughness
					}
				},
				zone
			)
		) {
			return false;
		}
	}
	// --- End Wave 9 & Wave 10 ---
	// --- Wave 11 ---
	if (
		!evaluateWave11ObjectFilter(c, f, zone, {
			state: run.state,
			controllerId: you,
			source: run.locate(run.ctx.sourceId)?.inst,
			eventObjectId: run.ctx.eventObjectId,
			eventAmount: run.ctx.eventAmount,
			item: run.ctx.item
				? {
						revealedCostCard: run.ctx.item.revealedCostCard,
						sacrificedCostLki: run.ctx.item.sacrificedCostLki
					}
				: undefined,
			stepActedIds: run.stepActedIds,
			chosenOddOrEvenParity: run.state.cantBlockManaValueParityThisTurn
		})
	) {
		return false;
	}
	// --- End Wave 11 ---
	return true;
}

export function evaluateEffectCondition(run: EffectRunAccess, c: Condition): boolean {
	switch (c.k) {
		case 'compare':
			return compare(run.amount(c.left), c.op, run.amount(c.right));
		case 'and':
			return c.of.every((x) => run.condition(x));
		case 'or':
			return c.of.some((x) => run.condition(x));
		case 'not':
			return !run.condition(c.of);
		case 'isTurnOf': {
			const p = run.playerRef(c.player);
			return Boolean(p && run.state.players[run.state.activePlayerIndex]?.playerId === p.playerId);
		}
		case 'graveyardAbove':
			return false;
		case 'controlCommander':
			return run.you.battlefield.some((perm) => !perm.phasedOut && Boolean(perm.isCommander));
		case 'kicked':
			return evaluateKickerCondition(c, run.kickerInfo());
		case 'evoked':
			return isObjectEvoked(run.state, run.ctx.sourceId, run.ctx.item);
		case 'escaped':
			return isObjectEscaped(run.state, run.ctx.sourceId, run.ctx.item);
		case 'isMonarch': {
			const monarchId = run.state.monarchPlayerId ?? null;
			if (!monarchId) return false;
			if (c.player) {
				const pl = run.playerRef(c.player);
				return Boolean(pl && monarchId === pl.playerId);
			}
			const rel = c.relation ?? 'you';
			if (rel === 'you') return monarchId === run.you.playerId;
			if (rel === 'opponent') return monarchId !== run.you.playerId;
			return true;
		}
		case 'foretold':
			return isObjectForetold(run.state, run.ctx.sourceId, run.ctx.item);
		case 'blitzed':
			return isObjectBlitzed(run.state, run.ctx.sourceId, run.ctx.item);
		case 'saddled': {
			const f = run.locate(run.ctx.sourceId);
			return Boolean(f && f.zone === 'battlefield' && !f.inst.phasedOut && f.inst.saddledThisTurn);
		}
		// --- Track P4 ---
		case 'exertedThisTurn': {
			if (run.ctx.item.sourceExertedThisTurn) return true;
			const f = run.locate(run.ctx.sourceId);
			return Boolean(f && f.zone === 'battlefield' && !f.inst.phasedOut && f.inst.exertedThisTurn);
		}
		// --- Track P5 ---
		case 'monstrous': {
			const f = run.locate(run.ctx.sourceId);
			if (
				f &&
				f.zone === 'battlefield' &&
				!f.inst.phasedOut &&
				(run.ctx.item.sourceObjectVersion === undefined ||
					(f.inst.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
			) {
				return Boolean(f.inst.isMonstrous);
			}
			return Boolean(run.ctx.item.sourceMonstrous);
		}
		case 'matchesFilter': {
			const targetRef = c.target ?? { k: 'self' };
			const objs = run.objects(targetRef as Selector);
			if (objs.length === 0) return false;
			const matchOne = (o: CardInstance) =>
				run.matches(
					o,
					c.filter,
					(o.zone === 'command' ? 'exile' : o.zone) as
						| 'battlefield'
						| 'graveyard'
						| 'hand'
						| 'library'
						| 'exile'
				);
			// --- Track P16a: `c.any` checks `some` for multi-card bindings ---
			return c.any ? objs.some(matchOne) : objs.every(matchOne);
			// --- End Track P16a ---
		}
		case 'evolveCompare': {
			const src = run.sourcePerm;
			if (!src || src.zone !== 'battlefield') return false;
			const srcEval = evaluatePermanent(run.state, src);
			if (!srcEval.isCreature) return false;
			let enterPower: number | undefined;
			let enterToughness: number | undefined;
			if (run.ctx.eventObjectId) {
				const enterPerm = run.locate(run.ctx.eventObjectId)?.inst;
				if (enterPerm && enterPerm.zone === 'battlefield') {
					const enterEval = evaluatePermanent(run.state, enterPerm);
					enterPower = enterEval.power;
					enterToughness = enterEval.toughness;
				} else if (run.ctx.eventLki) {
					enterPower = run.ctx.eventLki.power;
					enterToughness = run.ctx.eventLki.toughness;
				}
			}
			if (enterPower === undefined || enterToughness === undefined) return false;
			return enterPower > srcEval.power || enterToughness > srcEval.toughness;
		}
		// --- Track P7 ---
		case 'creatureDiedThisTurn':
		case 'attackedThisTurn':
		case 'permanentLeftBattlefieldThisTurn':
		case 'gainedLifeThisTurn':
		case 'wasCast': {
			const f = run.locate(run.ctx.sourceId);
			const liveObj =
				f &&
				f.zone === 'battlefield' &&
				!f.inst.phasedOut &&
				(run.ctx.item.sourceObjectVersion === undefined ||
					(f.inst.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
					? f.inst
					: undefined;
			const minLife =
				c.k === 'gainedLifeThisTurn' && c.min ? run.amount(c.min, 1) : undefined;
			return evaluateP7Condition(run.state, c, run.you.playerId, {
				minLife,
				sourceObj: liveObj,
				stackItem: run.ctx.item
			});
		}
		// --- Track P8 ---
		case 'objectState':
		case 'opponentCount':
		case 'anyPlayerLife':
		case 'distinctControlledCreaturePowers': {
			const srcFound = run.locate(run.ctx.sourceId);
			return evaluateP8Condition(c, {
				state: run.state,
				controllerId: run.you.playerId,
				source: srcFound?.inst,
				stackItem: run.ctx.item,
				xValue: run.ctx.xValue
			});
		}
		// --- Track P9 ---
		case 'cameUnderControlSinceLastUpkeep': {
			const f = run.locate(run.ctx.sourceId);
			return cameUnderControlSinceLastUpkeep(
				run.state,
				run.you.playerId,
				f && f.zone === 'battlefield' ? f.inst : undefined
			);
		}
		case 'ninjutsuWindow':
			return isNinjutsuWindowOpen(run.state);
		case 'lkiHasNoCounter':
			return (run.ctx.eventLki?.counters?.[c.counter] ?? 0) <= 0;
		// --- Track P10 ---
		case 'opponentLostLifeThisTurn':
		case 'descendedThisTurn':
		case 'hadCounterOnIt':
		case 'manaColorSpentToCast':
		case 'opponentComparison': {
			const f = run.locate(run.ctx.sourceId);
			const liveObj =
				f &&
				f.zone === 'battlefield' &&
				!f.inst.phasedOut &&
				(run.ctx.item.sourceObjectVersion === undefined ||
					(f.inst.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
					? f.inst
					: undefined;
			return evaluateP10Condition(c, {
				state: run.state,
				controllerId: run.you.playerId,
				source: liveObj,
				stackItem: run.ctx.item,
				eventLkiCounters: run.ctx.eventLki?.counters
			});
		}
		// --- End Track P10 ---
		// --- Track P12 ---
		case 'classLevelIs':
		case 'classLevelAtLeast':
		case 'caseSolved':
		case 'caseUnsolved':
		case 'isRenowned':
		case 'boastAttackedThisTurn':
		case 'exhaustUnused':
		case 'dethroneMostLife':
		case 'trainingGreaterAttacker':
		case 'creaturesAttackedCountThisTurn':
		case 'totalPowerControlled':
		case 'colorsAmongControlledPermanents':
		case 'sourcesDealtDamageThisTurn':
		case 'cardsPutIntoGraveyardFromAnywhereThisTurn':
		case 'spellsCastThisTurnCount': {
			const srcFound = run.locate(run.ctx.sourceId);
			return (
				evaluateP12Condition(
					c,
					{
						state: run.state,
						controllerId: run.you.playerId,
						source: srcFound?.inst,
						stackItem: run.ctx.item,
						xValue: run.ctx.xValue
					},
					matchesObjectFilter
				) ?? false
			);
		}
		// --- End Track P12 ---
		// --- Track P13 ---
		case 'selfInZone':
		case 'spellsCastLastTurn':
		case 'hasCompletedDungeon':
		case 'hasInitiative':
		case 'hasCitysBlessing':
		case 'hasMaxSpeed':
		case 'opponentPoisonAtLeast':
		case 'nonlandEnteredThisTurn':
		case 'voidThisTurn':
		case 'sameColorManaSpentAtLeast': {
			const srcFound = run.locate(run.ctx.sourceId);
			return (
				evaluateP13Condition(c, {
					state: run.state,
					controllerId: run.you.playerId,
					sourceId: run.ctx.sourceId,
					source: srcFound?.inst ?? null,
					stackItem: run.ctx.item
				}) ?? false
			);
		}
		// --- End Track P13 ---
		// --- Track P14 ---
		case 'anyOpponentMetric':
		case 'cardsDrawnThisTurnAtLeast':
		case 'nthMatchingSpellThisTurn': {
			const srcFound = run.locate(run.ctx.sourceId);
			return (
				evaluateWave5Condition(c, {
					state: run.state,
					controllerId: run.you.playerId,
					source: srcFound?.inst,
					stackItem: run.ctx.item,
					xValue: run.ctx.xValue
				}) ?? false
			);
		}
		// --- End Track P14 ---
		// --- Track P15 ---
		case 'maxSpeed':
		case 'citysBlessing':
		case 'giftPromised':
		case 'isDay':
		case 'isNight':
		case 'isYourTurn':
		case 'selfPrepared':
		case 'isImpending':
		case 'enteredWithXAtLeast': {
			const f = run.locate(run.ctx.sourceId);
			const liveObj =
				f &&
				f.zone === 'battlefield' &&
				!f.inst.phasedOut &&
				(run.ctx.item.sourceObjectVersion === undefined ||
					(f.inst.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
					? f.inst
					: undefined;
			return (
				evaluateP15Condition(c, run.state, run.you.playerId, {
					source: liveObj,
					giftPromised: Boolean(
						run.ctx.item.giftKind ||
							run.ctx.item.sourceGiftPromised ||
							liveObj?.giftPromised
					),
					enteredWithX:
						liveObj?.enteredWithX ??
						run.ctx.item.sourceEnteredWithX ??
						run.ctx.xValue,
					castWithImpending: Boolean(
						liveObj?.castWithImpending ?? run.ctx.item.sourceCastWithImpending
					)
				}) ?? false
			);
		}
		// --- End Track P15 ---
		// --- Wave 6 Shared ---
		case 'isPaired':
		case 'tributePaid':
		case 'hasEnduringStory':
		case 'isHarnessed': {
			const f = run.locate(run.ctx.sourceId);
			const liveObj =
				f &&
				f.zone === 'battlefield' &&
				!f.inst.phasedOut &&
				(run.ctx.item.sourceObjectVersion === undefined ||
					(f.inst.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
					? f.inst
					: undefined;
			if (c.k === 'isPaired') return Boolean(liveObj?.pairedWithId);
			// --- Track P18a ---
			if (c.k === 'tributePaid') {
				return Boolean(liveObj?.tributePaid || run.ctx.item.sourceTributePaid);
			}
			if (c.k === 'hasEnduringStory') {
				return Boolean(liveObj?.hasEnduringStory || run.ctx.controller.hasEnduringStory);
			}
			// --- End Track P18a ---
			return Boolean(liveObj?.isHarnessed);
		}
		// --- End Wave 6 Shared ---
		// --- Track P16b ---
		case 'attackingTotalPowerAtLeast':
		case 'firstCombatPhaseOfTurn':
		case 'eventPlayerHandCount':
		case 'notEventPlayerTurn':
		case 'cardLeftYourGraveyardThisTurn':
		case 'committedCrimeThisTurn':
		case 'controlledByOtherThanOwner':
		case 'youLostLifeThisTurn':
		case 'playerLostLifeAtLeastThisTurn':
		case 'moreCardsInHandThanEachOpponent':
		case 'eventObjectMatchedLki':
			return (
				evaluateP16bCondition(
					c,
					{
						state: run.state,
						controllerId: run.you.playerId,
						source: run.locate(run.ctx.sourceId)?.inst,
						stackItem: run.ctx.item
					},
					matchesObjectFilter
				) ?? false
			);
		// --- End Track P16b ---
		// --- Track P17b ---
		case 'p17bCondition': {
			const srcFound = run.locate(run.ctx.sourceId);
			return evaluateP17bCondition(
				c,
				{
					state: run.state,
					controllerId: run.you.playerId,
					source: srcFound?.inst,
					stackItem: run.ctx.item,
					xValue: run.ctx.xValue
				},
				matchesObjectFilter
			);
		}
		// --- End Track P17b ---
		// --- Track P18b ---
		case 'anchorWordChosen': {
			const f = run.locate(run.ctx.sourceId);
			const liveObj =
				f &&
				f.zone === 'battlefield' &&
				!f.inst.phasedOut &&
				(run.ctx.item.sourceObjectVersion === undefined ||
					(f.inst.objectVersion ?? 1) === run.ctx.item.sourceObjectVersion)
					? f.inst
					: undefined;
			return (
				(liveObj?.chosenAnchorWord ?? '').trim().toLowerCase() === c.word.trim().toLowerCase()
			);
		}
		case 'youWereAttackedThisCombat':
			return Boolean(
				run.state.combat?.active &&
					run.state.combat.attackers.some((a) => a.defenderPlayerId === run.you.playerId)
			);
		// --- End Track P18b ---
		// --- Track P16a ---
		case 'diedThisWay':
			return Boolean(evaluateP16aStepCondition(run.p16aHost(), c));
		// --- End Track P16a ---
		// --- Track P20a ---
		case 'lifeCompareHalfStarting':
		case 'mostCommonColorAmongPermanents':
		// --- End Track P20a ---
		// --- Track P22a ---
		case 'lifeAtLeastAboveStarting':
		case 'isAttackingAlone':
		case 'hasntDealtDamageYet':
		case 'yourTurnsTakenAtLeast':
		case 'enteredBattlefieldUnderYourControlThisTurn': {
		// --- End Track P22a ---
			const srcFound = run.locate(run.ctx.sourceId);
			return evaluateCondition(c, {
				state: run.state,
				controllerId: run.you.playerId,
				source: srcFound?.inst
			});
		}
		// --- Track P19a ---
		case 'anyGraveyardAtLeast':
		case 'controlledTargetAtResolution':
		case 'abilityActivatedCountThisTurn': {
			const srcFound = run.locate(run.ctx.sourceId);
			return Boolean(
				evaluateP19aCondition(c, {
					state: run.state,
					controllerId: run.you.playerId,
					source: srcFound?.inst,
					stackItem: run.ctx.item,
					xValue: run.ctx.xValue
				})
			);
		}
		// --- End Track P19a ---
		// --- Track P19b ---
		// --- Wave 10 ---
		case 'isFirstCombatPhaseOfTurn':
		case 'opponentHasMoreCardsInHandThan':
		case 'playerControlsFilter':
		case 'playerLostLifeThisTurn':
		case 'wasDealtCombatDamageBySelfNameThisGame':
		case 'playerDidntDiscardNonlandThisWay':
		case 'playerDiscardedHandThisWay':
			return evaluateWave10Condition(run, c) ?? false;
		// --- End Wave 10 ---
		default: {
			const w11Cond = evaluateWave11Condition(run, c);
			if (w11Cond !== null) return w11Cond;
			const srcFound = run.locate(run.ctx.sourceId);
			return evaluateCondition(c, {
				state: run.state,
				controllerId: run.you.playerId,
				source: srcFound?.inst,
				stackItem: run.ctx.item
			});
		}
		// --- End Track P19b ---
	}
}
