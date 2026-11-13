import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { runAutomatedPriorityAndBots } from '../ai.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	ENGINE_VERSION,
	type CardInstance,
	type GameActionPayload,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';
import {
	chooseBotAnswer,
	effectivePromptChoice,
	enqueueChoicePrompt,
	registerPromptHandler,
	validateChoiceAnswer
} from './choices.ts';
import { moveObject } from './zones.ts';

function card(overrides: Partial<ScryfallCard> & { name: string; typeLine: string }): ScryfallCard {
	return {
		id: `scry_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		oracleId: `ora_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{0}',
		cmc: 0,
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		legalCommander: false,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function spell(name: string, costClause: string, effect = 'Draw a card.'): ScryfallCard {
	return card({
		name,
		typeLine: 'Sorcery',
		manaCost: '{B}',
		cmc: 1,
		colors: ['B'],
		colorIdentity: ['B'],
		oracleText: `As an additional cost to cast this spell, ${costClause}\n${effect}`
	});
}

function creature(name: string, power = 2, toughness = 2): ScryfallCard {
	return card({
		name,
		typeLine: 'Creature — Beast',
		manaCost: '{1}{G}',
		cmc: 2,
		power: String(power),
		toughness: String(toughness)
	});
}

function artifact(name: string): ScryfallCard {
	return card({ name, typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
}

function newGame(keepMulligans = true): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const deck = PRECON_DECKS[0];
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `Player ${i + 1}`,
		avatarUrl: '',
		isBot: false,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: deck.colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
	const state = createInitialGameState(
		'CHOICE_TEST',
		seats,
		new Map([
			[0, deck],
			[1, deck]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	if (keepMulligans) {
		for (const p of state.players) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
		for (const p of state.players) {
			p.battlefield = [];
			p.hand = [];
			p.graveyard = [];
			p.exile = [];
			p.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		}
		state.phase = 'main1';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
	}
	return { state, p1: state.players[0], p2: state.players[1] };
}

function put(
	state: GameState,
	player: PlayerGameState,
	scryCard: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const inst = createCardInstance(scryCard, player.playerId, zone);
	inst.summoningSick = false;
	moveObject(state, inst, zone, { from: 'none', toPlayer: player, newTimestamp: true });
	return inst;
}

describe('Phase 8: GameState.engineVersion (§2.6)', () => {
	it('initialises engineVersion on new games and preserves it across JSON round-trip', () => {
		const { state } = newGame();
		assert.equal(typeof ENGINE_VERSION, 'number');
		assert.ok(ENGINE_VERSION >= 1);
		assert.equal(state.engineVersion, ENGINE_VERSION);

		const roundTrip = JSON.parse(JSON.stringify(state)) as GameState;
		assert.equal(roundTrip.engineVersion, ENGINE_VERSION);
	});

	it('ends an active game created under an older engineVersion with a system log entry', () => {
		const { state, p1 } = newGame();
		(state as { engineVersion: number }).engineVersion = ENGINE_VERSION - 1;

		const res = applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, false);
		assert.equal(state.status, 'finished');
		assert.ok(
			state.log.some((entry) => entry.kind === 'system' && /version/i.test(entry.text)),
			'expected a system log entry explaining the engineVersion mismatch'
		);
	});
});

describe('Phase 8: Generic choice protocol — all 6 choice kinds', () => {
	it('1. yesNo: commander zone choice and mulligan prompts carry yesNo choice and resolve via { type: "choice" }', () => {
		// Mulligan via generic { type: 'choice' }
		const { state: mulState, p1: mulP1, p2: mulP2 } = newGame(false);
		const mulPrompt = mulState.pendingPrompts.find((pr) => pr.playerId === mulP1.playerId)!;
		assert.ok(mulPrompt);
		assert.equal(mulPrompt.choice?.kind, 'yesNo');

		// Answering yes: false takes a mulligan
		assert.equal(
			applyGameAction(mulState, mulP1.playerId, {
				type: 'choice',
				promptId: mulPrompt.id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		assert.equal(mulP1.mulliganCount, 1);

		// Answering yes: true keeps hand
		const mulPromptAfter = mulState.pendingPrompts.find((pr) => pr.playerId === mulP1.playerId)!;
		assert.equal(
			applyGameAction(mulState, mulP1.playerId, {
				type: 'choice',
				promptId: mulPromptAfter.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(mulP1.hasKeptHand, true);
		assert.equal(applyGameAction(mulState, mulP2.playerId, { type: 'mulligan_keep' }).ok, true);

		// Commander zone SBA choice via generic { type: 'choice' }
		const { state, p1 } = newGame();
		const cmd = p1.command[0];
		moveObject(state, cmd, 'graveyard', {
			from: { player: p1, zone: 'command' },
			toPlayer: p1
		});
		checkStateBasedActions(state);

		const cmdPrompt = state.pendingPrompts.find((pr) => pr.playerId === p1.playerId)!;
		assert.ok(cmdPrompt);
		assert.equal(cmdPrompt.choice?.kind, 'yesNo');

		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: cmdPrompt.id,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.pendingPrompts.length, 0);
		assert.ok(p1.command.some((c) => c.instanceId === cmd.instanceId));
	});

	it('2. chooseObjects: discard_to_hand_size and search_library carry chooseObjects and resolve via { type: "choice" }', () => {
		const { state, p1 } = newGame();
		const cards = Array.from({ length: 9 }, (_, i) =>
			put(state, p1, creature(`Hand Bear ${i}`), 'hand')
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'end_turn' }).ok, true);

		const discardPrompt = state.pendingPrompts[0]!;
		assert.ok(discardPrompt);
		assert.equal(discardPrompt.choice?.kind, 'chooseObjects');
		if (discardPrompt.choice?.kind === 'chooseObjects') {
			assert.equal(discardPrompt.choice.min, 2);
			assert.equal(discardPrompt.choice.max, 2);
			assert.equal(discardPrompt.choice.zone, 'hand');
		}

		// Wrong count rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: discardPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [cards[0].instanceId] }
			}).ok,
			false
		);

		// Correct count accepted via { type: 'choice' }
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: discardPrompt.id,
				answer: {
					kind: 'chooseObjects',
					objectIds: [cards[0].instanceId, cards[1].instanceId]
				}
			}).ok,
			true
		);
		assert.equal(p1.hand.length, 7);
	});

	it('2b. chooseObjects: library search resolves pick and fail-to-find via { type: "choice" }', () => {
		const { state, p1, p2 } = newGame();
		const targetLand = put(
			state,
			p1,
			card({ name: 'Test Plains', typeLine: 'Basic Land — Plains' }),
			'library'
		);
		const nonMatch = put(state, p1, creature('Not A Land'), 'library');
		const tutor = put(
			state,
			p1,
			card({
				name: 'Seek the Plains',
				typeLine: 'Sorcery',
				manaCost: '{G}',
				cmc: 1,
				oracleText:
					'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: tutor.instanceId }).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		const searchPrompt = state.pendingPrompts[0]!;
		assert.ok(searchPrompt);
		assert.equal(searchPrompt.choice?.kind, 'chooseObjects');
		if (searchPrompt.choice?.kind === 'chooseObjects') {
			assert.equal(searchPrompt.choice.zone, 'library');
			assert.equal(searchPrompt.choice.min, 0);
			assert.equal(searchPrompt.choice.max, 1);
			assert.ok(searchPrompt.choice.candidates.includes(targetLand.instanceId));
			assert.ok(!searchPrompt.choice.candidates.includes(nonMatch.instanceId));
		}

		// Non-candidate rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: searchPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [nonMatch.instanceId] }
			}).ok,
			false
		);

		// Valid candidate accepted via { type: 'choice' }
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: searchPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [targetLand.instanceId] }
			}).ok,
			true
		);
		assert.ok(p1.battlefield.some((c) => c.instanceId === targetLand.instanceId));
	});

	it('3. chooseMode: validates mode indices and resolves modal choices via { type: "choice" }', () => {
		const { state, p1 } = newGame();
		let chosenIndices: number[] | null = null;
		// Step E2: the prompt continues through a named handler (plain data), not a callback.
		registerPromptHandler('test.prm_mode', (_st, _prompt, ans) => {
			if (ans.kind === 'chooseMode') chosenIndices = ans.indices;
		});
		const prompt = enqueueChoicePrompt(state, {
			id: 'prm_mode',
			continuation: { kind: 'handler', name: 'test.prm_mode' },
			playerId: p1.playerId,
			kind: 'chooseMode',
			title: 'Choose Two Modes',
			description: 'Choose two:',
			choice: {
				kind: 'chooseMode',
				modes: [
					'Destroy all artifacts',
					'Destroy all creatures',
					'Destroy all enchantments',
					'Exile all graveyards'
				],
				min: 2,
				max: 2
			}
		});

		// Too few modes rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseMode', indices: [0] }
			}).ok,
			false
		);
		// Duplicate mode index rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseMode', indices: [1, 1] }
			}).ok,
			false
		);
		// Out of bounds index rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseMode', indices: [0, 5] }
			}).ok,
			false
		);

		// Valid 2-mode selection resolves
		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseMode', indices: [1, 3] }
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.pendingPrompts.length, 0);
		assert.deepEqual(chosenIndices, [1, 3]);
	});

	it('4. chooseNumber: validates numeric bounds and resolves via { type: "choice" }', () => {
		const { state, p1 } = newGame();
		let pickedNumber: number | null = null;
		// Step E2: the prompt continues through a named handler (plain data), not a callback.
		registerPromptHandler('test.prm_num', (_st, _prompt, ans) => {
			if (ans.kind === 'chooseNumber') pickedNumber = ans.n;
		});
		const prompt = enqueueChoicePrompt(state, {
			id: 'prm_num',
			continuation: { kind: 'handler', name: 'test.prm_num' },
			playerId: p1.playerId,
			kind: 'chooseNumber',
			title: 'Choose a Number',
			description: 'Choose a number between 1 and 5.',
			choice: {
				kind: 'chooseNumber',
				min: 1,
				max: 5,
				reason: 'Choose a number between 1 and 5.'
			}
		});

		// Out of bounds or non-integer rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseNumber', n: 0 }
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseNumber', n: 6 }
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseNumber', n: 2.5 }
			}).ok,
			false
		);

		// Valid integer within [min, max] accepted
		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseNumber', n: 4 }
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(pickedNumber, 4);
	});

	it('5. orderObjects: scry and rearrange prompts carry orderObjects and resolve via { type: "choice" }', () => {
		const { state, p1, p2 } = newGame();
		const [a, b, c] = p1.library.slice(0, 3);
		const scrySpell = put(
			state,
			p1,
			card({
				name: 'Peer into Mist',
				typeLine: 'Instant',
				manaCost: '{U}',
				cmc: 1,
				oracleText: 'Scry 3.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: scrySpell.instanceId
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		const prompt = state.pendingPrompts[0]!;
		assert.ok(prompt);
		assert.equal(prompt.choice?.kind, 'orderObjects');
		if (prompt.choice?.kind === 'orderObjects') {
			assert.deepEqual(prompt.choice.objectIds, [a.instanceId, b.instanceId, c.instanceId]);
			assert.equal(prompt.choice.allowSplitBottom, true);
			assert.equal(prompt.choice.allowShuffle, false);
		}

		// Shuffle not allowed on normal scry
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: {
					kind: 'orderObjects',
					topIds: [c.instanceId, b.instanceId],
					bottomIds: [a.instanceId],
					shuffle: true
				}
			}).ok,
			false
		);

		// Valid orderObjects answer rearranges library
		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: {
				kind: 'orderObjects',
				topIds: [c.instanceId, b.instanceId],
				bottomIds: [a.instanceId]
			}
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p1.library[0].instanceId, c.instanceId);
		assert.equal(p1.library[1].instanceId, b.instanceId);
		assert.equal(p1.library.at(-1)?.instanceId, a.instanceId);
	});

	it('6. chooseReplacement: validates replacement option id and resolves via { type: "choice" }', () => {
		const { state, p1 } = newGame();
		let chosenReplacementId: string | null = null;
		// Step E2: the prompt continues through a named handler (plain data), not a callback.
		registerPromptHandler('test.prm_rep', (_st, _prompt, ans) => {
			if (ans.kind === 'chooseReplacement') chosenReplacementId = ans.id;
		});
		const prompt = enqueueChoicePrompt(state, {
			id: 'prm_rep',
			continuation: { kind: 'handler', name: 'test.prm_rep' },
			playerId: p1.playerId,
			kind: 'chooseReplacement',
			title: 'Choose Replacement Effect (CR 616.1)',
			description: 'Multiple replacement effects would modify this event. Choose which applies first:',
			choice: {
				kind: 'chooseReplacement',
				options: [
					{ id: 'rep_rest_in_peace', label: 'Exile card instead (Rest in Peace)' },
					{ id: 'rep_commander', label: 'Move Commander to Command Zone (CR 903.9a)' }
				]
			}
		});

		// Unknown replacement id rejected
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseReplacement', id: 'rep_nonexistent' }
			}).ok,
			false
		);

		// Valid replacement id accepted
		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseReplacement', id: 'rep_commander' }
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(chosenReplacementId, 'rep_commander');
	});
});

describe('Phase 8: End-the-turn optional choice without obeka_end_turn_choice', () => {
	it('prompts the active player with a generic yesNo choice and resolves via { type: "choice" }', () => {
		const { state, p1, p2 } = newGame();
		// Put a renamed card with "The player whose turn it is may end the turn." under p2's control
		// while it is p1's turn!
		const chronomancer = put(
			state,
			p2,
			card({
				name: 'Chrono Splitter',
				typeLine: 'Legendary Creature — Ogre Wizard',
				manaCost: '{1}{U}{B}{R}',
				cmc: 4,
				power: '3',
				toughness: '4',
				oracleText: '{T}: The player whose turn it is may end the turn.'
			}),
			'battlefield'
		);

		// Pass priority to p2 on p1's main1 so p2 can activate Chrono Splitter
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		const ab = getEffectiveActivatedAbilities(state, p2, chronomancer)[0]!;
		assert.ok(ab);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: chronomancer.instanceId,
				abilityId: ab.id
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);

		// Active player (p1) gets a generic yesNo prompt (not obeka_end_turn_choice)
		const prompt = state.pendingPrompts[0]!;
		assert.ok(prompt);
		assert.equal(prompt.playerId, p1.playerId);
		assert.notEqual(prompt.kind as string, 'obeka_end_turn_choice');
		assert.equal(prompt.choice?.kind, 'yesNo');

		// Legacy card-specific action 'obeka_end_turn_choice' is rejected
		const legacyAction = {
			type: 'obeka_end_turn_choice',
			endTurn: true
		} as unknown as GameActionPayload;
		assert.equal(applyGameAction(state, p1.playerId, legacyAction).ok, false);

		// Answering { kind: 'yesNo', yes: true } via { type: 'choice' } ends p1's turn immediately
		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.activePlayerIndex, 1, 'Turn ended and advanced to Player 2');
	});
});

describe('Phase 8: Cost choices via generic { type: "choice" }', () => {
	it('answers optional cost via { kind: "yesNo" }, mode cost via { kind: "chooseMode" }, and object cost via { kind: "chooseObjects" }', () => {
		const { state, p1 } = newGame();

		// 1. Optional cost -> yesNo choice
		const optSpell = put(state, p1, spell('Optional Spark', 'you may sacrifice an artifact.'), 'hand');
		const relic = put(state, p1, artifact('Spark Relic'), 'battlefield');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: optSpell.instanceId }).ok,
			true
		);
		const optPrompt = state.pendingPrompts[0]!;
		assert.ok(optPrompt);
		assert.equal(optPrompt.choice?.kind, 'yesNo');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: optPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.ok(p1.graveyard.some((c) => c.instanceId === relic.instanceId));
		state.stack = [];

		// 2. Alternative cost -> chooseMode choice
		const modeSpell = put(state, p1, spell('Ash Bargain', 'discard a card or pay 3 life.'), 'hand');
		put(state, p1, creature('Hand Fodder'), 'hand');
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: modeSpell.instanceId }).ok,
			true
		);
		const modePrompt = state.pendingPrompts[0]!;
		assert.ok(modePrompt);
		assert.equal(modePrompt.choice?.kind, 'chooseMode');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: modePrompt.id,
				answer: { kind: 'chooseMode', indices: [1] }
			}).ok,
			true
		);
		assert.equal(p1.life, lifeBefore - 3);
		state.stack = [];

		// 3. Object cost -> chooseObjects choice (and cancel)
		const sacSpell = put(state, p1, spell('Sacrifice Rite', 'sacrifice a creature.'), 'hand');
		const c1 = put(state, p1, creature('Beast One'), 'battlefield');
		const c2 = put(state, p1, creature('Beast Two'), 'battlefield');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: sacSpell.instanceId }).ok,
			true
		);
		const objPrompt = state.pendingPrompts[0]!;
		assert.ok(objPrompt);
		assert.equal(objPrompt.choice?.kind, 'chooseObjects');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: objPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [c2.instanceId] }
			}).ok,
			true
		);
		assert.ok(p1.battlefield.some((c) => c.instanceId === c1.instanceId));
		assert.ok(p1.graveyard.some((c) => c.instanceId === c2.instanceId));
	});
});

describe('Phase 8: Bot generic choice answering (ai.ts / runtime/choices.ts)', () => {
	it('bots answer pending generic choices through { type: "choice" } during runAutomatedPriorityAndBots', () => {
		const { state, p1 } = newGame();
		p1.isBot = true;
		let resolvedReplacement: string | null = null;
		// Step E2: the prompt continues through a named handler (plain data), not a callback.
		registerPromptHandler('test.prm_bot_rep', (_st, _prompt, ans) => {
			if (ans.kind === 'chooseReplacement') resolvedReplacement = ans.id;
		});
		enqueueChoicePrompt(state, {
			id: 'prm_bot_rep',
			continuation: { kind: 'handler', name: 'test.prm_bot_rep' },
			playerId: p1.playerId,
			kind: 'chooseReplacement',
			title: 'Bot Replacement Choice',
			description: 'Choose replacement:',
			choice: {
				kind: 'chooseReplacement',
				options: [
					{ id: 'opt_1', label: 'Option 1' },
					{ id: 'opt_2', label: 'Option 2' }
				]
			}
		});

		const botAns = chooseBotAnswer(state, p1, state.pendingPrompts[0]);
		assert.deepEqual(botAns, { kind: 'chooseReplacement', id: 'opt_1' });
		assert.equal(
			validateChoiceAnswer(effectivePromptChoice(state.pendingPrompts[0], state), botAns).ok,
			true
		);

		runAutomatedPriorityAndBots(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(resolvedReplacement, 'opt_1');
	});
});

describe('Track B1 Slice 2: Strict prompt & answer validation', () => {
	it('rejects wrong/stale promptId and foreign player promptId on { type: "choice" } without mutating pendingPrompts', () => {
		const { state, p1, p2 } = newGame();
		const p1Prompt = enqueueChoicePrompt(state, {
			id: 'prm_p1_only',
			playerId: p1.playerId,
			kind: 'yesNo',
			title: 'Confirm Action',
			description: 'Confirm?',
			choice: { kind: 'yesNo', question: 'Confirm?' }
		});
		const p2Prompt = enqueueChoicePrompt(state, {
			id: 'prm_p2_only',
			playerId: p2.playerId,
			kind: 'yesNo',
			title: 'Opponent Action',
			description: 'Confirm?',
			choice: { kind: 'yesNo', question: 'Confirm?' }
		});

		const wrongIdRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: 'prm_nonexistent',
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(wrongIdRes.ok, false);
		assert.ok(wrongIdRes.error);

		const foreignIdRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: p2Prompt.id,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(foreignIdRes.ok, false);
		assert.ok(foreignIdRes.error);

		assert.deepEqual(
			state.pendingPrompts.map((p) => p.id),
			[p1Prompt.id, p2Prompt.id],
			'pendingPrompts must remain untouched on rejected promptId'
		);
	});

	it('enforces orderObjects completeness on scry_choice and trigger_order', () => {
		// Direct validateChoiceAnswer checks (including empty objectIds + forged ID)
		assert.equal(
			validateChoiceAnswer(
				{ kind: 'orderObjects', objectIds: ['a', 'b'], allowSplitBottom: true, allowShuffle: false, reason: 'Scry 2' },
				{ kind: 'orderObjects', topIds: ['a'], bottomIds: [] }
			).ok,
			false
		);
		assert.equal(
			validateChoiceAnswer(
				{ kind: 'orderObjects', objectIds: [], allowSplitBottom: false, allowShuffle: false, reason: 'Empty' },
				{ kind: 'orderObjects', topIds: ['forged'], bottomIds: [] }
			).ok,
			false
		);

		// scry_choice via applyGameAction
		const { state, p1, p2 } = newGame();
		const [a, b, c] = p1.library.slice(0, 3);
		const scrySpell = put(
			state,
			p1,
			card({ name: 'Scry Probe', typeLine: 'Instant', manaCost: '{U}', cmc: 1, oracleText: 'Scry 3.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: scrySpell.instanceId }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		const scryPrompt = state.pendingPrompts[0]!;
		assert.equal(scryPrompt.purpose, 'scry_choice');
		const incompleteScry = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: scryPrompt.id,
			answer: { kind: 'orderObjects', topIds: [a.instanceId], bottomIds: [b.instanceId] }
		});
		assert.equal(incompleteScry.ok, false);
		assert.equal(state.pendingPrompts.length, 1, 'scry prompt stays pending on incomplete orderObjects');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: scryPrompt.id,
				answer: { kind: 'orderObjects', topIds: [a.instanceId, c.instanceId], bottomIds: [b.instanceId] }
			}).ok,
			true
		);

		// trigger_order via applyGameAction
		const { state: tState, p1: tp1, p2: tp2 } = newGame();
		const herald = put(
			tState,
			tp1,
			card({
				name: 'Dual Bell Herald',
				typeLine: 'Creature — Human',
				manaCost: '{1}{W}',
				cmc: 2,
				power: '2',
				toughness: '2',
				oracleText: 'When ~ enters, you gain 1 life.\nWhen ~ enters, draw a card.'
			}),
			'hand'
		);
		put(tState, tp1, card({ name: 'Plains', typeLine: 'Basic Land — Plains', manaCost: '', cmc: 0 }), 'library');
		assert.equal(applyGameAction(tState, tp1.playerId, { type: 'cast_spell', instanceId: herald.instanceId }).ok, true);
		assert.equal(applyGameAction(tState, tp1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(tState, tp2.playerId, { type: 'pass_priority' }).ok, true);

		const ordPrompt = tState.pendingPrompts[0]!;
		assert.equal(ordPrompt.purpose, 'trigger_order');
		assert.equal(ordPrompt.choice?.kind, 'orderObjects');
		const triggerIds = ordPrompt.choice?.kind === 'orderObjects' ? ordPrompt.choice.objectIds : [];
		assert.equal(triggerIds.length, 2);

		const incompleteOrder = applyGameAction(tState, tp1.playerId, {
			type: 'choice',
			promptId: ordPrompt.id,
			answer: { kind: 'orderObjects', topIds: [triggerIds[0]], bottomIds: [] }
		});
		assert.equal(incompleteOrder.ok, false);
		assert.equal(tState.pendingPrompts.length, 1, 'trigger_order prompt stays pending on incomplete list');
	});

	it('rejects stale/mismatched effect_choice continuations before splicing pendingPrompts', () => {
		const { state, p1 } = newGame();
		const b1 = put(state, p1, creature('Bog Hound'), 'battlefield');
		const spellCard = card({
			name: 'Sacrifice Rite',
			typeLine: 'Sorcery',
			oracleText: 'Sacrifice a creature.'
		});
		state.stack.push({
			id: 'stk_live',
			sourceInstanceId: 'src_live',
			card: spellCard,
			oracleText: spellCard.oracleText,
			ownerId: p1.playerId,
			controllerId: p1.playerId,
			kind: 'spell',
			title: spellCard.name,
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0,
			effectResume: {
				stepIndex: 2,
				bindings: [],
				answers: {}
			}
		});

		const mismatchedStepPrompt = enqueueChoicePrompt(state, {
			id: 'prm_eff_step',
			playerId: p1.playerId,
			kind: 'chooseObjects',
			title: 'Choose Creature',
			description: 'Sacrifice a creature.',
			continuation: { kind: 'effect_choice', stackItemId: 'stk_live', stepIndex: 0 },
			choice: { kind: 'chooseObjects', candidates: [b1.instanceId], min: 1, max: 1, zone: 'battlefield', reason: 'Sacrifice a creature.' }
		});

		const resMismatch = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: mismatchedStepPrompt.id,
			answer: { kind: 'chooseObjects', objectIds: [b1.instanceId] }
		});
		assert.equal(resMismatch.ok, false);
		assert.equal(state.pendingPrompts.length, 1, 'mismatched stepIndex prompt not spliced');

		state.pendingPrompts = [];
		const missingItemPrompt = enqueueChoicePrompt(state, {
			id: 'prm_eff_missing',
			playerId: p1.playerId,
			kind: 'chooseObjects',
			title: 'Choose Creature',
			description: 'Sacrifice a creature.',
			continuation: { kind: 'effect_choice', stackItemId: 'stk_gone', stepIndex: 0 },
			choice: { kind: 'chooseObjects', candidates: [b1.instanceId], min: 1, max: 1, zone: 'battlefield', reason: 'Sacrifice a creature.' }
		});

		const resMissing = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: missingItemPrompt.id,
			answer: { kind: 'chooseObjects', objectIds: [b1.instanceId] }
		});
		assert.equal(resMissing.ok, false);
		assert.equal(state.pendingPrompts.length, 1, 'missing stackItem effect_choice prompt not spliced');
	});

	it('rejects stale trigger_targets, trigger_may, manual_resolution, and invalid cost_choice without silent ok', () => {
		// 1. Stale trigger_targets (missing stack item)
		const { state: s1, p1: a1 } = newGame();
		const targetChoice = enqueueChoicePrompt(s1, {
			id: 'prm_trg_missing',
			playerId: a1.playerId,
			kind: 'chooseObjects',
			purpose: 'trigger_targets',
			title: 'Choose Trigger Target',
			description: 'Choose target',
			triggerStackItemId: 'stk_missing',
			triggerTargetSpecIndex: 0,
			choice: { kind: 'chooseObjects', candidates: [a1.playerId], min: 1, max: 1, zone: 'battlefield', reason: 'Choose target' }
		});
		assert.equal(
			applyGameAction(s1, a1.playerId, {
				type: 'choice',
				promptId: targetChoice.id,
				answer: { kind: 'chooseObjects', objectIds: [a1.playerId] }
			}).ok,
			false
		);
		assert.equal(s1.pendingPrompts.length, 1);

		// 2. Stale trigger_targets (out-of-bounds specIndex on live item) and trigger_may (missing item)
		const { state: s2, p1: a2 } = newGame();
		const trigCard = card({
			name: 'Spark Watcher',
			typeLine: 'Creature — Wizard',
			oracleText: 'When ~ enters, ~ deals 1 damage to any target.'
		});
		s2.stack.push({
			id: 'stk_trig',
			sourceInstanceId: 'src_trig',
			card: trigCard,
			oracleText: trigCard.oracleText,
			ownerId: a2.playerId,
			controllerId: a2.playerId,
			kind: 'triggered',
			title: trigCard.name,
			triggeredAbilityIndex: 0,
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});
		const badSpecPrompt = enqueueChoicePrompt(s2, {
			id: 'prm_trg_badspec',
			playerId: a2.playerId,
			kind: 'chooseObjects',
			purpose: 'trigger_targets',
			title: 'Choose Target',
			description: 'Choose target',
			triggerStackItemId: 'stk_trig',
			triggerTargetSpecIndex: 9,
			choice: { kind: 'chooseObjects', candidates: [a2.playerId], min: 1, max: 1, zone: 'battlefield', reason: 'Choose target' }
		});
		assert.equal(
			applyGameAction(s2, a2.playerId, {
				type: 'choice',
				promptId: badSpecPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [a2.playerId] }
			}).ok,
			false
		);
		assert.equal(s2.pendingPrompts.length, 1);

		s2.pendingPrompts = [];
		const staleMayPrompt = enqueueChoicePrompt(s2, {
			id: 'prm_trg_may_missing',
			playerId: a2.playerId,
			kind: 'yesNo',
			purpose: 'trigger_may',
			title: 'Optional Trigger',
			description: 'Use?',
			triggerStackItemId: 'stk_gone',
			choice: { kind: 'yesNo', question: 'Use?' }
		});
		assert.equal(
			applyGameAction(s2, a2.playerId, {
				type: 'choice',
				promptId: staleMayPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			false
		);
		assert.equal(s2.pendingPrompts.length, 1);

		// 3. Stale manual_resolution (missing stack item) does not apply operations or splice prompt
		const { state: s3, p1: a3 } = newGame();
		const lifeBefore = a3.life;
		const staleManual = enqueueChoicePrompt(s3, {
			id: 'prm_manual_stale',
			playerId: a3.playerId,
			kind: 'guided_resolution',
			purpose: 'guided_resolution',
			title: 'Resolve Manually',
			description: 'Resolve',
			continuation: { kind: 'manual_resolution', stackItemId: 'stk_gone' },
			choice: { kind: 'yesNo', question: 'Done?' }
		});
		assert.equal(
			applyGameAction(s3, a3.playerId, {
				type: 'choice',
				promptId: staleManual.id,
				answer: { kind: 'yesNo', yes: true },
				operations: [{ op: 'modify_life', targetId: a3.playerId, amount: 10 }]
			}).ok,
			false
		);
		assert.equal(s3.pendingPrompts.length, 1);
		assert.equal(a3.life, lifeBefore, 'operations must not run when manual_resolution stack item is missing');

		// 4. Invalid cost_choice when !cancel and !pendingAction
		const { state: s4, p1: a4 } = newGame();
		const invalidCost = enqueueChoicePrompt(s4, {
			id: 'prm_cost_invalid',
			playerId: a4.playerId,
			kind: 'cost_choice',
			purpose: 'cost_choice',
			title: 'Choose Cost',
			description: 'Pay?',
			choice: { kind: 'yesNo', question: 'Pay?' }
		});
		assert.equal(
			applyGameAction(s4, a4.playerId, {
				type: 'choice',
				promptId: invalidCost.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			false
		);
		assert.equal(s4.pendingPrompts.length, 1);
		// Cancelling an invalid/orphaned cost_choice is still permitted
		assert.equal(
			applyGameAction(s4, a4.playerId, {
				type: 'choice',
				promptId: invalidCost.id,
				cancel: true
			}).ok,
			true
		);
		assert.equal(s4.pendingPrompts.length, 0);
	});

	it('rejects duplicate, foreign, or forged IDs in london_bottom (both choice and legacy actions)', () => {
		const { state, p1, p2 } = newGame(false);
		state.rules.mulliganRule = 'london_standard';

		// Mulligan twice so P1 must bottom 2 cards
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_take' }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_take' }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_keep' }).ok, true);

		const bottomPrompt = state.pendingPrompts.find(
			(pr) => pr.playerId === p1.playerId && pr.kind === 'london_bottom'
		)!;
		assert.ok(bottomPrompt);
		assert.equal(bottomPrompt.countRequired, 2);

		const handBefore = p1.hand.map((c) => c.instanceId);
		const libBefore = p1.library.length;
		const foreignId = p2.hand[0].instanceId;

		// 1. Duplicate IDs via legacy london_bottom
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'london_bottom',
				instanceIds: [handBefore[0], handBefore[0]]
			}).ok,
			false
		);
		// 2. Foreign ID via legacy london_bottom
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'london_bottom',
				instanceIds: [handBefore[0], foreignId]
			}).ok,
			false
		);
		// 3. Forged ID via { type: 'choice' }
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: bottomPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [handBefore[0], 'forged_card_id'] }
			}).ok,
			false
		);
		// 4. Wrong/foreign promptId during mulligan via { type: 'choice' }
		const p2MullPrompt = state.pendingPrompts.find((pr) => pr.playerId === p2.playerId)!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: p2MullPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [handBefore[0], handBefore[1]] }
			}).ok,
			false
		);

		assert.equal(p1.hand.length, handBefore.length);
		assert.equal(p1.library.length, libBefore);
		assert.ok(state.pendingPrompts.some((pr) => pr.id === bottomPrompt.id));

		// Valid choice succeeds
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: bottomPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [handBefore[0], handBefore[1]] }
			}).ok,
			true
		);
		assert.equal(p1.hand.length, handBefore.length - 2);
		assert.equal(p1.library.length, libBefore + 2);
	});

	it('rejects stale procedure continuations (clone_copy_choice & ward_payment_choice) before splicing pendingPrompts', () => {
		const { state, p1, p2 } = newGame();
		const targetPerm = put(state, p2, creature('Target Bear'), 'battlefield');

		const staleCloneId = 'prm_stale_clone';
		const staleWardId = 'prm_stale_ward';
		state.pendingPrompts.push(
			{
				id: staleCloneId,
				playerId: p1.playerId,
				kind: 'chooseObjects',
				purpose: 'generic',
				title: 'Clone — Choose a Creature to Copy',
				description: 'Choose a creature to copy.',
				continuation: {
					kind: 'procedure',
					procedure: { kind: 'clone_copy_choice', stackItemId: 'stk_missing_clone' }
				},
				choice: {
					kind: 'chooseObjects',
					candidates: [targetPerm.instanceId],
					min: 0,
					max: 1,
					zone: 'battlefield',
					reason: 'Choose creature to copy'
				}
			},
			{
				id: staleWardId,
				playerId: p1.playerId,
				kind: 'yesNo',
				purpose: 'generic',
				title: 'Ward',
				description: 'Pay ward cost {2}?',
				continuation: {
					kind: 'procedure',
					procedure: {
						kind: 'ward_payment_choice',
						wardStackItemId: 'stk_missing_ward',
						targetStackItemId: 'stk_missing_target'
					}
				},
				choice: { kind: 'yesNo', question: 'Pay ward cost {2}?' }
			}
		);

		const cloneRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: staleCloneId,
			answer: { kind: 'chooseObjects', objectIds: [targetPerm.instanceId] }
		});
		assert.equal(cloneRes.ok, false);
		assert.ok(
			state.pendingPrompts.some((pr) => pr.id === staleCloneId),
			'stale clone_copy_choice rejection must not splice prompt'
		);

		const wardRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: staleWardId,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(wardRes.ok, false);
		assert.ok(
			state.pendingPrompts.some((pr) => pr.id === staleWardId),
			'stale ward_payment_choice rejection must not splice prompt'
		);
	});
});
