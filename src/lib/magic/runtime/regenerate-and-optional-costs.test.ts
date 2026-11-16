import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

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

function creature(name: string, oracleText = '', power = '2', toughness = '2', keywords: string[] = []): ScryfallCard {
	return card({
		name,
		manaCost: '{2}',
		cmc: 2,
		typeLine: 'Creature — Troll',
		oracleText,
		power,
		toughness,
		keywords
	});
}

function seat(i: number, id: string, username: string, isBot = false): LobbySeat {
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

function setupGame(botSeats: boolean[] = [false, false]): GameState {
	const names = ['Alice', 'Bob', 'Carol'];
	const seats = botSeats.map((isBot, i) => seat(i, `player_${i + 1}`, names[i], isBot));
	const state = createInitialGameState(
		'LOBBY_D2',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	return state;
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'battlefield' | 'hand' | 'graveyard' | 'library' | 'command' = 'battlefield',
	extra?: Partial<CardInstance>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, zone === 'command', false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (extra) Object.assign(inst, extra);
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function cast(
	state: GameState,
	p: PlayerGameState,
	inst: CardInstance,
	targets: Array<Omit<TargetRef, 'label'> & { label?: string }> = []
): void {
	const fullTargets: TargetRef[] = targets.map((t) => ({ ...t, label: t.label ?? t.id }) as TargetRef);
	const res = applyGameAction(state, p.playerId, { type: 'cast_spell', instanceId: inst.instanceId, targets: fullTargets });
	assert.equal(res.ok, true, res.error ?? '');
}

function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) {
		const active = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, active.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function advancePhase(state: GameState, targetPhase: GameState['phase']): void {
	let guard = 60;
	while (state.phase !== targetPhase && state.pendingPrompts.length === 0 && guard-- > 0) {
		const active = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, active.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
	assert.equal(state.phase, targetPhase);
}

function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function answerChoice(state: GameState, playerId: string, answer: ChoiceAnswer): void {
	const prompt = state.pendingPrompts.find((p) => p.playerId === playerId);
	assert.ok(prompt, `Expected prompt for ${playerId}`);
	const res = applyGameAction(state, playerId, {
		type: 'choice',
		promptId: prompt.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? '');
}

describe('Track D Slice 2: Part A — Regenerate and cantBeRegenerated (CR 701.19a–c, 614.8)', () => {
	it('regenerates on effect destruction: taps, clears damage, consumes shield, skips dies triggers, and 2nd destroy kills', () => {
		const state = setupGame();
		const [alice, bob] = state.players;
		const troll = put(
			state,
			alice,
			creature('Mire Strider', '{G}: Regenerate Mire Strider.\nWhen Mire Strider dies, you lose 5 life.', '2', '2')
		);
		troll.damageMarked = 1;
		const shieldSpell = put(
			state,
			alice,
			card({ name: 'Bark Ward', manaCost: '{G}', typeLine: 'Instant', oracleText: 'Regenerate target creature.' }),
			'hand'
		);
		const killA = put(
			state,
			bob,
			card({ name: 'Snuff Out Test', manaCost: '{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		const killB = put(
			state,
			bob,
			card({ name: 'Doom Blade Test', manaCost: '{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);

		cast(state, alice, shieldSpell, [{ kind: 'permanent', id: troll.instanceId }]);
		settle(state);
		assert.equal(troll.regenerationShields, 1);

		// Pass priority to Bob in main1 to cast Destroy A
		assert.equal(applyGameAction(state, alice.playerId, { type: 'pass_priority' }).ok, true);
		cast(state, bob, killA, [{ kind: 'permanent', id: troll.instanceId }]);
		settle(state);

		assert.equal(troll.zone, 'battlefield');
		assert.equal(troll.tapped, true);
		assert.equal(troll.damageMarked, 0);
		assert.equal(troll.regenerationShields, undefined);
		assert.equal(alice.life, 40, 'dies trigger must not fire when regenerated');

		// 2nd Destroy kills the now-unshielded troll
		assert.equal(applyGameAction(state, alice.playerId, { type: 'pass_priority' }).ok, true);
		cast(state, bob, killB, [{ kind: 'permanent', id: troll.instanceId }]);
		settle(state);

		assert.equal(troll.zone, 'graveyard');
		assert.equal(alice.life, 35);
	});

	it('regenerates on lethal and deathtouch SBA damage, removing from combat and clearing damage/deathtouch flags', () => {
		const state = setupGame();
		const [alice, bob] = state.players;
		const atk = put(state, alice, creature('Briar Brute', '', '2', '3'), 'battlefield', {
			regenerationShields: 1
		});
		const def = put(state, bob, creature('Viper Sentinel', '', '1', '1', ['Deathtouch']), 'battlefield');

		advancePhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: atk.instanceId, defenderPlayerId: bob.playerId }]
			}).ok,
			true
		);
		advancePhase(state, 'declare_blockers');
		assert.equal(
			applyGameAction(state, bob.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: def.instanceId, attackerInstanceId: atk.instanceId }]
			}).ok,
			true
		);
		advancePhase(state, 'main2');

		assert.equal(atk.zone, 'battlefield');
		assert.equal(atk.tapped, true);
		assert.equal(atk.damageMarked, 0);
		assert.equal(atk.deathtouchDamageMarked, false);
		assert.equal(atk.regenerationShields, undefined);
		assert.equal(
			state.combat.attackers.some((a) => a.attackerInstanceId === atk.instanceId),
			false,
			'regenerated creature is removed from combat (CR 701.19a)'
		);
		assert.equal(def.zone, 'graveyard');
	});

	it('does NOT regenerate from zero toughness (CR 704.5f) or sacrifice', () => {
		const state = setupGame();
		const [alice] = state.players;
		const zeroTough = put(state, alice, creature('Fragile Shade', '', '2', '2'), 'battlefield', {
			regenerationShields: 2,
			tempPowerMod: -2,
			tempToughnessMod: -2
		});
		checkStateBasedActions(state);
		assert.equal(zeroTough.zone, 'graveyard', '0 toughness cannot be regenerated (CR 704.5f)');

		const sacBait = put(state, alice, creature('Sacrificial Troll', '', '2', '2'), 'battlefield', {
			regenerationShields: 2
		});
		const edict = put(
			state,
			alice,
			card({ name: 'Self Edict', manaCost: '{B}', typeLine: 'Sorcery', oracleText: 'Sacrifice a creature.' }),
			'hand'
		);
		cast(state, alice, edict);
		settle(state);
		assert.equal(sacBait.zone, 'graveyard', 'sacrifice cannot be regenerated');
	});

	it('respects Indestructible precedence (does not consume shield) and cantBeRegenerated / shield counters', () => {
		const state = setupGame();
		const [alice] = state.players;

		const indest = put(state, alice, creature('Iron Colossus', '', '3', '3', ['Indestructible']), 'battlefield', {
			regenerationShields: 1
		});
		const shatter = put(
			state,
			alice,
			card({ name: 'Wrath Test', manaCost: '{W}', typeLine: 'Sorcery', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		cast(state, alice, shatter, [{ kind: 'permanent', id: indest.instanceId }]);
		settle(state);
		assert.equal(indest.zone, 'battlefield');
		assert.equal(indest.regenerationShields, 1, 'Indestructible should not consume regeneration shield');

		// cantBeRegenerated bypasses regeneration shield, but shield counter still saves!
		const shielded = put(state, alice, creature('Scaled Guardian', '', '2', '2'), 'battlefield', {
			regenerationShields: 1
		});
		shielded.counters.shield = 1;
		const noRegenKill = put(
			state,
			alice,
			card({
				name: 'Terminate Clone',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText: "Destroy target creature. It can't be regenerated."
			}),
			'hand'
		);
		cast(state, alice, noRegenKill, [{ kind: 'permanent', id: shielded.instanceId }]);
		settle(state);
		assert.equal(shielded.zone, 'battlefield', 'shield counter still saves when regeneration is prevented');
		assert.equal(shielded.counters.shield, 0);
		assert.equal(shielded.regenerationShields, 1);

		// Damage + "That creature can't be regenerated this turn" kills shielded creature even with regen shield
		const scorch = put(
			state,
			alice,
			card({
				name: 'Scorching Bolt',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: "Scorching Bolt deals 3 damage to target creature. That creature can't be regenerated this turn."
			}),
			'hand'
		);
		cast(state, alice, scorch, [{ kind: 'permanent', id: shielded.instanceId }]);
		settle(state);
		assert.equal(shielded.zone, 'graveyard');
	});

	it('clears regeneration shields and cantBeRegeneratedThisTurn at end of turn and when leaving the battlefield', () => {
		const state = setupGame();
		const [alice] = state.players;
		alice.hand = [];
		const c = put(state, alice, creature('Fading Troll'), 'battlefield', {
			regenerationShields: 2,
			cantBeRegeneratedThisTurn: true
		});
		advancePhase(state, 'end_step');
		let guard = 20;
		while (state.activePlayerIndex === 0 && state.pendingPrompts.length === 0 && guard-- > 0) {
			const active = state.players[state.priorityPlayerIndex];
			assert.equal(applyGameAction(state, active.playerId, { type: 'pass_priority' }).ok, true);
		}
		assert.equal(state.activePlayerIndex, 1);
		assert.equal(c.regenerationShields, undefined);
		assert.equal(c.cantBeRegeneratedThisTurn, undefined);

		// Also cleared on LTB (bounce to hand)
		const state2 = setupGame();
		const [alice2] = state2.players;
		const bouncer = put(
			state2,
			alice2,
			card({
				name: 'Unsummon Test',
				manaCost: '{U}',
				typeLine: 'Instant',
				oracleText: "Return target creature to its owner's hand."
			}),
			'hand'
		);
		const target = put(state2, alice2, creature('Shielded Drifter'), 'battlefield', {
			regenerationShields: 1,
			cantBeRegeneratedThisTurn: true
		});
		cast(state2, alice2, bouncer, [{ kind: 'permanent', id: target.instanceId }]);
		settle(state2);
		assert.equal(target.zone, 'hand');
		assert.equal(target.regenerationShields, undefined);
		assert.equal(target.cantBeRegeneratedThisTurn, undefined);
	});
});

describe('Track D Slice 2: Part B — Unified OptionalSpec + CostDef[] + ifPrecedingDeclined', () => {
	it('handles human pay / decline / cant-pay across JSON round-trips for "You may pay {2}. If you do, draw a card. If you don\'t, you lose 2 life."', () => {
		// Case 1: Human chooses Pay
		let state = setupGame();
		let alice = state.players[0];
		alice.manaPool = { W: 0, U: 2, B: 0, R: 0, G: 0, C: 2 };
		const cardDef = card({
			name: 'Bargain Draw',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: "You may pay {2}. If you do, draw a card. If you don't, you lose 2 life."
		});
		const spell1 = put(state, alice, cardDef, 'hand');
		const handBefore = alice.hand.length;
		cast(state, alice, spell1);
		settle(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].kind, 'yesNo');

		state = roundTrip(state);
		alice = state.players[0];
		answerChoice(state, alice.playerId, { kind: 'yesNo', yes: true });
		assert.equal(state.stack.length, 0);
		assert.equal(alice.hand.length, handBefore, 'cast -1 + draw +1');
		assert.equal(alice.life, 40);
		assert.equal(alice.manaPool.C + alice.manaPool.U, 0);

		// Case 2: Human chooses Don't Pay -> takes ifPrecedingDeclined branch
		let state2 = setupGame();
		let alice2 = state2.players[0];
		alice2.manaPool = { W: 0, U: 2, B: 0, R: 0, G: 0, C: 2 };
		const spell2 = put(state2, alice2, cardDef, 'hand');
		const handBefore2 = alice2.hand.length;
		cast(state2, alice2, spell2);
		settle(state2);
		state2 = roundTrip(state2);
		alice2 = state2.players[0];
		answerChoice(state2, alice2.playerId, { kind: 'yesNo', yes: false });
		assert.equal(alice2.hand.length, handBefore2 - 1);
		assert.equal(alice2.life, 38);
		assert.equal(alice2.manaPool.C + alice2.manaPool.U, 2, 'did not spend the {2}');

		// Case 3: Human cannot pay {2} -> auto-declines without prompting
		const state3 = setupGame();
		const alice3 = state3.players[0];
		alice3.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 }; // only enough to cast spell
		const spell3 = put(state3, alice3, cardDef, 'hand');
		cast(state3, alice3, spell3);
		settle(state3);
		assert.equal(state3.pendingPrompts.length, 0);
		assert.equal(alice3.life, 38);
	});

	it('pauses for chooseObjects inside composite optional cost after yesNo and resumes cleanly across JSON round-trips', () => {
		let state = setupGame();
		let alice = state.players[0];
		alice.manaPool = { W: 0, U: 0, B: 1, R: 0, G: 0, C: 1 };
		const c1 = put(state, alice, creature('Fodder One'), 'battlefield');
		const c2 = put(state, alice, creature('Fodder Two'), 'battlefield');
		const spell = put(
			state,
			alice,
			card({
				name: 'Blood Tribute Test',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'You may pay {1} and sacrifice a creature. If you do, draw two cards.'
			}),
			'hand'
		);
		const handBefore = alice.hand.length;
		cast(state, alice, spell);
		settle(state);
		assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');

		state = roundTrip(state);
		answerChoice(state, alice.playerId, { kind: 'yesNo', yes: true });
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].kind, 'chooseObjects');

		state = roundTrip(state);
		alice = state.players[0];
		answerChoice(state, alice.playerId, { kind: 'chooseObjects', objectIds: [c1.instanceId] });

		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 0);
		assert.equal(alice.battlefield.some((c) => c.instanceId === c1.instanceId), false);
		assert.equal(alice.battlefield.some((c) => c.instanceId === c2.instanceId), true);
		assert.equal(alice.hand.length, handBefore - 1 + 2);
	});

	it('resolves "Counter target spell unless its controller pays {2}" for both Pay and Dont Pay across JSON round-trips', () => {
		const leakDef = card({
			name: 'Arcane Leak',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Counter target spell unless its controller pays {2}.'
		});
		const boltDef = card({
			name: 'Shock Bolt',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Shock Bolt deals 3 damage to any target.'
		});

		// Case 1: Opponent pays {2} -> spell is NOT countered and resolves damage
		let state1 = setupGame();
		let [alice1, bob1] = state1.players;
		const bolt1 = put(state1, bob1, boltDef, 'hand');
		const leak1 = put(state1, alice1, leakDef, 'hand');
		assert.equal(applyGameAction(state1, alice1.playerId, { type: 'pass_priority' }).ok, true);
		cast(state1, bob1, bolt1, [{ kind: 'player', id: alice1.playerId }]);
		assert.equal(applyGameAction(state1, bob1.playerId, { type: 'pass_priority' }).ok, true);
		const boltStackId = state1.stack[0].id;
		cast(state1, alice1, leak1, [{ kind: 'stack', id: boltStackId }]);
		settle(state1);
		assert.equal(state1.pendingPrompts.length, 1);
		assert.equal(state1.pendingPrompts[0].playerId, bob1.playerId);

		state1 = roundTrip(state1);
		[alice1, bob1] = state1.players;
		const bobManaBefore = bob1.manaPool.C + bob1.manaPool.G;
		answerChoice(state1, bob1.playerId, { kind: 'yesNo', yes: true });
		settle(state1);
		assert.equal(alice1.life, 37, 'Bob paid {2}, so Shock Bolt resolved');
		assert.equal(bob1.manaPool.C + bob1.manaPool.G, bobManaBefore - 2);

		// Case 2: Opponent declines -> spell IS countered
		let state2 = setupGame();
		let [alice2, bob2] = state2.players;
		const bolt2 = put(state2, bob2, boltDef, 'hand');
		const leak2 = put(state2, alice2, leakDef, 'hand');
		assert.equal(applyGameAction(state2, alice2.playerId, { type: 'pass_priority' }).ok, true);
		cast(state2, bob2, bolt2, [{ kind: 'player', id: alice2.playerId }]);
		assert.equal(applyGameAction(state2, bob2.playerId, { type: 'pass_priority' }).ok, true);
		const boltStackId2 = state2.stack[0].id;
		cast(state2, alice2, leak2, [{ kind: 'stack', id: boltStackId2 }]);
		settle(state2);
		state2 = roundTrip(state2);
		[alice2, bob2] = state2.players;
		answerChoice(state2, bob2.playerId, { kind: 'yesNo', yes: false });
		assert.equal(state2.stack.length, 0);
		assert.equal(alice2.life, 40, 'Bob declined to pay, so Shock Bolt was countered');
	});

	it('allows Powerstone mana ({ isSpell: false }) to pay optional costs while still forbidding nonartifact spells', () => {
		const state = setupGame();
		const [alice] = state.players;
		alice.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		alice.restrictedMana = {
			artifactSpellOrNonSpell: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 }
		};
		const taxSpell = put(
			state,
			alice,
			card({
				name: 'Powerstone Inquiry',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Sorcery',
				oracleText: 'You may pay {1}. If you do, draw a card.'
			}),
			'hand'
		);
		const nonArtifact = put(
			state,
			alice,
			card({ name: 'Cant Cast Me', manaCost: '{1}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Draw a card.' }),
			'hand'
		);
		// Cannot cast a {1} nonartifact sorcery using Powerstone restricted mana
		const blocked = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: nonArtifact.instanceId
		});
		assert.equal(blocked.ok, false);

		// Cast {0} sorcery, then pay optional {1} using the Powerstone mana
		const handBefore = alice.hand.length;
		cast(state, alice, taxSpell);
		settle(state);
		assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');
		answerChoice(state, alice.playerId, { kind: 'yesNo', yes: true });
		assert.equal(alice.restrictedMana?.artifactSpellOrNonSpell?.C ?? 0, 0);
		assert.equal(alice.hand.length, handBefore, '-1 cast +1 draw');
	});

	it('resolves Rhystic-style triggered abilities and handles commander replacement mid-optional-sacrifice without double spending mana', () => {
		// 1. Triggered: "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}."
		let state = setupGame();
		let [alice, bob] = state.players;
		put(
			state,
			alice,
			card({
				name: 'Study Taxer',
				manaCost: '{2}{U}',
				typeLine: 'Enchantment',
				oracleText: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.'
			}),
			'battlefield'
		);
		const bobBolt = put(state, bob, card({ name: 'Ping', manaCost: '{0}', typeLine: 'Instant', oracleText: '' }), 'hand');
		const aliceHandBefore = alice.hand.length;
		assert.equal(applyGameAction(state, alice.playerId, { type: 'pass_priority' }).ok, true);
		cast(state, bob, bobBolt);
		// Trigger is on top of stack above Ping
		assert.equal(applyGameAction(state, bob.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, alice.playerId, { type: 'pass_priority' }).ok, true);
		// Bob prompted to pay {1}
		assert.equal(state.pendingPrompts[0]?.playerId, bob.playerId);
		state = roundTrip(state);
		[alice, bob] = state.players;
		answerChoice(state, bob.playerId, { kind: 'yesNo', yes: false });
		// Alice now prompted whether to draw
		assert.equal(state.pendingPrompts[0]?.playerId, alice.playerId);
		state = roundTrip(state);
		[alice, bob] = state.players;
		answerChoice(state, alice.playerId, { kind: 'yesNo', yes: true });
		assert.equal(alice.hand.length, aliceHandBefore + 1);

		// 2. Replacement choice (commander_zone_choice) mid-optional sacrifice + mana cost does not double-spend mana
		let state2 = setupGame();
		let alice2 = state2.players[0];
		alice2.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 };
		const cmdr = put(
			state2,
			alice2,
			card({
				name: 'Valiant Leader',
				manaCost: '{2}',
				typeLine: 'Legendary Creature — Human',
				power: '2',
				toughness: '2'
			}),
			'battlefield',
			{ isCommander: true }
		);
		const sacSpell = put(
			state2,
			alice2,
			card({
				name: 'Commander Offering',
				manaCost: '{0}',
				typeLine: 'Sorcery',
				oracleText: 'You may pay {2} and sacrifice a creature. If you do, draw a card.'
			}),
			'hand'
		);
		const handBefore2 = alice2.hand.length;
		cast(state2, alice2, sacSpell);
		settle(state2);
		state2 = roundTrip(state2);
		alice2 = state2.players[0];
		answerChoice(state2, alice2.playerId, { kind: 'yesNo', yes: true });
		// Only 1 creature -> auto-picked, hits graveyard -> commander_zone_choice prompt fires!
		assert.equal(state2.pendingPrompts[0]?.kind, 'commander_zone_choice');
		state2 = roundTrip(state2);
		alice2 = state2.players[0];
		const cmdrRes = applyGameAction(state2, alice2.playerId, {
			type: 'commander_zone_choice',
			commanderInstanceId: cmdr.instanceId,
			sendToCommandZone: true
		});
		assert.equal(cmdrRes.ok, true, cmdrRes.error ?? '');
		assert.equal(alice2.command.some((c) => c.instanceId === cmdr.instanceId), true);
		assert.equal(alice2.manaPool.C, 0);
		assert.equal(alice2.hand.length, handBefore2, '-1 cast +1 draw');
	});

	it('has bots automatically pay unless/tax mana costs when affordable and decline when short', () => {
		const state = setupGame([false, true]);
		const [alice, bot] = state.players;
		put(
			state,
			alice,
			card({
				name: 'Tithe Taxer',
				manaCost: '{3}{W}',
				typeLine: 'Enchantment',
				oracleText: "Whenever an opponent draws a card, that player may pay {2}. If the player doesn't, you create a Treasure token."
			}),
			'battlefield'
		);
		bot.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 };
		const botDraw = put(
			state,
			alice,
			card({ name: 'Gift Draw', manaCost: '{0}', typeLine: 'Sorcery', oracleText: 'Target opponent draws a card.' }),
			'hand'
		);
		cast(state, alice, botDraw, [{ kind: 'player', id: bot.playerId }]);
		settle(state);
		// Bot had {2} so bot paid {2} and Alice got 0 Treasures
		assert.equal(bot.manaPool.C, 0);
		assert.equal(alice.battlefield.filter((c) => c.card.name === 'Treasure').length, 0);

		// Second draw when bot has 0 mana: Alice gets 1 Treasure token!
		const botDraw2 = put(
			state,
			alice,
			card({ name: 'Gift Draw Two', manaCost: '{0}', typeLine: 'Sorcery', oracleText: 'Target opponent draws a card.' }),
			'hand'
		);
		cast(state, alice, botDraw2, [{ kind: 'player', id: bot.playerId }]);
		settle(state);
		assert.equal(alice.battlefield.filter((c) => c.card.name === 'Treasure').length, 1);
	});

	it('preserves synthetic rename invariance for compiled Track D Slice 2 effects', () => {
		const a = compileCard(
			card({
				name: 'Alpha Warden',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: 'Counter target spell unless its controller pays {2}.'
			})
		);
		const b = compileCard(
			card({
				name: 'Zeta Nullifier',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: 'Counter target spell unless its controller pays {2}.'
			})
		);
		assert.deepEqual(a.faces[0].abilities, b.faces[0].abilities);

		const r1 = compileCard(
			card({
				name: 'Moss Troll',
				manaCost: '{2}{G}',
				typeLine: 'Creature — Troll',
				oracleText: '{G}: Regenerate Moss Troll.'
			})
		);
		const r2 = compileCard(
			card({
				name: 'Bog Lurker',
				manaCost: '{2}{G}',
				typeLine: 'Creature — Troll',
				oracleText: '{G}: Regenerate Bog Lurker.'
			})
		);
		assert.deepEqual(r1.faces[0].abilities, r2.faces[0].abilities);
	});
});
