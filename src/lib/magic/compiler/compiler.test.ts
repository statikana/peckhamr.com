import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clearCompileCache, compileCard } from './index.ts';
import { normalizeFace } from './normalize.ts';
import { runtimeTriggers } from './triggers.ts';
import {
	ALTERNATIVE_COST_KEYWORDS,
	GRANTABLE_KEYWORDS,
	GRANTED_TRIGGER_KEYWORD_EVENTS,
	IMPLEMENTED_KEYWORDS,
	KEYWORD_LABELS,
	KEYWORD_REGISTRY,
	KNOWN_KEYWORDS,
	STATIC_CONTINUOUS_KEYWORDS
} from '../keywords.ts';
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

describe('KEYWORD_REGISTRY and Track B3 Slice 1 keyword compilation', () => {
	it('derives consistent views across compiler and runtime from KEYWORD_REGISTRY', () => {
		const entries = Object.values(KEYWORD_REGISTRY);
		const knownSet = new Set(KNOWN_KEYWORDS);
		assert.equal(Object.keys(KEYWORD_REGISTRY).length, entries.length);
		assert.equal(knownSet.size, entries.length);
		for (const spec of entries) {
			assert.equal(knownSet.has(spec.name), true);
			if (spec.status === 'implemented') {
				assert.equal(IMPLEMENTED_KEYWORDS.has(spec.name), true);
			} else {
				assert.equal(IMPLEMENTED_KEYWORDS.has(spec.name), false);
			}
		}
		assert.equal(STATIC_CONTINUOUS_KEYWORDS.has('battle cry'), true);
		assert.equal(GRANTABLE_KEYWORDS.includes('battle cry'), true);
		assert.equal(GRANTABLE_KEYWORDS.includes('prowess'), true);
		assert.equal(GRANTABLE_KEYWORDS.includes('afterlife'), false);
		assert.equal(KEYWORD_LABELS['battle cry'], 'Battle cry');
		assert.equal(KEYWORD_LABELS['living weapon'], 'Living weapon');
		assert.equal(KEYWORD_LABELS['for mirrodin!'], 'For Mirrodin!');
		assert.equal(KEYWORD_LABELS.exploit, 'Exploit');
		assert.equal('flashback' in ALTERNATIVE_COST_KEYWORDS, true);
		assert.equal('overload' in ALTERNATIVE_COST_KEYWORDS, true);
		assert.equal(GRANTED_TRIGGER_KEYWORD_EVENTS.has('cast'), true);
		assert.equal(GRANTED_TRIGGER_KEYWORD_EVENTS.has('attacks'), true);
	});

	it('compiles all 7 B3 Slice 1 keywords into pure IR with runtime triggers and zero unsupported', () => {
		const affArtifacts = compileFresh(
			synthetic({
				name: 'Bronze Sentinel',
				manaCost: '{7}',
				cmc: 7,
				typeLine: 'Artifact Creature — Golem',
				oracleText: 'Affinity for artifacts'
			})
		);
		const affAb = affArtifacts.faces[0].abilities[0];
		assert.equal(affAb.kind, 'keyword');
		if (affAb.kind === 'keyword') {
			assert.equal(affAb.keyword.name, 'affinity');
			assert.equal(affAb.keyword.param, 'for artifacts');
			assert.deepEqual(affAb.keyword.affinityFilter, { types: ['Artifact'] });
		}

		const affOutlaws = compileFresh(
			synthetic({
				name: 'Shadow Syndicate',
				manaCost: '{5}{B}',
				cmc: 6,
				typeLine: 'Sorcery',
				oracleText: 'Affinity for outlaws'
			})
		);
		const outlawAb = affOutlaws.faces[0].abilities[0];
		assert.equal(outlawAb.kind, 'keyword');
		if (outlawAb.kind === 'keyword') {
			assert.deepEqual(outlawAb.keyword.affinityFilter, {
				subtypes: ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock']
			});
		}

		const afterlifeCard = compileFresh(
			synthetic({
				name: 'Orzhov Pontiff Probe',
				manaCost: '{2}{W}{B}',
				cmc: 4,
				typeLine: 'Creature — Human Cleric',
				oracleText: 'Afterlife 2'
			})
		);
		assert.equal(afterlifeCard.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const aftTrig = runtimeTriggers(afterlifeCard);
		assert.equal(aftTrig.length, 1);
		assert.equal(aftTrig[0].trigger.event, 'zoneChange');
		assert.equal(aftTrig[0].effect?.steps[0].verb, 'createToken');

		const battleCryCard = compileFresh(
			synthetic({
				name: 'Accorder Probe',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Knight',
				oracleText: 'Battle cry'
			})
		);
		const bcTrig = runtimeTriggers(battleCryCard);
		assert.equal(bcTrig.length, 1);
		assert.equal(bcTrig[0].trigger.event, 'attacks');
		assert.equal(bcTrig[0].effect?.steps[0].verb, 'pump');

		const bushidoCard = compileFresh(
			synthetic({
				name: 'Samurai Probe',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Creature — Human Samurai',
				oracleText: 'Bushido 3'
			})
		);
		const buTrig = runtimeTriggers(bushidoCard);
		assert.equal(buTrig.length, 1);
		assert.equal(buTrig[0].trigger.event, 'blocks');
		assert.equal(buTrig[0].trigger.or?.[0].event, 'becomesBlocked');

		const exploitCard = compileFresh(
			synthetic({
				name: 'Sidisi Probe',
				manaCost: '{3}{B}',
				cmc: 4,
				typeLine: 'Creature — Zombie Wizard',
				oracleText: 'Exploit'
			})
		);
		const exTrig = runtimeTriggers(exploitCard);
		assert.equal(exTrig.length, 1);
		assert.equal(exTrig[0].effect?.steps[0].verb, 'sacrifice');
		assert.equal(Boolean(exTrig[0].effect?.steps[0].optional), true);

		const mirrodinCard = compileFresh(
			synthetic({
				name: 'Hexplate Probe',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Artifact — Equipment',
				oracleText: 'For Mirrodin!\nEquip {2}'
			})
		);
		assert.equal(mirrodinCard.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const fmTrig = runtimeTriggers(mirrodinCard);
		assert.equal(fmTrig.length, 1);
		assert.equal(fmTrig[0].effect?.steps[0].verb, 'createToken');
		assert.equal(fmTrig[0].effect?.steps[1].verb, 'attach');

		const livingCard = compileFresh(
			synthetic({
				name: 'Flayer Husk Probe',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact — Equipment',
				oracleText: 'Living weapon\nEquip {2}'
			})
		);
		assert.equal(livingCard.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const lwTrig = runtimeTriggers(livingCard);
		assert.equal(lwTrig.length, 1);
		assert.equal(lwTrig[0].effect?.steps[0].verb, 'createToken');
		assert.equal(lwTrig[0].effect?.steps[1].verb, 'attach');
	});

	it('rejects malformed or unsupported keyword parameters cleanly as keyword_not_implemented', () => {
		const malformedCases = [
			'Afterlife X',
			'Afterlife',
			'Bushido',
			'Bushido X',
			'Affinity',
			'Affinity for historic permanents',
			'Flying 2'
		];
		for (const line of malformedCases) {
			const def = compileFresh(
				synthetic({
					name: `Malformed ${line}`,
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Creature — Human',
					oracleText: line
				})
			);
			const ab = def.faces[0].abilities[0];
			assert.equal(ab.kind, 'unsupported', `Expected "${line}" to compile to unsupported`);
			if (ab.kind === 'unsupported') {
				assert.equal(ab.reason, 'keyword_not_implemented', `Expected reason for "${line}"`);
			}
		}
	});

	it('preserves synthetic rename invariance for B3 Slice 1 keywords', () => {
		const baseText = 'Affinity for artifacts\nAfterlife 2\nBattle cry\nBushido 1\nExploit';
		const cardA = compileFresh(
			synthetic({ name: 'Alpha Keyword Probe', manaCost: '{6}', cmc: 6, oracleText: baseText })
		);
		const cardB = compileFresh(
			synthetic({ name: 'Zeta Keyword Mirror', manaCost: '{6}', cmc: 6, oracleText: baseText })
		);
		assert.deepEqual(cardA.faces[0].abilities, cardB.faces[0].abilities);
	});
});

describe('Track B3 Slice 2 keyword compilation (Exalted, Annihilator, Landwalk)', () => {
	it('compiles Exalted, Annihilator N, and all Landwalk variants into IR with zero unsupported', () => {
		const exaltedCard = compileFresh(
			synthetic({
				name: 'Squire of Grace Probe',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Knight',
				oracleText: 'Exalted, exalted'
			})
		);
		assert.equal(exaltedCard.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const exTrigs = runtimeTriggers(exaltedCard);
		assert.equal(exTrigs.length, 2);
		assert.equal(exTrigs[0].trigger.event, 'attacks');
		assert.equal(exTrigs[0].trigger.filter.alone, true);
		assert.equal(exTrigs[0].effect?.steps[0].verb, 'pump');
		assert.deepEqual(exTrigs[0].effect?.steps[0].subject, { k: 'eventObject' });

		const annihilatorCard = compileFresh(
			synthetic({
				name: 'Eldrazi Crusher Probe',
				manaCost: '{8}',
				cmc: 8,
				typeLine: 'Creature — Eldrazi',
				oracleText: 'Annihilator 3'
			})
		);
		assert.equal(annihilatorCard.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const anTrigs = runtimeTriggers(annihilatorCard);
		assert.equal(anTrigs.length, 1);
		assert.equal(anTrigs[0].trigger.event, 'attacks');
		assert.equal(anTrigs[0].trigger.filter.object, 'self');
		assert.equal(anTrigs[0].effect?.steps[0].verb, 'sacrifice');
		assert.deepEqual(anTrigs[0].effect?.steps[0].actor, { k: 'defendingPlayer' });
		assert.deepEqual(anTrigs[0].effect?.steps[0].amount, { k: 'const', n: 3 });

		const landwalkCard = compileFresh(
			synthetic({
				name: 'Walker of Shores Probe',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Creature — Merfolk',
				oracleText:
					'Landwalk, plainswalk, islandwalk, swampwalk, mountainwalk, forestwalk, nonbasic landwalk'
			})
		);
		assert.equal(landwalkCard.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		assert.deepEqual(
			landwalkCard.faces[0].abilities.map((a) => (a.kind === 'keyword' ? a.keyword.name : '')),
			[
				'landwalk',
				'plainswalk',
				'islandwalk',
				'swampwalk',
				'mountainwalk',
				'forestwalk',
				'nonbasic landwalk'
			]
		);
		assert.equal(STATIC_CONTINUOUS_KEYWORDS.has('exalted'), true);
		assert.equal(GRANTABLE_KEYWORDS.includes('exalted'), true);
		assert.equal(GRANTABLE_KEYWORDS.includes('islandwalk'), true);
		assert.equal(GRANTABLE_KEYWORDS.includes('nonbasic landwalk'), true);
		assert.equal(GRANTABLE_KEYWORDS.includes('annihilator'), false);
	});

	it('rejects malformed Annihilator parameters and preserves synthetic rename invariance', () => {
		for (const bad of ['Annihilator', 'Annihilator X', 'Annihilator {2}', 'Annihilator two']) {
			const def = compileFresh(
				synthetic({
					name: `Bad ${bad}`,
					manaCost: '{4}',
					cmc: 4,
					typeLine: 'Creature — Eldrazi',
					oracleText: bad
				})
			);
			const ab = def.faces[0].abilities[0];
			assert.equal(ab.kind, 'unsupported', `Expected "${bad}" to be unsupported`);
			if (ab.kind === 'unsupported') {
				assert.equal(ab.reason, 'keyword_not_implemented');
			}
		}

		const text = 'Exalted\nAnnihilator 2\nIslandwalk, nonbasic landwalk';
		const a = compileFresh(synthetic({ name: 'Silverwind Vanguard', oracleText: text }));
		const b = compileFresh(synthetic({ name: 'Thornpeak Ravager', oracleText: text }));
		assert.deepEqual(a.faces[0].abilities, b.faces[0].abilities);
	});

	it('compiles Kicker and Multikicker costs, conditions, ETB replacements, and rejects instead overrides', () => {
		const single = compileFresh(
			synthetic({
				name: 'Kicker Bolt',
				typeLine: 'Instant',
				oracleText: 'Kicker {1}{R}\nKicker Bolt deals 2 damage to any target.\nIf Kicker Bolt was kicked, it deals 1 damage to any target.'
			})
		);
		assert.equal(single.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const kKw = single.faces[0].abilities.find((a) => a.kind === 'keyword');
		assert.equal(kKw?.kind, 'keyword');
		if (kKw?.kind === 'keyword') {
			assert.equal(kKw.keyword.name, 'kicker');
			assert.equal(kKw.keyword.kickerCosts?.[0]?.cost, '{1}{R}');
			assert.ok(kKw.keyword.kickerCosts?.[0]?.tags.includes('{1}{R}'));
			assert.ok(kKw.keyword.kickerCosts?.[0]?.tags.includes('red'));
		}
		const kSpell = single.faces[0].abilities.find((a) => a.kind === 'spell');
		assert.equal(kSpell?.kind, 'spell');
		if (kSpell?.kind === 'spell') {
			assert.equal(kSpell.targets.length, 2);
			assert.equal(kSpell.targets[0].condition, undefined);
			assert.deepEqual(kSpell.targets[1].condition, { k: 'kicked' });
			assert.deepEqual(kSpell.effect[1].condition, { k: 'kicked' });
		}

		const dual = compileFresh(
			synthetic({
				name: 'Dual Kicker Squire',
				typeLine: 'Creature — Human',
				oracleText:
					'Kicker {W} and/or {B}\nWhen Dual Kicker Squire enters, if it was kicked with its {W} kicker, you gain 4 life.\nWhen Dual Kicker Squire enters, if it was kicked with its {B} kicker, target player discards a card.'
			})
		);
		assert.equal(dual.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const dualKw = dual.faces[0].abilities.find((a) => a.kind === 'keyword');
		if (dualKw?.kind === 'keyword') {
			assert.equal(dualKw.keyword.kickerCosts?.length, 2);
			assert.ok(dualKw.keyword.kickerCosts?.[0]?.tags.includes('{W}'));
			assert.ok(dualKw.keyword.kickerCosts?.[0]?.tags.includes('white'));
			assert.ok(dualKw.keyword.kickerCosts?.[1]?.tags.includes('{B}'));
			assert.ok(dualKw.keyword.kickerCosts?.[1]?.tags.includes('black'));
		}

		const dashAndMulti = compileFresh(
			synthetic({
				name: 'Multi Hydra',
				typeLine: 'Creature — Hydra',
				oracleText:
					'Multikicker {1}{G}\nMulti Hydra enters with two +1/+1 counters on it for each time it was kicked.'
			})
		);
		assert.equal(dashAndMulti.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const rep = dashAndMulti.faces[0].abilities.find((a) => a.kind === 'replacement');
		assert.equal(rep?.kind, 'replacement');
		if (rep?.kind === 'replacement' && !Array.isArray(rep.replacement.with) && rep.replacement.with.k === 'modify') {
			assert.deepEqual(rep.replacement.with.counters, {
				counter: '+1/+1',
				amount: { k: 'kickedCount', multiplier: 2 }
			});
		}

		const nonMana = compileFresh(
			synthetic({
				name: 'Blood Kicker',
				typeLine: 'Creature — Vampire',
				oracleText:
					'Kicker—Pay 3 life.\nIf Blood Kicker was kicked, it enters tapped.'
			})
		);
		assert.equal(nonMana.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);

		for (const bad of ['Kicker', 'Multikicker', 'Kicker—Florb a glorb.']) {
			const badDef = compileFresh(synthetic({ name: `Bad ${bad}`, oracleText: bad }));
			const ab = badDef.faces[0].abilities[0];
			assert.equal(ab?.kind, 'unsupported', `Expected "${bad}" to be unsupported`);
			if (ab?.kind === 'unsupported') assert.equal(ab.reason, 'unparsed');
		}

		const insteadDef = compileFresh(
			synthetic({
				name: 'Instead Shock',
				typeLine: 'Instant',
				oracleText:
					'Kicker {2}\nInstead Shock deals 2 damage to any target. If Instead Shock was kicked, it deals 4 damage to that target instead.'
			})
		);
		assert.equal(insteadDef.faces[0].abilities.some((a) => a.kind === 'unsupported'), true);

		const textA = 'Kicker {2}\n~ deals 2 damage to any target.\nIf ~ was kicked, draw a card.';
		const inv1 = compileFresh(synthetic({ name: 'Amber Flare', typeLine: 'Instant', oracleText: textA }));
		const inv2 = compileFresh(synthetic({ name: 'Cobalt Spark', typeLine: 'Instant', oracleText: textA }));
		assert.deepEqual(inv1.faces[0].abilities, inv2.faces[0].abilities);
	});
});
