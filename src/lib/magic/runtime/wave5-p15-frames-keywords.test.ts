import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn
} from '../engine.ts';
import { validateCommanderDeck } from '../scryfall.ts';
import { effectiveManaValue } from './faces.ts';
import { moveObject } from './zones.ts';
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

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p15_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p15_${synthSeq}`,
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
		defense: overrides.defense,
		imageUrl: '',
		artCropUrl: '',
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

function makeDeck(cards: ScryfallCard[], commanders: ScryfallCard[] = []): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: 'deck_p15',
		userId: 'p1',
		name: 'Track P15 Deck',
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

function setupGame(
	opts: {
		p1Bot?: boolean;
		p2Bot?: boolean;
		threePlayer?: boolean;
		p1Commanders?: ScryfallCard[];
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Sunlit Meadow',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(
		Array.from({ length: 30 }, () => filler),
		opts.p1Commanders ?? []
	);
	const d2 = makeDeck(Array.from({ length: 30 }, () => filler));
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: d1.commanders.map((c) => c.name),
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
			isBot: Boolean(opts.p2Bot),
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
	if (opts.threePlayer) {
		const d3 = makeDeck(Array.from({ length: 30 }, () => filler));
		seats.push({
			seatIndex: 2,
			userId: 'p3',
			username: 'Charlie',
			avatarUrl: '',
			isBot: false,
			deckId: d3.id,
			deckName: d3.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d3.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
		decks.set(2, d3);
	}
	const state = createInitialGameState('P15', seats, decks, DEFAULT_LOBBY_RULES);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hasKeptHand = true;
		p.hand = [];
	}
	return {
		state,
		p1: state.players[0],
		p2: state.players[1],
		p3: state.players[2]
	};
}

function giveMana(player: PlayerGameState, amounts: Partial<Record<ManaColor, number>>): void {
	for (const [c, n] of Object.entries(amounts)) {
		const col = c as ManaColor;
		player.manaPool[col] = (player.manaPool[col] ?? 0) + (n ?? 0);
	}
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
	}
	if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	return inst;
}

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 40; guard++) {
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].purpose === 'trigger_order') {
			const prm = state.pendingPrompts[0];
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
			});
			assert.equal(res.ok, true, res.error ?? '');
			continue;
		}
		if (state.pendingPrompts.length > 0 || state.stack.length === 0) break;
		const prioPlayer = state.players[state.priorityPlayerIndex];
		if (!prioPlayer) break;
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function advanceToPhase(state: GameState, targetPhase: GameState['phase'], targetActiveIdx = state.activePlayerIndex): void {
	for (let guard = 0; guard < 80; guard++) {
		if (
			state.phase === targetPhase &&
			state.activePlayerIndex === targetActiveIdx &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0
		) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			break;
		}
		const prio = state.players[state.priorityPlayerIndex];
		if (!prio) break;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

// ============================================================================
// Group 1 — P15.1 Battles & Sieges (CR 310), Control Point Gate, & Self-Ref
// ============================================================================

describe('Track P15.1 — Battles & Sieges (CR 310.1–12), Control Point Gate, & Self-Reference Normalization', () => {
	it('enters Siege Battle with defense counters, assigns opponent protector (including 3p choice & CR 704.5w reassignment), handles combat/burn damage, and casts transformed back face on defeat (CR 310.11b)', () => {
		const siegeCard = synthCard({
			name: 'Invasion of Glimmerfen',
			layout: 'transform',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Battle — Siege',
			oracleText: 'When this Siege enters, you gain 1 life.',
			colors: ['R'],
			colorIdentity: ['R'],
			defense: '4',
			backFace: {
				name: 'Glimmerfen Vanguard',
				manaCost: '',
				typeLine: 'Creature — Elemental Warrior',
				oracleText: 'Haste',
				power: '3',
				toughness: '3',
				imageUrl: ''
			}
		});
		const compiled = compileCard(siegeCard);
		assert.equal(compiled.fullySupported, true);
		assert.ok(compiled.faces[0].characteristics.types.includes('Battle'));
		assert.ok(compiled.faces[0].characteristics.subtypes.includes('Siege'));
		assert.equal(compiled.faces[0].characteristics.defense, 4);

		// 3-player human protector choice + CR 704.5w protector reassignment SBA
		const mp = setupGame({ threePlayer: true });
		const mpHandSiege = putInZone(mp.state, mp.p1, siegeCard, 'hand');
		giveMana(mp.p1, { R: 1, W: 1 });
		const mpCast = applyGameAction(mp.state, 'p1', {
			type: 'cast_spell',
			instanceId: mpHandSiege.instanceId
		});
		assert.equal(mpCast.ok, true, mpCast.error ?? '');
		resolveAllStack(mp.state);
		// Human controller in 3p game must choose which opponent protects the Siege (CR 310.11a)
		assert.equal(mp.state.pendingPrompts.length, 1);
		const protPrompt = mp.state.pendingPrompts[0];
		const ansProt = applyGameAction(mp.state, 'p1', {
			type: 'choice',
			promptId: protPrompt.id,
			answer: { kind: 'chooseMode', indices: [1] } // Charlie (p3)
		});
		assert.equal(ansProt.ok, true, ansProt.error ?? '');
		resolveAllStack(mp.state);
		const mpBattle = mp.p1.battlefield.find((b) => b.card.name === 'Invasion of Glimmerfen');
		assert.ok(mpBattle);
		assert.equal(mpBattle.counters.defense, 4);
		assert.equal(mpBattle.protectorId, 'p3');

		// Eliminate p3 -> CR 704.5w SBA reassigns protector to remaining opponent p2
		mp.p3!.life = 0;
		checkStateBasedActions(mp.state);
		assert.equal(mpBattle.protectorId, 'p2');

		// 2-player full combat + spell damage defeat -> exile & cast transformed free
		const { state, p1, p2 } = setupGame();
		const handSiege = putInZone(state, p1, siegeCard, 'hand');
		giveMana(p1, { R: 1, W: 1 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: handSiege.instanceId
			}).ok,
			true
		);
		resolveAllStack(state);
		resolveAllStack(state);
		const battle = p1.battlefield.find((b) => b.card.name === 'Invasion of Glimmerfen')!;
		assert.ok(battle);
		assert.equal(battle.protectorId, 'p2');
		assert.equal(battle.counters.defense, 4);

		// Put a 2/2 attacker for p1 and a 1/4 blocker for p2
		const attacker = putInZone(
			state,
			p1,
			synthCard({ name: 'Fen Striker', typeLine: 'Creature — Wolf', power: '2', toughness: '2' }),
			'battlefield'
		);
		const p1Other = putInZone(
			state,
			p1,
			synthCard({ name: 'Fen Bystander', typeLine: 'Creature — Human', power: '1', toughness: '1' }),
			'battlefield'
		);
		advanceToPhase(state, 'declare_attackers', 0);
		const atkRes = applyGameAction(state, 'p1', {
			type: 'declare_attackers',
			assignments: [
				{
					attackerInstanceId: attacker.instanceId,
					defenderPlayerId: 'p2',
					defenderBattleId: battle.instanceId
				}
			]
		});
		assert.equal(atkRes.ok, true, atkRes.error ?? '');
		advanceToPhase(state, 'declare_blockers', 0);

		// Non-protector creature cannot block an attacker attacking a Battle (CR 310.8d)
		const badBlk = applyGameAction(state, 'p1', {
			type: 'declare_blockers',
			assignments: [{ blockerInstanceId: p1Other.instanceId, attackerInstanceId: attacker.instanceId }]
		});
		assert.equal(badBlk.ok, false);

		// Unblocked combat damage removes 2 defense counters (4 -> 2, CR 120.3f)
		advanceToPhase(state, 'main2', 0);
		assert.equal(battle.counters.defense, 2);

		// Protector (p2) cannot attack a Battle they protect on their turn (CR 310.8a)
		const p2Raider = putInZone(
			state,
			p2,
			synthCard({ name: 'Bob Raider', typeLine: 'Creature — Goblin', power: '2', toughness: '2' }),
			'battlefield'
		);
		// First deal 2 burn damage to defeat the Siege in p1's main2!
		const burn = putInZone(
			state,
			p1,
			synthCard({
				name: 'Siege Bolt',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: '~ deals 2 damage to any target.'
			}),
			'hand'
		);
		giveMana(p1, { R: 1 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: burn.instanceId,
				targets: [{ kind: 'permanent', id: battle.instanceId, label: battle.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		// Siege 0-defense trigger is on stack; resolve it -> prompts yesNo to cast transformed free
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].kind, 'yesNo');
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveAllStack(state);

		const vanguard = p1.battlefield.find((c) => c.instanceId === battle.instanceId);
		assert.ok(vanguard, 'Defeated Siege resolved onto battlefield transformed');
		assert.equal(vanguard.transformed, true);
		const evVanguard = evaluatePermanent(state, vanguard);
		assert.equal(evVanguard.power, 3);
		assert.ok(evVanguard.activeKeywords.includes('Haste'));
		assert.ok(p2Raider);
	});

	it('enforces CR 310.8a protector attack restriction, CR 704.5v non-Siege 0-defense SBA, Control Point gate, and self-reference normalization', () => {
		// Control Point playtest card must compile as unsupported
		const controlPoint = synthCard({
			name: 'Point Alpha',
			typeLine: 'Battle — Control Point',
			oracleText: 'When ~ enters, draw a card.',
			defense: '5'
		});
		const cpDef = compileCard(controlPoint);
		assert.equal(cpDef.fullySupported, false);
		assert.ok(cpDef.faces[0].abilities.some((a) => a.kind === 'unsupported'));

		// Self-reference normalization for Room, Omen, Case, Class, Battle
		for (const sub of ['Room', 'Case', 'Class']) {
			const c = synthCard({
				name: `Test ${sub}`,
				typeLine: `Enchantment — ${sub}`,
				oracleText: `When this ${sub} enters, draw a card.`
			});
			assert.equal(compileCard(c).fullySupported, true, `Expected "this ${sub}" to normalize to ~`);
		}

		// Protector cannot attack protected Battle (CR 310.8a) & non-Siege Battle at 0 defense goes to graveyard (CR 704.5v)
		const { state, p1, p2 } = setupGame();
		const plainBattle = synthCard({
			name: 'Skirmish Plain',
			typeLine: 'Battle',
			oracleText: '',
			defense: '3'
		});
		const bInst = putInZone(state, p1, plainBattle, 'battlefield');
		bInst.protectorId = 'p2';
		bInst.counters.defense = 3;
		const p2Atk = putInZone(
			state,
			p2,
			synthCard({ name: 'Protector Soldier', typeLine: 'Creature — Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);
		advanceToPhase(state, 'declare_attackers', 1);
		const illegalAtk = applyGameAction(state, 'p2', {
			type: 'declare_attackers',
			assignments: [
				{
					attackerInstanceId: p2Atk.instanceId,
					defenderPlayerId: 'p1',
					defenderBattleId: bInst.instanceId
				}
			]
		});
		assert.equal(illegalAtk.ok, false, 'Protector cannot attack a Battle they protect');

		// Drop non-Siege Battle to 0 defense -> SBA puts it into owner's graveyard (CR 704.5v)
		bInst.counters.defense = 0;
		checkStateBasedActions(state);
		assert.ok(p1.graveyard.some((c) => c.instanceId === bInst.instanceId));
	});
});

// ============================================================================
// Group 2 — P15.1 Rooms, Preparation, Omen, ±X Loyalty & Compleated, Riders
// ============================================================================

describe('Track P15.1 — Rooms (CR 709.5), Preparation (CR 723), Omen (CR 721), ±X Loyalty, Compleated, & Activation Riders', () => {
	it('casts split Room half, unlocks second door via unlock_room_door, updates MV, and fires Eerie door/fully-unlocked triggers (CR 709.5)', () => {
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
		const eerieWatcher = synthCard({
			name: 'Glimmer Eerie Watcher',
			typeLine: 'Creature — Spirit',
			oracleText:
				'Eerie — Whenever an enchantment you control enters and whenever you fully unlock a Room, you gain 2 life.',
			power: '2',
			toughness: '2'
		});
		assert.equal(compileCard(roomCard).fullySupported, true);
		assert.equal(compileCard(eerieWatcher).fullySupported, true);

		const { state, p1 } = setupGame();
		const watcher = putInZone(state, p1, eerieWatcher, 'battlefield');
		const roomHand = putInZone(state, p1, roomCard, 'hand');
		const startHand = p1.hand.length;
		const startLife = p1.life;

		giveMana(p1, { U: 4, W: 4 });
		const castRes = applyGameAction(state, 'p1', {
			type: 'cast_spell',
			instanceId: roomHand.instanceId,
			optionId: 'normal',
			faceIndex: 0
		});
		assert.equal(castRes.ok, true, castRes.error ?? '');
		resolveAllStack(state);
		resolveAllStack(state);

		const roomPerm = p1.battlefield.find((c) => c.instanceId === roomHand.instanceId)!;
		assert.ok(roomPerm);
		assert.deepEqual(roomPerm.unlockedFaces, [0]);
		assert.equal(effectiveManaValue(roomPerm.card, { zone: 'battlefield', unlockedFaces: roomPerm.unlockedFaces }), 2);
		assert.equal(p1.hand.length, startHand - 1 + 1, 'Study Hall door-unlock trigger drew 1 card');
		assert.equal(p1.life, startLife + 2, 'Eerie triggered once on enchantment ETB');
		assert.equal(evaluatePermanent(state, watcher).power, 2, 'Right door still locked');

		// Unlock right door (faceIndex 1) via special action unlock_room_door
		const unlockRes = applyGameAction(state, 'p1', {
			type: 'unlock_room_door',
			instanceId: roomPerm.instanceId,
			faceIndex: 1
		});
		assert.equal(unlockRes.ok, true, unlockRes.error ?? '');
		resolveAllStack(state);

		assert.deepEqual(roomPerm.unlockedFaces, [0, 1]);
		assert.equal(effectiveManaValue(roomPerm.card, { zone: 'battlefield', unlockedFaces: roomPerm.unlockedFaces }), 5);
		assert.equal(evaluatePermanent(state, watcher).power, 3, 'Grand Archive static +1/+1 now active');
		assert.equal(p1.life, startLife + 4, 'Eerie triggered again when Room became fully unlocked');
	});

	it('handles Preparation layout (CR 723) cast_preparation_copy and Omen layout (CR 721.3d) shuffle-on-resolve', () => {
		const prepCard = synthCard({
			name: 'Runescribe Mentor // Rune Surge',
			layout: 'prepare',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Wizard // Sorcery',
			oracleText: '~ enters prepared.',
			power: '2',
			toughness: '2',
			faces: [
				{
					name: 'Runescribe Mentor',
					manaCost: '{1}{U}',
					cmc: 2,
					typeLine: 'Creature — Wizard',
					oracleText: '~ enters prepared.',
					colors: ['U'],
					power: '2',
					toughness: '2',
					imageUrl: '',
					artCropUrl: ''
				},
				{
					name: 'Rune Surge',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Sorcery',
					oracleText: 'Draw two cards.',
					colors: ['U'],
					imageUrl: '',
					artCropUrl: ''
				}
			]
		});
		const omenCard = synthCard({
			name: 'Stormscale Drake // Tempest Omen',
			layout: 'omen',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Creature — Dragon // Instant — Omen',
			oracleText: 'Flying',
			power: '3',
			toughness: '3',
			faces: [
				{
					name: 'Stormscale Drake',
					manaCost: '{3}{U}',
					cmc: 4,
					typeLine: 'Creature — Dragon',
					oracleText: 'Flying',
					colors: ['U'],
					power: '3',
					toughness: '3',
					imageUrl: '',
					artCropUrl: ''
				},
				{
					name: 'Tempest Omen',
					manaCost: '{1}{U}',
					cmc: 2,
					typeLine: 'Instant — Omen',
					oracleText: 'Draw a card.',
					colors: ['U'],
					imageUrl: '',
					artCropUrl: ''
				}
			]
		});
		assert.equal(compileCard(prepCard).fullySupported, true);
		assert.equal(compileCard(omenCard).fullySupported, true);

		const { state, p1 } = setupGame();
		const prepHand = putInZone(state, p1, prepCard, 'hand');
		giveMana(p1, { U: 5, W: 5 });
		assert.equal(
			applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: prepHand.instanceId }).ok,
			true
		);
		resolveAllStack(state);
		const prepPerm = p1.battlefield.find((c) => c.instanceId === prepHand.instanceId)!;
		assert.equal(prepPerm.isPrepared, true, 'Creature entered prepared');

		const handBeforePrepCopy = p1.hand.length;
		const copyRes = applyGameAction(state, 'p1', {
			type: 'cast_preparation_copy',
			instanceId: prepPerm.instanceId
		});
		assert.equal(copyRes.ok, true, copyRes.error ?? '');
		assert.equal(prepPerm.isPrepared, false, 'Casting preparation copy unprepares the permanent');
		assert.ok(p1.battlefield.some((c) => c.instanceId === prepPerm.instanceId), 'Permanent remains on battlefield');
		resolveAllStack(state);
		assert.equal(p1.hand.length, handBeforePrepCopy + 2, 'Preparation spell copy drew 2 cards');

		// Omen Face 1 shuffles into owner's library instead of going to graveyard (CR 721.3d)
		const omenHand = putInZone(state, p1, omenCard, 'hand');
		const opts = getCastOptions(state, 'p1', omenHand, 'hand');
		const omenOpt = opts.find((o) => o.faceIndex === 1);
		assert.ok(omenOpt, 'Expected Omen Face 1 cast option');
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: omenHand.instanceId,
				optionId: omenOpt.id,
				faceIndex: 1
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === omenHand.instanceId), false);
		assert.equal(p1.exile.some((c) => c.instanceId === omenHand.instanceId), false);
		assert.equal(
			p1.library.some((c) => c.instanceId === omenHand.instanceId),
			true,
			'Omen card shuffled into owner library on resolution'
		);
	});

	it('supports Compleated (CR 702.150a) & ±X loyalty abilities (CR 606.4) plus beforeAttackers, oncePerGame, activatorWho, and trailing Activate only if riders', () => {
		const walkerCard = synthCard({
			name: 'Vael, Compleated Sage',
			manaCost: '{1}{U}{U/P}',
			cmc: 3,
			typeLine: 'Legendary Planeswalker — Vael',
			oracleText: 'Compleated\n+X: You gain X life.\n-X: Draw X cards.',
			loyalty: '5'
		});
		assert.equal(compileCard(walkerCard).fullySupported, true);

		const { state, p1, p2 } = setupGame();
		const wHand = putInZone(state, p1, walkerCard, 'hand');
		// Give only {1}{U} so {U/P} is paid with 2 life -> Compleated enters with 5 - 2 = 3 loyalty!
		giveMana(p1, { U: 1, W: 1 });
		const startLife = p1.life;
		const castW = applyGameAction(state, 'p1', {
			type: 'cast_spell',
			instanceId: wHand.instanceId,
			costPayment: { phyrexianLifeCount: 1 }
		});
		assert.equal(castW.ok, true, castW.error ?? '');
		assert.equal(p1.life, startLife - 2);
		resolveAllStack(state);

		const walker = p1.battlefield.find((c) => c.instanceId === wHand.instanceId)!;
		assert.equal(walker.counters.loyalty, 3, 'Compleated reduced starting loyalty by 2');

		const walkerAbs = getEffectiveActivatedAbilities(state, p1, walker);
		const minusX = walkerAbs.find((a) => a.loyaltySign === '-')!;
		assert.ok(minusX);
		// Cannot pay -4 when loyalty is 3
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: walker.instanceId,
				abilityId: minusX.id,
				xValue: 4
			}).ok,
			false
		);
		// Pay -2 -> loyalty becomes 1, draws 2 cards
		const handBefore = p1.hand.length;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: walker.instanceId,
				abilityId: minusX.id,
				xValue: 2
			}).ok,
			true
		);
		assert.equal(walker.counters.loyalty, 1);
		resolveAllStack(state);
		assert.equal(p1.hand.length, handBefore + 2);

		// Activation riders: beforeAttackers, oncePerGame, Any player / Only any opponent, Activate only if
		const riderRelic = synthCard({
			name: 'Pact Sundial',
			typeLine: 'Artifact',
			oracleText:
				'{0}: You gain 1 life. Activate only during your turn, before attackers are declared.\n{0}: You gain 2 life. Activate only once.\n{1}: Draw a card. Only any opponent may activate this ability.'
		});
		assert.equal(compileCard(riderRelic).fullySupported, true);
		const relic = putInZone(state, p1, riderRelic, 'battlefield');
		const rAbs = getEffectiveActivatedAbilities(state, p1, relic);

		// beforeAttackers works in main1
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: relic.instanceId,
				abilityId: rAbs[0].id
			}).ok,
			true
		);
		resolveAllStack(state);

		// oncePerGame works once, then blocks second activation even on a future turn
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: relic.instanceId,
				abilityId: rAbs[1].id
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			checkAbilityActivationLegality(state, 'p1', relic, rAbs[1]).ok,
			false,
			'oncePerGame blocks second activation'
		);

		// Only any opponent: p1 (controller) cannot activate rAbs[2], while p2 (opponent) CAN when given priority
		giveMana(p1, { W: 1 });
		assert.equal(checkAbilityActivationLegality(state, 'p1', relic, rAbs[2]).ok, false);
		giveMana(p2, { W: 1 });
		const p2RelicAbs = getEffectiveActivatedAbilities(state, p2, relic);
		assert.equal(applyGameAction(state, 'p1', { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, 'p2', {
				type: 'activate_ability',
				instanceId: relic.instanceId,
				abilityId: p2RelicAbs[2].id
			}).ok,
			true
		);
		resolveAllStack(state);
	});
});

// ============================================================================
// Group 3 — P15.2 Partner Variants, Day/Night, Speed, Ascend, & Read Ahead
// ============================================================================

describe('Track P15.2 — Partner Variants (CR 702.124), Daybound/Nightbound, Start your engines! & Max speed, Ascend, & Read ahead', () => {
	it('validates Choose a Background, Doctor\'s companion, Friends forever, and Partner—[text] pairings in validateCommanderDeck', () => {
		const filler98: DeckCardEntry[] = [
			{
				card: synthCard({
					name: 'Plains',
					manaCost: '',
					cmc: 0,
					typeLine: 'Basic Land — Plains',
					oracleText: '({T}: Add {W}.)'
				}),
				quantity: 98
			}
		];

		// 1. Choose a Background + Legendary Background
		const bgHero = synthCard({
			name: 'Valen, Lone Wanderer',
			typeLine: 'Legendary Creature — Human Warrior',
			oracleText: 'Choose a Background',
			colorIdentity: ['W'],
			canBeCommander: true,
			hasChooseBackground: true
		});
		const bgEnch = synthCard({
			name: 'Guild Artisan Crest',
			typeLine: 'Legendary Enchantment — Background',
			oracleText: 'Commander creatures you own have vigilance.',
			colorIdentity: ['R'],
			isBackground: true
		});
		assert.equal(compileCard(bgHero).fullySupported, true);
		assert.equal(validateCommanderDeck([bgHero, bgEnch], filler98).isLegal, true);

		// 2. Doctor's companion + Time Lord Doctor (and reject extra subtype!)
		const doc = synthCard({
			name: 'The Fifteenth Wanderer',
			typeLine: 'Legendary Creature — Time Lord Doctor',
			oracleText: 'Vigilance',
			colorIdentity: ['U'],
			canBeCommander: true
		});
		const badDoc = synthCard({
			name: 'Mutated Doctor',
			typeLine: 'Legendary Creature — Time Lord Doctor Rogue',
			oracleText: 'Vigilance',
			colorIdentity: ['U'],
			canBeCommander: true
		});
		const companion = synthCard({
			name: 'Clara, Steadfast Ally',
			typeLine: 'Legendary Creature — Human',
			oracleText: "Doctor's companion",
			colorIdentity: ['W'],
			canBeCommander: true
		});
		assert.equal(compileCard(companion).fullySupported, true);
		assert.equal(validateCommanderDeck([doc, companion], filler98).isLegal, true);
		assert.equal(validateCommanderDeck([badDoc, companion], filler98).isLegal, false);

		// 3. Friends forever + Friends forever
		const ff1 = synthCard({
			name: 'Will, Harbor Scout',
			typeLine: 'Legendary Creature — Human',
			oracleText: 'Friends forever',
			colorIdentity: ['U'],
			canBeCommander: true
		});
		const ff2 = synthCard({
			name: 'Mike, Signal Keeper',
			typeLine: 'Legendary Creature — Human',
			oracleText: 'Friends forever',
			colorIdentity: ['W'],
			canBeCommander: true
		});
		assert.equal(compileCard(ff1).fullySupported, true);
		assert.equal(validateCommanderDeck([ff1, ff2], filler98).isLegal, true);
		assert.equal(validateCommanderDeck([ff1, companion], filler98).isLegal, false);

		// 4. Partner—Survivors + Partner—Survivors
		const surv1 = synthCard({
			name: 'Joel, Outpost Guard',
			typeLine: 'Legendary Creature — Human',
			oracleText: 'Partner—Survivors',
			colorIdentity: ['G'],
			canBeCommander: true
		});
		const surv2 = synthCard({
			name: 'Ellie, Keen Tracker',
			typeLine: 'Legendary Creature — Human',
			oracleText: 'Partner—Survivors',
			colorIdentity: ['W'],
			canBeCommander: true
		});
		assert.equal(compileCard(surv1).fullySupported, true);
		assert.equal(validateCommanderDeck([surv1, surv2], filler98).isLegal, true);
	});

	it('tracks Daybound and Nightbound (CR 702.145, CR 732), Start your engines! & Max speed (CR 702.178–179), Ascend (CR 702.131), and Read ahead (CR 702.155)', () => {
		const werewolf = synthCard({
			name: 'Hollowhenge Ranger',
			layout: 'transform',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Human Werewolf',
			oracleText: 'Daybound',
			power: '2',
			toughness: '2',
			backFace: {
				name: 'Hollowhenge Howler',
				manaCost: '',
				typeLine: 'Creature — Werewolf',
				oracleText: 'Nightbound',
				power: '4',
				toughness: '4',
				imageUrl: ''
			}
		});
		const speedster = synthCard({
			name: 'Driftcircuit Pilot',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Pilot',
			oracleText: 'Start your engines!\nMax speed — ~ gets +2/+2 and has haste.',
			power: '2',
			toughness: '2'
		});
		const ascendPerm = synthCard({
			name: 'Golden Spire',
			typeLine: 'Artifact',
			oracleText: 'Ascend'
		});
		const readAheadSaga = synthCard({
			name: 'Chronicle of the Deep',
			typeLine: 'Enchantment — Saga',
			oracleText: 'Read ahead\nI — You gain 5 life.\nII — Draw two cards.\nIII — You gain 1 life.'
		});
		assert.equal(compileCard(werewolf).fullySupported, true);
		assert.equal(compileCard(speedster).fullySupported, true);
		assert.equal(compileCard(ascendPerm).fullySupported, true);
		assert.equal(compileCard(readAheadSaga).fullySupported, true);

		const { state, p1, p2 } = setupGame();

		// 1. Daybound sets day; 0 spells on p1's turn -> night at next untap -> transforms to Nightbound!
		const wwHand = putInZone(state, p1, werewolf, 'hand');
		giveMana(p1, { G: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: wwHand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(state.dayNight, 'day');
		const wwPerm = p1.battlefield.find((c) => c.instanceId === wwHand.instanceId)!;
		assert.equal(wwPerm.transformed, false);

		// External transform effect cannot transform a Daybound/Nightbound permanent (CR 702.145c)
		const moonMist = putInZone(
			state,
			p1,
			synthCard({ name: 'Force Shift', manaCost: '{G}', typeLine: 'Instant', oracleText: 'Transform target creature.' }),
			'hand'
		);
		giveMana(p1, { G: 1 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: moonMist.instanceId,
				targets: [{ kind: 'permanent', id: wwPerm.instanceId, label: wwPerm.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(wwPerm.transformed, false, 'Daybound blocks external transform effects');

		// Advance to p2's turn (p1 cast >=2 spells, stays day), then pass p2's turn with 0 spells -> night!
		advanceToPhase(state, 'main1', 1);
		assert.equal(state.dayNight, 'day');
		advanceToPhase(state, 'main1', 0);
		assert.equal(state.dayNight, 'night');
		assert.equal(wwPerm.transformed, true, 'Transformed to Nightbound at night');
		assert.equal(evaluatePermanent(state, wwPerm).power, 4);

		// Daybound creature entering at night enters transformed (CR 702.145b)
		const ww2 = synthCard({ ...werewolf, id: 'syn_ww2', name: 'Hollowhenge Scout' });
		const ww2Hand = putInZone(state, p1, ww2, 'hand');
		giveMana(p1, { G: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: ww2Hand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(p1.battlefield.find((c) => c.instanceId === ww2Hand.instanceId)?.transformed, true);

		// 2. Start your engines! & Max speed
		const spPerm = putInZone(state, p1, speedster, 'battlefield');
		checkStateBasedActions(state);
		assert.equal(p1.speed, 1, 'Start your engines! SBA sets speed to 1');
		assert.equal(evaluatePermanent(state, spPerm).power, 2, 'Not max speed yet');

		const ping = putInZone(
			state,
			p1,
			synthCard({ name: 'Spark Dart', manaCost: '{R}', typeLine: 'Instant', oracleText: '~ deals 1 damage to target player.' }),
			'hand'
		);
		giveMana(p1, { R: 1 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: ping.instanceId,
				targets: [{ kind: 'player', id: 'p2', label: 'Bob' }]
			}).ok,
			true
		);
		resolveAllStack(state);
		resolveAllStack(state);
		assert.equal(p1.speed, 2, 'Opponent life loss on controller turn increased speed to 2');
		p1.speed = 4;
		checkStateBasedActions(state);
		const evMax = evaluatePermanent(state, spPerm);
		assert.equal(evMax.power, 4, 'Max speed — +2/+2 active at speed 4');
		assert.ok(evMax.activeKeywords.includes('Haste'));

		// 3. Ascend SBA at 10 permanents
		putInZone(state, p1, ascendPerm, 'battlefield');
		checkStateBasedActions(state);
		assert.equal(Boolean(p1.hasCitysBlessing), false);
		for (let i = p1.battlefield.length; i < 10; i++) {
			putInZone(
				state,
				p1,
				synthCard({ name: `City Pillar ${i}`, typeLine: 'Artifact', oracleText: '' }),
				'battlefield'
			);
		}
		checkStateBasedActions(state);
		assert.equal(p1.hasCitysBlessing, true, 'Gained city\'s blessing at 10 permanents');
		assert.ok(p2);

		// 4. Read ahead Saga chooses Chapter 2, skips Chapter I, draws 2 cards
		const sagaHand = putInZone(state, p1, readAheadSaga, 'hand');
		const lifeBeforeSaga = p1.life;
		const handBeforeSaga = p1.hand.length;
		giveMana(p1, { W: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: sagaHand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [1] } // Chapter 2
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.life, lifeBeforeSaga, 'Chapter I (+5 life) skipped by Read ahead');
		assert.equal(p1.hand.length, handBeforeSaga - 1 + 2, 'Chapter II drew 2 cards');
	});
});

// ============================================================================
// Group 4 — P15.3 Cast & Cost Keywords (Power-up, Gift, Splice, Cleave, etc.)
// ============================================================================

describe('Track P15.3 — Power-up, Gift, Splice, Cleave, Freerunning, Prowl, Impending, Assist, Living metal & More than meets the eye', () => {
	it('reduces Power-up cost for creatures that entered this turn (once per game), delivers Gift, Splices without losing hand card, and Cleaves bracketed text', () => {
		const { state, p1, p2 } = setupGame();

		// 1. Power-up (CR 702.193): {3}: Draw a card, reduced by permanent's own mana cost ({2}) if it entered this turn
		const powerUpCard = synthCard({
			name: 'Arcade Golem',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact Creature — Construct',
			oracleText: 'Power-up — {3}: Draw a card.',
			power: '2',
			toughness: '2'
		});
		const puPerm = putInZone(state, p1, powerUpCard, 'battlefield');
		// Entered this turn -> {3} reduced by permanent's mana cost {2} to {1}!
		const puAb = getEffectiveActivatedAbilities(state, p1, puPerm)[0];
		giveMana(p1, { W: 1 });
		const puRes = applyGameAction(state, 'p1', {
			type: 'activate_ability',
			instanceId: puPerm.instanceId,
			abilityId: puAb.id
		});
		assert.equal(puRes.ok, true, puRes.error ?? '');
		resolveAllStack(state);
		giveMana(p1, { W: 5 });
		assert.equal(
			checkAbilityActivationLegality(state, 'p1', puPerm, puAb).ok,
			false,
			'Power-up activates only once per game'
		);

		// 2. Gift a card (CR 702.174): opponent draws 1 card and promised branch executes
		const giftSpell = synthCard({
			name: 'Bramble Offering',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Gift a card\nYou gain 2 life. If the gift was promised, you gain 5 life instead.'
		});
		assert.equal(compileCard(giftSpell).fullySupported, true);
		const gHand = putInZone(state, p1, giftSpell, 'hand');
		const p2HandBefore = p2.hand.length;
		const p1LifeBefore = p1.life;
		giveMana(p1, { W: 2 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: gHand.instanceId,
				optionalCostCounts: { 'opt:gift': 1 },
				giftRecipientId: 'p2'
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.hand.length, p2HandBefore + 1, 'Promised Gift a card drew 1 card for Bob');
		assert.equal(p1.life, p1LifeBefore + 5, 'Promised branch granted 5 life');

		// 3. Splice onto Arcane (CR 702.47): splice card stays in hand while appending its effect
		const arcaneBase = synthCard({
			name: 'Spirit Bolt',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant — Arcane',
			oracleText: 'You gain 1 life.'
		});
		const spliceCard = synthCard({
			name: 'Glacial Ray Insight',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant — Arcane',
			oracleText: 'Draw a card.\nSplice onto Arcane {1}{U}'
		});
		assert.equal(compileCard(spliceCard).fullySupported, true);
		const baseInst = putInZone(state, p1, arcaneBase, 'hand');
		const spliceInst = putInZone(state, p1, spliceCard, 'hand');
		const handBeforeSplice = p1.hand.length;
		giveMana(p1, { R: 1, U: 2 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: baseInst.instanceId,
				optionalCostCounts: { [`opt:splice:${spliceInst.instanceId}`]: 1 }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.ok(p1.hand.some((c) => c.instanceId === spliceInst.instanceId), 'Spliced card stayed in hand');
		assert.equal(p1.hand.length, handBeforeSplice - 1 + 1, 'Spliced effect drew 1 card');

		// 4. Cleave (CR 702.148): strips [attacking] restriction so non-attacking creature can be destroyed
		const cleaveSpell = synthCard({
			name: 'Lantern Flare Slash',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Cleave {2}{W}\nDestroy target [attacking] creature.'
		});
		assert.equal(compileCard(cleaveSpell).fullySupported, true);
		const idleTarget = putInZone(
			state,
			p2,
			synthCard({ name: 'Idle Ogre', typeLine: 'Creature — Ogre', power: '3', toughness: '3' }),
			'battlefield'
		);
		const clvHand = putInZone(state, p1, cleaveSpell, 'hand');
		giveMana(p1, { W: 3 });
		// Normal mode fails against non-attacking creature
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: clvHand.instanceId,
				optionId: 'normal',
				targets: [{ kind: 'permanent', id: idleTarget.instanceId, label: idleTarget.card.name }]
			}).ok,
			false
		);
		// Cleaved mode succeeds!
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: clvHand.instanceId,
				optionId: 'alt:cleave',
				targets: [{ kind: 'permanent', id: idleTarget.instanceId, label: idleTarget.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.ok(p2.graveyard.some((c) => c.instanceId === idleTarget.instanceId));
	});

	it('enforces Freerunning, Prowl, Impending non-creature time countdown, Assist generic aid, Living metal, and More than meets the eye', () => {
		const { state, p1, p2 } = setupGame();

		// 1. Freerunning & Prowl unlock after combat damage with matching subtype
		const freerunCard = synthCard({
			name: 'Rooftop Recon',
			manaCost: '{3}{B}',
			cmc: 4,
			typeLine: 'Sorcery',
			oracleText: 'Freerunning {B}\nDraw two cards.'
		});
		const prowlCard = synthCard({
			name: 'Rogue Loot',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Kindred Sorcery — Rogue',
			oracleText: 'Prowl {U}\nDraw two cards.'
		});
		const frHand = putInZone(state, p1, freerunCard, 'hand');
		const prHand = putInZone(state, p1, prowlCard, 'hand');
		giveMana(p1, { B: 1, U: 1 });
		assert.equal(getCastOptions(state, 'p1', frHand, 'hand').some((o) => o.id === 'alt:freerunning'), false);
		assert.equal(getCastOptions(state, 'p1', prHand, 'hand').some((o) => o.id === 'alt:prowl'), false);

		p1.dealtCombatDamageWithSubtypesThisTurn = ['Assassin', 'Rogue'];
		assert.equal(getCastOptions(state, 'p1', frHand, 'hand').some((o) => o.id === 'alt:freerunning'), true);
		assert.equal(getCastOptions(state, 'p1', prHand, 'hand').some((o) => o.id === 'alt:prowl'), true);
		assert.equal(
			applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: frHand.instanceId, optionId: 'alt:freerunning' }).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: prHand.instanceId, optionId: 'alt:prowl' }).ok,
			true
		);
		resolveAllStack(state);

		// 2. Assist (CR 702.132): p2 pays {2} generic while p1 pays {U}
		const assistSpell = synthCard({
			name: 'Shared Schematics',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Assist\nDraw two cards.'
		});
		const asHand = putInZone(state, p1, assistSpell, 'hand');
		giveMana(p1, { U: 1 });
		giveMana(p2, { G: 2 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: asHand.instanceId,
				costAidIds: { 'aid:assist': ['p2', 'p2'] }
			}).ok,
			true
		);
		assert.equal(p2.manaPool.G, 0, 'Assist deducted 2 generic mana from assisting player');
		resolveAllStack(state);

		// 3. Impending (CR 702.176) + Living metal (CR 702.161) & More than meets the eye (CR 702.162)
		const impendingCard = synthCard({
			name: 'Overlord of the Mist',
			manaCost: '{4}{W}',
			cmc: 5,
			typeLine: 'Enchantment Creature — Avatar Glimmer',
			oracleText: 'Impending 1—{1}{W}',
			power: '5',
			toughness: '5'
		});
		const transformerCard = synthCard({
			name: 'Autobot Vanguard',
			layout: 'transform',
			manaCost: '{3}{R}',
			cmc: 4,
			typeLine: 'Legendary Artifact Creature — Robot',
			oracleText: 'More than meets the eye {1}{R}',
			power: '4',
			toughness: '4',
			backFace: {
				name: 'Autobot Cruiser',
				manaCost: '',
				typeLine: 'Legendary Artifact — Vehicle',
				oracleText: 'Living metal',
				power: '3',
				toughness: '3',
				imageUrl: ''
			}
		});
		const impHand = putInZone(state, p1, impendingCard, 'hand');
		const tfHand = putInZone(state, p1, transformerCard, 'hand');
		giveMana(p1, { W: 2, R: 2 });
		assert.equal(
			applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: impHand.instanceId, optionId: 'alt:impending' }).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'cast_spell',
				instanceId: tfHand.instanceId,
				optionId: 'alt:more_than_meets_the_eye'
			}).ok,
			true
		);
		resolveAllStack(state);

		const impPerm = p1.battlefield.find((c) => c.instanceId === impHand.instanceId)!;
		const tfPerm = p1.battlefield.find((c) => c.instanceId === tfHand.instanceId)!;
		assert.equal(impPerm.counters.time, 1);
		assert.equal(evaluatePermanent(state, impPerm).isCreature, false, 'Impending with time counters is not a creature');
		assert.equal(evaluatePermanent(state, tfPerm).isCreature, true, 'Living metal Vehicle IS a creature during your turn');

		// Advance to p2's main1: Impending removed last time counter at p1 end_step -> IS a creature now; Living metal is NOT a creature on opponent's turn!
		advanceToPhase(state, 'main1', 1);
		assert.equal(impPerm.counters.time, 0);
		assert.equal(evaluatePermanent(state, impPerm).isCreature, true, 'Impending becomes a creature once time counters hit 0');
		assert.equal(evaluatePermanent(state, tfPerm).isCreature, false, 'Living metal stops being a creature on opponent turn');
	});
});

// ============================================================================
// Group 5 — P15.3 & P15.4 Permanent, Combat, Trigger, Landwalk, & Persistence
// ============================================================================

describe('Track P15.3 & P15.4 — Craft, Reconfigure, Job select, Cipher, Increment, Provoke, Ripple, Ravenous, Paradigm, Amplify, Demonstrate, Gravestorm, Landwalk, Transfigure, Aura swap, Persistence & Rename Invariance', () => {
	it('executes Craft, Reconfigure, Job select, Transfigure, Aura swap, and case-insensitive Typecycling', () => {
		const { state, p1 } = setupGame();

		// 1. Job select (CR 702.182): creates 1/1 Hero token and attaches Equipment
		const jobBlade = synthCard({
			name: 'Warrior Broadsword',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Artifact — Equipment',
			oracleText: 'Job select\nEquipped creature gets +2/+1.\nEquip {2}'
		});
		const jbHand = putInZone(state, p1, jobBlade, 'hand');
		giveMana(p1, { W: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: jbHand.instanceId }).ok, true);
		resolveAllStack(state);
		resolveAllStack(state);
		const jbPerm = p1.battlefield.find((c) => c.instanceId === jbHand.instanceId)!;
		const heroToken = p1.battlefield.find((c) => c.isToken && c.card.typeLine.includes('Hero'))!;
		assert.ok(heroToken, 'Job select created 1/1 Hero token');
		assert.equal(jbPerm.attachedToId, heroToken.instanceId);
		assert.equal(evaluatePermanent(state, heroToken).power, 3);

		// 2. Reconfigure (CR 702.151): attaches, stops being a creature while attached, and unattaches
		const reconfigJelly = synthCard({
			name: 'Reality Chipper',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Artifact Creature — Equipment Jellyfish',
			oracleText: 'Equipped creature gets +1/+1.\nReconfigure {1}',
			power: '1',
			toughness: '2'
		});
		const rcPerm = putInZone(state, p1, reconfigJelly, 'battlefield');
		assert.equal(evaluatePermanent(state, rcPerm).isCreature, true);
		const rcAttach = getEffectiveActivatedAbilities(state, p1, rcPerm).find(
			(a) => a.costKeyword === 'reconfigure' && !a.id.startsWith('reconfigure_unattach_')
		)!;
		giveMana(p1, { W: 1 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: rcPerm.instanceId,
				abilityId: rcAttach.id,
				targets: [{ kind: 'permanent', id: heroToken.instanceId, label: heroToken.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(rcPerm.attachedToId, heroToken.instanceId);
		assert.equal(evaluatePermanent(state, rcPerm).isCreature, false, 'Reconfigure permanent is non-creature while attached');
		assert.equal(evaluatePermanent(state, heroToken).power, 4);

		const rcUnattach = getEffectiveActivatedAbilities(state, p1, rcPerm).find((a) =>
			a.id.startsWith('reconfigure_unattach_')
		)!;
		giveMana(p1, { W: 1 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: rcPerm.instanceId,
				abilityId: rcUnattach.id
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(rcPerm.attachedToId, null);
		assert.equal(evaluatePermanent(state, rcPerm).isCreature, true);

		// 3. Craft with artifact (CR 702.167)
		const craftIdol = synthCard({
			name: 'Sunforge Totem',
			layout: 'transform',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: 'Craft with artifact {2}',
			backFace: {
				name: 'Sunforge Colossus',
				manaCost: '',
				typeLine: 'Artifact Creature — Golem',
				oracleText: 'Vigilance',
				power: '5',
				toughness: '5',
				imageUrl: ''
			}
		});
		const scrapMat = putInZone(
			state,
			p1,
			synthCard({ name: 'Scrap Cog', typeLine: 'Artifact', oracleText: '' }),
			'graveyard'
		);
		const craftPerm = putInZone(state, p1, craftIdol, 'battlefield');
		const craftAb = getEffectiveActivatedAbilities(state, p1, craftPerm).find((a) => a.id.startsWith('craft_'))!;
		giveMana(p1, { W: 2 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: craftPerm.instanceId,
				abilityId: craftAb.id
			}).ok,
			true
		);
		resolveAllStack(state);
		const colossus = p1.battlefield.find((c) => c.instanceId === craftPerm.instanceId)!;
		assert.equal(colossus.transformed, true);
		assert.equal(colossus.craftedWithCards?.length, 1);
		assert.equal(colossus.craftedWithCards?.[0].name, scrapMat.card.name);
		assert.equal(evaluatePermanent(state, colossus).power, 5);

		// 4. Transfigure (CR 702.71) & Aura swap (CR 702.65) & mid-line Wizardcycling
		const cyclingMage = synthCard({
			name: 'Aether Adept',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Creature — Human Wizard',
			oracleText: 'Flying, Wizardcycling {2}',
			power: '2',
			toughness: '2'
		});
		assert.equal(compileCard(cyclingMage).fullySupported, true);

		const transfigurer = synthCard({
			name: 'Flesh Sculptor',
			manaCost: '{1}{B}{B}',
			cmc: 3,
			typeLine: 'Creature — Horror',
			oracleText: 'Transfigure {1}{B}',
			power: '2',
			toughness: '2'
		});
		const libTarget = putInZone(state, p1, cyclingMage, 'library');
		const tfPerm = putInZone(state, p1, transfigurer, 'battlefield');
		const tfAb = getEffectiveActivatedAbilities(state, p1, tfPerm).find((a) => a.id.startsWith('transfigure_'))!;
		giveMana(p1, { B: 2 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: tfPerm.instanceId,
				abilityId: tfAb.id
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [libTarget.instanceId] }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.ok(p1.battlefield.some((c) => c.instanceId === libTarget.instanceId));

		// Aura swap exchanges attached Aura on battlefield with Aura card in hand
		const swapAura = synthCard({
			name: 'Arcane Wings',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.\nAura swap {1}{U}'
		});
		const bigAura = synthCard({
			name: 'Eldrazi Conscription Synth',
			manaCost: '{8}',
			cmc: 8,
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant creature\nEnchanted creature gets +6/+6.'
		});
		const auraOnBoard = putInZone(state, p1, swapAura, 'battlefield');
		auraOnBoard.attachedToId = heroToken.instanceId;
		const auraInHand = putInZone(state, p1, bigAura, 'hand');
		const swapAb = getEffectiveActivatedAbilities(state, p1, auraOnBoard).find((a) => a.id.startsWith('aura_swap_'))!;
		giveMana(p1, { U: 2 });
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'activate_ability',
				instanceId: auraOnBoard.instanceId,
				abilityId: swapAb.id
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [auraInHand.instanceId] }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.ok(p1.hand.some((c) => c.instanceId === auraOnBoard.instanceId));
		assert.equal(
			p1.battlefield.find((c) => c.instanceId === auraInHand.instanceId)?.attachedToId,
			heroToken.instanceId
		);
		assert.equal(evaluatePermanent(state, heroToken).power, 9);
	});

	it('triggers Cipher, Increment, Provoke, Ripple, Ravenous, Paradigm, Amplify, Demonstrate, and Gravestorm cleanly', () => {
		const { state, p1, p2 } = setupGame({ p1Bot: true, p2Bot: true });
		p1.isBot = false;
		p2.isBot = false;

		// 1. Increment (CR 702.191) + Ravenous (CR 702.156) + Amplify (CR 702.38)
		const incCreature = putInZone(
			state,
			p1,
			synthCard({
				name: 'Sapling Grower',
				typeLine: 'Creature — Plant',
				oracleText: 'Increment',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const ravenousHydra = synthCard({
			name: 'Voracious Maw',
			manaCost: '{X}{G}',
			cmc: 1,
			typeLine: 'Creature — TyranidBeast',
			oracleText: 'Ravenous',
			power: '0',
			toughness: '0'
		});
		const ravHand = putInZone(state, p1, ravenousHydra, 'hand');
		const handBeforeRav = p1.hand.length;
		giveMana(p1, { G: 6 });
		assert.equal(
			applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: ravHand.instanceId, xValue: 5 }).ok,
			true
		);
		// Mana spent = 6 > 1 -> Increment triggers! Ravenous X=5 >= 5 -> draws a card on ETB!
		resolveAllStack(state);
		resolveAllStack(state);
		assert.equal(incCreature.counters['+1/+1'], 1, 'Increment placed +1/+1 counter');
		const ravPerm = p1.battlefield.find((c) => c.instanceId === ravHand.instanceId)!;
		assert.equal(ravPerm.counters['+1/+1'], 5, 'Ravenous entered with 5 +1/+1 counters');
		assert.equal(p1.hand.length, handBeforeRav - 1 + 1, 'Ravenous X>=5 drew a card');

		// Amplify 2 reveals matching Beast card in hand -> +2/+2 counters on ETB
		const beastInHand = putInZone(
			state,
			p1,
			synthCard({ name: 'Crag Beast', typeLine: 'Creature — Beast', power: '3', toughness: '3' }),
			'hand'
		);
		const ampBeast = putInZone(
			state,
			p1,
			synthCard({
				name: 'Amplified Herdleader',
				manaCost: '{2}{G}',
				typeLine: 'Creature — Beast',
				oracleText: 'Amplify 2',
				power: '2',
				toughness: '2'
			}),
			'hand'
		);
		giveMana(p1, { G: 3 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: ampBeast.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [beastInHand.instanceId] }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			p1.battlefield.find((c) => c.instanceId === ampBeast.instanceId)?.counters['+1/+1'],
			2
		);

		// 2. Ripple 4 (CR 702.60), Demonstrate (CR 702.144), Gravestorm (CR 702.69)
		const rippleSpell = synthCard({
			name: 'SurgingVitality',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Ripple 4\nYou gain 3 life.'
		});
		putInZone(state, p1, rippleSpell, 'library'); // top of library matches name!
		const ripHand = putInZone(state, p1, rippleSpell, 'hand');
		const lifeBeforeRip = p1.life;
		giveMana(p1, { W: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: ripHand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(p1.life, lifeBeforeRip + 6, 'Ripple 4 cast matching copy from library for +6 total life');

		// Demonstrate copies for both caster and opponent
		const demoSpell = synthCard({
			name: 'Dual Lecture',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Demonstrate\nYou gain 2 life.'
		});
		const demoHand = putInZone(state, p1, demoSpell, 'hand');
		const p1LifeDemo = p1.life;
		const p2LifeDemo = p2.life;
		giveMana(p1, { W: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: demoHand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.life, p1LifeDemo + 4, 'Caster resolved original + Demonstrate copy');
		assert.equal(p2.life, p2LifeDemo + 2, 'Opponent resolved their Demonstrate copy');

		// Gravestorm copies once per permanent put into graveyard from battlefield this turn
		const doomed = putInZone(
			state,
			p1,
			synthCard({ name: 'Doomed Relic', typeLine: 'Artifact', oracleText: '' }),
			'battlefield'
		);
		moveObject(state, doomed, 'graveyard', {
			from: 'anyBattlefield',
			bumpVersion: true,
			leaveBattlefieldReset: true
		});
		const gsSpell = synthCard({
			name: 'Bitter Gravestorm',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'You gain 1 life.\nGravestorm'
		});
		const gsHand = putInZone(state, p1, gsSpell, 'hand');
		const lifeBeforeGs = p1.life;
		giveMana(p1, { B: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: gsHand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(p1.life, lifeBeforeGs + 2, 'Gravestorm created 1 copy for the 1 permanent that died');

		// 3. Cipher (CR 702.99) + Provoke (CR 702.39) + Paradigm (CR 702.192)
		const cipherSpell = synthCard({
			name: 'Whispering Cipher',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'You gain 2 life.\nCipher'
		});
		const provoker = putInZone(
			state,
			p1,
			synthCard({
				name: 'Taunting Hunter',
				typeLine: 'Creature — Beast',
				oracleText: 'Provoke',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const tappedDefender = putInZone(
			state,
			p2,
			synthCard({ name: 'Sleepy Guard', typeLine: 'Creature — Soldier', power: '1', toughness: '1' }),
			'battlefield'
		);
		tappedDefender.tapped = true;

		const cipHand = putInZone(state, p1, cipherSpell, 'hand');
		giveMana(p1, { U: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: cipHand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [incCreature.instanceId] }
			}).ok,
			true
		);
		assert.equal(incCreature.encodedSpellCards?.length, 1, 'Cipher encoded spell onto creature');

		const paradigmSpell = synthCard({
			name: 'Eternal Paradigm',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Paradigm\nYou gain 3 life.'
		});
		const parHand = putInZone(state, p1, paradigmSpell, 'hand');
		giveMana(p1, { W: 2 });
		assert.equal(applyGameAction(state, 'p1', { type: 'cast_spell', instanceId: parHand.instanceId }).ok, true);
		resolveAllStack(state);
		assert.ok(p1.exile.some((c) => c.instanceId === parHand.instanceId), 'Paradigm exiled spell on resolve');

		// Attack with both incCreature (encoded Cipher) and provoker (Provoke untaps Sleepy Guard and forces block!)
		advanceToPhase(state, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: incCreature.instanceId, defenderPlayerId: 'p2' },
					{ attackerInstanceId: provoker.instanceId, defenderPlayerId: 'p2' }
				]
			}).ok,
			true
		);
		// Human attacker selects tappedDefender as the Provoke trigger target
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [tappedDefender.instanceId] }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(tappedDefender.tapped, false, 'Provoke untapped defending creature');
		assert.equal(tappedDefender.provokeMustBlockId, provoker.instanceId);

		// p2 must block provoker with tappedDefender; incCreature goes unblocked and triggers Cipher!
		advanceToPhase(state, 'declare_blockers', 0);
		assert.equal(
			applyGameAction(state, 'p2', { type: 'declare_blockers', assignments: [] }).ok,
			false,
			'Provoke forces Sleepy Guard to block Taunting Hunter'
		);
		assert.equal(
			applyGameAction(state, 'p2', {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: tappedDefender.instanceId, attackerInstanceId: provoker.instanceId }]
			}).ok,
			true
		);
		const lifeBeforeCipherHit = p1.life;
		for (let guard = 0; guard < 20; guard++) {
			if (state.pendingPrompts.length > 0 || state.stack.length > 0) break;
			const prio = state.players[state.priorityPlayerIndex];
			if (!prio) break;
			const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
			assert.equal(res.ok, true, res.error ?? '');
		}
		resolveAllStack(state);
		// Cipher combat damage trigger prompts yesNo to cast free copy
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.life, lifeBeforeCipherHit + 2, 'Cipher cast free copy on combat damage to player');

		// Next turn cycle: beginning of p1's main1 triggers Paradigm free copy!
		advanceToPhase(state, 'main1', 1);
		for (let guard = 0; guard < 40; guard++) {
			if (state.activePlayerIndex === 0 && state.pendingPrompts.length > 0) break;
			const prio = state.players[state.priorityPlayerIndex];
			if (!prio) break;
			applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		}
		assert.equal(state.pendingPrompts.length, 1, 'Paradigm triggered at beginning of main1');
		const lifeBeforeParadigmCopy = p1.life;
		assert.equal(
			applyGameAction(state, 'p1', {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.life, lifeBeforeParadigmCopy + 3, 'Paradigm main1 copy gained 3 life');
	});

	it('enforces all Snow/Legendary/Artifact landwalk evasion variants (CR 702.14), JSON round-trip persistence, and synthetic rename invariance', () => {
		const landwalkSpecs: Array<{ kw: string; landTypeLine: string }> = [
			{ kw: 'snow landwalk', landTypeLine: 'Basic Snow Land — Wastes' },
			{ kw: 'snow plainswalk', landTypeLine: 'Basic Snow Land — Plains' },
			{ kw: 'snow islandwalk', landTypeLine: 'Basic Snow Land — Island' },
			{ kw: 'snow swampwalk', landTypeLine: 'Basic Snow Land — Swamp' },
			{ kw: 'snow mountainwalk', landTypeLine: 'Basic Snow Land — Mountain' },
			{ kw: 'snow forestwalk', landTypeLine: 'Basic Snow Land — Forest' },
			{ kw: 'legendary landwalk', landTypeLine: 'Legendary Land' },
			{ kw: 'artifact landwalk', landTypeLine: 'Artifact Land' }
		];

		for (const { kw, landTypeLine } of landwalkSpecs) {
			const { state, p1, p2 } = setupGame();
			const walker = putInZone(
				state,
				p1,
				synthCard({
					name: `Walker of ${kw}`,
					typeLine: 'Creature — Scout',
					oracleText: kw.charAt(0).toUpperCase() + kw.slice(1),
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			assert.equal(hasKeyword(walker, kw, state), true);
			putInZone(
				state,
				p2,
				synthCard({ name: `Land for ${kw}`, manaCost: '', cmc: 0, typeLine: landTypeLine }),
				'battlefield'
			);
			const blocker = putInZone(
				state,
				p2,
				synthCard({ name: 'Wall Blocker', typeLine: 'Creature — Wall', power: '0', toughness: '4' }),
				'battlefield'
			);
			advanceToPhase(state, 'declare_attackers', 0);
			assert.equal(
				applyGameAction(state, 'p1', {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: walker.instanceId, defenderPlayerId: 'p2' }]
				}).ok,
				true
			);
			advanceToPhase(state, 'declare_blockers', 0);
			const blk = applyGameAction(state, 'p2', {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blocker.instanceId, attackerInstanceId: walker.instanceId }]
			});
			assert.equal(blk.ok, false, `Expected "${kw}" to make attacker unblockable when defender controls ${landTypeLine}`);
		}

		// JSON round-trip persistence & synthetic rename invariance (ENGINE_INVARIANTS.md §1.3 & §7.1)
		const cardA = synthCard({
			name: 'Invasion of Zendikar',
			layout: 'transform',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Battle — Siege',
			oracleText: 'When Invasion of Zendikar enters, you gain 2 life.',
			defense: '3',
			backFace: {
				name: 'Awakened Skyclave',
				manaCost: '',
				typeLine: 'Creature — Elemental',
				oracleText: 'Vigilance',
				power: '4',
				toughness: '4',
				imageUrl: ''
			}
		});
		const cardB = synthCard({
			...cardA,
			id: 'syn_rename_b',
			name: 'Assault on Glimmerspire',
			oracleText: 'When Assault on Glimmerspire enters, you gain 2 life.',
			backFace: {
				...cardA.backFace!,
				name: 'Risen Glimmerspire'
			}
		});
		const defA = compileCard(cardA);
		const defB = compileCard(cardB);
		assert.equal(defA.fullySupported, true);
		assert.equal(defB.fullySupported, true);
		assert.deepEqual(
			defA.faces[0].abilities.map((a) => (a.kind === 'triggered' ? a.effect : null)),
			defB.faces[0].abilities.map((a) => (a.kind === 'triggered' ? a.effect : null))
		);

		const g1 = setupGame();
		putInZone(g1.state, g1.p1, cardB, 'battlefield').protectorId = 'p2';
		runBeginningOfTurn(g1.state);
		const roundTripped = JSON.parse(JSON.stringify(g1.state)) as GameState;
		assert.equal(JSON.stringify(roundTripped), JSON.stringify(g1.state));
	});
});
