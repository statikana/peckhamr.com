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

	it('"for each" P/T with arbitrary steps and attachments', () => {
		assert.deepEqual(defs('~ gets +1/+0 for each artifact you control.'), [
			{ k: 'continuous', layer: '7c', affected: 'self', mod: { k: 'pt', power: { k: 'count', of: { types: ['Artifact'], controller: 'you', zone: 'battlefield' } }, toughness: n(0) } }
		]);
		assert.deepEqual(defs('Enchanted creature gets +2/+2 for each Aura attached to it.'), [
			{
				k: 'continuous',
				layer: '7c',
				affected: 'attachedTo',
				mod: {
					k: 'pt',
					power: { k: 'mul', factor: 2, of: { k: 'attachmentsOn', target: 'attachedTo', filter: { subtypes: ['Aura'] } } },
					toughness: { k: 'mul', factor: 2, of: { k: 'attachmentsOn', target: 'attachedTo', filter: { subtypes: ['Aura'] } } }
				}
			}
		]);
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
		assert.deepEqual(defs('Enchanted creature has defender and loses flying.'), [
			{ k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'addKeywords', keywords: ['defender'] } },
			{ k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'removeKeywords', keywords: ['flying'] } }
		]);
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

	it('quoted general activated abilities (Goldspan-style mana and non-mana)', () => {
		const [goldspan] = defs('Treasures you control have "{T}, Sacrifice ~: Add two mana of any one color."') as Array<{
			affected: unknown;
			mod: { k: string; ability: { kind: string; isMana: boolean; timing: string; cost: unknown[]; effect: Array<{ verb: string; amount: unknown; params: unknown }> } };
		}>;
		assert.deepEqual(goldspan.affected, { subtypes: ['Treasure'], controller: 'you' });
		assert.equal(goldspan.mod.k, 'grantAbility');
		assert.equal(goldspan.mod.ability.kind, 'activated');
		assert.equal(goldspan.mod.ability.isMana, true);
		assert.equal(goldspan.mod.ability.timing, 'mana');
		assert.deepEqual(goldspan.mod.ability.cost, [
			{ k: 'tapSelf' },
			{ k: 'sacrifice', count: n(1), filter: 'self' }
		]);
		assert.equal(goldspan.mod.ability.effect[0].verb, 'addMana');
		assert.deepEqual(goldspan.mod.ability.effect[0].amount, n(2));
		assert.deepEqual(goldspan.mod.ability.effect[0].params, { manaChoice: 'any' });

		const [drawSingleQuoted] = defs("Creatures you control have '{1}, {T}: Draw a card.'") as Array<{
			mod: { k: string; ability: { kind: string; isMana: boolean; timing: string; cost: unknown[]; effect: Array<{ verb: string }> } };
		}>;
		assert.equal(drawSingleQuoted.mod.k, 'grantAbility');
		assert.equal(drawSingleQuoted.mod.ability.isMana, false);
		assert.equal(drawSingleQuoted.mod.ability.timing, 'instant');
		assert.deepEqual(drawSingleQuoted.mod.ability.cost, [{ k: 'mana', cost: '{1}' }, { k: 'tapSelf' }]);
		assert.equal(drawSingleQuoted.mod.ability.effect[0].verb, 'draw');

		const [sorceryGrant] = defs('Equipped creature has "{2}, {T}: Draw a card. Activate only as a sorcery."') as Array<{
			affected: unknown;
			mod: { ability: { timing: string } };
		}>;
		assert.equal(sorceryGrant.affected, 'attachedTo');
		assert.equal(sorceryGrant.mod.ability.timing, 'sorcery');

		// Uninterpretable quoted text stays honestly unparsed rather than half-compiling.
		unparsed('Creatures you control have "{T}: Flip a coin and do a dance."');
		const [trigGrant] = defs('Creatures you control have "Whenever ~ attacks, draw a card."') as Array<{
			affected: unknown;
			mod: { k: string; ability: { kind: string; effect: Array<{ verb: string }> } };
		}>;
		assert.deepEqual(trigGrant.affected, { types: ['Creature'], controller: 'you' });
		assert.equal(trigGrant.mod.k, 'grantAbility');
		assert.equal(trigGrant.mod.ability.kind, 'triggered');
		assert.equal(trigGrant.mod.ability.effect[0].verb, 'draw');
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
		assert.deepEqual(
			defs("Other creatures you control get +1/+1 as long as you've completed a dungeon."),
			[
				{
					k: 'continuous',
					layer: '7c',
					affected: { other: true, types: ['Creature'], controller: 'you' },
					mod: { k: 'pt', power: n(1), toughness: n(1) },
					condition: { k: 'hasCompletedDungeon' }
				}
			]
		);
		unparsed(
			'Other creatures you control get +1/+1 as long as your starting life total was at least 30.'
		);
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

	it('"for each" self and spell reductions', () => {
		assert.deepEqual(defs('~ costs {1} less to cast for each creature on the battlefield.'), [
			{
				k: 'costModifier',
				affects: { k: 'self' },
				delta: { mode: 'reduce', generic: 1, times: { k: 'count', of: { types: ['Creature'], zone: 'battlefield' } } },
				who: { relation: 'you' }
			}
		]);
		assert.deepEqual(defs('Creature spells you cast cost {1} less to cast for each +1/+1 counter on ~.'), [
			{
				k: 'costModifier',
				affects: { k: 'spell', filter: { types: ['Creature'] } },
				delta: {
					mode: 'reduce',
					generic: 1,
					per: { k: 'countersOn', counter: '+1/+1', of: { k: 'self' } }
				},
				who: { relation: 'you' }
			}
		]);
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
		assert.deepEqual(
			rule(
				'While an opponent is searching their library, they exile each card they find. You may play those cards for as long as they remain exiled, and you may spend mana as though it were mana of any color to cast them.'
			),
			[
				['searchControl', 'each_opponent', { exilesFoundCards: true }],
				['searchControl', 'each_opponent', { grantPlayFromExile: true, spendManaAsAnyColor: true }]
			]
		);
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
		assert.deepEqual(defs("~ can't be countered."), [{ k: 'restriction', affected: 'self', restriction: 'cantBeCountered' }]);
		assert.deepEqual(defs("Creature spells you control can't be countered."), [
			{ k: 'restriction', affected: { types: ['Creature'], controller: 'you' }, restriction: 'cantBeCountered' }
		]);
		assert.deepEqual(defs("~ can't be blocked by creatures with power 2 or less."), [
			{
				k: 'combatRule',
				affected: 'self',
				rule: {
					kind: 'cantBeBlockedBy',
					filter: { types: ['Creature'], power: { op: '<=', value: n(2) } }
				}
			}
		]);
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

	it('compiles conditional "enters tapped unless" checklands', () => {
		assert.deepEqual(defs('~ enters tapped unless you control a Plains or an Island.'), [
			{
				replacement: {
					replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
					with: { k: 'modify', tapped: true },
					selfReplacement: true,
					condition: {
						k: 'not',
						of: {
							k: 'compare',
							left: { k: 'count', of: { subtypes: ['Plains', 'Island'], controller: 'you' } },
							op: '>=',
							right: n(1)
						}
					}
				}
			}
		]);
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
		assert.deepEqual(
			defs(
				'If a triggered ability of an Ally you control triggers, that ability triggers an additional time.'
			),
			[
				{
					k: 'multiplier',
					what: 'triggers',
					factor: 2,
					filter: { subtypes: ['Ally'], controller: 'you' }
				}
			]
		);
		unparsed(
			'If a triggered ability of a colorless spell you control triggers, that ability triggers an additional time.'
		);
	});
});

describe('Static grammar: Layer 2 control changes (CR 613.1b)', () => {
	it('compiles Aura and Equipment control-changing static abilities', () => {
		assert.deepEqual(defs('You control enchanted creature.'), [
			{ k: 'continuous', layer: '2', affected: 'attachedTo', mod: { k: 'setController', controller: { k: 'you' } } }
		]);
		assert.deepEqual(defs('You control enchanted permanent.'), [
			{ k: 'continuous', layer: '2', affected: 'attachedTo', mod: { k: 'setController', controller: { k: 'you' } } }
		]);
		assert.deepEqual(defs('You control equipped creature.'), [
			{ k: 'continuous', layer: '2', affected: 'attachedTo', mod: { k: 'setController', controller: { k: 'you' } } }
		]);
	});
});

describe('Static grammar: Track P11 dynamic P/T, quoted grants, cost modifiers, and replacements', () => {
	it('compiles dynamic +X/+X and base X/X continuous effects', () => {
		assert.deepEqual(defs('Enchanted creature gets +X/+X, where X is the number of artifacts you control.'), [
			{
				k: 'continuous',
				layer: '7c',
				affected: 'attachedTo',
				mod: {
					k: 'pt',
					power: { k: 'count', of: { zone: 'battlefield', types: ['Artifact'], controller: 'you' } },
					toughness: { k: 'count', of: { zone: 'battlefield', types: ['Artifact'], controller: 'you' } }
				}
			}
		]);
		assert.deepEqual(defs('Enchanted creature has base power and toughness X/X, where X is the number of lands you control.'), [
			{
				k: 'continuous',
				layer: '7b',
				affected: 'attachedTo',
				mod: {
					k: 'setBasePT',
					power: { k: 'count', of: { zone: 'battlefield', types: ['Land'], controller: 'you' } },
					toughness: { k: 'count', of: { zone: 'battlefield', types: ['Land'], controller: 'you' } }
				}
			}
		]);
	});

	it('compiles colored/hybrid cost modifiers, two-sentence floors, and activated ability cost reductions', () => {
		assert.deepEqual(
			defs('Dragon spells you cast cost {R} less to cast. This effect reduces only the amount of colored mana you pay.'),
			[
				{
					k: 'costModifier',
					affects: { k: 'spell', filter: { subtypes: ['Dragon'] } },
					delta: { mode: 'reduce', generic: 0, colored: { R: 1 }, coloredOnly: true },
					who: { relation: 'you' }
				}
			]
		);
		assert.deepEqual(
			defs(
				"Activated abilities of creatures you control cost {2} less to activate. This effect can't reduce the mana in that cost to less than one mana."
			),
			[
				{
					k: 'costModifier',
					affects: { k: 'ability', filter: { types: ['Creature'], controller: 'you' } },
					delta: { mode: 'reduce', generic: 2, minTotalMana: 1 },
					who: { relation: 'you' }
				}
			]
		);
	});

	it('compiles chosen-name ETB & bans, counter choice ETB, damage/lifegain replacements, and alt-cast permissions', () => {
		assert.deepEqual(defs('As ~ enters, choose a nonland card name.'), [
			{
				replacement: {
					replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
					with: { k: 'modify', chooseCardName: { nonlandOnly: true } },
					selfReplacement: true
				}
			}
		]);
		assert.deepEqual(defs("Spells with the chosen name can't be cast."), [
			{ k: 'ruleModifier', rule: 'cantCastChosenName', who: { relation: 'each_player' } }
		]);
		assert.deepEqual(defs("Activated abilities of sources with the chosen name can't be activated unless they're mana abilities."), [
			{ k: 'cantActivateAbilities', affected: { ofChosenName: true }, allowManaAbilities: true }
		]);
		assert.deepEqual(defs('~ enters with your choice of a flying counter or a reach counter on it.'), [
			{
				replacement: {
					replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
					with: { k: 'modify', chooseCounter: ['flying', 'reach'] },
					selfReplacement: true
				}
			}
		]);
		assert.deepEqual(defs('If a red source you control would deal damage to an opponent or a permanent an opponent controls, it deals that much damage plus 2 instead.'), [
			{
				replacement: {
					replaces: { event: 'damage', filter: {} },
					with: {
						k: 'modify',
						damageMod: {
							mode: 'add',
							add: n(2),
							sourceFilter: { colors: ['R'], controller: 'you' },
							targetFilter: 'opponentOrOpponentPerm'
						}
					}
				}
			}
		]);
		assert.deepEqual(defs('If you would gain life, you gain twice that much life instead.'), [
			{
				replacement: {
					replaces: { event: 'lifeGain', filter: { player: { relation: 'you' } } },
					with: { k: 'modify', lifeGainMod: { mode: 'double' } }
				}
			}
		]);
		assert.deepEqual(defs('You may pay {W}{U}{B}{R}{G} rather than pay the mana cost for spells you cast.'), [
			{
				k: 'altCastPermission',
				affects: { k: 'spell', filter: {} },
				manaCost: '{W}{U}{B}{R}{G}'
			}
		]);
		assert.deepEqual(defs('Each creature you control assigns combat damage equal to its toughness rather than its power.'), [
			{
				k: 'assignCombatDamageByToughness',
				affected: { types: ['Creature'], controller: 'you' }
			}
		]);
		assert.deepEqual(defs('You may choose not to untap ~ during your untap step.'), [
			{ k: 'mayChooseNotToUntap', affected: 'self' }
		]);
	});
});

describe('Static grammar: Track P14 devotion, protection exemption, combat rules, zone permissions, prepared, and damage prevention', () => {
	it('compiles Theros God devotion Layer 4 type removal, self-safe Aura protection, super-trample, and graveyard Incarnation statics', () => {
		assert.deepEqual(defs("As long as your devotion to white is less than five, ~ isn't a creature."), [
			{
				k: 'continuous',
				layer: '4',
				affected: 'self',
				mod: { k: 'removeTypes', types: ['Creature'] },
				condition: {
					k: 'compare',
					left: { k: 'devotion', colors: ['W'], player: { k: 'you' } },
					op: '<',
					right: n(5)
				}
			}
		]);
		assert.deepEqual(
			defs("Enchanted creature has protection from all colors. This effect doesn't remove ~."),
			[
				{
					k: 'continuous',
					layer: '6',
					affected: 'attachedTo',
					mod: {
						k: 'addKeywords',
						keywords: ['protection from all colors'],
						protectionAttachmentExemption: 'self'
					}
				}
			]
		);
		assert.deepEqual(defs("You may have ~ assign its combat damage as though it weren't blocked."), [
			{ k: 'combatRule', affected: 'self', rule: { kind: 'assignCombatDamageAsThoughUnblocked' } }
		]);
		assert.deepEqual(
			defs('As long as ~ is in your graveyard and you control an Island, creatures you control have flying.'),
			[
				{
					k: 'continuous',
					layer: '6',
					affected: { types: ['Creature'], controller: 'you' },
					mod: { k: 'addKeywords', keywords: ['flying'] },
					activeInZone: 'graveyard',
					condition: {
						k: 'compare',
						left: { k: 'count', of: { subtypes: ['Island'], controller: 'you' } },
						op: '>=',
						right: n(1)
					}
				}
			]
		);
	});

	it('compiles single-axis Layer 7b, compound inline tails, two-sentence Otherwise, context-aware attached conditions, and colorsOfObject', () => {
		assert.deepEqual(defs('Creatures your opponents control have base toughness 1.'), [
			{
				k: 'continuous',
				layer: '7b',
				affected: { types: ['Creature'], controller: 'opponent' },
				mod: { k: 'setBaseToughness', toughness: n(1) }
			}
		]);
		assert.deepEqual(
			defs('Other Spiders, Boars, Birds, and Squirrels you control get +1/+1 and have vigilance.'),
			[
				{
					k: 'continuous',
					layer: '7c',
					affected: { other: true, subtypes: ['Spider', 'Boar', 'Bird', 'Squirrel'], controller: 'you' },
					mod: { k: 'pt', power: n(1), toughness: n(1) }
				},
				{
					k: 'continuous',
					layer: '6',
					affected: { other: true, subtypes: ['Spider', 'Boar', 'Bird', 'Squirrel'], controller: 'you' },
					mod: { k: 'addKeywords', keywords: ['vigilance'] }
				}
			]
		);
		assert.deepEqual(
			defs("Enchanted creature gets +2/+2 as long as it's a Vampire. Otherwise, it gets -2/-2."),
			[
				{
					k: 'continuous',
					layer: '7c',
					affected: 'attachedTo',
					mod: { k: 'pt', power: n(2), toughness: n(2) },
					condition: { k: 'objectState', of: 'attachedTo', filter: { subtypes: ['Vampire'] } }
				},
				{
					k: 'continuous',
					layer: '7c',
					affected: 'attachedTo',
					mod: { k: 'pt', power: n(-2), toughness: n(-2) },
					condition: {
						k: 'not',
						of: { k: 'objectState', of: 'attachedTo', filter: { subtypes: ['Vampire'] } }
					}
				}
			]
		);
		assert.deepEqual(
			defs("As long as enchanted permanent is a Vehicle, it's a creature in addition to its other types."),
			[
				{
					k: 'continuous',
					layer: '4',
					affected: 'attachedTo',
					mod: { k: 'addTypes', types: ['Creature'] },
					condition: { k: 'objectState', of: 'attachedTo', filter: { subtypes: ['Vehicle'] } }
				}
			]
		);
		assert.deepEqual(
			defs('Each other multicolored creature you control gets +1/+1 for each of its colors.'),
			[
				{
					k: 'continuous',
					layer: '7c',
					affected: { other: true, multicolored: true, types: ['Creature'], controller: 'you' },
					mod: {
						k: 'pt',
						power: { k: 'colorsOfObject', of: 'affected' },
						toughness: { k: 'colorsOfObject', of: 'affected' }
					}
				}
			]
		);
	});

	it('compiles combat rules, flash grants, commander designation, zone play permissions, prepared ETB, and damage prevention', () => {
		assert.deepEqual(defs("~ can attack as though it didn't have defender."), [
			{ k: 'combatRule', affected: 'self', rule: { kind: 'canAttackDespiteDefender' } }
		]);
		assert.deepEqual(defs('Enchanted creature is goaded.'), [
			{ k: 'combatRule', affected: 'attachedTo', rule: { kind: 'isGoaded' } }
		]);
		assert.deepEqual(defs("~ can't be blocked by creatures with greater power."), [
			{ k: 'combatRule', affected: 'self', rule: { kind: 'cantBeBlockedByPowerGreaterThanSelf' } }
		]);
		assert.deepEqual(defs("~ can't block creatures with flying."), [
			{
				k: 'combatRule',
				affected: 'self',
				rule: { kind: 'cantBlockFilter', filter: { types: ['Creature'], hasKeywords: ['flying'] } }
			}
		]);
		assert.deepEqual(defs('You may cast creature spells as though they had flash.'), [
			{
				k: 'ruleModifier',
				rule: 'castAsThoughFlash',
				who: { relation: 'you' },
				params: { spells: { types: ['Creature'] } }
			}
		]);
		assert.deepEqual(defs('~ can be your commander.'), [{ k: 'commanderDesignation' }]);
		assert.deepEqual(defs('~ enters prepared.'), [
			{
				replacement: {
					replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
					with: { k: 'modify', entersPrepared: true }
				}
			}
		]);
		assert.deepEqual(
			defs('During each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard.'),
			[
				{
					k: 'zonePlayPermission',
					zone: 'graveyard',
					allowLands: true,
					allowSpells: true,
					spellFilter: {
						types: ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker']
					},
					duringYourTurnOnly: true,
					slotMode: 'perPermanentType'
				}
			]
		);
		assert.deepEqual(defs('You may cast ~ from your graveyard or from exile.'), [
			{
				k: 'zonePlayPermission',
				zone: 'graveyard',
				affects: 'self',
				allowSpells: true
			},
			{
				k: 'zonePlayPermission',
				zone: 'exile',
				affects: 'self',
				allowSpells: true
			}
		]);
		assert.deepEqual(
			defs('If damage would be dealt to ~, prevent that damage and remove a +1/+1 counter from ~.'),
			[
				{
					k: 'staticDamagePrevention',
					amount: 'all',
					target: 'self',
					phantomCounterRemoval: { counter: '+1/+1', mode: 'one' }
				}
			]
		);
		assert.deepEqual(defs('Prevent all damage that would be dealt by sources with the chosen name.'), [
			{
				k: 'staticDamagePrevention',
				amount: 'all',
				target: 'any',
				sourceFilter: { ofChosenName: true }
			}
		]);
	});
});



