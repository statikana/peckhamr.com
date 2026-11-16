import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getCastOptions,
	getEffectiveActivatedAbilities
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
	DUNGEON_ART_URI,
	EMBLEM_ART_URI,
	buildBoardViewModel,
	computeArrowSignature,
	extractCounterBadges,
	getRingAbilitiesForLevel
} from './boardViewModel.ts';
import {
	buildDeclareAttackersPayload,
	createEmptyCombatDraft,
	pruneStaleCombatDraft,
	retargetDraftAttackersToBattle,
	retargetDraftAttackersToPlaneswalker,
	retargetDraftAttackersToPlayer,
	toggleDraftAttacker
} from './combatController.ts';
import {
	beginAbilityTargeting,
	beginSpellTargeting,
	canClickTargetCandidate,
	computeMaxAffordableX,
	confirmCurrentSlot,
	confirmSlotDivisions,
	describeCurrentTargetSlot,
	stepBackToPreviousSlot,
	toggleOrAdvanceTarget
} from './targetingController.ts';

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	const id = `u5_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
		oracleId: id,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: 'https://example.invalid/card.jpg',
		artCropUrl: 'https://example.invalid/crop.jpg',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function makeSeat(i: number): LobbySeat {
	const deck = PRECON_DECKS[i];
	return {
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `Player ${i + 1}`,
		avatarUrl: '',
		isBot: false,
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
	const seats = [makeSeat(0), makeSeat(1)];
	const state = createInitialGameState(
		'U5HUD',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		delete p.snowManaByColor;
		p.restrictedMana = {};
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
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, false, false, state.nextTimestamp);
	inst.summoningSick = false;
	player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

describe('Wave 6 Track U5 — Designations HUD, Permanent Chrome, & CR 601.2d Allocation', () => {
	describe('Global & Per-Player Designations ViewModel (Day/Night, Initiative, Dungeon, Speed, City, Ring, Snow)', () => {
		it('surfaces Day/Night, Initiative, Active Dungeon room, Speed/Max Speed, Citys Blessing, Ring levels, and Snow {S} mana', () => {
			const { state, p1, p2 } = createTestBoard();

			// Global designations
			state.dayNight = 'night';
			state.spellsCastByActivePlayerThisTurn = 2;
			state.prevTurnSpellsCastByActivePlayer = 0;
			state.initiativePlayerId = p1.playerId;

			// P1 designations & Snow {S} mana pool
			p1.speed = 4;
			p1.hasCitysBlessing = true;
			p1.ringLevel = 3;
			p1.activeDungeon = { dungeonId: 'undercity', roomIndex: 0 };
			p1.completedDungeonNames = ['Lost Mine of Phandelver', 'Dungeon of the Mad Mage'];
			p1.manaPool = { W: 1, U: 2, B: 0, R: 0, G: 1, C: 0 };
			p1.snowManaByColor = { W: 1, U: 1 };

			const bearer = putInZone(
				state,
				p1,
				synthCard({
					name: 'Halfling Scout',
					typeLine: 'Creature — Halfling Scout',
					power: '1',
					toughness: '2'
				}),
				'battlefield'
			);
			p1.ringBearerId = bearer.instanceId;

			// P2 partial designations
			p2.speed = 2;
			p2.ringLevel = 1;

			const vm = buildBoardViewModel(state, p1.playerId);
			assert.equal(vm.dayNight, 'night');
			assert.equal(vm.spellsCastByActivePlayerThisTurn, 2);
			assert.equal(vm.prevTurnSpellsCastByActivePlayer, 0);
			assert.equal(vm.initiativePlayerId, p1.playerId);

			const s1 = vm.playerStatusesById[p1.playerId];
			assert.equal(s1.hasInitiative, true);
			assert.equal(s1.speed, 4);
			assert.equal(s1.isMaxSpeed, true);
			assert.equal(s1.hasCitysBlessing, true);
			assert.equal(s1.ringLevel, 3);
			assert.equal(s1.ringBearerId, bearer.instanceId);
			assert.equal(s1.ringAbilities.length, 3);
			assert.equal(getRingAbilitiesForLevel(4).length, 4);
			assert.equal(s1.snowManaTotal, 2);
			assert.equal(s1.snowManaByColor.W, 1);
			assert.equal(s1.snowManaByColor.U, 1);
			assert.equal(s1.activeDungeon?.dungeonId, 'undercity');
			assert.equal(s1.activeDungeon?.dungeonName, 'Undercity');
			assert.equal(s1.activeDungeon?.roomName, 'Secret Entrance');
			assert.ok((s1.activeDungeon?.roomEffectText.length ?? 0) > 0);
			assert.equal(s1.completedDungeonCount, 2);
			assert.deepEqual(s1.completedDungeonNames, [
				'Lost Mine of Phandelver',
				'Dungeon of the Mad Mage'
			]);

			const bearerView = vm.permanentsById[bearer.instanceId];
			assert.equal(bearerView.isRingBearer, true);

			const s2 = vm.playerStatusesById[p2.playerId];
			assert.equal(s2.hasInitiative, false);
			assert.equal(s2.speed, 2);
			assert.equal(s2.isMaxSpeed, false);
			assert.equal(s2.ringLevel, 1);
			assert.equal(s2.ringAbilities.length, 1);
			assert.equal(s2.snowManaTotal, 0);
		});

		it('separates Emblems and Dungeons from Commanders in command zone views without Commander tax or castability', () => {
			const { state, p1 } = createTestBoard();
			assert.ok(EMBLEM_ART_URI.startsWith('data:image/svg+xml'));
			assert.ok(DUNGEON_ART_URI.startsWith('data:image/svg+xml'));

			const emblem = putInZone(
				state,
				p1,
				synthCard({
					name: 'Elspeth Emblem',
					manaCost: '',
					cmc: 0,
					typeLine: 'Emblem',
					oracleText: 'Creatures you control get +2/+2 and have flying.',
					artCropUrl: ''
				}),
				'command'
			);
			emblem.isEmblem = true;

			const dungeonCard = putInZone(
				state,
				p1,
				synthCard({
					name: 'Undercity',
					manaCost: '',
					cmc: 0,
					typeLine: 'Dungeon',
					oracleText: '',
					artCropUrl: ''
				}),
				'command'
			);
			dungeonCard.isDungeon = true;

			p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
			const vm = buildBoardViewModel(state, p1.playerId);
			const s1 = vm.playerStatusesById[p1.playerId];

			assert.equal(s1.emblems.length, 1);
			assert.equal(s1.emblems[0].instanceId, emblem.instanceId);
			assert.equal(s1.dungeonCommandCards.length, 1);
			assert.equal(s1.dungeonCommandCards[0].instanceId, dungeonCard.instanceId);
			assert.equal(
				s1.commanders.some(
					(c) => c.instanceId === emblem.instanceId || c.instanceId === dungeonCard.instanceId
				),
				false,
				'Emblems and Dungeons must not be listed as Commanders'
			);
			assert.equal(vm.commandPlayabilityById[emblem.instanceId], false);
			assert.equal(vm.commandPlayabilityById[dungeonCard.instanceId], false);
		});
	});

	describe('Battles & Sieges (CR 310), Rooms (CR 709.5), and Preparation (CR 723)', () => {
		it('surfaces Battle defense counter badge, protectorName, CR 310.8b attackability, and end-to-end declare_attackers targeting', () => {
			const { state, p1, p2 } = createTestBoard();
			state.phase = 'declare_attackers';

			const attacker = putInZone(
				state,
				p1,
				synthCard({
					name: 'Vanguard Knight',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human Knight',
					power: '3',
					toughness: '3'
				}),
				'battlefield'
			);

			// Siege controlled by P1, protected by opponent P2 -> P1 CAN attack it! (CR 310.11b / CR 310.8b)
			const ownSiege = putInZone(
				state,
				p1,
				synthCard({
					name: 'Invasion of Ravnica',
					layout: 'transform',
					manaCost: '{5}',
					cmc: 5,
					typeLine: 'Battle — Siege',
					defense: '4',
					oracleText: 'When this Siege enters, exile target nonland permanent an opponent controls.',
					backFace: {
						name: 'Guildpact Paragon',
						manaCost: '',
						typeLine: 'Artifact Creature — Construct',
						oracleText: '',
						power: '5',
						toughness: '5',
						imageUrl: ''
					}
				}),
				'battlefield'
			);
			ownSiege.counters.defense = 4;
			ownSiege.protectorId = p2.playerId;

			// Siege controlled by P2, protected by P1 -> P1 CANNOT attack a battle they protect! (CR 310.8b)
			const viewerProtectedBattle = putInZone(
				state,
				p2,
				synthCard({
					name: 'Invasion of Zendikar',
					typeLine: 'Battle — Siege',
					defense: '3'
				}),
				'battlefield'
			);
			viewerProtectedBattle.counters.defense = 3;
			viewerProtectedBattle.protectorId = p1.playerId;
			noteLayerInputsChanged(state);

			const badges = extractCounterBadges(ownSiege.counters);
			assert.equal(badges.length, 1);
			assert.equal(badges[0].badgeKind, 'defense');
			assert.equal(badges[0].label, 'Def:4');

			const vm = buildBoardViewModel(state, p1.playerId);
			const ownSiegeView = vm.permanentsById[ownSiege.instanceId];
			const viewerProtectedView = vm.permanentsById[viewerProtectedBattle.instanceId];

			assert.equal(ownSiegeView.isBattle, true);
			assert.equal(ownSiegeView.protectorId, p2.playerId);
			assert.equal(ownSiegeView.protectorName, p2.username);
			assert.equal(ownSiegeView.canBeAttackedAsBattle, true);

			assert.equal(viewerProtectedView.isBattle, true);
			assert.equal(viewerProtectedView.protectorId, p1.playerId);
			assert.equal(
				viewerProtectedView.canBeAttackedAsBattle,
				false,
				'CR 310.8b: A battle protector cannot attack that battle'
			);

			// Draft attacker -> retarget to Battle -> verify mutual exclusion with planeswalker -> dispatch declare_attackers
			let draft = createEmptyCombatDraft();
			draft = toggleDraftAttacker(draft, vm.permanentsById[attacker.instanceId], state, p1.playerId);
			assert.equal(draft.draftAttackers[attacker.instanceId], p2.playerId);

			// Retargeting to viewer-protected battle is rejected (no-op)
			const rejectedDraft = retargetDraftAttackersToBattle(draft, viewerProtectedView, p1.playerId);
			assert.equal(rejectedDraft, draft);

			// Retargeting to opponent-protected Siege succeeds even though P1 controls the Siege
			draft = retargetDraftAttackersToBattle(draft, ownSiegeView, p1.playerId);
			assert.equal(draft.draftAttackerBattles[attacker.instanceId], ownSiege.instanceId);
			assert.equal(draft.draftAttackerWalkers[attacker.instanceId] ?? null, null);
			assert.equal(draft.draftAttackers[attacker.instanceId], p2.playerId);

			// Arrow signature reflects Battle target
			const sigWithBattle = computeArrowSignature({
				gameState: state,
				draftAttackers: draft.draftAttackers,
				draftAttackerWalkers: draft.draftAttackerWalkers,
				draftAttackerBattles: draft.draftAttackerBattles,
				draftBlockers: {}
			});
			assert.ok(sigWithBattle.includes(ownSiege.instanceId));

			// Pruning keeps valid Battle target
			const pruned = pruneStaleCombatDraft(draft, state, p1.playerId);
			assert.equal(pruned.draftAttackerBattles[attacker.instanceId], ownSiege.instanceId);

			const payload = buildDeclareAttackersPayload(draft);
			assert.deepEqual(payload, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: attacker.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: null,
						defenderBattleId: ownSiege.instanceId
					}
				]
			});

			// Engine end-to-end validation of declare_attackers against the Siege!
			const engineRes = applyGameAction(state, p1.playerId, payload);
			assert.equal(engineRes.ok, true, engineRes.error ?? '');
			assert.equal(state.combat.attackers[0]?.defenderBattleId, ownSiege.instanceId);

			// Also verify retargeting back to player or planeswalker clears draftAttackerBattles
			const oppWalker = putInZone(
				state,
				p2,
				synthCard({
					name: 'Jace Mirror',
					typeLine: 'Legendary Planeswalker — Jace',
					loyalty: '3'
				}),
				'battlefield'
			);
			oppWalker.counters.loyalty = 3;
			noteLayerInputsChanged(state);
			const vm2 = buildBoardViewModel(state, p1.playerId);
			const walkerDraft = retargetDraftAttackersToPlaneswalker(
				draft,
				vm2.permanentsById[oppWalker.instanceId],
				p2.playerId,
				p1.playerId
			);
			assert.equal(walkerDraft.draftAttackerBattles[attacker.instanceId] ?? null, null);
			assert.equal(walkerDraft.draftAttackerWalkers[attacker.instanceId], oppWalker.instanceId);

			const playerDraft = retargetDraftAttackersToPlayer(draft, p2, p1.playerId);
			assert.equal(playerDraft.draftAttackerBattles[attacker.instanceId] ?? null, null);
		});

		it('surfaces Room left/right door lock status and unlockable door options', () => {
			const { state, p1 } = createTestBoard();
			const roomCard = synthCard({
				name: 'Study Hall // Grand Archive',
				layout: 'split',
				manaCost: '{1}{U} // {2}{U}',
				cmc: 5,
				typeLine: 'Enchantment — Room // Enchantment — Room',
				oracleText: 'When you unlock this door, draw a card.\n//\nCreatures you control get +1/+1.',
				faces: [
					{
						name: 'Study Hall',
						manaCost: '{1}{U}',
						cmc: 2,
						typeLine: 'Enchantment — Room',
						oracleText: 'When you unlock this door, draw a card.',
						colors: ['U'],
						imageUrl: '',
						artCropUrl: ''
					},
					{
						name: 'Grand Archive',
						manaCost: '{2}{U}',
						cmc: 3,
						typeLine: 'Enchantment — Room',
						oracleText: 'Creatures you control get +1/+1.',
						colors: ['U'],
						imageUrl: '',
						artCropUrl: ''
					}
				]
			});
			assert.equal(compileCard(roomCard).fullySupported, true);

			const roomPerm = putInZone(state, p1, roomCard, 'battlefield');
			roomPerm.unlockedFaces = [0];
			p1.manaPool = { W: 0, U: 3, B: 0, R: 0, G: 0, C: 0 };
			noteLayerInputsChanged(state);

			const vm = buildBoardViewModel(state, p1.playerId);
			const rView = vm.permanentsById[roomPerm.instanceId];
			assert.deepEqual(rView.roomDoors, [
				{ faceIndex: 0, name: 'Study Hall', manaCost: '{1}{U}', unlocked: true },
				{ faceIndex: 1, name: 'Grand Archive', manaCost: '{2}{U}', unlocked: false }
			]);
			assert.equal(rView.actableSummary.unlockableFaces.length, 1);
			assert.equal(rView.actableSummary.unlockableFaces[0].faceIndex, 1);
			assert.equal(rView.actableSummary.isActable, true);

			// Unlock door 1 via engine action and verify both doors show unlocked
			const unlockRes = applyGameAction(state, p1.playerId, {
				type: 'unlock_room_door',
				instanceId: roomPerm.instanceId,
				faceIndex: 1
			});
			assert.equal(unlockRes.ok, true, unlockRes.error ?? '');
			const vmAfter = buildBoardViewModel(state, p1.playerId);
			assert.equal(
				vmAfter.permanentsById[roomPerm.instanceId].roomDoors.every((d) => d.unlocked),
				true
			);
		});

		it('surfaces Prepared permanents, prevents single-tap mana bypass, and casts Preparation copy end-to-end', () => {
			const { state, p1, p2 } = createTestBoard();
			const prepCard = synthCard({
				name: 'Runescribe Mentor // Rune Bolt',
				layout: 'prepare',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Wizard // Sorcery',
				oracleText: '~ enters prepared.\n{T}: Add {R}.',
				power: '2',
				toughness: '2',
				faces: [
					{
						name: 'Runescribe Mentor',
						manaCost: '{1}{R}',
						cmc: 2,
						typeLine: 'Creature — Wizard',
						oracleText: '~ enters prepared.\n{T}: Add {R}.',
						colors: ['R'],
						power: '2',
						toughness: '2',
						imageUrl: '',
						artCropUrl: ''
					},
					{
						name: 'Rune Bolt',
						manaCost: '{R}',
						cmc: 1,
						typeLine: 'Sorcery',
						oracleText: 'Rune Bolt deals 2 damage to any target.',
						colors: ['R'],
						imageUrl: '',
						artCropUrl: ''
					}
				]
			});
			assert.equal(compileCard(prepCard).fullySupported, true);

			const prepPerm = putInZone(state, p1, prepCard, 'battlefield');
			prepPerm.isPrepared = true;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 };
			noteLayerInputsChanged(state);

			const vm = buildBoardViewModel(state, p1.playerId);
			const pView = vm.permanentsById[prepPerm.instanceId];
			assert.equal(pView.isPrepared, true);
			assert.equal(pView.actableSummary.preparationCopyFaceName, 'Rune Bolt');
			assert.equal(pView.actableSummary.preparationCopyManaCost, '{R}');
			assert.ok(pView.actableSummary.preparationCopyOption);
			assert.equal(pView.actableSummary.isActable, true);
			assert.equal(
				pView.actableSummary.isSingleTapManaOnly,
				false,
				'Prepared permanent with a mana ability must open AbilityMenuModal instead of auto-tapping for mana'
			);

			// Targeting flow for Preparation copy from battlefield emits cast_preparation_copy
			const opt = pView.actableSummary.preparationCopyOption!;
			const started = beginSpellTargeting({
				inst: prepPerm,
				fromZone: 'battlefield',
				xValue: 0,
				option: opt,
				gameState: state,
				actorId: p1.playerId
			});
			assert.equal(started.status, 'targeting');
			if (started.status !== 'targeting') return;

			const picked = toggleOrAdvanceTarget(state, p1.playerId, started.session, {
				kind: 'player',
				id: p2.playerId,
				label: p2.username
			});
			assert.equal(picked.status, 'ready_to_submit');
			if (picked.status !== 'ready_to_submit') return;
			assert.deepEqual(picked.payload, {
				type: 'cast_preparation_copy',
				instanceId: prepPerm.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			});

			const castRes = applyGameAction(state, p1.playerId, picked.payload);
			assert.equal(castRes.ok, true, castRes.error ?? '');
			assert.equal(prepPerm.isPrepared, false);
		});
	});

	describe('CR 601.2d Divided Damage & Distributed Counters Targeting Flow', () => {
		it('caps maxTargets by divideTotal, auto-allocates 1-target and N-for-N cases, and validates multi-target splits', () => {
			const { state, p1, p2 } = createTestBoard();
			p1.manaPool = { W: 0, U: 0, B: 0, R: 10, G: 10, C: 0 };

			const c1 = putInZone(
				state,
				p2,
				synthCard({
					name: 'goblin alpha',
					typeLine: 'Creature — Goblin',
					power: '2',
					toughness: '3'
				}),
				'battlefield'
			);
			const c2 = putInZone(
				state,
				p2,
				synthCard({
					name: 'goblin beta',
					typeLine: 'Creature — Goblin',
					power: '2',
					toughness: '3'
				}),
				'battlefield'
			);
			const c3 = putInZone(
				state,
				p2,
				synthCard({
					name: 'goblin gamma',
					typeLine: 'Creature — Goblin',
					power: '2',
					toughness: '3'
				}),
				'battlefield'
			);

			// 1. Spell dealing 2 damage among 1, 2, or 3 targets -> CR 601.2d caps maxTargets to 2!
			const twoDmgThreeSpec = putInZone(
				state,
				p1,
				synthCard({
					name: 'Twin Spark',
					manaCost: '{1}{R}',
					cmc: 2,
					typeLine: 'Instant',
					oracleText: 'Twin Spark deals 2 damage divided as you choose among one, two, or three targets.'
				}),
				'hand'
			);
			const capStart = beginSpellTargeting({
				inst: twoDmgThreeSpec,
				fromZone: 'hand',
				option: getCastOptions(state, p1.playerId, twoDmgThreeSpec, 'hand')[0],
				gameState: state,
				actorId: p1.playerId
			});
			assert.equal(capStart.status, 'targeting');
			if (capStart.status !== 'targeting') return;
			assert.equal(capStart.session.currentRequirement.maxTargets, 2);
			assert.equal(capStart.session.currentDivideAmount, 2);

			// Selecting 2 targets for 2 damage auto-allocates 1 each without opening awaitingDivision!
			const sel1 = toggleOrAdvanceTarget(state, p1.playerId, capStart.session, {
				kind: 'permanent',
				id: c1.instanceId,
				label: c1.card.name
			});
			assert.equal(sel1.status, 'targeting');
			if (sel1.status !== 'targeting') return;
			const sel2 = toggleOrAdvanceTarget(state, p1.playerId, sel1.session, {
				kind: 'permanent',
				id: c2.instanceId,
				label: c2.card.name
			});
			assert.equal(sel2.status, 'ready_to_submit');
			if (sel2.status !== 'ready_to_submit') return;
			assert.equal(sel2.payload.type, 'cast_spell');
			if (sel2.payload.type === 'cast_spell') {
				assert.deepEqual(sel2.payload.targetDivisions, {
					[c1.instanceId]: 1,
					[c2.instanceId]: 1
				});
			}

			// 2. Spell dealing 3 damage among 1, 2, or 3 targets:
			//    - 1 target confirmed -> trivial { [c1]: 3 }
			//    - 2 targets confirmed -> transitions to awaitingDivision: true -> validates [2, 1] -> accepted by engine!
			const threeDmgSpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Triad Bolt',
					manaCost: '{2}{R}',
					cmc: 3,
					typeLine: 'Instant',
					oracleText: 'Triad Bolt deals 3 damage divided as you choose among one, two, or three targets.'
				}),
				'hand'
			);
			const threeOpt = getCastOptions(state, p1.playerId, threeDmgSpell, 'hand')[0];
			const start3 = beginSpellTargeting({
				inst: threeDmgSpell,
				fromZone: 'hand',
				option: threeOpt,
				gameState: state,
				actorId: p1.playerId
			});
			assert.equal(start3.status, 'targeting');
			if (start3.status !== 'targeting') return;

			const onePicked = toggleOrAdvanceTarget(state, p1.playerId, start3.session, {
				kind: 'permanent',
				id: c1.instanceId,
				label: c1.card.name
			});
			assert.equal(onePicked.status, 'targeting');
			if (onePicked.status !== 'targeting') return;

			// Confirming with 1 target auto-allocates all 3 damage immediately
			const singleConfirmed = confirmCurrentSlot(onePicked.session);
			assert.equal(singleConfirmed.status, 'ready_to_submit');
			if (singleConfirmed.status === 'ready_to_submit' && singleConfirmed.payload.type === 'cast_spell') {
				assert.deepEqual(singleConfirmed.payload.targetDivisions, { [c1.instanceId]: 3 });
			}

			// Picking a 2nd target and confirming enters awaitingDivision: true
			const twoPicked = toggleOrAdvanceTarget(state, p1.playerId, onePicked.session, {
				kind: 'permanent',
				id: c2.instanceId,
				label: c2.card.name
			});
			assert.equal(twoPicked.status, 'targeting');
			if (twoPicked.status !== 'targeting') return;

			const enterDiv = confirmCurrentSlot(twoPicked.session);
			assert.equal(enterDiv.status, 'targeting');
			if (enterDiv.status !== 'targeting') return;
			assert.equal(enterDiv.session.awaitingDivision, true);
			assert.ok(describeCurrentTargetSlot(enterDiv.session).includes('Distribute 3 damage among 2 targets'));
			assert.equal(
				canClickTargetCandidate(state, p1.playerId, enterDiv.session, {
					kind: 'permanent',
					id: c3.instanceId,
					label: c3.card.name
				}),
				false,
				'Board targets are locked while awaitingDivision is open'
			);

			// Stepping back from awaitingDivision returns to target selection on the same slot
			const steppedBack = stepBackToPreviousSlot(enterDiv.session);
			assert.equal(steppedBack.awaitingDivision, false);
			assert.equal(steppedBack.selectedTargets.length, 2);

			// Invalid divisions rejected (0 share, wrong sum, unknown target)
			assert.equal(
				confirmSlotDivisions(enterDiv.session, { [c1.instanceId]: 3, [c2.instanceId]: 0 }).status,
				'invalid'
			);
			assert.equal(
				confirmSlotDivisions(enterDiv.session, { [c1.instanceId]: 1, [c2.instanceId]: 1 }).status,
				'invalid'
			);
			assert.equal(
				confirmSlotDivisions(enterDiv.session, {
					[c1.instanceId]: 2,
					[c2.instanceId]: 1,
					[c3.instanceId]: 1
				}).status,
				'invalid'
			);

			// Valid [2, 1] split produces ready_to_submit and passes applyGameAction!
			const validSplit = confirmSlotDivisions(enterDiv.session, {
				[c1.instanceId]: 2,
				[c2.instanceId]: 1
			});
			assert.equal(validSplit.status, 'ready_to_submit');
			if (validSplit.status !== 'ready_to_submit') return;
			const applyRes = applyGameAction(state, p1.playerId, validSplit.payload);
			assert.equal(applyRes.ok, true, applyRes.error ?? '');
		});

		it('handles X-scaled counter distribution and activated ability targetDivisions', () => {
			const { state, p1 } = createTestBoard();
			p1.manaPool = { W: 0, U: 0, B: 0, R: 5, G: 5, C: 0 };

			const ally1 = putInZone(
				state,
				p1,
				synthCard({
					name: 'mossbear one',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const ally2 = putInZone(
				state,
				p1,
				synthCard({
					name: 'mossbear two',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);

			const xCountersSpell = putInZone(
				state,
				p1,
				synthCard({
					name: 'Canopy Bounty',
					manaCost: '{X}{G}',
					cmc: 1,
					typeLine: 'Sorcery',
					oracleText: 'Distribute X +1/+1 counters among any number of target creatures.'
				}),
				'hand'
			);
			const xOpt = getCastOptions(state, p1.playerId, xCountersSpell, 'hand')[0];
			assert.equal(
				computeMaxAffordableX({
					gameState: state,
					actorId: p1.playerId,
					inst: xCountersSpell,
					fromZone: 'hand',
					castOption: xOpt
				}),
				9
			);

			// At X = 0, divideAmount is 0 -> CR 601.2d submits immediately with 0 targets!
			const xZero = beginSpellTargeting({
				inst: xCountersSpell,
				fromZone: 'hand',
				xValue: 0,
				option: xOpt,
				gameState: state,
				actorId: p1.playerId
			});
			assert.equal(xZero.status, 'ready_to_submit');

			// At X = 4, picking 2 targets transitions to counters division
			const xFour = beginSpellTargeting({
				inst: xCountersSpell,
				fromZone: 'hand',
				xValue: 4,
				option: xOpt,
				gameState: state,
				actorId: p1.playerId
			});
			assert.equal(xFour.status, 'targeting');
			if (xFour.status !== 'targeting') return;
			assert.equal(xFour.session.currentDivideUnitLabel, 'counters');
			assert.equal(xFour.session.currentRequirement.maxTargets, 4);

			const t1 = toggleOrAdvanceTarget(state, p1.playerId, xFour.session, {
				kind: 'permanent',
				id: ally1.instanceId,
				label: ally1.card.name
			});
			assert.equal(t1.status, 'targeting');
			if (t1.status !== 'targeting') return;
			const t2 = toggleOrAdvanceTarget(state, p1.playerId, t1.session, {
				kind: 'permanent',
				id: ally2.instanceId,
				label: ally2.card.name
			});
			assert.equal(t2.status, 'targeting');
			if (t2.status !== 'targeting') return;
			const divSession = confirmCurrentSlot(t2.session);
			assert.equal(divSession.status, 'targeting');
			if (divSession.status !== 'targeting') return;
			assert.equal(divSession.session.awaitingDivision, true);

			const confirmedX = confirmSlotDivisions(divSession.session, {
				[ally1.instanceId]: 3,
				[ally2.instanceId]: 1
			});
			assert.equal(confirmedX.status, 'ready_to_submit');
			if (confirmedX.status !== 'ready_to_submit') return;
			assert.equal(applyGameAction(state, p1.playerId, confirmedX.payload).ok, true);

			// Activated ability with divided damage
			const arty = putInZone(
				state,
				p1,
				synthCard({
					name: 'Scatter Cannon',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Artifact',
					oracleText: '{1}, {T}: Scatter Cannon deals 3 damage divided as you choose among one, two, or three targets.'
				}),
				'battlefield'
			);
			const ab = getEffectiveActivatedAbilities(state, p1, arty)[0];
			assert.ok(ab);
			const abStart = beginAbilityTargeting({
				inst: arty,
				ability: ab,
				gameState: state,
				actorId: p1.playerId
			});
			assert.equal(abStart.status, 'targeting');
			if (abStart.status !== 'targeting') return;
			const abT1 = toggleOrAdvanceTarget(state, p1.playerId, abStart.session, {
				kind: 'permanent',
				id: ally1.instanceId,
				label: ally1.card.name
			});
			assert.equal(abT1.status, 'targeting');
			if (abT1.status !== 'targeting') return;
			const abT2 = toggleOrAdvanceTarget(state, p1.playerId, abT1.session, {
				kind: 'permanent',
				id: ally2.instanceId,
				label: ally2.card.name
			});
			assert.equal(abT2.status, 'targeting');
			if (abT2.status !== 'targeting') return;
			const abDiv = confirmCurrentSlot(abT2.session);
			assert.equal(abDiv.status, 'targeting');
			if (abDiv.status !== 'targeting') return;
			const abReady = confirmSlotDivisions(abDiv.session, {
				[ally1.instanceId]: 2,
				[ally2.instanceId]: 1
			});
			assert.equal(abReady.status, 'ready_to_submit');
			if (abReady.status !== 'ready_to_submit') return;
			assert.equal(abReady.payload.type, 'activate_ability');
			if (abReady.payload.type === 'activate_ability') {
				assert.deepEqual(abReady.payload.targetDivisions, {
					[ally1.instanceId]: 2,
					[ally2.instanceId]: 1
				});
			}
			assert.equal(applyGameAction(state, p1.playerId, abReady.payload).ok, true);
		});
	});
});
