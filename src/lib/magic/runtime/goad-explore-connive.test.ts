import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { PREDEFINED_TOKEN_DEFS } from '../oracle.ts';
import { PRECON_DECKS } from '../precons.ts';
import { subscribeEvents, type GameEvent } from './events.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
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

function createGame(playerCount: 2 | 3, botMask: boolean[] = []): GameState {
	const seats: LobbySeat[] = Array.from({ length: playerCount }, (_, i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length];
		return {
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: Boolean(botMask[i]),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: deck.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: deck.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		};
	});
	const decks = new Map(seats.map((s, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]]));
	const state = createInitialGameState('TRACKD1', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		if (!p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
		p.hand = [];
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return state;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const ts = allocateTimestamp(state);
	const inst = createCardInstance(card, player.playerId, zone, false, false, ts, state);
	inst.summoningSick = false;
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		...(zone === 'library' ? { insert: 'start' } : {}),
		bumpVersion: true
	});
	return inst;
}

function passAllPriority(state: GameState, maxSteps = 20): void {
	for (let i = 0; i < maxSteps && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		if (!prio || prio.lost) break;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
	}
}

function passUntilTopResolves(state: GameState, maxSteps = 10): void {
	const topId = state.stack[state.stack.length - 1]?.id;
	if (!topId) return;
	for (let i = 0; i < maxSteps && state.stack.some((item) => item.id === topId) && state.pendingPrompts.length === 0; i++) {
		const prio = state.players[state.priorityPlayerIndex];
		if (!prio || prio.lost) break;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
	}
}

function advanceTurnViaPriority(state: GameState, targetActiveIdx?: number, stopPhase?: string): void {
	const startIdx = state.activePlayerIndex;
	for (let guard = 0; guard < 100; guard++) {
		if (targetActiveIdx !== undefined && state.activePlayerIndex === targetActiveIdx && (!stopPhase || state.phase === stopPhase)) {
			return;
		}
		if (targetActiveIdx === undefined && state.activePlayerIndex !== startIdx) {
			return;
		}
		const prio = state.players[state.priorityPlayerIndex];
		assert.ok(prio && !prio.lost, 'expected active priority player');
		if (state.phase === 'declare_attackers' && prio.playerId === state.players[state.activePlayerIndex].playerId && !state.combat) {
			const res = applyGameAction(state, prio.playerId, { type: 'declare_attackers', assignments: [] });
			assert.equal(res.ok, true, res.error ?? 'declare_attackers failed');
			continue;
		}
		if (state.phase === 'declare_blockers' && state.combat?.attackers?.length && !state.combat.blockersDeclared) {
			const res = applyGameAction(state, prio.playerId, { type: 'declare_blockers', assignments: [] });
			assert.equal(res.ok, true, res.error ?? 'declare_blockers failed');
			continue;
		}
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `[active=${state.activePlayerIndex}, phase=${state.phase}, prio=${prio.playerId}] ${res.error}`);
	}
	assert.fail(`advanceTurnViaPriority did not reach target (${targetActiveIdx}, ${stopPhase}); stuck at ${state.activePlayerIndex} / ${state.phase}`);
}

function jsonRoundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

describe('Track D Slice 1: Draw-then-discard runtime', () => {
	it('human draws before discard prompt pauses and survives JSON round-trip cleanly', () => {
		let state = createGame(2);
		const p1 = state.players[0];
		p1.manaPool.U = 5;
		p1.hand = [];
		const kept = putInZone(state, p1, makeCard({ name: 'Kept Relic', typeLine: 'Artifact' }), 'hand');
		const spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Sift Probe',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Draw two cards, then discard two cards.'
			}),
			'hand'
		);
		const top1 = putInZone(state, p1, makeCard({ name: 'Top Card One', typeLine: 'Instant' }), 'library');
		const top2 = putInZone(state, p1, makeCard({ name: 'Top Card Two', typeLine: 'Sorcery' }), 'library');

		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		passAllPriority(state);

		// Should have paused for human discard after drawing BOTH cards (3 in hand total: kept + top2 + top1).
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.players[0].hand.length, 3);
		assert.equal(state.pendingPrompts[0].choice?.kind, 'chooseObjects');

		state = jsonRoundTrip(state);
		const prompt = state.pendingPrompts[0];
		const res = applyGameAction(state, state.players[0].playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseObjects', objectIds: [top1.instanceId, top2.instanceId] }
		});
		assert.equal(res.ok, true, res.error ?? 'choice failed');
		assert.equal(state.stack.length, 0);
		assert.equal(state.players[0].hand.map((c) => c.instanceId).join(','), kept.instanceId);
		assert.equal(state.players[0].graveyard.some((c) => c.instanceId === top1.instanceId), true);
		assert.equal(state.players[0].graveyard.some((c) => c.instanceId === top2.instanceId), true);
	});

	it('bot resolves draw-then-discard deterministically without pausing', () => {
		const state = createGame(2, [true, false]);
		const bot = state.players[0];
		bot.manaPool.R = 5;
		bot.hand = [];
		const spell = putInZone(
			state,
			bot,
			makeCard({
				name: 'Bot Looter',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Draw two cards, then discard a card.'
			}),
			'hand'
		);
		putInZone(state, bot, makeCard({ name: 'Lib A', typeLine: 'Artifact' }), 'library');
		putInZone(state, bot, makeCard({ name: 'Lib B', typeLine: 'Land' }), 'library');

		assert.equal(applyGameAction(state, bot.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		passAllPriority(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(bot.hand.length, 1);
		assert.equal(bot.graveyard.some((c) => c.card.name !== 'Bot Looter'), true);
	});
});

describe('Track D Slice 1: Goad runtime (CR 701.15a–d, CR 800.4m)', () => {
	it('enforces mandatory attack, non-goader preference, persistence across other turns, and goader turn-start expiration', () => {
		const state = createGame(3);
		const [p1, p2, p3] = state.players;
		p1.manaPool.R = 6;

		const bearCard = makeCard({
			name: 'Goaded Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		const bear = putInZone(state, p2, bearCard, 'battlefield');

		const goadSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Mocking Spell',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Goad target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: goadSpell.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		passAllPriority(state);

		assert.deepEqual(bear.goadedByPlayerIds, [p1.playerId]);
		assert.deepEqual(bear.goadExpirations, { [p1.playerId]: 'untilYourNextTurn' });

		// Deduplication CR 701.15d
		const goadSpell2 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Mocking Spell',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Goad target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: goadSpell2.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		passAllPriority(state);
		assert.deepEqual(bear.goadedByPlayerIds, [p1.playerId]);

		// Explicit "until end of turn" by same goader should not downgrade untilYourNextTurn
		const eotSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Quick Jeer',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Until end of turn, goad target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: eotSpell.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		passAllPriority(state);
		assert.equal(bear.goadExpirations?.[p1.playerId], 'untilYourNextTurn');

		// Pass P1 -> P2's declare_attackers
		advanceTurnViaPriority(state, 1, 'declare_attackers');
		assert.equal(state.activePlayerIndex, 1);
		assert.deepEqual(bear.goadedByPlayerIds, [p1.playerId]);

		// Reject skipping attack
		const noAtk = applyGameAction(state, p2.playerId, { type: 'declare_attackers', assignments: [] });
		assert.equal(noAtk.ok, false);

		// Reject attacking goader P1 when P3 is alive
		const atkGoader = applyGameAction(state, p2.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p1.playerId }]
		});
		assert.equal(atkGoader.ok, false);

		// Legal: attack P3
		const atkP3 = applyGameAction(state, p2.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p3.playerId }]
		});
		assert.equal(atkP3.ok, true, atkP3.error ?? 'declare_attackers failed');
		// Advance through P2 -> P3
		advanceTurnViaPriority(state, 2);
		assert.equal(state.activePlayerIndex, 2);
		assert.deepEqual(bear.goadedByPlayerIds, [p1.playerId]);

		// Advance P3 -> P1's next turn: goad expires at beginning of P1's turn!
		advanceTurnViaPriority(state, 0);
		assert.equal(state.activePlayerIndex, 0);
		assert.equal(bear.goadedByPlayerIds, undefined);
		assert.equal(bear.goadExpirations, undefined);
	});

	it('can attack goader in 2-player game and handles multi-goader (CR 701.15c), blink reset, and EOT goad', () => {
		const state2p = createGame(2);
		const [h1, h2] = state2p.players;
		const p2Bear = putInZone(
			state2p,
			h2,
			makeCard({ name: 'Solo Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		h1.manaPool.R = 5;
		const eot = putInZone(
			state2p,
			h1,
			makeCard({
				name: 'Brief Taunt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Goad target creature until end of turn.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state2p, h1.playerId, {
				type: 'cast_spell',
				instanceId: eot.instanceId,
				targets: [{ kind: 'permanent', id: p2Bear.instanceId, label: p2Bear.card.name }]
			}).ok,
			true
		);
		passAllPriority(state2p);
		assert.deepEqual(p2Bear.goadExpirations, { [h1.playerId]: 'endOfTurn' });

		// Pass P1's turn -> EOT cleanup clears 'endOfTurn' goad
		advanceTurnViaPriority(state2p, 1, 'main1');
		assert.equal(p2Bear.goadedByPlayerIds, undefined);
		assert.equal(p2Bear.goadExpirations, undefined);

		// Advance P2 -> H1's main1, then goad in 2P with standard goad -> P2 CAN attack H1 since no other opponent exists
		advanceTurnViaPriority(state2p, 0, 'main1');
		h1.manaPool.R = 5;
		const goad2p = putInZone(
			state2p,
			h1,
			makeCard({ name: 'Long Taunt', manaCost: '{R}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Goad target creature.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state2p, h1.playerId, {
				type: 'cast_spell',
				instanceId: goad2p.instanceId,
				targets: [{ kind: 'permanent', id: p2Bear.instanceId, label: p2Bear.card.name }]
			}).ok,
			true
		);
		passAllPriority(state2p);
		advanceTurnViaPriority(state2p, 1, 'declare_attackers');
		assert.equal(
			applyGameAction(state2p, h2.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: p2Bear.instanceId, defenderPlayerId: h1.playerId }]
			}).ok,
			true
		);

		// Blink / leave battlefield resets goadedByPlayerIds and goadExpirations
		moveObject(state2p, p2Bear, 'exile', {
			from: { player: h2, zone: 'battlefield' },
			toPlayer: h2,
			leaveBattlefieldReset: true,
			bumpVersion: true
		});
		assert.equal(p2Bear.goadedByPlayerIds, undefined);
		assert.equal(p2Bear.goadExpirations, undefined);
	});

	it('preserves remaining goaders when one expires (CR 701.15c) and expires goad of eliminated player when their turn would begin (CR 800.4m)', () => {
		const state = createGame(3);
		const [p1, p2, p3] = state.players;
		const target = putInZone(
			state,
			p3,
			makeCard({ name: 'Target Brute', typeLine: 'Creature — Ogre', power: '3', toughness: '3' }),
			'battlefield'
		);

		// P1 goads target
		p1.manaPool.R = 5;
		const g1 = putInZone(
			state,
			p1,
			makeCard({ name: 'P1 Taunt', manaCost: '{R}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Goad all creatures target player controls.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: g1.instanceId,
				targets: [{ kind: 'player', id: p3.playerId, label: p3.username }]
			}).ok,
			true
		);
		passAllPriority(state);

		// Advance to P2's main1 and P2 also goads target
		advanceTurnViaPriority(state, 1, 'main1');
		assert.equal(state.activePlayerIndex, 1);
		p2.manaPool.R = 5;
		const g2 = putInZone(
			state,
			p2,
			makeCard({ name: 'P2 Taunt', manaCost: '{R}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Goad each creature your opponents control.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: g2.instanceId }).ok, true);
		passAllPriority(state);
		assert.deepEqual(target.goadedByPlayerIds?.sort(), [p1.playerId, p2.playerId].sort());

		// Eliminate P1 before P3 passes turn -> CR 800.4m keeps P1 goad through P3's turn, then expires when P1's next turn would begin!
		p1.lost = true;
		advanceTurnViaPriority(state, 2, 'main1');
		assert.equal(state.activePlayerIndex, 2);
		assert.deepEqual(target.goadedByPlayerIds?.sort(), [p1.playerId, p2.playerId].sort());

		// Have P3's goaded brute attack P2 so combat progresses cleanly, then pass P3's turn
		advanceTurnViaPriority(state, 2, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p3.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: target.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advanceTurnViaPriority(state, 1);
		// Skipped P1 (lost), landed on P2 -> P1 expired via CR 800.4m AND P2 expired at start of P2's turn!
		assert.equal(state.activePlayerIndex, 1);
		assert.equal(target.goadedByPlayerIds, undefined);
	});
});

describe('Track D Slice 1: Explore, Map tokens, and Triggers (CR 111.10s, 701.44)', () => {
	it('creates Map tokens and activates sorcery-only explore with land, nonland keep/graveyard, and Rest in Peace JSON round-trip', () => {
		let state = createGame(2);
		const [p1] = state.players;
		const exploredEvents: Array<Extract<GameEvent, { kind: 'Explored' }>> = [];
		subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'Explored') exploredEvents.push(ev);
		});

		p1.manaPool.G = 6;
		const mapMaker = putInZone(
			state,
			p1,
			makeCard({
				name: 'Mapmaker Scout',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Human Scout',
				power: '1',
				toughness: '2',
				oracleText:
					'When Mapmaker Scout enters, create a Map token.\nWhenever a creature you control explores, you gain 2 life.'
			}),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mapMaker.instanceId }).ok, true);
		passAllPriority(state); // Resolve creature -> ETB goes on stack
		passAllPriority(state); // Resolve ETB -> creates Map token

		const mapTok = p1.battlefield.find((c) => c.card.name === 'Map');
		assert.ok(mapTok, 'expected Map token on battlefield');
		const mapAb = getEffectiveActivatedAbilities(state, p1, mapTok).find((a) => /explores/i.test(a.effectText));
		assert.ok(mapAb);

		// Sorcery-only check: reject during combat
		state.phase = 'declare_attackers';
		const scoutOnBoard = p1.battlefield.find((c) => c.instanceId === mapMaker.instanceId)!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: mapTok.instanceId,
				abilityId: mapAb.id,
				targets: [{ kind: 'permanent', id: scoutOnBoard.instanceId, label: scoutOnBoard.card.name }]
			}).ok,
			false
		);

		// Main phase Case 1: top card is Land -> moved to hand, 0 counters, trigger heals +2
		state.phase = 'main1';
		p1.manaPool.G = 3;
		const topLand = putInZone(state, p1, makeCard({ name: 'Forest Land', typeLine: 'Basic Land — Forest' }), 'library');
		const startLife = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: mapTok.instanceId,
				abilityId: mapAb.id,
				targets: [{ kind: 'permanent', id: scoutOnBoard.instanceId, label: scoutOnBoard.card.name }]
			}).ok,
			true
		);
		passAllPriority(state); // Resolve Map ability -> explore -> ETB explore watcher trigger
		passAllPriority(state); // Resolve explore watcher trigger

		assert.equal(p1.hand.some((c) => c.instanceId === topLand.instanceId), true);
		assert.equal(scoutOnBoard.counters['+1/+1'], 0);
		assert.equal(p1.life, startLife + 2);
		assert.equal(exploredEvents.at(-1)?.revealedLand, true);

		// Case 2: Nonland -> +1/+1 counter + yesNo prompt -> JSON round-trip -> keep on top vs put in graveyard with Rest in Peace replacement pause
		p1.manaPool.G = 5;
		const rip = makeCard({
			name: 'Rest in Peace',
			typeLine: 'Enchantment',
			oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
		});
		const leyline = makeCard({
			name: 'Second RIP',
			typeLine: 'Enchantment',
			oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
		});
		putInZone(state, state.players[1], rip, 'battlefield');
		putInZone(state, state.players[1], leyline, 'battlefield');

		const nonlandSpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Relic Spell', typeLine: 'Instant', oracleText: 'Draw a card.' }),
			'library'
		);
		const exploreSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Chart Deep',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Target creature explores.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: exploreSpell.instanceId,
				targets: [{ kind: 'permanent', id: scoutOnBoard.instanceId, label: scoutOnBoard.card.name }]
			}).ok,
			true
		);
		passAllPriority(state);

		// Counter placed before prompt; yesNo prompt paused
		assert.equal(scoutOnBoard.counters['+1/+1'], 1);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].kind, 'yesNo');

		state = jsonRoundTrip(state);
		const pr1 = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: pr1.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		// Multiple replacement effects (RIP + Second RIP) pause on zone_replacement_choice (for NL, then for Chart Deep itself going to GY)!
		while (state.pendingPrompts.length > 0) {
			state = jsonRoundTrip(state);
			const pr = state.pendingPrompts[0];
			const repChoice = pr.choice?.kind === 'chooseReplacement' ? pr.choice : undefined;
			assert.ok(repChoice);
			assert.equal(
				applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseReplacement', id: repChoice.options[0].id }
				}).ok,
				true
			);
		}
		passAllPriority(state);
		// Did NOT re-add +1/+1 counter on resume! Still exactly 1 counter, card exiled, life gained +2 more.
		assert.equal(state.players[0].battlefield.find((c) => c.instanceId === scoutOnBoard.instanceId)?.counters['+1/+1'], 1);
		assert.equal(state.players[0].exile.some((c) => c.instanceId === nonlandSpell.instanceId), true);
		assert.equal(state.players[0].life, startLife + 4);
	});

	it('handles empty library (CR 701.44b), LKI when explorer leaves battlefield (CR 701.44c), and APNAP order (CR 701.44d)', () => {
		const state = createGame(2, [false, true]);
		const [p1, p2] = state.players;
		const order: string[] = [];
		subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'Explored') order.push(`${ev.playerId}:${ev.object.card.name}:${ev.revealedLand}`);
		});

		// Empty library still triggers "explores" (CR 701.44b)
		p1.library = [];
		p1.manaPool.G = 6;
		const emptyScout = putInZone(
			state,
			p1,
			makeCard({
				name: 'Dry Scout',
				typeLine: 'Creature — Scout',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever ~ explores, you gain 3 life.'
			}),
			'battlefield'
		);
		const expSpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Explore Empty', manaCost: '{G}', typeLine: 'Sorcery', oracleText: 'Target creature explores.' }),
			'hand'
		);
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: expSpell.instanceId,
				targets: [{ kind: 'permanent', id: emptyScout.instanceId, label: emptyScout.card.name }]
			}).ok,
			true
		);
		passAllPriority(state);
		passAllPriority(state);
		assert.equal(p1.life, lifeBefore + 3);
		assert.deepEqual(order, [`${p1.playerId}:Dry Scout:false`]);

		// LKI CR 701.44c: ETB explorer removed before trigger resolves -> controller still gets land to hand, trigger still fires
		order.length = 0;
		const watcher = putInZone(
			state,
			p1,
			makeCard({
				name: 'LKI Watcher',
				typeLine: 'Creature — Wizard',
				power: '1',
				toughness: '1',
				oracleText: 'Whenever a creature you control explores, you gain 1 life.'
			}),
			'battlefield'
		);
		const topLand = putInZone(state, p1, makeCard({ name: 'Swamp Land', typeLine: 'Basic Land — Swamp' }), 'library');
		const etbScout = putInZone(
			state,
			p1,
			makeCard({
				name: 'Fleeting Explorer',
				manaCost: '{G}',
				typeLine: 'Creature — Elf Scout',
				power: '1',
				toughness: '1',
				oracleText: 'When Fleeting Explorer enters, it explores.'
			}),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: etbScout.instanceId }).ok, true);
		passUntilTopResolves(state); // Resolve creature -> ETB explore is now on the stack!
		const etbBoard = p1.battlefield.find((c) => c.instanceId === etbScout.instanceId)!;
		moveObject(state, etbBoard, 'graveyard', { from: { player: p1, zone: 'battlefield' }, toPlayer: p1, bumpVersion: true });
		const lifePreLki = p1.life;
		passAllPriority(state); // Resolve ETB explore using LKI -> reveals Land to P1 hand + triggers LKI Watcher!
		passAllPriority(state);
		assert.ok(watcher);
		assert.equal(p1.hand.some((c) => c.instanceId === topLand.instanceId), true);
		assert.equal(p1.life, lifePreLki + 1);
		assert.equal(order[0], `${p1.playerId}:Fleeting Explorer:true`);

		// APNAP CR 701.44d: "Each creature explores." -> active player's creature explores first
		order.length = 0;
		putInZone(state, p1, makeCard({ name: 'Active Land', typeLine: 'Land' }), 'library');
		putInZone(state, p2, makeCard({ name: 'NonActive Land', typeLine: 'Land' }), 'library');
		putInZone(state, p2, makeCard({ name: 'P2 Creature', typeLine: 'Creature', power: '1', toughness: '1' }), 'battlefield');
		const massExplore = putInZone(
			state,
			p1,
			makeCard({ name: 'Mass Explore', manaCost: '{G}', typeLine: 'Sorcery', oracleText: 'Each creature explores.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: massExplore.instanceId }).ok, true);
		passAllPriority(state);
		passAllPriority(state);
		const p1FirstIdx = order.findIndex((s) => s.startsWith(p1.playerId));
		const p2Idx = order.findIndex((s) => s.startsWith(p2.playerId));
		assert.ok(p1FirstIdx >= 0 && p2Idx > p1FirstIdx);
	});
});

describe('Track D Slice 1: Connive / Connive N (CR 701.50a–f) and Rename Invariance', () => {
	it('connives 2, pauses human discard without re-drawing across JSON round-trip + Rest in Peace, counts nonlands, and triggers', () => {
		let state = createGame(2);
		const [p1, p2] = state.players;
		const connivedEvents: Array<Extract<GameEvent, { kind: 'Connived' }>> = [];
		subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'Connived') connivedEvents.push(ev);
		});

		p1.manaPool.U = 6;
		p1.hand = [];
		const conniver = putInZone(
			state,
			p1,
			makeCard({
				name: 'Obscura Spy',
				typeLine: 'Creature — Bird Rogue',
				power: '1',
				toughness: '3',
				oracleText: 'Whenever ~ connives, you gain 1 life.'
			}),
			'battlefield'
		);
		const rip = makeCard({
			name: 'Rest in Peace',
			typeLine: 'Enchantment',
			oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
		});
		const leyline = makeCard({
			name: 'Second RIP',
			typeLine: 'Enchantment',
			oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
		});
		putInZone(state, p2, rip, 'battlefield');
		putInZone(state, p2, leyline, 'battlefield');

		const hLand = putInZone(state, p1, makeCard({ name: 'Hand Island', typeLine: 'Basic Land — Island' }), 'hand');
		const hSpell = putInZone(state, p1, makeCard({ name: 'Hand Opt', typeLine: 'Instant' }), 'hand');
		const lib1 = putInZone(state, p1, makeCard({ name: 'Lib Spell 1', typeLine: 'Sorcery' }), 'library');
		putInZone(state, p1, makeCard({ name: 'Lib Spell 2', typeLine: 'Artifact' }), 'library');
		const spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Double Connive',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Target creature connives 2.'
			}),
			'hand'
		);

		const startLife = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: conniver.instanceId, label: conniver.card.name }]
			}).ok,
			true
		);
		passAllPriority(state);

		// Should have drawn 2 (hand now 4: hLand, hSpell, lib2, lib1) and paused on discard 2 prompt!
		assert.equal(state.players[0].hand.length, 4);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].kind, 'chooseObjects');

		state = jsonRoundTrip(state);
		const discPrompt = state.pendingPrompts[0];
		// Discard 1 land + 1 nonland -> nonlandDiscardedCount = 1 (+1/+1 counter once!)
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: discPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [hLand.instanceId, hSpell.instanceId] }
			}).ok,
			true
		);

		// Rest in Peace + Second RIP pauses for first card (moving it to pendingZoneMoves), then second card, WITHOUT re-drawing!
		assert.equal(state.players[0].hand.length, 3);
		assert.equal(state.pendingZoneMoves?.length, 1);
		while (state.pendingPrompts.length > 0) {
			state = jsonRoundTrip(state);
			subscribeEvents(state, (_s, ev) => {
				if (ev.kind === 'Connived') connivedEvents.push(ev);
			});
			const rp = state.pendingPrompts[0];
			const rc = rp.choice?.kind === 'chooseReplacement' ? rp.choice : undefined;
			assert.ok(rc, 'expected replacement choice');
			assert.equal(
				applyGameAction(state, rp.playerId, {
					type: 'choice',
					promptId: rp.id,
					answer: { kind: 'chooseReplacement', id: rc.options[0].id }
				}).ok,
				true
			);
		}
		passAllPriority(state);

		const spyOnBoard = state.players[0].battlefield.find((c) => c.instanceId === conniver.instanceId)!;
		assert.equal(spyOnBoard.counters['+1/+1'], 1);
		// Must still have only 2 remaining cards in hand (drew 2, did NOT re-draw on resume!)
		assert.equal(state.players[0].hand.length, 2);
		assert.equal(state.players[0].hand.some((c) => c.instanceId === lib1.instanceId), true);
		assert.equal(state.players[0].life, startLife + 1);
		assert.equal(connivedEvents.length, 1);
		assert.equal(connivedEvents[0].nonlandDiscardedCount, 1);
	});

	it('treats connive 0 as complete no-op (CR 701.50e), supports LKI (CR 701.50b), APNAP (CR 701.50c), and rename invariance', () => {
		const state = createGame(2, [true, true]);
		const [p1, p2] = state.players;
		const events: Array<Extract<GameEvent, { kind: 'Connived' }>> = [];
		subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'Connived') events.push(ev);
		});

		p1.manaPool.U = 6;
		const body = putInZone(
			state,
			p1,
			makeCard({ name: 'Test Spy', typeLine: 'Creature — Rogue', power: '2', toughness: '2' }),
			'battlefield'
		);
		const libBefore = p1.library.length;
		const xZero = putInZone(
			state,
			p1,
			makeCard({ name: 'Zero Connive', manaCost: '{X}{U}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Target creature connives X.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: xZero.instanceId,
				xValue: 0,
				targets: [{ kind: 'permanent', id: body.instanceId, label: body.card.name }]
			}).ok,
			true
		);
		passAllPriority(state);
		assert.equal(p1.library.length, libBefore);
		assert.equal(body.counters['+1/+1'], 0);
		assert.equal(events.length, 0);

		// LKI CR 701.50b: creature with ETB connive removed before trigger resolves -> controller still draws 1 & discards 1, trigger still fires
		const watcher = putInZone(
			state,
			p1,
			makeCard({
				name: 'Connive Watcher',
				typeLine: 'Creature — Angel',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever a creature you control connives, you gain 2 life.'
			}),
			'battlefield'
		);
		assert.ok(watcher);
		const fleeting = putInZone(
			state,
			p1,
			makeCard({
				name: 'Fleeting Conniver',
				manaCost: '{U}',
				typeLine: 'Creature — Rogue',
				power: '1',
				toughness: '1',
				oracleText: 'When Fleeting Conniver enters, it connives.'
			}),
			'hand'
		);
		const libMid = p1.library.length;
		const lifePre = p1.life;
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: fleeting.instanceId }).ok, true);
		passUntilTopResolves(state); // Creature resolves -> ETB connive on stack
		const fleeter = p1.battlefield.find((c) => c.instanceId === fleeting.instanceId)!;
		moveObject(state, fleeter, 'graveyard', { from: { player: p1, zone: 'battlefield' }, toPlayer: p1, bumpVersion: true });
		passAllPriority(state); // ETB connive resolves with LKI -> draw 1, discard 1, watcher triggers
		passAllPriority(state);
		assert.equal(p1.library.length, libMid - 1);
		assert.equal(p1.life, lifePre + 2);
		assert.equal(events.length, 1);

		// APNAP CR 701.50c
		events.length = 0;
		putInZone(state, p2, makeCard({ name: 'P2 Spy', typeLine: 'Creature — Rogue', power: '1', toughness: '1' }), 'battlefield');
		const massConnive = putInZone(
			state,
			p1,
			makeCard({ name: 'Mass Connive', manaCost: '{U}', typeLine: 'Sorcery', oracleText: 'Each creature connives.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: massConnive.instanceId }).ok, true);
		passAllPriority(state);
		passAllPriority(state);
		const p1Idx = events.findIndex((e) => e.playerId === p1.playerId);
		const p2Idx = events.findIndex((e) => e.playerId === p2.playerId);
		assert.ok(p1Idx >= 0 && p2Idx > p1Idx);

		// Synthetic card rename invariance
		const irA = compileCard(
			makeCard({ name: 'Alpha Conniver', oracleText: 'When Alpha Conniver enters, it connives.\nWhenever Alpha Conniver explores, goad target creature.' })
		);
		const irB = compileCard(
			makeCard({ name: 'Omega Conniver', oracleText: 'When Omega Conniver enters, it connives.\nWhenever Omega Conniver explores, goad target creature.' })
		);
		assert.deepEqual(
			JSON.parse(JSON.stringify(irA.faces.map((f) => f.abilities))),
			JSON.parse(JSON.stringify(irB.faces.map((f) => f.abilities)))
		);
	});
});
