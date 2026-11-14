import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	clearCompileCache,
	compileCard,
	compiledStackItemEffects,
	describeModalModes,
	expandModalEffects,
	getAbilityModal
} from './index.ts';
import { getCardActivatedAbilities } from '../ruleTree.ts';
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

describe('Cycling & Typecycling compilation', () => {
	it('compiles Cycling mana, life, and composite costs without unsupported abilities', () => {
		const manaCycler = compileFresh(
			synthetic({
				name: 'Sand Scout',
				typeLine: 'Creature — Human Scout',
				oracleText: 'Cycling {2} ({2}, Discard this card: Draw a card.)'
			})
		);
		assert.equal(manaCycler.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const manaKw = manaCycler.faces[0].abilities.find((a) => a.kind === 'keyword');
		assert.equal(manaKw?.kind, 'keyword');
		if (manaKw?.kind === 'keyword') {
			assert.equal(manaKw.keyword.name, 'cycling');
			assert.equal(manaKw.keyword.cost, '{2}');
			assert.deepEqual(manaKw.keyword.costDefs, [{ k: 'mana', cost: '{2}' }]);
			assert.equal(manaKw.keyword.cyclingFilter, undefined);
		}

		const lifeCycler = compileFresh(
			synthetic({
				name: 'Street Pulse',
				typeLine: 'Creature — Elemental',
				oracleText: 'Cycling—Pay 2 life.'
			})
		);
		assert.equal(lifeCycler.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const lifeKw = lifeCycler.faces[0].abilities.find((a) => a.kind === 'keyword');
		assert.equal(lifeKw?.kind, 'keyword');
		if (lifeKw?.kind === 'keyword') {
			assert.equal(lifeKw.keyword.name, 'cycling');
			assert.deepEqual(lifeKw.keyword.costDefs, [{ k: 'payLife', amount: { k: 'const', n: 2 } }]);
		}

		const compositeCycler = compileFresh(
			synthetic({
				name: 'Ash Ritualist',
				typeLine: 'Creature — Warlock',
				oracleText: 'Cycling—{1}, Sacrifice a creature.'
			})
		);
		assert.equal(compositeCycler.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const compKw = compositeCycler.faces[0].abilities.find((a) => a.kind === 'keyword');
		assert.equal(compKw?.kind, 'keyword');
		if (compKw?.kind === 'keyword') {
			assert.equal(compKw.keyword.name, 'cycling');
			assert.equal(compKw.keyword.costDefs?.[0]?.k, 'mana');
			assert.equal(compKw.keyword.costDefs?.[1]?.k, 'sacrifice');
		}
	});

	it('compiles Basic landcycling, Landcycling, and [quality]cycling variants cleanly', () => {
		const variants: Array<{
			oracleText: string;
			expectedName: string;
			expectedMana: string;
			expectedSupertypes?: string[];
			expectedTypes?: string[];
			expectedSubtypes?: string[];
		}> = [
			{
				oracleText: 'Basic landcycling {2}',
				expectedName: 'basic landcycling',
				expectedMana: '{2}',
				expectedSupertypes: ['Basic'],
				expectedTypes: ['Land']
			},
			{
				oracleText: 'Landcycling {2}',
				expectedName: 'landcycling',
				expectedMana: '{2}',
				expectedTypes: ['Land']
			},
			{
				oracleText: 'Plainscycling {2}',
				expectedName: 'typecycling',
				expectedMana: '{2}',
				expectedSubtypes: ['Plains']
			},
			{
				oracleText: 'Islandcycling {1}',
				expectedName: 'typecycling',
				expectedMana: '{1}',
				expectedSubtypes: ['Island']
			},
			{
				oracleText: 'Swampcycling {2}',
				expectedName: 'typecycling',
				expectedMana: '{2}',
				expectedSubtypes: ['Swamp']
			},
			{
				oracleText: 'Mountaincycling {2}',
				expectedName: 'typecycling',
				expectedMana: '{2}',
				expectedSubtypes: ['Mountain']
			},
			{
				oracleText: 'Forestcycling {2}',
				expectedName: 'typecycling',
				expectedMana: '{2}',
				expectedSubtypes: ['Forest']
			},
			{
				oracleText: 'Wizardcycling {3}',
				expectedName: 'typecycling',
				expectedMana: '{3}',
				expectedSubtypes: ['Wizard']
			},
			{
				oracleText: 'Slivercycling {3}',
				expectedName: 'typecycling',
				expectedMana: '{3}',
				expectedSubtypes: ['Sliver']
			},
			{
				oracleText: 'Artifactcycling {2}',
				expectedName: 'typecycling',
				expectedMana: '{2}',
				expectedTypes: ['Artifact']
			},
			{
				oracleText: 'Basic Swampcycling {2}',
				expectedName: 'typecycling',
				expectedMana: '{2}',
				expectedSupertypes: ['Basic'],
				expectedSubtypes: ['Swamp']
			}
		];

		for (const v of variants) {
			const def = compileFresh(
				synthetic({
					name: `Synthetic ${v.oracleText}`,
					typeLine: 'Creature — Spirit',
					oracleText: v.oracleText
				})
			);
			assert.equal(
				def.faces[0].abilities.some((a) => a.kind === 'unsupported'),
				false,
				`${v.oracleText} produced unsupported`
			);
			const kw = def.faces[0].abilities.find((a) => a.kind === 'keyword');
			assert.equal(kw?.kind, 'keyword', `${v.oracleText} missing keyword ability`);
			if (kw?.kind === 'keyword') {
				assert.equal(kw.keyword.name, v.expectedName);
				assert.equal(kw.keyword.cost, v.expectedMana);
				assert.ok(kw.keyword.cyclingFilter, `${v.oracleText} missing cyclingFilter`);
				if (v.expectedSupertypes) {
					assert.deepEqual(kw.keyword.cyclingFilter.supertypes, v.expectedSupertypes);
				}
				if (v.expectedTypes) {
					assert.deepEqual(kw.keyword.cyclingFilter.types, v.expectedTypes);
				}
				if (v.expectedSubtypes) {
					assert.deepEqual(kw.keyword.cyclingFilter.subtypes, v.expectedSubtypes);
				}
			}
		}
	});

	it('compiles cycling cost modifier statics and rejects invalid cycling syntax cleanly', () => {
		const reducer = compileFresh(
			synthetic({
				name: 'Fluctuation Stone',
				typeLine: 'Artifact',
				oracleText: 'Cycling abilities you activate cost {2} less to activate.'
			})
		);
		assert.equal(reducer.faces[0].abilities.some((a) => a.kind === 'unsupported'), false);
		const staticAb = reducer.faces[0].abilities.find((a) => a.kind === 'static');
		assert.equal(staticAb?.kind, 'static');
		if (staticAb?.kind === 'static') {
			assert.equal(staticAb.static.k, 'costModifier');
			if (staticAb.static.k === 'costModifier') {
				assert.deepEqual(staticAb.static.affects, { k: 'ability', keyword: 'cycling' });
				assert.equal(staticAb.static.delta.mode, 'reduce');
				assert.equal(staticAb.static.delta.generic, 2);
			}
		}

		for (const bad of ['Cycling', 'Cycling—Florb a glorb.', 'Typecycling {2}', 'thecycling {2}']) {
			const def = compileFresh(
				synthetic({
					name: `Bad ${bad}`,
					typeLine: 'Creature — Human',
					oracleText: bad
				})
			);
			assert.equal(
				def.faces[0].abilities.some((a) => a.kind === 'unsupported'),
				true,
				`Expected unsupported for "${bad}"`
			);
		}
	});

	it('preserves rename invariance and builds hand-zone abilities + stack effects cleanly', () => {
		const cardA = synthetic({
			name: 'Dune Runner',
			typeLine: 'Creature — Jackal',
			oracleText: 'Cycling {2}\nPlainscycling {2}'
		});
		const cardB = synthetic({
			name: 'Veld Scout',
			typeLine: 'Creature — Jackal',
			oracleText: 'Cycling {2}\nPlainscycling {2}'
		});
		const defA = compileFresh(cardA);
		const defB = compileFresh(cardB);
		assert.deepEqual(defA.faces[0].abilities, defB.faces[0].abilities);

		const abs = getCardActivatedAbilities(cardA);
		assert.equal(abs.length, 2);
		for (const ab of abs) {
			assert.deepEqual(ab.activationZones, ['hand']);
			assert.equal(ab.costKeyword, 'cycling');
			assert.equal(ab.manaCost, '{2}');
			assert.deepEqual(ab.cost, [
				{ k: 'mana', cost: '{2}' },
				{ k: 'discard', count: { k: 'const', n: 1 }, filter: 'self' }
			]);
		}

		const cyclingCompiled = compiledStackItemEffects({
			id: 'stack_1',
			controllerId: 'p1',
			kind: 'activated',
			sourceInstanceId: 'src_1',
			title: `${cardA.name} Ability`,
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0,
			abilityId: abs[0].id,
			card: cardA,
			oracleText: abs[0].effectText
		});
		assert.ok(cyclingCompiled);
		assert.equal(cyclingCompiled.steps[0]?.verb, 'draw');
		assert.deepEqual(cyclingCompiled.steps[0]?.amount, { k: 'const', n: 1 });

		const searchCompiled = compiledStackItemEffects({
			id: 'stack_2',
			controllerId: 'p1',
			kind: 'activated',
			sourceInstanceId: 'src_1',
			title: `${cardA.name} Ability`,
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0,
			abilityId: abs[1].id,
			card: cardA,
			oracleText: abs[1].effectText
		});
		assert.ok(searchCompiled);
		const searchStep = searchCompiled.steps[0];
		assert.equal(searchStep?.verb, 'search');
		const searchParam = searchStep?.params?.search;
		assert.ok(searchParam);
		assert.equal(searchParam.reveal, true);
		assert.deepEqual(searchParam.destinations, [{ zone: 'hand' }]);
		assert.deepEqual(searchParam.filter.subtypes, ['Plains']);
	});

	it('compiles cycling and discard triggers (CR 702.29c–d)', () => {
		// 1. "When you cycle ~, ..." -> event: 'cycle', object: 'self', fromZone: 'any'
		const selfTrigger = compileFresh(
			synthetic({
				name: 'Deem Worthy',
				typeLine: 'Instant',
				manaCost: '{4}{R}',
				oracleText: 'Cycling {3}{R}\nWhen you cycle Deem Worthy, ~ deals 7 damage to target creature.'
			})
		);
		const cycleTrig = selfTrigger.faces[0].abilities.find((a) => a.kind === 'triggered');
		assert.ok(cycleTrig && cycleTrig.kind === 'triggered');
		assert.deepEqual(cycleTrig.trigger, {
			event: 'cycle',
			filter: { object: 'self', player: { relation: 'you' } },
			fromZone: 'any'
		});

		// 2. "Whenever you cycle a card, ..." and "Whenever a player cycles a [quality] card, ..."
		const youCycleCard = compileFresh(
			synthetic({
				name: 'Cycle Watcher',
				typeLine: 'Enchantment',
				oracleText: 'Whenever you cycle a card, you gain 2 life.'
			})
		);
		const t2 = youCycleCard.faces[0].abilities[0];
		assert.ok(t2 && t2.kind === 'triggered');
		assert.deepEqual(t2.trigger, {
			event: 'cycle',
			filter: { player: { relation: 'you' }, object: {} }
		});

		const playerCycleCreature = compileFresh(
			synthetic({
				name: 'Beast Cycler Watcher',
				typeLine: 'Enchantment',
				oracleText: 'Whenever a player cycles a creature card, draw a card.'
			})
		);
		const t3 = playerCycleCreature.faces[0].abilities[0];
		assert.ok(t3 && t3.kind === 'triggered');
		assert.deepEqual(t3.trigger, {
			event: 'cycle',
			filter: { player: { relation: 'any' }, object: { types: ['Creature'] } }
		});

		// 3. "Whenever you cycle or discard a card, ..." -> single 'discard' TriggerDef (CR 702.29d)
		const cycleOrDiscard = compileFresh(
			synthetic({
				name: 'Drake Nest',
				typeLine: 'Enchantment',
				oracleText: 'Whenever you cycle or discard a card, you gain 1 life.'
			})
		);
		const t4 = cycleOrDiscard.faces[0].abilities[0];
		assert.ok(t4 && t4.kind === 'triggered');
		assert.deepEqual(t4.trigger, {
			event: 'discard',
			filter: { player: { relation: 'you' }, object: {} }
		});

		const filteredCycleOrDiscard = compileFresh(
			synthetic({
				name: 'Creature Discard Watcher',
				typeLine: 'Enchantment',
				oracleText: 'Whenever a player cycles or discards a creature card, you gain 1 life.'
			})
		);
		const t5 = filteredCycleOrDiscard.faces[0].abilities[0];
		assert.ok(t5 && t5.kind === 'triggered');
		assert.deepEqual(t5.trigger, {
			event: 'discard',
			filter: { player: { relation: 'any' }, object: { types: ['Creature'] } }
		});

		// 4. "Whenever an opponent discards a card, ..." -> event: 'discard'
		const oppDiscard = compileFresh(
			synthetic({
				name: 'Liliana Watcher',
				typeLine: 'Enchantment',
				oracleText: 'Whenever an opponent discards a card, you gain 2 life.'
			})
		);
		const t6 = oppDiscard.faces[0].abilities[0];
		assert.ok(t6 && t6.kind === 'triggered');
		assert.deepEqual(t6.trigger, {
			event: 'discard',
			filter: { player: { relation: 'opponent' }, object: {} }
		});

		// 5. Unsupported effect on "When you cycle ~" still preserves trigger metadata for manual resolution
		const manualCycle = compileFresh(
			synthetic({
				name: 'Silence Decree',
				typeLine: 'Enchantment',
				oracleText: 'Cycling {4}{U}{U}\nWhen you cycle Silence Decree, counter target spell.'
			})
		);
		const t7 = manualCycle.faces[0].abilities.find((a) => a.kind === 'unsupported');
		assert.ok(t7 && t7.kind === 'unsupported');
		assert.deepEqual(t7.trigger, {
			event: 'cycle',
			filter: { object: 'self', player: { relation: 'you' } },
			fromZone: 'any'
		});
	});
});

describe('Track D Slice 3: modal triggered, activated, loyalty, and multi-target compilation', () => {
	it('compiles modal ETB and Landfall triggered abilities onto IR and runtimeTriggers with modal metadata', () => {
		const etbCard = synthetic({
			name: 'Charmweaver Spirit',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Spirit',
			oracleText:
				'When Charmweaver Spirit enters, choose one —\n• Put a +1/+1 counter on target creature.\n• Destroy target artifact.\n• Draw a card.'
		});
		const etbDef = compileFresh(etbCard);
		assert.equal(etbDef.fullySupported, true);
		const trig = etbDef.faces[0].abilities.find((a) => a.kind === 'triggered');
		assert.ok(trig && trig.kind === 'triggered' && trig.modal);
		assert.equal(trig.modal.min, 1);
		assert.equal(trig.modal.max, 1);
		assert.equal(trig.modal.modes.length, 3);
		assert.equal(trig.modal.modes[0].targets.length, 1);

		const rt = runtimeTriggers(etbDef);
		assert.equal(rt.length, 1);
		assert.ok(rt[0].effect?.modal);
		assert.equal(rt[0].effect?.modal.modes.length, 3);

		const landfallCard = synthetic({
			name: 'Terracharm Elemental',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Creature — Elemental',
			oracleText:
				'Landfall — Whenever a land enters under your control, choose up to two —\n• Draw a card.\n• Gain 2 life.\n• Scry 1.'
		});
		const landfallDef = compileFresh(landfallCard);
		assert.equal(landfallDef.fullySupported, true);
		const lTrig = landfallDef.faces[0].abilities.find((a) => a.kind === 'triggered');
		assert.ok(lTrig && lTrig.kind === 'triggered' && lTrig.modal);
		assert.deepEqual([lTrig.modal.min, lTrig.modal.max, lTrig.modal.upTo], [0, 2, true]);
	});

	it('compiles modal activated abilities (printed, loyalty, onceEachTurn, oncePerTurnUnique) and preserves rename invariance', () => {
		const actCardA = synthetic({
			name: 'Archivist Engine',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText:
				"{1}, {T}: Choose one that hasn't been chosen this turn —\n• Draw a card.\n• Add {C}{C}.\n• Gain 2 life."
		});
		const actCardB = synthetic({
			name: 'Chronicle Apparatus',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText:
				"{1}, {T}: Choose one that hasn't been chosen this turn —\n• Draw a card.\n• Add {C}{C}.\n• Gain 2 life."
		});
		const defA = compileFresh(actCardA);
		const defB = compileFresh(actCardB);
		assert.equal(defA.fullySupported, true);
		assert.deepEqual(defA.faces[0].abilities, defB.faces[0].abilities);

		const ab = defA.faces[0].abilities.find((a) => a.kind === 'activated');
		assert.ok(ab && ab.kind === 'activated' && ab.modal);
		assert.equal(ab.isMana, false);
		assert.equal(ab.modal.oncePerTurnUnique, true);
		assert.equal(ab.modal.modes.length, 3);

		const fetchedModal = getAbilityModal(actCardA, ab.id);
		assert.ok(fetchedModal);
		assert.equal(fetchedModal.oncePerTurnUnique, true);
		assert.equal(describeModalModes(actCardA, fetchedModal).length, 3);

		const expanded = expandModalEffects(fetchedModal, [0, 2]);
		assert.ok(expanded);
		assert.equal(expanded.steps.length, 2);
		assert.deepEqual(
			expanded.steps.map((s) => s.verb),
			['draw', 'gainLife']
		);

		const walker = synthetic({
			name: 'Nora, Modal Mind',
			manaCost: '{2}{U}{R}',
			cmc: 4,
			typeLine: 'Legendary Planeswalker — Nora',
			loyalty: '4',
			oracleText:
				'+1: Choose one —\n• Draw a card.\n• Nora, Modal Mind deals 1 damage to each opponent.\n−2: Draw two cards.'
		});
		const wDef = compileFresh(walker);
		assert.equal(wDef.fullySupported, true);
		const plus1 = wDef.faces[0].abilities[0];
		assert.ok(plus1 && plus1.kind === 'activated' && plus1.modal);
		assert.deepEqual(plus1.cost, [{ k: 'loyalty', delta: 1 }]);
		assert.equal(plus1.timing, 'sorcery');
		assert.equal(plus1.modal.modes.length, 2);
	});

	it('compiles multi-target modal spells as fullySupported and expands repeatable mode target indices properly', () => {
		const multiCard = synthetic({
			name: 'Twin Decrees',
			manaCost: '{2}{W}{B}',
			cmc: 4,
			typeLine: 'Instant',
			oracleText:
				'Choose three. You may choose the same mode more than once. —\n• Target creature gets +1/+1 until end of turn. Destroy target artifact.\n• Draw a card.'
		});
		const def = compileFresh(multiCard);
		assert.equal(def.fullySupported, true);
		const spell = def.faces[0].abilities.find((a) => a.kind === 'spell');
		assert.ok(spell && spell.kind === 'spell' && spell.modal);
		assert.equal(spell.modal.allowRepeat, true);
		assert.equal(spell.modal.modes[0].targets.length, 2);

		// Choosing mode 0 twice then mode 1 shifts targetIndex for the second mode 0 copy by 2
		const expanded = expandModalEffects(spell.modal, [0, 0, 1]);
		assert.ok(expanded);
		assert.equal(expanded.steps.length, 5);
		const firstDestroy = expanded.steps[1];
		const secondDestroy = expanded.steps[3];
		assert.equal(firstDestroy.verb, 'destroy');
		assert.equal(secondDestroy.verb, 'destroy');
		assert.equal((firstDestroy.subject as { k: 'target'; index: number }).index, 1);
		assert.equal((secondDestroy.subject as { k: 'target'; index: number }).index, 3);
	});

	it('compiles Crew N, "becomes crewed" triggers, and "can\'t crew Vehicles" restrictions', () => {
		const vehicle = synthetic({
			name: 'Sky Skiff Replica',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact — Vehicle',
			power: '4',
			toughness: '4',
			oracleText: 'Flying\nWhenever Sky Skiff Replica becomes crewed, draw a card.\nCrew 3'
		});
		const def = compileFresh(vehicle);
		assert.equal(def.fullySupported, true);
		const trig = def.faces[0].abilities.find((a) => a.kind === 'triggered');
		assert.ok(trig && trig.kind === 'triggered');
		assert.equal(trig.trigger.event, 'becomesCrewed');
		const crewKw = def.faces[0].abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'crew');
		assert.ok(crewKw && crewKw.kind === 'keyword');
		assert.equal(crewKw.keyword.n, 3);

		const ox = synthetic({
			name: 'Pacifist Ox',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Ox',
			power: '4',
			toughness: '4',
			oracleText: "Pacifist Ox can't crew Vehicles."
		});
		const oxDef = compileFresh(ox);
		assert.equal(oxDef.fullySupported, true);
		const rest = oxDef.faces[0].abilities.find((a) => a.kind === 'static');
		assert.ok(rest && rest.kind === 'static' && rest.static.k === 'restriction');
		assert.equal(rest.static.restriction, 'cantCrewVehicles');
	});
});

