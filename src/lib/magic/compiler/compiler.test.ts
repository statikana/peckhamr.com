import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clearCompileCache, compileCard } from './index.ts';
import { normalizeFace } from './normalize.ts';
import { STAPLE_CARDS } from '../precons.ts';
import type { ScryfallCard } from '../types.ts';
import type { CardDefinition } from '../ir.ts';

/**
 * IR snapshot tests (ENGINE_ARCHITECTURE_PLAN.md section 5).
 *
 * Expected IR lives in __snapshots__/ir.json. After an intended compiler change, regenerate it with
 *   UPDATE_IR_SNAPSHOTS=1 node --test src/lib/magic/compiler/compiler.test.ts
 * and review the diff like code.
 */

const DIR = new URL('.', import.meta.url).pathname;
const SNAPSHOT_PATH = join(DIR, '__snapshots__', 'ir.json');
const UPDATE = process.env.UPDATE_IR_SNAPSHOTS === '1';

function staple(name: string): ScryfallCard {
	const card = STAPLE_CARDS[name.toLowerCase()];
	if (!card) throw new Error(`Not a precon card: ${name}`);
	return card;
}

function synthetic(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `synthetic_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '',
		cmc: 0,
		typeLine: 'Creature — Elf',
		oracleText: '',
		colors: [],
		colorIdentity: [],
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

// Representative real cards (their text matches Oracle; see the precon integrity test) and
// synthetic cards with invented names, which prove the compiler doesn't rely on card names.
const SNAPSHOT_CARDS: ScryfallCard[] = [
	staple('Forest'),
	staple('Sol Ring'),
	staple('Command Tower'),
	staple('Arcane Signet'),
	staple('Mind Stone'),
	staple('Elvish Archdruid'),
	staple('Marwyn, the Nurturer'),
	staple('Swords to Plowshares'),
	staple('Counterspell'),
	staple('Cyclonic Rift'),
	staple('Wrath of God'),
	staple('Toxic Deluge'),
	staple('Farewell'),
	staple('Cultivate'),
	staple('Ponder'),
	staple('Final Fortune'),
	staple('Rift Bolt'),
	staple('Lightning Greaves'),
	staple('Craterhoof Behemoth'),
	staple('Lathril, Blade of the Elves'),
	staple("Atraxa, Praetors' Voice"),
	staple('Nether Shadow'),
	staple('Felidar Sovereign'),
	staple('Guttersnipe'),
	staple('Veyran, Voice of Duality'),
	synthetic({
		name: 'Bramblecrest, Warden of Ash',
		typeLine: 'Legendary Creature — Elf Druid',
		manaCost: '{1}{G}',
		power: '1',
		toughness: '2',
		colors: ['G'],
		oracleText:
			'Flying, vigilance\nWhen Bramblecrest, Warden of Ash enters, draw a card.\n{T}: Add {G} for each Elf you control.\n{2}, {T}, Sacrifice Bramblecrest: Draw a card.'
	}),
	synthetic({
		name: 'Glimmerfen Overseer',
		typeLine: 'Creature — Faerie',
		oracleText:
			"Landfall — Whenever a land you control enters, you gain 1 life.\nAt the beginning of your upkeep, if you have 40 or more life, you win the game.\nGlimmerfen Overseer's power is equal to the number of cards in your hand.",
		power: '*',
		toughness: '3'
	}),
	synthetic({
		name: 'Twinned Lantern Wardens',
		typeLine: 'Creature — Human Soldier',
		oracleText: 'Ward {2}\nKicker {1}{W}',
		backFace: {
			name: 'Lantern Wardens Ascendant',
			manaCost: '',
			typeLine: 'Creature — Human Soldier',
			oracleText: 'Flying',
			imageUrl: ''
		}
	})
];

function compileFresh(card: ScryfallCard): CardDefinition {
	clearCompileCache();
	// Round-trip through JSON so the snapshot compares plain data.
	return JSON.parse(JSON.stringify(compileCard(card)));
}

describe('Card compiler: IR snapshots', () => {
	const actual: Record<string, CardDefinition> = {};
	for (const card of SNAPSHOT_CARDS) actual[card.name] = compileFresh(card);

	if (UPDATE) {
		writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(actual, null, '\t')}\n`);
	}
	const expected: Record<string, CardDefinition> = existsSync(SNAPSHOT_PATH)
		? JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
		: {};

	for (const card of SNAPSHOT_CARDS) {
		it(`${card.name} compiles to the snapshotted IR`, () => {
			assert.ok(expected[card.name], `No snapshot for ${card.name}; run with UPDATE_IR_SNAPSHOTS=1`);
			assert.deepEqual(actual[card.name], expected[card.name]);
		});
	}

	it('has no stale snapshots', () => {
		assert.deepEqual(
			Object.keys(expected).sort(),
			SNAPSHOT_CARDS.map((c) => c.name).sort()
		);
	});
});

describe('Card compiler: invariants', () => {
	it('compiles the same text under a different name to the same abilities', () => {
		const original = SNAPSHOT_CARDS.find((c) => c.name === 'Bramblecrest, Warden of Ash')!;
		const renamed = synthetic({
			...original,
			id: 'synthetic_renamed',
			name: 'Quillmoss, Keeper of Ferns',
			oracleText: original.oracleText
				.replace(/Bramblecrest, Warden of Ash/g, 'Quillmoss, Keeper of Ferns')
				.replace(/Bramblecrest/g, 'Quillmoss')
		});
		assert.deepEqual(compileFresh(renamed).faces[0].abilities, compileFresh(original).faces[0].abilities);
	});

	it('normalises the full name, the short name and "this <type>" to ~', () => {
		const norm = normalizeFace(
			'Bramblecrest, Warden of Ash',
			"When Bramblecrest, Warden of Ash enters, Bramblecrest's power doubles. Sacrifice this creature. (Reminder text.)"
		);
		assert.equal(norm.text, "When ~ enters, ~'s power doubles. Sacrifice ~.");
	});

	it('records spans that point at the normalised text', () => {
		for (const card of SNAPSHOT_CARDS) {
			const def = compileFresh(card);
			const norm = normalizeFace(card.name, card.oracleText);
			for (const ab of def.faces[0].abilities) {
				if (ab.kind === 'unsupported') {
					assert.equal(norm.text.slice(ab.span.start, ab.span.end), ab.text, `${card.name}: span of "${ab.text}"`);
				}
				assert.ok(ab.span.start >= 0 && ab.span.end <= norm.text.length, `${card.name}: span in range`);
			}
		}
	});

	it('does not depend on the commander identity of the deck', () => {
		const tower = staple('Command Tower');
		const def = compileFresh(tower);
		const mana = def.faces[0].abilities.find((a) => a.kind === 'activated');
		assert.ok(mana && mana.kind === 'activated');
		assert.equal(mana.effect[0].params?.manaChoice, 'commanderIdentity');
	});
});

describe('Precon data integrity', () => {
	// Generated from the Scryfall bulk file by
	//   node scripts/magic-coverage.ts <bulk> --write-precon-fixture src/lib/magic/precon-oracle.fixture.json
	const fixture = JSON.parse(
		readFileSync(join(DIR, '..', 'precon-oracle.fixture.json'), 'utf8')
	) as Record<string, { oracleText: string; typeLine: string; manaCost: string }>;

	it('every precon card matches its Oracle text, type line and mana cost', () => {
		const problems: string[] = [];
		for (const card of Object.values(STAPLE_CARDS)) {
			const oracle = fixture[card.name];
			if (!oracle) {
				problems.push(`${card.name}: missing from the fixture; regenerate it`);
				continue;
			}
			for (const field of ['oracleText', 'typeLine', 'manaCost'] as const) {
				if (card[field] !== oracle[field]) problems.push(`${card.name}: ${field} differs from Oracle`);
			}
		}
		assert.deepEqual(problems, []);
	});
});
