import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAbilityEffectText, parseEffects, parseSpellText, type EffectParse } from './effects.ts';
import type { EffectStep } from '../ir.ts';

/** Steps without spans, for readable assertions. */
function steps(parse: EffectParse): unknown[] {
	return JSON.parse(JSON.stringify(parse.steps, (k, v) => (k === 'span' ? undefined : v)));
}

function verbs(parse: EffectParse): string[] {
	return parse.steps.map((s) => s.verb);
}

function ok(parse: EffectParse): EffectParse {
	assert.deepEqual(parse.unparsed, [], 'expected the whole text to parse');
	return parse;
}

const YOU = { k: 'player', filter: { relation: 'you' } };

describe('Effect grammar: order and verbs', () => {
	it('keeps sentence order: "Each opponent loses 10 life and you gain 10 life" (Lathril)', () => {
		const p = ok(parseAbilityEffectText('Lathril, Blade of the Elves', 'Each opponent loses 10 life and you gain 10 life.'));
		assert.deepEqual(steps(p), [
			{ verb: 'loseLife', subject: { k: 'player', filter: { relation: 'each_opponent' } }, amount: { k: 'const', n: 10 } },
			{ verb: 'gainLife', subject: YOU, amount: { k: 'const', n: 10 } }
		]);
	});

	it('a continued predicate keeps its subject and its target ("Target player draws two cards and loses 2 life")', () => {
		const p = ok(parseSpellText('Inkwell Pact', 'Target player draws two cards and loses 2 life.'));
		assert.equal(p.targets.length, 1);
		assert.deepEqual(p.targets[0].kind, 'player');
		const subject = { k: 'playerRef', ref: { k: 'target', index: 0 } };
		assert.deepEqual(steps(p), [
			{ verb: 'draw', subject, amount: { k: 'const', n: 2 } },
			{ verb: 'loseLife', subject, amount: { k: 'const', n: 2 } }
		]);
	});

	it('verb x selector: destroy target / all, damage to any target / each creature / each opponent', () => {
		assert.deepEqual(verbs(ok(parseSpellText('Grimble Rot', 'Destroy target artifact or creature. It can\'t be regenerated.'))), ['destroy']);
		const wrath = ok(parseSpellText('Grimble Wipe', 'Destroy all creatures. They can\'t be regenerated.'));
		assert.deepEqual(wrath.steps[0].subject, { k: 'all', filter: { types: ['Creature'], zone: 'battlefield' } });
		const bolt = ok(parseSpellText('Zorblax Jolt', 'Zorblax Jolt deals 3 damage to any target.'));
		assert.equal(bolt.targets[0].kind, 'objectOrPlayer');
		assert.deepEqual(steps(bolt), [{ verb: 'damage', subject: { k: 'target', index: 0 }, amount: { k: 'const', n: 3 } }]);
		const sweep = ok(parseSpellText('Zorblax Storm', 'Zorblax Storm deals 2 damage to each creature and each opponent.'.replace(' and each opponent', '')));
		assert.deepEqual(sweep.steps[0].subject, { k: 'all', filter: { types: ['Creature'], zone: 'battlefield' } });
		const opp = ok(parseEffects('~ deals 2 damage to each opponent.', 0, 'triggered'));
		assert.deepEqual(opp.steps[0].subject, { k: 'player', filter: { relation: 'each_opponent' } });
	});

	it('covers the verbs of the legacy executeParsedEffect cases', () => {
		const cases: Array<[string, string, EffectStep['verb'][]]> = [
			['Counter target noncreature spell.', 'spell', ['counterSpell']],
			['Scry 2, then draw a card.', 'spell', ['scry', 'draw']],
			['Return target nonland permanent you don\'t control to its owner\'s hand.', 'spell', ['bounce']],
			['Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.', 'spell', ['search']],
			['Create two 1/1 white Soldier creature tokens with lifelink.', 'spell', ['createToken']],
			['Create a Treasure token.', 'spell', ['createToken']],
			['Create a token that\'s a copy of target creature you control.', 'spell', ['copyPermanent']],
			['Proliferate.', 'spell', ['proliferate']],
			['Put a +1/+1 counter on each creature you control.', 'activated', ['putCounters']],
			['Put two +1/+1 counters on ~.', 'activated', ['putCounters']],
			['~ gets +1/+0 until end of turn.', 'activated', ['pump']],
			['Target creature gains flying until end of turn.', 'spell', ['grant']],
			['Add {R}{R}{R}.', 'spell', ['addMana']],
			['Return target creature card from your graveyard to your hand.', 'spell', ['move']],
			['Return the top creature card of your graveyard to the battlefield.', 'spell', ['move']],
			['Attach to target creature you control.', 'activated', ['attach']],
			['End the turn.', 'spell', ['endTurn']],
			['The player whose turn it is may end the turn.', 'activated', ['endTurn']],
			['Take an extra turn after this one.', 'spell', ['extraTurn']],
			['All permanents you control phase out.', 'spell', ['phaseOut']],
			['Switch target creature\'s power and toughness until end of turn.', 'spell', ['switchPT']],
			['You win the game.', 'spell', ['win']],
			['You lose the game.', 'spell', ['lose']],
			['Sacrifice ~.', 'activated', ['sacrifice']],
			['Exile all graveyards.', 'triggered', ['exile']],
			['Return ~ from your graveyard to the battlefield.', 'triggered', ['move']],
			['Mill three cards.', 'spell', ['mill']]
		];
		for (const [text, ctx, expected] of cases) {
			const p = parseEffects(text, 0, ctx as 'spell');
			assert.deepEqual(p.unparsed, [], text);
			assert.deepEqual(verbs(p), expected, text);
		}
	});

	it('reports what it does not understand as unparsed spans, sentence by sentence', () => {
		const text = 'Draw a card. Each player shuffles their hand into their library.';
		const p = parseEffects(text, 10);
		assert.deepEqual(verbs(p), ['draw']);
		assert.equal(p.unparsed.length, 1);
		assert.equal(text.slice(p.unparsed[0].start - 10, p.unparsed[0].end - 10), 'Each player shuffles their hand into their library.');
	});
});

describe('Effect grammar: bindings, LKI and actors', () => {
	it('Swords to Plowshares: the life gain is bound to the exiled creature (controller and power from LKI)', () => {
		const p = ok(parseSpellText('Plowshare Edict', 'Exile target creature. Its controller gains life equal to its power.'));
		assert.deepEqual(steps(p), [
			{ verb: 'exile', subject: { k: 'target', index: 0 }, bindAs: 'b0' },
			{
				verb: 'gainLife',
				subject: { k: 'playerRef', ref: { k: 'controllerOf', of: { k: 'binding', name: 'b0' } } },
				amount: { k: 'stat', of: { k: 'binding', name: 'b0' }, stat: 'power', lki: true }
			}
		]);
	});

	it('"Its controller creates ..." makes the bound object\'s controller the actor', () => {
		const p = ok(parseSpellText('Beastly Gift', 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.'));
		assert.deepEqual(p.steps[1].actor, { k: 'controllerOf', of: { k: 'binding', name: 'b0' } });
		assert.equal(p.steps[1].params?.token?.name, 'Beast Token');
	});

	it('Corpse Dance: move binds the creature; haste and the delayed exile refer to the same binding', () => {
		const p = ok(
			parseSpellText(
				'Grave Waltz',
				'Buyback {2} (You may pay an additional {2} as you cast this spell. If you do, put this card into your hand as it resolves.)\nReturn the top creature card of your graveyard to the battlefield. That creature gains haste until end of turn. Exile it at the beginning of the next end step.'
			)
		);
		assert.deepEqual(steps(p), [
			{
				verb: 'move',
				subject: { k: 'all', filter: { types: ['Creature'], zone: 'graveyard', owner: 'you' } },
				params: { from: 'graveyard', to: 'battlefield', topmostOnly: true },
				bindAs: 'b0'
			},
			{ verb: 'grant', subject: { k: 'binding', name: 'b0' }, params: { keywords: ['Haste'], duration: 'endOfTurn' } },
			{
				verb: 'delayedTrigger',
				subject: { k: 'none' },
				delayed: {
					trigger: { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'each_turn' },
					effect: [{ verb: 'exile', subject: { k: 'binding', name: 'b0' } }]
				}
			}
		]);
	});

	it('"You lose life equal to that card\'s mana value" reads the moved card\'s LKI (Reanimate)', () => {
		const p = ok(parseSpellText('Necro Pull', 'Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to that card\'s mana value.'));
		assert.equal(p.targets[0].filter.zone, 'graveyard');
		assert.deepEqual(p.steps[0].params, { from: 'graveyard', to: 'battlefield', underYourControl: true });
		assert.deepEqual(p.steps[1].amount, { k: 'stat', of: { k: 'binding', name: 'b0' }, stat: 'manaValue', lki: true });
	});

	it('"may" makes a step optional for its chooser (Path to Exile)', () => {
		const p = ok(
			parseSpellText(
				'Exile Path',
				'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.'
			)
		);
		const ctl = { k: 'controllerOf', of: { k: 'binding', name: 'b0' } };
		assert.deepEqual(p.steps[1].optional, { chooser: ctl });
		assert.deepEqual(p.steps[1].actor, ctl);
		assert.equal(p.steps[1].params?.search?.destinations[0].tapped, true);
	});

	it('in a triggered ability, "it" is the event object and "that many" the event amount', () => {
		const tokens = ok(parseEffects('create that many 1/1 green Elf Warrior creature tokens.', 0, 'triggered'));
		assert.deepEqual(tokens.steps[0].amount, { k: 'eventAmount' });
		const it = ok(parseEffects('exile it.', 0, 'triggered'));
		assert.deepEqual(it.steps[0].subject, { k: 'eventObject' });
	});

	it('"It phases out" after putting a counter on a target refers to that target (Slip Out the Back)', () => {
		const p = ok(parseSpellText('Back Door', 'Put a +1/+1 counter on target creature. It phases out.'));
		assert.deepEqual(verbs(p), ['putCounters', 'phaseOut']);
		assert.deepEqual(p.steps[1].subject, { k: 'binding', name: 'b0' });
	});
});

describe('Effect grammar: amounts, delayed effects and special sentences', () => {
	it('Amount expressions replace dynamicFormula strings', () => {
		const ov = ok(parseSpellText('Stampede Call', 'Creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.'));
		const x = { k: 'count', of: { types: ['Creature'], zone: 'battlefield', controller: 'you' } };
		assert.deepEqual(verbs(ov), ['grant', 'pump']);
		assert.deepEqual(ov.steps[1].amount, x);
		assert.deepEqual(ov.steps[1].params?.toughness, x);

		const deluge = ok(parseSpellText('Murk Flood', 'All creatures get -X/-X until end of turn.'));
		assert.deepEqual(deluge.steps[0].amount, { k: 'negate', of: { k: 'x' } });

		const mana = ok(parseAbilityEffectText('Grove Keeper', 'Add {G} for each Elf you control.'));
		assert.deepEqual(mana.steps[0].amount, { k: 'count', of: { subtypes: ['Elf'], zone: 'battlefield', controller: 'you' } });
		const power = ok(parseAbilityEffectText('Grove Keeper', "Add an amount of {G} equal to Grove Keeper's power."));
		assert.deepEqual(power.steps[0].amount, { k: 'stat', of: { k: 'self' }, stat: 'power' });

		const win = ok(parseEffects('If your devotion to blue is greater than or equal to the number of cards in your library, you win the game.', 0, 'triggered'));
		assert.deepEqual(win.steps[0].params?.condition, {
			k: 'compare',
			left: { k: 'devotion', colors: ['U'] },
			op: '>=',
			right: { k: 'cardsIn', zone: 'library', of: { k: 'you' } }
		});
	});

	it('"any color that a land an opponent controls could produce" is its own mana choice, not "any color"', () => {
		const p = ok(parseAbilityEffectText('Alien Grove', 'Add one mana of any color that a land an opponent controls could produce.'));
		assert.deepEqual(p.steps[0].params, { manaChoice: 'opponentLandColors' });
		const any = ok(parseAbilityEffectText('Prism Stone', 'Add one mana of any color.'));
		assert.deepEqual(any.steps[0].params, { manaChoice: 'any' });
	});

	it('Final Fortune: the delayed loss is on "that turn" (the extra turn)', () => {
		const p = ok(parseSpellText('Last Gamble', "Take an extra turn after this one. At the beginning of that turn's end step, you lose the game."));
		assert.deepEqual(verbs(p), ['extraTurn', 'delayedTrigger']);
		assert.equal(p.steps[1].delayed?.trigger.scope, 'controller_turn');
		assert.deepEqual(p.steps[1].delayed?.effect.map((s) => s.verb), ['lose']);
	});

	it("Teferi's Protection: player rules, team phase-out and the spell exiling itself", () => {
		const p = ok(
			parseSpellText(
				'Shelter Veil',
				"Until your next turn, your life total can't change and you gain protection from everything. All permanents you control phase out. (While they're phased out, they're treated as though they don't exist. They phase in before you untap during your untap step.)\nExile Shelter Veil."
			)
		);
		assert.deepEqual(verbs(p), ['grantPlayer', 'phaseOut', 'exile']);
		assert.deepEqual(p.steps[2].subject, { k: 'self' });
	});

	it('Ponder: "You may shuffle." belongs to the look-and-reorder step', () => {
		const p = ok(parseSpellText('Muse', 'Look at the top three cards of your library, then put them back in any order. You may shuffle.\nDraw a card.'));
		assert.deepEqual(verbs(p), ['lookAndReorder', 'draw']);
		assert.equal(p.steps[0].params?.mayShuffle, true);
	});

	it('modal spells parse each mode', () => {
		const p = ok(parseSpellText('Five Ways', 'Choose one or more —\n• Destroy target artifact.\n• Destroy target creature.\n• Exile all graveyards.'));
		assert.equal(p.modal?.modes.length, 3);
		assert.deepEqual([p.modal?.min, p.modal?.max], [1, 3]);
		assert.deepEqual(p.modal?.modes.map((m) => m.effect.map((s) => s.verb)), [['destroy'], ['destroy'], ['exile']]);
	});

	it('keyword lines, additional costs and restrictions are not effect sentences', () => {
		const p = ok(parseSpellText('Rift Snap', 'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {6}{U}'));
		assert.deepEqual(verbs(p), ['bounce']);
		const ab = ok(parseAbilityEffectText('Sun Clock', 'End the turn. Activate only during your turn.'));
		assert.deepEqual(verbs(ab), ['endTurn']);
	});

	it('does not depend on the card name: renamed cards compile identically', () => {
		const a = parseSpellText('Lightning Bolt', 'Lightning Bolt deals 3 damage to any target.');
		const b = parseSpellText('Qwerty Zap', 'Qwerty Zap deals 3 damage to any target.');
		assert.deepEqual(steps(a), steps(b));
	});

	it('compiles until-end-of-turn keyword removal and cantHaveOrGain riders without card-name dependence', () => {
		const spear = ok(
			parseAbilityEffectText(
				'Shadowspear',
				'Permanents your opponents control lose hexproof and indestructible until end of turn.'
			)
		);
		assert.deepEqual(spear.steps[0], {
			verb: 'grant',
			subject: { k: 'all', filter: { zone: 'battlefield', controller: 'opponent' } },
			params: { removeKeywords: ['Hexproof', 'Indestructible'], duration: 'endOfTurn' },
			span: spear.steps[0].span
		});

		const lighthouse = ok(
			parseAbilityEffectText(
				'Arcane Lighthouse',
				"Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud."
			)
		);
		assert.deepEqual(lighthouse.steps[0], {
			verb: 'grant',
			subject: { k: 'all', filter: { types: ['Creature'], zone: 'battlefield', controller: 'opponent' } },
			params: {
				removeKeywords: ['Hexproof', 'Shroud'],
				cantHaveOrGain: true,
				duration: 'endOfTurn'
			},
			span: lighthouse.steps[0].span
		});

		const renamed = ok(
			parseAbilityEffectText(
				'Glimmerfen Beacon',
				"Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud."
			)
		);
		assert.deepEqual(steps(lighthouse), steps(renamed));

		const bonds = ok(
			parseAbilityEffectText(
				'Bonds of Mortality',
				'Creatures your opponents control lose hexproof and indestructible until end of turn.'
			)
		);
		assert.deepEqual(bonds.steps[0].params, {
			removeKeywords: ['Hexproof', 'Indestructible'],
			duration: 'endOfTurn'
		});

		const targeted = ok(parseSpellText('Clip Wings', 'Target creature loses flying until end of turn.'));
		assert.equal(targeted.targets.length, 1);
		assert.deepEqual(targeted.steps[0].subject, { k: 'target', index: 0 });
		assert.deepEqual(targeted.steps[0].params, {
			removeKeywords: ['Flying'],
			duration: 'endOfTurn'
		});

		const selfLose = ok(parseAbilityEffectText('Stone Sentry', 'Stone Sentry loses defender until end of turn.'));
		assert.deepEqual(selfLose.steps[0].subject, { k: 'self' });
		assert.deepEqual(selfLose.steps[0].params, {
			removeKeywords: ['Defender'],
			duration: 'endOfTurn'
		});
	});

	it('parses mid-sequence "may", "If you do / If that player does", non-controller choosers, and named searches', () => {
		const lootIf = ok(parseSpellText('Study Gamble', 'Draw a card. You may discard a card. If you do, draw two cards.'));
		assert.deepEqual(verbs(lootIf), ['draw', 'discard', 'draw']);
		assert.deepEqual(lootIf.steps[1].optional, { chooser: { k: 'you' } });
		assert.equal(lootIf.steps[2].ifPrecedingAccepted, 1);

		const oneSentence = ok(parseSpellText('Bargain Draw', 'You may discard a card, and if you do, draw two cards.'));
		assert.deepEqual(verbs(oneSentence), ['discard', 'draw']);
		assert.deepEqual(oneSentence.steps[0].optional, { chooser: { k: 'you' } });
		assert.equal(oneSentence.steps[1].ifPrecedingAccepted, 0);

		const oppMay = ok(parseSpellText('Tribute Deal', 'Target opponent may sacrifice a creature. If that player does, they draw a card.'));
		assert.deepEqual(verbs(oppMay), ['sacrifice', 'draw']);
		assert.equal(oppMay.targets[0]?.player?.relation, 'opponent');
		assert.deepEqual(oppMay.steps[0].optional, { chooser: { k: 'target', index: 0 } });
		assert.equal(oppMay.steps[1].ifPrecedingAccepted, 0);

		const namedSearch = ok(
			parseSpellText(
				'Bear Call',
				'Search your library for a card named Forest Bear, reveal it, put it into your hand, then shuffle.'
			)
		);
		assert.deepEqual(namedSearch.steps[0].params?.search?.filter, { named: 'Forest Bear' });
		assert.equal(namedSearch.steps[0].params?.search?.statedQuality, true);

		const danglingIf = parseSpellText('Bad If', 'Draw a card. If you do, gain 2 life.');
		assert.equal(danglingIf.unparsed.length, 1);
	});

	it('parses restricted mana, predefined Powerstone/Vibranium/Junk tokens, and top-of-library impulse exile', () => {
		const powerstoneAb = ok(
			parseAbilityEffectText('Powerstone', "Add {C}. This mana can't be spent to cast a nonartifact spell.")
		);
		assert.deepEqual(steps(powerstoneAb), [
			{
				verb: 'addMana',
				subject: { k: 'none' },
				amount: { k: 'const', n: 1 },
				params: { mana: ['C'], manaRestriction: 'artifactSpellOrNonSpell' }
			}
		]);

		const junkAb = ok(
			parseAbilityEffectText(
				'Junk',
				'Exile the top card of your library. You may play that card this turn. Activate only as a sorcery.'
			)
		);
		assert.deepEqual(steps(junkAb), [
			{
				verb: 'exile',
				subject: { k: 'libraryTop' },
				amount: { k: 'const', n: 1 },
				bindAs: 'b0'
			},
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'binding', name: 'b0' },
				params: { playFromExile: { duration: 'thisTurn' } }
			}
		]);

		const impulseTwo = ok(
			parseSpellText(
				'Reckless Probe',
				'Exile the top two cards of your library. You may play those cards this turn.'
			)
		);
		assert.deepEqual(steps(impulseTwo), [
			{
				verb: 'exile',
				subject: { k: 'libraryTop' },
				amount: { k: 'const', n: 2 },
				bindAs: 'b0'
			},
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'binding', name: 'b0' },
				params: { playFromExile: { duration: 'thisTurn' } }
			}
		]);

		const tappedPowerstone = ok(parseSpellText('Powerstone Forge', 'Create a tapped Powerstone token.'));
		assert.equal(tappedPowerstone.steps[0].verb, 'createToken');
		assert.equal(tappedPowerstone.steps[0].params?.token?.name, 'Powerstone');
		assert.equal(tappedPowerstone.steps[0].params?.token?.tapped, true);

		const vibranium = ok(parseSpellText('Vibranium Gift', 'Create a Vibranium token.'));
		assert.equal(vibranium.steps[0].params?.token?.name, 'Vibranium');
		assert.deepEqual(vibranium.steps[0].params?.token?.keywords, ['Indestructible']);

		const junkCreate = ok(parseSpellText('Junkyard Gift', 'Create two Junk tokens.'));
		assert.equal(junkCreate.steps[0].params?.token?.name, 'Junk');
		assert.deepEqual(junkCreate.steps[0].amount, { k: 'const', n: 2 });

		const powerstonePlural = ok(
			parseAbilityEffectText('Mightstone', "Add {C}{C}. This mana can't be spent to cast nonartifact spells.")
		);
		assert.deepEqual(steps(powerstonePlural), [
			{
				verb: 'addMana',
				subject: { k: 'none' },
				amount: { k: 'const', n: 2 },
				params: { mana: ['C', 'C'], manaRestriction: 'artifactSpellOrNonSpell' }
			}
		]);

		const untilEotImpulse = ok(
			parseSpellText(
				'Act on Impulse Probe',
				'Exile the top three cards of your library. Until end of turn, you may play those cards.'
			)
		);
		assert.deepEqual(steps(untilEotImpulse), [
			{
				verb: 'exile',
				subject: { k: 'libraryTop' },
				amount: { k: 'const', n: 3 },
				bindAs: 'b0'
			},
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'binding', name: 'b0' },
				params: { playFromExile: { duration: 'thisTurn' } }
			}
		]);

		const renamedA = ok(
			parseSpellText('Alpha Impulse', 'Exile the top card of your library. You may play that card this turn.')
		);
		const renamedB = ok(
			parseSpellText('Beta Impulse', 'Exile the top card of your library. You may play that card this turn.')
		);
		assert.deepEqual(steps(renamedA), steps(renamedB));
	});
});
