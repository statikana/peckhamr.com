import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
	botDelayMs,
	capturePreActionSnapshot,
	executeBotStep,
	runAutomatedPriorityAndBots,
	type BotPauseKind
} from './ai.ts';
import { applyGameAction, createCardInstance, createInitialGameState } from './engine.ts';
import { PRECON_DECKS } from './precons.ts';
import { enqueueChoicePrompt } from './runtime/choices.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type ScryfallCard,
	type ZoneType
} from './types.ts';

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function withDeterminism<T>(seed: number, fn: () => T): T {
	let clock = 1_700_000_000_000;
	mock.method(Math, 'random', mulberry32(seed));
	mock.method(Date, 'now', () => (clock += 7));
	try {
		return fn();
	} finally {
		mock.restoreAll();
	}
}

function makeCard(overrides: Partial<ScryfallCard> & Pick<ScryfallCard, 'name' | 'typeLine'>): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '',
		cmc: overrides.cmc ?? 0,
		typeLine: overrides.typeLine,
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: false,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function inst(state: GameState, card: ScryfallCard, ownerId: string, zone: ZoneType): CardInstance {
	return createCardInstance(card, ownerId, zone, false, false, undefined, state);
}

function makePodGame(
	seatSpecs: Array<{ isBot: boolean; userId: string | null; username: string }>,
	seed = 42
): GameState {
	const seats: LobbySeat[] = seatSpecs.map((spec, idx) => ({
		seatIndex: idx,
		userId: spec.userId,
		username: spec.username,
		avatarUrl: '',
		isBot: spec.isBot,
		deckId: PRECON_DECKS[idx % PRECON_DECKS.length].id,
		deckName: PRECON_DECKS[idx % PRECON_DECKS.length].name,
		commanderNames: PRECON_DECKS[idx % PRECON_DECKS.length].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: PRECON_DECKS[idx % PRECON_DECKS.length].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 1_700_000_000_000
	}));
	const decksBySeat = new Map(
		seats.map((s, idx) => [s.seatIndex, PRECON_DECKS[idx % PRECON_DECKS.length]])
	);
	return withDeterminism(seed, () =>
		createInitialGameState('PACE01', seats, decksBySeat, { ...DEFAULT_LOBBY_RULES })
	);
}

const BASIC_FOREST = makeCard({
	name: 'Forest',
	typeLine: 'Basic Land — Forest',
	oracleText: '({T}: Add {G}.)',
	colorIdentity: ['G']
});

const GRIZZLY_BEARS = makeCard({
	name: 'Grizzly Bears',
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Creature — Bear',
	oracleText: '',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '2',
	toughness: '2'
});

const SHORT_SWORD = makeCard({
	name: 'Short Sword',
	manaCost: '{1}',
	cmc: 1,
	typeLine: 'Artifact — Equipment',
	oracleText: 'Equipped creature gets +1/+1.\nEquip {1}'
});

const COUNTERSPELL = makeCard({
	name: 'Counterspell',
	manaCost: '{U}{U}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText: 'Counter target spell.',
	colors: ['U'],
	colorIdentity: ['U']
});

const BASIC_ISLAND = makeCard({
	name: 'Island',
	typeLine: 'Basic Land — Island',
	oracleText: '({T}: Add {U}.)',
	colorIdentity: ['U']
});

const UNCASTABLE_GOLEM = makeCard({
	name: 'Colossus',
	manaCost: '{9}{G}{G}',
	cmc: 11,
	typeLine: 'Creature — Golem',
	power: '10',
	toughness: '10',
	colors: ['G'],
	colorIdentity: ['G']
});

describe('ai.ts bot pacing mode', () => {
	it('steps through a bot turn one visible action at a time (turn_start -> play_land -> cast_spell -> equip -> attack)', () => {
		const state = makePodGame([
			{ isBot: false, userId: 'u_human', username: 'Alice' },
			{ isBot: true, userId: null, username: 'Liliana (AI Bot)' }
		]);

		assert.equal(applyGameAction(state, 'u_human', { type: 'mulligan_keep' }).ok, true);
		const alice = state.players[0];
		const liliana = state.players[1];
		alice.hand = [];
		liliana.command = [];

		const f1 = inst(state, BASIC_FOREST, liliana.playerId, 'battlefield');
		const f2 = inst(state, BASIC_FOREST, liliana.playerId, 'battlefield');
		const attacker = inst(state, GRIZZLY_BEARS, liliana.playerId, 'battlefield');
		attacker.summoningSick = false;
		const sword = inst(state, SHORT_SWORD, liliana.playerId, 'battlefield');
		liliana.battlefield = [f1, f2, attacker, sword];

		const handLand = inst(state, BASIC_FOREST, liliana.playerId, 'hand');
		const handBear = inst(state, GRIZZLY_BEARS, liliana.playerId, 'hand');
		liliana.hand = [handLand, handBear];
		liliana.library.unshift(inst(state, UNCASTABLE_GOLEM, liliana.playerId, 'library'));

		const preEndTurn = capturePreActionSnapshot(state);
		assert.equal(applyGameAction(state, 'u_human', { type: 'end_turn' }).ok, true);

		// Run 1: Turn advanced to Liliana -> pauses at turn_start BEFORE Liliana draws or plays a land
		const r1 = runAutomatedPriorityAndBots(state, { pace: true, preAction: preEndTurn });
		assert.deepEqual(r1, { paused: true, pausedFor: 'turn_start' });
		assert.equal(state.activePlayerIndex, 1);
		assert.equal(state.phase, 'upkeep');
		assert.equal(liliana.landsPlayedThisTurn, 0);
		assert.equal(state.stack.length, 0);

		// Run 2: Liliana quietly passes upkeep & draw, enters main1, and plays her Forest -> pauses immediately
		const r2 = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(r2, { paused: true, pausedFor: 'action' });
		assert.equal(state.phase, 'main1');
		assert.equal(liliana.landsPlayedThisTurn, 1);
		assert.equal(state.stack.length, 0);

		// Run 3: Liliana casts Grizzly Bears -> pauses while spell sits on the stack
		const r3 = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(r3, { paused: true, pausedFor: 'action' });
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].card.name, 'Grizzly Bears');

		// Run 4: Priority passes around (Alice auto-passes), Grizzly Bears resolves, then Liliana activates Equip -> pauses
		const r4 = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(r4, { paused: true, pausedFor: 'action' });
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].kind, 'activated');

		// Run 5: Equip resolves, Main 1 & Begin Combat pass quietly, Liliana declares attackers -> pauses
		const r5 = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(r5, { paused: true, pausedFor: 'action' });
		assert.equal(state.phase, 'declare_attackers');
		assert.equal(state.combat.attackers.length, 1);
		assert.equal(sword.attachedToId !== undefined && sword.attachedToId !== null, true);

		// Run 6: Enters declare_blockers -> stops at defending human Alice with { paused: false }
		const r6 = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(r6, { paused: false });
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(state.priorityPlayerIndex, 0);

		// Alice confirms 0 blockers -> combat damage resolves (3 dmg), Main 2 & End Step pass quietly -> Alice's Turn 2!
		assert.equal(
			applyGameAction(state, 'u_human', { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		const r7 = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(r7, { paused: false });
		assert.equal(state.activePlayerIndex, 0);
		assert.equal(alice.life, 37);
	});

	it('never pauses on quiet steps (0 attackers, 0 blockers, bookkeeping prompts) and pauses on visible prompts', () => {
		const state = makePodGame([
			{ isBot: false, userId: 'u_human', username: 'Alice' },
			{ isBot: true, userId: null, username: 'Liliana (AI Bot)' }
		]);
		assert.equal(applyGameAction(state, 'u_human', { type: 'mulligan_keep' }).ok, true);
		const alice = state.players[0];
		const liliana = state.players[1];
		alice.hand = [];
		liliana.hand = [];
		liliana.command = [];
		liliana.library.unshift(inst(state, UNCASTABLE_GOLEM, liliana.playerId, 'library'));

		const pre = capturePreActionSnapshot(state);
		assert.equal(applyGameAction(state, 'u_human', { type: 'end_turn' }).ok, true);

		// Turn start pauses once
		const startRes = runAutomatedPriorityAndBots(state, { pace: true, preAction: pre });
		assert.deepEqual(startRes, { paused: true, pausedFor: 'turn_start' });

		// Queue bookkeeping prompts (scry_choice + single-option trigger_order): neither should pause!
		const topCard = liliana.library[0];
		enqueueChoicePrompt(state, {
			id: 'prm_scry_quiet',
			playerId: liliana.playerId,
			kind: 'scry_choice',
			purpose: 'scry_choice',
			title: 'Scry 1',
			description: 'Scry 1',
			candidateInstanceIds: [topCard.instanceId],
			choice: {
				kind: 'orderObjects',
				objectIds: [topCard.instanceId],
				allowSplitBottom: true,
				reason: 'Scry 1'
			}
		});

		// Entire rest of Liliana's turn (scry, upkeep/draw/main1 passes, 0 attackers declared, end step) finishes in ONE run!
		const restRes = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(restRes, { paused: false });
		assert.equal(state.activePlayerIndex, 0);

		// Advance Alice's Turn 2 from upkeep -> draw -> main1
		while (state.phase !== 'main1') {
			assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
			assert.equal(runAutomatedPriorityAndBots(state, { pace: true }).paused, false);
		}
		alice.hand = [];

		// Case A: Liliana has NO creatures -> 0 blockers declared -> quiet!
		const atkBear = inst(state, GRIZZLY_BEARS, alice.playerId, 'battlefield');
		atkBear.summoningSick = false;
		alice.battlefield.push(atkBear);

		assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
		assert.equal(runAutomatedPriorityAndBots(state, { pace: true }).paused, false);
		assert.equal(state.phase, 'begin_combat');
		assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
		assert.equal(runAutomatedPriorityAndBots(state, { pace: true }).paused, false);
		assert.equal(state.phase, 'declare_attackers');
		const preAtk = capturePreActionSnapshot(state);
		assert.equal(
			applyGameAction(state, 'u_human', {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: atkBear.instanceId, defenderPlayerId: liliana.playerId }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
		const zeroBlockRes = runAutomatedPriorityAndBots(state, { pace: true, preAction: preAtk });
		// Liliana declared 0 blockers quietly (did NOT pause!) and priority returned to active human Alice in declare_blockers
		assert.deepEqual(zeroBlockRes, { paused: false });
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(state.priorityPlayerIndex, 0);
		assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
		assert.deepEqual(runAutomatedPriorityAndBots(state, { pace: true }), { paused: false });
		// Combat damage step -> active human Alice passes priority -> main2 with Liliana at 38 life
		if (state.phase === 'combat_damage') {
			assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
			assert.deepEqual(runAutomatedPriorityAndBots(state, { pace: true }), { paused: false });
		}
		if (state.phase === 'end_combat') {
			assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
			assert.deepEqual(runAutomatedPriorityAndBots(state, { pace: true }), { paused: false });
		}
		assert.equal(state.phase, 'main2');
		assert.equal(liliana.life, 38);

		// Visible prompt check: give Liliana a legend_rule choice on Alice's main2 -> pauses with pausedFor: 'action'!
		const legCard = makeCard({
			name: 'Isamaru, Hound of Konda',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Legendary Creature — Dog',
			colors: ['W'],
			colorIdentity: ['W'],
			power: '2',
			toughness: '2'
		});
		const leg1 = inst(state, legCard, liliana.playerId, 'battlefield');
		const leg2 = inst(state, legCard, liliana.playerId, 'battlefield');
		liliana.battlefield.push(leg1, leg2);
		enqueueChoicePrompt(state, {
			id: 'prm_vis_legend',
			playerId: liliana.playerId,
			kind: 'legend_rule',
			purpose: 'legend_rule',
			title: 'Legend Rule',
			description: 'Choose one legendary permanent to keep',
			candidateInstanceIds: [leg1.instanceId, leg2.instanceId]
		});
		const visPromptRes = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(visPromptRes, { paused: true, pausedFor: 'action' });
		assert.equal(liliana.graveyard.length, 1);
	});

	it('pauses when a defending bot declares >= 1 blocker', () => {
		const state = makePodGame([
			{ isBot: false, userId: 'u_human', username: 'Alice' },
			{ isBot: true, userId: null, username: 'Liliana (AI Bot)' }
		]);
		assert.equal(applyGameAction(state, 'u_human', { type: 'mulligan_keep' }).ok, true);
		const alice = state.players[0];
		const liliana = state.players[1];
		alice.hand = [];
		liliana.hand = [];

		const attacker = inst(state, GRIZZLY_BEARS, alice.playerId, 'battlefield');
		attacker.summoningSick = false;
		alice.battlefield.push(attacker);

		const centaur = inst(
			state,
			makeCard({
				name: 'Centaur Courser',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Centaur Warrior',
				colors: ['G'],
				colorIdentity: ['G'],
				power: '3',
				toughness: '3'
			}),
			liliana.playerId,
			'battlefield'
		);
		liliana.battlefield.push(centaur);

		assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
		runAutomatedPriorityAndBots(state, { pace: true });
		assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);
		runAutomatedPriorityAndBots(state, { pace: true });
		assert.equal(state.phase, 'declare_attackers');

		assert.equal(
			applyGameAction(state, 'u_human', {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: liliana.playerId }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, 'u_human', { type: 'pass_priority' }).ok, true);

		const blkRes = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(blkRes, { paused: true, pausedFor: 'action' });
		assert.equal(state.phase, 'declare_blockers');
		assert.deepEqual(state.combat.attackers[0].blockerInstanceIds, [centaur.instanceId]);
	});

	it('reaches the exact same final GameState in 1 unpaced run as N paced runs (same seed, 3 bots)', () => {
		const baseState = makePodGame(
			[
				{ isBot: false, userId: 'u_human', username: 'Alice' },
				{ isBot: true, userId: null, username: 'Teferi (AI Bot)' },
				{ isBot: true, userId: null, username: 'Liliana (AI Bot)' },
				{ isBot: true, userId: null, username: 'Chandra (AI Bot)' }
			],
			1337
		);
		assert.equal(applyGameAction(baseState, 'u_human', { type: 'mulligan_keep' }).ok, true);
		baseState.players[0].hand = [];
		baseState.players[0].library = Array.from({ length: 10 }, () =>
			inst(baseState, BASIC_FOREST, baseState.players[0].playerId, 'library')
		);

		const unpacedState: GameState = JSON.parse(JSON.stringify(baseState));
		const pacedState: GameState = JSON.parse(JSON.stringify(baseState));

		for (let round = 0; round < 2; round++) {
			const pauseKinds: BotPauseKind[] = [];

			// Advance Alice from upkeep -> main1 if needed, and play her drawn land so hand stays empty
			for (const st of [unpacedState, pacedState]) {
				while (st.activePlayerIndex === 0 && st.phase !== 'main1') {
					assert.equal(applyGameAction(st, 'u_human', { type: 'pass_priority' }).ok, true);
					runAutomatedPriorityAndBots(st, { maxSteps: 1500 });
				}
				const aliceLand = st.players[0].hand[0];
				if (aliceLand) {
					assert.equal(
						applyGameAction(st, 'u_human', { type: 'play_land', instanceId: aliceLand.instanceId }).ok,
						true
					);
				}
			}

			while (true) {
				withDeterminism(5000 + round, () => {
					if (unpacedState.activePlayerIndex === 0) {
						assert.equal(applyGameAction(unpacedState, 'u_human', { type: 'end_turn' }).ok, true);
					} else if (
						unpacedState.phase === 'declare_blockers' &&
						unpacedState.priorityPlayerIndex === 0
					) {
						assert.equal(
							applyGameAction(unpacedState, 'u_human', { type: 'declare_blockers', assignments: [] }).ok,
							true
						);
					}
					const res = runAutomatedPriorityAndBots(unpacedState, { maxSteps: 1500 });
					assert.deepEqual(res, { paused: false });
				});

				withDeterminism(5000 + round, () => {
					const pre = capturePreActionSnapshot(pacedState);
					if (pacedState.activePlayerIndex === 0) {
						assert.equal(applyGameAction(pacedState, 'u_human', { type: 'end_turn' }).ok, true);
					} else if (
						pacedState.phase === 'declare_blockers' &&
						pacedState.priorityPlayerIndex === 0
					) {
						assert.equal(
							applyGameAction(pacedState, 'u_human', { type: 'declare_blockers', assignments: [] }).ok,
							true
						);
					}

					let first = true;
					for (let guard = 0; guard < 200; guard++) {
						const res = runAutomatedPriorityAndBots(pacedState, {
							maxSteps: 1500,
							pace: true,
							...(first ? { preAction: pre } : {})
						});
						first = false;
						if (!res.paused) break;
						pauseKinds.push(res.pausedFor!);
					}
				});

				if (unpacedState.activePlayerIndex === 0) {
					break;
				}
			}

			assert.equal(
				pauseKinds.filter((k) => k === 'turn_start').length,
				3,
				`Round ${round + 1}: expected 3 bot turn_start pauses, got ${JSON.stringify(pauseKinds)}`
			);
			assert.ok(
				pauseKinds.filter((k) => k === 'action').length >= 3,
				`Round ${round + 1}: expected >= 3 visible bot actions, got ${JSON.stringify(pauseKinds)}`
			);

			const stripTimestamps = (s: GameState) => {
				const c: GameState = JSON.parse(JSON.stringify(s));
				c.turnStartedAt = 0;
				c.priorityUpdatedAt = 0;
				c.recentVfxEvents = c.recentVfxEvents.map((v) => ({ ...v, timestamp: 0 }));
				c.log = c.log.map((l) => ({ ...l, timestamp: 0 }));
				c.stack = c.stack.map((st) => ({ ...st, createdAt: 0 }));
				return c;
			};
			assert.deepEqual(stripTimestamps(pacedState), stripTimestamps(unpacedState));
			assert.equal(pacedState.rngState, unpacedState.rngState);
		}
	});

	it('stops with { paused: false } when a human holds priority with an instant response or has a prompt, and pauses Turn 1 when Seat 0 is a bot', () => {
		const state = makePodGame([
			{ isBot: false, userId: 'u_human', username: 'Alice' },
			{ isBot: true, userId: null, username: 'Liliana (AI Bot)' }
		]);
		assert.equal(applyGameAction(state, 'u_human', { type: 'mulligan_keep' }).ok, true);
		const alice = state.players[0];
		const liliana = state.players[1];
		alice.command = [];
		liliana.command = [];

		const i1 = inst(state, BASIC_ISLAND, alice.playerId, 'battlefield');
		const i2 = inst(state, BASIC_ISLAND, alice.playerId, 'battlefield');
		const cs = inst(state, COUNTERSPELL, alice.playerId, 'hand');
		alice.battlefield = [i1, i2];
		alice.hand = [cs];

		const f1 = inst(state, BASIC_FOREST, liliana.playerId, 'battlefield');
		const f2 = inst(state, BASIC_FOREST, liliana.playerId, 'battlefield');
		const bear = inst(state, GRIZZLY_BEARS, liliana.playerId, 'hand');
		liliana.battlefield = [f1, f2];
		liliana.hand = [bear];
		liliana.library.unshift(inst(state, UNCASTABLE_GOLEM, liliana.playerId, 'library'));

		const pre = capturePreActionSnapshot(state);
		assert.equal(applyGameAction(state, 'u_human', { type: 'end_turn' }).ok, true);

		// 1) Pauses for Liliana's turn_start
		assert.deepEqual(runAutomatedPriorityAndBots(state, { pace: true, preAction: pre }), {
			paused: true,
			pausedFor: 'turn_start'
		});
		// 2) Liliana casts Grizzly Bears -> pauses for 'action'
		assert.deepEqual(runAutomatedPriorityAndBots(state, { pace: true }), {
			paused: true,
			pausedFor: 'action'
		});
		assert.equal(state.stack.length, 1);

		// 3) Next advance: Liliana passes priority on her spell, and because Alice can cast Counterspell,
		//    the loop MUST stop at Alice's priority with { paused: false }!
		const stopForAlice = runAutomatedPriorityAndBots(state, { pace: true });
		assert.deepEqual(stopForAlice, { paused: false });
		assert.equal(state.priorityPlayerIndex, 0);
		assert.equal(state.stack.length, 1);

		// Also verify Seat-0 bot Turn 1 pauses on turn_start right after human mulligan_keep
		const botFirstState = makePodGame([
			{ isBot: true, userId: null, username: 'Teferi (AI Bot)' },
			{ isBot: false, userId: 'u_human', username: 'Alice' }
		]);
		const preMull = capturePreActionSnapshot(botFirstState);
		assert.equal(applyGameAction(botFirstState, 'u_human', { type: 'mulligan_keep' }).ok, true);
		const turnOnePause = runAutomatedPriorityAndBots(botFirstState, {
			pace: true,
			preAction: preMull
		});
		assert.deepEqual(turnOnePause, { paused: true, pausedFor: 'turn_start' });
		assert.equal(botFirstState.activePlayerIndex, 0);
		assert.equal(botFirstState.players[0].landsPlayedThisTurn, 0);
		assert.equal(typeof executeBotStep, 'function');
	});

	it('botDelayMs returns 0 for instant, stays within configured speed ranges, uses low end for turn_start, and is deterministic', () => {
		assert.equal(botDelayMs('instant', 'action', 'ABC123', 1), 0);
		assert.equal(botDelayMs('instant', 'turn_start', 'ABC123', 99), 0);

		const expectations = [
			{ speed: 'fast' as const, min: 400, max: 700, turnStartMax: 475 },
			{ speed: 'normal' as const, min: 900, max: 1600, turnStartMax: 1075 },
			{ speed: 'slow' as const, min: 1800, max: 3000, turnStartMax: 2100 }
		];

		for (const { speed, min, max, turnStartMax } of expectations) {
			const actionValues = new Set<number>();
			for (let v = 1; v <= 100; v++) {
				const dAction = botDelayMs(speed, 'action', 'POD777', v);
				assert.ok(
					dAction >= min && dAction <= max,
					`${speed} action delay ${dAction} outside [${min}, ${max}]`
				);
				assert.equal(dAction, botDelayMs(speed, 'action', 'POD777', v));
				actionValues.add(dAction);

				const dTurn = botDelayMs(speed, 'turn_start', 'POD777', v);
				assert.ok(
					dTurn >= min && dTurn <= turnStartMax,
					`${speed} turn_start delay ${dTurn} outside low end [${min}, ${turnStartMax}]`
				);
				assert.equal(dTurn, botDelayMs(speed, 'turn_start', 'POD777', v));
			}
			assert.ok(actionValues.size > 20, `Expected deterministic jitter spread for ${speed}`);
		}

		// Missing / undefined speed defaults to 'normal'
		assert.equal(
			botDelayMs(undefined, 'action', 'LEGACY', 5),
			botDelayMs('normal', 'action', 'LEGACY', 5)
		);
	});
});
