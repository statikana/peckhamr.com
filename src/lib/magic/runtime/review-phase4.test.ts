import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedPriorityAndBots } from '../ai.ts';
import * as engine from '../engine.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	MAX_TRIGGERS_PER_TURN
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function creature(name: string, oracleText: string, power = '2', toughness = '2', subtype = 'Human'): ScryfallCard {
	return card({ name, manaCost: '{2}', cmc: 2, typeLine: `Creature — ${subtype}`, oracleText, power, toughness });
}

function seat(i: number, id: string, username: string, isBot: boolean): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: id,
		username,
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

function game(players = 2, bots: boolean[] = []): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i], Boolean(bots[i])));
	const state = createInitialGameState(
		'LOBBY_PH4',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const s of seats) {
		const pl = state.players.find((x) => x.playerId === s.userId)!;
		const wasBot = pl.isBot;
		pl.isBot = false;
		if (state.status === 'mulligan') assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
		pl.isBot = wasBot;
	}
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	return { state, p: state.players };
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function settle(state: GameState, max = 600): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0 && state.status === 'active'; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function tokens(pl: PlayerGameState, name: string): number {
	return pl.battlefield.filter((c) => c.isToken && c.card.name.includes(name)).length;
}

describe('Phase 4 — Trigger Cap Redesign & Loop Detection (#10)', () => {
	it('1. legitimate big turn (> 200 simultaneous triggers): 250 tokens dying to a board wipe all trigger and resolve without dropping any', () => {
		const { state, p } = game(2, [true, true]);
		assert.equal(MAX_TRIGGERS_PER_TURN, 2000, 'MAX_TRIGGERS_PER_TURN is raised to 2000');
		put(
			state,
			p[0],
			creature('Mourning Witness', 'Whenever another creature dies, you gain 1 life.', '1', '1', 'Cleric'),
			'battlefield'
		);
		for (let i = 0; i < 250; i++) {
			createTokenOnBoard(state, p[0], {
				name: 'Soldier',
				power: 1,
				toughness: 1,
				colors: ['W'],
				typeLine: 'Token Creature — Soldier',
				keywords: []
			});
		}
		const lifeBefore = p[0].life;
		const wipe = put(state, p[0], card({ name: 'MassSweep', typeLine: 'Sorcery', oracleText: 'Destroy all creatures.' }), 'hand');
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: wipe.instanceId, targets: [] }).ok, true);
		settle(state, 600);
		assert.equal(state.status, 'active', 'game remains active after a simultaneous batch of 250 death triggers');
		assert.equal(state.stack.length, 0, 'all 250 death triggers resolved');
		assert.equal(p[0].life, lifeBefore + 250, 'all 250 death triggers gained 1 life each (none dropped at 200)');
	});

	it('2. mandatory loop in a bots-only game (CR 104.4b): detects loop at LOOP_TRIGGER_THRESHOLD (30), logs CR 104.4b, and ends in a draw', () => {
		const threshold = (engine as Record<string, unknown>).LOOP_TRIGGER_THRESHOLD as number;
		assert.equal(threshold, 30, 'LOOP_TRIGGER_THRESHOLD is exported as 30');
		const { state, p } = game(2, [true, true]);
		put(
			state,
			p[0],
			creature('Endless Sporewright', 'Whenever another creature you control enters, create a 1/1 green Saproling creature token.', '1', '1', 'Fungus'),
			'battlefield'
		);
		createTokenOnBoard(state, p[0], {
			name: 'Saproling',
			power: 1,
			toughness: 1,
			colors: ['G'],
			typeLine: 'Token Creature — Saproling',
			keywords: []
		});
		for (let i = 0; i < 40 && state.status === 'active'; i++) {
			runAutomatedPriorityAndBots(state, { maxSteps: 50 });
		}
		assert.equal(state.status, 'finished', 'mandatory loop in a bots-only game ends the game');
		assert.equal(state.winnerPlayerId, null, 'mandatory loop ends the game in a draw (winnerPlayerId === null)');
		assert.ok(
			state.log.some((l) => l.kind === 'rule' && /104\.4b/.test(l.text)),
			'logs a rule message citing CR 104.4b'
		);
		const saprolings = tokens(p[0], 'Saproling');
		assert.equal(saprolings, threshold + 1, `created 1 initial + ${threshold} loop Saprolings before detecting the loop`);
	});

	it('3. mandatory loop with a human player: prompts at 30 cycles to draw (CR 104.4b) or run 30 more triggers', () => {
		const threshold = ((engine as Record<string, unknown>).LOOP_TRIGGER_THRESHOLD as number) ?? 30;
		const { state, p } = game(2, [false, true]);
		put(
			state,
			p[0],
			creature('Endless Sporewright', 'Whenever another creature you control enters, create a 1/1 green Saproling creature token.', '1', '1', 'Fungus'),
			'battlefield'
		);
		createTokenOnBoard(state, p[0], {
			name: 'Saproling',
			power: 1,
			toughness: 1,
			colors: ['G'],
			typeLine: 'Token Creature — Saproling',
			keywords: []
		});
		settle(state, 200);
		assert.equal(state.status, 'active');
		const firstPrompt = state.pendingPrompts[0];
		assert.ok(firstPrompt, 'human player is prompted when mandatory loop is detected');
		assert.equal(firstPrompt.kind, 'chooseMode');
		assert.equal(tokens(p[0], 'Saproling'), threshold + 1, `stopped after ${threshold} loop resolutions`);

		// Choose "Let it run 30 more triggers" (mode index 1)
		const resMore = applyGameAction(state, firstPrompt.playerId, {
			type: 'choice',
			promptId: firstPrompt.id,
			answer: { kind: 'chooseMode', indices: [1] }
		});
		assert.equal(resMore.ok, true, resMore.error ?? '');
		settle(state, 200);
		assert.equal(state.status, 'active');
		const secondPrompt = state.pendingPrompts[0];
		assert.ok(secondPrompt, 'human player is prompted again after 30 more triggers');
		assert.equal(secondPrompt.kind, 'chooseMode');
		assert.equal(tokens(p[0], 'Saproling'), threshold * 2 + 1, `ran ${threshold} additional cycles`);

		// Choose "End the game in a draw (CR 104.4b)" (mode index 0)
		const resDraw = applyGameAction(state, secondPrompt.playerId, {
			type: 'choice',
			promptId: secondPrompt.id,
			answer: { kind: 'chooseMode', indices: [0] }
		});
		assert.equal(resDraw.ok, true, resDraw.error ?? '');
		assert.equal(state.status, 'finished', 'choosing draw finishes the game');
		assert.equal(state.winnerPlayerId, null, 'winnerPlayerId is null for a draw');
	});

	it('4. optional ("you may") loop (CR 731.2b): bot declines the optional trigger at LOOP_TRIGGER_THRESHOLD (30), breaking the loop cleanly', () => {
		const threshold = ((engine as Record<string, unknown>).LOOP_TRIGGER_THRESHOLD as number) ?? 30;
		const { state, p } = game(2, [true, true]);
		p[0].hand = [];
		p[0].command = [];
		p[1].hand = [];
		p[1].command = [];
		put(
			state,
			p[0],
			creature(
				'Optional Sporewright',
				'Whenever another creature you control enters, you may create a 1/1 green Saproling creature token.',
				'1',
				'1',
				'Fungus'
			),
			'battlefield'
		);
		createTokenOnBoard(state, p[0], {
			name: 'Saproling',
			power: 1,
			toughness: 1,
			colors: ['G'],
			typeLine: 'Token Creature — Saproling',
			keywords: []
		});
		for (let i = 0; i < 40 && state.stack.length > 0 && state.status === 'active'; i++) {
			runAutomatedPriorityAndBots(state, { maxSteps: 50 });
		}
		assert.equal(state.status, 'active', 'game remains active after breaking an optional loop');
		assert.equal(state.stack.length, 0, 'stack empties cleanly after declining optional trigger');
		assert.equal(tokens(p[0], 'Saproling'), threshold + 1, `bot accepted ${threshold} times and declined on cycle ${threshold + 1}`);
		assert.ok(
			state.log.some((l) => l.kind === 'rule' && /731\.2b/.test(l.text)),
			'logs a rule message citing CR 731.2b'
		);
	});

	it('5. hard backstop (MAX_TRIGGERS_PER_TURN = 2000): logs loudly and pauses with a guided_resolution prompt instead of silently dropping', () => {
		const { state, p } = game(2, [false, true]);
		put(
			state,
			p[0],
			creature('Mourning Witness', 'Whenever another creature dies, you gain 1 life.', '1', '1', 'Cleric'),
			'battlefield'
		);
		// Pre-seed triggersPlacedThisTurn right below the 2000 hard backstop
		state.triggersPlacedThisTurn = {
			turn: state.turnSerial ?? state.turnNumber,
			count: 1999
		};
		createTokenOnBoard(state, p[0], {
			name: 'Soldier',
			power: 1,
			toughness: 1,
			colors: ['W'],
			typeLine: 'Token Creature — Soldier',
			keywords: []
		});
		createTokenOnBoard(state, p[0], {
			name: 'Soldier',
			power: 1,
			toughness: 1,
			colors: ['W'],
			typeLine: 'Token Creature — Soldier',
			keywords: []
		});
		const wipe = put(state, p[0], card({ name: 'MassSweep', typeLine: 'Sorcery', oracleText: 'Destroy all creatures.' }), 'hand');
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: wipe.instanceId, targets: [] }).ok, true);
		settle(state, 10);
		assert.ok(
			state.log.some((l) => l.kind === 'rule' && /runaway trigger loop safety cap/.test(l.text)),
			'logs loudly when the hard trigger backstop is reached'
		);
		const guided = state.pendingPrompts.find((pr) => pr.purpose === 'guided_resolution');
		assert.ok(guided, 'pauses the game for manual resolution (guided_resolution prompt) when the backstop is reached');
	});
});
