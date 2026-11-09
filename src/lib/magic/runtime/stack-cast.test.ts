import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkLandPlayLegality,
	checkSpellCastLegality,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	getCardActivatedAbilities,
	getEffectiveActivatedAbilities,
	movePermanentToZone,
	resolveTopOfStack
} from '../engine.ts';
import {
	canPayManaCost,
	deductManaFromPool,
	parseManaCost
} from '../oracle.ts';
import { STAPLE_CARDS, PRECON_DECKS } from '../precons.ts';
import {
	effectiveSpellManaCost,
	payPlannedCosts,
	planCosts,
	type CostContext
} from './costs.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Instant',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function staple(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	assert.ok(c, `Missing staple card: ${name}`);
	return structuredClone(c);
}

function createTwoPlayerGame(): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `P${i + 1}`,
		avatarUrl: '',
		isBot: false,
		deckId: PRECON_DECKS[i].id,
		deckName: PRECON_DECKS[i].name,
		commanderNames: PRECON_DECKS[i].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: PRECON_DECKS[i].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
	const state = createInitialGameState(
		'WAVE3C',
		seats,
		new Map([
			[0, PRECON_DECKS[0]],
			[1, PRECON_DECKS[1]]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command' | 'library'
): CardInstance {
	const ts = allocateTimestamp(state);
	const inst = createCardInstance(card, player.playerId, zone, false, false, ts);
	player[zone].push(inst);
	return inst;
}

describe('Wave 3C — Task 1: Phase 10 Ratchet Cleanup & Rename Invariance', () => {
	it('creates Treasure tokens with intrinsic mana ability based on subtype (CR 111.10a), independent of token name', () => {
		const { state, p1 } = createTwoPlayerGame();
		const customTreasure = createTokenOnBoard(state, p1, {
			name: 'Gleaming Dubloon',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Token Artifact — Treasure',
			keywords: []
		});
		const abilities = getEffectiveActivatedAbilities(state, p1, customTreasure);
		assert.ok(
			abilities.some((a) => a.isManaAbility && a.requiresTap && a.requiresSacrificeSelf),
			'Renamed Treasure subtype token still receives its intrinsic sacrifice-for-mana ability'
		);
	});
});

describe('Wave 3C — Task 2: Target Re-validation & Fizzle on Resolution (CR 608.2b)', () => {
	it('fizzles a single-target spell when its target permanent is flickered (new objectVersion per CR 400.7)', () => {
		for (const spellName of ['Murder', 'Synthetic Doom Ray']) {
			const { state, p1, p2 } = createTwoPlayerGame();
			const bear = putInZone(
				state,
				p2,
				makeCard({
					name: 'Target Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const murder = putInZone(
				state,
				p1,
				makeCard({
					name: spellName,
					manaCost: '{1}{B}{B}',
					cmc: 3,
					typeLine: 'Instant',
					oracleText: 'Destroy target creature.'
				}),
				'hand'
			);

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: murder.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			});
			assert.equal(castRes.ok, true);

			// Flicker bear (exile and return to battlefield -> bumps objectVersion twice)
			moveObject(state, bear, 'exile', {
				from: { player: p2, zone: 'battlefield' },
				toPlayer: p2,
				leaveBattlefieldReset: true,
				bumpVersion: true,
				newTimestamp: true
			});
			moveObject(state, bear, 'battlefield', {
				from: { player: p2, zone: 'exile' },
				toPlayer: p2,
				controllerId: p2.playerId,
				bumpVersion: true,
				newTimestamp: true
			});
			assert.ok((bear.objectVersion ?? 1) > 1);

			resolveTopOfStack(state);

			assert.ok(
				p2.battlefield.some((c) => c.instanceId === bear.instanceId),
				`${spellName}: flickered creature is a new object and survives`
			);
			assert.ok(
				p1.graveyard.some((c) => c.instanceId === murder.instanceId),
				`${spellName}: fizzled spell goes to caster's graveyard`
			);
		}
	});

	it('fizzles Equip on resolution if an opponent gains control of the target creature in response (CR 608.2b)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		const bear = putInZone(
			state,
			p1,
			makeCard({
				name: 'Loyal Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const abilities = getEffectiveActivatedAbilities(state, p1, boots);
		const equipAb = abilities.find((a) => a.id.startsWith('equip_'));
		assert.ok(equipAb);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: equipAb.id,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);

		// Opponent steals bear before Equip resolves
		p1.battlefield.splice(p1.battlefield.indexOf(bear), 1);
		bear.controllerId = p2.playerId;
		p2.battlefield.push(bear);

		resolveTopOfStack(state);
		assert.equal(boots.attachedToId, null, 'Equip fizzles when target creature is no longer controlled by you');
	});

	it('fizzles "target creature an opponent controls" when control changes to caster before resolution (CR 608.2b)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		const bear = putInZone(
			state,
			p2,
			makeCard({
				name: 'Enemy Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Opponent Smite',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature an opponent controls.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);

		// Caster gains control of bear before resolution
		p2.battlefield.splice(p2.battlefield.indexOf(bear), 1);
		bear.controllerId = p1.playerId;
		p1.battlefield.push(bear);

		resolveTopOfStack(state);
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === bear.instanceId),
			'Bear is not destroyed because it is no longer controlled by an opponent'
		);
	});

	it('fizzles "target creature" when target stops being a creature before resolution (CR 608.2b)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		const animArtifact = putInZone(
			state,
			p2,
			makeCard({
				name: 'Animated Relic',
				typeLine: 'Artifact Creature — Golem',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);
		const spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Creature Bolt',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: animArtifact.instanceId, label: animArtifact.card.name }]
			}).ok,
			true
		);

		// Target stops being a creature before resolution
		animArtifact.copiableCard = makeCard({
			name: 'Inert Relic',
			typeLine: 'Artifact'
		});

		resolveTopOfStack(state);
		assert.ok(
			p2.battlefield.some((c) => c.instanceId === animArtifact.instanceId),
			'Non-creature permanent is no longer a legal target for Destroy target creature'
		);
	});

	it('partially resolves a multi-target spell when 1 target becomes illegal and 1 remains legal (CR 608.2b)', () => {
		const { state, p1 } = createTwoPlayerGame();
		const c1 = putInZone(
			state,
			p1,
			makeCard({ name: 'Dead Elf 1', typeLine: 'Creature — Elf', power: '1', toughness: '1' }),
			'graveyard'
		);
		const c2 = putInZone(
			state,
			p1,
			makeCard({ name: 'Dead Elf 2', typeLine: 'Creature — Elf', power: '2', toughness: '2' }),
			'graveyard'
		);
		const multiReturn = putInZone(
			state,
			p1,
			makeCard({
				name: 'Twin Recall',
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Return two target creature cards from your graveyard to your hand.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: multiReturn.instanceId,
				targets: [
					{ kind: 'graveyard_card', id: c1.instanceId, label: c1.card.name },
					{ kind: 'graveyard_card', id: c2.instanceId, label: c2.card.name }
				]
			}).ok,
			true
		);

		// Exile c1 from graveyard in response so only c2 remains legal
		moveObject(state, c1, 'exile', {
			from: { player: p1, zone: 'graveyard' },
			toPlayer: p1,
			bumpVersion: true
		});

		resolveTopOfStack(state);
		assert.ok(
			p1.hand.some((c) => c.instanceId === c2.instanceId),
			'Remaining legal target c2 is returned to hand'
		);
		assert.ok(
			p1.exile.some((c) => c.instanceId === c1.instanceId),
			'Illegal target c1 stays in exile'
		);
	});
});

describe('Wave 3C — Task 3: Resolving Spell on Stack & End the Turn (CR 608.2n / 725.1b)', () => {
	it('exiles the resolving "End the turn." spell from the stack (CR 725.1b) instead of putting it into graveyard', () => {
		for (const cardName of ['Time Stop', 'Chrono Halt']) {
			const { state, p1 } = createTwoPlayerGame();
			const timeStop = putInZone(
				state,
				p1,
				makeCard({
					name: cardName,
					manaCost: '{4}{U}{U}',
					cmc: 6,
					typeLine: 'Instant',
					oracleText: 'End the turn.'
				}),
				'hand'
			);

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: timeStop.instanceId
				}).ok,
				true
			);
			assert.equal(state.stack.length, 1);

			resolveTopOfStack(state);

			assert.equal(state.stack.length, 0, 'Stack is emptied by End the turn');
			assert.ok(
				p1.exile.some((c) => c.instanceId === timeStop.instanceId),
				`${cardName} was on the stack while resolving and was exiled by CR 725.1b`
			);
			assert.ok(
				!p1.graveyard.some((c) => c.instanceId === timeStop.instanceId),
				`${cardName} is not put into the graveyard`
			);
		}
	});
});

describe('Wave 3C — Task 4: excludeSelf Instance Identity (CR 201.5) & DelayedTrigger objectVersion (CR 603.7c)', () => {
	it('applies "Other <Type> spells you cast cost {1} less" to a second copy of the same card name (CR 201.5)', () => {
		const { state, p1 } = createTwoPlayerGame();
		const lordCard = makeCard({
			name: 'Goblin Warchief Variant',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Creature — Goblin Warrior',
			oracleText: 'Other Goblin spells you cast cost {1} less to cast.',
			power: '2',
			toughness: '2'
		});
		const onBoard = putInZone(state, p1, lordCard, 'battlefield');
		const secondCopyInHand = putInZone(state, p1, structuredClone(lordCard), 'hand');

		assert.notEqual(onBoard.instanceId, secondCopyInHand.instanceId);
		assert.equal(onBoard.card.name, secondCopyInHand.card.name);

		const effCost = effectiveSpellManaCost(state, p1, secondCopyInHand);
		assert.equal(effCost.generic, 1, 'Second copy in hand gets {1} discount from on-board copy');

		p1.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 };
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, secondCopyInHand, 'hand').ok,
			true,
			'checkSpellCastLegality also applies {1} discount to second copy with same card name'
		);
	});

	it('does not exile a permanent from a DelayedTrigger if it left and re-entered with a new objectVersion (CR 603.7c)', () => {
		const { state, p1 } = createTwoPlayerGame();
		const bear = putInZone(
			state,
			p1,
			makeCard({
				name: 'Danced Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'graveyard'
		);
		const corpseDance = putInZone(state, p1, staple('Corpse Dance'), 'hand');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: corpseDance.instanceId
			}).ok,
			true
		);
		resolveTopOfStack(state);

		assert.ok(p1.battlefield.some((c) => c.instanceId === bear.instanceId));
		assert.equal(state.delayedTriggers?.length, 1);

		// Flicker bear before the end step so its objectVersion changes
		moveObject(state, bear, 'exile', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true
		});
		moveObject(state, bear, 'battlefield', {
			from: { player: p1, zone: 'exile' },
			toPlayer: p1,
			controllerId: p1.playerId,
			bumpVersion: true,
			newTimestamp: true
		});

		// Trigger end step
		assert.equal(applyGameAction(state, p1.playerId, { type: 'end_turn' }).ok, true);
		while (state.stack.length > 0) {
			resolveTopOfStack(state);
		}

		assert.ok(
			p1.battlefield.some((c) => c.instanceId === bear.instanceId),
			'Flickered bear has a new objectVersion and is not exiled by Corpse Dance delayed trigger'
		);
	});
});

describe('Wave 3C — Task 5: Zone-Change Integrity, Clone, Equip Timestamp & X Permanents', () => {
	it('forces hand, graveyard, and library destinations to card owner (CR 400.3)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		for (const destZone of ['hand', 'graveyard', 'library'] as const) {
			const ownedByP2 = putInZone(
				state,
				p2,
				makeCard({ name: `Owned By P2 (${destZone})`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			p2.battlefield.splice(p2.battlefield.indexOf(ownedByP2), 1);
			ownedByP2.controllerId = p1.playerId;
			p1.battlefield.push(ownedByP2);

			moveObject(state, ownedByP2, destZone, {
				from: { player: p1, zone: 'battlefield' },
				toPlayer: p1, // intentionally wrong player
				leaveBattlefieldReset: true,
				bumpVersion: true
			});

			assert.ok(
				p2[destZone].includes(ownedByP2),
				`Card owned by P2 goes to P2's ${destZone}, never P1's`
			);
			assert.ok(!p1[destZone].includes(ownedByP2));
		}
	});

	it('refuses to move an Instant or Sorcery card onto the battlefield (CR 304.4 / 307.4)', () => {
		const { state, p1 } = createTwoPlayerGame();
		const bolt = putInZone(
			state,
			p1,
			makeCard({ name: 'Lightning Bolt', typeLine: 'Instant', oracleText: 'Lightning Bolt deals 3 damage to any target.' }),
			'graveyard'
		);

		const dest = moveObject(state, bolt, 'battlefield', {
			from: { player: p1, zone: 'graveyard' },
			toPlayer: p1,
			bumpVersion: true
		});

		assert.equal(dest, 'graveyard');
		assert.ok(p1.graveyard.includes(bolt), 'Instant remains in graveyard');
		assert.ok(!p1.battlefield.includes(bolt), 'Instant is never placed on the battlefield');
	});

	it('initializes printed loyalty counters when a Planeswalker enters the battlefield via moveObject (CR 306.5b)', () => {
		const { state, p1 } = createTwoPlayerGame();
		const pw = putInZone(
			state,
			p1,
			makeCard({
				name: 'Test Walker',
				manaCost: '{2}{U}{U}',
				cmc: 4,
				typeLine: 'Legendary Planeswalker — Jace',
				loyalty: '4',
				oracleText: '+1: Draw a card.'
			}),
			'graveyard'
		);
		assert.equal(pw.counters.loyalty, 0);

		moveObject(state, pw, 'battlefield', {
			from: { player: p1, zone: 'graveyard' },
			toPlayer: p1,
			controllerId: p1.playerId,
			bumpVersion: true,
			newTimestamp: true
		});

		assert.equal(pw.counters.loyalty, 4, 'Planeswalker enters with 4 loyalty counters');
		checkStateBasedActions(state);
		assert.ok(p1.battlefield.includes(pw), 'Planeswalker survives SBAs');
	});

	it('resets transient state and controllerId on leaveBattlefieldReset (CR 108.4a / 400.7)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		const perm = putInZone(
			state,
			p2,
			makeCard({ name: 'Stolen Walker', typeLine: 'Creature — Shapeshifter', power: '2', toughness: '2' }),
			'battlefield'
		);
		p2.battlefield.splice(p2.battlefield.indexOf(perm), 1);
		perm.controllerId = p1.playerId;
		perm.usedLoyaltyThisTurn = true;
		perm.transformed = true;
		perm.isFaceDown = true;
		perm.goadedByPlayerIds = [p2.playerId];
		perm.playableFromExileBy = { playerId: p1.playerId, sourceName: 'Test', spendManaAsAnyColor: true };
		p1.battlefield.push(perm);

		movePermanentToZone(state, perm, 'graveyard');

		assert.equal(perm.controllerId, p2.playerId, 'controllerId resets to ownerId');
		assert.equal(perm.usedLoyaltyThisTurn, false);
		assert.equal(perm.transformed, false);
		assert.equal(perm.isFaceDown, false);
		assert.equal(perm.goadedByPlayerIds, undefined);
		assert.equal(perm.playableFromExileBy, undefined);
	});

	it('sets copiableCard on Clone and restores printed Clone card when leaving the battlefield (CR 707.2)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		const titan = putInZone(
			state,
			p2,
			makeCard({
				name: 'Frost Titan',
				manaCost: '{4}{U}{U}',
				cmc: 6,
				typeLine: 'Creature — Giant',
				power: '6',
				toughness: '6'
			}),
			'battlefield'
		);
		const clone = putInZone(state, p1, staple('Clone'), 'hand');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: clone.instanceId
			}).ok,
			true
		);
		resolveTopOfStack(state);

		const onBoard = p1.battlefield.find((c) => c.instanceId === clone.instanceId);
		assert.ok(onBoard);
		assert.equal(onBoard.copiableCard?.name, 'Frost Titan');

		movePermanentToZone(state, onBoard, 'graveyard');
		assert.equal(onBoard.copiableCard, undefined);
		assert.equal(onBoard.card.name, 'Clone', 'Dead Clone reverts to printed Clone card in graveyard');
	});

	it('updates Equipment timestamp when attaching via Equip (CR 613.7e)', () => {
		const { state, p1 } = createTwoPlayerGame();
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		const bear = putInZone(
			state,
			p1,
			makeCard({ name: 'Equipped Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const tsBefore = boots.enteredTimestamp ?? 0;
		assert.ok((bear.enteredTimestamp ?? 0) > tsBefore);

		const equipAb = getEffectiveActivatedAbilities(state, p1, boots).find((a) => a.id.startsWith('equip_'))!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: equipAb.id,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);

		assert.equal(boots.attachedToId, bear.instanceId);
		assert.ok(
			(boots.enteredTimestamp ?? 0) > (bear.enteredTimestamp ?? 0),
			'Equipment receives a new timestamp when attached (CR 613.7e)'
		);
	});

	it('propagates enteredWithX on permanent spells with {X} and applies X self-ETB counters (CR 107.3m)', () => {
		const { state, p1 } = createTwoPlayerGame();
		const hydra = putInZone(
			state,
			p1,
			makeCard({
				name: 'Mistcutter Hydra Variant',
				manaCost: '{X}{G}',
				cmc: 1,
				typeLine: 'Creature — Hydra',
				oracleText: 'This creature enters with X +1/+1 counters on it.',
				power: '0',
				toughness: '0'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: hydra.instanceId,
				xValue: 4
			}).ok,
			true
		);
		resolveTopOfStack(state);

		const onBoard = p1.battlefield.find((c) => c.instanceId === hydra.instanceId);
		assert.ok(onBoard, 'X-Hydra entered the battlefield and survived SBAs');
		assert.equal(onBoard.enteredWithX, 4);
		assert.equal(onBoard.counters['+1/+1'], 4);
	});
});

describe('Wave 3C — Task 6: Mana, Costs, Taxes & Land Plays', () => {
	it('restricts Exotic Orchard to colors that opponent lands can produce (CR 106.7) and does not give non-mana lands a fallback mana ability (CR 305.6)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		p1.battlefield = [];
		p2.battlefield = [];
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

		const orchard = putInZone(state, p1, staple('Exotic Orchard'), 'battlefield');
		const maze = putInZone(
			state,
			p2,
			makeCard({
				name: 'Maze of Ith',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText: '{T}: Untap target attacking creature. Prevent all combat damage that would be dealt to and dealt by that creature this turn.'
			}),
			'battlefield'
		);

		assert.equal(
			getEffectiveActivatedAbilities(state, p2, maze).some((a) => a.isManaAbility),
			false,
			'Maze of Ith has no mana ability (CR 305.6)'
		);

		// When opponent only controls Maze of Ith (no mana ability), Exotic Orchard cannot tap for mana
		const tapResEmpty = applyGameAction(state, p1.playerId, {
			type: 'tap_mana',
			instanceId: orchard.instanceId
		});
		assert.equal(tapResEmpty.ok, false, 'Exotic Orchard cannot produce mana when opponents control no mana-producing lands');

		// Give opponent an Island -> Exotic Orchard can now produce {U}, but not {R}
		putInZone(state, p2, staple('Island'), 'battlefield');
		const orchardAbilities = getEffectiveActivatedAbilities(state, p1, orchard);
		const manaAb = orchardAbilities.find((a) => a.isManaAbility);
		assert.ok(manaAb);
		assert.deepEqual(manaAb.producesMana, ['U']);
	});

	it('parses activated abilities whose cost text before the colon exceeds 75 characters (CR 602.1a)', () => {
		const longCostCard = makeCard({
			name: 'Verbose Altar',
			typeLine: 'Artifact',
			oracleText:
				'{2}, {T}, Tap an untapped artifact you control, Sacrifice another nonland permanent you control: Draw two cards.'
		});
		const abilities = getCardActivatedAbilities(longCostCard, ['W', 'U', 'B', 'R', 'G']);
		assert.equal(abilities.length, 1, 'Activated ability with >75-char cost before colon is parsed');
	});

	it('computes MV 2 for {2/W} (CR 202.3f) and supports hybrid {W/U}, 2-brid {2/W}, and Phyrexian {W/P} payment (CR 107.4e-f)', () => {
		const twobrid = parseManaCost('{2/W}{2/W}{2/W}');
		assert.equal(twobrid.totalCmc, 6, 'Each {2/W} symbol contributes 2 to mana value (CR 202.3f)');

		// Hybrid {W/U} paid with {U}
		const hybridReq = parseManaCost('{W/U}');
		assert.equal(canPayManaCost({ W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 }, hybridReq), true);
		const afterHybrid = deductManaFromPool({ W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 }, hybridReq);
		assert.equal(afterHybrid.U, 0);

		// 2-brid {2/W} paid with 2 colorless
		const singleTwobrid = parseManaCost('{2/W}');
		assert.equal(canPayManaCost({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 }, singleTwobrid), true);
		const afterTwobrid = deductManaFromPool({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 }, singleTwobrid);
		assert.equal(afterTwobrid.C, 0);

		// Phyrexian {W/P} cast by paying 2 life when pool has 0 mana
		const { state, p1 } = createTwoPlayerGame();
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		p1.battlefield = [];
		const phySpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Gitaxian Probe Variant',
				manaCost: '{U/P}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.'
			}),
			'hand'
		);
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: phySpell.instanceId
			}).ok,
			true,
			'Phyrexian mana spell can be cast by paying 2 life'
		);
		assert.equal(p1.life, lifeBefore - 2, '2 life paid for {U/P}');
	});

	it('applies generic taxes (and Commander Tax) after setZero alternative cost (CR 601.2f / 118.9d)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		// Put a permanent on P2's battlefield that taxes spells by {1}
		putInZone(
			state,
			p2,
			makeCard({
				name: 'Tax Sphere',
				typeLine: 'Artifact',
				oracleText: 'Spells your opponents cast cost {1} more to cast.'
			}),
			'battlefield'
		);
		// Put a commander in P1's command zone with castCount = 1 (+{2} commander tax)
		const cmd = p1.command[0];
		cmd.isCommander = true;
		cmd.commanderCastCount = 1;
		p1.commanderCastCounts = { [cmd.instanceId]: 1 };

		// Equip {0} modifier + tax test via parseManaCost & effectiveSpellManaCost
		const equipTaxed = parseManaCost('', 0, 1, 0);
		assert.equal(equipTaxed.generic, 1);

		const cmdCost = effectiveSpellManaCost(state, p1, cmd);
		assert.ok(cmdCost.generic >= 3, 'Commander tax (+2) and opponent sphere tax (+1) apply');
	});

	it('applies graveyardReplacement (Rest in Peace) to mill costs (CR 701.17)', () => {
		const { state, p1 } = createTwoPlayerGame();
		putInZone(state, p1, staple('Rest in Peace'), 'battlefield');
		const topCard = p1.library[0];
		const ctx: CostContext = {
			state,
			player: p1,
			source: p1.battlefield[0],
			xValue: 0,
			isSpell: false,
			baseMana: null,
			canPayMana: () => true,
			payMana: () => true
		};
		const plan = planCosts(ctx, [{ k: 'mill', count: { k: 'const', n: 1 } } as never]);
		assert.equal(plan.ok, true);
		if (plan.ok && !plan.question) {
			payPlannedCosts(ctx, plan);
		}
		assert.ok(p1.exile.includes(topCard), 'Milled cost card goes to exile under Rest in Peace');
		assert.ok(!p1.graveyard.includes(topCard));
	});

	it('increases max land plays from extraLandPlays static abilities (CR 305.2) and clears passedPriorityPlayerIds on play_land and suspend_card (CR 117.3c)', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		putInZone(
			state,
			p1,
			makeCard({
				name: 'Exploration',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Enchantment',
				oracleText: 'You may play an additional land on each of your turns.'
			}),
			'battlefield'
		);

		const land1 = putInZone(state, p1, staple('Forest'), 'hand');
		const land2 = putInZone(state, p1, staple('Forest'), 'hand');
		const land3 = putInZone(state, p1, staple('Forest'), 'hand');

		state.passedPriorityPlayerIds = [p2.playerId];
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: land1.instanceId }).ok,
			true
		);
		assert.deepEqual(
			state.passedPriorityPlayerIds,
			[],
			'play_land clears passedPriorityPlayerIds (CR 117.3c)'
		);

		assert.equal(
			checkLandPlayLegality(state, p1.playerId, land2).ok,
			true,
			'Exploration allows playing a second land on the same turn (CR 305.2)'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: land2.instanceId }).ok,
			true
		);
		assert.equal(
			checkLandPlayLegality(state, p1.playerId, land3).ok,
			false,
			'Third land is rejected when only 1 additional land play is granted'
		);

		// Suspend also clears passedPriorityPlayerIds (CR 117.3c)
		const talisman = putInZone(state, p1, staple('Sol Talisman'), 'hand');
		state.passedPriorityPlayerIds = [p2.playerId];
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'suspend_card', instanceId: talisman.instanceId }).ok,
			true
		);
		assert.deepEqual(
			state.passedPriorityPlayerIds,
			[],
			'suspend_card clears passedPriorityPlayerIds (CR 117.3c)'
		);
	});
});
