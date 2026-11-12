import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMPLEMENTED_KEYWORDS } from '../compiler/card.ts';
import { compileCard } from '../compiler/index.ts';
import type { ScryfallCard } from '../types.ts';

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAGIC_DIR = path.resolve(RUNTIME_DIR, '..');

/**
 * Explicit coverage map from every keyword in `IMPLEMENTED_KEYWORDS` (`compiler/card.ts`)
 * to the dedicated test files verifying its compilation and CR 702.x runtime behaviour.
 * Adding a keyword to `IMPLEMENTED_KEYWORDS` without registering its test suite here fails this test.
 */
export const KEYWORD_COVERAGE_FILES: Record<string, readonly string[]> = {
	changeling: ['runtime/keywords-casting.test.ts', 'runtime/keywords-damage.test.ts'],
	deathtouch: ['runtime/keywords-combat-damage.test.ts', 'runtime/keywords-damage.test.ts'],
	defender: ['runtime/keywords-evasion.test.ts'],
	'double strike': ['runtime/keywords-combat-damage.test.ts', 'magic.test.ts'],
	enchant: ['runtime/keywords-protection-attachments.test.ts', 'runtime/tier1b.test.ts'],
	equip: ['runtime/keywords-protection-attachments.test.ts', 'runtime/wave4-cr-completion.test.ts'],
	fear: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	'first strike': ['runtime/keywords-combat-damage.test.ts', 'runtime/turn-combat.test.ts'],
	flash: ['runtime/keywords-casting.test.ts', 'runtime/replace.test.ts'],
	flying: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	haste: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	hexproof: ['runtime/keywords-protection-attachments.test.ts', 'magic.test.ts'],
	horsemanship: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	indestructible: ['runtime/keywords-protection-attachments.test.ts', 'runtime/sba.test.ts'],
	infect: ['runtime/keywords-combat-damage.test.ts', 'runtime/keywords-damage.test.ts'],
	intimidate: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	lifelink: ['runtime/keywords-combat-damage.test.ts', 'runtime/combat-tier1.test.ts'],
	menace: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	overload: ['runtime/keywords-casting.test.ts', 'magic.test.ts'],
	partner: ['runtime/keywords-casting.test.ts', 'runtime/keywords-damage.test.ts'],
	protection: ['runtime/keywords-protection-attachments.test.ts', 'runtime/combat-tier1.test.ts'],
	prowess: ['runtime/keywords-casting.test.ts', 'runtime/review-fix2.test.ts'],
	reach: ['runtime/keywords-evasion.test.ts', 'magic.test.ts'],
	shadow: ['runtime/keywords-evasion.test.ts', 'runtime/tier2a.test.ts'],
	shroud: ['runtime/keywords-protection-attachments.test.ts', 'magic.test.ts'],
	suspend: ['runtime/keywords-casting.test.ts', 'magic.test.ts'],
	trample: ['runtime/keywords-combat-damage.test.ts', 'runtime/combat-tier1.test.ts'],
	vigilance: ['runtime/keywords-evasion.test.ts', 'runtime/tier3b.test.ts'],
	ward: ['runtime/keywords-protection-attachments.test.ts', 'runtime/wave4-cr-completion.test.ts'],
	wither: ['runtime/keywords-combat-damage.test.ts', 'runtime/keywords-damage.test.ts']
};

const SAMPLE_ORACLE_FOR_KEYWORD: Record<string, { typeLine: string; oracleText: string }> = {
	enchant: { typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' },
	equip: { typeLine: 'Artifact — Equipment', oracleText: 'Equip {1}' },
	overload: {
		typeLine: 'Instant',
		oracleText: "Return target nonland permanent you don't control to its owner's hand.\nOverload {6}{U}"
	},
	partner: { typeLine: 'Legendary Creature — Human', oracleText: 'Partner' },
	protection: { typeLine: 'Creature — Human Knight', oracleText: 'Protection from red' },
	suspend: { typeLine: 'Sorcery', oracleText: 'Draw a card.\nSuspend 4—{U}' },
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
});
