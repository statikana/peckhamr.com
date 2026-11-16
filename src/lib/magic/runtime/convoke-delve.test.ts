import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeBotStep } from '../ai.ts';
import {
	applyGameAction,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	getCastOptions
} from '../engine.ts';
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

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	const id = `syn_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
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
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {})
	};
}

function makeDeck(cards: ScryfallCard[], commander?: ScryfallCard): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: 'deck_test',
		userId: 'p1',
		name: 'Test Deck',
		description: '',
		commanders: commander ? [commander] : [],
		cards: entries,
		colorIdentity: commander?.colorIdentity ?? [],
		cardCount: entries.length + (commander ? 1 : 0),
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
}

function setupMain1Game(opts: { p1Bot?: boolean } = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)',
		colors: []
	});
	const deck = makeDeck(Array.from({ length: 12 }, () => filler));
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: [],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: false,
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: [],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		}
	];
	const decksBySeat = new Map<number, MagicDeck>([
		[0, deck],
		[1, deck]
	]);
	const state = createInitialGameState('test_convoke_delve', seats, decksBySeat, DEFAULT_LOBBY_RULES);
	state.status = 'active';
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.turnNumber = 1;
	state.pendingPrompts = [];
	return {
		state,
		p1: state.players[0],
		p2: state.players[1]
	};
}

function addCard(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'command'
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, undefined, state);
	if (zone === 'command') inst.isCommander = true;
	player[zone].push(inst);
	return inst;
}

describe('Convoke (CR 702.51) & Delve (CR 702.66)', () => {
	it('convokes colored and generic costs, respects summoning sickness, and skips phased-out/tapped creatures', () => {
		const { state, p1 } = setupMain1Game();
		const forest = synthCard({
			name: 'Forest',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: '({T}: Add {G}.)'
		});
		const greenCreature = synthCard({
			name: 'Elf Citizen',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Elf',
			power: '2',
			toughness: '2',
			colors: ['G']
		});
		const colorlessCreature = synthCard({
			name: 'Iron Myrkin',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact Creature — Construct',
			power: '1',
			toughness: '1',
			colors: []
		});
		const tappedCreature = synthCard({
			name: 'Resting Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2',
			colors: ['G']
		});
		const phasedCreature = synthCard({
			name: 'Veiled Wolf',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Wolf',
			power: '2',
			toughness: '2',
			colors: ['G']
		});
		const convokeWurm = synthCard({
			name: 'Siege Wurm Alpha',
			manaCost: '{3}{G}{G}',
			cmc: 5,
			typeLine: 'Creature — Wurm',
			power: '5',
			toughness: '5',
			colors: ['G'],
			oracleText: 'Convoke\nTrample',
			keywords: ['Convoke', 'Trample']
		});

		addCard(state, p1, forest, 'battlefield');
		const cGreen = addCard(state, p1, greenCreature, 'battlefield');
		cGreen.summoningSick = true;
		const cColorless = addCard(state, p1, colorlessCreature, 'battlefield');
		const cTapped = addCard(state, p1, tappedCreature, 'battlefield');
		cTapped.tapped = true;
		const cPhased = addCard(state, p1, phasedCreature, 'battlefield');
		cPhased.phasedOut = true;
		const wurm = addCard(state, p1, convokeWurm, 'hand');

		// Need 5 mana ({3}{G}{G}) — only 1 Forest + cGreen + cColorless = 3 mana total, so illegal!
		assert.equal(getCastOptions(state, p1.playerId, wurm, 'hand').length, 0);

		// Add two more colorless creatures (now 1 Forest + 4 untapped creatures = 5)
		const cExtra1 = addCard(state, p1, colorlessCreature, 'battlefield');
		const cExtra2 = addCard(state, p1, colorlessCreature, 'battlefield');

		const opts = getCastOptions(state, p1.playerId, wurm, 'hand');
		assert.equal(opts.length, 1);
		const convokeAid = opts[0].paymentAids?.find((a) => a.id === 'aid:convoke');
		assert.ok(convokeAid);
		assert.ok(convokeAid.candidateIds.includes(cGreen.instanceId));
		assert.ok(convokeAid.candidateIds.includes(cColorless.instanceId));
		assert.ok(!convokeAid.candidateIds.includes(cTapped.instanceId));
		assert.ok(!convokeAid.candidateIds.includes(cPhased.instanceId));

		// Strict cast without costAidIds must fail when short on lands
		const failNoAid = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: wurm.instanceId,
			fromZone: 'hand'
		});
		assert.equal(failNoAid.ok, false);

		// Casting with explicit costAidIds (even with summoning-sick green creature) succeeds
		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: wurm.instanceId,
			fromZone: 'hand',
			costAidIds: {
				'aid:convoke': [cGreen.instanceId, cColorless.instanceId, cExtra1.instanceId, cExtra2.instanceId]
			}
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(cGreen.tapped, true);
		assert.equal(cColorless.tapped, true);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].card.name, 'Siege Wurm Alpha');
		assert.ok(state.log.some((l) => l.text.includes('tapped') && l.text.includes('while casting Siege Wurm Alpha')));
	});

	it('respects multicolor convoke choice (only one mana of one color or generic) and validates choices', () => {
		const { state, p1 } = setupMain1Game();
		const wgCreature = synthCard({
			name: 'Selesnya Knight',
			manaCost: '{G}{W}',
			cmc: 2,
			typeLine: 'Creature — Knight',
			power: '2',
			toughness: '2',
			colors: ['W', 'G']
		});
		const convokeSpell = synthCard({
			name: 'Joined Assault',
			manaCost: '{W}{G}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'Convoke\nDraw a card.',
			colors: ['W', 'G'],
			keywords: ['Convoke']
		});
		const k1 = addCard(state, p1, wgCreature, 'battlefield');
		const k2 = addCard(state, p1, wgCreature, 'battlefield');
		const spell = addCard(state, p1, convokeSpell, 'hand');

		// Cannot pay {R} with W/G creature
		const badColor = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [k1.instanceId] },
			costAidColorChoices: { [k1.instanceId]: 'R' }
		});
		assert.equal(badColor.ok, false);

		// Cannot pay 'generic' when spell has no generic mana
		const badGeneric = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [k1.instanceId] },
			costAidColorChoices: { [k1.instanceId]: 'generic' }
		});
		assert.equal(badGeneric.ok, false);

		// Explicit split: k1 pays {W}, k2 pays {G} -> casts {W}{G} instant/sorcery with 0 lands!
		const goodCast = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [k1.instanceId, k2.instanceId] },
			costAidColorChoices: { [k1.instanceId]: 'W', [k2.instanceId]: 'G' }
		});
		assert.equal(goodCast.ok, true, goodCast.error ?? '');
		assert.equal(k1.tapped, true);
		assert.equal(k2.tapped, true);
		assert.equal(state.stack.length, 1);
	});

	it('prevents double-tapping a mana-producing creature for both Convoke and mana (CR 118.10)', () => {
		const { state, p1 } = setupMain1Game();
		const dork = synthCard({
			name: 'Llanowar Mystic',
			manaCost: '{G}',
			cmc: 1,
			typeLine: 'Creature — Elf Druid',
			power: '1',
			toughness: '1',
			colors: ['G'],
			oracleText: '{T}: Add {G}.'
		});
		const spell = synthCard({
			name: 'Twin Oak',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Treefolk',
			power: '2',
			toughness: '2',
			colors: ['G'],
			oracleText: 'Convoke',
			keywords: ['Convoke']
		});
		const elvishDork = addCard(state, p1, dork, 'battlefield');
		const card = addCard(state, p1, spell, 'hand');

		// 1 mana dork alone CANNOT pay {1}{G} by convoking {1} and tapping for {G}!
		assert.equal(getCastOptions(state, p1.playerId, card, 'hand').length, 0);
		const badRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: card.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [elvishDork.instanceId] }
		});
		assert.equal(badRes.ok, false);

		// With 1 Forest + 1 mana dork: dork convokes {G} and Forest pays {1} -> succeeds!
		const forest = synthCard({
			name: 'Forest',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Forest',
			oracleText: '({T}: Add {G}.)'
		});
		const f1 = addCard(state, p1, forest, 'battlefield');
		const okRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: card.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [elvishDork.instanceId] }
		});
		assert.equal(okRes.ok, true, okRes.error ?? '');
		assert.equal(elvishDork.tapped, true);
		assert.equal(f1.tapped, true);
	});

	it('prevents reusing a convoke creature for a mandatory tap additional cost (CR 118.10)', () => {
		const { state, p1 } = setupMain1Game();
		const soldier = synthCard({
			name: 'Solo Guard',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Creature — Human Soldier',
			power: '1',
			toughness: '1',
			colors: ['W']
		});
		const spellWithExtraCost = synthCard({
			name: 'Guarded Blessing',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Convoke\nAs an additional cost to cast this spell, tap an untapped creature you control.\nGain 4 life.',
			colors: ['W'],
			keywords: ['Convoke']
		});
		const s1 = addCard(state, p1, soldier, 'battlefield');
		const sp = addCard(state, p1, spellWithExtraCost, 'hand');

		// 1 creature cannot pay BOTH the Convoke {W} and the additional "tap a creature" cost
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, sp, 'hand', 0, 'normal', undefined, undefined, undefined, { 'aid:convoke': [s1.instanceId] }, undefined, true).ok,
			false
		);
		const failRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: sp.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [s1.instanceId] }
		});
		assert.equal(failRes.ok, false);
	});

	it('fires BecomesTapped triggers from Convoke above the convoked spell on the stack (CR 702.51c, 601.2i)', () => {
		const { state, p1, p2 } = setupMain1Game();
		const tapTriggerCreature = synthCard({
			name: 'Emmara Watcher',
			manaCost: '{G}{W}',
			cmc: 2,
			typeLine: 'Creature — Elf Cleric',
			power: '2',
			toughness: '2',
			colors: ['G', 'W'],
			oracleText: 'Whenever Emmara Watcher becomes tapped, gain 1 life.'
		});
		const convokeSpell = synthCard({
			name: 'Sprouting Chorus',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Sorcery',
			colors: ['W'],
			oracleText: 'Convoke\nGain 3 life.',
			keywords: ['Convoke']
		});
		const watcher = addCard(state, p1, tapTriggerCreature, 'battlefield');
		const spell = addCard(state, p1, convokeSpell, 'hand');

		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [watcher.instanceId] },
			costAidColorChoices: { [watcher.instanceId]: 'W' }
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.stack.length, 2);
		assert.equal(state.stack[0].kind, 'spell');
		assert.equal(state.stack[1].kind, 'triggered');

		// Pass priority twice -> top of stack (becomes tapped trigger) resolves FIRST (+1 life = 41)
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(p1.life, 41);
		assert.equal(state.stack.length, 1);
	});

	it('applies cost increases (Commander Tax) before Convoke/Delve reductions (CR 601.2f-h, 702.51b, 702.66b)', () => {
		const { state, p1 } = setupMain1Game();
		const delveCommander = synthCard({
			name: 'Tasigur Test',
			manaCost: '{5}{B}',
			cmc: 6,
			typeLine: 'Legendary Creature — Human Shaman',
			power: '4',
			toughness: '5',
			colors: ['B'],
			canBeCommander: true,
			oracleText: 'Delve\nConvoke',
			keywords: ['Delve', 'Convoke']
		});
		const blackCreature = synthCard({
			name: 'Grave Rat',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Creature — Rat',
			power: '1',
			toughness: '1',
			colors: ['B']
		});
		const deadCard = synthCard({ name: 'Dead Spell', manaCost: '{1}', cmc: 1, typeLine: 'Sorcery' });

		const cmd = addCard(state, p1, delveCommander, 'command');
		cmd.commanderCastCount = 1; // + {2} commander tax -> total {7}{B}!
		const rat = addCard(state, p1, blackCreature, 'battlefield');
		const gyIds = Array.from({ length: 7 }, () => addCard(state, p1, deadCard, 'graveyard').instanceId);

		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: cmd.instanceId,
			fromZone: 'command',
			costAidIds: {
				'aid:convoke': [rat.instanceId],
				'aid:delve': gyIds
			}
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(p1.exile.length, 7);
		assert.equal(p1.graveyard.length, 0);
		assert.equal(rat.tapped, true);
		assert.equal(state.stack[0].card.name, 'Tasigur Test');
	});

	it('delves only generic mana, rejects exiling for colored pips or overpaying, and treats duplicates as redundant (CR 702.66a/c)', () => {
		const { state, p1 } = setupMain1Game();
		const swamp = synthCard({
			name: 'Swamp',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Swamp',
			oracleText: '({T}: Add {B}.)'
		});
		const doubleDelve = synthCard({
			name: 'Deep Delver',
			manaCost: '{3}{B}',
			cmc: 4,
			typeLine: 'Creature — Zombie',
			power: '4',
			toughness: '4',
			colors: ['B'],
			oracleText: 'Delve\nDelve',
			keywords: ['Delve', 'Delve']
		});
		const trash = synthCard({ name: 'Scrap', manaCost: '{1}', cmc: 1, typeLine: 'Instant' });
		addCard(state, p1, swamp, 'battlefield');
		const g1 = addCard(state, p1, trash, 'graveyard');
		const g2 = addCard(state, p1, trash, 'graveyard');
		const g3 = addCard(state, p1, trash, 'graveyard');
		const g4 = addCard(state, p1, trash, 'graveyard');
		const spell = addCard(state, p1, doubleDelve, 'hand');

		// Cannot exile 4 cards when only {3} generic exists
		const overpay = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:delve': [g1.instanceId, g2.instanceId, g3.instanceId, g4.instanceId] }
		});
		assert.equal(overpay.ok, false);

		// Exiling 3 cards pays {3}, Swamp pays {B}
		const ok = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:delve': [g1.instanceId, g2.instanceId, g3.instanceId] }
		});
		assert.equal(ok.ok, true, ok.error ?? '');
		assert.equal(p1.exile.length, 3);
		assert.equal(p1.graveyard.length, 1);

		// Multiple Convoke instances are redundant too (CR 702.51d)
		const doubleConvoke = synthCard({
			name: 'Twin Choir',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Bird',
			power: '2',
			toughness: '2',
			colors: ['W'],
			oracleText: 'Convoke\nConvoke',
			keywords: ['Convoke', 'Convoke']
		});
		const wBird = addCard(state, p1, synthCard({
			name: 'White Hawk',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Creature — Bird',
			power: '1',
			toughness: '1',
			colors: ['W']
		}), 'battlefield');
		const twinSpell = addCard(state, p1, doubleConvoke, 'hand');
		const failOneBird = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: twinSpell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:convoke': [wBird.instanceId] }
		});
		assert.equal(failOneBird.ok, false);
	});

	it('pauses mid-Delve on zone_replacement_choice, survives JSON round-trip, and finishes casting', () => {
		const { state, p1 } = setupMain1Game();
		const delveSpell = synthCard({
			name: 'Treasure Seek',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Sorcery',
			oracleText: 'As an additional cost to cast this spell, discard a card.\nDelve\nDraw two cards.',
			keywords: ['Delve']
		});
		const ripA = synthCard({
			name: 'Exile Field',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
		});
		const ripB = synthCard({
			name: 'Wheel Field',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Enchantment',
			oracleText: "If a card or token would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
		});
		const discardCard = synthCard({ name: 'Tossed Pebble', manaCost: '{0}', cmc: 0, typeLine: 'Artifact' });
		const normalCard = synthCard({ name: 'Filler', manaCost: '{1}', cmc: 1, typeLine: 'Sorcery' });

		addCard(state, p1, ripA, 'battlefield');
		addCard(state, p1, ripB, 'battlefield');
		const d1 = addCard(state, p1, discardCard, 'hand');
		const gy1 = addCard(state, p1, normalCard, 'graveyard');
		const gy2 = addCard(state, p1, normalCard, 'graveyard');
		const spell = addCard(state, p1, delveSpell, 'hand');

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: spell.instanceId,
			fromZone: 'hand',
			costAidIds: { 'aid:delve': [gy1.instanceId, gy2.instanceId] },
			costPayment: { options: [], objects: [[d1.instanceId]] }
		});
		assert.equal(castRes.ok, true, castRes.error ?? '');
		assert.ok(state.pendingCostPayment, 'should pause inside PendingCostPayment during Delve spell');
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].choice?.kind, 'chooseReplacement');
		// Delve cards in graveyard must NOT have been exiled yet while discard paused
		assert.equal(p1.graveyard.length, 2);

		// JSON round-trip mid-payment!
		const restored: GameState = JSON.parse(JSON.stringify(state));
		const prompt = restored.pendingPrompts[0];
		assert.equal(prompt.choice?.kind, 'chooseReplacement');
		const exileOpt = prompt.choice.options[0];
		const resolveRes = applyGameAction(restored, 'p1', {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseReplacement', id: exileOpt.id }
		});
		assert.equal(resolveRes.ok, true, resolveRes.error ?? '');
		assert.equal(restored.pendingCostPayment, undefined);
		assert.equal(restored.pendingPrompts.length, 0);
		assert.equal(restored.stack.length, 1);
		assert.equal(restored.stack[0].card.name, 'Treasure Seek');
		// Both discard (replaced to exile) and the 2 Delve cards ended up in exile
		assert.equal(restored.players[0].graveyard.length, 0);
		assert.equal(restored.players[0].exile.some((c) => c.instanceId === d1.instanceId), true);
		assert.equal(restored.players[0].exile.some((c) => c.instanceId === gy1.instanceId), true);
		assert.equal(restored.players[0].exile.some((c) => c.instanceId === gy2.instanceId), true);
	});

	it('scopes paymentAids strictly to the cast face of a multi-face card', () => {
		const { state, p1 } = setupMain1Game();
		const split = synthCard({
			name: 'March // Dig',
			manaCost: '{1}{W}',
			cmc: 2,
			layout: 'split',
			typeLine: 'Instant // Sorcery',
			faces: [
				{
					name: 'March',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Instant',
					oracleText: 'Convoke\nGain 2 life.',
					colors: ['W'],
					keywords: ['Convoke'],
					imageUrl: ''
				},
				{
					name: 'Dig',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Sorcery',
					oracleText: 'Delve\nDraw a card.',
					colors: ['U'],
					keywords: ['Delve'],
					imageUrl: ''
				}
			]
		});
		const wCreature = addCard(state, p1, synthCard({
			name: 'Squire',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Human',
			power: '1',
			toughness: '2',
			colors: ['W']
		}), 'battlefield');
		addCard(state, p1, synthCard({
			name: 'Plains',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Plains',
			oracleText: '({T}: Add {W}.)'
		}), 'battlefield');
		addCard(state, p1, synthCard({ name: 'Dead', manaCost: '{1}', cmc: 1, typeLine: 'Instant' }), 'graveyard');
		const splitInst = addCard(state, p1, split, 'hand');

		const opts = getCastOptions(state, p1.playerId, splitInst, 'hand');
		const marchOpt = opts.find((o) => o.faceIndex === 0);
		assert.ok(marchOpt);
		assert.ok(marchOpt.paymentAids?.some((a) => a.id === 'aid:convoke'));
		assert.ok(!marchOpt.paymentAids?.some((a) => a.id === 'aid:delve'));
		assert.equal(wCreature.tapped, false);
	});

	it('allows bot AI to cast Convoke and Delve spells using costAidIds when short on lands', () => {
		const { state, p1 } = setupMain1Game({ p1Bot: true });
		p1.hand = [];
		const island = synthCard({
			name: 'Island',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Island',
			oracleText: '({T}: Add {U}.)'
		});
		const delveDraw = synthCard({
			name: 'Cruising Bot',
			manaCost: '{4}{U}',
			cmc: 5,
			typeLine: 'Sorcery',
			colors: ['U'],
			oracleText: 'Delve\nDraw two cards.',
			keywords: ['Delve']
		});
		addCard(state, p1, island, 'battlefield');
		for (let i = 0; i < 4; i++) {
			addCard(state, p1, synthCard({ name: `Scrap ${i}`, manaCost: '{1}', cmc: 1, typeLine: 'Sorcery' }), 'graveyard');
		}
		addCard(state, p1, delveDraw, 'hand');

		const step1 = executeBotStep(state, p1, p1);
		assert.equal(step1, 'visible');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].card.name, 'Cruising Bot');
		assert.equal(p1.exile.length, 4);

		// Also verify bot casting a Convoke creature when short on lands
		const { state: s2, p1: bot2 } = setupMain1Game({ p1Bot: true });
		bot2.hand = [];
		const greenTok = synthCard({
			name: 'Saproling',
			manaCost: '',
			cmc: 0,
			typeLine: 'Creature — Saproling',
			power: '1',
			toughness: '1',
			colors: ['G']
		});
		const convokeBot = synthCard({
			name: 'Conclave Bot Beast',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Creature — Beast',
			power: '4',
			toughness: '4',
			colors: ['G'],
			oracleText: 'Convoke',
			keywords: ['Convoke']
		});
		const c1 = addCard(s2, bot2, greenTok, 'battlefield');
		const c2 = addCard(s2, bot2, greenTok, 'battlefield');
		const c3 = addCard(s2, bot2, greenTok, 'battlefield');
		const c4 = addCard(s2, bot2, greenTok, 'battlefield');
		addCard(s2, bot2, convokeBot, 'hand');

		const step2 = executeBotStep(s2, bot2, bot2);
		assert.equal(step2, 'visible');
		assert.equal(s2.stack.length, 1);
		assert.equal(s2.stack[0].card.name, 'Conclave Bot Beast');
		assert.ok([c1, c2, c3, c4].every((c) => c.tapped));
	});
});
