import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	runBeginningOfTurn
} from '../engine.ts';
import { transferBattlefieldControl } from './zones.ts';
import { subscribeEvents } from './events.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GamePhase,
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
		'WAVE3A_TEST',
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
		id: overrides.id ?? `synth_w3a_${synthCounter}`,
		oracleId: overrides.oracleId ?? `ora_w3a_${synthCounter}`,
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
		loyalty: overrides.loyalty ?? null,
		legalities: { commander: 'legal' },
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		setName: 'Test',
		setCode: 'TST'
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

describe('Wave 3A — 1. CR 703.3 Turn-Based Action Ordering, CR 702.26a/g Phasing & CR 122.1d Stun Counters', () => {
	it('simultaneously phases out permanents with Phasing (plus indirect attachments) and phases in phased-out permanents (including cross-controller indirect Auras) during untap (CR 702.26a/g)', () => {
		const { state, p1, p2 } = makeGame();

		// 1. P1 controls a phased-in creature with Phasing, with an opponent-controlled Aura attached to it
		const phasingOutHost = putInZone(
			state,
			p1,
			synthCard({
				name: 'Breezekeeper',
				typeLine: 'Creature — Djinn',
				oracleText: 'Phasing',
				keywords: ['Phasing']
			}),
			'battlefield'
		);
		const oppAuraOnPhasingOut = putInZone(
			state,
			p2,
			synthCard({
				name: 'Opp Curse Aura',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature'
			}),
			'battlefield'
		);
		oppAuraOnPhasingOut.attachedToId = phasingOutHost.instanceId;

		// 2. P1 controls an already phased-out creature (which also has Phasing) with a cross-controller indirectly phased-out Aura on P2's battlefield
		const phasingInHost = putInZone(
			state,
			p1,
			synthCard({
				name: 'Sandbar Crocodile',
				typeLine: 'Creature — Crocodile',
				oracleText: 'Phasing',
				keywords: ['Phasing']
			}),
			'battlefield'
		);
		phasingInHost.phasedOut = true;
		phasingInHost.phasedOutIndirectly = false;

		const oppAuraOnPhasingIn = putInZone(
			state,
			p2,
			synthCard({
				name: 'Opp Pacifism Aura',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature'
			}),
			'battlefield'
		);
		oppAuraOnPhasingIn.attachedToId = phasingInHost.instanceId;
		oppAuraOnPhasingIn.phasedOut = true;
		oppAuraOnPhasingIn.phasedOutIndirectly = true;

		// 3. P1 also controls an indirectly phased-out Aura attached to a phased-out creature on P2's battlefield (must NOT phase in on P1's turn!)
		const p2PhasedOutHost = putInZone(
			state,
			p2,
			synthCard({
				name: 'P2 Phased Creature',
				typeLine: 'Creature — Bear'
			}),
			'battlefield'
		);
		p2PhasedOutHost.phasedOut = true;
		p2PhasedOutHost.phasedOutIndirectly = false;

		const p1IndirectAuraOnP2Host = putInZone(
			state,
			p1,
			synthCard({
				name: 'P1 Indirect Aura',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature'
			}),
			'battlefield'
		);
		p1IndirectAuraOnP2Host.attachedToId = p2PhasedOutHost.instanceId;
		p1IndirectAuraOnP2Host.phasedOut = true;
		p1IndirectAuraOnP2Host.phasedOutIndirectly = true;

		runBeginningOfTurn(state);

		// Breezekeeper phased out and took oppAuraOnPhasingOut with it indirectly
		assert.equal(phasingOutHost.phasedOut, true, 'Phased-in permanent with Phasing phased out');
		assert.equal(phasingOutHost.phasedOutIndirectly, false);
		assert.equal(oppAuraOnPhasingOut.phasedOut, true, 'Attachment phased out indirectly with host');
		assert.equal(oppAuraOnPhasingOut.phasedOutIndirectly, true);

		// Sandbar Crocodile phased in (and did not re-phase out in the same step!) along with P2's indirectly phased-out Aura
		assert.equal(phasingInHost.phasedOut, false, 'Previously phased-out permanent phased in');
		assert.equal(phasingInHost.phasedOutIndirectly, false);
		assert.equal(
			oppAuraOnPhasingIn.phasedOut,
			false,
			'Cross-controller indirectly phased-out attachment phased in with its host (CR 702.26g)'
		);
		assert.equal(oppAuraOnPhasingIn.phasedOutIndirectly, false);

		// P1's indirectly phased-out Aura attached to P2's still-phased-out creature stayed phased out
		assert.equal(
			p1IndirectAuraOnP2Host.phasedOut,
			true,
			'Indirectly phased-out attachment whose host is on P2 battlefield stays phased out during P1 untap'
		);
	});

	it('only removes a stun counter during untap if the permanent is actually tapped and would untap (CR 122.1d)', () => {
		const { state, p1 } = makeGame();

		const untappedWithStun = putInZone(
			state,
			p1,
			synthCard({ name: 'Untapped Stunned Bear' }),
			'battlefield'
		);
		untappedWithStun.tapped = false;
		untappedWithStun.counters.stun = 2;

		const tappedWithStun = putInZone(
			state,
			p1,
			synthCard({ name: 'Tapped Stunned Bear' }),
			'battlefield'
		);
		tappedWithStun.tapped = true;
		tappedWithStun.counters.stun = 1;

		runBeginningOfTurn(state);

		assert.equal(
			untappedWithStun.counters.stun,
			2,
			'Already-untapped permanent did not lose a stun counter during untap (CR 122.1d)'
		);
		assert.equal(untappedWithStun.tapped, false);

		assert.equal(
			tappedWithStun.counters.stun,
			0,
			'Tapped permanent removed 1 stun counter instead of untapping'
		);
		assert.equal(tappedWithStun.tapped, true);
	});

	it('executes turn-based actions in untap, draw, combat_damage, and cleanup BEFORE emitting PhaseBegin and flushing step triggers (CR 703.3)', () => {
		const { state, p1, p2 } = makeGame();
		state.turnNumber = 2;

		const tappedPerm = putInZone(state, p1, synthCard({ name: 'Tapped Elf' }), 'battlefield');
		tappedPerm.tapped = true;

		const attacker = putInZone(
			state,
			p1,
			synthCard({ name: 'Blade Bear', power: '3', toughness: '3' }),
			'battlefield'
		);
		attacker.tempPowerMod = 2;

		let untapDoneBeforePhaseBegin = false;
		let drawDoneBeforePhaseBegin = false;
		let damageDoneBeforePhaseBegin = false;
		let cleanupDoneBeforePhaseBegin = false;

		const handBeforeTurn = p1.hand.length;
		const p2LifeBefore = p2.life;

		const unsub = subscribeEvents(state, (st, ev) => {
			if (ev.kind === 'PhaseBegin') {
				if (ev.phase === 'untap') {
					untapDoneBeforePhaseBegin = tappedPerm.tapped === false;
				} else if (ev.phase === 'draw') {
					drawDoneBeforePhaseBegin = p1.hand.length === handBeforeTurn + 1;
				} else if (ev.phase === 'combat_damage') {
					damageDoneBeforePhaseBegin = p2.life < p2LifeBefore;
				} else if (ev.phase === 'cleanup') {
					cleanupDoneBeforePhaseBegin = attacker.tempPowerMod === 0;
				}
			}
		});

		// 1. Run beginning of turn -> untap, then upkeep
		runBeginningOfTurn(state);
		assert.equal(
			untapDoneBeforePhaseBegin,
			true,
			'Untap turn-based action completed before PhaseBegin("untap")'
		);
		assert.equal(state.phase, 'upkeep');

		// 2. Pass priority in upkeep -> enters draw step
		passAll(state);
		assert.equal(state.phase, 'draw');
		assert.equal(
			drawDoneBeforePhaseBegin,
			true,
			'Draw step card draw completed before PhaseBegin("draw")'
		);

		// 3. Pass priority in draw -> main1 -> begin_combat -> declare_attackers
		passAll(state);
		assert.equal(state.phase, 'main1');
		passAll(state);
		assert.equal(state.phase, 'begin_combat');
		passAll(state);
		assert.equal(state.phase, 'declare_attackers');

		// 4. Declare attacker, pass priority in declare_attackers -> declare_blockers -> combat_damage
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		passAll(state);
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		passAll(state);
		assert.equal(state.phase, 'combat_damage');
		assert.equal(
			damageDoneBeforePhaseBegin,
			true,
			'Combat damage turn-based action completed before PhaseBegin("combat_damage")'
		);

		// 5. Pass priority through combat_damage -> end_combat -> main2 -> end_step -> cleanup
		passAll(state);
		assert.equal(state.phase, 'end_combat');
		passAll(state);
		assert.equal(state.phase, 'main2');
		passAll(state);
		assert.equal(state.phase, 'end_step');
		passAll(state);
		assert.equal(
			cleanupDoneBeforePhaseBegin,
			true,
			'Cleanup turn-based action cleared EOT modifiers before PhaseBegin("cleanup")'
		);

		unsub();
	});
});

describe('Wave 3A — 2. CR 106.4 / 500.4 Mana Pool Emptying on Every Step & Phase Transition', () => {
	it('empties all players mana pools at the end of every step and phase', () => {
		const { state, p1, p2 } = makeGame();
		state.turnNumber = 2;

		const giveBothPlayersMana = () => {
			p1.manaPool = { W: 2, U: 1, B: 0, R: 0, G: 3, C: 1 };
			p2.manaPool = { W: 0, U: 2, B: 1, R: 4, G: 0, C: 0 };
		};
		const assertBothPoolsEmpty = (stepLabel: string) => {
			assert.deepEqual(
				p1.manaPool,
				createEmptyManaPool(),
				`P1 mana pool should be empty after ${stepLabel}`
			);
			assert.deepEqual(
				p2.manaPool,
				createEmptyManaPool(),
				`P2 mana pool should be empty after ${stepLabel}`
			);
		};

		const attacker = putInZone(
			state,
			p1,
			synthCard({ name: 'Step Bear', power: '2', toughness: '2' }),
			'battlefield'
		);

		// 1. untap -> upkeep empties both players' mana pools
		giveBothPlayersMana();
		runBeginningOfTurn(state);
		assert.equal(state.phase, 'upkeep');
		assertBothPoolsEmpty('untap -> upkeep');

		// 2. upkeep -> draw
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'draw');
		assertBothPoolsEmpty('upkeep -> draw');

		// 3. draw -> main1
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'main1');
		assertBothPoolsEmpty('draw -> main1');

		// 4. main1 -> begin_combat
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'begin_combat');
		assertBothPoolsEmpty('main1 -> begin_combat');

		// 5. begin_combat -> declare_attackers
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'declare_attackers');
		assertBothPoolsEmpty('begin_combat -> declare_attackers');

		// 6. declare_attackers -> declare_blockers
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'declare_blockers');
		assertBothPoolsEmpty('declare_attackers -> declare_blockers');

		// 7. declare_blockers -> combat_damage
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'combat_damage');
		assertBothPoolsEmpty('declare_blockers -> combat_damage');

		// 8. combat_damage -> end_combat
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'end_combat');
		assertBothPoolsEmpty('combat_damage -> end_combat');

		// 9. end_combat -> main2
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'main2');
		assertBothPoolsEmpty('end_combat -> main2');

		// 10. main2 -> end_step
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'end_step');
		assertBothPoolsEmpty('main2 -> end_step');

		// 11. end_step -> cleanup -> next turn upkeep
		giveBothPlayersMana();
		passAll(state);
		assert.equal(state.phase, 'upkeep');
		assertBothPoolsEmpty('end_step -> cleanup');
	});
});

describe('Wave 3A — 3. CR 506–511 Combat Step Sequence & CR 500.2 Priority Stops', () => {
	it('fires "At the beginning of combat" in begin_combat, keeps attackers/blockers in combat through end_combat (CR 511.3), and fires "At end of combat" triggers', () => {
		const { state, p1, p2 } = makeGame();

		const beginCombatWatcher = putInZone(
			state,
			p1,
			synthCard({
				name: 'War Horn',
				typeLine: 'Artifact',
				oracleText: 'At the beginning of combat on your turn, you gain 2 life.'
			}),
			'battlefield'
		);
		assert.ok(beginCombatWatcher);

		const endCombatWatcher = putInZone(
			state,
			p1,
			synthCard({
				name: 'Peace Chime',
				typeLine: 'Artifact',
				oracleText: 'At end of combat, you gain 3 life.'
			}),
			'battlefield'
		);
		assert.ok(endCombatWatcher);

		const attacker = putInZone(
			state,
			p1,
			synthCard({ name: 'Vanguard Knight', power: '2', toughness: '4' }),
			'battlefield'
		);
		const blocker = putInZone(
			state,
			p2,
			synthCard({ name: 'Shield Wall', power: '1', toughness: '4' }),
			'battlefield'
		);

		const lifeStart = p1.life;

		// Advance main1 -> begin_combat
		passAll(state);
		assert.equal(state.phase, 'begin_combat');
		assert.equal(state.stack.length, 1, 'Beginning of combat trigger placed on stack');
		passAll(state); // resolve War Horn trigger
		assert.equal(p1.life, lifeStart + 2, 'War Horn gained 2 life in begin_combat');

		// Pass empty stack in begin_combat -> declare_attackers
		passAll(state);
		assert.equal(state.phase, 'declare_attackers');

		// Declare attacker -> stays in declare_attackers with active player priority (CR 508.2)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		assert.equal(
			state.phase,
			'declare_attackers',
			'Remains in declare_attackers after declaring attackers (CR 508.2)'
		);
		assert.equal(state.priorityPlayerIndex, 0, 'Active player receives priority in declare_attackers');

		// Pass priority in declare_attackers -> declare_blockers
		passAll(state);
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(state.priorityPlayerIndex, 1, 'Defending player receives priority to declare blockers');

		// Declare blocker -> stays in declare_blockers
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: blocker.instanceId, attackerInstanceId: attacker.instanceId }
				]
			}).ok,
			true
		);
		assert.equal(state.phase, 'declare_blockers');

		// Pass priority in declare_blockers -> combat_damage
		passAll(state);
		assert.equal(state.phase, 'combat_damage');

		// Pass priority in combat_damage -> end_combat
		passAll(state);
		assert.equal(state.phase, 'end_combat');
		assert.equal(
			state.combat.active,
			true,
			'Combat remains active during end_combat step (CR 511.3)'
		);
		assert.equal(
			state.combat.attackers.length,
			1,
			'Attacker is still an attacking creature during end_combat (CR 511.3)'
		);
		assert.deepEqual(
			state.combat.attackers[0].blockerInstanceIds,
			[blocker.instanceId],
			'Blocker is still a blocking creature during end_combat (CR 511.3)'
		);
		assert.equal(state.stack.length, 1, 'At end of combat trigger placed on stack');
		passAll(state); // resolve Peace Chime trigger
		assert.equal(p1.life, lifeStart + 5, 'Peace Chime gained 3 life in end_combat');

		// Pass empty stack in end_combat -> main2, clearing state.combat
		passAll(state);
		assert.equal(state.phase, 'main2');
		assert.equal(state.combat.active, false, 'Combat cleared upon leaving end_combat for main2');
		assert.equal(state.combat.attackers.length, 0);
	});

	it('skips declare_blockers, combat_damage, and end_combat straight to main2 when 0 attackers are declared and priority passes in declare_attackers (CR 508.8)', () => {
		const { state, p1 } = makeGame();
		state.phase = 'declare_attackers';

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: []
			}).ok,
			true
		);
		assert.equal(
			state.phase,
			'declare_attackers',
			'Active player still gets priority in declare_attackers after declaring 0 attackers (CR 508.2)'
		);

		passAll(state);
		assert.equal(
			state.phase,
			'main2',
			'Skipped declare_blockers, combat_damage, and end_combat directly to main2 (CR 508.8)'
		);
	});
});

describe('Wave 3A — 4. CR 508.1b / 509.1 / 701.15b / 702.16e / 702.19c Attack & Block Validation & Trample to Planeswalker', () => {
	it('validates defenderPlaneswalkerId in declare_attackers (CR 508.1b) and routes excess Trample combat damage to the attacked Planeswalker when blocked (CR 702.19c)', () => {
		const { state, p1, p2 } = makeGame();

		const trampler = putInZone(
			state,
			p1,
			synthCard({
				name: 'Siege Rhino-Beast',
				power: '5',
				toughness: '5',
				oracleText: 'Trample',
				keywords: ['Trample']
			}),
			'battlefield'
		);
		const chumpBlocker = putInZone(
			state,
			p2,
			synthCard({ name: 'Chump Squire', power: '2', toughness: '2' }),
			'battlefield'
		);
		const planeswalker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Test Planeswalker',
				typeLine: 'Legendary Planeswalker — Jace',
				loyalty: '5'
			}),
			'battlefield'
		);
		planeswalker.counters.loyalty = 5;

		state.phase = 'declare_attackers';

		// 1. Non-existent defenderPlaneswalkerId is rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: trampler.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: 'non_existent_pw'
					}
				]
			}).ok,
			false,
			'Rejects non-existent defenderPlaneswalkerId (CR 508.1b)'
		);

		// 2. Non-planeswalker permanent as defenderPlaneswalkerId is rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: trampler.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: chumpBlocker.instanceId
					}
				]
			}).ok,
			false,
			'Rejects non-planeswalker permanent as defenderPlaneswalkerId (CR 508.1b)'
		);

		// 3. Valid Planeswalker on defending player's battlefield is accepted
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: trampler.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: planeswalker.instanceId
					}
				]
			}).ok,
			true
		);

		passAll(state);
		assert.equal(state.phase, 'declare_blockers');

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: chumpBlocker.instanceId,
						attackerInstanceId: trampler.instanceId
					}
				]
			}).ok,
			true
		);

		const p2LifeBefore = p2.life;
		passAll(state); // advance to combat_damage

		assert.equal(
			planeswalker.counters.loyalty,
			2,
			'Blocked 5/5 Trample attacking a 5-loyalty Planeswalker dealt 2 to 2/2 blocker and 3 excess damage to the Planeswalker (CR 702.19c)'
		);
		assert.equal(
			p2.life,
			p2LifeBefore,
			'Defending player took 0 trample damage when their Planeswalker was being attacked (CR 702.19c)'
		);
	});

	it('enforces Goad in declare_attackers: must attack a player other than the goader if able (CR 701.15b)', () => {
		const { state, players, p1 } = makeGame(3);
		const p2 = players[1];
		const p3 = players[2];

		const goadedCreature = putInZone(
			state,
			p1,
			synthCard({ name: 'Goaded Brute', power: '4', toughness: '4' }),
			'battlefield'
		);
		goadedCreature.goadedByPlayerIds = [p2.playerId];

		state.phase = 'declare_attackers';

		// Attacking the goader (P2) when P3 is a legal non-goader defender must be rejected
		const atkGoaderRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{
					attackerInstanceId: goadedCreature.instanceId,
					defenderPlayerId: p2.playerId
				}
			]
		});
		assert.equal(
			atkGoaderRes.ok,
			false,
			'Goaded creature cannot attack its goader when another player can be attacked (CR 701.15b)'
		);

		// Attacking P3 (not the goader) succeeds
		const atkOtherRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{
					attackerInstanceId: goadedCreature.instanceId,
					defenderPlayerId: p3.playerId
				}
			]
		});
		assert.equal(atkOtherRes.ok, true, atkOtherRes.error ?? '');
	});

	it('enforces stack empty, single declaration, no duplicate blockerInstanceId (CR 509.1a), cantBlock, and Protection (CR 702.16e) in declare_blockers', () => {
		const { state, p1, p2 } = makeGame();

		const atk1 = putInZone(
			state,
			p1,
			synthCard({
				name: 'White Knight Attacker',
				power: '2',
				toughness: '2',
				oracleText: 'Protection from black'
			}),
			'battlefield'
		);
		const atk2 = putInZone(
			state,
			p1,
			synthCard({ name: 'Vanilla Attacker', power: '2', toughness: '2' }),
			'battlefield'
		);

		const blackBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Black Zombie',
				colors: ['B'],
				colorIdentity: ['B'],
				manaCost: '{1}{B}'
			}),
			'battlefield'
		);
		const cantBlockCreature = putInZone(
			state,
			p2,
			synthCard({
				name: 'Reckless Runner',
				oracleText: "Reckless Runner can't block."
			}),
			'battlefield'
		);
		const legalBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Green Bear',
				colors: ['G'],
				colorIdentity: ['G'],
				manaCost: '{1}{G}'
			}),
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
		passAll(state);
		assert.equal(state.phase, 'declare_blockers');

		// 1. Cannot declare blockers while stack is non-empty
		state.stack.push({
			id: 'stk_test',
			sourceInstanceId: atk1.instanceId,
			card: atk1.card,
			controllerId: p1.playerId,
			kind: 'triggered',
			title: 'Test Trigger',
			oracleText: '',
			targets: [],
			xValue: 0,
			parsedEffects: [],
			requiresGuidedResolution: false,
			createdAt: 0
		});
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: []
			}).ok,
			false,
			'Cannot declare blockers while the stack is non-empty'
		);
		state.stack = [];

		// 2. Duplicate blockerInstanceId (blocking two attackers with one creature) is rejected (CR 509.1a)
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: legalBlocker.instanceId, attackerInstanceId: atk1.instanceId },
					{ blockerInstanceId: legalBlocker.instanceId, attackerInstanceId: atk2.instanceId }
				]
			}).ok,
			false,
			'Rejects duplicate blockerInstanceId blocking multiple attackers (CR 509.1a)'
		);

		// 3. Creature with cantBlock is rejected
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: cantBlockCreature.instanceId, attackerInstanceId: atk2.instanceId }
				]
			}).ok,
			false,
			'Rejects blocker with cantBlock restriction'
		);

		// 4. Black creature blocking attacker with Protection from black is rejected (CR 702.16e)
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: blackBlocker.instanceId, attackerInstanceId: atk1.instanceId }
				]
			}).ok,
			false,
			'Rejects blocker matching quality of attacker Protection (CR 702.16e)'
		);

		// 5. Valid block succeeds once, and a second declare_blockers in the same step is rejected (CR 509.1)
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: legalBlocker.instanceId, attackerInstanceId: atk1.instanceId }
				]
			}).ok,
			true
		);
		assert.equal(state.combat.blockersDeclared, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: []
			}).ok,
			false,
			'Rejects declaring blockers a second time in the same declare_blockers step'
		);
	});
});

describe('Wave 3A — 5. CR 510.2 Simultaneous Combat Damage & CR 702.7c Per-Creature First Strike Tracking', () => {
	it('tracks dealtFirstStrikeDamageIds per creature so a creature gaining First Strike after first_strike_damage still deals regular combat damage (CR 702.7c)', () => {
		const { state, p1, p2 } = makeGame();

		const fsAttacker = putInZone(
			state,
			p1,
			synthCard({
				name: 'First Striker',
				power: '2',
				toughness: '2',
				oracleText: 'First strike',
				keywords: ['First strike']
			}),
			'battlefield'
		);
		const lateFsAttacker = putInZone(
			state,
			p1,
			synthCard({
				name: 'Late Striker',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: fsAttacker.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: lateFsAttacker.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		passAll(state); // -> declare_blockers
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);

		const lifeStart = p2.life;
		passAll(state); // -> first_strike_damage
		assert.equal(state.phase, 'first_strike_damage');
		assert.equal(p2.life, lifeStart - 2, 'First Striker dealt 2 damage in first_strike_damage');
		assert.deepEqual(state.combat.dealtFirstStrikeDamageIds, [fsAttacker.instanceId]);

		// During first_strike_damage priority window, Late Striker gains First Strike!
		lateFsAttacker.grantedKeywords.push('First strike');

		passAll(state); // -> combat_damage
		assert.equal(state.phase, 'combat_damage');
		assert.equal(
			p2.life,
			lifeStart - 5,
			'Late Striker dealt 3 damage in regular combat_damage because it had not dealt first-strike damage (CR 702.7c)'
		);
	});

	it('snapshots combat damage simultaneously before Infect -1/-1 counters shrink the blocker (CR 510.2)', () => {
		const { state, p1, p2 } = makeGame();

		const infectAttacker = putInZone(
			state,
			p1,
			synthCard({
				name: 'Plague Stinger-Beast',
				power: '2',
				toughness: '4',
				oracleText: 'Infect',
				keywords: ['Infect']
			}),
			'battlefield'
		);
		const vanillaBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Sturdy Ogre',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: infectAttacker.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		passAll(state);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: vanillaBlocker.instanceId,
						attackerInstanceId: infectAttacker.instanceId
					}
				]
			}).ok,
			true
		);

		passAll(state); // -> combat_damage
		assert.equal(
			vanillaBlocker.counters['-1/-1'],
			2,
			'Infect attacker placed two -1/-1 counters on blocker'
		);
		assert.equal(
			infectAttacker.damageMarked,
			3,
			'Blocker dealt its full pre-damage 3 combat damage simultaneously before Infect -1/-1 counters reduced its power (CR 510.2)'
		);
	});
});

describe('Wave 3A — 6. CR 302.6 / 506.4b Control Change Combat Removal & Summoning Sickness', () => {
	it('sets summoningSick = true and removes the permanent from combat when control changes via transferBattlefieldControl (CR 302.6, 506.4b)', () => {
		const { state, p1, p2 } = makeGame();

		const attacker = putInZone(
			state,
			p1,
			synthCard({ name: 'Contested Warrior', power: '3', toughness: '3' }),
			'battlefield'
		);
		attacker.summoningSick = false;

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		assert.equal(state.combat.attackers.length, 1);

		// Transfer control of the attacking creature to P2 during combat
		transferBattlefieldControl(attacker, p1, p2, state);

		assert.equal(attacker.controllerId, p2.playerId);
		assert.equal(
			attacker.summoningSick,
			true,
			'Creature changing control becomes summoning sick under new controller (CR 302.6)'
		);
		assert.equal(
			state.combat.attackers.length,
			0,
			'Creature changing control is removed from combat (CR 506.4b)'
		);
	});
});
