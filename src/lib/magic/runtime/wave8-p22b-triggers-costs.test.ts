import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	getSpellCostRequirement,
	runBeginningOfTurn
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import { parseCost, parseAdditionalCostSentence, parseCostModifierSentence } from '../compiler/costs.ts';
import { parseCondition, parseTriggerHeader, runtimeTriggerProblem } from '../compiler/triggers.ts';
import { emitEvent } from './events.ts';
import { flushTriggers } from './triggers.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { evaluateCondition } from './objectFilter.ts';
import {
	planCosts,
	serializeCostPlanParts,
	executeCostPaymentParts
} from './costs.ts';
import { dealDamageToPermanent } from './effects.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type DeckCardEntry,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `p22b_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function makeDeck(cards: ScryfallCard[]): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: 'deck_p22b',
		userId: 'p1',
		name: 'Track P22b Deck',
		description: '',
		commanders: [],
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupGame(numPlayers = 2): { state: GameState; p: PlayerGameState[] } {
	const filler = synthCard({
		name: 'P22b Filler Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	for (let i = 0; i < numPlayers; i++) {
		const deck = makeDeck(Array.from({ length: 25 }, () => filler));
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: names[i],
			avatarUrl: '',
			isBot: false,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
		decks.set(i, deck);
	}
	const state = createInitialGameState('LOBBY_P22B', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: 20
	});
	for (const s of seats) {
		if (state.status === 'mulligan') {
			assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	state.phase = 'main1';
	state.turnNumber = 2;
	for (const pl of state.players) {
		pl.life = 20;
		pl.hand = [];
		pl.battlefield = [];
		pl.graveyard = [];
		pl.exile = [];
		pl.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	noteLayerInputsChanged(state);
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
	noteLayerInputsChanged(state);
	return inst;
}

function resolveAll(state: GameState, max = 50): void {
	for (let guard = 0; guard < max; guard++) {
		const prompt = state.pendingPrompts[0];
		if (prompt?.choice?.kind === 'orderObjects') {
			const res = applyGameAction(state, prompt.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'orderObjects', topIds: prompt.choice.objectIds }
			});
			assert.equal(res.ok, true);
			continue;
		}
		if (prompt?.choice?.kind === 'yesNo') {
			const res = applyGameAction(state, prompt.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'yesNo', yes: true }
			});
			assert.equal(res.ok, true);
			continue;
		}
		if (state.stack.length === 0) break;
		const actor = state.players[state.priorityPlayerIndex];
		if (!actor) break;
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, JSON.stringify(res));
	}
}

describe('Wave 8 — Track P22b: Trigger Conditions, Events, and Costs', () => {
	it('compiles P22b trigger heads, conditions, costs, and cost modifiers with zero runtimeTriggerProblem and synthetic rename invariance', () => {
		const compileCheckCards: Array<{
			text: string;
			typeLine?: string;
			manaCost?: string;
			power?: string;
			toughness?: string;
		}> = [
			{
				text: 'Whenever an opponent activates a loyalty ability of a planeswalker, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: "Whenever an opponent activates an ability that isn't a mana ability, you gain 1 life.",
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever players finish voting, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever you win a clash, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever a player shuffles their library, you gain 2 life.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever a spell is countered, you gain 1 life.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever the final chapter ability of a Saga you control resolves, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever a creature you control saddles a Mount or crews a Vehicle during your main phase, it gains haste until end of turn.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever you cast a spell with flashback, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever an opponent draws a card except the first one they draw in each of their draw steps, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever a creature you control attacks the player with the most life, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever a player attacks with three or more creatures, draw a card.',
				typeLine: 'Enchantment'
			},
			{
				text: 'Whenever an Aura or Equipment becomes attached to ~, draw a card.',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			},
			{
				text: 'At the beginning of each of your main phases, if this ability hasn\'t added mana this turn, add {G}.',
				typeLine: 'Enchantment'
			},
			{
				text: "Spells with the chosen name the enchanted player casts cost {2} more to cast.",
				typeLine: 'Enchantment — Aura'
			},
			{
				text: 'This spell costs {1} less to cast for each life your opponents lost this turn.',
				typeLine: 'Creature — Demon',
				manaCost: '{4}{B}{R}',
				power: '6',
				toughness: '6'
			}
		];

		for (const spec of compileCheckCards) {
			const c1 = synthCard({
				name: 'Alpha Test Card',
				oracleText: spec.text.replace(/~/g, 'Alpha Test Card'),
				typeLine: spec.typeLine ?? 'Enchantment',
				manaCost: spec.manaCost ?? '{2}',
				power: spec.power,
				toughness: spec.toughness
			});
			const c2 = synthCard({
				name: 'Beta Renamed Card',
				oracleText: spec.text.replace(/~/g, 'Beta Renamed Card'),
				typeLine: spec.typeLine ?? 'Enchantment',
				manaCost: spec.manaCost ?? '{2}',
				power: spec.power,
				toughness: spec.toughness
			});
			const d1 = compileCard(c1);
			const d2 = compileCard(c2);
			const rep = definitionSupportReport(d1);
			assert.equal(rep.fullySupported, true, `Expected full support for: ${spec.text}; rep=${JSON.stringify(rep)}`);
			assert.deepEqual(
				d1.faces[0].abilities.map((a) => ({
					kind: a.kind,
					text: 'text' in a ? a.text : a.kind === 'keyword' ? a.keyword.name : ''
				})),
				d2.faces[0].abilities.map((a) => ({
					kind: a.kind,
					text: 'text' in a ? a.text : a.kind === 'keyword' ? a.keyword.name : ''
				}))
			);
			for (const ab of d1.faces[0].abilities) {
				if (ab.kind === 'triggered') {
					assert.equal(runtimeTriggerProblem(ab.trigger), null, `runtimeTriggerProblem for: ${spec.text}`);
				}
			}
		}

		// Verify all P22b cost & condition grammars parse cleanly
		assert.deepEqual(parseCost('Choose a creature type').defs, [{ k: 'chooseCreatureType' }]);
		assert.deepEqual(parseCost('Choose a number between 1 and 5').defs, [
			{ k: 'chooseNumberBetween', min: 1, max: 5 }
		]);
		assert.deepEqual(parseCost('Reveal the player you chose').defs, [{ k: 'revealChosenPlayer' }]);
		assert.deepEqual(parseCost('Reveal the creature type you chose').defs, [{ k: 'revealChosenSubType' }]);
		assert.deepEqual(parseCost('Discard the last card you drew this turn').defs, [
			{ k: 'discardLastDrawnThisTurn' }
		]);
		assert.deepEqual(parseCost('Choose flying, first strike, trample, or banding').defs, [
			{ k: 'chooseFromKeywordList', keywords: ['flying', 'first strike', 'trample', 'banding'] }
		]);
		assert.deepEqual(parseCost("Pay enchanted creature's mana cost").defs, [{ k: 'payAttachedManaCost' }]);
		assert.deepEqual(parseCost('Exile a creature card from your graveyard and pay its mana cost').defs, [
			{ k: 'exileFromGraveyardAndPayManaCost', filter: { types: ['Creature'] } }
		]);
		assert.deepEqual(parseCost('Exile a face-down permanent you control face up').defs, [
			{ k: 'exileFaceDownPermanentFaceUp' }
		]);
		assert.deepEqual(parseCost('Pay {1} for each +1/+1 counter on ~').defs, [
			{ k: 'payManaPerCounter', perMana: '{1}', counter: '+1/+1', of: 'self' }
		]);
		assert.deepEqual(parseCost('Reveal ~ from your hand').defs, [{ k: 'revealSelfFromHand' }]);
		assert.deepEqual(
			parseCost('Remove a time counter from a permanent you control or suspended card you own').defs,
			[{ k: 'removeCounters', counter: 'time', count: { k: 'const', n: 1 }, from: {}, orSuspendedYouOwn: true }]
		);
		assert.deepEqual(
			parseAdditionalCostSentence('As an additional cost to cast ~, you may pay {1}{G} any number of times.')
				?.defs,
			[{ k: 'repeatableOptionalMana', cost: '{1}{G}' }]
		);
		assert.deepEqual(
			parseCost('Collect evidence X, where X is the total mana value of the permanents it targets').defs,
			[
				{
					k: 'exileFrom',
					zone: 'graveyard',
					count: { k: 'anyNumber' },
					minTotalManaValueAmount: { k: 'targetsTotalManaValue' },
					collectEvidence: true
				}
			]
		);
		assert.deepEqual(parseCondition('if that spell was kicked'), { k: 'eventSpellWasKicked' });
		assert.deepEqual(parseCondition('if no colored mana was spent to cast that spell'), {
			k: 'eventSpellNoColoredManaSpent'
		});
		assert.deepEqual(
			parseCondition('if the amount of mana spent to cast that spell is less than its mana value'),
			{ k: 'eventSpellManaSpentLessThanMv' }
		);
		assert.deepEqual(parseCondition('if you have less life than your starting life total'), {
			k: 'yourLifeLessThanStarting'
		});
		assert.deepEqual(parseCondition('if every land on the battlefield is a Forest'), {
			k: 'allLandsAreSubtype',
			subtype: 'Forest'
		});
		assert.deepEqual(parseCondition("if ~ didn't attack this turn"), { k: 'selfDidntAttackThisTurn' });
		const mod = parseCostModifierSentence(
			'Spells with the chosen name the enchanted player casts cost {2} more to cast'
		);
		assert.equal(mod?.k, 'costModifier');
		if (mod?.k === 'costModifier') {
			assert.equal(mod.whoEnchantedPlayer, true);
			assert.equal(mod.affects.k === 'spell' && mod.affects.filter.ofChosenName, true);
		}
		assert.equal(parseTriggerHeader('Whenever players finish voting, draw a card.')?.trigger?.event, 'playersFinishedVoting');
	});

	it('triggers AbilityActivated (loyalty & non-mana), LibraryShuffled, SpellCountered, Clash, PlayersFinishedVoting, SagaChapterResolved, and SaddledMount/CrewedVehicle (duringPhase)', () => {
		const { state, p } = setupGame(2);
		const [p1, p2] = p;

		const loyaltyWatcher = synthCard({
			name: 'Loyalty Watcher',
			typeLine: 'Enchantment',
			oracleText: 'Whenever an opponent activates a loyalty ability of a planeswalker, you gain 2 life.'
		});
		const shuffleWatcher = synthCard({
			name: 'Shuffle Watcher',
			typeLine: 'Enchantment',
			oracleText: 'Whenever a player shuffles their library, you gain 3 life.'
		});
		const counterWatcher = synthCard({
			name: 'Counter Watcher',
			typeLine: 'Enchantment',
			oracleText: 'Whenever a spell is countered, you gain 4 life.'
		});
		const clashWatcher = synthCard({
			name: 'Clash Watcher',
			typeLine: 'Enchantment',
			oracleText: 'Whenever you win a clash, you gain 5 life.'
		});
		const voteWatcher = synthCard({
			name: 'Vote Watcher',
			typeLine: 'Enchantment',
			oracleText: 'Whenever players finish voting, you gain 6 life.'
		});
		const sagaWatcher = synthCard({
			name: 'Saga Watcher',
			typeLine: 'Enchantment',
			oracleText: 'Whenever the final chapter ability of a Saga you control resolves, you gain 7 life.'
		});
		const mainSaddleWatcher = synthCard({
			name: 'Velocitaur Mentor',
			typeLine: 'Enchantment',
			oracleText:
				'Whenever a creature you control saddles a Mount or crews a Vehicle during your main phase, draw a card.'
		});
		const bear = synthCard({
			name: 'Test Mount Pilot',
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		const mount = synthCard({
			name: 'Test Mount',
			typeLine: 'Creature — Horse Mount',
			power: '3',
			toughness: '3',
			oracleText: 'Saddle 2'
		});
		const saga = synthCard({
			name: 'Test Saga',
			typeLine: 'Enchantment — Saga',
			oracleText: 'I — You gain 1 life.\nII — Draw a card.'
		});
		const pw = synthCard({
			name: 'Test Planeswalker',
			typeLine: 'Planeswalker — Test',
			loyalty: '3',
			oracleText: '+1: You gain 1 life.'
		});
		const bolt = synthCard({
			name: 'Dummy Spell',
			manaCost: '{R}',
			typeLine: 'Instant',
			oracleText: 'Dummy Spell deals 1 damage to any target.'
		});

		put(state, p1, loyaltyWatcher, 'battlefield');
		put(state, p1, shuffleWatcher, 'battlefield');
		put(state, p1, counterWatcher, 'battlefield');
		put(state, p1, clashWatcher, 'battlefield');
		put(state, p1, voteWatcher, 'battlefield');
		put(state, p1, sagaWatcher, 'battlefield');
		put(state, p1, mainSaddleWatcher, 'battlefield');
		const p1Bear = put(state, p1, bear, 'battlefield');
		const p1Mount = put(state, p1, mount, 'battlefield');
		const p1Saga = put(state, p1, saga, 'battlefield');
		const p2Pw = put(state, p2, pw, 'battlefield');

		// 1. Loyalty ability activation event from opponent -> triggers loyaltyWatcher (+2)
		emitEvent(state, {
			kind: 'AbilityActivated',
			playerId: p2.playerId,
			sourceId: p2Pw.instanceId,
			source: p2Pw,
			isLoyaltyAbility: true,
			isManaAbility: false
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 22);

		// 2. LibraryShuffled (+3)
		emitEvent(state, { kind: 'LibraryShuffled', playerId: p2.playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 25);

		// 3. SpellCountered (+4)
		emitEvent(state, {
			kind: 'SpellCountered',
			counteredStackItemId: 'stk_bolt',
			counteredCard: bolt,
			byControllerId: p1.playerId,
			bySpellOrAbility: true
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 29);

		// 4. Clash won (+5; loss does NOT trigger "Whenever you win a clash")
		emitEvent(state, { kind: 'Clash', playerId: p1.playerId, won: false });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 29);
		emitEvent(state, { kind: 'Clash', playerId: p1.playerId, won: true });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 34);

		// 5. PlayersFinishedVoting (+6)
		emitEvent(state, { kind: 'PlayersFinishedVoting', controllerId: p1.playerId, winningChoice: 'time' });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 40);

		// 6. SagaChapterResolved (non-final chapter ignored, final chapter +7)
		emitEvent(state, {
			kind: 'SagaChapterResolved',
			objectId: p1Saga.instanceId,
			object: p1Saga,
			controllerId: p1.playerId,
			chapterNumbers: [1],
			isFinalChapter: false
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 40);
		emitEvent(state, {
			kind: 'SagaChapterResolved',
			objectId: p1Saga.instanceId,
			object: p1Saga,
			controllerId: p1.playerId,
			chapterNumbers: [2],
			isFinalChapter: true
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, 47);

		// 7. SaddledMount during main1 draws a card, outside main1 does NOT
		const handBefore = p1.hand.length;
		emitEvent(state, {
			kind: 'SaddledMount',
			playerId: p1.playerId,
			creatureId: p1Bear.instanceId,
			creature: p1Bear,
			mountId: p1Mount.instanceId,
			mount: p1Mount
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.hand.length, handBefore + 1);

		state.phase = 'begin_combat';
		emitEvent(state, {
			kind: 'SaddledMount',
			playerId: p1.playerId,
			creatureId: p1Bear.instanceId,
			creature: p1Bear,
			mountId: p1Mount.instanceId,
			mount: p1Mount
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.hand.length, handBefore + 1);
	});

	it('enforces Carpet of Flowers triggered-mana gate, Leela exceptFirstInDrawStep, Reflective Golem targetsOnlySelf, Curse of Silence whoEnchantedPlayer, and Aurelia attackingWithFilter', () => {
		const { state, p } = setupGame(3);
		const [p1, p2, p3] = p;

		// 1. Carpet of Flowers: triggers main1, marks addedManaThisTurn=true so main2 does NOT re-trigger
		const carpet = synthCard({
			name: 'Flower Patch',
			typeLine: 'Enchantment',
			oracleText:
				"At the beginning of each of your main phases, if this ability hasn't added mana this turn, add {G}."
		});
		const p1Carpet = put(state, p1, carpet, 'battlefield');
		emitEvent(state, { kind: 'PhaseBegin', phase: 'main1', activePlayerId: p1.playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.manaPool.G, 1);
		assert.equal(p1Carpet.addedManaThisTurn, true);

		state.phase = 'main2';
		emitEvent(state, { kind: 'PhaseBegin', phase: 'main2', activePlayerId: p1.playerId });
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.manaPool.G, 1, 'Main2 must NOT trigger again after main1 added mana');

		// 2. Leela exceptFirstInDrawStep
		state.phase = 'main1';
		const leela = synthCard({
			name: 'Draw Watcher',
			typeLine: 'Creature — Human',
			power: '2',
			toughness: '2',
			oracleText:
				'Whenever an opponent draws a card except the first one they draw in each of their draw steps, you gain 2 life.'
		});
		put(state, p1, leela, 'battlefield');
		const p1LifeStart = p1.life;
		const d1 = put(state, p2, synthCard({ name: 'D1' }), 'hand');
		const d2 = put(state, p2, synthCard({ name: 'D2' }), 'hand');
		// First draw in p2's own draw step -> skipped
		emitEvent(state, {
			kind: 'CardDrawn',
			playerId: p2.playerId,
			objectId: d1.instanceId,
			object: d1,
			inOwnDrawStepOrdinal: 1
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, p1LifeStart);
		// Second draw in p2's draw step -> triggers (+2 life)
		emitEvent(state, {
			kind: 'CardDrawn',
			playerId: p2.playerId,
			objectId: d2.instanceId,
			object: d2,
			inOwnDrawStepOrdinal: 2
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, p1LifeStart + 2);

		// 3. Curse of Silence (whoEnchantedPlayer + enchantedPlayerCasts + ofChosenName)
		const curse = synthCard({
			name: 'Silence Curse',
			typeLine: 'Enchantment — Aura Curse',
			oracleText:
				'Enchant player\nSpells with the chosen name the enchanted player casts cost {2} more to cast.\nWhenever enchanted player casts a spell with the chosen name, draw a card.'
		});
		const targetSpellCard = synthCard({
			name: 'Chosen Lightning',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Deal 3 damage to any target.'
		});
		const p1Curse = put(state, p1, curse, 'battlefield');
		p1Curse.attachedToId = p2.playerId;
		p1Curse.chosenCardName = 'Chosen Lightning';

		const p2Inst = put(state, p2, targetSpellCard, 'hand');
		const p3Inst = put(state, p3, targetSpellCard, 'hand');
		const p2Req = getSpellCostRequirement(p2, p2Inst, state);
		const p3Req = getSpellCostRequirement(p3, p3Inst, state);
		assert.equal(p2Req.generic, 2, 'Enchanted player pays {2} extra');
		assert.equal(p2Req.colored.R, 1);
		assert.equal(p3Req.generic, 0, 'Non-enchanted player does NOT pay curse tax');
		assert.equal(p3Req.colored.R, 1);

		// 4. Reflective Golem targetsOnlySelf
		const golem = synthCard({
			name: 'Reflective Construct',
			typeLine: 'Artifact Creature — Golem',
			power: '2',
			toughness: '3',
			oracleText: 'Whenever you cast an instant or sorcery spell that targets only ~, you gain 3 life.'
		});
		const p1Golem = put(state, p1, golem, 'battlefield');
		const p1Bear = put(state, p1, synthCard({ name: 'Other Bear', typeLine: 'Creature', power: '2', toughness: '2' }), 'battlefield');
		const buffSpell = synthCard({
			name: 'Single Target Buff',
			manaCost: '{G}',
			typeLine: 'Instant',
			oracleText: 'Target creature gets +2/+2 until end of turn.'
		});
		const singleCast = put(state, p1, buffSpell, 'hand');
		singleCast.zone = 'stack';
		p1.hand = p1.hand.filter((c) => c.instanceId !== singleCast.instanceId);
		state.stack.push({
			id: 'stk_single_buff',
			sourceInstanceId: singleCast.instanceId,
			card: singleCast.card,
			ownerId: p1.playerId,
			controllerId: p1.playerId,
			kind: 'spell',
			title: singleCast.card.name,
			oracleText: singleCast.card.oracleText,
			targets: [{ kind: 'permanent', id: p1Golem.instanceId, label: p1Golem.card.name }],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});
		const lifeBeforeSingle = p1.life;
		emitEvent(state, {
			kind: 'Cast',
			playerId: p1.playerId,
			objectId: singleCast.instanceId,
			object: singleCast,
			targets: [{ kind: 'permanent', id: p1Golem.instanceId, label: p1Golem.card.name }],
			stackItemId: 'stk_single_buff'
		});
		flushTriggers(state);
		state.stack = state.stack.filter((s) => s.id !== 'stk_single_buff');
		resolveAll(state);
		assert.equal(p1.life, lifeBeforeSingle + 3);

		// Multi-target spell (even including golem) must NOT satisfy targetsOnlySelf
		const multiCast = put(state, p1, buffSpell, 'hand');
		multiCast.zone = 'stack';
		p1.hand = p1.hand.filter((c) => c.instanceId !== multiCast.instanceId);
		state.stack.push({
			id: 'stk_multi_buff',
			sourceInstanceId: multiCast.instanceId,
			card: multiCast.card,
			ownerId: p1.playerId,
			controllerId: p1.playerId,
			kind: 'spell',
			title: multiCast.card.name,
			oracleText: multiCast.card.oracleText,
			targets: [
				{ kind: 'permanent', id: p1Golem.instanceId, label: p1Golem.card.name },
				{ kind: 'permanent', id: p1Bear.instanceId, label: p1Bear.card.name }
			],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});
		emitEvent(state, {
			kind: 'Cast',
			playerId: p1.playerId,
			objectId: multiCast.instanceId,
			object: multiCast,
			targets: [
				{ kind: 'permanent', id: p1Golem.instanceId, label: p1Golem.card.name },
				{ kind: 'permanent', id: p1Bear.instanceId, label: p1Bear.card.name }
			],
			stackItemId: 'stk_multi_buff'
		});
		flushTriggers(state);
		state.stack = state.stack.filter((s) => s.id !== 'stk_multi_buff');
		resolveAll(state);
		assert.equal(p1.life, lifeBeforeSingle + 3);

		// 5. Aurelia attackingWithFilter + minAttackingWithCount
		const warleader = synthCard({
			name: 'Battle Commander',
			typeLine: 'Creature — Angel',
			power: '4',
			toughness: '4',
			oracleText: 'Whenever a player attacks with three or more creatures, you gain 5 life.'
		});
		put(state, p1, warleader, 'battlefield');
		const lifeBeforeAtk = p1.life;
		const a1 = put(state, p2, synthCard({ name: 'Atk1', typeLine: 'Creature', power: '1', toughness: '1' }), 'battlefield');
		const a2 = put(state, p2, synthCard({ name: 'Atk2', typeLine: 'Creature', power: '1', toughness: '1' }), 'battlefield');
		const a3 = put(state, p2, synthCard({ name: 'Atk3', typeLine: 'Creature', power: '1', toughness: '1' }), 'battlefield');
		emitEvent(state, {
			kind: 'AttackDeclared',
			playerId: p2.playerId,
			attackerIds: [a1.instanceId, a2.instanceId, a3.instanceId]
		});
		flushTriggers(state);
		resolveAll(state);
		assert.equal(p1.life, lifeBeforeAtk + 5);
	});

	it('evaluates P22b excess damage, lifeLostLastTurn snapshot, Rakdos opponentsLifeLostThisTurn cost reduction, and intervening-if conditions', () => {
		const { state, p } = setupGame(2);
		const [p1, p2] = p;

		// 1. Excess damage tracking
		const toughness2 = put(
			state,
			p2,
			synthCard({ name: 'Small Target', typeLine: 'Creature', power: '2', toughness: '2' }),
			'battlefield'
		);
		const attacker = put(
			state,
			p1,
			synthCard({ name: 'Heavy Hitter', typeLine: 'Creature — Giant', power: '5', toughness: '5' }),
			'battlefield'
		);
		dealDamageToPermanent(
			state,
			toughness2,
			4,
			attacker.instanceId,
			{
				hasDeathtouch: false,
				hasLifelink: false,
				hasInfect: false,
				hasWither: false,
				colors: [],
				types: ['Creature'],
				sourceControllerId: p1.playerId,
				sourceCard: attacker.card
			},
			{ actorId: p1.playerId }
		);
		assert.equal((toughness2.dealtExcessDamageThisTurn ?? 0) > 0, true);

		// 2. Rakdos opponentsLifeLostThisTurn cost reduction
		p2.lifeLostThisTurn = 3;
		const rakdos = synthCard({
			name: 'Lord of Pain',
			manaCost: '{4}{B}{R}',
			cmc: 6,
			typeLine: 'Legendary Creature — Demon',
			power: '6',
			toughness: '6',
			oracleText: 'This spell costs {1} less to cast for each life your opponents lost this turn.'
		});
		const rakdosInst = put(state, p1, rakdos, 'hand');
		const req = getSpellCostRequirement(p1, rakdosInst, state);
		assert.equal(req.generic, 1);
		assert.equal(req.colored.B, 1);
		assert.equal(req.colored.R, 1);

		// 3. Intervening-if condition evaluations
		p1.life = 15; // startingLife = 20 -> yourLifeLessThanStarting = true
		assert.equal(
			evaluateCondition({ k: 'yourLifeLessThanStarting' }, { state, controllerId: p1.playerId }),
			true
		);
		p1.life = 22;
		assert.equal(
			evaluateCondition({ k: 'yourLifeLessThanStarting' }, { state, controllerId: p1.playerId }),
			false
		);
	});

	it('separates yourLifeLessThanStarting, lifeLostLastTurn across end/begin turn, and executes P22b costs (Urgent Necropsy, Rift Elemental, BeholdOrChoose, PayManaPerCounter, RepeatableOptionalMana, ChooseNumber, ExileGyPayMana, ExileFaceDownFaceUp)', () => {
		const { state, p } = setupGame(2);
		const [p1, p2] = p;

		// yourLifeLessThanStarting exact check
		p1.life = 20;
		assert.equal(
			evaluateCondition({ k: 'yourLifeLessThanStarting' }, { state, controllerId: p1.playerId }),
			false
		);
		p1.life = 19;
		assert.equal(
			evaluateCondition({ k: 'yourLifeLessThanStarting' }, { state, controllerId: p1.playerId }),
			true
		);

		// lifeLostLastTurn snapshot across turn transition
		p2.lifeLostThisTurn = 4;
		enterEndStep(state, p1);
		runBeginningOfTurn(state); // advances to p2's turn and snapshots p2's lifeLostThisTurn -> lifeLostLastTurn
		assert.equal(p2.lifeLostLastTurn, 4);
		assert.equal(
			evaluateCondition(
				{ k: 'playerLostLifeLastTurn' },
				{ state, controllerId: p1.playerId, eventPlayerId: p2.playerId }
			),
			true
		);

		// Reset to p1 main1 for cost tests
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.phase = 'main1';

		// 1. Urgent Necropsy: minTotalManaValueAmount: targetsTotalManaValue
		const permTarget = put(
			state,
			p2,
			synthCard({ name: 'Target Relic', cmc: 5, typeLine: 'Artifact' }),
			'battlefield'
		);
		const gyFodder = put(
			state,
			p1,
			synthCard({ name: 'High MV Card', cmc: 6, typeLine: 'Sorcery' }),
			'graveyard'
		);
		const necropsy = put(state, p1, synthCard({ name: 'Necropsy Test' }), 'hand');
		const necrDefs = parseCost(
			'Collect evidence X, where X is the total mana value of the permanents it targets'
		).defs;
		const necrCtx = {
			state,
			player: p1,
			source: necropsy,
			isSpell: true,
			xValue: 0,
			baseMana: null,
			canPayMana: () => true,
			payMana: () => true,
			targets: [{ kind: 'permanent' as const, id: permTarget.instanceId, label: permTarget.card.name }]
		};
		const necrPlan = planCosts(necrCtx, necrDefs, {
			objects: [[gyFodder.instanceId]]
		});
		assert.equal(necrPlan.ok, true);
		if (necrPlan.ok && !('question' in necrPlan)) {
			const exec = executeCostPaymentParts(necrCtx, serializeCostPlanParts(necrCtx, necrPlan));
			assert.equal(!exec.paused, true);
			assert.equal(p1.graveyard.length, 0);
			assert.equal(p1.exile.length, 1);
		}

		// 2. Rift Elemental: removeCounters.orSuspendedYouOwn
		const rift = put(state, p1, synthCard({ name: 'Rift Elemental', typeLine: 'Creature' }), 'battlefield');
		const susp = put(state, p1, synthCard({ name: 'Suspended Spell', typeLine: 'Sorcery' }), 'exile');
		susp.isSuspended = true;
		susp.counters.time = 2;
		const riftDefs = parseCost('Remove a time counter from a permanent you control or suspended card you own').defs;
		const riftCtx = {
			state,
			player: p1,
			source: rift,
			isSpell: false,
			xValue: 0,
			baseMana: null,
			canPayMana: () => true,
			payMana: () => true
		};
		const riftPlan = planCosts(riftCtx, riftDefs, {
			objects: [[susp.instanceId]]
		});
		assert.equal(riftPlan.ok, true);
		if (riftPlan.ok && !('question' in riftPlan)) {
			const exec = executeCostPaymentParts(riftCtx, serializeCostPlanParts(riftCtx, riftPlan));
			assert.equal(!exec.paused, true);
			assert.equal(susp.counters.time, 1);
		}

		// 3. BeholdOrChoose + ChooseCreatureType + ChooseNumberBetween + RepeatableOptionalMana + PayManaPerCounter
		const dragon = put(
			state,
			p1,
			synthCard({ name: 'Big Dragon', typeLine: 'Creature — Dragon', power: '5', toughness: '5' }),
			'battlefield'
		);
		const beholdDefs = parseCost('Choose a Dragon you control or reveal a Dragon card from your hand').defs;
		const dragonCtx = {
			state,
			player: p1,
			source: rift,
			isSpell: true,
			xValue: 0,
			baseMana: null,
			canPayMana: () => true,
			payMana: () => true
		};
		const bPlan = planCosts(dragonCtx, beholdDefs, {
			objects: [[dragon.instanceId]]
		});
		assert.equal(bPlan.ok, true);
		if (bPlan.ok && !('question' in bPlan)) {
			const exec = executeCostPaymentParts(dragonCtx, serializeCostPlanParts(dragonCtx, bPlan));
			assert.equal(!exec.paused, true);
			assert.equal(exec.beheldOrChosenPower, 5);
		}

		const ctypePlan = planCosts(dragonCtx, parseCost('Choose a creature type').defs, {
			chosenSubTypeCost: 'Goblin'
		});
		assert.equal(ctypePlan.ok, true);
		if (ctypePlan.ok && !('question' in ctypePlan)) {
			const exec = executeCostPaymentParts(dragonCtx, serializeCostPlanParts(dragonCtx, ctypePlan));
			assert.equal(!exec.paused, true);
			assert.equal(exec.chosenSubTypeCost, 'Goblin');
		}

		const cnumPlan = planCosts(dragonCtx, parseCost('Choose a number between 1 and 5').defs, {
			chosenNumberCost: 3
		});
		assert.equal(cnumPlan.ok, true);
		if (cnumPlan.ok && !('question' in cnumPlan)) {
			const exec = executeCostPaymentParts(dragonCtx, serializeCostPlanParts(dragonCtx, cnumPlan));
			assert.equal(!exec.paused, true);
			assert.equal(exec.chosenNumberCost, 3);
		}

		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 4, C: 0 };
		const repDefs = parseAdditionalCostSentence(
			'As an additional cost to cast ~, you may pay {1}{G} any number of times.'
		)!.defs;
		const repCtx = {
			state,
			player: p1,
			source: rift,
			isSpell: true,
			xValue: 0,
			baseMana: null,
			canPayMana: (req: { generic: number; colored: Record<string, number> }) => {
				const needG = req.colored.G ?? 0;
				return p1.manaPool.G >= needG + req.generic;
			},
			payMana: (req: { generic: number; colored: Record<string, number> }) => {
				const needG = req.colored.G ?? 0;
				const total = needG + req.generic;
				if (p1.manaPool.G < total) return false;
				p1.manaPool.G -= total;
				return true;
			}
		};
		const repPlan = planCosts(repCtx, repDefs, {
			repeatableManaPaidCount: 2
		});
		assert.equal(repPlan.ok, true);
		if (repPlan.ok && !('question' in repPlan)) {
			const ex = executeCostPaymentParts(repCtx, serializeCostPlanParts(repCtx, repPlan));
			assert.equal(!ex.paused, true);
			assert.equal(ex.repeatableManaPaidCount, 2);
			assert.equal(p1.manaPool.G, 0);
		}

		// 4. PayManaPerCounter
		rift.counters['+1/+1'] = 2;
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 };
		const perCtrDefs = parseCost('Pay {1} for each +1/+1 counter on ~').defs;
		const perCtrCtx = {
			state,
			player: p1,
			source: rift,
			isSpell: false,
			xValue: 0,
			baseMana: null,
			canPayMana: (req: { generic: number }) => p1.manaPool.C >= req.generic,
			payMana: (req: { generic: number }) => {
				if (p1.manaPool.C < req.generic) return false;
				p1.manaPool.C -= req.generic;
				return true;
			}
		};
		const perPlan = planCosts(perCtrCtx, perCtrDefs, {});
		assert.equal(perPlan.ok, true);
		if (perPlan.ok && !('question' in perPlan)) {
			if (perPlan.mana) {
				assert.equal(perPlan.mana.generic, 2);
				assert.equal(perCtrCtx.payMana(perPlan.mana), true);
			}
			const exec = executeCostPaymentParts(perCtrCtx, serializeCostPlanParts(perCtrCtx, perPlan));
			assert.equal(!exec.paused, true);
			assert.equal(p1.manaPool.C, 0);
		}

		// 5. ExileFromGraveyardAndPayManaCost + ExileFaceDownPermanentFaceUp
		const gyCritter = put(
			state,
			p1,
			synthCard({ name: 'Dead Elf', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Elf' }),
			'graveyard'
		);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 2, C: 0 };
		const gyPayDefs = parseCost('Exile a creature card from your graveyard and pay its mana cost').defs;
		const gyPayPlan = planCosts(repCtx, gyPayDefs, {
			objects: [[gyCritter.instanceId]]
		});
		assert.equal(gyPayPlan.ok, true);
		if (gyPayPlan.ok && !('question' in gyPayPlan)) {
			const exec = executeCostPaymentParts(repCtx, serializeCostPlanParts(repCtx, gyPayPlan));
			assert.equal(!exec.paused, true);
			assert.equal(p1.manaPool.G, 0);
			assert.equal(p1.exile.some((e) => e.instanceId === gyCritter.instanceId), true);
		}

		const fdPerm = put(
			state,
			p1,
			synthCard({ name: 'Morphed Bear', typeLine: 'Creature' }),
			'battlefield'
		);
		fdPerm.isFaceDown = true;
		const fdPlan = planCosts(repCtx, parseCost('Exile a face-down permanent you control face up').defs, {
			objects: [[fdPerm.instanceId]]
		});
		assert.equal(fdPlan.ok, true);
		if (fdPlan.ok && !('question' in fdPlan)) {
			const exec = executeCostPaymentParts(repCtx, serializeCostPlanParts(repCtx, fdPlan));
			assert.equal(!exec.paused, true);
			const exiled = p1.exile.find((e) => e.instanceId === fdPerm.instanceId);
			assert.equal(exiled?.isFaceDown, false);
		}
	});
});
