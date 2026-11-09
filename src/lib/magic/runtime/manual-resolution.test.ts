import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedPriorityAndBots } from '../ai.ts';
import { applyGameAction, checkStateBasedActions, createCardInstance, createInitialGameState } from '../engine.ts';
import { cardSupportReport, unsupportedKindLabel } from '../compiler/support.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PendingPrompt,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

/**
 * Step E2 (ENGINE_ARCHITECTURE_PLAN.md section 2.7): defined behaviour for abilities the engine
 * doesn't automate. A human resolves an unsupported spell or ability through the guided_resolution
 * prompt; a bot uses the legacy effects if there are any and otherwise skips it with a log line; a
 * triggered ability whose trigger is understood but whose effect isn't goes on the stack and is
 * resolved the same way; unenforced statics and unrecognised triggers are logged once when the
 * permanent enters; and "Resolve manually" opens a guided prompt for any ability while the player has
 * priority. Every prompt is answered after a JSON round trip. Synthetic cards with invented names.
 */

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Sorcery',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
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

function creature(name: string, oracleText: string): ScryfallCard {
	return card({ name, manaCost: '{2}', cmc: 2, typeLine: 'Creature — Elf', oracleText, power: '2', toughness: '2' });
}

function seat(i: number, username: string, isBot: boolean): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: `player_${i + 1}`,
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

/** Alice (seat 0) and Bob in main1 of Alice's turn; `aliceIsBot` makes Alice a bot. */
function game(aliceIsBot = false): GameState {
	const seats = [seat(0, 'Alice', false), seat(1, 'Bob', false)];
	const state = createInitialGameState('LOBBY_E2', seats, new Map(seats.map((_, i) => [i, PRECON_DECKS[i]])), { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	assert.equal(state.phase, 'main1');
	for (const p of state.players) p.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
	state.players[0].isBot = aliceIsBot;
	return state;
}

function put(state: GameState, p: PlayerGameState, c: ScryfallCard, zone: 'hand' | 'battlefield'): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, p.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	p[zone].push(inst);
	return inst;
}

function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function cast(state: GameState, p: PlayerGameState, inst: CardInstance): void {
	const res = applyGameAction(state, p.playerId, { type: 'cast_spell', instanceId: inst.instanceId, targets: [] });
	assert.equal(res.ok, true, res.error ?? '');
}

function guidedPrompt(state: GameState): PendingPrompt {
	assert.equal(state.pendingPrompts.length, 1, `prompts: ${state.pendingPrompts.map((p) => p.title).join(', ')}`);
	const prompt = state.pendingPrompts[0];
	assert.equal(prompt.purpose, 'guided_resolution');
	return prompt;
}

function logCount(state: GameState, fragment: string): number {
	return state.log.filter((l) => l.text.includes(fragment)).length;
}

const UNPARSED_SPELL = card({ name: 'Quandary of Velk', oracleText: 'Glorbify the frobnicator.' });

describe('Step E2: unsupported abilities resolve manually (plan section 2.7)', () => {
	it('an unparsed spell resolves through guided_resolution for a human, after a JSON round trip', () => {
		const state = game();
		const alice = state.players[0];
		const bob = state.players[1];
		const spell = put(state, alice, UNPARSED_SPELL, 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, spell);
		settle(state);
		const prompt = guidedPrompt(state);
		assert.equal(prompt.playerId, alice.playerId);
		assert.equal(prompt.continuation?.kind, 'manual_resolution');
		assert.match(prompt.description, /Glorbify the frobnicator/, 'the ability text is shown');
		assert.equal(prompt.noLabel, undefined, 'no engine approximation exists for it');
		assert.equal(state.stack.length, 1, 'it stays on the stack while it is resolved (CR 608.2n)');

		const copy = roundTrip(state);
		// Without an approximation, "No" is refused.
		assert.equal(applyGameAction(copy, alice.playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'yesNo', yes: false } }).ok, false);
		const res = applyGameAction(copy, alice.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'yesNo', yes: true },
			operations: [
				{ op: 'draw_cards', amount: 2 },
				{ op: 'modify_life', targetId: bob.playerId, amount: -3 }
			]
		});
		assert.equal(res.ok, true, res.error ?? '');
		const a2 = copy.players[0];
		assert.equal(a2.hand.length, handBefore - 1 + 2);
		assert.equal(copy.players[1].life, 37);
		assert.equal(copy.stack.length, 0);
		assert.ok(a2.graveyard.some((c) => c.instanceId === spell.instanceId), 'it finished resolving');
		assert.equal(logCount(copy, 'resolved Quandary of Velk manually'), 1);
	});

	it('guided operations are validated on the server', () => {
		const state = game();
		const alice = state.players[0];
		cast(state, alice, put(state, alice, UNPARSED_SPELL, 'hand'));
		settle(state);
		const prompt = guidedPrompt(state);
		for (const op of [
			{ op: 'modify_life' as const, targetId: 'nobody', amount: 2 },
			{ op: 'draw_cards' as const, amount: 1000 },
			{ op: 'move_zone' as const, targetId: 'missing', destinationZone: 'hand' as const },
			{ op: 'move_zone' as const, targetId: state.players[1].library[0].instanceId, destinationZone: 'hand' as const },
			{ op: 'move_zone' as const, targetId: state.players[1].hand[0].instanceId, destinationZone: 'graveyard' as const }
		]) {
			const res = applyGameAction(state, alice.playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'yesNo', yes: true }, operations: [op] });
			assert.equal(res.ok, false, JSON.stringify(op));
		}
		assert.equal(state.pendingPrompts.length, 1);
	});

	it('a human may take the legacy approximation while it exists', () => {
		const state = game();
		const alice = state.players[0];
		const spell = put(state, alice, card({ name: 'Velkish Insight', oracleText: 'Draw a card. Glorbify the frobnicator.' }), 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, spell);
		settle(state);
		const prompt = guidedPrompt(state);
		assert.ok(prompt.noLabel, 'the approximation is offered');
		const copy = roundTrip(state);
		assert.equal(applyGameAction(copy, alice.playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'yesNo', yes: false } }).ok, true);
		assert.equal(copy.players[0].hand.length, handBefore, 'the legacy draw ran');
		assert.equal(copy.stack.length, 0);
	});

	it('a bot skips an unsupported spell with no legacy effects, with a log line', () => {
		const state = game(true);
		const alice = state.players[0];
		const spell = put(state, alice, UNPARSED_SPELL, 'hand');
		cast(state, alice, spell);
		settle(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 0);
		assert.equal(logCount(state, 'Alice (bot) skipped unsupported ability Quandary of Velk'), 1);
		assert.ok(alice.graveyard.some((c) => c.instanceId === spell.instanceId));
	});

	it('a bot falls back to the legacy effects when they exist', () => {
		const state = game(true);
		const alice = state.players[0];
		const spell = put(state, alice, card({ name: 'Velkish Insight', oracleText: 'Draw a card. Glorbify the frobnicator.' }), 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, spell);
		settle(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(alice.hand.length, handBefore, 'cast one, drew one (legacy)');
		assert.equal(logCount(state, 'skipped unsupported ability'), 0);
	});

	it('a trigger with a parsed head and an unparsed effect goes on the stack and resolves manually', () => {
		const state = game();
		const alice = state.players[0];
		const hob = put(state, alice, creature('Hobwick Tinkerer', 'When ~ enters, glorbify the frobnicator.'), 'hand');
		cast(state, alice, hob);
		settle(state);
		assert.equal(logCount(state, "Hobwick Tinkerer's"), 1, 'it was put onto the stack');
		const prompt = guidedPrompt(state);
		assert.match(prompt.description, /glorbify the frobnicator/);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].kind, 'triggered');
		const copy = roundTrip(state);
		const res = applyGameAction(copy, alice.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'yesNo', yes: true },
			operations: [{ op: 'add_counter', targetId: hob.instanceId, counterType: '+1/+1', amount: 2 }]
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(copy.stack.length, 0);
		assert.equal(copy.players[0].battlefield.find((c) => c.instanceId === hob.instanceId)?.counters['+1/+1'], 2);
	});

	it('a bot skips such a trigger with a log line', () => {
		const state = game(true);
		const alice = state.players[0];
		cast(state, alice, put(state, alice, creature('Hobwick Tinkerer', 'When ~ enters, glorbify the frobnicator.'), 'hand'));
		settle(state);
		assert.equal(state.stack.length, 0);
		assert.equal(logCount(state, 'skipped unsupported ability Hobwick Tinkerer'), 1);
	});

	it('an unenforced static is logged once on entering, not again on later checks', () => {
		const state = game();
		const alice = state.players[0];
		const c = put(state, alice, creature('Velkmoor Warden', "Creatures your opponents control can't glorbify."), 'hand');
		cast(state, alice, c);
		settle(state);
		const line = "Velkmoor Warden: 'Creatures your opponents control can't glorbify.' is not enforced.";
		assert.equal(logCount(state, line), 1);
		for (let i = 0; i < 3; i++) checkStateBasedActions(state);
		cast(state, alice, put(state, alice, creature('Plain Elf', ''), 'hand'));
		settle(state);
		assert.equal(applyGameAction(state, alice.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(logCount(state, line), 1);
		assert.equal(unsupportedKindLabel(cardSupportReport(c.card).unsupported[0].kind), 'Not enforced');
	});

	it('a trigger the engine cannot recognise is logged once on entering', () => {
		const state = game();
		const alice = state.players[0];
		cast(state, alice, put(state, alice, creature('Velkmoor Seer', 'Whenever an opponent glorbifies, you draw a card.'), 'hand'));
		settle(state);
		assert.equal(logCount(state, "Velkmoor Seer has an ability that isn't automated: Whenever an opponent glorbifies, you draw a card."), 1);
		assert.equal(state.pendingPrompts.length, 0);
	});

	it('"Resolve manually" opens a guided prompt for any ability while the player has priority', () => {
		const state = game();
		const alice = state.players[0];
		const bob = state.players[1];
		const seer = put(state, alice, creature('Velkmoor Seer', 'Whenever an opponent glorbifies, you draw a card.'), 'battlefield');
		// Only with priority, and only for a card the player controls.
		assert.equal(applyGameAction(state, bob.playerId, { type: 'resolve_manually', instanceId: seer.instanceId, abilityIndex: 0 }).ok, false);
		assert.equal(applyGameAction(state, alice.playerId, { type: 'resolve_manually', instanceId: 'nope' }).ok, false);
		assert.equal(applyGameAction(state, alice.playerId, { type: 'resolve_manually', instanceId: seer.instanceId, abilityIndex: 0 }).ok, true);
		const prompt = guidedPrompt(state);
		assert.equal(prompt.continuation?.kind, 'manual_ability');
		assert.equal(prompt.description, 'Whenever an opponent glorbifies, you draw a card.');
		assert.equal(state.stack.length, 0, 'it never uses the stack');

		const copy = roundTrip(state);
		const handBefore = copy.players[0].hand.length;
		const res = applyGameAction(copy, alice.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'yesNo', yes: true },
			operations: [
				{ op: 'draw_cards', amount: 1 },
				{ op: 'tap', targetId: seer.instanceId },
				{ op: 'create_token', amount: 1, tokenName: 'Velk Spirit', tokenPower: 1, tokenToughness: 1 }
			]
		});
		assert.equal(res.ok, true, res.error ?? '');
		const a2 = copy.players[0];
		assert.equal(a2.hand.length, handBefore + 1);
		assert.equal(a2.battlefield.find((c) => c.instanceId === seer.instanceId)?.tapped, true);
		assert.ok(a2.battlefield.some((c) => c.isToken && c.card.name === 'Velk Spirit'));
		assert.equal(copy.stack.length, 0);
		assert.equal(copy.pendingPrompts.length, 0);

		// It can also be cancelled.
		assert.equal(applyGameAction(state, alice.playerId, { type: 'choice', promptId: prompt.id, cancel: true }).ok, true);
		assert.equal(state.pendingPrompts.length, 0);
	});

	it('bots never get stuck on unsupported abilities', () => {
		const state = game(true);
		state.players[1].isBot = true;
		const alice = state.players[0];
		put(state, alice, UNPARSED_SPELL, 'hand');
		put(state, alice, creature('Hobwick Tinkerer', 'When ~ enters, glorbify the frobnicator.'), 'hand');
		runAutomatedPriorityAndBots(state);
		assert.equal(state.pendingPrompts.length, 0);
	});
});
