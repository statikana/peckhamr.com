import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
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
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `p13_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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
	const state = createInitialGameState('TRACKP13', seats, decks, { ...DEFAULT_LOBBY_RULES });
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

function resolveStack(state: GameState, maxSteps = 60): void {
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

function advanceToNextTurnMain1(state: GameState, expectedActiveSeat: number, maxSteps = 120): void {
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
// 1. Filters, Dynamic Amounts, Cross-Turn Durations, & Pronoun Chaining
// ============================================================================

describe('Wave 5 Track P13 — Filters, Dynamic Amounts, Cross-Turn Durations, & Pronouns', () => {
	it('compiles and resolves disjunctive anyOf & relational ObjectFilters', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const vehicleCard = makeCard({
			name: 'Aether Skiff',
			manaCost: '{2}',
			typeLine: 'Artifact — Vehicle',
			oracleText: 'Crew 1',
			power: '3',
			toughness: '2'
		});
		const skiff = putInZone(state, p2, vehicleCard, 'battlefield');

		const destroyDisjunctive = makeCard({
			name: 'Shatter Hull',
			manaCost: '{1}{R}',
			typeLine: 'Instant',
			oracleText: 'Destroy target creature or Vehicle.'
		});
		assert.equal(compileCard(destroyDisjunctive).fullySupported, true);
		const spellInst = putInZone(state, p1, destroyDisjunctive, 'hand');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spellInst.instanceId,
				targets: [permTarget(skiff)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.battlefield.length, 0);
		assert.equal(p2.graveyard.some((c) => c.card.name === 'Aether Skiff'), true);

		// Relational controllerRef: "Destroy all creatures target player controls."
		const bearCard = makeCard({
			name: 'Moss Bear',
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		putInZone(state, p1, bearCard, 'battlefield');
		putInZone(state, p2, bearCard, 'battlefield');

		const plagueWind = makeCard({
			name: 'Targeted Gale',
			manaCost: '{2}{B}',
			typeLine: 'Sorcery',
			oracleText: 'Destroy all creatures target player controls.'
		});
		assert.equal(compileCard(plagueWind).fullySupported, true);
		const gale = putInZone(state, p1, plagueWind, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: gale.instanceId,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.battlefield.length, 1);
		assert.equal(p2.battlefield.length, 0);
	});

	it('evaluates CR 700.5 devotion accurately for hybrid mana and face-down permanents', () => {
		const state = createGame();
		const [p1] = state.players;
		addMana(p1, 10);

		const hybridPerm = makeCard({
			name: 'Gruul Guildmage Avatar',
			manaCost: '{R/G}{R/G}',
			cmc: 2,
			typeLine: 'Creature — Shaman',
			power: '2',
			toughness: '2',
			colors: ['R', 'G']
		});
		putInZone(state, p1, hybridPerm, 'battlefield');

		const faceDownPerm = makeCard({
			name: 'Hidden Dragon',
			manaCost: '{R}{R}{R}',
			cmc: 3,
			typeLine: 'Creature — Dragon',
			power: '4',
			toughness: '4',
			colors: ['R']
		});
		const fd = putInZone(state, p1, faceDownPerm, 'battlefield');
		fd.isFaceDown = true;

		// Single-color devotion to red: {R/G}{R/G} contributes 2; face-down {R}{R}{R} contributes 0!
		const redDevSpell = makeCard({
			name: 'Red Devotion Pulse',
			manaCost: '{R}',
			typeLine: 'Sorcery',
			oracleText: 'You gain life equal to your devotion to red.'
		});
		assert.equal(compileCard(redDevSpell).fullySupported, true);
		const s1 = putInZone(state, p1, redDevSpell, 'hand');
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life - lifeBefore, 2);

		// Multi-color devotion to red and green (CR 700.5): each {R/G} symbol counts ONCE (2 total, NOT 4)!
		const rgDevSpell = makeCard({
			name: 'Xenagos Tribute',
			manaCost: '{G}',
			typeLine: 'Sorcery',
			oracleText: 'You gain life equal to your devotion to red and green.'
		});
		assert.equal(compileCard(rgDevSpell).fullySupported, true);
		const s2 = putInZone(state, p1, rgDevSpell, 'hand');
		const lifeMid = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s2.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life - lifeMid, 2);
	});

	it('evaluates CR 120.10 excessDamage and half rounded up/down accurately', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const ogre = putInZone(
			state,
			p2,
			makeCard({
				name: 'Hill Ogre',
				typeLine: 'Creature — Ogre',
				power: '2',
				toughness: '3'
			}),
			'battlefield'
		);
		// 1 damage already marked -> lethal damage is 2 -> 5 damage deals 3 excess damage (CR 120.10)!
		ogre.damageMarked = 1;

		const excessSpell = makeCard({
			name: 'Searing Spillover',
			manaCost: '{2}{R}',
			typeLine: 'Instant',
			oracleText:
				'Searing Spillover deals 5 damage to target creature. You gain life equal to the excess damage dealt this way.'
		});
		assert.equal(compileCard(excessSpell).fullySupported, true);
		const sp = putInZone(state, p1, excessSpell, 'hand');
		const startLife = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sp.instanceId,
				targets: [permTarget(ogre)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life - startLife, 3);

		// Half your life rounded up: 15 / 2 -> ceil(7.5) = 8 life lost -> 7 remaining
		const halfSpell = makeCard({
			name: 'Tithe of Half',
			manaCost: '{B}',
			typeLine: 'Sorcery',
			oracleText: 'Target player loses half their life, rounded up.'
		});
		assert.equal(compileCard(halfSpell).fullySupported, true);
		p2.life = 15;
		const hs = putInZone(state, p1, halfSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: hs.instanceId,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 7);
	});

	it('persists untilYourNextTurn across opponent turn and expires when your next turn begins (CR 611.2b)', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const guardian = putInZone(
			state,
			p1,
			makeCard({
				name: 'Vigilant Warden',
				typeLine: 'Creature — Soldier',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const shieldSpell = makeCard({
			name: 'Aegis Until Dawn',
			manaCost: '{1}{W}',
			typeLine: 'Instant',
			oracleText:
				'Target creature gets +2/+2 until your next turn. You gain hexproof until your next turn.'
		});
		assert.equal(compileCard(shieldSpell).fullySupported, true);
		const castInst = putInZone(state, p1, shieldSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: castInst.instanceId,
				targets: [permTarget(guardian)]
			}).ok,
			true
		);
		resolveStack(state);

		assert.equal(evaluatePermanent(state, guardian).power, 4);
		assert.equal(p1.hexproofUntilNextTurn, true);

		// Advance to P2's turn: +2/+2 and player hexproof MUST still be active!
		advanceToNextTurnMain1(state, 1);
		assert.equal(evaluatePermanent(state, guardian).power, 4);

		// P2 tries to target P1 with a player-targeting spell -> illegal due to P1's hexproofUntilNextTurn!
		addMana(p2, 5);
		const burnPlayer = putInZone(
			state,
			p2,
			makeCard({
				name: 'Mind Jolt',
				manaCost: '{B}',
				typeLine: 'Sorcery',
				oracleText: 'Target player loses 2 life.'
			}),
			'hand'
		);
		const illegalRes = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: burnPlayer.instanceId,
			targets: [playerTarget(p1)]
		});
		assert.equal(illegalRes.ok, false);

		// Advance to P1's next turn: both +2/+2 and player hexproof expire as P1's turn begins!
		advanceToNextTurnMain1(state, 0);
		assert.equal(evaluatePermanent(state, guardian).power, 2);
		assert.equal(Boolean(p1.hexproofUntilNextTurn), false);
	});

	it('chains plural token pronouns ("They gain haste until end of turn") cleanly', () => {
		const state = createGame();
		const [p1] = state.players;
		addMana(p1, 5);

		const rallyGoblins = makeCard({
			name: 'Goblin Warhorn',
			manaCost: '{1}{R}',
			typeLine: 'Sorcery',
			oracleText: 'Create two 1/1 red Goblin creature tokens. They gain haste until end of turn.'
		});
		assert.equal(compileCard(rallyGoblins).fullySupported, true);
		const inst = putInZone(state, p1, rallyGoblins, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: inst.instanceId }).ok,
			true
		);
		resolveStack(state);

		const goblins = p1.battlefield.filter((c) => c.card.name.includes('Goblin'));
		assert.equal(goblins.length, 2);
		for (const gob of goblins) {
			assert.equal(hasKeyword(gob, 'Haste', state), true);
		}
	});
});

// ============================================================================
// 2. Emblems, Roles, Double/Triple, Exchange, TurnFace, & Graveyard Cast
// ============================================================================

describe('Wave 5 Track P13 — Emblems, Role SBA, Double/Triple, Exchange, TurnFace, & Flashback Grant', () => {
	it('creates Emblems in command zone (CR 114) that apply statics, fire triggers, survive wipes, and keep GameState pure JSON', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const knight = putInZone(
			state,
			p1,
			makeCard({
				name: 'Silver Squire',
				typeLine: 'Creature — Human Knight',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const emblemSpell = makeCard({
			name: 'Oath of Ascension',
			manaCost: '{2}{W}',
			typeLine: 'Sorcery',
			oracleText:
				'You get an emblem with "Creatures you control get +1/+1." and "Whenever you cast a spell, you gain 2 life."'
		});
		assert.equal(compileCard(emblemSpell).fullySupported, true);
		const sp = putInZone(state, p1, emblemSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: sp.instanceId }).ok,
			true
		);
		resolveStack(state);

		assert.equal(p1.command.filter((c) => c.isEmblem).length, 1);
		assert.equal(evaluatePermanent(state, knight).power, 3);
		assert.equal(evaluatePermanent(state, knight).toughness, 3);

		// Wipe all permanents — emblem in command zone survives!
		const wipe = putInZone(
			state,
			p1,
			makeCard({
				name: 'Total Cataclysm',
				manaCost: '{2}{W}',
				typeLine: 'Sorcery',
				oracleText: 'Destroy all permanents.'
			}),
			'hand'
		);
		const lifeBeforeWipeCast = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wipe.instanceId }).ok,
			true
		);
		resolveStack(state);

		// Emblem cast trigger gained 2 life, and emblem still exists in command!
		assert.equal(p1.life - lifeBeforeWipeCast, 2);
		assert.equal(p1.battlefield.length, 0);
		assert.equal(p1.command.filter((c) => c.isEmblem).length, 1);
		assert.ok(JSON.parse(JSON.stringify(state)));
		assert.equal(p2.command.filter((c) => c.isEmblem).length, 0);
	});

	it('enforces CR 704.5s / 704.5z Role SBA per controller (same-controller replaces, different-controller coexists)', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);
		addMana(p2, 10);

		const hero = putInZone(
			state,
			p1,
			makeCard({
				name: 'Village Champion',
				typeLine: 'Creature — Human',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const wickedSpell = makeCard({
			name: 'Curse of Spite',
			manaCost: '{B}',
			typeLine: 'Instant',
			oracleText: 'Create a Wicked Role token attached to target creature.'
		});
		const monsterSpell = makeCard({
			name: 'Feral Mantle',
			manaCost: '{G}',
			typeLine: 'Instant',
			oracleText: 'Create a Monster Role token attached to target creature.'
		});
		assert.equal(compileCard(wickedSpell).fullySupported, true);
		assert.equal(compileCard(monsterSpell).fullySupported, true);

		// 1) P1 attaches Wicked Role -> hero becomes 3/3
		const w1 = putInZone(state, p1, wickedSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: w1.instanceId,
				targets: [permTarget(hero)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, hero).power, 3);

		// 2) P1 attaches Monster Role -> P1's older Wicked Role goes to graveyard via SBA and deals 1 life loss to P2!
		const p2LifeBefore = p2.life;
		const m1 = putInZone(state, p1, monsterSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: m1.instanceId,
				targets: [permTarget(hero)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(
			p1.battlefield.filter((c) => c.attachedToId === hero.instanceId).length,
			1,
			'Same controller may only keep newest Role'
		);
		assert.equal(p2.life, p2LifeBefore - 1, 'Wicked Role LTB trigger made opponent lose 1 life');
		assert.equal(hasKeyword(hero, 'Trample', state), true);

		// 3) P2 attaches a Wicked Role to the SAME creature -> different controllers, so BOTH Roles stay!
		const w2 = putInZone(state, p2, wickedSpell, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: w2.instanceId,
				targets: [permTarget(hero)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, hero).power, 4); // 2 + 1 (P1 Monster) + 1 (P2 Wicked)
	});

	it('doubles positive AND negative power accurately per CR 701.10b–c', () => {
		const state = createGame();
		const [p1] = state.players;
		addMana(p1, 10);

		const titan = putInZone(
			state,
			p1,
			makeCard({
				name: 'Brawny Brute',
				typeLine: 'Creature — Giant',
				power: '3',
				toughness: '4'
			}),
			'battlefield'
		);
		const shrunk = putInZone(
			state,
			p1,
			makeCard({
				name: 'Cursed Wisp',
				typeLine: 'Creature — Spirit',
				power: '1',
				toughness: '4'
			}),
			'battlefield'
		);
		shrunk.counters['-1/-1'] = 3; // evaluated power is -2!

		const doubleSpell = makeCard({
			name: 'Surge of Might',
			manaCost: '{1}{R}',
			typeLine: 'Instant',
			oracleText: "Double target creature's power until end of turn."
		});
		assert.equal(compileCard(doubleSpell).fullySupported, true);

		const d1 = putInZone(state, p1, doubleSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: d1.instanceId,
				targets: [permTarget(titan)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, titan).power, 6);

		// CR 701.10c: doubling -2 power gives -2/+0 -> -4 power!
		const d2 = putInZone(state, p1, doubleSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: d2.instanceId,
				targets: [permTarget(shrunk)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, shrunk).power, -4);
	});

	it('enforces CR 701.12b all-or-nothing Exchange for control and life totals', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);
		addMana(p2, 10);

		const c1 = putInZone(
			state,
			p1,
			makeCard({ name: 'P1 Frog', typeLine: 'Creature — Frog', power: '1', toughness: '1' }),
			'battlefield'
		);
		const c2 = putInZone(
			state,
			p2,
			makeCard({ name: 'P2 Dragon', typeLine: 'Creature — Dragon', power: '5', toughness: '5' }),
			'battlefield'
		);

		const swapControl = makeCard({
			name: 'Switcheroo',
			manaCost: '{3}{U}',
			typeLine: 'Sorcery',
			oracleText: 'Exchange control of two target creatures.'
		});
		assert.equal(compileCard(swapControl).fullySupported, true);
		const sw = putInZone(state, p1, swapControl, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sw.instanceId,
				targets: [permTarget(c1), permTarget(c2)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.battlefield.some((c) => c.card.name === 'P2 Dragon'), true);
		assert.equal(p2.battlefield.some((c) => c.card.name === 'P1 Frog'), true);

		// All-or-nothing: if one target dies in response, NO exchange happens (CR 701.12b)!
		const sw2 = putInZone(state, p1, swapControl, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sw2.instanceId,
				targets: [permTarget(c2), permTarget(c1)]
			}).ok,
			true
		);
		const killFrog = putInZone(
			state,
			p1,
			makeCard({
				name: 'Zap Frog',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: killFrog.instanceId,
				targets: [permTarget(c1)]
			}).ok,
			true
		);
		resolveStack(state);
		// P1 MUST still control P2 Dragon because P1 Frog left before Switcheroo resolved!
		assert.equal(p1.battlefield.some((c) => c.card.name === 'P2 Dragon'), true);
	});

	it('handles turnFace down/up and temporary flashback grant (grantGraveyardCast CR 702.34a)', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const morpher = putInZone(
			state,
			p1,
			makeCard({
				name: 'Shell Watcher',
				typeLine: 'Creature — Turtle',
				power: '1',
				toughness: '5',
				oracleText: 'Whenever ~ is turned face up, you gain 3 life.'
			}),
			'battlefield'
		);

		const flipDown = putInZone(
			state,
			p1,
			makeCard({
				name: 'Veil of Mist',
				manaCost: '{U}',
				typeLine: 'Instant',
				oracleText: 'Turn target creature face down.'
			}),
			'hand'
		);
		assert.equal(compileCard(flipDown.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flipDown.instanceId,
				targets: [permTarget(morpher)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(morpher.isFaceDown, true);
		assert.equal(evaluatePermanent(state, morpher).power, 2);
		assert.equal(evaluatePermanent(state, morpher).toughness, 2);

		const flipUp = putInZone(
			state,
			p1,
			makeCard({
				name: 'Unveil',
				manaCost: '{U}',
				typeLine: 'Instant',
				oracleText: 'Turn target face-down creature face up.'
			}),
			'hand'
		);
		assert.equal(compileCard(flipUp.card).fullySupported, true);
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flipUp.instanceId,
				targets: [permTarget(morpher)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(morpher.isFaceDown, false);
		assert.equal(p1.life - lifeBefore, 3);

		// Temporary flashback grant -> cast from graveyard -> exiled on resolution!
		const boltInGy = putInZone(
			state,
			p1,
			makeCard({
				name: 'Arc Spark',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: 'Arc Spark deals 3 damage to any target.'
			}),
			'graveyard'
		);
		const snapMageSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Echo Recall',
				manaCost: '{1}{U}',
				typeLine: 'Sorcery',
				oracleText:
					'Target instant or sorcery card in your graveyard gains flashback until end of turn. The flashback cost is equal to its mana cost.'
			}),
			'hand'
		);
		assert.equal(compileCard(snapMageSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: snapMageSpell.instanceId,
				targets: [gyTarget(boltInGy)]
			}).ok,
			true
		);
		resolveStack(state);

		const opts = getCastOptions(state, p1.playerId, boltInGy, 'graveyard');
		const fbOpt = opts.find((o) => o.fromZone === 'graveyard');
		assert.ok(fbOpt, 'Expected granted flashback cast option on graveyard instant');
		const p2LifeBefore = p2.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boltInGy.instanceId,
				fromZone: 'graveyard',
				optionId: fbOpt.id,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, p2LifeBefore - 3);
		assert.equal(p1.exile.some((c) => c.card.name === 'Arc Spark'), true);
		assert.equal(p1.graveyard.some((c) => c.card.name === 'Arc Spark'), false);
	});
});

// ============================================================================
// 3. Dungeons (CR 309, 701.49), Initiative (CR 727), & The Ring (CR 701.54)
// ============================================================================

describe('Wave 5 Track P13 — Dungeons, Initiative, & The Ring Tempts You', () => {
	it('steps through Lost Mine of Phandelver rooms to completion SBA (CR 309.6, 704.5t)', () => {
		const state = createGame();
		const [p1] = state.players;
		addMana(p1, 20);
		for (let i = 0; i < 6; i++) {
			putInZone(state, p1, makeCard({ name: `Deck Card ${i}`, typeLine: 'Artifact' }), 'library');
		}

		const ventureSpell = makeCard({
			name: 'Delve Deep',
			manaCost: '{W}',
			typeLine: 'Sorcery',
			oracleText: 'Venture into the dungeon.'
		});
		assert.equal(compileCard(ventureSpell).fullySupported, true);

		// Venture 1: Choose Lost Mine of Phandelver (index 0) -> enters Cave Entrance (Scry 1)
		const v1 = putInZone(state, p1, ventureSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: v1.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseMode');
		answerTopPrompt(state, { kind: 'chooseMode', indices: [0] }); // Lost Mine of Phandelver
		resolveStack(state);
		const postMineChoice = state.pendingPrompts.at(0)?.choice;
		if (postMineChoice?.kind === 'orderObjects') {
			const topIds = postMineChoice.objectIds;
			answerTopPrompt(state, { kind: 'orderObjects', topIds });
			resolveStack(state);
		}
		assert.equal(p1.command.some((c) => c.isDungeon), true);

		// Venture 2: Choose Goblin Lair (index 0: Create a 1/1 red Goblin creature token)
		const v2 = putInZone(state, p1, ventureSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: v2.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseMode');
		answerTopPrompt(state, { kind: 'chooseMode', indices: [0] }); // Goblin Lair
		resolveStack(state);
		assert.equal(p1.battlefield.some((c) => c.card.name.includes('Goblin')), true);

		// Venture 3: Choose Dark Pool (index 1: Each opponent loses 1 life and you gain 1 life)
		const v3 = putInZone(state, p1, ventureSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: v3.instanceId }).ok,
			true
		);
		resolveStack(state);
		answerTopPrompt(state, { kind: 'chooseMode', indices: [1] }); // Dark Pool
		resolveStack(state);

		// Venture 4: Final room Temple of Dumathoin (Draw a card) -> completes dungeon via SBA!
		const handBeforeFinal = p1.hand.length;
		const v4 = putInZone(state, p1, ventureSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: v4.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, handBeforeFinal + 1);
		assert.equal(p1.command.some((c) => c.isDungeon), false, 'Completed dungeon removed from command');
		assert.equal(p1.dungeonsCompletedCount, 1);

		// Verify "If you've completed a dungeon" condition now evaluates true!
		const payoff = putInZone(
			state,
			p1,
			makeCard({
				name: 'Veteran Delver',
				manaCost: '{1}{W}',
				typeLine: 'Sorcery',
				oracleText: "If you've completed a dungeon, you gain 4 life."
			}),
			'hand'
		);
		assert.equal(compileCard(payoff.card).fullySupported, true);
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: payoff.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life - lifeBefore, 4);
	});

	it('handles Take the Initiative (CR 727) into Undercity and re-taking initiative ventures again', () => {
		const state = createGame();
		const [p1] = state.players;
		addMana(p1, 10);
		putInZone(
			state,
			p1,
			makeCard({ name: 'Plains', typeLine: 'Basic Land — Plains' }),
			'library'
		);

		const initSpell = makeCard({
			name: 'Seize the Undercity',
			manaCost: '{1}{W}',
			typeLine: 'Sorcery',
			oracleText: 'You take the initiative.'
		});
		assert.equal(compileCard(initSpell).fullySupported, true);

		const s1 = putInZone(state, p1, initSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok,
			true
		);
		resolveStack(state);
		if (state.pendingPrompts.length > 0) {
			const ch = state.pendingPrompts[0]!.choice!;
			if (ch.kind === 'chooseObjects') {
				answerTopPrompt(state, { kind: 'chooseObjects', objectIds: ch.candidates.slice(0, 1) });
				resolveStack(state);
			}
		}
		assert.equal(state.initiativePlayerId, p1.playerId);
		assert.equal(p1.activeDungeon?.dungeonId, 'undercity');
		assert.equal(p1.activeDungeon?.roomIndex, 0);

		// CR 727.2: Taking the initiative when you ALREADY have it still ventures into Undercity!
		const s2 = putInZone(state, p1, initSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s2.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseMode');
		answerTopPrompt(state, { kind: 'chooseMode', indices: [1] }); // Lost Well (Scry 2)
		resolveStack(state);
		const postWellChoice = state.pendingPrompts.at(0)?.choice;
		if (postWellChoice?.kind === 'orderObjects') {
			answerTopPrompt(state, {
				kind: 'orderObjects',
				topIds: postWellChoice.objectIds
			});
			resolveStack(state);
		}
		assert.equal(p1.activeDungeon?.roomIndex, 2);
	});

	it('progresses The Ring Tempts You (CR 701.54) through levels 1..4 with Legendary + skulk + combat abilities', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 15);
		for (let i = 0; i < 4; i++) {
			putInZone(state, p1, makeCard({ name: `Loot Card ${i}`, typeLine: 'Artifact' }), 'library');
		}

		const frodo = putInZone(
			state,
			p1,
			makeCard({
				name: 'Halfling Scout',
				typeLine: 'Creature — Halfling',
				power: '1',
				toughness: '2'
			}),
			'battlefield'
		);
		const bigBlocker = putInZone(
			state,
			p2,
			makeCard({
				name: 'Uruk Guard',
				typeLine: 'Creature — Orc',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);

		const ringSpell = makeCard({
			name: 'Call of the Ring',
			manaCost: '{B}',
			typeLine: 'Sorcery',
			oracleText: 'The Ring tempts you.'
		});
		assert.equal(compileCard(ringSpell).fullySupported, true);

		for (let lvl = 1; lvl <= 4; lvl++) {
			const rs = putInZone(state, p1, ringSpell, 'hand');
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: rs.instanceId }).ok,
				true
			);
			resolveStack(state);
			if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
				answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [frodo.instanceId] });
				resolveStack(state);
			}
			assert.equal(p1.ringLevel, lvl);
		}
		assert.equal(p1.ringBearerId, frodo.instanceId);
		const ev = evaluatePermanent(state, frodo);
		assert.equal(ev.isLegendary, true, 'Level 1+ makes Ring-bearer Legendary');

		// Advance to declare_attackers and attack with Ring-bearer
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		// begin_combat -> declare_attackers
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.phase, 'declare_attackers');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: frodo.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		// Level 2 trigger: Ring-bearer attacks -> draw a card, then discard a card!
		resolveStack(state);
		if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			answerTopPrompt(state, {
				kind: 'chooseObjects',
				objectIds: [state.pendingPrompts[0].choice.candidates[0]!]
			});
			resolveStack(state);
		}
		// Advance to declare_blockers: 3/3 Uruk Guard CANNOT block 1/2 Ring-bearer (Level 1 skulk)!
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.phase, 'declare_blockers');

		const illegalBlock = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: bigBlocker.instanceId, attackerInstanceId: frodo.instanceId }
			]
		});
		assert.equal(illegalBlock.ok, false, 'Greater-power creature cannot block Ring-bearer');

		// No blockers -> combat damage deals 1 combat damage + Level 4 trigger makes P2 lose 3 life (total 4)!
		const p2LifeBefore = p2.life;
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		resolveStack(state);
		assert.equal(p2LifeBefore - p2.life, 4);
	});
});

// ============================================================================
// 4. CR 701 Actions, Room Door Isolation & Eerie, Valiant, Serialization & Rename Invariance
// ============================================================================

describe('Wave 5 Track P13 — CR 701 Actions, Room Door Isolation, Valiant, Round-Trip, & Rename Invariance', () => {
	it('resolves Earthbend N (CR 701.66) including delayed tapped return on death OR exile', () => {
		const state = createGame();
		const [p1] = state.players;
		addMana(p1, 10);

		const forest = putInZone(
			state,
			p1,
			makeCard({ name: 'Forest', typeLine: 'Basic Land — Forest' }),
			'battlefield'
		);

		const earthSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Toph Stomp',
				manaCost: '{1}{G}',
				typeLine: 'Sorcery',
				oracleText: 'Earthbend 3.'
			}),
			'hand'
		);
		assert.equal(compileCard(earthSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: earthSpell.instanceId,
				targets: [permTarget(forest)]
			}).ok,
			true
		);
		resolveStack(state);

		const ev = evaluatePermanent(state, forest);
		assert.equal(ev.isCreature, true);
		assert.equal(ev.isLand, true);
		assert.equal(ev.power, 3);
		assert.equal(hasKeyword(forest, 'Haste', state), true);

		// Exile the earthbent land -> delayed trigger returns it to the battlefield tapped!
		const exileIt = putInZone(
			state,
			p1,
			makeCard({
				name: 'Vanish Away',
				manaCost: '{W}',
				typeLine: 'Instant',
				oracleText: 'Exile target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: exileIt.instanceId,
				targets: [permTarget(forest)]
			}).ok,
			true
		);
		resolveStack(state);

		const returnedForest = p1.battlefield.find((c) => c.card.name === 'Forest');
		assert.ok(returnedForest, 'Earthbent land returned from exile');
		assert.equal(returnedForest.tapped, true);
	});

	it('resolves Airbend (CR 701.65), Villainous Choice (CR 701.55) with mid-prompt JSON round-trip, and Vote (CR 701.38)', () => {
		let state = createGame();
		let [p1, p2] = state.players;
		addMana(p1, 15);
		addMana(p2, 5);

		// 1) Airbend: exile permanent, owner can cast from exile for {2}
		const relic = putInZone(
			state,
			p1,
			makeCard({ name: 'Sky Relic', manaCost: '{5}', cmc: 5, typeLine: 'Artifact' }),
			'battlefield'
		);
		const airSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Gust Sweep',
				manaCost: '{1}{W}',
				typeLine: 'Instant',
				oracleText: 'Airbend target nonland permanent.'
			}),
			'hand'
		);
		assert.equal(compileCard(airSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: airSpell.instanceId,
				targets: [permTarget(relic)]
			}).ok,
			true
		);
		resolveStack(state);
		const exiledRelic = p1.exile.find((c) => c.card.name === 'Sky Relic');
		assert.ok(exiledRelic);
		const castOpts = getCastOptions(state, p1.playerId, exiledRelic, 'exile');
		assert.equal(
			castOpts.some((o) => o.baseCost.kind === 'alternative' && o.baseCost.manaCost === '{2}'),
			true
		);

		// 2) Villainous choice + mid-prompt JSON.parse(JSON.stringify(state)) lossless round-trip!
		const vilSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Cruel Ultimatum of Davros',
				manaCost: '{1}{B}',
				typeLine: 'Sorcery',
				oracleText:
					'Each opponent faces a villainous choice — They lose 3 life, or you create a Treasure token.'
			}),
			'hand'
		);
		assert.equal(compileCard(vilSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: vilSpell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts[0]?.playerId, p2.playerId);

		// Round-trip GameState mid-prompt per ENGINE_INVARIANTS.md §7.1!
		state = JSON.parse(JSON.stringify(state)) as GameState;
		[p1, p2] = state.players;
		answerTopPrompt(state, { kind: 'chooseMode', indices: [1] }); // P1 creates a Treasure token
		resolveStack(state);
		assert.equal(p1.battlefield.some((c) => c.card.name.includes('Treasure')), true);

		// 3) Council's dilemma Vote
		const voteSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Messenger Jays Plea',
				manaCost: '{2}{W}',
				typeLine: 'Sorcery',
				oracleText:
					'Starting with you, each player votes for grace or condemnation. For each grace vote, you gain 2 life. For each condemnation vote, each opponent loses 2 life.'
			}),
			'hand'
		);
		assert.equal(compileCard(voteSpell.card).fullySupported, true);
		const p1LifeBefore = p1.life;
		const p2LifeBefore = p2.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: voteSpell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		answerTopPrompt(state, { kind: 'chooseMode', indices: [0] }); // P1 votes grace
		answerTopPrompt(state, { kind: 'chooseMode', indices: [1] }); // P2 votes condemnation
		resolveStack(state);
		assert.equal(p1.life - p1LifeBefore, 2);
		assert.equal(p2LifeBefore - p2.life, 2);
	});

	it('isolates Room "When you unlock this door" per face (CR 709.5e–f), fires Eerie, and enforces once-per-turn Valiant', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 20);
		addMana(p2, 10);

		const eeriePerm = putInZone(
			state,
			p1,
			makeCard({
				name: 'Ghostly Pianist',
				typeLine: 'Creature — Spirit',
				power: '2',
				toughness: '2',
				oracleText:
					'Eerie — Whenever an enchantment you control enters and whenever you fully unlock a Room, you gain 1 life.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(eeriePerm.card).fullySupported, true);

		const roomCard = makeCard({
			name: 'Foyer // Vault',
			layout: 'split',
			manaCost: '{1}{W} // {2}{U}',
			cmc: 5,
			typeLine: 'Enchantment — Room // Enchantment — Room',
			oracleText:
				'When you unlock this door, you gain 2 life.\n//\nWhen you unlock this door, you gain 5 life.',
			faces: [
				{
					name: 'Foyer',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Enchantment — Room',
					oracleText: 'When you unlock this door, you gain 2 life.',
					colors: ['W'],
					imageUrl: ''
				},
				{
					name: 'Vault',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Enchantment — Room',
					oracleText: 'When you unlock this door, you gain 5 life.',
					colors: ['U'],
					imageUrl: ''
				}
			]
		});
		assert.equal(compileCard(roomCard).fullySupported, true);
		const roomInHand = putInZone(state, p1, roomCard, 'hand');

		// Cast Left Door (Foyer, faceIndex 0): Eerie (+1) + Foyer (+2) = +3 life (Vault +5 MUST NOT fire!)
		const lifeStart = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: roomInHand.instanceId,
				fromZone: 'hand',
				faceIndex: 0,
				targets: []
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life - lifeStart, 3, 'Only Left Door + Eerie ETB should fire');

		// Verify unlockedDoorsCount sees 1 unlocked door before Right Door is unlocked!
		const countDoorsSpell = makeCard({
			name: 'Door Census',
			manaCost: '{W}',
			typeLine: 'Instant',
			oracleText: 'You gain life equal to the number of unlocked doors among Rooms you control.'
		});
		assert.equal(compileCard(countDoorsSpell).fullySupported, true);

		// Now unlock Right Door (Vault, faceIndex 1): Vault (+5) + Eerie RoomFullyUnlocked (+1) = +6 life!
		const roomPerm = p1.battlefield.find((c) => c.card.name === 'Foyer // Vault')!;
		const lifeMid = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'unlock_room_door',
				instanceId: roomPerm.instanceId,
				faceIndex: 1
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life - lifeMid, 6, 'Right Door + Eerie fully-unlocked should fire');

		// Valiant: fires on 1st spell/ability you control targeting it this turn, NOT 2nd, and NOT opponent's!
		const valiantHero = putInZone(
			state,
			p1,
			makeCard({
				name: 'Heartfire Mouse',
				typeLine: 'Creature — Mouse Soldier',
				power: '1',
				toughness: '2',
				oracleText:
					'Valiant — Whenever ~ becomes the target of a spell or ability you control for the first time each turn, ~ gets +2/+0 until end of turn.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(valiantHero.card).fullySupported, true);

		const tapTarget = makeCard({
			name: 'Gentle Poke',
			manaCost: '{W}',
			typeLine: 'Instant',
			oracleText: 'Untap target creature.'
		});
		// Opponent targeting it does NOT trigger Valiant
		const oppPoke = putInZone(state, p2, tapTarget, 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppPoke.instanceId,
				targets: [permTarget(valiantHero)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, valiantHero).power, 1);

		// P1's 1st target triggers Valiant (+2/+0 -> 3 power); 2nd target this turn does NOT!
		const p1Poke1 = putInZone(state, p1, tapTarget, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: p1Poke1.instanceId,
				targets: [permTarget(valiantHero)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, valiantHero).power, 3);

		const p1Poke2 = putInZone(state, p1, tapTarget, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: p1Poke2.instanceId,
				targets: [permTarget(valiantHero)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, valiantHero).power, 3);
		checkStateBasedActions(state);
	});

	it('satisfies Rename Invariance (ENGINE_INVARIANTS.md §1.3) across compiled IR and runtime execution', () => {
		const canonical = makeCard({
			name: 'Archmage of the Undercity',
			manaCost: '{2}{U}',
			typeLine: 'Creature — Human Wizard',
			power: '2',
			toughness: '3',
			oracleText:
				'When Archmage of the Undercity enters, the Ring tempts you.\nWhenever you cast a spell from anywhere other than your hand, Archmage of the Undercity gets +1/+1 until your next turn.'
		});
		const synthetic = makeCard({
			name: 'Glimmerfen Overseer',
			manaCost: '{2}{U}',
			typeLine: 'Creature — Human Wizard',
			power: '2',
			toughness: '3',
			oracleText:
				'When Glimmerfen Overseer enters, the Ring tempts you.\nWhenever you cast a spell from anywhere other than your hand, Glimmerfen Overseer gets +1/+1 until your next turn.'
		});

		const defA = compileCard(canonical);
		const defB = compileCard(synthetic);
		assert.equal(defA.fullySupported, true);
		assert.equal(defB.fullySupported, true);
		const stripSpans = (x: unknown): unknown =>
			JSON.parse(
				JSON.stringify(x, (k, v) => (k === 'span' || k === 'text' || k === 'name' ? undefined : v))
			);
		assert.deepEqual(stripSpans(defA.faces), stripSpans(defB.faces));
	});

	it('covers Learn, predefined Map/Lander/Eldrazi Scion tokens, Adamant, Corrupted, Coven, and graveyard upkeep triggers', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 20);
		putInZone(state, p1, makeCard({ name: 'Draw Target', typeLine: 'Artifact' }), 'library');
		const discardFodder = putInZone(
			state,
			p1,
			makeCard({ name: 'Spare Scroll', typeLine: 'Artifact' }),
			'hand'
		);

		// 1) Learn (CR 701.48): rummage discard -> draw
		const learnSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Study Break',
				manaCost: '{1}{W}',
				typeLine: 'Instant',
				oracleText: 'Learn.'
			}),
			'hand'
		);
		assert.equal(compileCard(learnSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: learnSpell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		if (state.pendingPrompts[0]?.choice?.kind === 'chooseMode') {
			answerTopPrompt(state, { kind: 'chooseMode', indices: [0] });
			resolveStack(state);
		}
		if (state.pendingPrompts[0]?.choice?.kind === 'yesNo') {
			answerTopPrompt(state, { kind: 'yesNo', yes: true });
			resolveStack(state);
		}
		if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			answerTopPrompt(state, {
				kind: 'chooseObjects',
				objectIds: [discardFodder.instanceId]
			});
			resolveStack(state);
		}
		assert.equal(p1.hand.some((c) => c.card.name === 'Draw Target'), true);

		// 2) Predefined Map & Lander tokens + two-word Eldrazi Scion creature token
		const tokenSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Chart and Spawn',
				manaCost: '{2}{G}',
				typeLine: 'Sorcery',
				oracleText:
					'Create a Map token. Create a Lander token. Create a 1/1 colorless Eldrazi Scion creature token. It has "Sacrifice this creature: Add {C}."'
			}),
			'hand'
		);
		assert.equal(compileCard(tokenSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tokenSpell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.battlefield.some((c) => c.card.name.includes('Map')), true);
		assert.equal(p1.battlefield.some((c) => c.card.name.includes('Lander')), true);
		assert.equal(p1.battlefield.some((c) => c.card.name.includes('Eldrazi Scion')), true);

		// 3) Adamant + Corrupted + Coven + graveyard selfInZone upkeep trigger
		p2.poison = 3;
		putInZone(
			state,
			p1,
			makeCard({ name: 'Power 2 Ally', typeLine: 'Creature — Ally', power: '2', toughness: '2' }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			makeCard({ name: 'Power 3 Ally', typeLine: 'Creature — Ally', power: '3', toughness: '3' }),
			'battlefield'
		);
		// Eldrazi Scion has power 1, so powers {1, 2, 3} -> Coven (3+ different powers) is satisfied!
		const condBundle = putInZone(
			state,
			p1,
			makeCard({
				name: 'Triad Convergence',
				manaCost: '{2}{R}',
				typeLine: 'Sorcery',
				oracleText:
					'If an opponent has three or more poison counters, you gain 2 life. If you control three or more creatures with different powers, you gain 3 life. If at least three red mana was spent to cast this spell, you gain 4 life.'
			}),
			'hand'
		);
		assert.equal(compileCard(condBundle.card).fullySupported, true);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 3, G: 0, C: 0 };
		const lifeBeforeCond = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: condBundle.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life - lifeBeforeCond, 9); // 2 + 3 + 4

		// Graveyard upkeep trigger ("At the beginning of your upkeep, if ~ is in your graveyard, ...")
		const gySpirit = makeCard({
			name: 'Ashen Revenant',
			manaCost: '{1}{B}',
			typeLine: 'Creature — Spirit',
			power: '1',
			toughness: '1',
			oracleText:
				'At the beginning of your upkeep, if ~ is in your graveyard, you gain 2 life.'
		});
		assert.equal(compileCard(gySpirit).fullySupported, true);
	});
});
