import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { cardSupportReport } from '../compiler/support.ts';
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
		id: `t2a_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

function createTestGame(): GameState {
	const seats = [makeSeat(0, 'Alice', false), makeSeat(1, 'Bob', false)];
	const state = createInitialGameState(
		'LOBBY_T2A',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
	}
	return state;
}

function putOnBoard(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' = 'battlefield'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	player[zone].push(inst);
	return inst;
}

describe('Tier 2 Track A — Item 1: CR 207.2c Ability-Word Stripping', () => {
	it('does not strip non-ability-word prefixes (Solved, Max speed, Boast, Exhaust, Power-up) and does not apply them on turn 1, while preserving genuine CR 207.2c ability words (Landfall)', () => {
		const caseCard = card({
			name: 'Case of the Silent Vault',
			typeLine: 'Enchantment — Case',
			oracleText: 'Solved — Creatures you control get +2/+2 and have vigilance.',
			power: undefined,
			toughness: undefined
		});
		const maxSpeedCard = card({
			name: 'Aetherdrift Racer',
			typeLine: 'Creature — Pilot',
			oracleText: 'Max speed — Other creatures you control get +1/+1 and have haste.'
		});
		const boastCard = card({
			name: 'Fjord Raider',
			typeLine: 'Creature — Human Berserker',
			oracleText: 'Boast — Sacrifice a creature: Draw a card.'
		});
		const exhaustCard = card({
			name: 'Boosted Engine',
			typeLine: 'Artifact',
			oracleText: 'Exhaust — {2}: Draw a card.',
			power: undefined,
			toughness: undefined
		});
		const powerUpCard = card({
			name: 'Arcaderawler',
			typeLine: 'Creature — Construct',
			oracleText: 'Power-up — {1}: Put a +1/+1 counter on ~.'
		});
		const landfallCard = card({
			name: 'Lotus Tracker',
			typeLine: 'Creature — Elf',
			oracleText: 'Landfall — Whenever a land you control enters, you gain 1 life.'
		});

		assert.equal(compileCard(caseCard).fullySupported, false, 'Solved — is not an ability word (CR 702.169)');
		assert.equal(cardSupportReport(caseCard).fullySupported, false);
		assert.equal(compileCard(maxSpeedCard).fullySupported, false, 'Max speed — is not an ability word (CR 702.178)');
		assert.equal(cardSupportReport(maxSpeedCard).fullySupported, false);
		assert.equal(compileCard(boastCard).fullySupported, false, 'Boast — is not an ability word (CR 702.142)');
		assert.equal(compileCard(exhaustCard).fullySupported, false, 'Exhaust — is not an ability word (CR 702.177)');
		assert.equal(compileCard(powerUpCard).fullySupported, false, 'Power-up — is not an ability word (CR 702.193)');

		// Genuine CR 207.2c ability word still compiles as fullySupported
		const landfallDef = compileCard(landfallCard);
		assert.equal(landfallDef.fullySupported, true, 'Landfall — is a genuine CR 207.2c ability word');
		assert.equal(landfallDef.faces[0].abilities[0].kind, 'triggered');

		// Runtime check: on Turn 1, Case and Max speed static buffs must NOT apply
		const state = createTestGame();
		const alice = state.players[0];
		const bear = putOnBoard(state, alice, card({ name: 'Grizzly Cub', oracleText: '' }), 'battlefield');
		putOnBoard(state, alice, caseCard, 'battlefield');
		putOnBoard(state, alice, maxSpeedCard, 'battlefield');

		const evalBear = evaluatePermanent(state, bear);
		assert.equal(evalBear.power, 2, 'Solved and Max speed buffs must not apply on turn 1');
		assert.equal(evalBear.toughness, 2, 'Solved and Max speed buffs must not apply on turn 1');
		assert.ok(!evalBear.activeKeywords.includes('Vigilance'));
		assert.ok(!evalBear.activeKeywords.includes('Haste'));
	});
});

describe('Tier 2 Track A — Item 2: CR 602.5b Activation Restrictions', () => {
	it('enforces "Activate only during your upkeep", "Activate only once each turn", "Activate only during combat", and "Activate only during your turn", and marks unknown "Activate only ..." as unsupported', () => {
		const upkeepArtifact = card({
			name: 'Dawn Chime',
			typeLine: 'Artifact',
			oracleText: '{1}: You gain 1 life. Activate only during your upkeep.',
			power: undefined,
			toughness: undefined
		});
		const onceArtifact = card({
			name: 'Metered Well',
			typeLine: 'Artifact',
			oracleText: '{1}: You gain 1 life. Activate only once each turn.\n{2}: You gain 2 life. Activate only once each turn.',
			power: undefined,
			toughness: undefined
		});
		const combatArtifact = card({
			name: 'War Banner',
			typeLine: 'Artifact',
			oracleText: '{1}: You gain 1 life. Activate only during combat.',
			power: undefined,
			toughness: undefined
		});
		const yourTurnArtifact = card({
			name: 'Daylight Sundial',
			typeLine: 'Artifact',
			oracleText: '{1}: You gain 1 life. Activate only during your turn.',
			power: undefined,
			toughness: undefined
		});
		const conditionalArtifact = card({
			name: 'Dragon Shrine',
			typeLine: 'Artifact',
			oracleText: '{1}: You gain 1 life. Activate only if you control a Dragon.',
			power: undefined,
			toughness: undefined
		});

		assert.equal(compileCard(upkeepArtifact).fullySupported, true);
		assert.equal(compileCard(onceArtifact).fullySupported, true);
		assert.equal(compileCard(yourTurnArtifact).fullySupported, true);
		assert.equal(compileCard(conditionalArtifact).fullySupported, false, 'Unknown "Activate only if ..." must be unsupported');

		const state = createTestGame();
		const alice = state.players[0];
		const bob = state.players[1];

		const upkeepPerm = putOnBoard(state, alice, upkeepArtifact, 'battlefield');
		const oncePerm = putOnBoard(state, alice, onceArtifact, 'battlefield');
		const combatPerm = putOnBoard(state, alice, combatArtifact, 'battlefield');
		const yourTurnPerm = putOnBoard(state, bob, yourTurnArtifact, 'battlefield');

		// 1. In main1: upkeep ability and combat ability are illegal
		assert.equal(state.phase, 'main1');
		const resUpkeepMain = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: upkeepPerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resUpkeepMain.ok, false, 'Upkeep-only ability must be illegal in main1');
		assert.equal(compileCard(combatArtifact).fullySupported, true);

		const resCombatMain = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: combatPerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resCombatMain.ok, false, 'Combat-only ability must be illegal in main1');

		// 2. In upkeep: upkeep ability is legal
		state.phase = 'upkeep';
		const resUpkeepOk = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: upkeepPerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resUpkeepOk.ok, true, 'Upkeep-only ability must be legal during controller upkeep');
		state.stack = [];

		// 3. In combat: combat ability is legal
		state.phase = 'declare_attackers';
		const resCombatOk = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: combatPerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resCombatOk.ok, true, 'Combat-only ability must be legal during combat');
		state.stack = [];

		// 4. "Activate only once each turn": first activation legal, second illegal (even after control change, CR 602.5b),
		// while the second ability on the same permanent is still legal (CR 602.5c).
		state.phase = 'main1';
		const resOnce1 = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: oncePerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resOnce1.ok, true, 'First activation of once-each-turn ability must be legal');
		state.stack = [];

		const resOnce2 = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: oncePerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resOnce2.ok, false, 'Second activation of once-each-turn ability must be illegal');

		// Second ability (act_1) on the same permanent is tracked independently (CR 602.5c)
		const resOtherAb = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: oncePerm.instanceId,
			abilityId: 'act_1'
		});
		assert.equal(resOtherAb.ok, true, 'Different once-each-turn ability on same permanent must still be legal');
		state.stack = [];

		// 5. "Activate only during your turn": illegal for Bob during Alice's turn even with priority
		state.priorityPlayerIndex = 1;
		const resYourTurnOpp = applyGameAction(state, bob.playerId, {
			type: 'activate_ability',
			instanceId: yourTurnPerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resYourTurnOpp.ok, false, '"Activate only during your turn" must be illegal on opponent turn');

		// Transfer oncePerm control to Bob during the same turn: act_0 is still used this turn (CR 602.5b)
		alice.battlefield = alice.battlefield.filter((c) => c.instanceId !== oncePerm.instanceId);
		oncePerm.controllerId = bob.playerId;
		bob.battlefield.push(oncePerm);
		const resOnceBob = applyGameAction(state, bob.playerId, {
			type: 'activate_ability',
			instanceId: oncePerm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(resOnceBob.ok, false, 'Once-each-turn restriction persists across controller changes (CR 602.5b)');
	});
});

describe('Tier 2 Track A — Item 3: CR 509.1b / 702.11d / 702.13 / 702.28 / 702.31 / 702.36 / 702.108a Granted Keywords', () => {
	it('enforces Fear, Intimidate, Shadow (both directions), Horsemanship, Hexproof from [quality], and static-granted Prowess', () => {
		const state = createTestGame();
		const alice = state.players[0];
		const bob = state.players[1];

		const fearAtk = putOnBoard(
			state,
			alice,
			card({ name: 'Nightmare Stalker', colors: ['B'], oracleText: 'Fear' }),
			'battlefield'
		);
		const intimidateAtk = putOnBoard(
			state,
			alice,
			card({ name: 'Red Bruiser', colors: ['R'], oracleText: 'Intimidate' }),
			'battlefield'
		);
		const shadowAtk = putOnBoard(
			state,
			alice,
			card({ name: 'Dauthi Shade', colors: ['B'], oracleText: 'Shadow' }),
			'battlefield'
		);
		const normalAtk = putOnBoard(
			state,
			alice,
			card({ name: 'Vanilla Walker', colors: ['G'], oracleText: '' }),
			'battlefield'
		);
		const horseAtk = putOnBoard(
			state,
			alice,
			card({ name: 'Wei Cavalry', colors: ['B'], oracleText: 'Horsemanship' }),
			'battlefield'
		);

		const greenBlocker = putOnBoard(
			state,
			bob,
			card({ name: 'Green Bear', colors: ['G'], oracleText: '' }),
			'battlefield'
		);
		const blackBlocker = putOnBoard(
			state,
			bob,
			card({ name: 'Black Rat', colors: ['B'], oracleText: '' }),
			'battlefield'
		);
		const redBlocker = putOnBoard(
			state,
			bob,
			card({ name: 'Red Goblin', colors: ['R'], oracleText: '' }),
			'battlefield'
		);
		const artifactBlocker = putOnBoard(
			state,
			bob,
			card({
				name: 'Iron Myr',
				typeLine: 'Artifact Creature — Myr',
				colors: [],
				oracleText: ''
			}),
			'battlefield'
		);
		const shadowBlocker = putOnBoard(
			state,
			bob,
			card({ name: 'Soltari Trooper', colors: ['W'], oracleText: 'Shadow' }),
			'battlefield'
		);
		const horseBlocker = putOnBoard(
			state,
			bob,
			card({ name: 'Shu Cavalry', colors: ['W'], oracleText: 'Horsemanship' }),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'declare_attackers',
				assignments: [
					fearAtk,
					intimidateAtk,
					shadowAtk,
					normalAtk,
					horseAtk
				].map((a) => ({ attackerInstanceId: a.instanceId, defenderPlayerId: bob.playerId }))
			}).ok,
			true
		);
		state.phase = 'declare_blockers';
		state.priorityPlayerIndex = 1;

		// 1. Fear (CR 702.36b): green creature cannot block Fear
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: greenBlocker.instanceId, attackerInstanceId: fearAtk.instanceId }]
			}).ok,
			false,
			'Nonblack nonartifact creature must not block Fear (CR 702.36b)'
		);

		// 2. Intimidate (CR 702.13b): green creature cannot block Red Intimidate
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: greenBlocker.instanceId, attackerInstanceId: intimidateAtk.instanceId }]
			}).ok,
			false,
			'Creature sharing no color and not artifact must not block Intimidate (CR 702.13b)'
		);

		// 3. Shadow (CR 702.28b): non-Shadow cannot block Shadow, and Shadow cannot block non-Shadow
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: greenBlocker.instanceId, attackerInstanceId: shadowAtk.instanceId }]
			}).ok,
			false,
			'Creature without Shadow must not block Shadow (CR 702.28b)'
		);
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: shadowBlocker.instanceId, attackerInstanceId: normalAtk.instanceId }]
			}).ok,
			false,
			'Creature with Shadow must not block creature without Shadow (CR 702.28b)'
		);

		// 4. Horsemanship (CR 702.31b): non-Horsemanship cannot block Horsemanship
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: greenBlocker.instanceId, attackerInstanceId: horseAtk.instanceId }]
			}).ok,
			false,
			'Creature without Horsemanship must not block Horsemanship (CR 702.31b)'
		);

		// Legal blocks for all of them:
		// blackBlocker -> fearAtk, artifactBlocker -> fearAtk, redBlocker -> intimidateAtk,
		// shadowBlocker -> shadowAtk, horseBlocker -> horseAtk, greenBlocker -> normalAtk
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: blackBlocker.instanceId, attackerInstanceId: fearAtk.instanceId },
					{ blockerInstanceId: artifactBlocker.instanceId, attackerInstanceId: fearAtk.instanceId },
					{ blockerInstanceId: redBlocker.instanceId, attackerInstanceId: intimidateAtk.instanceId },
					{ blockerInstanceId: shadowBlocker.instanceId, attackerInstanceId: shadowAtk.instanceId },
					{ blockerInstanceId: horseBlocker.instanceId, attackerInstanceId: horseAtk.instanceId },
					{ blockerInstanceId: greenBlocker.instanceId, attackerInstanceId: normalAtk.instanceId }
				]
			}).ok,
			true,
			'Valid blockers for Fear, Intimidate, Shadow, and Horsemanship must succeed'
		);

		// 5. Hexproof from [quality] (CR 702.11d)
		const state2 = createTestGame();
		const p1 = state2.players[0];
		const p2 = state2.players[1];
		putOnBoard(
			state2,
			p2,
			card({
				name: 'Aegis Enchantment',
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control have hexproof from black.',
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);
		const p2Bear = putOnBoard(state2, p2, card({ name: 'Protected Bear', oracleText: '' }), 'battlefield');
		const blackKill = putOnBoard(
			state2,
			p1,
			card({
				name: 'Dark Banishing',
				typeLine: 'Instant',
				manaCost: '{1}{B}',
				colors: ['B'],
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		const redBolt = putOnBoard(
			state2,
			p1,
			card({
				name: 'Flame Lash',
				typeLine: 'Instant',
				manaCost: '{R}',
				colors: ['R'],
				oracleText: '~ deals 2 damage to target creature.'
			}),
			'hand'
		);

		// Opponent's black spell cannot target creature with hexproof from black
		assert.equal(
			applyGameAction(state2, p1.playerId, {
				type: 'cast_spell',
				instanceId: blackKill.instanceId,
				targets: [{ kind: 'permanent', id: p2Bear.instanceId, label: p2Bear.card.name }]
			}).ok,
			false,
			'Opponent black spell must not target permanent with hexproof from black (CR 702.11d)'
		);
		// Opponent's red spell CAN target creature with hexproof from black
		assert.equal(
			applyGameAction(state2, p1.playerId, {
				type: 'cast_spell',
				instanceId: redBolt.instanceId,
				targets: [{ kind: 'permanent', id: p2Bear.instanceId, label: p2Bear.card.name }]
			}).ok,
			true,
			'Opponent red spell can target permanent with hexproof from black'
		);
		state2.stack = [];

		// 6. Prowess granted by a static ability (CR 702.108a)
		const state3 = createTestGame();
		const caster = state3.players[0];
		const opp = state3.players[1];
		putOnBoard(
			state3,
			caster,
			card({
				name: 'Monastery Mentor Aura',
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control have prowess.',
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);
		const monk = putOnBoard(
			state3,
			caster,
			card({ name: 'Student Monk', power: '2', toughness: '2', oracleText: '' }),
			'battlefield'
		);
		const cantrip = putOnBoard(
			state3,
			caster,
			card({
				name: 'Quick Study Bolt',
				typeLine: 'Instant',
				manaCost: '{U}',
				colors: ['U'],
				oracleText: 'You gain 1 life.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state3, caster.playerId, {
				type: 'cast_spell',
				instanceId: cantrip.instanceId
			}).ok,
			true
		);
		// Stack has the spell + the Prowess trigger on top
		assert.equal(state3.stack.length, 2, 'Static-granted Prowess must trigger on noncreature spell cast (CR 702.108a)');
		// Resolve Prowess trigger
		assert.equal(applyGameAction(state3, caster.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state3, opp.playerId, { type: 'pass_priority' }).ok, true);
		const evalMonk = evaluatePermanent(state3, monk);
		assert.equal(evalMonk.power, 3, 'Prowess trigger must give +1/+1 until end of turn');
		assert.equal(evalMonk.toughness, 3, 'Prowess trigger must give +1/+1 until end of turn');
	});
});
