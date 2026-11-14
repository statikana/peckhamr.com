import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity
} from '../engine.ts';
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
import { previewAbilityAutoTap, previewSpellAutoTap } from './autoTapPreview.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `u1_at_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
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

function createTestGame(): { state: GameState; p1: PlayerGameState; p2: PlayerGameState } {
	const seats = [makeSeat(0, false), makeSeat(1, false)];
	const state = createInitialGameState(
		'U1AT',
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
		p.energyCounters = 0;
	}
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.stack = [];
	state.pendingPrompts = [];
	noteLayerInputsChanged(state);
	return { state, p1: state.players[0], p2: state.players[1] };
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	inst.summoningSick = false;
	player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

const basicIsland = () =>
	synthCard({
		name: 'Tidal Atoll',
		typeLine: 'Basic Land — Island',
		manaCost: '',
		cmc: 0,
		oracleText: '({T}: Add {U}.)'
	});

const basicForest = () =>
	synthCard({
		name: 'Verdant Grove',
		typeLine: 'Basic Land — Forest',
		manaCost: '',
		cmc: 0,
		oracleText: '({T}: Add {G}.)'
	});

describe('UI Track U1: autoTapPreview', () => {
	it('previews basic land auto-tap without mutating live gameState', () => {
		const { state, p1 } = createTestGame();
		const landU = put(state, p1, basicIsland(), 'battlefield');
		const landG1 = put(state, p1, basicForest(), 'battlefield');
		const landG2 = put(state, p1, basicForest(), 'battlefield');
		const spell = put(
			state,
			p1,
			synthCard({
				name: 'Canopy Study',
				typeLine: 'Sorcery',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				colorIdentity: ['U'],
				oracleText: 'Draw two cards.'
			}),
			'hand'
		);

		const beforeJson = JSON.stringify(state);
		const res = previewSpellAutoTap(state, p1.playerId, spell.instanceId);
		const afterJson = JSON.stringify(state);

		assert.equal(afterJson, beforeJson);
		assert.equal(res.canAutoTap, true);
		assert.equal(res.tappedPermanentIds.length, 2);
		assert.equal(res.tappedPermanentIds.includes(landU.instanceId), true);
		assert.equal(
			res.tappedPermanentIds.includes(landG1.instanceId) ||
				res.tappedPermanentIds.includes(landG2.instanceId),
			true
		);
		assert.equal(res.energySpent, 0);
		assert.deepEqual(res.manaPoolSpent, {});
	});

	it('spends already-pooled mana with 0 lands tapped and reports manaPoolSpent', () => {
		const { state, p1 } = createTestGame();
		put(state, p1, basicIsland(), 'battlefield');
		put(state, p1, basicForest(), 'battlefield');
		p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 1, C: 0 };

		const spell = put(
			state,
			p1,
			synthCard({
				name: 'Stream Insight',
				typeLine: 'Instant',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				colorIdentity: ['U'],
				oracleText: 'Draw a card.'
			}),
			'hand'
		);

		const beforeJson = JSON.stringify(state);
		const res = previewSpellAutoTap(state, p1.playerId, spell.instanceId);
		const afterJson = JSON.stringify(state);

		assert.equal(afterJson, beforeJson);
		assert.equal(res.canAutoTap, true);
		assert.deepEqual(res.tappedPermanentIds, []);
		assert.equal(res.energySpent, 0);
		assert.deepEqual(res.manaPoolSpent, { U: 1, G: 1 });
	});

	it('respects artifactSpellOrNonSpell restricted mana on artifact vs nonartifact spells', () => {
		const { state, p1 } = createTestGame();
		const forest1 = put(state, p1, basicForest(), 'battlefield');
		const forest2 = put(state, p1, basicForest(), 'battlefield');
		p1.restrictedMana = {
			artifactSpellOrNonSpell: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 }
		};

		const artifactSpell = put(
			state,
			p1,
			synthCard({
				name: 'Bronze Compass',
				typeLine: 'Artifact',
				manaCost: '{2}',
				cmc: 2,
				oracleText: '{T}: Add {C}.'
			}),
			'hand'
		);

		const nonArtifactSpell = put(
			state,
			p1,
			synthCard({
				name: 'Woodland March',
				typeLine: 'Sorcery',
				manaCost: '{2}',
				cmc: 2,
				oracleText: 'Gain 4 life.'
			}),
			'hand'
		);

		const beforeJson = JSON.stringify(state);
		const artPreview = previewSpellAutoTap(state, p1.playerId, artifactSpell.instanceId);
		const nonArtPreview = previewSpellAutoTap(state, p1.playerId, nonArtifactSpell.instanceId);
		const afterJson = JSON.stringify(state);

		assert.equal(afterJson, beforeJson);

		// Artifact spell uses the 2 restricted {C} mana without tapping either Forest:
		assert.equal(artPreview.canAutoTap, true);
		assert.deepEqual(artPreview.tappedPermanentIds, []);
		assert.deepEqual(artPreview.manaPoolSpent, { C: 2 });

		// Nonartifact spell cannot spend artifactSpellOrNonSpell mana, so it auto-taps both Forests:
		assert.equal(nonArtPreview.canAutoTap, true);
		assert.deepEqual(nonArtPreview.tappedPermanentIds, [forest1.instanceId, forest2.instanceId]);
		assert.deepEqual(nonArtPreview.manaPoolSpent, {});
	});

	it('previews {E}-paying mana lands and reports energySpent without mutating state', () => {
		const { state, p1 } = createTestGame();
		const energyLand = put(
			state,
			p1,
			synthCard({
				name: 'Conduit Spire',
				typeLine: 'Land',
				manaCost: '',
				cmc: 0,
				oracleText: '{T}: Add {C}.\n{T}, Pay {E}: Add one mana of any color.'
			}),
			'battlefield'
		);
		const spell = put(
			state,
			p1,
			synthCard({
				name: 'Azure Bolt',
				typeLine: 'Instant',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				colorIdentity: ['U'],
				oracleText: 'Draw a card.'
			}),
			'hand'
		);

		// With 0 {E}, cannot produce {U}:
		p1.energyCounters = 0;
		const noEnergy = previewSpellAutoTap(state, p1.playerId, spell.instanceId);
		assert.equal(noEnergy.canAutoTap, false);

		// With 1 {E}, auto-taps Conduit Spire and spends 1 {E}:
		p1.energyCounters = 1;
		const beforeJson = JSON.stringify(state);
		const withEnergy = previewSpellAutoTap(state, p1.playerId, spell.instanceId);
		const afterJson = JSON.stringify(state);

		assert.equal(afterJson, beforeJson);
		assert.equal(withEnergy.canAutoTap, true);
		assert.deepEqual(withEnergy.tappedPermanentIds, [energyLand.instanceId]);
		assert.equal(withEnergy.energySpent, 1);
	});

	it('previews ability auto-tap without self-tapping the source permanent for mana and runs < 0.5 ms warm', () => {
		const { state, p1 } = createTestGame();
		const forest1 = put(state, p1, basicForest(), 'battlefield');
		const forest2 = put(state, p1, basicForest(), 'battlefield');
		const sage = put(
			state,
			p1,
			synthCard({
				name: 'Grove Archivist',
				typeLine: 'Creature — Elf Druid',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				colorIdentity: ['G'],
				power: '1',
				toughness: '2',
				oracleText: '{T}: Add {G}.\n{2}, {T}: Draw a card.'
			}),
			'battlefield'
		);

		const abilities = getEffectiveActivatedAbilities(
			state,
			p1,
			sage,
			getPlayerCommanderIdentity(p1)
		);
		const drawAbility = abilities.find((a) => !a.isManaAbility);
		assert.ok(drawAbility, 'Expected non-mana activated ability on Grove Archivist');

		const beforeJson = JSON.stringify(state);
		const abPreview = previewAbilityAutoTap(state, p1.playerId, sage.instanceId, drawAbility);
		const afterJson = JSON.stringify(state);

		assert.equal(afterJson, beforeJson);
		assert.equal(abPreview.canAutoTap, true);
		assert.deepEqual(abPreview.tappedPermanentIds, [forest1.instanceId, forest2.instanceId]);
		assert.equal(abPreview.tappedPermanentIds.includes(sage.instanceId), false);

		// Warm latency benchmark (< 0.5 ms per hover call):
		const spell = put(
			state,
			p1,
			synthCard({
				name: 'Canopy Pulse',
				typeLine: 'Instant',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				colorIdentity: ['G'],
				oracleText: 'Gain 3 life.'
			}),
			'hand'
		);
		// Warm up JIT
		for (let i = 0; i < 10; i++) {
			previewSpellAutoTap(state, p1.playerId, spell.instanceId);
		}
		const iterations = 40;
		const t0 = performance.now();
		for (let i = 0; i < iterations; i++) {
			previewSpellAutoTap(state, p1.playerId, spell.instanceId);
		}
		const avgMs = (performance.now() - t0) / iterations;
		assert.ok(avgMs < 0.5, `Expected warm previewSpellAutoTap < 0.5 ms, observed ${avgMs.toFixed(3)} ms`);
	});
});
