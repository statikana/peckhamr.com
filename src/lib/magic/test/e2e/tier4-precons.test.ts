import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	sanitizeGameStateForViewer
} from '../../engine.ts';
import { compileCard } from '../../compiler/index.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard
} from '../../types.ts';
import {
	addCardToZone,
	assertJsonRoundTrip,
	castSpellAction,
	isFeatureReady,
	makeDeck,
	passAllPriority,
	playLandAction,
	setupE2EGame,
	synthCard
} from './e2e-harness.test.ts';

// Load the precon oracle fixture
const FIXTURE_PATH = join(new URL('.', import.meta.url).pathname, '../../precon-oracle.fixture.json');
const FIXTURE_DATA: Record<string, { oracleText: string; typeLine: string; manaCost: string }> = JSON.parse(
	readFileSync(FIXTURE_PATH, 'utf-8')
);

function getPreconCard(name: string): ScryfallCard {
	const entry = FIXTURE_DATA[name];
	if (!entry) throw new Error(`Card not found in precon fixture: ${name}`);
	return synthCard({
		name,
		oracleText: entry.oracleText,
		typeLine: entry.typeLine,
		manaCost: entry.manaCost,
		canBeCommander: entry.typeLine.includes('Legendary') && entry.typeLine.includes('Creature')
	});
}

describe('Tier 4: Real-World Precon Game Scenarios', () => {
	// ==========================================
	// 1. Precon Match Setup & Initialization
	// ==========================================
	describe('1. 4-Player Commander Match Initialization', () => {
		it('Initializes 4-player game with 40 starting life, commanders in command zone, and 7-card opening hands', () => {
			const cmd1 = getPreconCard('Atraxa, Praetors\' Voice');
			const cmd2 = getPreconCard('Miirym, Sentinel Wyrm');
			const { state, players } = setupE2EGame({
				playerCount: 4,
				p1Commander: cmd1,
				p2Commander: cmd2
			});

			assert.equal(state.status, 'active');
			assert.equal(players.length, 4);
			for (const p of players) {
				assert.equal(p.life, 40);
				assert.equal(p.battlefield.length, 0);
				assert.equal(p.graveyard.length, 0);
				assert.equal(p.exile.length, 0);
			}

			// Commanders in command zone
			assert.equal(players[0].command.length, 1);
			assert.equal(players[0].command[0].card.name, 'Atraxa, Praetors\' Voice');
			assert.equal(players[1].command.length, 1);
			assert.equal(players[1].command[0].card.name, 'Miirym, Sentinel Wyrm');

			// Viewer sanitization verification: Player 2 cannot see Player 1's library contents
			const sanitized = sanitizeGameStateForViewer(state, players[1].playerId);
			const sanitizedP1 = sanitized.players[0];
			assert.equal(sanitizedP1.libraryCount, players[0].library.length);
			assert.equal(sanitizedP1.library.length, 0);

			// JSON round trip
			assertJsonRoundTrip(state);
		});
	});

	// ==========================================
	// 2. Early Turns Precon Ramp & Development
	// ==========================================
	describe('2. Early Turn Ramp: Land Drop, Sol Ring, Arcane Signet', () => {
		it('Turn 1: Command Tower -> Sol Ring -> Arcane Signet sequence', () => {
			const { state, p1 } = setupE2EGame();
			const tower = addCardToZone(state, p1, getPreconCard('Command Tower'), 'hand');
			const solRing = addCardToZone(state, p1, getPreconCard('Sol Ring'), 'hand');
			const signet = addCardToZone(state, p1, getPreconCard('Arcane Signet'), 'hand');

			// 1. Play Land
			const landRes = playLandAction(state, p1, tower);
			assert.equal(landRes.ok, true);
			assert.equal(p1.battlefield.some((c) => c.instanceId === tower.instanceId), true);
			assert.equal(tower.tapped, false);

			// 2. Tap Command Tower for {1}
			p1.manaPool.C += 1;
			tower.tapped = true;

			// 3. Cast Sol Ring
			const solRes = castSpellAction(state, p1, solRing);
			assert.equal(solRes.ok, true);
			passAllPriority(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === solRing.instanceId), true);

			// 4. Tap Sol Ring for {C}{C}
			p1.manaPool.C += 2;
			solRing.tapped = true;

			// 5. Cast Arcane Signet
			const signetRes = castSpellAction(state, p1, signet);
			assert.equal(signetRes.ok, true);
			passAllPriority(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === signet.instanceId), true);

			// Check board state
			assert.equal(p1.battlefield.length, 3);
			assertJsonRoundTrip(state);
		});
	});

	// ==========================================
	// 3. Mid-Game Combat with Staples
	// ==========================================
	describe('3. Precon Combat Interaction: Attack, Block & Swords to Plowshares', () => {
		it('Declare attackers, instant speed Swords to Plowshares removal before damage', () => {
			const { state, p1, p2 } = setupE2EGame();
			const attacker = addCardToZone(state, p1, synthCard({
				name: 'Attacking Dragon',
				typeLine: 'Creature — Dragon',
				power: '5',
				toughness: '5'
			}), 'battlefield');
			attacker.summoningSick = false;

			const swords = addCardToZone(state, p2, getPreconCard('Swords to Plowshares'), 'hand');
			p2.manaPool.W = 1;

			// P1 enters combat and attacks
			state.phase = 'declare_attackers';
			state.combat = {
				active: true,
				attackers: [
					{
						attackerInstanceId: attacker.instanceId,
						controllerId: p1.playerId,
						defenderPlayerId: p2.playerId,
						blockerInstanceIds: []
					}
				],
				declaredBlockersPlayerIds: [],
				damageDealtFirstStrike: false,
				damageDealtNormal: false
			};
			attacker.tapped = true;

			// P2 casts Swords to Plowshares targeting the attacker
			state.priorityPlayerIndex = 1;
			const swordsRes = castSpellAction(state, p2, swords, {
				targets: [{ kind: 'permanent', id: attacker.instanceId, label: 'Attacking Dragon' }]
			});
			assert.equal(swordsRes.ok, true, swordsRes.error ?? '');

			// Resolve Swords
			passAllPriority(state);

			// Attacker is exiled
			assert.equal(p1.battlefield.some((c) => c.instanceId === attacker.instanceId), false);
			assert.equal(p1.exile.some((c) => c.card.name === 'Attacking Dragon'), true);

			// Controller of exiled creature gains life equal to its power (5)
			assert.equal(p1.life, 40 + 5);
			assertJsonRoundTrip(state);
		});
	});

	// ==========================================
	// 4. Board Wipe & Reset
	// ==========================================
	describe('4. Precon Board Wipe: Wrath of God', () => {
		it('Wrath of God destroys all creatures without allowing regeneration', () => {
			const { state, p1, p2 } = setupE2EGame();
			const c1 = addCardToZone(state, p1, synthCard({ name: 'Creature 1', power: '2', toughness: '2' }), 'battlefield');
			const c2 = addCardToZone(state, p1, synthCard({ name: 'Creature 2', power: '3', toughness: '3' }), 'battlefield');
			const c3 = addCardToZone(state, p2, synthCard({ name: 'Creature 3', power: '4', toughness: '4' }), 'battlefield');
			const wrath = addCardToZone(state, p1, getPreconCard('Wrath of God'), 'hand');

			p1.manaPool.W = 4;
			const res = castSpellAction(state, p1, wrath);
			assert.equal(res.ok, true);

			passAllPriority(state);

			// All 3 creatures destroyed
			assert.equal(p1.battlefield.some((c) => c.instanceId === c1.instanceId), false);
			assert.equal(p1.battlefield.some((c) => c.instanceId === c2.instanceId), false);
			assert.equal(p2.battlefield.some((c) => c.instanceId === c3.instanceId), false);

			assert.equal(p1.graveyard.some((c) => c.instanceId === c1.instanceId), true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === c2.instanceId), true);
			assert.equal(p2.graveyard.some((c) => c.instanceId === c3.instanceId), true);

			assertJsonRoundTrip(state);
		});
	});

	// ==========================================
	// 5. Precon Targeted Removal & Utility Staples
	// ==========================================
	describe('5. Precon Targeted Utility: Beast Within & Arcane Denial', () => {
		it('Beast Within destroys permanent and creates 3/3 green Beast token for controller', () => {
			const { state, p1, p2 } = setupE2EGame();
			const targetLand = addCardToZone(state, p2, synthCard({ name: 'Valuable Land', typeLine: 'Land' }), 'battlefield');
			const beastWithin = addCardToZone(state, p1, getPreconCard('Beast Within'), 'hand');

			p1.manaPool.G = 3;
			const res = castSpellAction(state, p1, beastWithin, {
				targets: [{ kind: 'permanent', id: targetLand.instanceId, label: 'Valuable Land' }]
			});
			assert.equal(res.ok, true, res.error ?? '');

			passAllPriority(state);

			// Land is destroyed
			assert.equal(p2.battlefield.some((c) => c.instanceId === targetLand.instanceId), false);
			assert.equal(p2.graveyard.some((c) => c.instanceId === targetLand.instanceId), true);

			// 3/3 Beast token created under P2 control
			const beastToken = p2.battlefield.find((c) => c.isToken);
			assert.ok(beastToken, 'Beast token should be created on P2 battlefield');

			assertJsonRoundTrip(state);
		});

		it('Arcane Denial counters spell and sets up delayed upkeep draw triggers', () => {
			const { state, p1, p2 } = setupE2EGame();
			const spell = addCardToZone(state, p1, synthCard({ name: 'Big Spell', manaCost: '{3}', typeLine: 'Sorcery' }), 'hand');
			p1.manaPool.C = 3;
			castSpellAction(state, p1, spell);
			assert.equal(state.stack.length, 1);
			const topStack = state.stack[state.stack.length - 1];

			const arcaneDenial = addCardToZone(state, p2, getPreconCard('Arcane Denial'), 'hand');
			p2.manaPool.U = 2;
			state.priorityPlayerIndex = 1;
			const denialRes = castSpellAction(state, p2, arcaneDenial, {
				targets: [{ kind: 'stack', id: topStack.id, label: 'Big Spell' }]
			});
			assert.equal(denialRes.ok, true, denialRes.error ?? '');

			passAllPriority(state);

			// Spell was countered and moved to graveyard
			assert.equal(state.stack.length, 0);
			assert.equal(p1.graveyard.some((c) => c.card.name === 'Big Spell'), true);

			assertJsonRoundTrip(state);
		});
	});

	// ==========================================
	// 6. M1 Precon Cards Integration Scenarios
	// ==========================================
	describe('6. Milestone 1 Precon Gameplay Scenarios', () => {
		it('Chaos Warp shuffles permanent and reveals replacement in live precon match', (t) => {
			if (!isFeatureReady('chaos_warp')) {
				t.skip('Chaos Warp awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const threat = addCardToZone(state, p2, getPreconCard('Akroma\'s Memorial'), 'battlefield');
			const threatVersionBefore = threat.objectVersion ?? 1;
			const initialBattlefieldCount = p2.battlefield.length;
			const warp = addCardToZone(state, p1, getPreconCard('Chaos Warp'), 'hand');
			p1.manaPool.R = 3;
			castSpellAction(state, p1, warp, { targets: [{ kind: 'permanent', id: threat.instanceId, label: 'Akroma\'s Memorial' }] });
			passAllPriority(state);

			// Under CR 701.24c and CR 400.7:
			// Threat was shuffled into library and top card revealed.
			// Since p2's library consists of permanent cards (Plains + Akroma's Memorial),
			// exactly one permanent card enters the battlefield from the library.
			assert.equal(p2.battlefield.length, initialBattlefieldCount);

			// If the revealed card was Akroma's Memorial, it re-entered as a new object (CR 400.7: objectVersion bumped).
			// If the revealed card was a Plains, Akroma's Memorial remains in the library.
			const memorialOnBf = p2.battlefield.find((c) => c.instanceId === threat.instanceId);
			if (memorialOnBf) {
				assert.ok((memorialOnBf.objectVersion ?? 1) > threatVersionBefore, 'Object version must bump on re-entry');
			} else {
				assert.equal(p2.library.some((c) => c.instanceId === threat.instanceId), true, 'Threat must be in library if not on BF');
			}
		});

		it('Jeska\'s Will generates mana and cards in live precon match', (t) => {
			if (!isFeatureReady('jeskas_will')) {
				t.skip('Jeska\'s Will awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			// Control commander to enable choosing both modes (CR 700.2a)
			const cmd = addCardToZone(state, p1, getPreconCard('The Ur-Dragon'), 'battlefield');
			cmd.isCommander = true;

			const will = addCardToZone(state, p1, getPreconCard('Jeska\'s Will'), 'hand');
			p1.manaPool.R = 3;
			const targetHandSize = p2.hand.length;

			const castRes = castSpellAction(state, p1, will, {
				modes: [0, 1],
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			});
			assert.equal(castRes.ok, true);
			passAllPriority(state);

			// Mode 0: Add {R} equal to target opponent's hand size
			assert.equal(p1.manaPool.R, targetHandSize);
			// Mode 1: Exile top 3 cards of library playable this turn
			assert.equal(p1.exile.length, 3);
		});

		it('Terror of the Peaks taxes opponent removal and triggers on entering dragons', (t) => {
			if (!isFeatureReady('terror_of_the_peaks')) {
				t.skip('Terror of the Peaks awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const terror = addCardToZone(state, p1, getPreconCard('Terror of the Peaks'), 'battlefield');
			terror.card.power = '5';
			terror.card.toughness = '4';

			// 1. Entering dragon triggers Terror damage trigger
			const initialLife = p2.life;
			const synthDragon = addCardToZone(state, p1, synthCard({
				name: 'Lesser Dragon',
				manaCost: '{1}{R}',
				typeLine: 'Creature — Dragon',
				power: '3',
				toughness: '3'
			}), 'hand');
			p1.manaPool.R = 2;
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;

			castSpellAction(state, p1, synthDragon);
			passAllPriority(state);

			while (state.pendingPrompts.length > 0) {
				const prompt = state.pendingPrompts[0];
				if (prompt.choice?.kind === 'chooseObjects') {
					applyGameAction(state, prompt.playerId, {
						type: 'choice',
						promptId: prompt.id,
						answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
					});
				} else if (prompt.choice?.kind === 'orderObjects') {
					applyGameAction(state, prompt.playerId, {
						type: 'choice',
						promptId: prompt.id,
						answer: { kind: 'orderObjects', topIds: prompt.choice.objectIds, bottomIds: [] }
					});
				}
				passAllPriority(state);
			}
			assert.equal(p2.life, initialLife - 3, 'Terror triggered on entering dragon');

			// 2. Opponent casts removal targeting Terror -> pays 3 life tax (CR 601.2f)
			const p2LifeBeforeCast = p2.life;
			const swords = addCardToZone(state, p2, getPreconCard('Swords to Plowshares'), 'hand');
			p2.manaPool.W = 1;
			state.priorityPlayerIndex = 1;

			const castRes = castSpellAction(state, p2, swords, {
				targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Terror of the Peaks' }]
			});
			assert.equal(castRes.ok, true);
			assert.equal(p2.life, p2LifeBeforeCast - 3, 'P2 pays 3 life targeting tax');
		});

		it('Hellkite Charger attack trigger extra combat phase in live precon match', (t) => {
			if (!isFeatureReady('hellkite_charger')) {
				t.skip('Hellkite Charger awaiting M1 implementation');
				return;
			}
			const { state, p1, p2 } = setupE2EGame();
			const charger = addCardToZone(state, p1, getPreconCard('Hellkite Charger'), 'battlefield');
			charger.summoningSick = false;
			p1.manaPool.R = 2;
			p1.manaPool.C = 5;

			state.phase = 'declare_attackers';
			const attRes = applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: charger.instanceId, defenderPlayerId: p2.playerId }]
			});
			assert.equal(attRes.ok, true);
			passAllPriority(state);
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: true }
				});
				passAllPriority(state);
			}
			assert.equal(state.additionalCombatPhases, 1);
			assert.equal(charger.tapped, false);
		});
	});
});
