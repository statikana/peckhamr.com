import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	addCountersToPermanent,
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	movePermanentToZone,
	resolveTopOfStack,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { cardSupportReport } from '../compiler/support.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type ManaPool,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function createEmptyManaPool(): ManaPool {
	return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

function makeSeat(index: number, isBot = false): LobbySeat {
	const deck = PRECON_DECKS[index % PRECON_DECKS.length];
	return {
		seatIndex: index,
		userId: `p${index + 1}`,
		username: `Player ${index + 1}`,
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

function makeGame(bots: boolean[] = [false, false]): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats = bots.map((isBot, i) => makeSeat(i, isBot));
	const state = createInitialGameState(
		'TIER2B_TEST',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		if (!p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	for (const p of state.players) {
		p.battlefield = [];
		p.hand = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = createEmptyManaPool();
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return {
		state,
		p1: state.players[0],
		p2: state.players[1]
	};
}

let synthCounter = 0;
function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	synthCounter += 1;
	return {
		id: overrides.id ?? `synth_t2b_${synthCounter}`,
		oracleId: overrides.oracleId ?? `ora_t2b_${synthCounter}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		loyalty: overrides.loyalty ?? undefined,
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

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'battlefield' | 'hand' | 'graveyard' | 'exile' | 'library' | 'command'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	player[zone].push(inst);
	return inst;
}

describe('Tier 2B — 5a: Commander to hand/library choice (CR 903.9b)', () => {
	it('prompts a human owner with commander_zone_choice when their commander is bounced to hand or tucked to library, and redacts the prompt for opponents (CR 903.9b)', () => {
		const { state, p1, p2 } = makeGame([false, false]);
		const cmd = p1.command.splice(0, 1)[0];
		assert.ok(cmd && cmd.isCommander);
		cmd.zone = 'battlefield';
		p1.battlefield.push(cmd);

		// Bounce human commander from battlefield to hand -> prompts commander_zone_choice
		movePermanentToZone(state, cmd, 'hand');
		const bouncePrompt = state.pendingPrompts.find(
			(pr) => pr.playerId === p1.playerId && pr.purpose === 'commander_zone_choice'
		);
		assert.ok(bouncePrompt, 'Expected a commander_zone_choice prompt when human commander moves to hand');
		assert.equal(bouncePrompt.choice?.kind, 'yesNo');

		// Sanitizer check: opponent view must not leak hidden card name or instanceId in prompt
		const viewForP2 = sanitizeGameStateForViewer(state, p2.playerId);
		const p2SeenPrompt = viewForP2.pendingPrompts.find((pr) => pr.id === bouncePrompt.id);
		assert.ok(p2SeenPrompt);
		assert.equal(p2SeenPrompt.description, 'Opponent is choosing…');
		const serialized = JSON.stringify(p2SeenPrompt);
		assert.equal(serialized.includes(cmd.card.name), false, 'Opponent prompt must not leak card name');
		assert.equal(serialized.includes(cmd.instanceId), false, 'Opponent prompt must not leak instanceId');

		// Accept default (yes -> command zone)
		const yesRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: bouncePrompt.id,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(yesRes.ok, true);
		assert.equal(p1.command.some((c) => c.instanceId === cmd.instanceId), true, 'Commander should be in command zone');
		assert.equal(p1.hand.some((c) => c.instanceId === cmd.instanceId), false, 'Commander should not remain in hand');

		// Put commander back on battlefield and tuck into library, then decline (leave in library)
		p1.command.splice(0, 1);
		cmd.zone = 'battlefield';
		p1.battlefield.push(cmd);
		movePermanentToZone(state, cmd, 'library');
		const tuckPrompt = state.pendingPrompts.find(
			(pr) => pr.playerId === p1.playerId && pr.purpose === 'commander_zone_choice'
		);
		assert.ok(tuckPrompt, 'Expected a commander_zone_choice prompt when human commander moves to library');
		const noRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: tuckPrompt.id,
			answer: { kind: 'yesNo', yes: false }
		});
		assert.equal(noRes.ok, true);
		assert.equal(p1.library.some((c) => c.instanceId === cmd.instanceId), true, 'Commander should stay in library when declined');
		assert.equal(p1.command.some((c) => c.instanceId === cmd.instanceId), false);
	});

	it('applies commanderRedirect on non-battlefield moves to hand/library for both bots and humans, and preserves CR 903.9a SBA', () => {
		const { state, p1, p2 } = makeGame([false, true]);
		const humanCmd = p1.command.splice(0, 1)[0];
		const botCmd = p2.command.splice(0, 1)[0];
		assert.ok(humanCmd && botCmd);

		// Put bot commander in graveyard (declined SBA) and return it to hand with an effect -> bot redirects to command zone
		botCmd.zone = 'graveyard';
		botCmd.commanderSbaDeclinedVersion = botCmd.objectVersion ?? 1;
		p2.graveyard.push(botCmd);

		const raiseDead = synthCard({
			name: 'Raise Dead',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Return target creature card from your graveyard to your hand.'
		});
		state.stack.push({
			id: 'stk_bot_raise',
			sourceInstanceId: 'src_bot_raise',
			card: raiseDead,
			controllerId: p2.playerId,
			kind: 'spell',
			title: 'Raise Dead',
			oracleText: raiseDead.oracleText,
			targets: [{ kind: 'graveyard_card', id: botCmd.instanceId, label: botCmd.card.name }],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});
		resolveTopOfStack(state);
		assert.equal(
			p2.command.some((c) => c.instanceId === botCmd.instanceId),
			true,
			'Bot commander returned from graveyard to hand should redirect to command zone (CR 903.9b)'
		);
		assert.equal(p2.hand.some((c) => c.instanceId === botCmd.instanceId), false);

		// Put human commander in graveyard and return it to hand -> prompts human with commander_zone_choice
		humanCmd.zone = 'graveyard';
		humanCmd.commanderSbaDeclinedVersion = humanCmd.objectVersion ?? 1;
		p1.graveyard.push(humanCmd);
		state.stack.push({
			id: 'stk_human_raise',
			sourceInstanceId: 'src_human_raise',
			card: raiseDead,
			controllerId: p1.playerId,
			kind: 'spell',
			title: 'Raise Dead',
			oracleText: raiseDead.oracleText,
			targets: [{ kind: 'graveyard_card', id: humanCmd.instanceId, label: humanCmd.card.name }],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});
		resolveTopOfStack(state);
		const gyToHandPrompt = state.pendingPrompts.find(
			(pr) => pr.playerId === p1.playerId && pr.purpose === 'commander_zone_choice'
		);
		assert.ok(gyToHandPrompt, 'Human should be prompted when commander moves from graveyard to hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: gyToHandPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1.command.some((c) => c.instanceId === humanCmd.instanceId), true);

		// Verify CR 903.9a (graveyard/exile SBA) still works unchanged
		p1.command.splice(0, 1);
		humanCmd.zone = 'exile';
		humanCmd.objectVersion = (humanCmd.objectVersion ?? 1) + 1;
		p1.exile.push(humanCmd);
		checkStateBasedActions(state);
		const sbaPrompt = state.pendingPrompts.find(
			(pr) => pr.playerId === p1.playerId && pr.purpose === 'commander_zone_choice'
		);
		assert.ok(sbaPrompt, 'CR 903.9a SBA prompt should still be enqueued for exile');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: sbaPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1.command.some((c) => c.instanceId === humanCmd.instanceId), true);
	});
});

describe('Tier 2B — 5b: Proliferate human choice (CR 701.34a)', () => {
	it('prompts a human controller with chooseObjects (min 0, max all) over permanents and players with counters, with heuristic defaultObjectIds, while keeping bots automatic (CR 701.34a)', () => {
		const { state, p1, p2 } = makeGame([false, true]);

		const cPlus = putInZone(state, p1, synthCard({ name: 'Plus Bear' }), 'battlefield');
		cPlus.counters['+1/+1'] = 1;
		const cMinus = putInZone(state, p1, synthCard({ name: 'Persist Bear', toughness: '4' }), 'battlefield');
		cMinus.counters['-1/-1'] = 1;
		const noCounter = putInZone(state, p1, synthCard({ name: 'Plain Bear' }), 'battlefield');
		p1.energyCounters = 2;

		const oppMinus = putInZone(state, p2, synthCard({ name: 'Weakened Guard', toughness: '4' }), 'battlefield');
		oppMinus.counters['-1/-1'] = 1;
		oppMinus.counters.stun = 1;
		const oppPlus = putInZone(state, p2, synthCard({ name: 'Buffed Guard' }), 'battlefield');
		oppPlus.counters['+1/+1'] = 1;
		p2.poison = 3;

		const prolifSpell = synthCard({
			name: 'Contentious Plan',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Proliferate.\nDraw a card.'
		});
		putInZone(state, p1, synthCard({ name: 'Top Card' }), 'library');
		state.stack.push({
			id: 'stk_prolif_human',
			sourceInstanceId: 'src_prolif_human',
			card: prolifSpell,
			controllerId: p1.playerId,
			kind: 'spell',
			title: 'Contentious Plan',
			oracleText: prolifSpell.oracleText,
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});

		resolveTopOfStack(state);

		const prompt = state.pendingPrompts.find((pr) => pr.playerId === p1.playerId);
		assert.ok(prompt, 'Human controller must receive a chooseObjects prompt for Proliferate');
		assert.equal(prompt.choice?.kind, 'chooseObjects');
		if (prompt.choice?.kind === 'chooseObjects') {
			assert.equal(prompt.choice.min, 0);
			assert.equal(prompt.choice.max, 6);
			assert.equal(prompt.choice.candidates.includes(noCounter.instanceId), false);
			assert.deepEqual(
				new Set(prompt.choice.candidates),
				new Set([
					cPlus.instanceId,
					cMinus.instanceId,
					p1.playerId,
					oppMinus.instanceId,
					oppPlus.instanceId,
					p2.playerId
				])
			);
			assert.deepEqual(
				new Set(prompt.choice.defaultObjectIds ?? []),
				new Set([cPlus.instanceId, p1.playerId, oppMinus.instanceId, p2.playerId])
			);
		}
		// Draw step after proliferate has not happened yet while paused
		assert.equal(p1.hand.length, 0);

		// Human deliberately chooses cMinus (own -1/-1 counter) and p2 (poison), skipping cPlus and oppMinus
		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: {
				kind: 'chooseObjects',
				objectIds: [cMinus.instanceId, p2.playerId]
			}
		});
		assert.equal(res.ok, true);
		assert.equal(cPlus.counters['+1/+1'], 1, 'Unchosen cPlus should stay at 1');
		assert.equal(cMinus.counters['-1/-1'], 2, 'Chosen cMinus should proliferate to 2');
		assert.equal(p1.energyCounters, 2, 'Unchosen p1 energy should stay at 2');
		assert.equal(oppMinus.counters['-1/-1'], 1, 'Unchosen oppMinus should stay at 1');
		assert.equal(p2.poison, 4, 'Chosen p2 poison should proliferate to 4');
		assert.equal(p1.hand.length, 1, 'Subsequent Draw a card step should complete after choice');

		// Bot controller proliferates automatically without a prompt
		state.stack.push({
			id: 'stk_prolif_bot',
			sourceInstanceId: 'src_prolif_bot',
			card: synthCard({
				name: 'Bot Proliferate',
				typeLine: 'Sorcery',
				oracleText: 'Proliferate.'
			}),
			controllerId: p2.playerId,
			kind: 'spell',
			title: 'Bot Proliferate',
			oracleText: 'Proliferate.',
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});
		resolveTopOfStack(state);
		assert.equal(state.pendingPrompts.length, 0, 'Bot should not be prompted for Proliferate');
		assert.equal(oppPlus.counters['+1/+1'], 2, 'Bot should auto-proliferate its own +1/+1 counter');
		assert.equal(cMinus.counters['-1/-1'], 3, 'Bot should auto-proliferate opponent -1/-1 counter');
	});
});

describe('Tier 2B — 5c: Ward human yesNo prompt and unsupported non-mana/life Ward costs (CR 702.21a)', () => {
	it('asks a human controller of a targeting spell/ability yesNo "Pay ward cost <cost>?", countering on decline and paying on yes (CR 702.21a)', () => {
		const { state, p1, p2 } = makeGame([false, false]);

		const wardDrake = putInZone(
			state,
			p1,
			synthCard({
				name: 'Ward Drake',
				typeLine: 'Creature — Drake',
				power: '3',
				toughness: '3',
				oracleText: 'Ward {2}',
				keywords: ['Ward']
			}),
			'battlefield'
		);

		const killSpell1 = putInZone(
			state,
			p2,
			synthCard({
				name: 'Doom Bolt 1',
				typeLine: 'Instant',
				manaCost: '{R}',
				cmc: 1,
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		p2.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 2 };
		state.priorityPlayerIndex = 1;

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: killSpell1.instanceId,
				targets: [{ kind: 'permanent', id: wardDrake.instanceId, label: wardDrake.card.name }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2);

		// Resolve Ward trigger -> human p2 can afford {2}, so p2 must be prompted with yesNo
		resolveTopOfStack(state);
		const wardPrompt1 = state.pendingPrompts.find((pr) => pr.playerId === p2.playerId);
		assert.ok(wardPrompt1, 'Human controller of targeting spell must be prompted to pay Ward cost');
		assert.equal(wardPrompt1.choice?.kind, 'yesNo');
		if (wardPrompt1.choice?.kind === 'yesNo') {
			assert.equal(wardPrompt1.choice.question, 'Pay ward cost {2}?');
		}

		// p2 declines to pay Ward {2} -> mana is unspent and spell is countered
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'choice',
				promptId: wardPrompt1.id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		assert.equal(p2.manaPool.C, 2, 'Mana must not be spent when declining Ward');
		assert.equal(state.stack.length, 0, 'Both Ward trigger and countered spell should leave stack');
		assert.equal(p2.graveyard.some((c) => c.instanceId === killSpell1.instanceId), true);
		assert.equal(p1.battlefield.some((c) => c.instanceId === wardDrake.instanceId), true);

		// Cast a second spell and accept the Ward prompt -> pays {2} and spell resolves
		const killSpell2 = putInZone(
			state,
			p2,
			synthCard({
				name: 'Doom Bolt 2',
				typeLine: 'Instant',
				manaCost: '{R}',
				cmc: 1,
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		p2.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 2 };
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: killSpell2.instanceId,
				targets: [{ kind: 'permanent', id: wardDrake.instanceId, label: wardDrake.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		const wardPrompt2 = state.pendingPrompts.find((pr) => pr.playerId === p2.playerId);
		assert.ok(wardPrompt2);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'choice',
				promptId: wardPrompt2.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p2.manaPool.C, 0, 'Human should pay {2} when accepting Ward prompt');
		assert.equal(state.stack.length, 1, 'Targeting spell should remain on stack after paying Ward');
		resolveTopOfStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === wardDrake.instanceId), false);
	});

	it('marks non-mana/non-life Ward costs as unsupported (fullySupported: false) and opens manual resolution instead of treating them as {0} (CR 702.21a)', () => {
		const { state, p1, p2 } = makeGame([false, false]);

		const discardWardCard = synthCard({
			name: 'Graveyard Sentinel',
			typeLine: 'Creature — Horror',
			power: '4',
			toughness: '4',
			oracleText: 'Ward—Discard a card.',
			keywords: ['Ward']
		});
		const report = cardSupportReport(discardWardCard);
		assert.equal(
			report.fullySupported,
			false,
			'Ward—Discard a card must report fullySupported: false instead of compiling as supported'
		);

		const sentinel = putInZone(state, p1, discardWardCard, 'battlefield');
		const bolt = putInZone(
			state,
			p2,
			synthCard({
				name: 'Bolt Sentinel',
				typeLine: 'Instant',
				manaCost: '{R}',
				cmc: 1,
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		p2.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
		state.priorityPlayerIndex = 1;

		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: sentinel.instanceId, label: sentinel.card.name }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2, 'Ward trigger should be placed on the stack');

		// Resolving the unsupported Ward trigger must open manual guided_resolution for p1, never succeed for free as {0}
		resolveTopOfStack(state);
		const manualPrompt = state.pendingPrompts.find((pr) => pr.purpose === 'guided_resolution');
		assert.ok(
			manualPrompt,
			'Unsupported Ward cost must open guided_resolution prompt instead of auto-paying {0} for free'
		);
		assert.equal(manualPrompt.playerId, p1.playerId);
	});
});

// ============================================================================
// Item 5d — Replacement ordering (CR 616.1, 616.1e–f)
// ============================================================================

describe('Tier 2B — 5d: Replacement ordering (CR 616.1, 616.1e–f)', () => {
	it('prompts the affected controller with chooseReplacement when 2+ zone-change replacements compete, re-evaluating after the choice so the other no longer applies (CR 616.1e–f)', () => {
		const { state, p1 } = makeGame([false, false]);

		// Enchantment: "If a card or token would be put into a graveyard from anywhere, exile it instead."
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Void Sanctum',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);

		// Creature 1: "If ~ would die, shuffle it into its owner's library instead."
		const phoenix1 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Astral Colossus 1',
				typeLine: 'Creature — Construct',
				power: '4',
				toughness: '4',
				oracleText: "If ~ would die, shuffle it into its owner's library instead."
			}),
			'battlefield'
		);

		movePermanentToZone(state, phoenix1, 'graveyard');

		const repPrompt1 = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseReplacement');
		assert.ok(
			repPrompt1,
			'Expected chooseReplacement prompt when two graveyard replacement effects apply to the same dying creature'
		);
		assert.equal(repPrompt1.playerId, p1.playerId);
		assert.equal(repPrompt1.choice?.kind, 'chooseReplacement');
		assert.equal(repPrompt1.choice.options.length, 2);

		const libOpt = repPrompt1.choice.options.find((o) => /library/i.test(o.label));
		assert.ok(libOpt, 'Expected an option for the shuffle-into-library replacement');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: repPrompt1.id,
				answer: { kind: 'chooseReplacement', id: libOpt.id }
			}).ok,
			true
		);
		assert.equal(
			state.pendingPrompts.length,
			0,
			'After shuffling into library, the graveyard-to-exile replacement no longer applies (CR 616.1f)'
		);
		assert.equal(p1.library.some((c) => c.instanceId === phoenix1.instanceId), true);
		assert.equal(p1.exile.some((c) => c.instanceId === phoenix1.instanceId), false);

		// Creature 2: choose the exile replacement first -> library replacement no longer applies
		const phoenix2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Astral Colossus 2',
				typeLine: 'Creature — Construct',
				power: '4',
				toughness: '4',
				oracleText: "If ~ would die, shuffle it into its owner's library instead."
			}),
			'battlefield'
		);
		movePermanentToZone(state, phoenix2, 'graveyard');
		const repPrompt2 = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseReplacement');
		assert.ok(repPrompt2 && repPrompt2.choice?.kind === 'chooseReplacement');
		const exileOpt = repPrompt2.choice.options.find((o) => /exile/i.test(o.label));
		assert.ok(exileOpt, 'Expected an option for the exile replacement');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: repPrompt2.id,
				answer: { kind: 'chooseReplacement', id: exileOpt.id }
			}).ok,
			true
		);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p1.exile.some((c) => c.instanceId === phoenix2.instanceId), true);
		assert.equal(p1.library.some((c) => c.instanceId === phoenix2.instanceId), false);
	});

	it('applies self-replacement first (CR 616.1a), prompts again when 2+ replacements still remain (CR 616.1f), and auto-applies when only 1 remains', () => {
		const { state, p1 } = makeGame([false, false]);

		const scales = putInZone(
			state,
			p1,
			synthCard({
				name: 'Hardened Scales',
				typeLine: 'Enchantment',
				oracleText:
					'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.'
			}),
			'battlefield'
		);
		const doubler1 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Corpsejack Menace',
				typeLine: 'Creature — Fungus',
				power: '4',
				toughness: '4',
				oracleText:
					'If one or more +1/+1 counters would be put on a creature you control, twice that many +1/+1 counters are put on it instead.'
			}),
			'battlefield'
		);
		const doubler2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Doubling Season',
				typeLine: 'Enchantment',
				oracleText:
					'If an effect would put one or more counters on a permanent you control, it puts twice that many of each of those kinds of counters on that permanent instead.'
			}),
			'battlefield'
		);
		assert.ok(scales && doubler1 && doubler2);

		const targetCreature = putInZone(
			state,
			p1,
			synthCard({
				name: 'Growing Saproling',
				typeLine: 'Creature — Saproling',
				power: '1',
				toughness: '1',
				oracleText: ''
			}),
			'battlefield'
		);

		// Put 2 +1/+1 counters on Growing Saproling with 3 applicable replacements (+1, x2, x2)
		addCountersToPermanent(state, targetCreature, '+1/+1', 2);

		// First prompt: 3 options
		const firstPrompt = state.pendingPrompts[0];
		assert.ok(firstPrompt, 'Expected first chooseReplacement prompt when 3 counter replacements apply');
		assert.equal(firstPrompt.choice?.kind, 'chooseReplacement');
		assert.equal(firstPrompt.choice.options.length, 3);

		// Choose Doubling Season (x2) first: 2 -> 4; 2 replacements remain (+1 and x2), so must prompt again!
		const d2Opt = firstPrompt.choice.options.find((o) => o.label.includes('Doubling Season'))!;
		assert.ok(d2Opt);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: firstPrompt.id,
				answer: { kind: 'chooseReplacement', id: d2Opt.id }
			}).ok,
			true
		);

		// Second prompt: 2 remaining options (Hardened Scales +1, Corpsejack Menace x2)
		const secondPrompt = state.pendingPrompts[0];
		assert.ok(
			secondPrompt,
			'Expected second chooseReplacement prompt because 2 replacements still apply (CR 616.1f)'
		);
		assert.equal(secondPrompt.choice?.kind, 'chooseReplacement');
		assert.equal(secondPrompt.choice.options.length, 2);

		// Choose Corpsejack Menace (x2) second: 4 -> 8; only 1 replacement remains (Hardened Scales +1), so it auto-applies (8 -> 9) without a third prompt!
		const d1Opt = secondPrompt.choice.options.find((o) => o.label.includes('Corpsejack Menace'))!;
		assert.ok(d1Opt);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: secondPrompt.id,
				answer: { kind: 'chooseReplacement', id: d1Opt.id }
			}).ok,
			true
		);
		assert.equal(state.pendingPrompts.length, 0, 'Single remaining replacement must apply without prompting');
		assert.equal(targetCreature.counters['+1/+1'], 9, '(2 * 2) * 2 + 1 = 9 counters');
	});
});

// ============================================================================
// Item 5e — Combat damage assignment among multiple blockers / trample (CR 510.1c–d, 702.19b)
// ============================================================================

describe('Tier 2B — 5e: Combat damage assignment among multiple blockers / trample (CR 510.1c–d, 702.19b)', () => {
	it('prompts human attacker with chooseNumber to divide damage freely among multiple blockers and deals all combat damage simultaneously (CR 510.1c, 510.2)', () => {
		const { state, p1, p2 } = makeGame([false, false]);

		const attacker = putInZone(
			state,
			p1,
			synthCard({
				name: 'Siege Rhino Veteran',
				typeLine: 'Creature — Soldier',
				power: '4',
				toughness: '4',
				oracleText: ''
			}),
			'battlefield'
		);
		const blocker1 = putInZone(
			state,
			p2,
			synthCard({
				name: 'Shield Bearer',
				typeLine: 'Creature — Wall',
				power: '2',
				toughness: '3',
				oracleText: ''
			}),
			'battlefield'
		);
		const blocker2 = putInZone(
			state,
			p2,
			synthCard({
				name: 'Spear Grunt',
				typeLine: 'Creature — Goblin',
				power: '1',
				toughness: '2',
				oracleText: ''
			}),
			'battlefield'
		);

		state.phase = 'declare_blockers';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.combat = {
			active: true,
			attackers: [
				{
					attackerInstanceId: attacker.instanceId,
					controllerId: p1.playerId,
					defenderPlayerId: p2.playerId,
					blockerInstanceIds: [blocker1.instanceId, blocker2.instanceId],
					wasBlocked: true
				}
			],
			declaredBlockersPlayerIds: [p2.playerId],
			blockersDeclared: true,
			damageDealtFirstStrike: false,
			damageDealtNormal: false,
			dealtFirstStrikeDamageIds: []
		};

		// Both players pass priority in declare_blockers -> advances to combat_damage
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		assert.equal(state.phase, 'combat_damage');
		const dmgPrompt = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseNumber');
		assert.ok(
			dmgPrompt,
			'Human attacker must receive a chooseNumber prompt when blocked by multiple creatures'
		);
		assert.equal(dmgPrompt.playerId, p1.playerId);
		assert.equal(dmgPrompt.choice?.kind, 'chooseNumber');
		assert.equal(dmgPrompt.choice.min, 0);
		assert.equal(dmgPrompt.choice.max, 4);
		assert.equal(dmgPrompt.choice.defaultNumber, 3);

		// CR 510.2: No combat damage is dealt before all assignments are collected
		assert.equal(blocker1.damageMarked, 0);
		assert.equal(blocker2.damageMarked, 0);
		assert.equal(attacker.damageMarked, 0);

		// CR 510.1c (late-2024 rules): Assign 1 (non-lethal) to blocker1; remaining 3 goes to blocker2
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: dmgPrompt.id,
				answer: { kind: 'chooseNumber', n: 1 }
			}).ok,
			true
		);

		assert.equal(state.pendingPrompts.length, 0, 'Remaining 3 damage to last blocker should be assigned automatically');
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === blocker1.instanceId),
			true,
			'Blocker 1 (2/3) took 1 damage and must survive'
		);
		assert.equal(blocker1.damageMarked, 1);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === blocker2.instanceId),
			false,
			'Blocker 2 (1/2) took 3 damage and must die'
		);
		assert.equal(
			attacker.damageMarked,
			3,
			'Attacker must take 2 + 1 = 3 combat damage simultaneously from both blockers (CR 510.2)'
		);
	});

	it('enforces CR 702.19b Trample (including Deathtouch + Trample): requires lethal on all blockers before excess tramples over', () => {
		// Subcase A: 5/5 Trample blocked by two 2/2s; assigning non-lethal (1) to B1 prevents any trample to player
		{
			const { state, p1, p2 } = makeGame([false, false]);
			const trampleAtk = putInZone(
				state,
				p1,
				synthCard({
					name: 'Charging Rhino',
					typeLine: 'Creature — Rhino',
					power: '5',
					toughness: '5',
					oracleText: 'Trample',
					keywords: ['Trample']
				}),
				'battlefield'
			);
			const b1 = putInZone(
				state,
				p2,
				synthCard({ name: 'Bear A', typeLine: 'Creature — Bear', power: '2', toughness: '2', oracleText: '' }),
				'battlefield'
			);
			const b2 = putInZone(
				state,
				p2,
				synthCard({ name: 'Bear B', typeLine: 'Creature — Bear', power: '2', toughness: '2', oracleText: '' }),
				'battlefield'
			);

			state.phase = 'declare_blockers';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			state.combat = {
				active: true,
				attackers: [
					{
						attackerInstanceId: trampleAtk.instanceId,
						controllerId: p1.playerId,
						defenderPlayerId: p2.playerId,
						blockerInstanceIds: [b1.instanceId, b2.instanceId],
						wasBlocked: true
					}
				],
				declaredBlockersPlayerIds: [p2.playerId],
				blockersDeclared: true,
				damageDealtFirstStrike: false,
				damageDealtNormal: false,
				dealtFirstStrikeDamageIds: []
			};

			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });

			const pB1 = state.pendingPrompts[0];
			assert.ok(pB1 && pB1.choice?.kind === 'chooseNumber');
			// Assign only 1 (non-lethal) to Bear A -> all remaining 4 must go to Bear B, 0 to defending player!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: pB1.id,
					answer: { kind: 'chooseNumber', n: 1 }
				}).ok,
				true
			);
			assert.equal(state.pendingPrompts.length, 0);
			assert.equal(p2.life, 40, 'No damage may trample over when a blocker was not assigned lethal damage (CR 702.19b)');
			assert.equal(p2.battlefield.some((c) => c.instanceId === b1.instanceId), true);
			assert.equal(p2.battlefield.some((c) => c.instanceId === b2.instanceId), false);
		}

		// Subcase B: 5/5 Deathtouch + Trample blocked by two 3/3s; 1 is lethal on each, 3 tramples over
		{
			const { state, p1, p2 } = makeGame([false, false]);
			const dtTrampleAtk = putInZone(
				state,
				p1,
				synthCard({
					name: 'Questing Basilisk',
					typeLine: 'Creature — Beast',
					power: '5',
					toughness: '5',
					oracleText: 'Deathtouch, trample',
					keywords: ['Deathtouch', 'Trample']
				}),
				'battlefield'
			);
			const b1 = putInZone(
				state,
				p2,
				synthCard({ name: 'Centaur A', typeLine: 'Creature — Centaur', power: '3', toughness: '3', oracleText: '' }),
				'battlefield'
			);
			const b2 = putInZone(
				state,
				p2,
				synthCard({ name: 'Centaur B', typeLine: 'Creature — Centaur', power: '3', toughness: '3', oracleText: '' }),
				'battlefield'
			);

			state.phase = 'declare_blockers';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			state.combat = {
				active: true,
				attackers: [
					{
						attackerInstanceId: dtTrampleAtk.instanceId,
						controllerId: p1.playerId,
						defenderPlayerId: p2.playerId,
						blockerInstanceIds: [b1.instanceId, b2.instanceId],
						wasBlocked: true
					}
				],
				declaredBlockersPlayerIds: [p2.playerId],
				blockersDeclared: true,
				damageDealtFirstStrike: false,
				damageDealtNormal: false,
				dealtFirstStrikeDamageIds: []
			};

			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });

			const pB1 = state.pendingPrompts[0];
			assert.ok(pB1 && pB1.choice?.kind === 'chooseNumber');
			assert.equal(pB1.choice.defaultNumber, 1, 'Deathtouch makes 1 damage lethal on a 3/3 blocker');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: pB1.id,
					answer: { kind: 'chooseNumber', n: 1 }
				}).ok,
				true
			);

			const pB2 = state.pendingPrompts[0];
			assert.ok(pB2 && pB2.choice?.kind === 'chooseNumber');
			assert.equal(pB2.choice.min, 1, 'Must assign at least lethal (1 with Deathtouch) to last blocker when trampling');
			assert.equal(pB2.choice.max, 4);
			assert.equal(pB2.choice.defaultNumber, 1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: pB2.id,
					answer: { kind: 'chooseNumber', n: 1 }
				}).ok,
				true
			);

			assert.equal(state.pendingPrompts.length, 0);
			assert.equal(p2.battlefield.length, 0, 'Both 3/3 blockers die to 1 Deathtouch damage');
			assert.equal(p2.life, 37, 'Remaining 3 damage tramples over to defending player');
		}
	});
});
