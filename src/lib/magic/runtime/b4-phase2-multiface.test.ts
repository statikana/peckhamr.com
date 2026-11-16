import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeBotStep } from '../ai.ts';
import {
	COMPILER_VERSION,
	abilityById,
	cardManaSteps,
	compileCard,
	compileSpellEffects
} from '../compiler/index.ts';
import {
	applyGameAction,
	checkSpellCastLegality,
	checkUnlockRoomDoorLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	getLandPlayOptions
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { getCardActivatedAbilities } from '../ruleTree.ts';
import { resolveObjectFaces } from './faces.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';

function staple(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	assert.ok(c, `missing staple ${name}`);
	return c;
}

function synth(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	const base: ScryfallCard = {
		id: `b4p2_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '',
		cmc: overrides.cmc ?? 0,
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
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false
	};
	return { ...base, ...overrides };
}

function makeGame(opts?: { p1Bot?: boolean }): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	for (let i = 0; i < 2; i++) {
		const d = PRECON_DECKS[i % PRECON_DECKS.length];
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: i === 0 ? Boolean(opts?.p1Bot) : false,
			deckId: d.id,
			deckName: d.name,
			commanderNames: d.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		});
		decks.set(i, d);
	}
	const state = createInitialGameState('B4_PHASE2_TEST', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (let i = 0; i < 2; i++) {
		applyGameAction(state, `p${i + 1}`, { type: 'mulligan_keep' });
	}
	for (let i = 0; i < 2; i++) {
		state.players[i].hand = [];
		state.players[i].battlefield = [];
		state.players[i].graveyard = [];
		state.players[i].exile = [];
		state.players[i].command = [];
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: Exclude<ZoneType, 'stack'>,
	overrides?: Partial<CardInstance>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (overrides) Object.assign(inst, overrides);
	player[zone].push(inst);
	return inst;
}

function resolveAllStack(state: GameState, maxSteps = 40): void {
	for (let i = 0; i < maxSteps && state.stack.length > 0; i++) {
		const prompt = state.pendingPrompts[0];
		if (prompt) {
			if (prompt.choice?.kind === 'yesNo') {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: { kind: 'yesNo', yes: false }
				});
				continue;
			}
			break;
		}
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		if (!res.ok) break;
	}
}

describe('B4 Phase 2: Modal DFC (Spell // Land, Spell // Spell, Creature // Artifact)', () => {
	function makeSpellLandMdfc(frontName = 'Verdant Pulse', backName = 'Verdant Sanctum'): ScryfallCard {
		return synth({
			name: `${frontName} // ${backName}`,
			layout: 'modal_dfc',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Sorcery // Land',
			colors: ['G'],
			faces: [
				{
					name: frontName,
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Sorcery',
					oracleText: 'Draw a card.',
					colors: ['G'],
					imageUrl: 'front.png',
					artCropUrl: 'front-art.png'
				},
				{
					name: backName,
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: 'This land enters tapped.\n{T}: Add {G}.',
					colors: [],
					imageUrl: 'back.png',
					artCropUrl: 'back-art.png'
				}
			]
		});
	}

	it('casts front spell face or plays back land face with activeFaceIndex, mana ability, and ETB tapped replacement', () => {
		const mdfc = makeSpellLandMdfc();
		const def = compileCard(mdfc);
		assert.equal(def.compilerVersion, COMPILER_VERSION);
		assert.equal(def.faces.length, 2);
		assert.equal(
			def.faces.some((f) => f.abilities.some((a) => a.kind === 'unsupported')),
			false
		);
		assert.ok(cardManaSteps(mdfc).length >= 1);

		// Path A: cast face 0 (Sorcery -> draws a card)
		const { state: s1, p1: p1a } = makeGame();
		p1a.library = [];
		const cardA = putInZone(s1, p1a, mdfc, 'hand');
		const topLib = putInZone(s1, p1a, staple('Forest'), 'library');
		const landOptsA = getLandPlayOptions(s1, p1a.playerId, cardA, 'hand');
		assert.equal(landOptsA.length, 1);
		assert.equal(landOptsA[0].faceIndex, 1);

		p1a.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 2, C: 0 };
		const castOptsA = getCastOptions(s1, p1a.playerId, cardA, 'hand');
		assert.equal(castOptsA.some((o) => (o.faceIndex ?? 0) === 0), true);
		assert.equal(castOptsA.some((o) => o.faceIndex === 1), false);

		// Direct cast of land face must fail
		const illegalCastLand = checkSpellCastLegality(s1, p1a.playerId, cardA, 'hand', 0, undefined, undefined, 1);
		assert.equal(illegalCastLand.ok, false);

		const castRes = applyGameAction(s1, p1a.playerId, {
			type: 'cast_spell',
			instanceId: cardA.instanceId,
			fromZone: 'hand',
			faceIndex: 0,
			targets: []
		});
		assert.equal(castRes.ok, true, castRes.error ?? 'castRes');
		assert.equal(s1.stack[0].title, 'Verdant Pulse');
		resolveAllStack(s1);
		assert.equal(p1a.hand.some((c) => c.instanceId === topLib.instanceId), true);
		assert.equal(p1a.graveyard.some((c) => c.instanceId === cardA.instanceId), true);

		// Path B: play face 1 as Land -> enters tapped, activeFaceIndex = 1, can tap for {G}
		const { state: s2, p1: p1b } = makeGame();
		const cardB = putInZone(s2, p1b, mdfc, 'hand');
		const playRes = applyGameAction(s2, p1b.playerId, {
			type: 'play_land',
			instanceId: cardB.instanceId,
			fromZone: 'hand',
			faceIndex: 1
		});
		assert.equal(playRes.ok, true, playRes.error ?? 'playRes');
		const perm = p1b.battlefield.find((c) => c.instanceId === cardB.instanceId)!;
		assert.ok(perm);
		assert.equal(perm.activeFaceIndex, 1);
		assert.equal(perm.tapped, true); // ETB tapped from back face

		const bfView = resolveObjectFaces(perm.card, { zone: 'battlefield', faceIndex: perm.activeFaceIndex });
		assert.equal(bfView.name, 'Verdant Sanctum');
		assert.equal(bfView.imageUrl, 'back.png');

		perm.tapped = false;
		const tapRes = applyGameAction(s2, p1b.playerId, {
			type: 'tap_mana',
			instanceId: perm.instanceId
		});
		assert.equal(tapRes.ok, true, tapRes.error ?? 'tapRes');
		assert.equal(p1b.manaPool.G, 1);
	});

	it('lets bot AI play an MDFC back land face via getLandPlayOptions without card-name/layout checks', () => {
		const mdfc = makeSpellLandMdfc('Boltable Bolt', 'Tapland Sanctum');
		const { state, p1 } = makeGame({ p1Bot: true });
		const card = putInZone(state, p1, mdfc, 'hand');
		// Bot has 0 mana and 1 land drop available -> plays back face as land
		const step = executeBotStep(state, p1, p1);
		assert.equal(step, 'visible');
		const perm = p1.battlefield.find((c) => c.instanceId === card.instanceId);
		assert.ok(perm);
		assert.equal(perm.activeFaceIndex, 1);
		assert.equal(p1.landsPlayedThisTurn, 1);
	});

	it('casts back face of Creature // Artifact MDFC onto battlefield with activeFaceIndex: 1 and preserves LKI face', () => {
		const mdfc = synth({
			name: 'Front Squire // Back Relic',
			layout: 'modal_dfc',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human // Artifact',
			colors: ['W'],
			faces: [
				{
					name: 'Front Squire',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Creature — Human',
					oracleText: '',
					colors: ['W'],
					power: '2',
					toughness: '1',
					imageUrl: ''
				},
				{
					name: 'Back Relic',
					manaCost: '{3}',
					cmc: 3,
					typeLine: 'Artifact',
					oracleText: 'When ~ enters, draw a card.\nWhen ~ leaves the battlefield, draw a card.\n{T}: Add {C}.',
					colors: [],
					imageUrl: ''
				}
			]
		});

		const { state, p1 } = makeGame();
		p1.library = [];
		const card = putInZone(state, p1, mdfc, 'hand');
		const drawn = putInZone(state, p1, staple('Plains'), 'library');
		const drawn2 = putInZone(state, p1, staple('Island'), 'library');
		const shatter = putInZone(
			state,
			p1,
			synth({
				name: 'Shatter Test',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Destroy target artifact.',
				colors: ['R']
			}),
			'hand'
		);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 3 };

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: card.instanceId,
			fromZone: 'hand',
			faceIndex: 1,
			targets: []
		});
		assert.equal(castRes.ok, true, castRes.error ?? 'castRes');
		assert.equal(state.stack[0].faceIndex, 1);
		resolveAllStack(state);

		const perm = p1.battlefield.find((c) => c.instanceId === card.instanceId)!;
		assert.ok(perm);
		assert.equal(perm.activeFaceIndex, 1);
		assert.equal(evaluatePermanent(state, perm).isCreature, false);
		assert.equal(evaluatePermanent(state, perm).isArtifact, true);
		assert.equal(p1.hand.some((c) => c.instanceId === drawn.instanceId), true);

		// Destroy Back Relic -> LKI should preserve activeFaceIndex: 1 so back face's LTB trigger fires
		const destroyRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: shatter.instanceId,
			fromZone: 'hand',
			targets: [{ kind: 'permanent', id: perm.instanceId, label: 'Back Relic' }]
		});
		assert.equal(destroyRes.ok, true, destroyRes.error ?? 'destroyRes');
		resolveAllStack(state);
		assert.equal(p1.hand.some((c) => c.instanceId === drawn2.instanceId), true);
	});
});

describe('B4 Phase 2: Adventure (CR 716.3d)', () => {
	function makeAdventureCard(creatureName = 'Wandering Knight', advName = 'Swift Quest'): ScryfallCard {
		return synth({
			name: `${creatureName} // ${advName}`,
			layout: 'adventure',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Knight // Instant — Adventure',
			colors: ['W'],
			power: '3',
			toughness: '2',
			faces: [
				{
					name: creatureName,
					manaCost: '{2}{W}',
					cmc: 3,
					typeLine: 'Creature — Knight',
					oracleText: 'Vigilance',
					colors: ['W'],
					keywords: ['Vigilance'],
					power: '3',
					toughness: '2',
					imageUrl: 'creature.png'
				},
				{
					name: advName,
					manaCost: '{W}',
					cmc: 1,
					typeLine: 'Instant — Adventure',
					oracleText: 'You gain 3 life.',
					colors: ['W'],
					imageUrl: 'adv.png'
				}
			]
		});
	}

	it('exiles resolving Adventure on an adventure (allowedFaceIndices: [0]), allows casting Creature from exile, blocks re-casting Adventure, and passes rename invariance', () => {
		for (const [cName, aName] of [
			['Wandering Knight', 'Swift Quest'],
			['Renamed Hero', 'Renamed Trial']
		]) {
			const advCard = makeAdventureCard(cName, aName);
			const { state, p1 } = makeGame();
			const card = putInZone(state, p1, advCard, 'hand');

			// Step 1: cast Adventure half (face 1)
			p1.manaPool = { W: 1, U: 0, B: 0, R: 0, G: 0, C: 0 };
			const castAdv = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: card.instanceId,
				fromZone: 'hand',
				faceIndex: 1,
				targets: []
			});
			assert.equal(castAdv.ok, true, castAdv.error ?? 'castAdv');
			assert.equal(state.stack[0].title, aName);
			assert.equal(state.stack[0].spellMods?.exileAdventureOnResolve, true);

			resolveAllStack(state);
			assert.equal(p1.life, 43);
			const exiled = p1.exile.find((c) => c.instanceId === card.instanceId);
			assert.ok(exiled, 'Adventure should resolve into exile (CR 716.3d)');
			assert.equal(exiled.playableFromExileBy?.onAdventure, true);
			assert.deepEqual(exiled.playableFromExileBy?.allowedFaceIndices, [0]);

			// Step 2: from exile on adventure, only face 0 (Creature) is castable; face 1 (Adventure) is blocked
			p1.manaPool = { W: 1, U: 0, B: 0, R: 0, G: 0, C: 2 };
			const exileOpts = getCastOptions(state, p1.playerId, exiled, 'exile');
			assert.equal(exileOpts.some((o) => (o.faceIndex ?? 0) === 0), true);
			assert.equal(exileOpts.some((o) => o.faceIndex === 1), false);

			const reAdv = checkSpellCastLegality(state, p1.playerId, exiled, 'exile', 0, undefined, undefined, 1);
			assert.equal(reAdv.ok, false);

			// Step 3: cast Creature face 0 from exile -> resolves to battlefield
			const castCreat = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: exiled.instanceId,
				fromZone: 'exile',
				faceIndex: 0,
				targets: []
			});
			assert.equal(castCreat.ok, true, castCreat.error ?? 'castCreat');
			resolveAllStack(state);
			const perm = p1.battlefield.find((c) => c.instanceId === exiled.instanceId);
			assert.ok(perm);
			assert.equal(perm.playableFromExileBy, undefined);
		}
	});

	it('sends a countered Adventure to graveyard instead of exile (CR 716.3d only applies on resolution)', () => {
		const advCard = makeAdventureCard();
		const { state, p1, p2 } = makeGame();
		const card = putInZone(state, p1, advCard, 'hand');
		const counterSpell = putInZone(state, p2, staple('Counterspell'), 'hand');

		p1.manaPool.W = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: card.instanceId,
				fromZone: 'hand',
				faceIndex: 1,
				targets: []
			}).ok,
			true
		);
		const advStackId = state.stack[0].id;
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		p2.manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: counterSpell.instanceId,
				fromZone: 'hand',
				targets: [{ kind: 'stack', id: advStackId, label: advCard.faces![1].name }]
			}).ok,
			true
		);

		resolveAllStack(state);
		assert.equal(p1.exile.some((c) => c.instanceId === card.instanceId), false);
		assert.equal(p1.graveyard.some((c) => c.instanceId === card.instanceId), true);
	});
});

describe('B4 Phase 2: Rooms (CR 709.5)', () => {
	function makeRoomCard(leftName = 'Study Alcove', rightName = 'Vault Workshop'): ScryfallCard {
		return synth({
			name: `${leftName} // ${rightName}`,
			layout: 'split',
			manaCost: '{1}{U} // {2}{R}',
			cmc: 5,
			typeLine: 'Enchantment — Room // Enchantment — Room',
			colors: ['U', 'R'],
			faces: [
				{
					name: leftName,
					manaCost: '{1}{U}',
					cmc: 2,
					typeLine: 'Enchantment — Room',
					oracleText: '{1}{U}, {T}: Draw a card.',
					colors: ['U'],
					imageUrl: 'left-room.png'
				},
				{
					name: rightName,
					manaCost: '{2}{R}',
					cmc: 3,
					typeLine: 'Enchantment — Room',
					oracleText: '{R}, {T}: You gain 2 life.\nCreatures you control get +1/+0.',
					colors: ['R'],
					imageUrl: 'right-room.png'
				}
			]
		});
	}

	it('casts one Room door, keeps the other locked until sorcery-speed unlock_room_door, scopes statics, and disambiguates colliding act_0 across unlocked doors', () => {
		for (const [leftName, rightName] of [
			['Study Alcove', 'Vault Workshop'],
			['Crystal Hall', 'Ember Chamber']
		]) {
			const roomCard = makeRoomCard(leftName, rightName);
			const def = compileCard(roomCard);
			assert.equal(def.faces.length, 2);
			const abLeft = abilityById(roomCard, 'f0:act_0');
			const abRight = abilityById(roomCard, 'f1:act_0');
			assert.ok(
				abLeft &&
					abRight &&
					abLeft.kind === 'activated' &&
					abRight.kind === 'activated' &&
					abLeft.id === 'act_0' &&
					abRight.id === 'act_0'
			);

			const { state, p1 } = makeGame();
			p1.library = [];
			const card = putInZone(state, p1, roomCard, 'hand');
			const bear = putInZone(
				state,
				p1,
				synth({
					name: 'Test Grizzly',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const lib1 = putInZone(state, p1, staple('Island'), 'library');
			const lib2 = putInZone(state, p1, staple('Mountain'), 'library');

			// Cast left door (face 0) -> enters with unlockedFaces: [0] only
			p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 };
			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: card.instanceId,
				fromZone: 'hand',
				faceIndex: 0,
				targets: []
			});
			assert.equal(castRes.ok, true, castRes.error ?? 'castRes');
			resolveAllStack(state);

			const perm = p1.battlefield.find((c) => c.instanceId === card.instanceId)!;
			assert.deepEqual(perm.unlockedFaces, [0]);
			// Right door static (+1/+0) must NOT apply while locked
			assert.equal(evaluatePermanent(state, bear).power, 2);
			// Left door activated ability is active; right door's is not
			const abs1 = getEffectiveActivatedAbilities(state, p1, perm);
			assert.equal(abs1.length, 1);
			assert.equal(abs1[0].faceIndex, 0);

			// Instant-speed / off-turn unlock must fail
			state.activePlayerIndex = 1;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 2 };
			assert.equal(checkUnlockRoomDoorLegality(state, p1.playerId, perm, 1).ok, false);
			state.activePlayerIndex = 0;

			// Sorcery-speed unlock of door 1 succeeds immediately (special action, does not use stack)
			assert.equal(checkUnlockRoomDoorLegality(state, p1.playerId, perm, 1).ok, true);
			const unlockRes = applyGameAction(state, p1.playerId, {
				type: 'unlock_room_door',
				instanceId: perm.instanceId,
				faceIndex: 1
			});
			assert.equal(unlockRes.ok, true, unlockRes.error ?? 'unlockRes');
			assert.equal(state.stack.length, 0);
			assert.deepEqual(perm.unlockedFaces, [0, 1]);

			// Already-unlocked door rejects
			assert.equal(checkUnlockRoomDoorLegality(state, p1.playerId, perm, 1).ok, false);

			// Right door static (+1/+0) NOW applies!
			assert.equal(evaluatePermanent(state, bear).power, 3);

			// Both doors' colliding act_0 are cleanly disambiguated as f0:act_0 and f1:act_0
			const absBoth = getEffectiveActivatedAbilities(state, p1, perm);
			assert.equal(absBoth.length, 2);
			assert.equal(absBoth[0].id, 'f0:act_0');
			assert.equal(absBoth[1].id, 'f1:act_0');

			// Activate f1:act_0 ({R}, {T}: gain 2 life) and verify it runs door 1's effect, not door 0's
			const handBefore = p1.hand.length;
			const lifeBefore = p1.life;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
			const act1 = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: perm.instanceId,
				abilityId: 'f1:act_0',
				targets: []
			});
			assert.equal(act1.ok, true, act1.error ?? 'act1');
			resolveAllStack(state);
			assert.equal(p1.life, lifeBefore + 2);
			assert.equal(p1.hand.length, handBefore);

			// Untap and activate f0:act_0 ({1}{U}, {T}: Draw a card)
			perm.tapped = false;
			p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 };
			const act0 = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: perm.instanceId,
				abilityId: 'f0:act_0',
				targets: []
			});
			assert.equal(act0.ok, true, act0.error ?? 'act0');
			resolveAllStack(state);
			assert.equal(p1.hand.length, handBefore + 1);
			assert.equal(
				p1.hand.some((c) => c.instanceId === lib1.instanceId || c.instanceId === lib2.instanceId),
				true
			);
		}
	});

	it('keeps both Room doors locked if placed on battlefield without casting (CR 709.5)', () => {
		const roomCard = makeRoomCard();
		const { state, p1 } = makeGame();
		const perm = putInZone(state, p1, roomCard, 'battlefield');
		assert.equal(perm.unlockedFaces, undefined);
		const view = resolveObjectFaces(perm.card, { zone: 'battlefield', unlockedFaces: perm.unlockedFaces });
		assert.deepEqual(view.activeFaceIndices, []);
		assert.equal(
			getCardActivatedAbilities(perm.card, [], undefined, {
				zone: 'battlefield',
				unlockedFaces: perm.unlockedFaces
			}).length,
			0
		);
		assert.equal(getEffectiveActivatedAbilities(state, p1, perm).length, 0);

		p1.manaPool = { W: 0, U: 1, B: 0, R: 1, G: 0, C: 5 };
		assert.equal(checkUnlockRoomDoorLegality(state, p1.playerId, perm, 0).ok, true);
		assert.equal(checkUnlockRoomDoorLegality(state, p1.playerId, perm, 1).ok, true);
	});
});
