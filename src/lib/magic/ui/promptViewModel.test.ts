import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	FACE_DOWN_ART_URI,
	adjustAllocation,
	allocatedTotal,
	buildOrderObjectsInitialLists,
	computeWeightProgress,
	createAllocationState,
	createPileSplitState,
	filterStringOptions,
	isPromptCancellable,
	isSingleClickObjectChoice,
	isValidAllocation,
	isValidPileSplit,
	moveBetweenPiles,
	moveOrderedObjectSplit,
	remainingAllocation,
	resolvePromptCandidates,
	serializePileSplit,
	shiftOrderedObjects
} from './promptViewModel.ts';
import {
	DEFAULT_LOBBY_RULES,
	createEmptyCounterMap,
	type CardInstance,
	type GameState,
	type PendingPrompt,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type ZoneType
} from '../types.ts';

function makeSyntheticCard(overrides: Partial<ScryfallCard> & { id: string; name: string }): ScryfallCard {
	return {
		id: overrides.id,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{2}{U}',
		cmc: overrides.cmc ?? 3,
		typeLine: overrides.typeLine ?? 'Creature — Construct',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['U'],
		colorIdentity: overrides.colorIdentity ?? ['U'],
		keywords: overrides.keywords ?? [],
		...(overrides.power !== undefined ? { power: overrides.power } : { power: '2' }),
		...(overrides.toughness !== undefined ? { toughness: overrides.toughness } : { toughness: '3' }),
		imageUrl: overrides.imageUrl ?? `https://example.test/cards/${overrides.id}.jpg`,
		artCropUrl: overrides.artCropUrl ?? `https://example.test/art/${overrides.id}.jpg`,
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false
	};
}

function makeInstance(
	id: string,
	card: ScryfallCard,
	ownerId: string,
	zone: ZoneType,
	overrides: Partial<CardInstance> = {}
): CardInstance {
	return {
		instanceId: id,
		card,
		ownerId,
		controllerId: overrides.controllerId ?? ownerId,
		zone,
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		// --- Track P11 ---
		counters: createEmptyCounterMap(),
		// --- End Track P11 ---
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: false,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		...overrides
	};
}

function makePlayer(playerId: string, username: string, life = 40): PlayerGameState {
	return {
		playerId,
		seatIndex: playerId === 'p1' ? 0 : 1,
		username,
		avatarUrl: '',
		isBot: false,
		life,
		poison: 0,
		experienceCounters: 0,
		energyCounters: 0,
		manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
		landsPlayedThisTurn: 0,
		maxLandsPerTurn: 1,
		mulliganCount: 0,
		hasKeptHand: true,
		lost: false,
		commanderDamageTaken: {},
		commanderNames: {},
		commanderCastCounts: {},
		autoPassEmptyStack: false,
		fullControl: false,
		stopPhases: [],
		library: [],
		hand: [],
		battlefield: [],
		graveyard: [],
		exile: [],
		command: []
	};
}

function makeGameState(players: PlayerGameState[], stack: StackItem[] = []): GameState {
	return {
		engineVersion: 1,
		gameId: 'g_test',
		lobbyCode: 'TEST01',
		status: 'active',
		winnerPlayerId: null,
		rules: { ...DEFAULT_LOBBY_RULES },
		turnNumber: 3,
		activePlayerIndex: 0,
		priorityPlayerIndex: 0,
		passedPriorityPlayerIds: [],
		phase: 'main1',
		players,
		stack,
		combat: {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		},
		pendingPrompts: [],
		recentVfxEvents: [],
		log: [],
		turnStartedAt: 0,
		priorityUpdatedAt: 0
	};
}

describe('promptViewModel — cross-zone candidate resolution & face-down secrecy', () => {
	it('resolves candidates across all 7 zones + pendingZoneMoves for multiple players in input order', () => {
		const p1 = makePlayer('p1', 'Alice', 38);
		const p2 = makePlayer('p2', 'Bob', 29);

		const bfOrig = makeSyntheticCard({ id: 'c_bf_orig', name: 'Shapeshifter Vessel' });
		const bfCopied = makeSyntheticCard({ id: 'c_bf_copy', name: 'Mirrored Colossus' });
		const stolenPerm = makeInstance('inst_bf_stolen', bfOrig, 'p2', 'battlefield', {
			controllerId: 'p1',
			copiableCard: bfCopied
		});
		p1.battlefield = [stolenPerm];

		const handCard = makeInstance(
			'inst_hand',
			makeSyntheticCard({ id: 'c_hand', name: 'Aether Spark' }),
			'p1',
			'hand'
		);
		p1.hand = [handCard];

		const oppGyCard = makeInstance(
			'inst_opp_gy',
			makeSyntheticCard({ id: 'c_gy', name: 'Ashen Relic' }),
			'p2',
			'graveyard'
		);
		p2.graveyard = [oppGyCard];

		const oppExileCard = makeInstance(
			'inst_opp_ex',
			makeSyntheticCard({ id: 'c_ex', name: 'Void Shard' }),
			'p2',
			'exile'
		);
		p2.exile = [oppExileCard];

		const cmdCard = makeInstance(
			'inst_cmd',
			makeSyntheticCard({ id: 'c_cmd', name: 'Starlight Sovereign' }),
			'p1',
			'command',
			{ isCommander: true }
		);
		p1.command = [cmdCard];

		const libCard = makeInstance(
			'inst_lib',
			makeSyntheticCard({ id: 'c_lib', name: 'Chrono Compass' }),
			'p2',
			'library'
		);
		p2.library = [libCard];

		const stackCard = makeSyntheticCard({ id: 'c_stk', name: 'Arcane Surge' });
		const stackSpell: StackItem = {
			id: 'stk_1',
			sourceInstanceId: 'inst_src_stk',
			card: stackCard,
			ownerId: 'p2',
			controllerId: 'p2',
			kind: 'spell',
			title: 'Arcane Surge',
			oracleText: '',
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 100
		};

		const pendingCard = makeInstance(
			'inst_pending',
			makeSyntheticCard({ id: 'c_pend', name: 'Drifting Nomad' }),
			'p1',
			'graveyard'
		);

		const state = makeGameState([p1, p2], [stackSpell]);
		state.pendingZoneMoves = [pendingCard];

		const requestedIds = [
			'stk_1',
			'inst_opp_gy',
			'inst_bf_stolen',
			'p2',
			'inst_opp_ex',
			'inst_cmd',
			'inst_lib',
			'inst_hand',
			'inst_pending',
			'custom_option_alpha'
		];

		const res = resolvePromptCandidates(state, 'p1', requestedIds);
		assert.deepEqual(
			res.candidates.map((c) => c.id),
			[
				'stk_1',
				'inst_opp_gy',
				'inst_bf_stolen',
				'inst_opp_ex',
				'inst_cmd',
				'inst_lib',
				'inst_hand',
				'inst_pending'
			]
		);

		// Verify Layer 1 copiableCard is respected via effectiveCardForObject + stolen ownership metadata
		const stolenEntry = res.candidates.find((c) => c.id === 'inst_bf_stolen')!;
		assert.equal(stolenEntry.displayCard.name, 'Mirrored Colossus');
		assert.equal(stolenEntry.ownerName, 'Bob');
		assert.equal(stolenEntry.controllerName, 'Alice');
		assert.equal(stolenEntry.zone, 'battlefield');
		assert.equal(stolenEntry.isYours, true);
		assert.equal(stolenEntry.isOwnedByViewer, false);

		// Verify opponent graveyard metadata
		const gyEntry = res.candidates.find((c) => c.id === 'inst_opp_gy')!;
		assert.equal(gyEntry.ownerName, 'Bob');
		assert.equal(gyEntry.controllerName, 'Bob');
		assert.equal(gyEntry.zone, 'graveyard');
		assert.equal(gyEntry.isYours, false);

		// Verify stack item candidate
		const stkEntry = res.candidates.find((c) => c.id === 'stk_1')!;
		assert.equal(stkEntry.zone, 'stack');
		assert.equal(stkEntry.controllerName, 'Bob');
		assert.equal(stkEntry.displayCard.name, 'Arcane Surge');
		assert.equal(stkEntry.isYours, false);

		// Verify nonCardCandidates (player + raw option)
		assert.equal(res.nonCardCandidates.length, 2);
		assert.equal(res.nonCardCandidates[0].kind, 'player');
		assert.equal(res.nonCardCandidates[0].label, 'Player: Bob (29 life)');
		assert.equal(res.nonCardCandidates[1].kind, 'option');
		assert.equal(res.nonCardCandidates[1].label, 'custom_option_alpha');
	});

	it('enforces face-down secrecy across battlefield (CR 708.5), exile (CR 406.3), and stack (CR 708.4)', () => {
		const p1 = makePlayer('p1', 'Alice');
		const p2 = makePlayer('p2', 'Bob');

		const secretPermanent = makeInstance(
			'fd_bf',
			makeSyntheticCard({ id: 'secret_1', name: 'Hidden Leviathan' }),
			'p2',
			'battlefield',
			{
				controllerId: 'p2',
				isFaceDown: true,
				faceDownLabel: 'Disguised Creature',
				faceDownSpec: { kind: 'disguise', wardCost: '{2}', power: 2, toughness: 2 }
			}
		);
		p2.battlefield = [secretPermanent];

		const secretExileForNobody = makeInstance(
			'fd_ex_locked',
			makeSyntheticCard({ id: 'secret_2', name: 'Sealed Grimoire' }),
			'p1',
			'exile',
			{
				isFaceDown: true,
				faceDownLabel: 'Exiled Face-Down'
			}
		);
		const secretExileKnownToP1 = makeInstance(
			'fd_ex_known',
			makeSyntheticCard({ id: 'secret_3', name: 'Foretold Comet' }),
			'p1',
			'exile',
			{
				isFaceDown: true,
				knownToPlayerIds: ['p1']
			}
		);
		p1.exile = [secretExileForNobody, secretExileKnownToP1];

		const secretStackSpell: StackItem = {
			id: 'fd_stk',
			sourceInstanceId: 'src_fd_stk',
			card: makeSyntheticCard({ id: 'secret_4', name: 'Cloaked Ambush' }),
			ownerId: 'p2',
			controllerId: 'p2',
			kind: 'spell',
			title: 'Cloaked Ambush',
			oracleText: '',
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 200,
			isFaceDown: true,
			faceDownLabel: 'Morph Spell'
		};

		const state = makeGameState([p1, p2], [secretStackSpell]);
		const ids = ['fd_bf', 'fd_ex_locked', 'fd_ex_known', 'fd_stk'];

		// Viewer p1 (Alice): cannot see p2's face-down permanent or spell, cannot see locked exile, CAN see known exile
		const asAlice = resolvePromptCandidates(state, 'p1', ids);
		const bfForAlice = asAlice.candidates.find((c) => c.id === 'fd_bf')!;
		assert.equal(bfForAlice.isFaceDownHidden, true);
		assert.equal(bfForAlice.displayCard.id, 'face_down');
		assert.equal(bfForAlice.displayCard.name, 'Disguised Creature');
		assert.equal(bfForAlice.imageUrl, FACE_DOWN_ART_URI);

		const lockedExForAlice = asAlice.candidates.find((c) => c.id === 'fd_ex_locked')!;
		assert.equal(lockedExForAlice.isFaceDownHidden, true);
		assert.equal(lockedExForAlice.displayCard.id, 'face_down');
		assert.equal(lockedExForAlice.imageUrl, FACE_DOWN_ART_URI);

		const knownExForAlice = asAlice.candidates.find((c) => c.id === 'fd_ex_known')!;
		assert.equal(knownExForAlice.isFaceDownHidden, false);
		assert.equal(knownExForAlice.displayCard.name, 'Foretold Comet');

		const stkForAlice = asAlice.candidates.find((c) => c.id === 'fd_stk')!;
		assert.equal(stkForAlice.isFaceDownHidden, true);
		assert.equal(stkForAlice.displayCard.id, 'face_down');
		assert.equal(stkForAlice.displayCard.name, 'Morph Spell');

		// Viewer p2 (Bob): CAN see his own face-down battlefield permanent and stack spell, cannot see p1's known exile
		const asBob = resolvePromptCandidates(state, 'p2', ids);
		assert.equal(asBob.candidates.find((c) => c.id === 'fd_bf')!.displayCard.name, 'Hidden Leviathan');
		assert.equal(asBob.candidates.find((c) => c.id === 'fd_stk')!.displayCard.name, 'Cloaked Ambush');
		assert.equal(asBob.candidates.find((c) => c.id === 'fd_ex_known')!.isFaceDownHidden, true);
	});
});

describe('promptViewModel — generalized orderObjects & cancellable prompts', () => {
	it('resolves orderObjects candidates outside me.library (graveyard, exile, battlefield blockers, opponent library)', () => {
		const p1 = makePlayer('p1', 'Alice');
		const p2 = makePlayer('p2', 'Bob');

		const gy1 = makeInstance('gy_1', makeSyntheticCard({ id: 'g1', name: 'Bone Sentinel' }), 'p1', 'graveyard');
		const gy2 = makeInstance('gy_2', makeSyntheticCard({ id: 'g2', name: 'Crypt Hound' }), 'p1', 'graveyard');
		p1.graveyard = [gy1, gy2];

		const blk1 = makeInstance('blk_1', makeSyntheticCard({ id: 'b1', name: 'Iron Guard' }), 'p2', 'battlefield');
		const blk2 = makeInstance('blk_2', makeSyntheticCard({ id: 'b2', name: 'Stone Warden' }), 'p2', 'battlefield');
		p2.battlefield = [blk1, blk2];

		const state = makeGameState([p1, p2]);

		const gyLists = buildOrderObjectsInitialLists(state, 'p1', {
			objectIds: ['gy_2', 'gy_1'],
			allowSplitBottom: false
		});
		assert.deepEqual(gyLists.topIds, ['gy_2', 'gy_1']);
		assert.deepEqual(gyLists.bottomIds, []);
		assert.equal(gyLists.inferredZone, 'graveyard');
		assert.equal(gyLists.candidatesById.get('gy_2')?.displayCard.name, 'Crypt Hound');
		assert.equal(gyLists.candidatesById.get('gy_1')?.displayCard.name, 'Bone Sentinel');

		const blockerLists = buildOrderObjectsInitialLists(state, 'p1', {
			objectIds: ['blk_1', 'blk_2'],
			allowSplitBottom: false
		});
		assert.equal(blockerLists.inferredZone, 'battlefield');
		assert.equal(blockerLists.candidates.length, 2);

		// Verify immutable reorder + split helpers
		const shifted = shiftOrderedObjects(gyLists.topIds, gyLists.bottomIds, 'gy_1', -1);
		assert.deepEqual(shifted.topIds, ['gy_1', 'gy_2']);

		const split = moveOrderedObjectSplit(shifted.topIds, shifted.bottomIds, 'gy_2', true);
		assert.deepEqual(split.topIds, ['gy_1']);
		assert.deepEqual(split.bottomIds, ['gy_2']);

		const unsplit = moveOrderedObjectSplit(split.topIds, split.bottomIds, 'gy_2', false);
		assert.deepEqual(unsplit.topIds, ['gy_1', 'gy_2']);
		assert.deepEqual(unsplit.bottomIds, []);
	});

	it('honors isPromptCancellable across all 6 ChoiceKinds and cost_choice purpose', () => {
		const basePrompt: PendingPrompt = {
			id: 'pr_1',
			kind: 'chooseObjects',
			playerId: 'p1',
			title: 'Pick',
			description: 'Pick one'
		};

		assert.equal(isPromptCancellable(basePrompt, 'generic'), false);
		assert.equal(isPromptCancellable({ ...basePrompt, cancellable: true }, 'generic'), true);
		assert.equal(isPromptCancellable({ ...basePrompt, cancellable: false }, 'cost_choice'), true);
		assert.equal(isPromptCancellable({ ...basePrompt, kind: 'cost_choice' }), true);
		assert.equal(isPromptCancellable(null), false);
	});

	it('computes weight progress, single-click fast pick eligibility, and empty-candidate bypass', () => {
		const crewChoice = {
			candidates: ['c1', 'c2', 'c3'],
			min: 1,
			max: 3,
			minWeightSum: 4,
			weightsById: { c1: 2, c2: 3, c3: 1 },
			weightLabel: 'Power'
		};
		assert.equal(isSingleClickObjectChoice(crewChoice), false);
		assert.equal(isSingleClickObjectChoice({ min: 1, max: 1 }), true);
		assert.equal(isSingleClickObjectChoice({ min: 0, max: 1 }), false);

		const p0 = computeWeightProgress(['c1'], crewChoice);
		assert.equal(p0.selectedWeightSum, 2);
		assert.equal(p0.remainingWeight, 2);
		assert.equal(p0.weightLabel, 'power');
		assert.equal(p0.countSatisfied, true);
		assert.equal(p0.weightSatisfied, false);
		assert.equal(p0.isReady, false);

		const p1 = computeWeightProgress(['c1', 'c2'], crewChoice);
		assert.equal(p1.selectedWeightSum, 5);
		assert.equal(p1.remainingWeight, 0);
		assert.equal(p1.progressRatio, 1);
		assert.equal(p1.isReady, true);

		// Empty-candidate mandatory tutor bypass
		const emptyTutor = computeWeightProgress([], {
			candidates: [],
			min: 1,
			max: 1
		});
		assert.equal(emptyTutor.isReady, true);
	});
});

describe('promptViewModel — CR 601.2d AllocationState, CR 701.23 PileSplitState, CR 201.4 filterStringOptions', () => {
	it('enforces CR 601.2d divided allocation rules (total === amountToDistribute and each target >= minPerTarget)', () => {
		let state = createAllocationState({
			targetIds: ['t1', 't2', 't3'],
			amountToDistribute: 5
		});
		// Default seeds minPerTarget = 1 onto each target, leaving 2 unallocated
		assert.equal(state.minPerTarget, 1);
		assert.deepEqual(state.allocations, { t1: 1, t2: 1, t3: 1 });
		assert.equal(allocatedTotal(state), 3);
		assert.equal(remainingAllocation(state), 2);
		assert.equal(isValidAllocation(state), false);

		// Add +5 to t1 -> clamps to remaining pool (+2 -> t1 = 3), making total 5
		state = adjustAllocation(state, 't1', 5);
		assert.deepEqual(state.allocations, { t1: 3, t2: 1, t3: 1 });
		assert.equal(remainingAllocation(state), 0);
		assert.equal(isValidAllocation(state), true);

		// Drop t3 down to 0 and move that point to t2 -> sum is still 5, but t3 < minPerTarget (1) violates CR 601.2d!
		state = adjustAllocation(state, 't3', -1);
		state = adjustAllocation(state, 't2', 1);
		assert.deepEqual(state.allocations, { t1: 3, t2: 2, t3: 0 });
		assert.equal(allocatedTotal(state), 5);
		assert.equal(isValidAllocation(state), false);

		// Rebalance 1 point back to t3 -> valid again
		state = adjustAllocation(state, 't1', -1);
		state = adjustAllocation(state, 't3', 1);
		assert.deepEqual(state.allocations, { t1: 2, t2: 2, t3: 1 });
		assert.equal(isValidAllocation(state), true);

		// Impossible split: 2 damage across 3 targets with minPerTarget = 1
		const impossible = createAllocationState({
			targetIds: ['a', 'b', 'c'],
			amountToDistribute: 2,
			minPerTarget: 1
		});
		assert.equal(isValidAllocation(impossible), false);
	});

	it('manages CR 701.23 two-pile splits immutably and serializes to orderObjects', () => {
		let split = createPileSplitState(['id_1', 'id_2', 'id_3', 'id_4']);
		// Empty Pile B is legal per CR 701.23b
		assert.equal(isValidPileSplit(split), true);
		assert.deepEqual(split.pileA, ['id_1', 'id_2', 'id_3', 'id_4']);
		assert.deepEqual(split.pileB, []);

		split = moveBetweenPiles(split, 'id_2');
		split = moveBetweenPiles(split, 'id_4', 'B');
		assert.deepEqual(split.pileA, ['id_1', 'id_3']);
		assert.deepEqual(split.pileB, ['id_2', 'id_4']);
		assert.equal(isValidPileSplit(split), true);

		// Moving back to A restores membership without duplication
		split = moveBetweenPiles(split, 'id_2', 'A');
		assert.deepEqual(split.pileA, ['id_1', 'id_3', 'id_2']);
		assert.deepEqual(split.pileB, ['id_4']);

		const serialized = serializePileSplit(split);
		assert.deepEqual(serialized.answer, {
			kind: 'orderObjects',
			topIds: ['id_1', 'id_3', 'id_2'],
			bottomIds: ['id_4'],
			shuffle: false
		});
	});

	it('ranks options by exact > prefix > word-prefix > substring in filterStringOptions', () => {
		const subtypes = [
			'Overlord',
			'Time Lord',
			'Lord',
			'DragonLord',
			'Lordship',
			'Wizard',
			'Elemental'
		];

		const ranked = filterStringOptions(subtypes, '  lord ');
		assert.deepEqual(ranked, [
			'Lord', // exact
			'Lordship', // string prefix
			'Time Lord', // word-boundary prefix
			'Overlord', // substring (in input order)
			'DragonLord' // substring (in input order)
		]);

		assert.deepEqual(filterStringOptions(subtypes, '', 3), ['Overlord', 'Time Lord', 'Lord']);
		assert.deepEqual(filterStringOptions(subtypes, 'lord', 2), ['Lord', 'Lordship']);
	});
});
