import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	advancePhaseOrStep,
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	checkStateBasedActions,
	createInitialGameState,
	evaluatePermanent,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	hasKeyword
} from '../engine.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { matchesObjectFilter } from './objectFilter.ts';
import { attachObject, createEmptyCounters, moveObject } from './zones.ts';
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

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p20a_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p20a_${synthSeq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
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
		id: 'deck_p20a',
		userId: 'p1',
		name: 'Track P20a Deck',
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

function setupGame(
	opts: {
		p1Bot?: boolean;
		p2Bot?: boolean;
		startingLife?: number;
		threePlayer?: boolean;
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P20a Filler Land',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Wastes',
		oracleText: '{T}: Add {C}.'
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
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
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
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
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
			username: 'Carol',
			avatarUrl: '',
			isBot: false,
			deckId: d3.id,
			deckName: d3.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
		decks.set(2, d3);
	}
	const startLife = opts.startingLife ?? 20;
	const state = createInitialGameState('P20A_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: startLife
	});
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	state.phase = 'main1';
	state.turnNumber = 2;
	for (const p of state.players) {
		p.life = startLife;
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	noteLayerInputsChanged(state);
	return {
		state,
		p1: state.players[0],
		p2: state.players[1],
		p3: state.players[2]
	};
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const rep = definitionSupportReport(compileCard(card));
	assert.equal(
		rep.fullySupported,
		true,
		`Expected synthetic card "${card.name}" to compile cleanly, got unsupported: ${JSON.stringify(rep.unsupported)}`
	);
	const inst: CardInstance = {
		instanceId: `inst_${++synthSeq}`,
		card,
		ownerId: player.playerId,
		controllerId: player.playerId,
		defaultControllerId: player.playerId,
		zone: 'exile',
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters: {
			...createEmptyCounters(),
			loyalty: card.loyalty ? parseInt(card.loyalty, 10) : 0
		},
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: false,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		objectVersion: 1
	};
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		newTimestamp: true,
		emit: false
	});
	noteLayerInputsChanged(state);
	return inst;
}

function passAllPriorityOnce(state: GameState): void {
	for (
		let guard = 0;
		guard < 12 && state.stack.length > 0 && state.pendingPrompts.length === 0;
		guard++
	) {
		const prioPlayer = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error);
	}
}

describe('Wave 7 Track P20a — Static Filters, Clones/CDAs, ETB Anchors, Replacements, & Stax', () => {
	it('evaluates Soulbond pairedWithSource grants only on the source and its paired partner', () => {
		const { state, p1 } = setupGame();
		const paladinCard = synthCard({
			name: 'Paired Blade Knight',
			manaCost: '{1}{W}{W}',
			cmc: 3,
			typeLine: 'Creature — Human Knight',
			power: '2',
			toughness: '2',
			colors: ['W'],
			keywords: ['Soulbond'],
			oracleText:
				'Soulbond\nAs long as Paired Blade Knight is paired with another creature, both creatures get +2/+2 and have double strike.'
		});
		const partnerCard = synthCard({
			name: 'Ally Cub',
			power: '2',
			toughness: '2',
			oracleText: ''
		});
		const bystanderCard = synthCard({
			name: 'Unpaired Cub',
			power: '2',
			toughness: '2',
			oracleText: ''
		});
		const paladin = putInZone(state, p1, paladinCard, 'battlefield');
		const partner = putInZone(state, p1, partnerCard, 'battlefield');
		const bystander = putInZone(state, p1, bystanderCard, 'battlefield');

		assert.equal(getCreaturePower(paladin, state), 2);
		assert.equal(hasKeyword(partner, 'double strike', state), false);

		paladin.pairedWithId = partner.instanceId;
		partner.pairedWithId = paladin.instanceId;
		noteLayerInputsChanged(state);

		assert.equal(getCreaturePower(paladin, state), 4);
		assert.equal(getCreatureToughness(paladin, state), 4);
		assert.equal(hasKeyword(paladin, 'double strike', state), true);
		assert.equal(getCreaturePower(partner, state), 4);
		assert.equal(getCreatureToughness(partner, state), 4);
		assert.equal(hasKeyword(partner, 'double strike', state), true);
		assert.equal(getCreaturePower(bystander, state), 2);
		assert.equal(hasKeyword(bystander, 'double strike', state), false);

		paladin.pairedWithId = undefined;
		partner.pairedWithId = undefined;
		noteLayerInputsChanged(state);
		assert.equal(getCreaturePower(partner, state), 2);
		assert.equal(hasKeyword(partner, 'double strike', state), false);
	});

	it('applies Layer 2 Aura control changes and all-zone multi-subtype CDAs across zones', () => {
		const { state, p1, p2 } = setupGame();
		const equipCard = synthCard({
			name: 'Relic Hammer',
			typeLine: 'Artifact — Equipment',
			oracleText: 'Equipped creature gets +2/+0.\nEquip {1}'
		});
		const stealAuraCard = synthCard({
			name: 'Theft Tether',
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant Equipment\nYou control enchanted Equipment.'
		});
		const partyAutomatonCard = synthCard({
			name: 'Omni Party Construct',
			typeLine: 'Artifact Creature — Golem',
			power: '2',
			toughness: '1',
			oracleText: 'Omni Party Construct is also a Cleric, Rogue, Warrior, and Wizard.'
		});

		const equip = putInZone(state, p2, equipCard, 'battlefield');
		const aura = putInZone(state, p1, stealAuraCard, 'battlefield');
		attachObject(state, aura, equip.instanceId);
		noteLayerInputsChanged(state);
		assert.equal(evaluatePermanent(state, equip).controllerId, p1.playerId);

		const inHand = putInZone(state, p1, partyAutomatonCard, 'hand');
		for (const sub of ['Golem', 'Cleric', 'Rogue', 'Warrior', 'Wizard']) {
			assert.equal(
				matchesObjectFilter(
					inHand,
					{ subtypes: [sub] },
					{ state, controllerId: p1.playerId, zone: 'hand' }
				),
				true,
				`Expected hand CDA subtype ${sub}`
			);
		}
		moveObject(state, inHand, 'graveyard', {
			from: { player: p1, zone: 'hand' },
			toPlayer: p1,
			emit: false
		});
		assert.equal(
			matchesObjectFilter(
				inHand,
				{ subtypes: ['Wizard'] },
				{ state, controllerId: p1.playerId, zone: 'graveyard' }
			),
			true
		);
		moveObject(state, inHand, 'battlefield', {
			from: { player: p1, zone: 'graveyard' },
			toPlayer: p1,
			newTimestamp: true,
			emit: false
		});
		const ev = evaluatePermanent(state, inHand);
		for (const sub of ['Cleric', 'Rogue', 'Warrior', 'Wizard']) {
			assert.equal(
				ev.effectiveTypeLine.includes(sub),
				true,
				`Expected battlefield CDA subtype ${sub} in "${ev.effectiveTypeLine}"`
			);
		}
	});

	it('grants lifelink, wither, and deathtouch to instant and sorcery spells on resolution', () => {
		const { state, p1, p2 } = setupGame();
		const granterCard = synthCard({
			name: 'Arcane Siphon Mage',
			power: '2',
			toughness: '2',
			oracleText:
				'Instant and sorcery spells you control have lifelink.\nInstant and sorcery spells you control have wither.'
		});
		const boltCard = synthCard({
			name: 'Searing Spark',
			manaCost: '{R}',
			cmc: 1,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText: 'Searing Spark deals 2 damage to any target.'
		});
		const giantCard = synthCard({
			name: 'Hill Brute',
			power: '4',
			toughness: '4',
			oracleText: ''
		});
		putInZone(state, p1, granterCard, 'battlefield');
		const giant = putInZone(state, p2, giantCard, 'battlefield');
		const bolt = putInZone(state, p1, boltCard, 'hand');
		p1.manaPool.R = 1;

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: bolt.instanceId,
			targets: [{ kind: 'permanent', id: giant.instanceId, label: giant.card.name }]
		});
		assert.equal(castRes.ok, true, castRes.error);
		passAllPriorityOnce(state);

		assert.equal(p1.life, 22, 'Expected spell lifelink to gain 2 life');
		assert.equal(giant.counters['-1/-1'], 2, 'Expected spell wither to place 2 -1/-1 counters');
		assert.equal(giant.damageMarked, 0);
		assert.equal(getCreaturePower(giant, state), 2);
	});

	it('evaluates half-starting-life, most-common-color, toughness>power, and defender combat damage', () => {
		const { state, p1, p2 } = setupGame({ startingLife: 40 });
		const halfLifeCard = synthCard({
			name: 'Dusk Ascendant',
			power: '2',
			toughness: '2',
			colors: ['W'],
			oracleText:
				'As long as you have half your starting life total or less, Dusk Ascendant gets +3/+3.'
		});
		const colorDjinnCard = synthCard({
			name: 'Tide Djinn',
			power: '5',
			toughness: '5',
			colors: ['U'],
			oracleText:
				'As long as blue is the most common color among all permanents, Tide Djinn gets +2/+2.'
		});
		const wallLordCard = synthCard({
			name: 'Bastion Tactician',
			power: '2',
			toughness: '3',
			colors: ['W', 'U'],
			oracleText:
				"Each creature you control with toughness greater than its power gets +1/+1.\nEach creature you control with defender assigns combat damage equal to its toughness rather than its power and can attack as though it didn't have defender."
		});
		const wallCard = synthCard({
			name: 'Stone Rampart',
			power: '0',
			toughness: '4',
			colors: ['U'],
			keywords: ['Defender'],
			oracleText: 'Defender'
		});

		const ascendant = putInZone(state, p1, halfLifeCard, 'battlefield');
		const djinn = putInZone(state, p1, colorDjinnCard, 'battlefield');
		putInZone(state, p1, wallLordCard, 'battlefield');
		const wall = putInZone(state, p1, wallCard, 'battlefield');

		// Starting life is 40: at 25 life (>20), half-life buff is off; at 20 life (<=20), buff is on!
		p1.life = 25;
		noteLayerInputsChanged(state);
		assert.equal(getCreaturePower(ascendant, state), 2);
		p1.life = 20;
		noteLayerInputsChanged(state);
		assert.equal(getCreaturePower(ascendant, state), 5);

		// Blue has 3 permanents (djinn, wallLord, wall), White has 2 (ascendant, wallLord) -> blue is strictly most common!
		assert.equal(getCreaturePower(djinn, state), 7);

		// Wall is 0/4 -> toughnessGreaterThanPower gives +1/+1 -> 1/5, can attack despite defender, and deals 5 toughness damage!
		assert.equal(getCreaturePower(wall, state), 1);
		assert.equal(getCreatureToughness(wall, state), 5);

		advancePhaseOrStep(state); // begin_combat
		advancePhaseOrStep(state); // declare_attackers
		const atkRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: wall.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atkRes.ok, true, atkRes.error);
		advancePhaseOrStep(state); // declare_blockers
		const blkRes = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: []
		});
		assert.equal(blkRes.ok, true, blkRes.error);
		advancePhaseOrStep(state); // combat_damage
		assert.equal(p2.life, 35, 'Expected 1/5 defender creature to deal 5 combat damage via toughness');
	});

	it('enforces odd/even mana-value cast/block locks and ETB choose odd/even with JSON round-trip', () => {
		const { state, p1, p2 } = setupGame();
		const arbiterCard = synthCard({
			name: 'Null Parity Arbiter',
			power: '5',
			toughness: '5',
			oracleText:
				"Your opponents can't cast spells with even mana values.\nYour opponents can't block with creatures with even mana values."
		});
		const mv2SpellCard = synthCard({
			name: 'Two-Cost Rune',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Draw a card.'
		});
		const mv1SpellCard = synthCard({
			name: 'One-Cost Rune',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Draw a card.'
		});
		const mv2BlockerCard = synthCard({
			name: 'Even Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			power: '2',
			toughness: '2',
			oracleText: ''
		});
		const parityEnchantCard = synthCard({
			name: 'Cadence Banner',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText:
				'As Cadence Banner enters, choose odd or even.\nEach creature with mana value of the chosen quality has haste.'
		});

		const arbiter = putInZone(state, p1, arbiterCard, 'battlefield');
		const mv2Spell = putInZone(state, p2, mv2SpellCard, 'hand');
		const mv1Spell = putInZone(state, p2, mv1SpellCard, 'hand');
		const mv2Blocker = putInZone(state, p2, mv2BlockerCard, 'battlefield');
		p2.manaPool.U = 5;

		state.priorityPlayerIndex = 1;
		assert.equal(checkSpellCastLegality(state, p2.playerId, mv2Spell).ok, false);
		assert.equal(checkSpellCastLegality(state, p2.playerId, mv1Spell).ok, true);

		// Blocking check: Even Bear (MV 2) cannot block!
		state.priorityPlayerIndex = 0;
		advancePhaseOrStep(state); // begin_combat
		advancePhaseOrStep(state); // declare_attackers
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: arbiter.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advancePhaseOrStep(state); // declare_blockers
		const badBlk = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: mv2Blocker.instanceId, attackerInstanceId: arbiter.instanceId }
			]
		});
		assert.equal(badBlk.ok, false);

		// Finish combat into main2 and test ETB choose odd/even + JSON round-trip mid-prompt
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: []
			}).ok,
			true
		);
		advancePhaseOrStep(state); // combat_damage
		advancePhaseOrStep(state); // end_combat
		advancePhaseOrStep(state); // main2
		const banner = putInZone(state, p1, parityEnchantCard, 'hand');
		p1.manaPool.R = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: banner.instanceId
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		assert.ok(state.pendingPrompts.length > 0, 'Expected odd/even ETB choice prompt');

		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		const prompt = roundTripped.pendingPrompts[0];
		const ansRes = applyGameAction(roundTripped, roundTripped.players[0].playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseMode', indices: [1] } // Even
		});
		assert.equal(ansRes.ok, true, ansRes.error);
		const rtBlocker = roundTripped.players[1].battlefield.find(
			(b) => b.instanceId === mv2Blocker.instanceId
		)!;
		assert.equal(hasKeyword(rtBlocker, 'haste', roundTripped), true);
	});

	it('handles ETB choose player + protectionFromChosenPlayer + chosenPlayer damage doubler + becomesDayIfNeither', () => {
		const { state, p1, p2 } = setupGame();
		const nemesisCard = synthCard({
			name: 'Sworn Duelist',
			manaCost: '{1}{U}',
			cmc: 2,
			power: '3',
			toughness: '1',
			colors: ['U'],
			oracleText:
				"If it's neither day nor night, it becomes day as Sworn Duelist enters.\nAs Sworn Duelist enters, choose a player.\nSworn Duelist has protection from the chosen player.\nIf a source would deal damage to the chosen player or a permanent they control, it deals double that damage instead."
		});
		const p2ZapCard = synthCard({
			name: 'Rival Zap',
			manaCost: '{R}',
			cmc: 1,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText: 'Rival Zap deals 2 damage to any target.'
		});
		const p1ZapCard = synthCard({
			name: 'Twin Bolt',
			manaCost: '{R}',
			cmc: 1,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText: 'Twin Bolt deals 3 damage to any target.'
		});

		assert.equal(state.dayNight ?? null, null);
		const nemesis = putInZone(state, p1, nemesisCard, 'hand');
		p1.manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: nemesis.instanceId
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		assert.ok(state.pendingPrompts.length > 0, 'Expected ETB choose player prompt');

		// Choose Bob (p2) after JSON round-trip
		const rtState: GameState = JSON.parse(JSON.stringify(state));
		const rtP1 = rtState.players[0];
		const rtP2 = rtState.players[1];
		const prompt = rtState.pendingPrompts[0];
		const bobIdx =
			prompt.choice?.kind === 'chooseMode'
				? prompt.choice.modes.findIndex((m) => m.includes('Bob'))
				: 1;
		assert.equal(
			applyGameAction(rtState, rtP1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseMode', indices: [bobIdx] }
			}).ok,
			true
		);
		assert.equal(rtState.dayNight, 'day');

		const liveNemesis = rtP1.battlefield.find((b) => b.instanceId === nemesis.instanceId)!;
		assert.equal(liveNemesis.chosenPlayerId, rtP2.playerId);

		// p2 cannot target Sworn Duelist due to protectionFromChosenPlayer
		const p2Zap = putInZone(rtState, rtP2, p2ZapCard, 'hand');
		rtP2.manaPool.R = 2;
		rtState.priorityPlayerIndex = 1;
		const illegalTarget = applyGameAction(rtState, rtP2.playerId, {
			type: 'cast_spell',
			instanceId: p2Zap.instanceId,
			targets: [{ kind: 'permanent', id: liveNemesis.instanceId, label: liveNemesis.card.name }]
		});
		assert.equal(
			illegalTarget.ok,
			false,
			'Chosen player should not be able to target permanent with protection from them'
		);

		// p1 deals 3 damage to p2 -> doubled to 6!
		rtState.priorityPlayerIndex = 0;
		const p1Zap = putInZone(rtState, rtP1, p1ZapCard, 'hand');
		rtP1.manaPool.R = 2;
		assert.equal(
			applyGameAction(rtState, rtP1.playerId, {
				type: 'cast_spell',
				instanceId: p1Zap.instanceId,
				targets: [{ kind: 'player', id: rtP2.playerId, label: rtP2.username }]
			}).ok,
			true
		);
		passAllPriorityOnce(rtState);
		assert.equal(rtP2.life, 14, 'Expected 3 damage to chosen player to double to 6');

		// Damage to non-chosen player (rtP1) must NOT be doubled!
		const selfZap = putInZone(rtState, rtP1, p1ZapCard, 'hand');
		rtP1.manaPool.R = 1;
		assert.equal(
			applyGameAction(rtState, rtP1.playerId, {
				type: 'cast_spell',
				instanceId: selfZap.instanceId,
				targets: [{ kind: 'player', id: rtP1.playerId, label: rtP1.username }]
			}).ok,
			true
		);
		passAllPriorityOnce(rtState);
		assert.equal(rtP1.life, 17, 'Expected 3 damage to non-chosen player NOT to double');
	});

	it('handles ETB choose basic land type + setChosenSubtype mana ability, enterUnderOpponentControl, and external enters untapped', () => {
		const { state, p1, p2 } = setupGame();
		const passageCard = synthCard({
			name: 'Shifting Passage',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText:
				"As Shifting Passage enters, choose a basic land type. Then you may pay 2 life. If you don't, it enters tapped.\nShifting Passage is the chosen type."
		});
		const untapGatesCard = synthCard({
			name: 'Portal Steward',
			power: '2',
			toughness: '3',
			oracleText: 'Gates you control enter untapped.'
		});
		const tapGateCard = synthCard({
			name: 'Guild Portal',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land — Gate',
			oracleText: 'Guild Portal enters tapped.\n{T}: Add {G}.'
		});
		const sleeperCard = synthCard({
			name: 'Turncoat Agent',
			manaCost: '{B}',
			cmc: 1,
			power: '3',
			toughness: '3',
			colors: ['B'],
			oracleText: "Turncoat Agent enters tapped under an opponent's control."
		});

		// 1. Play Shifting Passage, choose Island, pay 2 life -> untapped Island with intrinsic {T}: Add {U}!
		const passage = putInZone(state, p1, passageCard, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: passage.instanceId
			}).ok,
			true
		);
		assert.ok(state.pendingPrompts.length > 0);
		const landPrompt = state.pendingPrompts[0];
		const islandIdx =
			landPrompt.choice?.kind === 'chooseMode'
				? landPrompt.choice.modes.indexOf('Island')
				: 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: landPrompt.id,
				answer: { kind: 'chooseMode', indices: [islandIdx] }
			}).ok,
			true
		);
		assert.ok(state.pendingPrompts.length > 0, 'Expected follow-up pay 2 life shockland prompt');
		const shockPrompt = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: shockPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1.life, 18);
		assert.equal(passage.tapped, false);
		assert.equal(evaluatePermanent(state, passage).effectiveTypeLine.includes('Island'), true);
		const manaAbs = getEffectiveActivatedAbilities(state, p1, passage);
		assert.equal(manaAbs.length > 0, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: passage.instanceId,
				abilityId: manaAbs[0].id
			}).ok,
			true
		);
		assert.equal(p1.manaPool.U, 1);

		// 2. External Gates enter untapped overrides Gate's self "enters tapped"!
		p1.landsPlayedThisTurn = 0;
		putInZone(state, p1, untapGatesCard, 'battlefield');
		const gate = putInZone(state, p1, tapGateCard, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: gate.instanceId
			}).ok,
			true
		);
		assert.equal(gate.tapped, false, 'Expected external Gates enter untapped to override enters tapped');

		// 3. Sleeper enters tapped under p2's control!
		const sleeper = putInZone(state, p1, sleeperCard, 'hand');
		p1.manaPool.B = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sleeper.instanceId
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		const liveSleeper = p2.battlefield.find((b) => b.instanceId === sleeper.instanceId)!;
		assert.ok(liveSleeper);
		assert.equal(liveSleeper.tapped, true);
		assert.equal(liveSleeper.controllerId, p2.playerId);
	});

	it('applies Layer 1 clone addSupertypes + addedAbilityTexts and tapForManaMultiplier with auto-tapper', () => {
		const { state, p1 } = setupGame();
		const templateBear = synthCard({
			name: 'Forest Stag',
			power: '2',
			toughness: '2',
			colors: ['G'],
			oracleText: ''
		});
		const cloneCard = synthCard({
			name: 'Mythic Doppelganger',
			manaCost: '{2}{U}',
			cmc: 3,
			power: '0',
			toughness: '0',
			colors: ['U'],
			oracleText:
				'You may have Mythic Doppelganger enter as a copy of any creature on the battlefield, except it\'s legendary and it has "{T}: Add {C}."'
		});
		const triplerCard = synthCard({
			name: 'Triple Leyline',
			typeLine: 'Enchantment',
			oracleText:
				'If you tap a permanent for mana, it produces three times as much of that mana instead.'
		});
		const basicForest = synthCard({
			name: 'Verdant Grove',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: '{T}: Add {G}.'
		});
		const threeDropCard = synthCard({
			name: 'Three-Mana Beast',
			manaCost: '{2}{G}',
			cmc: 3,
			power: '3',
			toughness: '3',
			oracleText: ''
		});

		const stag = putInZone(state, p1, templateBear, 'battlefield');
		const clone = putInZone(state, p1, cloneCard, 'hand');
		p1.manaPool.U = 3;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: clone.instanceId
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		for (let guard = 0; guard < 4 && state.pendingPrompts.length > 0; guard++) {
			const pr = state.pendingPrompts[0];
			if (pr.choice?.kind === 'yesNo') {
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'yesNo', yes: true }
					}).ok,
					true
				);
			} else {
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'chooseObjects', objectIds: [stag.instanceId] }
					}).ok,
					true
				);
			}
		}
		const liveClone = p1.battlefield.find((b) => b.instanceId === clone.instanceId)!;
		assert.ok(liveClone);
		const evClone = evaluatePermanent(state, liveClone);
		assert.equal(evClone.effectiveName, 'Forest Stag');
		assert.equal(evClone.isLegendary, true);
		liveClone.summoningSick = false;
		const cloneAbs = getEffectiveActivatedAbilities(state, p1, liveClone);
		assert.equal(cloneAbs.some((a) => a.isManaAbility), true);

		// Add 3x mana multiplier: tapping clone adds 3 {C}, and single Forest can auto-tap for a {2}{G} spell!
		putInZone(state, p1, triplerCard, 'battlefield');
		const cloneManaAb = getEffectiveActivatedAbilities(state, p1, liveClone).find(
			(a) => a.isManaAbility
		)!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: liveClone.instanceId,
				abilityId: cloneManaAb.id
			}).ok,
			true
		);
		assert.equal(p1.manaPool.C, 3, 'Expected 3x tap-for-mana multiplier on clone mana ability');
		p1.manaPool.C = 0;

		putInZone(state, p1, basicForest, 'battlefield');
		const threeDrop = putInZone(state, p1, threeDropCard, 'hand');
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, threeDrop).ok,
			true,
			'Auto-tapper should recognize 1 Forest produces {G}{G}{G} for a {2}{G} spell'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: threeDrop.instanceId
			}).ok,
			true
		);
	});

	it('replaces opponent-caused discard with battlefield entry (+ counters & CR 701.9c trigger) while self-discard goes to graveyard', () => {
		const { state, p1, p2 } = setupGame();
		const balothCard = synthCard({
			name: 'Defiant Behemoth',
			power: '4',
			toughness: '4',
			oracleText:
				'If a spell or ability an opponent controls causes you to discard Defiant Behemoth, put it onto the battlefield with two +1/+1 counters on it instead of putting it into your graveyard.'
		});
		const discardWatcherCard = synthCard({
			name: 'Discard Chronicler',
			power: '1',
			toughness: '3',
			oracleText: 'Whenever you discard a card, you gain 2 life.'
		});
		const hymnCard = synthCard({
			name: 'Mind Extraction',
			manaCost: '{B}',
			cmc: 1,
			colors: ['B'],
			typeLine: 'Sorcery',
			oracleText: 'Target opponent discards a card.'
		});
		const selfLootCard = synthCard({
			name: 'Self Purge',
			manaCost: '{B}',
			cmc: 1,
			colors: ['B'],
			typeLine: 'Sorcery',
			oracleText: 'Target player discards a card.'
		});

		putInZone(state, p1, discardWatcherCard, 'battlefield');
		const behemoth1 = putInZone(state, p1, balothCard, 'hand');

		// Opponent (p2) casts Mind Extraction on p1
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		const hymn = putInZone(state, p2, hymnCard, 'hand');
		p2.manaPool.B = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: hymn.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		if (state.pendingPrompts.length > 0) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [behemoth1.instanceId] }
				}).ok,
				true
			);
		}
		passAllPriorityOnce(state);

		assert.equal(
			p1.battlefield.some((b) => b.instanceId === behemoth1.instanceId),
			true,
			'Expected opponent-caused discard to put Defiant Behemoth onto the battlefield'
		);
		assert.equal(behemoth1.counters['+1/+1'], 2);
		assert.equal(p1.life, 22, 'CR 701.9c: CardDiscarded trigger must still fire');

		// Self-caused discard (p1 casts Self Purge targeting p1) -> goes to graveyard!
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		const behemoth2 = putInZone(state, p1, balothCard, 'hand');
		const selfPurge = putInZone(state, p1, selfLootCard, 'hand');
		p1.manaPool.B = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: selfPurge.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		if (state.pendingPrompts.length > 0) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [behemoth2.instanceId] }
				}).ok,
				true
			);
		}
		passAllPriorityOnce(state);
		assert.equal(p1.graveyard.some((g) => g.instanceId === behemoth2.instanceId), true);
	});

	it('handles noncombat damage as -1/-1 counters, dealt-damage exile-on-die, static self-regeneration, and extra-turn skip', () => {
		const { state, p1, p2 } = setupGame();
		const scarMageCard = synthCard({
			name: 'Cinder Scar Adept',
			power: '1',
			toughness: '2',
			oracleText:
				'If a source you control would deal noncombat damage to a creature an opponent controls, put that many -1/-1 counters on that creature instead.\nIf a creature dealt damage this turn by a source you controlled would die, exile it instead.'
		});
		const shockCard = synthCard({
			name: 'Arc Ping',
			manaCost: '{R}',
			cmc: 1,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText: 'Arc Ping deals 2 damage to any target.'
		});
		const regenKnightCard = synthCard({
			name: 'Immortal Sentinel',
			power: '2',
			toughness: '2',
			oracleText: 'If Immortal Sentinel would be destroyed, regenerate it.'
		});
		const doomCard = synthCard({
			name: 'Void Terminate',
			manaCost: '{B}',
			cmc: 1,
			colors: ['B'],
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});
		const nexusCard = synthCard({
			name: 'Chronos Idol',
			typeLine: 'Artifact',
			oracleText:
				'If Chronos Idol would be put into a graveyard from the battlefield, instead exile it and take an extra turn after this one.'
		});
		const strangleCard = synthCard({
			name: 'Temporal Anchor',
			typeLine: 'Enchantment',
			oracleText: 'If an opponent would begin an extra turn, that player skips that turn instead.'
		});
		const sacArtifactSpell = synthCard({
			name: 'Shatter Relic',
			manaCost: '{R}',
			cmc: 1,
			colors: ['R'],
			typeLine: 'Instant',
			oracleText: 'Destroy target artifact.'
		});

		const adept = putInZone(state, p1, scarMageCard, 'battlefield');
		const p2Bear = putInZone(
			state,
			p2,
			synthCard({ name: 'Target Bear', power: '3', toughness: '3', oracleText: '' }),
			'battlefield'
		);

		// 1. Noncombat damage places -1/-1 counters instead of marking damage
		const ping = putInZone(state, p1, shockCard, 'hand');
		p1.manaPool.R = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ping.instanceId,
				targets: [{ kind: 'permanent', id: p2Bear.instanceId, label: p2Bear.card.name }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		assert.equal(p2Bear.counters['-1/-1'], 2);
		assert.equal(p2Bear.damageMarked, 0);

		// 2. Combat damage from adept (1/2) to 1/1 p2Bear kills it -> exiled instead of graveyard!
		advancePhaseOrStep(state); // begin_combat
		advancePhaseOrStep(state); // declare_attackers
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: adept.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advancePhaseOrStep(state); // declare_blockers
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: p2Bear.instanceId, attackerInstanceId: adept.instanceId }]
			}).ok,
			true
		);
		advancePhaseOrStep(state); // combat_damage
		assert.equal(p2.exile.some((e) => e.instanceId === p2Bear.instanceId), true);
		assert.equal(p2.graveyard.some((g) => g.instanceId === p2Bear.instanceId), false);

		// 3. Static self-regeneration taps Immortal Sentinel and keeps it on battlefield when destroyed!
		advancePhaseOrStep(state); // end_combat
		advancePhaseOrStep(state); // main2
		const sentinel = putInZone(state, p1, regenKnightCard, 'battlefield');
		const doom = putInZone(state, p1, doomCard, 'hand');
		p1.manaPool.B = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doom.instanceId,
				targets: [{ kind: 'permanent', id: sentinel.instanceId, label: sentinel.card.name }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		assert.equal(p1.battlefield.some((b) => b.instanceId === sentinel.instanceId), true);
		assert.equal(sentinel.tapped, true, 'CR 701.19a: Regenerated creature becomes tapped');

		// 4. Chronos Idol destroyed -> exiled + queues extra turn for p2; p1's Temporal Anchor skips p2's extra turn!
		putInZone(state, p1, strangleCard, 'battlefield');
		const idol = putInZone(state, p2, nexusCard, 'battlefield');
		const shatter = putInZone(state, p1, sacArtifactSpell, 'hand');
		p1.manaPool.R = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: shatter.instanceId,
				targets: [{ kind: 'permanent', id: idol.instanceId, label: idol.card.name }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		assert.equal(p2.exile.some((e) => e.instanceId === idol.instanceId), true);
		assert.deepEqual(state.extraTurnQueue, [p2.playerId]);

		// Advance out of p1's turn -> p2's extra turn is skipped, so normal turn order goes to p2 with empty extraTurnQueue!
		state.phase = 'cleanup';
		advancePhaseOrStep(state);
		assert.deepEqual(state.extraTurnQueue ?? [], []);
	});

	it('enforces cleanup-sacrifice flash, activateAsThoughHaste, graveyardCantBeTargeted, cantBeTargetedBy, dontLoseAtZeroOrLessLife + infect, and selfCastRestriction', () => {
		const { state, p1, p2 } = setupGame();

		// 1. activateAsThoughHaste
		const elixirCard = synthCard({
			name: 'Haste Infuser',
			typeLine: 'Artifact',
			oracleText:
				'You may activate abilities of creatures you control as though those creatures had haste.'
		});
		const dorkCard = synthCard({
			name: 'Sleepy Druid',
			power: '1',
			toughness: '1',
			oracleText: '{T}: Add {G}.'
		});
		const dork = putInZone(state, p1, dorkCard, 'battlefield');
		dork.summoningSick = true;
		const dorkAb = getEffectiveActivatedAbilities(state, p1, dork)[0];
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, dork, dorkAb).ok, false);
		putInZone(state, p1, elixirCard, 'battlefield');
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, dork, dorkAb).ok, true);

		// 2. graveyardCantBeTargeted
		const sealCard = synthCard({
			name: 'Crypt Ward',
			typeLine: 'Enchantment',
			oracleText: "Cards in graveyards can't be the targets of spells or abilities."
		});
		const reanimateCard = synthCard({
			name: 'Raise Bones',
			manaCost: '{B}',
			cmc: 1,
			colors: ['B'],
			typeLine: 'Sorcery',
			oracleText: 'Return target creature card from your graveyard to your hand.'
		});
		const deadBear = putInZone(
			state,
			p1,
			synthCard({ name: 'Fallen Bear', power: '2', toughness: '2', oracleText: '' }),
			'graveyard'
		);
		const raise = putInZone(state, p1, reanimateCard, 'hand');
		p1.manaPool.B = 2;
		assert.equal(checkSpellCastLegality(state, p1.playerId, raise).ok, true);
		putInZone(state, p1, sealCard, 'battlefield');
		assert.equal(checkSpellCastLegality(state, p1.playerId, raise).ok, false);
		void deadBear;

		// 3. cantBeTargetedBy (nongreen opponent spells/abilities)
		const trollCard = synthCard({
			name: 'Mossback Warder',
			power: '5',
			toughness: '5',
			colors: ['G'],
			oracleText:
				"Mossback Warder can't be the target of nongreen spells your opponents control or abilities from nongreen sources your opponents control."
		});
		const blackBolt = synthCard({
			name: 'Dark Bolt',
			manaCost: '{B}',
			cmc: 1,
			colors: ['B'],
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});
		const greenBuff = synthCard({
			name: 'Verdant Touch',
			manaCost: '{G}',
			cmc: 1,
			colors: ['G'],
			typeLine: 'Instant',
			oracleText: 'Target creature gets +1/+1 until end of turn.'
		});
		const troll = putInZone(state, p1, trollCard, 'battlefield');
		const p2Black = putInZone(state, p2, blackBolt, 'hand');
		const p2Green = putInZone(state, p2, greenBuff, 'hand');
		p2.manaPool.B = 1;
		p2.manaPool.G = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: p2Black.instanceId,
				targets: [{ kind: 'permanent', id: troll.instanceId, label: troll.card.name }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: p2Green.instanceId,
				targets: [{ kind: 'permanent', id: troll.instanceId, label: troll.card.name }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);

		// 4. selfCastRestriction ("Cast this spell only if you've cast another spell this turn")
		state.priorityPlayerIndex = 0;
		const secondOnlyCard = synthCard({
			name: 'Phantom Drake',
			manaCost: '{U}',
			cmc: 1,
			power: '4',
			toughness: '4',
			colors: ['U'],
			oracleText: "Cast this spell only if you've cast another spell this turn."
		});
		const drake = putInZone(state, p1, secondOnlyCard, 'hand');
		p1.manaPool.U = 2;
		p1.spellsCastThisTurn = 0;
		assert.equal(checkSpellCastLegality(state, p1.playerId, drake).ok, false);
		p1.spellsCastThisTurn = 1;
		assert.equal(checkSpellCastLegality(state, p1.playerId, drake).ok, true);

		// 5. Cleanup-sacrifice flash (cast during p2's turn -> sacrificed at next cleanup step!)
		const flashAuraCard = synthCard({
			name: 'Instant Web',
			manaCost: '{G}',
			cmc: 1,
			colors: ['G'],
			typeLine: 'Enchantment — Aura',
			oracleText:
				"Enchant creature\nYou may cast Instant Web as though it had flash. If you cast it any time a sorcery couldn't have been cast, the controller of the permanent it becomes sacrifices it at the beginning of the next cleanup step.\nEnchanted creature gets +0/+3 and has reach."
		});
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		state.phase = 'declare_attackers';
		const web = putInZone(state, p1, flashAuraCard, 'hand');
		p1.manaPool.G = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: web.instanceId,
				targets: [{ kind: 'permanent', id: troll.instanceId, label: troll.card.name }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		assert.equal(p1.battlefield.some((b) => b.instanceId === web.instanceId), true);
		assert.equal(
			(state.delayedTriggers ?? []).some(
				(d) =>
					d.triggerPhase === 'cleanup' &&
					d.delayedEffect?.kind === 'sacrifice' &&
					d.delayedEffect.targetInstanceId === web.instanceId
			),
			true
		);
		state.phase = 'end_step';
		advancePhaseOrStep(state); // enters cleanup -> queues/performs cleanup sacrifice!
		passAllPriorityOnce(state);
		assert.equal(p1.graveyard.some((g) => g.instanceId === web.instanceId), true);

		// 6. dontLoseAtZeroOrLessLife + conditional damageToYouAsInfect
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.phase = 'main1';
		const unlifeCard = synthCard({
			name: 'Synthetic Unlife',
			typeLine: 'Enchantment',
			oracleText:
				"You don't lose the game for having 0 or less life.\nAs long as you have 0 or less life, all damage is dealt to you as though its source had infect."
		});
		putInZone(state, p1, unlifeCard, 'battlefield');
		p1.life = 0;
		noteLayerInputsChanged(state);
		checkStateBasedActions(state);
		assert.equal(p1.lost, false, 'Player should not lose at 0 life with dontLoseAtZeroOrLessLife');

		const burnFace = putInZone(
			state,
			p2,
			synthCard({
				name: 'Venom Ray',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: 'Venom Ray deals 4 damage to any target.'
			}),
			'hand'
		);
		p2.manaPool.R = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: burnFace.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		passAllPriorityOnce(state);
		assert.equal(
			p1.life,
			0,
			'Damage at <=0 life should not change life total when converted to infect'
		);
		assert.equal(p1.poison, 4, 'Damage at <=0 life should give 4 poison counters via infect');
	});

	it('upholds Rename-Invariance (ENGINE_INVARIANTS.md §1.3): arbitrary gibberish card names compile and execute identically', () => {
		const buildPair = (cardTitle: string) =>
			synthCard({
				name: cardTitle,
				manaCost: '{1}{U}',
				cmc: 2,
				power: '2',
				toughness: '3',
				colors: ['U'],
				oracleText: `As ${cardTitle} enters, choose odd or even.\n${cardTitle} is also a Cleric, Rogue, Warrior, and Wizard.\nEach creature with mana value of the chosen quality gets +1/+1.\nIf ${cardTitle} would be destroyed, regenerate it.`
			});

		const cardA = buildPair('Normal Exemplar');
		const cardB = buildPair('Zyxwvut99 Qwertymancer');

		const irA = compileCard(cardA);
		const irB = compileCard(cardB);
		// Strip text/name metadata and verify compiled ability IR structures are 100% identical
		const strip = (def: ReturnType<typeof compileCard>) =>
			def.faces[0].abilities.map((ab) => {
				const clone = JSON.parse(JSON.stringify(ab));
				delete clone.text;
				delete clone.span;
				return clone;
			});
		assert.deepEqual(strip(irA), strip(irB));

		const runScenario = (card: ScryfallCard) => {
			const { state, p1 } = setupGame({ p1Bot: true });
			const inst = putInZone(state, p1, card, 'hand');
			p1.manaPool.U = 2;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: inst.instanceId
				}).ok,
				true
			);
			passAllPriorityOnce(state);
			const liveInst = p1.battlefield.find((b) => b.instanceId === inst.instanceId)!;
			const ev = evaluatePermanent(state, liveInst);
			return {
				power: getCreaturePower(liveInst, state),
				toughness: getCreatureToughness(liveInst, state),
				effectiveTypeLine: ev.effectiveTypeLine,
				chosenParity: liveInst.chosenParity
			};
		};

		assert.deepEqual(runScenario(cardA), runScenario(cardB));
	});
});
