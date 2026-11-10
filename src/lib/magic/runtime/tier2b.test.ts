import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	movePermanentToZone,
	resolveTopOfStack,
	sanitizeGameStateForViewer
} from '../engine.ts';
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
