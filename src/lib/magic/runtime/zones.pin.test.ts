import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction as rawApplyGameAction,
	checkStateBasedActions as rawCheckStateBasedActions,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard as rawCreateTokenOnBoard,
	drawCards as rawDrawCards,
	getEffectiveActivatedAbilities,
	movePermanentToZone as rawMovePermanentToZone,
	resolveTopOfStack as rawResolveTopOfStack
} from '../engine.ts';
import { subscribeEvents, type GameEvent } from './events.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type ParsedEffect,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

/**
 * Behaviour pins for zone changes (Phase 2).
 *
 * Every zone-change site in the engine has its own bookkeeping: some bump objectVersion and assign a
 * new timestamp, some do only one, some neither; some put cards on top of the library and some on
 * the bottom. These tests pin each site's current behaviour so the move to a single moveObject()
 * can't silently unify them. Several pinned behaviours are probably rules bugs (listed in the
 * Phase 2 notes of ENGINE_ARCHITECTURE_PLAN.md); fixing one should update its pin deliberately.
 *
 * Every engine entry point used here is wrapped in `checkZoneChanges`, so each pinned site is also
 * checked for emitting exactly one ZoneChange per zone change.
 */

/** Where every object is right now: instanceId -> zone ('stack' for spells on the stack). */
function locate(state: GameState): Map<string, string> {
	const where = new Map<string, string>();
	const add = (id: string, zone: string) => {
		assert.ok(!where.has(id), `object ${id} is in two places (${where.get(id)} and ${zone})`);
		where.set(id, zone);
	};
	for (const p of state.players) {
		for (const z of ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'] as const) {
			for (const c of p[z]) add(c.instanceId, z);
		}
	}
	for (const item of state.stack) {
		if (item.kind === 'spell' && !item.isCopy) add(item.sourceInstanceId, 'stack');
	}
	return where;
}

/**
 * Runs `fn`, replaying its ZoneChange events against a model of where every object was before it
 * ran. Fails unless the replayed model matches the real state afterwards: a zone change without an
 * event, or an event without a zone change, both show up.
 */
function checkZoneChanges<T>(state: GameState, fn: () => T): T {
	const model = locate(state);
	const unsubscribe = subscribeEvents(state, (_s, ev) => {
		if (ev.kind !== 'ZoneChange') return;
		assert.equal(model.get(ev.objectId) ?? null, ev.from, `${ev.object.card.name} left ${ev.from}?`);
		if (ev.ceasedToExist) model.delete(ev.objectId);
		else model.set(ev.objectId, ev.to);
	});
	try {
		const result = fn();
		assert.deepEqual(locate(state), model, 'zone changes and ZoneChange events disagree');
		return result;
	} finally {
		unsubscribe();
	}
}

const applyGameAction: typeof rawApplyGameAction = (state, actorId, action) =>
	checkZoneChanges(state, () => rawApplyGameAction(state, actorId, action));
const checkStateBasedActions: typeof rawCheckStateBasedActions = (state) =>
	checkZoneChanges(state, () => rawCheckStateBasedActions(state));
const createTokenOnBoard: typeof rawCreateTokenOnBoard = (state, controller, spec) =>
	checkZoneChanges(state, () => rawCreateTokenOnBoard(state, controller, spec));
const drawCards: typeof rawDrawCards = (state, player, count) =>
	checkZoneChanges(state, () => rawDrawCards(state, player, count));
const movePermanentToZone: typeof rawMovePermanentToZone = (state, inst, dest) =>
	checkZoneChanges(state, () => rawMovePermanentToZone(state, inst, dest));
const resolveTopOfStack: typeof rawResolveTopOfStack = (state) =>
	checkZoneChanges(state, () => rawResolveTopOfStack(state));

function staple(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	assert.ok(c, `missing staple ${name}`);
	return c;
}

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `pin_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Instant',
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

const LAND = (name = 'Pin Land') => card({ name, typeLine: 'Land', manaCost: '', cmc: 0 });
const BEAR = (name = 'Pin Bear') =>
	card({ name, typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2' });

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

function newGame(players = 2): { state: GameState; p1: PlayerGameState; p2: PlayerGameState } {
	const seats = Array.from({ length: players }, (_, i) => seat(i, false));
	const state = createInitialGameState(
		'PIN',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	assert.equal(state.status, 'active');
	for (const p of state.players) p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	return { state, p1: state.players[0], p2: state.players[1] };
}

function put(
	state: GameState,
	p: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command' | 'library',
	atStart = false
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, p.playerId, zone, false, false, state.nextTimestamp);
	if (atStart) p[zone].unshift(inst);
	else p[zone].push(inst);
	return inst;
}

/** Records the bookkeeping fields of an object so a test can compare before/after. */
function marks(c: CardInstance) {
	return { v: c.objectVersion ?? 1, ts: c.enteredTimestamp };
}

function resolveEffects(
	state: GameState,
	controller: PlayerGameState,
	effects: ParsedEffect[],
	opts: { targets?: TargetRef[]; oracleText?: string; sourceInstanceId?: string } = {}
): void {
	state.stack.push({
		id: `stk_pin_${state.stack.length}`,
		sourceInstanceId: opts.sourceInstanceId ?? 'pin_source',
		card: card({ name: 'Pin Source', oracleText: opts.oracleText ?? '' }),
		controllerId: controller.playerId,
		kind: 'triggered',
		title: 'Pin Source',
		oracleText: opts.oracleText ?? '',
		targets: opts.targets ?? [],
		xValue: 0,
		parsedEffects: effects,
		requiresGuidedResolution: false,
		createdAt: 0
	});
	resolveTopOfStack(state);
}

const ids = (cs: CardInstance[]) => cs.map((c) => c.instanceId);

describe('Zone-change behaviour pins: draw, land, cast, suspend', () => {
	it('draw: library top -> end of hand, version +1, new timestamp', () => {
		const { state, p1 } = newGame();
		const top = p1.library[0];
		const before = marks(top);
		drawCards(state, p1, 1);
		assert.equal(p1.hand[p1.hand.length - 1], top);
		assert.equal(top.zone, 'hand');
		assert.equal(top.objectVersion, before.v + 1);
		assert.equal(top.enteredTimestamp, state.nextTimestamp);
	});

	it('play_land from hand: end of battlefield, version +1, new timestamp, untapped', () => {
		const { state, p1 } = newGame();
		const land = put(state, p1, LAND(), 'hand');
		const before = marks(land);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: land.instanceId }).ok, true);
		assert.equal(p1.battlefield[p1.battlefield.length - 1], land);
		assert.ok(!p1.hand.includes(land));
		assert.equal(land.zone, 'battlefield');
		assert.equal(land.objectVersion, before.v + 1);
		assert.notEqual(land.enteredTimestamp, before.ts);
		assert.equal(land.tapped, false);
	});

	it('cast_spell from hand: leaves hand, zone "stack", version +1, StackItem records the new version', () => {
		const { state, p1 } = newGame();
		const spell = put(state, p1, card({ name: 'Pin Draw', typeLine: 'Sorcery', oracleText: 'Draw a card.' }), 'hand');
		const before = marks(spell);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		assert.ok(!p1.hand.includes(spell));
		assert.equal(spell.zone, 'stack');
		assert.equal(spell.objectVersion, before.v + 1);
		assert.notEqual(spell.enteredTimestamp, before.ts);
		assert.equal(state.stack[state.stack.length - 1].sourceObjectVersion, before.v + 1);
	});

	it('additional-cost discard: hand -> graveyard (exile under Rest in Peace), version +1, new timestamp', () => {
		for (const rip of [false, true]) {
			const { state, p1 } = newGame();
			if (rip) put(state, p1, staple('Rest in Peace'), 'battlefield');
			p1.hand = [];
			const spell = put(
				state,
				p1,
				card({ name: 'Pin Discard Spell', typeLine: 'Sorcery', oracleText: 'As an additional cost to cast this spell, discard a card.\nDraw two cards.' }),
				'hand'
			);
			const fodder = put(state, p1, BEAR(), 'hand');
			const before = marks(fodder);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
			const dest = rip ? p1.exile : p1.graveyard;
			assert.equal(dest[dest.length - 1], fodder, `rip=${rip}`);
			assert.equal(fodder.zone, rip ? 'exile' : 'graveyard');
			assert.equal(fodder.objectVersion, before.v + 1);
			assert.notEqual(fodder.enteredTimestamp, before.ts);
		}
	});

	it('suspend_card: hand -> exile with time counters, version +1, new timestamp', () => {
		const { state, p1 } = newGame();
		const talisman = put(state, p1, staple('Sol Talisman'), 'hand');
		const before = marks(talisman);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'suspend_card', instanceId: talisman.instanceId }).ok, true);
		assert.equal(p1.exile[p1.exile.length - 1], talisman);
		assert.equal(talisman.zone, 'exile');
		assert.equal(talisman.isSuspended, true);
		assert.equal(talisman.counters.time, 3);
		assert.equal(talisman.objectVersion, before.v + 1);
		assert.notEqual(talisman.enteredTimestamp, before.ts);
	});

	it('Treasure (Phase 4 fix): its parsed mana ability sacrifices it like any permanent; the token then ceases to exist', () => {
		// Was: a name check and a bare removal (no graveyard, no bookkeeping). Now "{T}, Sacrifice this
		// artifact: Add one mana of any color." is paid from the IR: battlefield -> graveyard (one
		// ZoneChange, checked by the wrapper), and the token ceases to exist there (CR 111.7).
		const { state, p1 } = newGame();
		const treasure = createTokenOnBoard(state, p1, {
			name: 'Treasure',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Token Artifact — Treasure',
			keywords: []
		});
		assert.equal(p1.battlefield[p1.battlefield.length - 1], treasure);
		const ab = getEffectiveActivatedAbilities(state, p1, treasure).find((a) => a.isManaAbility);
		assert.ok(ab, 'the Treasure has a mana ability');
		const gyBefore = p1.graveyard.length;
		const manaBefore = Object.values(p1.manaPool).reduce((a, b) => a + b, 0);
		const before = marks(treasure);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: treasure.instanceId, abilityId: ab.id }).ok,
			true
		);
		assert.ok(!p1.battlefield.includes(treasure));
		assert.equal(p1.graveyard.length, gyBefore);
		assert.equal(Object.values(p1.manaPool).reduce((a, b) => a + b, 0), manaBefore + 1);
		assert.equal(treasure.objectVersion, before.v + 1);
	});
});

describe('Zone-change behaviour pins: mulligan', () => {
	it('mulligan_take reshuffles into a fresh 7; london_bottom puts chosen cards at the bottom without bookkeeping', () => {
		const seats = [seat(0, false), seat(1, false)];
		const state = createInitialGameState(
			'PIN',
			seats,
			new Map([[0, PRECON_DECKS[0]], [1, PRECON_DECKS[1]]]),
			{ ...DEFAULT_LOBBY_RULES, mulliganRule: 'london_1free' }
		);
		const p1 = state.players[0];
		const total = p1.library.length + p1.hand.length;
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_take' }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_take' }).ok, true);
		assert.equal(p1.hand.length, 7);
		assert.equal(p1.library.length + p1.hand.length, total);
		assert.ok(p1.hand.every((c) => c.zone === 'hand' && (c.objectVersion ?? 1) === 1));
		assert.ok(p1.library.every((c) => c.zone === 'library'));
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_keep' }).ok, true);
		const bottom = p1.hand[2];
		const before = marks(bottom);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'london_bottom', instanceIds: [bottom.instanceId] }).ok, true);
		assert.equal(p1.library[p1.library.length - 1], bottom);
		assert.equal(bottom.zone, 'library');
		assert.deepEqual(marks(bottom), before);
		assert.equal(p1.hand.length, 6);
	});
});

describe('Zone-change behaviour pins: commander and cleanup', () => {
	for (const bot of [false, true]) {
		it(`commander graveyard -> command zone (${bot ? 'bot SBA' : 'human prompt'}): clears damage/tap only, no bookkeeping`, () => {
			const { state, p1 } = newGame();
			p1.isBot = bot;
			const cmd = p1.command.splice(0, 1)[0];
			cmd.zone = 'graveyard';
			cmd.damageMarked = 3;
			cmd.tapped = true;
			cmd.counters['+1/+1'] = 2;
			p1.graveyard.push(cmd);
			const before = marks(cmd);
			checkStateBasedActions(state);
			if (!bot) {
				assert.equal(state.pendingPrompts[0]?.kind, 'commander_zone_choice');
				assert.equal(
					applyGameAction(state, p1.playerId, { type: 'commander_zone_choice', commanderInstanceId: cmd.instanceId, sendToCommandZone: true }).ok,
					true
				);
			}
			assert.equal(p1.command[p1.command.length - 1], cmd);
			assert.ok(!p1.graveyard.includes(cmd));
			assert.equal(cmd.zone, 'command');
			assert.equal(cmd.damageMarked, 0);
			assert.equal(cmd.tapped, false);
			assert.equal(cmd.counters['+1/+1'], 2);
			assert.deepEqual(marks(cmd), before);
		});
	}

	for (const bot of [false, true]) {
		it(`discard to hand size (${bot ? 'bot: first cards in hand' : 'human: chosen cards'}): -> graveyard in order, no bookkeeping`, () => {
			const { state, p1 } = newGame();
			p1.isBot = bot;
			p1.hand = [];
			const cards = Array.from({ length: 9 }, (_, i) => put(state, p1, BEAR(`Pin Bear ${i}`), 'hand'));
			const chosen = bot ? [cards[0], cards[1]] : [cards[5], cards[2]];
			const before = chosen.map(marks);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'end_turn' }).ok, true);
			if (!bot) {
				assert.equal(state.pendingPrompts[0]?.kind, 'discard_to_hand_size');
				assert.equal(applyGameAction(state, p1.playerId, { type: 'discard_cards', instanceIds: ids(chosen) }).ok, true);
			}
			assert.deepEqual(ids(p1.graveyard.slice(-2)), ids(chosen));
			assert.ok(chosen.every((c) => c.zone === 'graveyard'));
			assert.deepEqual(chosen.map(marks), before);
		});
	}

	it('discard to hand size under Rest in Peace goes to exile', () => {
		const { state, p1 } = newGame();
		put(state, p1, staple('Rest in Peace'), 'battlefield');
		p1.hand = [];
		const cards = Array.from({ length: 8 }, (_, i) => put(state, p1, BEAR(`Pin Bear ${i}`), 'hand'));
		assert.equal(applyGameAction(state, p1.playerId, { type: 'end_turn' }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'discard_cards', instanceIds: [cards[4].instanceId] }).ok, true);
		assert.equal(p1.exile[p1.exile.length - 1], cards[4]);
		assert.equal(cards[4].zone, 'exile');
	});
});

describe('Zone-change behaviour pins: library search', () => {
	function searchPrompt(
		state: GameState,
		decider: PlayerGameState,
		owner: PlayerGameState,
		extra: Partial<GameState['pendingPrompts'][number]>
	) {
		state.pendingPrompts.push({
			id: 'prm_pin',
			playerId: decider.playerId,
			targetLibraryOwnerId: owner.playerId,
			kind: 'search_library',
			title: 'Pin search',
			description: '',
			...extra
		});
	}

	it('human pick to hand: end of hand, no bookkeeping', () => {
		const { state, p1 } = newGame();
		const target = p1.library[10];
		const before = marks(target);
		searchPrompt(state, p1, p1, { destinationZone: 'hand' });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'search_library_pick', instanceId: target.instanceId }).ok, true);
		assert.equal(p1.hand[p1.hand.length - 1], target);
		assert.equal(target.zone, 'hand');
		assert.deepEqual(marks(target), before);
	});

	it('human pick to battlefield tapped: end of battlefield, version +1, new timestamp', () => {
		const { state, p1 } = newGame();
		const target = put(state, p1, LAND('Pin Search Land'), 'library');
		const before = marks(target);
		searchPrompt(state, p1, p1, { destinationZone: 'battlefield', enterTapped: true });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'search_library_pick', instanceId: target.instanceId }).ok, true);
		assert.equal(p1.battlefield[p1.battlefield.length - 1], target);
		assert.equal(target.tapped, true);
		assert.equal(target.controllerId, p1.playerId);
		assert.equal(target.objectVersion, before.v + 1);
		assert.notEqual(target.enteredTimestamp, before.ts);
	});

	it('human pick to top: shuffled library with the card on top, version +1, new timestamp', () => {
		const { state, p1 } = newGame();
		const target = p1.library[20];
		const before = marks(target);
		const size = p1.library.length;
		searchPrompt(state, p1, p1, { destinationZone: 'library', putOnTop: true });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'search_library_pick', instanceId: target.instanceId }).ok, true);
		assert.equal(p1.library[0], target);
		assert.equal(p1.library.length, size);
		assert.equal(target.objectVersion, before.v + 1);
		assert.notEqual(target.enteredTimestamp, before.ts);
	});

	it('Opposition Agent pick: card goes to the library owner\'s exile with a play permission, version +1', () => {
		const { state, p1, p2 } = newGame();
		const target = p1.library[5];
		const before = marks(target);
		searchPrompt(state, p2, p1, {
			destinationZone: 'hand',
			interceptedBy: {
				controllerId: p2.playerId,
				sourceInstanceId: 'agent',
				sourceName: 'Opposition Agent',
				exilesFoundCards: true,
				grantPlayFromExile: true,
				spendManaAsAnyColor: true
			}
		});
		assert.equal(applyGameAction(state, p2.playerId, { type: 'search_library_pick', instanceId: target.instanceId }).ok, true);
		assert.equal(p1.exile[p1.exile.length - 1], target);
		assert.equal(target.zone, 'exile');
		assert.equal(target.playableFromExileBy?.playerId, p2.playerId);
		assert.equal(target.objectVersion, before.v + 1);
		assert.notEqual(target.enteredTimestamp, before.ts);
	});

	it('bot search: top destination ends on top after the shuffle; battlefield then hand', () => {
		const { state, p1 } = newGame();
		p1.isBot = true;
		const spec = (destinations: Array<{ zone: 'battlefield' | 'hand' | 'library'; tapped?: boolean; onTop?: boolean }>) => ({
			statedQuality: true,
			upTo: false,
			count: destinations.length,
			allowedTypes: ['Creature'],
			allowedSubtypes: ['Bear'],
			disallowedTypes: [],
			destinations,
			rawCriteriaText: 'a Bear card'
		});
		const bear = put(state, p1, BEAR('Pin Tutor Bear'), 'library');
		const before = marks(bear);
		resolveEffects(state, p1, [{ kind: 'search_library_to_hand', amount: 1, searchSpec: spec([{ zone: 'library', onTop: true }]) }]);
		assert.equal(p1.library[0], bear);
		assert.equal(bear.zone, 'library');
		assert.equal(bear.objectVersion, before.v + 1);
		assert.notEqual(bear.enteredTimestamp, before.ts);

		const b1 = put(state, p1, BEAR('Pin Tutor Bear 1'), 'library');
		const b2 = put(state, p1, BEAR('Pin Tutor Bear 2'), 'library');
		p1.library = p1.library.filter((c) => c !== bear);
		const m1 = marks(b1);
		const m2 = marks(b2);
		resolveEffects(state, p1, [
			{ kind: 'search_library_to_hand', amount: 1, searchSpec: spec([{ zone: 'battlefield', tapped: true }, { zone: 'hand' }]) }
		]);
		assert.equal(p1.battlefield[p1.battlefield.length - 1], b1);
		assert.equal(b1.tapped, true);
		assert.equal(b1.objectVersion, m1.v + 1);
		assert.equal(p1.hand[p1.hand.length - 1], b2);
		assert.deepEqual(marks(b2), m2);
	});
});

describe('Zone-change behaviour pins: library reordering', () => {
	it('scry_resolve: chosen top order, then bottom; no bookkeeping', () => {
		const { state, p1 } = newGame();
		const [a, b, c] = p1.library.slice(0, 3);
		const before = [a, b, c].map(marks);
		const rest = p1.library.slice(3);
		state.pendingPrompts.push({
			id: 'prm_scry',
			playerId: p1.playerId,
			kind: 'scry_choice',
			title: 'Scry 3',
			description: '',
			candidateInstanceIds: ids([a, b, c]),
			allowBottom: true
		});
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'scry_resolve', topInstanceIds: [c.instanceId], bottomInstanceIds: [a.instanceId] }).ok,
			true
		);
		assert.deepEqual(ids(p1.library), ids([c, b, ...rest, a]));
		assert.deepEqual([a, b, c].map(marks), before);
	});

	it('bot scry and bot rearrange_top follow their heuristics', () => {
		const { state, p1 } = newGame();
		p1.isBot = true;
		p1.hand = [];
		p1.battlefield = [];
		const land = LAND();
		const big = card({ name: 'Pin Big', typeLine: 'Creature — Giant', cmc: 6, manaCost: '{6}' });
		const small = card({ name: 'Pin Small', typeLine: 'Creature — Elf', cmc: 1, manaCost: '{G}' });
		p1.library = [];
		const [l, g, s, x] = [land, big, small, small].map((c) => put(state, p1, c, 'library'));
		resolveEffects(state, p1, [{ kind: 'scry', amount: 3 }]);
		assert.deepEqual(ids(p1.library), ids([l, s, x, g]));
		p1.library = [];
		const [s2, l2, s3] = [small, land, small].map((c) => put(state, p1, c, 'library'));
		resolveEffects(state, p1, [{ kind: 'rearrange_top', amount: 3 }]);
		assert.deepEqual(ids(p1.library), ids([l2, s2, s3]));
	});

	it('reorder_graveyard reorders without bookkeeping', () => {
		const { state, p1 } = newGame();
		const [a, b, c] = [1, 2, 3].map((i) => put(state, p1, BEAR(`Pin Bear ${i}`), 'graveyard'));
		const before = [a, b, c].map(marks);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'reorder_graveyard', instanceIds: ids([c, a, b]) }).ok, true);
		assert.deepEqual(ids(p1.graveyard), ids([c, a, b]));
		assert.deepEqual([a, b, c].map(marks), before);
	});
});

describe('Zone-change behaviour pins: graveyard effects', () => {
	it('graveyard-card targets of a resolving spell: return to hand / exile, version +1 only', () => {
		for (const mode of ['hand', 'exile'] as const) {
			const { state, p1, p2 } = newGame();
			const t = put(state, p2, BEAR(), 'graveyard');
			const before = marks(t);
			resolveEffects(state, p1, [], {
				oracleText: mode === 'hand' ? 'Return target card from a graveyard to its owner\'s hand.' : 'Exile target card from a graveyard.',
				targets: [{ kind: 'graveyard_card', id: t.instanceId, label: t.card.name }]
			});
			const dest = mode === 'hand' ? p2.hand : p2.exile;
			assert.equal(dest[dest.length - 1], t, mode);
			assert.equal(t.zone, mode);
			assert.equal(t.objectVersion, before.v + 1);
			assert.equal(t.enteredTimestamp, before.ts);
		}
	});

	it('exile_all_graveyards: each graveyard moves to its owner\'s exile in reverse order, version +1 only', () => {
		const { state, p1, p2 } = newGame();
		const cs = [1, 2, 3].map((i) => put(state, p1, BEAR(`Pin Bear ${i}`), 'graveyard'));
		const d = put(state, p2, BEAR('Pin Bear 4'), 'graveyard');
		const before = cs.map(marks);
		resolveEffects(state, p1, [{ kind: 'exile_all_graveyards', amount: 0 }]);
		assert.deepEqual(ids(p1.exile.slice(-3)), ids([cs[2], cs[1], cs[0]]));
		assert.equal(p2.exile[p2.exile.length - 1], d);
		assert.equal(p1.graveyard.length, 0);
		assert.deepEqual(
			cs.map(marks),
			before.map((m) => ({ v: m.v + 1, ts: m.ts }))
		);
	});

	it('return_from_graveyard_to_hand: target, else top of graveyard; version +1 only', () => {
		const { state, p1 } = newGame();
		const [a, b] = [1, 2].map((i) => put(state, p1, BEAR(`Pin Bear ${i}`), 'graveyard'));
		const mb = marks(b);
		resolveEffects(state, p1, [{ kind: 'return_from_graveyard_to_hand', amount: 1 }]);
		assert.equal(p1.hand[p1.hand.length - 1], b);
		assert.deepEqual(marks(b), { v: mb.v + 1, ts: mb.ts });
		const ma = marks(a);
		put(state, p1, BEAR('Pin Bear 3'), 'graveyard');
		resolveEffects(state, p1, [{ kind: 'return_from_graveyard_to_hand', amount: 1 }], {
			targets: [{ kind: 'graveyard_card', id: a.instanceId, label: 'a' }]
		});
		assert.equal(p1.hand[p1.hand.length - 1], a);
		assert.equal(a.zone, 'hand');
		assert.deepEqual(marks(a), { v: ma.v + 1, ts: ma.ts });
	});

	it('reanimate_target: opponent graveyard target -> controller battlefield; fallback takes the first player\'s top creature', () => {
		const { state, p1, p2 } = newGame();
		const t = put(state, p2, BEAR(), 'graveyard');
		const mt = marks(t);
		resolveEffects(state, p1, [{ kind: 'reanimate_target', amount: 1 }], {
			targets: [{ kind: 'graveyard_card', id: t.instanceId, label: 'bear' }]
		});
		assert.equal(p1.battlefield[p1.battlefield.length - 1], t);
		assert.equal(t.controllerId, p1.playerId);
		assert.equal(t.ownerId, p2.playerId);
		assert.equal(t.summoningSick, true);
		assert.equal(t.objectVersion, mt.v + 1);
		assert.notEqual(t.enteredTimestamp, mt.ts);

		const f = put(state, p2, BEAR('Pin Fallback'), 'graveyard');
		put(state, p2, LAND(), 'graveyard');
		resolveEffects(state, p2, [{ kind: 'reanimate_target', amount: 1 }]);
		assert.equal(p2.battlefield[p2.battlefield.length - 1], f);
		assert.equal(f.zone, 'battlefield');
		assert.equal(f.summoningSick, true);
	});

	it('return_self_from_graveyard: back under its controller, summoning sick unless it has haste', () => {
		const { state, p1 } = newGame();
		const slow = put(state, p1, BEAR('Pin Slow'), 'graveyard');
		const fast = put(state, p1, card({ ...BEAR('Pin Fast'), keywords: ['Haste'], oracleText: 'Haste' }), 'graveyard');
		const ms = marks(slow);
		resolveEffects(state, p1, [{ kind: 'return_self_from_graveyard', amount: 1 }], { sourceInstanceId: slow.instanceId });
		resolveEffects(state, p1, [{ kind: 'return_self_from_graveyard', amount: 1 }], { sourceInstanceId: fast.instanceId });
		assert.deepEqual(ids(p1.battlefield.slice(-2)), ids([slow, fast]));
		assert.equal(slow.summoningSick, true);
		assert.equal(fast.summoningSick, false);
		assert.equal(slow.objectVersion, ms.v + 1);
		assert.notEqual(slow.enteredTimestamp, ms.ts);
	});
});

describe('Zone-change behaviour pins: leaving the battlefield', () => {
	it('movePermanentToZone: resets, owner\'s zone, library on top, tokens cease to exist, bot commander redirect', () => {
		const { state, p1, p2 } = newGame();
		const stolen = put(state, p2, BEAR(), 'battlefield');
		p2.battlefield.splice(p2.battlefield.indexOf(stolen), 1);
		stolen.controllerId = p1.playerId;
		p1.battlefield.push(stolen);
		const aura = put(state, p1, card({ name: 'Pin Aura', typeLine: 'Enchantment — Aura' }), 'battlefield');
		aura.attachedToId = stolen.instanceId;
		stolen.tapped = true;
		stolen.damageMarked = 1;
		stolen.counters['+1/+1'] = 2;
		const ms = marks(stolen);
		assert.equal(movePermanentToZone(state, stolen, 'library'), 'library');
		assert.equal(p2.library[0], stolen);
		assert.equal(aura.attachedToId, null);
		assert.equal(stolen.tapped, false);
		assert.equal(stolen.damageMarked, 0);
		assert.equal(stolen.counters['+1/+1'], 0);
		assert.equal(stolen.objectVersion, ms.v + 1);
		assert.equal(stolen.enteredTimestamp, state.nextTimestamp);
		assert.equal(stolen.controllerId, p1.playerId, 'controllerId is not reset (pinned)');

		const token = createTokenOnBoard(state, p1, { name: 'Pin Token', power: 1, toughness: 1, colors: [], typeLine: 'Token Creature — Pin', keywords: [] });
		assert.equal(movePermanentToZone(state, token, 'graveyard'), 'graveyard');
		assert.ok(!p1.graveyard.includes(token) && !p1.battlefield.includes(token));
		assert.equal(token.zone, 'graveyard');

		p1.isBot = true;
		const cmd = p1.command.splice(0, 1)[0];
		cmd.zone = 'battlefield';
		p1.battlefield.push(cmd);
		assert.equal(movePermanentToZone(state, cmd, 'hand'), 'command');
		assert.equal(p1.command[p1.command.length - 1], cmd);

		put(state, p1, staple('Rest in Peace'), 'battlefield');
		const dying = put(state, p1, BEAR('Pin Dying'), 'battlefield');
		assert.equal(movePermanentToZone(state, dying, 'graveyard'), 'exile');
		assert.equal(p1.exile[p1.exile.length - 1], dying);
	});

	it('spell resolution: a permanent spell enters as a fresh object under its controller; an instant goes to its owner\'s graveyard', () => {
		const { state, p1 } = newGame();
		const bear = put(state, p1, BEAR(), 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: bear.instanceId }).ok, true);
		resolveTopOfStack(state);
		const onBoard = p1.battlefield[p1.battlefield.length - 1];
		assert.equal(onBoard.instanceId, bear.instanceId);
		assert.notEqual(onBoard, bear);
		assert.equal(onBoard.objectVersion, 1);
		assert.equal(onBoard.enteredTimestamp, state.nextTimestamp);
		assert.equal(onBoard.summoningSick, true);

		const draw = put(state, p1, card({ name: 'Pin Draw', typeLine: 'Instant', oracleText: 'Draw a card.' }), 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: draw.instanceId }).ok, true);
		resolveTopOfStack(state);
		const inGy = p1.graveyard[p1.graveyard.length - 1];
		assert.equal(inGy.instanceId, draw.instanceId);
		assert.equal(inGy.zone, 'graveyard');
		assert.equal(inGy.objectVersion, 1);
	});

	it('elimination: permanents owned by others return to their owner\'s battlefield (control change, no bookkeeping); the rest are removed', () => {
		const { state, p1, p2 } = newGame(3);
		const borrowed = put(state, p1, BEAR(), 'battlefield');
		p1.battlefield.splice(p1.battlefield.indexOf(borrowed), 1);
		borrowed.controllerId = p2.playerId;
		borrowed.attachedToId = 'something';
		p2.battlefield.push(borrowed);
		const own = put(state, p2, BEAR('Pin Own'), 'battlefield');
		const p2Card = put(state, p2, BEAR('Pin P2 Card'), 'battlefield');
		p2.battlefield.splice(p2.battlefield.indexOf(p2Card), 1);
		p2Card.controllerId = p1.playerId;
		p1.battlefield.push(p2Card);
		const mb = marks(borrowed);
		// Leaving the game is not a zone change (CR 800.4a): no ZoneChange for anything p2 had.
		const events: GameEvent[] = [];
		const unsubscribe = subscribeEvents(state, (_s, ev) => events.push(ev));
		assert.equal(rawApplyGameAction(state, p2.playerId, { type: 'concede' }).ok, true);
		unsubscribe();
		const touched = new Set([borrowed.instanceId, own.instanceId, p2Card.instanceId]);
		assert.deepEqual(
			events.filter((e) => e.kind === 'ZoneChange' && touched.has(e.objectId)),
			[]
		);
		assert.equal(p1.battlefield[p1.battlefield.length - 1], borrowed);
		assert.equal(borrowed.controllerId, p1.playerId);
		assert.equal(borrowed.attachedToId, null);
		assert.deepEqual(marks(borrowed), mb);
		assert.ok(!p1.battlefield.includes(p2Card));
		assert.equal(p2.battlefield.length + p2.hand.length + p2.library.length + p2.exile.length, 0);
		assert.ok(!p2.battlefield.includes(own));
	});
});
