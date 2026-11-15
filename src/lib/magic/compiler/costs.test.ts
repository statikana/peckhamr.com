import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAdditionalCostSentence, parseCost, parseObjectPhrase } from './costs.ts';

const ONE = { k: 'const', n: 1 } as const;
const n = (value: number) => ({ k: 'const', n: value }) as const;

describe('Cost grammar: activated ability costs', () => {
	const cases: Array<[string, unknown[]]> = [
		['{T}', [{ k: 'tapSelf' }]],
		['{2}{U}, {T}', [{ k: 'mana', cost: '{2}{U}' }, { k: 'tapSelf' }]],
		['{W/U}, {Q}', [{ k: 'mana', cost: '{W/U}' }, { k: 'untapSelf' }]],
		['{1}, {T}, Sacrifice ~', [{ k: 'mana', cost: '{1}' }, { k: 'tapSelf' }, { k: 'sacrifice', count: ONE, filter: 'self' }]],
		['Pay 2 life', [{ k: 'payLife', amount: n(2) }]],
		['Pay X life', [{ k: 'payLife', amount: { k: 'x' } }]],
		['Sacrifice a Food', [{ k: 'sacrifice', count: ONE, filter: { subtypes: ['Food'], controller: 'you' } }]],
		['Sacrifice three Treasures', [{ k: 'sacrifice', count: n(3), filter: { subtypes: ['Treasure'], controller: 'you' } }]],
		['Sacrifice another creature', [{ k: 'sacrifice', count: ONE, filter: { other: true, types: ['Creature'], controller: 'you' } }]],
		['Sacrifice a nonland permanent', [{ k: 'sacrifice', count: ONE, filter: { notTypes: ['Land'], controller: 'you' } }]],
		['Sacrifice an artifact or creature', [{ k: 'sacrifice', count: ONE, filter: { types: ['Artifact', 'Creature'], controller: 'you' } }]],
		[
			'Tap ten untapped Elves you control',
			[{ k: 'tapOthers', count: n(10), filter: { subtypes: ['Elf'], controller: 'you', tapped: false } }]
		],
		[
			'Tap an untapped Elf, Goblin, or Wizard you control',
			[{ k: 'tapOthers', count: ONE, filter: { subtypes: ['Elf', 'Goblin', 'Wizard'], controller: 'you', tapped: false } }]
		],
		['Discard ~', [{ k: 'discard', count: ONE, filter: 'self' }]],
		['Discard a card', [{ k: 'discard', count: ONE }]],
		['Discard two cards', [{ k: 'discard', count: n(2) }]],
		['Discard a card at random', [{ k: 'discard', count: ONE, random: true }]],
		['Discard a creature card', [{ k: 'discard', count: ONE, filter: { types: ['Creature'] } }]],
		['Exile ~', [{ k: 'exileFrom', zone: 'battlefield', count: ONE, filter: 'self' }]],
		['Exile ~ from your graveyard', [{ k: 'exileFrom', zone: 'graveyard', count: ONE, filter: 'self' }]],
		[
			'Exile two creature cards from your graveyard',
			[{ k: 'exileFrom', zone: 'graveyard', count: n(2), filter: { types: ['Creature'] } }]
		],
		[
			'Exile three other cards from your graveyard',
			[{ k: 'exileFrom', zone: 'graveyard', count: n(3), filter: { other: true } }]
		],
		[
			'Exile another creature card from your graveyard',
			[{ k: 'exileFrom', zone: 'graveyard', count: ONE, filter: { other: true, types: ['Creature'] } }]
		],
		['Remove a +1/+1 counter from ~', [{ k: 'removeCounters', counter: '+1/+1', count: ONE, from: 'self' }]],
		['Remove X charge counters from ~', [{ k: 'removeCounters', counter: 'charge', count: { k: 'x' }, from: 'self' }]],
		['Remove a counter from ~', [{ k: 'removeCounters', counter: 'any', count: ONE, from: 'self' }]],
		['Remove an oil counter from ~', [{ k: 'removeCounters', counter: 'oil', count: ONE, from: 'self' }]],
		["Return ~ to its owner's hand", [{ k: 'returnToHand', count: ONE, filter: 'self' }]],
		['Mill two cards', [{ k: 'mill', count: n(2) }]],
		['{S}, {T}', [{ k: 'mana', cost: '{S}' }, { k: 'tapSelf' }]],
		['Pay {E}{E}', [{ k: 'payEnergy', count: { k: 'const', n: 2 } }]],
		['Pay six {E}', [{ k: 'payEnergy', count: { k: 'const', n: 6 } }]],
		['Pay X {E}', [{ k: 'payEnergy', count: { k: 'x' } }]]
	];
	for (const [text, defs] of cases) {
		it(`parses "${text}"`, () => {
			const parsed = parseCost(text);
			assert.deepEqual(parsed.unparsed, []);
			assert.deepEqual(JSON.parse(JSON.stringify(parsed.defs)), defs);
		});
	}

	it('reports exactly the parts it does not understand, with spans', () => {
		const text = '{1}, Pay {TK}{TK}, Sacrifice ~';
		const parsed = parseCost(text, 100);
		assert.deepEqual(parsed.defs, [{ k: 'mana', cost: '{1}' }, { k: 'sacrifice', count: ONE, filter: 'self' }]);
		assert.deepEqual(
			parsed.unparsed.map((s) => text.slice(s.start - 100, s.end - 100)),
			['Pay {TK}{TK}']
		);
	});

	it('does not claim costs it cannot represent', () => {
		for (const text of [
			'Discard your hand',
			'Exile any number of other cards from your graveyard with four or more card types among them',
			'Sacrifice a creature that dealt damage this turn',
			'{E}{E}'
		]) {
			assert.equal(parseCost(text).unparsed.length, 1, text);
		}
	});
});

describe('Cost grammar: additional costs', () => {
	it('parses a single additional cost', () => {
		assert.deepEqual(parseAdditionalCostSentence('As an additional cost to cast ~, sacrifice a creature.'), {
			defs: [{ k: 'sacrifice', count: ONE, filter: { types: ['Creature'], controller: 'you' } }],
			unparsed: []
		});
	});

	it('parses costs joined by "and"', () => {
		const parsed = parseAdditionalCostSentence(
			'As an additional cost to cast ~, discard a card and sacrifice a creature.'
		);
		assert.deepEqual(parsed?.unparsed, []);
		assert.deepEqual(parsed?.defs.map((d) => d.k), ['discard', 'sacrifice']);
	});

	it('leaves a choice it cannot fully parse unparsed', () => {
		// "modified" isn't in the object-phrase grammar, so neither option may be claimed.
		const parsed = parseAdditionalCostSentence(
			'As an additional cost to cast ~, sacrifice a creature or sacrifice a modified creature.'
		);
		assert.ok(parsed);
		assert.equal(parsed.defs.length, 0);
		assert.equal(parsed.unparsed.length, 1);
	});

	it('ignores sentences that are not additional costs', () => {
		assert.equal(parseAdditionalCostSentence('Draw a card.'), null);
	});
});

describe('Cost grammar: object phrases', () => {
	it('compiles "artifact creature" via allTypes and keeps "Elf Warrior" (two subtypes) unparsed', () => {
		assert.deepEqual(parseObjectPhrase('artifact creature'), { allTypes: ['Artifact', 'Creature'] });
		assert.equal(parseObjectPhrase('Elf Warrior'), null);
	});

	it('combines a subtype and a card type', () => {
		assert.deepEqual(parseObjectPhrase('Goblin creature'), { subtypes: ['Goblin'], types: ['Creature'] });
		assert.deepEqual(parseObjectPhrase('basic land card'), { supertypes: ['Basic'], types: ['Land'] });
	});
});
