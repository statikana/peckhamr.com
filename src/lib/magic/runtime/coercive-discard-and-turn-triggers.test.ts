import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { compileCard, COMPILER_VERSION } from '../compiler/index.ts';
import { PRECON_DECKS } from '../precons.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { moveObject, shuffleLibrary } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `synth_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Construct',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'uncommon',
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
		lastHeartbeat: 0
	};
}

function setupGame(botSeats: boolean[] = [false, false]): GameState {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = botSeats.map((isBot, i) => makeSeat(i, `player_${i + 1}`, names[i] ?? `Seat${i}`, isBot));
	const state = createInitialGameState(
		'LOBBY_TRACK_F_S3',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		if (state.status === 'mulligan' && !p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 30, U: 30, B: 30, R: 30, G: 30, C: 30 };
		if (!p.isBot) p.fullControl = true;
	}
	return state;
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'battlefield' | 'hand' | 'graveyard' | 'library' = 'battlefield',
	extra?: Partial<CardInstance>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(
		c,
		player.playerId,
		zone,
		false,
		false,
		state.nextTimestamp,
		state
	);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (extra) Object.assign(inst, extra);
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

function stepPriorityOnce(state: GameState): void {
	for (let guard = 0; guard < 20; guard++) {
		if (state.pendingPrompts.length > 0) return;
		const beforeLen = state.stack.length;
		const beforeTopId = state.stack[state.stack.length - 1]?.id;
		const beforePhase = state.phase;
		const pid = state.players[state.priorityPlayerIndex].playerId;
		const res = applyGameAction(state, pid, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
		if (state.pendingPrompts.length > 0) return;
		const afterTopId = state.stack[state.stack.length - 1]?.id;
		if (
			state.stack.length !== beforeLen ||
			afterTopId !== beforeTopId ||
			state.phase !== beforePhase
		) {
			return;
		}
	}
}

function answerDefaultPrompt(pr: GameState['pendingPrompts'][number]): ChoiceAnswer {
	if (pr.choice?.kind === 'orderObjects') {
		return { kind: 'orderObjects', topIds: pr.choice.objectIds };
	}
	if (pr.choice?.kind === 'chooseObjects') {
		return {
			kind: 'chooseObjects',
			objectIds: pr.choice.candidates.slice(0, pr.choice.min)
		};
	}
	return { kind: 'yesNo', yes: false };
}

function drainStack(state: GameState): void {
	for (let guard = 0; guard < 40 && (state.stack.length > 0 || state.pendingPrompts.length > 0); guard++) {
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			assert.equal(
				pr.choice?.kind,
				'orderObjects',
				`Unexpected pending prompt while draining stack: ${pr.title} (${pr.choice?.kind})`
			);
			assert.equal(
				applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'orderObjects', topIds: pr.choice.objectIds }
				}).ok,
				true
			);
			continue;
		}
		stepPriorityOnce(state);
	}
	assert.equal(state.pendingPrompts.length, 0, 'Expected no pending prompts after draining stack');
	assert.equal(state.stack.length, 0, 'Expected stack to drain completely');
}

function advanceToPhase(state: GameState, targetPhase: GameState['phase']): void {
	for (let guard = 0; guard < 50 && state.phase !== targetPhase; guard++) {
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: answerDefaultPrompt(pr)
				}).ok,
				true
			);
			continue;
		}
		const pid = state.players[state.priorityPlayerIndex].playerId;
		assert.equal(applyGameAction(state, pid, { type: 'pass_priority' }).ok, true);
	}
	assert.equal(state.phase, targetPhase, `Expected phase ${targetPhase}, got ${state.phase}`);
}

function advanceToNextTurnMain1(state: GameState): void {
	const startSerial = state.turnSerial ?? 0;
	for (let guard = 0; guard < 60; guard++) {
		if (
			(state.turnSerial ?? 0) > startSerial &&
			state.phase === 'main1' &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0
		) {
			break;
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: answerDefaultPrompt(pr)
				}).ok,
				true
			);
			continue;
		}
		const pid = state.players[state.priorityPlayerIndex].playerId;
		assert.equal(applyGameAction(state, pid, { type: 'pass_priority' }).ok, true);
	}
	assert.ok((state.turnSerial ?? 0) > startSerial, 'Expected turnSerial to advance');
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 30, U: 30, B: 30, R: 30, G: 30, C: 30 };
	}
}

describe('Track F Slice 3: Coercive Hand Reveal & Chosen Discard + Per-Turn / Batch Triggers', () => {
	it('compiles COMPILER_VERSION 33 and reveals opponent hand, sanitizes viewer visibility, discards chosen card, clears knownToPlayerIds on zone change/shuffle, and executes trailing life loss (CR 701.9, 701.20, 400.7)', () => {
		assert.equal(COMPILER_VERSION, 33);
		const state = setupGame();
		const [alice, bob] = state.players;
		bob.hand = [];

		const bobLand = put(
			state,
			bob,
			synthCard({
				name: 'Obsidian Flats',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land'
			}),
			'hand'
		);
		const bobCreature = put(
			state,
			bob,
			synthCard({
				name: 'Cinder Stalker',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Hound',
				power: '2',
				toughness: '2'
			}),
			'hand'
		);
		const bobArtifact = put(
			state,
			bob,
			synthCard({
				name: 'Gilded Dynamo Core',
				manaCost: '{5}',
				cmc: 5,
				typeLine: 'Artifact'
			}),
			'hand'
		);

		// Watcher for CardDiscarded event
		put(
			state,
			alice,
			synthCard({
				name: 'Megrim Resonator',
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: 'Whenever an opponent discards a card, you gain 3 life.'
			}),
			'battlefield'
		);

		const mindProbe = synthCard({
			name: 'Mindrip Extraction',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText:
				'Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.'
		});
		const compiled = compileCard(mindProbe);
		assert.equal(compiled.fullySupported, true);
		const probeInst = put(state, alice, mindProbe, 'hand');

		const castRes = applyGameAction(state, alice.playerId, {
			type: 'cast_spell',
			instanceId: probeInst.instanceId,
			targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
		});
		assert.equal(castRes.ok, true, castRes.error ?? 'cast_spell failed');

		// Pass priority so Mindrip Extraction resolves up to the human chooseObjects prompt
		stepPriorityOnce(state);
		assert.equal(state.pendingPrompts.length, 1);
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt.playerId, alice.playerId);
		assert.equal(prompt.choice?.kind, 'chooseObjects');
		assert.equal(prompt.choice.zone, 'hand');
		assert.equal(prompt.choice.min, 1);
		assert.equal(prompt.choice.max, 1);
		assert.deepEqual(
			prompt.choice.candidates.sort(),
			[bobCreature.instanceId, bobArtifact.instanceId].sort(),
			'Only nonland cards in Bob hand are legal candidates'
		);

		// All 3 cards in Bob's hand were revealed (including the Land)
		for (const c of bob.hand) {
			assert.ok(c.knownToPlayerIds?.includes(alice.playerId));
			assert.ok(c.knownToPlayerIds?.includes(bob.playerId));
		}

		// Viewer sanitization: Alice sees all 3 revealed cards and handCount === 3; spectator sees 0 cards and handCount === 3
		const aliceView = sanitizeGameStateForViewer(state, alice.playerId);
		const bobInAliceView = aliceView.players[1];
		assert.equal(bobInAliceView.handCount, 3);
		assert.equal(bobInAliceView.hand.length, 3);

		const specView = sanitizeGameStateForViewer(state, null);
		const bobInSpecView = specView.players[1];
		assert.equal(bobInSpecView.handCount, 3);
		assert.equal(bobInSpecView.hand.length, 0);

		// Alice chooses Gilded Dynamo Core
		const chooseRes = applyGameAction(state, alice.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseObjects', objectIds: [bobArtifact.instanceId] }
		});
		assert.equal(chooseRes.ok, true, chooseRes.error ?? 'choice failed');

		// Gilded Dynamo Core moved to Bob's graveyard; knownToPlayerIds cleared on zone change (CR 400.7)
		assert.ok(bob.graveyard.some((c) => c.instanceId === bobArtifact.instanceId));
		assert.equal(bobArtifact.knownToPlayerIds, undefined);
		// Remaining 2 cards in Bob's hand stay known to Alice
		assert.equal(bob.hand.length, 2);
		assert.ok(bobLand.knownToPlayerIds?.includes(alice.playerId));
		assert.ok(bobCreature.knownToPlayerIds?.includes(alice.playerId));

		// Trailing "You lose 2 life." already ran (40 -> 38), and discard trigger is on the stack (+3 -> 41)
		assert.equal(alice.life, 38);
		drainStack(state);
		assert.equal(alice.life, 41);

		// Post-resolution viewer sanitization still shows the 2 remaining revealed cards in Bob's hand,
		// while an unrevealed newly drawn card stays hidden while handCount === 3!
		const secretCard = put(
			state,
			bob,
			synthCard({ name: 'Unrevealed Topdeck', manaCost: '{2}', cmc: 2 }),
			'hand'
		);
		assert.equal(secretCard.knownToPlayerIds, undefined);
		const alicePostView = sanitizeGameStateForViewer(state, alice.playerId);
		assert.equal(alicePostView.players[1].handCount, 3);
		assert.equal(alicePostView.players[1].hand.length, 2);

		// CR 701.20d: Shuffling clears knownToPlayerIds on shuffled library cards
		moveObject(state, bobLand, 'library', {
			from: { player: bob, zone: 'hand' },
			toPlayer: bob,
			insert: 'start'
		});
		bob.library[0].knownToPlayerIds = [alice.playerId];
		shuffleLibrary(state, bob);
		assert.ok(bob.library.every((c) => c.knownToPlayerIds === undefined));
	});

	it('handles empty-match coercive discard (all-Lands hand & MV-filtered miss) without hanging and still executes trailing steps', () => {
		const state = setupGame();
		const [alice, bob] = state.players;
		bob.hand = [];

		const land1 = put(
			state,
			bob,
			synthCard({ name: 'Basalt Mire', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'hand'
		);
		const land2 = put(
			state,
			bob,
			synthCard({ name: 'Salt Crag', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'hand'
		);

		const mindProbe = synthCard({
			name: 'Void Audit',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText:
				'Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.'
		});
		const probeInst = put(state, alice, mindProbe, 'hand');

		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: probeInst.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		stepPriorityOnce(state);

		// Hand was revealed, 0 nonland matches -> no prompt queued, 0 cards discarded, Alice still lost 2 life!
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(state.stack.length, 0);
		assert.equal(bob.hand.length, 2);
		assert.ok(land1.knownToPlayerIds?.includes(alice.playerId));
		assert.ok(land2.knownToPlayerIds?.includes(alice.playerId));
		assert.equal(alice.life, 38);

		// MV <= 3 coercive filter miss against a 6-MV threat, then hit against a 3-MV card
		const bigThreat = put(
			state,
			bob,
			synthCard({
				name: 'Colossal Dreadbeast',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Creature — Beast',
				power: '6',
				toughness: '6'
			}),
			'hand'
		);
		const mvProbeCard = synthCard({
			name: 'Minor Inquisition',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText:
				'Target player reveals their hand. You choose a nonland card with mana value 3 or less from it. That player discards that card.'
		});
		assert.equal(compileCard(mvProbeCard).fullySupported, true);
		const missInst = put(state, alice, mvProbeCard, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: missInst.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		stepPriorityOnce(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.ok(bob.hand.some((c) => c.instanceId === bigThreat.instanceId));

		const smallSpell = put(
			state,
			bob,
			synthCard({
				name: 'Quick Bolt',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to any target.'
			}),
			'hand'
		);
		const hitInst = put(state, alice, mvProbeCard, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: hitInst.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		stepPriorityOnce(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.deepEqual(state.pendingPrompts[0].choice?.kind === 'chooseObjects' ? state.pendingPrompts[0].choice.candidates : [], [
			smallSpell.instanceId
		]);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [smallSpell.instanceId] }
			}).ok,
			true
		);
		assert.ok(bob.graveyard.some((c) => c.instanceId === smallSpell.instanceId));
	});

	it('executes ETB coercive discard, coercive exile + newline token creation, optional "If you do / If you don\'t" branches, and bot threat selection', () => {
		const state = setupGame();
		const [alice, bob] = state.players;
		bob.hand = [];

		const bobSpell = put(
			state,
			bob,
			synthCard({
				name: 'Arcane Tome',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact'
			}),
			'hand'
		);
		const bobCreature = put(
			state,
			bob,
			synthCard({
				name: 'Iron Vanguard',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Creature — Knight',
				power: '3',
				toughness: '3'
			}),
			'hand'
		);

		// 3a. ETB coercive discard creature
		const etbSpecter = synthCard({
			name: 'Hollow Wraithling',
			manaCost: '{2}{B}{B}',
			cmc: 4,
			typeLine: 'Creature — Avatar Horror',
			power: '3',
			toughness: '2',
			oracleText:
				'When ~ enters, target opponent reveals their hand. You choose a nonland card from it. That player discards that card.'
		});
		assert.equal(compileCard(etbSpecter).fullySupported, true);
		const specterInst = put(state, alice, etbSpecter, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: specterInst.instanceId
			}).ok,
			true
		);
		// Resolve creature spell -> ETB trigger targets Bob (only opponent) or prompts for target
		stepPriorityOnce(state);
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].choice?.kind === 'chooseObjects' && state.pendingPrompts[0].choice.zone !== 'hand') {
			const tPr = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, alice.playerId, {
					type: 'choice',
					promptId: tPr.id,
					answer: { kind: 'chooseObjects', objectIds: [bob.playerId] }
				}).ok,
				true
			);
		}
		// Resolve ETB trigger up to hand choice
		stepPriorityOnce(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [bobCreature.instanceId] }
			}).ok,
			true
		);
		assert.ok(bob.graveyard.some((c) => c.instanceId === bobCreature.instanceId));

		// 3b. Coercive exile + newline token creation (does NOT fire CardDiscarded)
		put(
			state,
			alice,
			synthCard({
				name: 'Discard Auditor',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Enchantment',
				oracleText: 'Whenever an opponent discards a card, you gain 5 life.'
			}),
			'battlefield'
		);
		const lifeBeforeExile = alice.life;
		const exileCaress = synthCard({
			name: 'Vault Extraction',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText:
				'Target opponent reveals their hand. You choose a noncreature, nonland card from it. Exile that card.\nCreate a Treasure token.'
		});
		assert.equal(compileCard(exileCaress).fullySupported, true);
		const exileInst = put(state, alice, exileCaress, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: exileInst.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		stepPriorityOnce(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [bobSpell.instanceId] }
			}).ok,
			true
		);
		assert.ok(bob.exile.some((c) => c.instanceId === bobSpell.instanceId));
		assert.ok(alice.battlefield.some((c) => c.isToken && c.card.typeLine.includes('Treasure')));
		assert.equal(alice.life, lifeBeforeExile, 'Exiling from hand is not a discard event');

		// 3c. Optional choice + "If you do / If you don't"
		const bobWalker = put(
			state,
			bob,
			synthCard({
				name: 'Aether Envoy',
				manaCost: '{3}{U}',
				cmc: 4,
				typeLine: 'Legendary Planeswalker — Envoy',
				loyalty: '4'
			}),
			'hand'
		);
		const optionalProbe = synthCard({
			name: 'Merciful Scrutiny',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText:
				"Target opponent reveals their hand. You may choose a creature or planeswalker card from it. If you do, that player discards that card. If you do, you gain 2 life. If you don't, draw a card."
		});
		assert.equal(compileCard(optionalProbe).fullySupported, true);

		// Decline first: min === 0, objectIds: [] -> draws a card, does not gain 2 life
		const handCountBeforeDecline = alice.hand.length;
		const declineInst = put(state, alice, optionalProbe, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: declineInst.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		stepPriorityOnce(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].choice?.kind === 'chooseObjects' ? state.pendingPrompts[0].choice.min : -1, 0);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [] }
			}).ok,
			true
		);
		assert.ok(bob.hand.some((c) => c.instanceId === bobWalker.instanceId));
		assert.equal(alice.life, lifeBeforeExile);
		assert.equal(alice.hand.length, handCountBeforeDecline + 1);

		// Accept second: chooses bobWalker -> Bob discards (+5 from Discard Auditor, +2 from If you do)
		const handCountBeforeAccept = alice.hand.length;
		const acceptInst = put(state, alice, optionalProbe, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: acceptInst.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		stepPriorityOnce(state);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [bobWalker.instanceId] }
			}).ok,
			true
		);
		drainStack(state);
		assert.ok(bob.graveyard.some((c) => c.instanceId === bobWalker.instanceId));
		assert.equal(alice.hand.length, handCountBeforeAccept, 'Did not draw on accept branch');
		assert.equal(alice.life, lifeBeforeExile + 7);

		// 3d. Bot threat selection: bot caster picks highest-MV nonland over land and low-MV card
		const botState = setupGame([true, false]);
		const [botCaster, humanTarget] = botState.players;
		humanTarget.hand = [];
		const hLand = put(
			botState,
			humanTarget,
			synthCard({ name: 'Quiet Meadow', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'hand'
		);
		const hSmall = put(
			botState,
			humanTarget,
			synthCard({
				name: 'Tiny Scout',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1'
			}),
			'hand'
		);
		const hBig = put(
			botState,
			humanTarget,
			synthCard({
				name: 'Apex Sovereign',
				manaCost: '{5}{R}{R}',
				cmc: 7,
				typeLine: 'Creature — Dragon',
				power: '7',
				toughness: '7'
			}),
			'hand'
		);
		const anyCardProbe = synthCard({
			name: 'Total Mindwipe',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText:
				'Target opponent reveals their hand and you choose a card from it. That player discards that card.'
		});
		assert.equal(compileCard(anyCardProbe).fullySupported, true);
		const botSpell = put(botState, botCaster, anyCardProbe, 'hand');
		assert.equal(
			applyGameAction(botState, botCaster.playerId, {
				type: 'cast_spell',
				instanceId: botSpell.instanceId,
				targets: [{ kind: 'player', id: humanTarget.playerId, label: humanTarget.username }]
			}).ok,
			true
		);
		drainStack(botState);
		assert.ok(
			humanTarget.graveyard.some((c) => c.instanceId === hBig.instanceId),
			'Bot must pick highest-MV nonland threat from opponent hand'
		);
		assert.ok(humanTarget.hand.some((c) => c.instanceId === hLand.instanceId));
		assert.ok(humanTarget.hand.some((c) => c.instanceId === hSmall.instanceId));
	});

	it('triggers on per-turn second card drawn ("your second card" and "an opponent draws their second card") and resets each turn', () => {
		const state = setupGame();
		const [alice, bob] = state.players;

		const selfSecondDraw = synthCard({
			name: 'Chronicle Scribe',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Cleric',
			power: '1',
			toughness: '3',
			oracleText:
				'Whenever you draw your second card each turn, create a 1/1 white Soldier creature token.'
		});
		const oppSecondDraw = synthCard({
			name: 'Taxing Sentinel',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Creature — Horror',
			power: '2',
			toughness: '4',
			oracleText:
				'Whenever an opponent draws their second card each turn, ~ deals 2 damage to that player.'
		});
		assert.equal(compileCard(selfSecondDraw).fullySupported, true);
		assert.equal(compileCard(oppSecondDraw).fullySupported, true);
		put(state, alice, selfSecondDraw, 'battlefield');
		put(state, alice, oppSecondDraw, 'battlefield');

		// Turn 1: Alice has drawn 0 cards so far (opening hand was pre-turn; Turn 1 draw step skipped in 2p? No, Commander multiplayer skips or draws — let's check cardsDrawnThisTurn!)
		// Reset cardsDrawnThisTurn = 0 explicitly? Better: read actual cardsDrawnThisTurn from Turn 1!
		// Wait: in 2-player Commander / setupGame, let's check whether Alice drew 1 card in Turn 1 draw step!
		const initialAliceDraws = alice.cardsDrawnThisTurn ?? 0;
		const countSoldiers = () =>
			alice.battlefield.filter((c) => c.isToken && c.card.typeLine.includes('Soldier')).length;

		const cantrip = synthCard({
			name: 'Quick Study',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Draw a card.'
		});
		const drawTwo = synthCard({
			name: 'Deep Counsel',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText: 'Draw two cards.'
		});

		if (initialAliceDraws === 0) {
			// 1st draw this turn -> does NOT trigger
			const c1 = put(state, alice, cantrip, 'hand');
			assert.equal(applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: c1.instanceId }).ok, true);
			drainStack(state);
			assert.equal(alice.cardsDrawnThisTurn, 1);
			assert.equal(countSoldiers(), 0);
		} else {
			assert.equal(initialAliceDraws, 1);
			assert.equal(countSoldiers(), 0);
		}

		// Drawing two more cards (reaching 2nd and 3rd cards drawn this turn) -> triggers ONCE on 2nd, NOT on 3rd!
		const d2 = put(state, alice, drawTwo, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: d2.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.cardsDrawnThisTurn, 3);
		assert.equal(countSoldiers(), 1);

		// Bob draws 1st card on Turn 1 -> 0 damage; draws 2nd & 3rd -> takes 2 damage ONCE!
		const targetDrawOne = synthCard({
			name: 'Gift of Insight',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Target player draws a card.'
		});
		const targetDrawTwo = synthCard({
			name: 'Overflowing Lore',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText: 'Target player draws two cards.'
		});
		const g1 = put(state, alice, targetDrawOne, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: g1.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(bob.cardsDrawnThisTurn, 1);
		assert.equal(bob.life, 40);

		const g2 = put(state, alice, targetDrawTwo, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: g2.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(bob.cardsDrawnThisTurn, 3);
		assert.equal(bob.life, 38);

		// Advance to Turn 2 (Bob's turn): counters reset at beginning of turn, Bob draws 1 in draw step,
		// then casts cantrip (his 2nd card of Turn 2) -> Taxing Sentinel deals 2 more damage (38 -> 36)!
		advanceToNextTurnMain1(state);
		assert.equal(alice.cardsDrawnThisTurn, 0);
		assert.equal(bob.cardsDrawnThisTurn, 1);
		assert.equal(bob.life, 38);

		const bobCantrip = put(state, bob, cantrip, 'hand');
		assert.equal(
			applyGameAction(state, bob.playerId, { type: 'cast_spell', instanceId: bobCantrip.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(bob.cardsDrawnThisTurn, 2);
		assert.equal(bob.life, 36);
	});

	it('triggers on per-turn second spell cast, ignores copied spells (SpellCopied), does not fire on 1st or 3rd, and resets next turn', () => {
		const state = setupGame();
		const [alice, bob] = state.players;

		const flurryMage = synthCard({
			name: 'Dualcast Scholar',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Human Wizard',
			power: '2',
			toughness: '2',
			oracleText: 'Whenever you cast your second spell each turn, draw a card.'
		});
		const oppWatcher = synthCard({
			name: 'Order Warder',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Spirit',
			power: '2',
			toughness: '2',
			oracleText: 'Whenever an opponent casts their second spell each turn, you gain 3 life.'
		});
		const spellCopier = synthCard({
			name: 'Echoing Conduit',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: '{T}: Copy target instant or sorcery spell.'
		});
		assert.equal(compileCard(flurryMage).fullySupported, true);
		assert.equal(compileCard(oppWatcher).fullySupported, true);
		assert.equal(compileCard(spellCopier).fullySupported, true);

		put(state, alice, flurryMage, 'battlefield');
		put(state, bob, oppWatcher, 'battlefield');
		const copierInst = put(state, alice, spellCopier, 'battlefield');

		const OptGain = synthCard({
			name: 'Spark of Vitality',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'You gain 1 life.'
		});

		const s1 = put(state, alice, OptGain, 'hand');
		const s2 = put(state, alice, OptGain, 'hand');
		const s3 = put(state, alice, OptGain, 'hand');
		const handBefore = alice.hand.length;

		// Cast Spell #1 and copy it via Echoing Conduit -> SpellCopied must NOT count as 2nd cast spell!
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok,
			true
		);
		const stackSpellId = state.stack[0].id;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'activate_ability',
				instanceId: copierInst.instanceId,
				abilityId: 'act_0',
				targets: [{ kind: 'stack', id: stackSpellId, label: OptGain.name }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.spellsCastThisTurn, 1);
		assert.equal(alice.hand.length, handBefore - 1, 'No 2nd-spell draw from copying 1st spell');
		assert.equal(bob.life, 40, 'Bob did not gain life on 1st spell + copy');

		// Cast Spell #2 -> BOTH Dualcast Scholar and Order Warder trigger ONCE!
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: s2.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.spellsCastThisTurn, 2);
		assert.equal(alice.hand.length, handBefore - 1, 'Drew 1 card replacing Spell #2');
		assert.equal(bob.life, 43);

		// Cast Spell #3 -> neither triggers!
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: s3.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.spellsCastThisTurn, 3);
		assert.equal(bob.life, 43);

		// Advance to next turn -> resets spellsCastThisTurn!
		advanceToNextTurnMain1(state);
		assert.equal(alice.spellsCastThisTurn, 0);
	});

	it('enforces "This ability triggers only once each turn." (CR 603.2i) against multipliers, resets on blink (CR 400.7) & next turn, respects intervening-if (CR 603.4), and keeps "Do this only once each turn." unsupported (CR 603.2h)', () => {
		// CR 603.2h guard: "Do this only once each turn." must remain unsupported
		const doOnceCard = synthCard({
			name: 'Reflexive Broker',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Advisor',
			power: '2',
			toughness: '2',
			oracleText: 'Whenever a creature you control enters, you may pay {1}. Do this only once each turn.'
		});
		assert.equal(compileCard(doOnceCard).fullySupported, false);

		const state = setupGame();
		const [alice] = state.players;

		const onceHealer = synthCard({
			name: 'Sanctuary Bellkeeper',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Cleric',
			power: '2',
			toughness: '2',
			oracleText:
				'Whenever another creature you control enters, you gain 2 life. This ability triggers only once each turn.'
		});
		const doubler = synthCard({
			name: 'Harmonic Pillar',
			manaCost: '{4}',
			cmc: 4,
			typeLine: 'Artifact',
			oracleText:
				'If a creature entering the battlefield causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'
		});
		const conditionalOnce = synthCard({
			name: 'Ascendant Archivist',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Angel',
			power: '2',
			toughness: '3',
			oracleText:
				'Whenever another creature you control enters, if you have 44 or more life, draw a card. This ability triggers only once each turn.'
		});
		assert.equal(compileCard(onceHealer).fullySupported, true);
		assert.equal(compileCard(doubler).fullySupported, true);
		assert.equal(compileCard(conditionalOnce).fullySupported, true);

		const keeperInst = put(state, alice, onceHealer, 'battlefield');
		put(state, alice, doubler, 'battlefield');
		put(state, alice, conditionalOnce, 'battlefield');

		const bear = synthCard({
			name: 'Moss Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		const bounce = synthCard({
			name: 'Vapor Recall',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: "Return target creature to its owner's hand."
		});

		// Bear #1 at 40 life:
		// - Sanctuary Bellkeeper triggers ONLY ONCE (not doubled by Harmonic Pillar, CR 603.2i) -> life 42!
		// - Ascendant Archivist intervening-if (life >= 44) is FALSE -> does NOT trigger and does NOT spend its once-per-turn!
		const b1 = put(state, alice, bear, 'hand');
		const b2 = put(state, alice, bear, 'hand');
		const b3 = put(state, alice, bear, 'hand');
		const b4 = put(state, alice, bear, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: b1.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.life, 42);

		// Bear #2 same turn: Sanctuary Bellkeeper is suppressed (stays 42)
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: b2.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.life, 42);

		// Bounce & re-cast Sanctuary Bellkeeper -> new objectVersion (CR 400.7) resets its once-per-turn!
		const bounceInst = put(state, alice, bounce, 'hand');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: bounceInst.instanceId,
				targets: [{ kind: 'permanent', id: keeperInst.instanceId, label: onceHealer.name }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: keeperInst.instanceId
			}).ok,
			true
		);
		drainStack(state);

		// Set life to 44 so Ascendant Archivist's intervening-if is now TRUE!
		alice.life = 44;
		const handBeforeB3 = alice.hand.length;
		// Bear #3 enters: re-cast Sanctuary Bellkeeper triggers (+2 -> 46) AND Ascendant Archivist triggers (draws 1, not doubled)!
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: b3.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.life, 46);
		assert.equal(alice.hand.length, handBeforeB3, 'Played b3 (-1) and Ascendant Archivist drew (+1)');

		// Bear #4 same turn: BOTH once-per-turn abilities are now spent for this turn!
		const handBeforeB4 = alice.hand.length;
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: b4.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.life, 46);
		assert.equal(alice.hand.length, handBeforeB4 - 1);

		// Advance to Alice's next turn -> both reset!
		advanceToNextTurnMain1(state); // Bob's turn
		advanceToNextTurnMain1(state); // Alice's turn
		const b5 = put(state, alice, bear, 'hand');
		const lifeStart = alice.life;
		assert.equal(
			applyGameAction(state, alice.playerId, { type: 'cast_spell', instanceId: b5.instanceId }).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.life, lifeStart + 2);

		// Look-back LTB suppression (CR 603.10a + CR 603.2i): if "Whenever ~ or another creature you control dies"
		// already triggered earlier this turn when another creature died, ~ itself dying later that turn must NOT trigger again!
		const onceMourner = synthCard({
			name: 'Elegy Cantor',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Spirit Cleric',
			power: '2',
			toughness: '2',
			oracleText:
				'Whenever ~ or another creature you control dies, you gain 2 life. This ability triggers only once each turn.'
		});
		const doomSpell = synthCard({
			name: 'Void Sever',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});
		assert.equal(compileCard(onceMourner).fullySupported, true);
		alice.manaPool = { W: 30, U: 30, B: 30, R: 30, G: 30, C: 30 };
		const mournerInst = put(state, alice, onceMourner, 'battlefield');
		const d1 = put(state, alice, doomSpell, 'hand');
		const d2 = put(state, alice, doomSpell, 'hand');
		const lifeBeforeDeaths = alice.life;
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: d1.instanceId,
				targets: [{ kind: 'permanent', id: b5.instanceId, label: bear.name }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(alice.life, lifeBeforeDeaths + 2, 'First death triggers Elegy Cantor once');

		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: d2.instanceId,
				targets: [{ kind: 'permanent', id: mournerInst.instanceId, label: onceMourner.name }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(
			alice.life,
			lifeBeforeDeaths + 2,
			'Elegy Cantor itself dying later same turn must not fire look-back dies trigger a second time'
		);
	});

	it('fires batch combat damage to a player once per damaged player per combat damage step (CR 603.2c, CR 510.4) and 0 times when prevented', () => {
		// 7a. 3 simultaneous unblocked creatures -> 1 draw (not 3)
		const state = setupGame();
		const [alice, bob] = state.players;

		const batchRaider = synthCard({
			name: 'Pack Tactician',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Enchantment',
			oracleText: 'Whenever one or more creatures you control deal combat damage to a player, draw a card.'
		});
		assert.equal(compileCard(batchRaider).fullySupported, true);
		put(state, alice, batchRaider, 'battlefield');

		const wolf = synthCard({
			name: 'Swift Wolf',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Wolf',
			power: '2',
			toughness: '2'
		});
		const w1 = put(state, alice, wolf, 'battlefield');
		const w2 = put(state, alice, wolf, 'battlefield');
		const w3 = put(state, alice, wolf, 'battlefield');

		const handBeforeCombat = alice.hand.length;
		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: w1.instanceId, defenderPlayerId: bob.playerId },
					{ attackerInstanceId: w2.instanceId, defenderPlayerId: bob.playerId },
					{ attackerInstanceId: w3.instanceId, defenderPlayerId: bob.playerId }
				]
			}).ok,
			true
		);
		advanceToPhase(state, 'declare_blockers');
		assert.equal(
			applyGameAction(state, bob.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		advanceToPhase(state, 'main2');
		assert.equal(bob.life, 34);
		assert.equal(alice.hand.length, handBeforeCombat + 1, '3 simultaneous attackers must trigger batch once');

		// 7b. First strike + normal combat damage -> triggers TWICE (once per combat damage step, CR 510.4)
		const stateFs = setupGame();
		const [aliceFs, bobFs] = stateFs.players;
		put(stateFs, aliceFs, batchRaider, 'battlefield');
		const fsKnight = put(
			stateFs,
			aliceFs,
			synthCard({
				name: 'Lancer Vanguard',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Knight',
				power: '2',
				toughness: '2',
				oracleText: 'First strike',
				keywords: ['First strike']
			}),
			'battlefield'
		);
		const normalWolf = put(stateFs, aliceFs, wolf, 'battlefield');
		const fsHandBefore = aliceFs.hand.length;

		advanceToPhase(stateFs, 'declare_attackers');
		assert.equal(
			applyGameAction(stateFs, aliceFs.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: fsKnight.instanceId, defenderPlayerId: bobFs.playerId },
					{ attackerInstanceId: normalWolf.instanceId, defenderPlayerId: bobFs.playerId }
				]
			}).ok,
			true
		);
		advanceToPhase(stateFs, 'declare_blockers');
		assert.equal(
			applyGameAction(stateFs, bobFs.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		advanceToPhase(stateFs, 'main2');
		assert.equal(bobFs.life, 36);
		assert.equal(aliceFs.hand.length, fsHandBefore + 2, 'First strike + normal damage steps trigger twice');

		// 7c. 3-player pod: attacking two different opponents -> 1 trigger per damaged opponent + "deal combat damage to you"
		const stateMp = setupGame([false, false, false]);
		const [aliceMp, bobMp, carolMp] = stateMp.players;
		const oppPingBatch = synthCard({
			name: 'Raid Warlord',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Creature — Orc Warrior',
			power: '2',
			toughness: '3',
			oracleText:
				'Whenever one or more creatures you control deal combat damage to an opponent, ~ deals 1 damage to that player.'
		});
		const selfHitBatch = synthCard({
			name: 'Bastion Medic',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: 'Whenever one or more creatures deal combat damage to you, you gain 1 life.'
		});
		assert.equal(compileCard(oppPingBatch).fullySupported, true);
		assert.equal(compileCard(selfHitBatch).fullySupported, true);
		put(stateMp, aliceMp, oppPingBatch, 'battlefield');
		put(stateMp, bobMp, selfHitBatch, 'battlefield');

		const m1 = put(stateMp, aliceMp, wolf, 'battlefield');
		const m2 = put(stateMp, aliceMp, wolf, 'battlefield');
		const m3 = put(stateMp, aliceMp, wolf, 'battlefield');

		advanceToPhase(stateMp, 'declare_attackers');
		assert.equal(
			applyGameAction(stateMp, aliceMp.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: m1.instanceId, defenderPlayerId: bobMp.playerId },
					{ attackerInstanceId: m2.instanceId, defenderPlayerId: bobMp.playerId },
					{ attackerInstanceId: m3.instanceId, defenderPlayerId: carolMp.playerId }
				]
			}).ok,
			true
		);
		advanceToPhase(stateMp, 'declare_blockers');
		assert.equal(
			applyGameAction(stateMp, bobMp.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		assert.equal(
			applyGameAction(stateMp, carolMp.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		advanceToPhase(stateMp, 'main2');
		// Bob took 4 combat damage (-4) + 1 Raid Warlord ping (-1) + 1 Bastion Medic gain (+1) = 36!
		// Carol took 2 combat damage (-2) + 1 Raid Warlord ping (-1) = 37!
		assert.equal(bobMp.life, 36);
		assert.equal(carolMp.life, 37);

		// 7d. Prevented combat damage (protectionFromEverything -> dealt === 0) -> 0 batch triggers!
		const statePrev = setupGame();
		const [alicePrev, bobPrev] = statePrev.players;
		put(statePrev, alicePrev, batchRaider, 'battlefield');
		const pWolf = put(statePrev, alicePrev, wolf, 'battlefield');
		const shieldSpell = put(
			statePrev,
			bobPrev,
			synthCard({
				name: 'Sanctuary Veil',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText:
					"Until your next turn, your life total can't change and you gain protection from everything."
			}),
			'hand'
		);
		const prevHandBefore = alicePrev.hand.length;
		advanceToPhase(statePrev, 'declare_attackers');
		assert.equal(
			applyGameAction(statePrev, alicePrev.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: pWolf.instanceId, defenderPlayerId: bobPrev.playerId }]
			}).ok,
			true
		);
		advanceToPhase(statePrev, 'declare_blockers');
		assert.equal(
			applyGameAction(statePrev, bobPrev.playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		// Bob casts Sanctuary Veil before combat damage! (Refill mana after step transitions per CR 500.5)
		for (let guard = 0; guard < 10 && statePrev.players[statePrev.priorityPlayerIndex].playerId !== bobPrev.playerId; guard++) {
			assert.equal(
				applyGameAction(statePrev, statePrev.players[statePrev.priorityPlayerIndex].playerId, {
					type: 'pass_priority'
				}).ok,
				true
			);
		}
		bobPrev.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		assert.equal(
			applyGameAction(statePrev, bobPrev.playerId, {
				type: 'cast_spell',
				instanceId: shieldSpell.instanceId
			}).ok,
			true
		);
		advanceToPhase(statePrev, 'main2');
		assert.equal(bobPrev.life, 40);
		assert.equal(alicePrev.hand.length, prevHandBefore, 'Prevented combat damage (0 dealt) must not trigger batch');
	});

	it('survives JSON.parse(JSON.stringify(state)) mid-prompt during coercive hand reveal & choice', () => {
		const state = setupGame();
		const [alice, bob] = state.players;
		bob.hand = [];
		const targetCard = put(
			state,
			bob,
			synthCard({
				name: 'Relic Scepter',
				manaCost: '{4}',
				cmc: 4,
				typeLine: 'Artifact'
			}),
			'hand'
		);
		const probe = put(
			state,
			alice,
			synthCard({
				name: 'Serialized Thoughtprobe',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText:
					'Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, alice.playerId, {
				type: 'cast_spell',
				instanceId: probe.instanceId,
				targets: [{ kind: 'player', id: bob.playerId, label: bob.username }]
			}).ok,
			true
		);
		stepPriorityOnce(state);
		assert.equal(state.pendingPrompts.length, 1);

		const restored: GameState = JSON.parse(JSON.stringify(state));
		const pr = restored.pendingPrompts[0];
		const res = applyGameAction(restored, alice.playerId, {
			type: 'choice',
			promptId: pr.id,
			answer: { kind: 'chooseObjects', objectIds: [targetCard.instanceId] }
		});
		assert.equal(res.ok, true, res.error ?? 'choice failed');
		assert.equal(restored.stack.length, 0);
		assert.ok(restored.players[1].graveyard.some((c) => c.instanceId === targetCard.instanceId));
		assert.equal(restored.players[0].life, 38);
	});

	it('preserves rename invariance across all Track F Slice 3 templates', () => {
		const templates: Array<Omit<Partial<ScryfallCard>, 'name'> & { oracleText: string }> = [
			{
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText:
					'Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.'
			},
			{
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Target opponent reveals their hand. You may choose a creature or planeswalker card from it. If you do, exile that card.'
			},
			{
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Wizard',
				power: '2',
				toughness: '2',
				oracleText:
					'Whenever you draw your second card each turn, draw a card. This ability triggers only once each turn.'
			},
			{
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Creature — Warrior',
				power: '3',
				toughness: '2',
				oracleText:
					'Whenever you cast your second spell each turn, ~ deals 2 damage to each opponent.'
			},
			{
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText:
					'Whenever one or more creatures you control deal combat damage to one of your opponents, draw a card.'
			}
		];

		const canonicalNames = [
			'Thoughtseize',
			'Deceitful Extraction',
			'Faerie Vandal',
			'Pyromancer Veteran',
			'Grazilaxx Raider'
		];
		for (let i = 0; i < templates.length; i++) {
			const t = templates[i];
			const canonicalText = t.oracleText.replace(/~/g, canonicalNames[i]);
			const synthName = `Glimmerfen Overseer ${i}`;
			const synthText = t.oracleText.replace(/~/g, synthName);
			const cCanon = compileCard(synthCard({ ...t, name: canonicalNames[i], oracleText: canonicalText }));
			const cSynth = compileCard(synthCard({ ...t, name: synthName, oracleText: synthText }));
			assert.equal(cCanon.fullySupported, true, `Canonical ${canonicalNames[i]} must be fullySupported`);
			assert.equal(cSynth.fullySupported, true, `Synthetic ${synthName} must be fullySupported`);
			assert.deepEqual(cCanon.faces[0].abilities, cSynth.faces[0].abilities);
		}
	});
});
