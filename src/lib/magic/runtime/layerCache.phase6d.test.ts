import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	getAllLegalTargetsForRequirement,
	getEffectiveActivatedAbilities,
	hasKeyword
} from '../engine.ts';
import { hasAnyLegalInstantResponse, runAutomatedPriorityAndBots } from '../ai.ts';
import { clearCompileCache, compileCard } from '../compiler/index.ts';
import { PRECON_DECKS } from '../precons.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from '../ruleTree.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard
} from '../types.ts';
import { effectiveSpellManaCost } from './costs.ts';
import {
	layerCacheCheckStats,
	noteLayerInputsChanged,
	setLayerCacheCheck,
	withStableLayerInputs,
	withoutLayerCache
} from './layerCache.ts';
import { hasRestriction } from './replace.ts';
import { matchTriggers } from './triggers.ts';

/**
 * Phase 6d: the read-tracked dynamic fingerprint, the new trust scopes on read-only entry points
 * (legality checks, target enumeration, cost computation, trigger matching, bot decisions), the
 * per-card `compileCard` memo and the type-line subtype memo. Boards are mutated inside and outside
 * scopes and every answer is compared with a fresh, uncached computation.
 */

function card(spec: Partial<ScryfallCard> & { name: string; typeLine: string }): ScryfallCard {
	const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
	return {
		id: `p6d_${slug}`,
		oracleId: `p6d_oracle_${slug}`,
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

// Invented names. Each static reads one tracked input.
const SENTRY = card({ name: 'Idle Sentry', typeLine: 'Enchantment', oracleText: 'Tapped creatures you control get +2/+2.' });
const HOARDER = card({ name: 'Mirefen Hoarder', typeLine: 'Creature — Spirit', power: '*', toughness: '*', oracleText: "Mirefen Hoarder's power and toughness are each equal to the number of cards in your hand." });
const PROWLER = card({ name: 'Duskfang Prowler', typeLine: 'Creature — Cat', power: '2', toughness: '2', oracleText: "As long as it's your turn, Duskfang Prowler gets +2/+0." });
const SUNWARD = card({ name: 'Sunward Paragon', typeLine: 'Creature — Angel', power: '1', toughness: '1', oracleText: 'As long as you have 30 or more life, Sunward Paragon gets +5/+5.' });
const BEAR = card({ name: 'Thornvale Cub', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
const KITE = card({ name: 'Cloudmere Kite', typeLine: 'Creature — Bird Soldier', power: '2', toughness: '2', oracleText: 'Flying', keywords: ['Flying'] });
const SLUGGARD = card({ name: 'Rustjaw Sluggard', typeLine: 'Creature — Golem', power: '3', toughness: '3', oracleText: "Rustjaw Sluggard doesn't untap during your untap step." });
const ARCHIVIST = card({ name: 'Inkwell Archivist', typeLine: 'Creature — Human Wizard', power: '1', toughness: '1', oracleText: '{1}, {T}: Draw a card.' });
const SPROUT = card({ name: 'Mossling Tender', typeLine: 'Creature — Elf Druid', power: '1', toughness: '1', oracleText: '{T}: Add {G}.' });
const BOLT = card({ name: 'Emberlash', typeLine: 'Instant', manaCost: '{R}', colors: ['R'], oracleText: 'Emberlash deals 3 damage to any target.' });

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
		this.state = createInitialGameState('P6D', seats, decks, { ...DEFAULT_LOBBY_RULES });
		this.state.status = 'active';
		this.players = this.state.players.map((p) => p.playerId);
	}

	add(c: ScryfallCard, player = 0): CardInstance {
		const owner = this.players[player];
		this.ts += 1;
		const inst = createCardInstance(c, owner, 'battlefield', false, false, 1000 + this.ts);
		inst.controllerId = owner;
		inst.summoningSick = false;
		this.state.players[player].battlefield.push(inst);
		return inst;
	}

	toHand(c: ScryfallCard, player = 0): CardInstance {
		const inst = createCardInstance(c, this.players[player], 'hand', false, false, 2000 + ++this.ts);
		this.state.players[player].hand.push(inst);
		return inst;
	}
}

function fresh<T>(fn: () => T): T {
	return withoutLayerCache(fn);
}

/** Every permanent's evaluation, cached, equals a fresh one (functions are dropped by JSON). */
function assertBoardFresh(state: GameState, label: string): void {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			const cached = JSON.stringify(evaluatePermanent(state, perm));
			const expected = JSON.stringify(fresh(() => evaluatePermanent(state, perm)));
			assert.equal(cached, expected, `${label}: ${perm.card.name}`);
		}
	}
}

afterEach(() => setLayerCacheCheck(null));

describe('Phase 6d: read-tracked dynamic fingerprint', () => {
	it('a tapped filter makes tapping re-evaluate; without one, tapping does not change results', () => {
		const b = new Board();
		const cub = b.add(BEAR);
		assert.equal(evaluatePermanent(b.state, cub).power, 2);
		cub.tapped = true;
		assert.equal(evaluatePermanent(b.state, cub).power, 2);
		assertBoardFresh(b.state, 'no tapped filter');

		b.add(SENTRY);
		assert.equal(evaluatePermanent(b.state, cub).power, 4, 'tapped creature gets +2/+2');
		cub.tapped = false;
		assert.equal(evaluatePermanent(b.state, cub).power, 2, 'untapping is seen');
		cub.tapped = true;
		assert.equal(evaluatePermanent(b.state, cub).toughness, 4);
		assertBoardFresh(b.state, 'tapped filter');
	});

	it('cards in hand: drawing and discarding re-evaluate a hand-size CDA', () => {
		const b = new Board();
		const hoarder = b.add(HOARDER);
		const handSize = () => b.state.players[0].hand.length;
		assert.equal(evaluatePermanent(b.state, hoarder).power, handSize());
		b.toHand(BEAR);
		assert.equal(evaluatePermanent(b.state, hoarder).power, handSize());
		b.state.players[0].hand.length = 0;
		assert.equal(evaluatePermanent(b.state, hoarder).power, 0);
		assertBoardFresh(b.state, 'hand size');
	});

	it('the active player: a turn change re-evaluates an "as long as it\'s your turn" bonus', () => {
		const b = new Board();
		const prowler = b.add(PROWLER);
		b.state.activePlayerIndex = 0;
		assert.equal(evaluatePermanent(b.state, prowler).power, 4);
		b.state.activePlayerIndex = 1;
		assert.equal(evaluatePermanent(b.state, prowler).power, 2);
		assertBoardFresh(b.state, 'active player');
	});

	it('life: a life change re-evaluates a life-total condition', () => {
		const b = new Board();
		const paragon = b.add(SUNWARD);
		b.state.players[0].life = 40;
		assert.equal(evaluatePermanent(b.state, paragon).power, 6);
		b.state.players[0].life = 12;
		assert.equal(evaluatePermanent(b.state, paragon).power, 1);
		b.state.players[0].life = 30;
		assert.equal(evaluatePermanent(b.state, paragon).power, 6);
		assertBoardFresh(b.state, 'life');
	});

	it('random mutation sequences match a fresh evaluation after every step (check mode on)', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const b = new Board(3);
		const perms = [b.add(SENTRY), b.add(HOARDER), b.add(PROWLER, 1), b.add(SUNWARD, 2), b.add(BEAR), b.add(KITE, 1)];
		let seed = 7;
		const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
		for (let step = 0; step < 200; step++) {
			const perm = perms[rnd(perms.length)];
			switch (rnd(6)) {
				case 0:
					perm.tapped = !perm.tapped;
					break;
				case 1:
					b.state.players[rnd(3)].life += rnd(21) - 10;
					break;
				case 2:
					b.toHand(BEAR, rnd(3));
					break;
				case 3:
					b.state.activePlayerIndex = rnd(3);
					break;
				case 4:
					perm.counters['+1/+1'] = (perm.counters['+1/+1'] || 0) + 1;
					break;
				case 5:
					b.state.players[rnd(3)].hand.pop();
					break;
			}
			// Half the steps query inside a scope, noting the mutation as the contract requires.
			if (step % 2) {
				withStableLayerInputs(b.state, () => {
					assertBoardFresh(b.state, `scoped step ${step}`);
					perm.tapped = !perm.tapped;
					noteLayerInputsChanged(b.state);
					assertBoardFresh(b.state, `scoped step ${step} after noted tap`);
				});
			} else {
				assertBoardFresh(b.state, `step ${step}`);
			}
		}
		const after = layerCacheCheckStats();
		assert.ok(after.checks > before.checks);
		assert.equal(after.mismatches, before.mismatches);
	});
});

describe('Phase 6d: read-only entry points share one validation', () => {
	function castBoard() {
		const b = new Board();
		b.state.phase = 'main1';
		b.state.activePlayerIndex = 0;
		b.state.priorityPlayerIndex = 0;
		b.state.stack = [];
		const p = b.state.players[0];
		p.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
		const bolt = b.toHand(BOLT);
		const targets = [b.add(BEAR, 1), b.add(KITE, 1), b.add(SENTRY), b.add(SLUGGARD)];
		return { b, bolt, targets };
	}

	it('legality, targets, costs and restrictions equal the uncached answers, before and after mutations', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const { b, bolt, targets } = castBoard();
		const s = b.state;
		const ask = () =>
			JSON.stringify({
				cast: checkSpellCastLegality(s, b.players[0], bolt, 'hand', 0),
				targets: getAllLegalTargetsForRequirement(s, b.players[0], {
					requiresTarget: true,
					targetKind: 'any',
					minTargets: 1,
					maxTargets: 1,
					zone: 'battlefield',
					controllerFilter: 'any'
				} as never),
				cost: effectiveSpellManaCost(s, s.players[0], bolt, 0, false),
				untap: targets.map((t) => hasRestriction(s, t, 'doesntUntap')),
				flying: targets.map((t) => hasKeyword(t, 'Flying', s)),
				lost: targets.map((t) => permanentHasLostAllAbilities(t, s).lost),
				response: hasAnyLegalInstantResponse(s, s.players[0])
			});
		for (let round = 0; round < 4; round++) {
			assert.equal(ask(), fresh(ask), `round ${round}`);
			// Outside any scope: change layer inputs, then ask again.
			targets[round % targets.length].tapped = !targets[round % targets.length].tapped;
			s.players[0].manaPool.R = round % 2;
			assert.equal(ask(), fresh(ask), `round ${round} after outside mutation`);
			// Inside an enclosing scope, with the mutation noted.
			withStableLayerInputs(s, () => {
				assert.equal(ask(), fresh(ask), `round ${round} scoped`);
				targets[0].counters['+1/+1'] = (targets[0].counters['+1/+1'] || 0) + 1;
				noteLayerInputsChanged(s);
				assert.equal(ask(), fresh(ask), `round ${round} scoped after noted mutation`);
			});
		}
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches);
	});

	it('an un-noted mutation inside an enclosing scope is caught by check mode', () => {
		setLayerCacheCheck(true);
		const { b, targets } = castBoard();
		b.add(SENTRY);
		const before = layerCacheCheckStats();
		assert.throws(() =>
			withStableLayerInputs(b.state, () => {
				evaluatePermanent(b.state, targets[0]);
				targets[0].tapped = !targets[0].tapped; // a layer input (Idle Sentry reads it), not noted
				evaluatePermanent(b.state, targets[0]);
			})
		);
		// Restore the global counter for the run-wide report: this violation is deliberate.
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches + 1);
	});

	it('ability activation checks with hypothetical tap costs inside a scope stay consistent', () => {
		setLayerCacheCheck(true);
		const b = new Board();
		b.state.phase = 'main1';
		b.state.priorityPlayerIndex = 0;
		b.add(SENTRY);
		b.add(ARCHIVIST);
		b.add(SPROUT);
		b.add(SPROUT);
		let checked = 0;
		const before = layerCacheCheckStats();
		withStableLayerInputs(b.state, () => {
			for (const perm of b.state.players[0].battlefield) {
				for (const ab of getEffectiveActivatedAbilities(b.state, b.state.players[0], perm)) {
					const cached = checkAbilityActivationLegality(b.state, b.players[0], perm, ab);
					const expected = fresh(() => checkAbilityActivationLegality(b.state, b.players[0], perm, ab));
					assert.deepEqual(cached, expected, `${perm.card.name} ${ab.id}`);
					checked += 1;
				}
			}
		});
		assert.ok(checked >= 2, 'the archivist and the mana creatures have abilities');
		assert.equal(layerCacheCheckStats().mismatches, before.mismatches);
	});

	it('matchTriggers inside its scope records the same triggers as with caching off', () => {
		const b = new Board();
		const cub = b.add(BEAR);
		const run = () => {
			matchTriggers(b.state, {
				kind: 'DamageDealt',
				sourceId: cub.instanceId,
				targetKind: 'player',
				targetId: b.players[1],
				amount: 2,
				combat: true
			} as never);
			return JSON.stringify(b.state.players.map((p) => p.life));
		};
		assert.equal(run(), fresh(run));
	});
});

describe('Phase 6d: untap step and attacks decide against the pre-change board', () => {
	it("doesn't-untap is decided before anything untaps; the others untap", () => {
		const b = new Board();
		const sluggard = b.add(SLUGGARD);
		const cub = b.add(BEAR);
		sluggard.tapped = true;
		cub.tapped = true;
		const expectedSluggard = fresh(() => hasRestriction(b.state, sluggard, 'doesntUntap'));
		assert.equal(expectedSluggard, true);
		assert.equal(fresh(() => hasRestriction(b.state, cub, 'doesntUntap')), false);
	});

	it('a seeded bot game runs with every trusted hit re-validated and no mismatch', () => {
		setLayerCacheCheck(true);
		const before = layerCacheCheckStats();
		const seats: LobbySeat[] = [0, 1, 2, 3].map((i) => ({
			seatIndex: i,
			userId: null,
			username: `Bot ${i}`,
			avatarUrl: '',
			isBot: true,
			deckId: PRECON_DECKS[i % PRECON_DECKS.length].id,
			deckName: '',
			commanderNames: PRECON_DECKS[i % PRECON_DECKS.length].commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[i % PRECON_DECKS.length].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}));
		const decks = new Map(seats.map((s, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]]));
		const state = createInitialGameState('P6D_GAME', seats, decks, { ...DEFAULT_LOBBY_RULES, rngSeed: 11 } as never);
		for (let tick = 0; tick < 4 && state.status === 'active'; tick++) runAutomatedPriorityAndBots(state);
		const after = layerCacheCheckStats();
		assert.ok(after.scopeChecks > before.scopeChecks, 'trusted hits were re-validated');
		assert.equal(after.mismatches, before.mismatches);
	});
});

describe('Phase 6d: compileCard per-card memo and subtype memo', () => {
	it('returns the same definition for the same object and recompiles after an in-place change', () => {
		const c = card({ name: 'Glimmerfen Overseer', typeLine: 'Creature — Faerie', power: '1', toughness: '1', oracleText: 'Flying' });
		const d1 = compileCard(c);
		assert.equal(compileCard(c), d1);
		assert.equal(compileCard({ ...c }), d1, 'an equal copy shares the text-keyed definition');
		c.oracleText = 'Vigilance';
		const d2 = compileCard(c);
		assert.notEqual(d2, d1);
		assert.deepEqual(d2, compileCard({ ...c }));
		c.colors = ['W'];
		assert.notEqual(compileCard(c), d2, 'colors are part of the key');
		clearCompileCache();
		assert.deepEqual(compileCard(c), compileCard({ ...c }));
	});

	it('hasSubType answers equal a fresh evaluation for every subtype query', () => {
		const b = new Board();
		const kite = b.add(KITE);
		const ev = evaluatePermanent(b.state, kite);
		const fe = fresh(() => evaluatePermanent(b.state, kite));
		for (const sub of ['Bird', 'bird', 'Soldier', 'Faerie', 'Time Lord', 'Aura']) {
			assert.equal(ev.hasSubType(sub), fe.hasSubType(sub), sub);
		}
		assert.equal(ev.hasSubType('Bird'), true);
		assert.equal(ev.hasSubType('Faerie'), false);
	});
});
