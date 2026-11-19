/**
 * Trigger queue, host registration, subject/filter matchers, and intervening-if evaluators
 * extracted from runtime/triggers.ts (strictly below triggers.ts in DAG).
 */
import { compileCard } from '../compiler/index.ts';
import { runtimeTriggers, type RuntimeTrigger } from '../compiler/triggers.ts';
import type { EventKind } from '../ir.ts';
import { formatGrantedKeywordDef, getKeywordSpec } from '../keywords.ts';
import { resolveQuotedAbilityDefs } from './reflexiveManaAndActions.ts';
import {
	attachWave6TagToBaseRuntimeTrigger,
	grantedWave6TriggerEvents,
	type Wave6RuntimeTrigger
} from './keywordsWave6.ts';
import type { Amount, Compare, Condition, EventFilter, ObjectFilter, TriggerDef } from '../ir.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from '../ruleTree.ts';
import type {
	CardInstance,
	CounterType,
	GameState,
	ManaColor,
	ScryfallCard,
	SerializedPendingTrigger,
	StackItem,
	Wave7SpellDelayedTrigger,
	ZoneType
} from '../types.ts';
import {
	evaluateKickedCountAmount,
	evaluateKickerCondition,
	getObjectKickerInfo,
	isObjectBlitzed,
	isObjectEscaped,
	isObjectEvoked,
	isObjectForetold
} from './kicker.ts';
import { activeTimedLayer1aForPermanent } from './layerCache.ts';
import {
	isTimedContinuousEffectActiveForState,
	timedLayer6AbilitySurvivesRemoval
} from './layers.ts';
import { instanceFaceOptions, matchesColorFilter, resolveObjectFaces, stackItemFaceOptions } from './faces.ts';
import {
	evaluateAmount as evaluateObjectFilterAmount,
	evaluateCondition as evaluateObjectFilterCondition,
	matchesObjectFilter,
	objectManaValue,
	objectPower,
	objectToughness,
	playerCommanderCastCount
} from './objectFilter.ts';
import { evaluateP7Condition } from './copyPreventionAndEffects.ts';
import { cameUnderControlSinceLastUpkeep, isNinjutsuWindowOpen } from './keywordsWave3.ts';
import { countDistinctCardTypesInZone, evaluateP8Condition } from './staticsLayersAndRestrictions.ts';
import { evaluateP10Condition } from './reflexiveManaAndActions.ts';
import {
	collectActiveGrantedTriggeredAbilities,
	computeAttachmentsOnCount,
	computeDomainCount,
	computePartyCount,
	type GrantedTriggeredAbilityInstance
} from './staticsDynamicAndCosts.ts';
import {
	attachWave4TagToBaseRuntimeTrigger,
	collectBackupGrantedAbilityDefs,
	evaluateP12Amount,
	evaluateP12Condition,
	parseGrantedWave4TriggerKeyword,
	type Wave4RuntimeTrigger
} from './keywordsWave4.ts';
import {
	computeColorsAmongPermanents,
	computeDevotionTo,
	computeStatAggregateAmong,
	computeUnlockedDoorsCount,
	evaluateP13Condition,
	matchesP13ObjectFilterFields
} from './effectsWave5.ts';
import { evaluateP15Amount, evaluateP15Condition, objectsShareCreatureSubtype } from './framesBattlesAndKeywordsWave5.ts';
import { evaluateWave5Condition } from './staticsAndCostsWave5.ts';
import { evaluateP16bCondition, makeSynthCardInstance, matchesP16bObjectFilter } from './triggersWave6.ts';
import { evaluateP17bCondition } from './costsWave6.ts';
import {
	buildDelegatedSubFilterP19b,
	evaluateP19bCondition,
	hasDelegatedObjectFilterFieldsP19b
} from './triggersWave7.ts';
import {
	evaluateP22bAmount,
	evaluateP22bCondition,
	hasP22bObjectFilterFields,
	matchesP22bObjectFilter
} from './triggersWave8.ts';
import {
	evaluateWave9Condition,
	reconstructWave9DelayedRuntimeTrigger
} from './triggersWave9.ts';


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
	// --- Track P18a ---
	wave6Tag?: string;
	wave6N?: number;
	wave6Card?: ScryfallCard;
	wave6FaceIndex?: number;
	sourceTributePaid?: boolean;
	// --- End Track P18a ---
	// --- Track P19b ---
	lastTappedManaColors?: ManaColor[];
	treasureManaSpent?: boolean;
	// --- End Track P19b ---
	sourceCounterPutOnThisTurn?: boolean;
	delayedSubStepIndex?: number;
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

export function getTriggerHost(): TriggerHost | null {
	return host;
}


/** "Whenever ~ enters or attacks": the main TriggerDef and each `or` alternative. */
export function alternatives(def: TriggerDef): TriggerDef[] {
	return def.or ? [def, ...def.or] : [def];
}

// ---- Pending queue (transient, never in GameState) ------------------------------------------

export interface SimultaneousLkiEntry {
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
	// --- Track P18a ---
	mergedComponents?: ScryfallCard[];
	// --- End Track P18a ---
}

// --- Track P11: Transient pre-LTB Layer 6 granted triggered abilities (CR 603.10a) ---
export const preLeaveGrantedTriggers = new WeakMap<CardInstance, GrantedTriggeredAbilityInstance[]>();

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

export interface TriggerChannel {
	pending: PendingTrigger[];
	nextOrder: number;
	flushing: number;
	deferFlush: number;
	simultaneousLki?: Map<CardInstance, SimultaneousLkiEntry>;
	// --- Track P13: CR 603.2c oneOrMore simultaneous zone-change batching ---
	zoneBatchTriggeredKeys?: Set<string>;
	// --- End Track P13 ---
	// --- Track P16b ---
	discardBatchTriggeredKeys?: Set<string>;
	counterBatchTriggeredKeys?: Set<string>;
	// --- End Track P16b ---
}

export const channels = new WeakMap<GameState, TriggerChannel>();

export function channel(state: GameState): TriggerChannel {
	let ch = channels.get(state);
	if (!ch) {
		const maxDeferredOrder = (state.pendingTriggers ?? []).reduce((m, t) => Math.max(m, t.order), 0);
		ch = { pending: [], nextOrder: maxDeferredOrder + 1, flushing: 0, deferFlush: 0 };
		channels.set(state, ch);
	}
	return ch;
}

export function isResolutionPaused(state: GameState): boolean {
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

export function persistPendingTriggers(state: GameState, triggers: PendingTrigger[]): void {
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
			// --- Track P18a ---
			...(t.wave6Tag ? { wave6Tag: t.wave6Tag } : {}),
			...(t.wave6N !== undefined ? { wave6N: t.wave6N } : {}),
			...(t.wave6Card ? { wave6Card: t.wave6Card } : {}),
			...(t.wave6FaceIndex !== undefined ? { wave6FaceIndex: t.wave6FaceIndex } : {}),
			...(t.sourceTributePaid ? { sourceTributePaid: true } : {}),
			// --- End Track P18a ---
			// --- Track P19b ---
			...(t.lastTappedManaColors?.length ? { lastTappedManaColors: [...t.lastTappedManaColors] } : {}),
			...(t.treasureManaSpent ? { treasureManaSpent: true } : {}),
			...(t.delayedSubStepIndex !== undefined ? { delayedSubStepIndex: t.delayedSubStepIndex } : {}),
			// --- End Track P19b ---
			order: t.order
		});
	}
}

export function hydratePendingTriggers(state: GameState, ch: TriggerChannel): void {
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
		// --- Track P18a ---
		...(t.wave6Tag ? { wave6Tag: t.wave6Tag } : {}),
		...(t.wave6N !== undefined ? { wave6N: t.wave6N } : {}),
		...(t.wave6Card ? { wave6Card: t.wave6Card } : {}),
		...(t.wave6FaceIndex !== undefined ? { wave6FaceIndex: t.wave6FaceIndex } : {}),
		...(t.sourceTributePaid ? { sourceTributePaid: true } : {}),
		// --- End Track P18a ---
		// --- Track P19b ---
		...(t.lastTappedManaColors?.length ? { lastTappedManaColors: [...t.lastTappedManaColors] } : {}),
		...(t.treasureManaSpent ? { treasureManaSpent: true } : {}),
		...(t.delayedSubStepIndex !== undefined ? { delayedSubStepIndex: t.delayedSubStepIndex } : {}),
		// --- End Track P19b ---
		order: t.order
	}));
	ch.pending = [...hydrated, ...ch.pending];
	const maxOrder = hydrated.reduce((m, t) => Math.max(m, t.order), 0);
	if (ch.nextOrder <= maxOrder) ch.nextOrder = maxOrder + 1;
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

// --- Track P17a ---
export function getActiveSimultaneousZoneBatchToken(state: GameState): object | null {
	return channels.get(state)?.zoneBatchTriggeredKeys ?? null;
}
// --- End Track P17a ---

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

// ---- Objects as triggers see them -----------------------------------------------------------

/** The object an event is about, with the characteristics trigger filters check. */
export interface Subject {
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
	// --- Track P22b ---
	damagedByThisTurn?: Array<{ sourceId: string; sourceVersion?: number }>;
	// --- End Track P22b ---
}

export function battlefieldSubject(state: GameState, obj: CardInstance, controllerId: string): Subject {
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

export function printedSubject(
	obj: CardInstance,
	card: ScryfallCard,
	controllerId: string,
	allCreatureTypes = false,
	typeLine = resolveObjectFaces(card, instanceFaceOptions(obj)).typeLine,
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

export function subtypePart(typeLine: string): string {
	const idx = typeLine.indexOf('—');
	return idx >= 0 ? typeLine.slice(idx + 1) : '';
}

export function hasWord(text: string, word: string): boolean {
	return text.split(/[\s—]+/).includes(word);
}

/** Whose point of view a filter is read from: "another" excludes `id`, "you" is `controllerId`. */
export interface Viewer {
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

export const viewerOf = (source: Source): Viewer => ({
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
export function filterMatches(f: ObjectFilter, subject: Subject, source: Viewer): boolean {
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
	// --- Track P16b ---
	const stP16b = subject.state ?? source.state;
	if (stP16b) {
		const srcPerm = source.sourceObj ?? permanentById(stP16b, source.id)?.obj;
		if (
			f.sameNameAsSource !== undefined ||
			f.sharesColorWithSelf !== undefined ||
			f.hasAnyCounter !== undefined ||
			f.equipped !== undefined ||
			f.enchanted !== undefined
		) {
			if (
				!matchesObjectFilter(
					subject.obj,
					{
						...(f.sameNameAsSource !== undefined ? { sameNameAsSource: f.sameNameAsSource } : {}),
						...(f.sharesColorWithSelf !== undefined
							? { sharesColorWithSelf: f.sharesColorWithSelf }
							: {}),
						...(f.hasAnyCounter !== undefined ? { hasAnyCounter: f.hasAnyCounter } : {}),
						...(f.equipped !== undefined ? { equipped: f.equipped } : {}),
						...(f.enchanted !== undefined ? { enchanted: f.enchanted } : {})
					},
					{
						state: stP16b,
						controllerId: source.controllerId,
						source: srcPerm,
						stackItem: subject.stackItem
					}
				)
			) {
				return false;
			}
		}
		if (
			!matchesP16bObjectFilter(subject.obj, f, {
				state: stP16b,
				controllerId: source.controllerId,
				source: srcPerm,
				zone: subject.zone ?? subject.obj.zone,
				stackItem: subject.stackItem,
				powerOverride: subject.power(),
				toughnessOverride: subject.toughness(),
				manaValueOverride: subject.manaValue()
			})
		) {
			return false;
		}
	}
	// --- End Track P16b ---
	// --- Track P19b ---
	if (f.named !== undefined) {
		if (subject.isFaceDown || subject.name().toLowerCase() !== f.named.toLowerCase()) {
			return false;
		}
	}
	if (f.allColors?.length) {
		if (!f.allColors.every((c) => subject.colors.includes(c))) return false;
	}
	if (stP16b && hasDelegatedObjectFilterFieldsP19b(f)) {
		const srcPermP19b = source.sourceObj ?? permanentById(stP16b, source.id)?.obj;
		if (
			!matchesObjectFilter(subject.obj, buildDelegatedSubFilterP19b(f), {
				state: stP16b,
				controllerId: source.controllerId,
				source: srcPermP19b,
				zone: subject.zone ?? subject.obj.zone,
				stackItem: subject.stackItem
			})
		) {
			return false;
		}
	}
	// --- End Track P19b ---
	// --- Track P22b ---
	if (stP16b && hasP22bObjectFilterFields(f)) {
		const srcPermP22b = source.sourceObj ?? permanentById(stP16b, source.id)?.obj;
		if (
			!matchesP22bObjectFilter(subject.obj, f, {
				state: stP16b,
				controllerId: source.controllerId,
				source: srcPermP22b,
				zone: subject.zone ?? subject.obj.zone,
				stackItem: subject.stackItem,
				...(subject.damagedByThisTurn ? { lki: { damagedByThisTurn: subject.damagedByThisTurn } } : {})
			})
		) {
			return false;
		}
	}
	// --- End Track P22b ---
	// --- Wave 9 ---
	if (
		stP16b &&
		(f.zone !== undefined || f.powerOrToughness !== undefined || f.manaValueCompare !== undefined)
	) {
		const srcPermW9 = source.sourceObj ?? permanentById(stP16b, source.id)?.obj;
		if (
			!matchesObjectFilter(
				subject.obj,
				{
					...(f.zone !== undefined ? { zone: f.zone } : {}),
					...(f.powerOrToughness !== undefined ? { powerOrToughness: f.powerOrToughness } : {}),
					...(f.manaValueCompare !== undefined ? { manaValueCompare: f.manaValueCompare } : {})
				},
				{
					state: stP16b,
					controllerId: source.controllerId,
					source: srcPermW9,
					zone: subject.zone ?? subject.obj.zone,
					stackItem: subject.stackItem
				}
			)
		) {
			return false;
		}
	}
	// --- End Wave 9 ---
	return true;
}

/** EventFilter.object (+ orSelf) against the event's object. */
export function objectMatches(
	filter: EventFilter,
	subject: Subject,
	source: Source,
	lkiAttachedIds?: readonly string[]
): boolean {
	const o = filter.object;
	const isSelf = subject.obj.instanceId === source.obj.instanceId;
	// --- Track P16b ---
	if (filter.orAttachedToSelf) {
		const wasAttached =
			source.obj.attachedToId === subject.obj.instanceId ||
			Boolean(lkiAttachedIds && lkiAttachedIds.includes(source.obj.instanceId));
		if (isSelf) return true;
		if (!wasAttached) return false;
		if (filter.attachedFilter && !filterMatches(filter.attachedFilter, subject, viewerOf(source))) {
			return false;
		}
		return true;
	}
	// --- End Track P16b ---
	if (o === 'self') return isSelf || Boolean(filter.orCommander && subject.obj.isCommander);
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
export interface Source {
	obj: CardInstance;
	card: ScryfallCard;
	faceIndex?: number;
	controllerId: string;
	zone: ZoneType;
	/** Look-back for an object that left the battlefield (CR 603.10a). */
	lostAllAbilities?: boolean;
	isLookBack?: boolean;
	skipInnate?: boolean;
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
	includeTimedGrants?: boolean;
	// --- End Track P10 ---
	// --- Track P11 ---
	chosenCardName?: string;
	grantedTrigger?: GrantedTriggeredAbilityInstance;
	// --- End Track P11 ---
	// --- Track P19b ---
	wave7SpellDelayed?: { entry: Wave7SpellDelayedTrigger; runtimeTrigger: RuntimeTrigger };
	// --- End Track P19b ---
}

export function permanentById(state: GameState, id: string): { obj: CardInstance; controllerId: string } | null {
	for (const p of state.players) {
		const obj = p.battlefield.find((c) => c.instanceId === id && !c.phasedOut);
		if (obj) return { obj, controllerId: p.playerId };
	}
	return null;
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
	eventLki?: PendingTrigger['eventLki'],
	// --- Track P16b ---
	matchExtras?: {
		eventPlayerId?: string;
		triggerEventStackItem?: StackItem;
		// --- Track P22b ---
		p22bEventIsManaAbility?: boolean;
		p22bEventLifePaid?: number;
		p22bEventCrewCount?: number;
		p22bEventDamageSourceSubtypes?: string[];
		p22bEventAttackedTargetPlayerId?: string;
		// --- End Track P22b ---
	}
	// --- End Track P16b ---
): boolean {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return false;
	// --- Track P16b ---
	const effEventPlayerId = stackItem?.eventPlayerId ?? matchExtras?.eventPlayerId;
	const effTriggerEventStackItem =
		stackItem?.triggerEventStackItem ?? matchExtras?.triggerEventStackItem;
	// --- End Track P16b ---
	switch (cond.k) {
		case 'and':
			return cond.of.every((c) =>
				evaluateCondition(
					state,
					c,
					controllerId,
					sourceInstanceId,
					stackItem,
					source,
					eventObject,
					eventLki,
					matchExtras
				)
			);
		case 'or':
			return cond.of.some((c) =>
				evaluateCondition(
					state,
					c,
					controllerId,
					sourceInstanceId,
					stackItem,
					source,
					eventObject,
					eventLki,
					matchExtras
				)
			);
		case 'not':
			return !evaluateCondition(
				state,
				cond.of,
				controllerId,
				sourceInstanceId,
				stackItem,
				source,
				eventObject,
				eventLki,
				matchExtras
			);
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
				source:
					cond.k === 'manaColorSpentToCast' && effTriggerEventStackItem ? undefined : srcObj,
				stackItem:
					cond.k === 'manaColorSpentToCast'
						? (effTriggerEventStackItem ?? stackItem)
						: stackItem,
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
					source:
						cond.k === 'sameColorManaSpentAtLeast' && effTriggerEventStackItem
							? undefined
							: srcObj,
					stackItem:
						cond.k === 'sameColorManaSpentAtLeast'
							? (effTriggerEventStackItem ?? stackItem)
							: stackItem,
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
		// --- Wave 6 Shared ---
		case 'isPaired': {
			const srcObj = permanentById(state, sourceInstanceId)?.obj ?? source?.obj;
			return Boolean(srcObj?.pairedWithId);
		}
		case 'tributePaid': {
			const srcObj = permanentById(state, sourceInstanceId)?.obj ?? source?.obj;
			// --- Track P18a ---
			return Boolean(srcObj?.tributePaid || stackItem?.sourceTributePaid);
			// --- End Track P18a ---
		}
		case 'hasEnduringStory': {
			const srcObj = permanentById(state, sourceInstanceId)?.obj ?? source?.obj;
			// --- Track P18a ---
			return Boolean(srcObj?.hasEnduringStory || controller.hasEnduringStory);
			// --- End Track P18a ---
		}
		case 'isHarnessed': {
			const srcObj = permanentById(state, sourceInstanceId)?.obj ?? source?.obj;
			return Boolean(srcObj?.isHarnessed);
		}
		// --- End Wave 6 Shared ---
		// --- Track P18b ---
		case 'anchorWordChosen': {
			const srcObj = permanentById(state, sourceInstanceId)?.obj ?? source?.obj;
			return (srcObj?.chosenAnchorWord ?? '').trim().toLowerCase() === cond.word.trim().toLowerCase();
		}
		// --- End Track P18b ---
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
					const thatId = effEventPlayerId;
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
	// --- Track P16b ---
	const srcObjFallback = permanentById(state, sourceInstanceId)?.obj ?? source?.obj;
	const w5 = evaluateWave5Condition(cond, {
		state,
		controllerId,
		source: srcObjFallback,
		stackItem
	});
	if (w5 !== null) return w5;
	const p16b = evaluateP16bCondition(
		cond,
		{
			state,
			controllerId,
			source: srcObjFallback,
			stackItem,
			eventPlayerId: effEventPlayerId,
			eventObject,
			eventLki
		},
		matchesObjectFilter
	);
	if (p16b !== null) return p16b;
	if (cond.k === 'p17bCondition') {
		return evaluateP17bCondition(
			cond,
			{ state, controllerId, source: srcObjFallback, stackItem },
			matchesObjectFilter
		);
	}
	// --- End Track P16b ---
	// --- Track P19b ---
	const p19b = evaluateP19bCondition(
		cond,
		{
			state,
			controllerId,
			sourceInstanceId,
			source: srcObjFallback,
			stackItem,
			triggerEventStackItem: effTriggerEventStackItem,
			eventObject:
				eventObject ??
				(stackItem?.eventObjectId ? permanentById(state, stackItem.eventObjectId)?.obj : undefined)
		},
		matchesObjectFilter
	);
	if (p19b !== undefined) return p19b;
	// --- End Track P19b ---
	// --- Track P22b ---
	const p22b = evaluateP22bCondition(
		cond,
		{
			state,
			controllerId,
			sourceInstanceId,
			source: srcObjFallback,
			stackItem,
			triggerEventStackItem: effTriggerEventStackItem,
			eventObject:
				eventObject ??
				(stackItem?.eventObjectId ? permanentById(state, stackItem.eventObjectId)?.obj : undefined),
			eventLki: eventLki ?? stackItem?.eventLki,
			eventPlayerId: effEventPlayerId,
			eventIsManaAbility: matchExtras?.p22bEventIsManaAbility,
			eventLifePaid: matchExtras?.p22bEventLifePaid,
			eventCrewCount: matchExtras?.p22bEventCrewCount,
			eventDamageSourceSubtypes: matchExtras?.p22bEventDamageSourceSubtypes,
			eventAttackedTargetPlayerId: matchExtras?.p22bEventAttackedTargetPlayerId
		},
		matchesObjectFilter
	);
	if (p22b !== undefined) return p22b;
	// --- End Track P22b ---
	// --- Track P22c ---
	if (cond.k === 'youDiscardedThisTurn') {
		return evaluateObjectFilterCondition(cond, {
			state,
			controllerId,
			source: srcObjFallback,
			stackItem
		});
	}
	// --- End Track P22c ---
	// --- Wave 9 ---
	const w9 = evaluateWave9Condition(
		cond,
		{
			state,
			controllerId,
			sourceInstanceId,
			source: srcObjFallback,
			stackItem,
			triggerEventStackItem: effTriggerEventStackItem,
			eventObject:
				eventObject ??
				(stackItem?.eventObjectId ? permanentById(state, stackItem.eventObjectId)?.obj : undefined),
			eventLki: eventLki ?? stackItem?.eventLki,
			eventPlayerId: effEventPlayerId
		},
		matchesObjectFilter
	);
	if (w9 !== undefined) return w9;
	// --- End Wave 9 ---
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
					return Object.values(ctrs).reduce<number>(
						(acc, n) => acc + (n && n > 0 ? n : 0),
						0
					);
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
		// --- Track P22b ---
		case 'opponentsLifeLostThisTurn':
		case 'targetsTotalManaValue':
			return evaluateP22bAmount(a, state, controllerId, stackItem);
		// --- End Track P22b ---
		// --- Track P22c ---
		case 'distinctNamesCount':
		case 'creaturesDiedThisTurn':
		case 'spellsCastThisTurnCount':
		case 'playerCounters':
		case 'conditional': {
			const srcFound = permanentById(state, sourceInstanceId);
			return evaluateObjectFilterAmount(a, {
				state,
				controllerId,
				source: srcFound?.obj ?? source?.obj,
				stackItem
			});
		}
		// --- End Track P22c ---
		default:
			return null;
	}
}


// ---- Compiled triggers per card -------------------------------------------------------------

export interface CardTriggers {
	all: RuntimeTrigger[];
	/** Event kinds any alternative of any ability listens to. */
	events: Set<EventKind>;
	/** Event kinds of parameterless grantable trigger keywords granted by continuous statics on this card. */
	grantedTriggerEvents: Set<EventKind>;
}

const CARD_TRIGGERS = new WeakMap<ScryfallCard, Map<number, CardTriggers>>();

export function grantedTriggerEventsForKeyword(kw: string): readonly EventKind[] | null {
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
	// --- Track P18a ---
	const wave6Evs = grantedWave6TriggerEvents(kw);
	if (wave6Evs) return wave6Evs;
	// --- End Track P18a ---
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

export function triggersOf(card: ScryfallCard, faceIndex = 0): CardTriggers {
	let byFace = CARD_TRIGGERS.get(card);
	if (!byFace) {
		byFace = new Map();
		CARD_TRIGGERS.set(card, byFace);
	}
	let entry = byFace.get(faceIndex);
	if (!entry) {
		const def = compileCard(card);
		const faceAbs = def.faces[faceIndex]?.abilities ?? [];
		// --- Track P12 & P18a ---
		const baseRts = runtimeTriggers(def, faceIndex).map(
			(rt): Wave4RuntimeTrigger & Wave6RuntimeTrigger =>
				attachWave6TagToBaseRuntimeTrigger(
					attachWave4TagToBaseRuntimeTrigger(rt, faceAbs),
					faceAbs
				)
		);
		const all: RuntimeTrigger[] = baseRts.filter(
			(t) =>
				Boolean(t.wave4Tag) ||
				Boolean(t.wave6Tag) ||
				!host?.canExecute ||
				host.canExecute(t)
		);
		// --- End Track P12 & P18a ---
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

export function activeFacesForObject(
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



export function isLayer6EmittedTriggerKeyword(kwRaw: string): boolean {
	const kwLow = kwRaw.trim().toLowerCase();
	if (kwLow === 'undying' || kwLow === 'persist') return true;
	if (kwLow === 'ward' || kwLow.startsWith('ward ') || kwLow.startsWith('ward—')) return true;
	if (parseGrantedWave4TriggerKeyword(kwLow) !== null) return true;
	if (grantedWave6TriggerEvents(kwLow) !== null) return true;
	const spec = getKeywordSpec(kwLow);
	return Boolean(
		spec?.status === 'implemented' &&
			spec.grantable &&
			spec.parameterKind === 'none' &&
			spec.implementation?.kind === 'trigger'
	);
}

// --- Track P10: Compile quoted EOT-granted triggered abilities on demand ---
export function quotedTriggersForTexts(
	cardName: string,
	texts: readonly string[],
	opts?: { includeLayer6Keywords?: boolean }
): Array<{ ability: RuntimeTrigger; text: string }> {
	const out: Array<{ ability: RuntimeTrigger; text: string }> = [];
	for (const gt of texts) {
		const defs = resolveQuotedAbilityDefs(gt, cardName);
		const filteredDefs = opts?.includeLayer6Keywords
			? defs
			: defs.filter(
					(d) =>
						!(
							d.kind === 'keyword' &&
							(d.keyword.name.toLowerCase() === 'backup' ||
								isLayer6EmittedTriggerKeyword(formatGrantedKeywordDef(d.keyword)))
						)
				);
		if (filteredDefs.length === 0) continue;
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
						abilities: filteredDefs
					}
				]
			},
			0
		)
			.map((rt): Wave4RuntimeTrigger & Wave6RuntimeTrigger =>
				attachWave6TagToBaseRuntimeTrigger(
					attachWave4TagToBaseRuntimeTrigger(rt, filteredDefs),
					filteredDefs
				)
			)
			.filter(
				(t) =>
					Boolean(t.wave4Tag) ||
					Boolean(t.wave6Tag) ||
					!host?.canExecute ||
					host.canExecute(t)
			);
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

// --- Track P12: Shared LKI helper for surviving timed quoted & backup zone-change triggers ---
export function collectSurvivingTimedGrantedAbilityTexts(
	state: GameState,
	perm: CardInstance
): string[] {
	if (!state.timedContinuousEffects?.length) return [];
	const ver = perm.objectVersion || 1;
	const texts: string[] = [];
	for (const eff of state.timedContinuousEffects) {
		const hasQuoted = Boolean(eff.layer6?.grantedAbilityTexts?.length);
		if (!hasQuoted && !eff.backupGrant) continue;
		const affected = eff.affected.some(
			(a) =>
				a.instanceId === perm.instanceId &&
				(a.objectVersion === undefined || a.objectVersion === ver)
		);
		if (
			!affected ||
			!isTimedContinuousEffectActiveForState(state, eff) ||
			!timedLayer6AbilitySurvivesRemoval(perm, state, eff.timestamp, false)
		) {
			continue;
		}
		if (eff.layer6?.grantedAbilityTexts?.length) {
			for (const gt of eff.layer6.grantedAbilityTexts) {
				const defs = resolveQuotedAbilityDefs(gt, perm.card.name);
				if (
					defs.length > 0 &&
					defs.every(
						(d) =>
							d.kind === 'keyword' &&
							(d.keyword.name.toLowerCase() === 'backup' ||
								isLayer6EmittedTriggerKeyword(formatGrantedKeywordDef(d.keyword)))
					)
				) {
					continue;
				}
				texts.push(gt);
			}
		}
		if (eff.backupGrant) {
			const bDef = compileCard(eff.backupGrant.sourceCard);
			const faceAbs =
				eff.backupGrant.faceIndex > 0 && bDef.faces?.[eff.backupGrant.faceIndex]
					? bDef.faces[eff.backupGrant.faceIndex].abilities
					: (bDef.faces[0]?.abilities ?? []);
			for (const bt of triggersOf(eff.backupGrant.sourceCard, eff.backupGrant.faceIndex).all) {
				const rawIdx = bt.abilityIndex >= 5000 ? bt.abilityIndex - 5000 : bt.abilityIndex;
				if (rawIdx < eff.backupGrant.startAbilityIndex || !bt.text) continue;
				const abDef = faceAbs[rawIdx];
				if (abDef?.kind === 'keyword') {
					const formatted = formatGrantedKeywordDef(abDef.keyword);
					if (
						abDef.keyword.name.toLowerCase() === 'backup' ||
						isLayer6EmittedTriggerKeyword(formatted)
					) {
						continue;
					}
				}
				if (alternatives(bt.trigger).some((a) => a.event === 'zoneChange')) {
					texts.push(bt.text);
				}
			}
		}
	}
	return texts;
}
// --- End Track P12 ---

/**
 * Every object whose abilities can trigger on `kind`: battlefield permanents (not phased out) and
 * graveyard cards with `fromZone: 'graveyard'` abilities, in seat order then zone order. Players who
 * have left the game are skipped (CR 800.4a).
 */
export function sources(state: GameState, kind: EventKind): Source[] {
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
						) &&
						isTimedContinuousEffectActiveForState(state, eff) &&
						timedLayer6AbilitySurvivesRemoval(perm, state, eff.timestamp, false)
					) {
						(grantedTexts ??= []).push(...eff.layer6.grantedAbilityTexts);
					}
				}
			}
			let addedForPerm = false;
			// --- End Track P10 ---
			const activeFaces = activeFacesForObject(perm, card, 'battlefield', state);
			for (const faceIndex of activeFaces) {
				if (triggersOf(card, faceIndex).events.has(kind)) {
					out.push({
						obj: perm,
						card,
						faceIndex,
						controllerId: p.playerId,
						zone: 'battlefield',
						// --- Track P10 ---
						...(addedForPerm
							? { includeTimedGrants: false }
							: grantedTexts
								? { grantedAbilityTexts: grantedTexts }
								: {})
						// --- End Track P10 ---
					});
					addedForPerm = true;
				}
			}
			// --- Track P18a: Merged permanents also inherit triggered abilities of underneath components (CR 731.2b / CR 707.2) ---
			const effCopyForMerged = activeTimedLayer1aForPermanent(state, perm) ?? perm.copiableState;
			const effMergedForTriggers = effCopyForMerged
				? effCopyForMerged.mergedComponents
				: perm.mergedComponents;
			if (!perm.isFaceDown && effMergedForTriggers && effMergedForTriggers.length > 1) {
				for (let cIdx = 1; cIdx < effMergedForTriggers.length; cIdx++) {
					const mc = effMergedForTriggers[cIdx]!;
					if (triggersOf(mc, 0).events.has(kind)) {
						out.push({
							obj: perm,
							card: mc,
							faceIndex: 0,
							controllerId: p.playerId,
							zone: 'battlefield',
							...(addedForPerm
								? { includeTimedGrants: false }
								: grantedTexts
									? { grantedAbilityTexts: grantedTexts }
									: {})
						});
						addedForPerm = true;
					}
				}
			}
			// --- End Track P18a ---
			// --- Track P10 ---
			if (!addedForPerm && grantedTexts) {
				const qts = quotedTriggersForTexts(card.name, grantedTexts);
				if (qts.some((q) => alternatives(q.ability.trigger).some((a) => a.event === kind))) {
					out.push({
						obj: perm,
						card,
						faceIndex: activeFaces[0] ?? 0,
						controllerId: p.playerId,
						zone: 'battlefield',
						skipInnate: true,
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
				state.timedContinuousEffects?.some(
					(eff) =>
						Boolean(eff.backupGrant) &&
						eff.affected.some(
							(a) =>
								a.instanceId === perm.instanceId &&
								(a.objectVersion === undefined || (perm.objectVersion ?? 1) === a.objectVersion)
						) &&
						isTimedContinuousEffectActiveForState(state, eff) &&
						timedLayer6AbilitySurvivesRemoval(perm, state, eff.timestamp, false)
				) &&
				collectBackupGrantedAbilityDefs(state, perm).length > 0
			) {
				out.push({
					obj: perm,
					card,
					faceIndex: activeFaces[0] ?? 0,
					controllerId: p.playerId,
					zone: 'battlefield',
					skipInnate: true,
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
				// --- Track P16b: per-alternative fromZone support for compound triggers ---
				if (
					t.events.has(kind) &&
					t.all.some((a) =>
						alternatives(a.trigger).some(
							(alt) => alt.event === kind && (alt.fromZone ?? a.trigger.fromZone) === 'graveyard'
						)
					)
				) {
					out.push({ obj: c, card: c.card, faceIndex, controllerId: p.playerId, zone: 'graveyard' });
				}
				// --- End Track P16b ---
			}
		}
		// --- Track P16b & P18a: Exile-zone trigger sources (CR 702.55c Haunt, time-counter removal) ---
		for (const ex of p.exile) {
			for (const faceIndex of activeFacesForObject(ex, ex.card, 'exile', state)) {
				const t = triggersOf(ex.card, faceIndex);
				if (
					t.events.has(kind) &&
					t.all.some((a) =>
						alternatives(a.trigger).some(
							(alt) =>
								alt.event === kind &&
								((alt.fromZone ?? a.trigger.fromZone) === 'exile' ||
									(alt.event === 'hauntedCreatureDies' && Boolean(ex.hauntingTargetId)))
						)
					)
				) {
					out.push({
						obj: ex,
						card: ex.card,
						faceIndex,
						controllerId: ex.ownerId || p.playerId,
						zone: 'exile'
					});
				}
			}
		}
		// --- End Track P16b & P18a ---
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
	// --- Track P19b: Spell-created event-driven delayed triggers (CR 603.7a–b) ---
	if (state.wave7SpellDelayedTriggers?.length) {
		for (const dt of state.wave7SpellDelayedTriggers) {
			if (dt.waitForNextCombatThisTurn) continue;
			const ctrl = state.players.find((pl) => pl.playerId === dt.controllerId && !pl.lost);
			if (!ctrl) continue;
			const rt =
				dt.subTriggerStepIndex !== undefined
					? reconstructWave9DelayedRuntimeTrigger(dt)
					: triggersOf(dt.sourceCard, dt.faceIndex).all.find(
							(a) => a.abilityIndex === dt.abilityIndex
						);
			if (!rt) continue;
			if (!alternatives(rt.trigger).some((alt) => alt.event === kind)) continue;
			out.push({
				obj: makeSynthCardInstance(dt.sourceInstanceId, dt.sourceCard, dt.controllerId, 'command'),
				card: dt.sourceCard,
				faceIndex: dt.faceIndex,
				controllerId: dt.controllerId,
				zone: 'command',
				wave7SpellDelayed: { entry: dt, runtimeTrigger: rt }
			});
		}
	}
	// --- End Track P19b ---
	return out;
}

/**
 * The abilities of `source` that function in its zone, each with its alternatives for `kind` that
 * pass the cheap `pre` check (event fields only). Ability loss is checked last because it's costly.
 */
export function abilitiesFor(
	state: GameState,
	source: Source,
	kind: EventKind,
	pre: (alt: TriggerDef) => boolean = () => true
): Array<{ ability: RuntimeTrigger; alts: TriggerDef[]; grantedAbilityText?: string }> {
	// --- Track P19b: Spell-created event-driven delayed triggers (CR 603.7a–b) ---
	if (source.wave7SpellDelayed) {
		const ability = source.wave7SpellDelayed.runtimeTrigger;
		const alts = alternatives(ability.trigger).filter((a) => a.event === kind && pre(a));
		return alts.length > 0 ? [{ ability, alts }] : [];
	}
	// --- End Track P19b ---
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
	// --- Track P18a: Exiled Haunt cards function from exile on `hauntedCreatureDies` (CR 702.55c) ---
	const isHauntExileSource = Boolean(
		source.zone === 'exile' && source.obj.hauntingTargetId && kind === 'hauntedCreatureDies'
	);
	// --- End Track P18a ---
	if (!source.skipInnate) {
		for (const ability of triggersOf(source.card, source.faceIndex ?? 0).all) {
			// --- Track P16b & P18a: per-alternative fromZone matching for mixed-zone compound triggers (CR 603.1b) ---
			const altMatchesZone = (a: TriggerDef): boolean => {
				// --- Track P19b: spell-delayed abilities fire only via `wave7SpellDelayedTriggers` ---
				if (a.spellDelayed || ability.trigger.spellDelayed) return false;
				// --- End Track P19b ---
				const zone = a.fromZone ?? ability.trigger.fromZone ?? 'battlefield';
				if (zone === 'any' || isEmblemSource || isHauntExileSource) return true;
				if (source.zone === 'stack') return kind === 'cast';
				return zone === source.zone;
			};
			const candidateAlts = alternatives(ability.trigger).filter(
				(a) => a.event === kind && altMatchesZone(a)
			);
			if (candidateAlts.length === 0) continue;
			// --- End Track P16b & P18a ---
			// CR 711.2 / CR 722.2: Striated Leveler and Station abilities exist only while their counter threshold holds.
			if (
				ability.grantCondition &&
				!evaluateCondition(state, ability.grantCondition, source.controllerId, source.obj.instanceId, undefined, source)
			) {
				continue;
			}
			const alts = candidateAlts.filter(pre);
			if (alts.length > 0) out.push({ ability, alts });
		}
	}
	// CR 613 layer 6: a permanent that lost all abilities loses innate and merged rules-text triggered abilities.
	if (
		out.length > 0 &&
		(source.lostAllAbilities ??
			(source.zone === 'battlefield' && permanentHasLostAllAbilities(source.obj, state).lost))
	) {
		out.length = 0;
	}
	if (source.includeTimedGrants !== false) {
		// --- Track P10 ---
		if (source.isLookBack) {
			if (source.grantedAbilityTexts?.length && source.zone === 'battlefield') {
				for (const q of quotedTriggersForTexts(source.card.name, source.grantedAbilityTexts)) {
					const alts = alternatives(q.ability.trigger).filter((a) => a.event === kind && pre(a));
					if (alts.length > 0) {
						out.push({ ability: q.ability, alts, grantedAbilityText: q.text });
					}
				}
			}
		} else if (source.zone === 'battlefield' && state.timedContinuousEffects?.length) {
			const ver = source.obj.objectVersion ?? 1;
			for (const eff of state.timedContinuousEffects) {
				if (eff.layer6?.grantedAbilityTexts?.length) {
					if (
						eff.affected.some(
							(a) => a.instanceId === source.obj.instanceId && (a.objectVersion ?? 1) === ver
						) &&
						isTimedContinuousEffectActiveForState(state, eff) &&
						timedLayer6AbilitySurvivesRemoval(source.obj, state, eff.timestamp, false)
					) {
						for (const q of quotedTriggersForTexts(
							source.card.name,
							eff.layer6.grantedAbilityTexts
						)) {
							const alts = alternatives(q.ability.trigger).filter((a) => a.event === kind && pre(a));
							if (alts.length > 0) {
								out.push({ ability: q.ability, alts, grantedAbilityText: q.text });
							}
						}
					}
				}
				// --- Track P12: Backup-granted triggered abilities (CR 702.165a–d) ---
				if (eff.backupGrant) {
					const aff = eff.affected.find((a) => a.instanceId === source.obj.instanceId);
					if (
						aff &&
						(aff.objectVersion === undefined || ver === aff.objectVersion) &&
						isTimedContinuousEffectActiveForState(state, eff) &&
						timedLayer6AbilitySurvivesRemoval(source.obj, state, eff.timestamp, false)
					) {
						const bDef = compileCard(eff.backupGrant.sourceCard);
						const faceAbs =
							eff.backupGrant.faceIndex > 0 && bDef.faces?.[eff.backupGrant.faceIndex]
								? bDef.faces[eff.backupGrant.faceIndex].abilities
								: (bDef.faces[0]?.abilities ?? []);
						const bTrigs = triggersOf(eff.backupGrant.sourceCard, eff.backupGrant.faceIndex).all;
						for (const bt of bTrigs) {
							const rawIdx = bt.abilityIndex >= 5000 ? bt.abilityIndex - 5000 : bt.abilityIndex;
							if (rawIdx < eff.backupGrant.startAbilityIndex) continue;
							const abDef = faceAbs[rawIdx];
							if (abDef?.kind === 'keyword') {
								const formatted = formatGrantedKeywordDef(abDef.keyword);
								if (
									abDef.keyword.name.toLowerCase() === 'backup' ||
									isLayer6EmittedTriggerKeyword(formatted)
								) {
									continue;
								}
							}
							const alts = alternatives(bt.trigger).filter((a) => a.event === kind && pre(a));
							if (alts.length > 0) {
								out.push({
									ability: bt.text
										? ({ ...bt, grantedAbilityText: bt.text } as RuntimeTrigger)
										: bt,
									alts,
									...(bt.text ? { grantedAbilityText: bt.text } : {})
								});
							}
						}
					}
				}
				// --- End Track P12 ---
			}
		}
		// --- End Track P10 ---
	}
	return out;
}

