import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	COMPILER_VERSION,
	clearCompileCache,
	compileCard
} from '../compiler/index.ts';
import { getCardFaces, normalizeScryfallCard } from '../scryfall.ts';
import type { ScryfallCard } from '../types.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	effectiveManaValue,
	resolveObjectFaces
} from './faces.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	const name = overrides.name;
	const id = overrides.id ?? `faces_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
		manaCost: '{1}{U}',
		cmc: 2,
		typeLine: 'Creature — Human Wizard',
		oracleText: '',
		colors: ['U'],
		colorIdentity: ['U'],
		power: '1',
		toughness: '2',
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

describe('Scryfall multi-face normalization & compiler support (B4 Phase 1)', () => {
	it('normalizes transform, modal_dfc, split, adventure, and flip layouts with faces + colorIndicator', () => {
		const transformRaw = {
			id: 'raw_tdfc',
			name: 'Delver of Secrets // Insectile Aberration',
			layout: 'transform',
			cmc: 1,
			color_identity: ['U'],
			card_faces: [
				{
					name: 'Delver of Secrets',
					mana_cost: '{U}',
					type_line: 'Creature — Human Wizard',
					oracle_text: 'At the beginning of your upkeep, look at the top card of your library.',
					colors: ['U'],
					power: '1',
					toughness: '1'
				},
				{
					name: 'Insectile Aberration',
					mana_cost: '',
					type_line: 'Creature — Human Insect',
					oracle_text: 'Flying',
					colors: ['U'],
					color_indicator: ['U'],
					power: '3',
					toughness: '2'
				}
			]
		};
		const tdfc = normalizeScryfallCard(transformRaw);
		assert.equal(tdfc.layout, 'transform');
		assert.equal(tdfc.faces?.length, 2);
		assert.deepEqual(tdfc.faces?.[1].colorIndicator, ['U']);
		assert.deepEqual(tdfc.faces?.[1].colors, ['U']);
		assert.equal(tdfc.backFace?.name, 'Insectile Aberration');
		assert.equal(getCardFaces(tdfc).length, 2);

		const splitRaw = {
			id: 'raw_split',
			name: 'Fire // Ice',
			layout: 'split',
			cmc: 4,
			color_identity: ['U', 'R'],
			card_faces: [
				{ name: 'Fire', mana_cost: '{1}{R}', type_line: 'Instant', oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.' },
				{ name: 'Ice', mana_cost: '{1}{U}', type_line: 'Instant', oracle_text: 'Tap target permanent.\nDraw a card.' }
			]
		};
		const split = normalizeScryfallCard(splitRaw);
		assert.equal(split.layout, 'split');
		assert.equal(split.faces?.length, 2);
		assert.equal(split.cmc, 4);

		const advRaw = {
			id: 'raw_adv',
			name: 'Bonecrusher Giant // Stomp',
			layout: 'adventure',
			cmc: 3,
			color_identity: ['R'],
			card_faces: [
				{ name: 'Bonecrusher Giant', mana_cost: '{2}{R}', type_line: 'Creature — Giant', oracle_text: '', power: '4', toughness: '3' },
				{ name: 'Stomp', mana_cost: '{1}{R}', type_line: 'Instant — Adventure', oracle_text: 'Stomp deals 2 damage to any target.' }
			]
		};
		const adv = normalizeScryfallCard(advRaw);
		assert.equal(adv.layout, 'adventure');
		assert.equal(adv.faces?.length, 2);

		const flipRaw = {
			id: 'raw_flip',
			name: 'Nezumi Graverobber // Nighteyes the Desecrator',
			layout: 'flip',
			cmc: 2,
			color_identity: ['B'],
			card_faces: [
				{ name: 'Nezumi Graverobber', mana_cost: '{1}{B}', type_line: 'Creature — Rat Rogue', oracle_text: '', power: '2', toughness: '1' },
				{ name: 'Nighteyes the Desecrator', mana_cost: '', type_line: 'Legendary Creature — Rat Wizard', oracle_text: '', power: '4', toughness: '2' }
			]
		};
		const flip = normalizeScryfallCard(flipRaw);
		assert.equal(flip.layout, 'flip');
		assert.equal(flip.faces?.length, 2);

		// Legacy synthetic card with backFace but no explicit faces[] synthesizes two faces cleanly
		const legacy = synthCard({
			name: 'Legacy DFC',
			manaCost: '{2}{W}',
			cmc: 3,
			backFace: {
				name: 'Legacy Back',
				manaCost: '',
				typeLine: 'Creature — Angel',
				oracleText: 'Flying',
				power: '4',
				toughness: '4',
				imageUrl: ''
			}
		});
		const legacyFaces = getCardFaces(legacy);
		assert.equal(legacyFaces.length, 2);
		assert.equal(legacyFaces[1].name, 'Legacy Back');
	});

	it('tracks COMPILER_VERSION (35) and tracks layout, colorIndicator, and faces in memo caching', () => {
		assert.equal(COMPILER_VERSION, 35);
		clearCompileCache();
		const card = synthCard({
			id: 'memo_test',
			name: 'Memo DFC',
			layout: 'meld',
			colorIndicator: ['G'],
			faces: [
				{
					name: 'Memo DFC',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Human',
					oracleText: 'Trample',
					colors: ['G'],
					power: '2',
					toughness: '2',
					keywords: ['Trample'],
					imageUrl: ''
				},
				{
					name: 'Memo Beast',
					manaCost: '',
					cmc: 0,
					typeLine: 'Creature — Werewolf',
					oracleText: 'Menace',
					colors: ['G'],
					colorIndicator: ['G'],
					power: '4',
					toughness: '4',
					keywords: ['Menace'],
					imageUrl: ''
				}
			]
		});
		const def1 = compileCard(card);
		assert.equal(def1.layout, 'meld');
		assert.deepEqual(def1.faces[0].characteristics.colorIndicator, ['G']);
		assert.equal(
			def1.faces[0].abilities.some((a) => a.kind === 'unsupported' && a.reason === 'multiface'),
			true
		);

		// Mutate layout & faces on same object id to ensure memoMatches invalidates;
		// transform compiles both faces natively in Phase 3 without unsupported('multiface')
		card.layout = 'transform';
		const def2 = compileCard(card);
		assert.notEqual(def2, def1);
		assert.equal(def2.layout, 'transform');
		assert.equal(def2.faces.length, 2);
		assert.deepEqual(def2.faces[1].characteristics.colorIndicator, ['G']);
		assert.equal(
			def2.faces.some((f) => f.abilities.some((a) => a.kind === 'unsupported' && a.reason === 'multiface')),
			false
		);
	});
});

describe('Zone-aware face resolution (resolveObjectFaces / activeCharacteristics / effectiveManaValue)', () => {
	it('handles transform MV (CR 712.6b/d) including single-face copy MV 0', () => {
		const tdfc = synthCard({
			name: 'Front Wolf',
			layout: 'transform',
			manaCost: '{2}{G}',
			cmc: 3,
			typeLine: 'Creature — Human',
			colors: ['G'],
			power: '2',
			toughness: '2',
			faces: [
				{
					name: 'Front Wolf',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Human',
					oracleText: '',
					colors: ['G'],
					power: '2',
					toughness: '2',
					imageUrl: ''
				},
				{
					name: 'Back Werewolf',
					manaCost: '',
					cmc: 0,
					typeLine: 'Creature — Werewolf',
					oracleText: '',
					colors: ['R', 'G'],
					colorIndicator: ['R', 'G'],
					power: '4',
					toughness: '4',
					imageUrl: ''
				}
			]
		});

		assert.equal(resolveObjectFaces(tdfc, { zone: 'graveyard', faceIndex: 1 }).name, 'Front Wolf');
		assert.equal(effectiveManaValue(tdfc, { zone: 'graveyard', faceIndex: 1 }), 3);

		const bfBack = resolveObjectFaces(tdfc, { zone: 'battlefield', faceIndex: 1 });
		assert.equal(bfBack.name, 'Back Werewolf');
		assert.equal(bfBack.manaValue, 3, 'CR 712.6d: transformed permanent back face uses front face MV');
		assert.deepEqual(bfBack.colors, ['R', 'G']);

		const singleFaceCopy = resolveObjectFaces(tdfc, {
			zone: 'battlefield',
			faceIndex: 1,
			isSingleFaceCopy: true
		});
		assert.equal(singleFaceCopy.manaValue, 0, 'CR 712.6d: single-face copy of back face has MV 0');
	});

	it('handles modal_dfc across hand/graveyard vs stack/battlefield (CR 712.6a, 712.6e)', () => {
		const mdfc = synthCard({
			name: 'Modal Front',
			layout: 'modal_dfc',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			colors: ['U'],
			faces: [
				{ name: 'Modal Front', manaCost: '{1}{U}', cmc: 2, typeLine: 'Instant', oracleText: '', colors: ['U'], imageUrl: '' },
				{ name: 'Modal Back', manaCost: '', cmc: 0, typeLine: 'Land', oracleText: '', colors: [], imageUrl: '' }
			]
		});
		assert.equal(resolveObjectFaces(mdfc, { zone: 'hand', faceIndex: 1 }).name, 'Modal Front');
		assert.equal(effectiveManaValue(mdfc, { zone: 'battlefield', faceIndex: 1 }), 0);
		assert.deepEqual(activeCharacteristics(mdfc, { zone: 'battlefield', faceIndex: 1 }).types, ['Land']);
	});

	it('handles split cards combined vs half vs fused vs Rooms (CR 709.3-709.5, 702.102d)', () => {
		const split = synthCard({
			name: 'Fire // Ice',
			layout: 'split',
			manaCost: '{1}{R} // {1}{U}',
			cmc: 4,
			typeLine: 'Instant // Instant',
			colors: ['R', 'U'],
			faces: [
				{ name: 'Fire', manaCost: '{1}{R}', cmc: 2, typeLine: 'Instant', oracleText: '', colors: ['R'], imageUrl: '' },
				{ name: 'Ice', manaCost: '{1}{U}', cmc: 2, typeLine: 'Instant', oracleText: '', colors: ['U'], imageUrl: '' }
			]
		});
		assert.equal(effectiveManaValue(split, { zone: 'graveyard' }), 4);
		assert.deepEqual(activeCharacteristics(split, { zone: 'graveyard' }).colors, ['R', 'U']);

		const onStackFire = resolveObjectFaces(split, { zone: 'stack', faceIndex: 0 });
		assert.equal(onStackFire.manaValue, 2);
		assert.deepEqual(onStackFire.colors, ['R']);

		const onStackFused = resolveObjectFaces(split, { zone: 'stack', faceIndex: 0, fused: true });
		assert.equal(onStackFused.manaValue, 4);
		assert.deepEqual(onStackFused.colors, ['R', 'U']);

		const room = synthCard({
			name: 'Left Wing // Right Wing',
			layout: 'split',
			manaCost: '{2}{W} // {3}{U}',
			cmc: 7,
			typeLine: 'Enchantment — Room',
			colors: ['W', 'U'],
			faces: [
				{ name: 'Left Wing', manaCost: '{2}{W}', cmc: 3, typeLine: 'Enchantment — Room', oracleText: '', colors: ['W'], imageUrl: '' },
				{ name: 'Right Wing', manaCost: '{3}{U}', cmc: 4, typeLine: 'Enchantment — Room', oracleText: '', colors: ['U'], imageUrl: '' }
			]
		});
		const oneUnlocked = resolveObjectFaces(room, { zone: 'battlefield', unlockedFaces: [1] });
		assert.equal(oneUnlocked.name, 'Right Wing');
		assert.equal(oneUnlocked.manaValue, 4);
		assert.deepEqual(oneUnlocked.colors, ['U']);
		assert.deepEqual(oneUnlocked.types, ['Enchantment']);
		assert.deepEqual(oneUnlocked.subtypes, ['Room']);

		const bothUnlocked = resolveObjectFaces(room, { zone: 'battlefield', unlockedFaces: [0, 1] });
		assert.equal(bothUnlocked.name, 'Left Wing // Right Wing');
		assert.equal(bothUnlocked.manaValue, 7);
		assert.deepEqual(bothUnlocked.colors, ['W', 'U']);

		const noneUnlocked = resolveObjectFaces(room, { zone: 'battlefield', unlockedFaces: [] });
		assert.equal(noneUnlocked.manaValue, 0);
		assert.deepEqual(noneUnlocked.colors, []);
		assert.deepEqual(noneUnlocked.types, ['Enchantment']);
	});

	it('handles adventure (CR 716.2–4) and flip (CR 710.1c keeps front color and MV)', () => {
		const adv = synthCard({
			name: 'Giant',
			layout: 'adventure',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Creature — Giant',
			colors: ['R'],
			power: '4',
			toughness: '3',
			faces: [
				{ name: 'Giant', manaCost: '{2}{R}', cmc: 3, typeLine: 'Creature — Giant', oracleText: '', colors: ['R'], power: '4', toughness: '3', imageUrl: '' },
				{ name: 'Stomp', manaCost: '{1}{R}', cmc: 2, typeLine: 'Instant — Adventure', oracleText: '', colors: ['R'], imageUrl: '' }
			]
		});
		assert.equal(resolveObjectFaces(adv, { zone: 'graveyard', faceIndex: 1 }).name, 'Giant');
		assert.equal(resolveObjectFaces(adv, { zone: 'stack', faceIndex: 1 }).name, 'Stomp');
		assert.equal(effectiveManaValue(adv, { zone: 'stack', faceIndex: 1 }), 2);

		const flip = synthCard({
			name: 'Budoka Pupil',
			layout: 'flip',
			manaCost: '{1}{G}{G}',
			cmc: 3,
			typeLine: 'Creature — Human Monk',
			colors: ['G'],
			power: '2',
			toughness: '2',
			faces: [
				{ name: 'Budoka Pupil', manaCost: '{1}{G}{G}', cmc: 3, typeLine: 'Creature — Human Monk', oracleText: '', colors: ['G'], power: '2', toughness: '2', imageUrl: '' },
				{ name: 'Ichiga, Who Topples Oaks', manaCost: '', cmc: 0, typeLine: 'Legendary Creature — Spirit', oracleText: '', colors: [], power: '4', toughness: '3', imageUrl: '' }
			]
		});
		const flipped = resolveObjectFaces(flip, { zone: 'battlefield', faceIndex: 1 });
		assert.equal(flipped.name, 'Ichiga, Who Topples Oaks');
		assert.equal(flipped.manaCost, '{1}{G}{G}');
		assert.equal(flipped.manaValue, 3);
		assert.deepEqual(flipped.colors, ['G']);
		assert.equal(flipped.power, 4);
	});

	it('handles face-down resolution across battlefield (Disguise Ward), stack, and exile', () => {
		const card = synthCard({
			name: 'Secret Dragon',
			manaCost: '{4}{R}{R}',
			cmc: 6,
			typeLine: 'Creature — Dragon',
			colors: ['R'],
			power: '5',
			toughness: '5',
			keywords: ['Flying']
		});
		const disguiseBf = resolveObjectFaces(card, {
			zone: 'battlefield',
			isFaceDown: true,
			faceDownSpec: { kind: 'disguise', wardCost: '{2}', turnUpCost: '{4}{R}' }
		});
		assert.equal(disguiseBf.manaValue, 0);
		assert.deepEqual(disguiseBf.colors, []);
		assert.deepEqual(disguiseBf.types, ['Creature']);
		assert.deepEqual(disguiseBf.subtypes, []);
		assert.equal(disguiseBf.power, 2);
		assert.equal(disguiseBf.toughness, 2);
		assert.deepEqual(disguiseBf.keywords, ['Ward {2}']);
		assert.deepEqual(
			activeAbilityDefs(card, { zone: 'battlefield', isFaceDown: true }),
			[]
		);

		const stackDown = resolveObjectFaces(card, { zone: 'stack', isFaceDown: true });
		assert.equal(stackDown.manaValue, 0);
		assert.deepEqual(stackDown.types, ['Creature']);

		const exileDown = resolveObjectFaces(card, { zone: 'exile', isFaceDown: true });
		assert.equal(exileDown.manaValue, 0);
		assert.deepEqual(exileDown.types, []);
	});
});
