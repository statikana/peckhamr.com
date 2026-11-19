import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, mock } from 'node:test';

import {
	botDelayMs,
	capturePreActionSnapshot,
	runAutomatedPriorityAndBots,
	type BotPauseKind
} from '../ai.ts';
import { applyGameAction, createInitialGameState } from '../engine.ts';
import { PRECON_DECKS, type ArchidektPreconStore } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck
} from '../types.ts';
import { chooseBotAnswer } from './choices.ts';

const MAGIC_DIR = dirname(dirname(new URL(import.meta.url).pathname));

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

function withDeterminism<T>(seed: number, fn: () => T): T {
	let clock = 1_700_000_000_000 + seed * 1000;
	mock.method(Math, 'random', mulberry32(seed));
	mock.method(Date, 'now', () => (clock += 7));
	try {
		return fn();
	} finally {
		mock.restoreAll();
	}
}

function makeSeats(
	decks: MagicDeck[],
	humanSeatIndex: number | null = null
): LobbySeat[] {
	return decks.map((deck, idx) => {
		const isHuman = humanSeatIndex === idx;
		return {
			seatIndex: idx,
			userId: isHuman ? `u_human_${idx}` : null,
			username: isHuman ? `Tester ${idx}` : `Bot ${idx}`,
			avatarUrl: '',
			isBot: !isHuman,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: deck.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: deck.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 1_700_000_000_000
		};
	});
}

function assertCleanSerializedState(state: GameState): GameState {
	const json = JSON.stringify(state);
	const roundTripped = JSON.parse(json) as GameState;
	assert.equal(JSON.stringify(roundTripped), json);
	assert.deepEqual(JSON.parse(JSON.stringify(roundTripped)), roundTripped);

	const checkCardInstance = (inst: CardInstance, label: string) => {
		const rawCard = inst.card as unknown as Record<string, unknown>;
		const rawInst = inst as unknown as Record<string, unknown>;
		assert.equal('abilities' in rawCard, false, `${label}: leaked abilities IR on card`);
		assert.equal('faceDefinitions' in rawCard, false, `${label}: leaked faceDefinitions IR on card`);
		assert.equal('compiled' in rawInst, false, `${label}: leaked compiled IR on instance`);
	};

	for (const p of roundTripped.players) {
		assert.equal(Number.isFinite(p.life), true, `${p.playerId} life must be finite`);
		for (const zoneName of ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'] as const) {
			for (const inst of p[zoneName]) {
				checkCardInstance(inst, `${p.playerId}.${zoneName}.${inst.card.name}`);
			}
		}
	}
	for (const item of roundTripped.stack) {
		const rawCard = item.card as unknown as Record<string, unknown> | undefined;
		if (rawCard) {
			assert.equal('abilities' in rawCard, false, `stack.${item.title}: leaked abilities IR`);
		}
		assert.equal('compiled' in (item as unknown as Record<string, unknown>), false, `stack.${item.title}: leaked compiled IR`);
	}

	return roundTripped;
}

function drainPreGameBotPrompts(state: GameState): void {
	for (let guard = 0; guard < 24; guard++) {
		if (state.status !== 'mulligan' || state.pendingPrompts.length === 0) break;
		const pr = state.pendingPrompts[0]!;
		const pl = state.players.find((p) => p.playerId === pr.playerId);
		assert.ok(pl && pl.isBot, `Expected bot prompt during pre-game, got ${pr.playerId}`);
		const answer = chooseBotAnswer(state, pl, pr);
		const res = applyGameAction(state, pl.playerId, {
			type: 'choice',
			promptId: pr.id,
			answer
		});
		assert.equal(res.ok, true, `Pre-game bot choice failed: ${res.ok ? '' : res.error}`);
	}
}

function loadArchidektDecksFromStore(): {
	store: ArchidektPreconStore;
	archDecks: MagicDeck[];
} {
	const store = JSON.parse(
		readFileSync(join(MAGIC_DIR, 'precons.archidekt.json'), 'utf8')
	) as ArchidektPreconStore;
	const archIds = new Set(store.decks.map((d) => d.id));
	const archDecks = PRECON_DECKS.filter((d) => archIds.has(d.id));
	return { store, archDecks };
}

describe('Archidekt Commander multi-bot E2E smoke suite', () => {
	it('covers 100% of imported Archidekt decks across 10 deterministic 4-bot pods with JSON round-trips', () => {
		const { store, archDecks } = loadArchidektDecksFromStore();
		assert.ok(PRECON_DECKS.length >= 41, `Expected >= 41 PRECON_DECKS, got ${PRECON_DECKS.length}`);
		assert.equal(
			archDecks.length,
			store.decks.length,
			`Expected all ${store.decks.length} Archidekt decks in PRECON_DECKS`
		);
		assert.ok(archDecks.length >= 36, `Expected >= 36 Archidekt decks, got ${archDecks.length}`);

		const podCount = Math.max(10, Math.ceil(archDecks.length / 4));
		const coveredDeckIds = new Set<string>();

		for (let podIdx = 0; podIdx < podCount; podIdx++) {
			const podDecks: MagicDeck[] = [];
			for (let seat = 0; seat < 4; seat++) {
				const deck = archDecks[(podIdx * 4 + seat) % archDecks.length]!;
				podDecks.push(deck);
				coveredDeckIds.add(deck.id);
			}

			withDeterminism(1000 + podIdx * 37, () => {
				const seats = makeSeats(podDecks);
				const deckMap = new Map(seats.map((s, idx) => [s.seatIndex, podDecks[idx]!]));
				let state = createInitialGameState(`ARCH${podIdx}`, seats, deckMap, {
					...DEFAULT_LOBBY_RULES
				});

				drainPreGameBotPrompts(state);
				assert.equal(
					state.status,
					'active',
					`Pod ${podIdx} failed to reach active status (status=${state.status})`
				);

				for (let round = 0; round < 2 && state.status === 'active'; round++) {
					if (round >= 2) {
						throw new Error(`Pod ${podIdx} exceeded bounded round guard`);
					}
					runAutomatedPriorityAndBots(state, { maxSteps: 160 });
					state = assertCleanSerializedState(state);
				}

				// If a bot still holds a pending prompt after the step cap, verify applyGameAction resolves it cleanly
				if (state.status === 'active' && state.pendingPrompts.length > 0) {
					const pr = state.pendingPrompts[0]!;
					const pl = state.players.find((p) => p.playerId === pr.playerId);
					if (pl?.isBot) {
						const ans = chooseBotAnswer(state, pl, pr);
						const res = applyGameAction(state, pl.playerId, {
							type: 'choice',
							promptId: pr.id,
							answer: ans
						});
						assert.equal(res.ok, true, `Pod ${podIdx} trailing choice failed: ${res.ok ? '' : res.error}`);
						state = assertCleanSerializedState(state);
					}
				}

				assert.ok(
					state.status === 'active' || state.status === 'finished',
					`Pod ${podIdx} ended in unexpected status: ${state.status}`
				);
				assert.ok(
					state.turnNumber >= 2 || state.status === 'finished',
					`Pod ${podIdx} did not advance past turn 1 (turn=${state.turnNumber})`
				);
				assert.ok(
					state.log.length > 10,
					`Pod ${podIdx} expected > 10 log entries, got ${state.log.length}`
				);
				assert.ok(
					state.players.some((p) => p.battlefield.length > 0 || p.graveyard.length > 0),
					`Pod ${podIdx} showed no card plays onto battlefield or graveyard`
				);
			});
		}

		assert.equal(
			coveredDeckIds.size,
			archDecks.length,
			`Expected all ${archDecks.length} Archidekt decks covered, covered ${coveredDeckIds.size}`
		);
	});

	it('advances a 4-bot Archidekt pod cleanly under pace: true with mid-turn JSON round-trips', () => {
		const { archDecks } = loadArchidektDecksFromStore();
		const podDecks = archDecks.slice(0, 4);

		withDeterminism(4242, () => {
			const seats = makeSeats(podDecks);
			const deckMap = new Map(seats.map((s, idx) => [s.seatIndex, podDecks[idx]!]));
			let state = createInitialGameState('ARCHPACE', seats, deckMap, {
				...DEFAULT_LOBBY_RULES,
				botSpeed: 'normal'
			});

			drainPreGameBotPrompts(state);
			assert.equal(state.status, 'active');

			const pauseKinds: BotPauseKind[] = [];
			let reachedTurn2 = false;

			for (let guard = 0; guard < 60; guard++) {
				if (guard === 59) {
					throw new Error('Paced Archidekt pod exceeded 60-step guard without reaching Turn 2');
				}
				const preAction = capturePreActionSnapshot(state);
				const res = runAutomatedPriorityAndBots(state, {
					maxSteps: 160,
					pace: true,
					preAction
				});
				if (res.paused && res.pausedFor) {
					pauseKinds.push(res.pausedFor);
					const delay = botDelayMs('normal', res.pausedFor, 'ARCHPACE', state.log.length);
					assert.ok(delay >= 900, `Expected normal botDelayMs >= 900, got ${delay}`);
				}
				state = assertCleanSerializedState(state);
				if (state.turnNumber >= 2 && pauseKinds.includes('action') && pauseKinds.includes('turn_start')) {
					reachedTurn2 = true;
					break;
				}
				if (!res.paused || state.status !== 'active') {
					break;
				}
			}

			assert.equal(reachedTurn2, true, `Expected Turn 2 with turn_start & action pauses; got ${JSON.stringify(pauseKinds)}`);
			assert.ok(state.log.length > 10);
			assert.ok(state.players.some((p) => p.battlefield.length > 0));
		});
	});

	it('executes direct applyGameAction turns alongside 3 Archidekt bots cleanly', () => {
		const { archDecks } = loadArchidektDecksFromStore();
		const podDecks = archDecks.slice(4, 8);

		withDeterminism(7777, () => {
			const seats = makeSeats(podDecks, 0);
			const deckMap = new Map(seats.map((s, idx) => [s.seatIndex, podDecks[idx]!]));
			let state = createInitialGameState('ARCHACT', seats, deckMap, {
				...DEFAULT_LOBBY_RULES
			});

			const humanId = state.players[0]!.playerId;
			if (state.status === 'mulligan') {
				const keepRes = applyGameAction(state, humanId, { type: 'mulligan_keep' });
				assert.equal(keepRes.ok, true, `Human mulligan_keep failed: ${keepRes.ok ? '' : keepRes.error}`);
				drainPreGameBotPrompts(state);
			}
			assert.equal(state.status, 'active');

			for (let guard = 0; guard < 30 && (state.activePlayerIndex !== 0 || state.phase !== 'main1'); guard++) {
				if (state.priorityPlayerIndex === 0) {
					const passRes = applyGameAction(state, humanId, { type: 'pass_priority' });
					assert.equal(passRes.ok, true, `pass_priority failed: ${passRes.ok ? '' : passRes.error}`);
				} else {
					runAutomatedPriorityAndBots(state, { maxSteps: 160 });
				}
			}
			assert.equal(state.phase, 'main1');

			const endRes = applyGameAction(state, humanId, { type: 'end_turn' });
			assert.equal(endRes.ok, true, `end_turn failed: ${endRes.ok ? '' : endRes.error}`);
			for (let guard = 0; guard < 10 && state.pendingPrompts.length > 0; guard++) {
				const pr = state.pendingPrompts[0]!;
				const pl = state.players.find((p) => p.playerId === pr.playerId)!;
				const ans = chooseBotAnswer(state, pl, pr);
				const cRes = applyGameAction(state, pl.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: ans
				});
				assert.equal(cRes.ok, true, `choice failed: ${cRes.ok ? '' : cRes.error}`);
			}
			runAutomatedPriorityAndBots(state, { maxSteps: 160 });
			state = assertCleanSerializedState(state);

			assert.ok(state.turnNumber >= 2 || state.status === 'finished');
			assert.ok(state.log.length > 5);
		});
	});
});
