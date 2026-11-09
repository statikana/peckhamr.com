import { describe, it } from 'node:test';
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
	type ChoiceAnswer,
	type GameState,
	type LobbySeat,
	type PendingPrompt,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

/**
 * Step E2 (ENGINE_ARCHITECTURE_PLAN.md): every prompt a human can get survives the server's JSON
 * round trip. The lobby server saves GameState as JSON after each request and reloads it for the
 * next one, so each test creates a prompt, copies the state with JSON.parse(JSON.stringify(state)),
 * answers the prompt on the copy, and checks that the game went on correctly there. Before step E2
 * the sacrifice and discard prompts kept their continuation in a WeakMap callback keyed by the
 * original state object, so on the copy the answer did nothing. Synthetic cards with invented names.
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

function creature(name: string, oracleText = '', power = '2', toughness = '2', typeLine = 'Creature — Human'): ScryfallCard {
	return card({ name, manaCost: '{2}', cmc: 2, typeLine, oracleText, power, toughness });
}

function seat(i: number, id: string, username: string): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: id,
		username,
		avatarUrl: '',
		isBot: false,
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

function newState(players = 2): GameState {
	const names = ['Alice', 'Bob', 'Carol'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i]));
	return createInitialGameState(
		'LOBBY_RT',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
}

/** Two (or three) human players in main1 of Alice's turn, with plenty of mana. */
function game(players = 2): GameState {
	const state = newState(players);
	for (const p of state.players) {
		if (state.status === 'mulligan') assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) p.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
	return state;
}

/** What the lobby server does between two requests. */
function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function player(state: GameState, i: number): PlayerGameState {
	return state.players[i];
}

function put(state: GameState, p: PlayerGameState, c: ScryfallCard, zone: 'hand' | 'battlefield' | 'graveyard' | 'library'): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, p.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (zone === 'library') p.library.unshift(inst);
	else p[zone].push(inst);
	return inst;
}

function cast(state: GameState, p: PlayerGameState, inst: CardInstance, targets: TargetRef[] = []): void {
	const res = applyGameAction(state, p.playerId, { type: 'cast_spell', instanceId: inst.instanceId, targets });
	assert.equal(res.ok, true, res.error ?? '');
}

/** Whoever holds priority passes, until the stack is empty or a prompt is waiting. */
function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function onlyPrompt(state: GameState, playerIndex: number): PendingPrompt {
	assert.equal(state.pendingPrompts.length, 1, `expected one prompt, got ${state.pendingPrompts.map((p) => p.title).join(', ')}`);
	const prompt = state.pendingPrompts[0];
	assert.equal(prompt.playerId, state.players[playerIndex].playerId);
	return prompt;
}

/** Answers `prompt` with `{ type: 'choice' }` on a JSON copy of the state and returns the copy. */
function answerOnCopy(state: GameState, prompt: PendingPrompt, answer: ChoiceAnswer, extra: Record<string, unknown> = {}): GameState {
	const copy = roundTrip(state);
	const res = applyGameAction(copy, prompt.playerId, { type: 'choice', promptId: prompt.id, answer, ...extra });
	assert.equal(res.ok, true, res.error ?? '');
	assert.equal(JSON.stringify(roundTrip(copy)), JSON.stringify(copy), 'state stays plain JSON after answering');
	return copy;
}

function ids(cards: CardInstance[]): string[] {
	return cards.map((c) => c.instanceId);
}

describe('Step E2: prompts survive the JSON round trip (fail-first)', () => {
	it('sacrifice choice: resolution pauses until the answer, which works on the reloaded state, then the rest runs', () => {
		const state = game();
		const alice = player(state, 0);
		const a = put(state, alice, creature('Mossback Drudge', '', '1', '1'), 'battlefield');
		const b = put(state, alice, creature('Quillfen Strider', '', '4', '4'), 'battlefield');
		const spell = put(state, alice, card({ name: 'Ossuary Bargain', oracleText: 'Sacrifice a creature. You gain life equal to its power.' }), 'hand');
		cast(state, alice, spell);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.choice?.kind, 'chooseObjects');
		assert.equal(prompt.continuation?.kind, 'effect_choice');
		// CR 608.2n: still on the stack, and the life gain hasn't happened yet.
		assert.equal(state.stack.length, 1);
		assert.equal(alice.life, 40);

		const copy = answerOnCopy(state, prompt, { kind: 'chooseObjects', objectIds: [b.instanceId] });
		const alice2 = player(copy, 0);
		assert.ok(alice2.graveyard.some((c) => c.instanceId === b.instanceId), 'the chosen creature was sacrificed');
		assert.ok(alice2.battlefield.some((c) => c.instanceId === a.instanceId), 'the other creature stays');
		assert.equal(alice2.life, 44, 'the binding ("its power") survived the pause: 4 life');
		assert.equal(copy.stack.length, 0);
		assert.ok(alice2.graveyard.some((c) => c.instanceId === spell.instanceId), 'the spell finished resolving');
	});

	it('sacrifice choice for an opponent ("each opponent sacrifices"): the opponent answers on the reloaded state', () => {
		const state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);
		const x = put(state, bob, creature('Fenwick Sentry'), 'battlefield');
		const y = put(state, bob, creature('Brackenmaw'), 'battlefield');
		const spell = put(state, alice, card({ name: 'Edict of the Grey Moor', oracleText: 'Each opponent sacrifices a creature. Draw a card.' }), 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, spell);
		settle(state);
		const prompt = onlyPrompt(state, 1);
		assert.equal(alice.hand.length, handBefore - 1, 'no card drawn before the choice');

		const copy = answerOnCopy(state, prompt, { kind: 'chooseObjects', objectIds: [x.instanceId] });
		assert.ok(player(copy, 1).graveyard.some((c) => c.instanceId === x.instanceId));
		assert.ok(player(copy, 1).battlefield.some((c) => c.instanceId === y.instanceId));
		assert.equal(player(copy, 0).hand.length, handBefore, 'the draw ran after the choice');
		assert.equal(copy.stack.length, 0);
	});

	it('discard choice: each human chooses in turn (one prompt at a time, each after a round trip), then all discard at once', () => {
		const state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);
		const spell = put(state, alice, card({ name: 'Whispering Purge', oracleText: 'Each player discards a card, then draws a card.' }), 'hand');
		cast(state, alice, spell);
		settle(state);
		const first = onlyPrompt(state, 0);
		const aliceDiscard = alice.hand[0].instanceId;
		const s2 = answerOnCopy(state, first, { kind: 'chooseObjects', objectIds: [aliceDiscard] });
		// Alice chose; nothing is discarded until Bob has chosen too (CR 101.4).
		assert.ok(player(s2, 0).hand.some((c) => c.instanceId === aliceDiscard));
		const second = onlyPrompt(s2, 1);
		const bobDiscard = player(s2, 1).hand[2].instanceId;
		const s3 = answerOnCopy(s2, second, { kind: 'chooseObjects', objectIds: [bobDiscard] });
		assert.ok(player(s3, 0).graveyard.some((c) => c.instanceId === aliceDiscard));
		assert.ok(player(s3, 1).graveyard.some((c) => c.instanceId === bobDiscard));
		assert.equal(player(s3, 1).hand.length, bob.hand.length, 'Bob discarded one and drew one');
		assert.equal(s3.stack.length, 0);
		assert.equal(s3.pendingPrompts.length, 0);
	});

	it('discard choice for a target player', () => {
		const state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);
		const spell = put(state, alice, card({ name: 'Mindrot Whisper', oracleText: 'Target player discards two cards.' }), 'hand');
		cast(state, alice, spell, [{ kind: 'player', id: bob.playerId, label: bob.username }]);
		settle(state);
		const prompt = onlyPrompt(state, 1);
		const chosen = ids(bob.hand.slice(1, 3));
		const copy = answerOnCopy(state, prompt, { kind: 'chooseObjects', objectIds: chosen });
		for (const id of chosen) assert.ok(player(copy, 1).graveyard.some((c) => c.instanceId === id));
		assert.equal(player(copy, 1).hand.length, bob.hand.length - 2);
	});

	it('cost choice: the waiting activation is stored as data and runs on the reloaded state', () => {
		const state = game();
		const alice = player(state, 0);
		const altar = put(state, alice, card({ name: 'Cinderbone Altar', typeLine: 'Artifact', oracleText: 'Sacrifice a creature: You gain 2 life.' }), 'battlefield');
		const a = put(state, alice, creature('Ashgrove Thrall'), 'battlefield');
		put(state, alice, creature('Ashgrove Mourner'), 'battlefield');
		const res = applyGameAction(state, alice.playerId, { type: 'activate_ability', instanceId: altar.instanceId, abilityId: 'act_0' });
		assert.equal(res.ok, true, res.error ?? '');
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'cost_choice');
		const copy = answerOnCopy(state, prompt, { kind: 'chooseObjects', objectIds: [a.instanceId] });
		assert.ok(player(copy, 0).graveyard.some((c) => c.instanceId === a.instanceId));
		assert.equal(copy.stack.length, 1);
		settle(copy);
		assert.equal(player(copy, 0).life, 42);
	});

	it('library search', () => {
		const state = game();
		const alice = player(state, 0);
		const land = put(state, alice, card({ name: 'Forest', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0 }), 'library');
		const spell = put(state, alice, card({ name: 'Trailwise Forage', oracleText: 'Search your library for a basic land card, reveal it, put it into your hand, then shuffle.' }), 'hand');
		cast(state, alice, spell);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'search_library');
		const copy = answerOnCopy(state, prompt, { kind: 'chooseObjects', objectIds: [land.instanceId] });
		assert.ok(player(copy, 0).hand.some((c) => c.instanceId === land.instanceId));
	});

	it('scry', () => {
		const state = game();
		const alice = player(state, 0);
		const spell = put(state, alice, card({ name: 'Glimpse the Tidewheel', typeLine: 'Instant', oracleText: 'Scry 2.' }), 'hand');
		cast(state, alice, spell);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'scry_choice');
		const [top0, top1] = ids(alice.library.slice(0, 2));
		const copy = answerOnCopy(state, prompt, { kind: 'orderObjects', topIds: [top1], bottomIds: [top0] });
		assert.equal(player(copy, 0).library[0].instanceId, top1);
		assert.equal(player(copy, 0).library.at(-1)?.instanceId, top0);
	});

	it('scry before another step: resolution pauses after the scry prompt and resumes on the reloaded state', () => {
		const state = game();
		const alice = player(state, 0);
		const spell = put(state, alice, card({ name: 'Tidewheel Augury', typeLine: 'Instant', oracleText: 'Scry 2, then draw a card.' }), 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, spell);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'scry_choice');
		assert.equal(prompt.continuation?.kind, 'effect_resume');
		assert.equal(state.stack.length, 1, 'still on the stack (CR 608.2n)');
		assert.equal(alice.hand.length, handBefore - 1, 'nothing drawn yet');
		const [top0, top1] = ids(alice.library.slice(0, 2));
		const copy = answerOnCopy(state, prompt, { kind: 'orderObjects', topIds: [top1], bottomIds: [top0] });
		const a2 = player(copy, 0);
		assert.equal(a2.hand.length, handBefore, 'the draw ran after the scry');
		assert.ok(a2.hand.some((c) => c.instanceId === top1), 'it drew the card kept on top');
		assert.equal(a2.library.at(-1)?.instanceId, top0);
		assert.equal(copy.stack.length, 0);
		assert.ok(a2.graveyard.some((c) => c.instanceId === spell.instanceId));
	});

	it('a two-card search before another step: both search prompts carry the continuation; the rest runs after the last', () => {
		const state = game();
		const alice = player(state, 0);
		const forest = card({ name: 'Forest', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0 });
		const f1 = put(state, alice, forest, 'library');
		const f2 = put(state, alice, forest, 'library');
		const spell = put(
			state,
			alice,
			card({
				name: 'Rootpath Survey',
				oracleText: 'Search your library for up to two basic land cards, reveal them, put one onto the battlefield tapped and the other into your hand, then shuffle. You gain 2 life.'
			}),
			'hand'
		);
		cast(state, alice, spell);
		settle(state);
		const first = onlyPrompt(state, 0);
		assert.equal(first.purpose, 'search_library');
		assert.equal(first.continuation?.kind, 'effect_resume');
		const s2 = answerOnCopy(state, first, { kind: 'chooseObjects', objectIds: [f1.instanceId] });
		assert.equal(player(s2, 0).life, 40, 'no life gained between the two searches');
		const second = onlyPrompt(s2, 0);
		assert.equal(second.continuation?.kind, 'effect_resume');
		const s3 = answerOnCopy(s2, second, { kind: 'chooseObjects', objectIds: [f2.instanceId] });
		const a3 = player(s3, 0);
		assert.ok(a3.battlefield.some((c) => c.instanceId === f1.instanceId));
		assert.ok(a3.hand.some((c) => c.instanceId === f2.instanceId));
		assert.equal(a3.life, 42, 'the step after the search ran');
		assert.equal(s3.stack.length, 0);
	});

	it('trigger targets', () => {
		const state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);
		put(state, bob, creature('Reedmarsh Lurker'), 'battlefield');
		const c = put(state, alice, creature('Emberquill Adept', 'When ~ enters, ~ deals 1 damage to any target.'), 'hand');
		cast(state, alice, c);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'trigger_targets');
		const copy = answerOnCopy(state, prompt, { kind: 'chooseObjects', objectIds: [bob.playerId] });
		settle(copy);
		assert.equal(player(copy, 1).life, 39);
	});

	it('trigger order', () => {
		const state = game();
		const alice = player(state, 0);
		const c = put(state, alice, creature('Twinbell Herald', 'When ~ enters, you gain 1 life.\nWhen ~ enters, draw a card.'), 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, c);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'trigger_order');
		const order = prompt.choice?.kind === 'orderObjects' ? prompt.choice.objectIds : [];
		const copy = answerOnCopy(state, prompt, { kind: 'orderObjects', topIds: [...order].reverse() });
		settle(copy);
		assert.equal(player(copy, 0).life, 41);
		assert.equal(player(copy, 0).hand.length, handBefore);
		assert.equal(copy.stack.length, 0);
	});

	it('trigger "you may"', () => {
		const state = game();
		const alice = player(state, 0);
		const c = put(state, alice, creature('Lanternfen Scholar', 'When ~ enters, you may draw a card.'), 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, c);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'trigger_may');
		const copy = answerOnCopy(state, prompt, { kind: 'yesNo', yes: true });
		assert.equal(player(copy, 0).hand.length, handBefore);
		assert.equal(copy.stack.length, 0);
	});

	it('a paused resolution shows its "resolved" VFX once, not again when it resumes', () => {
		const state = game();
		const alice = player(state, 0);
		const c = put(state, alice, creature('Lanternfen Archivist', 'When ~ enters, you may draw a card.'), 'hand');
		cast(state, alice, c);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		const copy = answerOnCopy(state, prompt, { kind: 'yesNo', yes: true });
		const resolved = copy.recentVfxEvents.filter((v) => v.kind === 'stack_resolve' && v.label?.includes('Lanternfen Archivist ('));
		assert.equal(resolved.length, 1);
	});

	it('legend rule (prompt as data; note: the SBA currently keeps the newest copy without asking)', () => {
		const state = game();
		const alice = player(state, 0);
		const legend = creature('Vaskar, Keeper of Tides', '', '3', '3', 'Legendary Creature — Merfolk');
		const one = put(state, alice, legend, 'battlefield');
		const two = put(state, alice, legend, 'battlefield');
		state.pendingPrompts.push({
			id: 'prm_legend',
			playerId: alice.playerId,
			kind: 'legend_rule',
			title: 'Legend Rule',
			description: 'Choose the legendary permanent to keep.',
			candidateInstanceIds: [one.instanceId, two.instanceId]
		});
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose ?? prompt.kind, 'legend_rule');
		const copy = answerOnCopy(state, prompt, { kind: 'chooseObjects', objectIds: [two.instanceId] });
		assert.ok(player(copy, 0).battlefield.some((c) => c.instanceId === two.instanceId));
		assert.ok(player(copy, 0).graveyard.some((c) => c.instanceId === one.instanceId));
	});

	it('commander zone choice', () => {
		const state = game();
		const alice = player(state, 0);
		const cmd = alice.command[0];
		alice.command.splice(0, 1);
		cmd.zone = 'graveyard';
		alice.graveyard.push(cmd);
		checkStateBasedActions(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'commander_zone_choice');
		const copy = answerOnCopy(state, prompt, { kind: 'yesNo', yes: true });
		assert.ok(player(copy, 0).command.some((c) => c.instanceId === cmd.instanceId));
	});

	it('end the turn (yes/no for the active player)', () => {
		const state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);
		const spell = put(state, bob, card({ name: 'Hourglass Rupture', typeLine: 'Instant', oracleText: 'The player whose turn it is may end the turn.' }), 'hand');
		assert.equal(applyGameAction(state, alice.playerId, { type: 'pass_priority' }).ok, true);
		cast(state, bob, spell);
		settle(state);
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.purpose, 'end_turn');
		const copy = answerOnCopy(state, prompt, { kind: 'yesNo', yes: true });
		assert.ok(copy.log.some((l) => l.text.startsWith('The turn ended immediately')));
	});

	it('mulligan and London bottom', () => {
		const state = newState(2);
		state.rules.mulliganRule = 'london_standard';
		const mull = state.pendingPrompts.find((p) => p.playerId === state.players[0].playerId)!;
		assert.equal(mull.purpose ?? mull.kind, 'mulligan');
		const s2 = answerOnCopy(state, mull, { kind: 'yesNo', yes: false });
		assert.equal(player(s2, 0).mulliganCount, 1);
		const keep = s2.pendingPrompts.find((p) => p.playerId === s2.players[0].playerId)!;
		const s3 = answerOnCopy(s2, keep, { kind: 'yesNo', yes: true });
		const bottom = s3.pendingPrompts.find((p) => p.playerId === s3.players[0].playerId)!;
		assert.equal(bottom.kind, 'london_bottom');
		const chosen = player(s3, 0).hand[0].instanceId;
		const s4 = answerOnCopy(s3, bottom, { kind: 'chooseObjects', objectIds: [chosen] });
		assert.equal(player(s4, 0).hand.length, 6);
		assert.equal(player(s4, 0).library.at(-1)?.instanceId, chosen);
		assert.equal(player(s4, 0).hasKeptHand, true);
	});
});
