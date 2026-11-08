import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { createInitialGameState } from '../engine.ts';
import { runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS } from '../precons.ts';
import { DEFAULT_LOBBY_RULES, type GameState, type LobbySeat } from '../types.ts';

/**
 * Golden bot games (Phase 2 safety net).
 *
 * Plays seeded all-bot games with a deterministic clock and RNG and compares a projection of the
 * resulting state (every zone in order, per-object bookkeeping, and the game log) with
 * __snapshots__/golden.json. Its job is to catch *unintended* behaviour changes during refactors.
 * After an intended engine change, regenerate with:
 *   UPDATE_GOLDEN_SNAPSHOTS=1 node --test src/lib/magic/runtime/golden.test.ts
 * and review the diff.
 *
 * This file must run in its own process (node --test does that per file) because the engine has a
 * module-level instance counter.
 */

const DIR = dirname(new URL(import.meta.url).pathname);
const SNAPSHOT_PATH = join(DIR, '__snapshots__', 'golden.json');
const UPDATE = process.env.UPDATE_GOLDEN_SNAPSHOTS === '1';

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function botSeats(count: number): LobbySeat[] {
	return Array.from({ length: count }, (_, i) => ({
		seatIndex: i,
		userId: null,
		username: `Bot ${i}`,
		avatarUrl: '',
		isBot: true,
		deckId: PRECON_DECKS[i % PRECON_DECKS.length].id,
		deckName: PRECON_DECKS[i % PRECON_DECKS.length].name,
		commanderNames: PRECON_DECKS[i % PRECON_DECKS.length].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: PRECON_DECKS[i % PRECON_DECKS.length].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
}

function project(state: GameState): unknown {
	return {
		status: state.status,
		winner: state.winnerPlayerId,
		turn: state.turnNumber,
		phase: state.phase,
		nextTimestamp: state.nextTimestamp,
		stack: state.stack.map((s) => [s.title, s.sourceInstanceId, s.sourceObjectVersion ?? null]),
		players: state.players.map((p) => ({
			id: p.playerId,
			life: p.life,
			poison: p.poison,
			lost: p.lost,
			zones: Object.fromEntries(
				(['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'] as const).map((z) => [
					z,
					p[z].map((c) => [
						c.instanceId,
						c.card.name,
						c.zone,
						c.ownerId,
						c.controllerId,
						c.objectVersion ?? null,
						c.enteredTimestamp ?? null,
						c.tapped,
						c.summoningSick,
						c.damageMarked,
						Object.entries(c.counters)
							.filter(([, n]) => n)
							.map(([k, n]) => `${k}:${n}`)
							.join(','),
						c.attachedToId,
						c.grantedKeywords.join(','),
						c.commanderCastCount,
						Boolean(c.isSuspended)
					])
				])
			)
		})),
		log: state.log.map((l) => `${l.turn}/${l.phase}/${l.kind}: ${l.text}`)
	};
}

function playGame(seed: number, seats: number, rounds: number): unknown {
	const rand = mulberry32(seed);
	let clock = 1_700_000_000_000;
	mock.method(Math, 'random', rand);
	mock.method(Date, 'now', () => (clock += 7));
	try {
		const decks = new Map(
			botSeats(seats).map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]])
		);
		const state = createInitialGameState('GOLDEN', botSeats(seats), decks, {
			...DEFAULT_LOBBY_RULES
		});
		const snapshots: unknown[] = [];
		let last: unknown = null;
		for (let r = 0; r < rounds && state.status === 'active'; r++) {
			runAutomatedPriorityAndBots(state);
			last = project(state);
			// Intermediate states are pinned by digest to keep the snapshot file small; the final
			// state is stored in full so a mismatch shows a readable diff.
			snapshots.push(createHash('sha256').update(JSON.stringify(last)).digest('hex'));
		}
		return { digests: snapshots, final: last };
	} finally {
		mock.restoreAll();
	}
}

const GAMES: Array<{ name: string; seed: number; seats: number; rounds: number }> = [
	{ name: '2 bots, seed 1', seed: 1, seats: 2, rounds: 4 },
	{ name: '2 bots, seed 99', seed: 99, seats: 2, rounds: 4 },
	{ name: '3 bots, seed 7', seed: 7, seats: 3, rounds: 3 },
	{ name: '4 bots, seed 42', seed: 42, seats: 4, rounds: 3 }
];

describe('Golden bot games (behaviour pin for refactors)', () => {
	const results = Object.fromEntries(GAMES.map((g) => [g.name, playGame(g.seed, g.seats, g.rounds)]));
	if (UPDATE || !existsSync(SNAPSHOT_PATH)) {
		mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
		writeFileSync(SNAPSHOT_PATH, JSON.stringify(results, null, '\t') + '\n');
	}
	const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, unknown>;
	for (const g of GAMES) {
		it(`${g.name} matches the golden snapshot`, () => {
			assert.deepEqual(JSON.parse(JSON.stringify(results[g.name])), expected[g.name]);
		});
	}
});
