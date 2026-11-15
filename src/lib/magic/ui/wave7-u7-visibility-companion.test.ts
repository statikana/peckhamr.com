import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getCastOptions,
	getEffectiveActivatedAbilities,
	sanitizeGameStateForViewer
} from '../engine.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';
import { buildBoardViewModel, formatPermanentChosenDescriptor } from './boardViewModel.ts';
import {
	beginDropTargeting,
	beginSpellTargeting,
	toggleOrAdvanceTarget
} from './targetingController.ts';

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_u7_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_u7_${synthSeq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Beast',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? (overrides.typeLine?.includes('Creature') ? '2' : undefined),
		toughness:
			overrides.toughness ?? (overrides.typeLine?.includes('Creature') ? '2' : undefined),
		loyalty: overrides.loyalty,
		defense: overrides.defense,
		imageUrl: overrides.imageUrl ?? '',
		artCropUrl: overrides.artCropUrl ?? '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(id: string, cards: ScryfallCard[], commanders: ScryfallCard[] = []): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id,
		userId: id,
		name: id,
		description: '',
		commanders,
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + commanders.length,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupArenaState(): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Sunlit Meadow',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(
		'd1',
		Array.from({ length: 30 }, () => filler)
	);
	const d2 = makeDeck(
		'd2',
		Array.from({ length: 30 }, () => filler)
	);
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d1.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: false,
			deckId: d2.id,
			deckName: d2.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d2.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const decks = new Map<number, MagicDeck>([
		[0, d1],
		[1, d2]
	]);

	const state = createInitialGameState('U7_TEST', seats, decks, DEFAULT_LOBBY_RULES);
	for (let i = 0; i < state.players.length; i++) {
		const p = state.players[i]!;
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	const p1 = state.players[0]!;
	const p2 = state.players[1]!;
	p1.hand = [];
	p2.hand = [];
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.turnNumber = 2;
	state.turnSerial = 2;
	return { state, p1, p2 };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'battlefield' | 'hand' | 'graveyard' | 'exile' | 'command' | 'library'
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		player.battlefield.push(inst);
	} else if (zone === 'hand') {
		player.hand.push(inst);
	} else if (zone === 'graveyard') {
		player.graveyard.push(inst);
	} else if (zone === 'exile') {
		player.exile.push(inst);
	} else if (zone === 'command') {
		player.command.push(inst);
	} else {
		player.library.unshift(inst);
	}
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	inst.enteredTimestamp = state.nextTimestamp;
	return inst;
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor, number>>): void {
	for (const [k, v] of Object.entries(pool)) {
		if (v !== undefined) {
			player.manaPool[k as ManaColor] += v;
		}
	}
}

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 40; guard++) {
		if (state.pendingPrompts.length > 0 || state.stack.length === 0) break;
		const prioPlayer = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

describe('Wave 7 Track U7: Visibility, Companion Pedestal, GY/Library Playability, & Permanent Chrome', () => {
	describe('U7.1 Companion Outside-the-Game Pedestal & {3} Special Action (CR 702.139a / CR 116.2g)', () => {
		it('computes companionView legality, supports auto-tap {3}, moves companion to hand, and clears pedestal', () => {
			const { state, p1, p2 } = setupArenaState();
			const myComp = synthCard({
				name: 'Luminous Den-Mate',
				manaCost: '{1}{W}{B}',
				cmc: 3,
				typeLine: 'Legendary Creature — Cat Nightmare',
				oracleText:
					'Companion — Each permanent card in your starting deck has mana value 2 or less.\nLifelink',
				power: '3',
				toughness: '2'
			});
			const oppComp = synthCard({
				name: 'Tidal Leviathan Guide',
				manaCost: '{3}{U}{G}',
				cmc: 5,
				typeLine: 'Legendary Creature — Elemental Otter',
				oracleText: 'Flash',
				power: '3',
				toughness: '2'
			});
			p1.companion = myComp;
			p2.companion = oppComp;

			// 1. Non-main phase: disabled with main-phase reason
			state.phase = 'upkeep';
			const vmUpkeep = buildBoardViewModel(state, 'p1');
			assert.ok(vmUpkeep.companionView);
			assert.equal(vmUpkeep.companionView.card.id, myComp.id);
			assert.equal(vmUpkeep.companionView.canMoveToHand, false);
			assert.match(vmUpkeep.companionView.illegalityReason ?? '', /main phase/i);

			// Opponent's companion is visible in OpponentPod status view, never actionable by viewer
			const oppCompView = vmUpkeep.playerStatusesById[p2.playerId]?.companionView ?? null;
			assert.ok(oppCompView);
			assert.equal(oppCompView.card.id, oppComp.id);
			assert.equal(oppCompView.canMoveToHand, false);

			// 2. Main phase without {3} mana: disabled with mana reason
			state.phase = 'main1';
			const vmNoMana = buildBoardViewModel(state, 'p1');
			assert.ok(vmNoMana.companionView);
			assert.equal(vmNoMana.companionView.canMoveToHand, false);
			assert.match(vmNoMana.companionView.illegalityReason ?? '', /\{3\}/);

			// 3. Give 3 untapped lands (auto-tap check!) -> canMoveToHand becomes true
			for (let i = 0; i < 3; i++) {
				putInZone(
					state,
					p1,
					synthCard({
						name: `Sunlit Plain ${i}`,
						manaCost: '',
						cmc: 0,
						typeLine: 'Basic Land — Plains',
						oracleText: '{T}: Add {W}.'
					}),
					'battlefield'
				);
			}
			const vmReady = buildBoardViewModel(state, 'p1');
			assert.ok(vmReady.companionView);
			assert.equal(vmReady.companionView.canMoveToHand, true);
			assert.equal(vmReady.companionView.illegalityReason, null);

			// 4. Execute { type: 'companion_to_hand' } special action
			const res = applyGameAction(state, 'p1', { type: 'companion_to_hand' });
			assert.equal(res.ok, true, res.error ?? '');
			assert.equal(p1.companionMovedToHand, true);
			assert.equal(
				p1.hand.some((c) => c.card.id === myComp.id),
				true,
				'Companion should now be a real CardInstance in hand'
			);

			const vmAfter = buildBoardViewModel(state, 'p1');
			assert.equal(vmAfter.companionView, null);
			assert.equal(vmAfter.playerStatusesById[p1.playerId]?.companionView, null);
		});
	});

	describe('U7.2 Graveyard Land Playability (CR 305.1)', () => {
		it('surfaces gyLandPlayOptions + playableGraveyardIds and plays land from graveyard', () => {
			const { state, p1 } = setupArenaState();
			const gyLand = putInZone(
				state,
				p1,
				synthCard({
					name: 'Verdant Hollow',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: '{T}: Add {G}.'
				}),
				'graveyard'
			);

			// Without graveyard-land permission, land in GY is not playable
			const vmBefore = buildBoardViewModel(state, 'p1');
			assert.deepEqual(vmBefore.gyLandPlayOptions, {});
			assert.equal(vmBefore.playableGraveyardIds.includes(gyLand.instanceId), false);
			assert.equal(vmBefore.hasPlayableGraveyardActions, false);

			// Add Crucible-style permission permanent
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Hourglass Reliquary',
					manaCost: '{3}',
					cmc: 3,
					typeLine: 'Artifact',
					oracleText: 'You may play lands from your graveyard.'
				}),
				'battlefield'
			);

			const vmWithPerm = buildBoardViewModel(state, 'p1');
			const landOpts = vmWithPerm.gyLandPlayOptions[gyLand.instanceId];
			assert.ok(landOpts && landOpts.length === 1);
			assert.equal(landOpts[0]?.fromZone, 'graveyard');
			assert.equal(vmWithPerm.playableGraveyardIds.includes(gyLand.instanceId), true);
			assert.equal(vmWithPerm.hasPlayableGraveyardActions, true);

			// Dispatch play_land from graveyard
			const playRes = applyGameAction(state, 'p1', {
				type: 'play_land',
				instanceId: gyLand.instanceId,
				fromZone: 'graveyard',
				faceIndex: landOpts[0]!.faceIndex
			});
			assert.equal(playRes.ok, true, playRes.error ?? '');
			assert.equal(p1.landsPlayedThisTurn, 1);
			assert.equal(
				p1.battlefield.some((b) => b.card.id === gyLand.card.id),
				true,
				'Played graveyard land must enter battlefield'
			);

			// Put another land in graveyard; land drop is spent so gyLandPlayOptions must be empty
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Second Hollow',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: '{T}: Add {G}.'
				}),
				'graveyard'
			);
			const vmSpent = buildBoardViewModel(state, 'p1');
			assert.deepEqual(vmSpent.gyLandPlayOptions, {});
			assert.equal(vmSpent.hasPlayableGraveyardActions, false);
		});
	});

	describe('U7.3 Top-of-Library Visibility & Play/Cast from Library (CR 401.5)', () => {
		it('never leaks unrevealed top-of-library cards on raw GameState and exposes reveal-mode top card to both players', () => {
			const { state, p1, p2 } = setupArenaState();
			const topLand = putInZone(
				state,
				p1,
				synthCard({
					name: 'Canopy Vista Glade',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: '{T}: Add {G}.'
				}),
				'library'
			);

			// Security check on raw GameState (p1.library and p2.library are non-empty!)
			const vmHiddenP1 = buildBoardViewModel(state, 'p1');
			assert.equal(vmHiddenP1.topOfLibraryView, null);
			assert.equal(vmHiddenP1.topOfLibraryByPlayerId[p1.playerId]?.topCard, null);
			assert.equal(vmHiddenP1.topOfLibraryByPlayerId[p1.playerId]?.visibility, 'hidden');
			assert.equal(vmHiddenP1.topOfLibraryByPlayerId[p2.playerId]?.topCard, null);

			// Add Future-Sight-style reveal + play permission
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Astral Observatory Lens',
					manaCost: '{2}{U}{U}{U}',
					cmc: 5,
					typeLine: 'Enchantment',
					oracleText:
						'Play with the top card of your library revealed.\nYou may play lands and cast spells from the top of your library.'
				}),
				'battlefield'
			);

			const vmRevealedP1 = buildBoardViewModel(state, 'p1');
			assert.ok(vmRevealedP1.topOfLibraryView);
			assert.equal(vmRevealedP1.topOfLibraryView.topCard?.instanceId, topLand.instanceId);
			assert.equal(vmRevealedP1.topOfLibraryView.visibility, 'revealed');
			assert.equal(vmRevealedP1.topOfLibraryView.isRevealedToAll, true);
			assert.equal(vmRevealedP1.topOfLibraryView.libraryLandPlayOptions.length, 1);
			assert.equal(vmRevealedP1.topOfLibraryView.canPlayOrCast, true);

			// Opponent (p2) can also see p1's revealed top card, but cannot play it
			const vmRevealedP2 = buildBoardViewModel(state, 'p2');
			const p1TopForP2 = vmRevealedP2.playerStatusesById[p1.playerId]?.topOfLibraryView ?? null;
			assert.ok(p1TopForP2);
			assert.equal(p1TopForP2.topCard?.instanceId, topLand.instanceId);
			assert.equal(p1TopForP2.canPlayOrCast, false);
			assert.equal(vmRevealedP2.topOfLibraryView, null, "p2's own library remains hidden");

			// Play the land directly from top of library
			const landRes = applyGameAction(state, 'p1', {
				type: 'play_land',
				instanceId: topLand.instanceId,
				fromZone: 'library',
				faceIndex: 0
			});
			assert.equal(landRes.ok, true, landRes.error ?? '');
			assert.equal(
				p1.battlefield.some((b) => b.card.id === topLand.card.id),
				true
			);
		});

		it('supports look-mode + pay-life casting from library via targetingController while hiding look-mode card from opponents', () => {
			const { state, p1, p2 } = setupArenaState();
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Obsidian Stronghold Spire',
					manaCost: '{3}{B}{B}{B}',
					cmc: 6,
					typeLine: 'Legendary Artifact',
					oracleText:
						'You may look at the top card of your library any time.\nYou may play lands and cast spells from the top of your library. If you cast a spell this way, pay life equal to its mana value rather than pay its mana cost.'
				}),
				'battlefield'
			);

			const topBolt = putInZone(
				state,
				p1,
				synthCard({
					name: 'Searing Arc Bolt',
					manaCost: '{1}{R}',
					cmc: 2,
					typeLine: 'Instant',
					oracleText: '~ deals 3 damage to any target.'
				}),
				'library'
			);

			// Controller sees look-mode top card and life-payment cast option with 0 mana!
			const vmP1 = buildBoardViewModel(state, 'p1');
			assert.ok(vmP1.topOfLibraryView);
			assert.equal(vmP1.topOfLibraryView.topCard?.instanceId, topBolt.instanceId);
			assert.equal(vmP1.topOfLibraryView.visibility, 'look');
			assert.equal(vmP1.topOfLibraryView.isLookableByViewer, true);
			assert.equal(vmP1.topOfLibraryView.isRevealedToAll, false);
			assert.equal(vmP1.topOfLibraryView.libraryCastOptions.length >= 1, true);
			assert.equal(vmP1.topOfLibraryView.canPlayOrCast, true);

			// Security check: opponent p2 MUST NOT see p1's look-only top card even on raw GameState!
			const vmP2 = buildBoardViewModel(state, 'p2');
			assert.equal(vmP2.playerStatusesById[p1.playerId]?.topOfLibraryView, null);
			assert.equal(vmP2.topOfLibraryByPlayerId[p1.playerId]?.topCard, null);

			// CR 401.5 lock during pendingCostPayment: controller cannot look mid-cost-payment
			state.pendingCostPayment = {
				kind: 'activate_ability'
			} as unknown as NonNullable<GameState['pendingCostPayment']>;
			assert.equal(buildBoardViewModel(state, 'p1').topOfLibraryView, null);
			delete state.pendingCostPayment;

			// Cast targeted spell from 'library' through targetingController (both beginSpellTargeting and beginDropTargeting)
			const libOpts = getCastOptions(state, 'p1', topBolt, 'library');
			assert.equal(libOpts.length >= 1, true);
			const dropPreview = beginDropTargeting(state, 'p1', topBolt, 'library', {
				kind: 'player',
				id: p2.playerId,
				label: p2.username
			});
			assert.equal(dropPreview.status, 'ready_to_submit');

			const init = beginSpellTargeting({
				gameState: state,
				actorId: 'p1',
				inst: topBolt,
				fromZone: 'library',
				option: libOpts[0]!
			});
			assert.equal(init.status, 'targeting');
			const step = toggleOrAdvanceTarget(state, 'p1', init.session, {
				kind: 'player',
				id: p2.playerId,
				label: p2.username
			});
			assert.equal(step.status, 'ready_to_submit');
			const payload = step.payload;
			assert.equal(payload.type, 'cast_spell');
			if (payload.type === 'cast_spell') {
				assert.equal(payload.fromZone, 'library');
			}

			const lifeBefore = p1.life;
			const oppLifeBefore = p2.life;
			const castRes = applyGameAction(state, 'p1', payload);
			assert.equal(castRes.ok, true, castRes.error ?? '');
			assert.equal(p1.life, lifeBefore - 2, 'Should pay 2 life equal to MV 2');
			resolveAllStack(state);
			assert.equal(p2.life, oppLifeBefore - 3, 'Resolved library spell should deal 3 damage');
		});
	});

	describe('U7.4 Opponent Revealed Hand Visibility (CR 400.2 / CR 701.20a)', () => {
		it('exposes only knownToPlayerIds or globally revealed opponent hand cards without leaking hidden hand cards', () => {
			const { state, p1, p2 } = setupArenaState();
			const secretA = putInZone(
				state,
				p2,
				synthCard({ name: 'Hidden Blade One', manaCost: '{1}{B}', cmc: 2, typeLine: 'Instant' }),
				'hand'
			);
			const revealedB = putInZone(
				state,
				p2,
				synthCard({ name: 'Peeked Ritual Two', manaCost: '{R}', cmc: 1, typeLine: 'Instant' }),
				'hand'
			);
			const secretC = putInZone(
				state,
				p2,
				synthCard({ name: 'Hidden Shield Three', manaCost: '{W}', cmc: 1, typeLine: 'Instant' }),
				'hand'
			);

			// 1. All 3 cards unrevealed on raw GameState -> 0 cards exposed!
			const vmNone = buildBoardViewModel(state, 'p1');
			assert.deepEqual(vmNone.revealedOpponentHandsByPlayerId[p2.playerId], []);

			// 2. Mark revealedB as known to p1 -> ONLY revealedB is exposed (both raw & sanitized!)
			revealedB.knownToPlayerIds = ['p1'];
			const vmPartialRaw = buildBoardViewModel(state, 'p1');
			assert.deepEqual(
				vmPartialRaw.revealedOpponentHandsByPlayerId[p2.playerId]?.map((c) => c.instanceId),
				[revealedB.instanceId]
			);

			const sanitizedPartial = sanitizeGameStateForViewer(state, 'p1');
			const sanitizedOppPartial = sanitizedPartial.players.find((pl) => pl.playerId === p2.playerId)!;
			assert.equal(sanitizedOppPartial.handCount, 3);
			const vmPartialSanitized = buildBoardViewModel(sanitizedPartial, 'p1');
			assert.deepEqual(
				vmPartialSanitized.revealedOpponentHandsByPlayerId[p2.playerId]?.map((c) => c.instanceId),
				[revealedB.instanceId]
			);

			// 3. Add Telepathy-style global opponent hand reveal static -> all 3 cards exposed to p1, 0 to p2
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Mindglass Beacon',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Enchantment',
					oracleText: 'Your opponents play with their hands revealed.'
				}),
				'battlefield'
			);
			putInZone(
				state,
				p1,
				synthCard({ name: 'Alice Secret Card', manaCost: '{U}', cmc: 1, typeLine: 'Instant' }),
				'hand'
			);

			const vmAllRaw = buildBoardViewModel(state, 'p1');
			assert.deepEqual(
				vmAllRaw.revealedOpponentHandsByPlayerId[p2.playerId]?.map((c) => c.instanceId),
				[secretA.instanceId, revealedB.instanceId, secretC.instanceId]
			);
			const sanitizedAll = sanitizeGameStateForViewer(state, 'p1');
			const vmAllSanitized = buildBoardViewModel(sanitizedAll, 'p1');
			assert.deepEqual(
				vmAllSanitized.revealedOpponentHandsByPlayerId[p2.playerId]?.map((c) => c.instanceId),
				[secretA.instanceId, revealedB.instanceId, secretC.instanceId]
			);

			// One-sided check: p2 still cannot see p1's unrevealed hand!
			const vmForP2 = buildBoardViewModel(state, 'p2');
			assert.deepEqual(vmForP2.revealedOpponentHandsByPlayerId[p1.playerId], []);
		});
	});

	describe('U7.5 Permanent Chrome: Prototype, Regen Shields, Flagbearer, Chosen Descriptor, Stolen, Frozen, & Monstrous', () => {
		it('projects isPrototyped when cast via Prototype (CR 719) and false when cast normally', () => {
			const { state, p1 } = setupArenaState();
			const protoCardDef = {
				name: 'Steelwork Strider',
				manaCost: '{6}',
				cmc: 6,
				typeLine: 'Artifact Creature — Construct',
				oracleText: 'Prototype {1}{W} — 2/2\nLifelink',
				power: '5',
				toughness: '5'
			};
			const protoHand = putInZone(state, p1, synthCard(protoCardDef), 'hand');
			const normalHand = putInZone(
				state,
				p1,
				synthCard({ ...protoCardDef, name: 'Full-Scale Strider' }),
				'hand'
			);

			giveMana(p1, { W: 8 });
			const opts = getCastOptions(state, 'p1', protoHand, 'hand');
			const protoOpt = opts.find((o) => o.spellMods?.prototyped);
			assert.ok(protoOpt, 'Expected a prototyped CastOption');

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: protoHand.instanceId,
					fromZone: 'hand',
					optionId: protoOpt.id
				}).ok,
				true
			);
			resolveAllStack(state);

			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'cast_spell',
					instanceId: normalHand.instanceId,
					fromZone: 'hand'
				}).ok,
				true
			);
			resolveAllStack(state);

			const protoPerm = p1.battlefield.find((b) => b.card.id === protoHand.card.id)!;
			const normalPerm = p1.battlefield.find((b) => b.card.id === normalHand.card.id)!;
			const vm = buildBoardViewModel(state, 'p1');
			assert.equal(vm.permanentsById[protoPerm.instanceId]?.isPrototyped, true);
			assert.equal(vm.permanentsById[protoPerm.instanceId]?.power, 2);
			assert.equal(vm.permanentsById[protoPerm.instanceId]?.toughness, 2);
			assert.equal(vm.permanentsById[normalPerm.instanceId]?.isPrototyped, false);
			assert.equal(vm.permanentsById[normalPerm.instanceId]?.power, 5);
		});

		it('projects regenerationShields, isFlagbearer (with Layer 6 removal), chosenDescriptor, isStolen, isFrozen, and isMonstrous', () => {
			const { state, p1, p2 } = setupArenaState();
			const troll = putInZone(
				state,
				p1,
				synthCard({
					name: 'Mossbark Troll',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Troll',
					oracleText: '{G}: Regenerate ~.',
					power: '3',
					toughness: '2'
				}),
				'battlefield'
			);

			const flagbearer = putInZone(
				state,
				p2,
				synthCard({
					name: 'Pennant Bearer',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human Flagbearer',
					oracleText:
						'While an opponent is choosing targets as part of casting a spell they control or activating an ability they control, that player must choose at least one Flagbearer on the battlefield if able.',
					power: '1',
					toughness: '1'
				}),
				'battlefield'
			);

			// Activate regenerate twice on troll
			giveMana(p1, { G: 2 });
			const regenAb = getEffectiveActivatedAbilities(state, p1, troll, [])[0]!;
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: troll.instanceId,
					abilityId: regenAb.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'activate_ability',
					instanceId: troll.instanceId,
					abilityId: regenAb.id
				}).ok,
				true
			);
			resolveAllStack(state);

			// Configure chosen values, frozen, monstrous, and stolen state
			troll.chosenColor = 'G';
			troll.chosenSubType = 'Elf';
			troll.doesntUntapNextUntapStep = true;
			troll.isMonstrous = true;

			const stolenRelic = putInZone(
				state,
				p1,
				synthCard({
					name: 'Captured Obelisk',
					manaCost: '{2}',
					cmc: 2,
					typeLine: 'Artifact',
					oracleText: ''
				}),
				'battlefield'
			);
			stolenRelic.ownerId = p2.playerId;
			stolenRelic.chosenCardName = 'Arcane Bolt';
			stolenRelic.chosenAnchorWord = 'valor';

			const vm1 = buildBoardViewModel(state, 'p1');
			const trollView = vm1.permanentsById[troll.instanceId]!;
			assert.equal(trollView.regenerationShields, 2);
			assert.equal(trollView.chosenDescriptor, 'Elf • Green');
			assert.equal(trollView.isFrozen, true);
			assert.equal(trollView.isMonstrous, true);
			assert.equal(trollView.isStolen, false);

			const relicView = vm1.permanentsById[stolenRelic.instanceId]!;
			assert.equal(relicView.isStolen, true);
			assert.equal(relicView.ownerName, 'Bob');
			assert.equal(relicView.chosenDescriptor, 'Arcane Bolt • "valor"');
			assert.equal(formatPermanentChosenDescriptor(stolenRelic), 'Arcane Bolt • "valor"');

			// Flagbearer is active for both p1 and p2 views
			assert.equal(vm1.permanentsById[flagbearer.instanceId]?.isFlagbearer, true);
			assert.equal(
				buildBoardViewModel(state, 'p2').permanentsById[flagbearer.instanceId]?.isFlagbearer,
				true
			);

			// Add Layer 6 ability-removal static -> Flagbearer rule is lost so isFlagbearer becomes false
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Blanketing Silence Field',
					manaCost: '{2}{W}{W}',
					cmc: 4,
					typeLine: 'Enchantment',
					oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
				}),
				'battlefield'
			);
			const vmSilenced = buildBoardViewModel(state, 'p1');
			assert.equal(vmSilenced.permanentsById[flagbearer.instanceId]?.isFlagbearer, false);
		});

		it('invalidates the WeakMap BoardViewModel cache across every Wave 7 U7 state field mutation', () => {
			const { state, p1, p2 } = setupArenaState();
			const perm = putInZone(
				state,
				p1,
				synthCard({ name: 'Cache Probe Construct', typeLine: 'Artifact Creature — Construct' }),
				'battlefield'
			);
			const oppHand = putInZone(
				state,
				p2,
				synthCard({ name: 'Opponent Hand Probe', typeLine: 'Instant' }),
				'hand'
			);
			const topCard = putInZone(
				state,
				p1,
				synthCard({ name: 'Top Library Probe', typeLine: 'Instant' }),
				'library'
			);

			let prev = buildBoardViewModel(state, 'p1');
			assert.equal(buildBoardViewModel(state, 'p1'), prev, 'Unchanged state must hit WeakMap cache');

			const assertInvalidated = (label: string, mutate: () => void) => {
				mutate();
				const next = buildBoardViewModel(state, 'p1');
				assert.notEqual(next, prev, `Expected WeakMap cache invalidation on ${label}`);
				assert.equal(buildBoardViewModel(state, 'p1'), next, `Expected stable cache hit after ${label}`);
				prev = next;
			};

			assertInvalidated('p1.companion', () => {
				p1.companion = synthCard({ name: 'Designated Sidekick', typeLine: 'Creature — Beast' });
			});
			assertInvalidated('p1.companionMovedToHand', () => {
				p1.companionMovedToHand = true;
			});
			assertInvalidated('topCard.knownToPlayerIds', () => {
				topCard.knownToPlayerIds = ['p1'];
			});
			assertInvalidated('state.pendingCostPayment', () => {
				state.pendingCostPayment = {
					kind: 'activate_ability'
				} as unknown as NonNullable<GameState['pendingCostPayment']>;
			});
			assertInvalidated('oppHand.knownToPlayerIds', () => {
				delete state.pendingCostPayment;
				oppHand.knownToPlayerIds = ['p1'];
			});
			assertInvalidated('perm.prototyped', () => {
				perm.prototyped = true;
			});
			assertInvalidated('perm.copiableState.prototyped', () => {
				perm.prototyped = false;
				perm.copiableState = { card: perm.card, prototyped: true };
			});
			assertInvalidated('perm.regenerationShields', () => {
				perm.regenerationShields = 2;
			});
			assertInvalidated('perm.chosenCardName', () => {
				perm.chosenCardName = 'Named Relic';
			});
			assertInvalidated('perm.chosenSubType', () => {
				perm.chosenSubType = 'Construct';
			});
			assertInvalidated('perm.chosenColor', () => {
				perm.chosenColor = 'U';
			});
			assertInvalidated('perm.chosenAnchorWord', () => {
				perm.chosenAnchorWord = 'harmony';
			});
			assertInvalidated('perm.doesntUntapNextUntapStep', () => {
				perm.doesntUntapNextUntapStep = true;
			});
			assertInvalidated('perm.isMonstrous', () => {
				perm.isMonstrous = true;
			});
			assertInvalidated('perm.ownerId', () => {
				perm.ownerId = p2.playerId;
			});
		});

		it('keeps ArenaTable and owned UI files free of oracleText reads and Wave 4–7 keyword string literals', () => {
			const uiDir = path.dirname(fileURLToPath(import.meta.url));
			const filesToScan = [
				path.resolve(uiDir, '../ArenaTable.svelte'),
				path.join(uiDir, 'boardViewModel.ts'),
				path.join(uiDir, 'targetingController.ts'),
				path.join(uiDir, 'PermanentCard.svelte'),
				path.join(uiDir, 'CardInspector.svelte'),
				path.join(uiDir, 'ZoneBrowserModal.svelte'),
				path.join(uiDir, 'PlayerVitals.svelte'),
				path.join(uiDir, 'OpponentPod.svelte')
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
				'goad'
			];

			for (const filePath of filesToScan) {
				const rel = path.basename(filePath);
				const src = fs.readFileSync(filePath, 'utf8');
				assert.equal(
					/\.oracleText\b/.test(src),
					false,
					`Forbidden .oracleText read in ${rel}`
				);
				const lower = src.toLowerCase();
				for (const kw of forbiddenQuotedKeywords) {
					assert.equal(
						lower.includes(`'${kw}'`) || lower.includes(`"${kw}"`),
						false,
						`Forbidden quoted keyword literal "${kw}" in ${rel}`
					);
				}
			}
		});
	});
});
