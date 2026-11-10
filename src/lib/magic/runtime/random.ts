/**
 * Seeded randomness (ENGINE_INVARIANTS.md 7.2).
 *
 * Every random game decision (shuffles, "at random" choices) draws from `nextRandom(state)`, a
 * mulberry32 generator whose whole state is `GameState.rngState`, a plain number saved with the game.
 * `Math.random` is used only once per game, to pick the seed (`createInitialGameState`), and for
 * games saved before the seed existed, the first time they need a random number.
 */

/** Anything that carries the generator state (a GameState, or a seed holder before one exists). */
export interface RngHolder {
	rngState?: number;
}

export interface UidHolder {
	nextUid?: number;
	idSalt?: number;
	rngState?: number;
}

let fallbackUidCounter = 0;

export function uid(prefix: string, state?: UidHolder): string {
	if (state) {
		if (state.idSalt === undefined) {
			state.idSalt = deriveIdSalt(state.rngState ?? 0);
		}
		state.nextUid = (state.nextUid ?? 0) + 1;
		return `${prefix}_${hash32(state.idSalt, state.nextUid).toString(36)}`;
	}
	fallbackUidCounter += 1;
	return `${prefix}_ext_${fallbackUidCounter}`;
}

/** A fresh 32-bit seed. The only place the engine calls Math.random for game randomness. */
export function freshRngSeed(): number {
	return Math.floor(Math.random() * 0x100000000) | 0;
}

/** Derives a deterministic 32-bit salt for opaque instance IDs from the initial RNG seed without advancing `rngState`. */
export function deriveIdSalt(seed: number): number {
	let h = (seed ^ 0x6d2b79f5) | 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return (h ^ (h >>> 16)) | 0;
}

/** Deterministic 32-bit bijective hash mixing `(idSalt, counter)` into an unsigned 32-bit integer. */
export function hash32(salt: number, counter: number): number {
	let h = (counter + Math.imul(salt | 1, 0x9e3779b9)) | 0;
	h ^= salt;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic PRNG (mulberry32) advancing `holder.rngState` in place; a number in [0, 1). */
export function nextRandom(holder: RngHolder): number {
	if (holder.rngState === undefined) holder.rngState = freshRngSeed();
	let t = (holder.rngState = (holder.rngState + 0x6d2b79f5) | 0);
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Fisher–Yates shuffle of a copy of `items`, driven by the seeded generator. */
export function shuffleWith<T>(holder: RngHolder, items: T[]): T[] {
	const arr = [...items];
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom(holder) * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}
