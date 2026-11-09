import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type ScryfallCard
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{W}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Legendary Creature — Human Soldier',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['W'],
		colorIdentity: overrides.colorIdentity ?? ['W'],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'rare',
		legalCommander: true,
		canBeCommander: true,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function makeTwoPlayerGame(p1Bot = false, p2Bot = false): GameState {
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: p1Bot,
			deckId: PRECON_DECKS[0].id,
			deckName: PRECON_DECKS[0].name,
			commanderNames: PRECON_DECKS[0].commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[0].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: p2Bot,
			deckId: PRECON_DECKS[1].id,
			deckName: PRECON_DECKS[1].name,
			commanderNames: PRECON_DECKS[1].commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[1].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const state = createInitialGameState(
		'TEST_F4',
		seats,
		new Map([
			[0, PRECON_DECKS[0]],
			[1, PRECON_DECKS[1]]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	if (!p1Bot) applyGameAction(state, 'p1', { type: 'mulligan_keep' });
	if (!p2Bot) applyGameAction(state, 'p2', { type: 'mulligan_keep' });
	return state;
}

function putLegend(state: GameState, playerIndex: number, card: ScryfallCard): CardInstance {
	const p = state.players[playerIndex];
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(card, p.playerId, 'battlefield', false, false, state.nextTimestamp);
	p.battlefield.push(inst);
	return inst;
}

describe('Step F4: Legend Rule prompt (CR 704.5j) and deterministic uid()', () => {
	it('prompts a human controller to choose which legendary permanent to keep (CR 704.5j)', () => {
		const state = makeTwoPlayerGame(false, false);
		const p1 = state.players[0];
		const legend = makeCard({ name: 'Thalia, Guardian of Thraben' });

		const first = putLegend(state, 0, legend);
		first.counters['+1/+1'] = 2;
		const second = putLegend(state, 0, legend);

		checkStateBasedActions(state);

		// Neither copy is moved to the graveyard before the human chooses
		assert.equal(p1.battlefield.length, 2);
		const prompt = state.pendingPrompts.find(
			(pr) => pr.playerId === 'p1' && (pr.purpose ?? pr.kind) === 'legend_rule'
		);
		assert.ok(prompt, 'Expected a legend_rule prompt for the human player');
		assert.equal(prompt.choice?.kind, 'chooseObjects');
		assert.deepEqual(prompt.choice?.candidates, [first.instanceId, second.instanceId]);

		// Re-running SBAs while the prompt is pending does not enqueue a duplicate prompt
		checkStateBasedActions(state);
		assert.equal(
			state.pendingPrompts.filter((pr) => (pr.purpose ?? pr.kind) === 'legend_rule').length,
			1
		);

		// Human chooses to keep the first (older, buffed) copy; the second copy goes to the graveyard
		const res = applyGameAction(state, 'p1', {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseObjects', objectIds: [first.instanceId] }
		});
		assert.equal(res.ok, true);
		assert.deepEqual(
			p1.battlefield.map((c) => c.instanceId),
			[first.instanceId]
		);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === second.instanceId),
			true
		);
	});

	it('lets a bot keep the best copy automatically without prompting (CR 704.5j)', () => {
		const state = makeTwoPlayerGame(true, true);
		const bot = state.players[0];
		const legend = makeCard({ name: 'Thalia, Guardian of Thraben' });

		const buffedOriginal = putLegend(state, 0, legend);
		buffedOriginal.counters['+1/+1'] = 3;
		const plainNewer = putLegend(state, 0, legend);

		checkStateBasedActions(state);

		assert.equal(state.pendingPrompts.length, 0, 'Bot should not receive a pending prompt');
		assert.deepEqual(
			bot.battlefield.map((c) => c.instanceId),
			[buffedOriginal.instanceId],
			'Bot should keep the stronger copy with +1/+1 counters over the plain newer copy'
		);
		assert.equal(
			bot.graveyard.some((c) => c.instanceId === plainNewer.instanceId),
			true
		);
	});

	it('generates deterministic per-state uids without calling Math.random or Date.now after seed initialization', () => {
		let randomCalls = 0;
		mock.method(Math, 'random', () => {
			randomCalls += 1;
			return 0.25;
		});
		try {
			const g1 = makeTwoPlayerGame(false, false);
			const callsAfterG1 = randomCalls;
			// Only freshRngSeed() in createInitialGameState should have called Math.random once
			assert.equal(callsAfterG1, 1, 'createInitialGameState should only call Math.random once for freshRngSeed()');

			const g2 = makeTwoPlayerGame(false, false);
			assert.equal(randomCalls, 2);

			assert.equal(g1.gameId, g2.gameId);
			assert.deepEqual(
				g1.players[0].hand.map((c) => c.instanceId),
				g2.players[0].hand.map((c) => c.instanceId)
			);
			assert.deepEqual(
				g1.players[0].command.map((c) => c.instanceId),
				g2.players[0].command.map((c) => c.instanceId)
			);
		} finally {
			mock.restoreAll();
		}
	});
});
