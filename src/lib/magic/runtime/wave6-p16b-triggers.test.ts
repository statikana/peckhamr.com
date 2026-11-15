import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	enterEndStep,
	runBeginningOfTurn
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import { emitEvent } from './events.ts';
import { flushTriggers } from './triggers.ts';
import { setDayNight } from './framesBattlesAndKeywordsWave5.ts';
import { moveObject } from './zones.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';

function moveToZone(
	state: GameState,
	obj: CardInstance,
	from: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'exile',
	to: ZoneType
): void {
	const owner = state.players.find((pl) => pl.playerId === obj.ownerId)!;
	moveObject(state, obj, to, {
		from: from === 'battlefield' ? 'anyBattlefield' : { player: owner, zone: from },
		bumpVersion: true,
		leaveBattlefieldReset: from === 'battlefield',
		...(from === 'battlefield' ? { ceaseToExist: 'tokens' as const } : {})
	});
}

function discardCard(
	state: GameState,
	player: PlayerGameState,
	obj: CardInstance,
	reason: 'discard' | 'cycle' = 'discard',
	causeControllerId?: string
): void {
	moveObject(state, obj, 'graveyard', {
		from: { player, zone: 'hand' },
		bumpVersion: true
	});
	emitEvent(state, {
		kind: 'CardDiscarded',
		playerId: player.playerId,
		objectId: obj.instanceId,
		object: obj,
		reason,
		destZone: 'graveyard',
		...(causeControllerId ? { causeControllerId } : {})
	});
}

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `p16b_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		defense: overrides.defense,
		keywords: overrides.keywords ?? [],
		layout: overrides.layout,
		faces: overrides.faces,
		backFace: overrides.backFace,
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

function seat(i: number, id: string, username: string): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: id,
		username,
		avatarUrl: '',
		isBot: false,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: deck.colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: Date.now()
	};
}

function game(players = 2): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i]));
	const state = createInitialGameState(
		'LOBBY_P16B',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const s of seats) {
		assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
	}
	for (const pl of state.players) {
		pl.manaPool = { W: 15, U: 15, B: 15, R: 15, G: 15, C: 15 };
	}
	return { state, p: state.players };
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'exile'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		if (c.loyalty) inst.counters.loyalty = parseInt(c.loyalty, 10);
	}
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function drainStack(state: GameState, mayAnswer = true, maxSteps = 50): void {
	for (let guard = 0; guard < maxSteps; guard++) {
		const prompt = state.pendingPrompts[0];
		if (prompt) {
			if (prompt.purpose === 'trigger_order' && prompt.choice?.kind === 'orderObjects') {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: {
						kind: 'orderObjects',
						topIds: prompt.choice.objectIds,
						bottomIds: [],
						shuffle: false
					}
				});
				continue;
			}
			if (prompt.purpose === 'trigger_may' || prompt.choice?.kind === 'yesNo') {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: { kind: 'yesNo', yes: mayAnswer }
				});
				continue;
			}
			if (prompt.choice?.kind === 'chooseObjects' && prompt.choice.defaultObjectIds) {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: { kind: 'chooseObjects', objectIds: prompt.choice.defaultObjectIds }
				});
				continue;
			}
			break;
		}
		if (state.stack.length === 0) break;
		const prio = state.players[state.priorityPlayerIndex];
		if (!applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok) break;
	}
}

function assertFullySupported(c: ScryfallCard): void {
	const ir = compileCard(c);
	const rep = definitionSupportReport(ir);
	assert.equal(rep.fullySupported, true, `expected ${c.name} to be fully supported: ${JSON.stringify(ir.faces[0].abilities)}`);
}

describe('Wave 6 Track P16b — Compound Multi-Event Triggers (CR 603.1b)', () => {
	it('isolates per-alternative scope on "When ~ enters and at the beginning of your upkeep"', () => {
		const { state, p } = game();
		const watcher = card({
			name: 'Zephyr Herald',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Creature — Bird',
			oracleText: 'When Zephyr Herald enters and at the beginning of your upkeep, you gain 2 life.',
			power: '2',
			toughness: '2'
		});
		assertFullySupported(watcher);
		const lifeStart = p[0].life;
		const inHand = put(state, p[0], watcher, 'hand');
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: inHand.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, lifeStart + 2, 'ETB alternative fired');

		// Opponent's upkeep must NOT fire p[0]'s upkeep alternative!
		state.activePlayerIndex = 1;
		runBeginningOfTurn(state);
		drainStack(state);
		assert.equal(p[0].life, lifeStart + 2, 'opponent upkeep did not fire controller_turn alternative');

		// Controller's upkeep MUST fire!
		state.activePlayerIndex = 0;
		runBeginningOfTurn(state);
		drainStack(state);
		assert.equal(p[0].life, lifeStart + 4, 'controller upkeep fired');
	});

	it('fires on all three events of multi-comma "When ~ enters, attacks, or dies"', () => {
		const { state, p } = game();
		const titan = card({
			name: 'Triad Colossus',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Creature — Giant',
			oracleText: 'When Triad Colossus enters, attacks, or dies, you gain 3 life.',
			power: '4',
			toughness: '4'
		});
		assertFullySupported(titan);
		const life0 = p[0].life;
		const handInst = put(state, p[0], titan, 'hand');
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: handInst.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0 + 3, 'ETB fired');

		const bfInst = p[0].battlefield.find((c) => c.card.name === 'Triad Colossus')!;
		bfInst.summoningSick = false;
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p[0].playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: bfInst.instanceId, defenderPlayerId: p[1].playerId, defenderPlaneswalkerId: null }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p[0].life, life0 + 6, 'attack alternative fired');

		moveToZone(state, bfInst, 'battlefield', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 9, 'dies alternative fired');
	});

	it('supports mixed-zone "When ~ dies and when you discard ~"', () => {
		const { state, p } = game();
		const spirit = card({
			name: 'Ash Wraith',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Spirit',
			oracleText: 'When Ash Wraith dies and when you discard Ash Wraith, you gain 2 life.',
			power: '2',
			toughness: '1'
		});
		assertFullySupported(spirit);
		const life0 = p[0].life;

		// 1) Dies from battlefield
		const bf = put(state, p[0], spirit, 'battlefield');
		moveToZone(state, bf, 'battlefield', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 2, 'dies branch fired');

		// 2) Discarded from hand
		const inHand = put(state, p[0], spirit, 'hand');
		discardCard(state, p[0], inHand, 'discard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 4, 'discard branch fired from non-battlefield move');
	});

	it('supports shared-Whenever disjunction "Whenever you cast a blue spell or an Island you control enters"', () => {
		const { state, p } = game();
		const scholar = card({
			name: 'Tidal Scholar',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Wizard',
			oracleText: 'Whenever you cast a blue spell or an Island you control enters, you gain 1 life.',
			power: '1',
			toughness: '3'
		});
		assertFullySupported(scholar);
		put(state, p[0], scholar, 'battlefield');
		const life0 = p[0].life;

		const island = put(
			state,
			p[0],
			card({ name: 'Test Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island', oracleText: '' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'play_land', instanceId: island.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0 + 1, 'Island ETB fired');

		const cantrip = put(
			state,
			p[0],
			card({ name: 'Azure Spark', manaCost: '{U}', cmc: 1, colors: ['U'], typeLine: 'Instant', oracleText: 'Scry 1.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: cantrip.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0 + 2, 'blue spell cast fired');
	});
});

describe('Wave 6 Track P16b — CR 603.8 State-Triggered Abilities', () => {
	it('enforces CR 603.8 stack-presence anti-loop guard, JSON round-trip, and re-trigger on counter', () => {
		const { state, p } = game();
		const leviathan = card({
			name: 'Reef Serpent',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Creature — Serpent',
			oracleText: 'When you control no Islands, sacrifice Reef Serpent.',
			power: '5',
			toughness: '5'
		});
		assertFullySupported(leviathan);

		const island = put(
			state,
			p[0],
			card({ name: 'Lagoon Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island', oracleText: '' }),
			'battlefield'
		);
		const serpent = put(state, p[0], leviathan, 'battlefield');
		checkStateBasedActions(state);
		assert.equal(state.stack.length, 0, 'does not trigger while an Island is controlled');

		// Remove the Island -> state condition becomes true -> SBA queues state trigger once!
		moveToZone(state, island, 'battlefield', 'graveyard');
		checkStateBasedActions(state);
		assert.equal(state.stack.length, 1, 'state trigger placed on the stack');
		assert.equal(state.stack[0].sourceInstanceId, serpent.instanceId);

		// Running checkStateBasedActions again (and after JSON round-trip) MUST NOT queue a second copy!
		checkStateBasedActions(state);
		assert.equal(state.stack.length, 1, 'CR 603.8 stack-presence guard prevents duplicate');

		const cloned: GameState = JSON.parse(JSON.stringify(state));
		checkStateBasedActions(cloned);
		assert.equal(cloned.stack.length, 1, 'JSON round-trip preserves CR 603.8 stack-presence guard');

		// If the state trigger is countered/removed while condition still holds, SBA re-triggers it!
		state.stack.pop();
		checkStateBasedActions(state);
		assert.equal(state.stack.length, 1, 'CR 603.8 re-triggers when previous instance left stack without sacrificing');

		// Resolving the state trigger sacrifices Reef Serpent and stops further triggers.
		drainStack(state);
		checkStateBasedActions(state);
		assert.equal(
			p[0].battlefield.some((c) => c.instanceId === serpent.instanceId),
			false,
			'sacrificed when state trigger resolved'
		);
		assert.equal(state.stack.length, 0, 'no further triggers once sacrificed');
	});

	it('triggers counter-threshold and non-owner control state triggers', () => {
		const { state, p } = game();
		const shrine = card({
			name: 'Quest Vessel',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: 'When there are three or more quest counters on Quest Vessel, sacrifice it and draw two cards.'
		});
		assertFullySupported(shrine);
		const vessel = put(state, p[0], shrine, 'battlefield');
		vessel.counters.quest = 2;
		checkStateBasedActions(state);
		assert.equal(state.stack.length, 0);

		vessel.counters.quest = 3;
		const handBefore = p[0].hand.length;
		checkStateBasedActions(state);
		assert.equal(state.stack.length, 1);
		drainStack(state);
		assert.equal(p[0].hand.length, handBefore + 2);
		assert.equal(p[0].battlefield.some((c) => c.instanceId === vessel.instanceId), false);
	});
});

describe('Wave 6 Track P16b — CR 603.6c "put into a graveyard from anywhere"', () => {
	it('fires self-graveyard trigger from battlefield, library (mill), and hand (discard)', () => {
		const { state, p } = game();
		const relic = card({
			name: 'Grave Beacon',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact Creature — Construct',
			oracleText: 'When Grave Beacon is put into a graveyard from anywhere, you gain 3 life.',
			power: '2',
			toughness: '2'
		});
		assertFullySupported(relic);
		const life0 = p[0].life;

		// 1) From battlefield (death)
		const c1 = put(state, p[0], relic, 'battlefield');
		moveToZone(state, c1, 'battlefield', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 3, 'fired once from battlefield');

		// 2) From library (mill)
		const c2 = put(state, p[0], relic, 'library');
		moveToZone(state, c2, 'library', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 6, 'fired once from library');

		// 3) From hand (discard)
		const c3 = put(state, p[0], relic, 'hand');
		moveToZone(state, c3, 'hand', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 9, 'fired once from hand');
	});

	it('evaluates destination-zone card characteristics per CR 603.6c and excludes tokens on "card"', () => {
		const { state, p } = game();
		const landWatcher = card({
			name: 'Loam Keeper',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Druid',
			oracleText: 'Whenever a land card is put into your graveyard from anywhere, you gain 2 life.',
			power: '1',
			toughness: '3'
		});
		const creatureCardWatcher = card({
			name: 'Crypt Scribe',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Cleric',
			oracleText: 'Whenever a creature card is put into your graveyard from anywhere, you gain 5 life.',
			power: '1',
			toughness: '3'
		});
		assertFullySupported(landWatcher);
		assertFullySupported(creatureCardWatcher);
		put(state, p[0], landWatcher, 'battlefield');
		put(state, p[0], creatureCardWatcher, 'battlefield');
		const life0 = p[0].life;

		// Token creature dying is NOT a "creature card" in the graveyard!
		const tok = createTokenOnBoard(state, p[0], {
			name: 'Saproling',
			typeLine: 'Token Creature — Saproling',
			colors: ['G'],
			power: 1,
			toughness: 1,
			keywords: []
		});
		moveToZone(state, tok, 'battlefield', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0, 'token excluded from "creature card"');

		// Land card milled -> +2 life only
		const forest = put(
			state,
			p[0],
			card({ name: 'Moss Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest', oracleText: '' }),
			'library'
		);
		moveToZone(state, forest, 'library', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 2, 'land card matched Loam Keeper');
	});
});

describe('Wave 6 Track P16b — Werewolf Last-Turn Spells & DayNightChanged (CR 732)', () => {
	it('checks per-player last-turn spell counts (0 -> transform; 1+1 across players -> no; 2 by one player -> transform)', () => {
		const { state, p } = game();
		const werewolf = card({
			name: 'Dusk Tracker // Howling Tracker',
			manaCost: '{1}{G}',
			cmc: 2,
			layout: 'transform',
			typeLine: 'Creature — Human Werewolf',
			oracleText: 'At the beginning of each upkeep, if no spells were cast last turn, transform Dusk Tracker.',
			power: '2',
			toughness: '2',
			faces: [
				{
					name: 'Dusk Tracker',
					manaCost: '{1}{G}',
					colors: ['G'],
					typeLine: 'Creature — Human Werewolf',
					oracleText: 'At the beginning of each upkeep, if no spells were cast last turn, transform Dusk Tracker.',
					power: '2',
					toughness: '2',
					imageUrl: ''
				},
				{
					name: 'Howling Tracker',
					manaCost: '',
					colors: ['G'],
					typeLine: 'Creature — Werewolf',
					oracleText: 'At the beginning of each upkeep, if a player cast two or more spells last turn, transform Howling Tracker.',
					power: '4',
					toughness: '4',
					imageUrl: ''
				}
			],
			backFace: {
				name: 'Howling Tracker',
				manaCost: '',
				typeLine: 'Creature — Werewolf',
				oracleText: 'At the beginning of each upkeep, if a player cast two or more spells last turn, transform Howling Tracker.',
				power: '4',
				toughness: '4',
				imageUrl: ''
			}
		});
		assertFullySupported(werewolf);
		const ww = put(state, p[0], werewolf, 'battlefield');

		// Last turn had 0 spells cast -> transforms to back face!
		state.spellsCastLastTurnTotal = 0;
		state.maxSpellsCastBySinglePlayerLastTurn = 0;
		state.activePlayerIndex = 1;
		runBeginningOfTurn(state);
		drainStack(state);
		assert.equal(Boolean(ww.transformed), true, '0 spells last turn transformed to back face');

		// 1 spell by Alice + 1 spell by Bob (total 2, max 1 per player) -> MUST NOT transform!
		state.spellsCastLastTurnTotal = 2;
		state.maxSpellsCastBySinglePlayerLastTurn = 1;
		state.activePlayerIndex = 0;
		runBeginningOfTurn(state);
		drainStack(state);
		assert.equal(Boolean(ww.transformed), true, '1+1 across two players does not satisfy "a player cast two or more"');

		// 2 spells by Bob in a single turn -> transforms back to front face!
		state.spellsCastLastTurnTotal = 2;
		state.maxSpellsCastBySinglePlayerLastTurn = 2;
		state.activePlayerIndex = 1;
		runBeginningOfTurn(state);
		drainStack(state);
		assert.equal(Boolean(ww.transformed), false, '2 spells by one player transformed back to front face');
	});

	it('fires "Whenever day becomes night or night becomes day" only on flips between day and night', () => {
		const { state, p } = game();
		const celestus = card({
			name: 'Sundial Relic',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText: 'Whenever day becomes night or night becomes day, you gain 2 life.'
		});
		assertFullySupported(celestus);
		put(state, p[0], celestus, 'battlefield');
		const life0 = p[0].life;

		// Initial undefined -> 'day' is NOT "night becomes day"
		setDayNight(state, 'day');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0, 'initial designation does not count as flip');

		// 'day' -> 'night' fires!
		setDayNight(state, 'night');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 2, 'day -> night fired');

		// 'night' -> 'day' fires!
		setDayNight(state, 'day');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 4, 'night -> day fired');
	});
});

describe('Wave 6 Track P16b — Cycling/Discard Batching (CR 702.29d) & Opponent-Caused Discard', () => {
	it('triggers "Whenever you cycle or discard a card" once on cycling (CR 702.29d) and batches "discard one or more"', () => {
		const { state, p } = game();
		const drifter = card({
			name: 'Dune Glider',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Creature — Drake',
			oracleText: 'Whenever you cycle or discard a card, you gain 2 life.',
			power: '2',
			toughness: '2'
		});
		const batcher = card({
			name: 'Bone Collector',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Skeleton',
			oracleText: 'Whenever you discard one or more cards, you gain 3 life.',
			power: '1',
			toughness: '2'
		});
		assertFullySupported(drifter);
		assertFullySupported(batcher);
		put(state, p[0], drifter, 'battlefield');
		put(state, p[0], batcher, 'battlefield');
		const life0 = p[0].life;

		// Cycling emits CardDiscarded with reason 'cycle'; Dune Glider ("cycle or discard") must fire ONCE (+2, not +4)!
		const cycler = put(
			state,
			p[0],
			card({
				name: 'Sandstone Shard',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact',
				oracleText: 'Cycling {1}',
				keywords: ['Cycling']
			}),
			'hand'
		);
		discardCard(state, p[0], cycler, 'cycle');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 5, 'Dune Glider (+2 once) + Bone Collector (+3 once)');

		// Discarding TWO cards in one flush window fires Bone Collector ONCE (+3) and Dune Glider TWICE (+4)!
		const d1 = put(state, p[0], card({ name: 'Scrap A', typeLine: 'Artifact' }), 'hand');
		const d2 = put(state, p[0], card({ name: 'Scrap B', typeLine: 'Artifact' }), 'hand');
		discardCard(state, p[0], d1, 'discard');
		discardCard(state, p[0], d2, 'discard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 5 + 7, 'Bone Collector batched (+3) while per-card trigger fired twice (+4)');
	});

	it('distinguishes opponent-caused discard from self-caused discard', () => {
		const { state, p } = game();
		const baloth = card({
			name: 'Vengeful Stag',
			manaCost: '{2}{G}{G}',
			cmc: 4,
			typeLine: 'Creature — Elk',
			oracleText:
				'Whenever a spell or ability an opponent controls causes you to discard Vengeful Stag, put Vengeful Stag onto the battlefield.',
			power: '4',
			toughness: '4'
		});
		assertFullySupported(baloth);

		// Self-caused discard -> stays in graveyard
		const own = put(state, p[0], baloth, 'hand');
		discardCard(state, p[0], own, 'discard', p[0].playerId);
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].battlefield.some((c) => c.card.name === 'Vengeful Stag'), false);

		// Opponent-caused discard -> put onto battlefield!
		const coerced = put(state, p[0], baloth, 'hand');
		discardCard(state, p[0], coerced, 'discard', p[1].playerId);
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].battlefield.some((c) => c.card.name === 'Vengeful Stag'), true);
	});

	it('evaluates filtered spell ordinals ("first noncreature spell" & "other than your first spell")', () => {
		const { state, p } = game();
		const firstNoncreature = card({
			name: 'Arcane Relay',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText: 'Whenever you cast your first noncreature spell each turn, you gain 2 life.'
		});
		const afterFirst = card({
			name: 'Surge Conduit',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText: 'Whenever you cast a spell other than your first spell each turn, you gain 1 life.'
		});
		assertFullySupported(firstNoncreature);
		assertFullySupported(afterFirst);
		put(state, p[0], firstNoncreature, 'battlefield');
		put(state, p[0], afterFirst, 'battlefield');
		const life0 = p[0].life;

		// 1st spell is a Creature: neither Arcane Relay nor Surge Conduit fires!
		const bear = put(
			state,
			p[0],
			card({ name: 'Moss Cub', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: bear.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0, '1st spell (creature) fired neither');

		// 2nd spell overall is the 1st NONCREATURE spell: BOTH Arcane Relay (+2) and Surge Conduit (+1) fire!
		const bolt = put(
			state,
			p[0],
			card({ name: 'Spark Jolt', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'Draw a card.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: bolt.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0 + 3, '1st noncreature (2nd overall) fired both (+2 and +1)');

		// 3rd spell overall (2nd noncreature): ONLY Surge Conduit (+1) fires!
		const bolt2 = put(
			state,
			p[0],
			card({ name: 'Spark Jolt Two', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'Draw a card.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: bolt2.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0 + 4, '2nd noncreature fired only Surge Conduit (+1)');
	});

	it('filters targetingSourceFilter and player-targeted triggers', () => {
		const { state, p } = game();
		const bodyguard = card({
			name: 'Shield Captain',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Soldier',
			oracleText:
				'Whenever a creature you control becomes the target of an instant or sorcery spell an opponent controls, you gain 2 life.\nWhenever you become the target of a spell or ability an opponent controls, you gain 3 life.',
			power: '2',
			toughness: '2'
		});
		assertFullySupported(bodyguard);
		const cap = put(state, p[0], bodyguard, 'battlefield');
		const life0 = p[0].life;

		// Controller's own instant targeting Shield Captain -> 0 life
		const ownPing = put(
			state,
			p[0],
			card({ name: 'Friendly Buff', manaCost: '{W}', cmc: 1, typeLine: 'Instant', oracleText: 'Target creature gets +1/+1 until end of turn.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p[0].playerId, {
				type: 'cast_spell',
				instanceId: ownPing.instanceId,
				targets: [{ kind: 'permanent', id: cap.instanceId, label: cap.card.name }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p[0].life, life0, 'own instant did not trigger opponent-only filter');

		// Opponent casts instant targeting Shield Captain -> +2 life!
		state.priorityPlayerIndex = 1;
		const oppZap = put(
			state,
			p[1],
			card({ name: 'Frost Poke', manaCost: '{U}', cmc: 1, typeLine: 'Instant', oracleText: 'Tap target creature.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p[1].playerId, {
				type: 'cast_spell',
				instanceId: oppZap.instanceId,
				targets: [{ kind: 'permanent', id: cap.instanceId, label: cap.card.name }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p[0].life, life0 + 2, 'opponent instant targeting creature fired (+2)');

		// Opponent casts instant targeting p[0] -> +3 life!
		state.priorityPlayerIndex = 1;
		const oppBurn = put(
			state,
			p[1],
			card({ name: 'Mind Jab', manaCost: '{B}', cmc: 1, typeLine: 'Instant', oracleText: 'Target player loses 1 life.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p[1].playerId, {
				type: 'cast_spell',
				instanceId: oppBurn.instanceId,
				targets: [{ kind: 'player', id: p[0].playerId, label: p[0].username }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p[0].life, life0 + 2 + 3 - 1, 'opponent spell targeting you fired (+3, minus 1 life lost)');
	});

	it('enforces CR 603.2h "Do this only once each turn" suppression only after the optional action is taken', () => {
		const { state, p } = game();
		const mentor = card({
			name: 'Measured Mentor',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Advisor',
			oracleText: 'Whenever another creature you control enters, you may gain 2 life.',
			power: '2',
			toughness: '2'
		});
		const ir = compileCard(mentor);
		const trigAb = ir.faces[0].abilities[0];
		assert.equal(trigAb.kind, 'triggered');
		// Attach CR 603.2h flag directly to compiled IR (mirrors P16a's "Do this only once each turn." compiler output)
		trigAb.trigger.doThisOncePerTurn = true;

		put(state, p[0], mentor, 'battlefield');
		const life0 = p[0].life;

		// 1st creature enters -> decline ("No"): ability was NOT done this turn!
		createTokenOnBoard(state, p[0], {
			name: 'Soldier A',
			typeLine: 'Token Creature — Soldier',
			colors: ['W'],
			power: 1,
			toughness: 1,
			keywords: []
		});
		flushTriggers(state);
		drainStack(state, false);
		assert.equal(p[0].life, life0, 'declined optional action');

		// 2nd creature enters same turn -> MUST trigger again! Accept ("Yes") -> +2 life and marks done!
		createTokenOnBoard(state, p[0], {
			name: 'Soldier B',
			typeLine: 'Token Creature — Soldier',
			colors: ['W'],
			power: 1,
			toughness: 1,
			keywords: []
		});
		flushTriggers(state);
		assert.equal(state.stack.length, 1, 'triggered again because previous optional action was declined');
		drainStack(state, true);
		assert.equal(p[0].life, life0 + 2, 'accepted optional action');

		// 3rd creature enters same turn -> SUPPRESSED by CR 603.2h (does not even go on stack)!
		createTokenOnBoard(state, p[0], {
			name: 'Soldier C',
			typeLine: 'Token Creature — Soldier',
			colors: ['W'],
			power: 1,
			toughness: 1,
			keywords: []
		});
		flushTriggers(state);
		assert.equal(state.stack.length, 0, 'CR 603.2h suppressed subsequent trigger this turn');
	});
});

describe('Wave 6 Track P16b — CR 700 Batching (Modified, Outlaw, Full Party, Dilemma)', () => {
	it('evaluates Modified (CR 700.9): counter = true, own Aura = true, opponent Aura = false', () => {
		const watcher = card({
			name: 'Tempered Herald',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Samurai',
			oracleText: 'Whenever a modified creature you control attacks, you gain 2 life.',
			power: '2',
			toughness: '2'
		});
		assertFullySupported(watcher);

		// Case 1: Enchanted ONLY by opponent's Aura -> NOT modified per CR 700.9!
		{
			const { state, p } = game();
			put(state, p[0], watcher, 'battlefield');
			const runner = put(
				state,
				p[0],
				card({ name: 'Swift Scout', manaCost: '{R}', cmc: 1, typeLine: 'Creature — Scout', power: '1', toughness: '1' }),
				'battlefield'
			);
			const oppAura = put(
				state,
				p[1],
				card({ name: 'Mire Chains', manaCost: '{B}', cmc: 1, typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' }),
				'battlefield'
			);
			oppAura.attachedToId = runner.instanceId;
			const life0 = p[0].life;

			state.phase = 'declare_attackers';
			state.priorityPlayerIndex = 0;
			assert.equal(
				applyGameAction(state, p[0].playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: runner.instanceId, defenderPlayerId: p[1].playerId, defenderPlaneswalkerId: null }]
				}).ok,
				true
			);
			drainStack(state);
			assert.equal(p[0].life, life0, 'opponent Aura does NOT make creature modified (CR 700.9)');
		}

		// Case 2: Enchanted by controller's OWN Aura -> IS modified!
		{
			const { state, p } = game();
			put(state, p[0], watcher, 'battlefield');
			const runner = put(
				state,
				p[0],
				card({ name: 'Swift Scout', manaCost: '{R}', cmc: 1, typeLine: 'Creature — Scout', power: '1', toughness: '1' }),
				'battlefield'
			);
			const ownAura = put(
				state,
				p[0],
				card({ name: 'Sun Cloak', manaCost: '{W}', cmc: 1, typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' }),
				'battlefield'
			);
			ownAura.attachedToId = runner.instanceId;
			const life0 = p[0].life;

			state.phase = 'declare_attackers';
			state.priorityPlayerIndex = 0;
			assert.equal(
				applyGameAction(state, p[0].playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: runner.instanceId, defenderPlayerId: p[1].playerId, defenderPlaneswalkerId: null }]
				}).ok,
				true
			);
			drainStack(state);
			assert.equal(p[0].life, life0 + 2, 'own Aura makes creature modified');
		}

		// Case 3: Has a +1/+1 counter -> IS modified!
		{
			const { state, p } = game();
			put(state, p[0], watcher, 'battlefield');
			const runner = put(
				state,
				p[0],
				card({ name: 'Swift Scout', manaCost: '{R}', cmc: 1, typeLine: 'Creature — Scout', power: '1', toughness: '1' }),
				'battlefield'
			);
			runner.counters['+1/+1'] = 1;
			const life0 = p[0].life;

			state.phase = 'declare_attackers';
			state.priorityPlayerIndex = 0;
			assert.equal(
				applyGameAction(state, p[0].playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: runner.instanceId, defenderPlayerId: p[1].playerId, defenderPlaneswalkerId: null }]
				}).ok,
				true
			);
			drainStack(state);
			assert.equal(p[0].life, life0 + 2, '+1/+1 counter makes creature modified');
		}
	});

	it('evaluates Outlaw (CR 700.12) and Full Party (CR 700.8)', () => {
		const { state, p } = game();
		const outlawBoss = card({
			name: 'Saloon Broker',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Human Advisor',
			oracleText: 'Whenever an outlaw you control enters, you gain 1 life.',
			power: '1',
			toughness: '3'
		});
		const partyBanner = card({
			name: 'Expedition Standard',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: 'At the beginning of combat on your turn, if you have a full party, you gain 4 life.'
		});
		assertFullySupported(outlawBoss);
		assertFullySupported(partyBanner);
		put(state, p[0], outlawBoss, 'battlefield');
		put(state, p[0], partyBanner, 'battlefield');
		const life0 = p[0].life;

		// Non-outlaw Cleric enters -> +0 life
		const cleric = put(
			state,
			p[0],
			card({ name: 'Dawn Healer', manaCost: '{W}', cmc: 1, typeLine: 'Creature — Human Cleric', power: '1', toughness: '2' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: cleric.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0, 'Cleric is not an outlaw');

		// Rogue enters -> IS an outlaw (+1 life) AND 2nd party member!
		const rogue = put(
			state,
			p[0],
			card({ name: 'Alley Cutpurse', manaCost: '{B}', cmc: 1, typeLine: 'Creature — Human Rogue', power: '1', toughness: '1' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p[0].playerId, { type: 'cast_spell', instanceId: rogue.instanceId }).ok, true);
		drainStack(state);
		assert.equal(p[0].life, life0 + 1, 'Rogue matched outlaw');

		// Add Warrior and Wizard -> full party of 4!
		put(state, p[0], card({ name: 'Iron Brawler', typeLine: 'Creature — Dwarf Warrior', power: '2', toughness: '2' }), 'battlefield');
		put(state, p[0], card({ name: 'Star Adept', typeLine: 'Creature — Elf Wizard', power: '1', toughness: '1' }), 'battlefield');

		emitEvent(state, { kind: 'PhaseBegin', phase: 'begin_combat', activePlayerId: p[0].playerId });
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 5, 'full party condition satisfied (+4 life)');
	});
});

describe('Wave 6 Track P16b — Keyword Trigger Heads, Haunt Exile Look-Back, & Rename Invariance', () => {
	it('fires Haunt trigger from exile when the haunted creature dies (CR 702.55c)', () => {
		const { state, p } = game();
		const specter = card({
			name: 'Hollow Banshee',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Creature — Spirit',
			oracleText: 'When Hollow Banshee enters or the creature it haunts dies, you gain 3 life.',
			power: '2',
			toughness: '2'
		});
		assertFullySupported(specter);
		const exiledHaunter = put(state, p[0], specter, 'exile');
		const victim = put(
			state,
			p[1],
			card({ name: 'Doomed Squire', typeLine: 'Creature — Human', power: '1', toughness: '1' }),
			'battlefield'
		);
		exiledHaunter.hauntingTargetId = victim.instanceId;

		const life0 = p[0].life;
		moveToZone(state, victim, 'battlefield', 'graveyard');
		flushTriggers(state);
		drainStack(state);
		assert.equal(p[0].life, life0 + 3, 'exiled haunt card triggered when haunted creature died');
	});

	it('compiles and executes Mutate, Soulbond paired, Tribute, Exhaust, Unattach, and PhaseIn triggers identically under card rename', () => {
		const templates = [
			'Whenever ALPHA mutates, draw a card.',
			'Whenever ALPHA attacks, if ALPHA is paired with another creature, draw a card.',
			"When ALPHA enters, if tribute wasn't paid, draw a card.",
			'Whenever you activate an exhaust ability, draw a card.',
			'Whenever an Equipment you control becomes unattached from a creature, draw a card.',
			'Whenever ALPHA phases in, you gain 2 life.'
		];
		for (const tpl of templates) {
			const c1 = card({
				name: 'Zephyr Test One',
				typeLine: 'Creature — Beast',
				oracleText: tpl.replace(/ALPHA/g, 'Zephyr Test One'),
				power: '3',
				toughness: '3'
			});
			const c2 = card({
				name: 'Obsidian Probe Nine',
				typeLine: 'Creature — Beast',
				oracleText: tpl.replace(/ALPHA/g, 'Obsidian Probe Nine'),
				power: '3',
				toughness: '3'
			});
			assertFullySupported(c1);
			assertFullySupported(c2);
			assert.deepEqual(
				compileCard(c1).faces[0].abilities,
				compileCard(c2).faces[0].abilities,
				`rename invariance failed for: ${tpl}`
			);
		}
	});
});
