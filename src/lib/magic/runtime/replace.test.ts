import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	addCountersToPermanent,
	applyGameAction,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	drawCards,
	playerHasHexproofFrom as enginePlayerHasHexproofFrom,
	playerHasShroud as enginePlayerHasShroud
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	checkGlobalCastPermissionsAndRestrictions as ruleTreeCastRules,
	getLibrarySearchInterceptor as ruleTreeSearchInterceptor,
	playerCannotLoseGame as ruleTreeCannotLose,
	playerCannotWinGame as ruleTreeCannotWin,
	resolveZoneChangeReplacements as ruleTreeGraveyardZone
} from '../ruleTree.ts';
import { DEFAULT_LOBBY_RULES, type CardInstance, type GameState, type LobbySeat, type ScryfallCard } from '../types.ts';
import { allocateTimestamp } from './zones.ts';
import {
	activeRuleModifiers,
	applicableReplacements,
	applySelfEtbReplacements,
	cardEntersTapped,
	checkGlobalCastPermissionsAndRestrictions,
	counterMultiplier,
	getAttackTaxGeneric,
	getLibrarySearchInterceptor,
	hasRestriction,
	playerCannotLoseGame,
	playerCannotWinGame,
	playerHasHexproofFrom,
	playerHasNoMaxHandSize,
	playerHasShroud,
	replaceEmptyLibraryDraw,
	resolveZoneChangeReplacements,
	spellCannotBeCountered,
	tokenMultiplier,
	triggerMultiplier
} from './replace.ts';

/**
 * Steps C+D: triggered abilities use the stack. Resolves the triggered abilities on top of the stack
 * (not the spells under them) by passing priority, keeping the default order for order prompts and
 * answering "you may" with yes.
 */
function resolveTriggers(state: GameState, max = 40): void {
	for (let i = 0; i < max; i++) {
		const prompt = state.pendingPrompts[0];
		if (prompt?.purpose === 'trigger_order' && prompt.choice?.kind === 'orderObjects') {
			applyGameAction(state, prompt.playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'orderObjects', topIds: prompt.choice.objectIds, bottomIds: [], shuffle: false } });
			continue;
		}
		if (prompt?.purpose === 'trigger_may') {
			applyGameAction(state, prompt.playerId, { type: 'choice', promptId: prompt.id, answer: { kind: 'yesNo', yes: true } });
			continue;
		}
		if (prompt) return;
		const top = state.stack[state.stack.length - 1];
		if (!top || top.kind !== 'triggered') return;
		const prio = state.players[state.priorityPlayerIndex];
		if (!applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok) return;
	}
}

function getCardByName(name: string): ScryfallCard | undefined {
	const low = name.toLowerCase();
	if (STAPLE_CARDS[low]) return STAPLE_CARDS[low];
	for (const deck of PRECON_DECKS) {
		for (const c of deck.commanders) {
			if (c.name.toLowerCase() === low) return c;
		}
		for (const entry of deck.cards) {
			if (entry.card.name.toLowerCase() === low) return entry.card;
		}
	}
	return undefined;
}

function synthCard(overrides: Partial<ScryfallCard> & { name: string; oracleText: string }): ScryfallCard {
	const nameSlug = overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
	return {
		id: overrides.id ?? `synth_${nameSlug}`,
		oracleId: overrides.oracleId ?? `oracle_${nameSlug}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{2}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Enchantment',
		oracleText: overrides.oracleText,
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		legalCommander: false,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function twoPlayerState(): { state: GameState; p1Id: string; p2Id: string } {
	const seats: LobbySeat[] = [0, 1].map((i) => ({
		seatIndex: i,
		userId: `player_${i + 1}`,
		username: `Player ${i + 1}`,
		avatarUrl: '',
		isBot: false,
		deckId: PRECON_DECKS[i].id,
		deckName: PRECON_DECKS[i].name,
		commanderNames: PRECON_DECKS[i].commanders.map((c) => c.name),
		commanderArtUrl: PRECON_DECKS[i].commanders[0]?.artCropUrl ?? '',
		colorIdentity: PRECON_DECKS[i].colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	}));
	const decksBySeat = new Map([
		[0, PRECON_DECKS[0]],
		[1, PRECON_DECKS[1]]
	]);
	const state = createInitialGameState('test_replace', seats, decksBySeat, { ...DEFAULT_LOBBY_RULES });
	applyGameAction(state, state.players[0].playerId, { type: 'mulligan_keep' });
	applyGameAction(state, state.players[1].playerId, { type: 'mulligan_keep' });
	for (const p of state.players) {
		p.battlefield = [];
		p.hand = [];
		p.graveyard = [];
		p.exile = [];
	}
	return { state, p1Id: state.players[0].playerId, p2Id: state.players[1].playerId };
}

function putOnBattlefield(state: GameState, playerId: string, card: ScryfallCard): CardInstance {
	const player = state.players.find((p) => p.playerId === playerId)!;
	const inst = createCardInstance(card, playerId, 'battlefield');
	inst.summoningSick = false;
	inst.enteredTimestamp = allocateTimestamp(state);
	player.battlefield.push(inst);
	return inst;
}

function putInHand(state: GameState, playerId: string, card: ScryfallCard): CardInstance {
	const player = state.players.find((p) => p.playerId === playerId)!;
	const inst = createCardInstance(card, playerId, 'hand');
	player.hand.push(inst);
	return inst;
}

describe('Phase 7: runtime/replace.ts — Rule Modifiers', () => {
	it('replaces empty-library draw with a win on a renamed Laboratory Maniac and respects Humility', () => {
		const { state, p1Id } = twoPlayerState();
		const p1 = state.players[0];
		p1.library = [];

		const savant = synthCard({
			name: 'Archive Savant',
			typeLine: 'Creature — Human Wizard',
			power: '2',
			toughness: '2',
			oracleText: 'If you would draw a card while your library has no cards in it, you win the game instead.'
		});
		putOnBattlefield(state, p1Id, savant);

		assert.deepEqual(replaceEmptyLibraryDraw(state, p1), {
			replaced: true,
			winsGame: true,
			sourceName: 'Archive Savant'
		});

		// Drawing from empty library via engine.ts wins the game instead of losing.
		drawCards(state, p1, 1);
		assert.equal(p1.lost, false);
		assert.equal(state.winnerPlayerId, p1Id);

		// Under Humility, Archive Savant loses all abilities and the player loses on empty-library draw.
		const { state: state2, p1Id: p1Id2 } = twoPlayerState();
		const p1b = state2.players[0];
		p1b.library = [];
		putOnBattlefield(state2, p1Id2, savant);
		putOnBattlefield(
			state2,
			p1Id2,
			synthCard({
				name: 'Humility',
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
			})
		);
		assert.deepEqual(replaceEmptyLibraryDraw(state2, p1b), { replaced: false });
		drawCards(state2, p1b, 1);
		assert.equal(p1b.lost, true);
	});

	it('enforces generic {3} attack tax and stacks multiple attack tax permanents in declare_attackers', () => {
		const { state, p1Id, p2Id } = twoPlayerState();
		state.phase = 'declare_attackers';

		const attacker = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Test Berserker',
				typeLine: 'Creature — Human Berserker',
				power: '3',
				toughness: '3',
				oracleText: ''
			})
		);

		const barrier3 = synthCard({
			name: 'Sanctuary Barrier',
			typeLine: 'Enchantment',
			oracleText:
				"Creatures can't attack you unless their controller pays {3} for each creature they control that's attacking you."
		});
		putOnBattlefield(state, p2Id, barrier3);
		assert.equal(getAttackTaxGeneric(state, p2Id), 3);

		// With only 2 mana in pool, {3} attack tax blocks the attack.
		state.players[0].manaPool.C = 2;
		const fail3 = applyGameAction(state, p1Id, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2Id }]
		});
		assert.equal(fail3.ok, false);

		// Add a second {2} tax permanent -> total tax is {5} per attacker.
		const barrier2 = synthCard({
			name: 'Aether Toll',
			typeLine: 'Enchantment',
			oracleText:
				"Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you."
		});
		putOnBattlefield(state, p2Id, barrier2);
		assert.equal(getAttackTaxGeneric(state, p2Id), 5);

		state.players[0].manaPool.C = 4;
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			false
		);

		state.players[0].manaPool.C = 5;
		const ok5 = applyGameAction(state, p1Id, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2Id }]
		});
		assert.equal(ok5.ok, true);
		assert.equal(state.players[0].manaPool.C, 0);
	});

	it('grants unlimited hand size from a synthetic permanent and respects ability loss', () => {
		const { state, p1Id, p2Id } = twoPlayerState();
		const p1 = state.players[0];
		for (let i = 0; i < 9; i++) {
			putInHand(state, p1Id, getCardByName('Forest')!);
		}

		const scrollCreature = synthCard({
			name: 'Archivist of the Infinite',
			typeLine: 'Creature — Human Wizard',
			power: '1',
			toughness: '3',
			oracleText: 'You have no maximum hand size.'
		});
		putOnBattlefield(state, p1Id, scrollCreature);
		assert.equal(playerHasNoMaxHandSize(state, p1), true);

		// Advance from end_step -> cleanup -> next turn without prompting to discard!
		state.phase = 'end_step';
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(p1.hand.length, 9);
		assert.equal(
			state.pendingPrompts.some((p) => p.kind === 'discard_to_hand_size'),
			false
		);

		// Under Humility, the creature loses "You have no maximum hand size."
		putOnBattlefield(
			state,
			p2Id,
			synthCard({
				name: 'Humility',
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
			})
		);
		assert.equal(playerHasNoMaxHandSize(state, p1), false);
	});

	it('evaluates cantLose, opponentsCantWin, playerHexproof, and playerShroud with conditions', () => {
		const { state, p1Id, p2Id } = twoPlayerState();
		const p1 = state.players[0];
		const p2 = state.players[1];

		const conditionalAngel = synthCard({
			name: 'Metalwork Seraph',
			typeLine: 'Artifact Creature — Angel',
			power: '4',
			toughness: '4',
			oracleText:
				"As long as you control three or more artifacts, you can't lose the game.\nAs long as you control three or more artifacts, you have hexproof."
		});
		putOnBattlefield(state, p1Id, conditionalAngel);

		// Only 1 artifact so far -> condition false.
		assert.equal(playerCannotLoseGame(state, p1).protected, false);
		assert.equal(ruleTreeCannotLose(state, p1).protected, false);
		assert.equal(playerHasHexproofFrom(state, p1, p2Id), false);
		assert.equal(enginePlayerHasHexproofFrom(state, p1, p2Id), false);

		// Add two more artifacts -> condition becomes true!
		putOnBattlefield(state, p1Id, getCardByName('Sol Ring')!);
		putOnBattlefield(state, p1Id, getCardByName('Arcane Signet')!);
		assert.equal(playerCannotLoseGame(state, p1).protected, true);
		assert.equal(ruleTreeCannotLose(state, p1).protected, true);
		assert.equal(playerHasHexproofFrom(state, p1, p2Id), true);
		assert.equal(enginePlayerHasHexproofFrom(state, p1, p2Id), true);
		assert.equal(enginePlayerHasHexproofFrom(state, p1, p1Id), false);

		// Platinum Angel-style combined sentence + player shroud
		putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Veil Totem',
				typeLine: 'Artifact',
				oracleText: "You can't lose the game and your opponents can't win the game.\nYou have shroud."
			})
		);
		assert.equal(playerCannotWinGame(state, p2).blocked, true);
		assert.equal(ruleTreeCannotWin(state, p2).blocked, true);
		assert.equal(playerCannotWinGame(state, p1).blocked, false);
		assert.equal(playerHasShroud(state, p1), true);
		assert.equal(enginePlayerHasShroud(state, p1), true);
	});

	it('evaluates global cast permissions (including type-filtered flash) and restrictions', () => {
		const { state, p1Id, p2Id } = twoPlayerState();
		state.phase = 'upkeep';

		const creatureCard = getCardByName('Llanowar Elves')!;
		const sorceryCard = getCardByName('Cultivate')!;
		const creatureInst = putInHand(state, p1Id, creatureCard);
		const sorceryInst = putInHand(state, p1Id, sorceryCard);

		// "You may cast creature spells as though they had flash."
		putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Herald of Sudden Beasts',
				typeLine: 'Creature — Elf Shaman',
				power: '2',
				toughness: '2',
				oracleText: 'You may cast creature spells as though they had flash.'
			})
		);

		assert.equal(checkGlobalCastPermissionsAndRestrictions(state, p1Id, creatureInst, 'hand').grantsFlash, true);
		assert.equal(ruleTreeCastRules(state, p1Id, creatureInst, 'hand').grantsFlash, true);
		assert.equal(checkGlobalCastPermissionsAndRestrictions(state, p1Id, sorceryInst, 'hand').grantsFlash, false);
		state.players[0].manaPool.G = 5;
		assert.equal(checkSpellCastLegality(state, p1Id, creatureInst, 'hand').ok, true);
		assert.equal(checkSpellCastLegality(state, p1Id, sorceryInst, 'hand').ok, false);

		// Synthetic Grand Abolisher ("During your turn, your opponents can't cast spells.")
		putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Silent Arbiter of Law',
				typeLine: 'Creature — Human Advisor',
				power: '2',
				toughness: '2',
				oracleText: "During your turn, your opponents can't cast spells."
			})
		);
		const p2Summary = checkGlobalCastPermissionsAndRestrictions(state, p2Id, 'hand');
		assert.equal(p2Summary.blocked, true);
		assert.match(p2Summary.error ?? '', /Silent Arbiter of Law/);
	});

	it('evaluates library search interceptors and respects timestamp order', () => {
		const { state, p1Id, p2Id } = twoPlayerState();

		const oppAgent = synthCard({
			name: 'Shadow Auditor',
			typeLine: 'Creature — Human Rogue',
			power: '3',
			toughness: '2',
			oracleText:
				"Flash\nYou control your opponents while they're searching their libraries.\nWhile an opponent is searching their library, they exile each card they find. You may play those cards for as long as they remain exiled, and you may spend mana as though it were mana of any color to cast them."
		});
		putOnBattlefield(state, p2Id, oppAgent);

		const info = getLibrarySearchInterceptor(state, p1Id);
		assert.ok(info);
		assert.equal(info.controllerId, p2Id);
		assert.equal(info.sourceName, 'Shadow Auditor');
		assert.equal(info.exilesFoundCards, true);
		assert.equal(info.grantPlayFromExile, true);
		assert.equal(info.spendManaAsAnyColor, true);
		assert.deepEqual(ruleTreeSearchInterceptor(state, p1Id), info);
	});
});

describe('Phase 7: runtime/replace.ts — Restrictions', () => {
	it('prevents countering spells with self or granted cantBeCountered', () => {
		const { state, p1Id, p2Id } = twoPlayerState();

		const herald = synthCard({
			name: 'Spellshield Banneret',
			typeLine: 'Creature — Elemental',
			power: '2',
			toughness: '2',
			oracleText: "Creature spells you control can't be countered."
		});
		putOnBattlefield(state, p1Id, herald);

		const elves = putInHand(state, p1Id, getCardByName('Llanowar Elves')!);
		state.players[0].manaPool.G = 1;
		assert.equal(applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: elves.instanceId }).ok, true);
		assert.equal(spellCannotBeCountered(state, state.stack[0]), true);

		// Opponent casts Counterspell targeting Llanowar Elves -> Elves is not countered!
		const verdictStackId = state.stack[0].id;
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		const counter = putInHand(state, p2Id, getCardByName('Counterspell')!);
		state.players[1].manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'cast_spell',
				instanceId: counter.instanceId,
				targets: [{ kind: 'stack', id: verdictStackId, label: 'Llanowar Elves' }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].title, 'Llanowar Elves');
	});

	it('enforces cantAttack, cantBlock, cantAttackOrBlock (self and Aura), attacksEachCombat, and doesntUntap', () => {
		const { state, p1Id, p2Id } = twoPlayerState();

		const guardian = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Stalwart Statue',
				typeLine: 'Artifact Creature — Golem',
				power: '4',
				toughness: '4',
				oracleText: "~ can't attack."
			})
		);
		const berserker = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Frenzied Raider',
				typeLine: 'Creature — Orc Berserker',
				power: '3',
				toughness: '2',
				oracleText: '~ attacks each combat if able.'
			})
		);
		const lockedBear = putOnBattlefield(
			state,
			p2Id,
			synthCard({
				name: 'Bound Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2',
				oracleText: ''
			})
		);
		const pacifism = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Chains of Stillness',
				typeLine: 'Enchantment — Aura',
				oracleText: "Enchant creature\nEnchanted creature can't attack or block."
			})
		);
		pacifism.attachedToId = lockedBear.instanceId;

		const frozen = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Leaden Colossus',
				typeLine: 'Artifact Creature — Golem',
				power: '5',
				toughness: '5',
				oracleText: "~ doesn't untap during your untap step."
			})
		);
		frozen.tapped = true;

		assert.equal(hasRestriction(state, guardian, 'cantAttack'), true);
		assert.equal(hasRestriction(state, berserker, 'attacksEachCombat'), true);
		assert.equal(hasRestriction(state, lockedBear, 'cantAttack'), true);
		assert.equal(hasRestriction(state, lockedBear, 'cantBlock'), true);
		assert.equal(hasRestriction(state, frozen, 'doesntUntap'), true);

		state.phase = 'declare_attackers';
		// Stalwart Statue cannot attack.
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: guardian.instanceId, defenderPlayerId: p2Id },
					{ attackerInstanceId: berserker.instanceId, defenderPlayerId: p2Id }
				]
			}).ok,
			false
		);
		// Frenzied Raider must attack if able, so declaring 0 attackers fails.
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: []
			}).ok,
			false
		);
		// Declaring Frenzied Raider succeeds.
		assert.equal(
			applyGameAction(state, p1Id, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: berserker.instanceId, defenderPlayerId: p2Id }]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);

		// Now in declare_blockers -> Bound Bear cannot block because of attached Chains of Stillness.
		assert.equal(state.phase, 'declare_blockers');
		assert.equal(
			applyGameAction(state, p2Id, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: lockedBear.instanceId, attackerInstanceId: berserker.instanceId }]
			}).ok,
			false
		);

		// Check untap step: Leaden Colossus stays tapped when P1's next turn starts.
		state.phase = 'end_step';
		state.priorityPlayerIndex = 0;
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		// Now it is P2's turn; advance P2's turn to end_step and back to P1's turn.
		state.phase = 'end_step';
		state.priorityPlayerIndex = 1;
		assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(state.activePlayerIndex, 0);
		assert.equal(frozen.tapped, true);
		assert.equal(berserker.tapped, false);
	});
});

describe('Phase 7: runtime/replace.ts — Replacements & Scoped Multipliers', () => {
	it('evaluates graveyard replacement, self ETB tapped (exempting "unless"), and self ETB counters', () => {
		const { state, p1Id } = twoPlayerState();

		const tapLand = synthCard({
			name: 'Quiet Meadow',
			typeLine: 'Land',
			oracleText: '~ enters tapped.'
		});
		const checkLand = synthCard({
			name: 'Glacial Fortress',
			typeLine: 'Land',
			oracleText: 'Glacial Fortress enters tapped unless you control a Plains or an Island.'
		});
		assert.equal(cardEntersTapped(tapLand), true);
		assert.equal(cardEntersTapped(checkLand), false);

		// Self ETB with counters, doubled by Corpsejack Menace!
		putOnBattlefield(state, p1Id, getCardByName('Corpsejack Menace')!);
		const hydra = createCardInstance(
			synthCard({
				name: 'Clockwork Hydra',
				typeLine: 'Artifact Creature — Hydra',
				power: '0',
				toughness: '0',
				oracleText: '~ enters with four +1/+1 counters on it.'
			}),
			p1Id,
			'battlefield'
		);
		state.players[0].battlefield.push(hydra);
		applySelfEtbReplacements(state, hydra);
		assert.equal(hydra.counters['+1/+1'], 8);

		// Graveyard replacement from a synthetic card
		putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Null Void Shrine',
				typeLine: 'Enchantment',
				oracleText: 'If a card or token would be put into a graveyard from anywhere, exile it instead.'
			})
		);
		const gyResolved = resolveZoneChangeReplacements(state, hydra, 'battlefield', 'graveyard');
		assert.equal(gyResolved.dest, 'exile');
		assert.equal(gyResolved.replacedBy, 'Null Void Shrine');
		const ruleTreeResolved = ruleTreeGraveyardZone(state, hydra, 'battlefield', 'graveyard');
		assert.equal(ruleTreeResolved.dest, 'exile');
		assert.equal(ruleTreeResolved.replacedBy, 'Null Void Shrine');
	});

	it('scopes Corpsejack Menace to +1/+1 counters on creatures you control, and supports general counter/token/trigger doublers', () => {
		const { state, p1Id } = twoPlayerState();

		const corpsejack = putOnBattlefield(state, p1Id, getCardByName('Corpsejack Menace')!);
		const relic = putOnBattlefield(state, p1Id, getCardByName('Sol Ring')!);

		// Corpsejack Menace doubles +1/+1 counters on a creature you control:
		addCountersToPermanent(state, corpsejack, '+1/+1', 2);
		assert.equal(corpsejack.counters['+1/+1'], 4);

		// Corpsejack Menace does NOT double charge counters on a creature:
		addCountersToPermanent(state, corpsejack, 'charge', 2);
		assert.equal(corpsejack.counters.charge, 2);

		// Corpsejack Menace does NOT double +1/+1 counters on a non-creature artifact!
		assert.equal(counterMultiplier(state, relic, '+1/+1'), 1);
		addCountersToPermanent(state, relic, '+1/+1', 2);
		assert.equal(relic.counters['+1/+1'], 2);

		// General permanent counter doubler + token doubler (Doubling Season style)
		putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Season of Twin Moons',
				typeLine: 'Enchantment',
				oracleText:
					'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of each of those kinds of counters on that permanent instead.'
			})
		);
		assert.equal(counterMultiplier(state, relic, 'charge'), 2);
		addCountersToPermanent(state, relic, 'charge', 3);
		assert.equal(relic.counters.charge, 6);
		assert.equal(tokenMultiplier(state, p1Id), 2);
	});

	it('multiplies ETB, dies, and attack triggers via triggerMultiplier in runtime/triggers.ts', () => {
		const { state, p1Id } = twoPlayerState();

		const panharmonicon = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Resonant Chamber',
				typeLine: 'Artifact',
				oracleText:
					'If an artifact or creature entering the battlefield causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'
			})
		);
		const watcher = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Soul Warden Watcher',
				typeLine: 'Creature — Human Cleric',
				power: '1',
				toughness: '1',
				oracleText: 'Whenever another creature enters, you gain 1 life.'
			})
		);
		const landWatcher = putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Tireless Provisioner Scout',
				typeLine: 'Creature — Elf Scout',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever a land you control enters, you gain 1 life.'
			})
		);

		assert.equal(
			triggerMultiplier(state, watcher, p1Id, {
				event: 'zoneChange',
				object: panharmonicon,
				to: 'battlefield'
			}),
			2
		);
		const forestInst = createCardInstance(getCardByName('Forest')!, p1Id, 'battlefield');
		assert.equal(
			triggerMultiplier(state, landWatcher, p1Id, {
				event: 'zoneChange',
				object: forestInst,
				to: 'battlefield'
			}),
			1
		);

		// Cast a creature spell and resolve it -> Soul Warden Watcher triggers twice (+2 life)!
		const startLife = state.players[0].life;
		const bear = putInHand(
			state,
			p1Id,
			synthCard({
				name: 'Grizzly Cub',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2',
				oracleText: ''
			})
		);
		state.players[0].manaPool.G = 2;
		assert.equal(applyGameAction(state, p1Id, { type: 'cast_spell', instanceId: bear.instanceId }).ok, true);
		assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, state.players[1].playerId, { type: 'pass_priority' }).ok, true);
		resolveTriggers(state);
		assert.equal(state.players[0].life, startLife + 2);

		// Attack trigger multiplier (Wulfgar style) + Dies trigger multiplier (Drivnod style)
		putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Warlord of Dual Strikes',
				typeLine: 'Creature — Human Barbarian',
				power: '4',
				toughness: '4',
				oracleText:
					'If a creature you control attacking causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'
			})
		);
		putOnBattlefield(
			state,
			p1Id,
			synthCard({
				name: 'Dominus of Carnage',
				typeLine: 'Creature — Phyrexian Horror',
				power: '8',
				toughness: '3',
				oracleText:
					'If a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'
			})
		);
		assert.equal(
			triggerMultiplier(state, watcher, p1Id, {
				event: 'attacks',
				attackers: [watcher]
			}),
			2
		);
		assert.equal(
			triggerMultiplier(state, watcher, p1Id, {
				event: 'zoneChange',
				object: watcher,
				from: 'battlefield',
				to: 'graveyard'
			}),
			2
		);
	});
});
