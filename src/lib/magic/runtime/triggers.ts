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
import { getKeywordSpec, GRANTED_TRIGGER_KEYWORD_EVENTS } from '../keywords.ts';
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
import { activeAbilityDefs, instanceFaceOptions, matchesColorFilter, resolveObjectFaces, stackItemFaceOptions } from './faces.ts';
import {
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

/**
 * How a pending trigger is executed. 'stack': a StackItem put on the stack the next time a player
 * would receive priority, which resolves when all players pass (CR 603.3). 'inline': a triggered
 * mana ability, which resolves immediately (CR 605.1b, 605.4a). See `modeFor`.
 */
export type TriggerMode = 'stack' | 'inline';

export interface PendingTrigger {
	ability: RuntimeTrigger;
	/** The object whose ability triggered (for a leaves-the-battlefield trigger, the object that left). */
	source: CardInstance;
	/** The card whose ability it is: copiable values (CR 707.2), or the look-back card (CR 603.10a). */
	sourceCard: ScryfallCard;
	faceIndex?: number;
	controllerId: string;
	mode: TriggerMode;
	/** Short description for titles and the log ("ETB", "Landfall", "Attack", ...). */
	label: string;
	/** The object the event was about, when it isn't the source ("that creature"). */
	eventObject?: CardInstance;
	/** The player dealt damage (the pre-IR engine passed this player to legacy effects as a target). */
	eventPlayerId?: string;
	/** "That player": the player the event was about (dealt damage, the caster, the active player). */
	eventPlayer?: string;
	/** The defending player for an attack trigger (CR 508.5, 702.86a). */
	defendingPlayerId?: string;
	/** The stack item that targeted this permanent (for Ward). */
	targetStackItemId?: string;
	/** The amount the event carried: damage dealt, or the entering creature's power. */
	amount?: number;
	/** How the event object last existed on the battlefield (dies / leaves triggers, CR 603.10a). */
	eventLki?: {
		controllerId: string;
		power?: number;
		toughness?: number;
		// --- Track P9 ---
		counters?: Partial<Record<CounterType, number>>;
	};
	/** LKI snapshot of the stack item that triggered a `'cast'` trigger (CR 707.10, 702.40a). */
	triggerEventStackItem?: StackItem;
	/** Snapshot of spells cast before this spell in the current turn (CR 702.40a). */
	stormCount?: number;
	/** CR 715.2 / 704.5s: True when this pending trigger is a Saga chapter ability. */
	isChapterAbility?: boolean;
	sourceForetold?: boolean;
	sourceBlitzed?: boolean;
	// --- Track P4 ---
	sourceExertedThisTurn?: boolean;
	sourceChosenSubType?: string;
	sourceChosenColor?: ManaColor;
	// --- Track P5 ---
	sourceMonstrous?: boolean;
	isBecameMonstrous?: boolean;
	// --- Track P7 ---
	sourceWasCast?: boolean;
	sourceCastFromZone?: ZoneType;
	// --- End Track P7 ---
	// --- Track P10 ---
	grantedAbilityText?: string;
	// --- End Track P10 ---
	// --- Track P11 ---
	grantSourceCard?: ScryfallCard;
	grantFaceIndex?: number;
	grantAbilityIndex?: number;
	sourceChosenCardName?: string;
	// --- End Track P11 ---
	// --- Track P12 ---
	sourceIsRenowned?: boolean;
	sourceDevouredCount?: number;
	wave4Tag?: string;
	wave4N?: number;
	wave4CostText?: string;
	// --- End Track P12 ---
	// --- Track P15 ---
	gravestormCount?: number;
	sourceGiftPromised?: boolean;
	sourceEnteredWithX?: number;
	sourceCastWithImpending?: boolean;
	giftKind?: 'card' | 'food' | 'treasure' | 'tappedFish' | 'octopus' | 'extraTurn';
	giftRecipientId?: string;
	wave5Tag?: string;
	wave5N?: number;
	wave5CostText?: string;
	wave5Card?: ScryfallCard;
	// --- End Track P15 ---
	/** Match order (deterministic tie-break for a player's own simultaneous triggers). */
	order: number;
}

/** What the engine provides to execute triggers (injected to avoid an import cycle with engine.ts). */
export interface TriggerHost {
	/** Resolves one triggered ability now. The single place trigger effects are executed. */
	executeInline(state: GameState, trigger: PendingTrigger): void;
	/**
	 * Puts one triggered ability on the stack, choosing its targets (CR 603.3d). Returns the stack
	 * item, or null if the ability was removed (no legal targets).
	 */
	putOnStack(state: GameState, trigger: PendingTrigger): { id: string } | null;
	/**
	 * Called after a player's simultaneous triggers are on the stack (in match order), so the player
	 * can choose their order (CR 603.3b). `itemIds` are bottom-to-top.
	 */
	orderSimultaneous?(state: GameState, controllerId: string, itemIds: string[]): void;
	/**
	 * Whether the engine can execute this ability at all (legacy effects, or a compiled effect the IR
	 * interpreter supports). Abilities it can't execute never trigger.
	 */
	canExecute?(trigger: RuntimeTrigger): boolean;
}

let host: TriggerHost | null = null;

export function registerTriggerHost(h: TriggerHost): void {
	host = h;
}

// ---- Compiled triggers per card -------------------------------------------------------------

interface CardTriggers {
	all: RuntimeTrigger[];
	/** Event kinds any alternative of any ability listens to. */
	events: Set<EventKind>;
	/** Event kinds of parameterless grantable trigger keywords granted by continuous statics on this card. */
	grantedTriggerEvents: Set<EventKind>;
}

const CARD_TRIGGERS = new WeakMap<ScryfallCard, Map<number, CardTriggers>>();

function grantedTriggerEventsForKeyword(kw: string): readonly EventKind[] | null {
	// --- Track P12 ---
	const parsedWave4 = parseGrantedWave4TriggerKeyword(kw);
	if (parsedWave4) {
		switch (parsedWave4.base) {
			case 'decayed':
			case 'dethrone':
			case 'enlist':
			case 'firebending':
			case 'melee':
			case 'mentor':
			case 'mobilize':
			case 'myriad':
			case 'training':
				return ['attacks'];
			case 'afflict':
			case 'rampage':
				return ['becomesBlocked'];
			case 'ingest':
			case 'renown':
				return ['dealsDamage'];
		}
	}
	// --- End Track P12 ---
	const spec = getKeywordSpec(kw);
	if (
		spec?.status === 'implemented' &&
		spec.grantable &&
		spec.parameterKind === 'none' &&
		spec.implementation?.kind === 'trigger'
	) {
		return spec.implementation.events;
	}
	return null;
}

function triggersOf(card: ScryfallCard, faceIndex = 0): CardTriggers {
	let byFace = CARD_TRIGGERS.get(card);
	if (!byFace) {
		byFace = new Map();
		CARD_TRIGGERS.set(card, byFace);
	}
	let entry = byFace.get(faceIndex);
	if (!entry) {
		const def = compileCard(card);
		const faceAbs = def.faces[faceIndex]?.abilities ?? [];
		// --- Track P12 ---
		const baseRts = runtimeTriggers(def, faceIndex).map((rt): Wave4RuntimeTrigger =>
			attachWave4TagToBaseRuntimeTrigger(rt, faceAbs)
		);
		const all: RuntimeTrigger[] = baseRts.filter(
			(t) => Boolean(t.wave4Tag) || !host?.canExecute || host.canExecute(t)
		);
		// --- End Track P12 ---
		const events = new Set<EventKind>();
		for (const t of all) for (const alt of alternatives(t.trigger)) events.add(alt.event);
		const grantedTriggerEvents = new Set<EventKind>();
		for (const ab of def.faces[faceIndex]?.abilities ?? []) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				ab.static.mod.k === 'addKeywords'
			) {
				for (const kw of ab.static.mod.keywords) {
					const evs = grantedTriggerEventsForKeyword(kw);
					if (evs) for (const ev of evs) grantedTriggerEvents.add(ev);
				}
			}
		}
		entry = { all, events, grantedTriggerEvents };
		byFace.set(faceIndex, entry);
	}
	return entry;
}

function activeFacesForObject(
	obj: CardInstance,
	card: ScryfallCard,
	zone: ZoneType,
	state?: GameState,
	overrideFace?: { activeFaceIndex?: number; unlockedFaces?: number[] }
): number[] {
	if (zone === 'stack' && state) {
		const stk = state.stack.find((s) => s.sourceInstanceId === obj.instanceId);
		if (stk) return resolveObjectFaces(card, stackItemFaceOptions(stk)).activeFaceIndices;
	}
	const opts = instanceFaceOptions(obj, zone);
	// --- Track P7 ---
	if (zone === 'battlefield' && state) {
		const timedL1a = activeTimedLayer1aForPermanent(state, obj);
		if (timedL1a) {
			opts.copiableState = timedL1a;
			opts.faceIndex = timedL1a.faceIndex ?? 0;
			opts.isSingleFaceCopy = timedL1a.isSingleFaceCopy;
			opts.prototyped = Boolean(timedL1a.prototyped);
		}
	}
	// --- End Track P7 ---
	if (overrideFace?.activeFaceIndex !== undefined) opts.faceIndex = overrideFace.activeFaceIndex;
	if (overrideFace?.unlockedFaces !== undefined) opts.unlockedFaces = overrideFace.unlockedFaces;
	return resolveObjectFaces(card, opts).activeFaceIndices;
}

/** "Whenever ~ enters or attacks": the main TriggerDef and each `or` alternative. */
function alternatives(def: TriggerDef): TriggerDef[] {
	return def.or ? [def, ...def.or] : [def];
}

// ---- Pending queue (transient, never in GameState) ------------------------------------------

interface SimultaneousLkiEntry {
	obj: CardInstance;
	card: ScryfallCard;
	controllerId: string;
	lostAllAbilities: boolean;
	typeLine: string;
	hasAllCreatureTypes: boolean;
	tapped: boolean;
	colors: string[];
	power?: number;
	toughness?: number;
	attachedIds?: string[];
	activeFaceIndex?: number;
	unlockedFaces?: number[];
	foretold?: boolean;
	blitzed?: boolean;
	saddled?: boolean;
	exerted?: boolean;
	chosenSubType?: string;
	chosenColor?: ManaColor;
	monstrous?: boolean;
	counters?: Partial<Record<CounterType, number>>;
	// --- Track P7 ---
	wasCast?: boolean;
	castFromZone?: ZoneType;
	// --- Track P9 ---
	grantedDeathKeywords?: Record<string, number>;
	// --- Track P10 ---
	damagedByThisTurn?: Array<{ sourceId: string; sourceVersion?: number }>;
	grantedAbilityTexts?: string[];
	// --- End Track P10 ---
	// --- Track P11 ---
	chosenCardName?: string;
	grantedTriggers?: GrantedTriggeredAbilityInstance[];
	// --- End Track P11 ---
}

// --- Track P11: Transient pre-LTB Layer 6 granted triggered abilities (CR 603.10a) ---
const preLeaveGrantedTriggers = new WeakMap<CardInstance, GrantedTriggeredAbilityInstance[]>();

export function stashPreLeaveGrantedTriggers(state: GameState, perm: CardInstance): void {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return;
	const granted = collectActiveGrantedTriggeredAbilities(state, perm);
	if (granted.length > 0) {
		preLeaveGrantedTriggers.set(perm, granted);
	} else {
		preLeaveGrantedTriggers.delete(perm);
	}
}
// --- End Track P11 ---

interface TriggerChannel {
	pending: PendingTrigger[];
	nextOrder: number;
	flushing: number;
	deferFlush: number;
	simultaneousLki?: Map<CardInstance, SimultaneousLkiEntry>;
	// --- Track P13: CR 603.2c oneOrMore simultaneous zone-change batching ---
	zoneBatchTriggeredKeys?: Set<string>;
	// --- End Track P13 ---
}

const channels = new WeakMap<GameState, TriggerChannel>();

function channel(state: GameState): TriggerChannel {
	let ch = channels.get(state);
	if (!ch) {
		const maxDeferredOrder = (state.pendingTriggers ?? []).reduce((m, t) => Math.max(m, t.order), 0);
		ch = { pending: [], nextOrder: maxDeferredOrder + 1, flushing: 0, deferFlush: 0 };
		channels.set(state, ch);
	}
	return ch;
}

function isResolutionPaused(state: GameState): boolean {
	return (
		Boolean(state.pendingCostPayment) ||
		Boolean(state.pendingProcedure) ||
		Boolean(state.pendingZoneMoves && state.pendingZoneMoves.length > 0) ||
		state.pendingPrompts.some(
			(pr) => pr.choice?.kind === 'chooseReplacement' || pr.kind === 'chooseReplacement'
		) ||
		state.stack.some((s) => Boolean(s.resolutionStarted))
	);
}

function persistPendingTriggers(state: GameState, triggers: PendingTrigger[]): void {
	if (triggers.length === 0) return;
	const existing = state.pendingTriggers ?? (state.pendingTriggers = []);
	for (const t of triggers) {
		existing.push({
			ability: t.ability,
			source: t.source,
			sourceCard: t.sourceCard,
			...(t.faceIndex !== undefined ? { faceIndex: t.faceIndex } : {}),
			controllerId: t.controllerId,
			mode: t.mode,
			label: t.label,
			...(t.eventObject ? { eventObject: t.eventObject } : {}),
			...(t.eventPlayerId !== undefined ? { eventPlayerId: t.eventPlayerId } : {}),
			...(t.eventPlayer !== undefined ? { eventPlayer: t.eventPlayer } : {}),
			...(t.defendingPlayerId !== undefined ? { defendingPlayerId: t.defendingPlayerId } : {}),
			...(t.targetStackItemId !== undefined ? { targetStackItemId: t.targetStackItemId } : {}),
			...(t.amount !== undefined ? { amount: t.amount } : {}),
			...(t.eventLki ? { eventLki: t.eventLki } : {}),
			...(t.triggerEventStackItem ? { triggerEventStackItem: t.triggerEventStackItem } : {}),
			...(t.stormCount !== undefined ? { stormCount: t.stormCount } : {}),
			...(t.isChapterAbility ? { isChapterAbility: true } : {}),
			...(t.sourceForetold ? { sourceForetold: true } : {}),
			...(t.sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(t.sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(t.sourceChosenSubType ? { sourceChosenSubType: t.sourceChosenSubType } : {}),
			...(t.sourceChosenColor ? { sourceChosenColor: t.sourceChosenColor } : {}),
			...(t.sourceMonstrous ? { sourceMonstrous: true } : {}),
			...(t.isBecameMonstrous ? { isBecameMonstrous: true } : {}),
			// --- Track P7 ---
			...(t.sourceWasCast ? { sourceWasCast: true } : {}),
			...(t.sourceCastFromZone ? { sourceCastFromZone: t.sourceCastFromZone } : {}),
			// --- End Track P7 ---
			// --- Track P10 ---
			...(t.grantedAbilityText ? { grantedAbilityText: t.grantedAbilityText } : {}),
			// --- End Track P10 ---
			// --- Track P11 ---
			...(t.grantSourceCard ? { grantSourceCard: t.grantSourceCard } : {}),
			...(t.grantFaceIndex !== undefined ? { grantFaceIndex: t.grantFaceIndex } : {}),
			...(t.grantAbilityIndex !== undefined ? { grantAbilityIndex: t.grantAbilityIndex } : {}),
			...(t.sourceChosenCardName ? { sourceChosenCardName: t.sourceChosenCardName } : {}),
			// --- End Track P11 ---
			// --- Track P12 ---
			...(t.sourceIsRenowned ? { sourceIsRenowned: true } : {}),
			...(t.sourceDevouredCount !== undefined ? { sourceDevouredCount: t.sourceDevouredCount } : {}),
			...(t.wave4Tag ? { wave4Tag: t.wave4Tag } : {}),
			...(t.wave4N !== undefined ? { wave4N: t.wave4N } : {}),
			...(t.wave4CostText !== undefined ? { wave4CostText: t.wave4CostText } : {}),
			// --- End Track P12 ---
			// --- Track P15 ---
			...(t.gravestormCount !== undefined ? { gravestormCount: t.gravestormCount } : {}),
			...(t.sourceGiftPromised ? { sourceGiftPromised: true } : {}),
			...(t.sourceEnteredWithX !== undefined ? { sourceEnteredWithX: t.sourceEnteredWithX } : {}),
			...(t.sourceCastWithImpending ? { sourceCastWithImpending: true } : {}),
			...(t.giftKind ? { giftKind: t.giftKind } : {}),
			...(t.giftRecipientId ? { giftRecipientId: t.giftRecipientId } : {}),
			...(t.wave5Tag ? { wave5Tag: t.wave5Tag } : {}),
			...(t.wave5N !== undefined ? { wave5N: t.wave5N } : {}),
			...(t.wave5CostText !== undefined ? { wave5CostText: t.wave5CostText } : {}),
			...(t.wave5Card ? { wave5Card: t.wave5Card } : {}),
			// --- End Track P15 ---
			order: t.order
		});
	}
}

function hydratePendingTriggers(state: GameState, ch: TriggerChannel): void {
	const deferred = state.pendingTriggers;
	if (!deferred || deferred.length === 0) return;
	delete state.pendingTriggers;
	const hydrated: PendingTrigger[] = deferred.map((t: SerializedPendingTrigger) => ({
		ability: t.ability,
		source: t.source,
		sourceCard: t.sourceCard,
		...(t.faceIndex !== undefined ? { faceIndex: t.faceIndex } : {}),
		controllerId: t.controllerId,
		mode: t.mode,
		label: t.label,
		...(t.eventObject ? { eventObject: t.eventObject } : {}),
		...(t.eventPlayerId !== undefined ? { eventPlayerId: t.eventPlayerId } : {}),
		...(t.eventPlayer !== undefined ? { eventPlayer: t.eventPlayer } : {}),
		...(t.defendingPlayerId !== undefined ? { defendingPlayerId: t.defendingPlayerId } : {}),
		...(t.targetStackItemId !== undefined ? { targetStackItemId: t.targetStackItemId } : {}),
		...(t.amount !== undefined ? { amount: t.amount } : {}),
		...(t.eventLki ? { eventLki: t.eventLki } : {}),
		...(t.triggerEventStackItem ? { triggerEventStackItem: t.triggerEventStackItem } : {}),
		...(t.stormCount !== undefined ? { stormCount: t.stormCount } : {}),
		...(t.isChapterAbility ? { isChapterAbility: true } : {}),
		...(t.sourceForetold ? { sourceForetold: true } : {}),
		...(t.sourceBlitzed ? { sourceBlitzed: true } : {}),
		...(t.sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
		...(t.sourceChosenSubType ? { sourceChosenSubType: t.sourceChosenSubType } : {}),
		...(t.sourceChosenColor ? { sourceChosenColor: t.sourceChosenColor } : {}),
		...(t.sourceMonstrous ? { sourceMonstrous: true } : {}),
		...(t.isBecameMonstrous ? { isBecameMonstrous: true } : {}),
		// --- Track P7 ---
		...(t.sourceWasCast ? { sourceWasCast: true } : {}),
		...(t.sourceCastFromZone ? { sourceCastFromZone: t.sourceCastFromZone } : {}),
		// --- End Track P7 ---
		// --- Track P10 ---
		...(t.grantedAbilityText ? { grantedAbilityText: t.grantedAbilityText } : {}),
		// --- End Track P10 ---
		// --- Track P11 ---
		...(t.grantSourceCard ? { grantSourceCard: t.grantSourceCard } : {}),
		...(t.grantFaceIndex !== undefined ? { grantFaceIndex: t.grantFaceIndex } : {}),
		...(t.grantAbilityIndex !== undefined ? { grantAbilityIndex: t.grantAbilityIndex } : {}),
		...(t.sourceChosenCardName ? { sourceChosenCardName: t.sourceChosenCardName } : {}),
		// --- End Track P11 ---
		// --- Track P12 ---
		...(t.sourceIsRenowned ? { sourceIsRenowned: true } : {}),
		...(t.sourceDevouredCount !== undefined ? { sourceDevouredCount: t.sourceDevouredCount } : {}),
		...(t.wave4Tag ? { wave4Tag: t.wave4Tag } : {}),
		...(t.wave4N !== undefined ? { wave4N: t.wave4N } : {}),
		...(t.wave4CostText !== undefined ? { wave4CostText: t.wave4CostText } : {}),
		// --- End Track P12 ---
		// --- Track P15 ---
		...(t.gravestormCount !== undefined ? { gravestormCount: t.gravestormCount } : {}),
		...(t.sourceGiftPromised ? { sourceGiftPromised: true } : {}),
		...(t.sourceEnteredWithX !== undefined ? { sourceEnteredWithX: t.sourceEnteredWithX } : {}),
		...(t.sourceCastWithImpending ? { sourceCastWithImpending: true } : {}),
		...(t.giftKind ? { giftKind: t.giftKind } : {}),
		...(t.giftRecipientId ? { giftRecipientId: t.giftRecipientId } : {}),
		...(t.wave5Tag ? { wave5Tag: t.wave5Tag } : {}),
		...(t.wave5N !== undefined ? { wave5N: t.wave5N } : {}),
		...(t.wave5CostText !== undefined ? { wave5CostText: t.wave5CostText } : {}),
		...(t.wave5Card ? { wave5Card: t.wave5Card } : {}),
		// --- End Track P15 ---
		order: t.order
	}));
	ch.pending = [...hydrated, ...ch.pending];
	const maxOrder = hydrated.reduce((m, t) => Math.max(m, t.order), 0);
	if (ch.nextOrder <= maxOrder) ch.nextOrder = maxOrder + 1;
}

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
		const grantedDeathKeywords = lost ? undefined : extractGrantedDeathKeywords(state, perm, ev);
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
				if (!state.timedContinuousEffects?.length || lost) return {};
				const ver = perm.objectVersion || 1;
				const texts: string[] = [];
				for (const eff of state.timedContinuousEffects) {
					if (!eff.layer6?.grantedAbilityTexts?.length) continue;
					if (
						eff.affected.some(
							(a) => a.instanceId === perm.instanceId && (a.objectVersion ?? 1) === ver
						)
					) {
						texts.push(...eff.layer6.grantedAbilityTexts);
					}
				}
				return texts.length > 0 ? { grantedAbilityTexts: texts } : {};
			})(),
			// --- End Track P10 ---
			// --- Track P11 ---
			...(perm.chosenCardName ? { chosenCardName: perm.chosenCardName } : {}),
			grantedTriggers: collectActiveGrantedTriggeredAbilities(state, perm)
			// --- End Track P11 ---
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

// --- Track P13: Simultaneous zone-change batch wrapper for multi-token / mass ETB or LTB (CR 603.2c) ---
export function withSimultaneousZoneBatch<T>(state: GameState, fn: () => T): T {
	const ch = channel(state);
	if (ch.zoneBatchTriggeredKeys) return fn();
	const prev = ch.zoneBatchTriggeredKeys;
	ch.zoneBatchTriggeredKeys = new Set();
	try {
		return fn();
	} finally {
		ch.zoneBatchTriggeredKeys = prev;
	}
}
// --- End Track P13 ---

/**
 * Runs `fn` with trigger placement deferred: triggers that fire inside it wait until it returns, so
 * a resolving spell or ability finishes before its triggers are put on the stack and their targets
 * chosen (CR 603.3: the next time a player would receive priority). Triggered mana abilities wait
 * too; nothing inside a resolution needs mana.
 */
export function withTriggersDeferred<T>(state: GameState, fn: () => T): T {
	const ch = channel(state);
	ch.deferFlush += 1;
	try {
		return fn();
	} finally {
		ch.deferFlush -= 1;
	}
}

export function hasPendingTriggers(state: GameState): boolean {
	return (
		(channels.get(state)?.pending.length ?? 0) > 0 ||
		(state.pendingTriggers?.length ?? 0) > 0 ||
		// --- Track P10 ---
		(state.pendingReflexiveTriggers?.length ?? 0) > 0
		// --- End Track P10 ---
	);
}

/** For tests: the triggers waiting for the next flush. */
export function peekPendingTriggers(state: GameState): readonly PendingTrigger[] {
	return [...(state.pendingTriggers ?? []), ...(channels.get(state)?.pending ?? [])];
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

// ---- Objects as triggers see them -----------------------------------------------------------

/** The object an event is about, with the characteristics trigger filters check. */
interface Subject {
	obj: CardInstance;
	controllerId: string;
	isToken: boolean;
	tapped: boolean;
	saddled?: boolean;
	monstrous?: boolean;
	// --- Track P10 ---
	suspected?: boolean;
	// --- End Track P10 ---
	// --- Track P15 ---
	isPrepared?: boolean;
	// --- End Track P15 ---
	colors: string[];
	typeLine: () => string;
	hasSubtype: (subtype: string) => boolean;
	// --- Track P7 ---
	power: () => number | undefined;
	toughness: () => number | undefined;
	manaValue: () => number;
	// --- End Track P7 ---
	// --- Track P11 ---
	name: () => string;
	attachedToId: string | null;
	isFaceDown: boolean;
	// --- End Track P11 ---
	// --- Track P13 ---
	state?: GameState;
	zone?: ZoneType;
	stackItem?: StackItem;
	// --- End Track P13 ---
}

function battlefieldSubject(state: GameState, obj: CardInstance, controllerId: string): Subject {
	let evaluated: ReturnType<typeof evaluatePermanent> | undefined;
	const ev = () => (evaluated ??= evaluatePermanent(state, obj));
	return {
		obj,
		controllerId,
		isToken: obj.isToken,
		tapped: obj.tapped,
		saddled: Boolean(obj.saddledThisTurn),
		monstrous: Boolean(obj.isMonstrous),
		// --- Track P10 ---
		suspected: Boolean(obj.isSuspected),
		// --- End Track P10 ---
		// --- Track P15 ---
		isPrepared: Boolean(obj.isPrepared),
		// --- End Track P15 ---
		get colors() {
			return obj.isFaceDown ? [] : ev().colors;
		},
		typeLine: () => ev().typeLine,
		hasSubtype: (s) => ev().hasSubType(s),
		// --- Track P7 ---
		power: () => (ev().isCreature ? ev().power : undefined),
		toughness: () => (ev().isCreature ? ev().toughness : undefined),
		manaValue: () => {
			if (obj.isFaceDown) return 0;
			const timedL1a = activeTimedLayer1aForPermanent(state, obj);
			if (timedL1a) {
				if (timedL1a.except?.noManaCost) return 0;
				return resolveObjectFaces(timedL1a.card, {
					zone: 'battlefield',
					faceIndex: timedL1a.faceIndex ?? 0,
					isSingleFaceCopy: timedL1a.isSingleFaceCopy,
					prototyped: Boolean(timedL1a.prototyped),
					copiableState: timedL1a
				}).manaValue;
			}
			return objectManaValue(state, obj);
		},
		// --- End Track P7 ---
		// --- Track P11 ---
		name: () => (obj.isFaceDown ? '' : ev().effectiveName),
		attachedToId: obj.attachedToId,
		isFaceDown: Boolean(obj.isFaceDown),
		// --- End Track P11 ---
		// --- Track P13 ---
		state,
		zone: 'battlefield'
		// --- End Track P13 ---
	};
}

function printedSubject(
	obj: CardInstance,
	card: ScryfallCard,
	controllerId: string,
	allCreatureTypes = false,
	typeLine = card.typeLine,
	tapped = obj.tapped,
	colors: string[] = resolveObjectFaces(card, instanceFaceOptions(obj)).colors,
	saddled = Boolean(obj.saddledThisTurn),
	monstrous = Boolean(obj.isMonstrous),
	// --- Track P7 ---
	lkiStats?: {
		state?: GameState;
		power?: number;
		toughness?: number;
		manaValue?: number;
		// --- Track P13 ---
		stackItem?: StackItem;
		// --- End Track P13 ---
	}
	// --- End Track P7 ---
): Subject {
	return {
		obj,
		controllerId,
		isToken: obj.isToken,
		tapped,
		saddled,
		monstrous,
		// --- Track P15 ---
		isPrepared: Boolean(obj.isPrepared),
		// --- End Track P15 ---
		colors,
		typeLine: () => typeLine,
		hasSubtype: (s) => hasWord(subtypePart(typeLine), s) || (allCreatureTypes && hasWord(typeLine, 'Creature')),
		// --- Track P7 ---
		power: () => {
			if (lkiStats?.power !== undefined) return lkiStats.power;
			if (!hasWord(typeLine, 'Creature')) return undefined;
			if (lkiStats?.state) return objectPower(lkiStats.state, obj) ?? undefined;
			return resolveObjectFaces(card, instanceFaceOptions(obj)).power ?? 0;
		},
		toughness: () => {
			if (lkiStats?.toughness !== undefined) return lkiStats.toughness;
			if (!hasWord(typeLine, 'Creature')) return undefined;
			if (lkiStats?.state) return objectToughness(lkiStats.state, obj) ?? undefined;
			return resolveObjectFaces(card, instanceFaceOptions(obj)).toughness ?? 0;
		},
		manaValue: () => {
			if (lkiStats?.manaValue !== undefined) return lkiStats.manaValue;
			return objectManaValue(lkiStats?.state, obj);
		},
		// --- End Track P7 ---
		// --- Track P11 ---
		name: () => (obj.isFaceDown ? '' : resolveObjectFaces(card, instanceFaceOptions(obj)).name),
		attachedToId: obj.attachedToId,
		isFaceDown: Boolean(obj.isFaceDown),
		// --- End Track P11 ---
		// --- Track P13 ---
		state: lkiStats?.state,
		zone: obj.zone,
		stackItem: lkiStats?.stackItem
		// --- End Track P13 ---
	};
}

function subtypePart(typeLine: string): string {
	const idx = typeLine.indexOf('—');
	return idx >= 0 ? typeLine.slice(idx + 1) : '';
}

function hasWord(text: string, word: string): boolean {
	return text.split(/[\s—]+/).includes(word);
}

/** Whose point of view a filter is read from: "another" excludes `id`, "you" is `controllerId`. */
interface Viewer {
	id: string;
	controllerId: string;
	chosenSubType?: string;
	chosenColor?: ManaColor;
	// --- Track P11 ---
	chosenCardName?: string;
	attachedToId?: string | null;
	// --- End Track P11 ---
	// --- Track P15 ---
	sourceObj?: CardInstance;
	state?: GameState;
	// --- End Track P15 ---
}

const viewerOf = (source: Source): Viewer => ({
	id: source.obj.instanceId,
	controllerId: source.controllerId,
	...(source.chosenSubType ?? source.obj.chosenSubType
		? { chosenSubType: source.chosenSubType ?? source.obj.chosenSubType }
		: {}),
	...(source.chosenColor ?? source.obj.chosenColor
		? { chosenColor: source.chosenColor ?? source.obj.chosenColor }
		: {}),
	// --- Track P11 ---
	...(source.chosenCardName ?? source.obj.chosenCardName
		? { chosenCardName: source.chosenCardName ?? source.obj.chosenCardName }
		: {}),
	attachedToId: source.obj.attachedToId,
	// --- End Track P11 ---
	// --- Track P15 ---
	sourceObj: source.obj
	// --- End Track P15 ---
});

// --- Track P7 ---
function matchesFilterCompare(actual: number | null | undefined, cmp: Compare): boolean {
	if (actual === null || actual === undefined || cmp.value.k !== 'const') return false;
	const target = cmp.value.n;
	switch (cmp.op) {
		case '=':
			return actual === target;
		case '<':
			return actual < target;
		case '<=':
			return actual <= target;
		case '>':
			return actual > target;
		case '>=':
			return actual >= target;
	}
}
// --- End Track P7 ---

/** Does `subject` match an ObjectFilter, from the point of view of the trigger's source? */
function filterMatches(f: ObjectFilter, subject: Subject, source: Viewer): boolean {
	// --- Track P13: disjunctive anyOf branches ---
	if (f.anyOf && f.anyOf.length > 0 && !f.anyOf.some((branch) => filterMatches(branch, subject, source))) {
		return false;
	}
	// --- End Track P13 ---
	if (f.other && subject.obj.instanceId === source.id) return false;
	const typeLine =
		f.types || f.allTypes || f.supertypes || f.notTypes || f.notSupertypes ? subject.typeLine() : '';
	if (f.types && !f.types.some((t) => hasWord(typeLine, t))) return false;
	// --- Track P9 ---
	if (f.allTypes && !f.allTypes.every((t) => hasWord(typeLine, t))) return false;
	if (f.notTypes && f.notTypes.some((t) => hasWord(typeLine, t))) return false;
	if (f.supertypes && !f.supertypes.some((t) => hasWord(typeLine, t))) return false;
	if (f.notSupertypes && f.notSupertypes.some((t) => hasWord(typeLine, t))) return false;
	if (f.subtypes && !f.subtypes.some((s) => subject.hasSubtype(s))) return false;
	if (f.notSubtypes && f.notSubtypes.some((s) => subject.hasSubtype(s))) return false;
	if (f.ofChosenType) {
		if (!source.chosenSubType || !subject.hasSubtype(source.chosenSubType)) return false;
	}
	if (f.ofChosenColor) {
		if (!source.chosenColor || !subject.colors.includes(source.chosenColor)) return false;
	}
	// --- Track P11 ---
	if (f.ofChosenName) {
		if (
			!source.chosenCardName ||
			subject.isFaceDown ||
			subject.name().toLowerCase() !== source.chosenCardName.toLowerCase()
		) {
			return false;
		}
	}
	if (f.attachedToRef !== undefined) {
		const wantHost = f.attachedToRef === 'self' ? source.id : source.attachedToId;
		if (!wantHost || subject.attachedToId !== wantHost) return false;
	}
	if (f.historic !== undefined) {
		const tl = subject.typeLine();
		const isHist =
			!subject.isFaceDown &&
			(hasWord(tl, 'Legendary') || hasWord(tl, 'Artifact') || subject.hasSubtype('Saga'));
		if (isHist !== f.historic) return false;
	}
	// --- End Track P11 ---
	if (f.controller === 'you' && subject.controllerId !== source.controllerId) return false;
	if (f.controller === 'opponent' && subject.controllerId === source.controllerId) return false;
	// --- Track P13: relational controllerRef ---
	if (f.controllerRef && subject.state) {
		if (f.controllerRef.k === 'you' && subject.controllerId !== source.controllerId) return false;
		if (f.controllerRef.k === 'activePlayer') {
			const activeId = subject.state.players[subject.state.activePlayerIndex]?.playerId;
			if (subject.controllerId !== activeId) return false;
		}
		if (f.controllerRef.k === 'controllerOf' && f.controllerRef.of.k === 'attachedTo') {
			const host = source.attachedToId ? permanentById(subject.state, source.attachedToId) : null;
			if (!host || subject.controllerId !== host.controllerId) return false;
		}
	}
	// --- End Track P13 ---
	if (f.owner === 'you' && subject.obj.ownerId !== source.controllerId) return false;
	if (f.owner === 'opponent' && subject.obj.ownerId === source.controllerId) return false;
	if (f.isCommander !== undefined && Boolean(subject.obj.isCommander) !== f.isCommander) return false;
	if (f.token !== undefined && subject.isToken !== f.token) return false;
	if (f.tapped !== undefined && subject.tapped !== f.tapped) return false;
	if (f.saddled !== undefined && Boolean(subject.saddled) !== f.saddled) return false;
	if (f.monstrous !== undefined && Boolean(subject.monstrous) !== f.monstrous) return false;
	// --- Track P10 ---
	if (f.suspected !== undefined && Boolean(subject.suspected) !== f.suspected) return false;
	if (f.notColors || f.multicolored !== undefined || f.monocolored !== undefined) {
		const wubrgCount = new Set(
			subject.colors.filter((c) => c === 'W' || c === 'U' || c === 'B' || c === 'R' || c === 'G')
		).size;
		if (
			f.notColors &&
			f.notColors.some((c) => (c === 'C' ? wubrgCount === 0 : subject.colors.includes(c)))
		) {
			return false;
		}
		if (f.multicolored !== undefined && (wubrgCount >= 2) !== f.multicolored) return false;
		if (f.monocolored !== undefined && (wubrgCount === 1) !== f.monocolored) return false;
	}
	// --- End Track P10 ---
	if (f.colors && !matchesColorFilter(subject.colors, f.colors)) return false;
	// --- Track P7 ---
	if (f.power && !matchesFilterCompare(subject.power(), f.power)) return false;
	if (f.toughness && !matchesFilterCompare(subject.toughness(), f.toughness)) return false;
	if (f.manaValue && !matchesFilterCompare(subject.manaValue(), f.manaValue)) return false;
	// --- End Track P7 ---
	// --- Track P13 ---
	if (subject.state) {
		if (
			!matchesP13ObjectFilterFields(subject.obj, f, {
				state: subject.state,
				zone: subject.zone ?? subject.obj.zone,
				stackItem: subject.stackItem
			})
		) {
			return false;
		}
		if (
			f.targetsSelf !== undefined ||
			f.targetsFilter !== undefined ||
			f.hasKeywords !== undefined ||
			f.lacksKeywords !== undefined ||
			f.hasCounters !== undefined ||
			f.attacking !== undefined ||
			f.blocking !== undefined
		) {
			const srcPerm = permanentById(subject.state, source.id)?.obj;
			if (
				!matchesObjectFilter(
					subject.obj,
					{
						...(f.targetsSelf !== undefined ? { targetsSelf: f.targetsSelf } : {}),
						...(f.targetsFilter !== undefined ? { targetsFilter: f.targetsFilter } : {}),
						...(f.hasKeywords !== undefined ? { hasKeywords: f.hasKeywords } : {}),
						...(f.lacksKeywords !== undefined ? { lacksKeywords: f.lacksKeywords } : {}),
						...(f.hasCounters !== undefined ? { hasCounters: f.hasCounters } : {}),
						...(f.attacking !== undefined ? { attacking: f.attacking } : {}),
						...(f.blocking !== undefined ? { blocking: f.blocking } : {})
					},
					{
						state: subject.state,
						controllerId: source.controllerId,
						source: srcPerm,
						stackItem: subject.stackItem
					}
				)
			) {
				return false;
			}
		}
	}
	// --- End Track P13 ---
	// --- Track P15 ---
	if (f.isPrepared !== undefined && Boolean(subject.isPrepared) !== f.isPrepared) return false;
	if (f.sharesCreatureTypeWithSelf) {
		const st = source.state ?? subject.state;
		if (!st || !source.sourceObj) return false;
		if (!objectsShareCreatureSubtype(st, source.sourceObj, subject.obj)) return false;
	}
	// --- End Track P15 ---
	return true;
}

/** EventFilter.object (+ orSelf) against the event's object. */
function objectMatches(
	filter: EventFilter,
	subject: Subject,
	source: Source,
	lkiAttachedIds?: readonly string[]
): boolean {
	const o = filter.object;
	const isSelf = subject.obj.instanceId === source.obj.instanceId;
	if (o === 'self') return isSelf;
	if (o === 'attachedTo') {
		const wasAttached =
			source.obj.attachedToId === subject.obj.instanceId ||
			Boolean(lkiAttachedIds && lkiAttachedIds.includes(source.obj.instanceId));
		if (!wasAttached) return false;
		if (filter.attachedFilter && !filterMatches(filter.attachedFilter, subject, viewerOf(source))) {
			return false;
		}
		return true;
	}
	if (filter.orSelf && isSelf) return true;
	return filterMatches(o ?? {}, subject, viewerOf(source));
}

// ---- Sources --------------------------------------------------------------------------------

/** An object whose triggered abilities are being checked. */
interface Source {
	obj: CardInstance;
	card: ScryfallCard;
	faceIndex?: number;
	controllerId: string;
	zone: ZoneType;
	/** Look-back for an object that left the battlefield (CR 603.10a). */
	lostAllAbilities?: boolean;
	isLookBack?: boolean;
	foretold?: boolean;
	blitzed?: boolean;
	saddled?: boolean;
	exerted?: boolean;
	chosenSubType?: string;
	chosenColor?: ManaColor;
	monstrous?: boolean;
	counters?: Partial<Record<CounterType, number>>;
	// --- Track P7 ---
	wasCast?: boolean;
	castFromZone?: ZoneType;
	// --- Track P9 ---
	grantedDeathKeywords?: Record<string, number>;
	// --- Track P10 ---
	damagedByThisTurn?: Array<{ sourceId: string; sourceVersion?: number }>;
	grantedAbilityTexts?: string[];
	// --- End Track P10 ---
	// --- Track P11 ---
	chosenCardName?: string;
	grantedTrigger?: GrantedTriggeredAbilityInstance;
	// --- End Track P11 ---
}

// --- Track P10: Compile quoted EOT-granted triggered abilities on demand ---
function quotedTriggersForTexts(
	cardName: string,
	texts: readonly string[]
): Array<{ ability: RuntimeTrigger; text: string }> {
	const out: Array<{ ability: RuntimeTrigger; text: string }> = [];
	for (const gt of texts) {
		const defs = resolveQuotedAbilityDefs(gt, cardName);
		const rts = runtimeTriggers(
			{
				oracleId: '',
				name: cardName,
				compilerVersion: 0,
				textHash: '',
				fullySupported: true,
				faces: [
					{
						name: cardName,
						characteristics: {
							manaCost: '',
							types: [],
							subtypes: [],
							supertypes: [],
							colors: []
						},
						abilities: defs
					}
				]
			},
			0
		).filter((t) => !host?.canExecute || host.canExecute(t));
		for (const rt of rts) {
			out.push({
				ability: { ...rt, ...(gt ? { grantedAbilityText: gt } : {}) } as RuntimeTrigger,
				text: gt
			});
		}
	}
	return out;
}
// --- End Track P10 ---

/**
 * Every object whose abilities can trigger on `kind`: battlefield permanents (not phased out) and
 * graveyard cards with `fromZone: 'graveyard'` abilities, in seat order then zone order. Players who
 * have left the game are skipped (CR 800.4a).
 */
function sources(state: GameState, kind: EventKind): Source[] {
	const out: Source[] = [];
	// --- Track P10 ---
	const hasAnyQuotedCont = Boolean(
		state.timedContinuousEffects?.some((eff) => Boolean(eff.layer6?.grantedAbilityTexts?.length))
	);
	// --- End Track P10 ---
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			// --- Track P7 ---
			const card = activeTimedLayer1aForPermanent(state, perm)?.card ?? perm.copiableCard ?? perm.card;
			// --- End Track P7 ---
			// --- Track P10 ---
			let grantedTexts: string[] | undefined;
			if (hasAnyQuotedCont && state.timedContinuousEffects) {
				const ver = perm.objectVersion ?? 1;
				for (const eff of state.timedContinuousEffects) {
					if (!eff.layer6?.grantedAbilityTexts?.length) continue;
					if (
						eff.affected.some(
							(a) => a.instanceId === perm.instanceId && (a.objectVersion ?? 1) === ver
						)
					) {
						(grantedTexts ??= []).push(...eff.layer6.grantedAbilityTexts);
					}
				}
			}
			let addedForPerm = false;
			// --- End Track P10 ---
			for (const faceIndex of activeFacesForObject(perm, card, 'battlefield', state)) {
				if (triggersOf(card, faceIndex).events.has(kind)) {
					out.push({
						obj: perm,
						card,
						faceIndex,
						controllerId: p.playerId,
						zone: 'battlefield',
						// --- Track P10 ---
						...(!addedForPerm && grantedTexts ? { grantedAbilityTexts: grantedTexts } : {})
						// --- End Track P10 ---
					});
					addedForPerm = true;
				}
			}
			// --- Track P10 ---
			if (!addedForPerm && grantedTexts) {
				const qts = quotedTriggersForTexts(card.name, grantedTexts);
				if (qts.some((q) => alternatives(q.ability.trigger).some((a) => a.event === kind))) {
					out.push({
						obj: perm,
						card,
						faceIndex: 0,
						controllerId: p.playerId,
						zone: 'battlefield',
						grantedAbilityTexts: grantedTexts
					});
					addedForPerm = true;
				}
			}
			// --- End Track P10 ---
			// --- Track P12: Backup-granted triggered abilities (CR 702.165a–d) ---
			if (
				!addedForPerm &&
				!out.some((s) => s.obj === perm && s.zone === 'battlefield') &&
				collectBackupGrantedAbilityDefs(state, perm).length > 0
			) {
				out.push({
					obj: perm,
					card,
					faceIndex: 0,
					controllerId: p.playerId,
					zone: 'battlefield',
					...(grantedTexts ? { grantedAbilityTexts: grantedTexts } : {})
				});
			}
			// --- End Track P12 ---
			// --- Track P11: Layer 6 granted triggered abilities (CR 113.7a, 613.1f) ---
			for (const gt of collectActiveGrantedTriggeredAbilities(state, perm, kind)) {
				if (host?.canExecute && !host.canExecute(gt.runtimeTrigger)) continue;
				if (alternatives(gt.runtimeTrigger.trigger).some((alt) => alt.event === kind)) {
					out.push({
						obj: perm,
						card,
						controllerId: p.playerId,
						zone: 'battlefield',
						grantedTrigger: gt
					});
				}
			}
			// --- End Track P11 ---
		}
		for (const c of p.graveyard) {
			for (const faceIndex of activeFacesForObject(c, c.card, 'graveyard', state)) {
				const t = triggersOf(c.card, faceIndex);
				if (t.events.has(kind) && t.all.some((a) => a.trigger.fromZone === 'graveyard')) {
					out.push({ obj: c, card: c.card, faceIndex, controllerId: p.playerId, zone: 'graveyard' });
				}
			}
		}
		// --- Track P13: Emblems in command zone have functioning triggered abilities (CR 114.4) ---
		for (const cmd of p.command) {
			if (!cmd.isEmblem || cmd.isRingEmblem) continue;
			const t = triggersOf(cmd.card, 0);
			if (t.events.has(kind)) {
				out.push({
					obj: cmd,
					card: cmd.card,
					faceIndex: 0,
					controllerId: cmd.controllerId || p.playerId,
					zone: 'command'
				});
			}
		}
		// --- End Track P13 ---
	}
	return out;
}

/**
 * The abilities of `source` that function in its zone, each with its alternatives for `kind` that
 * pass the cheap `pre` check (event fields only). Ability loss is checked last because it's costly.
 */
function abilitiesFor(
	state: GameState,
	source: Source,
	kind: EventKind,
	pre: (alt: TriggerDef) => boolean = () => true
): Array<{ ability: RuntimeTrigger; alts: TriggerDef[]; grantedAbilityText?: string }> {
	// --- Track P11: Layer 6 granted triggered abilities (CR 113.7a, 613.7e) ---
	if (source.grantedTrigger) {
		const ability = source.grantedTrigger.runtimeTrigger;
		const zone = ability.trigger.fromZone ?? 'battlefield';
		if (ability.trigger.fromZone !== 'any' && zone !== source.zone) return [];
		if (
			ability.grantCondition &&
			!evaluateCondition(
				state,
				ability.grantCondition,
				source.controllerId,
				source.obj.instanceId,
				undefined,
				source
			)
		) {
			return [];
		}
		const alts = alternatives(ability.trigger).filter((a) => a.event === kind && pre(a));
		return alts.length > 0 ? [{ ability, alts }] : [];
	}
	// --- End Track P11 ---
	const out: Array<{ ability: RuntimeTrigger; alts: TriggerDef[]; grantedAbilityText?: string }> = [];
	// --- Track P13: Emblems function in the command zone (CR 114.4) ---
	const isEmblemSource = Boolean(source.obj.isEmblem && source.zone === 'command');
	// --- End Track P13 ---
	for (const ability of triggersOf(source.card, source.faceIndex ?? 0).all) {
		const zone = ability.trigger.fromZone ?? 'battlefield';
		// "When you cast ~" functions while the spell is on the stack (CR 603.2, 113.6).
		// "When you cycle ~" (`fromZone: 'any'`) triggers from whatever zone the card winds up in (CR 702.29c).
		if (
			ability.trigger.fromZone !== 'any' &&
			!isEmblemSource &&
			(source.zone === 'stack' ? kind !== 'cast' : zone !== source.zone)
		) {
			continue;
		}
		// CR 711.2 / CR 722.2: Striated Leveler and Station abilities exist only while their counter threshold holds.
		if (
			ability.grantCondition &&
			!evaluateCondition(state, ability.grantCondition, source.controllerId, source.obj.instanceId, undefined, source)
		) {
			continue;
		}
		const alts = alternatives(ability.trigger).filter((a) => a.event === kind && pre(a));
		if (alts.length > 0) out.push({ ability, alts });
	}
	// --- Track P10 ---
	if (source.grantedAbilityTexts?.length && source.zone === 'battlefield') {
		for (const q of quotedTriggersForTexts(source.card.name, source.grantedAbilityTexts)) {
			const alts = alternatives(q.ability.trigger).filter((a) => a.event === kind && pre(a));
			if (alts.length > 0) {
				out.push({ ability: q.ability, alts, grantedAbilityText: q.text });
			}
		}
	}
	// --- End Track P10 ---
	// --- Track P12: Backup-granted triggered abilities (CR 702.165a–d) ---
	if (source.zone === 'battlefield' && state.timedContinuousEffects?.length) {
		for (const eff of state.timedContinuousEffects) {
			if (!eff.backupGrant) continue;
			const aff = eff.affected.find((a) => a.instanceId === source.obj.instanceId);
			if (!aff || (aff.objectVersion !== undefined && (source.obj.objectVersion ?? 1) !== aff.objectVersion)) {
				continue;
			}
			const bTrigs = triggersOf(eff.backupGrant.sourceCard, eff.backupGrant.faceIndex).all;
			for (const bt of bTrigs) {
				const rawIdx = bt.abilityIndex >= 5000 ? bt.abilityIndex - 5000 : bt.abilityIndex;
				if (rawIdx < eff.backupGrant.startAbilityIndex) continue;
				const alts = alternatives(bt.trigger).filter((a) => a.event === kind && pre(a));
				if (alts.length > 0) out.push({ ability: bt, alts });
			}
		}
	}
	// --- End Track P12 ---
	if (out.length === 0) return out;
	// CR 613 layer 6: a permanent that lost all abilities has no triggered abilities.
	if (source.lostAllAbilities ?? (source.zone === 'battlefield' && permanentHasLostAllAbilities(source.obj, state).lost)) {
		return [];
	}
	return out;
}

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
			extras.eventLki
		)
	) {
		return;
	}
	let count = extras.times ?? 1;
	if (count <= 0) return;
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
	if (kind === 'tappedForMana' && e && !e.modal && e.targets.length === 0 && e.steps.length > 0 && e.steps.every((st) => st.verb === 'addMana')) {
		return 'inline';
	}
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
		case 'BecomesCrewed':
			return matchObjectActionEvent(state, ev, 'becomesCrewed', 'Crew Trigger');
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
	}
}

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
	event: 'ringTempted' | 'dungeonRoomEntered' | 'dungeonCompleted' | 'tookInitiative',
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
				const matching =
					f.object === undefined ? attackers : attackers.filter((s) => objectMatches(f, s, source));
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
	for (const source of sources(state, 'gainLife')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'gainLife')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
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
				return true;
			});
			if (alt) {
				record(state, source, ability, 'drawCard', {
					label: 'Draw Trigger',
					eventObject: ev.object,
					eventPlayer: ev.playerId,
					amount: 1
				});
			}
		}
	}
}

function matchCardDiscarded(state: GameState, ev: Extract<GameEvent, { kind: 'CardDiscarded' }>): void {
	const subject = printedSubject(ev.object, ev.object.card, ev.playerId);
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
					return objectMatches(a.filter, subject, source);
				});
				if (!alt) continue;
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
				objTriggers.all.some(
					(a) =>
						a.trigger.fromZone === 'any' &&
						alternatives(a.trigger).some((alt) => alt.event === 'cycle')
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
			objTriggers.all.some(
				(a) =>
					a.trigger.fromZone === 'any' &&
					alternatives(a.trigger).some((alt) => alt.event === 'discard')
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
			const alt = alts.find((a) => objectMatches(a.filter, subject, source));
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
	for (const source of sources(state, 'becomesTapped')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becomesTapped')) {
			const alt = alts.find((a) => objectMatches(a.filter, subject, source));
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
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	for (const source of sources(state, 'tappedForMana')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'tappedForMana')) {
			const alt = alts.find((a) => {
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.playerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
				return objectMatches(a.filter, subject, source);
			});
			if (alt) record(state, source, ability, 'tappedForMana', { label: 'Mana Trigger', eventObject: found.obj, eventPlayer: ev.playerId });
		}
	}
}

function matchZoneChange(state: GameState, ev: Extract<GameEvent, { kind: 'ZoneChange' }>): void {
	const obj = ev.object;
	if (ev.to === 'battlefield' && obj.phasedOut) return;
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
		(alt.filter.to === undefined || alt.filter.to === ev.to) &&
		(alt.filter.from !== undefined || alt.filter.to !== undefined);
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
						...(!pushedPeer && info.grantedAbilityTexts
							? { grantedAbilityTexts: info.grantedAbilityTexts }
							: {})
						// --- End Track P10 ---
					});
					pushedPeer = true;
				}
				// --- Track P10 ---
				if (!pushedPeer && info.grantedAbilityTexts?.length) {
					const qts = quotedTriggersForTexts(info.card.name, info.grantedAbilityTexts);
					if (qts.some((q) => alternatives(q.ability.trigger).some((a) => a.event === 'zoneChange'))) {
						candidates.push({
							obj: peerPerm,
							card: info.card,
							faceIndex: 0,
							controllerId: info.controllerId,
							zone: 'battlefield',
							lostAllAbilities: info.lostAllAbilities,
							isLookBack: true,
							...(info.counters ? { counters: info.counters } : {}),
							grantedAbilityTexts: info.grantedAbilityTexts
						});
					}
				}
				// --- End Track P10 ---
				// --- Track P11: LKI look-back for Layer 6 granted triggered abilities (CR 603.10a) ---
				for (const gt of info.grantedTriggers ?? []) {
					if (host?.canExecute && !host.canExecute(gt.runtimeTrigger)) continue;
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
					...(!pushedSelf && ev.lki.grantedAbilityTexts
						? { grantedAbilityTexts: ev.lki.grantedAbilityTexts }
						: {})
					// --- End Track P10 ---
				});
				pushedSelf = true;
			}
			// --- Track P10 ---
			if (!pushedSelf && ev.lki.grantedAbilityTexts?.length) {
				const qts = quotedTriggersForTexts(ev.lki.card.name, ev.lki.grantedAbilityTexts);
				if (qts.some((q) => alternatives(q.ability.trigger).some((a) => a.event === 'zoneChange'))) {
					candidates.push({
						obj,
						card: ev.lki.card,
						faceIndex: 0,
						controllerId: ev.lki.controllerId,
						zone: 'battlefield',
						lostAllAbilities: ev.lki.lostAllAbilities,
						isLookBack: true,
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
				if (host?.canExecute && !host.canExecute(gt.runtimeTrigger)) continue;
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
				return objectMatches(a.filter, subject, source, lkiAttachedIds);
			});
			if (!alt) continue;
			// Only look-back objects check leaves-the-battlefield triggers; other permanents see the event normally.
			if ((source.obj === obj || source.isLookBack) && ev.from === 'battlefield' && alt.filter.from !== 'battlefield') continue;
			// --- Track P13: CR 603.2c oneOrMore simultaneous zone-change batching ---
			if (alt.filter.oneOrMore) {
				const batchSet = channel(state).zoneBatchTriggeredKeys;
				if (batchSet) {
					const batchKey = `${source.obj.instanceId}:${source.zone}:${source.faceIndex ?? 0}:${ability.abilityIndex}:${ev.from ?? ''}->${ev.to}`;
					if (batchSet.has(batchKey)) continue;
					batchSet.add(batchKey);
				}
			}
			// --- End Track P13 ---
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'zoneChange',
							object: obj,
							from: ev.from,
							to: ev.to,
							lki: ev.lki
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
			record(state, source, ability, 'zoneChange', { label: label(source, alt), eventObject: obj, amount: enteredPower(), times, eventLki });
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
		const grantedDeath = lkiInfo && !lkiInfo.lostAllAbilities ? lkiInfo.grantedDeathKeywords : undefined;
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
						record(state, deathSource, { ...rt, grantedKeyword: kwName }, 'zoneChange', {
							label: spec.displayLabel || 'Dies',
							eventObject: obj,
							times,
							eventLki: deathEventLki
						});
					}
				}
			}
		}
	}
}

function boardCanGrantTriggerKeyword(
	state: GameState,
	kind: EventKind,
	focusPerms: readonly CardInstance[]
): boolean {
	// --- Track P12 ---
	const isWave4GrantEvent =
		kind === 'attacks' || kind === 'becomesBlocked' || kind === 'dealsDamage';
	if (!GRANTED_TRIGGER_KEYWORD_EVENTS.has(kind) && !isWave4GrantEvent) return false;
	for (const eff of state.timedContinuousEffects ?? []) {
		if (eff.layer6?.addKeywords?.some((kw) => grantedTriggerEventsForKeyword(kw)?.includes(kind))) {
			return true;
		}
		if (eff.backupGrant) return true;
	}
	// --- End Track P12 ---
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
				// "When you cast ~" only from the stack; other cast triggers only from other zones.
				if ((a.filter.object === 'self') !== (source.zone === 'stack')) return false;
				if (a.filter.targetsSelf) {
					if (source.zone !== 'battlefield') return false;
					if (!stackSpell?.targets?.some((t) => t.kind === 'permanent' && t.id === source.obj.instanceId)) {
						return false;
					}
				}
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
	}
}

function permanentById(state: GameState, id: string): { obj: CardInstance; controllerId: string } | null {
	for (const p of state.players) {
		const obj = p.battlefield.find((c) => c.instanceId === id && !c.phasedOut);
		if (obj) return { obj, controllerId: p.playerId };
	}
	return null;
}

function matchAttack(state: GameState, attackingPlayerId: string, attackerIds: string[]): void {
	const attackers = attackerIds
		.map((id) => permanentById(state, id))
		.filter((a): a is NonNullable<typeof a> => Boolean(a))
		.map((a) => battlefieldSubject(state, a.obj, a.controllerId));
	const attackerDefenderId = (id: string): string | undefined =>
		state.combat.attackers.find((a) => a.attackerInstanceId === id)?.defenderPlayerId;

	for (const source of sources(state, 'attacks')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'attacks')) {
			for (const alt of alts) {
				const f = alt.filter;
				if (f.alone && attackers.length !== 1) continue;
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
					if (playerMatches && attackers.length > 0) {
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attacks',
										attackers: attackers.map((s) => s.obj)
									})
								: 1;
						record(state, source, ability, 'attacks', {
							label: 'Attack',
							times,
							eventPlayer: attackingPlayerId,
							eventPlayerId: attackingPlayerId,
							amount: attackers.length
						});
						break;
					}
					continue;
				}
				// --- End Track P10 ---
				const matching = attackers.filter((s) => objectMatches(f, s, source));
				if (matching.length === 0) continue;
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
						...(defendingPlayerId ? { defendingPlayerId } : {}),
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
							...(defendingPlayerId ? { defendingPlayerId } : {}),
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
				// --- Track P10: CR 509.3b / CR 509.3d per-opposing-creature host filter ---
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
	const dealerSubject = dealer ? battlefieldSubject(state, dealer.obj, dealer.controllerId) : null;
	const damagedSubject = damaged ? battlefieldSubject(state, damaged.obj, damaged.controllerId) : null;

	if (dealerSubject) {
		for (const source of sources(state, 'dealsDamage')) {
			for (const { ability, alts } of abilitiesFor(state, source, 'dealsDamage')) {
				const alt = alts.find((a) => {
					if ((a.filter.combat && !ev.combat) || !damageToFits(a.filter.damageTo)) return false;
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
					return objectMatches(a.filter, dealerSubject, source);
				});
				if (!alt) continue;
				record(state, source, ability, 'dealsDamage', {
					label: ev.combat ? 'Combat Damage Trigger' : 'Damage Trigger',
					eventObject: damaged ? damaged.obj : dealerSubject.obj,
					eventPlayerId: ev.targetKind === 'player' ? ev.targetId : undefined,
					amount: ev.amount
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
				if (!alts.some((a) => objectMatches(a.filter, damagedSubject, source))) continue;
				record(state, source, ability, 'dealtDamage', { label: 'Dealt Damage', eventObject: damagedSubject.obj, amount: ev.amount });
			}
		}
	}
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
				const matching = attackerSubjects.filter((s) => objectMatches(a.filter, s, source));
				if (matching.length === 0) return false;
				matchedCount = matching.length;
				return true;
			});
			if (!alt) continue;
			record(state, source, ability, 'combatDamageBatchPlayer', {
				label: 'Combat Damage Trigger',
				eventPlayerId: ev.damagedPlayerId,
				eventPlayer: ev.damagedPlayerId,
				amount: matchedCount
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
				if (a.filter.phase !== ev.phase) return false;
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
				return true;
			});
			if (!phaseAlt) continue;
			// --- End Track P10 ---
			const scope = ability.trigger.scope ?? 'each_turn';
			if (scope === 'controller_turn' && source.controllerId !== ev.activePlayerId) continue;
			if (scope === 'opponent_turn' && source.controllerId === ev.activePlayerId) continue;
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
	for (const source of candidates) {
		if (source.obj.instanceId !== ev.objectId) continue;
		for (const { ability, alts } of abilitiesFor(state, source, 'counterPlaced')) {
			const chapterAlt = alts.find((a) => a.isChapterAbility && a.chapterNumbers?.length);
			if (chapterAlt) {
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
			if (!alts.some((a) => !a.isChapterAbility && a.filter.object === 'self' && (!a.filter.counter || a.filter.counter === ev.counterType))) continue;
			record(state, source, ability, 'counterPlaced', { label: 'Counter Placed', amount: ev.amount });
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
	for (const source of sources(state, 'becomesTarget')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becomesTarget')) {
			if (ability.ward) {
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
				if (a.filter.targetedBy !== 'spellOrAbility' && a.filter.targetedBy !== ev.by) return false;
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && ev.controllerId !== source.controllerId) return false;
				if (rel === 'opponent' && ev.controllerId === source.controllerId) return false;
				// --- Track P13: Valiant ---
				if (a.filter.firstTimeTargetedByYouThisTurn) {
					if (ev.controllerId !== source.controllerId || !wasFirstTargetByController) return false;
				}
				// --- End Track P13 ---
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
					(!a.filter.host || filterMatches(a.filter.host, hostSubject, viewerOf(source)))
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
 * order (event order, then seat/zone order of their sources); the host then lets the player
 * reorder them (`orderSimultaneous`, CR 603.3b).
 *
 * Inline (mana) triggers run before stacked ones are pushed. Triggers that fire while a flush is
 * running are flushed by the nested flush or by the next loop iteration.
 */
export function flushTriggers(state: GameState): void {
	if (!host) return;
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
					host.executeInline(state, t);
				}
				for (const pid of order) {
					const ids: string[] = [];
					for (const t of stacked) {
						if (t.controllerId !== pid) continue;
						const item = host.putOnStack(state, t);
						if (item) ids.push(item.id);
					}
					if (ids.length > 1) host.orderSimultaneous?.(state, pid, ids);
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
	}
}

/**
 * Resolves only pending triggered mana abilities (`mode === 'inline'`, CR 605.4a) immediately,
 * leaving normal stack triggers (`mode === 'stack'`) pending until the next `flushTriggers`
 * (when a player would receive priority, CR 603.3).
 */
export function flushInlineTriggers(state: GameState): void {
	if (!host) return;
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
				host.executeInline(state, t);
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
	// --- Track P9 ---
	if (stackItem?.grantedKeyword) {
		const spec = getKeywordSpec(stackItem.grantedKeyword);
		if (spec?.implementation?.kind === 'trigger') {
			const built = spec.implementation.buildTriggers(
				{ name: stackItem.grantedKeyword },
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
		const quoted = quotedTriggersForTexts(card.name, [stackItem.grantedAbilityText])[0];
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
	const ability = triggersOf(card, stackItem?.faceIndex ?? 0).all.find((t) => t.abilityIndex === abilityIndex);
	if (!ability?.condition) return true;
	return evaluateCondition(state, ability.condition, controllerId, sourceInstanceId, stackItem);
}

/** Evaluates an IR Condition for the controller of a triggered ability. Unknown forms are false. */
export function evaluateCondition(
	state: GameState,
	cond: Condition,
	controllerId: string,
	sourceInstanceId: string,
	stackItem?: StackItem,
	source?: Source,
	eventObject?: CardInstance,
	eventLki?: PendingTrigger['eventLki']
): boolean {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return false;
	switch (cond.k) {
		case 'and':
			return cond.of.every((c) =>
				evaluateCondition(state, c, controllerId, sourceInstanceId, stackItem, source, eventObject, eventLki)
			);
		case 'or':
			return cond.of.some((c) =>
				evaluateCondition(state, c, controllerId, sourceInstanceId, stackItem, source, eventObject, eventLki)
			);
		case 'not':
			return !evaluateCondition(state, cond.of, controllerId, sourceInstanceId, stackItem, source, eventObject, eventLki);
		case 'kicked':
			return evaluateKickerCondition(
				cond,
				getObjectKickerInfo(state, stackItem?.card ?? ({} as ScryfallCard), sourceInstanceId, stackItem, source?.obj)
			);
		case 'evoked':
			return isObjectEvoked(state, sourceInstanceId, stackItem, source?.obj);
		case 'escaped':
			return isObjectEscaped(state, sourceInstanceId, stackItem, source?.obj);
		case 'foretold':
			return source?.foretold !== undefined
				? source.foretold
				: isObjectForetold(state, sourceInstanceId, stackItem, source?.obj);
		case 'blitzed':
			return source?.blitzed !== undefined
				? source.blitzed
				: isObjectBlitzed(state, sourceInstanceId, stackItem, source?.obj);
		case 'saddled': {
			if (source) return Boolean(source.saddled ?? source.obj.saddledThisTurn);
			const found = permanentById(state, sourceInstanceId);
			return Boolean(found?.obj.saddledThisTurn);
		}
		// --- Track P4 ---
		case 'exertedThisTurn': {
			if (stackItem?.sourceExertedThisTurn) return true;
			if (source) return Boolean(source.exerted ?? source.obj.exertedThisTurn);
			const found = permanentById(state, sourceInstanceId);
			return Boolean(found?.obj.exertedThisTurn);
		}
		// --- Track P5 ---
		case 'monstrous': {
			if (source) return Boolean(source.monstrous ?? source.obj.isMonstrous);
			const found = permanentById(state, sourceInstanceId);
			if (found) return Boolean(found.obj.isMonstrous);
			return Boolean(stackItem?.sourceMonstrous);
		}
		// --- Track P7 ---
		case 'creatureDiedThisTurn':
		case 'attackedThisTurn':
		case 'permanentLeftBattlefieldThisTurn':
		case 'gainedLifeThisTurn':
		case 'wasCast': {
			const minLife =
				cond.k === 'gainedLifeThisTurn' && cond.min
					? (amount(state, cond.min, controllerId, sourceInstanceId, stackItem, source) ?? 1)
					: undefined;
			const sourceObj = source?.obj ?? permanentById(state, sourceInstanceId)?.obj;
			const res = evaluateP7Condition(state, cond, controllerId, {
				sourceObj,
				stackItem,
				sourceWasCast: source?.wasCast ?? stackItem?.sourceWasCast,
				sourceCastFromZone: source?.castFromZone ?? stackItem?.sourceCastFromZone,
				minLife
			});
			return res;
		}
		// --- Track P9 ---
		case 'cameUnderControlSinceLastUpkeep': {
			const found = permanentById(state, sourceInstanceId);
			return cameUnderControlSinceLastUpkeep(state, controllerId, found?.obj ?? source?.obj);
		}
		case 'ninjutsuWindow':
			return isNinjutsuWindowOpen(state);
		case 'lkiHasNoCounter': {
			const lkiCounters = source?.counters ?? stackItem?.eventLki?.counters;
			if (lkiCounters) {
				return (lkiCounters[cond.counter] ?? 0) <= 0;
			}
			const found = permanentById(state, sourceInstanceId);
			const counters = found?.obj.counters ?? source?.obj.lastKnownCounters ?? source?.obj.counters;
			return (counters?.[cond.counter] ?? 0) <= 0;
		}
		// --- Track P10 ---
		case 'opponentLostLifeThisTurn':
		case 'descendedThisTurn':
		case 'hadCounterOnIt':
		case 'manaColorSpentToCast':
		case 'opponentComparison': {
			const srcObj = source?.obj ?? permanentById(state, sourceInstanceId)?.obj;
			return evaluateP10Condition(cond, {
				state,
				controllerId,
				source: srcObj,
				stackItem,
				eventLkiCounters:
					eventLki?.counters ??
					stackItem?.eventLki?.counters ??
					source?.counters ??
					eventObject?.lastKnownCounters ??
					eventObject?.counters
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
			const found = permanentById(state, sourceInstanceId);
			const res = evaluateP12Condition(
				cond,
				{
					state,
					controllerId,
					source: found?.obj ?? source?.obj,
					stackItem
				},
				matchesObjectFilter
			);
			return res ?? false;
		}
		// --- End Track P12 ---
		// --- Track P13 ---
		case 'objectState':
		case 'opponentCount':
		case 'anyPlayerLife':
		case 'distinctControlledCreaturePowers': {
			const found = permanentById(state, sourceInstanceId);
			return evaluateP8Condition(cond, {
				state,
				controllerId,
				source: found?.obj ?? source?.obj,
				stackItem
			});
		}
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
			const found = permanentById(state, sourceInstanceId);
			const srcObj = found?.obj ?? source?.obj;
			return (
				evaluateP13Condition(cond, {
					state,
					controllerId,
					source: srcObj,
					stackItem,
					zone: source?.zone ?? srcObj?.zone
				}) ?? false
			);
		}
		// --- End Track P13 ---
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
			const found = permanentById(state, sourceInstanceId);
			const srcObj = found?.obj ?? source?.obj;
			return (
				evaluateP15Condition(cond, state, controllerId, {
					source: srcObj,
					giftPromised: Boolean(
						stackItem?.giftKind || stackItem?.sourceGiftPromised || srcObj?.giftPromised
					),
					enteredWithX:
						srcObj?.enteredWithX ?? stackItem?.sourceEnteredWithX ?? stackItem?.xValue,
					castWithImpending: Boolean(
						srcObj?.castWithImpending ?? stackItem?.sourceCastWithImpending
					)
				}) ?? false
			);
		}
		// --- End Track P15 ---
		case 'isTurnOf':
			if (cond.player.k === 'you') return state.players[state.activePlayerIndex]?.playerId === controllerId;
			return cond.player.k === 'activePlayer';
		case 'controlCommander':
			return controller.battlefield.some((perm) => !perm.phasedOut && Boolean(perm.isCommander));
		case 'isMonarch': {
			const monarchId = state.monarchPlayerId ?? null;
			if (!monarchId) return false;
			if (cond.player) {
				if (cond.player.k === 'you') return monarchId === controllerId;
				if (cond.player.k === 'activePlayer') {
					return monarchId === state.players[state.activePlayerIndex]?.playerId;
				}
				if (cond.player.k === 'eventPlayer') {
					const thatId = stackItem?.eventPlayerId;
					return Boolean(thatId && monarchId === thatId);
				}
				return false;
			}
			const rel = cond.relation ?? 'you';
			if (rel === 'you') return monarchId === controllerId;
			if (rel === 'opponent') return monarchId !== controllerId;
			return true;
		}
		case 'graveyardAbove': {
			// CR 404.2: the graveyard's order matters; the top is the end of the array.
			const idx = controller.graveyard.findIndex((c) => c.instanceId === sourceInstanceId);
			if (idx < 0) return false;
			const above = controller.graveyard.slice(idx + 1);
			const viewer: Viewer = { id: sourceInstanceId, controllerId };
			const n = above.filter((c) => filterMatches(cond.filter, printedSubject(c, c.card, c.ownerId), viewer)).length;
			return n >= cond.count;
		}
		case 'evolveCompare': {
			const srcPerm = state.players
				.flatMap((p) => p.battlefield)
				.find((p) => p.instanceId === sourceInstanceId && !p.phasedOut);
			if (!srcPerm) return false;
			const srcEval = evaluatePermanent(state, srcPerm);
			if (!srcEval.isCreature) return false;

			let enterPower: number | undefined;
			let enterToughness: number | undefined;

			if (eventObject) {
				const enterPerm = state.players
					.flatMap((p) => p.battlefield)
					.find((p) => p.instanceId === eventObject.instanceId && !p.phasedOut);
				if (enterPerm) {
					const enterEval = evaluatePermanent(state, enterPerm);
					enterPower = enterEval.power;
					enterToughness = enterEval.toughness;
				} else {
					enterPower = eventObject.lastKnownPower;
					enterToughness = eventObject.lastKnownToughness;
				}
			} else if (stackItem?.eventObjectId) {
				const enterPerm = state.players
					.flatMap((p) => p.battlefield)
					.find((p) => p.instanceId === stackItem.eventObjectId && !p.phasedOut);
				if (enterPerm) {
					const enterEval = evaluatePermanent(state, enterPerm);
					enterPower = enterEval.power;
					enterToughness = enterEval.toughness;
				} else if (stackItem.eventLki) {
					enterPower = stackItem.eventLki.power;
					enterToughness = stackItem.eventLki.toughness;
				}
			}

			if (enterPower === undefined || enterToughness === undefined) return false;
			return enterPower > srcEval.power || enterToughness > srcEval.toughness;
		}
		case 'matchesFilter': {
			// --- Track P13 ---
			const srcPerm = permanentById(state, sourceInstanceId)?.obj ?? source?.obj;
			let targetObj: CardInstance | undefined;
			if (!cond.target || cond.target.k === 'self') {
				targetObj = srcPerm;
			} else if (cond.target.k === 'attachedTo') {
				const hostId = srcPerm?.attachedToId;
				targetObj = hostId ? permanentById(state, hostId)?.obj : undefined;
			} else if (cond.target.k === 'eventObject') {
				if (eventObject) {
					targetObj = permanentById(state, eventObject.instanceId)?.obj ?? eventObject;
				} else if (stackItem?.eventObjectId) {
					targetObj = permanentById(state, stackItem.eventObjectId)?.obj;
				}
			}
			if (!targetObj) return false;
			return matchesObjectFilter(targetObj, cond.filter, {
				state,
				controllerId,
				source: srcPerm,
				stackItem
			});
			// --- End Track P13 ---
		}
		case 'compare': {
			const l = amount(state, cond.left, controllerId, sourceInstanceId, stackItem, source);
			const r = amount(state, cond.right, controllerId, sourceInstanceId, stackItem, source);
			if (l === null || r === null) return false;
			switch (cond.op) {
				case '>=':
					return l >= r;
				case '<=':
					return l <= r;
				case '>':
					return l > r;
				case '<':
					return l < r;
				case '=':
					return l === r;
			}
			return false;
		}
	}
	return false;
}

/** The Amount kinds conditions use. Anything else is null (the condition is then false). */
function amount(
	state: GameState,
	a: Amount,
	controllerId: string,
	sourceInstanceId: string,
	stackItem?: StackItem,
	source?: Source
): number | null {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return null;
	switch (a.k) {
		case 'const':
			return a.n;
		case 'commanderCastCount':
			return playerCommanderCastCount(state, controllerId);
		case 'stormCount':
			return stackItem?.stormCount ?? 0;
		case 'tappedCostPower':
			return stackItem?.tappedCostPower ?? 0;
		// --- Track P9 ---
		case 'lkiCounterCount': {
			const lkiCounters = source?.counters ?? stackItem?.eventLki?.counters;
			return lkiCounters?.[a.counter] ?? 0;
		}
		// --- Track P12 ---
		case 'devouredCount': {
			const found = permanentById(state, sourceInstanceId);
			return evaluateP12Amount(a, {
				state,
				controllerId,
				source: found?.obj ?? source?.obj,
				stackItem
			});
		}
		// --- End Track P12 ---
		case 'countersOn': {
			if (a.of.k !== 'self') return null;
			// --- Track P8 ---
			const readCtrs = (ctrs: Partial<Record<CounterType, number>> | undefined): number => {
				if (!ctrs) return 0;
				if (a.counter === 'any') {
					return Object.values(ctrs).reduce((acc, n) => acc + (n && n > 0 ? n : 0), 0);
				}
				return ctrs[a.counter] ?? 0;
			};
			if (source?.isLookBack && source.counters) {
				return readCtrs(source.counters);
			}
			const found = permanentById(state, sourceInstanceId);
			if (found) return readCtrs(found.obj.counters);
			if (source) return readCtrs(source.counters ?? source.obj.counters);
			return 0;
		}
		case 'kickedCount':
			return evaluateKickedCountAmount(
				a,
				getObjectKickerInfo(state, stackItem?.card ?? ({} as ScryfallCard), sourceInstanceId, stackItem)
			);
		case 'life':
			return a.of.k === 'you' ? controller.life : null;
		case 'energyCount': {
			if (a.player.k === 'you') return controller.energyCounters ?? 0;
			if (a.player.k === 'activePlayer') {
				return state.players[state.activePlayerIndex]?.energyCounters ?? 0;
			}
			if (a.player.k === 'eventPlayer') {
				const thatId = stackItem?.eventPlayerId;
				return thatId ? (state.players.find((pl) => pl.playerId === thatId)?.energyCounters ?? 0) : null;
			}
			return null;
		}
		case 'cardsIn': {
			if (a.of.k !== 'you') return null;
			const zone = a.zone;
			return zone === 'hand' || zone === 'library' || zone === 'graveyard' || zone === 'exile' || zone === 'battlefield'
				? controller[zone].length
				: null;
		}
		case 'count': {
			const srcFound = permanentById(state, sourceInstanceId);
			const viewer: Viewer = {
				id: sourceInstanceId,
				controllerId,
				...(srcFound?.obj.chosenSubType ? { chosenSubType: srcFound.obj.chosenSubType } : {}),
				...(srcFound?.obj.chosenColor ? { chosenColor: srcFound.obj.chosenColor } : {}),
				// --- Track P11 ---
				...(srcFound?.obj.chosenCardName ?? stackItem?.sourceChosenCardName
					? { chosenCardName: srcFound?.obj.chosenCardName ?? stackItem?.sourceChosenCardName }
					: {}),
				attachedToId: srcFound?.obj.attachedToId ?? source?.obj.attachedToId,
				// --- End Track P11 ---
				// --- Track P15 ---
				sourceObj: srcFound?.obj ?? source?.obj,
				state
				// --- End Track P15 ---
			};
			// --- Track P10: Support graveyard count conditions (Threshold / N+ creature cards in graveyard) ---
			if (a.of.zone === 'graveyard') {
				let n = 0;
				for (const p of state.players) {
					if (p.lost) continue;
					if (a.of.owner === 'you' && p.playerId !== controllerId) continue;
					if (a.of.owner === 'opponent' && p.playerId === controllerId) continue;
					if (a.of.controller === 'you' && p.playerId !== controllerId) continue;
					if (a.of.controller === 'opponent' && p.playerId === controllerId) continue;
					for (const c of p.graveyard) {
						if (filterMatches(a.of, printedSubject(c, c.card, p.playerId), viewer)) n++;
					}
				}
				return n;
			}
			// --- End Track P10 ---
			let n = 0;
			for (const p of state.players) {
				if (p.lost) continue;
				if (a.of.controller === 'you' && p.playerId !== controllerId) continue;
				if (a.of.controller === 'opponent' && p.playerId === controllerId) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (filterMatches(a.of, battlefieldSubject(state, perm, p.playerId), viewer)) n++;
				}
			}
			return n;
		}
		// --- Track P10: Delirium distinctCardTypesInZone condition ---
		case 'distinctCardTypesInZone':
			return countDistinctCardTypesInZone(state, controllerId, a.zone, a.whose);
		// --- End Track P10 ---
		// --- Track P11 ---
		case 'mul': {
			const sub = amount(state, a.of, controllerId, sourceInstanceId, stackItem, source);
			return sub === null ? null : a.factor * sub;
		}
		case 'domain': {
			const pid =
				a.player.k === 'you'
					? controllerId
					: (state.players[state.activePlayerIndex]?.playerId ?? controllerId);
			return computeDomainCount(state, pid);
		}
		case 'partyCount': {
			const pid =
				a.player.k === 'you'
					? controllerId
					: (state.players[state.activePlayerIndex]?.playerId ?? controllerId);
			return computePartyCount(state, pid);
		}
		case 'attachmentsOn': {
			const srcFound = permanentById(state, sourceInstanceId);
			const srcObj = srcFound?.obj ?? source?.obj;
			const hostId = a.target === 'self' ? sourceInstanceId : (srcObj?.attachedToId ?? undefined);
			if (!hostId) return 0;
			return computeAttachmentsOnCount(state, hostId, a.filter, controllerId, srcObj);
		}
		// --- End Track P11 ---
		// --- Track P13 ---
		case 'stat': {
			const srcFound = permanentById(state, sourceInstanceId);
			const srcObj = srcFound?.obj ?? source?.obj;
			let targetObj: CardInstance | undefined;
			if (a.of.k === 'self') targetObj = srcObj;
			else if (a.of.k === 'attachedTo') {
				const hostId = srcObj?.attachedToId;
				targetObj = hostId ? permanentById(state, hostId)?.obj : undefined;
			} else if (a.of.k === 'eventObject') {
				targetObj = stackItem?.eventObjectId ? permanentById(state, stackItem.eventObjectId)?.obj : undefined;
			}
			if (!targetObj) {
				if (a.of.k === 'self' && source?.isLookBack) {
					return a.stat === 'power'
						? (source.obj.lastKnownPower ?? 0)
						: a.stat === 'toughness'
							? (source.obj.lastKnownToughness ?? 0)
							: objectManaValue(state, source.obj);
				}
				return null;
			}
			return a.stat === 'power'
				? (objectPower(state, targetObj) ?? 0)
				: a.stat === 'toughness'
					? (objectToughness(state, targetObj) ?? 0)
					: objectManaValue(state, targetObj);
		}
		case 'devotion':
			return computeDevotionTo(state, controllerId, a.colors);
		case 'unlockedDoorsCount':
			return computeUnlockedDoorsCount(state, controllerId);
		case 'colorsAmongPermanents': {
			const srcFound = permanentById(state, sourceInstanceId);
			const pid =
				a.player.k === 'you'
					? controllerId
					: (state.players[state.activePlayerIndex]?.playerId ?? controllerId);
			return computeColorsAmongPermanents(state, pid, a.filter, (obj, f) =>
				matchesObjectFilter(obj, f, { state, controllerId, source: srcFound?.obj ?? source?.obj, stackItem })
			);
		}
		case 'dungeonsCompleted': {
			const pid =
				a.player.k === 'you'
					? controllerId
					: (state.players[state.activePlayerIndex]?.playerId ?? controllerId);
			return state.players.find((pl) => pl.playerId === pid)?.dungeonsCompletedCount ?? 0;
		}
		case 'greatestStatAmong':
		case 'totalStatAmong': {
			const srcFound = permanentById(state, sourceInstanceId);
			return computeStatAggregateAmong(
				state,
				a.filter,
				a.stat,
				a.k === 'greatestStatAmong' ? 'greatest' : 'total',
				(obj, f) =>
					matchesObjectFilter(obj, f, {
						state,
						controllerId,
						source: srcFound?.obj ?? source?.obj,
						stackItem
					})
			);
		}
		case 'half': {
			const sub = amount(state, a.of, controllerId, sourceInstanceId, stackItem, source);
			if (sub === null) return null;
			return a.round === 'up' ? Math.ceil(sub / 2) : Math.floor(sub / 2);
		}
		// --- End Track P13 ---
		// --- Track P15 ---
		case 'playerSpeed':
		case 'gravestormCount':
			return evaluateP15Amount(a, state, controllerId, {
				gravestormOverride: stackItem?.gravestormCount
			});
		// --- End Track P15 ---
		default:
			return null;
	}
}
