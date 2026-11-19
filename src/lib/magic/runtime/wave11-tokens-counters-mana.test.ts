import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard, describeModalModes } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { opponentLandColors } from './effects.ts';
import { permanentCouldProduceManaTypes } from './effectsWave7.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { evaluateCondition } from './objectFilter.ts';
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

let w11Seq = 0;

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
	const renameText = (srcName: string, txt: string) => {
		let out = txt.split(srcName).join(newName);
		for (const short of [srcName.split(',')[0].trim(), srcName.split(/\s+of\s+/i)[0].trim()]) {
			if (short && short !== srcName && short.length >= 3) {
				out = out.replace(
					new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
					newShort
				);
			}
		}
		return out;
	};
	let nextText = base.oracleText.split(base.name).join(newName);
	for (const short of [shortComma, shortOf]) {
		if (short && short !== base.name && short.length >= 3) {
			nextText = nextText.replace(
				new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
				newShort
			);
		}
	}
	w11Seq += 1;
	return {
		...base,
		id: `syn_w11_clone_${w11Seq}`,
		oracleId: `ora_w11_clone_${w11Seq}`,
		name: newName,
		oracleText: nextText,
		...(base.faces
			? {
					faces: base.faces.map((f, idx) => ({
						...f,
						name: idx === 0 ? newName : `${newName} Aspect ${idx}`,
						oracleText: renameText(f.name, f.oracleText)
					}))
				}
			: {})
	};
}

function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	w11Seq += 1;
	const id = overrides.id ?? `syn_w11_${w11Seq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_w11_${w11Seq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? overrides.colors ?? [],
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
		layout: overrides.layout ?? 'normal',
		...(overrides.faces ? { faces: overrides.faces } : {})
	};
}

function makeDeck(cards: ScryfallCard[]): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_w11_${++w11Seq}`,
		userId: 'p1',
		name: 'Wave 11 Deck',
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

function setupGame(opts: { p1Bot?: boolean; p2Bot?: boolean } = {}) {
	const filler = synthCard({
		name: 'Basic Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	for (let i = 0; i < 2; i++) {
		const d = makeDeck(Array.from({ length: 30 }, () => filler));
		decks.set(i, d);
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `Player${i + 1}`,
			avatarUrl: '',
			isBot: i === 0 ? Boolean(opts.p1Bot) : Boolean(opts.p2Bot),
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
	const state = createInitialGameState('W11', seats, decks, DEFAULT_LOBBY_RULES);
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
	return { state, p1: state.players[0]!, p2: state.players[1]! };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library' | 'command',
	opts: { summoningSick?: boolean; counters?: Record<string, number>; tapped?: boolean; isCommander?: boolean; isToken?: boolean } = {}
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(
		card,
		player.playerId,
		zone,
		Boolean(opts.isCommander),
		Boolean(opts.isToken),
		state.nextTimestamp
	);
	if (zone === 'battlefield') {
		inst.summoningSick = opts.summoningSick ?? false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
		if (opts.tapped) inst.tapped = true;
	}
	if (opts.counters) inst.counters = { ...inst.counters, ...opts.counters };
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	if (opts.isCommander) {
		player.commanderNames[inst.instanceId] = card.name;
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

function answerTopPrompt(state: GameState, answer: ChoiceAnswer): void {
	const prm = state.pendingPrompts[0];
	assert.ok(prm, 'Expected a pending prompt');
	const res = applyGameAction(state, prm.playerId, {
		type: 'choice',
		promptId: prm.id,
		answer
	});
	assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
}

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 250; guard++) {
		if (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0]!;
			if (prm.purpose === 'trigger_order') {
				answerTopPrompt(state, { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] });
				continue;
			}
			return;
		}
		if (state.stack.length === 0) return;
		const actor = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
	assert.fail(`resolveAllStack exceeded 250 iterations (stack=${state.stack.length})`);
}

function passUntilPhase(state: GameState, targetPhase: GameState['phase'], targetActiveIndex?: number): void {
	for (let guard = 0; guard < 600; guard++) {
		if (
			state.phase === targetPhase &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0 &&
			(targetActiveIndex === undefined || state.activePlayerIndex === targetActiveIndex)
		) {
			return;
		}
		if (state.pendingPrompts.length > 0) {
			resolveAllStack(state);
			if (state.pendingPrompts.length > 0) return;
			continue;
		}
		const actor = state.players[state.priorityPlayerIndex]!;
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
	}
	assert.fail(`passUntilPhase exceeded 600 steps (phase=${state.phase}, active=${state.activePlayerIndex})`);
}

function castSpell(
	state: GameState,
	caster: PlayerGameState,
	inst: CardInstance,
	opts: { targets?: Array<{ kind: TargetRef['kind']; id: string; label?: string }>; xValue?: number } = {}
) {
	return applyGameAction(state, caster.playerId, {
		type: 'cast_spell',
		instanceId: inst.instanceId,
		...(opts.targets
			? { targets: opts.targets.map((t) => ({ kind: t.kind, id: t.id, label: t.label ?? t.id })) }
			: {}),
		...(opts.xValue !== undefined ? { xValue: opts.xValue } : {})
	});
}

describe('Wave 11: Tokens, Counters, Dynamic Mana, Type Shifts, Restrictions & Case Solve', () => {
	it('Case of the Crimson Pulse solves when hand is empty at end step and activates solved upkeep draw (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const base = realCard('Case of the Crimson Pulse');
			const caseCard = useClone ? cloneRenamed(base, 'Case of the Ember Pulse') : base;
			const def = compileCard(caseCard);
			assert.equal(def.fullySupported, true);

			const fillerHand = synthCard({ name: 'Filler Card', manaCost: '{1}', cmc: 1, typeLine: 'Sorcery' });
			const inHand = putInZone(state, p1, fillerHand, 'hand');
			const casePerm = putInZone(state, p1, caseCard, 'battlefield');

			// Pass to p1's end_step with 1 card still in hand -> Case remains unsolved
			passUntilPhase(state, 'end_step', 0);
			assert.equal(Boolean(casePerm.isSolved), false);

			// Pass to p1's next main1 so draw step already happened, then clear hand before p1's end_step
			passUntilPhase(state, 'main1', 0);
			p1.hand = [];
			p1.graveyard.push(inHand);
			inHand.zone = 'graveyard';

			passUntilPhase(state, 'end_step', 0);
			assert.equal(casePerm.isSolved, true, 'Case must be solved when hand is empty at end step');

			// Advance to next p1 upkeep / draw: solved upkeep trigger should fire
			const handBeforeNextMain = p1.hand.length;
			passUntilPhase(state, 'main1', 0);
			assert.ok(
				p1.hand.length >= handBeforeNextMain + 2,
				`Expected solved Case upkeep trigger + draw step to add >=2 cards (got ${p1.hand.length})`
			);
		}
	});

	it('Second Harvest doubles controlled tokens and Saw in Half halves P/T from LKI (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const { state, p1 } = setupGame();
			const harvestBase = realCard('Second Harvest');
			const harvestCard = useClone ? cloneRenamed(harvestBase, 'Bountiful Clone') : harvestBase;
			const sawBase = realCard('Saw in Half');
			const sawCard = useClone ? cloneRenamed(sawBase, 'Bisecting Blade') : sawBase;

			const goblinTok = putInZone(
				state,
				p1,
				synthCard({ name: 'Goblin Token', manaCost: '', typeLine: 'Token Creature — Goblin', power: '1', toughness: '1' }),
				'battlefield',
				{ isToken: true }
			);
			assert.ok(goblinTok);
			giveMana(p1, { G: 2, C: 2 });
			const harvestInst = putInZone(state, p1, harvestCard, 'hand');
			const castH = castSpell(state, p1, harvestInst);
			assert.equal(castH.ok, true, castH.ok ? '' : (castH.error ?? ''));
			resolveAllStack(state);
			assert.equal(
				p1.battlefield.filter((p) => p.card.name === 'Goblin Token').length,
				2,
				'Second Harvest should double tokens'
			);

			// Saw in Half on a 4/5 creature with a +1/+1 counter (LKI 5/6 -> ceil(5/2)=3, ceil(6/2)=3)
			const giant = putInZone(
				state,
				p1,
				synthCard({ name: 'Hill Behemoth', manaCost: '{3}{B}', typeLine: 'Creature — Giant', power: '4', toughness: '5' }),
				'battlefield',
				{ counters: { '+1/+1': 1 } }
			);
			giveMana(p1, { B: 1, C: 2 });
			const sawInst = putInZone(state, p1, sawCard, 'hand');
			const castS = castSpell(state, p1, sawInst, {
				targets: [{ kind: 'permanent', id: giant.instanceId }]
			});
			assert.equal(castS.ok, true, castS.ok ? '' : (castS.error ?? ''));
			resolveAllStack(state);

			assert.equal(giant.zone, 'graveyard');
			const copies = p1.battlefield.filter((p) => p.isToken && p.card.name === 'Hill Behemoth');
			assert.equal(copies.length, 2, 'Saw in Half must create two token copies');
			for (const cp of copies) {
				const ev = evaluatePermanent(state, cp);
				assert.equal(ev.power, 3);
				assert.equal(ev.toughness, 3);
			}
		}
	});

	it('Raging Ravine retains Land types (stillALand) and gains attack +1/+1 counters; Weeping Angel removes Creature type', () => {
		const { state, p1, p2 } = setupGame();
		const ravine = putInZone(state, p1, realCard('Raging Ravine'), 'battlefield');
		giveMana(p1, { R: 1, G: 1, C: 2 });
		const animAb = getEffectiveActivatedAbilities(state, p1, ravine).find((a) => !a.isManaAbility);
		assert.ok(animAb);
		const actRes = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: ravine.instanceId,
			abilityId: animAb.id
		});
		assert.equal(actRes.ok, true, actRes.ok ? '' : (actRes.error ?? ''));
		resolveAllStack(state);

		const ev = evaluatePermanent(state, ravine);
		assert.equal(ev.isCreature, true);
		assert.equal(ev.isLand, true, 'Raging Ravine must remain a Land');
		assert.equal(ev.power, 3);
		assert.equal(ev.toughness, 3);

		// Attack with animated Raging Ravine -> triggers "put a +1/+1 counter on ~"
		passUntilPhase(state, 'declare_attackers', 0);
		const atk = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: ravine.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atk.ok, true, atk.ok ? '' : (atk.error ?? ''));
		resolveAllStack(state);
		assert.equal(ravine.counters['+1/+1'], 1);

		// Weeping Angel: cast by p2 triggers p1's Weeping Angel to remove Creature type until end of turn
		passUntilPhase(state, 'main2', 0);
		const angel = putInZone(state, p1, realCard('Weeping Angel'), 'battlefield');
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'main1';
		giveMana(p2, { G: 1 });
		const bear = putInZone(
			state,
			p2,
			synthCard({ name: 'Elf Scout', manaCost: '{G}', cmc: 1, typeLine: 'Creature — Elf', power: '1', toughness: '1' }),
			'hand'
		);
		const castBear = castSpell(state, p2, bear);
		assert.equal(castBear.ok, true, castBear.ok ? '' : (castBear.error ?? ''));
		resolveAllStack(state);
		assert.equal(evaluatePermanent(state, angel).isCreature, false, 'Weeping Angel stops being a creature');
	});

	it('Cavern of Souls makes matching creature spells uncounterable and Jegantha mana disallows generic costs', () => {
		const { state, p1, p2 } = setupGame();
		const cavernCard = cloneRenamed(realCard('Cavern of Souls'), 'Grotto of Echoes');
		const cavern = putInZone(state, p1, cavernCard, 'battlefield');
		cavern.chosenSubType = 'Elf';

		const elfSpell = putInZone(
			state,
			p1,
			synthCard({ name: 'Llanowar Apprentice', manaCost: '{G}', cmc: 1, typeLine: 'Creature — Elf', power: '1', toughness: '1' }),
			'hand'
		);
		const cavernAbs = getEffectiveActivatedAbilities(state, p1, cavern);
		const coloredTap = cavernAbs.find((a) => a.id === 'act_2');
		assert.ok(coloredTap);
		const tapCav = applyGameAction(state, p1.playerId, {
			type: 'tap_mana',
			instanceId: cavern.instanceId,
			abilityId: coloredTap.id,
			preferredColor: 'G'
		});
		assert.equal(tapCav.ok, true, tapCav.ok ? '' : (tapCav.error ?? ''));

		const castElf = castSpell(state, p1, elfSpell);
		assert.equal(castElf.ok, true, castElf.ok ? '' : (castElf.error ?? ''));
		assert.equal(state.stack[0]?.cantBeCounteredByMana, true);

		// p2 tries to Counterspell the Cavern-cast Elf -> fails to counter, Elf resolves onto battlefield!
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		const counterspell = putInZone(state, p2, realCard('Counterspell'), 'hand');
		giveMana(p2, { U: 2 });
		const castCnt = castSpell(state, p2, counterspell, {
			targets: [{ kind: 'stack', id: state.stack[0]!.id }]
		});
		assert.equal(castCnt.ok, true, castCnt.ok ? '' : (castCnt.error ?? ''));
		resolveAllStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.card.name === 'Llanowar Apprentice'),
			true,
			'Elf cast with Cavern of Souls mana cannot be countered'
		);

		// Jegantha, the Wellspring: adds WUBRG that can't pay generic costs
		const jeg = putInZone(state, p1, realCard('Jegantha, the Wellspring'), 'battlefield');
		const jegAbs = getEffectiveActivatedAbilities(state, p1, jeg).find((a) => a.isManaAbility);
		assert.ok(jegAbs);
		const tapJ = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: jeg.instanceId,
			abilityId: jegAbs.id
		});
		assert.equal(tapJ.ok, true, tapJ.ok ? '' : (tapJ.error ?? ''));

		const genericArt = putInZone(
			state,
			p1,
			synthCard({ name: 'Iron Relic', manaCost: '{2}', cmc: 2, typeLine: 'Artifact' }),
			'hand'
		);
		const badCast = castSpell(state, p1, genericArt);
		assert.equal(badCast.ok, false, 'Jegantha mana cannot pay generic {2} cost');

		const coloredSpell = putInZone(
			state,
			p1,
			synthCard({ name: 'Prismatic Charm', manaCost: '{W}{G}', cmc: 2, typeLine: 'Instant' }),
			'hand'
		);
		const goodCast = castSpell(state, p1, coloredSpell);
		assert.equal(goodCast.ok, true, 'Jegantha mana CAN pay colored {W}{G} cost');
	});

	it('Faeburrow Elder, Nykthos, Opal Palace commander bonus, and Mana Drain delayed main-phase mana work', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(
			state,
			p1,
			synthCard({ name: 'Watchwolf', manaCost: '{G}{W}', cmc: 2, typeLine: 'Creature — Wolf', colors: ['G', 'W'], power: '3', toughness: '3' }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			synthCard({ name: 'Tidal Sprite', manaCost: '{U}', cmc: 1, typeLine: 'Creature — Faerie', colors: ['U'], power: '1', toughness: '1' }),
			'battlefield'
		);
		const elder = putInZone(state, p1, realCard('Faeburrow Elder'), 'battlefield');
		const elderMana = getEffectiveActivatedAbilities(state, p1, elder).find((a) => a.isManaAbility)!;
		const resE = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: elder.instanceId,
			abilityId: elderMana.id
		});
		assert.equal(resE.ok, true, resE.ok ? '' : (resE.error ?? ''));
		assert.ok((p1.manaPool.G ?? 0) >= 1 && (p1.manaPool.W ?? 0) >= 1 && (p1.manaPool.U ?? 0) >= 1);

		// Nykthos, Shrine to Nyx devotion mana
		const nyk = putInZone(state, p1, realCard('Nykthos, Shrine to Nyx'), 'battlefield');
		giveMana(p1, { C: 2 });
		const nykAb = getEffectiveActivatedAbilities(state, p1, nyk).find((a) => a.id === 'act_1')!;
		const resN = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: nyk.instanceId,
			abilityId: nykAb.id
		});
		assert.equal(resN.ok, true, resN.ok ? '' : (resN.error ?? ''));
		resolveAllStack(state);
		if (state.pendingPrompts.length > 0) {
			answerTopPrompt(state, { kind: 'chooseMode', indices: [4] });
			resolveAllStack(state);
		}
		assert.ok((p1.manaPool.G ?? 0) >= 2, 'Nykthos adds Green equal to Green devotion');

		// Opal Palace casting commander puts bonus +1/+1 counter on commander
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		const opal = putInZone(state, p1, realCard('Opal Palace'), 'battlefield');
		const opalColored = getEffectiveActivatedAbilities(state, p1, opal).find((a) => a.id === 'act_1')!;
		giveMana(p1, { C: 2 });
		const cmd = putInZone(
			state,
			p1,
			synthCard({ name: 'Commander Lion', manaCost: '{1}{W}', cmc: 2, typeLine: 'Legendary Creature — Cat', colors: ['W'], power: '2', toughness: '2' }),
			'command',
			{ isCommander: true }
		);
		const resO = applyGameAction(state, p1.playerId, {
			type: 'tap_mana',
			instanceId: opal.instanceId,
			abilityId: opalColored.id,
			preferredColor: 'W'
		});
		assert.equal(resO.ok, true, resO.ok ? '' : (resO.error ?? ''));
		const castCmd = castSpell(state, p1, cmd);
		assert.equal(castCmd.ok, true, castCmd.ok ? '' : (castCmd.error ?? ''));
		resolveAllStack(state);
		const bfCmd = p1.battlefield.find((c) => c.card.name === 'Commander Lion');
		assert.ok(bfCmd, 'Commander Lion should resolve onto battlefield');
		assert.equal(bfCmd.counters['+1/+1'], 1, 'Commander cast with Opal Palace mana enters with +1/+1 counter');

		// Mana Drain counters opponent's 4-MV spell and adds 4 {C} at beginning of p1's next main1
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'main1';
		giveMana(p2, { C: 4 });
		const fourDrop = putInZone(
			state,
			p2,
			synthCard({ name: 'Heavy Golem', manaCost: '{4}', cmc: 4, typeLine: 'Artifact Creature — Golem', power: '4', toughness: '4' }),
			'hand'
		);
		const castFour = castSpell(state, p2, fourDrop);
		assert.equal(castFour.ok, true, castFour.ok ? '' : (castFour.error ?? ''));
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		giveMana(p1, { U: 2 });
		const md = putInZone(state, p1, realCard('Mana Drain'), 'hand');
		const mdRes = castSpell(state, p1, md, { targets: [{ kind: 'stack', id: state.stack[0]!.id }] });
		assert.equal(mdRes.ok, true, mdRes.ok ? '' : (mdRes.error ?? ''));
		resolveAllStack(state);
		assert.equal(p1.pendingNextMainPhaseMana?.C, 4);

		passUntilPhase(state, 'main1', 0);
		assert.ok((p1.manaPool.C ?? 0) >= 4, 'Mana Drain adds 4 {C} at start of controller next main phase');
	});

	it('Goldberry & Nesting Grounds move counters; Exponential Growth doubles power X times; Mutated Cultist removes poison', () => {
		const { state, p1, p2 } = setupGame();
		const goldberry = putInZone(state, p1, cloneRenamed(realCard('Goldberry, River-Daughter'), 'River Spirit'), 'battlefield');
		const carrier = putInZone(
			state,
			p1,
			synthCard({ name: 'Counter Bear', manaCost: '{1}{G}', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield',
			{ counters: { '+1/+1': 2, shield: 1 } }
		);
		const goldAbs = getEffectiveActivatedAbilities(state, p1, goldberry);
		const moveOntoSelf = goldAbs.find((a) => a.id === 'act_0')!;
		const resG0 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: goldberry.instanceId,
			abilityId: moveOntoSelf.id,
			targets: [{ kind: 'permanent', id: carrier.instanceId, label: carrier.card.name }]
		});
		assert.equal(resG0.ok, true, resG0.ok ? '' : (resG0.error ?? ''));
		resolveAllStack(state);
		assert.equal(goldberry.counters['+1/+1'], 1, 'Goldberry moved one +1/+1 counter onto itself');
		assert.equal(goldberry.counters.shield, 1, 'Goldberry moved one shield counter onto itself');

		// Nesting Grounds moves a counter onto carrier
		const nest = putInZone(state, p1, realCard('Nesting Grounds'), 'battlefield');
		const nestAb = getEffectiveActivatedAbilities(state, p1, nest).find((a) => a.id === 'act_1')!;
		giveMana(p1, { C: 1 });
		const resNest = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: nest.instanceId,
			abilityId: nestAb.id,
			targets: [
				{ kind: 'permanent', id: goldberry.instanceId, label: goldberry.card.name },
				{ kind: 'permanent', id: carrier.instanceId, label: carrier.card.name }
			]
		});
		assert.equal(resNest.ok, true, resNest.ok ? '' : (resNest.error ?? ''));
		resolveAllStack(state);

		// Exponential Growth with X = 2 on a 3-power creature -> 3 * 2^2 = 12 power
		const tiger = putInZone(
			state,
			p1,
			synthCard({ name: 'Wild Tiger', manaCost: '{2}{G}', typeLine: 'Creature — Cat', power: '3', toughness: '3' }),
			'battlefield'
		);
		giveMana(p1, { G: 2, C: 4 });
		const growth = putInZone(state, p1, realCard('Exponential Growth'), 'hand');
		const resExp = castSpell(state, p1, growth, {
			xValue: 2,
			targets: [{ kind: 'permanent', id: tiger.instanceId }]
		});
		assert.equal(resExp.ok, true, resExp.ok ? '' : (resExp.error ?? ''));
		resolveAllStack(state);
		assert.equal(evaluatePermanent(state, tiger).power, 12, 'Exponential Growth doubled 3 power twice to 12');

		// Mutated Cultist cast trigger removes poison counters from opponent
		p2.poison = 4;
		giveMana(p1, { B: 1, C: 2 });
		const cultist = putInZone(state, p1, realCard('Mutated Cultist'), 'hand');
		const resCult = castSpell(state, p1, cultist);
		assert.equal(resCult.ok, true, resCult.ok ? '' : (resCult.error ?? ''));
		if (state.pendingPrompts.length > 0) {
			answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [p2.playerId] });
		}
		resolveAllStack(state);
		assert.equal(p2.poison, 0, 'Mutated Cultist removed all poison counters from opponent');
	});

	it('Palace Jailer returns exiled creature on monarch change; Gather Specimens steals entering creature; Zack Fair & Reins of Power', () => {
		const { state, p1, p2 } = setupGame();
		const oppBear = putInZone(
			state,
			p2,
			synthCard({ name: 'Grizzly Cub', manaCost: '{1}{G}', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const jailer = putInZone(state, p1, realCard('Palace Jailer'), 'hand');
		giveMana(p1, { W: 2, C: 2 });
		const cJ1 = castSpell(state, p1, jailer);
		assert.equal(cJ1.ok, true, cJ1.ok ? '' : (cJ1.error ?? ''));
		resolveAllStack(state);
		assert.equal(state.monarchPlayerId, p1.playerId);
		assert.equal(oppBear.zone, 'exile');
		assert.ok(oppBear.exiledUntilOpponentMonarch, 'oppBear tracked until opponent becomes monarch');

		// Opponent becomes monarch via another Palace Jailer -> exiled creature returns immediately
		const oppJailer = putInZone(state, p2, realCard('Palace Jailer'), 'hand');
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'main1';
		giveMana(p2, { W: 2, C: 2 });
		const cJ2 = castSpell(state, p2, oppJailer);
		assert.equal(cJ2.ok, true, cJ2.ok ? '' : (cJ2.error ?? ''));
		resolveAllStack(state);
		assert.equal(state.monarchPlayerId, p2.playerId);
		assert.equal(oppBear.zone, 'battlefield', 'Exiled creature returned when opponent became monarch');

		// Gather Specimens steals opponent's entering creature
		passUntilPhase(state, 'main1', 0);
		giveMana(p1, { U: 3, C: 3 });
		const gather = putInZone(state, p1, realCard('Gather Specimens'), 'hand');
		const cGather = castSpell(state, p1, gather);
		assert.equal(cGather.ok, true, cGather.ok ? '' : (cGather.error ?? ''));
		resolveAllStack(state);
		assert.equal(state.stealOpponentEnteringCreaturesPlayerIdThisTurn, p1.playerId);

		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		const stolenElf = putInZone(
			state,
			p2,
			synthCard({
				name: 'Flash Sprite',
				manaCost: '{G}',
				typeLine: 'Creature — Elf',
				oracleText: 'Flash',
				keywords: ['Flash'],
				power: '1',
				toughness: '1'
			}),
			'hand'
		);
		giveMana(p2, { G: 1 });
		const cStolen = castSpell(state, p2, stolenElf);
		assert.equal(cStolen.ok, true, cStolen.ok ? '' : (cStolen.error ?? ''));
		resolveAllStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.card.name === 'Flash Sprite'),
			true,
			'Gather Specimens stole opponent entering creature'
		);

		// Zack Fair transfers attached Equipment when sacrificed; Reins of Power swaps creatures
		const buddy = putInZone(
			state,
			p1,
			synthCard({ name: 'Partner Soldier', manaCost: '{1}{W}', typeLine: 'Creature — Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);
		const zack = putInZone(state, p1, realCard('Zack Fair'), 'battlefield');
		const sword = putInZone(
			state,
			p1,
			synthCard({ name: 'Buster Blade', manaCost: '{1}', typeLine: 'Artifact — Equipment', oracleText: 'Equip {1}' }),
			'battlefield'
		);
		sword.attachedToId = zack.instanceId;
		noteLayerInputsChanged(state);

		const zackSacAb = getEffectiveActivatedAbilities(state, p1, zack).find((a) => !a.isManaAbility)!;
		giveMana(p1, { C: 1 });
		const resZack = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: zack.instanceId,
			abilityId: zackSacAb.id,
			targets: [{ kind: 'permanent', id: buddy.instanceId, label: buddy.card.name }]
		});
		assert.equal(resZack.ok, true, resZack.ok ? '' : (resZack.error ?? ''));
		resolveAllStack(state);
		assert.equal(sword.attachedToId, buddy.instanceId, 'Zack Fair attached Equipment via LKI on sacrifice');

		// Reins of Power control swap
		const p1BeforeCount = p1.battlefield.filter((p) => evaluatePermanent(state, p).isCreature).length;
		const p2BeforeCount = p2.battlefield.filter((p) => evaluatePermanent(state, p).isCreature).length;
		assert.ok(p1BeforeCount > 0 && p2BeforeCount > 0);
		giveMana(p1, { U: 2, C: 2 });
		const reins = putInZone(state, p1, realCard('Reins of Power'), 'hand');
		const resReins = castSpell(state, p1, reins, {
			targets: [{ kind: 'player', id: p2.playerId }]
		});
		assert.equal(resReins.ok, true, resReins.ok ? '' : (resReins.error ?? ''));
		resolveAllStack(state);
		const p1AfterCount = p1.battlefield.filter((p) => evaluatePermanent(state, p).isCreature).length;
		assert.equal(p1AfterCount, p2BeforeCount, 'Reins of Power exchanged control of all creatures');
	});

	it('Rod of Absorption exiles resolving instant/sorcery spells and Twins of Discord blocks parity blocking', () => {
		const { state, p1, p2 } = setupGame();
		putInZone(state, p1, realCard('Rod of Absorption'), 'battlefield');
		const bolt = putInZone(
			state,
			p1,
			synthCard({
				name: 'Quick Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Quick Bolt deals 1 damage to target opponent.'
			}),
			'hand'
		);
		giveMana(p1, { R: 1 });
		const cBolt = castSpell(state, p1, bolt, { targets: [{ kind: 'player', id: p2.playerId }] });
		assert.equal(cBolt.ok, true, cBolt.ok ? '' : (cBolt.error ?? ''));
		resolveAllStack(state);
		assert.equal(
			p1.exile.some((c) => c.instanceId === bolt.instanceId),
			true,
			'Rod of Absorption must exile resolving Instant instead of graveyard'
		);

		// Twins of Discord parity block lock on declare_attackers
		const twins = putInZone(state, p1, realCard('Twins of Discord'), 'battlefield');
		const oddBlocker = putInZone(
			state,
			p2,
			synthCard({ name: 'Odd Guard', manaCost: '{3}', cmc: 3, typeLine: 'Creature — Construct', power: '3', toughness: '3' }),
			'battlefield'
		);
		passUntilPhase(state, 'declare_attackers', 0);
		const atkT = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: twins.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atkT.ok, true, atkT.ok ? '' : (atkT.error ?? ''));
		resolveAllStack(state);
		assert.equal(state.cantBlockManaValueParityThisTurn, 'odd');
		passUntilPhase(state, 'declare_blockers', 0);
		const illegalBlk = applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: [{ blockerInstanceId: oddBlocker.instanceId, attackerInstanceId: twins.instanceId }]
		});
		assert.equal(illegalBlk.ok, false, 'Odd mana value creature cannot block after Twins of Discord lock');
	});

	it("repeatSequence: Hoarder's Greed executes do-while, pauses/resumes across JSON roundtrip, and repeats on clash win (+ cloneRenamed)", () => {
		for (const useClone of [false, true]) {
			const base = realCard("Hoarder's Greed");
			const card = useClone ? cloneRenamed(base, 'Avaricious Ledger') : base;

			// 1. Multi-iteration repeat: iter 0 draws [MV 2, MV 1] and clashes MV 6 > MV 4 (wins), iter 1 draws [MV 3, MV 2] and clashes MV 1 < MV 4 (loses)
			let { state, p1, p2 } = setupGame();
			const makeLibCard = (name: string, cmc: number) =>
				synthCard({ name, manaCost: cmc > 0 ? `{${cmc}}` : '', cmc, typeLine: 'Artifact', oracleText: '' });
			p1.library = [
				makeLibCard('Draw1A', 2),
				makeLibCard('Draw1B', 1),
				makeLibCard('ClashWin6', 6),
				makeLibCard('Draw2A', 3),
				makeLibCard('Draw2B', 2),
				makeLibCard('ClashLose1', 1)
			].map((c) => createCardInstance(c, p1.playerId, 'library', false, false, ++state.nextTimestamp!));
			p2.library = [makeLibCard('Opp4A', 4), makeLibCard('Opp4B', 4)].map((c) =>
				createCardInstance(c, p2.playerId, 'library', false, false, ++state.nextTimestamp!)
			);

			const greed = putInZone(state, p1, card, 'hand');
			giveMana(p1, { B: 1, C: 3 });
			const cRes = castSpell(state, p1, greed);
			assert.equal(cRes.ok, true, cRes.ok ? '' : (cRes.error ?? ''));

			let promptsSeen = 0;
			for (let g = 0; g < 30; g++) {
				resolveAllStack(state);
				if (state.pendingPrompts.length === 0) break;
				promptsSeen += 1;
				// Verify JSON round-trip mid-repeatSequence pause
				state = JSON.parse(JSON.stringify(state)) as GameState;
				const prm = state.pendingPrompts[0]!;
				assert.equal(prm.kind, 'yesNo');
				// Keep ClashWin6 / Opp4A on top so P1 draws them or keeps ClashLose1 on top
				const ansRes = applyGameAction(state, prm.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'yesNo', yes: false }
				});
				assert.equal(ansRes.ok, true, ansRes.ok ? '' : (ansRes.error ?? ''));
			}
			assert.ok(promptsSeen >= 2, 'Expected human clash placement prompts across repeatSequence iterations');
			assert.equal(state.players[0]!.life, 36, "Hoarder's Greed ran 2 iterations (lost 4 life total)");
			assert.equal(state.players[0]!.hand.length, 4, "Hoarder's Greed drew 4 cards across 2 iterations");

			// 2. Single-iteration stop when losing first clash
			const g2 = setupGame();
			g2.p1.library = [makeLibCard('D1', 1), makeLibCard('D2', 1), makeLibCard('Low1', 1)].map((c) =>
				createCardInstance(c, g2.p1.playerId, 'library', false, false, ++g2.state.nextTimestamp!)
			);
			g2.p2.library = [makeLibCard('High7', 7)].map((c) =>
				createCardInstance(c, g2.p2.playerId, 'library', false, false, ++g2.state.nextTimestamp!)
			);
			const greed2 = putInZone(g2.state, g2.p1, card, 'hand');
			giveMana(g2.p1, { B: 1, C: 3 });
			assert.equal(castSpell(g2.state, g2.p1, greed2).ok, true);
			for (let g = 0; g < 15; g++) {
				resolveAllStack(g2.state);
				if (g2.state.pendingPrompts.length === 0) break;
				answerTopPrompt(g2.state, { kind: 'yesNo', yes: false });
			}
			assert.equal(g2.p1.life, 38, 'Single-iteration stop loses only 2 life');
			assert.equal(g2.p1.hand.length, 2, 'Single-iteration stop draws only 2 cards');
		}
	});

	it('repeatSequence: Insatiable Frugivore pauses on optional graveyard exile, persists iteration across JSON roundtrip, and stops on decline or empty GY (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const base = realCard('Insatiable Frugivore');
			const card = useClone ? cloneRenamed(base, 'Ravenous Glutton') : base;

			// 1. 4 cards in graveyard: iter 0 creates Food 1 + exiles 3 (repeats), iter 1 creates Food 2 + cannot pay (stops)
			let { state, p1 } = setupGame();
			const gyCards = Array.from({ length: 4 }, (_, idx) =>
				putInZone(state, p1, synthCard({ name: `GY Fodder ${idx}`, oracleText: '' }), 'graveyard')
			);
			const frug = putInZone(state, p1, card, 'hand');
			giveMana(p1, { B: 1, C: 3 });
			assert.equal(castSpell(state, p1, frug).ok, true);
			resolveAllStack(state);
			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(state.pendingPrompts[0]?.kind, 'yesNo', 'Prompted to exile 3 cards from graveyard');
			answerTopPrompt(state, { kind: 'yesNo', yes: true });
			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseObjects', 'Prompted to choose 3 graveyard cards');
			answerTopPrompt(state, {
				kind: 'chooseObjects',
				objectIds: gyCards.slice(0, 3).map((c) => c.instanceId)
			});
			resolveAllStack(state);
			const foods = state.players[0]!.battlefield.filter((b) => b.isToken && b.card.name === 'Food');
			assert.equal(foods.length, 2, 'Created 2 Food tokens across 2 iterations');
			assert.equal(state.players[0]!.exile.length, 3, 'Exiled 3 graveyard cards on iteration 0');
			assert.equal(state.players[0]!.graveyard.length, 1, '1 card remained in graveyard');

			// 2. Decline optional cost on iter 0 -> 1 Food token, 0 exiled
			const g2 = setupGame();
			for (let idx = 0; idx < 3; idx++) {
				putInZone(g2.state, g2.p1, synthCard({ name: `GY2 ${idx}`, oracleText: '' }), 'graveyard');
			}
			const frug2 = putInZone(g2.state, g2.p1, card, 'hand');
			giveMana(g2.p1, { B: 1, C: 3 });
			assert.equal(castSpell(g2.state, g2.p1, frug2).ok, true);
			resolveAllStack(g2.state);
			assert.equal(g2.state.pendingPrompts[0]?.kind, 'yesNo');
			answerTopPrompt(g2.state, { kind: 'yesNo', yes: false });
			resolveAllStack(g2.state);
			assert.equal(g2.p1.battlefield.filter((b) => b.isToken && b.card.name === 'Food').length, 1);
			assert.equal(g2.p1.exile.length, 0);
		}
	});

	it('repeatSequence: Tyrant of Discord repeats until a land or no permanents remain (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const base = realCard('Tyrant of Discord');
			const card = useClone ? cloneRenamed(base, 'Discord Behemoth') : base;

			// 1. 2 nonland permanents -> sacrifices both across 2 repeating iterations, then stops at 0 permanents
			const { state, p1, p2 } = setupGame();
			putInZone(state, p2, synthCard({ name: 'Nonland A', typeLine: 'Artifact' }), 'battlefield');
			putInZone(state, p2, synthCard({ name: 'Nonland B', typeLine: 'Creature — Bear', power: '2', toughness: '2' }), 'battlefield');
			const tyrant = putInZone(state, p1, card, 'hand');
			giveMana(p1, { R: 3, C: 4 });
			const res = castSpell(state, p1, tyrant);
			assert.equal(res.ok, true, res.ok ? '' : (res.error ?? ''));
			resolveAllStack(state);
			assert.equal(p2.battlefield.length, 0, 'Both nonland permanents sacrificed across repeat iterations');
			assert.equal(p2.graveyard.length, 2);

			// 2. 1 Land only -> sacrifices the Land on iter 0 and stops immediately
			const g2 = setupGame();
			putInZone(g2.state, g2.p2, synthCard({ name: 'Only Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' }), 'battlefield');
			const tyrant2 = putInZone(g2.state, g2.p1, card, 'hand');
			giveMana(g2.p1, { R: 3, C: 4 });
			assert.equal(castSpell(g2.state, g2.p1, tyrant2).ok, true);
			resolveAllStack(g2.state);
			assert.equal(g2.p2.battlefield.length, 0);
			assert.equal(g2.p2.graveyard.length, 1);
		}
	});

	it('sameNameLandsControlledAtLeast excludes face-down permanents even when turned into Lands (CR 201.2a / 708.2a) (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const base = realCard('Endless Atlas');
			const atlasCard = useClone ? cloneRenamed(base, 'Unnamed Cartographer') : base;
			const { state, p1 } = setupGame();
			const atlas = putInZone(state, p1, atlasCard, 'battlefield');
			// Static effect turning all creatures into Lands (like Ashaya)
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Landmaker Aura',
					typeLine: 'Enchantment',
					oracleText: 'All creatures are lands in addition to their other types.'
				}),
				'battlefield'
			);
			// Put 3 face-down creatures on battlefield -> all evaluate as Land with synthetic effectiveName 'Face-Down Creature'
			for (let i = 0; i < 3; i++) {
				const fd = putInZone(
					state,
					p1,
					synthCard({ name: `Secret Creature ${i}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
					'battlefield'
				);
				fd.isFaceDown = true;
			}
			noteLayerInputsChanged(state);
			const fdPerms = p1.battlefield.filter((b) => b.isFaceDown);
			assert.equal(fdPerms.length, 3);
			for (const fd of fdPerms) {
				const ev = evaluatePermanent(state, fd);
				assert.equal(ev.isLand, true, 'Face-down creature is turned into a Land');
				assert.equal(ev.effectiveName, 'Face-Down Creature');
			}

			giveMana(p1, { C: 2 });
			const drawAb = getEffectiveActivatedAbilities(state, p1, atlas).find((a) => !a.isManaAbility);
			assert.ok(drawAb, 'Endless Atlas has activated draw ability');
			const blocked = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: atlas.instanceId,
				abilityId: drawAb.id
			});
			assert.equal(blocked.ok, false, '3 face-down Lands share no name and must NOT satisfy sameNameLandsControlledAtLeast');
			assert.equal(p1.hand.length, 0);

			// Now put 3 face-up Forests on battlefield -> Endless Atlas CAN activate and draws a card
			const forestCard = synthCard({
				name: 'Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '({T}: Add {G}.)'
			});
			for (let i = 0; i < 3; i++) {
				putInZone(state, p1, forestCard, 'battlefield');
			}
			const allowed = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: atlas.instanceId,
				abilityId: drawAb.id
			});
			assert.equal(allowed.ok, true, '3 face-up Forests satisfy sameNameLandsControlledAtLeast');
			resolveAllStack(state);
			assert.equal(p1.hand.length, 1, 'Endless Atlas drew 1 card');
		}
	});

	it('River of Tears (playedLandThisTurn) produces {U} before land, {B} after land, blocks {U}{B} autoTap, resets across turns, and updates opponent Exotic Orchard CR 106.7 (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const base = realCard('River of Tears');
			const riverCard = useClone ? cloneRenamed(base, 'Wavelet of Grief') : base;
			const orchardCard = realCard('Exotic Orchard');
			const { state, p1, p2 } = setupGame();

			const river = putInZone(state, p1, riverCard, 'battlefield');
			const orchard = putInZone(state, p2, orchardCard, 'battlefield');
			const extraLand = putInZone(
				state,
				p1,
				synthCard({ name: 'Colorless Waste', manaCost: '', cmc: 0, typeLine: 'Land', oracleText: '({T}: Add {C}.)' }),
				'hand'
			);
			const ubSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Dimir Probe', manaCost: '{U}{B}', cmc: 2, typeLine: 'Instant', oracleText: 'Draw a card.', colors: ['U', 'B'] }),
				'hand'
			);
			const uSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Blue Peek', manaCost: '{U}', cmc: 1, typeLine: 'Instant', oracleText: 'Draw a card.', colors: ['U'] }),
				'hand'
			);
			const bSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Black Peek', manaCost: '{B}', cmc: 1, typeLine: 'Instant', oracleText: 'You lose 1 life.', colors: ['B'] }),
				'hand'
			);

			// Before play_land: River produces ['U'], amount 1, no manaBundles; Exotic Orchard sees ['U']
			const abBefore = getEffectiveActivatedAbilities(state, p1, river).find((a) => a.isManaAbility);
			assert.ok(abBefore);
			assert.deepEqual(abBefore.producesMana, ['U']);
			assert.equal(abBefore.producesAmount, 1);
			assert.equal(abBefore.manaBundles, undefined);
			const orchardBefore = getEffectiveActivatedAbilities(state, p2, orchard).find((a) => a.isManaAbility);
			assert.ok(orchardBefore);
			assert.deepEqual(orchardBefore.producesMana, ['U']);

			// Auto-tap before play_land: {U}{B} and {B} rejected; {U} succeeds via single River of Tears
			assert.equal(castSpell(state, p1, ubSpell).ok, false, 'Single River of Tears must not auto-tap for {U}{B}');
			assert.equal(castSpell(state, p1, bSpell).ok, false, 'River of Tears must not auto-tap for {B} before play_land');
			assert.equal(castSpell(state, p1, uSpell).ok, true, 'River of Tears auto-taps for {U} before play_land');
			assert.equal(river.tapped, true);
			resolveAllStack(state);

			// Manual tap_mana & activate_ability before play_land both add {U: 1, B: 0}
			river.tapped = false;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			const actBefore = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: river.instanceId,
				abilityId: abBefore.id
			});
			assert.equal(actBefore.ok, true, actBefore.ok ? '' : (actBefore.error ?? ''));
			assert.deepEqual({ U: p1.manaPool.U, B: p1.manaPool.B }, { U: 1, B: 0 });

			river.tapped = false;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			const tapBefore = applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: river.instanceId });
			assert.equal(tapBefore.ok, true, tapBefore.ok ? '' : (tapBefore.error ?? ''));
			assert.deepEqual({ U: p1.manaPool.U, B: p1.manaPool.B }, { U: 1, B: 0 });

			// Play a land this turn -> River switches to {B}, Exotic Orchard switches to ['B']
			river.tapped = false;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			const playRes = applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: extraLand.instanceId });
			assert.equal(playRes.ok, true, playRes.ok ? '' : (playRes.error ?? ''));

			const abAfter = getEffectiveActivatedAbilities(state, p1, river).find((a) => a.isManaAbility);
			assert.ok(abAfter);
			assert.deepEqual(abAfter.producesMana, ['B']);
			assert.equal(abAfter.producesAmount, 1);
			assert.equal(abAfter.manaBundles, undefined);
			const orchardAfter = getEffectiveActivatedAbilities(state, p2, orchard).find((a) => a.isManaAbility);
			assert.ok(orchardAfter);
			assert.deepEqual(orchardAfter.producesMana, ['B']);

			// Auto-tap after play_land: {U}{B} rejected; {B} succeeds
			assert.equal(castSpell(state, p1, ubSpell).ok, false, 'Single River of Tears must not auto-tap for {U}{B} after play_land');
			assert.equal(castSpell(state, p1, bSpell).ok, true, 'River of Tears auto-taps for {B} after play_land');
			assert.equal(river.tapped, true);
			resolveAllStack(state);

			// Manual activate_ability & tap_mana after play_land both add {U: 0, B: 1}
			river.tapped = false;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: river.instanceId, abilityId: abAfter.id }).ok,
				true
			);
			assert.deepEqual({ U: p1.manaPool.U, B: p1.manaPool.B }, { U: 0, B: 1 });

			river.tapped = false;
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: river.instanceId }).ok, true);
			assert.deepEqual({ U: p1.manaPool.U, B: p1.manaPool.B }, { U: 0, B: 1 });

			// Turn boundary resets landsPlayedThisTurn -> River reverts to {U}
			passUntilPhase(state, 'main1', 1);
			const abOppTurn = getEffectiveActivatedAbilities(state, p1, river).find((a) => a.isManaAbility);
			assert.deepEqual(abOppTurn?.producesMana, ['U']);
			passUntilPhase(state, 'main1', 0);
			const abNextOwnTurn = getEffectiveActivatedAbilities(state, p1, river).find((a) => a.isManaAbility);
			assert.deepEqual(abNextOwnTurn?.producesMana, ['U']);
		}
	});

	it('Generic conditional addMana: gated 0-mana ability preserves isManaAbility (CR 605.2 / CR 106.5) and additive conditional+dynamic addMana sums active steps (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			// A. Gated conditional mana ability
			const gatedBase = synthCard({
				name: 'Ferocious Relic',
				typeLine: 'Artifact',
				oracleText: '{T}: If you control a creature with power 4 or greater, add {G}{G}.'
			});
			const gatedCard = useClone ? cloneRenamed(gatedBase, 'Titan Mana Stone') : gatedBase;
			assert.equal(compileCard(gatedCard).fullySupported, true);

			const { state, p1 } = setupGame();
			const relic = putInZone(state, p1, gatedCard, 'battlefield');
			const gSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Green Bolt', manaCost: '{G}', cmc: 1, typeLine: 'Instant', oracleText: 'You gain 1 life.', colors: ['G'] }),
				'hand'
			);
			const ggSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Double Green', manaCost: '{G}{G}', cmc: 2, typeLine: 'Instant', oracleText: 'You gain 2 life.', colors: ['G'] }),
				'hand'
			);

			const abInactive = getEffectiveActivatedAbilities(state, p1, relic).find((a) => a.isManaAbility);
			assert.ok(abInactive, 'CR 605.2: gated conditional addMana still has isManaAbility === true when condition is false');
			assert.deepEqual(abInactive.producesMana, []);
			assert.equal(abInactive.producesAmount, 0);
			assert.equal(castSpell(state, p1, gSpell).ok, false, 'autoTap skips gated mana ability with 0 active mana');

			// Manual tap_mana when inactive pays {T} and adds 0 mana (CR 106.5)
			const tapInactive = applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: relic.instanceId });
			assert.equal(tapInactive.ok, true, tapInactive.ok ? '' : (tapInactive.error ?? ''));
			assert.equal(relic.tapped, true);
			assert.equal(p1.manaPool.G, 0);

			// Add a 4/4 creature -> gated ability now produces ['G'] x 2
			relic.tapped = false;
			putInZone(
				state,
				p1,
				synthCard({ name: 'Big Beast', typeLine: 'Creature — Beast', power: '4', toughness: '4' }),
				'battlefield'
			);
			const abActive = getEffectiveActivatedAbilities(state, p1, relic).find((a) => a.isManaAbility);
			assert.ok(abActive);
			assert.deepEqual(abActive.producesMana, ['G']);
			assert.equal(abActive.producesAmount, 2);
			assert.equal(castSpell(state, p1, ggSpell).ok, true, 'autoTap uses active {G}{G} mana ability');
			resolveAllStack(state);

			// B. Additive conditional + dynamic addMana
			const additiveBase = synthCard({
				name: 'Elvish Font',
				typeLine: 'Artifact',
				oracleText: '{T}: Add {G}. If you control an Elf, add {G} for each Elf you control.'
			});
			const additiveCard = useClone ? cloneRenamed(additiveBase, 'Sylvan Conduit') : additiveBase;
			assert.equal(compileCard(additiveCard).fullySupported, true);

			const g2 = setupGame();
			const font = putInZone(g2.state, g2.p1, additiveCard, 'battlefield');
			assert.equal(applyGameAction(g2.state, g2.p1.playerId, { type: 'tap_mana', instanceId: font.instanceId }).ok, true);
			assert.equal(g2.p1.manaPool.G, 1, 'Produces 1 {G} with 0 Elves');

			font.tapped = false;
			g2.p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			for (let i = 0; i < 2; i++) {
				putInZone(
					g2.state,
					g2.p1,
					synthCard({ name: `Elf Scout ${i}`, typeLine: 'Creature — Elf', power: '1', toughness: '1' }),
					'battlefield'
				);
			}
			assert.equal(applyGameAction(g2.state, g2.p1.playerId, { type: 'tap_mana', instanceId: font.instanceId }).ok, true);
			assert.equal(g2.p1.manaPool.G, 3, 'Produces 1 + 2 = 3 {G} with 2 Elves');
		}
	});

	it('Prize Pig removes 3+ ribbon counters and untaps via conditionalSequence (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const base = realCard('Prize Pig');
			const pigCard = useClone ? cloneRenamed(base, 'Ribbon Boar') : base;
			const { state, p1 } = setupGame();
			const pig = putInZone(state, p1, pigCard, 'battlefield', { tapped: true });

			const gain2 = putInZone(
				state,
				p1,
				synthCard({ name: 'Gain Two', manaCost: '{W}', cmc: 1, typeLine: 'Sorcery', oracleText: 'You gain 2 life.', colors: ['W'] }),
				'hand'
			);
			const gain1 = putInZone(
				state,
				p1,
				synthCard({ name: 'Gain One', manaCost: '{W}', cmc: 1, typeLine: 'Sorcery', oracleText: 'You gain 1 life.', colors: ['W'] }),
				'hand'
			);
			const gain4 = putInZone(
				state,
				p1,
				synthCard({ name: 'Gain Four', manaCost: '{W}', cmc: 1, typeLine: 'Sorcery', oracleText: 'You gain 4 life.', colors: ['W'] }),
				'hand'
			);

			// 2 life -> 2 ribbon counters, stays tapped
			giveMana(p1, { W: 1 });
			assert.equal(castSpell(state, p1, gain2).ok, true);
			resolveAllStack(state);
			assert.equal(pig.counters.ribbon ?? 0, 2);
			assert.equal(pig.tapped, true);

			// +1 life (3 total) -> removes all ribbon counters AND untaps
			giveMana(p1, { W: 1 });
			assert.equal(castSpell(state, p1, gain1).ok, true);
			resolveAllStack(state);
			assert.equal(pig.counters.ribbon ?? 0, 0);
			assert.equal(pig.tapped, false);

			// Tap again and gain 4 life -> removes all 4 ribbon counters AND untaps
			pig.tapped = true;
			giveMana(p1, { W: 1 });
			assert.equal(castSpell(state, p1, gain4).ok, true);
			resolveAllStack(state);
			assert.equal(pig.counters.ribbon ?? 0, 0);
			assert.equal(pig.tapped, false);
		}
	});

	it('conditionalSequence preserves single condition check across self-invalidating step and mid-branch JSON pause/resume (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const base = synthCard({
				name: 'Counter Archive',
				typeLine: 'Artifact',
				oracleText: '{T}: If Counter Archive has a +1/+1 counter on it, remove a +1/+1 counter from Counter Archive and you may draw a card.'
			});
			const card = useClone ? cloneRenamed(base, 'Rune Reliquary') : base;
			assert.equal(compileCard(card).fullySupported, true);

			let { state, p1 } = setupGame();
			const perm = putInZone(state, p1, card, 'battlefield', { counters: { '+1/+1': 1 } });
			const ab = getEffectiveActivatedAbilities(state, p1, perm).find((a) => !a.isManaAbility);
			assert.ok(ab);

			// Activate with 1 +1/+1 counter -> step 0 removes counter (0 left), step 1 pauses on optional draw
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: perm.instanceId, abilityId: ab.id }).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(perm.counters['+1/+1'] ?? 0, 0, 'First step removed the +1/+1 counter');
			assert.equal(state.pendingPrompts[0]?.kind, 'yesNo', 'Second step inside conditionalSequence prompted despite counter removal');

			// Round-trip GameState through JSON while paused mid-conditionalSequence, then accept
			state = JSON.parse(JSON.stringify(state)) as GameState;
			answerTopPrompt(state, { kind: 'yesNo', yes: true });
			resolveAllStack(state);
			assert.equal(state.players[0]!.hand.length, 1, 'Resumed thenSteps completed optional draw after JSON round-trip');

			// Activate again with 0 +1/+1 counters -> condition false, no prompt, 0 cards drawn
			const permRef = state.players[0]!.battlefield.find((b) => b.instanceId === perm.instanceId)!;
			permRef.tapped = false;
			assert.equal(
				applyGameAction(state, state.players[0]!.playerId, { type: 'activate_ability', instanceId: permRef.instanceId, abilityId: ab.id }).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(state.pendingPrompts.length, 0);
			assert.equal(state.players[0]!.hand.length, 1);
		}
	});

	it('Currency Converter binds nonland check to moved card rather than Treasure token (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const base = realCard('Currency Converter');
			const ccCard = useClone ? cloneRenamed(base, 'Minting Ledger') : base;
			const { state, p1 } = setupGame();
			const cc = putInZone(state, p1, ccCard, 'battlefield');

			// Drive real discard trigger -> optional exile for a nonland creature card
			const bear = putInZone(
				state,
				p1,
				synthCard({ name: 'Discarded Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2', manaCost: '{1}{G}', cmc: 2 }),
				'hand'
			);
			const discardSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Self Discard', manaCost: '{B}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Discard a card.', colors: ['B'] }),
				'hand'
			);
			giveMana(p1, { B: 1 });
			assert.equal(castSpell(state, p1, discardSpell).ok, true);
			resolveAllStack(state);
			// Discard Bear (since only Bear is left in hand, or chooseObjects if prompted)
			if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
				answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [bear.instanceId] });
				resolveAllStack(state);
			}
			assert.equal(state.pendingPrompts[0]?.kind, 'yesNo', 'Currency Converter prompts to exile discarded card');
			answerTopPrompt(state, { kind: 'yesNo', yes: true });
			resolveAllStack(state);
			assert.equal(p1.exile.some((c) => c.instanceId === bear.instanceId), true, 'Bear exiled with Currency Converter');

			const tapReturnAb = getEffectiveActivatedAbilities(state, p1, cc).find(
				(a) => !a.isManaAbility && a.manaCost === ''
			);
			assert.ok(tapReturnAb, 'Currency Converter has {T} exiled-return ability');
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: cc.instanceId, abilityId: tapReturnAb.id }).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.graveyard.some((c) => c.instanceId === bear.instanceId), true, 'Exiled nonland card moved to graveyard');
			const rogueTokens = p1.battlefield.filter((b) => b.isToken && b.card.name === 'Rogue Token');
			assert.equal(rogueTokens.length, 1, 'Created 2/2 black Rogue token for nonland card');

			// Also verify land card exiled with Currency Converter creates a Treasure token and no extra Rogue token
			cc.tapped = false;
			const land = putInZone(
				state,
				p1,
				synthCard({ name: 'Discarded Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' }),
				'hand'
			);
			const discardSpell2 = putInZone(
				state,
				p1,
				synthCard({ name: 'Self Discard 2', manaCost: '{B}', cmc: 1, typeLine: 'Sorcery', oracleText: 'Discard a card.', colors: ['B'] }),
				'hand'
			);
			giveMana(p1, { B: 1 });
			assert.equal(castSpell(state, p1, discardSpell2).ok, true);
			resolveAllStack(state);
			if (state.pendingPrompts[0]?.choice?.kind === 'chooseObjects') {
				answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [land.instanceId] });
				resolveAllStack(state);
			}
			answerTopPrompt(state, { kind: 'yesNo', yes: true });
			resolveAllStack(state);
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'activate_ability', instanceId: cc.instanceId, abilityId: tapReturnAb.id }).ok,
				true
			);
			resolveAllStack(state);
			const treasureTokens = p1.battlefield.filter((b) => b.isToken && b.card.name === 'Treasure');
			assert.equal(treasureTokens.length, 1, 'Created Treasure token for exiled land card');
			assert.equal(p1.battlefield.filter((b) => b.isToken && b.card.name === 'Rogue Token').length, 1);
		}
	});

	it('CR 106.7 Bug 1: Thriving Grove manaOrChosenColor propagates to Exotic Orchard, Fellwar Stone, autoTap, and tap_mana (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const thrivingBase = realCard('Thriving Grove');
			const orchardBase = realCard('Exotic Orchard');
			const stoneBase = realCard('Fellwar Stone');
			const thrivingCard = useClone ? cloneRenamed(thrivingBase, 'Flourishing Glade') : thrivingBase;
			const orchardCard = useClone ? cloneRenamed(orchardBase, 'Alien Meadow') : orchardBase;
			const stoneCard = useClone ? cloneRenamed(stoneBase, 'Echoing Signet') : stoneBase;

			const { state, p1, p2 } = setupGame();
			const tg = putInZone(state, p1, thrivingCard, 'battlefield');
			tg.chosenColor = 'U';
			const eo = putInZone(state, p2, orchardCard, 'battlefield');
			const fs = putInZone(state, p2, stoneCard, 'battlefield');
			noteLayerInputsChanged(state);

			assert.deepEqual(opponentLandColors(state, p2), ['U', 'G']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['U', 'G']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, fs)[0]?.producesMana, ['U', 'G']);

			// tap_mana preferredColor=G adds {G} (not {U})
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'tap_mana',
					instanceId: eo.instanceId,
					preferredColor: 'G'
				}).ok,
				true
			);
			assert.equal(p2.manaPool.G, 1);
			assert.equal(p2.manaPool.U, 0);

			// autoTap uses Exotic Orchard to cast a {G} spell
			eo.tapped = false;
			p2.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 1;
			const greenSpell = putInZone(
				state,
				p2,
				synthCard({ name: 'Green Bolt', manaCost: '{G}', cmc: 1, typeLine: 'Sorcery', colors: ['G'], oracleText: 'You gain 1 life.' }),
				'hand'
			);
			assert.equal(castSpell(state, p2, greenSpell).ok, true);
			assert.equal(eo.tapped, true);
		}
	});

	it('CR 106.7 Bug 2: activationCondition gates Spire of Industry, Tainted Wood, and Temple of the False God for Exotic Orchard & Reflecting Pool (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const spireCard = useClone ? cloneRenamed(realCard('Spire of Industry'), 'Foundry Tower') : realCard('Spire of Industry');
			const taintedCard = useClone ? cloneRenamed(realCard('Tainted Wood'), 'Foul Thicket') : realCard('Tainted Wood');
			const templeCard = useClone ? cloneRenamed(realCard('Temple of the False God'), 'Shrine of Idols') : realCard('Temple of the False God');
			const orchardCard = useClone ? cloneRenamed(realCard('Exotic Orchard'), 'Foreign Grove') : realCard('Exotic Orchard');
			const poolCard = useClone ? cloneRenamed(realCard('Reflecting Pool'), 'Mirror Basin') : realCard('Reflecting Pool');

			// 1. Spire of Industry (0 vs 1 artifact)
			{
				const { state, p1, p2 } = setupGame();
				putInZone(state, p1, spireCard, 'battlefield');
				const rp = putInZone(state, p1, poolCard, 'battlefield');
				const eo = putInZone(state, p2, orchardCard, 'battlefield');
				noteLayerInputsChanged(state);

				assert.deepEqual(opponentLandColors(state, p2), []);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo), []);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, true), ['C']);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, false), []);

				putInZone(state, p1, synthCard({ name: 'Test Relic', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 }), 'battlefield');
				noteLayerInputsChanged(state);
				assert.deepEqual(opponentLandColors(state, p2), ['W', 'U', 'B', 'R', 'G']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['W', 'U', 'B', 'R', 'G']);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, true), ['W', 'U', 'B', 'R', 'G', 'C']);
			}

			// 2. Tainted Wood (0 vs 1 Swamp)
			{
				const { state, p1, p2 } = setupGame();
				putInZone(state, p1, taintedCard, 'battlefield');
				const rp = putInZone(state, p1, poolCard, 'battlefield');
				const eo = putInZone(state, p2, orchardCard, 'battlefield');
				noteLayerInputsChanged(state);

				assert.deepEqual(opponentLandColors(state, p2), []);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, false), []);
				const gSpell = putInZone(
					state,
					p1,
					synthCard({ name: 'Need Green', manaCost: '{G}', cmc: 1, typeLine: 'Sorcery', colors: ['G'], oracleText: 'You gain 1 life.' }),
					'hand'
				);
				assert.equal(castSpell(state, p1, gSpell).ok, false, 'Reflecting Pool cannot cast {G} off Tainted Wood with 0 Swamps');

				putInZone(state, p1, synthCard({ name: 'Test Swamp', manaCost: '', cmc: 0, typeLine: 'Basic Land — Swamp' }), 'battlefield');
				noteLayerInputsChanged(state);
				assert.deepEqual(opponentLandColors(state, p2), ['B', 'G']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['B', 'G']);
				assert.equal(castSpell(state, p1, gSpell).ok, true, 'Reflecting Pool casts {G} once P1 controls a Swamp');
			}

			// 3. Temple of the False God (4 vs 5 lands)
			{
				const { state, p1 } = setupGame();
				const temple = putInZone(state, p1, templeCard, 'battlefield');
				const rp = putInZone(state, p1, poolCard, 'battlefield');
				const wasteCard = synthCard({ name: 'Test Waste', manaCost: '', cmc: 0, typeLine: 'Land', oracleText: '' });
				putInZone(state, p1, wasteCard, 'battlefield');
				putInZone(state, p1, wasteCard, 'battlefield');
				noteLayerInputsChanged(state);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, temple, true), []);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, true), []);

				putInZone(state, p1, wasteCard, 'battlefield');
				noteLayerInputsChanged(state);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, temple, true), ['C']);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, true), ['C']);
			}
		}
	});

	it('CR 106.7 Bug 3: Active-face scoping on MDFC/transform/clone lands and CR 708.2a face-down lands (+ cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const pathwayBase = realCard('Clearwater Pathway');
			const pathwayCard = useClone
				? {
						...cloneRenamed(pathwayBase, 'Silverstream Trail'),
						faces: pathwayBase.faces?.map((f, i) => ({
							...f,
							name: i === 0 ? 'Silverstream Trail' : 'Shadowstream Trail'
						}))
					}
				: pathwayBase;
			const orchardCard = useClone ? cloneRenamed(realCard('Exotic Orchard'), 'Distant Meadow') : realCard('Exotic Orchard');
			const stoneCard = useClone ? cloneRenamed(realCard('Fellwar Stone'), 'Borrowed Stone') : realCard('Fellwar Stone');
			const poolCard = useClone ? cloneRenamed(realCard('Reflecting Pool'), 'Still Pond') : realCard('Reflecting Pool');

			// 1. MDFC face 0 ({U}) vs face 1 ({B})
			{
				const { state, p1, p2 } = setupGame();
				const pw = putInZone(state, p1, pathwayCard, 'battlefield');
				pw.activeFaceIndex = 0;
				const rp = putInZone(state, p1, poolCard, 'battlefield');
				const eo = putInZone(state, p2, orchardCard, 'battlefield');
				const fs = putInZone(state, p2, stoneCard, 'battlefield');
				noteLayerInputsChanged(state);

				assert.deepEqual(opponentLandColors(state, p2), ['U']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['U']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, fs)[0]?.producesMana, ['U']);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, true), ['U']);

				// P2 cannot cast {B} off face-0 Clearwater Pathway
				state.activePlayerIndex = 1;
				state.priorityPlayerIndex = 1;
				const bSpell = putInZone(
					state,
					p2,
					synthCard({ name: 'Black Cantrip', manaCost: '{B}', cmc: 1, typeLine: 'Sorcery', colors: ['B'], oracleText: 'You gain 1 life.' }),
					'hand'
				);
				assert.equal(castSpell(state, p2, bSpell).ok, false);

				// Flip to face 1 ({B}) -> only ['B'] visible
				pw.activeFaceIndex = 1;
				noteLayerInputsChanged(state);
				assert.deepEqual(opponentLandColors(state, p2), ['B']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['B']);
				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, true), ['B']);
				assert.equal(castSpell(state, p2, bSpell).ok, true);
			}

			// 2. Transform / clone land (enchantment face 0 vs transformed land face 1 + copiableState clone)
			{
				const ritesLike = synthCard({
					name: useClone ? 'Bountiful Glade // Glade Cradle' : 'Sylvan Rites // Sylvan Cradle',
					layout: 'transform',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Enchantment // Land',
					oracleText: '',
					faces: [
						{
							name: useClone ? 'Bountiful Glade' : 'Sylvan Rites',
							manaCost: '{2}{G}',
							cmc: 3,
							typeLine: 'Enchantment',
							oracleText: 'At the beginning of your end step, you gain 1 life.',
							colors: ['G'],
							keywords: [],
							imageUrl: ''
						},
						{
							name: useClone ? 'Glade Cradle' : 'Sylvan Cradle',
							manaCost: '',
							cmc: 0,
							typeLine: 'Legendary Land',
							oracleText: '{T}: Add {G}.',
							colors: [],
							keywords: [],
							imageUrl: ''
						}
					]
				});
				const { state, p1, p2 } = setupGame();
				const rites = putInZone(state, p1, ritesLike, 'battlefield');
				rites.activeFaceIndex = 0;
				const clonePerm = putInZone(
					state,
					p1,
					synthCard({ name: 'Land Copycat', typeLine: 'Artifact', manaCost: '{2}', cmc: 2 }),
					'battlefield'
				);
				clonePerm.copiableState = { card: ritesLike, faceIndex: 1, isSingleFaceCopy: true };
				clonePerm.copiableCard = ritesLike;
				const eo = putInZone(state, p2, orchardCard, 'battlefield');
				noteLayerInputsChanged(state);

				// Clone is face 1 (Land -> {G}); front face 0 on rites is Enchantment (not a Land)
				assert.deepEqual(opponentLandColors(state, p2), ['G']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['G']);

				// Remove clone -> rites on face 0 is not a land, even if animated into a Land it shouldn't leak face 1 {G}
				p1.battlefield = [rites];
				putInZone(
					state,
					p1,
					synthCard({
						name: 'Land Anim',
						typeLine: 'Enchantment',
						manaCost: '{1}',
						cmc: 1,
						oracleText: 'Enchantments you control are lands in addition to their other types.'
					}),
					'battlefield'
				);
				noteLayerInputsChanged(state);
				assert.deepEqual(opponentLandColors(state, p2), []);
			}

			// 3. Face-down creature turned into a Land (CR 708.2a -> 0 leaked innate mana)
			{
				const { state, p1, p2 } = setupGame();
				const anim = synthCard({
					name: useClone ? 'Wildwood Spirit' : 'Earth Spirit',
					typeLine: 'Enchantment',
					manaCost: '{2}{G}',
					cmc: 3,
					colors: ['G'],
					oracleText: 'Creatures you control are lands in addition to their other types.'
				});
				putInZone(state, p1, anim, 'battlefield');
				const faceDownBirds = putInZone(
					state,
					p1,
					synthCard({
						name: useClone ? 'Hidden Avian' : 'Manifested Avian',
						typeLine: 'Creature — Bird',
						manaCost: '{G}',
						cmc: 1,
						power: '0',
						toughness: '1',
						oracleText: '{T}: Add one mana of any color.'
					}),
					'battlefield'
				);
				faceDownBirds.isFaceDown = true;
				const eo = putInZone(state, p2, orchardCard, 'battlefield');
				noteLayerInputsChanged(state);

				assert.equal(evaluatePermanent(state, faceDownBirds).isLand, true);
				assert.deepEqual(opponentLandColors(state, p2), []);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo), []);

				// Now also make nontoken creatures Forest lands -> only ['G'] from Forest subtype, never innate any-color
				putInZone(
					state,
					p1,
					synthCard({
						name: useClone ? 'Canopy Avatar' : 'Forest Avatar',
						typeLine: 'Creature — Elemental',
						manaCost: '{3}{G}{G}',
						cmc: 5,
						colors: ['G'],
						power: '4',
						toughness: '4',
						oracleText: 'Nontoken creatures you control are Forest lands in addition to their other types.'
					}),
					'battlefield'
				);
				noteLayerInputsChanged(state);
				assert.deepEqual(opponentLandColors(state, p2), ['G']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['G']);
			}
		}
	});

	it('CR 106.7 edge cases: mutual Exotic Orchards, Reflecting Pool + Orchard, Pit of Offerings, Gift of Paradise, keepManaAbilities, Cabal Coffers, Command Tower, and controlsFilter stack zone', () => {
		// 1. Mutual Exotic Orchards + empty Orchards (0 infinite recursion)
		{
			const { state, p1, p2 } = setupGame();
			const eo1 = putInZone(state, p1, realCard('Exotic Orchard'), 'battlefield');
			const eo2 = putInZone(state, p2, realCard('Exotic Orchard'), 'battlefield');
			noteLayerInputsChanged(state);
			assert.deepEqual(opponentLandColors(state, p1), []);
			assert.deepEqual(opponentLandColors(state, p2), []);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p1, eo1), []);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo2), []);

			putInZone(state, p1, realCard('Island'), 'battlefield');
			noteLayerInputsChanged(state);
			assert.deepEqual(opponentLandColors(state, p1), ['U']);
			assert.deepEqual(opponentLandColors(state, p2), ['U']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p1, eo1)[0]?.producesMana, ['U']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo2)[0]?.producesMana, ['U']);
		}

		// 2. Reflecting Pool + Exotic Orchard vs opponent Mountain + empty Reflecting Pools
		{
			const { state, p1, p2 } = setupGame();
			const rp1 = putInZone(state, p1, realCard('Reflecting Pool'), 'battlefield');
			putInZone(state, p1, realCard('Reflecting Pool'), 'battlefield');
			noteLayerInputsChanged(state);
			assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp1, true), []);

			putInZone(state, p1, realCard('Exotic Orchard'), 'battlefield');
			putInZone(state, p2, realCard('Mountain'), 'battlefield');
			noteLayerInputsChanged(state);
			assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp1, true), ['R']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p1, rp1)[0]?.producesMana, ['R']);
		}

		// 3. Pit of Offerings with exiled Black card
		{
			const { state, p1, p2 } = setupGame();
			const pit = putInZone(state, p1, realCard('Pit of Offerings'), 'battlefield');
			const rp = putInZone(state, p1, realCard('Reflecting Pool'), 'battlefield');
			const eo = putInZone(state, p2, realCard('Exotic Orchard'), 'battlefield');
			const exiledSwampOrBlack = putInZone(
				state,
				p2,
				synthCard({ name: 'Black Card', manaCost: '{B}', cmc: 1, typeLine: 'Sorcery', colors: ['B'] }),
				'exile'
			);
			exiledSwampOrBlack.exiledBy = {
				sourceInstanceId: pit.instanceId,
				sourceObjectVersion: pit.objectVersion ?? 1
			};
			noteLayerInputsChanged(state);

			const pitAct = getEffectiveActivatedAbilities(state, p1, pit).find((a) => a.id === 'act_3');
			assert.deepEqual(pitAct?.producesMana, ['B']);
			assert.deepEqual(permanentCouldProduceManaTypes(state, p1, pit, true), ['B', 'C']);
			assert.deepEqual(permanentCouldProduceManaTypes(state, p1, rp, true), ['B', 'C']);
			assert.deepEqual(opponentLandColors(state, p2), ['B']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['B']);

			// autoTap can tap Pit of Offerings for {B}
			const darkSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Dark Cantrip', manaCost: '{B}', cmc: 1, typeLine: 'Sorcery', colors: ['B'], oracleText: 'You gain 1 life.' }),
				'hand'
			);
			assert.equal(castSpell(state, p1, darkSpell).ok, true);
			assert.equal(pit.tapped, true);
		}

		// 4. Gift of Paradise (Layer 6 granted 2-mana any color) & keepManaAbilities on Land-creature
		{
			const { state, p1, p2 } = setupGame();
			const waste = putInZone(
				state,
				p1,
				synthCard({ name: 'Plain Waste', manaCost: '', cmc: 0, typeLine: 'Land' }),
				'battlefield'
			);
			const gift = putInZone(state, p1, realCard('Gift of Paradise'), 'battlefield');
			gift.attachedToId = waste.instanceId;
			const eo = putInZone(state, p2, realCard('Exotic Orchard'), 'battlefield');
			noteLayerInputsChanged(state);

			assert.deepEqual(opponentLandColors(state, p2), ['W', 'U', 'B', 'R', 'G']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['W', 'U', 'B', 'R', 'G']);

			// Land-creature with keepManaAbilities retains innate mana ability
			const { state: s2, p1: q1, p2: q2 } = setupGame();
			putInZone(
				s2,
				q1,
				synthCard({
					name: 'Land Anim 2',
					typeLine: 'Enchantment',
					manaCost: '{1}',
					cmc: 1,
					oracleText: 'Creatures you control are lands in addition to their other types.'
				}),
				'battlefield'
			);
			putInZone(
				s2,
				q1,
				synthCard({
					name: 'Mana Keeper',
					typeLine: 'Enchantment',
					manaCost: '{2}{W}',
					cmc: 3,
					colors: ['W'],
					oracleText: 'Creatures lose all abilities except mana abilities.'
				}),
				'battlefield'
			);
			putInZone(
				s2,
				q1,
				synthCard({
					name: 'Blue Dork',
					typeLine: 'Creature — Wizard',
					manaCost: '{U}',
					cmc: 1,
					colors: ['U'],
					power: '1',
					toughness: '1',
					oracleText: '{T}: Add {U}.'
				}),
				'battlefield'
			);
			noteLayerInputsChanged(s2);
			assert.deepEqual(opponentLandColors(s2, q2), ['U']);
		}

		// 5. Cabal Coffers (0 vs >=1 Swamps)
		{
			const { state, p1, p2 } = setupGame();
			const coffers = putInZone(state, p1, realCard('Cabal Coffers'), 'battlefield');
			const eo = putInZone(state, p2, realCard('Exotic Orchard'), 'battlefield');
			noteLayerInputsChanged(state);
			assert.deepEqual(permanentCouldProduceManaTypes(state, p1, coffers, true), []);
			assert.deepEqual(opponentLandColors(state, p2), []);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo), []);

			putInZone(state, p1, realCard('Swamp'), 'battlefield');
			noteLayerInputsChanged(state);
			assert.deepEqual(permanentCouldProduceManaTypes(state, p1, coffers, true), ['B']);
			assert.deepEqual(opponentLandColors(state, p2), ['B']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['B']);
		}

		// 6. Command Tower with commander on battlefield (not in command zone)
		{
			const { state, p1, p2 } = setupGame();
			p1.commanderColorIdentity = [];
			putInZone(
				state,
				p1,
				synthCard({
					name: 'Battlefield Commander',
					manaCost: '{U}{R}',
					cmc: 2,
					typeLine: 'Legendary Creature — Wizard',
					colors: ['U', 'R'],
					colorIdentity: ['U', 'R'],
					power: '2',
					toughness: '2',
					canBeCommander: true
				}),
				'battlefield',
				{ isCommander: true }
			);
			putInZone(state, p1, realCard('Command Tower'), 'battlefield');
			const eo = putInZone(state, p2, realCard('Exotic Orchard'), 'battlefield');
			noteLayerInputsChanged(state);
			assert.deepEqual(opponentLandColors(state, p2), ['U', 'R']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p2, eo)[0]?.producesMana, ['U', 'R']);
		}

		// 7. controlsFilter under ctx.zone = 'stack' (objectFilter.ts:1760)
		{
			const { state, p1 } = setupGame();
			putInZone(
				state,
				p1,
				synthCard({ name: 'Stack Test Relic', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 }),
				'battlefield'
			);
			const res = evaluateCondition(
				{
					k: 'controlsFilter',
					filter: { zone: 'battlefield', types: ['Artifact'], controller: 'you' }
				},
				{ state, controllerId: p1.playerId, zone: 'stack' }
			);
			assert.equal(res, true);
		}
	});

	it('CR 613.1f keepManaAbilities retains Exotic Orchard mana ability for tap_mana and autoTap cast_spell (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const bloodSunBase = synthCard({
				name: 'Blood Sun',
				manaCost: '{2}{R}',
				cmc: 3,
				typeLine: 'Enchantment',
				colors: ['R'],
				oracleText: 'All lands lose all abilities except mana abilities.'
			});
			const bloodSunCard = useClone
				? cloneRenamed(bloodSunBase, 'Crimson Eclipse')
				: bloodSunBase;
			const orchardCard = useClone
				? cloneRenamed(realCard('Exotic Orchard'), 'Foreign Meadow')
				: realCard('Exotic Orchard');
			const { state, p1, p2 } = setupGame();
			putInZone(state, p1, bloodSunCard, 'battlefield');
			const eo = putInZone(state, p1, orchardCard, 'battlefield');
			putInZone(state, p2, realCard('Island'), 'battlefield');
			noteLayerInputsChanged(state);

			assert.deepEqual(opponentLandColors(state, p2), ['U']);
			assert.deepEqual(permanentCouldProduceManaTypes(state, p1, eo, true), ['U']);
			assert.deepEqual(getEffectiveActivatedAbilities(state, p1, eo)[0]?.producesMana, ['U']);

			const tapRes = applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: eo.instanceId,
				preferredColor: 'U'
			});
			assert.equal(tapRes.ok, true);
			assert.equal(p1.manaPool.U, 1);

			// Untap and verify autoTap cast_spell works under Blood Sun
			eo.tapped = false;
			p1.manaPool.U = 0;
			noteLayerInputsChanged(state);
			const blueBolt = putInZone(
				state,
				p1,
				synthCard({
					name: 'Blue Spark',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Sorcery',
					colors: ['U'],
					oracleText: 'You gain 1 life.'
				}),
				'hand'
			);
			const castRes = castSpell(state, p1, blueBolt);
			assert.equal(castRes.ok, true);
			assert.equal(eo.tapped, true);
		}
	});

	it('Mirage Mirror (timedLayer1a) copying Reflecting Pool, Llanowar Elves / Clearwater Pathway f1 under keepManaAbilities (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const mirrorCard = useClone
				? cloneRenamed(realCard('Mirage Mirror'), 'Glass Reflection')
				: realCard('Mirage Mirror');
			const poolCard = useClone
				? cloneRenamed(realCard('Reflecting Pool'), 'Shimmering Basin')
				: realCard('Reflecting Pool');
			const elvesCard = useClone
				? cloneRenamed(realCard('Llanowar Elves'), 'Sylvannus Mystic')
				: realCard('Llanowar Elves');
			const pathwayBase = realCard('Clearwater Pathway');
			const pathwayCard = useClone
				? {
						...cloneRenamed(pathwayBase, 'Clearbrook Trail'),
						faces: pathwayBase.faces?.map((f, i) => ({
							...f,
							name: i === 0 ? 'Clearbrook Trail' : 'Murkbrook Trail'
						}))
					}
				: pathwayBase;

			// 1. Mirage Mirror copying Reflecting Pool populates producesMana, tap_mana, and autoTap cast_spell
			{
				const { state, p1, p2 } = setupGame();
				const mirror = putInZone(state, p1, mirrorCard, 'battlefield');
				const mountain = putInZone(state, p1, realCard('Mountain'), 'battlefield');
				const rp = putInZone(state, p2, poolCard, 'battlefield');
				giveMana(p1, { C: 2 });
				noteLayerInputsChanged(state);

				const mmAb = getEffectiveActivatedAbilities(state, p1, mirror)[0]!;
				const actRes = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: mirror.instanceId,
					abilityId: mmAb.id,
					targets: [{ kind: 'permanent', id: rp.instanceId, label: rp.card.name }]
				});
				assert.equal(actRes.ok, true);
				resolveAllStack(state);
				mountain.tapped = true;
				noteLayerInputsChanged(state);

				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, mirror, true), ['R']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p1, mirror)[0]?.producesMana, ['R']);
				const tapRes = applyGameAction(state, p1.playerId, {
					type: 'tap_mana',
					instanceId: mirror.instanceId,
					preferredColor: 'R'
				});
				assert.equal(tapRes.ok, true);
				assert.equal(p1.manaPool.R, 1);

				mirror.tapped = false;
				p1.manaPool.R = 0;
				noteLayerInputsChanged(state);
				const redSpell = putInZone(
					state,
					p1,
					synthCard({
						name: 'Red Ping',
						manaCost: '{R}',
						cmc: 1,
						typeLine: 'Sorcery',
						colors: ['R'],
						oracleText: 'You gain 1 life.'
					}),
					'hand'
				);
				assert.equal(castSpell(state, p1, redSpell).ok, true);
				assert.equal(mirror.tapped, true);
			}

			// 2. keepManaAbilities + Mirage Mirror copying Llanowar Elves
			{
				const { state, p1, p2 } = setupGame();
				putInZone(
					state,
					p1,
					synthCard({
						name: 'Keep Mana Enchant',
						manaCost: '{1}{W}',
						cmc: 2,
						typeLine: 'Enchantment',
						colors: ['W'],
						oracleText: 'Creatures you control lose all abilities except mana abilities.'
					}),
					'battlefield'
				);
				const mirror = putInZone(state, p1, mirrorCard, 'battlefield');
				const elves = putInZone(state, p2, elvesCard, 'battlefield');
				giveMana(p1, { C: 2 });
				noteLayerInputsChanged(state);

				const mmAb = getEffectiveActivatedAbilities(state, p1, mirror)[0]!;
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: mirror.instanceId,
						abilityId: mmAb.id,
						targets: [{ kind: 'permanent', id: elves.instanceId, label: elves.card.name }]
					}).ok,
					true
				);
				resolveAllStack(state);

				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, mirror, true), ['G']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p1, mirror)[0]?.producesMana, ['G']);
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'tap_mana',
						instanceId: mirror.instanceId,
						preferredColor: 'G'
					}).ok,
					true
				);
				assert.equal(p1.manaPool.G, 1);
			}

			// 3. keepManaAbilities (Blood Sun) + Mirage Mirror copying Clearwater Pathway f1
			{
				const { state, p1, p2 } = setupGame();
				const bloodSunBase = synthCard({
					name: 'Blood Sun',
					manaCost: '{2}{R}',
					cmc: 3,
					typeLine: 'Enchantment',
					colors: ['R'],
					oracleText: 'All lands lose all abilities except mana abilities.'
				});
				const bloodSunCard = useClone
					? cloneRenamed(bloodSunBase, 'Solar Lock')
					: bloodSunBase;
				putInZone(state, p1, bloodSunCard, 'battlefield');
				const mirror = putInZone(state, p1, mirrorCard, 'battlefield');
				const pw = putInZone(state, p2, pathwayCard, 'battlefield');
				pw.activeFaceIndex = 1;
				giveMana(p1, { C: 2 });
				noteLayerInputsChanged(state);

				const mmAb = getEffectiveActivatedAbilities(state, p1, mirror)[0]!;
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: mirror.instanceId,
						abilityId: mmAb.id,
						targets: [{ kind: 'permanent', id: pw.instanceId, label: pw.card.name }]
					}).ok,
					true
				);
				resolveAllStack(state);

				assert.deepEqual(permanentCouldProduceManaTypes(state, p1, mirror, true), ['B']);
				assert.deepEqual(getEffectiveActivatedAbilities(state, p1, mirror)[0]?.producesMana, ['B']);
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'tap_mana',
						instanceId: mirror.instanceId,
						preferredColor: 'B'
					}).ok,
					true
				);
				assert.equal(p1.manaPool.B, 1);
			}
		}
	});

	it('CR 400.7 blinked Pit of Offerings does not retain pre-blink exiled card colors (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const pitCard = useClone
				? cloneRenamed(realCard('Pit of Offerings'), 'Chasm of Tribute')
				: realCard('Pit of Offerings');
			const { state, p1, p2 } = setupGame({ p1Bot: true, p2Bot: true });
			putInZone(
				state,
				p2,
				synthCard({
					name: 'Blue Graveyard Spell',
					manaCost: '{U}',
					cmc: 1,
					typeLine: 'Instant',
					colors: ['U']
				}),
				'graveyard'
			);
			const pit = putInZone(state, p1, pitCard, 'hand');
			const playRes = applyGameAction(state, p1.playerId, {
				type: 'play_land',
				instanceId: pit.instanceId
			});
			assert.equal(playRes.ok, true);
			resolveAllStack(state);

			assert.equal(pit.objectVersion, 2);
			assert.deepEqual(opponentLandColors(state, p2), ['U']);
			assert.deepEqual(
				getEffectiveActivatedAbilities(state, p1, pit).find((a) => a.id === 'act_3')?.producesMana,
				['U']
			);

			const blink = putInZone(
				state,
				p1,
				synthCard({
					name: 'Flicker Step',
					manaCost: '{0}',
					cmc: 0,
					typeLine: 'Sorcery',
					oracleText:
						"Exile target permanent you control, then return it to the battlefield under its owner's control."
				}),
				'hand'
			);
			const blinkRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: blink.instanceId,
				targets: [{ kind: 'permanent', id: pit.instanceId, label: pit.card.name }]
			});
			assert.equal(blinkRes.ok, true);
			resolveAllStack(state);

			const pitNow = p1.battlefield.find((c) => c.card.name === pitCard.name)!;
			assert.ok(pitNow);
			assert.equal(pitNow.objectVersion, 4);
			pitNow.tapped = false;
			noteLayerInputsChanged(state);

			assert.deepEqual(opponentLandColors(state, p2), []);
			assert.deepEqual(
				getEffectiveActivatedAbilities(state, p1, pitNow).find((a) => a.id === 'act_3')?.producesMana,
				[]
			);
			const tapRes = applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: pitNow.instanceId,
				abilityId: 'act_3',
				preferredColor: 'U'
			});
			assert.equal(tapRes.ok, true);
			assert.equal(p1.manaPool.U, 0);
		}
	});

	it('Mage-Ring Network act_2 (countersRemovedThisWay) via tap_mana, activate_ability, and Mirage Mirror timedLayer1a copy (canonical + cloneRenamed)', () => {
		for (const useClone of [false, true]) {
			const mrCard = useClone
				? cloneRenamed(realCard('Mage-Ring Network'), 'Arcane Storage Spire')
				: realCard('Mage-Ring Network');
			const mirrorCard = useClone
				? cloneRenamed(realCard('Mirage Mirror'), 'Echoing Looking-Glass')
				: realCard('Mirage Mirror');

			// 1. tap_mana with 2 storage counters removed -> {C: 2}
			{
				const { state, p1 } = setupGame();
				const mr = putInZone(state, p1, mrCard, 'battlefield', { counters: { storage: 2 } });
				const tapRes = applyGameAction(state, p1.playerId, {
					type: 'tap_mana',
					instanceId: mr.instanceId,
					abilityId: 'act_2'
				});
				assert.equal(tapRes.ok, true);
				const prompt = state.pendingPrompts[0];
				assert.ok(prompt && prompt.choice?.kind === 'chooseMode');
				const modeIdx = prompt.choice.modes.findIndex((m) => m.includes('2'));
				assert.ok(modeIdx >= 0);
				const ansRes = applyGameAction(state, p1.playerId, {
					type: 'cost_choice',
					promptId: prompt.id,
					option: modeIdx
				});
				assert.equal(ansRes.ok, true);
				assert.equal(mr.counters.storage, 0);
				assert.equal(p1.manaPool.C, 2);
			}

			// 2. activate_ability with 2 storage counters removed -> {C: 2}
			{
				const { state, p1 } = setupGame();
				const mr = putInZone(state, p1, mrCard, 'battlefield', { counters: { storage: 2 } });
				const actRes = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: mr.instanceId,
					abilityId: 'act_2'
				});
				assert.equal(actRes.ok, true);
				const prompt = state.pendingPrompts[0];
				assert.ok(prompt && prompt.choice?.kind === 'chooseMode');
				const modeIdx = prompt.choice.modes.findIndex((m) => m.includes('2'));
				assert.ok(modeIdx >= 0);
				const ansRes = applyGameAction(state, p1.playerId, {
					type: 'cost_choice',
					promptId: prompt.id,
					option: modeIdx
				});
				assert.equal(ansRes.ok, true);
				assert.equal(mr.counters.storage, 0);
				assert.equal(p1.manaPool.C, 2);
			}

			// 3. Mirage Mirror (timedLayer1a) copying Mage-Ring Network with 2 storage counters
			{
				const { state, p1, p2 } = setupGame();
				const mirror = putInZone(state, p1, mirrorCard, 'battlefield', { counters: { storage: 2 } });
				const oppMr = putInZone(state, p2, mrCard, 'battlefield');
				giveMana(p1, { C: 2 });
				noteLayerInputsChanged(state);

				const mmAb = getEffectiveActivatedAbilities(state, p1, mirror)[0]!;
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: mirror.instanceId,
						abilityId: mmAb.id,
						targets: [{ kind: 'permanent', id: oppMr.instanceId, label: oppMr.card.name }]
					}).ok,
					true
				);
				resolveAllStack(state);

				const tapRes = applyGameAction(state, p1.playerId, {
					type: 'tap_mana',
					instanceId: mirror.instanceId,
					abilityId: 'act_2'
				});
				assert.equal(tapRes.ok, true);
				const prompt = state.pendingPrompts[0];
				assert.ok(prompt && prompt.choice?.kind === 'chooseMode');
				const modeIdx = prompt.choice.modes.findIndex((m) => m.includes('2'));
				assert.ok(modeIdx >= 0);
				const ansRes = applyGameAction(state, p1.playerId, {
					type: 'cost_choice',
					promptId: prompt.id,
					option: modeIdx
				});
				assert.equal(ansRes.ok, true);
				assert.equal(mirror.counters.storage, 0);
				assert.equal(p1.manaPool.C, 2);
			}
		}
	});

	it('handles Track P18a mergedComponents (backup_act:merged_<idx>:) Wave 11 mana abilities & delayed riders under normal play, SplendorKeeper keepManaAbilities, and Mirage Mirror (canonical + cloneRenamed)', () => {
			const realElder = realCard('Faeburrow Elder');
			const realPool = realCard('Reflecting Pool');
			const realGrove = realCard('Thriving Grove');
			const realPit = realCard('Pit of Offerings');
			const realPath = realCard('Path of Ancestry');
			const realMirror = realCard('Mirage Mirror');
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				typeLine: 'Creature — Angel',
				power: '2',
				toughness: '2',
				oracleText: 'Creatures you control lose all abilities except mana abilities.'
			});

			const variants = [
				{
					elder: realElder,
					pool: realPool,
					grove: realGrove,
					pit: realPit,
					path: realPath,
					mirror: realMirror,
					keeper: baseKeeper
				},
				{
					elder: cloneRenamed(realElder, 'Prism Elder'),
					pool: cloneRenamed(realPool, 'Shimmering Basin'),
					grove: cloneRenamed(realGrove, 'Verdant Hollow'),
					pit: cloneRenamed(realPit, 'Vault of Tributes'),
					path: cloneRenamed(realPath, 'Road of Forebears'),
					mirror: cloneRenamed(realMirror, 'Glass Reflection'),
					keeper: cloneRenamed(baseKeeper, 'Radiant Warden')
				}
			];

			for (const v of variants) {
				// 1. Merged Faeburrow Elder (addManaPerColorControlled): normal play, SplendorKeeper, & Mirage Mirror
				for (const withKeeper of [false, true]) {
					const { state, p1 } = setupGame();
					if (withKeeper) putInZone(state, p1, v.keeper, 'battlefield');
					const blueTop = synthCard({
						name: 'Azure Beast',
						manaCost: '{1}{U}',
						cmc: 2,
						colors: ['U'],
						typeLine: 'Creature — Beast',
						power: '3',
						toughness: '3'
					});
					const mut = putInZone(state, p1, blueTop, 'battlefield');
					mut.mergedComponents = [blueTop, v.elder];
					// Add a green permanent so controlled colors = ['U', 'G']
					putInZone(
						state,
						p1,
						synthCard({
							name: 'Green Saproling',
							manaCost: '{G}',
							cmc: 1,
							colors: ['G'],
							typeLine: 'Creature — Saproling',
							power: '1',
							toughness: '1'
						}),
						'battlefield'
					);
					noteLayerInputsChanged(state);

					const abs = getEffectiveActivatedAbilities(state, p1, mut);
					const elderAb = abs.find((a) => a.id === 'backup_act:merged_1:mana_tap');
					assert.ok(elderAb, `Expected backup_act:merged_1:mana_tap (keeper=${withKeeper})`);
					assert.deepEqual([...elderAb.producesMana].sort(), ['G', 'U']);
					assert.equal(elderAb.producesAmount, 2);
					assert.equal(elderAb.manaBundles?.length, 1);

					// tap_mana adds both U and G
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: mut.instanceId,
							abilityId: elderAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
					assert.equal(p1.manaPool.G, 1);

					// Untap and test activate_ability
					mut.tapped = false;
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: mut.instanceId,
							abilityId: elderAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
					assert.equal(p1.manaPool.G, 1);

					// Untap and test autoTap via cast_spell {U}{G}
					mut.tapped = false;
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					const ugSpell = putInZone(
						state,
						p1,
						synthCard({
							name: 'Simic Flash',
							manaCost: '{U}{G}',
							cmc: 2,
							colors: ['U', 'G'],
							typeLine: 'Sorcery',
							oracleText: 'Draw a card.'
						}),
						'hand'
					);
					const castRes = applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: ugSpell.instanceId
					});
					assert.equal(castRes.ok, true, castRes.error ?? '');
					assert.equal(mut.tapped, true, 'autoTap tapped merged Faeburrow Elder');
				}

				// 1b. Mirage Mirror copying mutated Faeburrow Elder under SplendorKeeper
				{
					const { state, p1, p2 } = setupGame();
					putInZone(state, p1, v.keeper, 'battlefield');
					const mirror = putInZone(state, p1, v.mirror, 'battlefield');
					const blueTop = synthCard({
						name: 'Azure Beast',
						manaCost: '{1}{U}',
						cmc: 2,
						colors: ['U'],
						typeLine: 'Creature — Beast',
						power: '3',
						toughness: '3'
					});
					const oppMut = putInZone(state, p2, blueTop, 'battlefield');
					oppMut.mergedComponents = [blueTop, v.elder];
					giveMana(p1, { C: 2 });
					noteLayerInputsChanged(state);
					const mmAb = getEffectiveActivatedAbilities(state, p1, mirror)[0]!;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: mirror.instanceId,
							abilityId: mmAb.id,
							targets: [{ kind: 'permanent', id: oppMut.instanceId, label: oppMut.card.name }]
						}).ok,
						true
					);
					resolveAllStack(state);
					const copyAb = getEffectiveActivatedAbilities(state, p1, mirror).find((a) =>
						a.id.startsWith('backup_act:merged_1:')
					);
					assert.ok(copyAb);
					assert.deepEqual(copyAb.producesMana, ['U']);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: mirror.instanceId,
							abilityId: copyAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
				}

				// 2. Merged Reflecting Pool (controlledLandProducedColors), Thriving Grove (manaOrChosenColor), Pit of Offerings (addManaFromExiledColors)
				for (const withKeeper of [false, true]) {
					const { state, p1 } = setupGame();
					if (withKeeper) putInZone(state, p1, v.keeper, 'battlefield');
					const island = putInZone(
						state,
						p1,
						synthCard({
							name: 'Basic Island',
							manaCost: '',
							cmc: 0,
							typeLine: 'Basic Land — Island',
							oracleText: '({T}: Add {U}.)'
						}),
						'battlefield'
					);
					island.tapped = true; // keep Island tapped so autoTap must use the merged creatures!

					const top = synthCard({
						name: 'Host Elk',
						typeLine: 'Creature — Elk',
						power: '2',
						toughness: '2'
					});

					// A. Merged Reflecting Pool
					const poolMut = putInZone(state, p1, top, 'battlefield');
					poolMut.mergedComponents = [top, v.pool];

					// B. Merged Thriving Grove (chosenColor: 'R')
					const groveMut = putInZone(state, p1, top, 'battlefield');
					groveMut.mergedComponents = [top, v.grove];
					groveMut.chosenColor = 'R';

					// C. Merged Pit of Offerings (linked red exiled card)
					const pitMut = putInZone(state, p1, top, 'battlefield');
					pitMut.mergedComponents = [top, v.pit];
					const exiledRed = putInZone(
						state,
						p1,
						synthCard({
							name: 'Red Exile Card',
							manaCost: '{R}',
							cmc: 1,
							colors: ['R'],
							typeLine: 'Instant'
						}),
						'exile'
					);
					exiledRed.exiledBy = {
						sourceInstanceId: pitMut.instanceId,
						sourceObjectVersion: pitMut.objectVersion ?? 1
					};
					noteLayerInputsChanged(state);

					const poolAb = getEffectiveActivatedAbilities(state, p1, poolMut).find((a) =>
						a.id.startsWith('backup_act:merged_1:')
					);
					assert.ok(poolAb);
					assert.equal(poolAb.producesMana.includes('U'), true);

					const groveAb = getEffectiveActivatedAbilities(state, p1, groveMut).find((a) =>
						a.id.startsWith('backup_act:merged_1:')
					);
					assert.ok(groveAb);
					assert.equal(groveAb.producesMana.includes('G'), true);
					assert.equal(groveAb.producesMana.includes('R'), true);

					const pitAb = getEffectiveActivatedAbilities(state, p1, pitMut).find(
						(a) => a.id.startsWith('backup_act:merged_1:') && a.producesMana.includes('R')
					);
					assert.ok(pitAb);

					// tap_mana each
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: poolMut.instanceId,
							abilityId: poolAb.id,
							preferredColor: 'U'
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: groveMut.instanceId,
							abilityId: groveAb.id,
							preferredColor: 'R'
						}).ok,
						true
					);
					assert.equal(p1.manaPool.R, 1);

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: pitMut.instanceId,
							abilityId: pitAb.id,
							preferredColor: 'R'
						}).ok,
						true
					);
					assert.equal(p1.manaPool.R, 2);

					// Untap and test autoTap cast_spell {U}{G}{R}
					poolMut.tapped = false;
					groveMut.tapped = false;
					pitMut.tapped = false;
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					const temurSpell = putInZone(
						state,
						p1,
						synthCard({
							name: 'Temur Chant',
							manaCost: '{U}{G}{R}',
							cmc: 3,
							colors: ['U', 'G', 'R'],
							typeLine: 'Sorcery',
							oracleText: 'Draw a card.'
						}),
						'hand'
					);
					const castRes = applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: temurSpell.instanceId
					});
					assert.equal(castRes.ok, true, castRes.error ?? '');
					assert.equal(poolMut.tapped, true);
					assert.equal(groveMut.tapped, true);
					assert.equal(pitMut.tapped, true);
				}

				// 3. Merged Path of Ancestry delayed scry mana rider (tap_mana, activate_ability, & autoTap)
				for (const mode of ['tap_mana', 'activate_ability', 'autoTap'] as const) {
					const { state, p1 } = setupGame();
					const cmd = putInZone(
						state,
						p1,
						synthCard({
							name: 'Elf Commander',
							manaCost: '{2}{G}',
							cmc: 3,
							colors: ['G'],
							typeLine: 'Legendary Creature — Elf',
							power: '2',
							toughness: '2'
						}),
						'command',
						{ isCommander: true }
					);
					assert.ok(cmd);
					const top = synthCard({
						name: 'Host Elf',
						typeLine: 'Creature — Elf',
						power: '2',
						toughness: '2'
					});
					const pathMut = putInZone(state, p1, top, 'battlefield');
					pathMut.mergedComponents = [top, v.path];
					noteLayerInputsChanged(state);

					const pathAb = getEffectiveActivatedAbilities(state, p1, pathMut).find(
						(a) => a.id.startsWith('backup_act:merged_1:') && a.isManaAbility
					);
					assert.ok(pathAb);

					const elfCast = putInZone(
						state,
						p1,
						synthCard({
							name: 'Woodland Elf',
							manaCost: '{G}',
							cmc: 1,
							colors: ['G'],
							typeLine: 'Creature — Elf',
							power: '1',
							toughness: '1'
						}),
						'hand'
					);

					if (mode === 'tap_mana') {
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'tap_mana',
								instanceId: pathMut.instanceId,
								abilityId: pathAb.id,
								preferredColor: 'G'
							}).ok,
							true
						);
						assert.equal(p1.manaRiders?.length ?? 0, 1);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: elfCast.instanceId
							}).ok,
							true
						);
					} else if (mode === 'activate_ability') {
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'activate_ability',
								instanceId: pathMut.instanceId,
								abilityId: pathAb.id
							}).ok,
							true
						);
						if (state.pendingPrompts.length > 0 && state.pendingPrompts[0]!.choice?.kind === 'chooseMode') {
							const gIdx = state.pendingPrompts[0]!.choice.modes.indexOf('G');
							answerTopPrompt(state, { kind: 'chooseMode', indices: [Math.max(0, gIdx)] });
						}
						assert.equal(p1.manaRiders?.length ?? 0, 1);
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: elfCast.instanceId
							}).ok,
							true
						);
					} else {
						assert.equal(
							applyGameAction(state, p1.playerId, {
								type: 'cast_spell',
								instanceId: elfCast.instanceId
							}).ok,
							true
						);
						assert.equal(pathMut.tapped, true);
					}
					// Path of Ancestry rider triggered Scry 1 on casting Elf creature!
					assert.equal(
						state.stack.some(
							(s) => s.title.toLowerCase().includes('scry') || s.oracleText?.toLowerCase().includes('scry')
						),
						true,
						`Expected scry trigger on stack for mode=${mode}`
					);
				}
			}
		});

		it('handles Track P12 Backup (backup_act:<id>:), multi-face DFC donor grantFaceIndex=1, Layer 6 granted:, Cauldron, & quoted_eot: Wave 11 mana abilities (canonical + cloneRenamed)', () => {
			const realCauldron = realCard("Agatha's Soul Cauldron");
			const realElder = realCard('Faeburrow Elder');
			const baseKeeper = synthCard({
				name: 'Splendor Keeper',
				typeLine: 'Creature — Angel',
				power: '2',
				toughness: '2',
				oracleText: 'Creatures you control lose all abilities except mana abilities.'
			});
			const baseAura = synthCard({
				name: 'Pool Aura',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nEnchanted creature has "{T}: Add one mana of any color that a land you control could produce." and "{T}: Add {G} or {U}."'
			});
			const baseDfcDonor = synthCard({
				name: 'Dual Face Mentor',
				manaCost: '{1}{R}',
				cmc: 2,
				layout: 'transform',
				typeLine: 'Creature — Human',
				power: '1',
				toughness: '1',
				oracleText: '{T}: Add {R}.\n{2}, {T}: Draw a card.',
				faces: [
					{
						name: 'Dual Face Mentor',
						manaCost: '{1}{R}',
						typeLine: 'Creature — Human',
						oracleText: '{T}: Add {R}.\n{2}, {T}: Draw a card.',
						colors: ['R'],
						power: '1',
						toughness: '1',
						keywords: [],
						imageUrl: ''
					},
					{
						name: 'Awakened Mentor',
						manaCost: '',
						typeLine: 'Creature — Spirit',
						oracleText:
							'Backup 1\n{T}: For each color among permanents you control, add one mana of that color.\n{1}, {T}: You gain 3 life.',
						colors: ['U'],
						power: '2',
						toughness: '2',
						keywords: ['Backup'],
						imageUrl: ''
					}
				]
			});
			const baseBackupBloom = synthCard({
				name: 'Backup Bloom Mentor',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1',
				oracleText:
					"Backup 1\n{T}: For each color among permanents you control, add one mana of that color.\n{T}: Add one mana of any color in your commander's color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1."
			});
			const basePathCreature = synthCard({
				name: 'Ancestral Pilgrim',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Elf',
				power: '1',
				toughness: '1',
				oracleText:
					"{T}: Add one mana of any color in your commander's color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1."
			});

			const variants = [
				{
					cauldron: realCauldron,
					elder: realElder,
					keeper: baseKeeper,
					aura: baseAura,
					dfc: baseDfcDonor,
					backupBloom: baseBackupBloom,
					pathCreature: basePathCreature
				},
				{
					cauldron: cloneRenamed(realCauldron, 'Soul Crucible'),
					elder: cloneRenamed(realElder, 'Grove Elder'),
					keeper: cloneRenamed(baseKeeper, 'Sanctuary Arbiter'),
					aura: cloneRenamed(baseAura, 'Tidal Gift'),
					dfc: cloneRenamed(baseDfcDonor, 'Shifting Preceptor'),
					backupBloom: cloneRenamed(baseBackupBloom, 'Canopy Preceptor'),
					pathCreature: cloneRenamed(basePathCreature, 'Lineage Druid')
				}
			];

			for (const v of variants) {
				// 1. Track P12 Backup Wave 11 mana + Path of Ancestry rider under SplendorKeeper
				{
					const { state, p1 } = setupGame();
					putInZone(
						state,
						p1,
						synthCard({
							name: 'Elf Commander',
							manaCost: '{2}{G}',
							cmc: 3,
							colors: ['G'],
							colorIdentity: ['G'],
							typeLine: 'Legendary Creature — Elf',
							power: '2',
							toughness: '2'
						}),
						'command',
						{ isCommander: true }
					);
					const targetBear = putInZone(
						state,
						p1,
						synthCard({
							name: 'Blue Target',
							manaCost: '{1}{U}',
							cmc: 2,
							colors: ['U'],
							typeLine: 'Creature — Bear',
							power: '2',
							toughness: '2'
						}),
						'battlefield'
					);
					const mentor = putInZone(state, p1, v.backupBloom, 'hand');
					giveMana(p1, { G: 1, C: 1 });
					assert.equal(
						applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mentor.instanceId }).ok,
						true
					);
					for (let g = 0; g < 20 && (state.stack.length > 0 || state.pendingPrompts.length > 0); g++) {
						if (state.pendingPrompts.length > 0) {
							answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [targetBear.instanceId] });
						} else {
							const pr = state.players[state.priorityPlayerIndex]!;
							assert.equal(applyGameAction(state, pr.playerId, { type: 'pass_priority' }).ok, true);
						}
					}
					putInZone(state, p1, v.keeper, 'battlefield');

					const abs = getEffectiveActivatedAbilities(state, p1, targetBear);
					const perColorAb = abs.find(
						(a) => a.id.startsWith('backup_act:') && a.producesMana.includes('U') && a.producesMana.includes('G')
					);
					assert.ok(perColorAb, 'Backup addManaPerColorControlled must report [U, G]');
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: targetBear.instanceId,
							abilityId: perColorAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
					assert.equal(p1.manaPool.G, 1);

					// Untap and test Path-style backup rider
					targetBear.tapped = false;
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					const riderAb = abs.find(
						(a) => a.id.startsWith('backup_act:') && a.id !== perColorAb.id && a.isManaAbility
					);
					assert.ok(riderAb);
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: targetBear.instanceId,
							abilityId: riderAb.id,
							preferredColor: 'G'
						}).ok,
						true
					);
					assert.equal(p1.manaRiders?.length ?? 0, 1);
				}

				// 2. Multi-face DFC donor (faceIndex: 1) preserves grantFaceIndex=1 across mana and non-mana abilities
				{
					const { state, p1 } = setupGame();
					const targetBear = putInZone(
						state,
						p1,
						synthCard({
							name: 'Blue Target',
							manaCost: '{1}{U}',
							cmc: 2,
							colors: ['U'],
							typeLine: 'Creature — Bear',
							power: '2',
							toughness: '2'
						}),
						'battlefield'
					);
					const dfcPerm = putInZone(state, p1, v.dfc, 'battlefield');
					dfcPerm.transformed = true;
					dfcPerm.activeFaceIndex = 1;
					state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
					(state.timedContinuousEffects ??= []).push({
						sourceName: v.dfc.name,
						controllerId: p1.playerId,
						timestamp: state.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: targetBear.instanceId, objectVersion: targetBear.objectVersion ?? 1 }],
						backupGrant: {
							sourceCard: v.dfc,
							faceIndex: 1,
							startAbilityIndex: 1
						}
					});
					noteLayerInputsChanged(state);

					const abs = getEffectiveActivatedAbilities(state, p1, targetBear);
					const manaAb = abs.find((a) => a.id.startsWith('backup_act:') && a.isManaAbility);
					const lifeAb = abs.find((a) => a.id.startsWith('backup_act:') && !a.isManaAbility);
					assert.ok(manaAb && lifeAb);
					assert.equal(manaAb.grantFaceIndex, 1);
					assert.equal(lifeAb.grantFaceIndex, 1);
					assert.deepEqual(manaAb.producesMana, ['U'], 'Must resolve face 1 addManaPerColorControlled, NOT face 0 {R}');

					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: targetBear.instanceId,
							abilityId: manaAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);
					assert.equal(p1.manaPool.R, 0);

					targetBear.tapped = false;
					const handBefore = p1.hand.length;
					const lifeBefore = p1.life;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'activate_ability',
							instanceId: targetBear.instanceId,
							abilityId: lifeAb.id
						}).ok,
						true
					);
					resolveAllStack(state);
					assert.equal(p1.life, lifeBefore + 3, 'Must resolve face 1 gain 3 life, not face 0 draw');
					assert.equal(p1.hand.length, handBefore);
				}

				// 3. Layer 6 granted: (Aura) + Agatha's Soul Cauldron + quoted_eot: under SplendorKeeper
				{
					const { state, p1 } = setupGame();
					putInZone(
						state,
						p1,
						synthCard({
							name: 'Wizard Commander',
							manaCost: '{2}{U}',
							cmc: 3,
							colors: ['U'],
							colorIdentity: ['U'],
							typeLine: 'Legendary Creature — Wizard',
							power: '2',
							toughness: '2'
						}),
						'command',
						{ isCommander: true }
					);
					putInZone(state, p1, v.keeper, 'battlefield');
					putInZone(
						state,
						p1,
						synthCard({
							name: 'Basic Island',
							manaCost: '',
							cmc: 0,
							typeLine: 'Basic Land — Island',
							oracleText: '({T}: Add {U}.)'
						}),
						'battlefield',
						{ tapped: true }
					);
					const targetBear = putInZone(
						state,
						p1,
						synthCard({
							name: 'Blue Target',
							manaCost: '{1}{U}',
							cmc: 2,
							colors: ['U'],
							typeLine: 'Creature — Bear',
							power: '2',
							toughness: '2'
						}),
						'battlefield',
						{ counters: { '+1/+1': 1 } }
					);
					const auraPerm = putInZone(state, p1, v.aura, 'battlefield');
					auraPerm.attachedToId = targetBear.instanceId;

					const cauldron = putInZone(state, p1, v.cauldron, 'battlefield');
					const exElder = putInZone(state, p1, v.elder, 'exile');
					exElder.exiledBy = {
						sourceInstanceId: cauldron.instanceId,
						sourceObjectVersion: cauldron.objectVersion ?? 1
					};
					const exPath = putInZone(state, p1, v.pathCreature, 'exile');
					exPath.exiledBy = {
						sourceInstanceId: cauldron.instanceId,
						sourceObjectVersion: cauldron.objectVersion ?? 1
					};

					state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
					(state.timedContinuousEffects ??= []).push({
						sourceName: 'Quoted Mana Surge',
						controllerId: p1.playerId,
						timestamp: state.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: targetBear.instanceId, objectVersion: targetBear.objectVersion ?? 1 }],
						layer6: {
							grantedAbilityTexts: [
								'{T}: For each color among permanents you control, add one mana of that color.'
							]
						}
					});
					noteLayerInputsChanged(state);

					const abs = getEffectiveActivatedAbilities(state, p1, targetBear);
					const auraPoolAb = abs.find((a) => a.id.startsWith(`granted:${auraPerm.instanceId}:`) && a.producesMana.includes('U') && !a.producesMana.includes('G'));
					const auraOrAb = abs.find((a) => a.id.startsWith(`granted:${auraPerm.instanceId}:`) && a.producesMana.includes('G'));
					const cauldronElderAb = abs.find((a) => a.id.startsWith(`granted:${exElder.instanceId}:`));
					const cauldronPathAb = abs.find((a) => a.id.startsWith(`granted:${exPath.instanceId}:`));
					const quotedAb = abs.find((a) => a.id.startsWith('quoted_eot:'));
					assert.ok(auraPoolAb && auraOrAb && cauldronElderAb && cauldronPathAb && quotedAb);

					assert.equal(auraPoolAb.producesMana.includes('U'), true);
					assert.deepEqual(auraOrAb.producesMana, ['G', 'U']);
					assert.deepEqual(cauldronElderAb.producesMana, ['U']);
					assert.deepEqual(quotedAb.producesMana, ['U']);

					// Tap quoted_eot:
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: targetBear.instanceId,
							abilityId: quotedAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 1);

					// Untap and tap Cauldron Elder
					targetBear.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: targetBear.instanceId,
							abilityId: cauldronElderAb.id
						}).ok,
						true
					);
					assert.equal(p1.manaPool.U, 2);

					// Untap and tap Cauldron Path rider
					targetBear.tapped = false;
					assert.equal(
						applyGameAction(state, p1.playerId, {
							type: 'tap_mana',
							instanceId: targetBear.instanceId,
							abilityId: cauldronPathAb.id,
							preferredColor: 'U'
						}).ok,
						true
					);
					assert.equal(p1.manaRiders?.length ?? 0, 1);

					// Untap and test autoTap cast_spell {U} using Aura pool ability
					targetBear.tapped = false;
					p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
					const uSpell = putInZone(
						state,
						p1,
						synthCard({
							name: 'Opt Synth',
							manaCost: '{U}',
							cmc: 1,
							colors: ['U'],
							typeLine: 'Sorcery',
							oracleText: 'Draw a card.'
						}),
						'hand'
					);
					const castRes = applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: uSpell.instanceId
					});
					assert.equal(castRes.ok, true, castRes.error ?? '');
					assert.equal(targetBear.tapped, true);
				}
			}
		});

		it('handles Bug 2 DFC faceIndex: 1 & quoted_eot: delayed triggers, cross-nested delayed/reflexive triggers, JSON round-trip, and modal labels (canonical + cloneRenamed)', () => {
			const baseDfcDelayed = synthCard({
				name: 'Chronicle Shifter',
				manaCost: '{1}{R}',
				cmc: 2,
				layout: 'transform',
				typeLine: 'Creature — Human',
				power: '1',
				toughness: '1',
				oracleText:
					'Haste\n{T}: You gain 1 life. At the beginning of the next end step, you lose 10 life.',
				faces: [
					{
						name: 'Chronicle Shifter',
						manaCost: '{1}{R}',
						typeLine: 'Creature — Human',
						oracleText:
							'Haste\n{T}: You gain 1 life. At the beginning of the next end step, you lose 10 life.',
						colors: ['R'],
						power: '1',
						toughness: '1',
						keywords: ['Haste'],
						imageUrl: ''
					},
					{
						name: 'Timeless Spirit',
						manaCost: '',
						typeLine: 'Creature — Spirit',
						oracleText:
							'Backup 1\n{T}: You gain 1 life. At the beginning of the next end step, target player loses 5 life.',
						colors: ['U'],
						power: '2',
						toughness: '2',
						keywords: ['Backup'],
						imageUrl: ''
					}
				]
			});
			const baseDfcLayer6 = synthCard({
				name: 'Relic Conduit',
				manaCost: '{2}',
				cmc: 2,
				layout: 'transform',
				typeLine: 'Artifact',
				oracleText:
					'Other creatures you control have "{T}: You gain 1 life. At the beginning of the next end step, you lose 10 life."',
				faces: [
					{
						name: 'Relic Conduit',
						manaCost: '{2}',
						typeLine: 'Artifact',
						oracleText:
							'Other creatures you control have "{T}: You gain 1 life. At the beginning of the next end step, you lose 10 life."',
						colors: [],
						keywords: [],
						imageUrl: ''
					},
					{
						name: 'Awakened Conduit',
						manaCost: '',
						typeLine: 'Artifact',
						oracleText:
							'Other creatures you control have "{T}: You gain 1 life. At the beginning of the next end step, target player loses 5 life."',
						colors: [],
						keywords: [],
						imageUrl: ''
					}
				]
			});
			const baseDfcCross = synthCard({
				name: 'Echoing Twin',
				manaCost: '{2}{U}',
				cmc: 3,
				layout: 'transform',
				typeLine: 'Creature — Illusion',
				power: '2',
				toughness: '2',
				oracleText: 'Flying\n{T}: You gain 2 life.',
				faces: [
					{
						name: 'Echoing Twin',
						manaCost: '{2}{U}',
						typeLine: 'Creature — Illusion',
						oracleText: 'Flying\n{T}: You gain 2 life.',
						colors: ['U'],
						power: '2',
						toughness: '2',
						keywords: ['Flying'],
						imageUrl: ''
					},
					{
						name: 'Echoing Oracle',
						manaCost: '',
						typeLine: 'Creature — Spirit',
						oracleText:
							'Backup 1\n{T}: You may pay {1}. When you do, at the beginning of the next end step, target player loses 5 life.\n{T}: At the beginning of the next end step, you may pay {1}. When you do, target player loses 5 life.',
						colors: ['U'],
						power: '2',
						toughness: '2',
						keywords: ['Backup'],
						imageUrl: ''
					}
				]
			});
			const baseDfcModal = synthCard({
				name: 'Dilemma Weaver',
				manaCost: '{2}{W}',
				cmc: 3,
				layout: 'transform',
				typeLine: 'Creature — Advisor',
				power: '2',
				toughness: '2',
				oracleText:
					'{T}: An opponent chooses one —\n• Draw a card.\n• You lose 4 life.',
				faces: [
					{
						name: 'Dilemma Weaver',
						manaCost: '{2}{W}',
						typeLine: 'Creature — Advisor',
						oracleText:
							'{T}: An opponent chooses one —\n• Draw a card.\n• You lose 4 life.',
						colors: ['W'],
						power: '2',
						toughness: '2',
						keywords: [],
						imageUrl: ''
					},
					{
						name: 'Dilemma Arbiter',
						manaCost: '',
						typeLine: 'Creature — Angel',
						oracleText:
							'Backup 1\n{T}: An opponent chooses one —\n• You gain 7 life.\n• Draw two cards.',
						colors: ['W'],
						power: '3',
						toughness: '3',
						keywords: ['Backup'],
						imageUrl: ''
					}
				]
			});
			const baseBear = synthCard({
				name: 'Silverback Bear',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});

			const variants = [
				{
					dfcDelayed: baseDfcDelayed,
					dfcLayer6: baseDfcLayer6,
					dfcCross: baseDfcCross,
					dfcModal: baseDfcModal,
					bear: baseBear
				},
				{
					dfcDelayed: cloneRenamed(baseDfcDelayed, 'Temporal Herald'),
					dfcLayer6: cloneRenamed(baseDfcLayer6, 'Chrono Astrolabe'),
					dfcCross: cloneRenamed(baseDfcCross, 'Resonant Phantom'),
					dfcModal: cloneRenamed(baseDfcModal, 'Choice Arbiter'),
					bear: cloneRenamed(baseBear, 'Timber Bruin')
				}
			];

			const plainsCard = synthCard({
				name: 'Test Plains',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Plains',
				oracleText: '({T}: Add {W}.)'
			});

			for (const v of variants) {
				// 1a. DFC faceIndex: 1 backup_act: delayed trigger + JSON round-trip
				{
					let { state, p1, p2 } = setupGame();
					const bear = putInZone(state, p1, v.bear, 'battlefield');
					state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
					(state.timedContinuousEffects ??= []).push({
						sourceName: v.dfcDelayed.name,
						controllerId: p1.playerId,
						timestamp: state.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						backupGrant: {
							sourceCard: v.dfcDelayed,
							faceIndex: 1,
							startAbilityIndex: 1
						}
					});
					noteLayerInputsChanged(state);

					const ab = getEffectiveActivatedAbilities(state, p1, bear).find((a) =>
						a.id.startsWith('backup_act:')
					);
					assert.ok(ab);
					assert.equal(ab.grantFaceIndex, 1);

					const actRes = applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: bear.instanceId,
						abilityId: ab.id,
						targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
					});
					assert.equal(actRes.ok, true, actRes.error ?? '');
					resolveAllStack(state);
					assert.equal(p1.life, 41);
					assert.equal(state.delayedTriggers?.length, 1);
					assert.equal(state.delayedTriggers?.[0]?.delayedEffect?.kind, 'compiledDelayed');
					if (state.delayedTriggers?.[0]?.delayedEffect?.kind === 'compiledDelayed') {
						assert.equal(state.delayedTriggers[0].delayedEffect.grantFaceIndex, 1);
					}

					state = JSON.parse(JSON.stringify(state)) as GameState;
					p1 = state.players[0]!;
					p2 = state.players[1]!;
					passUntilPhase(state, 'end_step');
					assert.equal(p1.life, 41);
					assert.equal(p2.life, 35);
				}

				// 1b. Transformed DFC (activeFaceIndex: 1) Layer 6 granted: delayed trigger + JSON round-trip
				{
					let { state, p1, p2 } = setupGame();
					const conduit = putInZone(state, p1, v.dfcLayer6, 'battlefield');
					conduit.transformed = true;
					conduit.activeFaceIndex = 1;
					noteLayerInputsChanged(state);
					const bear = putInZone(state, p1, v.bear, 'battlefield');

					const ab = getEffectiveActivatedAbilities(state, p1, bear).find((a) =>
						a.id.startsWith(`granted:${conduit.instanceId}:`)
					);
					assert.ok(ab);
					assert.equal(ab.grantFaceIndex, 1);

					const actRes = applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: bear.instanceId,
						abilityId: ab.id,
						targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
					});
					assert.equal(actRes.ok, true, actRes.error ?? '');
					resolveAllStack(state);
					assert.equal(p1.life, 41);
					assert.equal(state.delayedTriggers?.length, 1);
					if (state.delayedTriggers?.[0]?.delayedEffect?.kind === 'compiledDelayed') {
						assert.equal(state.delayedTriggers[0].delayedEffect.grantFaceIndex, 1);
					}

					state = JSON.parse(JSON.stringify(state)) as GameState;
					p1 = state.players[0]!;
					p2 = state.players[1]!;
					passUntilPhase(state, 'end_step');
					assert.equal(p1.life, 41);
					assert.equal(p2.life, 35);
				}

				// 2. quoted_eot: (grantedAbilityText) delayed trigger + JSON round-trip
				{
					let { state, p1, p2 } = setupGame();
					const bear = putInZone(state, p1, v.bear, 'battlefield');
					state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
					(state.timedContinuousEffects ??= []).push({
						sourceName: 'Quoted Delayed Surge',
						controllerId: p1.playerId,
						timestamp: state.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						layer6: {
							grantedAbilityTexts: [
								'{T}: You gain 1 life. At the beginning of the next end step, target player loses 5 life.'
							]
						}
					});
					noteLayerInputsChanged(state);

					const quotedAb = getEffectiveActivatedAbilities(state, p1, bear).find((a) =>
						a.id.startsWith('quoted_eot:')
					);
					assert.ok(quotedAb?.grantedAbilityText);

					const actRes = applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: bear.instanceId,
						abilityId: quotedAb.id,
						targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
					});
					assert.equal(actRes.ok, true, actRes.error ?? '');
					resolveAllStack(state);
					assert.equal(p1.life, 41);
					assert.equal(state.delayedTriggers?.length, 1);
					if (state.delayedTriggers?.[0]?.delayedEffect?.kind === 'compiledDelayed') {
						assert.ok(state.delayedTriggers[0].delayedEffect.grantedAbilityText);
					}

					state = JSON.parse(JSON.stringify(state)) as GameState;
					p1 = state.players[0]!;
					p2 = state.players[1]!;
					passUntilPhase(state, 'end_step');
					assert.equal(p1.life, 41);
					assert.equal(p2.life, 35);
				}

				// 3a. Cross-nested Delayed inside Reflexive (quoted_eot: & DFC faceIndex: 1 backup_act:)
				for (const useQuoted of [true, false]) {
					let { state, p1, p2 } = setupGame();
					const bear = putInZone(state, p1, v.bear, 'battlefield');
					putInZone(state, p1, plainsCard, 'battlefield');
					state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
					(state.timedContinuousEffects ??= []).push({
						sourceName: useQuoted ? 'Quoted Reflexive Delayed' : v.dfcCross.name,
						controllerId: p1.playerId,
						timestamp: state.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						...(useQuoted
							? {
									layer6: {
										grantedAbilityTexts: [
											'{T}: You may pay {1}. When you do, at the beginning of the next end step, target player loses 5 life.'
										]
									}
								}
							: {
									backupGrant: {
										sourceCard: v.dfcCross,
										faceIndex: 1,
										startAbilityIndex: 1
									}
								})
					});
					noteLayerInputsChanged(state);

					const abs = getEffectiveActivatedAbilities(state, p1, bear);
					const ab = useQuoted
						? abs.find((a) => a.id.startsWith('quoted_eot:'))
						: abs.find((a) => a.id.startsWith('backup_act:') && a.id.endsWith(':act_1'));
					assert.ok(ab);

					const actRes = applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: bear.instanceId,
						abilityId: ab.id,
						targets: []
					});
					assert.equal(actRes.ok, true, actRes.error ?? '');
					resolveAllStack(state);
					assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');
					answerTopPrompt(state, { kind: 'yesNo', yes: true });
					// Reflexive trigger enters stack and prompts for target player
					if ((state.pendingPrompts[0]?.kind as string | undefined) === 'chooseObjects') {
						answerTopPrompt(state, {
							kind: 'chooseObjects',
							objectIds: [p2.playerId]
						});
					}
					resolveAllStack(state);
					assert.equal(state.delayedTriggers?.length, 1);
					const dtEff = state.delayedTriggers?.[0]?.delayedEffect;
					assert.equal(dtEff?.kind, 'compiledDelayed');
					if (dtEff?.kind === 'compiledDelayed') {
						assert.equal(dtEff.stepPath.length, 2);
						if (useQuoted) assert.ok(dtEff.grantedAbilityText);
						else assert.equal(dtEff.grantFaceIndex, 1);
					}

					state = JSON.parse(JSON.stringify(state)) as GameState;
					p2 = state.players[1]!;
					passUntilPhase(state, 'end_step');
					assert.equal(p2.life, 35);
				}

				// 3b. Cross-nested Reflexive inside Delayed (quoted_eot: & DFC faceIndex: 1 backup_act:)
				for (const useQuoted of [true, false]) {
					let { state, p1, p2 } = setupGame();
					const bear = putInZone(state, p1, v.bear, 'battlefield');
					putInZone(state, p1, plainsCard, 'battlefield');
					state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
					(state.timedContinuousEffects ??= []).push({
						sourceName: useQuoted ? 'Quoted Delayed Reflexive' : v.dfcCross.name,
						controllerId: p1.playerId,
						timestamp: state.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						...(useQuoted
							? {
									layer6: {
										grantedAbilityTexts: [
											'{T}: At the beginning of the next end step, you may pay {1}. When you do, target player loses 5 life.'
										]
									}
								}
							: {
									backupGrant: {
										sourceCard: v.dfcCross,
										faceIndex: 1,
										startAbilityIndex: 1
									}
								})
					});
					noteLayerInputsChanged(state);

					const abs = getEffectiveActivatedAbilities(state, p1, bear);
					const ab = useQuoted
						? abs.find((a) => a.id.startsWith('quoted_eot:'))
						: abs.find((a) => a.id.startsWith('backup_act:') && a.id.endsWith(':act_2'));
					assert.ok(ab);

					const actRes = applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: bear.instanceId,
						abilityId: ab.id,
						targets: []
					});
					assert.equal(actRes.ok, true, actRes.error ?? '');
					resolveAllStack(state);
					assert.equal(state.delayedTriggers?.length, 1);

					state = JSON.parse(JSON.stringify(state)) as GameState;
					p2 = state.players[1]!;
					passUntilPhase(state, 'end_step');
					assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');
					answerTopPrompt(state, { kind: 'yesNo', yes: true });
					if ((state.pendingPrompts[0]?.kind as string | undefined) === 'chooseObjects') {
						answerTopPrompt(state, {
							kind: 'chooseObjects',
							objectIds: [p2.playerId]
						});
					}
					resolveAllStack(state);
					assert.equal(p2.life, 35);
				}

				// 4. Modal labels: DFC faceIndex: 1 opponentChooses + describeModalModes with grantedAbilityText
				{
					const { state, p1, p2 } = setupGame({ p2Bot: false });
					const bear = putInZone(state, p1, v.bear, 'battlefield');
					state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
					(state.timedContinuousEffects ??= []).push({
						sourceName: v.dfcModal.name,
						controllerId: p1.playerId,
						timestamp: state.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear.instanceId, objectVersion: bear.objectVersion ?? 1 }],
						backupGrant: {
							sourceCard: v.dfcModal,
							faceIndex: 1,
							startAbilityIndex: 1
						}
					});
					noteLayerInputsChanged(state);

					const modalAb = getEffectiveActivatedAbilities(state, p1, bear).find((a) =>
						a.id.startsWith('backup_act:')
					);
					assert.ok(modalAb?.modal);
					assert.equal(modalAb.grantFaceIndex, 1);

					const actRes = applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: bear.instanceId,
						abilityId: modalAb.id,
						targets: []
					});
					assert.equal(actRes.ok, true, actRes.error ?? '');
					resolveAllStack(state);

					const prm = state.pendingPrompts[0];
					assert.ok(prm && prm.choice?.kind === 'chooseMode');
					assert.equal(prm.playerId, p2.playerId);
					if (prm.choice?.kind === 'chooseMode') {
						assert.deepEqual(prm.choice.modes, ['You gain 7 life.', 'Draw two cards.']);
					}

					answerTopPrompt(state, { kind: 'chooseMode', indices: [0] });
					resolveAllStack(state);
					assert.equal(p1.life, 47);

					// Direct describeModalModes with grantedAbilityText
					const quotedModalText =
						'{T}: An opponent chooses one —\n• You gain 7 life.\n• Draw two cards.';
					const { state: s2, p1: p1b } = setupGame();
					const bear2 = putInZone(s2, p1b, v.bear, 'battlefield');
					s2.nextTimestamp = (s2.nextTimestamp ?? 1) + 1;
					(s2.timedContinuousEffects ??= []).push({
						sourceName: 'Quoted Modal Surge',
						controllerId: p1b.playerId,
						timestamp: s2.nextTimestamp,
						expires: 'endOfTurn',
						affected: [{ instanceId: bear2.instanceId, objectVersion: bear2.objectVersion ?? 1 }],
						layer6: { grantedAbilityTexts: [quotedModalText] }
					});
					noteLayerInputsChanged(s2);
					const qModalAb = getEffectiveActivatedAbilities(s2, p1b, bear2).find((a) =>
						a.id.startsWith('quoted_eot:')
					);
					assert.ok(qModalAb?.modal);
					assert.deepEqual(
						describeModalModes(bear2.card, qModalAb.modal, 0, quotedModalText),
						['You gain 7 life.', 'Draw two cards.']
					);
				}
			}
		});

	it('preserves reflexiveTrigger.targets (multi-target and filter.zone) inside compiledDelayed triggers (canonical + cloneRenamed)', () => {
		const baseTwoTarget = synthCard({
			name: 'Chronicle Broker',
			manaCost: '{1}{U}',
			cmc: 2,
			colors: ['U'],
			typeLine: 'Creature — Human Wizard',
			power: '1',
			toughness: '3',
			oracleText:
				'{T}: You may pay {1}. When you do, at the beginning of the next end step, target player draws a card and target opponent loses 3 life.'
		});
		const baseGyCopy = synthCard({
			name: 'Echoing Necromancer',
			manaCost: '{2}{B}',
			cmc: 3,
			colors: ['B'],
			typeLine: 'Creature — Zombie Wizard',
			power: '2',
			toughness: '2',
			oracleText:
				"{T}: You may pay {1}. When you do, at the beginning of the next end step, create a token that's a copy of target creature card in your graveyard."
		});
		const baseBear = synthCard({
			name: 'Cinderback Bear',
			manaCost: '{1}{G}',
			cmc: 2,
			colors: ['G'],
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2'
		});
		const plainsCard = synthCard({
			name: 'Test Plains',
			manaCost: '',
			cmc: 0,
			typeLine: 'Basic Land — Plains',
			oracleText: '({T}: Add {W}.)'
		});

		const variants = [
			{ twoTarget: baseTwoTarget, gyCopy: baseGyCopy, bear: baseBear },
			{
				twoTarget: cloneRenamed(baseTwoTarget, 'Temporal Arbiter'),
				gyCopy: cloneRenamed(baseGyCopy, 'Sepulcher Sculptor'),
				bear: cloneRenamed(baseBear, 'Timber Bruin')
			}
		];

		for (const v of variants) {
			// A. 2-target delayed-inside-reflexive: spec[0] (draw -> p1 only), spec[1] (loseLife -> p2)
			{
				let { state, p1, p2 } = setupGame();
				const broker = putInZone(state, p1, v.twoTarget, 'battlefield');
				putInZone(state, p1, plainsCard, 'battlefield');
				const ab = getEffectiveActivatedAbilities(state, p1, broker).find((a) => !a.isManaAbility);
				assert.ok(ab);
				const p1HandBefore = p1.hand.length;
				const p2HandBefore = p2.hand.length;

				const actRes = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: broker.instanceId,
					abilityId: ab.id,
					targets: []
				});
				assert.equal(actRes.ok, true, actRes.error ?? '');
				resolveAllStack(state);
				assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');
				answerTopPrompt(state, { kind: 'yesNo', yes: true });
				if ((state.pendingPrompts[0]?.kind as string | undefined) === 'chooseObjects') {
					answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [p1.playerId] });
				}
				resolveAllStack(state);
				assert.equal(state.delayedTriggers?.length, 1);

				state = JSON.parse(JSON.stringify(state)) as GameState;
				p1 = state.players[0]!;
				p2 = state.players[1]!;
				passUntilPhase(state, 'end_step');
				assert.equal(p1.hand.length, p1HandBefore + 1, 'target[0] (p1) drew 1 card');
				assert.equal(p2.hand.length, p2HandBefore, 'target[1] (p2) did NOT draw a card');
				assert.equal(p2.life, 37, 'target[1] (p2) lost 3 life');
			}

			// B. filter.zone === 'graveyard' delayed-inside-reflexive copyPermanent
			{
				let { state, p1 } = setupGame();
				const necro = putInZone(state, p1, v.gyCopy, 'battlefield');
				const gyBear = putInZone(state, p1, v.bear, 'graveyard');
				putInZone(state, p1, plainsCard, 'battlefield');
				const ab = getEffectiveActivatedAbilities(state, p1, necro).find((a) => !a.isManaAbility);
				assert.ok(ab);

				const actRes = applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: necro.instanceId,
					abilityId: ab.id,
					targets: []
				});
				assert.equal(actRes.ok, true, actRes.error ?? '');
				resolveAllStack(state);
				assert.equal(state.pendingPrompts[0]?.kind, 'yesNo');
				answerTopPrompt(state, { kind: 'yesNo', yes: true });
				if ((state.pendingPrompts[0]?.kind as string | undefined) === 'chooseObjects') {
					answerTopPrompt(state, { kind: 'chooseObjects', objectIds: [gyBear.instanceId] });
				}
				resolveAllStack(state);
				assert.equal(state.delayedTriggers?.length, 1);

				state = JSON.parse(JSON.stringify(state)) as GameState;
				p1 = state.players[0]!;
				passUntilPhase(state, 'end_step');
				const copyTok = p1.battlefield.find((c) => c.isToken && c.card.name === v.bear.name);
				assert.ok(copyTok, 'delayed copyPermanent copied graveyard target via reflexiveTrigger.targets');
			}
		}
	});
});

