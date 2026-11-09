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

describe('Phase 3 (§4.2): Trigger target order (#8, CR 603.3d)', () => {
	it('stores trigger targets in TargetSpec order and updates targetObjectVersions when Spec 0 is prompted and Spec 1 is forced', () => {
		const { state, p } = setupGame(2, [false, false]);
		const [p1, p2] = p;

		// Spec 0 ("target creature you control") has 2 legal candidates (prompted for human P1).
		// Spec 1 ("target creature an opponent controls") has 1 legal candidate (forced).
		const ally1 = put(state, p1, creature('Ally Alpha'), 'battlefield');
		const ally2 = put(state, p1, creature('Ally Beta'), 'battlefield');
		const enemy = put(state, p2, creature('Enemy Ogre'), 'battlefield');

		const etbCard = creature(
			'Vanguard Marshal',
			'When Vanguard Marshal enters, target creature you control gets +2/+2 until end of turn. Destroy target creature an opponent controls.'
		);
		const etbInst = put(state, p1, etbCard, 'hand');

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: etbInst.instanceId }).ok,
			true
		);
		// Resolve the creature spell so its ETB trigger is placed onto the stack
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		assert.equal(state.stack.length, 1);
		const prompt = state.pendingPrompts[0];
		assert.ok(prompt, 'Expected a trigger_targets prompt for Spec 0');
		assert.equal(prompt.purpose, 'trigger_targets');
		assert.equal(prompt.triggerTargetSpecIndex, 0);

		// Human answers Spec 0 by choosing ally1
		const choiceRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseObjects', objectIds: [ally1.instanceId] }
		});
		assert.equal(choiceRes.ok, true);

		const triggerItem = state.stack[0];
		assert.ok(triggerItem);
		assert.deepEqual(
			triggerItem.targets.map((t) => t.id),
			[ally1.instanceId, enemy.instanceId],
			'item.targets must be in [spec0Target, spec1Target] order'
		);
		assert.ok(
			triggerItem.targetObjectVersions?.[ally1.instanceId] !== undefined &&
				triggerItem.targetObjectVersions?.[enemy.instanceId] !== undefined,
			'targetObjectVersions must include both prompted and forced targets'
		);

		// Resolve the triggered ability: ally1 gets +2/+2 and stays on board; enemy is destroyed
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		assert.equal(state.stack.length, 0);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === ally1.instanceId),
			true,
			'ally1 (Spec 0) should still be on the battlefield'
		);
		assert.equal(ally1.tempPowerMod, 2, 'ally1 (Spec 0) should have received +2/+2');
		assert.equal(ally2.tempPowerMod, 0);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === enemy.instanceId),
			false,
			'enemy (Spec 1) should have been destroyed'
		);
	});
});

describe('Phase 3 (§4.3): Per-turn trigger counter (#9)', () => {
	it('resets triggersPlacedThisTurn for each player turn within the same round (turnNumber === 1)', () => {
		const { state, p } = setupGame(4, [false, false, false, false]);
		const [p1, p2] = p;
		assert.equal(state.turnNumber, 1);
		assert.equal(state.activePlayerIndex, 0);

		const landfallCard = card({
			name: 'Kazandu Refuge Watcher',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Elf',
			oracleText: 'Whenever a land you control enters, you gain 1 life.',
			power: '1',
			toughness: '1'
		});
		const forestCard = card({
			name: 'Forest',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: '{T}: Add {G}.'
		});

		for (let i = 0; i < 150; i++) {
			put(state, p1, landfallCard, 'battlefield');
		}
		for (let i = 0; i < 100; i++) {
			put(state, p2, landfallCard, 'battlefield');
		}

		p1.hand = [];
		p2.hand = [];

		// P1 plays a land on P1's turn -> places 150 triggers on the stack
		const p1Forest = put(state, p1, forestCard, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: p1Forest.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 150);

		// Clear stack/prompts and pass P1's turn to P2's turn (still round turnNumber === 1)
		state.stack = [];
		state.pendingPrompts = [];
		assert.equal(applyGameAction(state, p1.playerId, { type: 'end_turn' }).ok, true);
		assert.equal(state.turnNumber, 1, 'P2 turn 1 is still round turnNumber 1');
		assert.equal(state.activePlayerIndex, 1);

		// Advance P2 from upkeep -> draw -> main1
		while (state.phase !== 'main1') {
			const prioId = state.players[state.priorityPlayerIndex].playerId;
			assert.equal(applyGameAction(state, prioId, { type: 'pass_priority' }).ok, true);
		}
		assert.equal(state.phase, 'main1');

		// P2 plays a land on P2's turn -> places 100 triggers; none should be dropped!
		const p2Forest = put(state, p2, forestCard, 'hand');
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'play_land', instanceId: p2Forest.instanceId }).ok,
			true
		);
		assert.equal(
			state.stack.length,
			100,
			'All 100 of P2 triggers should be placed on the stack on P2 turn'
		);
	});
});


