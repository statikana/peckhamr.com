import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createCardInstance, createInitialGameState } from '../engine.ts';
import { runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	evaluatePermanent,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities
} from '../ruleTree.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard
} from '../types.ts';
import {
	getBoardSnapshot,
	layerCacheCheckStats,
	setLayerCacheCheck,
	setLayerReference,
	withoutLayerCache
} from './layerCache.ts';
import * as reference from './layerReference.test.ts';

/**
 * Phase 6a: the cached layer evaluation must give exactly the same answers as (a) a fresh,
 * uncached computation and (b) the frozen pre-cache implementation (layerReference.test.ts), on
 * boards that are mutated between evaluations so a stale cache would show.
 */

// ---- Cards ----------------------------------------------------------------------------------

function real(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	if (!c) throw new Error(`Not a precon card: ${name}`);
	return c;
}

function card(spec: Partial<ScryfallCard> & { name: string; typeLine: string }): ScryfallCard {
	return {
		id: `cache_${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...spec
	};
}

const SKY = card({ name: 'Cloudmere Kite', typeLine: 'Creature — Bird Soldier', power: '2', toughness: '2', oracleText: 'Flying', keywords: ['Flying'] });
const BRUTE = card({ name: 'Bramblehide Ox', typeLine: 'Creature — Ox', power: '5', toughness: '5', cmc: 5, oracleText: 'Trample', keywords: ['Trample'] });
const ELF = card({ name: 'Fernglade Elf', typeLine: 'Creature — Elf Druid', power: '1', toughness: '1' });
const MARSHAL = card({ name: 'Oakshade Captain', typeLine: 'Creature — Elf Warrior', power: '2', toughness: '2', oracleText: 'Other Elf creatures you control get +1/+1 and have vigilance.' });
const BANNER = card({ name: 'Standard of the Dells', typeLine: 'Enchantment', cmc: 3, oracleText: 'Creatures you control get +1/+1.' });
const VEIL = card({ name: 'Shroud of Forgetting', typeLine: 'Enchantment — Aura', oracleText: 'Enchant permanent\nEnchanted permanent loses all abilities.' });
const HARNESS = card({ name: 'Gullwing Rig', typeLine: 'Artifact — Equipment', oracleText: 'Equipped creature gets +2/+2 and has flying.\nEquip {2}' });
const COLOSSUS = card({ name: 'Mossheap Giant', typeLine: 'Creature — Plant', power: '*', toughness: '*', oracleText: "Mossheap Giant's power and toughness are each equal to the number of creatures you control." });
const GRAVESWORN = card({ name: 'Cryptwalker Shade', typeLine: 'Creature — Shade', power: '*', toughness: '*', oracleText: "Cryptwalker Shade's power and toughness are each equal to the number of creature cards in all graveyards." });
const SIGIL = card({ name: 'Downdraft Ward', typeLine: 'Enchantment', oracleText: 'Creatures your opponents control lose flying.' });
const MUTATE = card({ name: 'Glasswing Curse', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nEnchanted creature is a Frog artifact creature with base power and toughness 1/1 and loses all other abilities.' });

// ---- Board ----------------------------------------------------------------------------------

class Board {
	readonly state: GameState;
	readonly players: string[];
	private ts = 0;

	constructor(playerCount = 2) {
		const seats: LobbySeat[] = [];
		const decks = new Map<number, MagicDeck>();
		for (let i = 0; i < playerCount; i++) {
			const deck = PRECON_DECKS[i % PRECON_DECKS.length];
			seats.push({
				seatIndex: i,
				userId: `player_${i + 1}`,
				username: `P${i + 1}`,
				avatarUrl: '',
				isBot: false,
				deckId: deck.id,
				deckName: deck.name,
				commanderNames: deck.commanders.map((c) => c.name),
				commanderArtUrl: '',
				colorIdentity: deck.colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: 0
			});
			decks.set(i, deck);
		}
		this.state = createInitialGameState('CACHE', seats, decks, { ...DEFAULT_LOBBY_RULES });
		this.players = this.state.players.map((p) => p.playerId);
	}

	add(
		c: ScryfallCard,
		opts: { player?: number; attachTo?: CardInstance; zone?: 'battlefield' | 'graveyard' } = {}
	): CardInstance {
		const owner = this.players[opts.player ?? 0];
		const zone = opts.zone ?? 'battlefield';
		this.ts += 1;
		const inst = createCardInstance(c, owner, zone, false, false, this.ts);
		inst.controllerId = owner;
		inst.summoningSick = false;
		if (opts.attachTo) inst.attachedToId = opts.attachTo.instanceId;
		this.player(opts.player ?? 0)[zone].push(inst);
		return inst;
	}

	player(i: number) {
		return this.state.players[i];
	}

	remove(inst: CardInstance): void {
		for (const p of this.state.players) {
			const idx = p.battlefield.indexOf(inst);
			if (idx >= 0) p.battlefield.splice(idx, 1);
		}
	}
}

// ---- Comparison -----------------------------------------------------------------------------

const json = (v: unknown) => JSON.parse(JSON.stringify(v));

/** Every object whose layer state the tests compare: all battlefields plus graveyards and hands. */
function objectsOf(state: GameState): CardInstance[] {
	return state.players.flatMap((p) => [...p.battlefield, ...p.graveyard, ...p.hand.slice(0, 2)]);
}

const SUBTYPES = ['Elf', 'Bird', 'Frog', 'Forest', 'Swamp', 'Goblin'];

/**
 * Asserts the cached answer equals the uncached one and the frozen reference's, for every object.
 * Runs the cached queries first so the cache is warm for the next mutation.
 */
function assertMatchesReference(state: GameState, context: string): void {
	for (const inst of objectsOf(state)) {
		const label = `${context}: ${inst.card.name} (${inst.instanceId})`;
		const cachedInspect = json(inspectCardContinuousBreakdown(inst, state));
		const cachedLost = permanentHasLostAllAbilities(inst, state);
		const cachedEval = evaluatePermanent(state, inst);
		const fresh = withoutLayerCache(() => ({
			inspect: json(inspectCardContinuousBreakdown(inst, state)),
			lost: permanentHasLostAllAbilities(inst, state),
			eval: evaluatePermanent(state, inst)
		}));
		const refEval = reference.evaluatePermanent(state, inst);

		assert.deepStrictEqual(cachedInspect, fresh.inspect, `${label}: inspect vs fresh`);
		assert.deepStrictEqual(cachedInspect, json(reference.inspectCardContinuousBreakdown(inst, state)), `${label}: inspect vs reference`);
		assert.deepStrictEqual(cachedLost, fresh.lost, `${label}: lost vs fresh`);
		assert.deepStrictEqual(cachedLost, reference.permanentHasLostAllAbilities(inst, state), `${label}: lost vs reference`);
		assert.deepStrictEqual(json(cachedEval), json(fresh.eval), `${label}: evaluate vs fresh`);
		assert.deepStrictEqual(json(cachedEval), json(refEval), `${label}: evaluate vs reference`);
		for (const sub of SUBTYPES) {
			assert.equal(cachedEval.hasSubType(sub), refEval.hasSubType(sub), `${label}: hasSubType(${sub})`);
		}
	}
	// The ScryfallCard entry point (used by the UI inspector) looks the instance up by id/name.
	for (const inst of state.players.flatMap((p) => p.battlefield)) {
		assert.deepStrictEqual(
			json(inspectCardContinuousBreakdown(inst.card, state)),
			json(reference.inspectCardContinuousBreakdown(inst.card, state)),
			`${context}: inspect(card) ${inst.card.name}`
		);
	}
}

/** Warm the cache, mutate, and compare again; each step is checked against the reference. */
function scenario(build: (b: Board) => void, steps: Array<[string, (b: Board) => void]>): void {
	const b = new Board(2);
	build(b);
	assertMatchesReference(b.state, 'initial');
	const warm = getBoardSnapshot(b.state);
	assert.equal(getBoardSnapshot(b.state), warm, 'an unchanged board reuses its snapshot');
	for (const [name, mutate] of steps) {
		mutate(b);
		assertMatchesReference(b.state, name);
	}
}

afterEach(() => {
	setLayerCacheCheck(null);
	setLayerReference(null);
});

// ---- Mutation scenarios ---------------------------------------------------------------------

describe('Layer cache: results track board mutations (Phase 6a)', () => {
	it('attaching and detaching an ability-stripping Aura', () => {
		let target!: CardInstance;
		let aura!: CardInstance;
		scenario(
			(b) => {
				target = b.add(SKY);
				b.add(BANNER);
				aura = b.add(VEIL);
			},
			[
				['attach', () => (aura.attachedToId = target.instanceId)],
				['detach', () => (aura.attachedToId = null)],
				['reattach', () => (aura.attachedToId = target.instanceId)],
				['aura on the aura', (b) => b.add(VEIL, { attachTo: aura })],
				['type-changing aura too', (b) => b.add(MUTATE, { attachTo: target })]
			]
		);
	});

	it('phasing the target, the Aura and an anthem in and out', () => {
		let target!: CardInstance;
		let aura!: CardInstance;
		let banner!: CardInstance;
		scenario(
			(b) => {
				target = b.add(SKY);
				banner = b.add(BANNER);
				aura = b.add(MUTATE, { attachTo: target });
			},
			[
				['aura phased out', () => (aura.phasedOut = true)],
				['anthem phased out', () => (banner.phasedOut = true)],
				['target phased out', () => (target.phasedOut = true)],
				['all phased in', () => {
					aura.phasedOut = false;
					banner.phasedOut = false;
					target.phasedOut = false;
				}]
			]
		);
	});

	it('counters, temporary P/T, switched P/T, granted keywords and suspend (never cached)', () => {
		let target!: CardInstance;
		scenario(
			(b) => {
				target = b.add(BRUTE);
				b.add(BANNER);
			},
			[
				['+1/+1 counters', () => (target.counters['+1/+1'] = 2)],
				['-1/-1 counters', () => (target.counters['-1/-1'] = 3)],
				['temp pump', () => {
					target.tempPowerMod = 3;
					target.tempToughnessMod = -1;
				}],
				['switch P/T', () => (target.switchedPTCount = 1)],
				['granted keyword', () => target.grantedKeywords.push('haste')],
				['cast via suspend', () => (target.castViaSuspend = true)],
				['counters removed', () => {
					target.counters['+1/+1'] = 0;
					target.counters['-1/-1'] = 0;
				}]
			]
		);
	});

	it('changing control (with and without moving battlefields)', () => {
		let lord!: CardInstance;
		let elf!: CardInstance;
		let flyer!: CardInstance;
		scenario(
			(b) => {
				lord = b.add(MARSHAL);
				elf = b.add(ELF);
				flyer = b.add(SKY, { player: 1 });
				b.add(SIGIL);
			},
			[
				['controllerId only', (b) => (elf.controllerId = b.players[1])],
				['elf moves to the opponent', (b) => {
					b.remove(elf);
					elf.controllerId = b.players[1];
					b.player(1).battlefield.push(elf);
				}],
				['flyer moves to the sigil player', (b) => {
					b.remove(flyer);
					flyer.controllerId = b.players[0];
					b.player(0).battlefield.push(flyer);
				}],
				['lord moves too', (b) => {
					b.remove(lord);
					lord.controllerId = b.players[1];
					b.player(1).battlefield.push(lord);
				}]
			]
		);
	});

	it('Humility (and Opalescence) entering and leaving, in both timestamp orders', () => {
		let humility!: CardInstance;
		let opal!: CardInstance;
		scenario(
			(b) => {
				b.add(SKY);
				b.add(MARSHAL);
				b.add(ELF);
				b.add(BANNER);
				b.add(COLOSSUS);
			},
			[
				['Humility enters', (b) => (humility = b.add(real('Humility')))],
				['Opalescence enters', (b) => (opal = b.add(real('Opalescence'), { player: 1 }))],
				['timestamps swapped', () => {
					const t = humility.enteredTimestamp;
					humility.enteredTimestamp = opal.enteredTimestamp;
					opal.enteredTimestamp = t;
				}],
				['Humility leaves', (b) => b.remove(humility)],
				['Opalescence leaves', (b) => b.remove(opal)]
			]
		);
	});

	it('copy effects: copiableCard set and cleared, card replaced wholesale', () => {
		let bear!: CardInstance;
		scenario(
			(b) => {
				bear = b.add(ELF);
				b.add(MARSHAL);
				b.add(SKY, { player: 1 });
			},
			[
				['becomes a copy of Humility', () => (bear.copiableCard = real('Humility'))],
				['copy cleared', () => (bear.copiableCard = undefined)],
				['becomes a copy of the lord', () => (bear.copiableCard = MARSHAL)],
				['card replaced (Clone-style JSON copy)', () => {
					const copy = JSON.parse(JSON.stringify(SIGIL)) as ScryfallCard;
					bear.copiableCard = copy;
					bear.card = copy;
				}]
			]
		);
	});

	it('face-down, player loss, timestamps, graveyards and replaced arrays', () => {
		let target!: CardInstance;
		let aura!: CardInstance;
		scenario(
			(b) => {
				target = b.add(SKY);
				aura = b.add(HARNESS, { attachTo: target });
				b.add(GRAVESWORN);
				b.add(real('Blood Moon'), { player: 1 });
				b.add(real('Urborg, Tomb of Yawgmoth'));
				b.add(real('Command Tower'));
			},
			[
				['face down', () => (target.isFaceDown = true)],
				['face up', () => (target.isFaceDown = false)],
				['equipment re-timestamped', () => (aura.enteredTimestamp = 0)],
				['creature card hits a graveyard', (b) => b.add(BRUTE, { player: 1, zone: 'graveyard' })],
				['opponent loses', (b) => (b.player(1).lost = true)],
				['opponent back', (b) => (b.player(1).lost = false)],
				['battlefield array replaced', (b) => (b.player(0).battlefield = [...b.player(0).battlefield].reverse())],
				['Darksteel Mutation on the land', (b) => {
					const tower = b.player(0).battlefield.find((c) => c.card.name === 'Command Tower')!;
					b.add(real('Darksteel Mutation'), { attachTo: tower });
				}]
			]
		);
	});

	it('the cross-check flag compares every call against a fresh computation and the reference', () => {
		setLayerReference(reference);
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const b = new Board(2);
		const target = b.add(SKY);
		b.add(BANNER);
		evaluatePermanent(b.state, target);
		b.add(VEIL, { attachTo: target });
		evaluatePermanent(b.state, target);
		const after = layerCacheCheckStats();
		assert.ok(after.checks > before.checks, 'cross-checks ran');
		assert.equal(after.mismatches, before.mismatches);
	});
});

// ---- Seeded bot games -----------------------------------------------------------------------

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

function botSeats(count: number): LobbySeat[] {
	return Array.from({ length: count }, (_, i) => ({
		seatIndex: i,
		userId: null,
		username: `Bot ${i}`,
		avatarUrl: '',
		isBot: true,
		deckId: PRECON_DECKS[i % PRECON_DECKS.length].id,
		deckName: PRECON_DECKS[i % PRECON_DECKS.length].name,
		commanderNames: PRECON_DECKS[i % PRECON_DECKS.length].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: PRECON_DECKS[i % PRECON_DECKS.length].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
}

describe('Layer cache: seeded 4-bot games match the reference on every call (Phase 6a)', () => {
	for (const seed of [1, 2]) {
		it(`seed ${seed}: every layer query during play, and every object after each tick`, () => {
			let clock = 1_700_000_000_000;
			mock.method(Math, 'random', mulberry32(seed));
			mock.method(Date, 'now', () => (clock += 7));
			setLayerReference(reference);
			setLayerCacheCheck(true);
			const before = layerCacheCheckStats();
			try {
				const decks = new Map(botSeats(4).map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]]));
				const state = createInitialGameState('CACHE', botSeats(4), decks, { ...DEFAULT_LOBBY_RULES });
				for (let tick = 0; tick < 3 && state.status === 'active'; tick++) {
					runAutomatedPriorityAndBots(state);
					setLayerCacheCheck(false);
					assertMatchesReference(state, `seed ${seed} tick ${tick}`);
					setLayerCacheCheck(true);
				}
				const after = layerCacheCheckStats();
				assert.ok(after.checks > before.checks, 'cross-checks ran during play');
				assert.equal(after.mismatches, before.mismatches, 'no mismatches (some may have been swallowed)');
			} finally {
				mock.restoreAll();
			}
		});
	}
});
