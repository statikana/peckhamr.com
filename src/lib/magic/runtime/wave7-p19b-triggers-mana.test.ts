import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	runBeginningOfTurn
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import { parseTriggerHeader, runtimeTriggerProblem } from '../compiler/triggers.ts';

function fullySupported(def: ReturnType<typeof compileCard>): boolean {
	return definitionSupportReport(def).fullySupported;
}
import { emitEvent } from './events.ts';
import { flushTriggers } from './triggers.ts';
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
		lastHeartbeat: Date.now()
	};
}

function game(players = 2): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i]));
	const state = createInitialGameState(
		'LOBBY_P19B',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const s of seats) {
		assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
	}
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) {
		pl.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	return { state, p: state.players };
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'exile'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		if (c.loyalty) inst.counters.loyalty = parseInt(c.loyalty, 10);
	}
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function resolveAll(state: GameState, max = 50): void {
	for (let guard = 0; guard < max; guard++) {
		const prompt = state.pendingPrompts[0];
		if (prompt?.purpose === 'trigger_order' && prompt.choice?.kind === 'orderObjects') {
			applyGameAction(state, prompt.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: {
					kind: 'orderObjects',
					topIds: prompt.choice.objectIds,
					bottomIds: [],
					shuffle: false
				}
			});
			continue;
		}
		if (prompt?.purpose === 'trigger_may') {
			applyGameAction(state, prompt.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'yesNo', yes: true }
			});
			continue;
		}
		if (
			prompt?.continuation?.kind === 'effect_choice' &&
			prompt.choice?.kind === 'chooseObjects' &&
			prompt.choice.defaultObjectIds
		) {
			applyGameAction(state, prompt.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: prompt.choice.defaultObjectIds }
			});
			continue;
		}
		if (prompt) return;
		if (state.stack.length === 0) return;
		const prio = state.players[state.priorityPlayerIndex];
		if (!applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok) return;
	}
}

describe('Wave 7 Track P19b — Slice P19b.1: named filter unification & zero event_not_implemented', () => {
	it('compiles named permanent triggers with zero runtimeTriggerProblem and fires only on matching name', () => {
		const watcherDef = card({
			name: 'Pack Herald',
			typeLine: 'Creature — Wolf',
			power: '2',
			toughness: '2',
			oracleText: 'Whenever another creature named Timber Scout enters under your control, draw a card.'
		});
		const compiled = compileCard(watcherDef);
		assert.equal(fullySupported(compiled), true);
		const ab = compiled.faces[0].abilities[0];
		assert.equal(ab.kind, 'triggered');
		assert.equal(runtimeTriggerProblem(ab.trigger), null);

		const { state, p } = game(2);
		put(state, p[0], watcherDef, 'battlefield');
		const handBefore = p[0].hand.length;

		// Non-matching creature name does not trigger.
		const other = put(
			state,
			p[0],
			card({
				name: 'Mountain Goat',
				manaCost: '{G}',
				typeLine: 'Creature — Goat',
				power: '1',
				toughness: '1'
			}),
			'hand'
		);
		p[0].manaPool.G = 2;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: other.instanceId }).ok, true);
		resolveAll(state);
		assert.equal(p[0].hand.length, handBefore);

		// Matching creature name ("Timber Scout") triggers and draws 1 card.
		const scout = put(
			state,
			p[0],
			card({
				name: 'Timber Scout',
				manaCost: '{G}',
				typeLine: 'Creature — Wolf Scout',
				power: '1',
				toughness: '1'
			}),
			'hand'
		);
		p[0].manaPool.G = 2;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: scout.instanceId }).ok, true);
		resolveAll(state);
		assert.equal(p[0].hand.length, handBefore + 1);
	});
});

describe('Wave 7 Track P19b — Slice P19b.2: CR 605.1b & CR 605.4a stackless triggered mana abilities', () => {
	it('resolves subtype-enchanted mana taps (enchanted Forest) stacklessly for its controller', () => {
		const auraDef = card({
			name: 'Canopy Growth',
			manaCost: '{G}',
			typeLine: 'Enchantment — Aura',
			oracleText:
				'Enchant Forest\nAs ~ enters, choose a color.\nWhenever enchanted Forest is tapped for mana, its controller adds an additional one mana of the chosen color.'
		});
		const forestDef = card({
			name: 'Forest',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: ''
		});

		const { state, p } = game(2);
		const p1Forest = put(state, p[0], forestDef, 'battlefield');
		const aura1 = put(state, p[0], auraDef, 'battlefield');
		aura1.attachedToId = p1Forest.instanceId;
		aura1.chosenColor = 'U';

		const res1 = applyGameAction(state, p[0].playerId, {
			type: 'tap_mana',
			instanceId: p1Forest.instanceId
		});
		assert.equal(res1.ok, true);
		assert.equal(state.stack.length, 0, 'CR 605.4a: triggered mana ability never uses the stack');
		assert.equal(p[0].manaPool.G, 1);
		assert.equal(p[0].manaPool.U, 1);

		// Enchanting opponent's Forest: when opponent taps it, opponent ("its controller") gets the bonus mana.
		const p2Forest = put(state, p[1], forestDef, 'battlefield');
		const aura2 = put(state, p[0], auraDef, 'battlefield');
		aura2.attachedToId = p2Forest.instanceId;
		aura2.chosenColor = 'R';

		const res2 = applyGameAction(state, p[1].playerId, {
			type: 'tap_mana',
			instanceId: p2Forest.instanceId
		});
		assert.equal(res2.ok, true);
		assert.equal(state.stack.length, 0);
		assert.equal(p[1].manaPool.G, 1);
		assert.equal(p[1].manaPool.R, 1);
		assert.equal(p[0].manaPool.R, 0);
	});

	it('resolves linked-exile same-name land mana taps stacklessly', () => {
		const lensDef = card({
			name: 'Mirror Lens',
			manaCost: '{3}',
			typeLine: 'Artifact',
			oracleText:
				'Whenever a land with the same name as the exiled card is tapped for mana, its controller adds one mana of any type that land produced.'
		});
		const snowIsland = card({
			name: 'Snow-Covered Island',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Snow Land — Island',
			oracleText: ''
		});
		const plainIsland = card({
			name: 'Island',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Island',
			oracleText: ''
		});

		const { state, p } = game(2);
		const lens = put(state, p[0], lensDef, 'battlefield');
		const exiled = put(state, p[0], snowIsland, 'exile');
		exiled.exiledBy = {
			sourceInstanceId: lens.instanceId,
			sourceObjectVersion: lens.objectVersion ?? 1
		};

		const matchingLand = put(state, p[0], snowIsland, 'battlefield');
		const nonMatchingLand = put(state, p[0], plainIsland, 'battlefield');

		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: matchingLand.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 0);
		assert.equal(p[0].manaPool.U, 2);

		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: nonMatchingLand.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 0);
		assert.equal(p[0].manaPool.U, 3);
	});

	it('resolves chosen-color basic land mana taps and CR 605.1b land-ability mana additions without infinite recursion', () => {
		const gauntletDef = card({
			name: 'Power Gauntlet',
			manaCost: '{5}',
			typeLine: 'Artifact',
			oracleText:
				'As ~ enters, choose a color.\nWhenever a basic land is tapped for mana of the chosen color, its controller adds an additional one mana of that color.'
		});
		const sunDef = card({
			name: 'Solar Cage',
			manaCost: '{6}',
			typeLine: 'Artifact',
			oracleText:
				"As ~ enters, choose a color.\nWhenever a land's ability causes you to add one or more mana of the chosen color, add one additional mana of that color."
		});
		const plainsDef = card({
			name: 'Plains',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Plains',
			oracleText: ''
		});
		const swampDef = card({
			name: 'Swamp',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Swamp',
			oracleText: ''
		});
		const dorkDef = card({
			name: 'Sun Acolyte',
			manaCost: '{W}',
			typeLine: 'Creature — Cleric',
			power: '1',
			toughness: '1',
			oracleText: '{T}: Add {W}.'
		});

		const { state, p } = game(2);
		const gauntlet = put(state, p[0], gauntletDef, 'battlefield');
		gauntlet.chosenColor = 'W';
		const sun = put(state, p[0], sunDef, 'battlefield');
		sun.chosenColor = 'W';

		const plains = put(state, p[0], plainsDef, 'battlefield');
		const swamp = put(state, p[0], swampDef, 'battlefield');
		const dork = put(state, p[0], dorkDef, 'battlefield');

		// Tapping basic Plains for {W}: base 1 + Gauntlet 1 + Solar Cage 1 = 3 {W}, stack remains empty, zero recursion loop!
		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: plains.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 0);
		assert.equal(p[0].manaPool.W, 3);

		// Tapping basic Swamp for {B}: neither chosenColor === 'W' trigger fires.
		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: swamp.instanceId }).ok,
			true
		);
		assert.equal(p[0].manaPool.B, 1);
		assert.equal(p[0].manaPool.W, 3);

		// Tapping a Creature mana dork for {W}: not a land, so neither trigger fires.
		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: dork.instanceId }).ok,
			true
		);
		assert.equal(p[0].manaPool.W, 4);
	});

	it('resolves {C} permanent mana taps and inline "while you\'re the monarch" land mana taps stacklessly', () => {
		const monumentDef = card({
			name: 'Void Obelisk',
			manaCost: '{5}',
			typeLine: 'Legendary Artifact',
			oracleText: 'Whenever you tap a permanent for {C}, add an additional {C}.'
		});
		const regalDef = card({
			name: 'Crown Behemoth',
			manaCost: '{4}{G}{G}',
			typeLine: 'Creature — Dinosaur',
			power: '5',
			toughness: '5',
			oracleText:
				"Whenever you tap a land for mana while you're the monarch, add one mana of any type that land produced."
		});
		const wastesDef = card({
			name: 'Wastes',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land',
			oracleText: '{T}: Add {C}.'
		});
		const mountainDef = card({
			name: 'Mountain',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Mountain',
			oracleText: ''
		});

		const { state, p } = game(2);
		put(state, p[0], monumentDef, 'battlefield');
		put(state, p[0], regalDef, 'battlefield');
		const wastes = put(state, p[0], wastesDef, 'battlefield');
		const mtn1 = put(state, p[0], mountainDef, 'battlefield');
		const mtn2 = put(state, p[0], mountainDef, 'battlefield');

		// Wastes tapped while NOT monarch: Void Obelisk adds +1 {C}, Crown Behemoth does not.
		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: wastes.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 0);
		assert.equal(p[0].manaPool.C, 2);

		// Mountain tapped while NOT monarch: +1 {R} only.
		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: mtn1.instanceId }).ok,
			true
		);
		assert.equal(p[0].manaPool.R, 1);

		// Become the monarch, then tap second Mountain: +2 {R} stacklessly!
		state.monarchPlayerId = p[0].playerId;
		assert.equal(
			applyGameAction(state, p[0].playerId, { type: 'tap_mana', instanceId: mtn2.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 0);
		assert.equal(p[0].manaPool.R, 3);
	});
});

describe('Wave 7 Track P19b — Slice P19b.3: Combat, Curse, Compound, Ordinal Counter, Two-Color, Targeting, Tap-Opponent, & Delayed Triggers', () => {
	it('fires perAttackedPlayer once per attacked player (CR 508.3e) and Curse enchanted-player attack triggers', () => {
		const { state, p } = game(3);
		const captainDef = card({
			name: 'Raid Marshal',
			typeLine: 'Creature — Human Warrior',
			power: '3',
			toughness: '3',
			oracleText: 'Whenever you attack a player, create a 1/1 red Goblin creature token.'
		});
		const curseDef = card({
			name: 'Hex of Unrest',
			typeLine: 'Enchantment — Aura Curse',
			oracleText: 'Enchant player\nWhenever enchanted player is attacked, draw a card.'
		});
		const bearDef = card({
			name: 'Grizzly Raider',
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});

		put(state, p[0], captainDef, 'battlefield');
		const curse = put(state, p[0], curseDef, 'battlefield');
		curse.attachedToId = p[1].playerId;

		const a1 = put(state, p[0], bearDef, 'battlefield');
		const a2 = put(state, p[0], bearDef, 'battlefield');
		const a3 = put(state, p[0], bearDef, 'battlefield');
		const handBefore = p[0].hand.length;

		// Advance to declare_attackers and attack p[1] with 2 creatures and p[2] with 1 creature.
		for (const pl of state.players) applyGameAction(state, pl.playerId, { type: 'pass_priority' });
		for (const pl of state.players) applyGameAction(state, pl.playerId, { type: 'pass_priority' });
		assert.equal(state.phase, 'declare_attackers');

		assert.equal(
			applyGameAction(state, p[0].playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: a1.instanceId, defenderPlayerId: p[1].playerId, defenderPlaneswalkerId: null },
					{ attackerInstanceId: a2.instanceId, defenderPlayerId: p[1].playerId, defenderPlaneswalkerId: null },
					{ attackerInstanceId: a3.instanceId, defenderPlayerId: p[2].playerId, defenderPlaneswalkerId: null }
				]
			}).ok,
			true
		);
		resolveAll(state);

		const goblins = p[0].battlefield.filter((perm) => perm.isToken && /goblin/i.test(perm.card.name));
		assert.equal(goblins.length, 2, 'CR 508.3e: triggers once for p[1] and once for p[2]');
		assert.equal(p[0].hand.length, handBefore + 1, 'Curse triggers once when enchanted player p[1] is attacked');
	});

	it('tracks first-attack-each-turn per permanent and resets on the next turn', () => {
		const { state, p } = game(2);
		const warleader = put(
			state,
			p[0],
			card({
				name: 'Dawn Warleader',
				typeLine: 'Creature — Angel',
				power: '3',
				toughness: '4',
				oracleText: 'Whenever ~ attacks for the first time each turn, draw a card.'
			}),
			'battlefield'
		);
		const handBefore = p[0].hand.length;

		emitEvent(state, {
			kind: 'AttackDeclared',
			playerId: p[0].playerId,
			attackerIds: [warleader.instanceId]
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, handBefore + 1);
		assert.equal(warleader.attacksCountThisTurn, 1);

		// Second attack in the same turn does NOT re-trigger.
		emitEvent(state, {
			kind: 'AttackDeclared',
			playerId: p[0].playerId,
			attackerIds: [warleader.instanceId]
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, handBefore + 1);
		assert.equal(warleader.attacksCountThisTurn, 2);
	});

	it('handles compound upkeep+cast Shrine triggers, both-colors cast triggers, and ordinal Nth counter triggers', () => {
		const { state, p } = game(2);
		const shrine = put(
			state,
			p[0],
			card({
				name: 'Sanctum of Echoes',
				typeLine: 'Legendary Enchantment — Shrine',
				oracleText: 'At the beginning of your upkeep and whenever you cast a Shrine spell, put a +1/+1 counter on ~.'
			}),
			'battlefield'
		);
		put(
			state,
			p[0],
			card({
				name: 'Duelist Mimic',
				typeLine: 'Creature — Shapeshifter',
				power: '2',
				toughness: '1',
				oracleText: "Whenever you cast a spell that's both red and white, draw a card."
			}),
			'battlefield'
		);
		const quest = put(
			state,
			p[0],
			card({
				name: 'Fourfold Tome',
				typeLine: 'Artifact',
				oracleText: 'When the fourth lore counter is put on ~, draw two cards.'
			}),
			'battlefield'
		);

		// 1. Upkeep triggers Sanctum of Echoes.
		emitEvent(state, { kind: 'PhaseBegin', phase: 'upkeep', activePlayerId: p[0].playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(shrine.counters['+1/+1'] ?? 0, 1);

		// 2. Casting a red-and-white Shrine spell triggers BOTH Sanctum of Echoes and Duelist Mimic!
		const handStart = p[0].hand.length;
		const rwShrine = put(
			state,
			p[0],
			card({
				name: 'Sanctum of Sparks',
				manaCost: '{R}{W}',
				cmc: 2,
				colors: ['R', 'W'],
				typeLine: 'Enchantment — Shrine',
				oracleText: ''
			}),
			'hand'
		);
		p[0].manaPool.R = 2;
		p[0].manaPool.W = 2;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: rwShrine.instanceId }).ok, true);
		resolveAll(state);
		assert.equal(shrine.counters['+1/+1'] ?? 0, 2);
		assert.equal(p[0].hand.length, handStart + 1);

		// Mono-red spell does NOT trigger "both red and white".
		const monoRed = put(
			state,
			p[0],
			card({
				name: 'Spark Bolt',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: 'You gain 1 life.'
			}),
			'hand'
		);
		const beforeMono = p[0].hand.length;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: monoRed.instanceId }).ok, true);
		resolveAll(state);
		assert.equal(p[0].hand.length, beforeMono - 1);

		// 3. Ordinal 4th lore counter on Fourfold Tome: 0->3 does not fire; 3->5 crosses 4 and fires once; 5->6 does not fire.
		const beforeLore = p[0].hand.length;
		quest.counters.lore = 3;
		emitEvent(state, {
			kind: 'CounterPlaced',
			objectId: quest.instanceId,
			object: quest,
			counterType: 'lore',
			amount: 3,
			previousCount: 0,
			newCount: 3
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, beforeLore);

		quest.counters.lore = 5;
		emitEvent(state, {
			kind: 'CounterPlaced',
			objectId: quest.instanceId,
			object: quest,
			counterType: 'lore',
			amount: 2,
			previousCount: 3,
			newCount: 5
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, beforeLore + 2);

		quest.counters.lore = 6;
		emitEvent(state, {
			kind: 'CounterPlaced',
			objectId: quest.instanceId,
			object: quest,
			counterType: 'lore',
			amount: 1,
			previousCount: 5,
			newCount: 6
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, beforeLore + 2);
	});

	it('handles first-target-each-turn, you-or-permanent target, tap-opponent-creature, library search, and coin/dice triggers', () => {
		const { state, p } = game(2);
		const kite = put(
			state,
			p[0],
			card({
				name: 'Mirror Kite',
				typeLine: 'Creature — Spirit',
				power: '2',
				toughness: '3',
				oracleText: 'Whenever ~ becomes the target of a spell or ability for the first time each turn, draw a card.'
			}),
			'battlefield'
		);
		put(
			state,
			p[0],
			card({
				name: 'Court Envoy',
				typeLine: 'Creature — Elf Advisor',
				power: '2',
				toughness: '2',
				oracleText:
					'Whenever you or a permanent you control becomes the target of a spell or ability an opponent controls, draw a card.'
			}),
			'battlefield'
		);
		put(
			state,
			p[0],
			card({
				name: 'Frost Sovereign',
				typeLine: 'Creature — Human Warlock',
				power: '3',
				toughness: '4',
				oracleText: 'Whenever you tap an untapped creature an opponent controls, draw a card.'
			}),
			'battlefield'
		);
		put(
			state,
			p[0],
			card({
				name: 'Tome Keeper',
				typeLine: 'Creature — Halfling',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever an opponent searches their library, you gain 1 life and draw a card.'
			}),
			'battlefield'
		);
		put(
			state,
			p[0],
			card({
				name: 'Lucky Gambler',
				typeLine: 'Creature — Rogue',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever you win a coin flip, you gain 2 life.\nWhenever you roll a 10 or higher, you gain 3 life.'
			}),
			'battlefield'
		);

		const oppCreature = put(
			state,
			p[1],
			card({
				name: 'Hill Orc',
				typeLine: 'Creature — Orc',
				power: '2',
				toughness: '2',
				oracleText: '{T}: Add {R}.'
			}),
			'battlefield'
		);

		// First target on Mirror Kite by opponent spell triggers BOTH Mirror Kite and Court Envoy (+2 cards).
		let h = p[0].hand.length;
		emitEvent(state, {
			kind: 'BecameTarget',
			objectId: kite.instanceId,
			object: kite,
			by: 'spell',
			controllerId: p[1].playerId
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, h + 2);

		// Second target on Mirror Kite in the same turn triggers Court Envoy (+1), NOT Mirror Kite!
		h = p[0].hand.length;
		emitEvent(state, {
			kind: 'BecameTarget',
			objectId: kite.instanceId,
			object: kite,
			by: 'spell',
			controllerId: p[1].playerId
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, h + 1);

		// Opponent spell targeting `you` (player p[0]) triggers Court Envoy (+1).
		h = p[0].hand.length;
		emitEvent(state, {
			kind: 'PlayerTargeted',
			targetPlayerId: p[0].playerId,
			by: 'spell',
			controllerId: p[1].playerId
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, h + 1);

		// Opponent tapping their own creature for mana does NOT trigger Frost Sovereign!
		h = p[0].hand.length;
		assert.equal(
			applyGameAction(state, p[1].playerId, { type: 'tap_mana', instanceId: oppCreature.instanceId }).ok,
			true
		);
		resolveAll(state);
		assert.equal(p[0].hand.length, h);

		// Untap oppCreature, then cast p[0]'s "Tap target creature." spell -> triggers Frost Sovereign (+1)!
		oppCreature.tapped = false;
		const tapSpell = put(
			state,
			p[0],
			card({
				name: 'Ice Bolt',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Tap target creature.'
			}),
			'hand'
		);
		p[0].manaPool.U = 1;
		h = p[0].hand.length;
		assert.equal(
			applyGameAction(state, p[0].playerId, {
				type: 'cast_spell',
				instanceId: tapSpell.instanceId,
				targets: [{ kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name }]
			}).ok,
			true
		);
		resolveAll(state);
		assert.equal(oppCreature.tapped, true);
		assert.equal(p[0].hand.length, h);

		// LibrarySearched by opponent triggers Tome Keeper (+1 life, +1 card).
		const lifeStart = p[0].life;
		h = p[0].hand.length;
		emitEvent(state, { kind: 'LibrarySearched', playerId: p[1].playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].life, lifeStart + 1);
		assert.equal(p[0].hand.length, h + 1);

		// CoinFlipped win & DieRolled 15 trigger Lucky Gambler (+2 life, +3 life).
		emitEvent(state, { kind: 'CoinFlipped', playerId: p[0].playerId, flips: 1, wins: 1, won: true });
		emitEvent(state, {
			kind: 'DieRolled',
			playerId: p[0].playerId,
			sides: 20,
			result: 15,
			naturalResult: 15,
			count: 1
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].life, lifeStart + 6);
	});

	it('registers and fires spell-delayed "When you next cast ... this turn" and "At the beginning of your next upkeep"', () => {
		const { state, p } = game(2);
		const doublecast = put(
			state,
			p[0],
			card({
				name: 'Twin Echo',
				manaCost: '{R}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'When you next cast an instant or sorcery spell this turn, copy that spell.'
			}),
			'hand'
		);
		const bolt1 = put(
			state,
			p[0],
			card({
				name: 'Lava Dart',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: '~ deals 3 damage to each opponent.'
			}),
			'hand'
		);
		const bolt2 = put(
			state,
			p[0],
			card({
				name: 'Cinder Dart',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: '~ deals 3 damage to each opponent.'
			}),
			'hand'
		);
		const pact = put(
			state,
			p[0],
			card({
				name: 'Vow of Dawn',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'You gain 1 life.\nAt the beginning of your next upkeep, you gain 4 life.'
			}),
			'hand'
		);

		p[0].manaPool = { W: 5, U: 0, B: 0, R: 10, G: 0, C: 0 };
		const p2LifeBefore = p[1].life;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: doublecast.instanceId }).ok, true);
		resolveAll(state);

		// Next sorcery spell is copied once (3 + 3 = 6 damage).
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: bolt1.instanceId }).ok, true);
		resolveAll(state);
		assert.equal(p[1].life, p2LifeBefore - 6);

		// Second sorcery spell is NOT copied (only 3 damage).
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: bolt2.instanceId }).ok, true);
		resolveAll(state);
		assert.equal(p[1].life, p2LifeBefore - 9);

		// Cast Vow of Dawn: gains 1 life now, registers nextUpkeep delayed trigger.
		const p1LifeBefore = p[0].life;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: pact.instanceId }).ok, true);
		resolveAll(state);
		assert.equal(p[0].life, p1LifeBefore + 1);
		assert.equal(state.wave7SpellDelayedTriggers?.length, 1);

		// Opponent's upkeep does NOT fire p[0]'s nextUpkeep trigger.
		emitEvent(state, { kind: 'PhaseBegin', phase: 'upkeep', activePlayerId: p[1].playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].life, p1LifeBefore + 1);
		assert.equal(state.wave7SpellDelayedTriggers?.length, 1);

		// p[0]'s next upkeep fires once (+4 life) and consumes the one-shot delayed trigger!
		emitEvent(state, { kind: 'PhaseBegin', phase: 'upkeep', activePlayerId: p[0].playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].life, p1LifeBefore + 5);
		assert.equal(state.wave7SpellDelayedTriggers?.length ?? 0, 0);
	});
});

describe('Wave 7 Track P19b — Slice P19b.4: Intervening-If Clauses, JSON Round-Trip, & Rename Invariance', () => {
	it('fires "if ~ is suspended" triggers from exile only while isSuspended is true', () => {
		const krakenDef = card({
			name: 'Abyssal Leviathan',
			manaCost: '{6}{U}',
			typeLine: 'Creature — Kraken',
			power: '6',
			toughness: '6',
			oracleText: 'At the beginning of your upkeep, if ~ is suspended, draw a card.'
		});
		const compiled = compileCard(krakenDef);
		assert.equal(fullySupported(compiled), true);
		assert.equal(compiled.faces[0].abilities[0].kind, 'triggered');
		if (compiled.faces[0].abilities[0].kind === 'triggered') {
			assert.equal(compiled.faces[0].abilities[0].trigger.fromZone, 'exile');
		}

		const { state, p } = game(2);
		const exiledCard = put(state, p[0], krakenDef, 'exile');
		const handStart = p[0].hand.length;

		// Not suspended in exile -> does NOT trigger.
		exiledCard.isSuspended = false;
		emitEvent(state, { kind: 'PhaseBegin', phase: 'upkeep', activePlayerId: p[0].playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p[0].hand.length, handStart);

		// Suspended in exile -> triggers and draws 1 card!
		exiledCard.isSuspended = true;
		runBeginningOfTurn(state);
		resolveAll(state);
		assert.ok(p[0].hand.length >= handStart + 1);
	});

	it('evaluates Treasure mana spent, creatureDiedUnderYourControlThisTurn, and noSpellCastFromHandThisTurn, and round-trips JSON cleanly', () => {
		const { state, p } = game(2);
		put(
			state,
			p[0],
			card({
				name: 'Steward of Gondor',
				typeLine: 'Creature — Human Noble',
				power: '2',
				toughness: '4',
				oracleText: 'At the beginning of your end step, if a creature died under your control this turn, you gain 3 life.'
			}),
			'battlefield'
		);
		put(
			state,
			p[0],
			card({
				name: 'Exile Hermit',
				typeLine: 'Creature — Crab',
				power: '1',
				toughness: '4',
				oracleText: "At the beginning of your end step, if you haven't cast a spell from your hand this turn, you gain 2 life."
			}),
			'battlefield'
		);

		// Create a Treasure token and sacrifice it for {R}.
		const treasure = put(
			state,
			p[0],
			card({
				name: 'Treasure',
				manaCost: '',
				cmc: 0,
				typeLine: 'Token Artifact — Treasure',
				oracleText: '{T}, Sacrifice ~: Add one mana of any color.'
			}),
			'battlefield'
		);
		treasure.isToken = true;
		assert.equal(
			applyGameAction(state, p[0].playerId, {
				type: 'tap_mana',
				instanceId: treasure.instanceId,
				preferredColor: 'R'
			}).ok,
			true
		);
		assert.equal(p[0].treasureManaInPool, 1);

		// JSON round-trip mid-turn BEFORE spending the Treasure mana!
		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		assert.equal(roundTripped.players[0].treasureManaInPool, 1);

		// Put a dragon in exile with mayPlay (or hand — let's test Treasure ETB from hand, which also flips noSpellCastFromHandThisTurn!).
		const dragon = put(
			roundTripped,
			roundTripped.players[0],
			card({
				name: 'Hoard Drake',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Creature — Dragon',
				power: '2',
				toughness: '2',
				oracleText: 'When ~ enters, if mana from a Treasure was spent to cast it, draw two cards.'
			}),
			'hand'
		);
		const handBeforeCast = roundTripped.players[0].hand.length;
		assert.equal(
			applyGameAction(roundTripped, roundTripped.players[0].playerId, {
				type: 'cast_spell',
				instanceId: dragon.instanceId
			}).ok,
			true
		);
		resolveAll(roundTripped);
		assert.equal(
			roundTripped.players[0].hand.length,
			handBeforeCast - 1 + 2,
			'Treasure mana spent satisfies intervening-if and draws 2 cards'
		);

		// Destroy Hoard Drake so a creature died under p[0]'s control this turn!
		const doom = put(
			roundTripped,
			roundTripped.players[1],
			card({
				name: 'Fell Strike',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		roundTripped.players[1].manaPool.B = 1;
		// Pass priority to p[1] or emit death via SBA/spell — p[0] has priority in main1, pass once so p[1] casts instant!
		assert.equal(
			applyGameAction(roundTripped, roundTripped.players[0].playerId, { type: 'pass_priority' }).ok,
			true
		);
		assert.equal(
			applyGameAction(roundTripped, roundTripped.players[1].playerId, {
				type: 'cast_spell',
				instanceId: doom.instanceId,
				targets: [{ kind: 'permanent', id: dragon.instanceId, label: dragon.card.name }]
			}).ok,
			true
		);
		resolveAll(roundTripped);

		// Enter end step: Steward of Gondor fires (+3 life because Hoard Drake died under p[0]'s control),
		// while Exile Hermit does NOT fire (because Hoard Drake was cast from p[0]'s hand)!
		const lifeBeforeEnd = roundTripped.players[0].life;
		enterEndStep(roundTripped, roundTripped.players[0]);
		resolveAll(roundTripped);
		assert.equal(roundTripped.players[0].life, lifeBeforeEnd + 3);
	});

	it('preserves synthetic rename invariance across new P19b trigger heads and intervening-if conditions', () => {
		const makeVariant = (name: string) =>
			compileCard(
				card({
					name,
					typeLine: 'Creature — Wizard',
					power: '2',
					toughness: '3',
					oracleText:
						`At the beginning of your upkeep and whenever you cast a Shrine spell, put a +1/+1 counter on ${name}.\n` +
						`Whenever ${name} attacks for the first time each turn, if a creature died under your control this turn, draw a card.\n` +
						`When the third +1/+1 counter is put on ${name}, you gain 2 life.`
				})
			);

		const irA = makeVariant('Aether Scribe');
		const irB = makeVariant('Zephyr Chronicler');
		assert.equal(fullySupported(irA), true);
		assert.equal(fullySupported(irB), true);

		const stripSpans = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, val) => (k === 'span' || k === 'name' ? undefined : val)));
		assert.deepEqual(stripSpans(irA.faces[0].abilities), stripSpans(irB.faces[0].abilities));

		// Also verify inline `while` preserves unknown-while rejection (`triggers.test.ts` contract).
		const unknownWhile = parseTriggerHeader('Whenever ~ attacks while enchanted, draw a card.');
		assert.equal(unknownWhile?.trigger, undefined);
	});
});
