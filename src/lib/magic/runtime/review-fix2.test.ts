import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyGameAction, checkStateBasedActions, createCardInstance, createInitialGameState, movePermanentToZone } from '../engine.ts';
import type { CardInstance, GameState, LobbySeat, PlayerGameState, ScryfallCard, ZoneType } from '../types.ts';
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
			{ commanders: [cmd], cards: Array.from({ length: 99 }, () => filler) }
		])
	);
	const state = createInitialGameState('test_rf2', seats, decks, DEFAULT_LOBBY_RULES);
	state.status = 'active';
	state.turnNumber = 1;
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	for (const p of state.players) {
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

describe('Review 2 — Group A (Findings 2, 3, 5): pending zone-change replacement prompts', () => {
	it('Finding 2: a creature with a leaves-the-battlefield trigger, controlled by a non-owner, dying with two competing graveyard replacements fires the trigger once for the controller (CR 603.10a, 616.1)', () => {
		const { state, p1, p2 } = makeGame([false, false]);

		// Two graveyard replacements on the battlefield
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
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Wheel of Sun and Moon',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);

		// Observer on p1's battlefield: "Whenever a creature you control leaves the battlefield, you gain 3 life."
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Soul Watcher',
				typeLine: 'Creature — Cleric',
				oracleText: 'Whenever a creature you control leaves the battlefield, you gain 3 life.'
			}),
			'battlefield'
		);

		// Creature owned by p2, controlled by p1, with its own LTB trigger:
		// "When ~ leaves the battlefield, you gain 2 life."
		const stolen = putInZone(
			state,
			p1,
			synthCard({
				name: 'StolenEnvoy',
				typeLine: 'Creature — Spirit',
				oracleText: 'When ~ leaves the battlefield, you gain 2 life.'
			}),
			'battlefield',
			{ ownerId: p2.playerId }
		);

		movePermanentToZone(state, stolen, 'graveyard');

		const repPrompt = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseReplacement');
		assert.ok(repPrompt, 'Expected chooseReplacement prompt for p1');
		assert.equal(repPrompt.playerId, p1.playerId, 'Controller p1 chooses replacement order');
		assert.equal(repPrompt.choice?.kind, 'chooseReplacement');

		const chosenOpt = repPrompt.choice.options[0];
		assert.ok(chosenOpt);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: repPrompt.id,
				answer: { kind: 'chooseReplacement', id: chosenOpt.id }
			}).ok,
			true
		);

		// Both LTB triggers ("When ~ leaves the battlefield" and "Whenever a creature you control leaves the battlefield")
		// must be on the stack controlled by p1 (the last battlefield controller, not owner p2).
		assert.equal(state.stack.length, 2, 'Both self-LTB and observer-LTB triggers must be placed on the stack');
		for (const item of state.stack) {
			assert.equal(item.controllerId, p1.playerId, 'LTB triggers must be controlled by battlefield controller p1');
		}
	});

	it('Finding 3: human commander with two replacements where chosen one sends it to library prompts commander_zone_choice and "yes" puts it in the command zone (CR 903.9b, 616.1)', () => {
		const { state, p1 } = makeGame([false, false]);

		putInZone(
			state,
			p1,
			synthCard({
				name: 'Void Maw',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);

		const cmd = putInZone(
			state,
			p1,
			synthCard({
				name: 'Shuffle Commander',
				typeLine: 'Legendary Creature — Avatar',
				power: '5',
				toughness: '5',
				oracleText: "If ~ would die, shuffle it into its owner's library instead."
			}),
			'battlefield',
			{ isCommander: true }
		);
		p1.commanderNames[cmd.instanceId] = cmd.card.name;

		movePermanentToZone(state, cmd, 'graveyard');

		const repPrompt = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseReplacement');
		assert.ok(repPrompt && repPrompt.choice?.kind === 'chooseReplacement', 'Expected chooseReplacement prompt');
		const libOpt = repPrompt.choice.options.find((o) => /library/i.test(o.label));
		assert.ok(libOpt, 'Expected shuffle-into-library replacement option');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: repPrompt.id,
				answer: { kind: 'chooseReplacement', id: libOpt.id }
			}).ok,
			true
		);

		const cmdPrompt = state.pendingPrompts.find((pr) => pr.purpose === 'commander_zone_choice');
		assert.ok(cmdPrompt, 'Human owner must receive commander_zone_choice prompt when replacement sends commander to library (CR 903.9b)');
		assert.equal(cmdPrompt.playerId, p1.playerId);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: cmdPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1.command.some((c) => c.instanceId === cmd.instanceId), true, 'Commander should move to command zone on yes');
		assert.equal(p1.library.some((c) => c.instanceId === cmd.instanceId), false, 'Commander should no longer be in library');
	});

	it('Finding 5: creature dying with Rest in Peace + another graveyard replacement is not in graveyard before answering and fires no died log/trigger; after choosing RIP it is in exile (CR 616.1)', () => {
		const { state, p1 } = makeGame([false, false]);

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
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Void Leyline',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Death Watcher',
				typeLine: 'Creature — Cleric',
				oracleText: 'Whenever a creature you control dies, you gain 2 life.'
			}),
			'battlefield'
		);

		const martyr = putInZone(
			state,
			p1,
			synthCard({
				name: 'Doomed Martyr',
				typeLine: 'Creature — Human',
				power: '2',
				toughness: '2',
				oracleText: 'When ~ dies, draw a card.'
			}),
			'battlefield'
		);
		martyr.damageMarked = 2; // lethal damage

		checkStateBasedActions(state);

		const repPrompt = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseReplacement');
		assert.ok(repPrompt && repPrompt.choice?.kind === 'chooseReplacement', 'Expected chooseReplacement prompt from SBA death');

		// Before answering: card is NOT in graveyard, exile, or battlefield, and no "died" log or dies trigger has fired
		assert.equal(p1.graveyard.some((c) => c.instanceId === martyr.instanceId), false, 'Card must not be in graveyard while replacement prompt is pending');
		assert.equal(p1.exile.some((c) => c.instanceId === martyr.instanceId), false, 'Card must not be in exile before replacement choice is made');
		assert.equal(p1.battlefield.some((c) => c.instanceId === martyr.instanceId), false, 'Card has left battlefield into pendingZoneMoves');
		assert.equal(
			state.log.some((entry) => /Doomed Martyr died/i.test(entry.text)),
			false,
			'No "died" log entry may be emitted while replacement choice is pending'
		);
		assert.equal(state.stack.length, 0, 'No dies trigger may be on the stack while replacement choice is pending');

		const ripOpt = repPrompt.choice.options.find((o) => o.label.includes('Rest in Peace')) ?? repPrompt.choice.options[0];
		assert.ok(ripOpt);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: repPrompt.id,
				answer: { kind: 'chooseReplacement', id: ripOpt.id }
			}).ok,
			true
		);

		assert.equal(p1.exile.some((c) => c.instanceId === martyr.instanceId), true, 'After choosing RIP, card is in exile');
		assert.equal(p1.graveyard.some((c) => c.instanceId === martyr.instanceId), false, 'Card is never in graveyard');
		assert.equal(state.stack.length, 0, 'No dies trigger fires when exiled instead of dying');
		assert.equal(
			state.log.some((entry) => /Doomed Martyr died/i.test(entry.text)),
			false,
			'No "died" log entry after choosing exile replacement'
		);
	});
});
