import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	canPayOrAutoTap,
	createCardInstance,
	createInitialGameState,
	drawCards,
	runBeginningOfTurn
} from '../engine.ts';
import { subscribeEvents, type GameEvent } from './events.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { parseManaCost } from '../oracle.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `t3a_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{G}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['G'],
		colorIdentity: overrides.colorIdentity ?? ['G'],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
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

function makeSeat(i: number, username: string, isBot = false): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: `player_${i + 1}`,
		username,
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

function createTestGame(bots: [boolean, boolean] = [false, false]): GameState {
	const seats = [makeSeat(0, 'Alice', bots[0]), makeSeat(1, 'Bob', bots[1])];
	const state = createInitialGameState(
		'LOBBY_T3A',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		const wasBot = p.isBot;
		p.isBot = false;
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		p.isBot = wasBot;
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	return state;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library' = 'battlefield'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		player.battlefield.push(inst);
		noteLayerInputsChanged(state);
	} else if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	return inst;
}

describe('Tier 3 Track A — Item 1: Auto-tap emits TappedForMana and resolves triggered mana abilities (CR 106.12, 605.1b, 605.3a, 605.4a)', () => {
	it('with an "add an additional {G}" land-tap trigger on the battlefield, auto-paying a spell yields the extra mana (and manual tap does too; simulate pass does not emit)', () => {
		const state = createTestGame();
		const alice = state.players[0];
		alice.battlefield = [];

		putInZone(
			state,
			alice,
			card({
				name: 'Emerald Reflection',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				typeLine: 'Enchantment',
				oracleText: 'Whenever you tap a land for mana, add an additional {G}.',
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);

		const forest1 = putInZone(
			state,
			alice,
			card({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)',
				colors: [],
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);
		const forest2 = putInZone(
			state,
			alice,
			card({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)',
				colors: [],
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);

		// 1. Planning / simulate pass (canPayOrAutoTap) must not tap lands or emit TappedForMana.
		assert.equal(canPayOrAutoTap(alice, parseManaCost('{G}'), state), true);
		assert.equal(forest1.tapped, false);
		assert.equal(forest2.tapped, false);
		assert.equal(alice.manaPool.G, 0);

		// 2. Manual tap_mana yields {G} from the Forest + {G} from the inline triggered mana ability (CR 605.4a).
		const tapRes = applyGameAction(state, alice.playerId, {
			type: 'tap_mana',
			instanceId: forest1.instanceId
		});
		assert.equal(tapRes.ok, true, tapRes.error ?? '');
		assert.equal(forest1.tapped, true);
		assert.equal(state.stack.length, 0, 'triggered mana ability does not use the stack (CR 605.4a)');
		assert.equal(alice.manaPool.G, 2, 'manual tap added {G} + extra {G}');

		// Reset mana pool to 0 so casting the spell must auto-tap forest2.
		alice.manaPool.G = 0;

		const elf = putInZone(
			state,
			alice,
			card({
				name: 'Canopy Scout',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Elf Scout',
				oracleText: '',
				power: '1',
				toughness: '1'
			}),
			'hand'
		);

		// 3. Auto-paying a {G} spell taps forest2 through the mana-ability funnel, triggers the extra {G} inline,
		// deducts {G} for the spell, and leaves the extra {G} in Alice's mana pool.
		const castRes = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: elf.instanceId
		});
		assert.equal(castRes.ok, true, castRes.error ?? '');
		assert.equal(forest2.tapped, true, 'forest2 was auto-tapped');
		assert.equal(state.stack.length, 1, 'only the spell is on the stack');
		assert.equal(alice.manaPool.G, 1, 'extra {G} from triggered mana ability remains in mana pool after auto-paying {G}');
	});
});

function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && (state.stack.length > 0 || state.pendingPrompts.length > 0); i++) {
		const pr = state.pendingPrompts[0];
		if (pr) {
			if (pr.purpose === 'trigger_order' && pr.choice?.kind === 'orderObjects') {
				const res = applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'orderObjects', topIds: pr.choice.objectIds }
				});
				assert.equal(res.ok, true, res.error ?? '');
				continue;
			}
			break;
		}
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

describe('Tier 3 Track A — Item 2: GainLife, CardDrawn, BecomesTapped events, playersDrawnThisTurn reset, and ETB CounterPlaced (CR 119.9-119.10, 121.2, 122.6, 603.2)', () => {
	it('GainLife event fires once per positive life-gain occurrence with correct amount and player, and gaining 0 life does not trigger (CR 119.9-119.10)', () => {
		const state = createTestGame();
		const [alice, bob] = state.players;
		alice.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		const pridemate = putInZone(
			state,
			alice,
			card({
				name: 'Sunlit Acolyte',
				typeLine: 'Creature — Cat Soldier',
				oracleText: 'Whenever you gain life, put that many +1/+1 counters on ~.'
			}),
			'battlefield'
		);

		const events: GameEvent[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => events.push(ev));

		// 1. Gaining 0 life (X = 0) is not a life-gain event (CR 119.9, 119.10).
		const zeroHeal = putInZone(
			state,
			alice,
			card({
				name: 'Empty Draught',
				manaCost: '{X}{W}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'You gain X life.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: zeroHeal.instanceId,
				xValue: 0
			}).ok,
			true
		);
		settle(state);
		assert.equal(
			events.filter((e) => (e as { kind: string }).kind === 'GainLife').length,
			0,
			'gaining 0 life must not emit GainLife (CR 119.10)'
		);
		assert.equal(pridemate.counters['+1/+1'], 0);

		// 2. Positive life gain emits GainLife with playerId and amount, triggering Sunlit Acolyte with eventAmount = 3.
		const heal3 = putInZone(
			state,
			alice,
			card({
				name: 'vitality Balm',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'You gain 3 life.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: heal3.instanceId
			}).ok,
			true
		);
		settle(state);
		const gainEvents = events.filter((e) => (e as { kind: string }).kind === 'GainLife') as Array<{
			kind: 'GainLife';
			playerId: string;
			amount: number;
		}>;
		assert.equal(gainEvents.length, 1);
		assert.equal(gainEvents[0].playerId, alice.playerId);
		assert.equal(gainEvents[0].amount, 3);
		assert.equal(pridemate.counters['+1/+1'], 3, 'trigger placed 3 +1/+1 counters from eventAmount');

		// 3. Opponent gaining life does not trigger "Whenever you gain life".
		const bobHeal = putInZone(
			state,
			alice,
			card({
				name: 'Alms for the Rival',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Target player gains 2 life.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: bobHeal.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		settle(state);
		assert.equal(pridemate.counters['+1/+1'], 3, 'opponent life gain did not trigger Alice ability');
		unsub();
	});

	it('CardDrawn event fires once per individual card drawn (CR 121.2) and playersDrawnThisTurn resets on turn transition', () => {
		const state = createTestGame();
		const [alice] = state.players;

		putInZone(
			state,
			alice,
			card({
				name: 'Scroll Sage',
				typeLine: 'Creature — Wizard',
				oracleText: 'Whenever you draw a card, you gain 1 life.'
			}),
			'battlefield'
		);

		const events: GameEvent[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => events.push(ev));

		const startLife = alice.life;
		drawCards(state, alice, 3);
		const drawEvs = events.filter((e) => (e as { kind: string }).kind === 'CardDrawn') as Array<{
			kind: 'CardDrawn';
			playerId: string;
		}>;
		assert.equal(drawEvs.length, 3, 'each card drawn is its own CardDrawn event (CR 121.2)');
		assert.ok(drawEvs.every((e) => e.playerId === alice.playerId));
		assert.ok(state.playersDrawnThisTurn?.includes(alice.playerId), 'playersDrawnThisTurn tracks Alice');

		settle(state);
		assert.equal(alice.life, startLife + 3, 'three draw triggers each gained 1 life');

		// Turn transition clears state.playersDrawnThisTurn.
		runBeginningOfTurn(state);
		assert.deepEqual(state.playersDrawnThisTurn, [], 'playersDrawnThisTurn cleared at beginning of turn');
		unsub();
	});

	it('BecomesTapped event fires only when an untapped permanent becomes tapped (CR 603.2e)', () => {
		const state = createTestGame();
		const [alice] = state.players;

		const tapwatcher = putInZone(
			state,
			alice,
			card({
				name: 'Drowsing Druid',
				typeLine: 'Creature — Elf Druid',
				oracleText: 'Whenever ~ becomes tapped, you gain 2 life.\n{T}: Add {G}.'
			}),
			'battlefield'
		);

		const events: GameEvent[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => events.push(ev));
		const startLife = alice.life;

		// 1. Tapping an untapped permanent emits BecomesTapped and triggers Drowsing Druid.
		const tapRes = applyGameAction(state, alice.playerId, {
			type: 'tap_mana',
			instanceId: tapwatcher.instanceId
		});
		assert.equal(tapRes.ok, true, tapRes.error ?? '');
		const tapEvs = events.filter((e) => (e as { kind: string }).kind === 'BecomesTapped');
		assert.equal(tapEvs.length, 1, 'BecomesTapped emitted once');
		assert.equal(state.stack.length, 1, 'BecomesTapped trigger is on the stack');
		settle(state);
		assert.equal(alice.life, startLife + 2);

		// 2. Entering the battlefield tapped does NOT emit BecomesTapped (CR 603.2e).
		const tapland = putInZone(
			state,
			alice,
			card({
				name: 'Tranquil Grove',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText: '~ enters tapped.\n{T}: Add {G}.',
				power: undefined,
				toughness: undefined
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'play_land',
				instanceId: tapland.instanceId
			}).ok,
			true
		);
		assert.equal(tapland.tapped, true);
		assert.equal(
			events.filter((e) => (e as { kind: string }).kind === 'BecomesTapped').length,
			1,
			'entering tapped must not emit BecomesTapped (CR 603.2e)'
		);
		unsub();
	});

	it('ETB-with-counters routes through addCountersToPermanent and emits CounterPlaced (CR 122.6)', () => {
		const state = createTestGame();
		const [alice] = state.players;
		alice.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		const hydra = putInZone(
			state,
			alice,
			card({
				name: 'Runebound Hydra',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Hydra',
				oracleText: '~ enters with two +1/+1 counters on it.\nWhenever a +1/+1 counter is put on ~, draw a card.',
				power: '0',
				toughness: '0'
			}),
			'hand'
		);

		const events: GameEvent[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => events.push(ev));
		const handBefore = alice.hand.length - 1; // minus hydra being cast

		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: hydra.instanceId
			}).ok,
			true
		);
		// Resolve Runebound Hydra onto the battlefield.
		assert.equal(applyGameAction(state, alice.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' }).ok, true);

		const counterEvs = events.filter((e) => e.kind === 'CounterPlaced');
		assert.equal(counterEvs.length, 1, 'ETB counters emitted CounterPlaced (CR 122.6)');
		assert.equal(counterEvs[0].amount, 2);
		assert.equal(
			state.stack.some((s) => s.kind === 'triggered' && s.title.includes('Runebound Hydra')),
			true,
			'CounterPlaced trigger went on the stack on ETB'
		);
		settle(state);
		assert.equal(alice.hand.length, handBefore + 1, 'trigger resolved and drew a card');
		unsub();
	});
});

describe('Tier 3 Track A — Item 3: Compiler grammar and runtime for fight, tap, untap, tapOrUntap, and copySpell (CR 701.14, 701.26, 707.10)', () => {
	it('compiles and resolves fight spells/abilities, enforcing CR 701.14a-d (mutual non-combat damage, missing/non-creature no-op, self-fight 2x power)', () => {
		const state = createTestGame();
		const [alice, bob] = state.players;
		alice.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		const bearA = putInZone(
			state,
			alice,
			card({
				name: 'Grizzly Fighter',
				typeLine: 'Creature — Bear',
				power: '3',
				toughness: '4',
				oracleText: ''
			}),
			'battlefield'
		);
		const wolfB = putInZone(
			state,
			bob,
			card({
				name: 'Timber Opponent',
				typeLine: 'Creature — Wolf',
				power: '2',
				toughness: '5',
				oracleText: ''
			}),
			'battlefield'
		);

		const events: GameEvent[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => events.push(ev));

		// 1. "Target creature you control fights target creature you don't control." (CR 701.14a, 701.14d)
		const preySpell = putInZone(
			state,
			alice,
			card({
				name: 'Savage Duel',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: "Target creature you control fights target creature you don't control."
			}),
			'hand'
		);
		const cast1 = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: preySpell.instanceId,
			targets: [
				{ kind: 'permanent', id: bearA.instanceId, label: bearA.card.name },
				{ kind: 'permanent', id: wolfB.instanceId, label: wolfB.card.name }
			]
		});
		assert.equal(cast1.ok, true, cast1.error ?? '');
		settle(state);

		assert.equal(bearA.damageMarked, 2, 'bearA took 2 fight damage from wolfB');
		assert.equal(wolfB.damageMarked, 3, 'wolfB took 3 fight damage from bearA');
		const dmgEvents = events.filter((e) => e.kind === 'DamageDealt') as Array<
			Extract<GameEvent, { kind: 'DamageDealt' }>
		>;
		assert.equal(dmgEvents.length, 2, 'two DamageDealt events emitted');
		assert.ok(dmgEvents.every((e) => e.combat === false), 'fight damage is not combat damage (CR 701.14d)');

		// 2. CR 701.14b: If either creature is no longer on the battlefield (or illegal target), neither deals damage.
		bearA.damageMarked = 0;
		wolfB.damageMarked = 0;
		const preySpell2 = putInZone(
			state,
			alice,
			card({
				name: 'Interrupted Duel',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: "Target creature you control fights target creature you don't control."
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: preySpell2.instanceId,
				targets: [
					{ kind: 'permanent', id: bearA.instanceId, label: bearA.card.name },
					{ kind: 'permanent', id: wolfB.instanceId, label: wolfB.card.name }
				]
			}).ok,
			true
		);
		// Remove wolfB from the battlefield before resolution.
		bob.battlefield = bob.battlefield.filter((c) => c.instanceId !== wolfB.instanceId);
		wolfB.zone = 'exile';
		bob.exile.push(wolfB);
		settle(state);
		assert.equal(bearA.damageMarked, 0, 'neither creature dealt damage when one left the battlefield (CR 701.14b)');

		// 3. CR 701.14c: Fighting itself deals damage to itself equal to twice its power.
		const brawler = putInZone(
			state,
			alice,
			card({
				name: 'Mirror Brawler',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Beast',
				power: '2',
				toughness: '6',
				oracleText: '{G}: ~ fights target creature.'
			}),
			'battlefield'
		);
		const actSelfFight = applyGameAction(state, alice.playerId, {
			type: 'activate_ability',
			instanceId: brawler.instanceId,
			abilityId: 'act_0',
			targets: [{ kind: 'permanent', id: brawler.instanceId, label: brawler.card.name }]
		});
		assert.equal(actSelfFight.ok, true, actSelfFight.error ?? '');
		settle(state);
		assert.equal(brawler.damageMarked, 4, 'fighting itself deals 2x power damage to itself (CR 701.14c)');
		unsub();
	});

	it('compiles and resolves tap, untap, and tapOrUntap effects (CR 701.26)', () => {
		const state = createTestGame();
		const [alice, bob] = state.players;
		alice.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		const bobCreature = putInZone(
			state,
			bob,
			card({
				name: 'Enemy Guard',
				typeLine: 'Creature — Soldier',
				power: '2',
				toughness: '2',
				oracleText: ''
			}),
			'battlefield'
		);

		const tapSpell = putInZone(
			state,
			alice,
			card({
				name: 'Icy Blast',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Tap target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: tapSpell.instanceId,
				targets: [{ kind: 'permanent', id: bobCreature.instanceId, label: bobCreature.card.name }]
			}).ok,
			true
		);
		settle(state);
		assert.equal(bobCreature.tapped, true, 'Tap target creature tapped bobCreature');

		const untapSpell = putInZone(
			state,
			alice,
			card({
				name: 'Renewing Breeze',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Untap target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: untapSpell.instanceId,
				targets: [{ kind: 'permanent', id: bobCreature.instanceId, label: bobCreature.card.name }]
			}).ok,
			true
		);
		settle(state);
		assert.equal(bobCreature.tapped, false, 'Untap target creature untapped bobCreature');

		const twiddle = putInZone(
			state,
			alice,
			card({
				name: 'Arcane Twiddle',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Tap or untap target permanent.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: twiddle.instanceId,
				targets: [{ kind: 'permanent', id: bobCreature.instanceId, label: bobCreature.card.name }]
			}).ok,
			true
		);
		settle(state);
		assert.equal(bobCreature.tapped, true, 'Tap or untap target permanent tapped an untapped permanent');
	});

	it('compiles and resolves copySpell on the stack, emitting SpellCopied (CR 707.10)', () => {
		const state = createTestGame();
		const [alice] = state.players;
		alice.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		const events: GameEvent[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => events.push(ev));

		const salve = putInZone(
			state,
			alice,
			card({
				name: 'Sun Nectar',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'You gain 3 life.'
			}),
			'hand'
		);
		const fork = putInZone(
			state,
			alice,
			card({
				name: 'Echo Cast',
				manaCost: '{U}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Copy target instant or sorcery spell.'
			}),
			'hand'
		);

		const startLife = alice.life;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: salve.instanceId
			}).ok,
			true
		);
		const origStackId = state.stack[0].id;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: fork.instanceId,
				targets: [{ kind: 'stack', id: origStackId, label: salve.card.name }]
			}).ok,
			true
		);
		settle(state);

		assert.equal(
			events.filter((e) => e.kind === 'SpellCopied').length,
			1,
			'SpellCopied emitted when copySpell resolves (CR 707.10)'
		);
		assert.equal(alice.life, startLife + 6, 'both the copied spell and the original spell resolved (+6 life total)');
		unsub();
	});
});
