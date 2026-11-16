import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	endTheTurnImmediately,
	sanitizeGameStateForViewer
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

	for (const accept of [true, false]) {
		it(`mid-ability "You may ... If you do, ..." (${accept ? 'accepted' : 'declined'}) survives JSON round-trips`, () => {
			let state = game();
			let alice = player(state, 0);
			const spell = put(
				state,
				alice,
				card({
					name: 'Scholarly Bargain',
					oracleText: 'Draw a card. You may discard a card. If you do, draw two cards.'
				}),
				'hand'
			);
			const keepCard = put(state, alice, card({ name: 'Island', typeLine: 'Basic Land — Island' }), 'hand');
			const handBeforeCast = alice.hand.length;
			cast(state, alice, spell);
			settle(state);

			// Cast (-1) + step 0 draw (+1) before pausing at step 1 ("You may discard a card.")
			assert.equal(player(state, 0).hand.length, handBeforeCast);
			assert.equal(state.stack.length, 1);
			const optPrompt = onlyPrompt(state, 0);
			assert.equal(optPrompt.choice?.kind, 'yesNo');

			state = answerOnCopy(state, optPrompt, { kind: 'yesNo', yes: accept });
			if (!accept) {
				assert.equal(state.pendingPrompts.length, 0);
				assert.equal(state.stack.length, 0);
				assert.equal(player(state, 0).hand.length, handBeforeCast, 'declining skips discard and conditional draw');
				return;
			}

			// Step 1 pause: choose a card to discard.
			const discardPrompt = onlyPrompt(state, 0);
			assert.equal(discardPrompt.choice?.kind, 'chooseObjects');
			assert.equal(state.stack.length, 1);
			state = answerOnCopy(state, discardPrompt, {
				kind: 'chooseObjects',
				objectIds: [keepCard.instanceId]
			});
			assert.equal(state.pendingPrompts.length, 0);
			assert.equal(state.stack.length, 0);
			// +1 draw -1 discard +2 conditional draw -1 spell = handBeforeCast + 1
			assert.equal(player(state, 0).hand.length, handBeforeCast + 1);
		});
	}

	it('non-controller chooser ("Target opponent may ...") prompts the opponent and survives JSON round-trip', () => {
		let state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);
		const spell = put(
			state,
			alice,
			card({ name: 'Parley Offer', oracleText: 'Target opponent may draw a card.' }),
			'hand'
		);
		const bobHand = bob.hand.length;
		const aliceHandAfterCast = alice.hand.length - 1;
		cast(state, alice, spell, [{ kind: 'player', id: bob.playerId, label: bob.username }]);
		settle(state);

		const prompt = onlyPrompt(state, 1);
		assert.equal(prompt.playerId, bob.playerId, 'opponent gets the yes/no prompt, not controller');
		assert.equal(prompt.choice?.kind, 'yesNo');
		state = answerOnCopy(state, prompt, { kind: 'yesNo', yes: true });
		assert.equal(state.stack.length, 0);
		assert.equal(player(state, 1).hand.length, bobHand + 1);
		assert.equal(player(state, 0).hand.length, aliceHandAfterCast);
	});

	it('defers SBAs (CR 704.4) and triggered abilities (CR 603.3) while paused mid-resolution, strips them in viewer state, and flushes after resume', () => {
		let state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);
		// Put a 2/2 creature on Bob's battlefield and a dies-watcher on Alice's battlefield.
		const bear = put(state, bob, creature('Ashcoat Bear', '', '2', '2'), 'battlefield');
		put(
			state,
			alice,
			creature('Mourning Witness', 'Whenever a creature dies, you gain 1 life.'),
			'battlefield'
		);
		const spell = put(
			state,
			alice,
			card({
				name: 'Withering Pause',
				oracleText: 'Target creature gets -2/-2 until end of turn. You may draw a card.'
			}),
			'hand'
		);
		const aliceLifeBefore = alice.life;
		const aliceHandAfterCast = alice.hand.length - 1;

		cast(state, alice, spell, [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]);
		settle(state);

		// Spell paused before step 1 ("You may draw a card."): resolving spell is STILL on the stack
		// and bear with 2 - 2 = 0 toughness has NOT been put into graveyard by SBAs yet (CR 704.4).
		const prompt = onlyPrompt(state, 0);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].resolutionStarted, true);
		assert.ok(
			player(state, 1).battlefield.some((c) => c.instanceId === bear.instanceId),
			'SBA must not kill 0-toughness creature while spell is paused mid-resolution'
		);
		assert.equal(player(state, 1).graveyard.length, 0);
		assert.equal(state.pendingTriggers, undefined);

		// Verify sanitized viewer state hides effectResume and any pendingTriggers.
		const viewerState = sanitizeGameStateForViewer(state, alice.playerId);
		assert.equal(viewerState.stack[0].effectResume, undefined);
		assert.equal(viewerState.pendingTriggers, undefined);

		// Also verify a trigger fired directly during a paused step waits in state.pendingTriggers across JSON round-trip.
		let state2 = game();
		const alice2 = player(state2, 0);
		const bob2 = player(state2, 1);
		const prey = put(state2, alice2, creature('Ephemeral Squire', '', '1', '1'), 'battlefield');
		put(
			state2,
			bob2,
			creature('Vengeful Tracker', 'Whenever a creature dies, you gain 2 life.'),
			'battlefield'
		);
		const bobLifeBefore = bob2.life;
		const sacSpell = put(
			state2,
			alice2,
			card({
				name: 'Dark Bargain',
				oracleText: 'Target player sacrifices a creature. Draw a card. You may draw a card.'
			}),
			'hand'
		);
		//Wait: Dark Bargain has step 0 sacrifice -> step 2 optional draw!
		cast(state2, alice2, sacSpell, [{ kind: 'player', id: alice2.playerId, label: alice2.username }]);
		settle(state2);

		// Prey was sacrificed in step 0 (trigger recorded), then step 2 paused!
		// Trigger MUST wait in state.pendingTriggers rather than going on the stack above Dark Bargain!
		const pausePrompt = onlyPrompt(state2, 0);
		assert.equal(state2.stack.length, 1, 'only the resolving spell is on the stack while paused');
		assert.equal(state2.stack[0].title, 'Dark Bargain');
		assert.equal(state2.pendingTriggers?.length, 1, 'dies trigger is queued in pendingTriggers');
		assert.equal(player(state2, 1).life, bobLifeBefore, 'deferred trigger has not resolved yet');
		const sanitized2 = sanitizeGameStateForViewer(state2, alice2.playerId);
		assert.equal(sanitized2.pendingTriggers, undefined, 'viewer state strips pendingTriggers');
		assert.equal(sanitized2.stack[0].effectResume, undefined);

		// Answer on a JSON copy: spell finishes, leaves stack, deferred trigger goes on stack and settles!
		state2 = answerOnCopy(state2, pausePrompt, { kind: 'yesNo', yes: false });
		assert.equal(state2.pendingTriggers, undefined, 'pendingTriggers cleared once flushed');
		assert.equal(state2.stack.length, 1, 'deferred dies trigger is now on the stack');
		settle(state2);
		assert.equal(state2.stack.length, 0);
		assert.equal(player(state2, 1).life, bobLifeBefore + 2);
		assert.ok(prey.instanceId);

		// Finish first game (Withering Pause): once spell finishes, SBA kills bear -> Mourning Witness triggers!
		state = answerOnCopy(state, prompt, { kind: 'yesNo', yes: true });
		assert.equal(player(state, 0).hand.length, aliceHandAfterCast + 1);
		assert.ok(
			player(state, 1).graveyard.some((c) => c.instanceId === bear.instanceId),
			'SBA kills 0-toughness bear once paused spell finishes resolving'
		);
		assert.equal(state.stack.length, 1, 'dies trigger from post-resolution SBA is now on the stack');
		settle(state);
		assert.equal(player(state, 0).life, aliceLifeBefore + 1);
	});

	it('pausable PendingCostPayment (cast_spell): pauses mid-cost on zone_replacement_choice, defers SBAs/triggers, hides private state, and completes after JSON round-trip', () => {
		let state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);

		// Empty mana pool so cast_spell must tap the two Swamps once (and never re-pay on resume).
		alice.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		const swamp1 = put(state, alice, card({ name: 'Swamp', typeLine: 'Basic Land — Swamp', manaCost: '', cmc: 0 }), 'battlefield');
		const swamp2 = put(state, alice, card({ name: 'Swamp', typeLine: 'Basic Land — Swamp', manaCost: '', cmc: 0 }), 'battlefield');

		// Dies-watcher on Bob's battlefield triggers when c1 is sacrificed (part 0, object 0).
		put(
			state,
			bob,
			creature('Sorrow Stalker', 'Whenever a creature dies, you gain 2 life.'),
			'battlefield'
		);
		// Creature with lethal damage marked: SBA must NOT destroy it while PendingCostPayment is active (CR 704.3).
		const wounded = put(state, bob, creature('Wounded Sentinel', '', '2', '2'), 'battlefield');
		wounded.damageMarked = 2;

		// c1 dies normally -> triggers Sorrow Stalker; c2 has two competing graveyard replacements -> pauses on zone_replacement_choice.
		const c1 = put(state, alice, creature('Fodder Thrall'), 'battlefield');
		const c2 = put(
			state,
			alice,
			creature(
				'Shifted Martyr',
				"If ~ would be put into a graveyard from anywhere, exile it instead.\nIf ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			),
			'battlefield'
		);
		const discardCard = put(state, alice, card({ name: 'Bog Pebble', typeLine: 'Artifact', manaCost: '{0}', cmc: 0 }), 'hand');
		const spell = put(
			state,
			alice,
			card({
				name: 'Bleak Offering',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				colorIdentity: ['B'],
				oracleText: 'As an additional cost to cast this spell, sacrifice two creatures and discard a card.\nYou gain 3 life.'
			}),
			'hand'
		);

		const bobLifeBefore = bob.life;
		const aliceLifeBefore = alice.life;

		// Submit cast_spell with explicit object choices for sacrifice (part 0) and discard (part 1).
		const res = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			costPayment: {
				options: [],
				objects: [[c1.instanceId, c2.instanceId], [discardCard.instanceId]]
			}
		});
		assert.equal(res.ok, true, res.error ?? '');

		// Paused mid-payment: taps/mana already paid, c1 sacrificed, c2 in pendingZoneMoves awaiting replacement choice, discard NOT paid yet.
		const prompt = onlyPrompt(state, 0);
		assert.equal(prompt.choice?.kind, 'chooseReplacement');
		assert.equal(swamp1.tapped, true, 'mana lands tapped once');
		assert.equal(swamp2.tapped, true);
		assert.ok(state.pendingCostPayment, 'pendingCostPayment saved on state');
		assert.equal(state.pendingCostPayment?.kind, 'cast_spell');
		assert.equal(state.pendingCostPayment?.tapsAndManaDone, true);
		assert.equal(state.pendingCostPayment?.nextPartIndex, 0);
		assert.equal(state.pendingCostPayment?.nextObjectIndex, 2);
		assert.ok(alice.graveyard.some((c) => c.instanceId === c1.instanceId), 'c1 sacrificed');
		assert.ok(state.pendingZoneMoves?.some((c) => c.instanceId === c2.instanceId), 'c2 awaiting replacement choice');
		assert.ok(alice.hand.some((c) => c.instanceId === discardCard.instanceId), 'part 1 discard not paid yet');
		assert.ok(alice.hand.some((c) => c.instanceId === spell.instanceId), 'spell not placed on stack yet');
		assert.equal(state.stack.length, 0, 'stack still empty while mid-payment');
		assert.equal(state.pendingTriggers?.length, 1, 'c1 dies trigger deferred in pendingTriggers (CR 601.2i / 603.3)');
		assert.equal(bob.life, bobLifeBefore);

		// SBAs defer while pendingCostPayment is active (CR 704.3).
		checkStateBasedActions(state);
		assert.ok(bob.battlefield.some((c) => c.instanceId === wounded.instanceId), 'SBA deferred during PendingCostPayment');

		// Viewer sanitization strips pendingCostPayment and pendingTriggers.
		const aliceView = sanitizeGameStateForViewer(state, alice.playerId);
		const bobView = sanitizeGameStateForViewer(state, bob.playerId);
		assert.equal(aliceView.pendingCostPayment, undefined);
		assert.equal(aliceView.pendingTriggers, undefined);
		assert.equal(bobView.pendingCostPayment, undefined);
		assert.equal(bobView.pendingTriggers, undefined);

		// Answer zone_replacement_choice (exile c2) on a JSON round-tripped copy.
		const exileOpt = prompt.choice.options[0];
		state = answerOnCopy(state, prompt, { kind: 'chooseReplacement', id: exileOpt.id });

		const aliceAfter = player(state, 0);
		const bobAfter = player(state, 1);
		assert.equal(state.pendingCostPayment, undefined, 'pendingCostPayment cleared on completion');
		assert.equal(state.pendingZoneMoves, undefined);
		assert.equal(state.pendingTriggers, undefined, 'deferred triggers flushed onto stack');
		assert.ok(aliceAfter.exile.some((c) => c.instanceId === c2.instanceId), 'c2 exiled by chosen replacement');
		assert.ok(aliceAfter.graveyard.some((c) => c.instanceId === discardCard.instanceId), 'part 1 discard completed on resume');
		assert.ok(bobAfter.graveyard.some((c) => c.instanceId === wounded.instanceId), 'deferred SBA ran after payment completed');

		// Stack now has Bleak Offering on bottom, plus Sorrow Stalker triggers (c1 + wounded) above it.
		assert.ok(state.stack.some((s) => s.title === 'Bleak Offering'));
		assert.ok(state.stack.length >= 2);
		settle(state);
		assert.equal(state.stack.length, 0);
		assert.equal(player(state, 0).life, aliceLifeBefore + 3);
		assert.equal(player(state, 1).life, bobLifeBefore + 4);
	});

	it('pausable PendingCostPayment (activate_ability & tap_mana): pauses on zone_replacement_choice and completes after JSON round-trip', () => {
		// 1. activate_ability with {T}, Discard two cards: card 0 triggers zone_replacement_choice, tap isn't re-run, card 1 still discards.
		let state = game();
		let alice = player(state, 0);
		const relic = put(
			state,
			alice,
			card({
				name: 'Dusk Vault',
				typeLine: 'Artifact',
				manaCost: '{2}',
				cmc: 2,
				oracleText: '{T}, Discard two cards: You gain 3 life.'
			}),
			'battlefield'
		);
		const d1 = put(
			state,
			alice,
			card({
				name: 'Wandering Echo',
				typeLine: 'Sorcery',
				oracleText:
					"If ~ would be put into a graveyard from anywhere, exile it instead.\nIf ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			}),
			'hand'
		);
		const d2 = put(state, alice, card({ name: 'Plain Pebble', typeLine: 'Artifact' }), 'hand');

		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'activate_ability',
				instanceId: relic.instanceId,
				abilityId: 'act_0',
				costPayment: { options: [], objects: [[d1.instanceId, d2.instanceId]] }
			}).ok,
			true
		);

		const actPrompt = onlyPrompt(state, 0);
		assert.equal(actPrompt.choice?.kind, 'chooseReplacement');
		assert.equal(relic.tapped, true);
		assert.equal(state.pendingCostPayment?.kind, 'activate_ability');
		assert.equal(state.pendingCostPayment?.tapsAndManaDone, true);
		assert.equal(state.pendingCostPayment?.nextPartIndex, 1);
		assert.equal(state.pendingCostPayment?.nextObjectIndex, 1);
		assert.ok(alice.hand.some((c) => c.instanceId === d2.instanceId), 'second discard awaits resume');
		assert.equal(state.stack.length, 0);

		state = answerOnCopy(state, actPrompt, { kind: 'chooseReplacement', id: actPrompt.choice.options[0].id });
		alice = player(state, 0);
		assert.equal(state.pendingCostPayment, undefined);
		assert.ok(alice.exile.some((c) => c.instanceId === d1.instanceId));
		assert.ok(alice.graveyard.some((c) => c.instanceId === d2.instanceId));
		assert.equal(state.stack.length, 1);
		settle(state);
		assert.equal(player(state, 0).life, 43);

		// 2. tap_mana with {T}, Sacrifice ~: Add {B}.
		let manaState = game();
		const mAlice = player(manaState, 0);
		mAlice.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		const lotus = put(
			manaState,
			mAlice,
			card({
				name: 'Rift Petal',
				typeLine: 'Artifact',
				manaCost: '{0}',
				cmc: 0,
				oracleText:
					"{T}, Sacrifice ~: Add {B}.\nIf ~ would be put into a graveyard from anywhere, exile it instead.\nIf ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			}),
			'battlefield'
		);
		assert.equal(
			applyGameAction(manaState, mAlice.playerId, {
				type: 'tap_mana',
				instanceId: lotus.instanceId
			}).ok,
			true
		);
		const manaPrompt = onlyPrompt(manaState, 0);
		assert.equal(manaPrompt.choice?.kind, 'chooseReplacement');
		assert.equal(manaState.pendingCostPayment?.kind, 'tap_mana');
		assert.equal(mAlice.manaPool.B, 0, 'mana not added until replacement resolves');

		manaState = answerOnCopy(manaState, manaPrompt, {
			kind: 'chooseReplacement',
			id: manaPrompt.choice.options[0].id
		});
		assert.equal(manaState.pendingCostPayment, undefined);
		assert.equal(player(manaState, 0).manaPool.B, 1, 'mana added once payment completes');
		assert.ok(player(manaState, 0).exile.some((c) => c.instanceId === lotus.instanceId));
	});

	it('nested zone_replacement_choice mid-batch in EffectStep pauses remaining batch items, defers SBAs/triggers, and finishes after JSON round-trip', () => {
		let state = game();
		const alice = player(state, 0);
		const bob = player(state, 1);

		const shrine = put(
			state,
			bob,
			card({
				name: 'Sorrow Shrine',
				typeLine: 'Enchantment',
				manaCost: '{2}{B}',
				cmc: 3,
				oracleText: 'Whenever a creature dies, you gain 2 life.'
			}),
			'battlefield'
		);
		const bobLifeBefore = bob.life;
		const c1 = put(
			state,
			alice,
			card({
				name: 'Split-Fate Soldier',
				typeLine: 'Creature — Human',
				power: '2',
				toughness: '2',
				oracleText:
					"If ~ would be put into a graveyard from anywhere, exile it instead.\nIf ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			}),
			'battlefield'
		);
		const c2 = put(state, alice, creature('Bronze Bear', '', '2', '2'), 'battlefield');
		const wrathAndDraw = put(
			state,
			alice,
			card({
				name: 'Measured Cleansing',
				oracleText: 'Destroy all creatures. Draw a card.'
			}),
			'hand'
		);
		const handBeforeResolve = alice.hand.length - 1;
		cast(state, alice, wrathAndDraw);
		settle(state);

		const repPrompt = onlyPrompt(state, 0);
		assert.equal(repPrompt.choice?.kind, 'chooseReplacement');
		assert.equal(state.pendingZoneMoves?.length, 1, 'only c1 is paused in pendingZoneMoves');
		assert.equal(state.stack.length, 1, 'sorcery remains on stack mid-batch');
		assert.equal(state.stack[0].effectResume?.stepIndex, 0);
		assert.equal(state.stack[0].effectResume?.subStepIndex, 1);
		assert.ok(
			player(state, 0).battlefield.some((p) => p.instanceId === c2.instanceId),
			'c2 has not been destroyed yet while c1 awaits replacement order'
		);
		assert.equal(
			player(state, 0).hand.length,
			handBeforeResolve,
			'subsequent Draw step has not run yet'
		);
		assert.equal(state.pendingTriggers, undefined, 'no dies triggers flushed prematurely');
		const viewer = sanitizeGameStateForViewer(state, bob.playerId);
		assert.equal(viewer.pendingProcedure, undefined);
		assert.equal(viewer.stack[0]?.effectResume, undefined);

		// Answer c1's replacement (exile c1) after a JSON round-trip: c2 destroys, Draw step runs, then dies trigger flushes!
		state = answerOnCopy(state, repPrompt, {
			kind: 'chooseReplacement',
			id: repPrompt.choice!.options[0].id
		});
		assert.equal(state.pendingZoneMoves, undefined);
		assert.ok(player(state, 0).exile.some((c) => c.instanceId === c1.instanceId));
		assert.ok(player(state, 0).graveyard.some((c) => c.instanceId === c2.instanceId));
		assert.ok(player(state, 1).battlefield.some((c) => c.instanceId === shrine.instanceId));
		assert.equal(
			player(state, 0).hand.length,
			handBeforeResolve + 1,
			'Draw step executed after the destroy batch completed'
		);
		assert.equal(state.stack.length, 1, 'dies trigger for c2 flushed onto stack after resolution');
		settle(state);
		assert.equal(state.stack.length, 0);
		assert.equal(player(state, 1).life, bobLifeBefore + 2);
	});

	it('nested counter_replacement_choice mid-batch in putCounters preserves batch progress across multiple pauses and JSON round-trips', () => {
		let state = game();
		const alice = player(state, 0);

		put(
			state,
			alice,
			card({
				name: 'Hardened Scales',
				typeLine: 'Enchantment',
				manaCost: '{G}',
				cmc: 1,
				oracleText:
					'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.'
			}),
			'battlefield'
		);
		put(
			state,
			alice,
			card({
				name: 'Doubling Season',
				typeLine: 'Enchantment',
				manaCost: '{4}{G}',
				cmc: 5,
				oracleText:
					'If an effect would put one or more counters on a permanent you control, it puts twice that many of each of those kinds of counters on that permanent instead.'
			}),
			'battlefield'
		);
		const a = put(state, alice, creature('Alpha Cub', '', '1', '1'), 'battlefield');
		const b = put(state, alice, creature('Beta Cub', '', '1', '1'), 'battlefield');
		const bless = put(
			state,
			alice,
			card({
				name: 'Pack Surge',
				oracleText: 'Put a +1/+1 counter on each creature you control. You gain 3 life.'
			}),
			'hand'
		);
		cast(state, alice, bless);
		settle(state);

		// Paused on first creature (Alpha Cub): Beta Cub has 0 counters and life gain hasn't run!
		const p1Prompt = onlyPrompt(state, 0);
		assert.equal(p1Prompt.choice?.kind, 'chooseReplacement');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].effectResume?.stepIndex, 0);
		assert.equal(state.stack[0].effectResume?.subStepIndex, 1);
		assert.equal(player(state, 0).battlefield.find((c) => c.instanceId === a.instanceId)?.counters['+1/+1'], 0);
		assert.equal(player(state, 0).battlefield.find((c) => c.instanceId === b.instanceId)?.counters['+1/+1'], 0);
		assert.equal(player(state, 0).life, 40, 'step 1 life gain has not run yet');

		// Choose option 0 for Alpha Cub on a JSON round-tripped copy -> pauses on Beta Cub at subStepIndex 2!
		state = answerOnCopy(state, p1Prompt, {
			kind: 'chooseReplacement',
			id: p1Prompt.choice!.options[0].id
		});
		const p2Prompt = onlyPrompt(state, 0);
		assert.equal(p2Prompt.choice?.kind, 'chooseReplacement');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].effectResume?.stepIndex, 0);
		assert.equal(state.stack[0].effectResume?.subStepIndex, 2);
		const aCounters =
			player(state, 0).battlefield.find((c) => c.instanceId === a.instanceId)?.counters['+1/+1'] ?? 0;
		assert.ok(aCounters >= 3, 'Alpha Cub received replaced counters before Beta Cub');
		assert.equal(
			player(state, 0).battlefield.find((c) => c.instanceId === b.instanceId)?.counters['+1/+1'],
			0,
			'Beta Cub awaits second counter_replacement_choice'
		);
		assert.equal(player(state, 0).life, 40, 'step 1 life gain still waits until batch completes');

		// Choose option 1 for Beta Cub on JSON round-trip -> Beta Cub gets counters and step 1 ("gain 3 life") runs!
		state = answerOnCopy(state, p2Prompt, {
			kind: 'chooseReplacement',
			id: p2Prompt.choice!.options[1].id
		});
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 0);
		const bCounters =
			player(state, 0).battlefield.find((c) => c.instanceId === b.instanceId)?.counters['+1/+1'] ?? 0;
		assert.ok(bCounters >= 3, 'Beta Cub received replaced counters');
		assert.equal(player(state, 0).life, 43, 'step 1 ran once putCounters batch finished');
	});

	it('discard_to_hand_size hitting zone_replacement_choice preserves remaining discards, defers pass turn, and strips pendingProcedure from viewer', () => {
		let state = game();
		const alice = player(state, 0);
		const d1 = put(
			state,
			alice,
			card({
				name: 'Shifting Scroll',
				typeLine: 'Instant',
				manaCost: '{U}',
				cmc: 1,
				oracleText:
					"If ~ would be put into a graveyard from anywhere, exile it instead.\nIf ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			}),
			'hand'
		);
		const d2 = put(state, alice, card({ name: 'Plain Scroll', typeLine: 'Instant', manaCost: '{U}', cmc: 1, oracleText: '' }), 'hand');
		while (alice.hand.length > 9) {
			alice.hand.shift();
		}
		while (alice.hand.length < 9) {
			put(state, alice, card({ name: 'Filler Island', typeLine: 'Basic Land — Island' }), 'hand');
		}
		const turnBefore = state.turnNumber;
		const activeBefore = state.activePlayerIndex;

		endTheTurnImmediately(state, alice.playerId);
		const discPrompt = onlyPrompt(state, 0);
		assert.equal(discPrompt.purpose, 'discard_to_hand_size');
		assert.equal(discPrompt.continuation?.kind, 'procedure');

		// Answer choosing [d1, d2] -> d1 triggers zone_replacement_choice before d2 discards or turn passes!
		state = answerOnCopy(state, discPrompt, {
			kind: 'chooseObjects',
			objectIds: [d1.instanceId, d2.instanceId]
		});
		const repPrompt = onlyPrompt(state, 0);
		assert.equal(repPrompt.choice?.kind, 'chooseReplacement');
		assert.equal(state.pendingProcedure?.kind, 'discard_to_hand_size');
		assert.equal(state.turnNumber, turnBefore);
		assert.equal(state.activePlayerIndex, activeBefore, 'turn has not passed while replacement is pending');
		assert.ok(
			player(state, 0).hand.some((c) => c.instanceId === d2.instanceId),
			'd2 remains in hand until d1 replacement finishes'
		);
		const viewer = sanitizeGameStateForViewer(state, player(state, 1).playerId);
		assert.equal(viewer.pendingProcedure, undefined, 'viewer state strips pendingProcedure');

		// Resolve replacement on JSON copy -> d1 exiles, d2 discards to graveyard, cleanup completes and turn passes!
		state = answerOnCopy(state, repPrompt, {
			kind: 'chooseReplacement',
			id: repPrompt.choice!.options[0].id
		});
		assert.equal(state.pendingProcedure, undefined);
		assert.ok(player(state, 0).exile.some((c) => c.instanceId === d1.instanceId));
		assert.ok(player(state, 0).graveyard.some((c) => c.instanceId === d2.instanceId));
		assert.equal(state.activePlayerIndex, 1, 'turn passed to Bob after all cleanup discards completed');
	});

	it('legend_rule hitting zone_replacement_choice pauses remaining duplicates and SBAs cleanly across JSON round-trip', () => {
		let state = game();
		const alice = player(state, 0);
		const kKeep = put(
			state,
			alice,
			card({
				name: 'Twin Champion',
				typeLine: 'Legendary Creature — Warrior',
				manaCost: '{1}{W}',
				cmc: 2,
				power: '2',
				toughness: '2',
				oracleText:
					"If ~ would be put into a graveyard from anywhere, exile it instead.\nIf ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			}),
			'battlefield'
		);
		const kRepl = put(state, alice, { ...kKeep.card }, 'battlefield');
		const kThird = put(state, alice, { ...kKeep.card }, 'battlefield');
		// Make kThird have plain oracleText so only kRepl triggers zone_replacement_choice while kThird moves normally after!
		kThird.card = { ...kKeep.card, oracleText: '' };

		checkStateBasedActions(state);
		const legPrompt = onlyPrompt(state, 0);
		assert.equal(legPrompt.purpose, 'legend_rule');
		assert.equal(legPrompt.continuation?.kind, 'procedure');

		// Choose kKeep -> kRepl enters pendingZoneMoves with zone_replacement_choice, kThird waits!
		state = answerOnCopy(state, legPrompt, {
			kind: 'chooseObjects',
			objectIds: [kKeep.instanceId]
		});
		const rep1 = onlyPrompt(state, 0);
		assert.equal(rep1.choice?.kind, 'chooseReplacement');
		assert.equal(state.pendingProcedure?.kind, 'legend_rule');
		assert.ok(
			player(state, 0).battlefield.some((p) => p.instanceId === kThird.instanceId),
			'kThird waits on battlefield until kRepl replacement resolves'
		);
		const viewer = sanitizeGameStateForViewer(state, player(state, 1).playerId);
		assert.equal(viewer.pendingProcedure, undefined, 'viewer state strips pendingProcedure');

		// Answer kRepl replacement -> kThird moves to graveyard cleanly and pendingProcedure clears!
		state = answerOnCopy(state, rep1, {
			kind: 'chooseReplacement',
			id: rep1.choice!.options[0].id
		});
		assert.equal(state.pendingProcedure, undefined);
		assert.ok(player(state, 0).battlefield.some((p) => p.instanceId === kKeep.instanceId));
		assert.ok(player(state, 0).exile.some((c) => c.instanceId === kRepl.instanceId));
		assert.ok(player(state, 0).graveyard.some((c) => c.instanceId === kThird.instanceId));
	});
});
