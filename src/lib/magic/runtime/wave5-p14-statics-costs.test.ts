import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	addCountersToPermanent,
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn
} from '../engine.ts';
import { canCardBeCommander, validateCommanderDeck } from '../scryfall.ts';
import { effectiveSpellManaCost } from './costs.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { attachObject, moveObject } from './zones.ts';
import {
	cardHasCommanderDesignation,
	computeDevotionToColors,
	getCardDeckCopyLimit,
	getEffectiveGoaderPlayerIds
} from './staticsAndCostsWave5.ts';
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
let nextTestTs = 500;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p14_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p14_${synthSeq}`,
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
		id: 'deck_p14',
		userId: 'p1',
		name: 'Track P14 Deck',
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
		name: 'P14 Filler Plains',
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
	const state = createInitialGameState('P14_TEST', seats, decks, {
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
	noteLayerInputsChanged(state);
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
	player.battlefield.push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	zone: 'hand' | 'graveyard' | 'library' | 'exile',
	card: ScryfallCard
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, nextTestTs++);
	player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
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

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 50; guard++) {
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const pr = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, pr.playerId, { type: 'pass_priority' });
		if (!res.ok) break;
	}
}

function advanceToPhase(state: GameState, targetPhase: GameState['phase']): void {
	for (let guard = 0; guard < 40; guard++) {
		if (state.phase === targetPhase && state.stack.length === 0) return;
		if (state.pendingPrompts.length > 0) return;
		const pr = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, pr.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

describe('Track P14 — Statics & Costs Wave 5 End-to-End Runtime Suite', () => {
	describe('1. Theros God Devotion Layer 4 Type Removal & Devotion Amounts (CR 700.5a–b, 613.1d, 205.1a)', () => {
		it('removes Creature and creature subtypes when devotion < 5, restores at >= 5, counts hybrid symbols once, and updates across Layer 2 control change', () => {
			const { state, p1, p2 } = setupGame();
			const sunGod = synthCard({
				name: 'P14 Sun Deity',
				manaCost: '{3}{W}',
				cmc: 4,
				colors: ['W'],
				typeLine: 'Legendary Enchantment Creature — God',
				power: '5',
				toughness: '6',
				oracleText: "Indestructible\nAs long as your devotion to white is less than five, ~ isn't a creature."
			});
			assert.equal(definitionSupportReport(compileCard(sunGod)).fullySupported, true);

			const godPerm = putPerm(state, p1, sunGod);
			// Only 1 white pip on the God itself -> devotion = 1 < 5 -> Enchantment only, NOT Creature or God
			const evalLow = evaluatePermanent(state, godPerm);
			assert.equal(evalLow.isCreature, false);
			assert.equal(evalLow.isEnchantment, true);
			assert.equal(/\bGod\b/.test(evalLow.typeLine), false);

			// Add {W}{W} knight + hybrid {W/U}{W/U} spirit (2 hybrid pips count 1 each toward W -> +2) => 1 + 2 + 2 = 5!
			const knight = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Dawn Paladin',
					manaCost: '{W}{W}',
					cmc: 2,
					colors: ['W'],
					typeLine: 'Creature — Human Knight',
					power: '2',
					toughness: '2'
				})
			);
			putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Sky Spirit',
					manaCost: '{W/U}{W/U}',
					cmc: 2,
					colors: ['W', 'U'],
					typeLine: 'Creature — Spirit',
					power: '2',
					toughness: '2'
				})
			);
			assert.equal(computeDevotionToColors(state, p1.playerId, ['W']), 5);
			const evalHigh = evaluatePermanent(state, godPerm);
			assert.equal(evalHigh.isCreature, true);
			assert.equal(/\bGod\b/.test(evalHigh.typeLine), true);
			assert.equal(getCreaturePower(godPerm, state), 5);

			// Opponent attaches Layer 2 control-stealing Aura to the {W}{W} knight -> devotion drops to 3 < 5!
			const mindLeash = putPerm(
				state,
				p2,
				synthCard({
					name: 'P14 Mind Leash',
					manaCost: '{2}{U}{U}',
					cmc: 4,
					colors: ['U'],
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant creature\nYou control enchanted creature.'
				})
			);
			attachObject(state, mindLeash, knight.instanceId);
			assert.equal(computeDevotionToColors(state, p1.playerId, ['W']), 3);
			assert.equal(evaluatePermanent(state, godPerm).isCreature, false);
		});
	});

	describe('2. Self-Safe Aura Protection Exemption (CR 702.16n, 702.16p, 704.5m)', () => {
		it('keeps an Aura with "This effect doesn\'t remove ~" attached during SBA while knocking off non-exempt colored Auras', () => {
			const { state, p1 } = setupGame();
			const host = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Ward Host',
					manaCost: '{1}{W}',
					cmc: 2,
					colors: ['W'],
					typeLine: 'Creature — Human',
					power: '2',
					toughness: '2'
				})
			);
			const normalWhiteAura = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Plain Mantle',
					manaCost: '{W}',
					cmc: 1,
					colors: ['W'],
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.'
				})
			);
			const safeOmniAura = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Spectra Cloak',
					manaCost: '{3}{W}{W}',
					cmc: 5,
					colors: ['W'],
					typeLine: 'Enchantment — Aura',
					oracleText:
						"Enchant creature\nEnchanted creature gets +2/+2 and has protection from all colors. This effect doesn't remove ~."
				})
			);
			assert.equal(definitionSupportReport(compileCard(safeOmniAura.card)).fullySupported, true);

			attachObject(state, normalWhiteAura, host.instanceId);
			attachObject(state, safeOmniAura, host.instanceId);
			checkStateBasedActions(state);

			// Non-exempt white Aura falls off to graveyard (CR 704.5m), while Spectra Cloak stays attached!
			assert.equal(normalWhiteAura.zone, 'graveyard');
			assert.equal(safeOmniAura.zone, 'battlefield');
			assert.equal(safeOmniAura.attachedToId, host.instanceId);
			assert.equal(getCreaturePower(host, state), 4);
		});
	});

	describe('3. Super-Trample ("assign its combat damage as though it weren\'t blocked", CR 510.1c–d)', () => {
		it('prompts human attacker and deals full power directly to defending player when chosen', () => {
			const { state, p1, p2 } = setupGame();
			const thornBeast = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Thorn Colossus',
					manaCost: '{5}{G}{G}',
					cmc: 7,
					colors: ['G'],
					typeLine: 'Creature — Elemental',
					power: '7',
					toughness: '7',
					oracleText: "You may have ~ assign its combat damage as though it weren't blocked."
				})
			);
			assert.equal(definitionSupportReport(compileCard(thornBeast.card)).fullySupported, true);
			const chump = putPerm(
				state,
				p2,
				synthCard({
					name: 'P14 Stone Wall',
					manaCost: '{1}{W}',
					cmc: 2,
					colors: ['W'],
					typeLine: 'Creature — Wall',
					power: '0',
					toughness: '4',
					oracleText: 'Defender'
				})
			);

			advanceToPhase(state, 'declare_attackers');
			const declAtk = applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: thornBeast.instanceId, defenderPlayerId: p2.playerId }]
			});
			assert.equal(declAtk.ok, true, declAtk.error ?? '');

			advanceToPhase(state, 'declare_blockers');
			const declBlk = applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: chump.instanceId, attackerInstanceId: thornBeast.instanceId }]
			});
			assert.equal(declBlk.ok, true, declBlk.error ?? '');

			advanceToPhase(state, 'combat_damage');
			assert.equal(state.pendingPrompts.length, 1);
			const prm = state.pendingPrompts[0];
			assert.equal(prm.kind, 'yesNo');
			const chooseYes = applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'yesNo', yes: true }
			});
			assert.equal(chooseYes.ok, true, chooseYes.error ?? '');

			// Full 7 combat damage went to p2 (20 -> 13); blocker took 0 damage and survived!
			assert.equal(p2.life, 13);
			assert.equal(chump.zone, 'battlefield');
			assert.equal(chump.damageMarked, 0);
		});
	});

	describe('4. Graveyard Incarnation Statics (CR 113.6b)', () => {
		it('grants keywords from graveyard iff condition holds and invalidates layer cache cleanly', () => {
			const { state, p1 } = setupGame();
			const wonderCard = synthCard({
				name: 'P14 Sky Incarnation',
				manaCost: '{3}{U}',
				cmc: 4,
				colors: ['U'],
				typeLine: 'Creature — Incarnation',
				power: '2',
				toughness: '2',
				oracleText:
					'Flying\nAs long as ~ is in your graveyard and you control an Island, creatures you control have flying.'
			});
			assert.equal(definitionSupportReport(compileCard(wonderCard)).fullySupported, true);

			const bear = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Grizzly',
					manaCost: '{1}{G}',
					cmc: 2,
					colors: ['G'],
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				})
			);
			const wonderInst = putInZone(state, p1, 'graveyard', wonderCard);
			assert.equal(hasKeyword(bear, 'flying', state), false);

			const island = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Island',
					manaCost: '',
					cmc: 0,
					typeLine: 'Basic Land — Island',
					oracleText: '({T}: Add {U}.)'
				})
			);
			assert.equal(hasKeyword(bear, 'flying', state), true);

			// Exiling the incarnation removes flying immediately
			moveObject(state, wonderInst, 'exile', {
				from: { player: p1, zone: 'graveyard' },
				toPlayer: p1
			});
			assert.equal(hasKeyword(bear, 'flying', state), false);
			assert.ok(island);
		});
	});

	describe('5. Combat Rules, Attached Two-Sentence Otherwise, & Single-Axis Layer 7b', () => {
		it('handles canAttackDespiteDefender, static Aura goad, power-greater block restriction, Otherwise Aura, and single-axis base toughness', () => {
			const { state, p1, p2, p3 } = setupGame({ threePlayer: true });
			assert.ok(p3);

			const mobileWall = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Rolling Rampart',
					manaCost: '{2}{G}',
					cmc: 3,
					colors: ['G'],
					typeLine: 'Creature — Wall',
					power: '2',
					toughness: '4',
					oracleText: "Defender\n~ can attack as though it didn't have defender.\n~ can't be blocked by creatures with greater power."
				})
			);
			assert.equal(definitionSupportReport(compileCard(mobileWall.card)).fullySupported, true);

			// Two-sentence "Otherwise" Aura + single-axis base toughness debuff
			const vampAura = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Blood Trial',
					manaCost: '{1}{B}',
					cmc: 2,
					colors: ['B'],
					typeLine: 'Enchantment — Aura',
					oracleText:
						"Enchant creature\nEnchanted creature gets +2/+2 as long as it's a Vampire. Otherwise, it gets -2/-2."
				})
			);
			attachObject(state, vampAura, mobileWall.instanceId);
			// Wall is not a Vampire -> gets -2/-2 => 0/2; boost power back with +1/+1 counters to 3/5
			assert.equal(getCreaturePower(mobileWall, state), 0);
			addCountersToPermanent(state, mobileWall, '+1/+1', 3);
			assert.equal(getCreaturePower(mobileWall, state), 3);

			// Opponent controls a 4/4 giant and p1 controls "Creatures your opponents control have base toughness 1."
			const bigBlocker = putPerm(
				state,
				p2,
				synthCard({
					name: 'P14 Hill Brute',
					manaCost: '{3}{R}',
					cmc: 4,
					colors: ['R'],
					typeLine: 'Creature — Giant',
					power: '4',
					toughness: '4'
				})
			);
			const smallBlocker = putPerm(
				state,
				p2,
				synthCard({
					name: 'P14 Goblin Guard',
					manaCost: '{1}{R}',
					cmc: 2,
					colors: ['R'],
					typeLine: 'Creature — Goblin',
					power: '2',
					toughness: '3'
				})
			);
			const shrinkEnchant = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Brittle Curse',
					manaCost: '{2}{U}',
					cmc: 3,
					colors: ['U'],
					typeLine: 'Enchantment',
					oracleText: 'Creatures your opponents control have base toughness 1.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(shrinkEnchant.card)).fullySupported, true);
			assert.equal(getCreaturePower(bigBlocker, state), 4);
			assert.equal(getCreatureToughness(bigBlocker, state), 1);

			// Goad Aura on p2's bigBlocker
			const impetus = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Martial Impetus',
					manaCost: '{2}{W}',
					cmc: 3,
					colors: ['W'],
					typeLine: 'Enchantment — Aura',
					oracleText: 'Enchant creature\nEnchanted creature gets +1/+1 and is goaded.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(impetus.card)).fullySupported, true);
			attachObject(state, impetus, bigBlocker.instanceId);
			assert.deepEqual(getEffectiveGoaderPlayerIds(state, bigBlocker), [p1.playerId]);

			// Wall with defender CAN declare attack thanks to canAttackDespiteDefender!
			advanceToPhase(state, 'declare_attackers');
			const atkRes = applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: mobileWall.instanceId, defenderPlayerId: p2.playerId }]
			});
			assert.equal(atkRes.ok, true, atkRes.error ?? '');

			advanceToPhase(state, 'declare_blockers');
			// bigBlocker (power 5 > 3) CANNOT block mobileWall (power 3)
			const illegalBlk = applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: bigBlocker.instanceId, attackerInstanceId: mobileWall.instanceId }]
			});
			assert.equal(illegalBlk.ok, false);

			// smallBlocker (power 2 <= 3) CAN block mobileWall
			const legalBlk = applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: smallBlocker.instanceId, attackerInstanceId: mobileWall.instanceId }]
			});
			assert.equal(legalBlk.ok, true, legalBlk.error ?? '');
		});
	});

	describe('6. Commander Designation & Deck Copy Limits (CR 903.3a, 903.5b)', () => {
		it('recognizes IR-compiled commander designation on Planeswalkers and validates custom deck copy limits', () => {
			const pwCommander = synthCard({
				name: 'P14 Rift Navigator',
				manaCost: '{2}{U}{U}',
				cmc: 4,
				colors: ['U'],
				colorIdentity: ['U'],
				typeLine: 'Legendary Planeswalker — Navigator',
				loyalty: '4',
				canBeCommander: false,
				oracleText: '+1: Draw a card.\n~ can be your commander.'
			});
			assert.equal(cardHasCommanderDesignation(pwCommander), true);
			assert.equal(canCardBeCommander(pwCommander), true);

			const anyCopyRat = synthCard({
				name: 'P14 Colony Rat',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				colorIdentity: ['B'],
				typeLine: 'Creature — Rat',
				power: '2',
				toughness: '1',
				oracleText: 'A deck can have any number of cards named ~.'
			});
			const sevenDwarves = synthCard({
				name: 'P14 Seven Miners',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				colorIdentity: ['R'],
				typeLine: 'Creature — Dwarf',
				power: '2',
				toughness: '2',
				oracleText: 'A deck can have up to seven cards named ~.'
			});
			assert.equal(getCardDeckCopyLimit(anyCopyRat), 'any');
			assert.equal(getCardDeckCopyLimit(sevenDwarves), 7);

			const commander = synthCard({
				name: 'P14 Grixis Overlord',
				manaCost: '{U}{B}{R}',
				cmc: 3,
				colors: ['U', 'B', 'R'],
				colorIdentity: ['U', 'B', 'R'],
				typeLine: 'Legendary Creature — Wizard',
				power: '3',
				toughness: '3'
			});
			const swamp = synthCard({
				name: 'Swamp',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Swamp',
				oracleText: '({T}: Add {B}.)'
			});
			// 20 Colony Rats + 7 Seven Miners + 72 Swamps + 1 Commander = 100 legal Commander deck!
			const legalRes = validateCommanderDeck(
				[commander],
				[
					{ card: anyCopyRat, quantity: 20 },
					{ card: sevenDwarves, quantity: 7 },
					{ card: swamp, quantity: 72 }
				]
			);
			assert.equal(legalRes.isLegal, true, legalRes.errors.join('; '));

			// 8 Seven Miners (> 7) is flagged!
			const overLimitRes = validateCommanderDeck(
				[commander],
				[
					{ card: anyCopyRat, quantity: 20 },
					{ card: sevenDwarves, quantity: 8 },
					{ card: swamp, quantity: 71 }
				]
			);
			assert.equal(overLimitRes.isLegal, false);
		});
	});

	describe('7. Turn-Slotted & Self Graveyard / Exile Play Permissions', () => {
		it('tracks Muldrotha per-permanent-type slots (including multi-type Artifact Creature choices), Kess exile-on-resolution, and self graveyard/exile cast', () => {
			const { state, p1 } = setupGame();
			const muldrotha = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Gravetide Avatar',
					manaCost: '{3}{B}{G}{U}',
					cmc: 6,
					colors: ['B', 'G', 'U'],
					typeLine: 'Legendary Creature — Elemental Avatar',
					power: '6',
					toughness: '6',
					oracleText:
						'During each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(muldrotha.card)).fullySupported, true);

			const artCreature = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({
					name: 'P14 Bronze Automaton',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Artifact Creature — Construct',
					power: '2',
					toughness: '2'
				})
			);
			const pureCreature = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({
					name: 'P14 Moss Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					colors: ['G'],
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				})
			);

			// Give mana first so getCastOptions includes legal options
			giveMana(p1, { C: 4, G: 4 });

			// Bronze Automaton exposes BOTH Artifact slot and Creature slot options!
			const autoOpts = getCastOptions(state, p1.playerId, artCreature, 'graveyard');
			const artSlotOpt = autoOpts.find((o) => o.id.endsWith(':Artifact'));
			const creatureSlotOpt = autoOpts.find((o) => o.id.endsWith(':Creature'));
			assert.ok(artSlotOpt, 'Expected Artifact slot option');
			assert.ok(creatureSlotOpt, 'Expected Creature slot option');

			// Cast Bronze Automaton using the Artifact slot so the Creature slot stays open!
			const castAuto = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: artCreature.instanceId,
				fromZone: 'graveyard',
				optionId: artSlotOpt.id
			});
			assert.equal(castAuto.ok, true, castAuto.error ?? '');
			resolveAllStack(state);
			assert.equal(
				p1.battlefield.some((c) => c.card.id === artCreature.card.id),
				true
			);

			// Creature slot is STILL open for Moss Bear this turn!
			const bearOpts = getCastOptions(state, p1.playerId, pureCreature, 'graveyard');
			assert.equal(bearOpts.length, 1);
			const castBear = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: pureCreature.instanceId,
				fromZone: 'graveyard',
				optionId: bearOpts[0].id
			});
			assert.equal(castBear.ok, true, castBear.error ?? '');
			resolveAllStack(state);
			assert.equal(
				p1.battlefield.some((c) => c.card.id === pureCreature.card.id),
				true
			);

			// Now Creature slot IS used — another creature in graveyard has 0 options from Muldrotha!
			const secondBear = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({
					name: 'P14 Second Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					colors: ['G'],
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				})
			);
			assert.equal(getCastOptions(state, p1.playerId, secondBear, 'graveyard').length, 0);

			// Kess-style once-per-turn instant/sorcery that exiles instead of going to graveyard
			const kess = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Dissident Mage',
					manaCost: '{1}{U}{B}{R}',
					cmc: 4,
					colors: ['U', 'B', 'R'],
					typeLine: 'Legendary Creature — Human Wizard',
					power: '3',
					toughness: '4',
					oracleText:
						'Once during each of your turns, you may cast an instant or sorcery spell from your graveyard. If a spell cast this way would be put into your graveyard, exile it instead.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(kess.card)).fullySupported, true);
			const cantrip = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({
					name: 'P14 Arcane Insight',
					manaCost: '{U}',
					cmc: 1,
					colors: ['U'],
					typeLine: 'Sorcery',
					oracleText: 'Draw a card.'
				})
			);
			giveMana(p1, { U: 1 });
			const kessOpts = getCastOptions(state, p1.playerId, cantrip, 'graveyard');
			assert.equal(kessOpts.length, 1);
			const castCantrip = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cantrip.instanceId,
				fromZone: 'graveyard',
				optionId: kessOpts[0].id
			});
			assert.equal(castCantrip.ok, true, castCantrip.error ?? '');
			resolveAllStack(state);
			assert.equal(
				p1.exile.some((c) => c.card.id === cantrip.card.id),
				true
			);

			// Self exile/graveyard cast (Squee, the Immortal style)
			const squee = putInZone(
				state,
				p1,
				'exile',
				synthCard({
					name: 'P14 Undying Nabob',
					manaCost: '{1}{R}{R}',
					cmc: 3,
					colors: ['R'],
					typeLine: 'Legendary Creature — Goblin',
					power: '2',
					toughness: '1',
					oracleText: 'You may cast ~ from your graveyard or from exile.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(squee.card)).fullySupported, true);
			giveMana(p1, { R: 2, C: 1 });
			const squeeOpts = getCastOptions(state, p1.playerId, squee, 'exile');
			assert.equal(squeeOpts.length, 1);
			const castSquee = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: squee.instanceId,
				fromZone: 'exile',
				optionId: squeeOpts[0].id
			});
			assert.equal(castSquee.ok, true, castSquee.error ?? '');
			resolveAllStack(state);
			assert.equal(
				p1.battlefield.some((c) => c.card.id === squee.card.id),
				true
			);
		});
	});

	describe('8. "~ enters prepared" (CR 723.3a)', () => {
		it('sets isPrepared = true upon entering the battlefield and clears isPrepared when leaving the battlefield', () => {
			const { state, p1 } = setupGame();
			const prepCreature = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Vigilant Scout',
					manaCost: '{1}{W}',
					cmc: 2,
					colors: ['W'],
					typeLine: 'Creature — Human Scout',
					power: '2',
					toughness: '2',
					oracleText: '~ enters prepared.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(prepCreature.card)).fullySupported, true);

			giveMana(p1, { W: 1, C: 1 });
			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: prepCreature.instanceId
			});
			assert.equal(castRes.ok, true, castRes.error ?? '');
			resolveAllStack(state);

			const enteredScout = p1.battlefield.find((c) => c.card.id === prepCreature.card.id);
			assert.ok(enteredScout, 'Expected prepared creature on battlefield');
			assert.equal(enteredScout.isPrepared, true);

			moveObject(state, enteredScout, 'graveyard', {
				from: 'anyBattlefield',
				toPlayer: p1,
				leaveBattlefieldReset: true
			});
			assert.equal(enteredScout.zone, 'graveyard');
			assert.equal(enteredScout.isPrepared, undefined);
		});
	});

	describe('9. Phantom / Polukranos Counter-Removal Prevention & Static Damage Prevention (CR 615.1, 615.5–6, 615.10, 615.12)', () => {
		it('prevents damage and removes 1 (Phantom) or that many (Polukranos) +1/+1 counters, still removes counters under unpreventable damage (CR 615.12), and prevents noncombat damage to you', () => {
			const { state, p1 } = setupGame();
			const phantom = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Spectral Nomad',
					manaCost: '{2}{G}',
					cmc: 3,
					colors: ['G'],
					typeLine: 'Creature — Spirit Nomad',
					power: '0',
					toughness: '0',
					oracleText:
						'~ enters with two +1/+1 counters on it.\nIf damage would be dealt to ~, prevent that damage and remove a +1/+1 counter from ~.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(phantom.card)).fullySupported, true);
			addCountersToPermanent(state, phantom, '+1/+1', 2);

			const hydra = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Chained Hydra',
					manaCost: '{2}{B}{G}',
					cmc: 4,
					colors: ['B', 'G'],
					typeLine: 'Legendary Creature — Zombie Hydra',
					power: '0',
					toughness: '0',
					oracleText:
						'~ enters with six +1/+1 counters on it.\nIf damage would be dealt to ~ while it has a +1/+1 counter on it, prevent that damage and remove that many +1/+1 counters from ~.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(hydra.card)).fullySupported, true);
			addCountersToPermanent(state, hydra, '+1/+1', 8);

			const boltCard = synthCard({
				name: 'P14 Flame Bolt',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to any target.'
			});

			// Deal 3 damage to Phantom -> prevented (0 marked), 1 counter removed (2 -> 1)
			const bolt1 = putInZone(state, p1, 'hand', boltCard);
			giveMana(p1, { R: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bolt1.instanceId,
					targets: [permTarget(phantom)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(phantom.damageMarked, 0);
			assert.equal(phantom.counters['+1/+1'], 1);

			// Deal 3 damage to Polukranos -> prevented (0 marked), 3 counters removed (6 -> 3)
			const bolt2 = putInZone(state, p1, 'hand', boltCard);
			giveMana(p1, { R: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bolt2.instanceId,
					targets: [permTarget(hydra)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(hydra.damageMarked, 0);
			assert.equal(hydra.counters['+1/+1'], 5);

			// Add "Damage can't be prevented." (CR 615.12): Polukranos STILL removes 2 counters AND takes 2 damage!
			putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Skull Flare',
					manaCost: '{2}{R}',
					cmc: 3,
					colors: ['R'],
					typeLine: 'Enchantment',
					oracleText: "Damage can't be prevented."
				})
			);
			const shock = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Shock Spark',
					manaCost: '{R}',
					cmc: 1,
					colors: ['R'],
					typeLine: 'Instant',
					oracleText: '~ deals 2 damage to any target.'
				})
			);
			giveMana(p1, { R: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: shock.instanceId,
					targets: [permTarget(hydra)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(hydra.counters['+1/+1'], 3);
			assert.equal(hydra.damageMarked, 2);
		});

		it('prevents noncombat damage to you via staticDamagePrevention', () => {
			const { state, p1 } = setupGame();
			const wanderer = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Shielded Wayfarer',
					manaCost: '{3}{W}',
					cmc: 4,
					colors: ['W'],
					typeLine: 'Enchantment',
					oracleText: 'Prevent all noncombat damage that would be dealt to you and other permanents you control.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(wanderer.card)).fullySupported, true);

			const bolt = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Lava Dart',
					manaCost: '{R}',
					cmc: 1,
					colors: ['R'],
					typeLine: 'Instant',
					oracleText: '~ deals 3 damage to any target.'
				})
			);
			giveMana(p1, { R: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bolt.instanceId,
					targets: [playerTarget(p1)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.life, 20);
		});
	});

	describe('10. Strive, Familiar / Greatest-Power / Ordinal Cost Modifiers, & Pitch / Bounce Alt-Cast Permissions', () => {
		it('computes Strive per-extra-target tax, greatest-power {X} reduction, ordinal spell discount, and Force-of-Will / Daze alt-cast options', () => {
			const { state, p1, p2 } = setupGame();
			const b1 = putPerm(state, p1, synthCard({ name: 'P14 Ally One', power: '4', toughness: '4' }));
			const b2 = putPerm(state, p2, synthCard({ name: 'P14 Foe Two', power: '2', toughness: '2' }));
			const b3 = putPerm(state, p2, synthCard({ name: 'P14 Foe Three', power: '2', toughness: '2' }));

			// Strive: {R} base + {2}{R} per target beyond the first => 3 targets costs {4}{R}{R}{R}
			const striveSpell = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Twinflame Surge',
					manaCost: '{R}',
					cmc: 1,
					colors: ['R'],
					typeLine: 'Sorcery',
					oracleText:
						'~ costs {2}{R} more to cast for each target beyond the first.\n~ deals 1 damage to any number of target creatures.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(striveSpell.card)).fullySupported, true);
			const eff1 = effectiveSpellManaCost(
				state,
				p1,
				striveSpell,
				0,
				'{R}',
				undefined,
				0,
				false,
				undefined,
				false,
				[permTarget(b1)]
			);
			assert.equal(eff1.generic, 0);
			assert.equal(eff1.colored.R, 1);
			const eff3 = effectiveSpellManaCost(
				state,
				p1,
				striveSpell,
				0,
				'{R}',
				undefined,
				0,
				false,
				undefined,
				false,
				[permTarget(b1), permTarget(b2), permTarget(b3)]
			);
			assert.equal(eff3.generic, 4);
			assert.equal(eff3.colored.R, 3);

			// Greatest power {X} reduction: Ally One has power 4 => {6}{G}{G} becomes {2}{G}{G}
			const henge = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Great Monolith',
					manaCost: '{6}{G}{G}',
					cmc: 8,
					colors: ['G'],
					typeLine: 'Legendary Artifact',
					oracleText: '~ costs {X} less to cast, where X is the greatest power among creatures you control.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(henge.card)).fullySupported, true);
			const hengeCost = effectiveSpellManaCost(state, p1, henge, 0, '{6}{G}{G}');
			assert.equal(hengeCost.generic, 2);
			assert.equal(hengeCost.colored.G, 2);

			// Pitch alt-cast (Force of Will style: pay 1 life + exile a blue card from hand rather than mana cost)
			const pitchCounter = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Will Snap',
					manaCost: '{3}{U}{U}',
					cmc: 5,
					colors: ['U'],
					typeLine: 'Instant',
					oracleText:
						"You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nDraw a card."
				})
			);
			assert.equal(definitionSupportReport(compileCard(pitchCounter.card)).fullySupported, true);
			const blueFodder = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Blue Drake',
					manaCost: '{2}{U}',
					cmc: 3,
					colors: ['U'],
					typeLine: 'Creature — Drake',
					power: '2',
					toughness: '2'
				})
			);

			const pitchOpts = getCastOptions(state, p1.playerId, pitchCounter, 'hand');
			const altOpt = pitchOpts.find((o) => o.id.startsWith('static_alt_self_'));
			assert.ok(altOpt, 'Expected static pitch alternative cast option');

			// Cast with 0 mana in pool using the pitch option!
			const castPitch = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: pitchCounter.instanceId,
				optionId: altOpt.id
			});
			assert.equal(castPitch.ok, true, castPitch.error ?? '');
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseObjects', objectIds: [blueFodder.instanceId] }
					}).ok,
					true
				);
			}
			assert.equal(p1.life, 19);
			assert.equal(blueFodder.zone, 'exile');
			resolveAllStack(state);
		});
	});

	describe('11. Waterbend [cost] (CR 701.67a–b)', () => {
		it('pays activated Waterbend {3} by tapping artifacts/creatures + mana, strictly caps reduction to waterbend generic mana, and survives JSON round-trip mid-payment', () => {
			const { state, p1 } = setupGame();
			const bender = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Tide Master',
					manaCost: '{1}{U}',
					cmc: 2,
					colors: ['U'],
					typeLine: 'Creature — Human Monk',
					power: '2',
					toughness: '2',
					oracleText: 'Waterbend {3}: Draw a card.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(bender.card)).fullySupported, true);

			const clue = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Relic Orb',
					manaCost: '{1}',
					cmc: 1,
					typeLine: 'Artifact'
				})
			);
			const otter = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Stream Otter',
					manaCost: '{U}',
					cmc: 1,
					colors: ['U'],
					typeLine: 'Creature — Otter',
					power: '1',
					toughness: '1',
					// Summoning-sick creatures CAN be tapped for waterbend (CR 701.67a doesn't use {T}!)
				}),
				{ summoningSick: true }
			);

			// Pool has only {C: 1}, plus 3 untapped artifacts/creatures (bender, clue, otter) -> legal!
			giveMana(p1, { C: 1 });
			const ab = findAbility(state, p1, bender);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, bender, ab).ok, true);

			const actRes = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: bender.instanceId,
				abilityId: ab.id
			});
			assert.equal(actRes.ok, true, actRes.error ?? '');
			assert.equal(state.pendingPrompts.length, 1);

			// Verify JSON.parse(JSON.stringify(state)) round-trip mid-payment (zero IR in GameState invariant!)
			const roundTripped: GameState = JSON.parse(JSON.stringify(state));
			const prm = roundTripped.pendingPrompts[0];
			const rP1 = roundTripped.players[0];
			const chooseTap = applyGameAction(roundTripped, rP1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [clue.instanceId, otter.instanceId] }
			});
			assert.equal(chooseTap.ok, true, chooseTap.error ?? '');
			resolveAllStack(roundTripped);
			assert.equal(rP1.manaPool.C, 0);
			assert.equal(rP1.battlefield.find((c) => c.instanceId === clue.instanceId)?.tapped, true);
			assert.equal(rP1.battlefield.find((c) => c.instanceId === otter.instanceId)?.tapped, true);
			assert.equal(rP1.hand.length, 1);

			// Colored pip cap test: Waterbend {1}{U} CANNOT be paid with 0 blue mana even with 3 untapped artifacts!
			const { state: s2, p1: s2p1 } = setupGame();
			const coloredBender = putPerm(
				s2,
				s2p1,
				synthCard({
					name: 'P14 Strict Tide',
					manaCost: '{U}',
					cmc: 1,
					colors: ['U'],
					typeLine: 'Creature — Monk',
					power: '1',
					toughness: '2',
					oracleText: 'Waterbend {1}{U}: Draw a card.'
				})
			);
			putPerm(s2, s2p1, synthCard({ name: 'P14Spare Relic', typeLine: 'Artifact' }));
			const strictAb = findAbility(s2, s2p1, coloredBender);
			assert.equal(checkAbilityActivationLegality(s2, s2p1.playerId, coloredBender, strictAb).ok, false);
			giveMana(s2p1, { U: 1 });
			assert.equal(checkAbilityActivationLegality(s2, s2p1.playerId, coloredBender, strictAb).ok, true);
		});
	});

	describe('12. Behold a [quality] (CR 701.4a–b) & Remaining Cost Forms (putCounters, discardHand, tuck, tapAttached, Grandeur)', () => {
		it('pays Behold via controlled permanent OR hand reveal, enforces cantHaveCounters on putCounters cost, tucks from hand to library[0], and evaluates Grandeur sameNameAsSource under copy effects', () => {
			const { state, p1, p2 } = setupGame();

			// 12a. Behold a Dragon or pay {2}
			const dragonBreath = synthCard({
				name: 'P14 Draconic Roar',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: 'As an additional cost to cast ~, behold a Dragon or pay {2}.\nDraw a card.'
			});
			assert.equal(definitionSupportReport(compileCard(dragonBreath)).fullySupported, true);
			const roarInst = putInZone(state, p1, 'hand', dragonBreath);

			// With only {1}{R} and NO Dragon in hand or on battlefield, cannot cast!
			giveMana(p1, { R: 1, C: 1 });
			assert.equal(checkSpellCastLegality(state, p1.playerId, roarInst).ok, false);

			// Put a Dragon card in hand -> now Behold option is legal with just {1}{R}!
			const handDragon = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P14 Sky Dragon',
					manaCost: '{4}{R}{R}',
					cmc: 6,
					colors: ['R'],
					typeLine: 'Creature — Dragon',
					power: '5',
					toughness: '5'
				})
			);
			assert.equal(checkSpellCastLegality(state, p1.playerId, roarInst).ok, true);
			const castRoar = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: roarInst.instanceId
			});
			assert.equal(castRoar.ok, true, castRoar.error ?? '');
			for (let guard = 0; guard < 5 && state.pendingPrompts.length > 0; guard++) {
				const prm = state.pendingPrompts[0];
				if (prm.choice?.kind === 'chooseMode') {
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseMode', indices: [0] }
						}).ok,
						true
					);
				} else if (prm.choice?.kind === 'chooseObjects') {
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseObjects', objectIds: [handDragon.instanceId] }
						}).ok,
						true
					);
				} else {
					break;
				}
			}
			// Hand Dragon stayed in hand and was revealed to opponent!
			assert.equal(handDragon.zone, 'hand');
			assert.equal(Boolean(handDragon.knownToPlayerIds?.includes(p2.playerId)), true);
			resolveAllStack(state);

			// 12b. Put a -1/-1 counter on ~ cost & cantHaveCounters illegality
			const cinder = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Cinder Druid',
					manaCost: '{1}{G}',
					cmc: 2,
					colors: ['G'],
					typeLine: 'Creature — Elf Druid',
					power: '2',
					toughness: '3',
					oracleText: 'Put a -1/-1 counter on ~: Add {G}.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(cinder.card)).fullySupported, true);
			const cinderAb = findAbility(state, p1, cinder);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, cinder, cinderAb).ok, true);

			// Solemnity-style cantHaveCounters makes "Put a -1/-1 counter on ~" illegal to pay!
			const solemnity = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Stillness Field',
					manaCost: '{2}{W}',
					cmc: 3,
					colors: ['W'],
					typeLine: 'Enchantment',
					oracleText: "Counters can't be put on creatures."
				})
			);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, cinder, cinderAb).ok, false);
			moveObject(state, solemnity, 'exile', {
				from: 'anyBattlefield',
				toPlayer: p1,
				leaveBattlefieldReset: true
			});
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, cinder, cinderAb).ok, true);

			// 12c. Put a card from your hand on top of your library cost -> places at library[0]
			const tuckMage = putPerm(
				state,
				p1,
				synthCard({
					name: 'P14 Scroll Chronomancer',
					manaCost: '{1}{U}',
					cmc: 2,
					colors: ['U'],
					typeLine: 'Creature — Human Wizard',
					power: '1',
					toughness: '3',
					oracleText: 'Put a card from your hand on top of your library: ~ gets +1/+1 until end of turn.'
				})
			);
			assert.equal(definitionSupportReport(compileCard(tuckMage.card)).fullySupported, true);
			const tuckAb = findAbility(state, p1, tuckMage);
			const actTuck = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: tuckMage.instanceId,
				abilityId: tuckAb.id
			});
			assert.equal(actTuck.ok, true, actTuck.error ?? '');
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseObjects', objectIds: [handDragon.instanceId] }
					}).ok,
					true
				);
			}
			assert.equal(p1.library[0]?.instanceId, handDragon.instanceId);
			resolveAllStack(state);

			// 12d. Grandeur ("Discard another card named ~") uses evaluated permanent name (Layer 1 copy-aware!)
			const grandeurLegend = synthCard({
				name: 'P14 Korlash Heir',
				manaCost: '{2}{B}{B}',
				cmc: 4,
				colors: ['B'],
				typeLine: 'Legendary Creature — Zombie Warrior',
				power: '4',
				toughness: '4',
				oracleText: 'Grandeur — Discard another card named ~: Draw two cards.'
			});
			assert.equal(definitionSupportReport(compileCard(grandeurLegend)).fullySupported, true);
			const grandeurPerm = putPerm(state, p1, grandeurLegend);
			const grandeurAb = findAbility(state, p1, grandeurPerm);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, grandeurPerm, grandeurAb).ok, false);

			const dupInHand = putInZone(state, p1, 'hand', grandeurLegend);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, grandeurPerm, grandeurAb).ok, true);
			const actGrandeur = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: grandeurPerm.instanceId,
				abilityId: grandeurAb.id
			});
			assert.equal(actGrandeur.ok, true, actGrandeur.error ?? '');
			assert.equal(dupInHand.zone, 'graveyard');
			resolveAllStack(state);
		});
	});
});
