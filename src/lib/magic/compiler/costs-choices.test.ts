import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAdditionalCostSentence, parseCost, parseCostModifierSentence, parseObjectPhrase } from './costs.ts';

/**
 * Phase 4 cost grammar: choices between costs, optional costs, conditions in object phrases and
 * cost-modifying statics. These are the forms the legacy parser over-claimed (ENGINE_ARCHITECTURE_PLAN.md,
 * Phase 1 follow-up: cost grammar).
 */

const ONE = { k: 'const', n: 1 } as const;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const additional = (body: string) => {
	const parsed = parseAdditionalCostSentence(`As an additional cost to cast ~, ${body}`);
	assert.ok(parsed, body);
	assert.deepEqual(parsed.unparsed, [], body);
	return plain(parsed.defs);
};

describe('Cost grammar: choices between costs', () => {
	it('"discard a card or pay 3 life" is a choice, not both', () => {
		assert.deepEqual(additional('discard a card or pay 3 life.'), [
			{ k: 'choice', options: [[{ k: 'discard', count: ONE }], [{ k: 'payLife', amount: { k: 'const', n: 3 } }]] }
		]);
	});

	it('"sacrifice a creature or pay {3}{B}" offers a mana option', () => {
		assert.deepEqual(additional('sacrifice a creature or pay {3}{B}.'), [
			{
				k: 'choice',
				options: [
					[{ k: 'sacrifice', count: ONE, filter: { types: ['Creature'], controller: 'you' } }],
					[{ k: 'mana', cost: '{3}{B}' }]
				]
			}
		]);
	});

	it('keeps "or" inside an object phrase: "pay {4} or sacrifice an artifact or creature"', () => {
		assert.deepEqual(additional('pay {4} or sacrifice an artifact or creature.'), [
			{
				k: 'choice',
				options: [
					[{ k: 'mana', cost: '{4}' }],
					[{ k: 'sacrifice', count: ONE, filter: { types: ['Artifact', 'Creature'], controller: 'you' } }]
				]
			}
		]);
		assert.deepEqual(additional('sacrifice a creature or planeswalker or pay {3}.'), [
			{
				k: 'choice',
				options: [
					[{ k: 'sacrifice', count: ONE, filter: { types: ['Creature', 'Planeswalker'], controller: 'you' } }],
					[{ k: 'mana', cost: '{3}' }]
				]
			}
		]);
	});

	it('parses a choice inside an activated-ability cost', () => {
		const parsed = parseCost('{1}, Sacrifice a creature or discard a card');
		assert.deepEqual(parsed.unparsed, []);
		assert.deepEqual(plain(parsed.defs), [
			{ k: 'mana', cost: '{1}' },
			{
				k: 'choice',
				options: [
					[{ k: 'sacrifice', count: ONE, filter: { types: ['Creature'], controller: 'you' } }],
					[{ k: 'discard', count: ONE }]
				]
			}
		]);
	});
});

describe('Cost grammar: optional costs', () => {
	it('"you may sacrifice an artifact" is optional', () => {
		assert.deepEqual(additional('you may sacrifice an artifact.'), [
			{ k: 'optional', cost: [{ k: 'sacrifice', count: ONE, filter: { types: ['Artifact'], controller: 'you' } }] }
		]);
	});
});

describe('Cost grammar: conditions and disjunctions are kept', () => {
	it('"a creature with power 4 or greater" keeps the power condition', () => {
		assert.deepEqual(additional('sacrifice a creature with power 4 or greater.'), [
			{
				k: 'sacrifice',
				count: ONE,
				filter: { power: { op: '>=', value: { k: 'const', n: 4 } }, types: ['Creature'], controller: 'you' }
			}
		]);
	});

	it('"an artifact or creature with mana value X"', () => {
		assert.deepEqual(parseObjectPhrase('artifact or creature with mana value X'), {
			manaValue: { op: '=', value: { k: 'x' } },
			types: ['Artifact', 'Creature']
		});
	});

	it('"an artifact or creature" is either type', () => {
		assert.deepEqual(additional('sacrifice an artifact or creature.'), [
			{ k: 'sacrifice', count: ONE, filter: { types: ['Artifact', 'Creature'], controller: 'you' } }
		]);
	});

	it('"discard a card at random" keeps "at random"', () => {
		assert.deepEqual(additional('discard a card at random.'), [{ k: 'discard', count: ONE, random: true }]);
	});
});

describe('Cost grammar: cost modifiers', () => {
	it('accepts any type or subtype, not a fixed list', () => {
		for (const [text, filter] of [
			['Wizard spells you cast cost {1} less to cast.', { subtypes: ['Wizard'] }],
			['Instant and sorcery spells you cast cost {1} less to cast.', { types: ['Instant', 'Sorcery'] }],
			['Artifact spells you cast cost {2} less to cast.', { types: ['Artifact'] }],
			['Noncreature spells you cast cost {1} less to cast.', { notTypes: ['Creature'] }]
		] as const) {
			const def = parseCostModifierSentence(text);
			assert.ok(def, text);
			assert.deepEqual(plain(def), {
				k: 'costModifier',
				affects: { k: 'spell', filter },
				delta: { mode: 'reduce', generic: text.includes('{2}') ? 2 : 1 },
				who: { relation: 'you' }
			});
		}
	});

	it('Eminence works from the command zone and excludes the source', () => {
		const def = parseCostModifierSentence(
			'As long as ~ is in the command zone or on the battlefield, other Dragon spells you cast cost {1} less to cast.'
		);
		assert.deepEqual(plain(def), {
			k: 'costModifier',
			affects: { k: 'spell', filter: { subtypes: ['Dragon'], other: true } },
			delta: { mode: 'reduce', generic: 1 },
			who: { relation: 'you' },
			activeZones: ['battlefield', 'command']
		});
	});

	it('"This spell costs {1} less to cast for each creature on the battlefield."', () => {
		assert.deepEqual(plain(parseCostModifierSentence('This spell costs {1} less to cast for each creature on the battlefield.')), {
			k: 'costModifier',
			affects: { k: 'self' },
			delta: { mode: 'reduce', generic: 1, per: { k: 'count', of: { types: ['Creature'], zone: 'battlefield' } } },
			who: { relation: 'you' }
		});
	});

	it('rejects what it does not understand', () => {
		assert.equal(parseCostModifierSentence('Spells your opponents cast cost {1} more to cast.'), null);
		assert.equal(parseCostModifierSentence('Draw a card.'), null);
	});
});
