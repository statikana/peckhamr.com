import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	checkTurnFaceUpLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getEffectiveActivatedAbilities,
	sanitizeGameStateForViewer
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { subscribeEvents, type GameEvent } from './events.ts';
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
		id: `p5_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

function createGame(playerCount: 2 | 3 = 2, botMask: boolean[] = []): GameState {
	const seats: LobbySeat[] = Array.from({ length: playerCount }, (_, i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length];
		return {
			seatIndex: i,
			userId: `p${i + 1}`,
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
	const decks = new Map(seats.map((s, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]]));
	const state = createInitialGameState('TRACKP5', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		if (!p.isBot) {
			assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
		}
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

function passAllPriority(state: GameState, maxSteps = 30): void {
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

describe('Track P5 — Self-contained CR 701 keyword actions', () => {
	describe('1. Amass [Subtype] N (CR 701.47a–d)', () => {
		it('creates a 0/0 black [Subtype] Army token when none exists, adds counters & subtypes on subsequent amass, and fires amass triggers', () => {
			const state = createGame(2);
			const p1 = state.players[0];
			const p2 = state.players[1];
			addMana(p1, 10);

			const orcWatcher = makeCard({
				name: 'Synthetic Orc Chronicler',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Orc',
				power: '1',
				toughness: '3',
				oracleText: 'Whenever you amass Orcs, you gain 2 life.'
			});
			const anyAmassWatcher = makeCard({
				name: 'Synthetic War Drummer',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Warrior',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever you amass, you gain 1 life.'
			});
			const amassOrcsSpell = makeCard({
				name: 'Synthetic Muster Orcs',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Amass Orcs 2.'
			});
			const legacyAmassAndBlast = makeCard({
				name: 'Synthetic Brutal Advance',
				manaCost: '{2}{B}{R}',
				cmc: 4,
				typeLine: 'Sorcery',
				oracleText:
					'Amass 3, then the amassed Army deals damage equal to its power to each non-Army creature.'
			});
			const bystander = makeCard({
				name: 'Synthetic Hill Watcher',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Creature — Giant',
				power: '4',
				toughness: '6'
			});

			assert.equal(definitionSupportReport(compileCard(orcWatcher)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(anyAmassWatcher)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(amassOrcsSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(legacyAmassAndBlast)).fullySupported, true);

			putInZone(state, p1, orcWatcher, 'battlefield');
			putInZone(state, p1, anyAmassWatcher, 'battlefield');
			const enemyGiant = putInZone(state, p2, bystander, 'battlefield');
			const spell1 = putInZone(state, p1, amassOrcsSpell, 'hand');
			const spell2 = putInZone(state, p1, legacyAmassAndBlast, 'hand');

			const events: GameEvent[] = [];
			subscribeEvents(state, (_s, ev) => events.push(ev));

			const lifeBefore = p1.life;
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell1.instanceId })
					.ok,
				true
			);
			passAllPriority(state);

			const armies = p1.battlefield.filter((c) => evaluatePermanent(state, c).hasSubType('Army'));
			assert.equal(armies.length, 1);
			const army = armies[0];
			assert.equal(army.isToken, true);
			const ev1 = evaluatePermanent(state, army);
			assert.equal(ev1.power, 2);
			assert.equal(ev1.toughness, 2);
			assert.deepEqual(ev1.colors, ['B']);
			assert.equal(ev1.hasSubType('Orc'), true);
			assert.equal(ev1.hasSubType('Army'), true);
			assert.equal(ev1.hasSubType('Zombie'), false);
			assert.equal(p1.life, lifeBefore + 3);
			assert.equal(
				events.some(
					(e) =>
						e.kind === 'Amassed' &&
						e.subtype === 'Orc' &&
						e.amount === 2 &&
						e.objectId === army.instanceId
				),
				true
			);

			// Legacy "Amass 3" defaults to Zombie (CR 701.47d), reuses the existing Orc Army, grants Zombie in Layer 4,
			// grows it to 5/5, deals 5 damage to non-Army creatures (sparing the Army!), and triggers only "Whenever you amass".
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell2.instanceId })
					.ok,
				true
			);
			passAllPriority(state);

			const armiesAfter = p1.battlefield.filter((c) =>
				evaluatePermanent(state, c).hasSubType('Army')
			);
			assert.equal(armiesAfter.length, 1);
			const ev2 = evaluatePermanent(state, army);
			assert.equal(ev2.power, 5);
			assert.equal(ev2.toughness, 5);
			assert.equal(ev2.hasSubType('Orc'), true);
			assert.equal(ev2.hasSubType('Zombie'), true);
			assert.equal(ev2.hasSubType('Army'), true);
			assert.equal(army.damageMarked, 0);
			assert.equal(enemyGiant.damageMarked, 5);
			// Generic amass trigger (+1 life) resolved, NOT +2 Orc life.
			assert.equal(p1.life, lifeBefore + 4);
		});

		it('prompts when controlling two Armies and survives JSON round-trip mid-prompt, plus supports spell-MV where-X amass', () => {
			let state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 12);

			const armyCardA = makeCard({
				name: 'Synthetic Army One',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Orc Army',
				power: '1',
				toughness: '1'
			});
			const armyCardB = makeCard({
				name: 'Synthetic Army Two',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Changeling',
				oracleText: 'Changeling',
				keywords: ['Changeling'],
				power: '2',
				toughness: '2'
			});
			const spellCasterWatcher = makeCard({
				name: 'Synthetic White-Hand Seer',
				manaCost: '{1}{U}{B}{R}',
				cmc: 4,
				typeLine: 'Legendary Creature — Avatar Wizard',
				power: '2',
				toughness: '5',
				oracleText:
					"Whenever you cast a noncreature spell, amass Orcs X, where X is that spell's mana value."
			});
			const divSpell = makeCard({
				name: 'Synthetic Insight',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Draw a card.'
			});

			assert.equal(definitionSupportReport(compileCard(spellCasterWatcher)).fullySupported, true);

			const a1 = putInZone(state, p1, armyCardA, 'battlefield');
			const a2 = putInZone(state, p1, armyCardB, 'battlefield');
			putInZone(state, p1, spellCasterWatcher, 'battlefield');
			const spellInst = putInZone(state, p1, divSpell, 'hand');

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: spellInst.instanceId
				}).ok,
				true
			);
			// Top of stack is the cast trigger (amass Orcs 3). Pass priority so it resolves and pauses for Army choice.
			passAllPriority(state);
			assert.equal(state.pendingPrompts.length, 1);
			const prompt = state.pendingPrompts[0];
			assert.equal(prompt.choice?.kind, 'chooseObjects');

			// JSON round-trip mid-prompt
			state = JSON.parse(JSON.stringify(state)) as GameState;
			const res = applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: [a1.instanceId] }
			});
			assert.equal(res.ok, true, res.error ?? 'choice failed');
			passAllPriority(state);

			const updatedA1 = state.players[0].battlefield.find((c) => c.instanceId === a1.instanceId)!;
			const updatedA2 = state.players[0].battlefield.find((c) => c.instanceId === a2.instanceId)!;
			assert.equal(updatedA1.counters['+1/+1'] ?? 0, 3);
			assert.equal(updatedA2.counters['+1/+1'] ?? 0, 0);
		});
	});

	describe('2. Incubate N (CR 701.53a–c, CR 111.10i) & 3. Populate (CR 701.36, CR 707.8a)', () => {
		it('creates colorless Incubator DFC tokens with N +1/+1 counters, transforms for {2} into 0/0 Phyrexian, and prompts on Populate with >= 2 creature tokens', () => {
			let state = createGame(2);
			const p1 = state.players[0];
			const p2 = state.players[1];
			addMana(p1, 20);

			const fodder1 = makeCard({
				name: 'Synthetic Bear A',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const fodder2 = makeCard({
				name: 'Synthetic Bear B',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const sunfallLike = makeCard({
				name: 'Synthetic Dawn Wipe',
				manaCost: '{3}{W}{W}',
				cmc: 5,
				typeLine: 'Sorcery',
				oracleText:
					'Exile all creatures. Incubate X, where X is the number of creatures exiled this way.'
			});
			const populateSpell = makeCard({
				name: 'Synthetic Wake Reflections',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Populate.'
			});
			const incubateTwiceSpell = makeCard({
				name: 'Synthetic Twin Pods',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Incubate 2 twice.'
			});

			assert.equal(definitionSupportReport(compileCard(sunfallLike)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(populateSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(incubateTwiceSpell)).fullySupported, true);

			putInZone(state, p1, fodder1, 'battlefield');
			putInZone(state, p2, fodder2, 'battlefield');
			const wipeInst = putInZone(state, p1, sunfallLike, 'hand');
			const popEmpty = putInZone(state, p1, populateSpell, 'hand');
			const popAfterTransform = putInZone(state, p1, populateSpell, 'hand');
			const twinInst = putInZone(state, p1, incubateTwiceSpell, 'hand');

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: wipeInst.instanceId
				}).ok,
				true
			);
			passAllPriority(state);

			assert.equal(p1.battlefield.length, 1);
			const incubator = p1.battlefield[0];
			assert.equal(incubator.isToken, true);
			assert.equal(incubator.counters['+1/+1'], 2);
			const frontEv = evaluatePermanent(state, incubator);
			assert.equal(frontEv.isArtifact, true);
			assert.equal(frontEv.isCreature, false);
			assert.equal(frontEv.hasSubType('Incubator'), true);

			// Populate when controlling only a non-creature Incubator token does nothing (CR 701.36b).
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: popEmpty.instanceId
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(p1.battlefield.length, 1);

			// Activate "{2}: Transform this token." on the Incubator token.
			const abilities = getEffectiveActivatedAbilities(state, p1, incubator);
			assert.equal(abilities.length, 1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: incubator.instanceId,
					abilityId: abilities[0].id
				}).ok,
				true
			);
			passAllPriority(state);

			assert.equal(incubator.transformed, true);
			const backEv = evaluatePermanent(state, incubator);
			assert.equal(backEv.isArtifact, true);
			assert.equal(backEv.isCreature, true);
			assert.equal(backEv.hasSubType('Phyrexian'), true);
			assert.equal(backEv.power, 2);
			assert.equal(backEv.toughness, 2);

			// Incubate 2 twice and transform one of the new tokens too so Populate has >= 2 creature tokens and prompts!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: twinInst.instanceId
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(p1.battlefield.length, 3);

			const secondIncubator = p1.battlefield.find((c) => c.instanceId !== incubator.instanceId)!;
			secondIncubator.counters['+1/+1'] = 4;
			const ab2 = getEffectiveActivatedAbilities(state, p1, secondIncubator);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: secondIncubator.instanceId,
					abilityId: ab2[0].id
				}).ok,
				true
			);
			passAllPriority(state);

			// Cast Populate: two Phyrexian creature tokens exist, so P1 gets a prompt.
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: popAfterTransform.instanceId
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(state.pendingPrompts.length, 1);
			const popPrompt = state.pendingPrompts[0];
			assert.equal(popPrompt.choice?.kind, 'chooseObjects');

			// JSON round-trip mid-prompt
			state = JSON.parse(JSON.stringify(state)) as GameState;
			const res = applyGameAction(state, state.players[0].playerId, {
				type: 'choice',
				promptId: popPrompt.id,
				answer: { kind: 'chooseObjects', objectIds: [incubator.instanceId] }
			});
			assert.equal(res.ok, true, res.error ?? 'choice failed');
			passAllPriority(state);
			// Because Phyrexian Token has printed 0/0 and counters aren't copied (CR 707.2), the 0/0 copy entered on its transformed face and died to 0-toughness SBA.
			assert.equal(
				state.log.some((l) => l.text.includes('Phyrexian Token')),
				true
			);
		});

		it('populates a transformed DFC creature token onto its active face with full copiable DFC faces (CR 707.8a)', () => {
			const state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 10);

			const anthem = makeCard({
				name: 'Synthetic Glorious Banner',
				manaCost: '{1}{W}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control get +1/+1.'
			});
			const incSpell = makeCard({
				name: 'Synthetic Quick Pod',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Incubate 1.'
			});
			const popSpell = makeCard({
				name: 'Synthetic Echo Token',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Populate.'
			});

			putInZone(state, p1, anthem, 'battlefield');
			const i1 = putInZone(state, p1, incSpell, 'hand');
			const pSpell = putInZone(state, p1, popSpell, 'hand');

			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: i1.instanceId }).ok,
				true
			);
			passAllPriority(state);
			const pod = p1.battlefield.find((c) => c.isToken)!;
			const ab = getEffectiveActivatedAbilities(state, p1, pod);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: pod.instanceId,
					abilityId: ab[0].id
				}).ok,
				true
			);
			passAllPriority(state);

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: pSpell.instanceId
				}).ok,
				true
			);
			passAllPriority(state);

			const tokens = p1.battlefield.filter((c) => c.isToken);
			assert.equal(tokens.length, 2);
			const copyTok = tokens.find((c) => c.instanceId !== pod.instanceId)!;
			assert.equal(copyTok.transformed, true);
			assert.equal(copyTok.activeFaceIndex, 1);
			assert.equal(copyTok.counters['+1/+1'] ?? 0, 0);
			assert.equal(copyTok.card.faces?.length, 2);
			const copyEv = evaluatePermanent(state, copyTok);
			assert.equal(copyEv.isCreature, true);
			assert.equal(copyEv.hasSubType('Phyrexian'), true);
			// Base 0/0 + +1/+1 from anthem = 1/1 (counters from original were NOT copied).
			assert.equal(copyEv.power, 1);
			assert.equal(copyEv.toughness, 1);
		});
	});

	describe('4. Manifest (CR 701.40), Cloak (CR 701.58), & Manifest dread (CR 701.62)', () => {
		it('manifests creature vs instant vs morph land accurately and enforces viewer sanitization & turn_face_up rules', () => {
			const state = createGame(2);
			const p1 = state.players[0];
			const p2 = state.players[1];
			addMana(p1, 15);

			const etbCreature = makeCard({
				name: 'Synthetic Hidden Grizzly',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '3',
				toughness: '4',
				oracleText: 'When ~ enters, you gain 5 life.'
			});
			const sorceryCard = makeCard({
				name: 'Synthetic Secret Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to any target.'
			});
			const morphLand = makeCard({
				name: 'Synthetic Hidden Refuge',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				keywords: ['Morph'],
				oracleText: 'Morph {2}\n{T}: Add {C}.'
			});
			const manifestThree = makeCard({
				name: 'Synthetic Triple Manifest',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Manifest the top three cards of your library.'
			});

			assert.equal(definitionSupportReport(compileCard(manifestThree)).fullySupported, true);

			// Note: putInZone(..., 'library') inserts at index 0, so push in reverse order.
			const landInst = putInZone(state, p1, morphLand, 'library');
			const instantInst = putInZone(state, p1, sorceryCard, 'library');
			const creatureInst = putInZone(state, p1, etbCreature, 'library');
			const castInst = putInZone(state, p1, manifestThree, 'hand');

			const lifeBefore = p1.life;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: castInst.instanceId
				}).ok,
				true
			);
			passAllPriority(state);

			// Printed ETB did NOT fire while entering face down!
			assert.equal(p1.life, lifeBefore);
			assert.equal(p1.battlefield.length, 3);

			for (const perm of p1.battlefield) {
				assert.equal(perm.isFaceDown, true);
				const ev = evaluatePermanent(state, perm);
				assert.equal(ev.power, 2);
				assert.equal(ev.toughness, 2);
				assert.deepEqual(ev.colors, []);
				assert.equal(ev.effectiveName.startsWith('Face-Down'), true);
			}

			// Viewer sanitization: P1 sees true card names via knownFaceCard, P2 sees masked Face-down Card.
			const viewP1 = sanitizeGameStateForViewer(state, p1.playerId);
			const viewP2 = sanitizeGameStateForViewer(state, p2.playerId);
			const p1CreatureView = viewP1.players[0].battlefield.find(
				(c) => c.instanceId === creatureInst.instanceId
			)!;
			const p2CreatureView = viewP2.players[0].battlefield.find(
				(c) => c.instanceId === creatureInst.instanceId
			)!;
			assert.equal(p1CreatureView.card.name, 'Synthetic Hidden Grizzly');
			assert.equal(p1CreatureView.faceDownSpec?.turnUpManaCost, '{1}{G}');
			assert.equal(p2CreatureView.card.name.startsWith('Face-Down'), true);
			assert.equal(p2CreatureView.faceDownSpec?.turnUpManaCost, undefined);

			// CR 701.40g: Instant cannot be turned face up.
			assert.equal(checkTurnFaceUpLegality(state, p1.playerId, instantInst).ok, false);

			// CR 701.40b: Creature card turns face up for its mana cost {1}{G}.
			assert.equal(checkTurnFaceUpLegality(state, p1.playerId, creatureInst).ok, true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'turn_face_up',
					instanceId: creatureInst.instanceId
				}).ok,
				true
			);
			assert.equal(creatureInst.isFaceDown, false);
			assert.equal(evaluatePermanent(state, creatureInst).power, 3);
			assert.equal(evaluatePermanent(state, creatureInst).toughness, 4);

			// CR 701.40c: Non-creature land with Morph {2} turns face up via its Morph cost!
			assert.equal(checkTurnFaceUpLegality(state, p1.playerId, landInst).ok, true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'turn_face_up',
					instanceId: landInst.instanceId
				}).ok,
				true
			);
			assert.equal(landInst.isFaceDown, false);
			assert.equal(evaluatePermanent(state, landInst).isLand, true);
			assert.equal(evaluatePermanent(state, landInst).isCreature, false);
		});

		it('supports Cloak + Equipment attach (Cryptic Coat pattern) with Ward {2} and masked log', () => {
			const state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 10);

			const topCard = makeCard({
				name: 'Synthetic Secret Agent',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Human Rogue',
				power: '3',
				toughness: '1'
			});
			const coatEquip = makeCard({
				name: 'Synthetic Cloak Garment',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Artifact — Equipment',
				oracleText:
					'When ~ enters, cloak the top card of your library, then attach ~ to it.\nEquipped creature gets +1/+0.'
			});

			assert.equal(definitionSupportReport(compileCard(coatEquip)).fullySupported, true);

			const agentInst = putInZone(state, p1, topCard, 'library');
			const coatInst = putInZone(state, p1, coatEquip, 'hand');

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: coatInst.instanceId
				}).ok,
				true
			);
			passAllPriority(state);

			assert.equal(agentInst.zone, 'battlefield');
			assert.equal(agentInst.isFaceDown, true);
			assert.equal(agentInst.faceDownSpec?.kind, 'cloak');
			assert.equal(agentInst.faceDownSpec?.wardCost, '{2}');
			const bfCoat = p1.battlefield.find((c) => c.instanceId === coatInst.instanceId)!;
			assert.ok(bfCoat);
			assert.equal(bfCoat.attachedToId, agentInst.instanceId);

			const cloakedEv = evaluatePermanent(state, agentInst);
			assert.equal(cloakedEv.power, 3); // 2/2 base + +1/+0 from Equipment
			assert.equal(cloakedEv.toughness, 2);
			assert.equal(
				cloakedEv.keywords.some((k) => k.toLowerCase().startsWith('ward')),
				true
			);
			// Log must NOT leak the secret card's true name while face down!
			assert.equal(
				state.log.some((l) => l.text.includes('Synthetic Secret Agent')),
				false
			);
		});

		it('supports Manifest dread (CR 701.62) with library choice prompt, JSON round-trip, graveyard bin, trigger, and empty library', () => {
			let state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 10);
			p1.library = [];

			const cardTop1 = makeCard({
				name: 'Synthetic Dread Stalker',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Creature — Horror',
				power: '4',
				toughness: '4'
			});
			const cardTop2 = makeCard({
				name: 'Synthetic Dread Mulch',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'You gain 2 life.'
			});
			const dreadWatcher = makeCard({
				name: 'Synthetic Paranormal Scholar',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Creature — Human Detective',
				power: '1',
				toughness: '3',
				oracleText: 'Whenever you manifest dread, you gain 2 life.'
			});
			const dreadSpell = makeCard({
				name: 'Synthetic Dread Summons',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Manifest dread.'
			});

			assert.equal(definitionSupportReport(compileCard(dreadWatcher)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(dreadSpell)).fullySupported, true);

			putInZone(state, p1, dreadWatcher, 'battlefield');
			const c2 = putInZone(state, p1, cardTop2, 'library');
			const c1 = putInZone(state, p1, cardTop1, 'library');
			const s1 = putInZone(state, p1, dreadSpell, 'hand');
			const s2 = putInZone(state, p1, dreadSpell, 'hand');

			const lifeBefore = p1.life;
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok,
				true
			);
			passAllPriority(state);

			assert.equal(state.pendingPrompts.length, 1);
			const pr = state.pendingPrompts[0];
			assert.equal(pr.choice?.kind, 'chooseObjects');
			if (pr.choice?.kind === 'chooseObjects') {
				assert.equal(pr.choice.zone, 'library');
				assert.equal(pr.choice.candidates.length, 2);
			}

			// JSON round-trip mid-prompt
			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(
				applyGameAction(state, state.players[0].playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [c1.instanceId] }
				}).ok,
				true
			);
			passAllPriority(state);

			const manifested = state.players[0].battlefield.find((c) => c.instanceId === c1.instanceId)!;
			assert.ok(manifested);
			assert.equal(manifested.isFaceDown, true);
			assert.equal(
				state.players[0].graveyard.some((c) => c.instanceId === c2.instanceId),
				true
			);
			assert.equal(state.players[0].life, lifeBefore + 2);

			// Empty library (CR 701.62b): still counts as manifesting dread and fires "Whenever you manifest dread"!
			assert.equal(state.players[0].library.length, 0);
			assert.equal(
				applyGameAction(state, state.players[0].playerId, {
					type: 'cast_spell',
					instanceId: s2.instanceId
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(state.players[0].life, lifeBefore + 4);
		});

		it('prompts when manifesting a card from hand and survives JSON round-trip', () => {
			let state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 10);

			const handA = makeCard({
				name: 'Synthetic Hand Colossus',
				manaCost: '{6}{G}{G}',
				cmc: 8,
				typeLine: 'Creature — Wurm',
				power: '8',
				toughness: '8'
			});
			const handB = makeCard({
				name: 'Synthetic Hand Sprite',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Creature — Faerie',
				power: '1',
				toughness: '1'
			});
			const scrollSpell = makeCard({
				name: 'Synthetic Fate Scroll',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Manifest a card from your hand.'
			});

			assert.equal(definitionSupportReport(compileCard(scrollSpell)).fullySupported, true);

			const hA = putInZone(state, p1, handA, 'hand');
			putInZone(state, p1, handB, 'hand');
			const castInst = putInZone(state, p1, scrollSpell, 'hand');

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: castInst.instanceId
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(state.pendingPrompts.length, 1);
			const pr = state.pendingPrompts[0];

			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(
				applyGameAction(state, state.players[0].playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [hA.instanceId] }
				}).ok,
				true
			);
			passAllPriority(state);

			const bfWurm = state.players[0].battlefield.find((c) => c.instanceId === hA.instanceId)!;
			assert.ok(bfWurm);
			assert.equal(bfWurm.isFaceDown, true);
		});
	});

	describe('5. Monstrosity N (CR 701.37a–c)', () => {
		it('becomes monstrous once with X carried into becameMonstrous trigger, activates static condition, and resets on zone change', () => {
			const state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 30);

			const hydra = makeCard({
				name: 'Synthetic Brood Hydra',
				manaCost: '{2}{G}{G}',
				cmc: 4,
				typeLine: 'Creature — Hydra',
				power: '3',
				toughness: '3',
				oracleText:
					'{X}{G}: Monstrosity X.\nAs long as ~ is monstrous, it has trample and hexproof.\nWhen ~ becomes monstrous, create X 1/1 green Saproling creature tokens.'
			});
			const bounceSpell = makeCard({
				name: 'Synthetic Unsummon',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: "Return target creature to its owner's hand."
			});

			assert.equal(definitionSupportReport(compileCard(hydra)).fullySupported, true);

			const hydraInst = putInZone(state, p1, hydra, 'battlefield');
			const bounceInst = putInZone(state, p1, bounceSpell, 'hand');

			const evBefore = evaluatePermanent(state, hydraInst);
			assert.equal(
				evBefore.keywords.some((k) => k.toLowerCase() === 'trample'),
				false
			);
			assert.equal(
				evBefore.keywords.some((k) => k.toLowerCase() === 'hexproof'),
				false
			);

			const ab = getEffectiveActivatedAbilities(state, p1, hydraInst);
			assert.equal(ab.length, 1);

			// Activate {X}{G}: Monstrosity X with X = 3.
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: hydraInst.instanceId,
					abilityId: ab[0].id,
					xValue: 3
				}).ok,
				true
			);
			passAllPriority(state);

			assert.equal(hydraInst.isMonstrous, true);
			assert.equal(hydraInst.counters['+1/+1'], 3);
			const evAfter = evaluatePermanent(state, hydraInst);
			assert.equal(evAfter.power, 6);
			assert.equal(evAfter.toughness, 6);
			assert.equal(
				evAfter.keywords.some((k) => k.toLowerCase() === 'trample'),
				true
			);
			assert.equal(
				evAfter.keywords.some((k) => k.toLowerCase() === 'hexproof'),
				true
			);
			const saprolings = p1.battlefield.filter((c) => c.isToken);
			assert.equal(saprolings.length, 3);

			// Second activation while already monstrous does nothing (CR 701.37a).
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: hydraInst.instanceId,
					abilityId: ab[0].id,
					xValue: 4
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(hydraInst.counters['+1/+1'], 3);
			assert.equal(p1.battlefield.filter((c) => c.isToken).length, 3);

			// Bounce: monstrous designation resets on zone change (CR 400.7).
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bounceInst.instanceId,
					targets: [{ kind: 'permanent', id: hydraInst.instanceId, label: 'hydra' }]
				}).ok,
				true
			);
			passAllPriority(state);
			const handHydra = p1.hand.find((c) => c.instanceId === hydraInst.instanceId)!;
			assert.ok(handHydra);
			assert.equal(handHydra.zone, 'hand');
			assert.equal(handHydra.isMonstrous, undefined);
		});
	});

	describe('6. Bolster N (CR 701.39a), 7. Support N (CR 701.41a), & 8. Adapt N (CR 701.46a)', () => {
		it('bolsters minimum effective toughness creature and prompts on ties with JSON round-trip', () => {
			let state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 10);

			const bigWall = makeCard({
				name: 'Synthetic Stone Wall',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Wall',
				power: '0',
				toughness: '5'
			});
			const tieA = makeCard({
				name: 'Synthetic Scout Alpha',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Creature — Scout',
				power: '2',
				toughness: '1'
			});
			const tieB = makeCard({
				name: 'Synthetic Scout Beta',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Creature — Scout',
				power: '1',
				toughness: '1'
			});
			const bolsterSpell = makeCard({
				name: 'Synthetic Dromoka Blessing',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Bolster 2.'
			});

			assert.equal(definitionSupportReport(compileCard(bolsterSpell)).fullySupported, true);

			putInZone(state, p1, bigWall, 'battlefield');
			const a = putInZone(state, p1, tieA, 'battlefield');
			const b = putInZone(state, p1, tieB, 'battlefield');
			const s1 = putInZone(state, p1, bolsterSpell, 'hand');
			const s2 = putInZone(state, p1, bolsterSpell, 'hand');

			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: s1.instanceId }).ok,
				true
			);
			passAllPriority(state);

			// Tie between tieA (2/1) and tieB (1/1); bigWall (0/5) is NOT a candidate!
			assert.equal(state.pendingPrompts.length, 1);
			const pr = state.pendingPrompts[0];
			assert.equal(pr.choice?.kind, 'chooseObjects');
			if (pr.choice?.kind === 'chooseObjects') {
				assert.equal(pr.choice.candidates.length, 2);
				assert.equal(pr.choice.candidates.includes(a.instanceId), true);
				assert.equal(pr.choice.candidates.includes(b.instanceId), true);
			}

			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(
				applyGameAction(state, state.players[0].playerId, {
					type: 'choice',
					promptId: pr.id,
					answer: { kind: 'chooseObjects', objectIds: [a.instanceId] }
				}).ok,
				true
			);
			passAllPriority(state);

			// Now tieA is 4/3, tieB is 1/1 (sole minimum toughness), so a second Bolster 2 auto-picks tieB without prompting!
			assert.equal(
				applyGameAction(state, state.players[0].playerId, {
					type: 'cast_spell',
					instanceId: s2.instanceId
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(state.pendingPrompts.length, 0);
			const updatedB = state.players[0].battlefield.find((c) => c.instanceId === b.instanceId)!;
			assert.equal(updatedB.counters['+1/+1'], 2);
		});

		it('compiles and resolves Support N on permanents (other target creatures) vs spells (any target creatures)', () => {
			const state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 10);

			const ally1 = makeCard({
				name: 'Synthetic Cadet One',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Creature — Soldier',
				power: '1',
				toughness: '1'
			});
			const supportCreature = makeCard({
				name: 'Synthetic Support Captain',
				manaCost: '{3}{W}',
				cmc: 4,
				typeLine: 'Creature — Kor Soldier',
				power: '3',
				toughness: '2',
				oracleText: 'When ~ enters, support 2.'
			});
			const supportSpell = makeCard({
				name: 'Synthetic Rally Formation',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Sorcery',
				oracleText: 'Support 2. Draw a card.'
			});

			const compiledPerm = compileCard(supportCreature);
			const compiledSpell = compileCard(supportSpell);
			assert.equal(definitionSupportReport(compiledPerm).fullySupported, true);
			assert.equal(definitionSupportReport(compiledSpell).fullySupported, true);

			// Permanent support sets filter.other === true; spell support does not.
			const permTrig = compiledPerm.faces[0].abilities.find((a) => a.kind === 'triggered');
			assert.ok(permTrig && permTrig.kind === 'triggered');
			assert.equal(permTrig.targets[0].filter.other, true);
			const spellAb = compiledSpell.faces[0].abilities.find((a) => a.kind === 'spell');
			assert.ok(spellAb && spellAb.kind === 'spell');
			assert.equal(spellAb.targets[0].filter.other, undefined);

			const c1 = putInZone(state, p1, ally1, 'battlefield');
			const cap = putInZone(state, p1, supportCreature, 'hand');
			const sp = putInZone(state, p1, supportSpell, 'hand');
			putInZone(state, p1, ally1, 'library');

			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: cap.instanceId }).ok,
				true
			);
			passAllPriority(state);
			if (state.pendingPrompts.length > 0) {
				const pr = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'chooseObjects', objectIds: [c1.instanceId] }
					}).ok,
					true
				);
				passAllPriority(state);
			}
			const bfCap = p1.battlefield.find((c) => c.instanceId === cap.instanceId)!;
			assert.ok(bfCap);
			assert.equal(c1.counters['+1/+1'], 1);
			assert.equal(bfCap.counters['+1/+1'] ?? 0, 0);

			// Spell Support 2 can target BOTH c1 and bfCap!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: sp.instanceId,
					targets: [
						{ kind: 'permanent', id: c1.instanceId, label: 'c1' },
						{ kind: 'permanent', id: bfCap.instanceId, label: 'bfCap' }
					]
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(c1.counters['+1/+1'], 2);
			assert.equal(bfCap.counters['+1/+1'], 1);
		});

		it('executes Adapt N iff permanent has no +1/+1 counters (CR 701.46a) and supports Convert + Adapt', () => {
			const state = createGame(2);
			const p1 = state.players[0];
			addMana(p1, 15);

			const biomancer = makeCard({
				name: 'Synthetic Simic Adept',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Creature — Merfolk Wizard',
				power: '1',
				toughness: '1',
				oracleText: '{1}{U}: Adapt 2.'
			});
			const convertDfc = makeCard({
				name: 'Synthetic Automaton Front // Synthetic Automaton Back',
				layout: 'transform',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Robot',
				power: '2',
				toughness: '2',
				oracleText: '{3}: Convert ~, then adapt 3.',
				faces: [
					{
						name: 'Synthetic Automaton Front',
						manaCost: '{2}',
						typeLine: 'Creature — Robot',
						oracleText: '{3}: Convert ~, then adapt 3.',
						power: '2',
						toughness: '2',
						colors: [],
						imageUrl: ''
					},
					{
						name: 'Synthetic Automaton Back',
						manaCost: '',
						typeLine: 'Artifact Creature — Robot',
						oracleText: 'Flying',
						power: '4',
						toughness: '4',
						colors: [],
						imageUrl: ''
					}
				]
			});

			assert.equal(definitionSupportReport(compileCard(biomancer)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(convertDfc)).fullySupported, true);

			const bioInst = putInZone(state, p1, biomancer, 'battlefield');
			const botInst = putInZone(state, p1, convertDfc, 'battlefield');
			// Non-+1/+1 counters do NOT block Adapt!
			bioInst.counters['shield'] = 1;

			const bioAb = getEffectiveActivatedAbilities(state, p1, bioInst);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: bioInst.instanceId,
					abilityId: bioAb[0].id
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(bioInst.counters['+1/+1'], 2);

			// Second Adapt while having +1/+1 counters does nothing.
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: bioInst.instanceId,
					abilityId: bioAb[0].id
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(bioInst.counters['+1/+1'], 2);

			// Removing all +1/+1 counters allows Adapt to put counters again.
			bioInst.counters['+1/+1'] = 0;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: bioInst.instanceId,
					abilityId: bioAb[0].id
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(bioInst.counters['+1/+1'], 2);

			// Convert ~, then adapt 3.
			const botAb = getEffectiveActivatedAbilities(state, p1, botInst);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: botInst.instanceId,
					abilityId: botAb[0].id
				}).ok,
				true
			);
			passAllPriority(state);
			assert.equal(botInst.transformed, true);
			assert.equal(botInst.counters['+1/+1'], 3);
		});
	});

	describe('9. Card-rename invariance (ENGINE_INVARIANTS.md)', () => {
		it('produces identical compiled steps and runtime state regardless of card name', () => {
			const makeVariant = (name: string) =>
				makeCard({
					name,
					manaCost: '{2}{B}',
					cmc: 3,
					typeLine: 'Sorcery',
					oracleText: `Amass Orcs 2. Incubate 2. Bolster 1.`
				});

			const cardA = makeVariant('Alpha Arbitrary Title');
			const cardB = makeVariant('Omega Completely Unrelated Title');
			assert.deepEqual(
				compileCard(cardA).faces[0].abilities,
				compileCard(cardB).faces[0].abilities
			);
		});
	});
});
