import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard, compiledTriggerEffect } from './index.ts';
import { parseEffects } from './effects.ts';
import { runtimeTriggers } from './triggers.ts';
import type { ScryfallCard } from '../types.ts';

/**
 * Step C grammar tests: the effect clause of a triggered ability (after the trigger head and any
 * intervening-if) compiled by the effect grammar, with event referents. Synthetic cards only.
 */

function card(name: string, oracleText: string, typeLine = 'Creature — Human'): ScryfallCard {
	return {
		id: `test_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name,
		manaCost: '{2}',
		cmc: 2,
		typeLine,
		oracleText,
		colors: [],
		colorIdentity: [],
		power: '2',
		toughness: '2',
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'span' ? undefined : x)));

/** The compiled effect of the card's only triggered ability. */
function effectOf(c: ScryfallCard) {
	const [t] = runtimeTriggers(compileCard(c));
	assert.ok(t, 'the runtime matches a triggered ability');
	const e = compiledTriggerEffect(c, t.abilityIndex);
	assert.ok(e, 'it has a compiled effect');
	assert.deepEqual(e.unparsed, [], 'the whole effect clause parsed');
	return strip(e);
}

describe('Step C: triggered-ability effect grammar', () => {
	it('compiles only the effect clause, after the trigger head and the intervening-if', () => {
		const e = effectOf(card('Ninefold Regent', 'At the beginning of your upkeep, if you have 40 or more life, you win the game.', 'Creature — Cat'));
		assert.deepEqual(e.steps, [{ verb: 'win', subject: { k: 'player', filter: { relation: 'you' } } }]);
		assert.deepEqual(e.targets, []);
	});

	it('"it" / "that creature" in a trigger is the event object', () => {
		const e = effectOf(card('Warhorn of Veld', 'Whenever a creature you control attacks, it gets +2/+0 until end of turn.', 'Enchantment'));
		assert.equal(e.steps[0].verb, 'pump');
		assert.deepEqual(e.steps[0].subject, { k: 'eventObject' });
		const t = effectOf(card('Gate Sentry', 'Whenever another creature you control enters, that creature gains haste until end of turn.'));
		assert.deepEqual(t.steps[0].subject, { k: 'eventObject' });
	});

	it('"that many" / "that much" is the event amount', () => {
		const tokens = effectOf(card('Thornwake Sovereign', 'Whenever this creature deals combat damage to a player, create that many 1/1 green Elf Warrior creature tokens.'));
		assert.deepEqual(tokens.steps[0].amount, { k: 'eventAmount' });
		const life = effectOf(card('Sunlit Chaplain', 'Whenever this creature deals combat damage to a player, you gain that much life.'));
		assert.deepEqual(life.steps[0], { verb: 'gainLife', subject: { k: 'player', filter: { relation: 'you' } }, amount: { k: 'eventAmount' } });
		const draw = effectOf(card('Inkwell Seer', 'Whenever this creature deals combat damage to a player, draw that many cards.'));
		assert.deepEqual(draw.steps[0].amount, { k: 'eventAmount' });
	});

	it('"the entering creature\'s power" and "its power" read the event object (LKI for "its")', () => {
		const e = effectOf(card('Brindle Augur', "Whenever another creature you control enters, you gain life equal to the entering creature's power."));
		assert.deepEqual(e.steps[0].amount, { k: 'stat', of: { k: 'eventObject' }, stat: 'power' });
		const d = effectOf(card('Emberhusk Brute', 'When this creature dies, each opponent loses life equal to its power.'));
		assert.deepEqual(d.steps[0].amount, { k: 'stat', of: { k: 'eventObject' }, stat: 'power', lki: true });
	});

	it('"that player" is the event player, unless an earlier clause chose a target player', () => {
		const e = effectOf(card('Gloamstep Rogue', 'Whenever this creature deals combat damage to a player, that player loses 2 life.'));
		assert.deepEqual(e.steps[0].subject, { k: 'playerRef', ref: { k: 'eventPlayer' } });
		const cast = effectOf(card('Hushwing Scold', 'Whenever an opponent casts a spell, that player loses 1 life.'));
		assert.deepEqual(cast.steps[0].subject, { k: 'playerRef', ref: { k: 'eventPlayer' } });
		const tgt = parseEffects('target player draws a card. That player loses 1 life.', 0, 'triggered');
		assert.deepEqual(strip(tgt.steps[1].subject), { k: 'playerRef', ref: { k: 'target', index: 0 } });
	});

	it('records target specs for targeted triggers', () => {
		const e = effectOf(card('Rustbiter Drake', 'When this creature enters, destroy target artifact an opponent controls.', 'Creature — Drake'));
		assert.equal(e.steps[0].verb, 'destroy');
		assert.deepEqual(e.steps[0].subject, { k: 'target', index: 0 });
		assert.equal(e.targets.length, 1);
		assert.equal(e.targets[0].kind, 'object');
		assert.deepEqual(e.targets[0].filter.types, ['Artifact']);
		assert.equal(e.targets[0].filter.controller, 'opponent');
	});

	it('"you may" marks the steps optional with the controller as chooser', () => {
		const e = effectOf(card('Tidecall Scribe', 'Whenever another creature you control enters, you may draw a card.'));
		assert.deepEqual(e.steps[0].optional, { chooser: { k: 'you' } });
	});

	it('is rename-invariant (the same IR for a renamed card)', () => {
		const a = effectOf(card('Emberhusk Brute', 'When Emberhusk Brute dies, each opponent loses life equal to its power.'));
		const b = effectOf(card('Ashveil Ogre', 'When Ashveil Ogre dies, each opponent loses life equal to its power.'));
		assert.deepEqual(a, b);
	});

	it('triggers the grammar understands but the legacy parser never claimed are matched by the runtime', () => {
		const c = card('Inkwell Seer', 'Whenever this creature deals combat damage to a player, draw that many cards.');
		const [t] = runtimeTriggers(compileCard(c));
		assert.ok(t);
		assert.ok(t.effect && t.effect.unparsed.length === 0);
	});
});
