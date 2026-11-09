import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	triggerResolutionCounts
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
 * Step C (ENGINE_ARCHITECTURE_PLAN.md, Phase 10 roadmap): triggered-ability effects run on the IR
 * interpreter (runtime/effects.ts), compiled by the effect grammar with event referents ("it",
 * "that creature", "that many", "the entering creature's power"). Each pattern is tested with a
 * synthetic card with an invented name; Lathril also with the real card. `triggerResolutionCounts`
 * shows which path ran, so these fail on the pre-step-C engine (every trigger was legacy).
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
		assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
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

/** Runs `fn` and returns how many triggered abilities resolved on each path. */
function paths(fn: () => void): { interpreter: number; legacy: number } {
	triggerResolutionCounts(true);
	fn();
	return triggerResolutionCounts(true);
}

describe('Step C: triggered abilities on the IR interpreter', () => {
	it('ETB draw: "When ~ enters, draw two cards, then each opponent loses 1 life" (synthetic)', () => {
		const { state, p } = game();
		const scholar = put(state, p[0], creature('Quillmere Scholar', 'When this creature enters, draw two cards. Each opponent loses 1 life.'), 'hand');
		const hand = p[0].hand.length;
		const life = p[1].life;
		const ran = paths(() => {
			cast(state, p[0], scholar);
			settle(state);
		});
		assert.equal(p[0].hand.length, hand - 1 + 2, 'drew two (the Scholar left the hand)');
		assert.equal(p[1].life, life - 1, 'opponent lost 1 life');
		assert.equal(ran.interpreter, 1);
		assert.equal(ran.legacy, 0);
	});

	it('"Whenever another creature you control enters, you gain 1 life" (synthetic, observer ETB)', () => {
		const { state, p } = game();
		put(state, p[0], creature('Vellum Warden', 'Whenever another creature you control enters, you gain 1 life.'), 'battlefield');
		const life = p[0].life;
		const ran = paths(() => {
			createTokenOnBoard(state, p[0], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
			settle(state);
			// An opponent's creature doesn't trigger it.
			createTokenOnBoard(state, p[1], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
			settle(state);
		});
		assert.equal(p[0].life, life + 1);
		assert.deepEqual(ran, { interpreter: 1, legacy: 0 });
	});

	it('"you gain life equal to the entering creature\'s power" reads the event object (synthetic)', () => {
		const { state, p } = game();
		put(state, p[0], creature('Brindle Augur', "Whenever another creature you control enters, you gain life equal to the entering creature's power."), 'battlefield');
		const life = p[0].life;
		const ran = paths(() => {
			createTokenOnBoard(state, p[0], { name: 'Beast', power: 3, toughness: 3, colors: ['G'], typeLine: 'Token Creature — Beast', keywords: [] });
			settle(state);
		});
		assert.equal(p[0].life, life + 3);
		assert.deepEqual(ran, { interpreter: 1, legacy: 0 });
	});

	for (const name of ['Lathril, Blade of the Elves', 'Thornwake Sovereign']) {
		it(`"create that many tokens" on combat damage uses the damage dealt (${name})`, () => {
			const { state, p } = game();
			const real = staple('Lathril, Blade of the Elves');
			const c = name === real.name ? real : { ...real, id: 'test_thornwake', name, oracleText: real.oracleText.replaceAll('Lathril', name) };
			const lathril = put(state, p[0], c, 'battlefield');
			lathril.counters['+1/+1'] = 1; // 3/4: deals 3
			const ran = paths(() => {
				attack(state, p[0], p[1], [lathril]);
				passUntil(state, 'main2');
				settle(state);
			});
			assert.equal(tokens(p[0], 'Elf Warrior'), 3);
			assert.ok(ran.interpreter >= 1, 'the combat damage trigger resolved on the interpreter');
			assert.equal(ran.legacy, 0);
		});
	}

	it('dies trigger uses last known information: "each opponent loses life equal to its power" (synthetic)', () => {
		const { state, p } = game();
		const brute = put(state, p[0], creature('Emberhusk Brute', 'When this creature dies, each opponent loses life equal to its power.'), 'battlefield');
		brute.counters['+1/+1'] = 2; // 4/4 on the battlefield; a 2/2 card in the graveyard
		const bolt = put(state, p[0], card({ name: 'Cinder Lance', manaCost: '{R}', typeLine: 'Instant', oracleText: 'Cinder Lance deals 5 damage to target creature.' }), 'hand');
		const life = p[1].life;
		const ran = paths(() => {
			cast(state, p[0], bolt, [{ kind: 'permanent', id: brute.instanceId, label: brute.card.name }]);
			settle(state);
		});
		assert.ok(p[0].graveyard.some((c) => c.card.name === 'Emberhusk Brute'), 'it died');
		assert.equal(p[1].life, life - 4, 'its power as it last existed on the battlefield (CR 608.2h)');
		assert.deepEqual(ran, { interpreter: 1, legacy: 0 });
	});

	it('Landfall: "Whenever a land you control enters, you gain 2 life" (synthetic)', () => {
		const { state, p } = game();
		put(state, p[0], creature('Mossgate Pilgrim', 'Landfall — Whenever a land you control enters, you gain 2 life.'), 'battlefield');
		const land = put(state, p[0], card({ name: 'Forest', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0, oracleText: '({T}: Add {G}.)' }), 'hand');
		const life = p[0].life;
		const ran = paths(() => {
			assert.equal(applyGameAction(state, p[0].playerId, { type: 'play_land', instanceId: land.instanceId }).ok, true);
			settle(state);
		});
		assert.equal(p[0].life, life + 2);
		assert.deepEqual(ran, { interpreter: 1, legacy: 0 });
	});

	it('cast trigger: "Whenever you cast a noncreature spell, create a 1/1 red Elemental creature token" (synthetic)', () => {
		const { state, p } = game();
		put(state, p[0], creature('Sparkwright Adept', 'Whenever you cast a noncreature spell, create a 1/1 red Elemental creature token.'), 'battlefield');
		const spell = put(state, p[0], card({ name: 'Idle Thought', manaCost: '{U}', typeLine: 'Instant', oracleText: 'Draw a card.' }), 'hand');
		const ran = paths(() => {
			cast(state, p[0], spell);
			settle(state);
		});
		assert.equal(tokens(p[0], 'Elemental'), 1);
		assert.equal(ran.interpreter, 1);
		assert.equal(ran.legacy, 0);
	});

	it('attack trigger: "Whenever a creature you control attacks, it gets +2/+0 until end of turn" (synthetic, "it" = the attacker)', () => {
		const { state, p } = game();
		put(state, p[0], card({ name: 'Warhorn of Veld', typeLine: 'Enchantment', oracleText: 'Whenever a creature you control attacks, it gets +2/+0 until end of turn.' }), 'battlefield');
		const bear = put(state, p[0], creature('Plain Bear', '', '2', '2', 'Bear'), 'battlefield');
		const life = p[1].life;
		const ran = paths(() => {
			attack(state, p[0], p[1], [bear]);
			passUntil(state, 'main2');
		});
		assert.equal(p[1].life, life - 4, 'the attacker dealt 4');
		assert.deepEqual(ran, { interpreter: 1, legacy: 0 });
	});

	it('"that player" in a combat damage trigger is the damaged player (synthetic)', () => {
		const { state, p } = game(3);
		const rogue = put(state, p[0], creature('Gloamstep Rogue', 'Whenever this creature deals combat damage to a player, that player loses 2 life.', '1', '1', 'Rogue'), 'battlefield');
		const life1 = p[1].life;
		const life2 = p[2].life;
		const ran = paths(() => {
			attack(state, p[0], p[2], [rogue]);
			passUntil(state, 'main2');
			settle(state);
		});
		assert.equal(p[2].life, life2 - 1 - 2, 'the damaged player lost 1 (combat) + 2');
		assert.equal(p[1].life, life1, 'the other opponent is untouched');
		assert.deepEqual(ran, { interpreter: 1, legacy: 0 });
	});
});
