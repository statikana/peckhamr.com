import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	getEffectiveActivatedAbilities,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { buildTokenScryfallCard, PREDEFINED_TOKEN_DEFS } from '../oracle.ts';
import { PRECON_DECKS } from '../precons.ts';
import { effectivePromptChoice } from './choices.ts';
import { subscribeEvents } from './events.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

function createTwoPlayerGame(p2IsBot = false): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `p${i + 1}`,
		username: `P${i + 1}`,
		avatarUrl: '',
		isBot: i === 1 ? p2IsBot : false,
		deckId: PRECON_DECKS[i].id,
		deckName: PRECON_DECKS[i].name,
		commanderNames: PRECON_DECKS[i].commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: PRECON_DECKS[i].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
	const state = createInitialGameState(
		'SLICE1',
		seats,
		new Map([
			[0, PRECON_DECKS[0]],
			[1, PRECON_DECKS[1]]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		if (!p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const ts = allocateTimestamp(state);
	const inst = createCardInstance(card, player.playerId, zone, false, false, ts, state);
	moveObject(state, inst, zone, { from: 'none', toPlayer: player, bumpVersion: true });
	return inst;
}

function passPriorityRound(state: GameState): void {
	let guard = 0;
	while (state.stack.length > 0 && state.pendingPrompts.length === 0 && guard < 20) {
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `pass_priority failed: ${res.ok ? '' : res.error}`);
		guard += 1;
	}
}

describe('Predefined Tokens (CR 111.10a-g, u, v, x)', () => {
	it('compiles all 10 predefined token creation texts as fullySupported with exact TokenSpec and rename invariance', () => {
		const cases: Array<{ phrase: string; key: keyof typeof PREDEFINED_TOKEN_DEFS }> = [
			{ phrase: 'Create a Treasure token.', key: 'treasure' },
			{ phrase: 'Create a Food token.', key: 'food' },
			{ phrase: 'Create a Gold token.', key: 'gold' },
			{ phrase: 'Create a Walker token.', key: 'walker' },
			{ phrase: 'Create a Shard token.', key: 'shard' },
			{ phrase: 'Create a Clue token.', key: 'clue' },
			{ phrase: 'Create a Blood token.', key: 'blood' },
			{ phrase: 'Create a Lander token.', key: 'lander' },
			{ phrase: 'Create a Mutagen token.', key: 'mutagen' },
			{ phrase: 'Create a Heartwood token.', key: 'heartwood' }
		];

		for (const { phrase, key } of cases) {
			const expected = PREDEFINED_TOKEN_DEFS[key];
			const defA = compileCard(makeCard({ name: `Spawner Alpha ${key}`, oracleText: phrase }));
			const defB = compileCard(makeCard({ name: `Spawner Beta ${key}`, oracleText: phrase }));
			assert.equal(defA.fullySupported, true, `${key} should compile fullySupported`);
			assert.deepEqual(
				defA.faces[0].abilities.filter((a) => a.kind === 'unsupported'),
				[],
				`${key} unsupported spans should be empty`
			);
			assert.deepEqual(defA.faces[0].abilities, defB.faces[0].abilities, `${key} should be rename invariant`);
			const spellAb = defA.faces[0].abilities.find((a) => a.kind === 'spell');
			assert.ok(spellAb && spellAb.kind === 'spell');
			assert.equal(spellAb.effect[0]?.verb, 'createToken');
			const tok = spellAb.effect[0]?.params?.token;
			assert.ok(tok, `Missing token spec for ${key}`);
			assert.equal(tok.name, expected.name);
			assert.equal(tok.typeLine, expected.typeLine);
			assert.deepEqual(tok.colors, [...expected.colors]);
			assert.equal(tok.power, expected.power);
			assert.equal(tok.toughness, expected.toughness);
		}
	});

	it('compiles tapped predefined and creature token phrases and creates tapped tokens on the battlefield', () => {
		const phrases = [
			'Create a tapped Treasure token.',
			'Create a Treasure token tapped.',
			'Create two tapped 1/1 white Soldier creature tokens.',
			'Create a 2/2 black Zombie creature token tapped.'
		];
		for (const oracleText of phrases) {
			const def = compileCard(makeCard({ name: 'Tap Spawner', oracleText }));
			assert.equal(def.fullySupported, true, `"${oracleText}" should compile`);
			const ab = def.faces[0].abilities[0];
			assert.ok(ab && ab.kind === 'spell');
			assert.equal(ab.effect[0]?.params?.token?.tapped, true, `"${oracleText}" should mark token tapped`);
		}

		const { state, p1 } = createTwoPlayerGame();
		p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		const spell = putInZone(
			state,
			p1,
			makeCard({ name: 'Tap Treasure Spell', manaCost: '{1}', oracleText: 'Create a tapped Treasure token.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		passPriorityRound(state);
		const treasure = p1.battlefield.find((c) => c.isToken && c.card.typeLine.includes('Treasure'));
		assert.ok(treasure);
		assert.equal(treasure.tapped, true);
	});

	it('recognizes predefined tokens by subtype regardless of synthetic token name (CR 111.10)', () => {
		const treasureCard = buildTokenScryfallCard('tok_1', {
			name: 'Renamed Doubloon',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Token Artifact — Treasure',
			keywords: []
		});
		assert.equal(treasureCard.power, undefined);
		assert.equal(treasureCard.toughness, undefined);
		assert.ok(treasureCard.oracleText.includes('Sacrifice this artifact'));

		const goldCard = buildTokenScryfallCard('tok_2', {
			name: 'Renamed Ingot',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Token Artifact — Gold',
			keywords: []
		});
		assert.equal(goldCard.oracleText, 'Sacrifice this token: Add one mana of any color.');

		const walkerCard = buildTokenScryfallCard('tok_3', {
			name: 'Walker',
			power: 2,
			toughness: 2,
			colors: ['B'],
			typeLine: 'Token Creature — Zombie',
			keywords: []
		});
		assert.equal(walkerCard.power, '2');
		assert.equal(walkerCard.toughness, '2');
		assert.equal(walkerCard.oracleText, '');
	});

	it('activates Gold while tapped without emitting TappedForMana and supports auto-tap cast_spell', () => {
		const { state, p1 } = createTwoPlayerGame();
		let tappedForManaCount = 0;
		subscribeEvents(state, (_state, ev) => {
			if (ev.kind === 'TappedForMana') tappedForManaCount += 1;
		});

		const gold1 = createTokenOnBoard(state, p1, {
			name: 'Gold',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Token Artifact — Gold',
			keywords: [],
			tapped: true
		});
		assert.equal(gold1.tapped, true);

		const res = applyGameAction(state, p1.playerId, {
			type: 'tap_mana',
			instanceId: gold1.instanceId,
			preferredColor: 'U'
		});
		assert.equal(res.ok, true, `Expected tapped Gold tap_mana to succeed: ${res.ok ? '' : res.error}`);
		assert.equal(p1.manaPool.U, 1);
		assert.equal(p1.battlefield.some((c) => c.instanceId === gold1.instanceId), false);
		assert.equal(tappedForManaCount, 0, 'Sacrificing Gold without {T} must not emit TappedForMana');

		// Also verify auto-tap uses tapped Gold tokens to pay for spells when pool is empty.
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		const gold2 = createTokenOnBoard(state, p1, {
			name: 'Gold',
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Token Artifact — Gold',
			keywords: [],
			tapped: true
		});
		const optSpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Test Opt', manaCost: '{U}', oracleText: 'Draw a card.' }),
			'hand'
		);
		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: optSpell.instanceId
		});
		assert.equal(castRes.ok, true, `Auto-tap cast with tapped Gold failed: ${castRes.ok ? '' : castRes.error}`);
		assert.equal(p1.battlefield.some((c) => c.instanceId === gold2.instanceId), false);
		assert.equal(tappedForManaCount, 0);
	});

	it('creates and resolves abilities for Food, Clue, Shard, Blood, Lander, Mutagen, Heartwood, and Walker', () => {
		const { state, p1 } = createTwoPlayerGame();
		p1.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };

		const targetCreature = putInZone(
			state,
			p1,
			makeCard({
				name: 'Test Bear',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const extraForest = makeCard({
			name: 'Forest',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: '{T}: Add {G}.'
		});
		const libTopCard = makeCard({ name: 'Filler Card', manaCost: '{1}', typeLine: 'Artifact', oracleText: '' });
		p1.library.unshift(
			createCardInstance(extraForest, p1.playerId, 'library', false, false, allocateTimestamp(state), state),
			createCardInstance(libTopCard, p1.playerId, 'library', false, false, allocateTimestamp(state), state),
			createCardInstance(libTopCard, p1.playerId, 'library', false, false, allocateTimestamp(state), state)
		);

		// Walker: 2/2 black Zombie creature, summoning sick, 0 activated abilities
		const walker = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.walker.name,
			power: PREDEFINED_TOKEN_DEFS.walker.power,
			toughness: PREDEFINED_TOKEN_DEFS.walker.toughness,
			colors: [...PREDEFINED_TOKEN_DEFS.walker.colors],
			typeLine: PREDEFINED_TOKEN_DEFS.walker.typeLine,
			keywords: []
		});
		assert.equal(walker.summoningSick, true);
		assert.equal(walker.card.power, '2');
		assert.equal(walker.card.toughness, '2');
		assert.equal(getEffectiveActivatedAbilities(state, p1, walker).length, 0);

		// Heartwood: {T}: Add {R} or {G}.
		const heartwood = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.heartwood.name,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: PREDEFINED_TOKEN_DEFS.heartwood.typeLine,
			keywords: []
		});
		const startR = p1.manaPool.R;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: heartwood.instanceId, preferredColor: 'R' })
				.ok,
			true
		);
		assert.equal(p1.manaPool.R, startR + 1);
		assert.equal(heartwood.tapped, true);

		// Food: gain 3 life
		const food = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.food.name,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: PREDEFINED_TOKEN_DEFS.food.typeLine,
			keywords: []
		});
		const foodAb = getEffectiveActivatedAbilities(state, p1, food)[0];
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: food.instanceId,
				abilityId: foodAb.id
			}).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(p1.life, lifeBefore + 3);

		// Mutagen: +1/+1 counter, sorcery speed only
		const mutagen = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.mutagen.name,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: PREDEFINED_TOKEN_DEFS.mutagen.typeLine,
			keywords: []
		});
		const mutagenAb = getEffectiveActivatedAbilities(state, p1, mutagen)[0];
		state.activePlayerIndex = 1; // opponent's turn -> must reject sorcery-speed activation
		const badTiming = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: mutagen.instanceId,
			abilityId: mutagenAb.id,
			targets: [{ kind: 'permanent', id: targetCreature.instanceId, label: targetCreature.card.name }]
		});
		assert.equal(badTiming.ok, false);
		state.activePlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: mutagen.instanceId,
				abilityId: mutagenAb.id,
				targets: [{ kind: 'permanent', id: targetCreature.instanceId, label: targetCreature.card.name }]
			}).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(targetCreature.counters['+1/+1'], 1);

		// Shard: Scry 1, then draw a card
		const shard = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.shard.name,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: PREDEFINED_TOKEN_DEFS.shard.typeLine,
			keywords: []
		});
		const shardAb = getEffectiveActivatedAbilities(state, p1, shard)[0];
		const handBeforeShard = p1.hand.length;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: shard.instanceId,
				abilityId: shardAb.id
			}).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(state.pendingPrompts.length, 1);
		const scryTopId = state.pendingPrompts[0].candidateInstanceIds![0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'orderObjects', topIds: [scryTopId], bottomIds: [], shuffle: false }
			}).ok,
			true
		);
		assert.equal(p1.hand.length, handBeforeShard + 1);

		// Blood: discard a card, draw a card
		const discardFodder = putInZone(state, p1, libTopCard, 'hand');
		const blood = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.blood.name,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: PREDEFINED_TOKEN_DEFS.blood.typeLine,
			keywords: []
		});
		const bloodAb = getEffectiveActivatedAbilities(state, p1, blood)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: blood.instanceId,
				abilityId: bloodAb.id
			}).ok,
			true
		);
		if (state.pendingPrompts.length > 0) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [discardFodder.instanceId] }
				}).ok,
				true
			);
		}
		const handBeforeBloodResolve = p1.hand.length;
		passPriorityRound(state);
		assert.equal(p1.hand.length, handBeforeBloodResolve + 1);

		// Lander: search basic land onto battlefield tapped, then shuffle
		const basicOnDeck = putInZone(state, p1, extraForest, 'library');
		const lander = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.lander.name,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: PREDEFINED_TOKEN_DEFS.lander.typeLine,
			keywords: []
		});
		const landerAb = getEffectiveActivatedAbilities(state, p1, lander)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: lander.instanceId,
				abilityId: landerAb.id
			}).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [basicOnDeck.instanceId] }
			}).ok,
			true
		);
		const searchedLand = p1.battlefield.find((c) => c.instanceId === basicOnDeck.instanceId);
		assert.ok(searchedLand);
		assert.equal(searchedLand.tapped, true);

		// Clue: Draw a card
		const clue = createTokenOnBoard(state, p1, {
			name: PREDEFINED_TOKEN_DEFS.clue.name,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: PREDEFINED_TOKEN_DEFS.clue.typeLine,
			keywords: []
		});
		const clueAb = getEffectiveActivatedAbilities(state, p1, clue)[0];
		const handBeforeClue = p1.hand.length;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: clue.instanceId,
				abilityId: clueAb.id
			}).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(p1.hand.length, handBeforeClue + 1);
	});
});

describe('Investigate (CR 701.16a)', () => {
	it('compiles investigate and multi-investigate phrases and fires Investigated triggers once per investigation', () => {
		const twiceDef = compileCard(makeCard({ name: 'Double Clue', oracleText: 'Investigate twice.' }));
		assert.equal(twiceDef.fullySupported, true);
		const timesDef = compileCard(makeCard({ name: 'Triple Clue', oracleText: 'Investigate 3 times.' }));
		assert.equal(timesDef.fullySupported, true);

		const { state, p1, p2 } = createTwoPlayerGame();
		p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		putInZone(
			state,
			p1,
			makeCard({
				name: 'Investigate Watcher',
				manaCost: '{2}',
				typeLine: 'Enchantment',
				oracleText: 'Whenever you investigate, you gain 2 life.'
			}),
			'battlefield'
		);
		putInZone(
			state,
			p2,
			makeCard({
				name: 'Opponent Spy',
				manaCost: '{2}',
				typeLine: 'Enchantment',
				oracleText: 'Whenever an opponent investigates, you gain 1 life.'
			}),
			'battlefield'
		);

		let eventCount = 0;
		subscribeEvents(state, (_state, ev) => {
			if (ev.kind === 'Investigated') eventCount += 1;
		});

		const lifeP1Before = p1.life;
		const lifeP2Before = p2.life;
		const spell = putInZone(
			state,
			p1,
			makeCard({ name: 'Investigate Twice', manaCost: '{2}', oracleText: 'Investigate twice.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		passPriorityRound(state);
		// Answer simultaneous trigger ordering prompts for each player, then resolve triggers on the stack.
		while (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			const req = effectivePromptChoice(pr, state);
			assert.equal(req.kind, 'orderObjects');
			if (req.kind === 'orderObjects') {
				assert.equal(
					applyGameAction(state, pr.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'orderObjects', topIds: req.objectIds, bottomIds: [], shuffle: false }
					}).ok,
					true
				);
			}
		}
		passPriorityRound(state);

		const clues = p1.battlefield.filter((c) => c.isToken && c.card.typeLine.includes('Clue'));
		assert.equal(clues.length, 2, 'Investigate twice should create 2 Clue tokens');
		assert.equal(eventCount, 2, 'Investigate twice should emit 2 separate Investigated events');
		assert.equal(p1.life, lifeP1Before + 4, 'Your trigger should fire twice (+4 life)');
		assert.equal(p2.life, lifeP2Before + 2, 'Opponent trigger should fire twice (+2 life)');
	});
});

describe('Surveil (CR 701.25a-d)', () => {
	it('prompts with graveyard splitLabel, redacts hidden info, survives JSON round-trip, emits Surveilled, and resumes remaining steps', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		p1.library = [];

		const cardA = putInZone(state, p1, makeCard({ name: 'Top Grave Card' }), 'library');
		const cardB = putInZone(state, p1, makeCard({ name: 'Keep Draw Card' }), 'library');
		const cardC = putInZone(state, p1, makeCard({ name: 'Deeper Library Card' }), 'library');

		putInZone(
			state,
			p1,
			makeCard({
				name: 'Surveil Lifegain',
				manaCost: '{2}',
				typeLine: 'Enchantment',
				oracleText: 'Whenever you surveil, you gain 3 life.'
			}),
			'battlefield'
		);

		let surveilEvents = 0;
		subscribeEvents(state, (_state, ev) => {
			if (ev.kind === 'Surveilled') surveilEvents += 1;
		});

		const lifeBefore = p1.life;
		const handBefore = p1.hand.length;
		const spell = putInZone(
			state,
			p1,
			makeCard({ name: 'Consider Variant', manaCost: '{U}', oracleText: 'Surveil 2, then draw a card.' }),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		passPriorityRound(state);

		assert.equal(state.pendingPrompts.length, 1);
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt.splitMode, 'graveyard');
		const req = effectivePromptChoice(prompt, state);
		assert.equal(req.kind, 'orderObjects');
		if (req.kind === 'orderObjects') {
			assert.equal(req.splitLabel, 'graveyard');
			assert.deepEqual(req.objectIds, [cardA.instanceId, cardB.instanceId]);
		}

		// Sanitization: viewer p1 sees only the 2 surveilled cards, viewer p2 sees empty library and redacted prompt
		const p1View = sanitizeGameStateForViewer(state, p1.playerId);
		assert.deepEqual(
			p1View.players[0].library.map((c) => c.instanceId),
			[cardA.instanceId, cardB.instanceId]
		);
		assert.equal(p1View.players[0].library.some((c) => c.instanceId === cardC.instanceId), false);
		const p2View = sanitizeGameStateForViewer(state, p2.playerId);
		assert.equal(p2View.players[0].library.length, 0);
		assert.equal(p2View.pendingPrompts[0].candidateInstanceIds, undefined);

		// JSON round-trip while paused mid-surveil
		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		subscribeEvents(roundTripped, (_state, ev) => {
			if (ev.kind === 'Surveilled') surveilEvents += 1;
		});
		const rtP1 = roundTripped.players[0];
		const rtPrompt = roundTripped.pendingPrompts[0];
		assert.equal(
			applyGameAction(roundTripped, rtP1.playerId, {
				type: 'choice',
				promptId: rtPrompt.id,
				answer: {
					kind: 'orderObjects',
					topIds: [cardB.instanceId],
					bottomIds: [cardA.instanceId],
					shuffle: false
				}
			}).ok,
			true
		);
		// While triggers resolve after the spell, pass priority to clear the Surveil Lifegain trigger.
		passPriorityRound(roundTripped);

		assert.equal(rtP1.graveyard.some((c) => c.instanceId === cardA.instanceId), true);
		assert.equal(rtP1.hand.some((c) => c.instanceId === cardB.instanceId), true, 'Kept top card should be drawn');
		assert.equal(rtP1.hand.length, handBefore + 1);
		assert.equal(rtP1.life, lifeBefore + 3);
		assert.equal(surveilEvents, 1);
	});

	it('respects CR 701.25c (surveil 0 does not emit or trigger) and CR 701.25d (empty library still triggers)', () => {
		const { state, p1 } = createTwoPlayerGame();
		p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };

		putInZone(
			state,
			p1,
			makeCard({
				name: 'Surveil Triggerer',
				manaCost: '{2}',
				typeLine: 'Enchantment',
				oracleText: 'Whenever you surveil, you gain 2 life.'
			}),
			'battlefield'
		);

		let surveilEvents = 0;
		subscribeEvents(state, (_state, ev) => {
			if (ev.kind === 'Surveilled') surveilEvents += 1;
		});

		// CR 701.25c: Surveil X with X = 0
		const zeroSpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Zero Surveil', manaCost: '{X}{U}', oracleText: 'Surveil X.' }),
			'hand'
		);
		const life0 = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: zeroSpell.instanceId, xValue: 0 }).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(surveilEvents, 0);
		assert.equal(p1.life, life0);

		// CR 701.25d: Surveil 2 with empty library still emits Surveilled and fires trigger
		p1.library = [];
		const emptySpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Empty Surveil', manaCost: '{U}', oracleText: 'Surveil 2.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: emptySpell.instanceId }).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(surveilEvents, 1);
		assert.equal(p1.life, life0 + 2);
	});

	it('applies graveyard replacement (Rest in Peace) and handles multi-replacement pause/resume mid-surveil', () => {
		// Single graveyard replacement -> exile instead
		const { state, p1 } = createTwoPlayerGame();
		p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		p1.library = [];
		const ripTarget = putInZone(state, p1, makeCard({ name: 'Exiled By RIP' }), 'library');
		const keptCard = putInZone(state, p1, makeCard({ name: 'Kept Card' }), 'library');
		putInZone(
			state,
			p1,
			makeCard({
				name: 'RIP Replacement',
				manaCost: '{1}{W}',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);
		const surveilSpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Surveil RIP', manaCost: '{U}', oracleText: 'Surveil 2.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: surveilSpell.instanceId }).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: {
					kind: 'orderObjects',
					topIds: [keptCard.instanceId],
					bottomIds: [ripTarget.instanceId],
					shuffle: false
				}
			}).ok,
			true
		);
		assert.equal(p1.graveyard.some((c) => c.instanceId === ripTarget.instanceId), false);
		assert.equal(p1.exile.some((c) => c.instanceId === ripTarget.instanceId), true);

		// Multi-replacement (exile OR shuffle into library) pauses per graveyard card and resumes trailing draw step
		const multi = createTwoPlayerGame();
		multi.p1.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		multi.p1.library = [];
		const m1 = putInZone(multi.state, multi.p1, makeCard({ name: 'M1' }), 'library');
		const m2 = putInZone(multi.state, multi.p1, makeCard({ name: 'M2' }), 'library');
		const m3 = putInZone(multi.state, multi.p1, makeCard({ name: 'M3' }), 'library');
		putInZone(
			multi.state,
			multi.p1,
			makeCard({
				name: 'Exile Global',
				manaCost: '{1}{W}',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			}),
			'battlefield'
		);
		putInZone(
			multi.state,
			multi.p1,
			makeCard({
				name: 'Shuffle Global',
				manaCost: '{2}{G}',
				typeLine: 'Enchantment',
				oracleText: "If a card would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
			}),
			'battlefield'
		);
		const multiSpell = putInZone(
			multi.state,
			multi.p1,
			makeCard({ name: 'Surveil Multi', manaCost: '{U}', oracleText: 'Surveil 2, then draw a card.' }),
			'hand'
		);
		const handBeforeMulti = multi.p1.hand.length;
		assert.equal(
			applyGameAction(multi.state, multi.p1.playerId, { type: 'cast_spell', instanceId: multiSpell.instanceId }).ok,
			true
		);
		passPriorityRound(multi.state);
		assert.equal(multi.state.pendingPrompts[0]?.kind, 'scry_choice');
		assert.equal(
			applyGameAction(multi.state, multi.p1.playerId, {
				type: 'choice',
				promptId: multi.state.pendingPrompts[0].id,
				answer: {
					kind: 'orderObjects',
					topIds: [],
					bottomIds: [m1.instanceId, m2.instanceId],
					shuffle: false
				}
			}).ok,
			true
		);

		// Should pause for card 1 replacement, then card 2 replacement, then draw m3, then SM itself going to graveyard!
		for (let step = 0; step < 3; step++) {
			const repPrompt = multi.state.pendingPrompts[0];
			assert.ok(repPrompt, `Expected replacement prompt #${step + 1}`);
			assert.equal(repPrompt.choice?.kind, 'chooseReplacement');
			const exileOpt = repPrompt.choice.options.find((o) => /exile/i.test(o.label)) ?? repPrompt.choice.options[0];
			assert.equal(
				applyGameAction(multi.state, multi.p1.playerId, {
					type: 'choice',
					promptId: repPrompt.id,
					answer: { kind: 'chooseReplacement', id: exileOpt.id }
				}).ok,
				true
			);
		}
		assert.equal(multi.state.pendingPrompts.length, 0);
		assert.equal(multi.p1.exile.some((c) => c.instanceId === m1.instanceId), true);
		assert.equal(multi.p1.exile.some((c) => c.instanceId === m2.instanceId), true);
		assert.equal(multi.p1.exile.some((c) => c.instanceId === multiSpell.instanceId), true);
		assert.equal(multi.p1.hand.some((c) => c.instanceId === m3.instanceId), true);
		assert.equal(multi.p1.hand.length, handBeforeMulti);
	});

	it('resolves bot surveil automatically via pickScryOrSurveilSplit and fires triggers', () => {
		const { state, p2 } = createTwoPlayerGame(true);
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		p2.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
		// Ensure >= 4 lands across battlefield+hand so bot sends top land to graveyard
		for (let i = 0; i < 4; i++) {
			putInZone(
				state,
				p2,
				makeCard({ name: `Forest ${i}`, manaCost: '', typeLine: 'Basic Land — Forest' }),
				'battlefield'
			);
		}
		p2.library = [];
		const topLand = putInZone(
			state,
			p2,
			makeCard({ name: 'Excess Land', manaCost: '', typeLine: 'Basic Land — Island' }),
			'library'
		);
		const keepSpell = putInZone(
			state,
			p2,
			makeCard({ name: 'Good Spell', manaCost: '{1}{U}', cmc: 2, typeLine: 'Instant', oracleText: 'Draw a card.' }),
			'library'
		);
		putInZone(
			state,
			p2,
			makeCard({
				name: 'Bot Surveil Watcher',
				manaCost: '{2}',
				typeLine: 'Enchantment',
				oracleText: 'Whenever you surveil, you gain 2 life.'
			}),
			'battlefield'
		);
		const botLifeBefore = p2.life;
		const botSpell = putInZone(
			state,
			p2,
			makeCard({ name: 'Bot Surveil', manaCost: '{U}', oracleText: 'Surveil 2.' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: botSpell.instanceId }).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p2.graveyard.some((c) => c.instanceId === topLand.instanceId), true);
		assert.equal(p2.library[0]?.instanceId, keepSpell.instanceId);
		assert.equal(p2.life, botLifeBefore + 2);
	});
});
