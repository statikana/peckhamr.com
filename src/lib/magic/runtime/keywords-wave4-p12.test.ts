import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
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
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
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
});
