import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	resolveTopOfStack
} from '../engine.ts';
import { parseAbilityEffectText, parseEffects, parseSpellText } from '../compiler/effects.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type TargetRef,
	type ZoneType
} from '../types.ts';
import { subscribeEvents } from './events.ts';
import { executeEffectSteps, opponentLandColors } from './effects.ts';

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
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function makeTwoPlayerGame(): { state: GameState; p1: PlayerGameState; p2: PlayerGameState } {
	const d1 = PRECON_DECKS[0];
	const d2 = PRECON_DECKS[1];
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: false,
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: d1.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d1.colorIdentity,
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
			deckId: d2.id,
			deckName: d2.name,
			commanderNames: d2.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d2.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		}
	];
	const state = createInitialGameState(
		'EFFECTS_TEST',
		seats,
		new Map([
			[0, d1],
			[1, d2]
		]),
		{ ...DEFAULT_LOBBY_RULES }
	);
	applyGameAction(state, 'p1', { type: 'mulligan_keep' });
	applyGameAction(state, 'p2', { type: 'mulligan_keep' });
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	const [p1, p2] = state.players;
	p1.hand = [];
	p2.hand = [];
	return { state, p1, p2 };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: Exclude<ZoneType, 'stack'>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	player[zone].push(inst);
	return inst;
}

function pushSpellOnStack(
	state: GameState,
	controller: PlayerGameState,
	card: ScryfallCard,
	targets: TargetRef[] = [],
	xValue = 0
): StackItem {
	const inst = putInZone(state, controller, card, 'hand');
	const idx = controller.hand.indexOf(inst);
	if (idx >= 0) controller.hand.splice(idx, 1);
	const item: StackItem = {
		id: `stk_${inst.instanceId}`,
		sourceInstanceId: inst.instanceId,
		sourceObjectVersion: inst.objectVersion,
		card,
		ownerId: controller.playerId,
		controllerId: controller.playerId,
		kind: 'spell',
		title: card.name,
		oracleText: card.oracleText,
		targets,
		xValue,
		castMode: 'normal',
		requiresGuidedResolution: false,
		createdAt: Date.now()
	};
	state.stack.push(item);
	return item;
}

describe('Effect interpreter: Phase 3 bug fixes', () => {
	it('1. Lathril: executes "Each opponent loses 10 life" before "you gain 10 life" (and works when renamed)', () => {
		for (const name of ['Lathril, Blade of the Elves', 'Zorblax, Elf Sovereign']) {
			const { state, p1, p2 } = makeTwoPlayerGame();
			const card = syntheticCard({
				name,
				typeLine: 'Legendary Creature — Elf Noble',
				power: '2',
				toughness: '3',
				oracleText:
					'{T}, Tap ten untapped Elves you control: Each opponent loses 10 life and you gain 10 life.'
			});
			const src = putInZone(state, p1, card, 'battlefield');
			const effectText = 'Each opponent loses 10 life and you gain 10 life.';
			state.stack.push({
				id: 'stk_lathril',
				sourceInstanceId: src.instanceId,
				sourceObjectVersion: src.objectVersion,
				card,
				controllerId: p1.playerId,
				kind: 'activated',
				title: `${card.name} Ability`,
				oracleText: effectText,
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: Date.now()
			});
			state.recentVfxEvents = [];
			const logsBefore = state.log.length;

			resolveTopOfStack(state);

			assert.equal(p2.life, 30);
			assert.equal(p1.life, 50);
			const lifeLogs = state.log.slice(logsBefore).filter((l) => l.kind === 'life');
			assert.equal(lifeLogs.length, 2);
			assert.match(lifeLogs[0].text, /Bob lost 10 life/);
			assert.match(lifeLogs[1].text, /Alice gained 10 life/);
			const lifeVfx = state.recentVfxEvents.filter((v) => v.kind === 'damage' || v.kind === 'heal');
			assert.deepEqual(
				lifeVfx.map((v) => [v.kind, v.targetId, v.amount]),
				[
					['damage', p2.playerId, 10],
					['heal', p1.playerId, 10]
				]
			);
		}
	});

	it('2. Swords to Plowshares: life gain goes to the exiled creature\'s LKI controller equal to its LKI battlefield power', () => {
		for (const name of ['Swords to Plowshares', 'Plowshare Edict']) {
			const { state, p1, p2 } = makeTwoPlayerGame();
			// Owned by Alice (p1), currently controlled by Bob (p2), with counters + temp pump on board.
			const bear = putInZone(
				state,
				p2,
				syntheticCard({
					name: 'Grizzly Test Bear',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			bear.ownerId = p1.playerId;
			bear.controllerId = p2.playerId;
			bear.counters['+1/+1'] = 2;
			bear.tempPowerMod = 3; // effective battlefield power = 2 + 2 + 3 = 7

			const spell = syntheticCard({
				name,
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Exile target creature. Its controller gains life equal to its power.'
			});
			pushSpellOnStack(state, p1, spell, [
				{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }
			]);

			resolveTopOfStack(state);

			// Exiled to owner's (Alice's) exile zone, where leaveBattlefieldReset stripped counters/pump.
			assert.equal(p2.battlefield.length, 0);
			assert.equal(p1.exile.some((c) => c.instanceId === bear.instanceId), true);
			assert.equal(bear.zone, 'exile');
			assert.equal(bear.counters['+1/+1'], 0);
			assert.equal(bear.tempPowerMod, 0);
			// Bob (the LKI controller on the battlefield), not Alice, gained 7 life (the LKI power, not printed 2).
			assert.equal(p1.life, 40);
			assert.equal(p2.life, 47);
		}

		// Also verify `actor` form directly on executeEffectSteps (plan section 2.1).
		const { state, p1, p2 } = makeTwoPlayerGame();
		const target = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Hill Giant', typeLine: 'Creature — Giant', power: '4', toughness: '4' }),
			'battlefield'
		);
		const dummyCard = syntheticCard({ name: 'Test Exile' });
		const dummyItem = pushSpellOnStack(state, p1, dummyCard, [
			{ kind: 'permanent', id: target.instanceId, label: target.card.name }
		]);
		state.stack.pop();
		executeEffectSteps(
			state,
			{
				controller: p1,
				sourceId: dummyItem.sourceInstanceId,
				sourceCard: dummyCard,
				title: dummyCard.name,
				item: dummyItem,
				targets: dummyItem.targets,
				targetSpecs: [],
				xValue: 0
			},
			[
				{ verb: 'exile', subject: { k: 'target', index: 0 }, bindAs: 't', span: { start: 0, end: 0 } },
				{
					verb: 'gainLife',
					subject: { k: 'none' },
					actor: { k: 'controllerOf', of: { k: 'binding', name: 't' } },
					amount: { k: 'stat', of: { k: 'binding', name: 't' }, stat: 'power', lki: true },
					span: { start: 0, end: 0 }
				}
			]
		);
		assert.equal(p2.life, 44);
	});

	it('3. Corpse Dance: reanimates top creature, grants haste, and exiles that bound creature at next end step without a card-name check', () => {
		for (const name of ['Corpse Dance', 'Grave Waltz']) {
			const { state, p1 } = makeTwoPlayerGame();
			const bottom = putInZone(state, p1, staple('Llanowar Elves'), 'graveyard');
			const top = putInZone(state, p1, staple('Elvish Archdruid'), 'graveyard');
			const nonCreature = putInZone(state, p1, staple('Sol Ring'), 'graveyard');
			const bystander = putInZone(state, p1, staple('Elvish Mystic'), 'battlefield');

			const spell = syntheticCard({
				name,
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText:
					'Buyback {2} (You may pay an additional {2} as you cast this spell. If you do, put this card into your hand as it resolves.)\nReturn the top creature card of your graveyard to the battlefield. That creature gains haste until end of turn. Exile it at the beginning of the next end step.'
			});
			pushSpellOnStack(state, p1, spell);

			resolveTopOfStack(state);

			// Top creature (Eternal Witness) returned to battlefield with Haste; Sol Ring and Llanowar Elves stayed in graveyard.
			assert.equal(p1.battlefield.some((c) => c.instanceId === top.instanceId), true);
			assert.equal(top.grantedKeywords.includes('Haste'), true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === bottom.instanceId), true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === nonCreature.instanceId), true);

			// Exactly one delayed trigger was registered, bound to `top.instanceId`.
			assert.equal(state.delayedTriggers?.length, 1);
			assert.equal(state.delayedTriggers?.[0]?.targetInstanceId, top.instanceId);

			// At the beginning of the next end step, the delayed trigger goes on the stack and exiles `top`.
			state.phase = 'end_step';
			enterEndStep(state, p1);
			assert.equal(state.stack.length, 1);
			resolveTopOfStack(state);

			assert.equal(p1.battlefield.some((c) => c.instanceId === top.instanceId), false);
			assert.equal(p1.exile.some((c) => c.instanceId === top.instanceId), true);
			assert.equal(p1.battlefield.some((c) => c.instanceId === bystander.instanceId), true);
		}
	});

	it('4. "any color that a land an opponent controls could produce" (Exotic Orchard / Fellwar Stone) obeys CR 106.7', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const stone = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Alien Stone',
				typeLine: 'Artifact',
				oracleText: '{T}: Add one mana of any color that a land an opponent controls could produce.'
			}),
			'battlefield'
		);
		const parse = parseAbilityEffectText(stone.card.name, stone.card.oracleText.replace(/^\{T\}:\s*/, ''));
		const runAddMana = (preferredColor?: 'W' | 'U' | 'B' | 'R' | 'G') => {
			const dummyItem: StackItem = {
				id: 'stk_mana',
				sourceInstanceId: stone.instanceId,
				card: stone.card,
				controllerId: p1.playerId,
				kind: 'activated',
				title: 'Alien Stone Ability',
				oracleText: stone.card.oracleText,
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: Date.now()
			};
			executeEffectSteps(
				state,
				{
					controller: p1,
					sourceId: stone.instanceId,
					sourceCard: stone.card,
					title: dummyItem.title,
					item: dummyItem,
					targets: [],
					targetSpecs: [],
					xValue: 0,
					preferredColor
				},
				parse.steps
			);
		};

		// (a) Opponent controls no lands -> no colors.
		assert.deepEqual(opponentLandColors(state, p1), []);
		runAddMana('G');
		assert.deepEqual(p1.manaPool, { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

		// (b) Opponent controls only a colorless land (Reliquary Tower) and a non-land mana rock (Arcane Signet) -> still no colors!
		putInZone(state, p2, staple('Reliquary Tower'), 'battlefield');
		putInZone(state, p2, staple('Arcane Signet'), 'battlefield');
		assert.deepEqual(opponentLandColors(state, p1), []);
		runAddMana('U');
		assert.deepEqual(p1.manaPool, { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

		// (c) Opponent controls a Swamp and a Forest -> only B and G.
		putInZone(state, p2, staple('Swamp'), 'battlefield');
		putInZone(state, p2, staple('Forest'), 'battlefield');
		assert.deepEqual(opponentLandColors(state, p1), ['B', 'G']);
		runAddMana('G');
		assert.equal(p1.manaPool.G, 1);
		// Asking for 'U' (not producible by opponent's lands) cannot produce U; falls back to first allowed ('B').
		runAddMana('U');
		assert.equal(p1.manaPool.U, 0);
		assert.equal(p1.manaPool.B, 1);

		// (d) Two Exotic Orchards: if p2 only has Exotic Orchard and p1 has an Island, p2's Orchard could produce U, so p1's can too.
		p2.battlefield = [];
		putInZone(state, p2, staple('Exotic Orchard'), 'battlefield');
		assert.deepEqual(opponentLandColors(state, p1), []);
		putInZone(state, p1, staple('Island'), 'battlefield');
		assert.deepEqual(opponentLandColors(state, p1), ['U']);
	});

	it('5. spells whose only targets have kind "card_in_graveyard" resolve instead of fizzling, and fizzle if the card left the graveyard', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const target = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Grave Titan',
				manaCost: '{4}{B}{B}',
				cmc: 6,
				typeLine: 'Creature — Giant',
				power: '6',
				toughness: '6'
			}),
			'graveyard'
		);
		const reanimate = syntheticCard({
			name: 'Necro Pull',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Sorcery',
			oracleText:
				"Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to that card's mana value."
		});
		pushSpellOnStack(state, p1, reanimate, [
			{ kind: 'card_in_graveyard', id: target.instanceId, label: target.card.name }
		]);

		resolveTopOfStack(state);

		assert.equal(p1.battlefield.some((c) => c.instanceId === target.instanceId), true);
		assert.equal(p2.graveyard.some((c) => c.instanceId === target.instanceId), false);
		assert.equal(p1.life, 34);

		// If the targeted card is removed from the graveyard before resolution, the spell fizzles (CR 608.2b).
		const missing = putInZone(state, p1, staple('Llanowar Elves'), 'graveyard');
		pushSpellOnStack(state, p1, reanimate, [
			{ kind: 'card_in_graveyard', id: missing.instanceId, label: missing.card.name }
		]);
		p1.graveyard = []; // removed in response
		resolveTopOfStack(state);
		assert.equal(p1.life, 34);
		assert.match(state.log[state.log.length - 1].text, /countered on resolution/);
	});
});

describe('Effect interpreter: Phase 5 entry point, zone events, and legacy bug fixes', () => {
	it('executeEffectSteps supports eventObject and eventAmount for triggered abilities (Phase 5 entry point)', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		const attacker = putInZone(state, p2, staple('Llanowar Elves'), 'battlefield');
		const dummy = syntheticCard({ name: 'Trigger Host', typeLine: 'Creature — Elf' });
		const dummyItem = pushSpellOnStack(state, p1, dummy);
		state.stack.pop();

		const exileParsed = parseEffects('exile it.', 0, 'triggered');
		const tokensParsed = parseEffects(
			'create that many 1/1 green Elf Warrior creature tokens.',
			0,
			'triggered'
		);
		assert.deepEqual(exileParsed.unparsed, []);
		assert.deepEqual(tokensParsed.unparsed, []);

		const events: string[] = [];
		const unsub = subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'ZoneChange') events.push(`${ev.from}->${ev.to}`);
		});
		try {
			executeEffectSteps(
				state,
				{
					controller: p1,
					sourceId: dummyItem.sourceInstanceId,
					sourceCard: dummy,
					title: dummy.name,
					item: dummyItem,
					targets: [],
					targetSpecs: [],
					xValue: 0,
					eventObjectId: attacker.instanceId,
					eventAmount: 3
				},
				[...exileParsed.steps, ...tokensParsed.steps]
			);
		} finally {
			unsub();
		}

		assert.equal(p2.battlefield.length, 0);
		assert.equal(p2.exile.some((c) => c.instanceId === attacker.instanceId), true);
		assert.equal(p1.battlefield.filter((c) => c.isToken && c.card.name === 'Elf Warrior Token').length, 3);
		assert.deepEqual(events, [
			'battlefield->exile',
			'null->battlefield',
			'null->battlefield',
			'null->battlefield'
		]);
	});

	it('Sign in Blood, Feed the Swarm, and Toxic Deluge resolve accurately on the interpreter', () => {
		const { state, p1, p2 } = makeTwoPlayerGame();
		putInZone(state, p2, staple('Forest'), 'library');
		putInZone(state, p2, staple('Swamp'), 'library');
		const signInBlood = parseSpellText(
			'Inkwell Pact',
			'Target player draws two cards and loses 2 life.'
		);
		assert.deepEqual(signInBlood.unparsed, []);
		pushSpellOnStack(
			state,
			p1,
			syntheticCard({
				name: 'Inkwell Pact',
				typeLine: 'Sorcery',
				oracleText: 'Target player draws two cards and loses 2 life.'
			}),
			[{ kind: 'player', id: p2.playerId, label: p2.username }]
		);
		resolveTopOfStack(state);
		assert.equal(p2.hand.length, 2);
		assert.equal(p2.life, 38);
		assert.equal(p1.hand.length, 0);

		// Feed the Swarm loses life equal to the destroyed permanent's mana value (LKI).
		const archdruid = putInZone(state, p2, staple('Elvish Archdruid'), 'battlefield'); // cmc 3
		pushSpellOnStack(
			state,
			p1,
			syntheticCard({
				name: 'Swarm Bite',
				typeLine: 'Sorcery',
				oracleText:
					"Destroy target creature or enchantment you don't control. You lose life equal to its mana value."
			}),
			[{ kind: 'permanent', id: archdruid.instanceId, label: archdruid.card.name }]
		);
		resolveTopOfStack(state);
		assert.equal(p2.battlefield.length, 0);
		assert.equal(p1.life, 37);

		// Toxic Deluge gives -X/-X until end of turn.
		const bear = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		pushSpellOnStack(
			state,
			p1,
			syntheticCard({
				name: 'Murk Flood',
				typeLine: 'Sorcery',
				oracleText:
					'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.'
			}),
			[],
			2
		);
		resolveTopOfStack(state);
		assert.equal(p2.battlefield.some((c) => c.instanceId === bear.instanceId), false);
		assert.equal(p2.graveyard.some((c) => c.instanceId === bear.instanceId), true);
	});
});
