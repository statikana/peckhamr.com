import type { DeckCardEntry, MagicDeck, ManaColor, ScryfallCard } from './types.ts';

function makeCard(spec: {
	id: string;
	name: string;
	manaCost: string;
	cmc: number;
	typeLine: string;
	oracleText: string;
	colors: ManaColor[];
	colorIdentity: ManaColor[];
	keywords?: string[];
	power?: string;
	toughness?: string;
	loyalty?: string;
	artId?: string;
	canBeCommander?: boolean;
	hasPartner?: boolean;
}): ScryfallCard {
	// Generate Scryfall card image URL or sleek SVG card art data URI fallback
	const encodedName = encodeURIComponent(spec.name).replace(/'/g, '%27');
	const imageUrl = `https://api.scryfall.com/cards/named?exact=${encodedName}&format=image&version=normal`;
	const artCropUrl = `https://api.scryfall.com/cards/named?exact=${encodedName}&format=image&version=art_crop`;
	const isLegendary = spec.typeLine.includes('Legendary');
	const isCreatureOrVehicle =
		spec.typeLine.includes('Creature') ||
		spec.typeLine.includes('Vehicle') ||
		spec.typeLine.includes('Spacecraft');
	const canBeCommander =
		spec.canBeCommander ??
		((isLegendary && isCreatureOrVehicle) ||
			spec.oracleText.toLowerCase().includes('can be your commander'));

	return {
		id: spec.id,
		name: spec.name,
		manaCost: spec.manaCost,
		cmc: spec.cmc,
		typeLine: spec.typeLine,
		oracleText: spec.oracleText,
		colors: spec.colors,
		colorIdentity: spec.colorIdentity,
		keywords: spec.keywords || [],
		power: spec.power,
		toughness: spec.toughness,
		loyalty: spec.loyalty,
		imageUrl,
		artCropUrl,
		legalCommander: true,
		canBeCommander,
		hasPartner: Boolean(spec.hasPartner),
		hasChooseBackground: spec.oracleText.includes('Choose a Background'),
		isBackground: spec.typeLine.includes('Background')
	};
}

export const STAPLE_CARDS: Record<string, ScryfallCard> = {};

function reg(spec: Parameters<typeof makeCard>[0]): ScryfallCard {
	const c = makeCard(spec);
	STAPLE_CARDS[c.name.toLowerCase()] = c;
	return c;
}

// --- Basic Lands & Multi-Lands ---
reg({
	id: 'card_plains',
	name: 'Plains',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Plains',
	oracleText: '({T}: Add {W}.)',
	colors: [],
	colorIdentity: ['W']
});
reg({
	id: 'card_island',
	name: 'Island',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Island',
	oracleText: '({T}: Add {U}.)',
	colors: [],
	colorIdentity: ['U']
});
reg({
	id: 'card_swamp',
	name: 'Swamp',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Swamp',
	oracleText: '({T}: Add {B}.)',
	colors: [],
	colorIdentity: ['B']
});
reg({
	id: 'card_mountain',
	name: 'Mountain',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Mountain',
	oracleText: '({T}: Add {R}.)',
	colors: [],
	colorIdentity: ['R']
});
reg({
	id: 'card_forest',
	name: 'Forest',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Forest',
	oracleText: '({T}: Add {G}.)',
	colors: [],
	colorIdentity: ['G']
});
reg({
	id: 'card_wastes',
	name: 'Wastes',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land',
	oracleText: '{T}: Add {C}.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_command_tower',
	name: 'Command Tower',
	manaCost: '',
	cmc: 0,
	typeLine: 'Land',
	oracleText: "{T}: Add one mana of any color in your commander's color identity.",
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_exotic_orchard',
	name: 'Exotic Orchard',
	manaCost: '',
	cmc: 0,
	typeLine: 'Land',
	oracleText: '{T}: Add one mana of any color that a land an opponent controls could produce.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_reliquary_tower',
	name: 'Reliquary Tower',
	manaCost: '',
	cmc: 0,
	typeLine: 'Land',
	oracleText: 'You have no maximum hand size.\n{T}: Add {C}.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_path_of_ancestry',
	name: 'Path of Ancestry',
	manaCost: '',
	cmc: 0,
	typeLine: 'Land',
	oracleText:
		'This land enters tapped.\n{T}: Add one mana of any color in your commander\'s color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1. (Look at the top card of your library. You may put that card on the bottom.)',
	colors: [],
	colorIdentity: []
});

// --- Commanders ---
reg({
	id: 'cmd_atraxa',
	name: "Atraxa, Praetors' Voice",
	manaCost: '{G}{W}{U}{B}',
	cmc: 4,
	typeLine: 'Legendary Creature — Phyrexian Angel Horror',
	oracleText:
		'Flying, vigilance, deathtouch, lifelink\nAt the beginning of your end step, proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)',
	colors: ['W', 'U', 'B', 'G'],
	colorIdentity: ['W', 'U', 'B', 'G'],
	keywords: ['Flying', 'Vigilance', 'Deathtouch', 'Lifelink'],
	power: '4',
	toughness: '4'
});

reg({
	id: 'cmd_lathril',
	name: 'Lathril, Blade of the Elves',
	manaCost: '{2}{B}{G}',
	cmc: 4,
	typeLine: 'Legendary Creature — Elf Noble',
	oracleText:
		'Menace (This creature can\'t be blocked except by two or more creatures.)\nWhenever Lathril deals combat damage to a player, create that many 1/1 green Elf Warrior creature tokens.\n{T}, Tap ten untapped Elves you control: Each opponent loses 10 life and you gain 10 life.',
	colors: ['B', 'G'],
	colorIdentity: ['B', 'G'],
	keywords: ['Menace'],
	power: '2',
	toughness: '3'
});

reg({
	id: 'cmd_veyran',
	name: 'Veyran, Voice of Duality',
	manaCost: '{1}{U}{R}',
	cmc: 3,
	typeLine: 'Legendary Creature — Efreet Wizard',
	oracleText:
		'Magecraft — Whenever you cast or copy an instant or sorcery spell, Veyran gets +1/+1 until end of turn.\nIf you casting or copying an instant or sorcery spell causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.',
	colors: ['U', 'R'],
	colorIdentity: ['U', 'R'],
	keywords: ['Magecraft'],
	power: '2',
	toughness: '2'
});

reg({
	id: 'cmd_ur_dragon',
	name: 'The Ur-Dragon',
	manaCost: '{4}{W}{U}{B}{R}{G}',
	cmc: 9,
	typeLine: 'Legendary Creature — Dragon Avatar',
	oracleText:
		'Eminence — As long as The Ur-Dragon is in the command zone or on the battlefield, other Dragon spells you cast cost {1} less to cast.\nFlying\nWhenever one or more Dragons you control attack, draw that many cards, then you may put a permanent card from your hand onto the battlefield.',
	colors: ['W', 'U', 'B', 'R', 'G'],
	colorIdentity: ['W', 'U', 'B', 'R', 'G'],
	keywords: ['Flying'],
	power: '10',
	toughness: '10'
});

// --- Artifacts & Mana Rocks ---
reg({
	id: 'card_sol_ring',
	name: 'Sol Ring',
	manaCost: '{1}',
	cmc: 1,
	typeLine: 'Artifact',
	oracleText: '{T}: Add {C}{C}.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_arcane_signet',
	name: 'Arcane Signet',
	manaCost: '{2}',
	cmc: 2,
	typeLine: 'Artifact',
	oracleText: "{T}: Add one mana of any color in your commander's color identity.",
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_chromatic_lantern',
	name: 'Chromatic Lantern',
	manaCost: '{3}',
	cmc: 3,
	typeLine: 'Artifact',
	oracleText:
		'Lands you control have "{T}: Add one mana of any color."\n{T}: Add one mana of any color.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_fellwar_stone',
	name: 'Fellwar Stone',
	manaCost: '{2}',
	cmc: 2,
	typeLine: 'Artifact',
	oracleText: '{T}: Add one mana of any color that a land an opponent controls could produce.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_thought_vessel',
	name: 'Thought Vessel',
	manaCost: '{2}',
	cmc: 2,
	typeLine: 'Artifact',
	oracleText: 'You have no maximum hand size.\n{T}: Add {C}.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_mind_stone',
	name: 'Mind Stone',
	manaCost: '{2}',
	cmc: 2,
	typeLine: 'Artifact',
	oracleText: '{T}: Add {C}.\n{1}, {T}, Sacrifice this artifact: Draw a card.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_commanders_sphere',
	name: "Commander's Sphere",
	manaCost: '{3}',
	cmc: 3,
	typeLine: 'Artifact',
	oracleText:
		'{T}: Add one mana of any color in your commander\'s color identity.\nSacrifice this artifact: Draw a card.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_lightning_greaves',
	name: 'Lightning Greaves',
	manaCost: '{2}',
	cmc: 2,
	typeLine: 'Artifact — Equipment',
	oracleText: 'Equipped creature has haste and shroud. (It can\'t be the target of spells or abilities.)\nEquip {0}',
	colors: [],
	colorIdentity: [],
	keywords: ['Equip']
});
reg({
	id: 'card_swiftfoot_boots',
	name: 'Swiftfoot Boots',
	manaCost: '{2}',
	cmc: 2,
	typeLine: 'Artifact — Equipment',
	oracleText: 'Equipped creature has hexproof and haste. (It can\'t be the target of spells or abilities your opponents control. It can attack and {T} no matter when it came under your control.)\nEquip {1} ({1}: Attach to target creature you control. Equip only as a sorcery.)',
	colors: [],
	colorIdentity: [],
	keywords: ['Equip']
});

// --- Green Ramp & Staples ---
reg({
	id: 'card_cultivate',
	name: 'Cultivate',
	manaCost: '{2}{G}',
	cmc: 3,
	typeLine: 'Sorcery',
	oracleText:
		'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_kodamas_reach',
	name: "Kodama's Reach",
	manaCost: '{2}{G}',
	cmc: 3,
	typeLine: 'Sorcery — Arcane',
	oracleText:
		'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_rampant_growth',
	name: 'Rampant Growth',
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText:
		'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_farseek',
	name: 'Farseek',
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText:
		'Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_llanowar_elves',
	name: 'Llanowar Elves',
	manaCost: '{G}',
	cmc: 1,
	typeLine: 'Creature — Elf Druid',
	oracleText: '{T}: Add {G}.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_elvish_mystic',
	name: 'Elvish Mystic',
	manaCost: '{G}',
	cmc: 1,
	typeLine: 'Creature — Elf Druid',
	oracleText: '{T}: Add {G}.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_fyndhorn_elves',
	name: 'Fyndhorn Elves',
	manaCost: '{G}',
	cmc: 1,
	typeLine: 'Creature — Elf Druid',
	oracleText: '{T}: Add {G}.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_elvish_archdruid',
	name: 'Elvish Archdruid',
	manaCost: '{1}{G}{G}',
	cmc: 3,
	typeLine: 'Creature — Elf Druid',
	oracleText:
		'Other Elf creatures you control get +1/+1.\n{T}: Add {G} for each Elf you control.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '2',
	toughness: '2'
});
reg({
	id: 'card_priest_of_titania',
	name: 'Priest of Titania',
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Creature — Elf Druid',
	oracleText: '{T}: Add {G} for each Elf on the battlefield.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_beast_whisperer',
	name: 'Beast Whisperer',
	manaCost: '{2}{G}{G}',
	cmc: 4,
	typeLine: 'Creature — Elf Druid',
	oracleText: 'Whenever you cast a creature spell, draw a card.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '2',
	toughness: '3'
});
reg({
	id: 'card_marwyn',
	name: 'Marwyn, the Nurturer',
	manaCost: '{2}{G}',
	cmc: 3,
	typeLine: 'Legendary Creature — Elf Druid',
	oracleText:
		'Whenever another Elf you control enters, put a +1/+1 counter on Marwyn.\n{T}: Add an amount of {G} equal to Marwyn\'s power.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_craterhoof_behemoth',
	name: 'Craterhoof Behemoth',
	manaCost: '{5}{G}{G}{G}',
	cmc: 8,
	typeLine: 'Creature — Beast',
	oracleText:
		'Haste\nWhen this creature enters, creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.',
	colors: ['G'],
	colorIdentity: ['G'],
	keywords: ['Haste', 'Trample'],
	power: '5',
	toughness: '5'
});
reg({
	id: 'card_beast_within',
	name: 'Beast Within',
	manaCost: '{2}{G}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText: 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_heroic_intervention',
	name: 'Heroic Intervention',
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText: 'Permanents you control gain hexproof and indestructible until end of turn.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_eternal_witness',
	name: 'Eternal Witness',
	manaCost: '{1}{G}{G}',
	cmc: 3,
	typeLine: 'Creature — Human Shaman',
	oracleText:
		'When this creature enters, you may return target card from your graveyard to your hand.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '2',
	toughness: '1'
});

// --- White Removal & Staples ---
reg({
	id: 'card_swords_to_plowshares',
	name: 'Swords to Plowshares',
	manaCost: '{W}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText: 'Exile target creature. Its controller gains life equal to its power.',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_path_to_exile',
	name: 'Path to Exile',
	manaCost: '{W}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText:
		'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_wrath_of_god',
	name: 'Wrath of God',
	manaCost: '{2}{W}{W}',
	cmc: 4,
	typeLine: 'Sorcery',
	oracleText: "Destroy all creatures. They can't be regenerated.",
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_farewell',
	name: 'Farewell',
	manaCost: '{4}{W}{W}',
	cmc: 6,
	typeLine: 'Sorcery',
	oracleText:
		'Choose one or more —\n• Exile all artifacts.\n• Exile all creatures.\n• Exile all enchantments.\n• Exile all graveyards.',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_smothering_tithe',
	name: 'Smothering Tithe',
	manaCost: '{3}{W}',
	cmc: 4,
	typeLine: 'Enchantment',
	oracleText:
		'Whenever an opponent draws a card, that player may pay {2}. If the player doesn\'t, you create a Treasure token. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_generous_gift',
	name: 'Generous Gift',
	manaCost: '{2}{W}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText: 'Destroy target permanent. Its controller creates a 3/3 green Elephant creature token.',
	colors: ['W'],
	colorIdentity: ['W']
});

// --- Blue Interaction & Draw ---
reg({
	id: 'card_counterspell',
	name: 'Counterspell',
	manaCost: '{U}{U}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText: 'Counter target spell.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_arcane_denial',
	name: 'Arcane Denial',
	manaCost: '{1}{U}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText: 'Counter target spell. Its controller may draw up to two cards at the beginning of the next turn\'s upkeep.\nYou draw a card at the beginning of the next turn\'s upkeep.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_negate',
	name: 'Negate',
	manaCost: '{1}{U}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText: 'Counter target noncreature spell.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_cyclonic_rift',
	name: 'Cyclonic Rift',
	manaCost: '{1}{U}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText:
		'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {6}{U} (You may cast this spell for its overload cost. If you do, change "target" in its text to "each.")',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_rhystic_study',
	name: 'Rhystic Study',
	manaCost: '{2}{U}',
	cmc: 3,
	typeLine: 'Enchantment',
	oracleText:
		'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_brainstorm',
	name: 'Brainstorm',
	manaCost: '{U}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText: 'Draw three cards, then put two cards from your hand on top of your library in any order.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_ponder',
	name: 'Ponder',
	manaCost: '{U}',
	cmc: 1,
	typeLine: 'Sorcery',
	oracleText:
		'Look at the top three cards of your library, then put them back in any order. You may shuffle.\nDraw a card.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_preordain',
	name: 'Preordain',
	manaCost: '{U}',
	cmc: 1,
	typeLine: 'Sorcery',
	oracleText: 'Scry 2, then draw a card. (To scry 2, look at the top two cards of your library, then put any number of them on the bottom and the rest on top in any order.)',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_opt',
	name: 'Opt',
	manaCost: '{U}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText: 'Scry 1. (Look at the top card of your library. You may put that card on the bottom.)\nDraw a card.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_archmage_emeritus',
	name: 'Archmage Emeritus',
	manaCost: '{2}{U}{U}',
	cmc: 4,
	typeLine: 'Creature — Human Wizard',
	oracleText: 'Magecraft — Whenever you cast or copy an instant or sorcery spell, draw a card.',
	colors: ['U'],
	colorIdentity: ['U'],
	power: '2',
	toughness: '2'
});
reg({
	id: 'card_talrand',
	name: 'Talrand, Sky Summoner',
	manaCost: '{2}{U}{U}',
	cmc: 4,
	typeLine: 'Legendary Creature — Merfolk Wizard',
	oracleText:
		'Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake creature token with flying.',
	colors: ['U'],
	colorIdentity: ['U'],
	power: '2',
	toughness: '2'
});

// --- Black Removal, Draw & Tutors ---
reg({
	id: 'card_demonic_tutor',
	name: 'Demonic Tutor',
	manaCost: '{1}{B}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText: 'Search your library for a card, put that card into your hand, then shuffle.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_toxic_deluge',
	name: 'Toxic Deluge',
	manaCost: '{2}{B}',
	cmc: 3,
	typeLine: 'Sorcery',
	oracleText: 'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_feed_the_swarm',
	name: 'Feed the Swarm',
	manaCost: '{1}{B}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText: 'Destroy target creature or enchantment an opponent controls. You lose life equal to that permanent\'s mana value.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_infernal_grasp',
	name: 'Infernal Grasp',
	manaCost: '{1}{B}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText: 'Destroy target creature. You lose 2 life.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_night_whisper',
	name: "Night's Whisper",
	manaCost: '{1}{B}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText: 'You draw two cards and lose 2 life.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_sign_in_blood',
	name: 'Sign in Blood',
	manaCost: '{B}{B}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText: 'Target player draws two cards and loses 2 life.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_read_the_bones',
	name: 'Read the Bones',
	manaCost: '{2}{B}',
	cmc: 3,
	typeLine: 'Sorcery',
	oracleText: 'Scry 2, then draw two cards. You lose 2 life. (To scry 2, look at the top two cards of your library, then put any number of them on the bottom and the rest on top in any order.)',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_reanimate',
	name: 'Reanimate',
	manaCost: '{B}',
	cmc: 1,
	typeLine: 'Sorcery',
	oracleText: 'Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to that card\'s mana value.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_shaman_of_the_pack',
	name: 'Shaman of the Pack',
	manaCost: '{1}{B}{G}',
	cmc: 3,
	typeLine: 'Creature — Elf Shaman',
	oracleText:
		'When this creature enters, target opponent loses life equal to the number of Elves you control.',
	colors: ['B', 'G'],
	colorIdentity: ['B', 'G'],
	power: '3',
	toughness: '2'
});
reg({
	id: 'card_putrefy',
	name: 'Putrefy',
	manaCost: '{1}{B}{G}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText: "Destroy target artifact or creature. It can't be regenerated.",
	colors: ['B', 'G'],
	colorIdentity: ['B', 'G']
});
reg({
	id: 'card_casualties_of_war',
	name: 'Casualties of War',
	manaCost: '{2}{B}{B}{G}{G}',
	cmc: 6,
	typeLine: 'Sorcery',
	oracleText: 'Choose one or more —\n• Destroy target artifact.\n• Destroy target creature.\n• Destroy target enchantment.\n• Destroy target land.\n• Destroy target planeswalker.',
	colors: ['B', 'G'],
	colorIdentity: ['B', 'G']
});

// --- Red Spells, Dragons & Interaction ---
reg({
	id: 'card_lightning_bolt',
	name: 'Lightning Bolt',
	manaCost: '{R}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText: 'Lightning Bolt deals 3 damage to any target.',
	colors: ['R'],
	colorIdentity: ['R']
});
reg({
	id: 'card_chaos_warp',
	name: 'Chaos Warp',
	manaCost: '{2}{R}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it\'s a permanent card, they put it onto the battlefield.',
	colors: ['R'],
	colorIdentity: ['R']
});
reg({
	id: 'card_blasphemous_act',
	name: 'Blasphemous Act',
	manaCost: '{8}{R}',
	cmc: 9,
	typeLine: 'Sorcery',
	oracleText:
		'This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature.',
	colors: ['R'],
	colorIdentity: ['R']
});
reg({
	id: 'card_guttersnipe',
	name: 'Guttersnipe',
	manaCost: '{2}{R}',
	cmc: 3,
	typeLine: 'Creature — Goblin Shaman',
	oracleText: 'Whenever you cast an instant or sorcery spell, this creature deals 2 damage to each opponent.',
	colors: ['R'],
	colorIdentity: ['R'],
	power: '2',
	toughness: '2'
});
reg({
	id: 'card_young_pyromancer',
	name: 'Young Pyromancer',
	manaCost: '{1}{R}',
	cmc: 2,
	typeLine: 'Creature — Human Shaman',
	oracleText:
		'Whenever you cast an instant or sorcery spell, create a 1/1 red Elemental creature token.',
	colors: ['R'],
	colorIdentity: ['R'],
	power: '2',
	toughness: '1'
});
reg({
	id: 'card_storm_kiln_artist',
	name: 'Storm-Kiln Artist',
	manaCost: '{3}{R}',
	cmc: 4,
	typeLine: 'Creature — Dwarf Shaman',
	oracleText:
		'This creature gets +1/+0 for each artifact you control.\nMagecraft — Whenever you cast or copy an instant or sorcery spell, create a Treasure token. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")',
	colors: ['R'],
	colorIdentity: ['R'],
	power: '2',
	toughness: '2'
});
reg({
	id: 'card_goblin_electromancer',
	name: 'Goblin Electromancer',
	manaCost: '{U}{R}',
	cmc: 2,
	typeLine: 'Creature — Goblin Wizard',
	oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.',
	colors: ['U', 'R'],
	colorIdentity: ['U', 'R'],
	power: '2',
	toughness: '2'
});
reg({
	id: 'card_expressive_iteration',
	name: 'Expressive Iteration',
	manaCost: '{U}{R}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText: 'Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. You may play the exiled card this turn.',
	colors: ['U', 'R'],
	colorIdentity: ['U', 'R']
});
reg({
	id: 'card_jeskas_will',
	name: "Jeska's Will",
	manaCost: '{2}{R}',
	cmc: 3,
	typeLine: 'Sorcery',
	oracleText: 'Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Add {R} for each card in target opponent\'s hand.\n• Exile the top three cards of your library. You may play them this turn.',
	colors: ['R'],
	colorIdentity: ['R']
});

// --- Dragons & Counters Synergy ---
reg({
	id: 'card_miirym',
	name: 'Miirym, Sentinel Wyrm',
	manaCost: '{3}{G}{U}{R}',
	cmc: 6,
	typeLine: 'Legendary Creature — Dragon Spirit',
	oracleText:
		'Flying, ward {2}\nWhenever another nontoken Dragon you control enters, create a token that\'s a copy of it, except the token isn\'t legendary.',
	colors: ['G', 'U', 'R'],
	colorIdentity: ['G', 'U', 'R'],
	keywords: ['Flying', 'Ward'],
	power: '6',
	toughness: '6'
});
reg({
	id: 'card_terror_of_the_peaks',
	name: 'Terror of the Peaks',
	manaCost: '{3}{R}{R}',
	cmc: 5,
	typeLine: 'Creature — Dragon',
	oracleText:
		'Flying\nSpells your opponents cast that target this creature cost an additional 3 life to cast.\nWhenever another creature you control enters, this creature deals damage equal to that creature\'s power to any target.',
	colors: ['R'],
	colorIdentity: ['R'],
	keywords: ['Flying'],
	power: '5',
	toughness: '4'
});
reg({
	id: 'card_lathliss',
	name: 'Lathliss, Dragon Queen',
	manaCost: '{4}{R}{R}',
	cmc: 6,
	typeLine: 'Legendary Creature — Dragon',
	oracleText:
		'Flying\nWhenever another nontoken Dragon you control enters, create a 5/5 red Dragon creature token with flying.\n{1}{R}: Dragons you control get +1/+0 until end of turn.',
	colors: ['R'],
	colorIdentity: ['R'],
	keywords: ['Flying'],
	power: '6',
	toughness: '6'
});
reg({
	id: 'card_atarka',
	name: 'Atarka, World Render',
	manaCost: '{5}{R}{G}',
	cmc: 7,
	typeLine: 'Legendary Creature — Dragon',
	oracleText:
		'Flying, trample\nWhenever a Dragon you control attacks, it gains double strike until end of turn.',
	colors: ['R', 'G'],
	colorIdentity: ['R', 'G'],
	keywords: ['Flying', 'Trample', 'Double strike'],
	power: '6',
	toughness: '4'
});
reg({
	id: 'card_hellkite_charger',
	name: 'Hellkite Charger',
	manaCost: '{4}{R}{R}',
	cmc: 6,
	typeLine: 'Creature — Dragon',
	oracleText: 'Flying, haste\nWhenever this creature attacks, you may pay {5}{R}{R}. If you do, untap all attacking creatures and after this phase, there is an additional combat phase.',
	colors: ['R'],
	colorIdentity: ['R'],
	keywords: ['Flying', 'Haste'],
	power: '5',
	toughness: '5'
});
reg({
	id: 'card_goldspan_dragon',
	name: 'Goldspan Dragon',
	manaCost: '{3}{R}{R}',
	cmc: 5,
	typeLine: 'Creature — Dragon',
	oracleText: 'Flying, haste\nWhenever this creature attacks or becomes the target of a spell, create a Treasure token.\nTreasures you control have "{T}, Sacrifice this artifact: Add two mana of any one color."',
	colors: ['R'],
	colorIdentity: ['R'],
	keywords: ['Flying', 'Haste'],
	power: '4',
	toughness: '4'
});
reg({
	id: 'card_scourge_of_valkas',
	name: 'Scourge of Valkas',
	manaCost: '{2}{R}{R}{R}',
	cmc: 5,
	typeLine: 'Creature — Dragon',
	oracleText:
		'Flying\nWhenever this creature or another Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control.\n{R}: This creature gets +1/+0 until end of turn.',
	colors: ['R'],
	colorIdentity: ['R'],
	keywords: ['Flying'],
	power: '4',
	toughness: '4'
});
reg({
	id: 'card_forgotten_ancient',
	name: 'Forgotten Ancient',
	manaCost: '{3}{G}',
	cmc: 4,
	typeLine: 'Creature — Elemental',
	oracleText:
		'Whenever a player casts a spell, you may put a +1/+1 counter on this creature.\nAt the beginning of your upkeep, you may move any number of +1/+1 counters from this creature onto other creatures.',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '0',
	toughness: '3'
});
reg({
	id: 'card_fathom_mage',
	name: 'Fathom Mage',
	manaCost: '{2}{G}{U}',
	cmc: 4,
	typeLine: 'Creature — Human Wizard',
	oracleText:
		'Evolve (Whenever a creature you control enters, if that creature has greater power or toughness than this creature, put a +1/+1 counter on this creature.)\nWhenever a +1/+1 counter is put on this creature, you may draw a card.',
	colors: ['G', 'U'],
	colorIdentity: ['G', 'U'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_crystalline_crawler',
	name: 'Crystalline Crawler',
	manaCost: '{4}',
	cmc: 4,
	typeLine: 'Artifact Creature — Construct',
	oracleText:
		'Converge — This creature enters with a +1/+1 counter on it for each color of mana spent to cast it.\nRemove a +1/+1 counter from this creature: Add one mana of any color.\n{T}: Put a +1/+1 counter on this creature.',
	colors: [],
	colorIdentity: [],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_evolution_sage',
	name: 'Evolution Sage',
	manaCost: '{2}{G}',
	cmc: 3,
	typeLine: 'Creature — Elf Druid',
	oracleText:
		'Landfall — Whenever a land you control enters, proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)',
	colors: ['G'],
	colorIdentity: ['G'],
	power: '3',
	toughness: '2'
});
reg({
	id: 'card_flux_channeler',
	name: 'Flux Channeler',
	manaCost: '{2}{U}',
	cmc: 3,
	typeLine: 'Creature — Human Wizard',
	oracleText: 'Whenever you cast a noncreature spell, proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)',
	colors: ['U'],
	colorIdentity: ['U'],
	power: '2',
	toughness: '2'
});
reg({
	id: 'card_grateful_apparition',
	name: 'Grateful Apparition',
	manaCost: '{1}{W}',
	cmc: 2,
	typeLine: 'Creature — Spirit',
	oracleText:
		'Flying\nWhenever this creature deals combat damage to a player or planeswalker, proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)',
	colors: ['W'],
	colorIdentity: ['W'],
	keywords: ['Flying'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_shalai',
	name: 'Shalai, Voice of Plenty',
	manaCost: '{3}{W}',
	cmc: 4,
	typeLine: 'Legendary Creature — Angel',
	oracleText:
		'Flying\nYou, planeswalkers you control, and other creatures you control have hexproof.\n{4}{G}{G}: Put a +1/+1 counter on each creature you control.',
	colors: ['W'],
	colorIdentity: ['W', 'G'],
	keywords: ['Flying', 'Hexproof'],
	power: '3',
	toughness: '4'
});
reg({
	id: 'card_corpsejack_menace',
	name: 'Corpsejack Menace',
	manaCost: '{2}{B}{G}',
	cmc: 4,
	typeLine: 'Creature — Fungus',
	oracleText:
		'If one or more +1/+1 counters would be put on a creature you control, twice that many +1/+1 counters are put on it instead.',
	colors: ['B', 'G'],
	colorIdentity: ['B', 'G'],
	power: '4',
	toughness: '4'
});
reg({
	id: 'card_mortify',
	name: 'Mortify',
	manaCost: '{1}{W}{B}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText: 'Destroy target creature or enchantment.',
	colors: ['W', 'B'],
	colorIdentity: ['W', 'B']
});
reg({
	id: 'card_anguished_unmaking',
	name: 'Anguished Unmaking',
	manaCost: '{1}{W}{B}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText: 'Exile target nonland permanent. You lose 3 life.',
	colors: ['W', 'B'],
	colorIdentity: ['W', 'B']
});

// --- Continuous Layer, Keyword-Removal & Type-Changing Staples ---
reg({
	id: 'card_shadowspear',
	name: 'Shadowspear',
	manaCost: '{1}',
	cmc: 1,
	typeLine: 'Legendary Artifact — Equipment',
	oracleText:
		'Equipped creature gets +1/+1 and has trample and lifelink.\n{1}: Permanents your opponents control lose hexproof and indestructible until end of turn.\nEquip {2}',
	colors: [],
	colorIdentity: [],
	keywords: ['Trample', 'Lifelink', 'Equip']
});
STAPLE_CARDS['shadow spear'] = STAPLE_CARDS['shadowspear'];

reg({
	id: 'card_arcane_lighthouse',
	name: 'Arcane Lighthouse',
	manaCost: '',
	cmc: 0,
	typeLine: 'Land',
	oracleText:
		'{T}: Add {C}.\n{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can\'t have hexproof or shroud.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_bonds_of_mortality',
	name: 'Bonds of Mortality',
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Enchantment',
	oracleText:
		'When this enchantment enters, draw a card.\n{G}: Creatures your opponents control lose hexproof and indestructible until end of turn.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_darksteel_mutation',
	name: 'Darksteel Mutation',
	manaCost: '{1}{W}',
	cmc: 2,
	typeLine: 'Enchantment — Aura',
	oracleText:
		'Enchant creature\nEnchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types.',
	colors: ['W'],
	colorIdentity: ['W'],
	keywords: ['Enchant', 'Indestructible']
});
reg({
	id: 'card_kenriths_transformation',
	name: "Kenrith's Transformation",
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Enchantment — Aura',
	oracleText:
		'Enchant creature\nWhen this Aura enters, draw a card.\nEnchanted creature loses all abilities and is a green Elk creature with base power and toughness 3/3. (It loses all other card types and creature types.)',
	colors: ['G'],
	colorIdentity: ['G'],
	keywords: ['Enchant']
});
reg({
	id: 'card_imprisoned_in_the_moon',
	name: 'Imprisoned in the Moon',
	manaCost: '{2}{U}',
	cmc: 3,
	typeLine: 'Enchantment — Aura',
	oracleText:
		'Enchant creature, land, or planeswalker\nEnchanted permanent is a colorless land with "{T}: Add {C}" and loses all other card types and abilities.',
	colors: ['U'],
	colorIdentity: ['U'],
	keywords: ['Enchant']
});
reg({
	id: 'card_song_of_the_dryads',
	name: 'Song of the Dryads',
	manaCost: '{2}{G}',
	cmc: 3,
	typeLine: 'Enchantment — Aura',
	oracleText:
		'Enchant permanent\nEnchanted permanent is a colorless Forest land.',
	colors: ['G'],
	colorIdentity: ['G'],
	keywords: ['Enchant']
});
reg({
	id: 'card_blood_moon',
	name: 'Blood Moon',
	manaCost: '{2}{R}',
	cmc: 3,
	typeLine: 'Enchantment',
	oracleText: 'Nonbasic lands are Mountains.',
	colors: ['R'],
	colorIdentity: ['R']
});
reg({
	id: 'card_urborg',
	name: 'Urborg, Tomb of Yawgmoth',
	manaCost: '',
	cmc: 0,
	typeLine: 'Legendary Land',
	oracleText: 'Each land is a Swamp in addition to its other land types.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_yavimaya',
	name: 'Yavimaya, Cradle of Growth',
	manaCost: '',
	cmc: 0,
	typeLine: 'Legendary Land',
	oracleText: 'Each land is a Forest in addition to its other land types.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_mycosynth_lattice',
	name: 'Mycosynth Lattice',
	manaCost: '{6}',
	cmc: 6,
	typeLine: 'Artifact',
	oracleText:
		'All permanents are artifacts in addition to their other types.\nAll cards that aren\'t on the battlefield, spells, and permanents are colorless.\nPlayers may spend mana as though it were mana of any color.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_maskwood_nexus',
	name: 'Maskwood Nexus',
	manaCost: '{4}',
	cmc: 4,
	typeLine: 'Artifact',
	oracleText:
		'Creatures you control are every creature type. The same is true for creature spells you control and creature cards you own that aren\'t on the battlefield.\n{3}, {T}: Create a 2/2 blue Shapeshifter creature token with changeling. (It is every creature type.)',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_humility',
	name: 'Humility',
	manaCost: '{2}{W}{W}',
	cmc: 4,
	typeLine: 'Enchantment',
	oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_dress_down',
	name: 'Dress Down',
	manaCost: '{1}{U}',
	cmc: 2,
	typeLine: 'Enchantment',
	oracleText:
		'Flash\nWhen this enchantment enters, draw a card.\nCreatures lose all abilities.\nAt the beginning of the end step, sacrifice this enchantment.',
	colors: ['U'],
	colorIdentity: ['U'],
	keywords: ['Flash']
});
reg({
	id: 'card_akromas_memorial',
	name: "Akroma's Memorial",
	manaCost: '{7}',
	cmc: 7,
	typeLine: 'Legendary Artifact',
	oracleText:
		'Creatures you control have flying, first strike, vigilance, trample, haste, and protection from black and from red.',
	colors: [],
	colorIdentity: [],
	keywords: ['Flying', 'First strike', 'Vigilance', 'Trample', 'Haste', 'Protection']
});
reg({
	id: 'card_archetype_imagination',
	name: 'Archetype of Imagination',
	manaCost: '{4}{U}{U}',
	cmc: 6,
	typeLine: 'Enchantment Creature — Human Wizard',
	oracleText:
		'Creatures you control have flying.\nCreatures your opponents control lose flying and can\'t have or gain flying.',
	colors: ['U'],
	colorIdentity: ['U'],
	keywords: ['Flying'],
	power: '3',
	toughness: '2'
});
reg({
	id: 'card_obeka',
	name: 'Obeka, Brute Chronologist',
	manaCost: '{1}{U}{B}{R}',
	cmc: 4,
	typeLine: 'Legendary Creature — Ogre Wizard',
	oracleText: '{T}: The player whose turn it is may end the turn. (Exile all spells and abilities from the stack. The player whose turn it is discards down to their maximum hand size. Damage wears off, and "this turn" and "until end of turn" effects end.)',
	colors: ['U', 'B', 'R'],
	colorIdentity: ['U', 'B', 'R'],
	power: '3',
	toughness: '4',
	canBeCommander: true
});
reg({
	id: 'card_sundial_of_the_infinite',
	name: 'Sundial of the Infinite',
	manaCost: '{2}',
	cmc: 2,
	typeLine: 'Artifact',
	oracleText: '{1}, {T}: End the turn. Activate only during your turn. (Exile all spells and abilities from the stack. Discard down to your maximum hand size. Damage wears off, and "this turn" and "until end of turn" effects end.)',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_time_stop',
	name: 'Time Stop',
	manaCost: '{4}{U}{U}',
	cmc: 6,
	typeLine: 'Instant',
	oracleText: 'End the turn. (Exile all spells and abilities, including this spell. The player whose turn it is discards down to their maximum hand size. Damage heals and "this turn" and "until end of turn" effects end.)',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_final_fortune',
	name: 'Final Fortune',
	manaCost: '{R}{R}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText:
		"Take an extra turn after this one. At the beginning of that turn's end step, you lose the game.",
	colors: ['R'],
	colorIdentity: ['R']
});
reg({
	id: 'card_time_warp',
	name: 'Time Warp',
	manaCost: '{3}{U}{U}',
	cmc: 5,
	typeLine: 'Sorcery',
	oracleText: 'Target player takes an extra turn after this one.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_sol_talisman',
	name: 'Sol Talisman',
	manaCost: '',
	cmc: 0,
	typeLine: 'Artifact',
	oracleText: 'Suspend 3—{1} (Rather than cast this card from your hand, pay {1} and exile it with three time counters on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)\n{T}: Add {C}{C}.',
	colors: [],
	colorIdentity: [],
	keywords: ['Suspend']
});
reg({
	id: 'card_ancestral_vision',
	name: 'Ancestral Vision',
	manaCost: '',
	cmc: 0,
	typeLine: 'Sorcery',
	oracleText: 'Suspend 4—{U} (Rather than cast this card from your hand, pay {U} and exile it with four time counters on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)\nTarget player draws three cards.',
	colors: ['U'],
	colorIdentity: ['U'],
	keywords: ['Suspend']
});
reg({
	id: 'card_rift_bolt',
	name: 'Rift Bolt',
	manaCost: '{2}{R}',
	cmc: 3,
	typeLine: 'Sorcery',
	oracleText: 'Rift Bolt deals 3 damage to any target.\nSuspend 1—{R} (Rather than cast this card from your hand, you may pay {R} and exile it with a time counter on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)',
	colors: ['R'],
	colorIdentity: ['R'],
	keywords: ['Suspend']
});
reg({
	id: 'card_teferis_protection',
	name: "Teferi's Protection",
	manaCost: '{2}{W}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText:
		'Until your next turn, your life total can\'t change and you gain protection from everything. All permanents you control phase out. (While they\'re phased out, they\'re treated as though they don\'t exist. They phase in before you untap during your untap step.)\nExile Teferi\'s Protection.',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_slip_out_the_back',
	name: 'Slip Out the Back',
	manaCost: '{U}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText: 'Put a +1/+1 counter on target creature. It phases out. (Treat it and anything attached to it as though they don\'t exist until its controller\'s next turn.)',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_rest_in_peace',
	name: 'Rest in Peace',
	manaCost: '{1}{W}',
	cmc: 2,
	typeLine: 'Enchantment',
	oracleText:
		'When this enchantment enters, exile all graveyards.\nIf a card or token would be put into a graveyard from anywhere, exile it instead.',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_platinum_angel',
	name: 'Platinum Angel',
	manaCost: '{7}',
	cmc: 7,
	typeLine: 'Artifact Creature — Angel',
	oracleText: "Flying\nYou can't lose the game and your opponents can't win the game.",
	colors: [],
	colorIdentity: [],
	keywords: ['Flying'],
	power: '4',
	toughness: '4'
});
reg({
	id: 'card_thassas_oracle',
	name: "Thassa's Oracle",
	manaCost: '{U}{U}',
	cmc: 2,
	typeLine: 'Creature — Merfolk Wizard',
	oracleText:
		'When this creature enters, look at the top X cards of your library, where X is your devotion to blue. Put up to one of them on top of your library and the rest on the bottom of your library in a random order. If X is greater than or equal to the number of cards in your library, you win the game. (Each {U} in the mana costs of permanents you control counts toward your devotion to blue.)',
	colors: ['U'],
	colorIdentity: ['U'],
	power: '1',
	toughness: '3'
});
reg({
	id: 'card_laboratory_maniac',
	name: 'Laboratory Maniac',
	manaCost: '{2}{U}',
	cmc: 3,
	typeLine: 'Creature — Human Wizard',
	oracleText: 'If you would draw a card while your library has no cards in it, you win the game instead.',
	colors: ['U'],
	colorIdentity: ['U'],
	power: '2',
	toughness: '2'
});
reg({
	id: 'card_felidar_sovereign',
	name: 'Felidar Sovereign',
	manaCost: '{4}{W}{W}',
	cmc: 6,
	typeLine: 'Creature — Cat Beast',
	oracleText:
		'Vigilance (Attacking doesn\'t cause this creature to tap.)\nLifelink (Damage dealt by this creature also causes you to gain that much life.)\nAt the beginning of your upkeep, if you have 40 or more life, you win the game.',
	colors: ['W'],
	colorIdentity: ['W'],
	keywords: ['Vigilance', 'Lifelink'],
	power: '4',
	toughness: '6'
});
reg({
	id: 'card_rule_of_law',
	name: 'Rule of Law',
	manaCost: '{2}{W}',
	cmc: 3,
	typeLine: 'Enchantment',
	oracleText: "Each player can't cast more than one spell each turn.",
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_drannith_magistrate',
	name: 'Drannith Magistrate',
	manaCost: '{1}{W}',
	cmc: 2,
	typeLine: 'Creature — Human Wizard',
	oracleText: "Your opponents can't cast spells from anywhere other than their hands.",
	colors: ['W'],
	colorIdentity: ['W'],
	power: '1',
	toughness: '3'
});
reg({
	id: 'card_vedalken_orrery',
	name: 'Vedalken Orrery',
	manaCost: '{4}',
	cmc: 4,
	typeLine: 'Artifact',
	oracleText: 'You may cast spells as though they had flash.',
	colors: [],
	colorIdentity: []
});
reg({
	id: 'card_leyline_of_anticipation',
	name: 'Leyline of Anticipation',
	manaCost: '{2}{U}{U}',
	cmc: 4,
	typeLine: 'Enchantment',
	oracleText:
		'If this card is in your opening hand, you may begin the game with it on the battlefield.\nYou may cast spells as though they had flash.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_propaganda',
	name: 'Propaganda',
	manaCost: '{2}{U}',
	cmc: 3,
	typeLine: 'Enchantment',
	oracleText:
		"Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.",
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_ghostly_prison',
	name: 'Ghostly Prison',
	manaCost: '{2}{W}',
	cmc: 3,
	typeLine: 'Enchantment',
	oracleText:
		"Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.",
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_clone',
	name: 'Clone',
	manaCost: '{3}{U}',
	cmc: 4,
	typeLine: 'Creature — Shapeshifter',
	oracleText: 'You may have this creature enter as a copy of any creature on the battlefield.',
	colors: ['U'],
	colorIdentity: ['U'],
	power: '0',
	toughness: '0'
});
reg({
	id: 'card_inside_out',
	name: 'Inside Out',
	manaCost: '{1}{U/R}',
	cmc: 2,
	typeLine: 'Instant',
	oracleText: "Switch target creature's power and toughness until end of turn.\nDraw a card.",
	colors: ['U', 'R'],
	colorIdentity: ['U', 'R']
});
reg({
	id: 'card_opalescence',
	name: 'Opalescence',
	manaCost: '{2}{W}{W}',
	cmc: 4,
	typeLine: 'Enchantment',
	oracleText:
		'Each other non-Aura enchantment is a creature in addition to its other types and has base power and base toughness each equal to its mana value.',
	colors: ['W'],
	colorIdentity: ['W']
});
reg({
	id: 'card_nether_shadow',
	name: 'Nether Shadow',
	manaCost: '{B}{B}',
	cmc: 2,
	typeLine: 'Creature — Spirit',
	oracleText:
		'Haste\nAt the beginning of your upkeep, if this card is in your graveyard with three or more creature cards above it, you may put this card onto the battlefield.',
	colors: ['B'],
	colorIdentity: ['B'],
	keywords: ['Haste'],
	power: '1',
	toughness: '1'
});
reg({
	id: 'card_corpse_dance',
	name: 'Corpse Dance',
	manaCost: '{2}{B}',
	cmc: 3,
	typeLine: 'Instant',
	oracleText:
		'Buyback {2} (You may pay an additional {2} as you cast this spell. If you do, put this card into your hand as it resolves.)\nReturn the top creature card of your graveyard to the battlefield. That creature gains haste until end of turn. Exile it at the beginning of the next end step.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_opposition_agent',
	name: 'Opposition Agent',
	manaCost: '{2}{B}',
	cmc: 3,
	typeLine: 'Creature — Human Rogue',
	oracleText:
		"Flash\nYou control your opponents while they're searching their libraries.\nWhile an opponent is searching their library, they exile each card they find. You may play those cards for as long as they remain exiled, and you may spend mana as though it were mana of any color to cast them.",
	colors: ['B'],
	colorIdentity: ['B'],
	keywords: ['Flash'],
	power: '3',
	toughness: '2'
});
reg({
	id: 'card_natures_lore',
	name: "Nature's Lore",
	manaCost: '{1}{G}',
	cmc: 2,
	typeLine: 'Sorcery',
	oracleText: 'Search your library for a Forest card, put that card onto the battlefield, then shuffle.',
	colors: ['G'],
	colorIdentity: ['G']
});
reg({
	id: 'card_mystical_tutor',
	name: 'Mystical Tutor',
	manaCost: '{U}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText:
		'Search your library for an instant or sorcery card, reveal it, then shuffle and put that card on top.',
	colors: ['U'],
	colorIdentity: ['U']
});
reg({
	id: 'card_vampiric_tutor',
	name: 'Vampiric Tutor',
	manaCost: '{B}',
	cmc: 1,
	typeLine: 'Instant',
	oracleText:
		'Search your library for a card, then shuffle and put that card on top. You lose 2 life.',
	colors: ['B'],
	colorIdentity: ['B']
});
reg({
	id: 'card_steelshapers_gift',
	name: "Steelshaper's Gift",
	manaCost: '{W}',
	cmc: 1,
	typeLine: 'Sorcery',
	oracleText:
		'Search your library for an Equipment card, reveal that card, put it into your hand, then shuffle.',
	colors: ['W'],
	colorIdentity: ['W']
});

function buildPreconDeck(params: {
	id: string;
	name: string;
	description: string;
	commanderName: string;
	nonBasicCounts: Array<[string, number]>;
	basicCounts: Array<[string, number]>;
}): MagicDeck {
	const commander = STAPLE_CARDS[params.commanderName.toLowerCase()];
	const cards: DeckCardEntry[] = [];
	let totalMain = 0;

	for (const [name, qty] of params.nonBasicCounts) {
		const card = STAPLE_CARDS[name.toLowerCase()];
		if (card) {
			cards.push({ quantity: qty, card });
			totalMain += qty;
		}
	}

	for (const [name, qty] of params.basicCounts) {
		const card = STAPLE_CARDS[name.toLowerCase()];
		if (card) {
			cards.push({ quantity: qty, card });
			totalMain += qty;
		}
	}

	// Ensure exact 99 mainboard + 1 commander = 100 cards
	if (totalMain < 99 && params.basicCounts.length > 0) {
		const diff = 99 - totalMain;
		const lastBasic = cards[cards.length - 1];
		if (lastBasic) {
			lastBasic.quantity += diff;
			totalMain += diff;
		}
	}

	return {
		id: params.id,
		userId: 'system_precon',
		name: params.name,
		description: params.description,
		commanders: [commander],
		cards,
		colorIdentity: commander.colorIdentity,
		cardCount: 1 + totalMain,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		isPrecon: true,
		createdAt: 1730000000000,
		updatedAt: 1730000000000
	};
}

export const PRECON_DECKS: MagicDeck[] = [
	buildPreconDeck({
		id: 'precon_atraxa',
		name: "Praetors' Ascendancy (Atraxa Counters)",
		description:
			'WUBG +1/+1 Counters & Proliferate engine led by Atraxa, Praetors\' Voice. Scales threats every End Step while holding up interaction.',
		commanderName: "Atraxa, Praetors' Voice",
		nonBasicCounts: [
			['Sol Ring', 1],
			['Arcane Signet', 1],
			['Chromatic Lantern', 1],
			['Fellwar Stone', 1],
			['Thought Vessel', 1],
			['Mind Stone', 1],
			["Commander's Sphere", 1],
			['Lightning Greaves', 1],
			['Swiftfoot Boots', 1],
			['Cultivate', 1],
			["Kodama's Reach", 1],
			['Rampant Growth', 1],
			['Farseek', 1],
			['Swords to Plowshares', 1],
			['Path to Exile', 1],
			['Wrath of God', 1],
			['Farewell', 1],
			['Smothering Tithe', 1],
			['Generous Gift', 1],
			['Counterspell', 1],
			['Arcane Denial', 1],
			['Negate', 1],
			['Cyclonic Rift', 1],
			['Rhystic Study', 1],
			['Brainstorm', 1],
			['Ponder', 1],
			['Preordain', 1],
			['Demonic Tutor', 1],
			['Toxic Deluge', 1],
			['Infernal Grasp', 1],
			["Night's Whisper", 1],
			['Putrefy', 1],
			['Mortify', 1],
			['Anguished Unmaking', 1],
			['Beast Within', 1],
			['Heroic Intervention', 1],
			['Eternal Witness', 1],
			['Forgotten Ancient', 1],
			['Fathom Mage', 1],
			['Crystalline Crawler', 1],
			['Evolution Sage', 1],
			['Flux Channeler', 1],
			['Grateful Apparition', 1],
			['Shalai, Voice of Plenty', 1],
			['Corpsejack Menace', 1],
			['Command Tower', 1],
			['Exotic Orchard', 1],
			['Reliquary Tower', 1],
			['Path of Ancestry', 1]
		],
		basicCounts: [
			['Forest', 14],
			['Plains', 12],
			['Island', 12],
			['Swamp', 12]
		]
	}),
	buildPreconDeck({
		id: 'precon_lathril',
		name: 'Blade of the Elves (Lathril Golgari Elves)',
		description:
			'Explosive BG Elf tribal & token swarm deck. Generates massive mana, floods the board with Elves, and drains the table.',
		commanderName: 'Lathril, Blade of the Elves',
		nonBasicCounts: [
			['Sol Ring', 1],
			['Arcane Signet', 1],
			['Fellwar Stone', 1],
			['Thought Vessel', 1],
			['Mind Stone', 1],
			["Commander's Sphere", 1],
			['Lightning Greaves', 1],
			['Swiftfoot Boots', 1],
			['Llanowar Elves', 1],
			['Elvish Mystic', 1],
			['Fyndhorn Elves', 1],
			['Elvish Archdruid', 1],
			['Priest of Titania', 1],
			['Beast Whisperer', 1],
			['Marwyn, the Nurturer', 1],
			['Shaman of the Pack', 1],
			['Evolution Sage', 1],
			['Eternal Witness', 1],
			['Forgotten Ancient', 1],
			['Corpsejack Menace', 1],
			['Craterhoof Behemoth', 1],
			['Cultivate', 1],
			["Kodama's Reach", 1],
			['Rampant Growth', 1],
			['Beast Within', 1],
			['Heroic Intervention', 1],
			['Demonic Tutor', 1],
			['Toxic Deluge', 1],
			['Feed the Swarm', 1],
			['Infernal Grasp', 1],
			["Night's Whisper", 1],
			['Sign in Blood', 1],
			['Read the Bones', 1],
			['Reanimate', 1],
			['Putrefy', 1],
			['Casualties of War', 1],
			['Command Tower', 1],
			['Exotic Orchard', 1],
			['Reliquary Tower', 1],
			['Path of Ancestry', 1]
		],
		basicCounts: [
			['Forest', 36],
			['Swamp', 23]
		]
	}),
	buildPreconDeck({
		id: 'precon_veyran',
		name: 'Arcane Conduit (Veyran Spellslinger)',
		description:
			'High-velocity UR Spellslinger & Magecraft deck. Doubles every spell trigger with Veyran, Guttersnipe, Storm-Kiln Artist, and Talrand.',
		commanderName: 'Veyran, Voice of Duality',
		nonBasicCounts: [
			['Sol Ring', 1],
			['Arcane Signet', 1],
			['Fellwar Stone', 1],
			['Thought Vessel', 1],
			['Mind Stone', 1],
			["Commander's Sphere", 1],
			['Lightning Greaves', 1],
			['Swiftfoot Boots', 1],
			['Goblin Electromancer', 1],
			['Storm-Kiln Artist', 1],
			['Archmage Emeritus', 1],
			['Guttersnipe', 1],
			['Young Pyromancer', 1],
			['Talrand, Sky Summoner', 1],
			['Flux Channeler', 1],
			['Goldspan Dragon', 1],
			['Counterspell', 1],
			['Arcane Denial', 1],
			['Negate', 1],
			['Cyclonic Rift', 1],
			['Rhystic Study', 1],
			['Brainstorm', 1],
			['Ponder', 1],
			['Preordain', 1],
			['Opt', 1],
			['Lightning Bolt', 1],
			['Chaos Warp', 1],
			['Blasphemous Act', 1],
			['Expressive Iteration', 1],
			["Jeska's Will", 1],
			['Command Tower', 1],
			['Exotic Orchard', 1],
			['Reliquary Tower', 1],
			['Path of Ancestry', 1]
		],
		basicCounts: [
			['Island', 34],
			['Mountain', 31]
		]
	}),
	buildPreconDeck({
		id: 'precon_ur_dragon',
		name: 'Primeval Wings (The Ur-Dragon 5C Tribal)',
		description:
			'Five-Color Dragon Tribal powerhouse. Reduces Dragon costs from Turn 0 with Eminence and deploys devastating flying threats.',
		commanderName: 'The Ur-Dragon',
		nonBasicCounts: [
			['Sol Ring', 1],
			['Arcane Signet', 1],
			['Chromatic Lantern', 1],
			['Fellwar Stone', 1],
			["Commander's Sphere", 1],
			['Lightning Greaves', 1],
			['Swiftfoot Boots', 1],
			['Cultivate', 1],
			["Kodama's Reach", 1],
			['Rampant Growth', 1],
			['Farseek', 1],
			['Miirym, Sentinel Wyrm', 1],
			['Terror of the Peaks', 1],
			['Lathliss, Dragon Queen', 1],
			['Atarka, World Render', 1],
			['Hellkite Charger', 1],
			['Goldspan Dragon', 1],
			['Scourge of Valkas', 1],
			['Swords to Plowshares', 1],
			['Path to Exile', 1],
			['Smothering Tithe', 1],
			['Counterspell', 1],
			['Cyclonic Rift', 1],
			['Rhystic Study', 1],
			['Demonic Tutor', 1],
			['Infernal Grasp', 1],
			["Night's Whisper", 1],
			['Lightning Bolt', 1],
			['Chaos Warp', 1],
			['Blasphemous Act', 1],
			['Beast Within', 1],
			['Heroic Intervention', 1],
			['Putrefy', 1],
			['Mortify', 1],
			['Anguished Unmaking', 1],
			['Command Tower', 1],
			['Exotic Orchard', 1],
			['Reliquary Tower', 1],
			['Path of Ancestry', 1]
		],
		basicCounts: [
			['Mountain', 18],
			['Forest', 16],
			['Island', 9],
			['Swamp', 9],
			['Plains', 8]
		]
	})
];
