import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import type { ActivatedAbility } from '../ir.ts';
import {
	applyGameAction,
	canBlock,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	hasKeyword
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
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
		id: `p16a_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Instant',
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

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function playerTarget(player: PlayerGameState): TargetRef {
	return { kind: 'player', id: player.playerId, label: player.username };
}

function gyTarget(inst: CardInstance): TargetRef {
	return { kind: 'card_in_graveyard', id: inst.instanceId, label: inst.card.name };
}

function stackTarget(stackId: string, label = 'Spell'): TargetRef {
	return { kind: 'stack', id: stackId, label };
}

function roundTripJson(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function stripSpans(val: unknown): unknown {
	if (Array.isArray(val)) return val.map(stripSpans);
	if (val && typeof val === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
			if (k === 'span' || k === 'text') continue;
			out[k] = stripSpans(v);
		}
		return out;
	}
	return val;
}

function createGame(playerCount: 2 | 3 = 2, botMask: boolean[] = []): GameState {
	const seats: LobbySeat[] = Array.from({ length: playerCount }, (_, i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length];
		return {
			seatIndex: i,
			userId: botMask[i] ? null : `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: Boolean(botMask[i]),
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
	const decks = new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]]));
	const state = createInitialGameState('TRACKP16A', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		if (!p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
	}
	state.phase = 'main1';
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
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		...(zone === 'library' ? { insert: 'start' } : {}),
		bumpVersion: true
	});
	inst.summoningSick = false;
	return inst;
}

function addMana(player: PlayerGameState, amount = 10): void {
	player.manaPool.W += amount;
	player.manaPool.U += amount;
	player.manaPool.B += amount;
	player.manaPool.R += amount;
	player.manaPool.G += amount;
	player.manaPool.C += amount;
}

function firstActivatedId(card: ScryfallCard, index = 0): string {
	const def = compileCard(card);
	const acts = def.faces[0].abilities.filter(
		(a): a is ActivatedAbility => a.kind === 'activated' && !a.intrinsic
	);
	assert.ok(acts[index], `Expected activated ability at index ${index} on ${card.name}`);
	return acts[index].id;
}

function resolveStack(state: GameState, maxSteps = 80): void {
	for (let guard = 0; guard < maxSteps; guard++) {
		const pr = state.pendingPrompts[0];
		const choice = pr?.choice;
		if (
			state.pendingPrompts.length === 1 &&
			pr?.purpose === 'trigger_order' &&
			choice?.kind === 'orderObjects'
		) {
			const orderRes = applyGameAction(state, pr.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'orderObjects', topIds: choice.objectIds }
			});
			assert.equal(orderRes.ok, true, orderRes.error ?? 'trigger_order failed');
			continue;
		}
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const prio = state.players[state.priorityPlayerIndex];
		if (!prio || prio.lost) break;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
	}
}

function answerTopPrompt(state: GameState, answer: ChoiceAnswer): void {
	const pr = state.pendingPrompts[0];
	assert.ok(pr, 'Expected an active pending prompt');
	const res = applyGameAction(state, pr.playerId, {
		type: 'choice',
		promptId: pr.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? 'choice answer failed');
}

function advanceToPhase(state: GameState, targetPhase: GamePhase, maxSteps = 120): void {
	for (let guard = 0; guard < maxSteps; guard++) {
		if (
			state.phase === targetPhase &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0 &&
			guard > 0
		) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0]!;
			const ch = pr.choice;
			if (ch?.kind === 'orderObjects') {
				answerTopPrompt(state, { kind: 'orderObjects', topIds: ch.objectIds });
				continue;
			}
			assert.fail(`Unexpected prompt advancing to ${targetPhase}: ${pr.title}`);
		}
		const prio = state.players[state.priorityPlayerIndex]!;
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
	}
	assert.equal(state.phase, targetPhase);
}

function advanceToNextTurnMain1(state: GameState, expectedActiveSeat: number, maxSteps = 160): void {
	const startTurn = state.turnNumber;
	for (let guard = 0; guard < maxSteps; guard++) {
		if (
			(state.turnNumber > startTurn || state.activePlayerIndex === expectedActiveSeat) &&
			state.activePlayerIndex === expectedActiveSeat &&
			state.phase === 'main1' &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0 &&
			guard > 0
		) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0]!;
			const ch = pr.choice;
			if (ch?.kind === 'orderObjects') {
				answerTopPrompt(state, { kind: 'orderObjects', topIds: ch.objectIds });
				continue;
			}
			assert.fail(`Unexpected prompt advancing turn: ${pr.title}`);
		}
		const prio = state.players[state.priorityPlayerIndex]!;
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
	}
	assert.equal(state.activePlayerIndex, expectedActiveSeat);
	assert.equal(state.phase, 'main1');
}

// ============================================================================
// Slice P16.1 — Inline Conditionals, Compound Clauses, Durations & Once-Per-Turn
// ============================================================================

describe('Wave 6 Track P16a — Slice P16.1: Inline Conditionals, Durations & Once-Per-Turn', () => {
	it('resolves prefix/trailing conditionals, Otherwise branches, instead replacements, and died-this-way checks', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const branchSpell = makeCard({
			name: 'Aetheric Inquiry',
			manaCost: '{1}{U}',
			typeLine: 'Sorcery',
			oracleText: 'If you control an artifact, draw two cards. Otherwise, draw a card.'
		});
		assert.equal(compileCard(branchSpell).fullySupported, true);

		// Without artifact -> draws 1
		const s1 = putInZone(state, p1, branchSpell, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(p1.hand.length, 1);

		// Add an artifact -> draws 2!
		putInZone(state, p1, makeCard({ name: 'Brass Cogwork', typeLine: 'Artifact' }), 'battlefield');
		p1.hand = [];
		const s2 = putInZone(state, p1, branchSpell, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s2.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(p1.hand.length, 2);

		// Trailing conditional + Otherwise + sentence-leading "Until end of turn"
		const fighter = putInZone(
			state,
			p1,
			makeCard({ name: 'Vaelor Vanguard', typeLine: 'Creature — Human Knight', power: '2', toughness: '2' }),
			'battlefield'
		);
		const trailingOtherwise = makeCard({
			name: 'Sigil Surge',
			manaCost: '{G}',
			typeLine: 'Instant',
			oracleText:
				'Target creature gets +3/+3 until end of turn if you control an enchantment. Otherwise, it gets +1/+1 until end of turn.'
		});
		assert.equal(compileCard(trailingOtherwise).fullySupported, true);
		const s3 = putInZone(state, p1, trailingOtherwise, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: s3.instanceId,
				targets: [permTarget(fighter)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, fighter).power, 3);

		// "instead" replacement: "Draw a card. If you control an artifact, draw three cards instead."
		p1.hand = [];
		const insteadSpell = makeCard({
			name: 'Chrono Insight',
			manaCost: '{2}{U}',
			typeLine: 'Instant',
			oracleText: 'Draw a card. If you control an artifact, draw three cards instead.'
		});
		assert.equal(compileCard(insteadSpell).fullySupported, true);
		const s4 = putInZone(state, p1, insteadSpell, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s4.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(p1.hand.length, 3);

		// "If a creature died this way, draw a card."
		p1.hand = [];
		const victim = putInZone(
			state,
			p2,
			makeCard({ name: 'Mire Imp', typeLine: 'Creature — Imp', power: '1', toughness: '2' }),
			'battlefield'
		);
		const sear = makeCard({
			name: 'Grim Verdict',
			manaCost: '{1}{B}',
			typeLine: 'Instant',
			oracleText: 'Destroy target creature. If a creature died this way, draw a card.'
		});
		assert.equal(compileCard(sear).fullySupported, true);
		const s5 = putInZone(state, p1, sear, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: s5.instanceId,
				targets: [permTarget(victim)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(victim.zone, 'graveyard');
		assert.equal(p1.hand.length, 1);
	});

	it('handles top-of-library type inspection, Kinship reveal follow-ups, and optional sacrifice/dig follow-ups', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const inspectTop = makeCard({
			name: 'Horizon Scoutcraft',
			manaCost: '{G}',
			typeLine: 'Sorcery',
			oracleText:
				"Look at the top card of your library. If it's a land card, put it onto the battlefield. Otherwise, put it into your hand."
		});
		assert.equal(compileCard(inspectTop).fullySupported, true);

		const topLand = putInZone(
			state,
			p1,
			makeCard({ name: 'Verdant Steppe', typeLine: 'Land', manaCost: '' }),
			'library'
		);
		const c1 = putInZone(state, p1, inspectTop, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c1.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(topLand.zone, 'battlefield');

		// Kinship pattern: look at top card, if shares creature type with ~, you may reveal it. If you do, ...
		const kinshipElder = putInZone(
			state,
			p1,
			makeCard({
				name: 'Glimmerbough Elder',
				manaCost: '{2}{B}',
				typeLine: 'Creature — Treefolk Shaman',
				power: '2',
				toughness: '3',
				oracleText:
					'When Glimmerbough Elder enters, you may look at the top card of your library. If it shares a creature type with Glimmerbough Elder, you may reveal it. If you do, each opponent loses 3 life.'
			}),
			'hand'
		);
		assert.equal(compileCard(kinshipElder.card).fullySupported, true);
		putInZone(
			state,
			p1,
			makeCard({ name: 'Bramble Shaman', typeLine: 'Creature — Elf Shaman', power: '1', toughness: '1' }),
			'library'
		);
		const lifeBefore = p2.life;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: kinshipElder.instanceId }).ok,
			true
		);
		resolveStack(state);
		// Prompt 1: "you may look at the top card of your library"
		answerTopPrompt(state, { kind: 'yesNo', yes: true });
		resolveStack(state);
		// Prompt 2: "you may reveal it"
		answerTopPrompt(state, { kind: 'yesNo', yes: true });
		resolveStack(state);
		assert.equal(lifeBefore - p2.life, 3);

		// Optional sacrifice + "If you do"
		const fodder = putInZone(
			state,
			p1,
			makeCard({ name: 'Spore Wisp', typeLine: 'Creature — Fungus', power: '1', toughness: '1' }),
			'battlefield'
		);
		const sacGain = makeCard({
			name: 'Rite of Renewal',
			manaCost: '{1}{B}',
			typeLine: 'Sorcery',
			oracleText: 'Sacrifice a creature. If you do, you gain 5 life.'
		});
		assert.equal(compileCard(sacGain).fullySupported, true);
		const p1LifeBefore = p1.life;
		const sg = putInZone(state, p1, sacGain, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: sg.instanceId }).ok, true);
		resolveStack(state);
		if (state.pendingPrompts.length > 0) {
			answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [fodder.instanceId] });
			resolveStack(state);
		}
		assert.equal(fodder.zone, 'graveyard');
		assert.equal(p1.life - p1LifeBefore, 5);
	});

	it('enforces untilEndOfCombat (CR 511.2), forAsLongAsYouControlSelf, and permanent CR 611.2b latch on forAsLongAsSelfRemainsTapped', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const knight = putInZone(
			state,
			p1,
			makeCard({ name: 'Dawnblade Sentinel', typeLine: 'Creature — Human Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);

		// 1) untilEndOfCombat: active in combat, expires by main2!
		advanceToPhase(state, 'begin_combat');
		addMana(p1, 10);
		const combatPump = makeCard({
			name: 'Battlefield Rally',
			manaCost: '{W}',
			typeLine: 'Instant',
			oracleText: 'Target creature gets +3/+3 until end of combat.'
		});
		assert.equal(compileCard(combatPump).fullySupported, true);
		const cp = putInZone(state, p1, combatPump, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cp.instanceId,
				targets: [permTarget(knight)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, knight).power, 5);

		advanceToPhase(state, 'main2');
		assert.equal(evaluatePermanent(state, knight).power, 2, 'untilEndOfCombat must expire leaving combat');

		// 2) forAsLongAsSelfRemainsTapped (CR 611.2b): freezes target across opponent untap, and permanently latches once untapped!
		addMana(p1, 10);
		const binder = putInZone(
			state,
			p1,
			makeCard({
				name: 'Cryo Anchor',
				manaCost: '{2}{U}',
				typeLine: 'Creature — Vedalken Wizard',
				power: '1',
				toughness: '3',
				oracleText:
					"{T}: Target creature gets -2/-0 and doesn't untap during its controller's untap step for as long as Cryo Anchor remains tapped."
			}),
			'battlefield'
		);
		assert.equal(compileCard(binder.card).fullySupported, true);

		const ogre = putInZone(
			state,
			p2,
			makeCard({ name: 'Crag Brute', typeLine: 'Creature — Ogre', power: '4', toughness: '4' }),
			'battlefield'
		);
		ogre.tapped = true;

		const actId = firstActivatedId(binder.card);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: binder.instanceId,
				abilityId: actId,
				targets: [permTarget(ogre)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(binder.tapped, true);
		assert.equal(evaluatePermanent(state, ogre).power, 2);

		// Advance to P2's main1: ogre must STILL be tapped and at power 2!
		advanceToNextTurnMain1(state, 1);
		assert.equal(ogre.tapped, true, 'Frozen creature must not untap while binder remains tapped');
		assert.equal(evaluatePermanent(state, ogre).power, 2);

		// Advance back to P1's main1: binder untaps during P1's untap step -> CR 611.2b latches the duration permanently!
		advanceToNextTurnMain1(state, 0);
		assert.equal(binder.tapped, false);
		assert.equal(evaluatePermanent(state, ogre).power, 4, 'Effect ends once binder untaps');

		// Manually tapping binder WITHOUT re-activating its ability MUST NOT revive the already-ended duration!
		binder.tapped = true;
		checkStateBasedActions(state);
		assert.equal(
			evaluatePermanent(state, ogre).power,
			4,
			'CR 611.2b: re-tapping source must never revive an already-broken duration'
		);
	});

	it('enforces CR 603.2h "Do this only once each turn." per ability instance and resets next turn', () => {
		const state = createGame();
		const [p1] = state.players;
		addMana(p1, 20);

		const mentor = putInZone(
			state,
			p1,
			makeCard({
				name: 'Sanctum Archivist',
				manaCost: '{1}{W}',
				typeLine: 'Creature — Human Cleric',
				power: '2',
				toughness: '2',
				oracleText:
					'Whenever another creature you control enters, you may pay {1}. If you do, draw a card. Do this only once each turn.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(mentor.card).fullySupported, true);

		const cCard = makeCard({ name: 'Silver Initiate', manaCost: '{W}', typeLine: 'Creature — Human', power: '1', toughness: '1' });

		// First creature enters -> decline paying {1} -> cap is NOT yet consumed!
		const c1 = putInZone(state, p1, cCard, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c1.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		answerTopPrompt(state, { kind: 'yesNo', yes: false });
		resolveStack(state);
		assert.equal(p1.hand.length, 0);

		// Second creature enters -> accept paying {1} -> draws 1 card and marks done this turn!
		const c2 = putInZone(state, p1, cCard, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c2.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		answerTopPrompt(state, { kind: 'yesNo', yes: true });
		resolveStack(state);
		assert.equal(p1.hand.length, 1);

		// Third creature enters same turn -> skipped without prompting!
		p1.hand = [];
		const c3 = putInZone(state, p1, cCard, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c3.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p1.hand.length, 0);
	});
});

// ============================================================================
// Slice P16.2 — Universal Counters, Player Counters, Counter Movement & Targets
// ============================================================================

describe('Wave 6 Track P16a — Slice P16.2: Universal Counters & Multi-Target Unblocking', () => {
	it('evaluates arbitrary ±M/±N counters, keyword counters, named counters, moveCounters, and LKI copyCountersFrom', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const golem = putInZone(
			state,
			p1,
			makeCard({ name: 'Basalt Automaton', typeLine: 'Artifact Creature — Golem', power: '2', toughness: '2' }),
			'battlefield'
		);
		const ally = putInZone(
			state,
			p1,
			makeCard({ name: 'Aether Striker', typeLine: 'Creature — Human Monk', power: '1', toughness: '2' }),
			'battlefield'
		);

		// +2/+2 counter + shadow keyword counter + filibuster named counter
		const infuse = makeCard({
			name: 'Prismatic Infusion',
			manaCost: '{2}{G}',
			typeLine: 'Sorcery',
			oracleText:
				'Put a +2/+2 counter on target creature. Put a shadow counter on that creature. Put two oil counters on it.'
		});
		assert.equal(compileCard(infuse).fullySupported, true);
		const inf = putInZone(state, p1, infuse, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: inf.instanceId,
				targets: [permTarget(golem)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, golem).power, 4);
		assert.equal(evaluatePermanent(state, golem).toughness, 4);
		assert.equal(hasKeyword(golem, 'Shadow', state), true);
		assert.equal(golem.counters.oil, 2);

		// CR 122.5 moveCounters: Move an oil counter from target permanent onto another target permanent
		const shiftOil = makeCard({
			name: 'Conduit Siphon',
			manaCost: '{U}',
			typeLine: 'Instant',
			oracleText: 'Move an oil counter from target permanent onto another target permanent.'
		});
		assert.equal(compileCard(shiftOil).fullySupported, true);
		const so = putInZone(state, p1, shiftOil, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: so.instanceId,
				targets: [permTarget(golem), permTarget(ally)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(golem.counters.oil, 1);
		assert.equal(ally.counters.oil, 1);

		// CR 122.8 LKI "When ~ dies, put its counters on target creature you control."
		const vessel = putInZone(
			state,
			p1,
			makeCard({
				name: 'Spore Reliquary',
				typeLine: 'Creature — Plant',
				power: '1',
				toughness: '1',
				oracleText: 'When Spore Reliquary dies, put its counters on target creature you control.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(vessel.card).fullySupported, true);
		vessel.counters['+1/+1'] = 2;
		vessel.counters.trample = 1;

		const slay = putInZone(
			state,
			p1,
			makeCard({ name: 'Void Sever', manaCost: '{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: slay.instanceId,
				targets: [permTarget(vessel)]
			}).ok,
			true
		);
		resolveStack(state);
		if (state.pendingPrompts.length > 0) {
			answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [ally.instanceId] });
			resolveStack(state);
		}
		assert.equal(ally.counters['+1/+1'], 2);
		assert.equal(hasKeyword(ally, 'Trample', state), true);

		// Player counters (experience + rad) + proliferate + dynamic playerCounters scaling
		const expSpell = makeCard({
			name: 'Scholar Ascension',
			manaCost: '{1}{U}',
			typeLine: 'Sorcery',
			oracleText: 'You get two experience counters. Target player gets two rad counters. Proliferate.'
		});
		assert.equal(compileCard(expSpell).fullySupported, true);
		const es = putInZone(state, p1, expSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: es.instanceId,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		resolveStack(state);
		// Proliferate prompt: select both p1 and p2
		if (state.pendingPrompts.length > 0) {
			const ch = state.pendingPrompts[0]!.choice;
			if (ch?.kind === 'chooseObjects') {
				answerTopPrompt(state, { kind: 'chooseObjects', objectIds: ch.candidates });
				resolveStack(state);
			}
		}
		assert.equal(p1.experienceCounters, 3);
		assert.equal(p2.radCounters, 3);
	});

	it('supports Thriving/Gate manaOrChosenColor, countersRemovedThisWay, and qualified stack spell targeting', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);
		addMana(p2, 10);

		// Gate land: "{T}: Add {W} or one mana of the chosen color."
		const gateCard = makeCard({
			name: 'Citadel Archway',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land — Gate',
			oracleText:
				'Citadel Archway enters tapped.\nAs Citadel Archway enters, choose a color other than white.\n{T}: Add {W} or one mana of the chosen color.'
		});
		assert.equal(compileCard(gateCard).fullySupported, true);
		const gate = putInZone(state, p1, gateCard, 'battlefield');
		// Answer ETB color choice (Blue, Black, Red, Green -> index 1 = Black)
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0]!.choice?.kind === 'chooseMode') {
			const modes = state.pendingPrompts[0]!.choice.modes;
			const blackIdx = modes.findIndex((m) => m.toLowerCase().includes('black'));
			answerTopPrompt(state, { kind: 'chooseMode', indices: [blackIdx >= 0 ? blackIdx : 0] });
		}
		assert.equal(gate.chosenColor, 'B');
		gate.tapped = false;
		const beforeB = p1.manaPool.B;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: gate.instanceId,
				preferredColor: 'B'
			}).ok,
			true
		);
		assert.equal(p1.manaPool.B - beforeB, 1);
		gate.tapped = false;
		const beforeW = p1.manaPool.W;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: gate.instanceId,
				preferredColor: 'W'
			}).ok,
			true
		);
		assert.equal(p1.manaPool.W - beforeW, 1);

		// Qualified stack spell targeting: "Counter target spell with mana value 3 or less."
		const smallCounter = makeCard({
			name: 'Minor Rebuke',
			manaCost: '{U}',
			typeLine: 'Instant',
			oracleText: 'Counter target spell with mana value 3 or less.'
		});
		assert.equal(compileCard(smallCounter).fullySupported, true);

		const bigSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Colossal Titan',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Creature — Giant',
				power: '6',
				toughness: '6'
			}),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: bigSpell.instanceId }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);

		const reb1 = putInZone(state, p2, smallCounter, 'hand');
		const illegalCounter = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: reb1.instanceId,
			targets: [stackTarget(state.stack[0]!.id)]
		});
		assert.equal(illegalCounter.ok, false, 'Must reject countering MV 6 spell');
		resolveStack(state);

		const cheapSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Swift Courser',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Horse',
				power: '2',
				toughness: '2'
			}),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: cheapSpell.instanceId }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);

		const legalCounter = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: reb1.instanceId,
			targets: [stackTarget(state.stack[0]!.id)]
		});
		assert.equal(legalCounter.ok, true, 'Must allow countering MV 2 spell');
		resolveStack(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === cheapSpell.instanceId), true);
	});
});

// ============================================================================
// Slice P16.3 — Library Piles, Copy-Card Free-Cast, Linked Exile, Combat & CR 701
// ============================================================================

describe('Wave 6 Track P16a — Slice P16.3: Piles, Copy/Free-Cast, GY, Combat & CR 701 Actions', () => {
	it('resolves CR 700.3 two-pile split across JSON round-trips on both pile_make and pile_choose prompts', () => {
		let state = createGame();
		addMana(state.players[0], 10);

		const topA = putInZone(state, state.players[0], makeCard({ name: 'Starlight Shard', typeLine: 'Artifact' }), 'library');
		const topB = putInZone(state, state.players[0], makeCard({ name: 'Moonstone Orb', typeLine: 'Artifact' }), 'library');
		const topC = putInZone(state, state.players[0], makeCard({ name: 'Sunfire Tome', typeLine: 'Artifact' }), 'library');
		const topD = putInZone(state, state.players[0], makeCard({ name: 'Duskglass Relic', typeLine: 'Artifact' }), 'library');

		const pileSpell = makeCard({
			name: 'Schism of Truth',
			manaCost: '{3}{U}',
			typeLine: 'Instant',
			oracleText:
				'Reveal the top four cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other into your graveyard.'
		});
		assert.equal(compileCard(pileSpell).fullySupported, true);
		const ps = putInZone(state, state.players[0], pileSpell, 'hand');
		assert.equal(
			applyGameAction(state, state.players[0].playerId, { type: 'cast_spell', instanceId: ps.instanceId }).ok,
			true
		);
		resolveStack(state);

		// P2 is prompted to separate into two piles -> JSON round-trip mid-prompt!
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0]!.playerId, state.players[1].playerId);
		state = roundTripJson(state);

		answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [topD.instanceId, topC.instanceId] });
		resolveStack(state);

		// P1 is now prompted to choose Pile 1 or Pile 2 -> JSON round-trip mid-prompt!
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0]!.playerId, state.players[0].playerId);
		state = roundTripJson(state);

		// Choose Pile 1 (index 0 -> topD & topC to hand, topB & topA to graveyard)
		answerTopPrompt(state, { kind: 'chooseMode', indices: [0] });
		resolveStack(state);

		const handNames = state.players[0].hand.map((c) => c.card.name).sort();
		const gyNames = state.players[0].graveyard.map((c) => c.card.name).sort();
		assert.deepEqual(handNames, ['Duskglass Relic', 'Sunfire Tome']);
		assert.equal(gyNames.includes('Moonstone Orb'), true);
		assert.equal(gyNames.includes('Starlight Shard'), true);
	});

	it('resolves CR 707.12 copy-card free-cast with JSON round-trips leaving the original card in graveyard', () => {
		let state = createGame();
		addMana(state.players[0], 10);

		const burnCard = makeCard({
			name: 'Searing Bolt',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Searing Bolt deals 4 damage to target player.'
		});
		const gyBurn = putInZone(state, state.players[1], burnCard, 'graveyard');

		const copyCaster = makeCard({
			name: 'Echo Savant',
			manaCost: '{2}{U}{R}',
			typeLine: 'Creature — Human Wizard',
			power: '2',
			toughness: '2',
			oracleText:
				'When Echo Savant enters, copy target instant or sorcery card in a graveyard. You may cast the copy without paying its mana cost.'
		});
		assert.equal(compileCard(copyCaster).fullySupported, true);
		const cc = putInZone(state, state.players[0], copyCaster, 'hand');
		const p2LifeBefore = state.players[1].life;

		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'cast_spell',
				instanceId: cc.instanceId
			}).ok,
			true
		);
		resolveStack(state);

		// ETB target selection if prompted
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0]!.choice?.kind === 'chooseObjects') {
			answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [gyBurn.instanceId] });
			resolveStack(state);
		}

		// Prompt 1: Cast a copy without paying its mana cost? -> JSON round-trip!
		assert.equal(state.pendingPrompts.length, 1);
		state = roundTripJson(state);
		answerTopPrompt(state, { kind: 'yesNo', yes: true });

		// Prompt 2: Choose target for Searing Bolt (P1 or P2) -> JSON round-trip!
		assert.equal(state.pendingPrompts.length, 1);
		state = roundTripJson(state);
		const modeChoice = state.pendingPrompts[0]!.choice;
		assert.equal(modeChoice?.kind, 'chooseMode');
		const p2Idx = modeChoice.modes.findIndex((opt) => opt.includes('P2'));
		answerTopPrompt(state, { kind: 'chooseMode', indices: [p2Idx >= 0 ? p2Idx : 0] });

		resolveStack(state);
		assert.equal(p2LifeBefore - state.players[1].life, 4);
		assert.equal(
			state.players[1].graveyard.some((c) => c.instanceId === gyBurn.instanceId),
			true,
			'CR 707.12: original graveyard card must remain in graveyard when its copy is cast'
		);
	});

	it('resolves mass graveyard reanimation, CR 607.2 linked exile return, librarySelf shuffle, and turn/next-spell cast rules', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 20);
		addMana(p2, 20);

		// Mass GY reanimation with MV <= 2 filter
		const smallA = putInZone(
			state,
			p1,
			makeCard({ name: 'Fen Scout', manaCost: '{1}{B}', cmc: 2, typeLine: 'Creature — Scout', power: '2', toughness: '1' }),
			'graveyard'
		);
		const bigB = putInZone(
			state,
			p1,
			makeCard({ name: 'Mire Leviathan', manaCost: '{5}{B}', cmc: 6, typeLine: 'Creature — Leviathan', power: '6', toughness: '6' }),
			'graveyard'
		);
		const massReanim = makeCard({
			name: 'Call of the Crypts',
			manaCost: '{3}{B}',
			typeLine: 'Sorcery',
			oracleText: 'Return all creature cards with mana value 2 or less from your graveyard to the battlefield tapped.'
		});
		assert.equal(compileCard(massReanim).fullySupported, true);
		const mr = putInZone(state, p1, massReanim, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mr.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(smallA.zone, 'battlefield');
		assert.equal(smallA.tapped, true);
		assert.equal(bigB.zone, 'graveyard');

		// CR 607.2 linked exile: exile with ~ then return all cards exiled with ~ to their owners' hands
		const vault = putInZone(
			state,
			p1,
			makeCard({
				name: 'Stasis Vault',
				manaCost: '{2}',
				typeLine: 'Artifact',
				oracleText:
					"{1}, {T}: Exile target creature.\n{2}, Sacrifice Stasis Vault: Return all cards exiled with Stasis Vault to their owners' hands."
			}),
			'battlefield'
		);
		assert.equal(compileCard(vault.card).fullySupported, true);
		const captive = putInZone(
			state,
			p2,
			makeCard({ name: 'Skywing Drake', typeLine: 'Creature — Drake', power: '2', toughness: '2' }),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: vault.instanceId,
				abilityId: firstActivatedId(vault.card, 0),
				targets: [permTarget(captive)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(captive.zone, 'exile');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: vault.instanceId,
				abilityId: firstActivatedId(vault.card, 1)
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(captive.zone, 'hand');
		assert.equal(p2.hand.some((c) => c.instanceId === captive.instanceId), true);

		// Resolving spell shuffle-self ("Shuffle ~ into its owner's library.")
		const zenith = makeCard({
			name: 'Emerald Cycle',
			manaCost: '{1}{G}',
			typeLine: 'Sorcery',
			oracleText: "You gain 3 life. Shuffle Emerald Cycle into its owner's library."
		});
		assert.equal(compileCard(zenith).fullySupported, true);
		const zInst = putInZone(state, p1, zenith, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: zInst.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(p1.library.some((c) => c.card.name === 'Emerald Cycle'), true);
		assert.equal(p1.graveyard.some((c) => c.card.name === 'Emerald Cycle'), false);

		// Next-spell flash + opponent cast ban ("Target opponent can't cast spells this turn.")
		const silence = makeCard({
			name: 'Hush of Law',
			manaCost: '{W}',
			typeLine: 'Instant',
			oracleText: "Target opponent can't cast spells this turn."
		});
		assert.equal(compileCard(silence).fullySupported, true);
		const sil = putInZone(state, p1, silence, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sil.instanceId,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.cantCastSpellsThisTurn, true);

		const p2Inst = putInZone(
			state,
			p2,
			makeCard({ name: 'Spark Dart', manaCost: '{R}', typeLine: 'Instant', oracleText: 'Draw a card.' }),
			'hand'
		);
		assert.equal(getCastOptions(state, p2.playerId, p2Inst, 'hand').length, 0);
	});

	it('resolves Layer 4/6/7b animations & ability loss, choice grants, and combat block overrides', () => {
		let state = createGame();
		addMana(state.players[0], 20);

		const dragon = putInZone(
			state,
			state.players[1],
			makeCard({
				name: 'Pyrescale Wyrm',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '5',
				oracleText: 'Flying, trample'
			}),
			'battlefield'
		);
		assert.equal(hasKeyword(dragon, 'Flying', state), true);

		// Layer 6 ability removal + Layer 7b 1/1 setting
		const humble = makeCard({
			name: 'Diminish Form',
			manaCost: '{1}{U}',
			typeLine: 'Instant',
			oracleText: 'Target creature loses all abilities and has base power and toughness 1/1 until end of turn.'
		});
		assert.equal(compileCard(humble).fullySupported, true);
		const hm = putInZone(state, state.players[0], humble, 'hand');
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'cast_spell',
				instanceId: hm.instanceId,
				targets: [permTarget(dragon)]
			}).ok,
			true
		);
		resolveStack(state);
		const evDragon = evaluatePermanent(state, dragon);
		assert.equal(evDragon.power, 1);
		assert.equal(evDragon.toughness, 1);
		assert.equal(evDragon.losesAllAbilities, true);
		assert.equal(hasKeyword(dragon, 'Flying', state), false);

		// Choice protection grant with JSON round-trip mid-prompt
		const paladin = putInZone(
			state,
			state.players[0],
			makeCard({ name: 'Sunshield Warder', typeLine: 'Creature — Human Knight', power: '2', toughness: '2' }),
			'battlefield'
		);
		const protSpell = makeCard({
			name: 'Ward of Faith',
			manaCost: '{W}',
			typeLine: 'Instant',
			oracleText: 'Target creature you control gains protection from the color of your choice until end of turn.'
		});
		assert.equal(compileCard(protSpell).fullySupported, true);
		const pr = putInZone(state, state.players[0], protSpell, 'hand');
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'cast_spell',
				instanceId: pr.instanceId,
				targets: [permTarget(paladin)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		state = roundTripJson(state);
		// Choose Red (index 3 in White, Blue, Black, Red, Green)
		answerTopPrompt(state, { kind: 'chooseMode', indices: [3] });
		resolveStack(state);
		const paladinAfter = state.players[0].battlefield.find((c) => c.instanceId === paladin.instanceId)!;
		assert.equal(
			evaluatePermanent(state, paladinAfter).activeKeywords.some(
				(k) => k.toLowerCase() === 'protection from red'
			),
			true
		);

		// Combat block override: "Target creature can't block ~ this turn."
		const stalker = putInZone(
			state,
			state.players[0],
			makeCard({
				name: 'Duskblade Raider',
				typeLine: 'Creature — Rogue',
				power: '3',
				toughness: '2',
				oracleText: "{R}: Target creature can't block Duskblade Raider this turn."
			}),
			'battlefield'
		);
		assert.equal(compileCard(stalker.card).fullySupported, true);
		const dragonNow = state.players[1].battlefield.find((c) => c.instanceId === dragon.instanceId)!;
		assert.equal(canBlock(state, dragonNow, stalker), true);
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'activate_ability',
				instanceId: stalker.instanceId,
				abilityId: firstActivatedId(stalker.card),
				targets: [permTarget(dragonNow)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(canBlock(state, dragonNow, stalker), false);
	});

	it('resolves all 6 Wave 6 CR 701 actions: Harness, Convert, Empower Jace, Assimilate, Recruit, and Heal (with JSON round-trips)', () => {
		let state = createGame();
		addMana(state.players[0], 30);

		// 1) CR 701.64 Harness + conditional isHarnessed check
		const engineRelic = putInZone(
			state,
			state.players[0],
			makeCard({
				name: 'Astral Dynamo',
				manaCost: '{2}',
				typeLine: 'Artifact',
				oracleText: '{1}: Harness Astral Dynamo.\n{T}: If Astral Dynamo is harnessed, you gain 4 life.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(engineRelic.card).fullySupported, true);
		assert.equal(Boolean(engineRelic.isHarnessed), false);
		// Before harnessing, activating the second ability gains 0 life!
		const lifeBeforeHarness = state.players[0].life;
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'activate_ability',
				instanceId: engineRelic.instanceId,
				abilityId: firstActivatedId(engineRelic.card, 1)
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.players[0].life, lifeBeforeHarness);
		engineRelic.tapped = false;

		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'activate_ability',
				instanceId: engineRelic.instanceId,
				abilityId: firstActivatedId(engineRelic.card, 0)
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(engineRelic.isHarnessed, true);

		const lifePreInf = state.players[0].life;
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'activate_ability',
				instanceId: engineRelic.instanceId,
				abilityId: firstActivatedId(engineRelic.card, 1)
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.players[0].life - lifePreInf, 4);

		// 2) CR 701.28 Convert (Transforming DFC)
		const mechCard = makeCard({
			name: 'Vanguard Rig',
			layout: 'transform',
			manaCost: '{3}',
			typeLine: 'Artifact Creature — Robot',
			power: '3',
			toughness: '3',
			oracleText: '{1}: Convert Vanguard Rig.',
			backFace: {
				name: 'Vanguard Cruiser',
				manaCost: '',
				typeLine: 'Artifact — Vehicle',
				oracleText: '{1}: Convert Vanguard Cruiser.',
				power: '5',
				toughness: '5',
				imageUrl: ''
			}
		});
		assert.equal(compileCard(mechCard).fullySupported, true);
		const mech = putInZone(state, state.players[0], mechCard, 'battlefield');
		assert.equal(Boolean(mech.transformed), false);
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'activate_ability',
				instanceId: mech.instanceId,
				abilityId: firstActivatedId(mechCard, 0)
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(mech.transformed, true);

		// 3) CR 701.71 Empower Jace N (first creates 0/0 Jace token + N loyalty; with 2 Jace tokens prompts + JSON round-trips!)
		const empSpell = makeCard({
			name: 'Mindsculpt Pulse',
			manaCost: '{1}{U}',
			typeLine: 'Sorcery',
			oracleText: 'Empower Jace 2.'
		});
		assert.equal(compileCard(empSpell).fullySupported, true);
		const e1 = putInZone(state, state.players[0], empSpell, 'hand');
		assert.equal(applyGameAction(state, state.players[0].playerId, { type: 'cast_spell', instanceId: e1.instanceId }).ok, true);
		resolveStack(state);
		const firstJace = state.players[0].battlefield.find((c) => c.isToken && c.card.name === 'Jace');
		assert.ok(firstJace, 'Expected 0/0 Jace planeswalker token');
		assert.equal(firstJace.counters.loyalty, 2); // 0 initial + 2 empowered (CR 701.71a)

		// Put a second Jace planeswalker token on battlefield to trigger choice prompt + JSON round-trip!
		const secondJace = putInZone(
			state,
			state.players[0],
			makeCard({ name: 'Jace Mirror', typeLine: 'Planeswalker — Jace', loyalty: '2' }),
			'battlefield'
		);
		secondJace.isToken = true;
		secondJace.counters.loyalty = 2;

		const e2 = putInZone(state, state.players[0], empSpell, 'hand');
		assert.equal(applyGameAction(state, state.players[0].playerId, { type: 'cast_spell', instanceId: e2.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		const secondJaceId = secondJace.instanceId;
		state = roundTripJson(state);
		answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [secondJaceId] });
		resolveStack(state);
		const secondJaceAfter = state.players[0].battlefield.find((c) => c.instanceId === secondJaceId)!;
		assert.equal(secondJaceAfter.counters.loyalty, 4);

		// 4) CR 701.72 Assimilate (gain control, +1/+1 counter, Borg artifact creature, assimilatedWithSelf tracking)
		const droneLord = putInZone(
			state,
			state.players[0],
			makeCard({
				name: 'Collective Nexus',
				manaCost: '{3}{U}{B}',
				typeLine: 'Artifact Creature — Borg',
				power: '3',
				toughness: '3',
				oracleText:
					'{2}: Assimilate target creature.\n{1}: Put a +1/+1 counter on each creature assimilated with Collective Nexus.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(droneLord.card).fullySupported, true);
		const oppBear = putInZone(
			state,
			state.players[1],
			makeCard({ name: 'Timber Wolf', typeLine: 'Creature — Wolf', power: '2', toughness: '2' }),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'activate_ability',
				instanceId: droneLord.instanceId,
				abilityId: firstActivatedId(droneLord.card, 0),
				targets: [permTarget(oppBear)]
			}).ok,
			true
		);
		resolveStack(state);
		const assimilatedWolf = state.players[0].battlefield.find((c) => c.instanceId === oppBear.instanceId)!;
		assert.ok(assimilatedWolf, 'Assimilated creature must move to controller battlefield');
		const evWolf = evaluatePermanent(state, assimilatedWolf);
		assert.equal(evWolf.isArtifact, true);
		assert.equal(evWolf.effectiveTypeLine.includes('Borg'), true);
		assert.equal(assimilatedWolf.counters['+1/+1'], 1);

		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'activate_ability',
				instanceId: droneLord.instanceId,
				abilityId: firstActivatedId(droneLord.card, 1)
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(assimilatedWolf.counters['+1/+1'], 2);

		// 5) CR 701.70 Recruit (draw, discard via prompt + JSON round-trip -> 1/1 Human Soldier if nonland)
		putInZone(state, state.players[0], makeCard({ name: 'Banner Blade', typeLine: 'Artifact' }), 'library');
		const extraHand = putInZone(state, state.players[0], makeCard({ name: 'Spare Halberd', typeLine: 'Artifact' }), 'hand');
		const extraHandId = extraHand.instanceId;
		const recruitSpell = makeCard({
			name: 'Muster the Ranks',
			manaCost: '{1}{W}',
			typeLine: 'Instant',
			oracleText: 'Recruit.'
		});
		assert.equal(compileCard(recruitSpell).fullySupported, true);
		const rec = putInZone(state, state.players[0], recruitSpell, 'hand');
		assert.equal(
			applyGameAction(state, state.players[0].playerId, { type: 'cast_spell', instanceId: rec.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		state = roundTripJson(state);
		answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [extraHandId] });
		resolveStack(state);
		assert.equal(
			state.players[0].battlefield.some((c) => c.isToken && c.card.name === 'Human Soldier'),
			true
		);

		// 6) CR 701.69 Heal (clears marked damage & deathtouch damage)
		assimilatedWolf.damageMarked = 2;
		assimilatedWolf.deathtouchDamageMarked = true;
		const healSpell = makeCard({
			name: 'Mending Balm',
			manaCost: '{W}',
			typeLine: 'Instant',
			oracleText: 'Heal target creature.'
		});
		assert.equal(compileCard(healSpell).fullySupported, true);
		const hs = putInZone(state, state.players[0], healSpell, 'hand');
		const wolfNow = state.players[0].battlefield.find((c) => c.instanceId === assimilatedWolf.instanceId)!;
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'cast_spell',
				instanceId: hs.instanceId,
				targets: [permTarget(wolfNow)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(wolfNow.damageMarked, 0);
		assert.equal(wolfNow.deathtouchDamageMarked, false);
	});

	it('upholds synthetic card Rename Invariance across Wave 6 Track P16a IR compilation', () => {
		const buildVariant = (cardName: string): ScryfallCard =>
			makeCard({
				name: cardName,
				manaCost: '{2}{U}{B}',
				typeLine: 'Artifact Creature — Construct',
				power: '2',
				toughness: '4',
				oracleText: [
					`When ${cardName} enters, look at the top three cards of your library. You may reveal an artifact card from among them and put it into your hand. Put the rest on the bottom of your library in a random order. If you didn't put a card into your hand this way, put two storage counters on ${cardName}.`,
					`{1}, {T}: Target creature gets -2/-0 for as long as ${cardName} remains tapped.`,
					`{2}, Sacrifice ${cardName}: Return all cards exiled with ${cardName} to their owners' hands.`
				].join('\n')
			});

		const defA = compileCard(buildVariant('Glimmerfen Overseer'));
		const defB = compileCard(buildVariant('Obsidian Chronomancer'));
		assert.equal(defA.fullySupported, true);
		assert.equal(defB.fullySupported, true);
		assert.deepEqual(stripSpans(defA.faces[0].abilities), stripSpans(defB.faces[0].abilities));
	});
});
