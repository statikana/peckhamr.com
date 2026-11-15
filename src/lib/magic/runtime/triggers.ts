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
import type { Amount, Condition, EventFilter, EventKind, ObjectFilter, TriggerDef } from '../ir.ts';
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
import { playerCommanderCastCount } from './objectFilter.ts';
import { triggerMultiplier } from './replace.ts';

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
	eventLki?: { controllerId: string; power?: number; toughness?: number };
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
		const all = runtimeTriggers(def, faceIndex).filter((t) => !host?.canExecute || host.canExecute(t));
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
}

interface TriggerChannel {
	pending: PendingTrigger[];
	nextOrder: number;
	flushing: number;
	deferFlush: number;
	simultaneousLki?: Map<CardInstance, SimultaneousLkiEntry>;
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
		map.set(perm, {
			obj: perm,
			card: perm.copiableCard ?? perm.card,
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
			counters: { ...perm.counters }
		});
	}
	const prevMap = ch.simultaneousLki;
	ch.simultaneousLki = map;
	ch.deferFlush += 1;
	try {
		fn();
	} finally {
		ch.deferFlush -= 1;
		ch.simultaneousLki = prevMap;
	}
	flushTriggers(state);
}

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
	return (channels.get(state)?.pending.length ?? 0) > 0 || (state.pendingTriggers?.length ?? 0) > 0;
}

/** For tests: the triggers waiting for the next flush. */
export function peekPendingTriggers(state: GameState): readonly PendingTrigger[] {
	return [...(state.pendingTriggers ?? []), ...(channels.get(state)?.pending ?? [])];
}

// ---- Objects as triggers see them -----------------------------------------------------------

/** The object an event is about, with the characteristics trigger filters check. */
interface Subject {
	obj: CardInstance;
	controllerId: string;
	isToken: boolean;
	tapped: boolean;
	saddled?: boolean;
	monstrous?: boolean;
	colors: string[];
	typeLine: () => string;
	hasSubtype: (subtype: string) => boolean;
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
		get colors() {
			return obj.isFaceDown ? [] : ev().colors;
		},
		typeLine: () => ev().typeLine,
		hasSubtype: (s) => ev().hasSubType(s)
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
	monstrous = Boolean(obj.isMonstrous)
): Subject {
	return {
		obj,
		controllerId,
		isToken: obj.isToken,
		tapped,
		saddled,
		monstrous,
		colors,
		typeLine: () => typeLine,
		hasSubtype: (s) => hasWord(subtypePart(typeLine), s) || (allCreatureTypes && hasWord(typeLine, 'Creature'))
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
}

const viewerOf = (source: Source): Viewer => ({
	id: source.obj.instanceId,
	controllerId: source.controllerId,
	...(source.chosenSubType ?? source.obj.chosenSubType
		? { chosenSubType: source.chosenSubType ?? source.obj.chosenSubType }
		: {}),
	...(source.chosenColor ?? source.obj.chosenColor
		? { chosenColor: source.chosenColor ?? source.obj.chosenColor }
		: {})
});

/** Does `subject` match an ObjectFilter, from the point of view of the trigger's source? */
function filterMatches(f: ObjectFilter, subject: Subject, source: Viewer): boolean {
	if (f.other && subject.obj.instanceId === source.id) return false;
	const typeLine = f.types || f.supertypes || f.notTypes || f.notSupertypes ? subject.typeLine() : '';
	if (f.types && !f.types.some((t) => hasWord(typeLine, t))) return false;
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
	if (f.controller === 'you' && subject.controllerId !== source.controllerId) return false;
	if (f.controller === 'opponent' && subject.controllerId === source.controllerId) return false;
	if (f.owner === 'you' && subject.obj.ownerId !== source.controllerId) return false;
	if (f.owner === 'opponent' && subject.obj.ownerId === source.controllerId) return false;
	if (f.isCommander !== undefined && Boolean(subject.obj.isCommander) !== f.isCommander) return false;
	if (f.token !== undefined && subject.isToken !== f.token) return false;
	if (f.tapped !== undefined && subject.tapped !== f.tapped) return false;
	if (f.saddled !== undefined && Boolean(subject.saddled) !== f.saddled) return false;
	if (f.monstrous !== undefined && Boolean(subject.monstrous) !== f.monstrous) return false;
	if (f.colors && !matchesColorFilter(subject.colors, f.colors)) return false;
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
}

/**
 * Every object whose abilities can trigger on `kind`: battlefield permanents (not phased out) and
 * graveyard cards with `fromZone: 'graveyard'` abilities, in seat order then zone order. Players who
 * have left the game are skipped (CR 800.4a).
 */
function sources(state: GameState, kind: EventKind): Source[] {
	const out: Source[] = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const card = perm.copiableCard ?? perm.card;
			for (const faceIndex of activeFacesForObject(perm, card, 'battlefield', state)) {
				if (triggersOf(card, faceIndex).events.has(kind)) {
					out.push({ obj: perm, card, faceIndex, controllerId: p.playerId, zone: 'battlefield' });
				}
			}
		}
		for (const c of p.graveyard) {
			for (const faceIndex of activeFacesForObject(c, c.card, 'graveyard', state)) {
				const t = triggersOf(c.card, faceIndex);
				if (t.events.has(kind) && t.all.some((a) => a.trigger.fromZone === 'graveyard')) {
					out.push({ obj: c, card: c.card, faceIndex, controllerId: p.playerId, zone: 'graveyard' });
				}
			}
		}
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
): Array<{ ability: RuntimeTrigger; alts: TriggerDef[] }> {
	const out: Array<{ ability: RuntimeTrigger; alts: TriggerDef[] }> = [];
	for (const ability of triggersOf(source.card, source.faceIndex ?? 0).all) {
		const zone = ability.trigger.fromZone ?? 'battlefield';
		// "When you cast ~" functions while the spell is on the stack (CR 603.2, 113.6).
		// "When you cycle ~" (`fromZone: 'any'`) triggers from whatever zone the card winds up in (CR 702.29c).
		if (
			ability.trigger.fromZone !== 'any' &&
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
}

function record(state: GameState, source: Source, ability: RuntimeTrigger, kind: EventKind, extras: MatchExtras): void {
	// CR 603.4: an intervening-if condition must be true when the event happens.
	if (
		ability.condition &&
		!evaluateCondition(state, ability.condition, source.controllerId, source.obj.instanceId, undefined, source, extras.eventObject)
	) {
		return;
	}
	let count = extras.times ?? 1;
	if (count <= 0) return;
	// CR 603.2i: "This ability triggers only once each turn" cannot trigger more than once per turn
	// per object identity in that zone (CR 400.7), even under trigger multipliers.
	if (ability.trigger.onlyOncePerTurn) {
		const abilityTag = ability.grantedKeyword ?? `${source.faceIndex ?? 0}:${ability.abilityIndex}`;
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
	}
}

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

	matchEventKind('discard', sources(state, 'discard'));
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
						Boolean(objBatchInfo.monstrous)
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
							Boolean(ev.lki.monstrous)
						)
					: printedSubject(obj, obj.card, obj.ownerId);
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
						...(info.monstrous ? { monstrous: true } : {}),
						...(info.counters ? { counters: info.counters } : {})
					});
				}
			}
		} else if (ev.lki) {
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
					...(ev.lki.counters ? { counters: ev.lki.counters } : {})
				});
			}
		}
	}
	const lkiAttachedIds = objBatchInfo?.attachedIds ?? ev.lki?.attachedIds;
	for (const source of candidates) {
		for (const { ability, alts } of abilitiesFor(state, source, 'zoneChange', fits)) {
			const alt = alts.find((a) => objectMatches(a.filter, subject, source, lkiAttachedIds));
			if (!alt) continue;
			// Only look-back objects check leaves-the-battlefield triggers; other permanents see the event normally.
			if ((source.obj === obj || source.isLookBack) && ev.from === 'battlefield' && alt.filter.from !== 'battlefield') continue;
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
							...(objBatchInfo.toughness !== undefined ? { toughness: objBatchInfo.toughness } : {})
						}
					: ev.lki
						? { controllerId: ev.lki.controllerId, power: ev.lki.power, toughness: ev.lki.toughness }
						: undefined;
			record(state, source, ability, 'zoneChange', { label: label(source, alt), eventObject: obj, amount: enteredPower(), times, eventLki });
		}
	}
}

function boardCanGrantTriggerKeyword(
	state: GameState,
	kind: EventKind,
	focusPerms: readonly CardInstance[]
): boolean {
	if (!GRANTED_TRIGGER_KEYWORD_EVENTS.has(kind)) return false;
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
			const pCard = perm.copiableCard ?? perm.card;
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
	const card = perm.copiableCard ?? perm.card;
	const source: Source = { obj: perm, card, controllerId, zone: 'battlefield' };
	for (const item of breakdown.items) {
		if (item.removed) continue;
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
		castView.colors
	);
	let triggerEventStackItem: StackItem | undefined;
	if (stackSpell) {
		triggerEventStackItem = JSON.parse(JSON.stringify(stackSpell)) as StackItem;
		delete triggerEventStackItem.effectResume;
		delete triggerEventStackItem.triggerEventStackItem;
	}
	const totalCast = state.players.reduce((sum, pl) => sum + (pl.spellsCastThisTurn ?? 0), 0);
	const stormCount = isCopy ? 0 : Math.max(0, totalCast - 1);
	const candidates = sources(state, 'cast');
	if (!isCopy) {
		for (const faceIndex of activeFacesForObject(spell, spell.card, 'stack', state)) {
			candidates.push({ obj: spell, card: spell.card, faceIndex, controllerId: casterId, zone: 'stack' });
		}
	}
	const casterForCount = state.players.find((p) => p.playerId === casterId);
	const castCountThisTurn = casterForCount?.spellsCastThisTurn ?? 0;
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
			const isHeroic = Boolean(alt.filter.targetsSelf);
			record(state, source, ability, 'cast', {
				label: isStorm ? 'Storm' : ability.text === 'Prowess' ? 'Prowess' : isHeroic ? 'Heroic' : 'On Cast',
				times,
				eventObject: spell,
				eventPlayer: casterId,
				...(triggerEventStackItem ? { triggerEventStackItem } : {}),
				...(isStorm ? { stormCount } : {})
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
				if (f.object === undefined) {
					// "Whenever you attack".
					if (f.player?.relation === 'you' && attackingPlayerId === source.controllerId && attackers.length > 0) {
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attacks',
										attackers: attackers.map((s) => s.obj)
									})
								: 1;
						record(state, source, ability, 'attacks', { label: 'Attack', times });
						break;
					}
					continue;
				}
				const matching = attackers.filter((s) => objectMatches(f, s, source));
				if (matching.length === 0) continue;
				if (f.object === 'self' || f.oneOrMore) {
					const defendingPlayerId =
						f.object === 'self'
							? attackerDefenderId(source.obj.instanceId)
							: f.alone && matching.length === 1
								? attackerDefenderId(matching[0].obj.instanceId)
								: undefined;
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
						...(f.oneOrMore ? { amount: matching.length } : {})
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
	void defenderId;
	for (const kind of ['blocks', 'becomesBlocked'] as const) {
		const subjects = kind === 'blocks' ? blockers : blocked;
		for (const source of sources(state, kind)) {
			for (const { ability, alts } of abilitiesFor(state, source, kind)) {
				const alt = alts[0];
				const matching = subjects.filter((s) => objectMatches(alt.filter, s, source));
				if (alt.filter.object === 'self') {
					if (matching.length > 0) record(state, source, ability, kind, { label: kind === 'blocks' ? 'Block' : 'Blocked' });
				} else {
					for (const s of matching) record(state, source, ability, kind, { label: kind === 'blocks' ? 'Block' : 'Blocked', eventObject: s.obj });
				}
			}
		}
		if (boardCanGrantTriggerKeyword(state, kind, subjects.map((s) => s.obj))) {
			for (const s of subjects) {
				emitGrantedTriggerKeywords(
					state,
					s.obj,
					s.controllerId,
					kind,
					(rt) => alternatives(rt.trigger).some((a) => a.event === kind && a.filter.object === 'self'),
					(rt, times) => ({ label: rt.text || (kind === 'blocks' ? 'Block' : 'Blocked'), times }),
					() => 1
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
				const alt = alts.find(
					(a) => (!a.filter.combat || ev.combat) && damageToFits(a.filter.damageTo) && objectMatches(a.filter, dealerSubject, source)
				);
				if (!alt) continue;
				record(state, source, ability, 'dealsDamage', {
					label: ev.combat ? 'Combat Damage Trigger' : 'Damage Trigger',
					eventObject: damaged ? damaged.obj : dealerSubject.obj,
					eventPlayerId: ev.targetKind === 'player' ? ev.targetId : undefined,
					amount: ev.amount
				});
			}
		}
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
			if (!alts.some((a) => a.filter.phase === ev.phase)) continue;
			const scope = ability.trigger.scope ?? 'each_turn';
			if (scope === 'controller_turn' && source.controllerId !== ev.activePlayerId) continue;
			if (scope === 'opponent_turn' && source.controllerId === ev.activePlayerId) continue;
			const step = ev.phase === 'upkeep' ? 'Upkeep' : ev.phase === 'end_step' ? 'End Step' : 'Phase';
			record(state, source, ability, 'phaseBegin', {
				label: source.zone === 'graveyard' ? `Graveyard ${step}` : `${step} Trigger`,
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
		const card = ev.object.copiableCard ?? ev.object.card;
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
				for (const ch of chapterAlt.chapterNumbers!) {
					if (prev < ch && next >= ch) {
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
		const card = ev.object.copiableCard ?? ev.object.card;
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
				return objectMatches(a.filter, subject, source);
			});
			if (alt) {
				const label = ability.ward ? 'Ward' : 'Targeted';
				record(state, source, ability, 'becomesTarget', {
					label,
					eventObject: found.obj,
					targetStackItemId: ev.stackItemId
				});
			}
		}
	}
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
			const singleDef = parsed.defs.length === 1 && parsed.unparsed.length === 0 ? parsed.defs[0] : undefined;
			const supported = Boolean(
				singleDef &&
					((singleDef.k === 'mana' && !/\{X\}/i.test(singleDef.cost)) ||
						(singleDef.k === 'payLife' && singleDef.amount.k === 'const'))
			);
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
		for (let guard = 0; ch.pending.length > 0 && guard < 1000; guard++) {
			const batch = ch.pending.splice(0);
			if (state.status === 'finished') return;
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
	eventObject?: CardInstance
): boolean {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return false;
	switch (cond.k) {
		case 'and':
			return cond.of.every((c) =>
				evaluateCondition(state, c, controllerId, sourceInstanceId, stackItem, source, eventObject)
			);
		case 'or':
			return cond.of.some((c) =>
				evaluateCondition(state, c, controllerId, sourceInstanceId, stackItem, source, eventObject)
			);
		case 'not':
			return !evaluateCondition(state, cond.of, controllerId, sourceInstanceId, stackItem, source, eventObject);
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
		case 'matchesFilter':
			return false;
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
		case 'countersOn': {
			if (a.of.k !== 'self') return null;
			if (source?.isLookBack && source.counters) {
				return source.counters[a.counter] ?? 0;
			}
			const found = permanentById(state, sourceInstanceId);
			if (found) return found.obj.counters[a.counter] ?? 0;
			if (source) return source.counters?.[a.counter] ?? source.obj.counters[a.counter] ?? 0;
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
				...(srcFound?.obj.chosenColor ? { chosenColor: srcFound.obj.chosenColor } : {})
			};
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
		default:
			return null;
	}
}
