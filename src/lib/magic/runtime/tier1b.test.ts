import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameAction,
	createInitialGameState,
	enterEndStep
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type GameState,
	type LobbySeat,
	type ManaPool,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function createEmptyManaPool(): ManaPool {
	return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

function makeSeat(index: number, isBot = false): LobbySeat {
	const deck = PRECON_DECKS[index % PRECON_DECKS.length];
	return {
		seatIndex: index,
		userId: `p${index + 1}`,
		username: `Player ${index + 1}`,
		avatarUrl: '',
		isBot,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: deck.colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	};
}

function makeGame(playerCount = 2): {
	state: GameState;
	players: PlayerGameState[];
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats = Array.from({ length: playerCount }, (_, i) => makeSeat(i, false));
	const state = createInitialGameState(
		'TIER1B_TEST',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.battlefield = [];
		p.hand = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = createEmptyManaPool();
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return {
		state,
		players: state.players,
		p1: state.players[0],
		p2: state.players[1]
	};
}

let synthCounter = 0;
export function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	synthCounter += 1;
	return {
		id: overrides.id ?? `synth_t1b_${synthCounter}`,
		oracleId: overrides.oracleId ?? `ora_t1b_${synthCounter}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		loyalty: overrides.loyalty ?? undefined,
		imageUrl: '',
		artCropUrl: '',
		setName: 'Test',
		setCode: 'TST',
		rarity: 'common'
	};
}

function finishCurrentTurn(state: GameState): void {
	const active = state.players[state.activePlayerIndex];
	active.hand = [];
	enterEndStep(state, active);
	const aliveCount = state.players.filter((p) => !p.lost).length;
	for (let i = 0; i < aliveCount; i++) {
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		assert.equal(applyGameAction(state, priorityPlayer.playerId, { type: 'pass_priority' }).ok, true);
	}
}

describe('Tier 1b CR fixes', () => {
	describe('Item 4: Extra-turn order resumes normal turn order (CR 500.7)', () => {
		it('resumes normal turn order with the next player after an out-of-order extra turn', () => {
			const { state, players } = makeGame(4);
			const [, p2, p3, p4] = players;

			assert.equal(state.activePlayerIndex, 0, 'Starts on Player 1 normal turn');

			// Player 3 (seat 2) is granted an extra turn after Player 1's turn
			state.extraTurnQueue = [p3.playerId];

			// End Player 1's turn -> Player 3 takes their extra turn
			finishCurrentTurn(state);
			assert.equal(state.activePlayerIndex, 2, 'Player 3 takes the extra turn');

			// During Player 3's extra turn, Player 4 (seat 3) also gets an extra turn
			state.extraTurnQueue.push(p4.playerId);

			// End Player 3's extra turn -> Player 4 takes their extra turn
			finishCurrentTurn(state);
			assert.equal(state.activePlayerIndex, 3, 'Player 4 takes the chained extra turn');

			// End Player 4's extra turn -> Normal turn order must resume at Player 2 (seat 1), not wrap to Player 1!
			finishCurrentTurn(state);
			assert.equal(
				state.activePlayerIndex,
				1,
				'Normal turn order resumes with Player 2 after extra turns finish'
			);
			assert.equal(p2.playerId, state.players[state.activePlayerIndex].playerId);
		});
	});
});
