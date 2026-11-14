import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { executeBotStep, runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

function makeSeat(i: number, id: string, username: string, isBot = false): LobbySeat {
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
		lastHeartbeat: Date.now()
	};
}

function makeGame(botOpponent = false): { state: GameState; p: PlayerGameState[] } {
	const seats = [
		makeSeat(0, 'player_1', 'Alice', false),
		makeSeat(1, 'player_2', 'Bob', botOpponent)
	];
	const state = createInitialGameState(
		'LOBBY_MODAL',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const s of seats) {
		if (!s.isBot && state.status === 'mulligan') {
			assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
		}
	}
	assert.equal(state.status, 'active');
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) {
		pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	}
	return { state, p: state.players };
}

function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		if (card.loyalty) inst.counters.loyalty = parseInt(card.loyalty, 10);
	}
	player[zone].push(inst);
	return inst;
}

function assertOk(res: { ok: boolean; error?: string }): void {
	assert.equal(res.ok, true, res.error ?? 'expected action to succeed');
}

function passStackEmpty(state: GameState, max = 20): GameState {
	let s = state;
	for (let i = 0; i < max; i++) {
		if (s.stack.length === 0 || s.pendingPrompts.length > 0) break;
		const prio = s.players[s.priorityPlayerIndex];
		assertOk(applyGameAction(s, prio.playerId, { type: 'pass_priority' }));
		s = roundTrip(s);
	}
	return s;
}

function advanceToNextTurnMain1(state: GameState): GameState {
	const startActive = state.activePlayerIndex;
	const startTurn = state.turnNumber;
	enterEndStep(state, state.players[startActive]);
	let s = roundTrip(state);
	for (let i = 0; i < 30; i++) {
		if ((s.activePlayerIndex !== startActive || s.turnNumber !== startTurn) && s.phase === 'main1') {
			return s;
		}
		const pr = s.pendingPrompts[0];
		if (pr?.purpose === 'discard_to_hand_size' || pr?.choice?.kind === 'chooseObjects') {
			const cands =
				pr.candidateInstanceIds ??
				(pr.choice?.kind === 'chooseObjects' ? pr.choice.candidates : []);
			const count = pr.countRequired ?? (pr.choice?.kind === 'chooseObjects' ? pr.choice.min : 1);
			const pick = cands.slice(0, count);
			assertOk(
				applyGameAction(
					s,
					pr.playerId,
					pr.choice?.kind === 'chooseObjects'
						? { type: 'choice', promptId: pr.id, answer: { kind: 'chooseObjects', objectIds: pick } }
						: { type: 'discard_cards', instanceIds: pick }
				)
			);
			s = roundTrip(s);
			continue;
		}
		const prio = s.players[s.priorityPlayerIndex];
		assertOk(applyGameAction(s, prio.playerId, { type: 'pass_priority' }));
		s = roundTrip(s);
	}
	return s;
}

describe('Track D Slice 3 runtime: modal activated abilities, triggers, repeatability, multi-target fizzle, and AI', () => {
	it('enforces CR 700.2a modal activated ability validation, oncePerTurnUnique tracking, turn reset, and zone reset (CR 400.7)', () => {
		let { state } = makeGame();
		const engineArtifact = synthCard({
			name: 'Prism Codex',
			typeLine: 'Artifact',
			manaCost: '{2}',
			cmc: 2,
			oracleText:
				"{1}: Choose one that hasn't been chosen this turn —\n• Draw a card.\n• Gain 3 life.\n• Scry 1."
		});
		const inst = putInZone(state, state.players[0], engineArtifact, 'battlefield');
		const abs = getEffectiveActivatedAbilities(state, state.players[0], inst);
		const modalAb = abs.find((a) => !!a.modal);
		assert.ok(modalAb);

		// Invalid mode choices rejected
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'activate_ability',
				instanceId: inst.instanceId,
				abilityId: modalAb.id,
				chosenModes: []
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'activate_ability',
				instanceId: inst.instanceId,
				abilityId: modalAb.id,
				chosenModes: [0, 1]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'activate_ability',
				instanceId: inst.instanceId,
				abilityId: modalAb.id,
				chosenModes: [5]
			}).ok,
			false
		);

		const handBefore = state.players[0].hand.length;
		assertOk(
			applyGameAction(state, 'player_1', {
				type: 'activate_ability',
				instanceId: inst.instanceId,
				abilityId: modalAb.id,
				chosenModes: [0]
			})
		);
		state = passStackEmpty(roundTrip(state));
		assert.equal(state.players[0].hand.length, handBefore + 1);

		const onBoard = state.players[0].battlefield.find((c) => c.instanceId === inst.instanceId)!;
		assert.deepEqual(onBoard.usedModalModesThisTurn, [0]);

		// Choosing already-chosen mode 0 this turn is rejected
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'activate_ability',
				instanceId: inst.instanceId,
				abilityId: modalAb.id,
				chosenModes: [0]
			}).ok,
			false
		);

		// Choosing mode 1 succeeds and gains 3 life
		const lifeBefore = state.players[0].life;
		assertOk(
			applyGameAction(state, 'player_1', {
				type: 'activate_ability',
				instanceId: inst.instanceId,
				abilityId: modalAb.id,
				chosenModes: [1]
			})
		);
		state = passStackEmpty(roundTrip(state));
		assert.equal(state.players[0].life, lifeBefore + 3);

		// Advancing to next turn clears usedModalModesThisTurn via cleanup + untap
		state = advanceToNextTurnMain1(state);
		for (const pl of state.players) {
			pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		}
		const afterTurn = state.players[0].battlefield.find((c) => c.instanceId === inst.instanceId)!;
		assert.equal(afterTurn.usedModalModesThisTurn, undefined);

		// Alice can activate mode 0 again at instant speed on Bob's turn (once priority passes or give Alice priority)
		state.priorityPlayerIndex = 0;
		assertOk(
			applyGameAction(state, 'player_1', {
				type: 'activate_ability',
				instanceId: inst.instanceId,
				abilityId: modalAb.id,
				chosenModes: [0]
			})
		);
		state = passStackEmpty(roundTrip(state));
		assert.deepEqual(
			state.players[0].battlefield.find((c) => c.instanceId === inst.instanceId)?.usedModalModesThisTurn,
			[0]
		);

		// Leaving the battlefield and returning (CR 400.7) resets usedModalModesThisTurn via blink
		const blinkSpell = synthCard({
			name: 'Ephemeral Step',
			typeLine: 'Instant',
			manaCost: '{W}',
			cmc: 1,
			oracleText: "Exile target artifact you control, then return it to the battlefield under its owner's control."
		});
		const blinkCard = putInZone(state, state.players[0], blinkSpell, 'hand');
		// After stack empties on Bob's turn, Bob holds priority until he passes to Alice
		assert.equal(applyGameAction(state, 'player_2', { type: 'pass_priority' }).ok, true);
		assertOk(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: blinkCard.instanceId,
				targets: [permTarget(inst)]
			})
		);
		state = passStackEmpty(roundTrip(state));
		const blinked = state.players[0].battlefield.find((c) => c.card.name === 'Prism Codex');
		assert.ok(blinked);
		assert.equal(blinked.usedModalModesThisTurn, undefined);
	});

	it('handles CR 700.2b modal trigger prompts (disabledIndices, trigger_modes -> trigger_targets, CR 603.3c empty/illegal triggers)', () => {
		// Case A: disabledIndices when mode 0 lacks legal targets, mode 1 succeeds
		let { state } = makeGame();
		const etbModal = synthCard({
			name: 'Relic Sentinel',
			typeLine: 'Creature — Spirit',
			manaCost: '{1}{W}',
			cmc: 2,
			power: '2',
			toughness: '2',
			oracleText:
				'When Relic Sentinel enters, choose one —\n• Destroy target artifact.\n• Draw a card.\n• Gain 2 life.'
		});
		const creatureHand = putInZone(state, state.players[0], etbModal, 'hand');
		assert.equal(
			applyGameAction(state, 'player_1', { type: 'cast_spell', instanceId: creatureHand.instanceId }).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));

		const p1 = state.pendingPrompts[0];
		assert.ok(p1 && p1.purpose === 'trigger_modes' && p1.choice?.kind === 'chooseMode');
		assert.deepEqual(p1.choice.disabledIndices, [0]);

		// Selecting disabled mode 0 is rejected
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'choice',
				promptId: p1.id,
				answer: { kind: 'chooseMode', indices: [0] }
			}).ok,
			false
		);

		const handBefore = state.players[0].hand.length;
		assertOk(
			applyGameAction(state, 'player_1', {
				type: 'choice',
				promptId: p1.id,
				answer: { kind: 'chooseMode', indices: [1] }
			})
		);
		assert.equal(state.pendingPrompts.length, 0);
		state = passStackEmpty(roundTrip(state));
		assert.equal(state.players[0].hand.length, handBefore + 1);

		// Case B: with 2 opponent artifacts present, choosing mode 0 enqueues trigger_targets -> resolves destruction
		const enemyArt = synthCard({ name: 'Target Bauble', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
		const enemyArt2 = synthCard({ name: 'Backup Bauble', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
		const artInst = putInZone(state, state.players[1], enemyArt, 'battlefield');
		putInZone(state, state.players[1], enemyArt2, 'battlefield');
		const creature2 = putInZone(state, state.players[0], etbModal, 'hand');
		assert.equal(
			applyGameAction(state, 'player_1', { type: 'cast_spell', instanceId: creature2.instanceId }).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));

		const pm = state.pendingPrompts[0];
		assert.ok(pm && pm.purpose === 'trigger_modes' && pm.choice?.kind === 'chooseMode');
		assert.deepEqual(pm.choice.disabledIndices ?? [], []);
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'choice',
				promptId: pm.id,
				answer: { kind: 'chooseMode', indices: [0] }
			}).ok,
			true
		);
		state = roundTrip(state);
		const pt = state.pendingPrompts[0];
		assert.ok(pt && pt.purpose === 'trigger_targets' && pt.choice?.kind === 'chooseObjects');
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'choice',
				promptId: pt.id,
				answer: { kind: 'chooseObjects', objectIds: [artInst.instanceId] }
			}).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));
		assert.equal(
			state.players[1].battlefield.some((c) => c.instanceId === artInst.instanceId),
			false
		);
		assert.equal(
			state.players[1].graveyard.some((c) => c.instanceId === artInst.instanceId),
			true
		);

		// Case C: CR 603.3c trigger with NO legal mode (neither artifact nor enchantment exists) is removed before stack
		const impossibleEtb = synthCard({
			name: 'Doom Courier',
			typeLine: 'Creature — Horror',
			manaCost: '{2}{B}',
			cmc: 3,
			power: '2',
			toughness: '2',
			oracleText:
				'When Doom Courier enters, choose one —\n• Destroy target artifact.\n• Destroy target enchantment.'
		});
		const impHand = putInZone(state, state.players[0], impossibleEtb, 'hand');
		assert.equal(
			applyGameAction(state, 'player_1', { type: 'cast_spell', instanceId: impHand.instanceId }).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 0);

		// Case D: CR 603.3c "choose up to one" where human picks [] removes ability from stack
		const upToEtb = synthCard({
			name: 'Wisefolk',
			typeLine: 'Creature — Wizard',
			manaCost: '{1}{U}',
			cmc: 2,
			power: '1',
			toughness: '3',
			oracleText: 'When Wisefolk enters, choose up to one —\n• Draw a card.'
		});
		const handBeforeDecline = state.players[0].hand.length;
		const upHand = putInZone(state, state.players[0], upToEtb, 'hand');
		assert.equal(
			applyGameAction(state, 'player_1', { type: 'cast_spell', instanceId: upHand.instanceId }).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));
		const pu = state.pendingPrompts[0];
		assert.ok(pu && pu.purpose === 'trigger_modes');
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'choice',
				promptId: pu.id,
				answer: { kind: 'chooseMode', indices: [] }
			}).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));
		assert.equal(state.stack.length, 0);
		// -1 from casting Wisefolk, +0 from declining draw
		assert.equal(state.players[0].hand.length, handBeforeDecline);
	});

	it('supports CR 700.2d repeatable modes ("Choose three. You may choose the same mode more than once.") with per-spec targeting', () => {
		let { state } = makeGame();
		const bear = synthCard({
			name: 'Grizzly Bear',
			typeLine: 'Creature — Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			power: '2',
			toughness: '2'
		});
		const bearInst = putInZone(state, state.players[0], bear, 'battlefield');

		const threeRepeat = synthCard({
			name: 'Triad Surge',
			typeLine: 'Instant',
			manaCost: '{2}{G}',
			cmc: 3,
			oracleText:
				'Choose three. You may choose the same mode more than once. —\n• Target creature gets +2/+2 until end of turn.\n• Draw a card.'
		});
		const spell1 = putInZone(state, state.players[0], threeRepeat, 'hand');
		const handBefore = state.players[0].hand.length;

		assertOk(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: spell1.instanceId,
				modes: [0, 0, 1],
				targets: [permTarget(bearInst), permTarget(bearInst)]
			})
		);
		state = passStackEmpty(roundTrip(state));

		const boardBear = state.players[0].battlefield.find((c) => c.instanceId === bearInst.instanceId)!;
		assert.equal(boardBear.tempPowerMod, 4);
		assert.equal(boardBear.tempToughnessMod, 4);
		assert.equal(state.players[0].hand.length, handBefore); // -1 spell, +1 draw

		// Non-repeatable "Choose two —" rejects duplicate modes
		const nonRepeat = synthCard({
			name: 'Strict Pair',
			typeLine: 'Instant',
			manaCost: '{1}{G}',
			cmc: 2,
			oracleText: 'Choose two —\n• Draw a card.\n• Gain 2 life.'
		});
		const spell2 = putInZone(state, state.players[0], nonRepeat, 'hand');
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: spell2.instanceId,
				modes: [0, 0]
			}).ok,
			false
		);
	});

	it('resolves multi-target mode partially under CR 608.2b when one target leaves and counters when all targets become illegal', () => {
		let { state } = makeGame();
		const art = putInZone(
			state,
			state.players[1],
			synthCard({ name: 'Bronze Idol', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 }),
			'battlefield'
		);
		const ench = putInZone(
			state,
			state.players[1],
			synthCard({ name: 'Leyline Test', typeLine: 'Enchantment', manaCost: '{1}{W}', cmc: 2 }),
			'battlefield'
		);

		const multiModal = synthCard({
			name: 'Dual Verdict',
			typeLine: 'Instant',
			manaCost: '{1}{W}{B}',
			cmc: 3,
			oracleText:
				'Choose one —\n• Destroy target artifact. Destroy target enchantment.\n• Draw a card.'
		});
		const spell1 = putInZone(state, state.players[0], multiModal, 'hand');
		const exileArt = synthCard({
			name: 'Shatter Exile',
			typeLine: 'Instant',
			manaCost: '{W}',
			cmc: 1,
			oracleText: 'Exile target artifact.'
		});
		const responseSpell = putInZone(state, state.players[0], exileArt, 'hand');

		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: spell1.instanceId,
				modes: [0],
				targets: [permTarget(art), permTarget(ench)]
			}).ok,
			true
		);
		// Respond on top of stack by exiling only the artifact
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: responseSpell.instanceId,
				targets: [permTarget(art)]
			}).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));
		// CR 608.2b: artifact was exiled by response, enchantment is still destroyed by Dual Verdict!
		assert.equal(state.players[1].exile.some((c) => c.instanceId === art.instanceId), true);
		assert.equal(state.players[1].graveyard.some((c) => c.instanceId === ench.instanceId), true);

		// Now put fresh artifact + enchantment and exile BOTH before Dual Verdict resolves -> countered (not resolved)
		const art2 = putInZone(
			state,
			state.players[1],
			synthCard({ name: 'Silver Vessel', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 }),
			'battlefield'
		);
		const ench2 = putInZone(
			state,
			state.players[1],
			synthCard({ name: 'Oath Aura', typeLine: 'Enchantment', manaCost: '{W}', cmc: 1 }),
			'battlefield'
		);
		const spell2 = putInZone(state, state.players[0], multiModal, 'hand');
		const exileEnch = synthCard({
			name: 'Erase Test',
			typeLine: 'Instant',
			manaCost: '{W}',
			cmc: 1,
			oracleText: 'Exile target enchantment.'
		});
		const rArt = putInZone(state, state.players[0], exileArt, 'hand');
		const rEnch = putInZone(state, state.players[0], exileEnch, 'hand');

		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: spell2.instanceId,
				modes: [0],
				targets: [permTarget(art2), permTarget(ench2)]
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: rArt.instanceId,
				targets: [permTarget(art2)]
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, 'player_1', {
				type: 'cast_spell',
				instanceId: rEnch.instanceId,
				targets: [permTarget(ench2)]
			}).ok,
			true
		);
		state = passStackEmpty(roundTrip(state));
		assert.equal(state.stack.length, 0);
		assert.equal(
			state.players[0].graveyard.some((c) => c.instanceId === spell2.instanceId),
			true
		);
	});

	it('runs AI bot modal spell casting, modal activated abilities, and modal triggers with rename invariance', () => {
		function runBotScenario(prefix: string) {
			let { state } = makeGame(true);
			// Move to Bob's (bot) main1
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 1;
			state.phase = 'main1';

			const botModalArt = synthCard({
				name: `${prefix} Console`,
				typeLine: 'Artifact',
				manaCost: '{1}',
				cmc: 1,
				oracleText: `{1}, {T}: Choose one —\n• Draw a card.\n• Gain 2 life.`
			});
			const botModalSpell = synthCard({
				name: `${prefix} Charm`,
				typeLine: 'Sorcery',
				manaCost: '{1}{U}',
				cmc: 2,
				oracleText:
					'Choose two. You may choose the same mode more than once. —\n• Draw a card.\n• Gain 2 life.'
			});
			const botModalCreature = synthCard({
				name: `${prefix} Envoy`,
				typeLine: 'Creature — Spirit',
				manaCost: '{1}{W}',
				cmc: 2,
				power: '2',
				toughness: '2',
				oracleText: `When ${prefix} Envoy enters, choose one —\n• Draw a card.\n• Gain 2 life.`
			});

			putInZone(state, state.players[1], botModalArt, 'battlefield');
			putInZone(state, state.players[1], botModalSpell, 'hand');
			putInZone(state, state.players[1], botModalCreature, 'hand');
			// Clear extra non-test cards from Bob's hand & normalize library so shuffle RNG cannot alter bot choices
			state.players[1].hand = state.players[1].hand.filter((c) => c.card.name.startsWith(prefix));
			const blankSorcery = synthCard({
				name: 'Study Tome',
				typeLine: 'Sorcery',
				manaCost: '{99}',
				cmc: 99,
				oracleText: 'Draw a card.'
			});
			state.players[1].library = Array.from({ length: 10 }, () => {
				state.nextTimestamp = (state.nextTimestamp || 0) + 1;
				return createCardInstance(blankSorcery, 'player_2', 'library', false, false, state.nextTimestamp);
			});

			const initialLife = state.players[1].life;
			for (let step = 0; step < 30; step++) {
				runAutomatedPriorityAndBots(state);
				if (state.activePlayerIndex !== 1 || state.phase === 'end_step' || state.phase === 'cleanup') break;
				const botRes = executeBotStep(
					state,
					state.players[1],
					state.players[state.activePlayerIndex]
				);
				if (botRes === 'none') {
					if (state.pendingPrompts.length > 0) break;
					const prio = state.players[state.priorityPlayerIndex];
					applyGameAction(state, prio.playerId, { type: 'pass_priority' });
				}
				state = roundTrip(state);
			}
			const bob = state.players[1];
			assert.ok(
				bob.battlefield.some((c) => c.card.name === `${prefix} Envoy`),
				'bot cast modal ETB creature'
			);
			assert.ok(
				bob.graveyard.some((c) => c.card.name === `${prefix} Charm`),
				'bot cast repeatable modal sorcery'
			);
			const consoleOnBoard = bob.battlefield.find((c) => c.card.name === `${prefix} Console`);
			assert.ok(consoleOnBoard?.tapped, 'bot activated modal battlefield ability');
			assert.ok(bob.life >= initialLife, 'bot stayed valid with modal effects');
			return {
				life: bob.life,
				handCount: bob.hand.length,
				graveyardCount: bob.graveyard.length,
				battlefieldTapped: bob.battlefield.filter((c) => c.tapped).length
			};
		}

		const alpha = runBotScenario('Alpha');
		const zeta = runBotScenario('Zeta');
		assert.deepEqual(alpha, zeta);
	});
});
