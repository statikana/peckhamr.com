import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createCardInstance, createInitialGameState } from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard
} from '../types.ts';
import { buildBoardViewModel } from './boardViewModel.ts';
import {
	assignSelectedBlockerToAttacker,
	buildDeclareAttackersPayload,
	buildDeclareBlockersPayload,
	canViewerSelectAllAttackers,
	createEmptyCombatDraft,
	deriveTurnControlView,
	pruneStaleCombatDraft,
	retargetDraftAttackersToPlaneswalker,
	retargetDraftAttackersToPlayer,
	selectAllEligibleAttackers,
	toggleDraftAttacker,
	toggleOrSelectBlocker
} from './combatController.ts';

function synthCard(
	overrides: Partial<ScryfallCard> & Pick<ScryfallCard, 'name' | 'typeLine'>
): ScryfallCard {
	const id = `synth_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
		oracleId: id,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{R}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine,
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['R'],
		colorIdentity: overrides.colorIdentity ?? ['R'],
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
		isBackground: false
	};
}

function makeThreeSeatMatch(): GameState {
	const seats: LobbySeat[] = [
		{ seatIndex: 0, userId: 'p1', username: 'SeatAlpha', isBot: false },
		{ seatIndex: 1, userId: 'p2', username: 'SeatBeta', isBot: true },
		{ seatIndex: 2, userId: 'p3', username: 'SeatGamma', isBot: true }
	].map((s, i) => ({
		...s,
		avatarUrl: '',
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
		[1, PRECON_DECKS[1]],
		[2, PRECON_DECKS[2]]
	]);
	const state = createInitialGameState('TESTPOD', seats, decks, { ...DEFAULT_LOBBY_RULES });
	state.status = 'active';
	state.pendingPrompts = [];
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'declare_attackers';
	state.combat = {
		active: false,
		attackers: [],
		declaredBlockersPlayerIds: [],
		damageDealtFirstStrike: false,
		damageDealtNormal: false
	};
	return state;
}

describe('combatController', () => {
	it('toggles attackers, supports Attack All, and retargets between players and Layer-4 planeswalkers', () => {
		const state = makeThreeSeatMatch();
		const p1 = state.players[0];
		const p3 = state.players[2];

		const strikerA = createCardInstance(
			synthCard({
				name: 'Synthetic Striker One',
				typeLine: 'Creature — Construct',
				power: '3',
				toughness: '3'
			}),
			'p1',
			'battlefield'
		);
		strikerA.summoningSick = false;

		const strikerB = createCardInstance(
			synthCard({
				name: 'Synthetic Striker Two',
				typeLine: 'Creature — Construct',
				power: '2',
				toughness: '2'
			}),
			'p1',
			'battlefield'
		);
		strikerB.summoningSick = false;

		const sickCreature = createCardInstance(
			synthCard({
				name: 'Synthetic Sickling',
				typeLine: 'Creature — Construct',
				power: '1',
				toughness: '1'
			}),
			'p1',
			'battlefield'
		);
		sickCreature.summoningSick = true;

		const walker = createCardInstance(
			synthCard({
				name: 'Synthetic Horizon Guide',
				typeLine: 'Legendary Planeswalker — Guide',
				loyalty: '4'
			}),
			'p3',
			'battlefield'
		);
		walker.counters.loyalty = 4;

		p1.battlefield.push(strikerA, strikerB, sickCreature);
		p3.battlefield.push(walker);

		const vm = buildBoardViewModel(state, 'p1');
		assert.equal(
			canViewerSelectAllAttackers(vm, state, 'p1', {
				isConfirmingAttackers: true,
				hasPriority: true,
				interactionBlocked: false
			}),
			true
		);

		let draft = createEmptyCombatDraft();
		// Sick creature cannot be drafted as an attacker
		draft = toggleDraftAttacker(
			draft,
			vm.permanentsById[sickCreature.instanceId]!,
			state,
			'p1'
		);
		assert.deepEqual(draft.draftAttackers, {});

		// Toggle Striker One on -> defaults to first alive opponent (p2)
		draft = toggleDraftAttacker(
			draft,
			vm.permanentsById[strikerA.instanceId]!,
			state,
			'p1'
		);
		assert.equal(draft.draftAttackers[strikerA.instanceId], 'p2');

		// Retarget to SeatGamma (p3)
		draft = retargetDraftAttackersToPlayer(draft, p3, 'p1');
		assert.equal(draft.draftAttackers[strikerA.instanceId], 'p3');

		// Select All Eligible Attackers preserves existing target for Striker One and adds Striker Two
		draft = selectAllEligibleAttackers(draft, vm, state, 'p1');
		assert.equal(draft.draftAttackers[strikerA.instanceId], 'p3');
		assert.equal(draft.draftAttackers[strikerB.instanceId], 'p2');
		assert.equal(draft.draftAttackers[sickCreature.instanceId], undefined);

		// Retarget all drafted attackers to SeatGamma's planeswalker
		const walkerView = vm.permanentsById[walker.instanceId]!;
		draft = retargetDraftAttackersToPlaneswalker(draft, walkerView, 'p3', 'p1');
		const atkPayload = buildDeclareAttackersPayload(draft);
		assert.deepEqual(atkPayload, {
			type: 'declare_attackers',
			assignments: [
				{
					attackerInstanceId: strikerA.instanceId,
					defenderPlayerId: 'p3',
					defenderPlaneswalkerId: walker.instanceId
				},
				{
					attackerInstanceId: strikerB.instanceId,
					defenderPlayerId: 'p3',
					defenderPlaneswalkerId: walker.instanceId
				}
			]
		});
	});

	it('auto-assigns single-attacker blocks, handles multi-attacker selection, and prunes on phase change', () => {
		const state = makeThreeSeatMatch();
		state.activePlayerIndex = 1; // p2's turn
		state.priorityPlayerIndex = 0; // p1 declaring blockers
		state.phase = 'declare_blockers';

		const p1 = state.players[0];
		const p2 = state.players[1];

		const atk1 = createCardInstance(
			synthCard({
				name: 'Synthetic Raider Alpha',
				typeLine: 'Creature — Construct',
				power: '4',
				toughness: '4'
			}),
			'p2',
			'battlefield'
		);
		const atk2 = createCardInstance(
			synthCard({
				name: 'Synthetic Raider Beta',
				typeLine: 'Creature — Construct',
				power: '2',
				toughness: '2'
			}),
			'p2',
			'battlefield'
		);
		const guard = createCardInstance(
			synthCard({
				name: 'Synthetic Bastion Guard',
				typeLine: 'Creature — Construct',
				power: '2',
				toughness: '5'
			}),
			'p1',
			'battlefield'
		);
		p2.battlefield.push(atk1, atk2);
		p1.battlefield.push(guard);

		// Single attacker on p1 -> clicking guard auto-assigns to atk1
		state.combat = {
			active: true,
			attackers: [
				{
					attackerInstanceId: atk1.instanceId,
					controllerId: 'p2',
					defenderPlayerId: 'p1',
					blockerInstanceIds: []
				}
			],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		};

		let vm = buildBoardViewModel(state, 'p1');
		let draft = createEmptyCombatDraft();
		draft = toggleOrSelectBlocker(
			draft,
			vm.permanentsById[guard.instanceId]!,
			state,
			'p1'
		);
		assert.equal(draft.draftBlockers[guard.instanceId], atk1.instanceId);
		assert.equal(draft.selectedBlockerId, null);

		// Clicking guard again unassigns the block
		draft = toggleOrSelectBlocker(
			draft,
			vm.permanentsById[guard.instanceId]!,
			state,
			'p1'
		);
		assert.deepEqual(draft.draftBlockers, {});

		// Two attackers on p1 -> clicking guard selects it first, then clicking atk2 assigns it
		state.combat.attackers.push({
			attackerInstanceId: atk2.instanceId,
			controllerId: 'p2',
			defenderPlayerId: 'p1',
			blockerInstanceIds: []
		});
		vm = buildBoardViewModel(state, 'p1');
		draft = toggleOrSelectBlocker(
			draft,
			vm.permanentsById[guard.instanceId]!,
			state,
			'p1'
		);
		assert.equal(draft.selectedBlockerId, guard.instanceId);
		draft = assignSelectedBlockerToAttacker(draft, atk2.instanceId, state);
		assert.equal(draft.selectedBlockerId, null);
		assert.deepEqual(buildDeclareBlockersPayload(draft), {
			type: 'declare_blockers',
			assignments: [
				{
					blockerInstanceId: guard.instanceId,
					attackerInstanceId: atk2.instanceId
				}
			]
		});

		// Advancing to combat_damage prunes stale blocker draft
		state.phase = 'combat_damage';
		const pruned = pruneStaleCombatDraft(draft, state, 'p1');
		assert.deepEqual(pruned.draftBlockers, {});
		assert.equal(pruned.selectedBlockerId, null);
	});

	it('derives turn control labels and disables step actions while targeting or waiting on prompts', () => {
		const state = makeThreeSeatMatch();
		const p1 = state.players[0];
		let draft = createEmptyCombatDraft();

		const noAtkCtrl = deriveTurnControlView(state, p1, draft, false);
		assert.equal(noAtkCtrl.isConfirmingAttackers, true);
		assert.equal(noAtkCtrl.canAdvanceOrPass, true);
		assert.equal(noAtkCtrl.primaryStepLabel, 'No Attacks');

		draft = { ...draft, draftAttackers: { synth_atk_1: 'p2', synth_atk_2: 'p3' } };
		const twoAtkCtrl = deriveTurnControlView(state, p1, draft, false);
		assert.equal(twoAtkCtrl.primaryStepLabel, 'Attack with 2');

		const blockedByTargeting = deriveTurnControlView(state, p1, draft, true);
		assert.equal(blockedByTargeting.canAdvanceOrPass, false);
		assert.equal(blockedByTargeting.canPassToEndOfTurn, false);
	});
});
