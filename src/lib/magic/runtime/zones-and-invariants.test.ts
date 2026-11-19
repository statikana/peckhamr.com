import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent
} from '../engine.ts';
import {
	canCardBeCommander,
	normalizeScryfallCard,
	validateCommanderDeck
} from '../scryfall.ts';
import { DEFAULT_LOBBY_RULES, type LobbySeat, type MagicDeck, type ScryfallCard } from '../types.ts';
import { buildBoardViewModel } from '../ui/boardViewModel.ts';
import { resolveCardInstanceDisplay } from '../ui/promptViewModel.ts';
import { pickScryOrSurveilSplit } from './choices.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { moveObject } from './zones.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `inv_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		oracleId: `ora_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Creature — Construct',
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

function twoPlayerState() {
	const commander = synthCard({
		name: 'Test Commander',
		typeLine: 'Legendary Creature — Wizard',
		power: '2',
		toughness: '2',
		canBeCommander: true
	});
	const filler = synthCard({
		name: 'Test Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const deck: MagicDeck = {
		id: 'deck_inv',
		userId: 'u1',
		name: 'Invariant Deck',
		description: '',
		commanders: [commander],
		cards: [{ card: filler, quantity: 99 }],
		colorIdentity: [],
		cardCount: 100,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'u1',
			username: 'P1',
			avatarUrl: '',
			isBot: false,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [commander.name],
			commanderArtUrl: '',
			colorIdentity: [],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: null,
			username: 'Bot',
			avatarUrl: '',
			isBot: true,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [commander.name],
			commanderArtUrl: '',
			colorIdentity: [],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const state = createInitialGameState('INV', seats, new Map([[0, deck], [1, deck]]), {
		...DEFAULT_LOBBY_RULES
	});
	return { state, p1: state.players[0], p2: state.players[1] };
}

describe('M3 Stage 1B — moveObject CR 400.7 defaults', () => {
	it('defaults bumpVersion, newTimestamp, leaveBattlefieldReset, and resets summoningSick = false on battlefield -> graveyard/exile', () => {
		const { state, p1 } = twoPlayerState();
		const bear = createCardInstance(
			synthCard({ name: 'Summoned Bear', power: '2', toughness: '2' }),
			p1.playerId,
			'battlefield'
		);
		bear.summoningSick = true;
		bear.tapped = true;
		bear.damageMarked = 1;
		bear.counters['+1/+1'] = 2;
		p1.battlefield.push(bear);
		const v0 = bear.objectVersion ?? 1;
		const ts0 = bear.enteredTimestamp ?? 0;

		const dest = moveObject(state, bear, 'graveyard', {
			from: { player: p1, zone: 'battlefield' }
		});
		assert.equal(dest, 'graveyard');
		assert.equal(bear.zone, 'graveyard');
		assert.equal(bear.objectVersion, v0 + 1);
		assert.notEqual(bear.enteredTimestamp, ts0);
		assert.equal(bear.summoningSick, false);
		assert.equal(bear.tapped, false);
		assert.equal(bear.damageMarked, 0);
		assert.equal(bear.counters['+1/+1'], 0);
	});

	it('defaults bumpVersion = true and newTimestamp = true on non-battlefield zone transitions and stack -> graveyard', () => {
		const { state, p1 } = twoPlayerState();
		const card = p1.library[0];
		const v0 = card.objectVersion ?? 1;
		const ts0 = card.enteredTimestamp ?? 0;

		moveObject(state, card, 'hand', { from: { player: p1, zone: 'library' }, toPlayer: p1 });
		assert.equal(card.objectVersion, v0 + 1);
		assert.notEqual(card.enteredTimestamp, ts0);

		const v1 = card.objectVersion ?? 1;
		const ts1 = card.enteredTimestamp ?? 0;
		moveObject(state, card, 'graveyard', { from: { player: p1, zone: 'hand' }, toPlayer: p1 });
		assert.equal(card.objectVersion, v1 + 1);
		assert.notEqual(card.enteredTimestamp, ts1);

		const stackCard = createCardInstance(
			synthCard({ name: 'Stack Bolt', typeLine: 'Instant' }),
			p1.playerId,
			'stack'
		);
		const sv0 = stackCard.objectVersion ?? 1;
		const sts0 = stackCard.enteredTimestamp ?? 0;
		moveObject(state, stackCard, 'graveyard', { from: 'stack', toPlayer: p1 });
		assert.equal(stackCard.objectVersion, sv0 + 1);
		assert.notEqual(stackCard.enteredTimestamp, sts0);
	});

	it('preserves CR 400.7d bumpVersion = false and assigns fresh timestamp on stack -> battlefield', () => {
		const { state, p1 } = twoPlayerState();
		const perm = createCardInstance(
			synthCard({ name: 'Resolving Relic', typeLine: 'Artifact' }),
			p1.playerId,
			'stack'
		);
		const v0 = perm.objectVersion ?? 1;
		const ts0 = perm.enteredTimestamp ?? 0;
		moveObject(state, perm, 'battlefield', { from: 'stack', toPlayer: p1 });
		assert.equal(perm.zone, 'battlefield');
		assert.equal(perm.objectVersion, v0);
		assert.notEqual(perm.enteredTimestamp, ts0);
	});

	it('keeps bumpVersion, newTimestamp, and leaveBattlefieldReset false on same-zone reorders and from: none', () => {
		const { state, p1 } = twoPlayerState();
		const libCard = p1.library[0];
		const v0 = libCard.objectVersion ?? 1;
		const ts0 = libCard.enteredTimestamp ?? 0;
		moveObject(state, libCard, 'library', {
			from: { player: p1, zone: 'library' },
			toPlayer: p1,
			insert: 'end'
		});
		assert.equal(libCard.objectVersion, v0);
		assert.equal(libCard.enteredTimestamp, ts0);

		const tok = createCardInstance(
			synthCard({ name: 'Fresh Token', typeLine: 'Token Creature — Soldier' }),
			p1.playerId,
			'battlefield',
			false,
			true,
			42
		);
		moveObject(state, tok, 'battlefield', { from: 'none', toPlayer: p1 });
		assert.equal(tok.objectVersion, 1);
		assert.equal(tok.enteredTimestamp, 42);
	});
});

describe('M3 Stage 1B — Evaluated typeLine behavior in runtime & UI', () => {
	it('boardViewModel attachmentDetails uses evaluated Equipment subtype and PermanentView uses evaluatePermanent', () => {
		const { state, p1 } = twoPlayerState();
		const host = createCardInstance(
			synthCard({ name: 'Host Knight', typeLine: 'Creature — Knight', power: '2', toughness: '2' }),
			p1.playerId,
			'battlefield'
		);
		const equip = createCardInstance(
			synthCard({ name: 'Forged Blade', typeLine: 'Artifact — Equipment' }),
			p1.playerId,
			'battlefield'
		);
		equip.attachedToId = host.instanceId;
		const aura = createCardInstance(
			synthCard({ name: 'Holy Mantle', typeLine: 'Enchantment — Aura' }),
			p1.playerId,
			'battlefield'
		);
		aura.attachedToId = host.instanceId;
		p1.battlefield.push(host, equip, aura);

		const vm = buildBoardViewModel(state, p1.playerId);
		const hostView = vm.permanentsById[host.instanceId];
		assert.ok(hostView);
		assert.equal(hostView.attachmentDetails.length, 2);
		assert.deepEqual(
			hostView.attachmentDetails.map((d) => ({ name: d.name, isEquipment: d.isEquipment, isAura: d.isAura })),
			[
				{ name: 'Forged Blade', isEquipment: true, isAura: false },
				{ name: 'Holy Mantle', isEquipment: false, isAura: true }
			]
		);
	});

	it('pickScryOrSurveilSplit respects evaluated battlefield lands (Song of the Dryads turns creature into Land) and MDFC front faces', () => {
		const { state, p1 } = twoPlayerState();
		p1.hand = [];
		p1.battlefield = [];
		// Put 3 real lands + 1 creature enchanted by Song of the Dryads (= 4 evaluated lands!)
		for (let i = 0; i < 3; i++) {
			p1.battlefield.push(
				createCardInstance(synthCard({ name: `Plains ${i}`, typeLine: 'Basic Land — Plains', manaCost: '' }), p1.playerId, 'battlefield')
			);
		}
		const enchantedBear = createCardInstance(
			synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			p1.playerId,
			'battlefield'
		);
		const song = createCardInstance(
			synthCard({
				name: 'Song of the Dryads',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant permanent\nEnchanted permanent is a Forest land.'
			}),
			p1.playerId,
			'battlefield'
		);
		song.attachedToId = enchantedBear.instanceId;
		p1.battlefield.push(enchantedBear, song);
		assert.equal(evaluatePermanent(state, enchantedBear).isLand, true);

		const topLand = createCardInstance(
			synthCard({ name: 'Top Plains', typeLine: 'Basic Land — Plains', manaCost: '' }),
			p1.playerId,
			'library'
		);
		const mdfcSpellFront = createCardInstance(
			synthCard({
				name: 'Valakut Awakening',
				layout: 'modal_dfc',
				typeLine: 'Instant // Land',
				cmc: 3,
				faces: [
					{
						name: 'Valakut Awakening',
						manaCost: '{2}{R}',
						cmc: 3,
						typeLine: 'Instant',
						oracleText: 'Draw a card.',
						colors: ['R'],
						imageUrl: ''
					},
					{
						name: 'Valakut Stoneforge',
						manaCost: '',
						cmc: 0,
						typeLine: 'Land',
						oracleText: '{T}: Add {R}.',
						colors: [],
						imageUrl: ''
					}
				]
			}),
			p1.playerId,
			'library'
		);
		const split = pickScryOrSurveilSplit(p1, [topLand, mdfcSpellFront], state);
		// With >= 4 evaluated battlefield lands, topLand goes to bottom while mdfcSpellFront (Instant front face) stays on top!
		assert.deepEqual(split.bottomIds, [topLand.instanceId]);
		assert.deepEqual(split.topIds, [mdfcSpellFront.instanceId]);

		const disp = resolveCardInstanceDisplay(mdfcSpellFront, 'hand', p1.playerId);
		assert.deepEqual(disp.types, ['Instant']);
	});
});

describe('M3 Stage 1B — scryfall.ts IR-driven deck rules & normalizeScryfallCard', () => {
	function makeLandDeck(colorId: ('W' | 'U' | 'B' | 'R' | 'G')[], count: number, typeLine: string, name: string) {
		const land = synthCard({
			name,
			manaCost: '',
			cmc: 0,
			typeLine,
			colorIdentity: colorId
		});
		return [{ card: land, quantity: count }];
	}

	it('validates multi-copy cards (Relentless Rats, Shadowborn Apostle, Hare Apparent, Templar Knight) and synthetic renames via IR', () => {
		const cases = [
			{
				name: 'Relentless Rats',
				color: 'B' as const,
				typeLine: 'Creature — Rat',
				oracleText: 'Relentless Rats gets +1/+1 for each other creature on the battlefield named Relentless Rats.\nA deck can have any number of cards named Relentless Rats.'
			},
			{
				name: 'Shadowborn Apostle',
				color: 'B' as const,
				typeLine: 'Creature — Human Cleric',
				oracleText: '{B}, Sacrifice six creatures named Shadowborn Apostle: Search your library for a Demon creature card, put it onto the battlefield, then shuffle.\nA deck can have any number of cards named Shadowborn Apostle.'
			},
			{
				name: 'Hare Apparent',
				color: 'W' as const,
				typeLine: 'Creature — Rabbit Noble',
				oracleText: 'When this creature enters, create a number of 1/1 white Rabbit creature tokens equal to the number of other creatures you control named Hare Apparent.\nA deck can have any number of cards named Hare Apparent.'
			},
			{
				name: 'Templar Knight',
				color: 'W' as const,
				typeLine: 'Creature — Human Knight',
				oracleText: 'Vigilance\nWhenever Templar Knight and at least four other creatures attack, search your library for an artifact card, put it onto the battlefield, then shuffle.\nA deck can have any number of cards named Templar Knight.'
			},
			{
				name: 'Glimmerfen Swarm',
				color: 'B' as const,
				typeLine: 'Creature — Fungus',
				oracleText: 'A deck can have any number of cards named Glimmerfen Swarm.'
			}
		];

		for (const c of cases) {
			const cmd = synthCard({
				name: `${c.name} Commander`,
				typeLine: 'Legendary Creature — Avatar',
				colorIdentity: [c.color],
				canBeCommander: true
			});
			const multi = synthCard({
				name: c.name,
				typeLine: c.typeLine,
				colors: [c.color],
				colorIdentity: [c.color],
				oracleText: c.oracleText
			});
			const res = validateCommanderDeck([cmd], [
				{ card: multi, quantity: 30 },
				...makeLandDeck([c.color], 69, `Basic Land — ${c.color === 'W' ? 'Plains' : 'Swamp'}`, c.color === 'W' ? 'Plains' : 'Swamp')
			]);
			assert.equal(res.isLegal, true, `${c.name} should be legal at 30 copies: ${res.errors.join('; ')}`);
		}
	});

	it('validates capped-copy cards (Seven Dwarves, Nazgûl) and synthetic renames via IR', () => {
		const cmd = synthCard({
			name: 'Cap Commander',
			typeLine: 'Legendary Creature — Avatar',
			colorIdentity: ['B', 'R'],
			canBeCommander: true
		});
		const synth7 = synthCard({
			name: 'Vaelen Sentinels',
			typeLine: 'Creature — Construct',
			colors: ['R'],
			colorIdentity: ['R'],
			oracleText: 'A deck can have up to seven cards named Vaelen Sentinels.'
		});
		const synth9 = synthCard({
			name: 'Ashen Wraiths',
			typeLine: 'Creature — Wraith',
			colors: ['B'],
			colorIdentity: ['B'],
			oracleText: 'A deck can have up to nine cards named Ashen Wraiths.'
		});

		const okRes = validateCommanderDeck([cmd], [
			{ card: synth7, quantity: 7 },
			{ card: synth9, quantity: 9 },
			...makeLandDeck(['R'], 83, 'Basic Land — Mountain', 'Mountain')
		]);
		assert.equal(okRes.isLegal, true, okRes.errors.join('; '));

		const over7 = validateCommanderDeck([cmd], [
			{ card: synth7, quantity: 8 },
			...makeLandDeck(['R'], 91, 'Basic Land — Mountain', 'Mountain')
		]);
		assert.equal(over7.isLegal, false);

		const over9 = validateCommanderDeck([cmd], [
			{ card: synth9, quantity: 10 },
			...makeLandDeck(['B'], 89, 'Basic Land — Swamp', 'Swamp')
		]);
		assert.equal(over9.isLegal, false);
	});

	it('derives normalizeScryfallCard commander/partner flags from compiled IR and rejects fake partner prose', () => {
		const walkerRaw = {
			id: 'raw_walker',
			name: 'Vaelen, Temporal Weaver',
			type_line: 'Legendary Planeswalker — Vaelen',
			oracle_text: '+1: Draw a card.\nVaelen, Temporal Weaver can be your commander.',
			mana_cost: '{3}{U}',
			cmc: 4,
			colors: ['U'],
			color_identity: ['U'],
			keywords: [],
			legalities: { commander: 'legal' }
		};
		const walker = normalizeScryfallCard(walkerRaw);
		assert.equal(walker.canBeCommander, true);
		assert.equal(canCardBeCommander(walker), true);

		const partnerA = normalizeScryfallCard({
			id: 'raw_pa',
			name: 'Aurelia Dawnblade',
			type_line: 'Legendary Creature — Angel',
			oracle_text: 'Partner with Kaelen Stoneheart',
			mana_cost: '{2}{W}',
			cmc: 3,
			colors: ['W'],
			color_identity: ['W'],
			keywords: ['Partner with'],
			power: '2',
			toughness: '2',
			legalities: { commander: 'legal' }
		});
		const partnerB = normalizeScryfallCard({
			id: 'raw_pb',
			name: 'Kaelen Stoneheart',
			type_line: 'Legendary Creature — Dwarf',
			oracle_text: 'Partner with Aurelia Dawnblade',
			mana_cost: '{2}{R}',
			cmc: 3,
			colors: ['R'],
			color_identity: ['R'],
			keywords: ['Partner with'],
			power: '3',
			toughness: '2',
			legalities: { commander: 'legal' }
		});
		assert.equal(partnerA.hasPartner, true);
		assert.equal(partnerB.hasPartner, true);

		const bgChooser = normalizeScryfallCard({
			id: 'raw_bgc',
			name: 'Liora, Wandering Bard',
			type_line: 'Legendary Creature — Elf Bard',
			oracle_text: 'Choose a Background',
			mana_cost: '{1}{G}',
			cmc: 2,
			colors: ['G'],
			color_identity: ['G'],
			keywords: ['Choose a Background'],
			power: '2',
			toughness: '2',
			legalities: { commander: 'legal' }
		});
		const bg = normalizeScryfallCard({
			id: 'raw_bg',
			name: 'Song of the Wilds',
			type_line: 'Legendary Enchantment — Background',
			oracle_text: '',
			mana_cost: '{2}{G}',
			cmc: 3,
			colors: ['G'],
			color_identity: ['G'],
			keywords: [],
			legalities: { commander: 'legal' }
		});
		assert.equal(bgChooser.hasChooseBackground, true);
		assert.equal(bg.isBackground, true);

		const fakePartner = normalizeScryfallCard({
			id: 'raw_fake',
			name: 'Lone Strategist',
			type_line: 'Legendary Creature — Human',
			oracle_text: 'Whenever Lone Strategist attacks, choose a partner creature.',
			mana_cost: '{2}{W}',
			cmc: 3,
			colors: ['W'],
			color_identity: ['W'],
			keywords: [],
			power: '2',
			toughness: '2',
			legalities: { commander: 'legal' }
		});
		assert.equal(fakePartner.hasPartner, false);

		const lands = makeLandDeck(['W'], 98, 'Basic Land — Plains', 'Plains');
		assert.equal(validateCommanderDeck([partnerA, partnerB], lands).isLegal, true);
		assert.equal(validateCommanderDeck([bgChooser, bg], makeLandDeck(['G'], 98, 'Basic Land — Forest', 'Forest')).isLegal, true);
		assert.equal(validateCommanderDeck([partnerA, fakePartner], lands).isLegal, false);
	});

	it('validates Doctor\'s companion + Time Lord Doctor pairs and rejects Changeling or extra-subtype commanders', () => {
		const makeLandDeck = (ci: ('W' | 'U' | 'B' | 'R' | 'G')[], count: number, typeLine: string, name: string) =>
			Array.from({ length: count }, (_, idx) => ({
				card: synthCard({
					id: `land_doc_${idx}`,
					name,
					typeLine,
					manaCost: '',
					cmc: 0,
					colors: [],
					colorIdentity: ci,
					oracleText: `({T}: Add {${ci[0]}}.)`
				}),
				quantity: 1
			}));

		const doctor = normalizeScryfallCard({
			id: 'raw_doc',
			name: 'The Wandering Chronomancer',
			type_line: 'Legendary Creature — Time Lord Doctor',
			oracle_text: '',
			mana_cost: '{2}{U}',
			cmc: 3,
			colors: ['U'],
			color_identity: ['U'],
			keywords: [],
			power: '2',
			toughness: '3',
			legalities: { commander: 'legal' }
		});
		const companion = normalizeScryfallCard({
			id: 'raw_comp',
			name: 'Clara, Starlight Scout',
			type_line: 'Legendary Creature — Human',
			oracle_text: "Doctor's companion",
			mana_cost: '{1}{W}',
			cmc: 2,
			colors: ['W'],
			color_identity: ['W'],
			keywords: ["Doctor's companion"],
			power: '2',
			toughness: '2',
			legalities: { commander: 'legal' }
		});
		const companionNoKw = normalizeScryfallCard({
			id: 'raw_comp_nokw',
			name: 'Rose, Timeline Walker',
			type_line: 'Legendary Creature — Human',
			oracle_text: "Doctor's companion",
			mana_cost: '{1}{W}',
			cmc: 2,
			colors: ['W'],
			color_identity: ['W'],
			keywords: [],
			power: '2',
			toughness: '2',
			legalities: { commander: 'legal' }
		});
		const changeling = normalizeScryfallCard({
			id: 'raw_changeling_doc',
			name: 'Morphling Sovereign',
			type_line: 'Legendary Creature — Shapeshifter',
			oracle_text: 'Changeling',
			mana_cost: '{2}{U}',
			cmc: 3,
			colors: ['U'],
			color_identity: ['U'],
			keywords: ['Changeling'],
			power: '3',
			toughness: '3',
			legalities: { commander: 'legal' }
		});
		const extraSubtype = normalizeScryfallCard({
			id: 'raw_extra_doc',
			name: 'Chronos, Temporal Archmage',
			type_line: 'Legendary Creature — Time Lord Doctor Wizard',
			oracle_text: '',
			mana_cost: '{3}{U}',
			cmc: 4,
			colors: ['U'],
			color_identity: ['U'],
			keywords: [],
			power: '3',
			toughness: '3',
			legalities: { commander: 'legal' }
		});

		const uwLands = [
			...makeLandDeck(['U'], 49, 'Basic Land — Island', 'Island'),
			...makeLandDeck(['W'], 49, 'Basic Land — Plains', 'Plains')
		];
		assert.equal(validateCommanderDeck([doctor, companion], uwLands).isLegal, true);
		assert.equal(validateCommanderDeck([doctor, companionNoKw], uwLands).isLegal, true);
		assert.equal(validateCommanderDeck([changeling, companion], uwLands).isLegal, false);
		assert.equal(validateCommanderDeck([extraSubtype, companion], uwLands).isLegal, false);
	});
});

function twoHumanMain1State() {
	const commander = synthCard({
		name: 'Test Commander',
		typeLine: 'Legendary Creature — Wizard',
		power: '2',
		toughness: '2',
		canBeCommander: true
	});
	const filler = synthCard({
		name: 'Test Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const deck: MagicDeck = {
		id: 'deck_act',
		userId: 'u1',
		name: 'Action Deck',
		description: '',
		commanders: [commander],
		cards: [{ card: filler, quantity: 99 }],
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: 100,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'u1',
			username: 'P1',
			avatarUrl: '',
			isBot: false,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [commander.name],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'u2',
			username: 'P2',
			avatarUrl: '',
			isBot: false,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [commander.name],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const state = createInitialGameState('ACT', seats, new Map([[0, deck], [1, deck]]), {
		...DEFAULT_LOBBY_RULES,
		startingLife: 20
	});
	for (const s of seats) {
		if (state.status === 'mulligan') {
			assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	state.phase = 'main1';
	state.turnNumber = 2;
	for (const pl of state.players) {
		pl.life = 20;
		pl.hand = [];
		pl.battlefield = [];
		pl.graveyard = [];
		pl.exile = [];
		pl.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	noteLayerInputsChanged(state);
	return { state, p1: state.players[0], p2: state.players[1] };
}

function passBothPriority(state: ReturnType<typeof twoHumanMain1State>['state']) {
	const first = state.players[state.priorityPlayerIndex].playerId;
	assert.equal(applyGameAction(state, first, { type: 'pass_priority' }).ok, true);
	const second = state.players[state.priorityPlayerIndex].playerId;
	assert.equal(applyGameAction(state, second, { type: 'pass_priority' }).ok, true);
}

describe('M3 Stage 1B Iter 2 — CR 712.4a/712.8a off-battlefield & stack-face resolution', () => {
	it('Explore / runMatches evaluates MDFC Instant // Land on top of library strictly by front face (canonical + synthetic)', () => {
		for (const spec of [
			{
				label: 'canonical Valakut Awakening',
				mdfcName: 'Valakut Awakening',
				backName: 'Valakut Stoneforge',
				explorerName: 'Merfolk Branchwalker'
			},
			{
				label: 'synthetic renamed MDFC',
				mdfcName: 'Shatterspark Bolt',
				backName: 'Shatterspark Peak',
				explorerName: 'Glimmerfen Pathfinder'
			}
		]) {
			const { state, p1 } = twoHumanMain1State();
			const mdfc = synthCard({
				name: spec.mdfcName,
				layout: 'modal_dfc',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Instant // Land',
				colors: ['R'],
				oracleText: 'Draw a card.',
				faces: [
					{
						name: spec.mdfcName,
						manaCost: '{2}{R}',
						cmc: 3,
						typeLine: 'Instant',
						oracleText: 'Draw a card.',
						colors: ['R'],
						keywords: [],
						imageUrl: ''
					},
					{
						name: spec.backName,
						manaCost: '',
						cmc: 0,
						typeLine: 'Land',
						oracleText: '{T}: Add {R}.',
						colors: [],
						keywords: [],
						imageUrl: ''
					}
				]
			});
			const explorerCard = synthCard({
				name: spec.explorerName,
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Merfolk Scout',
				power: '2',
				toughness: '1',
				colors: ['G'],
				oracleText: `When ${spec.explorerName} enters, it explores.`
			});
			const instantTutor = synthCard({
				name: 'Arcane Finder',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Sorcery',
				colors: ['U'],
				oracleText:
					'Reveal cards from the top of your library until you reveal an instant card. Put that card into your hand and the rest on the bottom of your library in a random order.'
			});

			const mdfcInst = createCardInstance(mdfc, p1.playerId, 'library');
			p1.library.unshift(mdfcInst);
			const explorerHand = createCardInstance(explorerCard, p1.playerId, 'hand');
			const tutorHand = createCardInstance(instantTutor, p1.playerId, 'hand');
			p1.hand.push(explorerHand, tutorHand);
			p1.manaPool.G = 2;
			p1.manaPool.U = 2;

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: explorerHand.instanceId
				}).ok,
				true,
				spec.label
			);
			passBothPriority(state); // Resolve creature -> ETB explore on stack
			passBothPriority(state); // Resolve ETB explore -> MDFC is Instant (not Land) -> +1/+1 counter + yesNo prompt

			const liveExplorer = p1.battlefield.find((b) => b.instanceId === explorerHand.instanceId);
			assert.ok(liveExplorer, spec.label);
			assert.equal(liveExplorer.counters['+1/+1'], 1, `${spec.label}: explore should add +1/+1 counter`);
			assert.equal(
				p1.hand.some((c) => c.instanceId === mdfcInst.instanceId),
				false,
				`${spec.label}: MDFC Instant // Land must NOT be treated as Land by Explore`
			);
			assert.equal(state.pendingPrompts.length, 1, spec.label);
			assert.equal(state.pendingPrompts[0].choice?.kind, 'yesNo', spec.label);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: false }
				}).ok,
				true,
				spec.label
			);
			assert.equal(p1.library[0].instanceId, mdfcInst.instanceId, spec.label);

			// Now verify runMatches DOES match { types: ['Instant'] } for the same MDFC on top of library
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: tutorHand.instanceId
				}).ok,
				true,
				spec.label
			);
			passBothPriority(state);
			assert.equal(
				p1.hand.some((c) => c.instanceId === mdfcInst.instanceId),
				true,
				`${spec.label}: MDFC Instant // Land must match { types: ['Instant'] } in library`
			);
		}
	});

	it('SpellCountered resolves countered spell stack face for multi-face cards (Creature front vs Instant back)', () => {
		const { state, p1, p2 } = twoHumanMain1State();
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;

		const watcher = synthCard({
			name: 'Counter Watcher',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Enchantment',
			colors: ['U'],
			oracleText: 'Whenever an instant spell is countered, you gain 4 life.'
		});
		const mdfc = synthCard({
			name: 'Shifting Bear',
			layout: 'modal_dfc',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear // Instant',
			colors: ['G'],
			power: '2',
			toughness: '2',
			oracleText: '',
			faces: [
				{
					name: 'Shifting Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					oracleText: '',
					colors: ['G'],
					power: '2',
					toughness: '2',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Shifting Bolt',
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Draw a card.',
					colors: ['R'],
					keywords: [],
					imageUrl: ''
				}
			]
		});
		const counterspell = synthCard({
			name: 'Counterspell',
			manaCost: '{U}{U}',
			cmc: 2,
			typeLine: 'Instant',
			colors: ['U'],
			oracleText: 'Counter target spell.'
		});

		p1.battlefield.push(createCardInstance(watcher, p1.playerId, 'battlefield'));
		const cs1 = createCardInstance(counterspell, p1.playerId, 'hand');
		const cs2 = createCardInstance(counterspell, p1.playerId, 'hand');
		p1.hand.push(cs1, cs2);
		p1.manaPool.U = 4;

		const mdfc1 = createCardInstance(mdfc, p2.playerId, 'hand');
		const mdfc2 = createCardInstance(mdfc, p2.playerId, 'hand');
		p2.hand.push(mdfc1, mdfc2);
		p2.manaPool.G = 2;
		p2.manaPool.R = 1;

		// 1. P2 casts Creature front face (faceIndex 0); P1 counters it -> must NOT trigger "instant spell is countered"
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: mdfc1.instanceId,
				faceIndex: 0
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cs1.instanceId,
				targets: [{ kind: 'stack', id: state.stack[0].id, label: 'Shifting Bear' }]
			}).ok,
			true
		);
		passBothPriority(state); // Counterspell resolves
		assert.equal(state.stack.length, 0, 'Creature front-face counter must not trigger instant-counter watcher');
		assert.equal(p1.life, 20);

		// 2. P2 casts Instant back face (faceIndex 1); P1 counters it -> MUST trigger (+4 life)
		state.priorityPlayerIndex = 1;
		state.passedPriorityPlayerIds = [];
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: mdfc2.instanceId,
				faceIndex: 1
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cs2.instanceId,
				targets: [{ kind: 'stack', id: state.stack[0].id, label: 'Shifting Bolt' }]
			}).ok,
			true
		);
		passBothPriority(state); // Counterspell resolves -> trigger goes on stack
		assert.equal(state.stack.length, 1, 'Instant back-face counter must trigger instant-counter watcher');
		passBothPriority(state); // Trigger resolves
		assert.equal(p1.life, 24);
	});
});

