import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyGameAction, createCardInstance, createInitialGameState } from '../engine.ts';
import { noteLayerInputsChanged } from '../runtime/layerCache.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';
import {
	buildBoardViewModel,
	computeArrowSignature,
	extractCounterBadges,
	sortHandCards
} from './boardViewModel.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `u1_vm_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: 'https://example.invalid/card.jpg',
		artCropUrl: 'https://example.invalid/crop.jpg',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function makeSeat(i: number, isBot: boolean): LobbySeat {
	const deck = PRECON_DECKS[i];
	return {
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `Player ${i + 1}`,
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

function createTestBoard(): { state: GameState; p1: PlayerGameState; p2: PlayerGameState } {
	const seats = [makeSeat(0, false), makeSeat(1, false)];
	const state = createInitialGameState(
		'U1VM',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		p.restrictedMana = {};
	}
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.stack = [];
	state.pendingPrompts = [];
	noteLayerInputsChanged(state);
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	inst.summoningSick = false;
	player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

describe('UI Track U1: boardViewModel', () => {
	it('indexes O(B) attachments across players and skips phased-out objects', () => {
		const { state, p1, p2 } = createTestBoard();

		const host = putInZone(
			state,
			p1,
			synthCard({
				name: 'Vanguard Sentinel',
				typeLine: 'Creature — Soldier',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				colorIdentity: ['W'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const blade = putInZone(
			state,
			p1,
			synthCard({
				name: 'Sunforged Pike',
				typeLine: 'Artifact — Equipment',
				manaCost: '{2}',
				cmc: 2,
				oracleText: 'Equipped creature gets +2/+0.\nEquip {1}'
			}),
			'battlefield'
		);
		blade.attachedToId = host.instanceId;

		const oppAura = putInZone(
			state,
			p2,
			synthCard({
				name: 'Leaden Fetters',
				typeLine: 'Enchantment — Aura',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				colorIdentity: ['U'],
				oracleText: 'Enchant creature\nEnchanted creature gets -1/-0.'
			}),
			'battlefield'
		);
		oppAura.attachedToId = host.instanceId;

		const phasedOutGear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Glimmer Cloak',
				typeLine: 'Artifact — Equipment',
				manaCost: '{1}',
				cmc: 1,
				oracleText: 'Equip {1}'
			}),
			'battlefield'
		);
		phasedOutGear.attachedToId = host.instanceId;
		phasedOutGear.phasedOut = true;
		noteLayerInputsChanged(state);

		const vm = buildBoardViewModel(state, p1.playerId);

		const attachedIds = (vm.attachmentsByHostId[host.instanceId] ?? []).map((a) => a.instanceId);
		assert.deepEqual(attachedIds, [blade.instanceId, oppAura.instanceId]);
		assert.equal(vm.hostByAttachmentId[blade.instanceId]?.instanceId, host.instanceId);
		assert.equal(vm.hostByAttachmentId[oppAura.instanceId]?.instanceId, host.instanceId);
		assert.equal(vm.hostByAttachmentId[phasedOutGear.instanceId], undefined);

		const hostView = vm.permanentsById[host.instanceId];
		assert.equal(hostView.power, 3); // 2 + 2 - 1
		assert.equal(hostView.toughness, 2);
		assert.equal(hostView.attachments.length, 2);
		assert.equal(vm.permanentsById[blade.instanceId].host?.instanceId, host.instanceId);
	});

	it('partitions frontRow vs backRow and preserves all counter badges including Saga lore counters', () => {
		const { state, p1, p2 } = createTestBoard();

		const defenderCreature = putInZone(
			state,
			p1,
			synthCard({
				name: 'Bastion Bulwark',
				typeLine: 'Creature — Wall',
				manaCost: '{2}{W}',
				cmc: 3,
				power: '0',
				toughness: '5',
				oracleText: 'Defender',
				keywords: ['Defender']
			}),
			'battlefield'
		);
		defenderCreature.counters['+1/+1'] = 2;
		defenderCreature.counters.shield = 1;
		defenderCreature.counters.stun = 1;
		defenderCreature.goadedByPlayerIds = [p2.playerId];
		defenderCreature.saddledThisTurn = true;

		const walker = putInZone(
			state,
			p1,
			synthCard({
				name: 'Aurelia Wayfarer',
				typeLine: 'Legendary Planeswalker — Wayfarer',
				manaCost: '{2}{U}{U}',
				cmc: 4,
				loyalty: '4',
				oracleText: '+1: Draw a card.'
			}),
			'battlefield'
		);
		walker.counters.loyalty = 5;

		const sagaBackRow = putInZone(
			state,
			p1,
			synthCard({
				name: 'Chronicle of Dawn',
				typeLine: 'Enchantment — Saga',
				manaCost: '{2}{W}',
				cmc: 3,
				oracleText: 'I — Gain 2 life.\nII — Draw a card.\nIII — Gain 4 life.'
			}),
			'battlefield'
		);
		sagaBackRow.counters.lore = 2;

		const dynamoBackRow = putInZone(
			state,
			p1,
			synthCard({
				name: 'Temporal Reactor',
				typeLine: 'Artifact',
				manaCost: '{3}',
				cmc: 3,
				oracleText: '{T}: Add {C}.'
			}),
			'battlefield'
		);
		dynamoBackRow.counters.charge = 4;
		dynamoBackRow.counters.time = 3;
		dynamoBackRow.counters.age = 1;
		dynamoBackRow.counters['-1/-1'] = 1;
		(dynamoBackRow.counters as Record<string, number>).filibuster = 2;
		noteLayerInputsChanged(state);

		const vm = buildBoardViewModel(state, p1.playerId);

		assert.deepEqual(
			vm.frontRow.map((v) => v.instanceId),
			[defenderCreature.instanceId, walker.instanceId]
		);
		assert.deepEqual(
			vm.backRow.map((v) => v.instanceId),
			[sagaBackRow.instanceId, dynamoBackRow.instanceId]
		);

		const defView = vm.permanentsById[defenderCreature.instanceId];
		assert.equal(defView.isCreature, true);
		assert.equal(defView.hasDefender, true);
		assert.equal(defView.isGoaded, true);
		assert.equal(defView.isSaddled, true);
		assert.deepEqual(
			defView.countersList.map((c) => [c.badgeKind, c.count]),
			[
				['plus', 2],
				['shield', 1],
				['stun', 1]
			]
		);

		const sagaView = vm.permanentsById[sagaBackRow.instanceId];
		assert.equal(sagaView.isCreature, false);
		assert.deepEqual(
			sagaView.countersList.map((c) => [c.badgeKind, c.type, c.count]),
			[['lore', 'lore', 2]]
		);

		const dynamoView = vm.permanentsById[dynamoBackRow.instanceId];
		assert.deepEqual(
			dynamoView.countersList.map((c) => [c.badgeKind, c.count]),
			[
				['minus', 1],
				['charge', 4],
				['time', 3],
				['age', 1],
				['other', 2]
			]
		);

		const directBadges = extractCounterBadges({ lore: 3, charge: 0 });
		assert.equal(directBadges.length, 1);
		assert.equal(directBadges[0].badgeKind, 'lore');
	});

	it('extracts Monarch, Energy, Experience, Rad, Poison, RestrictedMana, Commander Damage, and Turn Shields', () => {
		const { state, p1, p2 } = createTestBoard();

		state.monarchPlayerId = p1.playerId;
		p1.poison = 4;
		p1.energyCounters = 6;
		p1.experienceCounters = 3;
		(p1 as unknown as { radCounters?: number }).radCounters = 2;
		p1.restrictedMana = {
			artifactSpellOrNonSpell: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 }
		};
		p1.commanderDamageTaken = { cmd_opp_1: 14 };
		p1.commanderNames = { cmd_opp_1: 'Valken, Sky Sovereign' };
		p1.protectionFromEverythingThisTurn = true;
		p1.cannotLoseGameThisTurn = true;
		p1.lifeTotalCannotChangeThisTurn = true;
		p1.damagePreventionShield = 5;
		p1.preventAllCombatDamageThisTurn = true;

		const vm = buildBoardViewModel(state, p1.playerId);
		const st1 = vm.playerStatusesById[p1.playerId];
		const st2 = vm.playerStatusesById[p2.playerId];

		assert.equal(st1.isMonarch, true);
		assert.equal(st2.isMonarch, false);
		assert.equal(st1.poison, 4);
		assert.equal(st1.energyCounters, 6);
		assert.equal(st1.experienceCounters, 3);
		assert.equal(st1.radCounters, 2);
		assert.equal(st1.restrictedManaEntries.length, 1);
		assert.equal(st1.restrictedManaEntries[0].restriction, 'artifactSpellOrNonSpell');
		assert.equal(st1.restrictedManaEntries[0].total, 2);
		assert.deepEqual(st1.restrictedManaEntries[0].colors, [{ color: 'C', amount: 2 }]);
		assert.equal(st1.commanderDamageEntries.length, 1);
		assert.equal(st1.commanderDamageEntries[0].shortName, 'Valken');
		assert.equal(st1.commanderDamageEntries[0].damage, 14);
		assert.deepEqual(
			st1.turnShieldBadges.map((b) => b.label),
			['Protection', "Can't Lose", 'Life Locked', 'Prevent 5', 'Fog Shield']
		);
	});

	it('precomputes hand, graveyard, and exile playability plus waitingOnPlayerIds', () => {
		const { state, p1, p2 } = createTestBoard();
		p1.manaPool = { W: 2, U: 2, B: 0, R: 0, G: 0, C: 2 };

		const landCard = putInZone(
			state,
			p1,
			synthCard({
				name: 'Sunlit Meadow',
				typeLine: 'Basic Land — Plains',
				manaCost: '',
				cmc: 0,
				oracleText: '({T}: Add {W}.)'
			}),
			'hand'
		);

		const castableSpell = putInZone(
			state,
			p1,
			synthCard({
				name: 'Arcane Insight',
				typeLine: 'Instant',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				colorIdentity: ['U'],
				oracleText: 'Draw a card.'
			}),
			'hand'
		);

		const uncastableSpell = putInZone(
			state,
			p1,
			synthCard({
				name: 'Abyssal Decree',
				typeLine: 'Sorcery',
				manaCost: '{4}{B}{B}',
				cmc: 6,
				colors: ['B'],
				colorIdentity: ['B'],
				oracleText: 'Draw two cards.'
			}),
			'hand'
		);

		const gySpell = putInZone(
			state,
			p1,
			synthCard({
				name: 'Echoing Wisdom',
				typeLine: 'Instant',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				colorIdentity: ['U'],
				oracleText: 'Draw a card.\nFlashback {1}{U}'
			}),
			'graveyard'
		);

		const exileImpulse = putInZone(
			state,
			p1,
			synthCard({
				name: 'Glimpse Spark',
				typeLine: 'Sorcery',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				colorIdentity: ['W'],
				oracleText: 'Gain 3 life.'
			}),
			'exile'
		);
		exileImpulse.playableFromExileBy = {
			playerId: p1.playerId,
			spendManaAsAnyColor: false,
			sourceName: 'Test Effect',
			duration: 'thisTurn'
		};

		const vm = buildBoardViewModel(state, p1.playerId);
		assert.equal(vm.handPlayabilityById[landCard.instanceId].canPlayLand, true);
		assert.equal(vm.handPlayabilityById[landCard.instanceId].playable, true);
		assert.equal(vm.handPlayabilityById[castableSpell.instanceId].playable, true);
		assert.equal(vm.handPlayabilityById[uncastableSpell.instanceId].playable, false);
		assert.deepEqual(vm.playableGraveyardIds, [gySpell.instanceId]);
		assert.deepEqual(vm.playableExileIds, [exileImpulse.instanceId]);
		assert.equal(vm.waitingOnPlayerIds.length, 0);

		// Add a pending prompt for opponent p2 while viewer p1 has none:
		state.pendingPrompts = [
			{
				id: 'pr_opp_1',
				playerId: p2.playerId,
				kind: 'scry_choice',
				title: 'Scry 1',
				description: 'Scry 1'
			}
		];
		const vmWaiting = buildBoardViewModel(state, p1.playerId);
		assert.deepEqual(vmWaiting.waitingOnPlayerIds, [p2.playerId]);

		// Hand sorting check:
		const sortedByCmc = sortHandCards(p1.hand, 'cmc', 'asc');
		assert.deepEqual(
			sortedByCmc.map((c) => c.instanceId),
			[landCard.instanceId, castableSpell.instanceId, uncastableSpell.instanceId]
		);
	});

	it('memoizes BoardViewModel on unchanged state and keeps computeArrowSignature idle-mouse invariant', () => {
		const { state, p1 } = createTestBoard();
		const vmA = buildBoardViewModel(state, p1.playerId);
		const vmB = buildBoardViewModel(state, p1.playerId);
		assert.equal(vmA, vmB);

		p1.energyCounters = 2;
		const vmC = buildBoardViewModel(state, p1.playerId);
		assert.notEqual(vmA, vmC);
		assert.equal(vmC.playerStatusesById[p1.playerId].energyCounters, 2);

		const sigIdle1 = computeArrowSignature({
			gameState: state,
			mousePos: { x: 120, y: 240 },
			viewportWidth: 1440,
			viewportHeight: 900
		});
		const sigIdle2 = computeArrowSignature({
			gameState: state,
			mousePos: { x: 680, y: 510 },
			viewportWidth: 1440,
			viewportHeight: 900
		});
		assert.equal(sigIdle1, sigIdle2);

		const sigTargeting1 = computeArrowSignature({
			gameState: state,
			pendingTarget: {
				instanceId: 'card_1',
				targetKind: 'creature',
				selectedTargets: []
			},
			mousePos: { x: 120, y: 240 },
			viewportWidth: 1440,
			viewportHeight: 900
		});
		const sigTargeting2 = computeArrowSignature({
			gameState: state,
			pendingTarget: {
				instanceId: 'card_1',
				targetKind: 'creature',
				selectedTargets: []
			},
			mousePos: { x: 680, y: 510 },
			viewportWidth: 1440,
			viewportHeight: 900
		});
		assert.notEqual(sigTargeting1, sigTargeting2);
	});
});
