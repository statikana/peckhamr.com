import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedPriorityAndBots } from '../ai.ts';
import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	canPayOrAutoTap,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard
} from '../engine.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { parseManaCost } from '../oracle.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { getEffectiveActivatedAbilities } from '../ruleTree.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `ga1_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{G}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['G'],
		colorIdentity: overrides.colorIdentity ?? ['W', 'U', 'B', 'R', 'G'],
		power: overrides.power ?? (overrides.typeLine?.includes('Creature') ?? true ? '2' : undefined),
		toughness:
			overrides.toughness ?? (overrides.typeLine?.includes('Creature') ?? true ? '2' : undefined),
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'rare',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function staple(name: string): ScryfallCard {
	const found = Object.values(STAPLE_CARDS).find((c) => c.name === name);
	assert.ok(found, `Expected ${name} in STAPLE_CARDS`);
	return found;
}

function makeSeat(i: number, username: string, isBot = false): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: `player_${i + 1}`,
		username,
		avatarUrl: '',
		isBot,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	};
}

function createTestGame(bots: [boolean, boolean] = [false, false]): {
	state: GameState;
	alice: PlayerGameState;
	bob: PlayerGameState;
} {
	const seats = [makeSeat(0, 'Alice', false), makeSeat(1, 'Bob', false)];
	const state = createInitialGameState(
		'LOBBY_A1',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	state.players[0].isBot = bots[0];
	state.players[1].isBot = bots[1];
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	const alice = state.players[0];
	const bob = state.players[1];
	for (const p of state.players) {
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		p.battlefield = [];
		p.hand = [];
	}
	noteLayerInputsChanged(state);
	return { state, alice, bob };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library' = 'battlefield'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		player.battlefield.push(inst);
		noteLayerInputsChanged(state);
	} else if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	return inst;
}

function makeTreasure(state: GameState, player: PlayerGameState): CardInstance {
	const t = createTokenOnBoard(state, player, {
		name: 'Treasure',
		power: 0,
		toughness: 0,
		colors: [],
		typeLine: 'Token Artifact — Treasure',
		keywords: []
	});
	noteLayerInputsChanged(state);
	return t;
}

const GLIMMERFEN_HOARDKEEPER = synthCard({
	name: 'Glimmerfen Hoardkeeper',
	manaCost: '{3}{R}{R}',
	cmc: 5,
	typeLine: 'Creature — Dragon',
	oracleText:
		'Flying, haste\nWhenever this creature attacks or becomes the target of a spell, create a Treasure token.\nTreasures you control have "{T}, Sacrifice this artifact: Add two mana of any one color."',
	colors: ['R'],
	colorIdentity: ['R'],
	power: '4',
	toughness: '4',
	keywords: ['Flying', 'Haste']
});

describe('Track A1: Granted activated abilities carry their IR (Goldspan Dragon)', () => {
	it('compiles Goldspan Dragon (STAPLE_CARDS) and synthetic Glimmerfen Hoardkeeper with fullySupported: true and identical IR', () => {
		const goldspan = staple('Goldspan Dragon');
		const supportGoldspan = definitionSupportReport(compileCard(goldspan));
		assert.equal(supportGoldspan.fullySupported, true, 'Goldspan Dragon must be fullySupported');

		const supportSynth = definitionSupportReport(compileCard(GLIMMERFEN_HOARDKEEPER));
		assert.equal(
			supportSynth.fullySupported,
			true,
			'Glimmerfen Hoardkeeper must be fullySupported'
		);

		const stripSpans = (v: unknown): unknown => {
			if (Array.isArray(v)) return v.map(stripSpans);
			if (v && typeof v === 'object') {
				const out: Record<string, unknown> = {};
				for (const [k, val] of Object.entries(v)) {
					if (k === 'span') continue;
					out[k] = stripSpans(val);
				}
				return out;
			}
			return v;
		};
		assert.deepEqual(
			stripSpans(compileCard(goldspan).faces[0].abilities),
			stripSpans(compileCard(GLIMMERFEN_HOARDKEEPER).faces[0].abilities),
			'Goldspan Dragon and Glimmerfen Hoardkeeper must compile to identical ability IR'
		);
	});

	it('Treasure produces 1 mana without Goldspan and 2 mana of one chosen color with Goldspan; human gets ability choice via both activate_ability and tap_mana', () => {
		const { state, alice } = createTestGame();

		// 1. Without Goldspan: Treasure produces 1 mana
		const tSolo = makeTreasure(state, alice);
		const soloAbs = getEffectiveActivatedAbilities(state, alice, tSolo, ['W', 'U', 'B', 'R', 'G']);
		assert.equal(soloAbs.length, 1);
		assert.equal(soloAbs[0].producesAmount, 1);

		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'tap_mana',
				instanceId: tSolo.instanceId
			}).ok,
			true
		);
		const soloColorPrompt = state.pendingPrompts[0];
		assert.ok(soloColorPrompt?.choice);
		assert.equal(soloColorPrompt.choice.kind, 'chooseMode');
		assert.deepEqual(soloColorPrompt.choice.modes, ['W', 'U', 'B', 'R', 'G']);
		// Choose 'U' (index 1)
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: soloColorPrompt.id,
				answer: { kind: 'chooseMode', indices: [1] }
			}).ok,
			true
		);
		assert.equal(alice.manaPool.U, 1);
		assert.equal(alice.battlefield.includes(tSolo), false);
		alice.manaPool.U = 0;

		// 2. Put Goldspan Dragon on the battlefield
		putInZone(state, alice, staple('Goldspan Dragon'), 'battlefield');
		const tWithGoldspan = makeTreasure(state, alice);
		const dualAbs = getEffectiveActivatedAbilities(state, alice, tWithGoldspan, [
			'W',
			'U',
			'B',
			'R',
			'G'
		]);
		assert.equal(dualAbs.length, 2, 'Treasure with Goldspan has both innate and granted abilities');
		const oneManaAb = dualAbs.find((a) => a.producesAmount === 1);
		const twoManaAb = dualAbs.find((a) => a.producesAmount === 2);
		assert.ok(oneManaAb, 'Innate 1-mana ability present');
		assert.ok(twoManaAb, 'Granted 2-mana ability present');
		assert.ok(
			twoManaAb.label.includes('Sacrifice this artifact') &&
				!twoManaAb.label.includes('Sacrifice Goldspan Dragon'),
			`Granted ability display text should preserve "this artifact", got: ${twoManaAb.label}`
		);

		// 2a. Human selects the 2-mana ability via activate_ability -> chooses 'B' -> gets 2 {B}
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'activate_ability',
				instanceId: tWithGoldspan.instanceId,
				abilityId: twoManaAb.id
			}).ok,
			true
		);
		const colorPrompt2 = state.pendingPrompts[0];
		assert.ok(colorPrompt2?.choice);
		assert.equal(colorPrompt2.choice.kind, 'chooseMode');
		assert.deepEqual(colorPrompt2.choice.modes, ['W', 'U', 'B', 'R', 'G']);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: colorPrompt2.id,
				answer: { kind: 'chooseMode', indices: [2] } // 'B'
			}).ok,
			true
		);
		assert.equal(alice.manaPool.B, 2, 'Selected 2-mana ability must add 2 {B}');
		assert.equal(
			Object.values(alice.manaPool).reduce((a, b) => a + b, 0),
			2,
			'Must add two mana of one chosen color'
		);
		assert.equal(alice.battlefield.includes(tWithGoldspan), false);
		alice.manaPool.B = 0;

		// 2b. Human selects the 1-mana ability via activate_ability -> chooses 'R' -> gets 1 {R}
		const tChooseOne = makeTreasure(state, alice);
		const chooseOneAbs = getEffectiveActivatedAbilities(state, alice, tChooseOne, [
			'W',
			'U',
			'B',
			'R',
			'G'
		]);
		const innateId = chooseOneAbs.find((a) => a.producesAmount === 1)!.id;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'activate_ability',
				instanceId: tChooseOne.instanceId,
				abilityId: innateId
			}).ok,
			true
		);
		const colorPrompt1 = state.pendingPrompts[0];
		assert.ok(colorPrompt1?.choice);
		assert.equal(colorPrompt1.choice.kind, 'chooseMode');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: colorPrompt1.id,
				answer: { kind: 'chooseMode', indices: [3] } // 'R'
			}).ok,
			true
		);
		assert.equal(alice.manaPool.R, 1, 'Selected 1-mana ability must add 1 {R}');
		alice.manaPool.R = 0;

		// 2c. Human calls tap_mana without abilityId -> prompted to choose which mana ability, then color
		const tTapMana = makeTreasure(state, alice);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'tap_mana',
				instanceId: tTapMana.instanceId
			}).ok,
			true
		);
		const abChoicePrompt = state.pendingPrompts[0];
		assert.ok(
			abChoicePrompt?.choice,
			'tap_mana without abilityId must prompt human to choose between the 2 mana abilities'
		);
		assert.equal(abChoicePrompt.choice.kind, 'chooseMode');
		assert.equal(abChoicePrompt.choice.modes.length, 2);
		const twoManaModeIdx = abChoicePrompt.choice.modes.findIndex((m) =>
			m.toLowerCase().includes('two mana')
		);
		assert.ok(twoManaModeIdx >= 0, '2-mana option must appear in tap_mana choice modes');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: abChoicePrompt.id,
				answer: { kind: 'chooseMode', indices: [twoManaModeIdx] }
			}).ok,
			true
		);
		const tapColorPrompt = state.pendingPrompts[0];
		assert.ok(tapColorPrompt?.choice);
		assert.equal(tapColorPrompt.choice.kind, 'chooseMode');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: tapColorPrompt.id,
				answer: { kind: 'chooseMode', indices: [4] } // 'G'
			}).ok,
			true
		);
		assert.equal(alice.manaPool.G, 2, 'Choosing 2-mana mode in tap_mana must produce 2 {G}');
	});

	it('auto-tap and bots prefer the two-mana ability when they need the mana (and preserve untapped lands first)', () => {
		// 1. Human auto-tap with Goldspan + 2 Treasures casting {1}{U}: sacrifices ONLY 1 Treasure using 2-mana ability
		const { state, alice } = createTestGame();
		putInZone(state, alice, staple('Goldspan Dragon'), 'battlefield');
		const t1 = makeTreasure(state, alice);
		const t2 = makeTreasure(state, alice);

		// Cannot pay {U}{R} (two different colors) with only 1 Treasure, even with Goldspan
		alice.battlefield = alice.battlefield.filter((b) => b.instanceId !== t2.instanceId);
		noteLayerInputsChanged(state);
		assert.equal(
			canPayOrAutoTap(alice, parseManaCost('{U}{R}'), state),
			false,
			'1 Treasure + Goldspan produces two mana of ONE color, not {U}{R}'
		);
		assert.equal(
			canPayOrAutoTap(alice, parseManaCost('{1}{U}'), state),
			true,
			'1 Treasure + Goldspan can pay {1}{U}'
		);

		// Restore 2nd Treasure and cast {1}{U} -> only 1 Treasure sacrificed!
		alice.battlefield.push(t2);
		noteLayerInputsChanged(state);
		const spell2U = putInZone(
			state,
			alice,
			synthCard({
				name: 'Azure Drakelet',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Drake',
				oracleText: 'Flying',
				colors: ['U'],
				power: '2',
				toughness: '1',
				keywords: ['Flying']
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: spell2U.instanceId
			}).ok,
			true
		);
		const remainingTreasures = alice.battlefield.filter((b) => b.card.name === 'Treasure');
		assert.equal(
			remainingTreasures.length,
			1,
			'Auto-tap must prefer the 2-mana ability so only 1 of 2 Treasures is sacrificed for {1}{U}'
		);
		assert.equal(remainingTreasures[0].instanceId, t2.instanceId);
		// Resolve spell
		applyGameAction(state, alice.playerId, { type: 'pass_priority' });
		applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' });

		// Verify untapped land is tapped BEFORE sacrificing a Treasure
		const mountain = putInZone(state, alice, staple('Mountain'), 'battlefield');
		const spell1R = putInZone(
			state,
			alice,
			synthCard({
				name: 'Goblin Scout',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Creature — Goblin',
				colors: ['R'],
				power: '1',
				toughness: '1'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: spell1R.instanceId
			}).ok,
			true
		);
		assert.equal(mountain.tapped, true, 'Auto-tap taps Mountain before sacrificing Treasure');
		assert.equal(
			alice.battlefield.some((b) => b.instanceId === t2.instanceId),
			true,
			'Treasure is preserved when untapped Mountain covers {R}'
		);

		// 2. Bot with synthetic Glimmerfen Hoardkeeper + 1 Treasure + 0 lands casts a {1}{R} creature
		const botGame = createTestGame([true, true]);
		const botAlice = botGame.alice;
		putInZone(botGame.state, botAlice, GLIMMERFEN_HOARDKEEPER, 'battlefield');
		const botTreasure = makeTreasure(botGame.state, botAlice);
		const botCreature = putInZone(
			botGame.state,
			botAlice,
			synthCard({
				name: 'Ember Cub',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Elemental',
				colors: ['R'],
				power: '2',
				toughness: '2'
			}),
			'hand'
		);
		runAutomatedPriorityAndBots(botGame.state, { maxSteps: 20 });
		assert.equal(
			botAlice.hand.some((c) => c.instanceId === botCreature.instanceId),
			false,
			'Bot must cast {1}{R} Ember Cub using Glimmerfen Hoardkeeper 2-mana Treasure ability'
		);
		assert.equal(
			botAlice.battlefield.some((b) => b.instanceId === botTreasure.instanceId),
			false,
			'Bot sacrificed the single Treasure for 2 mana'
		);
	});

	it('removing Goldspan mid-turn removes the ability; later-timestamp ability loss removes both abilities; earlier-timestamp ability loss leaves later grant (CR 613.1f, 613.7)', () => {
		const { state, alice, bob } = createTestGame();

		const goldspan = putInZone(state, alice, staple('Goldspan Dragon'), 'battlefield');
		const treasure = makeTreasure(state, alice);
		assert.equal(getEffectiveActivatedAbilities(state, alice, treasure).length, 2);

		// 1. Destroy Goldspan mid-turn via a spell cast through applyGameAction
		const killSpell = putInZone(
			state,
			alice,
			synthCard({
				name: 'Dragonbane Bolt',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.',
				colors: ['B']
			}),
			'hand'
		);
		alice.manaPool.B = 1;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: killSpell.instanceId,
				targets: [{ kind: 'permanent', id: goldspan.instanceId, label: goldspan.card.name }]
			}).ok,
			true
		);
		// Goldspan's "becomes the target of a spell" trigger goes on top of Dragonbane Bolt; resolve the whole stack
		while (state.stack.length > 0) {
			const priorityId = state.players[state.priorityPlayerIndex].playerId;
			assert.equal(applyGameAction(state, priorityId, { type: 'pass_priority' }).ok, true);
		}

		assert.equal(
			alice.battlefield.some((b) => b.instanceId === goldspan.instanceId),
			false,
			'Goldspan Dragon died'
		);
		const afterRemovalAbs = getEffectiveActivatedAbilities(state, alice, treasure, [
			'W',
			'U',
			'B',
			'R',
			'G'
		]);
		assert.equal(afterRemovalAbs.length, 1, 'Granted 2-mana ability removed immediately');
		assert.equal(afterRemovalAbs[0].producesAmount, 1);

		// 2. Later-timestamp ability loss (Dress Down-style global effect entering AFTER granter) leaves Treasure with NEITHER ability
		// Use an Enchantment granter so "All creatures lose all abilities" strips ONLY the animated Treasure (not the granter),
		// exercising Layer 6 timestamp ordering directly on the Treasure!
		const shrineEarly = putInZone(
			state,
			alice,
			synthCard({
				name: 'Glimmerfen Shrine',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText:
					'Treasures you control have "{T}, Sacrifice this artifact: Add two mana of any one color."',
				colors: ['R']
			}),
			'battlefield'
		);
		const animatedTreasure = createTokenOnBoard(state, alice, {
			name: 'Treasure',
			power: 1,
			toughness: 1,
			colors: [],
			typeLine: 'Token Artifact Creature — Treasure Construct',
			keywords: []
		});
		animatedTreasure.summoningSick = false;
		noteLayerInputsChanged(state);
		assert.equal(
			getEffectiveActivatedAbilities(state, alice, animatedTreasure, ['W', 'U', 'B', 'R', 'G'])
				.length,
			2,
			'Animated Treasure starts with both abilities'
		);

		// Dress Down-like global effect entering AFTER Glimmerfen Shrine (later timestamp)
		const dressDown = putInZone(
			state,
			alice,
			synthCard({
				name: 'Stasis Veil',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.',
				colors: ['U']
			}),
			'battlefield'
		);
		assert.ok(dressDown.enteredTimestamp! > shrineEarly.enteredTimestamp!);
		assert.deepEqual(
			getEffectiveActivatedAbilities(state, alice, animatedTreasure, ['W', 'U', 'B', 'R', 'G']),
			[],
			'Treasure that loses all abilities at a later timestamp has neither ability'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'tap_mana',
				instanceId: animatedTreasure.instanceId
			}).ok,
			false
		);

		// 3. Reverse timestamp order (CR 613.7): Stasis Veil has EARLIER timestamp, a new granter enters LATER!
		const lateHoardkeeperShrine = putInZone(
			state,
			alice,
			synthCard({
				name: 'Late Glimmerfen Shrine',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText:
					'Treasures you control have "{T}, Sacrifice this artifact: Add two mana of any one color."',
				colors: ['R']
			}),
			'battlefield'
		);
		assert.ok(lateHoardkeeperShrine.enteredTimestamp! > dressDown.enteredTimestamp!);
		const afterLateGrantAbs = getEffectiveActivatedAbilities(state, alice, animatedTreasure, [
			'W',
			'U',
			'B',
			'R',
			'G'
		]);
		assert.equal(
			afterLateGrantAbs.length,
			1,
			'CR 613.7: Innate ability remains lost, but later-timestamp granter grants the 2-mana ability'
		);
		assert.equal(afterLateGrantAbs[0].producesAmount, 2);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'activate_ability',
				instanceId: animatedTreasure.instanceId,
				abilityId: afterLateGrantAbs[0].id
			}).ok,
			true
		);
		const revPrompt = state.pendingPrompts[0];
		assert.ok(revPrompt);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: revPrompt.id,
				answer: { kind: 'chooseMode', indices: [0] } // 'W'
			}).ok,
			true
		);
		assert.equal(
			alice.manaPool.W,
			2,
			'Activated 2-mana ability on a permanent with earlier losesAllAbilities must still produce 2 mana (not clamped to 1)'
		);
	});

	it('executes non-mana granted activated abilities end-to-end via applyGameAction (including stack JSON round-trip and CR 113.7a granter removal)', () => {
		const { state, alice, bob } = createTestGame();

		const bear = putInZone(
			state,
			alice,
			synthCard({
				name: 'Mossback Bear',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				oracleText: '',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		// 1. Grant '{1}, {T}: Draw a card.' (single-quoted)
		const drawGranter = putInZone(
			state,
			alice,
			synthCard({
				name: 'Chorus of Scholars',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: "Creatures you control have '{1}, {T}: Draw a card.'",
				colors: ['U']
			}),
			'battlefield'
		);

		const drawnCard = putInZone(
			state,
			alice,
			synthCard({ name: 'Topdeck Island', typeLine: 'Basic Land — Island', manaCost: '', cmc: 0 }),
			'library'
		);

		const bearAbs = getEffectiveActivatedAbilities(state, alice, bear);
		assert.equal(bearAbs.length, 1);
		assert.equal(bearAbs[0].isManaAbility, false);

		alice.manaPool.C = 1;
		const handBefore = alice.hand.length;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'activate_ability',
				instanceId: bear.instanceId,
				abilityId: bearAbs[0].id
			}).ok,
			true
		);
		assert.equal(bear.tapped, true);
		assert.equal(state.stack.length, 1);

		// GameState must survive plain JSON serialization mid-stack (zero IR leak in GameState)
		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		assert.equal(roundTripped.stack.length, 1);

		// CR 113.7a: Destroy the granter BEFORE the activated ability on the stack resolves!
		const rtAlice = roundTripped.players[0];
		const rtBob = roundTripped.players[1];
		const naturalize = putInZone(
			roundTripped,
			rtBob,
			synthCard({
				name: 'Shatter Enchantment',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target enchantment.',
				colors: ['G']
			}),
			'hand'
		);
		assert.equal(applyGameAction(roundTripped, rtAlice.playerId, { type: 'pass_priority' }).ok, true);
		rtBob.manaPool.G = 2;
		assert.equal(
			applyGameAction(roundTripped, rtBob.playerId, {
				type: 'cast_spell',
				instanceId: naturalize.instanceId,
				targets: [{ kind: 'permanent', id: drawGranter.instanceId, label: drawGranter.card.name }]
			}).ok,
			true
		);
		// Resolve Shatter Enchantment
		assert.equal(applyGameAction(roundTripped, rtBob.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(roundTripped, rtAlice.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			rtAlice.battlefield.some((b) => b.instanceId === drawGranter.instanceId),
			false,
			'Granter was destroyed before granted ability resolved'
		);

		// Now resolve the granted Draw ability still on the stack
		assert.equal(roundTripped.stack.length, 1);
		assert.equal(applyGameAction(roundTripped, rtAlice.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(roundTripped, rtBob.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(roundTripped.stack.length, 0);
		assert.equal(rtAlice.hand.length, handBefore + 1, 'Alice drew a card from the granted ability');
		assert.equal(rtAlice.hand[rtAlice.hand.length - 1].instanceId, drawnCard.instanceId);

		// 2. Targeted non-mana granted ability: "{T}: This creature deals 1 damage to any target."
		const pingGranter = putInZone(
			roundTripped,
			rtAlice,
			synthCard({
				name: 'Ember Mantle Shrine',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control have "{T}: This creature deals 1 damage to any target."',
				colors: ['R']
			}),
			'battlefield'
		);
		assert.ok(pingGranter);
		const rtBear = rtAlice.battlefield.find((b) => b.instanceId === bear.instanceId)!;
		rtBear.tapped = false;
		const pingAbs = getEffectiveActivatedAbilities(roundTripped, rtAlice, rtBear);
		assert.equal(pingAbs.length, 1);
		assert.equal(pingAbs[0].requiresTarget, true);

		const bobLifeBefore = rtBob.life;
		assert.equal(
			applyGameAction(roundTripped, rtAlice.playerId, {
				type: 'activate_ability',
				instanceId: rtBear.instanceId,
				abilityId: pingAbs[0].id,
				targets: [{ kind: 'player', id: rtBob.playerId, label: rtBob.username }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(roundTripped, rtAlice.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(roundTripped, rtBob.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(rtBob.life, bobLifeBefore - 1, 'Targeted granted ability dealt 1 damage to Bob');
	});

	it('keeps existing land-grant cards working through the IR path without label regexes', () => {
		const { state, alice } = createTestGame();

		// Chromatic Lantern + Forest -> can tap Forest for {U}
		putInZone(state, alice, staple('Chromatic Lantern'), 'battlefield');
		const forest = putInZone(state, alice, staple('Forest'), 'battlefield');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'tap_mana',
				instanceId: forest.instanceId,
				preferredColor: 'U'
			}).ok,
			true
		);
		assert.equal(alice.manaPool.U, 1);

		// Imprisoned in the Moon on a creature -> taps for {C}
		const bear = putInZone(state, alice, synthCard({ name: 'Moon Bear' }), 'battlefield');
		const moon = putInZone(state, alice, staple('Imprisoned in the Moon'), 'battlefield');
		moon.attachedToId = bear.instanceId;
		noteLayerInputsChanged(state);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'tap_mana',
				instanceId: bear.instanceId
			}).ok,
			true
		);
		assert.equal(alice.manaPool.C, 1);

		// Urborg + Island -> taps Island for {B}
		putInZone(state, alice, staple('Urborg, Tomb of Yawgmoth'), 'battlefield');
		const island = putInZone(state, alice, staple('Island'), 'battlefield');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'tap_mana',
				instanceId: island.instanceId,
				preferredColor: 'B'
			}).ok,
			true
		);
		assert.equal(alice.manaPool.B, 1);
	});
});
