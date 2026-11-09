import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { applyGameAction, createCardInstance, createInitialGameState } from '../engine.ts';
import { runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS } from '../precons.ts';
import { DEFAULT_LOBBY_RULES, type GameState, type LobbySeat, type ScryfallCard } from '../types.ts';
import { peekEvents, subscribeEvents, type GameEvent, type GameEventKind } from './events.ts';

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function withDeterminism<T>(seed: number, fn: () => T): T {
	let clock = 1_700_000_000_000;
	mock.method(Math, 'random', mulberry32(seed));
	mock.method(Date, 'now', () => (clock += 7));
	try {
		return fn();
	} finally {
		mock.restoreAll();
	}
}

function seats(count: number, bots: boolean): LobbySeat[] {
	return Array.from({ length: count }, (_, i) => ({
		seatIndex: i,
		userId: bots ? null : `p${i + 1}`,
		username: `Seat ${i}`,
		avatarUrl: '',
		isBot: bots,
		deckId: PRECON_DECKS[i].id,
		deckName: PRECON_DECKS[i].name,
		commanderNames: PRECON_DECKS[i].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: PRECON_DECKS[i].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
}

function newGame(count: number, bots: boolean): GameState {
	const s = seats(count, bots);
	const state = createInitialGameState(
		'EVT',
		s,
		new Map(s.map((x, i) => [x.seatIndex, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	if (!bots) {
		for (const p of state.players) applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
	}
	return state;
}

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

describe('Event bus: ZoneChange accounting', () => {
	for (const [seed, count] of [
		[3, 2],
		[11, 3],
		[42, 4]
	] as const) {
		it(`every zone change emits exactly one ZoneChange (bots, ${count} players, seed ${seed})`, () => {
			withDeterminism(seed, () => {
				const state = newGame(count, true);
				// The model is advanced only by ZoneChange events; the real state must always agree.
				let model = locate(state);
				let synced = true;
				let zoneChanges = 0;
				const kinds = new Map<GameEventKind, number>();
				const unsubscribe = subscribeEvents(state, (st, ev) => {
					kinds.set(ev.kind, (kinds.get(ev.kind) ?? 0) + 1);
					if (ev.kind !== 'ZoneChange' || !synced) return;
					zoneChanges++;
					assert.equal(
						model.get(ev.objectId) ?? null,
						ev.from,
						`${ev.object.card.name}: event says it left ${ev.from}, model has it in ${model.get(ev.objectId)}`
					);
					if (ev.ceasedToExist) model.delete(ev.objectId);
					else model.set(ev.objectId, ev.to);
					// The object is now exactly where the event says (or nowhere, if it's on its way
					// to the stack and the StackItem isn't pushed yet, or the destination was deferred).
					const actual = locate(st).get(ev.objectId);
					if (!ev.ceasedToExist && ev.to !== 'stack' && actual !== undefined) {
						assert.equal(actual, ev.to, `${ev.object.card.name} should be in ${ev.to}`);
					}
				});
				for (let round = 0; round < 3 && state.status === 'active'; round++) {
					runAutomatedPriorityAndBots(state);
					// Leaving the game (CR 800.4a) removes objects without zone changes; stop checking then.
					if (state.players.some((p) => p.lost)) synced = false;
					if (synced) assert.deepEqual(locate(state), model);
					assert.equal(peekEvents(state).length, 0, 'queue is drained after each action');
				}
				unsubscribe();
				model = new Map();
				assert.ok(zoneChanges > 20, `only ${zoneChanges} zone changes observed`);
				for (const k of ['ZoneChange', 'Cast', 'PhaseBegin', 'AttackDeclared', 'DamageDealt'] as const) {
					assert.ok((kinds.get(k) ?? 0) > 0, `no ${k} events`);
				}
			});
		});
	}

	it('reordering a zone emits no ZoneChange (reorder_graveyard, scry_resolve)', () => {
		const state = newGame(2, false);
		const p1 = state.players[0];
		const card: ScryfallCard = { ...PRECON_DECKS[0].cards[0].card };
		for (let i = 0; i < 3; i++) p1.graveyard.push(createCardInstance(card, p1.playerId, 'graveyard'));
		const events: GameEvent[] = [];
		const unsubscribe = subscribeEvents(state, (_s, ev) => events.push(ev));
		const order = [...p1.graveyard].reverse().map((c) => c.instanceId);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'reorder_graveyard', instanceIds: order }).ok, true);
		state.pendingPrompts.push({
			id: 'prm_scry',
			playerId: p1.playerId,
			kind: 'scry_choice',
			title: 'Scry 2',
			description: '',
			candidateInstanceIds: p1.library.slice(0, 2).map((c) => c.instanceId),
			allowBottom: true
		});
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'scry_resolve',
				topInstanceIds: [],
				bottomInstanceIds: [p1.library[0].instanceId]
			}).ok,
			true
		);
		unsubscribe();
		assert.deepEqual(events.filter((e) => e.kind === 'ZoneChange'), []);
	});

	it('counters placed via addCountersToPermanent emit CounterPlaced', () => {
		withDeterminism(5, () => {
			const state = newGame(2, false);
			const p1 = state.players[0];
			const events: GameEvent[] = [];
			subscribeEvents(state, (_s, ev) => events.push(ev));
			const bear = createCardInstance(
				{ ...PRECON_DECKS[0].cards[0].card, typeLine: 'Creature — Bear', power: '2', toughness: '2' },
				p1.playerId,
				'battlefield'
			);
			bear.counters['+1/+1'] = 1;
			p1.battlefield.push(bear);
			state.stack.push({
				id: 'stk_prolif',
				sourceInstanceId: bear.instanceId,
				card: bear.card,
				controllerId: p1.playerId,
				kind: 'activated',
				title: 'Counters',
				oracleText: 'Put a +1/+1 counter on ~.',
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: 0
			});
			state.priorityPlayerIndex = 0;
			for (const p of state.players) applyGameAction(state, p.playerId, { type: 'pass_priority' });
			const placed = events.filter((e) => e.kind === 'CounterPlaced');
			assert.equal(placed.length, 1);
			assert.equal(placed[0].kind === 'CounterPlaced' && placed[0].objectId, bear.instanceId);
			assert.equal(bear.counters['+1/+1'], 2);
		});
	});
});

describe('GameState persistence', () => {
	function assertPlainData(value: unknown, path: string): void {
		if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return;
		assert.notEqual(typeof value, 'function', `${path} is a function`);
		assert.equal(typeof value, 'object', `${path} has type ${typeof value}`);
		const proto = Object.getPrototypeOf(value);
		assert.ok(
			proto === Object.prototype || proto === Array.prototype,
			`${path} is a ${proto?.constructor?.name} (only plain objects and arrays may be stored in GameState)`
		);
		for (const [k, v] of Object.entries(value as object)) assertPlainData(v, `${path}.${k}`);
	}

	it('survives a JSON round trip mid-game and plays on identically', () => {
		const SEED = 77;
		const { original, copy } = withDeterminism(SEED, () => {
			const state = newGame(3, true);
			runAutomatedPriorityAndBots(state);
			runAutomatedPriorityAndBots(state);
			assert.equal(state.status, 'active');
			assert.ok(state.players.some((p) => p.battlefield.length > 0));
			assertPlainData(state, 'state');
			const json = JSON.stringify(state);
			const parsed = JSON.parse(json) as GameState;
			assert.equal(JSON.stringify(parsed), json);
			return { original: state, copy: parsed };
		});
		// Continue both from identical RNG/clock streams: the restored copy must behave exactly like
		// the in-memory original (no hidden state outside GameState).
		withDeterminism(SEED + 1, () => runAutomatedPriorityAndBots(original));
		withDeterminism(SEED + 1, () => runAutomatedPriorityAndBots(copy));
		assert.equal(JSON.stringify(copy), JSON.stringify(original));
		assertPlainData(copy, 'copy');
	});
});
