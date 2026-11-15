import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeBotStep } from '../ai.ts';
import { compileCard } from '../compiler/index.ts';
import {
	addCountersToPermanent,
	applyGameAction,
	checkAbilityActivationLegality,
	checkLandPlayLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	getLandPlayOptions,
	hasKeyword,
	resolveTopOfStack,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { objectPower, objectToughness } from './objectFilter.ts';
import { moveObject } from './zones.ts';
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
	const id = `syn_p8_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
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
		id: 'deck_p8',
		userId: 'p1',
		name: 'Track P8 Deck',
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
		name: 'P8 Filler Plains',
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
	const decksBySeat = new Map<number, MagicDeck>([
		[0, deck],
		[1, deck]
	]);
	const state = createInitialGameState('LOBBY_P8', seats, decksBySeat, DEFAULT_LOBBY_RULES);
	state.status = 'active';
	state.pendingPrompts = [];
	state.turnNumber = 2;
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	const [p1, p2] = state.players;
	p1.hand = [];
	p1.battlefield = [];
	p1.graveyard = [];
	p1.exile = [];
	p2.hand = [];
	p2.battlefield = [];
	p2.graveyard = [];
	p2.exile = [];
	return { state, p1, p2 };
}

function putOnBattlefield(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	opts: { tapped?: boolean; summoningSick?: boolean; isToken?: boolean } = {}
): CardInstance {
	const inst = createCardInstance(card, player.playerId, 'battlefield');
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	inst.tapped = Boolean(opts.tapped);
	inst.summoningSick = Boolean(opts.summoningSick);
	if (opts.isToken) inst.isToken = true;
	moveObject(state, inst, 'battlefield', {
		from: 'none',
		toPlayer: player,
		controllerId: player.playerId,
		newTimestamp: true,
		bumpVersion: true
	});
	return inst;
}

describe('Track P8.1 — Conditional Statics, Combat Cache Invalidation, & Single-Axis Layer 7a/7b CDAs', () => {
	it('re-evaluates "As long as ~ is attacking / blocking" and "As long as it\'s your turn" immediately as combat & turn state change', () => {
		const { state, p1, p2 } = setupMain1Game();
		const chargerCard = synthCard({
			name: 'Sunlit Charger',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Hound',
			oracleText:
				"As long as it's your turn, Sunlit Charger has first strike.\nAs long as Sunlit Charger is attacking, it gets +2/+2 and has trample.",
			power: '2',
			toughness: '2',
			colors: ['R']
		});
		const guardianCard = synthCard({
			name: 'Shieldwall Sentry',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Soldier',
			oracleText: 'As long as Shieldwall Sentry is blocking, it gets +0/+3.',
			power: '1',
			toughness: '2',
			colors: ['W']
		});
		assert.equal(compileCard(chargerCard).fullySupported, true);
		assert.equal(compileCard(guardianCard).fullySupported, true);

		const charger = putOnBattlefield(state, p1, chargerCard);
		const guardian = putOnBattlefield(state, p2, guardianCard);

		// In p1's main1: charger is on p1's turn (has First Strike) and not attacking (2/2, no Trample)
		assert.equal(getCreaturePower(charger, state), 2);
		assert.equal(getCreatureToughness(charger, state), 2);
		assert.equal(hasKeyword(charger, 'First Strike', state), true);
		assert.equal(hasKeyword(charger, 'Trample', state), false);
		assert.equal(getCreatureToughness(guardian, state), 2);

		// Move to declare_attackers and declare charger attacking p2
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		const atkRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: charger.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atkRes.ok, true);

		// Layer cache must immediately invalidate on combat mutation: charger is now 4/4 with Trample!
		assert.equal(getCreaturePower(charger, state), 4);
		assert.equal(getCreatureToughness(charger, state), 4);
		assert.equal(hasKeyword(charger, 'Trample', state), true);

		// Advance to declare_blockers and have p2 block with guardian
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.phase, 'declare_blockers');

		const blkRes = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [{ blockerInstanceId: guardian.instanceId, attackerInstanceId: charger.instanceId }]
		});
		assert.equal(blkRes.ok, true);
		// Guardian is now blocking -> 1/5 (survives 4 first-strike damage!)
		assert.equal(getCreatureToughness(guardian, state), 5);

		// Flip active turn to p2 in main2 and clear combat -> charger loses First Strike and +2/+2
		state.combat.active = false;
		state.combat.attackers = [];
		state.activePlayerIndex = 1;
		state.phase = 'main2';
		assert.equal(hasKeyword(charger, 'First Strike', state), false);
		assert.equal(getCreaturePower(charger, state), 2);
	});

	it('evaluates untapped, equipped, enchanted, counter-bearing, Coven, and player-life conditions', () => {
		const { state, p1, p2 } = setupMain1Game();
		const hexDuelist = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Poised Duelist',
				typeLine: 'Creature — Elf Rogue',
				oracleText:
					'As long as Poised Duelist is untapped, it has hexproof.\nAs long as Poised Duelist is equipped, it gets +2/+0 and has vigilance.',
				power: '2',
				toughness: '2'
			})
		);
		const blade = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Bronze Shortsword',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equip {1}'
			})
		);
		const falconer = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Skyward Captain',
				typeLine: 'Creature — Human Soldier',
				oracleText:
					'Each creature you control with a +1/+1 counter on it has flying.\nAs long as you control three or more creatures with different powers, creatures you control get +1/+1.',
				power: '2',
				toughness: '3'
			})
		);
		const shadowGuard = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Dusk Sentinel',
				typeLine: 'Creature — Spirit',
				oracleText: "Dusk Sentinel can't attack unless a player has 13 or less life.",
				power: '4',
				toughness: '4'
			})
		);

		// Untapped -> Hexproof; not equipped -> power 2
		assert.equal(hasKeyword(hexDuelist, 'Hexproof', state), true);
		hexDuelist.tapped = true;
		assert.equal(hasKeyword(hexDuelist, 'Hexproof', state), false);
		hexDuelist.tapped = false;
		assert.equal(hasKeyword(hexDuelist, 'Hexproof', state), true);

		// Powers right now: hexDuelist=2, falconer=2, shadowGuard=4 -> only 2 distinct powers {2, 4}; Coven is OFF
		assert.equal(getCreaturePower(falconer, state), 2);

		// Attach equipment to hexDuelist -> hexDuelist becomes power 4 -> powers are {4, 2, 4} -> still 2 distinct!
		blade.attachedToId = hexDuelist.instanceId;
		assert.equal(hasKeyword(hexDuelist, 'Vigilance', state), true);
		assert.equal(getCreaturePower(hexDuelist, state), 4);
		assert.equal(getCreaturePower(falconer, state), 2);

		// Put a +1/+1 counter on hexDuelist -> hexDuelist becomes 5/3 -> powers are {5, 2, 4} -> 3 distinct powers!
		// Coven turns ON (+1/+1 to all creatures you control) AND +1/+1 counter grants Flying!
		addCountersToPermanent(state, hexDuelist, '+1/+1', 1);
		assert.equal(hasKeyword(hexDuelist, 'Flying', state), true);
		assert.equal(hasKeyword(falconer, 'Flying', state), false);
		assert.equal(getCreaturePower(falconer, state), 3); // 2 base + 1 Coven!
		assert.equal(getCreaturePower(hexDuelist, state), 6); // 2 base + 2 equipped + 1 counter + 1 Coven!

		// Life threshold restriction: both players at 40 life -> shadowGuard can't attack
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		const illegalAtk = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: shadowGuard.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(illegalAtk.ok, false);

		// Drop p2 to 13 life -> shadowGuard CAN attack!
		p2.life = 13;
		const legalAtk = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: shadowGuard.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(legalAtk.ok, true);
	});

	it('evaluates single-axis Layer 7a CDAs and distinctCardTypesInZone (CR 300.1, 208.2a) in all zones', () => {
		const { state, p1, p2 } = setupMain1Game();
		const goyfCard = synthCard({
			name: 'Lhurgoyf Sample',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Lhurgoyf',
			oracleText:
				"Lhurgoyf Sample's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
			power: '*',
			toughness: '1+*'
		});
		const singleAxisCard = synthCard({
			name: 'Pack Exemplar',
			manaCost: '{2}{G}',
			cmc: 3,
			typeLine: 'Creature — Wolf',
			oracleText: "Pack Exemplar's power is equal to the number of creatures you control.",
			power: '*',
			toughness: '4'
		});
		assert.equal(compileCard(goyfCard).fullySupported, true);
		assert.equal(compileCard(singleAxisCard).fullySupported, true);

		// Populate graveyards: Legendary Artifact Creature (2 card types: Artifact, Creature — Legendary is a supertype!),
		// Basic Land (1 card type: Land), Tribal Instant (2 card types: Kindred, Instant) -> total 5 distinct card types!
		p1.graveyard.push(
			createCardInstance(
				synthCard({
					name: 'Ancient Automaton',
					typeLine: 'Legendary Artifact Creature — Golem'
				}),
				p1.playerId,
				'graveyard'
			),
			createCardInstance(
				synthCard({
					name: 'Basic Snow Forest',
					typeLine: 'Basic Snow Land — Forest'
				}),
				p1.playerId,
				'graveyard'
			)
		);
		p2.graveyard.push(
			createCardInstance(
				synthCard({
					name: 'Boggart Birth Rite',
					typeLine: 'Tribal Instant — Goblin'
				}),
				p2.playerId,
				'graveyard'
			)
		);

		// Off-battlefield (in hand): CR 208.2a Layer 7a CDA still functions!
		const goyfInHand = createCardInstance(goyfCard, p1.playerId, 'hand');
		p1.hand.push(goyfInHand);
		assert.equal(objectPower(state, goyfInHand), 5);
		assert.equal(objectToughness(state, goyfInHand), 6);

		// Move both onto p1's battlefield
		const goyfBf = putOnBattlefield(state, p1, goyfCard);
		const packBf = putOnBattlefield(state, p1, singleAxisCard);
		assert.equal(getCreaturePower(goyfBf, state), 5);
		assert.equal(getCreatureToughness(goyfBf, state), 6);
		// Single-axis CDA: p1 controls 2 creatures -> Pack Exemplar is 2/4!
		assert.equal(getCreaturePower(packBf, state), 2);
		assert.equal(getCreatureToughness(packBf, state), 4);
	});
});

describe('Track P8.2 — Static Combat Restrictions, Evasions, Multi-Block, & CR 509.1c Solver', () => {
	it('enforces Skulk (CR 702.118b), cantBlockExcept, additionalBlockCount, and minBlockers + maxBlockers', () => {
		const { state, p1, p2 } = setupMain1Game();
		const skulker = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Wharf Infiltrator',
				typeLine: 'Creature — Human Rogue',
				oracleText: 'Skulk',
				keywords: ['Skulk'],
				power: '2',
				toughness: '2'
			})
		);
		const elusive = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Phantom Stalker',
				typeLine: 'Creature — Illusion',
				oracleText: "Menace\nPhantom Stalker can't be blocked by more than one creature.",
				keywords: ['Menace'],
				power: '3',
				toughness: '2'
			})
		);
		const skyNet = putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Cloudreach Archer',
				typeLine: 'Creature — Elf Archer',
				oracleText: 'Reach\nCloudreach Archer can block only creatures with flying.',
				keywords: ['Reach'],
				power: '2',
				toughness: '2'
			})
		);
		const ogre = putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Brute Sentinel',
				typeLine: 'Creature — Ogre',
				oracleText: '',
				power: '3',
				toughness: '3'
			})
		);
		const guardian = putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Palace Guard',
				typeLine: 'Creature — Human Soldier',
				oracleText: 'Palace Guard can block an additional creature each combat.',
				power: '1',
				toughness: '4'
			})
		);

		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: skulker.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: elusive.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.phase, 'declare_blockers');

		// 1. Ogre (power 3 > 2) cannot block Skulk (power 2)
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: ogre.instanceId, attackerInstanceId: skulker.instanceId }]
			}).ok,
			false
		);

		// 2. Cloudreach Archer ("can block only creatures with flying") cannot block ground Skulk
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: skyNet.instanceId, attackerInstanceId: skulker.instanceId }]
			}).ok,
			false
		);

		// 3. Menace (minBlockers 2) + maxBlockers 1 -> neither 1 blocker nor 2 blockers can block elusive!
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: guardian.instanceId, attackerInstanceId: elusive.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: guardian.instanceId, attackerInstanceId: elusive.instanceId },
					{ blockerInstanceId: ogre.instanceId, attackerInstanceId: elusive.instanceId }
				]
			}).ok,
			false
		);

		// 4. Add a second ground attacker so Palace Guard (additionalBlockCount: 1) blocks BOTH legal attackers!
		const grunt = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Goblin Grunt', typeLine: 'Creature — Goblin', power: '1', toughness: '1' })
		);
		state.combat.attackers.push({
			attackerInstanceId: grunt.instanceId,
			controllerId: p1.playerId,
			defenderPlayerId: p2.playerId,
			blockerInstanceIds: [],
			wasBlocked: false
		});

		const doubleBlock = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: guardian.instanceId, attackerInstanceId: skulker.instanceId },
				{ blockerInstanceId: guardian.instanceId, attackerInstanceId: grunt.instanceId }
			]
		});
		assert.equal(doubleBlock.ok, true);
	});

	it('enforces Silent Arbiter globalMaxAttackers / globalMaxBlockers and cantAttackAlone / cantBlockAlone', () => {
		const { state, p1, p2 } = setupMain1Game();
		const loner = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Pack Follower',
				typeLine: 'Creature — Hound',
				oracleText: "Pack Follower can't attack or block alone.",
				power: '2',
				toughness: '2'
			})
		);
		const buddy = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Pack Buddy',
				typeLine: 'Creature — Hound',
				oracleText: '',
				power: '2',
				toughness: '2'
			})
		);

		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;

		// Attacking alone with Pack Follower fails
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: loner.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			false
		);

		// Put Silent Arbiter on p2's battlefield -> max 1 attacker, max 1 blocker!
		putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Silent Arbiter Clone',
				typeLine: 'Artifact Creature — Construct',
				oracleText:
					'No more than one creature can attack each combat.\nNo more than one creature can block each combat.',
				power: '1',
				toughness: '5'
			})
		);

		// Attacking with both fails under Silent Arbiter (2 > 1)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: loner.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: buddy.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			false
		);

		// Attacking with buddy alone succeeds (1 <= 1 and buddy doesn't have cantAttackAlone)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: buddy.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
	});

	it('solves CR 509.1c maximum blocking requirements for mustBeBlockedIfAble, Lure (allAbleBlockers), and pass_priority', () => {
		const { state, p1, p2 } = setupMain1Game();
		const luredAttacker = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Taunting Sylvan',
				typeLine: 'Creature — Elf',
				oracleText: 'All creatures able to block Taunting Sylvan do so.',
				power: '2',
				toughness: '2'
			})
		);
		const sideAttacker = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Sneaky Raider',
				typeLine: 'Creature — Goblin',
				oracleText: '',
				power: '3',
				toughness: '1'
			})
		);
		const b1 = putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Defender One', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
		);
		const b2 = putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Defender Two', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
		);
		// Tapped creature isn't able to block, so Lure must not require it
		putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Tapped Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			{ tapped: true }
		);

		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: luredAttacker.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: sideAttacker.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.phase, 'declare_blockers');

		// Passing priority as the attacked defender in declare_blockers without declaring blockers (0 requirements met < max 2) MUST fail!
		const illegalPass = applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(illegalPass.ok, false);

		// Splitting blockers (1 on luredAttacker, 1 on sideAttacker -> only 1 of 2 Lure requirements met) MUST fail!
		const splitBlock = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: b1.instanceId, attackerInstanceId: luredAttacker.instanceId },
				{ blockerInstanceId: b2.instanceId, attackerInstanceId: sideAttacker.instanceId }
			]
		});
		assert.equal(splitBlock.ok, false);

		// Assigning BOTH able blockers to luredAttacker (2 of 2 requirements met) succeeds!
		const fullLureBlock = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: b1.instanceId, attackerInstanceId: luredAttacker.instanceId },
				{ blockerInstanceId: b2.instanceId, attackerInstanceId: luredAttacker.instanceId }
			]
		});
		assert.equal(fullLureBlock.ok, true);
	});
});

describe('Track P8.3 — Static Activated-Ability Locks (CR 602.5a, 606.2, 109.2)', () => {
	it('enforces Null Rod / Collector Ouphe on battlefield artifacts (including mana) while allowing Cycling in hand (CR 109.2)', () => {
		const { state, p1 } = setupMain1Game();
		putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Ouphe Disruptor',
				typeLine: 'Creature — Ouphe',
				oracleText: "Activated abilities of artifacts can't be activated.",
				power: '2',
				toughness: '2'
			})
		);
		const solRing = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Mox Shard',
				typeLine: 'Artifact',
				oracleText: '{T}: Add {C}.\n{2}, {T}: Draw a card.'
			})
		);
		const basicForest = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			})
		);
		const basicForest2 = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Forest Two',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			})
		);
		const cyclingArtifactInHand = createCardInstance(
			synthCard({
				name: 'Glass Bauble',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact',
				oracleText: 'Cycling {2}',
				keywords: ['Cycling']
			}),
			p1.playerId,
			'hand'
		);
		p1.hand.push(cyclingArtifactInHand);
		p1.library.push(
			createCardInstance(synthCard({ name: 'Drawn Card', typeLine: 'Instant' }), p1.playerId, 'library')
		);

		const ringAbs = getEffectiveActivatedAbilities(state, p1, solRing, []);
		const manaAb = ringAbs.find((a) => a.isManaAbility)!;
		const drawAb = ringAbs.find((a) => !a.isManaAbility)!;
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, solRing, manaAb).ok, false);
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, solRing, drawAb).ok, false);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: solRing.instanceId,
				abilityId: manaAb.id
			}).ok,
			false
		);

		// Non-artifact lands still tap for mana, and Cycling an artifact CARD in hand works (CR 109.2)!
		const handAbs = getEffectiveActivatedAbilities(state, p1, cyclingArtifactInHand, []);
		const cycleAb = handAbs.find((a) => a.activationZones?.includes('hand'))!;
		assert.ok(cycleAb);
		assert.equal(
			checkAbilityActivationLegality(state, p1.playerId, cyclingArtifactInHand, cycleAb).ok,
			true
		);
		const cycleRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: cyclingArtifactInHand.instanceId,
			abilityId: cycleAb.id,
			targets: []
		});
		assert.equal(cycleRes.ok, true);
		assert.equal(basicForest.tapped && basicForest2.tapped, true);
	});

	it('distinguishes Faith\'s Fetters (allowManaAbilities: true, blocks loyalty per CR 606.2) from Arrest and Linvala', () => {
		const { state, p1, p2 } = setupMain1Game();
		const druid = putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Leyline Druid',
				typeLine: 'Creature — Elf Druid',
				oracleText: '{T}: Add {G}.\n{1}: Gain 1 life.',
				power: '1',
				toughness: '2'
			})
		);
		const pw = putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Caged Seer',
				typeLine: 'Legendary Planeswalker — Seer',
				oracleText: '+1: Draw a card.',
				loyalty: '3'
			})
		);
		pw.counters.loyalty = 3;

		const fettersCard = synthCard({
			name: 'Fetters of Faith',
			manaCost: '{3}{W}',
			cmc: 4,
			typeLine: 'Enchantment — Aura',
			oracleText:
				"Enchant permanent\nEnchanted permanent can't attack or block, and its activated abilities can't be activated unless they're mana abilities.",
			keywords: ['Enchant']
		});
		assert.equal(compileCard(fettersCard).fullySupported, true);

		const fettersOnDruid = putOnBattlefield(state, p1, fettersCard);
		fettersOnDruid.attachedToId = druid.instanceId;
		const fettersOnPw = putOnBattlefield(state, p1, fettersCard);
		fettersOnPw.attachedToId = pw.instanceId;

		// On druid: {T}: Add {G} is a mana ability -> ALLOWED; {1}: Gain 1 life -> BLOCKED!
		p2.manaPool.G = 2;
		const druidAbs = getEffectiveActivatedAbilities(state, p2, druid, []);
		const druidMana = druidAbs.find((a) => a.isManaAbility)!;
		const druidNonMana = druidAbs.find((a) => !a.isManaAbility)!;
		assert.equal(checkAbilityActivationLegality(state, p2.playerId, druid, druidMana).ok, true);
		assert.equal(checkAbilityActivationLegality(state, p2.playerId, druid, druidNonMana).ok, false);

		// On planeswalker: +1 loyalty ability is an activated ability (CR 606.2) and NOT a mana ability -> BLOCKED!
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		const pwAbs = getEffectiveActivatedAbilities(state, p2, pw, []);
		assert.equal(pwAbs.length, 1);
		assert.equal(checkAbilityActivationLegality(state, p2.playerId, pw, pwAbs[0]).ok, false);

		// Add Linvala ("Activated abilities of creatures your opponents control can't be activated.") -> now druid's mana ability is ALSO blocked!
		putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Keeper of Silence',
				typeLine: 'Legendary Creature — Angel',
				oracleText: "Activated abilities of creatures your opponents control can't be activated.",
				power: '3',
				toughness: '4'
			})
		);
		assert.equal(checkAbilityActivationLegality(state, p2.playerId, druid, druidMana).ok, false);
	});
});

describe('Track P8.4 — Shocklands, Reveal Lands, Generalized Clone, & Top-of-Library / Graveyard Play', () => {
	it('handles Shocklands for humans (pay 2 life vs decline, CR 119.4 at 1 life, CR 119.8 Platinum Emperion) and smart bot heuristic', () => {
		const { state, p1 } = setupMain1Game();
		const shockCard = synthCard({
			name: 'Steam Pool',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land — Island Mountain',
			oracleText: '({T}: Add {U} or {R}.)\nAs Steam Pool enters, you may pay 2 life. If you don\'t, it enters tapped.'
		});
		assert.equal(compileCard(shockCard).fullySupported, true);

		// 1. Human at 20 life -> prompted; chooses yes -> life 18, enters untapped
		p1.life = 20;
		const s1 = createCardInstance(shockCard, p1.playerId, 'hand');
		p1.hand.push(s1);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: s1.instanceId }).ok,
			true
		);
		assert.equal(state.pendingPrompts.length, 1);
		const pr1 = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: pr1.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1.life, 18);
		assert.equal(s1.zone, 'battlefield');
		assert.equal(s1.tapped, false);

		// 2. Human at 1 life (CR 119.4) -> cannot pay 2 life; enters tapped automatically with NO prompt!
		p1.maxLandsPerTurn = 5;
		p1.life = 1;
		const s2 = createCardInstance(shockCard, p1.playerId, 'hand');
		p1.hand.push(s2);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: s2.instanceId }).ok,
			true
		);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p1.life, 1);
		assert.equal(s2.tapped, true);

		// 3. Under Platinum Emperion ("Your life total can't change", CR 119.8) at 20 life -> auto-tapped, no prompt!
		p1.life = 20;
		putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Emperion Golem',
				typeLine: 'Artifact Creature — Golem',
				oracleText: "Your life total can't change.",
				power: '8',
				toughness: '8'
			})
		);
		const s3 = createCardInstance(shockCard, p1.playerId, 'hand');
		p1.hand.push(s3);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: s3.instanceId }).ok,
			true
		);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p1.life, 20);
		assert.equal(s3.tapped, true);

		// 4. Bot heuristic: bot at 20 life with a {U} spell in hand pays 2 life; bot with empty hand declines!
		const botGame = setupMain1Game({ p1Bot: true });
		const bot = botGame.p1;
		bot.maxLandsPerTurn = 2;
		bot.life = 20;
		const botShock1 = createCardInstance(shockCard, bot.playerId, 'hand');
		const oneDrop = createCardInstance(
			synthCard({
				name: 'Agile Sprite',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Creature — Faerie',
				power: '1',
				toughness: '1'
			}),
			bot.playerId,
			'hand'
		);
		bot.hand.push(botShock1, oneDrop);
		assert.equal(
			applyGameAction(botGame.state, bot.playerId, {
				type: 'play_land',
				instanceId: botShock1.instanceId
			}).ok,
			true
		);
		assert.equal(bot.life, 18);
		assert.equal(botShock1.tapped, false);

		bot.hand = [];
		const botShock2 = createCardInstance(shockCard, bot.playerId, 'hand');
		bot.hand.push(botShock2);
		assert.equal(
			applyGameAction(botGame.state, bot.playerId, {
				type: 'play_land',
				instanceId: botShock2.instanceId
			}).ok,
			true
		);
		assert.equal(bot.life, 18); // did NOT pay life when nothing needed the +1 mana!
		assert.equal(botShock2.tapped, true);
	});

	it('handles Reveal lands (CR 701.20a knownToPlayerIds exposure) and Fast/Check/Slow/Battle conditional ETB lands', () => {
		const { state, p1, p2 } = setupMain1Game();
		p1.maxLandsPerTurn = 6;
		const snarlCard = synthCard({
			name: 'Frostboil Port',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText:
				"As Frostboil Port enters, you may reveal an Island or Mountain card from your hand. If you don't, Frostboil Port enters tapped.\n{T}: Add {U} or {R}."
		});
		assert.equal(compileCard(snarlCard).fullySupported, true);

		// 1. No Island/Mountain in hand -> enters tapped automatically
		const snarl1 = createCardInstance(snarlCard, p1.playerId, 'hand');
		p1.hand.push(snarl1);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: snarl1.instanceId }).ok,
			true
		);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(snarl1.tapped, true);

		// 2. Island in hand -> human reveals Island -> enters untapped AND opponent sees revealed Island in sanitizeGameStateForViewer!
		const islandInHand = createCardInstance(
			synthCard({ name: 'Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' }),
			p1.playerId,
			'hand'
		);
		const secretSpell = createCardInstance(
			synthCard({ name: 'Secret Counter', manaCost: '{U}{U}', cmc: 2, typeLine: 'Instant' }),
			p1.playerId,
			'hand'
		);
		const snarl2 = createCardInstance(snarlCard, p1.playerId, 'hand');
		p1.hand.push(islandInHand, secretSpell, snarl2);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: snarl2.instanceId }).ok,
			true
		);
		assert.equal(state.pendingPrompts.length, 1);
		const pr = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'chooseObjects', objectIds: [islandInHand.instanceId] }
			}).ok,
			true
		);
		assert.equal(snarl2.tapped, false);
		const p2View = sanitizeGameStateForViewer(state, p2.playerId);
		const visibleP1Hand = p2View.players[0].hand;
		assert.equal(visibleP1Hand.length, 1);
		assert.equal(visibleP1Hand[0].instanceId, islandInHand.instanceId);

		// 3. Fastland: right now p1 controls 2 lands (snarl1, snarl2) -> Fastland ("two or fewer other lands") enters UNTAPPED;
		// then with 3 lands, a second Fastland enters TAPPED!
		const fastCard = synthCard({
			name: 'Spirebluff Shore',
			manaCost: '',
			cmc: 0,
			typeLine: 'Land',
			oracleText:
				'Spirebluff Shore enters tapped unless you control two or fewer other lands.\n{T}: Add {U} or {R}.'
		});
		assert.equal(compileCard(fastCard).fullySupported, true);
		const fast1 = createCardInstance(fastCard, p1.playerId, 'hand');
		const fast2 = createCardInstance(fastCard, p1.playerId, 'hand');
		p1.hand.push(fast1, fast2);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: fast1.instanceId }).ok,
			true
		);
		assert.equal(fast1.tapped, false);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: fast2.instanceId }).ok,
			true
		);
		assert.equal(fast2.tapped, true);
	});

	it('applies Generalized Clone Layer 1a copyModifications (non-legendary & keepSelfName) on both cast and non-stack ETB', () => {
		const { state, p1 } = setupMain1Game();
		const hero = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Aurelia Prime',
				manaCost: '{4}{R}{W}',
				cmc: 6,
				typeLine: 'Legendary Creature — Angel',
				oracleText: 'Flying, vigilance',
				keywords: ['Flying', 'Vigilance'],
				power: '3',
				toughness: '4',
				colors: ['R', 'W']
			})
		);

		const sparkCloneCard = synthCard({
			name: 'Impostor Double',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Creature — Shapeshifter',
			oracleText:
				"You may have Impostor Double enter as a copy of a creature you control, except it isn't legendary and it has haste.",
			power: '0',
			toughness: '0',
			colors: ['U']
		});
		const sakashimaCard = synthCard({
			name: 'Mirror Impostor',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Legendary Creature — Human Rogue',
			oracleText:
				'You may have Mirror Impostor enter as a copy of any creature on the battlefield, except its name is Mirror Impostor.',
			power: '3',
			toughness: '1',
			colors: ['U']
		});
		assert.equal(compileCard(sparkCloneCard).fullySupported, true);
		assert.equal(compileCard(sakashimaCard).fullySupported, true);

		// 1. Cast Impostor Double as a spell -> human chooses hero -> enters as non-legendary Aurelia Prime with Haste (no Legend Rule!)
		p1.manaPool.U = 4;
		const cloneSpell = createCardInstance(sparkCloneCard, p1.playerId, 'hand');
		p1.hand.push(cloneSpell);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cloneSpell.instanceId,
				targets: []
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		const pr = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'chooseObjects', objectIds: [hero.instanceId] }
			}).ok,
			true
		);
		const resolvedClone = p1.battlefield.find((c) => c.instanceId === cloneSpell.instanceId);
		assert.ok(resolvedClone);
		assert.equal(resolvedClone.zone, 'battlefield');
		assert.equal(hero.zone, 'battlefield'); // Legend Rule did NOT fire because clone isn't legendary!
		const evClone = evaluatePermanent(state, resolvedClone);
		assert.equal(evClone.effectiveName, 'Aurelia Prime');
		assert.equal(evClone.typeLine.includes('Legendary'), false);
		assert.equal(hasKeyword(resolvedClone, 'Flying', state), true);
		assert.equal(hasKeyword(resolvedClone, 'Haste', state), true);

		// 2. Non-stack ETB (e.g. reanimation / put onto battlefield): Mirror Impostor keeps its own name!
		const sakashima = createCardInstance(sakashimaCard, p1.playerId, 'graveyard');
		p1.graveyard.push(sakashima);
		const moveRes = moveObject(state, sakashima, 'battlefield', {
			from: { player: p1, zone: 'graveyard' },
			toPlayer: p1,
			controllerId: p1.playerId,
			newTimestamp: true,
			bumpVersion: true
		});
		assert.equal(moveRes, 'pending');
		assert.equal(state.pendingPrompts.length, 1);
		const pr2 = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: pr2.id,
				answer: { kind: 'chooseObjects', objectIds: [hero.instanceId] }
			}).ok,
			true
		);
		assert.equal(sakashima.zone, 'battlefield');
		assert.equal(hero.zone, 'battlefield'); // Legend Rule did NOT fire because sakashima's name is Mirror Impostor!
		assert.equal(evaluatePermanent(state, sakashima).effectiveName, 'Mirror Impostor');
		assert.equal(getCreaturePower(sakashima, state), 3);
	});

	it('supports Courser / Vizier / Crucible top-of-library & graveyard play, CR 401.5 mid-cast hiding, and bot play', () => {
		const { state, p1, p2 } = setupMain1Game();
		const vizierCard = synthCard({
			name: 'Menagerie Seer',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Creature — Naga Druid',
			oracleText:
				'You may look at the top card of your library any time.\nYou may cast creature spells from the top of your library.',
			power: '3',
			toughness: '4'
		});
		const crucibleCard = synthCard({
			name: 'World Crucible',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText: 'You may play lands from your graveyard.'
		});
		const courserCard = synthCard({
			name: 'Horizon Courser',
			manaCost: '{1}{G}{G}',
			cmc: 3,
			typeLine: 'Enchantment Creature — Centaur',
			oracleText:
				'Play with the top card of your library revealed.\nYou may play lands from the top of your library.',
			power: '2',
			toughness: '4'
		});
		assert.equal(compileCard(vizierCard).fullySupported, true);
		assert.equal(compileCard(crucibleCard).fullySupported, true);
		assert.equal(compileCard(courserCard).fullySupported, true);

		const vizier = putOnBattlefield(state, p1, vizierCard);
		const crucible = putOnBattlefield(state, p1, crucibleCard);

		const topCreature = createCardInstance(
			synthCard({
				name: 'Topdeck Bear',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			p1.playerId,
			'library'
		);
		const secondSorcery = createCardInstance(
			synthCard({
				name: 'Topdeck Divination',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Draw two cards.'
			}),
			p1.playerId,
			'library'
		);
		p1.library = [topCreature, secondSorcery];

		// 1. Under "look at the top card any time": p1 sees library[0], p2 sees []!
		assert.equal(sanitizeGameStateForViewer(state, p1.playerId).players[0].library.length, 1);
		assert.equal(
			sanitizeGameStateForViewer(state, p1.playerId).players[0].library[0].instanceId,
			topCreature.instanceId
		);
		assert.equal(sanitizeGameStateForViewer(state, p2.playerId).players[0].library.length, 0);

		// 2. CR 401.5: While state.pendingCostPayment is active (mid-cast/activation), p1 CANNOT look at the new top card!
		state.pendingCostPayment = {
			kind: 'cast_spell',
			actorId: p1.playerId,
			sourceInstanceId: 'dummy',
			sourceZone: 'hand',
			sourcePlayerId: p1.playerId,
			castOptionId: 'hand:normal',
			xValue: 0,
			targets: [],
			sourceCard: topCreature.card,
			parts: [],
			manaPaid: null,
			tapsAndManaDone: false,
			nextPartIndex: 0,
			nextObjectIndex: 0,
			descriptions: []
		};
		assert.equal(sanitizeGameStateForViewer(state, p1.playerId).players[0].library.length, 0);
		state.pendingCostPayment = undefined;

		// 3. p1 casts Topdeck Bear from top of library!
		p1.manaPool.G = 2;
		assert.equal(getCastOptions(state, p1.playerId, topCreature, 'library').length, 1);
		// Second card in library cannot be cast
		assert.equal(getCastOptions(state, p1.playerId, secondSorcery, 'library').length, 0);
		const castTopRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: topCreature.instanceId,
			fromZone: 'library',
			targets: []
		});
		assert.equal(castTopRes.ok, true);
		assert.equal(state.stack.length, 1);
		resolveTopOfStack(state);
		const resolvedBear = p1.battlefield.find((c) => c.instanceId === topCreature.instanceId);
		assert.ok(resolvedBear);
		assert.equal(resolvedBear.zone, 'battlefield');

		// Now secondSorcery is library[0], which is NOT a creature spell -> Vizier does not allow casting it!
		p1.manaPool.U = 3;
		assert.equal(checkSpellCastLegality(state, p1.playerId, secondSorcery, 'library').ok, false);

		// 4. Crucible of Worlds: play a land from graveyard, then verify permission vanishes if Crucible leaves!
		const gyForest = createCardInstance(
			synthCard({ name: 'Graveyard Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }),
			p1.playerId,
			'graveyard'
		);
		const gyForest2 = createCardInstance(
			synthCard({ name: 'Graveyard Forest 2', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }),
			p1.playerId,
			'graveyard'
		);
		p1.graveyard.push(gyForest, gyForest2);
		p1.maxLandsPerTurn = 2;
		assert.equal(getLandPlayOptions(state, p1.playerId, gyForest, 'graveyard').length, 1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: gyForest.instanceId,
				fromZone: 'graveyard'
			}).ok,
			true
		);
		assert.equal(gyForest.zone, 'battlefield');

		// Remove Crucible -> gyForest2 can no longer be played from graveyard
		moveObject(state, crucible, 'exile', { from: { player: p1, zone: 'battlefield' }, toPlayer: p1 });
		assert.equal(checkLandPlayLegality(state, p1.playerId, gyForest2, 'graveyard').ok, false);

		// 5. Courser of Kruphix ("reveal") exposes library[0] to BOTH players and lets a bot play lands from library[0]!
		moveObject(state, vizier, 'exile', { from: { player: p1, zone: 'battlefield' }, toPlayer: p1 });
		putOnBattlefield(state, p1, courserCard);
		const topLand = createCardInstance(
			synthCard({ name: 'Topdeck Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }),
			p1.playerId,
			'library'
		);
		p1.library.unshift(topLand);
		assert.equal(sanitizeGameStateForViewer(state, p2.playerId).players[0].library.length, 1);

		p1.isBot = true;
		const stepRes = executeBotStep(state, p1, p1);
		assert.equal(stepRes, 'visible');
		assert.equal(topLand.zone, 'battlefield');
	});
});
