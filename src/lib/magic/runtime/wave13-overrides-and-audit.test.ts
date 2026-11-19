import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COMPILER_VERSION, compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { resolveCardOverride } from '../overrides/index.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

let w13Seq = 0;

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	w13Seq += 1;
	return {
		id: overrides.id ?? `syn_w13_${w13Seq}`,
		oracleId: overrides.oracleId ?? `ora_w13_${w13Seq}`,
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
		defense: overrides.defense,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: true,
		canBeCommander: overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		layout: overrides.layout ?? 'normal'
	};
}

function makeDeck(cards: ScryfallCard[]): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_w13_${++w13Seq}`,
		userId: 'p1',
		name: 'Wave 13 Deck',
		description: '',
		commanders: [],
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length,
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupGame(opts: { playerCount?: 2 | 3 } = {}) {
	const filler = synthCard({
		name: 'Basic Forest',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Forest',
		oracleText: '({T}: Add {G}.)'
	});
	const count = opts.playerCount ?? 2;
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	for (let i = 0; i < count; i++) {
		const d = makeDeck(Array.from({ length: 25 }, () => filler));
		decks.set(i, d);
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `Player${i + 1}`,
			avatarUrl: '',
			isBot: false,
			deckId: d.id,
			deckName: d.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: d.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
	}
	const state = createInitialGameState('W13', seats, decks, DEFAULT_LOBBY_RULES);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hasKeptHand = true;
		p.hand = [];
	}
	return { state, p1: state.players[0], p2: state.players[1], p3: state.players[2] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library',
	opts: { summoningSick?: boolean; counters?: Record<string, number> } = {}
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = opts.summoningSick ?? false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
	}
	if (opts.counters) {
		inst.counters = { ...inst.counters, ...opts.counters };
	}
	if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	noteLayerInputsChanged(state);
	return inst;
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor | 'C', number>>): void {
	for (const [k, v] of Object.entries(pool)) {
		if (typeof v === 'number') {
			player.manaPool[k as ManaColor | 'C'] = (player.manaPool[k as ManaColor | 'C'] ?? 0) + v;
		}
	}
}

function findInstance(state: GameState, instanceId: string): { zone: string; inst: CardInstance } | undefined {
	for (const p of state.players) {
		for (const z of ['battlefield', 'hand', 'graveyard', 'exile', 'library', 'command'] as const) {
			const hit = p[z].find((c) => c.instanceId === instanceId);
			if (hit) return { zone: z, inst: hit };
		}
	}
	return undefined;
}

function resolveAllStackAndOrderPrompts(state: GameState): void {
	for (let guard = 0; guard < 60; guard++) {
		if (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0];
			if (prm.purpose === 'trigger_order') {
				const res = applyGameAction(state, prm.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
				});
				assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
				continue;
			}
			return;
		}
		if (state.stack.length === 0) return;
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
	throw new Error('resolveAllStackAndOrderPrompts exceeded guard limit');
}

function passUntilPhase(
	state: GameState,
	targetPhase: GameState['phase'],
	targetActiveIndex?: number
): void {
	for (let guard = 0; guard < 120; guard++) {
		if (
			state.phase === targetPhase &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0 &&
			(targetActiveIndex === undefined || state.activePlayerIndex === targetActiveIndex)
		) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			resolveAllStackAndOrderPrompts(state);
			if (state.pendingPrompts.length > 0) return;
			continue;
		}
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
	throw new Error(`passUntilPhase(${targetPhase}) exceeded guard limit`);
}

function cloneRenamed(card: ScryfallCard, newName: string): ScryfallCard {
	const escaped = card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return {
		...card,
		id: `syn_clone_${++w13Seq}`,
		name: newName,
		oracleText: card.oracleText.replace(new RegExp(escaped, 'g'), newName)
	};
}

const CANONICAL = {
	glorybringer: () =>
		synthCard({
			oracleId: 'ora_glorybringer',
			name: 'Glorybringer',
			manaCost: '{3}{R}{R}',
			cmc: 5,
			typeLine: 'Creature — Dragon',
			power: '4',
			toughness: '4',
			colors: ['R'],
			keywords: ['Flying', 'Haste'],
			oracleText:
				"Flying, haste\nYou may exert this creature as it attacks. When you do, it deals 4 damage to target non-Dragon creature an opponent controls. (An exerted creature won't untap during your next untap step.)"
		}),
	mazemindTome: () =>
		synthCard({
			oracleId: 'ora_mazemind_tome',
			name: 'Mazemind Tome',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			colors: [],
			oracleText:
				'{T}: Scry 1. Put a page counter on this artifact.\n{2}, {T}: Draw a card. Put a page counter on this artifact.\nWhen there are four or more page counters on this artifact, exile it. If you do, you gain 4 life.'
		}),
	academyManufactor: () =>
		synthCard({
			oracleId: 'f36d1d8b-8303-44a9-ab56-531931641ea2',
			name: 'Academy Manufactor',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact Creature — Assembly-Worker',
			power: '1',
			toughness: '3',
			oracleText: 'If you would create a Clue, Food, or Treasure token, instead create one of each.'
		}),
	bello: () =>
		synthCard({
			oracleId: 'fb773114-6161-46a3-ab30-1853958fbcb0',
			name: 'Bello, Bard of the Brambles',
			manaCost: '{1}{R}{G}',
			cmc: 3,
			typeLine: 'Legendary Creature — Raccoon Bard',
			power: '3',
			toughness: '3',
			colors: ['G', 'R'],
			oracleText:
				'During your turn, each non-Equipment artifact and non-Aura enchantment you control with mana value 4 or greater is a 4/4 Elemental creature in addition to its other types and has indestructible, haste, and "Whenever this creature deals combat damage to a player, draw a card."'
		}),
	biggerOnTheInside: () =>
		synthCard({
			oracleId: '8f351961-69e3-4637-b010-d13f19daca39',
			name: 'Bigger on the Inside',
			manaCost: '{3}{R}{G}',
			cmc: 5,
			typeLine: 'Enchantment — Aura',
			colors: ['G', 'R'],
			keywords: ['Enchant'],
			oracleText:
				'Enchant artifact or land\nEnchanted permanent has "{T}: Target player adds two mana of any one color. The next spell they cast this turn has cascade." (When they cast their next spell, they exile cards from the top of their library until they exile a nonland card that costs less. They may cast it without paying its mana cost. They put the exiled cards on the bottom in a random order.)'
		}),
	indominusRex: () =>
		synthCard({
			oracleId: '723a66c3-2c2c-411c-bba5-922e8601981b',
			name: 'Indominus Rex, Alpha',
			manaCost: '{1}{U/B}{U/B}{G}{G}',
			cmc: 5,
			typeLine: 'Legendary Creature — Dinosaur Mutant',
			power: '6',
			toughness: '6',
			colors: ['B', 'G', 'U'],
			oracleText:
				'As Indominus Rex enters, discard any number of creature cards. It enters with a flying counter on it if a card discarded this way has flying. The same is true for first strike, double strike, deathtouch, hexproof, haste, indestructible, lifelink, menace, reach, trample, and vigilance.\nWhen Indominus Rex enters, draw a card for each counter on it.'
		}),
	sinUnending: () =>
		synthCard({
			oracleId: '48534bbf-06b6-46a0-8a86-b14f38caee58',
			name: 'Sin, Unending Cataclysm',
			manaCost: '{5}{G}{U}',
			cmc: 7,
			typeLine: 'Legendary Creature — Leviathan Avatar',
			power: '5',
			toughness: '5',
			colors: ['G', 'U'],
			keywords: ['Flying', 'Trample'],
			oracleText:
				"Flying, trample\nAs Sin enters, remove all counters from any number of artifacts, creatures, and enchantments. Sin enters with X +1/+1 counters on it, where X is twice the number of counters removed this way.\nWhen Sin dies, put its counters on target creature you control, then shuffle this card into its owner's library."
		}),
	benthicAnomaly: () =>
		synthCard({
			oracleId: 'c12e2563-4ad4-4637-b9ae-72f23cca31d8',
			name: 'Benthic Anomaly',
			manaCost: '{6}{U}',
			cmc: 7,
			typeLine: 'Creature — Eldrazi Serpent',
			power: '7',
			toughness: '8',
			colors: [],
			keywords: ['Devoid'],
			oracleText:
				"Devoid (This card has no color.)\nWhen you cast this spell, for each opponent, choose a creature that player controls. Create a token that's a copy of one of those creatures, except its power is equal to the total power of those creatures, its toughness is equal to the total toughness of those creatures, and it's a colorless Eldrazi creature."
		}),
	garrukCursed: () =>
		synthCard({
			oracleId: 'e0cef79c-ad47-4cbc-9d73-a913e487ccb7',
			name: 'Garruk, Cursed Huntsman',
			manaCost: '{4}{B}{G}',
			cmc: 6,
			typeLine: 'Legendary Planeswalker — Garruk',
			loyalty: '5',
			colors: ['B', 'G'],
			oracleText:
				'0: Create two 2/2 black and green Wolf creature tokens with "When this token dies, put a loyalty counter on each Garruk you control."\n−3: Destroy target creature. Draw a card.\n−6: You get an emblem with "Creatures you control get +3/+3 and have trample."'
		}),
	illusionistsGambit: () =>
		synthCard({
			oracleId: '333745d9-e930-439b-94d6-3aeea2877f69',
			name: "Illusionist's Gambit",
			manaCost: '{2}{U}{U}',
			cmc: 4,
			typeLine: 'Instant',
			colors: ['U'],
			oracleText:
				"Cast this spell only during the declare blockers step on an opponent's turn.\nRemove all attacking creatures from combat and untap them. After this phase, there is an additional combat phase. Each of those creatures attacks that combat if able. They can't attack you or planeswalkers you control that combat."
		}),
	pathOfTheAnimist: () =>
		synthCard({
			oracleId: '85ccae95-92c4-41ff-96fd-dcb515dc568e',
			name: 'Path of the Animist',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Sorcery',
			colors: ['G'],
			oracleText:
				'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.\nWill of the Planeswalkers — Starting with you, each player votes for planeswalk or chaos. If planeswalk gets more votes, planeswalk. If chaos gets more votes or the vote is tied, chaos ensues.'
		}),
	theChainVeil: () =>
		synthCard({
			oracleId: 'fb88fb3d-6a85-4bb1-b316-7f759b45a0fa',
			name: 'The Chain Veil',
			manaCost: '{4}',
			cmc: 4,
			typeLine: 'Legendary Artifact',
			colors: [],
			oracleText:
				"At the beginning of your end step, if you didn't activate a loyalty ability of a planeswalker this turn, you lose 2 life.\n{4}, {T}: For each planeswalker you control, you may activate one of its loyalty abilities once this turn as though none of its loyalty abilities have been activated this turn."
		}),
	ulalek: () =>
		synthCard({
			oracleId: '9f6828e3-39d9-45d9-9bf1-0e3737a0321e',
			name: 'Ulalek, Fused Atrocity',
			manaCost: '{C/W}{C/U}{C/B}{C/R}{C/G}',
			cmc: 5,
			typeLine: 'Legendary Creature — Eldrazi',
			power: '2',
			toughness: '5',
			colors: [],
			keywords: ['Devoid'],
			oracleText:
				"Devoid (This card has no color.)\nWhenever you cast an Eldrazi spell, you may pay {C}{C}. If you do, copy all spells you control, then copy all other activated and triggered abilities you control. You may choose new targets for the copies. (Mana abilities can't be copied.)"
		})
};

describe('Wave 13: All 13 remaining precon cards (2 general + 11 hash-verified overrides) + synthetic rename proof', () => {
	it('Override hash-gate refuses stale, mutated-name, or mismatched-oracleId cards across all 11 Wave 13 overrides', () => {
		const overrideCards = [
			CANONICAL.academyManufactor(),
			CANONICAL.bello(),
			CANONICAL.biggerOnTheInside(),
			CANONICAL.indominusRex(),
			CANONICAL.sinUnending(),
			CANONICAL.benthicAnomaly(),
			CANONICAL.garrukCursed(),
			CANONICAL.illusionistsGambit(),
			CANONICAL.pathOfTheAnimist(),
			CANONICAL.theChainVeil(),
			CANONICAL.ulalek()
		];
		for (const c of overrideCards) {
			const comp = compileCard(c);
			assert.equal(comp.fullySupported, true, `${c.name} compiles cleanly via verified override`);
			assert.ok(
				resolveCardOverride(c.oracleId ?? '', comp.textHash, c.name, COMPILER_VERSION),
				`${c.name} resolves via oracleId + exact textHash`
			);

			const renamed = cloneRenamed(c, `Synthetic Alias ${c.name}`);
			const renamedComp = compileCard(renamed);
			assert.equal(
				resolveCardOverride(
					renamed.oracleId ?? '',
					renamedComp.textHash,
					renamed.name,
					COMPILER_VERSION
				),
				null,
				`${c.name} renamed clone must NOT match stale name/hash override`
			);

			const wrongOra = resolveCardOverride(
				'99999999-9999-9999-9999-999999999999',
				comp.textHash,
				c.name,
				COMPILER_VERSION
			);
			assert.equal(wrongOra, null, `${c.name} wrong oracleId must not serve override by name`);
		}
	});

	it('1. Glorybringer (general): optional exert on attack fires targeted 4-damage reflexive trigger and keeps exerted (canonical + renamed)', () => {
		for (const renamed of [false, true]) {
			const { state, p1, p2 } = setupGame();
			const gloryCard = renamed ? cloneRenamed(CANONICAL.glorybringer(), 'Synthetic Skyfire Drake') : CANONICAL.glorybringer();
			assert.equal(compileCard(gloryCard).fullySupported, true);
			const glory = putInZone(state, p1, gloryCard, 'battlefield');
			const oppBear = putInZone(
				state,
				p2,
				synthCard({ name: 'Target Bear', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Bear', power: '3', toughness: '4' }),
				'battlefield'
			);
			putInZone(
				state,
				p2,
				synthCard({ name: 'Target Wolf', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Wolf', power: '2', toughness: '2' }),
				'battlefield'
			);
			const oppDragon = putInZone(
				state,
				p2,
				synthCard({ name: 'Big Dragon', manaCost: '{4}{R}{R}', cmc: 6, typeLine: 'Creature — Dragon', power: '5', toughness: '5' }),
				'battlefield'
			);
			passUntilPhase(state, 'declare_attackers', 0);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: glory.instanceId, defenderPlayerId: p2.playerId }]
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			const exertPrm = state.pendingPrompts[0];
			assert.equal(exertPrm?.kind, 'yesNo');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: exertPrm.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			const targetPrm = state.pendingPrompts[0];
			assert.ok(targetPrm?.choice?.kind === 'chooseObjects');
			assert.equal(targetPrm.choice.candidates.includes(oppDragon.instanceId), false, 'Cannot target a Dragon');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: targetPrm.id,
					answer: { kind: 'chooseObjects', objectIds: [oppBear.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
			assert.equal(oppBear.zone, 'graveyard', 'Exert reflexive trigger dealt 4 lethal damage to non-Dragon');
			assert.equal(glory.exertedThisTurn, true, 'Glorybringer recorded exert state');
		}
	});

	it('2. Mazemind Tome (general): state trigger at >=4 page counters exiles itself and gains 4 life (canonical + renamed)', () => {
		for (const renamed of [false, true]) {
			const { state, p1 } = setupGame();
			const tomeCard = renamed ? cloneRenamed(CANONICAL.mazemindTome(), 'Synthetic Codex') : CANONICAL.mazemindTome();
			assert.equal(compileCard(tomeCard).fullySupported, true);
			const tome = putInZone(state, p1, tomeCard, 'battlefield', { counters: { page: 3 } });
			putInZone(state, p1, synthCard({ name: 'Top Card', manaCost: '{1}' }), 'library');
			const scryAb = getEffectiveActivatedAbilities(state, p1, tome).find((a) =>
				a.label.toLowerCase().includes('scry')
			);
			assert.ok(scryAb, 'Scry activated ability available');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: tome.instanceId,
					abilityId: scryAb.id
				}).ok,
				true
			);
			// Handle Scry prompt if any, then resolve state trigger
			for (let g = 0; g < 20; g++) {
				if (state.pendingPrompts.length > 0) {
					const prm = state.pendingPrompts[0];
					if (prm.kind === 'yesNo') {
						assert.equal(
							applyGameAction(state, prm.playerId, {
								type: 'choice',
								promptId: prm.id,
								answer: { kind: 'yesNo', yes: false }
							}).ok,
							true
						);
						continue;
					}
					if (prm.choice?.kind === 'orderObjects') {
						assert.equal(
							applyGameAction(state, prm.playerId, {
								type: 'choice',
								promptId: prm.id,
								answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
							}).ok,
							true
						);
						continue;
					}
					break;
				}
				if (state.stack.length > 0) {
					const actor = state.players[state.priorityPlayerIndex];
					assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
					continue;
				}
				break;
			}
			assert.equal(tome.zone, 'exile', 'State trigger exiled Tome at 4 page counters');
			assert.equal(p1.life, 44, 'Gained 4 life from exiling Tome');
		}
	});

	it('3. Academy Manufactor: Clue/Food/Treasure replacement creates one of each with 1 ability and preserves tapped (CR 614.6)', () => {
		const { state, p1 } = setupGame();
		putInZone(state, p1, CANONICAL.academyManufactor(), 'battlefield');
		const spell = putInZone(
			state,
			p1,
			synthCard({ name: 'Inspect Clue', manaCost: '{U}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Investigate.' }),
			'hand'
		);
		giveMana(p1, { U: 1 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spell.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		const created = p1.battlefield.filter((c) => c.isToken);
		assert.equal(created.length, 3, 'Created 3 tokens');
		for (const tokName of ['Clue', 'Food', 'Treasure']) {
			const tok = created.find((c) => c.card.name === tokName);
			assert.ok(tok, `Created ${tokName}`);
			assert.equal(tok.tapped, false, `${tokName} enters untapped from Investigate`);
			assert.equal(
				getEffectiveActivatedAbilities(state, p1, tok).length,
				1,
				`${tokName} must have exactly 1 activated ability (no duplicate quotedAbilities)`
			);
		}

		// Tapped Treasure creation -> Clue, Food, and Treasure all enter tapped (CR 614.6)
		const tappedSpell = putInZone(
			state,
			p1,
			synthCard({
				name: 'Tapped Hoard',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Create a tapped Treasure token.'
			}),
			'hand'
		);
		giveMana(p1, { R: 1 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: tappedSpell.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		const newlyCreated = p1.battlefield.filter((c) => c.isToken && !created.includes(c));
		assert.equal(newlyCreated.length, 3, 'Created 3 tapped replacement tokens');
		for (const tokName of ['Clue', 'Food', 'Treasure']) {
			const tok = newlyCreated.find((c) => c.card.name === tokName);
			assert.ok(tok, `Created tapped ${tokName}`);
			assert.equal(tok.tapped, true, `${tokName} must inherit tapped: true via CR 614.6`);
			assert.equal(getEffectiveActivatedAbilities(state, p1, tok).length, 1, `Tapped ${tokName} has 1 activated ability`);
		}
	});

	it('4. Bello, Bard of the Brambles: animates MV>=4 non-Equipment artifacts & non-Aura enchantments only on your turn + combat damage draw', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p1, CANONICAL.bello(), 'battlefield');
		const lotus = putInZone(
			state,
			p1,
			synthCard({ name: 'Big Artifact', manaCost: '{5}', cmc: 5, typeLine: 'Artifact' }),
			'battlefield'
		);
		const smallArt = putInZone(
			state,
			p1,
			synthCard({ name: 'Small Relic', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' }),
			'battlefield'
		);
		const bigEquip = putInZone(
			state,
			p1,
			synthCard({ name: 'Big Sword', manaCost: '{4}', cmc: 4, typeLine: 'Artifact — Equipment' }),
			'battlefield'
		);
		const bigEnch = putInZone(
			state,
			p1,
			synthCard({ name: 'Big Enchantment', manaCost: '{3}{G}', cmc: 4, typeLine: 'Enchantment' }),
			'battlefield'
		);
		putInZone(state, p1, synthCard({ name: 'Drawn Spell', manaCost: '{R}' }), 'library');
		putInZone(state, p1, synthCard({ name: 'Drawn Spell 2', manaCost: '{G}' }), 'library');

		const evLotus = evaluatePermanent(state, lotus);
		assert.equal(evLotus.isCreature, true, 'MV 5 artifact is animated during your turn');
		assert.equal(evLotus.power, 4);
		assert.equal(evLotus.toughness, 4);
		assert.equal(evLotus.typeLine.includes('Elemental'), true);
		assert.equal(evaluatePermanent(state, bigEnch).isCreature, true, 'MV 4 enchantment is animated');
		assert.equal(evaluatePermanent(state, smallArt).isCreature, false, 'MV 1 artifact not animated');
		assert.equal(evaluatePermanent(state, bigEquip).isCreature, false, 'Equipment excluded');

		// Attack with animated lotus (has Haste from Bello)
		lotus.summoningSick = true;
		passUntilPhase(state, 'declare_attackers', 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: lotus.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		passUntilPhase(state, 'declare_blockers', 0);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
		passUntilPhase(state, 'main2', 0);
		assert.equal(p2.life, 36, 'Animated 4/4 artifact dealt 4 combat damage');
		assert.equal(p1.hand.length, 1, 'Combat damage trigger drew 1 card');

		// Advance to opponent turn: noncreature during opponent turn
		passUntilPhase(state, 'main1', 1);
		assert.equal(evaluatePermanent(state, lotus).isCreature, false, 'Not a creature during opponent turn');
		assert.equal(evaluatePermanent(state, bigEnch).isCreature, false, 'Enchantment reverts during opponent turn');
	});

	it('5. Bigger on the Inside: grants target-player 2 mana of one color + next spell cascade', () => {
		const { state, p1 } = setupGame();
		const land = putInZone(
			state,
			p1,
			synthCard({ name: 'Target Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }),
			'battlefield'
		);
		const aura = putInZone(state, p1, CANONICAL.biggerOnTheInside(), 'hand');
		const fourDrop = putInZone(
			state,
			p1,
			synthCard({ name: 'Hill Giant', manaCost: '{3}{R}', cmc: 4, typeLine: 'Creature — Giant', power: '3', toughness: '3', colors: ['R'] }),
			'hand'
		);
		const cascadeHit = synthCard({
			name: 'Cascade Ping',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Sorcery',
			colors: ['R'],
			oracleText: '~ deals 2 damage to target opponent.'
		});
		const landFiller = synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' });
		p1.library = [
			createCardInstance(landFiller, p1.playerId, 'library', false, false, ++state.nextTimestamp!),
			createCardInstance(cascadeHit, p1.playerId, 'library', false, false, ++state.nextTimestamp!),
			...Array.from({ length: 4 }, () =>
				createCardInstance(landFiller, p1.playerId, 'library', false, false, ++state.nextTimestamp!)
			)
		];
		giveMana(p1, { R: 1, G: 1, C: 3 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: aura.instanceId,
				targets: [{ kind: 'permanent', id: land.instanceId, label: land.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);

		const grantedAb = getEffectiveActivatedAbilities(state, p1, land).find((a) =>
			a.label.toLowerCase().includes('cascade') || a.label.toLowerCase().includes('two mana')
		);
		assert.ok(grantedAb, 'Land gained Bigger on the Inside activated ability');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: land.instanceId,
				abilityId: grantedAb.id,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		const colorPrm = state.pendingPrompts[0];
		if (colorPrm?.choice?.kind === 'chooseMode') {
			const rIdx = colorPrm.choice.modes.findIndex((m) => m.toLowerCase().includes('red') || m === 'R');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: colorPrm.id,
					answer: { kind: 'chooseMode', indices: [rIdx >= 0 ? rIdx : 3] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal((p1.manaPool.R ?? 0) >= 2 || Object.values(p1.manaPool).reduce((a, b) => a + b, 0) >= 2, true, 'Added 2 mana');
		assert.equal(p1.nextSpellCascadeCount, 1, 'Next spell gained cascade');

		giveMana(p1, { R: 1, C: 3 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: fourDrop.instanceId }).ok, true);
		for (let g = 0; g < 20; g++) {
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				if (prm.kind === 'yesNo') {
					assert.equal(
						applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'yesNo', yes: true }
						}).ok,
						true
					);
					continue;
				}
				if (prm.choice?.kind === 'chooseMode') {
					assert.equal(
						applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseMode', indices: prm.choice.defaultIndices ?? [0] }
						}).ok,
						true
					);
					continue;
				}
				break;
			}
			if (state.stack.length > 0) {
				const actor = state.players[state.priorityPlayerIndex];
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				continue;
			}
			break;
		}
		assert.equal(state.players[1].life, 38, 'Cascade free-cast 2-mana sorcery dealt 2 damage');
	});

	it('6. Indominus Rex, Alpha: discards creature cards on ETB for keyword counters and draws equal cards', () => {
		const { state, p1 } = setupGame();
		const rex = putInZone(state, p1, CANONICAL.indominusRex(), 'hand');
		const bird = putInZone(
			state,
			p1,
			synthCard({ name: 'Keyword Hawk', manaCost: '{1}{W}', cmc: 2, typeLine: 'Creature — Bird', power: '2', toughness: '2', keywords: ['Flying', 'Lifelink'], oracleText: 'Flying, lifelink' }),
			'hand'
		);
		const viper = putInZone(
			state,
			p1,
			synthCard({ name: 'Keyword Viper', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Snake', power: '2', toughness: '2', keywords: ['Deathtouch', 'Trample'], oracleText: 'Deathtouch, trample' }),
			'hand'
		);
		giveMana(p1, { U: 2, G: 2, C: 1 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: rex.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		const prm = state.pendingPrompts[0];
		assert.ok(prm?.choice?.kind === 'chooseObjects', 'ETB discard prompt queued');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [bird.instanceId, viper.instanceId] }
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		const bfRex = findInstance(state, rex.instanceId);
		assert.equal(bfRex?.zone, 'battlefield');
		assert.equal(bfRex?.inst.counters.flying, 1);
		assert.equal(bfRex?.inst.counters.lifelink, 1);
		assert.equal(bfRex?.inst.counters.deathtouch, 1);
		assert.equal(bfRex?.inst.counters.trample, 1);
		assert.equal(p1.hand.length, 4, 'ETB trigger drew 4 cards (one per keyword counter)');
		assert.equal(bird.zone, 'graveyard');
		assert.equal(viper.zone, 'graveyard');
	});

	it('7. Sin, Unending Cataclysm: removes counters for 2x +1/+1 counters on ETB, then transfers counters and shuffles on death', () => {
		const { state, p1, p2 } = setupGame();
		const ally = putInZone(
			state,
			p1,
			synthCard({ name: 'Ally Golem', manaCost: '{2}', cmc: 2, typeLine: 'Artifact Creature — Golem', power: '2', toughness: '2' }),
			'battlefield',
			{ counters: { '+1/+1': 2 } }
		);
		const oppArt = putInZone(
			state,
			p2,
			synthCard({ name: 'Opp Battery', manaCost: '{2}', cmc: 2, typeLine: 'Artifact' }),
			'battlefield',
			{ counters: { charge: 3 } }
		);
		const sin = putInZone(state, p1, CANONICAL.sinUnending(), 'hand');
		giveMana(p1, { G: 1, U: 1, C: 5 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: sin.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		const prm = state.pendingPrompts[0];
		assert.ok(prm?.choice?.kind === 'chooseObjects', 'ETB remove counters prompt queued');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [ally.instanceId, oppArt.instanceId] }
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		const bfSin = findInstance(state, sin.instanceId);
		assert.equal(bfSin?.zone, 'battlefield');
		assert.equal(ally.counters['+1/+1'], 0, 'Removed +1/+1 counters from ally');
		assert.equal(oppArt.counters.charge, 0, 'Removed charge counters from opp artifact');
		assert.equal(bfSin?.inst.counters['+1/+1'], 10, 'Sin entered with 2x5 = 10 +1/+1 counters');

		// Kill Sin -> dies trigger moves its 10 counters to ally and shuffles Sin into library
		const murder = putInZone(
			state,
			p1,
			synthCard({ name: 'Murder', manaCost: '{1}{B}', cmc: 2, typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		giveMana(p1, { B: 1, C: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: murder.instanceId,
				targets: [{ kind: 'permanent', id: bfSin!.inst.instanceId, label: bfSin!.inst.card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			const tPrm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: tPrm.id,
					answer: { kind: 'chooseObjects', objectIds: [ally.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}
		assert.equal(ally.counters['+1/+1'], 10, 'Sin dies trigger put all 10 +1/+1 counters on target creature you control');
		assert.equal(findInstance(state, sin.instanceId)?.zone, 'library', 'Sin shuffled into owner library');
	});

	it('8. Benthic Anomaly (3P): chooses creature per opponent, sums P/T, and creates colorless Eldrazi token copy', () => {
		const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
		const p2Big = putInZone(
			state,
			p2,
			synthCard({ name: 'Opp2 Giant', manaCost: '{3}{R}', cmc: 4, typeLine: 'Creature — Giant', power: '3', toughness: '4', colors: ['R'] }),
			'battlefield'
		);
		putInZone(
			state,
			p2,
			synthCard({ name: 'Opp2 Goblin', manaCost: '{R}', cmc: 1, typeLine: 'Creature — Goblin', power: '1', toughness: '1', colors: ['R'] }),
			'battlefield'
		);
		const p3Angel = putInZone(
			state,
			p3!,
			synthCard({ name: 'Opp3 Angel', manaCost: '{3}{W}{W}', cmc: 5, typeLine: 'Creature — Angel', power: '5', toughness: '2', colors: ['W'], keywords: ['Flying'], oracleText: 'Flying' }),
			'battlefield'
		);
		const anom = putInZone(state, p1, CANONICAL.benthicAnomaly(), 'hand');
		giveMana(p1, { U: 1, C: 6 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: anom.instanceId }).ok, true);
		let step = 0;
		for (let g = 0; g < 30; g++) {
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				if (prm.choice?.kind === 'chooseObjects') {
					const pickId = step === 0 ? p2Big.instanceId : p3Angel.instanceId;
					step += 1;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseObjects', objectIds: [pickId] }
						}).ok,
						true
					);
					continue;
				}
				break;
			}
			if (state.stack.length > 0) {
				const actor = state.players[state.priorityPlayerIndex];
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				continue;
			}
			break;
		}
		const tok = p1.battlefield.find((c) => c.isToken);
		assert.ok(tok, 'Created token copy');
		const ev = evaluatePermanent(state, tok);
		assert.equal(ev.power, 8, 'Total power = 3 + 5 = 8');
		assert.equal(ev.toughness, 6, 'Total toughness = 4 + 2 = 6');
		assert.deepEqual(ev.colors, [], 'Colorless Eldrazi token');
		assert.equal(ev.typeLine.includes('Eldrazi'), true);
		assert.equal(ev.typeLine.includes('Angel'), true);
		assert.equal(ev.keywords.some((k) => k.toLowerCase() === 'flying'), true);
	});

	it('9. Garruk, Cursed Huntsman: 0 loyalty creates 2/2 black-green Wolves whose death puts loyalty counter on each Garruk', () => {
		const { state, p1 } = setupGame();
		const garruk = putInZone(state, p1, CANONICAL.garrukCursed(), 'battlefield', { counters: { loyalty: 5 } });
		const zeroAb = getEffectiveActivatedAbilities(state, p1, garruk).find((a) => a.id === 'loyalty_0');
		assert.ok(zeroAb, '0 loyalty ability present');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: garruk.instanceId,
				abilityId: zeroAb.id
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		const wolves = p1.battlefield.filter((c) => c.isToken && c.card.name === 'Wolf');
		assert.equal(wolves.length, 2, 'Created two Wolf tokens');
		assert.equal(evaluatePermanent(state, wolves[0]).power, 2);
		assert.equal(evaluatePermanent(state, wolves[0]).toughness, 2);

		const doom = putInZone(
			state,
			p1,
			synthCard({ name: 'Kill Wolf', manaCost: '{B}', cmc: 1, typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		giveMana(p1, { B: 1 });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: doom.instanceId,
				targets: [{ kind: 'permanent', id: wolves[0].instanceId, label: wolves[0].card.name }]
			}).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(garruk.counters.loyalty, 6, 'Wolf death trigger added +1 loyalty counter to Garruk');
	});

	it('10. Illusionist\'s Gambit (3P): removes attackers, untaps, creates extra combat forcing attacks not against caster', () => {
		const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
		const attacker = putInZone(
			state,
			p2,
			synthCard({ name: 'P2 Crusher', manaCost: '{3}{G}', cmc: 4, typeLine: 'Creature — Beast', power: '4', toughness: '4' }),
			'battlefield'
		);
		const gambit = putInZone(state, p1, CANONICAL.illusionistsGambit(), 'hand');

		// Advance to p2 declare_attackers
		passUntilPhase(state, 'declare_attackers', 1);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p1.playerId }]
			}).ok,
			true
		);
		assert.equal(attacker.tapped, true);
		passUntilPhase(state, 'declare_blockers', 1);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
		// Pass priority around the 3P table until p1 holds priority in declare_blockers
		for (let pGuard = 0; pGuard < 4 && state.players[state.priorityPlayerIndex].playerId !== p1.playerId; pGuard++) {
			assert.equal(applyGameAction(state, state.players[state.priorityPlayerIndex].playerId, { type: 'pass_priority' }).ok, true);
		}
		giveMana(p1, { U: 2, C: 2 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: gambit.instanceId }).ok, true);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(state.combat.attackers.length, 0, 'Attackers removed from combat');
		assert.equal(attacker.tapped, false, 'Removed attacker untapped');
		assert.equal(state.additionalCombatPhases, 1, 'Additional combat scheduled');

		passUntilPhase(state, 'declare_attackers', 1);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p1.playerId }]
			}).ok,
			false,
			'Cannot attack Gambit caster in forced extra combat'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'declare_attackers', assignments: [] }).ok,
			false,
			'Cannot omit creature that attacked last combat when p3 is legal defender'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p3!.playerId }]
			}).ok,
			true,
			'Legal attack against third player p3 succeeds'
		);
		passUntilPhase(state, 'declare_blockers', 1);
		assert.equal(applyGameAction(state, p3!.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);
		passUntilPhase(state, 'main2', 1);
		assert.equal(p1.life, 40, 'Caster p1 took 0 combat damage');
		assert.equal(p3!.life, 36, 'Third player p3 took 4 combat damage');
	});

	it('11. Path of the Animist: searches up to 2 basic lands tapped then runs Will of the Planeswalkers vote (chaos wins ties)', () => {
		const { state, p1 } = setupGame();
		const path = putInZone(state, p1, CANONICAL.pathOfTheAnimist(), 'hand');
		const b1 = putInZone(state, p1, synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }), 'library');
		const b2 = putInZone(state, p1, synthCard({ name: 'Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' }), 'library');
		giveMana(p1, { G: 1, C: 3 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: path.instanceId }).ok, true);
		const searchPicks = [b1.instanceId, b2.instanceId];
		const voteOrder = [0, 1]; // p1 votes Planeswalk (0), p2 votes Chaos (1) -> tie -> Chaos ensues!
		for (let g = 0; g < 30; g++) {
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				if (prm.purpose === 'search_library') {
					const nid = searchPicks.shift();
					assert.equal(
						applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseObjects', objectIds: nid ? [nid] : [] }
						}).ok,
						true
					);
					continue;
				}
				if (prm.choice?.kind === 'chooseMode') {
					const vIdx = voteOrder.shift() ?? 1;
					assert.equal(
						applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseMode', indices: [vIdx] }
						}).ok,
						true
					);
					continue;
				}
				break;
			}
			if (state.stack.length > 0) {
				const actor = state.players[state.priorityPlayerIndex];
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				continue;
			}
			break;
		}
		assert.equal(b1.zone, 'battlefield');
		assert.equal(b1.tapped, true);
		assert.equal(b2.zone, 'battlefield');
		assert.equal(b2.tapped, true);
		assert.equal(
			state.log.some((l) => l.text.includes('Chaos ensues')),
			true,
			'Tie in Will of the Planeswalkers resolved Chaos ensues via tieWinnerIndex'
		);
	});

	it('12. The Chain Veil: grants additional loyalty activation per planeswalker this turn and drains 2 on end step if unused', () => {
		const { state, p1 } = setupGame();
		const veil = putInZone(state, p1, CANONICAL.theChainVeil(), 'battlefield');
		const garruk = putInZone(state, p1, CANONICAL.garrukCursed(), 'battlefield', { counters: { loyalty: 5 } });
		const oppCrit = putInZone(
			state,
			state.players[1],
			synthCard({ name: 'Target Fodder', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const zeroAb = getEffectiveActivatedAbilities(state, p1, garruk).find((a) => a.id === 'loyalty_0');
		const minus3 = getEffectiveActivatedAbilities(state, p1, garruk).find((a) => a.id === 'loyalty_1');
		assert.ok(zeroAb && minus3);

		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: garruk.instanceId, abilityId: zeroAb.id }).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: garruk.instanceId,
				abilityId: minus3.id,
				targets: [{ kind: 'permanent', id: oppCrit.instanceId, label: oppCrit.card.name }]
			}).ok,
			false
		);

		const veilAb = getEffectiveActivatedAbilities(state, p1, veil).find((a) => !a.isManaAbility);
		assert.ok(veilAb, 'Chain Veil activated ability found');
		giveMana(p1, { C: 4 });
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: veil.instanceId, abilityId: veilAb.id }).ok,
			true
		);
		resolveAllStackAndOrderPrompts(state);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: garruk.instanceId,
				abilityId: minus3.id,
				targets: [{ kind: 'permanent', id: oppCrit.instanceId, label: oppCrit.card.name }]
			}).ok,
			true,
			'Chain Veil enabled second loyalty activation this turn'
		);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(oppCrit.zone, 'graveyard');

		passUntilPhase(state, 'main1', 1);
		passUntilPhase(state, 'main1', 0);
		const lifeBefore = p1.life;
		passUntilPhase(state, 'end_step', 0);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(p1.life, lifeBefore - 2, 'End step trigger drained 2 life on turn with 0 loyalty activations');
	});

	it('13. Ulalek, Fused Atrocity: Eldrazi cast + pay {C}{C} copies all controlled spells and other stack abilities', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p1, CANONICAL.ulalek(), 'battlefield');
		const pinger = putInZone(
			state,
			p1,
			synthCard({
				name: 'Spark Caster',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Wizard',
				power: '1',
				toughness: '1',
				oracleText: '{T}: ~ deals 1 damage to target opponent.'
			}),
			'battlefield'
		);
		const pingAb = getEffectiveActivatedAbilities(state, p1, pinger)[0];
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: pinger.instanceId,
				abilityId: pingAb.id,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		const flashEldrazi = putInZone(
			state,
			p1,
			synthCard({
				name: 'Eldrazi Bolt',
				manaCost: '{2}{U}',
				cmc: 3,
				typeLine: 'Creature — Eldrazi',
				power: '2',
				toughness: '2',
				colors: [],
				keywords: ['Devoid', 'Flash'],
				oracleText: 'Devoid\nFlash\nWhen you cast this spell, you gain 2 life.'
			}),
			'hand'
		);
		giveMana(p1, { U: 1, C: 4 });
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: flashEldrazi.instanceId }).ok, true);
		if (state.pendingPrompts[0]?.purpose === 'trigger_order') {
			const orderPrm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, orderPrm.playerId, {
					type: 'choice',
					promptId: orderPrm.id,
					answer: { kind: 'orderObjects', topIds: [...(orderPrm.candidateInstanceIds ?? [])].reverse() }
				}).ok,
				true
			);
		}
		resolveAllStackAndOrderPrompts(state);
		for (let g = 0; g < 20; g++) {
			if (state.pendingPrompts.length > 0) {
				const prm = state.pendingPrompts[0];
				if (prm.kind === 'yesNo') {
					const yes = prm.title.toLowerCase().includes('retarget') ? false : true;
					assert.equal(
						applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'yesNo', yes }
						}).ok,
						true
					);
					continue;
				}
				break;
			}
			if (state.stack.length > 0) {
				const actor = state.players[state.priorityPlayerIndex];
				assert.equal(applyGameAction(state, actor.playerId, { type: 'pass_priority' }).ok, true);
				continue;
			}
			break;
		}
		const eldrazisOnBf = p1.battlefield.filter((c) => c.card.name === 'Eldrazi Bolt');
		assert.equal(eldrazisOnBf.length, 2, 'Ulalek copied the Eldrazi spell on the stack (original + token copy)');
		assert.equal(p1.life, 44, 'Ulalek copied the Eldrazi cast trigger (2x gain 2 life)');
		assert.equal(p2.life, 38, 'Ulalek copied the activated ping ability below on the stack (2x 1 damage)');
	});

	it('14. Benthic Anomaly: copying a Bello-animated MV>=4 noncreature Artifact yields a 4/4 colorless Eldrazi Creature', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p2, CANONICAL.bello(), 'battlefield');
		const bigLotus = putInZone(
			state,
			p2,
			synthCard({ name: 'Big Lotus', manaCost: '{5}', cmc: 5, typeLine: 'Artifact', colors: ['U'] }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Flash Enabler',
				manaCost: '{4}',
				cmc: 4,
				typeLine: 'Artifact',
				oracleText: 'You may cast spells as though they had flash.'
			}),
			'battlefield'
		);
		const anom = putInZone(state, p1, CANONICAL.benthicAnomaly(), 'hand');

		// Advance to P2 main1 so Bello animates Big Lotus into a 4/4 Elemental creature
		passUntilPhase(state, 'main1', 1);
		assert.equal(evaluatePermanent(state, bigLotus).isCreature, true, 'Big Lotus is animated by Bello on P2 turn');
		assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
		assert.equal(state.players[state.priorityPlayerIndex]?.playerId, p1.playerId, 'P1 holds priority on P2 main1');

		giveMana(p1, { U: 1, C: 6 });
		const castRes = applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: anom.instanceId });
		assert.equal(castRes.ok, true, castRes.ok ? '' : (castRes.error ?? ''));
		resolveAllStackAndOrderPrompts(state);
		if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
			const prm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, prm.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [bigLotus.instanceId] }
				}).ok,
				true
			);
			resolveAllStackAndOrderPrompts(state);
		}

		const tok = p1.battlefield.find((c) => c.isToken);
		assert.ok(tok, 'Created Benthic Anomaly token copy');
		const ev = evaluatePermanent(state, tok);
		assert.equal(ev.isCreature, true, 'Token copy of animated noncreature must be a Creature');
		assert.equal(ev.power, 4, 'Power matches animated 4/4');
		assert.equal(ev.toughness, 4, 'Toughness matches animated 4/4');
		assert.deepEqual(ev.colors, [], 'Colorless');
		assert.equal(ev.typeLine.includes('Creature'), true, 'TypeLine includes Creature');
		assert.equal(ev.typeLine.includes('Eldrazi'), true, 'TypeLine includes Eldrazi');
	});

	it('15. The Chain Veil: end-step trigger ignores opponent loyalty activations during controller turn', () => {
		const { state, p1 } = setupGame();
		putInZone(state, p1, CANONICAL.theChainVeil(), 'battlefield');
		// Simulate an opponent activating a loyalty ability during P1's turn without P1 doing so
		state.activatedLoyaltyAbilityThisTurn = true;
		delete p1.activatedLoyaltyAbilityThisTurn;
		const lifeBefore = p1.life;
		passUntilPhase(state, 'end_step', 0);
		resolveAllStackAndOrderPrompts(state);
		assert.equal(p1.life, lifeBefore - 2, 'The Chain Veil drains 2 life when controller activated no loyalty abilities');
	});
});

