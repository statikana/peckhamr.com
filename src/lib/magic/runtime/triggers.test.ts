import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	enterEndStep,
	getEffectiveActivatedAbilities,
	runBeginningOfTurn
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { emitEvent } from './events.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

/**
 * Phase 5: triggered abilities matched from the IR via the event bus (runtime/triggers.ts).
 * Each "bug" test below was written to fail on the pre-Phase-5 engine.
 */

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
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

function staple(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	assert.ok(c, `missing staple ${name}`);
	return c;
}

function seat(i: number, id: string, username: string): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: id,
		username,
		avatarUrl: '',
		isBot: false,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: deck.colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: Date.now()
	};
}

function game(players = 2): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i]));
	const state = createInitialGameState(
		'LOBBY_T',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const s of seats) assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	return { state, p: state.players };
}

function put(state: GameState, player: PlayerGameState, c: ScryfallCard, zone: 'hand' | 'battlefield' | 'graveyard' | 'library'): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		if (c.loyalty) inst.counters.loyalty = parseInt(c.loyalty, 10);
	}
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

/** Both players pass priority until the stack is empty (at most `max` rounds). */
function resolveStack(state: GameState, max = 10): void {
	for (let i = 0; i < max && state.stack.length > 0; i++) {
		for (const pl of [...state.players]) {
			const prio = state.players[state.priorityPlayerIndex];
			applyGameAction(state, prio.playerId, { type: 'pass_priority' });
			if (state.stack.length === 0) return;
			void pl;
		}
	}
}

function cast(state: GameState, player: PlayerGameState, inst: CardInstance, targets: Array<{ kind: 'permanent' | 'player'; id: string; label: string }> = []): void {
	const res = applyGameAction(state, player.playerId, { type: 'cast_spell', instanceId: inst.instanceId, targets });
	assert.equal(res.ok, true, res.error ?? '');
}

/** From main1 with an empty stack, move to declare attackers and attack with `attackers`. */
function attack(state: GameState, attacker: PlayerGameState, defender: PlayerGameState, attackers: CardInstance[], planeswalker?: CardInstance): void {
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) applyGameAction(state, pl.playerId, { type: 'pass_priority' });
	assert.equal(state.phase, 'begin_combat');
	for (const pl of state.players) applyGameAction(state, pl.playerId, { type: 'pass_priority' });
	assert.equal(state.phase, 'declare_attackers');
	const res = applyGameAction(state, attacker.playerId, {
		type: 'declare_attackers',
		assignments: attackers.map((a) => ({
			attackerInstanceId: a.instanceId,
			defenderPlayerId: defender.playerId,
			defenderPlaneswalkerId: planeswalker?.instanceId ?? null
		}))
	});
	assert.equal(res.ok, true, res.error ?? '');
	for (const pl of state.players) applyGameAction(state, pl.playerId, { type: 'pass_priority' });
}

/** From declare_blockers: declare `blocks` for the defender, then pass through combat damage. */
function blockAndDealDamage(state: GameState, defender: PlayerGameState, blocks: Array<[CardInstance, CardInstance]> = []): void {
	assert.equal(state.phase, 'declare_blockers');
	const res = applyGameAction(state, defender.playerId, {
		type: 'declare_blockers',
		assignments: blocks.map(([b, a]) => ({ blockerInstanceId: b.instanceId, attackerInstanceId: a.instanceId }))
	});
	assert.equal(res.ok, true, res.error ?? '');
	for (let i = 0; i < 10 && (state.phase as GameState['phase']) !== 'main2' && (state.phase as GameState['phase']) !== 'end_step'; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		applyGameAction(state, prio.playerId, { type: 'pass_priority' });
	}
}

/** A resolving permanent spell becomes a new object (engine.ts createCardInstance); find it by name. */
function onBattlefield(pl: PlayerGameState, name: string): CardInstance {
	const found = pl.battlefield.find((c) => c.card.name === name);
	assert.ok(found, `${name} is on the battlefield`);
	return found;
}

const treasures = (pl: PlayerGameState) => pl.battlefield.filter((c) => c.card.name === 'Treasure').length;

describe('Phase 5 bug: created tokens fire ETB triggers', () => {
	it('a creature token fires an observer ETB trigger, and a land token fires Landfall', () => {
		const { state, p } = game();
		const keeper = put(state, p[0], card({
			name: 'Hearth Keeper',
			typeLine: 'Creature — Human',
			oracleText: 'Whenever another creature you control enters, put a +1/+1 counter on Hearth Keeper.',
			power: '1',
			toughness: '1'
		}), 'battlefield');
		put(state, p[0], card({
			name: 'Root Listener',
			typeLine: 'Creature — Elf',
			oracleText: 'Landfall — Whenever a land you control enters, proliferate.',
			power: '1',
			toughness: '1'
		}), 'battlefield');

		createTokenOnBoard(state, p[0], { name: 'Saproling', power: 1, toughness: 1, colors: ['G'], typeLine: 'Token Creature — Saproling', keywords: [] });
		assert.equal(keeper.counters['+1/+1'], 1, 'observer ETB fired for the creature token');

		createTokenOnBoard(state, p[0], { name: 'Wastes Token', power: 0, toughness: 0, colors: [], typeLine: 'Token Land', keywords: [] });
		assert.equal(keeper.counters['+1/+1'], 2, 'Landfall (proliferate) fired for the land token');
	});
});

describe('Phase 5 bug: "or" triggers fire on every listed event', () => {
	it('"enters or attacks" fires on attack too', () => {
		const { state, p } = game();
		const raider = put(state, p[0], card({
			name: 'Gilded Raider',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Creature — Human',
			oracleText: 'Whenever Gilded Raider enters or attacks, create a Treasure token.',
			power: '2',
			toughness: '2'
		}), 'hand');
		cast(state, p[0], raider);
		resolveStack(state);
		assert.equal(treasures(p[0]), 1, 'enters');
		const onField = onBattlefield(p[0], 'Gilded Raider');
		onField.summoningSick = false;
		attack(state, p[0], p[1], [onField]);
		assert.equal(treasures(p[0]), 2, 'attacks');
	});

	it('"enters or dies" fires on death too', () => {
		const { state, p } = game();
		const moa = put(state, p[0], card({
			name: 'Grave Moa',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Creature — Bird',
			oracleText: 'When Grave Moa enters or dies, create a Treasure token.',
			power: '2',
			toughness: '2'
		}), 'hand');
		cast(state, p[0], moa);
		resolveStack(state);
		assert.equal(treasures(p[0]), 1, 'enters');
		const onField = onBattlefield(p[0], 'Grave Moa');
		const bolt = put(state, p[0], staple('Lightning Bolt'), 'hand');
		cast(state, p[0], bolt, [{ kind: 'permanent', id: onField.instanceId, label: onField.card.name }]);
		resolveStack(state);
		assert.ok(p[0].graveyard.some((c) => c.card.name === 'Grave Moa'), 'Moa died');
		assert.equal(treasures(p[0]), 2, 'dies');
	});

	it('"attacks or blocks" fires on block too', () => {
		const { state, p } = game();
		const brawler = put(state, p[1], card({
			name: 'Pit Brawler',
			typeLine: 'Creature — Zombie',
			oracleText: 'Whenever Pit Brawler attacks or blocks, you gain 3 life.',
			power: '2',
			toughness: '5'
		}), 'battlefield');
		const bear = put(state, p[0], card({ name: 'Plain Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }), 'battlefield');
		const lifeBefore = p[1].life;
		attack(state, p[0], p[1], [bear]);
		blockAndDealDamage(state, p[1], [[brawler, bear]]);
		assert.equal(p[1].life, lifeBefore + 3, 'block trigger gained 3 life');
	});
});

describe('Phase 5 bug: "cast or copy" triggers on copies', () => {
	it('a copied instant triggers Archmage Emeritus (and Veyran doubles it)', async () => {
		const { state, p } = game();
		put(state, p[0], staple('Archmage Emeritus'), 'battlefield');
		put(state, p[0], staple('Veyran, Voice of Duality'), 'battlefield');
		const spell = createCardInstance(staple('Lightning Bolt'), p[0].playerId, 'stack', false, false, 1);
		const handBefore = p[0].hand.length;
		emitEvent(state, { kind: 'SpellCopied', playerId: p[0].playerId, objectId: spell.instanceId, object: spell } as never);
		const { flushTriggers } = await import('./triggers.ts');
		flushTriggers(state);
		assert.equal(p[0].hand.length, handBefore + 2, 'Archmage drew twice for one copy (Veyran)');
	});
});

describe('Phase 5 bug: combat damage to a planeswalker', () => {
	const walker = () =>
		card({ name: 'Testwalker', typeLine: 'Legendary Planeswalker — Test', loyalty: '5', manaCost: '{3}', cmc: 3 });

	it('Grateful Apparition proliferates after damaging a planeswalker, which loses loyalty instead of its controller losing life', () => {
		const { state, p } = game();
		const apparition = put(state, p[0], staple('Grateful Apparition'), 'battlefield');
		const counted = put(state, p[0], card({ name: 'Counted Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }), 'battlefield');
		counted.counters['+1/+1'] = 1;
		const pw = put(state, p[1], walker(), 'battlefield');
		const lifeBefore = p[1].life;
		attack(state, p[0], p[1], [apparition], pw);
		blockAndDealDamage(state, p[1]);
		assert.equal(pw.counters.loyalty, 4, 'planeswalker was dealt 1 damage');
		assert.equal(p[1].life, lifeBefore, 'its controller lost no life');
		assert.equal(counted.counters['+1/+1'], 2, 'proliferated');
	});

	it('a "combat damage to a player" trigger does not fire for damage to a planeswalker', () => {
		const { state, p } = game();
		const raider = put(state, p[0], card({
			name: 'Courier Hawk',
			typeLine: 'Creature — Bird',
			oracleText: 'Whenever Courier Hawk deals combat damage to a player, create a Treasure token.',
			power: '1',
			toughness: '1'
		}), 'battlefield');
		const pw = put(state, p[1], walker(), 'battlefield');
		attack(state, p[0], p[1], [raider], pw);
		blockAndDealDamage(state, p[1]);
		assert.equal(pw.counters.loyalty, 4);
		assert.equal(treasures(p[0]), 0);
	});
});

describe('Phase 5 bug: Goldspan Dragon "or becomes the target of a spell"', () => {
	it('creates a Treasure when targeted by a spell', () => {
		const { state, p } = game();
		const goldspan = put(state, p[0], staple('Goldspan Dragon'), 'battlefield');
		const pump = put(state, p[0], card({ name: 'Quick Surge', manaCost: '{G}', typeLine: 'Instant', oracleText: 'Target creature gets +3/+3 until end of turn.' }), 'hand');
		cast(state, p[0], pump, [{ kind: 'permanent', id: goldspan.instanceId, label: goldspan.card.name }]);
		assert.equal(treasures(p[0]), 1);
	});
});

describe('Phase 5 bug: unsupported qualifiers never fire', () => {
	const cases: Array<[string, string]> = [
		['Saddle Runner', 'Whenever Saddle Runner attacks while saddled, draw a card.'],
		['Unseen Courier', "Whenever Unseen Courier attacks and isn't blocked, draw a card."],
		['Player Hunter', 'Whenever Player Hunter attacks a player, draw a card.']
	];
	for (const [name, text] of cases) {
		it(text, () => {
			const { state, p } = game();
			const c = card({ name, typeLine: 'Creature — Human', oracleText: text, power: '1', toughness: '1' });
			assert.ok(
				compileCard(c).faces[0].abilities.some((a) => a.kind === 'unsupported'),
				'the ability is marked unsupported'
			);
			const inst = put(state, p[0], c, 'battlefield');
			const handBefore = p[0].hand.length;
			attack(state, p[0], p[1], [inst]);
			blockAndDealDamage(state, p[1]);
			assert.equal(p[0].hand.length, handBefore, 'did not draw');
		});
	}

	it('When ~ enters untapped, draw a card.', () => {
		const { state, p } = game();
		const c = card({ name: 'Quiet Grange', typeLine: 'Land', manaCost: '', cmc: 0, oracleText: 'When Quiet Grange enters untapped, draw a card.' });
		assert.ok(compileCard(c).faces[0].abilities.some((a) => a.kind === 'unsupported'));
		const inst = put(state, p[0], c, 'hand');
		const handBefore = p[0].hand.length;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'play_land', instanceId: inst.instanceId }).ok, true);
		assert.equal(p[0].hand.length, handBefore - 1, 'did not draw');
	});

	it('a cast trigger with an unmodelled intervening-if does not fire', () => {
		const { state, p } = game();
		const c = card({
			name: 'Tide Sage',
			typeLine: 'Creature — Merfolk',
			oracleText: 'Whenever you cast a noncreature spell, if at least four mana was spent to cast it, draw a card.',
			power: '1',
			toughness: '3'
		});
		assert.ok(compileCard(c).faces[0].abilities.some((a) => a.kind === 'unsupported'));
		put(state, p[0], c, 'battlefield');
		const spell = put(state, p[0], card({ name: 'Small Thought', manaCost: '{U}', typeLine: 'Instant', oracleText: 'You gain 1 life.' }), 'hand');
		const handBefore = p[0].hand.length;
		cast(state, p[0], spell);
		assert.equal(p[0].hand.length, handBefore - 1, 'did not draw');
	});
});

describe('Phase 5 bug: lines matched to the wrong event', () => {
	const nantuko = () =>
		card({
			name: 'Springheart Nantuko',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Enchantment Creature — Insect Monk',
			oracleText:
				"Bestow {1}{G}\nEnchanted creature gets +1/+1.\nLandfall — Whenever a land you control enters, you may pay {1}{G} if this permanent is attached to a creature you control. If you do, create a token that's a copy of that creature. If you didn't create a token this way, create a 1/1 green Insect creature token.",
			power: '1',
			toughness: '1'
		});

	it("Springheart Nantuko's Landfall line is a Landfall trigger, not an attach trigger", () => {
		const { state, p } = game();
		put(state, p[0], nantuko(), 'battlefield');
		const boots = put(state, p[0], staple('Swiftfoot Boots'), 'battlefield');
		const bear = put(state, p[0], card({ name: 'Plain Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }), 'battlefield');
		const tokens = () => p[0].battlefield.filter((c) => c.isToken).length;
		const equip = getEffectiveActivatedAbilities(state, p[0], boots).find((a) => /equip/i.test(a.label))!;
		assert.equal(
			applyGameAction(state, p[0].playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: equip.id,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(boots.attachedToId, bear.instanceId);
		assert.equal(tokens(), 0, 'attaching an Equipment does not trigger the Landfall line');
		const forest = put(state, p[0], staple('Forest'), 'hand');
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'play_land', instanceId: forest.instanceId }).ok, true);
		assert.equal(tokens(), 1, 'a land entering does');
	});

	it("Sanguine Soothsayer's attack trigger does not fire when it enters", () => {
		const { state, p } = game();
		const c = card({
			name: 'Sanguine Soothsayer',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Bat Cleric',
			oracleText:
				'Flying, lifelink\nWhenever this creature attacks, conjure a card named Sanguine Bond into the top fifteen cards of your library at random. It perpetually gains "You may pay {0} rather than pay this spell\'s mana cost" and "When this permanent enters, draw a card."',
			power: '2',
			toughness: '2'
		});
		const inst = put(state, p[0], c, 'hand');
		const handBefore = p[0].hand.length;
		cast(state, p[0], inst);
		resolveStack(state);
		onBattlefield(p[0], 'Sanguine Soothsayer');
		assert.equal(p[0].hand.length, handBefore - 1, 'no card drawn on entering');
	});
});

describe('Phase 5 rules: APNAP ordering, intervening-if, LKI look-back, graveyard triggers, and flush ordering', () => {
	it('puts simultaneous beginning-of-end-step triggers on the stack in APNAP order (CR 603.3b) so non-active resolves first', () => {
		const { state, p } = game(3);
		const endWatcher = (name: string) =>
			card({
				name,
				typeLine: 'Enchantment',
				oracleText: 'At the beginning of each end step, you gain 1 life.'
			});
		put(state, p[0], endWatcher('Alice Bell'), 'battlefield');
		put(state, p[1], endWatcher('Bob Bell'), 'battlefield');
		put(state, p[2], endWatcher('Carol Bell'), 'battlefield');

		// Make Bob (seat 1) the active player -> APNAP order is Bob (p[1]), Carol (p[2]), Alice (p[0])
		state.activePlayerIndex = 1;
		enterEndStep(state, p[1]);

		assert.deepEqual(
			state.stack.map((item) => item.controllerId),
			[p[1].playerId, p[2].playerId, p[0].playerId],
			'stack bottom-to-top is APNAP: Bob, Carol, Alice (so Alice resolves first)'
		);
	});

	it('resolves simultaneous inline triggers in reverse APNAP order (non-active first, active last)', () => {
		const { state, p } = game(2);
		put(
			state,
			p[0],
			card({
				name: 'Alice Witness',
				typeLine: 'Creature — Human',
				oracleText: 'Whenever a player casts a spell, you gain 1 life.',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		put(
			state,
			p[1],
			card({
				name: 'Bob Witness',
				typeLine: 'Creature — Human',
				oracleText: 'Whenever a player casts a spell, you gain 1 life.',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const logBefore = state.log.length;
		const cantrip = put(
			state,
			p[0],
			card({ name: 'Minor Spark', manaCost: '{R}', typeLine: 'Instant', oracleText: 'You gain 1 life.' }),
			'hand'
		);
		cast(state, p[0], cantrip);
		const trigLogs = state.log.slice(logBefore).filter((l) => l.kind === 'trigger');
		assert.equal(trigLogs.length, 2);
		assert.ok(trigLogs[0].text.includes('Bob Witness'), 'non-active player trigger resolved first');
		assert.ok(trigLogs[1].text.includes('Alice Witness'), 'active player trigger resolved second');
	});

	it('checks intervening-if at trigger time and again on resolution (CR 603.4)', () => {
		const { state, p } = game();
		put(state, p[0], staple('Felidar Sovereign'), 'battlefield');
		p[0].life = 30;
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 0, 'does not trigger at 30 life');

		p[0].life = 40;
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 1, 'triggers at 40 life');
		p[0].life = 39;
		resolveStack(state);
		assert.equal(state.status, 'active', 'does not win when life drops below 40 before resolution');
	});

	it('uses leaves-the-battlefield look-back (CR 603.10a) for Clone and Humility on dies triggers', () => {
		const { state, p } = game();
		const martyr = put(
			state,
			p[0],
			card({
				name: 'Coin Martyr',
				typeLine: 'Creature — Human',
				oracleText: 'When Coin Martyr dies, create a Treasure token.',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const clone = put(state, p[0], staple('Clone'), 'hand');
		cast(state, p[0], clone, [{ kind: 'permanent', id: martyr.instanceId, label: martyr.card.name }]);
		resolveStack(state);
		const cloneOnField = p[0].battlefield.find((c) => c.instanceId === clone.instanceId)!;
		assert.ok(cloneOnField, 'Clone is on battlefield');

		// Kill the Clone -> its LKI copiableCard is Coin Martyr, so its dies trigger creates a Treasure
		const bolt1 = put(state, p[0], staple('Lightning Bolt'), 'hand');
		cast(state, p[0], bolt1, [{ kind: 'permanent', id: cloneOnField.instanceId, label: cloneOnField.card.name }]);
		resolveStack(state);
		assert.equal(treasures(p[0]), 1, 'Clone fired copied dies trigger via LKI look-back');

		// Now put Humility on the battlefield and kill the original Coin Martyr -> no Treasure
		put(state, p[0], staple('Humility'), 'battlefield');
		const bolt2 = put(state, p[0], staple('Lightning Bolt'), 'hand');
		cast(state, p[0], bolt2, [{ kind: 'permanent', id: martyr.instanceId, label: martyr.card.name }]);
		resolveStack(state);
		assert.equal(treasures(p[0]), 1, 'Humility stripped abilities in LKI, so dies trigger did not fire');
	});

	it('matches graveyard fromZone triggers (Nether Shadow, CR 404.2)', () => {
		const { state, p } = game();
		p[0].graveyard = [];
		const shadow = put(state, p[0], staple('Nether Shadow'), 'graveyard');
		const bear = (i: number) =>
			card({ name: `Grave Bear ${i}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' });
		put(state, p[0], bear(1), 'graveyard');
		put(state, p[0], bear(2), 'graveyard');

		runBeginningOfTurn(state);
		assert.ok(p[0].graveyard.some((c) => c.instanceId === shadow.instanceId), 'stays in graveyard with only 2 creatures above');

		put(state, p[0], bear(3), 'graveyard');
		runBeginningOfTurn(state);
		assert.ok(p[0].battlefield.some((c) => c.instanceId === shadow.instanceId), 'returns to battlefield with 3 creatures above');
	});

	it('pins ZoneChange flush ordering: land play increments landsPlayedThisTurn and logs before Landfall triggers, and elimination control transfer fires no ETB', () => {
		const { state, p } = game(3);
		put(
			state,
			p[0],
			card({
				name: 'Moss Watcher',
				typeLine: 'Creature — Elf',
				oracleText: 'Landfall — Whenever a land you control enters, you gain 1 life.',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const forest = put(state, p[0], staple('Forest'), 'hand');
		const logStart = state.log.length;
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'play_land', instanceId: forest.instanceId }).ok, true);
		assert.equal(p[0].landsPlayedThisTurn, 1);
		const newLogs = state.log.slice(logStart);
		const playIdx = newLogs.findIndex((l) => l.text.includes('played Forest'));
		const trigIdx = newLogs.findIndex((l) => l.kind === 'trigger');
		assert.ok(playIdx >= 0 && trigIdx > playIdx, 'land play log precedes Landfall trigger log');

		// Stolen land returning to Alice when Bob is eliminated is a control transfer, not a ZoneChange
		const stolenLand = put(state, p[1], staple('Plains'), 'battlefield');
		stolenLand.ownerId = p[0].playerId;
		stolenLand.controllerId = p[1].playerId;
		const lifeBefore = p[0].life;
		p[1].life = 0;
		checkStateBasedActions(state);
		assert.equal(p[1].lost, true);
		assert.ok(p[0].battlefield.some((c) => c.instanceId === stolenLand.instanceId), 'stolen land returned to owner');
		assert.equal(p[0].life, lifeBefore, 'control transfer on elimination did not fire Landfall');
	});
});
