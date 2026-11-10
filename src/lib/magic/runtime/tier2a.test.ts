import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { cardSupportReport } from '../compiler/support.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `t2a_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{G}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['G'],
		colorIdentity: overrides.colorIdentity ?? ['G'],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function makeSeat(i: number, username: string, isBot = false): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: `player_${i + 1}`,
		username,
		avatarUrl: '',
		isBot,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: deck.colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	};
}

function createTestGame(): GameState {
	const seats = [makeSeat(0, 'Alice', false), makeSeat(1, 'Bob', false)];
	const state = createInitialGameState(
		'LOBBY_T2A',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
	}
	return state;
}

function putOnBoard(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' = 'battlefield'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	player[zone].push(inst);
	return inst;
}

describe('Tier 2 Track A — Item 1: CR 207.2c Ability-Word Stripping', () => {
	it('does not strip non-ability-word prefixes (Solved, Max speed, Boast, Exhaust, Power-up) and does not apply them on turn 1, while preserving genuine CR 207.2c ability words (Landfall)', () => {
		const caseCard = card({
			name: 'Case of the Silent Vault',
			typeLine: 'Enchantment — Case',
			oracleText: 'Solved — Creatures you control get +2/+2 and have vigilance.',
			power: undefined,
			toughness: undefined
		});
		const maxSpeedCard = card({
			name: 'Aetherdrift Racer',
			typeLine: 'Creature — Pilot',
			oracleText: 'Max speed — Other creatures you control get +1/+1 and have haste.'
		});
		const boastCard = card({
			name: 'Fjord Raider',
			typeLine: 'Creature — Human Berserker',
			oracleText: 'Boast — Sacrifice a creature: Draw a card.'
		});
		const exhaustCard = card({
			name: 'Boosted Engine',
			typeLine: 'Artifact',
			oracleText: 'Exhaust — {2}: Draw a card.',
			power: undefined,
			toughness: undefined
		});
		const powerUpCard = card({
			name: 'Arcaderawler',
			typeLine: 'Creature — Construct',
			oracleText: 'Power-up — {1}: Put a +1/+1 counter on ~.'
		});
		const landfallCard = card({
			name: 'Lotus Tracker',
			typeLine: 'Creature — Elf',
			oracleText: 'Landfall — Whenever a land you control enters, you gain 1 life.'
		});

		assert.equal(compileCard(caseCard).fullySupported, false, 'Solved — is not an ability word (CR 702.169)');
		assert.equal(cardSupportReport(caseCard).fullySupported, false);
		assert.equal(compileCard(maxSpeedCard).fullySupported, false, 'Max speed — is not an ability word (CR 702.178)');
		assert.equal(cardSupportReport(maxSpeedCard).fullySupported, false);
		assert.equal(compileCard(boastCard).fullySupported, false, 'Boast — is not an ability word (CR 702.142)');
		assert.equal(compileCard(exhaustCard).fullySupported, false, 'Exhaust — is not an ability word (CR 702.177)');
		assert.equal(compileCard(powerUpCard).fullySupported, false, 'Power-up — is not an ability word (CR 702.193)');

		// Genuine CR 207.2c ability word still compiles as fullySupported
		const landfallDef = compileCard(landfallCard);
		assert.equal(landfallDef.fullySupported, true, 'Landfall — is a genuine CR 207.2c ability word');
		assert.equal(landfallDef.faces[0].abilities[0].kind, 'triggered');

		// Runtime check: on Turn 1, Case and Max speed static buffs must NOT apply
		const state = createTestGame();
		const alice = state.players[0];
		const bear = putOnBoard(state, alice, card({ name: 'Grizzly Cub', oracleText: '' }), 'battlefield');
		putOnBoard(state, alice, caseCard, 'battlefield');
		putOnBoard(state, alice, maxSpeedCard, 'battlefield');

		const evalBear = evaluatePermanent(state, bear);
		assert.equal(evalBear.power, 2, 'Solved and Max speed buffs must not apply on turn 1');
		assert.equal(evalBear.toughness, 2, 'Solved and Max speed buffs must not apply on turn 1');
		assert.ok(!evalBear.activeKeywords.includes('Vigilance'));
		assert.ok(!evalBear.activeKeywords.includes('Haste'));
	});
});
