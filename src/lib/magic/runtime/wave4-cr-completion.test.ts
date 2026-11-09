import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	advancePhaseOrStep,
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	executeProliferate,
	resolveTopOfStack
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbyRulesConfig,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';
import { subscribeEvents } from './events.ts';
import { mulliganRedraw } from './zones.ts';

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

function makeGame(
	playerCount = 2,
	ruleOverrides: Partial<LobbyRulesConfig> = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
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
	const state = createInitialGameState('WAVE4_CR_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		...ruleOverrides
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

describe('Wave 4 CR Completion: CR 103.5 / 103.5c / 103.8a — Pregame Mulligan & Turn-1 Draw', () => {
	it('suppresses in-game triggers during pregame mulligan and enforces london_standard (0 free) & Turn 1 draw skip (CR 103.5, 103.5c, 103.8a)', () => {
		const spellDeck: MagicDeck = {
			...PRECON_DECKS[0],
			cards: [{ card: staple('Counterspell'), quantity: 99 }]
		};
		const botSeats: LobbySeat[] = [
			{
				seatIndex: 0,
				userId: 'p1',
				username: 'P1',
				avatarUrl: '',
				isBot: false,
				deckId: spellDeck.id,
				deckName: spellDeck.name,
				commanderNames: spellDeck.commanders.map((c) => c.name),
				commanderArtUrl: '',
				colorIdentity: spellDeck.colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: Date.now()
			},
			{
				seatIndex: 1,
				userId: null,
				username: 'Bot 2',
				avatarUrl: '',
				isBot: true,
				deckId: spellDeck.id,
				deckName: spellDeck.name,
				commanderNames: spellDeck.commanders.map((c) => c.name),
				commanderArtUrl: '',
				colorIdentity: spellDeck.colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: Date.now()
			}
		];

		// 1. Under london_standard, bot with 0 lands in opening hand takes a mulligan, increments mulliganCount to 1, and bottoms 1 card (hand size 6)
		const state = createInitialGameState(
			'MULL_STD',
			botSeats,
			new Map([
				[0, spellDeck],
				[1, spellDeck]
			]),
			{
				...DEFAULT_LOBBY_RULES,
				mulliganRule: 'london_standard' as LobbyRulesConfig['mulliganRule'],
				firstTurnDraw: false
			}
		);
		const p1 = state.players[0];
		const bot2 = state.players[1];
		assert.equal(bot2.mulliganCount, 1);
		assert.equal(bot2.hand.length, 6);

		// 2. Pregame mulligan redraw with { emit: false } emits 0 ZoneChange events, and mulligan_take does not fire battlefield zone-change triggers
		putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Leave Watcher',
				typeLine: 'Enchantment',
				oracleText: 'Whenever a card leaves your hand, you gain 1 life.'
			}),
			'battlefield'
		);
		let emittedEvents = 0;
		const unsub = subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'ZoneChange') emittedEvents++;
		});
		try {
			mulliganRedraw(state, p1, { emit: false });
		} finally {
			unsub();
		}
		assert.equal(emittedEvents, 0);

		// Human takes 1 mulligan under london_standard -> requires bottoming 1 card (0 free mulligans)
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_take' }).ok, true);
		assert.equal(p1.mulliganCount, 1);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'mulligan_keep' }).ok, true);
		const bottomPrompt = state.pendingPrompts.find(
			(pr) => pr.playerId === p1.playerId && pr.kind === 'london_bottom'
		);
		assert.ok(bottomPrompt, 'Expected london_bottom prompt after 1st mulligan under london_standard');
		assert.equal(bottomPrompt.countRequired, 1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'london_bottom',
				instanceIds: [p1.hand[0].instanceId]
			}).ok,
			true
		);
		assert.equal(p1.hand.length, 6);
		assert.equal(state.status, 'active');

		// 3. CR 103.8a: In a 2-player game with firstTurnDraw: false, starting player (seat 0) skips Turn 1 draw,
		//    while Player 2 (seat 1) draws on their first turn!
		const p1HandBeforeTurn1 = p1.hand.length;
		state.phase = 'upkeep';
		advancePhaseOrStep(state);
		assert.equal(state.phase, 'draw');
		assert.equal(p1.hand.length, p1HandBeforeTurn1, 'Starting player must skip Turn 1 draw');

		// Now switch to Player 2's first turn (turnNumber is still 1, activePlayerIndex === 1)
		state.activePlayerIndex = 1;
		state.phase = 'upkeep';
		const bot2HandBeforeTurn1 = bot2.hand.length;
		advancePhaseOrStep(state);
		assert.equal(state.phase, 'draw');
		assert.equal(bot2.hand.length, bot2HandBeforeTurn1 + 1, 'Second player must draw on their first turn');
	});
});

describe('Wave 4 CR Completion: CR 113.7a — Source LKI on Ability Activation & Trigger Resolution', () => {
	it('uses the source permanent LKI power/toughness when sacrificed as an activation cost or removed in response (CR 113.7a)', () => {
		const { state, p1, p2 } = makeGame();

		// 1. Activated ability that sacrifices ~ as cost: deals damage equal to ~'s power to target player
		const flingGoblin = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Pyre Brawler',
				typeLine: 'Creature — Goblin Warrior',
				power: '2',
				toughness: '2',
				oracleText: 'Sacrifice Pyre Brawler: Pyre Brawler deals damage equal to its power to any target.'
			}),
			'battlefield'
		);
		// Give Pyre Brawler three +1/+1 counters so its effective power on the battlefield is 5 (printed is 2)
		flingGoblin.counters['+1/+1'] = 3;

		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: flingGoblin.instanceId,
			abilityId: 'act_0',
			targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
		});
		assert.equal(actRes.ok, true);
		// Pyre Brawler is now in the graveyard with counters reset, and its ability is on the stack
		assert.equal(p1.battlefield.length, 0);
		assert.equal(state.stack.length, 1);

		resolveTopOfStack(state);
		// Must deal 5 damage (LKI power with +1/+1 counters), not 2 (printed power)!
		assert.equal(p2.life, 35);

		// 2. Activated ability whose source is pumped (+4/+4 -> power 6) and then destroyed in response before resolution
		const archer = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mighty Bowmaster',
				typeLine: 'Creature — Elf Archer',
				power: '2',
				toughness: '2',
				oracleText: '{T}: Mighty Bowmaster deals damage equal to its power to any target.'
			}),
			'battlefield'
		);
		const actRes2 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: archer.instanceId,
			abilityId: 'act_0',
			targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
		});
		assert.equal(actRes2.ok, true);

		// Pump Mighty Bowmaster to 6/6 while its ability is on the stack, then destroy it before the ability resolves
		archer.tempPowerMod = 4;
		archer.tempToughnessMod = 4;
		const murder = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Instant Doom',
				typeLine: 'Instant',
				manaCost: '{0}',
				cmc: 0,
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: murder.instanceId,
				targets: [{ kind: 'permanent', id: archer.instanceId, label: archer.card.name }]
			}).ok,
			true
		);
		// Resolve Instant Doom -> Mighty Bowmaster dies with LKI power 6
		resolveTopOfStack(state);
		assert.equal(p1.battlefield.length, 0);

		// Now resolve Mighty Bowmaster's ability -> must deal 6 damage (its LKI power when it left the battlefield)!
		resolveTopOfStack(state);
		assert.equal(p2.life, 29);
	});
});

describe('Wave 4 CR Completion: CR 701.31a — Full Proliferate Across Counter Kinds & Battlefields', () => {
	it('adds one of each counter kind already present on permanents across battlefields and players (CR 701.31a)', () => {
		const { state, p1, p2 } = makeGame();

		// P1 permanent with multiple counter kinds: +1/+1, charge, lore, time, shield
		const sagaArtifact = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Chronicle Engine',
				typeLine: 'Artifact Creature — Construct',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		sagaArtifact.counters['+1/+1'] = 1;
		sagaArtifact.counters.charge = 2;
		sagaArtifact.counters.lore = 1;
		sagaArtifact.counters.time = 3;
		sagaArtifact.counters.shield = 1;

		// P2 (opponent) creature with -1/-1 and stun counters
		const oppCreature = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Blighted Guard',
				typeLine: 'Creature — Soldier',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		oppCreature.counters['-1/-1'] = 1;
		oppCreature.counters.stun = 1;

		// P2 has 2 poison counters; P1 has 1 experience counter and 2 energy counters
		p2.poison = 2;
		p1.experienceCounters = 1;
		p1.energyCounters = 2;

		executeProliferate(state, p1);

		assert.equal(sagaArtifact.counters['+1/+1'], 2);
		assert.equal(sagaArtifact.counters.charge, 3);
		assert.equal(sagaArtifact.counters.lore, 2);
		assert.equal(sagaArtifact.counters.time, 4);
		assert.equal(sagaArtifact.counters.shield, 2);

		assert.equal(oppCreature.counters['-1/-1'], 2);
		assert.equal(oppCreature.counters.stun, 2);
		assert.equal(p2.poison, 3);
		assert.equal(p1.experienceCounters, 2);
		assert.equal(p1.energyCounters, 3);
	});
});

describe('Wave 4 CR Completion: CR 702.6a — Equip [quality] Target Restriction', () => {
	it('enforces Equip legendary creature and Equip Knight target restrictions on activation and resolution (CR 702.6a)', () => {
		const { state, p1 } = makeGame();
		p1.manaPool = { W: 5, U: 5, B: 5, R: 5, G: 5, C: 5 };

		const regularBear = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Grizzly Bears',
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const legendaryElf = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Ezuri, Renegade Leader',
				typeLine: 'Legendary Creature — Elf Warrior',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const knight = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Silver Knight',
				typeLine: 'Creature — Human Knight',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		const legendaryBlade = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Heroic Blade',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+2.\nEquip legendary creature {1}'
			}),
			'battlefield'
		);
		const knightLance = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Jousting Lance',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+0.\nEquip Knight {2}'
			}),
			'battlefield'
		);

		// 1. Heroic Blade ("Equip legendary creature {1}") rejects non-legendary Grizzly Bears and Silver Knight
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: legendaryBlade.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: regularBear.instanceId, label: regularBear.card.name }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: legendaryBlade.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knight.instanceId, label: knight.card.name }]
			}).ok,
			false
		);
		// Accepts legendary creature Ezuri
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: legendaryBlade.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: legendaryElf.instanceId, label: legendaryElf.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(legendaryBlade.attachedToId, legendaryElf.instanceId);

		// 2. Jousting Lance ("Equip Knight {2}") rejects non-Knight Ezuri, accepts Silver Knight
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: knightLance.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: legendaryElf.instanceId, label: legendaryElf.card.name }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: knightLance.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knight.instanceId, label: knight.card.name }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(knightLance.attachedToId, knight.instanceId);
	});
});

describe('Wave 4 CR Completion: CR 702.21a — Ward [cost] Triggered Ability', () => {
	it('triggers Ward {2} and Ward—Pay 3 life when targeted by an opponent spell or ability, countering unless paid (CR 702.21a)', () => {
		const { state, p1, p2 } = makeGame();

		const wardCreature = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Sanctuary Guardian',
				typeLine: 'Creature — Drake',
				power: '3',
				toughness: '3',
				oracleText: 'Ward {2}',
				keywords: ['Ward']
			}),
			'battlefield'
		);

		// 1. P2 casts a spell targeting Sanctuary Guardian with 0 mana remaining -> Ward {2} triggers and counters the spell!
		const bolt1 = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Arcane Bolt',
				typeLine: 'Instant',
				manaCost: '{R}',
				cmc: 1,
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		p2.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt1.instanceId,
				targets: [{ kind: 'permanent', id: wardCreature.instanceId, label: wardCreature.card.name }]
			}).ok,
			true
		);
		// Stack has [Arcane Bolt, Ward trigger]
		assert.equal(state.stack.length, 2);
		assert.equal(state.stack[1].kind, 'triggered');

		// Resolve Ward trigger -> P2 cannot pay {2}, so Arcane Bolt is countered!
		resolveTopOfStack(state);
		assert.equal(state.stack.length, 0);
		assert.equal(p1.battlefield.some((c) => c.instanceId === wardCreature.instanceId), true);
		assert.equal(p2.graveyard.some((c) => c.instanceId === bolt1.instanceId), true);

		// 2. P2 casts a spell targeting Sanctuary Guardian with {2} mana available -> P2 pays {2} and the spell resolves!
		const bolt2 = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Second Bolt',
				typeLine: 'Instant',
				manaCost: '{R}',
				cmc: 1,
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		p2.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 2 };
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt2.instanceId,
				targets: [{ kind: 'permanent', id: wardCreature.instanceId, label: wardCreature.card.name }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2);
		// Resolve Ward trigger -> P2 pays {2} (C drops from 2 to 0), Second Bolt stays on stack
		resolveTopOfStack(state);
		assert.equal(p2.manaPool.C, 0);
		assert.equal(state.stack.length, 1);
		// Resolve Second Bolt -> Sanctuary Guardian is destroyed
		resolveTopOfStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === wardCreature.instanceId), false);

		// 3. Ward—Pay 3 life triggered by an opponent's activated ability (both paid and unpaid/declined)
		const lifeWardCreature = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Bloodshield Paladin',
				typeLine: 'Creature — Vampire Knight',
				power: '3',
				toughness: '3',
				oracleText: 'Ward—Pay 3 life',
				keywords: ['Ward']
			}),
			'battlefield'
		);
		const pinger = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Cunning Assassin',
				typeLine: 'Creature — Human Assassin',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Destroy target creature.'
			}),
			'battlefield'
		);

		// 3a. P2 activates ability when P2 has only 2 life (cannot pay 3 life) -> ability is countered by Ward!
		p2.life = 2;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: pinger.instanceId,
				abilityId: 'act_0',
				targets: [
					{ kind: 'permanent', id: lifeWardCreature.instanceId, label: lifeWardCreature.card.name }
				]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2);
		resolveTopOfStack(state);
		assert.equal(state.stack.length, 0);
		assert.equal(p2.life, 2);
		assert.equal(p1.battlefield.some((c) => c.instanceId === lifeWardCreature.instanceId), true);

		// 3b. P2 activates ability when P2 has 20 life -> P2 pays 3 life (20 -> 17) and ability resolves!
		pinger.tapped = false;
		p2.life = 20;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: pinger.instanceId,
				abilityId: 'act_0',
				targets: [
					{ kind: 'permanent', id: lifeWardCreature.instanceId, label: lifeWardCreature.card.name }
				]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2);
		resolveTopOfStack(state);
		assert.equal(p2.life, 17);
		assert.equal(state.stack.length, 1);
		resolveTopOfStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === lifeWardCreature.instanceId), false);
	});
});
