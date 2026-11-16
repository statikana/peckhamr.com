/**
 * Precon Assurance: "Bragos Spirit" (Archidekt #20701889).
 *
 * Behaviour tests for the general mechanics the deck needed, using synthetic cards with invented
 * names (ENGINE_INVARIANTS.md 1.3): every card is also compiled under a second invented name to
 * check rename invariance.
 *
 * - CR 700.4 "leave the battlefield without dying" batched zone-change trigger (`notToZone`)
 * - CR 406.3 "is exiled from the battlefield" trigger alias
 * - CR 205.3m "Choose a creature type. ... of that type" on a resolving spell
 * - CR 102.3 "investigate X times, where X is the number of opponents you have"
 * - CR 500.11 "skips their next combat phase" (`skipCombatPhase`)
 * - CR 101.2 "can't cast spells with the same name as that creature until your next turn" (`castNameLock`)
 * - CR 115.1 "target spell or permanent" (`alsoSpells`) and "for each opponent, up to one target ... that
 *   player controls" (`perOpponent`)
 * - CR 607.2a "the exiled card's owner creates an X/X ... where X is the mana value of the exiled card" (`linkedExile`)
 * - CR 706.3b die-roll rows that refer back to "those cards" exiled before the roll (incl. delayed returns)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { staticallyInterpretable } from '../compiler/interpretable.ts';
import {
	advancePhaseOrStep,
	applyGameAction,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { nextRandom } from './random.ts';
import { expireP13UntilNextTurnEffects } from './effectsWave5.ts';
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
		id: `bragos_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

function creature(name: string, power: string, toughness: string, subtype = 'Spirit', oracleText = ''): ScryfallCard {
	return makeCard({ name, manaCost: '{1}', cmc: 1, typeLine: `Creature — ${subtype}`, power, toughness, oracleText });
}

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function playerTarget(player: PlayerGameState): TargetRef {
	return { kind: 'player', id: player.playerId, label: player.username };
}

function roundTrip(state: GameState): GameState {
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

function createGame(playerCount = 2): GameState {
	const seats: LobbySeat[] = Array.from({ length: playerCount }, (_, i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length]!;
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
	const decks = new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]!]));
	const state = createInitialGameState('BRAGOS', seats, decks, { ...DEFAULT_LOBBY_RULES });
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

function put(
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

/** Passes priority until the stack is empty or a non-ordering prompt is pending. */
function settle(state: GameState): void {
	for (let guard = 0; guard < 32; guard++) {
		const pr = state.pendingPrompts[0];
		if (state.pendingPrompts.length === 1 && pr?.purpose === 'trigger_order' && pr.choice?.kind === 'orderObjects') {
			const res = applyGameAction(state, pr.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'orderObjects', topIds: pr.choice.objectIds }
			});
			assert.equal(res.ok, true, res.error ?? '');
			continue;
		}
		if (state.pendingPrompts.length > 0) return;
		if (state.stack.length === 0) return;
		const prio = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function answer(state: GameState, ans: ChoiceAnswer): { ok: boolean; error?: string } {
	const prompt = state.pendingPrompts[0];
	assert.ok(prompt, 'expected a pending prompt');
	return applyGameAction(state, prompt.playerId, { type: 'choice', promptId: prompt.id, answer: ans });
}

function cast(state: GameState, player: PlayerGameState, inst: CardInstance, targets?: TargetRef[]): void {
	const res = applyGameAction(state, player.playerId, {
		type: 'cast_spell',
		instanceId: inst.instanceId,
		...(targets ? { targets } : {})
	});
	assert.equal(res.ok, true, res.error ?? '');
}

/** A card text in two invented names; `~` stands for the card's own name. */
const SAMPLES: Array<{ typeLine: string; oracle: string; power?: string; toughness?: string }> = [
	{ typeLine: 'Sorcery', oracle: 'Choose a creature type. Draw a card for each permanent you control of that type.' },
	{
		typeLine: 'Creature — Frog Wizard',
		oracle: 'Whenever one or more other creatures you control leave the battlefield without dying, draw a card.',
		power: '3',
		toughness: '3'
	},
	{
		typeLine: 'Creature — Spirit',
		oracle: 'Flying\nWhen ~ enters, investigate X times, where X is the number of opponents you have.',
		power: '1',
		toughness: '3'
	},
	{
		typeLine: 'Instant',
		oracle:
			"Exile all nontoken creatures you control, then roll a d20.\n1—9 | Return those cards to the battlefield under their owner's control at the beginning of the next end step.\n10—20 | Return those cards to the battlefield under their owner's control, then exile them again. Return those cards to the battlefield under their owner's control at the beginning of the next end step."
	},
	{
		typeLine: 'Creature — Human Wizard',
		oracle:
			"When ~ enters, return target creature an opponent controls to its owner's hand. That creature's owner can't cast spells with the same name as that creature until your next turn.",
		power: '2',
		toughness: '3'
	},
	{
		typeLine: 'Artifact Creature — Construct',
		oracle:
			"Menace\nWhen ~ enters, for each opponent, put up to one target nonland permanent that player controls into its owner's library third from the top.",
		power: '5',
		toughness: '3'
	},
	{
		typeLine: 'Creature — Kor Spirit',
		oracle:
			"When ~ enters, exile up to one target nonland, nontoken permanent you don't control with mana value 4 or less.\nWhen ~ leaves the battlefield, the exiled card's owner creates an X/X blue Illusion creature token, where X is the mana value of the exiled card.",
		power: '2',
		toughness: '2'
	},
	{
		typeLine: 'Creature — Spirit',
		oracle: 'Flying\nWhenever a creature is exiled from the battlefield, put a +1/+1 counter on ~.',
		power: '1',
		toughness: '1'
	},
	{
		typeLine: 'Creature — Rhino Soldier',
		oracle: 'When ~ enters, target opponent skips their next combat phase.',
		power: '1',
		toughness: '4'
	},
	{
		typeLine: 'Legendary Creature — Human Wizard',
		oracle: "Flash\nWhen ~ enters, return target spell or permanent to its owner's hand.",
		power: '2',
		toughness: '2'
	}
];

describe('Precon Bragos Spirit: compiler support & rename invariance', () => {
	it('compiles every sample fully, interpretably, and identically under two invented names', () => {
		for (const [i, s] of SAMPLES.entries()) {
			const build = (name: string) =>
				makeCard({
					name,
					typeLine: s.typeLine,
					oracleText: s.oracle.replace(/~/g, name),
					...(s.power ? { power: s.power, toughness: s.toughness } : {})
				});
			const a = compileCard(build(`Quillmere Sample ${i}`));
			const b = compileCard(build(`Vostrandel Echo ${i}`));
			assert.equal(a.fullySupported, true, `sample ${i} must be fully supported: ${s.oracle}`);
			for (const ab of a.faces[0]!.abilities) {
				if (ab.kind === 'spell' || ab.kind === 'activated' || ab.kind === 'triggered') {
					assert.equal(
						staticallyInterpretable({ steps: ab.effect, targets: ab.targets, modal: ab.modal, unparsed: [] }),
						true,
						`sample ${i} (${ab.kind}) must be statically interpretable`
					);
				}
			}
			assert.deepEqual(
				stripSpans(a.faces[0]!.abilities),
				stripSpans(b.faces[0]!.abilities),
				`sample ${i} must be rename invariant`
			);
		}
	});
});

describe('Precon Bragos Spirit: runtime behaviour', () => {
	it('"Choose a creature type. Draw a card for each permanent you control of that type." on a spell', () => {
		const state = createGame();
		const p1 = state.players[0]!;
		put(state, p1, creature('Hollow Wisp', '1', '1', 'Spirit'), 'battlefield');
		put(state, p1, creature('Murk Wisp', '1', '1', 'Spirit'), 'battlefield');
		put(state, p1, creature('Bramble Elf', '1', '1', 'Elf'), 'battlefield');
		for (let i = 0; i < 5; i++) put(state, p1, creature(`Filler ${i}`, '1', '1', 'Ox'), 'library');
		const hymn = put(
			state,
			p1,
			makeCard({ name: 'Choral Remembrance', typeLine: 'Sorcery', oracleText: SAMPLES[0]!.oracle }),
			'hand'
		);
		addMana(p1);
		cast(state, p1, hymn);
		settle(state);
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt?.choice?.kind, 'chooseMode', 'a human picks the creature type');
		const modes = prompt!.choice!.kind === 'chooseMode' ? prompt!.choice!.modes : [];
		const spiritIdx = modes.indexOf('Spirit');
		assert.ok(spiritIdx >= 0, `Spirit must be offered (got ${modes.join(', ')})`);
		const next = roundTrip(state);
		assert.equal(answer(next, { kind: 'chooseMode', indices: [spiritIdx] }).ok, true);
		settle(next);
		assert.equal(next.players[0]!.hand.length, 2, 'draws one card per Spirit you control');
	});

	it('"one or more other creatures you control leave the battlefield without dying" batches and ignores deaths', () => {
		const state = createGame();
		const p1 = state.players[0]!;
		put(state, p1, makeCard({ name: 'Brackish Sentry', typeLine: 'Creature — Frog Wizard', power: '3', toughness: '3', oracleText: SAMPLES[1]!.oracle }), 'battlefield');
		put(state, p1, creature('Reed Mote', '1', '1'), 'battlefield');
		put(state, p1, creature('Silt Mote', '1', '1'), 'battlefield');
		const doomed = put(state, p1, creature('Ash Mote', '2', '2'), 'battlefield');
		for (let i = 0; i < 5; i++) put(state, p1, creature(`Filler ${i}`, '1', '1', 'Ox'), 'library');
		const tide = put(
			state,
			p1,
			makeCard({ name: 'Undertow Recall', typeLine: 'Sorcery', oracleText: "Return all creatures you control with power 1 or less to their owners' hands." }),
			'hand'
		);
		const ruin = put(state, p1, makeCard({ name: 'Ruinous Hex', typeLine: 'Instant', oracleText: 'Destroy target creature.' }), 'hand');
		addMana(p1);
		cast(state, p1, tide);
		settle(state);
		// two creatures returned to hand + one card drawn (batched: a single trigger)
		assert.equal(p1.hand.filter((c) => /Mote/.test(c.card.name)).length, 2);
		assert.equal(p1.hand.filter((c) => /Filler/.test(c.card.name)).length, 1, 'exactly one draw for the batch');
		cast(state, p1, ruin, [permTarget(doomed)]);
		settle(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === doomed.instanceId), true);
		assert.equal(p1.hand.filter((c) => /Filler/.test(c.card.name)).length, 1, 'dying does not trigger');
	});

	it('"Whenever a creature is exiled from the battlefield" puts a counter on the source', () => {
		const state = createGame();
		const [p1, p2] = state.players as [PlayerGameState, PlayerGameState];
		const shepherd = put(state, p1, makeCard({ name: 'Gloam Shepherd', typeLine: 'Creature — Spirit', power: '1', toughness: '1', oracleText: SAMPLES[7]!.oracle.replace(/~/g, 'Gloam Shepherd') }), 'battlefield');
		const victim = put(state, p2, creature('Rival Brute', '3', '3', 'Ogre'), 'battlefield');
		const banish = put(state, p1, makeCard({ name: 'Banishing Gleam', typeLine: 'Instant', oracleText: 'Exile target creature.' }), 'hand');
		addMana(p1);
		cast(state, p1, banish, [permTarget(victim)]);
		settle(state);
		assert.equal(shepherd.counters['+1/+1'], 1);
	});

	it('"investigate X times, where X is the number of opponents you have" scales with opponents', () => {
		const state = createGame(3);
		const p1 = state.players[0]!;
		const name = 'Spectral Auditor';
		const auditor = put(
			state,
			p1,
			makeCard({ name, manaCost: '{1}', typeLine: 'Creature — Spirit', power: '1', toughness: '3', oracleText: SAMPLES[2]!.oracle.replace(/~/g, name) }),
			'hand'
		);
		addMana(p1);
		cast(state, p1, auditor);
		settle(state);
		assert.equal(p1.battlefield.filter((c) => c.isToken && /Clue/.test(c.card.name)).length, 2);
	});

	it('"target opponent skips their next combat phase" skips exactly one combat phase on their turn', () => {
		const state = createGame();
		const [p1, p2] = state.players as [PlayerGameState, PlayerGameState];
		const decree = put(
			state,
			p1,
			makeCard({ name: 'Tollbooth Decree', typeLine: 'Sorcery', oracleText: 'Target opponent skips their next combat phase.' }),
			'hand'
		);
		addMana(p1);
		cast(state, p1, decree, [playerTarget(p2)]);
		settle(state);
		assert.equal(state.players[1]!.skipNextCombatPhases, 1);
		const s2 = roundTrip(state);
		s2.activePlayerIndex = 1;
		s2.priorityPlayerIndex = 1;
		s2.phase = 'main1';
		advancePhaseOrStep(s2);
		assert.equal(s2.phase, 'main2', 'combat phase skipped (CR 500.11)');
		assert.equal(s2.players[1]!.skipNextCombatPhases, undefined);
		s2.phase = 'main1';
		advancePhaseOrStep(s2);
		assert.equal(s2.phase, 'begin_combat', 'only the next combat phase is skipped');
	});

	it('"can\'t cast spells with the same name as that creature until your next turn" locks the bounced name', () => {
		const state = createGame();
		const [p1, p2] = state.players as [PlayerGameState, PlayerGameState];
		const victim = put(state, p2, creature('Glade Stalker', '3', '3', 'Cat'), 'battlefield');
		const name = 'Mirrorpane Warden';
		const warden = put(
			state,
			p1,
			makeCard({ name, typeLine: 'Creature — Human Wizard', power: '2', toughness: '3', oracleText: SAMPLES[4]!.oracle.replace(/~/g, name) }),
			'hand'
		);
		addMana(p1);
		cast(state, p1, warden);
		settle(state);
		assert.equal(p2.hand.some((c) => c.instanceId === victim.instanceId), true, 'bounced to its owner\'s hand');
		assert.equal(p2.castNameLocks?.[0]?.name, 'Glade Stalker');

		const s2 = roundTrip(state);
		s2.activePlayerIndex = 1;
		s2.priorityPlayerIndex = 1;
		s2.passedPriorityPlayerIds = [];
		addMana(s2.players[1]!);
		const blocked = applyGameAction(s2, s2.players[1]!.playerId, { type: 'cast_spell', instanceId: victim.instanceId });
		assert.equal(blocked.ok, false);
		assert.match(blocked.error ?? '', /Illegal Cast/);
		expireP13UntilNextTurnEffects(s2, s2.players[0]!.playerId);
		assert.equal(s2.players[1]!.castNameLocks, undefined, 'expires when the caster\'s next turn begins');
		const allowed = applyGameAction(s2, s2.players[1]!.playerId, { type: 'cast_spell', instanceId: victim.instanceId });
		assert.equal(allowed.ok, true, allowed.error ?? '');
	});

	it('"return target spell or permanent to its owner\'s hand" can pick a spell on the stack or a permanent', () => {
		const state = createGame();
		const [p1, p2] = state.players as [PlayerGameState, PlayerGameState];
		const name = 'Vellum Shaper';
		const shaperCard = makeCard({
			name,
			manaCost: '{1}',
			typeLine: 'Legendary Creature — Human Wizard',
			power: '2',
			toughness: '2',
			oracleText: SAMPLES[9]!.oracle.replace(/~/g, name)
		});
		const shaper = put(state, p1, shaperCard, 'hand');
		const opposing = put(state, p2, creature('Distant Ogre', '3', '3', 'Ogre'), 'battlefield');
		const draw = put(state, p1, makeCard({ name: 'Idle Musing', typeLine: 'Sorcery', oracleText: 'Draw a card.' }), 'hand');
		addMana(p1);
		cast(state, p1, draw);
		// p1 keeps priority (CR 117.3c) and responds with the flash creature.
		state.priorityPlayerIndex = 0;
		cast(state, p1, shaper);
		settle(state);
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt?.purpose, 'trigger_targets');
		const candidates = prompt!.choice!.kind === 'chooseObjects' ? prompt!.choice!.candidates : [];
		const spellItem = state.stack.find((s) => s.kind === 'spell' && s.card.name === 'Idle Musing');
		assert.ok(spellItem, 'the sorcery is still on the stack');
		assert.ok(candidates.includes(spellItem!.id), 'the spell is a legal target');
		assert.ok(candidates.includes(opposing.instanceId), 'a permanent is a legal target');
		assert.equal(answer(state, { kind: 'chooseObjects', objectIds: [spellItem!.id] }).ok, true);
		settle(state);
		assert.equal(p1.hand.some((c) => c.card.name === 'Idle Musing'), true, 'spell returned to its owner\'s hand');
		assert.equal(state.stack.length, 0);
	});

	it('"for each opponent, up to one target nonland permanent that player controls" allows one target per opponent', () => {
		const state = createGame(3);
		const [p1, p2, p3] = state.players as [PlayerGameState, PlayerGameState, PlayerGameState];
		const a1 = put(state, p2, creature('Opal Hound', '2', '2', 'Dog'), 'battlefield');
		const a2 = put(state, p2, creature('Onyx Hound', '2', '2', 'Dog'), 'battlefield');
		const b1 = put(state, p3, creature('Jade Hound', '2', '2', 'Dog'), 'battlefield');
		for (const pl of [p2, p3]) for (let i = 0; i < 4; i++) put(state, pl, creature(`Lib ${pl.username} ${i}`, '1', '1', 'Ox'), 'library');
		const name = 'Tidewright Colossus';
		const colossus = put(
			state,
			p1,
			makeCard({ name, manaCost: '{1}', typeLine: 'Artifact Creature — Construct', power: '5', toughness: '3', oracleText: SAMPLES[5]!.oracle.replace(/~/g, name) }),
			'hand'
		);
		addMana(p1);
		cast(state, p1, colossus);
		settle(state);
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt?.purpose, 'trigger_targets');
		assert.equal(prompt!.choice!.kind === 'chooseObjects' ? prompt!.choice!.max : -1, 2, 'one slot per opponent');
		const badRes = answer(roundTrip(state), { kind: 'chooseObjects', objectIds: [a1.instanceId, a2.instanceId] });
		assert.equal(badRes.ok, false, 'two targets controlled by the same opponent are illegal');
		assert.equal(answer(state, { kind: 'chooseObjects', objectIds: [a1.instanceId, b1.instanceId] }).ok, true);
		settle(state);
		assert.equal(p2.library[2]?.instanceId, a1.instanceId, 'third from the top of its owner\'s library');
		assert.equal(p3.library[2]?.instanceId, b1.instanceId, 'third from the top of its owner\'s library');
		assert.equal(p2.battlefield.some((c) => c.instanceId === a2.instanceId), true);
	});

	it('"the exiled card\'s owner creates an X/X ... where X is the mana value of the exiled card"', () => {
		const state = createGame();
		const [p1, p2] = state.players as [PlayerGameState, PlayerGameState];
		const relic = put(state, p2, makeCard({ name: 'Gilded Idol', manaCost: '{3}', cmc: 3, typeLine: 'Artifact' }), 'battlefield');
		const name = 'Vaultborn Apparition';
		const app = put(
			state,
			p1,
			makeCard({ name, manaCost: '{1}', typeLine: 'Creature — Kor Spirit', power: '2', toughness: '2', oracleText: SAMPLES[6]!.oracle.replace(/~/g, name) }),
			'hand'
		);
		const ruin = put(state, p1, makeCard({ name: 'Ruinous Hex', typeLine: 'Instant', oracleText: 'Destroy target creature.' }), 'hand');
		addMana(p1);
		cast(state, p1, app);
		settle(state);
		if (state.pendingPrompts[0]?.purpose === 'trigger_targets') {
			assert.equal(answer(state, { kind: 'chooseObjects', objectIds: [relic.instanceId] }).ok, true);
			settle(state);
		}
		assert.equal(p2.exile.some((c) => c.instanceId === relic.instanceId), true, 'exiled by the ETB');
		const appInst = p1.battlefield.find((c) => c.card.name === name)!;
		cast(state, p1, ruin, [permTarget(appInst)]);
		settle(state);
		const token = p2.battlefield.find((c) => c.isToken && /Illusion/.test(c.card.name));
		assert.ok(token, "the exiled card's owner gets the Illusion");
		assert.equal(token!.card.power, '3');
		assert.equal(token!.card.toughness, '3');
		assert.equal(p1.battlefield.some((c) => c.isToken), false);
	});

	it('die-roll rows return "those cards" exiled before the roll (now, re-exiled, and at the next end step)', () => {
		const name = 'Tumbling Gambit';
		const gambitCard = makeCard({ name, typeLine: 'Instant', oracleText: SAMPLES[3]!.oracle });
		const etbCard = creature('Bellwether Kite', '1', '1', 'Bird', 'When Bellwether Kite enters, you gain 1 life.');

		const setup = (): { state: GameState; p1: PlayerGameState } => {
			const state = createGame();
			const p1 = state.players[0]!;
			addMana(p1);
			cast(state, p1, put(state, p1, etbCard, 'hand'));
			settle(state);
			assert.equal(p1.battlefield.some((c) => c.card.name === 'Bellwether Kite'), true);
			put(state, p1, gambitCard, 'hand');
			return { state, p1 };
		};
		/** Finds an RNG seed whose first d20 roll lands in [min, max]. */
		const seedFor = (min: number, max: number): number => {
			for (let seed = 1; seed < 10_000; seed++) {
				const roll = 1 + Math.floor(nextRandom({ rngState: seed }) * 20);
				if (roll >= min && roll <= max) return seed;
			}
			throw new Error('no seed');
		};

		for (const [min, max] of [
			[1, 9],
			[10, 20]
		] as const) {
			const { state, p1 } = setup();
			state.rngState = seedFor(min, max);
			const lifeBefore = p1.life;
			cast(state, p1, p1.hand.find((c) => c.card.name === name)!);
			settle(state);
			const roll = state.log?.map((l) => l.text).find((t) => /rolled a d20/.test(t)) ?? '';
			const n = Number(roll.match(/: (\d+)/)?.[1] ?? NaN);
			assert.ok(n >= min && n <= max, `rolled in [${min}, ${max}] (log: ${roll})`);
			assert.equal(p1.exile.some((c) => c.card.name === 'Bellwether Kite'), true, 'in exile after resolution');
			assert.equal(p1.life, lifeBefore + (min === 10 ? 1 : 0), 'the 10—20 row returns it once (ETB) before re-exiling');
			assert.equal(state.delayedTriggers?.length, 1, 'a delayed return is scheduled');

			const s2 = roundTrip(state);
			for (let i = 0; i < 40 && s2.phase !== 'end_step'; i++) {
				if (s2.pendingPrompts.length > 0) break;
				const prio = s2.players[s2.priorityPlayerIndex]!;
				assert.equal(applyGameAction(s2, prio.playerId, { type: 'pass_priority' }).ok, true);
			}
			assert.equal(s2.phase, 'end_step');
			settle(s2);
			const q1 = s2.players[0]!;
			assert.equal(q1.battlefield.some((c) => c.card.name === 'Bellwether Kite'), true, 'returned at the next end step');
			assert.equal(q1.life, lifeBefore + (min === 10 ? 2 : 1));
		}
	});
});
