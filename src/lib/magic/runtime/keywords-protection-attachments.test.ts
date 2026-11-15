import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getEffectiveActivatedAbilities,
	resolveTopOfStack
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';
import { subscribeEvents } from './events.ts';
import { setLayerCacheCheck, withStableLayerInputs } from './layerCache.ts';
import * as zonesModule from './zones.ts';
const { transferBattlefieldControl } = zonesModule;

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
		typeLine: overrides.typeLine ?? 'Creature — Human',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
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

function makeGame(): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [];
	const decks = new Map<number, (typeof PRECON_DECKS)[number]>();
	for (let i = 0; i < 2; i++) {
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
	const state = createInitialGameState('KEYWORDS_PROT_ATTACH_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES
	});
	applyGameAction(state, 'p1', { type: 'mulligan_keep' });
	applyGameAction(state, 'p2', { type: 'mulligan_keep' });
	for (const pl of state.players) {
		pl.hand = [];
		pl.battlefield = [];
		pl.graveyard = [];
		pl.exile = [];
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
	zone: Exclude<ZoneType, 'stack'>,
	opts: { summoningSick?: boolean } = {}
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') {
		inst.summoningSick = opts.summoningSick ?? false;
	}
	player[zone].push(inst);
	return inst;
}

function passStep(state: GameState): void {
	const startPhase = state.phase;
	const startStack = state.stack.length;
	let guard = 0;
	while (guard++ < 10 && state.pendingPrompts.length === 0 && state.status !== 'finished') {
		const prio = state.players[state.priorityPlayerIndex];
		assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
		if (startStack > 0 && state.stack.length < startStack) break;
		if (startStack === 0 && state.phase !== startPhase) break;
	}
}

describe('Keyword: Indestructible (CR 702.12)', () => {
	it('compiles Indestructible, survives destroy & lethal/deathtouch damage, still dies to sacrifice, <=0 toughness, and Legend Rule, still gets exiled, and handles gain/loss (CR 702.12b–c, 704.5f–j)', () => {
		const indIr = compileCard(
			syntheticCard({ name: 'Darksteel Sentinel', oracleText: 'Flying, indestructible' })
		).faces[0];
		assert.ok(
			indIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'indestructible')
		);
		assert.equal(indIr.abilities.some((a) => a.kind === 'unsupported'), false);

		const { state, p1, p2 } = makeGame();

		// 1. Survives lethal marked damage AND global Wrath of God!
		const indColossus = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Darksteel Brute',
				typeLine: 'Artifact Creature — Golem',
				power: '4',
				toughness: '4',
				oracleText: 'Indestructible',
				keywords: ['Indestructible']
			}),
			'battlefield'
		);
		const normalBear = putInZone(state, p1, syntheticCard({ name: 'Grizzly Bears' }), 'battlefield');

		const bolt5 = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Lava Axe Creature',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Lava Axe Creature deals 5 damage to target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: bolt5.instanceId,
				targets: [{ kind: 'permanent', id: indColossus.instanceId, label: indColossus.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(indColossus.damageMarked, 5);
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === indColossus.instanceId),
			'Indestructible survives lethal marked damage >= toughness'
		);

		state.priorityPlayerIndex = 0;
		const wrath = putInZone(state, p1, staple('Wrath of God'), 'hand');
		p1.manaPool.W = 2;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wrath.instanceId }).ok,
			true
		);
		passStep(state);
		assert.ok(p1.graveyard.some((c) => c.instanceId === normalBear.instanceId));
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === indColossus.instanceId),
			'Indestructible survives Wrath of God'
		);

		// 2. Dies to Sacrifice!
		const sacInd = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Edict Victim',
				oracleText: 'Indestructible',
				keywords: ['Indestructible']
			}),
			'battlefield'
		);
		const edict = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Diabolic Edict',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target player sacrifices a creature.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: edict.instanceId,
				targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
			}).ok,
			true
		);
		passStep(state);
		if (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0];
			applyGameAction(state, p2.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseObjects', objectIds: [sacInd.instanceId] }
			});
		}
		assert.ok(
			p2.graveyard.some((c) => c.instanceId === sacInd.instanceId),
			'Indestructible creature still dies when sacrificed'
		);

		// 3. Dies to <= 0 toughness (-4/-4 on 4/4)!
		const shrink = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Grasp of Darkness',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gets -4/-4 until end of turn.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: shrink.instanceId,
				targets: [{ kind: 'permanent', id: indColossus.instanceId, label: indColossus.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === indColossus.instanceId),
			'Indestructible creature with toughness <= 0 dies via SBA (CR 704.5f)'
		);

		// 4. Legend Rule (CR 704.5j) puts duplicate Legendary Indestructible permanent into graveyard, and Exile still exiles the kept one!
		state.priorityPlayerIndex = 0;
		const legCard = syntheticCard({
			name: 'Avacyn, Test Angel',
			manaCost: '{0}',
			cmc: 0,
			typeLine: 'Legendary Creature — Angel',
			power: '4',
			toughness: '4',
			oracleText: 'Indestructible',
			keywords: ['Indestructible']
		});
		const leg1 = putInZone(state, p1, legCard, 'battlefield');
		const leg2 = putInZone(state, p1, legCard, 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: leg2.instanceId }).ok,
			true
		);
		passStep(state);
		const legendPrompt = state.pendingPrompts.find((pr) => (pr.purpose ?? pr.kind) === 'legend_rule');
		assert.ok(legendPrompt, 'Legend rule prompts even when both copies have Indestructible');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'legend_rule_keep',
				keepInstanceId: leg1.instanceId
			}).ok,
			true
		);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === leg2.instanceId),
			'Unkept Legendary Indestructible copy goes to graveyard via Legend Rule (CR 704.5j)'
		);

		// Exile via Swords to Plowshares!
		const plow = putInZone(state, p2, staple('Swords to Plowshares'), 'hand');
		p2.manaPool.W = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: plow.instanceId,
				targets: [{ kind: 'permanent', id: leg1.instanceId, label: leg1.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.ok(
			p1.exile.some((c) => c.instanceId === leg1.instanceId),
			'Indestructible does not prevent exile'
		);

		// 5. Gain (Heroic Intervention saves from Wrath of God) & Loss (removeKeywords / losesAllAbilities)
		state.priorityPlayerIndex = 0;
		const savedBear = putInZone(state, p1, syntheticCard({ name: 'Saved Bear' }), 'battlefield');
		const heroic = putInZone(state, p1, staple('Heroic Intervention'), 'hand');
		p1.manaPool.G = 1;
		p1.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: heroic.instanceId }).ok,
			true
		);
		passStep(state);
		assert.ok(
			evaluatePermanent(state, savedBear).keywords.some((k) => k.toLowerCase() === 'indestructible')
		);
		const wrath2 = putInZone(state, p1, staple('Wrath of God'), 'hand');
		p1.manaPool.W = 2;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wrath2.instanceId }).ok,
			true
		);
		passStep(state);
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === savedBear.instanceId),
			'Heroic Intervention granted Indestructible and saved creature from Wrath of God'
		);

		// P2 casts a Layer 6 keyword-removal enchantment ("Creatures your opponents control lose hexproof and indestructible.") and destroys Saved Bear!
		const stripEnch = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Mortality Field',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment',
				oracleText: 'Creatures your opponents control lose hexproof and indestructible.'
			}),
			'hand'
		);
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: stripEnch.instanceId })
				.ok,
			true
		);
		passStep(state);
		assert.equal(
			evaluatePermanent(state, savedBear).keywords.some((k) => k.toLowerCase() === 'indestructible'),
			false,
			'Layer 6 removeKeywords strips Indestructible'
		);

		const murder = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Doom Blade',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: murder.instanceId,
				targets: [{ kind: 'permanent', id: savedBear.instanceId, label: savedBear.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.ok(p1.graveyard.some((c) => c.instanceId === savedBear.instanceId));
	});

	it('Activated keyword-removal abilities on Shadowspear, Arcane Lighthouse, Bonds of Mortality, and a synthetic card only strip keywords after activation until end of turn, respect CR 613.7 timestamps and CR 113.11 cantHaveOrGain, and expire at cleanup (CR 514.2)', () => {
		const nullveilObelisk = syntheticCard({
			name: 'Nullveil Obelisk',
			typeLine: 'Artifact',
			oracleText: '{2}: Permanents your opponents control lose hexproof and indestructible until end of turn.'
		});
		const beaconSynthetic = syntheticCard({
			name: 'Glimmerfen Beacon',
			typeLine: 'Artifact',
			oracleText:
				"{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud."
		});

		// 1. All three printed cards and both synthetic cards compile with fullySupported: true
		for (const card of [
			staple('Shadowspear'),
			staple('Arcane Lighthouse'),
			staple('Bonds of Mortality'),
			nullveilObelisk,
			beaconSynthetic
		]) {
			const def = compileCard(card);
			assert.equal(
				def.fullySupported,
				true,
				`${card.name} should compile as fullySupported (got: ${JSON.stringify(def.faces[0].abilities)})`
			);
		}

		const { state, p1, p2 } = makeGame();

		const hasKw = (perm: CardInstance, kw: string) =>
			evaluatePermanent(state, perm).keywords.some((k) => k.toLowerCase() === kw.toLowerCase());

		const advanceToNextTurnMain = () => {
			const startTurn = state.turnNumber;
			let guard = 0;
			while (state.turnNumber === startTurn && guard++ < 40) {
				passStep(state);
			}
			assert.equal(state.turnNumber, startTurn + 1);
			while (state.phase !== 'main1' && guard++ < 40) {
				passStep(state);
			}
			assert.equal(state.phase, 'main1');
		};

		// P1 controls:
		// - stalker: Creature with innate Hexproof + Indestructible
		// - knightBlack: Creature with innate Hexproof from black
		// - shroudCalc: Creature with innate Shroud
		// - aegisRelic: Non-creature Artifact with innate Hexproof + Indestructible
		// - squire: Vanilla creature for testing Equipment grants after removal
		const stalker = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Sacred Stalker',
				oracleText: 'Hexproof, indestructible',
				keywords: ['Hexproof', 'Indestructible']
			}),
			'battlefield'
		);
		const knightBlack = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Duskwarden Knight',
				oracleText: 'Hexproof from black',
				keywords: ['Hexproof']
			}),
			'battlefield'
		);
		const shroudCalc = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Veiled Gargoyle', oracleText: 'Shroud', keywords: ['Shroud'] }),
			'battlefield'
		);
		const aegisRelic = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Aegis Relic',
				typeLine: 'Artifact',
				power: undefined,
				toughness: undefined,
				oracleText: 'Hexproof, indestructible',
				keywords: ['Hexproof', 'Indestructible']
			}),
			'battlefield'
		);
		const squire = putInZone(state, p1, syntheticCard({ name: 'Plain Squire' }), 'battlefield');
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		const greaves = putInZone(state, p1, staple('Lightning Greaves'), 'battlefield');

		// P2 controls Shadowspear, Arcane Lighthouse, Bonds of Mortality, and synthetic Nullveil Obelisk
		const spear = putInZone(state, p2, staple('Shadowspear'), 'battlefield');
		const lighthouse = putInZone(state, p2, staple('Arcane Lighthouse'), 'battlefield');
		const bonds = putInZone(state, p2, staple('Bonds of Mortality'), 'battlefield');
		const obelisk = putInZone(state, p2, nullveilObelisk, 'battlefield');

		const makeBlackDestroy = (name: string) =>
			putInZone(
				state,
				p2,
				syntheticCard({
					name,
					manaCost: '{0}',
					cmc: 0,
					colors: ['B'],
					typeLine: 'Instant',
					oracleText: 'Destroy target permanent.'
				}),
				'hand'
			);

		// 2. BEFORE activating any ability: all P1 permanents KEEP their keywords!
		assert.equal(hasKw(stalker, 'hexproof'), true);
		assert.equal(hasKw(stalker, 'indestructible'), true);
		assert.equal(hasKw(knightBlack, 'hexproof from black'), true);
		assert.equal(hasKw(shroudCalc, 'shroud'), true);
		assert.equal(hasKw(aegisRelic, 'hexproof'), true);
		assert.equal(hasKw(aegisRelic, 'indestructible'), true);

		const earlyKill = makeBlackDestroy('Early Dreadbore');
		state.priorityPlayerIndex = 1;
		for (const protectedPerm of [stalker, knightBlack, shroudCalc, aegisRelic]) {
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: earlyKill.instanceId,
					targets: [{ kind: 'permanent', id: protectedPerm.instanceId, label: protectedPerm.card.name }]
				}).ok,
				false,
				`${protectedPerm.card.name} must NOT be targetable by opponent while hate cards are unactivated`
			);
		}

		// 3. Activate Bonds of Mortality ({G}): strips Hexproof + Indestructible from opponent CREATURES only!
		const bondsAb = getEffectiveActivatedAbilities(state, p2, bonds).find((a) => !a.isManaAbility)!;
		p2.manaPool.G = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: bonds.instanceId,
				abilityId: bondsAb.id
			}).ok,
			true
		);
		// Still on the stack before resolution -> keywords still present!
		assert.equal(hasKw(stalker, 'hexproof'), true);
		passStep(state); // Resolve Bonds of Mortality ability

		assert.equal(hasKw(stalker, 'hexproof'), false);
		assert.equal(hasKw(stalker, 'indestructible'), false);
		assert.equal(hasKw(knightBlack, 'hexproof from black'), false);
		assert.equal(hasKw(shroudCalc, 'shroud'), true, 'Bonds of Mortality does not strip Shroud');
		assert.equal(
			hasKw(aegisRelic, 'hexproof'),
			true,
			'Bonds of Mortality only affects creatures, not non-creature artifacts'
		);
		assert.equal(hasKw(aegisRelic, 'indestructible'), true);

		// 4. Activate Shadowspear ({1}): strips Hexproof + Indestructible from ALL opponent permanents (including Aegis Relic)!
		const spearAb = getEffectiveActivatedAbilities(state, p2, spear).find(
			(a) => !a.isManaAbility && a.id.startsWith('act_')
		)!;
		p2.manaPool.C = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: spear.instanceId,
				abilityId: spearAb.id
			}).ok,
			true
		);
		passStep(state);

		assert.equal(hasKw(aegisRelic, 'hexproof'), false);
		assert.equal(hasKw(aegisRelic, 'indestructible'), false);

		// CR 613.7 timestamp order: Shadowspear lacks "can't have or gain", so a LATER temporary grant
		// ("Target creature gains hexproof until end of turn.") AND a LATER Equipment attach (Swiftfoot Boots, CR 613.7e) WIN!
		const guile1 = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Sheltering Veil',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gains hexproof until end of turn.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: guile1.instanceId,
				targets: [{ kind: 'permanent', id: stalker.instanceId, label: stalker.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(
			hasKw(stalker, 'hexproof'),
			true,
			'Later temporary grant beats earlier Shadowspear resolution in Layer 6 timestamp order (CR 613.7b)'
		);

		// Equip Swiftfoot Boots ({1}) onto knightBlack (which was in Shadowspear's affected set) AFTER Shadowspear resolved -> newer timestamp wins!
		const bootsEquip = getEffectiveActivatedAbilities(state, p1, boots).find((a) =>
			a.id.startsWith('equip_')
		)!;
		p1.manaPool.C = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: bootsEquip.id,
				targets: [{ kind: 'permanent', id: knightBlack.instanceId, label: knightBlack.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(boots.attachedToId, knightBlack.instanceId);
		assert.equal(
			hasKw(knightBlack, 'hexproof'),
			true,
			'Later Swiftfoot Boots attachment (CR 613.7e) beats earlier Shadowspear resolution on affected creature'
		);

		// 5. Activate Arcane Lighthouse ({1}, {T}): strips Hexproof + Shroud AND blocks later gains ("can't have hexproof or shroud", CR 113.11)!
		const lighthouseAb = getEffectiveActivatedAbilities(state, p2, lighthouse).find(
			(a) => !a.isManaAbility && a.id.startsWith('act_')
		)!;
		p2.manaPool.C = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: lighthouse.instanceId,
				abilityId: lighthouseAb.id
			}).ok,
			true
		);
		assert.equal(lighthouse.tapped, true);
		passStep(state);

		assert.equal(hasKw(stalker, 'hexproof'), false);
		assert.equal(hasKw(knightBlack, 'hexproof'), false);
		assert.equal(hasKw(shroudCalc, 'shroud'), false);

		// Attempt to re-grant Hexproof via spell AND Shroud via Lightning Greaves AFTER Arcane Lighthouse resolved -> BOTH BLOCKED!
		const guile2 = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Second Sheltering Veil',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gains hexproof until end of turn.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: guile2.instanceId,
				targets: [{ kind: 'permanent', id: stalker.instanceId, label: stalker.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(
			hasKw(stalker, 'hexproof'),
			false,
			'Arcane Lighthouse cantHaveOrGain prevents affected creature from gaining Hexproof later in the turn (CR 113.11)'
		);

		const greavesEquip = getEffectiveActivatedAbilities(state, p1, greaves).find((a) =>
			a.id.startsWith('equip_')
		)!;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: greaves.instanceId,
				abilityId: greavesEquip.id,
				targets: [{ kind: 'permanent', id: squire.instanceId, label: squire.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(greaves.attachedToId, squire.instanceId);
		assert.equal(
			hasKw(squire, 'shroud'),
			false,
			'Arcane Lighthouse cantHaveOrGain prevents Lightning Greaves from granting Shroud to affected creature'
		);
		assert.equal(
			hasKw(squire, 'haste'),
			true,
			'Lightning Greaves still grants Haste while Shroud is prevented'
		);

		// CR 611.2c: A creature entering AFTER Arcane Lighthouse resolved was not in the locked-in set, so it keeps innate Hexproof!
		const lateScout = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Late Gladecover Scout',
				manaCost: '{0}',
				cmc: 0,
				oracleText: 'Hexproof',
				keywords: ['Hexproof']
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: lateScout.instanceId }).ok,
			true
		);
		passStep(state);
		const lateScoutBf = p1.battlefield.find((c) => c.instanceId === lateScout.instanceId)!;
		assert.equal(
			hasKw(lateScoutBf, 'hexproof'),
			true,
			'Creature entering after Arcane Lighthouse resolved keeps Hexproof (CR 611.2c)'
		);

		// 6. Advance to next turn (cleanup CR 514.2): all until-end-of-turn effects expire and keywords return!
		advanceToNextTurnMain();
		assert.equal(hasKw(stalker, 'hexproof'), true);
		assert.equal(hasKw(stalker, 'indestructible'), true);
		assert.equal(hasKw(knightBlack, 'hexproof from black'), true);
		assert.equal(hasKw(knightBlack, 'hexproof'), true); // from attached Swiftfoot Boots
		assert.equal(hasKw(shroudCalc, 'shroud'), true);
		assert.equal(hasKw(squire, 'shroud'), true); // from attached Lightning Greaves
		assert.equal(hasKw(aegisRelic, 'hexproof'), true);
		assert.equal(hasKw(aegisRelic, 'indestructible'), true);

		// 7. Synthetic card ("Nullveil Obelisk", {2}) works identically by IR without any card-name check,
		// allowing P2 to target & destroy Indestructible+Hexproof Aegis Relic!
		const obeliskAb = getEffectiveActivatedAbilities(state, p2, obelisk).find(
			(a) => !a.isManaAbility
		)!;
		p2.manaPool.C = 2;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: obelisk.instanceId,
				abilityId: obeliskAb.id
			}).ok,
			true
		);
		passStep(state);
		assert.equal(hasKw(aegisRelic, 'hexproof'), false);
		assert.equal(hasKw(aegisRelic, 'indestructible'), false);

		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: earlyKill.instanceId,
				targets: [{ kind: 'permanent', id: aegisRelic.instanceId, label: aegisRelic.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === aegisRelic.instanceId),
			'Aegis Relic is targetable and destroyed once synthetic Nullveil Obelisk strips Hexproof and Indestructible'
		);

		// 8. Temporary keyword grant vs "All creatures lose all abilities" (Humility) obeys CR 613.7 timestamp order!
		const jump1 = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Sky Leap',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gains flying until end of turn.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: jump1.instanceId,
				targets: [{ kind: 'permanent', id: stalker.instanceId, label: stalker.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(hasKw(stalker, 'flying'), true);

		// Humility enters AFTER Sky Leap resolved -> strips earlier temporary Flying grant!
		const humility = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Nullifying Haze',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment',
				oracleText: 'All creatures lose all abilities.'
			}),
			'hand'
		);
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: humility.instanceId }).ok,
			true
		);
		passStep(state);
		assert.equal(
			hasKw(stalker, 'flying'),
			false,
			'Later removeAllAbilities enchantment strips earlier temporary keyword grant (CR 613.7)'
		);

		// A second temporary Flying grant resolving AFTER Humility entered wins in timestamp order!
		const jump2 = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Second Sky Leap',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gains flying until end of turn.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: jump2.instanceId,
				targets: [{ kind: 'permanent', id: stalker.instanceId, label: stalker.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(
			hasKw(stalker, 'flying'),
			true,
			'Later temporary keyword grant beats earlier removeAllAbilities enchantment (CR 613.7)'
		);
	});
});

describe('Keywords: Hexproof (CR 702.11) & Shroud (CR 702.18)', () => {
	it('compiles Hexproof, Hexproof from [quality], and Shroud; enforces controller vs opponent targeting, fizzles on response gain, keeps existing attachments, and strips via Shadowspear/Arcane Lighthouse', () => {
		for (const [text, expectedName, expectedQuality] of [
			['Hexproof', 'hexproof', undefined],
			['Hexproof from black', 'hexproof', 'black'],
			['Hexproof from artifacts', 'hexproof', 'artifacts'],
			['Shroud', 'shroud', undefined]
		] as const) {
			const ir = compileCard(syntheticCard({ name: `Test ${text}`, oracleText: text })).faces[0];
			const kw = ir.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === expectedName);
			assert.ok(kw && kw.kind === 'keyword', `Expected keyword ${expectedName} for "${text}"`);
			if (expectedQuality) {
				assert.equal(kw.keyword.param, expectedQuality);
			}
			assert.equal(ir.abilities.some((a) => a.kind === 'unsupported'), false);
		}

		const { state, p1, p2 } = makeGame();

		const hexPerm = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Gladecover Scout', oracleText: 'Hexproof', keywords: ['Hexproof'] }),
			'battlefield'
		);
		const hexBlackPerm = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Knight of Malice',
				oracleText: 'Hexproof from black',
				keywords: ['Hexproof']
			}),
			'battlefield'
		);
		const shroudPerm = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Calciderm', oracleText: 'Shroud', keywords: ['Shroud'] }),
			'battlefield'
		);

		const pumpSpell = (owner: PlayerGameState, colors: ('W' | 'B')[] = []) =>
			putInZone(
				state,
				owner,
				syntheticCard({
					name: `Target Check ${owner.playerId} ${colors.join('')}`,
					manaCost: '{0}',
					cmc: 0,
					colors,
					typeLine: 'Instant',
					oracleText: 'Target creature gets +1/+1 until end of turn.'
				}),
				'hand'
			);

		// 1. Opponent CANNOT target Hexproof or Shroud with spells OR activated abilities!
		state.priorityPlayerIndex = 1;
		const oppSpell = pumpSpell(p2);
		const oppPinger = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Opp Pinger',
				oracleText: '{T}: This creature deals 1 damage to any target.'
			}),
			'battlefield'
		);
		for (const untargetable of [hexPerm, shroudPerm]) {
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: oppSpell.instanceId,
					targets: [{ kind: 'permanent', id: untargetable.instanceId, label: untargetable.card.name }]
				}).ok,
				false,
				`Opponent spell must NOT target ${untargetable.card.name}`
			);
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'activate_ability',
					instanceId: oppPinger.instanceId,
					abilityId: 'act_0',
					targets: [{ kind: 'permanent', id: untargetable.instanceId, label: untargetable.card.name }]
				}).ok,
				false,
				`Opponent ability must NOT target ${untargetable.card.name}`
			);
		}

		// 2. Hexproof from black: blocks opponent's BLACK spell, ALLOWS opponent's WHITE spell!
		const oppBlackSpell = pumpSpell(p2, ['B']);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppBlackSpell.instanceId,
				targets: [{ kind: 'permanent', id: hexBlackPerm.instanceId, label: hexBlackPerm.card.name }]
			}).ok,
			false,
			'Hexproof from black blocks opponent black spell'
		);
		const oppWhiteSpell = pumpSpell(p2, ['W']);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppWhiteSpell.instanceId,
				targets: [{ kind: 'permanent', id: hexBlackPerm.instanceId, label: hexBlackPerm.card.name }]
			}).ok,
			true,
			'Hexproof from black allows opponent white spell'
		);
		passStep(state);

		// 3. Controller CAN target own Hexproof & own Hexproof from black (even with black spell!), CANNOT target own Shroud!
		state.priorityPlayerIndex = 0;
		const selfBlackOnHexBlack = pumpSpell(p1, ['B']);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: selfBlackOnHexBlack.instanceId,
				targets: [{ kind: 'permanent', id: hexBlackPerm.instanceId, label: hexBlackPerm.card.name }]
			}).ok,
			true
		);
		passStep(state);

		const selfOnHex = pumpSpell(p1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: selfOnHex.instanceId,
				targets: [{ kind: 'permanent', id: hexPerm.instanceId, label: hexPerm.card.name }]
			}).ok,
			true,
			'Controller CAN target own Hexproof creature'
		);
		passStep(state);

		const selfOnShroud = pumpSpell(p1);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: selfOnShroud.instanceId,
				targets: [{ kind: 'permanent', id: shroudPerm.instanceId, label: shroudPerm.card.name }]
			}).ok,
			false,
			'Controller CANNOT target own Shroud creature'
		);

		// 4. Existing Aura/Equipment stays attached when gaining Shroud (Lightning Greaves) + Fizzle when gaining Hexproof in response!
		const knight = putInZone(state, p1, syntheticCard({ name: 'Equipped Knight' }), 'battlefield');
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		const greaves = putInZone(state, p1, staple('Lightning Greaves'), 'battlefield');
		// First equip Boots to knight, then move Boots away so knight is targetable, attach an Aura, then equip Greaves!
		const aura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Holy Strength',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +1/+2.',
				keywords: ['Enchant']
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: aura.instanceId,
				targets: [{ kind: 'permanent', id: knight.instanceId, label: knight.card.name }]
			}).ok,
			true
		);
		passStep(state);
		const auraBf = p1.battlefield.find((c) => c.instanceId === aura.instanceId)!;
		assert.equal(auraBf.attachedToId, knight.instanceId);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: greaves.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knight.instanceId, label: knight.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(greaves.attachedToId, knight.instanceId);
		assert.equal(
			auraBf.attachedToId,
			knight.instanceId,
			'Already-attached Aura does NOT fall off when creature gains Shroud'
		);

		// Fizzle on response gain (CR 608.2b): P2 casts Murder on vulnerableBear, P1 responds with "Target creature gains hexproof until end of turn."
		const vulnerableBear = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Vulnerable Bear' }),
			'battlefield'
		);
		const killSpell = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Murder Bolt',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: killSpell.instanceId,
				targets: [
					{ kind: 'permanent', id: vulnerableBear.instanceId, label: vulnerableBear.card.name }
				]
			}).ok,
			true
		);
		const veil = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Ranger Guile',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gains hexproof until end of turn.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: veil.instanceId,
				targets: [
					{ kind: 'permanent', id: vulnerableBear.instanceId, label: vulnerableBear.card.name }
				]
			}).ok,
			true
		);
		passStep(state); // Resolves Ranger Guile
		passStep(state); // Murder Bolt fizzles!
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === vulnerableBear.instanceId),
			'Murder Bolt fizzles when target gains Hexproof before resolution (CR 608.2b)'
		);

		// 5. Layer 6 removeKeywords strips innate "Hexproof from black", regular Hexproof, and Shroud!
		const glare = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Detection Glare',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment',
				oracleText:
					"Creatures your opponents control lose hexproof and shroud and can't have or gain hexproof and shroud."
			}),
			'hand'
		);
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: glare.instanceId
			}).ok,
			true
		);
		passStep(state);

		// Now P2's black spell CAN target hexBlackPerm, and P2's spell CAN target shroudPerm!
		const oppBlackAfterStrip = pumpSpell(p2, ['B']);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppBlackAfterStrip.instanceId,
				targets: [{ kind: 'permanent', id: hexBlackPerm.instanceId, label: hexBlackPerm.card.name }]
			}).ok,
			true,
			'Layer 6 removeKeywords removes innate Hexproof from black so opponent black spell can target it'
		);
		passStep(state);

		const oppOnShroudAfterStrip = pumpSpell(p2);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppOnShroudAfterStrip.instanceId,
				targets: [{ kind: 'permanent', id: shroudPerm.instanceId, label: shroudPerm.card.name }]
			}).ok,
			true,
			'Layer 6 removeKeywords removes Shroud from opponent creatures'
		);
		passStep(state);

		// 6. Untargeted Wrath of God still destroys both Hexproof and Shroud creatures!
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		const wrath = putInZone(state, p1, staple('Wrath of God'), 'hand');
		p1.manaPool.W = 2;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wrath.instanceId }).ok,
			true
		);
		passStep(state);
		assert.ok(p1.graveyard.some((c) => c.instanceId === hexPerm.instanceId));
		assert.ok(p1.graveyard.some((c) => c.instanceId === shroudPerm.instanceId));
	});
});

describe('Keyword: Ward (CR 702.21)', () => {
	it('compiles Miirym & Ward mana/life costs, triggers on opponent spells, activated abilities, AND triggered abilities (not controller own), handles uncounterable spells, granted/multiple Ward instances, and ability loss (CR 702.21a–b)', () => {
		const miirymIr = compileCard(staple('Miirym, Sentinel Wyrm')).faces[0];
		assert.ok(
			miirymIr.abilities.some(
				(a) => a.kind === 'keyword' && a.keyword.name === 'ward' && a.keyword.cost === '{2}'
			)
		);
		const lifeWardIr = compileCard(
			syntheticCard({ name: 'Graveyard Trespasser', oracleText: 'Ward—Pay 2 life' })
		).faces[0];
		assert.ok(
			lifeWardIr.abilities.some(
				(a) => a.kind === 'keyword' && a.keyword.name === 'ward' && a.keyword.param === 'Pay 2 life'
			)
		);
		// --- Track P12: Ward—Discard a card is now supported; Ward—{X} remains unsupported ---
		const discardWardIr = compileCard(
			syntheticCard({ name: 'Discard Warder', oracleText: 'Ward—Discard a card.' })
		).faces[0];
		assert.ok(
			discardWardIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'ward')
		);
		const unsupWardIr = compileCard(
			syntheticCard({ name: 'Variable Warder', oracleText: 'Ward—{X}.' })
		).faces[0];
		assert.ok(unsupWardIr.abilities.some((a) => a.kind === 'unsupported'));
		// --- End Track P12 ---

		const { state, p1, p2 } = makeGame();

		const lifeWardPerm = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Blood Warder',
				power: '3',
				toughness: '3',
				oracleText: 'Ward—Pay 2 life',
				keywords: ['Ward']
			}),
			'battlefield'
		);

		// 1. Controller's OWN spell targeting Blood Warder does NOT trigger Ward!
		const selfPump = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Self Boon',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gets +1/+1 until end of turn.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: selfPump.instanceId,
				targets: [{ kind: 'permanent', id: lifeWardPerm.instanceId, label: lifeWardPerm.card.name }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 1, 'Controller own spell must NOT trigger Ward');
		passStep(state);

		// 2. Opponent's targeted TRIGGERED ability (ETB trigger) DOES trigger Ward—Pay 2 life!
		const etbPinger = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Flametongue Cub',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Creature — Beast',
				oracleText: 'When this creature enters, Flametongue Cub deals 2 damage to target creature.'
			}),
			'hand'
		);
		state.phase = 'main1';
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: etbPinger.instanceId
			}).ok,
			true
		);
		passStep(state); // Resolves Flametongue Cub -> enters battlefield -> target prompt for ETB trigger!
		if (state.pendingPrompts.length > 0) {
			const trigTargetPrm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'choice',
					promptId: trigTargetPrm.id,
					answer: {
						kind: 'chooseObjects',
						objectIds: [lifeWardPerm.instanceId]
					}
				}).ok,
				true
			);
		}
		assert.equal(
			state.stack.length,
			2,
			'Opponent targeted ETB triggered ability triggers Ward on top of the stack (CR 702.21a)'
		);
		// Resolve Ward trigger -> P2 pays 2 life -> ETB trigger resolves and deals 2 damage!
		resolveTopOfStack(state);
		const lifePrompt = state.pendingPrompts.find((pr) => pr.playerId === p2.playerId)!;
		assert.ok(lifePrompt, 'Expected Pay 2 life Ward prompt');
		applyGameAction(state, p2.playerId, {
			type: 'choice',
			promptId: lifePrompt.id,
			answer: { kind: 'yesNo', yes: true }
		});
		assert.equal(p2.life, 38, 'P2 paid 2 life for Ward');
		resolveTopOfStack(state);
		assert.equal(lifeWardPerm.damageMarked, 2, 'Paid Ward let the ETB trigger resolve');

		// 3. Uncounterable spell ("This spell can't be countered.") triggers Ward, opponent declines to pay, and spell STILL resolves (CR 702.21a)!
		const manaWardPerm = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Frost Titan Jr',
				power: '3',
				toughness: '3',
				oracleText: 'Ward {2}',
				keywords: ['Ward']
			}),
			'battlefield'
		);
		const uncounterableKill = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Abrupt End',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: "This spell can't be countered.\nDestroy target creature."
			}),
			'hand'
		);
		p2.manaPool.C = 2; // Can pay, chooses NOT to!
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: uncounterableKill.instanceId,
				targets: [{ kind: 'permanent', id: manaWardPerm.instanceId, label: manaWardPerm.card.name }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 2);
		resolveTopOfStack(state);
		const declinePrm = state.pendingPrompts.find((pr) => pr.playerId === p2.playerId)!;
		applyGameAction(state, p2.playerId, {
			type: 'choice',
			promptId: declinePrm.id,
			answer: { kind: 'yesNo', yes: false }
		});
		assert.equal(p2.manaPool.C, 2, 'Declining Ward spends 0 mana');
		assert.equal(state.stack.length, 1, 'Uncounterable spell remains on stack after unpaid Ward');
		resolveTopOfStack(state);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === manaWardPerm.instanceId),
			'Uncounterable spell still destroys Ward creature despite unpaid Ward'
		);

		// 4. Granted Ward + Multiple Ward instances trigger separately (CR 702.21a: each is its own triggered ability) + Ability loss stops Ward!
		const multiWard = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Dual Warder',
				power: '2',
				toughness: '2',
				oracleText: 'Ward {1}',
				keywords: ['Ward']
			}),
			'battlefield'
		);
		const grantWard2 = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Ward Blessing',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Flash\nEnchant creature\nEnchanted creature has ward {2}.',
				keywords: ['Flash', 'Enchant']
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: grantWard2.instanceId,
				targets: [{ kind: 'permanent', id: multiWard.instanceId, label: multiWard.card.name }]
			}).ok,
			true
		);
		passStep(state);

		// Opponent targets Dual Warder (Ward {1} + granted Ward {2}) -> TWO separate Ward triggers on stack!
		const oppPoke = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Tiny Poke',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gets -1/-1 until end of turn.'
			}),
			'hand'
		);
		p2.manaPool.C = 0;
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppPoke.instanceId,
				targets: [{ kind: 'permanent', id: multiWard.instanceId, label: multiWard.card.name }]
			}).ok,
			true
		);
		// If trigger_order prompt appears for the 2 Ward triggers, answer it:
		const ord = state.pendingPrompts[0];
		if (ord?.purpose === 'trigger_order' && ord.choice?.kind === 'orderObjects') {
			applyGameAction(state, ord.playerId, {
				type: 'choice',
				promptId: ord.id,
				answer: { kind: 'orderObjects', topIds: ord.choice.objectIds, bottomIds: [], shuffle: false }
			});
		}
		assert.equal(
			state.stack.filter((s) => s.kind === 'triggered').length,
			2,
			'Innate Ward {1} and granted Ward {2} each trigger separately (CR 702.21a)'
		);
		for (let i = 0; i < 10 && (state.stack.length > 0 || state.pendingPrompts.length > 0); i++) {
			if (state.pendingPrompts.length > 0) {
				const pr = state.pendingPrompts[0];
				if (pr.choice?.kind === 'yesNo') {
					applyGameAction(state, pr.playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'yesNo', yes: false }
					});
				} else {
					break;
				}
			} else {
				resolveTopOfStack(state);
			}
		}
		assert.equal(state.stack.length, 0, 'Unpaid Ward counters oppPoke and second Ward resolves cleanly');

		// Ability loss stops Ward: P1 enchants own Dual Warder with "Enchanted creature loses all abilities.", then P2 targets it with 0 triggers!
		const stripAura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Humble Aura',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Flash\nEnchant creature\nEnchanted creature loses all abilities.',
				keywords: ['Flash', 'Enchant']
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: stripAura.instanceId,
				targets: [{ kind: 'permanent', id: multiWard.instanceId, label: multiWard.card.name }]
			}).ok,
			true
		);
		passStep(state);

		const oppKillAfterStrip = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Clean Kill',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: oppKillAfterStrip.instanceId,
				targets: [{ kind: 'permanent', id: multiWard.instanceId, label: multiWard.card.name }]
			}).ok,
			true
		);
		assert.equal(state.stack.length, 1, 'Creature that lost all abilities does NOT trigger Ward');
		passStep(state);
		assert.ok(p1.graveyard.some((c) => c.instanceId === multiWard.instanceId));
	});
});

describe('Keyword: Protection (CR 702.16)', () => {
	it('compiles Protection qualities, enforces full DEBT (Damage, Enchant/Equip SBA fall-off, Blocking, Targeting), supports compound Akroma Memorial & multiple Protection coexistence, allows Wrath of God, and handles gain/loss', () => {
		for (const [text, expectedQuality] of [
			['Protection from red', 'red'],
			['Protection from creatures', 'creatures'],
			['Protection from artifacts', 'artifacts'],
			['Protection from everything', 'everything']
		] as const) {
			const ir = compileCard(syntheticCard({ name: `Test ${text}`, oracleText: text })).faces[0];
			const kw = ir.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'protection');
			assert.ok(kw && kw.kind === 'keyword');
			assert.equal(kw.keyword.param, expectedQuality);
			assert.equal(ir.abilities.some((a) => a.kind === 'unsupported'), false);
		}

		const { state, p1, p2 } = makeGame();

		// 1. Multi-protection coexistence + Compound Akroma's Memorial ("protection from black and from red") + Innate "Protection from white"!
		const paladin = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Sanctum Champion',
				power: '3',
				toughness: '3',
				oracleText: 'Protection from white',
				keywords: ['Protection']
			}),
			'battlefield'
		);
		putInZone(state, p1, staple("Akroma's Memorial"), 'battlefield');

		// T (Targeting): Blocked from WHITE (even controller's own!), BLACK, and RED; ALLOWED from GREEN!
		for (const col of ['W', 'B', 'R'] as const) {
			const spell = putInZone(
				state,
				p1,
				syntheticCard({
					name: `Spell ${col}`,
					manaCost: '{0}',
					cmc: 0,
					colors: [col],
					typeLine: 'Instant',
					oracleText: 'Target creature gets +1/+1 until end of turn.'
				}),
				'hand'
			);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: spell.instanceId,
					targets: [{ kind: 'permanent', id: paladin.instanceId, label: paladin.card.name }]
				}).ok,
				false,
				`Paladin with Protection from white + Akroma's Memorial must block ${col} targeting even from own controller`
			);
		}
		const greenPump = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Giant Growth Lite',
				manaCost: '{0}',
				cmc: 0,
				colors: ['G'],
				typeLine: 'Instant',
				oracleText: 'Target creature gets +1/+1 until end of turn.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: greenPump.instanceId,
				targets: [{ kind: 'permanent', id: paladin.instanceId, label: paladin.card.name }]
			}).ok,
			true
		);
		passStep(state);

		// D (Damage): Untargeted Black AND Untargeted Red damage are BOTH prevented on Paladin!
		for (const col of ['B', 'R'] as const) {
			const sweeper = putInZone(
				state,
				p2,
				syntheticCard({
					name: `Pyroclasm ${col}`,
					manaCost: '{0}',
					cmc: 0,
					colors: [col],
					typeLine: 'Instant',
					oracleText: `Pyroclasm ${col} deals 3 damage to each creature.`
				}),
				'hand'
			);
			state.priorityPlayerIndex = 1;
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: sweeper.instanceId
				}).ok,
				true
			);
			passStep(state);
			assert.equal(
				paladin.damageMarked,
				0,
				`Compound Protection from black and from red must prevent ${col} damage`
			);
		}

		// B (Blocking): Red flyer and White flyer CANNOT block Paladin; Green flyer CAN block Paladin!
		const redFlyer = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Red Drake', colors: ['R'], oracleText: 'Flying', keywords: ['Flying'] }),
			'battlefield'
		);
		const whiteFlyer = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'White Hawk',
				colors: ['W'],
				oracleText: 'Flying',
				keywords: ['Flying']
			}),
			'battlefield'
		);
		const greenFlyer = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Green Hornet',
				colors: ['G'],
				oracleText: 'Flying',
				keywords: ['Flying']
			}),
			'battlefield'
		);
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: paladin.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true
		);
		passStep(state);
		for (const illegalBlk of [redFlyer, whiteFlyer]) {
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'declare_blockers',
					assignments: [
						{ blockerInstanceId: illegalBlk.instanceId, attackerInstanceId: paladin.instanceId }
					]
				}).ok,
				false
			);
		}
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: greenFlyer.instanceId, attackerInstanceId: paladin.instanceId }
				]
			}).ok,
			true
		);

		// 2. E (Enchanted & Equipped fall off via SBA when creature gains Protection! CR 702.16c–d, 704.5m–n)
		state.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		};
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		const host = putInZone(state, p1, syntheticCard({ name: 'Armored Squire' }), 'battlefield');
		const greenAura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Oakform',
				manaCost: '{0}',
				cmc: 0,
				colors: ['G'],
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +2/+2.',
				keywords: ['Enchant']
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: greenAura.instanceId,
				targets: [{ kind: 'permanent', id: host.instanceId, label: host.card.name }]
			}).ok,
			true
		);
		passStep(state);
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		p1.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: host.instanceId, label: host.card.name }]
			}).ok,
			true
		);
		passStep(state);
		const greenAuraBf = p1.battlefield.find((c) => c.instanceId === greenAura.instanceId)!;
		assert.equal(greenAuraBf.attachedToId, host.instanceId);
		assert.equal(boots.attachedToId, host.instanceId);

		// Grant "protection from green, and protection from artifacts" until end of turn -> Aura goes to graveyard, Boots unattaches and stays on battlefield!
		const grantProt = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Tower Defense Ward',
				manaCost: '{0}',
				cmc: 0,
				colors: ['U'],
				typeLine: 'Instant',
				oracleText:
					'Target creature gains protection from green and protection from artifacts until end of turn.'
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: grantProt.instanceId,
				targets: [{ kind: 'permanent', id: host.instanceId, label: host.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === greenAura.instanceId),
			'Attached green Aura goes to graveyard via SBA when creature gains Protection from green (CR 702.16c)'
		);
		assert.equal(
			boots.attachedToId,
			null,
			'Attached Equipment unattaches via SBA when creature gains Protection from artifacts (CR 702.16d)'
		);
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === boots.instanceId),
			'Unattached Equipment remains on the battlefield'
		);

		// 3. Negative: Untargeted WHITE Wrath of God STILL destroys Sanctum Champion (despite Protection from white)!
		const wrath = putInZone(state, p1, staple('Wrath of God'), 'hand');
		p1.manaPool.W = 2;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wrath.instanceId }).ok,
			true
		);
		passStep(state);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === paladin.instanceId),
			'Protection from white does NOT stop untargeted non-damage Wrath of God'
		);
	});
});

describe('Keyword: Enchant (CR 702.5)', () => {
	it('compiles diverse Enchant restrictions, enforces legal targets on cast, puts Aura into graveyard on fizzle, and puts Aura into graveyard via SBA when host leaves, stops matching control restriction, or Aura becomes a creature (CR 702.5a, 303.4, 704.5m)', () => {
		for (const text of [
			'Enchant creature',
			'Enchant artifact',
			'Enchant land',
			'Enchant creature you control',
			'Enchant player',
			'Enchant creature, land, or planeswalker'
		]) {
			const ir = compileCard(
				syntheticCard({
					name: `Test ${text}`,
					typeLine: 'Enchantment — Aura',
					oracleText: text
				})
			).faces[0];
			assert.ok(
				ir.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'enchant'),
				`Expected Enchant keyword for "${text}"`
			);
			assert.equal(ir.abilities.some((a) => a.kind === 'unsupported'), false);
		}

		const { state, p1, p2 } = makeGame();
		const myCreature = putInZone(state, p1, syntheticCard({ name: 'My Bear' }), 'battlefield');
		const oppCreature = putInZone(state, p2, syntheticCard({ name: 'Opp Bear' }), 'battlefield');
		const mySolRing = putInZone(state, p1, staple('Sol Ring'), 'battlefield');

		// 1. Enchant artifact rejects non-artifact creature, accepts Sol Ring!
		const artAura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Relic Ward',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant artifact',
				keywords: ['Enchant']
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: artAura.instanceId,
				targets: [{ kind: 'permanent', id: myCreature.instanceId, label: myCreature.card.name }]
			}).ok,
			false,
			'Enchant artifact must reject non-artifact creature'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: artAura.instanceId,
				targets: [{ kind: 'permanent', id: mySolRing.instanceId, label: mySolRing.card.name }]
			}).ok,
			true
		);
		passStep(state);
		const artAuraBf = p1.battlefield.find((c) => c.instanceId === artAura.instanceId)!;
		assert.equal(artAuraBf.attachedToId, mySolRing.instanceId);

		// 2. Enchant creature you control rejects oppCreature, accepts myCreature, and goes to graveyard on control change!
		const myOnlyAura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Curious Obsession Lite',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature you control\nEnchanted creature gets +1/+1.',
				keywords: ['Enchant']
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: myOnlyAura.instanceId,
				targets: [{ kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name }]
			}).ok,
			false,
			'Enchant creature you control rejects opponent creature'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: myOnlyAura.instanceId,
				targets: [{ kind: 'permanent', id: myCreature.instanceId, label: myCreature.card.name }]
			}).ok,
			true
		);
		passStep(state);
		const myOnlyAuraBf = p1.battlefield.find((c) => c.instanceId === myOnlyAura.instanceId)!;
		assert.equal(myOnlyAuraBf.attachedToId, myCreature.instanceId);

		// Steal myCreature to P2 -> trigger SBA via priority pass -> myOnlyAura (still controlled by P1!) falls off into P1's graveyard!
		transferBattlefieldControl(myCreature, p1, p2, state);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === myOnlyAura.instanceId),
			'Enchant creature you control goes to graveyard via SBA when enchanted creature changes control'
		);

		// 3. Fizzle on resolution (CR 608.2b): target destroyed in response -> Aura goes straight to graveyard without entering battlefield!
		state.priorityPlayerIndex = 0;
		const fizzleAura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Doomed Boon',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +2/+2.',
				keywords: ['Enchant']
			}),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fizzleAura.instanceId,
				targets: [{ kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name }]
			}).ok,
			true
		);
		const instantKill = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Sac Kill',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: instantKill.instanceId,
				targets: [{ kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name }]
			}).ok,
			true
		);
		passStep(state); // Destroys oppCreature
		passStep(state); // fizzleAura fizzles -> graveyard!
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === fizzleAura.instanceId),
			'Aura whose target left before resolution goes to owner graveyard (CR 608.2b)'
		);

		// 4. CR 303.4d: If an attached Aura becomes a Creature (Opalescence), it cannot enchant anything and goes to graveyard via SBA!
		const opalescence = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Opalescence Lite',
				manaCost: '{0}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText:
					'Each enchantment is a creature in addition to its other types and has base power and base toughness each equal to its mana value.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: opalescence.instanceId
			}).ok,
			true
		);
		passStep(state);
		assert.ok(
			p1.graveyard.some((c) => c.instanceId === artAura.instanceId),
			'Attached Aura that becomes a Creature goes to graveyard via SBA (CR 303.4d, 704.5m)'
		);
	});
});

describe('Keyword: Equip (CR 702.6)', () => {
	it('compiles Equip & Equip [quality], enforces sorcery speed and controller-creature restriction, pays cost, moves between creatures, stays on battlefield when creature dies, unattaches if Equipment becomes a creature, and stops when losing abilities (CR 702.6a–c, 301.5c)', () => {
		for (const [card, expectedFilter] of [
			[staple('Swiftfoot Boots'), undefined],
			[
				syntheticCard({
					name: 'Hero Blade',
					typeLine: 'Artifact — Equipment',
					oracleText: 'Equip legendary creature {1}'
				}),
				{ supertypes: ['Legendary'] }
			],
			[
				syntheticCard({
					name: 'Knight Lance',
					typeLine: 'Artifact — Equipment',
					oracleText: 'Equip Knight {2}'
				}),
				{ subtypes: ['Knight'] }
			]
		] as const) {
			const ir = compileCard(card).faces[0];
			const kw = ir.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'equip');
			assert.ok(kw && kw.kind === 'keyword');
			if (expectedFilter) {
				assert.deepEqual(kw.keyword.equipFilter, expectedFilter);
			}
			assert.equal(ir.abilities.some((a) => a.kind === 'unsupported'), false);
		}

		const { state, p1, p2 } = makeGame();
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		const knightA = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Knight A', typeLine: 'Creature — Human Knight' }),
			'battlefield'
		);
		const bearB = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Bear B', typeLine: 'Creature — Bear' }),
			'battlefield'
		);
		const oppBear = putInZone(state, p2, syntheticCard({ name: 'Opp Bear' }), 'battlefield');

		// 1. Sorcery-speed checks: rejected on opponent's turn, during combat, and with non-empty stack!
		p1.manaPool.C = 5;
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
			}).ok,
			false,
			'Equip rejected on opponent turn'
		);

		state.activePlayerIndex = 0;
		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
			}).ok,
			false,
			'Equip rejected during combat phase'
		);

		state.phase = 'main1';
		const cantrip = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Stack Blocker',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Target creature gets +1/+1 until end of turn.'
			}),
			'hand'
		);
		applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: cantrip.instanceId,
			targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
		});
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
			}).ok,
			false,
			'Equip rejected while stack is non-empty'
		);
		passStep(state);

		// 2. Rejects opponent's creature & insufficient mana; pays {1} to equip knightA, then pays {1} to move directly to bearB!
		state.priorityPlayerIndex = 0;
		p1.manaPool.C = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
			}).ok,
			false,
			'Equip rejected without mana'
		);

		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: oppBear.instanceId, label: oppBear.card.name }]
			}).ok,
			false,
			'Equip rejected targeting opponent creature'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
			}).ok,
			true
		);
		assert.equal(p1.manaPool.C, 1, 'Equip {1} deducted 1 mana');
		passStep(state);
		assert.equal(boots.attachedToId, knightA.instanceId);

		// Move Boots from knightA -> bearB!
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: bearB.instanceId, label: bearB.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(boots.attachedToId, bearB.instanceId, 'Equipment moved to second creature');

		// 3. Equipped creature dies -> Equipment stays on the battlefield unattached!
		// (Use self-sacrifice or -2/-2 since bearB has Hexproof from Swiftfoot Boots!)
		const selfShrink = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Cull Own Bear',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: selfShrink.instanceId,
				targets: [{ kind: 'permanent', id: bearB.instanceId, label: bearB.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.ok(p1.graveyard.some((c) => c.instanceId === bearB.instanceId));
		assert.ok(
			p1.battlefield.some((c) => c.instanceId === boots.instanceId),
			'Equipment remains on the battlefield when equipped creature dies'
		);
		assert.equal(boots.attachedToId, null);

		// 4. CR 301.5c: If an attached Equipment becomes an Artifact Creature, it unattaches via SBA!
		p1.manaPool.C = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(boots.attachedToId, knightA.instanceId);

		// Animate Boots via March of the Machines ("Each artifact is a creature in addition to its other types and has base power and base toughness each equal to its mana value.")!
		const march = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'March of the Machines Lite',
				manaCost: '{0}',
				cmc: 4,
				typeLine: 'Enchantment',
				oracleText:
					'Each artifact is a creature in addition to its other types and has base power and base toughness each equal to its mana value.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: march.instanceId
			}).ok,
			true
		);
		passStep(state);
		assert.equal(
			boots.attachedToId,
			null,
			'Equipment that becomes a Creature unattaches via SBA and stays on battlefield (CR 301.5c)'
		);
		assert.ok(p1.battlefield.some((c) => c.instanceId === boots.instanceId));

		// 5. Losing all abilities prevents activating Equip!
		const muteBoots = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Nullify Relic',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant permanent\nEnchanted permanent loses all abilities.',
				keywords: ['Enchant']
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: muteBoots.instanceId,
				targets: [{ kind: 'permanent', id: boots.instanceId, label: boots.card.name }]
			}).ok,
			true
		);
		passStep(state);
		p1.manaPool.C = 2;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: knightA.instanceId, label: knightA.card.name }]
			}).ok,
			false,
			'Equipment that lost all abilities cannot activate Equip'
		);
	});
});

describe('CR 613.7e & CR 701.3b: Attachment timestamp funnel (attachObject)', () => {
	const TINSCALE_HARNESS = syntheticCard({
		name: 'Tinscale Harness',
		manaCost: '{0}',
		cmc: 1,
		typeLine: 'Artifact — Equipment',
		oracleText: 'Equipped creature has base power and toughness 1/1.\nEquip {1}',
		keywords: ['Equip']
	});

	const TITANPLATE_HARNESS = syntheticCard({
		name: 'Titanplate Harness',
		manaCost: '{0}',
		cmc: 1,
		typeLine: 'Artifact — Equipment',
		oracleText: 'Equipped creature has base power and toughness 4/4.\nEquip {1}',
		keywords: ['Equip']
	});

	function castFromHand(
		state: GameState,
		player: PlayerGameState,
		card: ScryfallCard,
		targets?: Array<{ kind: 'permanent' | 'player'; id: string; label: string }>
	): CardInstance {
		const inHand = putInZone(state, player, card, 'hand');
		state.priorityPlayerIndex = state.players.indexOf(player);
		assert.equal(
			applyGameAction(state, player.playerId, {
				type: 'cast_spell',
				instanceId: inHand.instanceId,
				...(targets ? { targets } : {})
			}).ok,
			true,
			`expected casting ${card.name} to succeed`
		);
		passStep(state);
		const onBoard = player.battlefield.find((c) => c.instanceId === inHand.instanceId);
		assert.ok(onBoard, `expected ${card.name} to enter the battlefield`);
		return onBoard;
	}

	function activateEquip(
		state: GameState,
		player: PlayerGameState,
		equipment: CardInstance,
		target: CardInstance
	): void {
		const equipAb = getEffectiveActivatedAbilities(state, player, equipment).find((a) =>
			a.id.startsWith('equip_')
		);
		assert.ok(equipAb, `expected Equip ability on ${equipment.card.name}`);
		player.manaPool.C = (player.manaPool.C ?? 0) + 2;
		state.priorityPlayerIndex = state.players.indexOf(player);
		assert.equal(
			applyGameAction(state, player.playerId, {
				type: 'activate_ability',
				instanceId: equipment.instanceId,
				abilityId: equipAb.id,
				targets: [{ kind: 'permanent', id: target.instanceId, label: target.card.name }]
			}).ok,
			true,
			`expected activating Equip on ${equipment.card.name} to succeed`
		);
		passStep(state);
	}

	it('CR 613.7e: two base-P/T Equipment cast A then B apply in Equip order (including A\'s first attachment)', () => {
		assert.equal(compileCard(TINSCALE_HARNESS).fullySupported, true);
		assert.equal(compileCard(TITANPLATE_HARNESS).fullySupported, true);

		for (const lobbyCode of ['KEYWORDS_PROT_ATTACH_TEST', 'GOLDEN']) {
			// Order 1: Cast A (1/1) then Cast B (4/4), Equip A then Equip B -> creature is 4/4
			{
				const { state, p1 } = makeGame();
				state.lobbyCode = lobbyCode;
				const lynx = putInZone(
					state,
					p1,
					syntheticCard({ name: 'Meadow Lynx', typeLine: 'Creature — Cat', power: '2', toughness: '2' }),
					'battlefield'
				);
				const equipA = castFromHand(state, p1, TINSCALE_HARNESS);
				const equipB = castFromHand(state, p1, TITANPLATE_HARNESS);
				assert.ok(
					(equipA.enteredTimestamp ?? 0) < (equipB.enteredTimestamp ?? 0),
					'A has an earlier cast timestamp than B'
				);

				const tsBeforeA = state.nextTimestamp ?? 0;
				activateEquip(state, p1, equipA, lynx);
				assert.equal(equipA.enteredTimestamp, tsBeforeA + 1, 'first attach allocates exactly 1 timestamp');
				assert.equal(evaluatePermanent(state, lynx).power, 1);
				assert.equal(evaluatePermanent(state, lynx).toughness, 1);

				const tsBeforeB = state.nextTimestamp ?? 0;
				activateEquip(state, p1, equipB, lynx);
				assert.equal(equipB.enteredTimestamp, tsBeforeB + 1, 'first attach of B allocates exactly 1 timestamp');
				assert.equal(evaluatePermanent(state, lynx).power, 4);
				assert.equal(evaluatePermanent(state, lynx).toughness, 4);
			}

			// Order 2: Cast A (1/1) then Cast B (4/4), Equip B FIRST then Equip A -> creature is 1/1!
			{
				const { state, p1 } = makeGame();
				state.lobbyCode = lobbyCode;
				const lynx = putInZone(
					state,
					p1,
					syntheticCard({ name: 'Meadow Lynx', typeLine: 'Creature — Cat', power: '2', toughness: '2' }),
					'battlefield'
				);
				const equipA = castFromHand(state, p1, TINSCALE_HARNESS);
				const equipB = castFromHand(state, p1, TITANPLATE_HARNESS);
				assert.ok((equipA.enteredTimestamp ?? 0) < (equipB.enteredTimestamp ?? 0));

				activateEquip(state, p1, equipB, lynx);
				assert.equal(evaluatePermanent(state, lynx).power, 4);
				assert.equal(evaluatePermanent(state, lynx).toughness, 4);

				const tsBeforeA = state.nextTimestamp ?? 0;
				activateEquip(state, p1, equipA, lynx);
				assert.equal(equipA.enteredTimestamp, tsBeforeA + 1);
				assert.ok(
					(equipA.enteredTimestamp ?? 0) > (equipB.enteredTimestamp ?? 0),
					`[${lobbyCode}] A receives a newer timestamp than B on its very first attachment (CR 613.7e)`
				);
				assert.equal(
					evaluatePermanent(state, lynx).power,
					1,
					`[${lobbyCode}] Equip B then Equip A leaves creature at 1/1`
				);
				assert.equal(evaluatePermanent(state, lynx).toughness, 1);
			}
		}
	});

	it('CR 613.7e (real cards): Cobbled Wings and Swiftfoot Boots cast before ability-removing enchantments win Layer 6 when equipped afterwards', () => {
		const cobbledWings = syntheticCard({
			name: 'Cobbled Wings',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact — Equipment',
			oracleText: 'Equipped creature has flying.\nEquip {1}',
			keywords: ['Equip']
		});
		const humility = syntheticCard({
			name: 'Humility',
			manaCost: '{2}{W}{W}',
			cmc: 4,
			typeLine: 'Enchantment',
			oracleText: 'All creatures lose all abilities and have base power and toughness 1/1.',
			colors: ['W'],
			colorIdentity: ['W']
		});

		// 1. Swiftfoot Boots cast before Humility, then equipped -> 1/1 with Hexproof and Haste
		for (const lobbyCode of ['KEYWORDS_PROT_ATTACH_TEST', 'GOLDEN']) {
			const { state, p1 } = makeGame();
			state.lobbyCode = lobbyCode;
			const bear = putInZone(
				state,
				p1,
				syntheticCard({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				'battlefield'
			);
			p1.manaPool.C = 4;
			p1.manaPool.W = 2;
			const boots = castFromHand(state, p1, staple('Swiftfoot Boots'));
			const hum = castFromHand(state, p1, humility);
			assert.ok((boots.enteredTimestamp ?? 0) < (hum.enteredTimestamp ?? 0));

			activateEquip(state, p1, boots, bear);
			const evalAfterEquip = evaluatePermanent(state, bear);
			assert.equal(evalAfterEquip.power, 1);
			assert.equal(evalAfterEquip.toughness, 1);
			assert.ok(
				evalAfterEquip.activeKeywords.includes('Hexproof') &&
					evalAfterEquip.activeKeywords.includes('Haste'),
				`[${lobbyCode}] Swiftfoot Boots equipped after Humility grants Hexproof and Haste (CR 613.7e)`
			);
		}

		// 2. Cobbled Wings vs Kenrith's Transformation in both attachment orders
		const { state, p1 } = makeGame();
		p1.library.push(
			createCardInstance(
				syntheticCard({ name: 'Forest', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0 }),
				p1.playerId,
				'library'
			),
			createCardInstance(
				syntheticCard({ name: 'Forest', typeLine: 'Basic Land — Forest', manaCost: '', cmc: 0 }),
				p1.playerId,
				'library'
			)
		);
		const bear1 = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Runeclaw Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const bear2 = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Ashcoat Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		p1.manaPool.C = 10;
		p1.manaPool.G = 4;
		const wings = castFromHand(state, p1, cobbledWings);
		// Cast Kenrith's Transformation on bear1 AFTER Cobbled Wings entered, THEN equip Cobbled Wings to bear1 -> bear1 HAS Flying!
		const kenrith1 = castFromHand(state, p1, staple("Kenrith's Transformation"), [
			{ kind: 'permanent', id: bear1.instanceId, label: bear1.card.name }
		]);
		assert.ok((wings.enteredTimestamp ?? 0) < (kenrith1.enteredTimestamp ?? 0));
		activateEquip(state, p1, wings, bear1);
		assert.equal(evaluatePermanent(state, bear1).power, 3);
		assert.ok(
			evaluatePermanent(state, bear1).activeKeywords.includes('Flying'),
			'Equipping Cobbled Wings after Kenrith\'s Transformation grants Flying via newer attachment timestamp'
		);

		// Move Cobbled Wings to bear2 FIRST, THEN cast a second Kenrith's Transformation on bear2 -> bear2 LOSES Flying!
		activateEquip(state, p1, wings, bear2);
		assert.ok(evaluatePermanent(state, bear2).activeKeywords.includes('Flying'));
		castFromHand(state, p1, staple("Kenrith's Transformation"), [
			{ kind: 'permanent', id: bear2.instanceId, label: bear2.card.name }
		]);
		assert.equal(evaluatePermanent(state, bear2).power, 3);
		assert.ok(
			!evaluatePermanent(state, bear2).activeKeywords.includes('Flying'),
			'Kenrith\'s Transformation entering after Cobbled Wings was equipped strips Flying'
		);
	});

	it('CR 701.3b: re-equipping an already-attached Equipment to the same creature does nothing and preserves timestamp', () => {
		const { state, p1 } = makeGame();
		const lynx = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Meadow Lynx', typeLine: 'Creature — Cat', power: '2', toughness: '2' }),
			'battlefield'
		);
		const equipA = castFromHand(state, p1, TINSCALE_HARNESS);
		const equipB = castFromHand(state, p1, TITANPLATE_HARNESS);

		// Equip A (1/1), then Equip B (4/4) -> creature is 4/4
		activateEquip(state, p1, equipA, lynx);
		activateEquip(state, p1, equipB, lynx);
		assert.equal(evaluatePermanent(state, lynx).power, 4);
		assert.equal(evaluatePermanent(state, lynx).toughness, 4);

		const aTimestampBefore = equipA.enteredTimestamp;
		const nextTimestampBefore = state.nextTimestamp;
		let attachedEvents = 0;
		const unsub = subscribeEvents(state, (_s, ev) => {
			if (ev.kind === 'Attached') attachedEvents++;
		});
		try {
			// Activate Equip on A targeting the SAME creature it is already attached to -> CR 701.3b no-op!
			activateEquip(state, p1, equipA, lynx);
			assert.equal(
				equipA.enteredTimestamp,
				aTimestampBefore,
				'Re-attaching to the same creature must not update enteredTimestamp (CR 701.3b)'
			);
			assert.equal(
				state.nextTimestamp,
				nextTimestampBefore,
				'Re-attaching to the same creature must not allocate a timestamp'
			);
			assert.equal(attachedEvents, 0, 'Re-attaching to the same creature must not emit Attached');
			assert.equal(
				evaluatePermanent(state, lynx).power,
				4,
				'Creature remains 4/4 because re-equipping A to the same host did nothing'
			);
			assert.equal(evaluatePermanent(state, lynx).toughness, 4);
		} finally {
			unsub();
		}
	});

	it('CR 613.7e: moving an Equipment or Aura from Creature 1 to Creature 2 updates its timestamp by +1', () => {
		const { state, p1 } = makeGame();
		const creature1 = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Copperhorn Stag', typeLine: 'Creature — Elk', power: '2', toughness: '2' }),
			'battlefield'
		);
		const creature2 = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Silverfur Wolf', typeLine: 'Creature — Wolf', power: '2', toughness: '2' }),
			'battlefield'
		);
		const equipA = castFromHand(state, p1, TINSCALE_HARNESS);
		const equipB = castFromHand(state, p1, TITANPLATE_HARNESS);

		// Equip A (1/1) to Creature 1, then Equip B (4/4) to Creature 2
		activateEquip(state, p1, equipA, creature1);
		activateEquip(state, p1, equipB, creature2);
		assert.equal(evaluatePermanent(state, creature1).power, 1);
		assert.equal(evaluatePermanent(state, creature2).power, 4);
		assert.ok((equipA.enteredTimestamp ?? 0) < (equipB.enteredTimestamp ?? 0));

		// Move Equipment A from Creature 1 to Creature 2 -> allocates exactly 1 new timestamp (> B)
		const tsBeforeMoveEquip = state.nextTimestamp ?? 0;
		activateEquip(state, p1, equipA, creature2);
		assert.equal(equipA.attachedToId, creature2.instanceId);
		assert.equal(
			equipA.enteredTimestamp,
			tsBeforeMoveEquip + 1,
			'Moving Equipment to a new host allocates exactly 1 timestamp (no double-increment)'
		);
		assert.equal(evaluatePermanent(state, creature1).power, 2);
		assert.equal(
			evaluatePermanent(state, creature2).power,
			1,
			'Equipment A moved onto Creature 2 overrides earlier Equipment B (4/4 -> 1/1)'
		);

		// Now test moving an Aura from Creature 1 to Creature 2 via applyGameAction!
		const shiftingAuraCard = syntheticCard({
			name: 'Glimmerweave Shackle',
			manaCost: '{0}',
			cmc: 1,
			typeLine: 'Enchantment — Aura',
			oracleText:
				'Enchant creature\nEnchanted creature has base power and toughness 1/1.\n{1}: Attach ~ to target creature you control.',
			keywords: ['Enchant']
		});
		assert.equal(compileCard(shiftingAuraCard).fullySupported, true);

		const auraInHand = putInZone(state, p1, shiftingAuraCard, 'hand');
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: auraInHand.instanceId,
				targets: [{ kind: 'permanent', id: creature1.instanceId, label: creature1.card.name }]
			}).ok,
			true
		);
		const tsBeforeAuraResolve = state.nextTimestamp ?? 0;
		passStep(state);
		const aura = p1.battlefield.find((c) => c.instanceId === auraInHand.instanceId)!;
		assert.ok(aura);
		assert.equal(
			aura.enteredTimestamp,
			tsBeforeAuraResolve + 1,
			'Aura spell resolution allocates exactly 1 timestamp'
		);
		assert.equal(aura.attachedToId, creature1.instanceId);
		assert.equal(evaluatePermanent(state, creature1).power, 1);

		// Re-equip B (4/4) onto Creature 1 ( wait: move B to Creature 1 first then back to Creature 2 so B has newer ts than Aura!)
		activateEquip(state, p1, equipB, creature1);
		activateEquip(state, p1, equipB, creature2);
		assert.ok((equipB.enteredTimestamp ?? 0) > (aura.enteredTimestamp ?? 0));
		assert.equal(evaluatePermanent(state, creature2).power, 4, 'B (4/4) currently beats A on Creature 2');

		// Activate Aura's "{1}: Attach ~ to target creature you control." targeting Creature 2!
		const moveAuraAb = getEffectiveActivatedAbilities(state, p1, aura)[0];
		assert.ok(moveAuraAb, 'expected activated attach ability on Glimmerweave Shackle');
		p1.manaPool.C = 2;
		state.priorityPlayerIndex = 0;
		const tsBeforeMoveAura = state.nextTimestamp ?? 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: aura.instanceId,
				abilityId: moveAuraAb.id,
				targets: [{ kind: 'permanent', id: creature2.instanceId, label: creature2.card.name }]
			}).ok,
			true
		);
		passStep(state);
		assert.equal(aura.attachedToId, creature2.instanceId);
		assert.equal(
			aura.enteredTimestamp,
			tsBeforeMoveAura + 1,
			'Moving Aura to Creature 2 allocates exactly 1 new timestamp (CR 613.7e)'
		);
		assert.equal(evaluatePermanent(state, creature1).power, 2);
		assert.equal(
			evaluatePermanent(state, creature2).power,
			1,
			'Moved Aura has newer timestamp than Equipment B on Creature 2 (4/4 -> 1/1)'
		);
	});

	it('CR 613.7d–e: Aura entering battlefield from graveyard without being cast gets 1 fresh timestamp via attachObject', () => {
		const { state, p1 } = makeGame();
		p1.isBot = true; // auto-picks single legal enchant candidate without interactive prompt
		const host = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Stalwart Ox', typeLine: 'Creature — Ox', power: '2', toughness: '2' }),
			'battlefield'
		);
		const equipB = putInZone(state, p1, TITANPLATE_HARNESS, 'battlefield');
		p1.isBot = false;
		activateEquip(state, p1, equipB, host);
		assert.equal(evaluatePermanent(state, host).power, 4);

		const gyAura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mirebind Halo',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature has base power and toughness 1/1.',
				keywords: ['Enchant']
			}),
			'graveyard'
		);
		const returnSpell = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Restore Relic-Ward',
				manaCost: '{0}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Return target enchantment card from your graveyard to the battlefield.'
			}),
			'hand'
		);
		assert.equal(compileCard(returnSpell.card).fullySupported, true);

		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: returnSpell.instanceId,
				targets: [{ kind: 'graveyard_card', id: gyAura.instanceId, label: gyAura.card.name }]
			}).ok,
			true
		);
		const tsBeforeResolve = state.nextTimestamp ?? 0;
		// Pass priority to resolve spell; human receives CR 303.4f Aura host choice prompt
		passStep(state);
		if (state.pendingPrompts.length > 0) {
			const prm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: prm.id,
					answer: { kind: 'chooseObjects', objectIds: [host.instanceId] }
				}).ok,
				true
			);
		}
		assert.equal(gyAura.zone, 'battlefield');
		assert.equal(gyAura.attachedToId, host.instanceId);
		// Restore Relic-Ward moved to graveyard (+1 timestamp) and gyAura entered attached (+1 timestamp = +2 total, NOT +3!)
		assert.equal(
			state.nextTimestamp,
			tsBeforeResolve + 2,
			'Reanimating an Aura allocates 1 timestamp for the Aura and 1 for the resolving sorcery (no double-increment)'
		);
		assert.equal(evaluatePermanent(state, host).power, 1);
	});

	it('attachObject helper updates layer cache inside withStableLayerInputs and returns false on same host', () => {
		const attachFn = (
			zonesModule as unknown as {
				attachObject?: (s: GameState, obj: CardInstance, hostId: string) => boolean;
			}
		).attachObject;
		assert.equal(typeof attachFn, 'function', 'attachObject must be exported from runtime/zones.ts');

		const { state, p1 } = makeGame();
		const host = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Test Hound', typeLine: 'Creature — Dog', power: '2', toughness: '2' }),
			'battlefield'
		);
		const harness = putInZone(state, p1, TINSCALE_HARNESS, 'battlefield');
		assert.ok((harness.enteredTimestamp ?? 0) > (host.enteredTimestamp ?? 0));

		setLayerCacheCheck(true);
		try {
			withStableLayerInputs(state, () => {
				assert.equal(evaluatePermanent(state, host).power, 2);
				const tsBefore = state.nextTimestamp ?? 0;
				assert.equal(attachFn!(state, harness, host.instanceId), true);
				assert.equal(harness.enteredTimestamp, tsBefore + 1);
				// Must not throw a stable-scope violation and must reflect new attachment immediately!
				assert.equal(evaluatePermanent(state, host).power, 1);
				// Attaching again to same host is a CR 701.3b no-op
				assert.equal(attachFn!(state, harness, host.instanceId), false);
				assert.equal(state.nextTimestamp, tsBefore + 1);
			});
		} finally {
			setLayerCacheCheck(null);
		}
	});
});

// ============================================================================
// LIVING WEAPON (CR 702.92) & FOR MIRRODIN! (CR 702.163)
// ============================================================================

describe('Keyword: Living weapon (CR 702.92)', () => {
	it('creates a 0/0 black Phyrexian Germ on ETB and attaches, surviving with toughness buff and dying at 0/0 without it (CR 702.92a)', () => {
		const { state, p1 } = makeGame();

		// 1. Equipment giving +2/+1 keeps the 0/0 Phyrexian Germ alive as a 2/1
		const batterSkullProbe = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Batterskull Probe',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact — Equipment',
				oracleText: 'Living weapon\nEquipped creature gets +2/+1.\nEquip {2}'
			}),
			'hand'
		);
		p1.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: batterSkullProbe.instanceId,
				optionId: 'normal'
			}).ok,
			true
		);
		passStep(state); // resolve Equipment onto battlefield and Living weapon ETB trigger
		const bsOnBoard = p1.battlefield.find((c) => c.instanceId === batterSkullProbe.instanceId);
		assert.ok(bsOnBoard, 'Batterskull Probe enters the battlefield');

		const germ = p1.battlefield.find((c) => c.card.typeLine.includes('Germ'));
		assert.ok(germ, 'Living weapon creates a Phyrexian Germ token');
		assert.deepEqual(germ.card.colors, ['B']);
		assert.equal(germ.card.typeLine, 'Token Creature — Phyrexian Germ');
		assert.equal(bsOnBoard.attachedToId, germ.instanceId);
		assert.equal(evaluatePermanent(state, germ).power, 2);
		assert.equal(evaluatePermanent(state, germ).toughness, 1);

		// 2. Equipment giving +2/+0 leaves Germ at 0 toughness -> SBA puts Germ in graveyard, leaving Equipment unattached
		const renamedZeroTough = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Renamed Lash Probe',
				manaCost: '{1}',
				cmc: 1,
				typeLine: 'Artifact — Equipment',
				oracleText: 'Living weapon\nEquipped creature gets +2/+0.\nEquip {2}'
			}),
			'hand'
		);
		p1.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: renamedZeroTough.instanceId,
				optionId: 'normal'
			}).ok,
			true
		);
		passStep(state); // resolve Equipment and Living weapon trigger + SBAs run
		const lashOnBoard = p1.battlefield.find((c) => c.instanceId === renamedZeroTough.instanceId);
		assert.ok(lashOnBoard);
		assert.equal(lashOnBoard.attachedToId ?? null, null);
		assert.equal(p1.battlefield.filter((c) => c.card.typeLine.includes('Germ')).length, 1, 'only the 2/1 Germ survives');
	});
});

describe('Keyword: For Mirrodin! (CR 702.163)', () => {
	it('creates a 2/2 red Rebel token on ETB and attaches the Equipment to it (CR 702.163a)', () => {
		const { state, p1 } = makeGame();
		const hexplate = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Hexplate Visitant Probe',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact — Equipment',
				oracleText: 'For Mirrodin!\nEquipped creature gets +1/+1.\nEquip {2}'
			}),
			'hand'
		);
		const renamedHexplate = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mirrored Rebellion Blade',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact — Equipment',
				oracleText: 'For Mirrodin!\nEquipped creature gets +1/+1.\nEquip {2}'
			}),
			'hand'
		);

		p1.manaPool.C = 4;
		for (const eq of [hexplate, renamedHexplate]) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: eq.instanceId,
					optionId: 'normal'
				}).ok,
				true
			);
			passStep(state); // resolve Equipment and For Mirrodin! ETB trigger
			const eqOnBoard = p1.battlefield.find((c) => c.instanceId === eq.instanceId);
			assert.ok(eqOnBoard, 'Equipment enters the battlefield');
			const rebel = p1.battlefield.find((c) => c.instanceId === eqOnBoard.attachedToId);
			assert.ok(rebel, 'Equipment attaches to newly created Rebel token');
			assert.deepEqual(rebel.card.colors, ['R']);
			assert.equal(rebel.card.typeLine, 'Token Creature — Rebel');
			assert.equal(evaluatePermanent(state, rebel).power, 3);
			assert.equal(evaluatePermanent(state, rebel).toughness, 3);
		}
	});
});
