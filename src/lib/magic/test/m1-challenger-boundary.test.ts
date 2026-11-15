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
import { PRECON_DECKS } from '../precons.ts';
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
import { hasAllOffBattlefieldAndSpellsColorless } from '../runtime/layers.ts';
import { matchesObjectFilter } from '../runtime/objectFilter.ts';

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
		'CHALLENGER_TEST',
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
	p1.library = [];
	p2.library = [];
	return { state, p1, p2 };
}

describe('M1 Challenger 2 — Empirical Boundary Conditions & Invariants', () => {
	// =========================================================================
	// 1. Chaos Warp Boundary Conditions
	// =========================================================================
	describe('1. Chaos Warp Boundary Conditions', () => {
		it('CW-EDGE-1: Target token when library is completely empty', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = []; // Library is empty

			const token = putOnBattlefield(
				p2,
				syntheticCard({ name: 'Saproling Token', typeLine: 'Token Creature — Saproling', power: '1', toughness: '1' })
			);
			token.isToken = true;

			const cwCard = findPrecon('Chaos Warp');
			const cwInst = createCardInstance(cwCard, p1.playerId);
			p1.hand.push(cwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cwInst.instanceId,
				targets: [{ kind: 'permanent', id: token.instanceId, label: 'Saproling Token' }]
			});
			assert.equal(castRes.ok, true);

			// Resolve Chaos Warp:
			// 1. Token ceases to exist upon leaving the battlefield / entering library
			// 2. Library remains 0 cards
			// 3. Reveal from empty library reveals nothing, puts nothing on battlefield
			resolveTopOfStack(state);

			assert.equal(p2.battlefield.length, 0, 'No permanents on battlefield');
			assert.equal(p2.library.length, 0, 'Library remains empty');
			assert.equal(p2.battlefield.some((c) => c.instanceId === token.instanceId), false);
		});

		it('CW-EDGE-2: Target non-token permanent when library is empty (shuffles itself into library)', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = []; // Library is empty

			const land = putOnBattlefield(p2, 'Mountain');

			const cwCard = findPrecon('Chaos Warp');
			const cwInst = createCardInstance(cwCard, p1.playerId);
			p1.hand.push(cwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cwInst.instanceId,
				targets: [{ kind: 'permanent', id: land.instanceId, label: 'Mountain' }]
			});

			// Resolve Chaos Warp:
			// Mountain is shuffled into empty library -> library has 1 card (Mountain).
			// Then top card is revealed (Mountain, a permanent card).
			// It is put back onto the battlefield!
			resolveTopOfStack(state);

			assert.equal(p2.battlefield.length, 1, 'Mountain returned to battlefield');
			assert.equal(p2.battlefield[0].card.name, 'Mountain');
			assert.equal(p2.library.length, 0, 'Library empty after permanent put on battlefield');
		});

		it('CW-EDGE-3: Target commander with redirection to command zone when library is empty', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = []; // Empty library

			const cmdCard = findPrecon('Lathril, Blade of the Elves');
			const cmdInst = putOnBattlefield(p2, cmdCard);
			cmdInst.isCommander = true;

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

			// Answer commander zone replacement prompt: redirect to command zone
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p2.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			// Commander redirected to command zone; library is empty; nothing revealed/put on battlefield
			assert.equal(p2.command.some((c) => c.instanceId === cmdInst.instanceId), true);
			assert.equal(p2.battlefield.length, 0);
			assert.equal(p2.library.length, 0);
		});

		it('CW-EDGE-4: Non-permanent revealed card remains in library and does not enter battlefield', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			p2.library = [];

			const token = putOnBattlefield(
				p2,
				syntheticCard({ name: 'Soldier Token', typeLine: 'Token Creature — Soldier', power: '1', toughness: '1' })
			);
			token.isToken = true;

			// Library contains only an instant card
			const topInstant = putInLibrary(p2, 'Lightning Bolt');

			const cwCard = findPrecon('Chaos Warp');
			const cwInst = createCardInstance(cwCard, p1.playerId);
			p1.hand.push(cwInst);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cwInst.instanceId,
				targets: [{ kind: 'permanent', id: token.instanceId, label: 'Soldier Token' }]
			});
			resolveTopOfStack(state);

			assert.equal(p2.battlefield.length, 0, 'Instant does not enter battlefield');
			assert.equal(p2.library.length, 1, 'Instant stays in library');
			assert.equal(p2.library[0].instanceId, topInstant.instanceId);
		});
	});

	// =========================================================================
	// 2. Crystalline Crawler Boundary Conditions
	// =========================================================================
	describe('2. Crystalline Crawler Boundary Conditions', () => {
		it('CC-EDGE-1: 0 counters prevents counter removal for mana', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const crawler = putOnBattlefield(p1, 'Crystalline Crawler');
			crawler.counters['+1/+1'] = 0;
			crawler.summoningSick = false;

			const abs = getEffectiveActivatedAbilities(state, p1, crawler);
			const manaAb = abs.find((a) => a.costText.includes('Remove a +1/+1 counter'));

			// If ability is returned, attempting activation MUST fail
			if (manaAb) {
				const res = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: crawler.instanceId,
					abilityId: manaAb.id
				});
				assert.equal(res.ok, false, 'Activation must fail with 0 counters');
			}
			assert.equal(crawler.counters['+1/+1'] || 0, 0);
		});

		it('CC-EDGE-2: Colorless-only mana spent ({C}{C}{C}{C}) yields 0 counters (CR 105.4)', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const ccCard = findPrecon('Crystalline Crawler');
			const ccInst = createCardInstance(ccCard, p1.playerId);
			p1.hand.push(ccInst);

			p1.manaPool.C = 4; // 4 colorless mana, 0 colored mana

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ccInst.instanceId
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			const crawler = p1.battlefield.find((c) => c.instanceId === ccInst.instanceId);
			assert.ok(crawler);
			assert.equal(crawler.counters['+1/+1'] || 0, 0, 'Colorless mana gives 0 converge counters');
		});

		it('CC-EDGE-3: 5 distinct colors spent yields 5 counters', () => {
			const { state, p1 } = makeTwoPlayerGame();
			// Add a static cost increase of {1} so total cost is {5}
			putOnBattlefield(
				p1,
				syntheticCard({
					name: 'Sphere of Resistance Synthetic',
					typeLine: 'Artifact',
					oracleText: 'Spells cost {1} more to cast.'
				})
			);

			const ccCard = findPrecon('Crystalline Crawler');
			const ccInst = createCardInstance(ccCard, p1.playerId);
			p1.hand.push(ccInst);

			// Spend 5 distinct colors: W, U, B, R, G
			p1.manaPool.W = 1;
			p1.manaPool.U = 1;
			p1.manaPool.B = 1;
			p1.manaPool.R = 1;
			p1.manaPool.G = 1;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ccInst.instanceId
			});
			assert.equal(castRes.ok, true);
			resolveTopOfStack(state);

			const crawler = p1.battlefield.find((c) => c.instanceId === ccInst.instanceId);
			assert.ok(crawler);
			assert.equal(crawler.counters['+1/+1'], 5, '5 colors spent yields 5 counters');
		});

		it('CC-EDGE-4: Counter removal for mana is legal when summoning sick, but {T} is not', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const crawler = putOnBattlefield(p1, 'Crystalline Crawler');
			crawler.counters['+1/+1'] = 2;
			crawler.summoningSick = true; // Summoning sick!

			const abs = getEffectiveActivatedAbilities(state, p1, crawler);
			const manaAb = abs.find((a) => a.costText.includes('Remove a +1/+1 counter'));
			const tapAb = abs.find((a) => a.costText === '{T}');

			assert.ok(manaAb, 'Mana ability without tap is available');

			// Removing counter does not require tap, so summoning sickness does not prevent it
			const actRes = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: crawler.instanceId,
				abilityId: manaAb.id
			});
			assert.equal(actRes.ok, true);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseMode', indices: [0] }
				});
			}
			assert.equal(crawler.counters['+1/+1'], 1);

			// {T} ability requires tap, so summoning sickness MUST prevent it
			if (tapAb) {
				const tapRes = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: crawler.instanceId,
					abilityId: tapAb.id
				});
				assert.equal(tapRes.ok, false, '{T} ability must be rejected due to summoning sickness');
			}
		});
	});

	// =========================================================================
	// 3. Expressive Iteration Boundary Conditions
	// =========================================================================
	describe('3. Expressive Iteration Boundary Conditions', () => {
		it('EI-EDGE-1: Library with exactly 0 cards resolves cleanly without corruption', () => {
			const { state, p1 } = makeTwoPlayerGame();
			p1.library = []; // 0 cards

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

			assert.equal(p1.hand.length, 0);
			assert.equal(p1.exile.length, 0);
			assert.equal(p1.library.length, 0);
			assert.equal(state.pendingPrompts.length, 0);
		});

		it('EI-EDGE-2: Library with exactly 1 card puts it into hand', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const c1 = createCardInstance(findPrecon('Mountain'), p1.playerId);
			p1.library = [c1];

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

			assert.equal(p1.hand.length, 1);
			assert.equal(p1.hand[0].instanceId, c1.instanceId);
			assert.equal(p1.exile.length, 0);
			assert.equal(p1.library.length, 0);
		});

		it('EI-EDGE-3: Library with exactly 2 cards prompts for hand and exiles other (0 to bottom)', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const c1 = createCardInstance(findPrecon('Mountain'), p1.playerId);
			const c2 = createCardInstance(findPrecon('Forest'), p1.playerId);
			p1.library = [c1, c2];

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

			// Choice prompt for hand
			assert.equal(state.pendingPrompts.length, 1);
			const prm = state.pendingPrompts[0];
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [c1.instanceId] }
			});

			assert.equal(p1.hand.some((c) => c.instanceId === c1.instanceId), true, 'c1 in hand');
			assert.equal(p1.exile.some((c) => c.instanceId === c2.instanceId), true, 'c2 in exile');
			assert.equal(p1.library.length, 0, '0 cards on bottom of library');
		});

		it('EI-EDGE-4: Playing land vs casting spell from exile and turn expiration', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const land = createCardInstance(findPrecon('Mountain'), p1.playerId);
			land.playableFromExileBy = {
				playerId: p1.playerId,
				expiresAtEndOfTurn: true,
				sourceName: 'Expressive Iteration',
				spendManaAsAnyColor: false
			};
			p1.exile.push(land);

			// Play the land
			const playRes = applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: land.instanceId
			});
			assert.equal(playRes.ok, true);
			assert.equal(p1.landsPlayedThisTurn, 1);
			assert.equal(land.playableFromExileBy, undefined, 'Permission cleared after playing');

			// Second land from exile must be rejected by land limit
			const land2 = createCardInstance(findPrecon('Forest'), p1.playerId);
			land2.playableFromExileBy = {
				playerId: p1.playerId,
				expiresAtEndOfTurn: true,
				sourceName: 'Expressive Iteration',
				spendManaAsAnyColor: false
			};
			p1.exile.push(land2);

			const playRes2 = applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: land2.instanceId
			});
			assert.equal(playRes2.ok, false, 'Cannot play second land without extra land play permission');

			// Cast spell from exile
			const spell = createCardInstance(findPrecon('Lightning Bolt'), p1.playerId);
			spell.playableFromExileBy = {
				playerId: p1.playerId,
				expiresAtEndOfTurn: true,
				sourceName: 'Expressive Iteration',
				spendManaAsAnyColor: false
			};
			p1.exile.push(spell);
			p1.manaPool.R = 1;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spell.instanceId,
				targets: [{ kind: 'player', id: state.players[1].playerId, label: 'Bob' }]
			});
			assert.equal(castRes.ok, true);
			assert.equal(spell.playableFromExileBy, undefined, 'Permission cleared upon casting');

			// Permission expiration at end of turn
			const unplayed = createCardInstance(findPrecon('Cultivate'), p1.playerId);
			unplayed.playableFromExileBy = {
				playerId: p1.playerId,
				expiresAtEndOfTurn: true,
				sourceName: 'Expressive Iteration',
				spendManaAsAnyColor: false
			};
			p1.exile.push(unplayed);

			enterEndStep(state, p1);
			advancePhaseOrStep(state); // cleanup
			assert.equal(unplayed.playableFromExileBy, undefined, 'Permission expires at cleanup');
		});
	});

	// =========================================================================
	// 4. Evolve & Fathom Mage Intervening-If Boundaries
	// =========================================================================
	describe('4. Evolve & Fathom Mage Intervening-If Boundaries', () => {
		it('FM-EDGE-1: Intervening-if succeeds via LKI when entering creature dies before resolve', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage'); // 1/1

			// Cast a synthetic 3/3 creature
			const enterCard = syntheticCard({ name: 'Synth Golem', typeLine: 'Creature — Golem', power: '3', toughness: '3' });
			const enter = createCardInstance(enterCard, p1.playerId);
			p1.hand.push(enter);
			p1.manaPool.C = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: enter.instanceId
			});
			resolveTopOfStack(state); // Creature enters, evolve triggers and is on stack

			// Kill the 3/3 entering creature before evolve resolves
			const onBf = p1.battlefield.find((c) => c.instanceId === enter.instanceId);
			assert.ok(onBf);
			onBf.lastKnownPower = 3;
			onBf.lastKnownToughness = 3;
			p1.battlefield = p1.battlefield.filter((c) => c.instanceId !== enter.instanceId);
			p1.graveyard.push(onBf);

			// Evolve resolves: checks LKI of entering creature (3/3) vs Fathom Mage (1/1). 3 > 1!
			resolveTopOfStack(state); // Evolve resolves
			assert.equal(fm.counters['+1/+1'], 1, 'Evolve succeeds using LKI of dead creature');
		});

		it('FM-EDGE-2: Intervening-if fails when entering creature is shrunk before resolve', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage'); // 1/1
			fm.counters['+1/+1'] = 1; // 1 counter -> 2/2

			// Enter a 3/3 creature -> triggers evolve (3 > 2)
			const enterCard = syntheticCard({ name: 'Synth Beast', typeLine: 'Creature — Beast', power: '3', toughness: '3' });
			const enter = createCardInstance(enterCard, p1.playerId);
			p1.hand.push(enter);
			p1.manaPool.C = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: enter.instanceId
			});
			resolveTopOfStack(state); // enters, evolve triggers and is on stack

			// Shrink entering creature on battlefield with 2 -1/-1 counters (evaluates to 1/1)
			const onBf = p1.battlefield.find((c) => c.instanceId === enter.instanceId);
			assert.ok(onBf);
			onBf.counters['-1/-1'] = 2; // shrinks power/toughness from 3/3 to 1/1

			// Evolve resolves: 1/1 is not greater than 2/2 -> fails intervening-if!
			resolveTopOfStack(state);
			assert.equal(fm.counters['+1/+1'], 1, 'No counter placed when entering creature shrunk');
		});

		it('FM-EDGE-3: Multiple evolve triggers resolving sequentially test intervening-if at each resolution', () => {
			const { state, p1 } = makeTwoPlayerGame();
			const fm = putOnBattlefield(p1, 'Fathom Mage'); // 1/1
			p1.library = [createCardInstance(findPrecon('Forest'), p1.playerId, 'library')];

			// Two 2/2 creatures enter sequentially
			const c1Card = syntheticCard({ name: 'Bear One', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
			const c1 = createCardInstance(c1Card, p1.playerId);
			p1.hand.push(c1);
			p1.manaPool.C = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: c1.instanceId
			});
			resolveTopOfStack(state); // c1 enters, queues evolve
			resolveTopOfStack(state); // evolve resolves: FM becomes 2/2 (+1 counter), queues draw
			resolveTopOfStack(state); // draw trigger resolves, prompts trigger_may
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			assert.equal(fm.counters['+1/+1'], 1, 'FM grew to 2/2');
			assert.equal(state.stack.length, 0, 'Stack is empty');

			// Second 2/2 enters
			const c2Card = syntheticCard({ name: 'Bear Two', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
			const c2 = createCardInstance(c2Card, p1.playerId);
			p1.hand.push(c2);
			p1.manaPool.C = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: c2.instanceId
			});
			resolveTopOfStack(state); // c2 enters

			// c2 does NOT trigger evolve because 2 is not > 2!
			assert.equal(state.stack.length, 0, 'No evolve trigger when power/toughness equal');
			assert.equal(fm.counters['+1/+1'], 1, 'FM remains 2/2');
		});
	});

	// =========================================================================
	// 5. Hellkite Charger Boundary Conditions
	// =========================================================================
	describe('5. Hellkite Charger Boundary Conditions', () => {
		it('HC-EDGE-1: Untaps ALL attacking creatures and grants extra combat upon payment', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const hc = putOnBattlefield(p1, 'Hellkite Charger');
			hc.summoningSick = false;

			const elf = putOnBattlefield(p1, 'Llanowar Elves');
			elf.summoningSick = false;

			p1.manaPool.R = 2;
			p1.manaPool.C = 5;

			state.phase = 'declare_attackers';
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: hc.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: elf.instanceId, defenderPlayerId: p2.playerId }
				]
			});

			// Both attackers are tapped
			assert.equal(hc.tapped, true);
			assert.equal(elf.tapped, true);

			// Resolve attack trigger and accept {5}{R}{R} payment
			resolveTopOfStack(state);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
			}

			// Both creatures must be untapped!
			assert.equal(hc.tapped, false, 'Hellkite Charger untapped');
			assert.equal(elf.tapped, false, 'Llanowar Elves untapped');
			assert.equal(state.additionalCombatPhases, 1);
		});

		it('HC-EDGE-2: Mana insufficiency prevents payment and extra combat', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const hc = putOnBattlefield(p1, 'Hellkite Charger');
			hc.summoningSick = false;

			// Insufficient mana: only {3}{R} instead of {5}{R}{R}
			p1.manaPool.R = 1;
			p1.manaPool.C = 3;

			state.phase = 'declare_attackers';
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: hc.instanceId, defenderPlayerId: p2.playerId }]
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

			assert.equal(state.additionalCombatPhases ?? 0, 0, 'No extra combat when mana insufficient');
			assert.equal(hc.tapped, true, 'Attacker remains tapped');
		});

		it('HC-EDGE-3: Multiple extra combats chained in single turn', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const hc = putOnBattlefield(p1, 'Hellkite Charger');
			hc.summoningSick = false;

			// Combat 1: Add mana for combat 1 payment
			p1.manaPool.R = 2;
			p1.manaPool.C = 5;

			state.phase = 'declare_attackers';
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: hc.instanceId, defenderPlayerId: p2.playerId }]
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
			assert.equal(hc.tapped, false);

			// End combat 1 -> transitions to begin_combat of additional combat
			state.phase = 'end_combat';
			advancePhaseOrStep(state);
			assert.equal(state.phase, 'begin_combat');
			assert.equal(state.additionalCombatPhases, 0);

			// Advance from begin_combat to declare_attackers
			advancePhaseOrStep(state);
			assert.equal(state.phase, 'declare_attackers');

			// Replenish mana for combat 2 (CR 106.4: mana emptied at phase/step end)
			p1.manaPool.R = 2;
			p1.manaPool.C = 5;

			// Combat 2: Attack and pay again
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: hc.instanceId, defenderPlayerId: p2.playerId }]
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
			assert.equal(state.additionalCombatPhases, 1, 'Second extra combat phase granted');
			assert.equal(hc.tapped, false);

			// End combat 2 -> begins combat 3
			state.phase = 'end_combat';
			advancePhaseOrStep(state);
			assert.equal(state.phase, 'begin_combat');
			assert.equal(state.additionalCombatPhases, 0);

			// End combat 3 -> moves to main2
			state.phase = 'end_combat';
			advancePhaseOrStep(state);
			assert.equal(state.phase, 'main2', 'Transitions to main2 when additional combats exhausted');
		});
	});

	// =========================================================================
	// 6. Terror of the Peaks & Scourge of Valkas Boundary Conditions
	// =========================================================================
	describe('6. Terror of the Peaks & Scourge of Valkas Boundary Conditions', () => {
		it('TP-EDGE-1: Opponent with <= 3 life targeting Terror of the Peaks', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const totp = putOnBattlefield(p1, 'Terror of the Peaks');

			state.priorityPlayerIndex = 1;

			// Case A: Opponent has exactly 3 life -> can pay 3 life (reduces life to 0)
			p2.life = 3;
			const bolt1 = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt1);
			p2.manaPool.R = 1;

			const castRes1 = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt1.instanceId,
				targets: [{ kind: 'permanent', id: totp.instanceId, label: 'Terror of the Peaks' }]
			});
			assert.equal(castRes1.ok, true, 'Player with 3 life can pay 3 life');
			assert.equal(p2.life, 0, 'Life reduced to 0');

			// Clean stack
			state.stack = [];

			// Case B: Opponent has 2 life -> cannot pay 3 life
			p2.life = 2;
			const bolt2 = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt2);
			p2.manaPool.R = 1;

			const castRes2 = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt2.instanceId,
				targets: [{ kind: 'permanent', id: totp.instanceId, label: 'Terror of the Peaks' }]
			});
			assert.equal(castRes2.ok, false, 'Player with 2 life cannot pay 3 life');

			// Case C: Opponent has 1 life -> cannot pay 3 life
			p2.life = 1;
			const bolt3 = createCardInstance(findPrecon('Lightning Bolt'), p2.playerId);
			p2.hand.push(bolt3);
			p2.manaPool.R = 1;

			const castRes3 = applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt3.instanceId,
				targets: [{ kind: 'permanent', id: totp.instanceId, label: 'Terror of the Peaks' }]
			});
			assert.equal(castRes3.ok, false, 'Player with 1 life cannot pay 3 life');
		});

		it('TP-EDGE-2: Terror of the Peaks evaluates LKI power when entering creature dies before resolve', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			putOnBattlefield(p1, 'Terror of the Peaks');

			// Cast a synthetic 5/5 creature
			const creatureCard = syntheticCard({ name: 'Synth Dragon 5/5', typeLine: 'Creature — Dragon', power: '5', toughness: '5' });
			const creature = createCardInstance(creatureCard, p1.playerId);
			p1.hand.push(creature);
			p1.manaPool.C = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: creature.instanceId
			});
			resolveTopOfStack(state); // Enters -> Terror triggers targeting Bob

			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
				});
			}

			// Destroy the 5/5 creature before Terror trigger resolves
			const onBf = p1.battlefield.find((c) => c.instanceId === creature.instanceId);
			assert.ok(onBf);
			onBf.lastKnownPower = 5;
			onBf.lastKnownToughness = 5;
			p1.battlefield = p1.battlefield.filter((c) => c.instanceId !== creature.instanceId);
			p1.graveyard.push(onBf);

			const bobLifeBefore = p2.life;
			resolveTopOfStack(state); // Terror trigger resolves

			assert.equal(p2.life, bobLifeBefore - 5, 'Bob takes 5 damage from LKI power');
		});

		it('SV-EDGE-1: Scourge of Valkas dynamic dragon count evaluation at resolution', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			putOnBattlefield(p1, 'Scourge of Valkas'); // Dragon 1

			// A synthetic Dragon enters (Dragon 2)
			const dragonCard = syntheticCard({ name: 'Synth Dragonette', typeLine: 'Creature — Dragon', power: '2', toughness: '2' });
			const dragon2 = createCardInstance(dragonCard, p1.playerId);
			p1.hand.push(dragon2);
			p1.manaPool.C = 1;

			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: dragon2.instanceId
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

			// Before trigger resolves, a 3rd Dragon enters battlefield under Alice's control
			putOnBattlefield(p1, syntheticCard({ name: 'Synth Dragon 3', typeLine: 'Creature — Dragon', power: '3', toughness: '3' }));

			// Trigger resolves: dynamically counts Dragons at resolution (3 Dragons)
			const bobLifeBefore = p2.life;
			resolveTopOfStack(state);

			assert.equal(p2.life, bobLifeBefore - 3, 'Deals 3 damage (dynamic count of 3 Dragons)');
		});
	});

	// =========================================================================
	// 7. Mycosynth Lattice Boundary Conditions
	// =========================================================================
	describe('7. Mycosynth Lattice Boundary Conditions', () => {
		it('ML-EDGE-1: Basic land types and intrinsic mana abilities are preserved', () => {
			const { state, p1 } = makeTwoPlayerGame();
			putOnBattlefield(p1, 'Mycosynth Lattice');
			const forest = putOnBattlefield(p1, 'Forest');

			const evaluated = evaluatePermanent(state, forest);
			assert.equal(evaluated.isArtifact, true, 'Forest is an artifact (Layer 4)');
			assert.equal(evaluated.isLand, true, 'Forest is a land');
			assert.ok(evaluated.hasSubType('Forest'), 'Forest subtype preserved');
			assert.deepEqual(evaluated.colors, [], 'Forest is colorless (Layer 5)');

			// Intrinsic mana ability works
			const abs = getEffectiveActivatedAbilities(state, p1, forest);
			const manaAb = abs.find((a) => a.isManaAbility);
			assert.ok(manaAb, 'Mana ability preserved');

			forest.tapped = false;
			applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: forest.instanceId,
				abilityId: manaAb.id
			});
			assert.equal(forest.tapped, true);
			assert.equal(p1.manaPool.G, 1);
		});

		it('ML-EDGE-2: Colorless spells with colored mana symbols cast using any color mana and matched as colorless', () => {
			const { state, p1, p2 } = makeTwoPlayerGame();
			putOnBattlefield(p1, 'Mycosynth Lattice');

			// Lightning Bolt in hand ({R})
			const bolt = createCardInstance(findPrecon('Lightning Bolt'), p1.playerId);
			p1.hand.push(bolt);

			// Alice has only Green mana in pool
			p1.manaPool.G = 1;

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: 'Bob' }]
			});
			assert.equal(castRes.ok, true, 'Can cast {R} spell using {G} mana via Mycosynth Lattice');

			// Spells on stack and cards off-battlefield are treated as colorless by filters (CR 613.1e)
			assert.equal(hasAllOffBattlefieldAndSpellsColorless(state), true);
			const redFilter = { colors: ['R' as const] };
			const matchesRed = matchesObjectFilter(bolt, redFilter, { state, controllerId: p1.playerId });
			assert.equal(matchesRed, false, 'Spell on stack does not match red filter because Mycosynth Lattice makes it colorless');
		});

		it('ML-EDGE-3: Layer 4 and Layer 5 order stability under evaluatePermanent', () => {
			const { state, p1 } = makeTwoPlayerGame();
			putOnBattlefield(p1, 'Mycosynth Lattice');
			const creature = putOnBattlefield(
				p1,
				syntheticCard({ name: 'Fresh Elf', typeLine: 'Creature — Elf', power: '1', toughness: '1' })
			);

			// Evaluate multiple times to ensure layer cache and order stability
			for (let i = 0; i < 5; i++) {
				const eval1 = evaluatePermanent(state, creature);
				assert.equal(eval1.isArtifact, true);
				assert.equal(eval1.isCreature, true);
				assert.deepEqual(eval1.colors, []);
				assert.equal(eval1.power, 1);
				assert.equal(eval1.toughness, 1);
			}

			// Perform SBA check to verify state integrity
			checkStateBasedActions(state);
			assert.equal(p1.battlefield.length, 2);
		});
	});
});
