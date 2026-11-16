import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
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
		id: `p10_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
		typeLine: 'Instant',
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

function createGame(playerCount: 2 | 3 = 2, botMask: boolean[] = []): GameState {
	const seats: LobbySeat[] = Array.from({ length: playerCount }, (_, i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length];
		return {
			seatIndex: i,
			userId: botMask[i] ? null : `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: Boolean(botMask[i]),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: deck.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: deck.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		};
	});
	const decks = new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]]));
	const state = createInitialGameState('TRACKP10', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		if (!p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
	}
	for (const p of state.players) {
		p.hand = [];
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return state;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const ts = allocateTimestamp(state);
	const inst = createCardInstance(card, player.playerId, zone, false, false, ts, state);
	inst.summoningSick = false;
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		...(zone === 'library' ? { insert: 'start' } : {}),
		bumpVersion: true
	});
	return inst;
}

function addMana(player: PlayerGameState, amount = 10): void {
	player.manaPool.W += amount;
	player.manaPool.U += amount;
	player.manaPool.B += amount;
	player.manaPool.R += amount;
	player.manaPool.G += amount;
	player.manaPool.C += amount;
}

function resolveStack(state: GameState, maxSteps = 50): void {
	for (let i = 0; i < maxSteps; i++) {
		const pr = state.pendingPrompts[0];
		const choice = pr?.choice;
		if (
			state.pendingPrompts.length === 1 &&
			pr?.purpose === 'trigger_order' &&
			choice?.kind === 'orderObjects'
		) {
			const orderRes = applyGameAction(state, pr.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'orderObjects', topIds: choice.objectIds }
			});
			assert.equal(orderRes.ok, true, orderRes.error ?? 'trigger_order failed');
			continue;
		}
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const prio = state.players[state.priorityPlayerIndex];
		if (!prio || prio.lost) break;
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? 'pass_priority failed');
	}
}

function advanceToPhase(state: GameState, targetPhase: GameState['phase'], maxSteps = 80): void {
	for (let i = 0; i < maxSteps; i++) {
		if (state.phase === targetPhase && state.stack.length === 0 && state.pendingPrompts.length === 0) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			const choice = pr?.choice;
			if (pr?.purpose === 'trigger_order' && choice?.kind === 'orderObjects') {
				assert.equal(
					applyGameAction(state, pr.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'orderObjects', topIds: choice.objectIds }
					}).ok,
					true
				);
				continue;
			}
			assert.fail(`Unexpected prompt while advancing to ${targetPhase}: ${pr?.title}`);
		}
		const prio = state.players[state.priorityPlayerIndex];
		assert.ok(prio);
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
	}
	assert.equal(state.phase, targetPhase);
}

function assertNoIrInGameState(state: GameState): void {
	const json = JSON.stringify(state);
	// StackItem & PendingReflexiveTrigger must never serialize EffectStep[] or TargetSpec[] IR AST nodes.
	assert.equal(json.includes('"reflexiveTriggerSpec"'), false);
	for (const item of state.stack) {
		assert.equal('steps' in (item as unknown as Record<string, unknown>), false);
		if (item.reflexiveTrigger) {
			assert.equal('effect' in (item.reflexiveTrigger as unknown as Record<string, unknown>), false);
			assert.equal('targets' in (item.reflexiveTrigger as unknown as Record<string, unknown>), false);
		}
	}
}

describe('Track P10 — Slice P10.1: Reflexive Delayed Triggers (CR 603.12, 603.2d) & Optional Chains', () => {
	it('places reflexive trigger as a separate stack item after parent resolves, prompts targets at stack-entry, survives JSON round-trip, and deals LKI power damage', () => {
		let state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 10);

		const fodder = putInZone(
			state,
			p1,
			makeCard({
				name: 'Molten Brute',
				typeLine: 'Creature — Elemental',
				power: '5',
				toughness: '2'
			}),
			'battlefield'
		);
		const oppBear = putInZone(
			state,
			p2,
			makeCard({
				name: 'Grizzly Guard',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '6'
			}),
			'battlefield'
		);
		const flinger = putInZone(
			state,
			p1,
			makeCard({
				name: 'Cinder Hurler',
				manaCost: '{2}{R}',
				typeLine: 'Creature — Goblin Shaman',
				power: '2',
				toughness: '2',
				oracleText:
					"When Cinder Hurler enters, you may sacrifice another creature. When you do, Cinder Hurler deals damage equal to that creature's power to any target."
			}),
			'hand'
		);
		assert.equal(compileCard(flinger.card).fullySupported, true);

		// CR 603.12a: Parent ETB trigger requires NO target when Cinder Hurler resolves!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flinger.instanceId
			}).ok,
			true
		);
		// Resolve Cinder Hurler permanent spell (1 top stack item) -> queues ETB trigger without asking for targets yet.
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].targets.length, 0, 'CR 603.12a: parent ETB trigger has no targets');

		// Start resolving parent ETB trigger -> prompts yesNo for optional sacrifice.
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].choice?.kind, 'yesNo');

		// Round-trip GameState mid-prompt (ENGINE_INVARIANTS §7.1)
		state = JSON.parse(JSON.stringify(state)) as GameState;
		assertNoIrInGameState(state);

		// Accept optional sacrifice (only 1 other creature controlled -> sacrifices Molten Brute immediately)
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.ok(
			state.players[0].graveyard.some((c) => c.instanceId === fodder.instanceId),
			'Molten Brute was sacrificed during parent trigger resolution'
		);

		// Reflexive trigger is now on stack and prompts for `trigger_targets`!
		assert.equal(state.stack.length, 1, 'Reflexive trigger pushed as its own StackItem');
		assert.ok(state.stack[0].reflexiveTrigger, 'StackItem carries plain-JSON CompiledReflexiveTrigger');
		assertNoIrInGameState(state);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].purpose, 'trigger_targets');

		// Round-trip mid reflexive target selection!
		state = JSON.parse(JSON.stringify(state)) as GameState;
		const tgtPrompt = state.pendingPrompts[0];
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: tgtPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [oppBear.instanceId] }
			}).ok,
			true
		);

		resolveStack(state);
		const liveBear = state.players[1].battlefield.find((c) => c.instanceId === oppBear.instanceId);
		assert.ok(liveBear);
		assert.equal(liveBear.damageMarked, 5, 'Reflexive trigger dealt LKI power (5) damage to chosen target');
	});

	it('does NOT double reflexive triggers under Panharmonicon (CR 603.2d) and handles "When you sacrifice an artifact this way" + Otherwise chains', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 15);

		// Panharmonicon on battlefield: doubles ETB triggers, but CR 603.2d says reflexive triggers are NOT caused by entering!
		const panharmonicon = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Resonator',
				typeLine: 'Artifact',
				oracleText:
					'If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(panharmonicon.card).fullySupported, true);

		const clue = putInZone(
			state,
			p1,
			makeCard({ name: 'Scrap Relic', typeLine: 'Artifact' }),
			'battlefield'
		);
		const tinkerer = putInZone(
			state,
			p1,
			makeCard({
				name: 'Vault Tinkerer',
				manaCost: '{2}{R}',
				typeLine: 'Creature — Artificer',
				power: '2',
				toughness: '2',
				oracleText:
					'When Vault Tinkerer enters, you may sacrifice an artifact. When you sacrifice an artifact this way, Vault Tinkerer deals 3 damage to target opponent.'
			}),
			'hand'
		);
		assert.equal(compileCard(tinkerer.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tinkerer.instanceId
			}).ok,
			true
		);
		// Resolve Vault Tinkerer permanent spell -> Panharmonicon doubles the ETB trigger (2 ETB triggers on stack)
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		if (
			state.pendingPrompts[0]?.purpose === 'trigger_order' &&
			state.pendingPrompts[0]?.choice?.kind === 'orderObjects'
		) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: {
						kind: 'orderObjects',
						topIds: state.pendingPrompts[0].choice.objectIds
					}
				}).ok,
				true
			);
		}
		assert.equal(state.stack.length, 2, 'ETB trigger itself triggered twice');

		// Resolve top ETB trigger and sacrifice Scrap Relic (note: Scrap Relic & Synth Resonator both exist -> yesNo then chooseObjects)
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		const firstSacPrompt = state.pendingPrompts[0];
		assert.equal(firstSacPrompt?.choice?.kind, 'yesNo');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: firstSacPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		const secondSacPrompt = state.pendingPrompts[0];
		if (secondSacPrompt?.choice?.kind === 'chooseObjects') {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: secondSacPrompt.id,
					answer: { kind: 'chooseObjects', objectIds: [clue.instanceId] }
				}).ok,
				true
			);
		}

		// Stack now has the remaining 2nd ETB trigger + EXACTLY ONE reflexive trigger (total 2 items, NOT 3!)
		const reflexiveOnStack = state.stack.filter((s) => Boolean(s.reflexiveTrigger));
		assert.equal(
			reflexiveOnStack.length,
			1,
			'CR 603.2d: Panharmonicon must not double the reflexive trigger itself'
		);

		// Resolve reflexive trigger (auto-targeted only opponent p2), then decline 2nd ETB sacrifice
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(p2.life, 37, 'Single reflexive trigger dealt 3 damage');

		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 37);

		// Also verify "You may discard a card. If you do, draw two cards. Otherwise, gain 2 life."
		putInZone(state, p1, makeCard({ name: 'Draw A' }), 'library');
		putInZone(state, p1, makeCard({ name: 'Draw B' }), 'library');
		const optSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Crossroads Insight',
				manaCost: '{1}{R}',
				typeLine: 'Sorcery',
				oracleText: 'You may discard a card. If you do, draw two cards. Otherwise, you gain 2 life.'
			}),
			'hand'
		);
		assert.equal(compileCard(optSpell.card).fullySupported, true);
		// p1 has no other cards in hand besides optSpell -> after casting optSpell, hand is empty so can't discard -> Otherwise branch gains 2 life!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: optSpell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life, 42, 'Otherwise branch executed when optional discard was not performed');
	});
});

describe('Track P10 — Slice P10.2: Mana Spending Restrictions (CR 106.6), Unemptied Mana (CR 106.4), & Quoted Ability Grants', () => {
	it('enforces creature-only mana spending restrictions in cast legality and prioritizes restricted buckets during payment', () => {
		const state = createGame(2);
		const [p1] = state.players;

		const dork = putInZone(
			state,
			p1,
			makeCard({
				name: 'Grove Tender',
				typeLine: 'Creature — Elf Druid',
				power: '1',
				toughness: '2',
				oracleText: '{T}: Add {G}{G}. Spend this mana only to cast creature spells.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(dork.card).fullySupported, true);

		const instantSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Synth Growth',
				manaCost: '{1}{G}',
				typeLine: 'Instant',
				oracleText: 'Draw a card.'
			}),
			'hand'
		);
		const creatureSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Mossback Boar',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Boar',
				power: '2',
				toughness: '2'
			}),
			'hand'
		);

		// Activate Grove Tender -> adds {G}{G} restricted to Creature spells
		const manaAbil = getEffectiveActivatedAbilities(state, p1, dork).find((a) => a.isManaAbility);
		assert.ok(manaAbil);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: dork.instanceId,
				abilityId: manaAbil.id
			}).ok,
			true
		);
		assert.equal(p1.restrictedManaBuckets?.length, 1);

		// Instant spell CANNOT spend the creature-only {G}{G}!
		assert.equal(
			checkSpellCastLegality(state, p1.playerId, instantSpell).ok,
			false,
			'CR 106.6: creature-only mana cannot pay for an Instant spell'
		);

		// Add 1 unrestricted {G} as well -> casting Mossback Boar ({1}{G}) consumes the 2 restricted {G} first, leaving unrestricted {G} intact!
		p1.manaPool.G += 1;
		assert.equal(checkSpellCastLegality(state, p1.playerId, creatureSpell).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: creatureSpell.instanceId
			}).ok,
			true
		);
		assert.equal(
			p1.manaPool.G,
			1,
			'Payment spent the 2 restricted creature-only {G} first and preserved the 1 unrestricted {G}'
		);
		assert.equal(p1.restrictedManaBuckets?.length ?? 0, 0);
	});

	it('retains unemptied mana across step/phase transitions until end of turn (CR 106.4) and supports quoted EOT & token ability grants', () => {
		const state = createGame(2);
		const [p1] = state.players;
		p1.manaPool.R = 2;

		const ritual = putInZone(
			state,
			p1,
			makeCard({
				name: 'Ember Reservoir',
				manaCost: '{1}{R}',
				typeLine: 'Sorcery',
				oracleText:
					"Add {R}{R}{R}. Until end of turn, you don't lose this mana as steps and phases end."
			}),
			'hand'
		);
		assert.equal(compileCard(ritual.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ritual.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.manaPool.R, 3);

		// Advance from main1 -> begin_combat -> main2: {R}{R}{R} is NOT emptied!
		advanceToPhase(state, 'main2');
		assert.equal(p1.manaPool.R, 3, 'CR 106.4: unemptied red mana survives step/phase endings');

		// Also test quoted EOT ability grant and token with quoted activated ability in main2
		addMana(p1, 5);
		putInZone(state, p1, makeCard({ name: 'Top Card' }), 'library');
		const bear = putInZone(
			state,
			p1,
			makeCard({ name: 'Rune Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const boon = putInZone(
			state,
			p1,
			makeCard({
				name: 'Voice of the Grove',
				manaCost: '{1}{G}',
				typeLine: 'Sorcery',
				oracleText: 'Target creature gains "{T}: Draw a card." until end of turn.'
			}),
			'hand'
		);
		const caller = putInZone(
			state,
			p1,
			makeCard({
				name: 'Scion Caller',
				manaCost: '{1}{G}',
				typeLine: 'Creature — Elf Shaman',
				power: '2',
				toughness: '2',
				oracleText:
					'When Scion Caller enters, create a 1/1 colorless Eldrazi Scion creature token with "Sacrifice this creature: Add {C}."'
			}),
			'hand'
		);
		assert.equal(compileCard(boon.card).fullySupported, true);
		assert.equal(compileCard(caller.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boon.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: caller.instanceId
			}).ok,
			true
		);
		resolveStack(state);

		// Rune Bear can tap to draw a card via its quoted EOT ability
		const bearDrawAbil = getEffectiveActivatedAbilities(state, p1, bear).find((a) => !a.isManaAbility);
		assert.ok(bearDrawAbil, 'Rune Bear gained quoted activated ability until EOT');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: bear.instanceId,
				abilityId: bearDrawAbil.id
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, 1);

		// Eldrazi Scion token can sacrifice itself for {C}
		const scion = p1.battlefield.find((c) => c.isToken && c.card.name.includes('Eldrazi Scion'));
		assert.ok(scion, 'Token with quoted ability created');
		const scionMana = getEffectiveActivatedAbilities(state, p1, scion).find((a) => a.isManaAbility);
		assert.ok(scionMana, 'Token has quoted mana ability');
		const cBefore = p1.manaPool.C;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: scion.instanceId,
				abilityId: scionMana.id
			}).ok,
			true
		);
		assert.equal(p1.manaPool.C, cBefore + 1);

		// Advance to next turn's main1 -> unemptied {R} mana clears at end of turn!
		advanceToPhase(state, 'end_step');
		advanceToPhase(state, 'main1');
		assert.equal(p1.manaPool.R, 0, 'Unemptied mana cleared once the turn ended');
	});
});

describe('Track P10 — Slice P10.3: Generalized Attach, Multi-Zone/Opponent Search, Reveal-Until, CopyAbility, & Counter-Exile', () => {
	it('handles generalized attach (CR 701.3 / 613.7e), multi-zone + opponent search, and reveal-until-creature', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const sword = putInZone(
			state,
			p1,
			makeCard({
				name: 'Sunblade',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+2.\nEquip {3}'
			}),
			'battlefield'
		);
		const squire = putInZone(
			state,
			p1,
			makeCard({ name: 'Squire', typeLine: 'Creature — Human Soldier', power: '1', toughness: '2' }),
			'battlefield'
		);
		const snapEquip = putInZone(
			state,
			p1,
			makeCard({
				name: 'Magnetic Grip',
				manaCost: '{W}',
				typeLine: 'Instant',
				oracleText: 'Attach target Equipment you control to target creature you control.'
			}),
			'hand'
		);
		assert.equal(compileCard(snapEquip.card).fullySupported, true);

		const prevTs = sword.enteredTimestamp ?? 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: snapEquip.instanceId,
				targets: [
					{ kind: 'permanent', id: sword.instanceId, label: sword.card.name },
					{ kind: 'permanent', id: squire.instanceId, label: squire.card.name }
				]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(sword.attachedToId, squire.instanceId);
		assert.ok((sword.enteredTimestamp ?? 0) > prevTs, 'CR 613.7e: Equipment receives new timestamp on attach');
		assert.equal(evaluatePermanent(state, squire).power, 3);

		// Opponent library search ("Search target opponent's library for up to three creature cards and put them into their graveyard. Then that player shuffles.")
		const oppC1 = putInZone(
			state,
			p2,
			makeCard({ name: 'Opp Beast 1', typeLine: 'Creature — Beast', power: '3', toughness: '3' }),
			'library'
		);
		const oppC2 = putInZone(
			state,
			p2,
			makeCard({ name: 'Opp Beast 2', typeLine: 'Creature — Beast', power: '4', toughness: '4' }),
			'library'
		);
		const extract = putInZone(
			state,
			p1,
			makeCard({
				name: 'Grim Extraction',
				manaCost: '{2}{B}',
				typeLine: 'Sorcery',
				oracleText:
					"Search target opponent's library for up to three creature cards and put them into their graveyard. Then that player shuffles."
			}),
			'hand'
		);
		assert.equal(compileCard(extract.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: extract.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [oppC1.instanceId, oppC2.instanceId] }
				}).ok,
				true
			);
		}
		resolveStack(state);
		assert.ok(p2.graveyard.some((c) => c.instanceId === oppC1.instanceId));
		assert.ok(p2.graveyard.some((c) => c.instanceId === oppC2.instanceId));

		// Reveal until creature card -> hand, rest on bottom in random order
		p1.library = [];
		const hitElf = putInZone(
			state,
			p1,
			makeCard({ name: 'Deepwood Tracker', typeLine: 'Creature — Elf', power: '2', toughness: '2' }),
			'library'
		);
		const skippedLand1 = putInZone(
			state,
			p1,
			makeCard({ name: 'Forest One', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0 }),
			'library'
		);
		const skippedLand2 = putInZone(
			state,
			p1,
			makeCard({ name: 'Forest Two', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0 }),
			'library'
		);
		const digCreature = putInZone(
			state,
			p1,
			makeCard({
				name: 'Call of the Canopy',
				manaCost: '{1}{G}',
				typeLine: 'Sorcery',
				oracleText:
					'Reveal cards from the top of your library until you reveal a creature card. Put that card into your hand and the rest on the bottom of your library in a random order.'
			}),
			'hand'
		);
		assert.equal(compileCard(digCreature.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: digCreature.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(p1.hand.some((c) => c.instanceId === hitElf.instanceId), 'Revealed creature put into hand');
		assert.equal(p1.library.length, 2, 'Skipped lands put on bottom of library');
		assert.ok(p1.library.some((c) => c.instanceId === skippedLand1.instanceId));
		assert.ok(p1.library.some((c) => c.instanceId === skippedLand2.instanceId));
	});

	it('counters spells into exile (CR 614.15) and copies abilities from colorless sources (CR 707.10)', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 15);
		addMana(p2, 15);

		const oppSpell = putInZone(
			state,
			p2,
			makeCard({
				name: 'Arcane Surge',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: 'Draw two cards.'
			}),
			'hand'
		);
		const dissipate = putInZone(
			state,
			p1,
			makeCard({
				name: 'Void Scatter',
				manaCost: '{1}{U}{U}',
				typeLine: 'Instant',
				oracleText:
					"Counter target spell. If that spell is countered this way, exile it instead of putting it into its owner's graveyard."
			}),
			'hand'
		);
		assert.equal(compileCard(dissipate.card).fullySupported, true);

		// Pass priority to p2 -> p2 casts Arcane Surge -> p1 counters with Void Scatter
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppSpell.instanceId
			}).ok,
			true
		);
		const oppStackId = state.stack[0].id;
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: dissipate.instanceId,
				targets: [{ kind: 'stack', id: oppStackId, label: oppSpell.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(
			p2.exile.some((c) => c.instanceId === oppSpell.instanceId),
			'CR 614.15: countered spell was exiled instead of going to graveyard'
		);
		assert.equal(p2.graveyard.some((c) => c.instanceId === oppSpell.instanceId), false);

		// Copy target activated or triggered ability you control from a colorless source
		const rod = putInZone(
			state,
			p1,
			makeCard({
				name: 'Blasting Rod',
				typeLine: 'Artifact',
				oracleText: '{1}, {T}: Blasting Rod deals 2 damage to any target.'
			}),
			'battlefield'
		);
		const resonator = putInZone(
			state,
			p1,
			makeCard({
				name: 'Echo Fork',
				manaCost: '{2}',
				typeLine: 'Instant',
				oracleText:
					'Copy target activated or triggered ability you control from a colorless source. You may choose new targets for the copy.'
			}),
			'hand'
		);
		assert.equal(compileCard(resonator.card).fullySupported, true);

		const rodAbil = getEffectiveActivatedAbilities(state, p1, rod).find((a) => !a.isManaAbility);
		assert.ok(rodAbil);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: rod.instanceId,
				abilityId: rodAbil.id,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		const rodStackId = state.stack[0].id;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: resonator.instanceId,
				targets: [{ kind: 'stack', id: rodStackId, label: rod.card.name }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		// Decline changing targets so the copy also hits p2!
		if (state.pendingPrompts[0]?.choice?.kind === 'yesNo') {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: false }
				}).ok,
				true
			);
		}
		resolveStack(state);
		assert.equal(p2.life, 36, 'Original ability + copied ability both dealt 2 damage (4 total)');
	});
});

describe('Track P10 — Slice P10.4: CR 701 Keyword Actions (Discover, Clash, Detain, Suspect, Evidence, Forage, Endure, Time Travel, Blight, Fateseal) & Coin/Die Tables', () => {
	it('executes Discover N (CR 701.57a): casts free on accept and puts hit card into HAND (not exile) on decline', () => {
		let state = createGame(2);
		const [p1] = state.players;
		addMana(p1, 15);
		p1.library = [];

		// Library top-to-bottom: 6-MV colossus (skipped), Land (skipped), 2-MV bear (hit!)
		const hitBear = putInZone(
			state,
			p1,
			makeCard({
				name: 'Sunlit Cub',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'library'
		);
		const skippedLand = putInZone(
			state,
			p1,
			makeCard({ name: 'Plains Skip', typeLine: 'Basic Land — Plains', manaCost: '', cmc: 0 }),
			'library'
		);
		const skippedColossus = putInZone(
			state,
			p1,
			makeCard({
				name: 'Dread Colossus',
				manaCost: '{6}',
				cmc: 6,
				typeLine: 'Creature — Giant',
				power: '6',
				toughness: '6'
			}),
			'library'
		);

		const discoverSpell1 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Delve the Caverns',
				manaCost: '{2}{G}',
				typeLine: 'Sorcery',
				oracleText: 'Discover 3.'
			}),
			'hand'
		);
		const discoverSpell2 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Second Expedition',
				manaCost: '{2}{G}',
				typeLine: 'Sorcery',
				oracleText: 'Discover 3.'
			}),
			'hand'
		);
		assert.equal(compileCard(discoverSpell1.card).fullySupported, true);

		// 1) Cast Delve the Caverns and DECLINE free cast -> Sunlit Cub goes to HAND!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: discoverSpell1.instanceId
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(state.pendingPrompts[0].choice?.kind, 'yesNo');

		// Round-trip mid-Discover prompt!
		state = JSON.parse(JSON.stringify(state)) as GameState;
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(
			state.players[0].hand.some((c) => c.instanceId === hitBear.instanceId),
			'CR 701.57a: declining Discover free-cast puts the card into hand (unlike Cascade)'
		);
		assert.equal(state.players[0].exile.length, 0, 'Skipped cards returned to bottom of library');
		assert.equal(state.players[0].library.length, 2);
		assert.ok(state.players[0].library.some((c) => c.instanceId === skippedLand.instanceId));
		assert.ok(state.players[0].library.some((c) => c.instanceId === skippedColossus.instanceId));

		// 2) Put a 3-MV spell on top of library, cast Second Expedition, ACCEPT free cast -> enters battlefield!
		const freeKnight = putInZone(
			state,
			state.players[0],
			makeCard({
				name: 'Cave Paladin',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Creature — Human Knight',
				power: '3',
				toughness: '3'
			}),
			'library'
		);
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'cast_spell',
				instanceId: discoverSpell2.instanceId
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, state.players[0].playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		resolveStack(state);
		assert.ok(
			state.players[0].battlefield.some((c) => c.instanceId === freeKnight.instanceId),
			'Accepting Discover cast Cave Paladin onto the stack and resolved it onto the battlefield'
		);
	});

	it('enforces Detain (CR 701.35a blocking mana abilities until your next turn) and Suspect (CR 701.60 menace + cantBlock)', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 15);

		const oppElf = putInZone(
			state,
			p2,
			makeCard({
				name: 'Opp Mana Elf',
				typeLine: 'Creature — Elf Druid',
				power: '1',
				toughness: '2',
				oracleText: '{T}: Add {G}.'
			}),
			'battlefield'
		);
		const myRogue = putInZone(
			state,
			p1,
			makeCard({
				name: 'Alley Cutthroat',
				typeLine: 'Creature — Human Rogue',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const detainAndSuspect = putInZone(
			state,
			p1,
			makeCard({
				name: 'Precinct Sweep',
				manaCost: '{1}{W}{U}',
				typeLine: 'Sorcery',
				oracleText: 'Detain target permanent an opponent controls. Suspect target creature you control.'
			}),
			'hand'
		);
		assert.equal(compileCard(detainAndSuspect.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: detainAndSuspect.instanceId,
				targets: [
					{ kind: 'permanent', id: oppElf.instanceId, label: oppElf.card.name },
					{ kind: 'permanent', id: myRogue.instanceId, label: myRogue.card.name }
				]
			}).ok,
			true
		);
		resolveStack(state);

		// Suspect grants Menace in Layer 6 and prevents blocking (CR 701.60c)
		assert.equal(hasKeyword(myRogue, 'menace', state), true, 'CR 701.60c: suspected creature has menace');
		assert.equal(myRogue.isSuspected, true, 'CR 701.60a: creature has suspected designation');

		// Detain prevents Opp Mana Elf from activating its {T}: Add {G} mana ability!
		const elfMana = getEffectiveActivatedAbilities(state, p2, oppElf).find((a) => a.isManaAbility);
		assert.ok(elfMana);
		// Pass priority to p2 so p2 has priority to try activating a mana ability
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		const illegalManaAct = applyGameAction(state, p2.playerId, {
			type: 'activate_ability',
			instanceId: oppElf.instanceId,
			abilityId: elfMana.id
		});
		assert.equal(
			illegalManaAct.ok,
			false,
			'CR 701.35a: detained permanent cannot activate even mana abilities!'
		);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

		// Advance to declare_attackers -> Alley Cutthroat attacks -> Opp Mana Elf cannot block (detained)!
		if (state.phase !== 'declare_attackers') {
			advanceToPhase(state, 'declare_attackers');
		}
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: myRogue.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advanceToPhase(state, 'declare_blockers');
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: oppElf.instanceId, attackerInstanceId: myRogue.instanceId }]
			}).ok,
			false,
			'Detained creature cannot block'
		);

		// Advance to p2's turn -> Opp Mana Elf STILL detained during p2's turn, AND suspected Alley Cutthroat cannot block!
		const p2Bear = putInZone(
			state,
			p2,
			makeCard({ name: 'Opp Raider', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		advanceToPhase(state, 'end_step');
		advanceToPhase(state, 'main1');
		assert.equal(state.activePlayerIndex, 1);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: oppElf.instanceId,
				abilityId: elfMana.id
			}).ok,
			false,
			"Still detained during opponent's turn before detainer's next turn"
		);
		myRogue.tapped = false;
		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: p2Bear.instanceId, defenderPlayerId: p1.playerId }]
			}).ok,
			true
		);
		advanceToPhase(state, 'declare_blockers');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: myRogue.instanceId, attackerInstanceId: p2Bear.instanceId }]
			}).ok,
			false,
			"CR 701.60c: suspected creature can't block"
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_blockers',
				assignments: []
			}).ok,
			true
		);

		// Advance to p1's next turn -> Detain expires at start of p1's turn!
		advanceToPhase(state, 'end_step');
		advanceToPhase(state, 'main1');
		assert.equal(state.activePlayerIndex, 0);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: oppElf.instanceId,
				abilityId: elfMana.id
			}).ok,
			true,
			"CR 701.35a: detain expired at start of detainer's next turn"
		);
	});

	it('executes Endure N (CR 701.63a choice + CR 701.63b LTB Spirit fallback when permanent dies in response!)', () => {
		const state = createGame(2);
		const [p1] = state.players;
		addMana(p1, 20);

		const monk1 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Abzan Devotee',
				manaCost: '{2}{W}',
				typeLine: 'Creature — Human Monk',
				power: '2',
				toughness: '2',
				oracleText: 'When Abzan Devotee enters, it endures 3.'
			}),
			'hand'
		);
		const monk2 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Second Devotee',
				manaCost: '{2}{W}',
				typeLine: 'Creature — Human Monk',
				power: '2',
				toughness: '2',
				oracleText: 'When Second Devotee enters, it endures 3.'
			}),
			'hand'
		);
		const killInstant = putInZone(
			state,
			p1,
			makeCard({
				name: 'Instant Doom',
				manaCost: '{B}',
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		assert.equal(compileCard(monk1.card).fullySupported, true);

		// Case A: Abzan Devotee stays on battlefield -> choose +1/+1 counters (mode 0)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: monk1.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseMode');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [0] }
			}).ok,
			true
		);
		resolveStack(state);
		const liveMonk1 = p1.battlefield.find((c) => c.card.name === 'Abzan Devotee');
		assert.ok(liveMonk1);
		assert.equal(liveMonk1.counters['+1/+1'], 3);
		assert.equal(evaluatePermanent(state, liveMonk1).power, 5);

		// Case B (CR 701.63b): Cast Second Devotee, resolve creature -> ETB endure 3 on stack -> kill Second Devotee in response!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: monk2.instanceId
			}).ok,
			true
		);
		// Resolve creature spell so ETB trigger is placed on stack
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.stack.length, 1);
		const liveMonk2 = p1.battlefield.find((c) => c.card.name === 'Second Devotee');
		assert.ok(liveMonk2);

		// Destroy Second Devotee while its Endure 3 trigger is on the stack!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: killInstant.instanceId,
				targets: [{ kind: 'permanent', id: liveMonk2.instanceId, label: liveMonk2.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		const spiritToken = p1.battlefield.find((c) => c.isToken && c.card.name === 'Spirit');
		assert.ok(
			spiritToken,
			'CR 701.63b: enduring permanent left battlefield before resolution -> automatically created 3/3 white Spirit token!'
		);
		assert.equal(evaluatePermanent(state, spiritToken).power, 3);
		assert.equal(evaluatePermanent(state, spiritToken).toughness, 3);
	});

	it('executes Clash, Collect evidence, Forage, Time travel, Blight, Fateseal, Coin Flip & d20 Die-Roll Tables', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 30);

		// 1) Clash (p1 top MV 5 > p2 top MV 1 -> p1 wins clash and draws a card!)
		p1.library = [];
		p2.library = [];
		putInZone(state, p1, makeCard({ name: 'Prize Draw', manaCost: '{1}', cmc: 1 }), 'library');
		const p1ClashTop = putInZone(
			state,
			p1,
			makeCard({ name: 'Titan Top', manaCost: '{5}', cmc: 5 }),
			'library'
		);
		putInZone(state, p2, makeCard({ name: 'Tiny Top', manaCost: '{1}', cmc: 1 }), 'library');
		const clashSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Trial of Wits',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: 'Clash with an opponent. If you win, draw a card.'
			}),
			'hand'
		);
		assert.equal(compileCard(clashSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: clashSpell.instanceId
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		// Both human players choose whether to put revealed card on bottom (p1 puts Titan Top on bottom -> draws Prize Draw!)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.hand.length, 1, 'Won clash -> drew a card');
		assert.equal(p1.library[p1.library.length - 1].instanceId, p1ClashTop.instanceId);

		// 2) Time travel (suspended card in exile + permanent with time counter on board)
		const rift = putInZone(
			state,
			p1,
			makeCard({ name: 'Chrono Obelisk', typeLine: 'Artifact' }),
			'battlefield'
		);
		rift.counters.time = 2;
		const suspended = putInZone(
			state,
			p1,
			makeCard({ name: 'Future Behemoth', typeLine: 'Creature — Beast', power: '6', toughness: '6' }),
			'exile'
		);
		suspended.counters.time = 2;
		suspended.isSuspended = true;

		const timeTravelSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Shift the Warp',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: 'Time travel.'
			}),
			'hand'
		);
		assert.equal(compileCard(timeTravelSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: timeTravelSpell.instanceId
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		// Add 1 time counter to Chrono Obelisk (mode 0), remove 1 time counter from Future Behemoth (mode 1)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [0] }
			}).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [1] }
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(rift.counters.time, 3);
		assert.equal(suspended.counters.time, 1);

		// 3) Blight 2 & Fateseal 2
		const sturdyOx = putInZone(
			state,
			p1,
			makeCard({ name: 'Sturdy Ox', typeLine: 'Creature — Ox', power: '3', toughness: '5' }),
			'battlefield'
		);
		p2.library = [];
		const oppCardA = putInZone(state, p2, makeCard({ name: 'Opp Draw A' }), 'library');
		const oppCardB = putInZone(state, p2, makeCard({ name: 'Opp Draw B' }), 'library'); // top of p2 library
		const blightFateseal = putInZone(
			state,
			p1,
			makeCard({
				name: 'Omen of Wither',
				manaCost: '{1}{B}',
				typeLine: 'Sorcery',
				oracleText: 'Blight 2. Fateseal 2.'
			}),
			'hand'
		);
		assert.equal(compileCard(blightFateseal.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: blightFateseal.instanceId
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		// Sturdy Ox is only creature -> Blight 2 auto-targets it, then Fateseal 2 prompts orderObjects!
		assert.equal(sturdyOx.counters['-1/-1'], 2);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'orderObjects');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: {
					kind: 'orderObjects',
					topIds: [oppCardA.instanceId],
					bottomIds: [oppCardB.instanceId]
				}
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.library[0].instanceId, oppCardA.instanceId);
		assert.equal(p2.library[p2.library.length - 1].instanceId, oppCardB.instanceId);

		// 4) d20 Die-Roll Result Table & N-sided die token creation
		for (let i = 0; i < 4; i++) {
			putInZone(state, p1, makeCard({ name: `Deck Filler ${i}` }), 'library');
		}
		const d20Spell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Arcane Gambit',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: 'Roll a d20.\n1—9 | Draw a card.\n10—20 | Draw two cards.'
			}),
			'hand'
		);
		const d6GoblinSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Goblin Dice',
				manaCost: '{2}{R}',
				typeLine: 'Sorcery',
				oracleText:
					'Roll a six-sided die. Create a number of 1/1 red Goblin creature tokens equal to the result.'
			}),
			'hand'
		);
		assert.equal(compileCard(d20Spell.card).fullySupported, true);
		assert.equal(compileCard(d6GoblinSpell.card).fullySupported, true);

		const handBeforeRoll = p1.hand.length - 2; // minus the 2 spells we're about to cast
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: d20Spell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		const drawn = p1.hand.length - (handBeforeRoll + 1);
		assert.ok(drawn === 1 || drawn === 2, `d20 table drew ${drawn} card(s)`);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: d6GoblinSpell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		const goblins = p1.battlefield.filter(
			(c) => c.isToken && evaluatePermanent(state, c).hasSubType('Goblin')
		);
		assert.ok(goblins.length >= 1 && goblins.length <= 6, `d6 created ${goblins.length} Goblin tokens`);
	});
});

describe('Track P10 — Slice P10.5: Trigger Heads (Graveyard Batch, Crime, Expend, Combat) & Conditions (Descend Token Rule, LKI Counters)', () => {
	it('fires graveyardLeaveBatch ONCE for multi-card Forage/Collect evidence (CR 603.10a), tracks Crime (CR 700.13) & Expend 4 (CR 700.14)', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 20);

		const watcher = putInZone(
			state,
			p1,
			makeCard({
				name: 'Crypt Chronicler',
				typeLine: 'Creature — Warlock',
				power: '2',
				toughness: '3',
				oracleText:
					'Whenever one or more cards leave your graveyard, you gain 2 life.\nWhenever you commit a crime, each opponent loses 1 life.\nWhenever you expend 4, draw a card.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(watcher.card).fullySupported, true);

		putInZone(state, p1, makeCard({ name: 'Expend Draw' }), 'library');
		putInZone(state, p1, makeCard({ name: 'GY Card 1', manaCost: '{2}', cmc: 2 }), 'graveyard');
		putInZone(state, p1, makeCard({ name: 'GY Card 2', manaCost: '{2}', cmc: 2 }), 'graveyard');
		putInZone(state, p1, makeCard({ name: 'GY Card 3', manaCost: '{2}', cmc: 2 }), 'graveyard');

		// Spell 1 costs {3}{B} (= 4 mana spent!) AND targets opponent's graveyard or opponent -> triggers Crime AND Expend 4, and Forages 3 GY cards -> triggers graveyardLeaveBatch ONCE!
		const crimeForageSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Bramble Shakedown',
				manaCost: '{3}{B}',
				cmc: 4,
				typeLine: 'Sorcery',
				oracleText: 'Target opponent loses 2 life. Forage.'
			}),
			'hand'
		);
		assert.equal(compileCard(crimeForageSpell.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: crimeForageSpell.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		resolveStack(state);

		assert.equal(
			p1.life,
			42,
			'CR 603.10a: exiling 3 cards simultaneously via Forage triggered "one or more cards leave your graveyard" ONCE (+2 life, not +6)'
		);
		assert.equal(p2.life, 37, 'Crime trigger (-1) + spell effect (-2) = 37 life');
		assert.equal(p1.hand.length, 1, 'CR 700.14: spending 4 mana on spells triggered Expend 4 once');
	});

	it('enforces CR 700.11 Descend (permanent tokens dying do NOT descend; nontoken permanent cards DO) and combat / LKI counter triggers', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		addMana(p1, 20);

		// Create a 1/1 token and sacrifice/destroy it -> must NOT count as descending!
		const tokenMaker = putInZone(
			state,
			p1,
			makeCard({
				name: 'Make Wisp',
				manaCost: '{W}',
				typeLine: 'Sorcery',
				oracleText: 'Create a 1/1 white Spirit creature token.'
			}),
			'hand'
		);
		const ping1 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Zap Token',
				manaCost: '{R}',
				typeLine: 'Instant',
				oracleText: 'Zap Token deals 1 damage to any target.'
			}),
			'hand'
		);
		const descendCheck1 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Echo of the Deep',
				manaCost: '{1}{B}',
				typeLine: 'Sorcery',
				oracleText: 'If you descended this turn, you gain 5 life.'
			}),
			'hand'
		);
		assert.equal(compileCard(descendCheck1.card).fullySupported, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: tokenMaker.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		const token = p1.battlefield.find((c) => c.isToken)!;
		assert.ok(token);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: ping1.instanceId,
				targets: [{ kind: 'permanent', id: token.instanceId, label: token.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.descendedThisTurn ?? false, false, 'CR 700.11: Creature token dying is NOT a permanent card');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: descendCheck1.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life, 40, 'Descend condition remained false after only a token died');

		// Now put a real nontoken Creature with a +1/+1 counter on board, plus an LKI counter death watcher, and kill it!
		const realCreature = putInZone(
			state,
			p1,
			makeCard({ name: 'Marked Squire', typeLine: 'Creature — Human', power: '1', toughness: '1' }),
			'battlefield'
		);
		realCreature.counters['+1/+1'] = 1;
		const counterDeathWatcher = putInZone(
			state,
			p1,
			makeCard({
				name: 'Relic Watcher',
				typeLine: 'Creature — Cleric',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever another creature you control dies, if it had a +1/+1 counter on it, you gain 3 life.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(counterDeathWatcher.card).fullySupported, true);

		const killMarked = putInZone(
			state,
			p1,
			makeCard({
				name: 'Fell Strike',
				manaCost: '{1}{B}',
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		const descendCheck2 = putInZone(
			state,
			p1,
			makeCard({
				name: 'Second Echo',
				manaCost: '{1}{B}',
				typeLine: 'Sorcery',
				oracleText: 'If you descended this turn, you gain 5 life.'
			}),
			'hand'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: killMarked.instanceId,
				targets: [{ kind: 'permanent', id: realCreature.instanceId, label: realCreature.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life, 43, 'LKI +1/+1 counter death trigger fired (+3 life)');
		assert.equal(p1.descendedThisTurn, true, 'CR 700.11: nontoken permanent card entering graveyard sets descendedThisTurn');

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: descendCheck2.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p1.life, 48, 'Descend condition succeeded (+5 life)');

		// Also verify CR 509.1h "Whenever ~ attacks and isn't blocked"
		const unblockedRogue = putInZone(
			state,
			p1,
			makeCard({
				name: 'Shadow Stalker',
				typeLine: 'Creature — Rogue',
				power: '2',
				toughness: '2',
				oracleText: "Whenever Shadow Stalker attacks and isn't blocked, target opponent loses 2 life."
			}),
			'battlefield'
		);
		assert.equal(compileCard(unblockedRogue.card).fullySupported, true);

		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: unblockedRogue.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		advanceToPhase(state, 'declare_blockers');
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: []
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 38, 'CR 509.1h: attacks-and-unblocked trigger dealt 2 life loss during declare_blockers');
	});

	it('supports Collect evidence N, Coin Flips, Battalion, becomesUntapped, manaColorSpentToCast, and opponentComparison', () => {
		const state = createGame(2);
		const [p1, p2] = state.players;
		p1.manaPool.R = 5;
		p1.manaPool.W = 5;
		p1.manaPool.U = 5;

		// Opponent controls 2 lands while p1 controls 0 lands -> opponentComparison ('lands') is true!
		putInZone(state, p2, makeCard({ name: 'Opp Plains 1', typeLine: 'Basic Land — Plains', manaCost: '', cmc: 0 }), 'battlefield');
		putInZone(state, p2, makeCard({ name: 'Opp Plains 2', typeLine: 'Basic Land — Plains', manaCost: '', cmc: 0 }), 'battlefield');

		// Collect evidence 4 + opponentComparison
		const gy3 = putInZone(state, p1, makeCard({ name: 'Clue Three', manaCost: '{3}', cmc: 3 }), 'graveyard');
		const gy2 = putInZone(state, p1, makeCard({ name: 'Clue Two', manaCost: '{2}', cmc: 2 }), 'graveyard');
		const evidenceSpell = putInZone(
			state,
			p1,
			makeCard({
				name: 'Case File Sweep',
				manaCost: '{1}{W}',
				typeLine: 'Sorcery',
				oracleText: 'Collect evidence 4. If an opponent controls more lands than you, you gain 4 life.'
			}),
			'hand'
		);
		assert.equal(compileCard(evidenceSpell.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: evidenceSpell.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [gy3.instanceId, gy2.instanceId] }
				}).ok,
				true
			);
		}
		resolveStack(state);
		assert.ok(p1.exile.some((c) => c.instanceId === gy3.instanceId));
		assert.ok(p1.exile.some((c) => c.instanceId === gy2.instanceId));
		assert.equal(p1.life, 44, 'opponentComparison (more lands) granted 4 life');

		// manaColorSpentToCast ({R} spent to cast creature) + Coin flip + becomesUntapped + Battalion
		const flameKnight = putInZone(
			state,
			p1,
			makeCard({
				name: 'Cinder Cavalier',
				manaCost: '{1}{R}',
				typeLine: 'Creature — Human Knight',
				power: '2',
				toughness: '2',
				oracleText: 'When Cinder Cavalier enters, if {R} was spent to cast it, Cinder Cavalier deals 2 damage to each opponent.'
			}),
			'hand'
		);
		assert.equal(compileCard(flameKnight.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flameKnight.instanceId
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 38, 'manaColorSpentToCast ({R}) ETB trigger dealt 2 damage');

		const liveCavalier = p1.battlefield.find((c) => c.card.name === 'Cinder Cavalier')!;
		liveCavalier.summoningSick = false;

		const untapSeer = putInZone(
			state,
			p1,
			makeCard({
				name: 'Wakeful Seer',
				typeLine: 'Creature — Merfolk Wizard',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever Wakeful Seer becomes untapped, you gain 1 life.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(untapSeer.card).fullySupported, true);
		untapSeer.tapped = true;

		const twiddle = putInZone(
			state,
			p1,
			makeCard({
				name: 'Quick Untap',
				manaCost: '{U}',
				typeLine: 'Instant',
				oracleText: 'Untap target creature. Flip a coin. If you win the flip, you gain 2 life.'
			}),
			'hand'
		);
		assert.equal(compileCard(twiddle.card).fullySupported, true);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: twiddle.instanceId,
				targets: [{ kind: 'permanent', id: untapSeer.instanceId, label: untapSeer.card.name }]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(untapSeer.tapped, false);
		const lifeAfterUntap: number = p1.life;
		assert.ok(
			lifeAfterUntap === 45 || lifeAfterUntap === 47,
			`becomesUntapped (+1) + coin flip (+0 or +2) -> ${lifeAfterUntap}`
		);

		// Battalion: "Whenever Legion Captain and at least two other creatures attack, each opponent loses 2 life."
		const captain = putInZone(
			state,
			p1,
			makeCard({
				name: 'Legion Captain',
				typeLine: 'Creature — Human Soldier',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever Legion Captain and at least two other creatures attack, each opponent loses 2 life.'
			}),
			'battlefield'
		);
		assert.equal(compileCard(captain.card).fullySupported, true);

		advanceToPhase(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: captain.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: liveCavalier.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: untapSeer.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		resolveStack(state);
		assert.equal(p2.life, 36, 'Battalion trigger fired when 3 creatures attacked together (-2 life)');
	});
});

describe('Track P10 — Synthetic Card Rename-Invariance (ENGINE_INVARIANTS §1.3)', () => {
	it('produces identical IR and identical runtime behavior when renaming a card to "Glimmerfen Overseer"', () => {
		const canonical = makeCard({
			name: 'Heartfire Immolator',
			manaCost: '{1}{R}',
			typeLine: 'Creature — Human Wizard',
			power: '2',
			toughness: '2',
			oracleText:
				"When Heartfire Immolator enters, you may sacrifice another creature. When you do, Heartfire Immolator deals damage equal to that creature's power to target opponent."
		});
		const synthetic = makeCard({
			name: 'Glimmerfen Overseer',
			manaCost: '{1}{R}',
			typeLine: 'Creature — Human Wizard',
			power: '2',
			toughness: '2',
			oracleText:
				"When Glimmerfen Overseer enters, you may sacrifice another creature. When you do, Glimmerfen Overseer deals damage equal to that creature's power to target opponent."
		});

		const defA = compileCard(canonical);
		const defB = compileCard(synthetic);
		assert.equal(defA.fullySupported, true);
		assert.equal(defB.fullySupported, true);

		const stripMeta = (obj: unknown): unknown =>
			JSON.parse(
				JSON.stringify(obj, (key, val) =>
					key === 'span' || key === 'text' || key === 'name' || key === 'textHash' ? undefined : val
				)
			);
		assert.deepEqual(stripMeta(defA.faces[0].abilities), stripMeta(defB.faces[0].abilities));

		const runScenario = (cardToCast: ScryfallCard): number => {
			const st = createGame(2);
			const [pl1, pl2] = st.players;
			addMana(pl1, 10);
			putInZone(
				st,
				pl1,
				makeCard({ name: 'Synth Boar', typeLine: 'Creature — Boar', power: '4', toughness: '2' }),
				'battlefield'
			);
			const caster = putInZone(st, pl1, cardToCast, 'hand');
			assert.equal(applyGameAction(st, pl1.playerId, { type: 'cast_spell', instanceId: caster.instanceId }).ok, true);
			resolveStack(st);
			assert.equal(
				applyGameAction(st, pl1.playerId, {
					type: 'choice',
					promptId: st.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveStack(st);
			return pl2.life;
		};

		assert.equal(runScenario(canonical), 36);
		assert.equal(runScenario(synthetic), 36);
	});
});
