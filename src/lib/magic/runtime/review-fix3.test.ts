import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState
} from '../engine.ts';
import type {
	CardInstance,
	GameState,
	LobbySeat,
	MagicDeck,
	PlayerGameState,
	ScryfallCard,
	ZoneType
} from '../types.ts';
import { DEFAULT_LOBBY_RULES } from '../types.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	const name = overrides.name;
	const id = overrides.id ?? `synth_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `${id}_oid`,
		name,
		manaCost: overrides.manaCost ?? '{1}{G}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['G'],
		colorIdentity: overrides.colorIdentity ?? ['G'],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false,
		imageUrl: '',
		artCropUrl: ''
	};
}

function makeSeat(index: number, isBot: boolean): LobbySeat {
	return {
		seatIndex: index,
		userId: isBot ? null : `usr_${index}`,
		username: `Player ${index + 1}`,
		avatarUrl: '',
		isBot,
		deckId: 'test',
		deckName: 'Test Deck',
		commanderNames: ['Test Commander'],
		commanderArtUrl: '',
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	};
}

function makeGame(botFlags: boolean[] = [false, false]): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats = botFlags.map((isBot, idx) => makeSeat(idx, isBot));
	const filler = synthCard({ name: 'Filler', oracleText: '' });
	const cmd = synthCard({
		name: 'Test Commander',
		typeLine: 'Legendary Creature — Human',
		oracleText: ''
	});
	const decks = new Map(
		seats.map((s) => [
			s.seatIndex,
			{ commanders: [cmd], cards: [{ card: filler, quantity: 99 }] }
		])
	) as unknown as Map<number, MagicDeck>;
	const state = createInitialGameState('test_rf3', seats, decks, DEFAULT_LOBBY_RULES);
	state.status = 'active';
	state.turnNumber = 1;
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.pendingPrompts = [];
	for (const p of state.players) {
		p.lost = false;
		p.attemptedEmptyLibraryDraw = false;
		p.hand = [];
		p.graveyard = [];
		p.exile = [];
	}
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: Exclude<ZoneType, 'stack'>,
	opts?: { ownerId?: string; isCommander?: boolean }
): CardInstance {
	const inst = createCardInstance(card, opts?.ownerId ?? player.playerId, zone, Boolean(opts?.isCommander));
	inst.controllerId = player.playerId;
	inst.summoningSick = false;
	player[zone].push(inst);
	return inst;
}

function countOccurrencesInPlayerZones(state: GameState, instanceId: string): number {
	const zones = ['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command'] as const;
	let count = 0;
	for (const p of state.players) {
		for (const z of zones) {
			for (const c of p[z]) {
				if (c.instanceId === instanceId) count += 1;
			}
		}
	}
	return count;
}

describe('Review 3 — Group A: SBA graveyard batch with pending moves and library/hand replacements', () => {
	it('R1: two creatures die simultaneously to SBA while one has two competing graveyard replacements for its human controller -> while pending it is on no battlefield and in no zone; after answering it exists once in the chosen zone (CR 616.1, 704.3, 704.8)', () => {
		const { state, p1 } = makeGame([false, false]);

		// Global graveyard replacement: Rest in Peace (exile instead)
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Rest in Peace',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);

		// Creature 1: has a self-replacement ("If ~ would die, shuffle it into its owner's library instead.")
		//Wait: self-replacement is tier 616.1a so it beats global RIP without prompting. Instead, use a second
		// global replacement ("If a card or token would be put into a graveyard from anywhere, shuffle it into its owner's library instead.")
		// or Creature 1 having two competing self-replacements so only Creature 1 prompts!
		const phoenix = putInZone(
			state,
			p1,
			synthCard({
				name: 'Twin-Fate Phoenix',
				typeLine: 'Creature — Phoenix',
				power: '2',
				toughness: '2',
				oracleText:
					'If Twin-Fate Phoenix would die, exile it instead.\nIf Twin-Fate Phoenix would die, return it to its owner\'s hand instead.'
			}),
			'battlefield'
		);
		const bear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Grizzly Bears',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		// Mark lethal damage on both creatures simultaneously and run SBAs
		phoenix.damageMarked = 2;
		bear.damageMarked = 2;
		checkStateBasedActions(state);

		// While the replacement prompt for phoenix is pending, phoenix must NOT be on any battlefield or in any zone
		const repPrompt = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseReplacement');
		assert.ok(repPrompt && repPrompt.choice?.kind === 'chooseReplacement', 'Expected chooseReplacement prompt for Twin-Fate Phoenix');
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === phoenix.instanceId),
			false,
			'Pending permanent must not reappear on the battlefield after SBA batch restore (R1)'
		);
		assert.equal(
			countOccurrencesInPlayerZones(state, phoenix.instanceId),
			0,
			'Pending permanent must not exist in any player zone while chooseReplacement is pending (CR 616.1)'
		);
		assert.equal(
			state.pendingZoneMoves?.some((c) => c.instanceId === phoenix.instanceId),
			true,
			'Pending permanent is held in state.pendingZoneMoves'
		);

		// Answer the replacement prompt (choose the first replacement: exile)
		const firstOpt = repPrompt.choice.options[0]!;
		const ansRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: repPrompt.id,
			answer: { kind: 'chooseReplacement', id: firstOpt.id }
		});
		assert.equal(ansRes.ok, true);

		assert.equal(
			p1.battlefield.some((c) => c.instanceId === phoenix.instanceId),
			false,
			'After answering replacement prompt, permanent must not be on the battlefield'
		);
		assert.equal(
			countOccurrencesInPlayerZones(state, phoenix.instanceId),
			1,
			'After answering replacement prompt, permanent must exist in player zones exactly once'
		);
		assert.equal(
			p1.exile.some((c) => c.instanceId === phoenix.instanceId),
			true,
			'Phoenix is in exile after choosing exile replacement'
		);
	});

	it('R2: simultaneous SBA deaths where one creature has a "shuffle into its owner\'s library instead" replacement puts it in the library only, exactly once, and the other in the graveyard (CR 614.1, 704.3, 704.8)', () => {
		const { state, p1 } = makeGame([false, false]);

		const colossus = putInZone(
			state,
			p1,
			synthCard({
				name: 'Adamantine Colossus',
				typeLine: 'Artifact Creature — Golem',
				power: '11',
				toughness: '11',
				oracleText:
					'If Adamantine Colossus would be put into a graveyard from anywhere, shuffle it into its owner\'s library instead.'
			}),
			'battlefield'
		);
		const bear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Grizzly Bears',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		colossus.damageMarked = 11;
		bear.damageMarked = 2;
		checkStateBasedActions(state);

		assert.equal(
			p1.graveyard.some((c) => c.instanceId === colossus.instanceId),
			false,
			'Colossus with library replacement must not also be pushed into graveyard during SBA restore (R2)'
		);
		assert.equal(
			p1.library.some((c) => c.instanceId === colossus.instanceId),
			true,
			'Colossus must be in owner\'s library'
		);
		assert.equal(
			countOccurrencesInPlayerZones(state, colossus.instanceId),
			1,
			'Colossus must exist in player zones exactly once'
		);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === bear.instanceId),
			true,
			'Other dying creature is in graveyard'
		);
		assert.equal(
			countOccurrencesInPlayerZones(state, bear.instanceId),
			1,
			'Other dying creature exists in player zones exactly once'
		);
	});
});
