import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	resolveTopOfStack
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { validateCommanderDeck } from '../scryfall.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type TargetRef,
	type ZoneType
} from '../types.ts';
import { subscribeEvents } from './events.ts';
import {
	devotion,
	executeEffectSteps,
	INTERPRETED_VERBS,
	interpretableNow,
	staticallyInterpretable
} from './effects.ts';
import { matchesObjectFilter, objectPower, splitTypeLine } from './objectFilter.ts';

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

function staple(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	assert.ok(c, `missing staple ${name}`);
	return c;
}

function syntheticCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `syn_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false
	};
}

function makeGame(playerCount = 2): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [];
	const decks = new Map<number, (typeof PRECON_DECKS)[number]>();
	for (let i = 0; i < playerCount; i++) {
		const d = PRECON_DECKS[i % PRECON_DECKS.length];
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: false,
			deckId: d.id,
			deckName: d.name,
			commanderNames: d.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		});
		decks.set(i, d);
	}
	const state = createInitialGameState('WAVE_3DE_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES
	});
	for (let i = 0; i < playerCount; i++) {
		applyGameAction(state, `p${i + 1}`, { type: 'mulligan_keep' });
	}
	for (let i = 0; i < playerCount; i++) {
		state.players[i].hand = [];
		state.players[i].battlefield = [];
		state.players[i].graveyard = [];
		state.players[i].exile = [];
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: Exclude<ZoneType, 'stack'>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	player[zone].push(inst);
	return inst;
}

function makeDummyItem(
	controller: PlayerGameState,
	sourceCard: ScryfallCard,
	sourceId = 'src_dummy',
	targets: TargetRef[] = []
): StackItem {
	return {
		id: `stk_${sourceId}`,
		sourceInstanceId: sourceId,
		card: sourceCard,
		ownerId: controller.playerId,
		controllerId: controller.playerId,
		kind: 'spell',
		title: sourceCard.name,
		oracleText: sourceCard.oracleText,
		targets,
		xValue: 0,
		castMode: 'normal',
		requiresGuidedResolution: false,
		createdAt: Date.now()
	};
}

describe('Wave 3D/3E: Unified Damage Pipeline (CR 120.3, 702.2, 702.15, 702.16b, 702.80, 702.90)', () => {
	it('prevents damage via Protection (CR 702.16b), damagePreventionShield (CR 120.3), and shield counters (CR 122.1c)', () => {
		const { state, p1, p2 } = makeGame();
		const redSource = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Cinder Mage',
				typeLine: 'Creature — Human Wizard',
				colors: ['R'],
				power: '2',
				toughness: '2',
				oracleText: 'Deathtouch, lifelink',
				keywords: ['Deathtouch', 'Lifelink']
			}),
			'battlefield'
		);

		const proRed = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Sanctum Paladin',
				typeLine: 'Creature — Human Knight',
				power: '2',
				toughness: '2',
				oracleText: 'Protection from red',
				keywords: ['Protection']
			}),
			'battlefield'
		);
		const shieldedPerm = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Ward Bear',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '4'
			}),
			'battlefield'
		);
		(shieldedPerm as CardInstance & { damagePreventionShield?: number }).damagePreventionShield = 2;

		const shieldCounterPerm = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Broker Veteran',
				typeLine: 'Creature — Cat Citizen',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		shieldCounterPerm.counters.shield = 1;

		const item = makeDummyItem(p1, redSource.card, redSource.instanceId);
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: redSource.instanceId,
				sourceCard: redSource.card,
				title: redSource.card.name,
				item,
				targets: [],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'damage',
					subject: { k: 'all', filter: { zone: 'battlefield', controller: 'opponent', types: ['Creature'] } },
					amount: { k: 'const', n: 3 },
					span: { start: 0, end: 0 }
				}
			]
		);

		// Protection from red prevents all 3 damage
		assert.equal(proRed.damageMarked, 0);
		assert.equal(proRed.deathtouchDamageMarked, false);

		// damagePreventionShield = 2 prevents 2 of 3 damage -> 1 damage marked + deathtouch
		assert.equal(
			(shieldedPerm as CardInstance & { damagePreventionShield?: number }).damagePreventionShield,
			0
		);
		assert.equal(shieldedPerm.damageMarked, 1);
		assert.equal(shieldedPerm.deathtouchDamageMarked, true);

		// Shield counter prevents the remaining 3 damage and removes 1 shield counter
		assert.equal(shieldCounterPerm.counters.shield, 0);
		assert.equal(shieldCounterPerm.damageMarked, 0);
		assert.equal(shieldCounterPerm.deathtouchDamageMarked, false);

		// Lifelink gained only the 1 unprevented damage dealt
		assert.equal(p1.life, 41);
	});

	it('removes loyalty counters from Planeswalkers on all-damage, places -1/-1 counters for Wither/Infect, and gives poison counters + Lifelink on players', () => {
		const { state, p1, p2 } = makeGame();
		const infectSource = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Blight Spitter',
				typeLine: 'Creature — Phyrexian Horror',
				power: '3',
				toughness: '3',
				oracleText: 'Infect\nLifelink',
				keywords: ['Infect', 'Lifelink']
			}),
			'battlefield'
		);
		const walker = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Test Planeswalker',
				typeLine: 'Legendary Planeswalker — Jace',
				loyalty: '5'
			}),
			'battlefield'
		);
		walker.counters.loyalty = 5;

		const creature = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Test Giant',
				typeLine: 'Creature — Giant',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);

		const item = makeDummyItem(p1, infectSource.card, infectSource.instanceId);
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: infectSource.instanceId,
				sourceCard: infectSource.card,
				title: infectSource.card.name,
				item,
				targets: [],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'damage',
					subject: { k: 'all', filter: { zone: 'battlefield', controller: 'opponent' } },
					amount: { k: 'const', n: 2 },
					span: { start: 0, end: 0 }
				},
				{
					verb: 'damage',
					subject: { k: 'player', filter: { relation: 'each_opponent' } },
					amount: { k: 'const', n: 3 },
					span: { start: 0, end: 0 }
				}
			]
		);

		// Planeswalker lost 2 loyalty counters even on sel.k === 'all' (CR 120.3c / 306.8)
		assert.equal(walker.counters.loyalty, 3);
		assert.equal(walker.damageMarked, 0);

		// Creature got 2 -1/-1 counters instead of damageMarked (CR 702.90b)
		assert.equal(creature.counters['-1/-1'], 2);
		assert.equal(creature.damageMarked, 0);

		// Opponent player got 3 poison counters instead of losing life (CR 702.90b)
		assert.equal(p2.poison, 3);
		assert.equal(p2.life, 40);

		// Lifelink gained 2 (walker) + 2 (creature) + 3 (player) = 7 life (CR 702.15)
		assert.equal(p1.life, 47);

		// Wither source places -1/-1 counters on creatures but deals normal life loss to players (CR 702.80)
		const witherSource = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Ashling Punisher',
				typeLine: 'Creature — Elemental',
				power: '2',
				toughness: '2',
				oracleText: 'Wither',
				keywords: ['Wither']
			}),
			'battlefield'
		);
		p2.damagePreventionShield = 1;
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: witherSource.instanceId,
				sourceCard: witherSource.card,
				title: witherSource.card.name,
				item: makeDummyItem(p1, witherSource.card, witherSource.instanceId),
				targets: [],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'damage',
					subject: { k: 'all', filter: { zone: 'battlefield', controller: 'opponent', types: ['Creature'] } },
					amount: { k: 'const', n: 1 },
					span: { start: 0, end: 0 }
				},
				{
					verb: 'damage',
					subject: { k: 'player', filter: { relation: 'each_opponent' } },
					amount: { k: 'const', n: 3 },
					span: { start: 0, end: 0 }
				}
			]
		);
		assert.equal(creature.counters['-1/-1'], 3);
		assert.equal(p2.damagePreventionShield, 0);
		assert.equal(p2.life, 38);
	});
});

describe('Wave 3D: Fight Keyword Action (CR 701.12b/c)', () => {
	it('resolves fight between two creatures, self-fight (2x power), and no-ops if either is non-creature or off-battlefield', () => {
		assert.equal(INTERPRETED_VERBS.has('fight' as never), true);

		const { state, p1, p2 } = makeGame();
		const tracker = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Apex Tracker',
				typeLine: 'Creature — Beast',
				power: '3',
				toughness: '4',
				oracleText: 'Deathtouch, lifelink',
				keywords: ['Deathtouch', 'Lifelink']
			}),
			'battlefield'
		);
		const ogre = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Cave Ogre',
				typeLine: 'Creature — Ogre',
				power: '2',
				toughness: '5'
			}),
			'battlefield'
		);

		const targets: TargetRef[] = [
			{ kind: 'permanent', id: tracker.instanceId, label: tracker.card.name },
			{ kind: 'permanent', id: ogre.instanceId, label: ogre.card.name }
		];
		const fightSpell = syntheticCard({ name: 'Pit Brawl' });
		const item = makeDummyItem(p1, fightSpell, 'stk_fight', targets);
		const fightStep = {
			verb: 'fight' as never,
			subject: { k: 'target' as const, index: 0 },
			params: { with: { k: 'target' as const, index: 1 } } as never,
			span: { start: 0, end: 0 }
		};
		const targetSpecs = [
			{ kind: 'object' as const, filter: { zone: 'battlefield' as const, types: ['Creature'] }, min: 1, max: 1 },
			{ kind: 'object' as const, filter: { zone: 'battlefield' as const, types: ['Creature'] }, min: 1, max: 1 }
		];
		assert.equal(staticallyInterpretable({ steps: [fightStep], targets: targetSpecs, unparsed: [] }), true);
		assert.equal(interpretableNow(state, item, { steps: [fightStep], targets: targetSpecs }, p1, false), true);

		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: item.sourceInstanceId,
				sourceCard: fightSpell,
				title: fightSpell.name,
				item,
				targets,
				targetSpecs,
				xValue: 0
			},
			[fightStep]
		);

		assert.equal(ogre.damageMarked, 3);
		assert.equal(ogre.deathtouchDamageMarked, true);
		assert.equal(tracker.damageMarked, 2);
		assert.equal(p1.life, 43);

		// CR 701.12c: A creature fighting itself deals twice its power to itself
		const selfFighter = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mirror Brawler',
				typeLine: 'Creature — Berserker',
				power: '2',
				toughness: '6'
			}),
			'battlefield'
		);
		const selfTargets: TargetRef[] = [
			{ kind: 'permanent', id: selfFighter.instanceId, label: selfFighter.card.name },
			{ kind: 'permanent', id: selfFighter.instanceId, label: selfFighter.card.name }
		];
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: 'stk_self_fight',
				sourceCard: fightSpell,
				title: fightSpell.name,
				item: makeDummyItem(p1, fightSpell, 'stk_self_fight', selfTargets),
				targets: selfTargets,
				targetSpecs,
				xValue: 0
			},
			[fightStep]
		);
		assert.equal(selfFighter.damageMarked, 4);

		// CR 701.12b: If either is not a creature (e.g. Song of the Dryads), neither deals damage
		const dryadSong = putInZone(state, p2, staple('Song of the Dryads'), 'battlefield');
		dryadSong.attachedToId = selfFighter.instanceId;
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: 'stk_noncreature_fight',
				sourceCard: fightSpell,
				title: fightSpell.name,
				item: makeDummyItem(p1, fightSpell, 'stk_noncreature_fight', [
					{ kind: 'permanent', id: selfFighter.instanceId, label: selfFighter.card.name },
					{ kind: 'permanent', id: ogre.instanceId, label: ogre.card.name }
				]),
				targets: [
					{ kind: 'permanent', id: selfFighter.instanceId, label: selfFighter.card.name },
					{ kind: 'permanent', id: ogre.instanceId, label: ogre.card.name }
				],
				targetSpecs,
				xValue: 0
			},
			[fightStep]
		);
		assert.equal(ogre.damageMarked, 3);
	});
});

describe('Wave 3D: Effect Fixes (CR 101.4, 122.1c-d, 603.10a, 613.7e, 700.5, 701.3b, 701.8, 701.19)', () => {
	it('handles simultaneous Run.destroy with shield counters (CR 122.1c) and look-back dies triggers (CR 603.10a)', () => {
		const { state, p1, p2 } = makeGame();
		const bloodArtist = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Soul Celebrant',
				typeLine: 'Creature — Vampire',
				power: '1',
				toughness: '1',
				oracleText: 'Whenever another creature dies, each opponent loses 1 life.'
			}),
			'battlefield'
		);
		const bear1 = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Bear One', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const bear2 = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Bear Two', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const shielded = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Shielded Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		shielded.counters.shield = 1;

		const wrath = syntheticCard({
			name: 'Total Judgment',
			typeLine: 'Sorcery',
			oracleText: 'Destroy all creatures.'
		});
		const item = makeDummyItem(p1, wrath, 'stk_wrath');
		state.stack.push(item);
		resolveTopOfStack(state);

		// Shielded Bear survived with 0 shield counters; the other 3 died simultaneously
		assert.equal(p2.battlefield.some((c) => c.instanceId === shielded.instanceId), true);
		assert.equal(shielded.counters.shield, 0);
		assert.equal(p1.battlefield.length, 0);
		assert.equal(p1.graveyard.some((c) => c.instanceId === bloodArtist.instanceId), true);
		assert.equal(p1.graveyard.some((c) => c.instanceId === bear1.instanceId), true);
		assert.equal(p2.graveyard.some((c) => c.instanceId === bear2.instanceId), true);

		resolveTriggers(state);
		// Soul Celebrant ("Whenever another creature dies") saw both Bear One and Bear Two die simultaneously!
		assert.equal(p2.life, 38);
	});

	it('orders players in APNAP order starting from state.activePlayerIndex (CR 101.4)', () => {
		const { state, p1, p2 } = makeGame(3);
		const p3 = state.players[2];
		state.activePlayerIndex = 1; // P2 is the active player

		for (const pl of [p1, p2, p3]) {
			putInZone(state, pl, staple('Forest'), 'library');
		}
		const drawAll = syntheticCard({ name: 'Collective Insight' });
		state.log = [];
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: 'stk_apnap',
				sourceCard: drawAll,
				title: drawAll.name,
				item: makeDummyItem(p1, drawAll, 'stk_apnap'),
				targets: [],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'draw',
					subject: { k: 'player', filter: { relation: 'each_player' } },
					amount: { k: 'const', n: 1 },
					span: { start: 0, end: 0 }
				}
			]
		);

		const drawOrder = state.log.map((l) => l.text.split(' ')[0]);
		assert.deepEqual(drawOrder, ['P2', 'P3', 'P1']);
	});

	it('selects atRandom discard and sacrifice deterministically via nextRandom(state) (CR 701.8 / 701.19)', () => {
		const { state, p1 } = makeGame();
		const c1 = putInZone(state, p1, syntheticCard({ name: 'Card A' }), 'hand');
		const c2 = putInZone(state, p1, syntheticCard({ name: 'Card B' }), 'hand');
		const c3 = putInZone(state, p1, syntheticCard({ name: 'Card C' }), 'hand');
		const c4 = putInZone(state, p1, syntheticCard({ name: 'Card D' }), 'hand');
		void [c1, c2, c3, c4];

		(state as GameState & { rngState?: number }).rngState = 42;
		const dummy = syntheticCard({ name: 'Random Hymn' });
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: 'stk_rand_disc',
				sourceCard: dummy,
				title: dummy.name,
				item: makeDummyItem(p1, dummy, 'stk_rand_disc'),
				targets: [],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'discard' as never,
					subject: { k: 'player', filter: { relation: 'you' } },
					amount: { k: 'const', n: 2 },
					params: { atRandom: true } as never,
					span: { start: 0, end: 0 }
				}
			]
		);
		assert.equal(p1.hand.length, 2);
		assert.equal(p1.graveyard.length, 2);
		const firstRunDiscarded = p1.graveyard.map((c) => c.card.name);

		// Re-running with the same rngState produces the exact same random selection
		const { state: state2, p1: p1b } = makeGame();
		putInZone(state2, p1b, syntheticCard({ name: 'Card A' }), 'hand');
		putInZone(state2, p1b, syntheticCard({ name: 'Card B' }), 'hand');
		putInZone(state2, p1b, syntheticCard({ name: 'Card C' }), 'hand');
		putInZone(state2, p1b, syntheticCard({ name: 'Card D' }), 'hand');
		(state2 as GameState & { rngState?: number }).rngState = 42;
		executeEffectSteps(
			state2,
			{
				controller: p1b,
				sourceId: 'stk_rand_disc',
				sourceCard: dummy,
				title: dummy.name,
				item: makeDummyItem(p1b, dummy, 'stk_rand_disc'),
				targets: [],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'discard' as never,
					subject: { k: 'player', filter: { relation: 'you' } },
					amount: { k: 'const', n: 2 },
					params: { atRandom: true } as never,
					span: { start: 0, end: 0 }
				}
			]
		);
		assert.deepEqual(
			p1b.graveyard.map((c) => c.card.name),
			firstRunDiscarded
		);
	});

	it('makes Run.attach a no-op when already attached (CR 701.3b) and assigns a new timestamp when moving (CR 613.7e)', () => {
		const { state, p1 } = makeGame();
		const host1 = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Host Alpha', typeLine: 'Creature — Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);
		const host2 = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Host Beta', typeLine: 'Creature — Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);
		const equip = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Test Blade',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+0.\nEquip {1}'
			}),
			'battlefield'
		);
		equip.attachedToId = host1.instanceId;
		const oldTs = equip.enteredTimestamp;

		let attachEvents = 0;
		const unsub = subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'Attached') attachEvents++;
		});
		try {
			// Attaching to host1 when already attached to host1 is a no-op (CR 701.3b)
			executeEffectSteps(
				state,
				{
					controller: p1,
					sourceId: equip.instanceId,
					sourceCard: equip.card,
					title: equip.card.name,
					item: makeDummyItem(p1, equip.card, equip.instanceId, [
						{ kind: 'permanent', id: host1.instanceId, label: host1.card.name }
					]),
					targets: [{ kind: 'permanent', id: host1.instanceId, label: host1.card.name }],
					targetSpecs: [],
					xValue: 0
				},
				[{ verb: 'attach', subject: { k: 'target', index: 0 }, span: { start: 0, end: 0 } }]
			);
			assert.equal(attachEvents, 0);
			assert.equal(equip.enteredTimestamp, oldTs);

			// Attaching to host2 updates attachedToId, allocates a new timestamp (CR 613.7e), and emits Attached
			executeEffectSteps(
				state,
				{
					controller: p1,
					sourceId: equip.instanceId,
					sourceCard: equip.card,
					title: equip.card.name,
					item: makeDummyItem(p1, equip.card, equip.instanceId, [
						{ kind: 'permanent', id: host2.instanceId, label: host2.card.name }
					]),
					targets: [{ kind: 'permanent', id: host2.instanceId, label: host2.card.name }],
					targetSpecs: [],
					xValue: 0
				},
				[{ verb: 'attach', subject: { k: 'target', index: 0 }, span: { start: 0, end: 0 } }]
			);
			assert.equal(attachEvents, 1);
			assert.equal(equip.attachedToId, host2.instanceId);
			assert.ok((equip.enteredTimestamp ?? 0) > (oldTs ?? 0));
		} finally {
			unsub();
		}
	});

	it('replaces untapping a tapped permanent with a stun counter by removing 1 stun counter (CR 122.1d)', () => {
		const { state, p1 } = makeGame();
		const perm = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Frozen Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		perm.tapped = true;
		perm.counters.stun = 1;

		const untapSpell = syntheticCard({ name: 'Thaw Out' });
		const targetRef: TargetRef = { kind: 'permanent', id: perm.instanceId, label: perm.card.name };

		// 1st untap: removes 1 stun counter and stays tapped
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: 'stk_untap1',
				sourceCard: untapSpell,
				title: untapSpell.name,
				item: makeDummyItem(p1, untapSpell, 'stk_untap1', [targetRef]),
				targets: [targetRef],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'tapOrUntap' as never,
					subject: { k: 'target', index: 0 },
					params: { tap: false } as never,
					span: { start: 0, end: 0 }
				}
			]
		);
		assert.equal(perm.tapped, true);
		assert.equal(perm.counters.stun, 0);

		// 2nd untap: now untaps normally
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: 'stk_untap2',
				sourceCard: untapSpell,
				title: untapSpell.name,
				item: makeDummyItem(p1, untapSpell, 'stk_untap2', [targetRef]),
				targets: [targetRef],
				targetSpecs: [],
				xValue: 0
			},
			[
				{
					verb: 'tapOrUntap' as never,
					subject: { k: 'target', index: 0 },
					params: { tap: false } as never,
					span: { start: 0, end: 0 }
				}
			]
		);
		assert.equal(perm.tapped, false);
	});

	it('computes devotion skipping face-down permanents, using copiableCard, and counting hybrid symbols once (CR 700.5)', () => {
		const { state, p1 } = makeGame();
		const faceDown = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Hidden Blue', manaCost: '{U}{U}{U}', typeLine: 'Creature — Wizard' }),
			'battlefield'
		);
		faceDown.isFaceDown = true;

		const clone = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Base Clone', manaCost: '{3}{U}', typeLine: 'Creature — Shapeshifter' }),
			'battlefield'
		);
		clone.copiableCard = syntheticCard({
			name: 'Copied Avatar',
			manaCost: '{W/U}{W/U}{U}',
			typeLine: 'Creature — Avatar'
		});

		// Face-down contributes 0; Copied Avatar has {W/U}{W/U}{U}:
		// Devotion to U = 3; Devotion to W = 2; Devotion to W and U (CR 700.5b) = 3 (not 5!)
		assert.equal(devotion(p1, ['U']), 3);
		assert.equal(devotion(p1, ['W']), 2);
		assert.equal(devotion(p1, ['W', 'U']), 3);
	});
});

describe('Wave 3D: Evaluated Colors, Negative P/T, Time Lord & Off-Battlefield CDAs (CR 105.2, 107.1b, 205.3m, 208.2a, 208.3, 702.73a)', () => {
	it('exposes Layer 5 colors on EvaluatedPermanent and uses them in matchesObjectFilter and triggers', () => {
		const { state, p1, p2 } = makeGame();
		const greenBear = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Forest Bear',
				typeLine: 'Creature — Bear',
				colors: ['G'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		assert.deepEqual(evaluatePermanent(state, greenBear).colors, ['G']);
		assert.equal(
			matchesObjectFilter(greenBear, { colors: ['G'] }, { state, controllerId: p1.playerId }),
			true
		);

		// Song of the Dryads makes enchanted permanent a colorless Forest land (Layer 5 colors = [])
		const song = putInZone(state, p2, staple('Song of the Dryads'), 'battlefield');
		song.attachedToId = greenBear.instanceId;
		assert.deepEqual(evaluatePermanent(state, greenBear).colors, []);
		assert.equal(
			matchesObjectFilter(greenBear, { colors: ['G'] }, { state, controllerId: p1.playerId }),
			false
		);

		// Face-down creature is colorless (colors = [])
		const faceDown = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Red Morph',
				typeLine: 'Creature —Beast',
				colors: ['R'],
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		faceDown.isFaceDown = true;
		assert.deepEqual(evaluatePermanent(state, faceDown).colors, []);
		assert.equal(
			matchesObjectFilter(faceDown, { colors: ['R'] }, { state, controllerId: p1.playerId }),
			false
		);
	});

	it('does not clamp negative power in objectPower (CR 107.1b) and returns null power for non-creatures on the battlefield (CR 208.3)', () => {
		const { state, p1, p2 } = makeGame();
		const small = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Tiny Squire', typeLine: 'Creature — Human', power: '1', toughness: '3' }),
			'battlefield'
		);
		small.tempPowerMod = -3; // effective power = -2
		assert.equal(objectPower(state, small), -2);
		assert.equal(
			matchesObjectFilter(
				small,
				{ power: { op: '<', value: { k: 'const', n: 0 } } },
				{ state, controllerId: p1.playerId }
			),
			true
		);

		// Turning Tiny Squire into a non-creature land via Song of the Dryads gives it null power (CR 208.3)
		const song = putInZone(state, p2, staple('Song of the Dryads'), 'battlefield');
		song.attachedToId = small.instanceId;
		assert.equal(objectPower(state, small), null);
		assert.equal(
			matchesObjectFilter(
				small,
				{ power: { op: '<=', value: { k: 'const', n: 2 } } },
				{ state, controllerId: p1.playerId }
			),
			false
		);
	});

	it('evaluates Changeling (CR 702.73a) and Layer 7a */* CDAs (CR 208.2a) in off-battlefield zones, and preserves "Time Lord" (CR 205.3m)', () => {
		const { state, p1 } = makeGame();

		// Off-battlefield Changeling in graveyard matches any creature subtype
		const changelingInGy = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mirror Entity Card',
				typeLine: 'Creature — Shapeshifter',
				oracleText: 'Changeling',
				keywords: ['Changeling'],
				power: '1',
				toughness: '1'
			}),
			'graveyard'
		);
		assert.equal(
			matchesObjectFilter(
				changelingInGy,
				{ zone: 'graveyard', subtypes: ['Dragon'] },
				{ state, controllerId: p1.playerId }
			),
			true
		);
		assert.equal(
			matchesObjectFilter(
				changelingInGy,
				{ zone: 'graveyard', subtypes: ['Equipment'] },
				{ state, controllerId: p1.playerId }
			),
			false
		);

		// Off-battlefield */* CDA in graveyard evaluates against state (CR 208.2a)
		putInZone(
			state,
			p1,
			syntheticCard({ name: 'Elf 1', typeLine: 'Creature — Elf', power: '1', toughness: '1' }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			syntheticCard({ name: 'Elf 2', typeLine: 'Creature — Elf', power: '1', toughness: '1' }),
			'battlefield'
		);
		const starCard = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Star Beast',
				typeLine: 'Creature — Beast',
				power: '*',
				toughness: '*',
				oracleText: "Star Beast's power and toughness are each equal to the number of creatures you control."
			}),
			'graveyard'
		);
		assert.equal(objectPower(state, starCard), 2);
		assert.equal(
			matchesObjectFilter(
				starCard,
				{ zone: 'graveyard', power: { op: '=', value: { k: 'const', n: 2 } } },
				{ state, controllerId: p1.playerId }
			),
			true
		);

		// CR 205.3m: "Time Lord" is a single creature subtype, not "Time" and "Lord"
		const split = splitTypeLine('Legendary Creature — Time Lord Doctor');
		assert.deepEqual(split.subtypes, ['Time Lord', 'Doctor']);

		const doctor = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'The Tenth Doctor',
				typeLine: 'Legendary Creature — Time Lord Doctor',
				power: '3',
				toughness: '5'
			}),
			'battlefield'
		);
		const evDoc = evaluatePermanent(state, doctor);
		assert.equal(evDoc.hasSubType('Time Lord'), true);
		assert.equal(evDoc.hasSubType('Doctor'), true);
		assert.equal(evDoc.hasSubType('Time'), false);
		assert.equal(evDoc.hasSubType('Lord'), false);
	});
});

describe('Wave 3E: Deck Validation — Copy Caps & Partner Variants (CR 100.2a, 702.124)', () => {
	function make98Lands(color: 'W' | 'U' | 'B' | 'R' | 'G' = 'R'): DeckCardEntry[] {
		const landName =
			color === 'W'
				? 'Plains'
				: color === 'U'
					? 'Island'
					: color === 'B'
						? 'Swamp'
						: color === 'R'
							? 'Mountain'
							: 'Forest';
		return [{ card: staple(landName), quantity: 98 }];
	}

	it('enforces Seven Dwarves (<= 7) and Nazgûl (<= 9) copy caps (CR 100.2a / 113.6c)', () => {
		const cmd = syntheticCard({
			name: 'Red Commander',
			typeLine: 'Legendary Creature — Dwarf',
			colors: ['R'],
			colorIdentity: ['R'],
			canBeCommander: true
		});
		const sevenDwarves = syntheticCard({
			name: 'Seven Dwarves',
			typeLine: 'Creature — Dwarf',
			colors: ['R'],
			colorIdentity: ['R'],
			oracleText: 'A deck can have up to seven cards named Seven Dwarves.'
		});
		const legal7 = validateCommanderDeck(
			[cmd],
			[
				{ card: sevenDwarves, quantity: 7 },
				{ card: staple('Mountain'), quantity: 92 }
			]
		);
		assert.equal(legal7.isLegal, true);

		const illegal8 = validateCommanderDeck(
			[cmd],
			[
				{ card: sevenDwarves, quantity: 8 },
				{ card: staple('Mountain'), quantity: 91 }
			]
		);
		assert.equal(illegal8.isLegal, false);

		const blackCmd = syntheticCard({
			name: 'Black Commander',
			typeLine: 'Legendary Creature — Wraith',
			colors: ['B'],
			colorIdentity: ['B'],
			canBeCommander: true
		});
		const nazgul = syntheticCard({
			name: 'Nazgûl',
			typeLine: 'Creature — Wraith Knight',
			colors: ['B'],
			colorIdentity: ['B'],
			oracleText: 'A deck can have up to nine cards named Nazgûl.'
		});
		const legal9 = validateCommanderDeck(
			[blackCmd],
			[
				{ card: nazgul, quantity: 9 },
				{ card: staple('Swamp'), quantity: 90 }
			]
		);
		assert.equal(legal9.isLegal, true);

		const illegal10 = validateCommanderDeck(
			[blackCmd],
			[
				{ card: nazgul, quantity: 10 },
				{ card: staple('Swamp'), quantity: 89 }
			]
		);
		assert.equal(illegal10.isLegal, false);
	});

	it('validates Partner, Partner with [Name], Friends forever, Choose a Background, and Doctor\'s companion pairings (CR 702.124)', () => {
		const genericPartner1 = syntheticCard({
			name: 'Thrasios',
			typeLine: 'Legendary Creature — Merfolk Wizard',
			colorIdentity: ['G', 'U'],
			oracleText: 'Partner',
			keywords: ['Partner'],
			canBeCommander: true,
			hasPartner: true
		});
		const genericPartner2 = syntheticCard({
			name: 'Tymna',
			typeLine: 'Legendary Creature — Human Cleric',
			colorIdentity: ['W', 'B'],
			oracleText: 'Partner',
			keywords: ['Partner'],
			canBeCommander: true,
			hasPartner: true
		});
		const friends1 = syntheticCard({
			name: 'Cecily',
			typeLine: 'Legendary Creature — Human Wizard',
			colorIdentity: ['U', 'B', 'R'],
			oracleText: 'Friends forever',
			keywords: ['Friends forever'],
			canBeCommander: true,
			hasPartner: true
		});
		const friends2 = syntheticCard({
			name: 'Othelm',
			typeLine: 'Legendary Creature — Human',
			colorIdentity: ['G', 'W'],
			oracleText: 'Friends forever',
			keywords: ['Friends forever'],
			canBeCommander: true,
			hasPartner: true
		});
		const partnerWithPir = syntheticCard({
			name: 'Toothy, Imaginary Friend',
			typeLine: 'Legendary Creature — Illusion',
			colorIdentity: ['U'],
			oracleText: 'Partner with Pir, Imaginative Rascal',
			keywords: ['Partner with', 'Partner'],
			canBeCommander: true,
			hasPartner: true
		});
		const pir = syntheticCard({
			name: 'Pir, Imaginative Rascal',
			typeLine: 'Legendary Creature — Human',
			colorIdentity: ['G'],
			oracleText: 'Partner with Toothy, Imaginary Friend',
			keywords: ['Partner with', 'Partner'],
			canBeCommander: true,
			hasPartner: true
		});
		const chooseBg = syntheticCard({
			name: 'Wilson, Refined Grizzly',
			typeLine: 'Legendary Creature — Bear Warrior',
			colorIdentity: ['G'],
			oracleText: 'Choose a Background',
			canBeCommander: true,
			hasChooseBackground: true
		});
		const background = syntheticCard({
			name: 'Raised by Giants',
			typeLine: 'Legendary Enchantment — Background',
			colorIdentity: ['G'],
			isBackground: true
		});
		const doctor = syntheticCard({
			name: 'The Tenth Doctor',
			typeLine: 'Legendary Creature — Time Lord Doctor',
			colorIdentity: ['U', 'R'],
			canBeCommander: true
		});
		const doctorExtraType = syntheticCard({
			name: 'Mutant Doctor',
			typeLine: 'Legendary Creature — Time Lord Doctor Mutant',
			colorIdentity: ['U', 'R'],
			canBeCommander: true
		});
		const companion = syntheticCard({
			name: 'Rose Tyler',
			typeLine: 'Legendary Creature — Human',
			colorIdentity: ['W'],
			oracleText: "Doctor's companion",
			keywords: ["Doctor's companion"],
			canBeCommander: true,
			hasPartner: true
		});

		const lands = make98Lands('G');
		assert.equal(validateCommanderDeck([genericPartner1, genericPartner2], lands).isLegal, true);
		assert.equal(validateCommanderDeck([genericPartner1, friends1], lands).isLegal, false);
		assert.equal(validateCommanderDeck([genericPartner1, partnerWithPir], lands).isLegal, false);
		assert.equal(validateCommanderDeck([friends1, friends2], lands).isLegal, true);
		assert.equal(validateCommanderDeck([partnerWithPir, pir], lands).isLegal, true);
		assert.equal(validateCommanderDeck([chooseBg, background], lands).isLegal, true);
		assert.equal(validateCommanderDeck([chooseBg, genericPartner1], lands).isLegal, false);
		assert.equal(validateCommanderDeck([doctor, companion], make98Lands('U')).isLegal, true);
		assert.equal(validateCommanderDeck([doctorExtraType, companion], make98Lands('U')).isLegal, false);
	});
});
