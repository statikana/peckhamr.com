/**
 * Trigger matching (ENGINE_ARCHITECTURE_PLAN.md section 2.3, Phase 5).
 *
 * One engine for every triggered ability. For each game event (runtime/events.ts) it walks the
 * compiled TriggerDefs of the objects in the relevant zones (the battlefield; the graveyard for
 * `fromZone: 'graveyard'` abilities such as Nether Shadow; the spell itself for "When you cast ~";
 * the last known information of an object that just left the battlefield for leaves-the-battlefield
 * abilities, CR 603.10a) and records each match as a pending trigger. Nothing runs at match time.
 *
 * `flushTriggers` then puts the pending triggers "on the stack" in APNAP order (CR 603.3b): the
 * active player's first, then each other player's in turn order. The engine calls it at the points
 * where a player would next receive priority (end of state-based actions, phase changes, the end of
 * every action) and where the pre-Phase-5 engine ran triggers directly (after the log line of the
 * zone change, so log order and `landsPlayedThisTurn` are as before).
 *
 * Intervening-if conditions (CR 603.4) are checked when the event happens and again on resolution.
 *
 * This file never reads rules text or card names: it reads compiled IR (compiler/triggers.ts
 * `runtimeTriggers`) and evaluated permanents (ruleTree.ts `evaluatePermanent`).
 */
import { compileCard } from '../compiler/index.ts';
import { parseCost } from '../compiler/costs.ts';
import { runtimeTriggers, type RuntimeTrigger } from '../compiler/triggers.ts';
import type { Amount, Compare, Condition, EventFilter, EventKind, ObjectFilter, TriggerDef } from '../ir.ts';
import { formatGrantedKeywordDef, getKeywordSpec, GRANTED_TRIGGER_KEYWORD_EVENTS } from '../keywords.ts';
import { evaluatePermanent, inspectCardContinuousBreakdown, permanentHasLostAllAbilities } from '../ruleTree.ts';
import type {
	CardInstance,
	CounterType,
	GameState,
	ManaColor,
	ScryfallCard,
	SerializedPendingTrigger,
	StackItem,
	ZoneType
} from '../types.ts';
import type { GameEvent } from './events.ts';
import {
	evaluateKickedCountAmount,
	evaluateKickerCondition,
	getObjectKickerInfo,
	isObjectBlitzed,
	isObjectEscaped,
	isObjectEvoked,
	isObjectForetold
} from './kicker.ts';
import { withStableLayerInputs } from './layerCache.ts';
import { splitSubtypes } from './layers.ts';
import { activeAbilityDefs, instanceFaceOptions, matchesColorFilter, resolveObjectFaces, stackItemFaceOptions } from './faces.ts';
import {
	// --- Track P22c ---
	evaluateAmount as evaluateObjectFilterAmount,
	evaluateCondition as evaluateObjectFilterCondition,
	// --- End Track P22c ---
	// --- Track P7 ---
	objectManaValue,
	objectPower,
	objectToughness,
	// --- End Track P7 ---
	playerCommanderCastCount
} from './objectFilter.ts';
import { triggerMultiplier } from './replace.ts';
// --- Track P7 ---
import { activeTimedLayer1aForPermanent } from './layerCache.ts';
import { evaluateP7Condition } from './copyPreventionAndEffects.ts';
// --- Track P9 ---
import {
	cameUnderControlSinceLastUpkeep,
	extractGrantedDeathKeywords,
	isNinjutsuWindowOpen
} from './keywordsWave3.ts';
// --- Track P10 ---
import { countDistinctCardTypesInZone, evaluateP8Condition } from './staticsLayersAndRestrictions.ts';
import {
	evaluateP10Condition,
	flushPendingReflexiveTriggers,
	resolveQuotedAbilityDefs
} from './reflexiveManaAndActions.ts';
// --- End Track P10 ---
// --- Track P11 ---
import {
	collectActiveGrantedTriggeredAbilities,
	computeAttachmentsOnCount,
	computeDomainCount,
	computePartyCount,
	resolveGrantedRuntimeTrigger,
	type GrantedTriggeredAbilityInstance
} from './staticsDynamicAndCosts.ts';
// --- End Track P11 ---
// --- Track P12 ---
import {
	attachWave4TagToBaseRuntimeTrigger,
	attackerHasGreaterPowerCoAttacker,
	buildSingleWave4KeywordTriggers,
	collectBackupGrantedAbilityDefs,
	evaluateP12Amount,
	evaluateP12Condition,
	isPlayerTiedForMostLife,
	parseGrantedWave4TriggerKeyword,
	type Wave4RuntimeTrigger
} from './keywordsWave4.ts';
import { matchesObjectFilter } from './objectFilter.ts';
import {
	areOpponentWardTriggersSuppressedWave9,
	buildGrantedRippleTriggerWave9
} from './staticsWave9.ts';
// --- End Track P12 ---
// --- Track P13 ---
import {
	computeColorsAmongPermanents,
	computeDevotionTo,
	computeStatAggregateAmong,
	computeUnlockedDoorsCount,
	evaluateP13Condition,
	matchesP13ObjectFilterFields
} from './effectsWave5.ts';
// --- End Track P13 ---
// --- Track P15 ---
import {
	evaluateP15Amount,
	evaluateP15Condition,
	findFaceGiftKeyword,
	objectsShareCreatureSubtype,
	type Wave5RuntimeTrigger
} from './framesBattlesAndKeywordsWave5.ts';
// --- End Track P15 ---
// --- Track P16b ---
import { evaluateWave5Condition } from './staticsAndCostsWave5.ts';
import {
	abilityHasDoThisOncePerTurn,
	collectReadyStateTriggers,
	doThisOnceKey,
	evaluateP16bCondition,
	isDoThisOnceTakenThisTurn,
	makeSynthCardInstance,
	matchesDuringTurnFilter,
	matchesP16bObjectFilter,
	matchesSpellCastOrdinal
} from './triggersWave6.ts';
// --- End Track P16b ---
// --- Track P17b ---
import { evaluateP17bCondition } from './costsWave6.ts';
// --- End Track P17b ---
// --- Track P18a ---
import {
	attachWave6TagToBaseRuntimeTrigger,
	buildGrantedWave6KeywordTriggers,
	grantedWave6TriggerEvents,
	parseGrantedWave6TriggerKeyword,
	type Wave6RuntimeTrigger
} from './keywordsWave6.ts';
// --- End Track P18a ---
// --- Track P17a ---
import { applyPendingExileReplacementCounters } from './staticsWave6.ts';
// --- End Track P17a ---
// --- Track P19b ---
import type { Wave7SpellDelayedTrigger } from '../types.ts';
import {
	buildDelegatedSubFilterP19b,
	canEnterInlineManaResolution,
	consumeP19bSpellDelayedTrigger,
	evaluateP19bCondition,
	hasDelegatedObjectFilterFieldsP19b,
	isP19bInlineManaEvent,
	matchesManaColorEventFilterP19b,
	recordP19bDamageState,
	recordP19bZoneChangeState,
	resolveTapActorId
} from './triggersWave7.ts';
// --- End Track P19b ---
// --- Track P22b ---
import {
	dispatchP22bTriggerEvent,
	evaluateP22bAmount,
	evaluateP22bCondition,
	hasP22bObjectFilterFields,
	matchesP22bAttackedTargetWithMostLife,
	matchesP22bCastFilter,
	matchesP22bObjectFilter,
	matchesP22bPhaseFilter
} from './triggersWave8.ts';
// --- End Track P22b ---
// --- Wave 9 ---
import {
	dispatchWave9TriggerEvent,
	isEnchantedPlayerId,
	matchesWave9AttacksFilter,
	matchesWave9DamagedTargetMin
} from './triggersWave9.ts';
// --- End Wave 9 ---

import {
	alternatives,
	battlefieldSubject,
	channel,
	channels,
	evaluateCondition,
	filterMatches,
	getTriggerHost,
	hasPendingTriggers,
	hasWord,
	hydratePendingTriggers,
	isResolutionPaused,
	objectMatches,
	peekPendingTriggers,
	permanentById,
	persistPendingTriggers,
	preLeaveGrantedTriggers,
	printedSubject,
	registerTriggerHost,
	stashPreLeaveGrantedTriggers,
	subtypePart,
	viewerOf,
	withSimultaneousZoneBatch,
	withTriggersDeferred,
	abilitiesFor,
	activeFacesForObject,
	collectSurvivingTimedGrantedAbilityTexts,
	getActiveSimultaneousZoneBatchToken,
	grantedTriggerEventsForKeyword,
	quotedTriggersForTexts,
	sources,
	triggersOf,
	type PendingTrigger,
	type SimultaneousLkiEntry,
	type Source,
	type Subject,
	type TriggerHost,
	type TriggerMode
} from './triggersFiltersAndQueue.ts';

export {
	collectSurvivingTimedGrantedAbilityTexts,
	evaluateCondition,
	getActiveSimultaneousZoneBatchToken,
	hasPendingTriggers,
	peekPendingTriggers,
	registerTriggerHost,
	stashPreLeaveGrantedTriggers,
	withSimultaneousZoneBatch,
	withTriggersDeferred,
	type PendingTrigger,
	type TriggerHost,
	type TriggerMode
} from './triggersFiltersAndQueue.ts';

/**
 * CR 603.10a: When multiple permanents are destroyed simultaneously (e.g. "Destroy all creatures"),
 * capture each permanent's pre-destruction LKI before any are moved from the battlefield so that
 * every permanent leaving the battlefield in the batch sees the simultaneous zone changes of the
 * others, then flush all resulting triggers together in APNAP order (CR 603.3b).
 */
export function withSimultaneousDestroyLki(
	state: GameState,
	perms: CardInstance[],
	fn: () => void
): void {
	if (perms.length <= 1) {
		fn();
		flushTriggers(state);
		return;
	}
	const ch = channel(state);
	const map = new Map<CardInstance, SimultaneousLkiEntry>();
	for (const perm of perms) {
		if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		const lost = permanentHasLostAllAbilities(perm, state).lost;
		const attachedIds: string[] = [];
		for (const pl of state.players) {
			for (const pObj of pl.battlefield) {
				if (!pObj.phasedOut && pObj.attachedToId === perm.instanceId) {
					attachedIds.push(pObj.instanceId);
				}
			}
		}
		const power = ev.isCreature
			? (perm.lastKnownPower ?? ev.breakdown.effectivePower ?? ev.power)
			: undefined;
		const toughness = ev.isCreature
			? (perm.lastKnownToughness ?? ev.breakdown.effectiveToughness ?? ev.toughness)
			: undefined;
		// --- Track P9 ---
		const grantedDeathKeywords = extractGrantedDeathKeywords(state, perm, ev);
		map.set(perm, {
			obj: perm,
			// --- Track P7 ---
			card: activeTimedLayer1aForPermanent(state, perm)?.card ?? perm.copiableCard ?? perm.card,
			// --- End Track P7 ---
			controllerId: perm.controllerId,
			lostAllAbilities: lost,
			typeLine: ev.typeLine,
			hasAllCreatureTypes: ev.hasAllCreatureTypes,
			tapped: perm.tapped,
			colors: perm.isFaceDown ? [] : [...ev.colors],
			...(power !== undefined ? { power } : {}),
			...(toughness !== undefined ? { toughness } : {}),
			...(attachedIds.length > 0 ? { attachedIds } : {}),
			...(perm.activeFaceIndex !== undefined ? { activeFaceIndex: perm.activeFaceIndex } : {}),
			...(perm.unlockedFaces ? { unlockedFaces: [...perm.unlockedFaces] } : {}),
			...(perm.foretold ? { foretold: true } : {}),
			...(perm.blitzed ? { blitzed: true } : {}),
			...(perm.saddledThisTurn ? { saddled: true } : {}),
			...(perm.exertedThisTurn ? { exerted: true } : {}),
			...(perm.chosenSubType ? { chosenSubType: perm.chosenSubType } : {}),
			...(perm.chosenColor ? { chosenColor: perm.chosenColor } : {}),
			...(perm.isMonstrous ? { monstrous: true } : {}),
			// --- Track P7 ---
			...(perm.wasCast ? { wasCast: true } : {}),
			...(perm.castFromZone ? { castFromZone: perm.castFromZone } : {}),
			// --- Track P9 ---
			counters: { ...(perm.lastKnownCounters ?? perm.counters) },
			...(grantedDeathKeywords ? { grantedDeathKeywords } : {}),
			// --- Track P10 ---
			...(perm.damagedByThisTurn?.length
				? { damagedByThisTurn: perm.damagedByThisTurn.map((d) => ({ ...d })) }
				: {}),
			...(() => {
				const texts = collectSurvivingTimedGrantedAbilityTexts(state, perm);
				return texts.length > 0 ? { grantedAbilityTexts: texts } : {};
			})(),
			// --- End Track P10 ---
			// --- Track P11 ---
			...(perm.chosenCardName ? { chosenCardName: perm.chosenCardName } : {}),
			grantedTriggers: collectActiveGrantedTriggeredAbilities(state, perm),
			// --- End Track P11 ---
			// --- Track P18a ---
			...(perm.mergedComponents?.length ? { mergedComponents: [...perm.mergedComponents] } : {})
			// --- End Track P18a ---
		});
	}
	const prevMap = ch.simultaneousLki;
	// --- Track P13 ---
	const prevBatchKeys = ch.zoneBatchTriggeredKeys;
	ch.zoneBatchTriggeredKeys = new Set();
	// --- End Track P13 ---
	ch.simultaneousLki = map;
	ch.deferFlush += 1;
	try {
		fn();
	} finally {
		ch.deferFlush -= 1;
		ch.simultaneousLki = prevMap;
		// --- Track P13 ---
		ch.zoneBatchTriggeredKeys = prevBatchKeys;
		// --- End Track P13 ---
	}
	flushTriggers(state);
}


// --- Track P15 ---
export function enqueuePendingTrigger(
	state: GameState,
	trigger: Omit<PendingTrigger, 'order'>
): void {
	const ch = channel(state);
	ch.pending.push({
		...trigger,
		order: ch.nextOrder++
	});
	flushTriggers(state);
}
// --- End Track P15 ---

// ---- Matching -------------------------------------------------------------------------------

interface MatchExtras {
	label: string;
	eventObject?: CardInstance;
	eventPlayerId?: string;
	targetStackItemId?: string;
	amount?: number;
	times?: number;
	eventLki?: PendingTrigger['eventLki'];
	triggerEventStackItem?: StackItem;
	stormCount?: number;
	eventPlayer?: string;
	defendingPlayerId?: string;
	isChapterAbility?: boolean;
	isBecameMonstrous?: boolean;
	// --- Track P10 ---
	grantedAbilityText?: string;
	// --- End Track P10 ---
	// --- Track P15 ---
	gravestormCount?: number;
	// --- End Track P15 ---
	// --- Track P19b ---
	lastTappedManaColors?: ManaColor[];
	// --- End Track P19b ---
	// --- Track P22b ---
	p22bEventIsManaAbility?: boolean;
	p22bEventLifePaid?: number;
	p22bEventCrewCount?: number;
	p22bEventDamageSourceSubtypes?: string[];
	p22bEventAttackedTargetPlayerId?: string;
	// --- End Track P22b ---
}

function record(state: GameState, source: Source, ability: RuntimeTrigger, kind: EventKind, extras: MatchExtras): void {
	// CR 603.4: an intervening-if condition must be true when the event happens.
	if (
		ability.condition &&
		!evaluateCondition(
			state,
			ability.condition,
			source.controllerId,
			source.obj.instanceId,
			undefined,
			source,
			extras.eventObject,
			extras.eventLki,
			// --- Track P16b ---
			{
				eventPlayerId: extras.eventPlayerId ?? extras.eventPlayer,
				triggerEventStackItem: extras.triggerEventStackItem,
				// --- Track P22b ---
				p22bEventIsManaAbility: extras.p22bEventIsManaAbility,
				p22bEventLifePaid: extras.p22bEventLifePaid,
				p22bEventCrewCount: extras.p22bEventCrewCount,
				p22bEventDamageSourceSubtypes: extras.p22bEventDamageSourceSubtypes,
				p22bEventAttackedTargetPlayerId: extras.p22bEventAttackedTargetPlayerId
				// --- End Track P22b ---
			}
			// --- End Track P16b ---
		)
	) {
		return;
	}
	let count = extras.times ?? 1;
	if (count <= 0) return;
	// --- Track P16b: CR 603.2h "Do this only once each turn" stops triggering once taken this turn ---
	if (abilityHasDoThisOncePerTurn(ability)) {
		const doOnceKey = doThisOnceKey(
			source.obj.instanceId,
			source.obj.objectVersion,
			source.faceIndex,
			ability.abilityIndex
		);
		if (isDoThisOnceTakenThisTurn(state, doOnceKey)) {
			return;
		}
	}
	// --- End Track P16b ---
	// CR 603.2i: "This ability triggers only once each turn" cannot trigger more than once per turn
	// per object identity in that zone (CR 400.7), even under trigger multipliers.
	const grantedAbilityText =
		extras.grantedAbilityText ?? (ability as { grantedAbilityText?: string }).grantedAbilityText;
	if (ability.trigger.onlyOncePerTurn) {
		// --- Track P10 + P11 ---
		const abilityTag = source.grantedTrigger
			? `grant:${source.grantedTrigger.grantSourceId ?? ''}:${source.grantedTrigger.grantFaceIndex}:${source.grantedTrigger.grantAbilityIndex}`
			: (grantedAbilityText ?? ability.grantedKeyword ?? `${source.faceIndex ?? 0}:${ability.abilityIndex}`);
		// --- End Track P10 + P11 ---
		const onceKey = `${source.obj.instanceId}:${source.zone}:${abilityTag}`;
		if (state.triggeredOnceThisTurn?.includes(onceKey)) {
			return;
		}
		(state.triggeredOnceThisTurn ??= []).push(onceKey);
		count = 1;
	}
	// --- Track P19b ---
	if (source.wave7SpellDelayed) {
		consumeP19bSpellDelayedTrigger(state, source.wave7SpellDelayed.entry.id);
	}
	const treasureManaSpent = Boolean(
		source.obj.treasureManaSpent ||
			extras.eventObject?.treasureManaSpent ||
			extras.triggerEventStackItem?.treasureManaSpent
	);
	const sourceCounterPutOnThisTurn = Boolean(source.obj.counterPutOnThisTurn);
	// --- End Track P19b ---
	const sourceForetold = Boolean(source.foretold ?? source.obj.foretold);
	const sourceBlitzed = Boolean(source.blitzed ?? source.obj.blitzed);
	const sourceExertedThisTurn = Boolean(source.exerted ?? source.obj.exertedThisTurn);
	const sourceChosenSubType = source.chosenSubType ?? source.obj.chosenSubType;
	const sourceChosenColor = source.chosenColor ?? source.obj.chosenColor;
	const sourceMonstrous = Boolean(source.monstrous ?? source.obj.isMonstrous);
	// --- Track P7 ---
	const sourceWasCast = Boolean(source.wasCast ?? source.obj.wasCast);
	const sourceCastFromZone = source.castFromZone ?? source.obj.castFromZone;
	// --- End Track P7 ---
	// --- Track P11 ---
	const sourceChosenCardName = source.chosenCardName ?? source.obj.chosenCardName;
	// --- End Track P11 ---
	const ch = channel(state);
	for (let i = 0; i < count; i++) {
		ch.pending.push({
			ability,
			source: source.obj,
			sourceCard: source.card,
			...(source.faceIndex !== undefined ? { faceIndex: source.faceIndex } : {}),
			controllerId: source.controllerId,
			mode: modeFor(kind, source, ability),
			label: extras.label,
			eventObject: extras.eventObject && extras.eventObject !== source.obj ? extras.eventObject : undefined,
			eventPlayerId: extras.eventPlayerId,
			targetStackItemId: extras.targetStackItemId,
			amount: extras.amount,
			eventLki: extras.eventLki,
			...(extras.triggerEventStackItem ? { triggerEventStackItem: extras.triggerEventStackItem } : {}),
			...(extras.stormCount !== undefined ? { stormCount: extras.stormCount } : {}),
			...(extras.isChapterAbility ? { isChapterAbility: true } : {}),
			...(extras.isBecameMonstrous ? { isBecameMonstrous: true } : {}),
			...(sourceForetold ? { sourceForetold: true } : {}),
			...(sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(sourceChosenSubType ? { sourceChosenSubType } : {}),
			...(sourceChosenColor ? { sourceChosenColor } : {}),
			...(sourceMonstrous ? { sourceMonstrous: true } : {}),
			// --- Track P7 ---
			...(sourceWasCast ? { sourceWasCast: true } : {}),
			...(sourceCastFromZone ? { sourceCastFromZone: sourceCastFromZone } : {}),
			// --- End Track P7 ---
			// --- Track P10 ---
			...(grantedAbilityText ? { grantedAbilityText } : {}),
			// --- End Track P10 ---
			// --- Track P11 ---
			...(source.grantedTrigger
				? {
						grantSourceCard: source.grantedTrigger.grantSourceCard,
						grantFaceIndex: source.grantedTrigger.grantFaceIndex,
						grantAbilityIndex: source.grantedTrigger.grantAbilityIndex
					}
				: {}),
			...(sourceChosenCardName ? { sourceChosenCardName } : {}),
			// --- End Track P11 ---
			// --- Track P12 ---
			...(source.obj.isRenowned ? { sourceIsRenowned: true } : {}),
			...(source.obj.devouredCount !== undefined
				? { sourceDevouredCount: source.obj.devouredCount }
				: {}),
			...((ability as Wave4RuntimeTrigger).wave4Tag
				? { wave4Tag: (ability as Wave4RuntimeTrigger).wave4Tag }
				: {}),
			...((ability as Wave4RuntimeTrigger).wave4N !== undefined
				? { wave4N: (ability as Wave4RuntimeTrigger).wave4N }
				: {}),
			...((ability as Wave4RuntimeTrigger).wave4CostText !== undefined
				? { wave4CostText: (ability as Wave4RuntimeTrigger).wave4CostText }
				: {}),
			// --- End Track P12 ---
			// --- Track P15 ---
			...(extras.gravestormCount !== undefined ? { gravestormCount: extras.gravestormCount } : {}),
			...(source.obj.giftPromised ? { sourceGiftPromised: true } : {}),
			...(source.obj.enteredWithX !== undefined
				? { sourceEnteredWithX: source.obj.enteredWithX }
				: {}),
			...(source.obj.castWithImpending ? { sourceCastWithImpending: true } : {}),
			...((ability as Wave5RuntimeTrigger).wave5Tag
				? { wave5Tag: (ability as Wave5RuntimeTrigger).wave5Tag }
				: {}),
			...((ability as Wave5RuntimeTrigger).wave5N !== undefined
				? { wave5N: (ability as Wave5RuntimeTrigger).wave5N }
				: {}),
			...((ability as Wave5RuntimeTrigger).wave5CostText !== undefined
				? { wave5CostText: (ability as Wave5RuntimeTrigger).wave5CostText }
				: {}),
			...((ability as Wave5RuntimeTrigger).wave5Card
				? { wave5Card: (ability as Wave5RuntimeTrigger).wave5Card }
				: {}),
			// --- End Track P15 ---
			// --- Track P18a ---
			...(source.obj.tributePaid ? { sourceTributePaid: true } : {}),
			...((ability as Wave6RuntimeTrigger).wave6Tag
				? { wave6Tag: (ability as Wave6RuntimeTrigger).wave6Tag }
				: {}),
			...((ability as Wave6RuntimeTrigger).wave6N !== undefined
				? { wave6N: (ability as Wave6RuntimeTrigger).wave6N }
				: {}),
			...((ability as Wave6RuntimeTrigger).wave6Card
				? { wave6Card: (ability as Wave6RuntimeTrigger).wave6Card }
				: {}),
			...((ability as Wave6RuntimeTrigger).wave6FaceIndex !== undefined
				? { wave6FaceIndex: (ability as Wave6RuntimeTrigger).wave6FaceIndex }
				: {}),
			// --- End Track P18a ---
			// --- Track P19b ---
			...(extras.lastTappedManaColors?.length
				? { lastTappedManaColors: [...extras.lastTappedManaColors] }
				: {}),
			...(treasureManaSpent ? { treasureManaSpent: true } : {}),
			...(sourceCounterPutOnThisTurn ? { sourceCounterPutOnThisTurn: true } : {}),
			...(source.wave7SpellDelayed?.entry.subTriggerStepIndex !== undefined
				? { delayedSubStepIndex: source.wave7SpellDelayed.entry.subTriggerStepIndex }
				: {}),
			// --- End Track P19b ---
			eventPlayer: extras.eventPlayer ?? extras.eventPlayerId,
			defendingPlayerId: extras.defendingPlayerId,
			order: ch.nextOrder++
		});
	}
}

/**
 * Every triggered ability uses the stack (CR 603.3), except a triggered mana ability: one without
 * a target that triggers from a mana ability and could add mana (CR 605.1b). The only mana-ability
 * event the engine emits is TappedForMana; an ability triggering on it whose effect only adds mana
 * resolves immediately (CR 605.4a).
 */
function modeFor(kind: EventKind, _source: Source, ability?: RuntimeTrigger): TriggerMode {
	const e = ability?.effect;
	// --- Track P19b: CR 605.1b, 605.4a stackless triggered mana abilities ---
	if (
		isP19bInlineManaEvent(kind) &&
		canEnterInlineManaResolution() &&
		e &&
		!e.modal &&
		e.targets.length === 0 &&
		e.steps.length > 0 &&
		e.steps.every((st) => st.verb === 'addMana')
	) {
		return 'inline';
	}
	// --- End Track P19b ---
	return 'stack';
}

/**
 * Matches one event against every triggered ability. Called for every emitted event. Matching
 * only reads the board and records pending triggers (not a layer input), so one layer-cache
 * validation serves every source's ability-loss and filter checks (Phase 6d).
 */
export function matchTriggers(state: GameState, ev: GameEvent): void {
	if (state.status === 'mulligan') return;
	withStableLayerInputs(state, () => matchTriggersInner(state, ev));
}

function matchTriggersInner(state: GameState, ev: GameEvent): void {
	switch (ev.kind) {
		case 'ZoneChange':
			return matchZoneChange(state, ev);
		case 'Cast':
			return matchCast(state, ev.playerId, ev.object, false);
		case 'SpellCopied':
			return matchCast(state, ev.playerId, ev.object, true);
		case 'AttackDeclared':
			return matchAttack(state, ev.playerId, ev.attackerIds);
		case 'BlockersDeclared':
			return matchBlocks(state, ev.playerId, ev.blocks);
		case 'DamageDealt':
			return matchDamage(state, ev);
		case 'PhaseBegin':
			return matchPhase(state, ev);
		case 'CounterPlaced':
			return matchCounter(state, ev);
		case 'CounterRemoved':
			return matchCounterRemoved(state, ev);
		case 'BecameTarget':
			return matchTargeted(state, ev);
		case 'Attached':
			return matchAttached(state, ev);
		case 'TappedForMana':
			return matchTappedForMana(state, ev);
		case 'GainLife':
			return matchGainLife(state, ev);
		case 'CardDrawn':
			return matchCardDrawn(state, ev);
		case 'BecomesTapped':
			return matchBecomesTapped(state, ev);
		case 'CardDiscarded':
			return matchCardDiscarded(state, ev);
		case 'Transformed':
			return matchTransformed(state, ev);
		case 'TurnedFaceUp':
			return matchTurnedFaceUp(state, ev);
		case 'Investigated':
			return matchInvestigated(state, ev);
		case 'Surveilled':
			return matchSurveilled(state, ev);
		case 'Explored':
			return matchObjectActionEvent(state, ev, 'explore', 'Explore Trigger');
		case 'Connived':
			return matchObjectActionEvent(state, ev, 'connive', 'Connive Trigger', ev.nonlandDiscardedCount);
		case 'BecomesCrewed': {
			// --- Track P19b ---
			const crewFound = permanentById(state, ev.objectId);
			if (crewFound) {
				crewFound.obj.crewedCountThisTurn = (crewFound.obj.crewedCountThisTurn ?? 0) + 1;
			}
			// --- End Track P19b ---
			return matchObjectActionEvent(state, ev, 'becomesCrewed', 'Crew Trigger');
		}
		case 'BecomesSaddled':
			return matchObjectActionEvent(state, ev, 'becomesSaddled', 'Saddle Trigger');
		case 'Foretold':
			return matchExileActionCardEvent(state, ev.playerId, ev.card, 'foretell', 'Foretell Trigger', true);
		case 'Plotted':
			return matchExileActionCardEvent(state, ev.playerId, ev.card, 'plot', 'Plot Trigger', false);
		case 'CombatDamageBatchPlayer':
			return matchCombatDamageBatchPlayer(state, ev);
		case 'BecameMonarch':
			return matchBecameMonarch(state, ev);
		// --- Track P4 ---
		case 'Exerted':
			return matchExerted(state, ev);
		// --- Track P5 ---
		case 'Amassed':
			return matchAmassed(state, ev);
		case 'ManifestDread':
			return matchManifestDread(state, ev);
		case 'BecameMonstrous':
			return matchObjectActionEvent(state, ev, 'becameMonstrous', 'Monstrosity Trigger', ev.amount);
		// --- Track P10 ---
		case 'UnblockedAttackers':
			return matchUnblockedAttackers(state, ev);
		case 'BecomesUntapped':
			return matchBecomesUntapped(state, ev);
		case 'Scried':
			return matchScried(state, ev);
		case 'CrimeCommitted':
			return matchCrimeCommitted(state, ev);
		case 'Exploited':
			return matchExploited(state, ev);
		case 'ManaExpended':
			return matchManaExpended(state, ev);
		case 'Sacrificed':
			return matchSacrificed(state, ev);
		case 'GraveyardLeaveBatch':
			return matchGraveyardLeaveBatch(state, ev);
		case 'Discovered':
			return matchDiscovered(state, ev);
		case 'Foraged':
			return matchForaged(state, ev);
		// --- End Track P10 ---
		// --- Track P12 ---
		case 'ClassLevelGained':
			return matchWave4ObjectEvent(state, ev, 'classLevelGained', `Class Level ${ev.classLevel} Trigger`, ev.classLevel);
		case 'CaseSolved':
			return matchWave4ObjectEvent(state, ev, 'caseSolved', 'Case Solved Trigger');
		case 'BecameRenowned':
			return matchWave4ObjectEvent(state, ev, 'becameRenowned', 'Renown Trigger', undefined, ev.amount);
		// --- End Track P12 ---
		// --- Track P13 & P15 ---
		case 'DoorUnlocked':
			return matchDoorUnlocked(state, ev);
		case 'RoomFullyUnlocked':
			return matchRoomFullyUnlocked(state, ev);
		case 'RingTempted': {
			const bearerObj = ev.ringBearerId ? permanentById(state, ev.ringBearerId)?.obj : undefined;
			return matchP13PlayerEvent(
				state,
				'ringTempted',
				ev.playerId,
				'The Ring Tempts You Trigger',
				ev.ringLevel,
				bearerObj
			);
		}
		case 'DungeonRoomEntered':
			return matchP13PlayerEvent(state, 'dungeonRoomEntered', ev.playerId, 'Venture Trigger');
		case 'DungeonCompleted':
			return matchP13PlayerEvent(state, 'dungeonCompleted', ev.playerId, 'Dungeon Completed Trigger');
		case 'TookInitiative':
			return matchP13PlayerEvent(state, 'tookInitiative', ev.playerId, 'Initiative Trigger');
		// --- End Track P13 & P15 ---
		// --- Track P16b & P18a ---
		case 'Mutated':
			return matchMutated(state, ev);
		case 'SoulbondPaired':
			return matchSoulbondPaired(state, ev);
		case 'HauntedCreatureDied':
			return matchHauntedCreatureDied(state, ev);
		case 'DayNightChanged':
			return matchDayNightChanged(state, ev);
		case 'FacedDilemma':
			return matchP13PlayerEvent(state, 'facedDilemma', ev.playerId, 'Dilemma Trigger');
		case 'LifeLost':
			return matchLifeLost(state, ev);
		case 'ExhaustActivated':
			return matchExhaustActivated(state, ev);
		case 'Unattached':
			return matchUnattached(state, ev);
		case 'PhasedIn':
			return matchPhasedIn(state, ev);
		case 'CollectedEvidence':
			return matchP13PlayerEvent(
				state,
				'collectEvidence',
				ev.playerId,
				'Collect Evidence Trigger',
				ev.totalManaValue ?? ev.amount
			);
		case 'LandPlayed':
			return matchLandPlayed(state, ev);
		case 'PlayerTargeted':
			return matchPlayerTargeted(state, ev);
		// --- End Track P16b & P18a ---
		// --- Track P19b ---
		case 'ManaAddedByLandAbility':
			return matchManaAddedByLandAbility(state, ev);
		case 'LibrarySearched':
			return matchLibrarySearched(state, ev);
		case 'PlayerLostGame':
			return matchPlayerLostGame(state, ev);
		case 'CoinFlipped':
			return matchCoinFlipped(state, ev);
		case 'DieRolled':
			return matchDieRolled(state, ev);
		case 'EnergyGained':
			return matchEnergyGained(state, ev);
		case 'Proliferated':
			return matchProliferated(state, ev);
		case 'Evolved':
			return matchEvolved(state, ev);
		case 'CrewedVehicle':
			return matchCrewedVehicle(state, ev);
		// --- End Track P19b ---
		// --- Track P22b ---
		case 'AbilityActivated':
		case 'PlayersFinishedVoting':
		case 'Clash':
		case 'LibraryShuffled':
		case 'SpellCountered':
		case 'SagaChapterResolved':
		case 'SaddledMount':
			dispatchP22bTriggerEvent(state, ev, {
				sources,
				abilitiesFor,
				objectMatches,
				filterMatches,
				battlefieldSubject,
				printedSubject,
				viewerOf,
				record
			});
			return;
		// --- End Track P22b ---
		// --- Wave 9 ---
		case 'TokenCreated':
		case 'GiftGiven':
		case 'AttackTriggered':
			dispatchWave9TriggerEvent(state, ev, {
				sources,
				abilitiesFor,
				objectMatches,
				filterMatches,
				battlefieldSubject,
				printedSubject,
				viewerOf,
				record
			});
			return;
		// --- End Wave 9 ---
	}
}

// --- Track P16b & P18a ---
/**
 * CR 603.8: Checks all battlefield permanents for state-triggered abilities whose state condition
 * holds and that do not already have an instance on the stack or pending queue. Returns the number
 * of state triggers queued.
 */
export function checkStateTriggers(state: GameState): number {
	return withStableLayerInputs(state, () => {
		const ready = collectReadyStateTriggers(
			state,
			peekPendingTriggers(state),
			(st, cond, cid, sid) => evaluateCondition(st, cond, cid, sid),
			getTriggerHost()?.canExecute
		);
		for (const item of ready) {
			const src: Source = {
				obj: item.perm,
				card: item.card,
				faceIndex: item.faceIndex,
				controllerId: item.controllerId,
				zone: 'battlefield'
			};
			record(state, src, item.ability, 'stateTriggered', {
				label: 'State Trigger'
			});
		}
		return ready.length;
	});
}

function matchesTargetingSourceFilter(
	state: GameState,
	stackItemId: string | undefined,
	by: 'spell' | 'ability',
	controllerId: string,
	filter: ObjectFilter,
	source: Source
): boolean {
	const stk = stackItemId ? state.stack.find((s) => s.id === stackItemId) : undefined;
	if (!stk) return false;
	if (by === 'spell' || stk.kind === 'spell') {
		const synthSpell = makeSynthCardInstance(
			stk.sourceInstanceId || stk.id,
			stk.card,
			controllerId,
			'stack'
		);
		return matchesObjectFilter(synthSpell, filter, {
			state,
			controllerId: source.controllerId,
			source: source.obj,
			stackItem: stk,
			zone: 'stack'
		});
	}
	const foundPerm = stk.sourceInstanceId ? permanentById(state, stk.sourceInstanceId) : null;
	if (foundPerm) {
		return matchesObjectFilter(foundPerm.obj, filter, {
			state,
			controllerId: source.controllerId,
			source: source.obj,
			stackItem: stk
		});
	}
	const synthSrc = makeSynthCardInstance(
		stk.sourceInstanceId || stk.id,
		stk.card,
		controllerId,
		'battlefield'
	);
	return matchesObjectFilter(synthSrc, filter, {
		state,
		controllerId: source.controllerId,
		source: source.obj,
		stackItem: stk,
		zone: 'stack'
	});
}

function matchMutated(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'Mutated' }>
): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(
				ev.object,
				ev.object.copiableCard ?? ev.object.card,
				ev.playerId,
				false,
				undefined,
				undefined,
				undefined,
				false,
				false,
				{ state }
			);
	for (const source of sources(state, 'mutates')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'mutates')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'mutates',
							object: found?.obj ?? ev.object
						})
					: 1;
			record(state, source, ability, 'mutates', {
				label: 'Mutate Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				amount: ev.mutateCount,
				times
			});
		}
	}
}

function matchSoulbondPaired(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'SoulbondPaired' }>
): void {
	const foundPrimary = permanentById(state, ev.objectId);
	const foundPartner = permanentById(state, ev.partnerId);
	const subjPrimary = foundPrimary
		? battlefieldSubject(state, foundPrimary.obj, foundPrimary.controllerId)
		: printedSubject(ev.object, ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	const subjPartner = foundPartner
		? battlefieldSubject(state, foundPartner.obj, foundPartner.controllerId)
		: printedSubject(ev.partner, ev.partner.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });

	for (const source of sources(state, 'soulbondPaired')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'soulbondPaired')) {
			let matchedPartnerObj: CardInstance | undefined;
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.object === 'self') {
					if (source.obj.instanceId === ev.objectId) {
						matchedPartnerObj = foundPartner?.obj ?? ev.partner;
						return true;
					}
					if (source.obj.instanceId === ev.partnerId) {
						matchedPartnerObj = foundPrimary?.obj ?? ev.object;
						return true;
					}
					return false;
				}
				if (a.filter.object !== undefined) {
					if (objectMatches(a.filter, subjPrimary, source)) {
						matchedPartnerObj = foundPartner?.obj ?? ev.partner;
						return true;
					}
					if (objectMatches(a.filter, subjPartner, source)) {
						matchedPartnerObj = foundPrimary?.obj ?? ev.object;
						return true;
					}
					return false;
				}
				matchedPartnerObj = foundPartner?.obj ?? ev.partner;
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'soulbondPaired',
							object: source.obj
						})
					: 1;
			record(state, source, ability, 'soulbondPaired', {
				label: 'Soulbond Trigger',
				eventObject: matchedPartnerObj,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}

function matchHauntedCreatureDied(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'HauntedCreatureDied' }>
): void {
	for (const source of sources(state, 'hauntedCreatureDies')) {
		if (source.zone !== 'exile' || source.obj.instanceId !== ev.haunterId) continue;
		for (const { ability, alts } of abilitiesFor(state, source, 'hauntedCreatureDies')) {
			if (alts.length === 0) continue;
			const eventLki = ev.lki
				? {
						controllerId: ev.lki.controllerId,
						...(ev.lki.power !== undefined ? { power: ev.lki.power } : {}),
						...(ev.lki.toughness !== undefined ? { toughness: ev.lki.toughness } : {}),
						...(ev.lki.counters ? { counters: { ...ev.lki.counters } } : {})
					}
				: undefined;
			record(state, source, ability, 'hauntedCreatureDies', {
				label: `${source.card.name} — Haunt`,
				eventObject: ev.hauntedObject,
				...(eventLki ? { eventLki } : {}),
				times: 1
			});
		}
	}
}

function matchDayNightChanged(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'DayNightChanged' }>
): void {
	for (const source of sources(state, 'dayNightChanged')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'dayNightChanged')) {
			const alt = alts.find((a) => {
				const dir = a.filter.dayNightDirection ?? 'any';
				if (dir === 'toDay') return ev.current === 'day';
				if (dir === 'toNight') return ev.current === 'night';
				if (dir === 'dayNightFlip') {
					return (
						(ev.previous === 'day' && ev.current === 'night') ||
						(ev.previous === 'night' && ev.current === 'day')
					);
				}
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'dayNightChanged', {
				label: ev.current === 'day' ? 'Daybreak' : 'Nightfall'
			});
		}
	}
}

function matchLifeLost(state: GameState, ev: Extract<GameEvent, { kind: 'LifeLost' }>): void {
	if (ev.amount <= 0) return;
	// --- Track P19b ---
	const loser = state.players.find((p) => p.playerId === ev.playerId);
	const lossOrdinal = loser ? (loser.lifeLossEventsThisTurn = (loser.lifeLossEventsThisTurn ?? 0) + 1) : 1;
	const activePlayerId = state.players[state.activePlayerIndex]?.playerId;
	const ownTurnOrdinal =
		loser && loser.playerId === activePlayerId
			? (loser.lifeLossEventsOnOwnTurn = (loser.lifeLossEventsOnOwnTurn ?? 0) + 1)
			: 0;
	// --- End Track P19b ---
	for (const source of sources(state, 'loseLife')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'loseLife')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P19b ---
				const ordForFirst = a.filter.duringTurn === 'eventPlayer' ? ownTurnOrdinal : lossOrdinal;
				if (a.filter.firstTimeEachTurn && ordForFirst !== 1) return false;
				if (a.filter.nthEventThisTurn !== undefined && lossOrdinal !== a.filter.nthEventThisTurn) {
					return false;
				}
				// --- End Track P19b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			if (alt.filter.oneOrMore) {
				const ch = channel(state);
				if (isResolutionPaused(state) || ch.deferFlush > 0) {
					const batchSet = (ch.zoneBatchTriggeredKeys ??= new Set());
					const bk = `loseLife:${source.obj.instanceId}:${source.zone}:${source.faceIndex ?? 0}:${ability.abilityIndex}`;
					if (batchSet.has(bk)) continue;
					batchSet.add(bk);
				}
			}
			record(state, source, ability, 'loseLife', {
				label: 'Life Loss Trigger',
				amount: ev.amount,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}

function matchExhaustActivated(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'ExhaustActivated' }>
): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	for (const source of sources(state, 'exhaustActivated')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'exhaustActivated')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'exhaustActivated', {
				label: 'Exhaust Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}

function matchUnattached(state: GameState, ev: Extract<GameEvent, { kind: 'Unattached' }>): void {
	const found = permanentById(state, ev.attachmentId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.attachment, ev.attachment.copiableCard ?? ev.attachment.card, ev.attachment.controllerId, false, undefined, undefined, undefined, false, false, { state });
	for (const source of sources(state, 'unattached')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'unattached')) {
			const alt = alts.find((a) => objectMatches(a.filter, subject, source));
			if (!alt) continue;
			record(state, source, ability, 'unattached', {
				label: 'Unattached Trigger',
				eventObject: ev.host ?? (found?.obj ?? ev.attachment)
			});
		}
	}
}

function matchPhasedIn(state: GameState, ev: Extract<GameEvent, { kind: 'PhasedIn' }>): void {
	const found = permanentById(state, ev.objectId);
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	for (const source of sources(state, 'phasedIn')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'phasedIn')) {
			const alt = alts.find((a) => objectMatches(a.filter, subject, source));
			if (!alt) continue;
			record(state, source, ability, 'phasedIn', {
				label: 'Phase In Trigger',
				eventObject: found.obj
			});
		}
	}
}

function matchLandPlayed(state: GameState, ev: Extract<GameEvent, { kind: 'LandPlayed' }>): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	for (const source of sources(state, 'landPlayed')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'landPlayed')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P19b ---
				if (a.filter.castFromZone !== undefined && ev.fromZone !== a.filter.castFromZone) {
					return false;
				}
				if (a.filter.castFromNotHand && (!ev.fromZone || ev.fromZone === 'hand')) {
					return false;
				}
				// --- End Track P19b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'landPlayed', {
				label: 'Land Played Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}

function matchPlayerTargeted(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'PlayerTargeted' }>
): void {
	for (const source of sources(state, 'becomesTarget')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becomesTarget')) {
			const alt = alts.find((a) => {
				if (!a.filter.targetPlayer) return false;
				if (a.filter.targetPlayer === 'you' && ev.targetPlayerId !== source.controllerId) {
					return false;
				}
				if (a.filter.targetPlayer === 'opponent' && ev.targetPlayerId === source.controllerId) {
					return false;
				}
				if (a.filter.targetedBy !== 'spellOrAbility' && a.filter.targetedBy !== ev.by) return false;
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.controllerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.controllerId === source.controllerId) return false;
				if (
					a.filter.targetingSourceFilter &&
					!matchesTargetingSourceFilter(
						state,
						ev.stackItemId,
						ev.by,
						ev.controllerId,
						a.filter.targetingSourceFilter,
						source
					)
				) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'becomesTarget', {
				label: 'Targeted',
				targetStackItemId: ev.stackItemId,
				eventPlayerId: ev.controllerId,
				eventPlayer: ev.controllerId
			});
		}
	}
}
// --- End Track P16b & P18a ---

// --- Track P19b ---
function matchManaAddedByLandAbility(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'ManaAddedByLandAbility' }>
): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId, false, undefined, ev.object.tapped, undefined, false, false, { state });
	for (const source of sources(state, 'manaAddedByLandAbility')) {
		const srcChosenColor = source.chosenColor ?? source.obj.chosenColor;
		for (const { ability, alts } of abilitiesFor(state, source, 'manaAddedByLandAbility')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (!matchesManaColorEventFilterP19b(a.filter, ev.producedColors, srcChosenColor)) {
					return false;
				}
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'manaAddedByLandAbility', {
				label: 'Mana Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				lastTappedManaColors: ev.producedColors
			});
		}
	}
}

function matchLibrarySearched(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'LibrarySearched' }>
): void {
	for (const source of sources(state, 'librarySearched')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'librarySearched')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'librarySearched', {
				label: 'Library Search Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}

function matchPlayerLostGame(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'PlayerLostGame' }>
): void {
	for (const source of sources(state, 'playerLostGame')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'playerLostGame')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'playerLostGame', {
				label: 'Player Lost Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}

function matchCoinFlipped(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'CoinFlipped' }>
): void {
	for (const source of sources(state, 'coinFlipped')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'coinFlipped')) {
			const flips = ev.flips ?? 1;
			const wins = ev.wins ?? (ev.won ? 1 : 0);
			const losses = Math.max(0, flips - wins);
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.wonCoinFlip === true && !ev.won) return false;
				if (a.filter.wonCoinFlip === false && losses <= 0) return false;
				return true;
			});
			if (!alt) continue;
			const baseTimes = alt.filter.oneOrMore
				? 1
				: alt.filter.wonCoinFlip === true
					? Math.max(1, wins)
					: alt.filter.wonCoinFlip === false
						? Math.max(1, losses)
						: Math.max(1, flips);
			const mult =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event: 'coinFlipped' })
					: 1;
			record(state, source, ability, 'coinFlipped', {
				label:
					alt.filter.wonCoinFlip === true
						? 'Coin Flip Won'
						: alt.filter.wonCoinFlip === false
							? 'Coin Flip Lost'
							: 'Coin Flip Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times: baseTimes * mult
			});
		}
	}
}

function matchDieRolled(state: GameState, ev: Extract<GameEvent, { kind: 'DieRolled' }>): void {
	for (const source of sources(state, 'dieRolled')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'dieRolled')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.dieRollMin !== undefined && ev.result < a.filter.dieRollMin) return false;
				if (a.filter.dieRollValues?.length && !a.filter.dieRollValues.includes(ev.result)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			const baseTimes = alt.filter.oneOrMore ? 1 : Math.max(1, ev.count ?? 1);
			const mult =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event: 'dieRolled' })
					: 1;
			record(state, source, ability, 'dieRolled', {
				label: 'Die Roll Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				amount: ev.result,
				times: baseTimes * mult
			});
		}
	}
}

function matchEnergyGained(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'EnergyGained' }>
): void {
	if (ev.amount <= 0) return;
	for (const source of sources(state, 'energyGained')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'energyGained')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'energyGained', {
				label: 'Energy Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				amount: ev.amount
			});
		}
	}
}

function matchProliferated(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'Proliferated' }>
): void {
	for (const source of sources(state, 'proliferated')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'proliferated')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'proliferated', {
				label: 'Proliferate Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}

function matchEvolved(state: GameState, ev: Extract<GameEvent, { kind: 'Evolved' }>): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	for (const source of sources(state, 'evolved')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'evolved')) {
			const alt = alts.find((a) => objectMatches(a.filter, subject, source));
			if (!alt) continue;
			record(state, source, ability, 'evolved', {
				label: 'Evolve Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}

function matchCrewedVehicle(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'CrewedVehicle' }>
): void {
	const found = permanentById(state, ev.creatureId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.creature, ev.creature.copiableCard ?? ev.creature.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	const activePlayerId = state.players[state.activePlayerIndex]?.playerId;
	for (const source of sources(state, 'crewedVehicle')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'crewedVehicle')) {
			const alt = alts.find((a) => {
				if (a.filter.duringPhase === 'main' && state.phase !== 'main1' && state.phase !== 'main2') {
					return false;
				}
				if (a.filter.duringTurn === 'your' && activePlayerId !== source.controllerId) {
					return false;
				}
				return objectMatches(a.filter, subject, source);
			});
			if (!alt) continue;
			record(state, source, ability, 'crewedVehicle', {
				label: 'Crew Trigger',
				eventObject: found?.obj ?? ev.creature,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId
			});
		}
	}
}
// --- End Track P19b ---

// --- Track P13 & P15 ---
function matchDoorUnlocked(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'DoorUnlocked' }>
): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	for (const source of sources(state, 'doorUnlocked')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'doorUnlocked')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.thisDoorFaceIndex !== undefined) {
					if (source.obj.instanceId !== ev.objectId) return false;
					const wantFace =
						a.filter.thisDoorFaceIndex === -1
							? (source.faceIndex ?? 0)
							: a.filter.thisDoorFaceIndex;
					if (ev.faceIndex !== wantFace) return false;
				}
				if (a.filter.object === 'self') {
					if (source.obj.instanceId !== ev.objectId) return false;
					// CR 709.5h: "When you unlock this door" only triggers for the specific unlocked half.
					if (
						a.filter.thisDoorFaceIndex === undefined &&
						source.faceIndex !== undefined &&
						source.faceIndex !== ev.faceIndex
					) {
						return false;
					}
					return true;
				}
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'doorUnlocked',
							object: found?.obj ?? ev.object
						})
					: 1;
			record(state, source, ability, 'doorUnlocked', {
				label: 'Door Unlocked Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}

function matchRoomFullyUnlocked(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'RoomFullyUnlocked' }>
): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	for (const source of sources(state, 'roomFullyUnlocked')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'roomFullyUnlocked')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'roomFullyUnlocked',
							object: found?.obj ?? ev.object
						})
					: 1;
			record(state, source, ability, 'roomFullyUnlocked', {
				label: 'Room Fully Unlocked Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}

function matchP13PlayerEvent(
	state: GameState,
	event:
		| 'ringTempted'
		| 'dungeonRoomEntered'
		| 'dungeonCompleted'
		| 'tookInitiative'
		| 'facedDilemma'
		| 'collectEvidence',
	playerId: string,
	label: string,
	amountVal?: number,
	eventObj?: CardInstance
): void {
	for (const source of sources(state, event)) {
		for (const { ability, alts } of abilitiesFor(state, source, event)) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && playerId !== source.controllerId) return false;
				if (rel === 'opponent' && playerId === source.controllerId) return false;
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event })
					: 1;
			record(state, source, ability, event, {
				label,
				eventPlayer: playerId,
				eventPlayerId: playerId,
				...(eventObj ? { eventObject: eventObj } : {}),
				...(amountVal !== undefined ? { amount: amountVal } : {}),
				times
			});
		}
	}
}
// --- End Track P13 & P15 ---

// --- Track P12 ---
function matchWave4ObjectEvent(
	state: GameState,
	ev: { objectId: string; object: CardInstance; controllerId: string },
	event: 'classLevelGained' | 'caseSolved' | 'becameRenowned',
	label: string,
	classLevel?: number,
	amountVal?: number
): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.controllerId);
	for (const source of sources(state, event)) {
		for (const { ability, alts } of abilitiesFor(state, source, event)) {
			const alt = alts.find(
				(a) =>
					(a.filter.classLevel === undefined || a.filter.classLevel === classLevel) &&
					objectMatches(a.filter, subject, source)
			);
			if (alt) {
				record(state, source, ability, event, {
					label,
					eventObject: found?.obj ?? ev.object,
					eventPlayer: ev.controllerId,
					...(amountVal !== undefined ? { amount: amountVal } : {})
				});
			}
		}
	}
}
// --- End Track P12 ---

// --- Track P10 ---
function matchUnblockedAttackers(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'UnblockedAttackers' }>
): void {
	if (ev.attackerIds.length === 0) return;
	const attackers = ev.attackerIds
		.map((id) => permanentById(state, id))
		.filter((a): a is NonNullable<typeof a> => Boolean(a))
		.map((a) => battlefieldSubject(state, a.obj, a.controllerId));
	if (attackers.length === 0) return;
	const attackerDefenderId = (id: string): string | undefined =>
		state.combat.attackers.find((a) => a.attackerInstanceId === id)?.defenderPlayerId;

	const atkControllerId = attackers[0].controllerId;
	for (const source of sources(state, 'attackedAndUnblocked')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'attackedAndUnblocked')) {
			for (const alt of alts) {
				const f = alt.filter;
				if (f.player) {
					const rel = f.player.relation ?? 'any';
					if (rel === 'you' && atkControllerId !== source.controllerId) continue;
					if (rel === 'opponent' && atkControllerId === source.controllerId) continue;
				}
				const matchingBase =
					f.object === undefined ? attackers : attackers.filter((s) => objectMatches(f, s, source));
				const matching =
					f.attackedTarget === 'you'
						? matchingBase.filter((s) => {
								const entry = state.combat.attackers.find((a) => a.attackerInstanceId === s.obj.instanceId);
								return entry && !entry.defenderPlaneswalkerId && !entry.defenderBattleId && entry.defenderPlayerId === source.controllerId;
							})
						: matchingBase;
				if (matching.length === 0) continue;
				if (f.object === 'self' || f.oneOrMore || f.object === undefined) {
					const defendingPlayerId =
						f.object === 'self'
							? attackerDefenderId(source.obj.instanceId)
							: matching.length === 1
								? attackerDefenderId(matching[0].obj.instanceId)
								: undefined;
					const times =
						source.zone === 'battlefield'
							? triggerMultiplier(state, source.obj, source.controllerId, {
									event: 'attackedAndUnblocked',
									attackers: matching.map((s) => s.obj)
								})
							: 1;
					record(state, source, ability, 'attackedAndUnblocked', {
						label: ability.text || 'Unblocked Trigger',
						times,
						...(matching.length === 1 ? { eventObject: matching[0].obj } : {}),
						...(defendingPlayerId
							? { defendingPlayerId, eventPlayerId: defendingPlayerId, eventPlayer: defendingPlayerId }
							: {}),
						...(f.oneOrMore ? { amount: matching.length } : {})
					});
				} else {
					for (const s of matching) {
						const defendingPlayerId = attackerDefenderId(s.obj.instanceId);
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attackedAndUnblocked',
										object: s.obj,
										attackers: [s.obj]
									})
								: 1;
						record(state, source, ability, 'attackedAndUnblocked', {
							label: ability.text || 'Unblocked Trigger',
							eventObject: s.obj,
							...(defendingPlayerId
								? { defendingPlayerId, eventPlayerId: defendingPlayerId, eventPlayer: defendingPlayerId }
								: {}),
							times
						});
					}
				}
				break;
			}
		}
	}
	// --- Track P18a: Layer 6 granted unblocked-attacker keywords (Frenzy N, CR 702.68a–b) ---
	if (boardCanGrantTriggerKeyword(state, 'attackedAndUnblocked', attackers.map((s) => s.obj))) {
		for (const atkSubj of attackers) {
			const defendingPlayerId = attackerDefenderId(atkSubj.obj.instanceId);
			emitGrantedTriggerKeywords(
				state,
				atkSubj.obj,
				atkSubj.controllerId,
				'attackedAndUnblocked',
				(rt) =>
					alternatives(rt.trigger).some(
						(a) => a.event === 'attackedAndUnblocked' && a.filter.object === 'self'
					),
				(rt, times) => ({
					label: rt.text || 'Frenzy Trigger',
					times,
					eventObject: atkSubj.obj,
					...(defendingPlayerId
						? { defendingPlayerId, eventPlayerId: defendingPlayerId, eventPlayer: defendingPlayerId }
						: {})
				}),
				(perm) =>
					triggerMultiplier(state, perm, atkSubj.controllerId, {
						event: 'attackedAndUnblocked',
						object: perm,
						attackers: [perm]
					})
			);
		}
	}
	// --- End Track P18a ---
}

function matchBecomesUntapped(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'BecomesUntapped' }>
): void {
	const found = permanentById(state, ev.objectId);
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	for (const source of sources(state, 'becomesUntapped')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becomesUntapped')) {
			const alt = alts.find((a) => objectMatches(a.filter, subject, source));
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'becomesUntapped',
							object: found.obj
						})
					: 1;
			record(state, source, ability, 'becomesUntapped', {
				label: 'Untap Trigger',
				eventObject: found.obj,
				eventPlayer: found.controllerId,
				times
			});
		}
	}
}

function matchScried(state: GameState, ev: Extract<GameEvent, { kind: 'Scried' }>): void {
	if (ev.amount <= 0) return;
	for (const source of sources(state, 'scry')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'scry')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event: 'scry' })
					: 1;
			record(state, source, ability, 'scry', {
				label: 'Scry Trigger',
				amount: ev.amount,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}

function matchCrimeCommitted(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'CrimeCommitted' }>
): void {
	for (const source of sources(state, 'committedCrime')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'committedCrime')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event: 'committedCrime' })
					: 1;
			record(state, source, ability, 'committedCrime', {
				label: 'Crime Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}

function matchExploited(state: GameState, ev: Extract<GameEvent, { kind: 'Exploited' }>): void {
	const foundSource = permanentById(state, ev.exploiterId);
	const exploiterObj = foundSource?.obj ?? ev.exploited;
	const sacLki = ev.exploitedLki;
	const exploiterSubject = foundSource
		? battlefieldSubject(state, foundSource.obj, foundSource.controllerId)
		: sacLki && ev.exploiterId === ev.exploitedId
			? printedSubject(
					ev.exploited,
					sacLki.card,
					sacLki.controllerId,
					sacLki.hasAllCreatureTypes,
					sacLki.typeLine,
					sacLki.tapped,
					undefined,
					Boolean(sacLki.saddled),
					Boolean(sacLki.monstrous),
					{ state, power: sacLki.power, toughness: sacLki.toughness }
				)
			: printedSubject(exploiterObj, exploiterObj.copiableCard ?? exploiterObj.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	const candidateSources = [...sources(state, 'exploited')];
	// CR 702.110b: If the exploiting creature sacrificed itself, it left the battlefield right before
	// `Exploited` fired, so include its LKI battlefield snapshot as a candidate trigger source.
	if (!foundSource && ev.exploiterId === ev.exploitedId && sacLki) {
		candidateSources.push({
			obj: ev.exploited,
			card: sacLki.card,
			controllerId: sacLki.controllerId,
			zone: 'battlefield',
			faceIndex: sacLki.activeFaceIndex,
			counters: sacLki.counters
		});
	}
	for (const source of candidateSources) {
		for (const { ability, alts } of abilitiesFor(state, source, 'exploited')) {
			const alt = alts.find((a) => {
				if (a.filter.player) {
					const rel = a.filter.player.relation ?? 'any';
					if (rel === 'you' && ev.playerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				}
				if (a.filter.object !== undefined && !objectMatches(a.filter, exploiterSubject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'exploited',
							object: exploiterObj
						})
					: 1;
			record(state, source, ability, 'exploited', {
				label: 'Exploit Trigger',
				eventObject: ev.exploited,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				...(sacLki
					? {
							eventLki: {
								controllerId: sacLki.controllerId,
								...(sacLki.power !== undefined ? { power: sacLki.power } : {}),
								...(sacLki.toughness !== undefined ? { toughness: sacLki.toughness } : {}),
								...(sacLki.counters ? { counters: sacLki.counters } : {})
							}
						}
					: {}),
				times
			});
		}
	}
}

function matchManaExpended(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'ManaExpended' }>
): void {
	for (const source of sources(state, 'expended')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'expended')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'you';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.expendThreshold !== undefined) {
					const thresh = a.filter.expendThreshold;
					if (!(ev.previousTotal < thresh && ev.newTotal >= thresh)) return false;
				}
				return true;
			});
			if (!alt) continue;
			const thresh = alt.filter.expendThreshold ?? ev.newTotal;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event: 'expended' })
					: 1;
			record(state, source, ability, 'expended', {
				label: `Expend ${thresh}`,
				amount: thresh,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}

function matchSacrificed(state: GameState, ev: Extract<GameEvent, { kind: 'Sacrificed' }>): void {
	const lki = ev.lki;
	const subject = lki
		? printedSubject(
				ev.object,
				lki.card,
				lki.controllerId,
				lki.hasAllCreatureTypes,
				lki.typeLine,
				lki.tapped,
				undefined,
				Boolean(lki.saddled),
				Boolean(lki.monstrous),
				{ state, power: lki.power, toughness: lki.toughness }
			)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	for (const source of sources(state, 'sacrificed')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'sacrificed')) {
			const alt = alts.find((a) => {
				if (a.filter.player) {
					const rel = a.filter.player.relation ?? 'any';
					if (rel === 'you' && ev.playerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				}
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'sacrificed',
							object: ev.object
						})
					: 1;
			record(state, source, ability, 'sacrificed', {
				label: 'Sacrifice Trigger',
				eventObject: ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				...(lki
					? {
							eventLki: {
								controllerId: lki.controllerId,
								...(lki.power !== undefined ? { power: lki.power } : {}),
								...(lki.toughness !== undefined ? { toughness: lki.toughness } : {}),
								...(lki.counters ? { counters: lki.counters } : {})
							}
						}
					: {}),
				times
			});
		}
	}
}

function matchGraveyardLeaveBatch(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'GraveyardLeaveBatch' }>
): void {
	if (ev.objects.length === 0) return;
	const subjects = ev.objects.map((c) =>
		printedSubject(c, c.card, ev.ownerId, false, undefined, false, undefined, false, false, { state })
	);
	for (const source of sources(state, 'graveyardLeaveBatch')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'graveyardLeaveBatch')) {
			let matchedObjs: Subject[] = [];
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'you';
				if (rel === 'you' && ev.ownerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.ownerId === source.controllerId) return false;
				const matching =
					a.filter.object === undefined
						? subjects
						: subjects.filter((s) => objectMatches(a.filter, s, source));
				if (matching.length === 0) return false;
				matchedObjs = matching;
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'graveyardLeaveBatch',
							object: matchedObjs[0]?.obj
						})
					: 1;
			record(state, source, ability, 'graveyardLeaveBatch', {
				label: 'Leaves Graveyard Trigger',
				...(matchedObjs.length === 1 ? { eventObject: matchedObjs[0].obj } : {}),
				amount: matchedObjs.length,
				eventPlayer: ev.ownerId,
				eventPlayerId: ev.ownerId,
				times
			});
		}
	}
}

function matchDiscovered(state: GameState, ev: Extract<GameEvent, { kind: 'Discovered' }>): void {
	for (const source of sources(state, 'discover')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'discover')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event: 'discover' })
					: 1;
			record(state, source, ability, 'discover', {
				label: 'Discover Trigger',
				...(ev.hitCard ? { eventObject: ev.hitCard } : {}),
				amount: ev.n,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}

function matchForaged(state: GameState, ev: Extract<GameEvent, { kind: 'Foraged' }>): void {
	for (const source of sources(state, 'forage')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'forage')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, { event: 'forage' })
					: 1;
			record(state, source, ability, 'forage', {
				label: 'Forage Trigger',
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times
			});
		}
	}
}
// --- End Track P10 ---

// --- Track P4 ---
function matchExerted(state: GameState, ev: Extract<GameEvent, { kind: 'Exerted' }>): void {
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId);
	for (const source of sources(state, 'exert')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'exert')) {
			const alt = alts.find((a) => {
				if (a.filter.player) {
					const rel = a.filter.player.relation ?? 'any';
					if (rel === 'you' && ev.playerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				}
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) {
					return false;
				}
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'exert', {
				label: 'Exert Trigger',
				eventObject: found?.obj ?? ev.object,
				eventPlayer: ev.playerId,
				eventPlayerId: ev.playerId,
				times: 1
			});
		}
	}
}

// --- Track P5 ---
function matchAmassed(state: GameState, ev: Extract<GameEvent, { kind: 'Amassed' }>): void {
	for (const source of sources(state, 'amass')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'amass')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (
					a.filter.amassSubtype &&
					a.filter.amassSubtype.toLowerCase() !== ev.subtype.toLowerCase()
				) {
					return false;
				}
				return true;
			});
			if (alt) {
				record(state, source, ability, 'amass', {
					label: 'Amass Trigger',
					eventObject: ev.object,
					eventPlayer: ev.playerId,
					eventPlayerId: ev.playerId,
					amount: ev.amount
				});
			}
		}
	}
}

function matchManifestDread(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'ManifestDread' }>
): void {
	for (const source of sources(state, 'manifestDread')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'manifestDread')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (alt) {
				record(state, source, ability, 'manifestDread', {
					label: 'Manifest Dread Trigger',
					eventObject: ev.manifestedObject,
					eventPlayer: ev.playerId,
					eventPlayerId: ev.playerId
				});
			}
		}
	}
}

function matchBecameMonarch(state: GameState, ev: Extract<GameEvent, { kind: 'BecameMonarch' }>): void {
	for (const source of sources(state, 'becameMonarch')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becameMonarch')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (alt) {
				record(state, source, ability, 'becameMonarch', {
					label: 'Monarch Trigger',
					eventPlayer: ev.playerId,
					eventPlayerId: ev.playerId
				});
			}
		}
	}
}

function matchPlayerRelationEvent(
	state: GameState,
	event: 'investigate' | 'surveil',
	playerId: string,
	label: string,
	amount: number
): void {
	for (const source of sources(state, event)) {
		for (const { ability, alts } of abilitiesFor(state, source, event)) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && playerId !== source.controllerId) return false;
				if (rel === 'opponent' && playerId === source.controllerId) return false;
				return true;
			});
			if (alt) {
				record(state, source, ability, event, {
					label,
					amount,
					eventPlayer: playerId
				});
			}
		}
	}
}

function matchInvestigated(state: GameState, ev: Extract<GameEvent, { kind: 'Investigated' }>): void {
	if (ev.count <= 0) return;
	matchPlayerRelationEvent(state, 'investigate', ev.playerId, 'Investigate Trigger', ev.count);
}

function matchSurveilled(state: GameState, ev: Extract<GameEvent, { kind: 'Surveilled' }>): void {
	if (ev.count <= 0) return;
	matchPlayerRelationEvent(state, 'surveil', ev.playerId, 'Surveil Trigger', ev.count);
}

function matchGainLife(state: GameState, ev: Extract<GameEvent, { kind: 'GainLife' }>): void {
	if (ev.amount <= 0) return;
	// --- Track P19b ---
	const gainer = state.players.find((p) => p.playerId === ev.playerId);
	const gainOrdinal = gainer ? (gainer.lifeGainEventsThisTurn = (gainer.lifeGainEventsThisTurn ?? 0) + 1) : 1;
	// --- End Track P19b ---
	for (const source of sources(state, 'gainLife')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'gainLife')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				// --- Track P19b ---
				if (a.filter.firstTimeEachTurn && gainOrdinal !== 1) return false;
				if (a.filter.nthEventThisTurn !== undefined && gainOrdinal !== a.filter.nthEventThisTurn) {
					return false;
				}
				// --- End Track P19b ---
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
				) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (alt) {
				record(state, source, ability, 'gainLife', {
					label: 'Life Gain Trigger',
					amount: ev.amount,
					eventPlayer: ev.playerId
				});
			}
		}
	}
}

function matchCardDrawn(state: GameState, ev: Extract<GameEvent, { kind: 'CardDrawn' }>): void {
	const drawer = state.players.find((p) => p.playerId === ev.playerId);
	const drawnCount = drawer?.cardsDrawnThisTurn ?? 0;
	for (const source of sources(state, 'drawCard')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'drawCard')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (a.filter.nthThisTurn !== undefined && drawnCount !== a.filter.nthThisTurn) return false;
				// --- Track P22b ---
				if (a.filter.exceptFirstInDrawStep && ev.inOwnDrawStepOrdinal === 1) return false;
				// --- End Track P22b ---
				return true;
			});
			if (alt) {
				// --- Track P17a ---
				const times =
					source.zone === 'battlefield'
						? triggerMultiplier(state, source.obj, source.controllerId, {
								event: 'drawCard',
								playerId: ev.playerId,
								object: ev.object
							})
						: 1;
				// --- End Track P17a ---
				record(state, source, ability, 'drawCard', {
					label: 'Draw Trigger',
					eventObject: ev.object,
					eventPlayer: ev.playerId,
					amount: 1,
					times
				});
			}
		}
	}
}

function matchCardDiscarded(state: GameState, ev: Extract<GameEvent, { kind: 'CardDiscarded' }>): void {
	const subject = printedSubject(ev.object, ev.object.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
	const label = ev.reason === 'cycle' ? 'Cycle Trigger' : 'Discard Trigger';
	const matchEventKind = (kind: 'cycle' | 'discard', candidates: Source[]) => {
		for (const source of candidates) {
			for (const { ability, alts } of abilitiesFor(state, source, kind)) {
				const alt = alts.find((a) => {
					const rel = a.filter.player?.relation ?? 'any';
					if (rel === 'you' && ev.playerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
					// --- Track P9 ---
					if (a.filter.madnessExiled && !(ev.destZone === 'exile' && Boolean(ev.object.madnessOwnerId))) {
						return false;
					}
					// --- Track P16b ---
					if (
						a.filter.causedByOpponent &&
						!(ev.causeControllerId && ev.causeControllerId !== ev.playerId)
					) {
						return false;
					}
					if (
						!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.playerId)
					) {
						return false;
					}
					// --- End Track P16b ---
					return objectMatches(a.filter, subject, source);
				});
				if (!alt) continue;
				// --- Track P16b: batch "discard one or more [filter] cards" once per flush window ---
				if (alt.filter.oneOrMore) {
					const ch = channel(state);
					const batchSet = (ch.discardBatchTriggeredKeys ??= new Set());
					const batchKey = `${source.obj.instanceId}:${source.zone}:${source.faceIndex ?? 0}:${ability.abilityIndex}:${ev.playerId}`;
					if (batchSet.has(batchKey)) continue;
					batchSet.add(batchKey);
				}
				// --- End Track P16b ---
				const times =
					source.zone === 'battlefield'
						? triggerMultiplier(state, source.obj, source.controllerId, {
								event: kind,
								object: ev.object
							})
						: 1;
				record(state, source, ability, kind, {
					label,
					eventObject: ev.object,
					eventPlayer: ev.playerId,
					eventPlayerId: ev.playerId,
					times
				});
			}
		}
	};

	if (ev.reason === 'cycle') {
		const cycleCandidates = sources(state, 'cycle');
		// CR 702.29c: "When you cycle ~" triggers from whatever zone the card winds up in after cycling.
		for (const faceIndex of activeFacesForObject(ev.object, ev.object.card, ev.destZone, state)) {
			const objTriggers = triggersOf(ev.object.card, faceIndex);
			if (
				!cycleCandidates.some(
					(c) => c.obj.instanceId === ev.object.instanceId && (c.faceIndex ?? 0) === faceIndex
				) &&
				objTriggers.events.has('cycle') &&
				objTriggers.all.some((a) =>
					alternatives(a.trigger).some(
						(alt) => alt.event === 'cycle' && (alt.fromZone ?? a.trigger.fromZone) === 'any'
					)
				)
			) {
				cycleCandidates.push({
					obj: ev.object,
					card: ev.object.card,
					faceIndex,
					controllerId: ev.playerId,
					zone: ev.destZone
				});
			}
		}
		matchEventKind('cycle', cycleCandidates);
	}

	// --- Track P9 ---
	const discardCandidates = sources(state, 'discard');
	for (const faceIndex of activeFacesForObject(ev.object, ev.object.card, ev.destZone, state)) {
		const objTriggers = triggersOf(ev.object.card, faceIndex);
		if (
			!discardCandidates.some(
				(c) => c.obj.instanceId === ev.object.instanceId && (c.faceIndex ?? 0) === faceIndex
			) &&
			objTriggers.events.has('discard') &&
			objTriggers.all.some((a) =>
				alternatives(a.trigger).some(
					(alt) => alt.event === 'discard' && (alt.fromZone ?? a.trigger.fromZone) === 'any'
				)
			)
		) {
			discardCandidates.push({
				obj: ev.object,
				card: ev.object.card,
				faceIndex,
				controllerId: ev.object.madnessOwnerId ?? ev.playerId,
				zone: ev.destZone
			});
		}
	}
	matchEventKind('discard', discardCandidates);
}

function matchTransformed(state: GameState, ev: Extract<GameEvent, { kind: 'Transformed' }>): void {
	const found = permanentById(state, ev.objectId);
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	for (const source of sources(state, 'transforms')) {
		const viewer = viewerOf(source);
		for (const { ability, alts } of abilitiesFor(state, source, 'transforms')) {
			const alt = alts.find((a) => {
				if (!objectMatches(a.filter, subject, source)) return false;
				if (a.filter.toFaceFilter && !filterMatches(a.filter.toFaceFilter, subject, viewer)) return false;
				return true;
			});
			if (alt) {
				record(state, source, ability, 'transforms', {
					label: 'Transform Trigger',
					eventObject: found.obj,
					eventPlayer: found.controllerId
				});
			}
		}
	}
}

function matchObjectActionEvent(
	state: GameState,
	ev: { objectId: string; object: CardInstance; playerId: string },
	event: 'explore' | 'connive' | 'becomesCrewed' | 'becomesSaddled' | 'becameMonstrous',
	label: string,
	amount?: number
): void {
	const found = permanentById(state, ev.objectId);
	// CR 701.44c / CR 701.50b: use LKI printed characteristics & controller if the object left the battlefield.
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.playerId);
	for (const source of sources(state, event)) {
		for (const { ability, alts } of abilitiesFor(state, source, event)) {
			const alt = alts.find((a) => {
				// --- Track P19b ---
				if (event === 'becomesCrewed') {
					const crewOrd = (found?.obj ?? ev.object).crewedCountThisTurn ?? 1;
					if (a.filter.firstTimeEachTurn && crewOrd !== 1) return false;
					if (a.filter.nthEventThisTurn !== undefined && crewOrd !== a.filter.nthEventThisTurn) {
						return false;
					}
				}
				// --- End Track P19b ---
				return objectMatches(a.filter, subject, source);
			});
			if (alt) {
				record(state, source, ability, event, {
					label,
					eventObject: found?.obj ?? ev.object,
					eventPlayer: ev.playerId,
					...(amount !== undefined ? { amount } : {}),
					...(event === 'becameMonstrous' ? { isBecameMonstrous: true } : {})
				});
			}
		}
	}
}

function matchExileActionCardEvent(
	state: GameState,
	playerId: string,
	card: CardInstance,
	event: 'foretell' | 'plot',
	label: string,
	faceDown: boolean
): void {
	// CR 702.143a: A card exiled face down via Foretell has no characteristics; Plot exiles face up (CR 702.170a).
	const view = faceDown
		? null
		: resolveObjectFaces(card.card, instanceFaceOptions(card, 'exile'));
	const subject = faceDown
		? printedSubject(card, card.card, playerId, false, '', false, [], false)
		: printedSubject(card, card.card, playerId, false, view!.typeLine, false, view!.colors, false);
	for (const source of sources(state, event)) {
		for (const { ability, alts } of abilitiesFor(state, source, event)) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && playerId !== source.controllerId) return false;
				if (rel === 'opponent' && playerId === source.controllerId) return false;
				if (a.filter.object !== undefined && !objectMatches(a.filter, subject, source)) return false;
				return true;
			});
			if (alt) {
				record(state, source, ability, event, {
					label,
					eventObject: card,
					eventPlayer: playerId,
					eventPlayerId: playerId
				});
			}
		}
	}
}

function matchTurnedFaceUp(state: GameState, ev: Extract<GameEvent, { kind: 'TurnedFaceUp' }>): void {
	const found = permanentById(state, ev.objectId);
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	for (const source of sources(state, 'turnFaceUp')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'turnFaceUp')) {
			const alt = alts.find((a) => {
				if (a.filter.player) {
					const rel = a.filter.player.relation ?? 'any';
					if (rel === 'you' && ev.playerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				}
				return objectMatches(a.filter, subject, source);
			});
			if (alt) {
				record(state, source, ability, 'turnFaceUp', {
					label: 'Turned Face Up',
					eventObject: found.obj,
					eventPlayer: ev.playerId,
					...(ev.xValue !== undefined ? { amount: ev.xValue } : {})
				});
			}
		}
	}
}

function matchBecomesTapped(state: GameState, ev: Extract<GameEvent, { kind: 'BecomesTapped' }>): void {
	const found = permanentById(state, ev.objectId);
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	// --- Track P19b ---
	const tapActorId = resolveTapActorId(state, ev.actorId);
	// --- End Track P19b ---
	for (const source of sources(state, 'becomesTapped')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becomesTapped')) {
			const alt = alts.find((a) => {
				// --- Track P19b ---
				if (a.filter.tappedByPlayer === 'you' && tapActorId !== source.controllerId) return false;
				if (
					a.filter.tappedByPlayer === 'opponent' &&
					(!tapActorId || tapActorId === source.controllerId)
				) {
					return false;
				}
				// --- End Track P19b ---
				return objectMatches(a.filter, subject, source);
			});
			if (alt) {
				record(state, source, ability, 'becomesTapped', {
					label: 'Tap Trigger',
					eventObject: found.obj,
					eventPlayer: found.controllerId
				});
			}
		}
	}
}

function matchTappedForMana(state: GameState, ev: Extract<GameEvent, { kind: 'TappedForMana' }>): void {
	const found = permanentById(state, ev.objectId);
	// --- Track P19b: support sacrificed mana permanents (e.g. Treasure) and produced color filters ---
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(
				ev.object,
				ev.object.copiableCard ?? ev.object.card,
				ev.playerId,
				false,
				undefined,
				true,
				undefined,
				false,
				false,
				{ state }
			);
	for (const source of sources(state, 'tappedForMana')) {
		const srcChosenColor = source.chosenColor ?? source.obj.chosenColor;
		for (const { ability, alts } of abilitiesFor(state, source, 'tappedForMana')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				if (!matchesManaColorEventFilterP19b(a.filter, ev.producedColors, srcChosenColor)) {
					return false;
				}
				return objectMatches(a.filter, subject, source);
			});
			if (alt) {
				record(state, source, ability, 'tappedForMana', {
					label: 'Mana Trigger',
					eventObject: found?.obj ?? ev.object,
					eventPlayer: ev.playerId,
					eventPlayerId: ev.playerId,
					lastTappedManaColors: ev.producedColors
				});
			}
		}
	}
	// --- End Track P19b ---
}

function matchZoneChange(state: GameState, ev: Extract<GameEvent, { kind: 'ZoneChange' }>): void {
	const obj = ev.object;
	// --- Track P17a ---
	if (ev.to === 'exile') {
		applyPendingExileReplacementCounters(obj);
	}
	// --- End Track P17a ---
	if (ev.to === 'battlefield' && obj.phasedOut) return;
	// --- Track P19b ---
	recordP19bZoneChangeState(state, ev);
	const inCombatNow =
		state.combat.active ||
		state.phase === 'begin_combat' ||
		state.phase === 'declare_attackers' ||
		state.phase === 'declare_blockers' ||
		state.phase === 'first_strike_damage' ||
		state.phase === 'combat_damage' ||
		state.phase === 'end_combat';
	// --- End Track P19b ---
	const batchLki = ev.from === 'battlefield' ? channel(state).simultaneousLki : undefined;
	const objBatchInfo = batchLki?.get(obj);
	const subject: Subject =
		ev.to === 'battlefield'
			? battlefieldSubject(state, obj, ev.toPlayerId ?? obj.controllerId)
			: objBatchInfo
				? printedSubject(
						obj,
						objBatchInfo.card,
						objBatchInfo.controllerId,
						objBatchInfo.hasAllCreatureTypes,
						objBatchInfo.typeLine,
						objBatchInfo.tapped,
						objBatchInfo.colors,
						Boolean(objBatchInfo.saddled),
						Boolean(objBatchInfo.monstrous),
						// --- Track P7 ---
						{ state, power: objBatchInfo.power, toughness: objBatchInfo.toughness }
						// --- End Track P7 ---
					)
				: ev.lki
					? printedSubject(
							obj,
							ev.lki.card,
							ev.lki.controllerId,
							ev.lki.hasAllCreatureTypes,
							ev.lki.typeLine,
							ev.lki.tapped,
							undefined,
							Boolean(ev.lki.saddled),
							Boolean(ev.lki.monstrous),
							// --- Track P7 ---
							{ state, power: ev.lki.power, toughness: ev.lki.toughness }
							// --- End Track P7 ---
						)
					: printedSubject(
							obj,
							obj.card,
							obj.ownerId,
							false,
							undefined,
							undefined,
							undefined,
							false,
							false,
							// --- Track P7 ---
							{ state }
							// --- End Track P7 ---
						);
	// --- Track P16b: CR 603.6c "from anywhere" checks characteristics as the object exists in the destination zone ---
	// --- Track P22b ---
	if (ev.lki?.damagedByThisTurn?.length) {
		subject.damagedByThisTurn = ev.lki.damagedByThisTurn;
	}
	// --- End Track P22b ---
	const postMoveSubject: Subject = printedSubject(
		obj,
		obj.card,
		obj.ownerId,
		false,
		undefined,
		undefined,
		undefined,
		false,
		false,
		{ state }
	);
	// --- End Track P16b ---
	const enters = ev.to === 'battlefield';
	const label = (source: Source, alt: TriggerDef) => {
		const self = source.obj === obj;
		if (alt.filter.from === 'battlefield') return alt.filter.to === 'graveyard' ? 'Dies' : 'Leaves the Battlefield';
		if (!enters) return 'Zone Change';
		if (self) return 'ETB';
		const o = alt.filter.object;
		return typeof o === 'object' && o.types?.length === 1 && o.types[0] === 'Land' ? 'Landfall' : 'ETB Trigger';
	};
	const fits = (alt: TriggerDef) =>
		(alt.filter.from === undefined || alt.filter.from === ev.from) &&
		(alt.filter.fromZones === undefined || (ev.from !== null && alt.filter.fromZones.includes(ev.from))) &&
		// --- Track P16b ---
		(alt.filter.notFromZone === undefined || ev.from !== alt.filter.notFromZone) &&
		// --- Precon Bragos Spirit ---
		(alt.filter.notToZone === undefined || ev.to !== alt.filter.notToZone) &&
		// --- End Precon Bragos Spirit ---
		(!alt.filter.entersUntapped || (enters && !obj.tapped)) &&
		// --- End Track P16b ---
		// --- Track P19b ---
		(!alt.filter.duringStep || state.phase === alt.filter.duringStep) &&
		(!alt.filter.duringCombat || inCombatNow) &&
		// --- End Track P19b ---
		(alt.filter.to === undefined || alt.filter.to === ev.to) &&
		(alt.filter.from !== undefined || alt.filter.fromZones !== undefined || alt.filter.to !== undefined);
	let amount: number | undefined;
	const enteredPower = () => {
		if (!enters) return undefined;
		return (amount ??= subject.typeLine().includes('Creature') ? evaluatePermanent(state, obj).power : 0);
	};

	const candidates = sources(state, 'zoneChange');
	// CR 603.10a: an object leaving the battlefield checks its own leaves-the-battlefield abilities as
	// it last existed there. When multiple permanents leave simultaneously, all permanents in the batch
	// also look back to the state immediately before the simultaneous event.
	if (ev.from === 'battlefield') {
		if (batchLki) {
			for (const [peerPerm, info] of batchLki) {
				if (candidates.some((c) => c.obj === peerPerm)) continue;
				let pushedPeer = false;
				for (const faceIndex of activeFacesForObject(peerPerm, info.card, 'battlefield', state, {
					activeFaceIndex: info.activeFaceIndex,
					unlockedFaces: info.unlockedFaces
				})) {
					if (!triggersOf(info.card, faceIndex).events.has('zoneChange')) continue;
					candidates.push({
						obj: peerPerm,
						card: info.card,
						faceIndex,
						controllerId: info.controllerId,
						zone: 'battlefield',
						lostAllAbilities: info.lostAllAbilities,
						isLookBack: true,
						...(info.foretold ? { foretold: true } : {}),
						...(info.blitzed ? { blitzed: true } : {}),
						...(info.saddled ? { saddled: true } : {}),
						...(info.exerted ? { exerted: true } : {}),
						...(info.chosenSubType ? { chosenSubType: info.chosenSubType } : {}),
						...(info.chosenColor ? { chosenColor: info.chosenColor } : {}),
						// --- Track P11 ---
						...(info.chosenCardName ? { chosenCardName: info.chosenCardName } : {}),
						// --- End Track P11 ---
						...(info.monstrous ? { monstrous: true } : {}),
						// --- Track P7 ---
						...(info.wasCast ? { wasCast: true } : {}),
						...(info.castFromZone ? { castFromZone: info.castFromZone } : {}),
						// --- End Track P7 ---
						...(info.counters ? { counters: info.counters } : {}),
						// --- Track P10 ---
						...(pushedPeer
							? { includeTimedGrants: false }
							: info.grantedAbilityTexts
								? { grantedAbilityTexts: info.grantedAbilityTexts }
								: {})
						// --- End Track P10 ---
					});
					pushedPeer = true;
				}
				// --- Track P18a: Merged permanent underneath components LTB look-back (CR 731.2b / 603.10a) ---
				if (info.mergedComponents && info.mergedComponents.length > 1) {
					for (let cIdx = 1; cIdx < info.mergedComponents.length; cIdx++) {
						const mc = info.mergedComponents[cIdx]!;
						if (!triggersOf(mc, 0).events.has('zoneChange')) continue;
						candidates.push({
							obj: peerPerm,
							card: mc,
							faceIndex: 0,
							controllerId: info.controllerId,
							zone: 'battlefield',
							lostAllAbilities: info.lostAllAbilities,
							isLookBack: true,
							includeTimedGrants: false,
							...(info.counters ? { counters: info.counters } : {})
						});
					}
				}
				// --- End Track P18a ---
				// --- Track P10 ---
				if (!pushedPeer && info.grantedAbilityTexts?.length) {
					const qts = quotedTriggersForTexts(info.card.name, info.grantedAbilityTexts);
					if (qts.some((q) => alternatives(q.ability.trigger).some((a) => a.event === 'zoneChange'))) {
						candidates.push({
							obj: peerPerm,
							card: info.card,
							faceIndex: info.activeFaceIndex ?? info.unlockedFaces?.[0] ?? 0,
							controllerId: info.controllerId,
							zone: 'battlefield',
							lostAllAbilities: info.lostAllAbilities,
							isLookBack: true,
							skipInnate: true,
							...(info.foretold ? { foretold: true } : {}),
							...(info.blitzed ? { blitzed: true } : {}),
							...(info.saddled ? { saddled: true } : {}),
							...(info.exerted ? { exerted: true } : {}),
							...(info.chosenSubType ? { chosenSubType: info.chosenSubType } : {}),
							...(info.chosenColor ? { chosenColor: info.chosenColor } : {}),
							...(info.chosenCardName ? { chosenCardName: info.chosenCardName } : {}),
							...(info.monstrous ? { monstrous: true } : {}),
							...(info.wasCast ? { wasCast: true } : {}),
							...(info.castFromZone ? { castFromZone: info.castFromZone } : {}),
							...(info.counters ? { counters: info.counters } : {}),
							grantedAbilityTexts: info.grantedAbilityTexts
						});
					}
				}
				// --- End Track P10 ---
				// --- Track P11: LKI look-back for Layer 6 granted triggered abilities (CR 603.10a) ---
				for (const gt of info.grantedTriggers ?? []) {
					if (getTriggerHost()?.canExecute && !getTriggerHost()!.canExecute!(gt.runtimeTrigger)) continue;
					if (!alternatives(gt.runtimeTrigger.trigger).some((alt) => alt.event === 'zoneChange')) {
						continue;
					}
					candidates.push({
						obj: peerPerm,
						card: info.card,
						controllerId: info.controllerId,
						zone: 'battlefield',
						lostAllAbilities: false,
						isLookBack: true,
						grantedTrigger: gt,
						...(info.foretold ? { foretold: true } : {}),
						...(info.blitzed ? { blitzed: true } : {}),
						...(info.saddled ? { saddled: true } : {}),
						...(info.exerted ? { exerted: true } : {}),
						...(info.chosenSubType ? { chosenSubType: info.chosenSubType } : {}),
						...(info.chosenColor ? { chosenColor: info.chosenColor } : {}),
						...(info.chosenCardName ? { chosenCardName: info.chosenCardName } : {}),
						...(info.monstrous ? { monstrous: true } : {}),
						...(info.wasCast ? { wasCast: true } : {}),
						...(info.castFromZone ? { castFromZone: info.castFromZone } : {}),
						...(info.counters ? { counters: info.counters } : {})
					});
				}
				// --- End Track P11 ---
			}
		} else if (ev.lki) {
			let pushedSelf = false;
			for (const faceIndex of activeFacesForObject(obj, ev.lki.card, 'battlefield', state, {
				activeFaceIndex: ev.lki.activeFaceIndex,
				unlockedFaces: ev.lki.unlockedFaces
			})) {
				if (!triggersOf(ev.lki.card, faceIndex).events.has('zoneChange')) continue;
				candidates.push({
					obj,
					card: ev.lki.card,
					faceIndex,
					controllerId: ev.lki.controllerId,
					zone: 'battlefield',
					lostAllAbilities: ev.lki.lostAllAbilities,
					isLookBack: true,
					...(ev.lki.foretold ? { foretold: true } : {}),
					...(ev.lki.blitzed ? { blitzed: true } : {}),
					...(ev.lki.saddled ? { saddled: true } : {}),
					...(ev.lki.exerted ? { exerted: true } : {}),
					...(ev.lki.chosenSubType ? { chosenSubType: ev.lki.chosenSubType } : {}),
					...(ev.lki.chosenColor ? { chosenColor: ev.lki.chosenColor } : {}),
					...(ev.lki.monstrous ? { monstrous: true } : {}),
					...(ev.lki.counters ? { counters: ev.lki.counters } : {}),
					// --- Track P10 ---
					...(pushedSelf
						? { includeTimedGrants: false }
						: ev.lki.grantedAbilityTexts
							? { grantedAbilityTexts: ev.lki.grantedAbilityTexts }
							: {})
					// --- End Track P10 ---
				});
				pushedSelf = true;
			}
			// --- Track P18a: Merged permanent underneath components LTB look-back (CR 731.2b / 603.10a) ---
			if (ev.lki.mergedComponents && ev.lki.mergedComponents.length > 1) {
				for (let cIdx = 1; cIdx < ev.lki.mergedComponents.length; cIdx++) {
					const mc = ev.lki.mergedComponents[cIdx]!;
					if (!triggersOf(mc, 0).events.has('zoneChange')) continue;
					candidates.push({
						obj,
						card: mc,
						faceIndex: 0,
						controllerId: ev.lki.controllerId,
						zone: 'battlefield',
						lostAllAbilities: ev.lki.lostAllAbilities,
						isLookBack: true,
						includeTimedGrants: false,
						...(ev.lki.counters ? { counters: ev.lki.counters } : {})
					});
				}
			}
			// --- End Track P18a ---
			// --- Track P10 ---
			if (!pushedSelf && ev.lki.grantedAbilityTexts?.length) {
				const qts = quotedTriggersForTexts(ev.lki.card.name, ev.lki.grantedAbilityTexts);
				if (qts.some((q) => alternatives(q.ability.trigger).some((a) => a.event === 'zoneChange'))) {
					candidates.push({
						obj,
						card: ev.lki.card,
						faceIndex: ev.lki.activeFaceIndex ?? ev.lki.unlockedFaces?.[0] ?? 0,
						controllerId: ev.lki.controllerId,
						zone: 'battlefield',
						lostAllAbilities: ev.lki.lostAllAbilities,
						isLookBack: true,
						skipInnate: true,
						...(ev.lki.foretold ? { foretold: true } : {}),
						...(ev.lki.blitzed ? { blitzed: true } : {}),
						...(ev.lki.saddled ? { saddled: true } : {}),
						...(ev.lki.exerted ? { exerted: true } : {}),
						...(ev.lki.chosenSubType ? { chosenSubType: ev.lki.chosenSubType } : {}),
						...(ev.lki.chosenColor ? { chosenColor: ev.lki.chosenColor } : {}),
						...(ev.lki.monstrous ? { monstrous: true } : {}),
						...(ev.lki.counters ? { counters: ev.lki.counters } : {}),
						grantedAbilityTexts: ev.lki.grantedAbilityTexts
					});
				}
			}
			// --- End Track P10 ---
			// --- Track P11: LKI look-back for Layer 6 granted triggered abilities (CR 603.10a) ---
			const preGranted = preLeaveGrantedTriggers.get(obj);
			preLeaveGrantedTriggers.delete(obj);
			for (const gt of preGranted ?? []) {
				if (getTriggerHost()?.canExecute && !getTriggerHost()!.canExecute!(gt.runtimeTrigger)) continue;
				if (!alternatives(gt.runtimeTrigger.trigger).some((alt) => alt.event === 'zoneChange')) {
					continue;
				}
				candidates.push({
					obj,
					card: ev.lki.card,
					controllerId: ev.lki.controllerId,
					zone: 'battlefield',
					lostAllAbilities: false,
					isLookBack: true,
					grantedTrigger: gt,
					...(ev.lki.foretold ? { foretold: true } : {}),
					...(ev.lki.blitzed ? { blitzed: true } : {}),
					...(ev.lki.saddled ? { saddled: true } : {}),
					...(ev.lki.exerted ? { exerted: true } : {}),
					...(ev.lki.chosenSubType ? { chosenSubType: ev.lki.chosenSubType } : {}),
					...(ev.lki.chosenColor ? { chosenColor: ev.lki.chosenColor } : {}),
					...(ev.lki.monstrous ? { monstrous: true } : {}),
					...(ev.lki.counters ? { counters: ev.lki.counters } : {})
				});
			}
			// --- End Track P11 ---
		}
	}
	const lkiAttachedIds = objBatchInfo?.attachedIds ?? ev.lki?.attachedIds;
	// --- Track P10 ---
	const lkiDamagedBy = objBatchInfo?.damagedByThisTurn ?? ev.lki?.damagedByThisTurn;
	// --- End Track P10 ---
	for (const source of candidates) {
		for (const { ability, alts } of abilitiesFor(state, source, 'zoneChange', fits)) {
			const alt = alts.find((a) => {
				// --- Track P10 ---
				if (a.filter.dealtDamageBySelfThisTurn) {
					const srcVer = source.obj.objectVersion ?? 1;
					if (
						!lkiDamagedBy?.some(
							(d) =>
								d.sourceId === source.obj.instanceId &&
								(d.sourceVersion === undefined || d.sourceVersion === srcVer)
						)
					) {
						return false;
					}
				}
				// --- End Track P10 ---
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(
						state,
						a.filter.duringTurn,
						source.controllerId,
						ev.toPlayerId ?? ev.fromPlayerId ?? obj.ownerId
					)
				) {
					return false;
				}
				// --- End Track P16b ---
				// --- Track P19b: player filter on zoneChange (e.g. "Whenever an opponent mills one or more cards") ---
				if (a.filter.player) {
					const affectedPid = ev.toPlayerId ?? ev.fromPlayerId ?? obj.ownerId;
					const rel = a.filter.player.relation ?? 'any';
					if (rel === 'you' && affectedPid !== source.controllerId) return false;
					if (rel === 'opponent' && affectedPid === source.controllerId) return false;
				}
				// --- End Track P19b ---
				return objectMatches(
					a.filter,
					a.filter.fromAnywhere ? postMoveSubject : subject,
					source,
					lkiAttachedIds
				);
			});
			if (!alt) continue;
			// Only look-back objects check leaves-the-battlefield triggers; other permanents see the event normally.
			// --- Track P16b: CR 603.6c "put into a graveyard from anywhere" on self functions from graveyard ---
			if (
				(source.obj === obj || source.isLookBack) &&
				ev.from === 'battlefield' &&
				alt.filter.from !== 'battlefield' &&
				!(alt.filter.fromAnywhere && source.zone === 'graveyard')
			) {
				continue;
			}
			// --- End Track P16b ---
			// --- Track P13: CR 603.2c oneOrMore simultaneous zone-change batching ---
			if (alt.filter.oneOrMore) {
				const ch = channel(state);
				const batchSet =
					ch.zoneBatchTriggeredKeys ??
					(isResolutionPaused(state) || ch.deferFlush > 0
						? (ch.zoneBatchTriggeredKeys = new Set())
						: undefined);
				if (batchSet) {
					// --- Track P19b: scope per-player mill batching when `alt.filter.player` is present ---
					const playerSuffix = alt.filter.player
						? `:${ev.toPlayerId ?? ev.fromPlayerId ?? obj.ownerId}`
						: '';
					// --- Precon Bragos Spirit: "leave without dying" batches every non-graveyard destination together (CR 603.2c) ---
					const batchTo = alt.filter.notToZone ? `!${alt.filter.notToZone}` : ev.to;
					const batchKey = `${source.obj.instanceId}:${source.zone}:${source.faceIndex ?? 0}:${ability.abilityIndex}:${ev.from ?? ''}->${batchTo}${playerSuffix}`;
					// --- End Precon Bragos Spirit ---
					// --- End Track P19b ---
					if (batchSet.has(batchKey)) continue;
					batchSet.add(batchKey);
				}
			}
			// --- End Track P13 ---
			if (alt.filter.firstTimeEachTurn) {
				const zcOnceKey = `wave9_zc_first:${source.obj.instanceId}:${source.zone}:${source.faceIndex ?? 0}:${ability.abilityIndex}`;
				if (state.triggeredOnceThisTurn?.includes(zcOnceKey)) continue;
				(state.triggeredOnceThisTurn ??= []).push(zcOnceKey);
			}
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'zoneChange',
							object: obj,
							from: ev.from,
							to: ev.to,
							lki:
								ev.lki ??
								(objBatchInfo
									? {
											card: objBatchInfo.card,
											controllerId: objBatchInfo.controllerId,
											typeLine: objBatchInfo.typeLine,
											hasAllCreatureTypes: Boolean(objBatchInfo.hasAllCreatureTypes),
											isToken: obj.isToken,
											tapped: objBatchInfo.tapped,
											lostAllAbilities: objBatchInfo.lostAllAbilities
										}
									: undefined)
						})
					: 1;
			const eventLki = enters
				? undefined
				: objBatchInfo
					? {
							controllerId: objBatchInfo.controllerId,
							...(objBatchInfo.power !== undefined ? { power: objBatchInfo.power } : {}),
							...(objBatchInfo.toughness !== undefined ? { toughness: objBatchInfo.toughness } : {}),
							// --- Track P9 ---
							...(objBatchInfo.counters ? { counters: { ...objBatchInfo.counters } } : {})
						}
					: ev.lki
						? {
								controllerId: ev.lki.controllerId,
								power: ev.lki.power,
								toughness: ev.lki.toughness,
								// --- Track P9 ---
								...(ev.lki.counters ? { counters: { ...ev.lki.counters } } : {})
							}
						: undefined;
			const zcAffectedPid = ev.toPlayerId ?? ev.fromPlayerId ?? obj.ownerId;
			record(state, source, ability, 'zoneChange', {
				label: label(source, alt),
				eventObject: obj,
				amount: enteredPower(),
				times,
				eventLki,
				...(alt.filter.player
					? { eventPlayer: zcAffectedPid, eventPlayerId: zcAffectedPid }
					: {})
			});
		}
	}
	// --- Track P15: CR 702.174b Gift on permanent ETB ("When this permanent enters, if its gift cost was paid, ...") ---
	if (
		ev.to === 'battlefield' &&
		obj.zone === 'battlefield' &&
		!obj.phasedOut &&
		obj.giftPromised &&
		obj.giftRecipientId &&
		!permanentHasLostAllAbilities(obj, state).lost
	) {
		const giftCard = activeTimedLayer1aForPermanent(state, obj)?.card ?? obj.copiableCard ?? obj.card;
		const giftKw = findFaceGiftKeyword(giftCard, obj.activeFaceIndex ?? 0);
		if (giftKw?.giftKind) {
			const mult = triggerMultiplier(state, obj, obj.controllerId, {
				event: 'zoneChange',
				object: obj,
				from: ev.from,
				to: ev.to
			});
			const ch = channel(state);
			const syntheticGiftRt: RuntimeTrigger = {
				abilityIndex: -15,
				trigger: { event: 'zoneChange', filter: { to: 'battlefield', object: 'self' } },
				effectSupported: true,
				text: `${obj.card.name} — Gift`
			};
			for (let g = 0; g < mult; g++) {
				ch.pending.push({
					ability: syntheticGiftRt,
					source: obj,
					sourceCard: giftCard,
					faceIndex: obj.activeFaceIndex ?? 0,
					controllerId: obj.controllerId,
					mode: 'stack',
					label: `${obj.card.name} — Gift`,
					sourceGiftPromised: true,
					giftKind: giftKw.giftKind,
					giftRecipientId: obj.giftRecipientId,
					wave5Tag: 'gift_etb',
					order: ch.nextOrder++
				});
			}
		}
	}
	// --- End Track P15 ---
	// --- Track P9: Layer 6 granted death keywords (Undying, Persist) via LKI (CR 603.10a, CR 704.8) ---
	if (ev.from === 'battlefield' && ev.to === 'graveyard') {
		const lkiInfo = objBatchInfo ?? ev.lki;
		const grantedDeath = lkiInfo?.grantedDeathKeywords;
		if (lkiInfo && grantedDeath) {
			const deathSource: Source = {
				obj,
				card: lkiInfo.card,
				controllerId: lkiInfo.controllerId,
				zone: 'battlefield',
				isLookBack: true,
				...(lkiInfo.counters ? { counters: lkiInfo.counters } : {})
			};
			const deathEventLki = {
				controllerId: lkiInfo.controllerId,
				...(lkiInfo.power !== undefined ? { power: lkiInfo.power } : {}),
				...(lkiInfo.toughness !== undefined ? { toughness: lkiInfo.toughness } : {}),
				...(lkiInfo.counters ? { counters: { ...lkiInfo.counters } } : {})
			};
			const mult = triggerMultiplier(state, obj, lkiInfo.controllerId, {
				event: 'zoneChange',
				object: obj,
				from: ev.from,
				to: ev.to,
				lki: ev.lki
			});
			for (const [kwName, grantedCount] of Object.entries(grantedDeath)) {
				if (grantedCount <= 0) continue;
				const spec = getKeywordSpec(kwName);
				if (spec?.status !== 'implemented' || spec.implementation?.kind !== 'trigger') continue;
				const built = spec.implementation.buildTriggers({ name: kwName }, -1, { start: 0, end: 0 });
				for (const rt of built) {
					const times = grantedCount * mult;
					if (times > 0) {
						// --- Track P18a ---
						const w6Tag = kwName.toLowerCase() === 'haunt' ? 'haunt_exile' : undefined;
						// --- End Track P18a ---
						record(
							state,
							deathSource,
							{ ...rt, grantedKeyword: kwName, ...(w6Tag ? { wave6Tag: w6Tag } : {}) },
							'zoneChange',
							{
								label: spec.displayLabel || 'Dies',
								eventObject: obj,
								times,
								eventLki: deathEventLki,
								...(w6Tag ? { wave6Tag: w6Tag } : {})
							}
						);
					}
				}
			}
		}
	}
	// --- Track P18a: Layer 6 granted ETB trigger keywords (Soulbond, CR 702.95a) ---
	if (enters && obj.zone === 'battlefield' && !obj.phasedOut) {
		const ctrlPlayer = state.players.find((p) => !p.lost && p.playerId === obj.controllerId);
		const focus = ctrlPlayer ? ctrlPlayer.battlefield.filter((c) => !c.phasedOut) : [obj];
		if (boardCanGrantTriggerKeyword(state, 'zoneChange', focus)) {
			for (const bfPerm of focus) {
				emitGrantedTriggerKeywords(
					state,
					bfPerm,
					bfPerm.controllerId,
					'zoneChange',
					(rt, src) =>
						alternatives(rt.trigger).some(
							(a) =>
								a.event === 'zoneChange' &&
								a.filter.to === 'battlefield' &&
								objectMatches(a.filter, subject, src)
						) &&
						(!rt.condition ||
							evaluateCondition(
								state,
								rt.condition,
								src.controllerId,
								src.obj.instanceId,
								undefined,
								src,
								obj
							)),
					(rt, times) => ({
						label: rt.text || 'Soulbond',
						times,
						eventObject: obj,
						amount: enteredPower()
					}),
					(perm) =>
						triggerMultiplier(state, perm, perm.controllerId, {
							event: 'zoneChange',
							object: obj,
							from: ev.from,
							to: ev.to
						})
				);
			}
		}
	}
	// --- End Track P18a ---
}

function boardCanGrantTriggerKeyword(
	state: GameState,
	kind: EventKind,
	focusPerms: readonly CardInstance[]
): boolean {
	// --- Track P12 & P18a ---
	const isWave4GrantEvent =
		kind === 'attacks' ||
		kind === 'becomesBlocked' ||
		kind === 'dealsDamage' ||
		kind === 'attackedAndUnblocked' ||
		kind === 'zoneChange';
	if (!GRANTED_TRIGGER_KEYWORD_EVENTS.has(kind) && !isWave4GrantEvent) return false;
	for (const eff of state.timedContinuousEffects ?? []) {
		if (eff.layer6?.addKeywords?.some((kw) => grantedTriggerEventsForKeyword(kw)?.includes(kind))) {
			return true;
		}
		if (eff.layer6?.grantedAbilityTexts?.length) {
			for (const gt of eff.layer6.grantedAbilityTexts) {
				for (const def of resolveQuotedAbilityDefs(gt, 'Permanent')) {
					if (
						def.kind === 'keyword' &&
						grantedTriggerEventsForKeyword(formatGrantedKeywordDef(def.keyword))?.includes(kind)
					) {
						return true;
					}
				}
			}
		}
		if (eff.backupGrant) return true;
	}
	// --- End Track P12 & P18a ---
	for (const eff of state.timedKeywordEffects ?? []) {
		if (eff.addKeywords?.some((kw) => grantedTriggerEventsForKeyword(kw)?.includes(kind))) {
			return true;
		}
	}
	for (const perm of focusPerms) {
		if (perm.phasedOut) continue;
		if (perm.grantedKeywords?.some((kw) => grantedTriggerEventsForKeyword(kw)?.includes(kind))) {
			return true;
		}
	}
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			// --- Track P7 ---
			const pCard = activeTimedLayer1aForPermanent(state, perm)?.card ?? perm.copiableCard ?? perm.card;
			// --- End Track P7 ---
			if (activeFacesForObject(perm, pCard, 'battlefield', state).some((fi) => triggersOf(pCard, fi).grantedTriggerEvents.has(kind))) {
				return true;
			}
		}
	}
	return false;
}

function emitGrantedTriggerKeywords(
	state: GameState,
	perm: CardInstance,
	controllerId: string,
	kind: EventKind,
	matches: (rt: RuntimeTrigger, source: Source) => boolean,
	buildExtras: (rt: RuntimeTrigger, times: number) => MatchExtras,
	multiplierFor: (perm: CardInstance) => number
): void {
	const breakdown = inspectCardContinuousBreakdown(perm, state);
	// --- Track P7 ---
	const card = activeTimedLayer1aForPermanent(state, perm)?.card ?? perm.copiableCard ?? perm.card;
	// --- End Track P7 ---
	const source: Source = { obj: perm, card, controllerId, zone: 'battlefield' };
	for (const item of breakdown.items) {
		if (item.removed) continue;
		// --- Track P12: support granted Wave 4 trigger keywords (including parameterized ones) ---
		const parsedWave4 = parseGrantedWave4TriggerKeyword(item.canonicalKey);
		if (parsedWave4) {
			const evs = grantedTriggerEventsForKeyword(item.canonicalKey);
			if (!evs || !evs.includes(kind)) continue;
			let grantedCount = 0;
			if (item.grantCount !== undefined) {
				grantedCount = item.grantCount;
			} else {
				for (const src of item.sources) {
					if (src !== 'innate') grantedCount += 1;
				}
			}
			if (grantedCount <= 0) continue;
			const built = buildSingleWave4KeywordTriggers(
				{ name: parsedWave4.base, ...(parsedWave4.n !== undefined ? { n: parsedWave4.n } : {}) },
				-1,
				item.canonicalKey
			);
			for (const rt of built) {
				if (!matches(rt, source)) continue;
				const times = grantedCount * multiplierFor(perm);
				if (times > 0) {
					record(state, source, rt, kind, buildExtras(rt, times));
				}
			}
			continue;
		}
		// --- End Track P12 ---
		// --- Track P18a: support granted Wave 6 trigger keywords (Frenzy N, Poisonous N, Soulbond) ---
		const parsedWave6 = parseGrantedWave6TriggerKeyword(item.canonicalKey);
		if (parsedWave6) {
			const evs = grantedTriggerEventsForKeyword(item.canonicalKey);
			if (!evs || !evs.includes(kind)) continue;
			let grantedCount = 0;
			if (item.grantCount !== undefined) {
				grantedCount = item.grantCount;
			} else {
				for (const src of item.sources) {
					if (src !== 'innate') grantedCount += 1;
				}
			}
			if (grantedCount <= 0) continue;
			const built = buildGrantedWave6KeywordTriggers(parsedWave6, item.canonicalKey);
			for (const rt of built) {
				if (!matches(rt, source)) continue;
				const times = grantedCount * multiplierFor(perm);
				if (times > 0) {
					record(state, source, rt, kind, buildExtras(rt, times));
				}
			}
			continue;
		}
		// --- End Track P18a ---
		const spec = getKeywordSpec(item.canonicalKey);
		if (
			!spec ||
			spec.status !== 'implemented' ||
			!spec.grantable ||
			spec.parameterKind !== 'none' ||
			spec.implementation?.kind !== 'trigger' ||
			!spec.implementation.events.includes(kind)
		) {
			continue;
		}
		let grantedCount = 0;
		if (item.grantCount !== undefined) {
			grantedCount = item.grantCount;
		} else {
			for (const src of item.sources) {
				if (src !== 'innate') grantedCount += 1;
			}
		}
		if (grantedCount <= 0) continue;
		const built = spec.implementation.buildTriggers(
			{ name: item.canonicalKey },
			-1,
			{ start: 0, end: 0 }
		);
		for (const rt of built) {
			if (!matches(rt, source)) continue;
			const times = grantedCount * multiplierFor(perm);
			if (times > 0) {
				record(state, source, { ...rt, grantedKeyword: item.canonicalKey }, kind, buildExtras(rt, times));
			}
		}
	}
}

function matchCast(state: GameState, casterId: string, spell: CardInstance, isCopy: boolean): void {
	const stackSpell = state.stack.findLast(
		(s) => s.kind === 'spell' && s.sourceInstanceId === spell.instanceId
	);
	const castFaceOpts = stackSpell ? stackItemFaceOptions(stackSpell) : instanceFaceOptions(spell, 'stack');
	const castView = resolveObjectFaces(spell.card, castFaceOpts);
	const spellHasChangeling =
		!spell.isFaceDown &&
		activeAbilityDefs(spell.card, castFaceOpts).some(
			(ab) =>
				(ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'changeling') ||
				(ab.kind === 'static' && ab.static.k === 'continuous' && ab.static.mod.k === 'allCreatureTypes')
		);
	const subject = printedSubject(
		spell,
		spell.card,
		casterId,
		spellHasChangeling,
		castView.typeLine,
		spell.tapped,
		castView.colors,
		false,
		false,
		// --- Track P7 ---
		{
			state,
			power: castView.power,
			toughness: castView.toughness,
			manaValue: stackSpell ? objectManaValue(state, stackSpell) : castView.manaValue,
			// --- Track P13 ---
			stackItem: stackSpell
			// --- End Track P13 ---
		}
		// --- End Track P7 ---
	);
	let triggerEventStackItem: StackItem | undefined;
	if (stackSpell) {
		triggerEventStackItem = JSON.parse(JSON.stringify(stackSpell)) as StackItem;
		delete triggerEventStackItem.effectResume;
		delete triggerEventStackItem.triggerEventStackItem;
	}
	const totalCast = state.players.reduce((sum, pl) => sum + (pl.spellsCastThisTurn ?? 0), 0);
	const stormCount = isCopy ? 0 : Math.max(0, totalCast - 1);
	// --- Track P15 ---
	const gravestormCount = isCopy ? 0 : (state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0);
	// --- End Track P15 ---
	// --- Track P19b ---
	if (isCopy) {
		for (const source of sources(state, 'spellCopied')) {
			for (const { ability, alts } of abilitiesFor(state, source, 'spellCopied')) {
				const alt = alts.find((a) => {
					const rel = a.filter.player?.relation ?? 'any';
					if (rel === 'you' && casterId !== source.controllerId) return false;
					if (rel === 'opponent' && casterId === source.controllerId) return false;
					return !a.filter.object || objectMatches(a.filter, subject, source);
				});
				if (!alt) continue;
				record(state, source, ability, 'spellCopied', {
					label: 'Spell Copy Trigger',
					eventObject: spell,
					eventPlayer: casterId,
					...(triggerEventStackItem ? { triggerEventStackItem } : {})
				});
			}
		}
	}
	// --- End Track P22b ---
	const candidates = sources(state, 'cast');
	if (!isCopy) {
		const stackFaces = new Set(activeFacesForObject(spell, spell.card, 'stack', state));
		if (stackSpell?.faceIndex !== undefined) stackFaces.add(stackSpell.faceIndex);
		for (const faceIndex of stackFaces) {
			candidates.push({ obj: spell, card: spell.card, faceIndex, controllerId: casterId, zone: 'stack' });
		}
	}
	const casterForCount = state.players.find((p) => p.playerId === casterId);
	const castCountThisTurn = casterForCount?.spellsCastThisTurn ?? 0;
	// --- Track P13 ---
	const activePlayerId = state.players[state.activePlayerIndex]?.playerId;
	const castFromZoneVal = stackSpell?.castFromZone ?? spell.castFromZone ?? 'hand';
	const spellWasKicked =
		!isCopy && getObjectKickerInfo(state, spell.card, spell.instanceId, stackSpell, spell).count > 0;
	// --- End Track P13 ---
	for (const source of candidates) {
		for (const { ability, alts } of abilitiesFor(state, source, 'cast')) {
			const alt = alts.find((a) => {
				if (isCopy && !a.filter.orCopy) return false;
				if (a.filter.nthThisTurn !== undefined && (isCopy || castCountThisTurn !== a.filter.nthThisTurn)) {
					return false;
				}
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && casterId !== source.controllerId) return false;
				if (rel === 'opponent' && casterId === source.controllerId) return false;
				// --- Track P13: cast timing / origin / kicked qualifiers ---
				if (a.filter.duringOpponentTurn && activePlayerId === source.controllerId) {
					return false;
				}
				if (a.filter.castFromNotHand && (isCopy || castFromZoneVal === 'hand')) {
					return false;
				}
				if (a.filter.castFromZone !== undefined) {
					if (isCopy) return false;
					const allowed = Array.isArray(a.filter.castFromZone)
						? a.filter.castFromZone
						: [a.filter.castFromZone];
					if (!allowed.includes(castFromZoneVal)) return false;
				}
				if (a.filter.wasKicked && !spellWasKicked) {
					return false;
				}
				// --- End Track P13 ---
				// --- Track P16b ---
				if (
					!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, casterId)
				) {
					return false;
				}
				if (a.filter.spellOrdinal !== undefined) {
					if (isCopy) return false;
					const srcPerm = permanentById(state, source.obj.instanceId)?.obj ?? source.obj;
					if (
						!matchesSpellCastOrdinal(
							state,
							casterForCount,
							a.filter.spellOrdinal,
							a.filter.object,
							source.controllerId,
							srcPerm,
							matchesObjectFilter
						)
					) {
						return false;
					}
				}
				// --- End Track P16b ---
				// "When you cast ~" only from the stack; other cast triggers only from other zones.
				if ((a.filter.object === 'self') !== (source.zone === 'stack')) return false;
				if (a.filter.targetsSelf) {
					if (source.zone !== 'battlefield') return false;
					if (!stackSpell?.targets?.some((t) => t.kind === 'permanent' && t.id === source.obj.instanceId)) {
						return false;
					}
				}
				// --- Track P22b ---
				if (!matchesP22bCastFilter(state, a.filter, spell, casterId, isCopy, source.obj, stackSpell)) {
					return false;
				}
				// --- End Track P22b ---
				return objectMatches(a.filter, subject, source);
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'cast',
							spell,
							casterId,
							isCopy
						})
					: 1;
			const isStorm = Boolean(
				ability.effect?.steps.some((st) => st.params?.count?.k === 'stormCount')
			);
			// --- Track P15 ---
			const isGravestorm = Boolean(
				ability.effect?.steps.some((st) => st.params?.count?.k === 'gravestormCount')
			);
			// --- End Track P15 ---
			const isHeroic = Boolean(alt.filter.targetsSelf);
			record(state, source, ability, 'cast', {
				label: isStorm
					? 'Storm'
					: isGravestorm
						? 'Gravestorm'
						: ability.text === 'Prowess'
							? 'Prowess'
							: isHeroic
								? 'Heroic'
								: 'On Cast',
				times,
				eventObject: spell,
				eventPlayer: casterId,
				...(triggerEventStackItem ? { triggerEventStackItem } : {}),
				...(isStorm ? { stormCount } : {}),
				...(isGravestorm ? { gravestormCount } : {})
			});
		}
	}
	// Layer 6 continuous/temporary grants of parameterless trigger keywords (e.g. Prowess, CR 702.108).
	if (!isCopy) {
		const caster = state.players.find((p) => p.playerId === casterId);
		if (caster && !caster.lost && boardCanGrantTriggerKeyword(state, 'cast', caster.battlefield)) {
			for (const perm of caster.battlefield) {
				if (perm.phasedOut) continue;
				emitGrantedTriggerKeywords(
					state,
					perm,
					casterId,
					'cast',
					(rt, source) =>
						alternatives(rt.trigger).some((a) => {
							if (a.event !== 'cast') return false;
							const rel = a.filter.player?.relation ?? 'any';
							if (rel === 'you' && casterId !== source.controllerId) return false;
							if (rel === 'opponent' && casterId === source.controllerId) return false;
							if (a.filter.object === 'self') return false;
							return objectMatches(a.filter, subject, source);
						}),
					(rt, times) => ({
						label: rt.text || 'On Cast',
						times,
						eventPlayer: casterId
					}),
					(p) =>
						triggerMultiplier(state, p, casterId, {
							event: 'cast',
							spell,
							casterId,
							isCopy
						})
				);
			}
		}
		// --- Track P17a: CR 613.1f / 702.85c statically granted spell-cast trigger keywords (Cascade, Storm, Gravestorm) ---
		if (stackSpell?.grantedSpellKeywords && stackSpell.grantedSpellKeywords.length > 0) {
			const stackSource: Source = {
				obj: spell,
				card: spell.card,
				faceIndex: stackSpell.faceIndex,
				controllerId: casterId,
				zone: 'stack'
			};
			for (const kwName of stackSpell.grantedSpellKeywords) {
				const spec = getKeywordSpec(kwName);
				if (
					!spec ||
					spec.status !== 'implemented' ||
					spec.implementation?.kind !== 'trigger' ||
					!spec.implementation.events.includes('cast')
				) {
					continue;
				}
				const built = spec.implementation.buildTriggers(
					{ name: kwName },
					-1,
					{ start: 0, end: 0 }
				);
				for (const rt of built) {
					const matchesSelfCast = alternatives(rt.trigger).some(
						(a) => a.event === 'cast' && a.filter.object === 'self'
					);
					if (!matchesSelfCast) continue;
					const isStormKw = kwName === 'storm';
					const isGravestormKw = kwName === 'gravestorm';
					record(state, stackSource, { ...rt, grantedKeyword: kwName }, 'cast', {
						label: isStormKw
							? 'Storm'
							: isGravestormKw
								? 'Gravestorm'
								: spec.displayLabel || 'On Cast',
						times: 1,
						eventObject: spell,
						eventPlayer: casterId,
						...(triggerEventStackItem ? { triggerEventStackItem } : {}),
						...(isStormKw ? { stormCount } : {}),
						...(isGravestormKw ? { gravestormCount } : {})
					});
				}
			}
		}
		// --- End Track P17a ---
	}
}



function matchAttack(state: GameState, attackingPlayerId: string, attackerIds: string[]): void {
	const attackers = attackerIds
		.map((id) => permanentById(state, id))
		.filter((a): a is NonNullable<typeof a> => Boolean(a))
		.map((a) => battlefieldSubject(state, a.obj, a.controllerId));
	// --- Track P19b: track per-turn attack declarations per permanent (CR 508.1k) ---
	for (const atk of attackers) {
		atk.obj.attacksCountThisTurn = (atk.obj.attacksCountThisTurn ?? 0) + 1;
	}
	const matchesAttackTurnOrdinal = (f: EventFilter, atkObj: CardInstance): boolean => {
		if (f.firstTimeEachTurn && (atkObj.attacksCountThisTurn ?? 0) !== 1) return false;
		if (f.nthEventThisTurn !== undefined && (atkObj.attacksCountThisTurn ?? 0) !== f.nthEventThisTurn) {
			return false;
		}
		return true;
	};
	const directAttackedPlayerId = (atkId: string): string | undefined => {
		const entry = state.combat.attackers.find((a) => a.attackerInstanceId === atkId);
		if (!entry || entry.defenderPlaneswalkerId || entry.defenderBattleId) return undefined;
		return entry.defenderPlayerId;
	};
	// --- End Track P19b ---
	const attackerDefenderId = (id: string): string | undefined =>
		state.combat.attackers.find((a) => a.attackerInstanceId === id)?.defenderPlayerId;

	for (const source of sources(state, 'attacks')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'attacks')) {
			for (const alt of alts) {
				const f = alt.filter;
				if (f.alone && attackers.length !== 1) continue;
				// --- Track P16b: attackedTarget & coAttackerFilter ---
				const matchesAttackedTarget = (atkId: string): boolean => {
					if (!f.attackedTarget) return true;
					const entry = state.combat.attackers.find((a) => a.attackerInstanceId === atkId);
					if (!entry) return false;
					const hasPermTarget = Boolean(entry.defenderPlaneswalkerId || entry.defenderBattleId);
					switch (f.attackedTarget) {
						case 'you':
							return !hasPermTarget && entry.defenderPlayerId === source.controllerId;
						case 'youOrPlaneswalkerYouControl': {
							if (!hasPermTarget && entry.defenderPlayerId === source.controllerId) {
								return true;
							}
							if (entry.defenderPlaneswalkerId) {
								const pw = permanentById(state, entry.defenderPlaneswalkerId);
								return Boolean(
									pw &&
										pw.controllerId === source.controllerId &&
										evaluatePermanent(state, pw.obj).isPlaneswalker
								);
							}
							return false;
						}
						case 'opponent':
							return !hasPermTarget && entry.defenderPlayerId !== source.controllerId;
						case 'opponentOrPlaneswalkerOpponentControls': {
							if (!hasPermTarget && entry.defenderPlayerId !== source.controllerId) {
								return true;
							}
							if (entry.defenderPlaneswalkerId) {
								const pw = permanentById(state, entry.defenderPlaneswalkerId);
								return Boolean(
									pw &&
										pw.controllerId !== source.controllerId &&
										evaluatePermanent(state, pw.obj).isPlaneswalker
								);
							}
							return false;
						}
						case 'enchantedPlayer':
							return (
								!hasPermTarget &&
								Boolean(source.obj.attachedToId) &&
								entry.defenderPlayerId === source.obj.attachedToId
							);
						case 'planeswalker': {
							if (!entry.defenderPlaneswalkerId) return false;
							const pw = permanentById(state, entry.defenderPlaneswalkerId);
							return Boolean(pw && evaluatePermanent(state, pw.obj).isPlaneswalker);
						}
						case 'battle': {
							if (!entry.defenderBattleId) return false;
							const b = permanentById(state, entry.defenderBattleId);
							return Boolean(b && evaluatePermanent(state, b.obj).typeLine.includes('Battle'));
						}
						// --- Track P22b ---
						case 'playerWithMostLife':
							return matchesP22bAttackedTargetWithMostLife(
								state,
								entry.defenderPlayerId,
								hasPermTarget
							);
						// --- End Track P22b ---
						case 'anyPlayer':
							return !hasPermTarget;
					}
				};
				if (!matchesWave9AttacksFilter(state, f, source, attackingPlayerId, attackerIds)) continue;
				// --- Track P22b ---
				if (f.attackingWithFilter && f.minAttackingWithCount !== undefined) {
					const rel = f.player?.relation ?? 'any';
					const playerMatches =
						rel === 'you'
							? attackingPlayerId === source.controllerId
							: rel === 'opponent'
								? attackingPlayerId !== source.controllerId
								: true;
					if (!playerMatches) continue;
					const atkViewer = viewerOf(source);
					const matchedCount = attackers.filter((s) =>
						filterMatches(f.attackingWithFilter!, s, atkViewer)
					).length;
					if (matchedCount < f.minAttackingWithCount) continue;
					record(state, source, ability, 'attacks', {
						label: ability.text || 'Attack Trigger',
						eventPlayer: attackingPlayerId,
						eventPlayerId: attackingPlayerId,
						amount: matchedCount
					});
					break;
				}
				// --- End Track P22b ---
				if (f.coAttackerFilter) {
					const coViewer = viewerOf(source);
					const coCount = attackers.filter(
						(s) =>
							s.obj.instanceId !== source.obj.instanceId &&
							filterMatches(f.coAttackerFilter!, s, coViewer)
					).length;
					if (coCount < (f.coAttackerMin ?? 1)) continue;
				}
				// --- End Track P16b ---
				// --- Track P10 ---
				if (
					f.minAttackers !== undefined &&
					(f.object === 'self' || f.object === undefined) &&
					attackers.length < f.minAttackers
				) {
					continue;
				}
				if (f.object === undefined) {
					const rel = f.player?.relation ?? 'any';
					const playerMatches =
						rel === 'you'
							? attackingPlayerId === source.controllerId
							: rel === 'opponent'
								? attackingPlayerId !== source.controllerId
								: true;
					const targetFiltered = f.attackedTarget
						? attackers.filter((s) => matchesAttackedTarget(s.obj.instanceId))
						: attackers;
					// --- Track P19b: CR 508.3e per-attacked-player batching & minAttackers on targetFiltered ---
					if (playerMatches && f.perAttackedPlayer) {
						const byDefender = new Map<string, Subject[]>();
						for (const s of targetFiltered) {
							const defPid = directAttackedPlayerId(s.obj.instanceId);
							if (!defPid) continue;
							let list = byDefender.get(defPid);
							if (!list) {
								list = [];
								byDefender.set(defPid, list);
							}
							list.push(s);
						}
						let firedAny = false;
						for (const [defPid, group] of byDefender) {
							if (f.minAttackers !== undefined && group.length < f.minAttackers) continue;
							const times =
								source.zone === 'battlefield'
									? triggerMultiplier(state, source.obj, source.controllerId, {
											event: 'attacks',
											attackers: group.map((s) => s.obj)
										})
									: 1;
							record(state, source, ability, 'attacks', {
								label: 'Attack',
								times,
								eventPlayer: defPid,
								eventPlayerId: defPid,
								defendingPlayerId: defPid,
								amount: group.length
							});
							firedAny = true;
						}
						if (firedAny) break;
						continue;
					}
					if (f.minAttackers !== undefined && targetFiltered.length < f.minAttackers) {
						continue;
					}
					// --- End Track P19b ---
					if (playerMatches && targetFiltered.length > 0) {
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attacks',
										attackers: targetFiltered.map((s) => s.obj)
									})
								: 1;
						record(state, source, ability, 'attacks', {
							label: 'Attack',
							times,
							eventPlayer: attackingPlayerId,
							eventPlayerId: attackingPlayerId,
							amount: targetFiltered.length
						});
						break;
					}
					continue;
				}
				// --- End Track P10 ---
				if (f.player?.relation === 'you' && attackingPlayerId !== source.controllerId) continue;
				if (f.player?.relation === 'opponent' && attackingPlayerId === source.controllerId) continue;
				const matching = attackers.filter(
					(s) =>
						objectMatches(f, s, source) &&
						matchesAttackedTarget(s.obj.instanceId) &&
						// --- Track P19b ---
						matchesAttackTurnOrdinal(f, s.obj)
						// --- End Track P19b ---
				);
				if (matching.length === 0) continue;
				// --- Track P19b: CR 508.3e "Whenever N or more <filter> you control attack a player" ---
				if (f.perAttackedPlayer && f.object !== 'self') {
					const byDefender = new Map<string, Subject[]>();
					for (const s of matching) {
						const defPid = directAttackedPlayerId(s.obj.instanceId);
						if (!defPid) continue;
						let list = byDefender.get(defPid);
						if (!list) {
							list = [];
							byDefender.set(defPid, list);
						}
						list.push(s);
					}
					let firedAny = false;
					for (const [defPid, group] of byDefender) {
						if (f.minAttackers !== undefined && group.length < f.minAttackers) continue;
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attacks',
										attackers: group.map((s) => s.obj)
									})
								: 1;
						record(state, source, ability, 'attacks', {
							label: ability.text || 'Attack',
							times,
							eventPlayer: defPid,
							eventPlayerId: defPid,
							defendingPlayerId: defPid,
							amount: group.length
						});
						firedAny = true;
					}
					if (firedAny) break;
					continue;
				}
				// --- End Track P19b ---
				if (f.minAttackers !== undefined && f.object !== 'self' && matching.length < f.minAttackers) {
					continue;
				}
				if (f.object === 'self' || f.oneOrMore) {
					const defendingPlayerId =
						f.object === 'self'
							? attackerDefenderId(source.obj.instanceId)
							: f.alone && matching.length === 1
								? attackerDefenderId(matching[0].obj.instanceId)
								: undefined;
					// --- Track P12: Dethrone (CR 702.105a) & Training (CR 702.149a) attack-time checks ---
					if (f.dethroneMostLife && (!defendingPlayerId || !isPlayerTiedForMostLife(state, defendingPlayerId))) {
						continue;
					}
					if (f.trainingGreaterAttacker && !attackerHasGreaterPowerCoAttacker(state, source.obj, source.controllerId)) {
						continue;
					}
					const mentorPower =
						(ability as Wave4RuntimeTrigger).wave4Tag === 'mentor' && source.zone === 'battlefield'
							? evaluatePermanent(state, source.obj).power
							: undefined;
					// --- End Track P12 ---
					const times =
						source.zone === 'battlefield'
							? triggerMultiplier(state, source.obj, source.controllerId, {
									event: 'attacks',
									attackers: matching.map((s) => s.obj)
								})
							: 1;
					record(state, source, ability, 'attacks', {
						label: ability.text || 'Attack',
						times,
						...(f.alone && matching.length === 1 ? { eventObject: matching[0].obj } : {}),
						...(defendingPlayerId
							? { defendingPlayerId, p22bEventAttackedTargetPlayerId: defendingPlayerId }
							: {}),
						...(f.oneOrMore ? { amount: matching.length } : {}),
						...(mentorPower !== undefined ? { amount: mentorPower } : {})
					});
				} else {
					for (const s of matching) {
						const defendingPlayerId = attackerDefenderId(s.obj.instanceId);
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attacks',
										object: s.obj,
										attackers: [s.obj]
									})
								: 1;
						record(state, source, ability, 'attacks', {
							label: f.alone && ability.text ? ability.text : 'Attack Trigger',
							eventObject: s.obj,
							...(defendingPlayerId
								? { defendingPlayerId, p22bEventAttackedTargetPlayerId: defendingPlayerId }
								: {}),
							times
						});
					}
				}
				break;
			}
		}
	}
	const allBattlefieldPerms = state.players
		.filter((p) => !p.lost)
		.flatMap((p) => p.battlefield.filter((perm) => !perm.phasedOut));
	if (boardCanGrantTriggerKeyword(state, 'attacks', allBattlefieldPerms)) {
		const attackerById = new Map(attackers.map((s) => [s.obj.instanceId, s]));
		for (const p of state.players) {
			if (p.lost) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				let matchedAttacker: Subject | undefined;
				emitGrantedTriggerKeywords(
					state,
					perm,
					p.playerId,
					'attacks',
					(rt, source) => {
						matchedAttacker = undefined;
						for (const a of alternatives(rt.trigger)) {
							if (a.event !== 'attacks') continue;
							if (a.filter.alone && attackers.length !== 1) continue;
							if (a.filter.object === 'self') {
								const s = attackerById.get(perm.instanceId);
								if (s) {
									// --- Track P12 ---
									const defId = attackerDefenderId(perm.instanceId);
									if (a.filter.dethroneMostLife && (!defId || !isPlayerTiedForMostLife(state, defId))) {
										continue;
									}
									if (a.filter.trainingGreaterAttacker && !attackerHasGreaterPowerCoAttacker(state, perm, p.playerId)) {
										continue;
									}
									// --- End Track P12 ---
									matchedAttacker = s;
									return true;
								}
							} else if (a.filter.object !== undefined) {
								const s = attackers.find((atk) => objectMatches(a.filter, atk, source));
								if (s) {
									matchedAttacker = s;
									return true;
								}
							}
						}
						return false;
					},
					(rt, times) => {
						const atkObj = matchedAttacker?.obj;
						const defendingPlayerId = atkObj ? attackerDefenderId(atkObj.instanceId) : undefined;
						return {
							label: rt.text || 'Attack',
							times,
							...(atkObj ? { eventObject: atkObj } : {}),
							...(defendingPlayerId ? { defendingPlayerId } : {})
						};
					},
					(prm) =>
						triggerMultiplier(state, prm, p.playerId, {
							event: 'attacks',
							...(matchedAttacker
								? { object: matchedAttacker.obj, attackers: [matchedAttacker.obj] }
								: { attackers: [] })
						})
				);
			}
		}
	}
}

function matchBlocks(state: GameState, defenderId: string, blocks: Array<{ blockerId: string; attackerId: string }>): void {
	if (blocks.length === 0) return;
	const subjectFor = (id: string) => {
		const found = permanentById(state, id);
		return found ? battlefieldSubject(state, found.obj, found.controllerId) : null;
	};
	const blockers = [...new Set(blocks.map((b) => b.blockerId))].map(subjectFor).filter((s): s is Subject => Boolean(s));
	const blocked = [...new Set(blocks.map((b) => b.attackerId))].map(subjectFor).filter((s): s is Subject => Boolean(s));
	const subjectById = new Map<string, Subject>();
	for (const s of [...blockers, ...blocked]) {
		subjectById.set(s.obj.instanceId, s);
	}
	const dedupPairs: Array<{ blocker: Subject; attacker: Subject }> = [];
	const seenPairKeys = new Set<string>();
	for (const b of blocks) {
		const pairKey = `${b.blockerId}::${b.attackerId}`;
		if (seenPairKeys.has(pairKey)) continue;
		seenPairKeys.add(pairKey);
		const blocker = subjectById.get(b.blockerId);
		const attacker = subjectById.get(b.attackerId);
		if (blocker && attacker) dedupPairs.push({ blocker, attacker });
	}
	void defenderId;
	for (const kind of ['blocks', 'becomesBlocked'] as const) {
		const subjects = kind === 'blocks' ? blockers : blocked;
		for (const source of sources(state, kind)) {
			for (const { ability, alts } of abilitiesFor(state, kind === 'blocks' ? source : source, kind)) {
				const alt = alts[0];
				// --- Track P10: CR 509.3b / CR 509.3d per-opposing-creature getTriggerHost() filter ---
				if (alt.filter.host) {
					const viewer = viewerOf(source);
					for (const pair of dedupPairs) {
						const selfSide = kind === 'blocks' ? pair.blocker : pair.attacker;
						const otherSide = kind === 'blocks' ? pair.attacker : pair.blocker;
						if (!objectMatches(alt.filter, selfSide, source)) continue;
						if (!filterMatches(alt.filter.host, otherSide, viewer)) continue;
						record(state, source, ability, kind, {
							label: kind === 'blocks' ? 'Block' : 'Blocked',
							eventObject: otherSide.obj
						});
					}
					continue;
				}
				// --- End Track P10 ---
				// --- Track P13: CR 509.3c blockedAttackerFilter ("Whenever ~ blocks a [filter]") ---
				if (kind === 'blocks' && alt.filter.blockedAttackerFilter) {
					const viewer = viewerOf(source);
					for (const pair of dedupPairs) {
						if (!objectMatches(alt.filter, pair.blocker, source)) continue;
						if (!filterMatches(alt.filter.blockedAttackerFilter, pair.attacker, viewer)) continue;
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'blocks',
										object: pair.blocker.obj
									})
								: 1;
						record(state, source, ability, kind, {
							label: ability.text || 'Block',
							eventObject: pair.attacker.obj,
							times
						});
					}
					continue;
				}
				// --- End Track P13 ---
				const matching = subjects.filter((s) => objectMatches(alt.filter, s, source));
				if (alt.filter.object === 'self') {
					if (matching.length > 0) {
						// --- Track P12 ---
						const atkEntry =
							kind === 'becomesBlocked'
								? state.combat.attackers.find((a) => a.attackerInstanceId === source.obj.instanceId)
								: undefined;
						// --- End Track P12 ---
						record(state, source, ability, kind, {
							label: ability.text || (kind === 'blocks' ? 'Block' : 'Blocked'),
							...(atkEntry ? { amount: atkEntry.blockerInstanceIds.length, defendingPlayerId: atkEntry.defenderPlayerId } : {})
						});
					}
				} else if (alt.filter.oneOrMore) {
					// --- Track P16b: batch "blocks / becomes blocked" with oneOrMore ---
					if (matching.length > 0) {
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: kind,
										object: matching[0].obj
									})
								: 1;
						record(state, source, ability, kind, {
							label: kind === 'blocks' ? 'Block' : 'Blocked',
							eventObject: matching[0].obj,
							amount: matching.length,
							times
						});
					}
					// --- End Track P16b ---
				} else {
					for (const s of matching) record(state, source, ability, kind, { label: kind === 'blocks' ? 'Block' : 'Blocked', eventObject: s.obj });
				}
			}
		}
		if (boardCanGrantTriggerKeyword(state, kind, subjects.map((s) => s.obj))) {
			for (const s of subjects) {
				const atkEntry =
					kind === 'becomesBlocked'
						? state.combat.attackers.find((a) => a.attackerInstanceId === s.obj.instanceId)
						: undefined;
				emitGrantedTriggerKeywords(
					state,
					s.obj,
					s.controllerId,
					kind,
					(rt) => alternatives(rt.trigger).some((a) => a.event === kind && a.filter.object === 'self'),
					(rt, times) => ({
						label: rt.text || (kind === 'blocks' ? 'Block' : 'Blocked'),
						times,
						...(atkEntry ? { amount: atkEntry.blockerInstanceIds.length, defendingPlayerId: atkEntry.defenderPlayerId } : {})
					}),
					() => 1
				);
			}
		}
	}
	// --- Track P10: blocksOrBecomesBlocked (CR 509.3a–d / 509.1h) ---
	const combinedCombatants = [
		...new Map([...blockers, ...blocked].map((s) => [s.obj.instanceId, s])).values()
	];
	for (const source of sources(state, 'blocksOrBecomesBlocked')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'blocksOrBecomesBlocked')) {
			const alt = alts[0];
			if (alt.filter.host) {
				const viewer = viewerOf(source);
				for (const pair of dedupPairs) {
					for (const [selfSide, otherSide] of [
						[pair.blocker, pair.attacker],
						[pair.attacker, pair.blocker]
					] as const) {
						if (!objectMatches(alt.filter, selfSide, source)) continue;
						if (!filterMatches(alt.filter.host, otherSide, viewer)) continue;
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'blocksOrBecomesBlocked',
										object: selfSide.obj
									})
								: 1;
						record(state, source, ability, 'blocksOrBecomesBlocked', {
							label: 'Blocks or Blocked',
							eventObject: otherSide.obj,
							times
						});
					}
				}
				continue;
			}
			const matching = combinedCombatants.filter((s) => objectMatches(alt.filter, s, source));
			if (alt.filter.object === 'self') {
				if (matching.length > 0) {
					const times =
						source.zone === 'battlefield'
							? triggerMultiplier(state, source.obj, source.controllerId, {
									event: 'blocksOrBecomesBlocked',
									object: source.obj
								})
							: 1;
					record(state, source, ability, 'blocksOrBecomesBlocked', {
						label: 'Blocks or Blocked',
						times
					});
				}
			} else if (alt.filter.oneOrMore) {
				if (matching.length > 0) {
					const times =
						source.zone === 'battlefield'
							? triggerMultiplier(state, source.obj, source.controllerId, {
									event: 'blocksOrBecomesBlocked',
									object: matching[0].obj
								})
							: 1;
					record(state, source, ability, 'blocksOrBecomesBlocked', {
						label: 'Blocks or Blocked',
						amount: matching.length,
						times
					});
				}
			} else {
				for (const s of matching) {
					const times =
						source.zone === 'battlefield'
							? triggerMultiplier(state, source.obj, source.controllerId, {
									event: 'blocksOrBecomesBlocked',
									object: s.obj
								})
							: 1;
					record(state, source, ability, 'blocksOrBecomesBlocked', {
						label: 'Blocks or Blocked',
						eventObject: s.obj,
						times
					});
				}
			}
		}
	}
	// --- End Track P10 ---
	// --- Track P9: Flanking / becomesBlockedBy (CR 702.25a–b) ---
	const blockedObjs = blocked.map((s) => s.obj);
	const canGrantBlockedBy = boardCanGrantTriggerKeyword(state, 'becomesBlockedBy', blockedObjs);
	const innateBlockedBySources = sources(state, 'becomesBlockedBy');
	if (innateBlockedBySources.length > 0 || canGrantBlockedBy) {
		for (const pair of blocks) {
			const blockerSub = subjectFor(pair.blockerId);
			const attackerSub = subjectFor(pair.attackerId);
			if (!blockerSub || !attackerSub) continue;
			const blockerHasFlanking = evaluatePermanent(state, blockerSub.obj).breakdown.items.some(
				(it) => !it.removed && it.canonicalKey === 'flanking'
			);
			for (const source of innateBlockedBySources) {
				for (const { ability, alts } of abilitiesFor(state, source, 'becomesBlockedBy')) {
					const alt = alts.find((a) => {
						if (a.filter.withoutFlanking && blockerHasFlanking) return false;
						return objectMatches(a.filter, attackerSub, source);
					});
					if (!alt) continue;
					const times =
						source.zone === 'battlefield'
							? triggerMultiplier(state, source.obj, source.controllerId, {
									event: 'becomesBlockedBy',
									object: blockerSub.obj
								})
							: 1;
					record(state, source, ability, 'becomesBlockedBy', {
						label: ability.text || 'Flanking',
						eventObject: blockerSub.obj,
						times
					});
				}
			}
			if (canGrantBlockedBy) {
				emitGrantedTriggerKeywords(
					state,
					attackerSub.obj,
					attackerSub.controllerId,
					'becomesBlockedBy',
					(rt, source) =>
						alternatives(rt.trigger).some(
							(a) =>
								a.event === 'becomesBlockedBy' &&
								(!a.filter.withoutFlanking || !blockerHasFlanking) &&
								objectMatches(a.filter, attackerSub, source)
						),
					(rt, times) => ({
						label: rt.text || 'Flanking',
						eventObject: blockerSub.obj,
						times
					}),
					(prm) =>
						triggerMultiplier(state, prm, attackerSub.controllerId, {
							event: 'becomesBlockedBy',
							object: blockerSub.obj
						})
				);
			}
		}
	}
}

function matchDamage(state: GameState, ev: Extract<GameEvent, { kind: 'DamageDealt' }>): void {
	if (ev.amount <= 0) return;
	// --- Track P19b ---
	recordP19bDamageState(state, ev);
	// --- End Track P19b ---
	const dealer = permanentById(state, ev.sourceId);
	const damaged = ev.targetKind === 'permanent' ? permanentById(state, ev.targetId) : null;
	const damagedEval = damaged ? evaluatePermanent(state, damaged.obj) : null;
	const damageToFits = (to: EventFilter['damageTo']) => {
		switch (to) {
			case 'player':
				return ev.targetKind === 'player';
			case 'playerOrPlaneswalker':
				return ev.targetKind === 'player' || Boolean(damagedEval?.isPlaneswalker);
			case 'creature':
				return Boolean(damagedEval?.isCreature);
			default:
				return true;
		}
	};
	// --- Track P16b ---
	const isDamagedBattle = Boolean(
		damaged && !damaged.obj.isFaceDown && damagedEval?.typeLine.includes('Battle')
	);
	const damageTargetKindFits = (tk: EventFilter['damageTargetKind']) => {
		if (!tk || tk === 'any') return true;
		if (tk === 'battle') return isDamagedBattle;
		if (tk === 'playerOrBattle') return ev.targetKind === 'player' || isDamagedBattle;
		if (tk === 'planeswalker') {
			return Boolean(damaged && !damaged.obj.isFaceDown && damagedEval?.isPlaneswalker);
		}
		if (tk === 'permanent') return ev.targetKind === 'permanent';
		return true;
	};
	// --- End Track P16b ---
	const dealerSubject = dealer ? battlefieldSubject(state, dealer.obj, dealer.controllerId) : null;
	const damagedSubject = damaged ? battlefieldSubject(state, damaged.obj, damaged.controllerId) : null;

	if (dealerSubject) {
		for (const source of sources(state, 'dealsDamage')) {
			for (const { ability, alts } of abilitiesFor(state, source, 'dealsDamage')) {
				const alt = alts.find((a) => {
					if ((a.filter.combat && !ev.combat) || !damageToFits(a.filter.damageTo)) return false;
					// --- Track P16b ---
					if (a.filter.noncombatOnly && ev.combat) return false;
					if (!damageTargetKindFits(a.filter.damageTargetKind)) return false;
					// --- End Track P16b ---
					// --- Track P19b ---
					if (a.filter.damageTargetEnchantedPlayer) {
						if (
							ev.targetKind !== 'player' ||
							!source.obj.attachedToId ||
							ev.targetId !== source.obj.attachedToId
						) {
							return false;
						}
					}
					if (a.filter.damageTargetFilter) {
						if (!damagedSubject || !filterMatches(a.filter.damageTargetFilter, damagedSubject, viewerOf(source))) {
							return false;
						}
					}
					// --- End Track P19b ---
					// --- Track P7 ---
					const rel = a.filter.damagePlayerRelation ?? a.filter.player?.relation ?? 'any';
					const damagedPid =
						ev.targetKind === 'player'
							? ev.targetId
							: a.filter.damageTo === 'playerOrPlaneswalker' && damagedEval?.isPlaneswalker
								? damaged?.controllerId
								: undefined;
					if (rel === 'you' && damagedPid !== source.controllerId) {
						return false;
					}
					if (rel === 'opponent' && (!damagedPid || damagedPid === source.controllerId)) {
						return false;
					}
					// --- End Track P7 ---
					if (a.filter.watchedBoundObject) {
						const watched = source.wave7SpellDelayed?.entry.watchedObjectIds;
						if (!watched || !watched.includes(dealerSubject.obj.instanceId)) return false;
					}
					return objectMatches(a.filter, dealerSubject, source);
				});
				if (!alt) continue;
				// --- Track P17a ---
				const times =
					source.zone === 'battlefield'
						? triggerMultiplier(state, source.obj, source.controllerId, {
								event: 'dealsDamage',
								object: dealerSubject.obj,
								combat: ev.combat,
								targetKind: ev.targetKind,
								targetIsPlaneswalker: Boolean(damagedEval?.isPlaneswalker)
							})
						: 1;
				// --- End Track P17a ---
				record(state, source, ability, 'dealsDamage', {
					label: ev.combat ? 'Combat Damage Trigger' : 'Damage Trigger',
					eventObject: damaged ? damaged.obj : dealerSubject.obj,
					eventPlayerId: ev.targetKind === 'player' ? ev.targetId : undefined,
					amount: ev.amount,
					times
				});
			}
		}
		// --- Track P12: Layer 6 granted combat-damage-to-player keywords (Ingest, Renown N) ---
		if (
			ev.combat &&
			ev.targetKind === 'player' &&
			boardCanGrantTriggerKeyword(state, 'dealsDamage', [dealerSubject.obj])
		) {
			emitGrantedTriggerKeywords(
				state,
				dealerSubject.obj,
				dealerSubject.controllerId,
				'dealsDamage',
				(rt) =>
					alternatives(rt.trigger).some(
						(a) =>
							a.event === 'dealsDamage' &&
							a.filter.object === 'self' &&
							(!a.filter.combat || ev.combat) &&
							damageToFits(a.filter.damageTo)
					),
				(rt, times) => ({
					label: rt.text || 'Combat Damage Trigger',
					times,
					eventObject: dealerSubject.obj,
					eventPlayerId: ev.targetId,
					amount: ev.amount
				}),
				() => 1
			);
		}
		// --- End Track P12 ---
	}
	if (damagedSubject) {
		for (const source of sources(state, 'dealtDamage')) {
			for (const { ability, alts } of abilitiesFor(state, source, 'dealtDamage')) {
				if (
					!alts.some(
						(a) =>
							!a.filter.damagedPlayer &&
							(!a.filter.combat || ev.combat) &&
							(!a.filter.noncombatOnly || !ev.combat) &&
							(a.filter.singleSourceDamageMin === undefined ||
								matchesWave9DamagedTargetMin(state, ev, a.filter.singleSourceDamageMin)) &&
							objectMatches(a.filter, damagedSubject, source)
					)
				) {
					continue;
				}
				record(state, source, ability, 'dealtDamage', {
					label: 'Dealt Damage',
					eventObject: damagedSubject.obj,
					amount: ev.amount,
					...(dealerSubject
						? {
								p22bEventDamageSourceSubtypes: splitSubtypes(
									evaluatePermanent(state, dealerSubject.obj).effectiveTypeLine
								)
							}
						: {})
				});
			}
		}
	}
	// --- Track P16b: "Whenever you're / an opponent is dealt [combat/noncombat] damage" ---
	if (ev.targetKind === 'player') {
		for (const source of sources(state, 'dealtDamage')) {
			for (const { ability, alts } of abilitiesFor(state, source, 'dealtDamage')) {
				const alt = alts.find((a) => {
					if (!a.filter.damagedPlayer) return false;
					if (a.filter.combat && !ev.combat) return false;
					if (a.filter.noncombatOnly && ev.combat) return false;
					if (a.filter.damagedPlayer === 'you' && ev.targetId !== source.controllerId) {
						return false;
					}
					if (a.filter.damagedPlayer === 'opponent' && ev.targetId === source.controllerId) {
						return false;
					}
					if (a.filter.object !== undefined) {
						if (!dealerSubject) return false;
						if (!objectMatches(a.filter, dealerSubject, source)) return false;
					}
					return true;
				});
				if (!alt) continue;
				record(state, source, ability, 'dealtDamage', {
					label: 'Dealt Damage',
					...(dealer ? { eventObject: dealer.obj } : {}),
					eventPlayerId: ev.targetId,
					eventPlayer: ev.targetId,
					amount: ev.amount
				});
			}
		}
	}
	// --- End Track P16b ---
}

function matchCombatDamageBatchPlayer(
	state: GameState,
	ev: Extract<GameEvent, { kind: 'CombatDamageBatchPlayer' }>
): void {
	if (ev.attackers.length === 0) return;
	const attackerSubjects = ev.attackers.map((atk) => {
		const onBf = permanentById(state, atk.instanceId);
		if (onBf) return battlefieldSubject(state, onBf.obj, onBf.controllerId);
		return printedSubject(atk, atk.copiableCard ?? atk.card, atk.controllerId);
	});
	for (const source of sources(state, 'combatDamageBatchPlayer')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'combatDamageBatchPlayer')) {
			let matchedCount = 0;
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.damagedPlayerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.damagedPlayerId === source.controllerId) return false;
				if (a.filter.combatDamageBatchPlayer === 'opponent' && ev.damagedPlayerId === source.controllerId) return false;
				if (a.filter.combatDamageBatchPlayer === 'you' && ev.damagedPlayerId !== source.controllerId) return false;
				const matching = attackerSubjects.filter((s) => objectMatches(a.filter, s, source));
				if (matching.length === 0) return false;
				matchedCount = matching.length;
				return true;
			});
			if (!alt) continue;
			// --- Track P17a ---
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'combatDamageBatchPlayer',
							attackers: ev.attackers,
							combat: true,
							targetKind: 'player'
						})
					: 1;
			// --- End Track P17a ---
			record(state, source, ability, 'combatDamageBatchPlayer', {
				label: 'Combat Damage Trigger',
				eventPlayerId: ev.damagedPlayerId,
				eventPlayer: ev.damagedPlayerId,
				amount: matchedCount,
				times
			});
		}
	}
}

function matchPhase(state: GameState, ev: Extract<GameEvent, { kind: 'PhaseBegin' }>): void {
	if (!ev.activePlayerId) return;
	for (const source of sources(state, 'phaseBegin')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'phaseBegin')) {
			// --- Track P10 ---
			let matchedHostObj: CardInstance | undefined;
			const phaseAlt = alts.find((a) => {
				// --- Track P22b ---
				if (!matchesP22bPhaseFilter(state, a.filter, source.obj, ev.activePlayerId!, ev.phase)) {
					return false;
				}
				// --- End Track P22b ---
				if (a.filter.enchantedControllerUpkeep) {
					const hostId = source.obj.attachedToId;
					if (!hostId) return false;
					const hostFound = permanentById(state, hostId);
					if (!hostFound || hostFound.controllerId !== ev.activePlayerId) return false;
					matchedHostObj = hostFound.obj;
				}
				if (a.filter.enchantedPlayerUpkeep) {
					if (source.obj.attachedToId !== ev.activePlayerId) return false;
				}
				if (a.filter.enchantedOpponentEndStep) {
					if (ev.phase !== 'end_step' || !isEnchantedPlayerId(source, ev.activePlayerId!)) return false;
				}
				// --- Track P16b ---
				if (a.filter.phaseTurnFilter === 'monarch') {
					if (!state.monarchPlayerId || state.monarchPlayerId !== ev.activePlayerId) return false;
				} else if (
					a.filter.phaseTurnFilter === 'yourFirstUpkeep' ||
					a.filter.phaseTurnFilter === 'firstOfGame'
				) {
					if (
						ev.phase !== 'upkeep' ||
						(a.filter.phaseTurnFilter === 'yourFirstUpkeep' &&
							source.controllerId !== ev.activePlayerId)
					) {
						return false;
					}
					const actPl = state.players.find((p) => p.playerId === ev.activePlayerId);
					if (actPl?.hadUpkeepThisGame) return false;
				}
				const altScope = a.scope ?? ability.trigger.scope ?? 'each_turn';
				if (altScope === 'controller_turn' && source.controllerId !== ev.activePlayerId) {
					return false;
				}
				if (altScope === 'opponent_turn' && source.controllerId === ev.activePlayerId) {
					return false;
				}
				// --- End Track P16b ---
				return true;
			});
			if (!phaseAlt) continue;
			// --- End Track P10 ---
			const step = ev.phase === 'upkeep' ? 'Upkeep' : ev.phase === 'end_step' ? 'End Step' : 'Phase';
			record(state, source, ability, 'phaseBegin', {
				label: source.zone === 'graveyard' ? `Graveyard ${step}` : `${step} Trigger`,
				...(matchedHostObj ? { eventObject: matchedHostObj } : {}),
				// "At the beginning of each opponent's upkeep, that player ...": the active player.
				eventPlayer: ev.activePlayerId ?? undefined
			});
		}
	}
}

const CHAPTER_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'] as const;

function matchCounter(state: GameState, ev: Extract<GameEvent, { kind: 'CounterPlaced' }>): void {
	if (ev.amount <= 0) return;
	if (ev.object.zone === 'battlefield') ev.object.counterPutOnThisTurn = true;
	const candidates = sources(state, 'counterPlaced');
	if (
		ev.object.zone === 'battlefield' &&
		!ev.object.phasedOut &&
		!candidates.some((c) => c.obj.instanceId === ev.objectId) &&
		!permanentHasLostAllAbilities(ev.object, state).lost
	) {
		// --- Track P7 ---
		const card = activeTimedLayer1aForPermanent(state, ev.object)?.card ?? ev.object.copiableCard ?? ev.object.card;
		// --- End Track P7 ---
		for (const faceIndex of activeFacesForObject(ev.object, card, 'battlefield', state)) {
			if (triggersOf(card, faceIndex).events.has('counterPlaced')) {
				candidates.push({
					obj: ev.object,
					card,
					faceIndex,
					controllerId: ev.object.controllerId,
					zone: 'battlefield'
				});
			}
		}
	}
	// --- Track P16b ---
	const foundCounterPerm = permanentById(state, ev.objectId);
	const counterSubject = foundCounterPerm
		? battlefieldSubject(state, foundCounterPerm.obj, foundCounterPerm.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.object.controllerId, false, undefined, undefined, undefined, false, false, { state });
	// --- End Track P16b ---
	for (const source of candidates) {
		for (const { ability, alts } of abilitiesFor(state, source, 'counterPlaced')) {
			const chapterAlt = alts.find((a) => a.isChapterAbility && a.chapterNumbers?.length);
			if (chapterAlt) {
				if (source.obj.instanceId !== ev.objectId) continue;
				// CR 715.2b–c: Chapter N triggers iff lore counters on this Saga went from < N to >= N.
				if (ev.counterType !== 'lore') continue;
				const next = ev.newCount ?? (ev.object.counters.lore || 0);
				const prev = ev.previousCount ?? next - ev.amount;
				// --- Track P15: CR 702.155b Read ahead skips earlier chapters on the turn the Saga entered ---
				const isReadAheadTurn =
					ev.object.readAheadChosenChapter !== undefined &&
					ev.object.enteredTurnSerial !== undefined &&
					ev.object.enteredTurnSerial === (state.turnSerial ?? state.turnNumber);
				// --- End Track P15 ---
				for (const ch of chapterAlt.chapterNumbers!) {
					const triggersChapter = isReadAheadTurn ? prev < ch && next === ch : prev < ch && next >= ch;
					if (triggersChapter) {
						record(state, source, ability, 'counterPlaced', {
							label: `Chapter ${CHAPTER_ROMAN[ch] ?? String(ch)}`,
							amount: ev.amount,
							isChapterAbility: true
						});
					}
				}
				continue;
			}
			// --- Track P16b: non-self permanent counter triggers, putByPlayer, and oneOrMore batching ---
			const matchedAlt = alts.find((a) => {
				if (a.isChapterAbility) return false;
				if (a.filter.counter && a.filter.counter !== ev.counterType) return false;
				// --- Track P19b: ordinal Nth counter threshold on self (prev < N && next >= N) ---
				if (a.filter.nthCounterOnSelf !== undefined) {
					if (source.obj.instanceId !== ev.objectId) return false;
					const nextCnt =
						ev.newCount ??
						((ev.object.counters as Record<string, number>)[ev.counterType] || 0);
					const prevCnt = ev.previousCount ?? nextCnt - ev.amount;
					const n = a.filter.nthCounterOnSelf;
					if (!(prevCnt < n && nextCnt >= n)) return false;
				}
				// --- End Track P19b ---
				if (a.filter.putByPlayer === 'you' && ev.actorId !== source.controllerId) return false;
				if (a.filter.putByPlayer === 'opponent' && (!ev.actorId || ev.actorId === source.controllerId)) {
					return false;
				}
				if (!matchesDuringTurnFilter(state, a.filter.duringTurn, source.controllerId, ev.actorId)) {
					return false;
				}
				return objectMatches(a.filter, counterSubject, source);
			});
			if (!matchedAlt) continue;
			if (matchedAlt.filter.oneOrMore && matchedAlt.filter.object !== 'self') {
				const ch = channel(state);
				if (isResolutionPaused(state) || ch.deferFlush > 0) {
					const batchSet = (ch.counterBatchTriggeredKeys ??= new Set());
					const batchKey = `${source.obj.instanceId}:${source.zone}:${source.faceIndex ?? 0}:${ability.abilityIndex}:${ev.counterType}`;
					if (batchSet.has(batchKey)) continue;
					batchSet.add(batchKey);
				}
			}
			record(state, source, ability, 'counterPlaced', {
				label: 'Counter Placed',
				eventObject: foundCounterPerm?.obj ?? ev.object,
				amount: ev.amount
			});
			// --- End Track P16b ---
		}
	}
}

function matchCounterRemoved(state: GameState, ev: Extract<GameEvent, { kind: 'CounterRemoved' }>): void {
	if (ev.amount <= 0) return;
	const found = permanentById(state, ev.objectId);
	const subject = found
		? battlefieldSubject(state, found.obj, found.controllerId)
		: printedSubject(ev.object, ev.object.copiableCard ?? ev.object.card, ev.object.controllerId);
	const candidates = sources(state, 'counterRemoved');
	if (
		ev.object.zone === 'battlefield' &&
		!ev.object.phasedOut &&
		!candidates.some((c) => c.obj.instanceId === ev.objectId) &&
		!permanentHasLostAllAbilities(ev.object, state).lost
	) {
		// --- Track P7 ---
		const card = activeTimedLayer1aForPermanent(state, ev.object)?.card ?? ev.object.copiableCard ?? ev.object.card;
		// --- End Track P7 ---
		for (const faceIndex of activeFacesForObject(ev.object, card, 'battlefield', state)) {
			if (triggersOf(card, faceIndex).events.has('counterRemoved')) {
				candidates.push({
					obj: ev.object,
					card,
					faceIndex,
					controllerId: ev.object.controllerId,
					zone: 'battlefield'
				});
			}
		}
	}
	for (const source of candidates) {
		for (const { ability, alts } of abilitiesFor(state, source, 'counterRemoved')) {
			const alt = alts.find((a) => {
				if (!objectMatches(a.filter, subject, source)) return false;
				if (a.filter.counter && a.filter.counter !== ev.counterType) return false;
				if (a.filter.lastCounter && !(ev.previousCount > 0 && ev.newCount === 0)) return false;
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'counterRemoved', {
				label: 'Counter Removed',
				eventObject: ev.object,
				amount: ev.amount
			});
		}
	}
}

function matchTargeted(state: GameState, ev: Extract<GameEvent, { kind: 'BecameTarget' }>): void {
	const found = permanentById(state, ev.objectId);
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	const targetBreakdown = inspectCardContinuousBreakdown(found.obj, state);
	// --- Track P13: Valiant — first time targeted by a spell or ability controlled by ev.controllerId this turn ---
	const priorTargeterIds = found.obj.targetedByControllerIdsThisTurn ?? [];
	const wasFirstTargetByController = !priorTargeterIds.includes(ev.controllerId);
	// --- End Track P13 ---
	// --- Track P19b: per-turn target ordinal on permanent ("for the first time each turn") ---
	const targetOrdinal = (found.obj.targetedCountThisTurn = (found.obj.targetedCountThisTurn ?? 0) + 1);
	// --- End Track P19b ---
	for (const source of sources(state, 'becomesTarget')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becomesTarget')) {
			if (ability.ward) {
				if (areOpponentWardTriggersSuppressedWave9(state, ev.controllerId, found.obj)) {
					continue;
				}
				const wardRemoved = targetBreakdown.items.some(
					(it) =>
						it.canonicalKey.startsWith('ward') &&
						it.isInnate &&
						it.removed &&
						it.name.toLowerCase() === ability.text.toLowerCase()
				);
				if (wardRemoved) continue;
			}
			const alt = alts.find((a) => {
				// --- Track P16b ---
				if (a.filter.targetPlayer && a.filter.object === undefined) return false;
				// --- End Track P16b ---
				if (a.filter.targetedBy !== 'spellOrAbility' && a.filter.targetedBy !== ev.by) return false;
				if (
					a.filter.targetedByActivatedAbility &&
					(ev.by !== 'ability' || state.stack.find((s) => s.id === ev.stackItemId)?.kind !== 'activated')
				) {
					return false;
				}
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.controllerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.controllerId === source.controllerId) return false;
				// --- Track P13: Valiant ---
				if (a.filter.firstTimeTargetedByYouThisTurn) {
					if (ev.controllerId !== source.controllerId || !wasFirstTargetByController) return false;
				}
				// --- End Track P13 ---
				// --- Track P19b ---
				if (a.filter.firstTimeEachTurn && targetOrdinal !== 1) return false;
				if (a.filter.nthEventThisTurn !== undefined && targetOrdinal !== a.filter.nthEventThisTurn) {
					return false;
				}
				// --- End Track P19b ---
				// --- Track P16b ---
				if (
					a.filter.targetingSourceFilter &&
					!matchesTargetingSourceFilter(
						state,
						ev.stackItemId,
						ev.by,
						ev.controllerId,
						a.filter.targetingSourceFilter,
						source
					)
				) {
					return false;
				}
				// --- End Track P16b ---
				return objectMatches(a.filter, subject, source);
			});
			if (alt) {
				const label = ability.ward ? 'Ward' : alt.filter.firstTimeTargetedByYouThisTurn ? 'Valiant' : 'Targeted';
				record(state, source, ability, 'becomesTarget', {
					label,
					eventObject: found.obj,
					targetStackItemId: ev.stackItemId,
					// --- Track P7 ---
					eventPlayerId: ev.controllerId,
					eventPlayer: ev.controllerId
					// --- End Track P7 ---
				});
			}
		}
	}
	// --- Track P13: Record controllerId after evaluating becomesTarget triggers ---
	if (wasFirstTargetByController) {
		(found.obj.targetedByControllerIdsThisTurn ??= []).push(ev.controllerId);
	}
	// --- End Track P13 ---
	// CR 702.21a / 702.21b: Granted Ward instances (via continuous effects or temporary grants)
	// also trigger separately when targeted by a spell or ability an opponent controls.
	if (ev.controllerId !== found.controllerId) {
		for (const item of targetBreakdown.items) {
			if (!item.canonicalKey.startsWith('ward') || item.removed) continue;
			let grantedCount = 0;
			if (item.grantCount !== undefined) {
				grantedCount = item.grantCount;
			} else {
				for (const src of item.sources) {
					if (src !== 'innate' || found.obj.isFaceDown) grantedCount += 1;
				}
			}
			if (grantedCount <= 0) continue;
			const rawCost = item.name.replace(/^ward\s*[—-]?\s*/i, '').trim() || '{1}';
			const parsed = parseCost(rawCost);
			// --- Track P12 ---
			const supported = Boolean(
				parsed.unparsed.length === 0 &&
					parsed.defs.length > 0 &&
					parsed.defs.every((d) => !(d.k === 'mana' && /\{X\}/i.test(d.cost)))
			);
			// --- End Track P12 ---
			if (!supported) continue;
			const syntheticWard: RuntimeTrigger = {
				abilityIndex: -2,
				trigger: {
					event: 'becomesTarget',
					filter: { object: 'self', targetedBy: 'spellOrAbility', player: { relation: 'opponent' } }
				},
				effectSupported: true,
				text: item.name,
				ward: { cost: rawCost, costDefs: parsed.defs }
			};
			const source: Source = {
				obj: found.obj,
				card: found.obj.copiableCard ?? found.obj.card,
				controllerId: found.controllerId,
				zone: 'battlefield'
			};
			record(state, source, syntheticWard, 'becomesTarget', {
				label: 'Ward',
				times: grantedCount,
				eventObject: found.obj,
				targetStackItemId: ev.stackItemId
			});
		}
	}
}

function matchAttached(state: GameState, ev: Extract<GameEvent, { kind: 'Attached' }>): void {
	const attachment = permanentById(state, ev.attachmentId);
	const hostObj = permanentById(state, ev.hostId);
	if (!attachment || !hostObj) return;
	const attachmentSubject = battlefieldSubject(state, attachment.obj, attachment.controllerId);
	const hostSubject = battlefieldSubject(state, hostObj.obj, hostObj.controllerId);
	for (const source of sources(state, 'attached')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'attached')) {
			const alt = alts.find(
				(a) =>
					objectMatches(a.filter, attachmentSubject, source) &&
					(!a.filter.host || filterMatches(a.filter.host, hostSubject, viewerOf(source))) &&
					// --- Track P22b ---
					(!a.filter.hostSelf || hostObj.obj.instanceId === source.obj.instanceId)
					// --- End Track P22b ---
			);
			if (alt) record(state, source, ability, 'attached', { label: 'On Attach', eventObject: hostObj.obj });
		}
	}
}

// ---- Flushing: APNAP order (CR 603.3b) ------------------------------------------------------

/**
 * Players in APNAP order: the active player, then the others in turn order (CR 101.4). Players who
 * have left the game control no triggers (CR 800.4a).
 */
function apnap(state: GameState): string[] {
	const n = state.players.length;
	const out: string[] = [];
	for (let k = 0; k < n; k++) {
		const p = state.players[(state.activePlayerIndex + k) % n];
		if (p && !p.lost) out.push(p.playerId);
	}
	return out;
}

/**
 * Puts every pending trigger on the stack (or resolves a triggered mana ability inline). The active
 * player's triggers are put on the stack first, then each other player's in turn order (CR 603.3b),
 * so the last non-active player's resolve first. A player's own simultaneous triggers go on in match
 * order (event order, then seat/zone order of their sources); the getTriggerHost() then lets the player
 * reorder them (`orderSimultaneous`, CR 603.3b).
 *
 * Inline (mana) triggers run before stacked ones are pushed. Triggers that fire while a flush is
 * running are flushed by the nested flush or by the next loop iteration.
 */
export function flushTriggers(state: GameState): void {
	const trigHost = getTriggerHost();
	if (!trigHost) return;
	const ch = channel(state);
	if (ch.deferFlush > 0) return;
	if (isResolutionPaused(state)) {
		if (ch.pending.length > 0) {
			persistPendingTriggers(state, ch.pending.splice(0));
		}
		return;
	}
	hydratePendingTriggers(state, ch);
	ch.flushing += 1;
	try {
		for (
			let guard = 0;
			(ch.pending.length > 0 || (state.pendingReflexiveTriggers?.length ?? 0) > 0) && guard < 1000;
			guard++
		) {
			if (isResolutionPaused(state)) {
				if (ch.pending.length > 0) persistPendingTriggers(state, ch.pending.splice(0));
				return;
			}
			const batch = ch.pending.splice(0);
			if (state.status === 'finished') return;
			if (batch.length > 0) {
				const order = apnap(state);
				const byPlayer = (mode: TriggerMode, pid: string) =>
					batch.filter((t) => t.mode === mode && t.controllerId === pid).sort((a, b) => a.order - b.order);
				const inline = [...order].reverse().flatMap((pid) => byPlayer('inline', pid));
				const stacked = order.flatMap((pid) => byPlayer('stack', pid));
				for (const t of inline) {
					if ((state.status as GameState['status']) === 'finished') return;
					// CR 603.4: checked again as it resolves.
					if (t.ability.condition && !evaluateCondition(state, t.ability.condition, t.controllerId, t.source.instanceId)) continue;
					trigHost.executeInline(state, t);
				}
				for (const pid of order) {
					const ids: string[] = [];
					for (const t of stacked) {
						if (t.controllerId !== pid) continue;
						const item = trigHost.putOnStack(state, t);
						if (item) ids.push(item.id);
					}
					if (ids.length > 1) trigHost.orderSimultaneous?.(state, pid, ids);
				}
			}
			// --- Track P10 (CR 603.12): Flush queued reflexive triggers in APNAP order without doubling ---
			if ((state.pendingReflexiveTriggers?.length ?? 0) > 0 && !isResolutionPaused(state)) {
				flushPendingReflexiveTriggers(state);
			}
			// --- End Track P10 ---
		}
	} finally {
		ch.flushing -= 1;
		// --- Track P16b ---
		if (ch.flushing === 0) {
			ch.discardBatchTriggeredKeys = undefined;
			ch.counterBatchTriggeredKeys = undefined;
			ch.zoneBatchTriggeredKeys = undefined;
		}
		// --- End Track P16b ---
	}
}

/**
 * Resolves only pending triggered mana abilities (`mode === 'inline'`, CR 605.4a) immediately,
 * leaving normal stack triggers (`mode === 'stack'`) pending until the next `flushTriggers`
 * (when a player would receive priority, CR 603.3).
 */
export function flushInlineTriggers(state: GameState): void {
	const trigHost = getTriggerHost();
	if (!trigHost) return;
	const ch = channel(state);
	if (ch.deferFlush > 0) return;
	ch.flushing += 1;
	try {
		for (let guard = 0; guard < 1000; guard++) {
			if (!ch.pending.some((t) => t.mode === 'inline')) break;
			const inlineBatch: PendingTrigger[] = [];
			const remaining: PendingTrigger[] = [];
			for (const t of ch.pending) {
				if (t.mode === 'inline') inlineBatch.push(t);
				else remaining.push(t);
			}
			ch.pending = remaining;
			if (state.status === 'finished') return;
			const order = apnap(state);
			const byPlayer = (pid: string) =>
				inlineBatch.filter((t) => t.controllerId === pid).sort((a, b) => a.order - b.order);
			const inline = [...order].reverse().flatMap((pid) => byPlayer(pid));
			for (const t of inline) {
				if ((state.status as GameState['status']) === 'finished') return;
				if (t.ability.condition && !evaluateCondition(state, t.ability.condition, t.controllerId, t.source.instanceId)) continue;
				trigHost.executeInline(state, t);
			}
		}
	} finally {
		ch.flushing -= 1;
	}
}

// ---- Intervening-if conditions (CR 603.4) ---------------------------------------------------

/**
 * Re-checks the intervening-if condition of a triggered ability on the stack (CR 603.4). True if the
 * item has no compiled condition.
 */
export function stackTriggerConditionHolds(
	state: GameState,
	card: ScryfallCard,
	abilityIndex: number,
	controllerId: string,
	sourceInstanceId: string,
	stackItem?: StackItem
): boolean {
	// --- Track P18a: Soulbond other-creature ETB intervening-if (CR 702.95a, CR 603.4) ---
	if (stackItem?.wave6Tag === 'soulbond_other') {
		return evaluateCondition(
			state,
			{ k: 'not', of: { k: 'isPaired' } },
			controllerId,
			sourceInstanceId,
			stackItem
		);
	}
	// --- End Track P18a ---
	// --- Track P9 ---
	if (stackItem?.grantedKeyword) {
		const rawKw = stackItem.grantedKeyword.trim();
		let spec = getKeywordSpec(rawKw);
		let n: number | undefined;
		if (!spec) {
			const m = /^(.+?)\s+(\d+)$/.exec(rawKw);
			if (m) {
				spec = getKeywordSpec(m[1]!);
				n = Number.parseInt(m[2]!, 10);
			}
		}
		if (spec?.implementation?.kind === 'trigger') {
			const built = spec.implementation.buildTriggers(
				{ name: spec.name, ...(n !== undefined ? { n } : {}) },
				-1,
				{ start: 0, end: 0 }
			);
			const cond = built[0]?.condition;
			if (!cond) return true;
			return evaluateCondition(state, cond, controllerId, sourceInstanceId, stackItem);
		}
	}
	// --- Track P10 ---
	if (stackItem?.grantedAbilityText) {
		const quoted = quotedTriggersForTexts(card.name, [stackItem.grantedAbilityText], {
			includeLayer6Keywords: true
		})[0];
		if (!quoted?.ability.condition) return true;
		return evaluateCondition(state, quoted.ability.condition, controllerId, sourceInstanceId, stackItem);
	}
	// --- End Track P10 ---
	// --- Track P11: Layer 6 granted triggered ability intervening-if check (CR 603.4) ---
	if (stackItem?.grantFaceIndex !== undefined && stackItem?.grantAbilityIndex !== undefined) {
		const grantedRt = resolveGrantedRuntimeTrigger(
			stackItem.grantSourceCard ?? card,
			stackItem.grantFaceIndex,
			stackItem.grantAbilityIndex
		);
		if (!grantedRt?.condition) return true;
		return evaluateCondition(state, grantedRt.condition, controllerId, sourceInstanceId, stackItem);
	}
	// --- End Track P11 ---
	if (stackItem?.delayedSubStepIndex !== undefined) return true;
	const ability = triggersOf(card, stackItem?.faceIndex ?? 0).all.find((t) => t.abilityIndex === abilityIndex);
	if (!ability?.condition) return true;
	return evaluateCondition(state, ability.condition, controllerId, sourceInstanceId, stackItem);
}

