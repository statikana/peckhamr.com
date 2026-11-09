import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedPriorityAndBots } from '../ai.ts';
import { createCardInstance, createInitialGameState } from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { DEFAULT_LOBBY_RULES, type GameState, type LobbySeat, type MagicDeck } from '../types.ts';

function staple(name: string) {
	const card = STAPLE_CARDS[name.toLowerCase()];
	if (!card) throw new Error(`Unknown staple card: ${name}`);
	return card;
}

/** P1 is a bot in main 1 with the given removal spell and one creature of its own; P2 has no permanents. */
function botWithOnlyOwnTargets(spellName: string): { state: GameState; creatureId: string; spellId: string } {
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `player_${i + 1}`,
		username: `Player ${i + 1}`,
		avatarUrl: '',
		isBot: i === 0,
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
	const state = createInitialGameState('AI_TARGETING', seats, decks, { ...DEFAULT_LOBBY_RULES });
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
		p.library = [];
		p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	const bot = state.players[0];
	const creature = createCardInstance(staple('Eternal Witness'), bot.playerId, 'battlefield');
	creature.summoningSick = false;
	bot.battlefield.push(creature);
	const spell = createCardInstance(staple(spellName), bot.playerId, 'hand');
	bot.hand.push(spell);
	return { state, creatureId: creature.instanceId, spellId: spell.instanceId };
}

describe('Bot targeting never aims harmful spells at its own permanents', () => {
	for (const name of ['Swords to Plowshares', 'Putrefy', 'Generous Gift', 'Anguished Unmaking']) {
		it(`doesn't cast ${name} on its own creature when opponents have no targets`, () => {
			const { state, creatureId, spellId } = botWithOnlyOwnTargets(name);
			const bot = state.players[0];
			runAutomatedPriorityAndBots(state);
			assert.ok(
				bot.battlefield.some((c) => c.instanceId === creatureId),
				`${name} removed the bot's own creature`
			);
			assert.ok(
				bot.hand.some((c) => c.instanceId === spellId),
				`${name} should stay in hand when the only legal targets are the bot's own`
			);
		});
	}
});
