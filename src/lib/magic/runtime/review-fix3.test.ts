import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyGameAction,
	canBlock,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	isCombatDeclarationPending
} from '../engine.ts';
import { executeEffectSteps } from './effects.ts';
import { matchesObjectFilter, objectManaValue, playerCommanderCastCount } from './objectFilter.ts';
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

describe('Review 3 — Group B: bot combat declarations and R10 shared predicates', () => {
	it('R10: shared canBlock and isCombatDeclarationPending helpers enforce evasion/protection and pending combat declarations (CR 508.1, 509.1, 702.9b, 702.16e)', () => {
		const { state, p1, p2 } = makeGame([false, true]);
		const flyer = putInZone(
			state,
			p1,
			synthCard({
				name: 'Sky Raptor',
				oracleText: 'Flying',
				keywords: ['Flying']
			}),
			'battlefield'
		);
		const proGreen = putInZone(
			state,
			p1,
			synthCard({
				name: 'White Knight',
				colors: ['W'],
				colorIdentity: ['W'],
				oracleText: 'Protection from green'
			}),
			'battlefield'
		);
		const greenBear = putInZone(
			state,
			p2,
			synthCard({
				name: 'Green Bear',
				colors: ['G'],
				colorIdentity: ['G']
			}),
			'battlefield'
		);
		const reachSpider = putInZone(
			state,
			p2,
			synthCard({
				name: 'Artifact Spider',
				typeLine: 'Artifact Creature — Spider',
				colors: [],
				colorIdentity: [],
				oracleText: 'Reach',
				keywords: ['Reach']
			}),
			'battlefield'
		);

		assert.equal(canBlock(state, greenBear, flyer), false, 'Ground creature cannot block flyer');
		assert.equal(canBlock(state, reachSpider, flyer), true, 'Reach creature can block flyer');
		assert.equal(
			canBlock(state, greenBear, proGreen),
			false,
			'Green creature cannot block attacker with protection from green'
		);
		assert.equal(
			canBlock(state, reachSpider, proGreen),
			true,
			'Colorless creature can block attacker with protection from green'
		);

		assert.equal(isCombatDeclarationPending(state), false);
		state.phase = 'declare_attackers';
		state.combat.awaitingAttackersDeclaration = true;
		assert.equal(isCombatDeclarationPending(state), true);
		state.combat.awaitingAttackersDeclaration = false;
		assert.equal(isCombatDeclarationPending(state), false);
	});

	it('R3: bot blocker declaration blocks an attacker with protection from green using legal non-green blockers and assigns creatures with "blocks each combat if able" (CR 509.1, 509.1b, 509.1c)', () => {
		const { state, p1, p2 } = makeGame([false, true]);

		// Human (p1) attacks Bot (p2) with a 4/4 that has protection from green and a 2/2 vanilla creature
		const proGreenAtk = putInZone(
			state,
			p1,
			synthCard({
				name: 'Mirran Crusader',
				colors: ['W'],
				colorIdentity: ['W'],
				power: '4',
				toughness: '4',
				oracleText: 'Protection from green'
			}),
			'battlefield'
		);
		const vanillaAtk = putInZone(
			state,
			p1,
			synthCard({
				name: 'Runeclaw Bear',
				colors: ['U'],
				colorIdentity: ['U'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		// Bot (p2) controls a 3/3 green creature, a 2/2 white creature, and a 1/1 white creature with "blocks each combat if able"
		const greenBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Centaur Courser',
				colors: ['G'],
				colorIdentity: ['G'],
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);
		const whiteBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Glory Seeker',
				colors: ['W'],
				colorIdentity: ['W'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const mandatoryBlocker = putInZone(
			state,
			p2,
			synthCard({
				name: 'Eager Cadet',
				colors: ['W'],
				colorIdentity: ['W'],
				power: '1',
				toughness: '1',
				oracleText: 'Eager Cadet blocks each combat if able.'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		state.combat.awaitingAttackersDeclaration = true;
		const atkRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{ attackerInstanceId: proGreenAtk.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: vanillaAtk.instanceId, defenderPlayerId: p2.playerId }
			]
		});
		assert.equal(atkRes.ok, true);

		// Advance into declare_blockers: bot p2 declares blockers at step entry
		const passRes = applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		assert.equal(passRes.ok, true);
		const passRes2 = applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(passRes2.ok, true);
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(state.combat.blockersDeclared, true);

		const proGreenEntry = state.combat.attackers.find(
			(a) => a.attackerInstanceId === proGreenAtk.instanceId
		)!;
		const vanillaEntry = state.combat.attackers.find(
			(a) => a.attackerInstanceId === vanillaAtk.instanceId
		)!;
		const allDeclaredBlockerIds = [
			...proGreenEntry.blockerInstanceIds,
			...vanillaEntry.blockerInstanceIds
		];

		assert.equal(
			proGreenEntry.blockerInstanceIds.includes(greenBlocker.instanceId),
			false,
			'Green creature cannot block attacker with protection from green'
		);
		assert.equal(
			proGreenEntry.blockerInstanceIds.length > 0,
			true,
			'Bot must still block the protection-from-green attacker with a legal non-green blocker (R3)'
		);
		assert.equal(
			allDeclaredBlockerIds.includes(whiteBlocker.instanceId),
			true,
			'Bot blocks with its legal non-green blocker (R3)'
		);
		assert.equal(
			allDeclaredBlockerIds.includes(greenBlocker.instanceId),
			true,
			'Bot also blocks the non-protected attacker with its green blocker (R3)'
		);
		assert.equal(
			allDeclaredBlockerIds.includes(mandatoryBlocker.instanceId),
			true,
			'Bot creature with "blocks each combat if able" must block (CR 509.1c, R3)'
		);
	});

	it('R6: bot attacker declaration at step entry includes goaded 1/1 attacking a non-goading opponent and 1/1 with "attacks each combat if able" (CR 508.1d, 701.15b)', () => {
		const { state, p1, p2 } = makeGame([false, true, false]);
		const p3 = state.players[2]!;

		// Give p3 higher or lower life than p1 so even if p1 has higher life, goad still forces attacking p3
		p1.life = 40;
		p3.life = 30;

		const goadedGoblin = putInZone(
			state,
			p2,
			synthCard({
				name: 'Pestering Goblin',
				colors: ['R'],
				colorIdentity: ['R'],
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		goadedGoblin.goadedByPlayerIds = [p1.playerId];

		const berserker = putInZone(
			state,
			p2,
			synthCard({
				name: 'RagingGoblinoid',
				colors: ['R'],
				colorIdentity: ['R'],
				power: '1',
				toughness: '1',
				oracleText: 'RagingGoblinoid attacks each combat if able.'
			}),
			'battlefield'
		);

		// Start on Bot p2's begin_combat and pass priority so p2 enters declare_attackers
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'begin_combat';
		for (const pl of state.players) {
			const res = applyGameAction(state, state.players[state.priorityPlayerIndex]!.playerId, {
				type: 'pass_priority'
			});
			assert.equal(res.ok, true);
		}

		assert.equal(state.phase, 'declare_attackers');
		assert.equal(state.combat.active, true, 'Combat must be active after bot declares attackers');

		const goadedAtk = state.combat.attackers.find(
			(a) => a.attackerInstanceId === goadedGoblin.instanceId
		);
		assert.ok(goadedAtk, 'Goaded 1/1 bot creature must attack (CR 701.15b, R6)');
		assert.equal(
			goadedAtk.defenderPlayerId,
			p3.playerId,
			'Goaded bot creature must attack a player other than the goading player if able (CR 701.15b, R6)'
		);

		const berserkerAtk = state.combat.attackers.find(
			(a) => a.attackerInstanceId === berserker.instanceId
		);
		assert.ok(
			berserkerAtk,
			'1/1 bot creature with "attacks each combat if able" must attack (CR 508.1d, R6)'
		);
	});

	it('R5: when an undecided defender passes in declare_blockers and block triggers go on the stack, active player gets priority with empty passedPriorityPlayerIds and all players must pass to resolve (CR 509.2, 117.3a, 117.4)', () => {
		const { state, p1, p2 } = makeGame([false, false, true]);
		const p3 = state.players[2]!;

		const atk1 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Grizzly Bears',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const atk2 = putInZone(
			state,
			p1,
			synthCard({
				name: 'Hill Giant',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);

		// Bot p3 has a 4/4 blocker with "Whenever ~ blocks or becomes blocked, draw a card."
		putInZone(
			state,
			p3,
			synthCard({
				name: 'Ophidian Guardian',
				power: '4',
				toughness: '4',
				oracleText: 'Whenever Ophidian Guardian blocks or becomes blocked, draw a card.'
			}),
			'battlefield'
		);

		state.phase = 'declare_attackers';
		state.combat.awaitingAttackersDeclaration = true;
		const declRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{ attackerInstanceId: atk1.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: atk2.instanceId, defenderPlayerId: p3.playerId }
			]
		});
		assert.equal(declRes.ok, true);

		// Pass priority around the table in declare_attackers to enter declare_blockers
		for (let i = 0; i < 3; i++) {
			const res = applyGameAction(state, state.players[state.priorityPlayerIndex]!.playerId, {
				type: 'pass_priority'
			});
			assert.equal(res.ok, true);
		}

		// In declare_blockers, human defender p2 is up first to declare blockers
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(state.combat.blockersDeclared, false);
		assert.equal(state.priorityPlayerIndex, 1);

		// p2 passes without declaring blockers -> p3 (bot) declares its blocker, triggering Ophidian Guardian
		const p2DeclPass = applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(p2DeclPass.ok, true);

		assert.equal(state.combat.blockersDeclared, true);
		assert.equal(state.stack.length, 1, 'Block trigger must be on the stack');
		assert.equal(
			state.priorityPlayerIndex,
			0,
			'Active player (p1) must receive priority first after blockers are declared (CR 509.2, 117.3a, R5)'
		);
		assert.deepEqual(
			state.passedPriorityPlayerIds,
			[],
			'Defender pass must not count against the newly placed trigger on the stack (CR 117.4, R5)'
		);

		// p1 passes priority on the trigger -> p2 gets priority and the trigger is still on the stack
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.priorityPlayerIndex, 1);
		assert.equal(
			state.stack.length,
			1,
			'Trigger must not resolve until defender p2 also passes with it on the stack'
		);

		// p2 passes -> p3 gets priority, trigger still on the stack
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.priorityPlayerIndex, 2);
		assert.equal(state.stack.length, 1);

		// p3 passes -> all players have passed with the trigger on the stack, so it resolves
		assert.equal(applyGameAction(state, p3.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.stack.length, 0, 'Trigger resolves after all 3 players pass priority');
	});
});

describe('Review 3 — Group C: prowess dedupe, objectManaValue, and playerCommanderCastCount', () => {
	it('R7: two separate temporary prowess grants on the same creature trigger prowess twice per noncreature spell cast while keeping other granted keywords deduped (CR 702.108b)', () => {
		const { state, p1 } = makeGame([false, false]);

		const bear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Runeclaw Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		for (const boonName of ['Scroll Boon A', 'Scroll Boon B']) {
			const boonCard = synthCard({
				name: boonName,
				typeLine: 'Instant',
				oracleText: 'Target creature gains prowess and flying until end of turn.'
			});
			const targets = [
				{ kind: 'permanent' as const, id: bear.instanceId, label: bear.card.name }
			];
			executeEffectSteps(
				state,
				{
					controller: p1,
					sourceId: `src_${boonName}`,
					sourceCard: boonCard,
					title: boonCard.name,
					item: {
						id: `stk_${boonName}`,
						sourceInstanceId: `src_${boonName}`,
						card: boonCard,
						ownerId: p1.playerId,
						controllerId: p1.playerId,
						kind: 'spell',
						title: boonCard.name,
						oracleText: boonCard.oracleText,
						targets,
						xValue: 0,
						castMode: 'normal',
						requiresGuidedResolution: false,
						createdAt: 0
					},
					targets,
					targetSpecs: [],
					xValue: 0
				},
				[
					{
						verb: 'grant',
						subject: { k: 'target', index: 0 },
						params: { keywords: ['prowess', 'flying'], duration: 'endOfTurn' },
						span: { start: 0, end: 0 }
					}
				]
			);
		}

		// Non-prowess keywords remain deduped in grantedKeywords
		assert.equal(
			bear.grantedKeywords.filter((kw) => kw.toLowerCase() === 'flying').length,
			1,
			'Non-prowess granted keywords must remain deduped'
		);

		const cantrip = putInZone(
			state,
			p1,
			synthCard({
				name: 'Steady Aim',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				colors: ['U'],
				colorIdentity: ['U'],
				oracleText: 'Draw a card.'
			}),
			'hand'
		);
		p1.manaPool.U = 1;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cantrip.instanceId,
				fromZone: 'hand'
			}).ok,
			true
		);

		const prowessTriggers = state.stack.filter(
			(s) => s.kind === 'triggered' && s.title.toLowerCase().includes('prowess')
		);
		assert.equal(
			prowessTriggers.length,
			2,
			'Two separate temporary prowess grants must produce two prowess triggers per noncreature spell (CR 702.108b, R7)'
		);
	});

	it('R8: objectManaValue uses only the object\'s own X and only when its manaCost contains {X}; caller ctx.xValue never leaks into target MV checks (CR 202.3e)', () => {
		const { state, p1, p2 } = makeGame([false, false]);

		// A 2-MV non-X spell on the stack
		const nonXCard = synthCard({
			name: 'Arcane Denial',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			colors: ['U'],
			colorIdentity: ['U']
		});
		const nonXInst = createCardInstance(nonXCard, p2.playerId, 'stack');

		// 1. An X=3 spell/ability checks "mana value 2 or less" against the 2-MV non-X spell on the stack
		const matchesMv2OrLess = matchesObjectFilter(
			nonXInst,
			{
				zone: 'stack',
				manaValue: { op: '<=', value: { k: 'const', n: 2 } }
			},
			{
				state,
				controllerId: p1.playerId,
				xValue: 3
			}
		);
		assert.equal(
			matchesMv2OrLess,
			true,
			'X=3 caller checking "mana value 2 or less" on a 2-MV stack spell must use the target\'s own MV (CR 202.3e, R8)'
		);

		// Also check a {X}{U} spell on the stack with no recorded xValue (i.e. X=0) checked by an X=3 caller
		const xZeroCard = synthCard({
			name: 'Condescend',
			manaCost: '{X}{U}',
			cmc: 1,
			typeLine: 'Instant',
			colors: ['U'],
			colorIdentity: ['U']
		});
		const xZeroInst = createCardInstance(xZeroCard, p2.playerId, 'stack');
		assert.equal(
			matchesObjectFilter(
				xZeroInst,
				{
					zone: 'stack',
					manaValue: { op: '<=', value: { k: 'const', n: 2 } }
				},
				{
					state,
					controllerId: p1.playerId,
					xValue: 3
				}
			),
			true,
			'X=3 caller must not leak its xValue into another {X} stack spell whose own X is not 3 (CR 202.3e, R8)'
		);

		// 2. A non-X stack spell with xValue set on its StackItem still has its printed MV
		const nonXStackItem = {
			id: `stk_${nonXInst.instanceId}`,
			sourceInstanceId: nonXInst.instanceId,
			card: nonXCard,
			ownerId: p2.playerId,
			controllerId: p2.playerId,
			kind: 'spell' as const,
			title: nonXCard.name,
			oracleText: nonXCard.oracleText,
			targets: [],
			xValue: 3,
			castMode: 'normal' as const,
			requiresGuidedResolution: false,
			createdAt: 0
		};
		state.stack.push(nonXStackItem);
		assert.equal(
			objectManaValue(state, nonXStackItem),
			2,
			'Non-{X} stack spell with xValue set must still have its printed MV (CR 202.3e, R8)'
		);
		assert.equal(
			objectManaValue(state, nonXInst),
			2,
			'Non-{X} stack CardInstance whose StackItem has xValue set must still have its printed MV (CR 202.3e, R8)'
		);
	});

	it('R9: playerCommanderCastCount reads player.commanderCastCounts without scanning zones and matches the zone-scan count across casting a commander twice (CR 903.8)', () => {
		const { state, p1, p2 } = makeGame([false, false]);

		function legacyZoneScanCommanderCastCount(st: GameState, playerId: string): number {
			const player = st.players.find((p) => p.playerId === playerId);
			if (!player) return 0;
			const byId = new Map<string, number>();
			if (player.commanderCastCounts) {
				for (const [id, count] of Object.entries(player.commanderCastCounts)) {
					if (count > 0) byId.set(id, count);
				}
			}
			const zones = ['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command'] as const;
			for (const p of st.players) {
				for (const z of zones) {
					for (const c of p[z]) {
						if (
							c.ownerId === playerId &&
							c.isCommander &&
							(c.commanderCastCount ?? 0) > (byId.get(c.instanceId) ?? 0)
						) {
							byId.set(c.instanceId, c.commanderCastCount);
						}
					}
				}
			}
			for (const item of st.stack) {
				if (
					(item.ownerId ?? item.controllerId) === playerId &&
					(item.commanderCastCount ?? 0) > (byId.get(item.sourceInstanceId) ?? 0)
				) {
					byId.set(item.sourceInstanceId, item.commanderCastCount!);
				}
			}
			let total = 0;
			for (const v of byId.values()) total += v;
			return total;
		}

		const cmd = p1.command[0]!;
		assert.ok(cmd && cmd.isCommander, 'p1 starts with commander in command zone');

		// Step 0: before casting
		assert.equal(playerCommanderCastCount(state, p1.playerId), 0);
		assert.equal(
			playerCommanderCastCount(state, p1.playerId),
			legacyZoneScanCommanderCastCount(state, p1.playerId)
		);

		// Cast commander #1 from command zone ({1}{G})
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 10, C: 0 };
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cmd.instanceId,
				fromZone: 'command'
			}).ok,
			true
		);
		// Step 1: on stack after 1st cast
		assert.equal(playerCommanderCastCount(state, p1.playerId), 1);
		assert.equal(
			playerCommanderCastCount(state, p1.playerId),
			legacyZoneScanCommanderCastCount(state, p1.playerId)
		);

		// Resolve 1st cast -> enters battlefield
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(playerCommanderCastCount(state, p1.playerId), 1);
		assert.equal(
			playerCommanderCastCount(state, p1.playerId),
			legacyZoneScanCommanderCastCount(state, p1.playerId)
		);

		// Kill commander via SBA and return to command zone
		const cmdOnBf = p1.battlefield.find((c) => c.instanceId === cmd.instanceId)!;
		cmdOnBf.damageMarked = 2;
		checkStateBasedActions(state);
		const cmdPrompt = state.pendingPrompts.find((pr) => pr.kind === 'commander_zone_choice');
		assert.ok(cmdPrompt, 'Expected commander_zone_choice SBA prompt for human commander owner (CR 903.9a)');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: cmdPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1.command.some((c) => c.instanceId === cmd.instanceId), true);
		assert.equal(playerCommanderCastCount(state, p1.playerId), 1);
		assert.equal(
			playerCommanderCastCount(state, p1.playerId),
			legacyZoneScanCommanderCastCount(state, p1.playerId)
		);

		// Cast commander #2 from command zone ({1}{G} + {2} commander tax)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cmd.instanceId,
				fromZone: 'command'
			}).ok,
			true
		);
		assert.equal(playerCommanderCastCount(state, p1.playerId), 2);
		assert.equal(
			playerCommanderCastCount(state, p1.playerId),
			legacyZoneScanCommanderCastCount(state, p1.playerId)
		);

		// Resolve 2nd cast -> enters battlefield
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(playerCommanderCastCount(state, p1.playerId), 2);
		assert.equal(
			playerCommanderCastCount(state, p1.playerId),
			legacyZoneScanCommanderCastCount(state, p1.playerId)
		);

		// Verify playerCommanderCastCount does not scan player zones (e.g. library)
		let libraryIndexReads = 0;
		const rawLibrary = p1.library;
		p1.library = new Proxy(rawLibrary, {
			get(target, prop, receiver) {
				if (typeof prop === 'string' && /^\d+$/.test(prop)) {
					libraryIndexReads += 1;
				}
				return Reflect.get(target, prop, receiver);
			}
		});
		try {
			assert.equal(playerCommanderCastCount(state, p1.playerId), 2);
			assert.equal(
				libraryIndexReads,
				0,
				'playerCommanderCastCount must read player.commanderCastCounts in O(1) without scanning player zones (R9)'
			);
		} finally {
			p1.library = rawLibrary;
		}
	});
});
