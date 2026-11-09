import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedPriorityAndBots } from '../ai.ts';
import { applyGameAction, createCardInstance, createInitialGameState } from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PendingPrompt,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

/**
 * Step F (ENGINE_ARCHITECTURE_PLAN.md Phase 10): the precon abilities that only the legacy
 * ParsedEffect fallback ran before step F now resolve on the IR interpreter, with their whole
 * effect (the legacy path approximated most of them). Each is tested with the printed card and with
 * a synthetic card with an invented name (rename invariance), and human prompts are answered after
 * a JSON round trip of the state.
 */

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

function staple(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	if (c) return c;
	for (const d of PRECON_DECKS) {
		for (const cmd of d.commanders) if (cmd.name === name) return cmd;
		for (const e of d.cards) if (e.card.name === name) return e.card;
	}
	assert.fail(`missing precon card ${name}`);
}

/** The card with another name; self-references in its text follow the new name. */
function renamed(c: ScryfallCard, name: string): ScryfallCard {
	return { ...c, id: `syn_${name.replace(/\W/g, '_')}`, name, oracleText: c.oracleText.split(c.name).join(name) };
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

/** A game in main1 of player 0's turn; `bots[i]` makes seat i a bot. Everyone has plenty of mana. */
function game(bots: boolean[] = []): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob'];
	const seats = names.map((n, i) => seat(i, `player_${i + 1}`, n, Boolean(bots[i])));
	const state = createInitialGameState(
		'LOBBY_STEPF',
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
	for (const pl of state.players) pl.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
	return { state, p: state.players };
}

function put(state: GameState, player: PlayerGameState, c: ScryfallCard, zone: 'hand' | 'battlefield' | 'graveyard' | 'library'): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function cast(state: GameState, player: PlayerGameState, inst: CardInstance, targets: TargetRef[] = [], modes?: number[]): void {
	const res = applyGameAction(state, player.playerId, {
		type: 'cast_spell',
		instanceId: inst.instanceId,
		targets,
		...(modes ? { modes } : {})
	});
	assert.equal(res.ok, true, res.error ?? '');
}

function passUntil(state: GameState, phase: GameState['phase'], max = 60): void {
	for (let i = 0; i < max && state.phase !== phase; i++) {
		if (state.pendingPrompts.length > 0) assert.fail(`unexpected prompt: ${state.pendingPrompts[0].title}`);
		const prio = state.players[state.priorityPlayerIndex];
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
	}
	assert.equal(state.phase, phase);
}

function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function onlyPrompt(state: GameState): PendingPrompt {
	assert.equal(state.pendingPrompts.length, 1, `prompts: ${state.pendingPrompts.map((p) => p.title).join(', ')}`);
	return state.pendingPrompts[0];
}

function answerObjects(state: GameState, prompt: PendingPrompt, objectIds: string[]): void {
	const res = applyGameAction(state, prompt.playerId, {
		type: 'choice',
		promptId: prompt.id,
		answer: { kind: 'chooseObjects', objectIds }
	});
	assert.equal(res.ok, true, res.error ?? '');
}

function answerYesNo(state: GameState, prompt: PendingPrompt, yes: boolean): void {
	const res = applyGameAction(state, prompt.playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'yesNo', yes } });
	assert.equal(res.ok, true, res.error ?? '');
}

const ref = (c: CardInstance): TargetRef => ({ kind: 'permanent', id: c.instanceId, label: c.card.name });
const filler = (name: string) => card({ name, typeLine: 'Sorcery', oracleText: 'Draw a card.' });
const creatureCard = (name: string, subtype = 'Bear', extra: Partial<ScryfallCard> = {}) =>
	card({ name, typeLine: `Creature — ${subtype}`, manaCost: '{2}', cmc: 2, power: '2', toughness: '2', ...extra });

function noManualOrLegacy(state: GameState): void {
	const bad = state.log.filter((l) => /isn't automated|skipped unsupported ability/.test(l.text));
	assert.deepEqual(bad.map((l) => l.text), []);
	assert.ok(!state.pendingPrompts.some((p) => p.purpose === 'guided_resolution'), 'no guided resolution');
}

describe('Step F: Brainstorm-style "put N cards from your hand on top of your library"', () => {
	for (const c of [staple('Brainstorm'), renamed(staple('Brainstorm'), 'Tidal Recollection')]) {
		it(`${c.name}: a human draws three, then chooses the two cards (and their order) to put back`, () => {
			let { state, p } = game();
			const alice = p[0];
			for (let i = 0; i < 5; i++) put(state, alice, filler(`Library Card ${i}`), 'library');
			const keep = put(state, alice, filler('Kept Card'), 'hand');
			const spell = put(state, alice, c, 'hand');
			const handBefore = alice.hand.length; // includes the spell
			cast(state, alice, spell);
			settle(state);
			const prompt = onlyPrompt(state);
			assert.equal(prompt.playerId, alice.playerId);
			assert.equal(alice.hand.length, handBefore - 1 + 3, 'drew three cards before choosing');
			const drawn = alice.hand.filter((h) => h.instanceId !== keep.instanceId);
			state = roundTrip(state);
			const second = drawn[0].instanceId;
			const top = keep.instanceId;
			answerObjects(state, state.pendingPrompts[0], [top, second]);
			settle(state);
			const a = state.players[0];
			assert.equal(a.library[0].instanceId, top, 'the first chosen card is on top');
			assert.equal(a.library[1].instanceId, second);
			assert.equal(a.hand.length, handBefore - 1 + 3 - 2);
			noManualOrLegacy(state);
		});
	}

	it('a bot resolves it without a prompt: +3 cards, -2 cards', () => {
		const { state, p } = game([true]);
		const alice = p[0];
		for (let i = 0; i < 5; i++) put(state, alice, filler(`Library Card ${i}`), 'library');
		const spell = put(state, alice, renamed(staple('Brainstorm'), 'Tidal Recollection'), 'hand');
		const handBefore = alice.hand.length;
		const libBefore = alice.library.length;
		cast(state, alice, spell);
		settle(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(alice.hand.length, handBefore - 1 + 1);
		assert.equal(alice.library.length, libBefore - 1);
		noManualOrLegacy(state);
	});
});

describe('Step F: Arcane Denial-style delayed upkeep draws', () => {
	for (const c of [staple('Arcane Denial'), renamed(staple('Arcane Denial'), 'Quiet Refusal')]) {
		it(`${c.name}: counters the spell; at the next upkeep its controller draws (up to) two and you draw one`, () => {
			const { state, p } = game([false, true]);
			for (const pl of p) pl.hand = [];
			const [alice, bob] = p;
			for (const pl of p) for (let i = 0; i < 6; i++) put(state, pl, filler(`${pl.username} Library ${i}`), 'library');
			// Bob's spell is on the stack; Alice counters it.
			const bobSpell = put(state, bob, card({ name: 'Bob Sorcery', typeLine: 'Instant', oracleText: 'Draw a card.' }), 'hand');
			state.priorityPlayerIndex = 1;
			cast(state, bob, bobSpell);
			state.priorityPlayerIndex = 0;
			const denial = put(state, alice, c, 'hand');
			const stackItem = state.stack[state.stack.length - 1];
			const res = applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: denial.instanceId,
				targets: [{ kind: 'stack', id: stackItem.id, label: stackItem.title }]
			});
			assert.equal(res.ok, true, res.error ?? '');
			settle(state);
			assert.ok(bob.graveyard.some((g) => g.instanceId === bobSpell.instanceId), 'the spell was countered');
			assert.equal(state.delayedTriggers?.length ?? 0, 2, 'two delayed triggers wait for the next upkeep');
			const aliceHand = alice.hand.length;
			const bobHand = bob.hand.length;
			passUntil(state, 'upkeep');
			settle(state);
			if (process.env.DBG) console.log(state.log.slice(-25).map((l) => l.text).join('\n'), JSON.stringify(state.delayedTriggers), state.phase, state.stack.length);
			// Bob (a bot) draws two; Alice draws one. Bob's turn: Bob also has a turn-based draw later.
			assert.equal(bob.hand.length, bobHand + 2, 'the countered spell\'s controller drew two');
			assert.equal(alice.hand.length, aliceHand + 1, 'Arcane Denial\'s controller drew one');
			assert.equal(state.delayedTriggers?.length ?? 0, 0);
			noManualOrLegacy(state);
		});
	}
});

describe('Step F: "may draw up to two" asks a human how many', () => {
	it('the countered spell\'s human controller chooses the number at the next upkeep (after a JSON round trip)', () => {
		let { state, p } = game([false, false]);
		for (const pl of p) pl.hand = [];
		const [alice, bob] = p;
		for (const pl of p) for (let i = 0; i < 6; i++) put(state, pl, filler(`${pl.username} Library ${i}`), 'library');
		const bobSpell = put(state, bob, card({ name: 'Bob Sorcery', typeLine: 'Instant', oracleText: 'Draw a card.' }), 'hand');
		state.priorityPlayerIndex = 1;
		cast(state, bob, bobSpell);
		state.priorityPlayerIndex = 0;
		const denial = put(state, alice, renamed(staple('Arcane Denial'), 'Quiet Refusal'), 'hand');
		const top = state.stack[state.stack.length - 1];
		assert.equal(applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: denial.instanceId, targets: [{ kind: 'stack', id: top.id, label: top.title }] }).ok, true);
		settle(state);
		passUntil(state, 'upkeep');
		settle(state);
		const prompt = state.pendingPrompts.find((pr) => pr.playerId === bob.playerId);
		assert.ok(prompt, 'Bob is asked');
		assert.equal(prompt.choice?.kind, 'chooseNumber');
		state = roundTrip(state);
		const res = applyGameAction(state, bob.playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'chooseNumber', n: 1 } });
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.players[1].hand.length, 1, 'Bob drew the one card he chose');
	});
});

describe('Step F: modal "Choose one or more" spells', () => {
	for (const c of [staple('Farewell'), renamed(staple('Farewell'), 'Clean Slate Dirge')]) {
		it(`${c.name}: only the chosen modes happen`, () => {
			const { state, p } = game();
			const [alice, bob] = p;
			const bear = put(state, bob, creatureCard('Bob Bear'), 'battlefield');
			const relic = put(state, bob, card({ name: 'Bob Relic', typeLine: 'Artifact' }), 'battlefield');
			put(state, bob, filler('Bob Graveyard Card'), 'graveyard');
			const spell = put(state, alice, c, 'hand');
			cast(state, alice, spell, [], [1, 3]); // creatures and graveyards
			settle(state);
			assert.ok(bob.exile.some((e) => e.instanceId === bear.instanceId), 'creatures exiled');
			assert.ok(bob.battlefield.some((b) => b.instanceId === relic.instanceId), 'artifacts stay');
			assert.equal(bob.graveyard.length, 0, 'graveyards exiled');
			noManualOrLegacy(state);
		});
	}

	it('a modal spell cast without modes is refused', () => {
		const { state, p } = game();
		const spell = put(state, p[0], staple('Farewell'), 'hand');
		const res = applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: spell.instanceId, targets: [] });
		assert.equal(res.ok, false);
	});

	for (const c of [staple('Casualties of War'), renamed(staple('Casualties of War'), 'Ruin of Many Things')]) {
		it(`${c.name}: each chosen mode destroys its own target`, () => {
			const { state, p } = game();
			const [alice, bob] = p;
			const bear = put(state, bob, creatureCard('Bob Bear'), 'battlefield');
			const relic = put(state, bob, card({ name: 'Bob Relic', typeLine: 'Artifact' }), 'battlefield');
			const charm = put(state, bob, card({ name: 'Bob Charm', typeLine: 'Enchantment' }), 'battlefield');
			const spell = put(state, alice, c, 'hand');
			cast(state, alice, spell, [ref(relic), ref(bear)], [0, 1]);
			settle(state);
			assert.ok(bob.graveyard.some((g) => g.instanceId === relic.instanceId), 'the artifact was destroyed');
			assert.ok(bob.graveyard.some((g) => g.instanceId === bear.instanceId), 'the creature was destroyed');
			assert.ok(bob.battlefield.some((b) => b.instanceId === charm.instanceId), 'the enchantment mode was not chosen');
			noManualOrLegacy(state);
		});
	}

	it('Casualties of War: a target that does not fit its mode is refused', () => {
		const { state, p } = game();
		const bear = put(state, p[1], creatureCard('Bob Bear'), 'battlefield');
		const spell = put(state, p[0], staple('Casualties of War'), 'hand');
		const res = applyGameAction(state, p[0].playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			targets: [ref(bear)],
			modes: [0]
		});
		assert.equal(res.ok, false, 'a creature is not a legal target for "Destroy target artifact"');
	});

	it('a bot casts Casualties of War choosing modes with legal targets', () => {
		const { state, p } = game([true]);
		const [alice, bob] = p;
		alice.hand = [];
		alice.command = [];
		bob.hand = [];
		const bear = put(state, bob, creatureCard('Bob Bear'), 'battlefield');
		const relic = put(state, bob, card({ name: 'Bob Relic', typeLine: 'Artifact' }), 'battlefield');
		put(state, alice, staple('Casualties of War'), 'hand');
		for (let i = 0; i < 6 && alice.hand.length > 0; i++) runAutomatedPriorityAndBots(state);
		settle(state);
		assert.ok(bob.graveyard.some((g) => g.instanceId === relic.instanceId));
		assert.ok(bob.graveyard.some((g) => g.instanceId === bear.instanceId));
		noManualOrLegacy(state);
	});
});

describe('Step F: Miirym-style "token copy, except it isn\'t legendary"', () => {
	for (const c of [staple('Miirym, Sentinel Wyrm'), renamed(staple('Miirym, Sentinel Wyrm'), 'Ysolde, Hoard Warden')]) {
		it(`${c.name}: a legendary Dragon entering makes a non-legendary token copy`, () => {
			const { state, p } = game([true]);
			const alice = p[0];
			put(state, alice, c, 'battlefield');
			const dragon = put(
				state,
				alice,
				card({ name: 'Elder Ember Wyrm', typeLine: 'Legendary Creature — Dragon', manaCost: '{3}', cmc: 3, power: '4', toughness: '4' }),
				'hand'
			);
			cast(state, alice, dragon);
			settle(state);
			const copies = alice.battlefield.filter((b) => b.isToken && b.card.name === 'Elder Ember Wyrm');
			assert.equal(copies.length, 1, 'one token copy');
			assert.ok(!copies[0].card.typeLine.includes('Legendary'), 'the token is not legendary');
			assert.ok(alice.battlefield.some((b) => !b.isToken && b.card.name === 'Elder Ember Wyrm'), 'the legend rule kept the original');
			noManualOrLegacy(state);
		});
	}
});

describe('Step F: Nether Shadow-style "you may put ~ onto the battlefield" from the graveyard', () => {
	for (const c of [staple('Nether Shadow'), renamed(staple('Nether Shadow'), 'Gloomtide Revenant')]) {
		it(`${c.name}: at upkeep, with three creature cards above it, a human may return it`, () => {
			let { state, p } = game();
			for (const pl of p) pl.hand = [];
			const alice = p[0];
			const shadow = put(state, alice, c, 'graveyard');
			for (let i = 0; i < 3; i++) put(state, alice, creatureCard(`Dead Bear ${i}`), 'graveyard');
			// Move to Alice's next upkeep: end this turn, then Bob's, then Alice's.
			passUntil(state, 'end_step');
			passUntil(state, 'upkeep'); // Bob's upkeep
			passUntil(state, 'end_step');
			passUntil(state, 'upkeep'); // Alice's upkeep
			assert.equal(state.players[state.activePlayerIndex].playerId, alice.playerId);
			settle(state);
			const prompt = onlyPrompt(state);
			assert.equal(prompt.purpose, 'trigger_may');
			state = roundTrip(state);
			answerYesNo(state, state.pendingPrompts[0], true);
			settle(state);
			assert.ok(state.players[0].battlefield.some((b) => b.instanceId === shadow.instanceId), 'it returned');
			noManualOrLegacy(state);
		});
	}
});

describe("Step F: Thassa's Oracle-style dig and win check", () => {
	for (const c of [staple("Thassa's Oracle"), renamed(staple("Thassa's Oracle"), 'Seer of the Shallows')]) {
		it(`${c.name}: with devotion at least the library size, its controller wins`, () => {
			const { state, p } = game([true]);
			const alice = p[0];
			alice.library = [];
			put(state, alice, filler('Last Card A'), 'library');
			const oracle = put(state, alice, c, 'hand');
			cast(state, alice, oracle);
			settle(state);
			assert.ok(state.players.find((x) => x.playerId === p[1].playerId)!.lost || state.status === 'finished', 'Alice won');
			noManualOrLegacy(state);
		});

		it(`${c.name}: a human keeps up to one of the top X on top and the rest go to the bottom`, () => {
			let { state, p } = game();
			const alice = p[0];
			for (let i = 0; i < 8; i++) put(state, alice, filler(`Deep Card ${i}`), 'library');
			put(state, alice, card({ name: 'Blue Relic', typeLine: 'Artifact', manaCost: '{U}{U}', colors: ['U'] }), 'battlefield');
			const oracle = put(state, alice, c, 'hand');
			cast(state, alice, oracle);
			settle(state);
			// Devotion to blue: {U}{U} (the creature) + {U}{U} (the relic) = 4.
			const prompt = onlyPrompt(state);
			assert.equal(prompt.playerId, alice.playerId);
			const choice = prompt.choice;
			assert.ok(choice && choice.kind === 'chooseObjects');
			assert.equal(choice.candidates.length, 4);
			assert.equal(choice.min, 0);
			assert.equal(choice.max, 1);
			const looked = [...choice.candidates];
			state = roundTrip(state);
			answerObjects(state, state.pendingPrompts[0], [looked[2]]);
			settle(state);
			const a = state.players[0];
			assert.equal(a.library[0].instanceId, looked[2], 'the chosen card is on top');
			const bottom = a.library.slice(-3).map((x) => x.instanceId).sort();
			assert.deepEqual(bottom, looked.filter((id) => id !== looked[2]).sort(), 'the rest are on the bottom');
			assert.equal(state.status, 'active', 'no win: devotion 4 < library 8');
			noManualOrLegacy(state);
		});
	}
});

describe('Step F: The Ur-Dragon-style "draw that many, then you may put a permanent card from your hand onto the battlefield"', () => {
	for (const c of [staple('The Ur-Dragon'), renamed(staple('The Ur-Dragon'), 'The Primal Wyrm')]) {
		it(`${c.name}: a human draws, then chooses up to one permanent card to put onto the battlefield`, () => {
			let { state, p } = game();
			const [alice, bob] = p;
			for (let i = 0; i < 5; i++) put(state, alice, filler(`Library ${i}`), 'library');
			const ur = put(state, alice, c, 'battlefield');
			const other = put(state, alice, creatureCard('Small Drake', 'Dragon'), 'battlefield');
			alice.hand = [];
			const relic = put(state, alice, card({ name: 'Hand Relic', typeLine: 'Artifact' }), 'hand');
			put(state, alice, filler('Hand Sorcery'), 'hand');
			passUntil(state, 'declare_attackers');
			const res = applyGameAction(state, alice.playerId, {
				type: 'declare_attackers',
				assignments: [ur, other].map((a) => ({ attackerInstanceId: a.instanceId, defenderPlayerId: bob.playerId, defenderPlaneswalkerId: null }))
			});
			assert.equal(res.ok, true, res.error ?? '');
			settle(state);
			const prompt = onlyPrompt(state);
			const choice = prompt.choice;
			assert.ok(choice && choice.kind === 'chooseObjects');
			assert.equal(choice.min, 0);
			assert.equal(choice.max, 1);
			assert.ok(choice.candidates.includes(relic.instanceId), 'the artifact card is a candidate');
			assert.equal(state.players[0].hand.length, 2 + 2, 'drew two (two Dragons attacked)');
			state = roundTrip(state);
			answerObjects(state, state.pendingPrompts[0], [relic.instanceId]);
			settle(state);
			assert.ok(state.players[0].battlefield.some((b) => b.instanceId === relic.instanceId));
			noManualOrLegacy(state);
		});
	}
});
