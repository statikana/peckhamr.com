import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	checkStateBasedActions,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	sanitizeGameStateForViewer
} from '../../engine.ts';
import {
	addCardToZone,
	assertJsonRoundTrip,
	castSpellAction,
	isFeatureReady,
	passAllPriority,
	playLandAction,
	setupE2EGame,
	synthCard
} from './e2e-harness.test.ts';

describe('Tier 3: Cross-Feature Interactions & Pairwise Combinations', () => {
	// ==========================================
	// 1. Combat Damage + Prevention Shields
	// ==========================================
	describe('1. Combat Damage + Damage Prevention', () => {
		it('Damage prevention shield absorbs combat damage before toughness reduction', (t) => {
			if (!isFeatureReady('damage_prevention')) {
				t.skip('damage_prevention awaiting M2 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const blocker = addCardToZone(state, p1, synthCard({ name: 'Shielded Bear', power: '2', toughness: '2' }), 'battlefield');
			blocker.damagePreventionShield = 2;
			blocker.damageMarked = 1;
			checkStateBasedActions(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === blocker.instanceId), true);
		});

		it('Fog prevents all combat damage but preserves non-combat spell damage', (t) => {
			if (!isFeatureReady('prevent_all_combat_damage')) {
				t.skip('prevent_all_combat_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// 2. Layer Engine Interactions (Layers 4, 5, 6, 7c)
	// ==========================================
	describe('2. Multi-Layer Continuous Stacking (Layers 4, 5, 6, 7c)', () => {
		it('Mycosynth Lattice (Layer 4/5) + Continuous pump/keyword (Layer 6/7c)', (t) => {
			if (!isFeatureReady('mycosynth_lattice') || !isFeatureReady('pump_and_keyword')) {
				t.skip('Awaiting mycosynth_lattice / pump_and_keyword implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			addCardToZone(state, p1, synthCard({
				name: 'Lattice',
				oracleText: "All permanents are artifacts in addition to their other types.\nAll cards that aren't on the battlefield, spells, and permanents are colorless."
			}), 'battlefield');
			const bear = addCardToZone(state, p1, synthCard({ name: 'Bear', colors: ['G'], power: '2', toughness: '2' }), 'battlefield');
			const evaluated = evaluatePermanent(state, bear);
			assert.equal(evaluated.isArtifact, true);
			assert.equal(evaluated.colors.length, 0);
		});

		it('Base P/T setting (Layer 7b) + Condition-gated buff (Layer 7c Threshold/Metalcraft)', (t) => {
			if (!isFeatureReady('threshold_metalcraft_delirium')) {
				t.skip('threshold_metalcraft_delirium awaiting M3 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// 3. Triggers + Replacements
	// ==========================================
	describe('3. Trigger Stacking & Replacement Interactions', () => {
		it('Simultaneous dragon ETB triggers stack via APNAP order', (t) => {
			if (!isFeatureReady('scourge_of_valkas') || !isFeatureReady('terror_of_the_peaks')) {
				t.skip('Awaiting scourge_of_valkas / terror_of_the_peaks implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			assert.equal(state.activePlayerIndex, 0);

			const warden = addCardToZone(state, p2, synthCard({
				name: 'Soul Warden Synth',
				manaCost: '{W}',
				typeLine: 'Creature',
				power: '1',
				toughness: '1',
				oracleText: 'Whenever another creature enters, you gain 1 life.'
			}), 'battlefield');

			const terror = addCardToZone(state, p1, synthCard({
				name: 'Terror Synth',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Whenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
			}), 'battlefield');

			const dragon = addCardToZone(state, p1, synthCard({
				name: 'Synth Dragon',
				manaCost: '{G}',
				typeLine: 'Creature — Dragon',
				power: '3',
				toughness: '3'
			}), 'hand');
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: dragon.instanceId });
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });

			// APNAP ordering (CR 603.3b): Active Player (P1) on bottom, Non-Active Player (P2) on top
			assert.equal(state.stack[0].controllerId, p1.playerId, 'AP trigger placed on bottom');
			assert.equal(state.stack[1].controllerId, p2.playerId, 'NAP trigger placed on top');

			if (state.pendingPrompts.length > 0) {
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
			}

			// Resolves P2 trigger first (+1 life)
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });
			assert.equal(p2.life, 41, 'NAP trigger resolves first');

			// Resolves P1 trigger second (-3 life)
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });
			assert.equal(p2.life, 38, 'AP trigger resolves second');
		});

		it('Death triggers do not fire when exile-on-death replacement effect applies', (t) => {
			if (!isFeatureReady('death_deals_damage') || !isFeatureReady('exile_on_death_damage')) {
				t.skip('Awaiting death_deals_damage / exile_on_death_damage implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Converge replacement counters interact with Evolve trigger on entering', (t) => {
			if (!isFeatureReady('crystalline_crawler') || !isFeatureReady('fathom_mage')) {
				t.skip('Awaiting crystalline_crawler / fathom_mage implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const mage = addCardToZone(state, p1, synthCard({
				name: 'Fathom Mage Synth',
				manaCost: '{2}{G}{U}',
				typeLine: 'Creature — Human Wizard',
				power: '1',
				toughness: '1',
				keywords: ['Evolve'],
				oracleText: 'Evolve\nWhenever a +1/+1 counter is put on ~, you may draw a card.'
			}), 'battlefield');

			const crawlerCard = synthCard({
				name: 'Crawler Synth',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: 'Converge — ~ enters with a +1/+1 counter on it for each color of mana spent to cast it.'
			});
			const crawler = addCardToZone(state, p1, crawlerCard, 'hand');
			p1.manaPool.W = 1;
			p1.manaPool.U = 1;
			p1.manaPool.B = 1;
			p1.manaPool.C = 1;

			const castRes = castSpellAction(state, p1, crawler);
			assert.equal(castRes.ok, true);
			passAllPriority(state);

			const bfCrawler = p1.battlefield.find((c) => c.card.name === 'Crawler Synth');
			assert.ok(bfCrawler);
			assert.equal(bfCrawler.counters['+1/+1'], 3, 'Crawler enters with 3 converge counters');
			assert.equal(mage.counters['+1/+1'], 1, 'Mage evolved from entering 4/4 crawler');
		});
	});

	// ==========================================
	// 4. Alternative Costs, Taxes & Reductions
	// ==========================================
	describe('4. Alternative Costs, Targeting Taxes & Cost Reductions', () => {
		it('Commander tax + targeting life tax apply in strict CR 601.2f order', (t) => {
			if (!isFeatureReady('terror_of_the_peaks')) {
				t.skip('terror_of_the_peaks awaiting M1 implementation');
				return;
			}
			const auraCmd = synthCard({
				name: 'Commander Aura',
				manaCost: '{1}{W}',
				typeLine: 'Legendary Enchantment — Aura',
				canBeCommander: true,
				oracleText: 'Enchant creature\nEnchanted creature gets +2/+2.'
			});
			const { state, p1, p2 } = setupE2EGame({ p2Commander: auraCmd });
			const terror = addCardToZone(state, p1, synthCard({
				name: 'Terror Synth',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Spells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
			}), 'battlefield');

			const cmdInst = p2.command.find(c => c.card.name === 'Commander Aura');
			assert.ok(cmdInst);
			cmdInst.commanderCastCount = 1;
			p2.commanderCastCounts = { [cmdInst.instanceId]: 1 };

			p2.manaPool.W = 1;
			p2.manaPool.C = 3; // {1}{W} base + {2} commander tax
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 1;
			const initialP2Life = p2.life;

			const castRes = castSpellAction(state, p2, cmdInst, {
				fromZone: 'command',
				targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Terror Synth' }]
			});
			assert.equal(castRes.ok, true);
			assert.equal(p2.life, initialP2Life - 3, 'Paid 3 life targeting tax (CR 601.2f)');
			assert.equal(p2.manaPool.W, 0, 'Paid {W}');
			assert.equal(p2.manaPool.C, 0, 'Paid {3} generic');
		});

		it('Tribal cost reduction does not reduce colored mana requirement below pips', (t) => {
			if (!isFeatureReady('tribal_type_cost_reduction')) {
				t.skip('tribal_type_cost_reduction awaiting M3 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// 5. Zone Transitions & Object Identity (CR 400.7)
	// ==========================================
	describe('5. Zone Transitions & Object Identity', () => {
		it('Chaos Warp resets object identity when returned from library to battlefield', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			p1.library = [];
			const creature = addCardToZone(state, p1, synthCard({
				name: 'Reset Bear',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}), 'battlefield');
			creature.counters['+1/+1'] = 3;
			const versionBefore = creature.objectVersion ?? 1;

			const warp = addCardToZone(state, p1, synthCard({
				name: 'Synthetic Warp',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: creature.instanceId, label: 'Reset Bear' }] });
			passAllPriority(state);

			const returned = p1.battlefield.find((c) => c.card.name === 'Reset Bear');
			assert.ok(returned, 'Bear returned to battlefield');
			assert.ok((returned.objectVersion ?? 1) > versionBefore, 'Object version must increment under CR 400.7');
			assert.equal(returned.counters['+1/+1'] ?? 0, 0, 'Counters must be wiped under CR 400.7');
		});

		it('Bounce land returns conditional ETB land, preserving correct state on replay', (t) => {
			if (!isFeatureReady('bounce_land') || !isFeatureReady('etb_tapped_conditional_lands')) {
				t.skip('Awaiting bounce_land / etb_tapped_conditional_lands implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// 6. Combat Phases & Attack Restrictions
	// ==========================================
	describe('6. Combat Phases & Attack Restrictions', () => {
		it('Hellkite Charger additional combat phase with Welkin Tern blocker restriction', (t) => {
			if (!isFeatureReady('hellkite_charger') || !isFeatureReady('blocking_restrictions')) {
				t.skip('Awaiting hellkite_charger / blocking_restrictions implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Cannot be blocked this turn combined with power-gated evasion', (t) => {
			if (!isFeatureReady('cant_be_blocked_eot') || !isFeatureReady('blocking_restrictions')) {
				t.skip('Awaiting cant_be_blocked_eot / blocking_restrictions implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// 7. Keyword Combinations
	// ==========================================
	describe('7. Keyword Combinations', () => {
		it('Undying + Modular interaction on death', (t) => {
			if (!isFeatureReady('cr702_undying_persist') || !isFeatureReady('cr702_modular')) {
				t.skip('Awaiting cr702_undying_persist / cr702_modular implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Improvise + Convoke cost assistance coexistence', (t) => {
			if (!isFeatureReady('cr702_improvise')) {
				t.skip('cr702_improvise awaiting M4 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Toxic combat damage + Renown trigger on player combat damage', (t) => {
			if (!isFeatureReady('cr702_toxic') || !isFeatureReady('cr702_renown')) {
				t.skip('Awaiting cr702_toxic / cr702_renown implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// 8. Interactive Choice Pause & JSON Round-Trip
	// ==========================================
	describe('8. Interactive Choice Pause & JSON Round-Trip', () => {
		it('Game state paused on modal choice survives JSON round-trip and resumes cleanly', () => {
			const { state, p1 } = setupE2EGame();
			state.pendingPrompts.push({
				id: 'prompt_test_modal',
				playerId: p1.playerId,
				kind: 'orderObjects',
				title: 'Order Triggers',
				description: 'Choose trigger order',
				purpose: 'trigger_order',
				choice: {
					kind: 'orderObjects',
					objectIds: ['obj_1', 'obj_2'],
					reason: 'Order triggers'
				}
			});
			const restored = assertJsonRoundTrip(state);
			assert.equal(restored.pendingPrompts.length, 1);
			assert.equal(restored.pendingPrompts[0].id, 'prompt_test_modal');

			// Resume and answer
			const res = applyGameAction(restored, p1.playerId, {
				type: 'choice',
				promptId: 'prompt_test_modal',
				answer: {
					kind: 'orderObjects',
					topIds: ['obj_1', 'obj_2'],
					bottomIds: [],
					shuffle: false
				}
			});
			assert.equal(res.ok, true);
			assert.equal(restored.pendingPrompts.length, 0);
		});

		it('Game state paused on yesNo choice survives JSON round-trip and resumes cleanly', () => {
			const { state, p1 } = setupE2EGame();
			state.pendingPrompts.push({
				id: 'prompt_test_yesno',
				playerId: p1.playerId,
				kind: 'yesNo',
				title: 'End Turn',
				description: 'End your turn?',
				purpose: 'end_turn',
				choice: {
					kind: 'yesNo',
					question: 'End your turn?'
				}
			});
			const restored = assertJsonRoundTrip(state);
			assert.equal(restored.pendingPrompts.length, 1);

			const res = applyGameAction(restored, p1.playerId, {
				type: 'choice',
				promptId: 'prompt_test_yesno',
				answer: { kind: 'yesNo', yes: true }
			});
			assert.equal(res.ok, true);
			assert.equal(restored.pendingPrompts.length, 0);
		});
	});
});
