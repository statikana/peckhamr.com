import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	addCountersToPermanent,
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	movePermanentToZone
} from '../engine.ts';
import { moveObject } from './zones.ts';
import { flushTriggers } from './triggers.ts';
import { compileCard } from '../compiler/index.ts';
import { normalizeFace } from '../compiler/normalize.ts';
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
			{ commanders: [cmd], cards: [{ card: filler, quantity: 99 }] }
		])
	);
	const state = createInitialGameState('test_rf2', seats, decks, DEFAULT_LOBBY_RULES);
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

describe('Review 2 — Finding 4: 0/0 entering with counters and pending counter_replacement_choice', () => {
	it('Finding 4: human casts Walking Ballista (X=2) with Hardened Scales + Doubling Season; it survives on the battlefield while chooseReplacement is pending and gets (2+1)*2=6 or 2*2+1=5 counters', () => {
		for (const preferScalesFirst of [true, false]) {
			const { state, p1, p2 } = makeGame();

			putInZone(
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
			putInZone(
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

			const ballistaInHand = putInZone(
				state,
				p1,
				synthCard({
					name: 'Walking Ballista',
					manaCost: '{X}{X}',
					cmc: 0,
					typeLine: 'Artifact Creature — Construct',
					oracleText: 'Walking Ballista enters with X +1/+1 counters on it.',
					power: '0',
					toughness: '0'
				}),
				'hand'
			);
			p1.manaPool.C = 4;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ballistaInHand.instanceId,
				xValue: 2
			});
			assert.equal(castRes.ok, true, castRes.ok ? '' : castRes.error);

			// Pass priority for both players so Walking Ballista resolves
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

			const onBoard = p1.battlefield.find((c) => c.card.name === 'Walking Ballista');
			assert.ok(onBoard, 'Walking Ballista must survive on the battlefield while counter_replacement_choice is pending');
			assert.equal(p1.graveyard.some((c) => c.card.name === 'Walking Ballista'), false, 'Walking Ballista must not die to 0-toughness SBA before counter replacement choice');

			const repPrompt = state.pendingPrompts.find((pr) => pr.choice?.kind === 'chooseReplacement');
			assert.ok(repPrompt && repPrompt.choice?.kind === 'chooseReplacement', 'Expected chooseReplacement prompt for Hardened Scales vs Doubling Season');

			const chosenOpt = repPrompt.choice.options.find((o) =>
				preferScalesFirst ? o.label.includes('Hardened Scales') : o.label.includes('Doubling Season')
			);
			assert.ok(chosenOpt, 'Expected option in chooseReplacement prompt');

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: repPrompt.id,
					answer: { kind: 'chooseReplacement', id: chosenOpt.id }
				}).ok,
				true
			);

			const stillOnBoard = p1.battlefield.find((c) => c.card.name === 'Walking Ballista');
			assert.ok(stillOnBoard, 'Walking Ballista remains on the battlefield after answering');
			const expectedCounters = preferScalesFirst ? 6 : 5;
			assert.equal(
				stillOnBoard.counters['+1/+1'],
				expectedCounters,
				`Expected ${expectedCounters} +1/+1 counters when choosing ${preferScalesFirst ? 'Hardened Scales' : 'Doubling Season'} first`
			);
		}
	});
});

describe('Review 2 — Finding 1: off-battlefield cards only apply self-referential replacement abilities (CR 113.6)', () => {
	it('Finding 1: milling or discarding Rest in Peace puts it into the graveyard, while self-referential "from anywhere" replacements still apply when milled and battlefield replacements apply when dying (CR 113.6, 113.6b, 614.1)', () => {
		const { state, p1 } = makeGame([true, true]);

		const ripInLibrary = putInZone(
			state,
			p1,
			synthCard({
				name: 'Rest in Peace',
				typeLine: 'Enchantment',
				oracleText:
					'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'library'
		);
		const ripInHand = putInZone(
			state,
			p1,
			synthCard({
				name: 'Rest in Peace',
				typeLine: 'Enchantment',
				oracleText:
					'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'hand'
		);

		// Mill Rest in Peace from library -> must go to graveyard, NOT exile itself
		moveObject(state, ripInLibrary, 'graveyard', {
			from: { player: p1, zone: 'library' },
			toPlayer: p1,
			graveyardReplacement: true,
			bumpVersion: true,
			newTimestamp: true
		});
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === ripInLibrary.instanceId),
			true,
			'Milled Rest in Peace must go to graveyard, not exile itself (CR 113.6)'
		);
		assert.equal(
			p1.exile.some((c) => c.instanceId === ripInLibrary.instanceId),
			false,
			'Milled Rest in Peace must not be in exile'
		);

		// Discard Rest in Peace from hand -> must go to graveyard, NOT exile itself
		moveObject(state, ripInHand, 'graveyard', {
			from: { player: p1, zone: 'hand' },
			toPlayer: p1,
			graveyardReplacement: true,
			bumpVersion: true,
			newTimestamp: true
		});
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === ripInHand.instanceId),
			true,
			'Discarded Rest in Peace must go to graveyard, not exile itself (CR 113.6)'
		);

		// (a) Self-referential "from anywhere -> shuffle into library" card milled from library still shuffles into library
		const colossusInLib = putInZone(
			state,
			p1,
			synthCard({
				name: 'Blightsteel Colossus',
				typeLine: 'Artifact Creature — Phyrexian Golem',
				oracleText:
					"If Blightsteel Colossus would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			}),
			'library'
		);
		moveObject(state, colossusInLib, 'graveyard', {
			from: { player: p1, zone: 'library' },
			toPlayer: p1,
			graveyardReplacement: true,
			bumpVersion: true,
			newTimestamp: true
		});
		assert.equal(
			p1.library.some((c) => c.instanceId === colossusInLib.instanceId),
			true,
			'Milled Blightsteel Colossus still shuffles into library (CR 113.6b)'
		);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === colossusInLib.instanceId),
			false
		);

		// (b) Permanent on the battlefield with a graveyard replacement that leaves the battlefield still applies it
		const ripOnBoard = putInZone(
			state,
			p1,
			synthCard({
				name: 'Rest in Peace',
				typeLine: 'Enchantment',
				oracleText:
					'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);
		movePermanentToZone(state, ripOnBoard, 'graveyard');
		assert.equal(
			p1.exile.some((c) => c.instanceId === ripOnBoard.instanceId),
			true,
			'Rest in Peace destroyed on the battlefield exiles itself'
		);
	});
});

describe('Review 2 — Finding 6: multiple granted prowess instances each trigger separately (CR 702.108b)', () => {
	it('Finding 6: two permanents granting prowess (both distinct names and same-name copies) each produce a separate prowess trigger on noncreature spell cast (CR 702.108a, 702.108b)', () => {
		for (const sameName of [false, true]) {
			const { state, p1 } = makeGame();

			putInZone(
				state,
				p1,
				synthCard({
					name: 'Grizzly Bears',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2',
					oracleText: ''
				}),
				'battlefield'
			);
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Prowess Banner',
					typeLine: 'Enchantment',
					oracleText: 'Creatures you control have prowess.'
				}),
				'battlefield'
			);
			putInZone(
				state,
				p1,
				synthCard({
					name: sameName ? 'Prowess Banner' : 'Monastery Standard',
					typeLine: 'Enchantment',
					oracleText: 'Creatures you control have prowess.'
				}),
				'battlefield'
			);

			const cantrip = putInZone(
				state,
				p1,
				synthCard({
					name: 'Opt',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Draw a card.'
				}),
				'hand'
			);
			p1.manaPool.U = 1;

			const res = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cantrip.instanceId
			});
			assert.equal(res.ok, true, res.ok ? '' : res.error);

			const prowessTriggers = state.stack.filter(
				(s) => s.kind === 'triggered' && /Prowess/i.test(s.title)
			);
			assert.equal(
				prowessTriggers.length,
				2,
				`Expected 2 Prowess triggers on stack when ${sameName ? 'two same-named' : 'two distinct-named'} permanents grant prowess (CR 702.108b)`
			);
		}
	});
});

describe('Review 2 — Finding 8: matchCounter only triggers on battlefield permanents with abilities (CR 113.6)', () => {
	it('Finding 8: "Whenever a +1/+1 counter is put on ~, draw a card." does not trigger in graveyard/exile/stack or when ability-stripped, and does trigger on a normal battlefield permanent (CR 113.6, 122.6, 603.2, 613.1f)', () => {
		const { state, p1 } = makeGame([true, true]);

		const counterTriggerCard = synthCard({
			name: 'Fathom Mage',
			typeLine: 'Creature — Human Wizard',
			power: '1',
			toughness: '1',
			oracleText: 'Whenever a +1/+1 counter is put on Fathom Mage, draw a card.'
		});

		// 1. In graveyard, exile, or stack: placing a +1/+1 counter must NOT trigger
		for (const offZone of ['graveyard', 'exile', 'hand'] as const) {
			const offCard = putInZone(state, p1, counterTriggerCard, offZone);
			addCountersToPermanent(state, offCard, '+1/+1', 1);
			flushTriggers(state);
			assert.equal(
				state.stack.length,
				0,
				`Counter placed on card in ${offZone} must not trigger battlefield ability (CR 113.6)`
			);
		}
		const stackCard = createCardInstance(counterTriggerCard, p1.playerId, 'stack');
		addCountersToPermanent(state, stackCard, '+1/+1', 1);
		flushTriggers(state);
		assert.equal(
			state.stack.length,
			0,
			'Counter placed on card on stack must not trigger battlefield ability (CR 113.6)'
		);

		// 2. On battlefield while stripped of abilities ("loses all abilities"): must NOT trigger
		const onBoard = putInZone(state, p1, counterTriggerCard, 'battlefield');
		const frogify = putInZone(
			state,
			p1,
			synthCard({
				name: 'Frogify',
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nEnchanted creature loses all abilities and is a blue Frog creature with base power and toughness 1/1.'
			}),
			'battlefield'
		);
		frogify.attachedToId = onBoard.instanceId;

		addCountersToPermanent(state, onBoard, '+1/+1', 1);
		assert.equal(
			state.stack.length,
			0,
			'Counter placed on ability-stripped permanent must not trigger (CR 613.1f)'
		);

		// 3. Remove Frogify -> normal battlefield permanent DOES trigger
		movePermanentToZone(state, frogify, 'graveyard');
		addCountersToPermanent(state, onBoard, '+1/+1', 1);
		assert.equal(
			state.stack.length,
			1,
			'Counter placed on normal battlefield permanent triggers its ability'
		);
	});
});

describe('Review 2 — Finding 7: strip CR 207.2c ability words and CR 207.2d flavor words while blocking rules terms (CR 207.2c, 207.2d, 701, 702)', () => {
	it('Finding 7: flavor-word triggered ability ("Keen Sight — Whenever ~ attacks, draw a card.") compiles as supported and triggers on attack; rules prefixes stay unsupported; Landfall stays supported', () => {
		const keenSightCard = synthCard({
			name: 'Keen-Eyed Owl',
			typeLine: 'Creature — Bird',
			power: '2',
			toughness: '2',
			oracleText: 'Keen Sight — Whenever Keen-Eyed Owl attacks, draw a card.'
		});
		const norm = normalizeFace(keenSightCard.name, keenSightCard.oracleText);
		assert.equal(norm.lines[0]?.abilityWord, 'Keen Sight', 'Flavor word is recorded on NormalizedLine.abilityWord (CR 207.2d)');
		assert.equal(norm.lines[0]?.body, 'Whenever ~ attacks, draw a card.');
		assert.equal(compileCard(keenSightCard).fullySupported, true, 'Flavor-word triggered ability compiles as fullySupported: true');

		// Verify it actually triggers when attacking
		const { state, p1, p2 } = makeGame();
		state.phase = 'declare_attackers';
		const owl = putInZone(state, p1, keenSightCard, 'battlefield');
		const atkRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: owl.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atkRes.ok, true, atkRes.ok ? '' : atkRes.error);
		assert.equal(
			state.stack.some((s) => s.kind === 'triggered' && s.sourceInstanceId === owl.instanceId),
			true,
			'Keen Sight attack trigger is placed on the stack when attacking'
		);

		// Rules prefixes (CR 701 / 702) must still NOT be stripped and must compile as fullySupported: false
		for (const [label, text] of [
			['Solved', 'Solved — Creatures you control get +2/+2 and have vigilance.'],
			['Max speed', 'Max speed — Other creatures you control get +1/+1 and have haste.'],
			['Boast', 'Boast — Sacrifice a creature: Draw a card.'],
			['Exhaust', 'Exhaust — Sacrifice a creature: Draw a card.'],
			['Power-up', 'Power-up — Sacrifice a creature: Put a +1/+1 counter on ~.']
		] as const) {
			const c = synthCard({
				name: `Rules Prefix ${label}`,
				typeLine: 'Creature — Test',
				oracleText: text
			});
			assert.equal(
				compileCard(c).fullySupported,
				false,
				`${label} — must not be stripped as a flavor/ability word`
			);
		}

		// Genuine CR 207.2c ability words (Landfall) still compile as fullySupported: true
		const landfallCard = synthCard({
			name: 'Lotus Tracker',
			typeLine: 'Creature — Elf',
			oracleText: 'Landfall — Whenever a land you control enters, you gain 1 life.'
		});
		assert.equal(compileCard(landfallCard).fullySupported, true, 'Landfall — still compiles as fullySupported: true');
	});
});

describe('Review 2 — Finding 9: route spell resolution and cleanup discard through moveObject with graveyardReplacement: true (CR 400.6, 608.2n, 614.1, 616.1)', () => {
	it('Finding 9: resolving an instant with a "from anywhere -> shuffle into library" self-replacement shuffles it into library, and discarding to hand size with Rest in Peace exiles the card (CR 400.6, 608.2n, 614.1)', () => {
		const { state, p1, p2 } = makeGame([false, true]);

		// 1. Instant with "from anywhere, shuffle into library" self-replacement resolving from stack
		const nexusInstant = putInZone(
			state,
			p1,
			synthCard({
				name: 'Beacon of Eternity',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText:
					'You gain 2 life.\nIf Beacon of Eternity would be put into a graveyard from anywhere, shuffle it into its owner\'s library instead.'
			}),
			'hand'
		);
		p1.manaPool.U = 1;

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: nexusInstant.instanceId
		});
		assert.equal(castRes.ok, true, castRes.ok ? '' : castRes.error);
		assert.equal(state.stack.length, 1);

		// Both players pass priority to resolve the instant
		const passRes1 = applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		assert.equal(passRes1.ok, true, passRes1.ok ? '' : passRes1.error);
		const passRes2 = applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(passRes2.ok, true, passRes2.ok ? '' : passRes2.error);
		assert.equal(state.stack.length, 0, 'Instant resolved off the stack');

		assert.equal(
			p1.graveyard.some((c) => c.instanceId === nexusInstant.instanceId),
			false,
			'Resolved instant with shuffle replacement must not end up in graveyard (CR 608.2n, 614.1)'
		);
		assert.equal(
			p1.library.some((c) => c.instanceId === nexusInstant.instanceId),
			true,
			'Resolved instant with shuffle replacement must be shuffled into owner\'s library (CR 608.2n, 614.1)'
		);

		// 2. Discarding to hand size with Rest in Peace on the battlefield exiles the discarded card
		putInZone(
			state,
			p2,
			synthCard({
				name: 'Rest in Peace',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);
		while (p1.hand.length < 8) {
			putInZone(
				state,
				p1,
				synthCard({
					name: `Extra Card ${p1.hand.length}`,
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				'hand'
			);
		}
		const discardTarget = p1.hand[0]!;

		// Advance to cleanup step where human must discard down to 7
		state.phase = 'end_step';
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		const discardPrompt = state.pendingPrompts.find((pr) => pr.purpose === 'discard_to_hand_size');
		assert.ok(discardPrompt, 'Expected discard_to_hand_size prompt in cleanup step');

		const ansRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: discardPrompt.id,
			answer: { kind: 'chooseObjects', objectIds: [discardTarget.instanceId] }
		});
		assert.equal(ansRes.ok, true, ansRes.ok ? '' : ansRes.error);

		assert.equal(
			p1.graveyard.some((c) => c.instanceId === discardTarget.instanceId),
			false,
			'Card discarded to hand size with Rest in Peace must not go to graveyard'
		);
		assert.equal(
			p1.exile.some((c) => c.instanceId === discardTarget.instanceId),
			true,
			'Card discarded to hand size with Rest in Peace must be exiled'
		);
	});
});
