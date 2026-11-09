import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
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
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
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

function creature(
	name: string,
	oracleText = '',
	power = '2',
	toughness = '2',
	subtype = 'Bear'
): ScryfallCard {
	return card({
		name,
		manaCost: '{2}',
		cmc: 2,
		typeLine: `Creature — ${subtype}`,
		oracleText,
		power,
		toughness
	});
}

function seat(i: number, id: string, username: string, isBot: boolean): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: id,
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

function setupGame(players = 2, bots: boolean[] = []): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) =>
		seat(i, `player_${i + 1}`, names[i], Boolean(bots[i]))
	);
	const state = createInitialGameState(
		'LOBBY_REV3',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES },
		42
	);
	for (const s of seats) {
		const pl = state.players.find((x) => x.playerId === s.userId)!;
		const wasBot = pl.isBot;
		pl.isBot = false;
		if (state.status === 'mulligan') {
			assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
		}
		pl.isBot = wasBot;
	}
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) {
		pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	return { state, p: state.players };
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	player[zone].push(inst);
	return inst;
}

describe('Phase 3 (§4.1): Modal and multi-requirement target validation (#6, CR 115.3)', () => {
	it('allows two modes of a modal spell to target the same opponent and resolves both modes on that opponent', () => {
		const { state, p } = setupGame(2, [false, true]);
		const [p1, p2] = p;
		p2.hand = [createCardInstance(creature('Spare Bear'), p2.playerId, 'hand')];
		const startLife = p2.life;

		const kolaghansCommand = card({
			name: "Kolaghan's Command",
			manaCost: '{1}{B}{R}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText: [
				'Choose two —',
				'• Return target creature card from your graveyard to your hand.',
				'• Target player discards a card.',
				'• Destroy target artifact.',
				"• Kolaghan's Command deals 2 damage to any target."
			].join('\n')
		});
		const spellInst = put(state, p1, kolaghansCommand, 'hand');

		const oppTarget = { kind: 'player' as const, id: p2.playerId, label: p2.username };
		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spellInst.instanceId,
			modes: [1, 3],
			targets: [oppTarget, oppTarget]
		});
		assert.equal(castRes.ok, true, `Expected modal cast to succeed, got: ${castRes.error}`);
		assert.equal(state.stack.length, 1);

		// Resolve the spell
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		assert.equal(state.stack.length, 0);
		assert.equal(p2.hand.length, 0, 'Opponent should have discarded their card');
		assert.equal(p2.life, startLife - 2, 'Opponent should have taken 2 damage');
	});

	it('rejects choosing the same creature twice for a single "two target creatures" requirement (CR 115.3)', () => {
		const { state, p } = setupGame(2, [false, false]);
		const [p1, p2] = p;
		const bear1 = put(state, p2, creature('Bear One'), 'battlefield');
		put(state, p2, creature('Bear Two'), 'battlefield');

		const tapTwo = card({
			name: 'Frost Breath',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText: 'Tap two target creatures.'
		});
		const spellInst = put(state, p1, tapTwo, 'hand');

		const sameTarget = { kind: 'permanent' as const, id: bear1.instanceId, label: bear1.card.name };
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spellInst.instanceId,
			targets: [sameTarget, sameTarget]
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? '', /CR 115\.3/);

		// Also reject duplicate targets within a single multi-target mode of a modal spell
		const modalDestroyTwo = card({
			name: 'Ruinous Command',
			manaCost: '{2}{B}{B}',
			cmc: 4,
			typeLine: 'Instant',
			oracleText: ['Choose one —', '• Destroy two target creatures.', '• You draw a card.'].join(
				'\n'
			)
		});
		const modalInst = put(state, p1, modalDestroyTwo, 'hand');
		const modalRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: modalInst.instanceId,
			modes: [0],
			targets: [sameTarget, sameTarget]
		});
		assert.equal(modalRes.ok, false);
		assert.match(modalRes.error ?? '', /CR 115\.3/);
	});

	it('reports the right 1-based mode number when the second chosen mode has an illegal target', () => {
		const { state, p } = setupGame(2, [false, false]);
		const [p1, p2] = p;
		const bear = put(state, p2, creature('Grizzly Bears'), 'battlefield');

		// Mode 1 (index 0) has no targets; Mode 2 (index 1) targets an artifact.
		const modalSpell = card({
			name: 'Prismari Charm',
			manaCost: '{1}{U}{R}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText: [
				'Choose two —',
				'• You draw a card.',
				'• Destroy target artifact.',
				'• Prismari Charm deals 2 damage to any target.'
			].join('\n')
		});
		const spellInst = put(state, p1, modalSpell, 'hand');

		// Choose modes [0, 1]: Mode 1 requires 0 targets, Mode 2 requires 1 artifact target.
		// Passing a creature as the only target (`targets[0]`) is illegal for Mode 2, NOT Mode 1!
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spellInst.instanceId,
			modes: [0, 1],
			targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? '', /mode 2/i);
	});
});
