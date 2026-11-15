import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileCard, describeModalModes } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getCastOptions,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import type { ModalDef } from '../ir.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';
import {
	buildBoardViewModel,
	extractModalModeCostView,
	resolveExileHauntingTargetName
} from './boardViewModel.ts';

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_u6_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_u6_${synthSeq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Beast',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? (overrides.typeLine?.includes('Creature') ? '2' : undefined),
		toughness:
			overrides.toughness ?? (overrides.typeLine?.includes('Creature') ? '2' : undefined),
		loyalty: overrides.loyalty,
		defense: overrides.defense,
		imageUrl: overrides.imageUrl ?? '',
		artCropUrl: overrides.artCropUrl ?? '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(id: string, cards: ScryfallCard[], commanders: ScryfallCard[] = []): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id,
		userId: id,
		name: id,
		description: '',
		commanders,
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + commanders.length,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupArenaState(opts: { threePlayer?: boolean } = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Sunlit Meadow',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(
		'd1',
		Array.from({ length: 30 }, () => filler)
	);
	const d2 = makeDeck(
		'd2',
		Array.from({ length: 30 }, () => filler)
	);
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d1.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: false,
			deckId: d2.id,
			deckName: d2.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d2.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const decks = new Map<number, MagicDeck>([
		[0, d1],
		[1, d2]
	]);
	if (opts.threePlayer) {
		const d3 = makeDeck(
			'd3',
			Array.from({ length: 30 }, () => filler)
		);
		seats.push({
			seatIndex: 2,
			userId: 'p3',
			username: 'Charlie',
			avatarUrl: '',
			isBot: false,
			deckId: d3.id,
			deckName: d3.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d3.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
		decks.set(2, d3);
	}
	const state = createInitialGameState('U6_TEST', seats, decks, DEFAULT_LOBBY_RULES);
	for (let i = 0; i < state.players.length; i++) {
		const p = state.players[i]!;
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (let i = 0; i < state.players.length; i++) {
		const p = state.players[i]!;
		p.hasKeptHand = true;
		p.hand = [];
	}
	return {
		state,
		p1: state.players[0]!,
		p2: state.players[1]!,
		p3: state.players[2]
	};
}

function giveMana(player: PlayerGameState, amounts: Partial<Record<ManaColor, number>>): void {
	for (const [col, amt] of Object.entries(amounts)) {
		const c = col as ManaColor;
		player.manaPool[c] = (player.manaPool[c] ?? 0) + (amt ?? 0);
	}
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
	}
	player[zone].push(inst);
	return inst;
}

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 50; guard++) {
		if (
			state.pendingPrompts.length > 0 &&
			state.pendingPrompts[0]!.purpose === 'trigger_order'
		) {
			const prm = state.pendingPrompts[0]!;
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
			});
			assert.equal(res.ok, true, res.error ?? '');
			continue;
		}
		if (state.pendingPrompts.length > 0) return;
		if (state.stack.length === 0) return;
		const prioPlayer = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function answerPrompt(state: GameState, answer: ChoiceAnswer): void {
	assert.ok(state.pendingPrompts.length > 0, 'Expected pending prompt');
	const prm = state.pendingPrompts[0]!;
	const res = applyGameAction(state, prm.playerId, {
		type: 'choice',
		promptId: prm.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? '');
}

describe('UI Track U6 — Wave 4–6 Frames, Merged/Melded/Flipped Permanents, & Status/Player Chrome', () => {
	describe('1. Class (CR 717) & Case (CR 720) Enchantment Frames', () => {
		it('surfaces Class level progression (Lv. 1 -> Lv. 2 -> Lv. 3) via engine actions and hides on non-Class / face-down permanents', () => {
			const { state, p1 } = setupArenaState();
			const valorClass = synthCard({
				name: 'Valor Class',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment — Class',
				oracleText:
					'Creatures you control get +1/+0.\n{1}{W}: Level 2\nCreatures you control have vigilance.\n{2}{W}: Level 3\nCreatures you control have double strike.'
			});
			const handClass = putInZone(state, p1, valorClass, 'hand');
			const bear = putInZone(
				state,
				p1,
				synthCard({
					name: 'Field Cadet',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human Soldier',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);

			giveMana(p1, { W: 10 });
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: handClass.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			const clsPerm = p1.battlefield.find((b) => b.card.id === valorClass.id)!;
			assert.ok(clsPerm);

			const vm1 = buildBoardViewModel(state, 'p1');
			assert.equal(vm1.permanentsById[clsPerm.instanceId]?.classLevel, 1);
			assert.equal(vm1.permanentsById[clsPerm.instanceId]?.caseSolved, null);
			assert.equal(vm1.permanentsById[bear.instanceId]?.classLevel, null);

			// Activate Level 2
			const abs1 = getEffectiveActivatedAbilities(state, p1, clsPerm, ['W']);
			const lvl2Ab = abs1.find((a) => a.label.includes('Level 2'))!;
			assert.ok(lvl2Ab, 'Expected Level 2 activated ability');
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: clsPerm.instanceId,
					abilityId: lvl2Ab.id
				}).ok,
				true
			);
			resolveAllStack(state);

			const vm2 = buildBoardViewModel(state, 'p1');
			assert.equal(vm2.permanentsById[clsPerm.instanceId]?.classLevel, 2);

			// Activate Level 3
			const abs2 = getEffectiveActivatedAbilities(state, p1, clsPerm, ['W']);
			const lvl3Ab = abs2.find((a) => a.label.includes('Level 3'))!;
			assert.ok(lvl3Ab, 'Expected Level 3 activated ability');
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: clsPerm.instanceId,
					abilityId: lvl3Ab.id
				}).ok,
				true
			);
			resolveAllStack(state);

			const vm3 = buildBoardViewModel(state, 'p1');
			assert.equal(vm3.permanentsById[clsPerm.instanceId]?.classLevel, 3);
			assert.equal(vm3.permanentsById[bear.instanceId]?.power, 3);

			// Face-down hides Class level
			clsPerm.isFaceDown = true;
			const vmFaceDown = buildBoardViewModel(state, 'p1');
			assert.equal(vmFaceDown.permanentsById[clsPerm.instanceId]?.classLevel, null);
		});

		it('surfaces Case Unsolved -> Solved transitions via engine end-step solve trigger (CR 720)', () => {
			const { state, p1 } = setupArenaState();
			const banquetCase = synthCard({
				name: 'Case of the Grand Banquet',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment — Case',
				oracleText:
					"Whenever a creature you control enters, you gain 5 life.\nTo solve — You've gained 5 or more life this turn.\nSolved — Creatures you control get +2/+2."
			});
			const handCase = putInZone(state, p1, banquetCase, 'hand');
			const handCreature = putInZone(
				state,
				p1,
				synthCard({
					name: 'Banquet Guest',
					manaCost: '{W}',
					cmc: 1,
					typeLine: 'Creature — Halfling',
					power: '1',
					toughness: '1'
				}),
				'hand'
			);

			giveMana(p1, { W: 4 });
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: handCase.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			const casePerm = p1.battlefield.find((b) => b.card.id === banquetCase.id)!;
			const vmUnsolved = buildBoardViewModel(state, 'p1');
			assert.equal(vmUnsolved.permanentsById[casePerm.instanceId]?.caseSolved, false);
			assert.equal(vmUnsolved.permanentsById[casePerm.instanceId]?.classLevel, null);

			// Cast creature -> gain 5 life -> advance to end step to solve Case
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: handCreature.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			for (let guard = 0; guard < 20 && state.phase !== 'end_step'; guard++) {
				const prio = state.players[state.priorityPlayerIndex]!;
				assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
				if (state.stack.length > 0) resolveAllStack(state);
			}
			resolveAllStack(state);

			const vmSolved = buildBoardViewModel(state, 'p1');
			assert.equal(vmSolved.permanentsById[casePerm.instanceId]?.caseSolved, true);
		});
	});

	describe('2. Mutate Merged Permanents (CR 731), Meld (CR 713), & Flip (CR 710)', () => {
		it('surfaces ordered top-to-bottom mergedComponentNames, mutateCount, and copy merged state (CR 731 / CR 702.140)', () => {
			const { state, p1 } = setupArenaState();
			const baseBeast = putInZone(
				state,
				p1,
				synthCard({
					name: 'Moss Cub',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					oracleText: 'Trample',
					keywords: ['Trample'],
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const mutator1 = putInZone(
				state,
				p1,
				synthCard({
					name: 'Apex Grazer',
					manaCost: '{3}{G}',
					cmc: 4,
					typeLine: 'Creature — Beast',
					oracleText: 'Mutate {1}{G}\nFlying',
					keywords: ['Flying'],
					power: '4',
					toughness: '4'
				}),
				'hand'
			);
			const mutator2 = putInZone(
				state,
				p1,
				synthCard({
					name: 'Canopy Prowler',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Cat Beast',
					oracleText: 'Mutate {1}{G}\nVigilance',
					keywords: ['Vigilance'],
					power: '3',
					toughness: '3'
				}),
				'hand'
			);

			// Unmerged initially
			const vm0 = buildBoardViewModel(state, 'p1');
			assert.deepEqual(vm0.permanentsById[baseBeast.instanceId]?.mergedComponentNames, []);
			assert.equal(vm0.permanentsById[baseBeast.instanceId]?.mutateCount, 0);

			// Mutate #1 ON TOP (choose mode 0)
			giveMana(p1, { G: 6 });
			const mutateOpt1 = getCastOptions(state, 'p1', mutator1, 'hand').find(
				(o) => o.id === 'alt:mutate'
			)!;
			assert.ok(mutateOpt1, 'Expected alt:mutate cast option');
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: mutator1.instanceId,
					optionId: mutateOpt1.id,
					targets: [{ kind: 'permanent', id: baseBeast.instanceId, label: 'Moss Cub' }]
				}).ok,
				true
			);
			resolveAllStack(state);
			answerPrompt(state, { kind: 'chooseMode', indices: [0] });
			resolveAllStack(state);

			const vm1 = buildBoardViewModel(state, 'p1');
			const pv1 = vm1.permanentsById[baseBeast.instanceId]!;
			assert.equal(pv1.displayCard.name, 'Apex Grazer');
			assert.deepEqual(pv1.mergedComponentNames, ['Apex Grazer', 'Moss Cub']);
			assert.equal(pv1.mutateCount, 1);

			// Mutate #2 UNDERNEATH (choose mode 1)
			const mutateOpt2 = getCastOptions(state, 'p1', mutator2, 'hand').find(
				(o) => o.id === 'alt:mutate'
			)!;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: mutator2.instanceId,
					optionId: mutateOpt2.id,
					targets: [{ kind: 'permanent', id: baseBeast.instanceId, label: 'Apex Grazer' }]
				}).ok,
				true
			);
			resolveAllStack(state);
			answerPrompt(state, { kind: 'chooseMode', indices: [1] });
			resolveAllStack(state);

			const vm2 = buildBoardViewModel(state, 'p1');
			const pv2 = vm2.permanentsById[baseBeast.instanceId]!;
			assert.equal(pv2.displayCard.name, 'Apex Grazer');
			assert.deepEqual(pv2.mergedComponentNames, [
				'Apex Grazer',
				'Moss Cub',
				'Canopy Prowler'
			]);
			assert.equal(pv2.mutateCount, 2);

			// Copy of a merged permanent inherits copiableState.mergedComponents with mutateCount === 0 (CR 702.140e)
			const clonePerm = putInZone(
				state,
				p1,
				synthCard({ name: 'Mirror Doppelganger', typeLine: 'Creature — Shapeshifter' }),
				'battlefield'
			);
			clonePerm.copiableState = {
				card: baseBeast.card,
				mergedComponents: [...(baseBeast.mergedComponents ?? [])]
			};
			const vmClone = buildBoardViewModel(state, 'p1');
			const pvClone = vmClone.permanentsById[clonePerm.instanceId]!;
			assert.deepEqual(pvClone.mergedComponentNames, [
				'Apex Grazer',
				'Moss Cub',
				'Canopy Prowler'
			]);
			assert.equal(pvClone.mutateCount, 0);
		});

		it('surfaces meldedComponentNames (CR 713) and isFlipped (CR 710) via both engine flip action and perm.isFlipped', () => {
			const { state, p1 } = setupArenaState();
			const partA = synthCard({
				name: 'Dusk Scavengers',
				manaCost: '{4}{B}',
				cmc: 5,
				typeLine: 'Creature — Human Rogue',
				power: '3',
				toughness: '3'
			});
			const partB = synthCard({
				name: 'Alley Rats',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Rat',
				power: '2',
				toughness: '1'
			});
			const meldedBack = synthCard({
				name: 'Skittering Host',
				manaCost: '',
				cmc: 0,
				layout: 'meld',
				typeLine: 'Creature — Eldrazi Horror',
				power: '5',
				toughness: '6'
			});
			const meldedPerm = putInZone(state, p1, meldedBack, 'battlefield');
			meldedPerm.meldedComponents = [partA, partB];

			const flipCard = synthCard({
				name: 'Novice Seer // Awakened Oracle',
				layout: 'flip',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Human Monk // Legendary Creature — Human Wizard',
				faces: [
					{
						name: 'Novice Seer',
						manaCost: '{1}{U}',
						typeLine: 'Creature — Human Monk',
						oracleText: '{0}: Flip Novice Seer.',
						colors: ['U'],
						power: '1',
						toughness: '1',
						keywords: [],
						imageUrl: ''
					},
					{
						name: 'Awakened Oracle',
						manaCost: '',
						typeLine: 'Legendary Creature — Human Wizard',
						oracleText: 'Flying',
						colors: ['U'],
						power: '4',
						toughness: '4',
						keywords: ['Flying'],
						imageUrl: ''
					}
				]
			});
			const flipPerm = putInZone(state, p1, flipCard, 'battlefield');

			const vmBefore = buildBoardViewModel(state, 'p1');
			assert.deepEqual(vmBefore.permanentsById[meldedPerm.instanceId]?.meldedComponentNames, [
				'Dusk Scavengers',
				'Alley Rats'
			]);
			assert.equal(vmBefore.permanentsById[flipPerm.instanceId]?.isFlipped, false);
			assert.equal(vmBefore.permanentsById[flipPerm.instanceId]?.displayCard.name, 'Novice Seer');

			// Flip via real engine ability activation
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: flipPerm.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			resolveAllStack(state);

			const vmAfterEngineFlip = buildBoardViewModel(state, 'p1');
			assert.equal(vmAfterEngineFlip.permanentsById[flipPerm.instanceId]?.isFlipped, true);
			assert.equal(
				vmAfterEngineFlip.permanentsById[flipPerm.instanceId]?.displayCard.name,
				'Awakened Oracle'
			);

			// Also verify explicit `perm.isFlipped = true` when activeFaceIndex is 0
			const flipPerm2 = putInZone(state, p1, flipCard, 'battlefield');
			flipPerm2.isFlipped = true;
			const vmDirectFlip = buildBoardViewModel(state, 'p1');
			assert.equal(vmDirectFlip.permanentsById[flipPerm2.instanceId]?.isFlipped, true);
			assert.equal(
				vmDirectFlip.permanentsById[flipPerm2.instanceId]?.displayCard.name,
				'Awakened Oracle'
			);
		});
	});

	describe('3. Soulbond (CR 702.95), Haunt (CR 702.55), & Permanent Status Pills', () => {
		it('surfaces Soulbond pairedWithId + pairedPartnerName for both partners and clears when partner leaves', () => {
			const { state, p1 } = setupArenaState();
			const squire = putInZone(
				state,
				p1,
				synthCard({
					name: 'Vanguard Squire',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human Soldier',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const paladinHand = putInZone(
				state,
				p1,
				synthCard({
					name: 'Silverblade Mentor',
					manaCost: '{1}{W}{W}',
					cmc: 3,
					typeLine: 'Creature — Human Knight',
					oracleText:
						'Soulbond\nAs long as ~ is paired with another creature, both creatures have double strike.',
					power: '2',
					toughness: '2'
				}),
				'hand'
			);

			giveMana(p1, { W: 4 });
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: paladinHand.instanceId }).ok,
				true
			);
			resolveAllStack(state);
			answerPrompt(state, { kind: 'chooseObjects', objectIds: [squire.instanceId] });
			resolveAllStack(state);

			const paladinPerm = p1.battlefield.find((b) => b.card.id === paladinHand.card.id)!;
			const vmPaired = buildBoardViewModel(state, 'p1');
			assert.equal(vmPaired.permanentsById[paladinPerm.instanceId]?.pairedWithId, squire.instanceId);
			assert.equal(
				vmPaired.permanentsById[paladinPerm.instanceId]?.pairedPartnerName,
				'Vanguard Squire'
			);
			assert.equal(vmPaired.permanentsById[squire.instanceId]?.pairedWithId, paladinPerm.instanceId);
			assert.equal(
				vmPaired.permanentsById[squire.instanceId]?.pairedPartnerName,
				'Silverblade Mentor'
			);

			// Destroy squire -> unpairs paladin
			const smite = putInZone(
				state,
				p1,
				synthCard({
					name: 'Final Verdict Bolt',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Destroy target creature.'
				}),
				'hand'
			);
			giveMana(p1, { B: 1 });
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: smite.instanceId,
					targets: [{ kind: 'permanent', id: squire.instanceId, label: 'Vanguard Squire' }]
				}).ok,
				true
			);
			resolveAllStack(state);

			const vmUnpaired = buildBoardViewModel(state, 'p1');
			assert.equal(vmUnpaired.permanentsById[paladinPerm.instanceId]?.pairedWithId, null);
			assert.equal(vmUnpaired.permanentsById[paladinPerm.instanceId]?.pairedPartnerName, null);
		});

		it('surfaces Haunt on both the haunted battlefield creature and the exiled haunting card (CR 702.55)', () => {
			const { state, p1, p2 } = setupArenaState();
			const victim = putInZone(
				state,
				p2,
				synthCard({
					name: 'Town Watchman',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human Soldier',
					power: '2',
					toughness: '3'
				}),
				'battlefield'
			);
			const hauntSpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Spectral Dirge',
					manaCost: '{W}{B}',
					cmc: 2,
					typeLine: 'Instant',
					oracleText:
						'Haunt\nYou gain 2 life.\nWhen the creature ~ haunts dies, you gain 2 life.'
				}),
				'hand'
			);

			giveMana(p1, { W: 1, B: 1 });
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: hauntSpell.instanceId }).ok,
				true
			);
			resolveAllStack(state);
			// Haunt target prompt when exiled from stack
			if (state.pendingPrompts.length > 0) {
				answerPrompt(state, { kind: 'chooseObjects', objectIds: [victim.instanceId] });
				resolveAllStack(state);
			}

			assert.equal(p1.exile.length, 1);
			const exiledDirge = p1.exile[0]!;
			const vm = buildBoardViewModel(state, 'p1');
			assert.deepEqual(vm.permanentsById[victim.instanceId]?.hauntedByNames, ['Spectral Dirge']);
			assert.equal(vm.exileHauntingTargetNameById[exiledDirge.instanceId], 'Town Watchman');
			assert.equal(resolveExileHauntingTargetName(state, exiledDirge), 'Town Watchman');

			// CR 400.7: if target objectVersion advances (left & returned as a new object), exile haunt link no longer matches
			victim.objectVersion = (victim.objectVersion ?? 1) + 5;
			if (exiledDirge.hauntingTargetVersion === undefined) {
				exiledDirge.hauntingTargetVersion = 1;
			}
			const vmStale = buildBoardViewModel(state, 'p1');
			assert.equal(vmStale.exileHauntingTargetNameById[exiledDirge.instanceId], undefined);
			assert.equal(resolveExileHauntingTargetName(state, exiledDirge), null);
		});

		it('surfaces isSuspected, isGoaded + goadedByNames, isHarnessed, isRenowned, and permanent hasEnduringStory', () => {
			const { state, p1, p2, p3 } = setupArenaState({ threePlayer: true });
			const rogue = putInZone(
				state,
				p1,
				synthCard({
					name: 'Alley Cutthroat',
					manaCost: '{1}{B}',
					cmc: 2,
					typeLine: 'Creature — Human Rogue',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const suspectSpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Mark of Guilt',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Sorcery',
					oracleText: 'Suspect target creature.'
				}),
				'hand'
			);

			giveMana(p1, { B: 1 });
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: suspectSpell.instanceId,
					targets: [{ kind: 'permanent', id: rogue.instanceId, label: 'Alley Cutthroat' }]
				}).ok,
				true
			);
			resolveAllStack(state);

			rogue.goadedByPlayerIds = [p2.playerId, p3!.playerId];
			rogue.isHarnessed = true;
			rogue.isRenowned = true;
			rogue.hasEnduringStory = true;

			const vm = buildBoardViewModel(state, 'p1');
			const pv = vm.permanentsById[rogue.instanceId]!;
			assert.equal(pv.isSuspected, true);
			assert.equal(pv.isGoaded, true);
			assert.deepEqual(pv.goadedByNames, ['Bob', 'Charlie']);
			assert.equal(pv.isHarnessed, true);
			assert.equal(pv.isRenowned, true);
			assert.equal(pv.hasEnduringStory, true);
		});
	});

	describe('4. Player Designations: Storied (CR 702.195) & Epic (CR 702.50)', () => {
		it('surfaces player hasEnduringStory when 3+ historic permanents are controlled with Storied (CR 702.195)', () => {
			const { state, p1 } = setupArenaState();
			const storiedSage = synthCard({
				name: 'Chronicler of Ages',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Legendary Creature — Human Advisor',
				oracleText: 'Storied',
				power: '2',
				toughness: '2'
			});
			const relic1 = synthCard({
				name: 'Ancient Astrolabe',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact',
				oracleText: ''
			});
			const relic2 = synthCard({
				name: 'Sun Sundial',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact',
				oracleText: ''
			});

			const handSage = putInZone(state, p1, storiedSage, 'hand');
			const handR1 = putInZone(state, p1, relic1, 'hand');
			const handR2 = putInZone(state, p1, relic2, 'hand');
			giveMana(p1, { W: 4 });

			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: handSage.instanceId }).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: handR1.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			assert.equal(buildBoardViewModel(state, 'p1').playerStatusesById['p1']?.hasEnduringStory, false);

			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: handR2.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			const vmAfter = buildBoardViewModel(state, 'p1');
			assert.equal(vmAfter.playerStatusesById['p1']?.hasEnduringStory, true);
		});

		it('surfaces player cannotCastSpellsForRestOfGame and epicSpellNames after resolving an Epic spell (CR 702.50)', () => {
			const { state, p1 } = setupArenaState();
			const epicSorcery = synthCard({
				name: 'Undying Dominion',
				manaCost: '{3}{G}',
				cmc: 4,
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.\nEpic'
			});
			const handEpic = putInZone(state, p1, epicSorcery, 'hand');
			giveMana(p1, { G: 4 });

			const vmBefore = buildBoardViewModel(state, 'p1');
			assert.equal(vmBefore.playerStatusesById['p1']?.cannotCastSpellsForRestOfGame, false);
			assert.deepEqual(vmBefore.playerStatusesById['p1']?.epicSpellNames, []);

			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: handEpic.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			const vmAfter = buildBoardViewModel(state, 'p2');
			const p1Status = vmAfter.playerStatusesById['p1']!;
			assert.equal(p1Status.cannotCastSpellsForRestOfGame, true);
			assert.deepEqual(p1Status.epicSpellNames, ['Undying Dominion']);
		});
	});

	describe('5. Per-Mode Additional Cost Readout (CR 700.2h Spree / Tiered / CR 702.120 Escalate)', () => {
		it('formats Spree per-mode mana and non-mana costs and sums selected mode costs', () => {
			const spreeCard = synthCard({
				name: 'Outlaw Confluence',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText:
					'Spree\n+ {2} — Draw two cards.\n+ {1}{R}, Discard a card — ~ deals 3 damage to any target.\n+ {R} — Create a Treasure token.'
			});
			const compiled = compileCard(spreeCard);
			const spellAb = compiled.faces[0]?.abilities.find((a) => a.kind === 'spell');
			assert.ok(spellAb && spellAb.kind === 'spell' && spellAb.modal);
			const modal: ModalDef = spellAb.modal;
			const labels = describeModalModes(spreeCard, modal, 0);
			assert.equal(labels.length, 3);

			const view0 = extractModalModeCostView(modal, {
				card: spreeCard,
				faceIndex: 0,
				selectedModes: []
			});
			assert.equal(view0.hasModeCosts, true);
			assert.equal(view0.escalateBadge, null);
			assert.deepEqual(view0.perModeBadges, [
				'+ {2}',
				'+ {1}{R}, Discard 1 card(s)',
				'+ {R}'
			]);
			assert.equal(view0.selectedTotalCostBadge, null);

			const viewSelected = extractModalModeCostView(modal, {
				card: spreeCard,
				faceIndex: 0,
				selectedModes: [0, 1]
			});
			assert.equal(
				viewSelected.selectedTotalCostBadge,
				'+ {2}{1}{R}, Discard 1 card(s)'
			);
		});

		it('formats Tiered per-mode costs including free + {0} tier', () => {
			const tieredCard = synthCard({
				name: 'Arcane Surge',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					'Tiered\n• Cantrip — {0} — Draw a card.\n• Study — {2} — Draw two cards.\n• Epiphany — {3}{U} — Draw three cards.'
			});
			const compiled = compileCard(tieredCard);
			const spellAb = compiled.faces[0]?.abilities.find((a) => a.kind === 'spell');
			assert.ok(spellAb && spellAb.kind === 'spell' && spellAb.modal);

			const viewTier0 = extractModalModeCostView(spellAb.modal, {
				card: tieredCard,
				faceIndex: 0,
				selectedModes: [0]
			});
			assert.deepEqual(viewTier0.perModeBadges, ['+ {0}', '+ {2}', '+ {3}{U}']);
			assert.equal(viewTier0.selectedTotalCostBadge, '+ {0}');

			const viewTier2 = extractModalModeCostView(spellAb.modal, {
				card: tieredCard,
				faceIndex: 0,
				selectedModes: [2]
			});
			assert.equal(viewTier2.selectedTotalCostBadge, '+ {3}{U}');
		});

		it('formats Escalate extra-mode costs (mana and non-mana) across 1, 2, and 3 chosen modes (CR 702.120)', () => {
			const escalateCard = synthCard({
				name: 'Collective Pact',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Escalate {2}\nChoose one or more —\n• Target opponent loses 2 life.\n• You gain 2 life.\n• Draw a card.'
			});
			const compiled = compileCard(escalateCard);
			const spellAb = compiled.faces[0]?.abilities.find((a) => a.kind === 'spell');
			assert.ok(spellAb && spellAb.kind === 'spell' && spellAb.modal);

			const viewOne = extractModalModeCostView(spellAb.modal, {
				card: escalateCard,
				faceIndex: 0,
				selectedModes: [0]
			});
			assert.equal(viewOne.hasModeCosts, true);
			assert.equal(viewOne.escalateStepCost, '+ {2}');
			assert.equal(viewOne.escalateBadge, '+ {2} per extra mode');
			assert.equal(viewOne.selectedTotalCostBadge, null);

			const viewThree = extractModalModeCostView(spellAb.modal, {
				card: escalateCard,
				faceIndex: 0,
				selectedModes: [0, 1, 2]
			});
			assert.equal(viewThree.selectedTotalCostBadge, '+ {2}{2}');

			const nonManaEscalate = synthCard({
				name: 'Collective Pyre',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Escalate—Discard a card.\nChoose one or more —\n• ~ deals 3 damage to target opponent.\n• Draw a card.'
			});
			const compiledNonMana = compileCard(nonManaEscalate);
			const nmSpellAb = compiledNonMana.faces[0]?.abilities.find((a) => a.kind === 'spell');
			assert.ok(nmSpellAb && nmSpellAb.kind === 'spell' && nmSpellAb.modal);
			const nmViewTwo = extractModalModeCostView(nmSpellAb.modal, {
				card: nonManaEscalate,
				faceIndex: 0,
				selectedModes: [0, 1]
			});
			assert.equal(nmViewTwo.escalateStepCost, '+ Discard 1 card(s)');
			assert.equal(nmViewTwo.selectedTotalCostBadge, '+ Discard 1 card(s)');
		});
	});

	describe('6. Memoization Cache Invalidation & UI Purity Guard', () => {
		it('invalidates buildBoardViewModel WeakMap cache whenever any U6 permanent, exile, or player field mutates', () => {
			const { state, p1, p2 } = setupArenaState();
			const permA = putInZone(
				state,
				p1,
				synthCard({ name: 'Sentinel Alpha', typeLine: 'Creature — Construct' }),
				'battlefield'
			);
			const permB = putInZone(
				state,
				p1,
				synthCard({ name: 'Sentinel Beta', typeLine: 'Creature — Construct' }),
				'battlefield'
			);
			const exCard = putInZone(
				state,
				p1,
				synthCard({ name: 'Exiled Echo', typeLine: 'Instant' }),
				'exile'
			);

			let prev = buildBoardViewModel(state, 'p1');
			// Unchanged state hits cache (strict reference equality)
			assert.equal(buildBoardViewModel(state, 'p1'), prev);

			const assertInvalidated = (label: string, mutate: () => void) => {
				mutate();
				const next = buildBoardViewModel(state, 'p1');
				assert.notEqual(next, prev, `Expected cache invalidation for ${label}`);
				assert.equal(buildBoardViewModel(state, 'p1'), next, `Expected cache hit after ${label}`);
				prev = next;
			};

			assertInvalidated('perm.classLevel', () => {
				permA.classLevel = 2;
			});
			assertInvalidated('perm.isSolved', () => {
				permA.isSolved = true;
			});
			assertInvalidated('perm.mergedComponents', () => {
				permA.mergedComponents = [
					permA.card,
					synthCard({ name: 'Underbeast', typeLine: 'Creature — Beast' })
				];
			});
			assertInvalidated('perm.mutateCount', () => {
				permA.mutateCount = 3;
			});
			assertInvalidated('perm.copiableState.mergedComponents', () => {
				permB.copiableState = {
					card: permB.card,
					mergedComponents: [
						permB.card,
						synthCard({ name: 'Copied Underbeast', typeLine: 'Creature — Beast' })
					]
				};
			});
			assertInvalidated('perm.meldedComponents', () => {
				permB.meldedComponents = [
					synthCard({ name: 'Half One', typeLine: 'Artifact' }),
					synthCard({ name: 'Half Two', typeLine: 'Artifact' })
				];
			});
			assertInvalidated('perm.isFlipped', () => {
				permA.isFlipped = true;
			});
			assertInvalidated('perm.pairedWithId', () => {
				permA.pairedWithId = permB.instanceId;
				permB.pairedWithId = permA.instanceId;
			});
			assertInvalidated('perm.hauntedByCards', () => {
				permA.hauntedByCards = [synthCard({ name: 'Ghostly Wail', typeLine: 'Sorcery' })];
			});
			assertInvalidated('perm.isSuspected', () => {
				permA.isSuspected = true;
			});
			assertInvalidated('perm.goadedByPlayerIds', () => {
				permA.goadedByPlayerIds = [p2.playerId];
			});
			assertInvalidated('perm.isHarnessed', () => {
				permA.isHarnessed = true;
			});
			assertInvalidated('perm.isRenowned', () => {
				permA.isRenowned = true;
			});
			assertInvalidated('perm.hasEnduringStory', () => {
				permA.hasEnduringStory = true;
			});
			assertInvalidated('exile.hauntingTargetId', () => {
				exCard.hauntingTargetId = permA.instanceId;
				exCard.hauntingTargetVersion = permA.objectVersion ?? 1;
			});
			assertInvalidated('exile.hauntingTargetVersion', () => {
				exCard.hauntingTargetVersion = (permA.objectVersion ?? 1) + 9;
			});
			assertInvalidated('player.hasEnduringStory', () => {
				p1.hasEnduringStory = true;
			});
			assertInvalidated('player.cannotCastSpellsForRestOfGame', () => {
				p1.cannotCastSpellsForRestOfGame = true;
			});
			assertInvalidated('player.epicSpells', () => {
				p1.epicSpells = [
					{ card: synthCard({ name: 'Eternal Chant', typeLine: 'Sorcery' }), faceIndex: 0 }
				];
			});
		});

		it('keeps UI source files free of oracleText reads and Wave 4–6 keyword string branching', () => {
			const uiDir = path.dirname(fileURLToPath(import.meta.url));
			const uiFiles = [
				'boardViewModel.ts',
				'PermanentCard.svelte',
				'CardInspector.svelte',
				'ZoneBrowserModal.svelte',
				'ModePickerModal.svelte',
				'PlayerVitals.svelte',
				'OpponentPod.svelte'
			];
			const forbiddenQuotedKeywords = [
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
				'goad'
			];

			for (const rel of uiFiles) {
				const src = fs.readFileSync(path.join(uiDir, rel), 'utf8');
				assert.equal(
					/\.oracleText\b/.test(src),
					false,
					`Forbidden .oracleText read in ${rel}`
				);
				const lower = src.toLowerCase();
				for (const kw of forbiddenQuotedKeywords) {
					assert.equal(
						lower.includes(`'${kw}'`) || lower.includes(`"${kw}"`),
						false,
						`Forbidden quoted keyword literal "${kw}" in ${rel}`
					);
				}
			}
		});
	});
});
