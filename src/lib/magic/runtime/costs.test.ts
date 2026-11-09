import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities,
	getSpellCostRequirement
} from '../engine.ts';
import { runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

/**
 * Phase 4: costs paid from the IR. Every card here has an invented name, so nothing can depend on
 * names. Each `it` was written to fail on the engine before Phase 4 (the over-claiming bugs listed in
 * ENGINE_ARCHITECTURE_PLAN.md, Phase 1 follow-up: cost grammar).
 */

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `cost_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

const creature = (name: string, power = 2, extra: Partial<ScryfallCard> = {}) =>
	card({ name, typeLine: 'Creature — Beast', manaCost: '{1}{G}', cmc: 2, power: String(power), toughness: '2', ...extra });
const artifact = (name: string) => card({ name, typeLine: 'Artifact', manaCost: '{2}', cmc: 2 });
const spell = (name: string, cost: string) =>
	card({ name, oracleText: `As an additional cost to cast this spell, ${cost}\nDraw a card.` });

function seat(i: number, isBot: boolean): LobbySeat {
	const deck = PRECON_DECKS[i];
	return {
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `P${i + 1}`,
		avatarUrl: '',
		isBot,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: deck.colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	};
}

function newGame(): { state: GameState; p1: PlayerGameState } {
	const seats = [seat(0, false), seat(1, false)];
	const state = createInitialGameState(
		'COST',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	for (const p of state.players) {
		p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		p.hand = [];
		p.battlefield = [];
	}
	return { state, p1: state.players[0] };
}

function put(state: GameState, p: PlayerGameState, c: ScryfallCard, zone: 'hand' | 'battlefield' | 'graveyard'): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, p.playerId, zone, false, false, state.nextTimestamp);
	inst.summoningSick = false;
	p[zone].push(inst);
	return inst;
}

const inZone = (p: PlayerGameState, zone: 'hand' | 'battlefield' | 'graveyard', c: CardInstance) =>
	p[zone].some((x) => x.instanceId === c.instanceId);

describe('Phase 4 costs: choices between costs', () => {
	it('"discard a card or pay 3 life" pays only the chosen option', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Bargain of Ash', 'discard a card or pay 3 life.'), 'hand');
		const keep = put(state, p1, creature('Ash Fodder'), 'hand');
		const life = p1.life;
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: s.instanceId,
			costPayment: { options: [1] }
		});
		assert.equal(res.ok, true, res.error ?? "");
		assert.equal(p1.life, life - 3);
		assert.ok(inZone(p1, 'hand', keep), 'no card was discarded');
	});

	it('the other option: discard, and no life is paid', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Bargain of Ash', 'discard a card or pay 3 life.'), 'hand');
		const fodder = put(state, p1, creature('Ash Fodder'), 'hand');
		const life = p1.life;
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: s.instanceId,
			costPayment: { options: [0] }
		});
		assert.equal(res.ok, true, res.error ?? "");
		assert.equal(p1.life, life);
		assert.ok(inZone(p1, 'graveyard', fodder));
	});

	it('without a payment, a human is asked to choose and nothing is paid yet', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Bargain of Ash', 'discard a card or pay 3 life.'), 'hand');
		put(state, p1, creature('Ash Fodder'), 'hand');
		const life = p1.life;
		const pool = { ...p1.manaPool };
		const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId });
		assert.equal(res.ok, true, res.error ?? "");
		assert.equal(state.stack.length, 0);
		assert.ok(inZone(p1, 'hand', s));
		assert.equal(p1.life, life);
		assert.deepEqual(p1.manaPool, pool);
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt?.kind, 'cost_choice');
		assert.equal(prompt.costOptionLabels?.length, 2);

		// Answering the prompt casts the spell with that choice.
		const answer = applyGameAction(state, p1.playerId, { type: 'cost_choice', promptId: prompt.id, option: 1 });
		assert.equal(answer.ok, true, answer.error ?? "");
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 1);
		assert.equal(p1.life, life - 3);
	});

	it('with no other card in hand, the only legal option is taken automatically', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Bargain of Ash', 'discard a card or pay 3 life.'), 'hand');
		const life = p1.life;
		const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId });
		assert.equal(res.ok, true, res.error ?? "");
		assert.equal(state.stack.length, 1);
		assert.equal(p1.life, life - 3);
	});

	it('"sacrifice a creature or pay {3}{B}" can be paid with mana and no creature', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Price of Tar', 'sacrifice a creature or pay {3}{B}.'), 'hand');
		assert.equal(checkSpellCastLegality(state, p1.playerId, s, 'hand').ok, true);
		const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId });
		assert.equal(res.ok, true, res.error ?? "");
		assert.equal(state.stack.length, 1);
		assert.equal(p1.manaPool.B, 9);
	});
});

describe('Phase 4 costs: optional costs', () => {
	it('"you may sacrifice an artifact" is not mandatory', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Spark Gamble', 'you may sacrifice an artifact.'), 'hand');
		const relic = put(state, p1, artifact('Gamble Relic'), 'battlefield');
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: s.instanceId,
			costPayment: { options: [1] }
		});
		assert.equal(res.ok, true, res.error ?? "");
		assert.ok(inZone(p1, 'battlefield', relic), 'the artifact was not sacrificed');
		assert.equal(state.stack.length, 1);
	});
});

describe('Phase 4 costs: filters keep their conditions and alternatives', () => {
	it('"a creature with power 4 or greater" needs such a creature', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Mighty Offering', 'sacrifice a creature with power 4 or greater.'), 'hand');
		put(state, p1, creature('Small Offering', 2), 'battlefield');
		assert.equal(checkSpellCastLegality(state, p1.playerId, s, 'hand').ok, false);
		const big = put(state, p1, creature('Large Offering', 5), 'battlefield');
		assert.equal(checkSpellCastLegality(state, p1.playerId, s, 'hand').ok, true);
		const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId });
		assert.equal(res.ok, true, res.error ?? "");
		assert.ok(inZone(p1, 'graveyard', big), 'the only legal creature was sacrificed');
	});

	it('"an artifact or creature" accepts a creature', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Either Offering', 'sacrifice an artifact or creature.'), 'hand');
		const beast = put(state, p1, creature('Either Beast'), 'battlefield');
		assert.equal(checkSpellCastLegality(state, p1.playerId, s, 'hand').ok, true);
		const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId });
		assert.equal(res.ok, true, res.error ?? "");
		assert.ok(inZone(p1, 'graveyard', beast));
	});

	it('"discard a card at random" uses the random source, not the first card', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Wild Thought', 'discard a card at random.'), 'hand');
		const first = put(state, p1, creature('Thought One'), 'hand');
		put(state, p1, creature('Thought Two'), 'hand');
		const last = put(state, p1, creature('Thought Three'), 'hand');
		const random = Math.random;
		Math.random = () => 0.99;
		try {
			const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId });
			assert.equal(res.ok, true, res.error ?? "");
		} finally {
			Math.random = random;
		}
		assert.equal(state.pendingPrompts.length, 0, 'a random discard is not a choice');
		assert.ok(inZone(p1, 'hand', first));
		assert.ok(inZone(p1, 'graveyard', last));
	});
});

describe('Phase 4 costs: the player chooses the objects', () => {
	it('sacrifices the creature the player chose', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Rite of Choice', 'sacrifice a creature.'), 'hand');
		put(state, p1, creature('Cheap Beast'), 'battlefield');
		const chosen = put(state, p1, creature('Chosen Beast', 3, { cmc: 5 }), 'battlefield');
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: s.instanceId,
			costPayment: { objects: [[chosen.instanceId]] }
		});
		assert.equal(res.ok, true, res.error ?? "");
		assert.ok(inZone(p1, 'graveyard', chosen));
		assert.equal(p1.battlefield.length, 1);
	});

	it('asks a human which creature to sacrifice when there are several', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Rite of Choice', 'sacrifice a creature.'), 'hand');
		const a = put(state, p1, creature('Beast A'), 'battlefield');
		const b = put(state, p1, creature('Beast B'), 'battlefield');
		const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId });
		assert.equal(res.ok, true, res.error ?? "");
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt?.kind, 'cost_choice');
		assert.deepEqual([...(prompt.candidateInstanceIds ?? [])].sort(), [a.instanceId, b.instanceId].sort());
		assert.equal(prompt.countRequired, 1);
		assert.equal(p1.battlefield.length, 2, 'nothing sacrificed before the choice');
		const answer = applyGameAction(state, p1.playerId, {
			type: 'cost_choice',
			promptId: prompt.id,
			instanceIds: [b.instanceId]
		});
		assert.equal(answer.ok, true, answer.error ?? "");
		assert.ok(inZone(p1, 'battlefield', a));
		assert.ok(inZone(p1, 'graveyard', b));
		assert.equal(state.stack.length, 1);
	});

	it('rejects a chosen object that does not match the cost', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Rite of Choice', 'sacrifice a creature.'), 'hand');
		put(state, p1, creature('Beast A'), 'battlefield');
		put(state, p1, creature('Beast B'), 'battlefield');
		const relic = put(state, p1, artifact('Not A Creature'), 'battlefield');
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: s.instanceId,
			costPayment: { objects: [[relic.instanceId]] }
		});
		assert.equal(res.ok, false);
		assert.ok(inZone(p1, 'hand', s));
	});

	it('discards the card the player chose', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Wheel of Choice', 'discard a card.'), 'hand');
		const first = put(state, p1, creature('Hand One'), 'hand');
		const chosen = put(state, p1, creature('Hand Two'), 'hand');
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: s.instanceId,
			costPayment: { objects: [[chosen.instanceId]] }
		});
		assert.equal(res.ok, true, res.error ?? "");
		assert.ok(inZone(p1, 'hand', first));
		assert.ok(inZone(p1, 'graveyard', chosen));
	});

	it('cancelling the prompt leaves the spell in hand', () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Wheel of Choice', 'discard a card.'), 'hand');
		put(state, p1, creature('Hand One'), 'hand');
		put(state, p1, creature('Hand Two'), 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s.instanceId }).ok, true);
		const prompt = state.pendingPrompts[0];
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cost_choice', promptId: prompt.id, cancel: true }).ok, true);
		assert.equal(state.pendingPrompts.length, 0);
		assert.ok(inZone(p1, 'hand', s));
		assert.equal(p1.hand.length, 3);
	});
});

describe('Phase 4 costs: activated abilities pay their whole cost', () => {
	const ability = (state: GameState, p: PlayerGameState, perm: CardInstance) =>
		getEffectiveActivatedAbilities(state, p, perm).find((a) => !a.isManaAbility)!;

	it('"Tap two untapped Wizards you control" is any filter, not a text literal', () => {
		const { state, p1 } = newGame();
		const src = put(
			state,
			p1,
			card({ name: 'Circle Keeper', typeLine: 'Artifact', oracleText: 'Tap two untapped Wizards you control: Draw a card.' }),
			'battlefield'
		);
		const wiz = (name: string) => card({ name, typeLine: 'Creature — Human Wizard', power: '1', toughness: '1' });
		const w1 = put(state, p1, wiz('Wizard One'), 'battlefield');
		const ab = ability(state, p1, src);
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, src, ab).ok, false, 'one Wizard is not enough');
		const w2 = put(state, p1, wiz('Wizard Two'), 'battlefield');
		w2.summoningSick = true; // CR 302.6 doesn't apply to tapping other creatures for a cost.
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, src, ab).ok, true);
		const res = applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: src.instanceId, abilityId: ab.id });
		assert.equal(res.ok, true, res.error ?? "");
		assert.equal(w1.tapped && w2.tapped, true);
		assert.equal(src.tapped, false);
	});

	it('without {T} in the cost, the source may be one of the creatures it taps', () => {
		const { state, p1 } = newGame();
		const elf = (name: string) => card({ name, typeLine: 'Creature — Elf Warrior', power: '1', toughness: '1' });
		const src = put(
			state,
			p1,
			card({ name: 'Grove Marshal', typeLine: 'Legendary Creature — Elf Noble', power: '2', toughness: '2', oracleText: 'Tap three untapped Elves you control: Draw a card.' }),
			'battlefield'
		);
		put(state, p1, elf('Grove Elf One'), 'battlefield');
		const ab = ability(state, p1, src);
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, src, ab).ok, false);
		put(state, p1, elf('Grove Elf Two'), 'battlefield');
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, src, ab).ok, true, 'two others plus itself');
	});

	it('"Sacrifice a creature:" sacrifices the chosen creature', () => {
		const { state, p1 } = newGame();
		const src = put(
			state,
			p1,
			card({ name: 'Hungry Altar', typeLine: 'Artifact', oracleText: 'Sacrifice a creature: Draw a card.' }),
			'battlefield'
		);
		put(state, p1, creature('Altar Beast A'), 'battlefield');
		const b = put(state, p1, creature('Altar Beast B'), 'battlefield');
		const ab = ability(state, p1, src);
		const res = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: src.instanceId,
			abilityId: ab.id,
			costPayment: { objects: [[b.instanceId]] }
		});
		assert.equal(res.ok, true, res.error ?? "");
		assert.ok(inZone(p1, 'graveyard', b));
		assert.equal(state.stack.length, 1);
	});

	it('"Discard a card:" needs a card to discard', () => {
		const { state, p1 } = newGame();
		const src = put(
			state,
			p1,
			card({ name: 'Rummage Idol', typeLine: 'Artifact', oracleText: '{1}, Discard a card: Draw a card.' }),
			'battlefield'
		);
		const ab = ability(state, p1, src);
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, src, ab).ok, false);
		const c = put(state, p1, creature('Rummaged'), 'hand');
		const res = applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: src.instanceId, abilityId: ab.id });
		assert.equal(res.ok, true, res.error ?? "");
		assert.ok(inZone(p1, 'graveyard', c));
	});

	it('CR 119.4: life equal to your life total can be paid', () => {
		const { state, p1 } = newGame();
		const src = put(
			state,
			p1,
			card({ name: 'Blood Idol', typeLine: 'Artifact', oracleText: 'Pay 5 life: Draw a card.' }),
			'battlefield'
		);
		p1.life = 5;
		const ab = ability(state, p1, src);
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, src, ab).ok, true);
	});

	it("CR 119.8: a player whose life total can't change can't pay life", () => {
		const { state, p1 } = newGame();
		const s = put(state, p1, spell('Blood Price', 'pay 4 life.'), 'hand');
		p1.lifeTotalCannotChangeThisTurn = true;
		assert.equal(checkSpellCastLegality(state, p1.playerId, s, 'hand').ok, false);
	});

	it('{T} and mana: the source is not also tapped for mana, and nothing is paid if the cost fails', () => {
		const { state, p1 } = newGame();
		const src = put(
			state,
			p1,
			card({ name: 'Drain Idol', typeLine: 'Artifact', oracleText: '{2}, {T}, Sacrifice a creature: Draw a card.' }),
			'battlefield'
		);
		const ab = ability(state, p1, src);
		const pool = { ...p1.manaPool };
		const res = applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: src.instanceId, abilityId: ab.id });
		assert.equal(res.ok, false, 'no creature to sacrifice');
		assert.deepEqual(p1.manaPool, pool, 'no mana was spent');
		assert.equal(src.tapped, false);
	});
});

describe('Phase 4 costs: cost modifiers, keyword costs, dynamic mana, and bots', () => {
	it('cost modifiers from IR support arbitrary subtypes ("Wizard spells you cast cost {1} less to cast.")', () => {
		const { state, p1 } = newGame();
		put(
			state,
			p1,
			card({
				name: 'Arcane Banneret',
				typeLine: 'Creature — Human Wizard',
				oracleText: 'Wizard spells you cast cost {1} less to cast.',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const wizSpell = put(
			state,
			p1,
			card({
				name: 'Tower Apprentice',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Creature — Human Wizard',
				power: '1',
				toughness: '3'
			}),
			'hand'
		);
		const beastSpell = put(
			state,
			p1,
			card({
				name: 'Tower Beast',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Beast',
				power: '3',
				toughness: '3'
			}),
			'hand'
		);
		assert.equal(getSpellCostRequirement(p1, wizSpell, state).generic, 1);
		assert.equal(getSpellCostRequirement(p1, beastSpell, state).generic, 2);
	});

	it('Eminence cost modifier in command zone reduces other matching spells and not itself', () => {
		const { state, p1 } = newGame();
		const cmdCard = card({
			name: 'Sovereign of Scales',
			manaCost: '{4}{R}{R}',
			cmc: 6,
			typeLine: 'Legendary Creature — Dragon',
			oracleText:
				'As long as Sovereign of Scales is in the command zone or on the battlefield, other Dragon spells you cast cost {1} less to cast.',
			power: '6',
			toughness: '6'
		});
		state.nextTimestamp = (state.nextTimestamp || 0) + 1;
		const cmdInst = createCardInstance(cmdCard, p1.playerId, 'command', true, false, state.nextTimestamp);
		p1.command = [cmdInst];

		const otherDragon = put(
			state,
			p1,
			card({
				name: 'Whelp of Scales',
				manaCost: '{3}{R}',
				cmc: 4,
				typeLine: 'Creature — Dragon',
				power: '3',
				toughness: '3'
			}),
			'hand'
		);
		assert.equal(getSpellCostRequirement(p1, otherDragon, state).generic, 2);
		assert.equal(getSpellCostRequirement(p1, cmdInst, state).generic, 4);
	});

	it('dynamic mana ability from IR produces 0 when the counted filter matches nothing', () => {
		const { state, p1 } = newGame();
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		const dork = put(
			state,
			p1,
			card({
				name: 'Choir Channeler',
				typeLine: 'Creature — Human Cleric',
				oracleText: '{T}: Add {G} for each Wizard you control.',
				power: '1',
				toughness: '2'
			}),
			'battlefield'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: dork.instanceId }).ok, true);
		assert.equal(p1.manaPool.G, 0);

		dork.tapped = false;
		put(
			state,
			p1,
			card({ name: 'Study Mage', typeLine: 'Creature — Human Wizard', power: '1', toughness: '1' }),
			'battlefield'
		);
		put(
			state,
			p1,
			card({ name: 'Hall Mage', typeLine: 'Creature — Elf Wizard', power: '1', toughness: '1' }),
			'battlefield'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: dork.instanceId }).ok, true);
		assert.equal(p1.manaPool.G, 2);
	});

	it('bots choose a legal costPayment when casting a spell with a choice or multiple object candidates', () => {
		const { state, p1 } = newGame();
		p1.isBot = true;
		const s = put(state, p1, spell('Bot Bargain', 'sacrifice a creature.'), 'hand');
		const token = put(state, p1, creature('Expendable Token', 1, { cmc: 0 }), 'battlefield');
		token.isToken = true;
		const real = put(state, p1, creature('Valuable Beast', 4, { cmc: 4 }), 'battlefield');
		runAutomatedPriorityAndBots(state);
		assert.equal(inZone(p1, 'hand', s), false, 'bot cast the spell');
		assert.equal(inZone(p1, 'battlefield', real), true, 'bot kept its real creature and sacrificed the token');
	});
});
