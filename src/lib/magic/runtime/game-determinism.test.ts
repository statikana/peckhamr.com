import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createCardInstance, createInitialGameState } from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { DEFAULT_LOBBY_RULES, type GameState, type LobbySeat } from '../types.ts';

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

function newSeededGame(seed: number): GameState {
	mock.method(Math, 'random', () => seed);
	mock.method(Date, 'now', () => 1_700_000_000_000);
	try {
		const decks = new Map(
			botSeats(2).map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]])
		);
		return createInitialGameState('DETERMINISM', botSeats(2), decks, { ...DEFAULT_LOBBY_RULES });
	} finally {
		mock.restoreAll();
	}
}

function startingCards(state: GameState): Array<[string, string, number | undefined]> {
	return state.players.flatMap((p) =>
		(['library', 'hand', 'command'] as const).flatMap((z) =>
			p[z].map((c): [string, string, number | undefined] => [c.instanceId, z, c.enteredTimestamp])
		)
	);
}

describe('New games do not depend on earlier work in the same process', () => {
	it('two games with the same seed get identical starting cards, IDs and timestamps even after other instances were created in between', () => {
		const first = newSeededGame(0.25);
		// Anything else the process creates between games (other games, tests, tokens) must not leak in.
		for (let i = 0; i < 5; i++) {
			createCardInstance(first.players[0].library[0].card, 'someone', 'battlefield');
		}
		const second = newSeededGame(0.25);
		assert.deepEqual(startingCards(second), startingCards(first));
	});
});
