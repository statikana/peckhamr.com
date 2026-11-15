import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import type { ActivatedAbility } from '../ir.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	hasKeyword
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `p19a_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function playerTarget(player: PlayerGameState): TargetRef {
	return { kind: 'player', id: player.playerId, label: player.username };
}

function stackTarget(stackId: string, label = 'Spell'): TargetRef {
	return { kind: 'stack', id: stackId, label };
}

function roundTripJson(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function stripSpans(val: unknown): unknown {
	if (Array.isArray(val)) return val.map(stripSpans);
	if (val && typeof val === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
			if (k === 'span' || k === 'text' || k === 'name' || k === 'id') continue;
			out[k] = stripSpans(v);
		}
		return out;
	}
	return val;
}

function createGame(playerCount: 2 | 3 = 2): GameState {
	const seats: LobbySeat[] = Array.from({ length: playerCount }, (_, i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length];
		return {
			seatIndex: i,
			userId: `p${i + 1}`,
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
		};
	});
	const decks = new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]]));
	const state = createInitialGameState('TRACKP19A', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
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
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		...(zone === 'library' ? { insert: 'start' } : {}),
		bumpVersion: true
	});
	inst.summoningSick = false;
	return inst;
}

function addMana(player: PlayerGameState, amount = 10): void {
	player.manaPool.W += amount;
	player.manaPool.U += amount;
	player.manaPool.B += amount;
	player.manaPool.R += amount;
	player.manaPool.G += amount;
	player.manaPool.C += amount;
}

function firstActivatedId(card: ScryfallCard, index = 0): string {
	const def = compileCard(card);
	const acts = def.faces[0].abilities.filter((a): a is ActivatedAbility => a.kind === 'activated');
	assert.ok(acts[index], `Expected activated ability at index ${index} on ${card.name}`);
	return acts[index].id;
}

function resolveStack(state: GameState, maxSteps = 80): void {
	for (let guard = 0; guard < maxSteps; guard++) {
		const pr = state.pendingPrompts[0];
		const choice = pr?.choice;
		if (
			state.pendingPrompts.length === 1 &&
			pr?.purpose === 'trigger_order' &&
			choice?.kind === 'orderObjects'
		) {
			const orderRes = applyGameAction(state, pr.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'orderObjects', topIds: choice.objectIds }
			});
			assert.equal(orderRes.ok, true, orderRes.error ?? 'trigger_order failed');
			continue;
		}
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const prio = state.players[state.priorityPlayerIndex];
		if (!prio || prio.lost) break;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
	}
}

function answerTopPrompt(state: GameState, answer: ChoiceAnswer): void {
	const pr = state.pendingPrompts[0];
	assert.ok(pr, 'Expected an active pending prompt');
	const res = applyGameAction(state, pr.playerId, {
		type: 'choice',
		promptId: pr.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? 'choice answer failed');
}

describe('Wave 7 Track P19a — Effects, LKI, Redirection, Impulse Any-Color Mana, & Tokens', () => {
	it('P19a.1: stacks delayed tap-for-mana triggers (High Tide style) and queries controlledLandProducedTypes', () => {
		const state = createGame();
		const [p1] = state.players;

		const highTide = makeCard({
			name: 'Tidal Surge Test',
			manaCost: '{U}',
			cmc: 1,
			colors: ['U'],
			typeLine: 'Instant',
			oracleText:
				'Until end of turn, whenever a player taps an Island for mana, that player adds an additional {U}.'
		});
		const islandCard = makeCard({
			name: 'Basic Island Test',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Island',
			oracleText: '({T}: Add {U}.)'
		});
		const reflectingRock = makeCard({
			name: 'Mirror Pool Rock',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: '{T}: Add one mana of any type that a land you control could produce.'
		});

		const ht1 = putInZone(state, p1, highTide, 'hand');
		const ht2 = putInZone(state, p1, highTide, 'hand');
		const island = putInZone(state, p1, islandCard, 'battlefield');
		const rock = putInZone(state, p1, reflectingRock, 'battlefield');

		p1.manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: ht1.instanceId }).ok,
			true
		);
		resolveStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: ht2.instanceId }).ok,
			true
		);
		resolveStack(state);

		assert.equal(p1.manaPool.U, 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: island.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		// Base {U} + two delayed triggers (+{U} each) = 3 {U}
		assert.equal(p1.manaPool.U, 3);

		// Mirror Pool Rock inspects Island's producible types ({U}) and produces {U}
		const rockAbId = firstActivatedId(reflectingRock, 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: rock.instanceId,
				abilityId: rockAbId
			}).ok,
			true
		);
		assert.equal(p1.manaPool.U, 4);
	});

	it('P19a.2: executes CR 119.5 setLifeTotal, CR 120.10 excess damage, choice pump/lose-keyword, and replacement If-instead', () => {
		const state = createGame();
		const [p1, p2] = state.players;

		// 1. CR 119.5 setLifeTotal (40 -> 10 loses 30 life)
		const setLifeSpell = makeCard({
			name: 'Scale of Fate Test',
			manaCost: '{2}{B}',
			cmc: 3,
			colors: ['B'],
			typeLine: 'Sorcery',
			oracleText: "Target player's life total becomes 10."
		});
		const slInst = putInZone(state, p1, setLifeSpell, 'hand');
		addMana(p1, 5);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: slInst.instanceId,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 10);

		// 2. CR 120.10 excess damage to controller (5 damage to a 2/2 -> 2 to creature, 3 to controller)
		const bear = putInZone(
			state,
			p2,
			makeCard({
				name: 'Runeclaw Test Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const excessBolt = makeCard({
			name: 'Flame Spill Test',
			manaCost: '{2}{R}',
			cmc: 3,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText:
				"Flame Spill Test deals 5 damage to target creature. Excess damage is dealt to that creature's controller instead."
		});
		const ebInst = putInZone(state, p1, excessBolt, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ebInst.instanceId,
				targets: [permTarget(bear)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 7);
		assert.equal(
			p2.graveyard.some((c) => c.instanceId === bear.instanceId),
			true
		);

		// 3. Choice-based lose-keyword (3 options) & replacement If-instead
		const keywordsCreature = putInZone(
			state,
			p2,
			makeCard({
				name: 'Aerial Striker Test',
				typeLine: 'Creature — Bird',
				power: '3',
				toughness: '3',
				keywords: ['Flying', 'First strike', 'Trample'],
				oracleText: 'Flying, first strike, trample'
			}),
			'battlefield'
		);
		const stripKwSpell = makeCard({
			name: 'Sponge Touch Test',
			manaCost: '{U}',
			cmc: 1,
			colors: ['U'],
			typeLine: 'Instant',
			oracleText:
				'Target creature loses your choice of flying, first strike, or trample until end of turn.'
		});
		const skInst = putInZone(state, p1, stripKwSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: skInst.instanceId,
				targets: [permTarget(keywordsCreature)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseMode');
		answerTopPrompt(state, { kind: 'chooseMode', indices: [0] }); // lose Flying
		resolveStack(state);
		assert.equal(hasKeyword(keywordsCreature, 'Flying', state), false);
		assert.equal(hasKeyword(keywordsCreature, 'Trample', state), true);

		// 4. Replacement "If you control an artifact, draw two cards instead."
		putInZone(
			state,
			p1,
			makeCard({ name: 'Relic Bauble Test', typeLine: 'Artifact', oracleText: '' }),
			'battlefield'
		);
		for (let i = 0; i < 3; i++) {
			putInZone(state, p1, makeCard({ name: `Deck Filler ${i}` }), 'library');
		}
		const ifInsteadDraw = makeCard({
			name: 'Tinkerer Insight Test',
			manaCost: '{1}{U}',
			cmc: 2,
			colors: ['U'],
			typeLine: 'Instant',
			oracleText: 'Draw a card. If you control an artifact, draw two cards instead.'
		});
		const iidInst = putInZone(state, p1, ifInsteadDraw, 'hand');
		const handBefore = p1.hand.length - 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: iidInst.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, handBefore + 2);
	});

	it('P19a.3: captures sacrificed-cost LKI power/toughness after continuous buffs (Fling)', () => {
		const state = createGame();
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const brute = putInZone(
			state,
			p1,
			makeCard({
				name: 'Hulking Ogre Test',
				typeLine: 'Creature — Ogre',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const pumpSpell = makeCard({
			name: 'Might Surge Test',
			manaCost: '{G}',
			cmc: 1,
			colors: ['G'],
			typeLine: 'Instant',
			oracleText: 'Target creature gets +3/+3 until end of turn.'
		});
		const psInst = putInZone(state, p1, pumpSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: psInst.instanceId,
				targets: [permTarget(brute)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(evaluatePermanent(state, brute).power, 5);

		const flingSpell = makeCard({
			name: 'Hurl Away Test',
			manaCost: '{1}{R}',
			cmc: 2,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText:
				"As an additional cost to cast this spell, sacrifice a creature.\nHurl Away Test deals damage equal to the sacrificed creature's power to any target."
		});
		const flInst = putInZone(state, p1, flingSpell, 'hand');
		const lifeBefore = p2.life;
		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: flInst.instanceId,
			targets: [playerTarget(p2)],
			costPayment: { objects: [[brute.instanceId]] }
		});
		assert.equal(castRes.ok, true, castRes.error ?? 'cast Fling failed');
		resolveStack(state);
		assert.equal(p2.life, lifeBefore - 5);
	});

	it('P19a.4a: executes CR 115.7d stack target redirection across mid-prompt JSON round-trip', () => {
		let state = createGame();
		let [p1, p2] = state.players;
		addMana(p1, 5);
		addMana(p2, 5);

		const boltCard = makeCard({
			name: 'Arc Bolt Test',
			manaCost: '{R}',
			cmc: 1,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText: 'Arc Bolt Test deals 3 damage to any target.'
		});
		const redirectCard = makeCard({
			name: 'Arcane Deflect Test',
			manaCost: '{U}{R}',
			cmc: 2,
			colors: ['U', 'R'],
			typeLine: 'Instant',
			oracleText: 'You may choose new targets for target spell.'
		});

		const boltInst = putInZone(state, p1, boltCard, 'hand');
		const redirInst = putInZone(state, p2, redirectCard, 'hand');

		// P1 casts Arc Bolt targeting P2
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boltInst.instanceId,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		const boltStackId = state.stack[0]!.id;

		// P1 passes priority -> P2 casts Arcane Deflect targeting Arc Bolt on the stack
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: redirInst.instanceId,
				targets: [stackTarget(boltStackId, boltCard.name)]
			}).ok,
			true
		);

		resolveStack(state);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'yesNo');

		// Verify plain-JSON serializability mid-prompt (ENGINE_INVARIANTS.md §1.5)
		state = roundTripJson(state);
		answerTopPrompt(state, { kind: 'yesNo', yes: true });

		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseObjects');
		state = roundTripJson(state);
		[p1, p2] = state.players;
		answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [p1.playerId] });

		resolveStack(state);
		[p1, p2] = state.players;
		assert.equal(p1.life, 37);
		assert.equal(p2.life, 40);
	});

	it('P19a.4b: executes exileUntil + CR 609.4b spendManaAsAnyColor, delayedNextSpellCopy, skipTurn, dynamic X/X toxic tokens, and rename invariance', () => {
		const state = createGame();
		const [p1, p2] = state.players;

		// 1. exileUntil + spendManaAsAnyColor ({R}{G} pays for {U}{U} card exiled from library)
		const blueBear = makeCard({
			name: 'Azure Drake Test',
			manaCost: '{U}{U}',
			cmc: 2,
			colors: ['U'],
			typeLine: 'Creature — Drake',
			power: '2',
			toughness: '2'
		});
		const forestFiller = makeCard({
			name: 'Top Forest Filler',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest'
		});
		p1.library = [];
		putInZone(state, p1, blueBear, 'library');
		putInZone(state, p1, forestFiller, 'library'); // top of library is Land, second is {U}{U} Creature

		const impulseAnyColor = makeCard({
			name: 'Chromatic Impulse Test',
			manaCost: '{1}{R}',
			cmc: 2,
			colors: ['R'],
			typeLine: 'Sorcery',
			oracleText:
				'Exile cards from the top of your library until you exile a nonland card. Until end of turn, you may cast that card, and you may spend mana as though it were mana of any color to cast that spell.'
		});
		const impInst = putInZone(state, p1, impulseAnyColor, 'hand');
		p1.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 2, C: 0 };
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: impInst.instanceId
			}).ok,
			true
		);
		resolveStack(state);

		const exiledDrake = p1.exile.find((c) => c.card.id === blueBear.id);
		assert.ok(exiledDrake, 'Expected nonland Drake to be exiled');
		const castOpts = getCastOptions(state, p1.playerId, exiledDrake, 'exile');
		assert.equal(castOpts.length > 0, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: exiledDrake.instanceId,
				fromZone: 'exile'
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === exiledDrake.instanceId),
			true
		);

		// 2. delayedNextSpellCopy + dynamic X/X toxic 1 token + rename invariance
		addMana(p1, 10);
		const doublecast = makeCard({
			name: 'Echo Next Spell Test',
			manaCost: '{R}{R}',
			cmc: 2,
			colors: ['R'],
			typeLine: 'Sorcery',
			oracleText:
				'Copy the next instant or sorcery spell you cast this turn when you cast it. You may choose new targets for the copy.'
		});
		const xTokenSpell = makeCard({
			name: 'Incubate Brood Alpha',
			manaCost: '{X}{G}',
			cmc: 1,
			colors: ['G'],
			typeLine: 'Sorcery',
			oracleText: 'Create an X/X green Phyrexian Beast creature token with toxic 1.'
		});
		const xTokenRenamed = makeCard({
			name: 'Totally Different Synthetic Name',
			manaCost: '{X}{G}',
			cmc: 1,
			colors: ['G'],
			typeLine: 'Sorcery',
			oracleText: 'Create an X/X green Phyrexian Beast creature token with toxic 1.'
		});
		assert.deepEqual(
			stripSpans(compileCard(xTokenSpell).faces[0]!.abilities),
			stripSpans(compileCard(xTokenRenamed).faces[0]!.abilities)
		);

		const dcInst = putInZone(state, p1, doublecast, 'hand');
		const xtInst = putInZone(state, p1, xTokenSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: dcInst.instanceId }).ok,
			true
		);
		resolveStack(state);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: xtInst.instanceId,
				xValue: 3
			}).ok,
			true
		);
		resolveStack(state);

		const beasts = p1.battlefield.filter((c) => c.isToken && c.card.typeLine.includes('Phyrexian'));
		assert.equal(beasts.length, 2, 'Expected original + copied spell to create two 3/3 tokens');
		assert.equal(evaluatePermanent(state, beasts[0]!).power, 3);
		assert.equal(evaluatePermanent(state, beasts[0]!).toughness, 3);
		assert.equal(hasKeyword(beasts[0]!, 'Toxic 1', state), true);

		// 3. CR 614.10 skipTurn
		const skipSpell = makeCard({
			name: 'Chrono Stasis Test',
			manaCost: '{2}{U}',
			cmc: 3,
			colors: ['U'],
			typeLine: 'Sorcery',
			oracleText: 'Target player skips their next turn.'
		});
		const skpInst = putInZone(state, p1, skipSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: skpInst.instanceId,
				targets: [playerTarget(p2)]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.skipNextTurns, 1);
	});
});
