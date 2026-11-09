import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	drawCards,
	getPlayerCommanderIdentity,
	movePermanentToZone,
	resolveTopOfStack
} from '../engine.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
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
	assert.ok(c, `missing staple ${name}`);
	return c;
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

function newGame(playerCount = 2): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const seats = Array.from({ length: playerCount }, (_, idx) =>
		seat(idx, `p${idx + 1}`, `P${idx + 1}`)
	);
	const decks = new Map(seats.map((_, idx) => [idx, PRECON_DECKS[idx % PRECON_DECKS.length]]));
	const state = createInitialGameState('SBATST', seats, decks, { ...DEFAULT_LOBBY_RULES });
	state.status = 'active';
	state.phase = 'main1';
	state.turnNumber = 2;
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.pendingPrompts = [];
	for (const p of state.players) {
		p.hasKeptHand = true;
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
	}
	return {
		state,
		p1: state.players[0],
		p2: state.players[1],
		p3: state.players[2]
	};
}

function putOnBattlefield(
	state: GameState,
	player: PlayerGameState,
	sc: ScryfallCard,
	isCommander = false
): CardInstance {
	const inst = createCardInstance(sc, player.playerId, 'battlefield', isCommander, false);
	inst.controllerId = player.playerId;
	inst.summoningSick = false;
	player.battlefield.push(inst);
	return inst;
}

describe('Wave 3B: State-Based Actions, Simultaneous Deaths, Elimination & Commander', () => {
	it('CR 704.8: preserves pre-annihilation LKI counters and P/T when a creature with +1/+1 and -1/-1 counters dies in the same SBA pass', () => {
		const { state, p1 } = newGame();
		const hydra = putOnBattlefield(
			state,
			p1,
			card({
				name: ' Clockwork Hydra Witness',
				typeLine: 'Artifact Creature — Hydra',
				power: '1',
				toughness: '1',
				oracleText: ''
			})
		);
		hydra.counters['+1/+1'] = 1;
		hydra.counters['-1/-1'] = 2;

		checkStateBasedActions(state);

		assert.equal(p1.battlefield.length, 0);
		assert.equal(p1.graveyard.length, 1);
		// Pre-annihilation LKI must record the counters before 704.5q cancelled them.
		assert.equal(hydra.lastKnownCounters?.['+1/+1'], 1);
		assert.equal(hydra.lastKnownCounters?.['-1/-1'], 2);
		assert.equal(hydra.lastKnownPower, 0);
		assert.equal(hydra.lastKnownToughness, 0);
	});

	it('CR 603.10a: simultaneous SBA deaths all see each other on the battlefield (observer dies triggers & multipliers)', () => {
		for (const observerName of ['Blood Artist', 'Renamed Soul Watcher']) {
			const { state, p1, p2 } = newGame();
			const observer = putOnBattlefield(
				state,
				p1,
				card({
					name: observerName,
					typeLine: 'Creature — Vampire',
					power: '0',
					toughness: '1',
					oracleText: 'Whenever a creature dies, you gain 1 life.'
				})
			);
			const bear1 = putOnBattlefield(
				state,
				p1,
				card({
					name: 'Dying Bear Alpha',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				})
			);
			const bear2 = putOnBattlefield(
				state,
				p2,
				card({
					name: 'Dying Bear Beta',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				})
			);

			// Mark lethal damage on all three creatures simultaneously (with observer first in zone order).
			observer.damageMarked = 1;
			bear1.damageMarked = 2;
			bear2.damageMarked = 2;

			const lifeBefore = p1.life;
			checkStateBasedActions(state);

			assert.equal(p1.battlefield.length, 0);
			assert.equal(p2.battlefield.length, 0);
			// Observer must trigger for itself, bear1, AND bear2 (3 deaths total = +3 life).
			assert.equal(p1.life, lifeBefore + 3);
		}

		// Also verify a dying trigger multiplier (placed BEFORE the dying creature in zone order)
		// still doubles the simultaneous death trigger (CR 603.10a).
		const { state: stateM, p1: p1M } = newGame();
		const doubler = putOnBattlefield(
			stateM,
			p1M,
			card({
				name: 'Death Harmonizer',
				typeLine: 'Creature — Advisor',
				power: '2',
				toughness: '4',
				oracleText:
					'If a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'
			})
		);
		const martyr = putOnBattlefield(
			stateM,
			p1M,
			card({
				name: 'Lifegiving Martyr',
				typeLine: 'Creature — Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'When this creature dies, you gain 2 life.'
			})
		);
		doubler.damageMarked = 4;
		martyr.damageMarked = 1;
		const lifeBeforeM = p1M.life;
		checkStateBasedActions(stateM);
		assert.equal(p1M.life, lifeBeforeM + 4);
	});

	it('CR 704.3: defers flushing SBA triggers until after the entire SBA fixpoint loop stabilizes', () => {
		const { state, p1 } = newGame();
		const host = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Fragile Host',
				typeLine: 'Creature — Spirit',
				power: '2',
				toughness: '2',
				oracleText: 'When this creature dies, you gain 2 life.'
			})
		);
		const aura = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Vigilant Halo',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nWhen this Aura is put into a graveyard from the battlefield, you gain 3 life.'
			})
		);
		aura.attachedToId = host.instanceId;

		// Give host lethal damage; pass 1 kills host, pass 2 puts unattached aura into graveyard,
		// and triggers flush only after the SBA loop completes.
		host.damageMarked = 2;
		const lifeBefore = p1.life;
		checkStateBasedActions(state);

		assert.equal(p1.battlefield.length, 0);
		assert.equal(p1.graveyard.length, 2);
		assert.equal(p1.life, lifeBefore + 5);
	});

	it('CR 704.5i: a Planeswalker that is also a Creature with 0 loyalty is put into the graveyard', () => {
		const { state, p1 } = newGame();
		const gideon = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Animated Planeswalker',
				typeLine: 'Legendary Planeswalker Creature — Gideon Human Soldier',
				power: '4',
				toughness: '4',
				loyalty: '0',
				oracleText: ''
			})
		);
		gideon.counters.loyalty = 0;

		checkStateBasedActions(state);

		assert.equal(p1.battlefield.length, 0);
		assert.equal(p1.graveyard.length, 1);
		assert.equal(p1.graveyard[0].instanceId, gideon.instanceId);
	});

	it('CR 704.5h: clears deathtouchDamageMarked on an Indestructible creature that survives SBAs', () => {
		const { state, p1 } = newGame();
		const guardian = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Adamant Sentinel',
				typeLine: 'Creature — Golem',
				power: '3',
				toughness: '3',
				keywords: ['Indestructible'],
				oracleText: 'Indestructible'
			})
		);
		guardian.damageMarked = 1;
		guardian.deathtouchDamageMarked = true;

		// First SBA check: creature is Indestructible so it survives, and deathtouchDamageMarked is cleared.
		checkStateBasedActions(state);
		assert.equal(p1.battlefield.length, 1);
		assert.equal(guardian.deathtouchDamageMarked, false);

		// Now strip all abilities (losing Indestructible); the old 1 damage should no longer kill a 3/3 via deathtouch.
		putOnBattlefield(
			state,
			p1,
			card({
				name: 'Nullifying Field',
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 3/3.'
			})
		);
		checkStateBasedActions(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === guardian.instanceId), true);
	});

	it('CR 303.4d / 702.16c / 704.5m: puts unattached or illegally attached Auras into the graveyard', () => {
		const { state, p1, p2 } = newGame();

		// 1. Unattached Aura on battlefield -> graveyard
		const looseAura = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Unattached Mantle',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.'
			})
		);
		looseAura.attachedToId = null;

		// 2. "Enchant creature" attached to a non-creature land -> graveyard
		const nonCreatureHost = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Quiet Meadow',
				typeLine: 'Land',
				oracleText: '{T}: Add {W}.'
			})
		);
		const wrongTypeAura = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Creature-Only Blessing',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +2/+2.'
			})
		);
		wrongTypeAura.attachedToId = nonCreatureHost.instanceId;

		// 3. "Enchant creature you control" attached to opponent's creature -> graveyard
		const oppCreature = putOnBattlefield(
			state,
			p2,
			card({
				name: 'Opponent Wolf',
				typeLine: 'Creature — Wolf',
				power: '2',
				toughness: '2'
			})
		);
		const controlRestrictedAura = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Loyal Bond',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature you control\nEnchanted creature gets +1/+1.'
			})
		);
		controlRestrictedAura.attachedToId = oppCreature.instanceId;

		// 4. Aura attached to a creature with Protection from the Aura's color -> graveyard
		const proWhiteCreature = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Black Knight Exemplar',
				typeLine: 'Creature — Human Knight',
				power: '2',
				toughness: '2',
				oracleText: 'Protection from white'
			})
		);
		const whiteAura = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Holy Armor Synthetic',
				typeLine: 'Enchantment — Aura',
				colors: ['W'],
				oracleText: 'Enchant creature\nEnchanted creature gets +1/+2.'
			})
		);
		whiteAura.attachedToId = proWhiteCreature.instanceId;

		checkStateBasedActions(state);

		const graveIds = new Set(p1.graveyard.map((c) => c.instanceId));
		assert.equal(graveIds.has(looseAura.instanceId), true, 'unattached Aura should go to graveyard');
		assert.equal(graveIds.has(wrongTypeAura.instanceId), true, 'Aura on non-creature should go to graveyard');
		assert.equal(graveIds.has(controlRestrictedAura.instanceId), true, 'Enchant creature you control on opponent creature should go to graveyard');
		assert.equal(graveIds.has(whiteAura.instanceId), true, 'White Aura on protection-from-white creature should go to graveyard');
	});

	it('CR 702.16d / 704.5n: unattaches Equipment from a non-creature or a creature with Protection from the Equipment', () => {
		const { state, p1 } = newGame();

		const land = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Animated Citadel',
				typeLine: 'Land',
				oracleText: '{T}: Add {C}.'
			})
		);
		const equip1 = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Test Blade',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+0.\nEquip {2}'
			})
		);
		equip1.attachedToId = land.instanceId;

		const proArtifactCreature = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Artifact Warder',
				typeLine: 'Creature — Elf',
				power: '2',
				toughness: '2',
				oracleText: 'Protection from artifacts'
			})
		);
		const equip2 = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Test Shield',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +0/+2.\nEquip {1}'
			})
		);
		equip2.attachedToId = proArtifactCreature.instanceId;

		checkStateBasedActions(state);

		assert.equal(equip1.attachedToId, null, 'Equipment on non-creature must unattach');
		assert.equal(equip2.attachedToId, null, 'Equipment on creature with protection from artifacts must unattach');
		assert.equal(p1.battlefield.includes(equip1), true, 'Equipment stays on battlefield');
		assert.equal(p1.battlefield.includes(equip2), true, 'Equipment stays on battlefield');
	});

	it('CR 201.2a / 708.2a: face-down Legendary permanents have no name and are exempt from the Legend Rule (CR 704.5j)', () => {
		const { state, p1 } = newGame();
		const legendCard = card({
			name: 'Arcanis the Omnipotent',
			typeLine: 'Legendary Creature — Wizard',
			power: '3',
			toughness: '4'
		});
		const l1 = putOnBattlefield(state, p1, legendCard);
		const l2 = putOnBattlefield(state, p1, legendCard);
		l1.isFaceDown = true;
		l2.isFaceDown = true;

		checkStateBasedActions(state);

		assert.equal(p1.battlefield.length, 2, 'Two face-down legends should not die to Legend Rule');
	});

	it('CR 104.3c / 704.5b / 104.4a: empty-library draw sets attemptedEmptyLibraryDraw and evaluates simultaneous draw losses in SBAs', () => {
		const { state, p1, p2 } = newGame();
		p1.library = [];
		p2.library = [];

		// Simulate simultaneous draw effect ("Each player draws a card.")
		const wheel = card({
			name: 'Synchronized Insight',
			typeLine: 'Sorcery',
			oracleText: 'Each player draws a card.'
		});
		state.stack.push({
			id: 'stk_wheel',
			sourceInstanceId: 'src_wheel',
			card: wheel,
			controllerId: p1.playerId,
			kind: 'spell',
			title: wheel.name,
			oracleText: wheel.oracleText,
			targets: [],
			xValue: 0,
			parsedEffects: [],
			requiresGuidedResolution: false,
			createdAt: 0
		});

		resolveTopOfStack(state);

		// Both players attempted to draw from an empty library before SBAs ran, so both lose simultaneously -> draw game!
		assert.equal(p1.lost, true);
		assert.equal(p2.lost, true);
		assert.equal(state.status, 'finished');
		assert.equal(state.winnerPlayerId, null);
		assert.equal(state.winnerId, undefined);
	});

	it('CR 704.5b: Platinum Angel prevents empty-library draw SBA loss and clears attemptedEmptyLibraryDraw', () => {
		const { state, p1 } = newGame();
		p1.library = [];
		const angel = putOnBattlefield(
			state,
			p1,
			card({
				name: 'Angel of Preservation',
				typeLine: 'Artifact Creature — Angel',
				power: '4',
				toughness: '4',
				oracleText: "You can't lose the game and your opponents can't win the game."
			})
		);

		drawCards(state, p1, 1);
		assert.equal(p1.lost, false);
		assert.equal(p1.attemptedEmptyLibraryDraw, false);

		// If the Angel later leaves the battlefield, p1 does not retroactively lose without a new empty-library draw attempt.
		movePermanentToZone(state, angel, 'graveyard');
		checkStateBasedActions(state);
		assert.equal(p1.lost, false);
	});

	it('CR 104.4a: evaluates all player SBA losses simultaneously before cleaning up eliminated players', () => {
		const { state, p1, p2 } = newGame();
		// p1 controls Humility ("All creatures lose all abilities and have base power and toughness 1/1.")
		putOnBattlefield(
			state,
			p1,
			card({
				name: 'Equalizing Humility',
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
			})
		);
		// p2 controls Platinum Angel ("You can't lose the game and your opponents can't win the game.")
		putOnBattlefield(
			state,
			p2,
			card({
				name: 'Guarding Angel',
				typeLine: 'Artifact Creature — Angel',
				power: '4',
				toughness: '4',
				oracleText: "You can't lose the game and your opponents can't win the game."
			})
		);

		// Both players are at 0 life when SBAs are checked.
		// Because all player loss conditions are evaluated simultaneously BEFORE p1's Humility is removed by
		// cleanupEliminatedPlayer, p2's Angel still has no abilities during the SBA check, so BOTH players
		// lose simultaneously (draw game, CR 104.4a)!
		p1.life = 0;
		p2.life = 0;

		checkStateBasedActions(state);

		assert.equal(p1.lost, true);
		assert.equal(p2.lost, true);
		assert.equal(state.status, 'finished');
		assert.equal(state.winnerPlayerId, null);
		assert.equal(state.winnerId, undefined);
	});

	it('CR 800.4a: cleanupEliminatedPlayer removes cards in graveyard and command zones too', () => {
		const { state, p1, p2, p3 } = newGame(3);
		assert.ok(p3);

		const gCard = createCardInstance(card({ name: 'Grave Card' }), p1.playerId, 'graveyard');
		p1.graveyard.push(gCard);
		assert.ok(p1.command.length > 0, 'p1 should start with a commander in command zone');

		p1.life = 0;
		checkStateBasedActions(state);

		assert.equal(p1.lost, true);
		assert.equal(p1.graveyard.length, 0, 'eliminated player graveyard must be emptied');
		assert.equal(p1.command.length, 0, 'eliminated player command zone must be emptied');
		assert.equal(state.status, 'active');
		void p2;
	});

	it('CR 704.6d / 903.9a: declining commander_zone_choice SBA prompt does not re-prompt until commander changes zones', () => {
		const { state, p1 } = newGame();
		const cmd = p1.command[0];
		assert.ok(cmd);

		// Move commander to graveyard
		p1.command.splice(0, 1);
		cmd.zone = 'graveyard';
		cmd.objectVersion = 5;
		p1.graveyard.push(cmd);

		checkStateBasedActions(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].kind, 'commander_zone_choice');

		// Player declines moving commander to Command Zone
		const res = applyGameAction(state, p1.playerId, {
			type: 'commander_zone_choice',
			commanderInstanceId: cmd.instanceId,
			sendToCommandZone: false
		});
		assert.equal(res.ok, true);
		assert.equal(p1.graveyard.includes(cmd), true);
		assert.equal(cmd.commanderSbaDeclinedVersion, 5);

		// Subsequent SBA checks must NOT re-prompt while objectVersion is unchanged
		checkStateBasedActions(state);
		assert.equal(
			state.pendingPrompts.some((pr) => pr.kind === 'commander_zone_choice'),
			false,
			'Should not re-prompt commander_zone_choice after declining'
		);

		// If the commander leaves and re-enters graveyard with a new objectVersion, it prompts again
		cmd.objectVersion = 6;
		checkStateBasedActions(state);
		assert.equal(
			state.pendingPrompts.some((pr) => pr.kind === 'commander_zone_choice'),
			true,
			'Should prompt again when commander objectVersion increments'
		);
	});

	it('CR 903.4: preserves commander color identity when commander is in library or on an opponent battlefield', () => {
		const { state, p1, p2 } = newGame();
		const expectedIdentity = [...(p1.commanderColorIdentity ?? [])];
		assert.ok(expectedIdentity.length > 0, 'commanderColorIdentity should be initialized');

		const cmd = p1.command.splice(0, 1)[0];
		assert.ok(cmd);

		// Case 1: Commander tucked into p1's library
		cmd.zone = 'library';
		p1.library.unshift(cmd);
		assert.deepEqual(
			new Set(getPlayerCommanderIdentity(p1)),
			new Set(expectedIdentity),
			'Commander in library must still provide color identity'
		);

		// Case 2: Commander stolen onto opponent's battlefield
		p1.library.shift();
		cmd.zone = 'battlefield';
		cmd.controllerId = p2.playerId;
		p2.battlefield.push(cmd);
		assert.deepEqual(
			new Set(getPlayerCommanderIdentity(p1)),
			new Set(expectedIdentity),
			'Commander on opponent battlefield must still provide color identity'
		);

		// Arcane Signet tapped by p1 still produces mana of p1's commander color identity
		const signet = putOnBattlefield(state, p1, staple('Arcane Signet'));
		const poolBefore = { ...p1.manaPool };
		const tapRes = applyGameAction(state, p1.playerId, {
			type: 'tap_mana',
			instanceId: signet.instanceId
		});
		assert.equal(tapRes.ok, true);
		const gainedColors = expectedIdentity.filter((c) => p1.manaPool[c] > poolBefore[c]);
		assert.equal(gainedColors.length, 1, 'Arcane Signet should produce a color in commander identity');
	});
});
