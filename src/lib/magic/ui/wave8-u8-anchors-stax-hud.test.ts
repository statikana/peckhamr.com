import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
	classifyCounterBadge,
	extractCounterBadges,
	formatPermanentChosenDescriptor
} from './boardViewModel.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `u8_synth_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: 'https://example.invalid/card.jpg',
		artCropUrl: 'https://example.invalid/crop.jpg',
		rarity: 'rare',
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
		'U8TEST',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		const res = applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		assert.equal(res.ok, true, res.error ?? '');
	}
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.library = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		p.restrictedMana = {};
		p.landsPlayedThisTurn = 0;
		p.maxLandsPerTurn = 1;
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
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	inst.summoningSick = false;
	player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

describe('Wave 8 Track U8: Arbitrary PT/Keyword Counters, ETB Anchors, Source-Linked Freeze/Combat, & Stax HUD', () => {
	describe('U8.1 Arbitrary ±M/±N (CR 122.1a) & Keyword Ability (CR 122.1b) Counter Badges', () => {
		it('classifies arbitrary ±M/±N counters with cumulative signed P/T deltas and plus/minus tones', () => {
			const plusTwo = classifyCounterBadge('+2/+2', 2);
			assert.equal(plusTwo.badgeKind, 'plus');
			assert.equal(plusTwo.shortLabel, '+4/+4');
			assert.equal(plusTwo.label, '+4/+4 (2×+2/+2)');
			assert.equal(plusTwo.powerDelta, 4);
			assert.equal(plusTwo.toughnessDelta, 4);
			assert.match(plusTwo.description, /CR 122\.1a/);

			const asymPlus = classifyCounterBadge('+1/+0', 3);
			assert.equal(asymPlus.badgeKind, 'plus');
			assert.equal(asymPlus.shortLabel, '+3/+0');
			assert.equal(asymPlus.powerDelta, 3);
			assert.equal(asymPlus.toughnessDelta, 0);

			const asymMinusZero = classifyCounterBadge('-0/-1', 2);
			assert.equal(asymMinusZero.badgeKind, 'minus');
			assert.equal(asymMinusZero.shortLabel, '-0/-2');
			assert.equal(asymMinusZero.powerDelta, 0);
			assert.equal(asymMinusZero.toughnessDelta, -2);

			const minusTwoSingle = classifyCounterBadge('-2/-2', 1);
			assert.equal(minusTwoSingle.badgeKind, 'minus');
			assert.equal(minusTwoSingle.shortLabel, '-2/-2');
			assert.equal(minusTwoSingle.label, '-2/-2');

			const mixedPositive = classifyCounterBadge('+2/-1', 2);
			assert.equal(mixedPositive.badgeKind, 'plus');
			assert.equal(mixedPositive.shortLabel, '+4/-2');
		});

		it('classifies CR 122.1b keyword ability counters via KEYWORD_LABELS and orders all 5 counter tiers deterministically', () => {
			const flyOne = classifyCounterBadge('flying', 1);
			assert.equal(flyOne.badgeKind, 'keyword');
			assert.equal(flyOne.shortLabel, 'Flying');
			assert.equal(flyOne.label, 'Flying');
			assert.match(flyOne.description, /grants Flying, CR 122\.1b/);

			const fsTwo = classifyCounterBadge('first strike', 2);
			assert.equal(fsTwo.badgeKind, 'keyword');
			assert.equal(fsTwo.shortLabel, 'First strike ×2');

			for (const kw of ['lifelink', 'hexproof', 'shadow', 'exalted', 'decayed']) {
				const badge = classifyCounterBadge(kw, 1);
				assert.equal(badge.badgeKind, 'keyword', `Expected '${kw}' counter to classify as keyword`);
			}

			const ordered = extractCounterBadges({
				spore: 3,
				flying: 1,
				stun: 1,
				'+2/+2': 2,
				'-0/-1': 2,
				'+1/+1': 1,
				'-1/-1': 1,
				shadow: 2
			});
			assert.deepEqual(
				ordered.map((b) => [b.type, b.badgeKind, b.shortLabel]),
				[
					['+1/+1', 'plus', '+1'],
					['-1/-1', 'minus', '-1'],
					['+2/+2', 'plus', '+4/+4'],
					['-0/-1', 'minus', '-0/-2'],
					['stun', 'stun', 'Stun:1'],
					['flying', 'keyword', 'Flying'],
					['shadow', 'keyword', 'Shadow ×2'],
					['spore', 'other', 'spore:3']
				]
			);

			// End-to-end BoardViewModel projection with Layer 7c + Layer 6 counter effects
			const { state, p1 } = createTestBoard();
			const creature = putInZone(
				state,
				p1,
				synthCard({
					name: 'MutagenicDrifter',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Mutant',
					power: '2',
					toughness: '2',
					colors: ['G'],
					colorIdentity: ['G']
				}),
				'battlefield'
			);
			creature.counters['+2/+2'] = 2;
			creature.counters['-0/-1'] = 1;
			creature.counters.flying = 1;
			creature.counters.shadow = 1;
			noteLayerInputsChanged(state);

			const vm = buildBoardViewModel(state, p1.playerId);
			const pv = vm.permanentsById[creature.instanceId];
			assert.equal(pv.power, 6);
			assert.equal(pv.toughness, 5);
			assert.deepEqual(
				pv.countersList.map((c) => [c.type, c.badgeKind, c.shortLabel]),
				[
					['+2/+2', 'plus', '+4/+4'],
					['-0/-1', 'minus', '-0/-1'],
					['flying', 'keyword', 'Flying'],
					['shadow', 'keyword', 'Shadow']
				]
			);
		});
	});

	describe('U8.2 CR 614.12 ETB Anchor Descriptors (chosenPlayerId, chosenParity)', () => {
		it('formats chosenPlayerId (resolved username + raw fallback) and chosenParity, and hides when face-down', () => {
			const { state, p1, p2 } = createTestBoard();

			const playerAnchor = putInZone(
				state,
				p1,
				synthCard({
					name: 'HeraldOfVendetta',
					manaCost: '{2}{B}',
					cmc: 3,
					typeLine: 'Creature — Specter',
					oracleText: 'As ~ enters, choose an opponent.',
					power: '2',
					toughness: '2',
					colors: ['B'],
					colorIdentity: ['B']
				}),
				'battlefield'
			);
			playerAnchor.chosenPlayerId = p2.playerId;

			const parityAnchor = putInZone(
				state,
				p1,
				synthCard({
					name: 'ScaleOfParity',
					manaCost: '{3}',
					cmc: 3,
					typeLine: 'Artifact',
					oracleText: 'As ~ enters, choose odd or even.'
				}),
				'battlefield'
			);
			parityAnchor.chosenParity = 'odd';

			const multiAnchor = putInZone(
				state,
				p1,
				synthCard({
					name: 'OmniAnchorObelisk',
					manaCost: '{4}',
					cmc: 4,
					typeLine: 'Artifact'
				}),
				'battlefield'
			);
			multiAnchor.chosenSubType = 'Elf';
			multiAnchor.chosenColor = 'G';
			multiAnchor.chosenPlayerId = p2.playerId;
			multiAnchor.chosenParity = 'even';

			noteLayerInputsChanged(state);

			const vm = buildBoardViewModel(state, p1.playerId);
			assert.equal(vm.permanentsById[playerAnchor.instanceId].chosenDescriptor, `Player: ${p2.username}`);
			assert.equal(vm.permanentsById[parityAnchor.instanceId].chosenDescriptor, 'Parity: Odd');
			assert.equal(
				vm.permanentsById[multiAnchor.instanceId].chosenDescriptor,
				`Elf • Green • Player: ${p2.username} • Parity: Even`
			);

			// Unknown player ID graceful fallback
			playerAnchor.chosenPlayerId = 'missing_seat_99';
			assert.equal(
				formatPermanentChosenDescriptor(playerAnchor, state.players),
				'Player: missing_seat_99'
			);

			// Face-down permanents hide chosen descriptors (CR 708)
			multiAnchor.isFaceDown = true;
			noteLayerInputsChanged(state);
			const vmFaceDown = buildBoardViewModel(state, p1.playerId);
			assert.equal(vmFaceDown.permanentsById[multiAnchor.instanceId].chosenDescriptor, null);
		});
	});

	describe('U8.3 Source-Linked Freeze (doesntUntapWhileSource), Assimilation, & Turn Combat Flags (P16a)', () => {
		it('projects isFrozen + frozenBySourceNames for active P16a source conditions and clears when source untaps or leaves', () => {
			const { state, p1, p2 } = createTestBoard();

			const tapperSource = putInZone(
				state,
				p1,
				synthCard({
					name: 'RimebindSentinel',
					manaCost: '{1}{U}',
					cmc: 2,
					typeLine: 'Creature — Merfolk Wizard',
					power: '1',
					toughness: '3',
					colors: ['U'],
					colorIdentity: ['U']
				}),
				'battlefield'
			);
			tapperSource.tapped = true;

			const controlSource = putInZone(
				state,
				p1,
				synthCard({
					name: 'StaticJailer',
					manaCost: '{2}{W}',
					cmc: 3,
					typeLine: 'Creature — Kor Soldier',
					power: '2',
					toughness: '2',
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);

			const lockedVictim = putInZone(
				state,
				p2,
				synthCard({
					name: 'IronbarkBehemoth',
					manaCost: '{4}{G}',
					cmc: 5,
					typeLine: 'Creature — Beast',
					power: '5',
					toughness: '5',
					colors: ['G'],
					colorIdentity: ['G']
				}),
				'battlefield'
			);
			lockedVictim.tapped = true;
			lockedVictim.doesntUntapWhileSource = [
				{
					sourceInstanceId: tapperSource.instanceId,
					sourceObjectVersion: tapperSource.objectVersion ?? 1,
					kind: 'remainsTapped',
					controllerId: p1.playerId
				},
				{
					sourceInstanceId: controlSource.instanceId,
					sourceObjectVersion: controlSource.objectVersion ?? 1,
					kind: 'controlledByPlayer',
					controllerId: p1.playerId
				}
			];
			noteLayerInputsChanged(state);

			const vmBoth = buildBoardViewModel(state, p1.playerId);
			const victimBoth = vmBoth.permanentsById[lockedVictim.instanceId];
			assert.equal(victimBoth.isFrozen, true);
			assert.deepEqual(victimBoth.frozenBySourceNames, ['RimebindSentinel', 'StaticJailer']);

			// Untap tapperSource -> 'remainsTapped' condition breaks; 'controlledByPlayer' remains active
			tapperSource.tapped = false;
			const vmAfterUntap = buildBoardViewModel(state, p1.playerId);
			assert.equal(vmAfterUntap.permanentsById[lockedVictim.instanceId].isFrozen, true);
			assert.deepEqual(vmAfterUntap.permanentsById[lockedVictim.instanceId].frozenBySourceNames, [
				'StaticJailer'
			]);

			// Change controlSource controller -> 'controlledByPlayer' breaks; victim is no longer frozen
			controlSource.controllerId = p2.playerId;
			noteLayerInputsChanged(state);
			const vmAfterControlChange = buildBoardViewModel(state, p1.playerId);
			assert.equal(vmAfterControlChange.permanentsById[lockedVictim.instanceId].isFrozen, false);
			assert.deepEqual(
				vmAfterControlChange.permanentsById[lockedVictim.instanceId].frozenBySourceNames,
				[]
			);
		});

		it('projects assimilatedBySourceName (version-checked) and turn-scoped combat requirements/restrictions', () => {
			const { state, p1, p2 } = createTestBoard();

			const assimilator = putInZone(
				state,
				p1,
				synthCard({
					name: 'SynapseAssimilator',
					manaCost: '{3}{U}',
					cmc: 4,
					typeLine: 'Artifact Creature — Construct',
					power: '3',
					toughness: '4',
					colors: ['U'],
					colorIdentity: ['U']
				}),
				'battlefield'
			);

			const oppAttacker = putInZone(
				state,
				p2,
				synthCard({
					name: 'CinderRaider',
					manaCost: '{1}{R}',
					cmc: 2,
					typeLine: 'Creature — Goblin Warrior',
					power: '2',
					toughness: '2',
					colors: ['R'],
					colorIdentity: ['R']
				}),
				'battlefield'
			);

			const brawler = putInZone(
				state,
				p1,
				synthCard({
					name: 'FrenziedVanguard',
					manaCost: '{2}{R}',
					cmc: 3,
					typeLine: 'Creature — Berserker',
					power: '4',
					toughness: '3',
					colors: ['R'],
					colorIdentity: ['R']
				}),
				'battlefield'
			);
			brawler.assimilatedBy = {
				sourceInstanceId: assimilator.instanceId,
				sourceObjectVersion: assimilator.objectVersion ?? 1
			};
			brawler.mustAttackThisTurn = true;
			brawler.mustBlockThisTurn = true;
			brawler.mustBeBlockedThisTurn = true;
			brawler.assignsNoCombatDamageThisTurn = true;
			brawler.cantBlockAttackerIdsThisTurn = [oppAttacker.instanceId];

			const vm = buildBoardViewModel(state, p1.playerId);
			const pv = vm.permanentsById[brawler.instanceId];
			assert.equal(pv.assimilatedBySourceName, 'SynapseAssimilator');
			assert.equal(pv.mustAttackThisTurn, true);
			assert.equal(pv.mustBlockThisTurn, true);
			assert.equal(pv.mustBeBlockedThisTurn, true);
			assert.equal(pv.assignsNoCombatDamageThisTurn, true);
			assert.equal(pv.cantBlockAttackerCount, 1);
			assert.deepEqual(pv.cantBlockAttackerNames, ['CinderRaider']);

			// Bumping assimilator's objectVersion invalidates the CR 400.7 link
			assimilator.objectVersion = (assimilator.objectVersion ?? 1) + 1;
			const vmStale = buildBoardViewModel(state, p1.playerId);
			assert.equal(vmStale.permanentsById[brawler.instanceId].assimilatedBySourceName, null);
		});
	});

	describe('U8.4 Monarch, Attack Tax, Static Shields, Mana Retention, & Stax Rule-Lock Telemetry (P17a / P20a)', () => {
		it('surfaces Monarch, stacked fixed + dynamic + colored attack taxes, and silences taxes under Layer 6 ability removal', () => {
			const { state, p1, p2 } = createTestBoard();
			state.monarchPlayerId = p2.playerId;

			const fixedWard = putInZone(
				state,
				p2,
				synthCard({
					name: 'alabaster_bastion',
					manaCost: '{2}{W}',
					cmc: 3,
					typeLine: 'Enchantment',
					oracleText:
						"Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.",
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);

			const dynamicWard = putInZone(
				state,
				p2,
				synthCard({
					name: 'sanctum_sphere',
					manaCost: '{4}{W}',
					cmc: 5,
					typeLine: 'Enchantment',
					oracleText:
						"Creatures can't attack you or planeswalkers you control unless their controller pays {X} for each creature they control that's attacking you, where X is the number of enchantments you control.",
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);

			const coloredWard = putInZone(
				state,
				p2,
				synthCard({
					name: 'tithe_sentinel',
					manaCost: '{1}{W}{W}',
					cmc: 3,
					typeLine: 'Creature — Archon',
					oracleText:
						"Creatures can't attack you unless their controller pays {W} for each creature they control that's attacking you.",
					power: '2',
					toughness: '3',
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);

			const vm = buildBoardViewModel(state, p1.playerId);
			assert.equal(vm.monarchPlayerId, p2.playerId);
			assert.equal(vm.playerStatusesById[p1.playerId].isMonarch, false);
			assert.equal(vm.playerStatusesById[p2.playerId].isMonarch, true);

			// p2 controls 2 enchantments + fixed {2} + colored {W} => {4}{W} per attacker
			assert.equal(vm.playerStatusesById[p1.playerId].attackTaxPerCreature, null);
			assert.equal(vm.playerStatusesById[p2.playerId].attackTaxPerCreature, '{4}{W}');
			assert.equal(vm.playerStatusesById[p2.playerId].attackTaxSources.length, 3);

			// Layer 6 removeAllAbilities silences all three attack tax sources
			state.nextTimestamp = (state.nextTimestamp || 0) + 1;
			state.timedContinuousEffects = [
				{
					sourceName: 'Nullifying Mist',
					controllerId: p1.playerId,
					timestamp: state.nextTimestamp,
					affected: [
						{ instanceId: fixedWard.instanceId },
						{ instanceId: dynamicWard.instanceId },
						{ instanceId: coloredWard.instanceId }
					],
					expires: 'endOfTurn',
					layer6: { removeAllAbilities: true }
				}
			];
			noteLayerInputsChanged(state);

			const vmSilenced = buildBoardViewModel(state, p1.playerId);
			assert.equal(vmSilenced.playerStatusesById[p2.playerId].attackTaxPerCreature, null);
		});

		it('surfaces static cantLose, dontLoseAtZeroOrLessLife, mana retention, spell-per-turn caps, and parity cast locks', () => {
			const { state, p1, p2 } = createTestBoard();

			// p1 controls static cantLose + green mana retention
			putInZone(
				state,
				p1,
				synthCard({
					name: 'AegisSeraph',
					manaCost: '{7}',
					cmc: 7,
					typeLine: 'Artifact Creature — Angel',
					oracleText: "You can't lose the game and your opponents can't win the game.",
					power: '4',
					toughness: '4'
				}),
				'battlefield'
			);
			putInZone(
				state,
				p1,
				synthCard({
					name: 'EmeraldReservoir',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Enchantment',
					oracleText: "You don't lose unspent green mana as steps and phases end.",
					colors: ['G'],
					colorIdentity: ['G']
				}),
				'battlefield'
			);

			// p2 controls dontLoseAtZeroOrLessLife + global 1-noncreature-spell cap + opponent even-MV lock + chosen-parity lock
			putInZone(
				state,
				p2,
				synthCard({
					name: 'UnlifePact',
					manaCost: '{2}{W}',
					cmc: 3,
					typeLine: 'Enchantment',
					oracleText: "You don't lose the game for having 0 or less life.",
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);
			putInZone(
				state,
				p2,
				synthCard({
					name: 'ChantOfStillness',
					manaCost: '{W}',
					cmc: 1,
					typeLine: 'Enchantment',
					oracleText: "Each player can't cast more than one noncreature spell each turn.",
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);
			putInZone(
				state,
				p2,
				synthCard({
					name: 'NullstoneColossus',
					manaCost: '{9}',
					cmc: 9,
					typeLine: 'Creature — Construct',
					oracleText: "Your opponents can't cast spells with even mana value.",
					power: '11',
					toughness: '9'
				}),
				'battlefield'
			);
			const chosenParityStax = putInZone(
				state,
				p2,
				synthCard({
					name: 'ParityMagistrate',
					manaCost: '{3}{W}',
					cmc: 4,
					typeLine: 'Creature — Advisor',
					oracleText:
						"As ~ enters, choose odd or even.\nPlayers can't cast spells with mana value of the chosen quality.",
					power: '2',
					toughness: '4',
					colors: ['W'],
					colorIdentity: ['W']
				}),
				'battlefield'
			);
			chosenParityStax.chosenParity = 'odd';
			noteLayerInputsChanged(state);

			const vm = buildBoardViewModel(state, p1.playerId);
			const st1 = vm.playerStatusesById[p1.playerId];
			const st2 = vm.playerStatusesById[p2.playerId];

			assert.equal(st1.staticCannotLoseGame, true);
			assert.equal(st1.dontLoseAtZeroOrLessLife, false);
			assert.equal(st1.unspentManaRetentionLabel, 'Retains {G}');
			assert.ok(st1.turnShieldBadges.some((b) => b.label === "Can't Lose"));

			assert.equal(st2.staticCannotLoseGame, false);
			assert.equal(st2.dontLoseAtZeroOrLessLife, true);
			assert.ok(st2.turnShieldBadges.some((b) => b.label === '≤0 Life Safe'));

			// p1 is subject to noncreature cap + opponent even-MV lock + global chosen-odd-MV lock
			const p1LockLabels = st1.activeRuleLocks.map((l) => l.label);
			assert.ok(p1LockLabels.includes("Can't Lose"));
			assert.ok(p1LockLabels.includes('Retains {G}'));
			assert.ok(p1LockLabels.includes('Max 1 Noncreature/Turn'));
			assert.ok(p1LockLabels.includes('No Even MV Spells'));
			assert.ok(p1LockLabels.includes('No Odd MV Spells'));

			// p2 controls NullstoneColossus so p2 is NOT subject to 'No Even MV Spells', but IS subject to global caps/locks
			const p2LockLabels = st2.activeRuleLocks.map((l) => l.label);
			assert.ok(p2LockLabels.includes('≤0 Life Safe'));
			assert.ok(p2LockLabels.includes('Max 1 Noncreature/Turn'));
			assert.equal(p2LockLabels.includes('No Even MV Spells'), false);
			assert.ok(p2LockLabels.includes('No Odd MV Spells'));

			// Global HUD locks deduplicate shared global stax sources cleanly
			const globalLabels = vm.globalRuleLocks.map((l) => l.label);
			assert.equal(
				globalLabels.filter((l) => l === 'Max 1 Noncreature/Turn').length,
				1,
				'Expected shared global rule lock to appear once in vm.globalRuleLocks'
			);
			assert.ok(globalLabels.includes('No Even MV Spells'));
			assert.ok(globalLabels.includes('No Odd MV Spells'));
		});
	});

	describe('U8.5 WeakMap Cache Invalidation & UI Source-Scan Guard', () => {
		it('invalidates the WeakMap BoardViewModel cache across every Wave 8 U8 state field mutation', () => {
			const { state, p1, p2 } = createTestBoard();
			const src = putInZone(
				state,
				p1,
				synthCard({
					name: 'CacheSource',
					typeLine: 'Creature — Construct',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const target = putInZone(
				state,
				p1,
				synthCard({
					name: 'CacheSubject',
					typeLine: 'Creature — Construct',
					power: '3',
					toughness: '3'
				}),
				'battlefield'
			);

			let prev = buildBoardViewModel(state, p1.playerId);
			assert.equal(buildBoardViewModel(state, p1.playerId), prev);

			const assertInvalidates = (mutate: () => void, label: string) => {
				mutate();
				const next = buildBoardViewModel(state, p1.playerId);
				assert.notEqual(next, prev, `Expected WeakMap cache invalidation after mutating ${label}`);
				prev = next;
			};

			assertInvalidates(() => {
				target.chosenPlayerId = p2.playerId;
			}, 'chosenPlayerId');
			assertInvalidates(() => {
				target.chosenParity = 'even';
			}, 'chosenParity');
			assertInvalidates(() => {
				target.counters['+2/+2'] = 1;
				noteLayerInputsChanged(state);
			}, 'arbitrary +2/+2 counter');
			assertInvalidates(() => {
				target.counters.flying = 1;
				noteLayerInputsChanged(state);
			}, 'keyword counter');
			assertInvalidates(() => {
				src.tapped = true;
				target.doesntUntapWhileSource = [
					{
						sourceInstanceId: src.instanceId,
						sourceObjectVersion: src.objectVersion ?? 1,
						kind: 'remainsTapped',
						controllerId: p1.playerId
					}
				];
			}, 'doesntUntapWhileSource');
			assertInvalidates(() => {
				src.tapped = false;
			}, 'doesntUntapWhileSource source untap');
			assertInvalidates(() => {
				target.assimilatedBy = {
					sourceInstanceId: src.instanceId,
					sourceObjectVersion: src.objectVersion ?? 1
				};
			}, 'assimilatedBy');
			assertInvalidates(() => {
				target.assignsNoCombatDamageThisTurn = true;
			}, 'assignsNoCombatDamageThisTurn');
			assertInvalidates(() => {
				target.mustAttackThisTurn = true;
			}, 'mustAttackThisTurn');
			assertInvalidates(() => {
				target.mustBlockThisTurn = true;
			}, 'mustBlockThisTurn');
			assertInvalidates(() => {
				target.mustBeBlockedThisTurn = true;
			}, 'mustBeBlockedThisTurn');
			assertInvalidates(() => {
				target.cantBlockAttackerIdsThisTurn = [src.instanceId];
			}, 'cantBlockAttackerIdsThisTurn');
			assertInvalidates(() => {
				p1.unemptiedManaColorsThisTurn = 'all';
			}, 'unemptiedManaColorsThisTurn');
			assertInvalidates(() => {
				state.monarchPlayerId = p1.playerId;
			}, 'monarchPlayerId');
		});

		it('keeps ArenaTable and owned UI files free of oracleText reads and forbidden keyword string literals', () => {
			const rootDir = path.resolve(import.meta.dirname, '..');
			const filesToScan = [
				path.join(rootDir, 'ArenaTable.svelte'),
				path.join(rootDir, 'ui', 'boardViewModel.ts'),
				path.join(rootDir, 'ui', 'PermanentCard.svelte'),
				path.join(rootDir, 'ui', 'CardInspector.svelte'),
				path.join(rootDir, 'ui', 'PlayerVitals.svelte'),
				path.join(rootDir, 'ui', 'OpponentPod.svelte'),
				path.join(rootDir, 'ui', 'HudBar.svelte')
			];

			const forbiddenQuotedKeywords = [
				'companion',
				'prototype',
				'regenerate',
				'monstrosity',
				'flagbearer',
				'soulbond',
				'haunt',
				'mutate',
				'escalate',
				'spree',
				'tiered',
				'renown',
				'epic',
				'storied',
				'suspect',
				'goad',
				'flying',
				'first strike',
				'double strike',
				'deathtouch',
				'lifelink',
				'menace',
				'trample',
				'vigilance',
				'reach',
				'hexproof',
				'indestructible',
				'shadow',
				'exalted',
				'decayed'
			];

			for (const filePath of filesToScan) {
				const src = fs.readFileSync(filePath, 'utf8');
				assert.equal(
					/\.oracleText\b/.test(src),
					false,
					`Expected zero .oracleText reads in ${path.basename(filePath)}`
				);
				const lower = src.toLowerCase();
				for (const kw of forbiddenQuotedKeywords) {
					assert.equal(
						lower.includes(`'${kw}'`) || lower.includes(`"${kw}"`),
						false,
						`Expected zero hardcoded '${kw}' string literals in ${path.basename(filePath)}`
					);
				}
			}
		});
	});
});
