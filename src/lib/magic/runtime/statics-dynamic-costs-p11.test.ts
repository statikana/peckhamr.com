import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	addCountersToPermanent,
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	hasKeyword,
	resolveTopOfStack
} from '../engine.ts';
import { parseManaCost } from '../oracle.ts';
import { effectiveAbilityManaCost, effectiveSpellManaCost } from './costs.ts';
import { computeEffectiveMaxHandSize } from './staticsDynamicAndCosts.ts';
import { moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	const id = `syn_p11_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id,
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
		legalCommander: true,
		canBeCommander: overrides.canBeCommander ?? false,
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
		id: 'deck_p11',
		userId: 'p1',
		name: 'Track P11 Deck',
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

function setupMain1Game(opts: { p1Bot?: boolean; p2Bot?: boolean; deckCards?: ScryfallCard[] } = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P11 Filler Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const baseCards = opts.deckCards ?? Array.from({ length: 30 }, () => filler);
	const deck = makeDeck(baseCards);
	const seats: LobbySeat[] = [
		{
			seatIndex: 0,
			userId: opts.p1Bot ? null : 'p1',
			username: 'Alice',
			avatarUrl: '',
			isBot: Boolean(opts.p1Bot),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		},
		{
			seatIndex: 1,
			userId: opts.p2Bot ? null : 'p2',
			username: 'Bob',
			avatarUrl: '',
			isBot: Boolean(opts.p2Bot),
			deckId: deck.id,
			deckName: deck.name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: ['W', 'U', 'B', 'R', 'G'],
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}
	];
	const decksBySeat = new Map<number, MagicDeck>([
		[0, deck],
		[1, deck]
	]);
	const state = createInitialGameState('LOBBY_P11', seats, decksBySeat, DEFAULT_LOBBY_RULES);
	state.status = 'active';
	state.pendingPrompts = [];
	state.turnNumber = 2;
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	const [p1, p2] = state.players;
	p1.hand = [];
	p1.battlefield = [];
	p1.graveyard = [];
	p1.exile = [];
	p2.hand = [];
	p2.battlefield = [];
	p2.graveyard = [];
	p2.exile = [];
	return { state, p1, p2 };
}

function putOnBattlefield(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	opts: { tapped?: boolean; summoningSick?: boolean; isToken?: boolean; attachTo?: CardInstance } = {}
): CardInstance {
	const inst = createCardInstance(card, player.playerId, 'battlefield');
	inst.controllerId = player.playerId;
	inst.defaultControllerId = player.playerId;
	inst.tapped = Boolean(opts.tapped);
	inst.summoningSick = Boolean(opts.summoningSick);
	if (opts.isToken) inst.isToken = true;
	if (opts.attachTo) inst.attachedToId = opts.attachTo.instanceId;
	moveObject(state, inst, 'battlefield', {
		from: 'none',
		toPlayer: player,
		controllerId: player.playerId,
		newTimestamp: true,
		bumpVersion: true
	});
	if (opts.attachTo) inst.attachedToId = opts.attachTo.instanceId;
	return inst;
}

function putInHand(state: GameState, player: PlayerGameState, card: ScryfallCard): CardInstance {
	const inst = createCardInstance(card, player.playerId, 'hand');
	inst.controllerId = player.playerId;
	moveObject(state, inst, 'hand', {
		from: 'none',
		toPlayer: player,
		controllerId: player.playerId,
		newTimestamp: true,
		bumpVersion: true
	});
	return inst;
}

function putInGraveyard(state: GameState, player: PlayerGameState, card: ScryfallCard): CardInstance {
	const inst = createCardInstance(card, player.playerId, 'graveyard');
	inst.controllerId = player.playerId;
	moveObject(state, inst, 'graveyard', {
		from: 'none',
		toPlayer: player,
		controllerId: player.playerId,
		newTimestamp: true,
		bumpVersion: true
	});
	return inst;
}

describe('Track P11.1 — Layer 6 Quoted Triggered/Static/Replacement Grants & Timestamp Ordering (CR 613.1f, 613.7e, 107.3j)', () => {
	it('grants compound P/T, keywords, and quoted triggered abilities where ~ binds to recipient and respects CR 613.7e re-attach vs Humility timestamps', () => {
		const { state, p1, p2 } = setupMain1Game();

		const scout = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Sunlit Scout',
				typeLine: 'Creature — Human Scout',
				power: '2',
				toughness: '2'
			})
		);

		const bladeCard = synthCard({
			name: 'Blade of Insight',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact — Equipment',
			oracleText:
				'Equipped creature gets +1/+1, has vigilance, and has "Whenever this creature attacks, you gain 2 life."\nEquip {1}',
			keywords: ['Equip']
		});
		assert.equal(compileCard(bladeCard).fullySupported, true);

		const blade = putOnBattlefield(state, p1, bladeCard, { attachTo: scout });
		assert.equal(getCreaturePower(scout, state), 3);
		assert.equal(getCreatureToughness(scout, state), 3);
		assert.equal(hasKeyword(scout, 'vigilance', state), true);

		// Enter Humility AFTER Blade was attached -> Scout loses granted Vigilance and attack trigger (CR 613.7)
		putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Nullifying Field',
				manaCost: '{2}{W}{W}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.'
			})
		);
		assert.equal(getCreaturePower(scout, state), 2); // 1/1 base + 1/+1 from Blade in 7c
		assert.equal(hasKeyword(scout, 'vigilance', state), false);

		// Attack while suppressed by Humility -> life does NOT increase
		const lifeBefore = p1.life;
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		const atk1 = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: scout.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atk1.ok, true);
		assert.equal(state.stack.length, 0);
		assert.equal(p1.life, lifeBefore);

		// Return to main1, move Blade onto another creature and re-equip to Scout -> CR 613.7e new timestamp!
		state.phase = 'main1';
		state.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		};
		const squire = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Camp Squire', typeLine: 'Creature — Human', power: '1', toughness: '1' })
		);
		p1.manaPool.C = 2;
		const eq1 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: blade.instanceId,
			abilityId: 'equip_1',
			targets: [{ kind: 'permanent', id: squire.instanceId, label: 'Camp Squire' }]
		});
		assert.equal(eq1.ok, true);
		resolveTopOfStack(state);

		const eq2 = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: blade.instanceId,
			abilityId: 'equip_1',
			targets: [{ kind: 'permanent', id: scout.instanceId, label: 'Sunlit Scout' }]
		});
		assert.equal(eq2.ok, true);
		resolveTopOfStack(state);

		// Blade's timestamp is now AFTER Humility -> Scout regains Vigilance and the attack trigger!
		assert.equal(hasKeyword(scout, 'vigilance', state), true);
		scout.tapped = false;
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		const atk2 = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: scout.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atk2.ok, true);
		assert.equal(state.stack.length, 1);
		// Ensure source of the granted trigger is Scout (~ binds to recipient, CR 107.3j)
		assert.equal(state.stack[0].sourceInstanceId, scout.instanceId);
		resolveTopOfStack(state);
		assert.equal(p1.life, lifeBefore + 2);
	});

	it('fires Layer 6 granted LKI dies triggers (CR 603.10a), multiplies independent grants (CR 113.2c), and evaluates granted replacement abilities', () => {
		const { state, p1 } = setupMain1Game();

		const lordCard = synthCard({
			name: 'Soulbound Herald',
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control have "When this creature dies, you gain 3 life."'
		});
		assert.equal(compileCard(lordCard).fullySupported, true);
		putOnBattlefield(state, p1, lordCard);
		putOnBattlefield(state, p1, synthCard({ ...lordCard, name: 'Soulbound Herald Copy' }));

		const bear = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Dusk Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
		);
		const sacOutlet = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Ash Altar',
				typeLine: 'Artifact',
				oracleText: 'Sacrifice a creature: Add {C}.'
			})
		);
		const sacAbId = getEffectiveActivatedAbilities(state, p1, sacOutlet)[0].id;

		const startLife = p1.life;
		const act = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: sacOutlet.instanceId,
			abilityId: sacAbId,
			costPayment: { objects: [[bear.instanceId]] }
		});
		assert.equal(act.ok, true);
		// Two independent Layer 6 grants -> 2 dies triggers on stack (+ APNAP trigger_order prompt)!
		assert.equal(state.stack.length, 2);
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].purpose === 'trigger_order') {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: {
						kind: 'orderObjects',
						topIds: state.pendingPrompts[0].candidateInstanceIds ?? []
					}
				}).ok,
				true
			);
		}
		resolveTopOfStack(state);
		resolveTopOfStack(state);
		assert.equal(p1.life, startLife + 6);

		// Now grant a replacement ability: "If this creature would die, exile it instead."
		const exileGrantCard = synthCard({
			name: 'Sanctified Halo',
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control have "If this creature would die, exile it instead."'
		});
		assert.equal(compileCard(exileGrantCard).fullySupported, true);
		putOnBattlefield(state, p1, exileGrantCard);

		const wolf = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Timber Wolf', typeLine: 'Creature — Wolf', power: '2', toughness: '2' })
		);
		const actExile = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: sacOutlet.instanceId,
			abilityId: sacAbId,
			costPayment: { objects: [[wolf.instanceId]] }
		});
		assert.equal(actExile.ok, true);
		assert.equal(p1.exile.some((c) => c.instanceId === wolf.instanceId), true);
		assert.equal(p1.graveyard.some((c) => c.instanceId === wolf.instanceId), false);
	});
});

describe('Track P11.2 — Dynamic Scaling Layer 7a/7b/7c P/T (Party, Domain, Attachments, Goyf) & Cost Modifiers', () => {
	it('computes exact Party bipartite matching (CR 700.8) with Changelings, Domain (CR 305.6), attachmentsOn, and Tarmogoyf CDA', () => {
		const { state, p1, p2 } = setupMain1Game();

		// 1. Party (0..4) with a Changeling
		const partyBanner = synthCard({
			name: 'Expedition Banner',
			typeLine: 'Artifact',
			oracleText: 'Creatures you control get +1/+1 for each creature in your party.'
		});
		assert.equal(compileCard(partyBanner).fullySupported, true);
		putOnBattlefield(state, p1, partyBanner);

		const shapeshifter = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Omni Shapeshifter',
				typeLine: 'Creature — Shapeshifter',
				oracleText: 'Changeling',
				keywords: ['Changeling'],
				power: '1',
				toughness: '1'
			})
		);
		// One Changeling alone fills at most 1 party slot -> party = 1 -> 2/2
		assert.equal(getCreaturePower(shapeshifter, state), 2);

		// Add Cleric -> Changeling shifts to Rogue/Warrior/Wizard -> party = 2 -> 3/3
		putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Dawn Cleric', typeLine: 'Creature — Human Cleric', power: '1', toughness: '1' })
		);
		assert.equal(getCreaturePower(shapeshifter, state), 3);

		// Add a second Cleric -> only Cleric + 1 Changeling = still 2 party roles -> 3/3!
		putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Dusk Cleric', typeLine: 'Creature — Kor Cleric', power: '1', toughness: '1' })
		);
		assert.equal(getCreaturePower(shapeshifter, state), 3);

		// Add Rogue + Warrior -> Cleric + Rogue + Warrior + Changeling(Wizard) = full party 4 -> 5/5!
		putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Alley Rogue', typeLine: 'Creature — Elf Rogue', power: '1', toughness: '1' })
		);
		putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Crag Warrior', typeLine: 'Creature — Dwarf Warrior', power: '1', toughness: '1' })
		);
		assert.equal(getCreaturePower(shapeshifter, state), 5);

		// 2. Domain (0..5) + Layer 4 subtype interactions
		const domainBrawlerCard = synthCard({
			name: 'Territorial Kavu Probe',
			typeLine: 'Creature — Kavu',
			oracleText:
				"Domain — Territorial Kavu Probe's power and toughness are each equal to the number of basic land types among lands you control.",
			power: '*',
			toughness: '*'
		});
		assert.equal(compileCard(domainBrawlerCard).fullySupported, true);
		const domainBrawler = putOnBattlefield(state, p2, domainBrawlerCard);
		putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Steam Dual', typeLine: 'Land — Island Mountain', manaCost: '', cmc: 0 })
		);
		putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Lush Forest', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0 })
		);
		// Island + Mountain + Forest = 3 domain (note: no party banner on p2)
		assert.equal(getCreaturePower(domainBrawler, state), 3);
		assert.equal(getCreatureToughness(domainBrawler, state), 3);

		// 3. attachmentsOn & Tarmogoyf CDA
		const championCard = synthCard({
			name: 'Armored Champion',
			typeLine: 'Creature — Human Knight',
			oracleText: 'Armored Champion gets +2/+2 for each Aura and Equipment attached to Armored Champion.',
			power: '2',
			toughness: '2'
		});
		assert.equal(compileCard(championCard).fullySupported, true);
		const champion = putOnBattlefield(state, p2, championCard);
		assert.equal(getCreaturePower(champion, state), 2);
		putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Iron Shield', typeLine: 'Artifact — Equipment', oracleText: '' }),
			{ attachTo: champion }
		);
		putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Holy Mantle', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature', keywords: ['Enchant'] }),
			{ attachTo: champion }
		);
		assert.equal(getCreaturePower(champion, state), 6);
		assert.equal(getCreatureToughness(champion, state), 6);

		const goyfCard = synthCard({
			name: 'Moss Lhurgoyf',
			typeLine: 'Creature — Lhurgoyf',
			oracleText:
				"Moss Lhurgoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
			power: '*',
			toughness: '1+*'
		});
		assert.equal(compileCard(goyfCard).fullySupported, true);
		const goyf = putOnBattlefield(state, p2, goyfCard);
		putInGraveyard(state, p1, synthCard({ name: 'Dead Bolt', typeLine: 'Instant' }));
		putInGraveyard(state, p2, synthCard({ name: 'Broken Automaton', typeLine: 'Artifact Creature — Golem' }));
		// Instant + Artifact + Creature = 3 card types -> 3/4!
		assert.equal(getCreaturePower(goyf, state), 3);
		assert.equal(getCreatureToughness(goyf, state), 4);
	});

	it('enforces colored-only cost reductions, conditional spell reductions, activated ability {1} floors, and Fist of Suns / Rooftop Storm alt-cast permissions', () => {
		const { state, p1, p2 } = setupMain1Game();

		// 1. Colored-only reduction (Morophon / Edgewalker / Dragonspeaker style)
		const reducerCard = synthCard({
			name: 'Crimson Bard',
			typeLine: 'Creature — Human Shaman',
			oracleText:
				'Dragon spells you cast cost {R}{R} less to cast. This effect reduces only the amount of colored mana you pay.',
			power: '2',
			toughness: '2'
		});
		assert.equal(compileCard(reducerCard).fullySupported, true);
		putOnBattlefield(state, p1, reducerCard);

		const dragonInst = putInHand(
			state,
			p1,
			synthCard({
				name: 'Cinder Dragon',
				manaCost: '{3}{R}',
				cmc: 4,
				typeLine: 'Creature — Dragon',
				power: '4',
				toughness: '4'
			})
		);
		const dragonReq = effectiveSpellManaCost(state, p1, dragonInst, 0);
		// {3}{R} reduced by {R}{R} with coloredOnly:true -> {3} (does NOT spill extra {R} into generic!)
		assert.equal(dragonReq.colored.R, 0);
		assert.equal(dragonReq.generic, 3);

		// 2. Conditional targeting spell reduction ("costs {2} less to cast if it targets a tapped creature")
		const tappedTarget = putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Sleepy Ogre', typeLine: 'Creature — Ogre', power: '3', toughness: '3' }),
			{ tapped: true }
		);
		const untappedTarget = putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Alert Ogre', typeLine: 'Creature — Ogre', power: '3', toughness: '3' }),
			{ tapped: false }
		);
		const boltCard = synthCard({
			name: 'Opportunist Strike',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Instant',
			oracleText:
				'Opportunist Strike costs {2} less to cast if it targets a tapped creature.\nOpportunist Strike deals 3 damage to target creature.'
		});
		assert.equal(compileCard(boltCard).fullySupported, true);
		const boltInst = putInHand(state, p1, boltCard);
		p1.manaPool.R = 1; // Only {R} available!
		// Targeting untapped creature costs {2}{R} -> illegal with only {R}
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boltInst.instanceId,
				targets: [{ kind: 'permanent', id: untappedTarget.instanceId, label: 'Alert Ogre' }]
			}).ok,
			false
		);
		// Targeting tapped creature costs {R} -> succeeds!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: boltInst.instanceId,
				targets: [{ kind: 'permanent', id: tappedTarget.instanceId, label: 'Sleepy Ogre' }]
			}).ok,
			true
		);
		resolveTopOfStack(state);

		// 3. Activated ability cost reduction with {1} floor (Training Grounds)
		const groundsCard = synthCard({
			name: 'Arcane Grounds',
			typeLine: 'Enchantment',
			oracleText:
				"Activated abilities of creatures you control cost {2} less to activate. This effect can't reduce the mana in that cost to less than one mana."
		});
		assert.equal(compileCard(groundsCard).fullySupported, true);
		putOnBattlefield(state, p1, groundsCard);

		const guildmage = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Azure Guildmage',
				typeLine: 'Creature — Human Wizard',
				oracleText: '{3}{U}: Draw a card.\n{2}: You gain 1 life.',
				power: '2',
				toughness: '2'
			})
		);
		const effAbs = getEffectiveActivatedAbilities(state, p1, guildmage);
		const cost0 = effectiveAbilityManaCost(
			state,
			p1.playerId,
			effAbs[0].id,
			effAbs[0].manaCost,
			effAbs[0].costKeyword,
			0,
			guildmage,
			effAbs[0].isManaAbility
		);
		const cost1 = effectiveAbilityManaCost(
			state,
			p1.playerId,
			effAbs[1].id,
			effAbs[1].manaCost,
			effAbs[1].costKeyword,
			0,
			guildmage,
			effAbs[1].isManaAbility
		);
		// {3}{U} -> {1}{U} (2 total >= 1 floor)
		assert.equal(cost0.manaCost, '{1}{U}');
		// {2} reduced by {2} with floor {1} -> {1} (NOT {0}!)
		assert.equal(cost1.manaCost, '{1}');

		// 4. Static alternative cast permissions (Rooftop Storm {0} & Fist of Suns {W}{U}{B}{R}{G})
		const rooftopCard = synthCard({
			name: 'Crypt Storm',
			typeLine: 'Enchantment',
			oracleText: 'You may pay {0} rather than pay the mana cost for Zombie creature spells you cast.'
		});
		assert.equal(compileCard(rooftopCard).fullySupported, true);
		putOnBattlefield(state, p1, rooftopCard);

		const zombieCard = synthCard({
			name: 'Colossal Zombie',
			manaCost: '{5}{B}{B}',
			cmc: 7,
			typeLine: 'Creature — Zombie Giant',
			power: '7',
			toughness: '7'
		});
		const zombieInst = putInHand(state, p1, zombieCard);
		const zOpts = getCastOptions(state, p1.playerId, zombieInst, 'hand');
		const freeAlt = zOpts.find((o) => o.permission === 'static_alt');
		assert.ok(freeAlt, 'expected static alternative cast option from Crypt Storm');
		const castFree = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: zombieInst.instanceId,
			optionId: freeAlt.id
		});
		assert.equal(castFree.ok, true);
		resolveTopOfStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === zombieInst.instanceId), true);
	});
});

describe('Track P11.3 — Ability & Finality Counters, Replacements (Hardened Scales, Torbran CR 614.7a, Life, Chosen Name) & Untap/Toughness/Hand/Draw', () => {
	it('evaluates Layer 6 keyword counters with CR 613.7c timestamps, finality exile replacement (CR 122.1d), ETB counter choices, and Hardened Scales +1', () => {
		const { state, p1, p2 } = setupMain1Game();

		// Hardened Scales (+1 to +1/+1 counters placed on creatures you control)
		const scalesCard = synthCard({
			name: 'Chitin Scales',
			typeLine: 'Enchantment',
			oracleText:
				'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.'
		});
		assert.equal(compileCard(scalesCard).fullySupported, true);
		putOnBattlefield(state, p1, scalesCard);

		// Choice-of-counter ETB creature
		const wingChoiceCard = synthCard({
			name: 'Adaptable Griffin',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Creature — Griffin',
			oracleText: 'Adaptable Griffin enters with your choice of a flying counter or a lifelink counter on it.',
			power: '2',
			toughness: '2'
		});
		assert.equal(compileCard(wingChoiceCard).fullySupported, true);
		const griffinHand = putInHand(state, p1, wingChoiceCard);
		p1.manaPool.W = 3;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: griffinHand.instanceId
			}).ok,
			true
		);
		resolveTopOfStack(state);
		// Prompted to choose flying (0) or lifelink (1)
		assert.equal(state.pendingPrompts.length, 1);
		const pickLifelink = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: state.pendingPrompts[0].id,
			answer: { kind: 'chooseMode', indices: [1] }
		});
		assert.equal(pickLifelink.ok, true);
		const griffin = p1.battlefield.find((c) => c.instanceId === griffinHand.instanceId)!;
		assert.equal(griffin.counters.lifelink, 1);
		assert.equal(hasKeyword(griffin, 'lifelink', state), true);

		// Add +1/+1 counter -> Hardened Scales increases 1 -> 2!
		addCountersToPermanent(state, griffin, '+1/+1', 1);
		assert.equal(griffin.counters['+1/+1'], 2);

		// Timestamp check (CR 613.7c): Humility enters AFTER lifelink counter -> removes lifelink;
		// then adding a trample counter AFTER Humility grants trample!
		putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Ability Eraser',
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities.'
			})
		);
		assert.equal(hasKeyword(griffin, 'lifelink', state), false);
		addCountersToPermanent(state, griffin, 'trample', 1);
		assert.equal(hasKeyword(griffin, 'trample', state), true);

		// Finality counter (CR 122.1d): dying permanent is exiled instead!
		addCountersToPermanent(state, griffin, 'finality', 1);
		const destroyBolt = putInHand(
			state,
			p2,
			synthCard({
				name: 'Void Doom',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			})
		);
		state.priorityPlayerIndex = 1;
		p2.manaPool.B = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: destroyBolt.instanceId,
				targets: [{ kind: 'permanent', id: griffin.instanceId, label: 'Adaptable Griffin' }]
			}).ok,
			true
		);
		resolveTopOfStack(state);
		assert.equal(p1.exile.some((c) => c.instanceId === griffin.instanceId), true);
		assert.equal(p1.graveyard.some((c) => c.instanceId === griffin.instanceId), false);
	});

	it('applies Torbran static damage addition while keeping 0 damage at 0 (CR 614.7a), life-gain replacements, and Doran toughness combat damage (CR 510.1a)', () => {
		const { state, p1, p2 } = setupMain1Game();

		// 1. Torbran: +2 damage from red sources you control to opponent/opponent perm, 0 stays 0!
		const torbranCard = synthCard({
			name: 'Thane of Red Fell',
			manaCost: '{1}{R}{R}{R}',
			cmc: 4,
			colors: ['R'],
			typeLine: 'Legendary Creature — Dwarf Noble',
			oracleText:
				'If a red source you control would deal damage to an opponent or a permanent an opponent controls, it deals that much damage plus 2 instead.',
			power: '2',
			toughness: '4'
		});
		assert.equal(compileCard(torbranCard).fullySupported, true);
		putOnBattlefield(state, p1, torbranCard);

		// 0-power red attacker deals 0 combat damage -> CR 614.7a MUST stay 0 (NOT 2)!
		const zeroWall = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Ember Imp',
				colors: ['R'],
				typeLine: 'Creature — Imp',
				power: '0',
				toughness: '3'
			})
		);
		const lifeStart = p2.life;
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: zeroWall.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		// Pass through declare_attackers -> declare_blockers -> combat_damage
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(p2.life, lifeStart, '0-power red creature must deal 0 damage under Torbran (CR 614.7a)');

		// Now add Doran ("Each creature you control assigns combat damage equal to its toughness rather than its power")!
		state.phase = 'declare_attackers';
		state.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		};
		state.priorityPlayerIndex = 0;
		const doranCard = synthCard({
			name: 'Bastion Tower',
			typeLine: 'Enchantment',
			oracleText: 'Each creature you control assigns combat damage equal to its toughness rather than its power.'
		});
		assert.equal(compileCard(doranCard).fullySupported, true);
		putOnBattlefield(state, p1, doranCard);

		// 0/3 red creature now assigns 3 combat damage by toughness, +2 from Torbran = 5!
		zeroWall.tapped = false;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: zeroWall.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(p2.life, lifeStart - 5);

		// 2. Life gain +1, x2, and cantGainLife
		state.phase = 'main1';
		state.priorityPlayerIndex = 0;
		const boonCard = synthCard({
			name: 'Vitality Reflection',
			typeLine: 'Enchantment',
			oracleText:
				'If you would gain life, you gain that much life plus 1 instead.\nIf you would gain life, you gain twice that much life instead.'
		});
		assert.equal(compileCard(boonCard).fullySupported, true);
		putOnBattlefield(state, p1, boonCard);

		const salve = putInHand(
			state,
			p1,
			synthCard({
				name: 'Warm Salve',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'You gain 3 life.'
			})
		);
		const p1BeforeSalve = p1.life;
		p1.manaPool.W = 1;
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: salve.instanceId }).ok, true);
		resolveTopOfStack(state);
		// (3 + 1) * 2 = 8 life gained!
		assert.equal(p1.life, p1BeforeSalve + 8);
	});

	it('enforces Pithing Needle & Meddling Mage chosen card name (CR 201.2a), optional untap (CR 502.3), max hand size timestamp order, and skipDrawStep', () => {
		const targetSpellCard = synthCard({
			name: 'Arcane Bolt',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: 'Arcane Bolt deals 2 damage to any target.'
		});
		const targetArtifactCard = synthCard({
			name: 'Relic Cannon',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: '{T}: Add {C}.\n{1}, {T}: Draw a card.'
		});
		const { state, p1, p2 } = setupMain1Game({ deckCards: [targetSpellCard, targetArtifactCard] });

		const boltInP2Hand = putInHand(state, p2, targetSpellCard);
		const cannonOnP2 = putOnBattlefield(state, p2, targetArtifactCard);

		// 1. Meddling Mage + Pithing Needle combined test
		const needleCard = synthCard({
			name: 'Runed Needle',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Artifact',
			oracleText:
				"As Runed Needle enters, choose a card name.\nActivated abilities of sources with the chosen name can't be activated unless they're mana abilities."
		});
		const mageCard = synthCard({
			name: 'Lawmage Arbiter',
			manaCost: '{W}{U}',
			cmc: 2,
			typeLine: 'Creature — Human Wizard',
			oracleText:
				"As Lawmage Arbiter enters, choose a nonland card name.\nSpells with the chosen name can't be cast.",
			power: '2',
			toughness: '2'
		});
		assert.equal(compileCard(needleCard).fullySupported, true);
		assert.equal(compileCard(mageCard).fullySupported, true);

		// Cast Runed Needle naming "Relic Cannon"
		const needleHand = putInHand(state, p1, needleCard);
		p1.manaPool.C = 1;
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: needleHand.instanceId }).ok, true);
		resolveTopOfStack(state);
		assert.equal(state.pendingPrompts.length, 1);
		const needleModes =
			state.pendingPrompts[0].choice?.kind === 'chooseMode' ? state.pendingPrompts[0].choice.modes : [];
		const cannonIdx = needleModes.indexOf('Relic Cannon');
		assert.ok(cannonIdx >= 0, 'Relic Cannon must be in candidate card names');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [cannonIdx] }
			}).ok,
			true
		);

		// Relic Cannon's non-mana ability is blocked, while its mana ability is still legal!
		state.priorityPlayerIndex = 1;
		p2.manaPool.C = 2;
		const cannonAbs = getEffectiveActivatedAbilities(state, p2, cannonOnP2);
		const manaAb = cannonAbs.find((a) => a.isManaAbility)!;
		const nonManaAb = cannonAbs.find((a) => !a.isManaAbility)!;
		assert.equal(checkAbilityActivationLegality(state, p2.playerId, cannonOnP2, nonManaAb).ok, false);
		assert.equal(checkAbilityActivationLegality(state, p2.playerId, cannonOnP2, manaAb).ok, true);

		// Cast Lawmage Arbiter naming "Arcane Bolt"
		state.priorityPlayerIndex = 0;
		const mageHand = putInHand(state, p1, mageCard);
		p1.manaPool.W = 1;
		p1.manaPool.U = 1;
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: mageHand.instanceId }).ok, true);
		resolveTopOfStack(state);
		const mageModes =
			state.pendingPrompts[0].choice?.kind === 'chooseMode' ? state.pendingPrompts[0].choice.modes : [];
		const boltIdx = mageModes.indexOf('Arcane Bolt');
		assert.ok(boltIdx >= 0);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [boltIdx] }
			}).ok,
			true
		);
		state.priorityPlayerIndex = 1;
		p2.manaPool.R = 1;
		assert.equal(checkSpellCastLegality(state, p2.playerId, boltInP2Hand).ok, false);

		// 2. Max hand size timestamp order (CR 613.10): noMaxHandSize followed by setMaxHandSize 2 -> 2; delta -1 -> 1!
		putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Reliquary Tower Probe', typeLine: 'Land', oracleText: 'You have no maximum hand size.' })
		);
		assert.equal(computeEffectiveMaxHandSize(state, p1.playerId), null);
		putOnBattlefield(
			state,
			p2,
			synthCard({ name: 'Cursed Rack Probe', typeLine: 'Artifact', oracleText: "Each opponent's maximum hand size is two." })
		);
		assert.equal(computeEffectiveMaxHandSize(state, p1.playerId), 2);
		putOnBattlefield(
			state,
			p2,
			synthCard({
				name: 'Miser Locust',
				typeLine: 'Creature — Insect',
				oracleText: "Each opponent's maximum hand size is reduced by one.",
				power: '1',
				toughness: '1'
			})
		);
		assert.equal(computeEffectiveMaxHandSize(state, p1.playerId), 1);

		// 3. Optional untap (CR 502.3) + Skip your draw step (CR 504.1) on p1's next turn
		const rubiniaCard = synthCard({
			name: 'Tidal Monolith',
			typeLine: 'Artifact',
			oracleText: 'You may choose not to untap Tidal Monolith during your untap step.\nSkip your draw step.'
		});
		assert.equal(compileCard(rubiniaCard).fullySupported, true);
		const monolith = putOnBattlefield(state, p1, rubiniaCard, { tapped: true });

		// Advance from p2's end_step into p1's untap step!
		state.activePlayerIndex = 1;
		state.phase = 'end_step';
		state.priorityPlayerIndex = 1;
		state.passedPriorityPlayerIds = [];
		p1.library.push(createCardInstance(targetSpellCard, p1.playerId, 'library'));
		const p1HandBeforeTurn = p1.hand.length;

		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });

		// Untap step pauses with prompt asking whether to untap Tidal Monolith!
		assert.equal(state.pendingPrompts.length, 1);
		// Choose index 1 ("Keep tapped")
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseMode', indices: [1] }
			}).ok,
			true
		);
		assert.equal(monolith.tapped, true, 'Tidal Monolith stays tapped when choosing mode 1');
		assert.equal(state.phase, 'upkeep');

		// Pass upkeep -> draw step is skipped ("Skip your draw step"), no card drawn!
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(p1.hand.length, p1HandBeforeTurn, 'Draw step was skipped');
	});
});

describe('Track P11.4 — Snow {S}, Phyrexian {W/P} & {W/U/P}, Twobrid {2/W}, Non-Mana Costs & Rename Invariance', () => {
	it('tracks Snow {S} mana production & conservation (CR 107.4h), Twobrid {2/W} MV === 2 (CR 202.3f), and Phyrexian life-payment locks (CR 119.4, 119.8)', () => {
		const { state, p1 } = setupMain1Game();

		// 1. Twobrid {2/W}{2/W} has MV === 4 (CR 202.3f)
		const twobridReq = parseManaCost('{2/W}{2/W}');
		assert.equal(twobridReq.totalCmc, 4);

		// 2. Snow {S}: non-snow Forest cannot pay {S}, Snow-Covered Forest can, and generic {1} conserves snow mana!
		const snowViperCard = synthCard({
			name: 'Rimefang Viper',
			manaCost: '{S}',
			cmc: 1,
			typeLine: 'Snow Creature — Snake',
			oracleText: 'Deathtouch',
			keywords: ['Deathtouch'],
			power: '1',
			toughness: '1'
		});
		assert.equal(compileCard(snowViperCard).fullySupported, true);
		const viperHand = putInHand(state, p1, snowViperCard);

		const normalForest = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Normal Forest', manaCost: '', cmc: 0, typeLine: 'Basic Land — Forest', oracleText: '{T}: Add {G}.' })
		);
		// Only non-snow Forest available -> cannot cast {S} spell!
		assert.equal(checkSpellCastLegality(state, p1.playerId, viperHand).ok, false);

		const snowForest = putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Snow-Covered Forest',
				manaCost: '',
				cmc: 0,
				typeLine: 'Basic Snow Land — Forest',
				oracleText: '{T}: Add {G}.'
			})
		);
		// Tap both lands into pool (1 non-snow {G}, 1 snow {G}), cast a {1} artifact first -> conserves snow {G}!
		assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: normalForest.instanceId }).ok, true);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: snowForest.instanceId }).ok, true);
		const bauble = putInHand(
			state,
			p1,
			synthCard({ name: 'Tin Bauble', manaCost: '{1}', cmc: 1, typeLine: 'Artifact', oracleText: '' })
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: bauble.instanceId }).ok, true);
		resolveTopOfStack(state);

		// Remaining {G} in pool is still snow mana -> can pay {S} for Rimefang Viper!
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: viperHand.instanceId }).ok, true);
		resolveTopOfStack(state);

		// 3. Phyrexian {W/P} & Hybrid-Phyrexian {G/U/P}: MV === 1 per pip, blocked at life < 2 and under Platinum Emperion!
		assert.equal(parseManaCost('{1}{G}{G/U/P}{U}').totalCmc, 4);
		const phyProbeCard = synthCard({
			name: 'Porcelain Probe',
			manaCost: '{W/P}',
			cmc: 1,
			typeLine: 'Artifact Creature — Myr',
			power: '1',
			toughness: '1'
		});
		const probe1 = putInHand(state, p1, phyProbeCard);
		// No mana available, p1.life === 40 -> pays 2 life!
		const lifeBeforeProbe = p1.life;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: probe1.instanceId,
				costPayment: { phyrexianLifeCount: 1 }
			}).ok,
			true
		);
		assert.equal(p1.life, lifeBeforeProbe - 2);
		resolveTopOfStack(state);

		// At 1 life, cannot pay 2 life (CR 119.4)!
		const probe2 = putInHand(state, p1, phyProbeCard);
		p1.life = 1;
		assert.equal(checkSpellCastLegality(state, p1.playerId, probe2).ok, false);

		// At 20 life under Platinum Emperion ("Your life total can't change."), cannot pay 2 life (CR 119.8)!
		p1.life = 20;
		putOnBattlefield(
			state,
			p1,
			synthCard({
				name: 'Emperion Sentinel',
				typeLine: 'Artifact Creature — Golem',
				oracleText: "Your life total can't change.",
				power: '8',
				toughness: '8'
			})
		);
		assert.equal(checkSpellCastLegality(state, p1.playerId, probe2).ok, false);
	});

	it('executes generalized bounce, mill, removeCounters ("from among"), and permanent additional costs, and upholds rename invariance', () => {
		const { state, p1 } = setupMain1Game();
		p1.library.push(
			createCardInstance(synthCard({ name: 'Lib Card 1', typeLine: 'Artifact' }), p1.playerId, 'library'),
			createCardInstance(synthCard({ name: 'Lib Card 2', typeLine: 'Artifact' }), p1.playerId, 'library')
		);

		const land = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Bounceland', manaCost: '', cmc: 0, typeLine: 'Land', oracleText: '' })
		);
		const c1 = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Bearer One', typeLine: 'Creature — Elf', power: '1', toughness: '1' })
		);
		const c2 = putOnBattlefield(
			state,
			p1,
			synthCard({ name: 'Bearer Two', typeLine: 'Creature — Elf', power: '1', toughness: '1' })
		);
		addCountersToPermanent(state, c1, '+1/+1', 1);
		addCountersToPermanent(state, c2, '+1/+1', 1);

		const engineArtifact = synthCard({
			name: 'Aether Centrifuge',
			typeLine: 'Artifact',
			oracleText:
				"Return a land you control to its owner's hand, Mill two cards, Remove two +1/+1 counters from among creatures you control: You gain 4 life."
		});
		assert.equal(compileCard(engineArtifact).fullySupported, true);
		const centrifuge = putOnBattlefield(state, p1, engineArtifact);
		const centrifugeAbId = getEffectiveActivatedAbilities(state, p1, centrifuge)[0].id;

		const startLife = p1.life;
		const act = applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: centrifuge.instanceId,
			abilityId: centrifugeAbId
		});
		assert.equal(act.ok, true);
		assert.equal(p1.hand.some((c) => c.instanceId === land.instanceId), true);
		assert.equal(p1.graveyard.length, 2);
		assert.equal(c1.counters['+1/+1'], 0);
		assert.equal(c2.counters['+1/+1'], 0);
		resolveTopOfStack(state);
		assert.equal(p1.life, startLife + 4);

		// Permanent spell with "As an additional cost to cast ~, sacrifice a creature."
		const demonCard = synthCard({
			name: 'Ravenous Fiend',
			manaCost: '{1}{B}',
			cmc: 2,
			typeLine: 'Creature — Demon',
			oracleText: 'As an additional cost to cast Ravenous Fiend, sacrifice a creature.\nFlying',
			keywords: ['Flying'],
			power: '5',
			toughness: '5'
		});
		assert.equal(compileCard(demonCard).fullySupported, true);
		const demonHand = putInHand(state, p1, demonCard);
		p1.manaPool.B = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: demonHand.instanceId,
				costPayment: { objects: [[c1.instanceId]] }
			}).ok,
			true
		);
		assert.equal(p1.graveyard.some((c) => c.instanceId === c1.instanceId), true);
		resolveTopOfStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === demonHand.instanceId), true);

		// Rename invariance across Track P11 constructs
		const complexOracle = (selfName: string) =>
			`As ${selfName} enters, choose a nonland card name.\n` +
			`Spells with the chosen name can't be cast.\n` +
			`${selfName} gets +2/+2 for each Aura and Equipment attached to ${selfName}.\n` +
			`Other creatures you control have "Whenever this creature attacks, you gain 1 life."\n` +
			`Remove an oil counter from ${selfName}, Mill a card: Draw a card.`;
		const alpha = compileCard(synthCard({ name: 'Alpha P11 Probe', oracleText: complexOracle('Alpha P11 Probe') }));
		const omega = compileCard(synthCard({ name: 'Omega P11 Mirror', oracleText: complexOracle('Omega P11 Mirror') }));
		assert.equal(alpha.fullySupported, true);
		assert.deepEqual(alpha.faces[0].abilities, omega.faces[0].abilities);
	});
});
