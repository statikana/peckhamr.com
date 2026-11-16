import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMPLEMENTED_KEYWORDS } from '../compiler/card.ts';
import { compileCard } from '../compiler/index.ts';
import { createCardInstance, createInitialGameState, evaluatePermanent } from '../engine.ts';
import { KEYWORD_REGISTRY, KNOWN_KEYWORDS } from '../keywords.ts';
import { PRECON_DECKS } from '../precons.ts';
import { DEFAULT_LOBBY_RULES, type LobbySeat, type MagicDeck, type ScryfallCard } from '../types.ts';
import { KEYWORD_LABELS } from './layers.ts';

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAGIC_DIR = path.resolve(RUNTIME_DIR, '..');

/**
 * Explicit coverage map from every keyword in `IMPLEMENTED_KEYWORDS` (`compiler/card.ts`)
 * to the dedicated test files verifying its compilation and CR 702.x runtime behaviour.
 * Adding a keyword to `IMPLEMENTED_KEYWORDS` without registering its test suite here fails this test.
 */
export const KEYWORD_COVERAGE_FILES: Record<string, readonly string[]> = {
	affinity: ['runtime/keywords-casting.test.ts'],
	afterlife: ['runtime/keywords-casting.test.ts'],
	annihilator: ['runtime/keywords-combat-damage.test.ts'],
	'basic landcycling': ['runtime/keywords-casting.test.ts'],
	'battle cry': ['runtime/keywords-combat-damage.test.ts'],
	bushido: ['runtime/keywords-combat-damage.test.ts'],
	buyback: ['runtime/graveyard-hand-cast-keywords.test.ts'],
	changeling: ['runtime/keywords-casting.test.ts', 'runtime/keywords-damage.test.ts'],
	convoke: ['runtime/convoke-delve.test.ts'],
	crew: ['runtime/crew-and-vehicles.test.ts'],
	cycling: ['runtime/keywords-casting.test.ts'],
	deathtouch: ['runtime/keywords-combat-damage.test.ts', 'runtime/keywords-damage.test.ts'],
	defender: ['runtime/keywords-evasion.test.ts'],
	delve: ['runtime/convoke-delve.test.ts'],
	devoid: ['runtime/keywords-devoid-and-dig.test.ts'],
	disguise: ['runtime/transform-flip-facedown.test.ts'],
	'double strike': ['runtime/keywords-combat-damage.test.ts', 'magic.test.ts'],
	enchant: ['runtime/keywords-protection-attachments.test.ts', 'runtime/tier1b.test.ts'],
	equip: ['runtime/keywords-protection-attachments.test.ts', 'runtime/wave4-cr-completion.test.ts'],
	escape: ['runtime/graveyard-hand-cast-keywords.test.ts'],
	evoke: ['runtime/graveyard-hand-cast-keywords.test.ts'],
	evolve: ['runtime/m1-precon-mechanics.test.ts'],
	exalted: ['runtime/keywords-combat-damage.test.ts'],
	exploit: ['runtime/keywords-casting.test.ts'],
	fear: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	'first strike': ['runtime/keywords-combat-damage.test.ts', 'runtime/turn-combat.test.ts'],
	flash: ['runtime/keywords-casting.test.ts', 'runtime/replace.test.ts'],
	flashback: ['runtime/keywords-casting.test.ts'],
	flying: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	'for mirrodin!': ['runtime/keywords-protection-attachments.test.ts'],
	forestwalk: ['runtime/keywords-evasion.test.ts'],
	fuse: ['runtime/keywords-casting.test.ts'],
	haste: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	hexproof: ['runtime/keywords-protection-attachments.test.ts', 'magic.test.ts'],
	horsemanship: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	indestructible: ['runtime/keywords-protection-attachments.test.ts', 'runtime/sba.test.ts'],
	infect: ['runtime/keywords-combat-damage.test.ts', 'runtime/keywords-damage.test.ts'],
	intimidate: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	islandwalk: ['runtime/keywords-evasion.test.ts'],
	kicker: ['runtime/keywords-casting.test.ts'],
	landcycling: ['runtime/keywords-casting.test.ts'],
	landwalk: ['runtime/keywords-evasion.test.ts'],
	lifelink: ['runtime/keywords-combat-damage.test.ts', 'runtime/combat-tier1.test.ts'],
	'living weapon': ['runtime/keywords-protection-attachments.test.ts'],
	megamorph: ['runtime/transform-flip-facedown.test.ts'],
	menace: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	morph: ['runtime/transform-flip-facedown.test.ts'],
	mountainwalk: ['runtime/keywords-evasion.test.ts'],
	multikicker: ['runtime/keywords-casting.test.ts'],
	'nonbasic landwalk': ['runtime/keywords-evasion.test.ts'],
	overload: ['runtime/keywords-casting.test.ts', 'magic.test.ts'],
	partner: ['runtime/keywords-casting.test.ts', 'runtime/keywords-damage.test.ts'],
	phasing: ['runtime/keywords-phasing.test.ts', 'runtime/turn-combat.test.ts'],
	plainswalk: ['runtime/keywords-evasion.test.ts'],
	protection: ['runtime/keywords-protection-attachments.test.ts', 'runtime/combat-tier1.test.ts'],
	prowess: ['runtime/keywords-casting.test.ts', 'runtime/review-fix2.test.ts'],
	reach: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	shadow: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	shroud: ['runtime/keywords-protection-attachments.test.ts', 'magic.test.ts'],
	storm: ['runtime/land-animate-copy-storm.test.ts'],
	suspend: ['runtime/keywords-casting.test.ts', 'magic.test.ts'],
	swampwalk: ['runtime/keywords-evasion.test.ts'],
	trample: ['runtime/keywords-combat-damage.test.ts', 'runtime/combat-tier1.test.ts'],
	typecycling: ['runtime/keywords-casting.test.ts'],
	unearth: ['runtime/graveyard-hand-cast-keywords.test.ts'],
	vigilance: ['runtime/keywords-evasion.test.ts', 'runtime/tier3b.test.ts'],
	ward: ['runtime/keywords-protection-attachments.test.ts', 'runtime/wave4-cr-completion.test.ts'],
	wither: ['runtime/keywords-combat-damage.test.ts', 'runtime/keywords-damage.test.ts'],
	// --- Track P3 ---
	blitz: ['runtime/orthogonal-keywords-p3.test.ts'],
	'cumulative upkeep': ['runtime/orthogonal-keywords-p3.test.ts'],
	disturb: ['runtime/orthogonal-keywords-p3.test.ts'],
	entwine: ['runtime/orthogonal-keywords-p3.test.ts'],
	foretell: ['runtime/orthogonal-keywords-p3.test.ts'],
	'jump-start': ['runtime/orthogonal-keywords-p3.test.ts'],
	plot: ['runtime/orthogonal-keywords-p3.test.ts'],
	retrace: ['runtime/orthogonal-keywords-p3.test.ts'],
	saddle: ['runtime/orthogonal-keywords-p3.test.ts'],
	// --- Track P6 ---
	casualty: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	conspire: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	fading: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	'level up': ['runtime/striated-frames-and-keywords-p6.test.ts'],
	offspring: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	prototype: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	reinforce: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	replicate: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	squad: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	station: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	transmute: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	vanishing: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	warp: ['runtime/striated-frames-and-keywords-p6.test.ts'],
	// --- Track P8 ---
	skulk: ['runtime/statics-layers-restrictions.test.ts'],
	// --- Track P9 ---
	bloodthirst: ['runtime/keywords-wave3-p9.test.ts'],
	cascade: ['runtime/keywords-wave3-p9.test.ts'],
	'commander ninjutsu': ['runtime/keywords-wave3-p9.test.ts'],
	dash: ['runtime/keywords-wave3-p9.test.ts'],
	echo: ['runtime/keywords-wave3-p9.test.ts'],
	extort: ['runtime/keywords-wave3-p9.test.ts'],
	fabricate: ['runtime/keywords-wave3-p9.test.ts'],
	flanking: ['runtime/keywords-wave3-p9.test.ts'],
	improvise: ['runtime/keywords-wave3-p9.test.ts'],
	madness: ['runtime/keywords-wave3-p9.test.ts'],
	modular: ['runtime/keywords-wave3-p9.test.ts'],
	ninjutsu: ['runtime/keywords-wave3-p9.test.ts'],
	persist: ['runtime/keywords-wave3-p9.test.ts'],
	rebound: ['runtime/keywords-wave3-p9.test.ts'],
	riot: ['runtime/keywords-wave3-p9.test.ts'],
	scavenge: ['runtime/keywords-wave3-p9.test.ts'],
	soulshift: ['runtime/keywords-wave3-p9.test.ts'],
	toxic: ['runtime/keywords-wave3-p9.test.ts'],
	undying: ['runtime/keywords-wave3-p9.test.ts'],
	unleash: ['runtime/keywords-wave3-p9.test.ts'],
	// --- Track P12 ---
	afflict: ['runtime/keywords-wave4-p12.test.ts'],
	aftermath: ['runtime/keywords-wave4-p12.test.ts'],
	awaken: ['runtime/keywords-wave4-p12.test.ts'],
	backup: ['runtime/keywords-wave4-p12.test.ts'],
	bargain: ['runtime/keywords-wave4-p12.test.ts'],
	'beam me up': ['runtime/keywords-wave4-p12.test.ts'],
	bestow: ['runtime/keywords-wave4-p12.test.ts'],
	champion: ['runtime/keywords-wave4-p12.test.ts'],
	decayed: ['runtime/keywords-wave4-p12.test.ts'],
	dethrone: ['runtime/keywords-wave4-p12.test.ts'],
	devour: ['runtime/keywords-wave4-p12.test.ts'],
	dredge: ['runtime/keywords-wave4-p12.test.ts'],
	embalm: ['runtime/keywords-wave4-p12.test.ts'],
	emerge: ['runtime/keywords-wave4-p12.test.ts'],
	encore: ['runtime/keywords-wave4-p12.test.ts'],
	enlist: ['runtime/keywords-wave4-p12.test.ts'],
	escalate: ['runtime/keywords-wave4-p12.test.ts'],
	eternalize: ['runtime/keywords-wave4-p12.test.ts'],
	firebending: ['runtime/keywords-wave4-p12.test.ts'],
	graft: ['runtime/keywords-wave4-p12.test.ts'],
	harmonize: ['runtime/keywords-wave4-p12.test.ts'],
	ingest: ['runtime/keywords-wave4-p12.test.ts'],
	mayhem: ['runtime/keywords-wave4-p12.test.ts'],
	melee: ['runtime/keywords-wave4-p12.test.ts'],
	mentor: ['runtime/keywords-wave4-p12.test.ts'],
	miracle: ['runtime/keywords-wave4-p12.test.ts'],
	mobilize: ['runtime/keywords-wave4-p12.test.ts'],
	myriad: ['runtime/keywords-wave4-p12.test.ts'],
	outlast: ['runtime/keywords-wave4-p12.test.ts'],
	rampage: ['runtime/keywords-wave4-p12.test.ts'],
	recover: ['runtime/keywords-wave4-p12.test.ts'],
	renown: ['runtime/keywords-wave4-p12.test.ts'],
	sneak: ['runtime/keywords-wave4-p12.test.ts'],
	spectacle: ['runtime/keywords-wave4-p12.test.ts'],
	'split second': ['runtime/keywords-wave4-p12.test.ts'],
	sunburst: ['runtime/keywords-wave4-p12.test.ts'],
	surge: ['runtime/keywords-wave4-p12.test.ts'],
	training: ['runtime/keywords-wave4-p12.test.ts'],
	'umbra armor': ['runtime/keywords-wave4-p12.test.ts'],
	undaunted: ['runtime/keywords-wave4-p12.test.ts'],
	'web-slinging': ['runtime/keywords-wave4-p12.test.ts'],
	// --- Track P15 ---
	amplify: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'artifact landwalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	ascend: ['runtime/wave5-p15-frames-keywords.test.ts'],
	assist: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'aura swap': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'choose a background': ['runtime/wave5-p15-frames-keywords.test.ts'],
	cipher: ['runtime/wave5-p15-frames-keywords.test.ts'],
	cleave: ['runtime/wave5-p15-frames-keywords.test.ts'],
	compleated: ['runtime/wave5-p15-frames-keywords.test.ts'],
	craft: ['runtime/wave5-p15-frames-keywords.test.ts'],
	daybound: ['runtime/wave5-p15-frames-keywords.test.ts'],
	demonstrate: ['runtime/wave5-p15-frames-keywords.test.ts'],
	"doctor's companion": ['runtime/wave5-p15-frames-keywords.test.ts'],
	freerunning: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'friends forever': ['runtime/wave5-p15-frames-keywords.test.ts'],
	gift: ['runtime/wave5-p15-frames-keywords.test.ts'],
	gravestorm: ['runtime/wave5-p15-frames-keywords.test.ts'],
	impending: ['runtime/wave5-p15-frames-keywords.test.ts'],
	increment: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'job select': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'legendary landwalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'living metal': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'more than meets the eye': ['runtime/wave5-p15-frames-keywords.test.ts'],
	nightbound: ['runtime/wave5-p15-frames-keywords.test.ts'],
	paradigm: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'power-up': ['runtime/wave5-p15-frames-keywords.test.ts'],
	provoke: ['runtime/wave5-p15-frames-keywords.test.ts'],
	prowl: ['runtime/wave5-p15-frames-keywords.test.ts'],
	ravenous: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'read ahead': ['runtime/wave5-p15-frames-keywords.test.ts', 'runtime/sagas-energy-monarch.test.ts'],
	reconfigure: ['runtime/wave5-p15-frames-keywords.test.ts'],
	ripple: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'snow forestwalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'snow islandwalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'snow landwalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'snow mountainwalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'snow plainswalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	'snow swampwalk': ['runtime/wave5-p15-frames-keywords.test.ts'],
	splice: ['runtime/wave5-p15-frames-keywords.test.ts'],
	'start your engines!': ['runtime/wave5-p15-frames-keywords.test.ts'],
	transfigure: ['runtime/wave5-p15-frames-keywords.test.ts'],
	// --- Track P18a ---
	absorb: ['runtime/wave6-p18a-keywords.test.ts'],
	banding: ['runtime/wave6-p18a-keywords.test.ts'],
	epic: ['runtime/wave6-p18a-keywords.test.ts'],
	fortify: ['runtime/wave6-p18a-keywords.test.ts'],
	frenzy: ['runtime/wave6-p18a-keywords.test.ts'],
	haunt: ['runtime/wave6-p18a-keywords.test.ts'],
	hideaway: ['runtime/wave6-p18a-keywords.test.ts'],
	mutate: ['runtime/wave6-p18a-keywords.test.ts'],
	poisonous: ['runtime/wave6-p18a-keywords.test.ts'],
	soulbond: ['runtime/wave6-p18a-keywords.test.ts'],
	storied: ['runtime/wave6-p18a-keywords.test.ts'],
	teamwork: ['runtime/wave6-p18a-keywords.test.ts'],
	tribute: ['runtime/wave6-p18a-keywords.test.ts'],
	// --- Track P21 ---
	boast: ['runtime/wave7-p21-frames-overrides.test.ts'],
	companion: ['runtime/wave7-p21-frames-overrides.test.ts'],
	exhaust: ['runtime/wave7-p21-frames-overrides.test.ts'],
	forecast: ['runtime/wave7-p21-frames-overrides.test.ts'],
	offering: ['runtime/wave7-p21-frames-overrides.test.ts'],
	'totem armor': ['runtime/wave7-p21-frames-overrides.test.ts'],
	'trample over planeswalkers': ['runtime/wave7-p21-frames-overrides.test.ts'],
	waterbend: ['runtime/wave7-p21-frames-overrides.test.ts']
};

const SAMPLE_ORACLE_FOR_KEYWORD: Record<
	string,
	{
		typeLine: string;
		oracleText: string;
		manaCost?: string;
		loyalty?: string;
		backFace?: ScryfallCard['backFace'];
	}
> = {
	affinity: { typeLine: 'Artifact Creature — Myr', oracleText: 'Affinity for artifacts' },
	afterlife: { typeLine: 'Creature — Human Cleric', oracleText: 'Afterlife 2' },
	annihilator: { typeLine: 'Creature — Eldrazi', oracleText: 'Annihilator 2' },
	'basic landcycling': { typeLine: 'Creature — Elephant', oracleText: 'Basic landcycling {2}' },
	bushido: { typeLine: 'Creature — Human Samurai', oracleText: 'Bushido 1' },
	buyback: { typeLine: 'Instant', oracleText: 'Buyback {3}\nDraw a card.' },
	crew: { typeLine: 'Artifact — Vehicle', oracleText: 'Crew 2' },
	cycling: { typeLine: 'Instant', oracleText: 'Draw a card.\nCycling {2}' },
	disguise: { typeLine: 'Creature — Human Detective', oracleText: 'Disguise {2}{U}' },
	enchant: { typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' },
	equip: { typeLine: 'Artifact — Equipment', oracleText: 'Equip {1}' },
	escape: {
		typeLine: 'Creature — Ox',
		oracleText: 'Escape—{3}{W}, Exile three other cards from your graveyard.'
	},
	evoke: {
		typeLine: 'Creature — Elemental',
		oracleText: 'When ~ enters, draw two cards.\nEvoke {2}{U}'
	},
	flashback: { typeLine: 'Sorcery', oracleText: 'Draw a card.\nFlashback {2}{U}' },
	'for mirrodin!': { typeLine: 'Artifact — Equipment', oracleText: 'For Mirrodin!\nEquip {2}' },
	fuse: { typeLine: 'Instant', oracleText: 'Draw a card.\nFuse' },
	kicker: { typeLine: 'Instant', oracleText: 'Kicker {1}{U}\nDraw a card.' },
	landcycling: { typeLine: 'Creature — Wurm', oracleText: 'Landcycling {2}' },
	'living weapon': { typeLine: 'Artifact — Equipment', oracleText: 'Living weapon\nEquip {2}' },
	megamorph: { typeLine: 'Creature — Beast', oracleText: 'Megamorph {3}{G}' },
	morph: { typeLine: 'Creature — Shapeshifter', oracleText: 'Morph {1}{U}' },
	multikicker: { typeLine: 'Creature — Elf', oracleText: 'Multikicker {1}{G}' },
	overload: {
		typeLine: 'Instant',
		oracleText: "Return target nonland permanent you don't control to its owner's hand.\nOverload {6}{U}"
	},
	partner: { typeLine: 'Legendary Creature — Human', oracleText: 'Partner' },
	protection: { typeLine: 'Creature — Human Knight', oracleText: 'Protection from red' },
	storm: { typeLine: 'Instant', oracleText: 'Draw a card.\nStorm' },
	suspend: { typeLine: 'Sorcery', oracleText: 'Draw a card.\nSuspend 4—{U}' },
	typecycling: { typeLine: 'Creature — Human Wizard', oracleText: 'Wizardcycling {3}' },
	unearth: { typeLine: 'Creature — Zombie', oracleText: 'Unearth {1}{B}' },
	ward: { typeLine: 'Creature — Drake', oracleText: 'Ward {2}' },
	// --- Track P3 ---
	blitz: { typeLine: 'Creature — Viashino Warrior', oracleText: 'Blitz {1}{R}' },
	'cumulative upkeep': { typeLine: 'Creature — Illusion', oracleText: 'Cumulative upkeep {1}' },
	disturb: { typeLine: 'Creature — Spirit', oracleText: 'Disturb {1}{W}' },
	entwine: {
		typeLine: 'Instant',
		oracleText: 'Choose one —\n• Draw a card.\n• Gain 3 life.\nEntwine {2}'
	},
	foretell: { typeLine: 'Instant', oracleText: 'Draw two cards.\nForetell {1}{U}' },
	'jump-start': { typeLine: 'Instant', oracleText: 'Draw a card.\nJump-start' },
	plot: { typeLine: 'Creature — Beast', oracleText: 'Plot {1}{G}' },
	retrace: { typeLine: 'Sorcery', oracleText: 'Draw a card.\nRetrace' },
	saddle: { typeLine: 'Creature — Beast Mount', oracleText: 'Saddle 2' },
	// --- Track P6 ---
	casualty: { typeLine: 'Instant', oracleText: 'Casualty 2\nDraw a card.' },
	conspire: { typeLine: 'Sorcery', oracleText: 'Draw two cards.\nConspire' },
	fading: { typeLine: 'Creature — Beast', oracleText: 'Fading 3' },
	'level up': {
		typeLine: 'Creature — Human Soldier',
		oracleText: 'Level up {1}{W}\nLEVEL 1-2\n3/3\nFirst strike\nLEVEL 3+\n4/4\nFlying, first strike'
	},
	offspring: { typeLine: 'Creature — Mouse', oracleText: 'Offspring {2}' },
	prototype: { typeLine: 'Artifact Creature — Construct', oracleText: 'Prototype {1}{R}{R} — 3/3' },
	reinforce: { typeLine: 'Instant', oracleText: 'Draw a card.\nReinforce 2—{1}{G}' },
	replicate: { typeLine: 'Instant', oracleText: 'Replicate {1}{R}\n~ deals 1 damage to any target.' },
	squad: { typeLine: 'Creature — Human Soldier', oracleText: 'Squad {2}' },
	station: {
		typeLine: 'Artifact — Spacecraft',
		oracleText: 'Station\n5+ | Flying'
	},
	transmute: { typeLine: 'Instant', oracleText: 'Draw a card.\nTransmute {1}{U}{U}' },
	vanishing: { typeLine: 'Creature — Sliver', oracleText: 'Vanishing 3' },
	warp: { typeLine: 'Artifact Creature — Robot Giant', oracleText: 'Warp {3}' },
	// --- Track P9 ---
	bloodthirst: { typeLine: 'Creature — Berserker', oracleText: 'Bloodthirst 2' },
	cascade: { typeLine: 'Sorcery', oracleText: 'Cascade\nDraw a card.' },
	'commander ninjutsu': {
		typeLine: 'Legendary Creature — Human Ninja',
		oracleText: 'Commander ninjutsu {U}{B}'
	},
	dash: { typeLine: 'Creature — Goblin Berserker', oracleText: 'Dash {1}{R}' },
	echo: { typeLine: 'Creature — Goblin', oracleText: 'Echo {1}{R}' },
	extort: { typeLine: 'Creature — Thrull', oracleText: 'Extort' },
	fabricate: { typeLine: 'Creature — Artificer', oracleText: 'Fabricate 2' },
	flanking: { typeLine: 'Creature — Human Knight', oracleText: 'Flanking' },
	improvise: { typeLine: 'Instant', oracleText: 'Improvise\nDraw two cards.' },
	madness: { typeLine: 'Instant', oracleText: '~ deals 3 damage to any target.\nMadness {R}' },
	modular: { typeLine: 'Artifact Creature — Construct', oracleText: 'Modular 2' },
	ninjutsu: { typeLine: 'Creature — Rat Ninja', oracleText: 'Ninjutsu {1}{B}' },
	persist: { typeLine: 'Creature — Faerie', oracleText: 'Persist' },
	rebound: { typeLine: 'Instant', oracleText: 'Draw a card.\nRebound' },
	riot: { typeLine: 'Creature — Ogre Warrior', oracleText: 'Riot' },
	scavenge: { typeLine: 'Creature — Plant Zombie', oracleText: 'Scavenge {2}{G}' },
	soulshift: { typeLine: 'Creature — Spirit', oracleText: 'Soulshift 3' },
	toxic: { typeLine: 'Creature — Phyrexian Mite', oracleText: 'Toxic 1' },
	undying: { typeLine: 'Creature — Wolf', oracleText: 'Undying' },
	unleash: { typeLine: 'Creature — Devil', oracleText: 'Unleash' },
	// --- Track P12 ---
	afflict: { typeLine: 'Creature — Zombie Jackal', oracleText: 'Afflict 2' },
	aftermath: { typeLine: 'Sorcery', oracleText: 'Aftermath\nDraw two cards.' },
	awaken: { typeLine: 'Sorcery', oracleText: 'Destroy target creature.\nAwaken 3—{4}{B}{B}' },
	backup: { typeLine: 'Creature — Human Knight', oracleText: 'Backup 1\nVigilance' },
	bargain: { typeLine: 'Instant', oracleText: 'Bargain\nDraw two cards.' },
	'beam me up': { typeLine: 'Sorcery', oracleText: 'Draw two cards.\nBeam me up {2}{U}' },
	bestow: { typeLine: 'Enchantment Creature — Nymph', oracleText: 'Bestow {3}{W}' },
	champion: { typeLine: 'Creature — Elf Warrior', oracleText: 'Champion an Elf' },
	devour: { typeLine: 'Creature — Beast', oracleText: 'Devour 2' },
	dredge: { typeLine: 'Creature — Plant Troll', oracleText: 'Dredge 4' },
	embalm: { typeLine: 'Creature — Human Cleric', oracleText: 'Embalm {3}{W}' },
	emerge: { typeLine: 'Creature — Eldrazi Crab', oracleText: 'Emerge {5}{U}{U}' },
	encore: { typeLine: 'Creature — Human Pirate', oracleText: 'Encore {4}{R}' },
	escalate: {
		typeLine: 'Instant',
		oracleText: 'Escalate {2}\nChoose one or more —\n• Draw a card.\n• You gain 3 life.'
	},
	eternalize: { typeLine: 'Creature — Naga Wizard', oracleText: 'Eternalize {4}{U}{U}' },
	firebending: { typeLine: 'Creature — Human Monk', oracleText: 'Firebending 2' },
	graft: { typeLine: 'Creature — Plant Mutant', oracleText: 'Graft 2' },
	harmonize: { typeLine: 'Sorcery', oracleText: 'Draw two cards.\nHarmonize {3}{U}' },
	mayhem: { typeLine: 'Sorcery', oracleText: 'Draw two cards.\nMayhem {1}{R}' },
	miracle: { typeLine: 'Sorcery', oracleText: 'Draw two cards.\nMiracle {U}' },
	mobilize: { typeLine: 'Creature — Human Warrior', oracleText: 'Mobilize 2' },
	outlast: { typeLine: 'Creature — Human Soldier', oracleText: 'Outlast {1}{W}' },
	rampage: { typeLine: 'Creature — Beast', oracleText: 'Rampage 2' },
	recover: { typeLine: 'Creature — Zombie', oracleText: 'Recover {1}{B}' },
	renown: { typeLine: 'Creature — Human Soldier', oracleText: 'Renown 1' },
	sneak: { typeLine: 'Creature — Mutant Ninja Turtle', oracleText: 'Sneak {1}{B}' },
	spectacle: { typeLine: 'Sorcery', oracleText: 'Draw two cards.\nSpectacle {R}' },
	'split second': { typeLine: 'Instant', oracleText: 'Split second\nDestroy target artifact.' },
	sunburst: { typeLine: 'Artifact Creature — Construct', oracleText: 'Sunburst' },
	surge: { typeLine: 'Instant', oracleText: 'Draw two cards.\nSurge {1}{U}' },
	'umbra armor': { typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nUmbra armor' },
	undaunted: { typeLine: 'Sorcery', oracleText: 'Undaunted\nDraw two cards.' },
	'web-slinging': { typeLine: 'Creature — Spider Hero', oracleText: 'Web-slinging {2}{W}' },
	// --- Track P15 ---
	amplify: { typeLine: 'Creature — Beast', oracleText: 'Amplify 1' },
	assist: { typeLine: 'Sorcery', oracleText: 'Assist\nDraw two cards.' },
	'aura swap': { typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nAura swap {2}{U}' },
	'choose a background': { typeLine: 'Legendary Creature — Human', oracleText: 'Choose a Background' },
	cipher: { typeLine: 'Sorcery', oracleText: 'Draw a card.\nCipher' },
	cleave: { typeLine: 'Instant', oracleText: 'Cleave {1}{W}\nDestroy target [attacking] creature.' },
	compleated: {
		typeLine: 'Legendary Planeswalker — Jace',
		oracleText: 'Compleated\n+1: Draw a card.',
		manaCost: '{2}{U}{U/P}',
		loyalty: '4'
	},
	craft: {
		typeLine: 'Artifact',
		oracleText: 'Craft with artifact {3}',
		backFace: {
			name: 'Guard Craft Back',
			manaCost: '',
			typeLine: 'Artifact Creature — Golem',
			oracleText: 'Vigilance',
			power: '4',
			toughness: '4',
			imageUrl: ''
		}
	},
	demonstrate: { typeLine: 'Sorcery', oracleText: 'Demonstrate\nDraw two cards.' },
	"doctor's companion": { typeLine: 'Legendary Creature — Human', oracleText: "Doctor's companion" },
	freerunning: { typeLine: 'Sorcery', oracleText: 'Freerunning {1}{B}\nDraw two cards.' },
	'friends forever': { typeLine: 'Legendary Creature — Human', oracleText: 'Friends forever' },
	gift: { typeLine: 'Instant', oracleText: 'Gift a card\nDestroy target artifact.' },
	gravestorm: {
		typeLine: 'Sorcery',
		oracleText: 'Create a 2/2 black Zombie creature token.\nGravestorm'
	},
	impending: { typeLine: 'Enchantment Creature — Glimmer', oracleText: 'Impending 3—{1}{W}' },
	'job select': { typeLine: 'Artifact — Equipment', oracleText: 'Job select\nEquip {2}' },
	'living metal': { typeLine: 'Artifact — Vehicle', oracleText: 'Living metal\nCrew 2' },
	'more than meets the eye': {
		typeLine: 'Legendary Artifact Creature — Robot',
		oracleText: 'More than meets the eye {2}{R}',
		backFace: {
			name: 'Guard Converted Mode',
			manaCost: '',
			typeLine: 'Legendary Artifact — Vehicle',
			oracleText: 'Living metal',
			power: '4',
			toughness: '4',
			imageUrl: ''
		}
	},
	paradigm: { typeLine: 'Sorcery', oracleText: 'Paradigm\nDraw a card.' },
	'power-up': { typeLine: 'Creature — Construct', oracleText: 'Power-up — {2}: Draw a card.' },
	prowl: { typeLine: 'Sorcery', oracleText: 'Prowl {1}{U}\nDraw two cards.' },
	ravenous: { typeLine: 'Creature — Tyranid', oracleText: 'Ravenous', manaCost: '{X}{G}' },
	'read ahead': {
		typeLine: 'Enchantment — Saga',
		oracleText: 'Read ahead\nI — Draw a card.\nII — You gain 2 life.'
	},
	reconfigure: { typeLine: 'Artifact Creature — Equipment Jellyfish', oracleText: 'Reconfigure {2}' },
	ripple: { typeLine: 'Sorcery', oracleText: 'Ripple 4\n~ deals 2 damage to any target.' },
	splice: { typeLine: 'Instant — Arcane', oracleText: 'Draw a card.\nSplice onto Arcane {1}{U}' },
	transfigure: { typeLine: 'Creature — Fleshbag', oracleText: 'Transfigure {1}{B}{B}' },
	// --- Track P18a ---
	absorb: { typeLine: 'Creature — Sliver', oracleText: 'Absorb 1' },
	banding: { typeLine: 'Creature — Human Soldier', oracleText: 'Banding' },
	epic: { typeLine: 'Sorcery', oracleText: 'Draw a card.\nEpic' },
	fortify: { typeLine: 'Artifact — Fortification', oracleText: 'Fortify {3}' },
	frenzy: { typeLine: 'Creature — Goblin Berserker', oracleText: 'Frenzy 2' },
	haunt: { typeLine: 'Creature — Spirit', oracleText: 'Haunt' },
	hideaway: { typeLine: 'Land', oracleText: 'Hideaway 4' },
	mutate: { typeLine: 'Creature — Beast', oracleText: 'Mutate {2}{G}' },
	poisonous: { typeLine: 'Creature — Snake', oracleText: 'Poisonous 1' },
	soulbond: { typeLine: 'Creature — Human Knight', oracleText: 'Soulbond' },
	storied: { typeLine: 'Creature — Dwarf Bard', oracleText: 'Storied' },
	teamwork: { typeLine: 'Instant', oracleText: 'Teamwork 2\nDraw a card.' },
	tribute: { typeLine: 'Creature — Centaur Warrior', oracleText: 'Tribute 2' },
	// --- Track P21 ---
	boast: { typeLine: 'Creature — Human Berserker', oracleText: 'Boast — {1}{R}: Draw a card.' },
	companion: {
		typeLine: 'Legendary Creature — Cat Nightmare',
		oracleText: 'Companion — Each permanent card in your starting deck has mana value 2 or less.'
	},
	exhaust: { typeLine: 'Creature — Goblin Artificer', oracleText: 'Exhaust — {2}{R}: Draw two cards.' },
	forecast: {
		typeLine: 'Creature — Bird Soldier',
		oracleText: 'Forecast — {1}{W}, Reveal ~ from your hand: You gain 2 life.'
	},
	offering: { typeLine: 'Legendary Creature — Rat Ninja', oracleText: 'Rat offering' },
	'totem armor': { typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nTotem armor' },
	'trample over planeswalkers': {
		typeLine: 'Creature — Phyrexian Thrull',
		oracleText: 'Trample over planeswalkers'
	},
	waterbend: { typeLine: 'Creature — Human Monk', oracleText: 'Waterbend {3}: Draw a card.' }
};

describe('Implemented Keywords Coverage Guard', () => {
	it('maps every keyword in IMPLEMENTED_KEYWORDS to existing, non-empty test suites and compiles each to a keyword ability', () => {
		const implemented = [...IMPLEMENTED_KEYWORDS].sort();
		const covered = Object.keys(KEYWORD_COVERAGE_FILES).sort();
		assert.deepEqual(
			covered,
			implemented,
			'Every keyword in IMPLEMENTED_KEYWORDS must have an explicit entry in KEYWORD_COVERAGE_FILES'
		);

		for (const kw of implemented) {
			const relFiles = KEYWORD_COVERAGE_FILES[kw];
			assert.ok(relFiles.length > 0, `Keyword "${kw}" must map to at least one test file`);

			for (const rel of relFiles) {
				const abs = path.join(MAGIC_DIR, rel);
				assert.ok(fs.existsSync(abs), `Missing test file ${rel} for keyword "${kw}"`);
				const content = fs.readFileSync(abs, 'utf8');
				assert.ok(content.includes('describe(') && content.includes('it('), `${rel} must contain tests`);
				assert.ok(
					content.toLowerCase().includes(kw.toLowerCase()),
					`Test file ${rel} mapped for "${kw}" does not mention "${kw}"`
				);
			}

			// Verify canonical compilation never falls through to keyword_not_implemented
			const sample = SAMPLE_ORACLE_FOR_KEYWORD[kw] ?? {
				typeLine: 'Creature — Human',
				oracleText: kw.charAt(0).toUpperCase() + kw.slice(1)
			};
			const card: ScryfallCard = {
				id: `guard_${kw.replace(/\s+/g, '_')}`,
				name: `Guard ${kw}`,
				manaCost: sample.manaCost ?? '{1}',
				cmc: 1,
				typeLine: sample.typeLine,
				oracleText: sample.oracleText,
				colors: [],
				colorIdentity: [],
				keywords: [],
				power:
					sample.typeLine.includes('Creature') || sample.typeLine.includes('Vehicle')
						? '2'
						: undefined,
				toughness:
					sample.typeLine.includes('Creature') || sample.typeLine.includes('Vehicle')
						? '2'
						: undefined,
				loyalty: sample.loyalty,
				imageUrl: '',
				artCropUrl: '',
				legalCommander: true,
				canBeCommander: sample.typeLine.includes('Legendary Creature'),
				hasPartner: kw === 'partner',
				hasChooseBackground: kw === 'choose a background',
				isBackground: false,
				...(sample.backFace ? { backFace: sample.backFace } : {})
			};
			const ir = compileCard(card).faces[0];
			assert.ok(
				ir.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === kw),
				`Expected "${kw}" to compile into a keyword ability`
			);
			assert.equal(
				ir.abilities.some((a) => a.kind === 'unsupported'),
				false,
				`Expected "${kw}" sample card to have zero unsupported abilities`
			);
		}
	});

	it('keeps KEYWORD_LABELS in sync with IMPLEMENTED_KEYWORDS and never renders badges for unimplemented keywords', () => {
		// Parameterized or non-battlefield-badge keywords formatted explicitly outside KEYWORD_LABELS
		const PARAMETERIZED_OR_CAST_KEYWORDS = new Set([
			'affinity',
			'afterlife',
			'annihilator',
			'basic landcycling',
			'bushido',
			'buyback',
			'crew',
			'cycling',
			'disguise',
			'enchant',
			'equip',
			'escape',
			'evoke',
			'flashback',
			'fuse',
			'kicker',
			'landcycling',
			'megamorph',
			'morph',
			'multikicker',
			'overload',
			'partner',
			'protection',
			'suspend',
			'typecycling',
			'unearth',
			'ward',
			// --- Track P3 ---
			'blitz',
			'cumulative upkeep',
			'disturb',
			'entwine',
			'foretell',
			'plot',
			'saddle',
			// --- Track P6 ---
			'casualty',
			'fading',
			'level up',
			'offspring',
			'prototype',
			'reinforce',
			'replicate',
			'squad',
			'transmute',
			'vanishing',
			'warp',
			// --- Track P9 ---
			'bloodthirst',
			'commander ninjutsu',
			'dash',
			'echo',
			'fabricate',
			'madness',
			'modular',
			'ninjutsu',
			'scavenge',
			'soulshift',
			'toxic',
			// --- Track P12 ---
			'afflict',
			'awaken',
			'backup',
			'beam me up',
			'bestow',
			'champion',
			'devour',
			'dredge',
			'embalm',
			'emerge',
			'encore',
			'escalate',
			'eternalize',
			'firebending',
			'graft',
			'harmonize',
			'mayhem',
			'miracle',
			'mobilize',
			'outlast',
			'rampage',
			'recover',
			'renown',
			'sneak',
			'spectacle',
			'surge',
			'web-slinging',
			// --- Track P15 ---
			'amplify',
			'aura swap',
			'cleave',
			'craft',
			'freerunning',
			'gift',
			'impending',
			'more than meets the eye',
			'power-up',
			'prowl',
			'reconfigure',
			'ripple',
			'splice',
			'transfigure',
			// --- Track P18a ---
			'absorb',
			'fortify',
			'frenzy',
			'hideaway',
			'mutate',
			'poisonous',
			'teamwork',
			'tribute',
			// --- Track P21 ---
			'boast',
			'companion',
			'exhaust',
			'forecast',
			'offering',
			'waterbend'
		]);

		assert.deepEqual(
			Object.keys(KEYWORD_REGISTRY).sort(),
			[...KNOWN_KEYWORDS].sort(),
			'KEYWORD_REGISTRY must define every keyword in KNOWN_KEYWORDS'
		);

		const labelKeys = Object.keys(KEYWORD_LABELS).sort();
		for (const key of labelKeys) {
			assert.equal(
				IMPLEMENTED_KEYWORDS.has(key),
				true,
				`KEYWORD_LABELS entry "${key}" is not in IMPLEMENTED_KEYWORDS`
			);
		}

		const expectedSimpleLabels = [...IMPLEMENTED_KEYWORDS]
			.filter((kw) => !PARAMETERIZED_OR_CAST_KEYWORDS.has(kw))
			.sort();
		assert.deepEqual(
			labelKeys,
			expectedSimpleLabels,
			'Every non-parameterized keyword in IMPLEMENTED_KEYWORDS must have a display label in KEYWORD_LABELS'
		);

		// Verify unimplemented keywords (Hidden agenda, Visit) do not render activeKeywords badges even if present in card.keywords
		const d = PRECON_DECKS[0];
		const seats: LobbySeat[] = [
			{
				seatIndex: 0,
				userId: 'p1',
				username: 'P1',
				avatarUrl: '',
				isBot: false,
				deckId: d.id,
				deckName: d.name,
				commanderNames: d.commanders.map((c) => c.name),
				commanderArtUrl: '',
				colorIdentity: d.colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: 0
			}
		];
		const decks = new Map<number, MagicDeck>([[0, d]]);
		const state = createInitialGameState('LABEL_GUARD', seats, decks, DEFAULT_LOBBY_RULES);
		const unimplementedCard: ScryfallCard = {
			id: 'unimpl_badge_check',
			name: 'Unimplemented Keyword Probe',
			manaCost: '{2}{G}{U}',
			cmc: 4,
			typeLine: 'Creature — Mutant',
			oracleText: 'Hidden agenda\nVisit',
			colors: ['G', 'U'],
			colorIdentity: ['G', 'U'],
			keywords: ['Hidden agenda', 'Visit'],
			power: '2',
			toughness: '2',
			imageUrl: '',
			artCropUrl: '',
			legalCommander: true,
			canBeCommander: false,
			hasPartner: false,
			hasChooseBackground: false,
			isBackground: false
		};
		const inst = createCardInstance(unimplementedCard, 'p1', 'battlefield', false, false, 1);
		state.players[0].battlefield.push(inst);
		const evaluated = evaluatePermanent(state, inst);
		assert.deepEqual(evaluated.activeKeywords, []);
	});
});
