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
	type CounterType,
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
let nextTestTs = 1000;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p17b_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p17b_${synthSeq}`,
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
		id: 'deck_p17b',
		userId: 'p1',
		name: 'Track P17b Deck',
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
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P17b Filler Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const d1 = makeDeck(Array.from({ length: 30 }, () => filler));
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
			commanderNames: [],
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
	const state = createInitialGameState('P17B_TEST', seats, decks, {
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

function stackTarget(stackId: string, label: string): TargetRef {
	return { kind: 'stack', id: stackId, label };
}

function spellCostStr(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	chosenTargets?: TargetRef[]
): string {
	const req = effectiveSpellManaCost(
		state,
		player,
		inst,
		0,
		undefined,
		undefined,
		0,
		false,
		undefined,
		false,
		chosenTargets
	);
	let out = req.generic > 0 ? `{${req.generic}}` : '';
	for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
		for (let i = 0; i < (req.colored[c] ?? 0); i++) out += `{${c}}`;
	}
	return out || '{0}';
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
	for (let guard = 0; guard < 50; guard++) {
		if (state.stack.length === 0 || state.pendingPrompts.length > 0) break;
		const pr = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, pr.playerId, { type: 'pass_priority' });
		if (!res.ok) break;
	}
}

describe('Track P17b — Costs Wave 6 End-to-End Compiler & Runtime Suite', () => {
	describe('1. Generalized Spell & Activated-Ability Cost Modifiers (CR 601.2f, CR 118.7)', () => {
		it('applies conditional spell-cast history reductions and dynamic where-X-is flying-power reductions', () => {
			const { state, p1 } = setupGame();

			const cantrip = synthCard({
				name: 'P17b Spark Cantrip',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: 'Draw a card.'
			});
			const surgeBolt = synthCard({
				name: 'P17b Surge Bolt',
				manaCost: '{3}{R}',
				cmc: 4,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText:
					"This spell costs {3} less to cast if you've cast another instant or sorcery spell this turn.\nDraw a card."
			});
			const skyTitan = synthCard({
				name: 'P17b Sky Titan',
				manaCost: '{6}{U}{U}',
				cmc: 8,
				colors: ['U'],
				typeLine: 'Creature — Giant',
				power: '5',
				toughness: '5',
				oracleText:
					'This spell costs {X} less to cast, where X is the total power of creatures you control with flying.'
			});

			assert.equal(definitionSupportReport(compileCard(surgeBolt)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(skyTitan)).fullySupported, true);

			putInZone(state, p1, 'library', cantrip);
			putInZone(state, p1, 'library', cantrip);
			const boltHand = putInZone(state, p1, 'hand', surgeBolt);
			assert.equal(spellCostStr(state, p1, boltHand), '{3}{R}');

			// Cast an instant first -> surgeBolt now costs {R}
			const cantripHand = putInZone(state, p1, 'hand', cantrip);
			giveMana(p1, { R: 2 });
			const cRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cantripHand.instanceId
			});
			assert.equal(cRes.ok, true, cRes.error ?? '');
			resolveAllStack(state);

			assert.equal(spellCostStr(state, p1, boltHand), '{R}');
			const bRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boltHand.instanceId
			});
			assert.equal(bRes.ok, true, bRes.error ?? '');
			assert.equal(p1.manaPool.R, 0);
			resolveAllStack(state);

			// Flying total power reduction: 2/2 flyer + 3/1 flyer = 5 total power -> {6}{U}{U} becomes {1}{U}{U}
			putPerm(
				state,
				p1,
				synthCard({
					name: 'P17b Wind Drake',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Creature — Drake',
					power: '2',
					toughness: '2',
					keywords: ['Flying'],
					oracleText: 'Flying'
				})
			);
			putPerm(
				state,
				p1,
				synthCard({
					name: 'P17b Cloud Aven',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Creature — Bird',
					power: '3',
					toughness: '1',
					keywords: ['Flying'],
					oracleText: 'Flying'
				})
			);
			putPerm(
				state,
				p1,
				synthCard({
					name: 'P17b Ground Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					power: '4',
					toughness: '4'
				})
			);
			const titanHand = putInZone(state, p1, 'hand', skyTitan);
			assert.equal(spellCostStr(state, p1, titanHand), '{1}{U}{U}');
		});

		it('enforces CR 118.7 minimum-1-mana floor and maxReduction caps on spells and activated abilities', () => {
			const { state, p1 } = setupGame();

			const spellReducer = synthCard({
				name: 'P17b Arcane Familiar',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '3',
				oracleText:
					"Artifact spells you cast cost {2} less to cast. This effect can't reduce the mana in that cost to less than one mana."
			});
			const cappedSpell = synthCard({
				name: 'P17b Capped Automaton',
				manaCost: '{7}',
				cmc: 7,
				typeLine: 'Artifact Creature — Golem',
				power: '6',
				toughness: '6',
				oracleText:
					"This spell costs {2} less to cast for each artifact you control. This effect can't reduce the mana this spell costs to cast by more than {5}."
			});
			const abilityReducer = synthCard({
				name: 'P17b Training Grounds Mentor',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Creature — Wizard',
				power: '1',
				toughness: '2',
				oracleText:
					"Activated abilities of creatures you control cost {2} less to activate. This effect can't reduce the mana in that cost to less than one mana."
			});
			const guildmage = synthCard({
				name: 'P17b Spark Guildmage',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Human Wizard',
				power: '2',
				toughness: '2',
				oracleText: '{2}: Draw a card.\n{1}{U}: You gain 1 life.'
			});

			assert.equal(definitionSupportReport(compileCard(spellReducer)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(cappedSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(abilityReducer)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(guildmage)).fullySupported, true);

			putPerm(state, p1, spellReducer);
			putPerm(
				state,
				p1,
				synthCard({ name: 'P17b Relic A', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' })
			);
			putPerm(
				state,
				p1,
				synthCard({ name: 'P17b Relic B', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' })
			);
			putPerm(
				state,
				p1,
				synthCard({ name: 'P17b Relic C', manaCost: '{1}', cmc: 1, typeLine: 'Artifact' })
			);

			// {2} artifact spell reduced by {2} with minTotalMana=1 floors at {1}, NOT {0}
			const twoManaBauble = synthCard({
				name: 'P17b Two-Mana Bauble',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact'
			});
			const baubleHand = putInZone(state, p1, 'hand', twoManaBauble);
			assert.equal(spellCostStr(state, p1, baubleHand), '{1}');

			// Remove spellReducer to test cappedSpell's maxReduction=5 cleanly with 3 artifacts (3 * 2 = 6 -> capped at 5 -> {7} - {5} = {2})
			p1.battlefield = p1.battlefield.filter((b) => b.card.id !== spellReducer.id);
			noteLayerInputsChanged(state);
			const cappedHand = putInZone(state, p1, 'hand', cappedSpell);
			assert.equal(spellCostStr(state, p1, cappedHand), '{2}');

			// Activated ability minTotalMana=1 floor: {2} -> {1}; {1}{U} -> {U} (1 colored pip >= 1 total mana!)
			putPerm(state, p1, abilityReducer);
			const magePerm = putPerm(state, p1, guildmage);
			const ab0 = findAbility(state, p1, magePerm, 'act_0');
			const ab1 = findAbility(state, p1, magePerm, 'act_1');
			assert.equal(
				effectiveAbilityManaCost(
					state,
					p1.playerId,
					ab0.id,
					ab0.baseManaCost ?? ab0.manaCost,
					ab0.costKeyword,
					0,
					magePerm,
					ab0.isManaAbility
				).manaCost,
				'{1}'
			);
			assert.equal(
				effectiveAbilityManaCost(
					state,
					p1.playerId,
					ab1.id,
					ab1.baseManaCost ?? ab1.manaCost,
					ab1.costKeyword,
					0,
					magePerm,
					ab1.isManaAbility
				).manaCost,
				'{U}'
			);
		});

		it('handles per-target reductions, stack-active target taxes, and targetsStackSpell reductions', () => {
			const { state, p1, p2 } = setupGame();

			const battlefieldThaumaturge = synthCard({
				name: 'P17b Battlefield Mage',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Human Wizard',
				power: '2',
				toughness: '1',
				oracleText:
					'Each instant and sorcery spell you cast costs {1} less to cast for each creature it targets.'
			});
			const dualArc = synthCard({
				name: 'P17b Twin Arc',
				manaCost: '{2}{R}',
				cmc: 3,
				colors: ['R'],
				typeLine: 'Sorcery',
				oracleText: '~ deals 1 damage to up to two target creatures.'
			});
			const wardedBoltOnStack = synthCard({
				name: 'P17b Ward-Shielded Spell',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText:
					'As long as ~ is on the stack, spells your opponents cast that target it cost {2} more to cast.\nYou gain 1 life.'
			});
			const blueDispute = synthCard({
				name: 'P17b Mystical Rebuke',
				manaCost: '{2}{U}',
				cmc: 3,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText:
					'This spell costs {2} less to cast if it targets a blue spell.\nCounter target spell.'
			});

			assert.equal(
				definitionSupportReport(compileCard(battlefieldThaumaturge)).fullySupported,
				true
			);
			assert.equal(definitionSupportReport(compileCard(dualArc)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(wardedBoltOnStack)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(blueDispute)).fullySupported, true);

			putPerm(state, p1, battlefieldThaumaturge);
			const c1 = putPerm(
				state,
				p2,
				synthCard({
					name: 'P17b Target Goblin 1',
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Creature — Goblin',
					power: '1',
					toughness: '1'
				})
			);
			const c2 = putPerm(
				state,
				p2,
				synthCard({
					name: 'P17b Target Goblin 2',
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Creature — Goblin',
					power: '1',
					toughness: '1'
				})
			);

			const arcHand = putInZone(state, p1, 'hand', dualArc);
			assert.equal(spellCostStr(state, p1, arcHand, [permTarget(c1)]), '{1}{R}');
			assert.equal(
				spellCostStr(state, p1, arcHand, [permTarget(c1), permTarget(c2)]),
				'{R}'
			);

			// Put wardedBoltOnStack onto stack by p1; p2 responds with blueDispute targeting it:
			// Base {2}{U} - {2} (targets blue spell) + {2} (wardedBoltOnStack stack tax) = {2}{U}!
			const wardedHand = putInZone(state, p1, 'hand', wardedBoltOnStack);
			giveMana(p1, { U: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: wardedHand.instanceId
				}).ok,
				true
			);
			const stackSpell = state.stack[state.stack.length - 1];
			assert.ok(stackSpell);

			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			assert.equal(state.priorityPlayerIndex, 1);

			const disputeHand = putInZone(state, p2, 'hand', blueDispute);
			assert.equal(
				spellCostStr(state, p2, disputeHand, [stackTarget(stackSpell.id, stackSpell.title)]),
				'{2}{U}'
			);

			// Compare against targeting a non-taxing blue spell on stack -> {U} only!
			const plainBlue = synthCard({
				name: 'P17b Plain Splash',
				manaCost: '{U}',
				cmc: 1,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText: 'You gain 1 life.'
			});
			resolveAllStack(state);
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			const plainHand = putInZone(state, p1, 'hand', plainBlue);
			giveMana(p1, { U: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: plainHand.instanceId
				}).ok,
				true
			);
			const plainStackItem = state.stack[state.stack.length - 1];
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			assert.equal(
				spellCostStr(state, p2, disputeHand, [
					stackTarget(plainStackItem.id, plainStackItem.title)
				]),
				'{U}'
			);
		});

		it('applies activated-ability cost modifiers to Equip, graveyard creature cards, and non-mana abilities only', () => {
			const { state, p1 } = setupGame();

			const equipReducer = synthCard({
				name: 'P17b Armory Squire',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				typeLine: 'Artifact — Equipment',
				keywords: ['Equip'],
				oracleText:
					'Equipped creature gets +1/+1.\nEquip abilities you activate of other Equipment cost {1} less to activate.\nEquip {2}'
			});
			const otherBlade = synthCard({
				name: 'P17b Short Blade',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact — Equipment',
				keywords: ['Equip'],
				oracleText: 'Equipped creature gets +1/+0.\nEquip {2}'
			});
			const cryptReducer = synthCard({
				name: 'P17b Crypt Whisperer',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Creature — Warlock',
				power: '2',
				toughness: '2',
				oracleText: 'Activated abilities of creature cards in your graveyard cost {1} less to activate.'
			});
			const graveSkeleton = synthCard({
				name: 'P17b Restless Bones',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Creature — Skeleton',
				power: '1',
				toughness: '1',
				oracleText: '{2}{B}: Return ~ from your graveyard to your hand.'
			});
			const suppressionTax = synthCard({
				name: 'P17b Damping Pillar',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: "Activated abilities cost {1} more to activate unless they're mana abilities."
			});
			const manaAndPing = synthCard({
				name: 'P17b Dual Dynamo',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{1}, {T}: Add {R}{R}.\n{1}: You gain 1 life.'
			});

			assert.equal(definitionSupportReport(compileCard(equipReducer)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(cryptReducer)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(graveSkeleton)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(suppressionTax)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(manaAndPing)).fullySupported, true);

			const squirePerm = putPerm(state, p1, equipReducer);
			const bladePerm = putPerm(state, p1, otherBlade);
			// "other Equipment": squirePerm's own Equip stays {2}, bladePerm's Equip becomes {1}
			assert.equal(findAbility(state, p1, squirePerm).manaCost, '{2}');
			assert.equal(findAbility(state, p1, bladePerm).manaCost, '{1}');

			// Graveyard creature card activated ability reduced from {2}{B} to {1}{B}
			putPerm(state, p1, cryptReducer);
			const skelInGy = putInZone(state, p1, 'graveyard', graveSkeleton);
			const gyAb = findAbility(state, p1, skelInGy, 'act_0');
			const gyReq = effectiveAbilityManaCost(
				state,
				p1.playerId,
				gyAb.id,
				gyAb.baseManaCost ?? gyAb.manaCost,
				undefined,
				0,
				skelInGy,
				false
			);
			assert.equal(gyReq.manaCost, '{1}{B}');
			assert.equal(gyReq.requirement.generic, 1);
			assert.equal(gyReq.requirement.colored.B, 1);
			giveMana(p1, { B: 2 });
			const gyAct = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: skelInGy.instanceId,
				abilityId: gyAb.id
			});
			assert.equal(gyAct.ok, true, gyAct.error ?? '');
			assert.equal(p1.manaPool.B, 0);
			resolveAllStack(state);
			assert.equal(p1.hand.some((c) => c.instanceId === skelInGy.instanceId), true);

			// Non-mana ability tax: mana ability stays {1}, non-mana ability becomes {2}
			putPerm(state, p1, suppressionTax);
			const dynamoPerm = putPerm(state, p1, manaAndPing);
			const manaAb = findAbility(state, p1, dynamoPerm, 'act_0');
			const lifeAb = findAbility(state, p1, dynamoPerm, 'act_1');
			assert.equal(manaAb.isManaAbility, true);
			assert.equal(
				effectiveAbilityManaCost(
					state,
					p1.playerId,
					manaAb.id,
					manaAb.baseManaCost ?? manaAb.manaCost,
					manaAb.costKeyword,
					0,
					dynamoPerm,
					manaAb.isManaAbility
				).manaCost,
				'{1}'
			);
			assert.equal(lifeAb.isManaAbility, false);
			assert.equal(
				effectiveAbilityManaCost(
					state,
					p1.playerId,
					lifeAb.id,
					lifeAb.baseManaCost ?? lifeAb.manaCost,
					lifeAb.costKeyword,
					0,
					dynamoPerm,
					lifeAb.isManaAbility
				).manaCost,
				'{2}'
			);
		});
	});

	describe('2. Multi-Choice "or pay {N}" & Variable-X Additional Cast Costs (CR 118.8)', () => {
		it('executes "forage or pay {2}", firing "Whenever you forage" ONLY on the forage branch', () => {
			const { state, p1 } = setupGame();

			const forageWatcher = synthCard({
				name: 'P17b Squirrel Watcher',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Squirrel Druid',
				power: '2',
				toughness: '2',
				oracleText: 'Whenever you forage, you gain 2 life.'
			});
			const forageSpell = synthCard({
				name: 'P17b Acorn Harvest',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Sorcery',
				oracleText: 'As an additional cost to cast this spell, forage or pay {2}.\nDraw a card.'
			});
			const foodToken = synthCard({
				name: 'Food',
				manaCost: '',
				cmc: 0,
				typeLine: 'Artifact — Food',
				oracleText: '{2}, {T}, Sacrifice this artifact: You gain 3 life.'
			});

			assert.equal(definitionSupportReport(compileCard(forageWatcher)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(forageSpell)).fullySupported, true);

			putPerm(state, p1, forageWatcher);
			const foodPerm = putPerm(state, p1, foodToken);
			putInZone(state, p1, 'library', foodToken);
			putInZone(state, p1, 'library', foodToken);

			// Case A: Choose "Pay {2}" branch when both Forage (Food) and {2} mana are available -> NO forage trigger
			const spellA = putInZone(state, p1, 'hand', forageSpell);
			giveMana(p1, { G: 3 }); // {G} base + {2} additional
			const resA = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spellA.instanceId
			});
			assert.equal(resA.ok, true, resA.error ?? '');
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(state.pendingPrompts[0].purpose, 'cost_choice');
			const ansA = applyGameAction(state, p1.playerId, {
				type: 'cost_choice',
				promptId: state.pendingPrompts[0].id,
				option: 1
			});
			assert.equal(ansA.ok, true, ansA.error ?? '');
			assert.equal(p1.manaPool.G, 0);
			assert.equal(p1.battlefield.some((b) => b.instanceId === foodPerm.instanceId), true);
			resolveAllStack(state);
			assert.equal(p1.life, 20); // Forage trigger did NOT fire!

			// Case B: Only {G} mana available + Food on battlefield -> auto-picks Forage (sacrifices Food) and FIRES "Whenever you forage"!
			const spellB = putInZone(state, p1, 'hand', forageSpell);
			giveMana(p1, { G: 1 });
			const resB = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: spellB.instanceId
			});
			assert.equal(resB.ok, true, resB.error ?? '');
			assert.equal(state.pendingPrompts.length, 0);
			assert.equal(p1.battlefield.some((b) => b.instanceId === foodPerm.instanceId), false);
			resolveAllStack(state);
			assert.equal(p1.life, 22); // Gained 2 life from "Whenever you forage"!
		});

		it('supports "blight 1 or pay {2}", "reveal a Dragon card from your hand or pay {3}", and variable-X sacrifice additional costs', () => {
			const { state, p1 } = setupGame();

			const blightSpell = synthCard({
				name: 'P17b Ash Curse',
				manaCost: '{B}',
				cmc: 1,
				colors: ['B'],
				typeLine: 'Sorcery',
				oracleText: 'As an additional cost to cast this spell, blight 1 or pay {2}.\nYou gain 1 life.'
			});
			const dragonBreath = synthCard({
				name: 'P17b Draconic Roar',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText:
					'As an additional cost to cast this spell, reveal a Dragon card from your hand or pay {3}.\nYou gain 1 life.'
			});
			const xSacDraw = synthCard({
				name: 'P17b Altar Insight',
				manaCost: '{1}{B}',
				cmc: 2,
				colors: ['B'],
				typeLine: 'Sorcery',
				oracleText:
					'As an additional cost to cast this spell, sacrifice X creatures.\nDraw X cards.'
			});

			assert.equal(definitionSupportReport(compileCard(blightSpell)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(dragonBreath)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(xSacDraw)).fullySupported, true);

			// 1. Blight 1 branch when only {B} is available -> puts one -1/-1 counter on our creature
			const bear1 = putPerm(
				state,
				p1,
				synthCard({
					name: 'P17b Blight Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				})
			);
			const blightHand = putInZone(state, p1, 'hand', blightSpell);
			giveMana(p1, { B: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: blightHand.instanceId
				}).ok,
				true
			);
			assert.equal(bear1.counters['-1/-1'], 1);
			resolveAllStack(state);

			// 2. Reveal a Dragon card from hand -> casts for {1}{R} without spending {3}
			putInZone(
				state,
				p1,
				'hand',
				synthCard({
					name: 'P17b Shivan Whelp',
					manaCost: '{4}{R}{R}',
					cmc: 6,
					typeLine: 'Creature — Dragon',
					power: '5',
					toughness: '5'
				})
			);
			const roarHand = putInZone(state, p1, 'hand', dragonBreath);
			giveMana(p1, { R: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: roarHand.instanceId
				}).ok,
				true
			);
			assert.equal(p1.manaPool.R, 0);
			resolveAllStack(state);

			// 3. Variable-X sacrifice additional cost: sacrifice 2 creatures (X = 2) -> draws 2 cards
			const sac2 = putPerm(
				state,
				p1,
				synthCard({
					name: 'P17b Token Imp',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Creature — Imp',
					power: '1',
					toughness: '1'
				})
			);
			for (let i = 0; i < 4; i++) {
				putInZone(state, p1, 'library', blightSpell);
			}
			const handBefore = p1.hand.length;
			const xSacHand = putInZone(state, p1, 'hand', xSacDraw);
			giveMana(p1, { B: 2 });
			const xRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: xSacHand.instanceId,
				xValue: 2
			});
			assert.equal(xRes.ok, true, xRes.error ?? '');
			assert.equal(state.stack[state.stack.length - 1]?.xValue, 2);
			assert.equal(p1.battlefield.some((b) => b.instanceId === bear1.instanceId), false);
			assert.equal(p1.battlefield.some((b) => b.instanceId === sac2.instanceId), false);
			resolveAllStack(state);
			assert.equal(p1.hand.length, handBefore + 2);
		});

		it('supports optional additional costs, halfLifeRoundedUp, collectEvidence, putOnBottomOfLibrary, and processOpponentExile', () => {
			const { state, p1, p2 } = setupGame();

			const halfLifeRelic = synthCard({
				name: 'P17b Blood Pendulum',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Pay half your life, rounded up: You gain 1 life.'
			});
			const evidenceRelic = synthCard({
				name: 'P17b Magnifying Lens',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{T}, Collect evidence 4: You gain 1 life.'
			});
			const tuckRelic = synthCard({
				name: 'P17b Archive Chute',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Put a card from your graveyard on the bottom of your library: You gain 1 life.'
			});
			const processorCreature = synthCard({
				name: 'P17b Void Processor',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Eldrazi Processor',
				power: '2',
				toughness: '2',
				oracleText: "Put a card an opponent owns from exile into that player's graveyard: You gain 1 life."
			});

			assert.equal(definitionSupportReport(compileCard(halfLifeRelic)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(evidenceRelic)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(tuckRelic)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(processorCreature)).fullySupported, true);

			// 1. Pay half your life, rounded up: 19 life -> pays ceil(19/2)=10 -> 9 life, then gains 1 -> 10
			p1.life = 19;
			const pendPerm = putPerm(state, p1, halfLifeRelic);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: pendPerm.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(p1.life, 9);
			resolveAllStack(state);
			assert.equal(p1.life, 10);

			// 2. Collect evidence 4: exiles MV-3 + MV-2 cards from graveyard (total MV = 5 >= 4)
			const lensPerm = putPerm(state, p1, evidenceRelic);
			const mv3 = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({ name: 'P17b Clue A', manaCost: '{2}{U}', cmc: 3 })
			);
			const mv2 = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({ name: 'P17b Clue B', manaCost: '{1}{U}', cmc: 2 })
			);
			const evAct = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: lensPerm.instanceId,
				abilityId: 'act_0'
			});
			assert.equal(evAct.ok, true, evAct.error ?? '');
			if (state.pendingPrompts.length > 0) {
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'cost_choice',
						promptId: state.pendingPrompts[0].id,
						instanceIds: [mv3.instanceId, mv2.instanceId]
					}).ok,
					true
				);
			}
			assert.equal(p1.exile.some((c) => c.instanceId === mv3.instanceId), true);
			assert.equal(p1.exile.some((c) => c.instanceId === mv2.instanceId), true);
			resolveAllStack(state);

			// 3. Put a card from your graveyard on the bottom of your library
			const chutePerm = putPerm(state, p1, tuckRelic);
			const gyCard = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({ name: 'P17b Tucked Scroll', manaCost: '{1}', cmc: 1 })
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: chutePerm.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(p1.library[p1.library.length - 1]?.instanceId, gyCard.instanceId);
			resolveAllStack(state);

			// 4. Eldrazi Processor: put an opponent's exiled card into their graveyard
			const procPerm = putPerm(state, p1, processorCreature);
			const oppExiled = putInZone(
				state,
				p2,
				'exile',
				synthCard({ name: 'P17b Exiled Relic', manaCost: '{2}', cmc: 2 })
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: procPerm.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(p2.graveyard.some((c) => c.instanceId === oppExiled.instanceId), true);
			resolveAllStack(state);
		});
	});

	describe('3. Self-Pitch, Trap, Flash-Extra, Graveyard & External altCastPermission (CR 118.9)', () => {
		it('supports land-sacrifice pitch, ordered graveyard fromTop pitch, opponentGainsLife (blocked by cantGainLife), revealHand, and attackingCount Trap', () => {
			const { state, p1, p2 } = setupGame();

			const gushPitch = synthCard({
				name: 'P17b Tidal Gush',
				manaCost: '{4}{U}',
				cmc: 5,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText:
					"You may sacrifice two Islands rather than pay this spell's mana cost.\nYou gain 1 life."
			});
			const spinningPitch = synthCard({
				name: 'P17b Spinning Shadow',
				manaCost: '{4}{B}{B}',
				cmc: 6,
				colors: ['B'],
				typeLine: 'Instant',
				oracleText:
					"You may exile the top three black cards of your graveyard rather than pay this spell's mana cost.\nYou gain 3 life."
			});
			const invigoratePitch = synthCard({
				name: 'P17b Canopy Surge',
				manaCost: '{2}{G}',
				cmc: 3,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText:
					"If you control a Forest, rather than pay this spell's mana cost, you may have an opponent gain 3 life.\nYou gain 1 life."
			});
			const landlessPitch = synthCard({
				name: 'P17b Landless Scout',
				manaCost: '{3}{G}',
				cmc: 4,
				colors: ['G'],
				typeLine: 'Sorcery',
				oracleText:
					"If there are no land cards in your hand, you may reveal your hand rather than pay this spell's mana cost.\nYou gain 1 life."
			});
			const arrowTrap = synthCard({
				name: 'P17b Volley Trap',
				manaCost: '{3}{W}{W}',
				cmc: 5,
				colors: ['W'],
				typeLine: 'Instant — Trap',
				oracleText:
					"If two or more creatures are attacking, you may pay {W} rather than pay this spell's mana cost.\nYou gain 2 life."
			});

			assert.equal(definitionSupportReport(compileCard(gushPitch)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(spinningPitch)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(invigoratePitch)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(landlessPitch)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(arrowTrap)).fullySupported, true);

			// 1. Land-sacrifice pitch: sacrifice 2 Islands for 0 mana
			putPerm(
				state,
				p1,
				synthCard({ name: 'Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' })
			);
			putPerm(
				state,
				p1,
				synthCard({ name: 'Island', manaCost: '', cmc: 0, typeLine: 'Basic Land — Island' })
			);
			const gushHand = putInZone(state, p1, 'hand', gushPitch);
			const gushOpt = getCastOptions(state, p1.playerId, gushHand, 'hand').find(
				(o) => o.permission === 'static_alt'
			);
			assert.ok(gushOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: gushHand.instanceId,
					optionId: gushOpt.id
				}).ok,
				true
			);
			assert.equal(p1.battlefield.length, 0);
			resolveAllStack(state);

			// 2. Ordered graveyard fromTop pitch: [deepBlack, midBlack1, nonBlack, midBlack2, topBlack] (index 0 = bottom, last = top)
			const mkBlack = (name: string) =>
				synthCard({
					name,
					manaCost: '{B}',
					cmc: 1,
					colors: ['B'],
					typeLine: 'Creature — Shade',
					power: '1',
					toughness: '1'
				});
			const deepBlack = putInZone(state, p1, 'graveyard', mkBlack('P17b Deep Black'));
			const midBlack1 = putInZone(state, p1, 'graveyard', mkBlack('P17b Mid Black 1'));
			const nonBlack = putInZone(
				state,
				p1,
				'graveyard',
				synthCard({ name: 'P17b White Card', manaCost: '{W}', cmc: 1, colors: ['W'] })
			);
			const midBlack2 = putInZone(state, p1, 'graveyard', mkBlack('P17b Mid Black 2'));
			const topBlack = putInZone(state, p1, 'graveyard', mkBlack('P17b Top Black'));

			const spinHand = putInZone(state, p1, 'hand', spinningPitch);
			const spinOpt = getCastOptions(state, p1.playerId, spinHand, 'hand').find(
				(o) => o.permission === 'static_alt'
			);
			assert.ok(spinOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: spinHand.instanceId,
					optionId: spinOpt.id
				}).ok,
				true
			);
			// Top 3 black cards exiled; deepBlack & nonBlack remain in graveyard!
			assert.equal(p1.exile.some((c) => c.instanceId === topBlack.instanceId), true);
			assert.equal(p1.exile.some((c) => c.instanceId === midBlack2.instanceId), true);
			assert.equal(p1.exile.some((c) => c.instanceId === midBlack1.instanceId), true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === deepBlack.instanceId), true);
			assert.equal(p1.graveyard.some((c) => c.instanceId === nonBlack.instanceId), true);
			resolveAllStack(state);

			// 3. opponentGainsLife pitch: works with Forest, blocked under CR 118.12 when opponent can't gain life
			putPerm(
				state,
				p1,
				synthCard({ name: 'Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest' })
			);
			const invHand1 = putInZone(state, p1, 'hand', invigoratePitch);
			const invOpt1 = getCastOptions(state, p1.playerId, invHand1, 'hand').find(
				(o) => o.permission === 'static_alt'
			);
			assert.ok(invOpt1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: invHand1.instanceId,
					optionId: invOpt1.id
				}).ok,
				true
			);
			assert.equal(p2.life, 23);
			resolveAllStack(state);

			// Put "Players can't gain life." on battlefield -> altCast option fails legality (CR 118.12)
			putPerm(
				state,
				p2,
				synthCard({
					name: 'P17b Sulfuric Vortex Idol',
					manaCost: '{2}{R}',
					cmc: 3,
					typeLine: 'Enchantment',
					oracleText: "Players can't gain life."
				})
			);
			const invHand2 = putInZone(state, p1, 'hand', invigoratePitch);
			const invLegalBlocked = checkSpellCastLegality(
				state,
				p1.playerId,
				invHand2,
				'hand',
				0,
				invOpt1.id
			);
			assert.equal(invLegalBlocked.ok, false);
			p2.battlefield = [];
			p1.hand = [];
			noteLayerInputsChanged(state);

			// 4. revealHand pitch when no lands in hand
			const scoutHand = putInZone(state, p1, 'hand', landlessPitch);
			const scoutOpt = getCastOptions(state, p1.playerId, scoutHand, 'hand').find(
				(o) => o.permission === 'static_alt'
			);
			assert.ok(scoutOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: scoutHand.instanceId,
					optionId: scoutOpt.id
				}).ok,
				true
			);
			resolveAllStack(state);

			// 5. Trap attackingCount >= 2
			giveMana(p1, { W: 1 });
			const trapHand = putInZone(state, p1, 'hand', arrowTrap);
			assert.equal(
				getCastOptions(state, p1.playerId, trapHand, 'hand').some(
					(o) => o.permission === 'static_alt'
				),
				false
			);
			const atk1 = putPerm(
				state,
				p2,
				synthCard({ name: 'P17b Raider 1', typeLine: 'Creature — Orc', power: '2', toughness: '2' })
			);
			const atk2 = putPerm(
				state,
				p2,
				synthCard({ name: 'P17b Raider 2', typeLine: 'Creature — Orc', power: '2', toughness: '2' })
			);
			state.combat.attackers = [
				{
					attackerInstanceId: atk1.instanceId,
					controllerId: p2.playerId,
					defenderPlayerId: p1.playerId,
					blockerInstanceIds: []
				},
				{
					attackerInstanceId: atk2.instanceId,
					controllerId: p2.playerId,
					defenderPlayerId: p1.playerId,
					blockerInstanceIds: []
				}
			];
			const trapOpt = getCastOptions(state, p1.playerId, trapHand, 'hand').find(
				(o) => o.permission === 'static_alt'
			);
			assert.ok(trapOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: trapHand.instanceId,
					optionId: trapOpt.id
				}).ok,
				true
			);
			assert.equal(p1.manaPool.W, 0);
		});

		it('supports external once-each-turn altCastPermission (payLifeEqualToSpellMV), graveyard enterCounters, and flash+{2} additionalOnly', () => {
			const { state, p1, p2 } = setupGame();

			const lifeConduit = synthCard({
				name: 'P17b Bloodline Conduit',
				manaCost: '{3}{B}',
				cmc: 4,
				colors: ['B'],
				typeLine: 'Enchantment',
				oracleText:
					'Once during each of your turns, you may cast a spell from your hand by paying life equal to its mana value rather than paying its mana cost.'
			});
			const bigSorcery = synthCard({
				name: 'P17b Dark Petition',
				manaCost: '{3}{B}{B}',
				cmc: 5,
				colors: ['B'],
				typeLine: 'Sorcery',
				oracleText: 'You gain 1 life.'
			});
			const gravePhoenix = synthCard({
				name: 'P17b Finality Phoenix',
				manaCost: '{1}{R}',
				cmc: 2,
				colors: ['R'],
				typeLine: 'Creature — Phoenix',
				power: '2',
				toughness: '2',
				oracleText:
					'You may cast ~ from your graveyard by discarding a card in addition to paying its other costs. If you do, it enters with a finality counter on it.'
			});
			const flashTaxBear = synthCard({
				name: 'P17b Ambush Stalker',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Cat',
				power: '2',
				toughness: '2',
				oracleText: 'You may cast ~ as though it had flash if you pay {2} more to cast it.'
			});

			assert.equal(definitionSupportReport(compileCard(lifeConduit)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(gravePhoenix)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(flashTaxBear)).fullySupported, true);

			// 1. External once-each-turn payLifeEqualToSpellMV: casts MV-5 spell for 5 life once, then consumed for the turn!
			putPerm(state, p1, lifeConduit);
			const s1 = putInZone(state, p1, 'hand', bigSorcery);
			const s2 = putInZone(state, p1, 'hand', bigSorcery);
			const opt1 = getCastOptions(state, p1.playerId, s1, 'hand').find(
				(o) => o.permission === 'static_alt'
			);
			assert.ok(opt1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: s1.instanceId,
					optionId: opt1.id
				}).ok,
				true
			);
			// Paid 5 life on cast; resolves "You gain 1 life." -> 16 life
			assert.equal(p1.life, 15);
			resolveAllStack(state);
			assert.equal(p1.life, 16);
			// Second spell this turn has NO static_alt option left
			assert.equal(
				getCastOptions(state, p1.playerId, s2, 'hand').some(
					(o) => o.permission === 'static_alt'
				),
				false
			);
			p1.hand = [];

			// 2. Self graveyard "in addition to paying its other costs" + enters with finality counter
			const phoenixGy = putInZone(state, p1, 'graveyard', gravePhoenix);
			const fodder = putInZone(
				state,
				p1,
				'hand',
				synthCard({ name: 'P17b Discard Fodder', manaCost: '{1}', cmc: 1 })
			);
			giveMana(p1, { R: 2 });
			const gyOpt = getCastOptions(state, p1.playerId, phoenixGy, 'graveyard').find(
				(o) => o.fromZone === 'graveyard'
			);
			assert.ok(gyOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: phoenixGy.instanceId,
					fromZone: 'graveyard',
					optionId: gyOpt.id
				}).ok,
				true
			);
			assert.equal(p1.graveyard.some((c) => c.instanceId === fodder.instanceId), true);
			resolveAllStack(state);
			const enteredPhoenix = p1.battlefield.find((b) => b.card.id === gravePhoenix.id);
			assert.ok(enteredPhoenix);
			assert.equal(enteredPhoenix.counters['finality' as CounterType], 1);

			// 3. Self flash + {2} additionalOnly on opponent's turn
			state.activePlayerIndex = 1;
			state.priorityPlayerIndex = 1;
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });
			assert.equal(state.priorityPlayerIndex, 0);

			const stalkerHand = putInZone(state, p1, 'hand', flashTaxBear);
			giveMana(p1, { G: 4 }); // {1}{G} + {2} = 4 mana total
			const flashOpt = getCastOptions(state, p1.playerId, stalkerHand, 'hand').find(
				(o) => o.permission === 'static_alt'
			);
			assert.ok(flashOpt, 'Expected flash+{2} option on opponent turn');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: stalkerHand.instanceId,
					optionId: flashOpt.id
				}).ok,
				true
			);
			assert.equal(p1.manaPool.G, 0);
		});
	});

	describe("4. Universal Counter Costs, Storage Lands & 'any' Counter Removal (CR 122.1)", () => {
		it("handles arbitrary named & -0/-1 counters, Storage Land X-counter mana abilities, and mixed 'any' counter removal", () => {
			const { state, p1 } = setupGame();

			const filibusterRelic = synthCard({
				name: 'P17b Senate Rostrum',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Remove a filibuster counter from ~: You gain 1 life.'
			});
			const wallMinusZeroOne = synthCard({
				name: 'P17b Scarred Rampart',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Wall',
				power: '0',
				toughness: '4',
				oracleText: 'Remove a -0/-1 counter from ~: You gain 1 life.'
			});
			const storageLand = synthCard({
				name: 'P17b Calciform Basin',
				manaCost: '',
				cmc: 0,
				typeLine: 'Land',
				oracleText:
					'{T}: Add {C}.\n{1}, {T}: Put a storage counter on ~.\n{1}, {T}, Remove X storage counters from ~: Add X mana in any combination of {W} and/or {U}.'
			});
			const mixedCounterRelic = synthCard({
				name: 'P17b Prism Reliquary',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Remove two counters from ~: Draw a card.'
			});

			assert.equal(definitionSupportReport(compileCard(filibusterRelic)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(wallMinusZeroOne)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(storageLand)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(mixedCounterRelic)).fullySupported, true);

			// 1. Custom named counter ('filibuster') and '-0/-1' counter removal
			const rostrumPerm = putPerm(state, p1, filibusterRelic);
			addCountersToPermanent(state, rostrumPerm, 'filibuster' as CounterType, 1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: rostrumPerm.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(rostrumPerm.counters['filibuster' as CounterType] ?? 0, 0);
			resolveAllStack(state);
			assert.equal(p1.life, 21);

			const wallPerm = putPerm(state, p1, wallMinusZeroOne);
			addCountersToPermanent(state, wallPerm, '-0/-1' as CounterType, 1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: wallPerm.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(wallPerm.counters['-0/-1' as CounterType] ?? 0, 0);
			resolveAllStack(state);
			assert.equal(p1.life, 22);

			// 2. Storage land: remove X=3 storage counters via tap_mana -> adds 3 mana and leaves 1 storage counter
			const basinPerm = putPerm(state, p1, storageLand);
			addCountersToPermanent(state, basinPerm, 'storage' as CounterType, 4);
			giveMana(p1, { C: 1 });
			const manaRes = applyGameAction(state, p1.playerId, {
				type: 'tap_mana',
				instanceId: basinPerm.instanceId,
				abilityId: 'act_2',
				xValue: 3,
				preferredColor: 'U'
			});
			assert.equal(manaRes.ok, true, manaRes.error ?? '');
			assert.equal(basinPerm.counters['storage' as CounterType], 1);
			assert.equal(p1.manaPool.U, 3);
			p1.manaPool.U = 0;

			// 3. Open-ended 'any' counter removal across mixed counters (1 brick + 1 verse)
			const prismPerm = putPerm(state, p1, mixedCounterRelic);
			addCountersToPermanent(state, prismPerm, 'brick' as CounterType, 1);
			addCountersToPermanent(state, prismPerm, 'verse' as CounterType, 1);
			putInZone(state, p1, 'library', filibusterRelic);
			const anyRes = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: prismPerm.instanceId,
				abilityId: 'act_0'
			});
			assert.equal(anyRes.ok, true, anyRes.error ?? '');
			assert.equal(prismPerm.counters['brick' as CounterType] ?? 0, 0);
			assert.equal(prismPerm.counters['verse' as CounterType] ?? 0, 0);
			resolveAllStack(state);
			assert.equal(p1.hand.length, 1);
		});
	});

	describe('5. {Q} Untap Symbol (CR 107.6 + CR 302.6) vs Spelled-Out untapSelf & untapOthers', () => {
		it('enforces summoning sickness & tapped requirement on {Q} for creatures while exempting noncreature artifacts, Haste, and spelled-out Untap costs', () => {
			const { state, p1 } = setupGame();

			const puresightCreature = synthCard({
				name: 'P17b Silkbind Merrow',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Merfolk',
				power: '2',
				toughness: '2',
				oracleText: '{U}, {Q}: You gain 1 life.'
			});
			const untapArtifact = synthCard({
				name: 'P17b Clockwork Rod',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: '{1}, {Q}: You gain 1 life.'
			});
			const spelledUntapSelf = synthCard({
				name: 'P17b Wirewood Channeler',
				manaCost: '{1}{G}',
				cmc: 2,
				colors: ['G'],
				typeLine: 'Creature — Elf Druid',
				power: '1',
				toughness: '2',
				oracleText: '{1}, Untap ~: You gain 1 life.'
			});
			const spelledUntapOther = synthCard({
				name: 'P17b Tide Marshal',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Merfolk Wizard',
				power: '2',
				toughness: '2',
				oracleText: 'Untap a tapped creature you control: You gain 1 life.'
			});

			assert.equal(definitionSupportReport(compileCard(puresightCreature)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(untapArtifact)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(spelledUntapSelf)).fullySupported, true);
			assert.equal(definitionSupportReport(compileCard(spelledUntapOther)).fullySupported, true);

			giveMana(p1, { U: 5, G: 5 });

			// 1. {Q} on untapped non-sick creature -> ILLEGAL (CR 107.6: must be tapped)
			const merrowUntapped = putPerm(state, p1, puresightCreature, {
				summoningSick: false,
				tapped: false
			});
			assert.equal(
				checkAbilityActivationLegality(
					state,
					p1.playerId,
					merrowUntapped,
					findAbility(state, p1, merrowUntapped, 'act_0')
				).ok,
				false
			);

			// 2. {Q} on tapped summoning-sick creature WITHOUT Haste -> ILLEGAL (CR 302.6)
			const merrowSick = putPerm(state, p1, puresightCreature, {
				summoningSick: true,
				tapped: true
			});
			assert.equal(
				checkAbilityActivationLegality(
					state,
					p1.playerId,
					merrowSick,
					findAbility(state, p1, merrowSick, 'act_0')
				).ok,
				false
			);

			// Grant Haste -> {Q} becomes LEGAL immediately and untaps merrowSick!
			merrowSick.grantedKeywords.push('Haste');
			noteLayerInputsChanged(state);
			assert.equal(
				checkAbilityActivationLegality(
					state,
					p1.playerId,
					merrowSick,
					findAbility(state, p1, merrowSick, 'act_0')
				).ok,
				true
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: merrowSick.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(merrowSick.tapped, false);
			resolveAllStack(state);

			// 3. {Q} on summoning-sick tapped noncreature artifact -> LEGAL (CR 302.6 only restricts creatures)
			const rodSick = putPerm(state, p1, untapArtifact, { summoningSick: true, tapped: true });
			assert.equal(
				checkAbilityActivationLegality(
					state,
					p1.playerId,
					rodSick,
					findAbility(state, p1, rodSick, 'act_0')
				).ok,
				true
			);

			// 4. Spelled-out "Untap ~" (viaSymbol: false) on summoning-sick tapped creature WITHOUT Haste -> LEGAL!
			const elfSick = putPerm(state, p1, spelledUntapSelf, { summoningSick: true, tapped: true });
			assert.equal(
				checkAbilityActivationLegality(
					state,
					p1.playerId,
					elfSick,
					findAbility(state, p1, elfSick, 'act_0')
				).ok,
				true
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: elfSick.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(elfSick.tapped, false);
			resolveAllStack(state);

			// 5. "Untap a tapped creature you control" (untapOthers) -> LEGAL even on summoning-sick creature
			merrowUntapped.tapped = true;
			const marshalSick = putPerm(state, p1, spelledUntapOther, {
				summoningSick: true,
				tapped: false
			});
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: marshalSick.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(merrowUntapped.tapped, false);
		});
	});

	describe('6. JSON Round-Trip Serialization Mid-Cost-Payment (ENGINE_INVARIANTS.md §7.1)', () => {
		it('survives JSON.parse(JSON.stringify(state)) at cost_choice prompts for both branch selection and multi-candidate object selection', () => {
			const { state, p1 } = setupGame();

			const forageSpell = synthCard({
				name: 'P17b Serialized Forage',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				typeLine: 'Sorcery',
				oracleText: 'As an additional cost to cast this spell, forage or pay {2}.\nYou gain 2 life.'
			});
			const untapMarshal = synthCard({
				name: 'P17b Serialized Marshal',
				manaCost: '{1}{U}',
				cmc: 2,
				colors: ['U'],
				typeLine: 'Creature — Wizard',
				power: '2',
				toughness: '2',
				oracleText: 'Untap a tapped creature you control: You gain 1 life.'
			});

			const food = putPerm(
				state,
				p1,
				synthCard({
					name: 'Food',
					manaCost: '',
					cmc: 0,
					typeLine: 'Artifact — Food',
					oracleText: '{2}, {T}, Sacrifice this artifact: You gain 3 life.'
				})
			);
			const spellHand = putInZone(state, p1, 'hand', forageSpell);
			giveMana(p1, { G: 3 });

			// Pause at "forage or pay {2}" prompt, round-trip through JSON, then answer option 0 (Forage)
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: spellHand.instanceId
				}).ok,
				true
			);
			assert.equal(state.pendingPrompts.length, 1);

			const reloaded1: GameState = JSON.parse(JSON.stringify(state));
			const promptId1 = reloaded1.pendingPrompts[0].id;
			const resume1 = applyGameAction(reloaded1, reloaded1.players[0].playerId, {
				type: 'cost_choice',
				promptId: promptId1,
				option: 0
			});
			assert.equal(resume1.ok, true, resume1.error ?? '');
			assert.equal(
				reloaded1.players[0].battlefield.some((b) => b.instanceId === food.instanceId),
				false
			);
			resolveAllStack(reloaded1);
			assert.equal(reloaded1.players[0].life, 22);

			// Pause at multi-candidate untapOthers selection (2 tapped creatures), round-trip through JSON, then pick candidate 2
			const marshal = putPerm(reloaded1, reloaded1.players[0], untapMarshal);
			const tapA = putPerm(
				reloaded1,
				reloaded1.players[0],
				synthCard({
					name: 'P17b Tapped Bear A',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				{ tapped: true }
			);
			const tapB = putPerm(
				reloaded1,
				reloaded1.players[0],
				synthCard({
					name: 'P17b Tapped Bear B',
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				{ tapped: true }
			);
			assert.equal(
				applyGameAction(reloaded1, reloaded1.players[0].playerId, {
					type: 'activate_ability',
					instanceId: marshal.instanceId,
					abilityId: 'act_0'
				}).ok,
				true
			);
			assert.equal(reloaded1.pendingPrompts.length, 1);

			const reloaded2: GameState = JSON.parse(JSON.stringify(reloaded1));
			const promptId2 = reloaded2.pendingPrompts[0].id;
			const resume2 = applyGameAction(reloaded2, reloaded2.players[0].playerId, {
				type: 'cost_choice',
				promptId: promptId2,
				instanceIds: [tapB.instanceId]
			});
			assert.equal(resume2.ok, true, resume2.error ?? '');
			const afterA = reloaded2.players[0].battlefield.find((b) => b.instanceId === tapA.instanceId);
			const afterB = reloaded2.players[0].battlefield.find((b) => b.instanceId === tapB.instanceId);
			assert.equal(afterA?.tapped, true);
			assert.equal(afterB?.tapped, false);
			resolveAllStack(reloaded2);
			assert.equal(reloaded2.players[0].life, 23);
		});
	});

	describe('7. Synthetic Card Rename Invariance (ENGINE_INVARIANTS.md §1.3)', () => {
		it('compiles and executes identically under an invented card name ("Glimmerfen Chronosmith")', () => {
			const makeChrono = (cardName: string) =>
				synthCard({
					name: cardName,
					manaCost: '{3}{U}',
					cmc: 4,
					colors: ['U'],
					typeLine: 'Artifact Creature — Vedalken Artificer',
					power: '2',
					toughness: '3',
					oracleText:
						`This spell costs {1} less to cast for each artifact you control. This effect can't reduce the mana in that cost to less than one mana.\n` +
						`Remove a charge counter from ${cardName}, {Q}: Draw a card.`
				});

			const canonical = makeChrono('Chronosmith Prototype');
			const renamed = makeChrono('Glimmerfen Chronosmith');

			const defA = compileCard(canonical);
			const defB = compileCard(renamed);
			assert.equal(definitionSupportReport(defA).fullySupported, true);
			assert.equal(definitionSupportReport(defB).fullySupported, true);

			const stripNames = (obj: unknown): unknown =>
				JSON.parse(
					JSON.stringify(obj, (key, val) =>
						key === 'name' || key === 'printedText' || key === 'text' ? undefined : val
					)
				);
			assert.deepEqual(stripNames(defA.faces), stripNames(defB.faces));

			const runScenario = (card: ScryfallCard) => {
				const { state, p1 } = setupGame();
				putPerm(state, p1, synthCard({ name: 'Relic 1', typeLine: 'Artifact' }));
				putPerm(state, p1, synthCard({ name: 'Relic 2', typeLine: 'Artifact' }));
				putInZone(state, p1, 'library', synthCard({ name: 'Drawn Card', typeLine: 'Artifact' }));

				const handInst = putInZone(state, p1, 'hand', card);
				const effCost = spellCostStr(state, p1, handInst);
				giveMana(p1, { U: 2 });
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'cast_spell',
						instanceId: handInst.instanceId
					}).ok,
					true
				);
				resolveAllStack(state);

				const perm = p1.battlefield.find((b) => b.card.id === card.id)!;
				perm.summoningSick = false;
				perm.tapped = true;
				addCountersToPermanent(state, perm, 'charge', 1);
				const actAb = findAbility(state, p1, perm);
				assert.equal(
					applyGameAction(state, p1.playerId, {
						type: 'activate_ability',
						instanceId: perm.instanceId,
						abilityId: actAb.id
					}).ok,
					true
				);
				resolveAllStack(state);
				return {
					effCost,
					tappedAfter: perm.tapped,
					chargeLeft: perm.counters.charge ?? 0,
					handCount: p1.hand.length
				};
			};

			const outA = runScenario(canonical);
			const outB = runScenario(renamed);
			assert.deepEqual(outA, outB);
			assert.deepEqual(outB, {
				effCost: '{1}{U}',
				tappedAfter: false,
				chargeLeft: 0,
				handCount: 1
			});
		});
	});
});
