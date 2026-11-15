import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	addCountersToPermanent,
	applyGameAction,
	checkAbilityActivationLegality,
	computeCombatDamageForecast,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn
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

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAGIC_DIR = path.resolve(RUNTIME_DIR, '..');
const REPO_ROOT = path.resolve(MAGIC_DIR, '../../..');

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	const id = `syn_p9_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
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
		canBeCommander: overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(cards: ScryfallCard[], commander?: ScryfallCard): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: 'deck_p9',
		userId: 'p1',
		name: 'Track P9 Deck',
		description: '',
		commanders: commander ? [commander] : [],
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + (commander ? 1 : 0),
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupGame(opts: {
	p1Bot?: boolean;
	p2Bot?: boolean;
	p1Commander?: ScryfallCard;
	maxHandSize?: number;
} = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P9 Filler Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(Array.from({ length: 30 }, () => filler), opts.p1Commander);
	const d2 = makeDeck(Array.from({ length: 30 }, () => filler));
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: opts.p1Bot ? null : 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: opts.p1Commander ? [opts.p1Commander.name] : [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: opts.p2Bot ? null : 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: Boolean(opts.p2Bot),
			deckId: d2.id,
			deckName: d2.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const decks = new Map<number, MagicDeck>([
		[0, d1],
		[1, d2]
	]);
	const rules = {
		...DEFAULT_LOBBY_RULES,
		...(opts.maxHandSize !== undefined ? { maxHandSize: opts.maxHandSize } : {})
	};
	const state = createInitialGameState('P9_TEST', seats, decks, rules);
	for (const p of state.players) {
		if (!p.isBot) {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.pendingPrompts = [];
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.turnNumber = 2;
	state.players[0].hand = [];
	state.players[1].hand = [];
	return { state, p1: state.players[0], p2: state.players[1] };
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor, number>>): void {
	for (const [k, v] of Object.entries(pool)) {
		player.manaPool[k as ManaColor] = (player.manaPool[k as ManaColor] ?? 0) + (v ?? 0);
	}
}

function addToZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library' | 'command'
): CardInstance {
	const isCmd = player.commanderNames[card.id] !== undefined || zone === 'command';
	const ts = (state.nextTimestamp = (state.nextTimestamp ?? 100) + 1);
	const inst = createCardInstance(card, player.playerId, zone, isCmd, false, ts, state);
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	if (zone === 'battlefield') {
		inst.summoningSick = false;
		inst.cameUnderControlAt = (state.echoClock = (state.echoClock ?? 0) + 1);
	}
	player[zone].push(inst);
	return inst;
}

function drainStackUntilPromptOrEmpty(state: GameState, maxSteps = 40): void {
	for (let i = 0; i < maxSteps; i++) {
		if (state.pendingPrompts.length > 0 || state.stack.length === 0) return;
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, `pass_priority failed: ${res.error}`);
	}
	assert.fail('Exceeded maxSteps while draining stack');
}

function jsonRoundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

describe('Wave 3 Track P9 — Compiler, Validation & Rename Invariance', () => {
	it('compiles all 20 Wave 3 keywords cleanly with rename invariance and rejects Modular—Sunburst', () => {
		const samples: ScryfallCard[] = [
			synthCard({ name: 'Echo Sample', typeLine: 'Creature — Goblin', oracleText: 'Echo {1}{R}', power: '2', toughness: '2' }),
			synthCard({ name: 'Echo NonMana Sample', typeLine: 'Creature — Beast', oracleText: 'Echo—Discard a card.', power: '4', toughness: '4' }),
			synthCard({ name: 'Madness Sample', typeLine: 'Instant', oracleText: '~ deals 3 damage to any target.\nMadness {R}' }),
			synthCard({ name: 'Cascade Sample', typeLine: 'Sorcery', manaCost: '{3}{R}', cmc: 4, oracleText: 'Cascade\nDraw a card.' }),
			synthCard({ name: 'Rebound Sample', typeLine: 'Instant', oracleText: 'Draw a card.\nRebound' }),
			synthCard({ name: 'Undying Sample', typeLine: 'Creature — Wolf', oracleText: 'Undying', power: '1', toughness: '1' }),
			synthCard({ name: 'Persist Sample', typeLine: 'Creature — Ouphe', oracleText: 'Persist', power: '2', toughness: '2' }),
			synthCard({ name: 'Modular Sample', typeLine: 'Artifact Creature — Construct', oracleText: 'Modular 2', power: '0', toughness: '0' }),
			synthCard({ name: 'Soulshift Sample', typeLine: 'Creature — Spirit', oracleText: 'Soulshift 3', power: '2', toughness: '2' }),
			synthCard({ name: 'Improvise Sample', typeLine: 'Instant', manaCost: '{3}{U}', cmc: 4, oracleText: 'Improvise\nDraw two cards.' }),
			synthCard({ name: 'Dash Sample', typeLine: 'Creature — Orc', oracleText: 'Dash {1}{R}', power: '3', toughness: '2' }),
			synthCard({ name: 'Ninjutsu Sample', typeLine: 'Creature — Rat Ninja', oracleText: 'Ninjutsu {1}{B}', power: '2', toughness: '1' }),
			synthCard({ name: 'Cmd Ninjutsu Sample', typeLine: 'Legendary Creature — Human Ninja', oracleText: 'Commander ninjutsu {U}{B}', power: '1', toughness: '3' }),
			synthCard({ name: 'Scavenge Sample', typeLine: 'Creature — Plant Zombie', oracleText: 'Scavenge {2}{G}', power: '3', toughness: '3' }),
			synthCard({ name: 'Toxic Sample', typeLine: 'Creature — Phyrexian Mite', oracleText: 'Toxic 2', power: '1', toughness: '1' }),
			synthCard({ name: 'Bloodthirst N Sample', typeLine: 'Creature — Berserker', oracleText: 'Bloodthirst 2', power: '1', toughness: '1' }),
			synthCard({ name: 'Bloodthirst X Sample', typeLine: 'Creature — Hydra', oracleText: 'Bloodthirst X', power: '1', toughness: '1' }),
			synthCard({ name: 'Flanking Sample', typeLine: 'Creature — Human Knight', oracleText: 'Flanking', power: '2', toughness: '2' }),
			synthCard({ name: 'Fabricate Sample', typeLine: 'Creature — Artificer', oracleText: 'Fabricate 2', power: '1', toughness: '1' }),
			synthCard({ name: 'Unleash Sample', typeLine: 'Creature — Devil', oracleText: 'Unleash', power: '2', toughness: '2' }),
			synthCard({ name: 'Extort Sample', typeLine: 'Creature — Thrull', oracleText: 'Extort', power: '1', toughness: '2' }),
			synthCard({ name: 'Riot Sample', typeLine: 'Creature — Gruul Warrior', oracleText: 'Riot', power: '3', toughness: '3' })
		];

		for (const sample of samples) {
			const defA = compileCard({ ...sample, name: 'Synthetic Alpha' });
			const defB = compileCard({ ...sample, name: 'Synthetic Beta' });
			assert.equal(
				definitionSupportReport(defA).fullySupported,
				true,
				`Expected ${sample.name} to be fullySupported`
			);
			assert.deepEqual(defA.faces[0].abilities, defB.faces[0].abilities, `Rename invariance failed for ${sample.name}`);
		}

		const modularSunburst = synthCard({
			name: 'Arcbound Wanderer Probe',
			typeLine: 'Artifact Creature — Golem',
			oracleText: 'Modular—Sunburst',
			power: '0',
			toughness: '0'
		});
		const compiledSunburst = compileCard(modularSunburst);
		assert.equal(definitionSupportReport(compiledSunburst).fullySupported, false);
		assert.equal(
			compiledSunburst.faces[0].abilities.some(
				(a) => a.kind === 'unsupported' && a.reason === 'keyword_not_implemented'
			),
			true
		);
	});
});

describe('Wave 3 Track P9 — Echo (CR 702.30)', () => {
	it('triggers only on the first upkeep after coming under control, supports JSON round-trip prompt, and sacrifices on decline', () => {
		let { state, p1 } = setupGame();
		const echoCard = synthCard({
			name: 'Mogg War Marshal Probe',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Goblin Warrior',
			oracleText: 'Echo {1}{R}',
			power: '1',
			toughness: '1'
		});
		const perm = addToZone(state, p1, echoCard, 'battlefield');

		// Upkeep 1: perm came under control after last upkeep -> Echo triggers
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 1);
		giveMana(p1, { R: 2 });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);

		// JSON round-trip mid-prompt
		state = jsonRoundTrip(state);
		p1 = state.players[0];
		const prmId = state.pendingPrompts[0].id;
		const payRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prmId,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(payRes.ok, true);
		assert.equal(p1.battlefield.some((c) => c.instanceId === perm.instanceId), true);
		assert.equal(p1.manaPool.R, 0);

		// Upkeep 2 on a subsequent turn: Echo does NOT trigger again!
		state.turnNumber += 1;
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 0, 'Echo must not trigger on subsequent upkeeps');

		// Second Echo creature declined when affordable -> sacrificed and mana preserved
		const perm2 = addToZone(state, p1, echoCard, 'battlefield');
		state.turnNumber += 1;
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 1);
		giveMana(p1, { R: 2 });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'yesNo', yes: false }
		});
		assert.equal(p1.battlefield.some((c) => c.instanceId === perm2.instanceId), false);
		assert.equal(p1.graveyard.some((c) => c.instanceId === perm2.instanceId), true);
		assert.equal(p1.manaPool.R, 2);
	});
});

describe('Wave 3 Track P9 — Madness (CR 702.35, 400.7k)', () => {
	it('exiles discarded card instead of graveyard, casts for Madness cost when accepted (including cleanup discard), or moves to graveyard on decline', () => {
		let { state, p1, p2 } = setupGame({ maxHandSize: 1 });
		const madnessBolt = synthCard({
			name: 'Fiery Temper Probe',
			manaCost: '{1}{R}{R}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText: '~ deals 3 damage to any target.\nMadness {R}',
			colors: ['R']
		});
		const lootSpell = synthCard({
			name: 'Discard Probe',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Discard a card.'
		});
		const boltInst = addToZone(state, p1, madnessBolt, 'hand');
		const lootInst = addToZone(state, p1, lootSpell, 'hand');
		giveMana(p1, { R: 3 });

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: lootInst.instanceId }).ok,
			true
		);
		drainStackUntilPromptOrEmpty(state);
		// Discard boltInst -> Madness replacement exiles it and puts Madness trigger on stack
		if (state.pendingPrompts.length > 0) {
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [boltInst.instanceId] }
			});
		}
		assert.equal(p1.exile.some((c) => c.instanceId === boltInst.instanceId), true);
		assert.equal(p1.graveyard.some((c) => c.instanceId === boltInst.instanceId), false);
		assert.equal(state.stack.length, 1);

		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		state = jsonRoundTrip(state);
		p1 = state.players[0];
		p2 = state.players[1];

		// Accept Madness cast
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'yesNo', yes: true }
		});
		// Choose target Bob
		assert.equal(state.pendingPrompts.length, 1);
		const bobModeIdx =
			state.pendingPrompts[0].choice?.kind === 'chooseMode'
				? state.pendingPrompts[0].choice.modes.findIndex((m) => m.includes('Bob'))
				: 0;
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'chooseMode', indices: [Math.max(0, bobModeIdx)] }
		});

		// Fiery Temper Probe is now on the stack! Resolve it:
		assert.equal(state.stack.some((s) => s.kind === 'spell' && s.card.name === 'Fiery Temper Probe'), true);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p2.life, 37);

		// Decline case: discarded Madness card during cleanup (with untapped Mountain so Madness is affordable) moves from exile to graveyard
		const mountain = synthCard({
			name: 'Madness Mountain',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Mountain',
			oracleText: '{T}: Add {R}.'
		});
		addToZone(state, p1, mountain, 'battlefield');
		const bolt2 = addToZone(state, p1, madnessBolt, 'hand');
		const filler = addToZone(state, p1, lootSpell, 'hand');
		void filler;
		// Advance to cleanup discard (maxHandSize = 1, hand has 2 cards)
		state.phase = 'main2';
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		// End step -> pass both to enter cleanup
		drainStackUntilPromptOrEmpty(state);
		if ((state.phase as string) === 'end_step') {
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		}
		assert.equal(state.pendingPrompts[0]?.kind, 'discard_to_hand_size');
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'chooseObjects', objectIds: [bolt2.instanceId] }
		});
		assert.equal(p1.exile.some((c) => c.instanceId === bolt2.instanceId), true);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'yesNo', yes: false }
		});
		assert.equal(p1.graveyard.some((c) => c.instanceId === bolt2.instanceId), true);
	});
});

describe('Wave 3 Track P9 — Cascade (CR 702.85) & Rebound (CR 702.88)', () => {
	it('cascades on cast, enforces both exile MV and resulting stack face MV on MDFCs, and tucks remaining exiled cards', () => {
		const { state, p1, p2 } = setupGame();
		const land = synthCard({ name: 'Cascade Land', manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' });
		const mdfc = synthCard({
			name: 'Bala Probe // Expensive Back',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: '~ deals 2 damage to each opponent.',
			layout: 'modal_dfc',
			faces: [
				{
					name: 'Bala Probe',
					manaCost: '{1}{R}',
					typeLine: 'Sorcery',
					oracleText: '~ deals 2 damage to each opponent.',
					colors: ['R'],
					imageUrl: ''
				},
				{
					name: 'Expensive Back',
					manaCost: '{5}{R}',
					typeLine: 'Creature — Dragon',
					oracleText: 'Flying',
					colors: ['R'],
					power: '5',
					toughness: '5',
					imageUrl: ''
				}
			]
		});
		const cascadeSpell = synthCard({
			name: 'Bloodbraid Probe',
			manaCost: '{2}{R}{G}',
			cmc: 4,
			typeLine: 'Creature — Elf Berserker',
			oracleText: 'Cascade\nHaste',
			power: '3',
			toughness: '2'
		});
		p1.library = [];
		const topLand = addToZone(state, p1, land, 'library');
		const hitMdfc = addToZone(state, p1, mdfc, 'library');
		const cascInst = addToZone(state, p1, cascadeSpell, 'hand');
		giveMana(p1, { R: 2, G: 2 });

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: cascInst.instanceId }).ok,
			true
		);
		// Stack has Bloodbraid Probe on bottom and Cascade trigger on top
		assert.equal(state.stack.length, 2);
		drainStackUntilPromptOrEmpty(state);
		// Prompt offers ONLY Bala Probe (MV 2 < 4), NOT Expensive Back (MV 6 >= 4)!
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].title.includes('Bala Probe'), true);
		assert.equal(state.pendingPrompts[0].title.includes('Expensive Back'), false);

		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'yesNo', yes: true }
		});
		// TopLand was tucked to bottom of library; Bala Probe is now on top of Bloodbraid Probe on stack!
		assert.equal(p1.library.some((c) => c.instanceId === topLand.instanceId), true);
		assert.equal(state.stack[state.stack.length - 1].title, 'Bala Probe');
		void hitMdfc;

		drainStackUntilPromptOrEmpty(state);
		assert.equal(p2.life, 38);
		assert.equal(p1.battlefield.some((c) => c.card.name === 'Bloodbraid Probe'), true);
	});

	it('exiles a Rebound spell cast from hand on resolution, casts it free on next upkeep, and then puts it into graveyard', () => {
		const { state, p1 } = setupGame();
		const reboundCard = synthCard({
			name: 'Ephemerate Probe',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'You gain 2 life.\nRebound',
			colors: ['W']
		});
		const inst = addToZone(state, p1, reboundCard, 'hand');
		giveMana(p1, { W: 1 });

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: inst.instanceId }).ok,
			true
		);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p1.life, 42);
		assert.equal(p1.exile.some((c) => c.instanceId === inst.instanceId), true);
		assert.equal(p1.graveyard.some((c) => c.instanceId === inst.instanceId), false);

		// Next upkeep of p1: Rebound delayed trigger fires
		state.turnNumber += 1;
		runBeginningOfTurn(state);
		assert.equal(state.stack.length, 1);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'yesNo', yes: true }
		});
		// Cast from exile without paying mana -> resolves to graveyard (does NOT rebound a second time!)
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p1.life, 44);
		assert.equal(p1.exile.some((c) => c.instanceId === inst.instanceId), false);
		assert.equal(p1.graveyard.some((c) => c.instanceId === inst.instanceId), true);
	});
});

describe('Wave 3 Track P9 — Undying, Persist, Modular & CR 704.8 Pre-SBA Counter LKI', () => {
	it('handles Undying, Persist, Modular, and enforces CR 704.8 pre-SBA counter LKI before +1/+1 & -1/-1 annihilation', () => {
		const { state, p1 } = setupGame({ p1Bot: true });
		const undyingWolf = synthCard({
			name: 'Young Wolf Probe',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Creature — Wolf',
			oracleText: 'Undying',
			power: '1',
			toughness: '1'
		});
		const persistOuphe = synthCard({
			name: 'Kitchen Finks Probe',
			manaCost: '{1}{G}{W}',
			cmc: 3,
			typeLine: 'Creature — Ouphe',
			oracleText: 'Persist',
			power: '2',
			toughness: '2'
		});
		const modularWorker = synthCard({
			name: 'Arcbound Worker Probe',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Artifact Creature — Construct',
			oracleText: 'Modular 2',
			power: '0',
			toughness: '0'
		});
		const thopter = synthCard({
			name: 'Ornithopter Probe',
			manaCost: '{0}',
			cmc: 0,
			typeLine: 'Artifact Creature — Thopter',
			oracleText: 'Flying',
			power: '0',
			toughness: '2'
		});
		const killSpell = synthCard({
			name: 'Terminate Probe',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});

		// 1. Undying returns without +1/+1 counter -> gains +1/+1 counter
		const wolf1 = addToZone(state, p1, undyingWolf, 'battlefield');
		const kill1 = addToZone(state, p1, killSpell, 'hand');
		giveMana(p1, { B: 1 });
		applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: kill1.instanceId,
			targets: [{ kind: 'permanent', id: wolf1.instanceId, label: wolf1.card.name }]
		});
		drainStackUntilPromptOrEmpty(state);
		const returnedWolf = p1.battlefield.find((c) => c.instanceId === wolf1.instanceId);
		assert.ok(returnedWolf, 'Undying creature without +1/+1 counter should return');
		assert.equal(returnedWolf.counters['+1/+1'], 1);

		// 2. Persist returns without -1/-1 counter -> gains -1/-1 counter
		const ouphe = addToZone(state, p1, persistOuphe, 'battlefield');
		const kill2 = addToZone(state, p1, killSpell, 'hand');
		giveMana(p1, { B: 1 });
		applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: kill2.instanceId,
			targets: [{ kind: 'permanent', id: ouphe.instanceId, label: ouphe.card.name }]
		});
		drainStackUntilPromptOrEmpty(state);
		const returnedOuphe = p1.battlefield.find((c) => c.instanceId === ouphe.instanceId);
		assert.ok(returnedOuphe, 'Persist creature without -1/-1 counter should return');
		assert.equal(returnedOuphe.counters['-1/-1'], 1);

		// 3. CR 704.8: Young Wolf (1/1) with ONE +1/+1 counter gets TWO -1/-1 counters -> 0/0 + counter annihilation in same SBA pass.
		// Pre-SBA it HAD a +1/+1 counter, so Undying MUST NOT trigger!
		addCountersToPermanent(state, returnedWolf, '-1/-1', 2);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === wolf1.instanceId),
			false,
			'CR 704.8: Young Wolf had a +1/+1 counter pre-SBA and must NOT return via Undying'
		);
		assert.equal(p1.graveyard.some((c) => c.instanceId === wolf1.instanceId), true);

		// 4. CR 704.8 + Modular: Cast Arcbound Worker (enters with 2 +1/+1 counters), place 2 -1/-1 counters -> 0/0 + annihilation in same SBA pass.
		// Pre-SBA it had 2 +1/+1 counters -> Modular moves 2 +1/+1 counters onto Ornithopter Probe!
		const thopInst = addToZone(state, p1, thopter, 'battlefield');
		const workerHand = addToZone(state, p1, modularWorker, 'hand');
		giveMana(p1, { W: 1 });
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: workerHand.instanceId });
		drainStackUntilPromptOrEmpty(state);
		const workerBf = p1.battlefield.find((c) => c.instanceId === workerHand.instanceId)!;
		assert.equal(workerBf.counters['+1/+1'], 2);

		addCountersToPermanent(state, workerBf, '-1/-1', 2);
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(
			thopInst.counters['+1/+1'],
			2,
			'CR 704.8: Modular must transfer the 2 pre-SBA +1/+1 counters onto target artifact creature'
		);
	});
});

describe('Wave 3 Track P9 — Soulshift, Improvise, Dash & Scavenge', () => {
	it('runs Soulshift N, Improvise generic-only artifact tapping, Dash haste + end-step bounce, and Scavenge LKI power', () => {
		const { state, p1, p2 } = setupGame({ p1Bot: true });

		// 1. Soulshift 3 returns Spirit MV <= 3 from graveyard to hand on death
		const smallSpirit = synthCard({
			name: 'Kami Probe',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Spirit',
			oracleText: 'Flying',
			power: '2',
			toughness: '2'
		});
		const bigSpirit = synthCard({
			name: 'Big Kami Probe',
			manaCost: '{4}{W}',
			cmc: 5,
			typeLine: 'Creature — Spirit',
			oracleText: 'Flying',
			power: '4',
			toughness: '4'
		});
		const soulshifter = synthCard({
			name: 'Gibbering Kami Probe',
			manaCost: '{3}{B}',
			cmc: 4,
			typeLine: 'Creature — Spirit',
			oracleText: 'Soulshift 3',
			power: '2',
			toughness: '2'
		});
		const killSpell = synthCard({
			name: 'Murder Probe',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});
		const smallInst = addToZone(state, p1, smallSpirit, 'graveyard');
		const bigInst = addToZone(state, p1, bigSpirit, 'graveyard');
		const shifterInst = addToZone(state, p1, soulshifter, 'battlefield');
		const killInst = addToZone(state, p1, killSpell, 'hand');
		giveMana(p1, { B: 1 });
		applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: killInst.instanceId,
			targets: [{ kind: 'permanent', id: shifterInst.instanceId, label: shifterInst.card.name }]
		});
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p1.hand.some((c) => c.instanceId === smallInst.instanceId), true);
		assert.equal(p1.graveyard.some((c) => c.instanceId === bigInst.instanceId), true);

		// 2. Improvise: taps 2 non-mana artifacts + {U} to cast {2}{U} spell; cannot pay colored {U} with artifacts
		const clue = synthCard({ name: 'Clue Artifact Probe', manaCost: '{1}', cmc: 1, typeLine: 'Artifact', oracleText: '' });
		const improviseDraw = synthCard({
			name: 'Reverse Engineer Probe',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Improvise\nYou gain 3 life.'
		});
		const a1 = addToZone(state, p1, clue, 'battlefield');
		const a2 = addToZone(state, p1, clue, 'battlefield');
		a1.summoningSick = true; // artifacts ignore summoning sickness for Improvise
		const impInst = addToZone(state, p1, improviseDraw, 'hand');
		state.priorityPlayerIndex = 0;
		// Without {U}, cannot cast even with aid:improvise (Improvise pays only generic mana)
		assert.equal(getCastOptions(state, p1.playerId, impInst, 'hand').length, 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: impInst.instanceId,
				costAidIds: { 'aid:improvise': [a1.instanceId, a2.instanceId] }
			}).ok,
			false
		);
		giveMana(p1, { U: 1 });
		const impOpts = getCastOptions(state, p1.playerId, impInst, 'hand');
		assert.equal(impOpts.length, 1);
		assert.ok(impOpts[0].paymentAids?.some((a) => a.id === 'aid:improvise'));
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: impInst.instanceId,
				costAidIds: { 'aid:improvise': [a1.instanceId, a2.instanceId] }
			}).ok,
			true
		);
		assert.equal(a1.tapped && a2.tapped, true);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p1.life, 43);

		// 3. Dash: grants haste and returns to owner's hand at beginning of next end step
		const dasher = synthCard({
			name: 'Zurgo Bellstriker Probe',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Creature — Orc Warrior',
			oracleText: 'Dash {1}{R}',
			power: '2',
			toughness: '2'
		});
		const dashInst = addToZone(state, p1, dasher, 'hand');
		giveMana(p1, { R: 2 });
		state.priorityPlayerIndex = 0;
		const dashOpt = getCastOptions(state, p1.playerId, dashInst, 'hand').find((o) =>
			o.label.toLowerCase().includes('dash')
		);
		assert.ok(dashOpt, 'Expected Dash cast option');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: dashInst.instanceId,
				optionId: dashOpt.id
			}).ok,
			true
		);
		drainStackUntilPromptOrEmpty(state);
		const dashedPerm = p1.battlefield.find((c) => c.instanceId === dashInst.instanceId)!;
		assert.ok(dashedPerm);
		assert.equal(hasKeyword(dashedPerm, 'Haste', state), true);

		// Scavenge before end step onto dashedPerm!
		const scavenger = synthCard({
			name: 'Slitherhead Probe',
			manaCost: '{B/G}',
			cmc: 1,
			typeLine: 'Creature — Plant Zombie',
			oracleText: 'Scavenge {G}',
			power: '3',
			toughness: '2'
		});
		const scavInst = addToZone(state, p1, scavenger, 'graveyard');
		giveMana(p1, { G: 1 });
		state.priorityPlayerIndex = 0;
		const scavAb = getEffectiveActivatedAbilities(state, p1, scavInst)[0];
		assert.ok(scavAb);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: scavInst.instanceId,
				abilityId: scavAb.id,
				targets: [{ kind: 'permanent', id: dashedPerm.instanceId, label: dashedPerm.card.name }]
			}).ok,
			true
		);
		assert.equal(p1.exile.some((c) => c.instanceId === scavInst.instanceId), true);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(dashedPerm.counters['+1/+1'], 3);

		// Advance to end step -> Dash delayed trigger bounces dashedPerm back to hand!
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p1.hand.some((c) => c.instanceId === dashInst.instanceId), true);
		assert.equal(p1.battlefield.some((c) => c.instanceId === dashInst.instanceId), false);
	});
});

describe('Wave 3 Track P9 — Ninjutsu & Commander Ninjutsu (CR 702.49, 508.4, 903.8)', () => {
	it('enforces post-blockers window, returns unblocked attacker, enters tapped and attacking same defender, and bypasses commander tax', () => {
		const yuriko = synthCard({
			name: 'Yuriko Probe',
			manaCost: '{1}{U}{B}',
			cmc: 3,
			typeLine: 'Legendary Creature — Human Ninja',
			oracleText: 'Commander ninjutsu {U}{B}',
			power: '1',
			toughness: '3',
			canBeCommander: true
		});
		const { state, p1, p2 } = setupGame({ p1Commander: yuriko });
		const cmdYuriko = p1.command[0];
		assert.ok(cmdYuriko);
		cmdYuriko.commanderCastCount = 3;
		p1.commanderCastCounts = { [cmdYuriko.instanceId]: 3 };

		const ornithopter = synthCard({
			name: 'Unblocked Ornithopter',
			manaCost: '{0}',
			cmc: 0,
			typeLine: 'Artifact Creature — Thopter',
			oracleText: 'Flying',
			power: '0',
			toughness: '2'
		});
		const atkPerm = addToZone(state, p1, ornithopter, 'battlefield');
		const cmdAb = getEffectiveActivatedAbilities(state, p1, cmdYuriko)[0];
		assert.ok(cmdAb);

		// Illegal during main1
		giveMana(p1, { U: 1, B: 1 });
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, cmdYuriko, cmdAb).ok, false);

		// Enter declare_attackers -> still illegal BEFORE blockers are declared!
		state.phase = 'declare_attackers';
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: atkPerm.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, cmdYuriko, cmdAb).ok, false);

		// Advance to declare_blockers with zero blockers -> NOW Commander ninjutsu is legal and costs {U}{B} (NO +6 commander tax!)
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(state.phase, 'declare_blockers');
		applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
		giveMana(p1, { U: 1, B: 1 });
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, cmdYuriko, cmdAb).ok, true);

		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: cmdYuriko.instanceId,
			abilityId: cmdAb.id,
			costPayment: { objects: [[atkPerm.instanceId]] }
		});
		assert.equal(actRes.ok, true, actRes.error ?? 'activate failed');
		assert.equal(p1.hand.some((c) => c.instanceId === atkPerm.instanceId), true);
		assert.equal(p1.commanderCastCounts[cmdYuriko.instanceId], 3, 'Commander tax count must NOT increment');

		drainStackUntilPromptOrEmpty(state);
		const yurikoBf = p1.battlefield.find((c) => c.instanceId === cmdYuriko.instanceId)!;
		assert.ok(yurikoBf);
		assert.equal(yurikoBf.tapped, true);
		assert.equal(
			state.combat.attackers.some(
				(a) => a.attackerInstanceId === yurikoBf.instanceId && a.defenderPlayerId === p2.playerId
			),
			true
		);
	});
});

describe('Wave 3 Track P9 — Toxic, Bloodthirst, Flanking, Fabricate, Unleash, Riot & Extort', () => {
	it('stacks Toxic with Infect and normal combat damage, and enables Bloodthirst N/X from damage (not life loss)', () => {
		const { state, p1, p2 } = setupGame({ p2Bot: true });
		const toxicInfect = synthCard({
			name: 'Phyrexian Toxic Probe',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Phyrexian Beast',
			oracleText: 'Infect\nToxic 2',
			power: '3',
			toughness: '3'
		});
		const toxicNormal = synthCard({
			name: 'Jawbone Mite Probe',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Creature — Phyrexian Mite',
			oracleText: 'Toxic 1',
			power: '2',
			toughness: '2'
		});
		const atk1 = addToZone(state, p1, toxicInfect, 'battlefield');
		const atk2 = addToZone(state, p1, toxicNormal, 'battlefield');

		state.phase = 'declare_attackers';
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [
				{ attackerInstanceId: atk1.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: atk2.instanceId, defenderPlayerId: p2.playerId }
			]
		});
		const forecast = computeCombatDamageForecast(state);
		// atk1: 3 Infect + 2 Toxic = 5 poison; atk2: 2 life loss + 1 Toxic = 1 poison -> total 6 poison, 2 life loss
		assert.equal(forecast.playerIncoming[p2.playerId].totalPoisonGain, 6);
		assert.equal(forecast.playerIncoming[p2.playerId].totalLifeLoss, 2);

		// Pass through blockers & combat damage -> main2
		for (let i = 0; i < 10 && (state.phase as string) !== 'main2'; i++) {
			const actor = state.players[state.priorityPlayerIndex];
			applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		}
		assert.equal(p2.poison, 6);
		assert.equal(p2.life, 38);
		assert.equal(p2.damageDealtToThisTurn, 5);

		// Bloodthirst X sees 5 total damage dealt to opponents this turn!
		const hydra = synthCard({
			name: 'Petrified Wood-Kin Probe',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Elemental',
			oracleText: 'Bloodthirst X',
			power: '1',
			toughness: '1'
		});
		const hydraInst = addToZone(state, p1, hydra, 'hand');
		giveMana(p1, { G: 2 });
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: hydraInst.instanceId });
		drainStackUntilPromptOrEmpty(state);
		const hydraBf = p1.battlefield.find((c) => c.instanceId === hydraInst.instanceId)!;
		assert.equal(hydraBf.counters['+1/+1'], 5);
	});

	it('triggers Flanking against non-Flanking blockers, runs Fabricate choice, Riot multi-choice, Unleash cantBlock toggle, and Extort', () => {
		let { state, p1, p2 } = setupGame();

		// 1. Extort + Riot (double Riot -> choose +1/+1 AND Haste!)
		const extorter = synthCard({
			name: 'Basilica Screecher Probe',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Bat',
			oracleText: 'Extort',
			power: '1',
			toughness: '2'
		});
		addToZone(state, p1, extorter, 'battlefield');

		const doubleRiot = synthCard({
			name: 'Rhythm Ogre Probe',
			manaCost: '{1}{R}{G}',
			cmc: 3,
			typeLine: 'Creature — Ogre Warrior',
			oracleText: 'Riot\nRiot',
			power: '2',
			toughness: '2'
		});
		const riotInst = addToZone(state, p1, doubleRiot, 'hand');
		giveMana(p1, { R: 1, G: 1, W: 2 }); // {1}{R}{G} + {W} for Extort!
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: riotInst.instanceId });

		// Extort trigger is on top of stack!
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(p2.life, 39);
		assert.equal(p1.life, 41);

		// Now resolve Rhythm Ogre Probe -> two Riot prompts!
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		state = jsonRoundTrip(state);
		p1 = state.players[0];
		p2 = state.players[1];
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'chooseMode', indices: [0] } // +1/+1 counter
		});
		assert.equal(state.pendingPrompts.length, 1);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'chooseMode', indices: [1] } // Haste
		});
		const riotBf = p1.battlefield.find((c) => c.instanceId === riotInst.instanceId)!;
		assert.equal(riotBf.counters['+1/+1'], 1);
		assert.equal(hasKeyword(riotBf, 'Haste', state), true);

		// 2. Fabricate 2 -> choose Servo tokens (yesNo: false)
		const fabricator = synthCard({
			name: 'Weaponcraft Enthusiast Probe',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Creature — Aetherborn Artificer',
			oracleText: 'Fabricate 2',
			power: '0',
			toughness: '1'
		});
		const fabInst = addToZone(state, p1, fabricator, 'hand');
		giveMana(p1, { B: 3 });
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: fabInst.instanceId });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'yesNo', yes: false } // Create two 1/1 Servo tokens
		});
		assert.equal(p1.battlefield.filter((c) => c.isToken && c.card.name === 'Servo').length, 2);

		// 3. Unleash + Flanking combat test:
		// Give p2 an Unleash creature (enters with +1/+1 counter -> CANNOT block!) and a 2/2 Bear (no Flanking -> gets -1/-1!)
		const unleashDevil = synthCard({
			name: 'Rakdos Cackler Probe',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Creature — Devil',
			oracleText: 'Unleash',
			power: '1',
			toughness: '1'
		});
		const devilHand = addToZone(state, p1, unleashDevil, 'hand');
		giveMana(p1, { R: 1 });
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: devilHand.instanceId });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(state.pendingPrompts.length, 1);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'chooseMode', indices: [0] } // Enter with +1/+1 counter (Unleash)
		});
		const devilBf = p1.battlefield.find((c) => c.instanceId === devilHand.instanceId)!;
		assert.equal(devilBf.counters['+1/+1'], 1);

		// Move devilBf to p2's battlefield to test blocking restriction, plus a 2/2 Bear on p2's battlefield
		p1.battlefield = p1.battlefield.filter((c) => c.instanceId !== devilBf.instanceId);
		devilBf.controllerId = p2.playerId;
		p2.battlefield.push(devilBf);
		const bearCard = synthCard({
			name: 'Grizzly Probe',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			oracleText: '',
			power: '2',
			toughness: '2'
		});
		const bearBf = addToZone(state, p2, bearCard, 'battlefield');
		const flankerCard = synthCard({
			name: 'Benalish Cavalry Probe',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Knight',
			oracleText: 'Flanking',
			power: '2',
			toughness: '2'
		});
		const flankerBf = addToZone(state, p1, flankerCard, 'battlefield');

		state.phase = 'declare_attackers';
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: flankerBf.instanceId, defenderPlayerId: p2.playerId }]
		});
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(state.phase, 'declare_blockers');

		// Unleash creature WITH +1/+1 counter cannot block!
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: devilBf.instanceId, attackerInstanceId: flankerBf.instanceId }]
			}).ok,
			false
		);

		// Remove +1/+1 counter -> Unleash creature CAN block; test Flanking with Grizzly Probe (2/2 -> 1/1!)
		devilBf.counters['+1/+1'] = 0;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: bearBf.instanceId, attackerInstanceId: flankerBf.instanceId }]
			}).ok,
			true
		);
		// Flanking trigger is on stack -> resolve it -> Grizzly Probe becomes 1/1!
		assert.equal(state.stack.length, 1);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(evaluatePermanent(state, bearBf).power, 1);
		assert.equal(evaluatePermanent(state, bearBf).toughness, 1);
	});
});

describe('Wave 3 Track P9 — Additional CR Corner Cases (Layer 6 Death Grants, CR 111.8, CR 508.4, CR 702.123a)', () => {
	it('supports Layer-6-granted Undying, blocks token Undying return (CR 111.8), ignores life-loss for Bloodthirst, skips attack triggers on Ninjutsu (CR 508.4), and creates Servos when Fabricate source left board', () => {
		const { state, p1, p2 } = setupGame({ p1Bot: true });

		// 1. Layer-6-granted Undying returns non-token creature with +1/+1 counter, while token ceases to exist (CR 111.8)
		const mikaeusProbe = synthCard({
			name: 'Undying Granter Probe',
			manaCost: '{3}{B}{B}',
			cmc: 5,
			typeLine: 'Creature — Zombie Cleric',
			oracleText: 'Other creatures you control have undying.',
			power: '4',
			toughness: '4'
		});
		const vanillaBear = synthCard({
			name: 'Vanilla Bear Probe',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			oracleText: '',
			power: '2',
			toughness: '2'
		});
		const killSpell = synthCard({
			name: 'Doom Probe',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});
		addToZone(state, p1, mikaeusProbe, 'battlefield');
		const bearBf = addToZone(state, p1, vanillaBear, 'battlefield');
		const tokenBear = addToZone(state, p1, vanillaBear, 'battlefield');
		tokenBear.isToken = true;

		const k1 = addToZone(state, p1, killSpell, 'hand');
		giveMana(p1, { B: 1 });
		applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: k1.instanceId,
			targets: [{ kind: 'permanent', id: bearBf.instanceId, label: bearBf.card.name }]
		});
		drainStackUntilPromptOrEmpty(state);
		const returnedBear = p1.battlefield.find((c) => c.instanceId === bearBf.instanceId);
		assert.ok(returnedBear, 'Layer-6-granted Undying must return non-token creature');
		assert.equal(returnedBear.counters['+1/+1'], 1);

		const k2 = addToZone(state, p1, killSpell, 'hand');
		giveMana(p1, { B: 1 });
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: k2.instanceId,
			targets: [{ kind: 'permanent', id: tokenBear.instanceId, label: tokenBear.card.name }]
		});
		drainStackUntilPromptOrEmpty(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === tokenBear.instanceId),
			false,
			'CR 111.8: Token with Undying ceases to exist and must not return'
		);

		// 2. Direct life loss ("Each opponent loses 3 life") does NOT enable Bloodthirst!
		const lifeLossSpell = synthCard({
			name: 'Life Drain Probe',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Each opponent loses 3 life.'
		});
		const bloodBerserker = synthCard({
			name: 'Stormblood Probe',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Human Berserker',
			oracleText: 'Bloodthirst 2',
			power: '1',
			toughness: '1'
		});
		const llInst = addToZone(state, p1, lifeLossSpell, 'hand');
		const bbInst = addToZone(state, p1, bloodBerserker, 'hand');
		giveMana(p1, { B: 1, R: 2 });
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: llInst.instanceId });
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p2.life, 37);
		assert.equal(p2.damageDealtToThisTurn ?? 0, 0);
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: bbInst.instanceId });
		drainStackUntilPromptOrEmpty(state);
		const bbBf = p1.battlefield.find((c) => c.instanceId === bbInst.instanceId)!;
		assert.equal(bbBf.counters['+1/+1'], 0, 'Life loss without damage must not trigger Bloodthirst');

		// 3. Fabricate when source leaves battlefield before trigger resolves -> creates N Servo tokens (CR 702.123a)
		const fabCard = synthCard({
			name: 'Marionette Probe',
			manaCost: '{4}{B}{B}',
			cmc: 6,
			typeLine: 'Creature — Human Artificer',
			oracleText: 'Fabricate 3',
			power: '1',
			toughness: '3'
		});
		const fabHand = addToZone(state, p1, fabCard, 'hand');
		giveMana(p1, { B: 6 });
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: fabHand.instanceId });
		// Pass priority once to resolve creature spell onto battlefield -> Fabricate 3 trigger goes on stack
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(state.stack.length, 1);
		// Destroy Marionette Probe in response BEFORE Fabricate 3 resolves!
		const k3 = addToZone(state, p1, killSpell, 'hand');
		giveMana(p1, { B: 1 });
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: k3.instanceId,
			targets: [{ kind: 'permanent', id: fabHand.instanceId, label: fabHand.card.name }]
		});
		// Remove Undying Granter first so Marionette Probe stays dead!
		p1.battlefield = p1.battlefield.filter((c) => c.card.name !== 'Undying Granter Probe');
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p1.battlefield.filter((c) => c.isToken && c.card.name === 'Servo').length, 3);

		// 4. Ninjutsu from hand does NOT trigger "Whenever ~ attacks" (CR 508.4)
		const ninjaWithAttackTrigger = synthCard({
			name: 'Silent-Blade Probe',
			manaCost: '{3}{U}{B}',
			cmc: 5,
			typeLine: 'Creature — Human Ninja',
			oracleText: 'Ninjutsu {1}{B}\nWhenever ~ attacks, you gain 5 life.',
			power: '3',
			toughness: '2'
		});
		const ninjaHand = addToZone(state, p1, ninjaWithAttackTrigger, 'hand');
		p1.isBot = false;
		returnedBear.summoningSick = false;
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: returnedBear.instanceId, defenderPlayerId: p2.playerId }]
		});
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
		giveMana(p1, { B: 2 });
		const ninjutsuAb = getEffectiveActivatedAbilities(state, p1, ninjaHand)[0];
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: ninjaHand.instanceId,
				abilityId: ninjutsuAb.id,
				costPayment: { objects: [[returnedBear.instanceId]] }
			}).ok,
			true
		);
		drainStackUntilPromptOrEmpty(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === ninjaHand.instanceId), true);
		assert.equal(p1.life, lifeBefore, 'CR 508.4: Entering tapped and attacking via Ninjutsu must NOT fire attack triggers');
	});
});

describe('Wave 3 Track P9 — UI & AI Keyword-Agnostic Purity Guard', () => {
	it('keeps ArenaTable.svelte, src/lib/magic/ui/, and ai.ts free of Wave 3 keyword string literals', () => {
		const wave3Keywords = [
			'commander ninjutsu',
			'bloodthirst',
			'soulshift',
			'improvise',
			'fabricate',
			'flanking',
			'ninjutsu',
			'scavenge',
			'madness',
			'cascade',
			'rebound',
			'undying',
			'persist',
			'modular',
			'unleash',
			'extort'
		];
		const filesToCheck = [
			path.join(MAGIC_DIR, 'ai.ts'),
			path.join(REPO_ROOT, 'src/routes/magic/components/ArenaTable.svelte')
		];
		const uiDir = path.join(MAGIC_DIR, 'ui');
		if (fs.existsSync(uiDir)) {
			for (const entry of fs.readdirSync(uiDir)) {
				if (entry.endsWith('.ts') || entry.endsWith('.svelte')) {
					filesToCheck.push(path.join(uiDir, entry));
				}
			}
		}
		for (const file of filesToCheck) {
			if (!fs.existsSync(file)) continue;
			const src = fs.readFileSync(file, 'utf8').toLowerCase();
			for (const kw of wave3Keywords) {
				assert.equal(
					src.includes(`'${kw}'`) || src.includes(`"${kw}"`),
					false,
					`Forbidden Wave 3 keyword literal "${kw}" found in ${path.relative(REPO_ROOT, file)}`
				);
			}
		}
	});
});
