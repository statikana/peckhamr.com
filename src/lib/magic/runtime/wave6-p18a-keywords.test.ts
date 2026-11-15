import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardSupportReport } from '../compiler/support.ts';
import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword
} from '../engine.ts';
import type { Span } from '../ir.ts';
import { moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

const ZERO_SPAN: Span = { start: 0, end: 0 };

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p18a_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p18a_${synthSeq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Beast',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? (overrides.typeLine?.includes('Creature') ? '2' : undefined),
		toughness:
			overrides.toughness ?? (overrides.typeLine?.includes('Creature') ? '2' : undefined),
		loyalty: overrides.loyalty,
		defense: overrides.defense,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(cards: ScryfallCard[], commanders: ScryfallCard[] = []): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: 'deck_p18a',
		userId: 'p1',
		name: 'Track P18a Deck',
		description: '',
		commanders,
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + commanders.length,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupGame(
	opts: {
		p1Bot?: boolean;
		p2Bot?: boolean;
		threePlayer?: boolean;
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Verdant Steppe',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(Array.from({ length: 30 }, () => filler));
	const d2 = makeDeck(Array.from({ length: 30 }, () => filler));
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d1.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: Boolean(opts.p2Bot),
			deckId: d2.id,
			deckName: d2.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d2.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const decks = new Map<number, MagicDeck>([
		[0, d1],
		[1, d2]
	]);
	if (opts.threePlayer) {
		const d3 = makeDeck(Array.from({ length: 30 }, () => filler));
		seats.push({
			seatIndex: 2,
			userId: 'p3',
			username: 'Charlie',
			avatarUrl: '',
			isBot: false,
			deckId: d3.id,
			deckName: d3.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d3.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
		decks.set(2, d3);
	}
	const state = createInitialGameState('P18A', seats, decks, DEFAULT_LOBBY_RULES);
	for (let i = 0; i < state.players.length; i++) {
		const p = state.players[i]!;
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (let i = 0; i < state.players.length; i++) {
		const p = state.players[i]!;
		p.hasKeptHand = true;
		p.hand = [];
	}
	return {
		state,
		p1: state.players[0]!,
		p2: state.players[1]!,
		p3: state.players[2]
	};
}

function giveMana(player: PlayerGameState, amounts: Partial<Record<ManaColor, number>>): void {
	for (const [c, n] of Object.entries(amounts)) {
		const col = c as ManaColor;
		player.manaPool[col] = (player.manaPool[col] ?? 0) + (n ?? 0);
	}
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
	}
	if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	return inst;
}

function roundTripState(state: GameState): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const cloned = JSON.parse(JSON.stringify(state)) as GameState;
	return {
		state: cloned,
		p1: cloned.players[0]!,
		p2: cloned.players[1]!,
		p3: cloned.players[2]
	};
}

function answerTopPrompt(state: GameState, answer: ChoiceAnswer): GameState {
	assert.ok(state.pendingPrompts.length > 0, 'Expected a pending prompt');
	const rt = roundTripState(state);
	const prm = rt.state.pendingPrompts[0]!;
	const res = applyGameAction(rt.state, prm.playerId, {
		type: 'choice',
		promptId: prm.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? 'Expected choice action to succeed');
	return rt.state;
}

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 50; guard++) {
		if (
			state.pendingPrompts.length > 0 &&
			state.pendingPrompts[0]!.purpose === 'trigger_order'
		) {
			const prm = state.pendingPrompts[0]!;
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
			});
			assert.equal(res.ok, true, res.error ?? '');
			continue;
		}
		if (state.pendingPrompts.length > 0 || state.stack.length === 0) break;
		const prioPlayer = state.players[state.priorityPlayerIndex];
		if (!prioPlayer) break;
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function advanceToPhase(
	state: GameState,
	targetPhase: GameState['phase'],
	targetActiveIdx = state.activePlayerIndex
): void {
	for (let guard = 0; guard < 90; guard++) {
		if (
			state.phase === targetPhase &&
			state.activePlayerIndex === targetActiveIdx &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0
		) {
			return;
		}
		if (
			state.pendingPrompts.length > 0 &&
			state.pendingPrompts[0]!.purpose === 'trigger_order'
		) {
			const prm = state.pendingPrompts[0]!;
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
			});
			assert.equal(res.ok, true, res.error ?? '');
			continue;
		}
		if (state.pendingPrompts.length > 0) {
			break;
		}
		const prio = state.players[state.priorityPlayerIndex];
		if (!prio) break;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

// ============================================================================
// Group 1 — Mutate [cost] (CR 702.140a–f) & Merged Permanents (CR 731.1–3)
// ============================================================================

describe('Wave 6 Track P18a — Mutate & Merged Permanents (CR 702.140, CR 731)', () => {
	it('enforces CR 702.140a targeting: non-Human creature with the same owner only', () => {
		const { state, p1, p2 } = setupGame();
		const mutatorCard = synthCard({
			name: 'Apex Chimera',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Creature — Beast',
			oracleText: 'Mutate {1}{G}\nTrample',
			power: '4',
			toughness: '4'
		});
		const beastCard = synthCard({
			name: 'Moss Badger',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Badger',
			oracleText: 'Vigilance',
			power: '2',
			toughness: '2'
		});
		const humanCard = synthCard({
			name: 'Town Scout',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Scout',
			oracleText: '',
			power: '2',
			toughness: '2'
		});
		const oppBeastCard = synthCard({
			name: 'Stray Wolf',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Wolf',
			oracleText: '',
			power: '2',
			toughness: '2'
		});

		const inHand = putInZone(state, p1, mutatorCard, 'hand');
		const ownBeast = putInZone(state, p1, beastCard, 'battlefield');
		const ownHuman = putInZone(state, p1, humanCard, 'battlefield');
		// Controlled by p1, but OWNED by p2 -> illegal Mutate target per CR 702.140a!
		const stolenBeast = putInZone(state, p1, oppBeastCard, 'battlefield');
		stolenBeast.ownerId = p2.playerId;

		giveMana(p1, { G: 6, C: 6 });

		const opts = getCastOptions(state, p1.playerId, inHand, 'hand');
		const mutateOpt = opts.find((o) => o.mutate);
		assert.ok(mutateOpt, 'Expected a Mutate CastOption');

		// 1. Rejects Human creature (CR 702.140a)
		const badHuman = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: inHand.instanceId,
			optionId: mutateOpt.id,
			targets: [{ kind: 'permanent', id: ownHuman.instanceId, label: ownHuman.card.name }]
		});
		assert.equal(badHuman.ok, false);

		// 2. Rejects creature owned by opponent even if controlled by caster (CR 702.140a)
		const badOwner = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: inHand.instanceId,
			optionId: mutateOpt.id,
			targets: [{ kind: 'permanent', id: stolenBeast.instanceId, label: stolenBeast.card.name }]
		});
		assert.equal(badOwner.ok, false);

		// 3. Accepts non-Human creature with same owner
		const okRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: inHand.instanceId,
			optionId: mutateOpt.id,
			targets: [{ kind: 'permanent', id: ownBeast.instanceId, label: ownBeast.card.name }]
		});
		assert.equal(okRes.ok, true, okRes.error ?? '');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0]!.spellMods?.mutating, true);
	});

	it('merges on top and underneath across JSON round-trip, combining abilities, preserving state without ETB, and firing mutates triggers (CR 702.140c–e, CR 731.2)', () => {
		const { state: s0, p1 } = setupGame();

		// Base creature on battlefield with ETB life gain (must NOT re-fire on mutate!) + Vigilance + {T}: Add {G}
		const baseCard = synthCard({
			name: 'Root Grazer',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Elf Druid',
			oracleText:
				'Vigilance\nWhen ~ enters, you gain 5 life.\n{T}: Add {G}.',
			colors: ['G'],
			power: '1',
			toughness: '3'
		});
		// First mutator (placed ON TOP): 4/4 Flying + synthetic `mutates` trigger (draw 1 card)
		const topMutator = synthCard({
			name: 'Cloudscale Drake',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Creature — Drake',
			oracleText: 'Mutate {2}{U}\nFlying',
			colors: ['U'],
			power: '4',
			toughness: '4'
		});
		const topDef = compileCard(topMutator);
		topDef.faces[0]!.abilities.push({
			kind: 'triggered',
			trigger: { event: 'mutates', filter: { object: 'self' } },
			targets: [],
			effect: [
				{
					verb: 'draw',
					subject: { k: 'player', filter: { relation: 'you' } },
					amount: { k: 'const', n: 1 },
					span: ZERO_SPAN
				}
			],
			span: ZERO_SPAN
		});

		// Second mutator (placed UNDERNEATH): 6/6 Trample + Haste
		const underMutator = synthCard({
			name: 'Crag Charger',
			manaCost: '{4}{R}',
			cmc: 5,
			typeLine: 'Creature — Elemental',
			oracleText: 'Mutate {1}{R}\nTrample, haste',
			colors: ['R'],
			power: '6',
			toughness: '6'
		});

		const basePerm = putInZone(s0, p1, baseCard, 'battlefield');
		basePerm.counters['+1/+1'] = 2;
		basePerm.damageMarked = 1;
		basePerm.tapped = true;
		const initialLife = p1.life;
		const initialLibSize = p1.library.length;

		const hand1 = putInZone(s0, p1, topMutator, 'hand');
		const hand2 = putInZone(s0, p1, underMutator, 'hand');
		giveMana(p1, { U: 5, R: 5, C: 10 });

		// Cast first mutator targeting basePerm
		const opt1 = getCastOptions(s0, p1.playerId, hand1, 'hand').find((o) => o.mutate)!;
		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'cast_spell',
				instanceId: hand1.instanceId,
				optionId: opt1.id,
				targets: [{ kind: 'permanent', id: basePerm.instanceId, label: basePerm.card.name }]
			}).ok,
			true
		);
		resolveAllStack(s0);
		// Should pause for human top/underneath choice (chooseMode)
		assert.equal(s0.pendingPrompts.length, 1);
		assert.equal(s0.pendingPrompts[0]!.kind, 'chooseMode');

		// Choose index 0 = ON TOP across JSON round-trip
		let state = answerTopPrompt(s0, { kind: 'chooseMode', indices: [0] });
		resolveAllStack(state);

		const merged1 = state.players[0]!.battlefield.find(
			(c) => c.instanceId === basePerm.instanceId
		)!;
		assert.ok(merged1, 'Merged permanent retains same instanceId');
		assert.equal(state.players[0]!.battlefield.length, 1);
		// CR 731.2c: No ETB trigger fired!
		assert.equal(state.players[0]!.life, initialLife);
		// CR 702.140d: `mutates` trigger fired and drew 1 card!
		assert.equal(state.players[0]!.library.length, initialLibSize - 1);
		assert.equal(merged1.mutateCount, 1);
		// Preserved counters, damage, and tapped status (CR 731.2b)
		assert.equal(merged1.counters['+1/+1'], 2);
		assert.equal(merged1.damageMarked, 1);
		assert.equal(merged1.tapped, true);

		// Top characteristics (4/4 Drake + 2 +1/+1 counters = 6/6) + underneath Vigilance & mana ability
		const ev1 = evaluatePermanent(state, merged1);
		assert.equal(ev1.effectiveName, 'Cloudscale Drake');
		assert.equal(ev1.power, 6);
		assert.equal(ev1.toughness, 6);
		assert.equal(ev1.hasSubType('Drake'), true);
		assert.equal(ev1.hasSubType('Elf'), false);
		assert.equal(hasKeyword(merged1, 'Flying', state), true);
		assert.equal(hasKeyword(merged1, 'Vigilance', state), true);
		assert.equal(
			getEffectiveActivatedAbilities(state, state.players[0]!, merged1).length,
			1
		);

		// Now cast second mutator and place UNDERNEATH (index 1)
		const p1After = state.players[0]!;
		const hand2After = p1After.hand.find((c) => c.instanceId === hand2.instanceId)!;
		const opt2 = getCastOptions(state, p1After.playerId, hand2After, 'hand').find(
			(o) => o.mutate
		)!;
		assert.equal(
			applyGameAction(state, p1After.playerId, {
				type: 'cast_spell',
				instanceId: hand2After.instanceId,
				optionId: opt2.id,
				targets: [{ kind: 'permanent', id: merged1.instanceId, label: merged1.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		state = answerTopPrompt(state, { kind: 'chooseMode', indices: [1] });
		resolveAllStack(state);

		const merged2 = state.players[0]!.battlefield[0]!;
		assert.equal(merged2.mutateCount, 2);
		// `mutates` trigger on top component fired a SECOND time!
		assert.equal(state.players[0]!.library.length, initialLibSize - 2);
		const ev2 = evaluatePermanent(state, merged2);
		// Still Cloudscale Drake on top (4/4 base + 2 counters = 6/6, NOT 6/6 base), with Trample & Haste from underneath!
		assert.equal(ev2.effectiveName, 'Cloudscale Drake');
		assert.equal(ev2.power, 6);
		assert.equal(ev2.toughness, 6);
		assert.equal(hasKeyword(merged2, 'Flying', state), true);
		assert.equal(hasKeyword(merged2, 'Vigilance', state), true);
		assert.equal(hasKeyword(merged2, 'Trample', state), true);
		assert.equal(hasKeyword(merged2, 'Haste', state), true);
	});

	it('resolves as an ordinary creature spell instead of fizzling if the mutate target leaves the battlefield (CR 702.140b)', () => {
		const { state, p1 } = setupGame();
		const mutatorCard = synthCard({
			name: 'Glimmer Elk',
			manaCost: '{2}{G}',
			cmc: 3,
			typeLine: 'Creature — Elk',
			oracleText: 'Mutate {1}{G}\nReach',
			power: '3',
			toughness: '3'
		});
		const beastCard = synthCard({
			name: 'Brush Cub',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Creature — Bear',
			oracleText: '',
			power: '2',
			toughness: '2'
		});

		const inHand = putInZone(state, p1, mutatorCard, 'hand');
		const targetBeast = putInZone(state, p1, beastCard, 'battlefield');
		giveMana(p1, { G: 4, C: 4 });

		const mutateOpt = getCastOptions(state, p1.playerId, inHand, 'hand').find(
			(o) => o.mutate
		)!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: inHand.instanceId,
				optionId: mutateOpt.id,
				targets: [{ kind: 'permanent', id: targetBeast.instanceId, label: targetBeast.card.name }]
			}).ok,
			true
		);

		// Target leaves battlefield before resolution!
		moveObject(state, targetBeast, 'graveyard', {
			from: { player: p1, zone: 'battlefield' }
		});
		assert.equal(p1.battlefield.length, 0);

		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 0);
		// Spell did NOT fizzle to graveyard — it entered battlefield as a standalone 3/3 creature!
		assert.equal(p1.battlefield.length, 1);
		assert.equal(p1.battlefield[0]!.card.name, 'Glimmer Elk');
		assert.equal(p1.battlefield[0]!.mergedComponents, undefined);
		assert.equal(p1.graveyard.length, 1);
		assert.equal(p1.graveyard[0]!.card.name, 'Brush Cub');
	});

	it('splits all merged components into destination zone on LTB and fires underneath dies triggers (CR 731.3, CR 603.10a)', () => {
		const { state: s0, p1 } = setupGame();
		const underDiesCard = synthCard({
			name: 'Spore Larva',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Insect',
			oracleText: 'When ~ dies, you gain 3 life.',
			power: '1',
			toughness: '1'
		});
		const topMutator = synthCard({
			name: 'Dusk Stalker',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Creature — Cat',
			oracleText: 'Mutate {1}{B}\nLifelink',
			power: '3',
			toughness: '3'
		});
		const killSpell = synthCard({
			name: 'Void Bolt',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});

		const basePerm = putInZone(s0, p1, underDiesCard, 'battlefield');
		const mutHand = putInZone(s0, p1, topMutator, 'hand');
		const killHand = putInZone(s0, p1, killSpell, 'hand');
		giveMana(p1, { B: 6, C: 6 });

		const mutOpt = getCastOptions(s0, p1.playerId, mutHand, 'hand').find((o) => o.mutate)!;
		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'cast_spell',
				instanceId: mutHand.instanceId,
				optionId: mutOpt.id,
				targets: [{ kind: 'permanent', id: basePerm.instanceId, label: basePerm.card.name }]
			}).ok,
			true
		);
		resolveAllStack(s0);
		const state = answerTopPrompt(s0, { kind: 'chooseMode', indices: [0] });
		resolveAllStack(state);

		const lifeBeforeKill = state.players[0]!.life;
		const merged = state.players[0]!.battlefield[0]!;
		assert.equal(merged.mergedComponents?.length, 2);

		// Destroy the merged permanent
		assert.equal(
			applyGameAction(state, state.players[0]!.playerId, {
				type: 'cast_spell',
				instanceId: killHand.instanceId,
				targets: [{ kind: 'permanent', id: merged.instanceId, label: merged.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		// Both component cards + Void Bolt are now separate cards in graveyard (3 total)!
		const gyNames = state.players[0]!.graveyard.map((c) => c.card.name).sort();
		assert.deepEqual(gyNames, ['Dusk Stalker', 'Spore Larva', 'Void Bolt']);
		// Underneath component's dies trigger fired!
		assert.equal(state.players[0]!.life, lifeBeforeKill + 3);
	});

	it('propagates combined characteristics and abilities when copying a merged permanent (CR 707.2, CR 731.2a)', () => {
		const { state: s0, p1 } = setupGame({ p1Bot: true });
		const baseCard = synthCard({
			name: 'Iron Beetle',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Insect',
			oracleText: 'Hexproof',
			power: '1',
			toughness: '1'
		});
		const topMutator = synthCard({
			name: 'Gilded Griffon',
			manaCost: '{3}{W}',
			cmc: 4,
			typeLine: 'Creature — Griffin',
			oracleText: 'Mutate {2}{W}\nFlying',
			power: '3',
			toughness: '4'
		});
		const cloneSpell = synthCard({
			name: 'Mirror Twin',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Create a token that\'s a copy of target creature you control.'
		});

		const basePerm = putInZone(s0, p1, baseCard, 'battlefield');
		const mutHand = putInZone(s0, p1, topMutator, 'hand');
		const cloneHand = putInZone(s0, p1, cloneSpell, 'hand');
		giveMana(p1, { W: 6, U: 6, C: 6 });

		const mutOpt = getCastOptions(s0, p1.playerId, mutHand, 'hand').find((o) => o.mutate)!;
		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'cast_spell',
				instanceId: mutHand.instanceId,
				optionId: mutOpt.id,
				targets: [{ kind: 'permanent', id: basePerm.instanceId, label: basePerm.card.name }]
			}).ok,
			true
		);
		resolveAllStack(s0);

		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'cast_spell',
				instanceId: cloneHand.instanceId,
				targets: [{ kind: 'permanent', id: basePerm.instanceId, label: basePerm.card.name }]
			}).ok,
			true
		);
		resolveAllStack(s0);

		const copyToken = p1.battlefield.find((c) => c.instanceId !== basePerm.instanceId)!;
		assert.ok(copyToken, 'Expected token copy of merged permanent');
		const copyEval = evaluatePermanent(s0, copyToken);
		assert.equal(copyEval.effectiveName, 'Gilded Griffon');
		assert.equal(copyEval.power, 3);
		assert.equal(copyEval.toughness, 4);
		assert.equal(hasKeyword(copyToken, 'Flying', s0), true);
		assert.equal(hasKeyword(copyToken, 'Hexproof', s0), true);
	});
});

// ============================================================================
// Group 2 — Fortify [cost] (CR 702.67a–c, CR 301.6, CR 704.5n)
// ============================================================================

describe('Wave 6 Track P18a — Fortify & Fortification SBAs (CR 702.67, CR 301.6)', () => {
	it('attaches Fortification to target controlled Land at sorcery speed and unattaches via SBA when illegal', () => {
		const { state, p1, p2 } = setupGame();
		const garrisonCard = synthCard({
			name: 'Bastion Rampart',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact — Fortification',
			oracleText: 'Fortify {2}'
		});
		// Attach a continuous Layer 6 keyword grant onto `'attachedTo'` to verify fortified land receives it
		const fortDef = compileCard(garrisonCard);
		fortDef.faces[0]!.abilities.push({
			kind: 'static',
			static: {
				k: 'continuous',
				layer: '6',
				affected: 'attachedTo',
				mod: { k: 'addKeywords', keywords: ['indestructible'] }
			},
			span: ZERO_SPAN
		});

		const landCard = synthCard({
			name: 'Citadel Meadow',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText: '{T}: Add {W}.'
		});
		const bearCard = synthCard({
			name: 'Hill Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			oracleText: '',
			power: '2',
			toughness: '2'
		});
		const animateSpell = synthCard({
			name: 'Awaken Steel',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText:
				'Target artifact becomes a 4/4 artifact creature until end of turn.'
		});

		const fort = putInZone(state, p1, garrisonCard, 'battlefield');
		const ownLand = putInZone(state, p1, landCard, 'battlefield');
		const oppLand = putInZone(state, p2, landCard, 'battlefield');
		const ownBear = putInZone(state, p1, bearCard, 'battlefield');
		const animHand = putInZone(state, p1, animateSpell, 'hand');

		const abilities = getEffectiveActivatedAbilities(state, p1, fort);
		const fortifyAb = abilities.find((a) => a.costKeyword === 'fortify');
		assert.ok(fortifyAb, 'Expected Fortify activated ability');
		assert.equal(fortifyAb.sorcerySpeedOnly, true);

		giveMana(p1, { U: 4, C: 10 });

		// 1. Instant-speed check: illegal during combat phase
		state.phase = 'declare_attackers';
		const badTiming = checkAbilityActivationLegality(state, p1.playerId, fort, fortifyAb);
		assert.equal(badTiming.ok, false);
		state.phase = 'main1';

		// 2. Rejects opponent's Land and rejects non-Land Creature
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: fort.instanceId,
				abilityId: fortifyAb.id,
				targets: [{ kind: 'permanent', id: oppLand.instanceId, label: oppLand.card.name }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: fort.instanceId,
				abilityId: fortifyAb.id,
				targets: [{ kind: 'permanent', id: ownBear.instanceId, label: ownBear.card.name }]
			}).ok,
			false
		);

		// 3. Attaches to controlled Land
		const okAct = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: fort.instanceId,
			abilityId: fortifyAb.id,
			targets: [{ kind: 'permanent', id: ownLand.instanceId, label: ownLand.card.name }]
		});
		assert.equal(okAct.ok, true, okAct.error ?? '');
		resolveAllStack(state);
		assert.equal(fort.attachedToId, ownLand.instanceId);
		assert.equal(hasKeyword(ownLand, 'Indestructible', state), true);

		// 4. CR 301.6 SBA: if Fortification becomes a Creature, it unattaches!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: animHand.instanceId,
				targets: [{ kind: 'permanent', id: fort.instanceId, label: fort.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(fort.attachedToId, null);
		assert.equal(hasKeyword(ownLand, 'Indestructible', state), false);
	});
});

// ============================================================================
// Group 3 — Soulbond (CR 702.95a–e)
// ============================================================================

describe('Wave 6 Track P18a — Soulbond (CR 702.95a–e)', () => {
	function makeSoulbondKnight(): ScryfallCard {
		const card = synthCard({
			name: 'Twinblade Paladin',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Human Knight',
			oracleText: 'Soulbond',
			power: '2',
			toughness: '2'
		});
		const def = compileCard(card);
		def.faces[0]!.abilities.push({
			kind: 'static',
			static: {
				k: 'continuous',
				layer: '7c',
				affected: 'self',
				condition: { k: 'isPaired' },
				mod: {
					k: 'pt',
					power: { k: 'const', n: 2 },
					toughness: { k: 'const', n: 2 }
				}
			},
			span: ZERO_SPAN
		});
		return card;
	}

	it('pairs on self-ETB via chooseObjects across JSON round-trip and unpairs on partner LTB (CR 702.95a, 702.95e)', () => {
		const { state: s0, p1 } = setupGame();
		const squireCard = synthCard({
			name: 'Loyal Squire',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Creature — Human Soldier',
			oracleText: '',
			power: '1',
			toughness: '1'
		});
		const soulbondCard = makeSoulbondKnight();

		const squire = putInZone(s0, p1, squireCard, 'battlefield');
		const sbHand = putInZone(s0, p1, soulbondCard, 'hand');
		giveMana(p1, { W: 4, C: 4 });

		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'cast_spell',
				instanceId: sbHand.instanceId
			}).ok,
			true
		);
		resolveAllStack(s0);
		assert.equal(s0.pendingPrompts.length, 1);
		assert.equal(s0.pendingPrompts[0]!.kind, 'chooseObjects');

		const state = answerTopPrompt(s0, {
			kind: 'chooseObjects',
			objectIds: [squire.instanceId]
		});
		resolveAllStack(state);

		const p1After = state.players[0]!;
		const sbPerm = p1After.battlefield.find((c) => c.card.name === 'Twinblade Paladin')!;
		const sqPerm = p1After.battlefield.find((c) => c.instanceId === squire.instanceId)!;
		assert.equal(sbPerm.pairedWithId, sqPerm.instanceId);
		assert.equal(sqPerm.pairedWithId, sbPerm.instanceId);

		// `{ k: 'isPaired' }` static grants +2/+2 -> 4/4!
		const evPaired = evaluatePermanent(state, sbPerm);
		assert.equal(evPaired.power, 4);
		assert.equal(evPaired.toughness, 4);

		// CR 702.95e: Partner leaves battlefield -> immediately unpaired!
		moveObject(state, sqPerm, 'graveyard', {
			from: { player: p1After, zone: 'battlefield' }
		});
		assert.equal(sbPerm.pairedWithId, undefined);
		const evUnpaired = evaluatePermanent(state, sbPerm);
		assert.equal(evUnpaired.power, 2);
		assert.equal(evUnpaired.toughness, 2);
	});

	it('triggers soulbond_other on another creature entering when unpaired, does not trigger while already paired, and unpairs on control change', () => {
		const { state: s0, p1 } = setupGame();
		const soulbondCard = makeSoulbondKnight();
		const bearCard = synthCard({
			name: 'Meadow Cub',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			oracleText: '',
			power: '2',
			toughness: '2'
		});

		// Put Soulbond creature alone on battlefield (unpaired)
		const sbPerm = putInZone(s0, p1, soulbondCard, 'battlefield');
		const bear1Hand = putInZone(s0, p1, bearCard, 'hand');
		const bear2Hand = putInZone(s0, p1, bearCard, 'hand');
		giveMana(p1, { G: 6, C: 6 });

		// Cast first bear -> triggers soulbond_other (`yesNo`)
		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'cast_spell',
				instanceId: bear1Hand.instanceId
			}).ok,
			true
		);
		resolveAllStack(s0);
		assert.equal(s0.pendingPrompts.length, 1);
		assert.equal(s0.pendingPrompts[0]!.kind, 'yesNo');

		const state = answerTopPrompt(s0, { kind: 'yesNo', yes: true });
		resolveAllStack(state);

		const p1After = state.players[0]!;
		const p2After = state.players[1]!;
		const sbAfter = p1After.battlefield.find((c) => c.instanceId === sbPerm.instanceId)!;
		const bear1Perm = p1After.battlefield.find((c) => c.instanceId !== sbPerm.instanceId)!;
		assert.equal(sbAfter.pairedWithId, bear1Perm.instanceId);

		// Cast second bear while ALREADY paired -> intervening-if `{ k: 'not', of: { k: 'isPaired' } }` blocks trigger!
		const bear2After = p1After.hand.find((c) => c.instanceId === bear2Hand.instanceId)!;
		assert.equal(
			applyGameAction(state, p1After.playerId, {
				type: 'cast_spell',
				instanceId: bear2After.instanceId
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(sbAfter.pairedWithId, bear1Perm.instanceId);

		// CR 702.95e: Opponent gains control of bear1 via Layer 2 -> unpairs immediately!
		const stealSpell = putInZone(
			state,
			p2After,
			synthCard({
				name: 'Sudden Betrayal',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Gain control of target creature until end of turn.'
			}),
			'hand'
		);
		giveMana(p2After, { R: 4, C: 4 });
		assert.equal(
			applyGameAction(state, p1After.playerId, { type: 'pass_priority' }).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p2After.playerId, {
				type: 'cast_spell',
				instanceId: stealSpell.instanceId,
				targets: [{ kind: 'permanent', id: bear1Perm.instanceId, label: bear1Perm.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(sbAfter.pairedWithId, undefined);
		assert.equal(bear1Perm.pairedWithId, undefined);
	});
});

// ============================================================================
// Group 4 — Banding (CR 702.22a–k)
// ============================================================================

describe('Wave 6 Track P18a — Banding (CR 702.22a–k)', () => {
	const bandingGuard = () =>
		synthCard({
			name: 'Phalanx Vanguard',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Creature — Human Soldier',
			oracleText: 'Banding',
			power: '1',
			toughness: '4'
		});

	it('validates attacking band declarations (N Banding + <= 1 non-Banding, same defender) and propagates blockers across bands (CR 702.22c, 702.22h)', () => {
		const { state, p1, p2 } = setupGame();
		const b1 = putInZone(state, p1, bandingGuard(), 'battlefield');
		const flyer = putInZone(
			state,
			p1,
			synthCard({
				name: 'Sky Falcon',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Bird',
				oracleText: 'Flying',
				power: '3',
				toughness: '2'
			}),
			'battlefield'
		);
		const extraNonBand = putInZone(
			state,
			p1,
			synthCard({
				name: 'Plain Footman',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Soldier',
				oracleText: '',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const groundBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Stone Tortoise',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Turtle',
				oracleText: '',
				power: '0',
				toughness: '6'
			}),
			'battlefield'
		);

		advanceToPhase(state, 'declare_attackers', 0);

		// 1. Rejects band with 2 non-Banding creatures (CR 702.22c)
		const badTwoNonBand = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{ attackerInstanceId: b1.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: flyer.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: extraNonBand.instanceId, defenderPlayerId: p2.playerId }
			],
			bands: [[b1.instanceId, flyer.instanceId, extraNonBand.instanceId]]
		});
		assert.equal(badTwoNonBand.ok, false);

		// 2. Legal band: 1 Banding + 1 Flying non-Banding
		const okBand = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{ attackerInstanceId: b1.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: flyer.instanceId, defenderPlayerId: p2.playerId }
			],
			bands: [[b1.instanceId, flyer.instanceId]]
		});
		assert.equal(okBand.ok, true, okBand.error ?? '');
		assert.equal(state.combat.bands?.length, 1);

		advanceToPhase(state, 'declare_blockers', 0);

		// Ground blocker blocks ONLY the ground Banding creature `b1` -> CR 702.22h propagates block to `flyer`!
		const blkRes = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: groundBlocker.instanceId, attackerInstanceId: b1.instanceId }
			]
		});
		assert.equal(blkRes.ok, true, blkRes.error ?? '');
		const flyerAtkEntry = state.combat.attackers.find(
			(a) => a.attackerInstanceId === flyer.instanceId
		)!;
		assert.equal(flyerAtkEntry.wasBlocked, true);
		assert.deepEqual(flyerAtkEntry.blockerInstanceIds, [groundBlocker.instanceId]);

		const p2LifeBefore = p2.life;
		advanceToPhase(state, 'main2', 0);
		// Flying bandmate was blocked via band propagation -> 0 damage dealt to p2!
		assert.equal(p2.life, p2LifeBefore);
	});

	it('lets defending player with a Banding blocker concentrate all of a Trample attacker\'s combat damage onto one blocker (CR 702.22j)', () => {
		const { state: s0, p1, p2 } = setupGame();
		const trampler = putInZone(
			s0,
			p1,
			synthCard({
				name: 'Colossal Rhino',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Creature — Rhino',
				oracleText: 'Trample',
				power: '6',
				toughness: '6'
			}),
			'battlefield'
		);
		const chumpBander = putInZone(
			s0,
			p2,
			synthCard({
				name: 'Shield Bearer',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Creature — Soldier',
				oracleText: 'Banding',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const bigBlocker = putInZone(
			s0,
			p2,
			synthCard({
				name: 'Oaken Guardian',
				manaCost: '{3}{G}',
				cmc: 4,
				typeLine: 'Creature — Treefolk',
				oracleText: '',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);

		advanceToPhase(s0, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: trampler.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		advanceToPhase(s0, 'declare_blockers', 0);
		assert.equal(
			applyGameAction(s0, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: chumpBander.instanceId,
						attackerInstanceId: trampler.instanceId
					},
					{
						blockerInstanceId: bigBlocker.instanceId,
						attackerInstanceId: trampler.instanceId
					}
				]
			}).ok,
			true
		);

		const p2LifeBefore = p2.life;
		advanceToPhase(s0, 'main2', 0);
		// Pauses at combat damage assignment — prompt is sent to DEFENDER p2 (not attacker p1!) per CR 702.22j!
		assert.equal(s0.pendingPrompts.length, 1);
		assert.equal(s0.pendingPrompts[0]!.playerId, p2.playerId);
		assert.equal(s0.pendingPrompts[0]!.kind, 'chooseNumber');

		// Defender assigns ALL 6 damage to the 1/1 Banding blocker across JSON round-trip!
		const state = answerTopPrompt(s0, { kind: 'chooseNumber', n: 6 });
		advanceToPhase(state, 'main2', 0);

		const p2After = state.players[1]!;
		// 0 trample damage dealt to p2, and Oaken Guardian (4/4) survived with 0 damage!
		assert.equal(p2After.life, p2LifeBefore);
		assert.ok(
			p2After.battlefield.some((c) => c.instanceId === bigBlocker.instanceId),
			'4/4 blocker survived unscathed'
		);
	});

	it('lets attacking player divide a blocker\'s combat damage onto the chosen Banding bandmate across JSON round-trip (CR 702.22k)', () => {
		const { state: s0, p1, p2 } = setupGame();
		const tankBander = putInZone(s0, p1, bandingGuard(), 'battlefield'); // 1/4 Banding
		const fragileHitter = putInZone(
			s0,
			p1,
			synthCard({
				name: 'Glass Striker',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Warrior',
				oracleText: '',
				power: '3',
				toughness: '1'
			}),
			'battlefield'
		);
		const blocker = putInZone(
			s0,
			p2,
			synthCard({
				name: 'Cave Troll',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Troll',
				oracleText: '',
				power: '3',
				toughness: '5'
			}),
			'battlefield'
		);

		advanceToPhase(s0, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: tankBander.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: fragileHitter.instanceId, defenderPlayerId: p2.playerId }
				],
				bands: [[tankBander.instanceId, fragileHitter.instanceId]]
			}).ok,
			true
		);
		advanceToPhase(s0, 'declare_blockers', 0);
		assert.equal(
			applyGameAction(s0, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: blocker.instanceId, attackerInstanceId: tankBander.instanceId }
				]
			}).ok,
			true
		);

		advanceToPhase(s0, 'main2', 0);
		// Blocker (3 power) blocks both bandmates; ATTACKER p1 gets to assign the 3 damage (CR 702.22k)!
		assert.equal(s0.pendingPrompts.length, 1);
		assert.equal(s0.pendingPrompts[0]!.playerId, p1.playerId);
		assert.equal(s0.pendingPrompts[0]!.kind, 'chooseNumber');

		// Put all 3 blocker damage onto first attacker (`tankBander`, 1/4) -> BOTH attackers survive!
		const state = answerTopPrompt(s0, { kind: 'chooseNumber', n: 3 });
		advanceToPhase(state, 'main2', 0);

		const p1After = state.players[0]!;
		assert.equal(p1After.battlefield.length, 2, 'Both bandmates survived');
	});
});

// ============================================================================
// Group 5 — Teamwork [N] (CR 702.194a–c) & Storied (CR 702.195a–c)
// ============================================================================

describe('Wave 6 Track P18a — Teamwork & Storied (CR 702.194, CR 702.195)', () => {
	it('compiles Teamwork N & bare Teamwork, enforces subset-sum power >= N, taps chosen creatures, and sets teamwork kicked tag', () => {
		const { state, p1 } = setupGame();
		const teamworkSpell = synthCard({
			name: 'Rallying Volley',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Teamwork 4\nYou gain 2 life.'
		});
		// Add a conditional bonus step when `kicked` (`'teamwork'`) is true
		const twDef = compileCard(teamworkSpell);
		const spellAb = twDef.faces[0]!.abilities.find((a) => a.kind === 'spell');
		assert.ok(spellAb && spellAb.kind === 'spell');
		spellAb.effect.push({
			verb: 'gainLife',
			subject: { k: 'player', filter: { relation: 'you' } },
			amount: { k: 'const', n: 5 },
			condition: { k: 'kicked', tag: 'teamwork' },
			span: ZERO_SPAN
		});

		const bareTeamworkCard = synthCard({
			name: 'Coordinated Strike',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Teamwork\nDraw a card.'
		});
		assert.equal(cardSupportReport(bareTeamworkCard).unsupported.length, 0);

		const c2 = putInZone(
			state,
			p1,
			synthCard({ name: 'Ally A', typeLine: 'Creature — Ally', power: '2', toughness: '2' }),
			'battlefield'
		);
		const c3 = putInZone(
			state,
			p1,
			synthCard({ name: 'Ally B', typeLine: 'Creature — Ally', power: '3', toughness: '3' }),
			'battlefield'
		);
		const spellInst = putInZone(state, p1, teamworkSpell, 'hand');
		giveMana(p1, { W: 4, C: 4 });

		// 1. Rejects Teamwork 4 when selected creatures only have total power 2 (< 4)
		const tooLow = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spellInst.instanceId,
			optionalCostCounts: { 'teamwork:0': 1 },
			costPayment: { objects: [[c2.instanceId]] }
		});
		assert.equal(tooLow.ok, false);
		assert.equal(c2.tapped, false);

		// 2. Accepts Teamwork 4 when tapping Ally A (2) + Ally B (3) = total power 5 >= 4
		const lifeBefore = p1.life;
		const okCast = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spellInst.instanceId,
			optionalCostCounts: { 'teamwork:0': 1 },
			costPayment: { objects: [[c2.instanceId, c3.instanceId]] }
		});
		assert.equal(okCast.ok, true, okCast.error ?? '');
		assert.equal(c2.tapped, true);
		assert.equal(c3.tapped, true);
		resolveAllStack(state);
		// Base 2 life + 5 Teamwork bonus life = +7!
		assert.equal(p1.life, lifeBefore + 7);
	});

	it('grants enduring story via Storied at >= 3 artifacts/legendaries/Sagas and keeps it for the rest of the game (CR 702.195a–c)', () => {
		const { state, p1 } = setupGame();
		const storiedChronicler = synthCard({
			name: 'Sage of Old Tales',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Advisor',
			oracleText: 'Storied',
			power: '2',
			toughness: '2'
		});
		const def = compileCard(storiedChronicler);
		def.faces[0]!.abilities.push({
			kind: 'static',
			static: {
				k: 'continuous',
				layer: '7c',
				affected: 'self',
				condition: { k: 'hasEnduringStory' },
				mod: {
					k: 'pt',
					power: { k: 'const', n: 3 },
					toughness: { k: 'const', n: 3 }
				}
			},
			span: ZERO_SPAN
		});

		const relic1 = synthCard({
			name: 'Bronze Scroll',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Artifact',
			oracleText: ''
		});
		const legend2 = synthCard({
			name: 'Heroic Banner',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Legendary Enchantment',
			oracleText: ''
		});
		const saga3 = synthCard({
			name: 'Chronicle of Dawn',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Enchantment — Saga',
			oracleText: 'I — You gain 1 life.'
		});

		const sage = putInZone(state, p1, storiedChronicler, 'battlefield');
		const r1 = putInZone(state, p1, relic1, 'battlefield');
		const r2 = putInZone(state, p1, legend2, 'battlefield');
		checkStateBasedActions(state);

		// Only 2 historic permanents -> NO enduring story yet!
		assert.equal(Boolean(p1.hasEnduringStory), false);
		assert.equal(evaluatePermanent(state, sage).power, 2);

		// 3rd historic permanent enters -> immediately grants `hasEnduringStory`!
		const r3 = putInZone(state, p1, saga3, 'battlefield');
		checkStateBasedActions(state);
		assert.equal(p1.hasEnduringStory, true);
		assert.equal(evaluatePermanent(state, sage).power, 5);

		// CR 702.195b: Persists for the rest of the game even after all 3 historic permanents leave!
		moveObject(state, r1, 'graveyard', { from: { player: p1, zone: 'battlefield' } });
		moveObject(state, r2, 'graveyard', { from: { player: p1, zone: 'battlefield' } });
		moveObject(state, r3, 'graveyard', { from: { player: p1, zone: 'battlefield' } });
		checkStateBasedActions(state);
		assert.equal(p1.hasEnduringStory, true);
		assert.equal(evaluatePermanent(state, sage).power, 5);
	});
});

// ============================================================================
// Group 6 — Hideaway [N] (CR 702.75a–b) & Tribute N (CR 702.104a–b)
// ============================================================================

describe('Wave 6 Track P18a — Hideaway & Tribute (CR 702.75, CR 702.104)', () => {
	it('resolves Hideaway N across JSON round-trip: exiles 1 of top N face down linked via exiledBy and puts N-1 on bottom of library', () => {
		const { state: s0, p1 } = setupGame();
		const hideawayLand = synthCard({
			name: 'Sunken Vault',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText: 'Hideaway 5\n~ enters tapped.\n{T}: Add {U}.'
		});
		const bareHideawayLand = synthCard({
			name: 'Mossy Hollow',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText: 'Hideaway\n{T}: Add {G}.'
		});
		assert.equal(cardSupportReport(hideawayLand).unsupported.length, 0);
		assert.equal(cardSupportReport(bareHideawayLand).unsupported.length, 0);

		p1.library = [];
		const libCards = Array.from({ length: 7 }, (_, idx) =>
			createCardInstance(
				synthCard({
					name: `Vault Card ${idx + 1}`,
					manaCost: `{${idx + 1}}`,
					cmc: idx + 1,
					typeLine: 'Artifact'
				}),
				p1.playerId,
				'library'
			)
		);
		p1.library.push(...libCards);
		const topFiveIds = libCards.slice(0, 5).map((c) => c.instanceId);
		const card6Id = libCards[5]!.instanceId;
		const card7Id = libCards[6]!.instanceId;

		const landHand = putInZone(s0, p1, hideawayLand, 'hand');
		assert.equal(
			applyGameAction(s0, p1.playerId, {
				type: 'play_land',
				instanceId: landHand.instanceId
			}).ok,
			true
		);
		resolveAllStack(s0);
		assert.equal(s0.pendingPrompts.length, 1);
		assert.equal(s0.pendingPrompts[0]!.kind, 'chooseObjects');
		assert.deepEqual(
			s0.pendingPrompts[0]!.choice?.kind === 'chooseObjects'
				? s0.pendingPrompts[0]!.choice.candidates
				: [],
			topFiveIds
		);

		const pickId = libCards[2]!.instanceId;
		const state = answerTopPrompt(s0, { kind: 'chooseObjects', objectIds: [pickId] });
		resolveAllStack(state);

		const p1After = state.players[0]!;
		const vaultPerm = p1After.battlefield[0]!;
		assert.equal(p1After.exile.length, 1);
		const exiled = p1After.exile[0]!;
		assert.equal(exiled.instanceId, pickId);
		assert.equal(exiled.isFaceDown, true);
		assert.equal(exiled.exiledBy?.sourceInstanceId, vaultPerm.instanceId);
		assert.ok(exiled.knownToPlayerIds?.includes(p1After.playerId));

		// Cards 6 and 7 are now at the TOP of the library (`[0]` and `[1]`), while the 4 unchosen cards are on the bottom!
		assert.equal(p1After.library.length, 6);
		assert.equal(p1After.library[0]!.instanceId, card6Id);
		assert.equal(p1After.library[1]!.instanceId, card7Id);
	});

	it('prompts opponent for Tribute N on ETB across JSON round-trip and handles both paid and unpaid branches (CR 702.104a–b)', () => {
		function makeTributeHydra(): ScryfallCard {
			const card = synthCard({
				name: 'Oran Hydra',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Hydra',
				oracleText: 'Tribute 3',
				power: '3',
				toughness: '3'
			});
			const def = compileCard(card);
			def.faces[0]!.abilities.push({
				kind: 'triggered',
				trigger: { event: 'zoneChange', filter: { to: 'battlefield', object: 'self' } },
				condition: { k: 'not', of: { k: 'tributePaid' } },
				targets: [],
				effect: [
					{
						verb: 'loseLife',
						subject: { k: 'player', filter: { relation: 'each_opponent' } },
						amount: { k: 'const', n: 4 },
						span: ZERO_SPAN
					}
				],
				span: ZERO_SPAN
			});
			return card;
		}

		// Case A: Opponent PAYS tribute (`yes: true`) -> +3 +1/+1 counters, `tributePaid === true`, punisher does NOT fire
		{
			const { state: s0, p1, p2 } = setupGame();
			const hydraHand = putInZone(s0, p1, makeTributeHydra(), 'hand');
			giveMana(p1, { G: 4, C: 4 });
			assert.equal(
				applyGameAction(s0, p1.playerId, {
					type: 'cast_spell',
					instanceId: hydraHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(s0);
			assert.equal(s0.pendingPrompts.length, 1);
			assert.equal(s0.pendingPrompts[0]!.playerId, p2.playerId);
			assert.equal(s0.pendingPrompts[0]!.kind, 'yesNo');

			const p2LifeBefore = p2.life;
			const state = answerTopPrompt(s0, { kind: 'yesNo', yes: true });
			resolveAllStack(state);

			const hydraPerm = state.players[0]!.battlefield[0]!;
			assert.equal(hydraPerm.tributePaid, true);
			assert.equal(hydraPerm.counters['+1/+1'], 3);
			assert.equal(evaluatePermanent(state, hydraPerm).power, 6);
			assert.equal(state.players[1]!.life, p2LifeBefore);
		}

		// Case B: Opponent DECLINES tribute (`yes: false`) -> 0 counters, `tributePaid === false`, punisher trigger fires!
		{
			const { state: s0, p1, p2 } = setupGame();
			const hydraHand = putInZone(s0, p1, makeTributeHydra(), 'hand');
			giveMana(p1, { G: 4, C: 4 });
			assert.equal(
				applyGameAction(s0, p1.playerId, {
					type: 'cast_spell',
					instanceId: hydraHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(s0);
			const p2LifeBefore = p2.life;
			const state = answerTopPrompt(s0, { kind: 'yesNo', yes: false });
			resolveAllStack(state);

			const hydraPerm = state.players[0]!.battlefield[0]!;
			assert.equal(hydraPerm.tributePaid, false);
			assert.equal(hydraPerm.counters['+1/+1'] ?? 0, 0);
			assert.equal(state.players[1]!.life, p2LifeBefore - 4);
		}
	});
});

// ============================================================================
// Group 7 — Haunt (CR 702.55a–c) & Epic (CR 702.50a–b)
// ============================================================================

describe('Wave 6 Track P18a — Haunt & Epic (CR 702.55, CR 702.50)', () => {
	it('exiles a dying Haunt creature haunting target creature and triggers from exile when haunted creature dies (CR 702.55a–c)', () => {
		const { state, p1, p2 } = setupGame({ p1Bot: true });
		const hauntSpirit = synthCard({
			name: 'Belfry Apparition',
			manaCost: '{1}{W}{B}',
			cmc: 3,
			typeLine: 'Creature — Spirit',
			oracleText: 'Haunt',
			power: '2',
			toughness: '2'
		});
		const spiritDef = compileCard(hauntSpirit);
		spiritDef.faces[0]!.abilities.push({
			kind: 'triggered',
			trigger: {
				event: 'hauntedCreatureDies',
				filter: {},
				fromZone: 'exile'
			},
			targets: [],
			effect: [
				{
					verb: 'gainLife',
					subject: { k: 'player', filter: { relation: 'you' } },
					amount: { k: 'const', n: 4 },
					span: ZERO_SPAN
				}
			],
			span: ZERO_SPAN
		});

		const victimCard = synthCard({
			name: 'Doomed Goblin',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Creature — Goblin',
			oracleText: '',
			power: '1',
			toughness: '1'
		});

		const spiritPerm = putInZone(state, p1, hauntSpirit, 'battlefield');
		const victimPerm = putInZone(state, p2, victimCard, 'battlefield');

		// 1. Spirit dies to lethal damage -> Haunt trigger goes on stack targeting `victimPerm` -> exiles Spirit haunting `victimPerm`
		spiritPerm.damageMarked = 5;
		checkStateBasedActions(state);
		resolveAllStack(state);

		assert.equal(p1.exile.length, 1);
		assert.equal(p1.exile[0]!.hauntingTargetId, victimPerm.instanceId);
		assert.equal(victimPerm.hauntedByCards?.length, 1);

		// 2. Haunted creature dies -> `hauntedCreatureDies` triggers from exile and gains 4 life!
		const lifeBefore = p1.life;
		victimPerm.damageMarked = 5;
		checkStateBasedActions(state);
		resolveAllStack(state);
		assert.equal(p1.life, lifeBefore + 4);
	});

	it('exiles a resolving Haunt instant haunting target creature and re-fires its spell effect when haunted creature dies (CR 702.55a, 702.55c)', () => {
		const { state, p1, p2 } = setupGame({ p1Bot: true });
		const hauntChant = synthCard({
			name: 'Echoing Benediction',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Haunt\nYou gain 3 life.'
		});
		const hostCreature = putInZone(
			state,
			p2,
			synthCard({
				name: 'Frail Imp',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Creature — Imp',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const chantHand = putInZone(state, p1, hauntChant, 'hand');
		giveMana(p1, { W: 3, C: 3 });

		const lifeStart = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: chantHand.instanceId
			}).ok,
			true
		);
		resolveAllStack(state);

		// Gained 3 life on resolution AND exiled haunting `hostCreature`!
		assert.equal(p1.life, lifeStart + 3);
		assert.equal(p1.exile.length, 1);
		assert.equal(p1.exile[0]!.hauntingTargetId, hostCreature.instanceId);

		// Haunted creature dies -> spell effect triggers again from exile (+3 more life = +6 total)!
		hostCreature.damageMarked = 5;
		checkStateBasedActions(state);
		resolveAllStack(state);
		assert.equal(p1.life, lifeStart + 6);
	});

	it('locks out spell casting for the rest of the game after Epic resolves and copies the spell on each subsequent upkeep (CR 702.50a–b)', () => {
		const { state, p1, p2 } = setupGame();
		const epicSorcery = synthCard({
			name: 'Unending Concord',
			manaCost: '{3}{W}{W}',
			cmc: 5,
			typeLine: 'Sorcery',
			oracleText: 'You gain 4 life.\nEpic'
		});
		const followUpSpell = synthCard({
			name: 'Minor Heal',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'You gain 1 life.'
		});

		const epicHand = putInZone(state, p1, epicSorcery, 'hand');
		const blockedHand = putInZone(state, p1, followUpSpell, 'hand');
		const oppSpell = putInZone(state, p2, followUpSpell, 'hand');
		giveMana(p1, { W: 10, C: 10 });
		giveMana(p2, { W: 5, C: 5 });

		const lifeStart = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: epicHand.instanceId
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(p1.life, lifeStart + 4);
		assert.equal(p1.cannotCastSpellsForRestOfGame, true);
		assert.equal(p1.epicSpells?.length, 1);

		// 1. p1 CANNOT cast any spells for the rest of the game (CR 702.50a)!
		assert.equal(getCastOptions(state, p1.playerId, blockedHand, 'hand').length, 0);
		const blockedCast = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: blockedHand.instanceId
		});
		assert.equal(blockedCast.ok, false);

		// 2. Opponent p2 CAN still cast spells normally when holding priority
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.ok(getCastOptions(state, p2.playerId, oppSpell, 'hand').length > 0);

		// 3. Advance through p2's turn to p1's NEXT upkeep -> Epic delayed trigger copies Unending Concord!
		advanceToPhase(state, 'main1', 1);
		advanceToPhase(state, 'main1', 0);

		assert.equal(p1.life, lifeStart + 8);
		// Resolving the Epic copy (`isCopy === true`) did NOT add a second entry to `p1.epicSpells`!
		assert.equal(p1.epicSpells?.length, 1);
	});
});

// ============================================================================
// Group 8 — Poisonous N (CR 702.70), Absorb N (CR 702.64), & Frenzy N (CR 702.68)
// ============================================================================

describe('Wave 6 Track P18a — Poisonous, Absorb, & Frenzy (CR 702.70, 702.64, 702.68)', () => {
	it('triggers Poisonous N on combat damage to a player (stacking with Layer 6 grants) and ignores non-combat damage (CR 702.70a–b)', () => {
		const { state, p1, p2 } = setupGame();
		const viperCard = synthCard({
			name: 'Marsh Viperling',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Creature — Snake',
			oracleText: 'Poisonous 1\n{T}: ~ deals 1 damage to any target.',
			power: '1',
			toughness: '1'
		});
		const sliverLordCard = synthCard({
			name: 'Venomous Hive',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control have poisonous 2.'
		});

		const viper = putInZone(state, p1, viperCard, 'battlefield');
		putInZone(state, p1, sliverLordCard, 'battlefield');

		// 1. Non-combat ping damage to p2 -> 0 poison counters!
		const pingAb = getEffectiveActivatedAbilities(state, p1, viper)[0]!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: viper.instanceId,
				abilityId: pingAb.id,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.poison, 0);

		// Untap viper and attack unblocked -> Poisonous 1 + granted Poisonous 2 both trigger separately = 3 poison!
		viper.tapped = false;
		advanceToPhase(state, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: viper.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advanceToPhase(state, 'main2', 0);
		assert.equal(p2.poison, 3);
	});

	it('prevents N damage per event via Absorb N and stacks multiple Absorb instances (CR 702.64a–c)', () => {
		const { state, p1 } = setupGame();
		const lymphCard = synthCard({
			name: 'Carapace Sliverling',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Beast',
			oracleText: 'Absorb 1',
			power: '2',
			toughness: '4'
		});
		const grantCard = synthCard({
			name: 'Shell Aegis',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control have absorb 2.'
		});
		const boltCard = synthCard({
			name: 'Flame Lance',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: '~ deals 4 damage to target creature.'
		});

		const beast = putInZone(state, p1, lymphCard, 'battlefield');
		putInZone(state, p1, grantCard, 'battlefield');
		const bolt = putInZone(state, p1, boltCard, 'hand');
		giveMana(p1, { R: 3, C: 3 });

		// Absorb 1 + granted Absorb 2 = prevents 3 of the 4 damage -> only 1 damage marked!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: beast.instanceId, label: beast.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(beast.damageMarked, 1);
	});

	it('pumps attacking unblocked creatures via Frenzy N (stacking with Layer 6 grants) and does not pump when blocked (CR 702.68a–b)', () => {
		const { state, p1, p2 } = setupGame();
		const goblinCard = synthCard({
			name: 'Reckless Raider',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Goblin Berserker',
			oracleText: 'Frenzy 2',
			power: '2',
			toughness: '2'
		});
		const frenzyAnthem = synthCard({
			name: 'Bloodlust Drums',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control have frenzy 1.'
		});

		const raider1 = putInZone(state, p1, goblinCard, 'battlefield');
		const raider2 = putInZone(state, p1, goblinCard, 'battlefield');
		putInZone(state, p1, frenzyAnthem, 'battlefield');
		const wall = putInZone(
			state,
			p2,
			synthCard({
				name: 'Granite Wall',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Wall',
				oracleText: 'Defender',
				power: '0',
				toughness: '6'
			}),
			'battlefield'
		);

		const p2LifeStart = p2.life;
		advanceToPhase(state, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: raider1.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: raider2.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		advanceToPhase(state, 'declare_blockers', 0);
		// Block `raider2`, leave `raider1` unblocked!
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: wall.instanceId, attackerInstanceId: raider2.instanceId }
				]
			}).ok,
			true
		);
		advanceToPhase(state, 'main2', 0);

		// Unblocked `raider1` got +2/+0 (Frenzy 2) + +1/+0 (granted Frenzy 1) = 5 power -> dealt 5 combat damage!
		assert.equal(evaluatePermanent(state, raider1).power, 5);
		assert.equal(p2.life, p2LifeStart - 5);
		// Blocked `raider2` did NOT trigger Frenzy -> stayed at 2 power (2 damage marked on 0/6 Wall)!
		assert.equal(evaluatePermanent(state, raider2).power, 2);
		assert.equal(wall.damageMarked, 2);
	});
});

// ============================================================================
// Group 9 — Synthetic Rename Invariance Across All 13 Track P18a Keywords
// ============================================================================

describe('Wave 6 Track P18a — Rename Invariance & Zero-Unsupported Compilation', () => {
	const CASES: Array<{ kw: string; typeLine: string; oracleText: string }> = [
		{ kw: 'absorb', typeLine: 'Creature — Sliver', oracleText: 'Absorb 2' },
		{ kw: 'banding', typeLine: 'Creature — Soldier', oracleText: 'Banding' },
		{ kw: 'epic', typeLine: 'Sorcery', oracleText: 'You gain 3 life.\nEpic' },
		{ kw: 'fortify', typeLine: 'Artifact — Fortification', oracleText: 'Fortify {3}' },
		{ kw: 'frenzy', typeLine: 'Creature — Goblin', oracleText: 'Frenzy 2' },
		{ kw: 'haunt', typeLine: 'Creature — Spirit', oracleText: 'Haunt' },
		{ kw: 'hideaway', typeLine: 'Land', oracleText: 'Hideaway 4\n{T}: Add {W}.' },
		{ kw: 'mutate', typeLine: 'Creature — Beast', oracleText: 'Mutate {2}{G}\nReach' },
		{ kw: 'poisonous', typeLine: 'Creature — Snake', oracleText: 'Poisonous 1' },
		{ kw: 'soulbond', typeLine: 'Creature — Human', oracleText: 'Soulbond' },
		{ kw: 'storied', typeLine: 'Creature — Advisor', oracleText: 'Storied' },
		{ kw: 'teamwork', typeLine: 'Sorcery', oracleText: 'Teamwork 3\nDraw a card.' },
		{ kw: 'tribute', typeLine: 'Creature — Hydra', oracleText: 'Tribute 2' }
	];

	it('compiles all 13 Track P18a keywords with zero unsupported abilities and identical IR under card renaming', () => {
		for (let i = 0; i < CASES.length; i++) {
			const c = CASES[i]!;
			const cardA = synthCard({
				name: `Alpha ${i} Specimen`,
				typeLine: c.typeLine,
				oracleText: c.oracleText
			});
			const cardB = synthCard({
				name: `Omega ${i} Contender`,
				typeLine: c.typeLine,
				oracleText: c.oracleText
			});
			const repA = cardSupportReport(cardA);
			const repB = cardSupportReport(cardB);
			assert.equal(
				repA.unsupported.length,
				0,
				`Expected 0 unsupported abilities for ${c.kw}: ${JSON.stringify(repA.unsupported)}`
			);
			assert.equal(repB.unsupported.length, 0);

			const irA = compileCard(cardA).faces[0]!.abilities;
			const irB = compileCard(cardB).faces[0]!.abilities;
			assert.deepEqual(irA, irB, `IR differed under rename for ${c.kw}`);
		}
	});
});
