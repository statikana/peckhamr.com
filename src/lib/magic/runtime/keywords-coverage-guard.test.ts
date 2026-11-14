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
	wither: ['runtime/keywords-combat-damage.test.ts', 'runtime/keywords-damage.test.ts']
};

const SAMPLE_ORACLE_FOR_KEYWORD: Record<string, { typeLine: string; oracleText: string }> = {
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
	ward: { typeLine: 'Creature — Drake', oracleText: 'Ward {2}' }
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
				manaCost: '{1}',
				cmc: 1,
				typeLine: sample.typeLine,
				oracleText: sample.oracleText,
				colors: [],
				colorIdentity: [],
				keywords: [],
				power: sample.typeLine.includes('Creature') ? '2' : undefined,
				toughness: sample.typeLine.includes('Creature') ? '2' : undefined,
				imageUrl: '',
				artCropUrl: '',
				legalCommander: true,
				canBeCommander: sample.typeLine.includes('Legendary Creature'),
				hasPartner: kw === 'partner',
				hasChooseBackground: false,
				isBackground: false
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
			'ward'
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

		// Verify unimplemented keywords (Evolve, Cascade) do not render activeKeywords badges even if present in card.keywords
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
			oracleText: 'Cascade\nEvolve',
			colors: ['G', 'U'],
			colorIdentity: ['G', 'U'],
			keywords: ['Cascade', 'Evolve'],
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
