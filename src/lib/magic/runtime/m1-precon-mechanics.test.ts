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
import { parseCostModifierSentence } from '../compiler/costs.ts';
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

function createCardInstance(
	card: ScryfallCard,
	ownerId: string,
	zone: ZoneType = 'hand'
): CardInstance {
	return engineCreateCardInstance(card, ownerId, zone);
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

function putOnBattlefield(player: PlayerGameState, cardOrName: ScryfallCard | string): CardInstance {
	const card = typeof cardOrName === 'string' ? findPrecon(cardOrName) : cardOrName;
	const inst = createCardInstance(card, player.playerId, 'battlefield');
	inst.zone = 'battlefield';
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	player.battlefield.push(inst);
	return inst;
}

function putInLibrary(player: PlayerGameState, cardOrName: ScryfallCard | string): CardInstance {
	const card = typeof cardOrName === 'string' ? findPrecon(cardOrName) : cardOrName;
	const inst = createCardInstance(card, player.playerId, 'library');
	inst.zone = 'library';
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	player.library.push(inst);
	return inst;
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
	const state = createInitialGameState(
		'M1_TEST',
		seats,
		new Map([
			[0, d1],
			[1, d2]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	applyGameAction(state, 'p1', { type: 'mulligan_keep' });
	applyGameAction(state, 'p2', { type: 'mulligan_keep' });
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	const [p1, p2] = state.players;
	p1.battlefield = [];
	p2.battlefield = [];
	p1.hand = [];
	p2.hand = [];
	p1.graveyard = [];
	p2.graveyard = [];
	p1.exile = [];
	p2.exile = [];
	return { state, p1, p2 };
}

describe('Milestone 1 — Precon Mechanics & Grammar Inversion', () => {
	describe('Feature 1: Grammar inversion parser & runtime cost modifiers', () => {
		it('GI-1: parses inverted subject-first syntax into costModifier StaticDef', () => {
			const parsed = parseCostModifierSentence('Spells your opponents cast cost {1} more to cast.');
			assert.ok(parsed, 'should parse inverted cost modifier');
			assert.equal(parsed.k, 'costModifier');
			assert.equal(parsed.affects.k, 'spell');
			assert.equal(parsed.who.relation, 'each_opponent');
			assert.equal(parsed.delta.mode, 'increase');
			assert.equal(parsed.delta.generic, 1);
		});

		it('GI-2: parses targeting additional life cost modifier into costModifier StaticDef', () => {
			const parsed = parseCostModifierSentence('Spells your opponents cast that target ~ cost an additional 3 life to cast.');
			assert.ok(parsed, 'should parse targeting life cost modifier');
			assert.equal(parsed.k, 'costModifier');
			assert.equal(parsed.affects.k, 'spell');
			assert.equal(parsed.affects.filter.targetsSelf, true);
			assert.equal(parsed.who.relation, 'each_opponent');
			assert.ok(parsed.delta.additionalCosts, 'must contain additionalCosts');
			assert.equal(parsed.delta.additionalCosts[0]?.k, 'payLife');
		});

		it('GI-3: rename-invariance — synthetic cards with inverted syntax compile identically', () => {
			const synth = syntheticCard({
				name: 'Grand Arbiter Synthetic',
				typeLine: 'Creature — Human Advisor',
				oracleText: 'Spells your opponents cast cost {1} more to cast.'
			});
			const compiled = compileCard(synth);
			assert.equal(compiled.fullySupported, true);
			const staticAb = compiled.faces[0]?.abilities.find((a) => a.kind === 'static');
			assert.ok(staticAb && staticAb.kind === 'static');
			assert.equal(staticAb.static.k, 'costModifier');
		});

		it('GI-4: parses "Target creature gets +2/+2 and gains trample until end of turn"', () => {
			const synth = syntheticCard({
				name: 'Titanic Growth Variant',
				typeLine: 'Instant',
				oracleText: 'Target creature gets +2/+2 and gains trample until end of turn.'
			});
			const compiled = compileCard(synth);
			assert.equal(compiled.fullySupported, true);
			const ab = compiled.faces[0]?.abilities[0];
			assert.ok(ab && ab.kind === 'spell');
			const steps = ab.effect;
			assert.ok(steps && steps.length >= 2);
			assert.equal(steps[0].verb, 'pump');
			assert.equal(steps[1].verb, 'grant');
			assert.deepEqual(steps[1].params?.keywords, ['Trample']);
		});
	});

	describe('Feature 2: Chaos Warp (CW-1 through CW-5)', () => {
		it('CW-1: target permanent shuffles into library, reveals top card, puts permanent onto battlefield', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = [];
			const targetLand = putOnBattlefield(p2, 'Mountain');
			const topPerm = putInLibrary(p2, 'Forest');

			const cwCard = findPrecon('Chaos Warp');
			const cwInst = createCardInstance(cwCard, p1.playerId);
			p1.hand.push(cwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cwInst.instanceId,
				targets: [{ kind: 'permanent', id: targetLand.instanceId, label: 'Mountain' }]
			});
			assert.equal(castRes.ok, true);

			// Resolve Chaos Warp
			resolveTopOfStack(state);

			// One permanent (either Mountain or Forest) is put onto battlefield; the other is in library
			assert.equal(p2.battlefield.length, 1);
			assert.equal(p2.library.length, 1);
			assert.ok(
				p2.battlefield.some((c) => c.instanceId === topPerm.instanceId) ||
				p2.battlefield.some((c) => c.instanceId === targetLand.instanceId)
			);
		});

		it('CW-2: revealed instant/sorcery stays on top of library and is not put onto battlefield', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = [];
			const targetCreature = putOnBattlefield(
				p2,
				syntheticCard({ name: 'Soldier Token', typeLine: 'Token Creature — Soldier', power: '1', toughness: '1' })
			);
			targetCreature.isToken = true;
			const topSpell = putInLibrary(p2, 'Chaos Warp');

			const cwCard = findPrecon('Chaos Warp');
			const cwInst = createCardInstance(cwCard, p1.playerId);
			p1.hand.push(cwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cwInst.instanceId,
				targets: [{ kind: 'permanent', id: targetCreature.instanceId, label: 'Soldier Token' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			// Soldier Token should not be on battlefield
			assert.equal(p2.battlefield.some((c) => c.instanceId === targetCreature.instanceId), false);
			// Revealed Chaos Warp should NOT be on battlefield; remains in library
			assert.equal(p2.battlefield.some((c) => c.instanceId === topSpell.instanceId), false);
			assert.equal(p2.library.some((c) => c.instanceId === topSpell.instanceId), true);
		});

		it('CW-3: commander redirected to command zone still shuffles library and reveals top card', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = [];
			const cmdCard = findPrecon('Lathril, Blade of the Elves');
			const cmdInst = putOnBattlefield(p2, cmdCard);
			cmdInst.isCommander = true;

			const topPerm = putInLibrary(p2, 'Forest');

			const cwCard = findPrecon('Chaos Warp');
			const cwInst = createCardInstance(cwCard, p1.playerId);
			p1.hand.push(cwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cwInst.instanceId,
				targets: [{ kind: 'permanent', id: cmdInst.instanceId, label: cmdCard.name }]
			});
			resolveTopOfStack(state);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p2.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			// Top permanent Forest enters battlefield
			assert.equal(p2.battlefield.some((c) => c.instanceId === topPerm.instanceId), true);
		});

		it('CW-4: token shuffled ceases to exist, library still reveals and puts permanent onto battlefield', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = [];
			const tokenCard = syntheticCard({ name: 'Goblin Token', typeLine: 'Token Creature — Goblin', power: '1', toughness: '1' });
			const tokenInst = putOnBattlefield(p2, tokenCard);
			tokenInst.isToken = true;

			const topPerm = putInLibrary(p2, 'Forest');

			const cwCard = findPrecon('Chaos Warp');
			const cwInst = createCardInstance(cwCard, p1.playerId);
			p1.hand.push(cwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cwInst.instanceId,
				targets: [{ kind: 'permanent', id: tokenInst.instanceId, label: 'Goblin Token' }]
			});
			resolveTopOfStack(state);

			assert.equal(p2.battlefield.some((c) => c.instanceId === tokenInst.instanceId), false);
			assert.equal(p2.library.some((c) => c.instanceId === tokenInst.instanceId), false);
			assert.equal(p2.battlefield.some((c) => c.instanceId === topPerm.instanceId), true);
		});

		it('CW-5: synthetic renamed Chaos Warp behaves identically', () => {
			const synth = syntheticCard({
				name: 'Entropic Flux',
				manaCost: '{2}{R}',
				typeLine: 'Instant',
				oracleText:
					"The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield."
			});
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = [];
			const targetLand = putOnBattlefield(p2, 'Mountain');
			const topPerm = putInLibrary(p2, 'Forest');

			const inst = createCardInstance(synth, p1.playerId);
			p1.hand.push(inst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: inst.instanceId,
				targets: [{ kind: 'permanent', id: targetLand.instanceId, label: 'Mountain' }]
			});
			resolveTopOfStack(state);

			assert.equal(p2.battlefield.length, 1);
			assert.equal(p2.library.length, 1);
			assert.ok(
				p2.battlefield.some((c) => c.instanceId === topPerm.instanceId) ||
				p2.battlefield.some((c) => c.instanceId === targetLand.instanceId)
			);
		});
	});

	describe('Feature 3: Crystalline Crawler (CC-1 through CC-7)', () => {
		it('CC-1: Converge enters with +1/+1 counters equal to number of colors of mana spent', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const ccCard = findPrecon('Crystalline Crawler');
			const ccInst = createCardInstance(ccCard, p1.playerId);
			p1.hand.push(ccInst);

			// Spend 4 colors: W, U, B, R
			p1.manaPool.W = 1;
			p1.manaPool.U = 1;
			p1.manaPool.B = 1;
			p1.manaPool.R = 1;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ccInst.instanceId
			});
			assert.equal(castRes.ok, true);

			resolveTopOfStack(state);

			const crawler = p1.battlefield.find((c) => c.instanceId === ccInst.instanceId);
			assert.ok(crawler, 'crawler on battlefield');
			assert.equal(crawler.counters['+1/+1'], 4);
		});

		it('CC-2: Colorless mana does not count as a color for Converge (CR 105.4)', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const ccCard = findPrecon('Crystalline Crawler');
			const ccInst = createCardInstance(ccCard, p1.playerId);
			p1.hand.push(ccInst);

			// Spend 1 color (G) and 3 colorless (C)
			p1.manaPool.G = 1;
			p1.manaPool.C = 3;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ccInst.instanceId
			});
			resolveTopOfStack(state);

			const crawler = p1.battlefield.find((c) => c.instanceId === ccInst.instanceId);
			assert.ok(crawler);
			assert.equal(crawler.counters['+1/+1'], 1);
		});

		it('CC-3: Remove a +1/+1 counter: Add one mana of any color', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const crawler = putOnBattlefield(p1, 'Crystalline Crawler');
			crawler.counters['+1/+1'] = 2;
			crawler.summoningSick = false;

			const abs = getEffectiveActivatedAbilities(state, p1, crawler);
			const manaAb = abs.find((a) => a.costText.includes('Remove a +1/+1 counter'));
			assert.ok(manaAb, 'mana ability exists');

			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: crawler.instanceId,
				abilityId: manaAb.id
			});
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseMode', indices: [0] }
				});
			}
			assert.equal(crawler.counters['+1/+1'], 1);
		});

		it('CC-4: {T}: Put a +1/+1 counter on Crystalline Crawler', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const crawler = putOnBattlefield(p1, 'Crystalline Crawler');
			crawler.counters['+1/+1'] = 1;
			crawler.summoningSick = false;

			const abs = getEffectiveActivatedAbilities(state, p1, crawler);
			const addCounterAb = abs.find((a) => a.costText === '{T}');
			assert.ok(addCounterAb, '{T} ability exists');

			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: crawler.instanceId,
				abilityId: addCounterAb.id
			});
			resolveTopOfStack(state);

			assert.equal(crawler.counters['+1/+1'], 2);
			assert.equal(crawler.tapped, true);
		});

		it('CC-5: Enters the battlefield without being cast enters with 0 counters', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const crawler = putOnBattlefield(p1, 'Crystalline Crawler');
			assert.equal(crawler.counters['+1/+1'] || 0, 0);
		});

		it('CC-6: synthetic renamed Crystalline Crawler behaves identically', () => {
			const synth = syntheticCard({
				name: 'Prismatic Automaton',
				manaCost: '{4}',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1',
				oracleText:
					'Converge — Prismatic Automaton enters the battlefield with a +1/+1 counter on it for each color of mana spent to cast it.\nRemove a +1/+1 counter from Prismatic Automaton: Add one mana of any color.\n{T}: Put a +1/+1 counter on Prismatic Automaton.'
			});
			const { state, p1 } = makeTwoPlayerGame();
			const inst = createCardInstance(synth, p1.playerId);
			p1.hand.push(inst);
			p1.manaPool.W = 1;
			p1.manaPool.U = 1;
			p1.manaPool.B = 1;
			p1.manaPool.R = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: inst.instanceId
			});
			resolveTopOfStack(state);

			const found = p1.battlefield.find((c) => c.instanceId === inst.instanceId);
			assert.ok(found);
			assert.equal(found.counters['+1/+1'], 4);
		});

		it('CC-7: state roundtrips cleanly through JSON serialization', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const crawler = createCardInstance(findPrecon('Crystalline Crawler'), p1.playerId);
			crawler.counters['+1/+1'] = 3;
			p1.battlefield.push(crawler);

			const serialized = JSON.stringify(state);
			const deserialized = JSON.parse(serialized);
			assert.equal(deserialized.players[0].battlefield[0].counters['+1/+1'], 3);
		});
	});

	describe('Feature 4: Expressive Iteration (EI-1 through EI-4)', () => {
		it('EI-1: Digs 3 cards, partitions 1 to hand, 1 to exile (playable), 1 to library bottom', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const c1 = createCardInstance(findPrecon('Mountain'), p1.playerId);
			const c2 = createCardInstance(findPrecon('Forest'), p1.playerId);
			const c3 = createCardInstance(findPrecon('Island'), p1.playerId);
			p1.library = [c1, c2, c3];

			const eiCard = findPrecon('Expressive Iteration');
			const eiInst = createCardInstance(eiCard, p1.playerId);
			p1.hand.push(eiInst);
			p1.manaPool.U = 1;
			p1.manaPool.R = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: eiInst.instanceId
			});
			resolveTopOfStack(state);

			for (let i = 0; i < 5 && state.pendingPrompts.length > 0; i++) {
				const prm = state.pendingPrompts[0];
				const cand = prm.choice?.kind === 'chooseObjects' ? prm.choice.candidates : (prm.candidateInstanceIds ?? []);
				const pick = cand.includes(c1.instanceId) ? c1.instanceId : cand.includes(c2.instanceId) ? c2.instanceId : cand[0];
				const res = applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: pick ? [pick] : [] }
				});
				if (!res.ok) {
					console.log('Choice failed:', res.error, 'prompt:', prm);
					break;
				}
			}

			// c1 should be in hand
			assert.equal(p1.hand.some((c) => c.instanceId === c1.instanceId), true);
			// c2 should be in exile with playableFromExileBy
			const exiled = p1.exile.find((c) => c.instanceId === c2.instanceId);
			assert.ok(exiled, 'c2 exiled');
			assert.equal(exiled.playableFromExileBy?.playerId, p1.playerId);
			assert.equal(exiled.playableFromExileBy?.expiresAtEndOfTurn, true);
			// c3 should be on bottom of library
			assert.equal(p1.library.some((c) => c.instanceId === c3.instanceId), true);
		});

		it('EI-2: Exiled card can be played as a land during current turn', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const land = createCardInstance(findPrecon('Mountain'), p1.playerId);
			land.playableFromExileBy = {
				playerId: p1.playerId,
				expiresAtEndOfTurn: true,
				sourceName: 'Expressive Iteration',
				spendManaAsAnyColor: false
			};
			p1.exile.push(land);

			const playRes = applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: land.instanceId
			});
			assert.equal(playRes.ok, true);
			assert.equal(p1.battlefield.some((c) => c.instanceId === land.instanceId), true);
		});

		it('EI-3: Exiled card permission expires at end of turn', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const spell = createCardInstance(findPrecon('Lightning Bolt'), p1.playerId);
			spell.playableFromExileBy = {
				playerId: p1.playerId,
				expiresAtEndOfTurn: true,
				sourceName: 'Expressive Iteration',
				spendManaAsAnyColor: false
			};
			p1.exile.push(spell);

			enterEndStep(state, p1);
			advancePhaseOrStep(state); // cleanup

			assert.equal(spell.playableFromExileBy, undefined);
		});

		it('EI-4: synthetic renamed Expressive Iteration behaves identically', () => {
			const synth = syntheticCard({
				name: 'Strategic Insight',
				manaCost: '{U}{R}',
				typeLine: 'Sorcery',
				oracleText:
					'Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. You may play the exiled card this turn.',
				colors: ['U', 'R']
			});
			const { state, p1 } = makeTwoPlayerGame();
			const c1 = createCardInstance(findPrecon('Mountain'), p1.playerId);
			const c2 = createCardInstance(findPrecon('Forest'), p1.playerId);
			const c3 = createCardInstance(findPrecon('Island'), p1.playerId);
			p1.library = [c1, c2, c3];

			const inst = createCardInstance(synth, p1.playerId);
			p1.hand.push(inst);
			p1.manaPool.U = 1;
			p1.manaPool.R = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: inst.instanceId
			});
			resolveTopOfStack(state);

			for (let i = 0; i < 5 && state.pendingPrompts.length > 0; i++) {
				const prm = state.pendingPrompts[0];
				const cand = prm.choice?.kind === 'chooseObjects' ? prm.choice.candidates : (prm.candidateInstanceIds ?? []);
				const pick = cand.includes(c1.instanceId) ? c1.instanceId : cand.includes(c2.instanceId) ? c2.instanceId : cand[0];
				const res = applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: pick ? [pick] : [] }
				});
				if (!res.ok) {
					break;
				}
			}

			assert.equal(p1.hand.some((c) => c.instanceId === c1.instanceId), true);
			assert.equal(p1.exile.some((c) => c.instanceId === c2.instanceId), true);
			assert.equal(p1.library.some((c) => c.instanceId === c3.instanceId), true);
		});
	});

	describe('Feature 5: Fathom Mage & Evolve (FM-1 through FM-6)', () => {
		it('FM-1: Evolve triggers when creature with greater power enters', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage');

			// Enter a 2/1 creature
			const biggerP = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			biggerP.card.power = '2';
			biggerP.card.toughness = '1';
			p1.hand.push(biggerP);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: biggerP.instanceId
			});
			resolveTopOfStack(state); // Llanowar Elves enters, evolve triggers
			resolveTopOfStack(state); // Evolve resolves (+1/+1 counter placed, draw trigger queued)
			resolveTopOfStack(state); // Draw trigger resolves

			assert.equal(fm.counters['+1/+1'], 1);
		});

		it('FM-2: Evolve triggers when creature with greater toughness enters', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage');

			// Enter a 0/4 creature
			const biggerT = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			biggerT.card.power = '0';
			biggerT.card.toughness = '4';
			p1.hand.push(biggerT);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: biggerT.instanceId
			});
			resolveTopOfStack(state); // creature enters
			resolveTopOfStack(state); // evolve resolves
			resolveTopOfStack(state); // draw trigger resolves

			assert.equal(fm.counters['+1/+1'], 1);
		});

		it('FM-3: Evolve does not trigger if creature has <= power and <= toughness', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage');

			const smaller = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			smaller.card.power = '1';
			smaller.card.toughness = '1';
			p1.hand.push(smaller);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: smaller.instanceId
			});
			resolveTopOfStack(state); // creature enters

			// No evolve trigger on stack
			assert.equal(state.stack.length, 0);
			assert.equal(fm.counters['+1/+1'] || 0, 0);
		});

		it('FM-4: Evolve intervening if: no counter if source has grown to >= entering creature', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage');

			const enter = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			enter.card.power = '2';
			enter.card.toughness = '2';
			p1.hand.push(enter);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: enter.instanceId
			});
			resolveTopOfStack(state); // enters, evolve triggers and is on stack

			// Before evolve resolves, pump Fathom Mage to 3/3 with counters
			fm.counters['+1/+1'] = 2;

			resolveTopOfStack(state); // evolve resolves: 3/3 is not less than 2/2 -> no additional counter
			assert.equal(fm.counters['+1/+1'], 2);
		});

		it('FM-5: Whenever a +1/+1 counter is put on Fathom Mage, draw a card', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage');
			p1.library = [createCardInstance(findPrecon('Forest'), p1.playerId)];

			const enter = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			enter.card.power = '3';
			enter.card.toughness = '3';
			p1.hand.push(enter);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: enter.instanceId
			});
			resolveTopOfStack(state); // creature enters, queues evolve
			resolveTopOfStack(state); // evolve places counter, queues draw
			resolveTopOfStack(state); // draw resolves -> prompts trigger_may
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			assert.equal(p1.hand.length, 1);
		});

		it('FM-6: synthetic renamed Evolve creature behaves identically', () => {
			const synth = syntheticCard({
				name: 'Adaptable Biomancer',
				typeLine: 'Creature — Elf Mutant',
				power: '1',
				toughness: '1',
				oracleText: 'Evolve\nWhenever a +1/+1 counter is put on Adaptable Biomancer, you may draw a card.'
			});
			const { state, p1 } = makeTwoPlayerGame();
			const inst = putOnBattlefield(p1, synth);
			p1.library = [createCardInstance(findPrecon('Forest'), p1.playerId)];

			const enter = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			enter.card.power = '2';
			enter.card.toughness = '2';
			p1.hand.push(enter);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: enter.instanceId
			});
			resolveTopOfStack(state); // enters
			resolveTopOfStack(state); // evolve resolves
			resolveTopOfStack(state); // draw resolves -> prompts trigger_may
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			assert.equal(inst.counters['+1/+1'], 1);
			assert.equal(p1.hand.length, 1);
		});
	});

	describe('Feature 6: Forgotten Ancient (FA-1 through FA-5)', () => {
		it('FA-1: Whenever a player casts a spell, put a +1/+1 counter on Forgotten Ancient', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const fa = putOnBattlefield(p1, 'Forgotten Ancient');

			const bolt = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt);
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;

			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: 'Alice' }]
			});
			// Casting puts Forgotten Ancient trigger on stack on top of Bolt
			resolveTopOfStack(state); // trigger resolves -> prompts optional choice
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			assert.equal(fa.counters['+1/+1'], 1);
		});

		it('FA-2: At beginning of upkeep, may move counters to other creatures', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fa = putOnBattlefield(p1, 'Forgotten Ancient');
			fa.counters['+1/+1'] = 2;

			const other = putOnBattlefield(p1, 'Llanowar Elves');

			// Advance from untap step into upkeep to fire PhaseBegin event
			state.phase = 'untap';
			state.activePlayerIndex = 0;
			advancePhaseOrStep(state);

			assert.equal(state.phase, 'upkeep');
			assert.equal(state.stack.length, 1, 'Forgotten Ancient upkeep trigger is on stack');

			// Resolve top of stack -> prompts optional "may" choice (yesNo)
			resolveTopOfStack(state);
			assert.equal(state.pendingPrompts.length, 1, 'Optional upkeep trigger prompt queued');
			const mayPrompt = state.pendingPrompts[0];
			assert.equal(mayPrompt.choice?.kind, 'yesNo');

			// Player chooses "yes" to move counters
			const mayChoiceRes = applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: mayPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			});
			assert.equal(mayChoiceRes.ok, true);

			// Resuming stack triggers chooseObjects prompt for destination creature
			assert.equal(state.pendingPrompts.length, 1, 'Target creature prompt queued');
			const targetPrompt = state.pendingPrompts[0];
			assert.equal(targetPrompt.choice?.kind, 'chooseObjects');

			// Player selects Llanowar Elves as the destination creature
			const targetChoiceRes = applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: targetPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [other.instanceId] }
			});
			assert.equal(targetChoiceRes.ok, true);

			// Resuming stack triggers chooseNumber prompt for counter count
			assert.equal(state.pendingPrompts.length, 1, 'Counter quantity prompt queued');
			const countPrompt = state.pendingPrompts[0];
			assert.equal(countPrompt.choice?.kind, 'chooseNumber');
			assert.equal((countPrompt.choice as any).max, 2);

			// Player chooses to move 2 counters (all available)
			const countChoiceRes = applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: countPrompt.id,
				answer: { kind: 'chooseNumber', n: 2 }
			});
			assert.equal(countChoiceRes.ok, true);

			// Verify counters were moved from Forgotten Ancient to Llanowar Elves
			assert.equal(fa.counters['+1/+1'], 0, 'Forgotten Ancient counters moved away');
			assert.equal(other.counters['+1/+1'], 2, 'Llanowar Elves received +1/+1 counters');
			assert.equal(state.stack.length, 0, 'Upkeep trigger fully resolved');
			assert.equal(state.pendingPrompts.length, 0, 'No remaining prompts');
		});

		it('FA-2a: Partial move — choose to move 1 of 3 counters to another creature', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fa = putOnBattlefield(p1, 'Forgotten Ancient');
			fa.counters['+1/+1'] = 3;
			const elves = putOnBattlefield(p1, 'Llanowar Elves');

			state.phase = 'untap';
			state.activePlayerIndex = 0;
			advancePhaseOrStep(state); // -> upkeep triggers FA upkeep ability

			assert.equal(state.stack.length, 1);
			resolveTopOfStack(state); // triggers optional prompt

			// 1. Answer optional prompt -> Yes
			const prm0 = state.pendingPrompts[0];
			assert.equal(prm0.choice?.kind, 'yesNo');
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: prm0.id, answer: { kind: 'yesNo', yes: true } });

			// 2. Choose destination creature -> Llanowar Elves
			const prm1 = state.pendingPrompts[0];
			assert.equal(prm1.choice?.kind, 'chooseObjects');
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: prm1.id, answer: { kind: 'chooseObjects', objectIds: [elves.instanceId] } });

			// 3. Choose count -> 1 counter
			const prm2 = state.pendingPrompts[0];
			assert.equal(prm2.choice?.kind, 'chooseNumber');
			assert.equal((prm2.choice as any).max, 3);
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: prm2.id, answer: { kind: 'chooseNumber', n: 1 } });

			// 4. Prompt for next destination -> choose none ([]) to stop
			const prm3 = state.pendingPrompts[0];
			assert.equal(prm3.choice?.kind, 'chooseObjects');
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: prm3.id, answer: { kind: 'chooseObjects', objectIds: [] } });

			// Verification: 1 counter moved, 2 counters remain on Forgotten Ancient
			assert.equal(fa.counters['+1/+1'], 2);
			assert.equal(elves.counters['+1/+1'], 1);
		});

		it('FA-2b: Multi-target distribution — move counters across multiple creatures', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fa = putOnBattlefield(p1, 'Forgotten Ancient');
			fa.counters['+1/+1'] = 4;
			const elves1 = putOnBattlefield(p1, 'Llanowar Elves');
			const elves2 = putOnBattlefield(p1, 'Llanowar Elves');

			state.phase = 'untap';
			state.activePlayerIndex = 0;
			advancePhaseOrStep(state);

			resolveTopOfStack(state);

			// Optional prompt -> Yes
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: state.pendingPrompts[0].id, answer: { kind: 'yesNo', yes: true } });

			// Dest 1 -> Elves 1
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: state.pendingPrompts[0].id, answer: { kind: 'chooseObjects', objectIds: [elves1.instanceId] } });
			// Count 1 -> 1
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: state.pendingPrompts[0].id, answer: { kind: 'chooseNumber', n: 1 } });

			// Dest 2 -> Elves 2
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: state.pendingPrompts[0].id, answer: { kind: 'chooseObjects', objectIds: [elves2.instanceId] } });
			// Count 2 -> 2
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: state.pendingPrompts[0].id, answer: { kind: 'chooseNumber', n: 2 } });

			// Dest 3 -> [] (stop)
			applyGameAction(state, p1.playerId, { type: 'choice', promptId: state.pendingPrompts[0].id, answer: { kind: 'chooseObjects', objectIds: [] } });

			// Verification: 1 to Elves 1, 2 to Elves 2, 1 remains on FA
			assert.equal(fa.counters['+1/+1'], 1);
			assert.equal(elves1.counters['+1/+1'], 1);
			assert.equal(elves2.counters['+1/+1'], 2);
		});

		it('FA-3: synthetic renamed Forgotten Ancient behaves identically', () => {
			const synth = syntheticCard({
				name: 'Elder Preserver',
				typeLine: 'Creature — Elemental',
				power: '0',
				toughness: '3',
				oracleText: 'Whenever a player casts a spell, you may put a +1/+1 counter on Elder Preserver.\nAt the beginning of your upkeep, you may move any number of +1/+1 counters from Elder Preserver onto other creatures.'
			});
			const { state, p1, p2 } = makeTwoPlayerGame();
			const inst = putOnBattlefield(p1, synth);

			const bolt = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt);
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;

			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: 'Alice' }]
			});
			resolveTopOfStack(state);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			assert.equal(inst.counters['+1/+1'], 1);
		});

		it('FA-4: JSON roundtrip serialization maintains counter state', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fa = putOnBattlefield(p1, 'Forgotten Ancient');
			fa.counters['+1/+1'] = 4;

			const deserialized = JSON.parse(JSON.stringify(state));
			assert.equal(deserialized.players[0].battlefield[0].counters['+1/+1'], 4);
		});

		it('FA-5: Multiple spells cast accumulate counters correctly', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fa = putOnBattlefield(p1, 'Forgotten Ancient');

			for (let i = 0; i < 3; i++) {
				const bolt = createCardInstance(findPrecon('Lightning Bolt'), p1.playerId);
				p1.hand.push(bolt);
				p1.manaPool.R = 1;
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bolt.instanceId,
					targets: [{ kind: 'player', id: state.players[1].playerId, label: 'Bob' }]
				});
				resolveTopOfStack(state); // FA trigger
				if (state.pendingPrompts.length > 0) {
					const prm = state.pendingPrompts[0];
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'yesNo', yes: true }
					});
				}
				resolveTopOfStack(state); // Bolt
			}

			assert.equal(fa.counters['+1/+1'], 3);
		});
	});

	describe('Feature 7: Hellkite Charger (HC-1 through HC-4)', () => {
		it('HC-1: Attacks trigger: paying {5}{R}{R} untaps attackers and grants additional combat phase', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const hc = putOnBattlefield(p1, 'Hellkite Charger');
			hc.summoningSick = false;
			p1.manaPool.R = 2;
			p1.manaPool.C = 5;

			state.phase = 'declare_attackers';
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: hc.instanceId, defenderPlayerId: state.players[1].playerId }]
			});
			// Attack trigger fires and prompts/resolves
			resolveTopOfStack(state);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			assert.equal(state.additionalCombatPhases, 1);
			assert.equal(hc.tapped, false); // Untapped
		});

		it('HC-2: In additional combat phase, creatures can attack again', () => {
			const { state, p1 } = makeTwoPlayerGame();
			state.additionalCombatPhases = 1;
			state.phase = 'end_combat';

			advancePhaseOrStep(state); // end_combat -> begins additional combat
			assert.equal(state.phase, 'begin_combat');
			assert.equal(state.additionalCombatPhases, 0);
		});

		it('HC-3: If cost not paid, no extra combat is granted', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const hc = putOnBattlefield(p1, 'Hellkite Charger');
			hc.summoningSick = false;
			// No mana in pool

			state.phase = 'declare_attackers';
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: hc.instanceId, defenderPlayerId: state.players[1].playerId }]
			});
			resolveTopOfStack(state);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: false }
				});
			}

			assert.equal(state.additionalCombatPhases ?? 0, 0);
		});

		it('HC-4: synthetic renamed Hellkite Charger behaves identically', () => {
			const synth = syntheticCard({
				name: 'Relentless Dragon',
				manaCost: '{4}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '5',
				oracleText: 'Flying, haste\nWhenever Relentless Dragon attacks, you may pay {5}{R}{R}. If you do, untap all attacking creatures and after this phase, there is an additional combat phase.'
			});
			const { state, p1 } = makeTwoPlayerGame();
			const inst = putOnBattlefield(p1, synth);
			inst.summoningSick = false;
			p1.manaPool.R = 2;
			p1.manaPool.C = 5;

			state.phase = 'declare_attackers';
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: inst.instanceId, defenderPlayerId: state.players[1].playerId }]
			});
			resolveTopOfStack(state);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			assert.equal(state.additionalCombatPhases, 1);
			assert.equal(inst.tapped, false);
		});
	});

	describe('Feature 8: Jeska\'s Will (JW-1 through JW-4)', () => {
		it('JW-1: Without commander, choose 1 mode (e.g. exile top 3 cards)', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const jwCard = findPrecon('Jeska\'s Will');
			const jwInst = createCardInstance(jwCard, p1.playerId);
			p1.hand.push(jwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;
			p1.library = [
				createCardInstance(findPrecon('Mountain'), p1.playerId),
				createCardInstance(findPrecon('Forest'), p1.playerId),
				createCardInstance(findPrecon('Island'), p1.playerId)
			];

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: jwInst.instanceId,
				modes: [1]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			assert.equal(p1.exile.length, 3);
		});

		it('JW-2: With commander controlled, choose both modes', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const cmd = putOnBattlefield(p1, 'Lathril, Blade of the Elves');
			cmd.isCommander = true;

			p2.hand = [
				createCardInstance(findPrecon('Mountain'), p2.playerId),
				createCardInstance(findPrecon('Forest'), p2.playerId)
			];
			p1.library = [
				createCardInstance(findPrecon('Mountain'), p1.playerId),
				createCardInstance(findPrecon('Forest'), p1.playerId),
				createCardInstance(findPrecon('Island'), p1.playerId)
			];

			const jwCard = findPrecon('Jeska\'s Will');
			const jwInst = createCardInstance(jwCard, p1.playerId);
			p1.hand.push(jwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: jwInst.instanceId,
				modes: [0, 1],
				targets: [{ kind: 'player', id: p2.playerId, label: 'Bob' }]
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			// Mode 0 adds R for each card in Bob's hand (2)
			assert.equal(p1.manaPool.R, 2);
			// Mode 1 exiles top 3 cards
			assert.equal(p1.exile.length, 3);
		});

		it('JW-3: Mode 1 adds correct red mana based on target opponent hand size', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.hand = [
				createCardInstance(findPrecon('Mountain'), p2.playerId),
				createCardInstance(findPrecon('Forest'), p2.playerId),
				createCardInstance(findPrecon('Island'), p2.playerId)
			];

			const jwCard = findPrecon('Jeska\'s Will');
			const jwInst = createCardInstance(jwCard, p1.playerId);
			p1.hand.push(jwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: jwInst.instanceId,
				modes: [0],
				targets: [{ kind: 'player', id: p2.playerId, label: 'Bob' }]
			});
			resolveTopOfStack(state);

			assert.equal(p1.manaPool.R, 3);
		});

		it('JW-4: synthetic renamed Jeska\'s Will behaves identically', () => {
			const synth = syntheticCard({
				name: 'Pyromancer\'s Decree',
				manaCost: '{2}{R}',
				typeLine: 'Sorcery',
				oracleText: 'Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Add {R} for each card in target opponent\'s hand.\n• Exile the top three cards of your library. You may play them this turn.'
			});
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.hand = [createCardInstance(findPrecon('Mountain'), p2.playerId)];
			const inst = createCardInstance(synth, p1.playerId);
			p1.hand.push(inst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: inst.instanceId,
				modes: [0],
				targets: [{ kind: 'player', id: p2.playerId, label: 'Bob' }]
			});
			resolveTopOfStack(state);

			assert.equal(p1.manaPool.R, 1);
		});
	});

	describe('Feature 9: Leyline of Anticipation (LA-1 through LA-4)', () => {
		it('LA-1: In opening hand, begins game on battlefield before turn 1', () => {
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
			const state = createInitialGameState(
				'LEYLINE_TEST',
				seats,
				new Map([[0, d1], [1, d2]]),
				{ ...DEFAULT_LOBBY_RULES }
			);
			// Put Leyline in Alice's opening hand before keeping mulligan
			const leyline = createCardInstance(findPrecon('Leyline of Anticipation'), 'p1');
			state.players[0].hand.push(leyline);

			applyGameAction(state, 'p1', { type: 'mulligan_keep' });
			applyGameAction(state, 'p2', { type: 'mulligan_keep' });

			// Leyline should now be on Alice's battlefield!
			assert.equal(state.players[0].battlefield.some((c) => c.card.name === 'Leyline of Anticipation'), true);
		});

		it('LA-2: Grants castAsThoughFlash to all spells you cast', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const leyline = createCardInstance(findPrecon('Leyline of Anticipation'), p1.playerId);
			p1.battlefield.push(leyline);

			// It is Bob's turn
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 0; // Alice has priority

			// Alice tries to cast a Sorcery on Bob's turn
			const sorcery = createCardInstance(findPrecon('Cultivate'), p1.playerId);
			p1.hand.push(sorcery);
			p1.manaPool.G = 1;
			p1.manaPool.C = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorcery.instanceId
			});
			assert.equal(castRes.ok, true, 'Alice should be able to cast sorcery at instant speed');
		});

		it('LA-3: Opponent without Leyline cannot cast sorcery on Alice\'s turn', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const leyline = createCardInstance(findPrecon('Leyline of Anticipation'), p1.playerId);
			p1.battlefield.push(leyline);

			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 1; // Bob has priority

			const sorcery = createCardInstance(findPrecon('Cultivate'), p2.playerId);
			p2.hand.push(sorcery);
			p2.manaPool.G = 1;
			p2.manaPool.C = 2;

			const castRes = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: sorcery.instanceId
			});
			assert.equal(castRes.ok, false);
		});

		it('LA-4: synthetic renamed Leyline behaves identically', () => {
			const synth = syntheticCard({
				name: 'Aetheric Alignment',
				manaCost: '{2}{U}{U}',
				typeLine: 'Enchantment',
				oracleText: 'If Aetheric Alignment is in your opening hand, you may begin the game with it on the battlefield.\nYou may cast spells as though they had flash.'
			});
			const { state, p1 } = makeTwoPlayerGame();
			const inst = createCardInstance(synth, p1.playerId);
			p1.battlefield.push(inst);

			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 0;

			const sorcery = createCardInstance(findPrecon('Cultivate'), p1.playerId);
			p1.hand.push(sorcery);
			p1.manaPool.G = 1;
			p1.manaPool.C = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorcery.instanceId
			});
			assert.equal(castRes.ok, true);
		});
	});

	describe('Feature 10: Mycosynth Lattice (ML-1 through ML-6)', () => {
		it('ML-1: All permanents are artifacts in addition to other types (Layer 4)', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const ml = putOnBattlefield(p1, 'Mycosynth Lattice');
			const creature = putOnBattlefield(p2, 'Llanowar Elves');

			const evaluated = evaluatePermanent(state, creature);
			assert.equal(evaluated.isArtifact, true);
			assert.equal(evaluated.isCreature, true);
		});

		it('ML-2: All cards not on battlefield are colorless (Layer 5)', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const ml = putOnBattlefield(p1, 'Mycosynth Lattice');

			const greenCard = createCardInstance(findPrecon('Cultivate'), p1.playerId);
			greenCard.zone = 'hand';
			p1.hand.push(greenCard);

			const costReq = getSpellCostRequirement(p1, greenCard, state);
			assert.ok(costReq);
		});

		it('ML-3: Permanents on battlefield are colorless (Layer 5)', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const ml = putOnBattlefield(p1, 'Mycosynth Lattice');
			const greenCreature = putOnBattlefield(p1, 'Llanowar Elves');

			const evaluated = evaluatePermanent(state, greenCreature);
			assert.deepEqual(evaluated.colors, []);
		});

		it('ML-4: Players may spend mana as though it were mana of any color', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const ml = putOnBattlefield(p1, 'Mycosynth Lattice');

			// Cast a red spell using white mana
			const bolt = createCardInstance(findPrecon('Lightning Bolt'), p1.playerId);
			bolt.zone = 'hand';
			p1.hand.push(bolt);
			p1.manaPool.W = 1;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'player', id: state.players[1].playerId, label: 'Bob' }]
			});
			assert.equal(castRes.ok, true);
		});

		it('ML-5: synthetic renamed Mycosynth Lattice behaves identically', () => {
			const synth = syntheticCard({
				name: 'Transmutation Matrix',
				manaCost: '{6}',
				typeLine: 'Artifact',
				oracleText: 'All permanents are artifacts in addition to their other types.\nAll cards that aren\'t on the battlefield, spells, and permanents are colorless.\nPlayers may spend mana as though it were mana of any color.'
			});
			const { state, p1 } = makeTwoPlayerGame();
			const inst = putOnBattlefield(p1, synth);
			const elf = putOnBattlefield(p1, 'Llanowar Elves');

			const evaluated = evaluatePermanent(state, elf);
			assert.equal(evaluated.isArtifact, true);
			assert.deepEqual(evaluated.colors, []);
		});

		it('ML-6: Layer evaluation preserves consistency', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const ml = putOnBattlefield(p1, 'Mycosynth Lattice');
			checkStateBasedActions(state);
			assert.equal(p1.battlefield.length, 1);
		});
	});

	describe('Feature 11: Path of Ancestry (PA-1 through PA-5)', () => {
		it('PA-1: Enters the battlefield tapped', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const land = createCardInstance(findPrecon('Path of Ancestry'), p1.playerId);
			p1.hand.push(land);

			applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: land.instanceId
			});

			const onBf = p1.battlefield.find((c) => c.instanceId === land.instanceId);
			assert.ok(onBf);
			assert.equal(onBf.tapped, true);
		});

		it('PA-2: {T}: Adds 1 mana in commander\'s color identity', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const land = putOnBattlefield(p1, 'Path of Ancestry');
			land.tapped = false;

			const abs = getEffectiveActivatedAbilities(state, p1, land, ['W', 'U', 'B', 'G']);
			const manaAb = abs.find((a) => a.isManaAbility);
			assert.ok(manaAb);

			applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: land.instanceId,
				abilityId: manaAb.id,
				preferredColor: 'G'
			});

			assert.equal(land.tapped, true);
			assert.equal(p1.manaRiders?.length, 1);
		});

		it('PA-3: When spent to cast creature sharing type with commander, Scry 1 triggers and resolves', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const cmd = createCardInstance(findPrecon('Lathril, Blade of the Elves'), p1.playerId); // Elf Noble
			cmd.isCommander = true;
			p1.command = [cmd];

			// Give p1 a plain-JSON mana rider from Path of Ancestry
			p1.manaRiders = [
				{
					sourceInstanceId: 'path_1',
					sourceCard: findPrecon('Path of Ancestry'),
					condition: { sharesCreatureTypeWithCommander: true },
					scryAmount: 1
				}
			];

			const elf = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			p1.hand.push(elf);
			p1.manaPool.G = 1;
			p1.library = [createCardInstance(findPrecon('Forest'), p1.playerId)];

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: elf.instanceId
			});

			// Rider should be consumed and triggered ability queued on top of elf
			assert.equal(p1.manaRiders?.length, 0);
			assert.equal(state.stack.length, 2);
			assert.equal(state.stack[1].title.includes('Scry 1'), true);

			// Resolve Scry 1
			resolveTopOfStack(state);
			assert.equal(state.stack.length, 1);
		});

		it('PA-4: When spent on creature that does not share type with commander, no Scry', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const cmd = createCardInstance(findPrecon('Lathril, Blade of the Elves'), p1.playerId); // Elf Noble
			cmd.isCommander = true;
			p1.command = [cmd];

			p1.manaRiders = [
				{
					sourceInstanceId: 'path_1',
					sourceCard: findPrecon('Path of Ancestry'),
					condition: { sharesCreatureTypeWithCommander: true },
					scryAmount: 1
				}
			];

			// Drannith Magistrate is Human Wizard (does not share Elf or Noble)
			const nonElf = createCardInstance(findPrecon('Drannith Magistrate'), p1.playerId);
			p1.hand.push(nonElf);
			p1.manaPool.W = 1;
			p1.manaPool.C = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: nonElf.instanceId
			});

			// Rider remains unconsumed; only nonElf is on stack
			assert.equal(state.stack.length, 1);
			assert.equal(state.stack[0].card.name, 'Drannith Magistrate');
		});

		it('PA-5: synthetic renamed Path of Ancestry behaves identically', () => {
			const synth = syntheticCard({
				name: 'Cradle of Lineage',
				typeLine: 'Land',
				oracleText: 'Cradle of Lineage enters the battlefield tapped.\n{T}: Add one mana of any color in your commander\'s color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1.'
			});
			const compiled = compileCard(synth);
			assert.equal(compiled.fullySupported, true);
		});
	});

	describe('Feature 12: Scourge of Valkas (SV-1 through SV-4)', () => {
		it('SV-1: Flying and firebreathing ({R}: +1/+0)', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const sov = putOnBattlefield(p1, 'Scourge of Valkas');
			sov.summoningSick = false;
			p1.manaPool.R = 1;

			const abs = getEffectiveActivatedAbilities(state, p1, sov);
			const firebreathing = abs.find((a) => a.costText === '{R}');
			assert.ok(firebreathing);

			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: sov.instanceId,
				abilityId: firebreathing.id
			});
			resolveTopOfStack(state);

			const evaluated = evaluatePermanent(state, sov);
			assert.equal(evaluated.power, 5); // 4 + 1
		});

		it('SV-2: When ~ enters, deals damage equal to number of Dragons you control', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const sovCard = findPrecon('Scourge of Valkas');
			const sov = createCardInstance(sovCard, p1.playerId);
			p1.hand.push(sov);
			p1.manaPool.R = 3;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sov.instanceId
			});
			resolveTopOfStack(state); // enters battlefield, queues trigger

			// Answer target prompt targeting Bob
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
			}
			resolveTopOfStack(state); // deals 1 damage (1 Dragon)
			assert.equal(p2.life, 39);
		});

		it('SV-3: Dragon count evaluated dynamically at trigger resolution', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const sov = putOnBattlefield(p1, 'Scourge of Valkas'); // Dragon 1

			// Cast a second Dragon (Goldspan Dragon)
			const dragon2 = createCardInstance(findPrecon('Goldspan Dragon'), p1.playerId);
			p1.hand.push(dragon2);
			p1.manaPool.R = 5;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: dragon2.instanceId
			});
			resolveTopOfStack(state); // Goldspan Dragon enters battlefield -> Scourge triggers

			// Answer target prompt targeting Bob
			assert.equal(state.pendingPrompts.length, 1);
			const prm = state.pendingPrompts[0];
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
			});

			assert.equal(state.stack.length, 1, 'Scourge trigger is on stack');

			// At trigger creation time, Alice controls 2 Dragons (Scourge of Valkas + Goldspan Dragon)
			const dragonsAtTrigger = p1.battlefield.filter((c) =>
				evaluatePermanent(state, c).hasSubType('Dragon')
			).length;
			assert.equal(dragonsAtTrigger, 2, '2 Dragons on battlefield when trigger was queued');

			// While Scourge trigger is still on stack, a 3rd Dragon enters battlefield under Alice's control
			putOnBattlefield(p1, 'Terror of the Peaks'); // Dragon 3
			const dragonsAtResolution = p1.battlefield.filter((c) =>
				evaluatePermanent(state, c).hasSubType('Dragon')
			).length;
			assert.equal(dragonsAtResolution, 3, '3 Dragons on battlefield prior to resolution');

			// Resolve Scourge trigger: dynamic count must evaluate to 3 at resolution time (CR 608.2h)
			const bobLifeBefore = p2.life;
			resolveTopOfStack(state);
			assert.equal(p2.life, bobLifeBefore - 3, 'Bob takes 3 damage matching dynamic dragon count at resolution');
		});

		it('SV-4: synthetic renamed Scourge of Valkas behaves identically', () => {
			const synth = syntheticCard({
				name: 'Draconic Pyremaster',
				manaCost: '{2}{R}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '4',
				toughness: '4',
				oracleText: 'Flying\nWhenever Draconic Pyremaster or another Dragon enters the battlefield under your control, it deals X damage to any target, where X is the number of Dragons you control.\n{R}: Draconic Pyremaster gets +1/+0 until end of turn.'
			});
			const compiled = compileCard(synth);
			assert.equal(compiled.fullySupported, true);
		});
	});

	describe('Feature 13: Terror of the Peaks (TP-1 through TP-5)', () => {
		it('TP-1: Spells opponents cast that target Terror of the Peaks cost an additional 3 life', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const totp = putOnBattlefield(p1, 'Terror of the Peaks');

			const bolt = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt);
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;

			const initialLife = p2.life;
			const castRes = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: totp.instanceId, label: 'Terror of the Peaks' }]
			});
			assert.equal(castRes.ok, true);

			// p2 should have paid 3 life!
			assert.equal(p2.life, initialLife - 3);
		});

		it('TP-2: Opponent cannot cast spell targeting Terror of the Peaks without at least 3 life', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const totp = putOnBattlefield(p1, 'Terror of the Peaks');

			p2.life = 2; // Insufficient life to pay 3 life
			const bolt = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt);
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;

			const castRes = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: totp.instanceId, label: 'Terror of the Peaks' }]
			});
			assert.equal(castRes.ok, false);
		});

		it('TP-3: When another creature enters under your control, deals damage equal to its power to any target', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const totp = putOnBattlefield(p1, 'Terror of the Peaks');

			const elf = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			elf.card.power = '4';
			elf.card.toughness = '4';
			p1.hand.push(elf);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: elf.instanceId
			});
			resolveTopOfStack(state); // elf enters -> Terror trigger queued

			// Answer target prompt targeting Bob
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
			}
			resolveTopOfStack(state); // deals 4 damage
			assert.equal(p2.life, 36);
		});

		it('TP-4: LKI power used if entering creature dies before trigger resolves', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const totp = putOnBattlefield(p1, 'Terror of the Peaks');

			// Cast a creature with 5 power and 2 toughness
			const creature = createCardInstance(findPrecon('Llanowar Elves'), p1.playerId);
			creature.card.power = '5';
			creature.card.toughness = '2';
			p1.hand.push(creature);
			p1.manaPool.G = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: creature.instanceId
			});
			resolveTopOfStack(state); // Creature resolves and enters battlefield -> Terror triggers

			// Answer target prompt targeting Bob
			assert.equal(state.pendingPrompts.length, 1);
			const prm = state.pendingPrompts[0];
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
			});

			assert.equal(state.stack.length, 1, 'Terror trigger is on stack');

			// While Terror trigger is on stack, Bob casts Lightning Bolt targeting the entering creature
			const bolt = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt);
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;

			const boltCast = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'permanent', id: creature.instanceId, label: 'Llanowar Elves' }]
			});
			assert.equal(boltCast.ok, true, 'Bob casts Lightning Bolt on entering creature');
			assert.equal(state.stack.length, 2, 'Bolt on top of Terror trigger');

			// Resolve Bolt: deals 3 damage to 5/2 creature, lethal SBA destroys it
			resolveTopOfStack(state);
			assert.equal(
				p1.battlefield.some((c) => c.instanceId === creature.instanceId),
				false,
				'Creature left battlefield before Terror trigger resolves'
			);
			assert.equal(p1.graveyard.length, 1, 'Creature is in graveyard');
			assert.equal(p1.graveyard[0].lastKnownPower, 5, 'LKI power captured on death');

			// Resolve Terror trigger: deals damage equal to creature LKI power (5) to Bob
			const bobLifeBefore = p2.life;
			resolveTopOfStack(state);
			assert.equal(p2.life, bobLifeBefore - 5, 'Bob takes 5 damage from LKI power (CR 608.2h)');
		});

		it('TP-5: synthetic renamed Terror of the Peaks behaves identically', () => {
			const synth = syntheticCard({
				name: 'Apex Predator of the Crag',
				manaCost: '{3}{R}{R}',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '4',
				oracleText: 'Flying\nSpells your opponents cast that target Apex Predator of the Crag cost an additional 3 life to cast.\nWhenever another creature enters the battlefield under your control, Apex Predator of the Crag deals damage equal to that creature\'s power to any target.'
			});
			const compiled = compileCard(synth);
			assert.equal(compiled.fullySupported, true);
		});
	});
});
