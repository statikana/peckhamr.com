import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeBotStep } from '../ai.ts';
import { compileCard } from '../compiler/index.ts';
import { cardSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
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

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAGIC_DIR = path.resolve(RUNTIME_DIR, '..');

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
		id: 'deck_slice2',
		userId: 'p1',
		name: 'Slice 2 Deck',
		description: '',
		commanders: commander ? [commander] : [],
		cards: entries,
		colorIdentity: commander?.colorIdentity ?? ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + (commander ? 1 : 0),
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
}

function setupMain1Game(opts: { p1Bot?: boolean; p2Bot?: boolean } = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Basic Filler',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const deck = makeDeck(Array.from({ length: 20 }, () => filler));
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: opts.p1Bot ? null : 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		},
		{
			seatIndex: 1,
			userId: opts.p2Bot ? null : 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: Boolean(opts.p2Bot),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		}
	];
	const state = createInitialGameState(
		'SLICE2',
		seats,
		new Map([
			[0, deck],
			[1, deck]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	state.status = 'active';
	state.turnNumber = 1;
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	state.pendingPrompts = [];
	const [p1, p2] = state.players;
	p1.hasKeptHand = true;
	p2.hasKeptHand = true;
	p1.hand = [];
	p2.hand = [];
	return { state, p1, p2 };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, undefined, state);
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	if (zone === 'battlefield') {
		inst.summoningSick = false;
	}
	player[zone].push(inst);
	return inst;
}

function resolveOrderTriggersPromptIfAny(state: GameState): boolean {
	const prompt = state.pendingPrompts[0];
	if (prompt && prompt.choice?.kind === 'orderObjects') {
		const res = applyGameAction(state, prompt.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'orderObjects', topIds: prompt.choice.objectIds }
		});
		assert.equal(res.ok, true, res.error ?? '');
		return true;
	}
	return false;
}

function drainStack(state: GameState): void {
	for (let guard = 0; guard < 40; guard++) {
		if (resolveOrderTriggersPromptIfAny(state)) continue;
		assert.equal(
			state.pendingPrompts.length,
			0,
			`Unexpected pending prompt while draining stack: ${state.pendingPrompts[0]?.kind}`
		);
		if (state.stack.length === 0) return;
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
	assert.equal(state.stack.length, 0, 'Stack failed to drain within bounded iterations');
}

function advanceUntilPhase(state: GameState, targetPhase: GameState['phase'], targetActiveIdx?: number): void {
	for (let guard = 0; guard < 40; guard++) {
		if (resolveOrderTriggersPromptIfAny(state)) continue;
		assert.equal(state.pendingPrompts.length, 0, 'Unexpected prompt while advancing phases');
		if (
			state.stack.length === 0 &&
			state.phase === targetPhase &&
			(targetActiveIdx === undefined || state.activePlayerIndex === targetActiveIdx)
		) {
			return;
		}
		const actor = state.players[state.priorityPlayerIndex];
		if (
			state.phase === 'declare_attackers' &&
			state.stack.length === 0 &&
			!state.combat.active &&
			actor.playerId === state.players[state.activePlayerIndex].playerId
		) {
			const res = applyGameAction(state, actor.playerId, {
				type: 'declare_attackers',
				assignments: []
			});
			assert.equal(res.ok, true, res.error ?? '');
			continue;
		}
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
	assert.fail(`Failed to reach phase ${targetPhase} within bounded steps`);
}

describe('Track F Slice 2 — Hand & Graveyard Activated Abilities', () => {
	it('compiles and resolves Channel / Discard ~ abilities from hand at instant speed and blocks activation from other zones', () => {
		const boseijuStyle = synthCard({
			name: 'Verdant Relic-Bough',
			manaCost: '{2}{G}',
			cmc: 3,
			typeLine: 'Creature — Spirit',
			oracleText: 'Channel — {1}{G}, Discard ~: Destroy target artifact.',
			power: '2',
			toughness: '2',
			colors: ['G'],
			colorIdentity: ['G']
		});
		const report = cardSupportReport(boseijuStyle);
		assert.equal(report.fullySupported, true);

		const { state, p1, p2 } = setupMain1Game();
		const targetArt = putInZone(
			state,
			p2,
			synthCard({ name: 'Iron Relic', manaCost: '{2}', cmc: 2, typeLine: 'Artifact' }),
			'battlefield'
		);
		const channelCard = putInZone(state, p1, boseijuStyle, 'hand');

		// Instant-speed activation on opponent's turn
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		state.phase = 'upkeep';

		const handAbs = getEffectiveActivatedAbilities(state, p1, channelCard);
		const channelAb = handAbs.find((a) => a.activationZones?.includes('hand'));
		assert.ok(channelAb, 'Expected hand-scoped Channel ability');
		assert.equal(channelAb.sorcerySpeedOnly, false);

		p1.manaPool.G = 2;
		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: channelCard.instanceId,
			abilityId: channelAb.id,
			targets: [{ kind: 'permanent', id: targetArt.instanceId, label: targetArt.card.name }]
		});
		assert.equal(actRes.ok, true, actRes.error ?? '');
		assert.equal(p1.hand.length, 0, 'Discarding ~ as cost moves it out of hand immediately');
		assert.equal(p1.graveyard.some((c) => c.instanceId === channelCard.instanceId), true);

		// Cannot activate again from graveyard
		const fromGyRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: channelCard.instanceId,
			abilityId: channelAb.id,
			targets: [{ kind: 'permanent', id: targetArt.instanceId, label: targetArt.card.name }]
		});
		assert.equal(fromGyRes.ok, false);

		drainStack(state);
		assert.equal(p2.battlefield.some((c) => c.instanceId === targetArt.instanceId), false);
		assert.equal(p2.graveyard.some((c) => c.instanceId === targetArt.instanceId), true);
	});

	it('infers hand activationZones from explicit "Activate only if ~ is in your hand" and enforces sorcery restriction', () => {
		const handInsight = synthCard({
			name: 'Tome Whisperer',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Creature — Wizard',
			oracleText: '{1}{U}: Gain 2 life. Activate only if ~ is in your hand and only as a sorcery.',
			power: '2',
			toughness: '3',
			colors: ['U'],
			colorIdentity: ['U']
		});
		assert.equal(cardSupportReport(handInsight).fullySupported, true);

		const { state, p1 } = setupMain1Game();
		const inHand = putInZone(state, p1, handInsight, 'hand');
		const onBf = putInZone(state, p1, handInsight, 'battlefield');
		p1.manaPool.U = 4;

		const bfAbCheck = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: onBf.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(bfAbCheck.ok, false, 'Cannot activate hand-only ability from battlefield');

		state.phase = 'upkeep';
		const upkeepCheck = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: inHand.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(upkeepCheck.ok, false, 'Sorcery-speed hand ability rejected during upkeep');

		state.phase = 'main1';
		const mainCheck = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: inHand.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(mainCheck.ok, true, mainCheck.error ?? '');
		drainStack(state);
		assert.equal(p1.life, 42);
	});

	it('supports Reassembling Skeleton, Sanitarium Skeleton, Exile ~ from graveyard, onceEachTurn, Grand Abolisher, and CR 400.7 version guards', () => {
		const reassembling = synthCard({
			name: 'Bone Reassembler',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Skeleton Warrior',
			oracleText: '{1}{B}: Return ~ from your graveyard to the battlefield tapped.',
			power: '1',
			toughness: '1',
			colors: ['B'],
			colorIdentity: ['B']
		});
		const sanitarium = synthCard({
			name: 'Asylum Bones',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Creature — Skeleton',
			oracleText: '{2}{B}: Return ~ from your graveyard to your hand.',
			power: '1',
			toughness: '2',
			colors: ['B'],
			colorIdentity: ['B']
		});
		const exileSelfGy = synthCard({
			name: 'Soul Vial',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Artifact',
			oracleText: '{G}, Exile ~ from your graveyard: Gain 3 life.'
		});
		const oncePerTurnGy = synthCard({
			name: 'CryptWhisperer',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Spirit',
			oracleText:
				'{B}: Gain 1 life. Activate only if ~ is in your graveyard and only once each turn.',
			power: '1',
			toughness: '1'
		});

		assert.equal(cardSupportReport(reassembling).fullySupported, true);
		assert.equal(cardSupportReport(sanitarium).fullySupported, true);
		assert.equal(cardSupportReport(exileSelfGy).fullySupported, true);
		assert.equal(cardSupportReport(oncePerTurnGy).fullySupported, true);

		const { state, p1, p2 } = setupMain1Game();
		const skel1 = putInZone(state, p1, reassembling, 'graveyard');
		const skel2 = putInZone(state, p1, sanitarium, 'graveyard');
		const vial = putInZone(state, p1, exileSelfGy, 'graveyard');
		const spirit = putInZone(state, p1, oncePerTurnGy, 'graveyard');

		// 1. Reassembling Skeleton returns tapped to battlefield
		p1.manaPool.B = 10;
		p1.manaPool.G = 2;
		const res1 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: skel1.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(res1.ok, true, res1.error ?? '');
		drainStack(state);
		const skelOnBf = p1.battlefield.find((c) => c.instanceId === skel1.instanceId);
		assert.ok(skelOnBf, 'Skeleton returned to battlefield');
		assert.equal(skelOnBf.tapped, true, 'Skeleton entered tapped');

		// Cannot activate graveyard ability while on battlefield
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: skelOnBf.instanceId,
				abilityId: 'act_0'
			}).ok,
			false
		);

		// 2. Sanitarium Skeleton returns to hand
		const res2 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: skel2.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(res2.ok, true, res2.error ?? '');
		drainStack(state);
		assert.equal(p1.hand.some((c) => c.instanceId === skel2.instanceId), true);

		// 3. Exile ~ from graveyard pays cost immediately and resolves life gain
		const lifeBefore = p1.life;
		const res3 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: vial.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(res3.ok, true, res3.error ?? '');
		assert.equal(p1.exile.some((c) => c.instanceId === vial.instanceId), true);
		drainStack(state);
		assert.equal(p1.life, lifeBefore + 3);

		// 4. onceEachTurn in graveyard
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: spirit.instanceId,
				abilityId: 'act_0'
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: spirit.instanceId,
				abilityId: 'act_0'
			}).ok,
			false,
			'onceEachTurn blocks second graveyard activation on same turn'
		);

		// 5. Grand Abolisher on p2's turn blocks p1 from activating graveyard creature ability
		const p1GySkel = putInZone(state, p1, reassembling, 'graveyard');
		const abolisher = synthCard({
			name: 'Silent Arbiter Cleric',
			manaCost: '{W}{W}',
			cmc: 2,
			typeLine: 'Creature — Human Cleric',
			oracleText:
				"During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments.",
			power: '2',
			toughness: '2'
		});
		putInZone(state, p2, abolisher, 'battlefield');
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		const blockedByAbolisher = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: p1GySkel.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(blockedByAbolisher.ok, false, 'Grand Abolisher blocks graveyard creature ability');

		// 6. CR 400.7 version guard if graveyard card changes zones and returns before resolution
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.phase = 'main1';
		const res4 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: p1GySkel.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(res4.ok, true, res4.error ?? '');
		// Simulate opponent exiling and re-putting into graveyard (bumping objectVersion)
		p1GySkel.objectVersion = (p1GySkel.objectVersion ?? 1) + 2;
		drainStack(state);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === p1GySkel.instanceId),
			true,
			'CR 400.7: bumped objectVersion in graveyard is not moved by stale ability'
		);
	});

	it('preserves battlefield self-blink ("Exile ~, then return ~ to the battlefield") despite CR 400.7 graveyard guard', () => {
		const blinker = synthCard({
			name: 'Aether Blinker',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Spirit',
			oracleText: "{W}: Exile ~, then return ~ to the battlefield under its owner's control.",
			power: '2',
			toughness: '2'
		});
		assert.equal(cardSupportReport(blinker).fullySupported, true);

		const { state, p1 } = setupMain1Game();
		const perm = putInZone(state, p1, blinker, 'battlefield');
		const initialVersion = perm.objectVersion ?? 1;
		p1.manaPool.W = 2;

		const res = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: perm.instanceId,
			abilityId: 'act_0'
		});
		assert.equal(res.ok, true, res.error ?? '');
		drainStack(state);

		const after = p1.battlefield.find((c) => c.instanceId === perm.instanceId);
		assert.ok(after, 'Self-blink creature returned to battlefield');
		assert.ok((after.objectVersion ?? 1) > initialVersion, 'Returned as a new objectVersion');
	});
});

describe('Track F Slice 2 — Unearth (CR 702.84a)', () => {
	it('Unearth returns from graveyard at sorcery speed with haste, exiles at next end step, and replaces non-exile departures', () => {
		const unearthCreature = synthCard({
			name: 'Rotting Lancer',
			manaCost: '{2}{B}',
			cmc: 3,
			typeLine: 'Creature — Zombie Knight',
			oracleText: 'Unearth {1}{B}',
			power: '3',
			toughness: '1',
			colors: ['B'],
			colorIdentity: ['B']
		});
		const dashUnearth = synthCard({
			name: 'Bloodbound Thrall',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Vampire',
			oracleText: 'Unearth—Pay 2 life.',
			power: '2',
			toughness: '1'
		});
		assert.equal(cardSupportReport(unearthCreature).fullySupported, true);
		assert.equal(cardSupportReport(dashUnearth).fullySupported, true);

		const { state, p1 } = setupMain1Game();
		const zombie = putInZone(state, p1, unearthCreature, 'graveyard');
		const thrall = putInZone(state, p1, dashUnearth, 'graveyard');
		p1.manaPool.B = 4;

		// Sorcery-speed restriction: rejected during upkeep
		state.phase = 'upkeep';
		const abs = getEffectiveActivatedAbilities(state, p1, zombie);
		const unearthAb = abs.find((a) => a.id.startsWith('unearth_'));
		assert.ok(unearthAb, 'Expected Unearth activated ability');
		assert.equal(checkAbilityActivationLegality(state, p1.playerId, zombie, unearthAb).ok, false);

		// Main phase activation succeeds
		state.phase = 'main1';
		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: zombie.instanceId,
			abilityId: unearthAb.id
		});
		assert.equal(actRes.ok, true, actRes.error ?? '');
		drainStack(state);

		const onBf = p1.battlefield.find((c) => c.instanceId === zombie.instanceId);
		assert.ok(onBf, 'Unearthed creature entered battlefield');
		assert.equal(hasKeyword(onBf, 'Haste', state), true, 'Unearth grants Haste');
		assert.equal(onBf.unearthLeaveExile, true);

		// Bounce spell ("Return target creature to its owner's hand") -> replaced with exile!
		const bounce = synthCard({
			name: 'Vapor Recall',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: "Return target creature to its owner's hand."
		});
		const bounceInst = putInZone(state, p1, bounce, 'hand');
		p1.manaPool.U = 2;
		const castBounce = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: bounceInst.instanceId,
			fromZone: 'hand',
			targets: [{ kind: 'permanent', id: onBf.instanceId, label: onBf.card.name }]
		});
		assert.equal(castBounce.ok, true, castBounce.error ?? '');
		drainStack(state);

		assert.equal(p1.hand.some((c) => c.instanceId === zombie.instanceId), false, 'Did not return to hand');
		assert.equal(p1.exile.some((c) => c.instanceId === zombie.instanceId), true, 'Exiled instead of going to hand');

		// Dash-cost Unearth—Pay 2 life. -> exiles at next end step
		const thrallAb = getEffectiveActivatedAbilities(state, p1, thrall).find((a) =>
			a.id.startsWith('unearth_')
		)!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: thrall.instanceId,
				abilityId: thrallAb.id
			}).ok,
			true
		);
		assert.equal(p1.life, 38);
		drainStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === thrall.instanceId), true);

		// Advance past p1's end_step (draining the delayed exile trigger) into p2's upkeep
		advanceUntilPhase(state, 'upkeep', 1);
		assert.equal(p1.battlefield.some((c) => c.instanceId === thrall.instanceId), false);
		assert.equal(p1.exile.some((c) => c.instanceId === thrall.instanceId), true);
	});

	it('CR 702.84a + CR 400.7: direct flicker to exile is NOT replaced and returns as a fresh permanent without unearth exile', () => {
		const unearthCreature = synthCard({
			name: 'Vault Construct',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact Creature — Golem',
			oracleText: 'Unearth {1}',
			power: '2',
			toughness: '2'
		});
		const flicker = synthCard({
			name: 'Phase Flicker',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText:
				'Exile target creature you control, then return that card to the battlefield under your control.'
		});
		const murder = synthCard({
			name: 'Shatter Bolt',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Destroy target creature.'
		});

		const { state, p1 } = setupMain1Game();
		const golem = putInZone(state, p1, unearthCreature, 'graveyard');
		const flickerInst = putInZone(state, p1, flicker, 'hand');
		const murderInst = putInZone(state, p1, murder, 'hand');
		p1.manaPool.W = 2;
		p1.manaPool.B = 2;

		const unearthAb = getEffectiveActivatedAbilities(state, p1, golem)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: golem.instanceId,
				abilityId: unearthAb.id
			}).ok,
			true
		);
		drainStack(state);

		// Flicker directly to exile and back
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flickerInst.instanceId,
				fromZone: 'hand',
				targets: [{ kind: 'permanent', id: golem.instanceId, label: golem.card.name }]
			}).ok,
			true
		);
		drainStack(state);

		const flickered = p1.battlefield.find((c) => c.instanceId === golem.instanceId);
		assert.ok(flickered, 'Flickered golem returned to battlefield');
		assert.equal(flickered.unearthLeaveExile, undefined, 'unearthLeaveExile cleared on new object');

		// Survives end step!
		advanceUntilPhase(state, 'upkeep', 1);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === golem.instanceId),
			true,
			'Flickered permanent is not exiled by Unearth end-step delayed trigger'
		);

		// Destroying it now puts it into graveyard normally, NOT exile
		advanceUntilPhase(state, 'main1', 0);
		p1.manaPool.B = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: murderInst.instanceId,
				fromZone: 'hand',
				targets: [{ kind: 'permanent', id: golem.instanceId, label: golem.card.name }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === golem.instanceId), true);
	});
});

describe('Track F Slice 2 — Buyback (CR 702.27a)', () => {
	it('unlocks precon Corpse Dance as fullySupported and returns Buyback spells to hand only on normal resolution', () => {
		const corpseDance =
			Object.values(STAPLE_CARDS).find((c) => c.name === 'Corpse Dance') ??
			PRECON_DECKS.flatMap((d) => d.cards.map((e) => e.card)).find((c) => c.name === 'Corpse Dance');
		assert.ok(corpseDance, 'Found Corpse Dance in precons/staples');
		assert.equal(cardSupportReport(corpseDance).fullySupported, true, 'Corpse Dance is now 100% supported');

		const whispers = synthCard({
			name: 'Shadow Whispers',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Buyback {2}\nDraw a card.',
			colors: ['B'],
			colorIdentity: ['B']
		});
		const lifeBuyback = synthCard({
			name: 'Crimson Pulse',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Buyback—Pay 3 life.\nIf ~ was kicked, gain 5 life.\nGain 1 life.'
		});
		assert.equal(cardSupportReport(whispers).fullySupported, true);
		assert.equal(cardSupportReport(lifeBuyback).fullySupported, true);

		const { state, p1, p2 } = setupMain1Game();
		const wInst = putInZone(state, p1, whispers, 'hand');
		const lInst = putInZone(state, p1, lifeBuyback, 'hand');
		p1.manaPool.B = 5;
		p1.manaPool.R = 3;

		// 1. Cast WITH Buyback -> returns to hand!
		const opts = getCastOptions(state, p1.playerId, wInst, 'hand');
		assert.equal(opts.length, 1);
		assert.equal(opts[0].optionalAdditionalCosts?.[0]?.id, 'buyback:0');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: wInst.instanceId,
				fromZone: 'hand',
				optionId: opts[0].id,
				optionalCostCounts: { 'buyback:0': 1 }
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.hand.some((c) => c.instanceId === wInst.instanceId), true, 'Buyback returned spell to hand');
		assert.equal(p1.graveyard.some((c) => c.instanceId === wInst.instanceId), false);

		// 2. Cast WITHOUT Buyback -> goes to graveyard!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: wInst.instanceId,
				fromZone: 'hand',
				optionId: opts[0].id
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === wInst.instanceId), true);

		// 3. Dash-cost Buyback—Pay 3 life. does NOT satisfy { k: 'kicked' }!
		const lifeBefore = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: lInst.instanceId,
				fromZone: 'hand',
				optionId: 'normal',
				optionalCostCounts: { 'buyback:0': 1 }
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.life, lifeBefore - 3 + 1, 'Paid 3 life for Buyback and gained 1 (NOT 5 from kicked)');
		assert.equal(p1.hand.some((c) => c.instanceId === lInst.instanceId), true);

		// 4. Countered Buyback spell goes to graveyard, NOT hand
		const counterspell = synthCard({
			name: 'Hard Counter',
			manaCost: '{U}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Counter target spell.'
		});
		const csInst = putInZone(state, p2, counterspell, 'hand');
		p2.manaPool.U = 2;
		p1.manaPool.R = 2;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: lInst.instanceId,
				fromZone: 'hand',
				optionId: 'normal',
				optionalCostCounts: { 'buyback:0': 1 }
			}).ok,
			true
		);
		const spellOnStack = state.stack[state.stack.length - 1];
		// Pass priority to p2 so p2 counters it
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: csInst.instanceId,
				fromZone: 'hand',
				targets: [{ kind: 'stack', id: spellOnStack.id, label: spellOnStack.title }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === lInst.instanceId), true, 'Countered Buyback goes to GY');
		assert.equal(p1.hand.some((c) => c.instanceId === lInst.instanceId), false);
	});

	it('fizzled Buyback goes to graveyard (CR 608.2b) and Flashback + Buyback exiles (CR 702.34a)', () => {
		const targetedBuyback = synthCard({
			name: 'Searing Bolt',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Buyback {1}\n~ deals 2 damage to target creature.'
		});
		const flashbackBuyback = synthCard({
			name: 'Echoing Wisdom',
			manaCost: '{U}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText: 'Buyback {1}\nDraw a card.\nFlashback {1}{U}'
		});
		const sacOutlet = synthCard({
			name: 'Altar Helper',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Creature — Bear',
			oracleText: 'Sacrifice ~: Gain 1 life.',
			power: '2',
			toughness: '2'
		});

		const { state, p1, p2 } = setupMain1Game();
		const bolt = putInZone(state, p1, targetedBuyback, 'hand');
		const bear = putInZone(state, p2, sacOutlet, 'battlefield');
		const echo = putInZone(state, p1, flashbackBuyback, 'graveyard');
		p1.manaPool.R = 3;
		p1.manaPool.U = 5;

		// Cast bolt with Buyback targeting bear, then p2 sacrifices bear in response -> bolt fizzles to GY!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				fromZone: 'hand',
				optionId: 'normal',
				optionalCostCounts: { 'buyback:0': 1 },
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: bear.instanceId,
				abilityId: 'act_0'
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === bolt.instanceId),
			true,
			'Fizzled Buyback spell goes to graveyard, not hand'
		);

		// Cast Echoing Wisdom from graveyard via Flashback AND pay Buyback -> Flashback exiles it!
		const gyOpts = getCastOptions(state, p1.playerId, echo, 'graveyard');
		assert.equal(gyOpts.length, 1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: echo.instanceId,
				fromZone: 'graveyard',
				optionId: gyOpts[0].id,
				optionalCostCounts: { 'buyback:0': 1 }
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(
			p1.exile.some((c) => c.instanceId === echo.instanceId),
			true,
			'CR 702.34a Flashback exile overrides Buyback return-to-hand'
		);
		assert.equal(p1.hand.some((c) => c.instanceId === echo.instanceId), false);
	});
});

describe('Track F Slice 2 — Evoke (CR 702.74a)', () => {
	it('Mulldrifter-style Evoke draws cards and sacrifices itself when evoked, stays when cast normally, and respects CR 400.7 flicker', () => {
		const drifter = synthCard({
			name: 'Cloud Drifter',
			manaCost: '{4}{U}',
			cmc: 5,
			typeLine: 'Creature — Elemental',
			oracleText: 'Flying\nWhen ~ enters, draw two cards.\nEvoke {2}{U}',
			power: '2',
			toughness: '2',
			colors: ['U'],
			colorIdentity: ['U']
		});
		const flicker = synthCard({
			name: 'Instant Cloudshift',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText:
				'Exile target creature you control, then return that card to the battlefield under your control.'
		});
		assert.equal(cardSupportReport(drifter).fullySupported, true);

		const { state, p1, p2 } = setupMain1Game();
		const d1 = putInZone(state, p1, drifter, 'hand');
		const d2 = putInZone(state, p1, drifter, 'hand');
		const d3 = putInZone(state, p1, drifter, 'hand');
		const flk = putInZone(state, p1, flicker, 'hand');

		// 1. Cast normally -> draws 2, stays on battlefield
		p1.manaPool.U = 5;
		const handBefore1 = p1.hand.length;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: d1.instanceId,
				fromZone: 'hand',
				optionId: 'normal'
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === d1.instanceId), true);
		assert.equal(p1.hand.length, handBefore1 - 1 + 2);

		// 2. Cast via Evoke -> draws 2 AND sacrifices itself
		p1.manaPool.U = 3;
		const handBefore2 = p1.hand.length;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: d2.instanceId,
				fromZone: 'hand',
				optionId: 'alt:evoke'
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === d2.instanceId), false);
		assert.equal(p1.graveyard.some((c) => c.instanceId === d2.instanceId), true);
		assert.equal(p1.hand.length, handBefore2 - 1 + 2);

		// 3. Cast via Evoke + flicker while ETB triggers are on stack -> draws 4 total and stays on battlefield!
		p1.manaPool.U = 3;
		p1.manaPool.W = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: d3.instanceId,
				fromZone: 'hand',
				optionId: 'alt:evoke'
			}).ok,
			true
		);
		// Resolve the creature spell itself so its ETB draw + Evoke sacrifice triggers go on stack
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		resolveOrderTriggersPromptIfAny(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === d3.instanceId), true);
		assert.ok(
			state.stack.some((s) => s.kind === 'triggered' && s.sourceInstanceId === d3.instanceId),
			'Evoke sacrifice trigger is on the stack'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flk.instanceId,
				fromZone: 'hand',
				targets: [{ kind: 'permanent', id: d3.instanceId, label: d3.card.name }]
			}).ok,
			true
		);
		drainStack(state);
		const survived = p1.battlefield.find((c) => c.instanceId === d3.instanceId);
		assert.ok(survived, 'CR 400.7: Flickered evoked creature survived Evoke sacrifice trigger');
		assert.equal(survived.evoked, undefined);
	});
});

describe('Track F Slice 2 — Escape (CR 702.138a–d)', () => {
	it('casts from graveyard exiling N other cards, applies "escapes with" counters & haste, evaluates "unless it escaped", and rejects multi-type Escape', () => {
		const titan = synthCard({
			name: 'Elder River Titan',
			manaCost: '{1}{G}{U}',
			cmc: 3,
			typeLine: 'Creature — Elder Giant',
			oracleText:
				'When ~ enters, sacrifice it unless it escaped.\nWhen ~ enters, gain 3 life.\nEscape—{G}{G}{U}{U}, Exile three other cards from your graveyard.\n~ escapes with two +1/+1 counters on it.\n~ escapes with haste.',
			power: '6',
			toughness: '6',
			colors: ['G', 'U'],
			colorIdentity: ['G', 'U']
		});
		assert.equal(cardSupportReport(titan).fullySupported, true);

		const multiTypeEscape = synthCard({
			name: 'Goyf of the Pit',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Creature — Lhurgoyf',
			oracleText:
				'Escape—{B}, Exile any number of other cards from your graveyard with four or more card types among them.',
			power: '1',
			toughness: '1'
		});
		assert.equal(
			cardSupportReport(multiTypeEscape).fullySupported,
			false,
			'Nethergoyf multi-type group constraint must be rejected cleanly'
		);

		const { state, p1 } = setupMain1Game();
		const tInst = putInZone(state, p1, titan, 'hand');

		// 1. Cast from hand -> gains 3 life, has 0 counters, no haste, sacrifices itself because it did NOT escape!
		p1.manaPool.G = 2;
		p1.manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tInst.instanceId,
				fromZone: 'hand',
				optionId: 'normal'
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.life, 43);
		assert.equal(p1.graveyard.some((c) => c.instanceId === tInst.instanceId), true, 'Sacrificed when not escaped');

		// 2. In graveyard with only 2 other cards -> Escape is illegal (cannot exile itself as one of the 3!)
		const fodderCard = synthCard({ name: 'Grave Yardling', manaCost: '{1}', cmc: 1, typeLine: 'Instant' });
		const f1 = putInZone(state, p1, fodderCard, 'graveyard');
		const f2 = putInZone(state, p1, fodderCard, 'graveyard');
		p1.manaPool.G = 2;
		p1.manaPool.U = 2;
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, tInst, 'graveyard', 0, 'alt:escape').ok,
			false,
			'Cannot escape with only 2 other cards in graveyard'
		);

		// Add 3rd other graveyard card -> Escape succeeds!
		const f3 = putInZone(state, p1, fodderCard, 'graveyard');
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, tInst, 'graveyard', 0, 'alt:escape').ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tInst.instanceId,
				fromZone: 'graveyard',
				optionId: 'alt:escape',
				costPayment: { objects: [[f1.instanceId, f2.instanceId, f3.instanceId]] }
			}).ok,
			true
		);
		assert.equal(p1.exile.length, 3, 'Exiled 3 other graveyard cards to pay Escape');
		drainStack(state);

		const escapedPerm = p1.battlefield.find((c) => c.instanceId === tInst.instanceId);
		assert.ok(escapedPerm, 'Escaped Titan stayed on the battlefield');
		assert.equal(escapedPerm.escaped, true);
		assert.equal(escapedPerm.counters['+1/+1'], 2, 'CR 702.138c: entered with two +1/+1 counters');
		assert.equal(hasKeyword(escapedPerm, 'Haste', state), true, 'CR 702.138d: escaped permanent has Layer 6 Haste');
		const evalPerm = evaluatePermanent(state, escapedPerm);
		assert.equal(evalPerm.power, 8);
		assert.equal(evalPerm.toughness, 8);
		assert.equal(p1.life, 46);
	});
});

describe('Track F Slice 2 — Rename Invariance, Bot Graveyard Activation, & Zero UI/AI Keyword Literals', () => {
	it('produces identical IR and runtime behavior across arbitrary card renames and lets bots activate graveyard abilities', () => {
		const makePair = (name: string) =>
			synthCard({
				name,
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Creature — Zombie',
				oracleText: 'Unearth {1}{B}',
				power: '3',
				toughness: '2'
			});

		const irA = compileCard(makePair('Alpha Corpse')).faces[0].abilities;
		const irB = compileCard(makePair('Zeta Construct')).faces[0].abilities;
		assert.deepEqual(irA, irB, 'Compiled IR is 100% invariant to card name');

		const { state, p1 } = setupMain1Game({ p1Bot: true });
		const botZombie = putInZone(state, p1, makePair('Bot Unearther'), 'graveyard');
		p1.manaPool.B = 2;
		const stepRes = executeBotStep(state, p1, p1);
		assert.notEqual(stepRes, 'none');
		drainStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === botZombie.instanceId),
			true,
			'Bot activated graveyard Unearth ability cleanly'
		);
	});

	it('ArenaTable.svelte and ai.ts contain zero string literals for unearth, buyback, evoke, escape, or channel', () => {
		for (const rel of ['ArenaTable.svelte', 'ai.ts']) {
			const content = fs.readFileSync(path.join(MAGIC_DIR, rel), 'utf8');
			// Exclude DOM KeyboardEvent `e.key === 'Escape'` while forbidding all lowercase/keyword literals
			const cleaned = content.replace(/e\.key\s*===\s*['"]Escape['"]/g, '');
			const match = cleaned.match(/['"`](unearth|buyback|evoke|escape|channel)['"`]/i);
			assert.equal(match, null, `Forbidden keyword literal in ${rel}: ${match?.[0]}`);
		}
	});
});
