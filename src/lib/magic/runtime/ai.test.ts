import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasRestriction, runAutomatedPriorityAndBots } from '../ai.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';

function staple(name: string): ScryfallCard {
	const card = STAPLE_CARDS[name.toLowerCase()];
	if (!card) throw new Error(`Unknown staple card: ${name}`);
	return card;
}

function syntheticCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `synth_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{2}',
		cmc: 2,
		typeLine: 'Creature — Bear',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		power: '2',
		toughness: '2',
		imageUrl: '',
		artCropUrl: '',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function makeTwoPlayerState(): { state: GameState; p1Id: string; p2Id: string } {
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `player_${i + 1}`,
		username: `Player ${i + 1}`,
		avatarUrl: '',
		isBot: false,
		deckId: PRECON_DECKS[i].id,
		deckName: PRECON_DECKS[i].name,
		commanderNames: PRECON_DECKS[i].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: [...PRECON_DECKS[i].colorIdentity],
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: Date.now()
	}));
	const decks = new Map<number, MagicDeck>([
		[0, PRECON_DECKS[0]],
		[1, PRECON_DECKS[1]]
	]);
	const state = createInitialGameState('AI_IR_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES
	});
	state.status = 'active';
	state.turnNumber = 2;
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.pendingPrompts = [];
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.command = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	return { state, p1Id: state.players[0].playerId, p2Id: state.players[1].playerId };
}

function putInZone(
	state: GameState,
	playerId: string,
	card: ScryfallCard,
	zone: ZoneType = 'battlefield'
): CardInstance {
	const player = state.players.find((p) => p.playerId === playerId)!;
	const inst = createCardInstance(card, playerId, zone);
	inst.controllerId = playerId;
	inst.summoningSick = false;
	if (zone === 'battlefield') player.battlefield.push(inst);
	else if (zone === 'hand') player.hand.push(inst);
	else if (zone === 'graveyard') player.graveyard.push(inst);
	else if (zone === 'exile') player.exile.push(inst);
	else if (zone === 'command') player.command.push(inst);
	return inst;
}

describe('Phase 9: Bot AI on compiled IR and evaluated permanents', () => {
	it('blocks a printed unblockable attacker when Darksteel Mutation removes its abilities', () => {
		const { state, p1Id, p2Id } = makeTwoPlayerState();
		const bot = state.players[1];
		bot.isBot = true;

		const infiltrator = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Duskblade Phantom',
				typeLine: 'Creature — Rogue',
				oracleText: "Duskblade Phantom can't be blocked.",
				power: '3',
				toughness: '2'
			})
		);
		// Give it +4/+4 in counters so even as a 0/1 base under Darksteel Mutation it is a 4/5 attacker
		infiltrator.counters['+1/+1'] = 4;

		const mutation = putInZone(state, p2Id, staple('Darksteel Mutation'));
		mutation.attachedToId = infiltrator.instanceId;

		const guardian = putInZone(
			state,
			p2Id,
			syntheticCard({
				name: 'Towering Colossus',
				typeLine: 'Creature — Golem',
				power: '6',
				toughness: '6'
			})
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: infiltrator.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		runAutomatedPriorityAndBots(state);

		assert.deepEqual(
			state.combat.attackers[0]?.blockerInstanceIds,
			[guardian.instanceId],
			'Bot blocks printed unblockable creature after Darksteel Mutation removes its abilities'
		);
	});

	it('respects attached Aura, global filter, and conditional cantBeBlocked restrictions from IR', () => {
		const { state, p1Id, p2Id } = makeTwoPlayerState();
		const bot = state.players[1];
		bot.isBot = true;

		// 1. Attached Aura granting "Enchanted creature can't be blocked."
		const brute = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Ironclad Brute',
				typeLine: 'Creature — Warrior',
				power: '4',
				toughness: '4'
			})
		);
		const cloak = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Cloak of Mist',
				typeLine: 'Enchantment — Aura',
				oracleText: "Enchant creature\nEnchanted creature can't be blocked."
			})
		);
		cloak.attachedToId = brute.instanceId;

		putInZone(
			state,
			p2Id,
			syntheticCard({
				name: 'Sentinel Giant',
				typeLine: 'Creature — Giant',
				power: '5',
				toughness: '5'
			})
		);

		assert.equal(
			hasRestriction(state, brute, 'cantBeBlocked'),
			true,
			'Aura with "Enchanted creature can\'t be blocked." grants cantBeBlocked restriction'
		);

		// 2. Conditional self restriction: "As long as you control an artifact, ~ can't be blocked."
		const agent = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Aetherblade Agent',
				typeLine: 'Creature — Rogue',
				oracleText: "As long as you control an artifact, Aetherblade Agent can't be blocked.",
				power: '4',
				toughness: '4'
			})
		);
		assert.equal(
			hasRestriction(state, agent, 'cantBeBlocked'),
			false,
			'Conditional cantBeBlocked is inactive without an artifact'
		);
		const ring = putInZone(state, p1Id, staple('Sol Ring'));
		assert.equal(
			hasRestriction(state, agent, 'cantBeBlocked'),
			true,
			'Conditional cantBeBlocked becomes active when controller controls an artifact'
		);
		state.players[0].battlefield = state.players[0].battlefield.filter(
			(b) => b.instanceId !== ring.instanceId
		);

		// 3. Global filter restriction: "Elf creatures you control can't be blocked."
		const herald = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Canopy Herald',
				typeLine: 'Enchantment',
				oracleText: "Elf creatures you control can't be blocked."
			})
		);
		assert.equal(hasRestriction(state, brute, 'cantBeBlocked'), true);
		// Remove Cloak of Mist so brute is a Warrior (not an Elf)
		state.players[0].battlefield = state.players[0].battlefield.filter(
			(b) => b.instanceId !== cloak.instanceId
		);
		assert.equal(
			hasRestriction(state, brute, 'cantBeBlocked'),
			false,
			'Non-Elf is blockable before Maskwood Nexus'
		);
		// Add Maskwood Nexus -> brute becomes an Elf in Layer 4 and is now unblockable!
		putInZone(state, p1Id, staple('Maskwood Nexus'));
		assert.equal(
			hasRestriction(state, brute, 'cantBeBlocked'),
			true,
			'Maskwood Nexus makes Warrior an Elf in Layer 4, matching "Elf creatures you control can\'t be blocked."'
		);
		assert.ok(herald);
	});

	it('skips creatures with cantBlock or cantAttackOrBlock restrictions when declaring blockers and attackers', () => {
		const { state, p1Id, p2Id } = makeTwoPlayerState();
		const bot = state.players[1];
		bot.isBot = true;

		const attacker = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Raging Minotaur',
				typeLine: 'Creature — Minotaur',
				power: '4',
				toughness: '3'
			})
		);

		// Bot has two 5/5 creatures, but the first is enchanted with "Enchanted creature can't attack or block."
		const pacified = putInZone(
			state,
			p2Id,
			syntheticCard({
				name: 'Chained Guardian',
				typeLine: 'Creature — Giant',
				power: '5',
				toughness: '5'
			})
		);
		const cage = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Stasis Fetters',
				typeLine: 'Enchantment — Aura',
				oracleText: "Enchant creature\nEnchanted creature can't attack or block."
			})
		);
		cage.attachedToId = pacified.instanceId;

		const freeBlocker = putInZone(
			state,
			p2Id,
			syntheticCard({
				name: 'Free Guardian',
				typeLine: 'Creature — Giant',
				power: '5',
				toughness: '5'
			})
		);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		applyGameAction(state, p1Id, { type: 'pass_priority' });
		runAutomatedPriorityAndBots(state);

		assert.deepEqual(
			state.combat.attackers[0]?.blockerInstanceIds,
			[freeBlocker.instanceId],
			'Bot skips creature with cantAttackOrBlock and blocks with the unrestricted creature'
		);
	});

	it('uses compiled IR to hold back counterspells, protection tricks, and low-value board wipes in main phase', () => {
		const { state, p1Id, p2Id } = makeTwoPlayerState();
		const bot = state.players[0];
		bot.isBot = true;
		bot.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		// Put a targetable permanent on p1's board so protection trick is legal to cast
		putInZone(state, p1Id, staple('Sol Ring'));
		// Put only 1 creature on opponent's board (< 2 creatures, so board wipe should be held back)
		const oneEnemy = putInZone(
			state,
			p2Id,
			syntheticCard({ name: 'Lone Scout', typeLine: 'Creature — Scout', power: '2', toughness: '2' })
		);

		putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Aegis Sanctuary',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Permanents you control gain hexproof and indestructible until end of turn.'
			}),
			'hand'
		);
		const wipe = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Solar Cataclysm',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Sorcery',
				oracleText: 'Destroy all creatures.'
			}),
			'hand'
		);

		state.phase = 'main1';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		runAutomatedPriorityAndBots(state);

		assert.equal(
			bot.hand.some((c) => c.instanceId === wipe.instanceId),
			true,
			'Bot holds back board wipe when opponents control only 1 creature'
		);
		assert.equal(
			state.players[1].battlefield.some((c) => c.instanceId === oneEnemy.instanceId),
			true
		);

		// Now give opponent a second creature and return to bot's main1 -> bot casts the board wipe!
		putInZone(
			state,
			p2Id,
			syntheticCard({ name: 'Second Scout', typeLine: 'Creature — Scout', power: '2', toughness: '2' })
		);
		state.phase = 'main1';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.passedPriorityPlayerIds = [];
		bot.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		runAutomatedPriorityAndBots(state);

		assert.equal(
			bot.hand.some((c) => c.instanceId === wipe.instanceId),
			false,
			'Bot casts board wipe when opponents control 2+ creatures'
		);
	});

	it('skips creatures with cantAttack restriction when declaring attackers and selects targets from IR', () => {
		const { state, p1Id, p2Id } = makeTwoPlayerState();
		const bot = state.players[0];
		bot.isBot = true;
		bot.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		// Bot has a 4/4 with "can't attack" and a 3/3 unrestricted creature
		putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Rootbound Sentinel',
				typeLine: 'Creature — Treefolk',
				oracleText: "Rootbound Sentinel can't attack.",
				power: '4',
				toughness: '4'
			})
		);
		const raider = putInZone(
			state,
			p1Id,
			syntheticCard({
				name: 'Swift Raider',
				typeLine: 'Creature — Warrior',
				power: '3',
				toughness: '3'
			})
		);

		// Opponent has a 2-CMC creature and a 5-CMC creature
		const smallEnemy = putInZone(
			state,
			p2Id,
			syntheticCard({
				name: 'Minor Construct',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Construct',
				power: '2',
				toughness: '2'
			})
		);
		const bigEnemy = putInZone(
			state,
			p2Id,
			syntheticCard({
				name: 'Colossal Dreadmaw',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Creature — Dinosaur',
				power: '6',
				toughness: '6'
			})
		);

		// Bot has a removal spell in hand -> should target the highest-CMC enemy creature (bigEnemy)
		putInZone(state, p1Id, staple('Swords to Plowshares'), 'hand');

		state.phase = 'main1';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		runAutomatedPriorityAndBots(state);

		// Pass priority for p2 to let Swords to Plowshares resolve, then run bot through declare_attackers
		while (state.stack.length > 0) {
			applyGameAction(state, p2Id, { type: 'pass_priority' });
			runAutomatedPriorityAndBots(state);
		}

		assert.equal(
			state.players[1].exile.some((c) => c.instanceId === bigEnemy.instanceId),
			true,
			'Bot targeted the highest-CMC opponent creature with Swords to Plowshares'
		);
		assert.equal(
			state.players[1].battlefield.some((c) => c.instanceId === smallEnemy.instanceId),
			true
		);
		assert.deepEqual(
			state.combat.attackers.map((a) => a.attackerInstanceId),
			[raider.instanceId],
			'Bot attacked only with the unrestricted creature and skipped the cantAttack creature'
		);
	});
});
