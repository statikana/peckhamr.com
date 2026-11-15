import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `p7_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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
	const decks = new Map(seats.map((s, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]]));
	const state = createInitialGameState('TRACKP7', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		if (!p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
		p.hand = [];
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
	inst.summoningSick = false;
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		...(zone === 'library' ? { insert: 'start' } : {}),
		bumpVersion: true
	});
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

function resolveStack(state: GameState, maxSteps = 40): void {
	for (let i = 0; i < maxSteps; i++) {
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

function advanceToPhase(state: GameState, targetPhase: GameState['phase'], maxSteps = 50): void {
	for (let i = 0; i < maxSteps; i++) {
		if (state.phase === targetPhase && state.stack.length === 0 && state.pendingPrompts.length === 0) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			const choice = pr?.choice;
			if (pr?.purpose === 'trigger_order' && choice?.kind === 'orderObjects') {
				assert.equal(
					applyGameAction(state, pr.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'orderObjects', topIds: choice.objectIds }
					}).ok,
					true
				);
				continue;
			}
			assert.fail(`Unexpected prompt while advancing to ${targetPhase}: ${pr?.title}`);
		}
		const prio = state.players[state.priorityPlayerIndex];
		assert.ok(prio);
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
	}
	assert.equal(state.phase, targetPhase);
}

describe('Track P7 — Slice P7.1: Damage Prevention, Unpreventable Damage, Burn Riders, Combat Restrictions', () => {
	it('prevents combat damage globally via Fog without preventing noncombat spell damage (CR 615.1)', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 10);
		addMana(p2, 10);

		const attacker = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Ogre',
				typeLine: 'Creature — Ogre',
				power: '4',
				toughness: '4',
				oracleText: ''
			}),
			'battlefield'
		);
		const fog = putInZone(
			state,
			p2,
			makeCard({
				name: 'Synth Fog',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Prevent all combat damage that would be dealt this turn.'
			}),
			'hand'
		);
		const bolt = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Bolt',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: 'Synth Bolt deals 3 damage to any target.'
			}),
			'hand'
		);
		assert.equal(compileCard(fog.card).fullySupported, true);

		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		// Pass priority to p2 in declare_attackers step (CR 508.2) and cast Fog before blockers/damage
		if (state.players[state.priorityPlayerIndex]?.playerId !== p2.playerId) {
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		}
		if (state.phase === 'declare_blockers') {
			assert.equal(
				applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok,
				true
			);
			if (state.players[state.priorityPlayerIndex]?.playerId !== p2.playerId) {
				assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			}
		}
		addMana(p2, 5);
		const fogCast = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: fog.instanceId
		});
		assert.equal(fogCast.ok, true, fogCast.error ?? '');
		resolveStack(state);

		advanceToPhase(state, 'main2');
		assert.equal(p2.life, 40, 'Fog must prevent all 4 combat damage');

		// Noncombat damage still goes through
		addMana(p1, 5);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 37, 'Fog must not prevent noncombat spell damage');
	});

	it('consumes next-N prevention shields and suppresses lifelink and damage triggers when fully prevented (CR 615.6–7)', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 10);
		p1.life = 30;

		const salve = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Salve',
				manaCost: '{W}',
				typeLine: 'Instant',
				oracleText: 'Prevent the next 3 damage that would be dealt to any target this turn.'
			}),
			'hand'
		);
		assert.equal(compileCard(salve.card).fullySupported, true);

		const pinger = putInZone(
			state,
			p1,
			makeCard({
				name: 'Lifelink Pinger',
				typeLine: 'Creature — Cleric',
				power: '2',
				toughness: '2',
				keywords: ['Lifelink'],
				oracleText:
					'Lifelink\n{T}: Lifelink Pinger deals 2 damage to any target.\nWhenever Lifelink Pinger deals damage, draw a card.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(pinger.card).fullySupported, true);

		const burn4 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Flame',
				manaCost: '{1}{R}',
				typeLine: 'Instant',
				oracleText: 'Synth Flame deals 4 damage to any target.'
			}),
			'hand'
		);

		// Put a 3-point shield on p2
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: salve.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveStack(state);

		// Activate Lifelink Pinger for 2 damage to p2 -> all 2 prevented (1 shield left)
		const actAbil = getEffectiveActivatedAbilities(state, p1, pinger).find((a) => !a.isManaAbility);
		assert.ok(actAbil);
		const handBefore = p1.hand.length;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: pinger.instanceId,
				abilityId: actAbil.id,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 40, '2 damage fully prevented');
		assert.equal(p1.life, 30, 'CR 615.6: prevented damage never grants lifelink life');
		assert.equal(p1.hand.length, handBefore, 'CR 615.6: prevented damage never triggers deals-damage');

		// Now deal 4 damage to p2 -> remaining 1 shield prevents 1, 3 damage goes through
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: burn4.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 37, 'Remaining 1 point of shield prevented 1 of 4 damage');
	});

	it("enforces CR 615.12 unpreventable damage ('Damage can\\'t be prevented this turn') including shield counters (CR 122.1c)", () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const targetBear = putInZone(
			state,
			p2,
			makeCard({
				name: 'Shielded Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '3',
				oracleText: ''
			}),
			'battlefield'
		);
		targetBear.counters.shield = 1;

		const salve = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Ward',
				manaCost: '{W}',
				typeLine: 'Instant',
				oracleText: 'Prevent all damage that would be dealt to target creature this turn.'
			}),
			'hand'
		);
		const stomp = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Stomp',
				manaCost: '{1}{R}',
				typeLine: 'Instant',
				oracleText: "Damage can't be prevented this turn. Synth Stomp deals 2 damage to any target."
			}),
			'hand'
		);
		assert.equal(compileCard(salve.card).fullySupported, true);
		assert.equal(compileCard(stomp.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: salve.instanceId,
				targets: [{ kind: 'permanent', id: targetBear.instanceId, label: targetBear.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: stomp.instanceId,
				targets: [{ kind: 'permanent', id: targetBear.instanceId, label: targetBear.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		assert.equal(
			targetBear.counters.shield ?? 0,
			0,
			'CR 122.1c + 615.12: shield counter is still removed even when damage cannot be prevented'
		);
		assert.equal(targetBear.damageMarked, 2, 'CR 615.12: unpreventable damage bypasses shields');
	});

	it('distinguishes Pillar of Flame ("dealt damage this way") from Lava Coil ("that creature") and Incinerate cantRegenerate', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const bearA = putInZone(
			state,
			p2,
			makeCard({ name: 'Bear A', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const bearB = putInZone(
			state,
			p2,
			makeCard({ name: 'Bear B', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const trollC = putInZone(
			state,
			p2,
			makeCard({ name: 'Regen Troll', typeLine: 'Creature — Troll', power: '2', toughness: '3' }),
			'battlefield'
		);
		trollC.regenerationShields = 1;

		const preventBearA = putInZone(
			state,
			p1,
			makeCard({
				name: 'Guard A',
				manaCost: '{W}',
				typeLine: 'Instant',
				oracleText: 'Prevent all damage that would be dealt to target creature this turn.'
			}),
			'hand'
		);
		const preventBearB = putInZone(
			state,
			p1,
			makeCard({
				name: 'Guard B',
				manaCost: '{W}',
				typeLine: 'Instant',
				oracleText: 'Prevent all damage that would be dealt to target creature this turn.'
			}),
			'hand'
		);
		const pillar = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Pillar',
				manaCost: '{R}',
				typeLine: 'Sorcery',
				oracleText:
					'Synth Pillar deals 2 damage to any target. If a creature dealt damage this way would die this turn, exile it instead.'
			}),
			'hand'
		);
		const coil = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Coil',
				manaCost: '{1}{R}',
				typeLine: 'Sorcery',
				oracleText:
					'Synth Coil deals 4 damage to target creature. If that creature would die this turn, exile it instead.'
			}),
			'hand'
		);
		const doomA = putInZone(
			state,
			p1,
			makeCard({ name: 'Doom A', manaCost: '{1}{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		const doomB = putInZone(
			state,
			p1,
			makeCard({ name: 'Doom B', manaCost: '{1}{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		const incinerate = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Incinerate',
				manaCost: '{1}{R}',
				typeLine: 'Instant',
				oracleText:
					"Synth Incinerate deals 3 damage to any target. A creature dealt damage this way can't be regenerated this turn."
			}),
			'hand'
		);

		assert.equal(compileCard(pillar.card).fullySupported, true);
		assert.equal(compileCard(coil.card).fullySupported, true);
		assert.equal(compileCard(incinerate.card).fullySupported, true);

		// Prevent damage to both Bear A and Bear B
		for (const [sp, tgt] of [
			[preventBearA, bearA],
			[preventBearB, bearB]
		] as const) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: sp.instanceId,
					targets: [{ kind: 'permanent', id: tgt.instanceId, label: tgt.card.name }]
				}).ok,
				true
			);
			resolveStack(state);
		}

		// Cast Pillar on Bear A (0 damage dealt) and Coil on Bear B (0 damage dealt), then destroy both!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: pillar.instanceId,
				targets: [{ kind: 'permanent', id: bearA.instanceId, label: bearA.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: coil.instanceId,
				targets: [{ kind: 'permanent', id: bearB.instanceId, label: bearB.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doomA.instanceId,
				targets: [{ kind: 'permanent', id: bearA.instanceId, label: bearA.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doomB.instanceId,
				targets: [{ kind: 'permanent', id: bearB.instanceId, label: bearB.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		assert.ok(
			p2.graveyard.some((c) => c.instanceId === bearA.instanceId),
			'Bear A had all damage prevented so "dealt damage this way" did not exile it'
		);
		assert.ok(
			p2.exile.some((c) => c.instanceId === bearB.instanceId),
			'Bear B was targeted by Lava Coil ("that creature") so it is exiled even when damage was prevented'
		);

		// Incinerate kills Regen Troll through its regeneration shield
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: incinerate.instanceId,
				targets: [{ kind: 'permanent', id: trollC.instanceId, label: trollC.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(
			p2.graveyard.some((c) => c.instanceId === trollC.instanceId),
			'cantBeRegeneratedThisTurn overrides active regeneration shield'
		);
	});

	it('enforces timed cantBlock and cantBeBlocked exceptBy restrictions in declare_blockers (CR 509.1b)', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const attacker = putInZone(
			state,
			p1,
			makeCard({ name: 'Sneaky Rogue', typeLine: 'Creature — Rogue', power: '3', toughness: '2' }),
			'battlefield'
		);
		const blocker1 = putInZone(
			state,
			p2,
			makeCard({ name: 'Guard One', typeLine: 'Creature — Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);
		const blocker2 = putInZone(
			state,
			p2,
			makeCard({ name: 'Guard Two', typeLine: 'Creature — Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);
		const blocker3 = putInZone(
			state,
			p2,
			makeCard({ name: 'Guard Three', typeLine: 'Creature — Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);

		const stunBlock = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Panic',
				manaCost: '{R}',
				typeLine: 'Sorcery',
				oracleText: "Target creature can't block this turn."
			}),
			'hand'
		);
		const menaceGrant = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Veer',
				manaCost: '{R}',
				typeLine: 'Sorcery',
				oracleText:
					"Target creature gets +1/+0 until end of turn and can't be blocked except by two or more creatures this turn."
			}),
			'hand'
		);
		assert.equal(compileCard(stunBlock.card).fullySupported, true);
		assert.equal(compileCard(menaceGrant.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: stunBlock.instanceId,
				targets: [{ kind: 'permanent', id: blocker1.instanceId, label: blocker1.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: menaceGrant.instanceId,
				targets: [{ kind: 'permanent', id: attacker.instanceId, label: attacker.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advanceToPhase(state, 'declare_blockers');

		// blocker1 can't block this turn
		const illegalCantBlock = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: blocker1.instanceId, attackerInstanceId: attacker.instanceId },
				{ blockerInstanceId: blocker2.instanceId, attackerInstanceId: attacker.instanceId }
			]
		});
		assert.equal(illegalCantBlock.ok, false);

		// Single blocker2 is illegal because attacker requires 2+ blockers
		const illegalSingle = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [{ blockerInstanceId: blocker2.instanceId, attackerInstanceId: attacker.instanceId }]
		});
		assert.equal(illegalSingle.ok, false);

		// Two legal blockers (blocker2 + blocker3) succeed
		const legalDouble = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: blocker2.instanceId, attackerInstanceId: attacker.instanceId },
				{ blockerInstanceId: blocker3.instanceId, attackerInstanceId: attacker.instanceId }
			]
		});
		assert.equal(legalDouble.ok, true, legalDouble.error ?? '');
	});
});

describe('Track P7 — Slice P7.2: Token Copies with Modifications, tappedAndAttacking, and Layer 1a becomeCopy', () => {
	it('applies CR 707.9a–d copy modifications (subtype replacement vs additive types/colors & nonlegendary)', () => {
		const state = createGame(2);
		const [p1] = state.players;
		addMana(p1, 20);

		const hero = putInZone(
			state,
			p1,
			makeCard({
				name: 'Aurelia Synth',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Legendary Creature — Human Knight',
				colors: ['W'],
				power: '3',
				toughness: '3',
				keywords: ['Vigilance'],
				oracleText: 'Vigilance'
			}),
			'battlefield'
		);

		const frogCopy = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Croak',
				manaCost: '{1}{G}',
				typeLine: 'Sorcery',
				oracleText: "Create a token that's a copy of target creature, except it's a 1/1 green Frog."
			}),
			'hand'
		);
		const zombieCopy = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Relic Clone',
				manaCost: '{2}{B}',
				typeLine: 'Sorcery',
				oracleText:
					"Create a token that's a copy of target creature you control, except it's not legendary and it's a 2/2 black Zombie in addition to its other colors and types."
			}),
			'hand'
		);
		assert.equal(compileCard(frogCopy.card).fullySupported, true);
		assert.equal(compileCard(zombieCopy.card).fullySupported, true);

		// Zombie additive non-legendary copy -> survives SBA alongside legendary original!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: zombieCopy.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.battlefield.length, 2, 'Nonlegendary token copy must not trigger legend rule');
		const zTok = p1.battlefield.find((c) => c.isToken)!;
		const zEv = evaluatePermanent(state, zTok);
		assert.equal(zEv.power, 2);
		assert.equal(zEv.toughness, 2);
		assert.equal(zEv.isLegendary, false);
		assert.deepEqual([...zEv.colors].sort(), ['B', 'W']);
		assert.ok(zEv.typeLine.includes('Human') && zEv.typeLine.includes('Knight') && zEv.typeLine.includes('Zombie'));
		assert.equal(hasKeyword(zTok, 'Vigilance', state), true);

		// Frog replacement copy of the non-legendary Zombie token -> replaces creature subtypes with Frog!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: frogCopy.instanceId,
				targets: [{ kind: 'permanent', id: zTok.instanceId, label: zTok.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		const fTok = p1.battlefield.find((c) => c.isToken && c.instanceId !== zTok.instanceId)!;
		const fEv = evaluatePermanent(state, fTok);
		assert.equal(fEv.power, 1);
		assert.equal(fEv.toughness, 1);
		assert.deepEqual(fEv.colors, ['G']);
		assert.ok(fEv.typeLine.includes('Frog') && !fEv.typeLine.includes('Zombie') && !fEv.typeLine.includes('Knight'));
	});

	it('creates tapped and attacking token copies during combat without triggering attack triggers (CR 508.4)', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;

		const captain = putInZone(
			state,
			p1,
			makeCard({
				name: 'Mirror Vanguard',
				typeLine: 'Creature — Human Warrior',
				power: '2',
				toughness: '2',
				oracleText:
					"Whenever Mirror Vanguard attacks, create a tapped and attacking token that's a copy of another target creature you control."
			}),
			'battlefield'
		);
		const ally = putInZone(
			state,
			p1,
			makeCard({
				name: 'Battlestriker',
				typeLine: 'Creature — Kor Soldier',
				power: '3',
				toughness: '1',
				oracleText: 'Whenever Battlestriker attacks, you gain 5 life.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(captain.card).fullySupported, true);
		assert.equal(compileCard(ally.card).fullySupported, true);

		advanceToPhase(state, 'declare_attackers');
		// Only captain is declared as attacker
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: captain.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		// Answer target prompt for Mirror Vanguard's attack trigger if prompted
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			const pr = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [ally.instanceId] }
				}).ok,
				true
			);
		}
		resolveStack(state);

		const copyToken = p1.battlefield.find((c) => c.isToken);
		assert.ok(copyToken, 'Token copy of Battlestriker created');
		assert.equal(copyToken.tapped, true);
		assert.ok(
			state.combat.attackers.some((a) => a.attackerInstanceId === copyToken.instanceId),
			'CR 508.4: token enters in combat.attackers'
		);
		assert.equal(p1.life, 40, 'CR 508.4c: entering attacking never fires "Whenever ~ attacks"');

		advanceToPhase(state, 'main2');
		assert.equal(p2.life, 35, '2 (captain) + 3 (attacking token copy) = 5 combat damage dealt');
	});

	it('applies Layer 1a becomeCopy underneath +1/+1 counters, propagates to subsequent copies (CR 707.2), and expires at EOT', () => {
		const state = createGame(2);
		const [p1] = state.players;
		addMana(p1, 20);

		const shapeshifter = putInZone(
			state,
			p1,
			makeCard({
				name: 'Agile Mimic',
				typeLine: 'Creature — Shapeshifter',
				power: '1',
				toughness: '1',
				oracleText:
					'{1}{U}: Until end of turn, Agile Mimic becomes a copy of target creature, except it\'s 4/4 and has flying.'
			}),
			'battlefield'
		);
		shapeshifter.counters['+1/+1'] = 2;

		const dragon = putInZone(
			state,
			p1,
			makeCard({
				name: 'Ruby Drake',
				manaCost: '{3}{R}',
				cmc: 4,
				typeLine: 'Creature — Dragon',
				colors: ['R'],
				power: '3',
				toughness: '2',
				keywords: ['Haste'],
				oracleText: 'Haste'
			}),
			'battlefield'
		);

		const cloneSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Echoing Twin',
				manaCost: '{2}{U}',
				typeLine: 'Sorcery',
				oracleText: "Create a token that's a copy of target creature you control."
			}),
			'hand'
		);

		assert.equal(compileCard(shapeshifter.card).fullySupported, true);
		const abil = getEffectiveActivatedAbilities(state, p1, shapeshifter)[0];
		assert.ok(abil);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: shapeshifter.instanceId,
				abilityId: abil.id,
				targets: [{ kind: 'permanent', id: dragon.instanceId, label: dragon.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		const shiftedEv = evaluatePermanent(state, shapeshifter);
		assert.equal(shiftedEv.power, 6, 'Layer 1a 4/4 base + two +1/+1 counters in Layer 7c = 6');
		assert.equal(shiftedEv.toughness, 6);
		assert.equal(hasKeyword(shapeshifter, 'Flying', state), true);
		assert.equal(hasKeyword(shapeshifter, 'Haste', state), true);
		assert.equal(shapeshifter.card.name, 'Agile Mimic', 'perm.card must never be mutated');

		// Copy-of-a-copy (CR 707.2): copying shapeshifter copies its Layer 1a 4/4 Flying Haste copiable values, NOT its +1/+1 counters!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cloneSpell.instanceId,
				targets: [{ kind: 'permanent', id: shapeshifter.instanceId, label: shapeshifter.card.name }]
			}).ok,
			true
		);
		resolveStack(state);

		const tokenCopy = p1.battlefield.find((c) => c.isToken)!;
		const tokEv = evaluatePermanent(state, tokenCopy);
		assert.equal(tokEv.power, 4, 'Token copy gets Layer 1a 4/4 copiable P/T without +1/+1 counters');
		assert.equal(tokEv.toughness, 4);
		assert.equal(hasKeyword(tokenCopy, 'Flying', state), true);
		assert.equal(hasKeyword(tokenCopy, 'Haste', state), true);

		// End turn -> shapeshifter reverts to 1/1 (+2/+2 counters = 3/3), while tokenCopy keeps its 4/4 copiable values!
		assert.equal(applyGameAction(state, p1.playerId, { type: 'end_turn' }).ok, true);
		const revertedEv = evaluatePermanent(state, shapeshifter);
		assert.equal(revertedEv.power, 3);
		assert.equal(revertedEv.toughness, 3);
		assert.equal(hasKeyword(shapeshifter, 'Flying', state), false);
		assert.equal(evaluatePermanent(state, tokenCopy).power, 4);
	});
});

describe('Track P7 — Slice P7.3: Edict Sacrifice, Wheel, Random Discard, and Divided Damage / Counters', () => {
	it('executes symmetric edict ("Each player sacrifices a creature of their choice"), per-player Wheel, and random discard', () => {
		const state = createGame(2, [false, true]);
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const p1Crit = putInZone(
			state,
			p1,
			makeCard({ name: 'Alice Critter', typeLine: 'Creature — Beast', power: '2', toughness: '2' }),
			'battlefield'
		);
		const p2Crit = putInZone(
			state,
			p2,
			makeCard({ name: 'Bob Critter', typeLine: 'Creature — Beast', power: '3', toughness: '3' }),
			'battlefield'
		);

		const edict = putInZone(
			state,
			p1,
			makeCard({
				name: 'Symmetric Tribute',
				manaCost: '{B}',
				typeLine: 'Sorcery',
				oracleText: 'Each player sacrifices a creature of their choice.'
			}),
			'hand'
		);
		const windfall = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Winds',
				manaCost: '{1}{U}',
				typeLine: 'Sorcery',
				oracleText: 'Each player discards all the cards in their hand, then draws that many cards.'
			}),
			'hand'
		);
		const randDiscard = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Hymn',
				manaCost: '{B}{B}',
				typeLine: 'Sorcery',
				oracleText: 'Target player discards two cards at random.'
			}),
			'hand'
		);

		assert.equal(compileCard(edict.card).fullySupported, true);
		assert.equal(compileCard(windfall.card).fullySupported, true);
		assert.equal(compileCard(randDiscard.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: edict.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(p1.graveyard.some((c) => c.instanceId === p1Crit.instanceId));
		assert.ok(p2.graveyard.some((c) => c.instanceId === p2Crit.instanceId));

		// Give p1 1 extra card in hand (plus windfall + randDiscard = 3 -> 2 remaining when windfall cast) and p2 4 cards in hand
		putInZone(state, p1, makeCard({ name: 'Extra Hand 1' }), 'hand');
		for (let i = 0; i < 4; i++) {
			putInZone(state, p2, makeCard({ name: `Bob Hand ${i}` }), 'hand');
		}
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: windfall.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, 2, 'Alice discarded 2 cards and drew that many (2)');
		assert.equal(p2.hand.length, 4, 'Bob discarded 4 cards and drew that many (4)');

		// Put randDiscard in Alice's hand and cast on Bob -> discards 2 at random with zero prompts
		const hymn2 = putInZone(state, p1, randDiscard.card, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: hymn2.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p2.hand.length, 2, 'Random discard removed exactly 2 cards without prompting');
	});

	it('validates CR 601.2d targetDivisions and preserves locked shares under CR 608.2b partial target illegality', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 20);
		addMana(p2, 10);

		const c1 = putInZone(
			state,
			p2,
			makeCard({ name: 'Target One', typeLine: 'Creature — Goblin', power: '1', toughness: '3' }),
			'battlefield'
		);
		const c2 = putInZone(
			state,
			p2,
			makeCard({ name: 'Target Two', typeLine: 'Creature — Goblin', power: '1', toughness: '4' }),
			'battlefield'
		);
		const sacOutlet = putInZone(
			state,
			p2,
			makeCard({
				name: 'Instant Altar',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText: 'Sacrifice a creature.'
			}),
			'hand'
		);

		const forkedBolt = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Pyrotechnics',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'Synth Pyrotechnics deals 3 damage divided as you choose among one, two, or three targets.'
			}),
			'hand'
		);
		const distCounters = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Blessings',
				manaCost: '{X}{G}',
				typeLine: 'Sorcery',
				oracleText: 'Distribute X +1/+1 counters among any number of target creatures.'
			}),
			'hand'
		);
		assert.equal(compileCard(forkedBolt.card).fullySupported, true);
		assert.equal(compileCard(distCounters.card).fullySupported, true);

		// Illegal division: 0 assigned to a target (CR 601.2d)
		const zeroShare = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: forkedBolt.instanceId,
			targets: [
				{ kind: 'permanent', id: c1.instanceId, label: c1.card.name },
				{ kind: 'permanent', id: c2.instanceId, label: c2.card.name }
			],
			targetDivisions: { [c1.instanceId]: 3, [c2.instanceId]: 0 }
		});
		assert.equal(zeroShare.ok, false);

		// Legal division: 2 to c1, 1 to c2
		const legalDiv = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: forkedBolt.instanceId,
			targets: [
				{ kind: 'permanent', id: c1.instanceId, label: c1.card.name },
				{ kind: 'permanent', id: c2.instanceId, label: c2.card.name }
			],
			targetDivisions: { [c1.instanceId]: 2, [c2.instanceId]: 1 }
		});
		assert.equal(legalDiv.ok, true, legalDiv.error ?? '');

		// In response, p2 sacrifices c1 so c1 is illegal on resolution; c2 must take ONLY its locked-in 1 damage (CR 608.2b)!
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: sacOutlet.instanceId
			}).ok,
			true
		);
		// Resolve sacOutlet only: pass p2, pass p1 -> prompts p2 to choose creature to sacrifice
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			const pr = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [c1.instanceId] }
				}).ok,
				true
			);
		}
		resolveStack(state);

		assert.ok(p2.graveyard.some((c) => c.instanceId === c1.instanceId));
		assert.equal(c2.damageMarked, 1, 'CR 608.2b: c2 takes its locked 1 damage, never c1\'s 2 damage');

		// Distribute X=0 with 1 target is illegal (CR 601.2d), X=3 on c2 puts 3 +1/+1 counters
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: distCounters.instanceId,
				xValue: 0,
				targets: [{ kind: 'permanent', id: c2.instanceId, label: c2.card.name }]
			}).ok,
			false
		);
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, distCounters, 'hand', 0).ok,
			true,
			'min=0 ("any number") is legal at X=0 when 0 targets are chosen'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: distCounters.instanceId,
				xValue: 3,
				targets: [{ kind: 'permanent', id: c2.instanceId, label: c2.card.name }],
				targetDivisions: { [c2.instanceId]: 3 }
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(c2.counters['+1/+1'], 3);
	});

	it('pumps and grants keywords to every legal target in multi-target pump ("Up to two target creatures each get +2/+2 and gain trample until end of turn")', () => {
		const state = createGame(2);
		const [p1] = state.players;
		addMana(p1, 10);

		const a = putInZone(
			state,
			p1,
			makeCard({ name: 'Bear A', typeLine: 'Creature — Bear', power: '2', toughness: '2', oracleText: '' }),
			'battlefield'
		);
		const b = putInZone(
			state,
			p1,
			makeCard({ name: 'Bear B', typeLine: 'Creature — Bear', power: '3', toughness: '3', oracleText: '' }),
			'battlefield'
		);
		const duoPump = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Tandem',
				manaCost: '{1}{G}',
				typeLine: 'Instant',
				oracleText: 'Up to two target creatures each get +2/+2 and gain trample until end of turn.'
			}),
			'hand'
		);
		assert.equal(compileCard(duoPump.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: duoPump.instanceId,
				targets: [
					{ kind: 'permanent', id: a.instanceId, label: a.card.name },
					{ kind: 'permanent', id: b.instanceId, label: b.card.name }
				]
			}).ok,
			true
		);
		resolveStack(state);

		assert.equal(evaluatePermanent(state, a).power, 4);
		assert.equal(evaluatePermanent(state, a).toughness, 4);
		assert.equal(hasKeyword(a, 'trample', state), true);
		assert.equal(evaluatePermanent(state, b).power, 5);
		assert.equal(evaluatePermanent(state, b).toughness, 5);
		assert.equal(hasKeyword(b, 'trample', state), true);
	});
});

describe('Track P7 — Slice P7.4: Stat-Filtered & Attached Triggers, Morbid/Raid/Revolt/Lifegain, and wasCast', () => {
	it('evaluates trigger ObjectFilter power/manaValue on ETB (with anthems, CR 603.6a), dies LKI (CR 603.10a), and spell cast', () => {
		const state = createGame(2);
		const [p1] = state.players;
		addMana(p1, 20);

		const anthem = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Banner',
				typeLine: 'Artifact',
				oracleText: 'Creatures you control get +2/+2.'
			}),
			'battlefield'
		);
		const packleader = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Packleader',
				typeLine: 'Creature — Beast',
				power: '2',
				toughness: '2',
				oracleText:
					'Whenever another creature you control with power 4 or greater enters, you gain 2 life.\nWhenever a creature you control with power 3 or less dies, you gain 1 life.\nWhenever you cast a spell with mana value 4 or greater, draw a card.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(anthem.card).fullySupported, true);
		assert.equal(compileCard(packleader.card).fullySupported, true);

		// Cast a 2/2 creature with MV 4: enters as 4/4 thanks to anthem -> triggers BOTH MV>=4 cast AND power>=4 ETB!
		const entrant = putInZone(
			state,
			p1,
			makeCard({
				name: 'Banner Squire',
				manaCost: '{3}{G}',
				cmc: 4,
				typeLine: 'Creature — Elf',
				power: '2',
				toughness: '2',
				oracleText: ''
			}),
			'hand'
		);
		const handBeforeCast = p1.hand.length - 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: entrant.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, handBeforeCast + 1, 'MV 4 spell cast trigger drew 1 card');
		assert.equal(p1.life, 42, '2/2 entering under +2/+2 anthem has power 4 and triggers ETB');

		// Give Banner Squire -2/-2 so its LKI power is 2, then destroy it -> triggers power <= 3 dies!
		const shrinkKill = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Wither',
				manaCost: '{1}{B}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets -2/-2 until end of turn. Destroy it.'
			}),
			'hand'
		);
		const onBf = p1.battlefield.find((c) => c.card.name === 'Banner Squire')!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: shrinkKill.instanceId,
				targets: [{ kind: 'permanent', id: onBf.instanceId, label: onBf.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life, 43, 'LKI power was 2 (<= 3), so dies trigger fired');
	});

	it('triggers attached Equipment combat-damage-to-player and Aura opponent-targeting triggers accurately', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 20);
		addMana(p2, 20);

		const wielder = putInZone(
			state,
			p1,
			makeCard({ name: 'Blade Bearer', typeLine: 'Creature — Human', power: '2', toughness: '2' }),
			'battlefield'
		);
		const gloves = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Gloves',
				manaCost: '{2}',
				typeLine: 'Artifact — Equipment',
				oracleText:
					'Whenever equipped creature deals combat damage to a player, draw a card.\nEquip {1}'
			}),
			'battlefield'
		);
		gloves.attachedToId = wielder.instanceId;

		const wardAura = putInZone(
			state,
			p1,
			makeCard({
				name: 'Illusion Cloak',
				manaCost: '{U}',
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nWhenever enchanted creature becomes the target of a spell or ability an opponent controls, sacrifice Illusion Cloak.'
			}),
			'battlefield'
		);
		wardAura.attachedToId = wielder.instanceId;

		assert.equal(compileCard(gloves.card).fullySupported, true);
		assert.equal(compileCard(wardAura.card).fullySupported, true);

		// Self-targeting spell does NOT sacrifice Illusion Cloak
		const myPump = putInZone(
			state,
			p1,
			makeCard({
				name: 'My Boon',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +1/+1 until end of turn.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: myPump.instanceId,
				targets: [{ kind: 'permanent', id: wielder.instanceId, label: wielder.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(p1.battlefield.some((c) => c.instanceId === wardAura.instanceId));

		// Unblocked attack triggers Synth Gloves draw
		const handBefore = p1.hand.length;
		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: wielder.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advanceToPhase(state, 'main2');
		assert.equal(p1.hand.length, handBefore + 1, 'Equipped creature combat damage to player drew a card');

		// Opponent targeting wielder DOES trigger Illusion Cloak sacrifice!
		const oppPing = putInZone(
			state,
			p2,
			makeCard({
				name: 'Opp Poke',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: 'Opp Poke deals 1 damage to target creature.'
			}),
			'hand'
		);
		addMana(p2, 5);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		const pokeRes = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: oppPing.instanceId,
			targets: [{ kind: 'permanent', id: wielder.instanceId, label: wielder.card.name }]
		});
		assert.equal(pokeRes.ok, true, pokeRes.error ?? '');
		resolveStack(state);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === wardAura.instanceId),
			'Opponent targeting enchanted creature triggered sacrifice'
		);
	});

	it('tracks Morbid replacement-if (Tragic Slip), Raid unless (Chart a Course), Revolt, Lifegain, and wasCast', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 30);

		const indestGod = putInZone(
			state,
			p2,
			makeCard({
				name: 'Stone Titan',
				typeLine: 'Creature — Giant',
				power: '5',
				toughness: '5',
				keywords: ['Indestructible'],
				oracleText: 'Indestructible'
			}),
			'battlefield'
		);
		const slip1 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Slip',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText:
					'Target creature gets -1/-1 until end of turn.\nMorbid — That creature gets -13/-13 until end of turn instead if a creature died this turn.'
			}),
			'hand'
		);
		assert.equal(compileCard(slip1.card).fullySupported, true);

		// Before any creature dies: gives -1/-1 -> 4/4
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: slip1.instanceId,
				targets: [{ kind: 'permanent', id: indestGod.instanceId, label: indestGod.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, indestGod).toughness, 4);

		// Sacrifice a fodder creature -> Morbid + Revolt turn on!
		const fodder = putInZone(
			state,
			p1,
			makeCard({
				name: 'Doomed Wisp',
				typeLine: 'Creature — Spirit',
				power: '1',
				toughness: '1',
				oracleText: '{0}, Sacrifice Doomed Wisp: You gain 3 life.'
			}),
			'battlefield'
		);
		const wispAbil = getEffectiveActivatedAbilities(state, p1, fodder)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: fodder.instanceId,
				abilityId: wispAbil.id
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.creatureDiedThisTurn, true);
		assert.equal(p1.permanentLeftBattlefieldThisTurn, true);
		assert.equal(p1.lifeGainedThisTurn, 3);

		// Second Synth Slip now gives -13/-13 instead -> Stone Titan dies to 0-toughness SBA!
		const slip2 = putInZone(state, p1, slip1.card, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: slip2.instanceId,
				targets: [{ kind: 'permanent', id: indestGod.instanceId, label: indestGod.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(p2.graveyard.some((c) => c.instanceId === indestGod.instanceId));

		// wasCast from hand vs reanimate from graveyard
		const sageCard = makeCard({
			name: 'Castborn Sage',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Creature — Wizard',
			power: '2',
			toughness: '2',
			oracleText: 'When Castborn Sage enters, if you cast it from your hand, draw two cards.'
		});
		assert.equal(compileCard(sageCard).fullySupported, true);

		const sageInGy = putInZone(state, p1, sageCard, 'graveyard');
		const zombify = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Reanimate',
				manaCost: '{1}{B}',
				typeLine: 'Sorcery',
				oracleText: 'Return target creature card from your graveyard to the battlefield.'
			}),
			'hand'
		);
		const handBeforeReanim = p1.hand.length - 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: zombify.instanceId,
				targets: [{ kind: 'graveyard_card', id: sageInGy.instanceId, label: sageInGy.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, handBeforeReanim, 'Reanimated creature was NOT cast from hand -> 0 cards drawn');

		const sageInHand = putInZone(state, p1, sageCard, 'hand');
		const handBeforeCast = p1.hand.length - 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sageInHand.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, handBeforeCast + 2, 'Creature cast from hand drew 2 cards');

		// Raid ("Draw two cards. Then discard a card unless you attacked this turn.") after attacking in combat
		const raidSpell = makeCard({
			name: 'Synth Course',
			manaCost: '{1}{U}',
			typeLine: 'Sorcery',
			oracleText: 'Draw two cards. Then discard a card unless you attacked this turn.'
		});
		assert.equal(compileCard(raidSpell).fullySupported, true);

		const raider = p1.battlefield.find((c) => c.card.name === 'Castborn Sage')!;
		raider.summoningSick = false;
		advanceToPhase(state, 'declare_attackers');
		const atkRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: raider.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atkRes.ok, true, atkRes.error ?? '');
		advanceToPhase(state, 'main2');
		addMana(p1, 5);
		const raidInst = putInZone(state, p1, raidSpell, 'hand');
		const preRaidHand = p1.hand.length - 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: raidInst.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, preRaidHand + 2, 'Attacked this turn -> skips discard!');

		// Turn-start reset clears turn-history flags
		runBeginningOfTurn(state);
		assert.equal(state.creatureDiedThisTurn, undefined);
		assert.equal(p1.attackedThisTurn, undefined);
		assert.equal(p1.permanentLeftBattlefieldThisTurn, undefined);
		assert.equal(p1.lifeGainedThisTurn, undefined);
	});

	it('guarantees synthetic rename invariance across all four Track P7 slices (ENGINE_INVARIANTS §1–2)', () => {
		const templates: Array<Omit<Partial<ScryfallCard>, 'name'> & { textTemplate: string }> = [
			{
				typeLine: 'Instant',
				manaCost: '{1}{R}',
				textTemplate:
					"Damage can't be prevented this turn. NAME deals 3 damage to any target. If a creature dealt damage this way would die this turn, exile it instead."
			},
			{
				typeLine: 'Sorcery',
				manaCost: '{2}{U}',
				textTemplate:
					"Create a token that's a copy of target creature, except it's not legendary and it's a 2/2 blue Illusion in addition to its other types."
			},
			{
				typeLine: 'Instant',
				manaCost: '{2}{R}',
				textTemplate: 'NAME deals 4 damage divided as you choose among one, two, or three targets.'
			},
			{
				typeLine: 'Instant',
				manaCost: '{B}',
				textTemplate:
					'Target creature gets -1/-1 until end of turn. That creature gets -13/-13 until end of turn instead if a creature died this turn.'
			}
		];

		for (const tmpl of templates) {
			const cardAlpha = makeCard({
				name: 'Zyxwvut Alpha',
				typeLine: tmpl.typeLine,
				manaCost: tmpl.manaCost,
				oracleText: tmpl.textTemplate.replaceAll('NAME', 'Zyxwvut Alpha')
			});
			const cardOmega = makeCard({
				name: 'Qwertymorph Omega',
				typeLine: tmpl.typeLine,
				manaCost: tmpl.manaCost,
				oracleText: tmpl.textTemplate.replaceAll('NAME', 'Qwertymorph Omega')
			});

			const irAlpha = compileCard(cardAlpha);
			const irOmega = compileCard(cardOmega);
			assert.equal(irAlpha.fullySupported, true);
			assert.equal(irOmega.fullySupported, true);
			const stripSpans = (v: unknown): unknown =>
				JSON.parse(JSON.stringify(v, (k, val) => (k === 'span' ? undefined : val)));
			assert.deepEqual(stripSpans(irAlpha.faces[0].abilities), stripSpans(irOmega.faces[0].abilities));
		}
	});
});
