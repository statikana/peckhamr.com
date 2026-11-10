import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkAbilityActivationLegality,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { evaluatePermanent, inspectCardContinuousBreakdown } from '../ruleTree.ts';
import { effectiveSpellManaCost } from './costs.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { matchesObjectFilter, objectPower, objectToughness } from './objectFilter.ts';
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
		id: `t3b_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{G}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['G'],
		colorIdentity: overrides.colorIdentity ?? ['G'],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
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

function makeSeat(i: number, username: string, isBot = false): LobbySeat {
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

function createTestGame(bots: [boolean, boolean] = [false, false]): GameState {
	const seats = [makeSeat(0, 'Alice', bots[0]), makeSeat(1, 'Bob', bots[1])];
	const state = createInitialGameState(
		'LOBBY_T3B',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		const wasBot = p.isBot;
		p.isBot = false;
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		p.isBot = wasBot;
	}
	assert.equal(state.phase, 'main1');
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	for (const p of state.players) {
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	return state;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'command' = 'battlefield',
	isCommander = false
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, isCommander, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		player.battlefield.push(inst);
		noteLayerInputsChanged(state);
	} else if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	return inst;
}

function settle(state: GameState, maxSteps = 20): void {
	for (let i = 0; i < maxSteps; i++) {
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			if (pr.choice?.kind === 'orderObjects') {
				assert.equal(
					applyGameAction(state, pr.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'orderObjects', topIds: pr.choice.objectIds }
					}).ok,
					true
				);
				continue;
			}
			break;
		}
		if (state.stack.length === 0) break;
		const pid = state.players[state.priorityPlayerIndex].playerId;
		assert.equal(applyGameAction(state, pid, { type: 'pass_priority' }).ok, true);
	}
}

describe('Tier 3 Track B — Item 4: Commander-specific IR queries (CR 903.3, 903.3d, 903.8, 702.124k)', () => {
	it('Background-style static ("Commander creatures you own get +2/+2 and have vigilance.") applies only to your commander creatures (CR 903.3, 702.124k)', () => {
		const state = createTestGame();
		const [alice, bob] = state.players;
		alice.battlefield = [];
		bob.battlefield = [];

		const bgCard = card({
			name: 'Veteran Background',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Legendary Enchantment — Background',
			oracleText: 'Commander creatures you own get +2/+2 and have vigilance.',
			colors: ['W']
		});
		const compiledBg = compileCard(bgCard);
		assert.equal(compiledBg.fullySupported, true, 'Background static should compile as fullySupported');

		putInZone(state, alice, bgCard, 'battlefield', false);

		const aliceCmd = putInZone(
			state,
			alice,
			card({
				name: 'Alice Commander',
				typeLine: 'Legendary Creature — Human Knight',
				power: '3',
				toughness: '3'
			}),
			'battlefield',
			true
		);
		const aliceNonCmd = putInZone(
			state,
			alice,
			card({
				name: 'Alice Squire',
				typeLine: 'Creature — Human Soldier',
				power: '2',
				toughness: '2'
			}),
			'battlefield',
			false
		);
		const bobCmd = putInZone(
			state,
			bob,
			card({
				name: 'Bob Commander',
				typeLine: 'Legendary Creature — Elf Warrior',
				power: '3',
				toughness: '3'
			}),
			'battlefield',
			true
		);

		const evAliceCmd = evaluatePermanent(state, aliceCmd);
		assert.equal(evAliceCmd.power, 5, 'Alice commander gets +2/+2 from Background');
		assert.equal(evAliceCmd.toughness, 5);
		assert.equal(
			evAliceCmd.activeKeywords.some((k) => k.toLowerCase() === 'vigilance'),
			true,
			'Alice commander gains vigilance'
		);

		const evAliceNonCmd = evaluatePermanent(state, aliceNonCmd);
		assert.equal(evAliceNonCmd.power, 2, 'Alice non-commander creature does not get Background buff');
		assert.equal(
			evAliceNonCmd.activeKeywords.some((k) => k.toLowerCase() === 'vigilance'),
			false
		);

		const evBobCmd = evaluatePermanent(state, bobCmd);
		assert.equal(evBobCmd.power, 3, 'Bob commander does not get Alice Background buff');
		assert.equal(
			evBobCmd.activeKeywords.some((k) => k.toLowerCase() === 'vigilance'),
			false
		);
	});

	it('free-cast permission ("If you control a commander, you may cast ~ without paying its mana cost.") requires controlling a commander on the battlefield (CR 903.3d)', () => {
		const state = createTestGame();
		const [alice, bob] = state.players;
		alice.battlefield = [];
		bob.battlefield = [];
		alice.command = [];

		const freeSpellCard = card({
			name: 'Commander Ward Bolt',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText:
				'If you control a commander, you may cast ~ without paying its mana cost.\n~ deals 3 damage to any target.',
			colors: ['R'],
			power: undefined,
			toughness: undefined
		});
		const compiledFree = compileCard(freeSpellCard);
		assert.equal(compiledFree.fullySupported, true, 'Free commander spell should compile as fullySupported');

		const cmdCard = card({
			name: 'Alice Warlord',
			manaCost: '{3}{R}',
			cmc: 4,
			typeLine: 'Legendary Creature — Human Warrior',
			power: '4',
			toughness: '4'
		});
		// Commander in command zone (not on battlefield): cost is still {2}{R}, cannot cast with 0 mana
		const cmdInCommand = putInZone(state, alice, cmdCard, 'command', true);
		const spellInHand = putInZone(state, alice, freeSpellCard, 'hand', false);

		const costWithoutCmd = effectiveSpellManaCost(state, alice, spellInHand);
		assert.equal(costWithoutCmd.totalCmc, 3, 'Cost is 3 when commander is only in the command zone');

		const failCast = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: spellInHand.instanceId,
			targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
		});
		assert.equal(failCast.ok, false, 'Cannot cast without mana when no commander is on the battlefield');

		// Put commander on Alice's battlefield: cost becomes {0}, can cast with 0 mana!
		alice.command = alice.command.filter((c) => c.instanceId !== cmdInCommand.instanceId);
		cmdInCommand.zone = 'battlefield';
		alice.battlefield.push(cmdInCommand);
		noteLayerInputsChanged(state);

		const costWithCmd = effectiveSpellManaCost(state, alice, spellInHand);
		assert.equal(costWithCmd.totalCmc, 0, 'Cost becomes 0 when controlling a commander on the battlefield');

		const bobLifeBefore = bob.life;
		const okCast = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: spellInHand.instanceId,
			targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
		});
		assert.equal(okCast.ok, true, 'Can cast for free when controlling a commander');
		settle(state);
		assert.equal(bob.life, bobLifeBefore - 3, 'Free commander spell resolved and dealt 3 damage');
	});

	it('Amount ("for each time you\'ve cast your commander from the command zone this game") reads the commander-tax counter (CR 903.8)', () => {
		const state = createTestGame();
		const [alice] = state.players;
		alice.battlefield = [];
		alice.command = [];

		const cmd = putInZone(
			state,
			alice,
			card({
				name: 'Taxed General',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Legendary Creature — Human Soldier',
				power: '2',
				toughness: '2',
				colors: ['W']
			}),
			'command',
			true
		);
		cmd.commanderCastCount = 3;
		alice.commanderCastCounts = { [cmd.instanceId]: 3 };

		const tokenSpellCard = card({
			name: 'Call of the General',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText:
				"Create a 1/1 white Soldier creature token for each time you've cast your commander from the command zone this game.",
			colors: ['W'],
			power: undefined,
			toughness: undefined
		});
		const compiledTokenSpell = compileCard(tokenSpellCard);
		assert.equal(
			compiledTokenSpell.fullySupported,
			true,
			'Commander cast count token spell should compile as fullySupported'
		);

		const tokenSpell = putInZone(state, alice, tokenSpellCard, 'hand', false);
		alice.manaPool.W = 2;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: tokenSpell.instanceId
			}).ok,
			true
		);
		settle(state);

		const soldiers = alice.battlefield.filter(
			(p) => p.isToken && p.card.typeLine.includes('Soldier')
		);
		assert.equal(
			soldiers.length,
			3,
			'Created 3 Soldier tokens matching the 3 times commander was cast from command zone'
		);

		// Also verify cost reduction per commander cast count
		const discountSpellCard = card({
			name: 'Commander Echo',
			manaCost: '{4}{W}',
			cmc: 5,
			typeLine: 'Sorcery',
			oracleText:
				"~ costs {1} less to cast for each time you've cast your commander from the command zone this game.\nDraw a card.",
			colors: ['W'],
			power: undefined,
			toughness: undefined
		});
		assert.equal(compileCard(discountSpellCard).fullySupported, true);
		const discountSpell = putInZone(state, alice, discountSpellCard, 'hand', false);
		assert.equal(effectiveSpellManaCost(state, alice, discountSpell).totalCmc, 2);
	});
});

describe('Tier 3 Track B — Item 5: Grand Abolisher activation lock (CR 101.2, 602.5b, 604.1)', () => {
	it("during the Abolisher controller's turn, opponents cannot tap a mana rock or activate a creature/enchantment ability, can tap a land, and can activate both on their own turn (CR 101.2, 602.5b, 604.1)", () => {
		const state = createTestGame();
		const [alice, bob] = state.players;
		alice.battlefield = [];
		bob.battlefield = [];

		const abolisherCard = card({
			name: 'Grand Abolisher',
			manaCost: '{W}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Cleric',
			oracleText:
				"During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments.",
			colors: ['W']
		});
		assert.equal(compileCard(abolisherCard).fullySupported, true);
		putInZone(state, alice, abolisherCard, 'battlefield', false);

		const manaRock = putInZone(
			state,
			bob,
			card({
				name: 'Arcane Signet',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{T}: Add {G}.',
				colors: [],
				power: undefined,
				toughness: undefined
			}),
			'battlefield',
			false
		);
		const pinger = putInZone(
			state,
			bob,
			card({
				name: 'Prodigal Pyromancer',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Creature — Human Wizard',
				oracleText: '{T}: ~ deals 1 damage to any target.',
				colors: ['R'],
				power: '1',
				toughness: '1'
			}),
			'battlefield',
			false
		);
		const enchAct = putInZone(
			state,
			bob,
			card({
				name: 'Sacred Mesa',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: '{1}{W}: Gain 1 life.',
				colors: ['W'],
				power: undefined,
				toughness: undefined
			}),
			'battlefield',
			false
		);
		const forest = putInZone(
			state,
			bob,
			card({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)',
				colors: [],
				power: undefined,
				toughness: undefined
			}),
			'battlefield',
			false
		);
		bob.manaPool.W = 2;

		// It is Alice's turn; give Bob priority to test his activation permissions during Alice's turn.
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 1;

		const rockAb = getEffectiveActivatedAbilities(state, bob, manaRock)[0]!;
		const pingerAb = getEffectiveActivatedAbilities(state, bob, pinger)[0]!;
		const enchAb = getEffectiveActivatedAbilities(state, bob, enchAct)[0]!;
		const forestAb = getEffectiveActivatedAbilities(state, bob, forest)[0]!;

		assert.equal(
			checkAbilityActivationLegality(state, bob.playerId, manaRock, rockAb).ok,
			false,
			"Opponent cannot activate artifact mana ability during Grand Abolisher controller's turn"
		);
		assert.equal(
			applyGameAction(state, bob.playerId, { type: 'tap_mana', instanceId: manaRock.instanceId }).ok,
			false
		);
		assert.equal(
			checkAbilityActivationLegality(state, bob.playerId, pinger, pingerAb).ok,
			false,
			"Opponent cannot activate creature ability during Grand Abolisher controller's turn"
		);
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'activate_ability',
				instanceId: pinger.instanceId,
				abilityId: pingerAb.id,
				targets: [{ kind: 'player', id: alice.playerId, label: alice.username }]
			}).ok,
			false
		);
		assert.equal(
			checkAbilityActivationLegality(state, bob.playerId, enchAct, enchAb).ok,
			false,
			"Opponent cannot activate enchantment ability during Grand Abolisher controller's turn"
		);

		// Land mana abilities are unaffected by Grand Abolisher
		assert.equal(
			checkAbilityActivationLegality(state, bob.playerId, forest, forestAb).ok,
			true,
			"Opponent CAN activate land mana ability during Grand Abolisher controller's turn"
		);
		assert.equal(
			applyGameAction(state, bob.playerId, { type: 'tap_mana', instanceId: forest.instanceId }).ok,
			true
		);
		assert.equal(bob.manaPool.G, 1);

		// Alice herself can still activate her own creature/artifact abilities on her turn
		const aliceRock = putInZone(
			state,
			alice,
			card({
				name: 'Alice Signet',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{T}: Add {W}.',
				colors: [],
				power: undefined,
				toughness: undefined
			}),
			'battlefield',
			false
		);
		const aliceRockAb = getEffectiveActivatedAbilities(state, alice, aliceRock)[0]!;
		assert.equal(
			checkAbilityActivationLegality(state, alice.playerId, aliceRock, aliceRockAb).ok,
			true
		);

		// On Bob's own turn, Bob can tap his mana rock and activate his creature ability
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		noteLayerInputsChanged(state);

		assert.equal(
			checkAbilityActivationLegality(state, bob.playerId, manaRock, rockAb).ok,
			true,
			'Opponent CAN activate artifact mana ability on their own turn'
		);
		assert.equal(
			applyGameAction(state, bob.playerId, { type: 'tap_mana', instanceId: manaRock.instanceId }).ok,
			true
		);
		assert.equal(bob.manaPool.G, 2);

		assert.equal(
			checkAbilityActivationLegality(state, bob.playerId, pinger, pingerAb).ok,
			true,
			'Opponent CAN activate creature ability on their own turn'
		);
		const aliceLifeBefore = alice.life;
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'activate_ability',
				instanceId: pinger.instanceId,
				abilityId: pingerAb.id,
				targets: [{ kind: 'player', id: alice.playerId, label: alice.username }]
			}).ok,
			true
		);
		settle(state);
		assert.equal(alice.life, aliceLifeBefore - 1);
	});
});

describe('Tier 3 Track B — Item 6: Off-battlefield CDAs and mana value (CR 208.2a, 604.3, 202.3a, 202.3e, 708.2a)', () => {
	it('evaluates layer-7a characteristic-defining abilities in graveyard/hand/library/command zones (CR 208.2a, 604.3)', () => {
		const state = createTestGame();
		const [alice, bob] = state.players;
		alice.battlefield = [];
		bob.battlefield = [];
		alice.graveyard = [];
		bob.graveyard = [];

		const mortivoreCard = card({
			name: 'Mortivore',
			manaCost: '{2}{B}{B}',
			cmc: 4,
			typeLine: 'Creature — Lhurgoyf',
			oracleText: "~'s power and toughness are each equal to the number of creature cards in all graveyards.",
			colors: ['B'],
			power: '*',
			toughness: '*'
		});
		assert.equal(compileCard(mortivoreCard).fullySupported, true);

		const mortivoreInGy = putInZone(state, alice, mortivoreCard, 'graveyard', false);
		putInZone(state, alice, card({ name: 'Dead Bear 1', power: '2', toughness: '2' }), 'graveyard', false);
		putInZone(state, bob, card({ name: 'Dead Bear 2', power: '2', toughness: '2' }), 'graveyard', false);
		putInZone(state, bob, card({ name: 'Dead Bear 3', power: '2', toughness: '2' }), 'graveyard', false);

		// 4 creature cards in all graveyards (Mortivore + 3 Dead Bears)
		const breakdown = inspectCardContinuousBreakdown(mortivoreInGy, state);
		assert.equal(
			breakdown.effectivePower,
			4,
			'buildOffBattlefieldBreakdown evaluates Layer 7a CDA power in graveyard (CR 208.2a, 604.3)'
		);
		assert.equal(breakdown.effectiveToughness, 4);
		assert.equal(objectPower(state, mortivoreInGy), 4);
		assert.equal(objectToughness(state, mortivoreInGy), 4);
		assert.equal(
			matchesObjectFilter(
				mortivoreInGy,
				{
					zone: 'graveyard',
					types: ['Creature'],
					power: { op: '>=', value: { k: 'const', n: 4 } }
				},
				{ state, controllerId: alice.playerId }
			),
			true,
			'Mortivore in graveyard matches "creature card with power 4 or greater in your graveyard"'
		);

		// Also test cardsIn CDA ("the number of cards in your hand") in hand/command zone
		const maroCard = card({
			name: 'Maro',
			manaCost: '{2}{G}{G}',
			cmc: 4,
			typeLine: 'Creature — Elemental',
			oracleText: "~'s power and toughness are each equal to the number of cards in your hand.",
			colors: ['G'],
			power: '*',
			toughness: '*'
		});
		const maroInHand = putInZone(state, alice, maroCard, 'hand', false);
		const expectedHandSize = alice.hand.length;
		assert.equal(inspectCardContinuousBreakdown(maroInHand, state).effectivePower, expectedHandSize);
		assert.equal(objectPower(state, maroInHand), expectedHandSize);
	});

	it('treats face-down permanents and spells as having mana value 0 under MV filters (CR 708.2a, 202.3a)', () => {
		const state = createTestGame();
		const [alice] = state.players;
		alice.battlefield = [];

		const bigCreature = putInZone(
			state,
			alice,
			card({
				name: 'Colossal Dreadmaw',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Creature — Dinosaur',
				power: '6',
				toughness: '6'
			}),
			'battlefield',
			false
		);
		bigCreature.isFaceDown = true;
		noteLayerInputsChanged(state);

		assert.equal(
			matchesObjectFilter(
				bigCreature,
				{ manaValue: { op: '=', value: { k: 'const', n: 0 } } },
				{ state, controllerId: alice.playerId }
			),
			true,
			'Face-down permanent has mana value 0 (CR 708.2a, 202.3a)'
		);
		assert.equal(
			matchesObjectFilter(
				bigCreature,
				{ manaValue: { op: '>=', value: { k: 'const', n: 4 } } },
				{ state, controllerId: alice.playerId }
			),
			false,
			'Face-down permanent does not match MV >= 4'
		);
	});

	it('includes xValue in mana value when a spell is on the stack and treats X as 0 in all other zones (CR 202.3e)', () => {
		const state = createTestGame();
		const [alice] = state.players;

		const fireballCard = card({
			name: 'Fireball',
			manaCost: '{X}{R}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: '~ deals X damage to any target.',
			colors: ['R'],
			power: undefined,
			toughness: undefined
		});

		const inHand = putInZone(state, alice, fireballCard, 'hand', false);
		assert.equal(
			matchesObjectFilter(
				inHand,
				{ manaValue: { op: '=', value: { k: 'const', n: 1 } } },
				{ state, controllerId: alice.playerId, xValue: 4 }
			),
			true,
			'In hand, {X} is 0 so mana value is 1 (CR 202.3e)'
		);

		// Move Fireball onto the stack with xValue = 4 -> mana value on the stack is 1 + 4 = 5
		alice.hand = alice.hand.filter((c) => c.instanceId !== inHand.instanceId);
		inHand.zone = 'stack';
		state.stack.push({
			id: 'stk_fireball',
			kind: 'spell',
			sourceInstanceId: inHand.instanceId,
			controllerId: alice.playerId,
			ownerId: alice.playerId,
			card: fireballCard,
			title: 'Fireball',
			description: 'Fireball deals 4 damage to any target.',
			targets: [],
			xValue: 4
		});

		assert.equal(
			matchesObjectFilter(
				inHand,
				{ manaValue: { op: '=', value: { k: 'const', n: 5 } } },
				{ state, controllerId: alice.playerId }
			),
			true,
			'On the stack with X=4, {X}{R} spell has mana value 5 (CR 202.3e)'
		);
		assert.equal(
			matchesObjectFilter(
				inHand,
				{ manaValue: { op: '<=', value: { k: 'const', n: 3 } } },
				{ state, controllerId: alice.playerId }
			),
			false,
			'On the stack with X=4, {X}{R} spell does not match MV <= 3'
		);
	});
});
