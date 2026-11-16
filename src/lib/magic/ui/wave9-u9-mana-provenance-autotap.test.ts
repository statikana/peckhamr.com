import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { noteLayerInputsChanged } from '../runtime/layerCache.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';
import {
	computeAbilityAutoTapPreview,
	computeSpellAutoTapPreview,
	previewAbilityAutoTap,
	previewSpellAutoTap
} from './autoTapPreview.ts';
import { buildBoardViewModel, formatCommanderTaxDisplay } from './boardViewModel.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `u9_synth_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: 'https://example.invalid/card.jpg',
		artCropUrl: 'https://example.invalid/crop.jpg',
		rarity: 'rare',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function makeSeat(i: number, isBot: boolean): LobbySeat {
	const deck = PRECON_DECKS[i];
	return {
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `Player ${i + 1}`,
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

function createTestBoard(): { state: GameState; p1: PlayerGameState; p2: PlayerGameState } {
	const seats = [makeSeat(0, false), makeSeat(1, false)];
	const state = createInitialGameState(
		'U9TEST',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		const res = applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		assert.equal(res.ok, true, res.error ?? '');
	}
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.library = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		p.restrictedMana = {};
		p.landsPlayedThisTurn = 0;
		p.maxLandsPerTurn = 1;
	}
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.stack = [];
	state.pendingPrompts = [];
	noteLayerInputsChanged(state);
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library' | 'command'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(
		card,
		player.playerId,
		zone,
		zone === 'command',
		false,
		state.nextTimestamp
	);
	inst.summoningSick = false;
	player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

const BASIC_FOREST = synthCard({
	name: 'Forest',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Forest',
	oracleText: '{T}: Add {G}.'
});

const BASIC_PLAINS = synthCard({
	name: 'Plains',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Plains',
	oracleText: '{T}: Add {W}.'
});

const BASIC_ISLAND = synthCard({
	name: 'Island',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Island',
	oracleText: '{T}: Add {U}.'
});

const BASIC_MOUNTAIN = synthCard({
	name: 'Mountain',
	manaCost: '',
	cmc: 0,
	typeLine: 'Basic Land — Mountain',
	oracleText: '{T}: Add {R}.'
});

describe('Wave 9 Track U9: Auto-Tap Provenance Immutability, Mana Provenance Telemetry, Linked Exile, & Commander Life Tax', () => {
	describe('U9.1 autoTapPreview Provenance Immutability, Spend Restrictions, Multipliers, & Top-of-Library Preview', () => {
		it('never mutates snowManaByColor, creatureManaByColor, basicLandManaByColor, treasureManaByColor, treasureManaInPool, or manaRiders during spell and ability previews', () => {
			const { state, p1 } = createTestBoard();

			p1.manaPool = { W: 1, U: 1, B: 0, R: 1, G: 1, C: 0 };
			p1.snowManaByColor = { U: 1 };
			p1.creatureManaByColor = { G: 1 };
			p1.basicLandManaByColor = { W: 1 };
			p1.treasureManaByColor = { R: 1 };
			p1.treasureManaInPool = 1;
			p1.manaRiders = [
				{
					id: 'rider_existing_1',
					color: 'G',
					sourceInstanceId: 'ancestry_src',
					sourceCard: BASIC_FOREST,
					condition: { sharesCreatureTypeWithCommander: true },
					scryAmount: 1
				}
			];

			const ancestryLand = putInZone(
				state,
				p1,
				synthCard({
					name: 'Ancestral Grove',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText:
						'{T}: Add {G}. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1.'
				}),
				'battlefield'
			);
			const treasureToken = putInZone(
				state,
				p1,
				synthCard({
					name: 'Treasure',
					manaCost: '',
					cmc: 0,
					typeLine: 'Token Artifact — Treasure',
					oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.'
				}),
				'battlefield'
			);
			treasureToken.isToken = true;

			const spellInHand = putInZone(
				state,
				p1,
				synthCard({
					name: 'Prismatic Verdict',
					manaCost: '{2}{W}{U}{R}{G}',
					cmc: 6,
					typeLine: 'Sorcery',
					oracleText: 'Draw two cards.',
					colors: ['W', 'U', 'R', 'G'],
					colorIdentity: ['W', 'U', 'R', 'G']
				}),
				'hand'
			);

			const activatedRelic = putInZone(
				state,
				p1,
				synthCard({
					name: 'Wayfarer Engine',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Artifact',
					oracleText: '{3}{G}: Draw a card.'
				}),
				'battlefield'
			);

			const cmdIdentity = getPlayerCommanderIdentity(p1);
			const drawAb = getEffectiveActivatedAbilities(state, p1, activatedRelic, cmdIdentity).find(
				(ab) => !ab.isManaAbility
			);
			assert.ok(drawAb, 'Expected non-mana activated ability on Wayfarer Engine');

			const beforeSnapshot = JSON.stringify(state);

			const spellPreview = computeSpellAutoTapPreview(state, p1.playerId, spellInHand.instanceId);
			assert.equal(spellPreview.canAutoTap, true);
			assert.deepEqual(
				new Set(spellPreview.tappedPermanentIds),
				new Set([ancestryLand.instanceId, treasureToken.instanceId])
			);
			assert.equal(
				JSON.stringify(state),
				beforeSnapshot,
				'computeSpellAutoTapPreview must leave live GameState 100% untouched'
			);

			const abPreview = computeAbilityAutoTapPreview(
				state,
				p1.playerId,
				activatedRelic.instanceId,
				drawAb
			);
			assert.equal(abPreview.canAutoTap, true);
			assert.equal(
				JSON.stringify(state),
				beforeSnapshot,
				'computeAbilityAutoTapPreview must leave live GameState 100% untouched'
			);
			assert.equal(computeSpellAutoTapPreview, previewSpellAutoTap);
			assert.equal(computeAbilityAutoTapPreview, previewAbilityAutoTap);
		});

		it('enforces P20b manaSpendRestriction (creature, basicLand, xColors) and P20a tapForManaMultiplier', () => {
			const { state, p1 } = createTestBoard();

			// 1. Creature-only mana spend restriction
			const creatureOnlySpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Primal Invocation',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Beast',
					power: '3',
					toughness: '3',
					colors: ['G'],
					colorIdentity: ['G'],
					oracleText: 'Spend only mana produced by creatures to cast this spell.'
				}),
				'hand'
			);
			const nonCreatureForest1 = putInZone(state, p1, BASIC_FOREST, 'battlefield');
			const nonCreatureForest2 = putInZone(state, p1, BASIC_FOREST, 'battlefield');

			const blockedByLands = previewSpellAutoTap(state, p1.playerId, creatureOnlySpell.instanceId);
			assert.equal(
				blockedByLands.canAutoTap,
				false,
				'Non-creature lands cannot pay a creature-mana-only spell'
			);

			const elfDork1 = putInZone(
				state,
				p1,
				synthCard({
					name: 'Sylvan Channeler',
					manaCost: '{G}',
					cmc: 1,
					typeLine: 'Creature — Elf Druid',
					power: '1',
					toughness: '1',
					colors: ['G'],
					colorIdentity: ['G'],
					oracleText: '{T}: Add {G}.'
				}),
				'battlefield'
			);
			const elfDork2 = putInZone(
				state,
				p1,
				synthCard({
					name: 'Canopy Mystic',
					manaCost: '{G}',
					cmc: 1,
					typeLine: 'Creature — Elf Druid',
					power: '1',
					toughness: '1',
					colors: ['G'],
					colorIdentity: ['G'],
					oracleText: '{T}: Add {G}.'
				}),
				'battlefield'
			);

			const paidByDorks = previewSpellAutoTap(state, p1.playerId, creatureOnlySpell.instanceId);
			assert.equal(paidByDorks.canAutoTap, true);
			assert.deepEqual(
				new Set(paidByDorks.tappedPermanentIds),
				new Set([elfDork1.instanceId, elfDork2.instanceId])
			);
			assert.equal(paidByDorks.tappedPermanentIds.includes(nonCreatureForest1.instanceId), false);
			assert.equal(paidByDorks.tappedPermanentIds.includes(nonCreatureForest2.instanceId), false);

			// 2. Basic-land-only mana spend restriction
			p1.battlefield = [];
			noteLayerInputsChanged(state);
			const basicOnlySpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Pureland Decree',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Instant',
					colors: ['W'],
					colorIdentity: ['W'],
					oracleText: 'Spend only mana produced by basic lands to cast this spell.\nGain 4 life.'
				}),
				'hand'
			);
			putInZone(
				state,
				p1,
				synthCard({
					name: 'alabaster_shrine',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: '{T}: Add {W}.'
				}),
				'battlefield'
			);
			putInZone(
				state,
				p1,
				synthCard({
					name: 'marble_obelisk',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Artifact',
					oracleText: '{T}: Add {W}.'
				}),
				'battlefield'
			);
			assert.equal(
				previewSpellAutoTap(state, p1.playerId, basicOnlySpell.instanceId).canAutoTap,
				false
			);

			const plains1 = putInZone(state, p1, BASIC_PLAINS, 'battlefield');
			const plains2 = putInZone(state, p1, BASIC_PLAINS, 'battlefield');
			const basicPreview = previewSpellAutoTap(state, p1.playerId, basicOnlySpell.instanceId);
			assert.equal(basicPreview.canAutoTap, true);
			assert.deepEqual(
				new Set(basicPreview.tappedPermanentIds),
				new Set([plains1.instanceId, plains2.instanceId])
			);

			// 3. X-color spend restriction ("Spend only red mana on X.")
			p1.battlefield = [];
			noteLayerInputsChanged(state);
			const redXSpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Crimson Torment',
					manaCost: '{X}{R}',
					cmc: 1,
					typeLine: 'Sorcery',
					colors: ['R'],
					colorIdentity: ['R'],
					oracleText: 'Spend only red mana on X.\nCrimson Torment deals X damage to any target.'
				}),
				'hand'
			);
			const mtn1 = putInZone(state, p1, BASIC_MOUNTAIN, 'battlefield');
			const nonRedDual = synthCard({
				name: 'Misty Woodland',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText: '{T}: Add {U} or {G}.'
			});
			putInZone(state, p1, nonRedDual, 'battlefield');
			putInZone(state, p1, nonRedDual, 'battlefield');

			assert.equal(
				previewSpellAutoTap(state, p1.playerId, redXSpell.instanceId, undefined, { xValue: 2 })
					.canAutoTap,
				false,
				'Non-red lands must not satisfy red-only X mana requirement'
			);

			const mtn2 = putInZone(state, p1, BASIC_MOUNTAIN, 'battlefield');
			const mtn3 = putInZone(state, p1, BASIC_MOUNTAIN, 'battlefield');
			const redXPreview = previewSpellAutoTap(state, p1.playerId, redXSpell.instanceId, undefined, {
				xValue: 2
			});
			assert.equal(redXPreview.canAutoTap, true);
			assert.deepEqual(
				new Set(redXPreview.tappedPermanentIds),
				new Set([mtn1.instanceId, mtn2.instanceId, mtn3.instanceId])
			);

			// 4. P20a tapForManaMultiplier (triple mana per tap -> single Forest pays {2}{G})
			p1.battlefield = [];
			noteLayerInputsChanged(state);
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Verdant Tripler',
					manaCost: '{4}{G}{G}{G}',
					cmc: 7,
					typeLine: 'Enchantment',
					oracleText:
						'If you tap a permanent for mana, it produces three times as much of that mana instead.'
				}),
				'battlefield'
			);
			const f1 = putInZone(state, p1, BASIC_FOREST, 'battlefield');
			putInZone(state, p1, BASIC_FOREST, 'battlefield');
			putInZone(state, p1, BASIC_FOREST, 'battlefield');
			const threeDrop = putInZone(
				state,
				p1,
				synthCard({
					name: 'Timberwarden',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Treefolk',
					power: '3',
					toughness: '4',
					colors: ['G'],
					colorIdentity: ['G'],
					oracleText: ''
				}),
				'hand'
			);
			const multPreview = previewSpellAutoTap(state, p1.playerId, threeDrop.instanceId);
			assert.equal(multPreview.canAutoTap, true);
			assert.equal(
				multPreview.tappedPermanentIds.length,
				1,
				'With a 3x tap multiplier, tapping a single Forest must pay {2}{G}'
			);
			assert.equal(multPreview.tappedPermanentIds[0], f1.instanceId);
		});

		it('previews top-of-library castable spells (CR 401.5) without cloning the rest of the library or mutating state', () => {
			const { state, p1 } = createTestBoard();

			putInZone(
				state,
				p1,
				synthCard({
					name: 'Chronicle Sight',
					manaCost: '{2}{U}{U}',
					cmc: 4,
					typeLine: 'Enchantment',
					oracleText:
						'Play with the top card of your library revealed.\nYou may play lands and cast spells from the top of your library.'
				}),
				'battlefield'
			);
			const isl1 = putInZone(state, p1, BASIC_ISLAND, 'battlefield');
			const isl2 = putInZone(state, p1, BASIC_ISLAND, 'battlefield');

			const topSpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Aether Insight',
					manaCost: '{1}{U}',
					cmc: 2,
					typeLine: 'Instant',
					colors: ['U'],
					colorIdentity: ['U'],
					oracleText: 'Draw a card.'
				}),
				'library'
			);
			for (let i = 0; i < 80; i++) {
				putInZone(state, p1, BASIC_ISLAND, 'library');
			}

			const vm = buildBoardViewModel(state, p1.playerId);
			assert.ok(vm.topOfLibraryView);
			assert.equal(vm.topOfLibraryView.topCard?.instanceId, topSpell.instanceId);
			assert.equal(vm.topOfLibraryView.libraryCastOptions.length, 1);

			const beforeJson = JSON.stringify(state);
			// Warm up JIT once, then measure average preview latency across 20 runs
			const firstPreview = previewSpellAutoTap(
				state,
				p1.playerId,
				topSpell.instanceId,
				vm.topOfLibraryView.libraryCastOptions[0]
			);
			assert.equal(firstPreview.canAutoTap, true);
			assert.deepEqual(
				new Set(firstPreview.tappedPermanentIds),
				new Set([isl1.instanceId, isl2.instanceId])
			);
			assert.equal(JSON.stringify(state), beforeJson);

			for (let warm = 0; warm < 5; warm++) {
				previewSpellAutoTap(
					state,
					p1.playerId,
					topSpell.instanceId,
					vm.topOfLibraryView.libraryCastOptions[0]
				);
			}
			const t0 = performance.now();
			const iterations = 20;
			for (let guard = 0; guard < iterations; guard++) {
				const p = previewSpellAutoTap(
					state,
					p1.playerId,
					topSpell.instanceId,
					vm.topOfLibraryView.libraryCastOptions[0]
				);
				assert.equal(p.canAutoTap, true);
			}
			const avgMs = (performance.now() - t0) / iterations;
			const budgetMs = process.env.MAGIC_LAYER_CACHE_CHECK === '1' ? 50 : 10;
			assert.ok(
				avgMs < budgetMs,
				`Expected fast sub-frame top-of-library preview (< ${budgetMs}ms), got ${avgMs.toFixed(3)}ms`
			);
		});
	});

	describe('U9.2 PlayerStatusView Mana Source Provenance Telemetry (CR 106.6)', () => {
		it('projects clamped creature, basic land, and reconciled Treasure mana totals and per-color maps', () => {
			const { state, p1 } = createTestBoard();

			p1.manaPool = { W: 1, U: 0, B: 0, R: 2, G: 3, C: 0 };
			p1.creatureManaByColor = { G: 2, B: 4 }; // B=4 exceeds manaPool.B=0 -> clamped out
			p1.basicLandManaByColor = { W: 1, G: 1 };
			p1.treasureManaByColor = { R: 1 };
			p1.treasureManaInPool = 2;

			const vm = buildBoardViewModel(state, p1.playerId);
			const st = vm.playerStatusesById[p1.playerId];
			assert.equal(st.creatureManaTotal, 2);
			assert.deepEqual(st.creatureManaByColor, { G: 2 });
			assert.equal(st.basicLandManaTotal, 2);
			assert.deepEqual(st.basicLandManaByColor, { W: 1, G: 1 });
			assert.equal(st.treasureManaTotal, 2);
			assert.deepEqual(st.treasureManaByColor, { R: 1 });

			// Single-color pool with scalar treasureManaInPool infers color cleanly
			p1.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 };
			delete p1.creatureManaByColor;
			delete p1.basicLandManaByColor;
			delete p1.treasureManaByColor;
			p1.treasureManaInPool = 2;
			const stSingle = buildBoardViewModel(state, p1.playerId).playerStatusesById[p1.playerId];
			assert.equal(stSingle.creatureManaTotal, 0);
			assert.equal(stSingle.basicLandManaTotal, 0);
			assert.equal(stSingle.treasureManaTotal, 2);
			assert.deepEqual(stSingle.treasureManaByColor, { R: 2 });

			// Empty pool clamps stale provenance down to 0
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			p1.creatureManaByColor = { G: 3 };
			p1.treasureManaInPool = 3;
			const stEmpty = buildBoardViewModel(state, p1.playerId).playerStatusesById[p1.playerId];
			assert.equal(stEmpty.creatureManaTotal, 0);
			assert.deepEqual(stEmpty.creatureManaByColor, {});
			assert.equal(stEmpty.treasureManaTotal, 0);
			assert.deepEqual(stEmpty.treasureManaByColor, {});
		});
	});

	describe('U9.3 Linked-Exile PermanentView Badges & CR 406.3 Face-Down Exile Secrecy', () => {
		it('links exiled cards matching sourceObjectVersion and masks hidden face-down exiled cards per viewerId', () => {
			const { state, p1, p2 } = createTestBoard();

			const vaultPerm = putInZone(
				state,
				p1,
				synthCard({
					name: 'Containment Vault',
					manaCost: '{2}{W}',
					cmc: 3,
					typeLine: 'Artifact',
					oracleText: ''
				}),
				'battlefield'
			);
			vaultPerm.objectVersion = 1;

			const faceUpExiled = putInZone(
				state,
				p2,
				synthCard({
					name: 'Sunblade Knight',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human Knight'
				}),
				'exile'
			);
			faceUpExiled.exiledBy = {
				sourceInstanceId: vaultPerm.instanceId,
				sourceObjectVersion: 1
			};

			const secretFaceDownExiled = putInZone(
				state,
				p2,
				synthCard({
					name: 'Top Secret Spell',
					manaCost: '{3}{U}{U}',
					cmc: 5,
					typeLine: 'Instant'
				}),
				'exile'
			);
			secretFaceDownExiled.isFaceDown = true;
			secretFaceDownExiled.knownToPlayerIds = [p1.playerId];
			secretFaceDownExiled.exiledBy = {
				sourceInstanceId: vaultPerm.instanceId,
				sourceObjectVersion: 1
			};

			// Viewer p1 knows the face-down card
			const vmP1 = buildBoardViewModel(state, p1.playerId);
			const pvForP1 = vmP1.permanentsById[vaultPerm.instanceId];
			assert.equal(pvForP1.linkedExileCount, 2);
			assert.deepEqual(pvForP1.linkedExileLabels, ['Sunblade Knight', 'Top Secret Spell']);

			// Viewer p2 is NOT in knownToPlayerIds -> must see 'Face-down card' (CR 406.3)
			const vmP2 = buildBoardViewModel(state, p2.playerId);
			const pvForP2 = vmP2.permanentsById[vaultPerm.instanceId];
			assert.equal(pvForP2.linkedExileCount, 2);
			assert.deepEqual(pvForP2.linkedExileLabels, ['Sunblade Knight', 'Face-down card']);
			assert.equal(
				pvForP2.linkedExileLabels.some((lbl) => lbl.includes('Top Secret Spell')),
				false,
				'Must never leak hidden face-down exiled card names to unauthorized viewers'
			);

			// CR 400.7: Bumping vaultPerm.objectVersion severs links to previous objectVersion=1 cards
			vaultPerm.objectVersion = 2;
			noteLayerInputsChanged(state);
			const vmBlinked = buildBoardViewModel(state, p1.playerId);
			assert.equal(vmBlinked.permanentsById[vaultPerm.instanceId].linkedExileCount, 0);
			assert.deepEqual(vmBlinked.permanentsById[vaultPerm.instanceId].linkedExileLabels, []);
		});
	});

	describe('U9.4 Commander-Tax-As-Life (CR 903.8), Layer 6 Silencing, WeakMap Cache Invalidation, & UI Purity', () => {
		it('projects commanderTaxAsLifePerCast when active and clears it when silenced in Layer 6', () => {
			const { state, p1, p2 } = createTestBoard();

			const duskAngelCard = synthCard({
				name: 'Shroud Seraph',
				manaCost: '{2}{W}{B}',
				cmc: 4,
				typeLine: 'Legendary Creature — Angel',
				power: '5',
				toughness: '5',
				colors: ['W', 'B'],
				colorIdentity: ['W', 'B'],
				canBeCommander: true,
				oracleText:
					"Rather than pay {2} for each previous time you've cast this spell from the command zone this game, pay 2 life that many times."
			});

			const seraphPerm = putInZone(state, p1, duskAngelCard, 'battlefield');
			const partnerCmd = p1.command[0];
			assert.ok(partnerCmd, 'Expected commander in p1 command zone');
			partnerCmd.commanderCastCount = 2;
			p1.commanderCastCounts[partnerCmd.instanceId] = 2;

			const vmActive = buildBoardViewModel(state, p1.playerId);
			assert.equal(vmActive.playerStatusesById[p1.playerId].commanderTaxAsLifePerCast, 2);
			assert.equal(vmActive.playerStatusesById[p2.playerId].commanderTaxAsLifePerCast, null);

			const activeTaxDisp = formatCommanderTaxDisplay(
				state,
				p1,
				partnerCmd,
				vmActive.playerStatusesById[p1.playerId].commanderTaxAsLifePerCast
			);
			assert.ok(activeTaxDisp);
			assert.equal(activeTaxDisp.isLifeTax, true);
			assert.equal(activeTaxDisp.totalLife, 4);
			assert.equal(activeTaxDisp.badgeText, 'Tax: 4 life');

			// Silence seraphPerm in Layer 6 ("loses all abilities")
			state.timedContinuousEffects = [
				{
					timestamp: 500,
					sourceName: 'Test Humility Pulse',
					controllerId: p2.playerId,
					expires: 'endOfTurn',
					affected: [
						{
							instanceId: seraphPerm.instanceId,
							objectVersion: seraphPerm.objectVersion ?? 1
						}
					],
					layer6: { removeAllAbilities: true }
				}
			];
			noteLayerInputsChanged(state);

			const vmSilenced = buildBoardViewModel(state, p1.playerId);
			assert.equal(
				vmSilenced.playerStatusesById[p1.playerId].commanderTaxAsLifePerCast,
				null,
				'Layer 6 ability removal must silence commanderTaxAsLifePerCast'
			);
			const fallbackTaxDisp = formatCommanderTaxDisplay(
				state,
				p1,
				partnerCmd,
				vmSilenced.playerStatusesById[p1.playerId].commanderTaxAsLifePerCast
			);
			assert.ok(fallbackTaxDisp);
			assert.equal(fallbackTaxDisp.isLifeTax, false);
			assert.equal(fallbackTaxDisp.badgeText, 'Tax: +4');

			// Also verify self-in-command-zone commander tax replacement (CR 113.6m / 903.8)
			const selfCmd = putInZone(state, p2, duskAngelCard, 'command');
			selfCmd.isCommander = true;
			selfCmd.commanderCastCount = 3;
			p2.commanderCastCounts[selfCmd.instanceId] = 3;
			const selfCmdTax = formatCommanderTaxDisplay(state, p2, selfCmd, null);
			assert.ok(selfCmdTax);
			assert.equal(selfCmdTax.isLifeTax, true);
			assert.equal(selfCmdTax.totalLife, 6);
			assert.equal(selfCmdTax.badgeText, 'Tax: 6 life');
		});

		it('invalidates the WeakMap BoardViewModel cache across every new U9 state field', () => {
			const { state, p1, p2 } = createTestBoard();
			p1.manaPool = { W: 2, U: 2, B: 2, R: 2, G: 2, C: 2 };
			const srcPerm = putInZone(
				state,
				p1,
				synthCard({
					name: 'Relic Cage',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Artifact',
					oracleText:
						"Rather than pay {2} for each previous time you've cast this spell from the command zone this game, pay 2 life that many times."
				}),
				'battlefield'
			);
			const exCard = putInZone(
				state,
				p2,
				synthCard({ name: 'Captured Relic', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
				'exile'
			);

			let prevModel = buildBoardViewModel(state, p1.playerId);
			assert.equal(buildBoardViewModel(state, p1.playerId), prevModel, 'Cache hit expected when unchanged');

			const assertInvalidates = (mutate: () => void, label: string) => {
				mutate();
				noteLayerInputsChanged(state);
				const nextModel = buildBoardViewModel(state, p1.playerId);
				assert.notEqual(nextModel, prevModel, `Expected WeakMap cache invalidation on ${label}`);
				prevModel = nextModel;
			};

			assertInvalidates(() => {
				p1.creatureManaByColor = { G: 1 };
			}, 'creatureManaByColor');
			assertInvalidates(() => {
				p1.basicLandManaByColor = { W: 1 };
			}, 'basicLandManaByColor');
			assertInvalidates(() => {
				p1.treasureManaByColor = { R: 1 };
			}, 'treasureManaByColor');
			assertInvalidates(() => {
				p1.treasureManaInPool = 2;
			}, 'treasureManaInPool');
			assertInvalidates(() => {
				exCard.exiledBy = {
					sourceInstanceId: srcPerm.instanceId,
					sourceObjectVersion: srcPerm.objectVersion ?? 1
				};
			}, 'exiledBy');
			assertInvalidates(() => {
				exCard.isFaceDown = true;
			}, 'exile isFaceDown');
			assertInvalidates(() => {
				exCard.knownToPlayerIds = [p1.playerId];
			}, 'exile knownToPlayerIds');
			assertInvalidates(() => {
				p1.commanderCastCounts['cmd_1'] = 1;
			}, 'commanderCastCounts');
			assertInvalidates(() => {
				state.timedContinuousEffects = [
					{
						timestamp: 777,
						sourceName: 'Test Effect',
						controllerId: p1.playerId,
						expires: 'endOfTurn',
						affected: [
							{
								instanceId: srcPerm.instanceId,
								objectVersion: srcPerm.objectVersion ?? 1
							}
						]
					}
				];
			}, 'timedContinuousEffects entry');
			assertInvalidates(() => {
				state.timedContinuousEffects![0].layer6 = { removeAllAbilities: true };
			}, 'in-place layer6.removeAllAbilities');
		});

		it('keeps ArenaTable and owned U9 UI files free of oracleText reads and forbidden keyword string literals', () => {
			const rootDir = path.resolve(import.meta.dirname, '..');
			const filesToScan = [
				path.join(rootDir, 'ArenaTable.svelte'),
				path.join(rootDir, 'ui', 'autoTapPreview.ts'),
				path.join(rootDir, 'ui', 'boardViewModel.ts'),
				path.join(rootDir, 'ui', 'PermanentCard.svelte'),
				path.join(rootDir, 'ui', 'CardInspector.svelte'),
				path.join(rootDir, 'ui', 'RightDock.svelte'),
				path.join(rootDir, 'ui', 'PlayerVitals.svelte'),
				path.join(rootDir, 'ui', 'OpponentPod.svelte'),
				path.join(rootDir, 'ui', 'CastOptionsModal.svelte')
			];

			const forbiddenQuotedKeywords = [
				'companion',
				'prototype',
				'regenerate',
				'monstrosity',
				'flagbearer',
				'soulbond',
				'haunt',
				'mutate',
				'escalate',
				'spree',
				'tiered',
				'renown',
				'epic',
				'storied',
				'suspect',
				'goad',
				'flying',
				'first strike',
				'double strike',
				'deathtouch',
				'lifelink',
				'menace',
				'trample',
				'vigilance',
				'reach',
				'hexproof',
				'indestructible',
				'shadow',
				'exalted',
				'decayed'
			];

			for (const filePath of filesToScan) {
				const src = fs.readFileSync(filePath, 'utf8');
				assert.equal(
					/\.oracleText\b/.test(src),
					false,
					`Expected zero .oracleText reads in ${path.basename(filePath)}`
				);
				const lower = src.toLowerCase();
				for (const kw of forbiddenQuotedKeywords) {
					assert.equal(
						lower.includes(`'${kw}'`) || lower.includes(`"${kw}"`),
						false,
						`Expected zero hardcoded '${kw}' string literals in ${path.basename(filePath)}`
					);
				}
			}
		});
	});
});
