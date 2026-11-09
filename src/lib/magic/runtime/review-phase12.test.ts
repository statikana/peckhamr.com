import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	drawCards,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type ScryfallCard
} from '../types.ts';

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

function makeTwoPlayerGame(seed?: number): GameState {
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
		{ ...DEFAULT_LOBBY_RULES },
		seed !== undefined ? { rngSeed: seed } : undefined
	);
}

describe('Phase 1 (§2.1 + §2.2): Secret stripping and opponent prompt redaction', () => {
	it('strips rngState, nextUid, and idSalt from the viewer copy without mutating the original state', () => {
		const state = makeTwoPlayerGame(12345);
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
		const state = makeTwoPlayerGame(42);
		state.rules.mulliganRule = 'standard_london';
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
		const state = makeTwoPlayerGame(99);
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
		state.stack.push({
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
		});

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
		const state = makeTwoPlayerGame(77);
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
			title: 'Brainstorm',
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
