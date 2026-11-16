import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard, clearCompileCache } from '../compiler/index.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	checkStateBasedActions,
	computeCombatDamageForecast,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword
} from '../engine.ts';
import { OVERRIDES_BY_ORACLE_ID, validateOverrideEntry } from '../overrides/index.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
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
	const id = overrides.id ?? `syn_p21_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p21_${synthSeq}`,
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
}

function makeDeck(
	cards: ScryfallCard[],
	commanders: ScryfallCard[] = [],
	companion?: ScryfallCard
): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_p21_${++synthSeq}`,
		userId: 'p1',
		name: 'Track P21 Deck',
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
	const state = createInitialGameState('P21', seats, decks, DEFAULT_LOBBY_RULES);
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
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library',
	opts: { isCommander?: boolean; summoningSick?: boolean } = {}
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(
		card,
		player.playerId,
		zone,
		Boolean(opts.isCommander),
		false,
		state.nextTimestamp
	);
	if (zone === 'battlefield') {
		inst.summoningSick = opts.summoningSick ?? false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
		if (card.loyalty && /^\d+$/.test(card.loyalty)) {
			inst.counters.loyalty = parseInt(card.loyalty, 10);
		}
	}
	if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	noteLayerInputsChanged(state);
	return inst;
}

function putInHand(state: GameState, player: PlayerGameState, card: ScryfallCard): CardInstance {
	return putInZone(state, player, card, 'hand');
}

function putOnBattlefield(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	opts: { isCommander?: boolean; summoningSick?: boolean } = {}
): CardInstance {
	return putInZone(state, player, card, 'battlefield', opts);
}

function putInGraveyard(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard
): CardInstance {
	return putInZone(state, player, card, 'graveyard');
}

function giveMana(
	player: PlayerGameState,
	pool: Partial<Record<ManaColor | 'C', number>>
): void {
	for (const [k, v] of Object.entries(pool)) {
		if (typeof v === 'number') {
			player.manaPool[k as ManaColor | 'C'] = (player.manaPool[k as ManaColor | 'C'] ?? 0) + v;
		}
	}
}

function resolveTopOfStack(state: GameState): void {
	for (let guard = 0; guard < 32; guard++) {
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].purpose === 'trigger_order') {
			const prm = state.pendingPrompts[0];
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
			});
			if (!res.ok) break;
			continue;
		}
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const pr = state.players[state.priorityPlayerIndex];
		if (!pr) break;
		const res = applyGameAction(state, pr.playerId, { type: 'pass_priority' });
		if (!res.ok) break;
	}
}

// ============================================================================
// 1. Promoted Keywords & Registry Sync (CR 702.48, 57, 89, 139, 142, 177, 186)
// ============================================================================

describe('Track P21 — Promoted Keywords & Registry Sync', () => {
	it('promotes totem armor (CR 702.89b) as an umbra armor replacement destroying the Aura instead of the enchanted creature', () => {
		const { state, p1 } = setupGame();
		const bear = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Moss Bear',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			})
		);
		const totemAura = putInHand(
			state,
			p1,
			synthCard({
				name: 'Spider Umbra',
				manaCost: '{G}',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +1/+1 and has reach.\nTotem armor',
				colors: ['G']
			})
		);
		assert.equal(compileCard(totemAura.card).fullySupported, true);
		giveMana(p1, { G: 1 });
		const castAura = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: totemAura.instanceId,
			targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
		});
		assert.equal(castAura.ok, true);
		resolveTopOfStack(state);
		const totemPerm = p1.battlefield.find((c) => c.instanceId === totemAura.instanceId)!;
		assert.ok(totemPerm);
		assert.equal(totemPerm.attachedToId, bear.instanceId);
		assert.equal(hasKeyword(totemPerm, 'umbra armor', state), true);

		const doom = putInHand(
			state,
			p1,
			synthCard({
				name: 'Fell Bolt',
				manaCost: '{1}{B}',
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.',
				colors: ['B']
			})
		);
		giveMana(p1, { B: 2 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doom.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);

		// CR 702.89a/b: Bear remains on battlefield undamaged; Totem armor Aura is destroyed instead.
		assert.equal(p1.battlefield.some((c) => c.instanceId === bear.instanceId), true);
		assert.equal(p1.graveyard.some((c) => c.instanceId === totemAura.instanceId), true);
	});

	it('executes boast, exhaust, forecast, waterbend, companion, and offering end-to-end as implemented keywords', () => {
		const { state, p1 } = setupGame();
		// 1) Boast
		const boaster = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Raiding Berserker',
				manaCost: '{1}{R}',
				typeLine: 'Creature — Human Berserker',
				oracleText: 'Boast — {1}{R}: Draw a card.',
				power: '2',
				toughness: '2',
				colors: ['R']
			})
		);
		assert.equal(compileCard(boaster.card).fullySupported, true);
		giveMana(p1, { R: 4 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boaster.instanceId,
				abilityId: 'boast_0'
			}).ok,
			false
		);
		boaster.creatureAttackedThisTurn = true;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boaster.instanceId,
				abilityId: 'boast_0'
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(p1.hand.length, 1);

		// 2) Exhaust: once-per-object activation
		const exhauster = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Boost Buggy',
				manaCost: '{2}{R}',
				typeLine: 'Creature — Goblin Pilot',
				oracleText: 'Exhaust — {1}: Draw a card.',
				power: '2',
				toughness: '2',
				colors: ['R']
			})
		);
		assert.equal(compileCard(exhauster.card).fullySupported, true);
		giveMana(p1, { R: 3 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: exhauster.instanceId,
				abilityId: 'exhaust_0'
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: exhauster.instanceId,
				abilityId: 'exhaust_0'
			}).ok,
			false
		);

		// 3) Waterbend: tap creatures/artifacts to pay {2}
		const monk = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Tidemender Monk',
				manaCost: '{1}{U}',
				typeLine: 'Creature — Human Monk',
				oracleText: 'Waterbend {2}: Draw a card.',
				power: '1',
				toughness: '3',
				colors: ['U']
			})
		);
		const relic = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Bronze Relic',
				manaCost: '{1}',
				typeLine: 'Artifact',
				oracleText: ''
			})
		);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		assert.equal(compileCard(monk.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: monk.instanceId,
				abilityId: 'act_0',
				costPayment: { objects: [[monk.instanceId, relic.instanceId]] }
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(monk.tapped, true);
		assert.equal(relic.tapped, true);

		// 4) Forecast: activate from hand during your upkeep
		const forecaster = putInHand(
			state,
			p1,
			synthCard({
				name: 'Sky Hussar',
				manaCost: '{3}{W}{U}',
				typeLine: 'Creature — Human Knight',
				oracleText: 'Forecast — {W}, Reveal ~ from your hand: You gain 2 life.',
				power: '4',
				toughness: '3',
				colors: ['W', 'U']
			})
		);
		assert.equal(compileCard(forecaster.card).fullySupported, true);
		state.phase = 'upkeep';
		giveMana(p1, { W: 1 });
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: forecaster.instanceId,
				abilityId: 'forecast_0'
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(p1.life, lifeBefore + 2);

		// 5) Companion & Offering
		const compCard = synthCard({
			name: 'Lurking Lurrus',
			manaCost: '{1}{W}{B}',
			cmc: 3,
			typeLine: 'Legendary Creature — Cat Nightmare',
			oracleText: 'Companion — Each permanent card in your starting deck has mana value 2 or less.',
			power: '3',
			toughness: '2',
			colors: ['W', 'B']
		});
		assert.equal(compileCard(compCard).fullySupported, true);
		const compGame = setupGame({ p1Companion: compCard });
		giveMana(compGame.p1, { C: 3 });
		assert.equal(
			applyGameAction(compGame.state, compGame.p1.playerId, {
				type: 'companion_to_hand'
			}).ok,
			true
		);
		assert.equal(compGame.p1.hand.some((c) => c.card.name === 'Lurking Lurrus'), true);

		const offeringCard = synthCard({
			name: 'Patron of the Nezumi',
			manaCost: '{5}{B}{B}',
			cmc: 7,
			typeLine: 'Legendary Creature — Spirit',
			oracleText: 'Rat offering',
			power: '6',
			toughness: '6',
			colors: ['B']
		});
		assert.equal(compileCard(offeringCard).fullySupported, true);
	});
});

// ============================================================================
// 2. Trample over planeswalkers (CR 702.19c–f) & Combat Forecast
// ============================================================================

describe('Track P21 — Trample over planeswalkers (CR 702.19c–f)', () => {
	const thrullCard = () =>
		synthCard({
			name: 'Thrull Crusher',
			manaCost: '{4}{B}{G}',
			typeLine: 'Creature — Phyrexian Thrull',
			oracleText: 'Trample over planeswalkers',
			power: '7',
			toughness: '7',
			colors: ['B', 'G']
		});

	const pwCard = (loyalty = '3') =>
		synthCard({
			name: 'Wandering Sage',
			manaCost: '{2}{U}',
			typeLine: 'Legendary Planeswalker — Jace',
			oracleText: '+1: Draw a card.',
			loyalty,
			colors: ['U']
		});

	it('assigns excess combat damage to the planeswalker controller when unblocked or blocked (CR 702.19c) and forecasts accurately', () => {
		const { state, p1, p2 } = setupGame();
		const attacker = putOnBattlefield(state, p1, thrullCard());
		const pw = putOnBattlefield(state, p2, pwCard('2'));
		const blocker = putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Grizzly Guard',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2',
				colors: ['G']
			})
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: attacker.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: pw.instanceId
					}
				]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });

		assert.equal(state.phase, 'declare_blockers');
		const unblockedForecast = computeCombatDamageForecast(state, {}, {});
		assert.equal(unblockedForecast.playerIncoming[p2.playerId].totalLifeLoss, 5);
		assert.equal(unblockedForecast.playerIncoming[p2.playerId].trampleThroughDamage, 5);

		const blockedForecast = computeCombatDamageForecast(
			state,
			{},
			{ [blocker.instanceId]: attacker.instanceId }
		);
		assert.equal(blockedForecast.playerIncoming[p2.playerId].totalLifeLoss, 3);

		const p2LifeBefore = p2.life;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: blocker.instanceId, attackerInstanceId: attacker.instanceId }
				]
			}).ok,
			true
		);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].kind === 'chooseNumber') {
			const prm = state.pendingPrompts[0];
			applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseNumber', n: 2 }
			});
		}

		assert.equal(p2.graveyard.some((c) => c.instanceId === blocker.instanceId), true);
		assert.equal(p2.graveyard.some((c) => c.instanceId === pw.instanceId), true);
		assert.equal(p2.life, p2LifeBefore - 3);
	});

	it('tramples excess damage over blockers to defending player if attacked planeswalker left combat (CR 702.19e)', () => {
		const { state, p1, p2 } = setupGame();
		const attacker = putOnBattlefield(state, p1, thrullCard());
		const pw = putOnBattlefield(state, p2, pwCard('4'));
		const blocker = putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Timber Wolf',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Wolf',
				power: '2',
				toughness: '2'
			})
		);

		state.phase = 'declare_attackers';
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{
					attackerInstanceId: attacker.instanceId,
					defenderPlayerId: p2.playerId,
					defenderPlaneswalkerId: pw.instanceId
				}
			]
		});
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });

		applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: blocker.instanceId, attackerInstanceId: attacker.instanceId }
			]
		});
		moveObject(state, pw, 'exile', {
			from: { player: p2, zone: 'battlefield' },
			toPlayer: p2,
			bumpVersion: true
		});

		const lifeBefore = p2.life;
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].kind === 'chooseNumber') {
			const prm = state.pendingPrompts[0];
			applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseNumber', n: 2 }
			});
		}

		assert.equal(p2.life, lifeBefore - 5);
	});
});

// ============================================================================
// 3. Complex Auras + Rename Invariance (Daybreak Coronet, Become the Pilot)
// ============================================================================

describe('Track P21 — Complex Enchant Filters & Rename Invariance', () => {
	it('enforces Daybreak Coronet ("Enchant creature with another Aura attached to it") on cast and CR 704.5m SBA fall-off under arbitrary card names', () => {
		const { state, p1 } = setupGame();
		const paladin = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Silver Knight',
				manaCost: '{W}{W}',
				typeLine: 'Creature — Human Knight',
				power: '2',
				toughness: '2',
				colors: ['W']
			})
		);
		const halo = putInHand(
			state,
			p1,
			synthCard({
				name: 'Sunlit Halo',
				manaCost: '{W}{W}',
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature with another Aura attached to it\nEnchanted creature gets +3/+3 and has first strike, vigilance, and lifelink.',
				colors: ['W']
			})
		);
		assert.equal(compileCard(halo.card).fullySupported, true);
		giveMana(p1, { W: 4 });

		// Illegal when paladin has no other Aura attached
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: halo.instanceId,
				targets: [{ kind: 'permanent', id: paladin.instanceId, label: paladin.card.name }]
			}).ok,
			false
		);

		const baseAura = putInHand(
			state,
			p1,
			synthCard({
				name: 'Holy Strength',
				manaCost: '{W}',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +1/+2.',
				colors: ['W']
			})
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: baseAura.instanceId,
				targets: [{ kind: 'permanent', id: paladin.instanceId, label: paladin.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const basePerm = p1.battlefield.find((c) => c.instanceId === baseAura.instanceId)!;
		assert.ok(basePerm);

		// Now Sunlit Halo is legal!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: halo.instanceId,
				targets: [{ kind: 'permanent', id: paladin.instanceId, label: paladin.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const haloPerm = p1.battlefield.find((c) => c.instanceId === halo.instanceId)!;
		assert.equal(haloPerm.attachedToId, paladin.instanceId);
		assert.equal(evaluatePermanent(state, paladin).power, 6);

		// Remove basePerm -> CR 704.5m SBA puts Sunlit Halo into graveyard because no other Aura is attached!
		moveObject(state, basePerm, 'graveyard', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			bumpVersion: true
		});
		checkStateBasedActions(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === halo.instanceId), true);
	});

	it('enforces "Enchant noncommander creature" (Become the Pilot)', () => {
		const cmdCard = synthCard({
			name: 'General Vane',
			manaCost: '{2}{W}',
			typeLine: 'Legendary Creature — Human Soldier',
			power: '3',
			toughness: '3',
			colors: ['W']
		});
		const { state, p1 } = setupGame({ p1Commanders: [cmdCard] });
		const cmdPerm = putOnBattlefield(state, p1, cmdCard, { isCommander: true });
		const recruit = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Deckhand Recruit',
				manaCost: '{1}{U}',
				typeLine: 'Creature — Human Pilot',
				power: '2',
				toughness: '2',
				colors: ['U']
			})
		);
		const aura = putInHand(
			state,
			p1,
			synthCard({
				name: 'Become the Pilot',
				manaCost: '{2}{U}',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant noncommander creature\nEnchanted creature gets +1/+1.',
				colors: ['U']
			})
		);
		assert.equal(compileCard(aura.card).fullySupported, true);
		giveMana(p1, { U: 3 });

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: aura.instanceId,
				targets: [{ kind: 'permanent', id: cmdPerm.instanceId, label: cmdPerm.card.name }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: aura.instanceId,
				targets: [{ kind: 'permanent', id: recruit.instanceId, label: recruit.card.name }]
			}).ok,
			true
		);
	});
});

// ============================================================================
// 4. Equip worthy, Hand of Vecna, Plate Armor, Craft share-type, Suspend X
// ============================================================================

describe('Track P21 — Equip Variants, Craft Share-Type, and Suspend X', () => {
	it('handles Equip worthy (CR 700.16), dynamic life Equip (Hand of Vecna), and inline Equip cost reduction (Plate Armor)', () => {
		const { state, p1 } = setupGame();
		const worthyHero = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Valkyrie Champion',
				manaCost: '{1}{R}{W}',
				typeLine: 'Legendary Creature — Angel Warrior',
				power: '3',
				toughness: '3',
				colors: ['R', 'W']
			})
		);
		const villainBoss = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Crimson Schemer',
				manaCost: '{1}{R}',
				typeLine: 'Legendary Creature — Human Villain',
				power: '2',
				toughness: '2',
				colors: ['R']
			})
		);
		const hammer = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Mjölnir, Hammer of Thor',
				manaCost: '{3}',
				typeLine: 'Legendary Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+2.\nEquip worthy {1}\nEquip {4}'
			})
		);
		assert.equal(compileCard(hammer.card).fullySupported, true);

		giveMana(p1, { C: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: hammer.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: villainBoss.instanceId, label: villainBoss.card.name }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: hammer.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: worthyHero.instanceId, label: worthyHero.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(hammer.attachedToId, worthyHero.instanceId);

		// Hand of Vecna: Equip—Pay 1 life for each card in your hand.
		const vecna = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Hand of Vecna',
				manaCost: '{3}',
				typeLine: 'Legendary Artifact — Equipment',
				oracleText: 'Equip—Pay 1 life for each card in your hand.'
			})
		);
		assert.equal(compileCard(vecna.card).fullySupported, true);
		for (let i = 0; i < 3; i++) {
			putInHand(state, p1, synthCard({ name: `Scroll ${i}` }));
		}
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: vecna.instanceId,
				abilityId: 'equip_0',
				targets: [{ kind: 'permanent', id: villainBoss.instanceId, label: villainBoss.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(p1.life, lifeBefore - 3);
		assert.equal(vecna.attachedToId, villainBoss.instanceId);

		// Plate Armor: Equip {3}. This ability costs {1} less to activate for each other Equipment you control.
		const plate = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Plate Armor',
				manaCost: '{2}{W}',
				typeLine: 'Artifact — Equipment',
				oracleText:
					'Equipped creature gets +3/+3.\nEquip {3}. This ability costs {1} less to activate for each other Equipment you control.',
				colors: ['W']
			})
		);
		assert.equal(compileCard(plate.card).fullySupported, true);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: plate.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: worthyHero.instanceId, label: worthyHero.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(plate.attachedToId, worthyHero.instanceId);
	});

	it('validates Craft with two that share a card type and Suspend X (X != 0)', () => {
		const { state, p1 } = setupGame();
		const eye = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Eye of Ojer Taq',
				manaCost: '{3}',
				typeLine: 'Artifact',
				oracleText: 'Craft with two that share a card type {6}',
				backFace: {
					name: 'Apex Observatory',
					manaCost: '',
					typeLine: 'Artifact',
					oracleText: '{T}: Add {C}{C}.',
					imageUrl: ''
				}
			})
		);
		assert.equal(compileCard(eye.card).fullySupported, true);
		const artPerm = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Copper Cog', typeLine: 'Artifact' })
		);
		const enchCard = putInGraveyard(
			state,
			p1,
			synthCard({ name: 'Faded Seal', typeLine: 'Enchantment' })
		);
		const artGy = putInGraveyard(
			state,
			p1,
			synthCard({ name: 'Broken Gear', typeLine: 'Artifact' })
		);

		giveMana(p1, { C: 6 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: eye.instanceId,
				abilityId: 'craft_0',
				craftMaterialIds: [artPerm.instanceId, enchCard.instanceId]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: eye.instanceId,
				abilityId: 'craft_0',
				craftMaterialIds: [artPerm.instanceId, artGy.instanceId]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const returned = p1.battlefield.find(
			(c) => c.card.name.includes('Eye of Ojer Taq') || c.transformed
		);
		assert.ok(returned);
		assert.equal(returned.transformed, true);

		// Suspend X—{X}{W}{W}. X can't be 0.
		const suspCard = putInHand(
			state,
			p1,
			synthCard({
				name: 'Benalish Commander',
				manaCost: '{3}{W}',
				typeLine: 'Creature — Human Soldier Lord',
				oracleText: "Suspend X—{X}{W}{W}. X can't be 0.",
				power: '2',
				toughness: '2',
				colors: ['W']
			})
		);
		assert.equal(compileCard(suspCard.card).fullySupported, true);
		giveMana(p1, { W: 2, C: 3 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'suspend_card',
				instanceId: suspCard.instanceId,
				xValue: 0
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'suspend_card',
				instanceId: suspCard.instanceId,
				xValue: 3
			}).ok,
			true
		);
		assert.equal(suspCard.zone, 'exile');
		assert.equal(suspCard.isSuspended, true);
		assert.equal(suspCard.counters.time, 3);
	});
});

// ============================================================================
// 5. card.ts & normalize.ts Fixes (Cleave, !, Permanent Quoted Grants, Quotes+Colons)
// ============================================================================

describe('Track P21 — Compiler Cleave, Punctuation, Quoted Grants, and Colon Fixes', () => {
	it('compiles and resolves Lantern Flare (Cleave + trailing X sentence), Blood for the Blood God!, Defiling Tears, Ignis Scientia, Urza Saga, and quoted colons', () => {
		const { state, p1, p2 } = setupGame();

		// 1) Blood for the Blood God! (`!` in card name self-reference)
		const blood = synthCard({
			name: 'Blood for the Blood God!',
			manaCost: '{8}{B}{B}{R}',
			cmc: 11,
			typeLine: 'Instant',
			oracleText:
				'This spell costs {1} less to cast for each creature that died this turn.\nDiscard your hand, then draw eight cards. Blood for the Blood God! deals 8 damage to each opponent. Exile Blood for the Blood God!.',
			colors: ['B', 'R']
		});
		assert.equal(compileCard(blood).fullySupported, true);

		// 2) Lantern Flare: manaCost {1}{W}, Cleave {X}{R}{W}
		const flare = putInHand(
			state,
			p1,
			synthCard({
				oracleId: '06a1c404-d76f-4206-8740-7ad7488fac33',
				layout: 'normal',
				name: 'Lantern Flare',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					'Cleave {X}{R}{W} (You may cast this spell for its cleave cost. If you do, remove the words in square brackets.)\nLantern Flare deals X damage to target creature or planeswalker and you gain X life. [X is the number of creatures you control.]',
				colors: ['W']
			})
		);
		assert.equal(compileCard(flare.card).fullySupported, true);
		const oppBear = putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Target Bear', typeLine: 'Creature — Bear', power: '4', toughness: '4' })
		);
		putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Ally 1', typeLine: 'Creature — Soldier', power: '1', toughness: '1' })
		);
		putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Ally 2', typeLine: 'Creature — Soldier', power: '1', toughness: '1' })
		);

		giveMana(p1, { W: 1, R: 1, C: 1 });
		const opts = getCastOptions(state, p1.playerId, flare, 'hand');
		assert.equal(opts.some((o) => o.id.includes('cleave')), true);
		const lifeStart = p1.life;
		// Cast normally for {1}{W} -> X is the number of creatures p1 controls (2)!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flare.instanceId,
				targets: [{ kind: 'permanent', id: oppBear.instanceId, label: oppBear.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(oppBear.damageMarked, 2);
		assert.equal(p1.life, lifeStart + 2);

		// 3) Defiling Tears
		const tears = putInHand(
			state,
			p1,
			synthCard({
				name: 'Defiling Tears',
				manaCost: '{2}{B}',
				typeLine: 'Instant',
				oracleText:
					'Until end of turn, target creature becomes black, gets +1/-1, and gains "{B}: Regenerate this creature."',
				colors: ['B']
			})
		);
		assert.equal(compileCard(tears.card).fullySupported, true);
		giveMana(p1, { B: 3 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tears.instanceId,
				targets: [{ kind: 'permanent', id: oppBear.instanceId, label: oppBear.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const evBear = evaluatePermanent(state, oppBear);
		assert.deepEqual(evBear.colors, ['B']);
		assert.equal(evBear.power, 5);
		assert.equal(evBear.toughness, 3);
		assert.equal(getEffectiveActivatedAbilities(state, p2, oppBear, []).length, 1);

		// 4) Urza's Saga permanent chapter I ability grant on plain land
		const sagaCard = synthCard({
			name: "Urza's Saga",
			manaCost: '',
			cmc: 0,
			typeLine: 'Enchantment Land — Urza’s Saga',
			oracleText:
				'I — Urza\'s Saga gains "{T}: Add {C}."\nII — Urza\'s Saga gains "{2}, {T}: Create a 0/0 colorless Construct artifact creature token with \'This token gets +1/+1 for each artifact you control.\'"\nIII — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle.'
		});
		assert.equal(compileCard(sagaCard).fullySupported, true);
		const sagaInHand = putInHand(state, p1, sagaCard);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: sagaInHand.instanceId
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const sagaPerm = p1.battlefield.find((c) => c.instanceId === sagaInHand.instanceId)!;
		const sagaActs = getEffectiveActivatedAbilities(state, p1, sagaPerm, []);
		assert.equal(
			sagaActs.some((a) => a.isManaAbility && a.producesMana.includes('C')),
			true,
			"Expected Urza's Saga Chapter I to grant {T}: Add {C}. permanently"
		);

		// 5) Ignis Scientia (`!` flavor word + conditional Food token + synthetic rename)
		const ignis = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Ignis Scientia',
				manaCost: '{1}{G}{U}',
				typeLine: 'Legendary Creature — Human Advisor',
				oracleText:
					"When Ignis Scientia enters, look at the top six cards of your library. You may put a land card from among them onto the battlefield tapped. Put the rest on the bottom of your library in a random order.\nI've Come Up with a New Recipe! — {1}{G}{U}, {T}: Exile target card from a graveyard. If a creature card was exiled this way, create a Food token.",
				power: '2',
				toughness: '2',
				colors: ['G', 'U']
			})
		);
		const ignisSynthetic = synthCard({
			name: 'Zephron Culinary Sage',
			manaCost: '{1}{G}{U}',
			typeLine: 'Legendary Creature — Human Advisor',
			oracleText:
				"When Zephron Culinary Sage enters, look at the top six cards of your library. You may put a land card from among them onto the battlefield tapped. Put the rest on the bottom of your library in a random order.\nEureka Moment! — {1}{G}{U}, {T}: Exile target card from a graveyard. If a creature card was exiled this way, create a Food token.",
			power: '2',
			toughness: '2',
			colors: ['G', 'U']
		});
		assert.equal(compileCard(ignis.card).fullySupported, true);
		assert.equal(compileCard(ignisSynthetic).fullySupported, true);
		const deadCreature = putInGraveyard(
			state,
			p2,
			synthCard({
				name: 'Fallen Beast',
				typeLine: 'Creature — Beast',
				power: '3',
				toughness: '3'
			})
		);
		giveMana(p1, { G: 2, U: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: ignis.instanceId,
				abilityId: 'act_1',
				targets: [
					{ kind: 'graveyard_card', id: deadCreature.instanceId, label: deadCreature.card.name }
				]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(
			p2.exile.some((c) => c.instanceId === deadCreature.instanceId),
			true
		);
		assert.equal(
			p1.battlefield.some((c) => c.isToken && c.card.typeLine.includes('Food')),
			true,
			'Expected Ignis Scientia to create a Food token when a creature card was exiled'
		);
		// Noncreature exiled -> no second Food token
		ignis.tapped = false;
		const deadSpell = putInGraveyard(
			state,
			p2,
			synthCard({ name: 'Spent Bolt', typeLine: 'Instant' })
		);
		giveMana(p1, { G: 2, U: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: ignis.instanceId,
				abilityId: 'act_1',
				targets: [{ kind: 'graveyard_card', id: deadSpell.instanceId, label: deadSpell.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(
			p1.battlefield.filter((c) => c.isToken && c.card.typeLine.includes('Food')).length,
			1,
			'Expected Ignis Scientia NOT to create a second Food token when a noncreature card was exiled'
		);

		// 6) Quote-safe costColon
		const quotedColonCard = synthCard({
			name: 'Voice of the Grove',
			manaCost: '{2}{G}',
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control have "{T}: Add {G}."',
			colors: ['G']
		});
		const qcDef = compileCard(quotedColonCard);
		assert.equal(qcDef.fullySupported, true);
		assert.equal(qcDef.faces[0].abilities[0].kind, 'static');
	});
});

// ============================================================================
// 6. Schema-Validated JSON Overrides & 8 Iconic Cards End-to-End
// ============================================================================

describe('Track P21 — JSON Override Registry, Schema Validation, & 8 Iconic Cards', () => {
	it('validates all 8+ registered overrides, rejects malformed JSON schemas, and falls back cleanly on textHash drift', () => {
		assert.ok(OVERRIDES_BY_ORACLE_ID.size >= 8);

		assert.throws(() =>
			validateOverrideEntry({ oracleId: 'not-a-uuid', expectedTextHash: '12345678', faces: [] })
		);
		assert.throws(() =>
			validateOverrideEntry({
				oracleId: 'c823e687-6311-4c99-974b-fd77d204141a',
				expectedTextHash: 'BADHASH!',
				faces: []
			})
		);
		assert.throws(() =>
			validateOverrideEntry({
				oracleId: 'c823e687-6311-4c99-974b-fd77d204141a',
				expectedTextHash: '3e508aa2',
				faces: [
					{
						name: 'Bad',
						characteristics: {
							manaCost: '{U}',
							types: ['Sorcery'],
							subtypes: [],
							supertypes: [],
							colors: ['U']
						},
						abilities: [
							{
								kind: 'unsupported',
								reason: 'unparsed',
								text: 'Nope',
								span: { start: 0, end: 4 },
								unparsed: [{ start: 0, end: 4 }]
							}
						]
					}
				]
			})
		);

		clearCompileCache();
		const drifted = synthCard({
			oracleId: 'c823e687-6311-4c99-974b-fd77d204141a',
			layout: 'normal',
			name: 'Timetwister',
			manaCost: '{2}{U}',
			typeLine: 'Sorcery',
			oracleText: 'Draw a card.',
			colors: ['U']
		});
		const driftedDef = compileCard(drifted);
		assert.equal(driftedDef.fullySupported, true);
		assert.equal(
			driftedDef.faces[0].abilities[0].kind === 'spell' &&
				driftedDef.faces[0].abilities[0].effect[0].verb,
			'draw'
		);
	});

	it('executes Animate Dead and Dance of the Dead end-to-end (graveyard target, reanimation, P/T & untap statics, and LTB sacrifice)', () => {
		const { state, p1, p2 } = setupGame();
		const titan = putInGraveyard(
			state,
			p2,
			synthCard({
				name: 'Grave Titanoid',
				manaCost: '{4}{B}{B}',
				typeLine: 'Creature — Giant',
				power: '6',
				toughness: '6',
				colors: ['B']
			})
		);
		const animateDead = putInHand(
			state,
			p1,
			synthCard({
				oracleId: 'c0d8fef4-65f4-4769-982d-b397d2b7e977',
				layout: 'normal',
				name: 'Animate Dead',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature card in a graveyard\nWhen this Aura enters, if it\'s on the battlefield, it loses "enchant creature card in a graveyard" and gains "enchant creature put onto the battlefield with this Aura." Return enchanted creature card to the battlefield under your control and attach this Aura to it. When this Aura leaves the battlefield, that creature\'s controller sacrifices it.\nEnchanted creature gets -1/-0.',
				colors: ['B']
			})
		);
		assert.equal(compileCard(animateDead.card).fullySupported, true);
		giveMana(p1, { B: 2 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: animateDead.instanceId,
				targets: [{ kind: 'graveyard_card', id: titan.instanceId, label: titan.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);

		const animPerm = p1.battlefield.find((c) => c.instanceId === animateDead.instanceId)!;
		assert.ok(animPerm);
		const reanimTitan = p1.battlefield.find((c) => c.instanceId === titan.instanceId)!;
		assert.ok(reanimTitan);
		assert.equal(animPerm.attachedToId, reanimTitan.instanceId);
		assert.equal(evaluatePermanent(state, reanimTitan).power, 5);
		assert.equal(evaluatePermanent(state, reanimTitan).toughness, 6);

		// Destroy Animate Dead -> LTB trigger causes p1 to sacrifice titan back to p2's graveyard!
		const disenchant = putInHand(
			state,
			p1,
			synthCard({
				name: 'Shatter Seal',
				manaCost: '{1}{W}',
				typeLine: 'Instant',
				oracleText: 'Destroy target enchantment.',
				colors: ['W']
			})
		);
		giveMana(p1, { W: 2 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: disenchant.instanceId,
				targets: [{ kind: 'permanent', id: animPerm.instanceId, label: animPerm.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === titan.instanceId), false);
		assert.equal(p2.graveyard.some((c) => c.instanceId === titan.instanceId), true);

		// Dance of the Dead: enters tapped with +1/+1 and doesn't untap normally
		const dance = putInHand(
			state,
			p1,
			synthCard({
				oracleId: '15d5b198-edbe-40f3-87e2-d72f7f0c58ab',
				layout: 'normal',
				name: 'Dance of the Dead',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature card in a graveyard\nWhen this Aura enters, if it\'s on the battlefield, it loses "enchant creature card in a graveyard" and gains "enchant creature put onto the battlefield with this Aura." Put enchanted creature card onto the battlefield tapped under your control and attach this Aura to it. When this Aura leaves the battlefield, that creature\'s controller sacrifices it.\nEnchanted creature gets +1/+1 and doesn\'t untap during its controller\'s untap step.\nAt the beginning of the upkeep of enchanted creature\'s controller, that player may pay {1}{B}. If the player does, untap that creature.',
				colors: ['B']
			})
		);
		assert.equal(compileCard(dance.card).fullySupported, true);
		const gyTitan = p2.graveyard.find((c) => c.instanceId === titan.instanceId)!;
		giveMana(p1, { B: 2 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: dance.instanceId,
				targets: [{ kind: 'graveyard_card', id: gyTitan.instanceId, label: gyTitan.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const dancedTitan = p1.battlefield.find((c) => c.instanceId === gyTitan.instanceId)!;
		assert.ok(dancedTitan);
		assert.equal(dancedTitan.tapped, true);
		assert.equal(evaluatePermanent(state, dancedTitan).power, 7);
		assert.equal(evaluatePermanent(state, dancedTitan).toughness, 7);
	});

	it('executes Necromancy flash-cast cleanup sacrifice (CR 514.3a)', () => {
		const { state, p1, p2 } = setupGame({ p1Bot: true, p2Bot: true });
		const wurm = putInGraveyard(
			state,
			p2,
			synthCard({ name: 'Dusk Wurm', typeLine: 'Creature — Wurm', power: '5', toughness: '5' })
		);
		const necromancy = putInHand(
			state,
			p1,
			synthCard({
				oracleId: '699b192c-f3f2-4ac5-9ca9-e35bcf08ad8a',
				layout: 'normal',
				name: 'Necromancy',
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText:
					'You may cast this spell as though it had flash. If you cast it any time a sorcery couldn\'t have been cast, the controller of the permanent it becomes sacrifices it at the beginning of the next cleanup step.\nWhen this enchantment enters, if it\'s on the battlefield, it becomes an Aura with "enchant creature put onto the battlefield with Necromancy." Put target creature card from a graveyard onto the battlefield under your control and attach this enchantment to it. When this enchantment leaves the battlefield, that creature\'s controller sacrifices it.',
				colors: ['B']
			})
		);
		assert.equal(compileCard(necromancy.card).fullySupported, true);

		// Cast on opponent's turn (non-sorcery timing!)
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		state.phase = 'end_step';
		giveMana(p1, { B: 3 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: necromancy.instanceId
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const necroPerm = p1.battlefield.find((c) => c.instanceId === necromancy.instanceId)!;
		assert.ok(necroPerm);
		assert.equal(p1.battlefield.some((c) => c.instanceId === wurm.instanceId), true);
		assert.equal(necroPerm.sacrificeAtNextCleanupStep, true);

		// Advance from end_step into cleanup -> delayed cleanup sacrifice fires, sacrificing Necromancy and then wurm!
		for (let guard = 0; guard < 16; guard++) {
			const pr = state.players[state.priorityPlayerIndex];
			if (!pr) break;
			applyGameAction(state, pr.playerId, { type: 'pass_priority' });
			if (
				p1.graveyard.some((c) => c.instanceId === necromancy.instanceId) &&
				state.stack.length === 0
			) {
				break;
			}
		}
		assert.equal(p1.graveyard.some((c) => c.instanceId === necromancy.instanceId), true);
		assert.equal(p2.graveyard.some((c) => c.instanceId === wurm.instanceId), true);
	});

	it('executes Spellweaver Volute, Space Beleren, Panglacial Wurm, Lion Eye Diamond, and Timetwister end-to-end', () => {
		// 1) Spellweaver Volute
		{
			const { state, p1, p2 } = setupGame({ p1Bot: true });
			const bolt1 = putInGraveyard(
				state,
				p1,
				synthCard({
					name: 'Spark Jolt',
					manaCost: '{R}',
					typeLine: 'Instant',
					oracleText: 'Spark Jolt deals 3 damage to any target.',
					colors: ['R']
				})
			);
			const bolt2 = putInGraveyard(
				state,
				p1,
				synthCard({
					name: 'Arcane Insight',
					manaCost: '{U}',
					typeLine: 'Instant',
					oracleText: 'Draw a card.',
					colors: ['U']
				})
			);
			const volute = putInHand(
				state,
				p1,
				synthCard({
					oracleId: '3d92e5ce-9d30-4203-9f84-6c36117440cf',
					layout: 'normal',
					name: 'Spellweaver Volute',
					manaCost: '{3}{U}{U}',
					cmc: 5,
					typeLine: 'Enchantment — Aura',
					oracleText:
						'Enchant instant card in a graveyard\nWhenever you cast a sorcery spell, copy the enchanted instant card. You may cast the copy without paying its mana cost. If you do, exile the enchanted card and attach this Aura to another instant card in a graveyard.',
					colors: ['U']
				})
			);
			assert.equal(compileCard(volute.card).fullySupported, true);
			giveMana(p1, { U: 5 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: volute.instanceId,
					targets: [{ kind: 'graveyard_card', id: bolt1.instanceId, label: bolt1.card.name }]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			const volutePerm = p1.battlefield.find((c) => c.instanceId === volute.instanceId)!;
			assert.equal(volutePerm.attachedToId, bolt1.instanceId);

			const sorc = putInHand(
				state,
				p1,
				synthCard({
					name: 'Ponderous Tome',
					manaCost: '{U}',
					typeLine: 'Sorcery',
					oracleText: 'Draw a card.',
					colors: ['U']
				})
			);
			const p2LifeBefore = p2.life;
			giveMana(p1, { U: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: sorc.instanceId
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(p2.life, p2LifeBefore - 3);
			assert.equal(p1.exile.some((c) => c.instanceId === bolt1.instanceId), true);
			assert.equal(volutePerm.attachedToId, bolt2.instanceId);
		}

		// 2) Space Beleren: sector assignment + +1 cross-sector block lock
		{
			const { state, p1, p2 } = setupGame({ p1Bot: true, p2Bot: false });
			const c1 = putOnBattlefield(
				state,
				p1,
				synthCard({
					name: 'Alpha Striker',
					typeLine: 'Creature — Pilot',
					power: '2',
					toughness: '2'
				})
			);
			const c2 = putOnBattlefield(
				state,
				p2,
				synthCard({
					name: 'Beta Defender',
					typeLine: 'Creature — Soldier',
					power: '2',
					toughness: '2'
				})
			);
			const beleren = putInHand(
				state,
				p1,
				synthCard({
					oracleId: 'cfca44cb-8ca5-4ebb-bd5c-b621eca41944',
					layout: 'normal',
					name: 'Space Beleren',
					manaCost: '{2}{W}{U}',
					cmc: 4,
					typeLine: 'Legendary Planeswalker — Jace',
					oracleText:
						"Space sculptor (Space Beleren divides the battlefield into alpha, beta, and gamma sectors. If a creature isn't assigned to a sector, its controller assigns it to one. Opponents assign first.)\n+1: Creatures in each sector can be blocked this turn only by creatures in the same sector.\n−1: Put a +1/+1 counter on each creature in the sector of your choice.\n−5: Destroy all creatures in the sector of your choice.",
					loyalty: '3',
					colors: ['U', 'W']
				})
			);
			assert.equal(compileCard(beleren.card).fullySupported, true);
			giveMana(p1, { W: 2, U: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: beleren.instanceId
				}).ok,
				true
			);
			resolveTopOfStack(state);
			// Opponent p2 assigns sector first (index 1 -> 'beta'), then bot p1 auto-assigns 'alpha'!
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, prm.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseMode', indices: [1] }
					}).ok,
					true
				);
			}
			const belerenPerm = p1.battlefield.find((c) => c.instanceId === beleren.instanceId)!;
			assert.ok(belerenPerm);
			assert.equal(c1.spaceSector, 'alpha');
			assert.equal(c2.spaceSector, 'beta');

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: belerenPerm.instanceId,
					abilityId: 'loyalty_1'
				}).ok,
				true
			);
			resolveTopOfStack(state);
			state.phase = 'declare_attackers';
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: c1.instanceId, defenderPlayerId: p2.playerId }]
			});
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });

			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'declare_blockers',
					assignments: [{ blockerInstanceId: c2.instanceId, attackerInstanceId: c1.instanceId }]
				}).ok,
				false
			);
			c2.spaceSector = 'alpha';
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'declare_blockers',
					assignments: [{ blockerInstanceId: c2.instanceId, attackerInstanceId: c1.instanceId }]
				}).ok,
				true
			);
		}

		// 3) Panglacial Wurm: cast from library while searching library!
		{
			const { state, p1 } = setupGame();
			const wurm = putInZone(
				state,
				p1,
				synthCard({
					oracleId: '49d4aef7-d2d1-4f66-bc2a-79ec8cc96565',
					layout: 'normal',
					name: 'Panglacial Wurm',
					manaCost: '{5}{G}{G}',
					cmc: 7,
					typeLine: 'Creature — Wurm',
					oracleText:
						"Trample\nWhile you're searching your library, you may cast this card from your library.",
					power: '9',
					toughness: '5',
					colors: ['G']
				}),
				'library'
			);
			assert.equal(compileCard(wurm.card).fullySupported, true);

			giveMana(p1, { G: 7 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: wurm.instanceId,
					fromZone: 'library'
				}).ok,
				false
			);

			const rampant = putInHand(
				state,
				p1,
				synthCard({
					name: 'Seek the Horizon',
					manaCost: '{1}{G}',
					typeLine: 'Sorcery',
					oracleText:
						'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
					colors: ['G']
				})
			);
			giveMana(p1, { G: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: rampant.instanceId
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(state.pendingPrompts.length > 0, true);

			const libOpts = getCastOptions(state, p1.playerId, wurm, 'library');
			assert.equal(libOpts.some((o) => o.fromZone === 'library'), true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: wurm.instanceId,
					fromZone: 'library'
				}).ok,
				true
			);
			assert.equal(state.stack.some((s) => s.sourceInstanceId === wurm.instanceId), true);
		}

		// 4) Lion's Eye Diamond (CR 605.3c: Activate only as an instant — never auto-tapped mid-cast)
		{
			const { state, p1 } = setupGame();
			const led = putOnBattlefield(
				state,
				p1,
				synthCard({
					oracleId: 'ee6099b0-fb1f-42f1-b862-7708c6e36d05',
					layout: 'normal',
					name: "Lion's Eye Diamond",
					manaCost: '{0}',
					cmc: 0,
					typeLine: 'Artifact',
					oracleText:
						'Discard your hand, Sacrifice this artifact: Add three mana of any one color. Activate only as an instant.',
					colors: []
				})
			);
			assert.equal(compileCard(led.card).fullySupported, true);
			const handSpell = putInHand(
				state,
				p1,
				synthCard({
					name: 'Azure Divination',
					manaCost: '{2}{U}',
					typeLine: 'Sorcery',
					oracleText: 'Draw two cards.',
					colors: ['U']
				})
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: handSpell.instanceId
				}).ok,
				false
			);
			state.priorityPlayerIndex = 1;
			const ledAb = getEffectiveActivatedAbilities(state, p1, led, [])[0]!;
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, led, ledAb).ok,
				false
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'tap_mana',
					instanceId: led.instanceId,
					abilityId: 'act_0',
					preferredColor: 'U'
				}).ok,
				false
			);
			state.priorityPlayerIndex = 0;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: led.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			if (state.pendingPrompts.length > 0) {
				const colorPrm = state.pendingPrompts[0];
				assert.equal(colorPrm.kind, 'chooseMode');
				assert.equal(
					applyGameAction(state, colorPrm.playerId, {
						type: 'choice',
						promptId: colorPrm.id,
						answer: { kind: 'chooseMode', indices: [1] }
					}).ok,
					true
				);
			}
			assert.equal(p1.hand.length, 0);
			assert.equal(p1.graveyard.some((c) => c.instanceId === led.instanceId), true);
			assert.equal(p1.manaPool.U, 3);
		}

		// 5) Timetwister: shuffle hand + graveyard into library, draw 7, Timetwister goes to graveyard
		{
			const { state, p1, p2 } = setupGame();
			putInHand(state, p1, synthCard({ name: 'Old Hand 1' }));
			putInGraveyard(state, p1, synthCard({ name: 'Old Grave 1' }));
			putInGraveyard(state, p2, synthCard({ name: 'Opp Grave 1' }));
			const twister = putInHand(
				state,
				p1,
				synthCard({
					oracleId: 'c823e687-6311-4c99-974b-fd77d204141a',
					layout: 'normal',
					name: 'Timetwister',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Sorcery',
					oracleText:
						"Each player shuffles their hand and graveyard into their library, then draws seven cards. (Then put Timetwister into its owner's graveyard.)",
					colors: ['U']
				})
			);
			assert.equal(compileCard(twister.card).fullySupported, true);
			giveMana(p1, { U: 3 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: twister.instanceId
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(p1.hand.length, 7);
			assert.equal(p2.hand.length, 7);
			assert.equal(p2.graveyard.length, 0);
			assert.equal(p1.graveyard.length, 1);
			assert.equal(p1.graveyard[0].instanceId, twister.instanceId);
		}
	});
});
