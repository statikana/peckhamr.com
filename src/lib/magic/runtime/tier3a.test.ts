import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	canPayOrAutoTap,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
import { parseManaCost } from '../oracle.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
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
		id: `t3a_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

function createTestGame(bots: [boolean, boolean] = [false, false]): GameState {
	const seats = [makeSeat(0, 'Alice', bots[0]), makeSeat(1, 'Bob', bots[1])];
	const state = createInitialGameState(
		'LOBBY_T3A',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		const wasBot = p.isBot;
		p.isBot = false;
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		p.isBot = wasBot;
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	return state;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library' = 'battlefield'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		player.battlefield.push(inst);
		noteLayerInputsChanged(state);
	} else if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	return inst;
}

describe('Tier 3 Track A — Item 1: Auto-tap emits TappedForMana and resolves triggered mana abilities (CR 106.12, 605.1b, 605.3a, 605.4a)', () => {
	it('with an "add an additional {G}" land-tap trigger on the battlefield, auto-paying a spell yields the extra mana (and manual tap does too; simulate pass does not emit)', () => {
		const state = createTestGame();
		const alice = state.players[0];
		alice.battlefield = [];

		putInZone(
			state,
			alice,
			card({
				name: 'Emerald Reflection',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				typeLine: 'Enchantment',
				oracleText: 'Whenever you tap a land for mana, add an additional {G}.',
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);

		const forest1 = putInZone(
			state,
			alice,
			card({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)',
				colors: [],
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);
		const forest2 = putInZone(
			state,
			alice,
			card({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)',
				colors: [],
				power: undefined,
				toughness: undefined
			}),
			'battlefield'
		);

		// 1. Planning / simulate pass (canPayOrAutoTap) must not tap lands or emit TappedForMana.
		assert.equal(canPayOrAutoTap(alice, parseManaCost('{G}'), state), true);
		assert.equal(forest1.tapped, false);
		assert.equal(forest2.tapped, false);
		assert.equal(alice.manaPool.G, 0);

		// 2. Manual tap_mana yields {G} from the Forest + {G} from the inline triggered mana ability (CR 605.4a).
		const tapRes = applyGameAction(state, alice.playerId, {
			type: 'tap_mana',
			instanceId: forest1.instanceId
		});
		assert.equal(tapRes.ok, true, tapRes.error ?? '');
		assert.equal(forest1.tapped, true);
		assert.equal(state.stack.length, 0, 'triggered mana ability does not use the stack (CR 605.4a)');
		assert.equal(alice.manaPool.G, 2, 'manual tap added {G} + extra {G}');

		// Reset mana pool to 0 so casting the spell must auto-tap forest2.
		alice.manaPool.G = 0;

		const elf = putInZone(
			state,
			alice,
			card({
				name: 'Canopy Scout',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Elf Scout',
				oracleText: '',
				power: '1',
				toughness: '1'
			}),
			'hand'
		);

		// 3. Auto-paying a {G} spell taps forest2 through the mana-ability funnel, triggers the extra {G} inline,
		// deducts {G} for the spell, and leaves the extra {G} in Alice's mana pool.
		const castRes = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: elf.instanceId
		});
		assert.equal(castRes.ok, true, castRes.error ?? '');
		assert.equal(forest2.tapped, true, 'forest2 was auto-tapped');
		assert.equal(state.stack.length, 1, 'only the spell is on the stack');
		assert.equal(alice.manaPool.G, 1, 'extra {G} from triggered mana ability remains in mana pool after auto-paying {G}');
	});
});
