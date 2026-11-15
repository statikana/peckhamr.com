import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	addCountersToPermanent,
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	getCastOptions,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { effectiveAbilityManaCost, effectiveSpellManaCost } from './costs.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type EffectiveActivatedAbility,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

let synthSeq = 0;
let nextTestTs = 5000;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p20b_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p20b_${synthSeq}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
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
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(cards: ScryfallCard[], commander?: ScryfallCard): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: 'deck_p20b',
		userId: 'p1',
		name: 'Track P20b Deck',
		description: '',
		commanders: commander ? [commander] : [],
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + (commander ? 1 : 0),
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: 0,
		updatedAt: 0
	};
}

function setupGame(
	opts: {
		p1Bot?: boolean;
		p2Bot?: boolean;
		p1Commander?: ScryfallCard;
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P20b Filler Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(
		Array.from({ length: 30 }, () => filler),
		opts.p1Commander
	);
	const d2 = makeDeck(Array.from({ length: 30 }, () => filler));
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: d1.id,
			deckName: d1.name,
			commanderNames: opts.p1Commander ? [opts.p1Commander.name] : [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: Boolean(opts.p2Bot),
			deckId: d2.id,
			deckName: d2.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const decks = new Map<number, MagicDeck>([
		[0, d1],
		[1, d2]
	]);
	const state = createInitialGameState('P20B_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: 20
	});
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	state.phase = 'main1';
	state.turnNumber = 2;
	for (const p of state.players) {
		p.life = 20;
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	}
	noteLayerInputsChanged(state);
	return {
		state,
		p1: state.players[0],
		p2: state.players[1]
	};
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor, number>>): void {
	for (const [k, v] of Object.entries(pool) as Array<[ManaColor, number]>) {
		player.manaPool[k] += v;
	}
}

function permTarget(inst: CardInstance): TargetRef {
	return { kind: 'permanent', id: inst.instanceId, label: inst.card.name };
}

function playerTarget(player: PlayerGameState): TargetRef {
	return { kind: 'player', id: player.playerId, label: player.username };
}

function putPerm(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	opts: { summoningSick?: boolean; tapped?: boolean } = {}
): CardInstance {
	const inst = createCardInstance(
		card,
		player.playerId,
		'battlefield',
		false,
		false,
		nextTestTs++
	);
	inst.summoningSick = opts.summoningSick ?? false;
	inst.tapped = opts.tapped ?? false;
	player.battlefield.push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	zone: 'hand' | 'graveyard' | 'library' | 'exile',
	card: ScryfallCard
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, nextTestTs++);
	player[zone].push(inst);
	noteLayerInputsChanged(state);
	return inst;
}

function findAbility(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	abilityId?: string
): EffectiveActivatedAbility {
	const list = getEffectiveActivatedAbilities(state, actor, inst);
	const found = abilityId ? list.find((a) => a.id === abilityId) : list[0];
	assert.ok(found, `Expected activated ability ${abilityId ?? '[0]'} on ${inst.card.name}`);
	return found;
}

function resolveAllStack(state: GameState): void {
	for (let guard = 0; guard < 24 && state.stack.length > 0; guard++) {
		if (state.pendingPrompts.length > 0) break;
		const prioPlayer = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prioPlayer.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.error);
	}
}

describe('Wave 7 — Track P20b: Exotic Activated Costs, Strive, Spend Restrictions, Defilers, Traps, Masteries & Pitch Reductions', () => {
	describe('Slice P20b.1 — Variable self/among counter removal, unattach, die-roll, & multi-card costs', () => {
		it('1. Storage-land / Mana-Battery "Remove any number of storage counters from ~" binds exact counter count on mana & stack abilities', () => {
			const { state, p1, p2 } = setupGame();
			const storageLand = synthCard({
				name: 'P20b Storage Cistern',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText:
					'{T}: Put a storage counter on P20b Storage Cistern.\n{T}, Remove any number of storage counters from P20b Storage Cistern: Add X {W}.'
			});
			const reservoir = synthCard({
				name: 'P20b Charge Reservoir',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText:
					'{T}, Remove one or more charge counters from P20b Charge Reservoir: P20b Charge Reservoir deals X damage to target player.'
			});

			const landPerm = putPerm(state, p1, storageLand);
			addCountersToPermanent(state, landPerm, 'storage', 4);
			const manaAbilities = getEffectiveActivatedAbilities(state, p1, landPerm);
			const storageManaAb = manaAbilities.find((a) => a.isManaAbility)!;
			assert.ok(storageManaAb, 'storage mana ability should be compiled');

			// Initiating tap_mana without counterCount opens a chooseMode (0..4 storage counters) prompt
			const step1 = applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: landPerm.instanceId,
				abilityId: storageManaAb.id
			});
			assert.equal(step1.ok, true, step1.error);
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(state.pendingPrompts[0].choice?.kind, 'chooseMode');
			if (state.pendingPrompts[0].choice?.kind === 'chooseMode') {
				assert.equal(state.pendingPrompts[0].choice.modes.length, 5);
			}

			// Choosing index 3 ("Remove 3 storage counters") removes 3 storage counters and adds {W}{W}{W}
			const step2 = applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [3] }
			});
			assert.equal(step2.ok, true, step2.error);
			assert.equal(landPerm.counters.storage ?? 0, 1);
			assert.equal(p1.manaPool.W, 3);

			// "Remove one or more charge counters" requires >= 1 counter and binds xValue/removedCounterCount
			const resPerm = putPerm(state, p1, reservoir);
			const resAb = findAbility(state, p1, resPerm);
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, resPerm, resAb).ok,
				false,
				'cannot remove one or more counters when 0 charge counters are present'
			);
			addCountersToPermanent(state, resPerm, 'charge', 3);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, resPerm, resAb).ok, true);

			const actRes = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: resPerm.instanceId,
				abilityId: resAb.id,
				targets: [playerTarget(p2)],
				costPayment: { counterCount: 2 }
			});
			assert.equal(actRes.ok, true, actRes.error);
			assert.equal(resPerm.counters.charge ?? 0, 1);
			assert.equal(state.stack[0]?.removedCounterCount, 2);
			assert.equal(state.stack[0]?.xValue, 2);
			resolveAllStack(state);
			assert.equal(p2.life, 18);
		});

		it('2. Multi-permanent "Remove three counters from among other artifacts, creatures, and planeswalkers you control" distributes counters & survives JSON round-trip mid-prompt', () => {
			const { state, p1 } = setupGame();
			const dominus = synthCard({
				name: 'P20b Inquiry Sovereign',
				manaCost: '{2}{U}{U}',
				cmc: 4,
				typeLine: 'Legendary Creature — Horror',
				power: '3',
				toughness: '5',
				colors: ['U'],
				oracleText:
					'{1}, Remove three counters from among other artifacts, creatures, and planeswalkers you control: Put an indestructible counter on P20b Inquiry Sovereign.'
			});
			const report = definitionSupportReport(compileCard(dominus));
			assert.equal(report.fullySupported, true, JSON.stringify(report));

			const domPerm = putPerm(state, p1, dominus);
			const relicA = putPerm(
				state,
				p1,
				synthCard({ name: 'P20b Relic A', typeLine: 'Artifact', oracleText: '' })
			);
			const bearB = putPerm(
				state,
				p1,
				synthCard({
					name: 'P20b Bear B',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2',
					oracleText: ''
				})
			);
			// Counters on self must NOT count because filter says "other"
			addCountersToPermanent(state, domPerm, '+1/+1', 5);
			addCountersToPermanent(state, relicA, 'charge', 2);

			const ab = findAbility(state, p1, domPerm);
			giveMana(p1, { C: 1 });
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, domPerm, ab).ok,
				false,
				'only 2 counters on other matching permanents should be insufficient'
			);

			addCountersToPermanent(state, bearB, '+1/+1', 2);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, domPerm, ab).ok, true);

			// Start activation without costPayment -> opens weighted chooseObjects prompt (minWeightSum = 3)
			const r1 = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: domPerm.instanceId,
				abilityId: ab.id
			});
			assert.equal(r1.ok, true, r1.error);
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(state.pendingPrompts[0].choice?.kind, 'chooseObjects');

			// JSON round-trip mid-cost-choice prompt!
			const roundTripped: GameState = JSON.parse(JSON.stringify(state));
			const rtP1 = roundTripped.players[0];
			const rtDom = rtP1.battlefield.find((c) => c.instanceId === domPerm.instanceId)!;
			const rtRelic = rtP1.battlefield.find((c) => c.instanceId === relicA.instanceId)!;
			const rtBear = rtP1.battlefield.find((c) => c.instanceId === bearB.instanceId)!;

			// Picking only rtRelic (2 counters < 3 required) is rejected
			assert.equal(
				applyGameAction(roundTripped, rtP1.playerId, {
					type: 'choice',
					promptId: roundTripped.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [rtRelic.instanceId] }
				}).ok,
				false,
				'selecting only 2 counters when 3 are required must be rejected'
			);

			// Selecting [rtRelic, rtBear] (2 + 2 >= 3) distributes 2 from rtRelic + 1 from rtBear
			const rChoice = applyGameAction(roundTripped, rtP1.playerId, {
				type: 'choice',
				promptId: roundTripped.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [rtRelic.instanceId, rtBear.instanceId] }
			});
			assert.equal(rChoice.ok, true, rChoice.error);

			assert.equal(roundTripped.pendingPrompts.length, 0);
			assert.equal(rtRelic.counters.charge ?? 0, 0);
			assert.equal(rtBear.counters['+1/+1'] ?? 0, 1);
			assert.equal(rtDom.counters['+1/+1'] ?? 0, 5, 'self counters untouched');
			resolveAllStack(roundTripped);
			assert.equal(rtDom.counters.indestructible ?? 0, 1);
		});

		it('3. Unattach ~ (CR 701.3d), compound remove-counter-and-bounce, die-roll cost, sacrifice one or more, & trailing "with <keyword>" tap filter work via applyGameAction', () => {
			const { state, p1, p2 } = setupGame();
			const unattachBlade = synthCard({
				name: 'P20b Seeker Blade',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact — Equipment',
				oracleText:
					'{T}, Unattach P20b Seeker Blade: Destroy target creature.\nEquip {1}'
			});
			const bounceVault = synthCard({
				name: 'P20b Eon Pool',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText:
					"{T}, Remove an eon counter from P20b Eon Pool and return it to its owner's hand: Draw a card."
			});
			const radiantTapper = synthCard({
				name: 'P20b Sky Marshal',
				manaCost: '{3}{W}',
				cmc: 4,
				typeLine: 'Creature — Angel',
				power: '3',
				toughness: '3',
				colors: ['W'],
				keywords: ['Flying'],
				oracleText:
					'Flying\n{T}, Tap another untapped creature you control with flying: Target creature gains flying until end of turn.'
			});
			const dieRoller = synthCard({
				name: 'P20b Dice Relic',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact',
				oracleText: 'Roll a d20: You gain 1 life.'
			});

			assert.equal(definitionSupportReport(compileCard(unattachBlade)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(bounceVault)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(radiantTapper)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(dieRoller)).fullySupported, true);

			const bladePerm = putPerm(state, p1, unattachBlade);
			const wielder = putPerm(
				state,
				p1,
				synthCard({
					name: 'P20b Wielder',
					typeLine: 'Creature — Soldier',
					power: '2',
					toughness: '2'
				})
			);
			const victim = putPerm(
				state,
				p2,
				synthCard({
					name: 'P20b Victim',
					typeLine: 'Creature — Goblin',
					power: '1',
					toughness: '1'
				})
			);

			const unattachAb = getEffectiveActivatedAbilities(state, p1, bladePerm).find(
				(a) => a.costKeyword !== 'equip'
			)!;
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, bladePerm, unattachAb).ok,
				false,
				'CR 701.3d: cannot unattach when not attached'
			);

			// Equip blade onto wielder, then activate {T}, Unattach ~
			const equipAb = getEffectiveActivatedAbilities(state, p1, bladePerm).find(
				(a) => a.costKeyword === 'equip'
			)!;
			giveMana(p1, { C: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: bladePerm.instanceId,
					abilityId: equipAb.id,
					targets: [permTarget(wielder)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(bladePerm.attachedToId, wielder.instanceId);

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: bladePerm.instanceId,
					abilityId: unattachAb.id,
					targets: [permTarget(victim)]
				}).ok,
				true
			);
			assert.equal(bladePerm.attachedToId, null, 'unattached immediately as cost');
			assert.equal(bladePerm.tapped, true);
			resolveAllStack(state);
			assert.equal(p2.battlefield.some((c) => c.instanceId === victim.instanceId), false);

			// Compound remove counter + bounce self
			const vaultPerm = putPerm(state, p1, bounceVault);
			addCountersToPermanent(state, vaultPerm, 'eon', 1);
			putInZone(state, p1, 'library', synthCard({ name: 'P20b Drawn Card' }));
			const vaultAb = findAbility(state, p1, vaultPerm);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: vaultPerm.instanceId,
					abilityId: vaultAb.id
				}).ok,
				true
			);
			assert.equal(p1.hand.some((c) => c.instanceId === vaultPerm.instanceId), true);
			resolveAllStack(state);
			assert.equal(p1.hand.length, 2);

			// Trailing "with flying" tap filter rejects ground creature, accepts flying ally
			const marshalPerm = putPerm(state, p1, radiantTapper);
			const marshalAb = findAbility(state, p1, marshalPerm);
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, marshalPerm, marshalAb).ok,
				false,
				'wielder lacks flying so cannot pay "another untapped creature you control with flying"'
			);
			const hawk = putPerm(
				state,
				p1,
				synthCard({
					name: 'P20b Hawk',
					typeLine: 'Creature — Bird',
					power: '1',
					toughness: '1',
					keywords: ['Flying'],
					oracleText: 'Flying'
				})
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: marshalPerm.instanceId,
					abilityId: marshalAb.id,
					targets: [permTarget(wielder)],
					costPayment: { objects: [[hawk.instanceId]] }
				}).ok,
				true
			);
			assert.equal(hawk.tapped, true);
			resolveAllStack(state);

			// Die-roll cost
			const dicePerm = putPerm(state, p1, dieRoller);
			const diceAb = findAbility(state, p1, dicePerm);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: dicePerm.instanceId,
					abilityId: diceAb.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.life, 21);
		});

		it('4. Multi-card graveyard named exile, total-MV X artifact exile, different-name discard, & shared-color reveal costs enforce constraints', () => {
			const { state, p1 } = setupGame();
			const folio = synthCard({
				name: 'P20b Chromatic Tome',
				manaCost: '{5}',
				cmc: 5,
				typeLine: 'Artifact',
				oracleText:
					'{1}, {T}, Reveal two cards from your hand that share a color: Draw a card.'
			});
			const ormos = synthCard({
				name: 'P20b Archive Sphinx',
				manaCost: '{4}{U}{U}',
				cmc: 6,
				typeLine: 'Creature — Sphinx',
				power: '5',
				toughness: '5',
				colors: ['U'],
				oracleText:
					'{1}, Discard two cards with different names: Put three +1/+1 counters on P20b Archive Sphinx.'
			});
			const foundry = synthCard({
				name: 'P20b Reforge Foundry',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText:
					'{X}, {T}, Exile one or more other artifacts you control with total mana value X: You gain 2 life.'
			});

			assert.equal(definitionSupportReport(compileCard(folio)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(ormos)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(foundry)).fullySupported, true);

			// Shared-color reveal: {R} + {U} fails, {R} + {R/G} succeeds
			const folioPerm = putPerm(state, p1, folio);
			const folioAb = findAbility(state, p1, folioPerm);
			putInZone(state, p1, 'library', synthCard({ name: 'P20b Tome Draw' }));
			const redCard = putInZone(
				state,
				p1,
				'hand',
				synthCard({ name: 'P20b Bolt', colors: ['R'] })
			);
			const blueCard = putInZone(
				state,
				p1,
				'hand',
				synthCard({ name: 'P20b Opt', colors: ['U'] })
			);
			giveMana(p1, { C: 1 });
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, folioPerm, folioAb).ok,
				false,
				'red + blue cards do not share a color'
			);
			const gruulCard = putInZone(
				state,
				p1,
				'hand',
				synthCard({ name: 'P20b Gruul Charm', colors: ['R', 'G'] })
			);
			assert.equal(checkAbilityActivationLegality(state, p1.playerId, folioPerm, folioAb).ok, true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: folioPerm.instanceId,
					abilityId: folioAb.id,
					costPayment: { objects: [[redCard.instanceId, gruulCard.instanceId]] }
				}).ok,
				true
			);
			resolveAllStack(state);

			// Different-name discard: two copies of same name rejected, distinct names accepted
			p1.hand = [];
			const ormosPerm = putPerm(state, p1, ormos);
			const ormosAb = findAbility(state, p1, ormosPerm);
			const dup1 = putInZone(state, p1, 'hand', synthCard({ name: 'P20b Tome Page' }));
			const dup2 = putInZone(state, p1, 'hand', synthCard({ name: 'P20b Tome Page' }));
			giveMana(p1, { C: 1 });
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, ormosPerm, ormosAb).ok,
				false,
				'two identical card names cannot satisfy "different names"'
			);
			const distinct = putInZone(state, p1, 'hand', synthCard({ name: 'P20b Scroll Leaf' }));
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: ormosPerm.instanceId,
					abilityId: ormosAb.id,
					costPayment: { objects: [[dup1.instanceId, distinct.instanceId]] }
				}).ok,
				true
			);
			assert.equal(p1.hand.some((c) => c.instanceId === dup2.instanceId), true);
			resolveAllStack(state);
			assert.equal(ormosPerm.counters['+1/+1'] ?? 0, 3);

			// Total mana value X artifact exile: MV 1 + MV 2 = 3 matches X=3, fails X=2 with both selected
			const foundryPerm = putPerm(state, p1, foundry);
			const foundryAb = findAbility(state, p1, foundryPerm);
			const art1 = putPerm(
				state,
				p1,
				synthCard({ name: 'P20b Cog 1', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' })
			);
			const art2 = putPerm(
				state,
				p1,
				synthCard({ name: 'P20b Cog 2', manaCost: '{2}', cmc: 2, typeLine: 'Artifact' })
			);
			giveMana(p1, { C: 3 });
			assert.equal(
				checkAbilityActivationLegality(state, p1.playerId, foundryPerm, foundryAb).ok,
				true,
				'UI/AI legality check without explicit xValue must find X=1..3 payable'
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: foundryPerm.instanceId,
					abilityId: foundryAb.id,
					xValue: 2,
					costPayment: { objects: [[art1.instanceId, art2.instanceId]] }
				}).ok,
				false,
				'MV 1 + 2 = 3 must be rejected when X=2'
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: foundryPerm.instanceId,
					abilityId: foundryAb.id,
					xValue: 3,
					costPayment: { objects: [[art1.instanceId, art2.instanceId]] }
				}).ok,
				true
			);
			assert.equal(p1.exile.length, 2);
			resolveAllStack(state);
			assert.equal(p1.life, 22);
		});
	});

	describe('Slice P20b.2 — Strive per-target costs & X / mana-source spending restrictions', () => {
		it('5. Strive ("~ costs {2}{R} more to cast for each target beyond the first") scales across 1, 2, and 3 targets via applyGameAction', () => {
			const { state, p1 } = setupGame();
			const striveSpell = synthCard({
				name: 'P20b Rally Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				colors: ['R'],
				oracleText:
					'Strive — P20b Rally Bolt costs {2}{R} more to cast for each target beyond the first.\nPut a +1/+1 counter on any number of target creatures.'
			});
			assert.equal(definitionSupportReport(compileCard(striveSpell)).fullySupported, true);

			const c1 = putPerm(state, p1, synthCard({ name: 'P20b Bear 1', power: '2', toughness: '2' }));
			const c2 = putPerm(state, p1, synthCard({ name: 'P20b Bear 2', power: '2', toughness: '2' }));
			const c3 = putPerm(state, p1, synthCard({ name: 'P20b Bear 3', power: '2', toughness: '2' }));
			const sInst = putInZone(state, p1, 'hand', striveSpell);

			// 1 target -> {R}
			const req1 = effectiveSpellManaCost(state, p1, sInst, 0, undefined, undefined, 0, false, undefined, false, [
				permTarget(c1)
			]);
			assert.equal(req1.generic, 0);
			assert.equal(req1.colored.R, 1);

			// 2 targets -> {2}{R}{R}
			const req2 = effectiveSpellManaCost(state, p1, sInst, 0, undefined, undefined, 0, false, undefined, false, [
				permTarget(c1),
				permTarget(c2)
			]);
			assert.equal(req2.generic, 2);
			assert.equal(req2.colored.R, 2);

			// 3 targets -> {4}{R}{R}{R}
			const req3 = effectiveSpellManaCost(state, p1, sInst, 0, undefined, undefined, 0, false, undefined, false, [
				permTarget(c1),
				permTarget(c2),
				permTarget(c3)
			]);
			assert.equal(req3.generic, 4);
			assert.equal(req3.colored.R, 3);

			// Casting with 3 targets fails when only {2}{R}{R} is available, succeeds with {4}{R}{R}{R}
			giveMana(p1, { C: 2, R: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: sInst.instanceId,
					targets: [permTarget(c1), permTarget(c2), permTarget(c3)]
				}).ok,
				false
			);
			giveMana(p1, { C: 2, R: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: sInst.instanceId,
					targets: [permTarget(c1), permTarget(c2), permTarget(c3)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(c1.counters['+1/+1'], 1);
			assert.equal(c2.counters['+1/+1'], 1);
			assert.equal(c3.counters['+1/+1'], 1);
			assert.equal(p1.manaPool.R, 0);
			assert.equal(p1.manaPool.C, 0);
		});

		it('6. "Spend only black mana on X" rejects non-black mana on X for both spells and activated abilities while allowing non-black generic mana', () => {
			const { state, p1, p2 } = setupGame();
			const drainSpell = synthCard({
				name: 'P20b Consume Essence',
				manaCost: '{X}{1}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				colors: ['B'],
				oracleText:
					'Spend only black mana on X.\nP20b Consume Essence deals X damage to any target and you gain X life.'
			});
			const ratsCard = synthCard({
				name: 'P20b Sewer Rats',
				manaCost: '{2}{B}',
				cmc: 3,
				typeLine: 'Creature — Rat',
				power: '1',
				toughness: '1',
				colors: ['B'],
				oracleText:
					'Spend only black mana on X.\n{X}: P20b Sewer Rats deals X damage to each player.'
			});
			assert.equal(definitionSupportReport(compileCard(drainSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(ratsCard)).fullySupported, true);

			// Spell: {X}{1}{B} with X=3 requires 4 {B} + 1 any. {R}{R}{R}{R}{B} must FAIL!
			const spInst = putInZone(state, p1, 'hand', drainSpell);
			giveMana(p1, { R: 4, B: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: spInst.instanceId,
					xValue: 3,
					targets: [playerTarget(p2)]
				}).ok,
				false,
				'cannot spend {R} mana on X when restricted to black mana'
			);

			// With {R} + {B}{B}{B}{B}, {R} pays {1} and {B}x4 pays {X=3}{B}!
			p1.manaPool = { W: 0, U: 0, B: 4, R: 1, G: 0, C: 0 };
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: spInst.instanceId,
					xValue: 3,
					targets: [playerTarget(p2)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p2.life, 17);
			assert.equal(p1.life, 23);

			// Activated ability: {X} with X=2 rejects {R}{R}, accepts {B}{B}
			const ratsPerm = putPerm(state, p1, ratsCard);
			const ratsAb = findAbility(state, p1, ratsPerm);
			giveMana(p1, { R: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: ratsPerm.instanceId,
					abilityId: ratsAb.id,
					xValue: 2
				}).ok,
				false,
				'activated ability must reject {R}{R} on X=2'
			);
			giveMana(p1, { B: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: ratsPerm.instanceId,
					abilityId: ratsAb.id,
					xValue: 2
				}).ok,
				true
			);
			assert.equal(p1.manaPool.R, 2, 'untouched red mana stays in pool');
			assert.equal(p1.manaPool.B, 0);
			resolveAllStack(state);
			assert.equal(p2.life, 15);
		});

		it('7. Source mana-spending restrictions ("produced by creatures" / "produced by basic lands") enforce provenance on pooled & auto-tapped mana', () => {
			const { state, p1 } = setupGame();
			const superion = synthCard({
				name: 'P20b Alloy Construct',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Construct',
				power: '5',
				toughness: '6',
				oracleText: 'Spend only mana produced by creatures to cast P20b Alloy Construct.'
			});
			const imperiosaur = synthCard({
				name: 'P20b Ancient Saurian',
				manaCost: '{2}{G}{G}',
				cmc: 4,
				typeLine: 'Creature — Dinosaur',
				power: '5',
				toughness: '5',
				colors: ['G'],
				oracleText: 'Spend only mana produced by basic lands to cast P20b Ancient Saurian.'
			});
			assert.equal(definitionSupportReport(compileCard(superion)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(imperiosaur)).fullySupported, true);

			const forestCard = synthCard({
				name: 'P20b Basic Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Land — Forest',
				oracleText: '{T}: Add {G}.'
			});
			const elfCard = synthCard({
				name: 'P20b Mana Elf',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Elf Druid',
				power: '1',
				toughness: '1',
				colors: ['G'],
				oracleText: '{T}: Add {G}.'
			});

			const f1 = putPerm(state, p1, forestCard);
			const f2 = putPerm(state, p1, forestCard);
			const supInst = putInZone(state, p1, 'hand', superion);

			// Basic lands alone CANNOT cast creature-mana-only spell (neither auto-tap nor pooled)
			assert.equal(checkSpellCastLegality(state, p1.playerId, supInst).ok, false);
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: f1.instanceId }).ok,
				true
			);
			assert.equal(
				applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: f2.instanceId }).ok,
				true
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: supInst.instanceId
				}).ok,
				false,
				'basic-land mana in pool cannot pay creature-only mana restriction'
			);

			// Add 2 Mana Elves -> auto-tapping the elves (leaving basic land mana untouched!) succeeds!
			const e1 = putPerm(state, p1, elfCard);
			const e2 = putPerm(state, p1, elfCard);
			assert.equal(checkSpellCastLegality(state, p1.playerId, supInst).ok, true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: supInst.instanceId
				}).ok,
				true
			);
			assert.equal(e1.tapped, true);
			assert.equal(e2.tapped, true);
			assert.equal(p1.manaPool.G, 2, 'non-creature basic-land mana remained unspent in pool');
			resolveAllStack(state);

			// Basic-land-only spell: 2 basic-land {G} in pool + 2 more basic Forests succeeds, whereas elf mana fails
			const saurInst = putInZone(state, p1, 'hand', imperiosaur);
			const e3 = putPerm(state, p1, elfCard);
			const e4 = putPerm(state, p1, elfCard);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: saurInst.instanceId
				}).ok,
				false,
				'2 basic-land {G} + 2 elves cannot satisfy 4 basic-land mana requirement'
			);
			assert.equal(e3.tapped, false);
			assert.equal(e4.tapped, false);
			putPerm(state, p1, forestCard);
			putPerm(state, p1, forestCard);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: saurInst.instanceId
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((c) => c.card.id === imperiosaur.id), true);
		});
	});

	describe('Slice P20b.3 — Defiler cycle, Traps, Strixhaven Masteries, waterbend/behold, March/Torgaar pitch reductions, Forge Anew & Liesa', () => {
		it('8. Defiler cycle optional 2-life payment reduces colored pip {G} by {G} without reducing generic mana', () => {
			const { state, p1 } = setupGame();
			const defiler = synthCard({
				name: 'P20b Vigor Defiler',
				manaCost: '{3}{G}{G}',
				cmc: 5,
				typeLine: 'Creature — Phyrexian Wurms',
				power: '6',
				toughness: '6',
				colors: ['G'],
				oracleText:
					'As an additional cost to cast green permanent spells, you may pay 2 life. Those spells cost {G} less to cast if you paid life this way. This effect reduces only the amount of green mana you pay.'
			});
			assert.equal(definitionSupportReport(compileCard(defiler)).fullySupported, true);
			putPerm(state, p1, defiler);

			const greenBear = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P20b Moss Bear',
					manaCost: '{2}{G}',
					cmc: 3,
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2',
					colors: ['G']
				})
			);

			giveMana(p1, { C: 2 });
			const opts = getCastOptions(state, p1.playerId, greenBear, 'hand');
			const defilerOpt = opts[0]?.optionalAdditionalCosts?.find((o) => o.id.startsWith('defiler:'));
			assert.ok(defilerOpt, 'Defiler optional 2-life cost should appear on green permanent CastOption');

			// Paying 2 life reduces {2}{G} -> {2} (colored {G} becomes 0, generic {2} is NOT reduced to {1}!)
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: greenBear.instanceId,
					optionalCostCounts: { [defilerOpt.id]: 1 }
				}).ok,
				false,
				'{1} generic mana must still be insufficient for {2} after {G} pip reduction'
			);
			giveMana(p1, { C: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: greenBear.instanceId,
					optionalCostCounts: { [defilerOpt.id]: 1 }
				}).ok,
				true
			);
			assert.equal(p1.life, 18, 'paid 2 life via Defiler');
			assert.equal(p1.manaPool.C, 0);
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === greenBear.instanceId), true);
		});

		it('9. Zendikar Traps & Strixhaven Mastery conditional/unconditional alt-costs track opponent actions and altCostPaid branch flag', () => {
			const { state, p1, p2 } = setupGame();
			const summonTrap = synthCard({
				name: 'P20b Ambush Trap',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Instant — Trap',
				colors: ['G'],
				oracleText:
					"If a creature spell you cast this turn was countered by a spell or ability an opponent controlled, you may pay {0} rather than pay P20b Ambush Trap's mana cost.\nYou gain 4 life."
			});
			const mastery = synthCard({
				name: 'P20b Dark Mastery',
				manaCost: '{3}{B}',
				cmc: 4,
				typeLine: 'Instant',
				colors: ['B'],
				oracleText:
					"You may pay {1}{B} rather than pay P20b Dark Mastery's mana cost.\nExile target creature."
			});
			assert.equal(definitionSupportReport(compileCard(summonTrap)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(mastery)).fullySupported, true);

			const trapInst = putInZone(state, p1, 'hand', summonTrap);
			assert.equal(
				getCastOptions(state, p1.playerId, trapInst, 'hand').some(
					(o) => o.baseCost.kind === 'alternative'
				),
				false,
				'Trap {0} alt-cost must be unavailable before creature spell is countered'
			);

			// Cast a creature spell as p1, counter it with p2's counterspell!
			const bearSpell = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P20b Test Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2',
					colors: ['G']
				})
			);
			const counterSpell = putInZone(
				state,
				p2,
				'hand',
				synthCard({
					name: 'P20b Cancel',
					manaCost: '{1}{U}{U}',
					cmc: 3,
					typeLine: 'Instant',
					colors: ['U'],
					oracleText: 'Counter target spell.'
				})
			);
			giveMana(p1, { C: 1, G: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bearSpell.instanceId
				}).ok,
				true
			);
			const bearStackId = state.stack[0].id;
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			giveMana(p2, { C: 1, U: 2 });
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: counterSpell.instanceId,
					targets: [{ kind: 'stack', id: bearStackId, label: bearSpell.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.creatureSpellCounteredByOpponentThisTurn, true);

			// Now Trap {0} alt-cost is unlocked!
			const trapOpts = getCastOptions(state, p1.playerId, trapInst, 'hand');
			const freeTrapOpt = trapOpts.find((o) => o.baseCost.kind === 'alternative')!;
			assert.ok(freeTrapOpt, 'Trap {0} option should now be available');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: trapInst.instanceId,
					optionId: freeTrapOpt.id
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.life, 24);

			// Strixhaven Mastery: {1}{B} alt-cost stamps altCostManaPaid='{1}{B}' on stack item
			const mastInst = putInZone(state, p1, 'hand', mastery);
			const p2Bear = putPerm(
				state,
				p2,
				synthCard({ name: 'P20b Target Bear', power: '2', toughness: '2' })
			);
			giveMana(p1, { C: 1, B: 1 });
			const mastAltOpt = getCastOptions(state, p1.playerId, mastInst, 'hand').find(
				(o) => o.baseCost.kind === 'alternative'
			)!;
			assert.ok(mastAltOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: mastInst.instanceId,
					optionId: mastAltOpt.id,
					targets: [permTarget(p2Bear)]
				}).ok,
				true
			);
			assert.equal(state.stack[0]?.altCostManaPaid, '{1}{B}');
			resolveAllStack(state);
			assert.equal(p2.exile.some((c) => c.instanceId === p2Bear.instanceId), true);
		});

		it('10. Waterbend, Behold [and exile it], & optional Blight additional spell costs pay cleanly via applyGameAction', () => {
			const { state, p1, p2 } = setupGame();
			const waterSpell = synthCard({
				name: 'P20b Swamp Visions',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Sorcery',
				colors: ['U'],
				oracleText: 'As an additional cost to cast P20b Swamp Visions, waterbend {3}.\nDraw two cards.'
			});
			const beholdExileSpell = synthCard({
				name: 'P20b Dragon Breath',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Instant',
				colors: ['W'],
				oracleText:
					'As an additional cost to cast P20b Dragon Breath, behold a Dragon and exile it.\nYou gain 3 life.'
			});
			const optBlightSpell = synthCard({
				name: 'P20b Cinder Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				colors: ['R'],
				oracleText:
					'As an additional cost to cast P20b Cinder Bolt, you may blight 1.\nP20b Cinder Bolt deals 2 damage to any target.'
			});

			assert.equal(definitionSupportReport(compileCard(waterSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(beholdExileSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(optBlightSpell)).fullySupported, true);

			// Waterbend {3}: tap 1 artifact + 1 creature you control + pay {1} mana alongside {1}{U} spell cost!
			putInZone(state, p1, 'library', synthCard({ name: 'P20b Draw 1' }));
			putInZone(state, p1, 'library', synthCard({ name: 'P20b Draw 2' }));
			const wInst = putInZone(state, p1, 'hand', waterSpell);
			const clue = putPerm(state, p1, synthCard({ name: 'P20b Clue', typeLine: 'Artifact' }));
			const otter = putPerm(
				state,
				p1,
				synthCard({ name: 'P20b Otter', typeLine: 'Creature — Otter', power: '2', toughness: '2' })
			);
			giveMana(p1, { C: 2, U: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: wInst.instanceId,
					costPayment: { objects: [[clue.instanceId, otter.instanceId]] }
				}).ok,
				true
			);
			assert.equal(clue.tapped, true);
			assert.equal(otter.tapped, true);
			assert.equal(p1.manaPool.C, 0);
			assert.equal(p1.manaPool.U, 0);
			resolveAllStack(state);
			assert.equal(p1.hand.length, 2);

			// Behold a Dragon and exile it: exiles Dragon card from hand!
			const bInst = putInZone(state, p1, 'hand', beholdExileSpell);
			const handDragon = putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P20b Hand Dragon',
					typeLine: 'Creature — Dragon',
					power: '4',
					toughness: '4'
				})
			);
			giveMana(p1, { C: 1, W: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bInst.instanceId,
					costPayment: { objects: [[handDragon.instanceId]] }
				}).ok,
				true
			);
			assert.equal(p1.exile.some((c) => c.instanceId === handDragon.instanceId), true);
			resolveAllStack(state);
			assert.equal(p1.life, 23);

			// Optional blight 1: accepting puts -1/-1 counter on controlled creature and sets additionalCostPaid=true
			const blInst = putInZone(state, p1, 'hand', optBlightSpell);
			giveMana(p1, { R: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: blInst.instanceId,
					targets: [playerTarget(p2)],
					costPayment: { options: [0], objects: [[otter.instanceId]] }
				}).ok,
				true
			);
			assert.equal(otter.counters['-1/-1'], 1);
			assert.equal(state.stack[0]?.additionalCostPaid, true);
			resolveAllStack(state);
			assert.equal(p2.life, 18);
		});

		it('11. Kamigawa March hand-exile & Torgaar creature-sacrifice variable self cost reductions reduce generic mana by {2} per card/creature', () => {
			const { state, p1, p2 } = setupGame();
			const march = synthCard({
				name: 'P20b Radiant March',
				manaCost: '{X}{W}',
				cmc: 1,
				typeLine: 'Instant',
				colors: ['W'],
				oracleText:
					'As an additional cost to cast this spell, you may exile any number of white cards from your hand. This spell costs {2} less to cast for each card exiled this way.\nExile target artifact, creature, or enchantment with mana value X or less.'
			});
			const torgaar = synthCard({
				name: 'P20b Famine Avatar',
				manaCost: '{6}{B}{B}',
				cmc: 8,
				typeLine: 'Legendary Creature — Avatar',
				power: '7',
				toughness: '6',
				colors: ['B'],
				oracleText:
					'As an additional cost to cast this spell, you may sacrifice any number of creatures. This spell costs {2} less to cast for each creature sacrificed this way.'
			});
			assert.equal(definitionSupportReport(compileCard(march)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(torgaar)).fullySupported, true);

			// March with X=4 ({4}{W}) + 2 white cards in hand + only {W} mana in pool:
			const mInst = putInZone(state, p1, 'hand', march);
			const w1 = putInZone(state, p1, 'hand', synthCard({ name: 'P20b White 1', colors: ['W'] }));
			const w2 = putInZone(state, p1, 'hand', synthCard({ name: 'P20b White 2', colors: ['W'] }));
			const mv4Target = putPerm(
				state,
				p2,
				synthCard({ name: 'P20b Golem', manaCost: '{4}', cmc: 4, typeLine: 'Artifact Creature — Golem', power: '4', toughness: '4' })
			);
			giveMana(p1, { W: 1 });

			// Declining the optional exile (`options: [1]`) fails because {4}{W} > {W}!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: mInst.instanceId,
					xValue: 4,
					targets: [permTarget(mv4Target)],
					costPayment: { options: [1] }
				}).ok,
				false,
				'declining pitch exile must charge full {4}{W}'
			);

			// Exiling 2 white cards (`options: [0], objects: [[w1, w2]]`) reduces {4}{W} -> {W} and succeeds!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: mInst.instanceId,
					xValue: 4,
					targets: [permTarget(mv4Target)],
					costPayment: { options: [0], objects: [[w1.instanceId, w2.instanceId]] }
				}).ok,
				true
			);
			assert.equal(p1.exile.length, 2);
			assert.equal(p1.manaPool.W, 0);
			resolveAllStack(state);
			assert.equal(p2.exile.some((c) => c.instanceId === mv4Target.instanceId), true);

			// Torgaar: {6}{B}{B} with 3 creatures sacrificed costs {B}{B}
			const tInst = putInZone(state, p1, 'hand', torgaar);
			const tok1 = putPerm(state, p1, synthCard({ name: 'P20b Thrull 1', power: '1', toughness: '1' }));
			const tok2 = putPerm(state, p1, synthCard({ name: 'P20b Thrull 2', power: '1', toughness: '1' }));
			const tok3 = putPerm(state, p1, synthCard({ name: 'P20b Thrull 3', power: '1', toughness: '1' }));
			giveMana(p1, { B: 2 });
			assert.equal(checkSpellCastLegality(state, p1.playerId, tInst).ok, true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: tInst.instanceId,
					costPayment: {
						options: [0],
						objects: [[tok1.instanceId, tok2.instanceId, tok3.instanceId]]
					}
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === tInst.instanceId), true);
			assert.equal(
				p1.graveyard.filter((c) => c.card.typeLine.includes('Creature')).length,
				3
			);
			assert.equal(p1.graveyard.length, 4);
		});

		it('12. Forge Anew first-equip-{0}, Liesa commander-tax-as-life, & synthetic card rename-invariance', () => {
			const liesaCmd = synthCard({
				name: 'P20b Dusk Angel',
				manaCost: '{2}{W}{B}',
				cmc: 4,
				typeLine: 'Legendary Creature — Angel',
				power: '5',
				toughness: '5',
				colors: ['W', 'B'],
				oracleText:
					"Rather than pay {2} for each previous time you've cast P20b Dusk Angel from the command zone this game, pay 2 life that many times.\nFlying"
			});
			const forgeCard = synthCard({
				name: 'P20b Reforged Armory',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				colors: ['W'],
				oracleText:
					'You may pay {0} rather than pay the equip cost of the first equip ability you activate during each of your turns.'
			});
			const heavyHammer = synthCard({
				name: 'P20b Colossal Hammer',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +3/+3.\nEquip {5}'
			});

			assert.equal(definitionSupportReport(compileCard(liesaCmd)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(forgeCard)).fullySupported, true);

			// Rename-invariance check: renaming synthetic cards produces structurally identical IR (modulo spans)
			const stripSpans = (v: unknown): unknown => {
				if (Array.isArray(v)) return v.map(stripSpans);
				if (v && typeof v === 'object') {
					const out: Record<string, unknown> = {};
					for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
						if (k === 'span' || k === 'text') continue;
						out[k] = stripSpans(val);
					}
					return out;
				}
				return v;
			};
			const renamedLiesa = synthCard({
				...liesaCmd,
				name: 'Zzzyx Arbitrary Archon',
				oracleText: liesaCmd.oracleText.replace(/P20b Dusk Angel/g, 'Zzzyx Arbitrary Archon')
			});
			assert.deepEqual(
				stripSpans(compileCard(liesaCmd).faces[0].abilities),
				stripSpans(compileCard(renamedLiesa).faces[0].abilities),
				'compiled IR must be 100% invariant to card name'
			);

			const { state, p1 } = setupGame({ p1Commander: liesaCmd });
			putPerm(state, p1, forgeCard);
			const hammerPerm = putPerm(state, p1, heavyHammer);
			const squireA = putPerm(state, p1, synthCard({ name: 'P20b Squire A', power: '1', toughness: '1' }));
			const squireB = putPerm(state, p1, synthCard({ name: 'P20b Squire B', power: '1', toughness: '1' }));
			const equipAb = findAbility(state, p1, hammerPerm);

			// First equip this turn costs {0} instead of {5}!
			assert.equal(equipAb.manaCost, '{0}');
			assert.equal(
				effectiveAbilityManaCost(
					state,
					p1.playerId,
					equipAb.id,
					'{5}',
					equipAb.costKeyword,
					0,
					hammerPerm
				).manaCost,
				'{0}'
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: hammerPerm.instanceId,
					abilityId: equipAb.id,
					targets: [permTarget(squireA)]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(hammerPerm.attachedToId, squireA.instanceId);

			// Second equip this turn reverts to {5}!
			assert.equal(findAbility(state, p1, hammerPerm).manaCost, '{5}');
			assert.equal(
				effectiveAbilityManaCost(
					state,
					p1.playerId,
					equipAb.id,
					'{5}',
					equipAb.costKeyword,
					0,
					hammerPerm
				).manaCost,
				'{5}'
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: hammerPerm.instanceId,
					abilityId: equipAb.id,
					targets: [permTarget(squireB)]
				}).ok,
				false
			);

			// Commander tax as life: simulate 2 previous casts from command zone -> 4 life instead of {4} mana!
			const cmdInst = p1.command[0]!;
			assert.ok(cmdInst, 'commander must start in command zone');
			cmdInst.commanderCastCount = 2;
			p1.commanderCastCounts = { [cmdInst.instanceId]: 2 };

			giveMana(p1, { C: 2, W: 1, B: 1 });
			assert.equal(checkSpellCastLegality(state, p1.playerId, cmdInst).ok, true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: cmdInst.instanceId
				}).ok,
				true
			);
			assert.equal(p1.life, 16, 'paid 4 life instead of {4} commander tax');
			resolveAllStack(state);
			assert.equal(p1.battlefield.some((c) => c.instanceId === cmdInst.instanceId), true);
		});
	});
});
