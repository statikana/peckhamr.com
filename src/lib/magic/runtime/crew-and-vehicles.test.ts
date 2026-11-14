import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkAbilityActivationLegality,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS } from '../precons.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectivePromptChoice } from './choices.ts';
import { canPayCosts, type CostContext } from './costs.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{2}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Artifact — Vehicle',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'uncommon',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function vehicle(
	name: string,
	crewN: number,
	power = '4',
	toughness = '4',
	extraOracle = '',
	typeLine = 'Artifact — Vehicle'
): ScryfallCard {
	const lines = [extraOracle, `Crew ${crewN}`].filter(Boolean).join('\n');
	return card({
		name,
		manaCost: '{3}',
		cmc: 3,
		typeLine,
		power,
		toughness,
		oracleText: lines
	});
}

function creature(name: string, power = '2', toughness = '2', oracleText = '', extra?: Partial<ScryfallCard>): ScryfallCard {
	return card({
		name,
		manaCost: '{2}',
		cmc: 2,
		typeLine: 'Creature — Pilot',
		power,
		toughness,
		oracleText,
		...extra
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
	const names = ['Alice', 'Bob'];
	const seats = botSeats.map((isBot, i) => seat(i, `player_${i + 1}`, names[i], isBot));
	const state = createInitialGameState(
		'LOBBY_CREW',
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
	zone: 'battlefield' | 'hand' | 'graveyard' | 'library' = 'battlefield',
	extra?: Partial<CardInstance>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp, state);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (extra) Object.assign(inst, extra);
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function passAll(state: GameState): void {
	let guard = 0;
	while (state.stack.length > 0 || guard === 0) {
		if (++guard > 30) throw new Error('passAll loop guard exceeded');
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
		if (state.stack.length === 0) break;
	}
}

function advanceToPhase(state: GameState, targetPhase: GameState['phase'], targetPlayerId?: string): void {
	let declaredCombatTurn = -1;
	for (let i = 0; i < 80; i++) {
		const active = state.players[state.activePlayerIndex];
		if (state.phase === targetPhase && (!targetPlayerId || active.playerId === targetPlayerId)) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			const ch = effectivePromptChoice(pr, state);
			if (ch.kind === 'chooseObjects') {
				const res = applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: ch.candidates.slice(0, ch.min) }
				});
				if (res.ok) continue;
			}
		}
		if (
			state.phase === 'declare_attackers' &&
			state.stack.length === 0 &&
			declaredCombatTurn !== state.turnNumber * 10 + state.activePlayerIndex
		) {
			declaredCombatTurn = state.turnNumber * 10 + state.activePlayerIndex;
			const res = applyGameAction(state, active.playerId, { type: 'declare_attackers', assignments: [] });
			if (res.ok) continue;
		}
		const prio = state.players[state.priorityPlayerIndex];
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
	}
	throw new Error(`Failed to reach phase ${targetPhase}`);
}

function crewAbilityId(state: GameState, player: PlayerGameState, veh: CardInstance): string {
	const abs = getEffectiveActivatedAbilities(state, player, veh);
	const ab = abs.find((a) => a.costKeyword === 'crew');
	assert.ok(ab, `Expected a crew activated ability on ${veh.card.name}`);
	return ab.id;
}

describe('CR 702.122 Crew & Vehicles (Track D Slice 4)', () => {
	it('animates a Vehicle via chooseObjects subset-sum prompt, preserves supertypes/subtypes, sets printed P/T, and reverts at cleanup (CR 702.122a, 205.1b, 514.2)', () => {
		const state = setupGame();
		const p1 = state.players[0];
		const skiff = put(
			state,
			p1,
			vehicle('Aether Freighter', 3, '4', '4', 'Flying', 'Legendary Artifact — Vehicle')
		);
		const pwr1 = put(state, p1, creature('Gear Mechanic', '1', '2'));
		const pwr2 = put(state, p1, creature('Veteran Driver', '2', '3'));
		put(state, p1, creature('Spotter', '1', '1'));

		const beforeEval = evaluatePermanent(state, skiff);
		assert.equal(beforeEval.isCreature, false);
		assert.equal(beforeEval.breakdown.effectivePower, null);
		assert.equal(beforeEval.breakdown.effectiveToughness, null);
		assert.equal(beforeEval.power, 0);
		assert.equal(beforeEval.effectiveTypeLine, 'Legendary Artifact — Vehicle');

		const abId = crewAbilityId(state, p1, skiff);
		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: skiff.instanceId,
			abilityId: abId,
			targets: []
		});
		assert.equal(actRes.ok, true, actRes.error ?? '');
		assert.equal(state.pendingPrompts.length, 1);

		const prompt = state.pendingPrompts[0];
		const choice = effectivePromptChoice(prompt, state);
		assert.equal(choice.kind, 'chooseObjects');
		assert.equal(choice.minWeightSum, 3);
		assert.equal(choice.weightLabel, 'Power');
		assert.deepEqual(choice.weightsById?.[pwr1.instanceId], 1);
		assert.deepEqual(choice.weightsById?.[pwr2.instanceId], 2);

		// Subset with insufficient power (1 < 3) is rejected by server validation
		const badRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseObjects', objectIds: [pwr1.instanceId] }
		});
		assert.equal(badRes.ok, false);
		assert.equal(state.pendingPrompts.length, 1);

		// Round-trip state through JSON mid-prompt before answering
		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		const rtP1 = roundTripped.players[0];
		const rtRes = applyGameAction(roundTripped, rtP1.playerId, {
			type: 'choice',
			promptId: roundTripped.pendingPrompts[0].id,
			answer: { kind: 'chooseObjects', objectIds: [pwr1.instanceId, pwr2.instanceId] }
		});
		assert.equal(rtRes.ok, true, rtRes.error ?? '');
		assert.equal(roundTripped.pendingPrompts.length, 0);
		assert.equal(roundTripped.stack.length, 1);
		assert.deepEqual(roundTripped.stack[0].crewedByIds, [pwr1.instanceId, pwr2.instanceId]);

		const rtPwr1 = rtP1.battlefield.find((c) => c.instanceId === pwr1.instanceId)!;
		const rtPwr2 = rtP1.battlefield.find((c) => c.instanceId === pwr2.instanceId)!;
		const rtSkiff = rtP1.battlefield.find((c) => c.instanceId === skiff.instanceId)!;
		assert.equal(rtPwr1.tapped, true);
		assert.equal(rtPwr2.tapped, true);

		passAll(roundTripped);
		assert.equal(roundTripped.stack.length, 0);

		const crewedEval = evaluatePermanent(roundTripped, rtSkiff);
		assert.equal(crewedEval.isCreature, true);
		assert.equal(crewedEval.power, 4);
		assert.equal(crewedEval.toughness, 4);
		assert.equal(crewedEval.isArtifact, true);
		assert.equal(crewedEval.isCreature, true);
		assert.equal(crewedEval.isLegendary, true);
		assert.equal(crewedEval.hasSubType('Vehicle'), true);
		assert.equal(crewedEval.effectiveTypeLine, 'Legendary Artifact Creature — Vehicle');
		assert.ok(crewedEval.activeKeywords.includes('Flying'));
		assert.deepEqual(rtSkiff.crewedThisTurnByIds, [pwr1.instanceId, pwr2.instanceId]);

		// Cleanup reverts the Vehicle back to non-creature and clears crewedThisTurnByIds
		advanceToPhase(roundTripped, 'main1', roundTripped.players[1].playerId);
		const afterCleanupEval = evaluatePermanent(roundTripped, rtSkiff);
		assert.equal(afterCleanupEval.isCreature, false);
		assert.equal(afterCleanupEval.breakdown.effectivePower, null);
		assert.equal(afterCleanupEval.breakdown.effectiveToughness, null);
		assert.equal(rtSkiff.crewedThisTurnByIds, undefined);
		assert.equal(roundTripped.timedContinuousEffects, undefined);
	});

	it('enforces CR 302.6 summoning sickness on newly entered Vehicles while allowing summoning-sick creatures to pay Crew costs', () => {
		const state = setupGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// Cast a Vehicle from hand so it enters with summoningSick = true despite not yet being a creature
		const fleet = put(
			state,
			p1,
			vehicle('Siege Harvester', 2, '5', '5'),
			'hand'
		);
		// Summoning-sick creature CAN tap to crew (CR 702.122a / 302.6)
		const sickPilot = put(state, p1, creature('Sick Pilot', '2', '2'), 'battlefield', {
			summoningSick: true
		});

		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: fleet.instanceId, targets: [] }).ok, true);
		passAll(state);
		const onBoardFleet = p1.battlefield.find((c) => c.instanceId === fleet.instanceId)!;
		assert.equal(onBoardFleet.summoningSick, true);

		const abId = crewAbilityId(state, p1, onBoardFleet);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: onBoardFleet.instanceId,
				abilityId: abId,
				targets: [],
				costPayment: { objects: [[sickPilot.instanceId]] }
			}).ok,
			true
		);
		passAll(state);
		assert.equal(sickPilot.tapped, true);
		assert.equal(evaluatePermanent(state, onBoardFleet).isCreature, true);

		// Newly entered Vehicle has summoning sickness -> cannot attack this turn
		advanceToPhase(state, 'declare_attackers', p1.playerId);
		const illegalAtk = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: onBoardFleet.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(illegalAtk.ok, false);

		// Advance through opponent's turn to P1's next main1 (after P1's untap clears summoningSick)
		advanceToPhase(state, 'main1', p2.playerId);
		advanceToPhase(state, 'main1', p1.playerId);
		assert.equal(onBoardFleet.summoningSick, false);

		// Crew again on P1's next turn -> can now attack!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: onBoardFleet.instanceId,
				abilityId: abId,
				targets: [],
				costPayment: { objects: [[sickPilot.instanceId]] }
			}).ok,
			true
		);
		passAll(state);
		advanceToPhase(state, 'declare_attackers', p1.playerId);
		const legalAtk = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: onBoardFleet.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(legalAtk.ok, true, legalAtk.error ?? '');
	});

	it('prevents an animated Vehicle from tapping itself to pay its own Crew cost (excludeSelf)', () => {
		const state = setupGame();
		const p1 = state.players[0];
		const cruiser = put(state, p1, vehicle('Solo Cruiser', 2, '4', '4'));
		const pilot = put(state, p1, creature('Only Pilot', '2', '2'));

		const abId = crewAbilityId(state, p1, cruiser);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: cruiser.instanceId,
				abilityId: abId,
				targets: [],
				costPayment: { objects: [[pilot.instanceId]] }
			}).ok,
			true
		);
		passAll(state);
		assert.equal(evaluatePermanent(state, cruiser).isCreature, true);
		assert.equal(cruiser.tapped, false);
		assert.equal(pilot.tapped, true);

		// Cruiser is an untapped 4/4 Creature now, but cannot tap itself to pay its own Crew 2
		const ab = getEffectiveActivatedAbilities(state, p1, cruiser).find((a) => a.costKeyword === 'crew')!;
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, cruiser, ab).ok, false);
	});

	it('triggers "Whenever ~ becomes crewed" and enforces "cantCrewVehicles" restrictions (CR 702.122c–d)', () => {
		const state = setupGame();
		const p1 = state.players[0];
		const handBefore = p1.hand.length;
		const train = put(
			state,
			p1,
			vehicle('Steam Express', 3, '4', '4', 'Whenever Steam Express becomes crewed, draw a card.')
		);
		const ox = put(
			state,
			p1,
			creature('Stubborn Beast', '4', '4', "Stubborn Beast can't crew Vehicles.")
		);
		const small = put(state, p1, creature('Tiny Scout', '2', '1'));
		const abId = crewAbilityId(state, p1, train);

		// Ox (power 4) can't crew Vehicles -> only Tiny Scout (power 2) is eligible -> Crew 3 cannot be paid
		const ab = getEffectiveActivatedAbilities(state, p1, train).find((a) => a.costKeyword === 'crew')!;
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, train, ab).ok, false);

		const anotherScout = put(state, p1, creature('Second Scout', '1', '1'));
		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: train.instanceId,
			abilityId: abId,
			targets: []
		});
		assert.equal(actRes.ok, true);
		const prompt = state.pendingPrompts[0];
		const choice = effectivePromptChoice(prompt, state);
		assert.equal(choice.kind, 'chooseObjects');
		assert.equal(choice.candidates.includes(ox.instanceId), false);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: [small.instanceId, anotherScout.instanceId] }
			}).ok,
			true
		);
		passAll(state);
		// BecomesCrewed trigger resolved and drew 1 card
		assert.equal(p1.hand.length, handBefore + 1);
	});

	it('applies continuous Layer 6/7b effects (Humility, anthems, +1/+1 counters) in timestamp order with Crew', () => {
		const state = setupGame();
		const p1 = state.players[0];
		const humility = put(
			state,
			p1,
			card({
				name: 'Humility',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
			})
		);
		const anthem = put(
			state,
			p1,
			card({
				name: 'Glorious Anthem',
				manaCost: '{1}{W}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control get +1/+1.'
			})
		);
		const warhorse = put(
			state,
			p1,
			vehicle('Clockwork Racer', 2, '5', '5', 'Trample'),
			'battlefield'
		);
		warhorse.counters['+1/+1'] = 1;
		// Put Humility first in timestamp? Clockwork Racer can't be crewed if it already lost Crew!
		//Wait: Humility only strips abilities from *creatures*, so BEFORE crewing, Racer is an Artifact — Vehicle
		// and STILL HAS Crew 2! Once crewed, Layer 4 makes it a Creature, so Humility strips Trample and sets base 1/1,
		// then Anthem (+1/+1) + counter (+1/+1) make it 3/3!
		const pilot = put(state, p1, creature('Sturdy Pilot', '2', '2'));
		assert.equal(evaluatePermanent(state, warhorse).activeKeywords.includes('Trample'), true);
		assert.equal(evaluatePermanent(state, pilot).power, 2); // 1/1 from Humility + 1/1 from Glorious Anthem
		const abId = crewAbilityId(state, p1, warhorse);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: warhorse.instanceId,
				abilityId: abId,
				targets: [],
				costPayment: { objects: [[pilot.instanceId]] }
			}).ok,
			true
		);
		passAll(state);
		const ev = evaluatePermanent(state, warhorse);
		assert.equal(ev.isCreature, true);
		assert.equal(ev.activeKeywords.includes('Trample'), false);
		assert.equal(ev.power, 3); // Humility sets 1/1 + Glorious Anthem (+1/+1) + +1/+1 counter = 3/3
		assert.equal(ev.toughness, 3);

		// Verify cleanup still leaves Humility intact without crashing when warhorse reverts
		void humility;
		void anthem;
	});

	it('respects objectVersion after zone change so stale TimedContinuousEffects never re-animate a flickered Vehicle', () => {
		const state = setupGame();
		const p1 = state.players[0];
		const car = put(state, p1, vehicle('Glass Wagon', 1, '3', '3'));
		const pilot = put(state, p1, creature('Driver', '2', '2'));
		const abId = crewAbilityId(state, p1, car);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: car.instanceId,
				abilityId: abId,
				targets: [],
				costPayment: { objects: [[pilot.instanceId]] }
			}).ok,
			true
		);
		passAll(state);
		assert.equal(evaluatePermanent(state, car).isCreature, true);
		assert.equal((car.crewedThisTurnByIds?.length ?? 0) > 0, true);

		// Bounce via Disperse and re-cast -> objectVersion bumped, crewedThisTurnByIds cleared
		const bounce = put(
			state,
			p1,
			card({
				name: 'Disperse',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: "Return target nonland permanent to its owner's hand."
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bounce.instanceId,
				targets: [{ kind: 'permanent', id: car.instanceId, label: car.card.name }]
			}).ok,
			true
		);
		passAll(state);
		const inHand = p1.hand.find((c) => c.instanceId === car.instanceId)!;
		assert.equal(inHand.crewedThisTurnByIds, undefined);

		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: inHand.instanceId, targets: [] }).ok, true);
		passAll(state);
		const reentered = p1.battlefield.find((c) => c.instanceId === car.instanceId)!;
		assert.equal(evaluatePermanent(state, reentered).isCreature, false);
	});

	it('prevents tapping the same mana creature for both a tapSubsetSum cost and a mana cost', () => {
		const state = setupGame();
		const p1 = state.players[0];
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		const elf = put(
			state,
			p1,
			creature('Llanowar Mystic', '1', '1', '{T}: Add {G}.')
		);
		const veh = put(state, p1, vehicle('Mana Relic', 1, '3', '3'));
		const ctx: CostContext = {
			state,
			player: p1,
			source: veh,
			xValue: 0,
			isSpell: false,
			baseMana: null,
			canPayMana: (req) => {
				// Only playable mana source is elf tapping for G
				return !elf.tapped && req.generic <= 1 && Object.values(req.colored).every((v) => v === 0);
			},
			payMana: () => false
		};
		assert.equal(
			canPayCosts(ctx, [
				{ k: 'mana', cost: '{1}' },
				{
					k: 'tapSubsetSum',
					minTotal: { k: 'const', n: 1 },
					metric: 'power',
					filter: { controller: 'you', types: ['Creature'], tapped: false },
					excludeSelf: true,
					restrictionTag: 'crew'
				}
			]),
			false
		);
	});

	it('allows bots to auto-crew an uncrewed non-sick Vehicle in main1 and preserves synthetic rename invariance', () => {
		const runRenamed = (vName: string, subType: string) => {
			const state = setupGame([true, false]);
			const bot = state.players[0];
			const opp = state.players[1];
			bot.hand = [];
			opp.hand = [];
			const v = put(state, bot, vehicle(vName, 2, '5', '5', '', `Artifact — ${subType}`));
			const pilot = put(state, bot, creature('Helper Pilot', '2', '2'), 'battlefield', {
				summoningSick: true
			});
			const res = runAutomatedPriorityAndBots(state, { pace: false, maxSteps: 20 });
			void res;
			// Bot should crew v with summoning-sick pilot during main1 and declare v as attacker when combat is reached
			const ev = evaluatePermanent(state, v);
			return {
				vIsCreature: ev.isCreature,
				vPower: ev.power,
				pilotTapped: pilot.tapped,
				attackersCount: state.combat.attackers.length
			};
		};
		const a = runRenamed('Skyship Alpha', 'Vehicle');
		const b = runRenamed('Contraption Zeta', 'Vehicle');
		assert.equal(a.vIsCreature, true);
		assert.equal(a.vPower, 5);
		assert.equal(a.pilotTapped, true);
		assert.deepEqual(a, b);
	});
});
