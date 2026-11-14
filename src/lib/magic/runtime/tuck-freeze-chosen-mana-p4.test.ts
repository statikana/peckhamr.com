import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn
} from '../engine.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	const id = `syn_p4_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
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
		id: 'deck_p4',
		userId: 'p1',
		name: 'Track P4 Deck',
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
		name: 'P4 Filler Wastes',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land',
		oracleText: '{T}: Add {C}.'
	});
	const deck = makeDeck(Array.from({ length: 20 }, () => filler));
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
	const state = createInitialGameState('P4_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: 40
	});
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
	p1.library = [];
	p2.library = [];
	return { state, p1, p2 };
}

function addCardToZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library',
	summoningSick = false
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, undefined, state);
	inst.summoningSick = zone === 'battlefield' ? summoningSick : false;
	player[zone].push(inst);
	return inst;
}

function addMana(player: PlayerGameState, pool: Partial<Record<ManaColor, number>>): void {
	for (const [k, v] of Object.entries(pool)) {
		if (v) player.manaPool[k as ManaColor] += v;
	}
}

function resolveAllStack(state: GameState, maxSteps = 40): void {
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

function seedNamedLibrary(state: GameState, player: PlayerGameState, count: number): CardInstance[] {
	player.library = [];
	const out: CardInstance[] = [];
	for (let i = 1; i <= count; i++) {
		const c = synthCard({
			name: `Lib Marker ${i}`,
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Artifact',
			oracleText: ''
		});
		out.push(addCardToZone(state, player, c, 'library'));
	}
	return out;
}

describe('Track P4 — Library Placement, Freeze/Exert, Chosen Type/Color, & Filter/Combo/Verge Mana', () => {
	describe('1. Library Top / Bottom / Top-or-Bottom / Nth-from-Top Placement (CR 401.2, 401.4, 401.7)', () => {
		it('places cards Nth from top with CR 401.7 clamping when library has fewer than N cards (including empty)', () => {
			const { state, p1, p2 } = setupMain1Game();
			seedNamedLibrary(state, p2, 10);

			const tuckThird = synthCard({
				name: 'Chrono Submerge',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: "Put target creature into its owner's library third from the top.",
				colors: ['U']
			});
			const targetBear = synthCard({
				name: 'grizzly test',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				oracleText: '',
				power: '2',
				toughness: '2',
				colors: ['G']
			});

			const bear = addCardToZone(state, p2, targetBear, 'battlefield');
			const spell = addCardToZone(state, p1, tuckThird, 'hand');
			addMana(p1, { U: 2 });

			const castRes = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			});
			assert.equal(castRes.ok, true);
			resolveAllStack(state);

			assert.equal(p2.battlefield.length, 0);
			assert.equal(p2.library.length, 11);
			assert.equal(p2.library[2].card.name, 'grizzly test');

			// Now test CR 401.7 clamping: 7th from top when library has only 2 cards -> goes to bottom (index 2)
			seedNamedLibrary(state, p2, 2);
			const tuckSeventh = synthCard({
				name: 'Seventh Horizon',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText:
					"You gain 7 life. Put Seventh Horizon into its owner's library seventh from the top.",
				colors: ['U']
			});
			seedNamedLibrary(state, p1, 2);
			const horizon = addCardToZone(state, p1, tuckSeventh, 'hand');
			addMana(p1, { U: 1 });

			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: horizon.instanceId }).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.life, 47);
			assert.equal(p1.graveyard.some((c) => c.card.name === 'Seventh Horizon'), false);
			assert.equal(p1.library.length, 3);
			assert.equal(p1.library[2].card.name, 'Seventh Horizon');

			// Empty library CR 401.7 clamping -> index 0
			p1.library = [];
			const horizon2 = addCardToZone(state, p1, tuckSeventh, 'hand');
			addMana(p1, { U: 1 });
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: horizon2.instanceId }).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.library.length, 1);
			assert.equal(p1.library[0].card.name, 'Seventh Horizon');
		});

		it('exiles a self-tucking spell cast via Flashback per CR 702.34a instead of putting it into library', () => {
			const { state, p1 } = setupMain1Game();
			seedNamedLibrary(state, p1, 5);

			const fbTuck = synthCard({
				name: 'Recurring Zenith',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText:
					"You gain 2 life. Put Recurring Zenith on the bottom of its owner's library.\nFlashback {1}{G}",
				keywords: ['Flashback'],
				colors: ['G']
			});

			const gySpell = addCardToZone(state, p1, fbTuck, 'graveyard');
			addMana(p1, { G: 2 });
			const fbOpt = getCastOptions(state, 'p1', gySpell, 'graveyard').find((o) =>
				o.id.includes('flashback')
			);
			assert.ok(fbOpt, 'expected flashback cast option');
			const res = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: gySpell.instanceId,
				fromZone: 'graveyard',
				optionId: fbOpt.id
			});
			assert.equal(res.ok, true);
			resolveAllStack(state);

			assert.equal(p1.life, 42);
			assert.equal(p1.library.length, 5);
			assert.equal(p1.exile.some((c) => c.card.name === 'Recurring Zenith'), true);
		});

		it('puts an uncounterable spell on the stack into its owner library without countering it (CR 701.5a)', () => {
			const { state, p1, p2 } = setupMain1Game();
			seedNamedLibrary(state, p1, 4);

			const uncounterable = synthCard({
				name: 'Inevitable Titan',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Giant',
				oracleText: "This spell can't be countered.",
				power: '4',
				toughness: '4',
				colors: ['G']
			});
			const tuckStackSpell = synthCard({
				name: 'Memory Lapse Variant',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: "Put target spell into its owner's library second from the top.",
				colors: ['U']
			});

			const titan = addCardToZone(state, p1, uncounterable, 'hand');
			const lapse = addCardToZone(state, p2, tuckStackSpell, 'hand');
			addMana(p1, { G: 2 });
			addMana(p2, { U: 2 });

			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: titan.instanceId }).ok,
				true
			);
			const titanStackId = state.stack[0].id;
			// Pass priority to p2
			assert.equal(applyGameAction(state, 'p1', { type: 'pass_priority' }).ok, true);

			const res = applyGameAction(state, 'p2', {
				type: 'cast_spell',
				instanceId: lapse.instanceId,
				targets: [{ kind: 'stack', id: titanStackId, label: titan.card.name }]
			});
			assert.equal(res.ok, true);
			resolveAllStack(state);

			assert.equal(p1.battlefield.length, 0);
			assert.equal(p1.library.length, 5);
			assert.equal(p1.library[1].card.name, 'Inevitable Titan');
		});

		it('supports top-or-bottom choice by owner vs controller across JSON round-trip and CR 401.4 multi-card ordering', () => {
			const { state, p1, p2 } = setupMain1Game();
			seedNamedLibrary(state, p2, 3);

			const ownerChoiceBounce = synthCard({
				name: 'AetherEddy',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					"Target creature's owner puts it on the top or bottom of their library.",
				colors: ['U']
			});
			const oppCreature = synthCard({
				name: 'Bob Wolf',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Wolf',
				oracleText: '',
				power: '2',
				toughness: '2',
				colors: ['G']
			});

			const wolf = addCardToZone(state, p2, oppCreature, 'battlefield');
			const eddy = addCardToZone(state, p1, ownerChoiceBounce, 'hand');
			addMana(p1, { U: 2 });

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: eddy.instanceId,
					targets: [{ kind: 'permanent', id: wolf.instanceId, label: wolf.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);

			// Human owner p2 must be prompted (not controller p1!)
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(state.pendingPrompts[0].playerId, 'p2');
			assert.equal(state.pendingPrompts[0].choice?.kind, 'chooseMode');

			const reloaded = roundTripState(state);
			const promptId = reloaded.pendingPrompts[0].id;
			// Choose index 1 = bottom of library
			const ansRes = applyGameAction(reloaded, 'p2', {
				type: 'choice',
				promptId,
				answer: { kind: 'chooseMode', indices: [1] }
			});
			assert.equal(ansRes.ok, true);
			resolveAllStack(reloaded);

			const p2Reloaded = reloaded.players[1];
			assert.equal(p2Reloaded.battlefield.length, 0);
			assert.equal(p2Reloaded.library.length, 4);
			assert.equal(p2Reloaded.library[3].card.name, 'Bob Wolf');

			// Now test CR 401.4 simultaneous multi-card library move ordering for human owner
			const cA = addCardToZone(
				reloaded,
				reloaded.players[0],
				synthCard({
					name: 'AlphaBear',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					oracleText: '',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const cB = addCardToZone(
				reloaded,
				reloaded.players[0],
				synthCard({
					name: 'BetaBear',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Bear',
					oracleText: '',
					power: '3',
					toughness: '3'
				}),
				'battlefield'
			);
			seedNamedLibrary(reloaded, reloaded.players[0], 2);
			const massTuck = addCardToZone(
				reloaded,
				reloaded.players[0],
				synthCard({
					name: 'Mass Submerge',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Sorcery',
					oracleText: "Put all creatures on the top of their owners' libraries.",
					colors: ['U']
				}),
				'hand'
			);
			addMana(reloaded.players[0], { U: 3 });
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'cast_spell',
					instanceId: massTuck.instanceId
				}).ok,
				true
			);
			resolveAllStack(reloaded);

			assert.equal(reloaded.pendingPrompts.length, 1);
			assert.equal(reloaded.pendingPrompts[0].choice?.kind, 'orderObjects');
			const reloaded2 = roundTripState(reloaded);
			const orderRes = applyGameAction(reloaded2, 'p1', {
				type: 'choice',
				promptId: reloaded2.pendingPrompts[0].id,
				answer: { kind: 'orderObjects', topIds: [cB.instanceId, cA.instanceId] }
			});
			assert.equal(orderRes.ok, true);
			resolveAllStack(reloaded2);
			assert.equal(reloaded2.players[0].library[0].card.name, 'BetaBear');
			assert.equal(reloaded2.players[0].library[1].card.name, 'AlphaBear');
		});
	});

	describe('2. Next-Untap Freeze & Exert (CR 502.3, 611.2b, 122.1d, 701.43)', () => {
		it('skips untapping AND stun-counter removal when frozen, clears freeze on untapped permanents (CR 611.2b), and untaps on subsequent turn', () => {
			const { state, p1, p2 } = setupMain1Game();
			seedNamedLibrary(state, p1, 5);
			seedNamedLibrary(state, p2, 5);

			const freezeSpell = synthCard({
				name: 'Glacial Grip',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText:
					"Tap target creature. It doesn't untap during its controller's next untap step.",
				colors: ['U']
			});
			const ogreCard = synthCard({
				name: 'Hill Ogre',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Creature — Ogre',
				oracleText: '',
				power: '3',
				toughness: '3',
				colors: ['R']
			});

			const ogre = addCardToZone(state, p2, ogreCard, 'battlefield');
			ogre.counters.stun = 1;
			// Also put an ALREADY UNTAPPED permanent on p2's board with doesntUntapNextUntapStep = true (CR 611.2b)
			const untappedFrozen = addCardToZone(state, p2, ogreCard, 'battlefield');
			untappedFrozen.tapped = false;
			untappedFrozen.doesntUntapNextUntapStep = true;

			const grip = addCardToZone(state, p1, freezeSpell, 'hand');
			addMana(p1, { U: 1 });
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: grip.instanceId,
					targets: [{ kind: 'permanent', id: ogre.instanceId, label: ogre.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);

			assert.equal(ogre.tapped, true);
			assert.equal(ogre.doesntUntapNextUntapStep, true);

			// Advance to p2's turn and run untap step
			state.activePlayerIndex = 1;
			state.turnNumber = 2;
			runBeginningOfTurn(state);

			// Ogre stays tapped, flag consumed, AND stun counter NOT removed (CR 122.1d)!
			assert.equal(ogre.tapped, true);
			assert.equal(ogre.doesntUntapNextUntapStep, undefined);
			assert.equal(ogre.counters.stun, 1);
			// Untapped frozen permanent also consumed its flag (CR 611.2b)
			assert.equal(untappedFrozen.doesntUntapNextUntapStep, undefined);

			// Next p2 untap step: now stun counter is removed (still tapped for 1 more turn due to stun)
			state.activePlayerIndex = 1;
			state.turnNumber = 4;
			runBeginningOfTurn(state);
			assert.equal(ogre.counters.stun, 0);
			assert.equal(ogre.tapped, true);

			// Third p2 untap step: finally untaps cleanly!
			state.turnNumber = 6;
			runBeginningOfTurn(state);
			assert.equal(ogre.tapped, false);
		});

		it('classifies depletion lands as mana abilities (CR 605.1a), freezes on colored tap, and prefers non-freezing mana in auto-tap', () => {
			const { state, p1 } = setupMain1Game();
			seedNamedLibrary(state, p1, 5);

			const depletionLand = synthCard({
				name: 'Cinder Ridge',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText:
					"{T}: Add {C}.\n{T}: Add {R} or {G}. Cinder Ridge doesn't untap during your next untap step."
			});
			const basicForest = synthCard({
				name: 'Simple Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '{T}: Add {G}.'
			});

			const ridge = addCardToZone(state, p1, depletionLand, 'battlefield');
			const forest = addCardToZone(state, p1, basicForest, 'battlefield');

			const abs = getEffectiveActivatedAbilities(state, p1, ridge, ['R', 'G']);
			assert.equal(abs.length, 2);
			assert.equal(abs.every((a) => a.isManaAbility), true);
			assert.equal(abs[0].freezesSelfUntap, undefined);
			assert.equal(abs[1].freezesSelfUntap, true);

			// Casting a {G} spell should auto-tap the pain-free Simple Forest first, leaving Cinder Ridge untapped!
			const elfSpell = synthCard({
				name: 'Scout',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Elf',
				oracleText: '',
				power: '1',
				toughness: '1',
				colors: ['G']
			});
			const scout = addCardToZone(state, p1, elfSpell, 'hand');
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: scout.instanceId }).ok,
				true
			);
			assert.equal(forest.tapped, true);
			assert.equal(ridge.tapped, false);
			resolveAllStack(state);

			// Now cast a {R} spell: auto-taps Cinder Ridge's {R}/{G} ability and sets doesntUntapNextUntapStep!
			const bolt = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'Spark',
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'You gain 1 life.',
					colors: ['R']
				}),
				'hand'
			);
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: bolt.instanceId }).ok,
				true
			);
			assert.equal(ridge.tapped, true);
			assert.equal(ridge.doesntUntapNextUntapStep, true);
		});

		it('handles Exert activated cost (CR 701.43b), attack-exert + When you do, Exerted triggers, and exertedThisTurn statics', () => {
			const { state, p1, p2 } = setupMain1Game({ p1Bot: true, p2Bot: true });
			seedNamedLibrary(state, p1, 5);
			seedNamedLibrary(state, p2, 5);

			const exertAttacker = synthCard({
				name: 'Glory Champion',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Human Warrior',
				oracleText:
					'As long as Glory Champion is exerted, it gets +2/+2 and has flying.\nYou may exert Glory Champion as it attacks. When you do, it deals 2 damage to each opponent.',
				power: '2',
				toughness: '2',
				colors: ['R']
			});
			const exertWatcher = synthCard({
				name: 'Trueheart Steward',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Cleric',
				oracleText:
					'Whenever you exert a creature, you gain 3 life.\n{1}, Exert Trueheart Steward: Draw a card.',
				power: '1',
				toughness: '3',
				colors: ['W']
			});

			const champ = addCardToZone(state, p1, exertAttacker, 'battlefield', false);
			const steward = addCardToZone(state, p1, exertWatcher, 'battlefield', false);

			// Activate "{1}, Exert ~: Draw a card" TWICE in the same turn (CR 701.43b allows exerting an already-exerted permanent!)
			addMana(p1, { C: 2 });
			const stewardAbs = getEffectiveActivatedAbilities(state, p1, steward, ['W', 'R']);
			assert.equal(stewardAbs.length, 1);

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: steward.instanceId,
					abilityId: stewardAbs[0].id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(steward.exertedThisTurn, true);
			assert.equal(steward.doesntUntapNextUntapStep, true);
			assert.equal(p1.life, 43);
			assert.equal(p1.hand.length, 1);

			// Activate a second time while already exerted!
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: steward.instanceId,
					abilityId: stewardAbs[0].id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.life, 46);
			assert.equal(p1.hand.length, 2);

			// Declare attackers with Glory Champion -> bot exerts it, triggering both "When you do" and watcher!
			state.phase = 'declare_attackers';
			const atkRes = applyGameAction(state, 'p1', {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: champ.instanceId, defenderPlayerId: 'p2' }]
			});
			assert.equal(atkRes.ok, true);
			resolveAllStack(state);

			assert.equal(champ.exertedThisTurn, true);
			assert.equal(champ.doesntUntapNextUntapStep, true);
			const evalChamp = evaluatePermanent(state, champ);
			assert.equal(evalChamp.power, 4);
			assert.equal(evalChamp.toughness, 4);
			assert.equal(hasKeyword(champ, 'Flying', state), true);
			assert.equal(p2.life, 38); // 2 damage from "When you do"
			assert.equal(p1.life, 49); // +3 life from Trueheart Steward
		});
	});

	describe('3. ETB Chosen Creature Type & Chosen Color (CR 614.1c, 614.12, 105.4, 205.3m, 707.2)', () => {
		it('prompts human on ETB creature-type choice across JSON round-trip, applies Layer 4/7c & cost reduction (including Changeling), and does NOT copy chosenSubType to Clones (CR 707.2)', () => {
			const { state, p1 } = setupMain1Game();

			const bannerCard = synthCard({
				name: 'Ancestral Standard',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact',
				oracleText:
					'As Ancestral Standard enters, choose a creature type.\nCreatures you control of the chosen type get +1/+1.\nSpells you cast of the chosen type cost {1} less to cast.'
			});
			const goblinCard = synthCard({
				name: 'Raging Raider',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Goblin',
				oracleText: '',
				power: '2',
				toughness: '2',
				colors: ['R']
			});
			const changelingCard = synthCard({
				name: 'Mirror Entityling',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Shapeshifter',
				oracleText: 'Changeling',
				keywords: ['Changeling'],
				power: '1',
				toughness: '1',
				colors: ['U']
			});

			const gob = addCardToZone(state, p1, goblinCard, 'battlefield');
			const shapeshifter = addCardToZone(state, p1, changelingCard, 'battlefield');
			const gobInHand = addCardToZone(state, p1, goblinCard, 'hand');
			const banner = addCardToZone(state, p1, bannerCard, 'hand');

			addMana(p1, { C: 3 });
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: banner.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			// Paused in pendingZoneMoves awaiting human creature-type choice!
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(state.pendingPrompts[0].purpose, 'etb_choice');
			assert.equal(state.pendingZoneMoves?.length, 1);
			assert.equal(p1.battlefield.some((b) => b.instanceId === banner.instanceId), false);

			const reloaded = roundTripState(state);
			const modes =
				reloaded.pendingPrompts[0].choice?.kind === 'chooseMode'
					? reloaded.pendingPrompts[0].choice.modes
					: [];
			const goblinIdx = modes.indexOf('Goblin');
			assert.equal(goblinIdx >= 0, true, 'Goblin must be in chooseMode options');

			const ans = applyGameAction(reloaded, 'p1', {
				type: 'choice',
				promptId: reloaded.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [goblinIdx] }
			});
			assert.equal(ans.ok, true);

			const p1After = reloaded.players[0];
			const bannerOnBoard = p1After.battlefield.find((b) => b.instanceId === banner.instanceId)!;
			assert.equal(bannerOnBoard.chosenSubType, 'Goblin');

			const gobAfter = p1After.battlefield.find((b) => b.instanceId === gob.instanceId)!;
			const shifterAfter = p1After.battlefield.find(
				(b) => b.instanceId === shapeshifter.instanceId
			)!;
			assert.equal(evaluatePermanent(reloaded, gobAfter).power, 3);
			assert.equal(evaluatePermanent(reloaded, gobAfter).toughness, 3);
			// Changeling has all creature types (CR 702.73a) -> also gets +1/+1!
			assert.equal(evaluatePermanent(reloaded, shifterAfter).power, 2);

			// Cost reduction: {1}{R} Goblin spell now costs only {R}!
			addMana(p1After, { R: 1 });
			const gobHandAfter = p1After.hand.find((c) => c.instanceId === gobInHand.instanceId)!;
			assert.equal(
				checkSpellCastLegality(reloaded, 'p1', gobHandAfter).ok,
				true,
				'Goblin spell should be castable for {R} with {1} cost reduction'
			);
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'cast_spell',
					instanceId: gobInHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(reloaded);

			// CR 707.2: A creature with "As ~ enters, choose a creature type. ~ is the chosen type in addition to its other types"
			// copied by a Clone does NOT inherit chosenSubType; the Clone prompts for its own choice!
			const adaptiveAutomaton = synthCard({
				name: 'Adaptive Construct',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact Creature — Construct',
				oracleText:
					'As Adaptive Construct enters, choose a creature type.\nAdaptive Construct is the chosen type in addition to its other types.',
				power: '2',
				toughness: '2'
			});
			const cloneCard = synthCard({
				name: 'Mirror Clone',
				manaCost: '{3}{U}',
				cmc: 4,
				typeLine: 'Creature — Shapeshifter',
				oracleText:
					'You may have Mirror Clone enter as a copy of any creature on the battlefield.',
				power: '0',
				toughness: '0',
				colors: ['U']
			});

			const construct = addCardToZone(reloaded, p1After, adaptiveAutomaton, 'battlefield');
			construct.chosenSubType = 'Elf';
			assert.equal(evaluatePermanent(reloaded, construct).typeLine.includes('Elf'), true);

			const cloneInHand = addCardToZone(reloaded, p1After, cloneCard, 'hand');
			addMana(p1After, { C: 3, U: 1 });
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'cast_spell',
					instanceId: cloneInHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(reloaded);

			// First prompt: Clone creature choice
			const cloneTargetPrompt = reloaded.pendingPrompts.at(0)!;
			assert.equal(cloneTargetPrompt.choice?.kind, 'chooseObjects');
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'choice',
					promptId: cloneTargetPrompt.id,
					answer: { kind: 'chooseObjects', objectIds: [construct.instanceId] }
				}).ok,
				true
			);

			// Second prompt: Clone's OWN ETB creature-type choice (CR 707.2)!
			assert.equal(reloaded.pendingPrompts.length, 1);
			const cloneEtbPrompt = reloaded.pendingPrompts.at(0)!;
			assert.equal(cloneEtbPrompt.purpose, 'etb_choice');
			const cloneModes =
				cloneEtbPrompt.choice?.kind === 'chooseMode' ? cloneEtbPrompt.choice.modes : [];
			const gobChoiceIdx = cloneModes.indexOf('Goblin');
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'choice',
					promptId: cloneEtbPrompt.id,
					answer: { kind: 'chooseMode', indices: [gobChoiceIdx] }
				}).ok,
				true
			);

			const resolvedClone = p1After.battlefield.find(
				(b) => b.instanceId === cloneInHand.instanceId
			)!;
			assert.equal(resolvedClone.chosenSubType, 'Goblin');
			assert.equal(evaluatePermanent(reloaded, resolvedClone).typeLine.includes('Goblin'), true);
			assert.equal(evaluatePermanent(reloaded, resolvedClone).typeLine.includes('Elf'), false);
			// Because it chose Goblin while Ancestral Standard is on Goblin, the Clone is a 3/3!
			assert.equal(evaluatePermanent(reloaded, resolvedClone).power, 3);
		});

		it('supports mid-resolution ETB chosen color ("other than black"), Layer 5/6 protection, and chosen-color mana production', () => {
			const { state, p1 } = setupMain1Game();
			seedNamedLibrary(state, p1, 3);

			const grailCard = synthCard({
				name: 'Radiant Chalice',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact',
				oracleText:
					'As Radiant Chalice enters, choose a color other than black.\nCreatures you control have protection from the chosen color.\n{T}: Add {C} and one mana of the chosen color.'
			});
			const reanimateArt = synthCard({
				name: 'Reforge & Study',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Return target artifact card from your graveyard to the battlefield, then draw a card.',
				colors: ['W']
			});
			const bear = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'Squire',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human',
					oracleText: '',
					power: '2',
					toughness: '2',
					colors: ['W']
				}),
				'battlefield'
			);

			const grailGy = addCardToZone(state, p1, grailCard, 'graveyard');
			const reanim = addCardToZone(state, p1, reanimateArt, 'hand');
			addMana(p1, { C: 1, W: 1 });

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: reanim.instanceId,
					targets: [{ kind: 'graveyard_card', id: grailGy.instanceId, label: grailGy.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);

			// Paused mid-resolution on etb_choice BEFORE "draw a card"!
			assert.equal(p1.hand.length, 0);
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(state.pendingPrompts[0].purpose, 'etb_choice');
			const colorModes =
				state.pendingPrompts[0].choice?.kind === 'chooseMode'
					? state.pendingPrompts[0].choice.modes
					: [];
			assert.deepEqual(colorModes, ['White', 'Blue', 'Red', 'Green']); // Black excluded!

			const reloaded = roundTripState(state);
			const redIdx = colorModes.indexOf('Red');
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'choice',
					promptId: reloaded.pendingPrompts[0].id,
					answer: { kind: 'chooseMode', indices: [redIdx] }
				}).ok,
				true
			);
			resolveAllStack(reloaded);

			const p1After = reloaded.players[0];
			// Remaining step ("draw a card") resumed and completed!
			assert.equal(p1After.hand.length, 1);
			const chaliceOnBoard = p1After.battlefield.find(
				(b) => b.card.name === 'Radiant Chalice'
			)!;
			assert.equal(chaliceOnBoard.chosenColor, 'R');

			const squireAfter = p1After.battlefield.find((b) => b.instanceId === bear.instanceId)!;
			assert.equal(hasKeyword(squireAfter, 'protection from red', reloaded), true);

			// Tap Radiant Chalice for "{C} and one mana of the chosen color" -> adds {C}{R} without extra prompt!
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'tap_mana',
					instanceId: chaliceOnBoard.instanceId
				}).ok,
				true
			);
			assert.equal(p1After.manaPool.C, 1);
			assert.equal(p1After.manaPool.R, 1);
		});
	});

	describe('4. Filter Lands, Multi-Color Combination Mana, & Verge Lands (CR 106.1a–b, 602.5b, 605.1a)', () => {
		it('handles Shadowmoor hybrid Filter lands and Odyssey Signet Filter lands in both manual tap_mana and cast_spell auto-tap', () => {
			const { state, p1 } = setupMain1Game();

			const fetidHeath = synthCard({
				name: 'Bleak Heath',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText: '{T}: Add {C}.\n{W/B}, {T}: Add {W}{W}, {W}{B}, or {B}{B}.'
			});
			const basicSwamp = synthCard({
				name: 'Dark Swamp',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Swamp',
				oracleText: '{T}: Add {B}.'
			});
			const wwKnight = synthCard({
				name: 'Silver Paladin',
				manaCost: '{W}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Knight',
				oracleText: '',
				power: '2',
				toughness: '2',
				colors: ['W']
			});

			const heath = addCardToZone(state, p1, fetidHeath, 'battlefield');
			const swamp = addCardToZone(state, p1, basicSwamp, 'battlefield');
			const knight = addCardToZone(state, p1, wwKnight, 'hand');

			// Auto-tap: Swamp ({B}) + Bleak Heath ({W/B}, {T}: Add {W}{W}) pays {W}{W}!
			assert.equal(checkSpellCastLegality(state, 'p1', knight).ok, true);
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: knight.instanceId }).ok,
				true
			);
			assert.equal(swamp.tapped, true);
			assert.equal(heath.tapped, true);
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((b) => b.card.name === 'Silver Paladin'), true);

			// Untap Bleak Heath and test human manual tap_mana prompt across JSON round-trip
			heath.tapped = false;
			addMana(p1, { B: 1 });
			const heathAbs = getEffectiveActivatedAbilities(state, p1, heath, ['W', 'B']);
			const filterAb = heathAbs.find((a) => Boolean(a.manaBundles?.length))!;
			assert.ok(filterAb);

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'tap_mana',
					instanceId: heath.instanceId,
					abilityId: filterAb.id
				}).ok,
				true
			);
			assert.equal(state.pendingPrompts.length, 1);
			const costRoundTrip = roundTripState(state);
			const costModes =
				costRoundTrip.pendingPrompts[0].choice?.kind === 'chooseMode'
					? costRoundTrip.pendingPrompts[0].choice.modes
					: [];
			assert.deepEqual(costModes, ['Pay {W}', 'Pay {B}']);
			// Pay {B} (index 1) from pool, triggering the mana-bundle choice prompt
			assert.equal(
				applyGameAction(costRoundTrip, 'p1', {
					type: 'choice',
					promptId: costRoundTrip.pendingPrompts[0].id,
					answer: { kind: 'chooseMode', indices: [1] }
				}).ok,
				true
			);
			assert.equal(costRoundTrip.pendingPrompts.length, 1);
			const reloaded = roundTripState(costRoundTrip);
			const bundleModes =
				reloaded.pendingPrompts[0].choice?.kind === 'chooseMode'
					? reloaded.pendingPrompts[0].choice.modes
					: [];
			assert.deepEqual(bundleModes, ['{W}{W}', '{W}{B}', '{B}{B}']);
			// Pick {W}{B} (index 1)
			assert.equal(
				applyGameAction(reloaded, 'p1', {
					type: 'choice',
					promptId: reloaded.pendingPrompts[0].id,
					answer: { kind: 'chooseMode', indices: [1] }
				}).ok,
				true
			);
			assert.equal(reloaded.players[0].manaPool.W, 1);
			assert.equal(reloaded.players[0].manaPool.B, 1);

			// Odyssey filter land: "{1}, {T}: Add {G}{W}." + Mountain ("{T}: Add {R}") + Forest ("{T}: Add {G}") -> casts {R}{G}{W}!
			const { state: s2, p1: p1b } = setupMain1Game();
			addCardToZone(
				s2,
				p1b,
				synthCard({
					name: 'Sun Prairie',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: '{1}, {T}: Add {G}{W}.'
				}),
				'battlefield'
			);
			addCardToZone(
				s2,
				p1b,
				synthCard({
					name: 'Peak',
					manaCost: '',
					cmc: 0,
					typeLine: 'Basic Land — Mountain',
					oracleText: '{T}: Add {R}.'
				}),
				'battlefield'
			);
			addCardToZone(
				s2,
				p1b,
				synthCard({
					name: 'Grove',
					manaCost: '',
					cmc: 0,
					typeLine: 'Basic Land — Forest',
					oracleText: '{T}: Add {G}.'
				}),
				'battlefield'
			);
			const nayaBeast = addCardToZone(
				s2,
				p1b,
				synthCard({
					name: 'Naya Beast',
					manaCost: '{R}{G}{W}',
					cmc: 3,
					typeLine: 'Creature — Beast',
					oracleText: '',
					power: '3',
					toughness: '3',
					colors: ['R', 'G', 'W']
				}),
				'hand'
			);
			assert.equal(checkSpellCastLegality(s2, 'p1', nayaBeast).ok, true);
			assert.equal(
				applyGameAction(s2, 'p1', { type: 'cast_spell', instanceId: nayaBeast.instanceId }).ok,
				true
			);
			resolveAllStack(s2);
			assert.equal(p1b.battlefield.some((b) => b.card.name === 'Naya Beast'), true);
		});

		it('handles multi-color combination mana ("Add three mana in any combination of {R} and/or {G}") and Verge-land activationCondition (CR 602.5b)', () => {
			const { state, p1 } = setupMain1Game();

			const comboDork = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'Grove Channeler',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Elf Druid',
					oracleText: '{T}: Add three mana in any combination of {R} and/or {G}.',
					power: '1',
					toughness: '3',
					colors: ['G']
				}),
				'battlefield',
				false
			);
			const rggSpell = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'Primal Roar',
					manaCost: '{R}{G}{G}',
					cmc: 3,
					typeLine: 'Sorcery',
					oracleText: 'You gain 4 life.',
					colors: ['R', 'G']
				}),
				'hand'
			);

			// Auto-tap picks ['R', 'G', 'G'] cleanly!
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: rggSpell.instanceId }).ok,
				true
			);
			assert.equal(comboDork.tapped, true);
			resolveAllStack(state);
			assert.equal(p1.life, 44);

			// Verge land: "{T}: Add {B}.\n{T}: Add {W}. Activate only if you control a Swamp or a Plains."
			const vergeLand = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'Gloom Verge',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText:
						'{T}: Add {B}.\n{T}: Add {W}. Activate only if you control a Swamp or a Plains.'
				}),
				'battlefield'
			);
			const vergeAbs = getEffectiveActivatedAbilities(state, p1, vergeLand, ['W', 'B']);
			assert.equal(vergeAbs.length, 2);

			const whiteSpell = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'Holy Light',
					manaCost: '{W}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'You gain 2 life.',
					colors: ['W']
				}),
				'hand'
			);

			// Without a Swamp or Plains, {W} ability is illegal for both manual activation and cast_spell auto-tap!
			assert.equal(
				checkAbilityActivationLegality(state, 'p1', vergeLand, vergeAbs[1]).ok,
				false
			);
			assert.equal(checkSpellCastLegality(state, 'p1', whiteSpell).ok, false);

			// Put a tapped Swamp onto battlefield -> now Verge land's {W} ability unlocks!
			const tappedSwamp = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'Mire',
					manaCost: '',
					cmc: 0,
					typeLine: 'Basic Land — Swamp',
					oracleText: '{T}: Add {B}.'
				}),
				'battlefield'
			);
			tappedSwamp.tapped = true;

			assert.equal(checkAbilityActivationLegality(state, 'p1', vergeLand, vergeAbs[1]).ok, true);
			assert.equal(checkSpellCastLegality(state, 'p1', whiteSpell).ok, true);
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: whiteSpell.instanceId
				}).ok,
				true
			);
			assert.equal(vergeLand.tapped, true);
			resolveAllStack(state);
			assert.equal(p1.life, 46);
		});
	});

	describe('5. Card-Rename Invariance (ENGINE_INVARIANTS.md §1)', () => {
		it('compiles and executes identically under arbitrary card renames', () => {
			function runScenario(suffix: string): {
				compiledSupported: boolean[];
				finalLife: number;
				libOrder: string[];
				frozen: boolean;
			} {
				const { state, p1, p2 } = setupMain1Game({ p1Bot: true, p2Bot: true });
				seedNamedLibrary(state, p1, 3);

				const selfTuckName = `ZyxSpell_${suffix}`;
				const selfTuck = synthCard({
					name: selfTuckName,
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Sorcery',
					oracleText: `You gain 2 life. Put ${selfTuckName} into its owner's library second from the top.`,
					colors: ['U']
				});
				const depName = `ZyxLand_${suffix}`;
				const depLand = synthCard({
					name: depName,
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: `{T}: Add {U}. ${depName} doesn't untap during your next untap step.`
				});
				const lordName = `ZyxBanner_${suffix}`;
				const lord = synthCard({
					name: lordName,
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Artifact',
					oracleText: `As ${lordName} enters, choose a creature type.\nCreatures you control of the chosen type get +1/+1.`
				});

				const defs = [selfTuck, depLand, lord].map((c) => compileCard(c));
				const compiledSupported = defs.map((d) => d.fullySupported);

				const landInst = addCardToZone(state, p1, depLand, 'battlefield');
				addCardToZone(
					state,
					p1,
					synthCard({
						name: `ZyxElf_${suffix}`,
						manaCost: '{G}',
						cmc: 1,
						typeLine: 'Creature — Elf',
						oracleText: '',
						power: '1',
						toughness: '1'
					}),
					'battlefield'
				);
				const lordInst = addCardToZone(state, p1, lord, 'hand');
				addMana(p1, { C: 2 });
				assert.equal(
					applyGameAction(state, 'p1', {
						type: 'cast_spell',
						instanceId: lordInst.instanceId
					}).ok,
					true
				);
				resolveAllStack(state);

				const spellInst = addCardToZone(state, p1, selfTuck, 'hand');
				assert.equal(
					applyGameAction(state, 'p1', {
						type: 'cast_spell',
						instanceId: spellInst.instanceId
					}).ok,
					true
				);
				resolveAllStack(state);

				const elfPerm = p1.battlefield.find((b) => b.card.typeLine.includes('Elf'))!;
				assert.equal(evaluatePermanent(state, elfPerm).power, 2);
				assert.equal(p2.life, 40);

				return {
					compiledSupported,
					finalLife: p1.life,
					libOrder: p1.library.map((c) =>
						c.card.name === selfTuckName ? '<TUCKED>' : c.card.name
					),
					frozen: Boolean(landInst.doesntUntapNextUntapStep)
				};
			}

			const r1 = runScenario('Alpha_101');
			const r2 = runScenario('Omega_999_Renamed');
			assert.deepEqual(r1.compiledSupported, [true, true, true]);
			assert.deepEqual(r1, r2);
			assert.equal(r1.finalLife, 42);
			assert.equal(r1.libOrder[1], '<TUCKED>');
			assert.equal(r1.frozen, true);
		});
	});
});
