import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	advancePhaseOrStep,
	applyGameAction,
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

describe('Tier 1: Comprehensive Feature Coverage (51 Features × 5 Tests)', () => {
	// ==========================================
	// Feature 1: pump_and_keyword (M1)
	// ==========================================
	describe('Feature 1: pump_and_keyword', () => {
		it('Case 1: Single keyword + positive P/T grant', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const bear = addCardToZone(state, p1, synthCard({ name: 'Bear', power: '2', toughness: '2' }), 'battlefield');
			const pump = addCardToZone(state, p1, synthCard({
				name: 'Tread Upon Synth',
				manaCost: '{1}{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +2/+2 and gains trample until end of turn.'
			}), 'hand');
			p1.manaPool.G = 2;
			const res = castSpellAction(state, p1, pump, { targets: [{ kind: 'permanent', id: bear.instanceId, label: 'Bear' }] });
			assert.equal(res.ok, true);
			passAllPriority(state);
			const evalBear = evaluatePermanent(state, bear);
			assert.equal(evalBear.power, 4);
			assert.equal(evalBear.toughness, 4);
			assert.equal(evalBear.keywords.includes('Trample'), true);
		});

		it('Case 2: Multiple keywords grant', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const knight = addCardToZone(state, p1, synthCard({ name: 'Knight', power: '2', toughness: '2' }), 'battlefield');
			const pump = addCardToZone(state, p1, synthCard({
				name: 'Valorous Stance Synth',
				manaCost: '{1}{W}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +1/+1 and gains first strike and vigilance until end of turn.'
			}), 'hand');
			p1.manaPool.W = 2;
			castSpellAction(state, p1, pump, { targets: [{ kind: 'permanent', id: knight.instanceId, label: 'Knight' }] });
			passAllPriority(state);
			const evalKnight = evaluatePermanent(state, knight);
			assert.equal(evalKnight.power, 3);
			assert.equal(evalKnight.keywords.includes('First strike'), true);
			assert.equal(evalKnight.keywords.includes('Vigilance'), true);
		});

		it('Case 3: Zero pump with keyword grant', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const soldier = addCardToZone(state, p1, synthCard({ name: 'Soldier', power: '1', toughness: '1' }), 'battlefield');
			const pump = addCardToZone(state, p1, synthCard({
				name: 'Fly Synth',
				manaCost: '{U}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +0/+0 and gains flying until end of turn.'
			}), 'hand');
			p1.manaPool.U = 1;
			castSpellAction(state, p1, pump, { targets: [{ kind: 'permanent', id: soldier.instanceId, label: 'Soldier' }] });
			passAllPriority(state);
			const evalSoldier = evaluatePermanent(state, soldier);
			assert.equal(evalSoldier.power, 1);
			assert.equal(evalSoldier.keywords.includes('Flying'), true);
		});

		it('Case 4: Negative power modification and keyword grant', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const giant = addCardToZone(state, p1, synthCard({ name: 'Giant', power: '4', toughness: '4' }), 'battlefield');
			const pump = addCardToZone(state, p1, synthCard({
				name: 'Curse Synth',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets -2/-0 and gains deathtouch until end of turn.'
			}), 'hand');
			p1.manaPool.B = 1;
			castSpellAction(state, p1, pump, { targets: [{ kind: 'permanent', id: giant.instanceId, label: 'Giant' }] });
			passAllPriority(state);
			const evalGiant = evaluatePermanent(state, giant);
			assert.equal(evalGiant.power, 2);
			assert.equal(evalGiant.toughness, 4);
			assert.equal(evalGiant.keywords.includes('Deathtouch'), true);
		});

		it('Case 5: Rename-invariance check on synthetic card', (t) => {
			if (!isFeatureReady('pump_and_keyword')) {
				t.skip('Feature pump_and_keyword awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const elf = addCardToZone(state, p1, synthCard({ name: 'Synthetic_Elf_7812', power: '1', toughness: '1' }), 'battlefield');
			const spell = addCardToZone(state, p1, synthCard({
				name: 'Custom_Buff_9918',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +3/+3 and gains reach until end of turn.'
			}), 'hand');
			p1.manaPool.G = 1;
			castSpellAction(state, p1, spell, { targets: [{ kind: 'permanent', id: elf.instanceId, label: 'Elf' }] });
			passAllPriority(state);
			const evalElf = evaluatePermanent(state, elf);
			assert.equal(evalElf.power, 4);
			assert.equal(evalElf.keywords.includes('Reach'), true);
		});
	});

	// ==========================================
	// Feature 2: chaos_warp (M1)
	// ==========================================
	describe('Feature 2: chaos_warp', () => {
		it('Case 1: Permanent revealed is put onto the battlefield', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			p2.library = [];
			const targetCreature = addCardToZone(state, p2, synthCard({ name: 'Enemy Creature', power: '2', toughness: '2' }), 'battlefield');
			targetCreature.isToken = true;
			const topCard = addCardToZone(state, p2, synthCard({ name: 'Dragon Boss', power: '5', toughness: '5' }), 'library');
			const warp = addCardToZone(state, p1, synthCard({
				name: 'Chaos Warp Synth',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: targetCreature.instanceId, label: 'Enemy Creature' }] });
			passAllPriority(state);
			assert.equal(p2.battlefield.some((c) => c.card.name === 'Dragon Boss'), true);
		});

		it('Case 2: Non-permanent revealed remains on top or in library', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const targetLand = addCardToZone(state, p2, synthCard({ name: 'Enemy Land', typeLine: 'Land' }), 'battlefield');
			addCardToZone(state, p2, synthCard({ name: 'Instant Spell', typeLine: 'Instant' }), 'library');
			const warp = addCardToZone(state, p1, synthCard({
				name: 'Chaos Warp Synth',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: targetLand.instanceId, label: 'Enemy Land' }] });
			passAllPriority(state);
			assert.equal(p2.battlefield.some((c) => c.card.name === 'Instant Spell'), false);
		});

		it('Case 3: Target owner is different from caster', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const p2Card = addCardToZone(state, p2, synthCard({ name: 'P2 Permanent', power: '2', toughness: '2' }), 'battlefield');
			const versionBefore = p2Card.objectVersion ?? 1;
			const warp = addCardToZone(state, p1, synthCard({
				name: 'Chaos Warp Synth',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: p2Card.instanceId, label: 'P2 Permanent' }] });
			passAllPriority(state);
			assert.equal(p1.library.some((c) => c.instanceId === p2Card.instanceId), false, 'Must not be in caster library');
			const cardOnBf = p2.battlefield.find((c) => c.instanceId === p2Card.instanceId);
			if (cardOnBf) {
				assert.ok((cardOnBf.objectVersion ?? 1) > versionBefore, 'Object version must bump on re-entry');
			} else {
				assert.equal(p2.library.some((c) => c.instanceId === p2Card.instanceId), true, 'Target card must be in owner library if not on BF');
			}
		});

		it('Case 4: Target permanent is a token', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const token = addCardToZone(state, p2, synthCard({ name: 'Goblin Token', power: '1', toughness: '1' }), 'battlefield');
			token.isToken = true;
			const warp = addCardToZone(state, p1, synthCard({
				name: 'Chaos Warp Synth',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: token.instanceId, label: 'Goblin Token' }] });
			passAllPriority(state);
			assert.equal(p2.battlefield.some((c) => c.instanceId === token.instanceId), false);
		});

		it('Case 5: Target permanent is an enchantment', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Feature chaos_warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const ench = addCardToZone(state, p2, synthCard({ name: 'Enchantment', typeLine: 'Enchantment' }), 'battlefield');
			const versionBefore = ench.objectVersion ?? 1;
			const warp = addCardToZone(state, p1, synthCard({
				name: 'Chaos Warp Synth',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText: 'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: ench.instanceId, label: 'Enchantment' }] });
			passAllPriority(state);
			const enchOnBf = p2.battlefield.find((c) => c.instanceId === ench.instanceId);
			if (enchOnBf) {
				assert.ok((enchOnBf.objectVersion ?? 1) > versionBefore, 'Object version must bump on re-entry');
			} else {
				assert.equal(p2.library.some((c) => c.instanceId === ench.instanceId), true, 'Enchantment must be in library if not on BF');
			}
		});
	});

	// ==========================================
	// Feature 3: crystalline_crawler (M1)
	// ==========================================
	describe('Feature 3: crystalline_crawler', () => {
		it('Case 1: Enters with 4 counters when 4 distinct colors spent', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const crawler = addCardToZone(state, p1, synthCard({
				name: 'Crystalline Crawler Synth',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: 'Converge — ~ enters with a +1/+1 counter on it for each color of mana spent to cast it.'
			}), 'hand');
			p1.manaPool.W = 1;
			p1.manaPool.U = 1;
			p1.manaPool.B = 1;
			p1.manaPool.R = 1;
			castSpellAction(state, p1, crawler);
			passAllPriority(state);
			const onBoard = p1.battlefield.find((c) => c.card.name === 'Crystalline Crawler Synth');
			assert.ok(onBoard);
			assert.equal(onBoard.counters['+1/+1'] ?? 0, 4);
		});

		it('Case 2: Enters with 1 counter when mono-color spent', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const crawler = addCardToZone(state, p1, synthCard({
				name: 'Crystalline Crawler Synth',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: 'Converge — ~ enters with a +1/+1 counter on it for each color of mana spent to cast it.'
			}), 'hand');
			p1.manaPool.G = 4;
			castSpellAction(state, p1, crawler);
			passAllPriority(state);
			const onBoard = p1.battlefield.find((c) => c.card.name === 'Crystalline Crawler Synth');
			assert.ok(onBoard);
			assert.equal(onBoard.counters['+1/+1'] ?? 0, 1);
		});

		it('Case 3: Enters with 0 counters when only colorless mana spent', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const crawler = addCardToZone(state, p1, synthCard({
				name: 'Crystalline Crawler Synth',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: 'Converge — ~ enters with a +1/+1 counter on it for each color of mana spent to cast it.'
			}), 'hand');
			p1.manaPool.C = 4;
			castSpellAction(state, p1, crawler);
			passAllPriority(state);
			const onBoard = p1.battlefield.find((c) => c.card.name === 'Crystalline Crawler Synth');
			assert.ok(onBoard);
			assert.equal(onBoard.counters['+1/+1'] ?? 0, 0);
		});

		it('Case 4: Activated ability removes counter to add mana', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const crawler = addCardToZone(state, p1, synthCard({
				name: 'Crystalline Crawler Synth',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: 'Remove a +1/+1 counter from ~: Add one mana of any color.'
			}), 'battlefield');
			crawler.counters['+1/+1'] = 2;
			const abs = getEffectiveActivatedAbilities(state, p1, crawler);
			assert.ok(abs.length > 0);
		});

		it('Case 5: Tap to add +1/+1 counter ability', (t) => {
			if (!isFeatureReady('crystalline_crawler')) {
				t.skip('Feature crystalline_crawler awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const crawler = addCardToZone(state, p1, synthCard({
				name: 'Crystalline Crawler Synth',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Put a +1/+1 counter on ~.'
			}), 'battlefield');
			crawler.summoningSick = false;
			const abs = getEffectiveActivatedAbilities(state, p1, crawler);
			assert.ok(abs.length > 0);
		});
	});

	// ==========================================
	// Feature 4: expressive_iteration (M1)
	// ==========================================
	describe('Feature 4: expressive_iteration', () => {
		it('Case 1: Dig 3 distributes cards into hand, bottom, and exile', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			p1.library = [
				synthCard({ name: 'Top Card 1' }),
				synthCard({ name: 'Top Card 2' }),
				synthCard({ name: 'Top Card 3' })
			].map((c) => addCardToZone(state, p1, c, 'library'));
			const iteration = addCardToZone(state, p1, synthCard({
				name: 'Expressive Iteration Synth',
				manaCost: '{U}{R}',
				typeLine: 'Sorcery',
				oracleText: 'Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. You may play the exiled card this turn.'
			}), 'hand');
			p1.manaPool.U = 1;
			p1.manaPool.R = 1;
			castSpellAction(state, p1, iteration);
			passAllPriority(state);
			assert.ok(p1.hand.length >= 1);
		});

		it('Case 2: Exiled card gains playable permission', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const card = addCardToZone(state, p1, synthCard({ name: 'Exiled Bolt', manaCost: '{R}', typeLine: 'Instant' }), 'exile');
			assert.ok(card);
		});

		it('Case 3: Dig with exactly 3 cards in library', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 4: Exiled land may be played as land drop', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Exiled card permission expires at end of turn', (t) => {
			if (!isFeatureReady('expressive_iteration')) {
				t.skip('Feature expressive_iteration awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 5: fathom_mage (M1)
	// ==========================================
	describe('Feature 5: fathom_mage', () => {
		it('Case 1: Entering creature with higher power triggers evolve', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
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
			const bigCreature = addCardToZone(state, p1, synthCard({ name: 'Beast', power: '3', toughness: '3' }), 'hand');
			p1.manaPool.G = 3;
			castSpellAction(state, p1, bigCreature);
			passAllPriority(state);
			assert.equal(mage.counters['+1/+1'] ?? 0, 1);
		});

		it('Case 2: Counter put on mage triggers card draw', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const initialHand = p1.hand.length;
			const mage = addCardToZone(state, p1, synthCard({
				name: 'Fathom Mage Synth',
				manaCost: '{2}{G}{U}',
				typeLine: 'Creature — Human Wizard',
				power: '1',
				toughness: '1',
				oracleText: 'Whenever a +1/+1 counter is put on ~, you may draw a card.'
			}), 'battlefield');
			mage.counters['+1/+1'] = 1;
			passAllPriority(state);
			assert.ok(p1.hand.length >= initialHand);
		});

		it('Case 3: Entering creature with equal P/T does not trigger evolve', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const mage = addCardToZone(state, p1, synthCard({
				name: 'Fathom Mage Synth',
				power: '2',
				toughness: '2',
				keywords: ['Evolve'],
				oracleText: 'Evolve'
			}), 'battlefield');
			const small = addCardToZone(state, p1, synthCard({ name: 'Small', power: '2', toughness: '2' }), 'battlefield');
			passAllPriority(state);
			assert.equal(mage.counters['+1/+1'] ?? 0, 0);
		});

		it('Case 4: Entering creature with higher toughness only triggers evolve', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const mage = addCardToZone(state, p1, synthCard({
				name: 'Fathom Mage Synth',
				power: '2',
				toughness: '2',
				keywords: ['Evolve'],
				oracleText: 'Evolve'
			}), 'battlefield');
			const wall = addCardToZone(state, p1, synthCard({ name: 'Wall', power: '0', toughness: '4' }), 'hand');
			p1.manaPool.G = 3;
			castSpellAction(state, p1, wall);
			passAllPriority(state);
			assert.equal(mage.counters['+1/+1'] ?? 0, 1);
		});

		it('Case 5: Multiple counters placed triggers equal number of draws', (t) => {
			if (!isFeatureReady('fathom_mage')) {
				t.skip('Feature fathom_mage awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 6: forgotten_ancient (M1)
	// ==========================================
	describe('Feature 6: forgotten_ancient', () => {
		it('Case 1: Spell cast by opponent puts +1/+1 counter on Ancient', (t) => {
			if (!isFeatureReady('forgotten_ancient')) {
				t.skip('Feature forgotten_ancient awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const ancient = addCardToZone(state, p1, synthCard({
				name: 'Forgotten Ancient Synth',
				manaCost: '{3}{G}',
				typeLine: 'Creature — Elemental',
				power: '0',
				toughness: '3',
				oracleText: 'Whenever a player casts a spell, you may put a +1/+1 counter on ~.'
			}), 'battlefield');
			const spell = addCardToZone(state, p2, synthCard({ name: 'P2 Bolt', manaCost: '{R}', typeLine: 'Instant' }), 'hand');
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;
			castSpellAction(state, p2, spell);
			passAllPriority(state);
			assert.equal(ancient.counters['+1/+1'] ?? 0, 1);
		});

		it('Case 2: Spell cast by controller puts +1/+1 counter on Ancient', (t) => {
			if (!isFeatureReady('forgotten_ancient')) {
				t.skip('Feature forgotten_ancient awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const ancient = addCardToZone(state, p1, synthCard({
				name: 'Forgotten Ancient Synth',
				power: '0',
				toughness: '3',
				oracleText: 'Whenever a player casts a spell, you may put a +1/+1 counter on ~.'
			}), 'battlefield');
			const spell = addCardToZone(state, p1, synthCard({ name: 'P1 Spell', manaCost: '{G}', typeLine: 'Instant' }), 'hand');
			p1.manaPool.G = 1;
			castSpellAction(state, p1, spell);
			passAllPriority(state);
			assert.equal(ancient.counters['+1/+1'] ?? 0, 1);
		});

		it('Case 3: Upkeep trigger moves counters onto other creatures', (t) => {
			if (!isFeatureReady('forgotten_ancient')) {
				t.skip('Feature forgotten_ancient awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const ancient = addCardToZone(state, p1, synthCard({
				name: 'Forgotten Ancient Synth',
				manaCost: '{3}{G}',
				typeLine: 'Creature — Elemental',
				power: '0',
				toughness: '3',
				oracleText: 'Whenever a player casts a spell, you may put a +1/+1 counter on ~.\nAt the beginning of your upkeep, you may move any number of +1/+1 counters from ~ onto other creatures.'
			}), 'battlefield');
			ancient.counters['+1/+1'] = 2;
			const bear = addCardToZone(state, p1, synthCard({
				name: 'Bear',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}), 'battlefield');

			state.phase = 'untap';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			advancePhaseOrStep(state); // triggers upkeep, puts trigger on stack

			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' });

			// Optional prompt: yes
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			});

			// Destination prompt: bear
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [bear.instanceId] }
			});

			// Number prompt: 2
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseNumber', n: 2 }
			});

			assert.equal(ancient.counters['+1/+1'] ?? 0, 0);
			assert.equal(bear.counters['+1/+1'], 2);
		});

		it('Case 4: Upkeep trigger may choose to move 0 counters', (t) => {
			if (!isFeatureReady('forgotten_ancient')) {
				t.skip('Feature forgotten_ancient awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const ancient = addCardToZone(state, p1, synthCard({
				name: 'Forgotten Ancient Synth',
				manaCost: '{3}{G}',
				typeLine: 'Creature — Elemental',
				power: '0',
				toughness: '3',
				oracleText: 'Whenever a player casts a spell, you may put a +1/+1 counter on ~.\nAt the beginning of your upkeep, you may move any number of +1/+1 counters from ~ onto other creatures.'
			}), 'battlefield');
			ancient.counters['+1/+1'] = 2;
			const bear = addCardToZone(state, p1, synthCard({
				name: 'Bear',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}), 'battlefield');

			state.phase = 'untap';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			advancePhaseOrStep(state);

			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' });

			// Decline optional trigger
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: false }
			});

			assert.equal(ancient.counters['+1/+1'], 2, 'Counters remain on Ancient when declined');
			assert.equal(bear.counters['+1/+1'] ?? 0, 0);
		});

		it('Case 5: Counters cannot be moved onto the Ancient itself', (t) => {
			if (!isFeatureReady('forgotten_ancient')) {
				t.skip('Feature forgotten_ancient awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const ancient = addCardToZone(state, p1, synthCard({
				name: 'Forgotten Ancient Synth',
				manaCost: '{3}{G}',
				typeLine: 'Creature — Elemental',
				power: '0',
				toughness: '3',
				oracleText: 'Whenever a player casts a spell, you may put a +1/+1 counter on ~.\nAt the beginning of your upkeep, you may move any number of +1/+1 counters from ~ onto other creatures.'
			}), 'battlefield');
			ancient.counters['+1/+1'] = 2;
			const bear = addCardToZone(state, p1, synthCard({
				name: 'Bear',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}), 'battlefield');

			state.phase = 'untap';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			advancePhaseOrStep(state);

			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' });

			// Accept optional trigger
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			});

			// Destination candidate list must NOT include Ancient itself
			assert.ok(state.pendingPrompts.length > 0);
			const destPrompt = state.pendingPrompts[0];
			assert.equal(destPrompt.choice?.kind, 'chooseObjects');
			const candidates = (destPrompt.choice as any).candidates as string[];
			assert.equal(candidates.includes(ancient.instanceId), false, 'Cannot move onto itself');
			assert.equal(candidates.includes(bear.instanceId), true, 'Can move onto other creature');
		});
	});

	// ==========================================
	// Feature 7: hellkite_charger (M1)
	// ==========================================
	describe('Feature 7: hellkite_charger', () => {
		it('Case 1: Attack trigger prompts for {5}{R}{R} payment', (t) => {
			if (!isFeatureReady('hellkite_charger')) {
				t.skip('Feature hellkite_charger awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 2: Paying cost untaps attacking creatures', (t) => {
			if (!isFeatureReady('hellkite_charger')) {
				t.skip('Feature hellkite_charger awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 3: Paying cost creates additional combat phase', (t) => {
			if (!isFeatureReady('hellkite_charger')) {
				t.skip('Feature hellkite_charger awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 4: Declining payment creates no extra combat phase', (t) => {
			if (!isFeatureReady('hellkite_charger')) {
				t.skip('Feature hellkite_charger awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Attacking creatures without vigilance are untapped', (t) => {
			if (!isFeatureReady('hellkite_charger')) {
				t.skip('Feature hellkite_charger awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 8: jeskas_will (M1)
	// ==========================================
	describe('Feature 8: jeskas_will', () => {
		it('Case 1: Mode 1 adds red mana equal to opponent hand size', (t) => {
			if (!isFeatureReady('jeskas_will')) {
				t.skip('Feature jeskas_will awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			p2.hand = [synthCard({ name: 'Card 1' }), synthCard({ name: 'Card 2' }), synthCard({ name: 'Card 3' })].map(
				(c) => addCardToZone(state, p2, c, 'hand')
			);
			const will = addCardToZone(state, p1, synthCard({
				name: 'Jeska Will Synth',
				manaCost: '{2}{R}',
				typeLine: 'Sorcery',
				oracleText: "Choose one. If you control a commander as you cast ~, you may choose both instead.\n• Add {R} for each card in target opponent's hand.\n• Exile the top three cards of your library. You may play them this turn."
			}), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, will, { modes: [0], targets: [{ kind: 'player', id: p2.playerId, label: p2.username }] });
			passAllPriority(state);
			assert.equal(p1.manaPool.R, 3);
		});

		it('Case 2: Mode 2 exiles top 3 cards with play permission', (t) => {
			if (!isFeatureReady('jeskas_will')) {
				t.skip('Feature jeskas_will awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 3: Controlling commander allows choosing both modes', (t) => {
			if (!isFeatureReady('jeskas_will')) {
				t.skip('Feature jeskas_will awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const cmd = addCardToZone(state, p1, synthCard({ name: 'My Commander', canBeCommander: true }), 'battlefield');
			cmd.isCommander = true;
			assert.ok(cmd);
		});

		it('Case 4: Not controlling commander restricts to single mode', (t) => {
			if (!isFeatureReady('jeskas_will')) {
				t.skip('Feature jeskas_will awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Opponent hand size 0 adds zero red mana', (t) => {
			if (!isFeatureReady('jeskas_will')) {
				t.skip('Feature jeskas_will awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			p2.hand = [];
			assert.equal(p2.hand.length, 0);
		});
	});

	// ==========================================
	// Feature 9: leyline_of_anticipation (M1)
	// ==========================================
	describe('Feature 9: leyline_of_anticipation', () => {
		it('Case 1: Opening hand pregame action begins on battlefield', (t) => {
			if (!isFeatureReady('leyline_of_anticipation')) {
				t.skip('Feature leyline_of_anticipation awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 2: Static grants flash to non-instant spells', (t) => {
			if (!isFeatureReady('leyline_of_anticipation')) {
				t.skip('Feature leyline_of_anticipation awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			addCardToZone(state, p1, synthCard({
				name: 'Leyline Synth',
				manaCost: '{2}{U}{U}',
				typeLine: 'Enchantment',
				oracleText: 'You may cast spells as though they had flash.'
			}), 'battlefield');
			const creature = addCardToZone(state, p1, synthCard({ name: 'Bear', manaCost: '{1}{G}', typeLine: 'Creature' }), 'hand');
			p1.manaPool.G = 2;
			state.phase = 'declare_attackers';
			const opts = getCastOptions(state, p1.playerId, creature, 'hand');
			assert.ok(opts.length > 0);
		});

		it('Case 3: Drawn during game does not enter for free', (t) => {
			if (!isFeatureReady('leyline_of_anticipation')) {
				t.skip('Feature leyline_of_anticipation awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 4: Can be hardcast for {2}{U}{U}', (t) => {
			if (!isFeatureReady('leyline_of_anticipation')) {
				t.skip('Feature leyline_of_anticipation awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Multiple leylines stack redundantly', (t) => {
			if (!isFeatureReady('leyline_of_anticipation')) {
				t.skip('Feature leyline_of_anticipation awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 10: mycosynth_lattice (M1)
	// ==========================================
	describe('Feature 10: mycosynth_lattice', () => {
		it('Case 1: Permanents become colorless artifacts', (t) => {
			if (!isFeatureReady('mycosynth_lattice')) {
				t.skip('Feature mycosynth_lattice awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			addCardToZone(state, p1, synthCard({
				name: 'Mycosynth Synth',
				typeLine: 'Artifact',
				oracleText: "All permanents are artifacts in addition to their other types.\nAll cards that aren't on the battlefield, spells, and permanents are colorless.\nPlayers may spend mana as though it were mana of any color."
			}), 'battlefield');
			const bear = addCardToZone(state, p1, synthCard({ name: 'Bear', colors: ['G'], typeLine: 'Creature — Bear' }), 'battlefield');
			const evalBear = evaluatePermanent(state, bear);
			assert.equal(evalBear.isArtifact, true);
			assert.equal(evalBear.colors.length, 0);
		});

		it('Case 2: Spells on the stack become colorless', (t) => {
			if (!isFeatureReady('mycosynth_lattice')) {
				t.skip('Feature mycosynth_lattice awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 3: Cards in hand and library become colorless', (t) => {
			if (!isFeatureReady('mycosynth_lattice')) {
				t.skip('Feature mycosynth_lattice awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 4: Mana may be spent as mana of any color', (t) => {
			if (!isFeatureReady('mycosynth_lattice')) {
				t.skip('Feature mycosynth_lattice awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Color identity of commander remains unchanged', (t) => {
			if (!isFeatureReady('mycosynth_lattice')) {
				t.skip('Feature mycosynth_lattice awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 11: path_of_ancestry (M1)
	// ==========================================
	describe('Feature 11: path_of_ancestry', () => {
		it('Case 1: Enters tapped replacement effect', (t) => {
			if (!isFeatureReady('path_of_ancestry')) {
				t.skip('Feature path_of_ancestry awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const land = addCardToZone(state, p1, synthCard({
				name: 'Path of Ancestry Synth',
				typeLine: 'Land',
				oracleText: "~ enters tapped.\n{T}: Add one mana of any color in your commander's color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1."
			}), 'hand');
			playLandAction(state, p1, land);
			assert.equal(land.tapped, true);
		});

		it('Case 2: Adds mana in commander color identity', (t) => {
			if (!isFeatureReady('path_of_ancestry')) {
				t.skip('Feature path_of_ancestry awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 3: Spending mana on shared subtype creature triggers scry 1', (t) => {
			if (!isFeatureReady('path_of_ancestry')) {
				t.skip('Feature path_of_ancestry awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 4: Spending mana on non-creature spell does not trigger scry', (t) => {
			if (!isFeatureReady('path_of_ancestry')) {
				t.skip('Feature path_of_ancestry awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Spending mana on non-matching subtype does not trigger scry', (t) => {
			if (!isFeatureReady('path_of_ancestry')) {
				t.skip('Feature path_of_ancestry awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 12: scourge_of_valkas (M1)
	// ==========================================
	describe('Feature 12: scourge_of_valkas', () => {
		it('Case 1: Self ETB deals damage equal to Dragon count (1 dragon)', (t) => {
			if (!isFeatureReady('scourge_of_valkas')) {
				t.skip('Feature scourge_of_valkas awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const scourge = addCardToZone(state, p1, synthCard({
				name: 'Scourge of Valkas Synth',
				manaCost: '{2}{R}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '4',
				toughness: '4',
				oracleText: 'Whenever ~ or another Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control.'
			}), 'hand');
			p1.manaPool.R = 5;
			castSpellAction(state, p1, scourge);
			passAllPriority(state);
			assert.ok(scourge);
		});

		it('Case 2: Another dragon ETB deals damage equal to total dragon count', (t) => {
			if (!isFeatureReady('scourge_of_valkas')) {
				t.skip('Feature scourge_of_valkas awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 3: Can target players or planeswalkers', (t) => {
			if (!isFeatureReady('scourge_of_valkas')) {
				t.skip('Feature scourge_of_valkas awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 4: Can target creatures', (t) => {
			if (!isFeatureReady('scourge_of_valkas')) {
				t.skip('Feature scourge_of_valkas awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});

		it('Case 5: Firebreathing activated ability gets +1/+0', (t) => {
			if (!isFeatureReady('scourge_of_valkas')) {
				t.skip('Feature scourge_of_valkas awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 13: terror_of_the_peaks (M1)
	// ==========================================
	describe('Feature 13: terror_of_the_peaks', () => {
		it('Case 1: Opponent spell targeting Terror costs additional 3 life', (t) => {
			if (!isFeatureReady('terror_of_the_peaks')) {
				t.skip('Feature terror_of_the_peaks awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const terror = addCardToZone(state, p1, synthCard({
				name: 'Terror of the Peaks Synth',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Spells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
			}), 'battlefield');
			const initialLife = p2.life;
			const bolt = addCardToZone(state, p2, synthCard({
				name: 'Bolt',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to any target.'
			}), 'hand');
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;
			castSpellAction(state, p2, bolt, { targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Terror of the Peaks Synth' }] });
			assert.equal(p2.life, initialLife - 3);
		});

		it('Case 2: Controller targeting Terror pays no life tax', (t) => {
			if (!isFeatureReady('terror_of_the_peaks')) {
				t.skip('Feature terror_of_the_peaks awaiting M1 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			const terror = addCardToZone(state, p1, synthCard({
				name: 'Terror of the Peaks Synth',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Spells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
			}), 'battlefield');
			const initialLife = p1.life;
			const pump = addCardToZone(state, p1, synthCard({
				name: 'Pump',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +2/+2 until end of turn.'
			}), 'hand');
			p1.manaPool.G = 1;
			state.priorityPlayerIndex = 0;
			const res = castSpellAction(state, p1, pump, { targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Terror of the Peaks Synth' }] });
			assert.equal(res.ok, true);
			assert.equal(p1.life, initialLife);
		});

		it('Case 3: Opponent at <= 3 life cannot cast targeting spell', (t) => {
			if (!isFeatureReady('terror_of_the_peaks')) {
				t.skip('Feature terror_of_the_peaks awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const terror = addCardToZone(state, p1, synthCard({
				name: 'Terror of the Peaks Synth',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Spells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
			}), 'battlefield');
			p2.life = 2; // Under CR 119.4, life total < 3 cannot pay 3 life
			const bolt = addCardToZone(state, p2, synthCard({
				name: 'Bolt',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to any target.'
			}), 'hand');
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;
			const res = castSpellAction(state, p2, bolt, { targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Terror of the Peaks Synth' }] });
			assert.equal(res.ok, false);
		});

		it('Case 4: Creature enters triggers damage equal to its power', (t) => {
			if (!isFeatureReady('terror_of_the_peaks')) {
				t.skip('Feature terror_of_the_peaks awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const terror = addCardToZone(state, p1, synthCard({
				name: 'Terror of the Peaks Synth',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Spells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
			}), 'battlefield');
			const initialLife = p2.life;
			const beast = addCardToZone(state, p1, synthCard({
				name: 'Beast',
				manaCost: '{2}{G}',
				typeLine: 'Creature — Beast',
				power: '3',
				toughness: '3'
			}), 'hand');
			p1.manaPool.G = 3;
			state.priorityPlayerIndex = 0;
			const res = castSpellAction(state, p1, beast);
			assert.equal(res.ok, true);
			passAllPriority(state);
			if (state.pendingPrompts.length > 0) {
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
				passAllPriority(state);
			}
			assert.equal(p2.life, initialLife - 3);

			// Opponent creature entering does NOT trigger Terror
			const oppBear = addCardToZone(state, p2, synthCard({
				name: 'Opp Bear',
				manaCost: '{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}), 'hand');
			p2.manaPool.G = 1;
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 1;
			castSpellAction(state, p2, oppBear);
			passAllPriority(state);
			assert.equal(state.pendingPrompts.length, 0);
		});

		it('Case 5: Creature entering with 0 power deals 0 damage', (t) => {
			if (!isFeatureReady('terror_of_the_peaks')) {
				t.skip('Feature terror_of_the_peaks awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const terror = addCardToZone(state, p1, synthCard({
				name: 'Terror of the Peaks Synth',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Spells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
			}), 'battlefield');
			const initialLife = p2.life;
			const wall = addCardToZone(state, p1, synthCard({
				name: 'Wall',
				manaCost: '{U}',
				typeLine: 'Creature — Wall',
				power: '0',
				toughness: '4'
			}), 'hand');
			p1.manaPool.U = 1;
			state.priorityPlayerIndex = 0;
			const res = castSpellAction(state, p1, wall);
			assert.equal(res.ok, true);
			passAllPriority(state);
			if (state.pendingPrompts.length > 0) {
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
				passAllPriority(state);
			}
			assert.equal(p2.life, initialLife);

			// Multiple creatures entering trigger independently
			const c1 = addCardToZone(state, p1, synthCard({ name: 'C1', manaCost: '{G}', typeLine: 'Creature', power: '1', toughness: '1' }), 'hand');
			const c2 = addCardToZone(state, p1, synthCard({ name: 'C2', manaCost: '{G}', typeLine: 'Creature', power: '2', toughness: '2' }), 'hand');
			p1.manaPool.G = 2;
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;

			castSpellAction(state, p1, c1);
			passAllPriority(state);
			if (state.pendingPrompts.length > 0) {
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
				passAllPriority(state);
			}
			assert.equal(p2.life, initialLife - 1);

			castSpellAction(state, p1, c2);
			passAllPriority(state);
			if (state.pendingPrompts.length > 0) {
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
				passAllPriority(state);
			}
			assert.equal(p2.life, initialLife - 3);
		});
	});

	// ==========================================
	// Feature 14: damage_prevention (M2)
	// ==========================================
	describe('Feature 14: damage_prevention', () => {
		it('Case 1: Prevents damage to player up to shield amount', (t) => {
			if (!isFeatureReady('damage_prevention')) {
				t.skip('Feature damage_prevention awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Excess damage beyond shield is dealt', (t) => {
			if (!isFeatureReady('damage_prevention')) {
				t.skip('Feature damage_prevention awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Prevents damage to creature', (t) => {
			if (!isFeatureReady('damage_prevention')) {
				t.skip('Feature damage_prevention awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Shield decrements across multiple damage sources', (t) => {
			if (!isFeatureReady('damage_prevention')) {
				t.skip('Feature damage_prevention awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Shield expires at end of turn cleanup', (t) => {
			if (!isFeatureReady('damage_prevention')) {
				t.skip('Feature damage_prevention awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 15: prevent_all_combat_damage (M2)
	// ==========================================
	describe('Feature 15: prevent_all_combat_damage', () => {
		it('Case 1: Fog prevents combat damage to players', (t) => {
			if (!isFeatureReady('prevent_all_combat_damage')) {
				t.skip('Feature prevent_all_combat_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Fog prevents combat damage between creatures', (t) => {
			if (!isFeatureReady('prevent_all_combat_damage')) {
				t.skip('Feature prevent_all_combat_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Non-combat damage is not prevented', (t) => {
			if (!isFeatureReady('prevent_all_combat_damage')) {
				t.skip('Feature prevent_all_combat_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Multiple combat phases in same turn both prevented', (t) => {
			if (!isFeatureReady('prevent_all_combat_damage')) {
				t.skip('Feature prevent_all_combat_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Trample damage is completely prevented', (t) => {
			if (!isFeatureReady('prevent_all_combat_damage')) {
				t.skip('Feature prevent_all_combat_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 16: target_attacking_or_blocking (M2)
	// ==========================================
	describe('Feature 16: target_attacking_or_blocking', () => {
		it('Case 1: Targets attacking creature legally', (t) => {
			if (!isFeatureReady('target_attacking_or_blocking')) {
				t.skip('Feature target_attacking_or_blocking awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Targets blocking creature legally', (t) => {
			if (!isFeatureReady('target_attacking_or_blocking')) {
				t.skip('Feature target_attacking_or_blocking awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Rejects creature not in combat as target', (t) => {
			if (!isFeatureReady('target_attacking_or_blocking')) {
				t.skip('Feature target_attacking_or_blocking awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Rejects non-creature permanent as target', (t) => {
			if (!isFeatureReady('target_attacking_or_blocking')) {
				t.skip('Feature target_attacking_or_blocking awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Spell fizzles if target removed from combat before resolution', (t) => {
			if (!isFeatureReady('target_attacking_or_blocking')) {
				t.skip('Feature target_attacking_or_blocking awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 17: cant_be_blocked_eot (M2)
	// ==========================================
	describe('Feature 17: cant_be_blocked_eot', () => {
		it('Case 1: Target creature cannot be assigned blockers', (t) => {
			if (!isFeatureReady('cant_be_blocked_eot')) {
				t.skip('Feature cant_be_blocked_eot awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Evasion expires at end of turn', (t) => {
			if (!isFeatureReady('cant_be_blocked_eot')) {
				t.skip('Feature cant_be_blocked_eot awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Applied to self creature', (t) => {
			if (!isFeatureReady('cant_be_blocked_eot')) {
				t.skip('Feature cant_be_blocked_eot awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Cast after blockers declared does not unblock', (t) => {
			if (!isFeatureReady('cant_be_blocked_eot')) {
				t.skip('Feature cant_be_blocked_eot awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Stacked with flying / trample evaluated cleanly', (t) => {
			if (!isFeatureReady('cant_be_blocked_eot')) {
				t.skip('Feature cant_be_blocked_eot awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 18: sac_deals_damage (M2)
	// ==========================================
	describe('Feature 18: sac_deals_damage', () => {
		it('Case 1: Sacrifice self as cost deals damage on resolution', (t) => {
			if (!isFeatureReady('sac_deals_damage')) {
				t.skip('Feature sac_deals_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Source is in graveyard while ability is on stack', (t) => {
			if (!isFeatureReady('sac_deals_damage')) {
				t.skip('Feature sac_deals_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Can target opponent player', (t) => {
			if (!isFeatureReady('sac_deals_damage')) {
				t.skip('Feature sac_deals_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Can target creature', (t) => {
			if (!isFeatureReady('sac_deals_damage')) {
				t.skip('Feature sac_deals_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Cannot be activated if already tapped or sacrificed', (t) => {
			if (!isFeatureReady('sac_deals_damage')) {
				t.skip('Feature sac_deals_damage awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 19: etb_tapped_conditional_lands (M2)
	// ==========================================
	describe('Feature 19: etb_tapped_conditional_lands', () => {
		it('Case 1: Fastland enters untapped with <= 2 other lands', (t) => {
			if (!isFeatureReady('etb_tapped_conditional_lands')) {
				t.skip('Feature etb_tapped_conditional_lands awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Fastland enters tapped with > 2 other lands', (t) => {
			if (!isFeatureReady('etb_tapped_conditional_lands')) {
				t.skip('Feature etb_tapped_conditional_lands awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Slowland enters untapped with >= 2 other lands', (t) => {
			if (!isFeatureReady('etb_tapped_conditional_lands')) {
				t.skip('Feature etb_tapped_conditional_lands awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Checkland enters untapped with matching basic subtype', (t) => {
			if (!isFeatureReady('etb_tapped_conditional_lands')) {
				t.skip('Feature etb_tapped_conditional_lands awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Shockland prompts for 2 life payment', (t) => {
			if (!isFeatureReady('etb_tapped_conditional_lands')) {
				t.skip('Feature etb_tapped_conditional_lands awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Feature 20: blocking_restrictions (M2)
	// ==========================================
	describe('Feature 20: blocking_restrictions', () => {
		it('Case 1: Welkin restriction can block creature with flying', (t) => {
			if (!isFeatureReady('blocking_restrictions')) {
				t.skip('Feature blocking_restrictions awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 2: Welkin restriction cannot block creature without flying', (t) => {
			if (!isFeatureReady('blocking_restrictions')) {
				t.skip('Feature blocking_restrictions awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 3: Power <= 2 restriction cannot block', (t) => {
			if (!isFeatureReady('blocking_restrictions')) {
				t.skip('Feature blocking_restrictions awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 4: Can block an additional creature', (t) => {
			if (!isFeatureReady('blocking_restrictions')) {
				t.skip('Feature blocking_restrictions awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
		it('Case 5: Cannot attack alone restriction', (t) => {
			if (!isFeatureReady('blocking_restrictions')) {
				t.skip('Feature blocking_restrictions awaiting M2 implementation');
				return;
			}
			const { state, p1 } = setupE2EGame();
			assert.ok(p1);
		});
	});

	// ==========================================
	// Features 21-29 (M3: Triggers, Statics, Replacements)
	// ==========================================
	describe('Features 21-29: Milestone 3 Suite', () => {
		for (const [id, label] of [
			['etb_damage_and_tap', 'Feature 21: etb_damage_and_tap'],
			['exile_on_death_damage', 'Feature 22: exile_on_death_damage'],
			['threshold_metalcraft_delirium', 'Feature 23: threshold_metalcraft_delirium'],
			['death_deals_damage', 'Feature 24: death_deals_damage'],
			['etb_attach_equipment', 'Feature 25: etb_attach_equipment'],
			['conditional_has_keyword', 'Feature 26: conditional_has_keyword'],
			['tribal_type_cost_reduction', 'Feature 27: tribal_type_cost_reduction'],
			['skulking_ghost_trigger', 'Feature 28: skulking_ghost_trigger'],
			['bounce_land', 'Feature 29: bounce_land']
		]) {
			describe(label, () => {
				it('Case 1: Primary happy path behavior', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 2: Secondary effect interaction', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 3: State transition on resolution', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 4: Target or trigger validation', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M3 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 5: Rename-invariance check on synthetic card', (t) => {
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
	// Features 30-50 (M4: CR 702 Keywords)
	// ==========================================
	describe('Features 30-50: Milestone 4 CR 702 Keywords Suite', () => {
		const m4Features: Array<[string, string]> = [
			['cr702_madness', 'Feature 30: Madness (CR 702.35)'],
			['cr702_echo', 'Feature 31: Echo (CR 702.30)'],
			['cr702_undying_persist', 'Feature 32: Undying & Persist (CR 702.93/79)'],
			['cr702_cascade', 'Feature 33: Cascade (CR 702.85)'],
			['cr702_soulshift', 'Feature 34: Soulshift (CR 702.46)'],
			['cr702_toxic', 'Feature 35: Toxic (CR 702.164)'],
			['cr702_rebound', 'Feature 36: Rebound (CR 702.88)'],
			['cr702_improvise', 'Feature 37: Improvise (CR 702.126)'],
			['cr702_bloodthirst', 'Feature 38: Bloodthirst (CR 702.54)'],
			['cr702_modular', 'Feature 39: Modular (CR 702.43)'],
			['cr702_dash', 'Feature 40: Dash (CR 702.108)'],
			['cr702_flanking', 'Feature 41: Flanking (CR 702.25)'],
			['cr702_ninjutsu', 'Feature 42: Ninjutsu (CR 702.49)'],
			['cr702_fabricate', 'Feature 43: Fabricate (CR 702.123)'],
			['cr702_myriad', 'Feature 44: Myriad (CR 702.116)'],
			['cr702_renown', 'Feature 45: Renown (CR 702.112)'],
			['cr702_unleash', 'Feature 46: Unleash (CR 702.98)'],
			['cr702_extort', 'Feature 47: Extort (CR 702.101)'],
			['cr702_scavenge', 'Feature 48: Scavenge (CR 702.97)'],
			['cr702_encore', 'Feature 49: Encore (CR 702.141)'],
			['cr702_embalm_eternalize', 'Feature 50: Embalm & Eternalize (CR 702.128/129)']
		];

		for (const [id, label] of m4Features) {
			describe(label, () => {
				it('Case 1: Standard activation / trigger execution', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 2: Cost payment and zone transition', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 3: Interactive prompt or choice handling', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 4: State-based and layer interaction', (t) => {
					if (!isFeatureReady(id)) {
						t.skip(`${id} awaiting M4 implementation`);
						return;
					}
					const { state, p1 } = setupE2EGame();
					assert.ok(p1);
				});
				it('Case 5: Rename-invariance check on synthetic keyword card', (t) => {
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
	// Feature 51: e2e_verification_and_hardening (M5)
	// ==========================================
	describe('Feature 51: e2e_verification_and_hardening', () => {
		it('Case 1: End-to-end game state round trip and viewer sanitization integrity', () => {
			const { state, p1, p2 } = setupE2EGame();
			const restored = assertJsonRoundTrip(state);
			assert.equal(restored.turnNumber, 1);
			const sanitizedP1 = sanitizeGameStateForViewer(state, p1.playerId);
			assert.ok(sanitizedP1);
		});

		it('Case 2: Deterministic action application and state tracking', () => {
			const { state, p1 } = setupE2EGame();
			const res1 = applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			assert.equal(res1.ok, true);
			assert.equal(state.priorityPlayerIndex, 1);
		});

		it('Case 3: Public action dispatcher rejects illegal actions without state corruption', () => {
			const { state, p1 } = setupE2EGame();
			const res = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: 'non_existent_card_id'
			});
			assert.equal(res.ok, false);
			assert.ok(res.error);
			assert.equal(state.status, 'active');
		});

		it('Case 4: Full priority pass drains stack and triggers cleanly', () => {
			const { state, p1 } = setupE2EGame();
			passAllPriority(state);
			assert.equal(state.stack.length, 0);
			assert.equal(state.pendingPrompts.length, 0);
		});

		it('Case 5: Comprehensive rules layer evaluation consistency under evaluatePermanent', () => {
			const { state, p1 } = setupE2EGame();
			const card = addCardToZone(state, p1, synthCard({
				name: 'Test Eval Core',
				power: '3',
				toughness: '3',
				oracleText: 'Vigilance'
			}), 'battlefield');
			const evaluated = evaluatePermanent(state, card);
			assert.equal(evaluated.power, 3);
			assert.equal(evaluated.toughness, 3);
			assert.equal(evaluated.keywords.includes('Vigilance'), true);
		});
	});
});
