import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeBotStep } from '../ai.ts';
import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	createTokenOnBoard,
	emptyAllPlayersManaPools,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
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
		'SLICE2',
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

function resolveStack(state: GameState): void {
	let guard = 0;
	while (state.stack.length > 0 && state.pendingPrompts.length === 0 && guard < 24) {
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `pass_priority failed: ${res.ok ? '' : res.error}`);
		guard += 1;
	}
}

function advanceTurnToP1Main1(state: GameState, p1: PlayerGameState, p2: PlayerGameState): void {
	const startingTurn = state.turnNumber;
	let guard = 0;
	while (
		(state.turnNumber === startingTurn ||
			state.activePlayerIndex !== 0 ||
			state.phase !== 'main1') &&
		guard < 80
	) {
		const actor = state.players[state.priorityPlayerIndex] ?? p1;
		if (state.pendingPrompts.length > 0) {
			// Discard down to hand size if cleanup prompt appears
			const pr = state.pendingPrompts[0];
			if (pr.kind === 'discard_to_hand_size' && pr.candidateInstanceIds?.length) {
				applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [pr.candidateInstanceIds[0]] }
				});
				guard += 1;
				continue;
			}
			break;
		}
		if (state.activePlayerIndex === 0 && p1.hand.length > state.rules.maxHandSize) {
			p1.hand.length = state.rules.maxHandSize;
		}
		if (state.activePlayerIndex === 1 && p2.hand.length > state.rules.maxHandSize) {
			p2.hand.length = state.rules.maxHandSize;
		}
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `advance turn failed: ${res.ok ? '' : res.error}`);
		guard += 1;
	}
	assert.equal(state.activePlayerIndex, 0);
	assert.equal(state.phase, 'main1');
	assert.ok(state.turnNumber > startingTurn);
}

describe('Predefined Tokens Slice 2: Powerstone, Vibranium, Junk (CR 111.10h, t, w)', () => {
	it('compiles and creates Powerstone, tapped Powerstone, Vibranium (with Indestructible), and Junk tokens', () => {
		const { state, p1 } = createTwoPlayerGame();
		p1.manaPool = { W: 0, U: 5, B: 0, R: 0, G: 0, C: 0 };

		const creator = putInZone(
			state,
			p1,
			makeCard({
				name: 'Token Maker Sorcery',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Create a tapped Powerstone token. Create a Vibranium token. Create a Junk token.'
			}),
			'hand'
		);
		const ir = compileCard(creator.card);
		assert.equal(ir.fullySupported, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: creator.instanceId }).ok, true);
		resolveStack(state);

		const powerstone = p1.battlefield.find((c) => c.card.typeLine.includes('Powerstone'));
		const vibranium = p1.battlefield.find((c) => c.card.typeLine.includes('Vibranium'));
		const junk = p1.battlefield.find((c) => c.card.typeLine.includes('Junk'));

		assert.ok(powerstone, 'Powerstone token should be created');
		assert.equal(powerstone.tapped, true, 'Create a tapped Powerstone token enters tapped');
		assert.equal(getEffectiveActivatedAbilities(state, p1, powerstone)[0]?.manaRestriction, 'artifactSpellOrNonSpell');

		assert.ok(vibranium, 'Vibranium token should be created');
		assert.equal(vibranium.tapped, false);
		assert.equal(hasKeyword(vibranium, 'Indestructible', state), true);
		assert.equal(getEffectiveActivatedAbilities(state, p1, vibranium)[0]?.manaRestriction, 'artifactSpellOrNonSpell');

		assert.ok(junk, 'Junk token should be created');
		assert.equal(junk.tapped, false);
		assert.equal(getEffectiveActivatedAbilities(state, p1, junk)[0]?.sorcerySpeedOnly, true);

		// Verify rename invariance for created token specs via synthetic cards
		const a = compileCard(makeCard({ name: 'Rename A', oracleText: 'Create a tapped Powerstone token.' }));
		const b = compileCard(makeCard({ name: 'Rename B', oracleText: 'Create a tapped Powerstone token.' }));
		assert.deepEqual(
			JSON.parse(JSON.stringify(a.faces[0].abilities)),
			JSON.parse(JSON.stringify(b.faces[0].abilities))
		);
	});
});

describe('Restricted Mana (Powerstone / Vibranium)', () => {
	it('pools restricted mana, allows artifacts/abilities/kicker/ward, blocks nonartifact spells, prefers restricted mana first, and empties on step change', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		const ps = createTokenOnBoard(state, p1, {
			name: 'Powerstone',
			typeLine: 'Token Artifact — Powerstone',
			colors: [],
			power: 0,
			toughness: 0,
			keywords: []
		});
		const ab = getEffectiveActivatedAbilities(state, p1, ps)[0];
		assert.ok(ab);
		assert.equal(ab.manaRestriction, 'artifactSpellOrNonSpell');

		// Tap Powerstone manually -> goes into restrictedMana, not unrestricted manaPool
		assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: ps.instanceId, abilityId: ab.id }).ok, true);
		assert.equal(p1.manaPool.C, 0);
		assert.equal(p1.restrictedMana?.artifactSpellOrNonSpell?.C, 1);

		const nonArtifact = putInZone(
			state,
			p1,
			makeCard({ name: 'Grizzly Probe', manaCost: '{1}', cmc: 1, typeLine: 'Creature — Bear' }),
			'hand'
		);
		const artifactSpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Ornithopter Probe', manaCost: '{1}', cmc: 1, typeLine: 'Artifact Creature — Thopter' }),
			'hand'
		);

		// Nonartifact spell cannot spend pooled restricted mana
		assert.equal(checkSpellCastLegality(state, p1.playerId, nonArtifact).ok, false);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: nonArtifact.instanceId }).ok, false);

		// Artifact spell CAN spend pooled restricted mana
		assert.equal(checkSpellCastLegality(state, p1.playerId, artifactSpell).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: artifactSpell.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(p1.restrictedMana?.artifactSpellOrNonSpell?.C, 0);

		// Untap Powerstone and verify preference: restricted mana/source spent before unrestricted mana
		ps.tapped = false;
		const ps2 = createTokenOnBoard(state, p1, {
			name: 'Vibranium',
			typeLine: 'Token Artifact — Vibranium',
			colors: [],
			power: 0,
			toughness: 0,
			keywords: ['Indestructible']
		});
		const island = putInZone(
			state,
			p1,
			makeCard({ name: 'Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' }),
			'battlefield'
		);
		const artifact2 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Kicked Relic',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact',
				oracleText: 'Kicker {1}\nWhen Kicked Relic enters, if it was kicked, draw a card.'
			}),
			'hand'
		);
		const blueSorcery = putInZone(
			state,
			p1,
			makeCard({ name: 'Blue Opt', manaCost: '{U}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Draw a card.' }),
			'hand'
		);
		// Auto-tap casting Kicked Relic with Kicker {1} ({2} total for artifact spell) taps Powerstone + Vibranium, leaving Island untapped!
		const relicOpts = getCastOptions(state, p1.playerId, artifact2, 'hand');
		const kickerId = relicOpts[0]?.optionalAdditionalCosts?.[0]?.id;
		assert.ok(kickerId, 'Kicker optional cost option should exist');
		const kickerCast = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: artifact2.instanceId,
			optionalCostCounts: { [kickerId]: 1 }
		});
		assert.equal(kickerCast.ok, true, kickerCast.ok ? '' : (kickerCast.error ?? ''));
		assert.equal(ps.tapped, true);
		assert.equal(ps2.tapped, true);
		assert.equal(island.tapped, false, 'Unrestricted Island should remain untapped after restricted sources pay for artifact');
		resolveStack(state);

		// Island still pays for nonartifact spell
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: blueSorcery.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(island.tapped, true);

		// Restricted mana pays activated ability costs and clears on mana pool emptying
		ps.tapped = false;
		ps2.tapped = false;
		const util = putInZone(
			state,
			p1,
			makeCard({
				name: 'Mind Stone Probe',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{2}, {T}: Draw a card.'
			}),
			'battlefield'
		);
		const utilAb = getEffectiveActivatedAbilities(state, p1, util)[0];
		assert.ok(utilAb);
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, util, utilAb).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: util.instanceId,
				abilityId: utilAb.id
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(ps.tapped, true);
		assert.equal(ps2.tapped, true);

		// Ward {2} can be paid with Powerstone restricted mana (non-spell cost)
		ps.tapped = false;
		ps2.tapped = false;
		island.tapped = false;
		const wardTarget = putInZone(
			state,
			p2,
			makeCard({
				name: 'Ward Bear',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2',
				keywords: ['Ward'],
				oracleText: 'Ward {2}'
			}),
			'battlefield'
		);
		const killSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Unsummon Probe',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: killSpell.instanceId,
				targets: [{ kind: 'permanent', id: wardTarget.instanceId, label: wardTarget.card.name }]
			}).ok,
			true
		);
		// Ward trigger goes on stack above killSpell; resolve until Ward prompts p1, accept payment -> pays {2} via Powerstone + Vibranium!
		resolveStack(state);
		const wardPrompt = state.pendingPrompts.find((pr) => pr.playerId === p1.playerId);
		assert.ok(wardPrompt, 'Human caster should be prompted to pay Ward {2}');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: wardPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.battlefield.some((c) => c.instanceId === wardTarget.instanceId), false, 'Ward {2} was paid with Powerstone + Vibranium so spell resolved');
		assert.equal(ps.tapped, true);
		assert.equal(ps2.tapped, true);

		// Ward {2} fails/counters when only 1 restricted {C} is available (insufficient mana)
		ps.tapped = false;
		p1.manaPool.U = 1;
		const wardTarget2 = putInZone(
			state,
			p2,
			makeCard({
				name: 'Ward Bear Two',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2',
				keywords: ['Ward'],
				oracleText: 'Ward {2}'
			}),
			'battlefield'
		);
		const killSpell2 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Unsummon Probe Two',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: killSpell2.instanceId,
				targets: [{ kind: 'permanent', id: wardTarget2.instanceId, label: wardTarget2.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts.length, 0);
		assert.equal(p2.battlefield.some((c) => c.instanceId === wardTarget2.instanceId), true, 'Insufficient mana for Ward {2} counters spell');
		assert.equal(ps.tapped, false, 'Powerstone should not tap when Ward {2} cannot be afforded');

		// Pooled restricted mana empties on emptyAllPlayersManaPools
		ps.tapped = false;
		assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: ps.instanceId, abilityId: ab.id }).ok, true);
		assert.equal(p1.restrictedMana?.artifactSpellOrNonSpell?.C, 1);
		emptyAllPlayersManaPools(state);
		assert.equal(p1.restrictedMana?.artifactSpellOrNonSpell?.C ?? 0, 0);
	});
});

describe('Junk Token & Impulse Exile (CR 111.10t, CR 701.18b, CR 514.2)', () => {
	it('enforces sorcery-only Junk activation, allows playing lands and casting spells from exile, and expires at cleanup', () => {
		const { state, p1, p2 } = createTwoPlayerGame();
		const junk1 = createTokenOnBoard(state, p1, {
			name: 'Junk',
			typeLine: 'Token Artifact — Junk',
			colors: [],
			power: 0,
			toughness: 0,
			keywords: []
		});
		const junkAb = getEffectiveActivatedAbilities(state, p1, junk1)[0];
		assert.ok(junkAb);
		assert.equal(junkAb.sorcerySpeedOnly, true);

		// Sorcery-speed restriction: rejected during opponent's turn
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, junk1, junkAb).ok, false);

		// Back to P1 main1 -> allowed
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		const fillers = Array.from({ length: 10 }, (_, idx) =>
			putInZone(state, p1, makeCard({ name: `Filler ${idx}`, typeLine: 'Basic Land — Plains', manaCost: '' }), 'library')
		);
		const topLand = putInZone(
			state,
			p1,
			makeCard({ name: 'Mountain', manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }),
			'library'
		);
		const topSpell = putInZone(
			state,
			p1,
			makeCard({ name: 'Impulse Bolt', manaCost: '{1}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Draw a card.' }),
			'library'
		);
		// Ensure topLand is library[0] and topSpell is library[1], followed by enough library cards not to deck out
		p1.library = [topLand, topSpell, ...fillers];

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: junk1.instanceId,
				abilityId: junkAb.id
			}).ok,
			true
		);
		// Junk token was sacrificed as cost
		assert.equal(p1.battlefield.some((c) => c.instanceId === junk1.instanceId), false);
		resolveStack(state);

		assert.equal(p1.exile.some((c) => c.instanceId === topLand.instanceId), true);
		assert.equal(topLand.playableFromExileBy?.playerId, p1.playerId);
		assert.equal(topLand.playableFromExileBy?.expiresAtEndOfTurn, true);

		// Play exiled land
		assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: topLand.instanceId }).ok, true);
		assert.equal(p1.battlefield.some((c) => c.instanceId === topLand.instanceId), true);
		assert.equal(topLand.playableFromExileBy, undefined);
		assert.equal(p1.landsPlayedThisTurn, 1);

		// Second Junk exiles topSpell; do NOT cast it this turn and advance turn -> permission expires at cleanup!
		const junk2 = createTokenOnBoard(state, p1, {
			name: 'Junk',
			typeLine: 'Token Artifact — Junk',
			colors: [],
			power: 0,
			toughness: 0,
			keywords: []
		});
		const junk2Ab = getEffectiveActivatedAbilities(state, p1, junk2)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: junk2.instanceId,
				abilityId: junk2Ab.id
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.exile.some((c) => c.instanceId === topSpell.instanceId), true);
		p1.manaPool.C = 5;
		assert.equal(checkSpellCastLegality(state, p1.playerId, topSpell, 'exile').ok, true);

		advanceTurnToP1Main1(state, p1, p2);
		assert.equal(p1.exile.some((c) => c.instanceId === topSpell.instanceId), true);
		assert.equal(topSpell.playableFromExileBy, undefined, 'This-turn exile permission must expire during cleanup');
		p1.manaPool.C = 5;
		assert.equal(checkSpellCastLegality(state, p1.playerId, topSpell, 'exile').ok, false);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: topSpell.instanceId }).ok, false);
	});

	it('handles multi-card impulse exile spells, empty library, and AI playing from impulse exile', () => {
		const { state, p1, p2 } = createTwoPlayerGame(true);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 5, G: 0, C: 5 };
		const impulseTwo = putInZone(
			state,
			p1,
			makeCard({
				name: 'Wrenn Probe',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Exile the top two cards of your library. You may play those cards this turn.'
			}),
			'hand'
		);
		const exA = putInZone(
			state,
			p1,
			makeCard({ name: 'Impulse Artifact', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'library'
		);
		const exB = putInZone(
			state,
			p1,
			makeCard({ name: 'Impulse Bear', manaCost: '{1}', cmc: 1, typeLine: 'Creature — Bear' }),
			'library'
		);
		p1.library = [exA, exB];

		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: impulseTwo.instanceId }).ok, true);
		resolveStack(state);

		assert.equal(exA.playableFromExileBy?.playerId, p1.playerId);
		assert.equal(exB.playableFromExileBy?.playerId, p1.playerId);
		assert.equal(exA.playableFromExileBy?.expiresAtEndOfTurn, true);
		assert.equal(exB.playableFromExileBy?.expiresAtEndOfTurn, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: exA.instanceId }).ok, true);
		resolveStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === exA.instanceId), true);
		assert.equal(exB.playableFromExileBy?.playerId, p1.playerId);

		// Empty library Junk activation resolves cleanly without crashing
		p1.library = [];
		const emptyJunk = createTokenOnBoard(state, p1, {
			name: 'Junk',
			typeLine: 'Token Artifact — Junk',
			colors: [],
			power: 0,
			toughness: 0,
			keywords: []
		});
		const ejAb = getEffectiveActivatedAbilities(state, p1, emptyJunk)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: emptyJunk.instanceId, abilityId: ejAb.id }).ok,
			true
		);
		resolveStack(state);

		// Bot plays land and casts spell from impulse exile
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'main1';
		p2.hand = [];
		p2.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 5 };
		p2.landsPlayedThisTurn = 0;
		const botLand = putInZone(
			state,
			p2,
			makeCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }),
			'exile'
		);
		botLand.playableFromExileBy = {
			playerId: p2.playerId,
			spendManaAsAnyColor: false,
			sourceName: 'Junk',
			expiresAtEndOfTurn: true
		};
		const botCreature = putInZone(
			state,
			p2,
			makeCard({
				name: 'Bot Exile Construct',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Construct',
				power: '2',
				toughness: '2'
			}),
			'exile'
		);
		botCreature.playableFromExileBy = {
			playerId: p2.playerId,
			spendManaAsAnyColor: false,
			sourceName: 'Junk',
			expiresAtEndOfTurn: true
		};

		// Bot takes actions in main1 until it plays the expiring exiled land (before hand land) and casts the creature
		const handLand = putInZone(
			state,
			p2,
			makeCard({ name: 'Plains', manaCost: '', cmc: 0, typeLine: 'Basic Land — Plains' }),
			'hand'
		);
		for (let i = 0; i < 6 && (state.stack.length > 0 || p2.exile.some((c) => c.playableFromExileBy?.playerId === p2.playerId)); i++) {
			if (state.stack.length > 0) {
				resolveStack(state);
			} else {
				executeBotStep(state, p2, state.players[state.activePlayerIndex]);
			}
		}
		if (state.stack.length > 0) resolveStack(state);
		assert.equal(p2.battlefield.some((c) => c.instanceId === botLand.instanceId), true, 'Bot should play expiring land from impulse exile first');
		assert.equal(p2.hand.some((c) => c.instanceId === handLand.instanceId), true, 'Bot should keep non-expiring hand land when expiring exile land is played');
		assert.equal(p2.battlefield.some((c) => c.instanceId === botCreature.instanceId), true, 'Bot should cast creature from impulse exile');

		// Bot with only a Powerstone casts an artifact spell, not a nonartifact spell
		p2.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		p2.restrictedMana = {};
		p2.hand = [];
		botLand.tapped = true;
		const botPs = createTokenOnBoard(state, p2, {
			name: 'Powerstone',
			typeLine: 'Token Artifact — Powerstone',
			colors: [],
			power: 0,
			toughness: 0,
			keywords: []
		});
		const botNonArtifact = putInZone(
			state,
			p2,
			makeCard({ name: 'Bot Bear', manaCost: '{1}', cmc: 1, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'hand'
		);
		const botArtifact = putInZone(
			state,
			p2,
			makeCard({ name: 'Bot Relic', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'hand'
		);
		executeBotStep(state, p2, state.players[state.activePlayerIndex]);
		resolveStack(state);
		assert.equal(botPs.tapped, true, 'Bot should tap Powerstone for artifact spell');
		assert.equal(p2.battlefield.some((c) => c.instanceId === botArtifact.instanceId), true, 'Bot casts artifact spell with Powerstone');
		assert.equal(p2.hand.some((c) => c.instanceId === botNonArtifact.instanceId), true, 'Bot cannot cast nonartifact spell with Powerstone');
	});
});
