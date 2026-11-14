import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getCastOptions,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';
import {
	beginAbilityTargeting,
	beginDropTargeting,
	beginModalTargeting,
	beginSpellTargeting,
	canConfirmCurrentSlot,
	canSkipOptionalSlot,
	computeMaxAffordableX,
	confirmCurrentSlot,
	describeCurrentTargetSlot,
	getPendingTargetArrowRefs,
	isCandidateLegalForCurrentSlot,
	requiredZoneDrawerForCurrentSlot,
	stepBackToPreviousSlot,
	toggleOrAdvanceTarget
} from './targetingController.ts';

function synthCard(overrides: Partial<ScryfallCard> & Pick<ScryfallCard, 'name' | 'typeLine'>): ScryfallCard {
	const id = `synth_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
		oracleId: id,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{G}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine,
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['G'],
		colorIdentity: overrides.colorIdentity ?? ['G'],
		keywords: overrides.keywords ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: false,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		faces: overrides.faces,
		backFace: overrides.backFace,
		layout: overrides.layout
	};
}

function makeTestMatch(): {
	state: GameState;
	p1Id: string;
	p2Id: string;
} {
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `player_${i + 1}`,
		username: `Player ${i + 1}`,
		avatarUrl: '',
		isBot: false,
		deckId: PRECON_DECKS[i].id,
		deckName: PRECON_DECKS[i].name,
		commanderNames: PRECON_DECKS[i].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: [...PRECON_DECKS[i].colorIdentity],
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: Date.now()
	}));
	const decks = new Map<number, MagicDeck>([
		[0, PRECON_DECKS[0]],
		[1, PRECON_DECKS[1]]
	]);
	const state = createInitialGameState('U2_TARGETING_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES
	});
	state.status = 'active';
	state.turnNumber = 2;
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.pendingPrompts = [];
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.command = [];
		p.library = [];
		p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	return {
		state,
		p1Id: state.players[0].playerId,
		p2Id: state.players[1].playerId
	};
}

function addPermanent(
	state: GameState,
	playerIndex: number,
	card: ScryfallCard
): { inst: CardInstance; ref: TargetRef } {
	const player = state.players[playerIndex];
	const inst = createCardInstance(card, player.playerId, 'battlefield');
	inst.summoningSick = false;
	player.battlefield.push(inst);
	return {
		inst,
		ref: { kind: 'permanent', id: inst.instanceId, label: card.name }
	};
}

describe('targetingController — Multi-slot sequential targeting state machine', () => {
	it('handles 2-slot asymmetric fight spell sequentially, preserves slot 1 arrow, and submits [ownId, oppId]', () => {
		const { state, p1Id, p2Id } = makeTestMatch();
		const ownCreature = addPermanent(
			state,
			0,
			synthCard({
				name: 'Mossback Vanguard',
				typeLine: 'Creature — Beast',
				power: '4',
				toughness: '4'
			})
		);
		const oppCreature = addPermanent(
			state,
			1,
			synthCard({
				name: 'Cinder Ridge Stalker',
				typeLine: 'Creature — Wolf',
				manaCost: '{1}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				power: '3',
				toughness: '3'
			})
		);

		const fightSpellCard = synthCard({
			name: 'Glimmerfen Brawl',
			manaCost: '{1}{G}',
			typeLine: 'Sorcery',
			oracleText: "Target creature you control fights target creature you don't control."
		});
		assert.equal(compileCard(fightSpellCard).fullySupported, true);

		const spellInst = createCardInstance(fightSpellCard, p1Id, 'hand');
		state.players[0].hand.push(spellInst);
		const [castOpt] = getCastOptions(state, p1Id, spellInst, 'hand');
		assert.ok(castOpt, 'Expected fight spell to have a legal cast option');

		const start = beginSpellTargeting({
			inst: spellInst,
			fromZone: 'hand',
			option: castOpt
		});
		assert.equal(start.status, 'targeting');
		const slot1 = start.session;
		assert.equal(slot1.totalSlots, 2);
		assert.equal(slot1.slotIndex, 0);
		assert.equal(slot1.remainingSpecs.length, 1);
		assert.match(describeCurrentTargetSlot(slot1), /you control/i);

		// Slot 1 accepts own creature and rejects opponent creature
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, slot1, ownCreature.ref), true);
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, slot1, oppCreature.ref), false);
		const badPick = toggleOrAdvanceTarget(state, p1Id, slot1, oppCreature.ref);
		assert.equal(badPick.status, 'invalid');

		// Advancing to slot 2 locks ownCreature into accumulatedTargets & arrow descriptors
		const adv = toggleOrAdvanceTarget(state, p1Id, slot1, ownCreature.ref);
		assert.equal(adv.status, 'targeting');
		const slot2 = adv.session;
		assert.equal(slot2.slotIndex, 1);
		assert.equal(slot2.remainingSpecs.length, 0);
		assert.deepEqual(
			slot2.accumulatedTargets.map((t) => t.id),
			[ownCreature.inst.instanceId]
		);
		assert.deepEqual(slot2.selectedTargets, []);

		const arrowsDuringSlot2 = getPendingTargetArrowRefs(slot2);
		assert.equal(arrowsDuringSlot2.length, 1);
		assert.equal(arrowsDuringSlot2[0].id, ownCreature.inst.instanceId);
		assert.equal(arrowsDuringSlot2[0].locked, true);
		assert.equal(arrowsDuringSlot2[0].slotIndex, 0);
		assert.equal(arrowsDuringSlot2[0].slotNumber, 1);

		// Slot 2 rejects own creature and accepts opponent creature
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, slot2, ownCreature.ref), false);
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, slot2, oppCreature.ref), true);
		const badOwnPick = toggleOrAdvanceTarget(state, p1Id, slot2, ownCreature.ref);
		assert.equal(badOwnPick.status, 'invalid');

		const finalRes = toggleOrAdvanceTarget(state, p1Id, slot2, oppCreature.ref);
		assert.equal(finalRes.status, 'ready_to_submit');
		assert.equal(finalRes.payload.type, 'cast_spell');
		assert.deepEqual(
			finalRes.payload.targets?.map((t) => t.id),
			[ownCreature.inst.instanceId, oppCreature.inst.instanceId]
		);

		// Verify engine accepts the generated payload cleanly
		const engineRes = applyGameAction(state, p1Id, finalRes.payload);
		assert.equal(engineRes.ok, true, engineRes.error ?? '');
		assert.equal(state.stack.length, 1);
		assert.deepEqual(
			state.stack[0].targets.map((t) => t.id),
			[ownCreature.inst.instanceId, oppCreature.inst.instanceId]
		);
		void p2Id;
	});

	it('enforces CR 115.3 otherTarget ("another target") across slots', () => {
		const { state, p1Id } = makeTestMatch();
		const creatureA = addPermanent(
			state,
			0,
			synthCard({
				name: 'Sunspire Sentinel',
				typeLine: 'Creature — Soldier',
				power: '2',
				toughness: '2'
			})
		);
		const creatureB = addPermanent(
			state,
			1,
			synthCard({
				name: 'Duskwatch Raider',
				typeLine: 'Creature — Rogue',
				power: '2',
				toughness: '2'
			})
		);

		const fightOtherSpell = synthCard({
			name: 'Twinbind Clash',
			manaCost: '{1}{G}',
			colors: ['G'],
			colorIdentity: ['G'],
			typeLine: 'Instant',
			oracleText: 'Target creature fights another target creature.'
		});
		assert.equal(compileCard(fightOtherSpell).fullySupported, true);

		const spellInst = createCardInstance(fightOtherSpell, p1Id, 'hand');
		state.players[0].hand.push(spellInst);
		const [castOpt] = getCastOptions(state, p1Id, spellInst, 'hand');
		assert.ok(castOpt);

		const start = beginSpellTargeting({ inst: spellInst, fromZone: 'hand', option: castOpt });
		assert.equal(start.status, 'targeting');
		assert.equal(start.session.totalSlots, 2);
		assert.equal(start.session.allSpecs[1].otherTarget, true);

		// Pick creatureA in slot 1
		const afterFirst = toggleOrAdvanceTarget(state, p1Id, start.session, creatureA.ref);
		assert.equal(afterFirst.status, 'targeting');
		const slot2 = afterFirst.session;
		assert.equal(slot2.currentSpec.otherTarget, true);
		assert.match(describeCurrentTargetSlot(slot2), /another/i);

		// Slot 2 MUST reject creatureA in both candidate legality and toggleOrAdvanceTarget
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, slot2, creatureA.ref), false);
		const dupAttempt = toggleOrAdvanceTarget(state, p1Id, slot2, creatureA.ref);
		assert.equal(dupAttempt.status, 'invalid');

		// Slot 2 accepts creatureB
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, slot2, creatureB.ref), true);
		const done = toggleOrAdvanceTarget(state, p1Id, slot2, creatureB.ref);
		assert.equal(done.status, 'ready_to_submit');
		assert.equal(done.payload.type, 'cast_spell');
		assert.deepEqual(
			done.payload.targets?.map((t) => t.id),
			[creatureA.inst.instanceId, creatureB.inst.instanceId]
		);

		const engineRes = applyGameAction(state, p1Id, done.payload);
		assert.equal(engineRes.ok, true, engineRes.error ?? '');
	});

	it('supports "up to one target creature" standalone (skip with 0 targets OR pick 1 target)', () => {
		const { state, p1Id } = makeTestMatch();
		const creature = addPermanent(
			state,
			0,
			synthCard({
				name: 'Silverleaf Scout',
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1'
			})
		);

		const upToOneSpell = synthCard({
			name: 'Verdant Blessing',
			manaCost: '{G}',
			typeLine: 'Instant',
			oracleText: 'Put a +1/+1 counter on up to one target creature.'
		});
		assert.equal(compileCard(upToOneSpell).fullySupported, true);

		const spellInst = createCardInstance(upToOneSpell, p1Id, 'hand');
		state.players[0].hand.push(spellInst);
		const [castOpt] = getCastOptions(state, p1Id, spellInst, 'hand');
		assert.ok(castOpt);

		const start = beginSpellTargeting({ inst: spellInst, fromZone: 'hand', option: castOpt });
		assert.equal(start.status, 'targeting');
		assert.equal(start.session.currentRequirement.minTargets, 0);
		assert.equal(start.session.currentRequirement.maxTargets, 1);
		assert.equal(canConfirmCurrentSlot(start.session), true);
		assert.equal(canSkipOptionalSlot(start.session), true);

		// Path A: Skip optional target (0 targets) -> ready_to_submit with []
		const skipped = confirmCurrentSlot(start.session);
		assert.equal(skipped.status, 'ready_to_submit');
		assert.equal(skipped.payload.type, 'cast_spell');
		assert.deepEqual(skipped.payload.targets, []);

		// Path B: Pick 1 target -> ready_to_submit with [creature]
		const picked = toggleOrAdvanceTarget(state, p1Id, start.session, creature.ref);
		assert.equal(picked.status, 'ready_to_submit');
		assert.equal(picked.payload.type, 'cast_spell');
		assert.deepEqual(picked.payload.targets, [creature.ref]);
	});

	it('advances cleanly from an optional "up to" slot 1 (skipped with 0 targets) to a mandatory slot 2', () => {
		const { state, p1Id, p2Id } = makeTestMatch();
		addPermanent(
			state,
			0,
			synthCard({
				name: 'Brightmeadow Stag',
				typeLine: 'Creature — Elk',
				power: '2',
				toughness: '3'
			})
		);

		const modalTwoModes = synthCard({
			name: 'Dualpulse Command',
			manaCost: '{2}{R}{W}',
			colors: ['R', 'W'],
			colorIdentity: ['R', 'W'],
			typeLine: 'Instant',
			oracleText:
				'Choose two —\n• Put a +1/+1 counter on up to one target creature.\n• Dualpulse Command deals 3 damage to target player.'
		});
		const compiled = compileCard(modalTwoModes);
		assert.equal(compiled.fullySupported, true);
		const modal = compiled.faces[0].abilities.find((a) => a.kind === 'spell')?.modal;
		assert.ok(modal);

		const spellInst = createCardInstance(modalTwoModes, p1Id, 'hand');
		state.players[0].hand.push(spellInst);
		const [castOpt] = getCastOptions(state, p1Id, spellInst, 'hand');
		assert.ok(castOpt);

		const modalStart = beginModalTargeting({
			kind: 'spell',
			inst: spellInst,
			modal,
			chosenModes: [0, 1],
			fromZone: 'hand',
			option: castOpt
		});
		assert.equal(modalStart.status, 'targeting');
		const slot1 = modalStart.session;
		assert.equal(slot1.totalSlots, 2);
		assert.equal(slot1.slotIndex, 0);
		assert.equal(slot1.currentRequirement.minTargets, 0);
		assert.equal(slot1.currentRequirement.maxTargets, 1);
		assert.equal(canSkipOptionalSlot(slot1), true);

		// Skip slot 1 with 0 targets -> MUST advance to slot 2 instead of submitting prematurely!
		const afterSkip = confirmCurrentSlot(slot1);
		assert.equal(afterSkip.status, 'targeting');
		const slot2 = afterSkip.session;
		assert.equal(slot2.slotIndex, 1);
		assert.deepEqual(slot2.accumulatedTargets, []);
		assert.equal(slot2.currentRequirement.targetKind, 'player');
		assert.equal(slot2.currentRequirement.minTargets, 1);
		assert.equal(canConfirmCurrentSlot(slot2), false);

		// Verify stepBackToPreviousSlot rewinds cleanly to slot 1
		const rewound = stepBackToPreviousSlot(slot2);
		assert.equal(rewound.slotIndex, 0);
		assert.equal(rewound.remainingSpecs.length, 1);

		// Complete slot 2 with opponent player target
		const oppPlayerRef: TargetRef = { kind: 'player', id: p2Id, label: 'Player 2' };
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, slot2, oppPlayerRef), true);
		const submitted = toggleOrAdvanceTarget(state, p1Id, slot2, oppPlayerRef);
		assert.equal(submitted.status, 'ready_to_submit');
		assert.equal(submitted.payload.type, 'cast_spell');
		assert.deepEqual(submitted.payload.modes, [0, 1]);
		assert.deepEqual(submitted.payload.targets, [oppPlayerRef]);

		const engineRes = applyGameAction(state, p1Id, submitted.payload);
		assert.equal(engineRes.ok, true, engineRes.error ?? '');
	});

	it('handles activated ability with 2 target slots and tracks both slots in arrows', () => {
		const { state, p1Id, p2Id } = makeTestMatch();
		const ownArtifact = addPermanent(
			state,
			0,
			synthCard({
				name: 'Brass Chronometer',
				manaCost: '{2}',
				colors: [],
				colorIdentity: [],
				typeLine: 'Artifact'
			})
		);
		const oppCreature = addPermanent(
			state,
			1,
			synthCard({
				name: 'Ironclaw Brute',
				manaCost: '{2}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				typeLine: 'Creature — Orc',
				power: '3',
				toughness: '2'
			})
		);
		const rigPerm = addPermanent(
			state,
			0,
			synthCard({
				name: 'Arcwire Manipulator',
				manaCost: '{3}',
				colors: [],
				colorIdentity: [],
				typeLine: 'Artifact',
				oracleText:
					'{T}: Tap target artifact you control. Tap target creature an opponent controls.'
			})
		);

		const abilities = getEffectiveActivatedAbilities(state, state.players[0], rigPerm.inst);
		assert.equal(abilities.length, 1);

		const start = beginAbilityTargeting({ inst: rigPerm.inst, ability: abilities[0] });
		assert.equal(start.status, 'targeting');
		assert.equal(start.session.mode, 'ability');
		assert.equal(start.session.totalSlots, 2);

		// Slot 1: target artifact you control (rigPerm itself and ownArtifact are legal; oppCreature is not)
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, start.session, ownArtifact.ref), true);
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, start.session, oppCreature.ref), false);

		const toSlot2 = toggleOrAdvanceTarget(state, p1Id, start.session, ownArtifact.ref);
		assert.equal(toSlot2.status, 'targeting');
		assert.equal(toSlot2.session.slotIndex, 1);

		// Slot 2: target creature an opponent controls
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, toSlot2.session, ownArtifact.ref), false);
		assert.equal(isCandidateLegalForCurrentSlot(state, p1Id, toSlot2.session, oppCreature.ref), true);

		const arrows = getPendingTargetArrowRefs(toSlot2.session);
		assert.equal(arrows.length, 1);
		assert.equal(arrows[0].id, ownArtifact.inst.instanceId);
		assert.equal(arrows[0].locked, true);

		const done = toggleOrAdvanceTarget(state, p1Id, toSlot2.session, oppCreature.ref);
		assert.equal(done.status, 'ready_to_submit');
		assert.equal(done.payload.type, 'activate_ability');
		assert.equal(done.payload.abilityId, abilities[0].id);
		assert.deepEqual(
			done.payload.targets?.map((t) => t.id),
			[ownArtifact.inst.instanceId, oppCreature.inst.instanceId]
		);

		const engineRes = applyGameAction(state, p1Id, done.payload);
		assert.equal(engineRes.ok, true, engineRes.error ?? '');
		void p2Id;
	});

	it('detects requiredZoneDrawerForCurrentSlot for both graveyard_card and exile_card slots', () => {
		const { state, p1Id, p2Id } = makeTestMatch();

		const deadCreature = createCardInstance(
			synthCard({
				name: 'Fallen Ranger',
				typeLine: 'Creature — Scout',
				power: '2',
				toughness: '1'
			}),
			p1Id,
			'graveyard'
		);
		state.players[0].graveyard.push(deadCreature);

		const oppExiledCard = createCardInstance(
			synthCard({
				name: 'Banished Relic',
				typeLine: 'Artifact',
				manaCost: '{2}',
				colors: [],
				colorIdentity: []
			}),
			p2Id,
			'exile'
		);
		state.players[1].exile.push(oppExiledCard);

		// 1. Own graveyard target -> { playerId: p1Id, zone: 'graveyard' }
		const raiseSpell = synthCard({
			name: 'Cryptcall Revival',
			manaCost: '{1}{B}',
			colors: ['B'],
			colorIdentity: ['B'],
			typeLine: 'Sorcery',
			oracleText: 'Return target creature card from your graveyard to your hand.'
		});
		const raiseInst = createCardInstance(raiseSpell, p1Id, 'hand');
		state.players[0].hand.push(raiseInst);
		const [raiseOpt] = getCastOptions(state, p1Id, raiseInst, 'hand');
		const gyStart = beginSpellTargeting({ inst: raiseInst, fromZone: 'hand', option: raiseOpt });
		assert.equal(gyStart.status, 'targeting');
		assert.deepEqual(requiredZoneDrawerForCurrentSlot(gyStart.session, p1Id), {
			playerId: p1Id,
			zone: 'graveyard'
		});

		// 2. Any graveyard target -> { playerId: 'all', zone: 'graveyard' }
		const anyGySpell = synthCard({
			name: 'Void Crypt Purge',
			manaCost: '{B}',
			colors: ['B'],
			colorIdentity: ['B'],
			typeLine: 'Instant',
			oracleText: 'Exile target card from a graveyard.'
		});
		const anyGyInst = createCardInstance(anyGySpell, p1Id, 'hand');
		state.players[0].hand.push(anyGyInst);
		const [anyGyOpt] = getCastOptions(state, p1Id, anyGyInst, 'hand');
		const anyGyStart = beginSpellTargeting({ inst: anyGyInst, fromZone: 'hand', option: anyGyOpt });
		assert.equal(anyGyStart.status, 'targeting');
		assert.deepEqual(requiredZoneDrawerForCurrentSlot(anyGyStart.session, p1Id), {
			playerId: 'all',
			zone: 'graveyard'
		});

		// 3. Exile card target -> { playerId, zone: 'exile' }
		const exileSession = {
			...anyGyStart.session,
			currentSpec: {
				kind: 'object' as const,
				filter: { zone: 'exile' as const, owner: 'opponent' as const },
				min: 1,
				max: 1
			},
			currentRequirement: {
				requiresTarget: true,
				targetKind: 'exile_card',
				minTargets: 1,
				maxTargets: 1,
				zone: 'exile' as const,
				sameGraveyard: false,
				controllerFilter: 'opponent' as const
			}
		};
		assert.deepEqual(requiredZoneDrawerForCurrentSlot(exileSession, p1Id), {
			playerId: 'opponent',
			zone: 'exile'
		});
		assert.deepEqual(requiredZoneDrawerForCurrentSlot(exileSession, p1Id, state), {
			playerId: p2Id,
			zone: 'exile'
		});

		const ownExileSession = {
			...exileSession,
			currentRequirement: {
				...exileSession.currentRequirement,
				controllerFilter: 'you' as const
			}
		};
		assert.deepEqual(requiredZoneDrawerForCurrentSlot(ownExileSession, p1Id), {
			playerId: p1Id,
			zone: 'exile'
		});
	});

	it('supports beginDropTargeting on multi-slot spells and computeMaxAffordableX for X spells', () => {
		const { state, p1Id } = makeTestMatch();
		state.players[0].manaPool = { W: 0, U: 0, B: 0, R: 2, G: 3, C: 0 };

		const ownCreature = addPermanent(
			state,
			0,
			synthCard({
				name: 'Timberwatch Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			})
		);
		const oppCreature = addPermanent(
			state,
			1,
			synthCard({
				name: 'Ashpeak Goblin',
				typeLine: 'Creature — Goblin',
				power: '1',
				toughness: '1'
			})
		);

		const fightSpell = synthCard({
			name: 'Canopy Clash',
			manaCost: '{1}{G}',
			typeLine: 'Instant',
			oracleText: "Target creature you control fights target creature you don't control."
		});
		const fightInst = createCardInstance(fightSpell, p1Id, 'hand');
		state.players[0].hand.push(fightInst);

		// Dropping on opponent creature first fails because slot 1 requires own creature
		const badDrop = beginDropTargeting(state, p1Id, fightInst, 'hand', oppCreature.ref);
		assert.equal(badDrop.status, 'invalid');

		// Dropping on own creature locks slot 1 and advances to slot 2!
		const goodDrop = beginDropTargeting(state, p1Id, fightInst, 'hand', ownCreature.ref);
		assert.equal(goodDrop.status, 'targeting');
		assert.equal(goodDrop.session.slotIndex, 1);
		assert.deepEqual(goodDrop.session.accumulatedTargets, [ownCreature.ref]);

		// X-cost affordability: player has 5 total mana ({R}{R}{G}{G}{G}), spell costs {X}{R} -> max X = 4
		const xSpell = synthCard({
			name: 'Starfire Volley',
			manaCost: '{X}{R}',
			cmc: 1,
			colors: ['R'],
			colorIdentity: ['R'],
			typeLine: 'Sorcery',
			oracleText: 'Starfire Volley deals X damage to any target.'
		});
		const xInst = createCardInstance(xSpell, p1Id, 'hand');
		state.players[0].hand.push(xInst);
		const [xOpt] = getCastOptions(state, p1Id, xInst, 'hand');
		assert.ok(xOpt);
		const maxX = computeMaxAffordableX({
			gameState: state,
			actorId: p1Id,
			inst: xInst,
			fromZone: 'hand',
			castOption: xOpt
		});
		assert.equal(maxX, 4);
	});

	it('expands all modes automatically when a chooseAllModes optional cost is paid', () => {
		const { state, p1Id, p2Id } = makeTestMatch();
		const oppCreature = addPermanent(
			state,
			1,
			synthCard({
				name: 'Frostpeak Yeti',
				typeLine: 'Creature — Yeti',
				power: '3',
				toughness: '3'
			})
		);

		const entwineCard = synthCard({
			name: 'Convergence Decree',
			manaCost: '{1}{R}',
			colors: ['R'],
			colorIdentity: ['R'],
			typeLine: 'Instant',
			oracleText:
				'Choose one —\n• Convergence Decree deals 2 damage to target creature.\n• Convergence Decree deals 2 damage to target player.\nEntwine {2}'
		});
		assert.equal(compileCard(entwineCard).fullySupported, true);

		const spellInst = createCardInstance(entwineCard, p1Id, 'hand');
		state.players[0].hand.push(spellInst);
		const [castOpt] = getCastOptions(state, p1Id, spellInst, 'hand');
		const allModesCost = castOpt.optionalAdditionalCosts?.find((oc) => oc.chooseAllModes);
		assert.ok(allModesCost);

		// Without chooseAllModes paid -> asks for mode picker
		const unpaidStart = beginSpellTargeting({
			inst: spellInst,
			fromZone: 'hand',
			option: castOpt
		});
		assert.equal(unpaidStart.status, 'needs_mode_picker');

		// With chooseAllModes paid -> bypasses mode picker and creates 2 sequential target slots!
		const paidCounts = { [allModesCost.id]: 1 };
		const paidStart = beginSpellTargeting({
			inst: spellInst,
			fromZone: 'hand',
			option: castOpt,
			optionalCostCounts: paidCounts
		});
		assert.equal(paidStart.status, 'targeting');
		assert.equal(paidStart.session.totalSlots, 2);
		assert.deepEqual(paidStart.session.modes, [0, 1]);

		const afterCreature = toggleOrAdvanceTarget(state, p1Id, paidStart.session, oppCreature.ref);
		assert.equal(afterCreature.status, 'targeting');
		assert.equal(afterCreature.session.slotIndex, 1);

		const oppPlayerRef: TargetRef = { kind: 'player', id: p2Id, label: 'Player 2' };
		const done = toggleOrAdvanceTarget(state, p1Id, afterCreature.session, oppPlayerRef);
		assert.equal(done.status, 'ready_to_submit');
		assert.equal(done.payload.type, 'cast_spell');
		assert.deepEqual(done.payload.modes, [0, 1]);
		assert.deepEqual(done.payload.targets, [oppCreature.ref, oppPlayerRef]);

		const engineRes = applyGameAction(state, p1Id, done.payload);
		assert.equal(engineRes.ok, true, engineRes.error ?? '');
	});

	it('supports multi-target toggling within a single slot and mixed locked/unlocked arrows', () => {
		const { state, p1Id, p2Id } = makeTestMatch();
		const c1 = addPermanent(
			state,
			0,
			synthCard({ name: 'Meadow Sprite', typeLine: 'Creature — Faerie', power: '1', toughness: '1' })
		);
		const c2 = addPermanent(
			state,
			1,
			synthCard({ name: 'Bog Strider', typeLine: 'Creature — Frog', power: '2', toughness: '2' })
		);

		const multiModal = synthCard({
			name: 'Frostwind Chorus',
			manaCost: '{2}{U}',
			colors: ['U'],
			colorIdentity: ['U'],
			typeLine: 'Instant',
			oracleText:
				'Choose two —\n• Tap target player.\n• Tap up to two target creatures.'
		});
		// Build a 2-slot modal spell: mode 0 targets player, mode 1 targets up to two creatures
		const cleanModal = synthCard({
			name: 'Tidecall Command',
			manaCost: '{2}{U}',
			colors: ['U'],
			colorIdentity: ['U'],
			typeLine: 'Instant',
			oracleText:
				'Choose two —\n• Tidecall Command deals 1 damage to target player.\n• Tap up to two target creatures.'
		});
		void multiModal;
		const compiled = compileCard(cleanModal);
		assert.equal(compiled.fullySupported, true);
		const modal = compiled.faces[0].abilities.find((a) => a.kind === 'spell')?.modal;
		assert.ok(modal);

		const spellInst = createCardInstance(cleanModal, p1Id, 'hand');
		state.players[0].hand.push(spellInst);
		const [castOpt] = getCastOptions(state, p1Id, spellInst, 'hand');

		const start = beginModalTargeting({
			kind: 'spell',
			inst: spellInst,
			modal,
			chosenModes: [0, 1],
			fromZone: 'hand',
			option: castOpt
		});
		assert.equal(start.status, 'targeting');

		const p2Ref: TargetRef = { kind: 'player', id: p2Id, label: 'Player 2' };
		const slot2Res = toggleOrAdvanceTarget(state, p1Id, start.session, p2Ref);
		assert.equal(slot2Res.status, 'targeting');

		// Pick c1 (1 of up to 2): stays in slot 2 with 1 locked arrow (p2) + 1 unlocked arrow (c1)
		const pickedOne = toggleOrAdvanceTarget(state, p1Id, slot2Res.session, c1.ref);
		assert.equal(pickedOne.status, 'targeting');
		const arrows = getPendingTargetArrowRefs(pickedOne.session);
		assert.equal(arrows.length, 2);
		assert.deepEqual(
			arrows.map((a) => ({ id: a.id, locked: a.locked, slotNumber: a.slotNumber })),
			[
				{ id: p2Id, locked: true, slotNumber: 1 },
				{ id: c1.inst.instanceId, locked: false, slotNumber: 2 }
			]
		);

		// Clicking c1 again toggles it OFF
		const toggledOff = toggleOrAdvanceTarget(state, p1Id, pickedOne.session, c1.ref);
		assert.equal(toggledOff.status, 'targeting');
		assert.deepEqual(toggledOff.session.selectedTargets, []);

		// Re-pick c1 and confirm early with 1 of 2 targets
		const rePicked = toggleOrAdvanceTarget(state, p1Id, toggledOff.session, c1.ref);
		assert.equal(rePicked.status, 'targeting');
		const confirmedEarly = confirmCurrentSlot(rePicked.session);
		assert.equal(confirmedEarly.status, 'ready_to_submit');
		assert.equal(confirmedEarly.payload.type, 'cast_spell');
		assert.deepEqual(confirmedEarly.payload.targets, [p2Ref, c1.ref]);

		// Or picking both c1 and c2 auto-submits when maxTargets (2) is reached
		const bothPicked = toggleOrAdvanceTarget(state, p1Id, rePicked.session, c2.ref);
		assert.equal(bothPicked.status, 'ready_to_submit');
		assert.equal(bothPicked.payload.type, 'cast_spell');
		assert.deepEqual(bothPicked.payload.targets, [p2Ref, c1.ref, c2.ref]);
	});
});
