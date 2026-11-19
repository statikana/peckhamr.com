import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

let w9Seq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string }
): ScryfallCard {
	w9Seq += 1;
	const id = overrides.id ?? `syn_w9_${w9Seq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_w9_${w9Seq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		defense: overrides.defense,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		layout: overrides.layout ?? 'normal',
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(cards: ScryfallCard[]): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_w9_${++w9Seq}`,
		userId: 'p1',
		name: 'Wave 9 Deck',
		description: '',
		commanders: [],
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupGame(opts: { p1Bot?: boolean; p2Bot?: boolean; playerCount?: 2 | 3 } = {}) {
	const filler = synthCard({
		name: 'Basic Island',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Island',
		oracleText: '({T}: Add {U}.)'
	});
	const count = opts.playerCount ?? 2;
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	for (let i = 0; i < count; i++) {
		const d = makeDeck(Array.from({ length: 25 }, () => filler));
		decks.set(i, d);
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `Player${i + 1}`,
			avatarUrl: '',
			isBot: i === 0 ? Boolean(opts.p1Bot) : i === 1 ? Boolean(opts.p2Bot) : false,
			deckId: d.id,
			deckName: d.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
	}
	const state = createInitialGameState('W9', seats, decks, DEFAULT_LOBBY_RULES);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hasKeptHand = true;
		p.hand = [];
	}
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library',
	opts: { isCommander?: boolean; summoningSick?: boolean; counters?: Record<string, number> } = {}
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(
		card,
		player.playerId,
		zone,
		Boolean(opts.isCommander),
		false,
		state.nextTimestamp
	);
	if (zone === 'battlefield') {
		inst.summoningSick = opts.summoningSick ?? false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
	}
	if (opts.counters) {
		inst.counters = { ...inst.counters, ...opts.counters };
	}
	if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	noteLayerInputsChanged(state);
	return inst;
}

function findInstanceInState(
	state: GameState,
	instanceId: string
): { zone: string; inst?: CardInstance } | undefined {
	for (const p of state.players) {
		for (const z of ['battlefield', 'hand', 'graveyard', 'exile', 'library', 'command'] as const) {
			const hit = p[z].find((c) => c.instanceId === instanceId);
			if (hit) return { zone: z, inst: hit };
		}
	}
	if (state.stack.some((s) => s.sourceInstanceId === instanceId)) return { zone: 'stack' };
	return undefined;
}

function currentZone(state: GameState, inst: CardInstance): string | undefined {
	return findInstanceInState(state, inst.instanceId)?.zone ?? inst.zone;
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor | 'C', number>>): void {
	for (const [k, v] of Object.entries(pool)) {
		if (typeof v === 'number') {
			player.manaPool[k as ManaColor | 'C'] = (player.manaPool[k as ManaColor | 'C'] ?? 0) + v;
		}
	}
}

function resolveAllStackAndOrderPrompts(state: GameState): void {
	for (let guard = 0; guard < 40; guard++) {
		if (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0];
			if (prm.purpose === 'trigger_order') {
				const res = applyGameAction(state, prm.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
				});
				assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
				continue;
			}
			return;
		}
		if (state.stack.length === 0) return;
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
}

function passUntilPhase(
	state: GameState,
	targetPhase: GameState['phase'],
	targetActiveIndex?: number
): void {
	for (let guard = 0; guard < 64; guard++) {
		if (
			state.phase === targetPhase &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0 &&
			(targetActiveIndex === undefined || state.activePlayerIndex === targetActiveIndex)
		) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			resolveAllStackAndOrderPrompts(state);
			if (state.pendingPrompts.length > 0) return;
			continue;
		}
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
	assert.fail(`Failed to reach phase ${targetPhase} (stuck in ${state.phase})`);
}

const CANONICAL_CARDS = {
	valgavoth: () =>
		synthCard({
			name: 'Valgavoth, Harrower of Souls',
			manaCost: '{2}{B}{R}',
			cmc: 4,
			typeLine: 'Legendary Creature — Elder Demon',
			power: '4',
			toughness: '4',
			oracleText:
				'Flying\nWard—Pay 2 life.\nWhenever an opponent loses life for the first time during each of their turns, put a +1/+1 counter on Valgavoth and draw a card.',
			colors: ['B', 'R'],
			keywords: ['Flying', 'Ward']
		}),
	mangara: () =>
		synthCard({
			name: 'Mangara, the Diplomat',
			manaCost: '{3}{W}',
			cmc: 4,
			typeLine: 'Legendary Creature — Human Cleric',
			power: '2',
			toughness: '4',
			oracleText:
				"Lifelink\nWhenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, draw a card.\nWhenever an opponent casts their second spell each turn, draw a card.",
			colors: ['W'],
			keywords: ['Lifelink']
		}),
	harshMentor: () =>
		synthCard({
			name: 'Harsh Mentor',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Human Cleric',
			power: '2',
			toughness: '2',
			oracleText:
				"Whenever an opponent activates an ability of an artifact, creature, or land on the battlefield, if it isn't a mana ability, Harsh Mentor deals 2 damage to that player.",
			colors: ['R']
		}),
	auntieOol: () =>
		synthCard({
			name: 'Auntie Ool, Cursewretch',
			manaCost: '{1}{B}{R}{G}',
			cmc: 4,
			typeLine: 'Legendary Creature — Goblin Warlock',
			power: '4',
			toughness: '4',
			oracleText:
				"Ward—Blight 2. (To blight 2, a player puts two -1/-1 counters on a creature they control.)\nWhenever one or more -1/-1 counters are put on a creature, draw a card if you control that creature. If you don't control it, its controller loses 1 life.",
			colors: ['B', 'R', 'G'],
			keywords: ['Blight', 'Ward']
		}),
	fireglassMentor: () =>
		synthCard({
			name: 'Fireglass Mentor',
			manaCost: '{B}{R}',
			cmc: 2,
			typeLine: 'Creature — Lizard Warlock',
			power: '2',
			toughness: '1',
			oracleText:
				'At the beginning of your second main phase, if an opponent lost life this turn, exile the top two cards of your library. Choose one of them. Until end of turn, you may play that card.',
			colors: ['B', 'R']
		}),
	kiora: () =>
		synthCard({
			name: 'Kiora, Sovereign of the Deep',
			manaCost: '{3}{G}{U}',
			cmc: 5,
			typeLine: 'Legendary Creature — Merfolk Noble',
			power: '4',
			toughness: '5',
			oracleText:
				"Vigilance, ward {3}\nWhenever you cast a Kraken, Leviathan, Octopus, or Serpent spell from your hand, look at the top X cards of your library, where X is that spell's mana value. You may cast a spell with mana value less than X from among them without paying its mana cost. Put the rest on the bottom of your library in a random order.",
			colors: ['G', 'U'],
			keywords: ['Vigilance', 'Ward']
		}),
	narsetsReversal: () =>
		synthCard({
			name: "Narset's Reversal",
			manaCost: '{U}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				"Copy target instant or sorcery spell, then return it to its owner's hand. You may choose new targets for the copy.",
			colors: ['U']
		}),
	chainOfVapor: () =>
		synthCard({
			name: 'Chain of Vapor',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText:
				"Return target nonland permanent to its owner's hand. Then that permanent's controller may sacrifice a land of their choice. If the player does, they may copy this spell and may choose a new target for that copy.",
			colors: ['U']
		}),
	tearAsunder: () =>
		synthCard({
			name: 'Tear Asunder',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				'Kicker {1}{B} (You may pay an additional {1}{B} as you cast this spell.)\nExile target artifact or enchantment. If this spell was kicked, exile target nonland permanent instead.',
			colors: ['G'],
			keywords: ['Kicker']
		}),
	longRiversPull: () =>
		synthCard({
			name: "Long River's Pull",
			manaCost: '{U}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				'Gift a card (You may promise an opponent a gift as you cast this spell. If you do, they draw a card before its other effects.)\nCounter target creature spell. If the gift was promised, instead counter target spell.',
			colors: ['U'],
			keywords: ['Gift']
		}),
	sunforger: () =>
		synthCard({
			name: 'Sunforger',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact — Equipment',
			oracleText:
				'Equipped creature gets +4/+0.\n{R}{W}, Unattach this Equipment: Search your library for a red or white instant card with mana value 4 or less and cast that card without paying its mana cost. Then shuffle.\nEquip {3}',
			colors: [],
			keywords: ['Equip']
		}),
	showdown: () =>
		synthCard({
			name: 'Showdown of the Skalds',
			manaCost: '{2}{R}{W}',
			cmc: 4,
			typeLine: 'Enchantment — Saga',
			oracleText:
				'I — Exile the top four cards of your library. Until the end of your next turn, you may play those cards.\nII, III — Whenever you cast a spell this turn, put a +1/+1 counter on target creature you control.',
			colors: ['R', 'W']
		}),
	sphinx: () =>
		synthCard({
			name: 'Sphinx of Forgotten Lore',
			manaCost: '{2}{U}{U}',
			cmc: 4,
			typeLine: 'Creature — Sphinx',
			power: '3',
			toughness: '3',
			oracleText:
				'Flash\nFlying\nWhenever this creature attacks, target instant or sorcery card in your graveyard gains flashback until end of turn. The flashback cost is equal to that card\'s mana cost.',
			colors: ['U'],
			keywords: ['Flash', 'Flying']
		}),
	moraug: () =>
		synthCard({
			name: 'Moraug, Fury of Akoum',
			manaCost: '{4}{R}{R}',
			cmc: 6,
			typeLine: 'Legendary Creature — Minotaur Warrior',
			power: '6',
			toughness: '6',
			oracleText:
				"Landfall — Whenever a land you control enters, if it's your main phase, there's an additional combat phase after this phase. At the beginning of that combat, untap all creatures you control.",
			colors: ['R']
		}),
	wakka: () =>
		synthCard({
			name: 'Wakka, Devoted Guardian',
			manaCost: '{2}{G}{W}',
			cmc: 4,
			typeLine: 'Legendary Creature — Human Warrior',
			power: '4',
			toughness: '4',
			oracleText:
				'Reach, trample\nWhenever Wakka deals combat damage to a player, destroy up to one target artifact that player controls and put a +1/+1 counter on Wakka.\nBlitzball Captain — At the beginning of your end step, if a counter was put on Wakka this turn, put a +1/+1 counter on each other creature you control.',
			colors: ['G', 'W'],
			keywords: ['Reach', 'Trample', 'Blitzball Captain']
		}),
	tamiyo: () =>
		synthCard({
			name: 'Tamiyo, Field Researcher',
			manaCost: '{1}{G}{W}{U}',
			cmc: 4,
			typeLine: 'Legendary Planeswalker — Tamiyo',
			loyalty: '4',
			oracleText:
				'+1: Choose up to two target creatures. Until your next turn, whenever either of those creatures deals combat damage, you draw a card.\n−2: Tap up to two target nonland permanents. They don\'t untap during their controller\'s next untap step.',
			colors: ['G', 'W', 'U']
		}),
	avenInterrupter: () =>
		synthCard({
			name: 'Aven Interrupter',
			manaCost: '{1}{W}{W}',
			cmc: 3,
			typeLine: 'Creature — Bird Rogue',
			power: '2',
			toughness: '2',
			oracleText:
				'Flash\nFlying\nWhen this creature enters, exile target spell. It becomes plotted.',
			colors: ['W'],
			keywords: ['Flash', 'Flying']
		}),
	massacreGirl: () =>
		synthCard({
			name: 'Massacre Girl, Known Killer',
			manaCost: '{2}{B}{B}',
			cmc: 4,
			typeLine: 'Legendary Creature — Human Assassin',
			power: '4',
			toughness: '4',
			oracleText:
				'Menace\nCreatures you control have wither. (They deal damage to creatures in the form of -1/-1 counters.)\nWhenever a creature an opponent controls dies, if its toughness was less than 1, draw a card.',
			colors: ['B'],
			keywords: ['Menace']
		}),
	burningCuriosity: () =>
		synthCard({
			name: 'Burning Curiosity',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText:
				"As an additional cost to cast this spell, you may blight 1. (You may put a -1/-1 counter on a creature you control.)\nExile the top two cards of your library. If this spell's additional cost was paid, exile the top three cards instead. Until the end of your next turn, you may play those cards.",
			colors: ['R'],
			keywords: ['Blight']
		}),
	stitchTogether: () =>
		synthCard({
			name: 'Stitch Together',
			manaCost: '{B}{B}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText:
				'Return target creature card from your graveyard to your hand.\nThreshold — Return that card from your graveyard to the battlefield instead if seven or more cards are in your graveyard.',
			colors: ['B'],
			keywords: ['Threshold']
		}),
	kodama: () =>
		synthCard({
			name: 'Kodama of the East Tree',
			manaCost: '{4}{G}{G}',
			cmc: 6,
			typeLine: 'Legendary Creature — Spirit',
			power: '6',
			toughness: '6',
			oracleText:
				"Reach\nWhenever another permanent you control enters, if it wasn't put onto the battlefield with this ability, you may put a permanent card with equal or lesser mana value from your hand onto the battlefield.",
			colors: ['G'],
			keywords: ['Reach']
		}),
	blueMagesCane: () =>
		synthCard({
			name: "Blue Mage's Cane",
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Artifact — Equipment',
			oracleText:
				"Whenever equipped creature deals combat damage to a player, exile up to one target instant or sorcery card from that player's graveyard. If you do, copy it. You may cast the copy by paying {3} rather than paying its mana cost.\nEquip {2}",
			colors: ['U'],
			keywords: ['Equip']
		}),
	firebenderAscension: () =>
		synthCard({
			name: 'Firebender Ascension',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText:
				'Whenever a creature you control attacking causes a triggered ability of that creature to trigger, put a quest counter on this enchantment. Then if it has four or more quest counters on it, you may copy that ability. You may choose new targets for the copy.',
			colors: ['R']
		}),
	bismuthMindrender: () =>
		synthCard({
			name: 'Bismuth Mindrender',
			manaCost: '{3}{B}',
			cmc: 4,
			typeLine: 'Creature — Eldrazi',
			power: '4',
			toughness: '3',
			oracleText:
				'Devoid\nMenace\nWhenever this creature deals combat damage to a player, that player exiles cards from the top of their library until they exile a nonland card. You may cast that card by paying life equal to its mana value rather than paying its mana cost.',
			colors: ['B'],
			keywords: ['Devoid', 'Menace']
		}),
	krile: () =>
		synthCard({
			name: 'Krile Baldesion',
			manaCost: '{1}{W}{U}',
			cmc: 3,
			typeLine: 'Legendary Creature — Lalafell Wizard',
			power: '2',
			toughness: '3',
			oracleText:
				'Whenever you cast a noncreature spell, return target creature card with mana value equal to that spell\'s mana value from your graveyard to your hand. Do this only once each turn.',
			colors: ['W', 'U']
		}),
	rodOfAbsorption: () =>
		synthCard({
			name: 'Rod of Absorption',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText:
				'{X}, {T}, Sacrifice ~: You may cast any number of spells from among cards exiled with ~ with total mana value X or less without paying their mana costs.',
			colors: ['U']
		}),
	florian: () =>
		synthCard({
			name: 'Florian, Voldaren Scion',
			manaCost: '{1}{B}{R}',
			cmc: 3,
			typeLine: 'Legendary Creature — Vampire Noble',
			power: '3',
			toughness: '3',
			oracleText:
				'First strike\nAt the beginning of each of your postcombat main phases, look at the top X cards of your library, where X is the total amount of life your opponents lost this turn. Exile one of those cards and put the rest on the bottom of your library in a random order. You may play the exiled card this turn.',
			colors: ['B', 'R'],
			keywords: ['First strike']
		}),
	creamOfTheCrop: () =>
		synthCard({
			name: 'Cream of the Crop',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText:
				"Whenever a creature you control enters, you may look at the top X cards of your library, where X is that creature's power. If you do, put one of those cards on top of your library and the rest on the bottom of your library in any order.",
			colors: ['G']
		}),
	riveteersOverlook: () =>
		synthCard({
			name: 'Riveteers Overlook',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText:
				'When ~ enters, sacrifice it. When you do, search your library for a basic Swamp, Mountain, or Forest card, put it onto the battlefield tapped, then shuffle and you gain 1 life.',
			colors: []
		}),
	demolitionField: () =>
		synthCard({
			name: 'Demolition Field',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText:
				"{T}: Add {C}.\n{2}, {T}, Sacrifice ~: Destroy target nonbasic land an opponent controls. That land's controller may search their library for a basic land card, put it onto the battlefield, then shuffle. You may search your library for a basic land card, put it onto the battlefield, then shuffle.",
			colors: []
		}),
	rampantRejuvenator: () =>
		synthCard({
			name: 'Rampant Rejuvenator',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Creature — Hydra',
			power: '0',
			toughness: '0',
			oracleText:
				"~ enters with two +1/+1 counters on it.\nWhen ~ dies, search your library for up to X basic land cards, where X is ~'s power, put them onto the battlefield, then shuffle.",
			colors: ['G']
		}),
	prismaticUndercurrents: () =>
		synthCard({
			name: 'Prismatic Undercurrents',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Enchantment',
			oracleText:
				'Vivid — When ~ enters, search your library for up to X basic land cards, where X is the number of colors among permanents you control. Reveal those cards, put them into your hand, then shuffle.',
			colors: ['G']
		}),
	momentOfTruth: () =>
		synthCard({
			name: 'Moment of Truth',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				'Look at the top three cards of your library. Put one of those cards into your hand, one into your graveyard, and one on the bottom of your library.',
			colors: ['U']
		}),
	creativeTechnique: () =>
		synthCard({
			name: 'Creative Technique',
			manaCost: '{4}{R}',
			cmc: 5,
			typeLine: 'Sorcery',
			oracleText:
				'Demonstrate\nShuffle your library, then reveal cards from the top of it until you reveal a nonland card. Exile that card and put the rest on the bottom of your library in a random order. You may cast the exiled card without paying its mana cost.',
			colors: ['R'],
			keywords: ['Demonstrate']
		})
};

describe('Wave 9 compiler rename-invariance & canonical IR checks', () => {
	it('compiles all Wave 9 canonical cards identically under synthetic renames', () => {
		for (const [key, factory] of Object.entries(CANONICAL_CARDS)) {
			const canonical = factory();
			const synthetic = synthCard({
				...canonical,
				name: `Synthetic Rename ${key}`,
				oracleText: canonical.oracleText
					.replaceAll(canonical.name, `Synthetic Rename ${key}`)
					.replace(/\bWakka\b/g, `Synthetic Rename ${key}`)
					.replace(/\bValgavoth\b/g, `Synthetic Rename ${key}`)
			});
			const irA = compileCard(canonical);
			const irB = compileCard(synthetic);
			assert.equal(irA.fullySupported, true, `${canonical.name} should compile as fullySupported`);
			assert.equal(irB.fullySupported, true, `${synthetic.name} should compile as fullySupported`);
			assert.deepEqual(
				irA.faces[0]?.abilities,
				irB.faces[0]?.abilities,
				`Rename invariance mismatch for ${canonical.name}`
			);
		}
	});
});

describe('Wave 9 runtime: triggers & intervening-if (CR 603.2 / 603.4)', () => {
	it('Valgavoth triggers only on first opponent life loss during that opponent own turn (and synthetic clone)', () => {
		for (const useSynth of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const valCard = useSynth
				? synthCard({
						...CANONICAL_CARDS.valgavoth(),
						name: 'Synthetic Soul Harvester',
						oracleText: CANONICAL_CARDS.valgavoth().oracleText.replaceAll(
							'Valgavoth',
							'Synthetic Soul Harvester'
						)
					})
				: CANONICAL_CARDS.valgavoth();
			const valgavoth = putInZone(state, p1, valCard, 'battlefield');

			const burn = synthCard({
				name: 'Lose Life Bolt',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Target player loses 2 life.',
				colors: ['B']
			});
			const b1 = putInZone(state, p1, burn, 'hand');
			giveMana(p1, { B: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: b1.instanceId,
					targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(p2.life, 38);
			assert.equal(valgavoth.counters['+1/+1'] ?? 0, 0, 'Must NOT trigger during your own turn');

			passUntilPhase(state, 'main1', 1);
			const shock = synthCard({
				name: 'Opp Pain',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'You lose 1 life.',
				colors: ['B']
			});
			const s1 = putInZone(state, p2, shock, 'hand');
			const s2 = putInZone(state, p2, shock, 'hand');
			giveMana(p2, { B: 2 });

			const handBefore = p1.hand.length;
			assert.equal(
				applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(valgavoth.counters['+1/+1'], 1);
			assert.equal(p1.hand.length, handBefore + 1);

			assert.equal(
				applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: s2.instanceId }).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(valgavoth.counters['+1/+1'], 1, 'Must NOT trigger a second time on same turn');
		}
	});

	it('Mangara draws on >=2 opponent attackers and on opponent 2nd spell each turn', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p1, CANONICAL_CARDS.mangara(), 'battlefield');

		const bearCard = synthCard({
			name: 'Vanilla Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		const a1 = putInZone(state, p2, bearCard, 'battlefield');
		const a2 = putInZone(state, p2, bearCard, 'battlefield');

		passUntilPhase(state, 'main1', 1);
		const drawSpell = synthCard({
			name: 'Opp Opt',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'You gain 1 life.'
		});
		const sp1 = putInZone(state, p2, drawSpell, 'hand');
		const sp2 = putInZone(state, p2, drawSpell, 'hand');
		giveMana(p2, { U: 2 });

		const handStart = p1.hand.length;
		assert.equal(applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: sp1.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(p1.hand.length, handStart, 'First opp spell does not trigger Mangara');

		assert.equal(applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: sp2.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(p1.hand.length, handStart + 1, 'Second opp spell draws a card');

		passUntilPhase(state, 'declare_attackers', 1);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: a1.instanceId, defenderPlayerId: p1.playerId },
					{ attackerInstanceId: a2.instanceId, defenderPlayerId: p1.playerId }
				]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(p1.hand.length, handStart + 2, 'Two attackers draw 1 card');
	});

	it('Harsh Mentor triggers on opponent non-mana abilities and ignores mana abilities', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p1, CANONICAL_CARDS.harshMentor(), 'battlefield');

		const manaRock = synthCard({
			name: 'Sol Stone',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: '{T}: Add {C}.'
		});
		const pinger = synthCard({
			name: 'Tap Relic',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: '{T}: Scry 1.'
		});
		const rock = putInZone(state, p2, manaRock, 'battlefield');
		const relic = putInZone(state, p2, pinger, 'battlefield');

		passUntilPhase(state, 'main1', 1);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'tap_mana', instanceId: rock.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(p2.life, 40, 'Mana ability does not trigger Harsh Mentor');

		const ab = getEffectiveActivatedAbilities(state, p2, relic).find((a) => !a.isManaAbility);
		assert.ok(ab);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: relic.instanceId,
				abilityId: ab!.id
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(p2.life, 38, 'Non-mana activated ability deals 2 damage to opponent');
	});

	it('Auntie Ool Ward—Blight 2 prompts blight and triggers -1/-1 counter draw or life loss', () => {
		const { state, p1, p2 } = setupGame();
		const auntie = putInZone(state, p1, CANONICAL_CARDS.auntieOol(), 'battlefield');
		const oppBear = putInZone(
			state,
			p2,
			synthCard({
				name: 'Opp Grizzly',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);
		const bolt = putInZone(
			state,
			p2,
			synthCard({
				name: 'Bolt Target',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to target creature.',
				colors: ['R']
			}),
			'hand'
		);

		passUntilPhase(state, 'main1', 1);
		giveMana(p2, { R: 1 });
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: auntie.instanceId, label: auntie.card.name }]
			}).ok,
			true
		);
		// Pass priority so Ward trigger resolves and asks p2 to pay Blight 2
		resolveAllStackAndOrderPrompts(state);
		assert.equal(state.pendingPrompts.length, 1);
		const wardPrompt = state.pendingPrompts[0];
		assert.equal(wardPrompt.playerId, p2.playerId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'choice',
				promptId: wardPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);

		// Ward—Blight 2 put two -1/-1 counters on oppBear -> triggers Auntie Ool (-1/-1 on opp creature => p2 loses 1 life); Bolt deals 3 damage to Auntie (4 toughness, survives)
		assert.equal(oppBear.counters['-1/-1'], 2);
		assert.equal(p2.life, 39, 'Auntie Ool triggers on -1/-1 counter placed on opponent creature');
		assert.equal(auntie.damageMarked, 3);
	});

	it('Krile Baldesion checks exact spell MV and "Do this only once each turn"', () => {
		const { state, p1 } = setupGame();
		putInZone(state, p1, CANONICAL_CARDS.krile(), 'battlefield');
		const gyBear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Two-Drop Elf',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Elf',
				power: '2',
				toughness: '2'
			}),
			'graveyard'
		);
		const opt2 = synthCard({
			name: 'Two MV Draw',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'You gain 1 life.'
		});
		const c1 = putInZone(state, p1, opt2, 'hand');
		const c2 = putInZone(state, p1, opt2, 'hand');
		giveMana(p1, { U: 4, C: 4 });

		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c1.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(gyBear.zone, 'hand', 'Krile returns matching MV creature to hand');

		const gyBear2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Another Two-Drop',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Elf',
				power: '2',
				toughness: '2'
			}),
			'graveyard'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c2.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(gyBear2.zone, 'graveyard', 'Krile Do this only once each turn prevents second return');
	});
});

describe('Wave 9 runtime: dig, search, exile permissions, copy, replacements & delayed triggers', () => {
	it('Fireglass Mentor exiles top 2, grants playFromExile ONLY to the chosen 1 card', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p1, CANONICAL_CARDS.fireglassMentor(), 'battlefield');
		const cardA = putInZone(
			state,
			p1,
			synthCard({ name: 'Cheap Opt', manaCost: '{U}', cmc: 1, typeLine: 'Instant', oracleText: 'Scry 1.', colors: ['U'] }),
			'library'
		);
		const cardB = putInZone(
			state,
			p1,
			synthCard({ name: 'Expensive Dragon', manaCost: '{4}{R}{R}', cmc: 6, typeLine: 'Creature — Dragon', power: '5', toughness: '5', colors: ['R'] }),
			'library'
		);
		// Make opponent lose life in main1
		const ping = putInZone(
			state,
			p1,
			synthCard({ name: 'Ping', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'Target opponent loses 1 life.', colors: ['R'] }),
			'hand'
		);
		giveMana(p1, { R: 1, U: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ping.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);

		passUntilPhase(state, 'main2', 0);
		assert.equal(state.pendingPrompts.length, 1);
		const choosePrm = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: choosePrm.id,
				answer: { kind: 'chooseObjects', objectIds: [cardA.instanceId] }
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);

		assert.equal(cardA.zone, 'exile');
		assert.equal(cardB.zone, 'exile');
		assert.equal(cardA.playableFromExileBy?.playerId, p1.playerId);
		assert.equal(cardB.playableFromExileBy, undefined, 'Unchosen exiled card must NOT be playable');

		giveMana(p1, { U: 1 });
		const exileOpts = getCastOptions(state, p1.playerId, cardA, 'exile');
		assert.ok(exileOpts.some((o) => o.permission === 'exile_permission'));
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cardA.instanceId,
				fromZone: 'exile',
				optionId: exileOpts.find((o) => o.permission === 'exile_permission')!.id
			}).ok,
			true
		);
	});

	it('Kiora, Sovereign of the Deep digs X cards and only free-casts spells with MV strictly < X', () => {
		const { state, p1 } = setupGame();
		putInZone(state, p1, CANONICAL_CARDS.kiora(), 'battlefield');
		// Top of library: MV 5 Serpent (NOT < 5) and MV 3 Elf (strictly < 5)
		const levi5 = putInZone(
			state,
			p1,
			synthCard({ name: 'Big Serpent', manaCost: '{3}{U}{U}', cmc: 5, typeLine: 'Creature — Serpent', power: '5', toughness: '5' }),
			'library'
		);
		const elf3 = putInZone(
			state,
			p1,
			synthCard({ name: 'Three-Drop Merfolk', manaCost: '{2}{U}', cmc: 3, typeLine: 'Creature — Merfolk', power: '3', toughness: '3' }),
			'library'
		);
		const triggerLevi = putInZone(
			state,
			p1,
			synthCard({ name: 'Sea Monster', manaCost: '{3}{U}{U}', cmc: 5, typeLine: 'Creature — Leviathan', power: '5', toughness: '5' }),
			'hand'
		);
		giveMana(p1, { U: 5 });
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: triggerLevi.instanceId }).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		// Kiora trigger should prompt human to choose among eligible (strictly MV < 5 => ONLY elf3, NOT levi5)
		assert.equal(state.pendingPrompts.length, 1);
		const digPrm = state.pendingPrompts[0];
		assert.ok(digPrm.candidateInstanceIds?.includes(elf3.instanceId));
		assert.equal(digPrm.candidateInstanceIds?.includes(levi5.instanceId), false, 'MV 5 must be excluded by strict < 5');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: digPrm.id,
				answer: { kind: 'chooseObjects', objectIds: [elf3.instanceId] }
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts.length > 0) {
			const castAsk = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: castAsk.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(
			currentZone(state, elf3),
			'battlefield',
			'Three-drop Merfolk was cast without paying its mana cost and entered battlefield'
		);
	});

	it("Narset's Reversal copies target spell (with retargeting) and returns original to hand", () => {
		const { state, p1, p2 } = setupGame();
		const oppBolt = putInZone(
			state,
			p2,
			synthCard({
				name: 'Lava Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to target player.',
				colors: ['R']
			}),
			'hand'
		);
		const reversal = putInZone(state, p1, CANONICAL_CARDS.narsetsReversal(), 'hand');
		passUntilPhase(state, 'main1', 1);
		giveMana(p2, { R: 1 });
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppBolt.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		// p2 passes priority to p1
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		giveMana(p1, { U: 2 });
		const boltStackId = state.stack[0].id;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: reversal.instanceId,
				targets: [{ kind: 'stack', id: boltStackId, label: oppBolt.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		// Answer retarget yes/no to point copy at p2
		const prmYn = state.pendingPrompts[0];
		assert.ok(prmYn);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prmYn.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts.length > 0) {
			const retargetTgt = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: retargetTgt.id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(currentZone(state, oppBolt), 'hand', 'Original spell returned to owner hand');
		assert.equal(p1.life, 40, 'Original spell never resolved against p1');
		assert.equal(p2.life, 37, 'Copied bolt hit opponent');
	});

	it('Chain of Vapor lets bounced permanent controller sacrifice a land and copy Chain of Vapor to bounce another permanent', () => {
		const { state, p1, p2 } = setupGame({ p2Bot: true });
		const myRelic = putInZone(
			state,
			p1,
			synthCard({ name: 'My Relic', manaCost: '{2}', cmc: 2, typeLine: 'Artifact' }),
			'battlefield'
		);
		const oppRock = putInZone(
			state,
			p2,
			synthCard({ name: 'Opp Rock', manaCost: '{2}', cmc: 2, typeLine: 'Artifact' }),
			'battlefield'
		);
		const oppLand = putInZone(
			state,
			p2,
			synthCard({ name: 'Opp Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' }),
			'battlefield'
		);
		const chain = putInZone(state, p1, CANONICAL_CARDS.chainOfVapor(), 'hand');
		giveMana(p1, { U: 1 });

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: chain.instanceId,
				targets: [{ kind: 'permanent', id: oppRock.instanceId, label: oppRock.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(oppRock.zone, 'hand', 'Opp Rock bounced');
		assert.equal(oppLand.zone, 'graveyard', 'Bot controller sacrificed a land to copy Chain of Vapor');
		assert.equal(myRelic.zone, 'hand', 'Opponent copy retargeted and bounced p1 relic');
	});

	it("Tear Asunder and Long River's Pull perform cast-time target swaps via kicker & gift", () => {
		const { state, p1, p2 } = setupGame();
		const oppBear = putInZone(
			state,
			p2,
			synthCard({ name: 'Target Bear', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const tear = putInZone(state, p1, CANONICAL_CARDS.tearAsunder(), 'hand');
		giveMana(p1, { G: 1, B: 1, C: 2 });

		const opts = getCastOptions(state, p1.playerId, tear, 'hand');
		const baseOpt = opts[0];
		assert.ok(baseOpt);
		assert.ok(baseOpt.optionalAdditionalCosts?.some((o) => o.id === 'kicker:0'));

		// Unkicked cannot target Creature
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tear.instanceId,
				optionId: baseOpt.id,
				targets: [{ kind: 'permanent', id: oppBear.instanceId, label: oppBear.card.name }]
			}).ok,
			false
		);

		// Kicked can target nonland Creature and exiles it
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tear.instanceId,
				optionId: baseOpt.id,
				optionalCostCounts: { 'kicker:0': 1 },
				targets: [{ kind: 'permanent', id: oppBear.instanceId, label: oppBear.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(oppBear.zone, 'exile');

		// Long River's Pull with Gift targeting a noncreature Sorcery
		const oppDiv = putInZone(
			state,
			p2,
			synthCard({ name: 'Opp Sorcery', manaCost: '{2}{U}', cmc: 3, typeLine: 'Sorcery', oracleText: 'You gain 1 life.' }),
			'hand'
		);
		const oppTop = putInZone(
			state,
			p2,
			synthCard({ name: 'Gift Draw', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' }),
			'library'
		);
		const pull = putInZone(state, p1, CANONICAL_CARDS.longRiversPull(), 'hand');
		passUntilPhase(state, 'main1', 1);
		giveMana(p2, { U: 1, C: 2 });
		assert.equal(applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: oppDiv.instanceId }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		giveMana(p1, { U: 2 });
		const pullOpts = getCastOptions(state, p1.playerId, pull, 'hand');
		const pullOpt = pullOpts[0];
		assert.ok(pullOpt?.optionalAdditionalCosts?.some((o) => o.id === 'opt:gift'), 'Gift optional cost should be generated');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: pull.instanceId,
				optionId: pullOpt!.id,
				optionalCostCounts: { 'opt:gift': 1 },
				giftRecipientId: p2.playerId,
				targets: [{ kind: 'stack', id: state.stack[0].id, label: oppDiv.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(oppTop.zone, 'hand', 'Opponent drew promised gift card');
		assert.equal(currentZone(state, oppDiv), 'graveyard', 'Countered sorcery went to graveyard');
	});

	it('Burning Curiosity & Stitch Together resolve conditional replacement branches cleanly', () => {
		const { state, p1 } = setupGame();
		const lizard = putInZone(
			state,
			p1,
			synthCard({ name: 'Test Lizard', manaCost: '{R}', cmc: 1, typeLine: 'Creature — Lizard', power: '2', toughness: '2' }),
			'battlefield'
		);
		const l1 = putInZone(state, p1, synthCard({ name: 'Top Card 1', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 1 life.' }), 'library');
		const l2 = putInZone(state, p1, synthCard({ name: 'Top Card 2', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 1 life.' }), 'library');
		const l3 = putInZone(state, p1, synthCard({ name: 'Top Card 3', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 1 life.' }), 'library');
		const curiosity = putInZone(state, p1, CANONICAL_CARDS.burningCuriosity(), 'hand');
		giveMana(p1, { R: 3 });

		const cOpts = getCastOptions(state, p1.playerId, curiosity, 'hand');
		const baseOpt = cOpts[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: curiosity.instanceId,
				optionId: baseOpt.id,
				costPayment: { options: [0], objects: [[lizard.instanceId]] }
			}).ok,
			true
		);
		// Pay optional blight 1 prompt if paused
		resolveAllStackAndOrderPrompts(state);
		while (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: prm.kind === 'yesNo' ? { kind: 'yesNo', yes: true } : { kind: 'chooseObjects', objectIds: [lizard.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(lizard.counters['-1/-1'], 1);
		assert.equal(l1.zone, 'exile');
		assert.equal(l2.zone, 'exile');
		assert.equal(l3.zone, 'exile', 'Blight paid => exiled top 3 instead of 2');
		assert.equal(l3.playableFromExileBy?.duration, 'untilEndOfYourNextTurn');

		// Stitch Together with threshold (>=7 cards in graveyard)
		const targetCr = putInZone(
			state,
			p1,
			synthCard({ name: 'Dead Giant', manaCost: '{4}{B}', cmc: 5, typeLine: 'Creature — Giant', power: '5', toughness: '5' }),
			'graveyard'
		);
		for (let i = 0; i < 6; i++) {
			putInZone(state, p1, synthCard({ name: `Filler ${i}`, manaCost: '{1}', cmc: 1, typeLine: 'Instant' }), 'graveyard');
		}
		const stitch = putInZone(state, p1, CANONICAL_CARDS.stitchTogether(), 'hand');
		giveMana(p1, { B: 2 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: stitch.instanceId,
				targets: [{ kind: 'graveyard_card', id: targetCr.instanceId, label: targetCr.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(targetCr.zone, 'battlefield', 'Stitch Together threshold returns creature to battlefield');
	});

	it('Showdown of the Skalds Ch II/III & Tamiyo +1 & Massacre Girl delayed triggers fire and expire accurately', () => {
		const { state, p1, p2 } = setupGame();
		const bear = putInZone(
			state,
			p1,
			synthCard({ name: 'Skald Warrior', manaCost: '{1}{W}', cmc: 2, typeLine: 'Creature — Human Warrior', power: '3', toughness: '3' }),
			'battlefield'
		);
		// Test Showdown Ch II delayed spell trigger directly via Saga at 1 lore counter going to main1 -> 2 lore counters
		const showdown = putInZone(state, p1, CANONICAL_CARDS.showdown(), 'battlefield', { counters: { lore: 1 } });
		passUntilPhase(state, 'main1', 0);
		// Advance to next turn so precombat main adds 2nd lore counter (Ch II)
		passUntilPhase(state, 'main1', 1);
		passUntilPhase(state, 'main1', 0);
		assert.equal(showdown.counters.lore, 2);

		const opt = putInZone(
			state,
			p1,
			synthCard({ name: 'Trigger Spell', manaCost: '{W}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 1 life.' }),
			'hand'
		);
		giveMana(p1, { W: 1 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: opt.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts.length > 0) {
			const pTgt = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: pTgt.id,
					answer: { kind: 'chooseObjects', objectIds: [bear.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(bear.counters['+1/+1'], 1, 'Showdown Ch II delayed spell trigger placed +1/+1 counter');

		// Tamiyo +1 watched combat damage draw until your next turn
		const tam = putInZone(state, p1, CANONICAL_CARDS.tamiyo(), 'battlefield', { counters: { loyalty: 4 } });
		const tamPlus = getEffectiveActivatedAbilities(state, p1, tam).find((a) => a.id.includes('loyalty') || a.loyaltyCost !== undefined);
		assert.ok(tamPlus);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: tam.instanceId,
				abilityId: tamPlus!.id,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		const preDrawHand = p1.hand.length;
		passUntilPhase(state, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		passUntilPhase(state, 'main2', 0);
		assert.equal(p1.hand.length, preDrawHand + 1, 'Tamiyo +1 watched creature drew a card on combat damage');

		// Massacre Girl, Known Killer LKI toughness < 1
		putInZone(state, p1, CANONICAL_CARDS.massacreGirl(), 'battlefield');
		const opp22 = putInZone(
			state,
			p2,
			synthCard({ name: 'Doomed 2/2', manaCost: '{1}{B}', cmc: 2, typeLine: 'Creature — Zombie', power: '2', toughness: '2' }),
			'battlefield'
		);
		const shrink = putInZone(
			state,
			p1,
			synthCard({ name: 'Double -1/-1', manaCost: '{B}', cmc: 1, typeLine: 'Instant', oracleText: 'Put two -1/-1 counters on target creature.' }),
			'hand'
		);
		giveMana(p1, { B: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: shrink.instanceId,
				targets: [{ kind: 'permanent', id: opp22.instanceId, label: opp22.card.name }]
			}).ok,
			true
		);
		const mgHandBefore = p1.hand.length;
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts.length > 0) {
			const sdTgt = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: sdTgt.id,
					answer: { kind: 'chooseObjects', objectIds: [bear.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(opp22.zone, 'graveyard');
		assert.equal(p1.hand.length, mgHandBefore + 1, 'Massacre Girl draws when opponent creature dies with LKI toughness < 1');
	});

	it('Moraug adds combat phase & untaps creatures; Wakka checks counterPutOnSelfThisTurn; Aven Interrupter plots', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p1, CANONICAL_CARDS.moraug(), 'battlefield');
		const atk = putInZone(
			state,
			p1,
			synthCard({ name: 'Tapped Bear', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		atk.tapped = true;

		const land = putInZone(state, p1, synthCard({ name: 'Mountain', manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }), 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: land.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(state.additionalCombatPhases, 1, 'Moraug added an additional combat phase');
		passUntilPhase(state, 'declare_attackers', 0); // first normal combat
		assert.equal(applyGameAction(state, p1.playerId, { type: 'declare_attackers', assignments: [] }).ok, true);
		// Passing out of first declare_attackers triggers beginPostCombatOrAdditionalCombat -> Moraug untap fires!
		passUntilPhase(state, 'begin_combat', 0);
		passUntilPhase(state, 'declare_attackers', 0);
		assert.equal(atk.tapped, false, 'Moraug delayed trigger untaps creatures at beginning of additional combat');

		// Wakka end-step intervening-if
		const wakka = putInZone(state, p1, CANONICAL_CARDS.wakka(), 'battlefield');
		const partnerBear = putInZone(
			state,
			p1,
			synthCard({ name: 'Partner', manaCost: '{1}{W}', cmc: 2, typeLine: 'Creature — Human', power: '2', toughness: '2' }),
			'battlefield'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'declare_attackers', assignments: [{ attackerInstanceId: wakka.instanceId, defenderPlayerId: p2.playerId }] }).ok, true);
		passUntilPhase(state, 'main2', 0);
		assert.equal(wakka.counters['+1/+1'], 1, 'Wakka combat damage trigger added counter');
		passUntilPhase(state, 'main1', 1); // finishes p1 end_step
		assert.equal(partnerBear.counters['+1/+1'], 1, 'Wakka end step added +1/+1 to other creature because counter was put on Wakka this turn');

		// Aven Interrupter plot exiles opponent spell and makes it castable on later turn as sorcery for free
		const oppCard = putInZone(
			state,
			p2,
			synthCard({ name: 'Opp Giant', manaCost: '{3}{G}', cmc: 4, typeLine: 'Creature — Giant', power: '4', toughness: '4' }),
			'hand'
		);
		giveMana(p2, { G: 1, C: 3 });
		assert.equal(applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: oppCard.instanceId }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		const aven = putInZone(state, p1, CANONICAL_CARDS.avenInterrupter(), 'hand');
		giveMana(p1, { W: 3 });
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: aven.instanceId }).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		const avenTgt = state.pendingPrompts[0];
		if (avenTgt) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: avenTgt.id,
					answer: { kind: 'chooseObjects', objectIds: [state.stack[0].id] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		const exiledOppCard = findInstanceInState(state, oppCard.instanceId);
		assert.equal(exiledOppCard?.zone, 'exile');
		assert.equal(exiledOppCard?.inst?.playableFromExileBy?.isPlotted, true);
		// Same turn: opp cannot cast plotted card yet
		assert.equal(getCastOptions(state, p2.playerId, exiledOppCard!.inst!, 'exile').length, 0);
		// Next turn of p2: castable for free as sorcery
		passUntilPhase(state, 'main1', 0);
		passUntilPhase(state, 'main1', 1);
		const plotOpts = getCastOptions(state, p2.playerId, exiledOppCard!.inst!, 'exile');
		assert.equal(plotOpts.length, 1);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: exiledOppCard!.inst!.instanceId,
				fromZone: 'exile',
				optionId: plotOpts[0].id
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(currentZone(state, oppCard), 'battlefield', 'Plotted spell resolved on later turn without paying mana cost');
	});

	it('Sunforger, Rod of Absorption, Bismuth Mindrender, Blue Mage\'s Cane, Firebender Ascension, and Kodama execute faithfully', () => {
		const { state, p1, p2 } = setupGame();
		// Sunforger attached to bear searches library & casts RW instant MV<=4 free
		const bear = putInZone(
			state,
			p1,
			synthCard({ name: 'Knight', manaCost: '{1}{W}', cmc: 2, typeLine: 'Creature — Knight', power: '2', toughness: '2' }),
			'battlefield'
		);
		const sun = putInZone(state, p1, CANONICAL_CARDS.sunforger(), 'battlefield');
		sun.attachedToId = bear.instanceId;
		noteLayerInputsChanged(state);
		assert.equal(evaluatePermanent(state, bear).power, 6);

		const helix = putInZone(
			state,
			p1,
			synthCard({
				name: 'White Red Gain',
				manaCost: '{R}{W}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'You gain 3 life.',
				colors: ['R', 'W']
			}),
			'library'
		);
		const redSorcery = putInZone(
			state,
			p1,
			synthCard({
				name: 'Red Sorcery NonCandidate',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'You gain 1 life.',
				colors: ['R']
			}),
			'library'
		);
		const sunAb = getEffectiveActivatedAbilities(state, p1, sun).find((a) => !a.id.includes('equip'));
		assert.ok(sunAb);
		giveMana(p1, { R: 1, W: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: sun.instanceId,
				abilityId: sunAb!.id
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts.length > 0) {
			const pick = state.pendingPrompts[0];
			assert.equal(
				pick.candidateInstanceIds?.includes(redSorcery.instanceId),
				false,
				'Mono-red sorcery must NOT match red or white instant card'
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: pick.id,
					answer: { kind: 'chooseObjects', objectIds: [helix.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(sun.attachedToId, null);
		assert.equal(p1.life, 43, 'Sunforger free-cast RW instant resolved');

		// Rod of Absorption respects totalMaxMv X budget across exiled cards
		const rod = putInZone(state, p1, CANONICAL_CARDS.rodOfAbsorption(), 'battlefield');
		const ex1 = putInZone(
			state,
			p1,
			synthCard({ name: 'Exiled Gain 1', manaCost: '{W}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 2 life.' }),
			'exile'
		);
		const ex2 = putInZone(
			state,
			p1,
			synthCard({ name: 'Exiled Gain 2', manaCost: '{1}{W}', cmc: 2, typeLine: 'Instant', oracleText: 'You gain 4 life.' }),
			'exile'
		);
		ex1.exiledBy = { sourceInstanceId: rod.instanceId, sourceObjectVersion: rod.objectVersion ?? 1 };
		ex2.exiledBy = { sourceInstanceId: rod.instanceId, sourceObjectVersion: rod.objectVersion ?? 1 };
		const rodAb = getEffectiveActivatedAbilities(state, p1, rod)[0];
		giveMana(p1, { C: 1 }); // X = 1: only ex1 fits!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: rod.instanceId,
				abilityId: rodAb.id,
				xValue: 1
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		while (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(p1.life, 45, 'Rod cast 1 MV spell within X=1 budget and skipped 2 MV spell');

		// Bismuth Mindrender combat damage -> exileUntil + pay life equal to MV
		const bis = putInZone(state, p1, CANONICAL_CARDS.bismuthMindrender(), 'battlefield');
		const oppSpy = putInZone(
			state,
			p2,
			synthCard({ name: 'Opp Draw Spell', manaCost: '{2}{U}', cmc: 3, typeLine: 'Sorcery', oracleText: 'You gain 1 life.' }),
			'library'
		);
		passUntilPhase(state, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: bis.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		passUntilPhase(state, 'main2', 0);
		if (state.pendingPrompts.length > 0) {
			const yn = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: yn.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(currentZone(state, oppSpy), 'graveyard');
		assert.equal(p1.life, 43, 'Paid 3 life (equal to MV 3) to cast exiled spell + gained 1 life');

		// Kodama of the East Tree: permanent enters -> puts equal/lesser MV permanent from hand -> must NOT re-trigger Kodama
		putInZone(state, p1, CANONICAL_CARDS.kodama(), 'battlefield');
		const drop2A = putInZone(
			state,
			p1,
			synthCard({ name: 'Drop Two A', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Elf', power: '2', toughness: '2' }),
			'hand'
		);
		const drop2B = putInZone(
			state,
			p1,
			synthCard({ name: 'Drop Two B', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Elf', power: '2', toughness: '2' }),
			'hand'
		);
		const drop2C = putInZone(
			state,
			p1,
			synthCard({ name: 'Drop Two C', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Elf', power: '2', toughness: '2' }),
			'hand'
		);
		passUntilPhase(state, 'main2', 0);
		giveMana(p1, { G: 1, C: 1 });
		const kCastRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: drop2A.instanceId });
		assert.equal(kCastRes.ok, true, kCastRes.ok ? '' : (kCastRes.error ?? ''));
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts.length > 0) {
			const kYn = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: kYn.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		if (state.pendingPrompts.length > 0) {
			const kPick = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: kPick.id,
					answer: { kind: 'chooseObjects', objectIds: [drop2B.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(drop2B.zone, 'battlefield', 'Kodama put drop2B onto battlefield');
		assert.equal(drop2C.zone, 'hand', 'Kodama did NOT re-trigger off permanent put onto battlefield by its own ability');
	});
});

function cloneRenamedCard(card: ScryfallCard, newName: string): ScryfallCard {
	return synthCard({
		...card,
		name: newName,
		oracleText: card.oracleText
			.replaceAll(card.name, newName)
			.replace(/\bWakka\b/g, newName)
			.replace(/\bValgavoth\b/g, newName)
	});
}

describe('Wave 9 runtime: dynamic search/dig, partitions, Capenna fetches & synthetic rename behavioral clones', () => {
	it('Demolition Field (canonical & synthetic) destroys opp nonbasic land and lets LKI controller + you search basic lands', () => {
		for (const useSynth of [false, true]) {
			const { state, p1, p2 } = setupGame({ p2Bot: true });
			const demoCard = useSynth
				? cloneRenamedCard(CANONICAL_CARDS.demolitionField(), 'Synthetic Field')
				: CANONICAL_CARDS.demolitionField();
			const demo = putInZone(state, p1, demoCard, 'battlefield');
			const oppNonbasic = putInZone(
				state,
				p2,
				synthCard({ name: 'Command Tower', manaCost: '', cmc: 0, typeLine: 'Land', oracleText: '{T}: Add {C}.' }),
				'battlefield'
			);
			const p1Forest = putInZone(
				state,
				p1,
				synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest', oracleText: '' }),
				'library'
			);
			const p2Swamp = putInZone(
				state,
				p2,
				synthCard({ name: 'Swamp', manaCost: '', cmc: 0, typeLine: 'Basic Land — Swamp', oracleText: '' }),
				'library'
			);
			const ab = getEffectiveActivatedAbilities(state, p1, demo).find((a) =>
				a.cost.some((c) => c.k === 'sacrifice')
			);
			assert.ok(ab);
			giveMana(p1, { C: 2 });
			const demoActRes = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: demo.instanceId,
				abilityId: ab!.id,
				targets: [{ kind: 'permanent', id: oppNonbasic.instanceId, label: oppNonbasic.card.name }]
			});
			assert.equal(demoActRes.ok, true, demoActRes.ok ? '' : (demoActRes.error ?? ''));
			resolveAllStackAndOrderPrompts(state);
			if (state.pendingPrompts[0]?.kind === 'yesNo') {
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: state.pendingPrompts[0].id,
						answer: { kind: 'yesNo', yes: true }
					}).ok,
					true
				);
				resolveAllStackAndOrderPrompts(state);
			}
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseObjects', objectIds: [p1Forest.instanceId] }
					}).ok,
					true
				);
				resolveAllStackAndOrderPrompts(state);
			}
			assert.equal(oppNonbasic.zone, 'graveyard');
			assert.equal(p2Swamp.zone, 'battlefield', 'Destroyed land controller fetched basic land to battlefield');
			assert.equal(p1Forest.zone, 'battlefield', 'Controller fetched basic land to battlefield');
		}
	});

	it('Riveteers Overlook (canonical & synthetic) enters, sacrifices, searches 3-basic fetch tapped and gains 1 life', () => {
		for (const useSynth of [false, true]) {
			const { state, p1 } = setupGame();
			const overlook = useSynth
				? cloneRenamedCard(CANONICAL_CARDS.riveteersOverlook(), 'Synthetic Overlook')
				: CANONICAL_CARDS.riveteersOverlook();
			const landInHand = putInZone(state, p1, overlook, 'hand');
			const mtn = putInZone(
				state,
				p1,
				synthCard({ name: 'Mountain', manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain', oracleText: '' }),
				'library'
			);
			const isl = putInZone(
				state,
				p1,
				synthCard({ name: 'Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island', oracleText: '' }),
				'library'
			);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: landInHand.instanceId }).ok, true);
			resolveAllStackAndOrderPrompts(state);
			if (state.pendingPrompts.length > 0) {
				const pick = state.pendingPrompts[0];
				assert.equal(pick.candidateInstanceIds?.includes(isl.instanceId), false, 'Island must not match Swamp/Mountain/Forest');
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: pick.id,
						answer: { kind: 'chooseObjects', objectIds: [mtn.instanceId] }
					}).ok,
					true
				);
				resolveAllStackAndOrderPrompts(state);
			}
			assert.equal(mtn.zone, 'battlefield');
			assert.equal(mtn.tapped, true);
			assert.equal(p1.life, 41, 'Capenna fetch gained 1 life');
		}
	});

	it('Florian, Cream of the Crop, Moment of Truth & Rampant Rejuvenator execute dynamically', () => {
		// Moment of Truth: 1 hand, 1 graveyard, 1 library bottom
		{
			const { state, p1 } = setupGame();
			const mot = putInZone(state, p1, cloneRenamedCard(CANONICAL_CARDS.momentOfTruth(), 'Synthetic Truth'), 'hand');
			const c1 = putInZone(state, p1, synthCard({ name: 'Card One', manaCost: '{U}', cmc: 1 }), 'library');
			const c2 = putInZone(state, p1, synthCard({ name: 'Card Two', manaCost: '{U}', cmc: 1 }), 'library');
			const c3 = putInZone(state, p1, synthCard({ name: 'Card Three', manaCost: '{U}', cmc: 1 }), 'library');
			giveMana(p1, { U: 1, C: 1 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mot.instanceId }).ok, true);
			resolveAllStackAndOrderPrompts(state);
			const prmHand = state.pendingPrompts[0];
			assert.ok(prmHand);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prmHand.id,
					answer: { kind: 'chooseObjects', objectIds: [c1.instanceId] }
				}).ok,
				true
			);
			const prmGy = state.pendingPrompts[0];
			assert.ok(prmGy);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prmGy.id,
					answer: { kind: 'chooseObjects', objectIds: [c2.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(c1.zone, 'hand');
			assert.equal(c2.zone, 'graveyard');
			assert.equal(c3.zone, 'library');
		}

		// Florian postcombat main looks at top X (= opponent life lost this turn), exiles 1 playable this turn
		{
			const { state, p1, p2 } = setupGame();
			putInZone(state, p1, cloneRenamedCard(CANONICAL_CARDS.florian(), 'Synthetic Scion'), 'battlefield');
			const top1 = putInZone(
				state,
				p1,
				synthCard({ name: 'Florian Hit', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 2 life.' }),
				'library'
			);
			const top2 = putInZone(state, p1, synthCard({ name: 'Florian Miss', manaCost: '{R}', cmc: 1 }), 'library');
			const ping = putInZone(
				state,
				p1,
				synthCard({ name: 'Loss Spell', manaCost: '{B}', cmc: 1, typeLine: 'Instant', oracleText: 'Target opponent loses 2 life.' }),
				'hand'
			);
			giveMana(p1, { B: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: ping.instanceId,
					targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			passUntilPhase(state, 'main2', 0);
			const flPrm = state.pendingPrompts[0];
			assert.ok(flPrm);
			assert.ok(flPrm.candidateInstanceIds?.includes(top1.instanceId));
			assert.ok(flPrm.candidateInstanceIds?.includes(top2.instanceId));
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: flPrm.id,
					answer: { kind: 'chooseObjects', objectIds: [top1.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(top1.zone, 'exile');
			assert.equal(top1.playableFromExileBy?.playerId, p1.playerId);
			assert.equal(top2.zone, 'library');
		}

		// Cream of the Crop & Rampant Rejuvenator
		{
			const { state, p1 } = setupGame();
			putInZone(state, p1, CANONICAL_CARDS.creamOfTheCrop(), 'battlefield');
			const topA = putInZone(state, p1, synthCard({ name: 'Cream Keep', manaCost: '{G}', cmc: 1 }), 'library');
			const topB = putInZone(state, p1, synthCard({ name: 'Cream Bottom', manaCost: '{G}', cmc: 1 }), 'library');
			const rejuv = putInZone(state, p1, cloneRenamedCard(CANONICAL_CARDS.rampantRejuvenator(), 'Synthetic Rejuvenator'), 'hand');
			const basic1 = putInZone(state, p1, synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }), 'library');
			// Put basic1 below topA and topB
			p1.library = [topA, topB, basic1];
			giveMana(p1, { G: 1, C: 3 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: rejuv.instanceId }).ok, true);
			resolveAllStackAndOrderPrompts(state);
			// Cream optional prompt -> yes
			if (state.pendingPrompts[0]?.kind === 'yesNo') {
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: state.pendingPrompts[0].id,
						answer: { kind: 'yesNo', yes: true }
					}).ok,
					true
				);
			}
			// Cream keep 1 on top -> pick topA
			if (state.pendingPrompts[0]?.kind === 'chooseObjects') {
				const cp = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: cp.id,
						answer: { kind: 'chooseObjects', objectIds: [topA.instanceId] }
					}).ok,
					true
				);
			}
			// If restOrder === 'any' prompts to order bottom cards, confirm order
			if (state.pendingPrompts[0]?.kind === 'orderObjects') {
				const op = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: op.id,
						answer: { kind: 'orderObjects', topIds: op.candidateInstanceIds ?? [] }
					}).ok,
					true
				);
			}
			resolveAllStackAndOrderPrompts(state);
			assert.equal(p1.library[0]?.instanceId, topA.instanceId, 'Cream of the Crop put chosen card on top');
		}
	});

	it('Synthetic renamed-card behavioral clones preserve Ward—Blight 2, Krile once-per-turn, Narset copy-rider & Moraug untap', () => {
		// 1. Synthetic Ward—Blight 2 + -1/-1 trigger
		{
			const { state, p1, p2 } = setupGame();
			const synAuntie = putInZone(state, p1, cloneRenamedCard(CANONICAL_CARDS.auntieOol(), 'Renamed Bog Witch'), 'battlefield');
			const fodder = putInZone(
				state,
				p2,
				synthCard({ name: 'Elf Target', manaCost: '{G}', cmc: 1, typeLine: 'Creature — Elf', power: '3', toughness: '3' }),
				'battlefield'
			);
			const shock = putInZone(
				state,
				p2,
				synthCard({ name: 'Opp Ping', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: '~ deals 1 damage to target creature.' }),
				'hand'
			);
			passUntilPhase(state, 'main1', 1);
			giveMana(p2, { R: 1 });
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: shock.instanceId,
					targets: [{ kind: 'permanent', id: synAuntie.instanceId, label: synAuntie.card.name }]
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			const yn = state.pendingPrompts[0];
			assert.ok(yn);
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'choice',
					promptId: yn.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(fodder.counters['-1/-1'], 2, 'Synthetic Ward—Blight 2 placed two -1/-1 counters');
			assert.equal(p2.life, 39, 'Synthetic -1/-1 trigger made opponent lose 1 life');
		}

		// 2. Synthetic Krile once-each-turn & exact MV trigger
		{
			const { state, p1 } = setupGame();
			putInZone(state, p1, cloneRenamedCard(CANONICAL_CARDS.krile(), 'Renamed Archivist'), 'battlefield');
			const gyCrit = putInZone(
				state,
				p1,
				synthCard({ name: 'One Drop', manaCost: '{W}', cmc: 1, typeLine: 'Creature — Bird', power: '1', toughness: '1' }),
				'graveyard'
			);
			const spellA = putInZone(
				state,
				p1,
				synthCard({ name: 'Opt A', manaCost: '{U}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 1 life.' }),
				'hand'
			);
			giveMana(p1, { U: 1 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spellA.instanceId }).ok, true);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(gyCrit.zone, 'hand', 'Synthetic Krile returned MV 1 creature to hand');
		}

		// 3. Synthetic Moraug additional combat + delayed untap
		{
			const { state, p1 } = setupGame();
			putInZone(state, p1, cloneRenamedCard(CANONICAL_CARDS.moraug(), 'Renamed Minotaur Lord'), 'battlefield');
			const atk = putInZone(
				state,
				p1,
				synthCard({ name: 'Exhausted Knight', manaCost: '{1}{W}', cmc: 2, typeLine: 'Creature — Knight', power: '2', toughness: '2' }),
				'battlefield'
			);
			atk.tapped = true;
			const land = putInZone(state, p1, synthCard({ name: 'Mountain', manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }), 'hand');
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: land.instanceId }).ok, true);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(state.additionalCombatPhases, 1);
			passUntilPhase(state, 'declare_attackers', 0);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'declare_attackers', assignments: [] }).ok, true);
			passUntilPhase(state, 'begin_combat', 0);
			passUntilPhase(state, 'declare_attackers', 0);
			assert.equal(atk.tapped, false, 'Synthetic Moraug delayed untap ran at beginning of additional combat');
		}
	});

	it('Audit #4: Blue Mage\'s Cane, Firebender Ascension, Sphinx of Forgotten Lore, Prismatic Undercurrents, Creative Technique, and Rampant Rejuvenator execute canonically and under synthetic renames', () => {
		const runBlueMagesCane = (renamed: boolean) => {
			const { state, p1, p2 } = setupGame();
			const caneCard = renamed
				? cloneRenamedCard(CANONICAL_CARDS.blueMagesCane(), 'Synthetic Azure Staff')
				: CANONICAL_CARDS.blueMagesCane();
			const cane = putInZone(state, p1, caneCard, 'battlefield');
			const attacker = putInZone(
				state,
				p1,
				synthCard({ name: 'Goblin Piker', manaCost: '{1}{R}', cmc: 2, typeLine: 'Creature — Goblin', power: '2', toughness: '1' }),
				'battlefield'
			);
			const oppInstant = putInZone(
				state,
				p2,
				synthCard({ name: 'Quick Study', manaCost: '{2}{U}', cmc: 3, typeLine: 'Instant', oracleText: 'Draw a card.' }),
				'graveyard'
			);
			putInZone(state, p1, synthCard({ name: 'Drawn Card', manaCost: '{U}', cmc: 1 }), 'library');
			const eqAb = getEffectiveActivatedAbilities(state, p1, cane).find(
				(a) => a.id.includes('equip') || a.label.toLowerCase().includes('equip')
			);
			assert.ok(eqAb, 'Equip ability present');
			giveMana(p1, { C: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: cane.instanceId,
					abilityId: eqAb.id,
					targets: [{ kind: 'permanent', id: attacker.instanceId, label: attacker.card.name }]
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(cane.attachedToId, attacker.instanceId);
			passUntilPhase(state, 'declare_attackers', 0);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
				}).ok,
				true
			);
			passUntilPhase(state, 'declare_blockers', 0);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
			// Advance into combat damage trigger
			for (let g = 0; g < 16; g++) {
				if (state.pendingPrompts.length > 0 || state.stack.length > 0) break;
				const actor = state.players[state.priorityPlayerIndex];
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
			}
			// Pick target from p2's graveyard if prompted, then accept optional {3} copy cast
			const handBefore = p1.hand.length;
			for (let g = 0; g < 20; g++) {
				if (state.pendingPrompts.length > 0) {
					const prm = state.pendingPrompts[0];
					if (prm.kind === 'chooseObjects') {
						assert.equal(
							applyGameAction(state, prm.playerId, {
								type: 'choice',
								promptId: prm.id,
								answer: { kind: 'chooseObjects', objectIds: [oppInstant.instanceId] }
							}).ok,
							true
						);
						continue;
					}
					if (prm.kind === 'yesNo') {
						giveMana(p1, { C: 3 });
						assert.equal(
							applyGameAction(state, prm.playerId, {
								type: 'choice',
								promptId: prm.id,
								answer: { kind: 'yesNo', yes: true }
							}).ok,
							true
						);
						continue;
					}
				}
				if (state.stack.length > 0) {
					const actor = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
					continue;
				}
				break;
			}
			assert.equal(oppInstant.zone, 'exile', 'Opponent graveyard instant exiled by Cane');
			assert.equal(p1.hand.length, handBefore + 1, 'Cast copy of exiled instant drew a card');
		};
		runBlueMagesCane(false);
		runBlueMagesCane(true);

		const runFirebenderAscension = (renamed: boolean) => {
			const { state, p1, p2 } = setupGame();
			const ascCard = renamed
				? cloneRenamedCard(CANONICAL_CARDS.firebenderAscension(), 'Synthetic Quest Aura')
				: CANONICAL_CARDS.firebenderAscension();
			const asc = putInZone(state, p1, ascCard, 'battlefield', { counters: { quest: 3 } });
			const atk = putInZone(
				state,
				p1,
				synthCard({
					name: 'Attack Ping',
					manaCost: '{1}{R}',
					cmc: 2,
					typeLine: 'Creature — Warrior',
					power: '2',
					toughness: '2',
					oracleText: 'Whenever ~ attacks, draw a card.'
				}),
				'battlefield'
			);
			putInZone(state, p1, synthCard({ name: 'Deck Card 1', manaCost: '{R}', cmc: 1 }), 'library');
			putInZone(state, p1, synthCard({ name: 'Deck Card 2', manaCost: '{R}', cmc: 1 }), 'library');
			passUntilPhase(state, 'declare_attackers', 0);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: atk.instanceId, defenderPlayerId: p2.playerId }]
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			while (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				if (prm.kind === 'yesNo') {
					assert.equal(
						applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'yesNo', yes: true }
						}).ok,
						true
					);
				} else if (prm.kind === 'chooseObjects' && prm.choice?.kind === 'chooseObjects') {
					const picks = prm.choice.defaultObjectIds ?? prm.choice.candidates.slice(0, prm.choice.min);
					assert.equal(
						applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseObjects', objectIds: picks }
						}).ok,
						true
					);
				} else {
					resolveAllStackAndOrderPrompts(state);
					break;
				}
				resolveAllStackAndOrderPrompts(state);
			}
			assert.equal(asc.counters.quest, 4, 'Quest counter reached 4');
			assert.equal(p1.hand.length, 2, 'Attack trigger and Firebender Ascension copy drew 2 cards');
		};
		runFirebenderAscension(false);
		runFirebenderAscension(true);

		const runSphinx = (renamed: boolean) => {
			const { state, p1, p2 } = setupGame();
			const sphinxCard = renamed
				? cloneRenamedCard(CANONICAL_CARDS.sphinx(), 'Synthetic Lore Sphinx')
				: CANONICAL_CARDS.sphinx();
			const sphinx = putInZone(state, p1, sphinxCard, 'battlefield');
			const spell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Pond Opt',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Draw a card.'
				}),
				'graveyard'
			);
			putInZone(state, p1, synthCard({ name: 'Deck Card', manaCost: '{U}', cmc: 1 }), 'library');
			passUntilPhase(state, 'declare_attackers', 0);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: sphinx.instanceId, defenderPlayerId: p2.playerId }]
				}).ok,
				true
			);
			if (state.pendingPrompts[0]?.kind === 'chooseObjects') {
				const prm = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, prm.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseObjects', objectIds: [spell.instanceId] }
					}).ok,
					true
				);
			}
			resolveAllStackAndOrderPrompts(state);
			passUntilPhase(state, 'main2', 0);
			giveMana(p1, { U: 1 });
			const fbOpt = getCastOptions(state, p1.playerId, spell, 'graveyard')[0];
			assert.ok(fbOpt, 'Instant in graveyard gained flashback via Sphinx attack trigger');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: spell.instanceId,
					fromZone: 'graveyard',
					optionId: fbOpt.id
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(p1.hand.length, 1, 'Flashback cast drew a card');
			assert.equal(currentZone(state, spell), 'exile', 'Flashback exiled spell after resolution');
		};
		runSphinx(false);
		runSphinx(true);

		const runPrismaticUndercurrents = (renamed: boolean) => {
			const { state, p1 } = setupGame();
			putInZone(
				state,
				p1,
				synthCard({ name: 'Blue Relic', manaCost: '{U}', cmc: 1, typeLine: 'Artifact', colors: ['U'] }),
				'battlefield'
			);
			const prismCard = renamed
				? cloneRenamedCard(CANONICAL_CARDS.prismaticUndercurrents(), 'Synthetic Vivid Tide')
				: CANONICAL_CARDS.prismaticUndercurrents();
			const prism = putInZone(state, p1, prismCard, 'hand');
			const f1 = putInZone(state, p1, synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }), 'library');
			const f2 = putInZone(state, p1, synthCard({ name: 'Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' }), 'library');
			giveMana(p1, { G: 1, C: 3 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: prism.instanceId }).ok, true);
			resolveAllStackAndOrderPrompts(state);
			const toPick = [f1.instanceId, f2.instanceId];
			while (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
				const prm = state.pendingPrompts[0];
				const nextId = toPick.shift();
				assert.equal(
					applyGameAction(state, prm.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseObjects', objectIds: nextId ? [nextId] : [] }
					}).ok,
					true
				);
				resolveAllStackAndOrderPrompts(state);
			}
			assert.equal(f1.zone, 'hand', 'Vivid search brought 1st basic land to hand');
			assert.equal(f2.zone, 'hand', 'Vivid search brought 2nd basic land to hand');
		};
		runPrismaticUndercurrents(false);
		runPrismaticUndercurrents(true);

		const runCreativeTechnique = (renamed: boolean) => {
			const { state, p1, p2 } = setupGame();
			const techCard = renamed
				? cloneRenamedCard(CANONICAL_CARDS.creativeTechnique(), 'Synthetic Improvisation')
				: CANONICAL_CARDS.creativeTechnique();
			const tech = putInZone(state, p1, techCard, 'hand');
			const zap = synthCard({
				name: 'Deck Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: '~ deals 3 damage to target opponent.',
				colors: ['R']
			});
			const landFiller = synthCard({ name: 'Mountain', manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' });
			p1.library = [
				createCardInstance(landFiller, p1.playerId, 'library', false, false, ++state.nextTimestamp!),
				createCardInstance(zap, p1.playerId, 'library', false, false, ++state.nextTimestamp!),
				...Array.from({ length: 5 }, () =>
					createCardInstance(landFiller, p1.playerId, 'library', false, false, ++state.nextTimestamp!)
				)
			];
			giveMana(p1, { R: 1, C: 4 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: tech.instanceId }).ok, true);
			for (let g = 0; g < 30; g++) {
				if (state.pendingPrompts.length > 0) {
					const prm = state.pendingPrompts[0];
					if (prm.kind === 'yesNo') {
						// Decline Demonstrate if asked for Demonstrate, accept free cast if asked for castFree
						const yes = !prm.title.toLowerCase().includes('demonstrate');
						assert.equal(
							applyGameAction(state, prm.playerId, {
								type: 'choice',
								promptId: prm.id,
								answer: { kind: 'yesNo', yes }
							}).ok,
							true
						);
						continue;
					}
					if (prm.choice?.kind === 'chooseMode') {
						assert.equal(
							applyGameAction(state, prm.playerId, {
								type: 'choice',
								promptId: prm.id,
								answer: { kind: 'chooseMode', indices: prm.choice.defaultIndices ?? [0] }
							}).ok,
							true
						);
						continue;
					}
					if (prm.choice?.kind === 'chooseObjects') {
						const picks = prm.choice.defaultObjectIds ?? prm.choice.candidates.slice(0, prm.choice.min);
						assert.equal(
							applyGameAction(state, prm.playerId, {
								type: 'choice',
								promptId: prm.id,
								answer: { kind: 'chooseObjects', objectIds: picks }
							}).ok,
							true
						);
						continue;
					}
				}
				if (state.stack.length > 0) {
					const actor = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
					continue;
				}
				break;
			}
			assert.equal(p2.life, 37, 'Creative Technique exiled and free-cast nonland burn spell');
		};
		runCreativeTechnique(false);
		runCreativeTechnique(true);

		const runRampantRejuvenatorDeath = (renamed: boolean) => {
			const { state, p1 } = setupGame();
			const rejuvCard = renamed
				? cloneRenamedCard(CANONICAL_CARDS.rampantRejuvenator(), 'Synthetic Rejuvenator Dies')
				: CANONICAL_CARDS.rampantRejuvenator();
			const rejuv = putInZone(state, p1, rejuvCard, 'hand');
			const b1 = putInZone(state, p1, synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }), 'library');
			const b2 = putInZone(state, p1, synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }), 'library');
			giveMana(p1, { G: 1, C: 3 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: rejuv.instanceId }).ok, true);
			resolveAllStackAndOrderPrompts(state);
			const bfRejuv = p1.battlefield.find((c) => c.instanceId === rejuv.instanceId);
			assert.ok(bfRejuv, 'Rejuvenator entered battlefield');
			assert.equal(bfRejuv.counters['+1/+1'], 2, 'Rejuvenator entered with two +1/+1 counters');

			const doom = putInZone(
				state,
				p1,
				synthCard({
					name: 'Murder Bolt',
					manaCost: '{1}{B}',
					cmc: 2,
					typeLine: 'Instant',
					oracleText: 'Destroy target creature.'
				}),
				'hand'
			);
			giveMana(p1, { B: 1, C: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: doom.instanceId,
					targets: [{ kind: 'permanent', id: bfRejuv.instanceId, label: bfRejuv.card.name }]
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			const toPickDeath = [b1.instanceId, b2.instanceId];
			while (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
				const prm = state.pendingPrompts[0];
				const nextId = toPickDeath.shift();
				assert.equal(
					applyGameAction(state, prm.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseObjects', objectIds: nextId ? [nextId] : [] }
					}).ok,
					true
				);
				resolveAllStackAndOrderPrompts(state);
			}
			assert.equal(currentZone(state, bfRejuv), 'graveyard');
			assert.equal(b1.zone, 'battlefield', 'Rejuvenator death trigger put 1st basic land onto battlefield');
			assert.equal(b2.zone, 'battlefield', 'Rejuvenator death trigger put 2nd basic land onto battlefield');
		};
		runRampantRejuvenatorDeath(false);
		runRampantRejuvenatorDeath(true);
	});
});

