import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCondition, parseTriggerHeader } from './triggers.ts';

function head(text: string) {
	const parsed = parseTriggerHeader(text);
	assert.ok(parsed, text);
	assert.deepEqual(parsed.unparsed, [], text);
	return JSON.parse(JSON.stringify({ trigger: parsed.trigger, condition: parsed.condition }));
}

describe('Trigger grammar: trigger heads', () => {
	const cases: Array<[string, unknown]> = [
		['When ~ enters, draw a card.', { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } }],
		['When ~ enters the battlefield, draw a card.', { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } }],
		['When ~ dies, draw a card.', { event: 'zoneChange', filter: { object: 'self', from: 'battlefield', to: 'graveyard' } }],
		['When ~ leaves the battlefield, draw a card.', { event: 'zoneChange', filter: { object: 'self', from: 'battlefield' } }],
		['Whenever ~ attacks, draw a card.', { event: 'attacks', filter: { object: 'self' } }],
		[
			'Whenever a land you control enters, draw a card.',
			{ event: 'zoneChange', filter: { object: { types: ['Land'], controller: 'you' }, to: 'battlefield' } }
		],
		[
			'Whenever another nontoken Dragon you control enters, draw a card.',
			{ event: 'zoneChange', filter: { object: { other: true, token: false, subtypes: ['Dragon'], controller: 'you' }, to: 'battlefield' } }
		],
		[
			'Whenever ~ or another Elf you control enters, draw a card.',
			{ event: 'zoneChange', filter: { object: { other: true, subtypes: ['Elf'], controller: 'you' }, orSelf: true, to: 'battlefield' } }
		],
		[
			'Whenever a creature an opponent controls dies, draw a card.',
			{ event: 'zoneChange', filter: { object: { types: ['Creature'], controller: 'opponent' }, from: 'battlefield', to: 'graveyard' } }
		],
		[
			'Whenever one or more Dragons you control attack, draw a card.',
			{ event: 'attacks', filter: { object: { subtypes: ['Dragon'], controller: 'you' }, oneOrMore: true } }
		],
		[
			'Whenever ~ deals combat damage to a player or planeswalker, proliferate.',
			{ event: 'dealsDamage', filter: { object: 'self', combat: true, damageTo: 'playerOrPlaneswalker' } }
		],
		['Whenever equipped creature attacks, draw a card.', { event: 'attacks', filter: { object: 'attachedTo' } }],
		[
			'Whenever ~ enters or attacks, draw a card.',
			{ event: 'zoneChange', filter: { object: 'self', to: 'battlefield' }, or: [{ event: 'attacks', filter: { object: 'self' } }] }
		],
		[
			'Whenever you cast or copy an instant or sorcery spell, draw a card.',
			{ event: 'cast', filter: { object: { types: ['Instant', 'Sorcery'] }, player: { relation: 'you' }, orCopy: true } }
		],
		[
			'Whenever you cast a noncreature spell, proliferate.',
			{ event: 'cast', filter: { object: { notTypes: ['Creature'] }, player: { relation: 'you' } } }
		],
		['Whenever a player casts a spell, draw a card.', { event: 'cast', filter: { object: {}, player: { relation: 'any' } } }],
		['When you cast ~, draw a card.', { event: 'cast', filter: { object: 'self', player: { relation: 'you' } } }],
		['Whenever you gain life, draw a card.', { event: 'gainLife', filter: { player: { relation: 'you' } } }],
		['Whenever an opponent draws a card, draw a card.', { event: 'drawCard', filter: { player: { relation: 'opponent' } } }],
		[
			'Whenever you draw your second card each turn, draw a card.',
			{ event: 'drawCard', filter: { player: { relation: 'you' }, nthThisTurn: 2 } }
		],
		[
			'Whenever you cast your second spell each turn, draw a card.',
			{ event: 'cast', filter: { object: {}, player: { relation: 'you' }, nthThisTurn: 2 } }
		],
		[
			'Whenever one or more creatures you control deal combat damage to a player, draw a card.',
			{ event: 'combatDamageBatchPlayer', filter: { object: { types: ['Creature'], controller: 'you' }, oneOrMore: true, player: { relation: 'any' } } }
		],
		['Whenever you attack, draw a card.', { event: 'attacks', filter: { player: { relation: 'you' }, oneOrMore: true } }],
		['Whenever a +1/+1 counter is put on ~, draw a card.', { event: 'counterPlaced', filter: { object: 'self', counter: '+1/+1' } }],
		['At the beginning of your upkeep, draw a card.', { event: 'phaseBegin', filter: { phase: 'upkeep' }, scope: 'controller_turn' }],
		["At the beginning of each opponent's end step, draw a card.", { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'opponent_turn' }],
		['At the beginning of each end step, draw a card.', { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'each_turn' }],
		['At the beginning of combat on your turn, draw a card.', { event: 'phaseBegin', filter: { phase: 'begin_combat' }, scope: 'controller_turn' }],
		['Whenever ~ attacks while saddled, draw a card.', { event: 'attacks', filter: { object: 'self', saddled: true } }],
		["Whenever ~ attacks and isn't blocked, draw a card.", { event: 'attackedAndUnblocked', filter: { object: 'self' } }],
		['When ~ enters untapped, draw a card.', { event: 'zoneChange', filter: { object: 'self', to: 'battlefield', entersUntapped: true } }],
		['Whenever ~ deals combat damage to a player or battle, draw a card.', { event: 'dealsDamage', filter: { object: 'self', combat: true, damageTargetKind: 'playerOrBattle' } }],
		['When ~ enters, attacks, or dies, draw a card.', { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' }, or: [{ event: 'attacks', filter: { object: 'self' } }, { event: 'zoneChange', filter: { object: 'self', from: 'battlefield', to: 'graveyard' } }] }],
		['When ~ enters and at the beginning of your upkeep, draw a card.', { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' }, or: [{ event: 'phaseBegin', filter: { phase: 'upkeep' }, scope: 'controller_turn' }] }]
	];
	for (const [text, trigger] of cases) {
		it(text, () => assert.deepEqual(head(text).trigger, trigger));
	}

	it('says where the effect starts', () => {
		const text = 'When ~ enters, if you have 40 or more life, you win the game.';
		const parsed = parseTriggerHeader(text, 10)!;
		assert.equal(text.slice(parsed.effectStart - 10), 'you win the game.');
	});

	it('returns null for text that is not a triggered ability', () => {
		assert.equal(parseTriggerHeader('Flying'), null);
		assert.equal(parseTriggerHeader('{T}: Add {G}.'), null);
	});

	it('does not claim heads with qualifiers it cannot represent', () => {
		for (const text of [
			'Whenever ~ attacks while enchanted, draw a card.',
			'Whenever ~ attacks the player with the most life, draw a card.',
			'When ~ enters from the command zone, draw a card.',
			'Whenever ~ deals combat damage to a player with poison counters, draw a card.',
			'Whenever you draw two or more cards, draw a card.'
		]) {
			const parsed = parseTriggerHeader(text)!;
			assert.equal(parsed.trigger, undefined, text);
			assert.equal(parsed.unparsed.length, 1, text);
		}
	});
});

describe('Trigger grammar: intervening-if conditions', () => {
	it('parses the conditions the engine models today', () => {
		assert.deepEqual(head('At the beginning of your upkeep, if you have 40 or more life, you win the game.').condition, {
			k: 'compare',
			left: { k: 'life', of: { k: 'you' } },
			op: '>=',
			right: { k: 'const', n: 40 }
		});
		assert.deepEqual(parseCondition('if you control three or more artifacts'), {
			k: 'compare',
			left: { k: 'count', of: { types: ['Artifact'], controller: 'you' } },
			op: '>=',
			right: { k: 'const', n: 3 }
		});
		assert.deepEqual(parseCondition("if it's not your turn"), { k: 'not', of: { k: 'isTurnOf', player: { k: 'you' } } });
		assert.deepEqual(parseCondition('if at least four mana was spent to cast it'), {
			k: 'manaColorSpentToCast',
			minTotal: 4
		});
	});

	it('marks a graveyard condition on ~ as functioning from the graveyard', () => {
		const parsed = head(
			'At the beginning of your upkeep, if ~ is in your graveyard with three or more creature cards above it, you may put ~ onto the battlefield.'
		);
		assert.equal(parsed.trigger.fromZone, 'graveyard');
		assert.deepEqual(parsed.condition, { k: 'graveyardAbove', filter: { types: ['Creature'] }, count: 3 });
	});

	it('reports an unknown condition as unparsed but keeps the trigger', () => {
		const text = 'Whenever you cast a noncreature spell, if mana from a Treasure was spent to cast it, draw a card.';
		const parsed = parseTriggerHeader(text)!;
		assert.ok(parsed.trigger);
		assert.deepEqual(
			parsed.unparsed.map((s) => text.slice(s.start, s.end)),
			['if mana from a Treasure was spent to cast it']
		);
		assert.equal(text.slice(parsed.effectStart), 'draw a card.');
	});
});
