import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeBotStep } from '../ai.ts';
import { compileCard } from '../compiler/index.ts';
import { cardSupportReport, deckUnsupportedCards } from '../compiler/support.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn
} from '../engine.ts';
import {
	isNonPlayableHelperCard,
	isNonPlayableRawScryfallRecord,
	validateCommanderDeck
} from '../scryfall.ts';
import { activeCharacteristics, effectiveManaValue, instanceFaceOptions } from './faces.ts';
import {
	checkCompanionSpecialActionLegality,
	validateCompanionDeckCondition
} from './framesModalsWave6.ts';
import { moveObject } from './zones.ts';
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

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p18b_${synthSeq}`;
	const card: ScryfallCard = {
		id,
		oracleId: overrides.oracleId ?? `ora_p18b_${synthSeq}`,
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
		defense: overrides.defense,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false,
		...(overrides.setType ? { setType: overrides.setType } : {}),
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
	return card;
}

function makeDeck(
	cards: ScryfallCard[],
	commanders: ScryfallCard[] = [],
	companion?: ScryfallCard
): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_p18b_${++synthSeq}`,
		userId: 'p1',
		name: 'Track P18b Deck',
		description: '',
		commanders,
		...(companion ? { companion } : {}),
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
		p1Commanders?: ScryfallCard[];
		p1Companion?: ScryfallCard;
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Sunlit Meadow',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(
		Array.from({ length: 30 }, () => filler),
		opts.p1Commanders ?? [],
		opts.p1Companion
	);
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
			commanderNames: d1.commanders.map((c) => c.name),
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
	const state = createInitialGameState('P18B', seats, decks, DEFAULT_LOBBY_RULES);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hasKeptHand = true;
		p.hand = [];
	}
	return {
		state,
		p1: state.players[0],
		p2: state.players[1]
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

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 40; guard++) {
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].purpose === 'trigger_order') {
			const prm = state.pendingPrompts[0];
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
			});
			assert.equal(res.ok, true);
			continue;
		}
		if (state.pendingPrompts.length > 0) break;
		if (state.stack.length === 0) break;
		const pid = state.players[state.priorityPlayerIndex].playerId;
		const res = applyGameAction(state, pid, { type: 'pass_priority' });
		assert.equal(res.ok, true);
	}
}

// ---- 1. Meld (CR 713.1–8, CR 701.42) & Multi-Loyalty Activations (CR 606.3) ----------------

describe('Wave 6 Track P18b — Meld (CR 713.1–8) & Multi-Loyalty (CR 606.3)', () => {
	function makeGrafRatsMeldPair() {
		const chitteringFace = {
			name: 'Chittering Host',
			manaCost: '',
			cmc: 0,
			typeLine: 'Creature — Eldrazi Horror',
			oracleText:
				'Haste\nMenace\nWhen Chittering Host enters, other creatures you control get +1/+0 and gain menace until end of turn.',
			colors: ['B'] as ManaColor[],
			colorIndicator: ['B'] as ManaColor[],
			power: '5',
			toughness: '6',
			keywords: ['Haste', 'Menace'],
			imageUrl: ''
		};
		const grafRats = synthCard({
			id: 'meld_graf_rats',
			name: 'Graf Rats',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Rat',
			oracleText:
				'At the beginning of combat on your turn, if you both own and control Graf Rats and a creature named Midnight Scavengers, exile them, then meld them into Chittering Host.',
			colors: ['B'],
			power: '2',
			toughness: '1',
			layout: 'meld',
			faces: [
				{
					name: 'Graf Rats',
					manaCost: '{1}{B}',
					cmc: 2,
					typeLine: 'Creature — Rat',
					oracleText:
						'At the beginning of combat on your turn, if you both own and control Graf Rats and a creature named Midnight Scavengers, exile them, then meld them into Chittering Host.',
					colors: ['B'],
					power: '2',
					toughness: '1',
					keywords: [],
					imageUrl: ''
				},
				chitteringFace
			]
		});
		const midnightScavengers = synthCard({
			id: 'meld_midnight_scavengers',
			name: 'Midnight Scavengers',
			manaCost: '{4}{B}',
			cmc: 5,
			typeLine: 'Creature — Human Rogue',
			oracleText:
				'When Midnight Scavengers enters, you may return target creature card with mana value 3 or less from your graveyard to your hand.\n(Melds with Graf Rats.)',
			colors: ['B'],
			power: '3',
			toughness: '3',
			layout: 'meld',
			faces: [
				{
					name: 'Midnight Scavengers',
					manaCost: '{4}{B}',
					cmc: 5,
					typeLine: 'Creature — Human Rogue',
					oracleText:
						'When Midnight Scavengers enters, you may return target creature card with mana value 3 or less from your graveyard to your hand.\n(Melds with Graf Rats.)',
					colors: ['B'],
					power: '3',
					toughness: '3',
					keywords: [],
					imageUrl: ''
				},
				chitteringFace
			]
		});
		return { grafRats, midnightScavengers };
	}

	it('compiles Meld pairs (including comma-containing partner names) cleanly with zero unsupported abilities', () => {
		const { grafRats, midnightScavengers } = makeGrafRatsMeldPair();
		assert.equal(compileCard(grafRats).fullySupported, true);
		assert.equal(compileCard(midnightScavengers).fullySupported, true);

		const gisela = synthCard({
			name: 'Gisela, the Broken Blade',
			manaCost: '{2}{W}{W}',
			cmc: 4,
			typeLine: 'Legendary Creature — Angel Horror',
			oracleText:
				'Flying, first strike, lifelink\nAt the beginning of your end step, if you both own and control Gisela, the Broken Blade and a creature named Bruna, the Fading Light, exile them, then meld them into Brisela, Voice of Nightmares.',
			colors: ['W'],
			power: '4',
			toughness: '3',
			layout: 'meld',
			faces: [
				{
					name: 'Gisela, the Broken Blade',
					manaCost: '{2}{W}{W}',
					cmc: 4,
					typeLine: 'Legendary Creature — Angel Horror',
					oracleText:
						'Flying, first strike, lifelink\nAt the beginning of your end step, if you both own and control Gisela, the Broken Blade and a creature named Bruna, the Fading Light, exile them, then meld them into Brisela, Voice of Nightmares.',
					colors: ['W'],
					power: '4',
					toughness: '3',
					keywords: ['Flying', 'First strike', 'Lifelink'],
					imageUrl: ''
				},
				{
					name: 'Brisela, Voice of Nightmares',
					manaCost: '',
					cmc: 0,
					typeLine: 'Legendary Creature — Eldrazi Angel',
					oracleText: 'Flying, first strike, vigilance, lifelink',
					colors: [],
					power: '9',
					toughness: '10',
					keywords: ['Flying', 'First strike', 'Vigilance', 'Lifelink'],
					imageUrl: ''
				}
			]
		});
		assert.equal(compileCard(gisela).fullySupported, true);
	});

	it('melds two owned-and-controlled front cards, sums front-face MV (CR 713.3b), blocks transform (CR 713.1c), and splits into two cards on LTB (CR 713.8)', () => {
		const { grafRats, midnightScavengers } = makeGrafRatsMeldPair();
		const { state, p1 } = setupGame();

		const ally = putInZone(
			state,
			p1,
			synthCard({
				name: 'Loyal Squire',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Soldier',
				oracleText: '',
				colors: ['W'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		putInZone(state, p1, grafRats, 'battlefield');
		putInZone(state, p1, midnightScavengers, 'battlefield');

		// Advance from main1 into begin_combat to fire Graf Rats's beginning-of-combat Meld trigger
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' }).ok,
			true
		);
		assert.equal(state.phase, 'begin_combat');
		assert.equal(state.stack.length, 1);

		resolveAllStack(state);

		const host = p1.battlefield.find(
			(c) => evaluatePermanent(state, c).effectiveName === 'Chittering Host'
		);
		assert.ok(host, 'Chittering Host melded permanent should be on the battlefield');
		assert.equal(host.activeFaceIndex, 1);
		assert.equal(host.meldedComponents?.length, 2);

		// CR 713.3b: mana value of a melded permanent is the sum of its two front-face mana values (2 + 5 = 7)
		assert.equal(effectiveManaValue(host.card, instanceFaceOptions(host, 'battlefield')), 7);
		const evHost = evaluatePermanent(state, host);
		assert.equal(evHost.power, 5);
		assert.equal(evHost.toughness, 6);
		assert.equal(hasKeyword(host, 'Haste', state), true);
		assert.equal(hasKeyword(host, 'Menace', state), true);

		// Chittering Host's ETB trigger pumped Loyal Squire by +1/+0 and granted Menace
		assert.equal(evaluatePermanent(state, ally).power, 3);
		assert.equal(hasKeyword(ally, 'Menace', state), true);

		// CR 713.3b: a copy of a melded permanent (no meldedComponents) has mana value 0
		const copyOfHost = createCardInstance(host.card, p1.playerId, 'battlefield', true, false, 99);
		copyOfHost.activeFaceIndex = 1;
		assert.equal(
			effectiveManaValue(copyOfHost.card, instanceFaceOptions(copyOfHost, 'battlefield')),
			0
		);

		// JSON round-trip preserves melded permanent characteristics & MV
		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		const rtHost = roundTripped.players[0].battlefield.find(
			(c) => evaluatePermanent(roundTripped, c).effectiveName === 'Chittering Host'
		)!;
		assert.equal(effectiveManaValue(rtHost.card, instanceFaceOptions(rtHost, 'battlefield')), 7);

		// CR 713.1c: An effect that instructs a player to transform a melded permanent does nothing!
		const transformRay = synthCard({
			name: 'Moonbeam Twist',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Transform target creature.',
			colors: ['U']
		});
		const rayHand = putInZone(state, p1, transformRay, 'hand');
		giveMana(p1, { U: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rayHand.instanceId,
				fromZone: 'hand',
				targets: [{ kind: 'permanent', id: host.instanceId, label: 'Chittering Host' }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(evaluatePermanent(state, host).effectiveName, 'Chittering Host');
		assert.equal(Boolean(host.transformed), false);

		// CR 713.8: when a melded permanent leaves the battlefield, BOTH component cards go to the destination zone front-face up
		moveObject(state, host, 'graveyard', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			bumpVersion: true,
			newTimestamp: true,
			leaveBattlefieldReset: true
		});
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === host.instanceId),
			false
		);
		const gyNames = p1.graveyard
			.filter((c) => c.card.name !== 'Moonbeam Twist')
			.map((c) => c.card.name)
			.sort();
		assert.deepEqual(gyNames, ['Graf Rats', 'Midnight Scavengers']);
		for (const gyCard of p1.graveyard) {
			assert.equal(Boolean(gyCard.transformed), false);
			assert.equal(gyCard.meldedComponents, undefined);
		}
	});

	it('allows activating loyalty abilities twice each turn with loyaltyActivationsPerTurn (Urza, Planeswalker, CR 606.3)', () => {
		const urzaPw = synthCard({
			name: 'Arcane High Artificer',
			manaCost: '{3}{W}{U}',
			cmc: 5,
			typeLine: 'Legendary Planeswalker — Urza',
			oracleText:
				'You may activate the loyalty abilities of Arcane High Artificer twice each turn rather than only once.\n+1: Draw a card.\n-2: Gain 3 life.',
			colors: ['W', 'U'],
			loyalty: '5'
		});
		assert.equal(compileCard(urzaPw).fullySupported, true);

		const { state, p1 } = setupGame();
		const pw = putInZone(state, p1, urzaPw, 'battlefield');
		pw.counters['loyalty'] = 5;

		const abilities = getEffectiveActivatedAbilities(state, p1, pw);
		const plusOne = abilities.find((a) => a.loyaltyCost === 1)!;
		const minusTwo = abilities.find((a) => a.loyaltyCost === -2)!;
		assert.ok(plusOne && minusTwo);

		// Activation #1 (+1)
		const r1 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: pw.instanceId,
			abilityId: plusOne.id,
			targets: []
		});
		assert.equal(r1.ok, true);
		resolveAllStack(state);
		assert.equal(pw.counters['loyalty'], 6);
		assert.equal(p1.hand.length, 1);

		// Activation #2 (-2) in the SAME turn succeeds!
		const r2 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: pw.instanceId,
			abilityId: minusTwo.id,
			targets: []
		});
		assert.equal(r2.ok, true);
		resolveAllStack(state);
		assert.equal(pw.counters['loyalty'], 4);
		assert.equal(p1.life, 43);

		// Activation #3 in the SAME turn is rejected (cap = 2)
		const r3 = checkAbilityActivationLegality(state, p1.playerId, pw, plusOne);
		assert.equal(r3.ok, false);

		// Resets on next turn (sorcery timing in main1)
		runBeginningOfTurn(state);
		state.phase = 'main1';
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, pw, plusOne).ok, true);
	});
});

// ---- 2. Kamigawa Flip Cards (CR 710.1–5) ----------------------------------------------------

describe('Wave 6 Track P18b — Kamigawa Flip Cards (CR 710.1–5)', () => {
	it('compiles Kamigawa flip cards (including <Character> the <Title> short names and hand-count flip riders) and enforces CR 710.1c/710.4', () => {
		const jushi = synthCard({
			name: 'Jushi Apprentice',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Human Wizard',
			oracleText: '{2}{U}, {T}: Draw a card. If you have nine or more cards in hand, flip Jushi Apprentice.',
			colors: ['U'],
			power: '1',
			toughness: '2',
			layout: 'flip',
			faces: [
				{
					name: 'Jushi Apprentice',
					manaCost: '{1}{U}',
					cmc: 2,
					typeLine: 'Creature — Human Wizard',
					oracleText:
						'{2}{U}, {T}: Draw a card. If you have nine or more cards in hand, flip Jushi Apprentice.',
					colors: ['U'],
					power: '1',
					toughness: '2',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Tomoya the Revealer',
					manaCost: '',
					cmc: 0,
					typeLine: 'Legendary Creature — Human Wizard',
					oracleText: '{3}{U}{U}, {T}: Target player draws X cards, where X is the number of cards in your hand.',
					colors: ['U'],
					power: '2',
					toughness: '3',
					keywords: [],
					imageUrl: ''
				}
			]
		});
		assert.equal(compileCard(jushi).fullySupported, true);

		const callowJushi = synthCard({
			name: 'Callow Jushi',
			manaCost: '{1}{U}{U}',
			cmc: 3,
			typeLine: 'Creature — Human Wizard',
			oracleText:
				'Whenever you cast a Spirit or Arcane spell, you may put a ki counter on Callow Jushi.\nAt the beginning of the end step, if there are two or more ki counters on Callow Jushi, you may flip it.',
			colors: ['U'],
			power: '2',
			toughness: '2',
			layout: 'flip',
			faces: [
				{
					name: 'Callow Jushi',
					manaCost: '{1}{U}{U}',
					cmc: 3,
					typeLine: 'Creature — Human Wizard',
					oracleText:
						'Whenever you cast a Spirit or Arcane spell, you may put a ki counter on Callow Jushi.\nAt the beginning of the end step, if there are two or more ki counters on Callow Jushi, you may flip it.',
					colors: ['U'],
					power: '2',
					toughness: '2',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Jaraku the Interloper',
					manaCost: '',
					cmc: 0,
					typeLine: 'Legendary Creature — Human Wizard',
					oracleText: 'Remove a ki counter from Jaraku: Counter target spell unless its controller pays {2}.',
					colors: ['U'],
					power: '3',
					toughness: '4',
					keywords: [],
					imageUrl: ''
				}
			]
		});
		// Short name "Jaraku" normalizes to ~ cleanly on Legendary Creature back face!
		assert.equal(compileCard(callowJushi).fullySupported, true);

		const { state, p1 } = setupGame();
		const perm = putInZone(state, p1, jushi, 'battlefield');
		// Put 8 cards in hand so drawing 1 brings hand size to 9 -> flips Jushi Apprentice!
		for (let i = 0; i < 8; i++) {
			putInZone(state, p1, p1.library[0].card, 'hand');
		}
		giveMana(p1, { U: 3 });
		const actAb = getEffectiveActivatedAbilities(state, p1, perm)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: perm.instanceId,
				abilityId: actAb.id,
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(perm.isFlipped, true);
		const ev = evaluatePermanent(state, perm);
		assert.equal(ev.effectiveName, 'Tomoya the Revealer');
		assert.equal(ev.power, 2);
		assert.equal(ev.toughness, 3);
		assert.equal(ev.typeLine.includes('Legendary'), true);

		// CR 710.1c: flipped permanent retains its top-half mana cost (MV 2) and color (['U'])!
		assert.equal(effectiveManaValue(perm.card, instanceFaceOptions(perm, 'battlefield')), 2);
		assert.deepEqual(
			activeCharacteristics(perm.card, instanceFaceOptions(perm, 'battlefield')).colors,
			['U']
		);

		// CR 400.7 / 710.4: leaving the battlefield resets flipped state
		moveObject(state, perm, 'graveyard', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			bumpVersion: true,
			newTimestamp: true,
			leaveBattlefieldReset: true
		});
		assert.equal(Boolean(perm.isFlipped), false);
	});

	it('supports Homura-style "return ~ to the battlefield flipped" death triggers', () => {
		const homura = synthCard({
			name: 'Ember Ascendant',
			manaCost: '{4}{R}{R}',
			cmc: 6,
			typeLine: 'Legendary Creature — Human Monk',
			oracleText: 'When Ember Ascendant dies, return it to the battlefield flipped.',
			colors: ['R'],
			power: '4',
			toughness: '4',
			layout: 'flip',
			faces: [
				{
					name: 'Ember Ascendant',
					manaCost: '{4}{R}{R}',
					cmc: 6,
					typeLine: 'Legendary Creature — Human Monk',
					oracleText: 'When Ember Ascendant dies, return it to the battlefield flipped.',
					colors: ['R'],
					power: '4',
					toughness: '4',
					keywords: [],
					imageUrl: ''
				},
				{
					name: 'Essence of Ember',
					manaCost: '',
					cmc: 0,
					typeLine: 'Legendary Enchantment',
					oracleText: 'Creatures you control get +2/+2 and have flying.',
					colors: ['R'],
					keywords: [],
					imageUrl: ''
				}
			]
		});
		assert.equal(compileCard(homura).fullySupported, true);

		const { state, p1 } = setupGame();
		const perm = putInZone(state, p1, homura, 'battlefield');
		const bear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Grizzly Cub',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				oracleText: '',
				colors: ['G'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		perm.damageMarked = 4;
		checkStateBasedActions(state);
		assert.equal(state.stack.length, 1);
		resolveAllStack(state);

		const returned = p1.battlefield.find(
			(c) => evaluatePermanent(state, c).effectiveName === 'Essence of Ember'
		);
		assert.ok(returned, 'Flipped enchantment face should enter the battlefield');
		assert.equal(returned.isFlipped, true);
		assert.equal(evaluatePermanent(state, bear).power, 4);
		assert.equal(hasKeyword(bear, 'Flying', state), true);
	});
});

// ---- 3. Line-Syntax Frame Keywords: ∞/Harness, Companion, Offering, Vanishing, Modular—Sunburst, Partner with ----

describe('Wave 6 Track P18b — Line-Syntax Frame Keywords', () => {
	it('compiles ∞ — <ability> & Harness ~ (CR 702.186, CR 701.64) and gates the infinity ability until harnessed', () => {
		const soulStone = synthCard({
			name: 'Astral Relic Stone',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Legendary Artifact — Infinity Stone',
			oracleText:
				'Indestructible\n{T}: Add {B}.\n{4}{B}{B}, {T}: Harness Astral Relic Stone.\n∞ — At the beginning of your upkeep, return target creature card from your graveyard to the battlefield.',
			colors: ['B']
		});
		assert.equal(compileCard(soulStone).fullySupported, true);

		const { state, p1 } = setupGame();
		const stone = putInZone(state, p1, soulStone, 'battlefield');
		const deadCreature = putInZone(
			state,
			p1,
			synthCard({
				name: 'Fallen Knight',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Zombie Knight',
				oracleText: '',
				colors: ['B'],
				power: '2',
				toughness: '2'
			}),
			'graveyard'
		);

		// Before Harness: upkeep does NOT trigger the ∞ — ability
		state.phase = 'upkeep';
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 0);
		assert.equal(p1.graveyard.length, 1);

		// Activate Harness ability in main1
		state.phase = 'main1';
		stone.tapped = false;
		giveMana(p1, { B: 6 });
		const harnessAb = getEffectiveActivatedAbilities(state, p1, stone).find(
			(a) => !a.isManaAbility
		)!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: stone.instanceId,
				abilityId: harnessAb.id,
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(stone.isHarnessed, true);

		// Next upkeep: ∞ — ability triggers and reanimates Fallen Knight!
		runBeginningOfTurn(state);
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].purpose === 'trigger_targets') {
			const prm = state.pendingPrompts[0];
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [deadCreature.instanceId] }
			});
		}
		resolveAllStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.card.name === 'Fallen Knight'),
			true
		);

		// CR 400.7: LTB resets isHarnessed
		moveObject(state, stone, 'exile', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			bumpVersion: true,
			newTimestamp: true,
			leaveBattlefieldReset: true
		});
		assert.equal(Boolean(stone.isHarnessed), false);
	});

	it('validates all 10 Companion deckbuilding conditions (CR 702.139) and executes the {3} companion_to_hand special action once per game (CR 116.2g)', () => {
		const cmd = synthCard({
			name: 'Five-Color Commander',
			manaCost: '{W}{U}{B}{R}',
			cmc: 4,
			typeLine: 'Legendary Creature — Elemental Cat',
			oracleText: '{G}: Gain 1 life.',
			colors: ['W', 'U', 'B', 'R'],
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			power: '4',
			toughness: '4'
		});
		const land = synthCard({
			name: 'Plain Field',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Plains',
			oracleText: '({T}: Add {W}.)'
		});
		const makeCompCard = (name: string, condText: string) =>
			synthCard({
				name,
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Legendary Creature — Beast',
				oracleText: `Companion — ${condText}\nVigilance`,
				power: '3',
				toughness: '3'
			});

		// 1. Lurrus (permanents MV <= 2)
		const lurrus = synthCard({
			name: 'Lurrus, Dream Den',
			manaCost: '{1}{W/B}{W/B}',
			cmc: 3,
			typeLine: 'Legendary Creature — Cat Nightmare',
			oracleText:
				'Companion — Each permanent card in your starting deck has mana value 2 or less.\nLifelink',
			colors: ['W', 'B'],
			colorIdentity: ['W', 'B'],
			power: '3',
			toughness: '2'
		});
		assert.equal(compileCard(lurrus).fullySupported, true);
		assert.equal(validateCompanionDeckCondition(lurrus, [cmd, land]).ok, false);
		const cheapCmd = synthCard({
			name: 'Tiny Cat',
			manaCost: '{W}{B}',
			cmc: 2,
			typeLine: 'Legendary Creature — Cat',
			oracleText: '{1}: Gain 1 life.',
			colors: ['W', 'B'],
			colorIdentity: ['W', 'B'],
			power: '2',
			toughness: '2'
		});
		assert.equal(validateCompanionDeckCondition(lurrus, [cheapCmd, land]).ok, true);

		// 2. Gyruda (even MV)
		const gyruda = makeCompCard(
			'Gyruda, Doom Kraken',
			'Your starting deck contains only cards with even mana values.'
		);
		assert.equal(compileCard(gyruda).fullySupported, true);
		const oddCard = synthCard({ name: 'Odd Bolt', manaCost: '{R}', cmc: 1, typeLine: 'Instant' });
		assert.equal(validateCompanionDeckCondition(gyruda, [cmd, land]).ok, true);
		assert.equal(validateCompanionDeckCondition(gyruda, [cmd, oddCard]).ok, false);

		// 3. Obosh (odd MV + lands)
		const obosh = makeCompCard(
			'Obosh, Preycerator',
			'Your starting deck contains only cards with odd mana values and land cards.'
		);
		assert.equal(compileCard(obosh).fullySupported, true);
		const oddCmd = synthCard({
			name: 'Odd Commander',
			manaCost: '{1}{R}{G}',
			cmc: 3,
			typeLine: 'Legendary Creature — Beast',
			power: '3',
			toughness: '3'
		});
		assert.equal(validateCompanionDeckCondition(obosh, [oddCmd, land, oddCard]).ok, true);
		assert.equal(validateCompanionDeckCondition(obosh, [cmd, land]).ok, false);

		// 4. Keruga (MV >= 3 + lands)
		const keruga = makeCompCard(
			'Keruga, Macrosage',
			'Your starting deck contains only cards with mana value 3 or greater and land cards.'
		);
		assert.equal(compileCard(keruga).fullySupported, true);
		assert.equal(validateCompanionDeckCondition(keruga, [cmd, land]).ok, true);
		assert.equal(validateCompanionDeckCondition(keruga, [cmd, oddCard]).ok, false);

		// 5. Jegantha (no repeated mana symbol)
		const jegantha = makeCompCard(
			'Jegantha, Wellspring',
			'No card in your starting deck has more than one of the same mana symbol in its mana cost.'
		);
		assert.equal(compileCard(jegantha).fullySupported, true);
		const doublePip = synthCard({
			name: 'Counterspell Clone',
			manaCost: '{U}{U}',
			cmc: 2,
			typeLine: 'Instant'
		});
		assert.equal(validateCompanionDeckCondition(jegantha, [cmd, land]).ok, true);
		assert.equal(validateCompanionDeckCondition(jegantha, [cmd, doublePip]).ok, false);

		// 6. Kaheera (Cat/Elemental/Nightmare/Dinosaur/Beast)
		const kaheera = makeCompCard(
			'Kaheera, Orphanguard',
			'Each creature card in your starting deck is a Cat, Elemental, Nightmare, Dinosaur, or Beast card.'
		);
		assert.equal(compileCard(kaheera).fullySupported, true);
		const elf = synthCard({
			name: 'Forest Elf',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Creature — Elf',
			power: '1',
			toughness: '1'
		});
		assert.equal(validateCompanionDeckCondition(kaheera, [cmd, land]).ok, true);
		assert.equal(validateCompanionDeckCondition(kaheera, [cmd, elf]).ok, false);

		// 7. Lutri (singleton nonlands)
		const lutri = makeCompCard(
			'Lutri, Spellchaser',
			'Each nonland card in your starting deck has a different name.'
		);
		assert.equal(compileCard(lutri).fullySupported, true);
		assert.equal(validateCompanionDeckCondition(lutri, [cmd, land, land, oddCard]).ok, true);
		assert.equal(validateCompanionDeckCondition(lutri, [cmd, oddCard, oddCard]).ok, false);

		// 8. Umori (shared card type among nonlands)
		const umori = makeCompCard(
			'Umori, Collector',
			'Each nonland card in your starting deck shares a card type.'
		);
		assert.equal(compileCard(umori).fullySupported, true);
		assert.equal(validateCompanionDeckCondition(umori, [cmd, land, elf]).ok, true);
		assert.equal(validateCompanionDeckCondition(umori, [cmd, oddCard]).ok, false);

		// 9. Yorion (>= minimum + 20)
		const yorion = makeCompCard(
			'Yorion, Sky Nomad',
			'Your starting deck contains at least twenty cards more than the minimum deck size.'
		);
		assert.equal(compileCard(yorion).fullySupported, true);
		assert.equal(validateCompanionDeckCondition(yorion, [cmd, land], 60).ok, false);
		assert.equal(
			validateCompanionDeckCondition(
				yorion,
				[cmd, ...Array.from({ length: 79 }, () => land)],
				60
			).ok,
			true
		);

		// 10. Zirda (each permanent card has an activated ability + static non-mana cost reduction)
		const zirda = synthCard({
			name: 'Zirda, Dawn Fox',
			manaCost: '{1}{R/W}{R/W}',
			cmc: 3,
			typeLine: 'Legendary Creature — Elemental Fox',
			oracleText:
				"Companion — Each permanent card in your starting deck has an activated ability.\nAbilities you activate that aren't mana abilities cost {2} less to activate. This effect can't reduce the mana in that cost to less than one mana.",
			colors: ['R', 'W'],
			colorIdentity: ['R', 'W'],
			power: '3',
			toughness: '3'
		});
		assert.equal(compileCard(zirda).fullySupported, true);
		assert.equal(validateCompanionDeckCondition(zirda, [cmd, land]).ok, true);
		assert.equal(validateCompanionDeckCondition(zirda, [cmd, elf]).ok, false);

		// Validate Commander 100-card deck check rejects an illegal Companion
		const ninetyNineLands: DeckCardEntry[] = [{ card: land, quantity: 99 }];
		const badCommanderCheck = validateCommanderDeck([cmd], ninetyNineLands, lurrus);
		assert.equal(badCommanderCheck.isLegal, false);
		assert.equal(
			badCommanderCheck.errors.some((e) => e.includes('Companion')),
			true
		);

		// Runtime CR 116.2g: {3} special action moves companion into hand once per game at sorcery timing
		const { state, p1, p2 } = setupGame({ p1Commanders: [cheapCmd], p1Companion: lurrus });
		assert.ok(p1.companion);
		assert.equal(Boolean(p1.companionMovedToHand), false);

		// Fails without {3} mana
		assert.equal(applyGameAction(state, p1.playerId, { type: 'companion_to_hand' }).ok, false);

		// Fails at instant timing (e.g. upkeep)
		giveMana(p1, { W: 3 });
		state.phase = 'upkeep';
		assert.equal(checkCompanionSpecialActionLegality(state, p1.playerId).ok, false);

		// Succeeds in main1 with empty stack!
		state.phase = 'main1';
		assert.equal(checkCompanionSpecialActionLegality(state, p1.playerId).ok, true);
		const compAct = applyGameAction(state, p1.playerId, { type: 'companion_to_hand' });
		assert.equal(compAct.ok, true);
		assert.equal(p1.companionMovedToHand, true);
		assert.equal(p1.manaPool.W, 0);
		assert.equal(
			p1.hand.some((c) => c.card.name === 'Lurrus, Dream Den'),
			true
		);

		// Cannot be used a second time in the same game
		giveMana(p1, { W: 3 });
		assert.equal(checkCompanionSpecialActionLegality(state, p1.playerId).ok, false);

		// Also verify Zirda reduces non-mana activated ability {3} -> {1} (respecting min 1 floor)
		const zPerm = putInZone(state, p1, zirda, 'battlefield');
		const rod = putInZone(
			state,
			p1,
			synthCard({
				name: 'Jayemdae Scroll',
				manaCost: '{4}',
				cmc: 4,
				typeLine: 'Artifact',
				oracleText: '{3}, {T}: Draw a card.'
			}),
			'battlefield'
		);
		p1.manaPool.W = 1; // Only 1 mana needed instead of 3!
		const rodAb = getEffectiveActivatedAbilities(state, p1, rod)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: rod.instanceId,
				abilityId: rodAb.id,
				targets: []
			}).ok,
			true
		);
		assert.equal(p1.manaPool.W, 0);
		assert.ok(zPerm && p2);
	});

	it('compiles [Subtype] offering (CR 702.48a–c) with flash timing, sacrifice cost, and colored + generic mana reduction', () => {
		const patron = synthCard({
			name: 'Patron of the Swarm',
			manaCost: '{5}{B}{B}',
			cmc: 7,
			typeLine: 'Legendary Creature — Spirit',
			oracleText: 'Rat offering\nMenace',
			colors: ['B'],
			power: '6',
			toughness: '6'
		});
		assert.equal(compileCard(patron).fullySupported, true);

		const { state, p1 } = setupGame();
		// Put it on opponent's turn in declare_blockers to test Flash permission from Offering (CR 702.48a)
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		state.phase = 'declare_blockers';

		const rat = putInZone(
			state,
			p1,
			synthCard({
				name: 'Ravenous Ratling',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Rat',
				oracleText: '',
				colors: ['B'],
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const patronHand = putInZone(state, p1, patron, 'hand');

		// Normal cast is illegal on opponent's turn without flash, and {5}{B}{B} minus {1}{B} = {4}{B} (5 mana)!
		giveMana(p1, { B: 5 });
		const opts = getCastOptions(state, p1.playerId, patronHand, 'hand');
		const offerOpt = opts.find((o) => o.id === 'alt:offering')!;
		assert.ok(offerOpt, 'Rat offering CastOption should be legal at instant speed with 5 mana');

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: patronHand.instanceId,
			fromZone: 'hand',
			optionId: offerOpt.id,
			targets: []
		});
		assert.equal(castRes.ok, true);
		assert.equal(p1.manaPool.B, 0);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === rat.instanceId),
			true
		);
		resolveAllStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.card.name === 'Patron of the Swarm'),
			true
		);
	});

	it('compiles bare Vanishing (CR 702.63b), Modular—Sunburst (CR 702.43–44), and Partner with [Name] reveal: true (CR 702.124j)', () => {
		const bareVanish = synthCard({
			name: 'Chrono Phantom',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Creature — Illusion',
			oracleText: 'Vanishing\nChrono Phantom enters with two time counters on it.',
			colors: ['U'],
			power: '3',
			toughness: '3'
		});
		assert.equal(compileCard(bareVanish).fullySupported, true);

		const solarion = synthCard({
			name: 'Solar Construct',
			manaCost: '{7}',
			cmc: 7,
			typeLine: 'Artifact Creature — Construct',
			oracleText: 'Modular—Sunburst',
			power: '0',
			toughness: '0'
		});
		assert.equal(compileCard(solarion).fullySupported, true);

		const partnerCard = synthCard({
			name: 'blade_partner',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Legendary Creature — Human Warrior',
			oracleText: 'Partner with Shield Partner\nHaste',
			colors: ['R'],
			power: '3',
			toughness: '2'
		});
		const pDef = compileCard(partnerCard);
		assert.equal(pDef.fullySupported, true);
		const etbSearch = pDef.faces[0].abilities.find((a) => a.kind === 'triggered');
		assert.ok(etbSearch && etbSearch.kind === 'triggered');
		assert.equal(etbSearch.effect[0]?.params?.search?.reveal, true);
	});
});

// ---- 4. Expanded Modals & Sieges (CR 700.2, CR 614.12c) -------------------------------------

describe('Wave 6 Track P18b — Expanded Modals & Siege Anchor Choices', () => {
	it('executes repeatable Confluence modals, Bloomburrow {P} Season pawprint budgets, and pre/post modal riders', () => {
		// 1. Repeatable Confluence + post-modal rider ("Draw a card.")
		const confluence = synthCard({
			name: 'Cinder Confluence',
			manaCost: '{2}{R}{R}',
			cmc: 4,
			typeLine: 'Sorcery',
			oracleText:
				'Choose three. You may choose the same mode more than once.\n• Cinder Confluence deals 1 damage to each creature.\n• Cinder Confluence deals 2 damage to each opponent.\n• Gain 2 life.\nDraw a card.',
			colors: ['R']
		});
		assert.equal(compileCard(confluence).fullySupported, true);

		// 2. Bloomburrow {P} Season pawprint budget (budget = 5, costs = [1, 2, 3])
		const season = synthCard({
			name: 'Season of Hearth',
			manaCost: '{3}{W}{W}',
			cmc: 5,
			typeLine: 'Sorcery',
			oracleText:
				'Choose up to five {P} worth of modes. You may choose the same mode more than once.\n{P} — Gain 2 life.\n{P}{P} — Scry 2.\n{P}{P}{P} — Draw two cards.',
			colors: ['W']
		});
		assert.equal(compileCard(season).fullySupported, true);

		const { state, p1, p2 } = setupGame();
		const confHand = putInZone(state, p1, confluence, 'hand');
		giveMana(p1, { R: 4 });
		// Choose mode 1 ("2 damage to each opponent") three times -> 6 damage + suffix "Draw a card"!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: confHand.instanceId,
				fromZone: 'hand',
				modes: [1, 1, 1],
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.life, 34);
		assert.equal(p1.hand.length, 1);

		// Season pawprint budget: [2, 2] costs 3 + 3 = 6 > 5 -> REJECTED!
		const seasonHand = putInZone(state, p1, season, 'hand');
		giveMana(p1, { W: 5 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: seasonHand.instanceId,
				fromZone: 'hand',
				modes: [2, 2],
				targets: []
			}).ok,
			false
		);
		// [2, 0, 0] costs 3 + 1 + 1 = 5 <= 5 -> ACCEPTED! Draws 2 cards + gains 4 life!
		const handBefore = p1.hand.length;
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: seasonHand.instanceId,
				fromZone: 'hand',
				modes: [2, 0, 0],
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.life, lifeBefore + 4);
		// -1 cast Season + 2 drawn = handBefore + 1
		assert.equal(p1.hand.length, handBefore + 1);
	});

	it('tracks "Choose one that hasn\'t been chosen" permanently across turns (CR 607.2d) and resets on LTB', () => {
		const pact = synthCard({
			name: 'Threefold Oathstone',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText:
				"{1}, {T}: Choose one that hasn't been chosen —\n• Gain 3 life.\n• Draw a card.",
			colors: ['B']
		});
		assert.equal(compileCard(pact).fullySupported, true);

		const { state, p1 } = setupGame();
		const stone = putInZone(state, p1, pact, 'battlefield');
		const ab = getEffectiveActivatedAbilities(state, p1, stone)[0];

		giveMana(p1, { B: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: stone.instanceId,
				abilityId: ab.id,
				chosenModes: [0],
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.deepEqual(stone.usedModalModesPermanent, [0]);

		// Next turn: mode 0 is STILL unavailable even after beginning-of-turn cleanup!
		runBeginningOfTurn(state);
		stone.tapped = false;
		giveMana(p1, { B: 1 });
		const repeatMode0 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: stone.instanceId,
			abilityId: ab.id,
			chosenModes: [0],
			targets: []
		});
		assert.equal(repeatMode0.ok, false);

		// Mode 1 is still unchosen and succeeds!
		const chooseMode1 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: stone.instanceId,
			abilityId: ab.id,
			chosenModes: [1],
			targets: []
		});
		assert.equal(chooseMode1.ok, true);
		resolveAllStack(state);
		assert.deepEqual(stone.usedModalModesPermanent, [0, 1]);

		// Both modes now exhausted -> activation itself is illegal
		stone.tapped = false;
		giveMana(p1, { B: 1 });
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, stone, ab).ok, false);
	});

	it('prompts on ETB for Siege "As ~ enters, choose Khans or Dragons" and activates only the chosen anchor', () => {
		const siege = synthCard({
			name: 'Citadel SiegeEngine',
			manaCost: '{2}{W}{W}',
			cmc: 4,
			typeLine: 'Enchantment',
			oracleText:
				'As Citadel SiegeEngine enters, choose Khans or Dragons.\n• Khans — Creatures you control get +1/+1.\n• Dragons — Creatures you control have flying.',
			colors: ['W']
		});
		assert.equal(compileCard(siege).fullySupported, true);

		const { state, p1 } = setupGame();
		const soldier = putInZone(
			state,
			p1,
			synthCard({
				name: 'Steppe Recruit',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Creature — Human Soldier',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const siegeHand = putInZone(state, p1, siege, 'hand');
		giveMana(p1, { W: 4 });

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: siegeHand.instanceId,
				fromZone: 'hand',
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);

		// Should pause with etb_choice prompt ("Khans" vs "Dragons")
		assert.equal(state.pendingPrompts.length, 1);
		const prm = state.pendingPrompts[0];
		assert.equal(prm.purpose, 'etb_choice');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseMode', indices: [1] } // Choose "Dragons"
			}).ok,
			true
		);

		const siegePerm = p1.battlefield.find((c) => c.card.name === 'Citadel SiegeEngine')!;
		assert.equal(siegePerm.chosenAnchorWord, 'Dragons');
		// Dragons grants flying, NOT Khans +1/+1!
		assert.equal(hasKeyword(soldier, 'Flying', state), true);
		assert.equal(evaluatePermanent(state, soldier).power, 2);
	});

	it('resolves opponentChooses and randomMode modal spells cleanly', () => {
		const oppModal = synthCard({
			name: 'Bitter Ultimatum Lite',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'An opponent chooses one —\n• You gain 2 life.\n• You draw a card.',
			colors: ['B']
		});
		const randModal = synthCard({
			name: 'Chaotic Whim',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Choose one at random —\n• Gain 3 life.\n• Draw a card.',
			colors: ['R']
		});
		assert.equal(compileCard(oppModal).fullySupported, true);
		assert.equal(compileCard(randModal).fullySupported, true);

		const { state, p1, p2 } = setupGame();
		const oppHand = putInZone(state, p1, oppModal, 'hand');
		giveMana(p1, { B: 2 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: oppHand.instanceId,
				fromZone: 'hand',
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		// Opponent (p2) receives the mode-choice prompt during resolution!
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].playerId, p2.playerId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [0] }
			}).ok,
			true
		);
		assert.equal(p1.life, 42);

		// Random mode resolves deterministically with zero human prompt
		const randHand = putInZone(state, p1, randModal, 'hand');
		giveMana(p1, { R: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: randHand.instanceId,
				fromZone: 'hand',
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 0);

		// Dynamic "Choose X" modal + "If you control a Dragon, you may choose all modes instead."
		const xModal = synthCard({
			name: 'Scale-Count Decree',
			manaCost: '{X}{G}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Choose X. You may choose the same mode more than once.\n• Gain 2 life.\n• Draw a card.',
			colors: ['G']
		});
		assert.equal(compileCard(xModal).fullySupported, true);
		const xModalHand = putInZone(state, p1, xModal, 'hand');
		giveMana(p1, { G: 3 }); // X = 2 -> must choose 2 modes
		const prevLife = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: xModalHand.instanceId,
				fromZone: 'hand',
				xValue: 2,
				modes: [0, 0],
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.life, prevLife + 4);
	});
});

// ---- 5. Riders, Semicolons, Pronouns, Helper Filtering & Synthetic Rename Invariance ---------

describe('Wave 6 Track P18b — Riders, Semicolons, Pronouns, Filtering & Rename Invariance', () => {
	it('enforces "X can\'t be 0", "Activate only once", activationCostReduction, and "you\'ve been attacked this step"', () => {
		const xSpell = synthCard({
			name: 'Nonzero Zenith',
			manaCost: '{X}{R}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: "Nonzero Zenith deals X damage to each opponent. X can't be 0.",
			colors: ['R']
		});
		assert.equal(compileCard(xSpell).fullySupported, true);

		const onceArtifact = synthCard({
			name: 'Single-Charge Dynamo',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText:
				'1: Gain 2 life. Activate only once.\n{4}, {T}: Draw a card. This ability costs {2} less to activate if you control a creature.'
		});
		// Fix "{1}:" mana syntax on Single-Charge Dynamo
		const dynamo = synthCard({
			name: 'Single-Charge Dynamo',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText:
				'{1}: Gain 2 life. Activate only once.\n{4}, {T}: Draw a card. This ability costs {2} less to activate if you control a creature.'
		});
		void onceArtifact;
		assert.equal(compileCard(dynamo).fullySupported, true);

		const defiantStand = synthCard({
			name: 'Valiant Stand',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				"Cast Valiant Stand only during the declare attackers step and only if you've been attacked this step.\nGain 4 life.",
			colors: ['W']
		});
		assert.equal(compileCard(defiantStand).fullySupported, true);

		const { state, p1, p2 } = setupGame();
		const xHand = putInZone(state, p1, xSpell, 'hand');
		// With only {R} (1 mana), checkSpellCastLegality enforces minimum X = 1 ({1}{R} = 2 mana) -> illegal!
		giveMana(p1, { R: 1 });
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, xHand, 'hand', 0, 'normal').ok,
			false
		);
		// With {R}{R} (2 mana), casting explicitly with X = 0 is still illegal!
		giveMana(p1, { R: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: xHand.instanceId,
				fromZone: 'hand',
				xValue: 0,
				targets: []
			}).ok,
			false
		);
		// X = 1 is legal!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: xHand.instanceId,
				fromZone: 'hand',
				xValue: 1,
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.life, 39);

		// Activate only once + conditional {2} activationCostReduction
		const dynPerm = putInZone(state, p1, dynamo, 'battlefield');
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Helper Myr',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact Creature — Myr',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const [onceAb, reducedAb] = getEffectiveActivatedAbilities(state, p1, dynPerm);
		giveMana(p1, { W: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: dynPerm.instanceId,
				abilityId: onceAb.id,
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		// Still blocked on future turns!
		runBeginningOfTurn(state);
		giveMana(p1, { W: 1 });
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, dynPerm, onceAb).ok, false);

		// {4}, {T} reduced by {2} (since p1 controls Helper Myr) -> playable with {2} total mana!
		p1.manaPool.W = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: dynPerm.instanceId,
				abilityId: reducedAb.id,
				targets: []
			}).ok,
			true
		);
		assert.equal(p1.manaPool.W, 0);

		// "Cast ~ only during the declare attackers step and only if you've been attacked this step."
		const standHand = putInZone(state, p1, defiantStand, 'hand');
		giveMana(p1, { W: 2 });
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, standHand, 'hand', 0, 'normal').ok,
			false
		);
		state.phase = 'declare_attackers';
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		const oppAttacker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Goblin Raider',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Goblin',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		state.combat.active = true;
		state.combat.attackers = [
			{
				attackerInstanceId: oppAttacker.instanceId,
				controllerId: p2.playerId,
				defenderPlayerId: p1.playerId,
				blockerInstanceIds: []
			}
		];
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, standHand, 'hand', 0, 'normal').ok,
			true
		);
	});

	it('compiles semicolon keyword lists, Planeswalker him/her self-pronouns, and filters set_type: token helper cards', () => {
		const semiCard = synthCard({
			name: 'Wardwing Samurai',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Human Samurai',
			oracleText: 'Flying; ward {2}\nDouble strike; bushido 2',
			colors: ['W'],
			power: '2',
			toughness: '2'
		});
		assert.equal(compileCard(semiCard).fullySupported, true);

		const gideon = synthCard({
			name: 'Gideon, Battle Paragon',
			manaCost: '{3}{W}{W}',
			cmc: 5,
			typeLine: 'Legendary Planeswalker — Gideon',
			oracleText:
				'+1: Up to one target creature gets +1/+1 until end of turn.\n0: Until end of turn, Gideon, Battle Paragon becomes a 5/5 Human Soldier creature with indestructible that\'s still a planeswalker. Prevent all damage that would be dealt to him this turn.',
			colors: ['W'],
			loyalty: '4'
		});
		assert.equal(compileCard(gideon).fullySupported, true);
		const report = cardSupportReport(gideon);
		assert.equal(report.fullySupported, true);

		// Helper/token card filtering
		assert.equal(
			isNonPlayableRawScryfallRecord({
				layout: 'normal',
				set_type: 'token',
				type_line: 'Card'
			}),
			true
		);
		const leakedHelper = synthCard({
			name: 'Day // Night Helper',
			manaCost: '',
			cmc: 0,
			typeLine: 'Card',
			oracleText: ' Unparseable helper text! ',
			setType: 'token'
		});
		assert.equal(isNonPlayableHelperCard(leakedHelper), true);
		const helperDeck = makeDeck([leakedHelper]);
		assert.equal(
			deckUnsupportedCards(helperDeck.commanders, helperDeck.cards, helperDeck.companion).length,
			0
		);
	});

	it('upholds synthetic card-name rename invariance (ENGINE_INVARIANTS.md §1.3) and bot xCantBeZero/Companion safety', () => {
		const canonical = synthCard({
			name: 'The Soul Stone',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Legendary Artifact — Infinity Stone',
			oracleText:
				'Indestructible\n{T}: Add {B}.\n{6}{B}, {T}: Harness The Soul Stone.\n∞ — At the beginning of your upkeep, return target creature card from your graveyard to the battlefield.',
			colors: ['B']
		});
		const invented = synthCard({
			name: 'Glimmerfen Prism',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Legendary Artifact — Infinity Stone',
			oracleText:
				'Indestructible\n{T}: Add {B}.\n{6}{B}, {T}: Harness Glimmerfen Prism.\n∞ — At the beginning of your upkeep, return target creature card from your graveyard to the battlefield.',
			colors: ['B']
		});
		const cDef = compileCard(canonical);
		const iDef = compileCard(invented);
		assert.equal(cDef.fullySupported, true);
		assert.equal(iDef.fullySupported, true);
		const stripSpans = (v: unknown): unknown =>
			JSON.parse(
				JSON.stringify(v, (k, val) => (k === 'span' || k === 'text' ? undefined : val))
			);
		assert.deepEqual(stripSpans(cDef.faces[0].abilities), stripSpans(iDef.faces[0].abilities));

		// Bot main2 companion_to_hand safety
		const botCompanion = synthCard({
			name: 'Vigilant Fox Companion',
			manaCost: '{1}{W}{W}',
			cmc: 3,
			typeLine: 'Legendary Creature — Cat',
			oracleText:
				'Companion — Each permanent card in your starting deck has mana value 2 or less.\nVigilance',
			colors: ['W'],
			power: '2',
			toughness: '2'
		});
		const { state, p1 } = setupGame({ p1Bot: true, p1Companion: botCompanion });
		state.phase = 'main2';
		giveMana(p1, { W: 3 });
		const botStep = executeBotStep(state, p1, p1);
		assert.equal(botStep, 'visible');
		assert.equal(p1.companionMovedToHand, true);
		assert.equal(
			p1.hand.some((c) => c.card.name === 'Vigilant Fox Companion'),
			true
		);
	});
});
