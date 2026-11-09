/**
 * Phase 6a: layer evaluation caching (ENGINE_ARCHITECTURE_PLAN.md, Phase 6).
 *
 * The engine mutates `GameState` in place in hundreds of places, so there's no reliable version
 * counter yet. Instead every public layer query takes a *board snapshot* for its `GameState`:
 *
 * - The snapshot is stored in a `WeakMap` keyed by the state object (never inside `GameState`,
 *   which is serialised to D1 and sent to clients).
 * - On each query the snapshot is re-validated against an O(n) fingerprint of everything the
 *   board-level layer code reads: the players array, each player's object / `lost` / `playerId` /
 *   battlefield array identity and length, and for every battlefield object (phased out or not) the
 *   object itself, `instanceId`, `phasedOut`, `attachedToId`, `enteredTimestamp`, `card`,
 *   `copiableCard`, `isFaceDown` and `controllerId`. Any mismatch rebuilds the snapshot, which drops
 *   every memoised result hanging off it.
 * - Card objects (`ScryfallCard`) are treated as immutable: the engine replaces them wholesale
 *   (`perm.card = …`, `copiableCard = …`), which changes identity and is caught by the fingerprint.
 *
 * Per-target inputs that aren't in the fingerprint (counters, temporary P/T, switched P/T, granted
 * keywords, suspend haste, graveyards for CDAs) are never cached; they're evaluated on every call.
 *
 * Phase 6c: read-only code that asks many queries in a row runs inside `withStableLayerInputs`,
 * which validates once per scope instead of once per query (see "Stable-input scopes" below).
 *
 * Debug: set `MAGIC_LAYER_CACHE_CHECK=1` to recompute every query on a fresh snapshot and throw
 * on any difference (see `layerCacheCheckEnabled`). Inside scopes it also re-validates every
 * trusted hit.
 */
import type { CardInstance, GameState, PlayerGameState, ScryfallCard } from '../types.ts';

export interface BoardEntry {
	perm: CardInstance;
	/** The player whose battlefield holds the object. */
	playerId: string;
	/** That player's state object. */
	player: PlayerGameState;
	/** 1-based position among active (non-phased-out, non-lost-player) objects, in board order. */
	order: number;
	/** `enteredTimestamp ?? order` (CR 613.7). */
	timestamp: number;
	/** Copiable values (layer 1): `copiableCard ?? card`. */
	card: ScryfallCard;
}

export interface BoardSnapshot {
	/** Non-phased-out objects on non-lost players' battlefields, in board order. */
	active: BoardEntry[];
	/** `active`, stably sorted by timestamp. Read-only. */
	sorted: BoardEntry[];
	/** Active objects grouped by `attachedToId`, in board order. */
	attachedTo: Map<string, BoardEntry[]>;
	/** Every battlefield object of every player (including phased-out and lost players). */
	objects: Set<CardInstance>;
	/** Every battlefield `instanceId` of every player (including phased-out and lost players). */
	instanceIds: Set<string>;
	/** Free slots for results derived from this exact board (cleared when the board changes). */
	memo: Map<string, unknown>;
	/** Fingerprint the snapshot was built from. */
	fingerprint: unknown[];
}

const SNAPSHOTS = new WeakMap<GameState, BoardSnapshot>();

function pushFingerprint(state: GameState, fp: unknown[]): void {
	fp.push(state.players, state.players.length);
	for (const p of state.players) {
		fp.push(p, p.lost, p.playerId, p.battlefield, p.battlefield.length);
		for (const perm of p.battlefield) {
			fp.push(
				perm,
				perm.instanceId,
				perm.phasedOut,
				perm.attachedToId,
				perm.enteredTimestamp,
				perm.card,
				perm.copiableCard,
				perm.isFaceDown,
				perm.controllerId
			);
		}
	}
}

function fingerprintMatches(state: GameState, fp: unknown[]): boolean {
	let i = 0;
	if (fp[i++] !== state.players || fp[i++] !== state.players.length) return false;
	for (const p of state.players) {
		if (
			fp[i++] !== p ||
			fp[i++] !== p.lost ||
			fp[i++] !== p.playerId ||
			fp[i++] !== p.battlefield ||
			fp[i++] !== p.battlefield.length
		) {
			return false;
		}
		for (const perm of p.battlefield) {
			if (
				fp[i++] !== perm ||
				fp[i++] !== perm.instanceId ||
				fp[i++] !== perm.phasedOut ||
				fp[i++] !== perm.attachedToId ||
				fp[i++] !== perm.enteredTimestamp ||
				fp[i++] !== perm.card ||
				fp[i++] !== perm.copiableCard ||
				fp[i++] !== perm.isFaceDown ||
				fp[i++] !== perm.controllerId
			) {
				return false;
			}
		}
	}
	return i === fp.length;
}

/** Builds a snapshot from scratch, without consulting or updating the cache. */
export function buildBoardSnapshot(state: GameState): BoardSnapshot {
	const fingerprint: unknown[] = [];
	pushFingerprint(state, fingerprint);
	const active: BoardEntry[] = [];
	const attachedTo = new Map<string, BoardEntry[]>();
	const objects = new Set<CardInstance>();
	const instanceIds = new Set<string>();
	let order = 0;
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			objects.add(perm);
			instanceIds.add(perm.instanceId);
		}
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			order += 1;
			const entry: BoardEntry = {
				perm,
				playerId: p.playerId,
				player: p,
				order,
				timestamp: perm.enteredTimestamp ?? order,
				card: perm.copiableCard ?? perm.card
			};
			active.push(entry);
			if (perm.attachedToId) {
				const list = attachedTo.get(perm.attachedToId);
				if (list) list.push(entry);
				else attachedTo.set(perm.attachedToId, [entry]);
			}
		}
	}
	const sorted = [...active].sort((a, b) => a.timestamp - b.timestamp);
	return {
		active,
		sorted,
		attachedTo,
		objects,
		instanceIds,
		memo: new Map(),
		fingerprint
	};
}

let bypassCache = false;

// ---- Stable-input scopes (Phase 6c) ---------------------------------------------------------
//
// Validating the fingerprints is O(n) per query, and some read-only code asks O(n) queries in a
// row (state-based action scans, mana-ability enumeration), which is O(n²) per pass. Inside
// `withStableLayerInputs(state, fn)` the caller promises that `fn` doesn't change any layer input
// of `state` (any fingerprinted field) except where it calls `noteLayerInputsChanged(state)`
// right after. The first query in the scope validates as usual; later queries reuse that result
// without re-walking the board. Mutation funnels (`runtime/zones.ts`) also call
// `noteLayerInputsChanged`, so a scope stays correct if one is reached by accident.
//
// Under `MAGIC_LAYER_CACHE_CHECK`, every trusted hit re-runs the full validation and throws if the
// promise was broken (counted in `layerCacheCheckStats`), on top of the fresh-recompute checks.
//
// Scopes must be synchronous: the trust table is module-global and cleared when the outermost
// scope exits.

/** Per-state results validated inside the current scope. `layer` is owned by `layers.ts`. */
export interface ScopeTrust {
	snap?: BoardSnapshot;
	layer?: unknown;
}

let scopeDepth = 0;
/** States declared stable by an open scope, with their nesting depth. Only these are trusted. */
const DECLARED = new Map<GameState, number>();
const TRUST = new Map<GameState, ScopeTrust>();

/**
 * Runs `fn` with `state`'s layer inputs declared stable: repeated layer queries validate the
 * cache once instead of once per query. `fn` must be synchronous and must call
 * `noteLayerInputsChanged(state)` after any change to a layer input it makes.
 */
export function withStableLayerInputs<T>(state: GameState, fn: () => T): T {
	scopeDepth += 1;
	DECLARED.set(state, (DECLARED.get(state) ?? 0) + 1);
	try {
		return fn();
	} finally {
		scopeDepth -= 1;
		const depth = (DECLARED.get(state) ?? 1) - 1;
		if (depth > 0) {
			DECLARED.set(state, depth);
		} else {
			DECLARED.delete(state);
			TRUST.delete(state);
		}
		if (scopeDepth === 0) TRUST.clear();
	}
}

/**
 * Declares that a layer input of `state` may have changed: the next query revalidates. A no-op
 * outside `withStableLayerInputs`.
 */
export function noteLayerInputsChanged(state?: GameState): void {
	if (scopeDepth === 0) return;
	if (state) TRUST.delete(state);
	else TRUST.clear();
}

let changingDepth = 0;

/**
 * Runs a mutation funnel: trust is dropped before and after `fn`, and no query inside `fn` is
 * trusted (it may see a half-applied change). Without a `state`, trust for every state is dropped.
 * Costs nothing outside `withStableLayerInputs`.
 */
export function whileLayerInputsChange<T>(state: GameState | undefined, fn: () => T): T {
	if (scopeDepth === 0) return fn();
	noteLayerInputsChanged(state);
	changingDepth += 1;
	try {
		return fn();
	} finally {
		changingDepth -= 1;
		noteLayerInputsChanged(state);
	}
}

/** True while inside a `withStableLayerInputs` scope (tests). */
export function inStableLayerScope(): boolean {
	return scopeDepth > 0;
}

/**
 * The trust record for `state` in the current scope, or `null` when no open scope declared
 * `state` (other states, e.g. clones, are validated as usual) or while the cache is bypassed.
 * Callers store what they validated on it.
 */
export function scopeTrust(state: GameState): ScopeTrust | null {
	if (scopeDepth === 0 || changingDepth > 0 || bypassCache || !DECLARED.has(state)) return null;
	let t = TRUST.get(state);
	if (!t) {
		t = {};
		TRUST.set(state, t);
	}
	return t;
}

/**
 * Check mode: `stillValid` says whether a value trusted inside a scope would still pass full
 * validation. Throws (and counts a mismatch) when it wouldn't.
 */
export function verifyScopeTrust(label: string, stillValid: boolean): void {
	checkCount += 1;
	scopeCheckCount += 1;
	if (!stillValid) {
		mismatchCount += 1;
		console.error(`[layerCache] stable-scope violation in ${label}`);
		throw new Error(
			`Layer cache stable-scope violation in ${label}: a layer input changed inside ` +
				'withStableLayerInputs without noteLayerInputsChanged'
		);
	}
}

/**
 * Returns the board snapshot for `state`, reusing the cached one when the fingerprint still
 * matches. O(n) in the number of battlefield objects.
 */
export function getBoardSnapshot(state: GameState): BoardSnapshot {
	if (bypassCache) return buildBoardSnapshot(state);
	const trust = scopeTrust(state);
	if (trust?.snap) {
		if (layerCacheCheckEnabled()) {
			verifyScopeTrust('getBoardSnapshot', fingerprintMatches(state, trust.snap.fingerprint));
		}
		return trust.snap;
	}
	const prev = SNAPSHOTS.get(state);
	let snap: BoardSnapshot;
	if (prev && fingerprintMatches(state, prev.fingerprint)) {
		snap = prev;
	} else {
		snap = buildBoardSnapshot(state);
		SNAPSHOTS.set(state, snap);
	}
	if (trust) trust.snap = snap;
	return snap;
}

/** True when `snap` still matches `state`'s board (check-mode verification). */
export function boardSnapshotMatches(state: GameState, snap: BoardSnapshot): boolean {
	return fingerprintMatches(state, snap.fingerprint);
}

/** Runs `fn` with caching disabled: every snapshot is built fresh. Used by the cross-check. */
export function withoutLayerCache<T>(fn: () => T): T {
	const prev = bypassCache;
	bypassCache = true;
	try {
		return fn();
	} finally {
		bypassCache = prev;
	}
}

/** Drops the cached snapshot for `state` (tests). */
export function invalidateLayerCache(state: GameState): void {
	SNAPSHOTS.delete(state);
	TRUST.delete(state);
}

const CHECK_ENABLED = (() => {
	try {
		return (
			typeof process !== 'undefined' &&
			Boolean(process.env?.MAGIC_LAYER_CACHE_CHECK) &&
			process.env.MAGIC_LAYER_CACHE_CHECK !== '0'
		);
	} catch {
		return false;
	}
})();

let checkOverride: boolean | null = null;
let checkDepth = 0;

/** True when cached results should be cross-checked against a fresh computation. */
export function layerCacheCheckEnabled(): boolean {
	return checkDepth === 0 && !bypassCache && (checkOverride ?? CHECK_ENABLED);
}

/** Turns the cross-check on or off (tests); `null` restores the environment setting. */
export function setLayerCacheCheck(enabled: boolean | null): void {
	checkOverride = enabled;
}

let checkCount = 0;
let mismatchCount = 0;
let scopeCheckCount = 0;

/**
 * Number of cross-checks run and mismatches found so far in this process. `scopeChecks` is the
 * part of `checks` that re-validated a trusted hit inside `withStableLayerInputs`.
 */
export function layerCacheCheckStats(): { checks: number; mismatches: number; scopeChecks: number } {
	return { checks: checkCount, mismatches: mismatchCount, scopeChecks: scopeCheckCount };
}

// `MAGIC_LAYER_CACHE_CHECK=verbose` also prints the totals to stderr when the process exits.
try {
	if (
		CHECK_ENABLED &&
		process.env.MAGIC_LAYER_CACHE_CHECK === 'verbose' &&
		typeof process.on === 'function'
	) {
		process.on('exit', () => {
			process.stderr.write(
				`[layerCache] cross-checks: ${checkCount}, mismatches: ${mismatchCount}, ` +
					`scope checks: ${scopeCheckCount}\n`
			);
		});
	}
} catch {
	// Not in Node: nothing to report.
}

/**
 * An independent implementation of the three public layer queries (tests register the frozen
 * pre-cache copy from layerReference.test.ts) that the cross-check also compares against.
 */
export interface LayerReferenceImpl {
	inspectCardContinuousBreakdown(cardOrInst: CardInstance | ScryfallCard, state?: GameState): unknown;
	permanentHasLostAllAbilities(perm: CardInstance, state: GameState): unknown;
	evaluatePermanent(state: GameState, inst: CardInstance): unknown;
}

let reference: LayerReferenceImpl | null = null;

/** Registers (or with `null` clears) the reference implementation used by the cross-check. */
export function setLayerReference(impl: LayerReferenceImpl | null): void {
	reference = impl;
}

function compareLayerResult(label: string, what: string, cached: unknown, expected: unknown): void {
	const a = JSON.stringify(cached);
	const b = JSON.stringify(expected);
	if (a !== b) {
		mismatchCount += 1;
		// Logged as well as thrown, in case a caller swallows the error.
		console.error(`[layerCache] mismatch in ${label} (vs ${what})`);
		throw new Error(`Layer cache mismatch in ${label} (vs ${what}):\ncached:   ${a}\nexpected: ${b}`);
	}
}

/**
 * Cross-check helper: recomputes `fresh` with caching disabled (and, when a reference
 * implementation is registered, `viaReference`) and throws if a JSON form differs from `cached`'s.
 * Functions (e.g. `hasSubType`) are ignored by JSON.
 */
export function crossCheckLayerResult<T>(
	label: string,
	cached: T,
	fresh: () => T,
	viaReference?: (ref: LayerReferenceImpl) => unknown
): void {
	checkDepth += 1;
	let expected: T;
	let expectedRef: unknown;
	const ref = reference;
	try {
		expected = withoutLayerCache(fresh);
		if (ref && viaReference) expectedRef = viaReference(ref);
	} finally {
		checkDepth -= 1;
	}
	checkCount += 1;
	compareLayerResult(label, 'fresh snapshot', cached, expected);
	if (ref && viaReference) compareLayerResult(label, 'reference', cached, expectedRef);
}
