import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkHandSpecialActionLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	getHandSpecialActions,
	hasKeyword,
	sanitizeGameStateForViewer
} from '../engine.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	const id = `syn_p3_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(cards: ScryfallCard[], commander?: ScryfallCard): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: 'deck_p3',
		userId: 'p1',
		name: 'Track P3 Deck',
		description: '',
		commanders: commander ? [commander] : [],
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + (commander ? 1 : 0),
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupMain1Game(opts: { p1Bot?: boolean; p2Bot?: boolean } = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P3 Filler Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const deck = makeDeck(Array.from({ length: 30 }, () => filler));
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: opts.p1Bot ? null : 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: opts.p2Bot ? null : 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: Boolean(opts.p2Bot),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const decks = new Map<number, MagicDeck>([
		[0, deck],
		[1, deck]
	]);
	const state = createInitialGameState('P3_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: 40
	});
	// Deterministic active player = p1 (seat 0) in main1 with clean hand/board
	state.status = 'active';
	state.turnNumber = 1;
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	state.pendingPrompts = [];
	state.stack = [];
	const p1 = state.players[0];
	const p2 = state.players[1];
	p1.playerId = 'p1';
	p2.playerId = 'p2';
	p1.hand = [];
	p2.hand = [];
	p1.battlefield = [];
	p2.battlefield = [];
	p1.graveyard = [];
	p2.graveyard = [];
	p1.exile = [];
	p2.exile = [];
	return { state, p1, p2 };
}

function addCardToZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile',
	summoningSick = false
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, undefined, state);
	inst.summoningSick = zone === 'battlefield' ? summoningSick : false;
	player[zone].push(inst);
	return inst;
}

function resolveAllStack(state: GameState, maxSteps = 30): void {
	for (let step = 0; step < maxSteps; step++) {
		if (state.stack.length === 0 && state.pendingPrompts.length === 0) return;
		if (state.pendingPrompts.length > 0) return;
		const prioPlayer = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `pass_priority failed: ${res.error}`);
	}
}

function roundTripState(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

describe('Track P3 Orthogonal Keywords (CR 702)', () => {
	describe('Foretell (CR 702.143, CR 116.2h)', () => {
		it('exiles face down for {2} at instant timing on own turn, hides identity from opponents, triggers foretell watchers, and casts on a later turn with foretold tracking', () => {
			const { state, p1, p2 } = setupMain1Game();

			const foretellDraw = synthCard({
				name: 'Frost Augury',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Draw two cards. If this spell was foretold, you gain 3 life.\nForetell {U}',
				colors: ['U'],
				colorIdentity: ['U']
			});
			const foretellWatcher = synthCard({
				name: 'Cosmos Sage',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Spirit Adviser',
				oracleText: 'Whenever you foretell a card, you gain 2 life.',
				power: '1',
				toughness: '3',
				colors: ['U']
			});
			const exileInstantWatcher = synthCard({
				name: 'Arcane Exile Sentinel',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Spirit',
				oracleText: 'Whenever an instant card is put into exile from anywhere, you gain 5 life.',
				power: '2',
				toughness: '2',
				colors: ['W']
			});
			const instantFiller = synthCard({
				name: 'Minor Spark',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'You gain 1 life.'
			});

			assert.equal(compileCard(foretellDraw).fullySupported, true);
			assert.equal(compileCard(foretellWatcher).fullySupported, true);

			addCardToZone(state, p1, foretellWatcher, 'battlefield');
			addCardToZone(state, p1, exileInstantWatcher, 'battlefield');
			const ftInst = addCardToZone(state, p1, foretellDraw, 'hand');
			const sparkInst = addCardToZone(state, p1, instantFiller, 'hand');

			const handSpecials = getHandSpecialActions(state, 'p1', ftInst);
			assert.equal(handSpecials.length, 1);
			assert.equal(handSpecials[0].id, 'special:foretell');

			// Put a spell on the stack so the stack is non-empty: Foretell is STILL legal on p1's turn (CR 116.2h)!
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: sparkInst.instanceId,
					fromZone: 'hand'
				}).ok,
				true
			);
			assert.equal(state.stack.length, 1);
			assert.equal(checkHandSpecialActionLegality(state, 'p1', ftInst, 'special:foretell').ok, true);

			// Cannot foretell on opponent's turn
			state.activePlayerIndex = 1;
			assert.equal(checkHandSpecialActionLegality(state, 'p1', ftInst, 'special:foretell').ok, false);
			state.activePlayerIndex = 0;

			// Execute Foretell special action while stack is non-empty
			const ftRes = applyGameAction(state, 'p1', {
				type: 'hand_special_action',
				instanceId: ftInst.instanceId,
				actionId: 'special:foretell'
			});
			assert.equal(ftRes.ok, true);
			assert.equal(p1.manaPool.C, 0);
			assert.equal(p1.exile.length, 1);
			const exiled = p1.exile[0];
			assert.equal(exiled.isFaceDown, true);
			assert.equal(exiled.foretoldByPlayerId, 'p1');
			assert.equal(exiled.foretoldTurnNumber, 1);

			// Owner can see card; opponent sees scrubbed Face-Down Card; log does not leak card name
			const p1View = sanitizeGameStateForViewer(state, 'p1');
			const p2View = sanitizeGameStateForViewer(state, 'p2');
			assert.equal(p1View.players[0].exile[0].card.name, 'Frost Augury');
			assert.notEqual(p2View.players[0].exile[0].card.name, 'Frost Augury');
			assert.equal(
				state.log.some((entry) => entry.text.includes('Frost Augury')),
				false,
				'Foretell special action log must not leak card name'
			);

			// Resolve Cosmos Sage foretell trigger (+2 life) + Minor Spark (+1 life); Instant exile watcher did NOT fire (+0, not +5)!
			resolveAllStack(state);
			assert.equal(p1.life, 43);

			// Cannot cast foretold card on the same turn (turn 1)
			p1.manaPool.U = 2;
			assert.equal(getCastOptions(state, 'p1', exiled, 'exile').length, 0);
			assert.equal(
				checkSpellCastLegality(state, 'p1', exiled, 'exile', 0, 'exile:foretell').ok,
				false
			);

			// On a later turn (turn 2, even on p2's turn because Frost Augury is an Instant!), p1 can cast it for {U}
			state.turnNumber = 2;
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 0;
			state.phase = 'upkeep';
			p1.manaPool.U = 1;
			const exileOpts = getCastOptions(state, 'p1', exiled, 'exile');
			assert.equal(exileOpts.some((o) => o.id === 'exile:foretell'), true);

			const handBefore = p1.hand.length;
			const lifeBefore = p1.life;
			const castRes = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: exiled.instanceId,
				fromZone: 'exile',
				optionId: 'exile:foretell'
			});
			assert.equal(castRes.ok, true);
			assert.equal(state.stack[state.stack.length - 1].isFaceDown, undefined);
			resolveAllStack(state);
			assert.equal(p1.hand.length, handBefore + 2);
			assert.equal(p1.life, lifeBefore + 3);
		});

		it('reveals face-down foretold cards in exile at end of game and when owner leaves the game (CR 702.143f)', () => {
			// 1) Opponent concedes -> game ends -> p1's face-down foretold card in exile is turned face up and logged
			const { state, p1 } = setupMain1Game();
			const card = synthCard({
				name: 'Hidden Doom',
				manaCost: '{3}{B}{B}',
				cmc: 5,
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.\nForetell—{1}{B}, Pay 2 life.'
			});
			assert.equal(compileCard(card).fullySupported, true);
			const inst = addCardToZone(state, p1, card, 'hand');
			p1.manaPool.C = 2;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'hand_special_action',
					instanceId: inst.instanceId,
					actionId: 'special:foretell'
				}).ok,
				true
			);
			assert.equal(p1.exile[0].isFaceDown, true);

			assert.equal(applyGameAction(state, 'p2', { type: 'concede' }).ok, true);
			assert.equal(p1.exile[0].isFaceDown, false);
			assert.equal(
				state.log.some((e) => e.text.includes('CR 702.143f') && e.text.includes('Hidden Doom')),
				true
			);

			// 2) Foretelling player concedes -> CR 702.143f reveals the card before CR 800.4a removes their exile
			const { state: s2, p1: q1 } = setupMain1Game();
			const inst2 = addCardToZone(s2, q1, card, 'hand');
			q1.manaPool.C = 2;
			assert.equal(
				applyGameAction(s2, 'p1', {
					type: 'hand_special_action',
					instanceId: inst2.instanceId,
					actionId: 'special:foretell'
				}).ok,
				true
			);
			assert.equal(applyGameAction(s2, 'p1', { type: 'concede' }).ok, true);
			assert.equal(
				s2.log.some((e) => e.text.includes('CR 702.143f') && e.text.includes('Hidden Doom')),
				true
			);
		});
	});

	describe('Plot (CR 702.170, CR 116.2k)', () => {
		it('exiles face up at sorcery speed (including dash costs with mid-prompt JSON round-trip) and casts for {0} at sorcery speed on a later turn', () => {
			const { state, p1, p2 } = setupMain1Game();

			const plotInstant = synthCard({
				name: 'Outlaw Ambush',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Draw two cards.\nPlot—{1}{R}, Discard a card.',
				colors: ['R'],
				colorIdentity: ['R']
			});
			const plotWatcher = synthCard({
				name: 'Frontier Planner',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Human Scout',
				oracleText: 'Whenever you plot a card, you gain 2 life.',
				power: '2',
				toughness: '2'
			});
			const discardOptA = synthCard({ name: 'Spare Bolt A', manaCost: '{R}', typeLine: 'Instant', oracleText: 'Draw a card.' });
			const discardOptB = synthCard({ name: 'Spare Bolt B', manaCost: '{R}', typeLine: 'Instant', oracleText: 'Draw a card.' });

			assert.equal(compileCard(plotInstant).fullySupported, true);
			assert.equal(compileCard(plotWatcher).fullySupported, true);

			addCardToZone(state, p1, plotWatcher, 'battlefield');
			const plotInst = addCardToZone(state, p1, plotInstant, 'hand');

			// With no other cards in hand, Plot—{1}{R}, Discard a card cannot discard itself!
			p1.manaPool.R = 1;
			p1.manaPool.C = 1;
			assert.equal(checkHandSpecialActionLegality(state, 'p1', plotInst, 'special:plot').ok, false);

			const optA = addCardToZone(state, p1, discardOptA, 'hand');
			const optB = addCardToZone(state, p1, discardOptB, 'hand');

			// Plot is sorcery-speed only: illegal in upkeep or on opponent's turn
			state.phase = 'upkeep';
			assert.equal(checkHandSpecialActionLegality(state, 'p1', plotInst, 'special:plot').ok, false);
			state.phase = 'main1';
			assert.equal(checkHandSpecialActionLegality(state, 'p1', plotInst, 'special:plot').ok, true);

			// Human receives a cost_choice prompt to choose which other card to discard
			const plotStart = applyGameAction(state, 'p1', {
				type: 'hand_special_action',
				instanceId: plotInst.instanceId,
				actionId: 'special:plot'
			});
			assert.equal(plotStart.ok, true);
			assert.equal(state.pendingPrompts.length, 1);
			const prompt = state.pendingPrompts[0];
			assert.equal(prompt.choice?.kind, 'chooseObjects');
			if (prompt.choice?.kind === 'chooseObjects') {
				assert.equal(prompt.choice.candidates.includes(plotInst.instanceId), false);
				assert.equal(prompt.choice.candidates.includes(optA.instanceId), true);
				assert.equal(prompt.choice.candidates.includes(optB.instanceId), true);
			}

			// Round-trip GameState through JSON mid-prompt
			const resumed = roundTripState(state);
			const answerRes = applyGameAction(resumed, 'p1', {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: [optA.instanceId] }
			});
			assert.equal(answerRes.ok, true);
			const rp1 = resumed.players[0];
			assert.equal(rp1.exile.length, 1);
			const plotted = rp1.exile[0];
			assert.equal(Boolean(plotted.isFaceDown), false);
			assert.equal(plotted.plottedByPlayerId, 'p1');
			assert.equal(plotted.plottedTurnNumber, 1);

			// Face-up in exile: opponent can see card name
			const oppView = sanitizeGameStateForViewer(resumed, 'p2');
			assert.equal(oppView.players[0].exile[0].card.name, 'Outlaw Ambush');
			void p2;

			// Plot trigger resolves (+2 life)
			resolveAllStack(resumed);
			assert.equal(rp1.life, 42);

			// Cannot cast plotted card on turn 1
			assert.equal(getCastOptions(resumed, 'p1', plotted, 'exile').length, 0);

			// On turn 2, even though Outlaw Ambush is an Instant, CR 702.170d restricts 'exile:plot' to sorcery timing!
			resumed.turnNumber = 2;
			resumed.phase = 'upkeep';
			assert.equal(
				checkSpellCastLegality(resumed, 'p1', plotted, 'exile', 0, 'exile:plot').ok,
				false
			);

			resumed.phase = 'main1';
			assert.equal(
				checkSpellCastLegality(resumed, 'p1', plotted, 'exile', 0, 'exile:plot').ok,
				true
			);
			const handBefore = rp1.hand.length;
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'cast_spell',
					instanceId: plotted.instanceId,
					fromZone: 'exile',
					optionId: 'exile:plot'
				}).ok,
				true
			);
			resolveAllStack(resumed);
			assert.equal(rp1.hand.length, handBefore + 2);
		});
	});

	describe('Saddle (CR 702.171)', () => {
		it('activates only as a sorcery using other creatures with total power >= N, pauses for subset selection, enables saddled statics/triggers, and resets at cleanup', () => {
			const { state, p1 } = setupMain1Game();

			const mountCard = synthCard({
				name: 'Sunmane Steed',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Creature — Horse Mount',
				oracleText:
					'As long as this Mount is saddled, it gets +2/+2 and has flying.\nWhenever this Mount becomes saddled, you gain 2 life.\nWhenever ~ attacks while saddled, draw a card.\nSaddle 3',
				power: '3',
				toughness: '3',
				colors: ['W']
			});
			const rider2a = synthCard({
				name: 'Rider Alpha',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Knight',
				oracleText: '',
				power: '2',
				toughness: '2'
			});
			const rider2b = synthCard({
				name: 'Rider Beta',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Scout',
				oracleText: '',
				power: '2',
				toughness: '2'
			});
			const rider2c = synthCard({
				name: 'Rider Gamma',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Soldier',
				oracleText: '',
				power: '2',
				toughness: '2'
			});

			assert.equal(compileCard(mountCard).fullySupported, true);

			const mount = addCardToZone(state, p1, mountCard, 'battlefield', false);
			const abilities = getEffectiveActivatedAbilities(state, p1, mount, []);
			const saddleAb = abilities.find((a) => a.costKeyword === 'saddle');
			assert.ok(saddleAb, 'Expected Saddle activated ability');
			assert.equal(saddleAb.sorcerySpeedOnly, true);

			// Mount alone has power 3, but Saddle excludes self ("any number of other untapped creatures you control")
			assert.equal(checkAbilityActivationLegality(state, 'p1', mount, saddleAb).ok, false);

			// Add summoning-sick riders (CR 302.6 allows tapping summoning-sick creatures for non-{T} Saddle cost)
			const rA = addCardToZone(state, p1, rider2a, 'battlefield', true);
			assert.equal(checkAbilityActivationLegality(state, 'p1', mount, saddleAb).ok, false);

			const rB = addCardToZone(state, p1, rider2b, 'battlefield', true);
			const rC = addCardToZone(state, p1, rider2c, 'battlefield', true);

			// Illegal outside main phase (CR 702.171b: Activate only as a sorcery)
			state.phase = 'begin_combat';
			assert.equal(checkAbilityActivationLegality(state, 'p1', mount, saddleAb).ok, false);
			state.phase = 'main1';
			assert.equal(checkAbilityActivationLegality(state, 'p1', mount, saddleAb).ok, true);

			// With 3 riders of power 2 (total 6 >= 3, multiple valid subsets), human gets a cost_choice prompt
			const actRes = applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: mount.instanceId,
				abilityId: saddleAb.id
			});
			assert.equal(actRes.ok, true);
			assert.equal(state.pendingPrompts.length, 1);

			const resumed = roundTripState(state);
			const prm = resumed.pendingPrompts[0];
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [rA.instanceId, rB.instanceId] }
				}).ok,
				true
			);
			const rp1 = resumed.players[0];
			const rMount = rp1.battlefield.find((c) => c.instanceId === mount.instanceId)!;
			assert.equal(rp1.battlefield.find((c) => c.instanceId === rA.instanceId)!.tapped, true);
			assert.equal(rp1.battlefield.find((c) => c.instanceId === rB.instanceId)!.tapped, true);
			assert.equal(rp1.battlefield.find((c) => c.instanceId === rC.instanceId)!.tapped, false);

			// Resolve Saddle ability + "Whenever ~ becomes saddled" trigger
			resolveAllStack(resumed);
			assert.equal(rMount.saddledThisTurn, true);
			assert.deepEqual(rMount.saddledThisTurnByIds, [rA.instanceId, rB.instanceId]);
			assert.equal(rp1.life, 42);

			const evalSaddled = evaluatePermanent(resumed, rMount);
			assert.equal(evalSaddled.power, 5);
			assert.equal(evalSaddled.toughness, 5);
			assert.equal(hasKeyword(rMount, 'Flying', resumed), true);

			// Advance to declare_attackers and attack with saddled Mount -> draws a card!
			resumed.phase = 'declare_attackers';
			resumed.combat.awaitingAttackersDeclaration = true;
			const handBeforeAtk = rp1.hand.length;
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: rMount.instanceId, defenderPlayerId: 'p2' }]
				}).ok,
				true
			);
			resolveAllStack(resumed);
			assert.equal(rp1.hand.length, handBeforeAtk + 1);

			// Advance to cleanup / next turn: saddled designation clears
			resumed.phase = 'end_step';
			resumed.combat.active = false;
			resumed.combat.attackers = [];
			resumed.passedPriorityPlayerIds = ['p1'];
			resumed.priorityPlayerIndex = 1;
			assert.equal(applyGameAction(resumed, 'p2', { type: 'pass_priority' }).ok, true);
			assert.equal(rMount.saddledThisTurn, undefined);
			assert.equal(evaluatePermanent(resumed, rMount).power, 3);
		});
	});

	describe('Entwine (CR 702.42)', () => {
		it('chooses 1 mode normally or all modes in printed order when entwined (including multi-mode targets and dash costs)', () => {
			const { state, p1, p2 } = setupMain1Game();

			const entwineSpell = synthCard({
				name: 'Twin Verdict',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					'Choose one —\n• ~ deals 3 damage to target creature.\n• Target player draws a card.\nEntwine—Sacrifice a land.',
				colors: ['R']
			});
			const mountain = synthCard({
				name: 'Mountain',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Mountain',
				oracleText: '({T}: Add {R}.)'
			});
			const plains = synthCard({
				name: 'Plains',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Plains',
				oracleText: '({T}: Add {W}.)'
			});
			const bear = synthCard({
				name: 'Grizzly Victim',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				oracleText: '',
				power: '2',
				toughness: '4'
			});

			assert.equal(compileCard(entwineSpell).fullySupported, true);

			// 1) Without Entwine: cannot choose both modes [0, 1]
			const spellA = addCardToZone(state, p1, entwineSpell, 'hand');
			p1.manaPool.R = 1;
			p1.manaPool.C = 1;
			const bearInst = addCardToZone(state, p2, bear, 'battlefield');

			const badBoth = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: spellA.instanceId,
				fromZone: 'hand',
				modes: [0, 1],
				targets: [
					{ kind: 'permanent', id: bearInst.instanceId, label: bearInst.card.name },
					{ kind: 'player', id: 'p1', label: 'Alice' }
				]
			});
			assert.equal(badBoth.ok, false);

			// 2) With Entwine paid (Sacrifice a land — 2 lands on board so human gets cost_choice prompt):
			const land1 = addCardToZone(state, p1, mountain, 'battlefield');
			const land2 = addCardToZone(state, p1, plains, 'battlefield');
			const opts = getCastOptions(state, 'p1', spellA, 'hand');
			const entwineOpt = opts[0].optionalAdditionalCosts?.find((oc) => oc.chooseAllModes);
			assert.ok(entwineOpt, 'Expected Entwine optional cost with chooseAllModes: true');

			const castEntwined = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: spellA.instanceId,
				fromZone: 'hand',
				optionId: opts[0].id,
				optionalCostCounts: { [entwineOpt.id]: 1 },
				targets: [
					{ kind: 'permanent', id: bearInst.instanceId, label: bearInst.card.name },
					{ kind: 'player', id: 'p1', label: 'Alice' }
				]
			});
			assert.equal(castEntwined.ok, true);
			assert.equal(state.pendingPrompts.length, 1);

			// JSON round-trip mid-cost-choice prompt
			const resumed = roundTripState(state);
			const prm = resumed.pendingPrompts[0];
			const rp1 = resumed.players[0];
			const rp2 = resumed.players[1];
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [land1.instanceId] }
				}).ok,
				true
			);
			assert.equal(rp1.battlefield.some((c) => c.instanceId === land1.instanceId), false);
			assert.equal(rp1.battlefield.some((c) => c.instanceId === land2.instanceId), true);
			assert.equal(rp1.hand.length, 0);
			assert.deepEqual(resumed.stack[0].chosenModes, [0, 1]);

			resolveAllStack(resumed);
			assert.equal(rp2.battlefield.find((c) => c.instanceId === bearInst.instanceId)!.damageMarked, 3);
			assert.equal(rp1.hand.length, 1);
		});
	});

	describe('Disturb (CR 702.146, CR 712.8c)', () => {
		it('casts Creature->Creature and Creature->Aura back faces from graveyard and exiles instead of going to graveyard from battlefield or stack', () => {
			const { state, p1 } = setupMain1Game();

			const disturbSpirit = synthCard({
				name: 'Chapel Initiate',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Cleric',
				oracleText: 'Lifelink\nDisturb {2}{W}',
				power: '2',
				toughness: '1',
				colors: ['W'],
				layout: 'transform',
				backFace: {
					name: 'Blessed Apparition',
					manaCost: '',
					typeLine: 'Creature — Spirit Cleric',
					oracleText:
						'Flying, lifelink\nIf Blessed Apparition would be put into a graveyard from anywhere, exile it instead.',
					power: '2',
					toughness: '2',
					imageUrl: ''
				}
			});
			const disturbAura = synthCard({
				name: 'Lantern Bearer Probe',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Creature — Spirit',
				oracleText: 'Flying\nDisturb {2}{U}',
				power: '1',
				toughness: '1',
				colors: ['U'],
				layout: 'transform',
				backFace: {
					name: 'Lanterns Lift',
					manaCost: '',
					typeLine: 'Enchantment — Aura',
					oracleText:
						'Enchant creature\nEnchanted creature gets +1/+1 and has flying.\nIf Lanterns Lift would be put into a graveyard from anywhere, exile it instead.',
					imageUrl: ''
				}
			});
			const hostBear = synthCard({
				name: 'Host Squire',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human',
				oracleText: '',
				power: '2',
				toughness: '2'
			});
			const killSpell = synthCard({
				name: 'Fell Strike',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			});
			const counterSpell = synthCard({
				name: 'Hard Deny',
				manaCost: '{1}{U}{U}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Counter target spell.'
			});

			assert.equal(compileCard(disturbSpirit).fullySupported, true);
			assert.equal(compileCard(disturbAura).fullySupported, true);

			// 1) Cast disturbSpirit from graveyard -> enters transformed as 2/2 Flying Lifelink Spirit; when destroyed, exiled instead of graveyard!
			const spiritGy = addCardToZone(state, p1, disturbSpirit, 'graveyard');
			p1.manaPool.W = 1;
			p1.manaPool.C = 2;
			const gyOpts = getCastOptions(state, 'p1', spiritGy, 'graveyard');
			assert.equal(gyOpts.some((o) => o.id === 'alt:disturb'), true);

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: spiritGy.instanceId,
					fromZone: 'graveyard',
					optionId: 'alt:disturb'
				}).ok,
				true
			);
			resolveAllStack(state);
			const spiritPerm = p1.battlefield.find((c) => c.instanceId === spiritGy.instanceId)!;
			assert.ok(spiritPerm);
			assert.equal(spiritPerm.transformed, true);
			assert.equal(spiritPerm.activeFaceIndex, 1);
			const spiritEval = evaluatePermanent(state, spiritPerm);
			assert.equal(spiritEval.power, 2);
			assert.equal(spiritEval.toughness, 2);
			assert.equal(hasKeyword(spiritPerm, 'Flying', state), true);

			// Destroy the transformed Spirit -> back-face replacement exiles it instead of graveyard!
			const killInst = addCardToZone(state, p1, killSpell, 'hand');
			p1.manaPool.B = 1;
			p1.manaPool.C = 1;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: killInst.instanceId,
					fromZone: 'hand',
					targets: [{ kind: 'permanent', id: spiritPerm.instanceId, label: 'Blessed Apparition' }]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.exile.some((c) => c.instanceId === spiritGy.instanceId), true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === spiritGy.instanceId), false);

			// 2) Cast disturbAura from graveyard targeting Host Squire -> countered on stack -> STILL exiled instead of graveyard (CR 712.8c)!
			const host = addCardToZone(state, p1, hostBear, 'battlefield');
			const auraGy = addCardToZone(state, p1, disturbAura, 'graveyard');
			const counterInst = addCardToZone(state, p1, counterSpell, 'hand');
			p1.manaPool.U = 3;
			p1.manaPool.C = 3;

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: auraGy.instanceId,
					fromZone: 'graveyard',
					optionId: 'alt:disturb',
					targets: [{ kind: 'permanent', id: host.instanceId, label: host.card.name }]
				}).ok,
				true
			);
			const auraStkId = state.stack[0].id;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: counterInst.instanceId,
					fromZone: 'hand',
					targets: [{ kind: 'stack', id: auraStkId, label: 'Lanterns Lift' }]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.exile.some((c) => c.instanceId === auraGy.instanceId), true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === auraGy.instanceId), false);
		});
	});

	describe('Blitz (CR 702.152)', () => {
		it('grants Layer 6 haste (removable by later ability-removal), fires dies draw trigger, sacrifices at end step, and clears on flicker (CR 400.7)', () => {
			const { state, p1 } = setupMain1Game();

			const blitzBruiser = synthCard({
				name: 'Riveteers Bruiser',
				manaCost: '{3}{R}',
				cmc: 4,
				typeLine: 'Creature — Ogre Warrior',
				oracleText: 'When ~ enters, if its blitz cost was paid, you gain 2 life.\nBlitz {1}{R}',
				power: '4',
				toughness: '3',
				colors: ['R']
			});
			const humilityEnchant = synthCard({
				name: 'Blanket Silence',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText: 'Creatures lose all abilities.',
				colors: ['W']
			});
			const flickerInstant = synthCard({
				name: 'Cloud Blink',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Exile target creature you control, then return that card to the battlefield under your control.'
			});

			assert.equal(compileCard(blitzBruiser).fullySupported, true);

			// 1) Cast via Blitz -> gains haste, fires "if its blitz cost was paid" ETB (+2 life), sacrifices at end step, and draws a card!
			const bruiser1 = addCardToZone(state, p1, blitzBruiser, 'hand');
			p1.manaPool.R = 1;
			p1.manaPool.C = 1;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: bruiser1.instanceId,
					fromZone: 'hand',
					optionId: 'alt:blitz'
				}).ok,
				true
			);
			resolveAllStack(state);

			const perm1 = p1.battlefield.find((c) => c.instanceId === bruiser1.instanceId)!;
			assert.equal(perm1.blitzed, true);
			assert.equal(p1.life, 42);
			assert.equal(hasKeyword(perm1, 'Haste', state), true);

			// Verify later-timestamp Layer 6 ability removal removes Blitz-granted haste (CR 613.7)
			const hum = addCardToZone(state, p1, humilityEnchant, 'battlefield');
			assert.equal(hasKeyword(perm1, 'Haste', state), false);
			p1.battlefield = p1.battlefield.filter((c) => c.instanceId !== hum.instanceId);
			assert.equal(hasKeyword(perm1, 'Haste', state), true);

			// Enter end_step -> Blitz sacrifice delayed trigger goes on stack and resolves -> dies trigger draws 1 card!
			const handBeforeEnd = p1.hand.length;
			state.phase = 'main2';
			state.passedPriorityPlayerIds = ['p1'];
			state.priorityPlayerIndex = 1;
			assert.equal(applyGameAction(state, 'p2', { type: 'pass_priority' }).ok, true);
			assert.equal(state.phase, 'end_step');
			resolveAllStack(state);
			assert.equal(p1.graveyard.some((c) => c.instanceId === bruiser1.instanceId), true);
			assert.equal(p1.hand.length, handBeforeEnd + 1);

			// 2) Flickering a blitzed creature (CR 400.7) clears blitzed and causes the delayed end-step sacrifice to fizzle
			state.phase = 'main1';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			state.passedPriorityPlayerIds = [];
			const bruiser2 = addCardToZone(state, p1, blitzBruiser, 'hand');
			const blink = addCardToZone(state, p1, flickerInstant, 'hand');
			p1.manaPool.R = 1;
			p1.manaPool.W = 1;
			p1.manaPool.C = 1;

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: bruiser2.instanceId,
					fromZone: 'hand',
					optionId: 'alt:blitz'
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: blink.instanceId,
					fromZone: 'hand',
					targets: [{ kind: 'permanent', id: bruiser2.instanceId, label: blitzBruiser.name }]
				}).ok,
				true
			);
			resolveAllStack(state);
			const flickered = p1.battlefield.find((c) => c.instanceId === bruiser2.instanceId)!;
			assert.equal(flickered.blitzed, undefined);

			state.phase = 'main2';
			state.passedPriorityPlayerIds = ['p1'];
			state.priorityPlayerIndex = 1;
			assert.equal(applyGameAction(state, 'p2', { type: 'pass_priority' }).ok, true);
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === bruiser2.instanceId), true);
		});
	});

	describe('Retrace (CR 702.81)', () => {
		it('casts from graveyard by discarding a land card (with mid-prompt JSON round-trip) and returns to graveyard for repeat casts', () => {
			const { state, p1 } = setupMain1Game();

			const retraceSpell = synthCard({
				name: 'Syphon Jab',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Target player loses 2 life and you gain 2 life.\nRetrace',
				colors: ['B']
			});
			const swampA = synthCard({ name: 'Swamp A', manaCost: '', cmc: 0, typeLine: 'Basic Land — Swamp', oracleText: '' });
			const swampB = synthCard({ name: 'Swamp B', manaCost: '', cmc: 0, typeLine: 'Basic Land — Swamp', oracleText: '' });
			const nonLand = synthCard({ name: 'Dark Relic', manaCost: '{1}', cmc: 1, typeLine: 'Artifact', oracleText: '' });

			assert.equal(compileCard(retraceSpell).fullySupported, true);

			const gySpell = addCardToZone(state, p1, retraceSpell, 'graveyard');
			addCardToZone(state, p1, nonLand, 'hand');
			p1.manaPool.B = 2;

			// Non-land card in hand cannot satisfy Retrace's "Discard a land card"
			assert.equal(
				checkSpellCastLegality(state, 'p1', gySpell, 'graveyard', 0, 'graveyard:retrace').ok,
				false
			);

			const landA = addCardToZone(state, p1, swampA, 'hand');
			const landB = addCardToZone(state, p1, swampB, 'hand');
			assert.equal(
				checkSpellCastLegality(state, 'p1', gySpell, 'graveyard', 0, 'graveyard:retrace').ok,
				true
			);

			// Cast #1 with 2 lands in hand -> prompts human to choose which land to discard
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: gySpell.instanceId,
					fromZone: 'graveyard',
					optionId: 'graveyard:retrace',
					targets: [{ kind: 'player', id: 'p2', label: 'Bob' }]
				}).ok,
				true
			);
			assert.equal(state.pendingPrompts.length, 1);

			const resumed = roundTripState(state);
			const prm = resumed.pendingPrompts[0];
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [landA.instanceId] }
				}).ok,
				true
			);
			resolveAllStack(resumed);

			const rp1 = resumed.players[0];
			const rp2 = resumed.players[1];
			assert.equal(rp1.life, 42);
			assert.equal(rp2.life, 38);
			// Retrace spell returns to graveyard (NOT exiled!) and can be cast again using Swamp B!
			const gyAgain = rp1.graveyard.find((c) => c.instanceId === gySpell.instanceId)!;
			assert.ok(gyAgain);

			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'cast_spell',
					instanceId: gyAgain.instanceId,
					fromZone: 'graveyard',
					optionId: 'graveyard:retrace',
					targets: [{ kind: 'player', id: 'p2', label: 'Bob' }]
				}).ok,
				true
			);
			assert.equal(rp1.hand.some((c) => c.instanceId === landB.instanceId), false);
			resolveAllStack(resumed);
			assert.equal(rp1.life, 44);
			assert.equal(rp2.life, 36);
			assert.equal(rp1.graveyard.some((c) => c.instanceId === gySpell.instanceId), true);
		});
	});

	describe('Jump-start (CR 702.133)', () => {
		it('casts from graveyard by discarding any card (with mid-prompt JSON round-trip) and exiles on resolve or counter', () => {
			const { state, p1 } = setupMain1Game();

			const jumpSpell = synthCard({
				name: 'Radical Pulse',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Draw a card.\nJump-start',
				colors: ['U']
			});
			const discard1 = synthCard({ name: 'Scrap Tome', manaCost: '{1}', cmc: 1, typeLine: 'Artifact', oracleText: '' });
			const discard2 = synthCard({ name: 'Scrap Cog', manaCost: '{1}', cmc: 1, typeLine: 'Artifact', oracleText: '' });
			const counterSpell = synthCard({
				name: 'Syncopate Probe',
				manaCost: '{1}{U}{U}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Counter target spell.'
			});

			assert.equal(compileCard(jumpSpell).fullySupported, true);

			// 1) Resolve path -> exiled after resolving
			const js1 = addCardToZone(state, p1, jumpSpell, 'graveyard');
			const d1 = addCardToZone(state, p1, discard1, 'hand');
			const d2 = addCardToZone(state, p1, discard2, 'hand');
			p1.manaPool.U = 1;
			p1.manaPool.C = 1;

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: js1.instanceId,
					fromZone: 'graveyard',
					optionId: 'graveyard:jumpstart'
				}).ok,
				true
			);
			assert.equal(state.pendingPrompts.length, 1);

			const resumed = roundTripState(state);
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'choice',
					promptId: resumed.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [d1.instanceId] }
				}).ok,
				true
			);
			resolveAllStack(resumed);
			const rp1 = resumed.players[0];
			assert.equal(rp1.exile.some((c) => c.instanceId === js1.instanceId), true);
			assert.equal(rp1.graveyard.some((c) => c.instanceId === js1.instanceId), false);

			// 2) Countered path -> STILL exiled when leaving the stack (CR 702.133a)
			const js2 = addCardToZone(resumed, rp1, jumpSpell, 'graveyard');
			const counterInst = addCardToZone(resumed, rp1, counterSpell, 'hand');
			rp1.manaPool.U = 3;
			rp1.manaPool.C = 2;
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'cast_spell',
					instanceId: js2.instanceId,
					fromZone: 'graveyard',
					optionId: 'graveyard:jumpstart',
					costPayment: { objects: [[d2.instanceId]] }
				}).ok,
				true
			);
			const stkId = resumed.stack[0].id;
			assert.equal(
				applyGameAction(resumed, 'p1', {
					type: 'cast_spell',
					instanceId: counterInst.instanceId,
					fromZone: 'hand',
					targets: [{ kind: 'stack', id: stkId, label: jumpSpell.name }]
				}).ok,
				true
			);
			resolveAllStack(resumed);
			assert.equal(rp1.exile.some((c) => c.instanceId === js2.instanceId), true);
			assert.equal(rp1.graveyard.some((c) => c.instanceId === js2.instanceId), false);
		});
	});

	describe('Cumulative upkeep (CR 702.24)', () => {
		it('places an age counter each upkeep, scales payment by age counters (with mid-prompt JSON round-trip), sacrifices on decline, handles 0 age counters, and marks snow {S} unsupported', () => {
			const { state, p1 } = setupMain1Game();

			const cumUpkeepPerm = synthCard({
				name: 'Glacial Wall Probe',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Creature — Wall',
				oracleText: 'Defender\nCumulative upkeep—Pay 2 life.',
				power: '0',
				toughness: '7',
				colors: ['U']
			});
			const snowUpkeep = synthCard({
				name: 'Rimebound Relic',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Cumulative upkeep {S}'
			});
			const solemnityLock = synthCard({
				name: 'Stasis Halo',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: "Counters can't be put on creatures."
			});

			assert.equal(compileCard(cumUpkeepPerm).fullySupported, true);
			assert.equal(compileCard(solemnityLock).fullySupported, true);
			// --- Track P11: Snow mana {S} is now implemented (CR 107.4h); unimplemented mana symbols stay unsupported ---
			assert.equal(compileCard(snowUpkeep).fullySupported, true);
			const unparsedUpkeep = synthCard({
				name: 'Voidbound Relic',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Cumulative upkeep—Flip a coin.'
			});
			assert.equal(compileCard(unparsedUpkeep).fullySupported, false);
			// --- End Track P11 ---

			const wall = addCardToZone(state, p1, cumUpkeepPerm, 'battlefield');

			// Advance p1 main2 -> end_step -> p2 turn -> back to p1's upkeep #1:
			// Faster & exact: jump to p2 end_step and pass priority into p1's next turn (untap -> upkeep)!
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 0;
			state.phase = 'end_step';
			state.passedPriorityPlayerIds = ['p2'];
			assert.equal(applyGameAction(state, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(state.phase, 'upkeep');
			assert.equal(state.stack.length, 1);

			// Resolve Cumulative upkeep trigger #1 -> puts 1st age counter & prompts yesNo ("Pay 2 life")
			assert.equal(applyGameAction(state, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, 'p2', { type: 'pass_priority' }).ok, true);
			assert.equal(wall.counters.age, 1);
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(state.pendingPrompts[0].choice?.kind, 'yesNo');

			// Round-trip mid-yesNo prompt and accept (pays 2 life -> 38 life)
			const resumed1 = roundTripState(state);
			assert.equal(
				applyGameAction(resumed1, 'p1', {
					type: 'choice',
					promptId: resumed1.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			assert.equal(resumed1.players[0].life, 38);
			assert.equal(
				resumed1.players[0].battlefield.some((c) => c.instanceId === wall.instanceId),
				true
			);

			// Next p1 upkeep (#2): age counter becomes 2 -> scales cost to 4 life!
			resumed1.activePlayerIndex = 1;
			resumed1.priorityPlayerIndex = 0;
			resumed1.phase = 'end_step';
			resumed1.passedPriorityPlayerIds = ['p2'];
			assert.equal(applyGameAction(resumed1, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(resumed1.phase, 'upkeep');
			assert.equal(applyGameAction(resumed1, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(resumed1, 'p2', { type: 'pass_priority' }).ok, true);

			const wall2 = resumed1.players[0].battlefield.find((c) => c.instanceId === wall.instanceId)!;
			assert.equal(wall2.counters.age, 2);
			assert.equal(resumed1.pendingPrompts.length, 1);

			// Pay 4 life -> life goes 38 -> 34
			assert.equal(
				applyGameAction(resumed1, 'p1', {
					type: 'choice',
					promptId: resumed1.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			assert.equal(resumed1.players[0].life, 34);

			// Next p1 upkeep (#3): decline payment -> permanent is sacrificed!
			resumed1.activePlayerIndex = 1;
			resumed1.priorityPlayerIndex = 0;
			resumed1.phase = 'end_step';
			resumed1.passedPriorityPlayerIds = ['p2'];
			assert.equal(applyGameAction(resumed1, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(resumed1, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(resumed1, 'p2', { type: 'pass_priority' }).ok, true);
			assert.equal(
				applyGameAction(resumed1, 'p1', {
					type: 'choice',
					promptId: resumed1.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: false }
				}).ok,
				true
			);
			assert.equal(resumed1.players[0].life, 34);
			assert.equal(
				resumed1.players[0].graveyard.some((c) => c.instanceId === wall.instanceId),
				true
			);

			// 0 age counters case (Stasis Halo prevents age counter): controller can pay {0} to keep it!
			const freshWall = addCardToZone(resumed1, resumed1.players[0], cumUpkeepPerm, 'battlefield');
			addCardToZone(resumed1, resumed1.players[0], solemnityLock, 'battlefield');
			resumed1.activePlayerIndex = 1;
			resumed1.priorityPlayerIndex = 0;
			resumed1.phase = 'end_step';
			resumed1.passedPriorityPlayerIds = ['p2'];
			assert.equal(applyGameAction(resumed1, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(resumed1, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(resumed1, 'p2', { type: 'pass_priority' }).ok, true);
			assert.equal(freshWall.counters.age, 0);
			assert.equal(resumed1.pendingPrompts.length, 1);
			assert.equal(
				applyGameAction(resumed1, 'p1', {
					type: 'choice',
					promptId: resumed1.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			assert.equal(resumed1.players[0].life, 34);
			assert.equal(
				resumed1.players[0].battlefield.some((c) => c.instanceId === freshWall.instanceId),
				true
			);
		});
	});

	describe('Synthetic Rename Invariance (ENGINE_INVARIANTS.md §1.3)', () => {
		it('produces identical compiled IR (modulo name/hash) for canonical vs invented names across Track P3 keywords', () => {
			const pairs: Array<[ScryfallCard, ScryfallCard]> = [
				[
					synthCard({
						name: 'Saw It Coming',
						manaCost: '{1}{U}{U}',
						typeLine: 'Instant',
						oracleText: 'Counter target spell.\nForetell {1}{U}'
					}),
					synthCard({
						name: 'Glimmerfen Denial',
						manaCost: '{1}{U}{U}',
						typeLine: 'Instant',
						oracleText: 'Counter target spell.\nForetell {1}{U}'
					})
				],
				[
					synthCard({
						name: 'Slickshot Show-Off',
						manaCost: '{1}{R}',
						typeLine: 'Creature — Bird Wizard',
						oracleText: 'Flying, haste\nPlot {1}{R}',
						power: '1',
						toughness: '2'
					}),
					synthCard({
						name: 'Cinderwing Duelist',
						manaCost: '{1}{R}',
						typeLine: 'Creature — Bird Wizard',
						oracleText: 'Flying, haste\nPlot {1}{R}',
						power: '1',
						toughness: '2'
					})
				],
				[
					synthCard({
						name: 'Caustic Bronco',
						manaCost: '{1}{B}',
						typeLine: 'Creature — Snake Horse Mount',
						oracleText: 'Whenever Caustic Bronco attacks while saddled, draw a card.\nSaddle 3',
						power: '2',
						toughness: '2'
					}),
					synthCard({
						name: 'Mirefang Courser',
						manaCost: '{1}{B}',
						typeLine: 'Creature — Snake Horse Mount',
						oracleText: 'Whenever Mirefang Courser attacks while saddled, draw a card.\nSaddle 3',
						power: '2',
						toughness: '2'
					})
				],
				[
					synthCard({
						name: 'Tenacious Underdog',
						manaCost: '{1}{B}',
						typeLine: 'Creature — Human Warrior',
						oracleText: 'Blitz—{2}{B}{B}, Pay 2 life.',
						power: '3',
						toughness: '2'
					}),
					synthCard({
						name: 'Ashpit Challenger',
						manaCost: '{1}{B}',
						typeLine: 'Creature — Human Warrior',
						oracleText: 'Blitz—{2}{B}{B}, Pay 2 life.',
						power: '3',
						toughness: '2'
					})
				]
			];

			for (const [canonical, renamed] of pairs) {
				const defA = compileCard(canonical);
				const defB = compileCard(renamed);
				assert.equal(defA.fullySupported, true);
				assert.equal(defB.fullySupported, true);
				assert.deepEqual(
					defA.faces.map((f) => ({ ...f, name: '' })),
					defB.faces.map((f) => ({ ...f, name: '' }))
				);
			}
		});
	});
});
