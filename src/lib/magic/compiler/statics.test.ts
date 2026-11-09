import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseKeywordList, parseStaticAbility } from './statics.ts';

const n = (value: number) => ({ k: 'const', n: value });

/** Parses a fully understood static line and returns its StaticDefs / ReplacementDefs. */
function defs(text: string): unknown[] {
	const parsed = parseStaticAbility(text);
	assert.deepEqual(parsed.unparsed, [], `unparsed: ${text}`);
	return JSON.parse(JSON.stringify(parsed.items.map((i) => (i.kind === 'static' ? i.static : { replacement: i.replacement }))));
}

function unparsed(text: string): void {
	const parsed = parseStaticAbility(text);
	assert.equal(parsed.items.length, 0, text);
	assert.equal(parsed.unparsed.length, 1, text);
}

describe('Static grammar: continuous effects', () => {
	it('anthems and lords, with subtypes and "other"', () => {
		assert.deepEqual(defs('Other Elf creatures you control get +1/+1.'), [
			{ k: 'continuous', layer: '7c', affected: { other: true, subtypes: ['Elf'], types: ['Creature'], controller: 'you' }, mod: { k: 'pt', power: n(1), toughness: n(1) } }
		]);
		assert.deepEqual(defs('Creatures your opponents control get -1/-1.'), [
			{ k: 'continuous', layer: '7c', affected: { types: ['Creature'], controller: 'opponent' }, mod: { k: 'pt', power: n(-1), toughness: n(-1) } }
		]);
		assert.deepEqual(defs('Goblin creatures you control get +1/+1 and have haste.'), [
			{ k: 'continuous', layer: '7c', affected: { subtypes: ['Goblin'], types: ['Creature'], controller: 'you' }, mod: { k: 'pt', power: n(1), toughness: n(1) } },
			{ k: 'continuous', layer: '6', affected: { subtypes: ['Goblin'], types: ['Creature'], controller: 'you' }, mod: { k: 'addKeywords', keywords: ['haste'] } }
		]);
	});

	it('keyword lists with protection', () => {
		assert.deepEqual(parseKeywordList('flying, first strike, vigilance, trample, haste, and protection from black and from red'), [
			'flying',
			'first strike',
			'vigilance',
			'trample',
			'haste',
			'protection from black and from red'
		]);
		assert.equal(parseKeywordList('flying and "{T}: Draw a card."'), null);
	});

	it('Equipment and Aura grants', () => {
		assert.deepEqual(defs('Equipped creature gets +1/+1 and has trample and lifelink.'), [
			{ k: 'continuous', layer: '7c', affected: 'attachedTo', mod: { k: 'pt', power: n(1), toughness: n(1) } },
			{ k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'addKeywords', keywords: ['trample', 'lifelink'] } }
		]);
	});

	it('"for each" P/T, only in steps of one', () => {
		assert.deepEqual(defs('~ gets +1/+0 for each artifact you control.'), [
			{ k: 'continuous', layer: '7c', affected: 'self', mod: { k: 'pt', power: { k: 'count', of: { types: ['Artifact'], controller: 'you', zone: 'battlefield' } }, toughness: n(0) } }
		]);
		unparsed('Enchanted creature gets +2/+2 for each Aura attached to it.');
	});

	it('attached type changers, layer by layer', () => {
		assert.deepEqual(
			defs('Enchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types.'),
			[
				{ k: 'continuous', layer: '4', affected: 'attachedTo', mod: { k: 'setTypes', types: ['Artifact', 'Creature'], subtypes: ['Insect'] } },
				{ k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'removeAllAbilities' } },
				{ k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'addKeywords', keywords: ['indestructible'] } },
				{ k: 'continuous', layer: '7b', affected: 'attachedTo', mod: { k: 'setBasePT', power: n(0), toughness: n(1) } }
			]
		);
		assert.deepEqual(defs('Enchanted creature loses all abilities and is a green Elk creature with base power and toughness 3/3.'), [
			{ k: 'continuous', layer: '4', affected: 'attachedTo', mod: { k: 'setTypes', types: ['Creature'], subtypes: ['Elk'] } },
			{ k: 'continuous', layer: '5', affected: 'attachedTo', mod: { k: 'setColors', colors: ['G'] } },
			{ k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'removeAllAbilities' } },
			{ k: 'continuous', layer: '7b', affected: 'attachedTo', mod: { k: 'setBasePT', power: n(3), toughness: n(3) } }
		]);
		// CR 305.7's ability loss is a rules consequence of setting a basic land type; the IR only
		// records the type and colour change (the layer engine applies 305.7).
		assert.deepEqual(defs('Enchanted permanent is a colorless Forest land.'), [
			{ k: 'continuous', layer: '4', affected: 'attachedTo', mod: { k: 'setTypes', types: ['Land'], subtypes: ['Forest'] } },
			{ k: 'continuous', layer: '5', affected: 'attachedTo', mod: { k: 'setColors', colors: [] } }
		]);
		const moon = defs('Enchanted permanent is a colorless land with "{T}: Add {C}" and loses all other card types and abilities.') as Array<{ mod: { k: string } }>;
		assert.deepEqual(moon.map((d) => d.mod.k), ['setTypes', 'setColors', 'removeAllAbilities', 'grantAbility']);
	});

	it('refuses "[subtype] artifact creature" without the text that removes prior types (CR 205.1b)', () => {
		unparsed('Enchanted creature is an Insect artifact creature with base power and toughness 0/1.');
	});

	it('global changes: Humility, Blood Moon, Urborg, Opalescence, Mycosynth, Maskwood', () => {
		assert.deepEqual(defs('All creatures lose all abilities and have base power and toughness 1/1.'), [
			{ k: 'continuous', layer: '6', affected: { types: ['Creature'] }, mod: { k: 'removeAllAbilities' } },
			{ k: 'continuous', layer: '7b', affected: { types: ['Creature'] }, mod: { k: 'setBasePT', power: n(1), toughness: n(1) } }
		]);
		assert.deepEqual(defs('Nonbasic lands are Mountains.'), [
			{ k: 'continuous', layer: '4', affected: { types: ['Land'], notSupertypes: ['Basic'] }, mod: { k: 'setSubtypes', subtypes: ['Mountain'] } }
		]);
		assert.deepEqual(defs('Each land is a Swamp in addition to its other land types.'), [
			{ k: 'continuous', layer: '4', affected: { types: ['Land'] }, mod: { k: 'addTypes', types: [], subtypes: ['Swamp'] } }
		]);
		const mv = { k: 'stat', of: { k: 'affected' }, stat: 'manaValue' };
		const enchantments = { other: true, notSubtypes: ['Aura'], types: ['Enchantment'] };
		assert.deepEqual(defs('Each other non-Aura enchantment is a creature in addition to its other types and has base power and base toughness each equal to its mana value.'), [
			{ k: 'continuous', layer: '4', affected: enchantments, mod: { k: 'addTypes', types: ['Creature'] } },
			{ k: 'continuous', layer: '7b', affected: enchantments, mod: { k: 'setBasePT', power: mv, toughness: mv } }
		]);
		assert.deepEqual(defs('All permanents are artifacts in addition to their other types.'), [
			{ k: 'continuous', layer: '4', affected: {}, mod: { k: 'addTypes', types: ['Artifact'] } }
		]);
		assert.deepEqual(defs('Creatures you control are every creature type.'), [
			{ k: 'continuous', layer: '4', affected: { types: ['Creature'], controller: 'you' }, mod: { k: 'allCreatureTypes' } }
		]);
	});

	it('keyword removal', () => {
		assert.deepEqual(defs("Creatures your opponents control lose flying and can't have or gain flying."), [
			{ k: 'continuous', layer: '6', affected: { types: ['Creature'], controller: 'opponent' }, mod: { k: 'removeKeywords', keywords: ['flying'], cantHaveOrGain: true } }
		]);
		unparsed('Enchanted creature has defender and loses flying.');
	});

	it('characteristic-defining abilities (layer 7a)', () => {
		const count = { k: 'count', of: { types: ['Creature'], controller: 'you', zone: 'battlefield' } };
		assert.deepEqual(defs("~'s power and toughness are each equal to the number of creatures you control."), [
			{ k: 'continuous', layer: '7a', affected: 'self', mod: { k: 'setBasePT', power: count, toughness: count } }
		]);
	});

	it('quoted mana abilities granted to lands', () => {
		const [def] = defs('Lands you control have "{T}: Add one mana of any color."') as Array<{ mod: { ability: { effect: Array<{ params: unknown }> } } }>;
		assert.deepEqual(def.mod.ability.effect[0].params, { manaChoice: 'any' });
	});

	it('conditions: "as long as" prefixes and suffixes', () => {
		assert.deepEqual(defs('Other creatures you control get +1/+1 as long as you control three or more artifacts.'), [
			{
				k: 'continuous',
				layer: '7c',
				affected: { other: true, types: ['Creature'], controller: 'you' },
				mod: { k: 'pt', power: n(1), toughness: n(1) },
				condition: { k: 'compare', left: { k: 'count', of: { types: ['Artifact'], controller: 'you' } }, op: '>=', right: n(3) }
			}
		]);
		unparsed("Other creatures you control get +1/+1 as long as you've completed a dungeon.");
	});
});

describe('Static grammar: cost modifiers', () => {
	it('spells by type or subtype, for you or your opponents', () => {
		assert.deepEqual(defs('Instant and sorcery spells you cast cost {1} less to cast.'), [
			{ k: 'costModifier', affects: { k: 'spell', filter: { types: ['Instant', 'Sorcery'] } }, delta: { mode: 'reduce', generic: 1 }, who: { relation: 'you' } }
		]);
		assert.deepEqual(defs('Spells your opponents cast cost {1} more to cast.'), [
			{ k: 'costModifier', affects: { k: 'spell', filter: {} }, delta: { mode: 'increase', generic: 1 }, who: { relation: 'each_opponent' } }
		]);
	});

	it('eminence works from the command zone too', () => {
		assert.deepEqual(defs('As long as ~ is in the command zone or on the battlefield, other Dragon spells you cast cost {1} less to cast.'), [
			{
				k: 'costModifier',
				affects: { k: 'spell', filter: { other: true, subtypes: ['Dragon'] } },
				delta: { mode: 'reduce', generic: 1 },
				who: { relation: 'you' },
				activeZones: ['battlefield', 'command']
			}
		]);
	});

	it('"for each" self reductions', () => {
		assert.deepEqual(defs('~ costs {1} less to cast for each creature on the battlefield.'), [
			{
				k: 'costModifier',
				affects: { k: 'self' },
				delta: { mode: 'reduce', generic: 1, times: { k: 'count', of: { types: ['Creature'], zone: 'battlefield' } } },
				who: { relation: 'you' }
			}
		]);
		unparsed('Creature spells you cast cost {1} less to cast for each +1/+1 counter on ~.');
	});
});

describe('Static grammar: rule modifiers', () => {
	const rule = (text: string) => (defs(text) as Array<{ rule: string; who: { relation: string }; params?: unknown }>).map((d) => [d.rule, d.who.relation, d.params]);
	it('player rules', () => {
		assert.deepEqual(rule('You have no maximum hand size.'), [['noMaxHandSize', 'you', undefined]]);
		assert.deepEqual(rule("You can't lose the game and your opponents can't win the game."), [
			['cantLose', 'you', undefined],
			['opponentsCantWin', 'each_opponent', undefined]
		]);
		assert.deepEqual(rule('You have hexproof.'), [['playerHexproof', 'you', undefined]]);
		assert.deepEqual(rule("Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you."), [
			['attackTax', 'you', { cost: '{2}' }]
		]);
		assert.deepEqual(rule("Creatures can't attack you unless their controller pays {1} for each creature they control that's attacking you."), [
			['attackTax', 'you', { cost: '{1}' }]
		]);
	});

	it('casting rules', () => {
		assert.deepEqual(rule('You may cast spells as though they had flash.'), [['castAsThoughFlash', 'you', undefined]]);
		assert.deepEqual(rule("Each player can't cast more than one spell each turn."), [['oneSpellPerTurn', 'each_player', undefined]]);
		assert.deepEqual(rule("Your opponents can't cast spells from anywhere other than their hands."), [['castOnlyFromHand', 'each_opponent', undefined]]);
		assert.deepEqual(rule('Each opponent can cast spells only any time they could cast a sorcery.'), [['castOnlySorcerySpeed', 'each_opponent', undefined]]);
		assert.deepEqual(rule("You control your opponents while they're searching their libraries."), [['searchControl', 'each_opponent', undefined]]);
	});

	it('Shalai: player hexproof plus keyword grants', () => {
		const out = defs('You, planeswalkers you control, and other creatures you control have hexproof.') as Array<{ k: string }>;
		assert.deepEqual(out.map((d) => d.k), ['ruleModifier', 'continuous', 'continuous']);
	});

	it('conditions on rule modifiers', () => {
		const [def] = defs("As long as you control three or more artifacts, you can't lose the game.") as Array<{ condition: unknown }>;
		assert.ok(def.condition);
	});
});

describe('Static grammar: restrictions', () => {
	it('combat and untap restrictions', () => {
		assert.deepEqual(defs("~ can't block."), [{ k: 'restriction', affected: 'self', restriction: 'cantBlock' }]);
		assert.deepEqual(defs("Enchanted creature can't attack or block."), [{ k: 'restriction', affected: 'attachedTo', restriction: 'cantAttackOrBlock' }]);
		assert.deepEqual(defs("Enchanted creature doesn't untap during its controller's untap step."), [
			{ k: 'restriction', affected: 'attachedTo', restriction: 'doesntUntap' }
		]);
		unparsed("~ can't be blocked by creatures with power 2 or less.");
	});
});

describe('Static grammar: replacements', () => {
	it('graveyard to exile, Laboratory Maniac, enters tapped, enters with counters', () => {
		assert.deepEqual(defs('If a card or token would be put into a graveyard from anywhere, exile it instead.'), [
			{ replacement: { replaces: { event: 'zoneChange', filter: { to: 'graveyard' } }, with: { k: 'modify', to: 'exile' } } }
		]);
		const [lab] = defs('If you would draw a card while your library has no cards in it, you win the game instead.') as Array<{ replacement: { condition: unknown; with: Array<{ verb: string }> } }>;
		assert.ok(lab.replacement.condition);
		assert.equal(lab.replacement.with[0].verb, 'win');
		assert.deepEqual(defs('~ enters tapped.'), [
			{ replacement: { replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } }, with: { k: 'modify', tapped: true } } }
		]);
		assert.deepEqual(defs('~ enters with four +1/+1 counters on it.'), [
			{
				replacement: {
					replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
					with: { k: 'modify', counters: { counter: '+1/+1', amount: n(4) } }
				}
			}
		]);
	});

	it('leaves conditional "enters tapped unless" unparsed', () => {
		unparsed('~ enters tapped unless you control a Plains or an Island.');
	});
});

describe('Static grammar: multipliers', () => {
	it('counter, token and trigger doublers keep their scope', () => {
		assert.deepEqual(defs('If one or more +1/+1 counters would be put on a creature you control, twice that many +1/+1 counters are put on it instead.'), [
			{ k: 'multiplier', what: 'counters', factor: 2, filter: { types: ['Creature'], controller: 'you' }, counter: '+1/+1' }
		]);
		assert.deepEqual(defs('If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.'), [
			{ k: 'multiplier', what: 'tokens', factor: 2, filter: { controller: 'you' } }
		]);
		assert.deepEqual(defs('If an artifact or creature entering the battlefield causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'), [
			{
				k: 'multiplier',
				what: 'triggers',
				factor: 2,
				filter: { controller: 'you' },
				cause: { event: 'zoneChange', filter: { object: { types: ['Artifact', 'Creature'] }, to: 'battlefield' } }
			}
		]);
		assert.deepEqual(defs('If a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'), [
			{
				k: 'multiplier',
				what: 'triggers',
				factor: 2,
				filter: { controller: 'you' },
				cause: { event: 'zoneChange', filter: { object: { types: ['Creature'] }, from: 'battlefield', to: 'graveyard' } }
			}
		]);
		// Abilities of particular permanents ("of an Ally you control") are a different filter, not a cause.
		unparsed('If a triggered ability of an Ally you control triggers, that ability triggers an additional time.');
	});
});
