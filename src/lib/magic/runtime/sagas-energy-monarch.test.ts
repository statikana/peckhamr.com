import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getEffectiveActivatedAbilities,
	getSagaFinalChapterNumber,
	setMonarch
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { subscribeEvents, type GameEvent } from './events.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type GamePhase,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function createGame(playerCount: 2 | 3 | 4 = 2): GameState {
	const seats: LobbySeat[] = Array.from({ length: playerCount }, (_, i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length];
		return {
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: false,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: deck.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: deck.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		};
	});
	const decks = new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]]));
	const state = createInitialGameState('TRACKP1', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.hand = [];
		p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	assert.equal(state.phase, 'main1');
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return state;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const ts = allocateTimestamp(state);
	const inst = createCardInstance(card, player.playerId, zone, false, false, ts, state);
	inst.summoningSick = false;
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		...(zone === 'library' ? { insert: 'start' } : {}),
		bumpVersion: true
	});
	return inst;
}

function resolveTopOfStack(state: GameState, maxSteps = 16): void {
	const topId = state.stack[state.stack.length - 1]?.id;
	if (!topId) return;
	for (
		let guard = 0;
		guard < maxSteps &&
		state.stack.some((item) => item.id === topId) &&
		state.pendingPrompts.length === 0;
		guard++
	) {
		const prio = state.players[state.priorityPlayerIndex];
		assert.ok(prio && !prio.lost, 'expected living priority player');
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
	}
}

function drainStack(state: GameState, maxSteps = 40): void {
	for (let guard = 0; guard < maxSteps; guard++) {
		const ord = state.pendingPrompts[0];
		if (ord && ord.purpose === 'trigger_order' && ord.choice?.kind === 'orderObjects') {
			const ids = ord.choice.objectIds;
			const res = applyGameAction(state, ord.playerId, {
				type: 'choice',
				promptId: ord.id,
				answer: { kind: 'orderObjects', topIds: [...ids], bottomIds: [] }
			});
			assert.equal(res.ok, true, res.error ?? 'trigger_order failed');
			continue;
		}
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const prio = state.players[state.priorityPlayerIndex];
		assert.ok(prio && !prio.lost, 'expected living priority player');
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
	}
}

function advanceTo(
	state: GameState,
	targetActiveIdx: number,
	targetPhase: GamePhase,
	stopOnStack = false,
	maxSteps = 120
): void {
	let leftInitialTarget =
		state.activePlayerIndex !== targetActiveIdx || state.phase !== targetPhase;
	for (let guard = 0; guard < maxSteps; guard++) {
		if (state.activePlayerIndex !== targetActiveIdx || state.phase !== targetPhase) {
			leftInitialTarget = true;
		}
		if (
			leftInitialTarget &&
			state.activePlayerIndex === targetActiveIdx &&
			state.phase === targetPhase
		) {
			return;
		}
		if (stopOnStack && leftInitialTarget && state.stack.length > 0) {
			return;
		}
		assert.equal(state.pendingPrompts.length, 0, 'unexpected pending prompt while advancing');
		const prio = state.players[state.priorityPlayerIndex];
		assert.ok(prio && !prio.lost, 'expected living priority player');
		if (
			state.phase === 'declare_attackers' &&
			prio.playerId === state.players[state.activePlayerIndex]?.playerId &&
			!state.combat.active
		) {
			const res = applyGameAction(state, prio.playerId, {
				type: 'declare_attackers',
				assignments: []
			});
			assert.equal(res.ok, true, res.error ?? 'declare_attackers failed');
			continue;
		}
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `[phase=${state.phase}, prio=${prio.playerId}] ${res.error}`);
	}
	assert.fail(
		`advanceTo timed out waiting for active=${targetActiveIdx} phase=${targetPhase} (got active=${state.activePlayerIndex} phase=${state.phase})`
	);
}

function castFromHand(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	targets?: TargetRef[],
	modeIndex?: number
): void {
	const res = applyGameAction(state, player.playerId, {
		type: 'cast_spell',
		instanceId: inst.instanceId,
		...(targets ? { targets } : {}),
		...(modeIndex !== undefined ? { modeIndex } : {})
	});
	assert.equal(res.ok, true, res.error ?? `cast_spell failed for ${inst.card.name}`);
}

function answerTopPrompt(state: GameState, player: PlayerGameState, answer: ChoiceAnswer): void {
	const prompt = state.pendingPrompts[0];
	assert.ok(prompt, 'expected a pending prompt');
	assert.equal(prompt.playerId, player.playerId);
	const res = applyGameAction(state, player.playerId, {
		type: 'choice',
		promptId: prompt.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? 'choice failed');
}

describe('Track P1 — Group 1: Saga 3-chapter lifecycle & Read ahead (CR 715.1–4, 704.5s, 702.155)', () => {
	it('runs a 3-chapter Saga across turns and waits for Chapter III to leave the stack before sacrificing (CR 715.3a/b, 715.4, 704.5s)', () => {
		const state = createGame(2);
		const [p1] = state.players;

		const sagaCard = makeCard({
			name: 'History of Benalia',
			manaCost: '{1}{W}{W}',
			cmc: 3,
			typeLine: 'Enchantment — Saga',
			oracleText:
				'(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\n' +
				'I — You gain 2 life.\n' +
				'II — Draw a card.\n' +
				'III — Create a 2/2 white Knight creature token with vigilance.',
			colors: ['W'],
			colorIdentity: ['W']
		});
		const def = compileCard(sagaCard);
		assert.equal(def.fullySupported, true);
		assert.equal(def.faces[0].abilities.length, 3);

		const sagaInst = putInZone(state, p1, sagaCard, 'hand');
		castFromHand(state, p1, sagaInst);

		// Resolve Saga spell -> enters battlefield with 1 lore counter (CR 715.3a) and triggers Chapter I
		resolveTopOfStack(state);
		const onBoard = p1.battlefield.find((c) => c.instanceId === sagaInst.instanceId);
		assert.ok(onBoard, 'Saga should be on the battlefield');
		assert.equal(onBoard.counters.lore, 1);
		assert.equal(getSagaFinalChapterNumber(state, onBoard), 3);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].isChapterAbility, true);

		// Resolve Chapter I -> gain 2 life, Saga stays on battlefield
		drainStack(state);
		assert.equal(p1.life, 42);
		assert.ok(p1.battlefield.some((c) => c.instanceId === sagaInst.instanceId));

		// Advance through P2's turn into P1's next precombat main phase -> lore counter #2 & Chapter II
		const handBeforeTurn2Main1 = p1.hand.length;
		advanceTo(state, 0, 'main1');
		assert.equal(onBoard.counters.lore, 2, 'CR 715.3b should place lore counter #2 at main1');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].isChapterAbility, true);

		// P1 drew 1 card in draw_step + 1 card from Chapter II resolving
		drainStack(state);
		assert.equal(p1.hand.length, handBeforeTurn2Main1 + 2);
		assert.ok(p1.battlefield.some((c) => c.instanceId === sagaInst.instanceId));

		// Advance through P2's turn into P1's third precombat main phase -> lore counter #3 & Chapter III
		advanceTo(state, 0, 'main1');
		assert.equal(onBoard.counters.lore, 3, 'CR 715.3b should place lore counter #3 at main1');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].isChapterAbility, true);

		// CR 715.4 / CR 704.5s: Saga MUST stay on the battlefield while Chapter III is still on the stack
		checkStateBasedActions(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === sagaInst.instanceId),
			true,
			'Saga must NOT be sacrificed while its chapter ability is still on the stack'
		);

		// Resolve Chapter III -> Knight token created, then SBA immediately sacrifices the Saga
		drainStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === sagaInst.instanceId),
			false,
			'Saga should leave the battlefield once its final chapter resolves'
		);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === sagaInst.instanceId),
			true,
			'Saga should be sacrificed to its owner graveyard (CR 704.5s)'
		);
		const knightToken = p1.battlefield.find(
			(c) => c.isToken && evaluatePermanent(state, c).hasSubType('Knight')
		);
		assert.ok(knightToken, 'Chapter III should have created the 2/2 Knight token');
		assert.equal(evaluatePermanent(state, knightToken).power, 2);
		assert.equal(evaluatePermanent(state, knightToken).toughness, 2);
	});

	it('keeps Read ahead Sagas as keyword_not_implemented and skips CR 715.3a automatic ETB lore placement', () => {
		const readAheadSaga = makeCard({
			name: 'Founding the Third Path',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Enchantment — Saga',
			oracleText:
				'Read ahead (Choose a chapter and start with that many lore counters. Add one after your draw step. Skipped chapters don\'t trigger. Sacrifice after III.)\n' +
				'I — You gain 1 life.\n' +
				'II — Draw a card.\n' +
				'III — Target opponent loses 2 life.',
			colors: ['U'],
			colorIdentity: ['U'],
			keywords: ['Read ahead']
		});
		const def = compileCard(readAheadSaga);
		assert.equal(def.fullySupported, false);
		assert.equal(def.faces[0].hasReadAhead, true);
		assert.equal(
			def.faces[0].abilities.some(
				(a) => a.kind === 'unsupported' && a.reason === 'keyword_not_implemented'
			),
			true
		);

		const state = createGame(2);
		const [p1] = state.players;
		const inst = putInZone(state, p1, readAheadSaga, 'battlefield');
		assert.equal(inst.counters.lore ?? 0, 0, 'Read ahead Saga skips CR 715.3a non-Read-ahead 1 lore');
	});
});

describe('Track P1 — Group 2: Multi-chapter lines, counter doublers, flavor words, & ability loss (CR 715.2b–d)', () => {
	it('triggers every crossed chapter threshold when a counter doubler puts 2 lore counters on ETB (CR 715.2b–c)', () => {
		const state = createGame(2);
		const [p1] = state.players;

		putInZone(
			state,
			p1,
			makeCard({
				name: 'Season of Doubling',
				manaCost: '{4}{G}',
				cmc: 5,
				typeLine: 'Enchantment',
				oracleText:
					'If an effect would put one or more counters on a permanent you control, it puts twice that many of each of those kinds of counters on that permanent instead.',
				colors: ['G'],
				colorIdentity: ['G']
			}),
			'battlefield'
		);

		const groupedSaga = makeCard({
			name: 'Dual Chronicle',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Enchantment — Saga',
			oracleText: 'I, II — You gain 3 life.\nIII — Draw a card.',
			colors: ['W'],
			colorIdentity: ['W']
		});
		const def = compileCard(groupedSaga);
		assert.equal(def.fullySupported, true);

		const sagaInst = putInZone(state, p1, groupedSaga, 'hand');
		castFromHand(state, p1, sagaInst);
		resolveTopOfStack(state);

		const onBoard = p1.battlefield.find((c) => c.instanceId === sagaInst.instanceId);
		assert.ok(onBoard);
		assert.equal(onBoard.counters.lore, 2, 'Doubler should put 2 lore counters on ETB (0 -> 2)');
		assert.equal(
			state.stack.filter((s) => s.isChapterAbility).length,
			2,
			'Crossing both I and II in one placement (0 -> 2) must trigger both Chapter I and Chapter II'
		);

		drainStack(state);
		assert.equal(p1.life, 46, 'Both Chapter I (+3) and Chapter II (+3) should resolve');
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === sagaInst.instanceId),
			'Saga stays on board at 2/3 lore counters'
		);
	});

	it('compiles Sagas with post-chapter flavor words, chapters IV+, and modal chapter effects', () => {
		const epicSaga = makeCard({
			name: 'Four-Act Ballad',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Enchantment — Saga',
			oracleText:
				'I — Overture — You gain 1 life.\n' +
				'II, III — Rising Action — Draw a card.\n' +
				'IV — Grand Finale — Choose one —\n' +
				'• You gain 4 life.\n' +
				'• Each opponent loses 3 life.',
			colors: ['B'],
			colorIdentity: ['B']
		});
		const def = compileCard(epicSaga);
		assert.equal(def.fullySupported, true);

		const state = createGame(2);
		const [p1, p2] = state.players;
		const inst = putInZone(state, p1, epicSaga, 'hand');
		castFromHand(state, p1, inst);
		resolveTopOfStack(state);
		const onBoard = p1.battlefield.find((c) => c.instanceId === inst.instanceId);
		assert.ok(onBoard);
		assert.equal(getSagaFinalChapterNumber(state, onBoard), 4);
		drainStack(state);
		assert.equal(p1.life, 41);

		// Jump through turns to Chapter IV and verify modal choice + SBA sacrifice
		advanceTo(state, 0, 'main1');
		drainStack(state);
		advanceTo(state, 0, 'main1');
		drainStack(state);
		advanceTo(state, 0, 'main1');
		assert.equal(onBoard.counters.lore, 4);
		// Modal triggered ability prompts or resolves mode; drain prompts/stack
		for (let guard = 0; guard < 10 && (state.pendingPrompts.length > 0 || state.stack.length > 0); guard++) {
			if (state.pendingPrompts.length > 0) {
				const pr = state.pendingPrompts[0];
				if (pr.choice?.kind === 'chooseMode') {
					answerTopPrompt(state, p1, { kind: 'chooseMode', indices: [1] });
				} else {
					break;
				}
			} else {
				resolveTopOfStack(state);
			}
		}
		assert.equal(p2.life, 37, 'Modal Chapter IV mode 2 should make opponent lose 3 life');
		assert.equal(p1.graveyard.some((c) => c.instanceId === inst.instanceId), true);
	});

	it('treats finalChapterNumber as 0 under Layer 6 ability loss, suppressing main1 lore and SBA sacrifice (CR 715.2d, 715.4)', () => {
		const state = createGame(2);
		const [p1] = state.players;

		const saga = putInZone(
			state,
			p1,
			makeCard({
				name: 'Silenced Saga',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Enchantment — Saga',
				oracleText: 'I — You gain 1 life.\nII — Draw a card.\nIII — You gain 2 life.',
				colors: ['U'],
				colorIdentity: ['U']
			}),
			'battlefield'
		);
		drainStack(state);

		const muteAura = putInZone(
			state,
			p1,
			makeCard({
				name: 'Nullifying Veil',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant enchantment\nEnchanted enchantment loses all abilities.',
				colors: ['W'],
				colorIdentity: ['W']
			}),
			'battlefield'
		);
		muteAura.attachedToId = saga.instanceId;
		saga.counters.lore = 3;

		const ev = evaluatePermanent(state, saga);
		assert.equal(ev.hasLostAllAbilities, true);
		assert.equal(getSagaFinalChapterNumber(state, saga), 0, 'CR 715.2d: 0 chapter abilities -> 0');

		// SBA does NOT sacrifice a Saga whose finalChapterNumber is 0, even with 3 lore counters (CR 715.4)
		checkStateBasedActions(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === saga.instanceId), true);

		// Advancing to P1's next main1 does NOT add a lore counter while finalChapterNumber === 0 (CR 715.3b/c)
		advanceTo(state, 0, 'main1');
		assert.equal(saga.counters.lore, 3);
		assert.equal(p1.battlefield.some((c) => c.instanceId === saga.instanceId), true);

		// Once the Aura leaves the battlefield, finalChapterNumber returns to 3 and SBA sacrifices the Saga
		moveObject(state, muteAura, 'graveyard', {
			from: { zone: 'battlefield', player: p1 },
			toPlayer: p1,
			detachAttachments: true,
			bumpVersion: true,
			leaveBattlefieldReset: true
		});
		assert.equal(getSagaFinalChapterNumber(state, saga), 3);
		checkStateBasedActions(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === saga.instanceId), true);
	});
});

describe('Track P1 — Group 3: Energy {E} counters (CR 107.14, 122.1f, 122.2, 701.34a)', () => {
	it('gains {E}, auto-taps {T}, Pay {E} lands for colored mana, activates {E} abilities, and persists {E} across turns', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 2, C: 0 };

		// 1. ETB creature gives {E}{E}
		const rogue = putInZone(
			state,
			p1,
			makeCard({
				name: 'ThrivingSpark Weaver',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Elf Artificer',
				oracleText: 'When ~ enters, you get {E}{E}.',
				power: '2',
				toughness: '2',
				colors: ['G'],
				colorIdentity: ['G']
			}),
			'hand'
		);
		castFromHand(state, p1, rogue);
		drainStack(state);
		assert.equal(p1.energyCounters, 2);

		// 2. Play Aether Hub-style land -> ETB gives +1 {E} (total 3 {E})
		const hubCard = makeCard({
			name: 'Aether Hub',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText:
				'When ~ enters, you get {E}.\n{T}: Add {C}.\n{T}, Pay {E}: Add one mana of any color.'
		});
		assert.equal(compileCard(hubCard).fullySupported, true);
		const hub = putInZone(state, p1, hubCard, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: hub.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.energyCounters, 3);

		// 3. Cast a {B} spell with empty mana pool -> auto-taps Aether Hub using {T}, Pay {E}
		const darkPing = putInZone(
			state,
			p1,
			makeCard({
				name: 'Void Spark',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Target opponent loses 2 life.',
				colors: ['B'],
				colorIdentity: ['B']
			}),
			'hand'
		);
		castFromHand(state, p1, darkPing, [{ kind: 'player', id: p2.playerId, label: p2.username }]);
		drainStack(state);
		assert.equal(hub.tapped, true);
		assert.equal(p1.energyCounters, 2, 'Auto-tapping Aether Hub for {B} must deduct 1 {E}');
		assert.equal(p2.life, 38);

		// 4. Activate an artifact ability costing {T}, Pay {E}{E}
		const dynamo = putInZone(
			state,
			p1,
			makeCard({
				name: 'Conduit Cell',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{T}, Pay {E}{E}: Draw a card.'
			}),
			'battlefield'
		);
		const handBefore = p1.hand.length;
		const dynamoAb = getEffectiveActivatedAbilities(state, p1, dynamo)[0];
		assert.ok(dynamoAb, 'expected activated ability on Conduit Cell');
		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: dynamo.instanceId,
			abilityId: dynamoAb.id
		});
		assert.equal(actRes.ok, true, actRes.error ?? 'activate_ability failed');
		drainStack(state);
		assert.equal(p1.energyCounters, 0);
		assert.equal(p1.hand.length, handBefore + 1);

		// 5. Untap hub; at 0 {E}, casting another {B} spell must fail because {T}, Pay {E} cannot be paid
		hub.tapped = false;
		const secondPing = putInZone(
			state,
			p1,
			makeCard({
				name: 'Second Void Spark',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Target opponent loses 2 life.',
				colors: ['B'],
				colorIdentity: ['B']
			}),
			'hand'
		);
		const failedCast = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: secondPing.instanceId,
			targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
		});
		assert.equal(failedCast.ok, false, 'Cannot produce colored mana from Aether Hub at 0 {E}');

		// 6. CR 122.2: Energy counters persist across steps and turns (unlike mana)
		p1.energyCounters = 4;
		advanceTo(state, 1, 'main1');
		advanceTo(state, 0, 'main1');
		assert.equal(p1.energyCounters, 4, 'Energy counters must persist across steps and turns');
	});

	it('handles optional "you may pay {E}{E}. If you do, ..." triggers and energyCount scaling', () => {
		const state = createGame(2);
		const [p1] = state.players;
		p1.energyCounters = 3;

		const whaleCard = makeCard({
			name: 'Aether Siphoner',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Vedalken Wizard',
			oracleText: 'When ~ enters, you may pay {E}{E}. If you do, draw two cards.',
			power: '1',
			toughness: '3',
			colors: ['U'],
			colorIdentity: ['U']
		});
		assert.equal(compileCard(whaleCard).fullySupported, true);

		// Case A: Pay {E}{E} (3 -> 1) and draw 2 cards
		const inst1 = putInZone(state, p1, whaleCard, 'hand');
		const handBefore1 = p1.hand.length;
		castFromHand(state, p1, inst1);
		drainStack(state);
		assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');
		answerTopPrompt(state, p1, { kind: 'yesNo', yes: true });
		drainStack(state);
		assert.equal(p1.energyCounters, 1);
		assert.equal(p1.hand.length, handBefore1 - 1 + 2);

		// Case B: Insufficient {E} (only 1 {E} left for {E}{E}) -> cannot pay, no prompt, 0 cards drawn
		const inst2 = putInZone(state, p1, whaleCard, 'hand');
		const handBefore2 = p1.hand.length;
		castFromHand(state, p1, inst2);
		drainStack(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p1.energyCounters, 1);
		assert.equal(p1.hand.length, handBefore2 - 1);

		// Case C: Decline optional {E}{E} payment -> keeps energy, draws 0 cards
		p1.energyCounters = 2;
		const inst3 = putInZone(state, p1, whaleCard, 'hand');
		const handBefore3 = p1.hand.length;
		castFromHand(state, p1, inst3);
		drainStack(state);
		assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');
		answerTopPrompt(state, p1, { kind: 'yesNo', yes: false });
		drainStack(state);
		assert.equal(p1.energyCounters, 2);
		assert.equal(p1.hand.length, handBefore3 - 1);

		// Case D: Scaling with { k: 'energyCount' }
		p1.energyCounters = 5;
		const pulse = putInZone(
			state,
			p1,
			makeCard({
				name: 'Aether Vitalize',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'You gain life equal to the amount of {E} you have.',
				colors: ['G'],
				colorIdentity: ['G']
			}),
			'hand'
		);
		assert.equal(compileCard(pulse.card).fullySupported, true);
		castFromHand(state, p1, pulse);
		drainStack(state);
		assert.equal(p1.life, 45);
	});

	it('proliferates player {E} alongside poison/experience while leaving 0 {E} players at 0 (CR 701.34a)', () => {
		const state = createGame(3);
		const [p1, p2, p3] = state.players;

		// p1 has both {E} and poison; p2 has poison only (0 {E}); p3 has 0 counters of any kind
		p1.energyCounters = 3;
		p1.poison = 2;
		p1.experienceCounters = 1;
		p2.energyCounters = 0;
		p2.poison = 4;
		p3.energyCounters = 0;
		p3.poison = 0;

		const prolifSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Aether Bloom',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Proliferate.',
				colors: ['U'],
				colorIdentity: ['U']
			}),
			'hand'
		);
		castFromHand(state, p1, prolifSpell);
		drainStack(state);

		const prompt = state.pendingPrompts[0];
		assert.ok(prompt && prompt.choice?.kind === 'chooseObjects');
		assert.equal(prompt.choice.candidates.includes(p1.playerId), true);
		assert.equal(prompt.choice.candidates.includes(p2.playerId), true);
		assert.equal(
			prompt.choice.candidates.includes(p3.playerId),
			false,
			'Player with 0 counters cannot be chosen to proliferate'
		);

		answerTopPrompt(state, p1, {
			kind: 'chooseObjects',
			objectIds: [p1.playerId, p2.playerId]
		});
		drainStack(state);

		assert.equal(p1.energyCounters, 4, 'CR 701.34a: p1 gets +1 {E}');
		assert.equal(p1.poison, 3, 'CR 701.34a: p1 simultaneously gets +1 poison');
		assert.equal(p1.experienceCounters, 2, 'CR 701.34a: p1 simultaneously gets +1 experience');
		assert.equal(p2.poison, 5, 'CR 701.34a: p2 gets +1 poison');
		assert.equal(p2.energyCounters ?? 0, 0, 'Player with 0 {E} must remain at 0 {E}');
	});
});

describe('Track P1 — Group 4: The Monarch (CR 726.1–5, CR 800.4k)', () => {
	it('becomes the monarch, suppresses redundant CR 726.3 events, and resolves the CR 726.2 end-step draw trigger on the stack', () => {
		const state = createGame(2);
		const [p1] = state.players;

		const monarchEvents: GameEvent[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'BecameMonarch') monarchEvents.push(ev);
		});

		try {
			putInZone(
				state,
				p1,
				makeCard({
					name: 'Royal Herald',
					manaCost: '{2}{W}',
					cmc: 3,
					typeLine: 'Enchantment',
					oracleText: 'Whenever you become the monarch, you gain 3 life.',
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);

			const coronation = makeCard({
				name: 'Claim the Crown',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'You become the monarch.',
				colors: ['W'],
				colorIdentity: ['W']
			});
			assert.equal(compileCard(coronation).fullySupported, true);

			const c1 = putInZone(state, p1, coronation, 'hand');
			castFromHand(state, p1, c1);
			drainStack(state);

			assert.equal(state.monarchPlayerId, p1.playerId);
			assert.equal(monarchEvents.length, 1);
			assert.equal(p1.life, 43);

			// CR 726.3: Becoming the monarch while already the monarch is a no-op (no event, no trigger)
			const c2 = putInZone(state, p1, coronation, 'hand');
			castFromHand(state, p1, c2);
			drainStack(state);
			assert.equal(monarchEvents.length, 1, 'CR 726.3: redundant becomeMonarch must not emit BecameMonarch');
			assert.equal(p1.life, 43);

			// Advance to P1's end_step and stop while the CR 726.2 inherent trigger is on the stack
			const handBeforeEnd = p1.hand.length;
			advanceTo(state, 0, 'end_step', true);
			assert.equal(state.phase, 'end_step');
			assert.equal(state.stack.length, 1);
			assert.equal(state.stack[0].inherentTrigger?.kind, 'monarchEndStepDraw');
			assert.equal(state.stack[0].controllerId, p1.playerId);

			drainStack(state);
			assert.equal(p1.hand.length, handBeforeEnd + 1, 'Monarch end-step trigger should draw 1 card');
		} finally {
			unsub();
		}
	});

	it('steals the monarch via CR 726.2 combat damage trigger and updates monarch-conditional static buffs cleanly', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;

		const anthemCard = makeCard({
			name: 'Crown Banner',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Enchantment',
			oracleText: "As long as you're the monarch, creatures you control get +2/+2.",
			colors: ['W'],
			colorIdentity: ['W']
		});
		assert.equal(compileCard(anthemCard).fullySupported, true);

		putInZone(state, p1, anthemCard, 'battlefield');
		putInZone(state, p2, anthemCard, 'battlefield');
		putInZone(
			state,
			p2,
			makeCard({
				name: 'Usurper Courtier',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Enchantment',
				oracleText: 'Whenever you become the monarch, you gain 2 life.',
				colors: ['B'],
				colorIdentity: ['B']
			}),
			'battlefield'
		);

		const p1Guard = putInZone(
			state,
			p1,
			makeCard({
				name: 'Palace Guard',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Soldier',
				power: '2',
				toughness: '2',
				colors: ['W'],
				colorIdentity: ['W']
			}),
			'battlefield'
		);
		p1Guard.tapped = true; // tapped so P1 has no blockers

		const p2Raider = putInZone(
			state,
			p2,
			makeCard({
				name: 'Crown Raider',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Human Warrior',
				power: '2',
				toughness: '2',
				colors: ['R'],
				colorIdentity: ['R']
			}),
			'battlefield'
		);

		setMonarch(state, p1.playerId);
		drainStack(state);

		// While P1 is monarch, P1's 2/2 is 4/4 and P2's 2/2 is 2/2
		assert.equal(evaluatePermanent(state, p1Guard).power, 4);
		assert.equal(evaluatePermanent(state, p2Raider).power, 2);

		// Advance to P2's declare_attackers step
		advanceTo(state, 1, 'declare_attackers');
		const atkRes = applyGameAction(state, p2.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: p2Raider.instanceId, defenderPlayerId: p1.playerId }]
		});
		assert.equal(atkRes.ok, true, atkRes.error ?? 'declare_attackers failed');

		// Step through priority until combat damage puts monarchCombatDamage onto the stack
		for (let guard = 0; guard < 20; guard++) {
			if (state.stack.some((s) => s.inherentTrigger?.kind === 'monarchCombatDamage')) {
				break;
			}
			const prio = state.players[state.priorityPlayerIndex];
			assert.ok(prio && !prio.lost);
			if (
				state.phase === 'declare_blockers' &&
				state.combat.active &&
				!state.combat.declaredBlockersPlayerIds?.includes(prio.playerId) &&
				prio.playerId === p1.playerId
			) {
				assert.equal(
					applyGameAction(state, prio.playerId, { type: 'declare_blockers', assignments: [] }).ok,
					true
				);
				continue;
			}
			assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
		}

		const stealItem = state.stack.find((s) => s.inherentTrigger?.kind === 'monarchCombatDamage');
		assert.ok(stealItem, 'CR 726.2 combat-damage trigger should be on the stack');
		assert.equal(
			stealItem.controllerId,
			p1.playerId,
			'CR 726.2: inherent trigger is controlled by the monarch at trigger time'
		);
		assert.equal(p1.life, 38, 'P2 Raider was 2/2 when combat damage was dealt');
		assert.equal(state.monarchPlayerId, p1.playerId, 'Crown transfers on resolution, not before');

		// Resolve steal trigger + P2's becameMonarch trigger
		drainStack(state);
		assert.equal(state.monarchPlayerId, p2.playerId);
		assert.equal(p2.life, 42, 'Usurper Courtier should have triggered when P2 became the monarch');
		assert.equal(evaluatePermanent(state, p1Guard).power, 2);
		assert.equal(evaluatePermanent(state, p2Raider).power, 4);
	});

	it('transfers the monarch on multiplayer elimination per CR 726.4 / CR 800.4k', () => {
		const state = createGame(4);
		const [p1, p2, p3, p4] = state.players;

		// Case (a): Active player is P1, monarch is non-active P3 -> P3 leaves -> active player P1 becomes monarch
		setMonarch(state, p3.playerId);
		assert.equal(state.activePlayerIndex, 0);
		assert.equal(state.monarchPlayerId, p3.playerId);

		assert.equal(applyGameAction(state, p3.playerId, { type: 'concede' }).ok, true);
		assert.equal(
			state.monarchPlayerId,
			p1.playerId,
			'CR 726.4: when a non-active monarch leaves, the active player becomes the monarch'
		);

		// Case (b): Advance to P2's turn and make P2 the monarch -> active monarch P2 loses -> next living in turn order (P4, skipping eliminated P3) becomes monarch
		advanceTo(state, 1, 'main1');
		setMonarch(state, p2.playerId);
		assert.equal(state.activePlayerIndex, 1);
		assert.equal(state.monarchPlayerId, p2.playerId);

		p2.life = 0;
		checkStateBasedActions(state);
		assert.equal(p2.lost, true);
		assert.equal(
			state.monarchPlayerId,
			p4.playerId,
			'CR 800.4k: when the active monarch leaves on their own turn, the next living player in turn order (P4, skipping P3) becomes the monarch'
		);
	});
});

describe('Track P1 — Group 5: Synthetic card rename-invariance (ENGINE_INVARIANTS.md §1.3)', () => {
	function normalizeCompiledForRename(card: ScryfallCard) {
		const def = compileCard(card);
		return JSON.parse(
			JSON.stringify({
				fullySupported: def.fullySupported,
				faces: def.faces.map((f) => {
					const faceClone = { ...f } as Record<string, unknown>;
					delete faceClone.name;
					faceClone.abilities = f.abilities.map((a) => {
						const clone = { ...a } as Record<string, unknown>;
						delete clone.text;
						delete clone.span;
						return clone;
					});
					return faceClone;
				})
			})
		);
	}

	it('produces identical IR and runtime outcomes for canonical vs synthetic names across Sagas, Energy, and Monarch', () => {
		const pairs: Array<[ScryfallCard, ScryfallCard]> = [
			[
				makeCard({
					name: 'The Flame of Keld',
					manaCost: '{1}{R}',
					cmc: 2,
					typeLine: 'Enchantment — Saga',
					oracleText: 'I, II — Draw a card.\nIII — Each opponent loses 2 life.',
					colors: ['R'],
					colorIdentity: ['R']
				}),
				makeCard({
					name: 'Glimmerfen Ember-Scroll',
					manaCost: '{1}{R}',
					cmc: 2,
					typeLine: 'Enchantment — Saga',
					oracleText: 'I, II — Draw a card.\nIII — Each opponent loses 2 life.',
					colors: ['R'],
					colorIdentity: ['R']
				})
			],
			[
				makeCard({
					name: 'Aether Hub',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText:
						'When Aether Hub enters, you get {E}.\n{T}: Add {C}.\n{T}, Pay {E}: Add one mana of any color.'
				}),
				makeCard({
					name: 'Zorblax Conduit Spire',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText:
						'When Zorblax Conduit Spire enters, you get {E}.\n{T}: Add {C}.\n{T}, Pay {E}: Add one mana of any color.'
				})
			],
			[
				makeCard({
					name: 'Palace Jailer',
					manaCost: '{2}{W}{W}',
					cmc: 4,
					typeLine: 'Creature — Human Soldier',
					oracleText:
						"When Palace Jailer enters, you become the monarch.\nAs long as you're the monarch, creatures you control get +1/+1.",
					power: '2',
					toughness: '2',
					colors: ['W'],
					colorIdentity: ['W']
				}),
				makeCard({
					name: 'Kestrel Throne-Warden',
					manaCost: '{2}{W}{W}',
					cmc: 4,
					typeLine: 'Creature — Human Soldier',
					oracleText:
						"When Kestrel Throne-Warden enters, you become the monarch.\nAs long as you're the monarch, creatures you control get +1/+1.",
					power: '2',
					toughness: '2',
					colors: ['W'],
					colorIdentity: ['W']
				})
			]
		];

		for (const [canonical, synthetic] of pairs) {
			assert.equal(compileCard(canonical).fullySupported, true, canonical.name);
			assert.deepEqual(
				normalizeCompiledForRename(canonical),
				normalizeCompiledForRename(synthetic),
				`IR mismatch between ${canonical.name} and ${synthetic.name}`
			);
		}

		// Runtime equivalence smoke check on synthetic Monarch + Energy + Saga in one game
		const state = createGame(2);
		const [p1] = state.players;
		const synthSaga = putInZone(state, p1, pairs[0][1], 'hand');
		const synthHub = putInZone(state, p1, pairs[1][1], 'hand');
		const synthMonarch = putInZone(state, p1, pairs[2][1], 'hand');

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: synthHub.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.energyCounters, 1);

		castFromHand(state, p1, synthMonarch);
		drainStack(state);
		const synthMonarchOnBoard = p1.battlefield.find(
			(c) => c.instanceId === synthMonarch.instanceId
		)!;
		assert.equal(state.monarchPlayerId, p1.playerId);
		assert.equal(evaluatePermanent(state, synthMonarchOnBoard).power, 3);

		const handBeforeSaga = p1.hand.length;
		castFromHand(state, p1, synthSaga);
		drainStack(state);
		const synthSagaOnBoard = p1.battlefield.find((c) => c.instanceId === synthSaga.instanceId)!;
		assert.equal(synthSagaOnBoard.counters.lore, 1);
		assert.equal(p1.hand.length, handBeforeSaga - 1 + 1);
	});
});
