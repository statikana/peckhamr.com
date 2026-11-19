import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type ChoiceAnswer,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

let w10Seq = 0;

const CARD_CATALOG = new Map<string, ScryfallCard>();
for (const d of PRECON_DECKS) {
	for (const e of d.cards) CARD_CATALOG.set(e.card.name, e.card);
}
for (const v of Object.values(STAPLE_CARDS)) {
	if (Array.isArray(v)) {
		for (const c of v) CARD_CATALOG.set(c.name, c);
	} else if (v && typeof v === 'object' && 'name' in v) {
		CARD_CATALOG.set((v as ScryfallCard).name, v as ScryfallCard);
	}
}

function realCard(name: string): ScryfallCard {
	const c = CARD_CATALOG.get(name);
	assert.ok(c, `Expected canonical card '${name}' in PRECON_DECKS/STAPLE_CARDS`);
	return c;
}

function cloneRenamed(base: ScryfallCard, newName: string): ScryfallCard {
	const shortComma = base.name.split(',')[0].trim();
	const shortOf = base.name.split(/\s+of\s+/i)[0].trim();
	const newShort = newName.split(',')[0].split(/\s+of\s+/i)[0].trim();
	let nextText = base.oracleText.split(base.name).join(newName);
	for (const short of [shortComma, shortOf]) {
		if (short && short !== base.name && short.length >= 3) {
			nextText = nextText.replace(new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), newShort);
		}
	}
	w10Seq += 1;
	return {
		...base,
		id: `syn_w10_clone_${w10Seq}`,
		oracleId: `ora_w10_clone_${w10Seq}`,
		name: newName,
		oracleText: nextText
	};
}

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	w10Seq += 1;
	const id = overrides.id ?? `syn_w10_${w10Seq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_w10_${w10Seq}`,
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
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		layout: overrides.layout ?? 'normal'
	};
}

function makeDeck(cards: ScryfallCard[]): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_w10_${++w10Seq}`,
		userId: 'p1',
		name: 'Wave 10 Deck',
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

function setupGame(opts: { p1Bot?: boolean; p2Bot?: boolean; p3Bot?: boolean; playerCount?: 2 | 3 } = {}) {
	const filler = synthCard({
		name: 'Basic Island',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Island',
		oracleText: '({T}: Add {U}.)'
	});
	const count = opts.playerCount ?? 2;
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	for (let i = 0; i < count; i++) {
		const d = makeDeck(Array.from({ length: 30 }, () => filler));
		decks.set(i, d);
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `Player${i + 1}`,
			avatarUrl: '',
			isBot: i === 0 ? Boolean(opts.p1Bot) : i === 1 ? Boolean(opts.p2Bot) : Boolean(opts.p3Bot),
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
	const state = createInitialGameState('W10', seats, decks, DEFAULT_LOBBY_RULES);
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
	return { state, p1: state.players[0]!, p2: state.players[1]!, p3: state.players[2] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library',
	opts: { summoningSick?: boolean; counters?: Record<string, number>; tapped?: boolean } = {}
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = opts.summoningSick ?? false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
		if (opts.tapped) inst.tapped = true;
	}
	if (opts.counters) inst.counters = { ...inst.counters, ...opts.counters };
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor | 'C', number>>): void {
	for (const [k, v] of Object.entries(pool)) {
		if (typeof v === 'number') player.manaPool[k as ManaColor | 'C'] = (player.manaPool[k as ManaColor | 'C'] ?? 0) + v;
	}
}

function resolveAllStackAndOrderPrompts(state: GameState): void {
	for (let guard = 0; guard < 200; guard++) {
		if (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0]!;
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
		const actor = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
	assert.fail(`resolveAllStackAndOrderPrompts exceeded 200 iterations (stack=${state.stack.length})`);
}

function passUntilPhase(state: GameState, targetPhase: GameState['phase'], targetActiveIndex?: number): void {
	for (let guard = 0; guard < 500; guard++) {
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
		const actor = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
	assert.fail(`Failed to reach phase ${targetPhase} (stuck in ${state.phase})`);
}

function castSpell(
	state: GameState,
	caster: PlayerGameState,
	inst: CardInstance,
	opts: {
		targets?: Array<{ kind: TargetRef['kind']; id: string; label?: string }>;
		xValue?: number;
		modeIndices?: number[];
	} = {}
): void {
	const mappedTargets: TargetRef[] | undefined = opts.targets?.map((t) => ({
		kind: t.kind,
		id: t.id,
		label: t.label ?? t.id
	}));
	const res = applyGameAction(state, caster.playerId, {
		type: 'cast_spell',
		instanceId: inst.instanceId,
		...(mappedTargets ? { targets: mappedTargets } : {}),
		...(opts.xValue !== undefined ? { xValue: opts.xValue } : {}),
		...(opts.modeIndices ? { modes: opts.modeIndices } : {})
	});
	assert.equal(res.ok, true, res.ok ? '' : (res.error ?? 'cast failed'));
}

function vanillaCreature(name: string, power: number, toughness: number, color: ManaColor = 'G', mv = 2): ScryfallCard {
	return synthCard({
		name,
		manaCost: `{${mv}}`,
		cmc: mv,
		typeLine: 'Creature — Beast',
		colors: [color],
		power: String(power),
		toughness: String(toughness)
	});
}

describe('Wave 10: Multiplayer Loops, Punishers, Partitions & Combat Shields', () => {
	describe('1. Multiplayer & Per-Player Sequential Loops + Random Opponent', () => {
		it('Cut a Deal (canonical + synthetic clone): each opponent draws 1 then controller draws for each opponent who drew', () => {
			for (const card of [realCard('Cut a Deal'), cloneRenamed(realCard('Cut a Deal'), 'Diplomatic Accord')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
				const deal = putInZone(state, p1, card, 'hand');
				giveMana(p1, { W: 1, C: 2 });
				castSpell(state, p1, deal);
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p2.hand.length, 1);
				assert.equal(p3!.hand.length, 1);
				assert.equal(p1.hand.length, 2);
			}
		});

		it('Syphon Mind (canonical + synthetic clone): each other player discards 1 and controller draws for each card discarded', () => {
			for (const card of [realCard('Syphon Mind'), cloneRenamed(realCard('Syphon Mind'), 'Neural Siphon')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
				const fodder = synthCard({ name: 'Fodder', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
				putInZone(state, p2, fodder, 'hand');
				putInZone(state, p3!, fodder, 'hand');
				const spell = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 1, C: 3 });
				castSpell(state, p1, spell);
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p2.graveyard.length, 1);
				assert.equal(p3!.graveyard.length, 1);
				assert.equal(p1.hand.length, 2);
			}
		});

		it('Living Death (canonical + synthetic clone): exiles all GY creatures, sacrifices all BF creatures, returns exiled cards', () => {
			for (const card of [realCard('Living Death'), cloneRenamed(realCard('Living Death'), 'Cycle of Graves')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				const bearBf = putInZone(state, p1, vanillaCreature('Living Bear', 2, 2), 'battlefield');
				const wurmGy = putInZone(state, p1, vanillaCreature('Dead Wurm', 6, 6), 'graveyard');
				const oppBf = putInZone(state, p2, vanillaCreature('Opp Knight', 3, 3), 'battlefield');
				const oppGy = putInZone(state, p2, vanillaCreature('Opp Angel', 4, 4), 'graveyard');
				const ld = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 2, C: 3 });
				castSpell(state, p1, ld);
				resolveAllStackAndOrderPrompts(state);
				assert.ok(p1.battlefield.some((c) => c.instanceId === wurmGy.instanceId));
				assert.ok(p1.graveyard.some((c) => c.instanceId === bearBf.instanceId));
				assert.ok(p2.battlefield.some((c) => c.instanceId === oppGy.instanceId));
				assert.ok(p2.graveyard.some((c) => c.instanceId === oppBf.instanceId));
			}
		});

		it('Adeline, Resplendent Cathar (canonical + synthetic clone): creates a 1/1 Human tapped and attacking each opponent', () => {
			for (const card of [
				realCard('Adeline, Resplendent Cathar'),
				cloneRenamed(realCard('Adeline, Resplendent Cathar'), 'Lyra, Cathar Marshal')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
				const adeline = putInZone(state, p1, card, 'battlefield', { summoningSick: false });
				passUntilPhase(state, 'declare_attackers', 0);
				const atkRes = applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: adeline.instanceId, defenderPlayerId: p2.playerId }]
				});
				assert.equal(atkRes.ok, true, atkRes.ok ? '' : (atkRes.error ?? ''));
				resolveAllStackAndOrderPrompts(state);
				const humans = p1.battlefield.filter((c) => c.card.typeLine.includes('Human') && c.instanceId !== adeline.instanceId);
				assert.equal(humans.length, 2);
				assert.ok(humans.every((h) => h.tapped));
				assert.equal(state.combat.attackers.length, 3);
				assert.ok(state.combat.attackers.some((a) => a.defenderPlayerId === p3!.playerId));
			}
		});

		it('Ruhan of the Fomori (canonical + synthetic clone): chooses an opponent at random at beginning of combat', () => {
			for (const card of [
				realCard('Ruhan of the Fomori'),
				cloneRenamed(realCard('Ruhan of the Fomori'), 'Borborygmos, Lost Giant')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1 } = setupGame({ playerCount: 3 });
				const ruhan = putInZone(state, p1, card, 'battlefield', { summoningSick: false });
				passUntilPhase(state, 'declare_attackers', 0);
				// Passing empty attackers must be rejected since Ruhan must attack the chosen opponent if able
				const failEmpty = applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: []
				});
				assert.equal(failEmpty.ok, false);
				const oppId = ruhan.mustAttackPlayerIdThisTurn;
				assert.ok(oppId && oppId !== p1.playerId, 'Expected random opponent to be bound to mustAttackPlayerIdThisTurn');
				const okAtk = applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: ruhan.instanceId, defenderPlayerId: oppId! }]
				});
				assert.equal(okAtk.ok, true, okAtk.ok ? '' : (okAtk.error ?? ''));
			}
		});
	});

	describe('2. Punishers & Opponent-Choice Splits', () => {
		it('Perplex (canonical + synthetic clone): counters spell unless controller discards hand', () => {
			for (const card of [realCard('Perplex'), cloneRenamed(realCard('Perplex'), 'Mind Scramble')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				state.activePlayerIndex = 1;
				state.priorityPlayerIndex = 1;
				const oppSpell = putInZone(state, p2, vanillaCreature('Opp Titan', 6, 6, 'G', 1), 'hand');
				const keepInHand = putInZone(state, p2, vanillaCreature('Spare Card', 1, 1), 'hand');
				giveMana(p2, { G: 1 });
				castSpell(state, p2, oppSpell);
				applyGameAction(state, p2.playerId, { type: 'pass_priority' });
				const stackId = state.stack[0]!.id;
				const perplex = putInZone(state, p1, card, 'hand');
				giveMana(p1, { U: 1, B: 1, C: 1 });
				castSpell(state, p1, perplex, { targets: [{ kind: 'stack', id: stackId, label: 'Opp Titan' }] });
				resolveAllStackAndOrderPrompts(state);
				// P2 chooses to decline discarding hand (mode index 1) -> oppSpell countered
				const prm = state.pendingPrompts[0]!;
				assert.ok(prm && prm.playerId === p2.playerId);
				const choice = applyGameAction(state, p2.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseMode', indices: [1] }
				});
				assert.equal(choice.ok, true);
				resolveAllStackAndOrderPrompts(state);
				assert.ok(p2.graveyard.some((c) => c.instanceId === oppSpell.instanceId));
				assert.ok(p2.hand.some((c) => c.instanceId === keepInHand.instanceId));
			}
		});

		it('Braids, Arisen Nightmare (canonical + synthetic clone): end step punisher draws + drains per declining opponent', () => {
			for (const card of [
				realCard('Braids, Arisen Nightmare'),
				cloneRenamed(realCard('Braids, Arisen Nightmare'), 'Mirella, Nightmare Weaver')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2, p2Bot: true });
				putInZone(state, p1, card, 'battlefield');
				const sacArt = putInZone(
					state,
					p1,
					synthCard({ name: 'Spare Relic', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 }),
					'battlefield'
				);
				passUntilPhase(state, 'end_step', 0);
				// Trigger resolves and asks P1 whether to sacrifice a creature/artifact/enchantment/land/planeswalker
				const accept = applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0]!.id,
					answer: { kind: 'yesNo', yes: true }
				});
				assert.equal(accept.ok, true);
				if (state.pendingPrompts.length > 0 && state.pendingPrompts[0]!.kind === 'chooseObjects') {
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: state.pendingPrompts[0]!.id,
						answer: { kind: 'chooseObjects', objectIds: [sacArt.instanceId] }
					});
				}
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p2.life, 38);
				assert.equal(p1.hand.length, 1);
			}
		});

		it('Plaguecrafter (canonical + synthetic clone): player with no creature or planeswalker discards a card', () => {
			for (const card of [realCard('Plaguecrafter'), cloneRenamed(realCard('Plaguecrafter'), 'Ash Broker')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2, p2Bot: true });
				const p2HandCard = putInZone(
					state,
					p2,
					synthCard({ name: 'P2 Secret', typeLine: 'Sorcery', manaCost: '{1}', cmc: 1 }),
					'hand'
				);
				const crafter = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 1, C: 2 });
				castSpell(state, p1, crafter);
				resolveAllStackAndOrderPrompts(state);
				assert.ok(p1.graveyard.some((c) => c.instanceId === crafter.instanceId));
				assert.ok(p2.graveyard.some((c) => c.instanceId === p2HandCard.instanceId));
			}
		});

		it('Combustible Gearhulk (canonical + synthetic clone): opponent declines draw -> mill 3 and deal total MV damage', () => {
			for (const card of [
				realCard('Combustible Gearhulk'),
				cloneRenamed(realCard('Combustible Gearhulk'), 'Pyre Automaton')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				p1.library = [];
				putInZone(state, p1, vanillaCreature('Cost4 A', 4, 4, 'R', 4), 'library');
				putInZone(state, p1, vanillaCreature('Cost3 B', 3, 3, 'R', 3), 'library');
				putInZone(state, p1, vanillaCreature('Cost2 C', 2, 2, 'R', 2), 'library');
				const hulk = putInZone(state, p1, card, 'hand');
				giveMana(p1, { R: 2, C: 4 });
				castSpell(state, p1, hulk);
				resolveAllStackAndOrderPrompts(state);
				let guard = 0;
				while (state.pendingPrompts.length > 0) {
					if (++guard > 50) assert.fail(`Combustible prompt loop stuck on ${state.pendingPrompts[0]?.kind}/${state.pendingPrompts[0]?.purpose}`);
					const prm = state.pendingPrompts[0]!;
					if (prm.purpose === 'trigger_targets') {
						const ansRes = applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseObjects', objectIds: [p2.playerId] }
						});
						assert.equal(ansRes.ok, true, ansRes.ok ? '' : (ansRes.error ?? ''));
					} else if (prm.kind === 'chooseMode') {
						// P2 declines having P1 draw 3 (choose mode index 1)
						const ansRes = applyGameAction(state, prm.playerId, {
							type: 'choice',
							promptId: prm.id,
							answer: { kind: 'chooseMode', indices: [1] }
						});
						assert.equal(ansRes.ok, true, ansRes.ok ? '' : (ansRes.error ?? ''));
					} else {
						assert.fail(`Unexpected prompt: ${prm.kind} / ${prm.purpose}`);
					}
					resolveAllStackAndOrderPrompts(state);
				}
				assert.equal(p1.graveyard.length, 3);
				assert.equal(p2.life, 40 - 9);
			}
		});

		it('Deliver Unto Evil (canonical + synthetic clone): opponent chooses 2 targets to leave in GY, rest go to hand', () => {
			for (const card of [realCard('Deliver Unto Evil'), cloneRenamed(realCard('Deliver Unto Evil'), 'Wicked Bargain')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1 } = setupGame({ playerCount: 2, p2Bot: true });
				const g1 = putInZone(state, p1, vanillaCreature('GY 1', 1, 1, 'B', 1), 'graveyard');
				const g2 = putInZone(state, p1, vanillaCreature('GY 2', 2, 2, 'B', 2), 'graveyard');
				const g3 = putInZone(state, p1, vanillaCreature('GY 3', 3, 3, 'B', 5), 'graveyard');
				const g4 = putInZone(state, p1, vanillaCreature('GY 4', 4, 4, 'B', 6), 'graveyard');
				const spell = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 1, C: 2 });
				castSpell(state, p1, spell, {
					targets: [
						{ kind: 'graveyard_card', id: g1.instanceId, label: g1.card.name },
						{ kind: 'graveyard_card', id: g2.instanceId, label: g2.card.name },
						{ kind: 'graveyard_card', id: g3.instanceId, label: g3.card.name },
						{ kind: 'graveyard_card', id: g4.instanceId, label: g4.card.name }
					]
				});
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p1.hand.length, 2);
				assert.ok(p1.hand.some((c) => c.instanceId === g1.instanceId));
				assert.ok(p1.hand.some((c) => c.instanceId === g2.instanceId));
				assert.ok(p1.graveyard.some((c) => c.instanceId === g3.instanceId));
				assert.ok(p1.graveyard.some((c) => c.instanceId === g4.instanceId));
			}
		});

		it('Tasigur, the Golden Fang (canonical + synthetic clone): opponent chooses nonland card from GY to return to hand', () => {
			for (const card of [
				realCard('Tasigur, the Golden Fang'),
				cloneRenamed(realCard('Tasigur, the Golden Fang'), 'Balthazar, Fang Regent')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1 } = setupGame({ playerCount: 2, p2Bot: true });
				const tas = putInZone(state, p1, card, 'battlefield');
				const low = putInZone(state, p1, vanillaCreature('Cheap Guy', 1, 1, 'G', 1), 'graveyard');
				const high = putInZone(state, p1, vanillaCreature('Big Guy', 6, 6, 'G', 7), 'graveyard');
				giveMana(p1, { U: 2, C: 2 });
				const ab = getEffectiveActivatedAbilities(state, p1, tas).find((a) => !a.isManaAbility);
				assert.ok(ab);
				const act = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: tas.instanceId,
					abilityId: ab.id
				});
				assert.equal(act.ok, true, act.ok ? '' : (act.error ?? ''));
				resolveAllStackAndOrderPrompts(state);
				assert.ok(p1.hand.some((c) => c.instanceId === low.instanceId));
				assert.ok(p1.graveyard.some((c) => c.instanceId === high.instanceId));
			}
		});
	});

	describe('3. Type-Partition Sacrifice, Greatest/Least Stat & Same-Name Sweepers', () => {
		it('Cataclysmic Gearhulk (canonical + synthetic clone): keeps at most 1 artifact, 1 creature, 1 enchantment, 1 PW per player plus lands', () => {
			for (const card of [
				realCard('Cataclysmic Gearhulk'),
				cloneRenamed(realCard('Cataclysmic Gearhulk'), 'Judge Automaton')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2, p2Bot: true });
				const c1 = putInZone(state, p1, vanillaCreature('Cr 1', 2, 2, 'W', 2), 'battlefield');
				const c2 = putInZone(state, p1, vanillaCreature('Cr 2', 3, 3, 'W', 3), 'battlefield');
				const land = putInZone(
					state,
					p1,
					synthCard({ name: 'Plains', typeLine: 'Basic Land — Plains', manaCost: '', cmc: 0 }),
					'battlefield'
				);
				putInZone(state, p2, vanillaCreature('Opp Cr 1', 2, 2, 'G', 2), 'battlefield');
				putInZone(state, p2, vanillaCreature('Opp Cr 2', 4, 4, 'G', 4), 'battlefield');
				const gear = putInZone(state, p1, card, 'hand');
				giveMana(p1, { W: 2, C: 3 });
				castSpell(state, p1, gear);
				resolveAllStackAndOrderPrompts(state);
				let guard = 0;
				while (state.pendingPrompts.length > 0) {
					if (++guard > 50) assert.fail(`Cataclysmic prompt loop stuck on ${state.pendingPrompts[0]?.kind}`);
					const prm = state.pendingPrompts[0]!;
					const cands = prm.candidateInstanceIds ?? [];
					const pickId = cands.includes(gear.instanceId) ? gear.instanceId : cands[0];
					const ansRes = applyGameAction(state, prm.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer: { kind: 'chooseObjects', objectIds: pickId ? [pickId] : [] }
					});
					assert.equal(ansRes.ok, true, ansRes.ok ? '' : (ansRes.error ?? ''));
					resolveAllStackAndOrderPrompts(state);
				}
				assert.ok(p1.battlefield.some((c) => c.instanceId === land.instanceId), 'Land must survive');
				assert.equal(p2.battlefield.filter((c) => c.card.typeLine.includes('Creature')).length, 1);
				assert.ok(p1.graveyard.some((c) => c.instanceId === c1.instanceId || c.instanceId === c2.instanceId));
			}
		});

		it('Papalymo Totolymo (canonical + synthetic clone): only opponents who lost life this turn sacrifice greatest-power creature', () => {
			for (const card of [
				realCard('Papalymo Totolymo'),
				cloneRenamed(realCard('Papalymo Totolymo'), 'Alisaie Leveilleur')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
				const pap = putInZone(state, p1, card, 'battlefield');
				const p2Small = putInZone(state, p2, vanillaCreature('P2 Small', 1, 1), 'battlefield');
				const p2Big = putInZone(state, p2, vanillaCreature('P2 Big', 5, 5), 'battlefield');
				const p3Big = putInZone(state, p3!, vanillaCreature('P3 Big', 6, 6), 'battlefield');
				const shock = putInZone(
					state,
					p1,
					synthCard({ name: 'Shock Probe', typeLine: 'Instant', manaCost: '{R}', cmc: 1, oracleText: '~ deals 2 damage to target player.' }),
					'hand'
				);
				giveMana(p1, { R: 1, C: 4 });
				castSpell(state, p1, shock, { targets: [{ kind: 'player', id: p2.playerId }] });
				resolveAllStackAndOrderPrompts(state);
				p3!.lostLifeThisTurn = false;
				const ab = getEffectiveActivatedAbilities(state, p1, pap).find((a) => a.requiresSacrificeSelf);
				assert.ok(ab);
				const act = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: pap.instanceId,
					abilityId: ab.id
				});
				assert.equal(act.ok, true, act.ok ? '' : (act.error ?? ''));
				resolveAllStackAndOrderPrompts(state);
				assert.ok(p2.graveyard.some((c) => c.instanceId === p2Big.instanceId));
				assert.ok(p2.battlefield.some((c) => c.instanceId === p2Small.instanceId));
				assert.ok(p3!.battlefield.some((c) => c.instanceId === p3Big.instanceId));
			}
		});

		it('Maelstrom Pulse (canonical + synthetic clone): destroys target and all other permanents with the same name', () => {
			for (const card of [realCard('Maelstrom Pulse'), cloneRenamed(realCard('Maelstrom Pulse'), 'Echoing Ruin')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				const goblinCard = vanillaCreature('Goblin Raider', 1, 1, 'R', 1);
				const g1 = putInZone(state, p1, goblinCard, 'battlefield');
				const g2 = putInZone(state, p2, goblinCard, 'battlefield');
				const g3 = putInZone(state, p2, vanillaCreature('Orc Brute', 3, 3, 'R', 2), 'battlefield');
				const pulse = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 1, G: 1, C: 1 });
				castSpell(state, p1, pulse, { targets: [{ kind: 'permanent', id: g1.instanceId, label: g1.card.name }] });
				resolveAllStackAndOrderPrompts(state);
				assert.ok(p1.graveyard.some((c) => c.instanceId === g1.instanceId));
				assert.ok(p2.graveyard.some((c) => c.instanceId === g2.instanceId));
				assert.ok(p2.battlefield.some((c) => c.instanceId === g3.instanceId));
			}
		});

		it('God-Eternal Bontu (canonical + synthetic clone): sacrifices any number of other permanents and draws that many cards', () => {
			for (const card of [
				realCard('God-Eternal Bontu'),
				cloneRenamed(realCard('God-Eternal Bontu'), 'Erebos, Crocodile Aspect')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1 } = setupGame({ playerCount: 2 });
				const pA = putInZone(state, p1, vanillaCreature('Fodder A', 1, 1), 'battlefield');
				const pB = putInZone(state, p1, vanillaCreature('Fodder B', 1, 1), 'battlefield');
				const bontu = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 2, C: 3 });
				castSpell(state, p1, bontu);
				resolveAllStackAndOrderPrompts(state);
				const prm = state.pendingPrompts[0]!;
				assert.ok(prm && prm.kind === 'chooseObjects');
				assert.equal(prm.choice?.kind === 'chooseObjects' ? prm.choice.min : prm.countRequired, 0);
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [pA.instanceId, pB.instanceId] }
				});
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p1.hand.length, 2);
				assert.ok(p1.graveyard.some((c) => c.instanceId === pA.instanceId));
				assert.ok(p1.graveyard.some((c) => c.instanceId === pB.instanceId));
				assert.ok(p1.battlefield.some((c) => c.instanceId === bontu.instanceId));
			}
		});

		it('Deadly Tempest (canonical + synthetic clone): destroys all creatures and deals per-player controlled loss', () => {
			for (const card of [realCard('Deadly Tempest'), cloneRenamed(realCard('Deadly Tempest'), 'Fatal Gale')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				putInZone(state, p1, vanillaCreature('P1 A', 2, 2), 'battlefield');
				putInZone(state, p2, vanillaCreature('P2 A', 2, 2), 'battlefield');
				putInZone(state, p2, vanillaCreature('P2 B', 2, 2), 'battlefield');
				putInZone(state, p2, vanillaCreature('P2 C', 2, 2), 'battlefield');
				const spell = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 2, C: 4 });
				castSpell(state, p1, spell);
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p1.life, 39);
				assert.equal(p2.life, 37);
			}
		});
	});

	describe('4. Combat Shields, Redirection, Directives, Fight Excess & Extra Combats', () => {
		it("Angel's Grace (canonical + synthetic clone): life total floor clamps damage at 1", () => {
			for (const card of [realCard("Angel's Grace"), cloneRenamed(realCard("Angel's Grace"), 'Seraphic Ward')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1 } = setupGame({ playerCount: 2 });
				p1.life = 5;
				const grace = putInZone(state, p1, card, 'hand');
				giveMana(p1, { W: 1 });
				castSpell(state, p1, grace);
				resolveAllStackAndOrderPrompts(state);
				const bolt = putInZone(
					state,
					p1,
					synthCard({ name: 'Big Burn', typeLine: 'Instant', manaCost: '{R}', cmc: 1, oracleText: '~ deals 10 damage to target player.' }),
					'hand'
				);
				giveMana(p1, { R: 1 });
				castSpell(state, p1, bolt, { targets: [{ kind: 'player', id: p1.playerId }] });
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p1.life, 1);
			}
		});

		it('Deflecting Palm (canonical + synthetic clone): prevents chosen source damage and deals it to source controller', () => {
			for (const card of [realCard('Deflecting Palm'), cloneRenamed(realCard('Deflecting Palm'), 'Mirrored Palm')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				const giant = putInZone(state, p2, vanillaCreature('Opp Giant', 7, 7, 'R', 5), 'battlefield');
				const palm = putInZone(state, p1, card, 'hand');
				giveMana(p1, { R: 1, W: 1 });
				castSpell(state, p1, palm);
				resolveAllStackAndOrderPrompts(state);
				if (state.pendingPrompts.length > 0) {
					applyGameAction(state, p1.playerId, {
						type: 'choice',
						promptId: state.pendingPrompts[0]!.id,
						answer: { kind: 'chooseObjects', objectIds: [giant.instanceId] }
					});
					resolveAllStackAndOrderPrompts(state);
				}
				state.activePlayerIndex = 1;
				state.priorityPlayerIndex = 1;
				passUntilPhase(state, 'declare_attackers', 1);
				applyGameAction(state, p2.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: giant.instanceId, defenderPlayerId: p1.playerId }]
				});
				passUntilPhase(state, 'main2', 1);
				assert.equal(p1.life, 40);
				assert.equal(p2.life, 33);
			}
		});

		it('Mandate of Peace (canonical + synthetic clone): ends combat phase immediately', () => {
			for (const card of [realCard('Mandate of Peace'), cloneRenamed(realCard('Mandate of Peace'), 'Truce Decree')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				const bear = putInZone(state, p1, vanillaCreature('Peace Bear', 4, 4), 'battlefield', { summoningSick: false });
				passUntilPhase(state, 'declare_attackers', 0);
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: bear.instanceId, defenderPlayerId: p2.playerId }]
				});
				const mandate = putInZone(state, p1, card, 'hand');
				giveMana(p1, { W: 1, C: 1 });
				castSpell(state, p1, mandate);
				resolveAllStackAndOrderPrompts(state);
				assert.equal(state.phase, 'main2');
				assert.equal(p2.life, 40);
			}
		});

		it('Kardur, Doomscourge (canonical + synthetic clone): opponents creatures must attack another player if able', () => {
			for (const card of [
				realCard('Kardur, Doomscourge'),
				cloneRenamed(realCard('Kardur, Doomscourge'), 'Grim Warlord')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
				const oppBear = putInZone(state, p2, vanillaCreature('Forced Bear', 2, 2), 'battlefield', { summoningSick: false });
				const kardur = putInZone(state, p1, card, 'hand');
				giveMana(p1, { B: 1, R: 1, C: 2 });
				castSpell(state, p1, kardur);
				resolveAllStackAndOrderPrompts(state);
				passUntilPhase(state, 'declare_attackers', 1);
				const badAtk = applyGameAction(state, p2.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: oppBear.instanceId, defenderPlayerId: p1.playerId }]
				});
				assert.equal(badAtk.ok, false);
				const goodAtk = applyGameAction(state, p2.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: oppBear.instanceId, defenderPlayerId: p3!.playerId }]
				});
				assert.equal(goodAtk.ok, true, goodAtk.ok ? '' : (goodAtk.error ?? ''));
			}
		});

		it('Misleading Signpost (canonical + synthetic clone): reselects attacking target to another opponent', () => {
			for (const card of [
				realCard('Misleading Signpost'),
				cloneRenamed(realCard('Misleading Signpost'), 'Crooked Milemarker')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2, p3 } = setupGame({ playerCount: 3 });
				state.activePlayerIndex = 1;
				state.priorityPlayerIndex = 1;
				const oppBeast = putInZone(state, p2, vanillaCreature('Charging Beast', 5, 5), 'battlefield', { summoningSick: false });
				passUntilPhase(state, 'declare_attackers', 1);
				applyGameAction(state, p2.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: oppBeast.instanceId, defenderPlayerId: p1.playerId }]
				});
				let pGuard = 0;
				while (state.priorityPlayerIndex !== 0) {
					if (++pGuard > 20) assert.fail(`Priority loop stuck at seat ${state.priorityPlayerIndex} in phase ${state.phase}`);
					const cur = state.players[state.priorityPlayerIndex]!;
					const pRes = applyGameAction(state, cur.playerId, { type: 'pass_priority' });
					assert.equal(pRes.ok, true, pRes.ok ? '' : (pRes.error ?? ''));
				}
				const sign = putInZone(state, p1, card, 'hand');
				giveMana(p1, { U: 1, C: 2 });
				castSpell(state, p1, sign);
				resolveAllStackAndOrderPrompts(state);
				let prmGuard = 0;
				while (state.pendingPrompts.length > 0) {
					if (++prmGuard > 20) assert.fail(`Signpost prompt loop stuck on ${state.pendingPrompts[0]?.kind}`);
					const prm = state.pendingPrompts[0]!;
					const answer: ChoiceAnswer =
						prm.kind === 'yesNo'
							? { kind: 'yesNo', yes: true }
							: prm.kind === 'chooseMode'
								? {
										kind: 'chooseMode',
										indices: [
											Math.max(
												0,
												(prm.choice?.kind === 'chooseMode' ? prm.choice.modes : []).findIndex((m) =>
													m.includes(p3!.username)
												)
											)
										]
									}
								: {
										kind: 'chooseObjects',
										objectIds: [prm.purpose === 'trigger_targets' ? oppBeast.instanceId : p3!.playerId]
									};
					const cRes = applyGameAction(state, prm.playerId, {
						type: 'choice',
						promptId: prm.id,
						answer
					});
					assert.equal(cRes.ok, true, cRes.ok ? '' : (cRes.error ?? ''));
					resolveAllStackAndOrderPrompts(state);
				}
				assert.equal(state.combat.attackers[0]?.defenderPlayerId, p3!.playerId);
			}
		});

		it('Ram Through & The Last Agni Kai (canonical + synthetic clones): trample excess to controller and fight excess to {R}', () => {
			for (const card of [realCard('Ram Through'), cloneRenamed(realCard('Ram Through'), 'Goring Charge')]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				const trampler = putInZone(
					state,
					p1,
					synthCard({ name: 'Trample Rhino', typeLine: 'Creature — Rhino', manaCost: '{3}{G}', cmc: 4, colors: ['G'], keywords: ['Trample'], oracleText: 'Trample', power: '6', toughness: '6' }),
					'battlefield'
				);
				const blocker = putInZone(state, p2, vanillaCreature('Small Bird', 1, 2), 'battlefield');
				const ram = putInZone(state, p1, card, 'hand');
				giveMana(p1, { G: 1, C: 1 });
				castSpell(state, p1, ram, {
					targets: [
						{ kind: 'permanent', id: trampler.instanceId, label: trampler.card.name },
						{ kind: 'permanent', id: blocker.instanceId, label: blocker.card.name }
					]
				});
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p2.life, 36);
			}

			for (const card of [
				realCard('The Last Agni Kai'),
				cloneRenamed(realCard('The Last Agni Kai'), 'Trial by Flame')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				const fighter = putInZone(state, p1, vanillaCreature('Firebender', 5, 5, 'R', 4), 'battlefield');
				const opp = putInZone(state, p2, vanillaCreature('Foe', 2, 2, 'G', 2), 'battlefield');
				const kai = putInZone(state, p1, card, 'hand');
				giveMana(p1, { R: 1, C: 1 });
				castSpell(state, p1, kai, {
					targets: [
						{ kind: 'permanent', id: fighter.instanceId, label: fighter.card.name },
						{ kind: 'permanent', id: opp.instanceId, label: opp.card.name }
					]
				});
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p1.manaPool.R ?? 0, 3);
			}
		});

		it('Tifa, Martial Artist (canonical + synthetic clone): extra combat phase on first combat', () => {
			for (const card of [
				realCard('Tifa, Martial Artist'),
				cloneRenamed(realCard('Tifa, Martial Artist'), 'Sabin, Blitz Monk')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2, p2Bot: true });
				const tifa = putInZone(state, p1, card, 'battlefield', { summoningSick: false });
				const striker = putInZone(state, p1, vanillaCreature('Big Striker', 7, 7), 'battlefield', { summoningSick: false });
				passUntilPhase(state, 'declare_attackers', 0);
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [
						{ attackerInstanceId: tifa.instanceId, defenderPlayerId: p2.playerId },
						{ attackerInstanceId: striker.instanceId, defenderPlayerId: p2.playerId }
					]
				});
				passUntilPhase(state, 'begin_combat', 0);
				assert.equal(state.combatPhasesCountThisTurn, 2);
			}
		});

		it('Syr Konrad, the Grim & Gollum, Obsessed Stalker (canonical + synthetic clones): GY leave triggers + game combat history drain', () => {
			for (const card of [
				realCard('Syr Konrad, the Grim'),
				cloneRenamed(realCard('Syr Konrad, the Grim'), 'Sir Mordred, Bleak Knight')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				putInZone(state, p1, card, 'battlefield');
				const gyCr = putInZone(state, p1, vanillaCreature('Dead Knight', 2, 2, 'B', 2), 'graveyard');
				const bounceGy = putInZone(
					state,
					p1,
					synthCard({
						name: 'Gravedigger Clone',
						typeLine: 'Sorcery',
						manaCost: '{B}',
						cmc: 1,
						colors: ['B'],
						oracleText: 'Return target creature card from your graveyard to your hand.'
					}),
					'hand'
				);
				giveMana(p1, { B: 1 });
				castSpell(state, p1, bounceGy, { targets: [{ kind: 'graveyard_card', id: gyCr.instanceId, label: gyCr.card.name }] });
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p2.life, 39);
			}

			for (const card of [
				realCard('Gollum, Obsessed Stalker'),
				cloneRenamed(realCard('Gollum, Obsessed Stalker'), 'Sméagol, Ring Stalker')
			]) {
				assert.equal(compileCard(card).fullySupported, true);
				const { state, p1, p2 } = setupGame({ playerCount: 2 });
				const gollum = putInZone(state, p1, card, 'battlefield', { summoningSick: false });
				passUntilPhase(state, 'declare_attackers', 0);
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: gollum.instanceId, defenderPlayerId: p2.playerId }]
				});
				passUntilPhase(state, 'main2', 0);
				assert.equal(p2.life, 39);
				const heal = putInZone(
					state,
					p1,
					synthCard({ name: 'Healing Balm', typeLine: 'Instant', manaCost: '{W}', cmc: 1, oracleText: 'You gain 4 life.' }),
					'hand'
				);
				giveMana(p1, { W: 1 });
				castSpell(state, p1, heal);
				resolveAllStackAndOrderPrompts(state);
				passUntilPhase(state, 'end_step', 0);
				resolveAllStackAndOrderPrompts(state);
				assert.equal(p2.life, 35);
			}
		});
	});
});
