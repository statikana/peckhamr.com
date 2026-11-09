import type { CardInstance, CounterType, GamePhase, GameState, ScryfallCard, ZoneType } from '../types.ts';

/**
 * Game events (ENGINE_ARCHITECTURE_PLAN.md section 2.3, Phase 2).
 *
 * Events are transient: they're never stored in GameState, so they're never saved to D1 or sent to
 * clients. (Sending them would leak hidden information such as which card a player drew.) Each
 * GameState object has its own queue in a WeakMap. `applyGameAction` drains the queue when its
 * outermost call returns, so a queue never outlives one action.
 *
 * Dispatch is synchronous. `emitEvent` calls the handler registered for the event's kind before it
 * returns, so moving a direct `triggerOnX(...)` call into a handler keeps the order of everything
 * else exactly as it was. Phase 5 replaces the handlers with trigger matching over the queue.
 *
 * Event ids come from a per-state counter. They must never use `Math.random` or `Date.now`, since
 * that would change the RNG stream the engine consumes.
 */

interface EventBase {
	/** Position in this action's queue (1-based, per GameState object). */
	seq: number;
}

/**
 * An object moved from one zone to another (CR 400.7: it becomes a new object). A null `from`
 * means the object didn't exist before (a token being created). `ceasedToExist` means the object
 * left `from` but was not put into `to`: a token leaving the battlefield (CR 704.5d / 111.7), or a
 * sacrificed Treasure.
 */
export interface ZoneChangeEvent extends EventBase {
	kind: 'ZoneChange';
	objectId: string;
	object: CardInstance;
	from: ZoneType | null;
	to: ZoneType;
	fromPlayerId: string | null;
	toPlayerId: string | null;
	ceasedToExist: boolean;
	/** Set when the object left the battlefield: how it looked just before (CR 603.10a look-back). */
	lki?: LeftBattlefieldInfo;
}

/**
 * Last known information of a permanent that left the battlefield, captured by moveObject before
 * the leaves-the-battlefield reset (which clears copy effects, counters and attachments).
 */
export interface LeftBattlefieldInfo {
	/** The copiable values it had (a Clone's copied card), whose abilities "dies" triggers use. */
	card: ScryfallCard;
	controllerId: string;
	/** Effective type line (layer 4) and "every creature type" (Maskwood Nexus, changeling). */
	typeLine: string;
	hasAllCreatureTypes: boolean;
	/** CR 613 layer 6: it had lost all abilities (Humility), so its own abilities don't trigger. */
	lostAllAbilities: boolean;
	isToken: boolean;
	tapped: boolean;
}

/** A spell was cast (it is already on the stack). */
export interface CastEvent extends EventBase {
	kind: 'Cast';
	playerId: string;
	objectId: string;
	object: CardInstance;
}

/** Attackers were declared (CR 508). */
export interface AttackDeclaredEvent extends EventBase {
	kind: 'AttackDeclared';
	playerId: string;
	attackerIds: string[];
}

/**
 * Damage was dealt. `sourceId` is an instanceId, or a playerId when the engine only knows the
 * controller of the source (non-combat damage from a resolving spell or ability).
 */
export interface DamageDealtEvent extends EventBase {
	kind: 'DamageDealt';
	sourceId: string;
	targetId: string;
	targetKind: 'player' | 'permanent';
	amount: number;
	combat: boolean;
}

/** A phase or step began (the engine has just set `state.phase`). */
export interface PhaseBeginEvent extends EventBase {
	kind: 'PhaseBegin';
	phase: GamePhase;
	activePlayerId: string | null;
}

/** Counters were put on a permanent via addCountersToPermanent. */
export interface CounterPlacedEvent extends EventBase {
	kind: 'CounterPlaced';
	objectId: string;
	object: CardInstance;
	counterType: CounterType;
	amount: number;
}

/** Blockers were declared by one defending player (CR 509). */
export interface BlockersDeclaredEvent extends EventBase {
	kind: 'BlockersDeclared';
	/** The defending player who declared these blocks. */
	playerId: string;
	blocks: Array<{ blockerId: string; attackerId: string }>;
}

/** A spell or ability targeted a permanent (CR 115.1; a spell becomes targeting when cast). */
export interface BecameTargetEvent extends EventBase {
	kind: 'BecameTarget';
	objectId: string;
	object: CardInstance;
	by: 'spell' | 'ability';
	/** The player who controls the targeting spell or ability. */
	controllerId: string;
}

/** A copy of a spell was put on the stack (CR 707.10). No engine path creates copies yet. */
export interface SpellCopiedEvent extends EventBase {
	kind: 'SpellCopied';
	playerId: string;
	objectId: string;
	object: CardInstance;
}

/** An Aura or Equipment became attached to a permanent (CR 701.3). */
export interface AttachedEvent extends EventBase {
	kind: 'Attached';
	attachmentId: string;
	attachment: CardInstance;
	hostId: string;
	host: CardInstance;
}

export type GameEvent =
	| ZoneChangeEvent
	| CastEvent
	| AttackDeclaredEvent
	| DamageDealtEvent
	| PhaseBeginEvent
	| CounterPlacedEvent
	| BlockersDeclaredEvent
	| BecameTargetEvent
	| SpellCopiedEvent
	| AttachedEvent;

export type GameEventKind = GameEvent['kind'];
type EventOf<K extends GameEventKind> = Extract<GameEvent, { kind: K }>;
type Unsequenced<E> = E extends GameEvent ? Omit<E, 'seq'> : never;

type Handler<K extends GameEventKind> = (state: GameState, event: EventOf<K>) => void;
type Listener = (state: GameState, event: GameEvent) => void;

interface EventChannel {
	queue: GameEvent[];
	nextSeq: number;
	depth: number;
	listeners: Listener[];
}

const channels = new WeakMap<GameState, EventChannel>();
const handlers: { [K in GameEventKind]?: Handler<K> } = {};

function channel(state: GameState): EventChannel {
	let ch = channels.get(state);
	if (!ch) {
		ch = { queue: [], nextSeq: 1, depth: 0, listeners: [] };
		channels.set(state, ch);
	}
	return ch;
}

/**
 * Registers the dispatcher for one event kind. The engine registers its handlers once, at module
 * load. There's one handler per kind; registering again replaces it.
 */
export function registerEventHandler<K extends GameEventKind>(kind: K, handler: Handler<K>): void {
	(handlers as Record<GameEventKind, Handler<GameEventKind> | undefined>)[kind] =
		handler as unknown as Handler<GameEventKind>;
}

/** Queues an event, then synchronously runs its handler and any listeners. */
export function emitEvent<E extends Unsequenced<GameEvent>>(state: GameState, event: E): GameEvent {
	const ch = channel(state);
	const full = { ...event, seq: ch.nextSeq++ } as GameEvent;
	ch.queue.push(full);
	const handler = handlers[full.kind] as Handler<GameEventKind> | undefined;
	if (handler) handler(state, full);
	for (const listener of [...ch.listeners]) listener(state, full);
	return full;
}

/**
 * Calls `listener` for every event emitted on this state object until the returned function is
 * called. For tests and debugging; listeners must not mutate the game.
 */
export function subscribeEvents(state: GameState, listener: Listener): () => void {
	const ch = channel(state);
	ch.listeners.push(listener);
	return () => {
		const i = ch.listeners.indexOf(listener);
		if (i >= 0) ch.listeners.splice(i, 1);
	};
}

/** The events queued so far in the current action (read-only view). */
export function peekEvents(state: GameState): readonly GameEvent[] {
	return channels.get(state)?.queue ?? [];
}

/** Removes and returns every queued event. */
export function drainEvents(state: GameState): GameEvent[] {
	const ch = channels.get(state);
	if (!ch) return [];
	const out = ch.queue;
	ch.queue = [];
	return out;
}

/**
 * Brackets one game action. Nested calls (applyGameAction calls itself for mana abilities) only
 * drain at the outermost level.
 */
export function beginAction(state: GameState): void {
	channel(state).depth += 1;
}

export function endAction(state: GameState): void {
	const ch = channel(state);
	ch.depth = Math.max(0, ch.depth - 1);
	if (ch.depth === 0) ch.queue = [];
}
