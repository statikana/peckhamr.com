import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
import { moveObject } from './zones.ts';
import { subscribeEvents, type GameEvent } from './events.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type ManaPool,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function createEmptyManaPool(): ManaPool {
	return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

function makeSeat(index: number, isBot = false): LobbySeat {
	const deck = PRECON_DECKS[index % PRECON_DECKS.length];
	return {
		seatIndex: index,
		userId: `p${index + 1}`,
		username: `Player ${index + 1}`,
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

function makeGame(playerCount = 2): {
	state: GameState;
	players: PlayerGameState[];
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats = Array.from({ length: playerCount }, (_, i) => makeSeat(i, false));
	const state = createInitialGameState(
		'TIER1_COMBAT_TEST',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.battlefield = [];
		p.hand = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = createEmptyManaPool();
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return {
		state,
		players: state.players,
		p1: state.players[0],
		p2: state.players[1]
	};
}

let synthCounter = 0;
function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	synthCounter += 1;
	return {
		id: overrides.id ?? `synth_t1a_${synthCounter}`,
		oracleId: overrides.oracleId ?? `ora_t1a_${synthCounter}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		loyalty: overrides.loyalty ?? undefined,
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		setCode: 'TST',
		legalCommander: overrides.legalCommander ?? false,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false
	};
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
	}
	player[zone].push(inst);
	return inst;
}

function passAll(state: GameState): void {
	const count = state.players.filter((p) => !p.lost).length;
	for (let i = 0; i < count; i++) {
		const prioPlayer = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? `pass_priority failed for ${prioPlayer.playerId}`);
	}
}

describe('Tier 1 Item 3 — CR 506.4 / 506.4a / 510.1c Removal from Combat', () => {
	it('removes attackers and blockers from state.combat when they leave the battlefield (including flicker), keeping attacker wasBlocked = true (CR 506.4, 510.1c)', () => {
		const { state, p1, p2 } = makeGame();

		const atk1 = putInZone(
			state,
			p1,
			synthCard({ name: 'Flickered Attacker', power: '3', toughness: '3' }),
			'battlefield'
		);
		const atk2 = putInZone(
			state,
			p1,
			synthCard({ name: 'Blocked Attacker', power: '4', toughness: '4' }),
			'battlefield'
		);
		const blk = putInZone(
			state,
			p2,
			synthCard({ name: 'Flickered Blocker', power: '2', toughness: '2' }),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: atk1.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: atk2.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blk.instanceId, attackerInstanceId: atk2.instanceId }]
			}).ok,
			true
		);

		assert.equal(state.combat.attackers.length, 2);
		assert.deepEqual(state.combat.attackers[1].blockerInstanceIds, [blk.instanceId]);
		assert.equal(state.combat.attackers[1].wasBlocked, true);

		// Flicker atk1 (leaves battlefield to exile, then returns to battlefield with same instanceId)
		moveObject(state, atk1, 'exile', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			leaveBattlefieldReset: true,
			bumpVersion: true
		});
		assert.equal(
			state.combat.attackers.some((a) => a.attackerInstanceId === atk1.instanceId),
			false,
			'Attacker leaving the battlefield is immediately removed from state.combat.attackers (CR 506.4)'
		);
		moveObject(state, atk1, 'battlefield', {
			from: { player: p1, zone: 'exile' },
			toPlayer: p1,
			newTimestamp: true
		});

		// Flicker blk (leaves battlefield to exile, then returns to battlefield)
		moveObject(state, blk, 'exile', {
			from: { player: p2, zone: 'battlefield' },
			toPlayer: p2,
			leaveBattlefieldReset: true,
			bumpVersion: true
		});
		assert.deepEqual(
			state.combat.attackers[0].blockerInstanceIds,
			[],
			'Blocker leaving the battlefield is immediately removed from blockerInstanceIds (CR 506.4)'
		);
		assert.equal(
			state.combat.attackers[0].wasBlocked,
			true,
			'Attacker remains blocked (wasBlocked = true) after its blocker leaves combat (CR 510.1c)'
		);
		moveObject(state, blk, 'battlefield', {
			from: { player: p2, zone: 'exile' },
			toPlayer: p2,
			newTimestamp: true
		});

		const lifeBefore = p2.life;
		passAll(state); // -> combat_damage
		assert.equal(p2.life, lifeBefore, 'Neither flickered attacker nor blocked non-trample attacker deals damage to P2');
		assert.equal(blk.damageMarked, 0, 'Flickered blocker returned as new object and took no combat damage');
		assert.equal(atk2.damageMarked, 0, 'Flickered blocker dealt no combat damage to atk2');
	});

	it('removes attacking and blocking permanents from state.combat when they stop being creatures (CR 506.4)', () => {
		const { state, p1, p2 } = makeGame();

		const atk1 = putInZone(
			state,
			p1,
			synthCard({ name: 'Transformed Attacker', power: '4', toughness: '4' }),
			'battlefield'
		);
		const atk2 = putInZone(
			state,
			p1,
			synthCard({ name: 'Regular Attacker', power: '3', toughness: '3' }),
			'battlefield'
		);
		const blk = putInZone(
			state,
			p2,
			synthCard({ name: 'Transformed Blocker', power: '2', toughness: '2' }),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: atk1.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: atk2.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blk.instanceId, attackerInstanceId: atk2.instanceId }]
			}).ok,
			true
		);

		// Attach type-changing Auras so atk1 and blk become Forest lands and stop being creatures (CR 506.4)
		const landifyAura1 = putInZone(
			state,
			p2,
			synthCard({
				name: 'Tree Form 1',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant permanent\nEnchanted permanent is a colorless Forest land.'
			}),
			'battlefield'
		);
		landifyAura1.attachedToId = atk1.instanceId;

		const landifyAura2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Tree Form 2',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant permanent\nEnchanted permanent is a colorless Forest land.'
			}),
			'battlefield'
		);
		landifyAura2.attachedToId = blk.instanceId;

		checkStateBasedActions(state);

		assert.equal(
			state.combat.attackers.some((a) => a.attackerInstanceId === atk1.instanceId),
			false,
			'Permanent that stopped being a creature is removed from state.combat.attackers (CR 506.4)'
		);
		const atk2Entry = state.combat.attackers.find((a) => a.attackerInstanceId === atk2.instanceId);
		assert.ok(atk2Entry);
		assert.deepEqual(
			atk2Entry.blockerInstanceIds,
			[],
			'Blocker that stopped being a creature is removed from blockerInstanceIds (CR 506.4)'
		);
		assert.equal(
			atk2Entry.wasBlocked,
			true,
			'Attacker remains blocked after its blocker stopped being a creature (CR 510.1c)'
		);
	});
});

describe('Tier 1 Item 2 — CR 506.4c / 510.1b / 702.19f Attacked Planeswalker Removed from Combat', () => {
	it('deals 0 combat damage to defending player when an unblocked planeswalker attacker loses its planeswalker (left battlefield, phased out, or lost Planeswalker type)', () => {
		const { state, p1, p2 } = makeGame();

		const pw1 = putInZone(
			state,
			p2,
			synthCard({
				name: 'Targeted Walker 1',
				typeLine: 'Legendary Planeswalker — Jace',
				loyalty: '4',
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);
		pw1.counters.loyalty = 4;

		const pw2 = putInZone(
			state,
			p2,
			synthCard({
				name: 'Targeted Walker 2',
				typeLine: 'Legendary Planeswalker — Chandra',
				loyalty: '4',
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);
		pw2.counters.loyalty = 4;

		const atk1 = putInZone(
			state,
			p1,
			synthCard({ name: 'Unblocked Striker', power: '4', toughness: '4' }),
			'battlefield'
		);
		const atk2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Unblocked Trampler',
				power: '5',
				toughness: '5',
				oracleText: 'Trample',
				keywords: ['Trample']
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: atk1.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: pw1.instanceId
					},
					{
						attackerInstanceId: atk2.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: pw2.instanceId
					}
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: []
			}).ok,
			true
		);

		// pw1 leaves the battlefield; pw2 stops being a planeswalker via an Aura
		moveObject(state, pw1, 'graveyard', {
			from: { player: p2, zone: 'battlefield' },
			toPlayer: p2,
			leaveBattlefieldReset: true
		});
		const landifyPw2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Walker into Land',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant permanent\nEnchanted permanent is a colorless Forest land.'
			}),
			'battlefield'
		);
		landifyPw2.attachedToId = pw2.instanceId;
		checkStateBasedActions(state);

		const lifeBefore = p2.life;
		passAll(state); // -> combat_damage

		assert.equal(
			p2.life,
			lifeBefore,
			'Unblocked creatures attacking planeswalkers that left combat deal 0 damage to defending player (CR 506.4c, 510.1b, 702.19f)'
		);
		assert.equal(
			pw2.counters.loyalty,
			4,
			'Permanent that stopped being a planeswalker was removed from combat and lost no loyalty counters (CR 506.4c)'
		);
	});

	it('assigns all Trample damage to blockers (or deals 0 if blockers also left) and never redirects excess to the defending player when the attacked planeswalker left combat (CR 702.19f)', () => {
		const { state, p1, p2 } = makeGame();

		const pw = putInZone(
			state,
			p2,
			synthCard({
				name: 'Doomed Walker',
				typeLine: 'Legendary Planeswalker — Garruk',
				loyalty: '3',
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);
		pw.counters.loyalty = 3;

		const trampleAtk1 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Trample Beast 1',
				power: '5',
				toughness: '5',
				oracleText: 'Trample',
				keywords: ['Trample']
			}),
			'battlefield'
		);
		const trampleAtk2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Trample Beast 2',
				power: '4',
				toughness: '4',
				oracleText: 'Trample',
				keywords: ['Trample']
			}),
			'battlefield'
		);

		const survivingBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Indestructible Blocker',
				power: '1',
				toughness: '2',
				oracleText: 'Indestructible',
				keywords: ['Indestructible']
			}),
			'battlefield'
		);
		const leavingBlocker = putInZone(
			state,
			p2,
			synthCard({ name: 'Leaving Blocker', power: '1', toughness: '2' }),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: trampleAtk1.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: pw.instanceId
					},
					{
						attackerInstanceId: trampleAtk2.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: pw.instanceId
					}
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: survivingBlocker.instanceId, attackerInstanceId: trampleAtk1.instanceId },
					{ blockerInstanceId: leavingBlocker.instanceId, attackerInstanceId: trampleAtk2.instanceId }
				]
			}).ok,
			true
		);

		// Remove the attacked planeswalker AND leavingBlocker before combat damage
		moveObject(state, pw, 'exile', {
			from: { player: p2, zone: 'battlefield' },
			toPlayer: p2,
			leaveBattlefieldReset: true
		});
		moveObject(state, leavingBlocker, 'graveyard', {
			from: { player: p2, zone: 'battlefield' },
			toPlayer: p2,
			leaveBattlefieldReset: true
		});

		const lifeBefore = p2.life;
		passAll(state); // -> combat_damage

		assert.equal(
			p2.life,
			lifeBefore,
			'Trample attackers attacking a removed planeswalker deal 0 combat damage to the defending player (CR 702.19f)'
		);
		assert.equal(
			survivingBlocker.damageMarked,
			5,
			'All 5 combat damage from trampleAtk1 was assigned to its blocker since the attacked planeswalker left combat (CR 702.19b, 702.19f)'
		);
	});
});

describe('Tier 1 Item 1 — CR 120.3d / 120.4 / 122.1c / 510.2 / 702.16e / 702.80a / 702.90c Unified Combat Damage Pipeline', () => {
	it('prevents combat damage against creatures with Protection (while still allowing Trample over lethal assignment per CR 702.19b) and prevents Lifelink from prevented damage (CR 702.16e)', () => {
		const { state, p1, p2 } = makeGame();

		const redTrampler = putInZone(
			state,
			p1,
			synthCard({
				name: 'Red Lifelink Trampler',
				power: '5',
				toughness: '5',
				colors: ['R'],
				oracleText: 'Trample, lifelink',
				keywords: ['Trample', 'Lifelink']
			}),
			'battlefield'
		);
		const proRedBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Pro-Red Knight',
				power: '2',
				toughness: '2',
				colors: ['W'],
				oracleText: 'Protection from red',
				keywords: ['Protection from red']
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: redTrampler.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: proRedBlocker.instanceId, attackerInstanceId: redTrampler.instanceId }
				]
			}).ok,
			true
		);

		const p1LifeBefore = p1.life;
		const p2LifeBefore = p2.life;
		passAll(state); // -> combat_damage

		assert.equal(
			proRedBlocker.damageMarked,
			0,
			'Protection from red prevented the 2 combat damage assigned to the blocker (CR 702.16e)'
		);
		assert.equal(
			p2.life,
			p2LifeBefore - 3,
			'Trample still assigned 2 lethal to the 2/2 blocker and 3 excess to the defending player (CR 702.19b)'
		);
		assert.equal(
			p1.life,
			p1LifeBefore + 3,
			'Lifelink only gained life equal to the 3 unprevented damage actually dealt (CR 120.3f)'
		);
		assert.equal(
			redTrampler.damageMarked,
			2,
			'Pro-Red blocker still dealt its 2 combat damage to the attacker'
		);
	});

	it('applies Wither as -1/-1 counters on creatures (with simultaneity under CR 510.2) and normal life loss on players (CR 120.3d, 702.80a)', () => {
		const { state, p1, p2 } = makeGame();

		const witherBlocked = putInZone(
			state,
			p1,
			synthCard({
				name: 'Wither Attacker',
				power: '2',
				toughness: '4',
				oracleText: 'Wither',
				keywords: ['Wither']
			}),
			'battlefield'
		);
		const witherUnblocked = putInZone(
			state,
			p1,
			synthCard({
				name: 'Wither Unblocked',
				power: '3',
				toughness: '3',
				oracleText: 'Wither',
				keywords: ['Wither']
			}),
			'battlefield'
		);
		const blocker = putInZone(
			state,
			p2,
			synthCard({ name: 'Sturdy Blocker', power: '3', toughness: '4' }),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: witherBlocked.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: witherUnblocked.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blocker.instanceId, attackerInstanceId: witherBlocked.instanceId }]
			}).ok,
			true
		);

		const counterEvents: Array<Extract<GameEvent, { kind: 'CounterPlaced' }>> = [];
		const unsub = subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'CounterPlaced') counterEvents.push(ev);
		});

		const p2LifeBefore = p2.life;
		passAll(state); // -> combat_damage
		unsub();

		assert.equal(
			blocker.counters['-1/-1'],
			2,
			'Wither combat damage placed two -1/-1 counters on the blocker (CR 702.80a)'
		);
		assert.equal(
			counterEvents.length,
			1,
			'Wither/Infect combat damage routes through addCountersToPermanent and emits CounterPlaced (CR 122.6)'
		);
		assert.equal(counterEvents[0].objectId, blocker.instanceId);
		assert.equal(counterEvents[0].counterType, '-1/-1');
		assert.equal(counterEvents[0].amount, 2);
		assert.equal(
			blocker.damageMarked,
			0,
			'Wither combat damage is not marked as regular damage on the blocker (CR 120.3d)'
		);
		assert.equal(
			witherBlocked.damageMarked,
			3,
			'Blocker dealt its full pre-damage 3 power simultaneously before Wither -1/-1 counters reduced its power (CR 510.2)'
		);
		assert.equal(
			p2.life,
			p2LifeBefore - 3,
			'Unblocked Wither creature causes life loss (not poison) to the defending player (CR 120.3a)'
		);
		assert.equal(p2.poison, 0);
	});

	it('prevents combat damage with shield counters (CR 122.1c) and damagePreventionShield (CR 615.7), while SBA lethal-damage destruction does not consume a shield counter (CR 122.1c vs 704.5g)', () => {
		const { state, p1, p2 } = makeGame();

		const atk1 = putInZone(
			state,
			p1,
			synthCard({ name: 'Heavy Attacker', power: '4', toughness: '4' }),
			'battlefield'
		);
		const atk2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Commander Attacker',
				typeLine: 'Legendary Creature — Warrior',
				power: '5',
				toughness: '5',
				legalCommander: true,
				canBeCommander: true
			}),
			'battlefield'
		);
		atk2.isCommander = true;

		const shieldedBlocker = putInZone(
			state,
			p2,
			synthCard({ name: 'Shielded Blocker', power: '1', toughness: '2' }),
			'battlefield'
		);
		shieldedBlocker.counters.shield = 1;

		// Prevent 2 of the 5 unblocked commander damage to P2
		p2.damagePreventionShield = 2;

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: atk1.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: atk2.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: shieldedBlocker.instanceId, attackerInstanceId: atk1.instanceId }
				]
			}).ok,
			true
		);

		const p2LifeBefore = p2.life;
		passAll(state); // -> combat_damage

		assert.equal(
			shieldedBlocker.counters.shield,
			0,
			'Shield counter was removed to prevent combat damage (CR 122.1c)'
		);
		assert.equal(
			shieldedBlocker.damageMarked,
			0,
			'Combat damage to creature with shield counter was prevented (CR 122.1c)'
		);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === shieldedBlocker.instanceId),
			true,
			'Shielded blocker survived combat'
		);
		assert.equal(
			p2.life,
			p2LifeBefore - 3,
			'Player damagePreventionShield prevented 2 of 5 combat damage (CR 615.7)'
		);
		assert.equal(
			p2.commanderDamageTaken[atk2.instanceId],
			3,
			'Commander combat damage tracks only the 3 unprevented combat damage actually dealt (CR 903.10a)'
		);

		// Verify CR 122.1c vs CR 704.5g: if a creature already has lethal damage marked and then gets a shield counter,
		// the lethal-damage SBA still destroys it because CR 704.5g is not "destroyed as the result of an effect".
		shieldedBlocker.damageMarked = 2;
		shieldedBlocker.counters.shield = 1;
		checkStateBasedActions(state);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === shieldedBlocker.instanceId),
			false,
			'Lethal damage SBA (CR 704.5g) destroys creature even with a shield counter because SBA is not an effect (CR 122.1c)'
		);
	});

	it('respects static lifeTotalCantChange rule modifiers during combat damage and lifelink while still dealing combat damage and tracking Commander damage (CR 119.7, 120.3a, 903.10a)', () => {
		const { state, p1, p2 } = makeGame();

		// Both players have "Your life total can't change."
		putInZone(
			state,
			p1,
			synthCard({
				name: 'P1 Emperion',
				typeLine: 'Artifact Creature — Golem',
				power: '8',
				toughness: '8',
				oracleText: "Your life total can't change."
			}),
			'battlefield'
		);
		putInZone(
			state,
			p2,
			synthCard({
				name: 'P2 Emperion',
				typeLine: 'Artifact Creature — Golem',
				power: '8',
				toughness: '8',
				oracleText: "Your life total can't change."
			}),
			'battlefield'
		);

		const cmdLifelinker = putInZone(
			state,
			p1,
			synthCard({
				name: 'Lifelink Commander',
				typeLine: 'Legendary Creature — Angel',
				power: '4',
				toughness: '4',
				oracleText: 'Lifelink',
				keywords: ['Lifelink'],
				legalCommander: true,
				canBeCommander: true
			}),
			'battlefield'
		);
		cmdLifelinker.isCommander = true;

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: cmdLifelinker.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: []
			}).ok,
			true
		);

		const p1LifeBefore = p1.life;
		const p2LifeBefore = p2.life;
		passAll(state); // -> combat_damage

		assert.equal(
			p2.life,
			p2LifeBefore,
			'Static lifeTotalCantChange modifier prevented P2 life total from decreasing (CR 119.7)'
		);
		assert.equal(
			p1.life,
			p1LifeBefore,
			'Static lifeTotalCantChange modifier prevented P1 life total from increasing via Lifelink (CR 119.7)'
		);
		assert.equal(
			p2.commanderDamageTaken[cmdLifelinker.instanceId],
			4,
			'Commander combat damage is still dealt and tracked even when life total cannot change (CR 120.3a, 903.10a)'
		);
	});
});
