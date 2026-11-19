import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { compileQuotedAbilityString } from '../compiler/effects.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	drawCards,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { opponentLandColors } from './effects.ts';
import { permanentCouldProduceManaTypes } from './effectsWave7.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type DeckCardEntry,
	type EffectiveActivatedAbility,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

let synthSeq = 0;
let nextTestTs = 100;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p12_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p12_${synthSeq}`,
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
		id: 'deck_p12',
		userId: 'p1',
		name: 'Track P12 Deck',
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
		threePlayer?: boolean;
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P12 Filler Plains',
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
	const state = createInitialGameState('P12_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: 20
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
		p.life = 20;
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	return {
		state,
		p1: state.players[0],
		p2: state.players[1],
		p3: state.players[2]
	};
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor, number>>): void {
	for (const [k, v] of Object.entries(pool) as Array<[ManaColor, number]>) {
		player.manaPool[k] += v;
	}
}

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function playerTarget(player: PlayerGameState): TargetRef {
	return { kind: 'player', id: player.playerId, label: player.username };
}

function findAbility(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	abilityId?: string
): EffectiveActivatedAbility {
	const list = getEffectiveActivatedAbilities(state, actor, inst);
	const found = abilityId ? list.find((a) => a.id === abilityId) : list[0];
	assert.ok(found, `Expected activated ability ${abilityId ?? '[0]'} on ${inst.card.name}`);
	return found;
}

function passAllOnce(state: GameState): void {
	const count = state.players.filter((p) => !p.lost).length;
	for (let i = 0; i < count; i++) {
		if (state.pendingPrompts.length > 0) break;
		const pr = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, pr.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 50; guard++) {
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const pr = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, pr.playerId, { type: 'pass_priority' });
		if (!res.ok) break;
	}
}

function putPerm(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	opts: { summoningSick?: boolean; tapped?: boolean } = {}
): CardInstance {
	const inst = createCardInstance(
		card,
		player.playerId,
		'battlefield',
		false,
		false,
		nextTestTs++
	);
	inst.summoningSick = opts.summoningSick ?? false;
	inst.tapped = opts.tapped ?? false;
	if (card.typeLine.includes('Class')) {
		inst.classLevel = 1;
	}
	player.battlefield.push(inst);
	return inst;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	zone: 'hand' | 'graveyard' | 'library' | 'exile',
	card: ScryfallCard
): CardInstance {
	const inst = createCardInstance(
		card,
		player.playerId,
		zone,
		false,
		false,
		nextTestTs++
	);
	player[zone].push(inst);
	return inst;
}

describe('Track P12 — Striated Frames, Modal Cost Generalizations, & 35 Wave 4 CR 702 Keywords', () => {
	describe('P12.1 — Class (CR 717) & Case (CR 720)', () => {
		it('compiles and resolves Class levels sequentially at sorcery speed and gates level abilities (CR 717)', () => {
			const { state, p1 } = setupGame();
			const paladinClass = synthCard({
				name: 'Valor Class',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment — Class',
				oracleText:
					'Creatures you control get +1/+0.\n{1}{W}: Level 2\nWhen ~ becomes level 2, draw a card.\nCreatures you control have vigilance.\n{2}{W}: Level 3\nCreatures you control have double strike.'
			});
			assert.equal(definitionSupportReport(compileCard(paladinClass)).fullySupported, true);

			const cls = putPerm(state, p1, paladinClass);
			const bear = putPerm(
				state,
				p1,
				synthCard({
					name: 'Squire',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human',
					power: '2',
					toughness: '2'
				})
			);
			putInZone(state, p1, 'library', synthCard({ name: 'Draw 1', typeLine: 'Basic Land — Plains' }));

			assert.equal(cls.classLevel, 1);
			assert.equal(evaluatePermanent(state, bear).power, 3);
			assert.equal(hasKeyword(bear, 'vigilance', state), false);

			// Level 3 cannot be activated before Level 2 (CR 717.2a)
			giveMana(p1, { W: 6, C: 6 });
			const lv2Ab = findAbility(state, p1, cls, 'class_level_2');
			const lv3Ab = findAbility(state, p1, cls, 'class_level_3');
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, cls, lv3Ab).ok, false);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, cls, lv2Ab).ok, true);

			const handBefore = p1.hand.length;
			const act2 = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: cls.instanceId,
				abilityId: 'class_level_2'
			});
			assert.equal(act2.ok, true, act2.error ?? '');
			resolveAllStack(state);

			assert.equal(cls.classLevel, 2);
			assert.equal(p1.hand.length, handBefore + 1);
			assert.equal(hasKeyword(bear, 'vigilance', state), true);
			assert.equal(hasKeyword(bear, 'double strike', state), false);

			const act3 = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: cls.instanceId,
				abilityId: 'class_level_3'
			});
			assert.equal(act3.ok, true, act3.error ?? '');
			resolveAllStack(state);
			assert.equal(cls.classLevel, 3);
			assert.equal(hasKeyword(bear, 'double strike', state), true);
		});

		it('compiles and resolves Case To solve end-step triggers and Solved gated abilities (CR 720)', () => {
			const { state, p1 } = setupGame();
			const feastCase = synthCard({
				name: 'Case of the Uneaten Banquet',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment — Case',
				oracleText:
					"Whenever a creature you control enters, you gain 1 life.\nTo solve — You've gained 5 or more life this turn.\nSolved — Creatures you control get +2/+2."
			});
			assert.equal(definitionSupportReport(compileCard(feastCase)).fullySupported, true);

			const casePerm = putPerm(state, p1, feastCase);
			const bear = putPerm(
				state,
				p1,
				synthCard({
					name: 'Investigator',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human Detective',
					power: '2',
					toughness: '2'
				})
			);
			assert.equal(Boolean(casePerm.isSolved), false);
			assert.equal(evaluatePermanent(state, bear).power, 2);

			// Gain 5 life this turn, then advance main2 -> end_step to trigger To solve
			p1.lifeGainedThisTurn = 5;
			state.phase = 'main2';
			state.priorityPlayerIndex = 0;
			state.passedPriorityPlayerIds = [];
			passAllOnce(state);
			assert.equal(state.phase, 'end_step');
			resolveAllStack(state);

			assert.equal(casePerm.isSolved, true);
			assert.equal(evaluatePermanent(state, bear).power, 4);
		});
	});

	describe('P12.1 — Spree (CR 702.172), Tiered (CR 702.183), & Escalate (CR 702.120)', () => {
		it('compiles Spree, Tiered, and Escalate spells and charges chosen mode costs on cast', () => {
			const { state, p1, p2 } = setupGame();
			for (let i = 0; i < 5; i++) {
				putInZone(
					state,
					p1,
					'library',
					synthCard({ name: `Card ${i}`, typeLine: 'Basic Land — Plains' })
				);
			}
			const spreeSpell = synthCard({
				name: 'Raid Plan',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Spree\n+ {1} — Draw a card.\n+ {2} — You gain 4 life.'
			});
			const tieredSpell = synthCard({
				name: 'Spark Magic',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					'Tiered\n• Spark — {0} — ~ deals 2 damage to any target.\n• Sparkra — {2} — ~ deals 4 damage to any target.'
			});
			const escalateSpell = synthCard({
				name: 'Collective Pact',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Escalate {2}\nChoose one or more —\n• Draw a card.\n• You gain 3 life.'
			});
			assert.equal(definitionSupportReport(compileCard(spreeSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(tieredSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(escalateSpell)).fullySupported, true);

			// Cast Spree choosing both modes ({W} + {1} + {2} = 4 mana)
			const spInst = putInZone(state, p1, 'hand', spreeSpell);
			giveMana(p1, { W: 1, C: 3 });
			const spCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spInst.instanceId,
				modes: [0, 1]
			});
			assert.equal(spCast.ok, true, spCast.error ?? '');
			assert.equal(p1.manaPool.C, 0);
			resolveAllStack(state);
			assert.equal(p1.life, 24);
			assert.equal(p1.hand.length, 1);

			// Cast Tiered choosing mode 1 ({1}{R} + {2} = 4 mana)
			const trInst = putInZone(state, p1, 'hand', tieredSpell);
			giveMana(p1, { R: 1, C: 3 });
			const trCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: trInst.instanceId,
				modes: [1],
				targets: [playerTarget(p2)]
			});
			assert.equal(trCast.ok, true, trCast.error ?? '');
			resolveAllStack(state);
			assert.equal(p2.life, 16);

			// Cast Escalate choosing 2 modes ({1}{W} + {2} = 4 mana)
			const escInst = putInZone(state, p1, 'hand', escalateSpell);
			giveMana(p1, { W: 1, C: 3 });
			const escCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: escInst.instanceId,
				modes: [0, 1]
			});
			assert.equal(escCast.ok, true, escCast.error ?? '');
			resolveAllStack(state);
			assert.equal(p1.life, 27);
		});
	});

	describe('P12.1 — Exhaust, Boast, Forecast, & Ward/Enchant/Equip/AdditionalCost Generalizations', () => {
		it('enforces Exhaust once per permanent lifetime, Boast only after attacking, and Forecast from hand during upkeep', () => {
			const { state, p1 } = setupGame();
			putInZone(state, p1, 'library', synthCard({ name: 'Draw Boast', typeLine: 'Basic Land — Plains' }));

			const exhaustCard = synthCard({
				name: 'Nitro Racer',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Human Pilot',
				power: '2',
				toughness: '2',
				oracleText: 'Exhaust — {1}{G}: Put two +1/+1 counters on ~.'
			});
			const boastCard = synthCard({
				name: 'Raider Berserker',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Human Berserker',
				power: '2',
				toughness: '2',
				oracleText: 'Boast — {1}: Draw a card.'
			});
			const forecastCard = synthCard({
				name: 'Sky Herald',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Creature — Bird',
				power: '2',
				toughness: '2',
				oracleText: 'Forecast — {W}, Reveal ~ from your hand: You gain 2 life.'
			});
			assert.equal(definitionSupportReport(compileCard(exhaustCard)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(boastCard)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(forecastCard)).fullySupported, true);

			const exPerm = putPerm(state, p1, exhaustCard);
			const boPerm = putPerm(state, p1, boastCard);
			const fcHand = putInZone(state, p1, 'hand', forecastCard);

			giveMana(p1, { G: 4, R: 4, W: 4, C: 4 });
			const exAb = findAbility(state, p1, exPerm);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: exPerm.instanceId,
					abilityId: exAb.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(exPerm.counters['+1/+1'], 2);
			// Cannot activate Exhaust a second time even on later turns
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, exPerm, findAbility(state, p1, exPerm)).ok,
				false
			);

			// Boast blocked before attacking, allowed after creatureAttackedThisTurn
			const boAb = findAbility(state, p1, boPerm);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, boPerm, boAb).ok, false);
			boPerm.creatureAttackedThisTurn = true;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: boPerm.instanceId,
					abilityId: boAb.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, boPerm, findAbility(state, p1, boPerm)).ok,
				false
			);

			// Forecast blocked outside upkeep, allowed during controller's upkeep once per turn
			const fcAb = findAbility(state, p1, fcHand);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, fcHand, fcAb).ok, false);
			state.phase = 'upkeep';
			giveMana(p1, { W: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: fcHand.instanceId,
					abilityId: fcAb.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.life, 22);
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, fcHand, findAbility(state, p1, fcHand)).ok,
				false
			);
		});

		it('supports permanent additionalCastCost, non-mana Ward, generalized Enchant, and non-mana/PW Equip', () => {
			const { state, p1, p2 } = setupGame({ p1Bot: true });
			const sacPermCard = synthCard({
				name: 'Bone Demon',
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Creature — Demon',
				power: '5',
				toughness: '5',
				oracleText: 'As an additional cost to cast ~, sacrifice a creature.'
			});
			const wardDiscardCard = synthCard({
				name: 'Graveyard Sentinel',
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Creature — Zombie',
				power: '3',
				toughness: '3',
				oracleText: 'Ward—Discard a card.'
			});
			const auraYouControl = synthCard({
				name: 'Loyal Blessing',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature you control\nEnchanted creature gets +2/+2.'
			});
			const equipLifeCard = synthCard({
				name: 'Bloodforged Blade',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+0.\nEquip—Pay 3 life.'
			});
			assert.equal(definitionSupportReport(compileCard(sacPermCard)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(wardDiscardCard)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(auraYouControl)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(equipLifeCard)).fullySupported, true);

			// Cast permanent with additional sacrifice cost
			const fodder = putPerm(
				state,
				p1,
				synthCard({
					name: 'Fodder',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Creature — Thrull',
					power: '1',
					toughness: '1'
				})
			);
			const demonHand = putInZone(state, p1, 'hand', sacPermCard);
			giveMana(p1, { B: 1, C: 2 });
			const sacCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: demonHand.instanceId
			});
			assert.equal(sacCast.ok, true, sacCast.error ?? '');
			assert.equal(fodder.zone, 'graveyard');
			resolveAllStack(state);

			// Equip—Pay 3 life
			const demonBf = p1.battlefield.find((c) => c.instanceId === demonHand.instanceId)!;
			const blade = putPerm(state, p1, equipLifeCard);
			const equipAb = findAbility(state, p1, blade);
			const eqRes = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: blade.instanceId,
				abilityId: equipAb.id,
				targets: [permTarget(demonBf)]
			});
			assert.equal(eqRes.ok, true, eqRes.error ?? '');
			assert.equal(p1.life, 17);
			resolveAllStack(state);
			assert.equal(blade.attachedToId, demonBf.instanceId);

			// Ward—Discard a card counters targeting spell when caster has empty hand
			const wardPerm = putPerm(state, p2, wardDiscardCard);
			const bolt = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'Zap',
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: '~ deals 4 damage to target creature.'
				})
			);
			giveMana(p1, { R: 1 });
			const boltRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [permTarget(wardPerm)]
			});
			assert.equal(boltRes.ok, true, boltRes.error ?? '');
			resolveAllStack(state);
			assert.equal(wardPerm.zone, 'battlefield');
			assert.equal(wardPerm.damageMarked, 0);
		});
	});

	describe('P12.2 — Casting, Alternative-Cost, & Graveyard Keywords', () => {
		it('handles Aftermath (CR 702.127), Bargain (CR 702.166), Emerge (CR 702.119), Awaken (CR 702.113), Spectacle (CR 702.137), Surge (CR 702.117), and Harmonize (CR 702.180)', () => {
			const { state, p1, p2 } = setupGame({ p1Bot: true });
			for (let i = 0; i < 8; i++) {
				putInZone(
					state,
					p1,
					'library',
					synthCard({ name: `LibDraw ${i}`, typeLine: 'Basic Land — Island' })
				);
			}

			// Aftermath: face 1 castable only from graveyard and exiled on resolution
			const aftermathSplit = synthCard({
				name: 'Cut // Ribbons',
				manaCost: '{1}{R}',
				cmc: 2,
				layout: 'split',
				typeLine: 'Sorcery // Sorcery',
				oracleText: '~ deals 4 damage to target creature.\n//\nAftermath\nDraw a card.',
				faces: [
					{
						name: 'Cut',
						manaCost: '{1}{R}',
						typeLine: 'Sorcery',
						oracleText: 'Cut deals 4 damage to target creature.',
						colors: ['R'],
						imageUrl: '',
						artCropUrl: ''
					},
					{
						name: 'Ribbons',
						manaCost: '{2}{B}',
						typeLine: 'Sorcery',
						oracleText: 'Aftermath\nDraw a card.',
						colors: ['B'],
						imageUrl: '',
						artCropUrl: ''
					}
				]
			});
			const amHand = putInZone(state, p1, 'hand', aftermathSplit);
			assert.equal(
				getCastOptions(state, p1.playerId, amHand, 'hand').some((o) => o.faceIndex === 1),
				false
			);
			p1.hand = [];
			const amGy = putInZone(state, p1, 'graveyard', aftermathSplit);
			giveMana(p1, { B: 1, C: 2 });
			const amOpts = getCastOptions(state, p1.playerId, amGy, 'graveyard');
			const amOpt = amOpts.find((o) => o.id === 'graveyard:aftermath');
			assert.ok(amOpt);
			const amCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: amGy.instanceId,
				fromZone: 'graveyard',
				optionId: amOpt!.id,
				faceIndex: 1
			});
			assert.equal(amCast.ok, true, amCast.error ?? '');
			resolveAllStack(state);
			assert.ok(p1.exile.some((c) => c.instanceId === amGy.instanceId));

			// Bargain: sacrifice artifact/enchantment/token for "if ~ was bargained" bonus
			const bargainSpell = synthCard({
				name: 'Candy Grapple',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Bargain\nDraw a card. If ~ was bargained, draw a card.'
			});
			assert.equal(definitionSupportReport(compileCard(bargainSpell)).fullySupported, true);
			const clue = putPerm(
				state,
				p1,
				synthCard({
					name: 'Clue',
					manaCost: '',
					cmc: 0,
					typeLine: 'Artifact — Clue',
					oracleText: ''
				})
			);
			clue.isToken = true;
			p1.hand = [];
			const bgHand = putInZone(state, p1, 'hand', bargainSpell);
			giveMana(p1, { U: 1, C: 1 });
			const bgCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bgHand.instanceId,
				optionalCostCounts: { 'bargain:0': 1 }
			});
			assert.equal(bgCast.ok, true, bgCast.error ?? '');
			resolveAllStack(state);
			assert.equal(p1.hand.length, 2);

			// Emerge: sacrifice creature to reduce emerge cost by mana value
			const emergeCard = synthCard({
				name: 'Wretched Gryff',
				manaCost: '{7}',
				cmc: 7,
				typeLine: 'Creature — Eldrazi Hippogriff',
				power: '3',
				toughness: '4',
				oracleText: 'Emerge {5}{U}'
			});
			const mv4Helper = putPerm(
				state,
				p1,
				synthCard({
					name: 'Scholar',
					manaCost: '{3}{U}',
					cmc: 4,
					typeLine: 'Creature — Human Wizard',
					power: '2',
					toughness: '2'
				})
			);
			const emHand = putInZone(state, p1, 'hand', emergeCard);
			giveMana(p1, { U: 1, C: 1 }); // {5}{U} reduced by 4 = {1}{U}
			const emOpt = getCastOptions(state, p1.playerId, emHand, 'hand').find(
				(o) => o.id === 'alt:emerge'
			);
			assert.ok(emOpt);
			const emCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: emHand.instanceId,
				optionId: emOpt!.id
			});
			assert.equal(emCast.ok, true, emCast.error ?? '');
			assert.equal(mv4Helper.zone, 'graveyard');
			resolveAllStack(state);

			// Awaken: animate target land you control with +1/+1 counters
			const land = putPerm(
				state,
				p1,
				synthCard({
					name: 'Island',
					manaCost: '',
					cmc: 0,
					typeLine: 'Basic Land — Island',
					oracleText: ''
				})
			);
			const awakenSpell = synthCard({
				name: 'Clutch of Waves',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.\nAwaken 3—{3}{U}'
			});
			const awHand = putInZone(state, p1, 'hand', awakenSpell);
			giveMana(p1, { U: 1, C: 3 });
			const awOpt = getCastOptions(state, p1.playerId, awHand, 'hand').find(
				(o) => o.id === 'alt:awaken'
			);
			assert.ok(awOpt);
			const awCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: awHand.instanceId,
				optionId: awOpt!.id,
				targets: [permTarget(land)]
			});
			assert.equal(awCast.ok, true, awCast.error ?? '');
			resolveAllStack(state);
			assert.equal(land.counters['+1/+1'], 3);
			assert.equal(evaluatePermanent(state, land).isCreature, true);
			assert.equal(evaluatePermanent(state, land).power, 3);

			// Spectacle (opponent lost life) & Surge (cast another spell this turn)
			const spectacleCard = synthCard({
				name: 'Light Up',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.\nSpectacle {R}'
			});
			const surgeCard = synthCard({
				name: 'Jwar Isle Avenger',
				manaCost: '{4}{U}',
				cmc: 5,
				typeLine: 'Instant',
				oracleText: 'Draw a card.\nSurge {1}{U}'
			});
			const spcHand = putInZone(state, p1, 'hand', spectacleCard);
			const srgHand = putInZone(state, p1, 'hand', surgeCard);
			giveMana(p1, { R: 1, U: 1, C: 1 });
			assert.equal(
				getCastOptions(state, p1.playerId, spcHand, 'hand').some((o) => o.id === 'alt:spectacle'),
				false
			);
			p2.lifeLostThisTurn = 2;
			assert.equal(
				getCastOptions(state, p1.playerId, spcHand, 'hand').some((o) => o.id === 'alt:spectacle'),
				true
			);
			assert.equal(
				getCastOptions(state, p1.playerId, srgHand, 'hand').some((o) => o.id === 'alt:surge'),
				true
			);

			// Harmonize from graveyard tapping creature to reduce generic mana and exiling on resolution
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			const harmonizeCard = synthCard({
				name: 'Chorus of Harmony',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'You gain 3 life.\nHarmonize {3}{G}'
			});
			const hmGy = putInZone(state, p1, 'graveyard', harmonizeCard);
			// Animated Island has power 3 (and Gryff has power 3), reducing {3}{G} -> {G}!
			giveMana(p1, { G: 1 });
			const hmOpt = getCastOptions(state, p1.playerId, hmGy, 'graveyard').find(
				(o) => o.id === 'graveyard:harmonize'
			);
			assert.ok(hmOpt);
			const hmCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: hmGy.instanceId,
				fromZone: 'graveyard',
				optionId: hmOpt!.id
			});
			assert.equal(hmCast.ok, true, hmCast.error ?? '');
			resolveAllStack(state);
			assert.ok(p1.exile.some((c) => c.instanceId === hmGy.instanceId));
		});

		it('handles Bestow Aura casting, non-fizzle revert (CR 702.103e), and SBA unattach revert (CR 702.103f)', () => {
			const { state, p1 } = setupGame();
			const eidolon = synthCard({
				name: 'Hopeful Eidolon',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment Creature — Spirit',
				power: '1',
				toughness: '1',
				oracleText: 'Bestow {3}{W}\nLifelink\nEnchanted creature gets +1/+1 and has lifelink.'
			});
			assert.equal(definitionSupportReport(compileCard(eidolon)).fullySupported, true);

			// Case 1: Target leaves battlefield before resolution -> resolves as Creature instead of fizzling (CR 702.103e)
			const host1 = putPerm(
				state,
				p1,
				synthCard({
					name: 'Host One',
					manaCost: '{W}',
					cmc: 1,
					typeLine: 'Creature — Human',
					power: '2',
					toughness: '2'
				})
			);
			const b1 = putInZone(state, p1, 'hand', eidolon);
			giveMana(p1, { W: 1, C: 3 });
			const bOpt1 = getCastOptions(state, p1.playerId, b1, 'hand').find(
				(o) => o.id === 'alt:bestow'
			)!;
			assert.ok(bOpt1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: b1.instanceId,
					optionId: bOpt1.id,
					targets: [permTarget(host1)]
				}).ok,
				true
			);
			p1.battlefield = p1.battlefield.filter((x) => x.instanceId !== host1.instanceId);
			resolveAllStack(state);
			const b1Bf = p1.battlefield.find((c) => c.instanceId === b1.instanceId)!;
			assert.ok(b1Bf);
			assert.equal(Boolean(b1Bf.isBestowed), false);
			assert.equal(evaluatePermanent(state, b1Bf).isCreature, true);

			// Case 2: Bestowed onto host2, then host2 dies -> unattaches and reverts to Creature (CR 702.103f)
			const host2 = putPerm(
				state,
				p1,
				synthCard({
					name: 'Host Two',
					manaCost: '{W}',
					cmc: 1,
					typeLine: 'Creature — Human',
					power: '2',
					toughness: '2'
				})
			);
			const b2 = putInZone(state, p1, 'hand', eidolon);
			giveMana(p1, { W: 1, C: 3 });
			const bOpt2 = getCastOptions(state, p1.playerId, b2, 'hand').find(
				(o) => o.id === 'alt:bestow'
			)!;
			assert.ok(bOpt2);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: b2.instanceId,
					optionId: bOpt2.id,
					targets: [permTarget(host2)]
				}).ok,
				true
			);
			resolveAllStack(state);
			const b2Bf = p1.battlefield.find((c) => c.instanceId === b2.instanceId)!;
			assert.ok(b2Bf);
			assert.equal(b2Bf.isBestowed, true);
			assert.equal(evaluatePermanent(state, b2Bf).isCreature, false);
			assert.equal(evaluatePermanent(state, host2).power, 3);

			host2.damageMarked = 10;
			checkStateBasedActions(state);
			assert.equal(host2.zone, 'graveyard');
			assert.equal(b2Bf.zone, 'battlefield');
			assert.equal(Boolean(b2Bf.isBestowed), false);
			assert.equal(evaluatePermanent(state, b2Bf).isCreature, true);
		});

		it('handles Embalm (CR 702.128), Eternalize (CR 702.129), Encore (CR 702.141), Outlast (CR 702.107), Dredge (CR 702.52), Miracle (CR 702.94), and Recover (CR 702.59)', () => {
			const { state, p1 } = setupGame({ p1Bot: true });

			const embalmCard = synthCard({
				name: 'Sacred Cat',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Creature — Cat',
				power: '1',
				toughness: '1',
				oracleText: 'Lifelink\nEmbalm {W}'
			});
			const eternalizeCard = synthCard({
				name: 'Proven Combatant',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Creature — Human Warrior',
				power: '1',
				toughness: '1',
				oracleText: 'Eternalize {3}{U}'
			});
			const encoreCard = synthCard({
				name: 'Impulsive Pilferer',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Creature — Goblin Pirate',
				power: '1',
				toughness: '1',
				oracleText: 'Encore {3}{R}'
			});
			const outlastCard = synthCard({
				name: 'Ainok Bond-Kin',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Hound Soldier',
				power: '2',
				toughness: '1',
				oracleText: 'Outlast {1}{W}'
			});
			const recoverCard = synthCard({
				name: 'Grim Haruspex',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Zombie',
				power: '2',
				toughness: '2',
				oracleText: 'Recover {1}{B}'
			});

			const emGy = putInZone(state, p1, 'graveyard', embalmCard);
			giveMana(p1, { W: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: emGy.instanceId,
					abilityId: findAbility(state, p1, emGy).id
				}).ok,
				true
			);
			resolveAllStack(state);
			const embalmTok = p1.battlefield.find((x) => x.isToken)!;
			assert.ok(embalmTok);
			assert.deepEqual(evaluatePermanent(state, embalmTok).colors, ['W']);
			assert.ok(evaluatePermanent(state, embalmTok).typeLine.includes('Zombie'));

			const etGy = putInZone(state, p1, 'graveyard', eternalizeCard);
			giveMana(p1, { U: 1, C: 3 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: etGy.instanceId,
					abilityId: findAbility(state, p1, etGy).id
				}).ok,
				true
			);
			resolveAllStack(state);
			const etTok = p1.battlefield.find(
				(x) => x.isToken && x.instanceId !== embalmTok.instanceId
			)!;
			assert.equal(evaluatePermanent(state, etTok).power, 4);
			assert.equal(evaluatePermanent(state, etTok).toughness, 4);
			assert.deepEqual(evaluatePermanent(state, etTok).colors, ['B']);

			const enGy = putInZone(state, p1, 'graveyard', encoreCard);
			giveMana(p1, { R: 1, C: 3 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: enGy.instanceId,
					abilityId: findAbility(state, p1, enGy).id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.battlefield.filter((x) => x.isToken).length, 3);

			// Outlast
			const olPerm = putPerm(state, p1, outlastCard);
			giveMana(p1, { W: 1, C: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: olPerm.instanceId,
					abilityId: findAbility(state, p1, olPerm).id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(olPerm.counters['+1/+1'], 1);

			// Recover: when another creature you control dies, pay {1}{B} to return recoverCard to hand
			const recGy = putInZone(state, p1, 'graveyard', recoverCard);
			giveMana(p1, { B: 1, C: 1 });
			olPerm.damageMarked = 10;
			checkStateBasedActions(state);
			resolveAllStack(state);
			assert.equal(recGy.zone, 'hand');

			// Dredge (bot replaces draw by milling N and returning dredge card to hand)
			const dredgeCard = synthCard({
				name: 'Golgari Grave-Troll',
				manaCost: '{4}{G}',
				cmc: 5,
				typeLine: 'Creature — Skeleton Troll',
				power: '0',
				toughness: '0',
				oracleText: 'Dredge 2'
			});
			const drGy = putInZone(state, p1, 'graveyard', dredgeCard);
			p1.library = [];
			for (let i = 0; i < 14; i++) {
				putInZone(
					state,
					p1,
					'library',
					synthCard({ name: `Lib ${i}`, typeLine: 'Basic Land — Forest' })
				);
			}
			drawCards(state, p1, 1);
			assert.equal(drGy.zone, 'hand');

			// Miracle: human draws first card of turn -> miracleTurnSerial stamped & castable in draw step
			const { state: mState, p1: mp1 } = setupGame();
			const miracleCard = synthCard({
				name: 'Temporal Mastery',
				manaCost: '{5}{U}{U}',
				cmc: 7,
				typeLine: 'Sorcery',
				oracleText: 'Draw two cards.\nMiracle {1}{U}'
			});
			mState.phase = 'upkeep';
			mState.priorityPlayerIndex = 0;
			mState.passedPriorityPlayerIds = [];
			mp1.cardsDrawnThisTurn = 0;
			mp1.library = [];
			const mirTop = putInZone(mState, mp1, 'library', miracleCard);
			putInZone(mState, mp1, 'library', synthCard({ name: 'Extra 1', typeLine: 'Basic Land — Island' }));
			putInZone(mState, mp1, 'library', synthCard({ name: 'Extra 2', typeLine: 'Basic Land — Island' }));
			passAllOnce(mState);
			assert.equal(mState.phase, 'draw');
			assert.ok(mirTop.miracleTurnSerial !== undefined);
			giveMana(mp1, { U: 1, C: 1 });
			const mirOpt = getCastOptions(mState, mp1.playerId, mirTop, 'hand').find(
				(o) => o.id === 'alt:miracle'
			);
			assert.ok(mirOpt);
		});
	});

	describe('P12.2 — ETB, Combat, Evasion, Static, & Replacement Keywords', () => {
		it('handles Backup (CR 702.165), Champion (CR 702.72), Devour (CR 702.82), Sunburst (CR 702.44), Split second (CR 702.61), and Umbra armor (CR 702.89)', () => {
			const { state, p1, p2 } = setupGame({ p1Bot: true });

			// Sunburst: 3 distinct colors spent -> 3 +1/+1 counters
			const sunburstCard = synthCard({
				name: 'Etched Oracle',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact Creature — Wizard',
				power: '0',
				toughness: '0',
				oracleText: 'Sunburst'
			});
			const sbHand = putInZone(state, p1, 'hand', sunburstCard);
			giveMana(p1, { W: 1, U: 1, B: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: sbHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);
			const sbBf = p1.battlefield.find((c) => c.instanceId === sbHand.instanceId)!;
			assert.equal(sbBf.counters['+1/+1'], 3);

			// Devour: sacrifices token fodder on ETB and triggers "for each creature it devoured"
			const saproling = putPerm(
				state,
				p1,
				synthCard({
					name: 'Saproling',
					manaCost: '',
					cmc: 0,
					typeLine: 'Creature — Saproling',
					power: '1',
					toughness: '1'
				})
			);
			saproling.isToken = true;
			const devourCard = synthCard({
				name: 'Skullmulcher',
				manaCost: '{4}{G}',
				cmc: 5,
				typeLine: 'Creature — Elemental',
				power: '3',
				toughness: '3',
				oracleText: 'Devour 2\nWhen ~ enters, you gain 1 life for each creature it devoured.'
			});
			assert.equal(definitionSupportReport(compileCard(devourCard)).fullySupported, true);
			const devHand = putInZone(state, p1, 'hand', devourCard);
			giveMana(p1, { G: 1, C: 4 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: devHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);
			const devBf = p1.battlefield.find((c) => c.instanceId === devHand.instanceId)!;
			assert.equal(devBf.counters['+1/+1'], 2);
			assert.equal(p1.life, 21);

			// Backup: grants abilities below Backup when targeting another creature until EOT
			const backupCard = synthCard({
				name: 'Boon-Bringer Valkyrie',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Creature — Angel Warrior',
				power: '2',
				toughness: '2',
				oracleText: 'Backup 1\nFlying\nLifelink'
			});
			const bkHand = putInZone(state, p1, 'hand', backupCard);
			giveMana(p1, { W: 1, C: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bkHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);

			// Champion: exiles matching Elf on ETB and returns it on LTB
			const elf = putPerm(
				state,
				p1,
				synthCard({
					name: 'Llanowar Scout',
					manaCost: '{G}',
					cmc: 1,
					typeLine: 'Creature — Elf',
					power: '1',
					toughness: '1'
				})
			);
			const champCard = synthCard({
				name: "Wren's Run Packmaster",
				manaCost: '{3}{G}',
				cmc: 4,
				typeLine: 'Creature — Elf Warrior',
				power: '3',
				toughness: '3',
				oracleText: 'Champion an Elf'
			});
			const chHand = putInZone(state, p1, 'hand', champCard);
			giveMana(p1, { G: 1, C: 3 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: chHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(elf.zone, 'exile');
			const chBf = p1.battlefield.find((c) => c.instanceId === chHand.instanceId)!;
			chBf.damageMarked = 10;
			checkStateBasedActions(state);
			resolveAllStack(state);
			const elfBf = p1.battlefield.find((c) => c.instanceId === elf.instanceId)!;
			assert.ok(elfBf);

			// Split second: blocks opponent spell casts & non-mana abilities while allowing mana abilities (CR 702.61a–b)
			const splitSecCard = synthCard({
				name: 'Krosan Grip',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Split second\nYou gain 2 life.'
			});
			const oppInstant = putInZone(
				state,
				p2,
				'hand',
				synthCard({
					name: 'Opt',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Draw a card.'
				})
			);
			const oppLand = putPerm(
				state,
				p2,
				synthCard({
					name: 'Opp Island',
					manaCost: '',
					cmc: 0,
					typeLine: 'Basic Land — Island',
					oracleText: '({T}: Add {U}.)'
				})
			);
			giveMana(p2, { U: 1 });
			const ssHand = putInZone(state, p1, 'hand', splitSecCard);
			giveMana(p1, { G: 1, C: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: ssHand.instanceId
				}).ok,
				true
			);
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			// Mana ability is legal while split second is on stack (CR 702.61b)!
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'tap_mana',
					instanceId: oppLand.instanceId
				}).ok,
				true
			);
			// Spell cast is forbidden while split second is on stack (CR 702.61a)!
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: oppInstant.instanceId
				}).ok,
				false
			);
			resolveAllStack(state);

			// Umbra armor: replaces BOTH explicit destroy effect AND lethal damage SBA (CR 702.89a)
			const umbraCard = synthCard({
				name: 'Hyena Umbra',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.\nUmbra armor'
			});
			const umbra1 = putPerm(state, p1, umbraCard);
			umbra1.attachedToId = elfBf.instanceId;
			elfBf.damageMarked = 1;
			const doom = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'Terminate',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Destroy target creature.'
				})
			);
			giveMana(p1, { B: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: doom.instanceId,
					targets: [permTarget(elfBf)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(elfBf.zone, 'battlefield');
			assert.equal(elfBf.damageMarked, 0);
			assert.equal(elfBf.tapped, false);
			assert.equal(umbra1.zone, 'graveyard');

			const umbra2 = putPerm(state, p1, umbraCard);
			umbra2.attachedToId = elfBf.instanceId;
			elfBf.damageMarked = 5;
			checkStateBasedActions(state);
			assert.equal(elfBf.zone, 'battlefield');
			assert.equal(elfBf.damageMarked, 0);
			assert.equal(umbra2.zone, 'graveyard');
		});

		it('handles Afflict, Decayed, Dethrone, Enlist, Firebending, Ingest, Melee, Mentor (including LKI power re-check), Mobilize, Myriad, Rampage, Renown, and Training in combat', () => {
			const { state, p1, p2, p3 } = setupGame({ p1Bot: true, threePlayer: true });
			p2.life = 25; // Most life for Dethrone
			p3!.life = 20;
			putInZone(
				state,
				p2,
				'library',
				synthCard({ name: 'Ingested Card', typeLine: 'Basic Land — Swamp' })
			);

			const helper = putPerm(
				state,
				p1,
				synthCard({
					name: 'Enlist Helper',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Soldier',
					power: '2',
					toughness: '2'
				})
			);
			const combatHero = putPerm(
				state,
				p1,
				synthCard({
					name: 'Wave 4 Warlord',
					manaCost: '{3}{R}{W}',
					cmc: 5,
					typeLine: 'Creature — Human Warrior',
					power: '4',
					toughness: '4',
					oracleText:
						'Dethrone, enlist, firebending 2, ingest, melee, mentor, mobilize 1, myriad, renown 2'
				})
			);
			const trainee = putPerm(
				state,
				p1,
				synthCard({
					name: 'Eager Trainee',
					manaCost: '{G}',
					cmc: 1,
					typeLine: 'Creature — Human',
					power: '1',
					toughness: '2',
					oracleText: 'Training'
				})
			);
			const decayedZombie = putPerm(
				state,
				p1,
				synthCard({
					name: 'Rotting Token',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Creature — Zombie',
					power: '2',
					toughness: '2',
					oracleText: 'Decayed'
				})
			);
			const afflictRampage = putPerm(
				state,
				p1,
				synthCard({
					name: 'Afflict Rampager',
					manaCost: '{3}{R}',
					cmc: 4,
					typeLine: 'Creature — Minotaur',
					power: '3',
					toughness: '5',
					oracleText: 'Afflict 2\nRampage 2'
				})
			);
			const b1 = putPerm(
				state,
				p2,
				synthCard({
					name: 'Blocker A',
					manaCost: '{1}',
					cmc: 1,
					typeLine: 'Creature — Wall',
					power: '0',
					toughness: '6'
				})
			);
			const b2 = putPerm(
				state,
				p2,
				synthCard({
					name: 'Blocker B',
					manaCost: '{1}',
					cmc: 1,
					typeLine: 'Creature — Wall',
					power: '0',
					toughness: '6'
				})
			);

			// Enter declare_attackers ready for manual attacker declaration
			state.phase = 'declare_attackers';
			state.combat.active = false;
			state.combat.attackers = [];
			state.priorityPlayerIndex = 0;
			state.passedPriorityPlayerIds = [];

			const atkRes = applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: combatHero.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: trainee.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: decayedZombie.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: afflictRampage.instanceId, defenderPlayerId: p2.playerId }
				]
			});
			assert.equal(atkRes.ok, true, atkRes.error ?? '');
			resolveAllStack(state);

			// Verify attack-trigger results: Firebending {R}{R} retained across step, Enlist tapped helper,
			// Dethrone +1/+1 on combatHero, Training +1/+1 on trainee, Mentor +1/+1 on friendly attacker, Mobilize + Myriad tokens!
			assert.equal(helper.tapped, true);
			assert.equal(p1.manaPool.R, 2);
			assert.equal(combatHero.counters['+1/+1'], 1);
			assert.equal(trainee.counters['+1/+1'], 1);
			assert.equal(
				(trainee.counters['+1/+1'] || 0) +
					(decayedZombie.counters['+1/+1'] || 0) +
					(afflictRampage.counters['+1/+1'] || 0),
				2
			);
			assert.ok(p1.battlefield.filter((x) => x.isToken).length >= 2);

			// Advance to declare_blockers -> double-block afflictRampage to trigger Afflict 2 & Rampage 2
			passAllOnce(state);
			assert.equal(state.phase, 'declare_blockers');
			assert.equal(p1.manaPool.R, 2); // Firebending red mana persisted into declare_blockers!

			const lifeBeforeBlock = p2.life;
			const powerBeforeBlock = evaluatePermanent(state, afflictRampage).power;
			const blkRes = applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: b1.instanceId, attackerInstanceId: afflictRampage.instanceId },
					{ blockerInstanceId: b2.instanceId, attackerInstanceId: afflictRampage.instanceId }
				]
			});
			assert.equal(blkRes.ok, true, blkRes.error ?? '');
			resolveAllStack(state);
			assert.equal(p2.life, lifeBeforeBlock - 2); // Afflict 2
			assert.equal(evaluatePermanent(state, afflictRampage).power, powerBeforeBlock + 2); // + Rampage 2

			// Also block Myriad copy or let p3 pass declare_blockers
			const p3Attacked = state.combat.attackers.some((a) => a.defenderPlayerId === p3!.playerId);
			if (p3Attacked) {
				applyGameAction(state, p3!.playerId, {
					type: 'declare_blockers',
					assignments: []
				});
			}

			// Advance through combat_damage -> Ingest exiles top card of p2 library & Renown 2 sets isRenowned
			for (let guard = 0; guard < 15; guard++) {
				if (state.phase === 'end_combat' || state.phase === 'main2') break;
				const pr = state.players[state.priorityPlayerIndex];
				applyGameAction(state, pr.playerId, { type: 'pass_priority' });
				resolveAllStack(state);
			}
			assert.equal(combatHero.isRenowned, true);
			assert.equal(p2.exile.length, 1);

			// Advance through end_combat -> Decayed sacrifices decayedZombie & Firebending clears at end of combat
			for (let guard = 0; guard < 15; guard++) {
				if (state.phase === 'main2') break;
				const pr = state.players[state.priorityPlayerIndex];
				applyGameAction(state, pr.playerId, { type: 'pass_priority' });
				resolveAllStack(state);
			}
			assert.equal(state.phase, 'main2');
			assert.equal(decayedZombie.zone, 'graveyard');
			assert.equal(p1.manaPool.R, 0);

			// Mentor resolution-time power re-check (CR 702.134a): if target power >= mentor power on resolution, no counter is placed
			const { state: ms, p1: mp1, p2: mp2 } = setupGame({ p1Bot: true });
			const mentorPerm = putPerm(
				ms,
				mp1,
				synthCard({
					name: 'Mentor Captain',
					manaCost: '{2}{W}',
					cmc: 3,
					typeLine: 'Creature — Human Soldier',
					power: '3',
					toughness: '3',
					oracleText: 'Mentor'
				})
			);
			const studentPerm = putPerm(
				ms,
				mp1,
				synthCard({
					name: 'Student',
					manaCost: '{W}',
					cmc: 1,
					typeLine: 'Creature — Human Soldier',
					power: '2',
					toughness: '2'
				})
			);
			ms.phase = 'declare_attackers';
			ms.combat.active = false;
			ms.combat.attackers = [];
			ms.priorityPlayerIndex = 0;
			ms.passedPriorityPlayerIds = [];
			assert.equal(
				applyGameAction(ms, mp1.playerId, {
					type: 'declare_attackers',
					assignments: [
						{ attackerInstanceId: mentorPerm.instanceId, defenderPlayerId: mp2.playerId },
						{ attackerInstanceId: studentPerm.instanceId, defenderPlayerId: mp2.playerId }
					]
				}).ok,
				true
			);
			// Boost student's power to 3 before Mentor trigger resolves -> fails CR 702.134a power re-check!
			studentPerm.tempPowerMod = 1;
			resolveAllStack(ms);
			assert.equal(studentPerm.counters['+1/+1'], 0);
		});

		it('maintains card-rename invariance across Class, Case, Spree, Forecast, and Renown compilation', () => {
			const cardA = synthCard({
				name: 'Topan Freeblade',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Soldier',
				power: '2',
				toughness: '2',
				oracleText: 'Vigilance\nRenown 1\nWhen Topan Freeblade becomes renowned, draw a card.'
			});
			const cardB = synthCard({
				name: 'Renamed Champion',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Soldier',
				power: '2',
				toughness: '2',
				oracleText: 'Vigilance\nRenown 1\nWhen Renamed Champion becomes renowned, draw a card.'
			});
			const irA = compileCard(cardA).faces[0];
			const irB = compileCard(cardB).faces[0];
			assert.equal(irA.abilities.length, irB.abilities.length);
			assert.equal(
				irA.abilities.some((a) => a.kind === 'unsupported'),
				false
			);
			assert.deepEqual(
				irA.abilities.map((a) => a.kind),
				irB.abilities.map((a) => a.kind)
			);
		});

		it('handles Graft (CR 702.58), Undaunted (CR 702.125), Mayhem (CR 702.187b–c), Web-slinging (CR 702.188), Sneak (CR 702.190), Beam me up (CR 702.196), and disjunctive Enchant/Equip/Affinity', () => {
			// 1. Undaunted in 3-player game reduces generic cost by 2 (CR 702.125a–b)
			const { state: uState, p1: up1, p3: up3 } = setupGame({ p1Bot: true, threePlayer: true });
			const undauntedCard = synthCard({
				name: 'Sublime Exhalation Probe',
				manaCost: '{3}{U}',
				cmc: 4,
				typeLine: 'Sorcery',
				oracleText: 'Undaunted\nDraw two cards.'
			});
			putInZone(uState, up1, 'library', synthCard({ name: 'Draw 1', typeLine: 'Basic Land — Island' }));
			putInZone(uState, up1, 'library', synthCard({ name: 'Draw 2', typeLine: 'Basic Land — Island' }));
			const uInst = putInZone(uState, up1, 'hand', undauntedCard);
			giveMana(up1, { U: 1, C: 1 }); // {3}{U} reduced by 2 opponents -> {1}{U}
			assert.equal(
				applyGameAction(uState, up1.playerId, {
					type: 'cast_spell',
					instanceId: uInst.instanceId
				}).ok,
				true
			);
			resolveAllStack(uState);
			assert.equal(up1.hand.length, 2);
			// Eliminated opponent no longer counts toward Undaunted (CR 702.125b)
			up3!.lost = true;
			const uInst2 = putInZone(uState, up1, 'hand', undauntedCard);
			giveMana(up1, { U: 1, C: 1 }); // only 1 active opponent now -> needs {2}{U}, so {1}{U} fails
			assert.equal(
				applyGameAction(uState, up1.playerId, {
					type: 'cast_spell',
					instanceId: uInst2.instanceId
				}).ok,
				false
			);

			// 2. Graft (CR 702.58a–b, CR 122.5): enters with N +1/+1 counters on land & creature, moves counter on ETB
			const { state, p1, p2 } = setupGame();
			const graftLand = synthCard({
				name: 'Llanowar Reborn Probe',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText: '~ enters tapped.\n{T}: Add {G}.\nGraft 1'
			});
			const glHand = putInZone(state, p1, 'hand', graftLand);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'play_land',
					instanceId: glHand.instanceId
				}).ok,
				true
			);
			const glBf = p1.battlefield.find((c) => c.instanceId === glHand.instanceId)!;
			assert.equal(glBf.counters['+1/+1'], 1);

			const bearCard = synthCard({
				name: 'Runeclaw Recruit',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const bearHand = putInZone(state, p1, 'hand', bearCard);
			giveMana(p1, { G: 1, C: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bearHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);
			// Human player receives Graft yes/no prompt
			assert.equal(state.pendingPrompts.length, 1);
			const graftPrompt = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: graftPrompt.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveAllStack(state);
			const bearBf = p1.battlefield.find((c) => c.instanceId === bearHand.instanceId)!;
			assert.equal(glBf.counters['+1/+1'], 0);
			assert.equal(bearBf.counters['+1/+1'], 1);

			// 3. Web-slinging (CR 702.188a): cast by returning a tapped creature you control to hand
			bearBf.tapped = true;
			const webCard = synthCard({
				name: 'Friendly Neighborhood Crawler',
				manaCost: '{3}{W}',
				cmc: 4,
				typeLine: 'Creature — Spider Hero',
				power: '3',
				toughness: '3',
				oracleText: 'Web-slinging {1}{W}'
			});
			const webHand = putInZone(state, p1, 'hand', webCard);
			giveMana(p1, { W: 1, C: 1 });
			const webOpt = getCastOptions(state, p1.playerId, webHand, 'hand').find(
				(o) => o.id === 'alt:web_slinging'
			);
			assert.ok(webOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: webHand.instanceId,
					optionId: webOpt.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(bearBf.zone, 'hand');
			const webBf = p1.battlefield.find((c) => c.instanceId === webHand.instanceId)!;
			assert.ok(webBf);

			// 4. Beam me up (CR 702.196a): cast sorcery from graveyard by returning a creature you control to hand, exiles on resolution
			const beamCard = synthCard({
				name: 'Transporter Extraction',
				manaCost: '{3}{U}',
				cmc: 4,
				typeLine: 'Sorcery',
				oracleText: 'You gain 3 life.\nBeam me up {1}{U}'
			});
			const beamGy = putInZone(state, p1, 'graveyard', beamCard);
			giveMana(p1, { U: 1, C: 1 });
			const beamOpt = getCastOptions(state, p1.playerId, beamGy, 'graveyard').find(
				(o) => o.id === 'graveyard:beam_me_up'
			);
			assert.ok(beamOpt);
			const lifeBeforeBeam = p1.life;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: beamGy.instanceId,
					optionId: beamOpt.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(webBf.zone, 'hand');
			assert.equal(p1.life, lifeBeforeBeam + 3);
			assert.ok(p1.exile.some((c) => c.instanceId === beamGy.instanceId));

			// 5. Mayhem (CR 702.187b–c): spell cast via Mayhem {cost} after discard (goes back to graveyard without permission), plus bare Mayhem land
			const mayhemSpell = synthCard({
				name: 'Goblin Glider Barrage',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: '~ deals 2 damage to any target.\nMayhem {R}'
			});
			const mayhemLand = synthCard({
				name: 'Oscorp Tower Probe',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText: 'Mayhem\n{T}: Add {B}.'
			});
			const discardOutlet = synthCard({
				name: 'Rummage Probe',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'As an additional cost to cast this spell, discard a card.\nYou gain 1 life.'
			});
			p1.hand = [];
			const msHand = putInZone(state, p1, 'hand', mayhemSpell);
			const doHand = putInZone(state, p1, 'hand', discardOutlet);
			giveMana(p1, { R: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: doHand.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(msHand.zone, 'graveyard');
			const mayhemOpt = getCastOptions(state, p1.playerId, msHand, 'graveyard').find(
				(o) => o.id === 'graveyard:mayhem'
			);
			assert.ok(mayhemOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: msHand.instanceId,
					optionId: mayhemOpt.id,
					targets: [playerTarget(p2)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p2.life, 18);
			// Mayhem does NOT exile on resolution (returns to graveyard as a new object without Mayhem permission)
			const msAfter = p1.graveyard.find((c) => c.instanceId === msHand.instanceId);
			assert.ok(msAfter);
			assert.equal(
				getCastOptions(state, p1.playerId, msAfter, 'graveyard').some(
					(o) => o.id === 'graveyard:mayhem'
				),
				false
			);

			// Bare Mayhem land played from graveyard after discarding this turn (CR 702.187c)
			p1.landsPlayedThisTurn = 0;
			p1.hand = [];
			const mlHand = putInZone(state, p1, 'hand', mayhemLand);
			const doHand2 = putInZone(state, p1, 'hand', discardOutlet);
			giveMana(p1, { R: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: doHand2.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(mlHand.zone, 'graveyard');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'play_land',
					instanceId: mlHand.instanceId,
					fromZone: 'graveyard'
				}).ok,
				true
			);
			assert.equal(mlHand.zone, 'battlefield');

			// 6. Sneak (CR 702.190a–b, CR 506.3, CR 508.4): cast during declare blockers returning unblocked attacker -> enters tapped & attacking without firing attack trigger
			const { state: sState, p1: sp1, p2: sp2 } = setupGame();
			const unblockedScout = putPerm(
				sState,
				sp1,
				synthCard({
					name: 'Foot Clan Scout',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Creature — Human Ninja',
					power: '1',
					toughness: '1'
				})
			);
			const sneakNinja = synthCard({
				name: 'Shadowshell Striker',
				manaCost: '{3}{B}',
				cmc: 4,
				typeLine: 'Creature — Mutant Ninja Turtle',
				power: '4',
				toughness: '3',
				oracleText: 'Sneak {1}{B}\nWhenever ~ attacks, you lose 5 life.'
			});
			const snHand = putInZone(sState, sp1, 'hand', sneakNinja);
			// Not castable via Sneak in main1
			assert.equal(
				getCastOptions(sState, sp1.playerId, snHand, 'hand').some((o) => o.id === 'alt:sneak'),
				false
			);
			sState.phase = 'declare_attackers';
			sState.combat.active = false;
			sState.combat.attackers = [];
			sState.priorityPlayerIndex = 0;
			sState.passedPriorityPlayerIds = [];
			assert.equal(
				applyGameAction(sState, sp1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: unblockedScout.instanceId, defenderPlayerId: sp2.playerId }]
				}).ok,
				true
			);
			passAllOnce(sState);
			assert.equal(sState.phase, 'declare_blockers');
			assert.equal(
				applyGameAction(sState, sp2.playerId, {
					type: 'declare_blockers',
					assignments: []
				}).ok,
				true
			);
			// Priority returns to active player sp1 in declare_blockers after blockers declared
			giveMana(sp1, { B: 1, C: 1 });
			const sneakOpt = getCastOptions(sState, sp1.playerId, snHand, 'hand').find(
				(o) => o.id === 'alt:sneak'
			);
			assert.ok(sneakOpt);
			assert.equal(
				applyGameAction(sState, sp1.playerId, {
					type: 'cast_spell',
					instanceId: snHand.instanceId,
					optionId: sneakOpt.id
				}).ok,
				true
			);
			assert.equal(unblockedScout.zone, 'hand');
			resolveAllStack(sState);
			const snBf = sp1.battlefield.find((c) => c.instanceId === snHand.instanceId)!;
			assert.ok(snBf);
			assert.equal(snBf.tapped, true);
			assert.equal(sp1.life, 20); // "Whenever ~ attacks" did NOT trigger (CR 508.4)
			assert.equal(
				sState.combat.attackers.some(
					(a) => a.attackerInstanceId === snBf.instanceId && a.defenderPlayerId === sp2.playerId
				),
				true
			);
			// Advance to combat_damage -> deals 4 combat damage to sp2!
			passAllOnce(sState);
			assert.equal(sp2.life, 16);

			// 7. Disjunctive Enchant, Equip choice cost, Affinity for historic, & lowercase subtypecycling compile cleanly
			for (const probe of [
				synthCard({
					name: 'Vehicle Harness',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant creature or Vehicle'
				}),
				synthCard({
					name: 'Gruul Warpaint',
					manaCost: '{R}{G}',
					cmc: 2,
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant red or green creature'
				}),
				synthCard({
					name: 'Dual Grip Blade',
					manaCost: '{1}',
					cmc: 1,
					typeLine: 'Artifact — Equipment',
					oracleText: 'Equip {2} or {B}'
				}),
				synthCard({
					name: 'Relic Golem',
					manaCost: '{6}',
					cmc: 6,
					typeLine: 'Artifact Creature — Golem',
					power: '4',
					toughness: '4',
					oracleText: 'Affinity for historic'
				}),
				synthCard({
					name: 'Mire Sojourner',
					manaCost: '{4}{U}{B}',
					cmc: 6,
					typeLine: 'Creature — Horror',
					power: '4',
					toughness: '4',
					oracleText: 'Islandcycling {2}, swampcycling {2}'
				})
			]) {
				const rep = definitionSupportReport(compileCard(probe));
				assert.equal(rep.fullySupported, true, `${probe.name} should be fully supported`);
			}
		});
	});

	describe('CR 106.7 & Layer 6 parity for backup_act:, quoted_eot:, and mergedComponents', () => {
		const catalog = new Map<string, ScryfallCard>();
		for (const d of PRECON_DECKS) {
			for (const e of d.cards) catalog.set(e.card.name, e.card);
		}
		for (const v of Object.values(STAPLE_CARDS)) {
			if (Array.isArray(v)) {
				for (const c of v) catalog.set(c.name, c);
			} else if (v && typeof v === 'object' && 'name' in v) {
				catalog.set((v as ScryfallCard).name, v as ScryfallCard);
			}
		}
		function realCard(name: string): ScryfallCard {
			const c = catalog.get(name);
			assert.ok(c, `Expected canonical card '${name}'`);
			return c;
		}
		function cloneRenamed(base: ScryfallCard, newName: string): ScryfallCard {
			const shortComma = base.name.split(',')[0].trim();
			const shortOf = base.name.split(/\s+of\s+/i)[0].trim();
			const newShort = newName.split(',')[0].split(/\s+of\s+/i)[0].trim();
			let nextText = base.oracleText.split(base.name).join(newName);
			for (const short of [shortComma, shortOf]) {
				if (short && short !== base.name && short.length >= 3) {
					nextText = nextText.replace(
						new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
						newShort
					);
				}
			}
			return synthCard({
				...base,
				id: undefined,
				oracleId: undefined,
				name: newName,
				oracleText: nextText
			});
		}
		function answerTopPrompt(state: GameState, answer: ChoiceAnswer): void {
			const prm = state.pendingPrompts[0];
			assert.ok(prm, 'Expected pending prompt');
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer
			});
			assert.equal(res.ok, true, res.error ?? '');
		}
		function passUntilPhase(state: GameState, targetPhase: GameState['phase'], targetActiveIndex?: number): void {
			for (let guard = 0; guard < 600; guard++) {
				if (
					state.phase === targetPhase &&
					state.stack.length === 0 &&
					state.pendingPrompts.length === 0 &&
					(targetActiveIndex === undefined || state.activePlayerIndex === targetActiveIndex)
				) {
					return;
				}
				if (state.pendingPrompts.length > 0) {
					resolveAllStack(state);
					if (state.pendingPrompts.length > 0) return;
					continue;
				}
				const actor = state.players[state.priorityPlayerIndex]!;
				const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
				assert.equal(res.ok, true, res.error ?? '');
			}
			assert.fail(`passUntilPhase exceeded 600 steps (phase=${state.phase}, active=${state.activePlayerIndex})`);
		}

		it('includes backup_act: mana abilities in CR 106.7 (Ashaya + Bear + Backup -> Exotic Orchard & Reflecting Pool + autoTap, canonical + cloneRenamed)', () => {
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseMentor = synthCard({
				name: 'White Mana Mentor',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Creature — Human Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\n{T}: Add {W}.'
			});
			const realOrchard = realCard('Exotic Orchard');
			const realPool = realCard('Reflecting Pool');

			const variants = [
				{
					ashaya: baseAshaya,
					mentor: baseMentor,
					orchard: realOrchard,
					pool: realPool
				},
				{
					ashaya: cloneRenamed(baseAshaya, 'Grove Animist'),
					mentor: cloneRenamed(baseMentor, 'Ivory Tutor'),
					orchard: cloneRenamed(realOrchard, 'Foreign Meadow'),
					pool: cloneRenamed(realPool, 'Shimmering Basin')
				}
			];

			for (const v of variants) {
				const { state, p1, p2 } = setupGame();
				putPerm(state, p1, v.ashaya);
				const bear = putPerm(
					state,
					p1,
					synthCard({ name: 'Grizzly Bears', manaCost: '{1}{G}', cmc: 2, colors: ['G'], typeLine: 'Creature — Bear', power: '2', toughness: '2' })
				);
				const pool = putPerm(state, p1, v.pool);
				const orchard = putPerm(state, p2, v.orchard);
				const mentorHand = putInZone(state, p1, 'hand', v.mentor);
				giveMana(p1, { C: 1 });
				noteLayerInputsChanged(state);

				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: mentorHand.instanceId
					}).ok,
					true
				);
				for (let g = 0; g < 20 && (state.stack.length > 0 || state.pendingPrompts.length > 0); g++) {
					if (state.pendingPrompts.length > 0) {
						answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [bear.instanceId] });
					} else {
						const pr = state.players[state.priorityPlayerIndex]!;
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
				const mentorPerm = p1.battlefield.find((c) => c.instanceId === mentorHand.instanceId)!;
				assert.ok(mentorPerm);
				moveObject(state, mentorPerm, 'graveyard', {
					from: { player: p1, zone: 'battlefield' },
					toPlayer: p1
				});
				noteLayerInputsChanged(state);

				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), ['W', 'G']);
				assert.deepEqual(opponentLandColors(state, p2), ['W', 'G']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, orchard)[0]?.producesMana, ['W', 'G']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p1, pool)[0]?.producesMana, ['W', 'G']);

				// Tap P2 Exotic Orchard for {W}
				assert.equal(
					applyGameAction(state, p2.playerId, {
						type: 'tap_mana',
						instanceId: orchard.instanceId,
						preferredColor: 'W'
					}).ok,
					true
				);
				assert.equal(p2.manaPool.W, 1);

				// P1 taps bear & ashaya beforehand or leaves only pool untapped -> autoTap casts {W} via Reflecting Pool
				bear.tapped = true;
				const ashayaPerm = p1.battlefield.find((c) => c.card.name === v.ashaya.name)!;
				ashayaPerm.tapped = true;
				const whiteSpell = putInZone(
					state,
					p1,
					'hand',
					synthCard({
						name: 'Healing Grace',
						manaCost: '{W}',
						cmc: 1,
						colors: ['W'],
						typeLine: 'Sorcery',
						oracleText: 'You gain 2 life.'
					})
				);
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: whiteSpell.instanceId
					}).ok,
					true
				);
				assert.equal(pool.tapped, true);
			}
		});

		it('enforces CR 613.1f / 613.7 / 611.2b Layer 6 keepManaAbilities, Humility/Dress Down timestamp order, face-down, & quoted_eot activity (canonical + cloneRenamed)', () => {
			const realHumility = realCard('Humility');
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				typeLine: 'Enchantment',
				manaCost: '{2}{W}',
				cmc: 3,
				colors: ['W'],
				oracleText: 'Creatures you control lose all abilities except mana abilities.'
			});
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseMentor = synthCard({
				name: 'White Mana Mentor',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Creature — Human Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\n{T}: Add {W}.'
			});

			const variants = [
				{
					humility: realHumility,
					keeper: baseKeeper,
					ashaya: baseAshaya,
					mentor: baseMentor
				},
				{
					humility: cloneRenamed(realHumility, 'Meekness Field'),
					keeper: cloneRenamed(baseKeeper, 'Sanctuary Seal'),
					ashaya: cloneRenamed(baseAshaya, 'Sylvan Soul'),
					mentor: cloneRenamed(baseMentor, 'Ivory Instructor')
				}
			];

			for (const v of variants) {
				// A. Backup before & after SplendorKeeper (non-creature Enchantment) retains 'W'
				for (const keeperFirst of [true, false]) {
					const { state, p1, p2 } = setupGame();
					if (keeperFirst) putPerm(state, p1, v.keeper);
					putPerm(state, p1, v.ashaya);
					const bear = putPerm(
						state,
						p1,
						synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					(state.timedContinuousEffects ??= []).push({
						sourceName: v.mentor.name,
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						backupGrant: { sourceCard: v.mentor, faceIndex: 0, startAbilityIndex: 1 }
					});
					if (!keeperFirst) putPerm(state, p1, v.keeper);
					noteLayerInputsChanged(state);

					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), ['W', 'G']);
					assert.deepEqual(opponentLandColors(state, p2), ['W', 'G']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bear.instanceId,
							preferredColor: 'W'
						}).ok,
						true
					);
					assert.equal(p1.manaPool.W, 1);
				}

				// B. Backup BEFORE Humility loses 'W'; Humility BEFORE Backup retains 'W' (CR 613.7)
				{
					const { state, p1 } = setupGame();
					const bear = putPerm(
						state,
						p1,
						synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					(state.timedContinuousEffects ??= []).push({
						sourceName: v.mentor.name,
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						backupGrant: { sourceCard: v.mentor, faceIndex: 0, startAbilityIndex: 1 }
					});
					putPerm(state, p1, v.humility);
					noteLayerInputsChanged(state);

					assert.equal(getEffectiveActivatedAbilities(state, p1, bear).length, 0);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), []);
				}
				{
					const { state, p1 } = setupGame();
					const bear = putPerm(
						state,
						p1,
						synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					putPerm(state, p1, v.humility);
					(state.timedContinuousEffects ??= []).push({
						sourceName: v.mentor.name,
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						backupGrant: { sourceCard: v.mentor, faceIndex: 0, startAbilityIndex: 1 }
					});
					noteLayerInputsChanged(state);

					assert.equal(getEffectiveActivatedAbilities(state, p1, bear).length, 1);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), ['W']);
				}

				// C. Face-down creature + Backup + SplendorKeeper retains backup_act: mana ability
				{
					const { state, p1 } = setupGame();
					const fd = putPerm(
						state,
						p1,
						synthCard({ name: 'Morph Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					fd.isFaceDown = true;
					fd.faceDownSpec = { kind: 'morph', power: 2, toughness: 2, types: ['Creature'] };
					(state.timedContinuousEffects ??= []).push({
						sourceName: v.mentor.name,
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'endOfTurn',
						affected: [{ instanceId: fd.instanceId, objectVersion: fd.objectVersion ?? 1 }],
						backupGrant: { sourceCard: v.mentor, faceIndex: 0, startAbilityIndex: 1 }
					});
					putPerm(state, p1, v.keeper);
					noteLayerInputsChanged(state);

					const fdAbs = getEffectiveActivatedAbilities(state, p1, fd);
					assert.equal(fdAbs.length, 1);
					assert.deepEqual(fdAbs[0]?.producesMana, ['W']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, fd, true), ['W']);
				}

				// D. Inactive quoted_eot (forAsLongAsSelfRemainsTapped when source is untapped) is excluded
				{
					const { state, p1 } = setupGame();
					const src = putPerm(
						state,
						p1,
						synthCard({ name: 'Tap Enabler', typeLine: 'Artifact' }),
						{ tapped: false }
					);
					const bear = putPerm(
						state,
						p1,
						synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					(state.timedContinuousEffects ??= []).push({
						sourceName: src.card.name,
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'forAsLongAsSelfRemainsTapped',
						sourceCondition: {
							kind: 'remainsTapped',
							sourceInstanceId: src.instanceId,
							sourceObjectVersion: src.objectVersion ?? 1,
							controllerId: p1.playerId
						},
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						layer6: { grantedAbilityTexts: ['{T}: Add {W}.'] }
					});
					noteLayerInputsChanged(state);

					assert.equal(getEffectiveActivatedAbilities(state, p1, bear).length, 0);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), []);
				}
			}
		});

		it('handles Mirage Mirror copying mergedComponents under Ashaya & onceEachTurn ID isolation (canonical + cloneRenamed)', () => {
			const realMirror = realCard('Mirage Mirror');
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseTopOnce = synthCard({
				name: 'Top Scholar',
				manaCost: '{2}{U}',
				cmc: 3,
				colors: ['U'],
				typeLine: 'Creature — Beast',
				power: '3',
				toughness: '3',
				oracleText: '{1}, {T}: Draw a card. Activate only once each turn.'
			});
			const baseBottomOnceMana = synthCard({
				name: 'White Dork',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {W}. Activate only once each turn.'
			});

			const variants = [
				{
					mirror: realMirror,
					ashaya: baseAshaya,
					topOnce: baseTopOnce,
					bottomMana: baseBottomOnceMana
				},
				{
					mirror: cloneRenamed(realMirror, 'Silver Mirror'),
					ashaya: cloneRenamed(baseAshaya, 'Forest Matriarch'),
					topOnce: cloneRenamed(baseTopOnce, 'Apex Archivist'),
					bottomMana: cloneRenamed(baseBottomOnceMana, 'Dawn Mystic')
				}
			];

			for (const v of variants) {
				// A. Mirage Mirror copying mutated creature under Ashaya -> ['W', 'G']
				{
					const { state, p1, p2 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const mirror = putPerm(state, p1, v.mirror);
					const oppMut = putPerm(state, p2, v.topOnce);
					oppMut.mergedComponents = [v.topOnce, v.bottomMana];
					giveMana(p1, { C: 2 });
					noteLayerInputsChanged(state);

					const mmAb = findAbility(state, p1, mirror);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: mirror.instanceId,
							abilityId: mmAb.id,
							targets: [permTarget(oppMut)]
						}).ok,
						true
					);
					resolveAllStack(state);

					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, mirror, true), ['W', 'G']);
					assert.deepEqual(opponentLandColors(state, p2), ['W', 'G']);
				}

				// B. onceEachTurn ID isolation: activating top's act_0 does NOT suppress bottom's mana ability; activating bottom's mana ability DOES
				{
					const { state, p1 } = setupGame();
					const mut = putPerm(state, p1, v.topOnce);
					mut.mergedComponents = [v.topOnce, v.bottomMana];
					giveMana(p1, { C: 1 });
					noteLayerInputsChanged(state);

					const abs = getEffectiveActivatedAbilities(state, p1, mut);
					const topAb = abs.find((a) => !a.isManaAbility)!;
					const botManaAb = abs.find((a) => a.isManaAbility && a.id.startsWith('backup_act:merged_1:'))!;
					assert.ok(topAb && botManaAb);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: mut.instanceId,
							abilityId: topAb.id
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.deepEqual(
						permanentCouldProduceManaTypes(state, p1, mut, true),
						['W'],
						"Top's onceEachTurn non-mana ability must not suppress merged bottom's mana ability"
					);

					mut.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: mut.instanceId,
							abilityId: botManaAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.W, 1);
					assert.deepEqual(
						permanentCouldProduceManaTypes(state, p1, mut, true),
						[],
						"Once bottom's onceEachTurn mana ability is used, CR 106.7 excludes it for the turn"
					);
				}
			}
		});

		it('enforces CR 613.6 + CR 305.6 for Ashaya + Bear + SplendorKeeper (keepManaAbilities: true) in both timestamp orders with & without Backup (canonical + cloneRenamed)', () => {
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				typeLine: 'Enchantment',
				manaCost: '{2}{W}',
				cmc: 3,
				colors: ['W'],
				oracleText: 'Creatures you control lose all abilities except mana abilities.'
			});
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseMentor = synthCard({
				name: 'White Mana Mentor',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Creature — Human Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\n{T}: Add {W}.'
			});
			const realOrchard = realCard('Exotic Orchard');
			const realPool = realCard('Reflecting Pool');

			const variants = [
				{
					keeper: baseKeeper,
					ashaya: baseAshaya,
					mentor: baseMentor,
					orchard: realOrchard,
					pool: realPool
				},
				{
					keeper: cloneRenamed(baseKeeper, 'Sanctuary Seal'),
					ashaya: cloneRenamed(baseAshaya, 'Sylvan Soul'),
					mentor: cloneRenamed(baseMentor, 'Ivory Instructor'),
					orchard: cloneRenamed(realOrchard, 'Fabled Grove'),
					pool: cloneRenamed(realPool, 'Mirror Basin')
				}
			];

			for (const v of variants) {
				for (const keeperFirst of [true, false]) {
					for (const withBackup of [false, true]) {
						const { state, p1, p2 } = setupGame();
						if (keeperFirst) putPerm(state, p1, v.keeper);
						const ashayaPerm = putPerm(state, p1, v.ashaya);
						const bear = putPerm(
							state,
							p1,
							synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
						);
						if (withBackup) {
							(state.timedContinuousEffects ??= []).push({
								sourceName: v.mentor.name,
								controllerId: p1.playerId,
								timestamp: nextTestTs++,
								expires: 'endOfTurn',
								affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
								backupGrant: { sourceCard: v.mentor, faceIndex: 0, startAbilityIndex: 1 }
							});
						}
						if (!keeperFirst) putPerm(state, p1, v.keeper);
						const p1Pool = putPerm(state, p1, v.pool);
						const p2Orchard = putPerm(state, p2, v.orchard);
						noteLayerInputsChanged(state);

						const ev = evaluatePermanent(state, bear);
						assert.equal(ev.isLand, true);
						assert.equal(ev.losesAllAbilities, true);
						assert.equal(ev.hasSubType('Forest'), true);

						const expectedCols: ManaColor[] = withBackup ? ['W', 'G'] : ['G'];
						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), expectedCols);
						const effAbs = getEffectiveActivatedAbilities(state, p1, bear);
						assert.ok(effAbs.some((a) => a.id === 'granted_mana_g'));
						if (withBackup) {
							assert.ok(effAbs.some((a) => a.id.startsWith('backup_act:')));
						}
						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, p1Pool, true), expectedCols);
						assert.deepEqual(permanentCouldProduceManaTypes(state, p2, p2Orchard, true), expectedCols);

						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'tap_mana',
								instanceId: bear.instanceId,
								preferredColor: 'G'
							}).ok,
							true
						);
						assert.equal(p1.manaPool.G, 1);

						// Untap bear (and tap p1Pool & ashaya) so autoTap must use bear's granted_mana_g to cast {G} spell
						bear.tapped = false;
						p1Pool.tapped = true;
						ashayaPerm.tapped = true;
						p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
						const greenSpell = putInZone(
							state,
							p1,
							'hand',
							synthCard({
								name: 'Verdant Pulse',
								manaCost: '{G}',
								cmc: 1,
								colors: ['G'],
								typeLine: 'Sorcery',
								oracleText: 'You gain 2 life.'
							})
						);
						const castRes = applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: greenSpell.instanceId
						});
						assert.equal(castRes.ok, true, castRes.error ?? '');
						assert.equal(bear.tapped, true);
					}
				}
			}
		});

		it('enforces CR 613.6 + CR 305.6 for Dryad of the Ilysian Grove / Ashaya + Humility / Darksteel Mutation vs SplendorKeeper in both timestamp orders (canonical + cloneRenamed)', () => {
			const realHumility = realCard('Humility');
			const realDryad = realCard('Dryad of the Ilysian Grove');
			const realDryadArbor = realCard('Dryad Arbor');
			const realWastes = realCard('Wastes');
			const realMutation = realCard('Darksteel Mutation');
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				typeLine: 'Enchantment',
				manaCost: '{2}{W}',
				cmc: 3,
				colors: ['W'],
				oracleText: 'Creatures you control lose all abilities except mana abilities.'
			});
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});

			const variants = [
				{
					humility: realHumility,
					dryad: realDryad,
					dryadArbor: realDryadArbor,
					wastes: realWastes,
					mutation: realMutation,
					keeper: baseKeeper,
					ashaya: baseAshaya
				},
				{
					humility: cloneRenamed(realHumility, 'Meekness Field'),
					dryad: cloneRenamed(realDryad, 'Grove Nymph'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Living Copse'),
					wastes: cloneRenamed(realWastes, 'Barren Expanse'),
					mutation: cloneRenamed(realMutation, 'Iron Shell'),
					keeper: cloneRenamed(baseKeeper, 'Sanctuary Seal'),
					ashaya: cloneRenamed(baseAshaya, 'Sylvan Soul')
				}
			];

			for (const v of variants) {
				// 1. Dryad + non-creature Wastes + Humility (both orders) -> Wastes keeps WUBRG + innate C!
				for (const humilityFirst of [true, false]) {
					const { state, p1 } = setupGame();
					if (humilityFirst) putPerm(state, p1, v.humility);
					const dryad = putPerm(state, p1, v.dryad);
					const wastes = putPerm(state, p1, v.wastes);
					if (!humilityFirst) putPerm(state, p1, v.humility);
					noteLayerInputsChanged(state);

					assert.equal(evaluatePermanent(state, dryad).losesAllAbilities, true);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, wastes, true), [
						'W',
						'U',
						'B',
						'R',
						'G',
						'C'
					]);
					const wAbs = getEffectiveActivatedAbilities(state, p1, wastes);
					for (const c of ['w', 'u', 'b', 'r', 'g']) {
						assert.ok(wAbs.some((a) => a.id === `granted_mana_${c}`));
					}
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: wastes.instanceId,
							preferredColor: 'U'
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
				}

				// 2. Dryad + Dryad Arbor + Humility (both orders) -> [] vs SplendorKeeper (both orders) -> WUBRG
				for (const firstOrder of [true, false]) {
					{
						const { state, p1 } = setupGame();
						if (firstOrder) putPerm(state, p1, v.humility);
						putPerm(state, p1, v.dryad);
						const arbor = putPerm(state, p1, v.dryadArbor);
						if (!firstOrder) putPerm(state, p1, v.humility);
						noteLayerInputsChanged(state);

						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, arbor, true), []);
						assert.equal(getEffectiveActivatedAbilities(state, p1, arbor).length, 0);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'tap_mana',
								instanceId: arbor.instanceId,
								preferredColor: 'R'
							}).ok,
							false
						);
					}
					{
						const { state, p1 } = setupGame();
						if (firstOrder) putPerm(state, p1, v.keeper);
						putPerm(state, p1, v.dryad);
						const arbor = putPerm(state, p1, v.dryadArbor);
						if (!firstOrder) putPerm(state, p1, v.keeper);
						noteLayerInputsChanged(state);

						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, arbor, true), [
							'W',
							'U',
							'B',
							'R',
							'G'
						]);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'tap_mana',
								instanceId: arbor.instanceId,
								preferredColor: 'R'
							}).ok,
							true
						);
						assert.equal(p1.manaPool.R, 1);
					}
				}

				// 3. Ashaya + Bear + Humility (both orders) & Darksteel Mutation on Bear + Ashaya (both orders) -> []
				for (const firstOrder of [true, false]) {
					{
						const { state, p1 } = setupGame();
						if (firstOrder) putPerm(state, p1, v.humility);
						putPerm(state, p1, v.ashaya);
						const bear = putPerm(
							state,
							p1,
							synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
						);
						if (!firstOrder) putPerm(state, p1, v.humility);
						noteLayerInputsChanged(state);

						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), []);
						assert.equal(getEffectiveActivatedAbilities(state, p1, bear).length, 0);
					}
					{
						const { state, p1 } = setupGame();
						const bear = putPerm(
							state,
							p1,
							synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
						);
						if (firstOrder) {
							const mut = putPerm(state, p1, v.mutation);
							mut.attachedToId = bear.instanceId;
						}
						putPerm(state, p1, v.ashaya);
						if (!firstOrder) {
							const mut = putPerm(state, p1, v.mutation);
							mut.attachedToId = bear.instanceId;
						}
						noteLayerInputsChanged(state);

						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), []);
						assert.equal(getEffectiveActivatedAbilities(state, p1, bear).length, 0);
					}
				}
			}
		});

		it('enforces CR 613.6 + CR 305.6 + CR 305.7 + CR 613.8 for Magus of the Moon, Blood Moon + Urborg, Song of the Dryads, Imprisoned in the Moon, and Dryad Arbor under Humility vs SplendorKeeper (canonical + cloneRenamed)', () => {
			const realHumility = realCard('Humility');
			const realBloodMoon = realCard('Blood Moon');
			const realUrborg = realCard('Urborg, Tomb of Yawgmoth');
			const realDryadArbor = realCard('Dryad Arbor');
			const realCommandTower = realCard('Command Tower');
			const realSong = realCard('Song of the Dryads');
			const realImprisoned = realCard('Imprisoned in the Moon');
			const baseMagus = synthCard({
				name: 'Magus of the Moon',
				manaCost: '{2}{R}',
				cmc: 3,
				colors: ['R'],
				typeLine: 'Creature — Human Wizard',
				power: '2',
				toughness: '2',
				oracleText: 'Nonbasic lands are Mountains.'
			});
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				typeLine: 'Enchantment',
				manaCost: '{2}{W}',
				cmc: 3,
				colors: ['W'],
				oracleText: 'Creatures you control lose all abilities except mana abilities.'
			});

			const variants = [
				{
					humility: realHumility,
					bloodMoon: realBloodMoon,
					urborg: realUrborg,
					dryadArbor: realDryadArbor,
					commandTower: realCommandTower,
					song: realSong,
					imprisoned: realImprisoned,
					magus: baseMagus,
					keeper: baseKeeper
				},
				{
					humility: cloneRenamed(realHumility, 'Meekness Field'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Lunar Orb'),
					urborg: cloneRenamed(realUrborg, 'Mire Tomb'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Living Copse'),
					commandTower: cloneRenamed(realCommandTower, 'Command Spire'),
					song: cloneRenamed(realSong, 'Grove Chant'),
					imprisoned: cloneRenamed(realImprisoned, 'Lunar Seal'),
					magus: cloneRenamed(baseMagus, 'Lunar Pyromancer'),
					keeper: cloneRenamed(baseKeeper, 'Sanctuary Seal')
				}
			];

			const forestCard = synthCard({
				name: 'Test Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			});

			for (const v of variants) {
				// 1. Magus of the Moon + Command Tower + Dryad Arbor + Humility (both orders) vs SplendorKeeper
				for (const humilityFirst of [true, false]) {
					const { state, p1 } = setupGame();
					if (humilityFirst) putPerm(state, p1, v.humility);
					putPerm(state, p1, v.magus);
					const tower = putPerm(state, p1, v.commandTower);
					const arbor = putPerm(state, p1, v.dryadArbor);
					if (!humilityFirst) putPerm(state, p1, v.humility);
					noteLayerInputsChanged(state);

					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, tower, true), ['R']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, arbor, true), []);
				}
				{
					const { state, p1 } = setupGame();
					putPerm(state, p1, v.magus);
					const tower = putPerm(state, p1, v.commandTower);
					const arbor = putPerm(state, p1, v.dryadArbor);
					putPerm(state, p1, v.keeper);
					noteLayerInputsChanged(state);

					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, tower, true), ['R']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, arbor, true), ['R']);
					const arborAbs = getEffectiveActivatedAbilities(state, p1, arbor);
					assert.ok(arborAbs.some((a) => a.id === 'granted_mana_r'));
					assert.ok(!arborAbs.some((a) => a.id === 'granted_mana_g'));
				}

				// 2. Blood Moon + Urborg + Forest: Urborg grants nothing (CR 613.8)
				{
					const { state, p1 } = setupGame();
					putPerm(state, p1, v.bloodMoon);
					putPerm(state, p1, v.urborg);
					const forest = putPerm(state, p1, forestCard);
					noteLayerInputsChanged(state);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, forest, true), ['G']);
				}

				// 3. Song of the Dryads / Imprisoned in the Moon on Bear + Humility: Bear is non-creature Land
				for (const auraCard of [v.song, v.imprisoned]) {
					const { state, p1 } = setupGame();
					const bear = putPerm(
						state,
						p1,
						synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					const aura = putPerm(state, p1, auraCard);
					aura.attachedToId = bear.instanceId;
					putPerm(state, p1, v.humility);
					noteLayerInputsChanged(state);

					const ev = evaluatePermanent(state, bear);
					assert.equal(ev.isLand, true);
					assert.equal(ev.isCreature, false);
					const tapRes = applyGameAction(state, p1.playerId, {
						type: 'tap_mana',
						instanceId: bear.instanceId
					});
					assert.equal(tapRes.ok, true, tapRes.error ?? '');
				}

				// 4. Dryad Arbor alone under Humility -> [] vs SplendorKeeper -> ['G']
				{
					const { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					putPerm(state, p1, v.humility);
					noteLayerInputsChanged(state);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, arbor, true), []);
				}
				{
					const { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					putPerm(state, p1, v.keeper);
					noteLayerInputsChanged(state);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, arbor, true), ['G']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: arbor.instanceId,
							preferredColor: 'G'
						}).ok,
						true
					);
					assert.equal(p1.manaPool.G, 1);
				}
			}
		});

		it('enforces oncePerGame (usedOncePerGameAbilityIds) and duringOpponentsTurn across tap_mana, activate_ability, autoTap, paused prompts, merged_, backup_act:, granted:, and quoted_eot: (canonical + cloneRenamed)', () => {
			const baseTopPerGame = synthCard({
				name: 'Relic Siphon',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Construct',
				power: '2',
				toughness: '2',
				oracleText: '{T}: Add {U}. Activate only once.'
			});
			const baseBotPerGame = synthCard({
				name: 'Sanctum Sprout',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {W}. Activate only once each game.'
			});
			const baseDiscardOnce = synthCard({
				name: 'Tome Conduit',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{T}, Discard a card: Add {U}. Activate only once.'
			});
			const baseBackupOnce = synthCard({
				name: 'Once Mentor',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Wizard',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\n{T}: Add {U}. Activate only once.'
			});
			const baseAuraOnce = synthCard({
				name: 'Single Boon',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature has "{T}: Add {G}. Activate only once."'
			});
			const baseOppTurnMana = synthCard({
				name: 'Moonlit Spire',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText: "{T}: Add {U}. Activate only during an opponent's turn."
			});

			const variants = [
				{
					topPerGame: baseTopPerGame,
					botPerGame: baseBotPerGame,
					discardOnce: baseDiscardOnce,
					backupOnce: baseBackupOnce,
					auraOnce: baseAuraOnce,
					oppTurnMana: baseOppTurnMana
				},
				{
					topPerGame: cloneRenamed(baseTopPerGame, 'Aether Siphon'),
					botPerGame: cloneRenamed(baseBotPerGame, 'Grove Tender'),
					discardOnce: cloneRenamed(baseDiscardOnce, 'Archive Engine'),
					backupOnce: cloneRenamed(baseBackupOnce, 'Chrono Preceptor'),
					auraOnce: cloneRenamed(baseAuraOnce, 'Fleeting Grace'),
					oppTurnMana: cloneRenamed(baseOppTurnMana, 'Dusk Beacon')
				}
			];

			for (const v of variants) {
				// 1. Mutated merged_ [Top PerGame, Bot PerGame]: tap_mana + activate_ability + turn advance isolation
				{
					const { state, p1 } = setupGame();
					const mut = putPerm(state, p1, v.topPerGame);
					mut.mergedComponents = [v.topPerGame, v.botPerGame];
					noteLayerInputsChanged(state);

					const abs = getEffectiveActivatedAbilities(state, p1, mut);
					const topAb = abs.find((a) => !a.id.startsWith('backup_act:merged_'))!;
					const botAb = abs.find((a) => a.id.startsWith('backup_act:merged_1:'))!;
					assert.ok(topAb && botAb);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: mut.instanceId,
							abilityId: topAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
					assert.deepEqual(mut.usedOncePerGameAbilityIds, [topAb.id]);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, mut, true), ['W']);

					// Untap and verify topAb cannot be re-activated via tap_mana or activate_ability
					mut.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: mut.instanceId,
							abilityId: topAb.id
						}).ok,
						false
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: mut.instanceId,
							abilityId: topAb.id
						}).ok,
						false
					);

					// Advance to next turn and verify topAb is STILL blocked while botAb works
					passUntilPhase(state, 'main1', 1);
					passUntilPhase(state, 'main1', 0);
					mut.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: mut.instanceId,
							abilityId: topAb.id
						}).ok,
						false
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: mut.instanceId,
							abilityId: botAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.W, 1);
					assert.deepEqual(mut.usedOncePerGameAbilityIds, [topAb.id, botAb.id]);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, mut, true), []);
				}

				// 2. Innate oncePerGame via autoTap cast_spell
				{
					const { state, p1 } = setupGame();
					const dork = putPerm(state, p1, v.topPerGame);
					const opt1 = putInZone(
						state,
						p1,
						'hand',
						synthCard({
							name: 'Opt 1',
							manaCost: '{U}',
							cmc: 1,
							colors: ['U'],
							typeLine: 'Sorcery',
							oracleText: 'Scry 1.'
						})
					);
					const opt2 = putInZone(
						state,
						p1,
						'hand',
						synthCard({
							name: 'Opt 2',
							manaCost: '{U}',
							cmc: 1,
							colors: ['U'],
							typeLine: 'Sorcery',
							oracleText: 'Scry 1.'
						})
					);
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: opt1.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(dork.usedOncePerGameAbilityIds?.length, 1);

					dork.tapped = false;
					const secondCast = applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: opt2.instanceId
					});
					assert.equal(secondCast.ok, false);
				}

				// 3. Interactive tap_mana pause (multi-part cost discard) -> cancel vs complete
				{
					const { state, p1 } = setupGame();
					const tome = putPerm(state, p1, v.discardOnce);
					const c1 = putInZone(
						state,
						p1,
						'hand',
						synthCard({ name: 'Discard Foil 1', typeLine: 'Artifact' })
					);
					const c2 = putInZone(
						state,
						p1,
						'hand',
						synthCard({ name: 'Discard Foil 2', typeLine: 'Artifact' })
					);
					noteLayerInputsChanged(state);

					const ab = findAbility(state, p1, tome);
					const tapRes = applyGameAction(state, p1.playerId, {
						type: 'tap_mana',
						instanceId: tome.instanceId,
						abilityId: ab.id
					});
					assert.equal(tapRes.ok, true, tapRes.error ?? '');
					assert.equal(tome.usedOncePerGameAbilityIds, undefined);
					assert.equal(state.pendingPrompts[0]?.kind, 'cost_choice');

					// Cancel before finishing cost -> usedOncePerGameAbilityIds stays undefined
					const cancelRes = applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: state.pendingPrompts[0]!.id,
						cancel: true
					});
					assert.equal(cancelRes.ok, true, cancelRes.error ?? '');
					assert.equal(tome.usedOncePerGameAbilityIds, undefined);
					assert.equal(tome.tapped, false);

					// Re-trigger and complete discard cost payment -> records usedOncePerGameAbilityIds
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: tome.instanceId,
							abilityId: ab.id
						}).ok,
						true
					);
					assert.equal(state.pendingPrompts[0]?.kind, 'cost_choice');
					answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [c1.instanceId] });
					assert.equal(p1.manaPool.U, 1);
					assert.deepEqual(tome.usedOncePerGameAbilityIds, [ab.id]);
					assert.equal(p1.hand.length, 1);
					assert.equal(p1.hand[0]?.instanceId, c2.instanceId);

					tome.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: tome.instanceId,
							abilityId: ab.id
						}).ok,
						false
					);
				}

				// 4. backup_act:, granted:, quoted_eot: oncePerGame & duringOpponentsTurn
				{
					const { state, p1, p2 } = setupGame();
					const bear = putPerm(
						state,
						p1,
						synthCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					const aura = putPerm(state, p1, v.auraOnce);
					aura.attachedToId = bear.instanceId;
					const spire = putPerm(state, p1, v.oppTurnMana);
					(state.timedContinuousEffects ??= []).push(
						{
							sourceName: v.backupOnce.name,
							controllerId: p1.playerId,
							timestamp: nextTestTs++,
							expires: 'endOfTurn',
							affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
							backupGrant: { sourceCard: v.backupOnce, faceIndex: 0, startAbilityIndex: 1 }
						},
						{
							sourceName: 'Quoted Once',
							controllerId: p1.playerId,
							timestamp: nextTestTs++,
							expires: 'endOfTurn',
							affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
							layer6: { grantedAbilityTexts: ['{T}: Add {R}. Activate only once.'] }
						}
					);
					noteLayerInputsChanged(state);

					const bearAbs = getEffectiveActivatedAbilities(state, p1, bear);
					const backupAb = bearAbs.find((a) => a.id.startsWith('backup_act:'))!;
					const grantedAb = bearAbs.find((a) => a.id.startsWith('granted:'))!;
					const quotedAb = bearAbs.find((a) => a.id.startsWith('quoted_eot:'))!;
					assert.ok(backupAb && grantedAb && quotedAb);

					for (const ab of [backupAb, grantedAb, quotedAb]) {
						bear.tapped = false;
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'tap_mana',
								instanceId: bear.instanceId,
								abilityId: ab.id
							}).ok,
							true
						);
						assert.ok(bear.usedOncePerGameAbilityIds?.includes(ab.id));
						bear.tapped = false;
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'tap_mana',
								instanceId: bear.instanceId,
								abilityId: ab.id
							}).ok,
							false
						);
					}

					// duringOpponentsTurn: blocked on p1's turn (tap_mana & autoTap), allowed on p2's turn!
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, spire, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: spire.instanceId
						}).ok,
						false
					);
					const instantU = putInZone(
						state,
						p1,
						'hand',
						synthCard({
							name: 'Flash Opt',
							manaCost: '{U}',
							cmc: 1,
							colors: ['U'],
							typeLine: 'Instant',
							oracleText: 'Scry 1.'
						})
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: instantU.instanceId
						}).ok,
						false
					);

					passUntilPhase(state, 'main1', 1);
					// Give p1 priority on p2's turn
					state.priorityPlayerIndex = 0;
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, spire, true), ['U']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: instantU.instanceId
						}).ok,
						true
					);
					assert.equal(spire.tapped, true);
					void p2;
				}
			}
		});

		it('enforces CR 613.6 for attached Layer 6 removeAllAbilities (Darksteel Mutation / Imprisoned in the Moon) vs CR 305.7 (Song of the Dryads) on Ashaya, Magus of the Moon, Dryad, Urborg, and Bear via applyGameAction (canonical + cloneRenamed)', () => {
			const realMutation = realCard('Darksteel Mutation');
			const realImprisoned = realCard('Imprisoned in the Moon');
			const realSong = realCard('Song of the Dryads');
			const realDryad = realCard('Dryad of the Ilysian Grove');
			const realUrborg = realCard('Urborg, Tomb of Yawgmoth');
			const realHumility = realCard('Humility');
			const realTower = realCard('Command Tower');
			const realWastes = realCard('Wastes');
			const realForest = realCard('Forest');

			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseMagus = synthCard({
				name: 'Magus of the Moon',
				manaCost: '{2}{R}',
				cmc: 3,
				colors: ['R'],
				typeLine: 'Creature — Human Wizard',
				power: '2',
				toughness: '2',
				oracleText: 'Nonbasic lands are Mountains.'
			});
			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});

			const variants = [
				{
					mutation: realMutation,
					imprisoned: realImprisoned,
					song: realSong,
					dryad: realDryad,
					urborg: realUrborg,
					humility: realHumility,
					tower: realTower,
					wastes: realWastes,
					forest: realForest,
					ashaya: baseAshaya,
					magus: baseMagus,
					bear: baseBear
				},
				{
					mutation: cloneRenamed(realMutation, 'Carapace Curse'),
					imprisoned: cloneRenamed(realImprisoned, 'Lunar Binding'),
					song: cloneRenamed(realSong, 'Sylvan Seal'),
					dryad: cloneRenamed(realDryad, 'Grove Nymph'),
					urborg: cloneRenamed(realUrborg, 'Mire Basin'),
					humility: cloneRenamed(realHumility, 'Meekness Field'),
					tower: cloneRenamed(realTower, 'Relic Spire'),
					wastes: cloneRenamed(realWastes, 'Barren Expanse'),
					forest: cloneRenamed(realForest, 'Mossy Glade'),
					ashaya: cloneRenamed(baseAshaya, 'Sylvan Soul'),
					magus: cloneRenamed(baseMagus, 'Cinder Sage'),
					bear: cloneRenamed(baseBear, 'Timber Bruin')
				}
			];

			for (const v of variants) {
				// 1. Darksteel Mutation cast (applyGameAction) onto Ashaya with Grizzly Bears on board
				{
					const { state, p1 } = setupGame();
					const ashaya = putPerm(state, p1, v.ashaya);
					const bear = putPerm(state, p1, v.bear);
					const mutHand = putInZone(state, p1, 'hand', v.mutation);
					giveMana(p1, { W: 1, C: 1 });
					noteLayerInputsChanged(state);

					const castMut = applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: mutHand.instanceId,
						targets: [permTarget(ashaya)]
					});
					assert.equal(castMut.ok, true, castMut.error ?? '');
					resolveAllStack(state);

					const evAshaya = evaluatePermanent(state, ashaya);
					assert.equal(evAshaya.isArtifact, true);
					assert.equal(evAshaya.isCreature, true);
					assert.equal(evAshaya.isLand, true);
					assert.equal(evAshaya.hasSubType('Forest'), true);
					assert.equal(evAshaya.power, 0);
					assert.equal(evAshaya.toughness, 1);
					assert.ok(evAshaya.activeKeywords.includes('Indestructible'));
					assert.equal(evAshaya.losesAllAbilities, true);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, ashaya, true), []);

					const evBear = evaluatePermanent(state, bear);
					assert.equal(evBear.isLand, true);
					assert.equal(evBear.hasSubType('Forest'), true);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), ['G']);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bear.instanceId
						}).ok,
						true
					);
					assert.equal(p1.manaPool.G, 1);

					// Untap bear and cast {G} spell via autoTap using bear's Forest mana
					bear.tapped = false;
					ashaya.tapped = true;
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					const gSpell = putInZone(
						state,
						p1,
						'hand',
						synthCard({
							name: 'Growth Note',
							manaCost: '{G}',
							cmc: 1,
							colors: ['G'],
							typeLine: 'Sorcery',
							oracleText: 'You gain 1 life.'
						})
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: gSpell.instanceId
						}).ok,
						true
					);
					assert.equal(bear.tapped, true);
				}

				// 2a. Darksteel Mutation cast (applyGameAction) onto Magus of the Moon + Command Tower
				{
					const { state, p1 } = setupGame();
					const magus = putPerm(state, p1, v.magus);
					const tower = putPerm(state, p1, v.tower);
					const mutHand = putInZone(state, p1, 'hand', v.mutation);
					giveMana(p1, { W: 1, C: 1 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: mutHand.instanceId,
							targets: [permTarget(magus)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const evMagus = evaluatePermanent(state, magus);
					assert.equal(evMagus.effectiveTypeLine, 'Artifact Creature — Insect');
					assert.equal(evMagus.power, 0);
					assert.equal(evMagus.toughness, 1);
					assert.ok(evMagus.activeKeywords.includes('Indestructible'));
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, magus, true), []);

					const evTower = evaluatePermanent(state, tower);
					assert.equal(evTower.effectiveTypeLine, 'Land — Mountain');
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, tower, true), ['R']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: tower.instanceId
						}).ok,
						true
					);
					assert.equal(p1.manaPool.R, 1);
				}

				// 2b. Imprisoned in the Moon cast (applyGameAction) onto Magus of the Moon + Command Tower
				{
					const { state, p1 } = setupGame();
					const magus = putPerm(state, p1, v.magus);
					const tower = putPerm(state, p1, v.tower);
					const impHand = putInZone(state, p1, 'hand', v.imprisoned);
					giveMana(p1, { U: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: impHand.instanceId,
							targets: [permTarget(magus)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const evTower = evaluatePermanent(state, tower);
					assert.equal(evTower.effectiveTypeLine, 'Land — Mountain');
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, tower, true), ['R']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: tower.instanceId
						}).ok,
						true
					);
					assert.equal(p1.manaPool.R, 1);

					const evMagus = evaluatePermanent(state, magus);
					assert.equal(evMagus.effectiveTypeLine, 'Land — Mountain');
					assert.equal(evMagus.isCreature, false);
					assert.deepEqual(evMagus.colors, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, magus, true), ['C']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: magus.instanceId
						}).ok,
						true
					);
					assert.equal(p1.manaPool.C, 1);
				}

				// 3. Darksteel Mutation cast (applyGameAction) onto Dryad of the Ilysian Grove + Wastes
				{
					const { state, p1 } = setupGame();
					const dryad = putPerm(state, p1, v.dryad);
					const wastes = putPerm(state, p1, v.wastes);
					const mutHand = putInZone(state, p1, 'hand', v.mutation);
					giveMana(p1, { W: 1, C: 1 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: mutHand.instanceId,
							targets: [permTarget(dryad)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const evDryad = evaluatePermanent(state, dryad);
					assert.equal(evDryad.effectiveTypeLine, 'Artifact Creature — Insect');
					assert.equal(evDryad.power, 0);
					assert.equal(evDryad.toughness, 1);
					assert.ok(evDryad.activeKeywords.includes('Indestructible'));
					assert.equal(evDryad.losesAllAbilities, true);

					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, wastes, true), [
						'W',
						'U',
						'B',
						'R',
						'G',
						'C'
					]);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: wastes.instanceId,
							preferredColor: 'U'
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
				}

				// 4a. Imprisoned in the Moon cast onto Urborg, Tomb of Yawgmoth (+ Forest)
				{
					const { state, p1 } = setupGame();
					const urborg = putPerm(state, p1, v.urborg);
					const forest = putPerm(state, p1, v.forest);
					const impHand = putInZone(state, p1, 'hand', v.imprisoned);
					giveMana(p1, { U: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: impHand.instanceId,
							targets: [permTarget(urborg)]
						}).ok,
						true
					);
					resolveAllStack(state);

					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, forest, true), ['B', 'G']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, urborg, true), ['C']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: urborg.instanceId
						}).ok,
						true
					);
					assert.equal(p1.manaPool.C, 1);
				}

				// 4b. Imprisoned in the Moon on Bear + Humility (both timestamp orders)
				for (const humilityFirst of [true, false]) {
					const { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					if (humilityFirst) putPerm(state, p1, v.humility);
					const impHand = putInZone(state, p1, 'hand', v.imprisoned);
					giveMana(p1, { U: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: impHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);
					if (!humilityFirst) {
						putPerm(state, p1, v.humility);
						noteLayerInputsChanged(state);
					}

					const evBear = evaluatePermanent(state, bear);
					assert.equal(evBear.isLand, true);
					assert.equal(evBear.isCreature, false);
					assert.deepEqual(evBear.colors, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), ['C']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bear.instanceId
						}).ok,
						true
					);
					assert.equal(p1.manaPool.C, 1);
				}

				// 5a. Darksteel Mutation then Song of the Dryads via applyGameAction onto Grizzly Bears (CR 704.5m)
				{
					const { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mutHand = putInZone(state, p1, 'hand', v.mutation);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { W: 1, G: 1, C: 3 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: mutHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);

					// Darksteel Mutation (Enchant creature) goes to graveyard via CR 704.5m SBA
					assert.ok(p1.graveyard.some((g) => g.instanceId === mutHand.instanceId));
					assert.ok(!p1.battlefield.some((b) => b.instanceId === mutHand.instanceId));

					const evBear = evaluatePermanent(state, bear);
					assert.equal(evBear.effectiveTypeLine, 'Land — Forest');
					assert.deepEqual(evBear.colors, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), ['G']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bear.instanceId
						}).ok,
						true
					);
					assert.equal(p1.manaPool.G, 1);
				}

				// 5b. Contrast: Song of the Dryads (CR 305.7, Layer 4) onto Ashaya / Magus / Dryad DOES strip Layer 4 abilities
				{
					const { state, p1 } = setupGame();
					const ashaya = putPerm(state, p1, v.ashaya);
					const bear = putPerm(state, p1, v.bear);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(ashaya)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(evaluatePermanent(state, bear).hasSubType('Forest'), false);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bear, true), []);
				}
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const magus = putPerm(state, p1, v.magus);
					const tower = putPerm(state, p1, v.tower);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(magus)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(evaluatePermanent(state, tower).hasSubType('Mountain'), false);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, tower, true), [
						'W',
						'U',
						'B',
						'R',
						'G'
					]);
				}
				{
					const { state, p1 } = setupGame();
					const dryad = putPerm(state, p1, v.dryad);
					const wastes = putPerm(state, p1, v.wastes);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(dryad)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, wastes, true), ['C']);
				}
			}
		});

		it('isolates CR 305.7 (!fromLayer6) from Layer 6 grants, handles Layer 4 overwrites, and preserves surviving quoted_eot:/backup_act:/Undying/Persist triggers & LKI (canonical + cloneRenamed + JSON round-trip)', () => {
			const realImprisoned = realCard('Imprisoned in the Moon');
			const realSong = realCard('Song of the Dryads');
			const realBloodMoon = realCard('Blood Moon');
			const realAbundant = realCard('Abundant Growth');
			const realOvergrowth = realCard('Overgrowth');
			const realDryadArbor = realCard('Dryad Arbor');
			const realUrborg = realCard('Urborg, Tomb of Yawgmoth');
			const realDryadGrove = realCard('Dryad of the Ilysian Grove');
			const realHumility = realCard('Humility');
			const realTower = realCard('Command Tower');

			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const baseBlessing = synthCard({
				name: "Serra's Blessing",
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control have vigilance.'
			});
			const baseSpreadingSeas = synthCard({
				name: 'Spreading Seas',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant land\nEnchanted land is an Island.'
			});
			const baseHarbinger = synthCard({
				name: 'Harbinger of the Seas',
				manaCost: '{1}{U}{U}',
				cmc: 3,
				colors: ['U'],
				typeLine: 'Creature — Merfolk Wizard',
				power: '2',
				toughness: '2',
				oracleText: 'Nonbasic lands are Islands.'
			});
			const baseSongPlains = synthCard({
				name: 'Song of the Plains',
				manaCost: '{2}{W}',
				cmc: 3,
				colors: ['W'],
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant permanent\nEnchanted permanent is a Plains land.'
			});
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				manaCost: '{2}{W}',
				cmc: 3,
				colors: ['W'],
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control lose all abilities except mana abilities.'
			});
			const baseQuotedMana = synthCard({
				name: 'Tidal Infusion',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains "{T}: Add {U}." until end of turn.'
			});
			const baseQuotedVig = synthCard({
				name: 'Sentinel Infusion',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains vigilance until end of turn.'
			});
			const baseQuotedTapTrig = synthCard({
				name: 'Lifetap Infusion',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				typeLine: 'Instant',
				oracleText:
					'Until end of turn, target creature gains "Whenever this creature becomes tapped, you gain 1 life."'
			});
			const baseQuotedDiesTrig = synthCard({
				name: 'Last Words Infusion',
				manaCost: '{B}',
				cmc: 1,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText:
					'Until end of turn, target creature gains "When this creature dies, draw a card."'
			});
			const baseBackupMentor = synthCard({
				name: 'Tidal Backup Mentor',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1',
				oracleText:
					'Backup 1\nVigilance\n{T}: Add {U}.\nWhenever this creature becomes tapped, you gain 2 life.'
			});
			const baseGrantUndying = synthCard({
				name: 'Undying Spark',
				manaCost: '{B}',
				cmc: 1,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains undying until end of turn.'
			});
			const baseGrantPersist = synthCard({
				name: 'Persist Chorus',
				manaCost: '{2}{B}',
				cmc: 3,
				colors: ['B'],
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control have persist.'
			});
			const baseDestroy = synthCard({
				name: 'Murderous Verdict',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			});
			const baseForestGiant = synthCard({
				name: 'Mossy Giant',
				manaCost: '{2}{G}',
				cmc: 3,
				colors: ['G'],
				typeLine: 'Land Creature — Forest Giant',
				power: '2',
				toughness: '2'
			});
			const baseMutateTop = synthCard({
				name: 'Apex Landbeast',
				manaCost: '{2}{G}',
				cmc: 3,
				colors: ['G'],
				typeLine: 'Land Creature — Forest Beast',
				power: '3',
				toughness: '3',
				oracleText: '{T}: Add {W}.\nWhenever this creature becomes tapped, you gain 1 life.'
			});
			const baseMutateBot = synthCard({
				name: 'Benevolent Sprout',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Elk',
				power: '2',
				toughness: '2',
				oracleText: '{T}: Add {U}.\nWhenever this creature becomes tapped, you gain 2 life.'
			});

			const variants = [
				{
					imprisoned: realImprisoned,
					song: realSong,
					bloodMoon: realBloodMoon,
					abundant: realAbundant,
					overgrowth: realOvergrowth,
					dryadArbor: realDryadArbor,
					urborg: realUrborg,
					dryadGrove: realDryadGrove,
					humility: realHumility,
					tower: realTower,
					bear: baseBear,
					blessing: baseBlessing,
					spreadingSeas: baseSpreadingSeas,
					harbinger: baseHarbinger,
					songPlains: baseSongPlains,
					keeper: baseKeeper,
					quotedMana: baseQuotedMana,
					quotedVig: baseQuotedVig,
					quotedTapTrig: baseQuotedTapTrig,
					quotedDiesTrig: baseQuotedDiesTrig,
					backupMentor: baseBackupMentor,
					grantUndying: baseGrantUndying,
					grantPersist: baseGrantPersist,
					destroy: baseDestroy,
					forestGiant: baseForestGiant,
					mutateTop: baseMutateTop,
					mutateBot: baseMutateBot
				},
				{
					imprisoned: cloneRenamed(realImprisoned, 'Lunar Binding'),
					song: cloneRenamed(realSong, 'Sylvan Seal'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Eclipse'),
					abundant: cloneRenamed(realAbundant, 'Verdant Surplus'),
					overgrowth: cloneRenamed(realOvergrowth, 'Wild Flourish'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Living Glade'),
					urborg: cloneRenamed(realUrborg, 'Mire Basin'),
					dryadGrove: cloneRenamed(realDryadGrove, 'Grove Nymph'),
					humility: cloneRenamed(realHumility, 'Meekness Field'),
					tower: cloneRenamed(realTower, 'Relic Spire'),
					bear: cloneRenamed(baseBear, 'Timber Bruin'),
					blessing: cloneRenamed(baseBlessing, 'Vigil Ward'),
					spreadingSeas: cloneRenamed(baseSpreadingSeas, 'Tidal Veil'),
					harbinger: cloneRenamed(baseHarbinger, 'Tide Herald'),
					songPlains: cloneRenamed(baseSongPlains, 'Meadow Seal'),
					keeper: cloneRenamed(baseKeeper, 'Sanctuary Seal'),
					quotedMana: cloneRenamed(baseQuotedMana, 'Azure Boon'),
					quotedVig: cloneRenamed(baseQuotedVig, 'Watchful Boon'),
					quotedTapTrig: cloneRenamed(baseQuotedTapTrig, 'Mending Boon'),
					quotedDiesTrig: cloneRenamed(baseQuotedDiesTrig, 'Epitaph Boon'),
					backupMentor: cloneRenamed(baseBackupMentor, 'Stream Preceptor'),
					grantUndying: cloneRenamed(baseGrantUndying, 'Rebirth Spark'),
					grantPersist: cloneRenamed(baseGrantPersist, 'Enduring Chorus'),
					destroy: cloneRenamed(baseDestroy, 'Fatal Decree'),
					forestGiant: cloneRenamed(baseForestGiant, 'Crag Colossus'),
					mutateTop: cloneRenamed(baseMutateTop, 'Summit Chimera'),
					mutateBot: cloneRenamed(baseMutateBot, 'Creek Elk')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;

			for (const v of variants) {
				// 1. Imprisoned in the Moon (ts1) + Song of the Dryads (ts2) on Bear -> ['C']
				{
					const { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const impHand = putInZone(state, p1, 'hand', v.imprisoned);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { U: 1, G: 1, C: 4 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: impHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtBear = findIn(rt, 0, bear.instanceId);
					const evBear = evaluatePermanent(rt, rtBear);
					assert.equal(evBear.effectiveTypeLine, 'Land — Forest');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtBear, true), ['C']);
					const manaGItem = evBear.breakdown.items.find((it) => it.canonicalKey === 'mana_g');
					assert.ok(manaGItem && manaGItem.removed && manaGItem.removedBy.includes(v.imprisoned.name));

					rt.players[0].manaPool.C = 0;
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'tap_mana',
							instanceId: rtBear.instanceId
						}).ok,
						true
					);
					assert.equal(rt.players[0].manaPool.C, 1);
				}

				// 2. Imprisoned in the Moon + Blood Moon on Command Tower (both timestamp orders) -> ['C']
				for (const impFirst of [true, false]) {
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					if (!impFirst) {
						const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
						giveMana(p1, { R: 1, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: bmHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					}
					const impHand = putInZone(state, p1, 'hand', v.imprisoned);
					giveMana(p1, { U: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: impHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);
					if (impFirst) {
						const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
						giveMana(p1, { R: 1, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: bmHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					const evTower = evaluatePermanent(rt, rtTower);
					assert.equal(evTower.effectiveTypeLine, impFirst ? 'Land — Mountain' : 'Land');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['C']);
					rt.players[0].manaPool.C = 0;
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'tap_mana',
							instanceId: rtTower.instanceId
						}).ok,
						true
					);
					assert.equal(rt.players[0].manaPool.C, 1);
				}

				// 3. Abundant Growth (ts1) on Command Tower + Blood Moon (ts2) -> ['W','U','B','R','G'] & tap_mana {U}
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					const abHand = putInZone(state, p1, 'hand', v.abundant);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { G: 1, R: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: abHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					assert.equal(evaluatePermanent(rt, rtTower).effectiveTypeLine, 'Land — Mountain');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), [
						'W',
						'U',
						'B',
						'R',
						'G'
					]);
					rt.players[0].manaPool.U = 0;
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'tap_mana',
							instanceId: rtTower.instanceId,
							preferredColor: 'U'
						}).ok,
						true
					);
					assert.equal(rt.players[0].manaPool.U, 1);
				}

				// 4. Serra's Blessing (ts1) + Dryad Arbor + Blood Moon (ts2) -> retains Vigilance & attacks untapped
				{
					const { state, p1, p2 } = setupGame();
					const blessingHand = putInZone(state, p1, 'hand', v.blessing);
					const arbor = putPerm(state, p1, v.dryadArbor);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { W: 1, R: 1, C: 3 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: blessingHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtArbor = findIn(rt, 0, arbor.instanceId);
					const evArbor = evaluatePermanent(rt, rtArbor);
					assert.equal(evArbor.effectiveTypeLine, 'Land Creature — Mountain Dryad');
					assert.equal(hasKeyword(rtArbor, 'vigilance', rt), true);
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtArbor, true), ['R']);

					passUntilPhase(rt, 'declare_attackers', 0);
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: rtArbor.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					assert.equal(rtArbor.tapped, false);
				}

				// 5. quoted_eot: & backup_act: mana, keyword, tap-trigger & dies-LKI under Blood Moon, mutationBefore, humilityBefore, & humilityAfter
				const realMutation = realCard('Darksteel Mutation');
				const mutationCard =
					variants[0].humility === v.humility
						? realMutation
						: cloneRenamed(realMutation, 'Carapace Curse');
				for (const regime of ['bloodMoon', 'mutationBefore', 'humilityBefore', 'humilityAfter'] as const) {
					const { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					putInZone(state, p1, 'library', v.bear);
					putInZone(state, p1, 'library', v.bear);
					if (regime === 'humilityBefore') {
						const humHand = putInZone(state, p1, 'hand', v.humility);
						giveMana(p1, { W: 2, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: humHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					} else if (regime === 'mutationBefore') {
						const mutHand = putInZone(state, p1, 'hand', mutationCard);
						giveMana(p1, { W: 1, C: 1 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: mutHand.instanceId,
								targets: [permTarget(arbor)]
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					// Cast quoted_eot: mana, vigilance, tap-trigger, and dies-trigger
					const qMana = putInZone(state, p1, 'hand', v.quotedMana);
					const qVig = putInZone(state, p1, 'hand', v.quotedVig);
					const qTap = putInZone(state, p1, 'hand', v.quotedTapTrig);
					const qDies = putInZone(state, p1, 'hand', v.quotedDiesTrig);
					giveMana(p1, { U: 1, W: 2, B: 1 });
					for (const spell of [qMana, qVig, qTap, qDies]) {
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: spell.instanceId,
								targets: [permTarget(arbor)]
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					// Cast Backup creature targeting Dryad Arbor (under humilityBefore, Humility removes Backup 1 ETB on Mentor!)
					const bkHand = putInZone(state, p1, 'hand', v.backupMentor);
					giveMana(p1, { U: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bkHand.instanceId
						}).ok,
						true
					);
					for (let guard = 0; guard < 50; guard++) {
						if (state.stack.length === 0 && state.pendingPrompts.length === 0) break;
						if (state.pendingPrompts.length > 0) {
							answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [arbor.instanceId] });
						} else {
							const pr = state.players[state.priorityPlayerIndex];
							assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
						}
					}

					if (regime === 'bloodMoon') {
						const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
						giveMana(p1, { R: 1, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: bmHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					} else if (regime === 'humilityAfter') {
						const humHand = putInZone(state, p1, 'hand', v.humility);
						giveMana(p1, { W: 2, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: humHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					const rt = roundTrip(state);
					const rtArbor = findIn(rt, 0, arbor.instanceId);
					const shouldQuotedSurvive = regime !== 'humilityAfter';
					const shouldBackupSurvive = regime === 'bloodMoon' || regime === 'mutationBefore';

					assert.equal(hasKeyword(rtArbor, 'vigilance', rt), shouldQuotedSurvive);
					const effAbs = getEffectiveActivatedAbilities(rt, rt.players[0], rtArbor);
					const quotedAb = effAbs.find((a) => a.id.startsWith('quoted_eot:'));
					const backupAb = effAbs.find((a) => a.id.startsWith('backup_act:'));
					if (shouldQuotedSurvive) {
						assert.ok(quotedAb, `expected surviving quoted_eot: mana ability under ${regime}`);
						if (shouldBackupSurvive) {
							assert.ok(backupAb, `expected surviving backup_act: mana ability under ${regime}`);
						} else {
							assert.equal(backupAb, undefined);
						}
						const expectedMana: ManaColor[] = regime === 'bloodMoon' ? ['U', 'R'] : ['U'];
						assert.deepEqual(
							permanentCouldProduceManaTypes(rt, rt.players[0], rtArbor, true),
							expectedMana
						);
						const lifeBefore = rt.players[0].life;
						rt.players[0].manaPool.U = 0;
						assert.equal(
							applyGameAction(rt, rt.players[0].playerId, {
								type: 'tap_mana',
								instanceId: rtArbor.instanceId,
								abilityId: quotedAb.id
							}).ok,
							true
						);
						for (let guard = 0; guard < 50; guard++) {
							if (rt.stack.length === 0 && rt.pendingPrompts.length === 0) break;
							if (rt.pendingPrompts.length > 0) {
								const prm = rt.pendingPrompts[0];
								if (prm.choice?.kind !== 'orderObjects') {
									assert.fail(`Expected orderObjects prompt, got ${prm.choice?.kind}`);
								}
								answerTopPrompt(rt, {
									kind: 'orderObjects',
									topIds: prm.choice.objectIds,
									bottomIds: []
								});
							} else {
								const pr = rt.players[rt.priorityPlayerIndex];
								assert.equal(applyGameAction(rt, pr.playerId, { type: 'pass_priority' }).ok, true);
							}
						}
						assert.equal(rt.players[0].manaPool.U, 1);
						// quoted_eot: (+1 life) survives in all surviving regimes; backup_act: (+2 life) also fires under bloodMoon & mutationBefore
						assert.equal(rt.players[0].life, lifeBefore + (shouldBackupSurvive ? 3 : 1));
					} else {
						assert.equal(quotedAb, undefined);
						assert.equal(backupAb, undefined);
						assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtArbor, true), []);
						assert.equal(
							applyGameAction(rt, rt.players[0].playerId, {
								type: 'tap_mana',
								instanceId: rtArbor.instanceId
							}).ok,
							false
						);
					}

					// Kill Dryad Arbor via -3/-3 SBA (pierces Darksteel Mutation Indestructible) -> check quoted_eot: dies LKI draw trigger
					const handBeforeDestroy = rt.players[0].hand.length;
					const shrinkCard = synthCard({
						name: variants[0].destroy === v.destroy ? 'Wither Grasp' : 'Blight Clutch',
						manaCost: '{B}',
						cmc: 1,
						colors: ['B'],
						typeLine: 'Instant',
						oracleText: 'Target creature gets -3/-3 until end of turn.'
					});
					const destHand = putInZone(rt, rt.players[0], 'hand', shrinkCard);
					giveMana(rt.players[0], { B: 1 });
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'cast_spell',
							instanceId: destHand.instanceId,
							targets: [permTarget(rtArbor)]
						}).ok,
						true
					);
					resolveAllStack(rt);
					assert.equal(
						rt.players[0].hand.length,
						handBeforeDestroy + (shouldQuotedSurvive ? 1 : 0),
						`quoted_eot dies LKI under ${regime}`
					);
				}

				// 6. Layer 4 -> Layer 4 overwrites, additive Urborg + Song, Overgrowth + Blood Moon, SplendorKeeper + Blood Moon, merged_ under Blood Moon
				// 6a. Song (ts1) + Blood Moon (ts2) on Bear -> ['R']; Blood Moon (ts1) + Song (ts2) on Tower -> ['G']
				{
					const { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const songHand = putInZone(state, p1, 'hand', v.song);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { G: 1, R: 1, C: 4 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtBear = findIn(rt, 0, bear.instanceId);
					assert.equal(evaluatePermanent(rt, rtBear).effectiveTypeLine, 'Land — Mountain');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtBear, true), ['R']);
				}
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, R: 1, C: 4 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					assert.equal(evaluatePermanent(rt, rtTower).effectiveTypeLine, 'Land — Forest');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['G']);
				}

				// 6b. Spreading Seas (ts1) + Blood Moon (ts2) -> ['R']; Blood Moon (ts1) + Harbinger (ts2) -> ['U']
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					const seasHand = putInZone(state, p1, 'hand', v.spreadingSeas);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { U: 1, R: 1, C: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: seasHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['R']);

					const harbHand = putInZone(rt, rt.players[0], 'hand', v.harbinger);
					giveMana(rt.players[0], { U: 2, C: 1 });
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'cast_spell',
							instanceId: harbHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(rt);
					assert.equal(evaluatePermanent(rt, rtTower).effectiveTypeLine, 'Land — Island');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['U']);
				}

				// 6c. Song #1 (Plains, ts1, p2) + Song #2 (Forest, ts2, p1) on Bear -> ['G'] (tests cross-player timestamp order)
				{
					const { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const p2Song = putPerm(state, p2, v.songPlains);
					p2Song.enteredTimestamp = 0;
					p2Song.attachedToId = bear.instanceId;
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);
					const rt = roundTrip(state);
					const rtBear = findIn(rt, 0, bear.instanceId);
					assert.equal(evaluatePermanent(rt, rtBear).effectiveTypeLine, 'Land — Forest');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtBear, true), ['G']);
				}

				// 6d. Urborg (ts1) + Song of the Dryads (ts2) on Bear -> Land — Forest Swamp, ['B','G']
				{
					const { state, p1 } = setupGame();
					const urborg = putPerm(state, p1, v.urborg);
					urborg.enteredTimestamp = 0;
					const bear = putPerm(state, p1, v.bear);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					noteLayerInputsChanged(state);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);
					const rt = roundTrip(state);
					const rtBear = findIn(rt, 0, bear.instanceId);
					assert.equal(evaluatePermanent(rt, rtBear).effectiveTypeLine, 'Land — Forest Swamp');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtBear, true), ['B', 'G']);
				}

				// 6e. Overgrowth (ts1) on Command Tower + Blood Moon (ts2) -> tapping adds {R}{G}{G}
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					const overHand = putInZone(state, p1, 'hand', v.overgrowth);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { G: 1, R: 1, C: 4 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: overHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					rt.players[0].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'tap_mana',
							instanceId: rtTower.instanceId
						}).ok,
						true
					);
					resolveAllStack(rt);
					assert.equal(rt.players[0].manaPool.R, 1);
					assert.equal(rt.players[0].manaPool.G, 2);
				}

				// 6f. SplendorKeeper + Blood Moon on Dryad Arbor -> ['R'] only, plus Song of the Dryads on merged_
				{
					const { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					const keeperHand = putInZone(state, p1, 'hand', v.keeper);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { W: 1, R: 1, C: 4 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: keeperHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);
					const rt = roundTrip(state);
					const rtArbor = findIn(rt, 0, arbor.instanceId);
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtArbor, true), ['R']);

					const mut2 = putPerm(rt, rt.players[0], v.mutateTop);
					mut2.mergedComponents = [v.mutateTop, v.mutateBot];
					const songHand = putInZone(rt, rt.players[0], 'hand', v.song);
					giveMana(rt.players[0], { G: 1, C: 2 });
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(mut2)]
						}).ok,
						true
					);
					resolveAllStack(rt);
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], mut2, true), ['G']);
					assert.ok(
						!getEffectiveActivatedAbilities(rt, rt.players[0], mut2).some((a) =>
							a.id.startsWith('backup_act:merged_')
						)
					);
				}

				// 6g. merged_ permanent under Blood Moon -> innate & merged_ activated + triggered abilities removed, while quoted_eot: survives
				{
					const { state, p1 } = setupGame();
					const mut = putPerm(state, p1, v.mutateTop);
					mut.mergedComponents = [v.mutateTop, v.mutateBot];
					const keeperHand = putInZone(state, p1, 'hand', v.keeper);
					const qMana = putInZone(state, p1, 'hand', v.quotedMana);
					const qTap = putInZone(state, p1, 'hand', v.quotedTapTrig);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { W: 2, U: 1, R: 1, C: 4 });
					noteLayerInputsChanged(state);

					for (const s of [
						{ id: keeperHand.instanceId },
						{ id: qMana.instanceId, targets: [permTarget(mut)] },
						{ id: qTap.instanceId, targets: [permTarget(mut)] },
						{ id: bmHand.instanceId }
					]) {
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: s.id,
								...(s.targets ? { targets: s.targets } : {})
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					const rt = roundTrip(state);
					const rtMut = findIn(rt, 0, mut.instanceId);
					const effAbs = getEffectiveActivatedAbilities(rt, rt.players[0], rtMut);
					assert.ok(!effAbs.some((a) => a.id.startsWith('backup_act:merged_')));
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtMut, true), [
						'U',
						'R'
					]);
					const lifeBefore = rt.players[0].life;
					rt.players[0].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'tap_mana',
							instanceId: rtMut.instanceId,
							preferredColor: 'R'
						}).ok,
						true
					);
					resolveAllStack(rt);
					assert.equal(rt.players[0].manaPool.R, 1);
					// Only quoted_eot: tap trigger (+1) fires; innate (+1) and merged_ (+2) were removed!
					assert.equal(rt.players[0].life, lifeBefore + 1);
				}

				// 7. Layer 6 granted Undying / Persist under CR 305.7 (Blood Moon) and earlier Humility
				for (const usePersist of [false, true]) {
					for (const regime of ['bloodMoon', 'humilityBefore'] as const) {
						const { state, p1 } = setupGame();
						const giant = putPerm(state, p1, v.forestGiant);
						if (regime === 'humilityBefore') {
							const humHand = putInZone(state, p1, 'hand', v.humility);
							giveMana(p1, { W: 2, C: 2 });
							assert.equal(
								applyGameAction(state, p1.playerId, {
									type: 'cast_spell',
									instanceId: humHand.instanceId
								}).ok,
								true
							);
							resolveAllStack(state);
						}
						if (usePersist) {
							const persHand = putInZone(state, p1, 'hand', v.grantPersist);
							giveMana(p1, { B: 1, C: 2 });
							assert.equal(
								applyGameAction(state, p1.playerId, {
									type: 'cast_spell',
									instanceId: persHand.instanceId
								}).ok,
								true
							);
							resolveAllStack(state);
							if (regime === 'humilityBefore') {
								const anthemCard = synthCard({
									name: variants[0].humility === v.humility ? 'Glorious Anthem' : 'Radiant Banner',
									manaCost: '{1}{W}{W}',
									cmc: 3,
									colors: ['W'],
									typeLine: 'Enchantment',
									oracleText: 'Creatures you control get +1/+1.'
								});
								const antHand = putInZone(state, p1, 'hand', anthemCard);
								giveMana(p1, { W: 2, C: 1 });
								assert.equal(
									applyGameAction(state, p1.playerId, {
										type: 'cast_spell',
										instanceId: antHand.instanceId
									}).ok,
									true
								);
								resolveAllStack(state);
							}
						} else {
							const undHand = putInZone(state, p1, 'hand', v.grantUndying);
							giveMana(p1, { B: 1 });
							assert.equal(
								applyGameAction(state, p1.playerId, {
									type: 'cast_spell',
									instanceId: undHand.instanceId,
									targets: [permTarget(giant)]
								}).ok,
								true
							);
							resolveAllStack(state);
						}
						if (regime === 'bloodMoon') {
							const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
							giveMana(p1, { R: 1, C: 2 });
							assert.equal(
								applyGameAction(state, p1.playerId, {
									type: 'cast_spell',
									instanceId: bmHand.instanceId
								}).ok,
								true
							);
							resolveAllStack(state);
						}

						const rt = roundTrip(state);
						const rtGiant = findIn(rt, 0, giant.instanceId);
						const destHand = putInZone(rt, rt.players[0], 'hand', v.destroy);
						giveMana(rt.players[0], { B: 1, C: 1 });
						assert.equal(
							applyGameAction(rt, rt.players[0].playerId, {
								type: 'cast_spell',
								instanceId: destHand.instanceId,
								targets: [permTarget(rtGiant)]
							}).ok,
							true
						);
						resolveAllStack(rt);

						const returned = findIn(rt, 0, giant.instanceId);
						assert.ok(returned, `expected granted ${usePersist ? 'Persist' : 'Undying'} under ${regime} to return creature`);
						assert.equal(
							returned.counters[usePersist ? '-1/-1' : '+1/+1'],
							1
						);
					}
				}
			}
		});

		it('enforces beforeBlockers, afterCombat, duringCombat+beforeAttackers, and static granted: parity across innate, quoted_eot:, and granted:, without regressing Desert (canonical + cloneRenamed)', () => {
			const baseBeforeBlockersMana = synthCard({
				name: 'Vanguard Relay',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Artifact',
				oracleText: '{T}: Add {W}. Activate only before blockers are declared.'
			});
			const baseDuringCombatBeforeBlockersMana = synthCard({
				name: 'Flank Lantern',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Artifact',
				oracleText: '{T}: Add {W}. Activate only during combat before blockers are declared.'
			});
			const baseBeforeBlockersLife = synthCard({
				name: 'Tactical Medic',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Creature — Human Soldier',
				power: '1',
				toughness: '2',
				oracleText: '{T}: You gain 1 life. Activate only before blockers are declared.'
			});
			const baseAfterCombatMana = synthCard({
				name: 'Postwar Dynamo',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Artifact',
				oracleText: '{T}: Add {U}. Activate only after combat.'
			});
			const baseYourPostcombatMana = synthCard({
				name: 'Vespers Conduit',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Artifact',
				oracleText: '{T}: Add {U}. Activate only during your postcombat main phase.'
			});
			const baseAfterCombatLife = synthCard({
				name: 'Respite Shrine',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Artifact',
				oracleText: '{T}: You gain 1 life. Activate only after combat.'
			});
			const baseDuringCombatBeforeAttackersMana = synthCard({
				name: 'Skirmish Brazier',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				typeLine: 'Artifact',
				oracleText: '{T}: Add {R}. Activate only during combat before attackers are declared.'
			});
			const baseAuraPostcombat = synthCard({
				name: 'Vespers Aura',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nEnchanted creature has "{T}: Add {U}. Activate only during your postcombat main phase."'
			});
			const baseAuraCompound = synthCard({
				name: 'Marshal Aura',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nEnchanted creature has "{T}: Add {W}. Activate only during your turn and only once each turn."'
			});
			const baseAuraCombatBeforeAtk = synthCard({
				name: 'Charge Aura',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nEnchanted creature has "{T}: Add {R}. Activate only during combat before attackers are declared."'
			});
			const baseDesert = synthCard({
				name: 'Desert',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land — Desert',
				oracleText:
					'{T}: Add {C}.\n{T}: Desert deals 1 damage to target attacking creature. Activate only during the end of combat step.'
			});

			const variants = [
				{
					bbMana: baseBeforeBlockersMana,
					dcbbMana: baseDuringCombatBeforeBlockersMana,
					bbLife: baseBeforeBlockersLife,
					acMana: baseAfterCombatMana,
					ypcMana: baseYourPostcombatMana,
					acLife: baseAfterCombatLife,
					dcbaMana: baseDuringCombatBeforeAttackersMana,
					auraPost: baseAuraPostcombat,
					auraCompound: baseAuraCompound,
					auraDcba: baseAuraCombatBeforeAtk,
					desert: baseDesert
				},
				{
					bbMana: cloneRenamed(baseBeforeBlockersMana, 'Frontline Relay'),
					dcbbMana: cloneRenamed(baseDuringCombatBeforeBlockersMana, 'Assault Lantern'),
					bbLife: cloneRenamed(baseBeforeBlockersLife, 'Field Surgeon'),
					acMana: cloneRenamed(baseAfterCombatMana, 'Aftermath Dynamo'),
					ypcMana: cloneRenamed(baseYourPostcombatMana, 'Dusk Conduit'),
					acLife: cloneRenamed(baseAfterCombatLife, 'Quiet Shrine'),
					dcbaMana: cloneRenamed(baseDuringCombatBeforeAttackersMana, 'Vanguard Brazier'),
					auraPost: cloneRenamed(baseAuraPostcombat, 'Dusk Blessing'),
					auraCompound: cloneRenamed(baseAuraCompound, 'Sovereign Blessing'),
					auraDcba: cloneRenamed(baseAuraCombatBeforeAtk, 'Fury Blessing'),
					desert: cloneRenamed(baseDesert, 'Searing Dunes')
				}
			];

			for (const v of variants) {
				// 0. Compiler IR verification across innate and quoted_eot:
				const bbDef = compileCard(v.bbMana);
				assert.equal(bbDef.fullySupported, true);
				const bbAb = bbDef.faces[0].abilities.find((a) => a.kind === 'activated');
				assert.ok(bbAb && bbAb.kind === 'activated');
				assert.deepEqual(bbAb.activationRestrictions, ['beforeBlockers']);

				const dcbbDef = compileCard(v.dcbbMana);
				assert.equal(dcbbDef.fullySupported, true);
				const dcbbAb = dcbbDef.faces[0].abilities.find((a) => a.kind === 'activated');
				assert.ok(dcbbAb && dcbbAb.kind === 'activated');
				assert.deepEqual(dcbbAb.activationRestrictions, ['duringCombat', 'beforeBlockers']);

				const acDef = compileCard(v.acMana);
				assert.equal(acDef.fullySupported, true);
				const acAb = acDef.faces[0].abilities.find((a) => a.kind === 'activated');
				assert.ok(acAb && acAb.kind === 'activated');
				assert.deepEqual(acAb.activationRestrictions, ['afterCombat']);

				const ypcDef = compileCard(v.ypcMana);
				assert.equal(ypcDef.fullySupported, true);
				const ypcAb = ypcDef.faces[0].abilities.find((a) => a.kind === 'activated');
				assert.ok(ypcAb && ypcAb.kind === 'activated');
				assert.deepEqual(ypcAb.activationRestrictions, ['duringYourTurn', 'afterCombat']);

				const dcbaDef = compileCard(v.dcbaMana);
				assert.equal(dcbaDef.fullySupported, true);
				const dcbaAb = dcbaDef.faces[0].abilities.find((a) => a.kind === 'activated');
				assert.ok(dcbaAb && dcbaAb.kind === 'activated');
				assert.deepEqual(dcbaAb.activationRestrictions, ['duringCombat', 'beforeAttackers']);

				const qBb = compileQuotedAbilityString('{T}: Add {W}. Activate only before blockers are declared.');
				assert.equal(qBb[0]?.kind, 'activated');
				if (qBb[0]?.kind === 'activated') {
					assert.deepEqual(qBb[0].activationRestrictions, ['beforeBlockers']);
				}
				const qAc = compileQuotedAbilityString('{T}: Add {U}. Activate only after combat.');
				assert.equal(qAc[0]?.kind, 'activated');
				if (qAc[0]?.kind === 'activated') {
					assert.deepEqual(qAc[0].activationRestrictions, ['afterCombat']);
				}

				assert.equal(compileCard(v.auraPost).fullySupported, true);
				assert.equal(compileCard(v.auraCompound).fullySupported, true);
				assert.equal(compileCard(v.auraDcba).fullySupported, true);

				// 5. Non-regression: Desert's "during the end of combat step" must NOT compile as afterCombat
				const desertDef = compileCard(v.desert);
				assert.equal(desertDef.fullySupported, false);
				const desertDmgAb = desertDef.faces[0].abilities.find(
					(a) =>
						(a.kind === 'activated' && !a.isMana) ||
						(a.kind === 'unsupported' && /attacking creature/i.test(a.text))
				);
				assert.ok(desertDmgAb);
				assert.equal(desertDmgAb.kind, 'unsupported');

				// 1. beforeBlockers across innate, quoted_eot:, and non-mana activate_ability
				{
					const { state, p1, p2 } = setupGame();
					const relay = putPerm(state, p1, v.bbMana);
					const dcRelay = putPerm(state, p1, v.dcbbMana);
					const medic = putPerm(state, p1, v.bbLife);
					const attacker = putPerm(
						state,
						p1,
						synthCard({
							name: 'Raider Bear',
							manaCost: '{1}{G}',
							cmc: 2,
							typeLine: 'Creature — Bear',
							power: '2',
							toughness: '2'
						})
					);
					const bearQ = putPerm(
						state,
						p1,
						synthCard({
							name: 'Quoted Host',
							typeLine: 'Creature — Bear',
							power: '2',
							toughness: '2'
						})
					);
					(state.timedContinuousEffects ??= []).push({
						sourceName: 'Quoted Before Blockers',
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'endOfTurn',
						affected: [{ instanceId: bearQ.instanceId, objectVersion: bearQ.objectVersion ?? 1 }],
						layer6: {
							grantedAbilityTexts: ['{T}: Add {W}. Activate only before blockers are declared.']
						}
					});
					const instW1 = putInZone(
						state,
						p1,
						'hand',
						synthCard({
							name: 'Instant Ward 1',
							manaCost: '{W}',
							cmc: 1,
							colors: ['W'],
							typeLine: 'Instant',
							oracleText: 'You gain 1 life.'
						})
					);
					const instW2 = putInZone(
						state,
						p1,
						'hand',
						synthCard({
							name: 'Instant Ward 2',
							manaCost: '{W}',
							cmc: 1,
							colors: ['W'],
							typeLine: 'Instant',
							oracleText: 'You gain 1 life.'
						})
					);
					noteLayerInputsChanged(state);

					const medicAb = getEffectiveActivatedAbilities(state, p1, medic).find((a) => !a.isManaAbility)!;
					const qBbAb = getEffectiveActivatedAbilities(state, p1, bearQ).find((a) =>
						a.id.startsWith('quoted_eot:')
					)!;
					assert.ok(medicAb && qBbAb);

					// main1: blocked
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, relay, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dcRelay, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: relay.instanceId }).ok,
						false
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: medic.instanceId,
							abilityId: medicAb.id
						}).ok,
						false
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: instW1.instanceId
						}).ok,
						false
					);

					// begin_combat: allowed!
					passUntilPhase(state, 'begin_combat');
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, relay, true), ['W']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dcRelay, true), ['W']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), ['W']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bearQ.instanceId,
							abilityId: qBbAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.W, 1);
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					bearQ.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: instW1.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(relay.tapped, true);
					relay.tapped = false;

					// declare_attackers (before blockers): allowed!
					passUntilPhase(state, 'declare_attackers');
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, relay, true), ['W']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dcRelay, true), ['W']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: medic.instanceId,
							abilityId: medicAb.id
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: instW2.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);

					// declare_blockers & main2: blocked!
					passUntilPhase(state, 'declare_blockers');
					if (state.priorityPlayerIndex !== 0) {
						applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
					}
					relay.tapped = false;
					dcRelay.tapped = false;
					bearQ.tapped = false;
					medic.tapped = false;
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, relay, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dcRelay, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: relay.instanceId }).ok,
						false
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: medic.instanceId,
							abilityId: medicAb.id
						}).ok,
						false
					);

					passUntilPhase(state, 'main2');
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, relay, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dcRelay, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: relay.instanceId }).ok,
						false
					);
				}

				// 2 & 4a. afterCombat + "during your postcombat main phase" across innate, quoted_eot:, and granted:
				{
					const { state, p1 } = setupGame();
					const dynamo = putPerm(state, p1, v.acMana);
					const conduit = putPerm(state, p1, v.ypcMana);
					const shrine = putPerm(state, p1, v.acLife);
					const bearHost = putPerm(
						state,
						p1,
						synthCard({ name: 'Aura Host', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					const auraPost = putPerm(state, p1, v.auraPost);
					auraPost.attachedToId = bearHost.instanceId;
					const bearQ = putPerm(
						state,
						p1,
						synthCard({ name: 'Quoted After Host', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					(state.timedContinuousEffects ??= []).push({
						sourceName: 'Quoted After Combat',
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'endOfTurn',
						affected: [{ instanceId: bearQ.instanceId, objectVersion: bearQ.objectVersion ?? 1 }],
						layer6: { grantedAbilityTexts: ['{T}: Add {U}. Activate only after combat.'] }
					});
					const instU = putInZone(
						state,
						p1,
						'hand',
						synthCard({
							name: 'Postcombat Opt',
							manaCost: '{U}',
							cmc: 1,
							colors: ['U'],
							typeLine: 'Instant',
							oracleText: 'You gain 1 life.'
						})
					);
					noteLayerInputsChanged(state);

					const shrineAb = getEffectiveActivatedAbilities(state, p1, shrine).find((a) => !a.isManaAbility)!;
					const grantedPostAb = getEffectiveActivatedAbilities(state, p1, bearHost).find((a) =>
						a.id.startsWith('granted:')
					)!;
					assert.ok(shrineAb && grantedPostAb);

					// main1 & begin_combat: all blocked
					for (const ph of ['main1', 'begin_combat'] as const) {
						if (state.phase !== ph) passUntilPhase(state, ph);
						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dynamo, true), []);
						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, conduit, true), []);
						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearHost, true), []);
						assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), []);
						assert.equal(
							applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: dynamo.instanceId }).ok,
							false
						);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'activate_ability',
								instanceId: shrine.instanceId,
								abilityId: shrineAb.id
							}).ok,
							false
						);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: instU.instanceId
							}).ok,
							false
						);
					}

					// main2 on controller's turn: all allowed!
					passUntilPhase(state, 'main2', 0);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dynamo, true), ['U']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, conduit, true), ['U']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearHost, true), ['U']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), ['U']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bearHost.instanceId,
							abilityId: grantedPostAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					bearHost.tapped = true;
					conduit.tapped = true;
					bearQ.tapped = true;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: instU.instanceId
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(dynamo.tapped, true);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: shrine.instanceId,
							abilityId: shrineAb.id
						}).ok,
						true
					);
					resolveAllStack(state);

					// Opponent's main2: "during your postcombat main phase" (conduit + granted bearHost) MUST be blocked, while generic "after combat" (dynamo) is allowed!
					passUntilPhase(state, 'main2', 1);
					state.priorityPlayerIndex = 0;
					dynamo.tapped = false;
					conduit.tapped = false;
					bearHost.tapped = false;
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, dynamo, true), ['U']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, conduit, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearHost, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: conduit.instanceId }).ok,
						false
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bearHost.instanceId,
							abilityId: grantedPostAb.id
						}).ok,
						false
					);
				}

				// 3 & 4b. duringCombat + beforeAttackers across innate, quoted_eot:, and granted:, plus compound granted:
				{
					const { state, p1, p2 } = setupGame();
					const brazier = putPerm(state, p1, v.dcbaMana);
					const attacker = putPerm(
						state,
						p1,
						synthCard({ name: 'Charger', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					const bearGranted = putPerm(
						state,
						p1,
						synthCard({ name: 'Granted Host', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					const auraDcba = putPerm(state, p1, v.auraDcba);
					auraDcba.attachedToId = bearGranted.instanceId;
					const bearCompound = putPerm(
						state,
						p1,
						synthCard({ name: 'Compound Host', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					const auraComp = putPerm(state, p1, v.auraCompound);
					auraComp.attachedToId = bearCompound.instanceId;
					const bearQ = putPerm(
						state,
						p1,
						synthCard({ name: 'Quoted DCBA Host', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
					);
					(state.timedContinuousEffects ??= []).push({
						sourceName: 'Quoted DCBA',
						controllerId: p1.playerId,
						timestamp: nextTestTs++,
						expires: 'endOfTurn',
						affected: [{ instanceId: bearQ.instanceId, objectVersion: bearQ.objectVersion ?? 1 }],
						layer6: {
							grantedAbilityTexts: [
								'{T}: Add {R}. Activate only during combat before attackers are declared.'
							]
						}
					});
					noteLayerInputsChanged(state);

					const grantedDcbaAb = getEffectiveActivatedAbilities(state, p1, bearGranted).find((a) =>
						a.id.startsWith('granted:')
					)!;
					const grantedCompAb = getEffectiveActivatedAbilities(state, p1, bearCompound).find((a) =>
						a.id.startsWith('granted:')
					)!;
					const quotedDcbaAb = getEffectiveActivatedAbilities(state, p1, bearQ).find((a) =>
						a.id.startsWith('quoted_eot:')
					)!;
					assert.ok(grantedDcbaAb && grantedCompAb && quotedDcbaAb);

					// main1: duringCombat + beforeAttackers MUST be blocked!
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, brazier, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearGranted, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: brazier.instanceId }).ok,
						false
					);

					// Compound granted: "during your turn and only once each turn" works once in main1, then blocked!
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bearCompound.instanceId,
							abilityId: grantedCompAb.id
						}).ok,
						true
					);
					bearCompound.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bearCompound.instanceId,
							abilityId: grantedCompAb.id
						}).ok,
						false
					);

					// begin_combat: duringCombat + beforeAttackers allowed!
					passUntilPhase(state, 'begin_combat', 0);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, brazier, true), ['R']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearGranted, true), ['R']);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), ['R']);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: brazier.instanceId }).ok,
						true
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bearGranted.instanceId,
							abilityId: grantedDcbaAb.id
						}).ok,
						true
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: bearQ.instanceId,
							abilityId: quotedDcbaAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.R, 3);

					// declare_attackers (combat.active = true): duringCombat + beforeAttackers blocked!
					passUntilPhase(state, 'declare_attackers', 0);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					brazier.tapped = false;
					bearGranted.tapped = false;
					bearQ.tapped = false;
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, brazier, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearGranted, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearQ, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: brazier.instanceId }).ok,
						false
					);

					// Next turn upkeep (controller's upkeep): duringCombat + beforeAttackers MUST also be blocked!
					passUntilPhase(state, 'upkeep', 1);
					passUntilPhase(state, 'upkeep', 0);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, brazier, true), []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, p1, bearGranted, true), []);
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: brazier.instanceId }).ok,
						false
					);
				}
			}
		});

		it('M5 Iter 11 Bug 1: Backup-granted dies/LTB triggers fire from LKI across regimes, Bondwarden, simultaneous wipe, Undying, Room/merged, and transformed DFC (canonical + cloneRenamed)', () => {
			const baseEpitaphMentor = synthCard({
				name: 'Epitaph Mentor',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Creature — Human Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nWhen this creature dies, draw a card.'
			});
			const baseUndyingMentor = synthCard({
				name: 'Undying Mentor',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Creature — Zombie Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nUndying'
			});
			const baseBondwarden = synthCard({
				name: 'Enduring Bondwarden',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				typeLine: 'Creature — Human Scout',
				power: '0',
				toughness: '1',
				keywords: ['Backup'],
				oracleText:
					'Backup 1 (When this creature enters, put a +1/+1 counter on target creature. If that\'s another creature, it gains the following ability until end of turn.)\nWhen this creature dies, put its counters on target creature you control.'
			});
			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const baseShrink = synthCard({
				name: 'Wither Grasp',
				manaCost: '{B}',
				cmc: 1,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Target creature gets -4/-4 until end of turn.'
			});
			const baseWrath = synthCard({
				name: 'Day of Doom',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				colors: ['W'],
				typeLine: 'Sorcery',
				oracleText: 'Destroy all creatures.'
			});
			const baseAnimateRoom = synthCard({
				name: 'Living Blueprint',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target noncreature permanent becomes a 2/2 creature until end of turn.'
			});
			const realDryadArbor = realCard('Dryad Arbor');
			const realBloodMoon = realCard('Blood Moon');
			const realMutation = realCard('Darksteel Mutation');
			const realHumility = realCard('Humility');
			const baseMutateTop = synthCard({
				name: 'Apex Landbeast',
				manaCost: '{2}{G}',
				cmc: 3,
				colors: ['G'],
				typeLine: 'Creature — Beast',
				power: '2',
				toughness: '2'
			});
			const baseMutateBot = synthCard({
				name: 'Benevolent Sprout',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Elk',
				power: '2',
				toughness: '2'
			});

			const variants = [
				{
					epitaphMentor: baseEpitaphMentor,
					undyingMentor: baseUndyingMentor,
					bondwarden: baseBondwarden,
					bear: baseBear,
					shrink: baseShrink,
					wrath: baseWrath,
					animateRoom: baseAnimateRoom,
					dryadArbor: realDryadArbor,
					bloodMoon: realBloodMoon,
					mutation: realMutation,
					humility: realHumility,
					mutateTop: baseMutateTop,
					mutateBot: baseMutateBot,
					dfcFrontName: 'Dawnbound Watch',
					dfcBackName: 'Nightbound Husk'
				},
				{
					epitaphMentor: cloneRenamed(baseEpitaphMentor, 'Graveyard Tutor'),
					undyingMentor: cloneRenamed(baseUndyingMentor, 'Restless Tutor'),
					bondwarden: cloneRenamed(baseBondwarden, 'Loyal Oathkeeper'),
					bear: cloneRenamed(baseBear, 'Forest Ursid'),
					shrink: cloneRenamed(baseShrink, 'Blight Snare'),
					wrath: cloneRenamed(baseWrath, 'Final Sweeper'),
					animateRoom: cloneRenamed(baseAnimateRoom, 'Animate Folio'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Living Glade'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Eclipse'),
					mutation: cloneRenamed(realMutation, 'Carapace Curse'),
					humility: cloneRenamed(realHumility, 'Meekness Field'),
					mutateTop: cloneRenamed(baseMutateTop, 'Summit Chimera'),
					mutateBot: cloneRenamed(baseMutateBot, 'Creek Elk'),
					dfcFrontName: 'Sunlit Sentry',
					dfcBackName: 'Shadowed Shell'
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const resolveWithTarget = (state: GameState, targetId: string): void => {
				for (let guard = 0; guard < 60; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) break;
					if (state.pendingPrompts.length > 0) {
						const prm = state.pendingPrompts[0];
						if (prm.choice?.kind === 'chooseObjects') {
							answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [targetId] });
						} else if (prm.choice?.kind === 'orderObjects') {
							answerTopPrompt(state, {
								kind: 'orderObjects',
								topIds: prm.choice.objectIds,
								bottomIds: []
							});
						} else {
							assert.fail(`Unexpected prompt kind: ${prm.choice?.kind}`);
						}
					} else {
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
			};

			for (const v of variants) {
				assert.equal(definitionSupportReport(compileCard(v.bondwarden)).fullySupported, true);
				assert.equal(definitionSupportReport(compileCard(v.epitaphMentor)).fullySupported, true);

				// 1. Synthetic Backup dies-LKI across regimes: standalone, bloodMoon, mutationBefore, humilityBefore, humilityAfter
				for (const regime of [
					'standalone',
					'bloodMoon',
					'mutationBefore',
					'humilityBefore',
					'humilityAfter'
				] as const) {
					let { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					putInZone(state, p1, 'library', v.bear);
					putInZone(state, p1, 'library', v.bear);
					if (regime === 'mutationBefore') {
						const mutHand = putInZone(state, p1, 'hand', v.mutation);
						giveMana(p1, { W: 1, C: 1 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: mutHand.instanceId,
								targets: [permTarget(arbor)]
							}).ok,
							true
						);
						resolveAllStack(state);
					} else if (regime === 'humilityBefore') {
						const humHand = putInZone(state, p1, 'hand', v.humility);
						giveMana(p1, { W: 2, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: humHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					const mentorHand = putInZone(state, p1, 'hand', v.epitaphMentor);
					giveMana(p1, { W: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: mentorHand.instanceId
						}).ok,
						true
					);
					resolveWithTarget(state, arbor.instanceId);

					if (regime === 'bloodMoon') {
						const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
						giveMana(p1, { R: 1, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: bmHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					} else if (regime === 'humilityAfter') {
						const humHand = putInZone(state, p1, 'hand', v.humility);
						giveMana(p1, { W: 2, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: humHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					state = roundTrip(state);
					p1 = state.players[0];
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const handBefore = p1.hand.length;
					const shrinkHand = putInZone(state, p1, 'hand', v.shrink);
					giveMana(p1, { B: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(rtArbor)]
						}).ok,
						true
					);
					resolveAllStack(state);
					// Under humilityBefore, Humility strips Backup 1 ETB on Epitaph Mentor itself -> 0; under humilityAfter, Humility strips granted trigger -> 0
					const expectedDraws =
						regime === 'humilityBefore' || regime === 'humilityAfter' ? 0 : 1;
					assert.equal(
						state.players[0].hand.length,
						handBefore + expectedDraws,
						`backup dies LKI under ${regime}`
					);
				}

				// 2. Double Backup grants on same creature -> 2 triggers (CR 702.165b)
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					putInZone(state, p1, 'library', v.bear);
					putInZone(state, p1, 'library', v.bear);
					for (let i = 0; i < 2; i++) {
						const mHand = putInZone(state, p1, 'hand', v.epitaphMentor);
						giveMana(p1, { W: 1, C: 1 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: mHand.instanceId
							}).ok,
							true
						);
						resolveWithTarget(state, bear.instanceId);
					}
					state = roundTrip(state);
					const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
					giveMana(state.players[0], { B: 1 });
					const handBefore = state.players[0].hand.length - 1;
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					resolveWithTarget(state, bear.instanceId);
					assert.equal(state.players[0].hand.length, handBefore + 2);
				}

				// 3. mergedComponents creature + 2-door Room (unlockedFaces: [0, 1]) Backup dies-LKI
				{
					let { state, p1 } = setupGame();
					const mut = putPerm(state, p1, v.mutateTop);
					mut.mergedComponents = [v.mutateTop, v.mutateBot];
					const roomCard = synthCard({
						name: 'Archive Hall // Gallery Wing',
						layout: 'split',
						manaCost: '{1}{U}',
						cmc: 2,
						typeLine: 'Enchantment — Room',
						faces: [
							{
								name: 'Archive Hall',
								manaCost: '{1}{U}',
								cmc: 2,
								typeLine: 'Enchantment — Room',
								oracleText: '',
								colors: ['U'],
								imageUrl: ''
							},
							{
								name: 'Gallery Wing',
								manaCost: '{1}{U}',
								cmc: 2,
								typeLine: 'Enchantment — Room',
								oracleText: '',
								colors: ['U'],
								imageUrl: ''
							}
						]
					});
					const room = putPerm(state, p1, roomCard);
					room.unlockedFaces = [0, 1];
					putInZone(state, p1, 'library', v.bear);
					putInZone(state, p1, 'library', v.bear);
					noteLayerInputsChanged(state);

					const animHand = putInZone(state, p1, 'hand', v.animateRoom);
					giveMana(p1, { U: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: animHand.instanceId,
							targets: [permTarget(room)]
						}).ok,
						true
					);
					resolveAllStack(state);

					for (const targetPerm of [mut, room]) {
						const mHand = putInZone(state, p1, 'hand', v.epitaphMentor);
						giveMana(p1, { W: 1, C: 1 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: mHand.instanceId
							}).ok,
							true
						);
						resolveWithTarget(state, targetPerm.instanceId);
					}

					state = roundTrip(state);
					for (const targetId of [mut.instanceId, room.instanceId]) {
						const handBefore = state.players[0].hand.length;
						const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
						giveMana(state.players[0], { B: 1 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: shrinkHand.instanceId,
								targets: [permTarget(findIn(state, 0, targetId))]
							}).ok,
							true
						);
						resolveAllStack(state);
						assert.equal(state.players[0].hand.length, handBefore + 1);
					}
				}

				// 4. Backup 1 + Undying -> single return with +1/+1 counter (no double-trigger)
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const uHand = putInZone(state, p1, 'hand', v.undyingMentor);
					giveMana(p1, { B: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: uHand.instanceId
						}).ok,
						true
					);
					resolveWithTarget(state, bear.instanceId);
					// Remove the Backup +1/+1 counter so Undying is eligible when Bear dies
					bear.counters['+1/+1'] = 0;

					state = roundTrip(state);
					const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
					giveMana(state.players[0], { B: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					resolveAllStack(state);
					const returned = findIn(state, 0, bear.instanceId);
					assert.ok(returned, 'expected Backup + Undying creature to return once');
					assert.equal(returned.counters['+1/+1'], 1);
				}

				// 5. Real Scryfall Enduring Bondwarden: standalone, Dryad Arbor + Blood Moon, and simultaneous board wipe
				for (const mode of ['bear', 'arborBloodMoon', 'wipe'] as const) {
					let { state, p1 } = setupGame();
					const recipient = putPerm(state, p1, mode === 'arborBloodMoon' ? v.dryadArbor : v.bear);
					const extraVictim = mode === 'wipe' ? putPerm(state, p1, v.bear) : undefined;
					const bwHand = putInZone(state, p1, 'hand', v.bondwarden);
					giveMana(p1, { W: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bwHand.instanceId
						}).ok,
						true
					);
					resolveWithTarget(state, recipient.instanceId);
					const bwPerm = state.players[0].battlefield.find((c) => c.card.name === v.bondwarden.name)!;
					assert.equal(recipient.counters['+1/+1'], 1);

					if (mode === 'arborBloodMoon') {
						const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
						giveMana(p1, { R: 1, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: bmHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					} else if (mode === 'wipe') {
						// Give Bondwarden Indestructible so it survives the wipe to receive the counter
						(state.timedKeywordEffects ??= []).push({
							sourceName: 'Indestructible Ward',
							controllerId: p1.playerId,
							timestamp: nextTestTs++,
							affected: [{ instanceId: bwPerm.instanceId, objectVersion: bwPerm.objectVersion ?? 1 }],
							addKeywords: ['indestructible']
						});
						noteLayerInputsChanged(state);
					}

					state = roundTrip(state);
					if (mode === 'wipe') {
						const wHand = putInZone(state, state.players[0], 'hand', v.wrath);
						giveMana(state.players[0], { W: 2, C: 2 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: wHand.instanceId
							}).ok,
							true
						);
						resolveWithTarget(state, bwPerm.instanceId);
						assert.equal(findIn(state, 0, recipient.instanceId), undefined);
						assert.equal(findIn(state, 0, extraVictim!.instanceId), undefined);
					} else {
						const sHand = putInZone(state, state.players[0], 'hand', v.shrink);
						giveMana(state.players[0], { B: 1 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: sHand.instanceId,
								targets: [permTarget(findIn(state, 0, recipient.instanceId))]
							}).ok,
							true
						);
						resolveWithTarget(state, bwPerm.instanceId);
					}
					const rtAfter = roundTrip(state);
					const rtBw = findIn(rtAfter, 0, bwPerm.instanceId);
					assert.equal(rtBw.counters['+1/+1'], 1, `Bondwarden counter failed in mode=${mode}`);
				}

				// 6. Transformed DFC (activeFaceIndex: 1) with innate dies trigger on face 0 ONLY + Backup dies grant -> 1 draw, not 2
				{
					let { state, p1 } = setupGame();
					const dfcCard = synthCard({
						name: `${v.dfcFrontName} // ${v.dfcBackName}`,
						layout: 'transform',
						manaCost: '{1}{W}',
						cmc: 2,
						colors: ['W'],
						typeLine: 'Creature — Human',
						power: '2',
						toughness: '2',
						oracleText: 'When this creature dies, draw a card.',
						backFace: {
							name: v.dfcBackName,
							manaCost: '',
							typeLine: 'Creature — Spirit',
							oracleText: '',
							power: '2',
							toughness: '2',
							imageUrl: ''
						}
					});
					const dfc = putPerm(state, p1, dfcCard);
					dfc.transformed = true;
					dfc.activeFaceIndex = 1;
					putInZone(state, p1, 'library', v.bear);
					putInZone(state, p1, 'library', v.bear);
					noteLayerInputsChanged(state);

					const mHand = putInZone(state, p1, 'hand', v.epitaphMentor);
					giveMana(p1, { W: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: mHand.instanceId
						}).ok,
						true
					);
					resolveWithTarget(state, dfc.instanceId);

					state = roundTrip(state);
					const handBefore = state.players[0].hand.length;
					const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
					giveMana(state.players[0], { B: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(findIn(state, 0, dfc.instanceId))]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(state.players[0].hand.length, handBefore + 1);
				}
			}
		});

		it('M5 Iter 11 Bug 2 & Equal-Timestamp/Same-Name Mana: evaluateAttachedTypes latestSetLandSubtypesTs, CR 613.8a Bear dependency, equal-ts, and same-name Convincing Mirage (canonical + cloneRenamed)', () => {
			const realTower = realCard('Command Tower');
			const realForest = realCard('Forest');
			const realWastes = realCard('Wastes');
			const realDryad = realCard('Dryad of the Ilysian Grove');
			const realUrborg = realCard('Urborg, Tomb of Yawgmoth');
			const realSong = realCard('Song of the Dryads');
			const realImprisoned = realCard('Imprisoned in the Moon');
			const baseYavimaya = synthCard({
				name: 'Yavimaya, Cradle of Growth',
				manaCost: '',
				cmc: 0,
				typeLine: 'Legendary Land',
				oracleText: 'Each land is a Forest in addition to its other land types.'
			});
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '*',
				toughness: '*',
				oracleText:
					"Ashaya, Soul of the Wild's power and toughness are each equal to the number of lands you control.\nNontoken creatures you control are Forest lands in addition to their other types."
			});
			const baseNissa = synthCard({
				name: 'Nissa, Who Shakes the World',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Planeswalker — Nissa',
				loyalty: '5',
				oracleText:
					'+1: Put three +1/+1 counters on up to one target noncreature land you control. Untap it. It becomes a 0/0 Elemental creature with vigilance and haste that\'s still a land.'
			});
			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const baseMirage = synthCard({
				name: 'Convincing Mirage',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				keywords: ['Enchant'],
				oracleText:
					'Enchant land\nAs Convincing Mirage enters, choose a basic land type.\nEnchanted land is the chosen type.'
			});
			const baseHymn = synthCard({
				name: 'Verdant Sealing Hymn',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Enchantment — Aura',
				keywords: ['Enchant'],
				oracleText: 'Enchant permanent\nEnchanted permanent is a Forest land.'
			});
			const basePlainsSong = synthCard({
				name: 'Song of the Plains',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Enchantment — Aura',
				keywords: ['Enchant'],
				oracleText: 'Enchant permanent\nEnchanted permanent is a Plains land.'
			});

			const variants = [
				{
					tower: realTower,
					forest: realForest,
					wastes: realWastes,
					dryad: realDryad,
					urborg: realUrborg,
					yavimaya: baseYavimaya,
					song: realSong,
					imprisoned: realImprisoned,
					ashaya: baseAshaya,
					nissa: baseNissa,
					bear: baseBear,
					mirage: baseMirage,
					hymn: baseHymn,
					plainsSong: basePlainsSong
				},
				{
					tower: cloneRenamed(realTower, 'Relic Spire'),
					forest: cloneRenamed(realForest, 'Verdant Glade'),
					wastes: cloneRenamed(realWastes, 'Null Barrens'),
					dryad: cloneRenamed(realDryad, 'Grove Nymph'),
					urborg: cloneRenamed(realUrborg, 'Mire Basin'),
					yavimaya: cloneRenamed(baseYavimaya, 'Bough Sanctuary'),
					song: cloneRenamed(realSong, 'Sylvan Seal'),
					imprisoned: cloneRenamed(realImprisoned, 'Lunar Binding'),
					ashaya: cloneRenamed(baseAshaya, 'Sylvan Avatar'),
					nissa: cloneRenamed(baseNissa, 'Sylvan Planeswalker'),
					bear: cloneRenamed(baseBear, 'Timber Bruin'),
					mirage: cloneRenamed(baseMirage, 'Illusory Shift'),
					hymn: cloneRenamed(baseHymn, 'Mossy Sealing'),
					plainsSong: cloneRenamed(basePlainsSong, 'Meadow Seal')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;

			for (const v of variants) {
				// 1. Additive land (Dryad / Urborg / Yavimaya at ts1) + existing Land (Tower / Forest / Wastes) + Song / Imprisoned (ts2)
				for (const addKind of ['dryad', 'urborg', 'yavimaya'] as const) {
					for (const landKind of ['tower', 'forest', 'wastes'] as const) {
						for (const auraKind of ['song', 'imprisoned'] as const) {
							const { state, p1 } = setupGame();
							p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
							const addCard = v[addKind];
							const landCard = v[landKind];
							const auraCard = v[auraKind];
							const land = putPerm(state, p1, landCard);
							putPerm(state, p1, addCard);
							state.nextTimestamp = nextTestTs + 1;
							const auraHand = putInZone(state, p1, 'hand', auraCard);
							giveMana(p1, { G: 2, U: 2, C: 4 });
							assert.equal(
								applyGameAction(state, p1.playerId, {
									type: 'cast_spell',
									instanceId: auraHand.instanceId,
									targets: [permTarget(land)]
								}).ok,
								true
							);
							resolveAllStack(state);

							const rt = roundTrip(state);
							const rtLand = findIn(rt, 0, land.instanceId);
							const ev = evaluatePermanent(rt, rtLand);
							const expectedType =
								auraKind === 'song'
									? landKind === 'tower'
										? 'Land — Forest'
										: 'Basic Land — Forest'
									: landKind === 'tower'
										? 'Land'
										: 'Basic Land';
							assert.equal(ev.effectiveTypeLine, expectedType, `${addKind}+${landKind}+${auraKind}`);
							assert.deepEqual(
								permanentCouldProduceManaTypes(rt, rt.players[0], rtLand, true),
								[auraKind === 'song' ? 'G' : 'C'],
								`mana ${addKind}+${landKind}+${auraKind}`
							);
						}
					}
				}

				// 2. Song (ts2) + later Urborg / Dryad (ts3) on Command Tower -> ts3 still applies!
				for (const laterKind of ['urborg', 'dryad'] as const) {
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					state.nextTimestamp = nextTestTs + 1;
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);

					if (laterKind === 'urborg') {
						const urb = putPerm(state, p1, v.urborg);
						urb.enteredTimestamp = state.nextTimestamp++;
						noteLayerInputsChanged(state);
					} else {
						const dHand = putInZone(state, p1, 'hand', v.dryad);
						giveMana(p1, { G: 1, C: 2 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: dHand.instanceId
							}).ok,
							true
						);
						resolveAllStack(state);
					}

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					if (laterKind === 'urborg') {
						assert.equal(evaluatePermanent(rt, rtTower).effectiveTypeLine, 'Land — Forest Swamp');
						assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['B', 'G']);
					} else {
						assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), [
							'W',
							'U',
							'B',
							'R',
							'G'
						]);
					}
				}

				// 3. CR 613.8a non-land Bear + Ashaya (ts1) + Urborg (ts2) + Song (ts3) -> Land — Forest Swamp ['B', 'G']
				{
					const { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					putPerm(state, p1, v.ashaya);
					putPerm(state, p1, v.urborg);
					state.nextTimestamp = nextTestTs + 1;
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtBear = findIn(rt, 0, bear.instanceId);
					assert.equal(evaluatePermanent(rt, rtBear).effectiveTypeLine, 'Land — Forest Swamp');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtBear, true), ['B', 'G']);
				}

				// 4. Command Tower + Nissa (+1 animate, ts1) + Urborg (ts2) + Song (ts3) -> Land — Forest ['G'] (noncreature)
				{
					const { state, p1 } = setupGame();
					const tower = putPerm(state, p1, v.tower);
					const nissa = putPerm(state, p1, v.nissa);
					state.nextTimestamp = nextTestTs + 1;
					const nissaPlus1 = getEffectiveActivatedAbilities(state, p1, nissa).find((a) =>
						a.label.includes('+1')
					)!;
					assert.ok(nissaPlus1);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: nissa.instanceId,
							abilityId: nissaPlus1.id,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);
					const urb = putPerm(state, p1, v.urborg);
					urb.enteredTimestamp = state.nextTimestamp++;
					noteLayerInputsChanged(state);
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					const ev = evaluatePermanent(rt, rtTower);
					assert.equal(ev.effectiveTypeLine, 'Land — Forest');
					assert.equal(ev.isCreature, false);
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['G']);
				}

				// 5. Equal-timestamp Verdant Sealing Hymn (ts=50, p1) + Song of the Plains (ts=50, p2) on Bear -> Land — Plains ['W']
				{
					const { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const a1 = putPerm(state, p1, v.hymn);
					const a2 = putPerm(state, p2, v.plainsSong);
					a1.attachedToId = bear.instanceId;
					a2.attachedToId = bear.instanceId;
					a1.enteredTimestamp = 50;
					a2.enteredTimestamp = 50;
					noteLayerInputsChanged(state);

					const rt = roundTrip(state);
					const rtBear = findIn(rt, 0, bear.instanceId);
					assert.equal(evaluatePermanent(rt, rtBear).effectiveTypeLine, 'Land — Plains');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtBear, true), ['W']);
				}

				// 6. Two same-name Convincing Mirage (Swamp then Island) on Command Tower -> both distinct ts and equal ts=50 yield Land — Island ['U']
				for (const equalTs of [false, true]) {
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					for (const sub of ['Swamp', 'Island'] as const) {
						const mHand = putInZone(state, p1, 'hand', v.mirage);
						giveMana(p1, { U: 1, C: 1 });
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: mHand.instanceId,
								targets: [permTarget(tower)]
							}).ok,
							true
						);
						for (let guard = 0; guard < 50; guard++) {
							if (state.stack.length === 0 && state.pendingPrompts.length === 0) break;
							if (state.pendingPrompts.length > 0) {
								const prm = state.pendingPrompts[0];
								if (prm.choice?.kind === 'chooseMode') {
									const idx = prm.choice.modes.indexOf(sub);
									answerTopPrompt(state, { kind: 'chooseMode', indices: [idx >= 0 ? idx : 0] });
								} else {
									assert.fail(`Unexpected prompt kind: ${prm.choice?.kind}`);
								}
							} else {
								const pr = state.players[state.priorityPlayerIndex];
								assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
							}
						}
					}
					if (equalTs) {
						const mirages = state.players[0].battlefield.filter((c) => c.card.name === v.mirage.name);
						assert.equal(mirages.length, 2);
						mirages[0].enteredTimestamp = 50;
						mirages[1].enteredTimestamp = 50;
						noteLayerInputsChanged(state);
					}
					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					assert.equal(evaluatePermanent(rt, rtTower).effectiveTypeLine, 'Land — Island');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['U']);
				}
			}
		});

		it('M5 Iter 11 Bug 3: Timed layer4.setSubtypes & layer4.addSubtypes (fixed + chooseBasicLandType) across Blood Moon, Song, Imprisoned, Dryad, Humility/Keeper, tap_mana, and EOT reversion (canonical + cloneRenamed)', () => {
			const baseIslandize = synthCard({
				name: 'Tidal Shift',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes an Island until end of turn.'
			});
			const baseIslandizeAdd = synthCard({
				name: 'Tidal Flood',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes an Island in addition to its other types until end of turn.'
			});
			const baseChooseOverwrite = synthCard({
				name: 'Prismatic Terrain',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes the basic land type of your choice until end of turn.'
			});
			const baseChooseAdd = synthCard({
				name: 'Fertile Expansion',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText:
					'Target land becomes the basic land type of your choice in addition to its other types until end of turn.'
			});
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Enchantment',
				oracleText: 'Creatures lose all abilities except mana abilities.'
			});
			const realTower = realCard('Command Tower');
			const realWastes = realCard('Wastes');
			const realBloodMoon = realCard('Blood Moon');
			const realSong = realCard('Song of the Dryads');
			const realImprisoned = realCard('Imprisoned in the Moon');
			const realDryad = realCard('Dryad of the Ilysian Grove');
			const realDryadArbor = realCard('Dryad Arbor');
			const realHumility = realCard('Humility');
			const realAbundant = realCard('Abundant Growth');

			const variants = [
				{
					islandize: baseIslandize,
					islandizeAdd: baseIslandizeAdd,
					chooseOverwrite: baseChooseOverwrite,
					chooseAdd: baseChooseAdd,
					keeper: baseKeeper,
					tower: realTower,
					wastes: realWastes,
					bloodMoon: realBloodMoon,
					song: realSong,
					imprisoned: realImprisoned,
					dryad: realDryad,
					dryadArbor: realDryadArbor,
					humility: realHumility,
					abundant: realAbundant
				},
				{
					islandize: cloneRenamed(baseIslandize, 'Sea Surge'),
					islandizeAdd: cloneRenamed(baseIslandizeAdd, 'Ocean Swell'),
					chooseOverwrite: cloneRenamed(baseChooseOverwrite, 'Mutable Terrain'),
					chooseAdd: cloneRenamed(baseChooseAdd, 'Verdant Expansion'),
					keeper: cloneRenamed(baseKeeper, 'Sanctuary Seal'),
					tower: cloneRenamed(realTower, 'Relic Spire'),
					wastes: cloneRenamed(realWastes, 'Null Barrens'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Eclipse'),
					song: cloneRenamed(realSong, 'Sylvan Seal'),
					imprisoned: cloneRenamed(realImprisoned, 'Lunar Binding'),
					dryad: cloneRenamed(realDryad, 'Grove Nymph'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Living Glade'),
					humility: cloneRenamed(realHumility, 'Meekness Field'),
					abundant: cloneRenamed(realAbundant, 'Verdant Surplus')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const resolveChoosingLand = (state: GameState, sub: 'Plains' | 'Island' | 'Swamp' | 'Mountain' | 'Forest'): void => {
				for (let guard = 0; guard < 50; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) break;
					if (state.pendingPrompts.length > 0) {
						const prm = state.pendingPrompts[0];
						if (prm.choice?.kind === 'chooseMode') {
							const idx = prm.choice.modes.indexOf(sub);
							answerTopPrompt(state, { kind: 'chooseMode', indices: [idx >= 0 ? idx : 0] });
						} else {
							assert.fail(`Unexpected prompt kind: ${prm.choice?.kind}`);
						}
					} else {
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
			};

			for (const v of variants) {
				// 1. Timed overwrite ("becomes an Island until end of turn") on Command Tower -> Land — Island ['U'], tap_mana adds {U}, reverts at EOT
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					const spellHand = putInZone(state, p1, 'hand', v.islandize);
					giveMana(p1, { U: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: spellHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					const ev = evaluatePermanent(rt, rtTower);
					assert.equal(ev.effectiveTypeLine, 'Land — Island');
					assert.equal(ev.losesAllAbilities, true);
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['U']);
					rt.players[0].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'tap_mana',
							instanceId: rtTower.instanceId
						}).ok,
						true
					);
					assert.equal(rt.players[0].manaPool.U, 1);

					// EOT reversion restores Command Tower's commander-identity mana ability
					rtTower.tapped = false;
					passUntilPhase(rt, 'main1', 1);
					const rtAfterEot = roundTrip(rt);
					const rtTowerAfter = findIn(rtAfterEot, 0, tower.instanceId);
					assert.equal(evaluatePermanent(rtAfterEot, rtTowerAfter).effectiveTypeLine, 'Land');
					assert.deepEqual(
						permanentCouldProduceManaTypes(rtAfterEot, rtAfterEot.players[0], rtTowerAfter, true),
						['W', 'U', 'B', 'R', 'G']
					);
				}

				// 2. Timed additive ("becomes an Island in addition to its other types until end of turn") on Wastes -> Basic Land — Island ['U', 'C'], tap_mana {U} adds {U}, reverts at EOT
				{
					const { state, p1 } = setupGame();
					const wastes = putPerm(state, p1, v.wastes);
					const spellHand = putInZone(state, p1, 'hand', v.islandizeAdd);
					giveMana(p1, { U: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: spellHand.instanceId,
							targets: [permTarget(wastes)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtWastes = findIn(rt, 0, wastes.instanceId);
					assert.equal(evaluatePermanent(rt, rtWastes).effectiveTypeLine, 'Basic Land — Island');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtWastes, true), ['U', 'C']);
					const tapU = getEffectiveActivatedAbilities(rt, rt.players[0], rtWastes).find((a) =>
						a.label.includes('{U}')
					);
					assert.ok(tapU, 'expected intrinsic {T}: Add {U} ability on Wastes');
					rt.players[0].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'tap_mana',
							instanceId: rtWastes.instanceId,
							preferredColor: 'U'
						}).ok,
						true
					);
					assert.equal(rt.players[0].manaPool.U, 1);

					rtWastes.tapped = false;
					passUntilPhase(rt, 'main1', 1);
					const rtAfterEot = roundTrip(rt);
					const rtWastesAfter = findIn(rtAfterEot, 0, wastes.instanceId);
					assert.equal(evaluatePermanent(rtAfterEot, rtWastesAfter).effectiveTypeLine, 'Basic Land');
					assert.deepEqual(
						permanentCouldProduceManaTypes(rtAfterEot, rtAfterEot.players[0], rtWastesAfter, true),
						['C']
					);
				}

				// 3. chooseBasicLandType timed overwrite vs additive on Command Tower
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					const chOver = putInZone(state, p1, 'hand', v.chooseOverwrite);
					giveMana(p1, { U: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: chOver.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveChoosingLand(state, 'Swamp');
					let rt = roundTrip(state);
					assert.equal(evaluatePermanent(rt, findIn(rt, 0, tower.instanceId)).effectiveTypeLine, 'Land — Swamp');
					assert.deepEqual(
						permanentCouldProduceManaTypes(rt, rt.players[0], findIn(rt, 0, tower.instanceId), true),
						['B']
					);

					const chAdd = putInZone(rt, rt.players[0], 'hand', v.chooseAdd);
					giveMana(rt.players[0], { G: 1, C: 1 });
					assert.equal(
						applyGameAction(rt, rt.players[0].playerId, {
							type: 'cast_spell',
							instanceId: chAdd.instanceId,
							targets: [permTarget(findIn(rt, 0, tower.instanceId))]
						}).ok,
						true
					);
					resolveChoosingLand(rt, 'Plains');
					rt = roundTrip(rt);
					assert.equal(
						evaluatePermanent(rt, findIn(rt, 0, tower.instanceId)).effectiveTypeLine,
						'Land — Swamp Plains'
					);
					assert.deepEqual(
						permanentCouldProduceManaTypes(rt, rt.players[0], findIn(rt, 0, tower.instanceId), true),
						['W', 'B']
					);
				}

				// 4. Both timestamp orders against Blood Moon, Song of the Dryads, Imprisoned in the Moon, and Dryad of the Ilysian Grove
				for (const timedFirst of [true, false]) {
					// 4a. Blood Moon vs timed Island on Command Tower
					{
						const { state, p1 } = setupGame();
						p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
						const tower = putPerm(state, p1, v.tower);
						const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
						const islHand = putInZone(state, p1, 'hand', v.islandize);
						giveMana(p1, { R: 1, U: 1, C: 2 });
						const first = timedFirst ? islHand : bmHand;
						const second = timedFirst ? bmHand : islHand;
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: first.instanceId,
								...(first === islHand ? { targets: [permTarget(tower)] } : {})
							}).ok,
							true
						);
						resolveAllStack(state);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: second.instanceId,
								...(second === islHand ? { targets: [permTarget(tower)] } : {})
							}).ok,
							true
						);
						resolveAllStack(state);

						const rt = roundTrip(state);
						const rtTower = findIn(rt, 0, tower.instanceId);
						assert.equal(
							evaluatePermanent(rt, rtTower).effectiveTypeLine,
							timedFirst ? 'Land — Mountain' : 'Land — Island'
						);
						assert.deepEqual(
							permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true),
							[timedFirst ? 'R' : 'U']
						);
					}

					// 4b. Song of the Dryads vs timed Island on Command Tower
					{
						const { state, p1 } = setupGame();
						p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
						const tower = putPerm(state, p1, v.tower);
						const songHand = putInZone(state, p1, 'hand', v.song);
						const islHand = putInZone(state, p1, 'hand', v.islandize);
						giveMana(p1, { G: 1, U: 1, C: 2 });
						const first = timedFirst ? islHand : songHand;
						const second = timedFirst ? songHand : islHand;
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: first.instanceId,
								targets: [permTarget(tower)]
							}).ok,
							true
						);
						resolveAllStack(state);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: second.instanceId,
								targets: [permTarget(tower)]
							}).ok,
							true
						);
						resolveAllStack(state);

						const rt = roundTrip(state);
						const rtTower = findIn(rt, 0, tower.instanceId);
						assert.equal(
							evaluatePermanent(rt, rtTower).effectiveTypeLine,
							timedFirst ? 'Land — Forest' : 'Land — Island'
						);
						assert.deepEqual(
							permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true),
							[timedFirst ? 'G' : 'U']
						);
					}

					// 4c. Imprisoned in the Moon vs timed Island on Command Tower
					{
						const { state, p1 } = setupGame();
						p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
						const tower = putPerm(state, p1, v.tower);
						const impHand = putInZone(state, p1, 'hand', v.imprisoned);
						const islHand = putInZone(state, p1, 'hand', v.islandize);
						giveMana(p1, { U: 2, C: 2 });
						const first = timedFirst ? islHand : impHand;
						const second = timedFirst ? impHand : islHand;
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: first.instanceId,
								targets: [permTarget(tower)]
							}).ok,
							true
						);
						resolveAllStack(state);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: second.instanceId,
								targets: [permTarget(tower)]
							}).ok,
							true
						);
						resolveAllStack(state);

						const rt = roundTrip(state);
						const rtTower = findIn(rt, 0, tower.instanceId);
						assert.equal(
							evaluatePermanent(rt, rtTower).effectiveTypeLine,
							timedFirst ? 'Land' : 'Land — Island'
						);
						assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), ['C']);
					}

					// 4d. Dryad of the Ilysian Grove vs timed Island on Command Tower
					{
						const { state, p1 } = setupGame();
						p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
						const tower = putPerm(state, p1, v.tower);
						const dryadHand = putInZone(state, p1, 'hand', v.dryad);
						const islHand = putInZone(state, p1, 'hand', v.islandize);
						giveMana(p1, { G: 1, U: 1, C: 2 });
						const first = timedFirst ? islHand : dryadHand;
						const second = timedFirst ? dryadHand : islHand;
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: first.instanceId,
								...(first === islHand ? { targets: [permTarget(tower)] } : {})
							}).ok,
							true
						);
						resolveAllStack(state);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: second.instanceId,
								...(second === islHand ? { targets: [permTarget(tower)] } : {})
							}).ok,
							true
						);
						resolveAllStack(state);

						const rt = roundTrip(state);
						const rtTower = findIn(rt, 0, tower.instanceId);
						assert.deepEqual(
							permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true),
							timedFirst ? ['W', 'U', 'B', 'R', 'G'] : ['U']
						);
					}
				}

				// 5. Timed Island + Humility / Splendor Keeper on Dryad Arbor (+ Abundant Growth on Command Tower)
				for (const l6Kind of ['humility', 'keeper'] as const) {
					for (const timedFirst of [true, false]) {
						const { state, p1 } = setupGame();
						const arbor = putPerm(state, p1, v.dryadArbor);
						const l6Hand = putInZone(state, p1, 'hand', l6Kind === 'humility' ? v.humility : v.keeper);
						const islHand = putInZone(state, p1, 'hand', v.islandize);
						giveMana(p1, { W: 2, U: 1, C: 2 });
						const first = timedFirst ? islHand : l6Hand;
						const second = timedFirst ? l6Hand : islHand;
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: first.instanceId,
								...(first === islHand ? { targets: [permTarget(arbor)] } : {})
							}).ok,
							true
						);
						resolveAllStack(state);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: second.instanceId,
								...(second === islHand ? { targets: [permTarget(arbor)] } : {})
							}).ok,
							true
						);
						resolveAllStack(state);

						const rt = roundTrip(state);
						const rtArbor = findIn(rt, 0, arbor.instanceId);
						assert.equal(evaluatePermanent(rt, rtArbor).effectiveTypeLine, 'Land Creature — Island Dryad');
						assert.deepEqual(
							permanentCouldProduceManaTypes(rt, rt.players[0], rtArbor, true),
							l6Kind === 'humility' ? [] : ['U']
						);
					}
				}

				// Abundant Growth (ts1) + timed Island (ts2) on Command Tower -> retains Abundant Growth ['W','U','B','R','G']
				{
					const { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					const abHand = putInZone(state, p1, 'hand', v.abundant);
					const islHand = putInZone(state, p1, 'hand', v.islandize);
					giveMana(p1, { G: 1, U: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: abHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: islHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					resolveAllStack(state);

					const rt = roundTrip(state);
					const rtTower = findIn(rt, 0, tower.instanceId);
					assert.equal(evaluatePermanent(rt, rtTower).effectiveTypeLine, 'Land — Island');
					assert.deepEqual(permanentCouldProduceManaTypes(rt, rt.players[0], rtTower, true), [
						'W',
						'U',
						'B',
						'R',
						'G'
					]);
				}
			}
		});

		it('M5 Iter 12 Part A.1: Backup-granted death-LKI keywords (Afterlife 2, Modular 1, Undying, Persist) & quoted EOT triggers resolve without guided_resolution (canonical + cloneRenamed)', () => {
			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const baseAfterlifeMentor = synthCard({
				name: 'Orzhov Mentor',
				manaCost: '{1}{W}{B}',
				cmc: 3,
				colors: ['W', 'B'],
				typeLine: 'Creature — Human Cleric',
				power: '2',
				toughness: '2',
				oracleText: 'Backup 1\nAfterlife 2'
			});
			const baseAfterlifeInnate = synthCard({
				name: 'Syndicate Thrull',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Creature — Thrull',
				power: '1',
				toughness: '2',
				oracleText: 'Afterlife 1'
			});
			const baseModularMentor = synthCard({
				name: 'Arcbound Mentor',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nModular 1'
			});
			const baseArtifactBuddy = synthCard({
				name: 'Brass Automaton',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Golem',
				power: '2',
				toughness: '2'
			});
			const baseUndyingMentor = synthCard({
				name: 'Dusk Mentor',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Creature — Zombie',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nUndying'
			});
			const basePersistMentor = synthCard({
				name: 'Gloom Mentor',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Creature — Spirit',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nPersist'
			});
			const baseShrink = synthCard({
				name: 'Wither Grasp',
				manaCost: '{B}',
				cmc: 1,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Target creature gets -4/-4 until end of turn.'
			});
			const baseQuotedProwess = synthCard({
				name: 'Scroll of Focus',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains "prowess" until end of turn.'
			});
			const baseQuotedAfterlife = synthCard({
				name: 'Scroll of Spirits',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains "afterlife 2" until end of turn.'
			});
			const baseQuotedUndying = synthCard({
				name: 'Scroll of Undeath',
				manaCost: '{B}',
				cmc: 1,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains "undying" until end of turn.'
			});
			const baseFlightGrant = synthCard({
				name: 'Wind Surge',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains flying until end of turn.'
			});
			const baseFlashHumility = synthCard({
				name: 'Flash Humility',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				colors: ['W'],
				typeLine: 'Enchantment',
				oracleText: 'Flash\nAll creatures lose all abilities and have base power and toughness 1/1.'
			});
			const realDryadArbor = realCard('Dryad Arbor');
			const realBloodMoon = realCard('Blood Moon');
			const realHumility = realCard('Humility');

			const variants = [
				{
					bear: baseBear,
					afterlifeMentor: baseAfterlifeMentor,
					afterlifeInnate: baseAfterlifeInnate,
					modularMentor: baseModularMentor,
					artifactBuddy: baseArtifactBuddy,
					undyingMentor: baseUndyingMentor,
					persistMentor: basePersistMentor,
					shrink: baseShrink,
					quotedProwess: baseQuotedProwess,
					quotedAfterlife: baseQuotedAfterlife,
					quotedUndying: baseQuotedUndying,
					flightGrant: baseFlightGrant,
					flashHumility: baseFlashHumility,
					dryadArbor: realDryadArbor,
					bloodMoon: realBloodMoon,
					humility: realHumility
				},
				{
					bear: cloneRenamed(baseBear, 'Timber Ursine'),
					afterlifeMentor: cloneRenamed(baseAfterlifeMentor, 'Spirit Guide'),
					afterlifeInnate: cloneRenamed(baseAfterlifeInnate, 'Debt Collector'),
					modularMentor: cloneRenamed(baseModularMentor, 'Forge Instructor'),
					artifactBuddy: cloneRenamed(baseArtifactBuddy, 'Copper Sentinel'),
					undyingMentor: cloneRenamed(baseUndyingMentor, 'Crypt Tutor'),
					persistMentor: cloneRenamed(basePersistMentor, 'Ash Tutor'),
					shrink: cloneRenamed(baseShrink, 'Blight Snare'),
					quotedProwess: cloneRenamed(baseQuotedProwess, 'Tome of Mastery'),
					quotedAfterlife: cloneRenamed(baseQuotedAfterlife, 'Tome of Ghosts'),
					quotedUndying: cloneRenamed(baseQuotedUndying, 'Tome of Return'),
					flightGrant: cloneRenamed(baseFlightGrant, 'Gale Charm'),
					flashHumility: cloneRenamed(baseFlashHumility, 'Sudden Meekness'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Forest Sprite'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Lunar'),
					humility: cloneRenamed(realHumility, 'Meekness Field')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const runCleanChain = (
				initial: GameState,
				opts: { backupTargetId?: string; objectTargetId?: string; seenStackCounts?: number[] } = {}
			): GameState => {
				let state = initial;
				for (let guard = 0; guard < 120; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						const prm = state.pendingPrompts[0];
						assert.notEqual(
							prm.kind,
							'guided_resolution',
							`Unexpected guided_resolution prompt: ${prm.title}`
						);
						if (prm.choice?.kind === 'orderObjects') {
							opts.seenStackCounts?.push(prm.choice.objectIds.length);
							answerTopPrompt(state, {
								kind: 'orderObjects',
								topIds: prm.choice.objectIds,
								bottomIds: []
							});
						} else if (prm.choice?.kind === 'chooseObjects') {
							const cands = prm.choice.candidates;
							const pick =
								opts.backupTargetId && cands.includes(opts.backupTargetId)
									? opts.backupTargetId
									: opts.objectTargetId && cands.includes(opts.objectTargetId)
										? opts.objectTargetId
										: cands[0];
							answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [pick] });
						} else if (prm.choice?.kind === 'yesNo') {
							answerTopPrompt(state, { kind: 'yesNo', yes: true });
						} else {
							assert.fail(`Unexpected prompt kind: ${prm.choice?.kind} (${prm.title})`);
						}
					} else {
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
				assert.fail('runCleanChain exceeded guard');
			};

			for (const v of variants) {
				assert.equal(definitionSupportReport(compileCard(v.afterlifeMentor)).fullySupported, true);
				assert.equal(definitionSupportReport(compileCard(v.modularMentor)).fullySupported, true);

				// 1. Backup 1\nAfterlife 2 across standalone, Blood Moon, earlier Humility, later Humility, double/innate+Backup
				for (const regime of [
					'standalone',
					'bloodMoon',
					'humilityBefore',
					'humilityAfter',
					'innatePlusBackup'
				] as const) {
					let { state, p1 } = setupGame();
					const recipient =
						regime === 'bloodMoon'
							? putPerm(state, p1, v.dryadArbor)
							: regime === 'innatePlusBackup'
								? putPerm(state, p1, v.afterlifeInnate)
								: putPerm(state, p1, v.bear);
					if (regime === 'bloodMoon') {
						const bmHand = putInZone(state, state.players[0], 'hand', v.bloodMoon);
						giveMana(state.players[0], { R: 1, C: 2 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: bmHand.instanceId
							}).ok,
							true
						);
						state = runCleanChain(state);
					}
					const mentorHand = putInZone(state, state.players[0], 'hand', v.afterlifeMentor);
					giveMana(state.players[0], { W: 1, B: 1, C: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: mentorHand.instanceId
						}).ok,
						true
					);
					if (regime === 'humilityBefore') {
						// Re-setup cleanly with Flash Humility cast in response to Backup ETB trigger
						({ state, p1 } = setupGame());
						const bear2 = putPerm(state, p1, v.bear);
						const m2 = putInZone(state, p1, 'hand', v.afterlifeMentor);
						const fhHand = putInZone(state, p1, 'hand', v.flashHumility);
						giveMana(p1, { W: 3, B: 1, C: 3 });
						assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: m2.instanceId }).ok, true);
						// Resolve creature spell so Backup ETB trigger hits stack and target prompt resolves
						for (let guard = 0; guard < 30; guard++) {
							state = roundTrip(state);
							if (state.pendingPrompts.length > 0) {
								const prm = state.pendingPrompts[0];
								assert.equal(prm.choice?.kind, 'chooseObjects');
								answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [bear2.instanceId] });
								break;
							}
							const pr = state.players[state.priorityPlayerIndex];
							assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
						}
						// Cast Flash Humility on top of Backup ETB trigger -> ts(Backup) > ts(Humility)
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: fhHand.instanceId
							}).ok,
							true
						);
						state = runCleanChain(state);
						const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
						giveMana(state.players[0], { B: 1 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: shrinkHand.instanceId,
								targets: [permTarget(findIn(state, 0, bear2.instanceId))]
							}).ok,
							true
						);
						state = runCleanChain(state);
						const spirits = state.players[0].battlefield.filter((c) => c.isToken && c.card.name.includes('Spirit'));
						assert.equal(spirits.length, 2, 'Earlier Humility should keep ts_backup > ts_humility Afterlife 2');
						continue;
					}
					state = runCleanChain(state, { backupTargetId: recipient.instanceId });
					const liveRec = findIn(state, 0, recipient.instanceId);
					const ev = evaluatePermanent(state, liveRec);
					assert.ok(
						ev.keywords.includes('Afterlife 2'),
						`Expected 'Afterlife 2' in ev.keywords, got ${JSON.stringify(ev.keywords)}`
					);
					assert.equal(ev.keywords.includes('Afterlife'), false);

					if (regime === 'humilityAfter') {
						const humHand = putInZone(state, state.players[0], 'hand', v.humility);
						giveMana(state.players[0], { W: 2, C: 2 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: humHand.instanceId
							}).ok,
							true
						);
						state = runCleanChain(state);
					}
					const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
					giveMana(state.players[0], { B: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(findIn(state, 0, recipient.instanceId))]
						}).ok,
						true
					);
					state = runCleanChain(state);
					const spirits = state.players[0].battlefield.filter((c) => c.isToken && c.card.name.includes('Spirit'));
					const expectedSpirits = regime === 'humilityAfter' ? 0 : regime === 'innatePlusBackup' ? 3 : 2;
					assert.equal(spirits.length, expectedSpirits, `Regime ${regime} expected ${expectedSpirits} Spirits`);
				}

				// 2. Backup 1\nModular 1 transfers all +1/+1 counters (existing + Backup) onto Artifact Creature target
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					bear.counters['+1/+1'] = 1;
					const buddy = putPerm(state, p1, v.artifactBuddy);
					const modHand = putInZone(state, p1, 'hand', v.modularMentor);
					giveMana(p1, { C: 2 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: modHand.instanceId }).ok, true);
					state = runCleanChain(state, { backupTargetId: bear.instanceId });
					const evBear = evaluatePermanent(state, findIn(state, 0, bear.instanceId));
					assert.ok(evBear.keywords.includes('Modular 1'), `Expected Modular 1, got ${JSON.stringify(evBear.keywords)}`);
					assert.equal(findIn(state, 0, bear.instanceId).counters['+1/+1'], 2);

					const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
					giveMana(state.players[0], { B: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = runCleanChain(state, { objectTargetId: buddy.instanceId });
					assert.equal(findIn(state, 0, buddy.instanceId).counters['+1/+1'], 2);
				}

				// 3. Backup 1\nUndying & Backup 1\nPersist return exactly once when counterless, 0 times with counter
				for (const kind of ['undying', 'persist'] as const) {
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mentorHand = putInZone(state, p1, 'hand', kind === 'undying' ? v.undyingMentor : v.persistMentor);
					giveMana(p1, { B: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mentorHand.instanceId }).ok, true);
					state = runCleanChain(state, { backupTargetId: bear.instanceId });
					const liveBear = findIn(state, 0, bear.instanceId);
					if (kind === 'undying') {
						liveBear.counters['+1/+1'] = 0;
					}
					const shrink1 = putInZone(state, state.players[0], 'hand', v.shrink);
					giveMana(state.players[0], { B: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrink1.instanceId,
							targets: [permTarget(liveBear)]
						}).ok,
						true
					);
					state = runCleanChain(state);
					const returned = state.players[0].battlefield.filter((c) => c.card.name === v.bear.name);
					assert.equal(returned.length, 1, `Expected 1 returned Bear for ${kind}`);
					assert.equal(returned[0].counters[kind === 'undying' ? '+1/+1' : '-1/-1'], 1);

					// Kill again while counter is present -> stays in graveyard (0 returns)
					const shrink2 = putInZone(state, state.players[0], 'hand', v.shrink);
					giveMana(state.players[0], { B: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrink2.instanceId,
							targets: [permTarget(returned[0])]
						}).ok,
						true
					);
					state = runCleanChain(state);
					assert.equal(state.players[0].battlefield.filter((c) => c.card.name === v.bear.name).length, 0);
				}

				// 4. Quoted EOT (quoted_eot:) "prowess" (standalone & with unrelated timed keyword), "afterlife 2", "undying"
				for (const withExtraFlight of [false, true]) {
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const qpHand = putInZone(state, p1, 'hand', v.quotedProwess);
					giveMana(p1, { U: withExtraFlight ? 2 : 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: qpHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = runCleanChain(state);
					if (withExtraFlight) {
						const flHand = putInZone(state, state.players[0], 'hand', v.flightGrant);
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: flHand.instanceId,
								targets: [permTarget(findIn(state, 0, bear.instanceId))]
							}).ok,
							true
						);
						state = runCleanChain(state);
					}
					const seenCounts: number[] = [];
					const spellHand = putInZone(state, state.players[0], 'hand', v.flightGrant);
					giveMana(state.players[0], { U: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: spellHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					// Only 1 Prowess trigger -> never emits orderObjects (would only occur on >=2 simultaneous triggers)
					state = runCleanChain(state, { seenStackCounts: seenCounts });
					assert.equal(seenCounts.length, 0, 'Quoted prowess should trigger once, not twice');
					assert.equal(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power, withExtraFlight ? 4 : 3);
					if (withExtraFlight) {
						assert.ok(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords.includes('Flying'));
					}
				}
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const qaHand = putInZone(state, p1, 'hand', v.quotedAfterlife);
					giveMana(p1, { W: 1, B: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: qaHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = runCleanChain(state);
					const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = runCleanChain(state);
					assert.equal(state.players[0].battlefield.filter((c) => c.isToken && c.card.name.includes('Spirit')).length, 2);
				}
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const quHand = putInZone(state, p1, 'hand', v.quotedUndying);
					giveMana(p1, { B: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: quHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = runCleanChain(state);
					const shrinkHand = putInZone(state, state.players[0], 'hand', v.shrink);
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: shrinkHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = runCleanChain(state);
					const returned = state.players[0].battlefield.filter((c) => c.card.name === v.bear.name);
					assert.equal(returned.length, 1);
					assert.equal(returned[0].counters['+1/+1'], 1);
				}
			}
		});

		it('M5 Iter 12 Part A.2: Backup-granted battlefield & parameterized keywords (Prowess, Battle cry, Exalted, Extort, Ward {2}, Mobilize 2, Frenzy 2, Bushido 2, Annihilator 2, Hideous Taskmaster, Protection/Hexproof) resolve cleanly without double triggers or guided_resolution (canonical + cloneRenamed)', () => {
			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const baseProwessMentor = synthCard({
				name: 'Monk Mentor',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Human Monk',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nProwess'
			});
			const baseBattleCryMentor = synthCard({
				name: 'Accorder Mentor',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Creature — Human Knight',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nBattle cry'
			});
			const baseExaltedMentor = synthCard({
				name: 'Bant Mentor',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Creature — Human Knight',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nExalted'
			});
			const baseExtortMentor = synthCard({
				name: 'Basilica Mentor',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Creature — Human Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nExtort'
			});
			const baseWardMentor = synthCard({
				name: 'Aegis Mentor',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Human Wizard',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nWard {2}'
			});
			const baseMobilizeMentor = synthCard({
				name: 'Mardu Mentor',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				typeLine: 'Creature — Human Warrior',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nMobilize 2'
			});
			const baseFrenzyMentor = synthCard({
				name: 'Reckless Mentor',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				typeLine: 'Creature — Goblin',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nFrenzy 2'
			});
			const baseBushidoMentor = synthCard({
				name: 'Samurai Mentor',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Creature — Human Samurai',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nBushido 2'
			});
			const baseAnnihilatorMentor = synthCard({
				name: 'Eldrazi Mentor',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Eldrazi',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nAnnihilator 2'
			});
			const baseTaskmaster = synthCard({
				name: 'Hideous Taskmaster',
				manaCost: '{5}{R}{R}',
				cmc: 7,
				colors: ['R'],
				typeLine: 'Creature — Eldrazi',
				power: '7',
				toughness: '2',
				oracleText:
					'When you cast this spell, gain control of target creature an opponent controls until end of turn. Untap that creature. It gains trample, haste, and "Annihilator 1" until end of turn.'
			});
			const baseProMentor = synthCard({
				name: 'Wardens of Grace',
				manaCost: '{2}{W}',
				cmc: 3,
				colors: ['W'],
				typeLine: 'Creature — Human',
				power: '2',
				toughness: '2',
				oracleText: 'Backup 1\nProtection from red\nHexproof from black'
			});
			const basePing = synthCard({
				name: 'Instant Ping',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: '~ deals 1 damage to target player.'
			});
			const baseShock = synthCard({
				name: 'Flame Jab',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: '~ deals 2 damage to target creature.'
			});
			const baseChump = synthCard({
				name: 'Squire Guard',
				manaCost: '{W}',
				cmc: 1,
				colors: ['W'],
				typeLine: 'Creature — Human',
				power: '1',
				toughness: '1'
			});
			const realBloodMoon = realCard('Blood Moon');
			const realHumility = realCard('Humility');

			const variants = [
				{
					bear: baseBear,
					prowessMentor: baseProwessMentor,
					battleCryMentor: baseBattleCryMentor,
					exaltedMentor: baseExaltedMentor,
					extortMentor: baseExtortMentor,
					wardMentor: baseWardMentor,
					mobilizeMentor: baseMobilizeMentor,
					frenzyMentor: baseFrenzyMentor,
					bushidoMentor: baseBushidoMentor,
					annihilatorMentor: baseAnnihilatorMentor,
					taskmaster: baseTaskmaster,
					proMentor: baseProMentor,
					ping: basePing,
					shock: baseShock,
					chump: baseChump,
					bloodMoon: realBloodMoon,
					humility: realHumility
				},
				{
					bear: cloneRenamed(baseBear, 'Timber Ursine'),
					prowessMentor: cloneRenamed(baseProwessMentor, 'Adept Tutor'),
					battleCryMentor: cloneRenamed(baseBattleCryMentor, 'Banner Tutor'),
					exaltedMentor: cloneRenamed(baseExaltedMentor, 'Champion Tutor'),
					extortMentor: cloneRenamed(baseExtortMentor, 'Tithe Tutor'),
					wardMentor: cloneRenamed(baseWardMentor, 'Shield Tutor'),
					mobilizeMentor: cloneRenamed(baseMobilizeMentor, 'Raid Tutor'),
					frenzyMentor: cloneRenamed(baseFrenzyMentor, 'Fury Tutor'),
					bushidoMentor: cloneRenamed(baseBushidoMentor, 'Blade Tutor'),
					annihilatorMentor: cloneRenamed(baseAnnihilatorMentor, 'Void Tutor'),
					taskmaster: cloneRenamed(baseTaskmaster, 'Dread Overseer'),
					proMentor: cloneRenamed(baseProMentor, 'Sanctum Tutor'),
					ping: cloneRenamed(basePing, 'Spark Bolt'),
					shock: cloneRenamed(baseShock, 'Ember Bolt'),
					chump: cloneRenamed(baseChump, 'Village Watch'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Lunar'),
					humility: cloneRenamed(realHumility, 'Meekness Field')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const drainStack = (
				initial: GameState,
				opts: {
					backupTargetId?: string;
					orderTriggerCounts?: number[];
					declineWard?: boolean;
					yesNoAccept?: boolean;
					sacrificeIds?: string[];
				} = {}
			): GameState => {
				let state = initial;
				for (let guard = 0; guard < 120; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						const prm = state.pendingPrompts[0];
						assert.notEqual(
							prm.kind,
							'guided_resolution',
							`Unexpected guided_resolution prompt: ${prm.title}`
						);
						if (prm.choice?.kind === 'orderObjects') {
							opts.orderTriggerCounts?.push(prm.choice.objectIds.length);
							answerTopPrompt(state, {
								kind: 'orderObjects',
								topIds: prm.choice.objectIds,
								bottomIds: []
							});
						} else if (prm.choice?.kind === 'chooseObjects') {
							const cands = prm.choice.candidates;
							if (prm.choice.min === 2 && cands.length >= 2) {
								answerTopPrompt(state, {
									kind: 'chooseObjects',
									objectIds: cands.slice(0, 2)
								});
							} else {
								const pick =
									opts.backupTargetId && cands.includes(opts.backupTargetId)
										? opts.backupTargetId
										: cands[0];
								answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [pick] });
							}
						} else if (prm.choice?.kind === 'yesNo') {
							answerTopPrompt(state, {
								kind: 'yesNo',
								yes: opts.yesNoAccept ?? !opts.declineWard
							});
						} else {
							assert.fail(`Unexpected prompt kind: ${prm.choice?.kind} (${prm.title})`);
						}
					} else {
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
				assert.fail('drainStack exceeded guard');
			};
			const advanceToPhase = (
				initial: GameState,
				targetPhase: GameState['phase'],
				opts: Parameters<typeof drainStack>[1] = {}
			): GameState => {
				let state = initial;
				for (let guard = 0; guard < 200; guard++) {
					state = drainStack(state, opts);
					if (state.phase === targetPhase && state.stack.length === 0 && state.pendingPrompts.length === 0) {
						return state;
					}
					const pr = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
				}
				assert.fail(`advanceToPhase(${targetPhase}) exceeded guard`);
			};

			for (const v of variants) {
				// 1. Backup 1\nProwess -> 2 triggers total (donor + Bear), Bear reaches 4 power, Humility suppresses
				{
					let { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.prowessMentor);
					giveMana(p1, { U: 1, R: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });

					const pHand = putInZone(state, state.players[0], 'hand', v.ping);
					const triggerCounts: number[] = [];
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: pHand.instanceId,
							targets: [playerTarget(state.players[1])]
						}).ok,
						true
					);
					state = drainStack(state, { orderTriggerCounts: triggerCounts });
					assert.deepEqual(triggerCounts, [2], 'Expected exactly 2 Prowess triggers (donor + Bear)');
					assert.equal(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power, 4);

					// Later Humility suppresses Prowess
					const humHand = putInZone(state, state.players[0], 'hand', v.humility);
					const pHand2 = putInZone(state, state.players[0], 'hand', v.ping);
					giveMana(state.players[0], { W: 2, R: 1, C: 2 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: humHand.instanceId
						}).ok,
						true
					);
					state = drainStack(state);
					const powerUnderHumilityBeforePing2 = evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power;
					assert.equal(powerUnderHumilityBeforePing2, 4);
					const humCounts: number[] = [];
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: pHand2.instanceId,
							targets: [playerTarget(state.players[1])]
						}).ok,
						true
					);
					state = drainStack(state, { orderTriggerCounts: humCounts });
					assert.equal(humCounts.length, 0);
					assert.equal(
						evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power,
						powerUnderHumilityBeforePing2
					);
				}

				// 2. Backup 1\nBattle cry -> 2 triggers total when donor + Bear attack together
				{
					let { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.battleCryMentor);
					giveMana(p1, { W: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					const mentorBf = state.players[0].battlefield.find((c) => c.card.name === v.battleCryMentor.name)!;
					mentorBf.summoningSick = false;
					state = advanceToPhase(state, 'declare_attackers');
					const atkCounts: number[] = [];
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [
								{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId },
								{ attackerInstanceId: mentorBf.instanceId, defenderPlayerId: p2.playerId }
							]
						}).ok,
						true
					);
					state = drainStack(state, { orderTriggerCounts: atkCounts });
					assert.deepEqual(atkCounts, [2]);
					assert.equal(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power, 4);
					assert.equal(evaluatePermanent(state, findIn(state, 0, mentorBf.instanceId)).power, 2);
				}

				// 3. Backup 1\nExalted -> Bear attacks alone -> 2 triggers (+2/+2)
				{
					let { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.exaltedMentor);
					giveMana(p1, { W: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					state = advanceToPhase(state, 'declare_attackers');
					const atkCounts: number[] = [];
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					state = drainStack(state, { orderTriggerCounts: atkCounts });
					assert.deepEqual(atkCounts, [2]);
					assert.equal(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power, 5);
				}

				// 4. Backup 1\nExtort -> 2 triggers when casting spell, drains 2 total when paying {W/B}
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.extortMentor);
					giveMana(p1, { W: 3, R: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					const pHand = putInZone(state, state.players[0], 'hand', v.ping);
					const extortCounts: number[] = [];
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: pHand.instanceId,
							targets: [playerTarget(state.players[1])]
						}).ok,
						true
					);
					state = drainStack(state, { orderTriggerCounts: extortCounts, yesNoAccept: true });
					assert.deepEqual(extortCounts, [2]);
					assert.equal(state.players[0].life, 22);
					assert.equal(state.players[1].life, 17); // 20 - 2 extort - 1 ping
				}

				// 5. Backup 1\nWard {2} -> ev.keywords has 'Ward {2}', single Ward trigger counters spell when P2 cannot/declines {2}
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.wardMentor);
					giveMana(p1, { U: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					const evBear = evaluatePermanent(state, findIn(state, 0, bear.instanceId));
					assert.ok(evBear.keywords.includes('Ward {2}'), `Expected Ward {2}, got ${JSON.stringify(evBear.keywords)}`);

					// Pass priority to P2 in main1 so P2 can cast Shock targeting Bear (with insufficient mana {1} for Ward {2})
					const pr = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					const p2Shock = putInZone(state, state.players[1], 'hand', v.shock);
					giveMana(state.players[1], { R: 1, C: 1 }); // only {1} left after {R}, cannot pay Ward {2}!
					assert.equal(
						applyGameAction(state, state.players[1].playerId, {
							type: 'cast_spell',
							instanceId: p2Shock.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					const wardOrderCounts: number[] = [];
					state = drainStack(state, { orderTriggerCounts: wardOrderCounts, declineWard: true });
					assert.equal(wardOrderCounts.length, 0, 'Ward {2} must trigger only once');
					assert.equal(findIn(state, 0, bear.instanceId).damageMarked, 0, 'Spell should be countered by Ward {2}');
					assert.equal(state.players[1].manaPool.C, 1, 'Ward {2} must not settle for {1}');
					assert.ok(state.players[1].graveyard.some((c) => c.instanceId === p2Shock.instanceId));
				}

				// 6. Backup 1\nMobilize 2 -> ev.keywords has 'Mobilize 2', creates 2 Warrior tokens (1 trigger)
				{
					let { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.mobilizeMentor);
					giveMana(p1, { R: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					assert.ok(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords.includes('Mobilize 2'));
					state = advanceToPhase(state, 'declare_attackers');
					const mobCounts: number[] = [];
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					state = drainStack(state, { orderTriggerCounts: mobCounts });
					assert.equal(mobCounts.length, 0, 'Mobilize 2 should trigger once');
					const warriors = state.players[0].battlefield.filter((c) => c.card.name.includes('Warrior'));
					assert.equal(warriors.length, 2, 'Mobilize 2 should create 2 Warrior tokens');
				}

				// 7. Backup 1\nFrenzy 2 -> ev.keywords has 'Frenzy 2', Bear attacking unblocked gets +2/+0 (5 power)
				{
					let { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.frenzyMentor);
					giveMana(p1, { R: 1, C: 1 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					assert.ok(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords.includes('Frenzy 2'));
					state = advanceToPhase(state, 'declare_attackers');
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					state = advanceToPhase(state, 'declare_blockers');
					assert.equal(
						applyGameAction(state, state.players[1].playerId, { type: 'declare_blockers', assignments: [] }).ok,
						true
					);
					const frenzyCounts: number[] = [];
					state = drainStack(state, { orderTriggerCounts: frenzyCounts });
					assert.equal(frenzyCounts.length, 0, 'Frenzy 2 should trigger once');
					assert.equal(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power, 5);
				}

				// 8. Backup 1\nBushido 2 -> ev.keywords has 'Bushido 2', single +2/+2 trigger on block (5/5), respects Blood Moon & Humility
				for (const regime of ['standalone', 'bloodMoon', 'humility'] as const) {
					let { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const chump = putPerm(state, p2, v.chump);
					if (regime === 'bloodMoon') {
						const bmHand = putInZone(state, state.players[0], 'hand', v.bloodMoon);
						giveMana(state.players[0], { R: 1, C: 2 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: bmHand.instanceId
							}).ok,
							true
						);
						state = drainStack(state);
					}
					const mHand = putInZone(state, state.players[0], 'hand', v.bushidoMentor);
					giveMana(state.players[0], { W: 1, C: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: mHand.instanceId
						}).ok,
						true
					);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					assert.ok(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords.includes('Bushido 2'));
					if (regime === 'humility') {
						const hHand = putInZone(state, state.players[0], 'hand', v.humility);
						giveMana(state.players[0], { W: 2, C: 2 });
						assert.equal(
							applyGameAction(state, state.players[0].playerId, {
								type: 'cast_spell',
								instanceId: hHand.instanceId
							}).ok,
							true
						);
						state = drainStack(state);
					}
					state = advanceToPhase(state, 'declare_attackers');
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					state = advanceToPhase(state, 'declare_blockers');
					assert.equal(
						applyGameAction(state, state.players[1].playerId, {
							type: 'declare_blockers',
							assignments: [{ blockerInstanceId: chump.instanceId, attackerInstanceId: bear.instanceId }]
						}).ok,
						true
					);
					const bushidoCounts: number[] = [];
					state = drainStack(state, { orderTriggerCounts: bushidoCounts });
					assert.equal(bushidoCounts.length, 0, 'Bushido 2 should trigger at most once');
					assert.equal(
						evaluatePermanent(state, findIn(state, 0, bear.instanceId)).power,
						regime === 'humility' ? 2 : 5
					);
				}

				// 9. Backup 1\nAnnihilator 2 & Hideous Taskmaster (grantedAbilityTexts: ['Annihilator 1'])
				{
					let { state, p1, p2 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const f1 = putPerm(state, p2, v.chump);
					const f2 = putPerm(state, p2, v.chump);
					const mHand = putInZone(state, p1, 'hand', v.annihilatorMentor);
					giveMana(p1, { C: 2 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					assert.ok(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords.includes('Annihilator 2'));
					state = advanceToPhase(state, 'declare_attackers');
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					state = drainStack(state);
					assert.equal(state.players[1].battlefield.length, 0, 'Annihilator 2 should force sacrifice of 2 permanents');
					void f1;
					void f2;
				}
				{
					let { state, p1, p2 } = setupGame();
					const oppBear = putPerm(state, p2, v.bear);
					const fodder = putPerm(state, p2, v.chump);
					const tmHand = putInZone(state, p1, 'hand', v.taskmaster);
					giveMana(p1, { R: 2, C: 5 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tmHand.instanceId
						}).ok,
						true
					);
					state = drainStack(state, { backupTargetId: oppBear.instanceId });
					assert.ok(evaluatePermanent(state, findIn(state, 0, oppBear.instanceId)).keywords.includes('Annihilator 1'));
					state = advanceToPhase(state, 'declare_attackers');
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: oppBear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
					state = drainStack(state);
					assert.equal(
						state.players[1].battlefield.some((c) => c.instanceId === fodder.instanceId),
						false,
						'Hideous Taskmaster Annihilator 1 should sacrifice defending permanent'
					);
				}

				// 10. Backup 1\nProtection from red\nHexproof from black preserves parameters in ev.keywords
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const pHand = putInZone(state, p1, 'hand', v.proMentor);
					giveMana(p1, { W: 1, C: 2 });
					assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: pHand.instanceId }).ok, true);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					const kws = evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords;
					assert.ok(kws.includes('Protection from red'), `Got ${JSON.stringify(kws)}`);
					assert.ok(kws.includes('Hexproof from black'), `Got ${JSON.stringify(kws)}`);
				}
			}
		});

		it('M5 Iter 12 Part B: Layer 4 Pass B/C Ashaya + timed land types/subtypes, CR 205.3d post-Ashaya cleanup, Mirage/Tidal Shift both orders, and Dryad Arbor + Ashaya + Tidal Shift + Elkify (canonical + cloneRenamed)', () => {
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const baseElves = synthCard({
				name: 'Llanowar Elves',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Creature — Elf Druid',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {G}.'
			});
			const baseTidalShift = synthCard({
				name: 'Tidal Shift',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes an Island until end of turn.'
			});
			const baseSwampShift = synthCard({
				name: 'Swamp Shift',
				manaCost: '{B}',
				cmc: 1,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes a Swamp until end of turn.'
			});
			const baseLandify = synthCard({
				name: 'Geomancer Rite',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature becomes a land in addition to its other types until end of turn.'
			});
			const baseElkify = synthCard({
				name: 'Beast Transmute',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature becomes a green Elk creature with base power and toughness 3/3 until end of turn.'
			});
			const baseMirage = synthCard({
				name: 'Convincing Mirage',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant land\nAs Convincing Mirage enters, choose a basic land type.\nEnchanted land is the chosen type.'
			});
			const baseMurder = synthCard({
				name: 'Murder',
				manaCost: '{1}{B}{B}',
				cmc: 3,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			});
			const realDryadArbor = realCard('Dryad Arbor');

			const variants = [
				{
					ashaya: baseAshaya,
					bear: baseBear,
					elves: baseElves,
					tidalShift: baseTidalShift,
					swampShift: baseSwampShift,
					landify: baseLandify,
					elkify: baseElkify,
					mirage: baseMirage,
					murder: baseMurder,
					dryadArbor: realDryadArbor
				},
				{
					ashaya: cloneRenamed(baseAshaya, 'Grove Animist'),
					bear: cloneRenamed(baseBear, 'Timber Ursine'),
					elves: cloneRenamed(baseElves, 'Forest Mystic'),
					tidalShift: cloneRenamed(baseTidalShift, 'Wave Shift'),
					swampShift: cloneRenamed(baseSwampShift, 'Mire Shift'),
					landify: cloneRenamed(baseLandify, 'Terrain Blessing'),
					elkify: cloneRenamed(baseElkify, 'Stag Form'),
					mirage: cloneRenamed(baseMirage, 'Illusory Terrain'),
					murder: cloneRenamed(baseMurder, 'Fatal Strike'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Forest Sprite')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const resolveWithMode = (initial: GameState, chosenMode?: string): GameState => {
				let state = initial;
				for (let guard = 0; guard < 80; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						const prm = state.pendingPrompts[0];
						if (prm.choice?.kind === 'chooseMode' && chosenMode) {
							const idx = prm.choice.modes.indexOf(chosenMode);
							answerTopPrompt(state, { kind: 'chooseMode', indices: [idx >= 0 ? idx : 0] });
						} else {
							assert.fail(`Unexpected prompt: ${prm.choice?.kind} (${prm.title})`);
						}
					} else {
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
				assert.fail('resolveWithMode exceeded guard');
			};

			for (const v of variants) {
				// 1. Ashaya (ts1) + Elves & Bear + timed Tidal Shift (ts2) -> CR 305.7 strips Forest & {T}:Add{G}; Murder on Ashaya -> CR 205.3d strips Island & restores {T}:Add{G}
				{
					let { state, p1 } = setupGame();
					const ashaya = putPerm(state, p1, v.ashaya);
					const elves = putPerm(state, p1, v.elves);
					const bear = putPerm(state, p1, v.bear);
					state.nextTimestamp = nextTestTs + 100;
					const tsElves = putInZone(state, p1, 'hand', v.tidalShift);
					const tsBear = putInZone(state, p1, 'hand', v.tidalShift);
					const murderHand = putInZone(state, p1, 'hand', v.murder);
					giveMana(p1, { U: 2, B: 2, C: 1 });

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsElves.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = resolveWithMode(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsBear.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = resolveWithMode(state);

					const rtElves = findIn(state, 0, elves.instanceId);
					const rtBear = findIn(state, 0, bear.instanceId);
					const evElves = evaluatePermanent(state, rtElves);
					const evBear = evaluatePermanent(state, rtBear);
					assert.equal(evElves.effectiveTypeLine, 'Creature Land — Island Elf Druid');
					assert.equal(evElves.losesAllAbilities, true);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElves, true), ['U']);
					assert.deepEqual(
						getEffectiveActivatedAbilities(state, state.players[0], rtElves).map((a) => a.id),
						['granted_mana_u']
					);
					assert.equal(evBear.effectiveTypeLine, 'Creature Land — Island Bear');
					assert.equal(evBear.losesAllAbilities, true);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtBear, true), ['U']);

					// Destroy Ashaya -> both revert to non-Lands and CR 205.3d strips 'Island'
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: murderHand.instanceId,
							targets: [permTarget(findIn(state, 0, ashaya.instanceId))]
						}).ok,
						true
					);
					state = resolveWithMode(state);
					const afterElves = findIn(state, 0, elves.instanceId);
					const afterBear = findIn(state, 0, bear.instanceId);
					assert.equal(evaluatePermanent(state, afterElves).effectiveTypeLine, 'Creature — Elf Druid');
					assert.equal(evaluatePermanent(state, afterElves).losesAllAbilities, false);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], afterElves, true), ['G']);
					assert.ok(
						getEffectiveActivatedAbilities(state, state.players[0], afterElves).some((a) =>
							a.id.startsWith('mana_tap')
						)
					);
					assert.equal(evaluatePermanent(state, afterBear).effectiveTypeLine, 'Creature — Bear');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], afterBear, true), []);
				}

				// 2. Timed addTypes: ['Land'] (ts1) + Elves + Tidal Shift (ts2)
				{
					let { state, p1 } = setupGame();
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const landHand = putInZone(state, p1, 'hand', v.landify);
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					giveMana(p1, { G: 1, U: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: landHand.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = resolveWithMode(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = resolveWithMode(state);
					const rtElves = findIn(state, 0, elves.instanceId);
					assert.equal(evaluatePermanent(state, rtElves).effectiveTypeLine, 'Creature Land — Island Elf Druid');
					assert.equal(evaluatePermanent(state, rtElves).losesAllAbilities, true);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElves, true), ['U']);
				}

				// 3. Ashaya + Elves + Convincing Mirage (Swamp) vs Tidal Shift (Island) in both timestamp orders
				for (const timedFirst of [true, false]) {
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const mHand = putInZone(state, p1, 'hand', v.mirage);
					giveMana(p1, { U: 2, C: 1 });
					const first = timedFirst ? tsHand : mHand;
					const second = timedFirst ? mHand : tsHand;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: first.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = resolveWithMode(state, 'Swamp');
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: second.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = resolveWithMode(state, 'Swamp');
					const rtElves = findIn(state, 0, elves.instanceId);
					assert.equal(
						evaluatePermanent(state, rtElves).effectiveTypeLine,
						timedFirst ? 'Creature Land — Swamp Elf Druid' : 'Creature Land — Island Elf Druid'
					);
					assert.deepEqual(
						permanentCouldProduceManaTypes(state, state.players[0], rtElves, true),
						[timedFirst ? 'B' : 'U']
					);
				}

				// 4. Dryad Arbor + Ashaya + Tidal Shift (ts=10) + Elkify (ts=20) + Swamp Shift (ts=30)
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					const swampHand = putInZone(state, p1, 'hand', v.swampShift);
					giveMana(p1, { U: 1, G: 1, B: 1, C: 1 });

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = resolveWithMode(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = resolveWithMode(state);
					const atTs20 = findIn(state, 0, arbor.instanceId);
					assert.equal(evaluatePermanent(state, atTs20).effectiveTypeLine, 'Creature Land — Elk');
					assert.deepEqual(
						permanentCouldProduceManaTypes(state, state.players[0], atTs20, true),
						[],
						'Elkify (ts=20) must suppress Tidal Shift (ts=10) Island mana under Ashaya'
					);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: swampHand.instanceId,
							targets: [permTarget(atTs20)]
						}).ok,
						true
					);
					state = resolveWithMode(state);
					const atTs30 = findIn(state, 0, arbor.instanceId);
					assert.equal(evaluatePermanent(state, atTs30).effectiveTypeLine, 'Creature Land — Swamp Elk');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], atTs30, true), ['B']);
				}
			}
		});

		it('M5 Iter 13 Bugs 1 & 3 + Line 64 + Reviewer Minor + Urborg Pass B + CR 205.1b: timed land-subtype pruning and CR 205.3d typeModifiedBy cleanup (canonical + cloneRenamed)', () => {
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseElves = synthCard({
				name: 'Llanowar Elves',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Creature — Elf Druid',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {G}.'
			});
			const baseBlackDryad = synthCard({
				name: 'BlackDryad',
				manaCost: '',
				cmc: 0,
				colors: ['G'],
				typeLine: 'Land Creature — Forest Dryad',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {B}.'
			});
			const baseForest = synthCard({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			});
			const baseTidalShift = synthCard({
				name: 'Tidal Shift',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes an Island until end of turn.'
			});
			const basePermIsland = synthCard({
				name: 'Surge of Tides',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target permanent becomes an Island until end of turn.'
			});
			const baseElkify = synthCard({
				name: 'Beast Transmute',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText:
					'Target creature becomes a green Elk creature with base power and toughness 3/3 until end of turn.'
			});
			const baseLandify = synthCard({
				name: 'Geomancer Rite',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature becomes a land in addition to its other types until end of turn.'
			});
			const baseGolemify = synthCard({
				name: 'Golem Sculpt',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Target permanent becomes a Golem artifact creature until end of turn.'
			});
			const baseDesertMirage = synthCard({
				name: 'Desert Mirage',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: 'Target creature becomes a Desert in addition to its other types until end of turn.'
			});
			const baseElfAspect = synthCard({
				name: 'Sylvan Aspect',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature becomes an Elf in addition to its other types until end of turn.'
			});
			const baseMurder = synthCard({
				name: 'Murder',
				manaCost: '{1}{B}{B}',
				cmc: 3,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			});
			const realDryadArbor = realCard('Dryad Arbor');
			const realUrborg = realCard('Urborg, Tomb of Yawgmoth');

			const variants = [
				{
					ashaya: baseAshaya,
					elves: baseElves,
					blackDryad: baseBlackDryad,
					forest: baseForest,
					tidalShift: baseTidalShift,
					permIsland: basePermIsland,
					elkify: baseElkify,
					landify: baseLandify,
					golemify: baseGolemify,
					desertMirage: baseDesertMirage,
					elfAspect: baseElfAspect,
					murder: baseMurder,
					dryadArbor: realDryadArbor,
					urborg: realUrborg
				},
				{
					ashaya: cloneRenamed(baseAshaya, 'Grove Animist'),
					elves: cloneRenamed(baseElves, 'Forest Mystic'),
					blackDryad: cloneRenamed(baseBlackDryad, 'Shadow Sprite'),
					forest: cloneRenamed(baseForest, 'Wildwood Glade'),
					tidalShift: cloneRenamed(baseTidalShift, 'Wave Transmute'),
					permIsland: cloneRenamed(basePermIsland, 'Tide Surge'),
					elkify: cloneRenamed(baseElkify, 'Stag Morph'),
					landify: cloneRenamed(baseLandify, 'Terrain Blessing'),
					golemify: cloneRenamed(baseGolemify, 'Automaton Forge'),
					desertMirage: cloneRenamed(baseDesertMirage, 'Dune Veil'),
					elfAspect: cloneRenamed(baseElfAspect, 'Canopy Aspect'),
					murder: cloneRenamed(baseMurder, 'Fatal Strike'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Verdant Dryad'),
					urborg: cloneRenamed(realUrborg, 'Blighted Tomb')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const drainNoPrompt = (initial: GameState): GameState => {
				let state = initial;
				for (let guard = 0; guard < 80; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						assert.fail(`Unexpected prompt: ${state.pendingPrompts[0].title}`);
					}
					const pr = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
				}
				assert.fail('drainNoPrompt exceeded guard');
			};

			for (const v of variants) {
				// 1. Bug 1: Ashaya + Elves + Tidal Shift (ts=102) + Elkify (ts=103)
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { U: 1, G: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const rtElves = findIn(state, 0, elves.instanceId);
					const evElves = evaluatePermanent(state, rtElves);
					assert.equal(evElves.effectiveTypeLine, 'Creature Land — Elk');
					assert.equal(evElves.losesAllAbilities, false);
					assert.deepEqual(evElves.lostAllAbilitiesBy, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElves, true), ['G']);
					assert.deepEqual(evElves.breakdown.typeModifiedBy, [v.elkify.name, v.ashaya.name]);
				}

				// 2. Challenger line 64: BlackDryad + Tidal Shift + Elkify (no Ashaya)
				{
					let { state, p1 } = setupGame();
					const dryad = putPerm(state, p1, v.blackDryad);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { U: 1, G: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(dryad)]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, dryad.instanceId))]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const rtDryad = findIn(state, 0, dryad.instanceId);
					const evDryad = evaluatePermanent(state, rtDryad);
					assert.equal(evDryad.effectiveTypeLine, 'Creature — Elk');
					assert.equal(evDryad.losesAllAbilities, false);
					assert.deepEqual(evDryad.lostAllAbilitiesBy, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtDryad, true), ['B']);
					assert.deepEqual(evDryad.breakdown.typeModifiedBy, [v.elkify.name]);
				}

				// 3. Reviewer Minor: non-Land Elves + timed setSubtypes:['Island'] + Elkify + timed addTypes:['Land']
				{
					let { state, p1 } = setupGame();
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const islHand = putInZone(state, p1, 'hand', v.permIsland);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					const landHand = putInZone(state, p1, 'hand', v.landify);
					giveMana(p1, { U: 1, G: 2, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: islHand.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: landHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const rtElves = findIn(state, 0, elves.instanceId);
					const evElves = evaluatePermanent(state, rtElves);
					assert.equal(evElves.effectiveTypeLine, 'Creature Land — Elk');
					assert.equal(evElves.losesAllAbilities, false);
					assert.deepEqual(evElves.lostAllAbilitiesBy, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElves, true), ['G']);
				}

				// 4. Pass B Urborg guard: Urborg + Forest + Tidal Shift on Urborg -> Urborg suppressed in Pass C
				{
					let { state, p1 } = setupGame();
					const urborg = putPerm(state, p1, v.urborg);
					const forest = putPerm(state, p1, v.forest);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					giveMana(p1, { U: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(urborg)]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const evUrborg = evaluatePermanent(state, findIn(state, 0, urborg.instanceId));
					const evForest = evaluatePermanent(state, findIn(state, 0, forest.instanceId));
					assert.equal(evUrborg.effectiveTypeLine, 'Legendary Land — Island');
					assert.equal(evUrborg.losesAllAbilities, true);
					assert.equal(evForest.effectiveTypeLine, 'Basic Land — Forest');
					assert.equal(evForest.hasSubType('Swamp'), false);
				}

				// 5. CR 205.1b preservation: Dryad Arbor + Tidal Shift + timed "becomes a Golem artifact creature"
				{
					let { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const golemHand = putInZone(state, p1, 'hand', v.golemify);
					giveMana(p1, { U: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: golemHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const evArbor = evaluatePermanent(state, rtArbor);
					assert.equal(evArbor.hasSubType('Island'), true);
					assert.equal(evArbor.hasSubType('Golem'), true);
					assert.equal(evArbor.losesAllAbilities, true);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), ['U']);
				}

				// 6. Bug 3: Ashaya + Elves + Tidal Shift + Desert Mirage -> Murder on Ashaya clears typeModifiedBy; non-land Elf works
				{
					let { state, p1 } = setupGame();
					const ashaya = putPerm(state, p1, v.ashaya);
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const desertHand = putInZone(state, p1, 'hand', v.desertMirage);
					const murderHand = putInZone(state, p1, 'hand', v.murder);
					giveMana(p1, { U: 1, R: 1, B: 2, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: desertHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const evAlive = evaluatePermanent(state, findIn(state, 0, elves.instanceId));
					assert.equal(evAlive.effectiveTypeLine, 'Creature Land — Island Elf Druid Desert');
					assert.ok(evAlive.breakdown.typeModifiedBy.includes(v.desertMirage.name));

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: murderHand.instanceId,
							targets: [permTarget(findIn(state, 0, ashaya.instanceId))]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const rtElvesAfter = findIn(state, 0, elves.instanceId);
					const evAfter = evaluatePermanent(state, rtElvesAfter);
					assert.equal(evAfter.effectiveTypeLine, 'Creature — Elf Druid');
					assert.equal(evAfter.breakdown.typeModified, false);
					assert.deepEqual(evAfter.breakdown.typeModifiedBy, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElvesAfter, true), ['G']);

					// Non-land addSubtypes (e.g. Elf on non-Elf) still sets typeModifiedBy
					const dryadBear = putPerm(
						state,
						state.players[0],
						cloneRenamed(
							synthCard({
								name: 'Woodland Bear',
								manaCost: '{1}{G}',
								cmc: 2,
								colors: ['G'],
								typeLine: 'Creature — Bear',
								power: '2',
								toughness: '2'
							}),
							`${v.elves.name} Companion`
						)
					);
					const elfHand = putInZone(state, state.players[0], 'hand', v.elfAspect);
					giveMana(state.players[0], { G: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: elfHand.instanceId,
							targets: [permTarget(dryadBear)]
						}).ok,
						true
					);
					state = drainNoPrompt(state);
					const evNonLand = evaluatePermanent(state, findIn(state, 0, dryadBear.instanceId));
					assert.equal(evNonLand.effectiveTypeLine, 'Creature — Bear Elf');
					assert.equal(evNonLand.breakdown.typeModified, true);
					assert.deepEqual(evNonLand.breakdown.typeModifiedBy, [v.elfAspect.name]);
				}
			}
		});

		it('M5 Iter 13 Bug 2: attached and global static land-subtype mana suppression under Elkify, reverse-ts Elkify + Blood Moon, and Blood Moon + Spreading Seas (canonical + cloneRenamed)', () => {
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseSpreadingSeas = synthCard({
				name: 'Spreading Seas',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant land\nWhen Spreading Seas enters, draw a card.\nEnchanted land is an Island.'
			});
			const baseMirage = synthCard({
				name: 'Convincing Mirage',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant land\nAs Convincing Mirage enters, choose a basic land type.\nEnchanted land is the chosen type.'
			});
			const baseElkify = synthCard({
				name: 'Beast Transmute',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText:
					'Target creature becomes a green Elk creature with base power and toughness 3/3 until end of turn.'
			});
			const realDryadArbor = realCard('Dryad Arbor');
			const realBloodMoon = realCard('Blood Moon');

			const variants = [
				{
					ashaya: baseAshaya,
					dryadArbor: realDryadArbor,
					spreadingSeas: baseSpreadingSeas,
					mirage: baseMirage,
					bloodMoon: realBloodMoon,
					elkify: baseElkify
				},
				{
					ashaya: cloneRenamed(baseAshaya, 'Grove Animist'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Forest Sprite'),
					spreadingSeas: cloneRenamed(baseSpreadingSeas, 'Rising Tides'),
					mirage: cloneRenamed(baseMirage, 'Illusory Terrain'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Lunar'),
					elkify: cloneRenamed(baseElkify, 'Stag Morph')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const resolveAll = (initial: GameState, chosenMode?: string): GameState => {
				let state = initial;
				for (let guard = 0; guard < 80; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						const prm = state.pendingPrompts[0];
						if (prm.choice?.kind === 'chooseMode' && chosenMode) {
							const idx = prm.choice.modes.indexOf(chosenMode);
							answerTopPrompt(state, { kind: 'chooseMode', indices: [idx >= 0 ? idx : 0] });
						} else {
							assert.fail(`Unexpected prompt: ${prm.choice?.kind} (${prm.title})`);
						}
					} else {
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
				assert.fail('resolveAll exceeded guard');
			};

			for (const v of variants) {
				// 1. Ashaya + Dryad Arbor + Spreading Seas (ts=102) + Elkify (ts=103) -> Creature Land — Elk, mana []
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const seasHand = putInZone(state, p1, 'hand', v.spreadingSeas);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { U: 1, G: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: seasHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = resolveAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = resolveAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Creature Land — Elk');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), []);
					assert.deepEqual(getEffectiveActivatedAbilities(state, state.players[0], rtArbor), []);
					assert.equal(ev.breakdown.items.some((it) => it.canonicalKey === 'type_island'), false);
				}

				// 2. Ashaya + Dryad Arbor + Convincing Mirage (Swamp, ts=102) + Elkify (ts=103) -> Creature Land — Elk, mana []
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const mirageHand = putInZone(state, p1, 'hand', v.mirage);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { U: 1, G: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: mirageHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = resolveAll(state, 'Swamp');
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = resolveAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Creature Land — Elk');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), []);
					assert.equal(ev.breakdown.items.some((it) => it.canonicalKey === 'type_swamp'), false);
				}

				// 3. Ashaya + Dryad Arbor + Blood Moon (ts=102) + Elkify (ts=103) -> Creature Land — Elk, losesAllAbilities: false, mana []
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { R: 1, G: 1, C: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					state = resolveAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = resolveAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Creature Land — Elk');
					assert.equal(ev.losesAllAbilities, false);
					assert.deepEqual(ev.lostAllAbilitiesBy, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), []);
					assert.equal(ev.breakdown.items.some((it) => it.canonicalKey === 'type_mountain'), false);
				}

				// 4. Reverse timestamp: Ashaya (100) + Dryad Arbor (101) + Elkify (104) + Blood Moon (200) -> Creature Land — Elk Forest, mana ['G'], no granted_mana_r
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 104;
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					giveMana(p1, { R: 1, G: 1, C: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = resolveAll(state);
					state.nextTimestamp = nextTestTs + 200;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					state = resolveAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Creature Land — Elk Forest');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), ['G']);
					assert.equal(
						getEffectiveActivatedAbilities(state, state.players[0], rtArbor).some(
							(a) => a.id === 'granted_mana_r'
						),
						false
					);
				}

				// 5. Dryad Arbor + Blood Moon (102) + Spreading Seas (103) -> mana ['U'], no type_mountain
				{
					let { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const bmHand = putInZone(state, p1, 'hand', v.bloodMoon);
					const seasHand = putInZone(state, p1, 'hand', v.spreadingSeas);
					giveMana(p1, { R: 1, U: 1, C: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: bmHand.instanceId
						}).ok,
						true
					);
					state = resolveAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: seasHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = resolveAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), ['U']);
					assert.equal(ev.breakdown.items.some((it) => it.canonicalKey === 'type_mountain'), false);
				}
			}
		});

		it('M5 Iter 13 Part A follow-ups: granted Evolve (Backup 1, gains evolve, gains "evolve", CR 603.4 intervening-if) and Ward {2}{U} / Ward—Pay 2 life labels & triggers (canonical + cloneRenamed)', () => {
			const baseBear = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const base33 = synthCard({
				name: 'Centaur Courser',
				manaCost: '{2}{G}',
				cmc: 3,
				colors: ['G'],
				typeLine: 'Creature — Centaur Warrior',
				power: '3',
				toughness: '3'
			});
			const base55 = synthCard({
				name: 'Goliath Wurm',
				manaCost: '{4}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Creature — Wurm',
				power: '5',
				toughness: '5'
			});
			const baseGiantGrowth = synthCard({
				name: 'Giant Growth',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature gets +3/+3 until end of turn.'
			});
			const baseEvolveMentor = synthCard({
				name: 'Simic Mentor',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Elf Mutant',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nEvolve'
			});
			const baseGainsEvolveUnquoted = synthCard({
				name: 'Mutant Awakening',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains evolve until end of turn.'
			});
			const baseGainsEvolveQuoted = synthCard({
				name: 'Adaptive Serum',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature gains "evolve" until end of turn.'
			});
			const baseWardManaMentor = synthCard({
				name: 'Azorius Warder',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Vedalken Wizard',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nWard {2}{U}'
			});
			const baseWardLifeMentor = synthCard({
				name: 'Blood Warder',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Creature — Vampire Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Backup 1\nWard—Pay 2 life.'
			});
			const baseWardManaAura = synthCard({
				name: 'Tidecloak Ward',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature has ward {2}{U}.'
			});
			const baseShock = synthCard({
				name: 'Flame Jab',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: '~ deals 2 damage to target creature.'
			});

			const variants = [
				{
					bear: baseBear,
					c33: base33,
					c55: base55,
					growth: baseGiantGrowth,
					evolveMentor: baseEvolveMentor,
					gainsEvolveUnquoted: baseGainsEvolveUnquoted,
					gainsEvolveQuoted: baseGainsEvolveQuoted,
					wardManaMentor: baseWardManaMentor,
					wardLifeMentor: baseWardLifeMentor,
					wardManaAura: baseWardManaAura,
					shock: baseShock
				},
				{
					bear: cloneRenamed(baseBear, 'Timber Ursine'),
					c33: cloneRenamed(base33, 'Plains Charger'),
					c55: cloneRenamed(base55, 'Canyon Behemoth'),
					growth: cloneRenamed(baseGiantGrowth, 'Titan Surge'),
					evolveMentor: cloneRenamed(baseEvolveMentor, 'Biomancer Tutor'),
					gainsEvolveUnquoted: cloneRenamed(baseGainsEvolveUnquoted, 'Growth Mutagen'),
					gainsEvolveQuoted: cloneRenamed(baseGainsEvolveQuoted, 'Clade Tonic'),
					wardManaMentor: cloneRenamed(baseWardManaMentor, 'Rune Tutor'),
					wardLifeMentor: cloneRenamed(baseWardLifeMentor, 'Pact Tutor'),
					wardManaAura: cloneRenamed(baseWardManaAura, 'Misty Veil'),
					shock: cloneRenamed(baseShock, 'Ember Bolt')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const drainStack = (
				initial: GameState,
				opts: { backupTargetId?: string; declineWard?: boolean } = {}
			): GameState => {
				let state = initial;
				for (let guard = 0; guard < 100; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						const prm = state.pendingPrompts[0];
						if (prm.choice?.kind === 'orderObjects') {
							answerTopPrompt(state, {
								kind: 'orderObjects',
								topIds: prm.choice.objectIds,
								bottomIds: []
							});
						} else if (prm.choice?.kind === 'chooseObjects') {
							const pick =
								opts.backupTargetId && prm.choice.candidates.includes(opts.backupTargetId)
									? opts.backupTargetId
									: prm.choice.candidates[0];
							answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [pick] });
						} else if (prm.choice?.kind === 'yesNo') {
							answerTopPrompt(state, { kind: 'yesNo', yes: !opts.declineWard });
						} else {
							assert.fail(`Unexpected prompt kind: ${prm.choice?.kind} (${prm.title})`);
						}
					} else {
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
				}
				assert.fail('drainStack exceeded guard');
			};

			for (const v of variants) {
				// 1. Backup 1\nEvolve on 2/2 Bear (3/3): 3/3 entering does not trigger; 5/5 entering adds +1/+1 counter (2 total)
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.evolveMentor);
					const c33Hand = putInZone(state, p1, 'hand', v.c33);
					const c55Hand = putInZone(state, p1, 'hand', v.c55);
					giveMana(p1, { G: 3, C: 7 });
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok,
						true
					);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					assert.ok(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords.includes('Evolve'));
					assert.equal(findIn(state, 0, bear.instanceId).counters['+1/+1'] || 0, 1);

					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c33Hand.instanceId }).ok,
						true
					);
					state = drainStack(state);
					assert.equal(findIn(state, 0, bear.instanceId).counters['+1/+1'] || 0, 1);

					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c55Hand.instanceId }).ok,
						true
					);
					state = drainStack(state);
					assert.equal(findIn(state, 0, bear.instanceId).counters['+1/+1'] || 0, 2);
				}

				// 2. Backup 1\nEvolve CR 603.4 intervening-if: pumping Bear to 7/7 in response suppresses Evolve counter
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.evolveMentor);
					const c55Hand = putInZone(state, p1, 'hand', v.c55);
					const growthHand = putInZone(state, p1, 'hand', v.growth);
					giveMana(p1, { G: 3, C: 5 });
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok,
						true
					);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c55Hand.instanceId }).ok,
						true
					);
					state = drainStack(state);
					assert.equal(findIn(state, 0, bear.instanceId).counters['+1/+1'] || 0, 2);

					const c55Hand2 = putInZone(state, state.players[0], 'hand', v.c55);
					giveMana(state.players[0], { G: 2, C: 4 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: c55Hand2.instanceId
						}).ok,
						true
					);
					for (let guard = 0; guard < 20; guard++) {
						state = roundTrip(state);
						if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].choice?.kind === 'orderObjects') {
							answerTopPrompt(state, {
								kind: 'orderObjects',
								topIds: state.pendingPrompts[0].choice.objectIds,
								bottomIds: []
							});
						}
						if (state.stack.some((s) => s.sourceInstanceId === bear.instanceId)) break;
						const pr = state.players[state.priorityPlayerIndex];
						assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					}
					assert.ok(
						state.stack.some((s) => s.sourceInstanceId === bear.instanceId),
						'Expected Evolve trigger on stack'
					);
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: growthHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = drainStack(state);
					assert.equal(
						findIn(state, 0, bear.instanceId).counters['+1/+1'] || 0,
						2,
						'CR 603.4 intervening-if must suppress Evolve when Bear is pumped to 7/7 in response'
					);
				}

				// 3. "gains evolve" and "gains \"evolve\"" both trigger Evolve when 5/5 enters
				for (const grantCard of [v.gainsEvolveUnquoted, v.gainsEvolveQuoted]) {
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const gHand = putInZone(state, p1, 'hand', grantCard);
					const c55Hand = putInZone(state, p1, 'hand', v.c55);
					giveMana(p1, { G: 2, C: 4 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: gHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = drainStack(state);
					assert.ok(evaluatePermanent(state, findIn(state, 0, bear.instanceId)).keywords.includes('Evolve'));
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: c55Hand.instanceId }).ok,
						true
					);
					state = drainStack(state);
					assert.equal(findIn(state, 0, bear.instanceId).counters['+1/+1'] || 0, 1);
				}

				// 4. Backup 1\nWard {2}{U} and Aura Ward {2}{U} format as 'Ward {2}{U}' and counter unpaid Shock
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.wardManaMentor);
					giveMana(p1, { U: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok,
						true
					);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					const evBear = evaluatePermanent(state, findIn(state, 0, bear.instanceId));
					assert.ok(evBear.keywords.includes('Ward {2}{U}'), `Got ${JSON.stringify(evBear.keywords)}`);

					const pr = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					const p2Shock = putInZone(state, state.players[1], 'hand', v.shock);
					giveMana(state.players[1], { R: 1, C: 2 }); // lacks {U} for Ward {2}{U}
					assert.equal(
						applyGameAction(state, state.players[1].playerId, {
							type: 'cast_spell',
							instanceId: p2Shock.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = drainStack(state, { declineWard: true });
					assert.equal(findIn(state, 0, bear.instanceId).damageMarked, 0);
					assert.ok(state.players[1].graveyard.some((c) => c.instanceId === p2Shock.instanceId));

					// Aura static Ward {2}{U} on a second Bear
					const bear2 = putPerm(state, state.players[0], v.bear);
					const auraHand = putInZone(state, state.players[0], 'hand', v.wardManaAura);
					giveMana(state.players[0], { U: 1, C: 1 });
					assert.equal(
						applyGameAction(state, state.players[0].playerId, {
							type: 'cast_spell',
							instanceId: auraHand.instanceId,
							targets: [permTarget(bear2)]
						}).ok,
						true
					);
					state = drainStack(state);
					const evBear2 = evaluatePermanent(state, findIn(state, 0, bear2.instanceId));
					assert.ok(evBear2.keywords.includes('Ward {2}{U}'), `Got ${JSON.stringify(evBear2.keywords)}`);
				}

				// 5. Backup 1\nWard—Pay 2 life formats as 'Ward—Pay 2 life' and charges 2 life when paid
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.bear);
					const mHand = putInZone(state, p1, 'hand', v.wardLifeMentor);
					giveMana(p1, { B: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mHand.instanceId }).ok,
						true
					);
					state = drainStack(state, { backupTargetId: bear.instanceId });
					const evBear = evaluatePermanent(state, findIn(state, 0, bear.instanceId));
					assert.ok(
						evBear.keywords.includes('Ward—Pay 2 life'),
						`Got ${JSON.stringify(evBear.keywords)}`
					);

					const pr = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
					const p2Shock = putInZone(state, state.players[1], 'hand', v.shock);
					giveMana(state.players[1], { R: 1 });
					assert.equal(
						applyGameAction(state, state.players[1].playerId, {
							type: 'cast_spell',
							instanceId: p2Shock.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = drainStack(state, { declineWard: false });
					assert.equal(state.players[1].life, 18);
					assert.equal(findIn(state, 0, bear.instanceId).damageMarked, 2);
				}
			}
		});

		it('M5 Iter 14: attached setTypes Land type_land suppression, unified Pass B pendingLandSubtypes CR 205.1b & CR 305.7 deferral, and Layer 6 hasSubtypeInWork (canonical + cloneRenamed)', () => {
			const baseAshaya = synthCard({
				name: 'Ashaya, Soul of the Wild',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				colors: ['G'],
				typeLine: 'Legendary Creature — Elemental',
				power: '4',
				toughness: '4',
				oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
			});
			const baseElves = synthCard({
				name: 'Llanowar Elves',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Creature — Elf Druid',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {G}.'
			});
			const baseBlackDryad = synthCard({
				name: 'BlackDryad',
				manaCost: '',
				cmc: 0,
				colors: ['G'],
				typeLine: 'Land Creature — Forest Dryad',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {B}.'
			});
			const baseForest = synthCard({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			});
			const baseTidalShift = synthCard({
				name: 'Tidal Shift',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes an Island until end of turn.'
			});
			const baseSurgeOfTides = synthCard({
				name: 'Surge of Tides',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'Target permanent becomes an Island until end of turn.'
			});
			const baseLandify = synthCard({
				name: 'Geomancer Rite',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature becomes a land in addition to its other types until end of turn.'
			});
			const baseGolemify = synthCard({
				name: 'Golem Sculpt',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Target permanent becomes a Golem artifact creature until end of turn.'
			});
			const baseAnimateLand = synthCard({
				name: 'Earth Animate',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target land becomes a 3/3 creature until end of turn.'
			});
			const baseElkify = synthCard({
				name: 'Beast Transmute',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText:
					'Target creature becomes a green Elk creature with base power and toughness 3/3 until end of turn.'
			});
			const baseSpreadingSeas = synthCard({
				name: 'Spreading Seas',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant land\nWhen Spreading Seas enters, draw a card.\nEnchanted land is an Island.'
			});
			const baseVerdantHymn = synthCard({
				name: 'Verdant Sealing Hymn',
				manaCost: '{2}{G}',
				cmc: 3,
				colors: ['G'],
				typeLine: 'Enchantment — Aura',
				keywords: ['Enchant'],
				oracleText: 'Enchant permanent\nEnchanted permanent is a Forest land.'
			});
			const baseMurder = synthCard({
				name: 'Murder',
				manaCost: '{1}{B}{B}',
				cmc: 3,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			});
			const realDryadArbor = realCard('Dryad Arbor');
			const realSong = realCard('Song of the Dryads');
			const realImprisoned = realCard('Imprisoned in the Moon');
			const realBloodMoon = realCard('Blood Moon');
			const realTower = realCard('Command Tower');
			const realUrborg = realCard('Urborg, Tomb of Yawgmoth');

			const variants = [
				{
					ashaya: baseAshaya,
					elves: baseElves,
					blackDryad: baseBlackDryad,
					forest: baseForest,
					tidalShift: baseTidalShift,
					surgeOfTides: baseSurgeOfTides,
					landify: baseLandify,
					golemify: baseGolemify,
					animateLand: baseAnimateLand,
					elkify: baseElkify,
					spreadingSeas: baseSpreadingSeas,
					verdantHymn: baseVerdantHymn,
					murder: baseMurder,
					dryadArbor: realDryadArbor,
					song: realSong,
					imprisoned: realImprisoned,
					bloodMoon: realBloodMoon,
					tower: realTower,
					urborg: realUrborg
				},
				{
					ashaya: cloneRenamed(baseAshaya, 'Grove Animist'),
					elves: cloneRenamed(baseElves, 'Forest Mystic'),
					blackDryad: cloneRenamed(baseBlackDryad, 'Shadow Sprite'),
					forest: cloneRenamed(baseForest, 'Wildwood Glade'),
					tidalShift: cloneRenamed(baseTidalShift, 'Wave Transmute'),
					surgeOfTides: cloneRenamed(baseSurgeOfTides, 'Tidal Surge'),
					landify: cloneRenamed(baseLandify, 'Terrain Blessing'),
					golemify: cloneRenamed(baseGolemify, 'Automaton Forge'),
					animateLand: cloneRenamed(baseAnimateLand, 'Stone Awakener'),
					elkify: cloneRenamed(baseElkify, 'Stag Morph'),
					spreadingSeas: cloneRenamed(baseSpreadingSeas, 'Rising Tides'),
					verdantHymn: cloneRenamed(baseVerdantHymn, 'Sylvan Canticle'),
					murder: cloneRenamed(baseMurder, 'Fatal Strike'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Living Glade'),
					song: cloneRenamed(realSong, 'Sylvan Seal'),
					imprisoned: cloneRenamed(realImprisoned, 'Lunar Binding'),
					bloodMoon: cloneRenamed(realBloodMoon, 'Crimson Lunar'),
					tower: cloneRenamed(realTower, 'Relic Spire'),
					urborg: cloneRenamed(realUrborg, 'Blighted Tomb')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const drainAll = (initial: GameState): GameState => {
				let state = initial;
				for (let guard = 0; guard < 80; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						assert.fail(`Unexpected prompt: ${state.pendingPrompts[0].title}`);
					}
					const pr = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
				}
				assert.fail('drainAll exceeded guard');
			};

			for (const v of variants) {
				// Explorer 1 Case 6: Dryad Arbor + Song of the Dryads (102) + Tidal Shift (103) -> no type_land/type_forest/mana_g
				{
					let { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const songHand = putInZone(state, p1, 'hand', v.song);
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					giveMana(p1, { G: 1, U: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Land — Island');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), ['U']);
					assert.equal(
						ev.breakdown.items.some((it) =>
							it.canonicalKey === 'type_land' ||
							it.canonicalKey === 'type_forest' ||
							it.canonicalKey === 'mana_g'
						),
						false
					);
				}

				// Explorer 1 Case 7a & 7b: Dryad Arbor + Verdant Sealing Hymn (102) + Spreading Seas / Blood Moon (103)
				for (const useBloodMoon of [false, true]) {
					let { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const hymnHand = putInZone(state, p1, 'hand', v.verdantHymn);
					const overHand = putInZone(state, p1, 'hand', useBloodMoon ? v.bloodMoon : v.spreadingSeas);
					giveMana(p1, { G: 1, U: 1, R: 1, C: 5 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: hymnHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: overHand.instanceId,
							...(useBloodMoon ? {} : { targets: [permTarget(findIn(state, 0, arbor.instanceId))] })
						}).ok,
						true
					);
					state = drainAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, useBloodMoon ? 'Land — Mountain' : 'Land — Island');
					assert.deepEqual(
						permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true),
						[useBloodMoon ? 'R' : 'U']
					);
					assert.equal(
						ev.breakdown.items.some((it) =>
							it.canonicalKey === 'type_land' ||
							it.canonicalKey === 'type_forest' ||
							it.canonicalKey === 'mana_g'
						),
						false
					);
				}

				// Explorer 1 Case 8: Ashaya + Dryad Arbor + Song/Hymn (102) + Animate Land (103) + Elkify (104) -> Creature Land — Elk, mana []
				for (const useHymn of [false, true]) {
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const auraHand = putInZone(state, p1, 'hand', useHymn ? v.verdantHymn : v.song);
					const animHand = putInZone(state, p1, 'hand', v.animateLand);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { G: 3, C: 5 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: auraHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: animHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Creature Land — Elk');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), []);
					assert.equal(
						ev.breakdown.items.some((it) =>
							it.canonicalKey === 'type_land' ||
							it.canonicalKey === 'type_forest' ||
							it.canonicalKey === 'mana_g'
						),
						false
					);
				}

				// Explorer 1 Case 9a: Ashaya + Dryad Arbor + Imprisoned in the Moon (102) + Animate Land (103) + Elkify (104)
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const impHand = putInZone(state, p1, 'hand', v.imprisoned);
					const animHand = putInZone(state, p1, 'hand', v.animateLand);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { U: 1, G: 2, C: 5 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: impHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: animHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, arbor.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Creature Land — Elk');
					assert.equal(ev.breakdown.items.some((it) => it.canonicalKey === 'type_land'), false);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), ['C']);
				}

				// Explorer 1 Case 9b: Command Tower + Imprisoned in the Moon (102) + Tidal Shift (103) -> Land — Island, mana ['C'], no type_land
				{
					let { state, p1 } = setupGame();
					p1.commanderColorIdentity = ['W', 'U', 'B', 'R', 'G'];
					const tower = putPerm(state, p1, v.tower);
					state.nextTimestamp = nextTestTs + 100;
					const impHand = putInZone(state, p1, 'hand', v.imprisoned);
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					giveMana(p1, { U: 2, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: impHand.instanceId,
							targets: [permTarget(tower)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(findIn(state, 0, tower.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtTower = findIn(state, 0, tower.instanceId);
					const ev = evaluatePermanent(state, rtTower);
					assert.equal(ev.effectiveTypeLine, 'Land — Island');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtTower, true), ['C']);
					assert.equal(ev.breakdown.items.some((it) => it.canonicalKey === 'type_land'), false);
				}

				// Explorer 2 Cases 1a, 1b & 3: Ashaya/Geomancer Rite + Elves + Tidal Shift (102) + Golem Sculpt (103) (+ Murder on Ashaya)
				for (const useTimedLand of [false, true]) {
					let { state, p1 } = setupGame();
					const ashaya = useTimedLand ? undefined : putPerm(state, p1, v.ashaya);
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const landHand = useTimedLand ? putInZone(state, p1, 'hand', v.landify) : undefined;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const golemHand = putInZone(state, p1, 'hand', v.golemify);
					const murderHand = useTimedLand ? undefined : putInZone(state, p1, 'hand', v.murder);
					giveMana(p1, { G: 1, U: 1, B: 2, C: 3 });
					if (landHand) {
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: landHand.instanceId,
								targets: [permTarget(elves)]
							}).ok,
							true
						);
						state = drainAll(state);
					}
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: golemHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtElves = findIn(state, 0, elves.instanceId);
					const evElves = evaluatePermanent(state, rtElves);
					assert.equal(evElves.effectiveTypeLine, 'Creature Land Artifact — Golem Island');
					assert.equal(evElves.losesAllAbilities, true);
					assert.deepEqual(evElves.lostAllAbilitiesBy, [v.tidalShift.name]);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElves, true), ['U']);
					assert.ok(evElves.breakdown.typeModifiedBy.includes(v.golemify.name));
					assert.ok(evElves.breakdown.typeModifiedBy.includes(v.tidalShift.name));
					assert.ok(
						evElves.breakdown.typeModifiedBy.includes(useTimedLand ? v.landify.name : v.ashaya.name)
					);

					// Case 3: Murder on Ashaya removes Land in Pass C -> reverts to Creature Artifact — Golem, mana ['G']
					if (ashaya && murderHand) {
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: murderHand.instanceId,
								targets: [permTarget(findIn(state, 0, ashaya.instanceId))]
							}).ok,
							true
						);
						state = drainAll(state);
						const rtAfter = findIn(state, 0, elves.instanceId);
						const evAfter = evaluatePermanent(state, rtAfter);
						assert.equal(evAfter.effectiveTypeLine, 'Creature Artifact — Golem');
						assert.equal(evAfter.losesAllAbilities, false);
						assert.deepEqual(evAfter.lostAllAbilitiesBy, []);
						assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtAfter, true), ['G']);
						assert.deepEqual(evAfter.breakdown.typeModifiedBy, [v.golemify.name]);
					}
				}

				// Explorer 2 Case 2: Inverse without Pass C Land: Elves + Surge of Tides (102) + Golem Sculpt (103)
				{
					let { state, p1 } = setupGame();
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const surgeHand = putInZone(state, p1, 'hand', v.surgeOfTides);
					const golemHand = putInZone(state, p1, 'hand', v.golemify);
					giveMana(p1, { U: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: surgeHand.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: golemHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtElves = findIn(state, 0, elves.instanceId);
					const ev = evaluatePermanent(state, rtElves);
					assert.equal(ev.effectiveTypeLine, 'Creature Artifact — Golem');
					assert.equal(ev.losesAllAbilities, false);
					assert.deepEqual(ev.lostAllAbilitiesBy, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElves, true), ['G']);
					assert.deepEqual(ev.breakdown.typeModifiedBy, [v.golemify.name]);
					assert.equal(
						ev.breakdown.items.some((it) => it.canonicalKey === 'mana_u' || it.canonicalKey === 'type_island'),
						false
					);
				}

				// Explorer 2 Case 4: Tidal Shift (102) + Golem Sculpt (103) + Elkify (104) on Ashaya+Elves and Dryad Arbor
				for (const useArbor of [false, true]) {
					let { state, p1 } = setupGame();
					if (!useArbor) putPerm(state, p1, v.ashaya);
					const targetPerm = putPerm(state, p1, useArbor ? v.dryadArbor : v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const tsHand = putInZone(state, p1, 'hand', v.tidalShift);
					const golemHand = putInZone(state, p1, 'hand', v.golemify);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { U: 1, G: 1, C: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: tsHand.instanceId,
							targets: [permTarget(targetPerm)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: golemHand.instanceId,
							targets: [permTarget(findIn(state, 0, targetPerm.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, targetPerm.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtPerm = findIn(state, 0, targetPerm.instanceId);
					const ev = evaluatePermanent(state, rtPerm);
					assert.equal(ev.effectiveTypeLine, useArbor ? 'Creature — Elk' : 'Creature Land — Elk');
					assert.equal(ev.losesAllAbilities, false);
					assert.deepEqual(ev.lostAllAbilitiesBy, []);
					assert.deepEqual(
						permanentCouldProduceManaTypes(state, state.players[0], rtPerm, true),
						useArbor ? [] : ['G']
					);
				}

				// Explorer 3 Finding 2a: Ashaya + BlackDryad + Spreading Seas / Blood Moon (102) + Elkify (103) -> losesAllAbilities: false, mana: ['B']
				for (const useBloodMoon of [false, true]) {
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const dryad = putPerm(state, p1, v.blackDryad);
					state.nextTimestamp = nextTestTs + 100;
					const overHand = putInZone(state, p1, 'hand', useBloodMoon ? v.bloodMoon : v.spreadingSeas);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { U: 1, R: 1, G: 1, C: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: overHand.instanceId,
							...(useBloodMoon ? {} : { targets: [permTarget(dryad)] })
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, dryad.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtDryad = findIn(state, 0, dryad.instanceId);
					const ev = evaluatePermanent(state, rtDryad);
					assert.equal(ev.effectiveTypeLine, 'Creature Land — Elk');
					assert.equal(ev.losesAllAbilities, false);
					assert.deepEqual(ev.lostAllAbilitiesBy, []);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtDryad, true), ['B']);
					assert.deepEqual(ev.breakdown.typeModifiedBy, [v.elkify.name, v.ashaya.name]);
				}

				// Explorer 3 Finding 2b: Ashaya + Elves + Spreading Seas (102) + Golem Sculpt (103) -> Creature Land Artifact — Golem Island, losesAllAbilities: true, mana: ['U']
				{
					let { state, p1 } = setupGame();
					putPerm(state, p1, v.ashaya);
					const elves = putPerm(state, p1, v.elves);
					state.nextTimestamp = nextTestTs + 100;
					const seasHand = putInZone(state, p1, 'hand', v.spreadingSeas);
					const golemHand = putInZone(state, p1, 'hand', v.golemify);
					giveMana(p1, { U: 1, C: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: seasHand.instanceId,
							targets: [permTarget(elves)]
						}).ok,
						true
					);
					state = drainAll(state);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: golemHand.instanceId,
							targets: [permTarget(findIn(state, 0, elves.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtElves = findIn(state, 0, elves.instanceId);
					const ev = evaluatePermanent(state, rtElves);
					assert.equal(ev.effectiveTypeLine, 'Creature Land Artifact — Golem Island');
					assert.equal(ev.losesAllAbilities, true);
					assert.deepEqual(ev.lostAllAbilitiesBy, [v.spreadingSeas.name]);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtElves, true), ['U']);
				}

				// Explorer 3 Finding 2c: Urborg + Forest + Ashaya + Earth Animate + Spreading Seas (10) + Elkify (20) -> Urborg keeps ability and grants Swamp to Forest
				{
					let { state, p1 } = setupGame();
					const urborg = putPerm(state, p1, v.urborg);
					const forest = putPerm(state, p1, v.forest);
					putPerm(state, p1, v.ashaya);
					state.nextTimestamp = nextTestTs + 6;
					const animHand = putInZone(state, p1, 'hand', v.animateLand);
					const seasHand = putInZone(state, p1, 'hand', v.spreadingSeas);
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { G: 2, U: 1, C: 2 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: animHand.instanceId,
							targets: [permTarget(urborg)]
						}).ok,
						true
					);
					state = drainAll(state);
					state.nextTimestamp = nextTestTs + 10;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: seasHand.instanceId,
							targets: [permTarget(findIn(state, 0, urborg.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					state.nextTimestamp = nextTestTs + 20;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(findIn(state, 0, urborg.instanceId))]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtUrborg = findIn(state, 0, urborg.instanceId);
					const rtForest = findIn(state, 0, forest.instanceId);
					const evUrborg = evaluatePermanent(state, rtUrborg);
					const evForest = evaluatePermanent(state, rtForest);
					assert.equal(evUrborg.effectiveTypeLine, 'Legendary Creature Land — Elk');
					assert.equal(evUrborg.losesAllAbilities, false);
					assert.deepEqual(evUrborg.lostAllAbilitiesBy, []);
					assert.equal(evForest.effectiveTypeLine, 'Basic Land — Forest Swamp');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtForest, true), ['B', 'G']);
				}

				// CR 305.6: Dryad Arbor + Elkify alone loses Forest subtype -> getEffectiveActivatedAbilities and mana both []
				{
					let { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					state.nextTimestamp = nextTestTs + 100;
					const elkHand = putInZone(state, p1, 'hand', v.elkify);
					giveMana(p1, { G: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: elkHand.instanceId,
							targets: [permTarget(arbor)]
						}).ok,
						true
					);
					state = drainAll(state);
					const rtArbor = findIn(state, 0, arbor.instanceId);
					const ev = evaluatePermanent(state, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Creature — Elk');
					assert.equal(ev.losesAllAbilities, false);
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtArbor, true), []);
					assert.deepEqual(getEffectiveActivatedAbilities(state, state.players[0], rtArbor), []);
				}
			}
		});

		it('M5 Iter 15: Layer 7b non-creature setter gate & isOverwrittenByLaterAttachedSetTypesNonRemoval (canonical + cloneRenamed)', () => {
			const baseGrizzly = synthCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const baseArtifactCreature = synthCard({
				name: 'Iron Construct',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Construct',
				power: '2',
				toughness: '2'
			});
			const baseAnthem = synthCard({
				name: 'Glorious Anthem',
				manaCost: '{1}{W}{W}',
				cmc: 3,
				colors: ['W'],
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control get +1/+1.'
			});
			const baseOneWithStars = synthCard({
				name: 'One with the Stars',
				manaCost: '{3}{U}',
				cmc: 4,
				colors: ['U'],
				typeLine: 'Enchantment — Aura',
				keywords: ['Enchant'],
				oracleText:
					'Enchant creature or enchantment\nEnchanted permanent is an enchantment and loses all other card types.'
			});
			const baseDarksteel = synthCard({
				name: 'Darksteel Mutation',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Enchantment — Aura',
				keywords: ['Enchant'],
				oracleText:
					'Enchant creature\nEnchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types.'
			});
			const baseAnimateLandKeep = synthCard({
				name: 'Animate Land',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: "Target land becomes a 3/3 creature until end of turn. It's still a land."
			});
			const baseGolemify = synthCard({
				name: 'Golem Sculpt',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Target permanent becomes a Golem artifact creature until end of turn.'
			});
			const basePlains = synthCard({
				name: 'Plains',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Plains',
				oracleText: '({T}: Add {W}.)'
			});
			const baseVerdantHymn = synthCard({
				name: 'Verdant Sealing Hymn',
				manaCost: '{2}{G}',
				cmc: 3,
				colors: ['G'],
				typeLine: 'Enchantment — Aura',
				keywords: ['Enchant'],
				oracleText: 'Enchant permanent\nEnchanted permanent is a Forest land.'
			});
			const realDryadArbor = realCard('Dryad Arbor');
			const realSong = realCard('Song of the Dryads');
			const realImprisoned = realCard('Imprisoned in the Moon');

			const variants = [
				{
					grizzly: baseGrizzly,
					artifactCreature: baseArtifactCreature,
					anthem: baseAnthem,
					oneWithStars: baseOneWithStars,
					darksteel: baseDarksteel,
					animateLandKeep: baseAnimateLandKeep,
					golemify: baseGolemify,
					plains: basePlains,
					verdantHymn: baseVerdantHymn,
					dryadArbor: realDryadArbor,
					song: realSong,
					imprisoned: realImprisoned
				},
				{
					grizzly: cloneRenamed(baseGrizzly, 'Timberland Bruin'),
					artifactCreature: cloneRenamed(baseArtifactCreature, 'Clockwork Frame'),
					anthem: cloneRenamed(baseAnthem, 'Banner of Valor'),
					oneWithStars: cloneRenamed(baseOneWithStars, 'Astral Veil'),
					darksteel: cloneRenamed(baseDarksteel, 'Carapace Curse'),
					animateLandKeep: cloneRenamed(baseAnimateLandKeep, 'Living Terrain'),
					golemify: cloneRenamed(baseGolemify, 'Automaton Forge'),
					plains: cloneRenamed(basePlains, 'Sunlit Steppe'),
					verdantHymn: cloneRenamed(baseVerdantHymn, 'Sylvan Canticle'),
					dryadArbor: cloneRenamed(realDryadArbor, 'Living Glade'),
					song: cloneRenamed(realSong, 'Sylvan Seal'),
					imprisoned: cloneRenamed(realImprisoned, 'Lunar Binding')
				}
			];

			const roundTrip = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState;
			const findIn = (state: GameState, playerIdx: number, id: string): CardInstance =>
				state.players[playerIdx].battlefield.find((c) => c.instanceId === id)!;
			const drainAll = (initial: GameState): GameState => {
				let state = initial;
				for (let guard = 0; guard < 80; guard++) {
					if (state.stack.length === 0 && state.pendingPrompts.length === 0) return state;
					state = roundTrip(state);
					if (state.pendingPrompts.length > 0) {
						assert.fail(`Unexpected prompt: ${state.pendingPrompts[0].title}`);
					}
					const pr = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
				}
				assert.fail('drainAll exceeded guard');
			};

			for (const v of variants) {
				// 1. Bear (2/2, plain / +1/+1 counter / Glorious Anthem) + Song of the Dryads / Imprisoned in the Moon (102) + Golem Sculpt (103)
				for (const isImprisoned of [false, true]) {
					const auraCard = isImprisoned ? v.imprisoned : v.song;
					for (const buffMode of ['plain', 'counter', 'anthem'] as const) {
						let { state, p1 } = setupGame();
						const bear = putPerm(state, p1, v.grizzly);
						if (buffMode === 'counter') bear.counters['+1/+1'] = 1;
						if (buffMode === 'anthem') putPerm(state, p1, v.anthem);
						state.nextTimestamp = nextTestTs + 100;
						const auraHand = putInZone(state, p1, 'hand', auraCard);
						const golemHand = putInZone(state, p1, 'hand', v.golemify);
						giveMana(p1, { W: 2, U: 3, G: 3, C: 5 });

						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: auraHand.instanceId,
								targets: [permTarget(bear)]
							}).ok,
							true
						);
						state = roundTrip(drainAll(state));
						const evLand = evaluatePermanent(state, findIn(state, 0, bear.instanceId));
						assert.equal(evLand.isCreature, false);
						assert.equal(evLand.breakdown.effectivePower, null);
						assert.equal(evLand.breakdown.effectiveToughness, null);
						assert.deepEqual(evLand.breakdown.ptModifiedBy, []);

						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: golemHand.instanceId,
								targets: [permTarget(findIn(state, 0, bear.instanceId))]
							}).ok,
							true
						);
						state = roundTrip(drainAll(state));
						const rtBear = findIn(state, 0, bear.instanceId);
						assert.ok(rtBear, 'Bear should survive SBA on battlefield');
						const ev = evaluatePermanent(state, rtBear);
						const expectedPT = buffMode === 'plain' ? 2 : 3;
						assert.equal(ev.isCreature, true);
						assert.equal(ev.isLand, true);
						assert.equal(ev.isArtifact, true);
						assert.equal(
							ev.effectiveTypeLine,
							isImprisoned ? 'Land Artifact Creature — Golem' : 'Land Artifact Creature — Golem Forest'
						);
						assert.equal(ev.power, expectedPT);
						assert.equal(ev.toughness, expectedPT);
						assert.equal(ev.breakdown.effectivePower, expectedPT);
						assert.equal(ev.breakdown.effectiveToughness, expectedPT);
						assert.deepEqual(
							permanentCouldProduceManaTypes(state, state.players[0], rtBear, true),
							[isImprisoned ? 'C' : 'G']
						);
					}
				}

				// 2. Bear (2/2) + Song of the Dryads (102) + Animate Land (103, 3/3) -> 3/3
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.grizzly);
					state.nextTimestamp = nextTestTs + 100;
					const songHand = putInZone(state, p1, 'hand', v.song);
					const animHand = putInZone(state, p1, 'hand', v.animateLandKeep);
					giveMana(p1, { G: 4, C: 4 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: animHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					const rtBear = findIn(state, 0, bear.instanceId);
					const ev = evaluatePermanent(state, rtBear);
					assert.equal(ev.isCreature, true);
					assert.equal(ev.isLand, true);
					assert.equal(ev.power, 3);
					assert.equal(ev.toughness, 3);
				}

				// 3a. Bear (2/2) + Darksteel Mutation (0/1, 102) + Song (103) + Golem Sculpt (104)
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.grizzly);
					state.nextTimestamp = nextTestTs + 100;
					const dmHand = putInZone(state, p1, 'hand', v.darksteel);
					const songHand = putInZone(state, p1, 'hand', v.song);
					const golemHand = putInZone(state, p1, 'hand', v.golemify);
					giveMana(p1, { W: 2, G: 2, C: 5 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: dmHand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					// SBA put Darksteel Mutation into graveyard when Bear became non-creature Land
					assert.equal(
						state.players[0].graveyard.some((c) => c.card.name === v.darksteel.name),
						true
					);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: golemHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					const evAction = evaluatePermanent(state, findIn(state, 0, bear.instanceId));
					assert.equal(evAction.power, 2);
					assert.equal(evAction.toughness, 2);

					// Direct evaluation (before SBA): Darksteel (102) + Song (103) -> null/null, ptModifiedBy: []; + Golem Sculpt (104) -> 0/1
					const direct = setupGame();
					const dBear = putPerm(direct.state, direct.p1, v.grizzly);
					const baseTs = dBear.enteredTimestamp ?? 100;
					dBear.enteredTimestamp = baseTs;
					const dDm = putPerm(direct.state, direct.p1, v.darksteel);
					dDm.enteredTimestamp = baseTs + 1;
					dDm.attachedToId = dBear.instanceId;
					const dSong = putPerm(direct.state, direct.p1, v.song);
					dSong.enteredTimestamp = baseTs + 2;
					dSong.attachedToId = dBear.instanceId;
					const rtDirect1 = roundTrip(direct.state);
					const evNoGolem = evaluatePermanent(rtDirect1, findIn(rtDirect1, 0, dBear.instanceId));
					assert.equal(evNoGolem.isCreature, false);
					assert.equal(evNoGolem.breakdown.effectivePower, null);
					assert.equal(evNoGolem.breakdown.effectiveToughness, null);
					assert.deepEqual(evNoGolem.breakdown.ptModifiedBy, []);

					(direct.state.timedContinuousEffects ??= []).push({
						timestamp: baseTs + 3,
						sourceName: v.golemify.name,
						controllerId: direct.p1.playerId,
						affected: [{ instanceId: dBear.instanceId, objectVersion: dBear.objectVersion ?? 1 }],
						expires: 'endOfTurn',
						layer4: { addTypes: ['Artifact', 'Creature'], setSubtypes: ['Golem'] }
					});
					const rtDirect2 = roundTrip(direct.state);
					const evDirectGolem = evaluatePermanent(rtDirect2, findIn(rtDirect2, 0, dBear.instanceId));
					assert.equal(evDirectGolem.isCreature, true);
					assert.equal(evDirectGolem.power, 0);
					assert.equal(evDirectGolem.toughness, 1);

					// 3b. Direct evaluation: Bear + Song (102) + Darksteel Mutation (103) -> 0/1 Artifact Creature
					const direct2 = setupGame();
					const dBear2 = putPerm(direct2.state, direct2.p1, v.grizzly);
					const baseTs2 = dBear2.enteredTimestamp ?? 100;
					dBear2.enteredTimestamp = baseTs2;
					const dSong2 = putPerm(direct2.state, direct2.p1, v.song);
					dSong2.enteredTimestamp = baseTs2 + 1;
					dSong2.attachedToId = dBear2.instanceId;
					const dDm2 = putPerm(direct2.state, direct2.p1, v.darksteel);
					dDm2.enteredTimestamp = baseTs2 + 2;
					dDm2.attachedToId = dBear2.instanceId;
					const rtDirect3 = roundTrip(direct2.state);
					const evOrder2 = evaluatePermanent(rtDirect3, findIn(rtDirect3, 0, dBear2.instanceId));
					assert.equal(evOrder2.isCreature, true);
					assert.equal(evOrder2.isLand, false);
					assert.equal(evOrder2.power, 0);
					assert.equal(evOrder2.toughness, 1);
				}

				// 4. Non-creature Plains + Song of the Dryads (102) -> null/null, ptModifiedBy: [], isCreature: false
				{
					let { state, p1 } = setupGame();
					const plains = putPerm(state, p1, v.plains);
					state.nextTimestamp = nextTestTs + 100;
					const songHand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { G: 3 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: songHand.instanceId,
							targets: [permTarget(plains)]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					const ev = evaluatePermanent(state, findIn(state, 0, plains.instanceId));
					assert.equal(ev.isCreature, false);
					assert.equal(ev.isLand, true);
					assert.equal(ev.breakdown.effectivePower, null);
					assert.equal(ev.breakdown.effectiveToughness, null);
					assert.deepEqual(ev.breakdown.ptModifiedBy, []);
				}

				// 5. Artifact Creature (2/2) + One with the Stars (102) + Golem Sculpt (103) -> null/null then 2/2 (3/3 with Anthem)
				for (const withAnthem of [false, true]) {
					let { state, p1 } = setupGame();
					const artCreature = putPerm(state, p1, v.artifactCreature);
					if (withAnthem) putPerm(state, p1, v.anthem);
					state.nextTimestamp = nextTestTs + 100;
					const starsHand = putInZone(state, p1, 'hand', v.oneWithStars);
					const golemHand = putInZone(state, p1, 'hand', v.golemify);
					giveMana(p1, { U: 2, C: 6 });
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: starsHand.instanceId,
							targets: [permTarget(artCreature)]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					const evStars = evaluatePermanent(state, findIn(state, 0, artCreature.instanceId));
					assert.equal(evStars.isCreature, false);
					assert.equal(evStars.isEnchantment, true);
					assert.equal(evStars.breakdown.effectivePower, null);
					assert.equal(evStars.breakdown.effectiveToughness, null);
					assert.deepEqual(evStars.breakdown.ptModifiedBy, []);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: golemHand.instanceId,
							targets: [permTarget(findIn(state, 0, artCreature.instanceId))]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					const evGolem = evaluatePermanent(state, findIn(state, 0, artCreature.instanceId));
					const expected = withAnthem ? 3 : 2;
					assert.equal(evGolem.isCreature, true);
					assert.equal(evGolem.isEnchantment, true);
					assert.equal(evGolem.isArtifact, true);
					assert.equal(evGolem.power, expected);
					assert.equal(evGolem.toughness, expected);
				}

				// 6a. Dryad Arbor + Song of the Dryads / Verdant Sealing Hymn (102) + One with the Stars (103) -> Enchantment, mana: [], abs: [], no mana_g or type_forest
				for (const useHymn of [false, true]) {
					const auraCard = useHymn ? v.verdantHymn : v.song;
					const { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					const arborTs = arbor.enteredTimestamp ?? 100;
					arbor.enteredTimestamp = arborTs;
					const auraPerm = putPerm(state, p1, auraCard);
					auraPerm.enteredTimestamp = arborTs + 1;
					auraPerm.attachedToId = arbor.instanceId;
					const starsPerm = putPerm(state, p1, v.oneWithStars);
					starsPerm.enteredTimestamp = arborTs + 2;
					starsPerm.attachedToId = arbor.instanceId;
					const rtState = roundTrip(state);
					const rtArbor = findIn(rtState, 0, arbor.instanceId);
					const ev = evaluatePermanent(rtState, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Enchantment');
					assert.equal(ev.isLand, false);
					assert.equal(ev.isCreature, false);
					assert.equal(ev.isEnchantment, true);
					assert.deepEqual(permanentCouldProduceManaTypes(rtState, rtState.players[0], rtArbor, true), []);
					assert.deepEqual(getEffectiveActivatedAbilities(rtState, rtState.players[0], rtArbor), []);
					assert.equal(
						ev.breakdown.items.some((it) => it.canonicalKey === 'mana_g' || it.canonicalKey === 'type_forest'),
						false
					);
				}

				// 6b. Dryad Arbor + Song (102) + OWTS (103) + Song (104) -> Land — Forest, mana: ['G'], mana_g present
				{
					const { state, p1 } = setupGame();
					const arbor = putPerm(state, p1, v.dryadArbor);
					const arborTs = arbor.enteredTimestamp ?? 100;
					arbor.enteredTimestamp = arborTs;
					const song1 = putPerm(state, p1, v.song);
					song1.enteredTimestamp = arborTs + 1;
					song1.attachedToId = arbor.instanceId;
					const stars = putPerm(state, p1, v.oneWithStars);
					stars.enteredTimestamp = arborTs + 2;
					stars.attachedToId = arbor.instanceId;
					const song2 = putPerm(state, p1, v.song);
					song2.enteredTimestamp = arborTs + 3;
					song2.attachedToId = arbor.instanceId;
					const rtState = roundTrip(state);
					const rtArbor = findIn(rtState, 0, arbor.instanceId);
					const ev = evaluatePermanent(rtState, rtArbor);
					assert.equal(ev.effectiveTypeLine, 'Land — Forest');
					assert.deepEqual(permanentCouldProduceManaTypes(rtState, rtState.players[0], rtArbor, true), ['G']);
					assert.equal(
						ev.breakdown.items.some((it) => it.canonicalKey === 'mana_g' && !it.removed),
						true
					);
					assert.equal(
						ev.breakdown.items.some((it) => it.canonicalKey === 'type_forest' && !it.removed),
						true
					);
				}

				// 6c. applyGameAction E2E: Bear + Song (102) + Animate Land (103) + One with the Stars (104) + Song (105)
				{
					let { state, p1 } = setupGame();
					const bear = putPerm(state, p1, v.grizzly);
					state.nextTimestamp = nextTestTs + 100;
					const song1Hand = putInZone(state, p1, 'hand', v.song);
					const animHand = putInZone(state, p1, 'hand', v.animateLandKeep);
					const starsHand = putInZone(state, p1, 'hand', v.oneWithStars);
					const song2Hand = putInZone(state, p1, 'hand', v.song);
					giveMana(p1, { U: 3, G: 5, C: 6 });

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: song1Hand.instanceId,
							targets: [permTarget(bear)]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: animHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: starsHand.instanceId,
							targets: [permTarget(findIn(state, 0, bear.instanceId))]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					let rtBear = findIn(state, 0, bear.instanceId);
					let ev = evaluatePermanent(state, rtBear);
					assert.equal(ev.effectiveTypeLine, 'Enchantment');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtBear, true), []);
					assert.deepEqual(getEffectiveActivatedAbilities(state, state.players[0], rtBear), []);
					assert.equal(
						ev.breakdown.items.some((it) => it.canonicalKey === 'mana_g' || it.canonicalKey === 'type_forest'),
						false
					);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'cast_spell',
							instanceId: song2Hand.instanceId,
							targets: [permTarget(rtBear)]
						}).ok,
						true
					);
					state = roundTrip(drainAll(state));
					rtBear = findIn(state, 0, bear.instanceId);
					ev = evaluatePermanent(state, rtBear);
					assert.equal(ev.effectiveTypeLine, 'Land — Forest');
					assert.deepEqual(permanentCouldProduceManaTypes(state, state.players[0], rtBear, true), ['G']);
				}
			}
		});
	});
});

