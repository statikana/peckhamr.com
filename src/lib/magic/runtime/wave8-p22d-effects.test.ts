import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { staticallyInterpretable } from '../compiler/interpretable.ts';
import type { ActivatedAbility } from '../ir.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

function makeCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `p22d_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function playerTarget(player: PlayerGameState): TargetRef {
	return { kind: 'player', id: player.playerId, label: player.username };
}

function roundTripJson(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function stripSpans(val: unknown): unknown {
	if (Array.isArray(val)) return val.map(stripSpans);
	if (val && typeof val === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
			if (k === 'span' || k === 'text' || k === 'name' || k === 'id') continue;
			out[k] = stripSpans(v);
		}
		return out;
	}
	return val;
}

function createGame(): GameState {
	const seats: LobbySeat[] = [0, 1].map((i) => {
		const deck = PRECON_DECKS[i % PRECON_DECKS.length]!;
		return {
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: false,
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
	const decks = new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]!]));
	const state = createInitialGameState('TRACKP22D', seats, decks, { ...DEFAULT_LOBBY_RULES });
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
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
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		...(zone === 'library' ? { insert: 'start' } : {}),
		bumpVersion: true
	});
	inst.summoningSick = false;
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

function firstActivatedId(card: ScryfallCard, index = 0): string {
	const def = compileCard(card);
	const acts = def.faces[0]!.abilities.filter((a): a is ActivatedAbility => a.kind === 'activated');
	assert.ok(acts[index], `Expected activated ability at index ${index} on ${card.name}`);
	return acts[index]!.id;
}

function passPriorityRound(state: GameState): void {
	for (let guard = 0; guard < 16; guard++) {
		const pr = state.pendingPrompts[0];
		if (
			state.pendingPrompts.length === 1 &&
			pr?.purpose === 'trigger_order' &&
			pr.choice?.kind === 'orderObjects'
		) {
			const orderRes = applyGameAction(state, pr.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer: { kind: 'orderObjects', topIds: pr.choice.objectIds }
			});
			assert.equal(orderRes.ok, true, orderRes.error ?? '');
			continue;
		}
		if (state.pendingPrompts.length > 0) return;
		if (state.stack.length === 0) return;
		const prioPlayer = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error ?? '');
	}
}

function answerTopPrompt(state: GameState, answer: ChoiceAnswer): GameState {
	const next = roundTripJson(state);
	const prompt = next.pendingPrompts[0];
	assert.ok(prompt, 'expected a pending prompt');
	const res = applyGameAction(next, prompt.playerId, {
		type: 'choice',
		promptId: prompt.id,
		answer
	});
	assert.equal(res.ok, true, res.error ?? '');
	return next;
}

describe('Wave 8 Track P22d: compiler + interpretable + runtime execution', () => {
	it('compiles target P22d cards with staticallyInterpretable=true and synthetic rename invariance', () => {
		const samples: Array<Partial<ScryfallCard> & { name: string }> = [
			{
				name: 'Dragon Fangs',
				manaCost: '{1}{G}',
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nEnchanted creature gets +1/+1 and has trample.\nWhen a creature with mana value 6 or greater enters, you may return Dragon Fangs from your graveyard to the battlefield attached to that creature.'
			},
			{
				name: 'Restless Spire',
				manaCost: '',
				typeLine: 'Land',
				oracleText:
					'Restless Spire enters tapped.\n{T}: Add {U} or {R}.\n{1}{U}{R}: Until end of turn, Restless Spire becomes a 2/1 blue and red Elemental creature with "During your turn, this creature has first strike." It\'s still a land.'
			},
			{
				name: 'Test of Faith',
				manaCost: '{1}{W}',
				typeLine: 'Instant',
				oracleText:
					'Prevent the next 3 damage that would be dealt to target creature this turn. For each 1 damage prevented this way, put a +1/+1 counter on that creature.'
			},
			{
				name: 'Refraction Trap',
				manaCost: '{3}{W}',
				typeLine: 'Instant — Trap',
				oracleText:
					'Prevent the next 3 damage that a source of your choice would deal to you and/or permanents you control this turn. If damage is prevented this way, Refraction Trap deals that much damage to any target.'
			},
			{
				name: 'Cho-Arrim Alchemist',
				manaCost: '{W}',
				typeLine: 'Creature — Human Spellshaper',
				oracleText:
					'{1}{W}{W}, {T}, Discard a card: The next time a source of your choice would deal damage to you this turn, prevent that damage. You gain life equal to the damage prevented this way.'
			},
			{
				name: 'The Tenth Doctor',
				manaCost: '{3}{U}{R}',
				typeLine: 'Legendary Creature — Time Lord Doctor',
				oracleText:
					"Allons-y! — Whenever you attack, exile cards from the top of your library until you exile a nonland card. Put three time counters on it. If it doesn't have suspend, it gains suspend."
			},
			{
				name: 'Undying Flames',
				manaCost: '{4}{R}{R}',
				typeLine: 'Sorcery',
				oracleText:
					'Exile cards from the top of your library until you exile a nonland card. Undying Flames deals damage equal to that card\'s mana value to any target.'
			},
			{
				name: "Sunbird's Invocation",
				manaCost: '{5}{R}',
				typeLine: 'Enchantment',
				oracleText:
					"Whenever you cast a spell from your hand, reveal the top X cards of your library, where X is that spell's mana value. You may cast a spell with mana value X or less from among them without paying its mana cost. Put the rest on the bottom of your library in a random order."
			},
			{
				name: 'Keldon Flamesage',
				manaCost: '{2}{R}',
				typeLine: 'Creature — Human Shaman',
				oracleText:
					'Whenever Keldon Flamesage attacks, look at the top X cards of your library, where X is its power. You may exile an instant or sorcery card with mana value X or less from among them. Put the rest on the bottom of your library in a random order. You may cast the exiled card without paying its mana cost.'
			},
			{
				name: 'Chaos Wand',
				manaCost: '{3}',
				typeLine: 'Artifact',
				oracleText:
					'{4}, {T}: Target opponent exiles cards from the top of their library until they exile an instant or sorcery card. You may cast that card without paying its mana cost. Then put the exiled cards that weren\'t cast this way on the bottom of that library in a random order.'
			},
			{
				name: 'Martyred Rusalka',
				manaCost: '{W}',
				typeLine: 'Creature — Spirit',
				oracleText: '{W}, Sacrifice a creature: Target creature can\'t attack this turn.'
			},
			{
				name: 'Psychic Rebuttal',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText:
					"Counter target instant or sorcery spell that targets you. If there are two or more instant and/or sorcery cards in your graveyard, you may copy that spell if it's countered this way. You may choose new targets for the copy."
			},
			{
				name: 'Waterbending Lesson',
				manaCost: '{1}{U}',
				typeLine: 'Sorcery — Lesson',
				oracleText:
					'Draw three cards, then discard a card unless you waterbend {3}.'
			},
			{
				name: 'Sea Gate Restoration',
				manaCost: '{4}{U}{U}{U}',
				typeLine: 'Sorcery',
				oracleText:
					'Draw cards equal to the number of cards in your hand plus one. You have no maximum hand size for the rest of the game.'
			},
			{
				name: 'Archangel Elspeth',
				manaCost: '{2}{W}{W}',
				typeLine: 'Legendary Planeswalker — Elspeth',
				oracleText:
					'+1: Create a 1/1 white Soldier creature token with lifelink.\n-2: Put two +1/+1 counters on target creature. It becomes a 0/0 Angel in addition to its other types and gains flying.'
			}
		];

		for (const sample of samples) {
			const def = compileCard(makeCard(sample));
			assert.equal(def.fullySupported, true, `${sample.name} should compile as fullySupported`);
			for (const ab of def.faces[0]!.abilities) {
				if (ab.kind === 'spell' || ab.kind === 'activated' || ab.kind === 'triggered') {
					assert.equal(
						staticallyInterpretable({
							steps: ab.effect,
							targets: ab.targets,
							modal: ab.modal,
							unparsed: []
						}),
						true,
						`${sample.name} ability (${ab.kind}) must satisfy staticallyInterpretable`
					);
				}
			}
		}

		const cardA = makeCard({
			name: 'Alpha Spire',
			typeLine: 'Land',
			manaCost: '',
			oracleText:
				'{1}{U}{R}: Until end of turn, Alpha Spire becomes a 2/1 blue and red Elemental creature with "During your turn, this creature has first strike." It\'s still a land.'
		});
		const cardB = makeCard({
			name: 'Omega Vault',
			typeLine: 'Land',
			manaCost: '',
			oracleText:
				'{1}{U}{R}: Until end of turn, Omega Vault becomes a 2/1 blue and red Elemental creature with "During your turn, this creature has first strike." It\'s still a land.'
		});
		assert.deepEqual(
			stripSpans(compileCard(cardA).faces[0]!.abilities),
			stripSpans(compileCard(cardB).faces[0]!.abilities),
			'synthetic rename must produce identical stripped IR'
		);
	});

	it('executes Waterbending Lesson optional waterbend cost (tap artifacts/creatures 0..N + JSON round-trip)', () => {
		let state = createGame();
		const p1 = state.players[0]!;
		const art1 = putInZone(
			state,
			p1,
			makeCard({ name: 'Ornithopter', manaCost: '{0}', typeLine: 'Artifact Creature — Thopter', power: '0', toughness: '2' }),
			'battlefield'
		);
		const art2 = putInZone(
			state,
			p1,
			makeCard({ name: 'Sol Ring', manaCost: '{1}', typeLine: 'Artifact' }),
			'battlefield'
		);
		for (let i = 0; i < 4; i++) {
			putInZone(state, p1, makeCard({ name: `Island ${i}`, typeLine: 'Land — Island', manaCost: '' }), 'library');
		}
		const lesson = putInZone(
			state,
			p1,
			makeCard({
				name: 'Waterbending Lesson',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Draw three cards, then discard a card unless you waterbend {3}.'
			}),
			'hand'
		);
		p1.manaPool.U = 2;
		p1.manaPool.C = 1; // 1 generic mana left + tap 2 permanents for {3} waterbend

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: lesson.instanceId
		});
		assert.equal(castRes.ok, true, castRes.error ?? '');
		passPriorityRound(state);

		assert.ok(state.pendingPrompts.length > 0);
		assert.equal(state.pendingPrompts[0]!.kind, 'yesNo');
		state = answerTopPrompt(state, { kind: 'yesNo', yes: true });

		assert.ok(state.pendingPrompts.length > 0);
		assert.equal(state.pendingPrompts[0]!.kind, 'chooseObjects');
		state = answerTopPrompt(state, {
			kind: 'chooseObjects',
			objectIds: [art1.instanceId, art2.instanceId]
		});
		passPriorityRound(state);

		const p1After = state.players[0]!;
		assert.equal(p1After.hand.length, 3);
		assert.equal(p1After.graveyard.some((c) => c.card.name.startsWith('Island')), false);
		assert.equal(p1After.battlefield.find((c) => c.instanceId === art1.instanceId)!.tapped, true);
		assert.equal(p1After.battlefield.find((c) => c.instanceId === art2.instanceId)!.tapped, true);
	});

	it('executes exileUntil stayExiled + allowExileCounters + grantSuspendIfMissing', () => {
		const state = createGame();
		const p1 = state.players[0]!;
		const docCard = makeCard({
			name: 'The Tenth Doctor',
			manaCost: '{3}{U}{R}',
			cmc: 5,
			typeLine: 'Legendary Creature',
			power: '3',
			toughness: '5',
			oracleText:
				'{7}: Exile cards from the top of your library until you exile a nonland card. Put three time counters on it. If it doesn\'t have suspend, it gains suspend.'
		});
		const doc = putInZone(state, p1, docCard, 'battlefield');
		const land = putInZone(
			state,
			p1,
			makeCard({ name: 'Mountain', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'library'
		);
		const hit = putInZone(
			state,
			p1,
			makeCard({ name: 'Shock', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: 'Shock deals 2 damage to any target.' }),
			'library'
		);
		p1.library = [land, hit];
		addMana(p1, 10);

		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: doc.instanceId,
			abilityId: firstActivatedId(docCard, 0)
		});
		assert.equal(actRes.ok, true, actRes.error ?? '');
		passPriorityRound(state);

		const exiledShock = p1.exile.find((c) => c.instanceId === hit.instanceId);
		assert.ok(exiledShock, 'nonland card must stay in exile');
		assert.equal(exiledShock.counters.time, 3);
		assert.equal(exiledShock.isSuspended, true);
		assert.equal(exiledShock.grantedKeywords.includes('Suspend'), true);
	});

	it('executes dig keepTo=castFree with keepMaxManaValue & JSON round-trip (Sunbird\'s Invocation)', () => {
		let state = createGame();
		const p1 = state.players[0]!;
		putInZone(
			state,
			p1,
			makeCard({
				name: "Sunbird's Invocation",
				manaCost: '{5}{R}',
				cmc: 6,
				typeLine: 'Enchantment',
				oracleText:
					"Whenever you cast a spell from your hand, reveal the top X cards of your library, where X is that spell's mana value. You may cast a spell with mana value X or less from among them without paying its mana cost. Put the rest on the bottom of your library in a random order."
			}),
			'battlefield'
		);

		const divination = makeCard({
			name: 'Divination',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Draw two cards.'
		});
		const bear = makeCard({
			name: 'Grizzly Bears',
			manaCost: '{1}{G}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		const colossal = makeCard({
			name: 'Colossal Dreadmaw',
			manaCost: '{4}{G}{G}',
			cmc: 6,
			typeLine: 'Creature — Dinosaur',
			power: '6',
			toughness: '6'
		});
		const forest = makeCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Land' });

		const cBear = putInZone(state, p1, bear, 'library');
		const cBig = putInZone(state, p1, colossal, 'library');
		const cLand = putInZone(state, p1, forest, 'library');
		p1.library = [cLand, cBig, cBear];

		const handSpell = putInZone(state, p1, divination, 'hand');
		addMana(p1, 5);

		const res = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: handSpell.instanceId
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, state.players[1]!.playerId, { type: 'pass_priority' }).ok, true);

		assert.ok(state.pendingPrompts.length > 0);
		const pr = state.pendingPrompts[0]!;
		assert.equal(pr.kind, 'chooseObjects');
		assert.deepEqual(pr.choice?.kind === 'chooseObjects' ? pr.choice.candidates : [], [cBear.instanceId]);

		state = answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [cBear.instanceId] });

		const p1After = state.players[0]!;
		assert.equal(p1After.library.length, 2);
		assert.equal(state.stack.some((it) => it.card.name === 'Grizzly Bears'), true);

		passPriorityRound(state);
		assert.equal(
			state.players[0]!.battlefield.some((c) => c.card.name === 'Grizzly Bears'),
			true
		);
	});

	it('executes opponent-library exileUntil + third-person cast free (Chaos Wand)', () => {
		let state = createGame();
		const p1 = state.players[0]!;
		const p2 = state.players[1]!;

		const wandCard = makeCard({
			name: 'Chaos Wand',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText:
				'{4}, {T}: Target opponent exiles cards from the top of their library until they exile an instant or sorcery card. You may cast that card without paying its mana cost. Then put the exiled cards that weren\'t cast this way on the bottom of that library in a random order.'
		});
		const wand = putInZone(state, p1, wandCard, 'battlefield');
		const oppLand = putInZone(state, p2, makeCard({ name: 'Swamp', manaCost: '', typeLine: 'Land' }), 'library');
		const oppDraw = putInZone(
			state,
			p2,
			makeCard({
				name: 'Sign in Blood',
				manaCost: '{B}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Draw two cards.'
			}),
			'library'
		);
		p2.library = [oppLand, oppDraw];
		const p1LibCard1 = putInZone(state, p1, makeCard({ name: 'Plains 1', manaCost: '', typeLine: 'Land' }), 'library');
		const p1LibCard2 = putInZone(state, p1, makeCard({ name: 'Plains 2', manaCost: '', typeLine: 'Land' }), 'library');
		p1.library = [p1LibCard1, p1LibCard2];
		addMana(p1, 5);

		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: wand.instanceId,
			abilityId: firstActivatedId(wandCard, 0),
			targets: [playerTarget(p2)]
		});
		assert.equal(actRes.ok, true, actRes.error ?? '');
		passPriorityRound(state);

		assert.ok(state.pendingPrompts.length > 0);
		assert.equal(state.pendingPrompts[0]!.playerId, p1.playerId);
		state = answerTopPrompt(state, { kind: 'yesNo', yes: true });
		passPriorityRound(state);

		assert.equal(state.players[0]!.hand.length, 2, 'P1 cast P2 spell and drew 2 cards');
		assert.equal(
			state.players[1]!.library.some((c) => c.instanceId === oppLand.instanceId),
			true,
			'un-cast exiled cards went to bottom of P2 library'
		);
	});

	it('executes preventDamage chooseSource + nextDamageEventOnly + onPrevented dealDamageEqual & putCountersEqual', () => {
		let state = createGame();
		let p1 = state.players[0]!;
		let p2 = state.players[1]!;

		const pingCard = makeCard({
			name: 'Prodigal Pyromancer',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Creature — Human Wizard',
			power: '1',
			toughness: '1',
			oracleText: '{T}: Prodigal Pyromancer deals 1 damage to any target.'
		});
		const pingGuy = putInZone(state, p2, pingCard, 'battlefield');
		const trap = putInZone(
			state,
			p1,
			makeCard({
				name: 'Refraction Trap',
				manaCost: '{3}{W}',
				cmc: 4,
				typeLine: 'Instant — Trap',
				oracleText:
					'Prevent the next 3 damage that a source of your choice would deal to you and/or permanents you control this turn. If damage is prevented this way, Refraction Trap deals that much damage to any target.'
			}),
			'hand'
		);
		const shock1 = putInZone(
			state,
			p2,
			makeCard({
				name: 'Pyrite Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Pyrite Bolt deals 2 damage to target player.'
			}),
			'hand'
		);
		addMana(p1, 5);
		addMana(p2, 5);

		const castTrap = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: trap.instanceId,
			targets: [playerTarget(p2)]
		});
		assert.equal(castTrap.ok, true, castTrap.error ?? '');
		passPriorityRound(state);

		assert.ok(state.pendingPrompts.length > 0);
		state = answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [pingGuy.instanceId] });
		passPriorityRound(state);

		p1 = state.players[0]!;
		p2 = state.players[1]!;

		state.priorityPlayerIndex = 1;
		state.passedPriorityPlayerIds = [];
		const p1LifeBeforeShock = p1.life;
		const shock1Res = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: shock1.instanceId,
			targets: [playerTarget(p1)]
		});
		assert.equal(shock1Res.ok, true, shock1Res.error ?? '');
		passPriorityRound(state);
		assert.equal(p1.life, p1LifeBeforeShock - 2);

		const p1LifeBeforePing = p1.life;
		const p2LifeBeforePing = p2.life;
		state.priorityPlayerIndex = 1;
		state.passedPriorityPlayerIds = [];
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: pingGuy.instanceId,
				abilityId: firstActivatedId(pingCard, 0),
				targets: [playerTarget(p1)]
			}).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(p1.life, p1LifeBeforePing, 'damage from chosen source must be prevented');
		assert.equal(p2.life, p2LifeBeforePing - 1, 'onPrevented dealDamageEqual must deal 1 to P2');

		const targetBear = putInZone(
			state,
			p1,
			makeCard({ name: 'Runeclaw Bear', manaCost: '{1}{G}', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const testOfFaith = putInZone(
			state,
			p1,
			makeCard({
				name: 'Test of Faith',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					'Prevent the next 3 damage that would be dealt to target creature this turn. For each 1 damage prevented this way, put a +1/+1 counter on that creature.'
			}),
			'hand'
		);
		const bolt = putInZone(
			state,
			p2,
			makeCard({
				name: 'Shock Copy',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Shock Copy deals 2 damage to any target.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		state.passedPriorityPlayerIds = [];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: testOfFaith.instanceId,
				targets: [permTarget(targetBear)]
			}).ok,
			true
		);
		passPriorityRound(state);
		state.priorityPlayerIndex = 1;
		state.passedPriorityPlayerIds = [];
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				targets: [permTarget(targetBear)]
			}).ok,
			true
		);
		passPriorityRound(state);
		assert.equal(targetBear.damageMarked ?? 0, 0);
		assert.equal(targetBear.counters['+1/+1'], 2);
	});

	it('executes Aura graveyard attach (attachedToSelector), cantAttack restriction (Martyred Rusalka), and Restless Spire quoted static', () => {
		let state = createGame();
		let p1 = state.players[0]!;
		let p2 = state.players[1]!;

		const reanimatorAnchor = putInZone(
			state,
			p1,
			makeCard({
				name: 'Fangs Reanimator',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText:
					'When a creature with mana value 6 or greater enters, return target Aura card from your graveyard to the battlefield attached to that creature.'
			}),
			'battlefield'
		);
		assert.ok(reanimatorAnchor);
		const fangs = putInZone(
			state,
			p1,
			makeCard({
				name: 'Dragon Fangs',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +1/+1 and has trample.'
			}),
			'graveyard'
		);
		const wurm = putInZone(
			state,
			p1,
			makeCard({
				name: 'Craw Wurm',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Creature — Wurm',
				power: '6',
				toughness: '4'
			}),
			'hand'
		);
		addMana(p1, 8);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wurm.instanceId }).ok, true);
		passPriorityRound(state);

		if (state.pendingPrompts.length > 0) {
			state = answerTopPrompt(state, {
				kind: 'chooseObjects',
				objectIds: [fangs.instanceId]
			});
			passPriorityRound(state);
		}
		p1 = state.players[0]!;
		p2 = state.players[1]!;
		const bfWurm = p1.battlefield.find((c) => c.card.name === 'Craw Wurm');
		const bfFangs = p1.battlefield.find((c) => c.instanceId === fangs.instanceId);
		assert.ok(bfWurm && bfFangs, 'Aura should return from graveyard to battlefield');
		assert.equal(bfFangs.attachedToId, bfWurm.instanceId, 'Aura must attach directly to Craw Wurm');

		const spireCard = makeCard({
			name: 'Restless Spire',
			manaCost: '',
			typeLine: 'Land',
			oracleText:
				'{1}{U}{R}: Until end of turn, Restless Spire becomes a 2/1 blue and red Elemental creature with "During your turn, this creature has first strike." It\'s still a land.'
		});
		const spire = putInZone(state, p1, spireCard, 'battlefield');
		addMana(p1, 5);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: spire.instanceId,
				abilityId: firstActivatedId(spireCard, 0)
			}).ok,
			true
		);
		passPriorityRound(state);
		const spireEv = evaluatePermanent(state, spire);
		assert.equal(spireEv.isCreature, true);
		assert.equal(spireEv.isLand, true, 'It must still be a land');
		assert.equal(spireEv.keywords.some((k) => k.toLowerCase() === 'first strike'), true, 'During your turn, Spire gains first strike');
		state.activePlayerIndex = 1;
		const spireOppEv = evaluatePermanent(state, spire);
		assert.equal(spireOppEv.keywords.some((k) => k.toLowerCase() === 'first strike'), false, 'Outside your turn, Spire loses first strike');

		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		const rusalkaCard = makeCard({
			name: 'Martyred Rusalka',
			manaCost: '{W}',
			cmc: 1,
			typeLine: 'Creature — Spirit',
			power: '1',
			toughness: '1',
			oracleText: '{W}, Sacrifice a creature: Target creature can\'t attack this turn.'
		});
		const rusalka = putInZone(state, p1, rusalkaCard, 'battlefield');
		const fodder = putInZone(
			state,
			p1,
			makeCard({ name: 'Token Soldier', manaCost: '{W}', typeLine: 'Creature — Soldier', power: '1', toughness: '1' }),
			'battlefield'
		);
		const enemyBear = putInZone(
			state,
			p2,
			makeCard({ name: 'Enemy Bear', manaCost: '{1}{G}', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: rusalka.instanceId,
				abilityId: firstActivatedId(rusalkaCard, 0),
				targets: [permTarget(enemyBear)]
			}).ok,
			true
		);
		if (state.pendingPrompts.length > 0) {
			state = answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [fodder.instanceId] });
		}
		passPriorityRound(state);
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'declare_attackers';
		const atkRes = applyGameAction(state, p2.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: enemyBear.instanceId, defenderPlayerId: p1.playerId }]
		});
		assert.equal(atkRes.ok, false, 'creature affected by cantAttack must be rejected in declare_attackers');
	});

	it('executes Sea Gate Restoration noMaxHandSizeForRestOfGame and CR 707.10b countered spell LKI copy', () => {
		let state = createGame();
		let p1 = state.players[0]!;
		let p2 = state.players[1]!;

		const seaGate = putInZone(
			state,
			p1,
			makeCard({
				name: 'Sea Gate Restoration',
				manaCost: '{4}{U}{U}{U}',
				cmc: 7,
				typeLine: 'Sorcery',
				oracleText:
					'Draw cards equal to the number of cards in your hand plus one. You have no maximum hand size for the rest of the game.'
			}),
			'hand'
		);
		for (let i = 0; i < 10; i++) {
			putInZone(state, p1, makeCard({ name: `Card ${i}`, typeLine: 'Instant', manaCost: '{U}' }), 'hand');
			putInZone(state, p1, makeCard({ name: `Lib ${i}`, typeLine: 'Land', manaCost: '' }), 'library');
		}
		addMana(p1, 10);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: seaGate.instanceId }).ok, true);
		passPriorityRound(state);
		assert.equal(p1.noMaxHandSizeForRestOfGame, true);

		const handBeforeCleanup = p1.hand.length;
		assert.ok(handBeforeCleanup > 7);
		state.phase = 'end_step';
		state.priorityPlayerIndex = 0;
		state.passedPriorityPlayerIds = [];
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(p1.hand.length, handBeforeCleanup, 'noMaxHandSizeForRestOfGame must skip cleanup discard');

		state.phase = 'main1';
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.passedPriorityPlayerIds = [];
		putInZone(state, p1, makeCard({ name: 'Opt 1', manaCost: '{U}', typeLine: 'Instant', oracleText: 'Draw a card.' }), 'graveyard');
		putInZone(state, p1, makeCard({ name: 'Opt 2', manaCost: '{U}', typeLine: 'Instant', oracleText: 'Draw a card.' }), 'graveyard');
		const p1Bolt = putInZone(
			state,
			p2,
			makeCard({ name: 'Lightning Strike', manaCost: '{1}{R}', cmc: 2, typeLine: 'Instant', oracleText: 'Lightning Strike deals 3 damage to any target.' }),
			'hand'
		);
		const rebuttal = putInZone(
			state,
			p1,
			makeCard({
				name: 'Psychic Rebuttal',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText:
					"Counter target instant or sorcery spell that targets you. If there are two or more instant and/or sorcery cards in your graveyard, you may copy that spell if it's countered this way. You may choose new targets for the copy."
			}),
			'hand'
		);
		addMana(p1, 5);
		addMana(p2, 5);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: p1Bolt.instanceId,
				targets: [playerTarget(p1)]
			}).ok,
			true
		);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		const targetStack = state.stack[0]!;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rebuttal.instanceId,
				targets: [{ kind: 'stack', id: targetStack.id, label: targetStack.title }]
			}).ok,
			true
		);
		passPriorityRound(state);
		for (let guard = 0; guard < 6 && state.pendingPrompts.length > 0; guard++) {
			const pr = state.pendingPrompts[0]!;
			if (pr.kind === 'yesNo') {
				state = answerTopPrompt(state, { kind: 'yesNo', yes: true });
			} else if (pr.kind === 'chooseObjects') {
				state = answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [p2.playerId] });
			}
		}
		passPriorityRound(state);
		p2 = state.players[1]!;
		assert.equal(p2.graveyard.some((c) => c.instanceId === p1Bolt.instanceId), true, 'Lightning Strike was countered');
		assert.equal(p2.life, 37, 'Copied countered Lightning Strike retargeted at P2 dealt 3 damage');
	});
});
