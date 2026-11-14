import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeBotStep } from '../ai.ts';
import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkTurnFaceUpLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getCreaturePower,
	getCreatureToughness,
	getTurnFaceUpDisplay,
	loseTheGame,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { IMPLEMENTED_KEYWORDS } from '../compiler/card.ts';
import { resolveObjectFaces } from './faces.ts';
import { STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard
} from '../types.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	const base: ScryfallCard = {
		id: `tff_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '',
		cmc: overrides.cmc ?? 0,
		typeLine: overrides.typeLine ?? 'Creature — Elemental',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false
	};
	return { ...base, ...overrides };
}

function makeTwoPlayerState(p1DeckCards: ScryfallCard[] = []): GameState {
	const forest = STAPLE_CARDS['forest'];
	const commander1 = synthCard({
		name: 'Synthetic Watchman',
		manaCost: '{2}{G}',
		cmc: 3,
		typeLine: 'Legendary Creature — Human Scout',
		colors: ['G'],
		colorIdentity: ['G'],
		power: '2',
		toughness: '3',
		canBeCommander: true
	});
	const commander2 = synthCard({
		name: 'Synthetic Rival',
		manaCost: '{2}{U}',
		cmc: 3,
		typeLine: 'Legendary Creature — Wizard',
		colors: ['U'],
		colorIdentity: ['U'],
		power: '2',
		toughness: '2',
		canBeCommander: true
	});
	const makeDeck = (id: string, cmd: ScryfallCard, extras: ScryfallCard[]): MagicDeck => ({
		id,
		userId: id,
		name: id,
		description: '',
		commanders: [cmd],
		cards: [
			...extras.map((card) => ({ card, quantity: 1 })),
			{ card: forest, quantity: Math.max(1, 20 - extras.length) }
		],
		colorIdentity: cmd.colorIdentity,
		cardCount: 20,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	});
	const decks = new Map<number, MagicDeck>([
		[0, makeDeck('d1', commander1, p1DeckCards)],
		[1, makeDeck('d2', commander2, [])]
	]);
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: 'd1',
			deckName: 'd1',
			commanderNames: [commander1.name],
			commanderArtUrl: '',
			colorIdentity: ['G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: true,
			deckId: 'd2',
			deckName: 'd2',
			commanderNames: [commander2.name],
			commanderArtUrl: '',
			colorIdentity: ['U'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const state = createInitialGameState(
		'TEST_TFF',
		seats,
		decks,
		{ ...DEFAULT_LOBBY_RULES, startingLife: 40 }
	);
	state.status = 'active';
	state.players.forEach((p) => (p.hasKeptHand = true));
	state.pendingPrompts = [];
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.turnNumber = 2;
	return state;
}

function flushTriggerOrderPrompts(state: GameState): void {
	while (state.pendingPrompts.length > 0 && state.pendingPrompts[0].purpose === 'trigger_order') {
		const pr = state.pendingPrompts[0];
		const ids = pr.choice?.kind === 'orderObjects' ? pr.choice.objectIds : pr.candidateInstanceIds ?? [];
		assert.equal(
			applyGameAction(state, pr.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'orderObjects', topIds: ids, bottomIds: [] }
			}).ok,
			true
		);
	}
}

function passBoth(state: GameState): void {
	flushTriggerOrderPrompts(state);
	const p1Id = state.players[state.priorityPlayerIndex].playerId;
	assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
	const p2Id = state.players[state.priorityPlayerIndex].playerId;
	assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
	flushTriggerOrderPrompts(state);
}

describe('Transform, Flip, Morph, Megamorph, Disguise & Face-Down Rules', () => {
	it('keeps unimplemented related keywords honest', () => {
		for (const kw of ['daybound', 'nightbound', 'craft', 'meld']) {
			assert.equal(IMPLEMENTED_KEYWORDS.has(kw), false, `${kw} should stay unimplemented`);
		}
		for (const kw of ['morph', 'megamorph', 'disguise', 'disturb']) {
			assert.equal(IMPLEMENTED_KEYWORDS.has(kw), true, `${kw} should be implemented`);
		}
	});

	it('transforms DFC back and forth via CR 701.27a, preserving identity and firing transforms triggers', () => {
		const observerEnchantment = synthCard({
			name: 'Transform Observer Beacon',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: 'Whenever a creature you control transforms, draw a card.',
			colors: ['G']
		});
		const synthDfc = synthCard({
			name: 'Twilight Seeker // Dawnbringer Hound',
			layout: 'transform',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Human // Creature — Werewolf',
			faces: [
				{
					name: 'Twilight Seeker',
					manaCost: '{1}{G}',
					typeLine: 'Creature — Human',
					oracleText: '{0}: Transform Twilight Seeker.',
					colors: ['G'],
					power: '2',
					toughness: '2',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Dawnbringer Hound',
					manaCost: '',
					typeLine: 'Creature — Eldrazi Werewolf',
					oracleText:
						'Trample\n{0}: Transform Dawnbringer Hound.\nWhenever this creature transforms into an Eldrazi, you gain 3 life.',
					colors: ['R'],
					power: '5',
					toughness: '4',
					keywords: ['Trample'],
					imageUrl: ''
				}
			]
		});

		const state = makeTwoPlayerState();
		const p1 = state.players[0];
		const perm = createCardInstance(synthDfc, 'p1', 'battlefield', false, false, 100);
		perm.counters['+1/+1'] = 1;
		perm.damageMarked = 1;
		const watcher = createCardInstance(observerEnchantment, 'p1', 'battlefield', false, false, 101);
		p1.battlefield.push(perm, watcher);

		const handBefore = p1.hand.length;
		const res1 = applyGameAction(state, 'p1', {
			type: 'activate_ability',
			instanceId: perm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(res1.ok, true);
		passBoth(state); // Resolve activated ability -> transforms -> fires BOTH triggers on stack
		// Triggered abilities from transform resolve
		while (state.stack.length > 0) passBoth(state);

		assert.equal(perm.transformed, true);
		assert.equal(perm.activeFaceIndex, 1);
		assert.equal(perm.counters['+1/+1'], 1);
		assert.equal(perm.damageMarked, 1);
		assert.equal(getCreaturePower(perm, state), 6);
		assert.equal(getCreatureToughness(perm, state), 5);
		assert.equal(evaluatePermanent(state, perm).keywords.includes('Trample'), true);
		assert.equal(p1.hand.length, handBefore + 1, 'transforms trigger drew 1 card');
		assert.equal(p1.life, 43, 'transforms into Eldrazi trigger gained 3 life');

		// Transform back to face 0: "transforms into Eldrazi" must NOT trigger on transforming back to Human!
		const res2 = applyGameAction(state, 'p1', {
			type: 'activate_ability',
			instanceId: perm.instanceId,
			abilityId: 'act_1'
		});
		assert.equal(res2.ok, true);
		passBoth(state);
		while (state.stack.length > 0) passBoth(state);

		assert.equal(perm.transformed, false);
		assert.equal(perm.activeFaceIndex, 0);
		assert.equal(getCreaturePower(perm, state), 3);
		assert.equal(p1.hand.length, handBefore + 2, 'back-to-front transform also fired watcher trigger');
		assert.equal(p1.life, 43, 'did not fire Eldrazi trigger on back-to-front transform');
	});

	it('CR 701.27d-e non-DFC and instant-back transform do nothing; CR 712.11a-b enters transformed / blocks instant back face', () => {
		const vanillaBear = synthCard({
			name: 'Plain Ursine',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			oracleText: '',
			colors: ['G'],
			power: '2',
			toughness: '2'
		});
		const transformTargetedSpell = synthCard({
			name: 'Shift Form Test',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Transform target creature.',
			colors: ['G']
		});
		const exiledTransformer = synthCard({
			name: 'Exile Hatchling // Exiled Leviathan',
			layout: 'transform',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Serpent // Creature — Leviathan',
			faces: [
				{
					name: 'Exile Hatchling',
					manaCost: '{1}{G}',
					typeLine: 'Creature — Serpent',
					oracleText:
						'{0}: Exile Exile Hatchling, then return it to the battlefield transformed under your control.',
					colors: ['G'],
					power: '1',
					toughness: '1',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Exiled Leviathan',
					manaCost: '',
					typeLine: 'Creature — Leviathan',
					oracleText: 'When Exiled Leviathan enters, draw a card.',
					colors: ['U'],
					power: '6',
					toughness: '6',
					keywords: [],
					imageUrl: ''
				}
			]
		});
		const instantBackTransformTarget = synthCard({
			name: 'Odd Artifact // Sudden Surge',
			layout: 'transform',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Artifact Creature — Construct // Instant',
			faces: [
				{
					name: 'Odd Artifact',
					manaCost: '{R}',
					typeLine: 'Artifact Creature — Construct',
					oracleText: '{0}: Transform Odd Artifact.',
					colors: ['R'],
					power: '1',
					toughness: '2',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Sudden Surge',
					manaCost: '',
					typeLine: 'Instant',
					oracleText: 'Draw a card.',
					colors: ['R'],
					keywords: [],
					imageUrl: ''
				}
			]
		});
		const instantBackDfc = synthCard({
			name: 'Odd Tome // Sudden Blast',
			layout: 'transform',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Artifact // Instant',
			faces: [
				{
					name: 'Odd Tome',
					manaCost: '{R}',
					typeLine: 'Artifact',
					oracleText: '{0}: Exile Odd Tome, then return it to the battlefield transformed under your control.',
					colors: ['R'],
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Sudden Blast',
					manaCost: '',
					typeLine: 'Instant',
					oracleText: 'Draw a card.',
					colors: ['R'],
					keywords: [],
					imageUrl: ''
				}
			]
		});

		const state = makeTwoPlayerState();
		const p1 = state.players[0];
		p1.manaPool.G = 1;
		const bear = createCardInstance(vanillaBear, 'p1', 'battlefield', false, false, 100);
		const hatchling = createCardInstance(exiledTransformer, 'p1', 'battlefield', false, false, 101);
		const tome = createCardInstance(instantBackDfc, 'p1', 'battlefield', false, false, 102);
		const instantTgt = createCardInstance(instantBackTransformTarget, 'p1', 'battlefield', false, false, 104);
		const spell = createCardInstance(transformTargetedSpell, 'p1', 'hand', false, false, 103);
		p1.battlefield.push(bear, hatchling, tome, instantTgt);
		p1.hand.push(spell);

		// CR 701.27d: transforming non-DFC does nothing
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(bear.transformed, false);
		assert.equal(getCreaturePower(bear, state), 2);

		// CR 701.27e: permanent whose other face is an Instant or Sorcery does not transform
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: instantTgt.instanceId,
				abilityId: 'act_0'
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(instantTgt.transformed, false);
		assert.equal(instantTgt.activeFaceIndex ?? 0, 0);

		// CR 712.11a: exile and return transformed enters directly on back face and fires back-face ETB
		const handBefore = p1.hand.length;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: hatchling.instanceId,
				abilityId: 'act_0'
			}).ok,
			true
		);
		passBoth(state);
		if (state.stack.length > 0) passBoth(state);
		const leviathan = p1.battlefield.find((c) => c.card.name === exiledTransformer.name);
		assert.ok(leviathan, 'DFC returned to battlefield');
		assert.equal(leviathan.transformed, true);
		assert.equal(leviathan.activeFaceIndex, 1);
		assert.equal(getCreaturePower(leviathan, state), 6);
		assert.equal(p1.hand.length, handBefore + 1, 'back-face ETB triggered');

		// CR 712.11b: back face is Instant -> cannot enter battlefield, stays in exile!
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: tome.instanceId,
				abilityId: 'act_0'
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === tome.instanceId), false);
		assert.equal(p1.exile.some((c) => c.card.name === instantBackDfc.name), true);
	});

	it('CR 704.5m / 303.4c puts transformed Aura enchanting an illegal permanent into graveyard as SBA', () => {
		const creatureToLandAura = synthCard({
			name: 'Morphic Charm // Stony Binding',
			layout: 'transform',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Enchantment — Aura // Enchantment — Aura',
			faces: [
				{
					name: 'Morphic Charm',
					manaCost: '{W}',
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant creature\n{0}: Transform Morphic Charm.',
					colors: ['W'],
					keywords: ['Enchant'],
					imageUrl: ''
				},
				{
					name: 'Stony Binding',
					manaCost: '',
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant land',
					colors: ['W'],
					keywords: ['Enchant'],
					imageUrl: ''
				}
			]
		});
		const hostCreature = synthCard({
			name: 'Test Host',
			manaCost: '{1}',
			typeLine: 'Creature — Golem',
			power: '2',
			toughness: '2'
		});
		const state = makeTwoPlayerState();
		const p1 = state.players[0];
		const host = createCardInstance(hostCreature, 'p1', 'battlefield', false, false, 100);
		const aura = createCardInstance(creatureToLandAura, 'p1', 'battlefield', false, false, 101);
		aura.attachedToId = host.instanceId;
		p1.battlefield.push(host, aura);

		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: aura.instanceId,
				abilityId: 'act_1'
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === aura.instanceId),
			false,
			'illegally attached transformed Aura sent to graveyard by SBA'
		);
		assert.equal(p1.graveyard.some((c) => c.instanceId === aura.instanceId), true);
	});

	it('flips flip cards once (CR 710.1, 710.4) and ignores second flip', () => {
		const flipCard = synthCard({
			name: 'Apprentice Mystic // Enlightened Sage',
			layout: 'flip',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Human Monk // Legendary Creature — Human Wizard',
			faces: [
				{
					name: 'Apprentice Mystic',
					manaCost: '{1}{U}',
					typeLine: 'Creature — Human Monk',
					oracleText: '{0}: Flip Apprentice Mystic.',
					colors: ['U'],
					power: '1',
					toughness: '1',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Enlightened Sage',
					manaCost: '',
					typeLine: 'Legendary Creature — Human Wizard',
					oracleText: 'Flying\n{0}: Flip Enlightened Sage.',
					colors: ['U'],
					power: '4',
					toughness: '4',
					keywords: ['Flying'],
					imageUrl: ''
				}
			]
		});

		const state = makeTwoPlayerState();
		const p1 = state.players[0];
		const perm = createCardInstance(flipCard, 'p1', 'battlefield', false, false, 100);
		p1.battlefield.push(perm);

		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: perm.instanceId,
				abilityId: 'act_0'
			}).ok,
			true
		);
		passBoth(state);

		assert.equal(perm.activeFaceIndex, 1);
		assert.equal(perm.transformed, false);
		assert.equal(getCreaturePower(perm, state), 4);
		assert.equal(evaluatePermanent(state, perm).keywords.includes('Flying'), true);

		// Second flip attempt keeps face 1 (CR 710.4)
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: perm.instanceId,
				abilityId: 'act_1'
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(perm.activeFaceIndex, 1);
		assert.equal(getCreaturePower(perm, state), 4);
	});

	it('casts Morph, Megamorph, Disguise & Land-with-Morph face down (CR 708.4-6), scrubs opponent view & enforces Ward', () => {
		const morphInstant = synthCard({
			name: 'Synthetic Trickster',
			manaCost: '{2}{U}{U}',
			cmc: 4,
			typeLine: 'Creature — Shapeshifter',
			oracleText: 'Flash\nMorph {1}{U}\nWhen Synthetic Trickster is turned face up, draw a card.',
			colors: ['U'],
			power: '3',
			toughness: '3',
			keywords: ['Flash']
		});
		const disguiseCard = synthCard({
			name: 'Synthetic Cloak Agent',
			manaCost: '{4}{U}',
			cmc: 5,
			typeLine: 'Creature — Human Detective',
			oracleText: 'Disguise {2}{U}\nWhenever Synthetic Cloak Agent is turned face up, gain 2 life.',
			colors: ['U'],
			power: '4',
			toughness: '4'
		});
		const morphLand = synthCard({
			name: 'Synthetic Shaping Land',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText: '{T}: Add {C}.\nMorph {2}',
			colors: []
		});
		const megamorphCard = synthCard({
			name: 'Synthetic Colossal Beast',
			manaCost: '{4}{G}{G}',
			cmc: 6,
			typeLine: 'Creature — Beast',
			oracleText: 'Megamorph {3}{G}',
			colors: ['G'],
			power: '4',
			toughness: '4'
		});
		const counterDoubler = synthCard({
			name: 'Counter Amplifier',
			manaCost: '{4}{G}',
			cmc: 5,
			typeLine: 'Enchantment',
			oracleText:
				'If one or more +1/+1 counters would be put on a creature you control, twice that many +1/+1 counters are put on it instead.',
			colors: ['G']
		});
		const killSpell = synthCard({
			name: 'Synthetic Bolt',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Synthetic Bolt deals 3 damage to target creature.',
			colors: ['R']
		});

		const state = makeTwoPlayerState();
		const p1 = state.players[0];
		const p2 = state.players[1];
		p1.manaPool.G = 2;
		p1.manaPool.U = 2;
		p1.manaPool.C = 10;

		const cMorph = createCardInstance(morphInstant, 'p1', 'hand', false, false, 100);
		const cDisguise = createCardInstance(disguiseCard, 'p1', 'hand', false, false, 101);
		const cLandMorph = createCardInstance(morphLand, 'p1', 'hand', false, false, 102);
		const cMega = createCardInstance(megamorphCard, 'p1', 'hand', false, false, 103);
		const doubler = createCardInstance(counterDoubler, 'p1', 'battlefield', false, false, 99);
		p1.hand.push(cMorph, cDisguise, cLandMorph, cMega);
		p1.battlefield.push(doubler);

		// Land with Morph has castFaceDown option even though it is a Land
		const landOpts = getCastOptions(state, 'p1', cLandMorph, 'hand');
		assert.equal(landOpts.some((o) => Boolean(o.spellMods.castFaceDown)), true);

		// Hidden Flash on Morph card does NOT grant instant speed while casting face down
		state.phase = 'combat_damage';
		const flashCheck = getCastOptions(state, 'p1', cMorph, 'hand').filter((o) =>
			Boolean(o.spellMods.castFaceDown)
		);
		assert.equal(flashCheck.length, 0, 'cannot cast face-down morph spell outside main phase despite hidden Flash');
		state.phase = 'main1';

		// Cast Disguise card face down -> opponent view is scrubbed & stack shows Face-Down #1
		const disOpts = getCastOptions(state, 'p1', cDisguise, 'hand');
		const disFaceDownOpt = disOpts.find((o) => Boolean(o.spellMods.castFaceDown));
		assert.ok(disFaceDownOpt);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: cDisguise.instanceId,
				optionId: disFaceDownOpt.id
			}).ok,
			true
		);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].title, 'Face-Down #1');

		const oppStackSanitized = sanitizeGameStateForViewer(state, 'p2');
		assert.equal(oppStackSanitized.stack[0].card.name, 'Face-Down #1');
		assert.equal(oppStackSanitized.stack[0].card.oracleText, '');
		assert.equal(oppStackSanitized.stack[0].faceDownSpec?.turnUpManaCost, undefined);
		assert.equal(oppStackSanitized.stack[0].faceDownSpec?.wardCost, '{2}');

		// Resolve Face-Down #1 onto battlefield
		passBoth(state);
		const disPerm = p1.battlefield.find((c) => c.instanceId === cDisguise.instanceId);
		assert.ok(disPerm);
		assert.equal(disPerm.isFaceDown, true);
		assert.equal(disPerm.faceDownLabel, 'Face-Down #1');
		assert.equal(getCreaturePower(disPerm, state), 2);
		assert.equal(getCreatureToughness(disPerm, state), 2);
		assert.deepEqual(evaluatePermanent(state, disPerm).colors, []);
		assert.equal(
			evaluatePermanent(state, disPerm).keywords.some((k) => k.startsWith('Ward')),
			true
		);

		// Opponent view of battlefield permanent is scrubbed; controller view retains card identity
		const oppBoardSanitized = sanitizeGameStateForViewer(state, 'p2');
		const oppSeenPerm = oppBoardSanitized.players[0].battlefield.find(
			(c) => c.instanceId === disPerm.instanceId
		)!;
		assert.equal(oppSeenPerm.card.name, 'Face-Down #1');
		assert.equal(oppSeenPerm.card.oracleText, '');
		assert.equal(oppSeenPerm.faceDownSpec?.turnUpManaCost, undefined);

		// Opponent targets Face-Down #1 without {2} -> Disguise Ward {2} counters spell, logs NEVER expose hidden name!
		const bolt = createCardInstance(killSpell, 'p2', 'hand', false, false, 105);
		p2.hand.push(bolt);
		p2.manaPool.R = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(applyGameAction(state, 'p1', { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, 'p2', {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: disPerm.instanceId, label: 'Face-Down #1' }]
			}).ok,
			true
		);
		// Ward trigger is on stack above Bolt; resolve Ward (p2 can't pay {2}, so Bolt is countered)
		passBoth(state);
		assert.equal(p2.graveyard.some((c) => c.instanceId === bolt.instanceId), true, 'Ward countered Bolt');
		assert.equal(
			state.log.some((l) => l.text.includes(disguiseCard.name)),
			false,
			'Logs must not leak hidden card name before turning face up'
		);

		// Cast Land-with-Morph face down -> gets unique Face-Down #2 label and doesn't consume land play
		state.priorityPlayerIndex = 0;
		const landFdOpt = landOpts.find((o) => Boolean(o.spellMods.castFaceDown))!;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: cLandMorph.instanceId,
				optionId: landFdOpt.id
			}).ok,
			true
		);
		passBoth(state);
		const landPerm = p1.battlefield.find((c) => c.instanceId === cLandMorph.instanceId)!;
		assert.equal(landPerm.faceDownLabel, 'Face-Down #2');
		assert.equal(p1.landsPlayedThisTurn, 0);

		// Turn Land-with-Morph face up at instant speed while another spell/phase runs (special action!)
		const origObjVer = landPerm.objectVersion;
		const origTimestamp = landPerm.enteredTimestamp;
		assert.equal(getTurnFaceUpDisplay(state, 'p1', landPerm)?.costDisplay, '{2}');
		assert.equal(
			applyGameAction(state, 'p1', { type: 'turn_face_up', instanceId: landPerm.instanceId }).ok,
			true
		);
		assert.equal(landPerm.isFaceDown, false);
		assert.equal(landPerm.objectVersion, origObjVer, 'CR 708.8 preserves object identity');
		assert.equal(landPerm.enteredTimestamp, origTimestamp);
		assert.equal(evaluatePermanent(state, landPerm).isLand, true);
		assert.equal(evaluatePermanent(state, landPerm).isCreature, false);

		// Cast Megamorph face down and turn face up -> gets +1/+1 counter doubled by replacement!
		const megaFdOpt = getCastOptions(state, 'p1', cMega, 'hand').find((o) =>
			Boolean(o.spellMods.castFaceDown)
		)!;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: cMega.instanceId,
				optionId: megaFdOpt.id
			}).ok,
			true
		);
		passBoth(state);
		const megaPerm = p1.battlefield.find((c) => c.instanceId === cMega.instanceId)!;
		assert.equal(
			applyGameAction(state, 'p1', { type: 'turn_face_up', instanceId: megaPerm.instanceId }).ok,
			true
		);
		assert.equal(megaPerm.isFaceDown, false);
		assert.equal(megaPerm.counters['+1/+1'], 2, 'Megamorph counter applies CR 614 replacement multiplier');
		assert.equal(getCreaturePower(megaPerm, state), 6);
	});

	it('supports composite revealFromHand / {X} morph costs, DFC face-down guard (CR 712.12a), and CR 708.9 reveals', () => {
		const revealMorph = synthCard({
			name: 'Azure Watcher',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Creature — Bird',
			oracleText: 'Morph—{1}{U}, Reveal a blue card from your hand.',
			colors: ['U'],
			power: '3',
			toughness: '3'
		});
		const blueCard = synthCard({
			name: 'Sapphire Charm Test',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Draw a card.',
			colors: ['U']
		});
		const dfcWithMorph = synthCard({
			name: 'Secret Keeper // Awakened Idol',
			layout: 'transform',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Creature — Construct // Creature — Golem',
			faces: [
				{
					name: 'Secret Keeper',
					manaCost: '{2}',
					typeLine: 'Creature — Construct',
					oracleText: 'Morph {1}',
					colors: [],
					power: '1',
					toughness: '3',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Awakened Idol',
					manaCost: '',
					typeLine: 'Creature — Golem',
					oracleText: '',
					colors: [],
					power: '4',
					toughness: '4',
					keywords: [],
					imageUrl: ''
				}
			]
		});
		const xMorphCard = synthCard({
			name: 'Prismatic Coil',
			manaCost: '{4}{G}',
			cmc: 5,
			typeLine: 'Creature — Hydra',
			oracleText:
				'Morph {X}{G}{G}\nWhen Prismatic Coil is turned face up, put X +1/+1 counters on it.',
			colors: ['G'],
			power: '2',
			toughness: '2'
		});
		const counterSpell = synthCard({
			name: 'Negate Test',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Counter target spell.',
			colors: ['U']
		});

		const state = makeTwoPlayerState();
		const p1 = state.players[0];
		const p2 = state.players[1];
		p1.manaPool.U = 4;
		p1.manaPool.G = 4;
		p1.manaPool.C = 16;
		p2.manaPool.U = 2;
		p2.manaPool.C = 4;

		const revInst = createCardInstance(revealMorph, 'p1', 'hand', false, false, 100);
		const blueInst = createCardInstance(blueCard, 'p1', 'hand', false, false, 101);
		const xInst = createCardInstance(xMorphCard, 'p1', 'hand', false, false, 102);
		const dfcInst = createCardInstance(dfcWithMorph, 'p1', 'battlefield', false, false, 103);
		dfcInst.isFaceDown = true;
		dfcInst.faceDownLabel = 'Face-Down #9';
		dfcInst.faceDownSpec = { kind: 'morph', castManaCost: '{3}', turnUpManaCost: '{1}' };
		const cntInst = createCardInstance(counterSpell, 'p2', 'hand', false, false, 104);
		p1.hand.push(revInst, blueInst, xInst);
		p1.battlefield.push(dfcInst);
		p2.hand.push(cntInst);

		// CR 712.12a: face-down DFC turned face up has front face up
		assert.equal(applyGameAction(state, 'p1', { type: 'turn_face_up', instanceId: dfcInst.instanceId }).ok, true);
		assert.equal(dfcInst.isFaceDown, false);
		assert.equal(dfcInst.transformed, false);
		assert.equal(dfcInst.activeFaceIndex, 0);

		// Cast revealMorph face down, resolve, cannot turn face up without blue card in hand, CAN with blue card!
		const revOpt = getCastOptions(state, 'p1', revInst, 'hand').find((o) =>
			Boolean(o.spellMods.castFaceDown)
		)!;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: revInst.instanceId,
				optionId: revOpt.id
			}).ok,
			true
		);
		passBoth(state);
		const revPerm = p1.battlefield.find((c) => c.instanceId === revInst.instanceId)!;
		assert.equal(
			checkTurnFaceUpLegality(state, 'p1', revPerm, 0).ok,
			true,
			'legal with blue card in hand'
		);
		// Temporarily remove blue card -> illegal
		p1.hand.splice(p1.hand.indexOf(blueInst), 1);
		assert.equal(checkTurnFaceUpLegality(state, 'p1', revPerm, 0).ok, false);
		p1.hand.push(blueInst);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'turn_face_up',
				instanceId: revPerm.instanceId,
				costPayment: { objects: [[blueInst.instanceId]] }
			}).ok,
			true
		);
		assert.equal(revPerm.isFaceDown, false);
		assert.equal(p1.hand.includes(blueInst), true, 'revealed card stays in hand');

		// Cast xMorphCard face down, resolve, turn face up with X = 3 -> gets 3 +1/+1 counters
		const xOpt = getCastOptions(state, 'p1', xInst, 'hand').find((o) =>
			Boolean(o.spellMods.castFaceDown)
		)!;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: xInst.instanceId,
				optionId: xOpt.id
			}).ok,
			true
		);
		passBoth(state);
		const xPerm = p1.battlefield.find((c) => c.instanceId === xInst.instanceId)!;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'turn_face_up',
				instanceId: xPerm.instanceId,
				xValue: 3
			}).ok,
			true
		);
		passBoth(state); // resolve TurnedFaceUp trigger
		assert.equal(xPerm.counters['+1/+1'], 3);
		assert.equal(getCreaturePower(xPerm, state), 5);

		// CR 708.9: face-down spell countered on stack reveals card name
		const revInst2 = createCardInstance(revealMorph, 'p1', 'hand', false, false, 110);
		p1.hand.push(revInst2);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: revInst2.instanceId,
				optionId: revOpt.id
			}).ok,
			true
		);
		const fdStack = state.stack[0];
		assert.equal(applyGameAction(state, 'p1', { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, 'p2', {
				type: 'cast_spell',
				instanceId: cntInst.instanceId,
				targets: [{ kind: 'stack', id: fdStack.id, label: fdStack.title }]
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(
			state.log.some((l) => l.text.includes('CR 708.9:') && l.text.includes('Azure Watcher')),
			true,
			'CR 708.9 log reveals countered face-down spell'
		);

		// CR 708.9: remaining face-down permanents revealed on player elimination
		const fdEnd = createCardInstance(disguiseForEndTest(), 'p1', 'battlefield', false, false, 120);
		fdEnd.isFaceDown = true;
		fdEnd.faceDownLabel = 'Face-Down #10';
		p1.battlefield.push(fdEnd);
		loseTheGame(state, p1, 'Conceded');
		assert.equal(
			state.log.some((l) => l.text.includes('CR 708.9:') && l.text.includes('Endgame Mystery')),
			true,
			'CR 708.9 reveals face-down permanent when game finishes / player eliminated'
		);
	});

	it('lets Bot AI cast face down and turn face up without any keyword branches', () => {
		const disguiseBotCard = synthCard({
			name: 'Bot Hidden Sentinel',
			manaCost: '{4}{U}{U}',
			cmc: 6,
			typeLine: 'Creature — Sphinx',
			oracleText: 'Disguise {2}{U}',
			colors: ['U'],
			power: '4',
			toughness: '4'
		});
		const state = makeTwoPlayerState();
		const bot = state.players[1];
		bot.command = [];
		const cardInst = createCardInstance(disguiseBotCard, 'p2', 'hand', false, false, 200);
		bot.hand = [cardInst];
		// Give bot {3} generic mana on turn 2: cannot cast 6-mana front face, CAN cast face down!
		bot.manaPool.C = 3;
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'main1';

		const step1 = executeBotStep(state, bot, bot);
		assert.equal(step1, 'visible');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].isFaceDown, true);
		passBoth(state);

		const onBoard = bot.battlefield.find((c) => c.instanceId === cardInst.instanceId)!;
		assert.equal(onBoard.isFaceDown, true);

		// Give bot {2}{U} and let bot execute turn_face_up
		bot.manaPool.U = 1;
		bot.manaPool.C = 2;
		state.priorityPlayerIndex = 1;
		const step2 = executeBotStep(state, bot, bot);
		assert.equal(step2, 'visible');
		assert.equal(onBoard.isFaceDown, false);
		assert.equal(getCreaturePower(onBoard, state), 4);
	});

	it('keeps ArenaTable.svelte and ai.ts strictly keyword-blind for transform/flip/morph/megamorph/disguise', () => {
		const thisDir = path.dirname(fileURLToPath(import.meta.url));
		const aiSrc = fs.readFileSync(path.resolve(thisDir, '../ai.ts'), 'utf8');
		const uiSrc = fs.readFileSync(path.resolve(thisDir, '../ArenaTable.svelte'), 'utf8');
		const uiScriptOnly = uiSrc.slice(0, uiSrc.indexOf('<style>'));
		const forbidden = /\b(morph|megamorph|disguise|transform|transforms)\b/gi;
		assert.deepEqual(aiSrc.match(forbidden) ?? [], [], 'ai.ts must remain keyword-blind');
		assert.deepEqual(
			uiScriptOnly.match(forbidden) ?? [],
			[],
			'ArenaTable.svelte script/markup must remain keyword-blind'
		);
		assert.equal(/\bflip\b/i.test(aiSrc), false, 'ai.ts must not mention flip');
		const uiFlipMatches = uiScriptOnly.match(/\bflip\b/gi) ?? [];
		// Existing "Flip / View Other Face" zoom preview button (3 tokens: zoom-flip-btn, flip-face-btn, Flip label)
		assert.ok(uiFlipMatches.length <= 3, `unexpected flip check in UI: ${uiFlipMatches.join(', ')}`);
	});
});

function disguiseForEndTest(): ScryfallCard {
	return synthCard({
		name: 'Endgame Mystery',
		manaCost: '{2}{U}',
		cmc: 3,
		typeLine: 'Creature — Shapeshifter',
		oracleText: 'Disguise {1}{U}',
		colors: ['U'],
		power: '2',
		toughness: '2'
	});
}
