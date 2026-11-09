import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { checkStateBasedActions, createCardInstance, createInitialGameState } from '../engine.ts';
import { runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS } from '../precons.ts';
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
	inStableLayerScope,
	layerCacheCheckStats,
	noteLayerInputsChanged,
	setLayerCacheCheck,
	whileLayerInputsChange,
	withStableLayerInputs,
	withoutLayerCache
} from './layerCache.ts';
import { abilityActivePermanents } from './layers.ts';
import {
	activeRuleModifiers,
	hasRestriction,
	playerCannotLoseGame,
	playerHasShroud
} from './replace.ts';
import { moveObject, transferBattlefieldControl } from './zones.ts';

/**
 * Phase 6c: stable-input scopes (`withStableLayerInputs`) and the board-level rule-modifier scan
 * (`abilityActivePermanents`). Boards are mutated between queries, inside and outside scopes, and
 * every answer is compared with a fresh, uncached computation.
 */

// ---- Cards (invented names) -----------------------------------------------------------------

function card(spec: Partial<ScryfallCard> & { name: string; typeLine: string }): ScryfallCard {
	const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
	return {
		id: `scope_${slug}`,
		oracleId: `scope_oracle_${slug}`,
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

const KITE = card({ name: 'Cloudmere Kite', typeLine: 'Creature — Bird Soldier', power: '2', toughness: '2', oracleText: 'Flying', keywords: ['Flying'] });
const BANNER = card({ name: 'Standard of the Dells', typeLine: 'Enchantment', cmc: 3, oracleText: 'Creatures you control get +1/+1.' });
const VEIL = card({ name: 'Shroud of Forgetting', typeLine: 'Enchantment — Aura', oracleText: 'Enchant permanent\nEnchanted permanent loses all abilities.' });
const WARDEN = card({ name: 'Bastion Wardstone', typeLine: 'Artifact', cmc: 4, oracleText: "You can't lose the game and your opponents can't win the game.\nYou have shroud." });
const SERAPH = card({ name: 'Metalwork Seraph', typeLine: 'Artifact Creature — Angel', power: '4', toughness: '4', oracleText: "As long as you control three or more artifacts, you can't lose the game." });
const TRINKET = card({ name: 'Brass Trinket', typeLine: 'Artifact', oracleText: '' });
const SLUGGARD = card({ name: 'Rustjaw Sluggard', typeLine: 'Creature — Golem', power: '3', toughness: '3', oracleText: "Rustjaw Sluggard doesn't untap during your untap step." });

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
		this.state = createInitialGameState('SCOPE', seats, decks, { ...DEFAULT_LOBBY_RULES });
		this.players = this.state.players.map((p) => p.playerId);
	}

	add(c: ScryfallCard, opts: { player?: number; attachTo?: CardInstance } = {}): CardInstance {
		const owner = this.players[opts.player ?? 0];
		this.ts += 1;
		const inst = createCardInstance(c, owner, 'battlefield', false, false, 1000 + this.ts);
		inst.controllerId = owner;
		inst.summoningSick = false;
		if (opts.attachTo) inst.attachedToId = opts.attachTo.instanceId;
		this.state.players[opts.player ?? 0].battlefield.push(inst);
		return inst;
	}
}

// ---- Comparison -----------------------------------------------------------------------------

const json = (v: unknown) => JSON.parse(JSON.stringify(v));

/** The pre-Phase-6c `activePermanents` scan: one `permanentHasLostAllAbilities` per permanent. */
function perPermanentReference(state: GameState): unknown[] {
	const out: unknown[] = [];
	for (const player of state.players) {
		if (player.lost) continue;
		for (const perm of player.battlefield) {
			if (perm.phasedOut) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			out.push([perm.instanceId, player.playerId, (perm.copiableCard ?? perm.card).name]);
		}
	}
	return out;
}

/** Everything a query returns for `state`, in a JSON-comparable form. */
function answers(state: GameState): unknown {
	const perms = state.players.flatMap((p) => p.battlefield);
	return json({
		eval: perms.map((p) => evaluatePermanent(state, p)),
		inspect: perms.map((p) => inspectCardContinuousBreakdown(p, state)),
		lost: perms.map((p) => permanentHasLostAllAbilities(p, state)),
		active: abilityActivePermanents(state).map((a) => [a.perm.instanceId, a.controllerId, a.card.name]),
		mods: activeRuleModifiers(state).map((m) => [m.def.rule, m.source.instanceId, m.controllerId]),
		cantLose: state.players.map((p) => playerCannotLoseGame(state, p)),
		shroud: state.players.map((p) => playerHasShroud(state, p)),
		doesntUntap: perms.map((p) => hasRestriction(state, p, 'doesntUntap'))
	});
}

function assertFresh(state: GameState, context: string): void {
	const cached = answers(state);
	const fresh = withoutLayerCache(() => answers(state));
	assert.deepStrictEqual(cached, fresh, `${context}: cached vs fresh`);
	assert.deepStrictEqual(
		json(abilityActivePermanents(state).map((a) => [a.perm.instanceId, a.controllerId, a.card.name])),
		json(perPermanentReference(state)),
		`${context}: abilityActivePermanents vs per-permanent scan`
	);
}

interface Fixture {
	b: Board;
	kite: CardInstance;
	banner: CardInstance;
	veil: CardInstance;
	warden: CardInstance;
	seraph: CardInstance;
	sluggard: CardInstance;
}

function fixture(): Fixture {
	const b = new Board(2);
	for (const p of b.state.players) p.battlefield = [];
	const kite = b.add(KITE);
	const banner = b.add(BANNER);
	const veil = b.add(VEIL);
	const warden = b.add(WARDEN, { player: 1 });
	const seraph = b.add(SERAPH);
	b.add(TRINKET);
	const sluggard = b.add(SLUGGARD, { player: 1 });
	return { b, kite, banner, veil, warden, seraph, sluggard };
}

/** Mutations of fingerprinted layer inputs, each applied in place. */
function mutations(f: Fixture): Array<[string, () => void]> {
	const s = f.b.state;
	return [
		['veil on the warden (loses all abilities)', () => (f.veil.attachedToId = f.warden.instanceId)],
		['veil on the sluggard', () => (f.veil.attachedToId = f.sluggard.instanceId)],
		['veil detached', () => (f.veil.attachedToId = null)],
		['third artifact (seraph condition)', () => f.b.add(TRINKET)],
		['banner phased out', () => (f.banner.phasedOut = true)],
		['banner phased in', () => (f.banner.phasedOut = false)],
		['kite tapped', () => (f.kite.tapped = true)],
		['kite +1/+1 counters', () => (f.kite.counters['+1/+1'] = 2)],
		['kite temp pump', () => (f.kite.tempPowerMod = 3)],
		['kite granted keyword', () => f.kite.grantedKeywords.push('haste')],
		['life change', () => (s.players[0].life -= 7)],
		['warden controller loses', () => (s.players[1].lost = true)],
		['warden controller back', () => (s.players[1].lost = false)],
		['kite card replaced wholesale', () => (f.kite.card = { ...f.kite.card, name: 'Cloudmere Kite' })]
	];
}

afterEach(() => {
	setLayerCacheCheck(null);
});

// ---- Tests ----------------------------------------------------------------------------------

describe('Layer cache stable-input scopes (Phase 6c)', () => {
	it('outside a scope, every query revalidates after in-place mutations', () => {
		const f = fixture();
		assertFresh(f.b.state, 'initial');
		for (const [name, mutate] of mutations(f)) {
			mutate();
			assertFresh(f.b.state, name);
		}
	});

	it('inside a scope, mutations followed by noteLayerInputsChanged give fresh results', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const f = fixture();
		withStableLayerInputs(f.b.state, () => {
			assert.ok(inStableLayerScope());
			assertFresh(f.b.state, 'initial');
			for (const [name, mutate] of mutations(f)) {
				mutate();
				noteLayerInputsChanged(f.b.state);
				assertFresh(f.b.state, `in scope: ${name}`);
			}
		});
		assert.ok(!inStableLayerScope());
		const after = layerCacheCheckStats();
		assert.ok(after.scopeChecks > before.scopeChecks, 'trusted hits were re-validated');
		assert.equal(after.mismatches, before.mismatches);
	});

	it('a mutation inside a scope without noteLayerInputsChanged is stale, and check mode throws', () => {
		const f = fixture();
		const s = f.b.state;
		// Without check mode the scope trusts its first validation (this is the contract callers keep).
		setLayerCacheCheck(false);
		withStableLayerInputs(s, () => {
			assert.equal(permanentHasLostAllAbilities(f.warden, s).lost, false);
			f.veil.attachedToId = f.warden.instanceId;
			assert.equal(permanentHasLostAllAbilities(f.warden, s).lost, false, 'trusted (stale) answer');
			assert.equal(
				withoutLayerCache(() => permanentHasLostAllAbilities(f.warden, s).lost),
				true,
				'fresh answer'
			);
		});
		// Leaving the scope drops the trust.
		assert.equal(permanentHasLostAllAbilities(f.warden, s).lost, true);
		assertFresh(s, 'after scope');

		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const errors = mock.method(console, 'error', () => {});
		try {
			assert.throws(
				() =>
					withStableLayerInputs(s, () => {
						evaluatePermanent(s, f.kite);
						f.kite.counters['+1/+1'] = 5;
						evaluatePermanent(s, f.kite);
					}),
				/stable-scope violation/
			);
		} finally {
			errors.mock.restore();
		}
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches + 1);
		assert.ok(!inStableLayerScope(), 'a throw still closes the scope');
		assertFresh(s, 'after violation');
	});

	it('zone funnels drop scope trust without an explicit note', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const f = fixture();
		const s = f.b.state;
		withStableLayerInputs(s, () => {
			assertFresh(s, 'initial');
			transferBattlefieldControl(f.banner, s.players[0], s.players[1], s);
			assertFresh(s, 'banner changes control');
			moveObject(s, f.seraph, 'graveyard', {
				from: { player: s.players[0], zone: 'battlefield' },
				leaveBattlefieldReset: true,
				emit: false
			});
			assertFresh(s, 'seraph to the graveyard');
			moveObject(s, f.veil, 'exile', {
				from: { player: s.players[0], zone: 'battlefield' },
				leaveBattlefieldReset: true,
				emit: false
			});
			assertFresh(s, 'veil exiled');
		});
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches);
	});

	it('queries inside whileLayerInputsChange are never trusted', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const f = fixture();
		const s = f.b.state;
		withStableLayerInputs(s, () => {
			evaluatePermanent(s, f.kite);
			whileLayerInputsChange(s, () => {
				f.veil.attachedToId = f.kite.instanceId;
				// Half-way through a change: must see the new attachment, not the trusted board.
				assert.equal(permanentHasLostAllAbilities(f.kite, s).lost, true);
				f.kite.counters['+1/+1'] = 1;
				assertFresh(s, 'mid-change');
			});
			assertFresh(s, 'after change');
		});
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches);
	});

	it('a scope only trusts the state it declared; other states revalidate', () => {
		setLayerCacheCheck(false);
		const f = fixture();
		const other = fixture();
		withStableLayerInputs(f.b.state, () => {
			evaluatePermanent(f.b.state, f.kite);
			assert.equal(permanentHasLostAllAbilities(other.warden, other.b.state).lost, false);
			other.veil.attachedToId = other.warden.instanceId; // no note: `other` isn't declared
			assert.equal(permanentHasLostAllAbilities(other.warden, other.b.state).lost, true);
			assertFresh(other.b.state, 'undeclared state in scope');
		});
	});

	it('nested scopes share trust and the outer scope keeps it after the inner one exits', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const f = fixture();
		const s = f.b.state;
		withStableLayerInputs(s, () => {
			evaluatePermanent(s, f.kite);
			withStableLayerInputs(s, () => {
				evaluatePermanent(s, f.banner);
				assert.ok(inStableLayerScope());
			});
			assert.ok(inStableLayerScope());
			f.kite.tapped = true;
			noteLayerInputsChanged(s);
			assertFresh(s, 'outer scope after inner exit');
		});
		assert.ok(!inStableLayerScope());
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches);
	});

	it('checkStateBasedActions (scoped SBA scans) matches fresh evaluation', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const f = fixture();
		const s = f.b.state;
		s.status = 'active';
		// An Aura whose host is gone, a creature with lethal damage and one with 0 toughness.
		f.veil.attachedToId = 'nowhere';
		f.kite.damageMarked = 9;
		f.seraph.counters['-1/-1'] = 5; // 4/4 +1/+1 from the banner
		checkStateBasedActions(s);
		assert.ok(!inStableLayerScope());
		assertFresh(s, 'after SBAs');
		const names = s.players.flatMap((p) => p.battlefield.map((c) => c.card.name));
		assert.ok(!names.includes('Cloudmere Kite'), 'lethal damage');
		assert.ok(!names.includes('Metalwork Seraph'), '0 toughness');
		assert.ok(!names.includes('Shroud of Forgetting'), 'unattached Aura');
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches);
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

describe('Layer cache scopes: seeded 4-bot game (Phase 6c)', () => {
	it('seed 3: trusted hits are re-validated during play and nothing goes stale', () => {
		let clock = 1_700_000_000_000;
		mock.method(Math, 'random', mulberry32(3));
		mock.method(Date, 'now', () => (clock += 7));
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		try {
			const decks = new Map(botSeats(4).map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]]));
			const state = createInitialGameState('SCOPE', botSeats(4), decks, { ...DEFAULT_LOBBY_RULES });
			for (let tick = 0; tick < 4 && state.status === 'active'; tick++) {
				runAutomatedPriorityAndBots(state);
				setLayerCacheCheck(false);
				assertFresh(state, `tick ${tick}`);
				setLayerCacheCheck(true);
			}
			const after = layerCacheCheckStats();
			assert.ok(after.scopeChecks > before.scopeChecks, 'scopes were used during play');
			assert.equal(after.mismatches, before.mismatches, 'no stale results or scope violations');
		} finally {
			mock.restoreAll();
		}
	});
});
