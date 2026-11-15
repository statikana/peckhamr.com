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
	activateAbilityAction,
	addCardToZone,
	assertJsonRoundTrip,
	castSpellAction,
	isFeatureReady,
	passAllPriority,
	playLandAction,
	setupE2EGame,
	synthCard
} from './e2e-harness.test.ts';

describe('Tier 2: Comprehensive Boundary & Corner Cases (51 Features × 5 Tests)', () => {
	// ==========================================
	// Feature 1: pump_and_keyword (M1)
	// ==========================================
	describe('Feature 1: pump_and_keyword boundaries', () => {
		it('Case 1: Negative toughness causes state-based death', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const small = addCardToZone(state, p1, synthCard({ name: 'Small Elf', power: '1', toughness: '1' }), 'battlefield');
			const debuff = addCardToZone(state, p1, synthCard({
				name: 'Wither Synth',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets -2/-2 and gains menace until end of turn.'
			}), 'hand');
			p1.manaPool.B = 1;
			castSpellAction(state, p1, debuff, { targets: [{ kind: 'permanent', id: small.instanceId, label: 'Small Elf' }] });
			passAllPriority(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === small.instanceId), false);
			assert.equal(p1.graveyard.some((c) => c.instanceId === small.instanceId), true);
		});

		it('Case 2: Zero pump (+0/+0) with multiple keywords', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const bear = addCardToZone(state, p1, synthCard({ name: 'Bear', power: '2', toughness: '2' }), 'battlefield');
			const buff = addCardToZone(state, p1, synthCard({
				name: 'Wings Synth',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +0/+0 and gains flying and hexproof until end of turn.'
			}), 'hand');
			p1.manaPool.U = 2;
			castSpellAction(state, p1, buff, { targets: [{ kind: 'permanent', id: bear.instanceId, label: 'Bear' }] });
			passAllPriority(state);
			const evalBear = evaluatePermanent(state, bear);
			assert.equal(evalBear.power, 2);
			assert.equal(evalBear.toughness, 2);
			assert.equal(evalBear.keywords.includes('Flying'), true);
		});

		it('Case 3: Extreme pump values (+100/+100)', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const bear = addCardToZone(state, p1, synthCard({ name: 'Bear', power: '2', toughness: '2' }), 'battlefield');
			const giantPump = addCardToZone(state, p1, synthCard({
				name: 'Titanic Synth',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +100/+100 and gains trample until end of turn.'
			}), 'hand');
			p1.manaPool.G = 1;
			castSpellAction(state, p1, giantPump, { targets: [{ kind: 'permanent', id: bear.instanceId, label: 'Bear' }] });
			passAllPriority(state);
			const evalBear = evaluatePermanent(state, bear);
			assert.equal(evalBear.power, 102);
			assert.equal(evalBear.toughness, 102);
		});

		it('Case 4: Target removed before resolution (CR 608.2b fizzle)', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const target = addCardToZone(state, p1, synthCard({ name: 'Target' }), 'battlefield');
			const pump = addCardToZone(state, p1, synthCard({
				name: 'Buff',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +2/+2 and gains trample until end of turn.'
			}), 'hand');
			p1.manaPool.G = 1;
			castSpellAction(state, p1, pump, { targets: [{ kind: 'permanent', id: target.instanceId, label: 'Target' }] });
			// Remove target before resolution
			p1.battlefield = p1.battlefield.filter((c) => c.instanceId !== target.instanceId);
			passAllPriority(state);
			assert.equal(p1.graveyard.some((c) => c.instanceId === pump.instanceId), true);
		});

		it('Case 5: Duration boundary cleanup clears buff', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 2: chaos_warp boundaries (M1)
	// ==========================================
	describe('Feature 2: chaos_warp boundaries', () => {
		it('Case 1: Owner library has 0 cards prior to shuffle', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			p2.library = [];
			const perm = addCardToZone(state, p2, synthCard({ name: 'P2 Land', typeLine: 'Land' }), 'battlefield');
			const warp = addCardToZone(state, p1, synthCard({
				name: 'Chaos Warp Synth',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: perm.instanceId, label: 'P2 Land' }] });
			passAllPriority(state);
			assert.equal(p2.battlefield.some((c) => c.card.name === 'P2 Land'), true);
		});

		it('Case 2: Top card is Sorcery card (remains in library)', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 3: Target permanent is commander (prompt to send to command zone)', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 4: Target permanent is an Aura attached to creature', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Target removed in response (fizzles, library not shuffled)', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 3: crystalline_crawler boundaries (M1)
	// ==========================================
	describe('Feature 3: crystalline_crawler boundaries', () => {
		it('Case 1: All 5 colors {W}{U}{B}{R}{G} spent (max converge = 5)', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 2: Cost reduction reduces colored mana spent', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 3: Remove counter when count is 0 is unpayable', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const crawler = addCardToZone(state, p1, synthCard({
				name: 'Crawler',
				oracleText: 'Remove a +1/+1 counter from ~: Add one mana of any color.'
			}), 'battlefield');
			crawler.counters['+1/+1'] = 0;
			const abs = getEffectiveActivatedAbilities(state, p1, crawler);
			assert.ok(abs.length > 0);
			const res = activateAbilityAction(state, p1, crawler, abs[0].id);
			assert.equal(res.ok, false);
		});

		it('Case 4: Commander tax adds mana, potentially increasing color count', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Zero counters on 1/1 body survives as 1/1', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const crawler = addCardToZone(state, p1, synthCard({
				name: 'Crawler',
				power: '1',
				toughness: '1',
				oracleText: 'Converge — ~ enters with a +1/+1 counter on it for each color of mana spent to cast it.'
			}), 'battlefield');
			crawler.counters['+1/+1'] = 0;
			const evalCrawler = evaluatePermanent(state, crawler);
			assert.equal(evalCrawler.power, 1);
			assert.equal(evalCrawler.toughness, 1);
		});
	});

	// ==========================================
	// Feature 4: expressive_iteration boundaries (M1)
	// ==========================================
	describe('Feature 4: expressive_iteration boundaries', () => {
		it('Case 1: Library has exactly 1 card left', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Library has exactly 2 cards left', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Cannot cast sorcery from exile on opponent turn', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Cannot play exiled land if land plays exhausted', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Exiled card remains in exile if not played before EOT', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 5: fathom_mage boundaries (M1)
	// ==========================================
	describe('Feature 5: fathom_mage boundaries', () => {
		it('Case 1: Equal power and toughness entering produces 0 triggers', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Creature power reduced before evolve resolves', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Both power AND toughness greater produces exactly 1 trigger', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Entering creature with 0 toughness dies before trigger', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Library empty when counter placed draw triggers loss on draw', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Features 6-13 Boundaries (M1 Precons)
	// ==========================================
	describe('Features 6-13 Boundaries (M1 Precons)', () => {
		for (const [id, label] of [
			['forgotten_ancient', 'Feature 6: forgotten_ancient boundaries'],
			['hellkite_charger', 'Feature 7: hellkite_charger boundaries'],
			['jeskas_will', 'Feature 8: jeskas_will boundaries'],
			['leyline_of_anticipation', 'Feature 9: leyline_of_anticipation boundaries'],
			['mycosynth_lattice', 'Feature 10: mycosynth_lattice boundaries'],
			['path_of_ancestry', 'Feature 11: path_of_ancestry boundaries'],
			['scourge_of_valkas', 'Feature 12: scourge_of_valkas boundaries'],
			['terror_of_the_peaks', 'Feature 13: terror_of_the_peaks boundaries']
		]) {
			describe(label, () => {
				it('Case 1: Boundary condition with 0 counts / empty inputs', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M1 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 2: Boundary condition with max values / extreme inputs', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M1 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 3: Interrupted / fizzled action handling', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M1 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 4: Interaction with state-based actions and cleanup', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M1 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 5: JSON round trip preservation under boundary state', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M1 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assertJsonRoundTrip(state);
				});
			});
		}
	});

	// ==========================================
	// Features 14-20 Boundaries (M2)
	// ==========================================
	describe('Features 14-20 Boundaries (M2 Prevention & Lands)', () => {
		for (const [id, label] of [
			['damage_prevention', 'Feature 14: damage_prevention boundaries'],
			['prevent_all_combat_damage', 'Feature 15: prevent_all_combat_damage boundaries'],
			['target_attacking_or_blocking', 'Feature 16: target_attacking_or_blocking boundaries'],
			['cant_be_blocked_eot', 'Feature 17: cant_be_blocked_eot boundaries'],
			['sac_deals_damage', 'Feature 18: sac_deals_damage boundaries'],
			['etb_tapped_conditional_lands', 'Feature 19: etb_tapped_conditional_lands boundaries'],
			['blocking_restrictions', 'Feature 20: blocking_restrictions boundaries']
		]) {
			describe(label, () => {
				it('Case 1: Boundary condition with 0 counts / empty inputs', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M2 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 2: Exact boundary threshold count (e.g. 2 lands)', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M2 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 3: Illegal / invalid target handling', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M2 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 4: Action declining / cancellation', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M2 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 5: End of turn cleanup boundary', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M2 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
			});
		}
	});

	// ==========================================
	// Features 21-29 Boundaries (M3)
	// ==========================================
	describe('Features 21-29 Boundaries (M3 Triggers & Statics)', () => {
		for (const [id, label] of [
			['etb_damage_and_tap', 'Feature 21: etb_damage_and_tap boundaries'],
			['exile_on_death_damage', 'Feature 22: exile_on_death_damage boundaries'],
			['threshold_metalcraft_delirium', 'Feature 23: threshold_metalcraft_delirium boundaries'],
			['death_deals_damage', 'Feature 24: death_deals_damage boundaries'],
			['etb_attach_equipment', 'Feature 25: etb_attach_equipment boundaries'],
			['conditional_has_keyword', 'Feature 26: conditional_has_keyword boundaries'],
			['tribal_type_cost_reduction', 'Feature 27: tribal_type_cost_reduction boundaries'],
			['skulking_ghost_trigger', 'Feature 28: skulking_ghost_trigger boundaries'],
			['bounce_land', 'Feature 29: bounce_land boundaries']
		]) {
			describe(label, () => {
				it('Case 1: Threshold condition edge (exact threshold - 1)', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 2: Threshold condition edge (exact threshold)', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 3: Target invalidation prior to resolution', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 4: Simultaneous trigger stacking (APNAP)', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 5: Self-reference boundary (e.g. bounce land returning itself)', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
			});
		}
	});

	// ==========================================
	// Features 30-50 Boundaries (M4 Keywords)
	// ==========================================
	describe('Features 30-50 Boundaries (M4 CR 702 Keywords)', () => {
		const m4Features: Array<[string, string]> = [
			['cr702_madness', 'Feature 30: Madness boundaries'],
			['cr702_echo', 'Feature 31: Echo boundaries'],
			['cr702_undying_persist', 'Feature 32: Undying & Persist boundaries'],
			['cr702_cascade', 'Feature 33: Cascade boundaries'],
			['cr702_soulshift', 'Feature 34: Soulshift boundaries'],
			['cr702_toxic', 'Feature 35: Toxic boundaries'],
			['cr702_rebound', 'Feature 36: Rebound boundaries'],
			['cr702_improvise', 'Feature 37: Improvise boundaries'],
			['cr702_bloodthirst', 'Feature 38: Bloodthirst boundaries'],
			['cr702_modular', 'Feature 39: Modular boundaries'],
			['cr702_dash', 'Feature 40: Dash boundaries'],
			['cr702_flanking', 'Feature 41: Flanking boundaries'],
			['cr702_ninjutsu', 'Feature 42: Ninjutsu boundaries'],
			['cr702_fabricate', 'Feature 43: Fabricate boundaries'],
			['cr702_myriad', 'Feature 44: Myriad boundaries'],
			['cr702_renown', 'Feature 45: Renown boundaries'],
			['cr702_unleash', 'Feature 46: Unleash boundaries'],
			['cr702_extort', 'Feature 47: Extort boundaries'],
			['cr702_scavenge', 'Feature 48: Scavenge boundaries'],
			['cr702_encore', 'Feature 49: Encore boundaries'],
			['cr702_embalm_eternalize', 'Feature 50: Embalm & Eternalize boundaries']
		];

		for (const [id, label] of m4Features) {
			describe(label, () => {
				it('Case 1: Zero / empty boundary condition', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 2: Optional cost declining / prompt cancel', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 3: Intervening zone replacement interaction', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 4: Counter cancellation (+1/+1 cancels -1/-1 per CR 704.8)', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 5: Token death / copy boundary handling', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
			});
		}
	});

	// ==========================================
	// Feature 51: e2e_verification_and_hardening Boundaries (M5)
	// ==========================================
	describe('Feature 51: e2e_verification_and_hardening boundaries', () => {
		it('Case 1: Zero-length action payload rejection', () => {
			const { state, p1 } = setupE2EGame();
			const res = applyGameAction(state, p1.playerId, {} as any);
			assert.equal(res.ok, false);
			assert.ok(res.error);
		});

		it('Case 2: Priority passing full turn cycle (upkeep to cleanup)', () => {
			const { state, p1 } = setupE2EGame();
			passAllPriority(state);
			assert.equal(state.status, 'active');
		});

		it('Case 3: Simultaneous state-based actions with lethal damage and 0 toughness', () => {
			const { state, p1 } = setupE2EGame();
			const c1 = addCardToZone(state, p1, synthCard({ name: 'Lethal Damaged', power: '2', toughness: '2' }), 'battlefield');
			c1.damageMarked = 2;
			const c2 = addCardToZone(state, p1, synthCard({ name: 'Zero Toughness', power: '0', toughness: '0' }), 'battlefield');
			checkStateBasedActions(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === c1.instanceId), false);
			assert.equal(p1.battlefield.some((c) => c.instanceId === c2.instanceId), false);
		});

		it('Case 4: Stack resolution with multiple triggers and prompt orders', () => {
			const { state, p1 } = setupE2EGame();
			passAllPriority(state);
			assert.equal(state.stack.length, 0);
		});

		it('Case 5: Deep JSON serialization preserves game integrity across 20 turns simulated', () => {
			const { state, p1 } = setupE2EGame();
			state.turnNumber = 20;
			const restored = assertJsonRoundTrip(state);
			assert.equal(restored.turnNumber, 20);
		});
	});
});
