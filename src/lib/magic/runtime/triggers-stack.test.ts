import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedPriorityAndBots } from '../ai.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	enterEndStep,
	MAX_TRIGGERS_PER_TURN
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

/**
 * Step D (ENGINE_ARCHITECTURE_PLAN.md, Phase 10 roadmap): every triggered ability uses the stack
 * (CR 603.3) except triggered mana abilities (CR 605.1b); targets are chosen as it's put on the
 * stack (CR 603.3d); a player orders their simultaneous triggers (CR 603.3b); "you may" is asked on
 * resolution. Every prompt is answered after a JSON round trip of the state, as the lobby server
 * does between requests. Synthetic cards with invented names throughout.
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

function creature(name: string, oracleText: string, power = '2', toughness = '2', subtype = 'Human'): ScryfallCard {
	return card({ name, manaCost: '{2}', cmc: 2, typeLine: `Creature — ${subtype}`, oracleText, power, toughness });
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
function game(players = 2, bots: boolean[] = []): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i], Boolean(bots[i])));
	const state = createInitialGameState(
		'LOBBY_TRG',
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

/** Whoever holds priority passes, until the stack is empty or a prompt is waiting. */
function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function cast(state: GameState, player: PlayerGameState, inst: CardInstance, targets: TargetRef[] = []): void {
	const res = applyGameAction(state, player.playerId, { type: 'cast_spell', instanceId: inst.instanceId, targets });
	assert.equal(res.ok, true, res.error ?? '');
}

function onBattlefield(pl: PlayerGameState, name: string): CardInstance {
	const found = pl.battlefield.find((c) => c.card.name === name);
	assert.ok(found, `${name} is on the battlefield`);
	return found;
}

/** Everyone passes (resolving anything on the stack) until the phase is `phase`. */
function passUntil(state: GameState, phase: GameState['phase'], max = 40): void {
	for (let i = 0; i < max && state.phase !== phase; i++) {
		if (state.pendingPrompts.length > 0) assert.fail(`unexpected prompt: ${state.pendingPrompts[0].title}`);
		const prio = state.players[state.priorityPlayerIndex];
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
	}
	assert.equal(state.phase, phase);
}

/** From main1 with an empty stack: go to declare attackers and attack `defender` with `attackers`. */
function attack(state: GameState, attacker: PlayerGameState, defender: PlayerGameState, attackers: CardInstance[]): void {
	passUntil(state, 'declare_attackers');
	const res = applyGameAction(state, attacker.playerId, {
		type: 'declare_attackers',
		assignments: attackers.map((a) => ({
			attackerInstanceId: a.instanceId,
			defenderPlayerId: defender.playerId,
			defenderPlaneswalkerId: null
		}))
	});
	assert.equal(res.ok, true, res.error ?? '');
}

const tokens = (pl: PlayerGameState, name: string) => pl.battlefield.filter((c) => c.isToken && c.card.name.includes(name)).length;

/** The lobby server reloads the state from JSON between requests. */
function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function pass(state: GameState): void {
	const prio = state.players[state.priorityPlayerIndex];
	assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
}

/** Passes until the object on top of the stack has resolved (and nothing more). */
function resolveTop(state: GameState): void {
	const top = state.stack[state.stack.length - 1];
	for (let i = 0; i < 8 && state.stack.includes(top) && state.pendingPrompts.length === 0; i++) pass(state);
}

const bear = (name = 'Plain Bear') => creature(name, '', '2', '2', 'Bear');
const relic = (name: string) => card({ name, typeLine: 'Artifact', manaCost: '{1}', oracleText: '' });
const ref = (c: CardInstance): TargetRef => ({ kind: 'permanent', id: c.instanceId, label: c.card.name });

describe('Step D: triggered abilities use the stack', () => {
	it('an ETB trigger waits on the stack; an opponent can respond by killing the source; it still resolves using LKI', () => {
		const { state, p } = game();
		const sage = put(state, p[0], creature('Duskmere Sage', 'When this creature enters, you gain life equal to its power.', '3', '3'), 'hand');
		cast(state, p[0], sage);
		resolveTop(state); // the creature spell resolves
		const onField = onBattlefield(p[0], 'Duskmere Sage');
		assert.equal(state.stack.length, 1, 'the ETB trigger is on the stack');
		assert.equal(state.stack[0].kind, 'triggered');
		assert.deepEqual(state.stack[0].targets, [], 'the event object is not a target');
		const life = p[0].life;
		// Alice passes; Bob responds with an instant that kills the source.
		pass(state);
		assert.equal(state.players[state.priorityPlayerIndex].playerId, p[1].playerId);
		const lance = put(state, p[1], card({ name: 'Cinder Lance', manaCost: '{R}', oracleText: 'Cinder Lance deals 5 damage to target creature.' }), 'hand');
		cast(state, p[1], lance, [ref(onField)]);
		resolveTop(state);
		assert.ok(p[0].graveyard.some((c) => c.card.name === 'Duskmere Sage'), 'the source died first');
		assert.equal(state.stack.length, 1, 'the trigger is still waiting');
		settle(state);
		assert.equal(p[0].life, life + 3, 'it resolved with the power the source last had (CR 113.7a, 608.2h)');
	});

	it('a targeted ETB trigger asks its human controller for a target (chooseObjects), surviving a JSON round trip', () => {
		let { state, p } = game();
		const a = put(state, p[1], relic('Brass Idol'), 'battlefield');
		const b = put(state, p[1], relic('Copper Censer'), 'battlefield');
		put(state, p[0], relic('Own Trinket'), 'battlefield');
		const drake = put(state, p[0], creature('Rustbiter Drake', 'When this creature enters, destroy target artifact an opponent controls.', '2', '2', 'Drake'), 'hand');
		cast(state, p[0], drake);
		resolveTop(state);
		assert.equal(state.stack.length, 1);
		const prompt = state.pendingPrompts[0];
		assert.ok(prompt, 'a target prompt');
		assert.equal(prompt.playerId, p[0].playerId);
		assert.equal(prompt.purpose, 'trigger_targets');
		assert.equal(prompt.choice?.kind, 'chooseObjects');
		assert.deepEqual([...(prompt.choice?.kind === 'chooseObjects' ? prompt.choice.candidates : [])].sort(), [a.instanceId, b.instanceId].sort(), "only the opponent's artifacts");
		state = roundTrip(state);
		p = state.players;
		const res = applyGameAction(state, p[0].playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'chooseObjects', objectIds: [b.instanceId] } });
		assert.equal(res.ok, true, res.error ?? '');
		assert.deepEqual(state.stack[0].targets.map((t) => t.id), [b.instanceId]);
		settle(state);
		assert.ok(p[1].graveyard.some((c) => c.card.name === 'Copper Censer'), 'the chosen artifact was destroyed');
		assert.ok(p[1].battlefield.some((c) => c.card.name === 'Brass Idol'), 'the other one was not');
		assert.ok(p[0].battlefield.some((c) => c.card.name === 'Own Trinket'));
	});

	it('a trigger with no legal targets is removed from the stack (CR 603.3d), with a log line', () => {
		const { state, p } = game();
		const drake = put(state, p[0], creature('Rustbiter Drake', 'When this creature enters, destroy target artifact an opponent controls.', '2', '2', 'Drake'), 'hand');
		cast(state, p[0], drake);
		resolveTop(state);
		assert.equal(state.stack.length, 0, 'nothing waits on the stack');
		assert.equal(state.pendingPrompts.length, 0);
		assert.ok(state.log.some((l) => /removed from the Stack: it has no legal targets \(CR 603\.3d\)/.test(l.text)));
	});

	it('a bot chooses its trigger target itself (an opponent\'s creature), with no prompt', () => {
		const { state, p } = game(2, [true, false]);
		const mine = put(state, p[0], bear('Bot Bear'), 'battlefield');
		const theirs = put(state, p[1], creature('Big Wurm', '', '6', '6', 'Wurm'), 'battlefield');
		put(state, p[0], creature('Gravecall Witch', 'Whenever another creature you control enters, destroy target creature.', '1', '1', 'Human'), 'battlefield');
		createTokenOnBoard(state, p[0], { name: 'Zombie', power: 2, toughness: 2, colors: ['B'], typeLine: 'Token Creature — Zombie', keywords: [] });
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 1);
		assert.deepEqual(state.stack[0].targets.map((t) => t.id), [theirs.instanceId]);
		settle(state);
		assert.ok(p[1].graveyard.some((c) => c.instanceId === theirs.instanceId));
		assert.ok(p[0].battlefield.some((c) => c.instanceId === mine.instanceId));
	});

	it('a targeted trigger whose only target became illegal does nothing (CR 608.2b)', () => {
		const { state, p } = game();
		const idol = put(state, p[1], relic('Brass Idol'), 'battlefield');
		const drake = put(state, p[0], creature('Rustbiter Drake', 'When this creature enters, destroy target artifact an opponent controls.', '2', '2', 'Drake'), 'hand');
		cast(state, p[0], drake);
		resolveTop(state);
		assert.deepEqual(state.stack[0]?.targets.map((t) => t.id), [idol.instanceId], 'the only legal target was chosen for the human');
		// Bob bounces the artifact in response, so the only target is gone.
		pass(state);
		const bounce = put(state, p[1], card({ name: 'Recall Gust', manaCost: '{U}', oracleText: "Return target artifact to its owner's hand." }), 'hand');
		cast(state, p[1], bounce, [ref(idol)]);
		resolveTop(state);
		assert.ok(p[1].hand.some((c) => c.card.name === 'Brass Idol'));
		settle(state);
		assert.equal(state.stack.length, 0);
		assert.ok(state.log.some((l) => /Rustbiter Drake .* was countered on resolution/.test(l.text)), 'it fizzled');
	});

	it('a human orders their simultaneous triggers (orderObjects), surviving a JSON round trip', () => {
		let { state, p } = game();
		put(state, p[0], creature('Vellum Warden', 'Whenever another creature you control enters, you gain 1 life.'), 'battlefield');
		put(state, p[0], creature('Inkwell Seer', 'Whenever another creature you control enters, draw a card.'), 'battlefield');
		createTokenOnBoard(state, p[0], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
		assert.equal(state.stack.length, 2);
		const prompt = state.pendingPrompts.find((x) => x.purpose === 'trigger_order');
		assert.ok(prompt, 'an order prompt');
		assert.equal(prompt.choice?.kind, 'orderObjects');
		const ids = prompt.choice?.kind === 'orderObjects' ? prompt.choice.objectIds : [];
		assert.deepEqual(ids, [state.stack[1].id, state.stack[0].id], 'listed top first');
		state = roundTrip(state);
		p = state.players;
		const wanted = [...ids].reverse(); // the bottom one should resolve first
		const res = applyGameAction(state, p[0].playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'orderObjects', topIds: wanted, bottomIds: [], shuffle: false } });
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.stack[state.stack.length - 1].id, wanted[0], 'the chosen first trigger is on top');
		assert.equal(state.stack[0].id, wanted[1]);
		const life = p[0].life;
		const hand = p[0].hand.length;
		settle(state);
		assert.equal(p[0].life, life + 1);
		assert.equal(p[0].hand.length, hand + 1);
	});

	it('a single trigger, or a bot\'s triggers, need no order prompt', () => {
		const { state, p } = game(2, [true, false]);
		put(state, p[0], creature('Vellum Warden', 'Whenever another creature you control enters, you gain 1 life.'), 'battlefield');
		put(state, p[0], creature('Inkwell Seer', 'Whenever another creature you control enters, draw a card.'), 'battlefield');
		createTokenOnBoard(state, p[0], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
		assert.equal(state.stack.length, 2);
		assert.equal(state.pendingPrompts.length, 0);
	});

	for (const yes of [false, true]) {
		it(`a "you may" trigger asks on resolution (yesNo) and is ${yes ? 'accepted' : 'declined'}, surviving a JSON round trip`, () => {
			let { state, p } = game();
			put(state, p[0], creature('Tidecall Scribe', 'Whenever another creature you control enters, you may draw a card.'), 'battlefield');
			createTokenOnBoard(state, p[0], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
			assert.equal(state.stack.length, 1);
			assert.equal(state.pendingPrompts.length, 0, 'nothing is asked when it triggers');
			const hand = p[0].hand.length;
			settle(state);
			const prompt = state.pendingPrompts[0];
			assert.ok(prompt, 'asked on resolution');
			assert.equal(prompt.purpose, 'trigger_may');
			assert.equal(prompt.choice?.kind, 'yesNo');
			assert.equal(state.stack.length, 1, 'the ability stays on the stack while its controller decides (CR 608.2n)');
			state = roundTrip(state);
			p = state.players;
			const res = applyGameAction(state, p[0].playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'yesNo', yes } });
			assert.equal(res.ok, true, res.error ?? '');
			assert.equal(state.stack.length, 0, 'it finished resolving');
			assert.equal(p[0].hand.length, hand + (yes ? 1 : 0));
		});
	}

	it('a bot answers "you may" itself', () => {
		const { state, p } = game(2, [true, false]);
		put(state, p[0], creature('Tidecall Scribe', 'Whenever another creature you control enters, you may draw a card.'), 'battlefield');
		createTokenOnBoard(state, p[0], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
		const hand = p[0].hand.length;
		settle(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p[0].hand.length, hand + 1);
	});

	it('a triggered mana ability resolves immediately, without the stack (CR 605.1b, 605.4a)', () => {
		const { state, p } = game();
		put(state, p[0], card({ name: 'Verdant Wellspring', typeLine: 'Enchantment', oracleText: 'Whenever you tap a land for mana, add {G}.' }), 'battlefield');
		const forest = put(state, p[0], card({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest', oracleText: '({T}: Add {G}.)' }), 'battlefield');
		p[0].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		const res = applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: forest.instanceId });
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.stack.length, 0, 'not on the stack');
		assert.equal(p[0].manaPool.G, 2, 'the land and the trigger each added {G}');
	});

	it('a delayed trigger goes on the stack at the end step and resolves from there (pin)', () => {
		const { state, p } = game();
		const target = put(state, p[0], bear('Borrowed Bear'), 'battlefield');
		state.delayedTriggers = [
			{
				id: 'dtrig_test',
				controllerId: p[0].playerId,
				sourceCard: card({ name: 'Ghastly Recall', typeLine: 'Sorcery' }),
				triggerPhase: 'end_step',
				targetInstanceId: target.instanceId,
				targetObjectVersion: target.objectVersion,
				title: 'Ghastly Recall — Delayed Exile Trigger',
				description: 'At the beginning of the next end step, exile Borrowed Bear.',
				effects: [{ kind: 'exile_target', amount: 1 }],
				createdAtTurn: state.turnNumber
			}
		];
		enterEndStep(state, p[0]);
		assert.ok(state.stack.some((s) => s.kind === 'triggered' && /Delayed/.test(s.title)), 'on the stack');
		assert.ok(p[0].battlefield.some((c) => c.instanceId === target.instanceId), 'not yet resolved');
		settle(state);
		assert.ok(p[0].exile.some((c) => c.card.name === 'Borrowed Bear'), 'exiled when it resolved');
	});

	it('triggers that fire while a spell resolves wait until it has finished (CR 603.3)', () => {
		const { state, p } = game();
		put(state, p[0], creature('Vellum Warden', 'Whenever another creature you control enters, you gain 1 life.'), 'battlefield');
		const spell = put(state, p[0], card({ name: 'Twin Sprouting', manaCost: '{G}', typeLine: 'Sorcery', oracleText: 'Create two 1/1 green Saproling creature tokens. You gain 5 life.' }), 'hand');
		const life = p[0].life;
		cast(state, p[0], spell);
		resolveTop(state);
		assert.equal(p[0].life, life + 5, 'the spell finished');
		assert.equal(state.stack.length, 2, 'both triggers are on the stack now, after the spell');
		// One human with two simultaneous triggers: answer the order prompt with the default order.
		const order = state.pendingPrompts.find((x) => x.purpose === 'trigger_order');
		if (order && order.choice?.kind === 'orderObjects') {
			applyGameAction(state, p[0].playerId, { type: 'choice', promptId: order.id, answer: { kind: 'orderObjects', topIds: order.choice.objectIds, bottomIds: [], shuffle: false } });
		}
		settle(state);
		assert.equal(p[0].life, life + 7);
	});

	it('a target-player trigger offers the players as candidates (3 players), surviving a JSON round trip', () => {
		let { state, p } = game(3);
		const hex = put(state, p[0], creature('Hexmire Crone', 'When this creature enters, target opponent loses 2 life.', '1', '1', 'Warlock'), 'hand');
		cast(state, p[0], hex);
		resolveTop(state);
		const prompt = state.pendingPrompts[0];
		assert.ok(prompt && prompt.purpose === 'trigger_targets');
		const candidates = prompt.choice?.kind === 'chooseObjects' ? prompt.choice.candidates : [];
		assert.deepEqual([...candidates].sort(), [p[1].playerId, p[2].playerId].sort(), 'both opponents, not the controller');
		state = roundTrip(state);
		p = state.players;
		const life1 = p[1].life;
		const life2 = p[2].life;
		const res = applyGameAction(state, p[0].playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'chooseObjects', objectIds: [p[2].playerId] } });
		assert.equal(res.ok, true, res.error ?? '');
		assert.deepEqual(state.stack[0].targets, [{ kind: 'player', id: p[2].playerId, label: p[2].username }]);
		settle(state);
		assert.equal(p[2].life, life2 - 2);
		assert.equal(p[1].life, life1);
	});

	it('a self-retriggering loop stops at the per-turn trigger cap, with a log line, and the bot loop terminates', () => {
		const { state, p } = game(2, [true, true]);
		put(state, p[0], creature('Endless Sporewright', 'Whenever another creature you control enters, create a 1/1 green Saproling creature token.', '1', '1', 'Fungus'), 'battlefield');
		createTokenOnBoard(state, p[0], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
		assert.equal(state.stack.length, 1, 'the loop starts');
		const turn = state.turnNumber;
		const capped = () => state.log.some((l) => /runaway trigger loop safety cap/.test(l.text));
		for (let i = 0; i < 100 && !capped() && state.turnNumber === turn && state.status === 'active'; i++) {
			runAutomatedPriorityAndBots(state, { maxSteps: 50 });
		}
		assert.ok(capped(), 'the cap was hit (with a log line) in the same turn');
		const saprolings = tokens(p[0], 'Saproling');
		assert.ok(saprolings >= MAX_TRIGGERS_PER_TURN && saprolings <= MAX_TRIGGERS_PER_TURN + 1, `${saprolings} tokens: one per allowed trigger`);
		// The bot loop keeps the game going: the stack empties and play continues.
		for (let i = 0; i < 20 && state.stack.length > 0; i++) runAutomatedPriorityAndBots(state, { maxSteps: 50 });
		assert.equal(state.stack.length, 0);
	});
});
