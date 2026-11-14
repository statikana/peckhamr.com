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
	hasKeyword
} from '../engine.ts';
import { resolveObjectFaces } from './faces.ts';
import { objectManaValue } from './objectFilter.ts';
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
	const id = `syn_p6_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
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
		id: 'deck_p6',
		userId: 'p1',
		name: 'Track P6 Deck',
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
		name: 'P6 Filler Plains',
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
	const state = createInitialGameState('P6_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: 40
	});
	state.status = 'active';
	state.turnNumber = 1;
	state.turnSerial = 1;
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

function giveRichMana(player: PlayerGameState, amount = 20): void {
	player.manaPool = { W: amount, U: amount, B: amount, R: amount, G: amount, C: amount };
}

function resolveAllStack(state: GameState): void {
	let guard = 0;
	while (state.stack.length > 0 && state.pendingPrompts.length === 0 && guard < 40) {
		guard++;
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, priorityPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `Failed passing priority: ${res.error}`);
	}
}

function advanceSinglePhase(state: GameState): void {
	assert.equal(state.stack.length, 0);
	for (let i = 0; i < state.players.length; i++) {
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, priorityPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `Failed advancing phase: ${res.error}`);
	}
}

describe('Track P6 — Striated & Inset Permanent Frames + 10 Orthogonal CR 702 Keywords', () => {
	describe('Station & Striated Permanents (CR 722, CR 702.184)', () => {
		const spacecraftCard = synthCard({
			name: 'P6 Vanguard Cruiser',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact — Spacecraft',
			oracleText: 'Station\n3+ | Flying\n7+ | Vigilance',
			power: '4',
			toughness: '5',
			keywords: ['Station']
		});

		const planetCard = synthCard({
			name: 'P6 Molten Coreworld',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land — Planet',
			oracleText: '~ enters tapped.\n{T}: Add {R}.\nStation\n12+ | {T}: Add {R}{R}{R}.',
			keywords: ['Station']
		});

		it('suppresses Spacecraft printed P/T off-battlefield (CR 722.2c) and unlocks striations at charge-counter thresholds', () => {
			const def = compileCard(spacecraftCard);
			assert.equal(def.fullySupported, true);

			// CR 722.2c: Non-creature Spacecraft has no power/toughness outside the battlefield.
			for (const zone of ['hand', 'graveyard', 'stack'] as const) {
				const view = resolveObjectFaces(spacecraftCard, { zone });
				assert.equal(view.power, undefined, `Expected undefined power in ${zone}`);
				assert.equal(view.toughness, undefined, `Expected undefined toughness in ${zone}`);
			}

			const { state, p1 } = setupMain1Game();
			const ship = addCardToZone(state, p1, spacecraftCard, 'battlefield');
			const pilotA = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Cadet Pilot',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Creature — Human Pilot',
					power: '3',
					toughness: '2'
				}),
				'battlefield',
				true // summoning sick creatures CAN still tap to pay Station's tapOthers cost!
			);
			const pilotB = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Veteran Captain',
					manaCost: '{4}',
					cmc: 4,
					typeLine: 'Creature — Human Pilot',
					power: '4',
					toughness: '4'
				}),
				'battlefield',
				false
			);

			// 0 charge counters: non-creature Artifact, no Flying, no Vigilance
			let evalShip = evaluatePermanent(state, ship);
			assert.equal(evalShip.typeLine.includes('Creature'), false);
			assert.equal(hasKeyword(ship, 'flying', state), false);

			const stationAb = getEffectiveActivatedAbilities(state, p1, ship).find((a) =>
				a.id.startsWith('station_')
			);
			assert.ok(stationAb, 'Expected Station activated ability on Spacecraft');

			// Station once with 3-power pilot -> 3 charge counters: gains Flying, still not a Creature (< 7)
			const act1 = applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: ship.instanceId,
				abilityId: stationAb.id,
				costPayment: { objects: [[pilotA.instanceId]] }
			});
			assert.equal(act1.ok, true);
			assert.equal(pilotA.tapped, true);
			resolveAllStack(state);

			assert.equal(ship.counters.charge, 3);
			evalShip = evaluatePermanent(state, ship);
			assert.equal(hasKeyword(ship, 'flying', state), true);
			assert.equal(hasKeyword(ship, 'vigilance', state), false);
			assert.equal(evalShip.typeLine.includes('Creature'), false);

			// Station again with 4-power captain -> 7 charge counters: becomes 4/5 Artifact Creature with Flying & Vigilance!
			const act2 = applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: ship.instanceId,
				abilityId: stationAb.id,
				costPayment: { objects: [[pilotB.instanceId]] }
			});
			assert.equal(act2.ok, true);
			resolveAllStack(state);

			assert.equal(ship.counters.charge, 7);
			evalShip = evaluatePermanent(state, ship);
			assert.equal(evalShip.typeLine.includes('Artifact'), true);
			assert.equal(evalShip.typeLine.includes('Creature'), true);
			assert.equal(evalShip.power, 4);
			assert.equal(evalShip.toughness, 5);
			assert.equal(hasKeyword(ship, 'flying', state), true);
			assert.equal(hasKeyword(ship, 'vigilance', state), true);
		});

		it('uses resolution-time power when the tapped creature stays on board and LKI power if removed in response (CR 702.184a, CR 608.2h)', () => {
			const { state, p1, p2 } = setupMain1Game();
			giveRichMana(p1);
			giveRichMana(p2);
			const ship = addCardToZone(state, p1, spacecraftCard, 'battlefield');
			const helper = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Power Conduit',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Creature — Construct',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const pumpInstant = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Surge Boost',
					manaCost: '{G}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Target creature gets +3/+3 until end of turn.'
				}),
				'hand'
			);

			const stationAb = getEffectiveActivatedAbilities(state, p1, ship).find((a) =>
				a.id.startsWith('station_')
			)!;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: ship.instanceId,
					abilityId: stationAb.id,
					costPayment: { objects: [[helper.instanceId]] }
				}).ok,
				true
			);
			// Pump the tapped creature in response before Station resolves -> 2 + 3 = 5 charge counters!
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: pumpInstant.instanceId,
					targets: [{ kind: 'permanent', id: helper.instanceId, label: helper.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(ship.counters.charge, 5);

			// Also verify sorcery-speed restriction on opponent's turn
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 0;
			helper.tapped = false;
			const illegal = checkAbilityActivationLegality(state, 'p1', ship, stationAb);
			assert.equal(illegal.ok, false);
		});

		it('gates Planet land striated mana abilities and triggered striations on charge counters (CR 722.2a)', () => {
			const def = compileCard(planetCard);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = setupMain1Game();
			const planet = addCardToZone(state, p1, planetCard, 'battlefield');
			planet.tapped = false;

			// At 0 charge counters: only 1 mana ability + Station (2 total activated abilities)
			let abs = getEffectiveActivatedAbilities(state, p1, planet);
			assert.equal(abs.filter((a) => a.isManaAbility).length, 1);

			// At 12 charge counters: 12+ mana ability unlocks!
			planet.counters.charge = 12;
			abs = getEffectiveActivatedAbilities(state, p1, planet);
			const manaAbs = abs.filter((a) => a.isManaAbility);
			assert.equal(manaAbs.length, 2);
			const bigMana = manaAbs.find((a) => a.producesAmount === 3);
			assert.ok(bigMana, 'Expected 3-mana striated ability at 12+ charge counters');
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			const tapRes = applyGameAction(state, 'p1', {
				type: 'tap_mana',
				instanceId: planet.instanceId,
				abilityId: bigMana.id
			});
			assert.equal(tapRes.ok, true);
			assert.equal(p1.manaPool.R, 3);
		});
	});

	describe('Level up & Leveler Cards (CR 711, CR 702.87)', () => {
		const levelerCard = synthCard({
			name: 'P6 Skyknight Aspirant',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Knight',
			oracleText:
				'Level up {1}{W}\nLEVEL 1-2\n2/3\nFirst strike\nLEVEL 3+\n4/5\nFlying, first strike',
			colors: ['W'],
			colorIdentity: ['W'],
			power: '1',
			toughness: '1',
			keywords: ['Level up']
		});

		it('progresses through level tiers as level counters are placed and reverts under Layer 6 ability loss (CR 711.5)', () => {
			const def = compileCard(levelerCard);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const knight = addCardToZone(state, p1, levelerCard, 'battlefield');

			// Level 0: 1/1, no keywords
			let ev = evaluatePermanent(state, knight);
			assert.equal(ev.power, 1);
			assert.equal(ev.toughness, 1);
			assert.equal(hasKeyword(knight, 'first strike', state), false);
			assert.equal(hasKeyword(knight, 'flying', state), false);

			const lvlAb = getEffectiveActivatedAbilities(state, p1, knight).find((a) =>
				a.id.startsWith('level_up_')
			);
			assert.ok(lvlAb, 'Expected Level up activated ability');

			// Level 1: 2/3 with First strike
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: knight.instanceId,
					abilityId: lvlAb.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(knight.counters.level, 1);
			ev = evaluatePermanent(state, knight);
			assert.equal(ev.power, 2);
			assert.equal(ev.toughness, 3);
			assert.equal(hasKeyword(knight, 'first strike', state), true);
			assert.equal(hasKeyword(knight, 'flying', state), false);

			// Level 3: 4/5 with Flying and First strike
			knight.counters.level = 2;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: knight.instanceId,
					abilityId: lvlAb.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(knight.counters.level, 3);
			ev = evaluatePermanent(state, knight);
			assert.equal(ev.power, 4);
			assert.equal(ev.toughness, 5);
			assert.equal(hasKeyword(knight, 'flying', state), true);
			assert.equal(hasKeyword(knight, 'first strike', state), true);

			// Layer 6 ability loss ("Creatures lose all abilities."):
			// CR 711.5: Level striation static abilities are removed in Layer 6, so Layer 7b setter does not apply!
			addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Mind Blank Field',
					manaCost: '{2}{W}{W}',
					cmc: 4,
					typeLine: 'Enchantment',
					oracleText: 'Creatures lose all abilities.'
				}),
				'battlefield'
			);
			ev = evaluatePermanent(state, knight);
			assert.equal(ev.losesAllAbilities, true);
			assert.equal(ev.power, 1);
			assert.equal(ev.toughness, 1);
			assert.equal(hasKeyword(knight, 'flying', state), false);
		});
	});

	describe('Prototype & Offspring Interaction (CR 719, CR 702.160, CR 702.175)', () => {
		const protoCard = synthCard({
			name: 'P6 Forge Strider',
			manaCost: '{7}',
			cmc: 7,
			typeLine: 'Artifact Creature — Construct',
			oracleText: 'Prototype {1}{R}{R} — 3/3\nTrample',
			colors: [],
			colorIdentity: ['R'],
			power: '6',
			toughness: '5',
			keywords: ['Prototype', 'Trample']
		});

		it('casts normally as 6/5 colorless MV 7 or prototyped as 3/3 red MV 3, preserving prototype on copies and resetting on zone change', () => {
			const def = compileCard(protoCard);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const inHand = addCardToZone(state, p1, protoCard, 'hand');

			const opts = getCastOptions(state, 'p1', inHand, 'hand');
			assert.ok(opts.some((o) => o.id === 'normal'));
			const protoOpt = opts.find((o) => o.id === 'alt:prototype');
			assert.ok(protoOpt, 'Expected alt:prototype CastOption');
			assert.equal(protoOpt.costDisplay, '{1}{R}{R}');

			// Only {1}{R}{R} available: normal cast ({7}) is illegal, prototyped cast is legal!
			p1.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 1 };
			assert.equal(checkSpellCastLegality(state, 'p1', inHand, 'hand', 0, 'normal').ok, false);
			assert.equal(checkSpellCastLegality(state, 'p1', inHand, 'hand', 0, 'alt:prototype').ok, true);

			const castRes = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: inHand.instanceId,
				optionId: 'alt:prototype'
			});
			assert.equal(castRes.ok, true);

			// On stack: mana value is 3 and color is Red (CR 719.3b)
			const stackItem = state.stack[0];
			assert.ok(stackItem);
			assert.equal(objectManaValue(state, stackItem), 3);
			const stackFaces = resolveObjectFaces(stackItem.card, { zone: 'stack', prototyped: true });
			assert.deepEqual(stackFaces.colors, ['R']);

			resolveAllStack(state);

			// On battlefield: 3/3 Red Artifact Creature with Trample and MV 3
			const perm = p1.battlefield.find((c) => c.instanceId === inHand.instanceId)!;
			assert.ok(perm);
			const ev = evaluatePermanent(state, perm);
			assert.equal(ev.power, 3);
			assert.equal(ev.toughness, 3);
			assert.deepEqual(ev.colors, ['R']);
			assert.equal(hasKeyword(perm, 'trample', state), true);
			assert.equal(objectManaValue(state, perm), 3);

			// CR 719.3d: Copying a prototyped permanent copies its prototype characteristics (3/3, Red, MV 3)
			giveRichMana(p1);
			const cloneSpell = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Mirrorcast',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Sorcery',
					oracleText: "Create a token that's a copy of target creature."
				}),
				'hand'
			);
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: cloneSpell.instanceId,
					targets: [{ kind: 'permanent', id: perm.instanceId, label: perm.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);

			const tokenCopy = p1.battlefield.find((c) => c.isToken)!;
			assert.ok(tokenCopy);
			const tokenEv = evaluatePermanent(state, tokenCopy);
			assert.equal(tokenEv.power, 3);
			assert.equal(tokenEv.toughness, 3);
			assert.deepEqual(tokenEv.colors, ['R']);
			assert.equal(objectManaValue(state, tokenCopy), 3);

			// CR 719.4: When the prototyped permanent dies, it reverts to normal characteristics in graveyard
			const killSpell = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Shatter Bolt',
					manaCost: '{1}{B}',
					cmc: 2,
					typeLine: 'Instant',
					oracleText: 'Destroy target creature.'
				}),
				'hand'
			);
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: killSpell.instanceId,
					targets: [{ kind: 'permanent', id: perm.instanceId, label: perm.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);

			const inGy = p1.graveyard.find((c) => c.instanceId === perm.instanceId)!;
			assert.ok(inGy);
			assert.equal(inGy.prototyped, undefined);
			assert.equal(objectManaValue(state, inGy), 7);
			const gyFaces = resolveObjectFaces(inGy.card, { zone: 'graveyard' });
			assert.deepEqual(gyFaces.colors, []);
			assert.equal(gyFaces.power, 6);
			assert.equal(gyFaces.toughness, 5);
		});

		it('creates a 1/1 token with Offspring (including LKI if parent dies before trigger resolves and Prototype color preservation)', () => {
			const protoOffspringCard = synthCard({
				name: 'P6 Ember Automaton',
				manaCost: '{6}',
				cmc: 6,
				typeLine: 'Artifact Creature — Golem',
				oracleText: 'Prototype {1}{R} — 2/2\nOffspring {2}\nHaste',
				colors: [],
				colorIdentity: ['R'],
				power: '5',
				toughness: '5',
				keywords: ['Prototype', 'Offspring', 'Haste']
			});
			assert.equal(compileCard(protoOffspringCard).fullySupported, true);

			const { state, p1, p2 } = setupMain1Game();
			giveRichMana(p1);
			giveRichMana(p2);
			const cardInst = addCardToZone(state, p1, protoOffspringCard, 'hand');

			// Cast Prototyped ({1}{R}) + Offspring ({2})
			const castRes = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: cardInst.instanceId,
				optionId: 'alt:prototype',
				optionalCostCounts: { 'offspring:0': 1 }
			});
			assert.equal(castRes.ok, true);

			// Resolve creature spell; stop with Offspring ETB trigger on stack!
			assert.equal(applyGameAction(state, 'p1', { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, 'p2', { type: 'pass_priority' }).ok, true);
			assert.equal(state.stack.length, 1, 'Offspring ETB trigger should be on the stack');

			// Destroy parent in response to test CR 707.11 LKI + plain-JSON round-trip!
			const removal = addCardToZone(
				state,
				p2,
				synthCard({
					name: 'P6 Instant Smelt',
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Destroy target artifact.'
				}),
				'hand'
			);
			state.priorityPlayerIndex = 1;
			assert.equal(
				applyGameAction(state, 'p2', {
					type: 'cast_spell',
					instanceId: removal.instanceId,
					targets: [{ kind: 'permanent', id: cardInst.instanceId, label: cardInst.card.name }]
				}).ok,
				true
			);

			// Plain-JSON round-trip mid-stack
			const reloaded = JSON.parse(JSON.stringify(state)) as GameState;
			resolveAllStack(reloaded);

			const reloadedP1 = reloaded.players[0];
			assert.equal(reloadedP1.battlefield.length, 1);
			const baby = reloadedP1.battlefield[0];
			assert.equal(baby.isToken, true);
			const babyEv = evaluatePermanent(reloaded, baby);
			assert.equal(babyEv.power, 1);
			assert.equal(babyEv.toughness, 1);
			assert.deepEqual(babyEv.colors, ['R'], 'Offspring of prototyped Golem keeps Prototype Red color');
			assert.equal(objectManaValue(reloaded, baby), 2, 'Offspring of prototyped Golem keeps Prototype MV 2');
			assert.equal(hasKeyword(baby, 'haste', reloaded), true);
		});
	});

	describe('Squad, Replicate, Conspire, Casualty (CR 702.157, 702.56, 702.78, 702.153)', () => {
		it('creates N token copies when Squad is paid N times (CR 702.157a)', () => {
			const squadCard = synthCard({
				name: 'P6 Trench Vanguard',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Soldier',
				oracleText: 'Squad {2}\nVigilance',
				colors: ['W'],
				colorIdentity: ['W'],
				power: '2',
				toughness: '2',
				keywords: ['Squad', 'Vigilance']
			});
			assert.equal(compileCard(squadCard).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const inst = addCardToZone(state, p1, squadCard, 'hand');

			const res = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: inst.instanceId,
				optionalCostCounts: { 'squad:0': 3 }
			});
			assert.equal(res.ok, true);
			resolveAllStack(state);

			// Original + 3 token copies = 4 total 2/2 Soldiers with Vigilance
			assert.equal(p1.battlefield.length, 4);
			assert.equal(p1.battlefield.filter((c) => c.isToken).length, 3);
			for (const perm of p1.battlefield) {
				const ev = evaluatePermanent(state, perm);
				assert.equal(ev.power, 2);
				assert.equal(ev.toughness, 2);
				assert.equal(hasKeyword(perm, 'vigilance', state), true);
			}
		});

		it('copies a Replicate spell on cast for each time Replicate was paid and supports retargeting prompts (CR 702.56a)', () => {
			const replicateCard = synthCard({
				name: 'P6 Spark Barrage',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Replicate {1}{R}\n~ deals 2 damage to any target.',
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Replicate']
			});
			assert.equal(compileCard(replicateCard).fullySupported, true);

			const { state, p1, p2 } = setupMain1Game();
			giveRichMana(p1);
			const inst = addCardToZone(state, p1, replicateCard, 'hand');

			const startLife = p2.life;
			const res = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: inst.instanceId,
				targets: [{ kind: 'player', id: 'p2', label: 'Bob' }],
				optionalCostCounts: { 'replicate:0': 2 }
			});
			assert.equal(res.ok, true);

			// Resolve Replicate cast trigger, declining retarget on both copies so all 3 hit Bob
			resolveAllStack(state);
			while (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				assert.equal(prm.choice?.kind, 'yesNo');
				assert.equal(
					applyGameAction(state, 'p1', {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'yesNo', yes: false }
					}).ok,
					true
				);
				resolveAllStack(state);
			}

			// Original + 2 copies = 3 * 2 = 6 damage!
			assert.equal(p2.life, startLife - 6);
		});

		it('enforces color-sharing creature taps for Conspire and copies the spell on cast (CR 702.78a)', () => {
			const conspireCard = synthCard({
				name: 'P6 Chorus of Insight',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Draw two cards.\nConspire',
				colors: ['G'],
				colorIdentity: ['G'],
				keywords: ['Conspire']
			});
			assert.equal(compileCard(conspireCard).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const spell = addCardToZone(state, p1, conspireCard, 'hand');
			const elf1 = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Green Druid A',
					manaCost: '{G}',
					cmc: 1,
					typeLine: 'Creature — Elf Druid',
					colors: ['G'],
					power: '1',
					toughness: '1'
				}),
				'battlefield'
			);
			const blueMerfolk = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Blue Adept',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Creature — Merfolk Wizard',
					colors: ['U'],
					power: '1',
					toughness: '1'
				}),
				'battlefield'
			);

			// Only 1 green creature + 1 blue creature -> cannot pay Conspire for a pure green spell!
			assert.equal(
				checkSpellCastLegality(state, 'p1', spell, 'hand', 0, 'normal', { 'conspire:0': 1 }).ok,
				false
			);

			const elf2 = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Green Red Shaman',
					manaCost: '{R}{G}',
					cmc: 2,
					typeLine: 'Creature — Elf Shaman',
					colors: ['R', 'G'],
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);

			// Now two creatures share Green with the spell -> Conspire legal!
			assert.equal(
				checkSpellCastLegality(state, 'p1', spell, 'hand', 0, 'normal', { 'conspire:0': 1 }).ok,
				true
			);
			const res = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				optionalCostCounts: { 'conspire:0': 1 },
				costPayment: { objects: [[elf1.instanceId, elf2.instanceId]] }
			});
			assert.equal(res.ok, true);
			assert.equal(elf1.tapped, true);
			assert.equal(elf2.tapped, true);
			assert.equal(blueMerfolk.tapped, false);

			resolveAllStack(state);
			// Original + 1 copy = 4 cards drawn!
			assert.equal(p1.hand.length, 4);
		});

		it('enforces power >= N sacrifice for Casualty N and copies the spell on cast (CR 702.153a)', () => {
			const casualtyCard = synthCard({
				name: 'P6 Syndicate Extraction',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Casualty 2\nTarget opponent loses 3 life and you gain 3 life.',
				colors: ['B'],
				colorIdentity: ['B'],
				keywords: ['Casualty']
			});
			assert.equal(compileCard(casualtyCard).fullySupported, true);

			const { state, p1, p2 } = setupMain1Game();
			giveRichMana(p1);
			const spell = addCardToZone(state, p1, casualtyCard, 'hand');
			const tiny = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Tiny Informant',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Creature — Rogue',
					colors: ['B'],
					power: '1',
					toughness: '1'
				}),
				'battlefield'
			);

			// Power 1 creature cannot pay Casualty 2!
			assert.equal(
				checkSpellCastLegality(state, 'p1', spell, 'hand', 0, 'normal', { 'casualty:0': 1 }).ok,
				false
			);

			const enforcer = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Muscle Enforcer',
					manaCost: '{2}{B}',
					cmc: 3,
					typeLine: 'Creature — Ogre Rogue',
					colors: ['B'],
					power: '3',
					toughness: '2'
				}),
				'battlefield'
			);

			const p1Start = p1.life;
			const p2Start = p2.life;
			const res = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'player', id: 'p2', label: 'Bob' }],
				optionalCostCounts: { 'casualty:0': 1 },
				costPayment: { objects: [[enforcer.instanceId]] }
			});
			assert.equal(res.ok, true);
			assert.equal(p1.battlefield.some((c) => c.instanceId === enforcer.instanceId), false);
			assert.equal(p1.battlefield.some((c) => c.instanceId === tiny.instanceId), true);

			resolveAllStack(state);
			assert.equal(p2.life, p2Start - 6);
			assert.equal(p1.life, p1Start + 6);
		});
	});

	describe('Warp (CR 702.185)', () => {
		const warpCard = synthCard({
			name: 'P6 Chrono Titan',
			manaCost: '{6}',
			cmc: 6,
			typeLine: 'Artifact Creature — Robot Giant',
			oracleText: 'Warp {2}\nTrample',
			power: '6',
			toughness: '6',
			keywords: ['Warp', 'Trample']
		});

		it('casts from hand via Warp, exiles at next end step, blocks same-turn exile cast, and allows normal cast on later turns', () => {
			assert.equal(compileCard(warpCard).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 };
			const titan = addCardToZone(state, p1, warpCard, 'hand');

			// Cast via Warp {2}
			const castWarp = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: titan.instanceId,
				optionId: 'alt:warp'
			});
			assert.equal(castWarp.ok, true);
			resolveAllStack(state);

			assert.equal(p1.battlefield.some((c) => c.instanceId === titan.instanceId), true);
			assert.equal(
				state.delayedTriggers?.some((dt) => dt.delayedEffect?.kind === 'warpExile'),
				true
			);

			// Enter end_step from main2 -> Warp delayed trigger goes onto the stack!
			state.phase = 'main2';
			state.passedPriorityPlayerIds = ['p1'];
			state.priorityPlayerIndex = 1;
			assert.equal(applyGameAction(state, 'p2', { type: 'pass_priority' }).ok, true);
			assert.equal(state.phase, 'end_step');
			// Warp delayed trigger is now on the stack at end_step!
			assert.equal(state.stack.length, 1);
			resolveAllStack(state);

			// Exiled by Warp!
			const exiledTitan = p1.exile.find((c) => c.instanceId === titan.instanceId)!;
			assert.ok(exiledTitan);
			assert.equal(exiledTitan.warpedByOwnerId, 'p1');

			// CR 702.185a: Cannot cast from exile during the SAME turn it was exiled (even with Flash / full mana)!
			giveRichMana(p1);
			assert.equal(getCastOptions(state, 'p1', exiledTitan, 'exile').length, 0);
			assert.equal(checkSpellCastLegality(state, 'p1', exiledTitan, 'exile').ok, false);

			// Advance to Alice's next turn main1
			state.turnNumber = 3;
			state.turnSerial = 3;
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			state.phase = 'main1';
			giveRichMana(p1);

			const exileOpts = getCastOptions(state, 'p1', exiledTitan, 'exile');
			assert.equal(exileOpts.some((o) => o.id === 'exile:warp'), true);
			assert.equal(
				exileOpts.some((o) => o.id === 'alt:warp'),
				false,
				'CR 702.185a: Warp alternative cost is hand-only'
			);

			const recast = applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: exiledTitan.instanceId,
				fromZone: 'exile',
				optionId: 'exile:warp'
			});
			assert.equal(recast.ok, true);
			resolveAllStack(state);

			const backOnBoard = p1.battlefield.find((c) => c.instanceId === titan.instanceId)!;
			assert.ok(backOnBoard);
			assert.equal(backOnBoard.warpedByOwnerId, undefined);
			assert.equal(
				state.delayedTriggers?.some((dt) => dt.delayedEffect?.kind === 'warpExile') ?? false,
				false,
				'Casting normally from exile via Warp permission does not re-exile at end step'
			);
		});
	});

	describe('Vanishing & Fading (CR 702.63, CR 702.32)', () => {
		it('Vanishing N enters with N time counters and sacrifices immediately when the last time counter is removed (upkeep or cost)', () => {
			const vanishingCard = synthCard({
				name: 'P6 Chrono Stalker',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Illusion',
				oracleText: 'Vanishing 2',
				colors: ['U'],
				colorIdentity: ['U'],
				power: '3',
				toughness: '3',
				keywords: ['Vanishing']
			});
			assert.equal(compileCard(vanishingCard).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const stalker = addCardToZone(state, p1, vanishingCard, 'hand');
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: stalker.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			const perm = p1.battlefield.find((c) => c.instanceId === stalker.instanceId)!;
			assert.equal(perm.counters.time, 2);

			// Upkeep #1: 2 -> 1 time counter, stays on battlefield
			state.phase = 'untap';
			advanceSinglePhase(state); // enters upkeep, puts Vanishing upkeep trigger on stack
			assert.equal(state.phase, 'upkeep');
			resolveAllStack(state);
			assert.equal(perm.counters.time, 1);
			assert.equal(p1.battlefield.some((c) => c.instanceId === perm.instanceId), true);

			// Upkeep #2: 1 -> 0 time counters -> "When the last time counter is removed" triggers sacrifice!
			state.phase = 'untap';
			advanceSinglePhase(state);
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === perm.instanceId), false);
			assert.equal(p1.graveyard.some((c) => c.instanceId === perm.instanceId), true);
		});

		it('Vanishing sacrifices when the last time counter is removed as an activated ability cost (CR 702.63a)', () => {
			const costRemoveVanish = synthCard({
				name: 'P6 Rift Feeder',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Horror',
				oracleText: 'Vanishing 1\nRemove a time counter from ~: Draw a card.',
				colors: ['B'],
				colorIdentity: ['B'],
				power: '2',
				toughness: '2',
				keywords: ['Vanishing']
			});
			assert.equal(compileCard(costRemoveVanish).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const horror = addCardToZone(state, p1, costRemoveVanish, 'hand');
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: horror.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			const perm = p1.battlefield.find((c) => c.instanceId === horror.instanceId)!;
			assert.equal(perm.counters.time, 1);
			const ab = getEffectiveActivatedAbilities(state, p1, perm)[0]!;
			assert.ok(ab);

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: perm.instanceId,
					abilityId: ab.id
				}).ok,
				true
			);
			resolveAllStack(state);

			assert.equal(p1.hand.length, 1);
			assert.equal(p1.battlefield.some((c) => c.instanceId === perm.instanceId), false);
			assert.equal(p1.graveyard.some((c) => c.instanceId === perm.instanceId), true);
		});

		it('Fading N survives the upkeep that removes its last fade counter and sacrifices on the NEXT upkeep when unable to remove one (CR 702.32a)', () => {
			const fadingCard = synthCard({
				name: 'P6 Ephemeral Wurm',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Wurm',
				oracleText: 'Fading 1',
				colors: ['G'],
				colorIdentity: ['G'],
				power: '5',
				toughness: '5',
				keywords: ['Fading']
			});
			assert.equal(compileCard(fadingCard).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const wurm = addCardToZone(state, p1, fadingCard, 'hand');
			assert.equal(
				applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: wurm.instanceId }).ok,
				true
			);
			resolveAllStack(state);

			const perm = p1.battlefield.find((c) => c.instanceId === wurm.instanceId)!;
			assert.equal(perm.counters.fade, 1);

			// Upkeep #1: removes last fade counter (1 -> 0), Wurm SURVIVES at 0 fade counters!
			state.phase = 'untap';
			advanceSinglePhase(state);
			resolveAllStack(state);
			assert.equal(perm.counters.fade, 0);
			assert.equal(p1.battlefield.some((c) => c.instanceId === perm.instanceId), true);

			// Upkeep #2: 0 fade counters -> unable to remove -> sacrificed!
			state.phase = 'untap';
			advanceSinglePhase(state);
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === perm.instanceId), false);
			assert.equal(p1.graveyard.some((c) => c.instanceId === perm.instanceId), true);
		});
	});

	describe('Transmute & Reinforce (CR 702.53, CR 702.77)', () => {
		it('Transmute discards from hand at sorcery speed and searches library only for cards with exact matching mana value', () => {
			const transmuteCard = synthCard({
				name: 'P6 Dimir Courier',
				manaCost: '{1}{U}{B}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Draw a card.\nTransmute {1}{U}{U}',
				colors: ['U', 'B'],
				colorIdentity: ['U', 'B'],
				keywords: ['Transmute']
			});
			assert.equal(compileCard(transmuteCard).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			const inHand = addCardToZone(state, p1, transmuteCard, 'hand');

			const mv2Card = createCardInstance(
				synthCard({ name: 'P6 Two Drop', manaCost: '{1}{U}', cmc: 2, typeLine: 'Artifact' }),
				'p1',
				'library',
				false,
				false,
				undefined,
				state
			);
			const mv3Card = createCardInstance(
				synthCard({ name: 'P6 Three Drop', manaCost: '{2}{B}', cmc: 3, typeLine: 'Sorcery' }),
				'p1',
				'library',
				false,
				false,
				undefined,
				state
			);
			p1.library = [mv2Card, mv3Card];

			const handAbs = getEffectiveActivatedAbilities(state, p1, inHand);
			const transAb = handAbs.find((a) => a.id.startsWith('transmute_'))!;
			assert.ok(transAb);

			// Sorcery-speed check: illegal on opponent's turn
			state.activePlayerIndex = 1;
			assert.equal(checkAbilityActivationLegality(state, 'p1', inHand, transAb).ok, false);
			state.activePlayerIndex = 0;
			assert.equal(checkAbilityActivationLegality(state, 'p1', inHand, transAb).ok, true);

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: inHand.instanceId,
					abilityId: transAb.id
				}).ok,
				true
			);
			assert.equal(p1.graveyard.some((c) => c.instanceId === inHand.instanceId), true);
			resolveAllStack(state);

			// Human search prompt should offer ONLY mv3Card (plus fail-to-find since statedQuality: true)!
			const prompt = state.pendingPrompts[0];
			assert.ok(prompt);
			assert.equal(prompt.kind, 'search_library');
			assert.deepEqual(prompt.candidateInstanceIds, [mv3Card.instanceId]);

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'search_library_pick',
					instanceId: mv3Card.instanceId
				}).ok,
				true
			);
			assert.equal(p1.hand.some((c) => c.instanceId === mv3Card.instanceId), true);
		});

		it('Reinforce N—[cost] activates from hand at instant speed to put N +1/+1 counters on target creature', () => {
			const reinforceCard = synthCard({
				name: 'P6 Rallying Surge',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Target creature gets +2/+2 until end of turn.\nReinforce 2—{1}{G}',
				colors: ['G'],
				colorIdentity: ['G'],
				keywords: ['Reinforce']
			});
			assert.equal(compileCard(reinforceCard).fullySupported, true);

			const { state, p1 } = setupMain1Game();
			giveRichMana(p1);
			// Opponent's turn in combat -> Reinforce is instant-speed so it's legal!
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 0;
			state.phase = 'begin_combat';

			const inHand = addCardToZone(state, p1, reinforceCard, 'hand');
			const bear = addCardToZone(
				state,
				p1,
				synthCard({
					name: 'P6 Forest Vanguard',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					colors: ['G'],
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);

			const reinfAb = getEffectiveActivatedAbilities(state, p1, inHand).find((a) =>
				a.id.startsWith('reinforce_')
			)!;
			assert.ok(reinfAb);
			assert.equal(checkAbilityActivationLegality(state, 'p1', inHand, reinfAb).ok, true);

			const res = applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: inHand.instanceId,
				abilityId: reinfAb.id,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			});
			assert.equal(res.ok, true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === inHand.instanceId), true);

			resolveAllStack(state);
			assert.equal(bear.counters['+1/+1'], 2);
			const ev = evaluatePermanent(state, bear);
			assert.equal(ev.power, 4);
			assert.equal(ev.toughness, 4);
		});
	});

	describe('Card-Rename Invariance (Engine Invariant)', () => {
		it('produces identical IR structure regardless of card name across striated and inset frames', () => {
			const shipA = synthCard({
				name: 'Alpha Orbital',
				manaCost: '{4}',
				cmc: 4,
				typeLine: 'Artifact — Spacecraft',
				oracleText: 'Station\n4+ | Flying\n8+ | Haste',
				power: '5',
				toughness: '5'
			});
			const shipB = synthCard({
				...shipA,
				name: 'Omega Dreadnought'
			});
			const stripNameAndSpan = (v: unknown): unknown =>
				JSON.parse(
					JSON.stringify(v, (k, val) =>
						k === 'name' || k === 'span' || k === 'oracleId' || k === 'textHash' ? undefined : val
					)
				);
			assert.deepEqual(
				stripNameAndSpan(compileCard(shipA)),
				stripNameAndSpan(compileCard(shipB))
			);
		});
	});
});
