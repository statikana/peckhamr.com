import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent
} from '../engine.ts';
import { syncBattlefieldControllers } from './zones.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
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
		typeLine: overrides.typeLine ?? 'Instant',
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

function creature(name: string, oracleText = '', power = '2', toughness = '2', subtype = 'Human'): ScryfallCard {
	return card({ name, manaCost: '{2}', cmc: 2, typeLine: `Creature — ${subtype}`, oracleText, power, toughness });
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
		lastHeartbeat: 0
	};
}

function game(players = 2): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i]));
	const state = createInitialGameState(
		'LOBBY_L2',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const s of seats) {
		if (state.status === 'mulligan') assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
	}
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) {
		pl.hand = [];
		pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	return { state, p: state.players };
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp, state);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function cast(state: GameState, player: PlayerGameState, inst: CardInstance, targets: TargetRef[] = []): void {
	const res = applyGameAction(state, player.playerId, { type: 'cast_spell', instanceId: inst.instanceId, targets });
	assert.equal(res.ok, true, res.error ?? '');
}

function pass(state: GameState): void {
	const prio = state.players[state.priorityPlayerIndex];
	assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
}

function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) pass(state);
	assert.equal(state.stack.length, 0);
}

function passUntil(state: GameState, phase: GameState['phase'], activeIdx?: number, max = 160): void {
	for (
		let i = 0;
		i < max && !(state.phase === phase && (activeIdx === undefined || state.activePlayerIndex === activeIdx));
		i++
	) {
		if (state.pendingPrompts.length > 0) assert.fail(`unexpected prompt: ${state.pendingPrompts[0].title}`);
		if (state.phase === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
			const active = state.players[state.activePlayerIndex];
			assert.equal(applyGameAction(state, active.playerId, { type: 'declare_attackers', assignments: [] }).ok, true);
		} else if (state.phase === 'declare_blockers' && !state.combat.blockersDeclared) {
			const defender = state.players.find((pl) => pl.playerId !== state.players[state.activePlayerIndex].playerId && !pl.lost)!;
			assert.equal(applyGameAction(state, defender.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
		} else {
			pass(state);
		}
	}
	assert.equal(state.phase, phase);
	if (activeIdx !== undefined) assert.equal(state.activePlayerIndex, activeIdx);
	for (const pl of state.players) pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
}

const ref = (c: CardInstance): TargetRef => ({ kind: 'permanent', id: c.instanceId, label: c.card.name });

describe('Track E Slice 3: Layer 2 continuous control changes (CR 613.1b, 613.7, 302.6)', () => {
	it('Act of Treason: untaps, grants haste to attack under CR 302.6, denies non-haste stolen attacker, and reverts at cleanup', () => {
		const { state: s0, p } = game(2);
		const hasteTarget = put(s0, p[1], creature('Iron Gargoyle', '', '3', '3', 'Gargoyle'), 'battlefield');
		hasteTarget.tapped = true;
		const slowTarget = put(s0, p[1], creature('Stone Ogre', '', '4', '4', 'Ogre'), 'battlefield');

		const treason = put(
			s0,
			p[0],
			card({
				name: 'Mutiny Spark',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn.'
			}),
			'hand'
		);
		const borrow = put(
			s0,
			p[0],
			card({
				name: 'Brief Command',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Gain control of target creature until end of turn.'
			}),
			'hand'
		);

		cast(s0, p[0], treason, [ref(hasteTarget)]);
		settle(s0);
		cast(s0, p[0], borrow, [ref(slowTarget)]);
		settle(s0);

		const state = roundTrip(s0);
		const p0 = state.players[0];
		const p1 = state.players[1];
		const stolenHaste = p0.battlefield.find((c) => c.instanceId === hasteTarget.instanceId);
		const stolenSlow = p0.battlefield.find((c) => c.instanceId === slowTarget.instanceId);
		assert.ok(stolenHaste, 'haste target moved to p0 battlefield');
		assert.ok(stolenSlow, 'slow target moved to p0 battlefield');
		assert.equal(stolenHaste.tapped, false, 'Act of Treason untapped the creature');
		assert.equal(stolenHaste.summoningSick, true, 'CR 302.6: changing control gives summoning sickness');
		assert.equal(stolenSlow.summoningSick, true);
		assert.equal(evaluatePermanent(state, stolenHaste).controllerId, p0.playerId);
		assert.equal(evaluatePermanent(state, stolenHaste).keywords.includes('Haste'), true);

		passUntil(state, 'declare_attackers', 0);

		// CR 302.6: stolen creature without Haste cannot attack.
		const badAttack = applyGameAction(state, p0.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: stolenSlow.instanceId, defenderPlayerId: p1.playerId, defenderPlaneswalkerId: null }]
		});
		assert.equal(badAttack.ok, false, 'non-haste creature stolen this turn cannot attack');

		// Stolen creature with Haste CAN attack.
		const goodAttack = applyGameAction(state, p0.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: stolenHaste.instanceId, defenderPlayerId: p1.playerId, defenderPlaneswalkerId: null }]
		});
		assert.equal(goodAttack.ok, true, goodAttack.error ?? '');

		// Advance through combat and cleanup to Bob's main1.
		passUntil(state, 'main1', 1);

		const returnedHaste = state.players[1].battlefield.find((c) => c.instanceId === hasteTarget.instanceId);
		const returnedSlow = state.players[1].battlefield.find((c) => c.instanceId === slowTarget.instanceId);
		assert.ok(returnedHaste, 'haste target returned to original controller after cleanup');
		assert.ok(returnedSlow, 'slow target returned to original controller after cleanup');
		assert.equal(returnedHaste.summoningSick, false, 'CR 302.6: cleared once Bob begins his turn controlling it');
		assert.equal(evaluatePermanent(state, returnedHaste).controllerId, state.players[1].playerId);
		assert.equal(state.timedContinuousEffects?.length ?? 0, 0, 'EOT control effects cleaned up');
	});

	it('Control Magic Aura: Layer 2 precedes Layer 4-7 anthems, resists Layer 6 ability removal (CR 613.6), and reverts when destroyed', () => {
		const { state, p } = game(2);
		const bear = put(state, p[1], creature('Valley Bear', '', '2', '2', 'Bear'), 'battlefield');
		put(
			state,
			p[0],
			card({
				name: 'Solar Banner',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control get +1/+1.'
			}),
			'battlefield'
		);
		const controlAura = put(
			state,
			p[0],
			card({
				name: 'Mind Tether',
				manaCost: '{2}{U}{U}',
				cmc: 4,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nYou control enchanted creature.'
			}),
			'hand'
		);

		cast(state, p[0], controlAura, [ref(bear)]);
		settle(state);

		assert.ok(p[0].battlefield.some((c) => c.instanceId === bear.instanceId), 'Bear moved to caster battlefield');
		assert.equal(bear.summoningSick, true);
		let evalBear = evaluatePermanent(state, bear);
		assert.equal(evalBear.controllerId, p[0].playerId);
		assert.equal(evalBear.power, 3, 'CR 613.1b: Layer 2 control resolved before Layer 7c +1/+1 anthem');
		assert.equal(evalBear.toughness, 3);

		// CR 613.6: an ability-stripping effect in Layer 6 (Humility / loses all abilities) on the battlefield
		// cannot undo Layer 2 control change because Layer 2 ran before Layer 6.
		put(
			state,
			p[1],
			card({
				name: 'Total Dampener',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
			}),
			'battlefield'
		);
		evalBear = evaluatePermanent(state, bear);
		assert.equal(evalBear.controllerId, p[0].playerId, 'CR 613.6: Layer 2 control still applies over Layer 6 ability loss');
		assert.equal(evalBear.power, 2, '1/1 base + +1/+1 anthem');
		assert.equal(evalBear.hasLostAllAbilities, true);

		// Destroy the Control Magic Aura -> Bear returns to p[1] and loses p[0]'s anthem.
		const naturalize = put(
			state,
			p[0],
			card({
				name: 'Dispel Bindings',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target enchantment.'
			}),
			'hand'
		);
		cast(state, p[0], naturalize, [ref(controlAura)]);
		settle(state);

		assert.ok(p[1].battlefield.some((c) => c.instanceId === bear.instanceId), 'Bear returned to original controller');
		evalBear = evaluatePermanent(state, bear);
		assert.equal(evalBear.controllerId, p[1].playerId);
		assert.equal(evalBear.power, 1, 'no longer gets p[0] anthem');
	});

	it('CR 506.4: changing control mid-combat removes creature from combat immediately', () => {
		const { state, p } = game(2);
		const attacker = put(state, p[0], creature('Charging Knight', '', '3', '2', 'Knight'), 'battlefield');
		const flashSteal = put(
			state,
			p[1],
			card({
				name: 'Sudden Turncoat',
				manaCost: '{3}{U}',
				cmc: 4,
				typeLine: 'Instant',
				oracleText: 'Gain control of target creature until end of turn.'
			}),
			'hand'
		);

		passUntil(state, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(state, p[0].playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p[1].playerId, defenderPlaneswalkerId: null }]
			}).ok,
			true
		);
		assert.equal(state.combat.attackers.length, 1);

		// p[0] passes priority in declare_attackers so p[1] casts Sudden Turncoat
		pass(state);
		assert.equal(state.players[state.priorityPlayerIndex].playerId, p[1].playerId);
		p[1].manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		cast(state, p[1], flashSteal, [ref(attacker)]);
		settle(state);

		assert.ok(p[1].battlefield.some((c) => c.instanceId === attacker.instanceId), 'defender stole the attacker');
		assert.equal(state.combat.attackers.some((a) => a.attackerInstanceId === attacker.instanceId), false, 'CR 506.4: removed from combat');
		assert.equal(state.combat.attackers.length, 0);
	});

	it('CR 613.7 timestamp stacking: Act of Treason on top of Control Magic reverts to Control Magic controller, then to owner', () => {
		const { state, p } = game(3);
		const bear = put(state, p[0], creature('Contested Bear', '', '2', '2', 'Bear'), 'battlefield');

		// Pass to p[1]'s main1 so p[1] casts Control Magic Aura on Alice's Bear.
		passUntil(state, 'main1', 1);
		const p1Aura = put(
			state,
			p[1],
			card({
				name: 'Mind Tether',
				manaCost: '{2}{U}{U}',
				cmc: 4,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nYou control enchanted creature.'
			}),
			'hand'
		);
		cast(state, p[1], p1Aura, [ref(bear)]);
		settle(state);
		assert.ok(p[1].battlefield.some((c) => c.instanceId === bear.instanceId), 'p[1] controls Bear via Aura (t1)');

		// Pass to p[2]'s main1 so p[2] casts Act of Treason on the Bear (t2 > t1).
		passUntil(state, 'main1', 2);
		const p2Treason = put(
			state,
			p[2],
			card({
				name: 'Mutiny Spark',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn.'
			}),
			'hand'
		);
		cast(state, p[2], p2Treason, [ref(bear)]);
		settle(state);
		assert.ok(p[2].battlefield.some((c) => c.instanceId === bear.instanceId), 'p[2] temporarily controls Bear (t2 > t1)');
		assert.equal(evaluatePermanent(state, bear).controllerId, p[2].playerId);

		// Pass past p[2]'s cleanup back to p[0]'s main1: t2 expires, t1 still applies -> reverts to p[1]!
		passUntil(state, 'main1', 0);
		assert.ok(p[1].battlefield.some((c) => c.instanceId === bear.instanceId), 'reverted to Control Magic controller p[1], not owner p[0]');
		assert.equal(bear.summoningSick, true, 'CR 302.6: returning control to non-active p[1] at cleanup keeps summoning sickness until p[1] untap');
		assert.equal(evaluatePermanent(state, bear).controllerId, p[1].playerId);

		// Now p[0] destroys p[1]'s Aura -> Bear finally reverts to p[0].
		const naturalize = put(
			state,
			p[0],
			card({
				name: 'Dispel Bindings',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target enchantment.'
			}),
			'hand'
		);
		cast(state, p[0], naturalize, [ref(p1Aura)]);
		settle(state);
		assert.ok(p[0].battlefield.some((c) => c.instanceId === bear.instanceId), 'reverted to original owner p[0] once Aura removed');
		assert.equal(evaluatePermanent(state, bear).controllerId, p[0].playerId);
	});

	it('untilSourceLeaves + Phasing (CR 702.26b/d): phasing out suspends control without pruning; leaving reverts permanently', () => {
		const { state: s0, p } = game(2);
		const victim = put(s0, p[1], creature('Highland Elk', '', '3', '3', 'Elk'), 'battlefield');
		const sower = put(
			s0,
			p[0],
			creature(
				'Lure Fae',
				'When Lure Fae enters the battlefield, gain control of target creature for as long as you control Lure Fae.',
				'2',
				'2',
				'Faerie'
			),
			'hand'
		);

		cast(s0, p[0], sower);
		// Resolve the creature spell first so its ETB trigger fires and prompts for target (if multiple legal creatures)
		const spellItem = s0.stack[s0.stack.length - 1];
		for (let i = 0; i < 8 && s0.stack.includes(spellItem) && s0.pendingPrompts.length === 0; i++) pass(s0);
		if (s0.pendingPrompts.length === 1) {
			const pr = s0.pendingPrompts[0];
			assert.equal(
				applyGameAction(s0, p[0].playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [victim.instanceId] }
				}).ok,
				true
			);
		}
		settle(s0);

		const state = roundTrip(s0);
		const p0 = state.players[0];
		const p1 = state.players[1];
		const sowerInst = p0.battlefield.find((c) => c.instanceId === sower.instanceId)!;
		const victimInst = p0.battlefield.find((c) => c.instanceId === victim.instanceId);
		assert.ok(victimInst, 'target controlled by p0 via untilSourceLeaves');
		assert.equal(state.timedContinuousEffects?.length, 1);
		assert.equal(state.timedContinuousEffects?.[0]?.expires, 'untilSourceLeaves');

		// Phasing out Lure Fae makes its continuous effect stop applying while phased out, WITHOUT pruning it.
		sowerInst.phasedOut = true;
		syncBattlefieldControllers(state);
		assert.ok(p1.battlefield.some((c) => c.instanceId === victim.instanceId), 'control temporarily reverted while source phased out');
		assert.equal(state.timedContinuousEffects?.length, 1, 'phased-out source does not delete timedContinuousEffect');

		// Phasing back in restores control!
		sowerInst.phasedOut = false;
		syncBattlefieldControllers(state);
		assert.ok(p0.battlefield.some((c) => c.instanceId === victim.instanceId), 'control restored when source phases back in');

		// Destroying Lure Fae permanently prunes the effect and reverts control.
		const murder = put(
			state,
			p0,
			card({
				name: 'Cut Down',
				manaCost: '{1}{B}{B}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		cast(state, p0, murder, [ref(sowerInst)]);
		settle(state);

		assert.ok(p1.battlefield.some((c) => c.instanceId === victim.instanceId), 'target reverted permanently after source left battlefield');
		assert.equal(state.timedContinuousEffects?.length ?? 0, 0, 'untilSourceLeaves timedContinuousEffect pruned');
	});

	it('CR 800.4a player elimination returns foreign controlled permanents cleanly (respecting remaining Layer 2 effects)', () => {
		const { state, p } = game(3);
		const bear = put(state, p[0], creature('Shared Bear', '', '2', '2', 'Bear'), 'battlefield');

		// Bob steals Alice's Bear with Control Magic Aura; Carol steals it with Act of Treason on top.
		passUntil(state, 'main1', 1);
		const bobAura = put(
			state,
			p[1],
			card({
				name: 'Mind Tether',
				manaCost: '{2}{U}{U}',
				cmc: 4,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nYou control enchanted creature.'
			}),
			'hand'
		);
		cast(state, p[1], bobAura, [ref(bear)]);
		settle(state);
		assert.ok(p[1].battlefield.some((c) => c.instanceId === bear.instanceId));

		passUntil(state, 'main1', 2);
		const carolTreason = put(
			state,
			p[2],
			card({
				name: 'Mutiny Spark',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn.'
			}),
			'hand'
		);
		cast(state, p[2], carolTreason, [ref(bear)]);
		settle(state);
		assert.ok(p[2].battlefield.some((c) => c.instanceId === bear.instanceId));

		// Carol leaves the game while controlling Alice's Bear (with Bob's Aura still active on it).
		assert.equal(applyGameAction(state, p[2].playerId, { type: 'concede' }).ok, true);
		assert.ok(p[1].battlefield.some((c) => c.instanceId === bear.instanceId), 'Bear passes to remaining Layer 2 controller Bob');
		assert.equal(evaluatePermanent(state, bear).controllerId, p[1].playerId);

		// Now Bob leaves the game -> Bob's Aura leaves too -> Bear returns to owner Alice!
		assert.equal(applyGameAction(state, p[1].playerId, { type: 'concede' }).ok, true);
		assert.ok(p[0].battlefield.some((c) => c.instanceId === bear.instanceId), 'Bear returns to Alice once Bob and his Aura leave');
		assert.equal(evaluatePermanent(state, bear).controllerId, p[0].playerId);
	});

	it('synthetic card rename invariance in runtime control resolution', () => {
		const results: Array<{ power: number; controllerIsP0: boolean; returnedToP1: boolean }> = [];
		for (const names of [
			{ aura: 'Psionic Chain', treason: 'Rage Flash' },
			{ aura: 'Gilded Collar', treason: 'Seize Impulse' }
		]) {
			const { state, p } = game(2);
			const bear = put(state, p[1], creature('Timber Cub', '', '2', '2', 'Bear'), 'battlefield');
			const aura = put(
				state,
				p[0],
				card({
					name: names.aura,
					manaCost: '{2}{U}{U}',
					cmc: 4,
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant creature\nYou control enchanted creature.'
				}),
				'hand'
			);
			cast(state, p[0], aura, [ref(bear)]);
			settle(state);
			const evalStolen = evaluatePermanent(state, bear);
			const naturalize = put(
				state,
				p[0],
				card({
					name: 'Unbind',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Instant',
					oracleText: 'Destroy target enchantment.'
				}),
				'hand'
			);
			cast(state, p[0], naturalize, [ref(aura)]);
			settle(state);
			results.push({
				power: evalStolen.power,
				controllerIsP0: evalStolen.controllerId === p[0].playerId,
				returnedToP1: p[1].battlefield.some((c) => c.instanceId === bear.instanceId)
			});
		}
		assert.deepEqual(results[0], results[1]);
		assert.deepEqual(results[0], { power: 2, controllerIsP0: true, returnedToP1: true });
	});
});
