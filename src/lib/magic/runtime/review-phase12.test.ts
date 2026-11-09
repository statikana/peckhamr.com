import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as choicesMod from './choices.ts';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	drawCards,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { withStackItemText } from '../oracle.ts';
import {
	DEFAULT_LOBBY_RULES,
	ENGINE_VERSION,
	type CardInstance,
	type ChoiceKind,
	type ChoiceRequest,
	type GameState,
	type LobbySeat,
	type MagicLobby,
	type PendingPrompt,
	type PromptPurpose,
	type ScryfallCard
} from '../types.ts';
import * as engineMod from '../engine.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{W}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Creature — Human Soldier',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['W'],
		colorIdentity: overrides.colorIdentity ?? ['W'],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: false,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function makeTwoPlayerGame(): GameState {
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: PRECON_DECKS[0].id,
			deckName: PRECON_DECKS[0].name,
			commanderNames: PRECON_DECKS[0].commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[0].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: false,
			deckId: PRECON_DECKS[1].id,
			deckName: PRECON_DECKS[1].name,
			commanderNames: PRECON_DECKS[1].commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[1].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	return createInitialGameState(
		'REV12',
		seats,
		new Map([
			[0, PRECON_DECKS[0]],
			[1, PRECON_DECKS[1]]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
}

describe('Phase 1 (§2.1 + §2.2): Secret stripping and opponent prompt redaction', () => {
	it('strips rngState, nextUid, and idSalt from the viewer copy without mutating the original state', () => {
		const state = makeTwoPlayerGame();
		state.idSalt = 987654321;
		const origRng = state.rngState;
		const origUid = state.nextUid;
		assert.equal(typeof origRng, 'number');
		assert.equal(typeof origUid, 'number');

		const viewP1 = sanitizeGameStateForViewer(state, 'p1');
		assert.equal(viewP1.rngState, undefined, 'rngState must be stripped for active player');
		assert.equal(viewP1.nextUid, undefined, 'nextUid must be stripped for active player');
		assert.equal(viewP1.idSalt, undefined, 'idSalt must be stripped for active player');
		assert.equal('rngState' in viewP1, false);
		assert.equal('nextUid' in viewP1, false);
		assert.equal('idSalt' in viewP1, false);

		const viewNull = sanitizeGameStateForViewer(state, null);
		assert.equal('rngState' in viewNull, false);
		assert.equal('nextUid' in viewNull, false);
		assert.equal('idSalt' in viewNull, false);

		// Original state must remain intact
		assert.equal(state.rngState, origRng);
		assert.equal(state.nextUid, origUid);
		assert.equal(state.idSalt, 987654321);
	});

	it('redacts P1 london_bottom prompt in P2 sanitized view so no hand card IDs leak', () => {
		const state = makeTwoPlayerGame();
		state.rules.mulliganRule = 'london_1free';
		// P1 takes two mulligans (first is free in Commander, second requires bottoming 1 card)
		applyGameAction(state, 'p1', { type: 'mulligan_take' });
		applyGameAction(state, 'p1', { type: 'mulligan_take' });
		applyGameAction(state, 'p1', { type: 'mulligan_keep' });

		const rawPrompt = state.pendingPrompts.find(
			(pr) => pr.playerId === 'p1' && pr.purpose === 'london_bottom'
		);
		assert.ok(rawPrompt, 'P1 should have a pending london_bottom prompt');
		const p1HandIds = new Set(state.players[0].hand.map((c) => c.instanceId));
		assert.ok(p1HandIds.size > 0);

		const viewForP2 = sanitizeGameStateForViewer(state, 'p2');
		const p2SeenPrompt = viewForP2.pendingPrompts.find((pr) => pr.playerId === 'p1');
		assert.ok(p2SeenPrompt, 'P2 still sees that P1 has a pending prompt');
		assert.equal(p2SeenPrompt.description, 'Opponent is choosing…');
		assert.equal(p2SeenPrompt.candidateInstanceIds, undefined);
		if (p2SeenPrompt.choice?.kind === 'chooseObjects') {
			assert.deepEqual(p2SeenPrompt.choice.candidates, []);
		}
		const serializedPrompt = JSON.stringify(p2SeenPrompt);
		for (const hid of p1HandIds) {
			assert.equal(
				serializedPrompt.includes(hid),
				false,
				`P2 sanitized prompt leaked P1 hand card ID ${hid}`
			);
		}

		// P1's own view still has the candidate hand IDs
		const viewForP1 = sanitizeGameStateForViewer(state, 'p1');
		const p1OwnPrompt = viewForP1.pendingPrompts.find((pr) => pr.playerId === 'p1');
		assert.ok(p1OwnPrompt);
		assert.equal(
			p1OwnPrompt.choice?.kind === 'chooseObjects' && p1OwnPrompt.choice.candidates.length,
			7
		);
	});

	it('redacts P1 search_library prompt and stack effectResume in P2 sanitized view so no library IDs leak', () => {
		const state = makeTwoPlayerGame();
		applyGameAction(state, 'p1', { type: 'mulligan_keep' });
		applyGameAction(state, 'p2', { type: 'mulligan_keep' });

		const p1 = state.players[0];
		const libIds = p1.library.slice(0, 5).map((c) => c.instanceId);
		state.pendingPrompts.push({
			id: 'prm_search_test',
			playerId: 'p1',
			targetLibraryOwnerId: 'p1',
			kind: 'search_library',
			purpose: 'search_library',
			title: 'Search Library',
			description: 'Choose a basic land card from your library.',
			destinationZone: 'hand',
			candidateInstanceIds: libIds,
			choice: {
				kind: 'chooseObjects',
				candidates: libIds,
				min: 0,
				max: 1,
				zone: 'library',
				reason: 'Choose a basic land card from your library.'
			}
		});
		// Also simulate a stack item with an effectResume frame holding hidden card IDs
		const dummyCard = makeCard({ name: 'Mind Rot' });
		state.stack.push(
			withStackItemText(
				{
					id: 'stk_pause_test',
					sourceInstanceId: libIds[0],
					card: dummyCard,
					controllerId: 'p1',
					kind: 'spell',
					title: 'Mind Rot',
					targets: [],
					xValue: 0,
					requiresGuidedResolution: false,
					createdAt: 0,
					effectResume: {
						stepIndex: 0,
						bindings: [],
						answers: { p1: [libIds[1], libIds[2]] }
					}
				},
				dummyCard
			)
		);

		const viewForP2 = sanitizeGameStateForViewer(state, 'p2');
		assert.equal(viewForP2.players[0].library.length, 0);
		const p2SeenPrompt = viewForP2.pendingPrompts.find((pr) => pr.id === 'prm_search_test');
		assert.ok(p2SeenPrompt);
		assert.equal(p2SeenPrompt.description, 'Opponent is choosing…');
		assert.equal(p2SeenPrompt.candidateInstanceIds, undefined);
		assert.equal(
			p2SeenPrompt.choice?.kind === 'chooseObjects' ? p2SeenPrompt.choice.candidates.length : -1,
			0
		);
		const promptJson = JSON.stringify(p2SeenPrompt);
		for (const lid of libIds) {
			assert.equal(
				promptJson.includes(lid),
				false,
				`P2 sanitized search_library prompt leaked library ID ${lid}`
			);
		}
		assert.equal(
			viewForP2.stack[0].effectResume,
			undefined,
			'stack item effectResume must be stripped in viewer state'
		);
	});

	it('does not log the private card name when a player draws a card or moves between hidden zones', () => {
		const state = makeTwoPlayerGame();
		applyGameAction(state, 'p1', { type: 'mulligan_keep' });
		const p1 = state.players[0];
		const topCardName = p1.library[0].card.name;
		const logBefore = state.log.length;

		// Keeping the final hand starts Turn 1 and executes P1's Turn 1 draw step
		applyGameAction(state, 'p2', { type: 'mulligan_keep' });
		drawCards(state, p1, 1);

		// Also test guided resolution moving a card from hand to library (hidden -> hidden)
		const handCard = p1.hand[0];
		state.pendingPrompts.push({
			id: 'prm_guided_hidden',
			playerId: 'p1',
			kind: 'guided_resolution',
			purpose: 'guided_resolution',
			title: 'Guided Action',
			description: 'Put a card from hand on library',
			choice: { kind: 'yesNo', question: 'Apply?' }
		});
		applyGameAction(state, 'p1', {
			type: 'choice',
			promptId: 'prm_guided_hidden',
			answer: { kind: 'yesNo', yes: true },
			operations: [
				{
					op: 'move_zone',
					targetId: handCard.instanceId,
					destinationZone: 'library'
				}
			]
		});

		const newLogs = state.log.slice(logBefore);
		assert.ok(newLogs.length > 0, 'Expected draw and move log entries');
		for (const entry of newLogs) {
			assert.equal(
				entry.text.includes(topCardName),
				false,
				`Draw log entry leaked private card name "${topCardName}": ${entry.text}`
			);
			assert.equal(
				entry.text.includes(handCard.card.name),
				false,
				`Hidden-zone move log entry leaked private card name "${handCard.card.name}": ${entry.text}`
			);
		}
	});
});

describe('Phase 1 (§2.3): Opaque instance IDs', () => {
	it('produces unrelated card instance IDs for two games with the same decklist and different seeds', () => {
		let seedIdx = 0;
		const seeds = [0.125, 0.875];
		mock.method(Math, 'random', () => seeds[seedIdx++ % seeds.length]);
		try {
			const g1 = makeTwoPlayerGame();
			const g2 = makeTwoPlayerGame();

			const g1Ids = new Set([
				...g1.players[0].command.map((c) => c.instanceId),
				...g1.players[0].hand.map((c) => c.instanceId),
				...g1.players[0].library.map((c) => c.instanceId)
			]);
			const g2Ids = new Set([
				...g2.players[0].command.map((c) => c.instanceId),
				...g2.players[0].hand.map((c) => c.instanceId),
				...g2.players[0].library.map((c) => c.instanceId)
			]);

			const overlap = [...g1Ids].filter((id) => g2Ids.has(id));
			assert.deepEqual(
				overlap,
				[],
				'Games with different seeds must not share card instance IDs'
			);
		} finally {
			mock.restoreAll();
		}
	});

	it('does not generate monotonic crd_1, crd_2, ... IDs in deck-list order', () => {
		const g = makeTwoPlayerGame();
		const allP1Cards = [
			...g.players[0].command,
			...g.players[0].hand,
			...g.players[0].library
		];
		const monotonicMatches = allP1Cards.filter((c) => /^(cmd|crd)_\d+$/.test(c.instanceId));
		assert.equal(
			monotonicMatches.length < allP1Cards.length / 2,
			true,
			'Instance IDs should be hashed base-36 strings rather than monotonic decimal counters'
		);
		assert.equal(
			allP1Cards.some((c) => c.instanceId === 'crd_1' || c.instanceId === 'crd_2'),
			false,
			'First cards must not have predictable crd_1 / crd_2 IDs'
		);
	});
});

describe('Phase 2 (§3): Engine-version gate (enforceEngineVersion)', () => {
	it('ends a game whose engineVersion is undefined (missing) in both enforceEngineVersion and applyGameAction', () => {
		const enforce = (engineMod as Record<string, unknown>).enforceEngineVersion as
			| ((s: GameState) => boolean)
			| undefined;
		assert.equal(typeof enforce, 'function', 'enforceEngineVersion must be exported from engine.ts');

		const state1 = makeTwoPlayerGame();
		delete (state1 as { engineVersion?: number }).engineVersion;
		const changed = enforce!(state1);
		assert.equal(changed, true);
		assert.equal(state1.status, 'finished');
		assert.ok(
			state1.log.some((l) => l.kind === 'system' && l.text.includes('engineVersion')),
			'Expected system log line when missing engineVersion ends the game'
		);

		// Also verify applyGameAction backstop catches missing engineVersion
		const state2 = makeTwoPlayerGame();
		delete (state2 as { engineVersion?: number }).engineVersion;
		const res = applyGameAction(state2, 'p1', { type: 'mulligan_keep' });
		assert.equal(res.ok, false);
		assert.equal(state2.status, 'finished');
	});

	it('ends a game with an old engineVersion once and does not duplicate log entries on repeated calls', () => {
		const enforce = (engineMod as Record<string, unknown>).enforceEngineVersion as
			| ((s: GameState) => boolean)
			| undefined;
		assert.equal(typeof enforce, 'function');

		const state = makeTwoPlayerGame();
		state.engineVersion = ENGINE_VERSION - 1;
		const logCountBefore = state.log.length;

		assert.equal(enforce!(state), true);
		assert.equal(state.status, 'finished');
		assert.equal(state.log.length, logCountBefore + 1);

		// Second call on already-finished state is a no-op
		assert.equal(enforce!(state), false);
		assert.equal(state.log.length, logCountBefore + 1);
	});

	it('transitions lobby status, bumps version, and triggers save in load -> enforceLobbyEngineVersion -> save flow', () => {
		const enforceLobby = (engineMod as Record<string, unknown>).enforceLobbyEngineVersion as
			| ((lobby: MagicLobby, now?: number) => boolean)
			| undefined;
		assert.equal(
			typeof enforceLobby,
			'function',
			'enforceLobbyEngineVersion must be exported from engine.ts'
		);

		const state = makeTwoPlayerGame();
		delete (state as { engineVersion?: number }).engineVersion;
		const lobby: MagicLobby = {
			code: 'REV12',
			name: 'Test Pod',
			hostUserId: 'p1',
			status: 'active',
			isPrivate: true,
			rules: { ...DEFAULT_LOBBY_RULES },
			seats: [],
			gameState: state,
			version: 5,
			createdAt: 1000,
			updatedAt: 1000
		};

		let savedLobby: MagicLobby | null = null;
		const changed = enforceLobby!(lobby, 2000);
		if (changed) {
			savedLobby = JSON.parse(JSON.stringify(lobby));
		}

		assert.equal(changed, true);
		assert.ok(savedLobby, 'Incompatible lobby must be saved when loaded');
		assert.equal(savedLobby.status, 'finished');
		assert.equal(savedLobby.gameState?.status, 'finished');
		assert.equal(savedLobby.version, 6);
		assert.equal(savedLobby.updatedAt, 2000);
	});
});

describe('Phase 5 (§6): ChoiceSpec and PromptPurpose exhaustiveness guards (#2)', () => {
	it('exports ChoiceKind exhaustiveness guard and renders all 6 ChoiceKind branches in ArenaTable.svelte', () => {
		const allKinds = (choicesMod as Record<string, unknown>).ALL_CHOICE_KINDS as
			| readonly ChoiceKind[]
			| undefined;
		const checkKind = (choicesMod as Record<string, unknown>).assertExhaustiveChoiceKind as
			| ((c: ChoiceRequest) => ChoiceKind)
			| undefined;
		assert.ok(Array.isArray(allKinds), 'ALL_CHOICE_KINDS must be exported from runtime/choices.ts');
		assert.equal(
			typeof checkKind,
			'function',
			'assertExhaustiveChoiceKind must be exported from runtime/choices.ts'
		);
		assert.deepEqual(
			[...allKinds].sort(),
			[
				'chooseMode',
				'chooseNumber',
				'chooseObjects',
				'chooseReplacement',
				'orderObjects',
				'yesNo'
			]
		);

		const sampleChoices: ChoiceRequest[] = [
			{ kind: 'yesNo', question: 'Q?' },
			{ kind: 'chooseObjects', candidates: [], min: 0, max: 1, zone: 'battlefield', reason: 'R' },
			{ kind: 'chooseMode', modes: ['A'], min: 1, max: 1 },
			{ kind: 'chooseNumber', min: 0, max: 3, reason: 'N' },
			{ kind: 'orderObjects', objectIds: [], reason: 'O' },
			{ kind: 'chooseReplacement', options: [{ id: 'r1', label: 'R1' }] }
		];
		for (const sample of sampleChoices) {
			assert.equal(checkKind!(sample), sample.kind);
		}

		const dir = dirname(new URL(import.meta.url).pathname);
		const arenaTableSrc = readFileSync(join(dir, '..', 'ArenaTable.svelte'), 'utf8');
		for (const kind of allKinds!) {
			assert.ok(
				arenaTableSrc.includes(`myChoice.kind === '${kind}'`),
				`ArenaTable.svelte must have a choice branch for myChoice.kind === '${kind}'`
			);
		}
		assert.ok(
			arenaTableSrc.includes('_exhaustiveChoice: never = myChoice'),
			'ArenaTable.svelte must include a compile-time never exhaustiveness check on myChoice'
		);
	});

	it('covers every PromptPurpose emitted by the engine with either a dedicated purpose branch or a valid ChoiceKind fallback', () => {
		const allPurposes = (choicesMod as Record<string, unknown>).ALL_PROMPT_PURPOSES as
			| readonly PromptPurpose[]
			| undefined;
		const allKinds = (choicesMod as Record<string, unknown>).ALL_CHOICE_KINDS as
			| readonly ChoiceKind[]
			| undefined;
		assert.ok(Array.isArray(allPurposes), 'ALL_PROMPT_PURPOSES must be exported');
		assert.ok(Array.isArray(allKinds), 'ALL_CHOICE_KINDS must be exported');

		const dir = dirname(new URL(import.meta.url).pathname);
		const sourceFiles = [
			join(dir, '..', 'engine.ts'),
			join(dir, 'triggers.ts'),
			join(dir, 'effects.ts'),
			join(dir, 'choices.ts')
		];
		const emittedPurposes = new Set<string>();
		const purposeRegex = /\bpurpose\s*:\s*'([a-z_]+)'/g;
		for (const file of sourceFiles) {
			const text = readFileSync(file, 'utf8');
			let m: RegExpExecArray | null;
			while ((m = purposeRegex.exec(text)) !== null) {
				emittedPurposes.add(m[1]);
			}
		}
		assert.ok(emittedPurposes.size > 0, 'Should discover emitted prompt purposes in engine sources');
		for (const ep of emittedPurposes) {
			assert.ok(
				allPurposes!.includes(ep as PromptPurpose),
				`Emitted purpose '${ep}' must be listed in ALL_PROMPT_PURPOSES`
			);
		}

		const state = makeTwoPlayerGame();
		for (const purpose of allPurposes!) {
			const kind =
				purpose === 'end_turn' || purpose === 'trigger_may' || purpose === 'generic'
					? 'yesNo'
					: purpose === 'trigger_targets'
						? 'chooseObjects'
						: purpose === 'trigger_order'
							? 'orderObjects'
							: purpose;
			const dummyPrompt: PendingPrompt = {
				id: `prm_${purpose}`,
				playerId: 'p1',
				kind,
				purpose,
				title: `Test ${purpose}`,
				description: `Description for ${purpose}`
			};
			const synthesized = choicesMod.effectivePromptChoice(dummyPrompt, state);
			assert.ok(
				allKinds!.includes(synthesized.kind),
				`Purpose '${purpose}' must resolve to a valid ChoiceKind (got '${synthesized.kind}')`
			);
		}
	});
});



