import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard, effectOf } from '../compiler/index.ts';
import { staticallyInterpretable } from '../compiler/interpretable.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	matchesLibrarySearchSpec,
	specTargetCandidates,
	validateTargetLegality
} from '../engine.ts';
import { IMPLEMENTED_KEYWORDS, KEYWORD_LABELS } from '../keywords.ts';
import { PRECON_DECKS } from '../precons.ts';
import { instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { matchesObjectFilter } from './objectFilter.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type GameState,
	type LobbySeat,
	type ManaColor,
	type PendingPrompt,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Eldrazi',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? overrides.colors ?? [],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function createTestGame(): GameState {
	const d0 = PRECON_DECKS[0];
	const d1 = PRECON_DECKS[1];
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: d0.id,
			deckName: d0.name,
			commanderNames: d0.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d0.colorIdentity,
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
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: d1.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d1.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const state = createInitialGameState(
		'DEVOID_DIG_TEST',
		seats,
		new Map([
			[0, d0],
			[1, d1]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	state.activePlayerIndex = 0;
	state.phase = 'main1';
	state.priorityPlayerIndex = 0;
	return state;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'library' | 'battlefield' | 'graveyard' | 'exile' | 'command'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	inst.summoningSick = false;
	if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	return inst;
}

function passBothPlayers(state: GameState, steps = 4): void {
	for (let i = 0; i < steps; i++) {
		if (state.pendingPrompts.length > 0 || state.stack.length === 0) break;
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function answerPromptOnRoundTrip(state: GameState, prompt: PendingPrompt, answer: ChoiceAnswer): GameState {
	const copy = roundTrip(state);
	const res = applyGameAction(copy, prompt.playerId, {
		type: 'choice',
		promptId: prompt.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? '');
	return copy;
}

function makePool(state: GameState, player: PlayerGameState, mana: Record<string, number>): void {
	for (const [k, v] of Object.entries(mana)) {
		(player.manaPool as unknown as Record<string, number>)[k] = v;
	}
	void state;
}

describe('Track E Slice 1 Part A — Generalized top-N dig', () => {
	it('compiles canonical and synthetic top-N dig cards and preserves rename invariance', () => {
		const anticipate = makeCard({
			name: 'Anticipate',
			typeLine: 'Instant',
			oracleText:
				'Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.'
		});
		const commune = makeCard({
			name: 'Commune with the Gods',
			typeLine: 'Sorcery',
			oracleText:
				'Reveal the top five cards of your library. You may put a creature or enchantment card from among them into your hand. Put the rest into your graveyard.'
		});
		const coco = makeCard({
			name: 'Collected Company',
			typeLine: 'Instant',
			oracleText:
				'Look at the top six cards of your library. Put up to two creature cards with mana value 3 or less from among them onto the battlefield. Put the rest on the bottom of your library in any order.'
		});
		const lead = makeCard({
			name: 'Lead the Stampede',
			typeLine: 'Sorcery',
			oracleText:
				'Look at the top five cards of your library. You may reveal any number of creature cards from among them and put them into your hand. Put the rest on the bottom of your library in any order.'
		});

		for (const c of [anticipate, commune, coco, lead]) {
			const compiled = compileCard(c);
			assert.equal(compiled.fullySupported, true, `${c.name} should compile as fullySupported`);
			const spellAb = compiled.faces[0].abilities.find((a) => a.kind === 'spell');
			const eff = effectOf(spellAb);
			assert.ok(eff, `${c.name} should have effect`);
			assert.equal(staticallyInterpretable(eff!), true, `${c.name} should be staticallyInterpretable`);
		}

		// Synthetic rename invariance
		const a1 = compileCard(makeCard({ name: 'Silver Gaze Alpha', typeLine: 'Sorcery', oracleText: commune.oracleText }));
		const a2 = compileCard(makeCard({ name: 'Obsidian Sight Beta', typeLine: 'Sorcery', oracleText: commune.oracleText }));
		assert.deepEqual(a1.faces[0].abilities, a2.faces[0].abilities);
	});

	it('rejects partial/unparsed dig follow-ups cleanly (Expressive Iteration & incomplete clauses)', () => {
		const expressive = makeCard({
			name: 'Expressive Iteration',
			typeLine: 'Sorcery',
			oracleText:
				'Look at the top three cards of your library. Put one of them into your hand, put one of them on top of your library, and exile one of them.'
		});
		const missingRest = makeCard({
			name: 'Half Dig One',
			typeLine: 'Sorcery',
			oracleText: 'Look at the top three cards of your library. Put one of them into your hand.'
		});
		const missingKeep = makeCard({
			name: 'Half Dig Two',
			typeLine: 'Sorcery',
			oracleText:
				'Look at the top three cards of your library. Put the rest on the bottom of your library in any order.'
		});
		const bareLook = makeCard({
			name: 'Bare Look',
			typeLine: 'Sorcery',
			oracleText: 'Look at the top three cards of your library.'
		});

		for (const c of [expressive, missingRest, missingKeep, bareLook]) {
			const compiled = compileCard(c);
			const spellAb = compiled.faces[0].abilities.find((a) => a.kind === 'spell');
			if (spellAb && spellAb.kind === 'spell') {
				const eff = effectOf(spellAb);
				assert.ok(eff);
				assert.equal(
					staticallyInterpretable(eff!),
					false,
					`${c.name} must remain non-interpretable instead of dropping clauses`
				);
				assert.equal(eff!.steps[0]?.params?.dig, undefined);
			} else {
				assert.equal(compiled.fullySupported, false, `${c.name} must be marked unsupported`);
			}
		}
	});

	it('resolves Anticipate via chooseObjects -> JSON round-trip -> orderObjects -> JSON round-trip', () => {
		let state = createTestGame();
		const p1 = state.players[0];
		p1.library.length = 0;

		const topC = putInZone(state, p1, makeCard({ name: 'Top Card', typeLine: 'Artifact' }), 'library');
		const topB = putInZone(state, p1, makeCard({ name: 'Middle Card', typeLine: 'Sorcery' }), 'library');
		const topA = putInZone(state, p1, makeCard({ name: 'First Top Card', typeLine: 'Instant' }), 'library');
		// top of library is [topA, topB, topC]
		p1.library.push(
			createCardInstance(makeCard({ name: 'Deep Library Card', typeLine: 'Land' }), p1.playerId, 'library', false, false, 999)
		);

		const spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Sapphire Study',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					'Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.'
			}),
			'hand'
		);
		makePool(state, p1, { U: 2 });

		const castRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId });
		assert.equal(castRes.ok, true, castRes.error ?? '');
		passBothPlayers(state);

		const keepPrompt = state.pendingPrompts[0];
		assert.ok(keepPrompt, 'expected chooseObjects prompt');
		assert.equal(keepPrompt.choice?.kind, 'chooseObjects');
		if (keepPrompt.choice?.kind === 'chooseObjects') {
			assert.deepEqual(keepPrompt.choice.candidates, [topA.instanceId, topB.instanceId, topC.instanceId]);
			assert.equal(keepPrompt.choice.min, 1);
			assert.equal(keepPrompt.choice.max, 1);
		}

		// Pick topB after JSON round-trip
		state = answerPromptOnRoundTrip(state, keepPrompt, {
			kind: 'chooseObjects',
			objectIds: [topB.instanceId]
		});

		const orderPrompt = state.pendingPrompts[0];
		assert.ok(orderPrompt, 'expected orderObjects prompt for remaining 2 cards');
		assert.equal(orderPrompt.choice?.kind, 'orderObjects');
		if (orderPrompt.choice?.kind === 'orderObjects') {
			assert.deepEqual(new Set(orderPrompt.choice.objectIds), new Set([topA.instanceId, topC.instanceId]));
			assert.equal(orderPrompt.choice.allowSplitBottom, false);
			assert.equal(orderPrompt.choice.allowShuffle, false);
		}

		// Order [topC, topA] on bottom after second JSON round-trip
		state = answerPromptOnRoundTrip(state, orderPrompt, {
			kind: 'orderObjects',
			topIds: [topC.instanceId, topA.instanceId]
		});

		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 0);
		const p1After = state.players[0];
		assert.ok(p1After.hand.some((c) => c.instanceId === topB.instanceId));
		assert.equal(p1After.library[0].card.name, 'Deep Library Card');
		assert.equal(p1After.library[p1After.library.length - 2].instanceId, topC.instanceId);
		assert.equal(p1After.library[p1After.library.length - 1].instanceId, topA.instanceId);
	});

	it('resolves Commune with the Gods (filtered upTo keep, revealAll log, rest to graveyard)', () => {
		let state = createTestGame();
		const p1 = state.players[0];
		p1.library.length = 0;

		const land = putInZone(state, p1, makeCard({ name: 'Forest', typeLine: 'Basic Land — Forest' }), 'library');
		const instant = putInZone(state, p1, makeCard({ name: 'Bolt', typeLine: 'Instant' }), 'library');
		const ench = putInZone(state, p1, makeCard({ name: 'Wild Aura', typeLine: 'Enchantment' }), 'library');
		const creat = putInZone(state, p1, makeCard({ name: 'Runeclaw Bear', typeLine: 'Creature — Bear' }), 'library');
		const sorc = putInZone(state, p1, makeCard({ name: 'Optic Spell', typeLine: 'Sorcery' }), 'library');

		const spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Grove Divination',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Reveal the top five cards of your library. You may put a creature or enchantment card from among them into your hand. Put the rest into your graveyard.'
			}),
			'hand'
		);
		makePool(state, p1, { G: 2 });

		const castRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId });
		assert.equal(castRes.ok, true, castRes.error ?? '');
		passBothPlayers(state);

		const prompt = state.pendingPrompts[0];
		assert.ok(prompt && prompt.choice?.kind === 'chooseObjects');
		if (prompt.choice?.kind === 'chooseObjects') {
			assert.equal(prompt.choice.min, 0);
			assert.equal(prompt.choice.max, 1);
			assert.deepEqual(new Set(prompt.choice.candidates), new Set([ench.instanceId, creat.instanceId]));
		}

		// Log already recorded revealed cards
		assert.ok(state.log.some((l) => l.text.includes('revealed') && l.text.includes('Runeclaw Bear')));

		state = answerPromptOnRoundTrip(state, prompt, {
			kind: 'chooseObjects',
			objectIds: [creat.instanceId]
		});

		assert.equal(state.pendingPrompts.length, 0);
		const p1After = state.players[0];
		assert.ok(p1After.hand.some((c) => c.instanceId === creat.instanceId));
		for (const id of [land.instanceId, instant.instanceId, ench.instanceId, sorc.instanceId]) {
			assert.ok(p1After.graveyard.some((c) => c.instanceId === id), `expected ${id} in graveyard`);
		}
	});

	it('resolves Collected Company (battlefield ETB, mana value <= 3 filter, empty-match safe)', () => {
		let state = createTestGame();
		const p1 = state.players[0];
		p1.library.length = 0;

		const big = putInZone(state, p1, makeCard({ name: 'Giant Beast', typeLine: 'Creature — Beast', cmc: 5 }), 'library');
		const land = putInZone(state, p1, makeCard({ name: 'Island', typeLine: 'Basic Land — Island', cmc: 0 }), 'library');
		const etbElf = putInZone(
			state,
			p1,
			makeCard({
				name: 'Elvish Visionary',
				typeLine: 'Creature — Elf Shaman',
				cmc: 2,
				oracleText: 'When ~ enters, you gain 2 life.'
			}),
			'library'
		);
		const bear = putInZone(state, p1, makeCard({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', cmc: 2 }), 'library');
		const smallArtifact = putInZone(state, p1, makeCard({ name: 'Sol Ring', typeLine: 'Artifact', cmc: 1 }), 'library');
		const instant = putInZone(state, p1, makeCard({ name: 'Giant Growth', typeLine: 'Instant', cmc: 1 }), 'library');

		const spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Pack Assembly',
				manaCost: '{3}{G}',
				cmc: 4,
				typeLine: 'Instant',
				oracleText:
					'Look at the top six cards of your library. Put up to two creature cards with mana value 3 or less from among them onto the battlefield. Put the rest on the bottom of your library in any order.'
			}),
			'hand'
		);
		makePool(state, p1, { G: 4 });

		const lifeBefore = p1.life;
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		passBothPlayers(state);

		const prompt = state.pendingPrompts[0];
		assert.ok(prompt && prompt.choice?.kind === 'chooseObjects');
		if (prompt.choice?.kind === 'chooseObjects') {
			assert.deepEqual(new Set(prompt.choice.candidates), new Set([etbElf.instanceId, bear.instanceId]));
			assert.ok(!prompt.choice.candidates.includes(big.instanceId));
			assert.ok(!prompt.choice.candidates.includes(smallArtifact.instanceId));
		}

		state = answerPromptOnRoundTrip(state, prompt, {
			kind: 'chooseObjects',
			objectIds: [etbElf.instanceId, bear.instanceId]
		});

		const orderPrompt = state.pendingPrompts[0];
		assert.ok(orderPrompt && orderPrompt.choice?.kind === 'orderObjects');
		if (orderPrompt.choice?.kind === 'orderObjects') {
			state = answerPromptOnRoundTrip(state, orderPrompt, {
				kind: 'orderObjects',
				topIds: [big.instanceId, land.instanceId, smallArtifact.instanceId, instant.instanceId]
			});
		}

		passBothPlayers(state, 4);
		const p1After = state.players[0];
		assert.ok(p1After.battlefield.some((c) => c.instanceId === etbElf.instanceId));
		assert.ok(p1After.battlefield.some((c) => c.instanceId === bear.instanceId));
		assert.equal(p1After.life, lifeBefore + 2, 'ETB trigger on creature entering via dig should resolve');
		assert.equal(p1After.library.length, 4);
	});

	it('supports keepTapped, keepAllMatching, revealKept, and empty-library safe no-op', () => {
		let state = createTestGame();
		const p1 = state.players[0];
		p1.library.length = 0;

		const spellEmpty = putInZone(
			state,
			p1,
			makeCard({
				name: 'Empty Dig',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText:
					'Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in a random order.'
			}),
			'hand'
		);
		makePool(state, p1, { C: 1 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spellEmpty.instanceId }).ok, true);
		passBothPlayers(state);
		assert.equal(state.pendingPrompts.length, 0, 'count <= 0 should return cleanly with no prompt');

		// Now test keepAllMatching + keepTapped + random bottom
		const nonland = putInZone(state, p1, makeCard({ name: 'Shock', typeLine: 'Instant' }), 'library');
		const land1 = putInZone(state, p1, makeCard({ name: 'Mountain', typeLine: 'Basic Land — Mountain' }), 'library');
		const land2 = putInZone(state, p1, makeCard({ name: 'Plains', typeLine: 'Basic Land — Plains' }), 'library');

		const spellTapped = putInZone(
			state,
			p1,
			makeCard({
				name: 'Landfall Dig',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText:
					'Reveal the top three cards of your library. Put all land cards from among them onto the battlefield tapped and the rest on the bottom of your library in a random order.'
			}),
			'hand'
		);
		makePool(state, p1, { G: 3 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spellTapped.instanceId }).ok, true);
		passBothPlayers(state);
		assert.equal(state.pendingPrompts.length, 0);
		const bfLand1 = state.players[0].battlefield.find((c) => c.instanceId === land1.instanceId);
		const bfLand2 = state.players[0].battlefield.find((c) => c.instanceId === land2.instanceId);
		assert.ok(bfLand1?.tapped);
		assert.ok(bfLand2?.tapped);
		assert.equal(state.players[0].library.length, 1);
		assert.equal(state.players[0].library[0].instanceId, nonland.instanceId);
	});
});

describe('Track E Slice 1 Part B — Devoid (CR 702.114a, 604.3, 613.3, 613.6, 903.4)', () => {
	const makeDevoidRedCreature = (name = 'Vile Aggregate Probe') =>
		makeCard({
			name,
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Creature — Eldrazi Drone',
			oracleText: 'Devoid',
			colors: ['R'],
			colorIdentity: ['R'],
			keywords: ['Devoid'],
			power: '2',
			toughness: '5'
		});

	const makeDevoidRedSpell = (name = 'Touch of the Void Probe') =>
		makeCard({
			name,
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Devoid\n~ deals 3 damage to target opponent.',
			colors: ['R'],
			colorIdentity: ['R'],
			keywords: ['Devoid']
		});

	it('registers devoid in IMPLEMENTED_KEYWORDS/KEYWORD_LABELS and preserves rename invariance', () => {
		assert.equal(IMPLEMENTED_KEYWORDS.has('devoid'), true);
		assert.equal(KEYWORD_LABELS.devoid, 'Devoid');

		const c1 = compileCard(makeDevoidRedCreature('Eldrazi Probe Alpha'));
		const c2 = compileCard(makeDevoidRedCreature('Eldrazi Probe Beta'));
		assert.equal(c1.fullySupported, true);
		assert.deepEqual(c1.faces[0].abilities, [
			{ kind: 'keyword', keyword: { name: 'devoid' }, span: { start: 0, end: 6 } }
		]);
		assert.deepEqual(c1.faces[0].abilities, c2.faces[0].abilities);
	});

	it('makes Devoid objects colorless in all zones while preserving colorIdentity (CR 702.114a, 604.3, 903.4)', () => {
		const state = createTestGame();
		const p1 = state.players[0];
		const devoidCard = makeDevoidRedCreature();

		for (const zone of ['hand', 'library', 'graveyard', 'exile', 'command', 'battlefield'] as const) {
			const inst = putInZone(state, p1, devoidCard, zone);
			const face = resolveObjectFaces(inst.card, instanceFaceOptions(inst));
			assert.deepEqual(face.colors, [], `expected colorless in ${zone}`);
			assert.deepEqual(inst.card.colorIdentity, ['R'], 'colorIdentity must stay untouched (CR 903.4)');
			assert.equal(
				matchesObjectFilter(inst, { colors: ['C'] }, { state, controllerId: p1.playerId }),
				true,
				`expected colorless filter match in ${zone}`
			);
			assert.equal(
				matchesObjectFilter(inst, { colors: ['R'] }, { state, controllerId: p1.playerId }),
				false,
				`expected red filter non-match in ${zone}`
			);
			if (zone === 'battlefield') {
				assert.deepEqual(evaluatePermanent(state, inst).colors, []);
			}
		}

		// Library search spec match
		assert.equal(
			matchesLibrarySearchSpec(
				devoidCard,
				{
					count: 1,
					destinations: [{ zone: 'hand' }],
					statedQuality: true,
					allowedTypes: [],
					allowedSubtypes: [],
					disallowedTypes: [],
					allowedColors: ['C'],
					rawCriteriaText: 'colorless card',
					upTo: false
				},
				resolveObjectFaces(devoidCard).colors
			),
			true
		);
		assert.equal(
			matchesLibrarySearchSpec(
				devoidCard,
				{
					count: 1,
					destinations: [{ zone: 'hand' }],
					statedQuality: true,
					allowedTypes: [],
					allowedSubtypes: [],
					disallowedTypes: [],
					allowedColors: ['R'],
					rawCriteriaText: 'red card',
					upTo: false
				},
				resolveObjectFaces(devoidCard).colors
			),
			false
		);
	});

	it('enforces Devoid on the stack for spell targeting, protection, and cast triggers', () => {
		const state = createTestGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// Trigger observer: colorless spell cast vs red spell cast
		putInZone(
			state,
			p1,
			makeCard({
				name: 'Colorless Watcher',
				typeLine: 'Artifact',
				oracleText: 'Whenever you cast a colorless spell, you gain 2 life.'
			}),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			makeCard({
				name: 'Red Watcher',
				typeLine: 'Enchantment',
				oracleText: 'Whenever you cast a red spell, you gain 5 life.'
			}),
			'battlefield'
		);

		const devoidSpell = putInZone(state, p1, makeDevoidRedSpell(), 'hand');
		const normalRedSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Volcanic Hammer Probe',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				colors: ['R'],
				oracleText: '~ deals 3 damage to target opponent.'
			}),
			'hand'
		);

		makePool(state, p1, { R: 4, C: 4 });
		const lifeBefore = p1.life;
		const castDevoidRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: devoidSpell.instanceId,
			targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
		});
		assert.equal(castDevoidRes.ok, true, castDevoidRes.error ?? '');

		const devoidStackItem = state.stack.find((s) => s.sourceInstanceId === devoidSpell.instanceId)!;
		assert.ok(devoidStackItem);

		// Counter target red spell vs counter target colorless spell on stack
		const counterRedCard = makeCard({
			name: 'Hydroblast Probe',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			colors: ['U'],
			oracleText: 'Counter target red spell.'
		});
		const counterColorlessCard = makeCard({
			name: 'Nullify Void Probe',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			colors: ['U'],
			oracleText: 'Counter target colorless spell.'
		});

		const redSpec = compileCard(counterRedCard).faces[0].abilities.find((a) => a.kind === 'spell')!.targets[0];
		const colorlessSpec = compileCard(counterColorlessCard).faces[0].abilities.find((a) => a.kind === 'spell')!.targets[0];

		assert.equal(
			specTargetCandidates(state, p2.playerId, counterRedCard, undefined, redSpec).some(
				(t) => t.id === devoidStackItem.id
			),
			false,
			'target red spell must NOT see Devoid spell as a candidate'
		);
		assert.equal(
			specTargetCandidates(state, p2.playerId, counterColorlessCard, undefined, colorlessSpec).some(
				(t) => t.id === devoidStackItem.id
			),
			true,
			'target colorless spell MUST see Devoid spell as a candidate'
		);

		// Legality check via validateTargetLegality
		const counterRedInfo = {
			requiresTarget: true,
			targetKind: 'spell' as const,
			minTargets: 1,
			maxTargets: 1,
			zone: 'stack' as const,
			sameGraveyard: false,
			controllerFilter: 'any' as const,
			targetSpecs: [redSpec]
		};
		assert.equal(
			validateTargetLegality(
				state,
				p2.playerId,
				{ kind: 'stack', id: devoidStackItem.id, label: devoidStackItem.title },
				counterRedInfo,
				counterRedCard
			).ok,
			false
		);

		passBothPlayers(state, 6);
		assert.equal(p1.life, lifeBefore + 2, 'only colorless cast trigger should fire for Devoid spell');
		assert.equal(p2.life, 37);

		// Protection from red vs protection from colorless
		const protRed = putInZone(
			state,
			p2,
			makeCard({
				name: 'Silver Knight Probe',
				typeLine: 'Creature — Human Knight',
				oracleText: 'Protection from red',
				colors: ['W']
			}),
			'battlefield'
		);
		const protColorless = putInZone(
			state,
			p2,
			makeCard({
				name: 'Null Ward Knight Probe',
				typeLine: 'Creature — Human Knight',
				oracleText: 'Protection from colorless',
				colors: ['W']
			}),
			'battlefield'
		);

		const devoidBolt = makeCard({
			name: 'Ghostfire Probe',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText: 'Devoid\n~ deals 2 damage to target creature.',
			colors: ['R'],
			keywords: ['Devoid']
		});
		const boltSpec = compileCard(devoidBolt).faces[0].abilities.find((a) => a.kind === 'spell')!.targets[0];
		const boltCands = specTargetCandidates(state, p1.playerId, devoidBolt, undefined, boltSpec);
		assert.equal(boltCands.some((c) => c.id === protRed.instanceId), true, 'Devoid red card bypasses protection from red');
		assert.equal(boltCands.some((c) => c.id === protColorless.instanceId), false, 'Devoid red card is blocked by protection from colorless');

		// Contrast: non-devoid red spell blocked by protection from red
		assert.equal(
			specTargetCandidates(state, p1.playerId, normalRedSpell.card, undefined, boltSpec).some(
				(c) => c.id === protRed.instanceId
			),
			false
		);
	});

	it('respects CR 613.3 (Layer 5 CDA before non-CDA timestamp) and CR 613.6 (persists under Layer 6 ability removal)', () => {
		const state = createTestGame();
		const p1 = state.players[0];

		// 1) Devoid creature enters AFTER a Painter's Servant-style addColors effect (earlier timestamp 5 vs creature timestamp 20)
		state.nextTimestamp = 20;
		const devoidCreature = putInZone(state, p1, makeDevoidRedCreature(), 'battlefield');

		state.timedContinuousEffects = [
			{
				timestamp: 5,
				sourceName: 'Chromatic Servant Probe',
				controllerId: p1.playerId,
				affected: [{ instanceId: devoidCreature.instanceId, objectVersion: devoidCreature.objectVersion ?? 1 }],
				layer5: { addColors: ['U'] as ManaColor[] }
			}
		];

		// CR 613.3: Even with earlier timestamp, Layer 5 CDA (Devoid: setColors []) runs BEFORE non-CDA addColors ['U'],
		// so effective colors must be ['U'], NOT ['R', 'U'] and NOT [].
		assert.deepEqual(evaluatePermanent(state, devoidCreature).colors, ['U']);

		// Clear timed effect and apply Humility (Layer 6 global removeAllAbilities) — CR 613.6: Devoid stays colorless!
		state.timedContinuousEffects = [];
		putInZone(
			state,
			p1,
			makeCard({
				name: 'Humility Probe',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.',
				colors: ['W']
			}),
			'battlefield'
		);

		const underHumility = evaluatePermanent(state, devoidCreature);
		assert.deepEqual(underHumility.colors, [], 'CR 613.6: Devoid Layer 5 CDA survives Layer 6 ability removal');
		assert.deepEqual(underHumility.activeKeywords, [], 'Layer 6 removes keyword ability text while Layer 5 already took effect');
	});
});
