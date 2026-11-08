import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	createEmptyManaPool,
	canPayManaCost,
	deductManaFromPool,
	detectTargetRequirement,
	getPermanentManaProduction,
	parseActivatedAbilities,
	parseAdditionalCostsAndRestrictions,
	parseManaCost,
	parseSpellOrAbilityEffects
} from './oracle.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkLandPlayLegality,
	checkSpellCastLegality,
	checkStateBasedActions,
	collectActiveBoardHooks,
	computeCombatDamageForecast,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	evaluateActionNode,
	evaluatePermanent,
	getAllLegalTargetsForRequirement,
	getAttachedCardsOnBoard,
	getCardRuleTree,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	getHostCardOnBoard,
	getLibrarySearchInterceptor,
	getSpellCostRequirement,
	hasKeyword,
	hasProtectionFrom,
	hasRequiredLegalTargets,
	inspectCardContinuousBreakdown,
	matchesLibrarySearchSpec,
	parseLibrarySearchSpec,
	permanentHasLostAllAbilities,
	runBeginningOfTurn,
	sanitizeGameStateForViewer,
	validateChosenTargets,
	validateTargetLegality
} from './engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from './precons.ts';
import { validateCommanderDeck } from './scryfall.ts';
import { matchesScryfallQuery } from './search.ts';
import { computeBezierPath } from './vfx.ts';
import { runAutomatedPriorityAndBots } from './ai.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type ScryfallCard,
	type TargetRef
} from './types.ts';

function getCardByName(name: string): ScryfallCard | undefined {
	return STAPLE_CARDS[name.toLowerCase()];
}

function makeTestCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
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
		keywords: overrides.keywords ?? [],
		imageUrl: overrides.imageUrl ?? '',
		artCropUrl: overrides.artCropUrl ?? '',
		rarity: overrides.rarity ?? 'common',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false
	};
}

function createActiveTwoPlayerGame(): {
	state: GameState;
	p1Id: string;
	p2Id: string;
} {
	const p1Id = 'player_1';
	const p2Id = 'player_2';
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: p1Id,
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: PRECON_DECKS[0].id,
			deckName: PRECON_DECKS[0].name,
			commanderNames: PRECON_DECKS[0].commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[0].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		},
		{
			seatIndex: 1,
			userId: p2Id,
			username: 'Bob',
			avatarUrl: '',
			isBot: false,
			deckId: PRECON_DECKS[1].id,
			deckName: PRECON_DECKS[1].name,
			commanderNames: PRECON_DECKS[1].commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[1].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		}
	];

	const state = createInitialGameState(
		'LOBBY1',
		seats,
		new Map([
			[0, PRECON_DECKS[0]],
			[1, PRECON_DECKS[1]]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);

	// Both players keep opening hands to enter active main1
	assert.equal(state.status, 'mulligan');
	assert.equal(applyGameAction(state, p1Id, { type: 'mulligan_keep' }).ok, true);
	assert.equal(applyGameAction(state, p2Id, { type: 'mulligan_keep' }).ok, true);
	assert.equal(state.status, 'active');
	assert.equal(state.phase, 'main1');
	assert.equal(state.activePlayerIndex, 0);
	assert.equal(state.priorityPlayerIndex, 0);

	// Give both players ample mana by default for focused rule testing unless overridden
	state.players[0].manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	state.players[1].manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

	return { state, p1Id, p2Id };
}

function addCardToZone(
	state: GameState,
	playerId: string,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command' | 'library'
): CardInstance {
	const player = state.players.find((p) => p.playerId === playerId)!;
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(card, playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		if (card.typeLine.includes('Planeswalker') && card.loyalty) {
			inst.counters.loyalty = parseInt(card.loyalty, 10) || 3;
		}
	}
	player[zone].push(inst);
	return inst;
}

describe('1. Oracle Parser, Mana Cost Engine & Target Requirement Detection', () => {
	it('parses standard, X, multi-X, hybrid, Commander tax, and cost-reduced mana costs', () => {
		const simple = parseManaCost('{2}{U}{U}');
		assert.equal(simple.colored.U, 2);
		assert.equal(simple.generic, 2);
		assert.equal(simple.totalCmc, 4);

		const xSpell = parseManaCost('{X}{R}{R}', 5, 2, 1); // X=5, +2 tax, -1 reduction
		assert.equal(xSpell.hasX, true);
		assert.equal(xSpell.colored.R, 2);
		assert.equal(xSpell.generic, 6); // 2 + 5 - 1 = 6
		assert.equal(xSpell.totalCmc, 8);

		const hybrid = parseManaCost('{W/U}{B/G}{2}');
		assert.equal(hybrid.colored.W, 1);
		assert.equal(hybrid.colored.B, 1);
		assert.equal(hybrid.generic, 2);
	});

	it('validates and deducts mana pools spending colorless mana first for generic costs', () => {
		const pool = { W: 1, U: 2, B: 0, R: 0, G: 0, C: 2 };
		const req = parseManaCost('{2}{U}{U}');
		assert.equal(canPayManaCost(pool, req), true);

		const after = deductManaFromPool(pool, req);
		assert.equal(after.U, 0);
		assert.equal(after.C, 0); // Colorless spent first for {2} generic!
		assert.equal(after.W, 1); // White preserved!

		const insufficient = { W: 5, U: 1, B: 0, R: 0, G: 0, C: 0 };
		assert.equal(canPayManaCost(insufficient, req), false);
	});

	it('detects single-graveyard vs multi-graveyard target requirements accurately', () => {
		// "you may target two cards in a graveyard" -> sameGraveyard: true, minTargets: 2, maxTargets: 2
		const twoInSingleGrave = detectTargetRequirement(
			'Return two target cards in a graveyard to your hand.',
			'Sorcery'
		);
		assert.equal(twoInSingleGrave.requiresTarget, true);
		assert.equal(twoInSingleGrave.targetKind, 'graveyard_card');
		assert.equal(twoInSingleGrave.zone, 'graveyard');
		assert.equal(twoInSingleGrave.minTargets, 2);
		assert.equal(twoInSingleGrave.maxTargets, 2);
		assert.equal(twoInSingleGrave.sameGraveyard, true);

		const youMayTargetTwo = detectTargetRequirement(
			'You may target two cards in a graveyard.',
			'Sorcery'
		);
		assert.equal(youMayTargetTwo.requiresTarget, true);
		assert.equal(youMayTargetTwo.zone, 'graveyard');
		assert.equal(youMayTargetTwo.minTargets, 2);
		assert.equal(youMayTargetTwo.maxTargets, 2);
		assert.equal(youMayTargetTwo.sameGraveyard, true);

		// Plural "graveyards" -> sameGraveyard: false
		const pluralGraves = detectTargetRequirement(
			'Exile two target cards from graveyards.',
			'Instant'
		);
		assert.equal(pluralGraves.requiresTarget, true);
		assert.equal(pluralGraves.zone, 'graveyard');
		assert.equal(pluralGraves.minTargets, 2);
		assert.equal(pluralGraves.sameGraveyard, false);

		// "up to two target creature cards from your graveyard" -> minTargets: 0, maxTargets: 2
		const upToTwo = detectTargetRequirement(
			'Return up to two target creature cards from your graveyard to your hand.',
			'Sorcery'
		);
		assert.equal(upToTwo.requiresTarget, false);
		assert.equal(upToTwo.minTargets, 0);
		assert.equal(upToTwo.maxTargets, 2);
		assert.equal(upToTwo.controllerFilter, 'you');
		assert.equal(upToTwo.cardTypeFilter, 'Creature');
	});

	it('distinguishes permanent ETB text from Aura and Instant/Sorcery spell targeting', () => {
		// Mulldrifter / Ravenous Chupacabra creature spell on stack does not require targets to cast
		const chupacabra = detectTargetRequirement(
			'When Ravenous Chupacabra enters, destroy target creature an opponent controls.',
			'Creature — Beast Horror'
		);
		assert.equal(chupacabra.requiresTarget, false);

		// Aura spell DOES require a target on the stack
		const aura = detectTargetRequirement(
			'Enchant creature\nEnchanted creature gets +3/+3.',
			'Enchantment — Aura'
		);
		assert.equal(aura.requiresTarget, true);
		assert.equal(aura.targetKind, 'creature');
	});

	it('parses additional costs and timing restrictions from oracle text', () => {
		const villageRites = parseAdditionalCostsAndRestrictions(
			'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.'
		);
		assert.equal(villageRites.sacrificePermanentType, 'Creature');

		const thrill = parseAdditionalCostsAndRestrictions(
			'As an additional cost to cast this spell, discard a card.\nDraw two cards.'
		);
		assert.equal(thrill.discardCount, 1);

		const lifePay = parseAdditionalCostsAndRestrictions(
			'As an additional cost to cast this spell, pay 4 life.\nDestroy target creature.'
		);
		assert.equal(lifePay.lifeCost, 4);

		const combatOnly = parseAdditionalCostsAndRestrictions(
			'Cast this spell only during combat.\nDestroy target attacking creature.'
		);
		assert.equal(combatOnly.onlyDuringCombat, true);
	});
});

describe('2. Commander Deck Validation & Precon Integrity', () => {
	it('validates all 4 built-in Commander precon decks as 100% legal', () => {
		for (const deck of PRECON_DECKS) {
			const res = validateCommanderDeck(deck.commanders, deck.cards);
			assert.equal(res.isLegal, true, `Expected precon ${deck.name} to be legal: ${res.errors.join(', ')}`);
			assert.equal(res.totalCards, 100);
		}
	});

	it('rejects singleton violations, wrong deck sizes, and off-color cards (and allows Relentless Rats multiples)', () => {
		const baseDeck = structuredClone(PRECON_DECKS[0]);
		// Add a second Sol Ring and remove 1 basic land
		const solRing = getCardByName('Sol Ring')!;
		baseDeck.cards.push({ card: solRing, quantity: 1 });
		baseDeck.cards[baseDeck.cards.length - 2].quantity -= 1;

		const singletonRes = validateCommanderDeck(baseDeck.commanders, baseDeck.cards);
		assert.equal(singletonRes.isLegal, false);
		assert.ok(singletonRes.errors.some((e) => e.includes('Sol Ring')));

		// Test off-color card in Golgari deck (PRECON_DECKS[1] is Lathril BG, let's add Counterspell U)
		const bgDeck = structuredClone(PRECON_DECKS[1]);
		const counterspell = getCardByName('Counterspell')!;
		bgDeck.cards[0].card = counterspell;
		const colorRes = validateCommanderDeck(bgDeck.commanders, bgDeck.cards);
		assert.equal(colorRes.isLegal, false);
		assert.ok(colorRes.errors.some((e) => e.includes('Color identity violation')));
	});
});

describe('3. London Mulligan & Turn Initialization', () => {
	it('enforces London Mulligan with 1 free mulligan and exact bottom-card counts', () => {
		const p1Id = 'p1';
		const p2Id = 'p2';
		const seats: LobbySeat[] = [
			{
				seatIndex: 0,
				userId: p1Id,
				username: 'P1',
				avatarUrl: '',
				isBot: false,
				deckId: PRECON_DECKS[0].id,
				deckName: PRECON_DECKS[0].name,
				commanderNames: [PRECON_DECKS[0].commanders[0].name],
				commanderArtUrl: '',
				colorIdentity: PRECON_DECKS[0].colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: Date.now()
			},
			{
				seatIndex: 1,
				userId: p2Id,
				username: 'P2',
				avatarUrl: '',
				isBot: false,
				deckId: PRECON_DECKS[1].id,
				deckName: PRECON_DECKS[1].name,
				commanderNames: [PRECON_DECKS[1].commanders[0].name],
				commanderArtUrl: '',
				colorIdentity: PRECON_DECKS[1].colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: Date.now()
			}
		];

		const state = createInitialGameState(
			'MULL1',
			seats,
			new Map([
				[0, PRECON_DECKS[0]],
				[1, PRECON_DECKS[1]]
			]),
			{ ...DEFAULT_LOBBY_RULES }
		);
		assert.equal(state.status, 'mulligan');
		assert.equal(state.players[0].hand.length, 7);
		assert.equal(state.players[0].command.length, 1);

		// 1st mulligan is FREE
		assert.equal(applyGameAction(state, p1Id, { type: 'mulligan_take' }).ok, true);
		assert.equal(state.players[0].mulliganCount, 1);
		assert.equal(state.players[0].hand.length, 7);

		// 2nd mulligan requires putting 1 card on the bottom upon keep
		assert.equal(applyGameAction(state, p1Id, { type: 'mulligan_take' }).ok, true);
		assert.equal(state.players[0].mulliganCount, 2);
		assert.equal(applyGameAction(state, p1Id, { type: 'mulligan_keep' }).ok, true);

		// P1 must now have a london_bottom prompt requiring 1 card
		const londonPrompt = state.pendingPrompts.find(
			(p) => p.playerId === p1Id && p.kind === 'london_bottom'
		);
		assert.ok(londonPrompt);
		assert.equal(londonPrompt.countRequired, 1);

		// Submitting 0 cards or 2 cards is rejected
		assert.equal(
			applyGameAction(state, p1Id, { type: 'london_bottom', instanceIds: [] }).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'london_bottom',
				instanceIds: [state.players[0].hand[0].instanceId, state.players[0].hand[1].instanceId]
			}).ok,
			false
		);

		// Submitting exactly 1 card succeeds and puts it on the bottom of P1's library
		const bottomedId = state.players[0].hand[0].instanceId;
		assert.equal(
			applyGameAction(state, p1Id, { type: 'london_bottom', instanceIds: [bottomedId] }).ok,
			true
		);
		assert.equal(state.players[0].hand.length, 6);
		assert.equal(state.players[0].library.at(-1)?.instanceId, bottomedId);

		// Game still in mulligan until P2 keeps
		assert.equal(state.status, 'mulligan');
		assert.equal(applyGameAction(state, p2Id, { type: 'mulligan_keep' }).ok, true);
		assert.equal(state.status, 'active');
		assert.equal(state.phase, 'main1');
	});
});

describe('4. Prevent Casting / Playing Cards Without Valid Targets or When Illegal', () => {
	it('prevents casting Counterspell when nothing is on the stack, and allows it when a spell is on the stack', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const counterspell = addCardToZone(
			state,
			p1Id,
			getCardByName('Counterspell')!,
			'hand'
		);

		// Stack is empty -> Counterspell is illegal to cast!
		const emptyCheck = checkSpellCastLegality(state, p1Id, counterspell, 'hand');
		assert.equal(emptyCheck.ok, false);
		assert.match(emptyCheck.error || '', /Stack/i);

		const applyRes = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: counterspell.instanceId
		});
		assert.equal(applyRes.ok, false);

		// Now put a spell on the stack (e.g. Cultivate)
		const cultivate = addCardToZone(state, p1Id, getCardByName('Cultivate')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: cultivate.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 1);

		// Now Counterspell HAS a valid target on the stack!
		const validCheck = checkSpellCastLegality(state, p1Id, counterspell, 'hand');
		assert.equal(validCheck.ok, true);

		const counterCast = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: counterspell.instanceId,
			targets: [{ kind: 'stack', id: state.stack[0].id, label: 'Cultivate' }]
		});
		assert.equal(counterCast.ok, true);
		assert.equal(state.stack.length, 2);
	});

	it('prevents casting Negate / Fierce Guardianship when only a Creature spell is on the stack', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const negate = addCardToZone(state, p1Id, getCardByName('Negate')!, 'hand');
		const llanowar = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'hand');

		// Cast Llanowar Elves (a Creature spell) onto the stack
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: llanowar.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 1);

		// Negate requires "target noncreature spell" -> illegal when only Llanowar Elves is on stack!
		const check = checkSpellCastLegality(state, p1Id, negate, 'hand');
		assert.equal(check.ok, false);

		const badCast = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: negate.instanceId,
			targets: [{ kind: 'stack', id: state.stack[0].id, label: 'Llanowar Elves' }]
		});
		assert.equal(badCast.ok, false);
		assert.match(badCast.error || '', /noncreature|valid target/i);

		// Now cast an Instant spell onto the stack -> Negate becomes legal!
		const brainstorm = addCardToZone(state, p1Id, getCardByName('Brainstorm')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: brainstorm.instanceId }).ok,
			true
		);
		assert.equal(checkSpellCastLegality(state, p1Id, negate, 'hand').ok, true);
	});

	it('enforces single-graveyard multi-target rule ("you may target two cards in a graveyard")', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const twoInGraveSpell = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Soul Salvage Variant',
				manaCost: '{2}{B}',
				typeLine: 'Sorcery',
				oracleText: 'You may target two cards in a graveyard. Return them to your hand.'
			}),
			'hand'
		);

		// Case 1: Both graveyards empty -> cannot cast
		assert.equal(checkSpellCastLegality(state, p1Id, twoInGraveSpell, 'hand').ok, false);

		// Case 2: P1 graveyard has 1 card, P2 graveyard has 1 card (2 cards total across graveyards, but only 1 per graveyard)
		const g1Card1 = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'graveyard');
		const g2Card1 = addCardToZone(state, p2Id, getCardByName('Sol Ring')!, 'graveyard');

		const splitGraveCheck = checkSpellCastLegality(state, p1Id, twoInGraveSpell, 'hand');
		assert.equal(
			splitGraveCheck.ok,
			false,
			'Should NOT allow casting when each graveyard only has 1 card'
		);
		assert.match(splitGraveCheck.error || '', /single graveyard/i);

		// Attempting to force-cast targeting 1 card from P1's graveyard and 1 from P2's graveyard is rejected
		const forcedSplitCast = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: twoInGraveSpell.instanceId,
			targets: [
				{ kind: 'graveyard_card', id: g1Card1.instanceId, label: g1Card1.card.name },
				{ kind: 'graveyard_card', id: g2Card1.instanceId, label: g2Card1.card.name }
			]
		});
		assert.equal(forcedSplitCast.ok, false);

		// Case 3: Add a 2nd card to P1's graveyard -> now P1's graveyard has 2 cards!
		const g1Card2 = addCardToZone(state, p1Id, getCardByName('Eternal Witness')!, 'graveyard');
		const validGraveCheck = checkSpellCastLegality(state, p1Id, twoInGraveSpell, 'hand');
		assert.equal(validGraveCheck.ok, true);

		// Even when castable, trying to pick 1 card from P1's graveyard and 1 from P2's graveyard is rejected by validateChosenTargets!
		const crossGraveAttempt = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: twoInGraveSpell.instanceId,
			targets: [
				{ kind: 'graveyard_card', id: g1Card1.instanceId, label: g1Card1.card.name },
				{ kind: 'graveyard_card', id: g2Card1.instanceId, label: g2Card1.card.name }
			]
		});
		assert.equal(crossGraveAttempt.ok, false);
		assert.match(crossGraveAttempt.error || '', /same single graveyard/i);

		// Trying to target the exact same card twice (CR 115.3) is rejected!
		const duplicateTargetAttempt = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: twoInGraveSpell.instanceId,
			targets: [
				{ kind: 'graveyard_card', id: g1Card1.instanceId, label: g1Card1.card.name },
				{ kind: 'graveyard_card', id: g1Card1.instanceId, label: g1Card1.card.name }
			]
		});
		assert.equal(duplicateTargetAttempt.ok, false);
		assert.match(duplicateTargetAttempt.error || '', /same object cannot be chosen multiple times/i);

		// Targeting both cards in P1's graveyard succeeds!
		const legalCast = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: twoInGraveSpell.instanceId,
			targets: [
				{ kind: 'graveyard_card', id: g1Card1.instanceId, label: g1Card1.card.name },
				{ kind: 'graveyard_card', id: g1Card2.instanceId, label: g1Card2.card.name }
			]
		});
		assert.equal(legalCast.ok, true);
	});

	it('enforces Hexproof, Shroud, and Protection from Color/Type when checking target legality', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const swords = addCardToZone(state, p1Id, getCardByName('Swords to Plowshares')!, 'hand');

		// No creatures on board -> Swords to Plowshares cannot be cast
		assert.equal(checkSpellCastLegality(state, p1Id, swords, 'hand').ok, false);

		// Add an opponent creature with Hexproof
		const hexCreature = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Gladecover Scout',
				typeLine: 'Creature — Elf Scout',
				oracleText: 'Hexproof',
				keywords: ['Hexproof'],
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);

		// Only creature is opponent's Hexproof creature -> Swords to Plowshares still cannot be cast!
		assert.equal(checkSpellCastLegality(state, p1Id, swords, 'hand').ok, false);

		// Add an opponent creature with Protection from White
		addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Black Knight',
				typeLine: 'Creature — Human Knight',
				oracleText: 'First strike, protection from white',
				colors: ['B'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		// Swords is White -> still cannot target Black Knight!
		assert.equal(checkSpellCastLegality(state, p1Id, swords, 'hand').ok, false);

		// Add a creature with Shroud on P1's own board
		const shroudCreature = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Wall of Denial',
				typeLine: 'Creature — Wall',
				oracleText: 'Defender, flying, shroud',
				keywords: ['Defender', 'Flying', 'Shroud'],
				power: '0',
				toughness: '8'
			}),
			'battlefield'
		);
		// Shroud prevents even P1 from targeting their own creature!
		assert.equal(checkSpellCastLegality(state, p1Id, swords, 'hand').ok, false);
		assert.equal(
			validateTargetLegality(
				state,
				p1Id,
				{ kind: 'permanent', id: shroudCreature.instanceId, label: 'Wall of Denial' },
				'creature',
				swords.card
			).ok,
			false
		);

		// Add a creature with Hexproof on P1's own board -> P1 CAN target their own Hexproof creature!
		const myHexCreature = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Slippery Bogle',
				typeLine: 'Creature — Beast',
				oracleText: 'Hexproof',
				keywords: ['Hexproof'],
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		assert.equal(checkSpellCastLegality(state, p1Id, swords, 'hand').ok, true);
		assert.equal(
			validateTargetLegality(
				state,
				p1Id,
				{ kind: 'permanent', id: myHexCreature.instanceId, label: 'Slippery Bogle' },
				'creature',
				swords.card
			).ok,
			true
		);
		// Meanwhile, P1 still cannot target P2's Hexproof creature
		assert.equal(
			validateTargetLegality(
				state,
				p1Id,
				{ kind: 'permanent', id: hexCreature.instanceId, label: 'Gladecover Scout' },
				'creature',
				swords.card
			).ok,
			false
		);
	});

	it('enforces additional costs (sacrifice, discard, life) and timing restrictions', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// 1. Sacrifice a creature additional cost
		const villageRites = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Village Rites',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.'
			}),
			'hand'
		);
		assert.equal(checkSpellCastLegality(state, p1Id, villageRites, 'hand').ok, false);

		const elf = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'battlefield');
		assert.equal(checkSpellCastLegality(state, p1Id, villageRites, 'hand').ok, true);
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: villageRites.instanceId }).ok,
			true
		);
		// Elf was sacrificed to graveyard as additional cost!
		assert.equal(
			state.players[0].battlefield.some((c) => c.instanceId === elf.instanceId),
			false
		);
		assert.equal(
			state.players[0].graveyard.some((c) => c.instanceId === elf.instanceId),
			true
		);

		// 2. Discard a card additional cost when hand has no other cards
		state.players[0].hand = [];
		const thrill = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Thrill of Possibility',
				manaCost: '{1}{R}',
				typeLine: 'Instant',
				oracleText: 'As an additional cost to cast this spell, discard a card.\nDraw two cards.'
			}),
			'hand'
		);
		assert.equal(checkSpellCastLegality(state, p1Id, thrill, 'hand').ok, false);
		addCardToZone(state, p1Id, getCardByName('Forest')!, 'hand');
		assert.equal(checkSpellCastLegality(state, p1Id, thrill, 'hand').ok, true);

		// 3. Combat-only timing restriction
		const combatSpell = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Celestial Flare',
				manaCost: '{W}{W}',
				typeLine: 'Instant',
				oracleText: 'Cast this spell only during combat.\nDraw a card.'
			}),
			'hand'
		);
		assert.equal(state.phase, 'main1');
		assert.equal(checkSpellCastLegality(state, p1Id, combatSpell, 'hand').ok, false);
		state.phase = 'declare_attackers';
		assert.equal(checkSpellCastLegality(state, p1Id, combatSpell, 'hand').ok, true);
		state.phase = 'main1';

		// 4. Grand Abolisher opponent stax restriction
		addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Grand Abolisher',
				typeLine: 'Creature — Human Cleric',
				oracleText:
					"During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments.",
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		state.priorityPlayerIndex = 1; // Give priority to P2 on P1's turn
		const p2Instant = addCardToZone(state, p2Id, getCardByName('Brainstorm')!, 'hand');
		const abolisherCheck = checkSpellCastLegality(state, p2Id, p2Instant, 'hand');
		assert.equal(abolisherCheck.ok, false);
		assert.match(abolisherCheck.error || '', /Grand Abolisher/i);
	});
});

describe('5. Stack LIFO Resolution, Uncounterable Spells & Spell Fizzling (CR 608.2b)', () => {
	it('does not counter spells with "can\'t be countered" when a counterspell resolves', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const supremeVerdict = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Supreme Verdict',
				manaCost: '{1}{W}{W}{U}',
				typeLine: 'Sorcery',
				oracleText: "This spell can't be countered.\nDestroy all creatures."
			}),
			'hand'
		);
		const bear = addCardToZone(state, p2Id, getCardByName('Llanowar Elves')!, 'battlefield');

		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: supremeVerdict.instanceId }).ok,
			true
		);
		const verdictStackId = state.stack[0].id;

		// Pass priority to P2, who casts Counterspell targeting Supreme Verdict
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		const counterspell = addCardToZone(state, p2Id, getCardByName('Counterspell')!, 'hand');
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'cast_spell',
				instanceId: counterspell.instanceId,
				targets: [{ kind: 'stack', id: verdictStackId, label: 'Supreme Verdict' }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2);

		// Both pass priority -> Counterspell resolves first (LIFO), but fails to counter Supreme Verdict!
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].title, 'Supreme Verdict');

		// Now both pass priority -> Supreme Verdict resolves and destroys all creatures!
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(state.stack.length, 0);
		assert.equal(
			state.players[1].battlefield.some((c) => c.instanceId === bear.instanceId),
			false
		);
	});

	it('fizzles a targeted spell completely (CR 608.2b) if all targets become illegal before resolution', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const targetCreature = addCardToZone(
			state,
			p2Id,
			getCardByName('Llanowar Elves')!,
			'battlefield'
		);
		const cantripRemoval = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Lethal Sting Cantrip',
				manaCost: '{1}{B}',
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.\nDraw a card.'
			}),
			'hand'
		);

		const handSizeBefore = state.players[0].hand.length - 1; // minus the spell being cast
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: cantripRemoval.instanceId,
				targets: [{ kind: 'permanent', id: targetCreature.instanceId, label: 'Llanowar Elves' }]
			}).ok,
			true
		);

		// Before the spell resolves, targetCreature is exiled from the battlefield!
		state.players[1].battlefield = [];

		// Both players pass priority to resolve Lethal Sting Cantrip
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Spell fizzled: P1 did NOT draw a card!
		assert.equal(state.stack.length, 0);
		assert.equal(state.players[0].hand.length, handSizeBefore);
		assert.ok(
			state.log.some((l) => l.text.includes('countered on resolution') || l.text.includes('fizzled'))
		);
	});
});

describe('6. Combat Engine & Niche Keyword Interactions', () => {
	it('enforces Summoning Sickness, Haste, Vigilance, Flying, Reach, Menace, and Unblockable', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const sickCreature = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Grizzly Bears',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		sickCreature.summoningSick = true;

		const flyerMenaceVigilance = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Serra Avenger',
				typeLine: 'Creature — Angel',
				oracleText: 'Flying, vigilance, menace, haste',
				keywords: ['Flying', 'Vigilance', 'Menace', 'Haste'],
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		flyerMenaceVigilance.summoningSick = true;

		state.phase = 'declare_attackers';

		// Summoning-sick creature without Haste cannot attack
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: sickCreature.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			false
		);

		// Creature with Haste & Vigilance attacks and does NOT tap!
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: flyerMenaceVigilance.instanceId, defenderPlayerId: p2Id }
				]
			}).ok,
			true
		);
		assert.equal(flyerMenaceVigilance.tapped, false);
		assert.equal(state.phase, 'declare_blockers');

		// Ground blocker without Flying or Reach cannot block a Flyer
		const groundBlocker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Ground Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: groundBlocker.instanceId,
						attackerInstanceId: flyerMenaceVigilance.instanceId
					}
				]
			}).ok,
			false
		);

		// Reach blocker CAN block a Flyer, BUT attacker also has Menace, so 1 blocker is illegal!
		const reachBlocker1 = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Giant Spider 1',
				typeLine: 'Creature — Spider',
				oracleText: 'Reach',
				keywords: ['Reach'],
				power: '2',
				toughness: '4'
			}),
			'battlefield'
		);
		const singleBlockRes = applyGameAction(state, p2Id, {
			type: 'declare_blockers',
			assignments: [
				{
					blockerInstanceId: reachBlocker1.instanceId,
					attackerInstanceId: flyerMenaceVigilance.instanceId
				}
			]
		});
		assert.equal(singleBlockRes.ok, false);
		assert.match(singleBlockRes.error || '', /Menace/i);

		// 2 Reach/Flying blockers satisfy both Flying and Menace!
		const reachBlocker2 = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Giant Spider 2',
				typeLine: 'Creature — Spider',
				oracleText: 'Reach',
				keywords: ['Reach'],
				power: '2',
				toughness: '4'
			}),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: reachBlocker1.instanceId,
						attackerInstanceId: flyerMenaceVigilance.instanceId
					},
					{
						blockerInstanceId: reachBlocker2.instanceId,
						attackerInstanceId: flyerMenaceVigilance.instanceId
					}
				]
			}).ok,
			true
		);
	});

	it('handles niche Deathtouch + Trample against a high-toughness Indestructible blocker (1 lethal + 5 trample!)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const dtTrampler = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Questing Beast Avatar',
				typeLine: 'Creature — Beast',
				oracleText: 'Deathtouch, trample, lifelink',
				keywords: ['Deathtouch', 'Trample', 'Lifelink'],
				power: '6',
				toughness: '6'
			}),
			'battlefield'
		);

		const indestructibleWall = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Darksteel Colossus Wall',
				typeLine: 'Artifact Creature — Golem',
				oracleText: 'Indestructible',
				keywords: ['Indestructible'],
				power: '0',
				toughness: '10'
			}),
			'battlefield'
		);

		const p2StartLife = state.players[1].life; // 40
		const p1StartLife = state.players[0].life; // 40

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: dtTrampler.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);

		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: indestructibleWall.instanceId,
						attackerInstanceId: dtTrampler.instanceId
					}
				]
			}).ok,
			true
		);

		// Pass priority through declare_blockers to execute combat damage!
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Because of Deathtouch + Trample (CR 702.19b & 702.2c), only 1 damage is assigned to the 0/10 blocker,
		// and the remaining 5 damage tramples over to Player 2!
		assert.equal(state.players[1].life, p2StartLife - 5);
		// Lifelink gained P1 6 life (1 to blocker + 5 to player)
		assert.equal(state.players[0].life, p1StartLife + 6);
		// And because the 0/10 blocker has Indestructible, it survives on the battlefield despite Deathtouch damage!
		assert.equal(
			state.players[1].battlefield.some((c) => c.instanceId === indestructibleWall.instanceId),
			true
		);
	});

	it('handles First Strike killing a normal blocker before normal combat damage is dealt', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const firstStriker = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'White Knight',
				typeLine: 'Creature — Human Knight',
				oracleText: 'First strike',
				keywords: ['First strike'],
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);

		const normalBlocker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Hill Giant',
				typeLine: 'Creature — Giant',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: firstStriker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: normalBlocker.instanceId,
						attackerInstanceId: firstStriker.instanceId
					}
				]
			}).ok,
			true
		);

		// Advance into first_strike_damage
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Hill Giant died in first_strike_damage; White Knight took 0 damage and survived!
		assert.equal(
			state.players[1].battlefield.some((c) => c.instanceId === normalBlocker.instanceId),
			false
		);
		assert.equal(
			state.players[0].battlefield.some((c) => c.instanceId === firstStriker.instanceId),
			true
		);
		assert.equal(firstStriker.damageMarked, 0);
	});
});

describe('7. State-Based Actions, Commander Tax & Multiplayer Elimination (CR 704.5, 903.9a, 800.4a)', () => {
	it('annihilates +1/+1 and -1/-1 counters and kills Indestructible creatures at 0 toughness', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();

		const indestCreature = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Hazoret',
				typeLine: 'Creature — God',
				oracleText: 'Indestructible',
				keywords: ['Indestructible'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		// Give two +1/+1 counters and one -1/-1 counter
		indestCreature.counters['+1/+1'] = 2;
		indestCreature.counters['-1/-1'] = 1;
		checkStateBasedActions(state);
		assert.equal(indestCreature.counters['+1/+1'], 1);
		assert.equal(indestCreature.counters['-1/-1'], 0);
		assert.equal(getCreatureToughness(indestCreature, state), 3);

		// Now give three -1/-1 counters -> net two -1/-1 counters -> 0/0 toughness -> dies despite Indestructible!
		indestCreature.counters['-1/-1'] = 3;
		checkStateBasedActions(state);
		assert.equal(
			state.players[0].battlefield.some((c) => c.instanceId === indestCreature.instanceId),
			false
		);
		assert.equal(
			state.players[0].graveyard.some((c) => c.instanceId === indestCreature.instanceId),
			true
		);
	});

	it('enforces Commander 21 combat damage lethal SBA, Command Zone return prompt, and Commander Tax (+{2})', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const cmd = state.players[0].command[0];
		assert.ok(cmd);
		assert.equal(cmd.isCommander, true);

		// Cast Commander from Command Zone (Cast #1)
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: cmd.instanceId }).ok,
			true
		);
		assert.equal(cmd.commanderCastCount, 1);

		// Resolve Commander onto the battlefield
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(
			state.players[0].battlefield.some((c) => c.instanceId === cmd.instanceId),
			true
		);

		// Put Commander into graveyard -> triggers commander_zone_choice prompt for human player
		const Murder = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Murder',
				manaCost: '{1}{B}{B}',
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: Murder.instanceId,
				targets: [{ kind: 'permanent', id: cmd.instanceId, label: cmd.card.name }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		const cmdPrompt = state.pendingPrompts.find((p) => p.kind === 'commander_zone_choice');
		assert.ok(cmdPrompt);
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'commander_zone_choice',
				commanderInstanceId: cmd.instanceId,
				sendToCommandZone: true
			}).ok,
			true
		);
		assert.equal(
			state.players[0].command.some((c) => c.instanceId === cmd.instanceId),
			true
		);

		// Cast Commander a 2nd time -> increments commanderCastCount to 2
		const returnedCmd = state.players[0].command[0];
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: returnedCmd.instanceId }).ok,
			true
		);
		assert.equal(returnedCmd.commanderCastCount, 2);
		assert.equal(state.players[0].commanderCastCounts[cmd.instanceId], 2);

		// Test 21 Commander Combat Damage SBA on P2
		state.players[1].commanderDamageTaken[cmd.instanceId] = 21;
		checkStateBasedActions(state);
		assert.equal(state.players[1].lost, true);
		assert.equal(state.status, 'finished');
		assert.equal(state.winnerPlayerId, p1Id);
	});
});

describe('8. Scryfall Search Syntax, VFX Bezier Alignment & AI Legality', () => {
	it('evaluates complex Scryfall syntax queries accurately', () => {
		const atraxa = getCardByName("Atraxa, Praetors' Voice")!;
		const solRing = getCardByName('Sol Ring')!;
		const counterspell = getCardByName('Counterspell')!;

		assert.equal(matchesScryfallQuery(atraxa, 't:angel kw:flying pow>=4 cmc=4'), true);
		assert.equal(matchesScryfallQuery(atraxa, 'id>=wubg is:commander'), true);
		assert.equal(matchesScryfallQuery(solRing, 't:artifact mv<=1 o:"{C}{C}"'), true);
		assert.equal(matchesScryfallQuery(counterspell, 't:instant c:u -t:creature'), true);
		assert.equal(matchesScryfallQuery(counterspell, 't:creature'), false);
		assert.equal(matchesScryfallQuery(counterspell, 't:instant o:"counter target"'), true);
	});

	it('computes Bezier paths with zero endpoint curvature so arrowheads align with the line', () => {
		const x1 = 400;
		const y1 = 600;
		const x2 = 750;
		const y2 = 220;
		const path = computeBezierPath(x1, y1, x2, y2);
		const m = path.match(
			/^M\s+([\d.-]+)\s+([\d.-]+)\s+C\s+([\d.-]+)\s+([\d.-]+),\s+([\d.-]+)\s+([\d.-]+),\s+([\d.-]+)\s+([\d.-]+)$/
		);
		assert.ok(m, `Unexpected Bezier path format: ${path}`);
		const [, , , cx1Str, cy1Str, cx2Str, cy2Str, ex2Str, ey2Str] = m;
		const cx1 = Number(cx1Str);
		const cy1 = Number(cy1Str);
		const cx2 = Number(cx2Str);
		const cy2 = Number(cy2Str);
		const ex2 = Number(ex2Str);
		const ey2 = Number(ey2Str);

		// Endpoint tangent (ex2 - cx2, ey2 - cy2) must be strictly colinear with (ex2 - cx1, ey2 - cy1)
		const crossProduct = (ex2 - cx2) * (ey2 - cy1) - (ey2 - cy2) * (ex2 - cx1);
		assert.ok(
			Math.abs(crossProduct) < 1e-6,
			`Expected colinear control points at tip, got crossProduct=${crossProduct}`
		);

		// Also verify vertically stacked targets (e.g., stack-to-stack where x1 === x2) produce a non-zero horizontal bow
		const stackPath = computeBezierPath(1100, 300, 1100, 380);
		const sm = stackPath.match(
			/^M\s+([\d.-]+)\s+([\d.-]+)\s+C\s+([\d.-]+)\s+([\d.-]+),\s+([\d.-]+)\s+([\d.-]+),\s+([\d.-]+)\s+([\d.-]+)$/
		)!;
		assert.ok(Number(sm[3]) < 1100, 'Vertical stack-to-stack arrow bows horizontally to avoid 0-width bounding box');
		const stackCross =
			(Number(sm[7]) - Number(sm[5])) * (Number(sm[8]) - Number(sm[4])) -
			(Number(sm[8]) - Number(sm[6])) * (Number(sm[7]) - Number(sm[3]));
		assert.ok(Math.abs(stackCross) < 1e-6);
	});

	it('ensures AI bots never cast illegal spells when no valid targets exist', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		state.players[0].isBot = true;
		state.players[0].hand = [];
		state.players[0].command = [];

		// Give the bot only Counterspell with an empty stack
		addCardToZone(state, p1Id, getCardByName('Counterspell')!, 'hand');

		runAutomatedPriorityAndBots(state);
		// Bot should pass priority rather than attempting an illegal Counterspell cast
		assert.equal(state.stack.length, 0);
		assert.equal(state.players[0].hand.length, 1);
	});
});

describe('9. Niche Mechanics: Modal Spells, Cyclonic Rift Overload, Infect, Double Strike, Legend Rule, Token Cleanup, Proliferate, Magecraft & 4-Player Elimination', () => {
	it('handles Modal Spells where only one mode has legal targets, and blocks casting when no mode has legal targets', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const modalCharm = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Archmage Charm Variant',
				manaCost: '{U}{U}{U}',
				typeLine: 'Instant',
				oracleText:
					'Choose one —\n• Counter target spell.\n• Destroy target creature.'
			}),
			'hand'
		);

		// Neither a spell on the stack nor a creature on the battlefield -> cannot cast!
		assert.equal(checkSpellCastLegality(state, p1Id, modalCharm, 'hand').ok, false);

		// Add a creature to the battlefield (still 0 spells on stack) -> Mode 2 is now legal, so spell is castable!
		const bear = addCardToZone(
			state,
			p2Id,
			getCardByName('Llanowar Elves')!,
			'battlefield'
		);
		assert.equal(checkSpellCastLegality(state, p1Id, modalCharm, 'hand').ok, true);

		// Casting targeting the creature succeeds via modal branch #2!
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: modalCharm.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
	});

	it('handles Cyclonic Rift normal targeted mode vs Overload untargeted mode', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const rift = addCardToZone(state, p1Id, getCardByName('Cyclonic Rift')!, 'hand');

		// Opponent controls only a Land (and P1 controls a nonland Sol Ring)
		addCardToZone(state, p2Id, getCardByName('Island')!, 'battlefield');
		addCardToZone(state, p1Id, getCardByName('Sol Ring')!, 'battlefield');

		// Normal mode (xValue = 0): requires "target nonland permanent you don't control" -> ILLEGAL!
		assert.equal(checkSpellCastLegality(state, p1Id, rift, 'hand', 0).ok, false);

		// Overload mode (xValue = 1): does not target -> LEGAL!
		assert.equal(checkSpellCastLegality(state, p1Id, rift, 'hand', 1).ok, true);

		// Now give opponent a Sol Ring -> Normal mode becomes legal too!
		const oppRing = addCardToZone(state, p2Id, getCardByName('Sol Ring')!, 'battlefield');
		assert.equal(checkSpellCastLegality(state, p1Id, rift, 'hand', 0).ok, true);
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: rift.instanceId,
				targets: [{ kind: 'permanent', id: oppRing.instanceId, label: 'Sol Ring' }],
				xValue: 0
			}).ok,
			true
		);
	});

	it('handles Infect combat damage (Poison counters to players, -1/-1 counters to creatures) & 10-Poison SBA loss', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const infectAttacker1 = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Blighted Agent',
				typeLine: 'Creature — Human Rogue',
				oracleText: "Infect\nBlighted Agent can't be blocked.",
				keywords: ['Infect'],
				power: '5',
				toughness: '5'
			}),
			'battlefield'
		);

		const infectAttacker2 = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Glistener Elf',
				typeLine: 'Creature — Elf Warrior',
				oracleText: 'Infect',
				keywords: ['Infect'],
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);

		const blocker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Wall of Stone',
				typeLine: 'Creature — Wall',
				power: '0',
				toughness: '5'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: infectAttacker1.instanceId, defenderPlayerId: p2Id },
					{ attackerInstanceId: infectAttacker2.instanceId, defenderPlayerId: p2Id }
				]
			}).ok,
			true
		);

		// Trying to block Blighted Agent ("can't be blocked") fails
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: blocker.instanceId,
						attackerInstanceId: infectAttacker1.instanceId
					}
				]
			}).ok,
			false
		);

		// Blocking Glistener Elf succeeds
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [
					{
						blockerInstanceId: blocker.instanceId,
						attackerInstanceId: infectAttacker2.instanceId
					}
				]
			}).ok,
			true
		);

		// Resolve combat damage
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// P2 took 5 Infect damage as 5 Poison counters (and lost 0 life!)
		assert.equal(state.players[1].life, 40);
		assert.equal(state.players[1].poison, 5);
		// Blocker took 3 Infect damage as three -1/-1 counters (now 0/2)!
		assert.equal(blocker.counters['-1/-1'], 3);
		assert.equal(getCreatureToughness(blocker, state), 2);

		// Now give P2 5 more poison counters -> 10 poison counters triggers lethal SBA!
		state.players[1].poison = 10;
		checkStateBasedActions(state);
		assert.equal(state.players[1].lost, true);
		assert.equal(state.status, 'finished');
	});

	it('handles Double Strike dealing damage in both First Strike and regular Combat Damage steps', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const doubleStriker = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Fencing Ace',
				typeLine: 'Creature — Human Soldier',
				oracleText: 'Double strike',
				keywords: ['Double strike'],
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: doubleStriker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p2Id, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);

		// Pass priority -> enters first_strike_damage (deals 4)
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(state.players[1].life, 36);

		// Pass priority -> enters combat_damage (deals another 4 = 8 total!)
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(state.players[1].life, 32);
	});

	it('enforces Legend Rule (CR 704.5j), Token Cleanup outside battlefield (CR 704.5d), and Veyran Magecraft doubling', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();

		// 1. Legend Rule: two copies of Veyran -> first goes to graveyard, newest stays
		const veyran1 = addCardToZone(
			state,
			p1Id,
			getCardByName('Veyran, Voice of Duality')!,
			'battlefield'
		);
		const veyran2 = addCardToZone(
			state,
			p1Id,
			getCardByName('Veyran, Voice of Duality')!,
			'battlefield'
		);
		checkStateBasedActions(state);
		const veyransOnBoard = state.players[0].battlefield.filter(
			(c) => c.card.name === 'Veyran, Voice of Duality'
		);
		assert.equal(veyransOnBoard.length, 1);
		assert.equal(veyransOnBoard[0].instanceId, veyran2.instanceId);
		assert.equal(
			state.players[0].graveyard.some((c) => c.instanceId === veyran1.instanceId),
			true
		);

		// 2. Veyran + Storm-Kiln Artist Magecraft trigger doubling on casting an Instant
		addCardToZone(state, p1Id, getCardByName('Storm-Kiln Artist')!, 'battlefield');
		const brainstorm = addCardToZone(state, p1Id, getCardByName('Brainstorm')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: brainstorm.instanceId }).ok,
			true
		);
		// Storm-Kiln Artist creates 2 Treasure tokens (doubled by Veyran!) and Veyran gets +2/+2!
		const treasures = state.players[0].battlefield.filter((c) => c.card.name === 'Treasure');
		assert.equal(treasures.length, 2);
		assert.equal(getCreaturePower(veyran2, state), 4);

		// 3. Token cleanup outside battlefield: move a Treasure token to graveyard -> ceases to exist!
		treasures[0].zone = 'graveyard';
		state.players[0].graveyard.push(treasures[0]);
		state.players[0].battlefield = state.players[0].battlefield.filter(
			(c) => c.instanceId !== treasures[0].instanceId
		);
		checkStateBasedActions(state);
		assert.equal(
			state.players[0].graveyard.some((c) => c.isToken),
			false
		);
	});

	it('cleans up eliminated player spells, permanents, and combat assignments in a 4-player pod (CR 800.4a)', () => {
		const seats: LobbySeat[] = ['p1', 'p2', 'p3', 'p4'].map((id, idx) => ({
			seatIndex: idx,
			userId: id,
			username: `Player ${idx + 1}`,
			avatarUrl: '',
			isBot: false,
			deckId: PRECON_DECKS[idx].id,
			deckName: PRECON_DECKS[idx].name,
			commanderNames: [PRECON_DECKS[idx].commanders[0].name],
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[idx].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		}));

		const state = createInitialGameState(
			'POD4',
			seats,
			new Map([
				[0, PRECON_DECKS[0]],
				[1, PRECON_DECKS[1]],
				[2, PRECON_DECKS[2]],
				[3, PRECON_DECKS[3]]
			]),
			{ ...DEFAULT_LOBBY_RULES }
		);
		for (const id of ['p1', 'p2', 'p3', 'p4']) {
			applyGameAction(state, id, { type: 'mulligan_keep' });
		}
		assert.equal(state.status, 'active');

		// Put a permanent on P1's board and a spell from P1 on the stack
		state.players[0].manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		addCardToZone(state, 'p1', getCardByName('Sol Ring')!, 'battlefield');
		const cult = addCardToZone(state, 'p1', getCardByName('Cultivate')!, 'hand');
		applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: cult.instanceId });
		assert.equal(state.stack.length, 1);

		// P1 concedes in a 4-player game
		assert.equal(applyGameAction(state, 'p1', { type: 'concede' }).ok, true);
		assert.equal(state.players[0].lost, true);
		// P1's spell on the stack and permanents on the battlefield are removed immediately
		assert.equal(state.stack.length, 0);
		assert.equal(state.players[0].battlefield.length, 0);
		// Game continues for the remaining 3 players, with active turn passed to P2!
		assert.equal(state.status, 'active');
		assert.equal(state.activePlayerIndex, 1);
	});
});

describe('10. Activated Abilities: Equipment, Planeswalker Loyalty & Lathril 10-Elf Restriction', () => {
	it('enforces Equip sorcery-speed & target legality, and grants Haste + Shroud/Hexproof when attached', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();

		const greaves = addCardToZone(
			state,
			p1Id,
			getCardByName('Lightning Greaves')!,
			'battlefield'
		);
		const abilities = parseActivatedAbilities(greaves.card, ['W', 'U', 'B', 'G']);
		const equipAb = abilities.find((a) => a.id.startsWith('equip_'))!;
		assert.ok(equipAb);

		// With 0 creatures controlled by P1, Equip ability is illegal to activate!
		const noCreatureCheck = checkAbilityActivationLegality(state, p1Id, greaves, equipAb);
		assert.equal(noCreatureCheck.ok, false);

		// Add a summoning-sick creature to P1's battlefield
		const bear = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Runeclaw Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		bear.summoningSick = true;

		// Equip is sorcery-speed only -> illegal during combat!
		state.phase = 'declare_attackers';
		assert.equal(checkAbilityActivationLegality(state, p1Id, greaves, equipAb).ok, false);
		state.phase = 'main1';
		assert.equal(checkAbilityActivationLegality(state, p1Id, greaves, equipAb).ok, true);

		// Activate Equip targeting Runeclaw Bear and resolve it from the stack
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'activate_ability',
				instanceId: greaves.instanceId,
				abilityId: equipAb.id,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, 'player_2', { type: 'pass_priority' }).ok, true);

		// Greaves is now attached to Runeclaw Bear, granting Haste and Shroud!
		assert.equal(greaves.attachedToId, bear.instanceId);
		assert.equal(hasKeyword(bear, 'Haste', state), true);
		assert.equal(hasKeyword(bear, 'Shroud', state), true);
	});

	it('enforces Planeswalker loyalty rules (once per turn, sorcery speed, sufficient loyalty, 0-loyalty SBA)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const walker = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Jace, the Mind Sculptor',
				typeLine: 'Legendary Planeswalker — Jace',
				loyalty: '3',
				oracleText: '+2: Draw a card.\n-1: Return target creature to its owner\'s hand.\n-12: Draw three cards.'
			}),
			'battlefield'
		);
		assert.equal(walker.counters.loyalty, 3);

		const abilities = parseActivatedAbilities(walker.card, ['U']);
		const plusTwo = abilities.find((a) => a.loyaltyCost === 2)!;
		const minusOne = abilities.find((a) => a.loyaltyCost === -1)!;
		const minusTwelve = abilities.find((a) => a.loyaltyCost === -12)!;

		// Cannot activate -12 when loyalty is 3
		assert.equal(checkAbilityActivationLegality(state, p1Id, walker, minusTwelve).ok, false);

		// Cannot activate -1 ("target creature") when no creatures are on the battlefield!
		assert.equal(checkAbilityActivationLegality(state, p1Id, walker, minusOne).ok, false);

		// Activate +2 -> loyalty immediately becomes 5, and usedLoyaltyThisTurn becomes true
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'activate_ability',
				instanceId: walker.instanceId,
				abilityId: plusTwo.id
			}).ok,
			true
		);
		assert.equal(walker.counters.loyalty, 5);
		assert.equal(walker.usedLoyaltyThisTurn, true);

		// Resolve ability
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Attempting to activate a 2nd loyalty ability in the same turn is rejected!
		assert.equal(checkAbilityActivationLegality(state, p1Id, walker, plusTwo).ok, false);

		// Reducing loyalty to 0 causes Planeswalker to die via SBA
		walker.counters.loyalty = 0;
		checkStateBasedActions(state);
		assert.equal(
			state.players[0].battlefield.some((c) => c.instanceId === walker.instanceId),
			false
		);
	});

	it('enforces Lathril, Blade of the Elves "Tap ten untapped Elves you control" cost restriction and never fires activated abilities on spell cast', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// First, verify casting Lathril from the Command Zone does NOT execute her activated ability on cast resolution!
		const lathrilInCmd = addCardToZone(
			state,
			p1Id,
			getCardByName('Lathril, Blade of the Elves')!,
			'command'
		);
		lathrilInCmd.isCommander = true;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: lathrilInCmd.instanceId,
				fromZone: 'command'
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Both players must still be at 40 life after Lathril resolves onto the battlefield!
		assert.equal(state.players[0].life, 40);
		assert.equal(state.players[1].life, 40);

		const lathril = state.players[0].battlefield.find(
			(c) => c.card.name === 'Lathril, Blade of the Elves'
		)!;
		assert.ok(lathril);
		lathril.summoningSick = false;

		const abilities = parseActivatedAbilities(lathril.card, ['B', 'G']);
		const tapTenAb = abilities[0]!;
		assert.ok(tapTenAb);

		// Only Lathril on board -> cannot activate!
		const failCheck = checkAbilityActivationLegality(state, p1Id, lathril, tapTenAb);
		assert.equal(failCheck.ok, false);
		assert.match(failCheck.error || '', /ten other untapped Elves/i);

		// Add 10 untapped Elf tokens to P1's battlefield -> now legal!
		for (let i = 0; i < 10; i++) {
			addCardToZone(
				state,
				p1Id,
				makeTestCard({
					name: `Elf Warrior ${i}`,
					typeLine: 'Token Creature — Elf Warrior',
					power: '1',
					toughness: '1'
				}),
				'battlefield'
			);
		}
		assert.equal(checkAbilityActivationLegality(state, p1Id, lathril, tapTenAb).ok, true);
	});
});

describe('11. Land Play Legality, Landfall Proliferate, Corpsejack Doubling & Cleanup Step', () => {
	it('enforces 1 land per turn at sorcery speed, triggers Evolution Sage Landfall Proliferate & Corpsejack doubling', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();

		const forest1 = addCardToZone(state, p1Id, getCardByName('Forest')!, 'hand');
		const forest2 = addCardToZone(state, p1Id, getCardByName('Forest')!, 'hand');
		const tapland = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Golgari Guildgate',
				typeLine: 'Land — Gate',
				oracleText: 'Golgari Guildgate enters tapped.\n{T}: Add {B} or {G}.'
			}),
			'hand'
		);

		// Put Evolution Sage and Corpsejack Menace on P1's battlefield, plus a creature with a +1/+1 counter
		const sage = addCardToZone(state, p1Id, getCardByName('Evolution Sage')!, 'battlefield');
		addCardToZone(state, p1Id, getCardByName('Corpsejack Menace')!, 'battlefield');
		sage.counters['+1/+1'] = 1;

		// Play first land (Golgari Guildgate) -> enters tapped, and triggers Evolution Sage Landfall Proliferate (+2 counters because of Corpsejack Menace!)
		assert.equal(checkLandPlayLegality(state, p1Id, tapland, 'hand').ok, true);
		assert.equal(
			applyGameAction(state, p1Id, { type: 'play_land', instanceId: tapland.instanceId }).ok,
			true
		);
		assert.equal(tapland.tapped, true);
		assert.equal(sage.counters['+1/+1'], 3); // 1 + (1 * 2 from Corpsejack) = 3!

		// Attempting to play a 2nd land on the same turn is rejected!
		assert.equal(checkLandPlayLegality(state, p1Id, forest1, 'hand').ok, false);
		assert.equal(
			applyGameAction(state, p1Id, { type: 'play_land', instanceId: forest2.instanceId }).ok,
			false
		);
	});

	it('enforces Cleanup Step discard-to-7 prompt unless Reliquary Tower / Thought Vessel is on board', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// Give P1 9 cards in hand (2 over maxHandSize=7)
		while (state.players[0].hand.length < 9) {
			addCardToZone(state, p1Id, getCardByName('Forest')!, 'hand');
		}

		// Advance to end_step and pass priority into cleanup
		state.phase = 'end_step';
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Should pause in cleanup with a discard_to_hand_size prompt requiring 2 cards!
		const discardPrompt = state.pendingPrompts.find(
			(p) => p.playerId === p1Id && p.kind === 'discard_to_hand_size'
		);
		assert.ok(discardPrompt);
		assert.equal(discardPrompt.countRequired, 2);

		// Discard 2 cards -> completes cleanup and advances turn to Player 2!
		const toDiscard = [
			state.players[0].hand[0].instanceId,
			state.players[0].hand[1].instanceId
		];
		assert.equal(
			applyGameAction(state, p1Id, { type: 'discard_cards', instanceIds: toDiscard }).ok,
			true
		);
		assert.equal(state.players[0].hand.length, 7);
		assert.equal(state.activePlayerIndex, 1);
	});
});

describe('12. Viewer State Sanitization (Hidden Information Security)', () => {
	it('hides opponent hand and library contents while preserving counts', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		const forP1 = sanitizeGameStateForViewer(state, p1Id);
		assert.ok(forP1.players[0].hand.length > 0, 'Viewer should see their own hand');
		assert.equal(forP1.players[1].hand.length, 0, 'Opponent hand array must be redacted');
		assert.equal(forP1.players[1].handCount, 7, 'Opponent handCount must be preserved');
		assert.equal(forP1.players[0].library.length, 0, 'Library must be hidden when not searching');
		assert.ok((forP1.players[0].libraryCount || 0) > 80, 'Library count must be preserved');
	});
});

describe('13. Standardized Labeled-Path CardRuleTree & Dynamic Board-State Hooks', () => {
	it('compiles Equip {1} into labeled path "activated.attach" with targetLegality, targetAmount, action, and emitsEvents: ["on_attach"]', () => {
		const bootsCard = getCardByName('Swiftfoot Boots')!;
		const tree = getCardRuleTree(bootsCard);

		assert.equal(tree.cardName, 'Swiftfoot Boots');
		const attachNodes = tree.paths['activated.attach'] || [];
		assert.equal(attachNodes.length, 1);

		const attachNode = tree.actions.find((a) => a.path === 'activated.attach')!;
		assert.ok(attachNode);
		assert.equal(attachNode.item, 'self');
		assert.equal(attachNode.manaCost, '{1}');
		assert.equal(attachNode.timing, 'sorcery');
		assert.equal(attachNode.targetLegality.zone, 'battlefield');
		assert.equal(attachNode.targetLegality.controller, 'self_controller');
		assert.equal(attachNode.targetLegality.cardType, 'Creature');
		assert.deepEqual(attachNode.targetAmount, { min: 1, max: 1 });
		assert.equal(attachNode.action.op, 'attach');
		assert.equal(attachNode.action.target, 'target[0]');
		assert.deepEqual(attachNode.emitsEvents, ['on_attach']);
	});

	it('applies board-state cost-modifier hooks to set mana_cost of all activated.attach actions to {0} and fires on_attach triggers', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// Give P1 ZERO mana in pool and ZERO lands on board!
		state.players[0].manaPool = createEmptyManaPool();
		state.players[0].battlefield = [];

		// Put Swiftfoot Boots (Equip {1}) and a creature on P1's battlefield
		const boots = addCardToZone(state, p1Id, getCardByName('Swiftfoot Boots')!, 'battlefield');
		const creature = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Silvercoat Lion',
				typeLine: 'Creature — Cat',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		// Without a free-attach hook on the board, evaluated manaCost is '{1}' and P1 cannot pay it with 0 mana
		const evalBefore = evaluateActionNode(state, p1Id, boots, 'activated.attach')!;
		assert.equal(evalBefore.effectiveManaCost, '{1}');
		assert.equal(evalBefore.effectiveCostRequirement.totalCmc, 1);
		const rawAb = getEffectiveActivatedAbilities(state, state.players[0], boots)[0]!;
		assert.equal(checkAbilityActivationLegality(state, p1Id, boots, rawAb).ok, false);

		// Now place a permanent on P1's battlefield with a free-attach board hook AND an on_attach trigger!
		addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Armory Automaton',
				typeLine: 'Artifact Creature — Construct',
				oracleText:
					'Equip abilities you activate cost {0}.\nWhenever an Equipment becomes attached to a creature, draw a card.',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const activeHooks = collectActiveBoardHooks(state);
		assert.equal(
			activeHooks.some(
				(h) => h.hook.targetPath === 'activated.attach' && h.hook.costMode === 'set_zero'
			),
			true
		);

		// Re-evaluating the "activated.attach" node on demand now yields effectiveManaCost === '{0}'!
		const evalAfter = evaluateActionNode(state, p1Id, boots, 'activated.attach')!;
		assert.equal(evalAfter.effectiveManaCost, '{0}');
		assert.equal(evalAfter.effectiveCostRequirement.totalCmc, 0);
		assert.ok(evalAfter.appliedHooks.length > 0);

		const hookedAb = getEffectiveActivatedAbilities(state, state.players[0], boots)[0]!;
		assert.equal(hookedAb.manaCost, '{0}');
		assert.equal(checkAbilityActivationLegality(state, p1Id, boots, hookedAb).ok, true);

		const handBefore = state.players[0].hand.length;
		// Activate Equip {0} with 0 mana available and resolve it!
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: hookedAb.id,
				targets: [{ kind: 'permanent', id: creature.instanceId, label: creature.card.name }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Boots is attached AND the on_attach trigger drew 1 card!
		assert.equal(boots.attachedToId, creature.instanceId);
		assert.equal(state.players[0].hand.length, handBefore + 1);
	});
});

describe('14. End Turn Action & 1v1 AI Turn Progression', () => {
	it('cleanly ends the human turn via { type: "end_turn" }, executes the AI Bot turn (including AI spells on the stack), and advances to Turn 2', () => {
		const seats: LobbySeat[] = [
			{
				seatIndex: 0,
				userId: 'human_1',
				username: 'Human Player',
				avatarUrl: '',
				isBot: false,
				deckId: PRECON_DECKS[0].id,
				deckName: PRECON_DECKS[0].name,
				commanderNames: [PRECON_DECKS[0].commanders[0].name],
				commanderArtUrl: '',
				colorIdentity: PRECON_DECKS[0].colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: Date.now()
			},
			{
				seatIndex: 1,
				userId: null,
				username: 'Garruk (AI Bot)',
				avatarUrl: '',
				isBot: true,
				botDifficulty: 'focused',
				deckId: PRECON_DECKS[1].id,
				deckName: PRECON_DECKS[1].name,
				commanderNames: [PRECON_DECKS[1].commanders[0].name],
				commanderArtUrl: '',
				colorIdentity: PRECON_DECKS[1].colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: Date.now()
			}
		];

		const state = createInitialGameState(
			'AI1V1',
			seats,
			new Map([
				[0, PRECON_DECKS[0]],
				[1, PRECON_DECKS[1]]
			]),
			{ ...DEFAULT_LOBBY_RULES }
		);

		// Human keeps opening hand -> Turn 1 starts for Human Player
		assert.equal(applyGameAction(state, 'human_1', { type: 'mulligan_keep' }).ok, true);
		runAutomatedPriorityAndBots(state);
		assert.equal(state.status, 'active');
		assert.equal(state.turnNumber, 1);
		assert.equal(state.activePlayerIndex, 0);

		// Give the AI Bot a Forest and a Sol Ring in hand so the AI will play a land AND cast a spell on its turn!
		state.players[1].hand = [];
		addCardToZone(state, 'bot_1', getCardByName('Forest')!, 'hand');
		addCardToZone(state, 'bot_1', getCardByName('Sol Ring')!, 'hand');

		// Play a land on Turn 1 (or keep hand size <= 7) and ensure Human has 0 mana / 0 instant responses
		state.players[0].hand = state.players[0].hand.slice(0, 7);
		state.players[0].manaPool = createEmptyManaPool();
		state.players[0].battlefield = [];
		state.players[0].fullControl = false;

		// Human clicks "End Turn" ({ type: 'end_turn' })
		const endRes = applyGameAction(state, 'human_1', { type: 'end_turn' });
		assert.equal(endRes.ok, true);

		// Run AI automation -> AI takes Turn 1 (plays Forest, casts Sol Ring which auto-resolves because Human has 0 responses), ends turn, and advances to Turn 2 for Human!
		runAutomatedPriorityAndBots(state);

		assert.equal(state.turnNumber, 2);
		assert.equal(state.activePlayerIndex, 0);
		assert.equal(state.priorityPlayerIndex, 0);
		assert.equal(state.phase, 'main1');
		assert.equal(
			state.players[1].battlefield.some((c) => c.card.name === 'Forest'),
			true,
			'AI Bot should have played Forest on its turn'
		);
		assert.equal(
			state.players[1].battlefield.some((c) => c.card.name === 'Sol Ring'),
			true,
			'AI Bot should have cast and resolved Sol Ring on its turn without freezing on the stack'
		);
	});
});

// ============================================================================
// 15. Continuous Layer & Keyword/Effect Attribution Engine (Alt-View Breakdown)
// ============================================================================
describe('15. Continuous Layer & Keyword/Effect Attribution Engine (Alt-View Breakdown)', () => {
	it('attributes innate keywords with (innate) and granted keywords/stats with exact source names', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const atraxa = addCardToZone(
			state,
			p1Id,
			getCardByName("Atraxa, Praetors' Voice")!,
			'battlefield'
		);
		const boots = addCardToZone(state, p1Id, getCardByName('Swiftfoot Boots')!, 'battlefield');
		boots.attachedToId = atraxa.instanceId;
		const spear = addCardToZone(state, p1Id, getCardByName('Shadowspear')!, 'battlefield');
		spear.attachedToId = atraxa.instanceId;

		const breakdown = inspectCardContinuousBreakdown(atraxa, state);

		// Innate keywords on Atraxa: Flying, Vigilance, Deathtouch, Lifelink
		const flying = breakdown.items.find((i) => i.canonicalKey === 'flying');
		assert.ok(flying);
		assert.equal(flying.isInnate, true);
		assert.deepEqual(flying.sources, ['innate']);
		assert.equal(flying.removed, false);

		// Lifelink is both innate AND reinforced by Shadowspear
		const lifelink = breakdown.items.find((i) => i.canonicalKey === 'lifelink');
		assert.ok(lifelink);
		assert.equal(lifelink.sources.includes('innate'), true);
		assert.equal(lifelink.sources.includes('Shadowspear'), true);

		// Granted keywords: Haste & Hexproof from Swiftfoot Boots, Trample from Shadowspear
		const hexproof = breakdown.items.find((i) => i.canonicalKey === 'hexproof');
		assert.ok(hexproof);
		assert.equal(hexproof.isInnate, false);
		assert.deepEqual(hexproof.sources, ['Swiftfoot Boots']);
		assert.equal(hexproof.removed, false);

		const trample = breakdown.items.find((i) => i.canonicalKey === 'trample');
		assert.ok(trample);
		assert.deepEqual(trample.sources, ['Shadowspear']);

		// Effective P/T includes +1/+1 from Shadowspear (4/4 -> 5/5)
		assert.equal(breakdown.basePower, 4);
		assert.equal(breakdown.baseToughness, 4);
		assert.equal(breakdown.effectivePower, 5);
		assert.equal(breakdown.effectiveToughness, 5);
		assert.equal(getCreaturePower(atraxa, state), 5);
	});

	it('crosses out Hexproof, Shroud, and Indestructible with (removed by Shadowspear / Arcane Lighthouse) and enforces removal in gameplay', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// Create a creature with innate Hexproof and Indestructible for Player 1
		const hexCreatureCard = makeTestCard({
			name: 'Sacred Stalker',
			typeLine: 'Creature — Beast',
			oracleText: 'Hexproof, indestructible',
			keywords: ['Hexproof', 'Indestructible'],
			power: '4',
			toughness: '4'
		});
		const stalker = addCardToZone(state, p1Id, hexCreatureCard, 'battlefield');

		// Also equip Lightning Greaves to a second creature for Shroud testing
		const llanowar = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'battlefield');
		const greaves = addCardToZone(state, p1Id, getCardByName('Lightning Greaves')!, 'battlefield');
		greaves.attachedToId = llanowar.instanceId;

		assert.equal(hasKeyword(stalker, 'Hexproof', state), true);
		assert.equal(hasKeyword(stalker, 'Indestructible', state), true);
		assert.equal(hasKeyword(llanowar, 'Shroud', state), true);

		// Player 2 has Shadowspear and Arcane Lighthouse on the battlefield
		addCardToZone(state, p2Id, getCardByName('Shadowspear')!, 'battlefield');
		addCardToZone(state, p2Id, getCardByName('Arcane Lighthouse')!, 'battlefield');

		const stalkerBreakdown = inspectCardContinuousBreakdown(stalker, state);
		const hexItem = stalkerBreakdown.items.find((i) => i.canonicalKey === 'hexproof');
		const indItem = stalkerBreakdown.items.find((i) => i.canonicalKey === 'indestructible');

		assert.ok(hexItem);
		assert.equal(hexItem.isInnate, true);
		assert.deepEqual(hexItem.sources, ['innate']);
		assert.equal(hexItem.removed, true);
		assert.equal(hexItem.removedBy.includes('Shadowspear'), true);
		assert.equal(hexItem.removedBy.includes('Arcane Lighthouse'), true);

		assert.ok(indItem);
		assert.equal(indItem.isInnate, true);
		assert.deepEqual(indItem.sources, ['innate']);
		assert.equal(indItem.removed, true);
		assert.deepEqual(indItem.removedBy, ['Shadowspear']);

		const llanowarBreakdown = inspectCardContinuousBreakdown(llanowar, state);
		const shroudItem = llanowarBreakdown.items.find((i) => i.canonicalKey === 'shroud');
		assert.ok(shroudItem);
		assert.deepEqual(shroudItem.sources, ['Lightning Greaves']);
		assert.equal(shroudItem.removed, true);
		assert.deepEqual(shroudItem.removedBy, ['Arcane Lighthouse']);

		// Gameplay engine enforcement: hasKeyword now returns false, allowing P2 to target & destroy stalker!
		assert.equal(hasKeyword(stalker, 'Hexproof', state), false);
		assert.equal(hasKeyword(stalker, 'Indestructible', state), false);
		assert.equal(hasKeyword(llanowar, 'Shroud', state), false);

		const murderCard = getCardByName('Infernal Grasp')!;
		const parsedMurder = parseSpellOrAbilityEffects(murderCard);
		const targetLegality = validateTargetLegality(
			state,
			p2Id,
			{ kind: 'permanent', id: stalker.instanceId, label: stalker.card.name },
			parsedMurder.targetInfo,
			murderCard
		);
		assert.equal(
			targetLegality.ok,
			true,
			'Opponent can now legally target creature whose Hexproof was removed by Shadowspear / Arcane Lighthouse'
		);
	});

	it('handles complex Layer 4, 6 & 7 type and ability interactions (Darksteel Mutation, Imprisoned in the Moon, Blood Moon, Urborg, Humility)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// 1. Darksteel Mutation on Miirym, Sentinel Wyrm (Flying, Ward {2}, ETB Trigger -> 0/1 Artifact Creature — Insect with Indestructible)
		const miirym = addCardToZone(
			state,
			p1Id,
			getCardByName('Miirym, Sentinel Wyrm')!,
			'battlefield'
		);
		const mutation = addCardToZone(
			state,
			p2Id,
			getCardByName('Darksteel Mutation')!,
			'battlefield'
		);
		mutation.attachedToId = miirym.instanceId;

		const miirymBd = inspectCardContinuousBreakdown(miirym, state);
		assert.equal(miirymBd.effectiveTypeLine, 'Legendary Artifact Creature — Insect');
		assert.equal(miirymBd.typeModified, true);
		assert.deepEqual(miirymBd.typeModifiedBy, ['Darksteel Mutation']);
		assert.equal(miirymBd.effectivePower, 0);
		assert.equal(miirymBd.effectiveToughness, 1);
		assert.equal(getCreaturePower(miirym, state), 0);
		assert.equal(getCreatureToughness(miirym, state), 1);

		// Innate Flying and Ward are crossed out as removed by Darksteel Mutation
		const flyingItem = miirymBd.items.find((i) => i.canonicalKey === 'flying');
		assert.ok(flyingItem);
		assert.equal(flyingItem.removed, true);
		assert.deepEqual(flyingItem.removedBy, ['Darksteel Mutation']);
		assert.equal(hasKeyword(miirym, 'Flying', state), false);

		// Indestructible is granted by Darksteel Mutation
		const indItem = miirymBd.items.find((i) => i.canonicalKey === 'indestructible');
		assert.ok(indItem);
		assert.equal(indItem.removed, false);
		assert.deepEqual(indItem.sources, ['Darksteel Mutation']);
		assert.equal(hasKeyword(miirym, 'Indestructible', state), true);

		// 2. Blood Moon + Urborg, Tomb of Yawgmoth on Reliquary Tower (nonbasic land)
		const tower = addCardToZone(state, p1Id, getCardByName('Reliquary Tower')!, 'battlefield');
		addCardToZone(state, p2Id, getCardByName('Blood Moon')!, 'battlefield');
		addCardToZone(state, p1Id, getCardByName('Urborg, Tomb of Yawgmoth')!, 'battlefield');

		const towerBd = inspectCardContinuousBreakdown(tower, state);
		assert.equal(towerBd.effectiveTypeLine, 'Land — Mountain Swamp');
		const noMaxHand = towerBd.items.find((i) => i.canonicalKey === 'ability_no_max_hand');
		assert.ok(noMaxHand);
		assert.equal(noMaxHand.removed, true);
		assert.deepEqual(noMaxHand.removedBy, ['Blood Moon']);
	});
});

describe('16. CR 613 Layers, Timestamps (Opalescence + Humility), Layer 7d P/T Switching & Clone Copiable Values', () => {
	it('evaluates Opalescence + Humility in both timestamp orders (CR 613.7) and applies +1/+1 counters in Layer 7c after Layer 7b', () => {
		// Case A: Opalescence enters first (earlier timestamp), Humility enters second (later timestamp) -> 1/1
		const gameA = createActiveTwoPlayerGame();
		const opalA = addCardToZone(
			gameA.state,
			gameA.p1Id,
			getCardByName('Opalescence')!,
			'battlefield'
		);
		const humA = addCardToZone(
			gameA.state,
			gameA.p1Id,
			getCardByName('Humility')!,
			'battlefield'
		);
		assert.ok((opalA.enteredTimestamp ?? 0) < (humA.enteredTimestamp ?? 0));
		// Opalescence animates Humility (Layer 4), and in Layer 7b Humility has the later timestamp so both are 1/1!
		assert.equal(getCreaturePower(humA, gameA.state), 1);
		assert.equal(getCreatureToughness(humA, gameA.state), 1);

		// Adding two +1/+1 counters (Layer 7c) after Humility's 1/1 base P/T (Layer 7b) makes it a 3/3!
		humA.counters['+1/+1'] = 2;
		assert.equal(getCreaturePower(humA, gameA.state), 3);
		assert.equal(getCreatureToughness(humA, gameA.state), 3);

		// Case B: Humility enters first (earlier timestamp), Opalescence enters second (later timestamp) -> 4/4 (CMC 4)
		const gameB = createActiveTwoPlayerGame();
		const humB = addCardToZone(
			gameB.state,
			gameB.p1Id,
			getCardByName('Humility')!,
			'battlefield'
		);
		const opalB = addCardToZone(
			gameB.state,
			gameB.p1Id,
			getCardByName('Opalescence')!,
			'battlefield'
		);
		assert.ok((humB.enteredTimestamp ?? 0) < (opalB.enteredTimestamp ?? 0));
		assert.equal(getCreaturePower(humB, gameB.state), 4);
		assert.equal(getCreatureToughness(humB, gameB.state), 4);
	});

	it('applies Layer 7d P/T switching (Inside Out) after Layer 7c counters and buffs, and copies Layer 1 values with Clone (CR 707.2)', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		// Put a 1/4 Wall with two +1/+1 counters on the battlefield -> 3/6 in Layer 7c
		const wallCard = makeTestCard({
			name: 'Glacial Wall',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Creature — Wall',
			oracleText: 'Defender',
			power: '1',
			toughness: '4',
			keywords: ['Defender']
		});
		const wall = addCardToZone(state, p1Id, wallCard, 'battlefield');
		wall.counters['+1/+1'] = 2;
		assert.equal(getCreaturePower(wall, state), 3);
		assert.equal(getCreatureToughness(wall, state), 6);

		// Cast Inside Out targeting Glacial Wall -> switches P/T in Layer 7d (becomes 6/3!)
		const insideOut = addCardToZone(state, p1Id, getCardByName('Inside Out')!, 'hand');
		const castRes = applyGameAction(state, p1Id, {
			type: 'cast_spell',
			instanceId: insideOut.instanceId,
			targets: [{ kind: 'permanent', id: wall.instanceId, label: wall.card.name }]
		});
		assert.equal(castRes.ok, true);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' });

		assert.equal(getCreaturePower(wall, state), 6);
		assert.equal(getCreatureToughness(wall, state), 3);

		// Now cast Clone copying Glacial Wall -> Clone copies Layer 1 copiable values (1/4), NOT the +1/+1 counters or Layer 7d switch!
		const cloneHand = addCardToZone(state, p1Id, getCardByName('Clone')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: cloneHand.instanceId
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' });

		const cloneOnBoard = state.players[0].battlefield.find(
			(b) => b.instanceId === cloneHand.instanceId
		);
		assert.ok(cloneOnBoard);
		assert.equal(cloneOnBoard.card.name, 'Glacial Wall');
		assert.equal(getCreaturePower(cloneOnBoard, state), 1);
		assert.equal(getCreatureToughness(cloneOnBoard, state), 4);
	});
});

describe('17. CR 614 Replacement Effects (Rest in Peace) & Rule-Modifying Win/Loss Locks (Platinum Angel, Laboratory Maniac, Thassa\'s Oracle)', () => {
	it('exiles dying creatures instead of putting them in graveyard when Rest in Peace is on the battlefield, preventing "dies" triggers', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();

		// Put Rest in Peace on the battlefield
		addCardToZone(state, p1Id, getCardByName('Rest in Peace')!, 'battlefield');

		// Create a creature with a "When ~ dies, draw a card" trigger
		const solemnCard = makeTestCard({
			name: 'Solemn Simulacrum',
			manaCost: '{4}',
			cmc: 4,
			typeLine: 'Artifact Creature — Golem',
			oracleText: 'When Solemn Simulacrum dies, you may draw a card.',
			power: '2',
			toughness: '2'
		});
		const solemn = addCardToZone(state, p1Id, solemnCard, 'battlefield');
		const handBefore = state.players[0].hand.length;

		// Deal lethal damage to Solemn Simulacrum and run SBAs
		solemn.damageMarked = 2;
		checkStateBasedActions(state);

		// Solemn Simulacrum was exiled instead of dying (graveyard is empty, exile has Solemn, and no card was drawn!)
		assert.equal(
			state.players[0].graveyard.some((c) => c.instanceId === solemn.instanceId),
			false
		);
		assert.equal(
			state.players[0].exile.some((c) => c.instanceId === solemn.instanceId),
			true
		);
		assert.equal(state.players[0].hand.length, handBefore);
	});

	it('prevents losing at <= 0 life or 10+ poison with Platinum Angel until Platinum Angel is removed, and wins with Laboratory Maniac on empty library draw', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		const angel = addCardToZone(state, p1Id, getCardByName('Platinum Angel')!, 'battlefield');
		p1.life = -5;
		p1.poison = 12;
		checkStateBasedActions(state);

		assert.equal(p1.lost, false, 'Platinum Angel prevents losing at -5 life and 12 poison');
		assert.equal(state.status, 'active');

		// Restore life/poison and test Laboratory Maniac winning when drawing from an empty library
		p1.life = 20;
		p1.poison = 0;
		p1.library = [];
		addCardToZone(state, p1Id, getCardByName('Laboratory Maniac')!, 'battlefield');

		// Remove Platinum Angel from opponent's perspective (p1 controls it, so p1 CAN win)
		const optCard = addCardToZone(state, p1Id, getCardByName('Opt')!, 'hand');
		applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: optCard.instanceId });
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(state.status, 'finished');
		assert.equal(state.winnerPlayerId, p1Id);
		assert.ok(angel);
	});
});

describe('18. CR 721 Premature Turn Ending (Obeka, Brute Chronologist / Sundial of the Infinite) & Extra Turns (Final Fortune)', () => {
	it('grants an extra turn from Final Fortune, puts the "you lose the game" delayed trigger on the stack at End Step, and exiles it with Obeka to survive!', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		const obeka = addCardToZone(
			state,
			p1Id,
			getCardByName('Obeka, Brute Chronologist')!,
			'battlefield'
		);
		const finalFortune = addCardToZone(
			state,
			p1Id,
			getCardByName('Final Fortune')!,
			'hand'
		);

		// Cast Final Fortune on Turn 1
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: finalFortune.instanceId
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(state.extraTurnQueue?.length, 1);
		assert.equal(state.delayedTriggers?.length, 1);

		// End Turn 1 -> p1 immediately begins their Extra Turn (Turn 2, still p1's turn!)
		p1.hand = []; // avoid discard prompt
		assert.equal(applyGameAction(state, p1Id, { type: 'end_turn' }).ok, true);
		assert.equal(state.activePlayerIndex, 0, 'Alice begins her extra turn');
		assert.equal(state.phase, 'main1');

		// Now advance to End Step of the Extra Turn -> Final Fortune's "you lose the game" trigger goes onto the Stack!
		assert.equal(applyGameAction(state, p1Id, { type: 'end_turn' }).ok, true);
		assert.equal(state.phase, 'end_step');
		assert.equal(state.stack.length, 1);
		assert.ok(state.stack[0].title.includes('Final Fortune'));

		// While the "you lose the game" trigger is on the stack, activate Obeka, Brute Chronologist ({T}: The player whose turn it is may end the turn)!
		const obekaAbilities = getEffectiveActivatedAbilities(state, p1, obeka, ['U', 'B', 'R']);
		assert.ok(obekaAbilities.length > 0);
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'activate_ability',
				instanceId: obeka.instanceId,
				abilityId: obekaAbilities[0].id
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2);

		// Resolve Obeka's ability on top of the stack -> exiles Final Fortune's loss trigger from the stack and ends the turn!
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(state.stack.length, 0, 'Obeka exiled all items from the Stack');
		assert.equal(p1.lost, false, 'Alice survived Final Fortune by ending the turn with Obeka!');
		assert.equal(state.activePlayerIndex, 1, 'Turn cleanly passed to Bob after Cleanup');
	});
});

describe('19. CR 702.62 Suspend Lifecycle (Exile with Time Counters, Upkeep Tick-Down & Free Cast with Haste)', () => {
	it('suspends Sol Talisman from hand into Exile with 3 time counters, ticks down on upkeep, and casts it for free when the last counter is removed', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];
		p1.hand = [];
		p2.hand = [];

		const talisman = addCardToZone(state, p1Id, getCardByName('Sol Talisman')!, 'hand');

		// Cannot cast Sol Talisman normally from hand (it has no mana cost)
		assert.equal(checkSpellCastLegality(state, p1Id, talisman, 'hand').ok, false);

		// Suspend Sol Talisman for {1} -> exiled with 3 time counters
		const suspRes = applyGameAction(state, p1Id, {
			type: 'suspend_card',
			instanceId: talisman.instanceId
		});
		assert.equal(suspRes.ok, true);
		assert.equal(p1.exile.length, 1);
		assert.equal(p1.exile[0].isSuspended, true);
		assert.equal(p1.exile[0].counters.time, 3);

		// Pass 3 of Alice's upkeeps -> counters tick 3 -> 2 -> 1 -> 0 and Sol Talisman is cast for free onto the battlefield!
		for (let cycle = 0; cycle < 3; cycle++) {
			p1.hand = [];
			p2.hand = [];
			applyGameAction(state, p1Id, { type: 'end_turn' }); // Alice -> Bob
			p2.hand = [];
			applyGameAction(state, p2.playerId, { type: 'end_turn' }); // Bob -> Alice's next turn (runs upkeep!)
		}

		assert.equal(p1.exile.length, 0, 'Sol Talisman left Exile after last time counter was removed');
		assert.equal(
			p1.battlefield.some((b) => b.card.name === 'Sol Talisman'),
			true,
			'Sol Talisman was automatically cast for free and entered the battlefield!'
		);
	});
});

describe('20. CR 404.2 Graveyard Ordering (Nether Shadow, Corpse Dance) & CR 702.26 Phasing (Teferi\'s Protection)', () => {
	it('respects graveyard card ordering (CR 404.2) for Nether Shadow upkeep return and Corpse Dance top-creature reanimation', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];
		p1.hand = [];
		p2.hand = [];

		// Put Nether Shadow at the bottom of graveyard, followed by 2 creatures above it (not enough yet)
		const shadow = addCardToZone(state, p1Id, getCardByName('Nether Shadow')!, 'graveyard');
		const elf1 = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'graveyard');
		const elf2 = addCardToZone(state, p1Id, getCardByName('Elvish Mystic')!, 'graveyard');

		// Reorder graveyard so Nether Shadow is at the TOP (above elf1 and elf2) even after adding a 3rd creature
		const elf3 = addCardToZone(state, p1Id, getCardByName('Fyndhorn Elves')!, 'graveyard');
		applyGameAction(state, p1Id, {
			type: 'reorder_graveyard',
			instanceIds: [elf1.instanceId, elf2.instanceId, elf3.instanceId, shadow.instanceId]
		});

		// Corpse Dance reanimates the TOP creature card of your graveyard (which is now Nether Shadow!)
		// Let's reorder so Nether Shadow is at the bottom (index 0) with 3 creatures above it!
		applyGameAction(state, p1Id, {
			type: 'reorder_graveyard',
			instanceIds: [shadow.instanceId, elf1.instanceId, elf2.instanceId, elf3.instanceId]
		});

		// Pass turn to Bob and back to Alice's upkeep -> Nether Shadow sees 3 creatures above it and returns to battlefield!
		applyGameAction(state, p1Id, { type: 'end_turn' });
		p2.hand = [];
		applyGameAction(state, p2.playerId, { type: 'end_turn' });

		assert.equal(
			p1.battlefield.some((b) => b.instanceId === shadow.instanceId),
			true,
			'Nether Shadow returned from graveyard to battlefield on upkeep because 3 creature cards were above it!'
		);
	});

	it('phases out permanents with Teferi\'s Protection (treating them as non-existent via findPermanentOnBoard) and phases them back in on untap without ETB triggers', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];
		p1.hand = [];
		p2.hand = [];

		const witness = addCardToZone(state, p1Id, getCardByName('Eternal Witness')!, 'battlefield');
		const teferiProt = addCardToZone(state, p1Id, getCardByName("Teferi's Protection")!, 'hand');

		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: teferiProt.instanceId
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(witness.phasedOut, true);
		assert.equal(p1.lifeTotalCannotChangeThisTurn, true);

		// Cast Wrath of God while Eternal Witness is phased out -> Eternal Witness is unaffected!
		const wrath = addCardToZone(state, p1Id, getCardByName('Wrath of God')!, 'hand');
		applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: wrath.instanceId });
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(
			p1.battlefield.some((b) => b.instanceId === witness.instanceId),
			true,
			'Phased-out Eternal Witness survived Wrath of God'
		);

		// Pass through Bob's turn back to Alice's untap step -> Eternal Witness phases back in!
		p1.hand = [];
		applyGameAction(state, p1Id, { type: 'end_turn' });
		p2.hand = [];
		applyGameAction(state, p2Id, { type: 'end_turn' });

		assert.equal(witness.phasedOut, false, 'Eternal Witness phased back in at untap step');
	});
});

describe('21. Stax Restrictions (Rule of Law, Drannith Magistrate), Flash Permissions (Vedalken Orrery) & CR 510.1c Blocked Attacker Rule', () => {
	it('enforces Rule of Law (1 spell per turn), Drannith Magistrate (no Command Zone casts), and Vedalken Orrery (cast sorceries at instant speed)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// 1. Drannith Magistrate controlled by Bob prevents Alice from casting her Commander from the Command Zone
		addCardToZone(state, p2Id, getCardByName('Drannith Magistrate')!, 'battlefield');
		const aliceCmd = state.players[0].command[0];
		assert.ok(aliceCmd);
		const cmdLegality = checkSpellCastLegality(state, p1Id, aliceCmd, 'command');
		assert.equal(cmdLegality.ok, false);
		assert.ok(cmdLegality.error?.includes('Drannith Magistrate'));

		// 2. Vedalken Orrery lets Bob cast a Sorcery on Alice's turn when holding priority
		addCardToZone(state, p2Id, getCardByName('Vedalken Orrery')!, 'battlefield');
		const cultivate = addCardToZone(state, p2Id, getCardByName('Cultivate')!, 'hand');
		state.priorityPlayerIndex = 1; // Give Bob priority on Alice's turn
		assert.equal(
			checkSpellCastLegality(state, p2Id, cultivate, 'hand').ok,
			true,
			'Vedalken Orrery allows casting Cultivate (Sorcery) on opponent turn'
		);

		// 3. Rule of Law prevents casting a second spell in the same turn
		state.priorityPlayerIndex = 0;
		addCardToZone(state, p2Id, getCardByName('Rule of Law')!, 'battlefield');
		const opt1 = addCardToZone(state, p1Id, getCardByName('Opt')!, 'hand');
		const opt2 = addCardToZone(state, p1Id, getCardByName('Brainstorm')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: opt1.instanceId }).ok,
			true
		);
		assert.equal(
			checkSpellCastLegality(state, p1Id, opt2, 'hand').ok,
			false,
			'Rule of Law blocks second spell cast this turn'
		);
	});

	it('enforces CR 510.1c: a blocked attacker without Trample deals 0 combat damage if its blocker is destroyed before combat damage', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p2 = state.players[1];
		const lifeBefore = p2.life;

		// Alice attacks with a 4/4 non-Trample creature
		const bearCard = makeTestCard({
			name: 'Runeclaw Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			oracleText: '',
			power: '4',
			toughness: '4'
		});
		const attacker = addCardToZone(state, p1Id, bearCard, 'battlefield');
		const blocker = addCardToZone(state, p2Id, getCardByName('Llanowar Elves')!, 'battlefield');

		// Advance to declare_attackers and attack Bob
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(state.phase, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);

		// Bob blocks with Llanowar Elves
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blocker.instanceId, attackerInstanceId: attacker.instanceId }]
			}).ok,
			true
		);

		// Before combat damage, Alice destroys Llanowar Elves with Infernal Grasp
		state.players[0].manaPool.B = 2;
		const grasp = addCardToZone(state, p1Id, getCardByName('Infernal Grasp')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: grasp.instanceId,
				targets: [{ kind: 'permanent', id: blocker.instanceId, label: blocker.card.name }]
			}).ok,
			true
		);
		// Resolve Infernal Grasp
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(p2.battlefield.some((b) => b.instanceId === blocker.instanceId), false);

		// Now advance to combat_damage -> attacker wasBlocked is true and has no Trample, so Bob takes 0 damage!
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(
			p2.life,
			lifeBefore,
			'Blocked attacker without Trample dealt 0 damage to defending player after its blocker was destroyed (CR 510.1c)'
		);
	});
});

describe('22. Combat Damage Forecast Layover & Aura/Equipment Attachment Helpers', () => {
	it('forecasts player & planeswalker incoming damage with live draftBlockers and resolves Aura/Equipment attachments', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// Alice controls a 5/5 Trample creature and a 3/3 normal creature; Bob controls a Planeswalker (L:4) and a 2/2 blocker
		const trampler = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Colossal Dreadmaw',
				typeLine: 'Creature — Dinosaur',
				power: '5',
				toughness: '5',
				keywords: ['Trample']
			}),
			'battlefield'
		);
		const knight = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Silver Knight',
				typeLine: 'Creature — Human Knight',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);
		const greaves = addCardToZone(state, p1Id, getCardByName('Lightning Greaves')!, 'battlefield');
		greaves.attachedToId = trampler.instanceId;

		// Verify attachment helpers
		const attachedList = getAttachedCardsOnBoard(state, trampler.instanceId);
		assert.equal(attachedList.length, 1);
		assert.equal(attachedList[0].instanceId, greaves.instanceId);
		assert.equal(getHostCardOnBoard(state, greaves.attachedToId)?.instanceId, trampler.instanceId);

		const walker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Jace, the Mind Sculptor',
				typeLine: 'Legendary Planeswalker — Jace',
				loyalty: '4'
			}),
			'battlefield'
		);
		const blocker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Grizzly Bears',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		// Advance to declare_attackers: trampler attacks Bob, knight attacks Jace
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		applyGameAction(state, p1Id, {
			type: 'declare_attackers',
			assignments: [
				{ attackerInstanceId: trampler.instanceId, defenderPlayerId: p2Id },
				{
					attackerInstanceId: knight.instanceId,
					defenderPlayerId: p2Id,
					defenderPlaneswalkerId: walker.instanceId
				}
			]
		});

		// 1. Before blockers are drafted: Bob would take 5 life loss (40 -> 35), Jace would lose 3 loyalty (4 -> 1)
		const forecastUnblocked = computeCombatDamageForecast(state, {}, {});
		assert.equal(forecastUnblocked.active, true);
		assert.equal(forecastUnblocked.playerIncoming[p2Id].totalLifeLoss, 5);
		assert.equal(forecastUnblocked.playerIncoming[p2Id].projectedLife, 35);
		assert.equal(forecastUnblocked.planeswalkerIncoming[walker.instanceId].loyaltyLoss, 3);
		assert.equal(forecastUnblocked.planeswalkerIncoming[walker.instanceId].projectedLoyalty, 1);

		// 2. Bob drafts Grizzly Bears (2/2) blocking Colossal Dreadmaw (5/5 Trample) -> 2 absorbed, 3 tramples over to Bob (40 -> 37), and Grizzly Bears dies!
		const forecastWithDraftBlock = computeCombatDamageForecast(
			state,
			{},
			{ [blocker.instanceId]: trampler.instanceId }
		);
		assert.equal(forecastWithDraftBlock.playerIncoming[p2Id].totalLifeLoss, 3);
		assert.equal(forecastWithDraftBlock.playerIncoming[p2Id].trampleThroughDamage, 3);
		assert.equal(forecastWithDraftBlock.playerIncoming[p2Id].projectedLife, 37);
		assert.equal(forecastWithDraftBlock.blockerSummaries[blocker.instanceId].blockerDies, true);
	});

	it('parses Ponder accurately ("Look at the top three cards... put them back in any order. You may shuffle. Draw a card.") and supports exact card rearrangement in both Ponder and Scry', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		const ponderCard = getCardByName('Ponder')!;
		assert.ok(
			ponderCard.oracleText.includes('Look at the top three cards of your library, then put them back in any order. You may shuffle.'),
			'Ponder has its real Oracle text instead of Scry 3'
		);
		const parsedPonder = parseSpellOrAbilityEffects(ponderCard);
		assert.equal(parsedPonder.effects[0].kind, 'rearrange_top');
		assert.equal(parsedPonder.effects[0].amount, 3);
		assert.equal(parsedPonder.effects[0].mayShuffle, true);
		assert.equal(parsedPonder.effects[1].kind, 'draw');

		// Put 3 known cards on top of Alice's library: [cardA, cardB, cardC]
		const cardA = createCardInstance(getCardByName('Island')!, p1Id, 'library');
		const cardB = createCardInstance(getCardByName('Counterspell')!, p1Id, 'library');
		const cardC = createCardInstance(getCardByName('Sol Ring')!, p1Id, 'library');
		p1.library.unshift(cardA, cardB, cardC);

		const ponderInst = addCardToZone(state, p1Id, ponderCard, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: ponderInst.instanceId }).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		// Ponder creates a rearrange_top prompt (allowBottom: false, allowShuffle: true)
		const prompt = state.pendingPrompts.find((pr) => pr.playerId === p1Id && pr.kind === 'scry_choice')!;
		assert.ok(prompt);
		assert.equal(prompt.allowBottom, false);
		assert.equal(prompt.allowShuffle, true);

		// Rearrange the top 3 so cardC (Sol Ring) is #1 (drawn immediately!), cardA (Island) is #2, cardB (Counterspell) is #3
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'scry_resolve',
				topInstanceIds: [cardC.instanceId, cardA.instanceId, cardB.instanceId],
				bottomInstanceIds: [],
				shuffleAfter: false
			}).ok,
			true
		);

		// Sol Ring (#1) was drawn into Alice's hand, and the new top 2 cards of Alice's library are [cardA (Island), cardB (Counterspell)]!
		assert.equal(p1.hand.some((h) => h.instanceId === cardC.instanceId), true, 'Sol Ring (#1 rearranged) was drawn');
		assert.equal(p1.library[0].instanceId, cardA.instanceId, 'Island is now #1 on top of library');
		assert.equal(p1.library[1].instanceId, cardB.instanceId, 'Counterspell is now #2 on top of library');
	});

	it('prompts human players to choose their land when resolving Farseek (allowing Plains/Island/Swamp/Mountain and rejecting Forest)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		const forest = createCardInstance(getCardByName('Forest')!, p1Id, 'library');
		const island = createCardInstance(getCardByName('Island')!, p1Id, 'library');
		p1.library.unshift(forest, island);

		const farseek = addCardToZone(state, p1Id, getCardByName('Farseek')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: farseek.instanceId }).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		// Farseek opens a search_library prompt for human player instead of auto-picking
		const prompt = state.pendingPrompts.find((pr) => pr.playerId === p1Id && pr.kind === 'search_library')!;
		assert.ok(prompt, 'Farseek created a search_library prompt for human player');
		assert.equal(prompt.destinationZone, 'battlefield');
		assert.equal(prompt.enterTapped, true);
		assert.equal(prompt.candidateInstanceIds?.includes(island.instanceId), true);
		assert.equal(prompt.candidateInstanceIds?.includes(forest.instanceId), false, 'Forest is not eligible for Farseek');

		// Picking Forest is rejected
		assert.equal(
			applyGameAction(state, p1Id, { type: 'search_library_pick', instanceId: forest.instanceId }).ok,
			false
		);

		// Picking Island puts it onto the battlefield tapped
		assert.equal(
			applyGameAction(state, p1Id, { type: 'search_library_pick', instanceId: island.instanceId }).ok,
			true
		);
		const onBoard = p1.battlefield.find((b) => b.instanceId === island.instanceId);
		assert.ok(onBoard, 'Chosen Island was put onto the battlefield');
		assert.equal(onBoard?.tapped, true, 'Chosen Island entered tapped');
	});
});

describe('23. General LibrarySearchSpec Grammar & Opposition Agent Rules Engine', () => {
	it('parses general "search your library for [criteria]" clauses into LibrarySearchSpec without hardcoded card edge cases', () => {
		const farseekSpec = parseLibrarySearchSpec(getCardByName('Farseek')!.oracleText)!;
		assert.equal(farseekSpec.statedQuality, true);
		assert.deepEqual(farseekSpec.allowedSubtypes, ['Plains', 'Island', 'Swamp', 'Mountain']);
		assert.equal(farseekSpec.destinations[0].zone, 'battlefield');
		assert.equal(farseekSpec.destinations[0].tapped, true);
		assert.equal(matchesLibrarySearchSpec(getCardByName('Island')!, farseekSpec), true);
		assert.equal(matchesLibrarySearchSpec(getCardByName('Forest')!, farseekSpec), false);

		const naturesLoreSpec = parseLibrarySearchSpec(getCardByName("Nature's Lore")!.oracleText)!;
		assert.equal(naturesLoreSpec.statedQuality, true);
		assert.deepEqual(naturesLoreSpec.allowedSubtypes, ['Forest']);
		assert.equal(naturesLoreSpec.destinations[0].zone, 'battlefield');
		assert.equal(naturesLoreSpec.destinations[0].tapped, false, "Nature's Lore puts Forest onto the battlefield untapped");
		assert.equal(matchesLibrarySearchSpec(getCardByName('Forest')!, naturesLoreSpec), true);
		assert.equal(matchesLibrarySearchSpec(getCardByName('Island')!, naturesLoreSpec), false);

		const cultivateSpec = parseLibrarySearchSpec(getCardByName('Cultivate')!.oracleText)!;
		assert.equal(cultivateSpec.statedQuality, true);
		assert.equal(cultivateSpec.upTo, true);
		assert.equal(cultivateSpec.count, 2);
		assert.equal(cultivateSpec.requireBasic, true);
		assert.deepEqual(cultivateSpec.allowedTypes, ['Land']);
		assert.equal(cultivateSpec.destinations.length, 2);
		assert.deepEqual(cultivateSpec.destinations[0], { zone: 'battlefield', tapped: true });
		assert.deepEqual(cultivateSpec.destinations[1], { zone: 'hand' });

		const mysticalSpec = parseLibrarySearchSpec(getCardByName('Mystical Tutor')!.oracleText)!;
		assert.equal(mysticalSpec.statedQuality, true);
		assert.deepEqual(mysticalSpec.allowedTypes, ['Instant', 'Sorcery']);
		assert.deepEqual(mysticalSpec.destinations[0], { zone: 'library', onTop: true });
		assert.equal(matchesLibrarySearchSpec(getCardByName('Counterspell')!, mysticalSpec), true);
		assert.equal(matchesLibrarySearchSpec(getCardByName('Sol Ring')!, mysticalSpec), false);

		const steelshaperSpec = parseLibrarySearchSpec(getCardByName("Steelshaper's Gift")!.oracleText)!;
		assert.equal(steelshaperSpec.statedQuality, true);
		assert.deepEqual(steelshaperSpec.allowedSubtypes, ['Equipment']);
		assert.equal(matchesLibrarySearchSpec(getCardByName('Lightning Greaves')!, steelshaperSpec), true);
		assert.equal(matchesLibrarySearchSpec(getCardByName('Sol Ring')!, steelshaperSpec), false);

		const demonicSpec = parseLibrarySearchSpec(getCardByName('Demonic Tutor')!.oracleText)!;
		assert.equal(demonicSpec.statedQuality, false, 'Unrestricted "a card" tutor does not state a quality');
		assert.equal(demonicSpec.upTo, false);
		assert.deepEqual(demonicSpec.destinations[0], { zone: 'hand' });
	});

	it('implements Opposition Agent: intercepts opponent library searches, enforces statedQuality vs mandatory find (CR 701.19b), exiles found cards, and allows playing exiled lands and spells spending mana as any color', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// Bob (P2) controls Opposition Agent on the battlefield
		addCardToZone(state, p2Id, getCardByName('Opposition Agent')!, 'battlefield');

		// Put known cards into Alice's (P1's) library: Forest, Island, Counterspell ({U}{U})
		const forest = createCardInstance(getCardByName('Forest')!, p1Id, 'library');
		const island = createCardInstance(getCardByName('Island')!, p1Id, 'library');
		const counterspell = createCardInstance(getCardByName('Counterspell')!, p1Id, 'library');
		p1.library.unshift(forest, island, counterspell);

		// 1. Alice casts Farseek (statedQuality: true -> Plains/Island/Swamp/Mountain)
		const farseek = addCardToZone(state, p1Id, getCardByName('Farseek')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: farseek.instanceId }).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		// Opposition Agent intercepts the search: Bob (p2Id) receives the search_library prompt targeting Alice's library (p1Id)!
		const farseekPrompt = state.pendingPrompts.find((pr) => pr.kind === 'search_library')!;
		assert.ok(farseekPrompt, 'Search prompt created');
		assert.equal(farseekPrompt.playerId, p2Id, 'Opposition Agent controller (Bob) controls the search decision');
		assert.equal(farseekPrompt.targetLibraryOwnerId, p1Id, 'Target library is Alice');
		assert.equal(farseekPrompt.canFailToFind, true, 'Farseek states a card quality so Fail to Find is legal');

		// Verify sanitizeGameStateForViewer exposes Alice's library to Bob during the intercepted search
		const sanitizedForBob = sanitizeGameStateForViewer(state, p2Id);
		assert.ok(
			sanitizedForBob.players[0].library.length > 0,
			'Opposition Agent controller can view the searched opponent library'
		);

		// Bob cannot have Alice find a card that doesn't match the search instruction (e.g. Counterspell or Forest)
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'search_library_pick',
				instanceId: counterspell.instanceId
			}).ok,
			false,
			'Cannot find a non-matching card with Farseek'
		);

		// Bob picks Alice's Island -> Island is exiled instead of entering Alice's battlefield, with playableFromExileBy granted to Bob!
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'search_library_pick',
				instanceId: island.instanceId
			}).ok,
			true
		);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === island.instanceId),
			false,
			'Island did NOT enter Alice battlefield'
		);
		const exiledIsland = p1.exile.find((c) => c.instanceId === island.instanceId);
		assert.ok(exiledIsland, 'Island was exiled into Alice exile zone');
		assert.equal(exiledIsland?.playableFromExileBy?.playerId, p2Id);

		// 2. Next, Alice casts Vampiric Tutor ("Search your library for a card, then shuffle and put that card on top.\nYou lose 2 life.")
		const lifeBeforeVamp = p1.life;
		const vampTutor = addCardToZone(state, p1Id, getCardByName('Vampiric Tutor')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: vampTutor.instanceId }).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		const vampPrompt = state.pendingPrompts.find((pr) => pr.kind === 'search_library')!;
		assert.ok(vampPrompt);
		assert.equal(vampPrompt.playerId, p2Id);
		assert.equal(
			vampPrompt.canFailToFind,
			false,
			'Vampiric Tutor searches for "a card" without a stated quality, so Fail to Find is illegal'
		);

		// Bob attempts to Fail to Find on Vampiric Tutor -> strictly rejected (CR 701.19b)!
		const failAttempt = applyGameAction(state, p2Id, {
			type: 'search_library_pick',
			instanceId: null
		});
		assert.equal(failAttempt.ok, false, 'Cannot Fail to Find on an unrestricted tutor');

		// Bob picks Alice's Counterspell ({U}{U}) -> Counterspell is exiled with playableFromExileBy + spendManaAsAnyColor, AND Alice still loses 2 life!
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'search_library_pick',
				instanceId: counterspell.instanceId
			}).ok,
			true
		);
		assert.equal(p1.life, lifeBeforeVamp - 2, 'Vampiric Tutor continuation effect (lose 2 life) still applied to Alice');
		const exiledCounterspell = p1.exile.find((c) => c.instanceId === counterspell.instanceId);
		assert.ok(exiledCounterspell, 'Counterspell was exiled');
		assert.equal(exiledCounterspell?.playableFromExileBy?.playerId, p2Id);
		assert.equal(exiledCounterspell?.playableFromExileBy?.spendManaAsAnyColor, true);

		// 3. While it is still Alice's turn, Bob cannot play the exiled Island (timing restriction: lands can only be played on your own turn),
		//    EVEN THOUGH Bob CAN cast the exiled Counterspell at Instant speed spending {B}{B} as though it were mana of any color!
		assert.equal(checkLandPlayLegality(state, p2Id, exiledIsland!, 'exile').ok, false);

		// Alice casts Sol Ring; Bob responds by casting the exiled Counterspell ({U}{U}) using {B}{B} in Bob's mana pool!
		const solRing = addCardToZone(state, p1Id, getCardByName('Sol Ring')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: solRing.instanceId }).ok,
			true
		);
		const solRingStackId = state.stack[0].id;
		applyGameAction(state, p1Id, { type: 'pass_priority' });

		// Give Bob {B}{B} (no Blue mana!)
		p2.manaPool = { W: 0, U: 0, B: 2, R: 0, G: 0, C: 0 };
		assert.equal(
			checkSpellCastLegality(state, p2Id, exiledCounterspell!, 'exile').ok,
			true,
			'Bob can cast exiled Counterspell ({U}{U}) spending {B}{B} as though it were mana of any color'
		);
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'cast_spell',
				instanceId: exiledCounterspell!.instanceId,
				fromZone: 'exile',
				targets: [{ kind: 'stack', id: solRingStackId, label: 'Sol Ring' }]
			}).ok,
			true
		);
		assert.equal(p2.manaPool.B, 0, '{B}{B} was spent to pay {U}{U}');

		// Pass priority to resolve Counterspell -> Sol Ring is countered, and Alice's Counterspell goes to Alice's graveyard (ownerId preserved)!
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		assert.equal(state.stack.length, 0);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === counterspell.instanceId),
			true,
			'Exiled Counterspell went to its owner (Alice) graveyard after resolving'
		);

		// 4. Advance to Bob's turn -> Bob plays Alice's exiled Island from Exile (obeying land play limits)!
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'main1';
		p2.landsPlayedThisTurn = 0;
		p2.maxLandsPerTurn = 1;

		assert.equal(checkLandPlayLegality(state, p2Id, exiledIsland!, 'exile').ok, true);
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'play_land',
				instanceId: exiledIsland!.instanceId,
				fromZone: 'exile'
			}).ok,
			true
		);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === island.instanceId),
			true,
			'Exiled Island entered the battlefield under Bob control'
		);
		assert.equal(p2.landsPlayedThisTurn, 1, 'Playing exiled land used Bob land play for the turn');
	});

	it('honors timestamp precedence when multiple players control Opposition Agent, and removes exiled cards when their owner leaves a multiplayer game (CR 800.4a)', () => {
		const deck = PRECON_DECKS[0];
		const seats: LobbySeat[] = [0, 1, 2].map((i) => ({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `Player ${i + 1}`,
			avatarUrl: '',
			isBot: false,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: deck.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		}));
		const decksBySeat = new Map([
			[0, deck],
			[1, deck],
			[2, deck]
		]);
		const state = createInitialGameState('MP3', seats, decksBySeat, DEFAULT_LOBBY_RULES);
		applyGameAction(state, 'p1', { type: 'mulligan_keep' });
		applyGameAction(state, 'p2', { type: 'mulligan_keep' });
		applyGameAction(state, 'p3', { type: 'mulligan_keep' });

		// P2 has an older Opposition Agent (enteredTimestamp = 300), P3 has a newer Opposition Agent (enteredTimestamp = 450)
		const agentP2 = addCardToZone(state, 'p2', getCardByName('Opposition Agent')!, 'battlefield');
		agentP2.enteredTimestamp = 300;
		const agentP3 = addCardToZone(state, 'p3', getCardByName('Opposition Agent')!, 'battlefield');
		agentP3.enteredTimestamp = 450;

		const interceptor = getLibrarySearchInterceptor(state, 'p1');
		assert.ok(interceptor);
		assert.equal(
			interceptor?.controllerId,
			'p3',
			'Most recently entered Opposition Agent (P3) wins timestamp precedence'
		);

		// Give P1 a Demonic Tutor and resolve it -> P3 controls P1's search and gets the exile play permission
		for (let i = 0; i < 4; i++) {
			addCardToZone(state, 'p1', getCardByName('Swamp')!, 'battlefield');
		}
		const targetCard = state.players[0].library[0];
		const tutor = addCardToZone(state, 'p1', getCardByName('Demonic Tutor')!, 'hand');
		assert.equal(
			applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: tutor.instanceId }).ok,
			true
		);
		applyGameAction(state, 'p1', { type: 'pass_priority' });
		applyGameAction(state, 'p2', { type: 'pass_priority' });
		applyGameAction(state, 'p3', { type: 'pass_priority' });

		const prompt = state.pendingPrompts.find((pr) => pr.kind === 'search_library')!;
		assert.equal(prompt.playerId, 'p3');
		assert.equal(
			applyGameAction(state, 'p3', {
				type: 'search_library_pick',
				instanceId: targetCard.instanceId
			}).ok,
			true
		);
		assert.equal(
			state.players[0].exile.find((c) => c.instanceId === targetCard.instanceId)?.playableFromExileBy?.playerId,
			'p3'
		);

		// Now P1 loses the game in multiplayer (life drops to 0) -> all cards P1 owns in Exile leave the game (CR 800.4a)!
		state.players[0].life = 0;
		checkStateBasedActions(state);
		assert.equal(state.players[0].lost, true);
		assert.equal(
			state.players[0].exile.length,
			0,
			'Cards owned by eliminated player in Exile left the game (CR 800.4a)'
		);
	});
});

describe('24. Stage A: Live Bug Fixes (A1 Intervening-If, A2 End Step Scope, A3 Overload Cost, A4 Upkeep Stack)', () => {
	it('A1 & A4: enforces intervening-if on Felidar Sovereign and synthetic upkeep triggers, pushes upkeep triggers onto the stack, and rechecks intervening-if on resolution (CR 603.4)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		p1.hand = [];
		state.players[1].hand = [];

		// 1. Felidar Sovereign at 20 life must NOT trigger or win on upkeep
		addCardToZone(state, p1Id, getCardByName('Felidar Sovereign')!, 'battlefield');
		p1.life = 20;
		runBeginningOfTurn(state);
		assert.equal(state.status, 'active', 'Felidar Sovereign at 20 life does not win the game');
		assert.equal(state.winnerPlayerId, null);
		assert.equal(state.stack.length, 0, 'Intervening-if false on upkeep means trigger does not go onto stack (CR 603.4)');

		// 2. Unrecognised intervening-if condition ("if the stars align, you win the game") must NOT fire unconditionally
		const mysteryCard = makeTestCard({
			name: 'Astrological Sphinx',
			typeLine: 'Creature — Sphinx',
			oracleText: 'At the beginning of your upkeep, if the stars align, you win the game.',
			power: '4',
			toughness: '4'
		});
		addCardToZone(state, p1Id, mysteryCard, 'battlefield');
		runBeginningOfTurn(state);
		assert.equal(state.status, 'active', 'Unrecognised intervening-if condition never executes unconditionally');
		assert.equal(state.stack.length, 0);

		// 3. Synthetic "if you have 40 or more life, draw a card" creature draws only at 40+ life and uses the upkeep stack
		p1.battlefield = [];
		const sageCard = makeTestCard({
			name: 'Vitality Chronicler',
			typeLine: 'Creature — Cleric',
			oracleText: 'At the beginning of your upkeep, if you have 40 or more life, draw a card.',
			power: '2',
			toughness: '2'
		});
		addCardToZone(state, p1Id, sageCard, 'battlefield');
		p1.life = 25;
		const handBefore25 = p1.hand.length;
		runBeginningOfTurn(state);
		// Only normal draw step card (1 card), no upkeep trigger draw
		assert.equal(p1.hand.length, handBefore25 + 1, 'Did not trigger upkeep draw at 25 life');

		p1.life = 40;
		const handBefore40 = p1.hand.length;
		runBeginningOfTurn(state);
		assert.equal(state.phase, 'upkeep', 'Upkeep trigger paused turn progression in upkeep step');
		assert.equal(state.stack.length, 1, 'Upkeep trigger is on the stack');
		// Resolve the upkeep trigger on the stack
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(p1.hand.length, handBefore40 + 1, 'Upkeep trigger resolved and drew 1 card');
		// Pass priority on empty upkeep stack to advance through Draw Step into Main Phase 1
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(state.phase, 'main1', 'Advanced to main1 after upkeep stack resolved');
		assert.equal(p1.hand.length, handBefore40 + 2, 'Normal turn draw also occurred when advancing from upkeep to main1');

		// 4. Felidar Sovereign at 40 life puts trigger on stack; if life drops below 40 before resolution, CR 603.4 prevents win; at 40+ life, resolving wins!
		p1.battlefield = [];
		addCardToZone(state, p1Id, getCardByName('Felidar Sovereign')!, 'battlefield');
		p1.life = 40;
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 1, 'Felidar Sovereign trigger on stack at 40 life');
		// Simulate opponent dropping Alice's life to 37 while trigger is on the stack
		p1.life = 37;
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(state.status, 'active', 'CR 603.4: Felidar trigger did not resolve when life dropped to 37 before resolution');

		// Now at 42 life without interruption, resolving Felidar trigger wins the game!
		p1.life = 42;
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 1);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(state.status, 'finished', 'Felidar Sovereign won the game on upkeep trigger resolution at 42 life');
		assert.equal(state.winnerPlayerId, p1Id);
	});

	it('A2: respects end-step trigger scope ("your end step" vs "each end step"), checks ability loss, and proliferates Atraxa exactly once', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		const atraxa = addCardToZone(state, p1Id, getCardByName("Atraxa, Praetors' Voice")!, 'battlefield');
		atraxa.counters['+1/+1'] = 1;

		// 1. Opponent's (P2's) end step: Atraxa ("At the beginning of your end step, proliferate.") must NOT trigger!
		state.activePlayerIndex = 1;
		enterEndStep(state, p2);
		assert.equal(state.stack.length, 0, 'Atraxa does not trigger on opponent end step');
		assert.equal(atraxa.counters['+1/+1'], 1, 'No counter added on opponent end step');

		// 2. Controller's (P1's) end step: Atraxa puts 1 trigger on stack (does NOT proliferate immediately before resolution), then proliferates once when resolved!
		state.activePlayerIndex = 0;
		enterEndStep(state, p1);
		assert.equal(atraxa.counters['+1/+1'], 1, 'Atraxa did not proliferate immediately before stack resolution');
		assert.equal(state.stack.length, 1, 'Exactly one Atraxa trigger on the stack');
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(atraxa.counters['+1/+1'], 2, 'Atraxa proliferated exactly once when trigger resolved');

		// 3. Under Humility, Atraxa loses all abilities and does NOT trigger on P1's end step
		const humility = makeTestCard({
			name: 'Humility',
			typeLine: 'Enchantment',
			oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
		});
		const humInst = addCardToZone(state, p2Id, humility, 'battlefield');
		state.activePlayerIndex = 0;
		enterEndStep(state, p1);
		assert.equal(state.stack.length, 0, 'Atraxa does not trigger while Humility removes its abilities');
		p2.battlefield = p2.battlefield.filter((b) => b.instanceId !== humInst.instanceId);

		// 4. Synthetic "At the beginning of each end step, draw a card." triggers on both P1's and P2's end steps
		p1.battlefield = [];
		const eachEndCard = makeTestCard({
			name: 'Twilight Sentinel',
			typeLine: 'Creature — Spirit',
			oracleText: 'At the beginning of each end step, draw a card.',
			power: '1',
			toughness: '3'
		});
		addCardToZone(state, p1Id, eachEndCard, 'battlefield');
		state.activePlayerIndex = 1;
		enterEndStep(state, p2);
		assert.equal(state.stack.length, 1, '"At the beginning of each end step" triggers on opponent turn too');
	});

	it('A3: evaluates Overload cost ({6}{U} for Cyclonic Rift and {4}{R} for synthetic Overload card) via cast.overload ActionRuleNode', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		const riftCard = getCardByName('Cyclonic Rift')!;
		const riftTree = getCardRuleTree(riftCard);
		const overloadNode = riftTree.actions.find((a) => a.path === 'cast.overload');
		assert.ok(overloadNode, 'Cyclonic Rift compiles a cast.overload ActionRuleNode');
		assert.equal(overloadNode?.manaCost, '{6}{U}');

		const riftInst = addCardToZone(state, p1Id, riftCard, 'hand');
		const normalReq = getSpellCostRequirement(p1, riftInst, state, 0);
		assert.equal(normalReq.generic, 1);
		assert.equal(normalReq.colored.U, 1);

		const overloadReq = getSpellCostRequirement(p1, riftInst, state, 1);
		assert.equal(overloadReq.generic, 6, 'Overloaded Cyclonic Rift requires {6} generic');
		assert.equal(overloadReq.colored.U, 1, 'Overloaded Cyclonic Rift requires {U}');

		const synthOverload = makeTestCard({
			name: 'Aether Wave',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Aether Wave deals 2 damage to target creature you don\'t control.\nOverload {4}{R}'
		});
		const synthInst = addCardToZone(state, p1Id, synthOverload, 'hand');
		const synthNormal = getSpellCostRequirement(p1, synthInst, state, 0);
		assert.equal(synthNormal.generic, 1);
		assert.equal(synthNormal.colored.R, 1);

		const synthOverloaded = getSpellCostRequirement(p1, synthInst, state, 1);
		assert.equal(synthOverloaded.generic, 4, 'Synthetic Overload card requires {4} generic when overloaded');
		assert.equal(synthOverloaded.colored.R, 1, 'Synthetic Overload card requires {R} when overloaded');
	});
});

// ============================================================================
// 25. Stage B: Correctness Fixes (B1 Stack Owner Zone, B2 Hook Phasing/Ability Loss, B3 Counter Multipliers, B4 Swords Controller Life, B5 Land ETB)
// ============================================================================
describe('25. Stage B: Correctness Fixes (B1 Stack Owner Zone, B2 Hook Phasing/Ability Loss, B3 Counter Multipliers, B4 Swords Controller Life, B5 Land ETB)', () => {
	it('B1: puts countered or Time-Stopped spells cast from opponent exile into their owner graveyard/exile (not caster)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// 1. Bob owns Opt in Exile with playableFromExileBy permission for Alice (e.g. via Opposition Agent)
		const bobOpt = addCardToZone(state, p2Id, getCardByName('Opt')!, 'exile');
		bobOpt.ownerId = p2Id;
		bobOpt.playableFromExileBy = {
			playerId: p1Id,
			spendManaAsAnyColor: true,
			sourceName: 'Opposition Agent'
		};

		p1.manaPool.U = 3;
		p2.manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: bobOpt.instanceId,
				fromZone: 'exile'
			}).ok,
			true
		);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].ownerId, p2Id);
		assert.equal(state.stack[0].controllerId, p1Id);

		// Bob counters Alice's cast of Bob's Opt with Counterspell -> Opt must go to BOB's graveyard, NOT Alice's!
		const counterspell = addCardToZone(state, p2Id, getCardByName('Counterspell')!, 'hand');
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'cast_spell',
				instanceId: counterspell.instanceId,
				targets: [{ kind: 'stack', id: state.stack[0].id, label: 'Opt' }]
			}).ok,
			true
		);
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		applyGameAction(state, p1Id, { type: 'pass_priority' });

		assert.equal(
			p2.graveyard.some((c) => c.instanceId === bobOpt.instanceId),
			true,
			"Countered spell owned by Bob goes to Bob's graveyard"
		);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === bobOpt.instanceId),
			false,
			"Countered spell owned by Bob does NOT go to Alice's graveyard"
		);

		// 2. Bob owns Ponder in Exile, Alice casts it, and Time Stop / Obeka exiles the stack -> goes to Bob's exile, not Alice's!
		const bobPonder = addCardToZone(state, p2Id, getCardByName('Ponder')!, 'exile');
		bobPonder.ownerId = p2Id;
		bobPonder.playableFromExileBy = {
			playerId: p1Id,
			spendManaAsAnyColor: true,
			sourceName: 'Opposition Agent'
		};
		p1.manaPool.U = 1;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: bobPonder.instanceId,
				fromZone: 'exile'
			}).ok,
			true
		);
		const obeka = addCardToZone(
			state,
			p1Id,
			getCardByName('Obeka, Brute Chronologist')!,
			'battlefield'
		);
		const obekaAb = getEffectiveActivatedAbilities(state, p1, obeka, ['U', 'B', 'R'])[0]!;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'activate_ability',
				instanceId: obeka.instanceId,
				abilityId: obekaAb.id
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(
			p2.exile.some((c) => c.instanceId === bobPonder.instanceId),
			true,
			"Exiled stack spell owned by Bob goes to Bob's exile"
		);
		assert.equal(
			p1.exile.some((c) => c.instanceId === bobPonder.instanceId),
			false,
			"Exiled stack spell owned by Bob does NOT go to Alice's exile"
		);
	});

	it('B2: skips phased-out and ability-stripped battlefield permanents in collectActiveBoardHooks while keeping Command-zone Eminence hooks', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		p1.command = [];
		p1.battlefield = [];

		const electro = addCardToZone(
			state,
			p1Id,
			getCardByName('Goblin Electromancer')!,
			'battlefield'
		);
		assert.equal(
			collectActiveBoardHooks(state).some((h) => h.sourceInstanceId === electro.instanceId),
			true
		);

		// 1. Phased-out Goblin Electromancer does not contribute hooks
		electro.phasedOut = true;
		assert.equal(
			collectActiveBoardHooks(state).some((h) => h.sourceInstanceId === electro.instanceId),
			false,
			'Phased-out permanent is skipped by collectActiveBoardHooks'
		);
		electro.phasedOut = false;

		// 2. Humility strips abilities from battlefield creatures, so Goblin Electromancer does not contribute hooks
		const humility = addCardToZone(state, p1Id, getCardByName('Humility')!, 'battlefield');
		assert.equal(
			collectActiveBoardHooks(state).some((h) => h.sourceInstanceId === electro.instanceId),
			false,
			'Ability-stripped creature is skipped by collectActiveBoardHooks'
		);

		// 3. The Ur-Dragon in the Command zone still contributes its Eminence hook even while Humility is on the battlefield
		const urDragonCmd = addCardToZone(state, p1Id, getCardByName('The Ur-Dragon')!, 'command');
		assert.equal(
			collectActiveBoardHooks(state).some((h) => h.sourceInstanceId === urDragonCmd.instanceId),
			true,
			'Command-zone Eminence hook remains active'
		);
		assert.ok(humility);
	});

	it('B3: applies Corpsejack Menace (and synthetic counter-multiplier hooks) to targeted +1/+1 counters (Slip Out the Back) and checks the receiving permanent controller', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		addCardToZone(state, p1Id, getCardByName('Corpsejack Menace')!, 'battlefield');
		const elf = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'battlefield');

		// Cast Slip Out the Back targeting Llanowar Elves ("Put a +1/+1 counter on target creature. It phases out.")
		p1.manaPool.U = 1;
		const slip = addCardToZone(state, p1Id, getCardByName('Slip Out the Back')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: slip.instanceId,
				targets: [{ kind: 'permanent', id: elf.instanceId, label: elf.card.name }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(
			elf.counters['+1/+1'],
			2,
			'Corpsejack Menace doubled the +1/+1 counter placed by add_counters_target (Slip Out the Back)'
		);
	});

	it('B4 & B5: gives Swords to Plowshares life to the target creature controller (not owner), and fires triggerOnEtb when lands enter', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// B4: Creature owned by Alice (`ownerId = p1Id`) but controlled by Bob (`controllerId = p2Id` on Bob's battlefield)
		const stolenBear = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Stolen Bear',
				typeLine: 'Creature — Bear',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		stolenBear.ownerId = p1Id;
		stolenBear.controllerId = p2Id;

		const p1LifeBefore = p1.life;
		const p2LifeBefore = p2.life;
		p1.manaPool.W = 1;
		const swords = addCardToZone(state, p1Id, getCardByName('Swords to Plowshares')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: swords.instanceId,
				targets: [{ kind: 'permanent', id: stolenBear.instanceId, label: stolenBear.card.name }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		assert.equal(
			p2.life,
			p2LifeBefore + 4,
			'Swords to Plowshares gave 4 life to the creature controller (Bob)'
		);
		assert.equal(
			p1.life,
			p1LifeBefore,
			'Swords to Plowshares did NOT give life to the non-controlling owner (Alice)'
		);

		// B5: Playing a land with an ETB trigger ("When Radiant Fountain enters, you gain 2 life.") fires triggerOnEtb
		const fountainCard = makeTestCard({
			name: 'Radiant Fountain',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText: 'When Radiant Fountain enters, you gain 2 life.\n{T}: Add {C}.'
		});
		const fountain = addCardToZone(state, p1Id, fountainCard, 'hand');
		const lifeBeforeLand = p1.life;
		assert.equal(
			applyGameAction(state, p1Id, { type: 'play_land', instanceId: fountain.instanceId }).ok,
			true
		);
		assert.equal(
			p1.life,
			lifeBeforeLand + 2,
			'Playing a land fired triggerOnEtb and gained 2 life'
		);
	});
});

// ============================================================================
// 26. Stage C: Grammar-Driven Triggers, Target-Controller Effects, Cost Modifiers, Overload & Dynamic Mana (C1-C8)
// ============================================================================
describe('26. Stage C: Grammar-Driven Triggers, Target-Controller Effects, Cost Modifiers, Overload & Dynamic Mana (C1-C8)', () => {
	it('C1: evaluates graveyard upkeep return triggers for both Nether Shadow and a synthetic card with a different name and threshold', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		const synthWraithCard = makeTestCard({
			name: 'Crypt Wraith',
			typeLine: 'Creature — Wraith',
			oracleText:
				'At the beginning of your upkeep, if Crypt Wraith is in your graveyard with two or more creature cards above it, you may put Crypt Wraith onto the battlefield.',
			power: '2',
			toughness: '2'
		});
		const wraith = addCardToZone(state, p1Id, synthWraithCard, 'graveyard');
		const c1 = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'graveyard');

		// Only 1 creature above Crypt Wraith -> does NOT return
		runBeginningOfTurn(state);
		assert.equal(
			p1.battlefield.some((b) => b.instanceId === wraith.instanceId),
			false,
			'Crypt Wraith does not return with only 1 creature above it'
		);

		// Add a 2nd creature above Crypt Wraith -> returns on upkeep!
		const c2 = addCardToZone(state, p1Id, getCardByName('Elvish Mystic')!, 'graveyard');
		assert.ok(c1 && c2);
		runBeginningOfTurn(state);
		assert.equal(
			p1.battlefield.some((b) => b.instanceId === wraith.instanceId),
			true,
			'Synthetic Crypt Wraith returned from graveyard on upkeep when 2 creatures were above it'
		);
	});

	it('C2: evaluates self ETB, observer ETB, and Landfall triggers generically for both real cards and synthetic cards', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// 1. Synthetic observer ETB ("Whenever another Elf enters the battlefield under your control, put a +1/+1 counter on ~")
		const synthObserverCard = makeTestCard({
			name: 'Canopy Mentor',
			typeLine: 'Creature — Elf Druid',
			oracleText:
				'Whenever another Elf enters the battlefield under your control, put a +1/+1 counter on Canopy Mentor.',
			power: '2',
			toughness: '2'
		});
		const mentor = addCardToZone(state, p1Id, synthObserverCard, 'battlefield');

		// 2. Synthetic Landfall ("Whenever a land enters the battlefield under your control, proliferate.")
		const synthLandfallCard = makeTestCard({
			name: 'Spore Cultivator',
			typeLine: 'Creature — Fungus',
			oracleText: 'Landfall — Whenever a land enters the battlefield under your control, proliferate.',
			power: '1',
			toughness: '3'
		});
		addCardToZone(state, p1Id, synthLandfallCard, 'battlefield');

		// Cast Llanowar Elves -> triggers Canopy Mentor (+1/+1 counter)
		p1.manaPool.G = 5;
		const elfHand = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: elfHand.instanceId }).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(
			mentor.counters['+1/+1'],
			1,
			'Synthetic Canopy Mentor got a +1/+1 counter when another Elf entered'
		);

		// Play a Forest -> triggers synthetic Spore Cultivator Landfall Proliferate (mentor goes from 1 to 2 counters!)
		const forestHand = addCardToZone(state, p1Id, getCardByName('Forest')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'play_land', instanceId: forestHand.instanceId }).ok,
			true
		);
		assert.equal(
			mentor.counters['+1/+1'],
			2,
			'Synthetic Spore Cultivator proliferated on Landfall'
		);

		// 3. Synthetic Shaman of the Pack ("When ~ enters, target opponent loses life equal to the number of Elves you control.")
		const synthDrainer = makeTestCard({
			name: 'GroveInvoker',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Elf Warlock',
			oracleText:
				'When GroveInvoker enters, target opponent loses life equal to the number of Elves you control.',
			power: '2',
			toughness: '2'
		});
		const p2LifeBefore = p2.life;
		p1.manaPool.B = 2;
		const drainerHand = addCardToZone(state, p1Id, synthDrainer, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: drainerHand.instanceId }).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		// Elves controlled by p1: Canopy Mentor, Llanowar Elves, GroveInvoker = 3 Elves!
		assert.equal(
			p2.life,
			p2LifeBefore - 3,
			'Synthetic GroveInvoker drained opponent for 3 life (3 Elves)'
		);
	});

	it('C3: evaluates spell-cast triggers (Magecraft, creature/noncreature/any-player cast) and +1/+1 counter placement triggers generically', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		// 1. Synthetic Magecraft draw card + Veyran trigger doubler
		const synthScholar = makeTestCard({
			name: 'Runecrest Scholar',
			typeLine: 'Creature — Wizard',
			oracleText: 'Magecraft — Whenever you cast or copy an instant or sorcery spell, draw a card.',
			power: '2',
			toughness: '2'
		});
		addCardToZone(state, p1Id, synthScholar, 'battlefield');
		addCardToZone(state, p1Id, getCardByName('Veyran, Voice of Duality')!, 'battlefield');

		// 2. Synthetic Fathom Mage ("Whenever a +1/+1 counter is placed on ~, you may draw a card.")
		const synthBiomancer = makeTestCard({
			name: 'Simic Biomancer',
			typeLine: 'Creature — Merfolk Wizard',
			oracleText: 'Whenever a +1/+1 counter is placed on Simic Biomancer, you may draw a card.',
			power: '1',
			toughness: '1'
		});
		const biomancer = addCardToZone(state, p1Id, synthBiomancer, 'battlefield');

		p1.manaPool.U = 2;
		const slip = addCardToZone(state, p1Id, getCardByName('Slip Out the Back')!, 'hand');
		const handBefore = p1.hand.length;
		// Casting Slip Out the Back triggers Runecrest Scholar twice (via Veyran) -> draws 2 cards immediately on cast!
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: slip.instanceId,
				targets: [{ kind: 'permanent', id: biomancer.instanceId, label: biomancer.card.name }]
			}).ok,
			true
		);
		assert.equal(
			p1.hand.length,
			handBefore - 1 + 2,
			'Synthetic Runecrest Scholar drew 2 cards on Instant cast (doubled by Veyran)'
		);

		// Resolving Slip Out the Back puts a +1/+1 counter on Simic Biomancer -> triggers Simic Biomancer to draw 1 more card!
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(
			p1.hand.length,
			handBefore - 1 + 3,
			'Synthetic Simic Biomancer drew 1 card when a +1/+1 counter was placed on it'
		);
	});

	it('C4: evaluates attack triggers and combat-damage-to-player triggers generically for real and synthetic cards', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];

		// Synthetic Goldspan ("Whenever ~ attacks, create a Treasure token.") + Synthetic Lathril ("Whenever ~ deals combat damage to a player, create that many 1/1 green Saproling creature tokens.")
		const synthRaider = makeTestCard({
			name: 'Hoard Drake',
			typeLine: 'Creature — Dragon',
			oracleText:
				'Whenever Hoard Drake attacks, create a Treasure token.\nWhenever Hoard Drake deals combat damage to a player, create that many 1/1 green Saproling creature tokens.',
			power: '3',
			toughness: '3'
		});
		const raider = addCardToZone(state, p1Id, synthRaider, 'battlefield');

		// Advance to declare_attackers
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(state.phase, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: raider.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		assert.equal(
			p1.battlefield.some((b) => b.card.name === 'Treasure'),
			true,
			'Synthetic Hoard Drake created a Treasure token on attack'
		);

		// No blockers -> advance to combat_damage
		applyGameAction(state, p2Id, { type: 'declare_blockers', assignments: [] });
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		const saprolings = p1.battlefield.filter((b) => b.card.typeLine.includes('Saproling'));
		assert.equal(
			saprolings.length,
			3,
			'Synthetic Hoard Drake created 3 Saproling tokens after dealing 3 combat damage to player'
		);
	});

	it('C5: routes target-controller effects (Beast Within, Generous Gift, Swords to Plowshares, Path to Exile, and synthetic cards) to target controller and through initiateLibrarySearch', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// 1. Synthetic Beast Within ("Destroy target permanent. Its controller creates a 2/2 white Swan creature token with flying.")
		const swanSongRemoval = makeTestCard({
			name: 'Fowl Substitution',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				'Destroy target permanent. Its controller creates a 2/2 blue Bird creature token with flying.'
		});
		const targetBear = addCardToZone(
			state,
			p2Id,
			makeTestCard({ name: 'Target Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		p1.manaPool.U = 2;
		const fowlInst = addCardToZone(state, p1Id, swanSongRemoval, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: fowlInst.instanceId,
				targets: [{ kind: 'permanent', id: targetBear.instanceId, label: targetBear.card.name }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(
			p2.battlefield.some((b) => b.card.typeLine.includes('Bird') && b.isToken),
			true,
			"Target's controller (Bob) received the 2/2 Bird token"
		);

		// 2. Path to Exile routes through initiateLibrarySearch -> intercepted by Alice's Opposition Agent when targeting Bob's creature!
		addCardToZone(state, p1Id, getCardByName('Opposition Agent')!, 'battlefield');
		const bobElf = addCardToZone(state, p2Id, getCardByName('Llanowar Elves')!, 'battlefield');
		p1.manaPool.W = 1;
		const pte = addCardToZone(state, p1Id, getCardByName('Path to Exile')!, 'hand');
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: pte.instanceId,
				targets: [{ kind: 'permanent', id: bobElf.instanceId, label: bobElf.card.name }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });

		// Because Path to Exile's search goes through initiateLibrarySearch for Bob, Alice's Opposition Agent intercepts it!
		const ptePrompt = state.pendingPrompts.find((pr) => pr.kind === 'search_library');
		assert.ok(ptePrompt, 'Path to Exile created a search_library prompt');
		assert.equal(
			ptePrompt?.playerId,
			p1Id,
			'Opposition Agent controller (Alice) controls Bob during Path to Exile search'
		);
		assert.equal(ptePrompt?.targetLibraryOwnerId, p2Id);
	});

	it('C6, C7 & C8: evaluates generic cost modifiers (Metalcraft, self creature discount), generic Overload resolution, and dynamic mana production', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// C6: Synthetic Blasphemous Act ("This spell costs {1} less to cast for each creature on the battlefield.")
		const synthAct = makeTestCard({
			name: 'Seismic Reckoning',
			manaCost: '{6}{R}',
			cmc: 7,
			typeLine: 'Sorcery',
			oracleText:
				'This spell costs {1} less to cast for each creature on the battlefield.\nSeismic Reckoning deals 5 damage to each creature.'
		});
		addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'battlefield');
		addCardToZone(state, p2Id, getCardByName('Elvish Mystic')!, 'battlefield');
		const actInst = addCardToZone(state, p1Id, synthAct, 'hand');
		const actCost = getSpellCostRequirement(p1, actInst, state, 0);
		assert.equal(actCost.generic, 4, 'Synthetic Seismic Reckoning reduced from {6}{R} to {4}{R} by 2 creatures');

		// C7: Synthetic Overloaded bounce spell returns all opponent nonland permanents without targeting
		const synthOverloadBounce = makeTestCard({
			name: 'Tempest Purge',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				"Return target nonland permanent you don't control to its owner's hand.\nOverload {3}{U}"
		});
		const purgeInst = addCardToZone(state, p1Id, synthOverloadBounce, 'hand');
		p1.manaPool.U = 4;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: purgeInst.instanceId,
				xValue: 1,
				targets: []
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(
			p2.battlefield.length,
			0,
			'Synthetic Overloaded Tempest Purge bounced opponent nonland permanents'
		);

		// C6: Every non-land card in STAPLE_CARDS has a non-null cast.normal ActionRuleNode
		const allCards = Object.values(STAPLE_CARDS);
		for (const c of allCards) {
			if (!c.typeLine.includes('Land') || c.typeLine.includes('Creature')) {
				const castNode = getCardRuleTree(c).actions.find((a) => a.path === 'cast.normal');
				assert.ok(castNode, `Card ${c.name} should have a cast.normal ActionRuleNode`);
			}
		}

		// C8: Synthetic Elvish Archdruid ("{T}: Add {G} for each Elf you control.") & Synthetic Marwyn ("{T}: Add an amount of {G} equal to ~'s power.")
		const synthArchdruid = makeTestCard({
			name: 'SylvanHighDruid',
			typeLine: 'Creature — Elf Druid',
			oracleText: '{T}: Add {G} for each Elf you control.',
			power: '2',
			toughness: '2'
		});
		const druidInst = addCardToZone(state, p1Id, synthArchdruid, 'battlefield');
		p1.manaPool.G = 0;
		assert.equal(
			applyGameAction(state, p1Id, { type: 'tap_mana', instanceId: druidInst.instanceId }).ok,
			true
		);
		// p1 controls Llanowar Elves + SylvanHighDruid = 2 Elves
		assert.equal(
			p1.manaPool.G,
			2,
			'Synthetic SylvanHighDruid tapped for 2 {G} (2 Elves controlled)'
		);

		const synthMarwyn = makeTestCard({
			name: 'CradleNurturer',
			typeLine: 'Creature — Elf Druid',
			oracleText: "{T}: Add an amount of {G} equal to CradleNurturer's power.",
			power: '4',
			toughness: '4'
		});
		const marwynInst = addCardToZone(state, p1Id, synthMarwyn, 'battlefield');
		p1.manaPool.G = 0;
		assert.equal(
			applyGameAction(state, p1Id, { type: 'tap_mana', instanceId: marwynInst.instanceId }).ok,
			true
		);
		assert.equal(p1.manaPool.G, 4, 'Synthetic CradleNurturer tapped for 4 {G} equal to its power');
	});
});

// ============================================================================
// 27. Stage D: Continuous Layer Engine — Snapshot & Synthetic Card Generalization (CR 613)
// ============================================================================
describe('27. Stage D: Continuous Layer Engine — Snapshot & Synthetic Card Generalization (CR 613)', () => {
	it('D1: preserves continuous breakdown snapshots for real cards across Layers 4, 6 & 7 (Darksteel Mutation, Kenrith\'s Transformation, Imprisoned in the Moon, Song of the Dryads, Yavimaya, Mycosynth Lattice, Maskwood Nexus, Dress Down, Shalai, Akroma\'s Memorial, Archetype of Imagination, Elvish Archdruid, Chromatic Lantern)', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// 1. Kenrith's Transformation on Atraxa -> Legendary Creature — Elk (3/3), loses all abilities
		const atraxa = addCardToZone(
			state,
			p1Id,
			getCardByName("Atraxa, Praetors' Voice")!,
			'battlefield'
		);
		const kenrith = addCardToZone(
			state,
			p2Id,
			getCardByName("Kenrith's Transformation")!,
			'battlefield'
		);
		kenrith.attachedToId = atraxa.instanceId;
		const atraxaBd = inspectCardContinuousBreakdown(atraxa, state);
		assert.equal(atraxaBd.effectiveTypeLine, 'Legendary Creature — Elk');
		assert.equal(atraxaBd.effectivePower, 3);
		assert.equal(atraxaBd.effectiveToughness, 3);
		assert.equal(permanentHasLostAllAbilities(atraxa, state).lost, true);

		// 2. Imprisoned in the Moon on Llanowar Elves -> Land, loses all abilities, grants Mana Ability: Add {C}
		const llanowar = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'battlefield');
		const moon = addCardToZone(
			state,
			p2Id,
			getCardByName('Imprisoned in the Moon')!,
			'battlefield'
		);
		moon.attachedToId = llanowar.instanceId;
		const llanowarBd = inspectCardContinuousBreakdown(llanowar, state);
		assert.equal(llanowarBd.effectiveTypeLine, 'Land');
		assert.equal(llanowarBd.effectivePower, null);
		assert.equal(
			llanowarBd.items.some((i) => i.canonicalKey === 'mana_c' && !i.removed),
			true
		);

		// 3. Song of the Dryads on Elvish Mystic -> Land — Forest, grants Mana Ability: Add {G}
		const mystic = addCardToZone(state, p1Id, getCardByName('Elvish Mystic')!, 'battlefield');
		const song = addCardToZone(state, p2Id, getCardByName('Song of the Dryads')!, 'battlefield');
		song.attachedToId = mystic.instanceId;
		const mysticBd = inspectCardContinuousBreakdown(mystic, state);
		assert.equal(mysticBd.effectiveTypeLine, 'Land — Forest');
		assert.equal(
			mysticBd.items.some((i) => i.canonicalKey === 'mana_g' && !i.removed),
			true
		);

		// 4. Yavimaya, Cradle of Growth + Chromatic Lantern on Command Tower
		const tower = addCardToZone(state, p1Id, getCardByName('Command Tower')!, 'battlefield');
		addCardToZone(state, p1Id, getCardByName('Yavimaya, Cradle of Growth')!, 'battlefield');
		addCardToZone(state, p1Id, getCardByName('Chromatic Lantern')!, 'battlefield');
		const towerBd = inspectCardContinuousBreakdown(tower, state);
		assert.equal(towerBd.effectiveTypeLine, 'Land — Forest');
		assert.equal(
			towerBd.items.some((i) => i.canonicalKey === 'mana_any' && !i.removed),
			true
		);

		// 5. Mycosynth Lattice + Maskwood Nexus + Elvish Archdruid + Shalai + Akroma's Memorial + Archetype of Imagination
		const game2 = createActiveTwoPlayerGame();
		const bear = addCardToZone(
			game2.state,
			game2.p1Id,
			makeTestCard({
				name: 'Grizzly Bears',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		addCardToZone(game2.state, game2.p1Id, getCardByName('Mycosynth Lattice')!, 'battlefield');
		addCardToZone(game2.state, game2.p1Id, getCardByName('Maskwood Nexus')!, 'battlefield');
		addCardToZone(game2.state, game2.p1Id, getCardByName('Elvish Archdruid')!, 'battlefield');
		addCardToZone(game2.state, game2.p1Id, getCardByName('Shalai, Voice of Plenty')!, 'battlefield');
		addCardToZone(game2.state, game2.p1Id, getCardByName("Akroma's Memorial")!, 'battlefield');
		const oppDragon = addCardToZone(
			game2.state,
			game2.p2Id,
			getCardByName('Lathliss, Dragon Queen')!,
			'battlefield'
		);
		addCardToZone(
			game2.state,
			game2.p1Id,
			getCardByName('Archetype of Imagination')!,
			'battlefield'
		);

		const bearEval = evaluatePermanent(game2.state, bear);
		assert.equal(bearEval.isArtifact, true, 'Mycosynth Lattice makes Bear an Artifact');
		assert.equal(bearEval.hasAllCreatureTypes, true, 'Maskwood Nexus grants all creature types');
		assert.equal(bearEval.hasSubType('Elf'), true, 'Maskwood Nexus makes Bear an Elf');
		assert.equal(bearEval.power, 3, 'Elvish Archdruid buffs Bear (+1/+1) because it is an Elf');
		assert.equal(hasKeyword(bear, 'Hexproof', game2.state), true, 'Shalai grants Hexproof');
		assert.equal(hasKeyword(bear, 'Haste', game2.state), true, "Akroma's Memorial grants Haste");
		assert.equal(
			hasProtectionFrom(
				bear,
				makeTestCard({ name: 'Doom Blade', colors: ['B'], typeLine: 'Instant' }),
				game2.state
			),
			true,
			"Akroma's Memorial grants Protection from black"
		);
		assert.equal(
			hasKeyword(oppDragon, 'Flying', game2.state),
			false,
			'Archetype of Imagination removes Flying from opponent Dragon'
		);
	});

	it('D2: evaluates synthetic Layer 4, Layer 6, and Layer 7 continuous effects without hardcoded card names', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();

		// 1. Synthetic Darksteel Mutation ("Carapace Prison": Insect/Beetle artifact creature 0/2 with indestructible, loses all abilities)
		const dragon = addCardToZone(
			state,
			p1Id,
			getCardByName('Lathliss, Dragon Queen')!,
			'battlefield'
		);
		const synthMutation = makeTestCard({
			name: 'Carapace Prison',
			typeLine: 'Enchantment — Aura',
			oracleText:
				'Enchant creature\nEnchanted creature is a Beetle artifact creature with base power and toughness 0/2 and has indestructible, and it loses all other abilities, card types, and creature types.'
		});
		const prisonInst = addCardToZone(state, p2Id, synthMutation, 'battlefield');
		prisonInst.attachedToId = dragon.instanceId;

		const dragonBd = inspectCardContinuousBreakdown(dragon, state);
		assert.equal(
			dragonBd.effectiveTypeLine,
			'Legendary Artifact Creature — Beetle',
			'Synthetic Carapace Prison sets type to Legendary Artifact Creature — Beetle'
		);
		assert.equal(dragonBd.effectivePower, 0, 'Synthetic Carapace Prison sets base power 0');
		assert.equal(dragonBd.effectiveToughness, 2, 'Synthetic Carapace Prison sets base toughness 2');
		assert.equal(
			hasKeyword(dragon, 'Flying', state),
			false,
			'Synthetic Carapace Prison strips innate Flying'
		);
		assert.equal(
			hasKeyword(dragon, 'Indestructible', state),
			true,
			'Synthetic Carapace Prison grants Indestructible'
		);

		// 2. Synthetic Kenrith's Transformation ("Polymorph into Boar": loses all abilities and is a green Boar creature with base power and toughness 2/2)
		const angel = addCardToZone(
			state,
			p1Id,
			getCardByName('Shalai, Voice of Plenty')!,
			'battlefield'
		);
		const synthKenrith = makeTestCard({
			name: 'Polymorph into Boar',
			typeLine: 'Enchantment — Aura',
			oracleText:
				'Enchant creature\nEnchanted creature loses all abilities and is a green Boar creature with base power and toughness 2/2.'
		});
		const boarAura = addCardToZone(state, p2Id, synthKenrith, 'battlefield');
		boarAura.attachedToId = angel.instanceId;

		const angelBd = inspectCardContinuousBreakdown(angel, state);
		assert.equal(
			angelBd.effectiveTypeLine,
			'Legendary Creature — Boar',
			'Synthetic Polymorph into Boar sets type to Legendary Creature — Boar'
		);
		assert.equal(angelBd.effectivePower, 2);
		assert.equal(angelBd.effectiveToughness, 2);
		assert.equal(permanentHasLostAllAbilities(angel, state).lost, true);

		// 3. Synthetic Imprisoned in the Moon ("Sealed in Obsidian") & Synthetic Song of the Dryads ("Turned to Marsh")
		const dork1 = addCardToZone(state, p1Id, getCardByName('Llanowar Elves')!, 'battlefield');
		const synthMoon = makeTestCard({
			name: 'Sealed in Obsidian',
			typeLine: 'Enchantment — Aura',
			oracleText:
				'Enchant creature, land, or planeswalker\nEnchanted permanent is a colorless land with "{T}: Add {C}" and loses all other card types and abilities.'
		});
		const obsidianInst = addCardToZone(state, p2Id, synthMoon, 'battlefield');
		obsidianInst.attachedToId = dork1.instanceId;
		const dork1Bd = inspectCardContinuousBreakdown(dork1, state);
		assert.equal(
			dork1Bd.effectiveTypeLine,
			'Land',
			'Synthetic Sealed in Obsidian turns creature into Land'
		);
		assert.equal(
			dork1Bd.items.some((i) => i.canonicalKey === 'mana_c' && !i.removed),
			true,
			'Synthetic Sealed in Obsidian grants Mana Ability: Add {C}'
		);

		const dork2 = addCardToZone(state, p1Id, getCardByName('Elvish Mystic')!, 'battlefield');
		const synthSong = makeTestCard({
			name: 'Turned to Marsh',
			typeLine: 'Enchantment — Aura',
			oracleText:
				'Enchant permanent\nEnchanted permanent is a colorless Swamp land and loses all other card types and abilities.'
		});
		const marshInst = addCardToZone(state, p2Id, synthSong, 'battlefield');
		marshInst.attachedToId = dork2.instanceId;
		const dork2Bd = inspectCardContinuousBreakdown(dork2, state);
		assert.equal(
			dork2Bd.effectiveTypeLine,
			'Land — Swamp',
			'Synthetic Turned to Marsh turns creature into Land — Swamp'
		);
		assert.equal(
			dork2Bd.items.some((i) => i.canonicalKey === 'mana_b' && !i.removed),
			true,
			'Synthetic Turned to Marsh grants Mana Ability: Add {B}'
		);

		// 4. Synthetic Lord ("Merfolk Sovereign": "Other Merfolk creatures you control get +1/+1 and have hexproof.")
		//    + Synthetic Shalai ("Aegis Archangel": "You, planeswalkers you control, and other creatures you control have vigilance.")
		//    + Synthetic Akroma's Memorial ("Banner of Valor": "Creatures you control have flying, haste, and protection from red.")
		//    + Synthetic Chromatic Lantern ("Prismatic Obelisk": 'Lands you control have "{T}: Add one mana of any color."')
		const game2 = createActiveTwoPlayerGame();
		const merfolkScout = addCardToZone(
			game2.state,
			game2.p1Id,
			makeTestCard({
				name: 'Merfolk Scout',
				typeLine: 'Creature — Merfolk Scout',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const synthLord = makeTestCard({
			name: 'Merfolk Sovereign',
			typeLine: 'Creature — Merfolk Noble',
			oracleText: 'Other Merfolk creatures you control get +1/+1 and have hexproof.',
			power: '2',
			toughness: '2'
		});
		addCardToZone(game2.state, game2.p1Id, synthLord, 'battlefield');

		const synthShalai = makeTestCard({
			name: 'Aegis Archangel',
			typeLine: 'Creature — Angel',
			oracleText: 'You, planeswalkers you control, and other creatures you control have vigilance.',
			power: '3',
			toughness: '4'
		});
		addCardToZone(game2.state, game2.p1Id, synthShalai, 'battlefield');

		const synthBanner = makeTestCard({
			name: 'Banner of Valor',
			typeLine: 'Artifact',
			oracleText: 'Creatures you control have flying, haste, and protection from red.'
		});
		addCardToZone(game2.state, game2.p1Id, synthBanner, 'battlefield');

		const synthLantern = makeTestCard({
			name: 'Prismatic Obelisk',
			typeLine: 'Artifact',
			oracleText: 'Lands you control have "{T}: Add one mana of any color."'
		});
		addCardToZone(game2.state, game2.p1Id, synthLantern, 'battlefield');
		const island = addCardToZone(
			game2.state,
			game2.p1Id,
			getCardByName('Island')!,
			'battlefield'
		);

		assert.equal(
			getCreaturePower(merfolkScout, game2.state),
			2,
			'Synthetic Merfolk Sovereign buffs other Merfolk +1/+1'
		);
		assert.equal(
			hasKeyword(merfolkScout, 'Hexproof', game2.state),
			true,
			'Synthetic Merfolk Sovereign grants Hexproof to other Merfolk'
		);
		assert.equal(
			hasKeyword(merfolkScout, 'Vigilance', game2.state),
			true,
			'Synthetic Aegis Archangel grants Vigilance'
		);
		assert.equal(
			hasKeyword(merfolkScout, 'Flying', game2.state),
			true,
			'Synthetic Banner of Valor grants Flying'
		);
		assert.equal(
			hasProtectionFrom(
				merfolkScout,
				makeTestCard({ name: 'Lightning Bolt', colors: ['R'], typeLine: 'Instant' }),
				game2.state
			),
			true,
			'Synthetic Banner of Valor grants Protection from red'
		);
		const islandBd = inspectCardContinuousBreakdown(island, game2.state);
		assert.equal(
			islandBd.items.some((i) => i.canonicalKey === 'mana_any' && !i.removed),
			true,
			'Synthetic Prismatic Obelisk grants Mana Ability: Add Any Color to controlled lands'
		);
	});
});

// ============================================================================
// 28. Stage E: AI Evaluator — Effective Layer Types & Phased-Out Permanents
// ============================================================================
describe('28. Stage E: AI Evaluator — Effective Layer Types & Phased-Out Permanents', () => {
	it('E1: bot declare_attackers and declare_blockers skip phased-out permanents and creatures turned into Lands (Song of the Dryads), and attack with Opalescence-animated enchantments', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players.find((p) => p.playerId === p1Id)!;
		const p2 = state.players.find((p) => p.playerId === p2Id)!;
		p2.isBot = true;

		// Case 1: P2 (bot) is in declare_attackers with:
		// - A 4/4 creature that is phasedOut
		// - A 4/4 creature enchanted by Song of the Dryads (now a Land — Forest, not a creature)
		// - Opalescence + a 4-CMC non-Aura Enchantment (animated into a 4/4 Creature by Layer 4)
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'declare_attackers';

		const phasedOutBeast = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Phased Beast',
				typeLine: 'Creature — Beast',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		phasedOutBeast.summoningSick = false;
		phasedOutBeast.phasedOut = true;

		const treefolk = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Silenced Rhino',
				typeLine: 'Creature — Rhino',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		treefolk.summoningSick = false;
		const song = addCardToZone(
			state,
			p1Id,
			getCardByName('Song of the Dryads')!,
			'battlefield'
		);
		song.attachedToId = treefolk.instanceId;

		const opal = addCardToZone(
			state,
			p2Id,
			getCardByName('Opalescence')!,
			'battlefield'
		);
		opal.summoningSick = false;
		const shrine = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Sunlit Shrine',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText: ''
			}),
			'battlefield'
		);
		shrine.summoningSick = false;

		runAutomatedPriorityAndBots(state);

		assert.deepEqual(
			state.combat.attackers.map((a) => a.attackerInstanceId),
			[shrine.instanceId],
			'Bot declared only the Opalescence-animated Enchantment as attacker, skipping phased-out and Song-of-the-Dryads permanents'
		);

		// Human defender P1 declares no blockers; combat damage resolves
		assert.equal(
			applyGameAction(state, p1Id, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		runAutomatedPriorityAndBots(state);

		// Sunlit Shrine (animated 4/4 creature) should have dealt 4 combat damage to P1!
		assert.equal(
			p1.life,
			36,
			'Bot attacked with Opalescence-animated Enchantment while skipping phased-out and Song-of-the-Dryads creatures'
		);
	});

	it('E2: bot declare_blockers skips phased-out / Song-of-the-Dryads non-creatures and blocks with a real creature', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p2 = state.players.find((p) => p.playerId === p2Id)!;
		p2.isBot = true;

		const attacker = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Charging Ogre',
				typeLine: 'Creature — Ogre',
				power: '4',
				toughness: '2'
			}),
			'battlefield'
		);
		attacker.summoningSick = false;

		// First on P2's battlefield: a printed Creature turned into a Land by Song of the Dryads
		const fakeBlocker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Dryadified Guardian',
				typeLine: 'Creature — Knight',
				power: '5',
				toughness: '5'
			}),
			'battlefield'
		);
		const song = addCardToZone(
			state,
			p1Id,
			getCardByName('Song of the Dryads')!,
			'battlefield'
		);
		song.attachedToId = fakeBlocker.instanceId;

		// Second on P2's battlefield: a real 3/5 Creature that can block and survive
		const realBlocker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Stalwart Shieldmate',
				typeLine: 'Creature — Soldier',
				power: '3',
				toughness: '5'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		// Pass priority to advance to declare_blockers where P2 (bot) acts
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		runAutomatedPriorityAndBots(state);

		assert.deepEqual(
			state.combat.attackers[0]?.blockerInstanceIds,
			[realBlocker.instanceId],
			'Bot skipped Song-of-the-Dryads permanent and declared Stalwart Shieldmate as blocker'
		);
	});

	it('E3: bot declare_blockers blocks an attacker with printed "can\'t be blocked" when Humility removes its abilities', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p2 = state.players.find((p) => p.playerId === p2Id)!;
		p2.isBot = true;

		const unblockableAttacker = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Phantom Infiltrator',
				typeLine: 'Creature — Rogue',
				oracleText: "Phantom Infiltrator can't be blocked.",
				power: '3',
				toughness: '2'
			}),
			'battlefield'
		);
		unblockableAttacker.summoningSick = false;

		const blocker = addCardToZone(
			state,
			p2Id,
			makeTestCard({
				name: 'Sentinel Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		// Give Sentinel Bear a +1/+1 counter so under Humility (1/1 base) it is a 2/2 and profitably kills the 1/1 attacker
		blocker.counters['+1/+1'] = 1;

		addCardToZone(state, p2Id, getCardByName('Humility')!, 'battlefield');

		state.phase = 'declare_attackers';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: unblockableAttacker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		runAutomatedPriorityAndBots(state);

		assert.deepEqual(
			state.combat.attackers[0]?.blockerInstanceIds,
			[blocker.instanceId],
			'Bot blocked printed unblockable creature because Humility stripped its "can\'t be blocked" ability'
		);
	});
});

// ============================================================================
// 29. Stage C & D Deep Audit: Timestamp Precedence, Layer-Aware Subtypes/Types,
//     Generic Non-Green Power Mana Dorks, Overload castMode & Player Hexproof
// ============================================================================
describe('29. Stage C & D Deep Audit: Timestamp Precedence, Layer-Aware Subtypes/Types & Generic Oracle Dispatch', () => {
	it('D-Audit-1: enforces CR 613 timestamp order between simultaneous Layer 4/6 Auras (Darksteel Mutation vs Song of the Dryads) and global Layer 6 effects (Akroma\'s Memorial vs Humility)', () => {
		// Case 1A: Darksteel Mutation (ts 10) then Song of the Dryads (ts 20)
		// Song of the Dryads has later timestamp -> permanent is a colorless Land — Forest (not Artifact Creature — Insect)
		// AND loses Indestructible granted by Darksteel Mutation at ts 10!
		const game1 = createActiveTwoPlayerGame();
		const target1 = addCardToZone(
			game1.state,
			game1.p1Id,
			makeTestCard({
				name: 'Grizzled Paladin',
				typeLine: 'Creature — Human Knight',
				oracleText: 'Vigilance',
				power: '3',
				toughness: '3',
				keywords: ['Vigilance']
			}),
			'battlefield'
		);
		const mutation1 = addCardToZone(
			game1.state,
			game1.p2Id,
			getCardByName('Darksteel Mutation')!,
			'battlefield'
		);
		mutation1.attachedToId = target1.instanceId;
		mutation1.enteredTimestamp = 10;

		const song1 = addCardToZone(
			game1.state,
			game1.p2Id,
			getCardByName('Song of the Dryads')!,
			'battlefield'
		);
		song1.attachedToId = target1.instanceId;
		song1.enteredTimestamp = 20;

		const eval1 = evaluatePermanent(game1.state, target1);
		assert.equal(eval1.isLand, true, 'Later Song of the Dryads makes it a Land');
		assert.equal(eval1.isCreature, false, 'Later Song of the Dryads removes Creature type added by earlier Darksteel Mutation');
		assert.equal(
			hasKeyword(target1, 'Indestructible', game1.state),
			false,
			'Later Song of the Dryads (ts 20) strips Indestructible granted by earlier Darksteel Mutation (ts 10)'
		);

		// Case 1B: Song of the Dryads (ts 10) then Darksteel Mutation (ts 20)
		// Darksteel Mutation has later timestamp -> overwrites type to Artifact Creature — Insect,
		// grants Indestructible, and strips the {T}: Add {G} mana ability granted by Song of the Dryads at ts 10!
		const game2 = createActiveTwoPlayerGame();
		const target2 = addCardToZone(
			game2.state,
			game2.p1Id,
			makeTestCard({
				name: 'Grizzled Paladin',
				typeLine: 'Creature — Human Knight',
				oracleText: 'Vigilance',
				power: '3',
				toughness: '3',
				keywords: ['Vigilance']
			}),
			'battlefield'
		);
		const song2 = addCardToZone(
			game2.state,
			game2.p2Id,
			getCardByName('Song of the Dryads')!,
			'battlefield'
		);
		song2.attachedToId = target2.instanceId;
		song2.enteredTimestamp = 10;

		const mutation2 = addCardToZone(
			game2.state,
			game2.p2Id,
			getCardByName('Darksteel Mutation')!,
			'battlefield'
		);
		mutation2.attachedToId = target2.instanceId;
		mutation2.enteredTimestamp = 20;

		const eval2 = evaluatePermanent(game2.state, target2);
		assert.equal(eval2.isCreature, true, 'Later Darksteel Mutation makes it an Artifact Creature');
		assert.equal(eval2.isLand, false, 'Later Darksteel Mutation overwrites Land type from earlier Song of the Dryads');
		assert.equal(hasKeyword(target2, 'Indestructible', game2.state), true);
		const abilitiesUnderMutation = getEffectiveActivatedAbilities(
			game2.state,
			game2.state.players[0],
			target2,
			['W', 'U', 'B', 'R', 'G']
		);
		assert.equal(
			abilitiesUnderMutation.some((a) => a.id === 'granted_mana_g'),
			false,
			'Later Darksteel Mutation (ts 20) strips Forest mana ability from earlier Song of the Dryads (ts 10)'
		);

		// Destroying Darksteel Mutation restores Song of the Dryads (isLand: true and granted_mana_g)
		game2.state.players[1].battlefield = game2.state.players[1].battlefield.filter(
			(b) => b.instanceId !== mutation2.instanceId
		);
		const eval2After = evaluatePermanent(game2.state, target2);
		assert.equal(eval2After.isLand, true, 'Removing Darksteel Mutation restores Song of the Dryads Land type');
		assert.equal(eval2After.isCreature, false);
		const abilitiesRestored = getEffectiveActivatedAbilities(
			game2.state,
			game2.state.players[0],
			target2,
			['W', 'U', 'B', 'R', 'G']
		);
		assert.equal(
			abilitiesRestored.some((a) => a.id === 'granted_mana_g'),
			true,
			'Removing Darksteel Mutation restores Forest mana ability from Song of the Dryads'
		);

		// Case 2: Akroma's Memorial (ts 10) vs Humility (ts 20) and vice versa
		const game3 = createActiveTwoPlayerGame();
		const bear3 = addCardToZone(
			game3.state,
			game3.p1Id,
			makeTestCard({
				name: 'Runeclaw Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const memorial3 = addCardToZone(
			game3.state,
			game3.p1Id,
			getCardByName("Akroma's Memorial")!,
			'battlefield'
		);
		memorial3.enteredTimestamp = 10;
		const humility3 = addCardToZone(
			game3.state,
			game3.p2Id,
			getCardByName('Humility')!,
			'battlefield'
		);
		humility3.enteredTimestamp = 20;

		assert.equal(
			hasKeyword(bear3, 'Flying', game3.state),
			false,
			'Humility (ts 20) removes Flying granted by earlier Akroma\'s Memorial (ts 10)'
		);

		// Flip timestamps: Humility (ts 10) then Akroma's Memorial (ts 20) -> Bear HAS Flying!
		humility3.enteredTimestamp = 10;
		memorial3.enteredTimestamp = 20;
		assert.equal(
			hasKeyword(bear3, 'Flying', game3.state),
			true,
			'Akroma\'s Memorial (ts 20) grants Flying after earlier Humility (ts 10)'
		);
	});

	it('D-Audit-2: attaching Song of the Dryads to Yavimaya or Humility strips their global static abilities', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const island = addCardToZone(state, p1Id, getCardByName('Island')!, 'battlefield');
		const yavimaya = addCardToZone(
			state,
			p1Id,
			getCardByName('Yavimaya, Cradle of Growth')!,
			'battlefield'
		);
		assert.equal(evaluatePermanent(state, island).hasSubType('Forest'), true);

		// Attach Song of the Dryads to Yavimaya -> Yavimaya loses all abilities, so Island is no longer a Forest!
		const songOnYav = addCardToZone(
			state,
			p2Id,
			getCardByName('Song of the Dryads')!,
			'battlefield'
		);
		songOnYav.attachedToId = yavimaya.instanceId;
		assert.equal(
			evaluatePermanent(state, island).hasSubType('Forest'),
			false,
			'Yavimaya enchanted by Song of the Dryads loses its ability to make other lands Forests'
		);

		// Now put Humility on the battlefield and a creature with Flying; then attach Song of the Dryads to Humility
		const serra = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Serra Angel',
				typeLine: 'Creature — Angel',
				oracleText: 'Flying, vigilance',
				power: '4',
				toughness: '4',
				keywords: ['Flying', 'Vigilance']
			}),
			'battlefield'
		);
		const humility = addCardToZone(state, p2Id, getCardByName('Humility')!, 'battlefield');
		assert.equal(hasKeyword(serra, 'Flying', state), false);

		const songOnHumility = addCardToZone(
			state,
			p1Id,
			getCardByName('Song of the Dryads')!,
			'battlefield'
		);
		songOnHumility.attachedToId = humility.instanceId;
		assert.equal(
			hasKeyword(serra, 'Flying', state),
			true,
			'Humility enchanted by Song of the Dryads loses its static ability, restoring Serra Angel\'s Flying'
		);
		assert.equal(getCreaturePower(serra, state), 4);
	});

	it('C-Audit-3: parses and taps synthetic non-green power-based mana dorks ("{T}: Add an amount of {R} equal to ~\'s power")', () => {
		const { state, p1Id } = createActiveTwoPlayerGame();
		const pyroDork = addCardToZone(
			state,
			p1Id,
			makeTestCard({
				name: 'Pyromancer Channeler',
				typeLine: 'Creature — Human Shaman',
				oracleText: "{T}: Add an amount of {R} equal to Pyromancer Channeler's power.",
				power: '4',
				toughness: '2'
			}),
			'battlefield'
		);
		pyroDork.summoningSick = false;

		const prod = getPermanentManaProduction(pyroDork.card, ['R']);
		assert.equal(prod.canTapForMana, true, 'Non-green power-based mana ability is recognized');
		assert.deepEqual(prod.colors, ['R']);

		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'tap_mana',
				instanceId: pyroDork.instanceId
			}).ok,
			true
		);
		assert.equal(state.players[0].manaPool.R, 4, 'Tapped for 4 {R} equal to power');
	});

	it('C/D-Audit-4: uses Layer 4 effective subtypes and types (Maskwood Nexus, Mycosynth Lattice, Song of the Dryads) across ETB/attack triggers, count_subtype effects, Metalcraft, and Blasphemous Act', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// 1. Maskwood Nexus makes non-Elf/non-Dragon creatures count as Elves and Dragons
		addCardToZone(state, p1Id, getCardByName('Maskwood Nexus')!, 'battlefield');
		const marwyn = addCardToZone(
			state,
			p1Id,
			getCardByName('Marwyn, the Nurturer')!,
			'battlefield'
		);
		const bearCard = makeTestCard({
			name: 'Grizzly Bears',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		const bearHand = addCardToZone(state, p1Id, bearCard, 'hand');
		p1.manaPool.G = 2;
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: bearHand.instanceId }).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		// Resolve Marwyn's ETB observer trigger ("Whenever another Elf you control enters, put a +1/+1 counter on Marwyn")
		if (state.stack.length > 0) {
			applyGameAction(state, p1Id, { type: 'pass_priority' });
			applyGameAction(state, p2Id, { type: 'pass_priority' });
		}
		assert.equal(
			marwyn.counters['+1/+1'] ?? 0,
			1,
			'Grizzly Bears entering under Maskwood Nexus triggered Marwyn\'s "another Elf you control enters" ability'
		);

		// Cast Shaman of the Pack -> counts Maskwood Nexus creatures as Elves!
		const lifeBefore = p2.life;
		const shamanHand = addCardToZone(state, p1Id, getCardByName('Shaman of the Pack')!, 'hand');
		p1.manaPool = { W: 0, U: 0, B: 1, R: 0, G: 2, C: 0 };
		assert.equal(
			applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: shamanHand.instanceId }).ok,
			true
		);
		// Resolve Shaman of the Pack + any triggers
		while (state.stack.length > 0) {
			applyGameAction(state, p1Id, {
				type: 'pass_priority'
			});
			applyGameAction(state, p2Id, {
				type: 'pass_priority'
			});
		}
		// P1 controls Marwyn (Elf), Grizzly Bears (All-Types via Maskwood Nexus), and Shaman of the Pack (Elf) = 3 Elves!
		assert.equal(
			p2.life,
			lifeBefore - 3,
			'Shaman of the Pack counted Grizzly Bears as an Elf via Maskwood Nexus (3 life lost)'
		);

		// 2. Mycosynth Lattice makes lands count as Artifacts for Puresteel Paladin's Metalcraft (Equip {0})
		const gameMetal = createActiveTwoPlayerGame();
		const paladin = addCardToZone(
			gameMetal.state,
			gameMetal.p1Id,
			getCardByName('Puresteel Paladin')!,
			'battlefield'
		);
		const boots = addCardToZone(
			gameMetal.state,
			gameMetal.p1Id,
			getCardByName('Swiftfoot Boots')!,
			'battlefield'
		);
		addCardToZone(gameMetal.state, gameMetal.p1Id, getCardByName('Plains')!, 'battlefield');
		// Only 1 artifact so far (Swiftfoot Boots) -> equip cost is {1}
		const abilitiesBefore = getEffectiveActivatedAbilities(
			gameMetal.state,
			gameMetal.state.players[0],
			boots,
			['W']
		);
		assert.equal(abilitiesBefore[0]?.costText.includes('{0}'), false);

		// Add Mycosynth Lattice -> Puresteel Paladin, Swiftfoot Boots, Plains, and Mycosynth Lattice are ALL Artifacts (>= 3)!
		addCardToZone(
			gameMetal.state,
			gameMetal.p1Id,
			getCardByName('Mycosynth Lattice')!,
			'battlefield'
		);
		const abilitiesAfter = getEffectiveActivatedAbilities(
			gameMetal.state,
			gameMetal.state.players[0],
			boots,
			['W']
		);
		assert.equal(
			abilitiesAfter[0]?.costText.includes('{0}'),
			true,
			'Mycosynth Lattice turns non-artifacts into Artifacts in Layer 4, enabling Puresteel Paladin Metalcraft Equip {0}'
		);
		assert.ok(paladin);

		// 3. Song of the Dryads turning a creature into a Land stops it from reducing Blasphemous Act's cost
		const gameBlasphemous = createActiveTwoPlayerGame();
		const blasAct = addCardToZone(
			gameBlasphemous.state,
			gameBlasphemous.p1Id,
			getCardByName('Blasphemous Act')!,
			'hand'
		);
		const c1 = addCardToZone(
			gameBlasphemous.state,
			gameBlasphemous.p1Id,
			bearCard,
			'battlefield'
		);
		assert.equal(
			getSpellCostRequirement(gameBlasphemous.state, gameBlasphemous.p1Id, blasAct, 'hand').cost.generic,
			7,
			'1 creature on battlefield reduces Blasphemous Act generic cost from 8 to 7'
		);
		const songBlas = addCardToZone(
			gameBlasphemous.state,
			gameBlasphemous.p2Id,
			getCardByName('Song of the Dryads')!,
			'battlefield'
		);
		songBlas.attachedToId = c1.instanceId;
		assert.equal(
			getSpellCostRequirement(gameBlasphemous.state, gameBlasphemous.p1Id, blasAct, 'hand').cost.generic,
			8,
			'Creature enchanted by Song of the Dryads is a Land (not a Creature) and no longer reduces Blasphemous Act cost'
		);
	});

	it('C-Audit-5: disambiguates castMode: "overload" vs normal "{X}" spell casts, and enforces synthetic player hexproof ("You have hexproof")', () => {
		const { state, p1Id, p2Id } = createActiveTwoPlayerGame();
		const p1 = state.players[0];
		const p2 = state.players[1];

		// 1. Synthetic spell with BOTH {X} in its mana cost and Overload
		const xOverloadCard = makeTestCard({
			name: 'Aether Gale Burst',
			manaCost: '{X}{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText:
				"Return target nonland permanent you don't control to its owner's hand.\nOverload {2}{U} (You may cast this spell for its overload cost. If you do, change 'target' in its text to 'each'.)"
		});
		const oppPerm1 = addCardToZone(state, p2Id, getCardByName('Sol Ring')!, 'battlefield');
		const oppPerm2 = addCardToZone(state, p2Id, getCardByName('Arcane Signet')!, 'battlefield');

		// Cast normally with xValue = 2 targeting only oppPerm1 -> should NOT overload (oppPerm2 stays on battlefield!)
		const spell1 = addCardToZone(state, p1Id, xOverloadCard, 'hand');
		p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 2 };
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'cast_spell',
				instanceId: spell1.instanceId,
				xValue: 2,
				castMode: 'normal',
				targets: [{ kind: 'permanent', id: oppPerm1.instanceId, label: oppPerm1.card.name }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		applyGameAction(state, p2Id, { type: 'pass_priority' });
		assert.equal(
			p2.battlefield.some((b) => b.instanceId === oppPerm1.instanceId),
			false,
			'Targeted Sol Ring was bounced'
		);
		assert.equal(
			p2.battlefield.some((b) => b.instanceId === oppPerm2.instanceId),
			true,
			'Normal cast with xValue=2 did NOT falsely trigger Overload on Arcane Signet'
		);

		// 2. Synthetic permanent granting "You have hexproof" prevents opponent from targeting the player
		const synthAegis = makeTestCard({
			name: 'Sanctuary Seraph',
			typeLine: 'Creature — Angel',
			oracleText: 'You and other creatures you control have hexproof.',
			power: '3',
			toughness: '4'
		});
		addCardToZone(state, p1Id, synthAegis, 'battlefield');

		const thoughtDistortion = makeTestCard({
			name: 'Mind Spike',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Target opponent loses 3 life.'
		});
		const spikeInst = addCardToZone(state, p2Id, thoughtDistortion, 'hand');
		const legality = validateTargetLegality(
			state,
			p2Id,
			spikeInst.card,
			{ kind: 'player', id: p1Id, label: p1.name },
			'opponent'
		);
		assert.equal(
			legality.ok,
			false,
			'Synthetic "You ... have hexproof" permanent prevents opponent from targeting player'
		);
	});
});







