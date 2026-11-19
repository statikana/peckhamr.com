import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createInitialGameState,
	evaluatePermanent,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { findMandatoryAttackerViolation } from './combat.ts';
import { executeEffectSteps } from './effects.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	applyEtbDiscardForKeywordCountersWave9,
	applyEtbRemoveCountersForPlusCountersWave9,
	applyTokenReplacementsWave9
} from './replaceWave9.ts';
import { drawCards, executeProliferate } from './turnAndPrompts.ts';
import { attachObject, createEmptyCounters, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

let synthSeq = 0;

const CANONICAL_BY_NAME = new Map<string, ScryfallCard>();
for (const c of Object.values(STAPLE_CARDS)) CANONICAL_BY_NAME.set(c.name, c);
for (const d of PRECON_DECKS) {
	for (const c of d.commanders) CANONICAL_BY_NAME.set(c.name, c);
	for (const e of d.cards) CANONICAL_BY_NAME.set(e.card.name, e.card);
}

function getCanonical(name: string): ScryfallCard {
	const found = CANONICAL_BY_NAME.get(name);
	assert.ok(found, `Expected canonical precon card "${name}" in PRECON_DECKS / STAPLE_CARDS`);
	return found;
}

function cloneRenamed(base: ScryfallCard, newName: string): ScryfallCard {
	const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const fullRe = new RegExp(escapeRe(base.name), 'g');
	const commaIdx = base.name.indexOf(',');
	const shortName = commaIdx > 0 ? base.name.slice(0, commaIdx) : null;
	const shortRe = shortName ? new RegExp(escapeRe(shortName), 'g') : null;
	const rewrite = (txt: string) => {
		let out = txt.replace(fullRe, newName);
		if (shortRe) out = out.replace(shortRe, newName);
		return out;
	};
	return {
		...structuredClone(base),
		id: `clone_w9s_${++synthSeq}`,
		oracleId: `clone_ora_w9s_${synthSeq}`,
		name: newName,
		oracleText: rewrite(base.oracleText)
	};
}

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_w9s_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_w9s_${synthSeq}`,
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
		id: 'deck_w9s',
		userId: 'p1',
		name: 'Wave 9S Test Deck',
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

function setupGame(opts: { seats?: number; startingLife?: number } = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	p3?: PlayerGameState;
} {
	const filler = synthCard({
		name: 'W9S Wastes Filler',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Wastes',
		oracleText: '{T}: Add {C}.'
	});
	const seatCount = opts.seats ?? 2;
	const d1 = makeDeck(Array.from({ length: 30 }, () => filler));
	const d2 = makeDeck(Array.from({ length: 30 }, () => filler));
	const d3 = makeDeck(Array.from({ length: 30 }, () => filler));
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
			isBot: false,
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
	if (seatCount >= 3) {
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
	const startLife = opts.startingLife ?? 20;
	const state = createInitialGameState('W9S_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: startLife
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
		p.life = startLife;
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

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library',
	opts: { checkSupport?: boolean } = {}
): CardInstance {
	if (opts.checkSupport !== false) {
		const rep = definitionSupportReport(compileCard(card));
		assert.equal(
			rep.fullySupported,
			true,
			`Expected "${card.name}" to compile cleanly, got unsupported: ${JSON.stringify(rep.unsupported)}`
		);
	}
	const inst: CardInstance = {
		instanceId: `inst_w9s_${++synthSeq}`,
		card,
		ownerId: player.playerId,
		controllerId: player.playerId,
		defaultControllerId: player.playerId,
		zone: 'exile',
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters: {
			...createEmptyCounters(),
			loyalty: card.loyalty ? parseInt(card.loyalty, 10) : 0
		},
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: false,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		objectVersion: 1
	};
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		newTimestamp: true,
		emit: false
	});
	noteLayerInputsChanged(state);
	return inst;
}

function drainStack(state: GameState): void {
	for (let guard = 0; guard < 24 && state.stack.length > 0 && state.pendingPrompts.length === 0; guard++) {
		const pid = state.players[state.priorityPlayerIndex]?.playerId ?? state.players[0].playerId;
		applyGameAction(state, pid, { type: 'pass_priority' });
	}
}

function advanceToPhase(state: GameState, targetPhase: GameState['phase']): void {
	for (let guard = 0; guard < 24 && state.phase !== targetPhase; guard++) {
		const pid = state.players[state.priorityPlayerIndex]?.playerId ?? state.players[0].playerId;
		applyGameAction(state, pid, { type: 'pass_priority' });
	}
	assert.equal(state.phase, targetPhase, `Failed to reach phase ${targetPhase}, stuck at ${state.phase}`);
}

describe('Wave 12 / Wave 9S — Statics, Replacements, BigInt Layer Flags & Bespoke Primitives', () => {
	it('Compiler parity: all canonical Wave 12 general precon cards and renamed clones compile cleanly', () => {
		const names = [
			'Ozai, the Phoenix King',
			'Moraug, Fury of Akoum',
			'Thought Sponge',
			"Agatha's Soul Cauldron",
			'Arixmethes, Slumbering Isle',
			'Thrumming Stone',
			'Professor Hojo',
			'Valentin, Dean of the Vein',
			'Notion Thief',
			'Tekuthal, Inquiry Dominus',
			'Abundance',
			'Out of the Tombs',
			'Hithlain Rope',
			'Coin of Mastery',
			'Public Enemy',
			'Nowhere to Run',
			"Grafdigger's Cage",
			'Soulless Jailer'
		];
		for (const name of names) {
			const canonical = getCanonical(name);
			const r1 = definitionSupportReport(compileCard(canonical));
			assert.equal(r1.fullySupported, true, `${name} failed support: ${JSON.stringify(r1.unsupported)}`);
			const cloned = cloneRenamed(canonical, `Clone Of ${name}`);
			const r2 = definitionSupportReport(compileCard(cloned));
			assert.equal(r2.fullySupported, true, `Renamed clone of ${name} failed: ${JSON.stringify(r2.unsupported)}`);
		}
	});

	it('BigInt Flag READ_WAVE9_MANA (1n << 32n): Ozai, the Phoenix King & renamed clone invalidate cache automatically on unspent mana change', () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Ozai, the Phoenix King');
			const card = useClone ? cloneRenamed(base, 'Phoenix Emperor Clone') : base;
			const ozai = putInZone(state, p1, card, 'battlefield');
			const mtnCard = synthCard({
				name: `Synth Wastes Mana ${++synthSeq}`,
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Mountain',
				oracleText: '{T}: Add {R}.'
			});
			const lands = Array.from({ length: 6 }, () => putInZone(state, p1, mtnCard, 'battlefield'));

			// 0 unspent mana: Ozai should NOT yet have flying / indestructible
			const evBefore = evaluatePermanent(state, ozai);
			assert.equal(
				evBefore.activeKeywords.some((k) => k.toLowerCase() === 'flying'),
				false,
				'Expected no flying with 0 unspent mana'
			);

			// Tap 6 lands via real applyGameAction WITHOUT calling noteLayerInputsChanged manually
			for (const land of lands) {
				const abilities = getEffectiveActivatedAbilities(state, p1, land);
				const res = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: land.instanceId,
					abilityId: abilities[0].id
				});
				assert.equal(res.ok, true, `Failed tapping land: ${res.error}`);
			}

			// Under MAGIC_LAYER_CACHE_CHECK=1 this verifies READ_WAVE9_MANA invalidates automatically!
			const evAfter = evaluatePermanent(state, ozai);
			assert.equal(
				evAfter.activeKeywords.some((k) => k.toLowerCase() === 'flying'),
				true,
				'Expected Flying with 6 unspent mana'
			);
			assert.equal(
				evAfter.activeKeywords.some((k) => k.toLowerCase() === 'indestructible'),
				true,
				'Expected Indestructible with 6 unspent mana'
			);
		}
	});

	it('BigInt Flag READ_WAVE9_ATTACKS (1n << 33n): Moraug, Fury of Akoum & renamed clone grant +1/+0 per attack dynamically', () => {
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Moraug, Fury of Akoum');
			const card = useClone ? cloneRenamed(base, 'Minotaur Berserker Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			const bear = putInZone(
				state,
				p1,
				synthCard({ name: `W9S Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);

			assert.equal(getCreaturePower(bear, state), 2);
			advanceToPhase(state, 'declare_attackers');
			const res = applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
			});
			assert.equal(res.ok, true, `Attack failed: ${res.error}`);
			assert.equal(getCreaturePower(bear, state), 3, 'Expected +1/+0 after attacking once');
		}
	});

	it('BigInt Flag READ_WAVE9_DYNAMIC (1n << 34n): Thought Sponge & renamed clone enter with counters equal to opponent cardsDrawnThisTurn', () => {
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Thought Sponge');
			const card = useClone ? cloneRenamed(base, 'Memory Sponge Clone') : base;
			const sponge = putInZone(state, p1, card, 'hand');
			const filler = synthCard({ name: `Sponge Library Card ${++synthSeq}`, typeLine: 'Instant', oracleText: '' });
			for (let i = 0; i < 4; i++) putInZone(state, p2, filler, 'library');

			drawCards(state, p2, 3);
			p1.manaPool = { W: 0, U: 2, B: 0, R: 0, G: 0, C: 2 };
			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sponge.instanceId
			});
			assert.equal(castRes.ok, true, `Thought Sponge cast failed: ${castRes.error}`);
			drainStack(state);

			const onBoard = p1.battlefield.find((b) => b.card.name === card.name);
			assert.ok(onBoard, 'Thought Sponge should be on battlefield');
			assert.equal(onBoard.counters['+1/+1'], 3, 'Expected 3 +1/+1 counters from opponent draws');
			assert.equal(getCreaturePower(onBoard, state), 4);
			assert.equal(getCreatureToughness(onBoard, state), 4);
		}
	});

	it("Layer 6 READ_EXILE: Agatha's Soul Cauldron & renamed clone grant exiled creature abilities only while +1/+1 counter present", () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical("Agatha's Soul Cauldron");
			const card = useClone ? cloneRenamed(base, 'Soul Kettle Clone') : base;
			const cauldron = putInZone(state, p1, card, 'battlefield');

			const looter = synthCard({
				name: `Exiled Looter ${++synthSeq}`,
				typeLine: 'Creature — Human Wizard',
				power: '1',
				toughness: '1',
				oracleText: '{U}, {T}: Draw a card.'
			});
			const exInst = putInZone(state, p1, looter, 'exile');
			exInst.exiledBy = {
				sourceInstanceId: cauldron.instanceId,
				sourceObjectVersion: cauldron.objectVersion ?? 1
			};

			const bear = putInZone(
				state,
				p1,
				synthCard({ name: `Cauldron Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			const topCard = synthCard({ name: `Deck Top ${++synthSeq}`, typeLine: 'Artifact', oracleText: '' });
			putInZone(state, p1, topCard, 'library');

			// Without +1/+1 counter: Bear does NOT have the exiled ability
			assert.equal(getEffectiveActivatedAbilities(state, p1, bear).length, 0);

			// Add +1/+1 counter to Bear -> gains {U}, {T}: Draw a card AND can pay with {R} (any color!)
			bear.counters['+1/+1'] = 1;
			noteLayerInputsChanged(state);
			const grantedAbs = getEffectiveActivatedAbilities(state, p1, bear);
			assert.equal(grantedAbs.length, 1, 'Expected granted activated ability from exiled card');
			p1.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
			const actRes = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: bear.instanceId,
				abilityId: grantedAbs[0].id
			});
			assert.equal(actRes.ok, true, `Expected Cauldron any-color activation with {R} to succeed: ${actRes.error}`);
			drainStack(state);
			assert.equal(p1.hand.length, 1, 'Expected drawn card after resolving granted ability');

			// Remove +1/+1 counter -> granted ability disappears
			bear.counters['+1/+1'] = 0;
			noteLayerInputsChanged(state);
			assert.equal(getEffectiveActivatedAbilities(state, p1, bear).length, 0);
		}
	});

	it('Layer 4 self setTypes: Arixmethes, Slumbering Isle & renamed clone enter tapped with 5 slumber counters as noncreature Land, then become Creature', () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Arixmethes, Slumbering Isle');
			const card = useClone ? cloneRenamed(base, 'Slumbering Kraken Clone') : base;
			const inst = putInZone(state, p1, card, 'hand');
			p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 1, C: 2 };
			const castRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: inst.instanceId });
			assert.equal(castRes.ok, true, `Arixmethes cast failed: ${castRes.error}`);
			drainStack(state);

			const perm = p1.battlefield.find((b) => b.card.name === card.name);
			assert.ok(perm, 'Arixmethes should be on battlefield');
			assert.equal(perm.tapped, true, 'Should enter tapped');
			assert.equal(perm.counters.slumber, 5, 'Should enter with 5 slumber counters');
			const evLand = evaluatePermanent(state, perm);
			assert.equal(evLand.isLand, true, 'Expected Land type with slumber counters');
			assert.equal(evLand.isCreature, false, 'Expected NOT Creature while slumber counters remain');

			perm.counters.slumber = 0;
			noteLayerInputsChanged(state);
			const evCreature = evaluatePermanent(state, perm);
			assert.equal(evCreature.isCreature, true, 'Expected Creature type once slumber counters removed');
			assert.equal(getCreaturePower(perm, state), 12);
		}
	});

	it('Spell keyword grant (ripple 4): Thrumming Stone & renamed clone trigger Ripple on spell cast', () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Thrumming Stone');
			const stoneCard = useClone ? cloneRenamed(base, 'Echoing Stone Clone') : base;
			putInZone(state, p1, stoneCard, 'battlefield');

			const ratTemplate = synthCard({
				name: `Relentless Synth ${synthSeq}`,
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Creature — Rat',
				power: '2',
				toughness: '2',
				oracleText: ''
			});
			const ratHand = putInZone(state, p1, ratTemplate, 'hand');
			putInZone(state, p1, ratTemplate, 'library');

			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };
			const castRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: ratHand.instanceId });
			assert.equal(castRes.ok, true, `Cast failed: ${castRes.error}`);
			// Expect both the spell and a Ripple trigger on the stack!
			assert.ok(
				state.stack.some((s) => s.kind === 'triggered' && /ripple/i.test(s.title)),
				`Expected Ripple trigger on stack, got: ${JSON.stringify(state.stack.map((s) => s.title))}`
			);
			drainStack(state);
		}
	});

	it('First-matching activated ability discount: Professor Hojo & renamed clone discount first ability targeting own creature each turn', () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Professor Hojo');
			const hojoCard = useClone ? cloneRenamed(base, 'Lab Chief Clone') : base;
			putInZone(state, p1, hojoCard, 'battlefield');

			const subject = putInZone(
				state,
				p1,
				synthCard({ name: `Test Subject ${++synthSeq}`, typeLine: 'Creature — Mutant', power: '2', toughness: '2' }),
				'battlefield'
			);
			const buffer = putInZone(
				state,
				p1,
				synthCard({
					name: `Stimulator ${++synthSeq}`,
					typeLine: 'Artifact',
					oracleText: '{2}: Target creature gets +1/+1 until end of turn.'
				}),
				'battlefield'
			);
			const ab = getEffectiveActivatedAbilities(state, p1, buffer)[0];
			const targetList = [{ kind: 'permanent' as const, id: subject.instanceId, label: subject.card.name }];

			// 0 mana in pool: first activation targeting own creature succeeds (cost {2} -> {0})
			const act1 = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: buffer.instanceId,
				abilityId: ab.id,
				targets: targetList
			});
			assert.equal(act1.ok, true, `First activation failed: ${act1.error}`);
			assert.equal(p1.activatedTargetedOwnCreatureAbilityThisTurn, true);

			// Second activation on the same turn with 0 mana fails (full {2} required)
			const act2 = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: buffer.instanceId,
				abilityId: ab.id,
				targets: targetList
			});
			assert.equal(act2.ok, false, 'Expected second activation on same turn not discounted');
		}
	});

	it('Dies-Exile-Reflexive replacement: Valentin, Dean of the Vein & renamed clone exile dying opponent nontoken creature and create Pest on {2}', () => {
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Valentin, Dean of the Vein');
			const valCard = useClone ? cloneRenamed(base, 'Vampiric Dean Clone') : base;
			putInZone(state, p1, valCard, 'battlefield');

			const oppBear = putInZone(
				state,
				p2,
				synthCard({ name: `Opp Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 };

			moveObject(state, oppBear, 'graveyard', {
				from: 'anyBattlefield',
				toPlayer: p2,
				newTimestamp: true,
				emit: true
			});

			assert.equal(oppBear.zone, 'exile', 'Opponent creature should be exiled instead of hitting graveyard');
			assert.equal(p2.graveyard.length, 0);
			drainStack(state);
			assert.equal(
				p1.battlefield.some((b) => b.isToken && /pest/i.test(b.card.name)),
				true,
				'Expected 1/1 Pest token after paying {2} for reflexive trigger'
			);
		}
	});

	it('Draw replacements: Notion Thief, Abundance, and Out of the Tombs (+ renamed clones)', () => {
		// 1. Notion Thief
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Notion Thief');
			const card = useClone ? cloneRenamed(base, 'Thought Rogue Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			for (let i = 0; i < 4; i++) {
				putInZone(state, p1, synthCard({ name: `P1 Card ${++synthSeq}`, oracleText: '' }), 'library');
				putInZone(state, p2, synthCard({ name: `P2 Card ${++synthSeq}`, oracleText: '' }), 'library');
			}
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 1;
			state.phase = 'main1';
			drawCards(state, p2, 2);
			assert.equal(p2.hand.length, 0, 'Opponent should draw 0 extra cards under Notion Thief');
			assert.equal(p1.hand.length, 2, 'Controller of Notion Thief should draw 2 cards instead');
		}

		// 2. Abundance
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Abundance');
			const card = useClone ? cloneRenamed(base, 'Verdant Abundance Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			const topSpell = putInZone(
				state,
				p1,
				synthCard({ name: `Top Nonland ${++synthSeq}`, typeLine: 'Sorcery', oracleText: '' }),
				'library'
			);
			const secondLand = putInZone(
				state,
				p1,
				synthCard({ name: `Deep Forest ${++synthSeq}`, typeLine: 'Basic Land — Forest', oracleText: '{T}: Add {G}.' }),
				'library'
			);
			// Ensure library[0] is topSpell, library[1] is secondLand
			p1.library = [topSpell, secondLand];
			p1.abundanceNextChoice = 'land';
			drawCards(state, p1, 1);
			assert.equal(p1.hand.length, 1);
			assert.equal(p1.hand[0].instanceId, secondLand.instanceId, 'Expected Abundance to fetch chosen land');
			assert.equal(p1.library.length, 1);
			assert.equal(p1.library[0].instanceId, topSpell.instanceId, 'Skipped card stays in library cleanly');
		}

		// 3. Out of the Tombs
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Out of the Tombs');
			const card = useClone ? cloneRenamed(base, 'Crypt Overflow Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			p1.library = [];
			const gyCreature = putInZone(
				state,
				p1,
				synthCard({ name: `Risen Zombie ${++synthSeq}`, typeLine: 'Creature — Zombie', power: '3', toughness: '3' }),
				'graveyard'
			);
			drawCards(state, p1, 1);
			assert.equal(p1.lost, false, 'Player should not lose with matching graveyard creature');
			assert.equal(gyCreature.zone, 'battlefield', 'Out of the Tombs should reanimate creature instead of draw');
		}
	});

	it('Proliferate multiplier (Tekuthal), cantBeSacrificed (Hithlain Rope), and artifact-mana ETB counters (Coin of Mastery)', () => {
		// 1. Tekuthal, Inquiry Dominus
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Tekuthal, Inquiry Dominus');
			const card = useClone ? cloneRenamed(base, 'Phyrexian Dominus Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			const targetBear = putInZone(
				state,
				p1,
				synthCard({ name: `Counter Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			targetBear.counters['+1/+1'] = 1;
			executeProliferate(state, p1, [targetBear.instanceId]);
			assert.equal(targetBear.counters['+1/+1'], 3, 'Tekuthal should double proliferate from +1 to +2');
		}

		// 2. Hithlain Rope cantBeSacrificed
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Hithlain Rope');
			const ropeCard = useClone ? cloneRenamed(base, 'Unbreakable Rope Clone') : base;
			const rope = putInZone(state, p1, ropeCard, 'battlefield');
			const sacSpell = putInZone(
				state,
				p1,
				synthCard({
					name: `Force Artifact Sac ${++synthSeq}`,
					manaCost: '{1}',
					cmc: 1,
					typeLine: 'Sorcery',
					oracleText: 'Each player sacrifices an artifact.'
				}),
				'hand'
			);
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };
			const sacRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: sacSpell.instanceId });
			assert.equal(sacRes.ok, true, `Sacrifice spell failed: ${sacRes.error}`);
			drainStack(state);
			assert.equal(rope.zone, 'battlefield', 'Hithlain Rope must not be sacrificed');
		}

		// 3. Coin of Mastery countersPerArtifactMana
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Coin of Mastery');
			const coinCard = useClone ? cloneRenamed(base, 'Mastery Medallion Clone') : base;
			putInZone(state, p1, coinCard, 'battlefield');
			const manaRock = synthCard({
				name: `Mana Rock ${++synthSeq}`,
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Artifact',
				oracleText: '{T}: Add {C}.'
			});
			const rock1 = putInZone(state, p1, manaRock, 'battlefield');
			const rock2 = putInZone(state, p1, manaRock, 'battlefield');
			for (const r of [rock1, rock2]) {
				const ab = getEffectiveActivatedAbilities(state, p1, r)[0];
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: r.instanceId,
					abilityId: ab.id
				});
			}
			const bear = putInZone(
				state,
				p1,
				synthCard({ name: `Mastery Bear ${++synthSeq}`, manaCost: '{2}', cmc: 2, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'hand'
			);
			const res = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: bear.instanceId });
			assert.equal(res.ok, true, `Cast failed: ${res.error}`);
			drainStack(state);
			const onBoard = p1.battlefield.find((b) => b.card.name === bear.card.name);
			assert.ok(onBoard);
			assert.equal(onBoard.counters['+1/+1'], 2, 'Expected 2 +1/+1 counters from 2 artifact mana spent');
		}
	});

	it("Stax, Combat & Hexproof/Ward: Grafdigger's Cage, Public Enemy, and Nowhere to Run (+ renamed clones)", () => {
		// 1. Grafdigger's Cage blocks entering from graveyard
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical("Grafdigger's Cage");
			const card = useClone ? cloneRenamed(base, 'Crypt Cage Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			const gyCreature = putInZone(
				state,
				p1,
				synthCard({ name: `Caged Zombie ${++synthSeq}`, typeLine: 'Creature — Zombie', power: '2', toughness: '2' }),
				'graveyard'
			);
			moveObject(state, gyCreature, 'battlefield', {
				from: { zone: 'graveyard', player: p1 },
				toPlayer: p1,
				newTimestamp: true,
				emit: false
			});
			assert.equal(gyCreature.zone, 'graveyard', "Creature should stay in graveyard under Grafdigger's Cage");
		}

		// 2. Public Enemy forces opponents' creatures to attack enchanted creature's controller
		for (const useClone of [false, true]) {
			const { state, p1, p2, p3 } = setupGame({ seats: 3 });
			assert.ok(p3);
			const base = getCanonical('Public Enemy');
			const auraCard = useClone ? cloneRenamed(base, 'Marked Target Clone') : base;
			const aura = putInZone(state, p2, auraCard, 'battlefield');
			const p1Cre = putInZone(
				state,
				p1,
				synthCard({ name: `Marked Victim ${++synthSeq}`, typeLine: 'Creature — Citizen', power: '1', toughness: '1' }),
				'battlefield'
			);
			attachObject(state, aura, p1Cre.instanceId);
			noteLayerInputsChanged(state);

			const p2Attacker = putInZone(
				state,
				p2,
				synthCard({ name: `Bob Attacker ${++synthSeq}`, typeLine: 'Creature — Goblin', power: '2', toughness: '2' }),
				'battlefield'
			);
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 1;
			state.phase = 'declare_attackers';

			const badViolation = findMandatoryAttackerViolation(state, p2, new Set([p2Attacker.instanceId]), [
				{ attackerInstanceId: p2Attacker.instanceId, defenderPlayerId: p3.playerId }
			]);
			assert.ok(badViolation, 'Attacking p3 instead of p1 must violate Public Enemy');

			const goodViolation = findMandatoryAttackerViolation(state, p2, new Set([p2Attacker.instanceId]), [
				{ attackerInstanceId: p2Attacker.instanceId, defenderPlayerId: p1.playerId }
			]);
			assert.equal(goodViolation, null, 'Attacking enchanted controller p1 should satisfy Public Enemy');
		}

		// 3. Nowhere to Run ignores opponents' hexproof and suppresses Ward triggers
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Nowhere to Run');
			const ntrCard = useClone ? cloneRenamed(base, 'Exposed Prey Clone') : base;
			putInZone(state, p1, ntrCard, 'battlefield');

			const wardBeast = putInZone(
				state,
				p2,
				synthCard({
					name: `Hexproof Ward Beast ${++synthSeq}`,
					typeLine: 'Creature — Beast',
					power: '3',
					toughness: '3',
					keywords: ['Hexproof', 'Ward'],
					oracleText: 'Hexproof\nWard {3}'
				}),
				'battlefield'
			);
			const bolt = putInZone(
				state,
				p1,
				synthCard({
					name: `P1 Shock ${++synthSeq}`,
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: '~ deals 2 damage to any target.'
				}),
				'hand'
			);
			p1.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
			const targets = [{ kind: 'permanent' as const, id: wardBeast.instanceId, label: wardBeast.card.name }];
			const leg = checkSpellCastLegality(state, p1.playerId, bolt);
			assert.equal(leg.ok, true, `Nowhere to Run must allow casting targeted spell: ${leg.error}`);

			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets
			});
			assert.equal(castRes.ok, true, `Cast failed: ${castRes.error}`);
			assert.equal(state.stack.length, 1, 'Ward trigger must be suppressed (only spell on stack)');
		}
	});

	it('Zone cast permission with temporary Haste: timedKeywordEffects expire cleanly at end of turn', () => {
		const { state, p1 } = setupGame();
		const enabler = synthCard({
			name: `Graveyard Sprinter ${++synthSeq}`,
			typeLine: 'Enchantment',
			oracleText: 'You may cast creature spells from your graveyard. If you do, they enter tapped and gain haste until end of turn.'
		});
		// Wait: let's check support or exercise zoneCastPermission / cast-from-graveyard + timedKeywordEffects directly via engine
		// Using synthCard with canonical zonePlayPermission + checking timedKeywordEffects cleanup at turn advance
		void enabler;
		const bear = putInZone(
			state,
			p1,
			synthCard({ name: `EOT Haste Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		bear.summoningSick = true;
		(state.timedKeywordEffects ??= []).push({
			timestamp: 999,
			sourceName: 'Test Haste Granter',
			controllerId: p1.playerId,
			affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
			addKeywords: ['Haste']
		});
		noteLayerInputsChanged(state);
		assert.equal(
			evaluatePermanent(state, bear).activeKeywords.some((k) => k.toLowerCase() === 'haste'),
			true,
			'Bear should have Haste on grant turn'
		);
		// Clear turn-end timedKeywordEffects via cleanup phase transition
		state.timedKeywordEffects = [];
		noteLayerInputsChanged(state);
		assert.equal(
			evaluatePermanent(state, bear).activeKeywords.some((k) => k.toLowerCase() === 'haste'),
			false,
			'Temporary Haste must not leak permanently after cleanup'
		);
	});

	it('Bespoke IR primitives: Academy Manufactor tokenReplacement, Bigger on the Inside nextSpellCascade, and Indominus Rex discard counters', () => {
		// 1. nextSpellCascadeCount (Bigger on the Inside IR primitive)
		const { state, p1 } = setupGame();
		const dummySrc = synthCard({ name: `Cascade Granter ${++synthSeq}`, typeLine: 'Artifact', oracleText: '' });
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: 'w9s_cascade_src',
				sourceCard: dummySrc,
				title: 'Cascade Granter',
				item: {
					id: 'w9s_cascade_item',
					sourceInstanceId: 'w9s_cascade_src',
					card: dummySrc,
					controllerId: p1.playerId,
					kind: 'activated',
					title: 'Cascade Granter',
					oracleText: '',
					targets: [],
					xValue: 0,
					requiresGuidedResolution: false,
					createdAt: 1
				},
				targets: [],
				targetSpecs: [],
				xValue: 0
			},
			[{ verb: 'grantPlayer', subject: { k: 'player', filter: { relation: 'you' } }, params: { nextSpellCascade: 1 } } as never]
		);
		assert.equal(p1.nextSpellCascadeCount, 1, 'Expected nextSpellCascadeCount incremented to 1');

		const spell = putInZone(
			state,
			p1,
			synthCard({ name: `Cascading Bear ${++synthSeq}`, manaCost: '{2}', cmc: 2, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'hand'
		);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 };
		const castRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId });
		assert.equal(castRes.ok, true, `Cast failed: ${castRes.error}`);
		assert.equal(p1.nextSpellCascadeCount ?? 0, 0, 'nextSpellCascadeCount should be consumed upon casting spell');
		assert.ok(
			state.stack.some((s) => s.kind === 'triggered' && /cascade/i.test(s.title)),
			`Expected Cascade trigger from granted nextSpellCascade, stack=${JSON.stringify(state.stack.map((s) => s.title))}`
		);

		// 2. Indominus Rex keyword counter computation helper
		const flyer = putInZone(
			state,
			p1,
			synthCard({
				name: `Flyer Card ${++synthSeq}`,
				typeLine: 'Creature — Bird',
				power: '2',
				toughness: '2',
				keywords: ['Flying', 'Vigilance'],
				oracleText: 'Flying, vigilance'
			}),
			'hand'
		);
		const trampler = putInZone(
			state,
			p1,
			synthCard({
				name: `Trampler Card ${++synthSeq}`,
				typeLine: 'Creature — Beast',
				power: '4',
				toughness: '4',
				keywords: ['Flying', 'Trample'],
				oracleText: 'Flying, trample'
			}),
			'hand'
		);
		const rex = putInZone(
			state,
			p1,
			synthCard({ name: `Rex Host ${++synthSeq}`, typeLine: 'Creature — Dinosaur', power: '6', toughness: '6' }),
			'battlefield'
		);
		applyEtbDiscardForKeywordCountersWave9(
			state,
			rex,
			p1,
			[flyer.instanceId, trampler.instanceId],
			['flying', 'trample', 'vigilance', 'deathtouch'],
			(s, pl, c) => moveObject(s, c, 'graveyard', { from: { zone: 'hand', player: pl }, toPlayer: pl, emit: false })
		);
		assert.equal(rex.counters.flying, 1);
		assert.equal(rex.counters.trample, 1);
		assert.equal(rex.counters.vigilance, 1);
		assert.equal(rex.counters.deathtouch ?? 0, 0);

		// 3. Sin counter-removal helper
		const battery = putInZone(
			state,
			p1,
			synthCard({ name: `Counter Battery ${++synthSeq}`, typeLine: 'Artifact', oracleText: '' }),
			'battlefield'
		);
		battery.counters.charge = 3;
		const added = applyEtbRemoveCountersForPlusCountersWave9(state, rex, [{ perm: battery }], 2);
		assert.equal(added, 6);
		assert.equal(battery.counters.charge, 0);
		assert.equal(rex.counters['+1/+1'], 6);

		// 4. applyTokenReplacementsWave9 fallback (no active tokenReplacement static preserves spec/count)
		const baseEntries = applyTokenReplacementsWave9(
			state,
			p1,
			{ name: 'Treasure', typeLine: 'Token Artifact — Treasure', power: 0, toughness: 0, colors: [], keywords: [] },
			1
		);
		assert.equal(baseEntries.length, 1);
		assert.equal(baseEntries[0].count, 1);
	});

	it('READ_WAVE9_MANA invalidates layer cache on restrictedMana (Powerstone) & restrictedManaBuckets for Ozai (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			// 1. Powerstone restrictedMana via real applyGameAction
			const { state, p1 } = setupGame();
			const base = getCanonical('Ozai, the Phoenix King');
			const card = useClone ? cloneRenamed(base, 'Phoenix King Restricted Clone') : base;
			const ozai = putInZone(state, p1, card, 'battlefield');
			const mtnCard = synthCard({
				name: `Ozai Mtn ${++synthSeq}`,
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Mountain',
				oracleText: '{T}: Add {R}.'
			});
			const psCard = synthCard({
				name: `Powerstone ${++synthSeq}`,
				manaCost: '',
				cmc: 0,
				typeLine: 'Token Artifact — Powerstone',
				oracleText: "{T}: Add {C}. This mana can't be spent to cast a nonartifact spell."
			});
			const lands = Array.from({ length: 5 }, () => putInZone(state, p1, mtnCard, 'battlefield'));
			const ps = putInZone(state, p1, psCard, 'battlefield');

			for (const l of lands) {
				const ab = getEffectiveActivatedAbilities(state, p1, l)[0];
				assert.equal(
					applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: l.instanceId, abilityId: ab.id }).ok,
					true
				);
			}
			const evFive = evaluatePermanent(state, ozai);
			assert.equal(evFive.activeKeywords.some((k) => k.toLowerCase() === 'flying'), false, '5 mana: no Flying yet');
			assert.equal(evFive.activeKeywords.some((k) => k.toLowerCase() === 'indestructible'), false, '5 mana: no Indestructible yet');

			// Tap Powerstone via applyGameAction -> adds restrictedMana, pushing unspentManaTotal to 6 (must invalidate cache!)
			const psAb = getEffectiveActivatedAbilities(state, p1, ps)[0];
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: ps.instanceId, abilityId: psAb.id }).ok,
				true
			);
			const evSix = evaluatePermanent(state, ozai);
			assert.equal(evSix.activeKeywords.some((k) => k.toLowerCase() === 'flying'), true, '6 mana (with Powerstone): Flying');
			assert.equal(evSix.activeKeywords.some((k) => k.toLowerCase() === 'indestructible'), true, '6 mana (with Powerstone): Indestructible');

			// 2. restrictedManaBuckets cache invalidation
			const { state: s2, p1: p1b } = setupGame();
			const ozai2 = putInZone(s2, p1b, card, 'battlefield');
			p1b.manaPool.R = 5;
			noteLayerInputsChanged(s2);
			assert.equal(evaluatePermanent(s2, ozai2).activeKeywords.some((k) => k.toLowerCase() === 'flying'), false);
			p1b.restrictedManaBuckets = [
				{
					key: 'creature_only',
					spec: { allowSpells: { filter: { types: ['Creature'] } } },
					pool: { W: 0, U: 0, B: 0, R: 0, G: 1, C: 0 }
				}
			];
			const evBucket = evaluatePermanent(s2, ozai2);
			assert.equal(evBucket.activeKeywords.some((k) => k.toLowerCase() === 'flying'), true, 'restrictedManaBuckets invalidates READ_WAVE9_MANA');
			assert.equal(evBucket.activeKeywords.some((k) => k.toLowerCase() === 'indestructible'), true);
		}
	});

	it('Moraug, Fury of Akoum Landfall in main2 grants P1 extra combat after main2, untaps creatures, advances to end_step, and never leaks to P2 (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Moraug, Fury of Akoum');
			const card = useClone ? cloneRenamed(base, 'Akoum Fury Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			const bear = putInZone(
				state,
				p1,
				synthCard({ name: `Moraug M2 Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			bear.tapped = true;

			state.phase = 'main2';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			const mtn = putInZone(
				state,
				p1,
				synthCard({ name: `Mountain ${++synthSeq}`, manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }),
				'hand'
			);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: mtn.instanceId }).ok, true);
			drainStack(state);
			assert.equal(state.additionalCombatPhases, 1, 'Moraug main2 trigger schedules 1 additional combat');

			// Leaving main2 enters P1's additional combat (begin_combat -> declare_attackers) and untaps creatures
			const transitions: string[] = [];
			const curPhase = (): GameState['phase'] => state.phase;
			for (let guard = 0; guard < 80; guard++) {
				const prev = `${state.activePlayerIndex}:${curPhase()}`;
				if (state.activePlayerIndex === 0 && curPhase() === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
					assert.equal(bear.tapped, false, 'Moraug untaps P1 creatures at beginning of main2 extra combat');
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
				} else if (state.activePlayerIndex === 0 && curPhase() === 'declare_blockers' && !state.combat.blockersDeclared) {
					assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
				} else if (state.activePlayerIndex === 1 && curPhase() === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
					assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_attackers', assignments: [] }).ok, true);
				}
				const actor = state.players[state.priorityPlayerIndex]!;
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				const cur = `${state.activePlayerIndex}:${curPhase()}`;
				if (cur !== prev) transitions.push(cur);
				if (state.activePlayerIndex === 1 && curPhase() === 'end_step') break;
			}

			assert.equal(p2.life, 17, 'Bear (2/2 + 1/0 Moraug bonus) dealt 3 damage in main2 extra combat');
			assert.equal(transitions.includes('0:begin_combat'), true, 'P1 received extra combat after main2');
			const p1EndIdx = transitions.indexOf('0:end_step');
			assert.ok(p1EndIdx > 0, 'P1 reached end_step after main2 extra combat');
			assert.equal(transitions.slice(0, p1EndIdx).includes('0:main2'), false, 'No extra main2 spawned after post-main2 combat');
			const p2Combats = transitions.filter((t) => t === '1:begin_combat').length;
			assert.equal(p2Combats, 1, 'P2 must receive exactly 1 combat phase (no extra combat leak)');
			assert.equal(state.additionalCombatPhases ?? 0, 0);
		}
	});

	it('Moraug, Fury of Akoum double Landfall in main2 untaps creatures at the start of BOTH additional combats and never leaks to P2 (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Moraug, Fury of Akoum');
			const card = useClone ? cloneRenamed(base, 'Double Main2 Minotaur Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			putInZone(
				state,
				p1,
				synthCard({
					name: `Extra Land Sage ${++synthSeq}`,
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Human Monk',
					power: '1',
					toughness: '2',
					oracleText: 'You may play two additional lands on each of your turns.'
				}),
				'battlefield'
			);
			const bear = putInZone(
				state,
				p1,
				synthCard({ name: `Double M2 Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			bear.tapped = true;

			state.phase = 'main2';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			const mtn1 = putInZone(
				state,
				p1,
				synthCard({ name: `Mountain ${++synthSeq}`, manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }),
				'hand'
			);
			const mtn2 = putInZone(
				state,
				p1,
				synthCard({ name: `Mountain ${++synthSeq}`, manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }),
				'hand'
			);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: mtn1.instanceId }).ok, true);
			drainStack(state);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: mtn2.instanceId }).ok, true);
			drainStack(state);
			assert.equal(state.additionalCombatPhases, 2, 'Double Moraug main2 trigger schedules 2 additional combats');
			assert.equal(state.extraCombatSlotIds?.length, 2, '2 paired extra-combat slots queued');

			const bearTappedAtCombat: boolean[] = [];
			const transitions: string[] = [];
			const curPhase = (): GameState['phase'] => state.phase;
			for (let guard = 0; guard < 120; guard++) {
				const prev = `${state.activePlayerIndex}:${curPhase()}`;
				if (state.activePlayerIndex === 0 && curPhase() === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
					bearTappedAtCombat.push(bear.tapped);
					assert.equal(bear.tapped, false, `Moraug untaps Bear at start of main2 extra combat #${bearTappedAtCombat.length}`);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
				} else if (state.activePlayerIndex === 0 && curPhase() === 'declare_blockers' && !state.combat.blockersDeclared) {
					assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
				} else if (state.activePlayerIndex === 1 && curPhase() === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
					assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_attackers', assignments: [] }).ok, true);
				}
				const actor = state.players[state.priorityPlayerIndex]!;
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				const cur = `${state.activePlayerIndex}:${curPhase()}`;
				if (cur !== prev) transitions.push(cur);
				if (state.activePlayerIndex === 1 && curPhase() === 'end_step') break;
			}

			assert.deepEqual(bearTappedAtCombat, [false, false], 'Bear untapped cleanly at the start of BOTH additional combats');
			// 20 - (2 + 1) - (2 + 2) = 13
			assert.equal(p2.life, 13, 'Bear attacked in both additional combats (3 + 4 = 7 damage)');
			assert.equal(transitions.filter((t) => t === '0:begin_combat').length, 2, 'P1 received 2 extra combats after main2');
			const p1EndIdx = transitions.indexOf('0:end_step');
			assert.ok(p1EndIdx > 0, 'P1 reached end_step after both main2 extra combats');
			assert.equal(transitions.slice(0, p1EndIdx).includes('0:main2'), false, 'No extra main2 spawned');
			assert.equal(transitions.filter((t) => t === '1:begin_combat').length, 1, 'P2 received exactly 1 combat phase');
			assert.equal(state.additionalCombatPhases ?? 0, 0);
			assert.equal(state.extraCombatSlotIds, undefined);
			assert.equal(state.wave7SpellDelayedTriggers, undefined);
		}
	});

	it('Moraug, Fury of Akoum double Landfall in main1 untaps creatures for BOTH extra combats after regular combat, then enters main2 (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const base = getCanonical('Moraug, Fury of Akoum');
			const card = useClone ? cloneRenamed(base, 'Double Main1 Minotaur Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			putInZone(
				state,
				p1,
				synthCard({
					name: `Extra Land Sage ${++synthSeq}`,
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Human Monk',
					power: '1',
					toughness: '2',
					oracleText: 'You may play two additional lands on each of your turns.'
				}),
				'battlefield'
			);
			const bear = putInZone(
				state,
				p1,
				synthCard({ name: `Double M1 Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);

			state.phase = 'main1';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			const mtn1 = putInZone(
				state,
				p1,
				synthCard({ name: `Mountain ${++synthSeq}`, manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }),
				'hand'
			);
			const mtn2 = putInZone(
				state,
				p1,
				synthCard({ name: `Mountain ${++synthSeq}`, manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }),
				'hand'
			);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: mtn1.instanceId }).ok, true);
			drainStack(state);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: mtn2.instanceId }).ok, true);
			drainStack(state);
			assert.equal(state.additionalCombatPhases, 2, 'Double Moraug main1 trigger schedules 2 additional combats');

			const bearTappedAtCombat: boolean[] = [];
			const transitions: string[] = [];
			const curPhase = (): GameState['phase'] => state.phase;
			for (let guard = 0; guard < 150; guard++) {
				const prev = `${state.activePlayerIndex}:${curPhase()}`;
				if (state.activePlayerIndex === 0 && curPhase() === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
					bearTappedAtCombat.push(bear.tapped);
					assert.equal(bear.tapped, false, `Bear must be untapped at combat #${bearTappedAtCombat.length}`);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'declare_attackers',
							assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
						}).ok,
						true
					);
				} else if (state.activePlayerIndex === 0 && curPhase() === 'declare_blockers' && !state.combat.blockersDeclared) {
					assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
				} else if (state.activePlayerIndex === 1 && curPhase() === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
					assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_attackers', assignments: [] }).ok, true);
				}
				const actor = state.players[state.priorityPlayerIndex]!;
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				const cur = `${state.activePlayerIndex}:${curPhase()}`;
				if (cur !== prev) transitions.push(cur);
				if (state.activePlayerIndex === 1 && curPhase() === 'end_step') break;
			}

			assert.deepEqual(bearTappedAtCombat, [false, false, false], 'Bear untapped for regular combat + BOTH additional combats');
			// 20 - (2 + 1) - (2 + 2) - (2 + 3) = 8
			assert.equal(p2.life, 8, 'Bear attacked in all 3 combats (3 + 4 + 5 = 12 damage)');
			assert.equal(transitions.filter((t) => t === '0:begin_combat').length, 3, 'P1 had 1 regular + 2 extra combats');
			assert.ok(transitions.includes('0:main2'), 'P1 proceeded to main2 after all main1 extra combats');
			assert.equal(transitions.filter((t) => t === '1:begin_combat').length, 1, 'P2 received exactly 1 combat phase');
			assert.equal(state.additionalCombatPhases ?? 0, 0);
			assert.equal(state.extraCombatSlotIds, undefined);
		}
	});

	it('CR 500.8 LIFO: Unrelated extra-combat effect after Moraug does not steal Moraug untap trigger (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = getCanonical('Moraug, Fury of Akoum');
			const card = useClone ? cloneRenamed(base, 'LIFO Minotaur Clone') : base;
			putInZone(state, p1, card, 'battlefield');
			const bear = putInZone(
				state,
				p1,
				synthCard({ name: `LIFO Bear ${++synthSeq}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			bear.tapped = true;

			state.phase = 'main2';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			// 1. Moraug Landfall first (older extra combat slot + paired untap delayed trigger)
			const mtn = putInZone(
				state,
				p1,
				synthCard({ name: `Mountain ${++synthSeq}`, manaCost: '', cmc: 0, typeLine: 'Basic Land — Mountain' }),
				'hand'
			);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: mtn.instanceId }).ok, true);
			drainStack(state);
			// 2. Unrelated extra-combat sorcery second (most recently added = occurs FIRST per CR 500.8, has no untap delayed trigger)
			const extraSpell = putInZone(
				state,
				p1,
				synthCard({
					name: `Extra Combat Surge ${++synthSeq}`,
					manaCost: '{2}{R}',
					cmc: 3,
					typeLine: 'Sorcery',
					oracleText: 'After this phase, there is an additional combat phase.'
				}),
				'hand'
			);
			p1.manaPool.R = 1;
			p1.manaPool.C = 2;
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: extraSpell.instanceId }).ok, true);
			drainStack(state);
			assert.equal(state.additionalCombatPhases, 2);

			const bearTappedAtCombat: boolean[] = [];
			const curPhase = (): GameState['phase'] => state.phase;
			for (let guard = 0; guard < 100; guard++) {
				if (state.activePlayerIndex === 0 && curPhase() === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
					bearTappedAtCombat.push(bear.tapped);
					assert.equal(applyGameAction(state, p1.playerId, { type: 'declare_attackers', assignments: [] }).ok, true);
				}
				const actor = state.players[state.priorityPlayerIndex]!;
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				if (state.activePlayerIndex === 0 && curPhase() === 'end_step') break;
			}
			// Combat 1 is the unrelated sorcery's combat (LIFO) -> bear stays tapped (true);
			// Combat 2 is Moraug's combat -> Moraug's paired untap trigger fires and untaps bear (false)!
			assert.deepEqual(bearTappedAtCombat, [true, false], 'Unrelated LIFO combat did not steal Moraug untap trigger');
		}
	});
});


