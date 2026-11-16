import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { allocateTimestamp, attachObject, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

function synCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `p2_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
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

function assertFullySupported(card: ScryfallCard): void {
	const def = compileCard(card);
	const report = definitionSupportReport(def);
	assert.equal(
		report.fullySupported,
		true,
		`Expected "${card.name}" (${card.oracleText}) to be fully supported, got gaps: ${JSON.stringify(report.unsupported)}`
	);
}

function makeTwoPlayerGame(): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `P${i + 1}`,
		avatarUrl: '',
		isBot: false,
		deckId: PRECON_DECKS[i].id,
		deckName: PRECON_DECKS[i].name,
		commanderNames: PRECON_DECKS[i].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: PRECON_DECKS[i].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
	const state = createInitialGameState(
		'TRACK_P2_TEST',
		seats,
		new Map([
			[0, PRECON_DECKS[0]],
			[1, PRECON_DECKS[1]]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (let i = 0; i < state.players.length; i++) {
		assert.equal(applyGameAction(state, state.players[i].playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (let i = 0; i < state.players.length; i++) {
		const p = state.players[i];
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = { W: 15, U: 15, B: 15, R: 15, G: 15, C: 15 };
		p.fullControl = true;
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const ts = allocateTimestamp(state);
	const inst = createCardInstance(card, player.playerId, zone, false, false, ts, state);
	if (zone === 'battlefield') inst.summoningSick = false;
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		insert: zone === 'library' ? 'start' : 'end',
		bumpVersion: true
	});
	noteLayerInputsChanged(state);
	return inst;
}

function resolveAllStack(state: GameState, maxSteps = 40): void {
	for (let guard = 0; guard < maxSteps; guard++) {
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			if (pr.purpose === 'trigger_order' && pr.choice?.kind === 'orderObjects') {
				const r = applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: {
						kind: 'orderObjects',
						topIds: pr.choice.objectIds,
						bottomIds: [],
						shuffle: false
					}
				});
				assert.equal(r.ok, true);
				continue;
			}
			if (pr.purpose === 'trigger_may') {
				const r = applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'yesNo', yes: true }
				});
				assert.equal(r.ok, true);
				continue;
			}
			assert.fail(`Unexpected pending prompt during stack resolution: ${pr.purpose ?? pr.kind}`);
		}
		if (state.stack.length === 0) return;
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `pass_priority failed: ${res.ok ? '' : res.error}`);
	}
	assert.equal(state.stack.length, 0, 'Stack failed to empty within bounded steps');
}

function resolveTopStackItemOnly(state: GameState, maxSteps = 12): void {
	const topItem = state.stack[state.stack.length - 1];
	assert.ok(topItem, 'Expected at least 1 item on stack');
	const topId = topItem.id;
	for (let guard = 0; guard < maxSteps; guard++) {
		if (!state.stack.some((it) => it.id === topId)) return;
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `pass_priority failed: ${res.ok ? '' : res.error}`);
	}
	assert.equal(
		state.stack.some((it) => it.id === topId),
		false,
		'Top stack item did not resolve within bounded steps'
	);
}

function advanceUntil(
	state: GameState,
	predicate: (s: GameState) => boolean,
	maxSteps = 80
): void {
	for (let guard = 0; guard < maxSteps; guard++) {
		if (predicate(state)) return;
		for (let pi = 0; pi < state.players.length; pi++) {
			const pl = state.players[pi];
			if (pl.hand.length > state.rules.maxHandSize) {
				pl.hand.length = state.rules.maxHandSize;
			}
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			if (pr.kind === 'discard_to_hand_size' && pr.candidateInstanceIds?.length) {
				const r = applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [pr.candidateInstanceIds[0]] }
				});
				assert.equal(r.ok, true);
				continue;
			}
			assert.fail(`Unexpected prompt while advancing phases: ${pr.purpose ?? pr.kind}`);
		}
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `advanceUntil pass_priority failed: ${res.ok ? '' : res.error}`);
	}
	assert.equal(predicate(state), true, 'advanceUntil predicate not reached within bounded steps');
}

describe('Track P2 Part 1: Two-Target Fight & Power-Damage Bite (CR 701.14, 608.2b, 608.2h, 115.3)', () => {
	it('resolves two-target fight with Deathtouch/Lifelink as noncombat damage and aborts fight if one leaves (CR 701.14a,b,d)', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const pitFight = synCard({
			name: 'Arena Pit Clash',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Target creature you control fights target creature an opponent controls.'
		});
		assertFullySupported(pitFight);

		const viper = putInZone(
			state,
			p1,
			synCard({
				name: 'Venomfang Striker',
				typeLine: 'Creature — Snake',
				power: '2',
				toughness: '4',
				oracleText:
					'Deathtouch, lifelink\nWhenever Venomfang Striker deals combat damage to a creature, draw a card.',
				keywords: ['Deathtouch', 'Lifelink']
			}),
			'battlefield'
		);
		const colossus = putInZone(
			state,
			p2,
			synCard({
				name: 'Granite Colossus',
				typeLine: 'Creature — Golem',
				power: '3',
				toughness: '7'
			}),
			'battlefield'
		);
		const spellInst = putInZone(state, p1, pitFight, 'hand');
		const lifeBefore = p1.life;

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spellInst.instanceId,
			targets: [
				{ kind: 'permanent', id: viper.instanceId, label: viper.card.name },
				{ kind: 'permanent', id: colossus.instanceId, label: colossus.card.name }
			]
		});
		assert.equal(castRes.ok, true);
		resolveAllStack(state);

		// Viper dealt 2 Deathtouch + Lifelink noncombat damage (killing 3/7 Colossus, gaining 2 life, drawing 0 cards)
		assert.equal(p1.life, lifeBefore + 2, 'Lifelink applies on fight damage');
		assert.equal(p1.hand.length, 0, 'Fight damage is noncombat damage (CR 701.14d)');
		assert.equal(viper.damageMarked, 3, 'Viper took 3 fight damage back');
		assert.equal(
			p2.graveyard.some((c) => c.instanceId === colossus.instanceId),
			true,
			'Deathtouch fight damage destroys 3/7 creature via SBA'
		);

		// CR 701.14b: if one target leaves the battlefield in response, neither deals nor takes damage
		viper.damageMarked = 0;
		const ogre = putInZone(
			state,
			p2,
			synCard({
				name: 'Crag Brute',
				typeLine: 'Creature — Ogre',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		const fight2 = putInZone(state, p1, pitFight, 'hand');
		const killSpell = putInZone(
			state,
			p2,
			synCard({
				name: 'Sudden Snuff',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fight2.instanceId,
				targets: [
					{ kind: 'permanent', id: viper.instanceId, label: viper.card.name },
					{ kind: 'permanent', id: ogre.instanceId, label: ogre.card.name }
				]
			}).ok,
			true
		);
		// Pass priority to P2, who destroys Ogre in response
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: killSpell.instanceId,
				targets: [{ kind: 'permanent', id: ogre.instanceId, label: ogre.card.name }]
			}).ok,
			true
		);
		const lifeBeforeFizzleFight = p1.life;
		resolveAllStack(state);

		assert.equal(viper.damageMarked, 0, 'Surviving target takes 0 damage when other fighter died');
		assert.equal(p1.life, lifeBeforeFizzleFight, 'Surviving fighter does not deal Lifelink damage');
	});

	it('applies pump before fight and keeps pump when opponent target becomes illegal (CR 608.2b)', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const savageomp = synCard({
			name: 'Ferocious Pounce',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText:
				'Target creature you control gets +2/+2 until end of turn. It fights target creature an opponent controls.'
		});
		assertFullySupported(savageomp);

		const bear = putInZone(
			state,
			p1,
			synCard({
				name: 'Timber Cub',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const foe = putInZone(
			state,
			p2,
			synCard({
				name: 'Iron Sentinel',
				typeLine: 'Creature — Construct',
				power: '3',
				toughness: '4'
			}),
			'battlefield'
		);
		const pounce1 = putInZone(state, p1, savageomp, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: pounce1.instanceId,
				targets: [
					{ kind: 'permanent', id: bear.instanceId, label: bear.card.name },
					{ kind: 'permanent', id: foe.instanceId, label: foe.card.name }
				]
			}).ok,
			true
		);
		resolveAllStack(state);
		// Bear became 4/4, dealt 4 damage killing 3/4 Sentinel, and survived taking 3 damage!
		assert.equal(evaluatePermanent(state, bear).power, 4);
		assert.equal(evaluatePermanent(state, bear).toughness, 4);
		assert.equal(bear.damageMarked, 3);
		assert.equal(p2.graveyard.some((c) => c.instanceId === foe.instanceId), true);

		// Now test CR 608.2b: second creature dies in response -> spell still resolves and pumps first creature!
		const wolf = putInZone(
			state,
			p1,
			synCard({
				name: 'Ridge Wolf',
				typeLine: 'Creature — Wolf',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const victim = putInZone(
			state,
			p2,
			synCard({
				name: 'Doomed Scout',
				typeLine: 'Creature — Human',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const pounce2 = putInZone(state, p1, savageomp, 'hand');
		const zap = putInZone(
			state,
			p2,
			synCard({
				name: 'Arc Flash',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Arc Flash deals 2 damage to any target.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: pounce2.instanceId,
				targets: [
					{ kind: 'permanent', id: wolf.instanceId, label: wolf.card.name },
					{ kind: 'permanent', id: victim.instanceId, label: victim.card.name }
				]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: zap.instanceId,
				targets: [{ kind: 'permanent', id: victim.instanceId, label: victim.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(evaluatePermanent(state, wolf).power, 4, 'First target still gets +2/+2 (CR 608.2b)');
		assert.equal(evaluatePermanent(state, wolf).toughness, 4);
		assert.equal(wolf.damageMarked, 0);
	});

	it('enforces CR 701.14c self-fight (2x power per rules.txt) and CR 115.3 another-target distinctness', () => {
		const { state, p1 } = makeTwoPlayerGame();
		// Note: src/lib/rules.txt CR 701.14c specifies:
		// "701.14c If a creature fights itself, it deals damage to itself equal to twice its power."
		const unrestrictedFight = synCard({
			name: 'Mirror Pit',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Target creature you control fights target creature.'
		});
		const distinctFight = synCard({
			name: 'Rival Brawl',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Target creature you control fights another target creature.'
		});
		assertFullySupported(unrestrictedFight);
		assertFullySupported(distinctFight);

		const brawler = putInZone(
			state,
			p1,
			synCard({
				name: 'Stoic Gargoyle',
				typeLine: 'Creature — Gargoyle',
				power: '3',
				toughness: '8'
			}),
			'battlefield'
		);
		const distinctInst = putInZone(state, p1, distinctFight, 'hand');
		const illegalSameTarget = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: distinctInst.instanceId,
			targets: [
				{ kind: 'permanent', id: brawler.instanceId, label: brawler.card.name },
				{ kind: 'permanent', id: brawler.instanceId, label: brawler.card.name }
			]
		});
		assert.equal(illegalSameTarget.ok, false, '"another target creature" must reject targeting the same creature twice (CR 115.3)');

		const selfFightInst = putInZone(state, p1, unrestrictedFight, 'hand');
		const legalSelfFight = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: selfFightInst.instanceId,
			targets: [
				{ kind: 'permanent', id: brawler.instanceId, label: brawler.card.name },
				{ kind: 'permanent', id: brawler.instanceId, label: brawler.card.name }
			]
		});
		assert.equal(legalSelfFight.ok, true);
		resolveAllStack(state);
		assert.equal(brawler.damageMarked, 6, 'CR 701.14c self-fight deals 2x power (6) to 3/8 creature');
	});

	it('resolves one-way power-damage bite (CR 608.2b vs CR 608.2h LKI) and disjoint damage targets', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const biteSpell = synCard({
			name: 'Venomous Lunge',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				'Target creature you control gets +2/+2 until end of turn. It deals damage equal to its power to target creature an opponent controls.'
		});
		const anyBiteSpell = synCard({
			name: 'Fierce Hurl',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Target creature you control deals damage equal to its power to any target.'
		});
		assertFullySupported(biteSpell);
		assertFullySupported(anyBiteSpell);

		const basilisk = putInZone(
			state,
			p1,
			synCard({
				name: 'Gilded Basilisk',
				typeLine: 'Creature — Basilisk',
				power: '1',
				toughness: '2',
				oracleText: 'Deathtouch, lifelink',
				keywords: ['Deathtouch', 'Lifelink']
			}),
			'battlefield'
		);
		const wurm = putInZone(
			state,
			p2,
			synCard({
				name: 'Dread Wurm',
				typeLine: 'Creature — Wurm',
				power: '6',
				toughness: '6'
			}),
			'battlefield'
		);
		const bite1 = putInZone(state, p1, biteSpell, 'hand');
		const p1LifeStart = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bite1.instanceId,
				targets: [
					{ kind: 'permanent', id: basilisk.instanceId, label: basilisk.card.name },
					{ kind: 'permanent', id: wurm.instanceId, label: wurm.card.name }
				]
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(basilisk.damageMarked, 0, 'One-way bite deals 0 damage back to biter');
		assert.equal(p1.life, p1LifeStart + 3, 'Bite uses post-pump power (3) and biter Lifelink');
		assert.equal(p2.graveyard.some((c) => c.instanceId === wurm.instanceId), true, 'Bite uses biter Deathtouch');

		// CR 608.2b: if targeted biting creature dies in response, 0 damage is dealt!
		const p2LifeBefore = p2.life;
		const hurlInst = putInZone(state, p1, anyBiteSpell, 'hand');
		const murder = putInZone(
			state,
			p2,
			synCard({
				name: 'Void Terminate',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: hurlInst.instanceId,
				targets: [
					{ kind: 'permanent', id: basilisk.instanceId, label: basilisk.card.name },
					{ kind: 'player', id: p2.playerId, label: p2.username }
				]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: murder.instanceId,
				targets: [{ kind: 'permanent', id: basilisk.instanceId, label: basilisk.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.life, p2LifeBefore, 'CR 608.2b: dead targeted creature cannot deal bite damage');

		// CR 608.2h: ETB trigger where ~ is destroyed in response STILL deals ~s LKI battlefield power!
		const etbFlamer = synCard({
			name: 'Cinder Stalker',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Creature — Elemental',
			power: '4',
			toughness: '2',
			oracleText: 'When Cinder Stalker enters, it deals damage equal to its power to any target.'
		});
		assertFullySupported(etbFlamer);
		const flamerHand = putInZone(state, p1, etbFlamer, 'hand');
		const murder2 = putInZone(
			state,
			p2,
			synCard({
				name: 'Void Terminate II',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flamerHand.instanceId
			}).ok,
			true
		);
		// Resolve creature spell so ETB trigger prompts or auto-stacks; here ETB needs target prompt
		resolveTopStackItemOnly(state);
		const targetPrompt = state.pendingPrompts[0];
		assert.ok(targetPrompt, 'Expected target prompt for ETB power-damage trigger');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: targetPrompt.id,
				answer: {
					kind: 'chooseObjects',
					objectIds: [p2.playerId]
				}
			}).ok,
			true
		);
		const flamerOnBf = p1.battlefield.find((c) => c.card.name === 'Cinder Stalker');
		assert.ok(flamerOnBf, 'Cinder Stalker is on battlefield with trigger on stack');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: murder2.instanceId,
				targets: [{ kind: 'permanent', id: flamerOnBf.instanceId, label: flamerOnBf.card.name }]
			}).ok,
			true
		);
		const p2LifeBeforeLki = p2.life;
		resolveAllStack(state);
		assert.equal(
			p2.life,
			p2LifeBeforeLki - 4,
			'CR 608.2h: ETB trigger uses source LKI power (4) after source died in response'
		);

		// Disjoint damage: "target player or planeswalker", "target opponent or planeswalker", and "each creature and each player"
		const lavaBolt = synCard({
			name: 'Magma Lance',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Magma Lance deals 4 damage to target opponent or planeswalker.'
		});
		const tremorWave = synCard({
			name: 'Sulfur Quake',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Sulfur Quake deals 2 damage to each creature and each player.'
		});
		assertFullySupported(lavaBolt);
		assertFullySupported(tremorWave);

		const pw = putInZone(
			state,
			p2,
			synCard({
				name: 'Seer of Horizons',
				typeLine: 'Legendary Planeswalker — Seer',
				loyalty: '5'
			}),
			'battlefield'
		);
		pw.counters = { ...pw.counters, loyalty: 5 };

		const boltSelf = putInZone(state, p1, lavaBolt, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boltSelf.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			false,
			'"target opponent or planeswalker" rejects targeting self'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boltSelf.instanceId,
				targets: [{ kind: 'permanent', id: pw.instanceId, label: pw.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(pw.counters.loyalty, 1, 'Planeswalker loses 4 loyalty counters');

		const bystander = putInZone(
			state,
			p1,
			synCard({
				name: 'Stone Toad',
				typeLine: 'Creature — Frog',
				power: '1',
				toughness: '4'
			}),
			'battlefield'
		);
		const quakeInst = putInZone(state, p1, tremorWave, 'hand');
		const l1 = p1.life;
		const l2 = p2.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: quakeInst.instanceId
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(bystander.damageMarked, 2);
		assert.equal(p1.life, l1 - 2);
		assert.equal(p2.life, l2 - 2);
	});
});

describe('Track P2 Part 2: Multi-Turn, Spells-Only, & Free-Cast Impulsive Draw (CR 601.1a, 118.9, 107.3b)', () => {
	it('tracks untilEndOfYourNextTurn permissions properly when cast on own turn vs opponent turn', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const visionSorcery = synCard({
			name: 'Ember Foresight',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText:
				'Exile the top three cards of your library. Until the end of your next turn, you may play those cards.'
		});
		const visionInstant = synCard({
			name: 'Midnight Insight',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText:
				'Exile the top two cards of your library. Until the end of your next turn, you may play those cards.'
		});
		assertFullySupported(visionSorcery);
		assertFullySupported(visionInstant);

		const cThisTurn = putInZone(
			state,
			p1,
			synCard({ name: 'Spark Dart', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'Spark Dart deals 1 damage to any target.' }),
			'library'
		);
		const cOppTurn = putInZone(
			state,
			p1,
			synCard({ name: 'Flash Shield', manaCost: '{W}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 2 life.' }),
			'library'
		);
		const cExpire = putInZone(
			state,
			p1,
			synCard({ name: 'Forgotten Relic', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'library'
		);
		p1.library = [cThisTurn, cOppTurn, cExpire];

		const sorcInst = putInZone(state, p1, visionSorcery, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: sorcInst.instanceId }).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(cThisTurn.playableFromExileBy?.duration, 'untilEndOfYourNextTurn');
		// Playable on P1's current turn
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cThisTurn.instanceId,
				fromZone: 'exile',
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveAllStack(state);

		// Advance to P2's main1 (still playable!)
		// Put filler library cards so draw steps never deck out
		for (let k = 0; k < 6; k++) {
			putInZone(state, p1, synCard({ name: `Filler P1 ${k}`, typeLine: 'Artifact' }), 'library');
			putInZone(state, p2, synCard({ name: `Filler P2 ${k}`, typeLine: 'Artifact' }), 'library');
		}
		advanceUntil(state, (s) => s.activePlayerIndex === 1 && s.phase === 'main1');
		assert.equal(cOppTurn.playableFromExileBy?.playerId, p1.playerId, 'Still playable during opponent turn');
		assert.equal(cExpire.playableFromExileBy?.playerId, p1.playerId, 'Artifact permission still active during opponent turn');

		// Pass priority to P1 on P2's turn: P1 casts cOppTurn AND casts Midnight Insight on P2's turn!
		p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		const oppTurnCardA = putInZone(
			state,
			p1,
			synCard({ name: 'Upcoming Relic A', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'library'
		);
		const oppTurnCardB = putInZone(
			state,
			p1,
			synCard({ name: 'Upcoming Relic B', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'library'
		);
		p1.library.unshift(oppTurnCardA, oppTurnCardB);
		const instantImpulse = putInZone(state, p1, visionInstant, 'hand');

		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cOppTurn.instanceId,
				fromZone: 'exile'
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: instantImpulse.instanceId
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(oppTurnCardA.playableFromExileBy?.duration, 'untilEndOfYourNextTurn');

		// Advance to P1's next turn main1: BOTH cExpire (from P1 Turn 1) and oppTurnCardA/B (from P2 Turn 1) MUST be playable!
		advanceUntil(state, (s) => s.activePlayerIndex === 0 && s.phase === 'main1');
		p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		assert.equal(cExpire.playableFromExileBy?.playerId, p1.playerId, 'Still playable on P1 next turn');
		assert.equal(oppTurnCardA.playableFromExileBy?.playerId, p1.playerId, 'Opponent-turn impulse playable on P1 upcoming turn');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: oppTurnCardA.instanceId,
				fromZone: 'exile'
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === oppTurnCardA.instanceId), true);

		// Advance past P1's cleanup into P2's next turn main1: BOTH cExpire and oppTurnCardB MUST have expired!
		advanceUntil(state, (s) => s.activePlayerIndex === 1 && s.phase === 'main1');
		assert.equal(cExpire.playableFromExileBy, undefined, 'Expired at cleanup of P1 next turn');
		assert.equal(oppTurnCardB.playableFromExileBy, undefined, 'Opponent-turn impulse expired at cleanup of P1 upcoming turn');
	});

	it('enforces untilYourNextEndStep, asLongAsExiled + anyColor, and spellsOnly ("may cast" vs "may play", CR 601.1a)', () => {
		const { state, p1 } = makeTwoPlayerGame();
		const castOnlySpell = synCard({
			name: 'Arcane Sift',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Exile the top two cards of your library. Until end of turn, you may cast those cards.'
		});
		const foreverSpell = synCard({
			name: 'Vault of Ages',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText:
				'Exile the top card of your library. For as long as that card remains exiled, you may play it. You may spend mana as though it were mana of any color to cast that spell.'
		});
		const nextEndStepSpell = synCard({
			name: 'Dusk Glimpse',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Exile the top card of your library. Until your next end step, you may play that card.'
		});
		assertFullySupported(castOnlySpell);
		assertFullySupported(foreverSpell);
		assertFullySupported(nextEndStepSpell);

		const exiledLand = putInZone(
			state,
			p1,
			synCard({ name: 'Barren Steppe', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'library'
		);
		const exiledOrb = putInZone(
			state,
			p1,
			synCard({ name: 'Copper Sphere', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'library'
		);
		p1.library = [exiledLand, exiledOrb];

		const siftInst = putInZone(state, p1, castOnlySpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: siftInst.instanceId }).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(exiledLand.playableFromExileBy?.spellsOnly, true);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: exiledLand.instanceId }).ok,
			false,
			'CR 601.1a: "may cast" forbids playing an exiled land'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: exiledOrb.instanceId,
				fromZone: 'exile'
			}).ok,
			true,
			'"may cast" allows casting exiled nonland spell'
		);
		resolveAllStack(state);

		// Test untilYourNextEndStep and asLongAsExiled + spendManaAsAnyColor
		const endStepCard = putInZone(
			state,
			p1,
			synCard({ name: 'Twilight Trinket', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'library'
		);
		const foreverCard = putInZone(
			state,
			p1,
			synCard({ name: 'Chromatic Wyrm', manaCost: '{B}{B}{G}', cmc: 3, typeLine: 'Creature — Dragon', power: '3', toughness: '3' }),
			'library'
		);
		p1.library = [endStepCard, foreverCard];
		for (let k = 0; k < 4; k++) {
			putInZone(state, p1, synCard({ name: `Deck Guard ${k}`, typeLine: 'Artifact' }), 'library');
		}
		p1.library = [endStepCard, foreverCard, ...p1.library.filter((c) => c !== endStepCard && c !== foreverCard)];

		const duskInst = putInZone(state, p1, nextEndStepSpell, 'hand');
		const vaultInst = putInZone(state, p1, foreverSpell, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: duskInst.instanceId }).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: vaultInst.instanceId }).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(endStepCard.playableFromExileBy?.duration, 'untilYourNextEndStep');
		assert.equal(foreverCard.playableFromExileBy?.duration, 'asLongAsExiled');
		assert.equal(foreverCard.playableFromExileBy?.spendManaAsAnyColor, true);

		// Advance to P1's end_step: endStepCard expires at the beginning of P1's next end step!
		advanceUntil(state, (s) => s.activePlayerIndex === 0 && s.phase === 'end_step');
		assert.equal(endStepCard.playableFromExileBy, undefined, 'untilYourNextEndStep expired at beginning of end step');
		assert.equal(foreverCard.playableFromExileBy?.playerId, p1.playerId, 'asLongAsExiled survives end step');

		// Advance all the way around to P1's next turn main1 and cast {B}{B}{G} creature using only colorless mana!
		for (let k = 0; k < 4; k++) {
			putInZone(state, state.players[1], synCard({ name: `P2 Guard ${k}`, typeLine: 'Artifact' }), 'library');
		}
		advanceUntil(state, (s) => s.activePlayerIndex === 0 && s.phase === 'main1');
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 3 };
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: foreverCard.instanceId,
				fromZone: 'exile'
			}).ok,
			true,
			'asLongAsExiled + spendManaAsAnyColor casts {B}{B}{G} using {C}{C}{C} on a later turn'
		);
		resolveAllStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === foreverCard.instanceId), true);
	});

	it('supports withoutPayingManaCost from exile with {0} CastOption, X=0 (CR 107.3b), taxes/additional costs (CR 118.9d), and alt-cost mutual exclusion (CR 118.9a)', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const freeImpulse = synCard({
			name: 'Cascade of Wonders',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText:
				'Exile the top four cards of your library. Until end of turn, you may cast those cards without paying their mana costs.'
		});
		assertFullySupported(freeImpulse);

		const giantSpell = putInZone(
			state,
			p1,
			synCard({
				name: 'Titan Titanosaur',
				manaCost: '{5}{G}{G}',
				cmc: 7,
				typeLine: 'Creature — Dinosaur',
				power: '7',
				toughness: '7'
			}),
			'library'
		);
		const xBlaze = putInZone(
			state,
			p1,
			synCard({
				name: 'Variable Scorch',
				manaCost: '{X}{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Variable Scorch deals X damage to any target.'
			}),
			'library'
		);
		const sacSpell = putInZone(
			state,
			p1,
			synCard({
				name: 'Rite of Cinders',
				manaCost: '{3}{B}',
				cmc: 4,
				typeLine: 'Sorcery',
				oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.'
			}),
			'library'
		);
		const overloadSpell = putInZone(
			state,
			p1,
			synCard({
				name: 'Charged Pulse',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Charged Pulse deals 2 damage to target creature you don\'t control.\nOverload {4}{R}',
				keywords: ['Overload']
			}),
			'library'
		);
		p1.library = [giantSpell, xBlaze, sacSpell, overloadSpell];
		for (let k = 0; k < 4; k++) {
			putInZone(state, p1, synCard({ name: `Draw Card ${k}`, typeLine: 'Artifact' }), 'library');
		}
		p1.library = [
			giantSpell,
			xBlaze,
			sacSpell,
			overloadSpell,
			...p1.library.filter((c) => ![giantSpell, xBlaze, sacSpell, overloadSpell].includes(c))
		];

		const castImpulse = putInZone(state, p1, freeImpulse, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: castImpulse.instanceId }).ok,
			true
		);
		resolveAllStack(state);

		// Empty mana pool completely!
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

		// 1. Cast {5}{G}{G} spell with 0 mana in pool via {0} CastOption!
		const giantOpts = getCastOptions(state, p1.playerId, giantSpell, 'exile');
		assert.equal(giantOpts.length, 1);
		assert.equal(giantOpts[0].baseCost.kind, 'free');
		assert.equal(giantOpts[0].costDisplay, '{0}');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: giantSpell.instanceId,
				fromZone: 'exile',
				optionId: giantOpts[0].id
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === giantSpell.instanceId), true);

		// 2. Cast {X}{R} spell for free -> CR 107.3b forces X = 0 even if xValue: 5 is passed!
		const p2LifeBeforeX = p2.life;
		const xOpts = getCastOptions(state, p1.playerId, xBlaze, 'exile');
		assert.equal(xOpts[0].choosesX, false, 'CR 107.3b: free cast cannot choose X');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: xBlaze.instanceId,
				fromZone: 'exile',
				xValue: 5,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.life, p2LifeBeforeX, 'CR 107.3b: X was forced to 0 so 0 damage was dealt');

		// 3. CR 118.9a: cannot combine Overload with withoutPayingManaCost!
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, overloadSpell, 'exile', 0, 'overload').ok,
			false,
			'CR 118.9a: cannot combine Overload alternative cost with free exile permission'
		);

		// 4. CR 118.9d: mandatory additional costs AND cost-increaser taxes still apply!
		const taxSphere = putInZone(
			state,
			p2,
			synCard({
				name: 'Damping Lodestone',
				typeLine: 'Artifact',
				oracleText: 'Spells cost {1} more to cast.'
			}),
			'battlefield'
		);
		assert.ok(taxSphere);
		// With 0 mana in pool, {1} tax blocks free spell!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sacSpell.instanceId,
				fromZone: 'exile',
				costPayment: { objects: [[giantSpell.instanceId]] }
			}).ok,
			false,
			'CR 118.9d: {1} cost-increaser tax still applies on free cast'
		);
		p1.manaPool.C = 1;
		// Without sacrificing a creature (when we remove giantSpell temporarily or omit sacrifice), mandatory additional cost still required:
		p1.battlefield = [];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sacSpell.instanceId,
				fromZone: 'exile'
			}).ok,
			false,
			'CR 118.9d: mandatory sacrifice additional cost still required on free cast'
		);
		const fodder = putInZone(
			state,
			p1,
			synCard({ name: 'Goblin Fodder', typeLine: 'Creature — Goblin', power: '1', toughness: '1' }),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sacSpell.instanceId,
				fromZone: 'exile',
				costPayment: { objects: [[fodder.instanceId]] }
			}).ok,
			true,
			'Pays {1} tax + sacrifices creature while skipping {3}{B} mana cost'
		);
		resolveAllStack(state);
		assert.equal(p1.hand.length, 2);
	});
});

describe('Track P2 Part 3A: Attached-Permanent LKI Death Triggers (CR 603.10a, 400.7, 400.7f)', () => {
	it('triggers Equipment LKI dies trigger on SBA death and simultaneous board wipe (CR 603.10a)', () => {
		const { state, p1 } = makeTwoPlayerGame();
		const clamp = synCard({
			name: 'Bonevise Clamp',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Artifact — Equipment',
			oracleText: 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}',
			keywords: ['Equip']
		});
		assertFullySupported(clamp);

		for (let k = 0; k < 6; k++) {
			putInZone(state, p1, synCard({ name: `Clamp Draw ${k}`, typeLine: 'Artifact' }), 'library');
		}
		const clampInst = putInZone(state, p1, clamp, 'battlefield');
		const token1 = putInZone(
			state,
			p1,
			synCard({ name: 'Fragile Squire', typeLine: 'Creature — Human', power: '1', toughness: '1' }),
			'battlefield'
		);
		const equipAb = getEffectiveActivatedAbilities(state, p1, clampInst).find((a) => a.id.startsWith('equip'));
		assert.ok(equipAb, 'Expected equip ability');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: clampInst.instanceId,
				abilityId: equipAb.id,
				targets: [{ kind: 'permanent', id: token1.instanceId, label: token1.card.name }]
			}).ok,
			true
		);
		// Resolves Equip -> Fragile Squire becomes 2/0 -> SBA kills it -> Bonevise Clamp triggers -> resolves drawing 2 cards!
		resolveAllStack(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === token1.instanceId), true);
		assert.equal(p1.hand.length, 2, 'Drew 2 cards from equipped creature SBA death via LKI');

		// Simultaneous destruction of BOTH Equipment and equipped creature ("Destroy all artifacts and creatures" / "Destroy all permanents")
		const bear = putInZone(
			state,
			p1,
			synCard({ name: 'Sturdy Bear', typeLine: 'Creature — Bear', power: '2', toughness: '3' }),
			'battlefield'
		);
		attachObject(state, clampInst, bear.instanceId);
		const wipe = putInZone(
			state,
			p1,
			synCard({
				name: 'Total Cataclysm',
				manaCost: '{4}{W}{W}',
				cmc: 6,
				typeLine: 'Sorcery',
				oracleText: 'Destroy all artifacts.\nDestroy all creatures.'
			}),
			'hand'
		);
		const wipeSingleStep = putInZone(
			state,
			p1,
			synCard({
				name: 'Planar Collapse',
				manaCost: '{4}{W}{W}',
				cmc: 6,
				typeLine: 'Sorcery',
				oracleText: 'Destroy all permanents.'
			}),
			'hand'
		);
		assert.ok(wipe);
		assertFullySupported(wipeSingleStep.card);
		p1.hand = [wipeSingleStep];
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wipeSingleStep.instanceId }).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			p1.hand.length,
			2,
			'Simultaneous destruction of Equipment and equipped creature still triggers LKI death ability (CR 603.10a)'
		);
	});

	it('returns enchanted permanent on death or exile, respects CR 400.7 graveyard tampering, and returns self-Aura (CR 400.7f)', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const ghostWard = synCard({
			name: 'Phantom Tether',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Enchantment — Aura',
			oracleText:
				'Enchant creature or planeswalker you control\nWhen enchanted permanent dies or is put into exile, return that card to the battlefield under your control.'
		});
		const returningAura = synCard({
			name: 'Undying Mantle',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant creature\nWhen enchanted creature dies, return Undying Mantle to its owner\'s hand.'
		});
		assertFullySupported(ghostWard);
		assertFullySupported(returningAura);

		// 1. Enchanted creature dies -> returns to battlefield under P1's control
		const hero = putInZone(
			state,
			p1,
			synCard({ name: 'Oathbound Knight', typeLine: 'Creature — Knight', power: '2', toughness: '2' }),
			'battlefield'
		);
		const wardHand = putInZone(state, p1, ghostWard, 'hand');
		const mantleHand = putInZone(state, p1, returningAura, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: wardHand.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: mantleHand.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		const kill = putInZone(
			state,
			p2,
			synCard({ name: 'Grim Cut', manaCost: '{B}', cmc: 1, typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: kill.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(
			p1.battlefield.some((c) => c.instanceId === hero.instanceId),
			true,
			'Phantom Tether returned enchanted creature from graveyard to battlefield'
		);
		assert.equal(
			p1.hand.some((c) => c.instanceId === mantleHand.instanceId),
			true,
			'CR 400.7f: Undying Mantle returned itself from graveyard to owner hand after SBA unattach'
		);

		// 2. Enchanted permanent is put into exile -> returns from exile to battlefield!
		const ward2 = putInZone(state, p1, ghostWard, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ward2.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		const banish = putInZone(
			state,
			p2,
			synCard({ name: 'Banish Light', manaCost: '{W}', cmc: 1, typeLine: 'Instant', oracleText: 'Exile target creature.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: banish.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === hero.instanceId),
			true,
			'Phantom Tether returned enchanted creature from exile to battlefield'
		);

		// 3. CR 400.7 graveyard tampering: creature dies, trigger goes on stack, opponent exiles card from graveyard in response!
		const ward3 = putInZone(state, p1, ghostWard, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ward3.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		const kill2 = putInZone(
			state,
			p1,
			synCard({ name: 'Self Cull', manaCost: '{B}', cmc: 1, typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		const gyExile = putInZone(
			state,
			p2,
			synCard({
				name: 'Crypt Purge',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Exile target card from a graveyard.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: kill2.instanceId,
				targets: [{ kind: 'permanent', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		// Resolve Self Cull only -> hero dies, Phantom Tether trigger is now on the stack!
		resolveTopStackItemOnly(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === hero.instanceId), true);
		assert.equal(state.stack.length, 1);

		// P2 responds by exiling hero from graveyard (bumping hero.objectVersion!)
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: gyExile.instanceId,
				targets: [{ kind: 'graveyard_card', id: hero.instanceId, label: hero.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(
			p1.battlefield.some((c) => c.instanceId === hero.instanceId),
			false,
			'CR 400.7: exiling card from graveyard in response creates a new object that trigger cannot track'
		);
		assert.equal(p1.exile.some((c) => c.instanceId === hero.instanceId), true);
	});
});

describe('Track P2 Part 3B: Cast-Targeting Heroic Triggers & Rename Invariance (CR 603.10a, 707.10)', () => {
	it('resolves Heroic cast trigger BEFORE the spell, fires once on multi-target, and ignores opponent casts and non-orCopy copies', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const hoplite = synCard({
			name: 'Sunspear Hoplite',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Creature — Human Soldier',
			power: '1',
			toughness: '1',
			oracleText: 'Whenever you cast a spell that targets Sunspear Hoplite, put a +1/+1 counter on Sunspear Hoplite.'
		});
		const magecraftHoplite = synCard({
			name: 'Prism Duelist',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Human Wizard',
			power: '1',
			toughness: '5',
			oracleText: 'Whenever you cast or copy an instant or sorcery spell that targets Prism Duelist, draw a card.'
		});
		assertFullySupported(hoplite);
		assertFullySupported(magecraftHoplite);

		for (let k = 0; k < 6; k++) {
			putInZone(state, p1, synCard({ name: `Heroic Draw ${k}`, typeLine: 'Artifact' }), 'library');
		}
		const hopInst = putInZone(state, p1, hoplite, 'battlefield');
		const duelistInst = putInZone(state, p1, magecraftHoplite, 'battlefield');

		// 1. Cast 1-damage ping targeting 1/1 Sunspear Hoplite:
		// Heroic trigger goes on top of stack, puts +1/+1 counter first (making it 2/2), so it SURVIVES the 1 damage!
		const ping = putInZone(
			state,
			p1,
			synCard({
				name: 'Needle Spark',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Needle Spark deals 1 damage to target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ping.instanceId,
				targets: [{ kind: 'permanent', id: hopInst.instanceId, label: hopInst.card.name }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2, 'Spell + Heroic trigger on stack');
		assert.equal(state.stack[1].kind, 'triggered', 'Heroic trigger sits above spell on stack');
		resolveAllStack(state);

		assert.equal(p1.battlefield.some((c) => c.instanceId === hopInst.instanceId), true, 'Hoplite survived 1 damage');
		assert.equal(hopInst.counters['+1/+1'], 1);
		assert.equal(hopInst.damageMarked, 1);

		// 2. Multi-target spell hitting Hoplite + Duelist triggers each once
		const dualBoon = putInZone(
			state,
			p1,
			synCard({
				name: 'Twin Blessing',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Target creature you control fights another target creature.'
			}),
			'hand'
		);
		hopInst.damageMarked = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: dualBoon.instanceId,
				targets: [
					{ kind: 'permanent', id: hopInst.instanceId, label: hopInst.card.name },
					{ kind: 'permanent', id: duelistInst.instanceId, label: duelistInst.card.name }
				]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(hopInst.counters['+1/+1'], 2, 'Triggered once on multi-target spell');
		assert.equal(p1.hand.length, 1, 'Duelist drew 1 card');

		// 3. Opponent casting a spell targeting Hoplite does NOT trigger "Whenever you cast..."
		hopInst.damageMarked = 0;
		const oppTap = putInZone(
			state,
			p2,
			synCard({
				name: 'Frost Bind',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Tap target creature.'
			}),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppTap.instanceId,
				targets: [{ kind: 'permanent', id: hopInst.instanceId, label: hopInst.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(hopInst.counters['+1/+1'], 2, 'Opponent spell did not trigger Heroic');

		// 4. Copying a spell targeting Hoplite vs Duelist (CR 707.10):
		// Copy does NOT trigger "Whenever you cast...", DOES trigger "Whenever you cast or copy..."!
		const cantrip = putInZone(
			state,
			p1,
			synCard({
				name: 'Feather Touch',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Untap target creature.'
			}),
			'hand'
		);
		const fork = putInZone(
			state,
			p1,
			synCard({
				name: 'Echoing Fork',
				manaCost: '{U}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.'
			}),
			'hand'
		);
		// Cast Feather Touch targeting Hoplite (+1 counter -> 3 counters), then Fork it keeping same target (Hoplite stays at 3 counters!)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cantrip.instanceId,
				targets: [{ kind: 'permanent', id: hopInst.instanceId, label: hopInst.card.name }]
			}).ok,
			true
		);
		// Resolve Heroic trigger on top first so Feather Touch is top of stack
		resolveTopStackItemOnly(state);
		assert.equal(hopInst.counters['+1/+1'], 3);
		const featherStackItem = state.stack[0];
		assert.ok(featherStackItem);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fork.instanceId,
				targets: [{ kind: 'stack', id: featherStackItem.id, label: featherStackItem.title }]
			}).ok,
			true
		);
		// Resolve Fork; decline choosing new targets if prompted so copy targets Hoplite
		for (let guard = 0; guard < 12 && state.stack.length > 0; guard++) {
			if (state.pendingPrompts.length > 0) {
				const pr = state.pendingPrompts[0];
				const r = applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'yesNo', yes: false }
				});
				assert.equal(r.ok, true);
				continue;
			}
			const actor = state.players[state.priorityPlayerIndex];
			assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
		}
		assert.equal(hopInst.counters['+1/+1'], 3, 'CR 707.10: spell copy is not cast and did not re-trigger Heroic');

		// Now test copying a spell onto Prism Duelist ("cast or copy"): draws 1 on cast + 1 on copy!
		const libBeforeDuelistCopy = p1.library.length;
		const cantrip2 = putInZone(
			state,
			p1,
			synCard({
				name: 'Feather Touch II',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Untap target creature.'
			}),
			'hand'
		);
		const fork2 = putInZone(
			state,
			p1,
			synCard({
				name: 'Echoing Fork II',
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
				instanceId: cantrip2.instanceId,
				targets: [{ kind: 'permanent', id: duelistInst.instanceId, label: duelistInst.card.name }]
			}).ok,
			true
		);
		resolveTopStackItemOnly(state);
		assert.equal(p1.library.length, libBeforeDuelistCopy - 1);
		const cantrip2Stack = state.stack[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fork2.instanceId,
				targets: [{ kind: 'stack', id: cantrip2Stack.id, label: cantrip2Stack.title }]
			}).ok,
			true
		);
		for (let guard = 0; guard < 16 && state.stack.length > 0; guard++) {
			if (state.pendingPrompts.length > 0) {
				const pr = state.pendingPrompts[0];
				const r = applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'yesNo', yes: false }
				});
				assert.equal(r.ok, true);
				continue;
			}
			const actor = state.players[state.priorityPlayerIndex];
			assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
		}
		assert.equal(
			p1.library.length,
			libBeforeDuelistCopy - 2,
			'orCopy cast-targeting trigger fired on spell copy'
		);
	});

	it('produces identical compiled support and runtime state across renamed synthetic card sets', () => {
		function runScenario(prefix: string) {
			const { state, p1, p2 } = makeTwoPlayerGame();
			for (let k = 0; k < 5; k++) {
				putInZone(state, p1, synCard({ name: `${prefix} Lib ${k}`, manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }), 'library');
			}
			const heroic = synCard({
				name: `${prefix} Champion`,
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Warrior',
				power: '2',
				toughness: '2',
				oracleText: `Whenever you cast a spell that targets ${prefix} Champion, put a +1/+1 counter on it.`
			});
			const bite = synCard({
				name: `${prefix} Strike`,
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Target creature you control deals damage equal to its power to target creature an opponent controls.'
			});
			const aura = synCard({
				name: `${prefix} Tether`,
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nWhen enchanted creature dies, return that card to the battlefield under your control.'
			});
			const impulse = synCard({
				name: `${prefix} Revelation`,
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Exile the top card of your library. Until the end of your next turn, you may play that card without paying its mana cost.'
			});
			for (const c of [heroic, bite, aura, impulse]) assertFullySupported(c);

			const champ = putInZone(state, p1, heroic, 'battlefield');
			const enemy = putInZone(
				state,
				p2,
				synCard({ name: `${prefix} Beast`, typeLine: 'Creature — Beast', power: '3', toughness: '3' }),
				'battlefield'
			);
			const auraInst = putInZone(state, p1, aura, 'hand');
			const biteInst = putInZone(state, p1, bite, 'hand');
			const impInst = putInZone(state, p1, impulse, 'hand');

			// Cast Aura on enemy -> P1 controls Aura; when enemy dies to bite, enemy returns under P1's control!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: auraInst.instanceId,
					targets: [{ kind: 'permanent', id: enemy.instanceId, label: enemy.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);

			// Cast bite targeting champ (Heroic -> +1/+1 -> 3/3!) and enemy (takes 3 -> dies -> returns under P1!)
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: biteInst.instanceId,
					targets: [
						{ kind: 'permanent', id: champ.instanceId, label: champ.card.name },
						{ kind: 'permanent', id: enemy.instanceId, label: enemy.card.name }
					]
				}).ok,
				true
			);
			resolveAllStack(state);

			// Cast free impulse spell and cast exiled artifact for {0}
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: impInst.instanceId }).ok,
				true
			);
			resolveAllStack(state);
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			const exCard = p1.exile[0];
			assert.ok(exCard);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: exCard.instanceId,
					fromZone: 'exile'
				}).ok,
				true
			);
			resolveAllStack(state);

			return {
				p1Life: p1.life,
				p2Life: p2.life,
				p1BattlefieldCount: p1.battlefield.length,
				p2BattlefieldCount: p2.battlefield.length,
				champCounters: champ.counters['+1/+1'] ?? 0,
				champPower: evaluatePermanent(state, champ).power,
				p1GraveyardCount: p1.graveyard.length,
				p1ExileCount: p1.exile.length
			};
		}

		const alpha = runScenario('ZyxwvAlpha');
		const omega = runScenario('QwertOmega');
		assert.deepEqual(alpha, omega);
		assert.equal(alpha.champCounters, 1);
		assert.equal(alpha.champPower, 3);
		assert.equal(alpha.p1BattlefieldCount, 3, 'Champion + stolen reanimated Beast + free exiled Artifact');
		assert.equal(alpha.p2BattlefieldCount, 0);
	});
});
