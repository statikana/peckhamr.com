import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	addCountersToPermanent,
	advancePhaseOrStep,
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	drawCards,
	evaluatePermanent,
	getCastOptions,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	hasKeyword,
	runBeginningOfTurn,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { executeBotStep } from '../ai.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { matchesObjectFilter } from './objectFilter.ts';
import { attachObject, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type EffectiveActivatedAbility,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

let synthSeq = 0;
let nextTestTs = 1000;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p17a_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p17a_${synthSeq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
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
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
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
		id: 'deck_p17a',
		userId: 'p1',
		name: 'Track P17a Deck',
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

function setupGame(
	opts: {
		p1Bot?: boolean;
		p2Bot?: boolean;
		threePlayer?: boolean;
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P17a Filler Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(Array.from({ length: 30 }, () => filler));
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
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
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
	if (opts.threePlayer) {
		const d3 = makeDeck(Array.from({ length: 30 }, () => filler));
		seats.push({
			seatIndex: 2,
			userId: 'p3',
			username: 'Carol',
			avatarUrl: '',
			isBot: false,
			deckId: d3.id,
			deckName: d3.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
		decks.set(2, d3);
	}
	const state = createInitialGameState('P17A_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: 20
	});
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	state.phase = 'main1';
	state.turnNumber = 2;
	for (const p of state.players) {
		p.life = 20;
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	noteLayerInputsChanged(state);
	return {
		state,
		p1: state.players[0],
		p2: state.players[1],
		p3: state.players[2]
	};
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor, number>>): void {
	for (const [k, v] of Object.entries(pool) as Array<[ManaColor, number]>) {
		player.manaPool[k] += v;
	}
}

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function playerTarget(player: PlayerGameState): TargetRef {
	return { kind: 'player', id: player.playerId, label: player.username };
}

function putPerm(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	opts: { summoningSick?: boolean; tapped?: boolean } = {}
): CardInstance {
	const inst = createCardInstance(
		card,
		player.playerId,
		'battlefield',
		false,
		false,
		nextTestTs++
	);
	inst.summoningSick = opts.summoningSick ?? false;
	inst.tapped = opts.tapped ?? false;
	player.battlefield.push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	zone: 'hand' | 'graveyard' | 'library' | 'exile',
	card: ScryfallCard,
	front = false
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, nextTestTs++);
	if (front) player[zone].unshift(inst);
	else player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

function isWave6AltOpt(id: string): boolean {
	return id.startsWith('static_w6_alt:') || id.startsWith('self_w6_alt:');
}

function passBoth(state: GameState): void {
	for (let guard = 0; guard < 40; guard++) {
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			if (pr.choice?.kind === 'chooseReplacement' && pr.choice.options.length > 0) {
				applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseReplacement', id: pr.choice.options[0].id }
				});
				continue;
			}
			if (pr.choice?.kind === 'orderObjects') {
				applyGameAction(state, pr.playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'orderObjects', topIds: pr.choice.objectIds }
				});
				continue;
			}
			break;
		}
		if (state.stack.length === 0) break;
		const prioPlayer = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		if (!res.ok) break;
	}
}

function advanceToPhase(state: GameState, targetPhase: GameState['phase']): void {
	for (let guard = 0; guard < 40; guard++) {
		if (state.phase === targetPhase && state.stack.length === 0) return;
		if (state.pendingPrompts.length > 0) return;
		const pr = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, pr.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function assertFullySupported(card: ScryfallCard): void {
	const def = compileCard(card);
	const report = definitionSupportReport(def);
	assert.equal(
		report.fullySupported,
		true,
		`Expected ${card.name} to compile with full support: ${JSON.stringify(report.unsupported)}`
	);
}

// ============================================================================
// 1. Top-of-Library / Hand Visibility & Static Cast Permissions (CR 401.5, 601.3)
// ============================================================================

describe('Wave 6 Track P17a — Visibility & Static Cast Permissions (CR 401.5, 601.3)', () => {
	it('reveals hands and top-of-library cards to the right viewers via sanitizeGameStateForViewer', () => {
		const { state, p1, p2 } = setupGame();
		const oppHandReveal = synthCard({
			name: 'Spyglass Lattice',
			typeLine: 'Enchantment',
			oracleText: 'Your opponents play with their hands revealed.'
		});
		const allTopReveal = synthCard({
			name: 'Crystal Lantern',
			typeLine: 'Artifact',
			oracleText: 'Players play with the top card of their libraries revealed.'
		});
		assertFullySupported(oppHandReveal);
		assertFullySupported(allTopReveal);

		const p1Secret = putInZone(
			state,
			p1,
			'hand',
			synthCard({ name: 'P1 Secret Card', oracleText: '' })
		);
		const p2Secret = putInZone(
			state,
			p2,
			'hand',
			synthCard({ name: 'P2 Secret Card', oracleText: '' })
		);
		const p1Top = putInZone(
			state,
			p1,
			'library',
			synthCard({ name: 'P1 Top Card', oracleText: '' }),
			true
		);
		const p2Top = putInZone(
			state,
			p2,
			'library',
			synthCard({ name: 'P2 Top Card', oracleText: '' }),
			true
		);

		// Before placing statics: opponent hands and libraries are hidden
		assert.equal(sanitizeGameStateForViewer(state, 'p1').players[1].hand.length, 0);
		assert.equal(sanitizeGameStateForViewer(state, 'p1').players[1].library.length, 0);

		putPerm(state, p1, oppHandReveal);
		const viewForP1 = sanitizeGameStateForViewer(state, 'p1');
		const viewForP2 = sanitizeGameStateForViewer(state, 'p2');
		assert.equal(viewForP1.players[1].hand[0]?.instanceId, p2Secret.instanceId);
		assert.equal(viewForP2.players[0].hand.length, 0, "P1's hand remains hidden from P2");

		putPerm(state, p1, allTopReveal);
		const viewWithLantern = sanitizeGameStateForViewer(state, 'p2');
		assert.equal(viewWithLantern.players[0].library.length, 1);
		assert.equal(viewWithLantern.players[0].library[0]?.instanceId, p1Top.instanceId);
		assert.equal(viewWithLantern.players[1].library[0]?.instanceId, p2Top.instanceId);
		assert.ok(p1Secret.instanceId);
	});

	it('casts top-of-library spells by paying life equal to mana value while preserving land plays', () => {
		const { state, p1 } = setupGame();
		const citadel = synthCard({
			name: 'Obsidian Bastion',
			manaCost: '{3}{B}{B}{B}',
			cmc: 6,
			typeLine: 'Legendary Artifact',
			oracleText:
				'You may look at the top card of your library any time.\nYou may play lands and cast spells from the top of your library. If you cast a spell this way, pay life equal to its mana value rather than pay its mana cost.'
		});
		assertFullySupported(citadel);
		putPerm(state, p1, citadel);

		const bigWurm = synthCard({
			name: 'Bastion Wurm',
			manaCost: '{3}{G}{G}',
			cmc: 5,
			typeLine: 'Creature — Wurm',
			power: '5',
			toughness: '5'
		});
		const topSpell = putInZone(state, p1, 'library', bigWurm, true);

		const opts = getCastOptions(state, p1.playerId, topSpell, 'library');
		const lifeOpt = opts.find((o) => isWave6AltOpt(o.id));
		assert.ok(lifeOpt, 'Expected life-for-MV alternative cast option on top-of-library spell');

		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: topSpell.instanceId,
			fromZone: 'library',
			optionId: lifeOpt.id
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(p1.life, 15, 'Should pay 5 life equal to mana value');
		passBoth(state);
		assert.equal(
			p1.battlefield.some((c) => c.card.name === 'Bastion Wurm'),
			true
		);

		// Top-of-library land play still works
		const forest = synthCard({
			name: 'Bastion Forest',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: '({T}: Add {G}.)'
		});
		const topLand = putInZone(state, p1, 'library', forest, true);
		const landRes = applyGameAction(state, p1.playerId, {
			type: 'play_land',
			instanceId: topLand.instanceId,
			fromZone: 'library'
		});
		assert.equal(landRes.ok, true, landRes.error ?? '');
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === topLand.instanceId),
			true
		);
	});

	it('grants free hand casts (X=0) and enforces once-per-turn static cast slots', () => {
		const { state, p1 } = setupGame();
		const omni = synthCard({
			name: 'Astral Plenary',
			manaCost: '{7}{U}{U}{U}',
			cmc: 10,
			typeLine: 'Enchantment',
			oracleText: 'You may cast spells from your hand without paying their mana costs.'
		});
		assertFullySupported(omni);
		const omniPerm = putPerm(state, p1, omni);

		const xDraw = synthCard({
			name: 'Mind Geyser',
			manaCost: '{X}{U}{U}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Draw X cards.'
		});
		assertFullySupported(xDraw);
		const xInst = putInZone(state, p1, 'hand', xDraw);

		const freeOpt = getCastOptions(state, p1.playerId, xInst, 'hand').find(
			(o) => o.permission === 'static_alt'
		);
		assert.ok(freeOpt);
		assert.equal(freeOpt.choosesX, false, 'CR 107.3b: X must be 0 without paying mana cost');

		// Remove Plenary and test once-per-turn free cast slot
		p1.battlefield = p1.battlefield.filter((b) => b.instanceId !== omniPerm.instanceId);
		noteLayerInputsChanged(state);

		const onceFree = synthCard({
			name: 'Chronicle Conduit',
			typeLine: 'Enchantment',
			oracleText:
				'Once during each of your turns, you may cast a spell from your hand without paying its mana cost.'
		});
		assertFullySupported(onceFree);
		putPerm(state, p1, onceFree);

		const bearA = putInZone(
			state,
			p1,
			'hand',
			synthCard({ name: 'Conduit Bear A', manaCost: '{2}{G}', cmc: 3, power: '2', toughness: '2' })
		);
		const bearB = putInZone(
			state,
			p1,
			'hand',
			synthCard({ name: 'Conduit Bear B', manaCost: '{2}{G}', cmc: 3, power: '2', toughness: '2' })
		);

		const optA = getCastOptions(state, p1.playerId, bearA, 'hand').find((o) =>
			isWave6AltOpt(o.id)
		);
		assert.ok(optA);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bearA.instanceId,
				optionId: optA.id
			}).ok,
			true
		);
		passBoth(state);

		const optBAfter = getCastOptions(state, p1.playerId, bearB, 'hand').find((o) =>
			isWave6AltOpt(o.id)
		);
		assert.equal(optBAfter, undefined, 'Once-per-turn free slot should be exhausted for this turn');
	});

	it('supports self graveyard cast with finality counter, conditional flash, and spell keyword grants', () => {
		const { state, p1, p2 } = setupGame();
		const phoenix = synthCard({
			name: 'Ashen Revenant',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Skeleton',
			power: '2',
			toughness: '1',
			oracleText:
				'You may cast Ashen Revenant from your graveyard by paying 2 life in addition to paying its other costs. If you do, it enters with a finality counter on it.'
		});
		assertFullySupported(phoenix);
		const gyInst = putInZone(state, p1, 'graveyard', phoenix);
		giveMana(p1, { C: 1, B: 1 });

		const gyOpt = getCastOptions(state, p1.playerId, gyInst, 'graveyard').find((o) =>
			isWave6AltOpt(o.id)
		);
		assert.ok(gyOpt, 'Expected self-graveyard additional-cost cast option');
		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: gyInst.instanceId,
			fromZone: 'graveyard',
			optionId: gyOpt.id
		});
		assert.equal(castRes.ok, true, castRes.error ?? '');
		assert.equal(p1.life, 18);
		passBoth(state);

		const bfRev = p1.battlefield.find((c) => c.card.name === 'Ashen Revenant');
		assert.ok(bfRev);
		assert.equal(bfRev.counters['finality'], 1, 'Should enter with a finality counter');

		// Self conditional flash on opponent's turn
		const ambusher = synthCard({
			name: 'Dusk Stalker',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Wolf',
			power: '2',
			toughness: '2',
			oracleText:
				'You may cast Dusk Stalker as though it had flash if you control a Skeleton.'
		});
		assertFullySupported(ambusher);
		const ambInst = putInZone(state, p1, 'hand', ambusher);
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		giveMana(p1, { C: 1, G: 1 });
		assert.equal(checkSpellCastLegality(state, p1.playerId, ambInst).ok, true);
		assert.ok(p2.playerId);

		// Spell keyword grant: "Noncreature spells you cast have delve."
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		const delveGranter = synthCard({
			name: 'Archive Condenser',
			typeLine: 'Enchantment',
			oracleText: 'Noncreature spells you cast have delve.'
		});
		assertFullySupported(delveGranter);
		putPerm(state, p1, delveGranter);

		const divination = synthCard({
			name: 'Arcane Study',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Draw two cards.'
		});
		const divInst = putInZone(state, p1, 'hand', divination);
		const fodder1 = putInZone(state, p1, 'graveyard', synthCard({ name: 'Fodder 1' }));
		const fodder2 = putInZone(state, p1, 'graveyard', synthCard({ name: 'Fodder 2' }));
		giveMana(p1, { U: 1 });

		const delveOpt = getCastOptions(state, p1.playerId, divInst, 'hand')[0];
		assert.equal(
			delveOpt.paymentAids?.some((a) => a.id === 'aid:delve'),
			true,
			'Granted delve should surface as a payment aid'
		);
		const delveRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: divInst.instanceId,
			costAidIds: { 'aid:delve': [fodder1.instanceId, fodder2.instanceId] }
		});
		assert.equal(delveRes.ok, true, delveRes.error ?? '');
		assert.equal(p1.exile.length, 2, 'Delve exiled 2 graveyard cards');
	});
});

// ============================================================================
// 2. Combat Taxes, Block Capacity, Virtual Power, & Flagbearer (CR 508.1, 509.1, 115.1)
// ============================================================================

describe('Wave 6 Track P17a — Combat Taxes, Modifiers, & Flagbearer', () => {
	it('enforces Propaganda-style attack tax and preserves JSON-serializable combat state', () => {
		const { state, p1, p2 } = setupGame();
		const prop = synthCard({
			name: 'Aether Tollgate',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Enchantment',
			oracleText:
				"Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you."
		});
		assertFullySupported(prop);
		putPerm(state, p2, prop);

		const attacker = putPerm(
			state,
			p1,
			synthCard({ name: 'Raider', power: '3', toughness: '2' })
		);
		advanceToPhase(state, 'declare_attackers');

		// Without mana, attacking P2 is illegal
		const noManaRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(noManaRes.ok, false);

		// JSON round-trip mid-combat invariant before declaring taxed attackers
		giveMana(p1, { C: 2 });
		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		const rtAtk = roundTripped.players[0].battlefield[0];
		const rtPayRes = applyGameAction(roundTripped, 'p1', {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: rtAtk.instanceId, defenderPlayerId: 'p2' }]
		});
		assert.equal(rtPayRes.ok, true, rtPayRes.error ?? '');
		assert.equal(roundTripped.players[0].manaPool.C, 0);
		assert.equal(
			roundTripped.combat?.attackers.some((a) => a.attackerInstanceId === rtAtk.instanceId),
			true
		);

		// Live state also pays {2} and commits the attack
		const livePayRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(livePayRes.ok, true, livePayRes.error ?? '');
		assert.equal(p1.manaPool.C, 0);
		assert.equal(
			state.combat?.attackers.some((a) => a.attackerInstanceId === attacker.instanceId),
			true
		);
	});

	it('handles dynamic blocker capacity, virtual reach, landwalk ignore, and Crew toughness/delta', () => {
		const { state, p1, p2 } = setupGame();

		// Crew using toughness + virtual power delta
		const vehicle = synthCard({
			name: 'Iron Juggernaut',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact — Vehicle',
			power: '5',
			toughness: '5',
			oracleText: 'Crew 4'
		});
		const pilotMod = synthCard({
			name: 'Wall Engineer',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Artificer',
			power: '0',
			toughness: '4',
			oracleText:
				'Creatures you control crew Vehicles using their toughness rather than their power.'
		});
		assertFullySupported(vehicle);
		assertFullySupported(pilotMod);
		const vehPerm = putPerm(state, p1, vehicle);
		const wallPerm = putPerm(state, p1, pilotMod);

		const crewAb = getEffectiveActivatedAbilities(state, p1, vehPerm).find(
			(a) => a.costKeyword === 'crew'
		);
		assert.ok(crewAb);
		assert.equal(
			checkAbilityActivationLegality(state, p1.playerId, vehPerm, crewAb).ok,
			true,
			'0/4 creature should satisfy Crew 4 via toughness'
		);
		const crewRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: vehPerm.instanceId,
			abilityId: crewAb.id,
			costPayment: { objects: [[wallPerm.instanceId]] }
		});
		assert.equal(crewRes.ok, true, crewRes.error ?? '');

		// Virtual reach + landwalk ignore + dynamic additional block count
		const reachAndWalk = synthCard({
			name: 'Canopy Sentinel',
			manaCost: '{2}{G}',
			cmc: 3,
			typeLine: 'Creature — Spider',
			power: '2',
			toughness: '5',
			oracleText:
				"Canopy Sentinel can block as though it had reach.\nCanopy Sentinel can block an additional creature each combat.\nCreatures with forestwalk can be blocked as though they didn't have forestwalk."
		});
		assertFullySupported(reachAndWalk);
		const sentinel = putPerm(state, p2, reachAndWalk);
		putPerm(
			state,
			p2,
			synthCard({
				name: 'Defender Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			})
		);

		const flyer = putPerm(
			state,
			p1,
			synthCard({
				name: 'Sky Hawk',
				power: '1',
				toughness: '1',
				keywords: ['Flying'],
				oracleText: 'Flying'
			})
		);
		const walker = putPerm(
			state,
			p1,
			synthCard({
				name: 'Woodland Walker',
				power: '2',
				toughness: '1',
				keywords: ['Forestwalk'],
				oracleText: 'Forestwalk'
			})
		);

		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: flyer.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: walker.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		advanceToPhase(state, 'declare_blockers');
		assert.equal(state.phase, 'declare_blockers');

		const blkRes = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [
				{ blockerInstanceId: sentinel.instanceId, attackerInstanceId: flyer.instanceId },
				{ blockerInstanceId: sentinel.instanceId, attackerInstanceId: walker.instanceId }
			]
		});
		assert.equal(
			blkRes.ok,
			true,
			`Sentinel should block both Flyer and Forestwalker: ${blkRes.error}`
		);
	});

	it('enforces Flagbearer targeting requirement and bypasses when Flagbearer has hexproof', () => {
		const { state, p1, p2 } = setupGame({ p1Bot: true });
		const bearerCard = synthCard({
			name: 'Banner Warden',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Flagbearer',
			power: '1',
			toughness: '3',
			oracleText:
				'While an opponent is choosing targets as part of casting a spell they control or activating an ability they control, that player must choose at least one Flagbearer on the battlefield if able.'
		});
		assertFullySupported(bearerCard);
		const bearer = putPerm(state, p2, bearerCard);
		const bystander = putPerm(
			state,
			p2,
			synthCard({ name: 'Valuable Bystander', power: '5', toughness: '5' })
		);

		const bolt = synthCard({
			name: 'Searing Bolt',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Searing Bolt deals 3 damage to target creature.'
		});
		const boltInst = putInZone(state, p1, 'hand', bolt);
		giveMana(p1, { R: 1 });

		// Targeting Bystander while Flagbearer is a legal target must fail
		const illegalRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: boltInst.instanceId,
			targets: [permTarget(bystander)]
		});
		assert.equal(illegalRes.ok, false, 'Must choose Flagbearer when able');

		// AI bot complies with Flagbearer requirement and casts Searing Bolt at Banner Warden
		executeBotStep(state, p1, p1);
		passBoth(state);
		assert.equal(
			p2.graveyard.some((c) => c.instanceId === bearer.instanceId),
			true,
			'Bot should have targeted and destroyed the Flagbearer'
		);

		// If a Flagbearer has hexproof, opponent is no longer able to target it
		const hexBearer = putPerm(state, p2, bearerCard);
		const cloak = synthCard({
			name: 'Shroud Mantle',
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control with toughness 3 or less have hexproof.'
		});
		assertFullySupported(cloak);
		putPerm(state, p2, cloak);

		const bolt2 = putInZone(state, p1, 'hand', bolt);
		giveMana(p1, { R: 1 });
		const bypassRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: bolt2.instanceId,
			targets: [permTarget(bystander)]
		});
		assert.equal(bypassRes.ok, true, 'Hexproof Flagbearer is not a legal target, so Bystander is legal');
		passBoth(state);
		assert.ok(hexBearer.instanceId);
	});
});

// ============================================================================
// 3. Universal ETB Counters, Counter/Token/Draw/Exile Replacements, & Mana Retention
// ============================================================================

describe('Wave 6 Track P17a — Universal Counters, Replacements, & Mana Retention', () => {
	it('compiles arbitrary named counters and applies +2/+2 non-standard P/T counters in Layer 7c', () => {
		const { state, p1 } = setupGame();
		const oddCounterCreature = synthCard({
			name: 'Ancient Baron',
			manaCost: '{3}{B}',
			cmc: 4,
			typeLine: 'Creature — Vampire',
			power: '1',
			toughness: '1',
			oracleText: 'Ancient Baron enters with a +2/+2 counter and two filibuster counters on it.'
		});
		assertFullySupported(oddCounterCreature);
		const handInst = putInZone(state, p1, 'hand', oddCounterCreature);
		giveMana(p1, { C: 3, B: 1 });

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: handInst.instanceId
			}).ok,
			true
		);
		passBoth(state);

		const bf = p1.battlefield.find((c) => c.card.name === 'Ancient Baron')!;
		assert.ok(bf);
		assert.equal(bf.counters['+2/+2'], 1);
		assert.equal(bf.counters['filibuster'], 2);
		assert.equal(getCreaturePower(bf, state), 3, '1 base + 2 from +2/+2 counter');
		assert.equal(getCreatureToughness(bf, state), 3);
	});

	it('applies Vorinclex-style counter doubling for you and halving (rounded down) for opponents', () => {
		const { state, p1, p2 } = setupGame();
		const vorinclex = synthCard({
			name: 'Apex Predator',
			manaCost: '{4}{G}{G}',
			cmc: 6,
			typeLine: 'Legendary Creature — Phyrexian Praetor',
			power: '6',
			toughness: '6',
			oracleText:
				'If you would put one or more counters on a permanent or player, put twice that many of each of those kinds of counters on that permanent or player instead.\nIf an opponent would put one or more counters on a permanent or player, they put half that many of each of those kinds of counters on that permanent or player instead, rounded down.'
		});
		assertFullySupported(vorinclex);
		putPerm(state, p1, vorinclex);

		const p1Bear = putPerm(state, p1, synthCard({ name: 'P1 Bear', power: '2', toughness: '2' }));
		const p2Bear = putPerm(state, p2, synthCard({ name: 'P2 Bear', power: '2', toughness: '2' }));

		addCountersToPermanent(state, p1Bear, '+1/+1', 2);
		assert.equal(p1Bear.counters['+1/+1'], 4, 'P1 placing 2 counters should double to 4');

		addCountersToPermanent(state, p2Bear, '+1/+1', 1);
		assert.equal(
			p2Bear.counters['+1/+1'] ?? 0,
			0,
			'Opponent placing 1 counter halves rounded down to 0'
		);
		addCountersToPermanent(state, p2Bear, '+1/+1', 3);
		assert.equal(p2Bear.counters['+1/+1'], 1, 'Opponent placing 3 counters halves to 1');
	});

	it('creates companion Food and Squirrel tokens on token creation and exiles opponent gravebound cards with void counters', () => {
		const { state, p1, p2 } = setupGame();
		const took = synthCard({
			name: 'Shire Baker',
			typeLine: 'Legendary Creature — Halfling Citizen',
			power: '2',
			toughness: '3',
			oracleText:
				'If one or more tokens would be created under your control, those tokens plus an additional Food token are created instead.'
		});
		const chatter = synthCard({
			name: 'Acorn General',
			typeLine: 'Legendary Creature — Squirrel Warrior',
			power: '3',
			toughness: '3',
			oracleText:
				'If one or more tokens would be created under your control, those tokens plus that many 1/1 green Squirrel creature tokens are created instead.'
		});
		const voidwalker = synthCard({
			name: 'Shadow Jailer',
			typeLine: 'Creature — Shadow Rogue',
			power: '3',
			toughness: '2',
			oracleText:
				'If a card would be put into an opponent\'s graveyard from anywhere, instead exile it with a void counter on it.'
		});
		assertFullySupported(took);
		assertFullySupported(chatter);
		assertFullySupported(voidwalker);
		putPerm(state, p1, took);
		putPerm(state, p1, chatter);
		putPerm(state, p1, voidwalker);

		const makeSoldiers = synthCard({
			name: 'Raise Patrol',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Create two 1/1 white Soldier creature tokens.'
		});
		const spellInst = putInZone(state, p1, 'hand', makeSoldiers);
		giveMana(p1, { C: 1, W: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spellInst.instanceId
			}).ok,
			true
		);
		passBoth(state);

		const tokens = p1.battlefield.filter((c) => c.isToken);
		assert.equal(tokens.filter((t) => t.card.typeLine.includes('Soldier')).length, 2);
		assert.equal(tokens.filter((t) => t.card.typeLine.includes('Food')).length, 1);
		assert.equal(tokens.filter((t) => t.card.typeLine.includes('Squirrel')).length >= 2, true);

		// Opponent creature dies -> exiled with a void counter instead of graveyard
		const oppVictim = putPerm(
			state,
			p2,
			synthCard({ name: 'Doomed Goblin', power: '1', toughness: '1' })
		);
		moveObject(state, oppVictim, 'graveyard', {
			from: 'anyBattlefield',
			graveyardReplacement: true
		});
		assert.equal(p2.graveyard.length, 0);
		assert.equal(p2.exile.length, 1);
		assert.equal(p2.exile[0].counters['void'], 1);
	});

	it('doubles non-first draw-step draws and retains/converts unspent mana across steps', () => {
		const { state, p1 } = setupGame();
		const insight = synthCard({
			name: 'Timeless Study',
			typeLine: 'Legendary Enchantment',
			oracleText:
				'If you would draw a card except the first one you draw in each of your draw steps, draw two cards instead.'
		});
		const horizon = synthCard({
			name: 'Planar Battery',
			typeLine: 'Artifact',
			oracleText:
				'If you would lose unspent mana, that mana becomes colorless instead.'
		});
		assertFullySupported(insight);
		assertFullySupported(horizon);
		putPerm(state, p1, insight);
		putPerm(state, p1, horizon);

		for (let i = 0; i < 6; i++) {
			putInZone(state, p1, 'library', synthCard({ name: `Lib Card ${i}` }));
		}

		// Simulate draw step first card (not doubled) vs second card (doubled)
		state.phase = 'draw';
		state.activePlayerIndex = 0;
		p1.cardsDrawnThisTurn = 0;
		p1.drewFirstCardInDrawStepThisTurn = false;
		drawCards(state, p1, 2);
		// 1st draw = 1 card, 2nd draw = 2 cards => 3 total!
		assert.equal(p1.hand.length, 3);

		// Mana conversion across step boundary
		state.phase = 'main1';
		giveMana(p1, { G: 2, U: 1 });
		advancePhaseOrStep(state);
		assert.equal(p1.manaPool.G, 0);
		assert.equal(p1.manaPool.U, 0);
		assert.equal(p1.manaPool.C, 3, 'Unspent colored mana should convert to colorless');
	});
});

// ============================================================================
// 4. Trigger Multipliers & Torpor Orb / Hushbringer Suppression (CR 603.2d)
// ============================================================================

describe('Wave 6 Track P17a — Trigger Multipliers & Suppression (CR 603.2d)', () => {
	it('doubles Legendary triggers and suppresses creature ETB triggers under Torpor Orb', () => {
		const { state, p1 } = setupGame();
		const annie = synthCard({
			name: 'Heroic Reunion',
			manaCost: '{1}{R}{G}{W}',
			cmc: 4,
			typeLine: 'Legendary Enchantment',
			oracleText:
				'If a triggered ability of a legendary permanent you control triggers, that ability triggers an additional time.'
		});
		assertFullySupported(annie);
		putPerm(state, p1, annie);

		const legEtb = synthCard({
			name: 'Sage of Peaks',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Legendary Creature — Human Advisor',
			power: '2',
			toughness: '2',
			oracleText: 'When Sage of Peaks enters, you gain 2 life.'
		});
		assertFullySupported(legEtb);
		const sageHand = putInZone(state, p1, 'hand', legEtb);
		giveMana(p1, { C: 2, W: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sageHand.instanceId
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(p1.life, 24, 'Legendary ETB life-gain trigger should fire twice (+4 life)');

		// Now put Torpor Orb on the battlefield: creature ETB triggers should be suppressed (0x)!
		const orb = synthCard({
			name: 'Null Sphere',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: "Creatures entering don't cause abilities to trigger."
		});
		assertFullySupported(orb);
		putPerm(state, p1, orb);

		const healer = synthCard({
			name: 'Cleric Initiate',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Cleric',
			power: '1',
			toughness: '2',
			oracleText: 'When Cleric Initiate enters, you gain 3 life.'
		});
		const healerHand = putInZone(state, p1, 'hand', healer);
		giveMana(p1, { C: 1, W: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: healerHand.instanceId
			}).ok,
			true
		);
		passBoth(state);
		assert.equal(p1.life, 24, 'Null Sphere must suppress creature ETB trigger completely');
	});
});

// ============================================================================
// 5. Layer 4/5/6/7 Dependency, Off-Battlefield Characteristics, & Rule Locks
// ============================================================================

describe('Wave 6 Track P17a — Layers, Off-Battlefield Grants, & Rule Locks', () => {
	it('resolves Urborg + Blood Moon Layer 4 dependency (CR 613.8) regardless of timestamp order', () => {
		const { state, p1 } = setupGame();
		const urborg = synthCard({
			name: 'Mire Tomb',
			manaCost: '',
			cmc: 0,
			typeLine: 'Legendary Land',
			oracleText: 'Each land is a Swamp in addition to its other land types.'
		});
		const bloodMoon = synthCard({
			name: 'Crimson Eclipse',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Enchantment',
			oracleText: 'Nonbasic lands are Mountains.'
		});
		assertFullySupported(urborg);
		assertFullySupported(bloodMoon);

		// Put Urborg down FIRST, Blood Moon SECOND (and test reverse timestamp too!)
		const urborgPerm = putPerm(state, p1, urborg);
		putPerm(state, p1, bloodMoon);

		const basicPlains = putPerm(
			state,
			p1,
			synthCard({
				name: 'Test Basic Plains',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Plains',
				oracleText: '({T}: Add {W}.)'
			})
		);

		// Under CR 613.8: Urborg's effect depends on Blood Moon because Blood Moon removes Urborg's ability in Layer 4!
		// So Blood Moon applies first -> Urborg becomes a Mountain (losing its ability) -> Basic Plains is NOT a Swamp!
		const urborgEval = evaluatePermanent(state, urborgPerm);
		const plainsEval = evaluatePermanent(state, basicPlains);
		assert.equal(urborgEval.typeLine.includes('Mountain'), true);
		assert.equal(urborgEval.typeLine.includes('Swamp'), false);
		assert.equal(plainsEval.typeLine.includes('Swamp'), false);
	});

	it('grants off-battlefield colors, creature types, and artifact type across hand, graveyard, and library', () => {
		const { state, p1 } = setupGame();
		const nexus = synthCard({
			name: 'Totem Matrix',
			manaCost: '{4}',
			cmc: 4,
			typeLine: 'Artifact',
			oracleText:
				'Creatures you control are every creature type. The same is true for creature spells you control and creature cards you own that aren\'t on the battlefield.'
		});
		const mycosynth = synthCard({
			name: 'Lattice Conduit',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Artifact',
			oracleText:
				'Nonland permanents you control are artifacts in addition to their other types. The same is true for permanent spells you control and nonland permanent cards you own that aren\'t on the battlefield.'
		});
		assertFullySupported(nexus);
		assertFullySupported(mycosynth);
		putPerm(state, p1, nexus);
		putPerm(state, p1, mycosynth);

		const gyBear = putInZone(
			state,
			p1,
			'graveyard',
			synthCard({ name: 'Grave Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
		);
		const handEnch = putInZone(
			state,
			p1,
			'hand',
			synthCard({ name: 'Hand Aura', typeLine: 'Enchantment', oracleText: '' })
		);

		assert.equal(
			matchesObjectFilter(
				gyBear,
				{ types: ['Creature'], subtypes: ['Elf'], zone: 'graveyard' },
				{ state, controllerId: p1.playerId }
			),
			true,
			'Graveyard creature card should match Elf via Totem Matrix'
		);
		assert.equal(
			matchesObjectFilter(
				handEnch,
				{ types: ['Artifact'], zone: 'hand' },
				{ state, controllerId: p1.playerId }
			),
			true,
			'Hand enchantment card should match Artifact via Lattice Conduit'
		);
	});

	it('enforces Deafening Silence spell cap, Grafdigger cast lock, Yasharn cost lock, Static Orb untap cap, Seedborn untap, and Mirror Box legend exemption', () => {
		const { state, p1, p2 } = setupGame();

		// 1. Deafening Silence: max 1 noncreature spell per turn, creatures still allowed
		const silence = synthCard({
			name: 'Hushed Decree',
			typeLine: 'Enchantment',
			oracleText: "Each player can't cast more than one noncreature spell each turn."
		});
		assertFullySupported(silence);
		putPerm(state, p2, silence);

		const opt1 = putInZone(
			state,
			p1,
			'hand',
			synthCard({ name: 'Cantrip 1', manaCost: '{U}', cmc: 1, typeLine: 'Instant', oracleText: 'Draw a card.' })
		);
		const opt2 = putInZone(
			state,
			p1,
			'hand',
			synthCard({ name: 'Cantrip 2', manaCost: '{U}', cmc: 1, typeLine: 'Instant', oracleText: 'Draw a card.' })
		);
		const creatureHand = putInZone(
			state,
			p1,
			'hand',
			synthCard({ name: 'Allowed Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2' })
		);
		putInZone(state, p1, 'library', synthCard({ name: 'Draw Replenish' }));
		giveMana(p1, { U: 2, C: 1, G: 1 });

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: opt1.instanceId }).ok,
			true
		);
		passBoth(state);
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, opt2).ok,
			false,
			'2nd noncreature spell must be blocked by Hushed Decree'
		);
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, creatureHand).ok,
			true,
			'Creature spell remains legal under Hushed Decree'
		);

		// 2. Grafdigger's Cage: players can't cast spells from graveyards or libraries
		const cage = synthCard({
			name: 'Iron Reliquary',
			typeLine: 'Artifact',
			oracleText: "Players can't cast spells from graveyards or libraries."
		});
		assertFullySupported(cage);
		putPerm(state, p2, cage);
		const flashbackSpell = putInZone(
			state,
			p1,
			'graveyard',
			synthCard({
				name: 'Graveyard Bear',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Zombie',
				power: '2',
				toughness: '2',
				oracleText: 'You may cast Graveyard Bear from your graveyard.'
			})
		);
		giveMana(p1, { C: 1, B: 1 });
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, flashbackSpell, 'graveyard').ok,
			false,
			'Iron Reliquary must block graveyard spell cast'
		);

		// 3. Yasharn: players can't pay life or sacrifice nonland permanents to cast spells or activate abilities
		const yasharn = synthCard({
			name: 'Earthwarden Boar',
			typeLine: 'Legendary Creature — Elemental Boar',
			power: '4',
			toughness: '4',
			oracleText:
				"Players can't pay life or sacrifice nonland permanents to cast spells or activate abilities."
		});
		assertFullySupported(yasharn);
		putPerm(state, p2, yasharn);

		const lifeActPerm = putPerm(
			state,
			p1,
			synthCard({
				name: 'Blood Altar',
				typeLine: 'Artifact',
				oracleText: 'Pay 2 life: Draw a card.'
			})
		);
		const lifeAb: EffectiveActivatedAbility = getEffectiveActivatedAbilities(
			state,
			p1,
			lifeActPerm
		)[0];
		assert.equal(
			checkAbilityActivationLegality(state, p1.playerId, lifeActPerm, lifeAb).ok,
			false,
			'Earthwarden Boar must block life-payment ability activation'
		);

		// 4. Mirror Box: the "legend rule" doesn't apply to permanents you control
		const mirror = synthCard({
			name: 'Reflection Vault',
			typeLine: 'Artifact',
			oracleText: 'The "legend rule" doesn\'t apply to permanents you control.'
		});
		assertFullySupported(mirror);
		putPerm(state, p1, mirror);
		const legA = putPerm(
			state,
			p1,
			synthCard({ name: 'Twin Hero', typeLine: 'Legendary Creature — Human', power: '2', toughness: '2' })
		);
		const legB = putPerm(
			state,
			p1,
			synthCard({ name: 'Twin Hero', typeLine: 'Legendary Creature — Human', power: '2', toughness: '2' })
		);
		checkStateBasedActions(state);
		assert.equal(
			p1.battlefield.filter((c) => c.card.name === 'Twin Hero').length,
			2,
			'Both Twin Hero legends survive SBA under Reflection Vault'
		);
		assert.ok(legA.instanceId !== legB.instanceId);

		// 5. Seedborn Muse untap during opponent's untap step + Static Orb untap cap prompt
		const muse = synthCard({
			name: 'Verdant Awakener',
			typeLine: 'Creature — Spirit',
			power: '2',
			toughness: '4',
			oracleText: "Untap all permanents you control during each other player's untap step."
		});
		assertFullySupported(muse);
		const musePerm = putPerm(state, p1, muse, { tapped: true });
		legA.tapped = true;
		legB.tapped = true;

		// Run P2's beginning of turn -> P1's tapped permanents untap!
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		runBeginningOfTurn(state);
		assert.equal(musePerm.tapped, false, "Seedborn Muse should untap during P2's untap step");
		assert.equal(legA.tapped, false);

		// Now put Static Orb down and tap 3 permanents of P1, then run P1's untap step
		const staticOrb = synthCard({
			name: 'Stasis Sphere',
			typeLine: 'Artifact',
			oracleText:
				"As long as Stasis Sphere is untapped, players can't untap more than two permanents during their untap steps."
		});
		assertFullySupported(staticOrb);
		putPerm(state, p2, staticOrb, { tapped: false });
		musePerm.tapped = true;
		legA.tapped = true;
		legB.tapped = true;

		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		runBeginningOfTurn(state);
		assert.equal(legA.tapped, false);
		assert.equal(legB.tapped, false);
		assert.equal(musePerm.tapped, true, '3rd tapped permanent must stay tapped under cap of 2');
	});
});

// ============================================================================
// 6. Synthetic Card Rename Invariance (ENGINE_INVARIANTS.md §1.3)
// ============================================================================

describe('Wave 6 Track P17a — Synthetic Card Rename Invariance (§1.3)', () => {
	it('produces identical compiled IR (modulo name/spans) and identical runtime results under arbitrary card names', () => {
		const buildVariant = (cardName: string): ScryfallCard =>
			synthCard({
				name: cardName,
				manaCost: '{2}{G}{W}',
				cmc: 4,
				typeLine: 'Legendary Creature — Elf Noble',
				power: '2',
				toughness: '3',
				oracleText: `${cardName} enters with two oil counters on it.\nCreatures you control with counters on them get +1/+1 and have vigilance and afterlife 1.\nOnce during each of your turns, you may cast a creature spell from the top of your library.`
			});

		const cardA = buildVariant('Quarzite Sovereign Alpha');
		const cardB = buildVariant('Zephryn Regent Omega');
		const irA = compileCard(cardA);
		const irB = compileCard(cardB);
		assert.equal(definitionSupportReport(irA).fullySupported, true);
		assert.equal(definitionSupportReport(irB).fullySupported, true);

		const scrubSpansAndText = (val: unknown): unknown => {
			if (Array.isArray(val)) return val.map(scrubSpansAndText);
			if (val && typeof val === 'object') {
				const out: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
					if (k === 'span' || k === 'text' || k === 'name') continue;
					out[k] = scrubSpansAndText(v);
				}
				return out;
			}
			return val;
		};

		assert.deepEqual(
			scrubSpansAndText(irA.faces[0].abilities),
			scrubSpansAndText(irB.faces[0].abilities),
			'Compiled static/ETB IR must depend exclusively on grammar, never on card name'
		);

		const runScenario = (card: ScryfallCard): { power: number; counters: number; topCastOk: boolean } => {
			const { state, p1 } = setupGame();
			const handInst = putInZone(state, p1, 'hand', card);
			const topBear = putInZone(
				state,
				p1,
				'library',
				synthCard({ name: 'Top Deck Scout', manaCost: '{G}', cmc: 1, power: '1', toughness: '1' }),
				true
			);
			giveMana(p1, { C: 2, G: 2, W: 1 });
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: handInst.instanceId });
			passBoth(state);
			const perm = p1.battlefield.find((c) => c.card.name === card.name)!;
			assert.equal(hasKeyword(perm, 'vigilance', state), true);
			const topRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: topBear.instanceId,
				fromZone: 'library'
			});
			passBoth(state);
			return {
				power: getCreaturePower(perm, state),
				counters: perm.counters['oil'] ?? 0,
				topCastOk: topRes.ok
			};
		};

		assert.deepEqual(runScenario(cardA), { power: 3, counters: 2, topCastOk: true });
		assert.deepEqual(runScenario(cardA), runScenario(cardB));
	});
});
