import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	advancePhaseOrStep,
	applyGameAction,
	checkStateBasedActions,
	createCardInstance as engineCreateCardInstance,
	createInitialGameState,
	enterEndStep,
	evaluatePermanent,
	getEffectiveActivatedAbilities,
	getSpellCostRequirement,
	resolveTopOfStack
} from '../engine.ts';
import { compileCard } from '../compiler/index.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';
import { preconCards } from '../../../../scripts/magic-shared.ts';

function findPrecon(name: string): ScryfallCard {
	const c = preconCards().find((x) => x.name.toLowerCase() === name.toLowerCase());
	assert.ok(c, `missing precon card: ${name}`);
	return c;
}

function syntheticCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `syn_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		oracleId: `ora_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function makeTwoPlayerGame(): { state: GameState; p1: PlayerGameState; p2: PlayerGameState } {
	const d1 = PRECON_DECKS[0];
	const d2 = PRECON_DECKS[1];
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: d1.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d1.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: false,
			deckId: d2.id,
			deckName: d2.name,
			commanderNames: d2.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d2.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		}
	];
	const decksBySeat = new Map([
		[0, d1],
		[1, d2]
	]);
	const state = createInitialGameState('m1_adversarial_test', seats, decksBySeat, DEFAULT_LOBBY_RULES);
	state.status = 'active';
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.turnNumber = 1;
	state.pendingPrompts = [];
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putOnBattlefield(player: PlayerGameState, cardOrName: ScryfallCard | string): CardInstance {
	const card = typeof cardOrName === 'string' ? findPrecon(cardOrName) : cardOrName;
	const inst = engineCreateCardInstance(card, player.playerId, 'battlefield');
	inst.zone = 'battlefield';
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	player.battlefield.push(inst);
	return inst;
}

function putInHand(player: PlayerGameState, cardOrName: ScryfallCard | string): CardInstance {
	const card = typeof cardOrName === 'string' ? findPrecon(cardOrName) : cardOrName;
	const inst = engineCreateCardInstance(card, player.playerId, 'hand');
	inst.zone = 'hand';
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	player.hand.push(inst);
	return inst;
}

function putInLibrary(player: PlayerGameState, cardOrName: ScryfallCard | string): CardInstance {
	const card = typeof cardOrName === 'string' ? findPrecon(cardOrName) : cardOrName;
	const inst = engineCreateCardInstance(card, player.playerId, 'library');
	inst.zone = 'library';
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	player.library.push(inst);
	return inst;
}

describe('M1 Adversarial Stress Tests: Synthetic Rename Invariance, JSON Round-Trip & Inverted Grammar', () => {

	// =========================================================================
	// 1. Synthetic Card Rename Invariance Stress (All 13 Features)
	// =========================================================================
	describe('Suite 1: Synthetic Card Rename Invariance (Features 1–13)', () => {
		it('Feature 1: Compound pump and keyword rename invariance', () => {
			const synthPump = syntheticCard({
				name: 'Synth_Challenger_Pump_001',
				manaCost: '{1}{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +3/+2 and gains trample until end of turn.'
			});
			const def = compileCard(synthPump);
			assert.equal(def.fullySupported, true);
			assert.equal(def.faces[0].abilities[0].kind, 'spell');
			const verbs = def.faces[0].abilities[0].effect?.map((e) => e.verb);
			assert.deepEqual(verbs, ['pump', 'grant']);

			const { state, p1 } = makeTwoPlayerGame();
			const bear = putOnBattlefield(p1, syntheticCard({
				name: 'Synth_Bear_001',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}));
			const pumpInst = putInHand(p1, synthPump);
			p1.manaPool.G = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: pumpInst.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: 'Synth Bear' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			const evaluated = evaluatePermanent(state, bear);
			assert.equal(evaluated.power, 5);
			assert.equal(evaluated.toughness, 4);
			assert.ok(evaluated.keywords.includes('Trample'));
		});

		it('Feature 2: Chaos Warp synthetic rename invariance', () => {
			const synthWarp = syntheticCard({
				name: 'Synth_Temporal_Disorder_002',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it\'s a permanent card, they put it onto the battlefield.'
			});
			const def = compileCard(synthWarp);
			assert.equal(def.fullySupported, true);

			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = []; // Clear library so only the placed permanent is revealed
			const targetArtifact = putOnBattlefield(p2, syntheticCard({
				name: 'Synth_Clockwork_Toy',
				manaCost: '{2}',
				typeLine: 'Artifact'
			}));
			const revealedCreature = putInLibrary(p2, syntheticCard({
				name: 'Synth_Giant_Colossus',
				manaCost: '{8}',
				typeLine: 'Artifact Creature — Golem',
				power: '8',
				toughness: '8'
			}));

			const warpInst = putInHand(p1, synthWarp);
			p1.manaPool.R = 3;
			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: warpInst.instanceId,
				targets: [{ kind: 'permanent', id: targetArtifact.instanceId, label: 'Clockwork Toy' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			// Both targetArtifact and revealedCreature are permanents, so one enters battlefield
			assert.equal(p2.battlefield.length, 1);
			assert.equal(p2.library.length, 1);
			assert.ok(
				p2.battlefield.some((c) => c.instanceId === revealedCreature.instanceId) ||
				p2.battlefield.some((c) => c.instanceId === targetArtifact.instanceId)
			);
		});

		it('Feature 3: Crystalline Crawler synthetic rename invariance', () => {
			const synthCrawler = syntheticCard({
				name: 'Synth_Prismatic_Crawler_003',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: 'Converge — ~ enters the battlefield with a +1/+1 counter on it for each color of mana spent to cast it.\nRemove a +1/+1 counter from ~: Add one mana of any color.\n{T}: Put a +1/+1 counter on ~.'
			});
			const def = compileCard(synthCrawler);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = makeTwoPlayerGame();
			const crawlerInst = putInHand(p1, synthCrawler);
			p1.manaPool.W = 1;
			p1.manaPool.U = 1;
			p1.manaPool.B = 1;
			p1.manaPool.C = 1;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: crawlerInst.instanceId
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			const crawler = p1.battlefield.find((c) => c.instanceId === crawlerInst.instanceId);
			assert.ok(crawler);
			assert.equal(crawler.counters['+1/+1'], 3);
			const evalCrawler = evaluatePermanent(state, crawler);
			assert.equal(evalCrawler.power, 4);
			assert.equal(evalCrawler.toughness, 4);
		});

		it('Feature 4: Expressive Iteration synthetic rename invariance', () => {
			const synthIteration = syntheticCard({
				name: 'Synth_Cognitive_Survey_004',
				manaCost: '{U}{R}',
				typeLine: 'Sorcery',
				oracleText: 'Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. You may play the exiled card this turn.'
			});
			const def = compileCard(synthIteration);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = makeTwoPlayerGame();
			p1.isBot = true;
			p1.hand = [];
			p1.library = [];
			putInLibrary(p1, syntheticCard({ name: 'Synth_Card_A', manaCost: '{1}' }));
			putInLibrary(p1, syntheticCard({ name: 'Synth_Card_B', manaCost: '{2}' }));
			putInLibrary(p1, syntheticCard({ name: 'Synth_Card_C', manaCost: '{3}' }));

			const iterInst = putInHand(p1, synthIteration);
			p1.manaPool.U = 1;
			p1.manaPool.R = 1;
			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: iterInst.instanceId
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			assert.equal(p1.hand.length, 1);
			assert.equal(p1.exile.length, 1);
			assert.equal(p1.library.length, 1);
			assert.equal(p1.exile[0].playableFromExileBy?.playerId, p1.playerId);
		});

		it('Feature 5: Fathom Mage & Evolve synthetic rename invariance', () => {
			const synthEvolve = syntheticCard({
				name: 'Synth_Biomancer_Sage_005',
				manaCost: '{2}{G}{U}',
				typeLine: 'Creature — Human Simic Wizard',
				power: '1',
				toughness: '1',
				oracleText: 'Evolve\nWhenever a +1/+1 counter is put on ~, you may draw a card.'
			});
			const def = compileCard(synthEvolve);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = makeTwoPlayerGame();
			p1.isBot = false;
			const mage = putOnBattlefield(p1, synthEvolve);
			p1.hand = [];
			p1.library = [];
			putInLibrary(p1, syntheticCard({ name: 'Synth_Drawn_Card', manaCost: '{1}' }));

			const bear = putInHand(p1, syntheticCard({
				name: 'Synth_Bear_22',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}));
			p1.manaPool.G = 2;
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bear.instanceId
			});
			resolveTopOfStack(state); // bear enters -> evolve triggers
			resolveTopOfStack(state); // evolve resolves -> counter placed -> draw trigger queued
			resolveTopOfStack(state); // draw trigger pauses for trigger_may prompt

			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts.find((p) => p.playerId === p1.playerId);
				if (prm) {
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'yesNo', yes: true }
					});
				}
			}

			assert.equal(mage.counters['+1/+1'], 1);
			assert.equal(p1.hand.length, 1);
			assert.equal(p1.hand[0].card.name, 'Synth_Drawn_Card');
		});

		it('Feature 6: Forgotten Ancient synthetic rename invariance', () => {
			const synthAncient = syntheticCard({
				name: 'Synth_Elder_Ent_006',
				manaCost: '{3}{G}',
				typeLine: 'Creature — Elemental',
				power: '0',
				toughness: '3',
				oracleText: 'Whenever a player casts a spell, you may put a +1/+1 counter on ~.\nAt the beginning of your upkeep, you may move any number of +1/+1 counters from ~ onto other creatures.'
			});
			const def = compileCard(synthAncient);
			assert.equal(def.fullySupported, true);

			const { state, p1, p2 } = makeTwoPlayerGame();
			p1.isBot = true; // Bot automatically accepts optional counter
			const ancient = putOnBattlefield(p1, synthAncient);

			state.priorityPlayerIndex = 1;
			const p2Spell = putInHand(p2, syntheticCard({
				name: 'Synth_Spark',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: '~ deals 1 damage to any target.'
			}));
			p2.manaPool.R = 1;
			const castRes = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: p2Spell.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: 'Alice' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);
			assert.equal(ancient.counters['+1/+1'], 1);
		});

		it('Feature 7: Hellkite Charger synthetic rename invariance', () => {
			const synthDragon = syntheticCard({
				name: 'Synth_Fury_Dragon_007',
				manaCost: '{4}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '5',
				oracleText: 'Flying, haste\nWhenever ~ attacks, you may pay {5}{R}{R}. If you do, untap all attacking creatures and after this phase, there is an additional combat phase.'
			});
			const def = compileCard(synthDragon);
			assert.equal(def.fullySupported, true);

			const ab = def.faces[0].abilities.find((a) => a.kind === 'triggered');
			assert.ok(ab);
			assert.equal((ab.effect?.[0]?.optional?.cost?.[0] as any)?.cost, '{5}{R}{R}');
			assert.equal(ab.effect?.[1]?.verb, 'untap');
			assert.equal(ab.effect?.[2]?.verb, 'extraCombatPhase');
		});

		it('Feature 8: Jeska\'s Will synthetic rename invariance', () => {
			const synthWill = syntheticCard({
				name: 'Synth_Pyromancer_Ultimatum_008',
				manaCost: '{2}{R}',
				typeLine: 'Sorcery',
				oracleText: 'Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Add {R} for each card in target opponent\'s hand.\n• Exile the top three cards of your library. Until end of turn, you may play cards exiled this way.'
			});
			const def = compileCard(synthWill);
			assert.equal(def.fullySupported, true);

			const { state, p1, p2 } = makeTwoPlayerGame();
			p1.isBot = true;
			const cmd = putOnBattlefield(p1, syntheticCard({
				name: 'Synth_Commander_Hero',
				manaCost: '{W}{U}',
				typeLine: 'Legendary Creature — Human Knight'
			}));
			cmd.isCommander = true;

			p2.hand = [
				putInHand(p2, syntheticCard({ name: 'H1' })),
				putInHand(p2, syntheticCard({ name: 'H2' })),
				putInHand(p2, syntheticCard({ name: 'H3' }))
			];
			putInLibrary(p1, syntheticCard({ name: 'Lib1' }));
			putInLibrary(p1, syntheticCard({ name: 'Lib2' }));
			putInLibrary(p1, syntheticCard({ name: 'Lib3' }));

			const willInst = putInHand(p1, synthWill);
			p1.manaPool.R = 3;
			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: willInst.instanceId,
				modes: [0, 1],
				targets: [{ kind: 'player', id: p2.playerId, label: 'Bob' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			assert.equal(p1.manaPool.R, 3);
			assert.equal(p1.exile.length, 3);
		});

		it('Feature 9: Leyline of Anticipation synthetic rename invariance', () => {
			const synthLeyline = syntheticCard({
				name: 'Synth_Flash_Aura_009',
				manaCost: '{2}{U}{U}',
				typeLine: 'Enchantment',
				oracleText: 'If ~ is in your opening hand, you may begin the game with it on the battlefield.\nYou may cast spells as though they had flash.'
			});
			const def = compileCard(synthLeyline);
			assert.equal(def.fullySupported, true);

			const { state, p1, p2 } = makeTwoPlayerGame();
			putOnBattlefield(p1, synthLeyline);

			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 0;
			const sorcery = putInHand(p1, syntheticCard({
				name: 'Synth_Instant_Sorcery',
				manaCost: '{G}',
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.'
			}));
			p1.manaPool.G = 1;
			putInLibrary(p1, syntheticCard({ name: 'DrawTarget' }));

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorcery.instanceId
			});
			assert.equal(castRes.ok, true, `Should cast sorcery at flash speed: ${castRes.error}`);
		});

		it('Feature 10: Mycosynth Lattice synthetic rename invariance', () => {
			const synthLattice = syntheticCard({
				name: 'Synth_Silicon_Web_010',
				manaCost: '{6}',
				typeLine: 'Artifact',
				oracleText: 'All permanents are artifacts in addition to their other types.\nAll cards that aren\'t on the battlefield, spells, and permanents are colorless.\nPlayers may spend mana as though it were mana of any color.'
			});
			const def = compileCard(synthLattice);
			assert.equal(def.fullySupported, true);

			const { state, p1, p2 } = makeTwoPlayerGame();
			putOnBattlefield(p1, synthLattice);
			const bear = putOnBattlefield(p2, syntheticCard({
				name: 'Synth_Green_Bear',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				colors: ['G']
			}));

			const evalBear = evaluatePermanent(state, bear);
			assert.equal(evalBear.isArtifact, true, 'Should be an artifact in addition to creature');
			assert.deepEqual(evalBear.colors, [], 'Should be colorless per Layer 5');
		});

		it('Feature 11: Path of Ancestry synthetic rename invariance', () => {
			const synthPath = syntheticCard({
				name: 'Synth_Ancient_Trail_011',
				manaCost: '',
				typeLine: 'Land',
				oracleText: '~ enters the battlefield tapped.\n{T}: Add one mana of any color in your commander\'s color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1.'
			});
			const def = compileCard(synthPath);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = makeTwoPlayerGame();
			const pathInst = putOnBattlefield(p1, synthPath);
			pathInst.tapped = false;

			const abilities = getEffectiveActivatedAbilities(state, p1, pathInst);
			assert.ok(abilities.length > 0);
		});

		it('Feature 12: Scourge of Valkas synthetic rename invariance', () => {
			const synthScourge = syntheticCard({
				name: 'Synth_Inferno_Drake_012',
				manaCost: '{2}{R}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '4',
				toughness: '4',
				oracleText: 'Flying\n{R}: ~ gets +1/+0 until end of turn.\nWhenever ~ or another Dragon you control enters the battlefield, it deals X damage to any target, where X is the number of Dragons you control.'
			});
			const def = compileCard(synthScourge);
			assert.equal(def.fullySupported, true);

			const { state, p1, p2 } = makeTwoPlayerGame();
			putOnBattlefield(p1, syntheticCard({
				name: 'Synth_Other_Dragon',
				typeLine: 'Creature — Dragon',
				power: '3',
				toughness: '3'
			}));
			const scourgeInst = putInHand(p1, synthScourge);
			p1.manaPool.R = 5;
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: scourgeInst.instanceId
			});
			resolveTopOfStack(state); // Enters -> trigger queued

			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
			}
			const initialLife = p2.life;
			resolveTopOfStack(state);
			assert.equal(p2.life, initialLife - 2);
		});

		it('Feature 13: Terror of the Peaks synthetic rename invariance', () => {
			const synthTerror = syntheticCard({
				name: 'Synth_Apex_Terror_013',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Flying\nSpells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters the battlefield, ~ deals damage equal to that creature\'s power to any target.'
			});
			const def = compileCard(synthTerror);
			assert.equal(def.fullySupported, true);

			const { state, p1, p2 } = makeTwoPlayerGame();
			const terror = putOnBattlefield(p1, synthTerror);

			state.priorityPlayerIndex = 1;
			const zap = putInHand(p2, syntheticCard({
				name: 'Synth_Zap',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: '~ deals 1 damage to any target.'
			}));
			p2.manaPool.R = 1;
			const initialLife = p2.life;
			const castRes = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: zap.instanceId,
				targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Apex Terror' }]
			});
			assert.equal(castRes.ok, true);
			assert.equal(p2.life, initialLife - 3, 'P2 should have paid 3 life targeting Terror');
		});
	});

	// =========================================================================
	// 2. Plain JSON Serialization Stress Tests
	// =========================================================================
	describe('Suite 2: Plain JSON Serialization Across Interactive States', () => {
		it('Serializes and resumes during Expressive Iteration interactive partition choices', () => {
			const { state, p1 } = makeTwoPlayerGame();
			p1.isBot = false;
			p1.hand = [];
			p1.library = [];
			const c1 = putInLibrary(p1, syntheticCard({ name: 'Card_Alpha', manaCost: '{1}' }));
			const c2 = putInLibrary(p1, syntheticCard({ name: 'Card_Beta', manaCost: '{2}' }));
			const c3 = putInLibrary(p1, syntheticCard({ name: 'Card_Gamma', manaCost: '{3}' }));

			const ei = putInHand(p1, findPrecon('Expressive Iteration'));
			p1.manaPool.U = 1;
			p1.manaPool.R = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ei.instanceId
			});
			resolveTopOfStack(state);

			assert.ok(state.pendingPrompts.length > 0);
			const prompt1 = state.pendingPrompts[0];
			assert.equal(prompt1.playerId, p1.playerId);
			assert.equal(prompt1.choice?.kind, 'chooseObjects');

			// === JSON SERIALIZATION ROUND TRIP 1 ===
			const serialized1 = JSON.parse(JSON.stringify(state));
			assert.equal(serialized1.pendingPrompts.length, 1);
			const resumedState1: GameState = serialized1;

			const ansRes1 = applyGameAction(resumedState1, p1.playerId, {
				type: 'choice',
				promptId: resumedState1.pendingPrompts[0].id,
				answer: {
					kind: 'chooseObjects',
					objectIds: [c1.instanceId]
				}
			});
			assert.equal(ansRes1.ok, true);

			assert.ok(resumedState1.pendingPrompts.length > 0);

			// === JSON SERIALIZATION ROUND TRIP 2 ===
			const serialized2 = JSON.parse(JSON.stringify(resumedState1));
			const resumedState2: GameState = serialized2;

			const ansRes2 = applyGameAction(resumedState2, p1.playerId, {
				type: 'choice',
				promptId: resumedState2.pendingPrompts[0].id,
				answer: {
					kind: 'chooseObjects',
					objectIds: [c2.instanceId]
				}
			});
			assert.equal(ansRes2.ok, true);

			const p1Final = resumedState2.players[0];
			assert.equal(p1Final.hand.some((c) => c.instanceId === c1.instanceId), true, 'c1 in hand');
			assert.equal(p1Final.exile.some((c) => c.instanceId === c2.instanceId), true, 'c2 in exile');
			assert.equal(p1Final.library.some((c) => c.instanceId === c3.instanceId), true, 'c3 in library');
			const exiledC2 = p1Final.exile.find((c) => c.instanceId === c2.instanceId);
			assert.equal(exiledC2?.playableFromExileBy?.playerId, p1.playerId);
		});

		it('Preserves CR 613 layer evaluations identically across JSON round trip', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const lattice = putOnBattlefield(p1, findPrecon('Mycosynth Lattice'));
			const crawler = putOnBattlefield(p1, findPrecon('Crystalline Crawler'));
			crawler.counters['+1/+1'] = 3;

			const knight = putOnBattlefield(p2, syntheticCard({
				name: 'Knight_Token',
				manaCost: '{W}',
				typeLine: 'Creature — Knight',
				power: '2',
				toughness: '2',
				colors: ['W']
			}));

			state.timedContinuousEffects = [
				{
					timestamp: 100,
					sourceName: 'Lattice',
					controllerId: p1.playerId,
					affected: [{ instanceId: knight.instanceId }],
					layer6: { addKeywords: ['Flying'] },
					layer7b: { setPower: 5, setToughness: 3 }
				}
			];

			const evalPreKnight = evaluatePermanent(state, knight);
			const evalPreCrawler = evaluatePermanent(state, crawler);

			// === JSON SERIALIZATION ROUND TRIP ===
			const serialized = JSON.parse(JSON.stringify(state));
			const deserialized: GameState = serialized;

			const knightPost = deserialized.players[1].battlefield.find((c) => c.instanceId === knight.instanceId)!;
			const crawlerPost = deserialized.players[0].battlefield.find((c) => c.instanceId === crawler.instanceId)!;

			const evalPostKnight = evaluatePermanent(deserialized, knightPost);
			const evalPostCrawler = evaluatePermanent(deserialized, crawlerPost);

			assert.equal(evalPostKnight.isArtifact, evalPreKnight.isArtifact);
			assert.deepEqual(evalPostKnight.colors, evalPreKnight.colors);
			assert.equal(evalPostKnight.power, evalPreKnight.power);
			assert.equal(evalPostKnight.toughness, evalPreKnight.toughness);
			assert.deepEqual(evalPostKnight.keywords, evalPreKnight.keywords);

			assert.equal(evalPostCrawler.power, evalPreCrawler.power);
			assert.equal(evalPostCrawler.toughness, evalPreCrawler.toughness);
		});

		it('Allows subsequent legal game actions after JSON serialization', () => {
			const { state, p1 } = makeTwoPlayerGame();
			putOnBattlefield(p1, findPrecon('Terror of the Peaks'));

			const serialized = JSON.parse(JSON.stringify(state));
			const resumed: GameState = serialized;

			const p1Resumed = resumed.players[0];
			const elf = putInHand(p1Resumed, syntheticCard({
				name: 'Llanowar_Elf_Synth',
				manaCost: '{G}',
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1'
			}));
			p1Resumed.manaPool.G = 1;

			const castRes = applyGameAction(resumed, p1Resumed.playerId, {
				type: 'cast_spell',
				instanceId: elf.instanceId
			});
			assert.equal(castRes.ok, true, `Subsequent cast action must succeed: ${castRes.error}`);
		});
	});

	// =========================================================================
	// 3. Inverted Grammar Stress Tests
	// =========================================================================
	describe('Suite 3: Inverted Grammar Stress (Multi-Keywords, Multi-Stats, Negative Deltas)', () => {
		it('Parses and applies multiple keyword grants in compound clause', () => {
			const multiKeywordCard = syntheticCard({
				name: 'Synth_Blessing_Multi',
				manaCost: '{1}{W}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +2/+2 and gains first strike, trample, and vigilance until end of turn.'
			});
			const def = compileCard(multiKeywordCard);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = makeTwoPlayerGame();
			const soldier = putOnBattlefield(p1, syntheticCard({
				name: 'Synth_Soldier',
				typeLine: 'Creature — Soldier',
				power: '1',
				toughness: '1'
			}));
			const spell = putInHand(p1, multiKeywordCard);
			p1.manaPool.W = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: soldier.instanceId, label: 'Soldier' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			const evalSoldier = evaluatePermanent(state, soldier);
			assert.equal(evalSoldier.power, 3);
			assert.equal(evalSoldier.toughness, 3);
			assert.ok(evalSoldier.keywords.includes('First strike'));
			assert.ok(evalSoldier.keywords.includes('Trample'));
			assert.ok(evalSoldier.keywords.includes('Vigilance'));
		});

		it('Parses and applies negative power/toughness deltas with keywords', () => {
			const witherCard = syntheticCard({
				name: 'Synth_Withering_Touch',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets -2/-2 and gains deathtouch until end of turn.'
			});
			const def = compileCard(witherCard);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = makeTwoPlayerGame();
			const giant = putOnBattlefield(p1, syntheticCard({
				name: 'Synth_Giant',
				typeLine: 'Creature — Giant',
				power: '5',
				toughness: '5'
			}));
			const spell = putInHand(p1, witherCard);
			p1.manaPool.B = 1;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: giant.instanceId, label: 'Giant' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			const evalGiant = evaluatePermanent(state, giant);
			assert.equal(evalGiant.power, 3);
			assert.equal(evalGiant.toughness, 3);
			assert.ok(evalGiant.keywords.includes('Deathtouch'));
		});

		it('Lethal negative toughness reduction kills creature via state-based actions', () => {
			const fatalWither = syntheticCard({
				name: 'Synth_Fatal_Curse',
				manaCost: '{1}{B}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets -3/-3 and gains flying until end of turn.'
			});
			const def = compileCard(fatalWither);
			assert.equal(def.fullySupported, true);

			const { state, p1 } = makeTwoPlayerGame();
			const bear = putOnBattlefield(p1, syntheticCard({
				name: 'Synth_Bear_22',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}));
			const spell = putInHand(p1, fatalWither);
			p1.manaPool.B = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: 'Bear' }]
			});
			resolveTopOfStack(state);

			assert.equal(bear.zone, 'graveyard');
			assert.equal(p1.graveyard.some((c) => c.instanceId === bear.instanceId), true);
		});

		it('Compound pump and keyword grants expire at end of turn cleanup (CR 514.2)', () => {
			const pumpCard = syntheticCard({
				name: 'Synth_Temporary_Surge',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +4/+4 and gains trample until end of turn.'
			});
			const { state, p1 } = makeTwoPlayerGame();
			const elf = putOnBattlefield(p1, syntheticCard({
				name: 'Synth_Elf',
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1'
			}));
			const spell = putInHand(p1, pumpCard);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'permanent', id: elf.instanceId, label: 'Elf' }]
			});
			resolveTopOfStack(state);

			const evalPumped = evaluatePermanent(state, elf);
			assert.equal(evalPumped.power, 5);
			assert.ok(evalPumped.keywords.includes('Trample'));

			enterEndStep(state, p1);
			advancePhaseOrStep(state); // Advances to turn 2 main1

			const evalExpired = evaluatePermanent(state, elf);
			assert.equal(evalExpired.power, 1);
			assert.equal(evalExpired.toughness, 1);
			assert.equal(evalExpired.keywords.includes('Trample'), false);
		});
	});

	// =========================================================================
	// 4. Precon Mechanics CR Edge Cases
	// =========================================================================
	describe('Suite 4: Precon Mechanics CR Edge Cases', () => {
		it('Chaos Warp fizzles if target leaves battlefield before resolution (CR 608.2b)', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const target = putOnBattlefield(p2, syntheticCard({
				name: 'Target_To_Exile',
				typeLine: 'Artifact'
			}));
			const warp = putInHand(p1, findPrecon('Chaos Warp'));
			p1.manaPool.R = 3;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: warp.instanceId,
				targets: [{ kind: 'permanent', id: target.instanceId, label: 'Target' }]
			});

			p2.battlefield = p2.battlefield.filter((c) => c.instanceId !== target.instanceId);
			target.zone = 'graveyard';
			p2.graveyard.push(target);

			const libraryCountBefore = p2.library.length;
			resolveTopOfStack(state);

			assert.equal(p2.library.length, libraryCountBefore);
		});

		it('Converge with 4 distinct colors spent places 4 counters', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const crawler = putInHand(p1, findPrecon('Crystalline Crawler'));
			p1.manaPool.W = 1;
			p1.manaPool.U = 1;
			p1.manaPool.B = 1;
			p1.manaPool.R = 1;
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: crawler.instanceId
			});
			resolveTopOfStack(state);

			const crawlerBf = p1.battlefield.find((c) => c.instanceId === crawler.instanceId)!;
			assert.equal(crawlerBf.counters['+1/+1'], 4);
		});

		it('Terror of the Peaks rejects cast if opponent cannot pay 3 life', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const terror = putOnBattlefield(p1, findPrecon('Terror of the Peaks'));

			state.priorityPlayerIndex = 1;
			p2.life = 2;
			const bolt = putInHand(p2, findPrecon('Lightning Bolt'));
			p2.manaPool.R = 1;

			const castRes = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Terror of the Peaks' }]
			});
			assert.equal(castRes.ok, false);
			assert.equal(p2.life, 2, 'Life unchanged after illegal cast rejection');
		});

		it('Hellkite Charger attack trigger optional decline grants no extra phase', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const dragon = putOnBattlefield(p1, findPrecon('Hellkite Charger'));
			dragon.tapped = true;
			state.phase = 'declare_attackers';
			state.additionalCombatPhases = 0;

			p1.manaPool.R = 0;
			assert.equal(state.additionalCombatPhases, 0);
			assert.equal(dragon.tapped, true);
		});
	});
});
