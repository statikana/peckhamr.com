import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { PRECON_DECKS } from '../precons.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Elemental',
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

function seat(i: number, id: string, username: string, isBot = false): LobbySeat {
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
	const names = ['Alice', 'Bob'];
	const seats = botSeats.map((isBot, i) => seat(i, `player_${i + 1}`, names[i], isBot));
	const state = createInitialGameState(
		'LOBBY_SLICE1',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	assert.equal(state.phase, 'main1');
	for (const p of state.players) {
		p.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
		p.fullControl = true;
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

function passBoth(state: GameState): void {
	const safety = 20;
	for (let i = 0; i < safety; i++) {
		if (state.pendingPrompts.length > 0) return;
		const beforeLen = state.stack.length;
		const beforeTopId = state.stack[state.stack.length - 1]?.id;
		const beforePhase = state.phase;
		const pid = state.players[state.priorityPlayerIndex].playerId;
		const res = applyGameAction(state, pid, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
		if (state.pendingPrompts.length > 0) return;
		const afterTopId = state.stack[state.stack.length - 1]?.id;
		if (state.stack.length !== beforeLen || afterTopId !== beforeTopId || state.phase !== beforePhase) {
			return;
		}
	}
}

function drainStack(state: GameState): void {
	for (let guard = 0; guard < 30 && state.stack.length > 0; guard++) {
		assert.equal(
			state.pendingPrompts.length,
			0,
			`Unexpected pending prompt while draining stack: ${state.pendingPrompts[0]?.title}`
		);
		passBoth(state);
	}
	assert.equal(state.stack.length, 0, 'Expected stack to drain completely');
}

function advanceToNextTurnMain1(state: GameState): void {
	const startTurn = state.turnNumber;
	const startActive = state.activePlayerIndex;
	for (let guard = 0; guard < 40; guard++) {
		if (
			(state.turnNumber > startTurn || state.activePlayerIndex !== startActive) &&
			state.phase === 'main1' &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0
		) {
			break;
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			const ans: ChoiceAnswer =
				pr.choice?.kind === 'chooseObjects'
					? {
							kind: 'chooseObjects',
							objectIds: pr.choice.candidates.slice(0, pr.choice.min)
						}
					: { kind: 'yesNo', yes: false };
			assert.equal(
				applyGameAction(state, pr.playerId, { type: 'choice', promptId: pr.id, answer: ans }).ok,
				true
			);
			continue;
		}
		const pid = state.players[state.priorityPlayerIndex].playerId;
		assert.equal(applyGameAction(state, pid, { type: 'pass_priority' }).ok, true);
	}
	for (const p of state.players) {
		p.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
	}
}

describe('Track F Slice 1: Land/Permanent Animation, Stack Copy & Retargeting, and Storm', () => {
	it('animates a land until EOT while keeping Land type & mana ability, then reverts at EOT cleanup (CR 205.1b, 613.1d-g)', () => {
		const state = setupGame();
		const [p1] = state.players;

		const forestCard = card({
			name: 'Forest',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: '({T}: Add {G}.)'
		});
		const forest = put(state, p1, forestCard, 'battlefield', { summoningSick: false });

		const animatorCard = card({
			name: 'Grove Awakener',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Elf Druid',
			power: '1',
			toughness: '3',
			oracleText:
				"{T}: Target land you control becomes a 3/3 green Elemental creature with haste until end of turn. It's still a land."
		});
		const animator = put(state, p1, animatorCard, 'battlefield', { summoningSick: false });

		const abs = getEffectiveActivatedAbilities(state, p1, animator).filter((a) => !a.isManaAbility);
		assert.equal(abs.length, 1);

		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: animator.instanceId,
			abilityId: abs[0].id,
			targets: [{ kind: 'permanent', id: forest.instanceId, label: forest.card.name }]
		});
		assert.equal(actRes.ok, true, actRes.error ?? 'activate_ability failed');
		passBoth(state);
		assert.equal(state.stack.length, 0);

		const evAnimated = evaluatePermanent(state, forest);
		assert.equal(evAnimated.isLand, true);
		assert.equal(evAnimated.isCreature, true);
		assert.equal(evAnimated.power, 3);
		assert.equal(evAnimated.toughness, 3);
		assert.deepEqual(evAnimated.colors, ['G']);
		assert.equal(evAnimated.hasSubType('Forest'), true);
		assert.equal(evAnimated.hasSubType('Elemental'), true);
		assert.equal(evAnimated.activeKeywords.includes('Haste'), true);

		// Still taps for mana because it remained a Forest and has been controlled since turn start
		const gBefore = p1.manaPool.G;
		const tapRes = applyGameAction(state, p1.playerId, {
			type: 'tap_mana',
			instanceId: forest.instanceId
		});
		assert.equal(tapRes.ok, true, tapRes.error ?? 'tap_mana failed');
		assert.equal(p1.manaPool.G, gBefore + 1);

		// Advance past EOT cleanup to P2's main1: animation expires
		advanceToNextTurnMain1(state);
		const evAfter = evaluatePermanent(state, forest);
		assert.equal(evAfter.isLand, true);
		assert.equal(evAfter.isCreature, false);
		assert.equal(evAfter.hasSubType('Elemental'), false);
	});

	it('enforces CR 302.6 summoning sickness on newly played animated lands unless granted Haste', () => {
		const state = setupGame();
		const [p1] = state.players;
		p1.maxLandsPerTurn = 2;

		const islandCard = card({
			name: 'Island',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Island',
			oracleText: '({T}: Add {U}.)'
		});
		const mountainCard = card({
			name: 'Mountain',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Mountain',
			oracleText: '({T}: Add {R}.)'
		});
		const islandInHand = put(state, p1, islandCard, 'hand');
		const mountainInHand = put(state, p1, mountainCard, 'hand');

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: islandInHand.instanceId })
				.ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: mountainInHand.instanceId
			}).ok,
			true
		);

		const slowAnimSpell = card({
			name: 'Tidal Awakening',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText:
				"Target land you control becomes a 3/3 blue Elemental creature until end of turn. It's still a land."
		});
		const fastAnimSpell = card({
			name: 'Cinder Awakening',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText:
				"Target land you control becomes a 3/3 red Elemental creature with haste until end of turn. It's still a land."
		});
		const slowInst = put(state, p1, slowAnimSpell, 'hand');
		const fastInst = put(state, p1, fastAnimSpell, 'hand');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: slowInst.instanceId,
				targets: [{ kind: 'permanent', id: islandInHand.instanceId, label: 'Island' }]
			}).ok,
			true
		);
		passBoth(state);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fastInst.instanceId,
				targets: [{ kind: 'permanent', id: mountainInHand.instanceId, label: 'Mountain' }]
			}).ok,
			true
		);
		passBoth(state);

		// Newly played Island animated WITHOUT haste cannot tap for {U} (CR 302.6)!
		const badTap = applyGameAction(state, p1.playerId, {
			type: 'tap_mana',
			instanceId: islandInHand.instanceId
		});
		assert.equal(badTap.ok, false);

		// Newly played Mountain animated WITH haste CAN tap for {R}, or untap and attack!
		// Advance to declare_attackers to test attacking with both
		for (let guard = 0; guard < 20 && state.phase !== 'declare_attackers'; guard++) {
			const pid = state.players[state.priorityPlayerIndex].playerId;
			assert.equal(applyGameAction(state, pid, { type: 'pass_priority' }).ok, true);
		}
		assert.equal(state.phase, 'declare_attackers');

		const sickAtk = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{ attackerInstanceId: islandInHand.instanceId, defenderPlayerId: state.players[1].playerId }
			]
		});
		assert.equal(sickAtk.ok, false, 'Animated newly played land without haste cannot attack');

		const hasteAtk = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{
					attackerInstanceId: mountainInHand.instanceId,
					defenderPlayerId: state.players[1].playerId
				}
			]
		});
		assert.equal(hasteAtk.ok, true, hasteAtk.error ?? 'declare_attackers failed');
	});

	it('composes Layer 7b 0/0 permanent animation with +1/+1 counters and destroys animated lands on lethal damage (CR 613.4, 704.5g)', () => {
		const state = setupGame();
		const [p1] = state.players;

		const wastes = put(
			state,
			p1,
			card({
				name: 'Wastes',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land',
				oracleText: '({T}: Add {C}.)'
			}),
			'battlefield'
		);
		wastes.counters['+1/+1'] = 3;

		const permAnim = put(
			state,
			p1,
			card({
				name: 'Awaken the Soil',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: "Target land you control becomes a 0/0 Elemental creature. It's still a land."
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: permAnim.instanceId,
				targets: [{ kind: 'permanent', id: wastes.instanceId, label: 'Wastes' }]
			}).ok,
			true
		);
		passBoth(state);

		// 0/0 base P/T + three +1/+1 counters = 3/3
		assert.equal(evaluatePermanent(state, wastes).power, 3);
		assert.equal(evaluatePermanent(state, wastes).toughness, 3);

		// Permanent duration persists across turns!
		advanceToNextTurnMain1(state);
		assert.equal(evaluatePermanent(state, wastes).isCreature, true);
		assert.equal(evaluatePermanent(state, wastes).power, 3);

		// Deal 3 lethal damage -> SBA destroys the animated land (CR 704.5g)
		const bolt = put(
			state,
			state.players[state.priorityPlayerIndex],
			card({
				name: 'Searing Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Searing Bolt deals 3 damage to any target.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, state.players[state.priorityPlayerIndex].playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: wastes.instanceId, label: 'Wastes' }]
			}).ok,
			true
		);
		passBoth(state);

		assert.equal(
			p1.battlefield.some((c) => c.instanceId === wastes.instanceId),
			false,
			'Animated land with lethal damage must be destroyed by SBA'
		);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === wastes.instanceId),
			true
		);
	});

	it('handles dynamic X/X land animation, Aura land animation (Awaken the Ancient), non-additive overwrite, and rejects quoted granted text', () => {
		const state = setupGame();
		const [p1] = state.players;

		// 1. Quoted granted text must remain unsupported (never silently dropped)
		const quotedAnim = card({
			name: 'Complex Land Shaper',
			manaCost: '{2}{G}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText:
				'Target land becomes a 3/3 creature with "Whenever this creature deals combat damage, draw a card" until end of turn.'
		});
		const compiledQuoted = compileCard(quotedAnim).faces[0];
		assert.equal(
			compiledQuoted.abilities.some((a) => a.kind === 'unsupported'),
			true,
			'Animation granting quoted rules text must stay unsupported'
		);

		// 2. Dynamic X/X land animation ("where X is the number of Allies you control")
		put(
			state,
			p1,
			card({ name: 'Ally Scout', typeLine: 'Creature — Human Ally', power: '1', toughness: '1' }),
			'battlefield'
		);
		const animist = put(
			state,
			p1,
			card({
				name: 'Vastwood Animist',
				typeLine: 'Creature — Elf Shaman Ally',
				power: '1',
				toughness: '1',
				oracleText:
					"{T}: Target land you control becomes an X/X Elemental creature until end of turn, where X is the number of Allies you control. It's still a land."
			}),
			'battlefield'
		);
		const plains = put(
			state,
			p1,
			card({
				name: 'Plains',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Plains',
				oracleText: '({T}: Add {W}.)'
			}),
			'battlefield'
		);
		const animAbs = getEffectiveActivatedAbilities(state, p1, animist).filter(
			(a) => !a.isManaAbility
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: animist.instanceId,
				abilityId: animAbs[0].id,
				targets: [{ kind: 'permanent', id: plains.instanceId, label: 'Plains' }]
			}).ok,
			true
		);
		passBoth(state);
		const evPlains = evaluatePermanent(state, plains);
		assert.equal(evPlains.isCreature, true);
		assert.equal(evPlains.isLand, true);
		assert.equal(evPlains.power, 2);
		assert.equal(evPlains.toughness, 2);

		// 3. Aura land animation: Awaken the Ancient
		const mountain = put(
			state,
			p1,
			card({
				name: 'Mountain',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Mountain',
				oracleText: '({T}: Add {R}.)'
			}),
			'battlefield',
			{ summoningSick: true }
		);
		const awaken = put(
			state,
			p1,
			card({
				name: 'Awaken the Ancient',
				manaCost: '{1}{R}{R}{R}',
				cmc: 4,
				typeLine: 'Enchantment — Aura',
				oracleText:
					"Enchant Mountain\nEnchanted Mountain is a 7/7 red Giant creature with haste. It's still a land."
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: awaken.instanceId,
				targets: [{ kind: 'permanent', id: mountain.instanceId, label: 'Mountain' }]
			}).ok,
			true
		);
		passBoth(state);

		const evMtn = evaluatePermanent(state, mountain);
		assert.equal(evMtn.isLand, true);
		assert.equal(evMtn.isCreature, true);
		assert.equal(evMtn.power, 7);
		assert.equal(evMtn.toughness, 7);
		assert.deepEqual(evMtn.colors, ['R']);
		assert.equal(evMtn.hasSubType('Mountain'), true);
		assert.equal(evMtn.hasSubType('Giant'), true);
		assert.equal(evMtn.activeKeywords.includes('Haste'), true);
		// Because Awaken grants Haste, even a summoning-sick Mountain can tap for {R}!
		const rBefore = p1.manaPool.R;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: mountain.instanceId }).ok,
			true
		);
		assert.equal(p1.manaPool.R, rBefore + 1);

		// Destroy the Aura -> Mountain cleanly reverts to a non-creature Land
		const naturalize = put(
			state,
			p1,
			card({
				name: 'Disenchant',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target artifact or enchantment.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: naturalize.instanceId,
				targets: [{ kind: 'permanent', id: awaken.instanceId, label: 'Awaken the Ancient' }]
			}).ok,
			true
		);
		passBoth(state);
		const evReverted = evaluatePermanent(state, mountain);
		assert.equal(evReverted.isLand, true);
		assert.equal(evReverted.isCreature, false);
		assert.equal(evReverted.hasSubType('Giant'), false);
		assert.equal(evReverted.hasSubType('Mountain'), true);

		// 4. Non-additive animation overwrites prior card types (CR 205.1a)
		const relic = put(
			state,
			p1,
			card({ name: 'Darksteel Relic', typeLine: 'Artifact', oracleText: '' }),
			'battlefield'
		);
		const reshape = put(
			state,
			p1,
			card({
				name: 'Flesh Sculpt',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Target artifact becomes a 4/4 Construct creature until end of turn.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: reshape.instanceId,
				targets: [{ kind: 'permanent', id: relic.instanceId, label: 'Darksteel Relic' }]
			}).ok,
			true
		);
		passBoth(state);
		const evRelic = evaluatePermanent(state, relic);
		assert.equal(evRelic.isCreature, true);
		assert.equal(evRelic.isArtifact, false, 'CR 205.1a: non-additive animation overwrites Artifact');
		assert.equal(evRelic.power, 4);
		assert.equal(evRelic.hasSubType('Construct'), true);
	});

	it('supports copySpell with pausable human retargeting (JSON round-trip safe), declined retargeting fizzle, and bot threat retargeting (CR 707.10c)', () => {
		const state = setupGame();
		const [p1, p2] = state.players;

		const bear1 = put(
			state,
			p2,
			card({ name: 'Grizzly Bears', power: '2', toughness: '2', typeLine: 'Creature — Bear' }),
			'battlefield'
		);
		const bear2 = put(
			state,
			p2,
			card({ name: 'Runeclaw Bear', power: '2', toughness: '2', typeLine: 'Creature — Bear' }),
			'battlefield'
		);

		const bolt = put(
			state,
			p1,
			card({
				name: 'Lightning Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Lightning Bolt deals 3 damage to any target.'
			}),
			'hand'
		);
		const reverb = put(
			state,
			p1,
			card({
				name: 'Reverberate',
				manaCost: '{R}{R}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: bear1.instanceId, label: bear1.card.name }]
			}).ok,
			true
		);
		const boltStackId = state.stack[0].id;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: reverb.instanceId,
				targets: [{ kind: 'stack', id: boltStackId, label: 'Lightning Bolt' }]
			}).ok,
			true
		);

		// Resolve Reverberate -> pauses for yesNo retarget prompt
		passBoth(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].choice?.kind, 'yesNo');

		// Round-trip GameState through plain JSON while paused!
		let rtState: GameState = JSON.parse(JSON.stringify(state));
		assert.equal(
			applyGameAction(rtState, p1.playerId, {
				type: 'choice',
				promptId: rtState.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);

		// Now paused for chooseObjects target slot prompt; round-trip again!
		assert.equal(rtState.pendingPrompts.length, 1);
		assert.equal(rtState.pendingPrompts[0].choice?.kind, 'chooseObjects');
		rtState = JSON.parse(JSON.stringify(rtState));
		assert.equal(
			applyGameAction(rtState, p1.playerId, {
				type: 'choice',
				promptId: rtState.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [bear2.instanceId] }
			}).ok,
			true
		);
		assert.equal(rtState.pendingPrompts.length, 0);
		assert.equal(rtState.stack.length, 2, 'Original Bolt + Copy of Bolt on stack');
		assert.equal(rtState.stack[1].isCopy, true);
		assert.equal(rtState.stack[1].targets[0].id, bear2.instanceId);

		// Resolve copy first -> Bear 2 dies, Bear 1 still alive
		passBoth(rtState);
		assert.equal(
			rtState.players[1].battlefield.some((c) => c.instanceId === bear2.instanceId),
			false
		);
		assert.equal(
			rtState.players[1].battlefield.some((c) => c.instanceId === bear1.instanceId),
			true
		);

		// Resolve original Bolt -> Bear 1 dies too
		passBoth(rtState);
		assert.equal(
			rtState.players[1].battlefield.some((c) => c.instanceId === bear1.instanceId),
			false
		);

		// Declining retarget when original target became illegal keeps illegal target and fizzles copy (CR 707.10c)
		const bear3 = put(
			rtState,
			rtState.players[1],
			card({ name: 'Ashcoat Bear', power: '2', toughness: '2', typeLine: 'Creature — Bear' }),
			'battlefield'
		);
		const bear4 = put(
			rtState,
			rtState.players[1],
			card({ name: 'Balduvian Bears', power: '2', toughness: '2', typeLine: 'Creature — Bear' }),
			'battlefield'
		);
		const murder = put(
			rtState,
			rtState.players[0],
			card({
				name: 'Murder',
				manaCost: '{1}{B}{B}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		const fork = put(
			rtState,
			rtState.players[0],
			card({
				name: 'Twincast',
				manaCost: '{U}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.'
			}),
			'hand'
		);
		const sacrificeInstant = put(
			rtState,
			rtState.players[1],
			card({
				name: 'Altar Reap',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Exile target creature you control.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(rtState, rtState.players[0].playerId, {
				type: 'cast_spell',
				instanceId: murder.instanceId,
				targets: [{ kind: 'permanent', id: bear3.instanceId, label: bear3.card.name }]
			}).ok,
			true
		);
		const murderStkId = rtState.stack[0].id;
		assert.equal(
			applyGameAction(rtState, rtState.players[0].playerId, {
				type: 'cast_spell',
				instanceId: fork.instanceId,
				targets: [{ kind: 'stack', id: murderStkId, label: 'Murder' }]
			}).ok,
			true
		);
		// Pass priority to P2 so P2 exiles bear3 in response before Twincast resolves!
		assert.equal(
			applyGameAction(rtState, rtState.players[0].playerId, { type: 'pass_priority' }).ok,
			true
		);
		assert.equal(
			applyGameAction(rtState, rtState.players[1].playerId, {
				type: 'cast_spell',
				instanceId: sacrificeInstant.instanceId,
				targets: [{ kind: 'permanent', id: bear3.instanceId, label: bear3.card.name }]
			}).ok,
			true
		);
		passBoth(rtState); // Exile bear3
		assert.equal(
			rtState.players[1].battlefield.some((c) => c.instanceId === bear3.instanceId),
			false
		);

		// Resolve Twincast -> P1 declines retargeting (keeps illegal bear3 target)
		passBoth(rtState);
		assert.equal(rtState.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(rtState, rtState.players[0].playerId, {
				type: 'choice',
				promptId: rtState.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		assert.equal(rtState.stack.length, 2);
		assert.equal(rtState.stack[1].targets[0].id, bear3.instanceId);
		passBoth(rtState); // Copy fizzles on illegal target bear3; bear4 survives!
		assert.equal(
			rtState.players[1].battlefield.some((c) => c.instanceId === bear4.instanceId),
			true
		);
		passBoth(rtState); // Original Murder also fizzles

		// Bot retargets opponent's harmful spell onto opponent when copying!
		const botState = setupGame([false, true]);
		const [human, bot] = botState.players;
		const humanBurn = put(
			botState,
			human,
			card({
				name: 'Lava Spike',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Lava Spike deals 3 damage to any target.'
			}),
			'hand'
		);
		const botFork = put(
			botState,
			bot,
			card({
				name: 'Echo Fork',
				manaCost: '{R}{R}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(botState, human.playerId, {
				type: 'cast_spell',
				instanceId: humanBurn.instanceId,
				targets: [{ kind: 'player', id: bot.playerId, label: bot.username }]
			}).ok,
			true
		);
		const spikeStkId = botState.stack[0].id;
		assert.equal(applyGameAction(botState, human.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(botState, bot.playerId, {
				type: 'cast_spell',
				instanceId: botFork.instanceId,
				targets: [{ kind: 'stack', id: spikeStkId, label: 'Lava Spike' }]
			}).ok,
			true
		);
		const humanLifeBefore = human.life;
		passBoth(botState); // Echo Fork resolves -> bot retargets copy onto human!
		assert.equal(botState.stack[botState.stack.length - 1].targets[0].id, human.playerId);
		passBoth(botState); // Copy resolves -> deals 3 damage to human!
		assert.equal(human.life, humanLifeBefore - 3);
	});

	it('emits BecameTarget and triggers Ward when a spell copy is retargeted onto a permanent with Ward (including animated land granted ward {3})', () => {
		const state = setupGame();
		const [p1, p2] = state.players;

		const bear = put(
			state,
			p2,
			card({ name: 'Target Dummy', power: '2', toughness: '2', typeLine: 'Creature — Construct' }),
			'battlefield'
		);
		const stormGiantsLand = put(
			state,
			p2,
			card({
				name: 'Hall of Storm Giants',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText:
					"{T}: Add {U}.\n{5}{U}: Hall of Storm Giants becomes a 7/7 blue Giant creature with ward {3} until end of turn. It's still a land."
			}),
			'battlefield'
		);

		// Pass priority to P2 so P2 animates Hall of Storm Giants (gains Ward {3})
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		const hallAbs = getEffectiveActivatedAbilities(state, p2, stormGiantsLand).filter(
			(a) => !a.isManaAbility
		);
		assert.equal(hallAbs.length, 1);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: stormGiantsLand.instanceId,
				abilityId: hallAbs[0].id
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(evaluatePermanent(state, stormGiantsLand).isCreature, true);
		assert.equal(evaluatePermanent(state, stormGiantsLand).power, 7);

		// Drain P1's mana after casting Doom Blade + Twincast so P1 CANNOT pay Ward {3}
		p1.manaPool = { W: 0, U: 2, B: 2, R: 0, G: 0, C: 0 };
		const doom = put(
			state,
			p1,
			card({
				name: 'Murder',
				manaCost: '{B}{B}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		const twincast = put(
			state,
			p1,
			card({
				name: 'Twincast',
				manaCost: '{U}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doom.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		const doomStkId = state.stack[0].id;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: twincast.instanceId,
				targets: [{ kind: 'stack', id: doomStkId, label: 'Murder' }]
			}).ok,
			true
		);

		// Resolve Twincast -> retarget copy onto Hall of Storm Giants!
		passBoth(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [stormGiantsLand.instanceId] }
			}).ok,
			true
		);

		// Ward {3} triggered on top of the Murder copy!
		assert.equal(state.stack.length, 3, 'Murder + Murder (Copy) + Ward trigger on stack');
		assert.equal(state.stack[2].title.includes('Ward'), true);

		// Resolve Ward {3}: P1 has 0 mana left -> Murder (Copy) is countered by Ward!
		passBoth(state);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === stormGiantsLand.instanceId),
			true,
			'Hall of Storm Giants survived because Ward {3} countered the retargeted copy'
		);
		assert.equal(state.stack.length, 1, 'Only original Murder remains on stack');
	});

	it('copies activated and triggered abilities while retaining source identity and never targeting mana abilities (CR 707.10b)', () => {
		const state = setupGame();
		const [p1, p2] = state.players;

		// Mana ability never uses the stack
		const forest = put(
			state,
			p1,
			card({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			}),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: forest.instanceId }).ok,
			true
		);
		assert.equal(state.stack.length, 0, 'Mana abilities never go on the stack');

		// Creature whose activated ability deals damage equal to ITS power ("~ deals damage equal to its power to any target")
		const archer = put(
			state,
			p1,
			card({
				name: 'Heavy Crossbowman',
				power: '4',
				toughness: '3',
				typeLine: 'Creature — Human Archer',
				oracleText: '{T}: Heavy Crossbowman deals damage equal to its power to any target.'
			}),
			'battlefield'
		);
		const resonator = put(
			state,
			p1,
			card({
				name: 'Lithoform Resonator',
				typeLine: 'Artifact',
				oracleText:
					'{2}, {T}: Copy target activated or triggered ability you control. You may choose new targets for the copy.'
			}),
			'battlefield'
		);
		const magecraftWatcher = put(
			state,
			p1,
			card({
				name: 'Spellcraft Scholar',
				power: '2',
				toughness: '2',
				typeLine: 'Creature — Human Wizard',
				oracleText:
					'Whenever you cast or copy an instant or sorcery spell, you gain 1 life.'
			}),
			'battlefield'
		);

		const oppBear = put(
			state,
			p2,
			card({ name: 'Hill Giant', power: '3', toughness: '3', typeLine: 'Creature — Giant' }),
			'battlefield'
		);

		const archerAbs = getEffectiveActivatedAbilities(state, p1, archer).filter(
			(a) => !a.isManaAbility
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: archer.instanceId,
				abilityId: archerAbs[0].id,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		const archerStkId = state.stack[0].id;

		const resAbs = getEffectiveActivatedAbilities(state, p1, resonator).filter(
			(a) => !a.isManaAbility
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: resonator.instanceId,
				abilityId: resAbs[0].id,
				targets: [{ kind: 'stack', id: archerStkId, label: state.stack[0].title }]
			}).ok,
			true
		);

		const p1LifeBefore = p1.life;
		const p2LifeBefore = p2.life;
		passBoth(state); // Resolve Resonator -> prompts to retarget copied ability
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [oppBear.instanceId] }
			}).ok,
			true
		);

		// CR 707.10b: ability copy retains archer.instanceId as sourceInstanceId and does NOT fire SpellCopied!
		assert.equal(state.stack.length, 2);
		assert.equal(state.stack[1].sourceInstanceId, archer.instanceId);
		assert.equal(p1.life, p1LifeBefore, 'Copying an ability does not emit SpellCopied');
		void magecraftWatcher;

		// Resolve copied ability -> deals 4 (archer's power!) to Hill Giant, destroying it!
		passBoth(state);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === oppBear.instanceId),
			false,
			'Copied ability read source power = 4 via retained sourceInstanceId (CR 707.10b)'
		);

		// Resolve original ability -> deals 4 damage to P2
		passBoth(state);
		assert.equal(p2.life, p2LifeBefore - 4);
	});

	it('resolves copied permanent spells as tokens without triggering token doublers, and supports nonLegendary exception (CR 707.10f)', () => {
		const state = setupGame();
		const [p1] = state.players;

		// Token doubler on board: must NOT double permanent spell copies (CR 707.10f)!
		put(
			state,
			p1,
			card({
				name: 'Anointed Procession',
				typeLine: 'Enchantment',
				oracleText:
					'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.'
			}),
			'battlefield'
		);

		const legend = put(
			state,
			p1,
			card({
				name: 'Isamaru, Hound of Konda',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Legendary Creature — Dog',
				power: '2',
				toughness: '2',
				oracleText: ''
			}),
			'hand'
		);
		const doubleMajor = put(
			state,
			p1,
			card({
				name: 'Double Major',
				manaCost: '{G}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: "Copy target creature spell you control, except it isn't legendary."
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: legend.instanceId
			}).ok,
			true
		);
		const legendStkId = state.stack[0].id;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doubleMajor.instanceId,
				targets: [{ kind: 'stack', id: legendStkId, label: legend.card.name }]
			}).ok,
			true
		);

		passBoth(state); // Double Major resolves -> creates spell copy on stack
		assert.equal(state.stack.length, 2);
		assert.equal(state.stack[1].isCopy, true);

		passBoth(state); // Copy resolves -> becomes a nonlegendary token permanent!
		passBoth(state); // Original resolves -> enters as legendary permanent; NO legend rule conflict!

		const dogs = p1.battlefield.filter((c) => c.card.name === 'Isamaru, Hound of Konda');
		assert.equal(dogs.length, 2, 'Exactly 1 token copy + 1 nontoken original (not doubled by Procession, no legend rule SBA)');
		const tokenDog = dogs.find((d) => d.isToken)!;
		const origDog = dogs.find((d) => !d.isToken)!;
		assert.ok(tokenDog);
		assert.ok(origDog);
		assert.equal(evaluatePermanent(state, tokenDog).isLegendary, false);
		assert.equal(evaluatePermanent(state, origDog).isLegendary, true);
	});

	it('implements Storm (CR 702.40a-b): turn reset, all-player count, response-spell snapshot, countered-original LKI, multiple Storm instances, and no Storm chain on copies', () => {
		const state = setupGame();
		const [p1, p2] = state.players;

		// Cast a spell on Turn 1, then pass to Turn 2 to prove spellsCastThisTurn resets for ALL players!
		const turn1Cantrip = put(
			state,
			p1,
			card({ name: 'Opt', manaCost: '{U}', cmc: 1, typeLine: 'Instant', oracleText: 'Draw a card.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: turn1Cantrip.instanceId
			}).ok,
			true
		);
		passBoth(state);
		advanceToNextTurnMain1(state); // Now on P2's turn (Turn 2)

		// 1. Storm with 0 prior spells this turn -> 0 copies
		const zeroStorm = put(
			state,
			p2,
			card({
				name: 'Grapeshot Zero',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Grapeshot Zero deals 1 damage to any target.\nStorm'
			}),
			'hand'
		);
		const p1LifeStart = p1.life;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: zeroStorm.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2, 'Original spell + Storm trigger');
		passBoth(state); // Storm trigger resolves with stormCount = 0 -> 0 copies
		assert.equal(state.stack.length, 1);
		passBoth(state); // Original resolves -> 1 damage total
		assert.equal(p1.life, p1LifeStart - 1);

		// Advance to P1's turn so we have a fresh turn for full Storm test
		advanceToNextTurnMain1(state);

		const magecraft = put(
			state,
			p1,
			card({
				name: 'Stormkiln Apprentice',
				power: '2',
				toughness: '2',
				typeLine: 'Creature — Dwarf Shaman',
				oracleText:
					'Whenever you cast or copy an instant or sorcery spell, you gain 1 life.'
			}),
			'battlefield'
		);
		void magecraft;

		// Spell #1 this turn: P1 casts a ritual
		const s1 = put(
			state,
			p1,
			card({
				name: 'Desperate Ritual',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Add {R}{R}{R}.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok,
			true
		);
		// Spell #2 this turn: Opponent P2 casts an instant! (Storm counts ALL players' spells!)
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		const s2Opp = put(
			state,
			p2,
			card({
				name: 'Peek',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Draw a card.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: s2Opp.instanceId }).ok,
			true
		);
		passBoth(state); // Peek resolves
		passBoth(state); // Magecraft trigger from Desperate Ritual or Desperate Ritual itself resolves
		drainStack(state);

		const targetCreature = put(
			state,
			p2,
			card({ name: 'Goblin Piker', power: '2', toughness: '1', typeLine: 'Creature — Goblin' }),
			'battlefield'
		);

		// Spell #3 this turn: P1 casts Grapeshot (stormCount must lock at 2!)
		const grapeshot = put(
			state,
			p1,
			card({
				name: 'Grapeshot',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Grapeshot deals 1 damage to any target.\nStorm'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: grapeshot.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		// P1 has two simultaneous cast triggers (Storm + Magecraft); order Magecraft to resolve first so p1LifeBeforeCopies isolates the 2 copy triggers
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].choice?.kind === 'orderObjects') {
			const orderIds = [...state.pendingPrompts[0].choice.objectIds].sort((a, b) => {
				const aStorm = state.stack.find((s) => s.id === a)?.title.includes('(Storm)') ? 1 : 0;
				const bStorm = state.stack.find((s) => s.id === b)?.title.includes('(Storm)') ? 1 : 0;
				return aStorm - bStorm;
			});
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'orderObjects', topIds: orderIds }
				}).ok,
				true
			);
		}
		const grapeshotStkId = state.stack.find((s) => s.kind === 'spell' && s.card.name === 'Grapeshot')!.id;

		// In response to the Storm trigger, P2 counters the original Grapeshot!
		// This BOTH casts a spell *after* Grapeshot (must NOT inflate stormCount from 2 to 3!)
		// AND removes the original Grapeshot from the stack (must STILL produce 2 copies via LKI!).
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		const counterspell = put(
			state,
			p2,
			card({
				name: 'Counterspell',
				manaCost: '{U}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Counter target spell.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: counterspell.instanceId,
				targets: [{ kind: 'stack', id: grapeshotStkId, label: 'Grapeshot' }]
			}).ok,
			true
		);
		passBoth(state); // Counterspell resolves -> original Grapeshot countered!
		assert.equal(
			state.stack.some((s) => s.id === grapeshotStkId),
			false,
			'Original Grapeshot was countered'
		);
		// If Magecraft trigger is currently on top of Storm trigger, resolve Magecraft first so Storm is on top
		for (
			let guard = 0;
			guard < 15 &&
			state.stack.length > 0 &&
			!state.stack[state.stack.length - 1].title.includes('(Storm)');
			guard++
		) {
			assert.equal(state.pendingPrompts.length, 0);
			passBoth(state);
		}

		const p1LifeBeforeCopies = p1.life;
		const p2LifeBeforeCopies = p2.life;

		// Resolve Storm trigger -> prompts for Copy #1 (decline -> keeps p2) and Copy #2 (accept -> retarget onto Goblin Piker)
		passBoth(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		// Immediately prompts for Copy #2!
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [targetCreature.instanceId] }
			}).ok,
			true
		);
		// Both Grapeshot copies triggered Magecraft simultaneously -> P1 orders the 2 Magecraft triggers (CR 603.3b)
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].choice?.kind === 'orderObjects') {
			const orderIds = [...state.pendingPrompts[0].choice.objectIds];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'orderObjects', topIds: orderIds }
				}).ok,
				true
			);
		}
		assert.equal(state.pendingPrompts.length, 0);

		// Exactly 2 Grapeshot copies + 2 Magecraft triggers (NO extra Storm triggers from copies!)
		const stormTriggersOnStack = state.stack.filter((s) => s.title.includes('(Storm)'));
		assert.equal(stormTriggersOnStack.length, 0, 'Storm copies must NOT re-trigger Storm');
		const grapeshotCopiesOnStack = state.stack.filter(
			(s) => s.kind === 'spell' && s.isCopy && s.card.name === 'Grapeshot'
		);
		assert.equal(
			grapeshotCopiesOnStack.length,
			2,
			'Storm locked stormCount = 2 at cast time despite Counterspell cast in response and original countered'
		);

		drainStack(state);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === targetCreature.instanceId),
			false,
			'Copy #2 killed Goblin Piker'
		);
		assert.equal(p2.life, p2LifeBeforeCopies - 1, 'Copy #1 dealt 1 damage to P2');
		assert.equal(p1.life, p1LifeBeforeCopies + 2, 'Magecraft triggered for each of the 2 spell copies');

		// Multiple instances of Storm trigger separately (CR 702.40b)
		// Spells cast so far this turn: s1 (1), s2Opp (2), grapeshot (3), counterspell (4) -> next spell sees stormCount = 4 per Storm instance!
		const doubleStorm = put(
			state,
			p1,
			card({
				name: 'Twin Tempest',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.\nStorm\nStorm'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doubleStorm.instanceId
			}).ok,
			true
		);
		const twinStormTriggers = state.stack.filter((s) => s.title.includes('(Storm)'));
		assert.equal(
			twinStormTriggers.length,
			2,
			'CR 702.40b: Two printed instances of Storm trigger separately'
		);
		assert.equal(twinStormTriggers[0].stormCount, 4);
		assert.equal(twinStormTriggers[1].stormCount, 4);
	});

	it('executes land animation, spell/ability copying, and Storm identically on arbitrarily named synthetic cards (rename invariance)', () => {
		const state = setupGame();
		const [p1, p2] = state.players;

		const synthLand = put(
			state,
			p1,
			card({
				name: 'Zyxwvut Basin 9001',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText:
					"{T}: Add {G}.\n{1}: Zyxwvut Basin 9001 becomes a 4/5 white and blue Construct artifact creature with flying and vigilance until end of turn. It's still a land."
			}),
			'battlefield'
		);
		const landAbs = getEffectiveActivatedAbilities(state, p1, synthLand).filter(
			(a) => !a.isManaAbility
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: synthLand.instanceId,
				abilityId: landAbs[0].id
			}).ok,
			true
		);
		passBoth(state);

		const ev = evaluatePermanent(state, synthLand);
		assert.equal(ev.isLand, true);
		assert.equal(ev.isArtifact, true);
		assert.equal(ev.isCreature, true);
		assert.equal(ev.power, 4);
		assert.equal(ev.toughness, 5);
		assert.deepEqual(ev.colors, ['W', 'U']);
		assert.equal(ev.hasSubType('Construct'), true);
		assert.equal(ev.activeKeywords.includes('Flying'), true);
		assert.equal(ev.activeKeywords.includes('Vigilance'), true);

		// Cast 1 synthetic spell, then a synthetic Storm spell, and copy one of its copies with a synthetic Dualcaster ETB creature!
		const cantrip = put(
			state,
			p1,
			card({
				name: 'Qwert Cantrip Alpha',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Draw a card.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: cantrip.instanceId }).ok,
			true
		);
		passBoth(state);

		const stormPing = put(
			state,
			p1,
			card({
				name: 'Fghjk Barrage Beta',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Fghjk Barrage Beta deals 2 damage to target opponent.\nStorm'
			}),
			'hand'
		);
		const p2Start = p2.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: stormPing.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		// Only 1 opponent exists so no retarget alternative exists -> Storm copy goes straight onto stack!
		passBoth(state);
		assert.equal(state.stack.length, 2, 'Original + 1 Storm copy');

		// Flash in a synthetic Dualcaster-style creature targeting the Storm spell on the stack!
		const flashForker = put(
			state,
			p1,
			card({
				name: 'Mnbvc Echoer Gamma',
				manaCost: '{1}{R}{R}',
				cmc: 3,
				typeLine: 'Creature — Weird',
				power: '2',
				toughness: '2',
				oracleText:
					'Flash\nWhen Mnbvc Echoer Gamma enters, copy target instant or sorcery spell. You may choose new targets for the copy.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flashForker.instanceId
			}).ok,
			true
		);
		passBoth(state); // Creature resolves -> ETB trigger targets a spell on the stack
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].choice?.kind === 'chooseObjects') {
			const cands = state.pendingPrompts[0].choice.candidates;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [cands[0]] }
				}).ok,
				true
			);
		}
		drainStack(state);

		// Original (2) + Storm copy (2) + ETB copy (2) = 6 damage total!
		assert.equal(p2.life, p2Start - 6);
	});
});
