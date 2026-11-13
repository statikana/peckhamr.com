import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { getEffectiveActivatedAbilities } from '../ruleTree.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';

function staple(name: string): ScryfallCard {
	const c = STAPLE_CARDS[name.toLowerCase()];
	assert.ok(c, `missing staple ${name}`);
	return c;
}

function syntheticCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `syn_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}{U}',
		cmc: overrides.cmc ?? 2,
		typeLine: overrides.typeLine ?? 'Creature — Illusion',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? ['U'],
		colorIdentity: overrides.colorIdentity ?? ['U'],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? (overrides.typeLine?.includes('Creature') === false ? undefined : '2'),
		toughness:
			overrides.toughness ?? (overrides.typeLine?.includes('Creature') === false ? undefined : '2'),
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
	const decks = new Map<number, MagicDeck>();
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
			lastHeartbeat: 0
		});
		decks.set(i, d);
	}
	const state = createInitialGameState('PHASING_TEST', seats, decks, DEFAULT_LOBBY_RULES);
	for (let i = 0; i < 2; i++) {
		applyGameAction(state, `p${i + 1}`, { type: 'mulligan_keep' });
	}
	state.turnNumber = 2;
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
	}
	return { state, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: Exclude<ZoneType, 'stack'>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	const inst = createCardInstance(
		card,
		player.playerId,
		zone,
		false,
		false,
		state.nextTimestamp,
		state
	);
	if (zone === 'battlefield') inst.summoningSick = false;
	player[zone].push(inst);
	return inst;
}

function passBothPlayers(state: GameState): void {
	const first = state.players[state.priorityPlayerIndex].playerId;
	const r1 = applyGameAction(state, first, { type: 'pass_priority' });
	assert.equal(r1.ok, true, r1.error ?? '');
	const second = state.players[state.priorityPlayerIndex].playerId;
	const r2 = applyGameAction(state, second, { type: 'pass_priority' });
	assert.equal(r2.ok, true, r2.error ?? '');
}

/**
 * Advance from `end_step` of `fromPlayerIndex` into `upkeep` of the next player's turn via real
 * `applyGameAction({ type: 'pass_priority' })` calls so `executeUntapTurnBasedActions` runs through
 * the normal turn-advancement pipeline.
 */
function advanceFromEndStepToNextPlayerUpkeep(state: GameState, fromPlayerIndex: number): void {
	state.activePlayerIndex = fromPlayerIndex;
	state.priorityPlayerIndex = fromPlayerIndex;
	state.phase = 'end_step';
	state.passedPriorityPlayerIds = [];
	state.stack = [];
	passBothPlayers(state);
	assert.equal(state.activePlayerIndex, (fromPlayerIndex + 1) % state.players.length);
	assert.equal(state.phase, 'upkeep');
}

describe('Keyword: Phasing (CR 702.26)', () => {
	it('compiles standalone, comma-separated, static-grant, token, and timed-grant/removal Phasing forms cleanly', () => {
		// Real Magic card Oracle text: Breezekeeper ({3}{U}, 4/4 Djinn, "Flying\nPhasing")
		const breezekeeper = syntheticCard({
			name: 'Breezekeeper',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Creature — Djinn',
			oracleText: 'Flying\nPhasing',
			power: '4',
			toughness: '4'
		});
		const bkDef = compileCard(breezekeeper);
		assert.equal(bkDef.fullySupported, true);
		assert.deepEqual(
			bkDef.faces[0].abilities.map((a) => (a.kind === 'keyword' ? a.keyword.name : a.kind)),
			['flying', 'phasing']
		);

		// Synthetic card with comma-separated keyword line
		const tidewalker = syntheticCard({
			name: 'Mistveil Tidewalker',
			oracleText: 'Flying, vigilance, phasing'
		});
		const twDef = compileCard(tidewalker);
		assert.equal(twDef.fullySupported, true);
		assert.deepEqual(
			twDef.faces[0].abilities.map((a) => (a.kind === 'keyword' ? a.keyword.name : a.kind)),
			['flying', 'vigilance', 'phasing']
		);

		// Static grant, token phrase, & timed grant/removal
		const lattice = syntheticCard({
			name: 'Aether-Phase Lattice',
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control have phasing.'
		});
		assert.equal(compileCard(lattice).fullySupported, true);

		const tokenSpell = syntheticCard({
			name: 'Conjure Mistform',
			typeLine: 'Sorcery',
			oracleText: 'Create a 2/2 blue Illusion creature token with phasing.'
		});
		assert.equal(compileCard(tokenSpell).fullySupported, true);

		const trick = syntheticCard({
			name: 'Veilpulse Snap',
			typeLine: 'Instant',
			oracleText: 'Target creature gains phasing until end of turn.'
		});
		assert.equal(compileCard(trick).fullySupported, true);

		const anchor = syntheticCard({
			name: 'Anchor of Reality Pulse',
			typeLine: 'Instant',
			oracleText: 'Creatures your opponents control lose phasing until end of turn.'
		});
		assert.equal(compileCard(anchor).fullySupported, true);
	});

	it('phases out before untapping, simultaneously phases in previously phased-out permanents, and untaps on phase-in (CR 502.1, 702.26a, 702.26p)', () => {
		const { state, p1 } = makeGame();

		// Tapped permanent with Phasing currently phased in -> phases out BEFORE untapping (stays tapped while phased out)
		const crocodile = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Sandbar Crocodile',
				manaCost: '{4}{U}',
				cmc: 5,
				typeLine: 'Creature — Crocodile',
				oracleText: 'Phasing',
				power: '6',
				toughness: '5'
			}),
			'battlefield'
		);
		crocodile.tapped = true;

		// Synthetic creature with Phasing already phased out and tapped ->
		// phases in BEFORE untapping, does NOT immediately phase back out, and untaps in the untap step!
		const tidewalker = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mistveil Tidewalker',
				oracleText: 'Phasing'
			}),
			'battlefield'
		);
		tidewalker.phasedOut = true;
		tidewalker.phasedOutIndirectly = false;
		tidewalker.tapped = true;

		// End P2's turn -> P1's untap step runs
		advanceFromEndStepToNextPlayerUpkeep(state, 1);

		assert.equal(crocodile.phasedOut, true, 'Phased-in creature with Phasing must phase out');
		assert.equal(crocodile.phasedOutIndirectly, false);
		assert.equal(
			crocodile.tapped,
			true,
			'Creature that phased out before untap does not untap while phased out'
		);

		assert.equal(
			tidewalker.phasedOut,
			false,
			'Previously phased-out creature phases in simultaneously without re-phasing out'
		);
		assert.equal(
			tidewalker.tapped,
			false,
			'Creature that phased in before untap untaps normally during the untap step'
		);

		// End P1's turn -> P2's untap step: neither P1 permanent phases in or out on P2's untap
		advanceFromEndStepToNextPlayerUpkeep(state, 0);
		assert.equal(crocodile.phasedOut, true);
		assert.equal(tidewalker.phasedOut, false);

		// End P2's turn -> P1's next untap step: Crocodile phases back in (and untaps!) while Tidewalker phases out
		advanceFromEndStepToNextPlayerUpkeep(state, 1);
		assert.equal(crocodile.phasedOut, false);
		assert.equal(crocodile.tapped, false);
		assert.equal(tidewalker.phasedOut, true);
	});

	it('treats phased-out permanents as non-existent for targeting, board wipes, and combat (CR 702.26b, 702.26e)', () => {
		const { state, p1, p2 } = makeGame();

		const phasedCreature = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mistveil Tidewalker',
				oracleText: 'Phasing',
				power: '3',
				toughness: '3'
			}),
			'battlefield'
		);
		const normalBear = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mossfield Bear',
				oracleText: '',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);

		// Trigger P1's untap so Mistveil Tidewalker phases out via its Phasing keyword
		advanceFromEndStepToNextPlayerUpkeep(state, 1);
		assert.equal(phasedCreature.phasedOut, true);

		// Advance to P1 main1
		passBothPlayers(state); // upkeep -> draw
		passBothPlayers(state); // draw -> main1
		assert.equal(state.phase, 'main1');

		// 1. Cannot target phased-out permanent with Swords to Plowshares
		const swords = putInZone(state, p1, staple('Swords to Plowshares'), 'hand');
		p1.manaPool.W = 2;
		const illegalTargetRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: swords.instanceId,
			targets: [{ kind: 'permanent', id: phasedCreature.instanceId, label: 'Mistveil Tidewalker' }]
		});
		assert.equal(illegalTargetRes.ok, false, 'Cannot target a phased-out creature');
		assert.match(illegalTargetRes.error ?? '', /target|legal|exist|battlefield/i);

		// 2. Wrath of God destroys phased-in Mossfield Bear and completely ignores phased-out Mistveil Tidewalker
		const wrath = putInZone(state, p1, staple('Wrath of God'), 'hand');
		p1.manaPool.W = 4;
		const castWrath = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: wrath.instanceId
		});
		assert.equal(castWrath.ok, true, castWrath.error ?? '');
		passBothPlayers(state);

		assert.equal(
			p1.graveyard.some((c) => c.instanceId === normalBear.instanceId),
			true,
			'Phased-in creature is destroyed by Wrath of God'
		);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === phasedCreature.instanceId),
			true,
			'Phased-out creature remains on the battlefield untouched by Wrath of God'
		);
		assert.equal(phasedCreature.phasedOut, true);

		// 3. Phasing out an attacker mid-combat removes it from combat so it deals 0 combat damage
		const attacker = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Charging Drake',
				oracleText: 'Haste',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		const phaseInstant = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Vanishing Wink',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Target creature phases out.'
			}),
			'hand'
		);

		passBothPlayers(state); // main1 -> begin_combat
		passBothPlayers(state); // begin_combat -> declare_attackers
		assert.equal(state.phase, 'declare_attackers');
		p2.manaPool.U = 1;

		const atkRes = applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(atkRes.ok, true, atkRes.error ?? '');

		// P1 passes priority -> P2 casts Vanishing Wink on the attacker
		assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
		const winkRes = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: phaseInstant.instanceId,
			targets: [{ kind: 'permanent', id: attacker.instanceId, label: 'Charging Drake' }]
		});
		assert.equal(winkRes.ok, true, winkRes.error ?? '');
		passBothPlayers(state); // resolve Vanishing Wink

		assert.equal(attacker.phasedOut, true);
		assert.equal(state.combat.attackers.length, 0, 'Phased-out attacker is removed from combat');
		passBothPlayers(state); // finish declare_attackers -> combat damage
		assert.equal(p2.life, 40, 'Removed attacker deals no combat damage');
	});

	it('does not change zones, fire ETB/LTB triggers, bump objectVersion, remove counters, or delete tokens (CR 702.26d)', () => {
		const { state, p1 } = makeGame();

		// Cast a spell that creates a 2/2 Illusion creature token with Phasing via applyGameAction
		const conjure = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Conjure Mistform',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Create a 2/2 blue Illusion creature token with phasing.'
			}),
			'hand'
		);
		p1.manaPool.U = 2;
		const castConjure = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: conjure.instanceId
		});
		assert.equal(castConjure.ok, true, castConjure.error ?? '');
		passBothPlayers(state);

		const tokenWithPhasing = p1.battlefield.find((c) => c.isToken)!;
		assert.ok(tokenWithPhasing, 'Expected Illusion token on battlefield');

		// Put +1/+1 counters on the token via a spell
		const bolster = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mistform Growth',
				manaCost: '{G}',
				cmc: 1,
				colors: ['G'],
				colorIdentity: ['G'],
				typeLine: 'Sorcery',
				oracleText: 'Put three +1/+1 counters on target creature.'
			}),
			'hand'
		);
		p1.manaPool.G = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolster.instanceId,
				targets: [{ kind: 'permanent', id: tokenWithPhasing.instanceId, label: 'Illusion' }]
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.equal(tokenWithPhasing.counters['+1/+1'], 3);

		// Observer creature that triggers whenever another creature enters or dies
		putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Soulwatch Chronicler',
				manaCost: '{1}{W}',
				colors: ['W'],
				colorIdentity: ['W'],
				typeLine: 'Creature — Cleric',
				oracleText:
					'Whenever another creature you control enters, you gain 1 life.\nWhenever another creature you control dies, you gain 1 life.'
			}),
			'battlefield'
		);

		const versionBefore = tokenWithPhasing.objectVersion;
		const lifeBefore = p1.life;

		// P1 untap #1: token phases out
		advanceFromEndStepToNextPlayerUpkeep(state, 1);
		assert.equal(tokenWithPhasing.phasedOut, true);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === tokenWithPhasing.instanceId),
			true,
			'Phased-out token does not leave the battlefield or cease to exist via SBA 704.5d'
		);
		assert.equal(tokenWithPhasing.objectVersion, versionBefore, 'objectVersion does not change');
		assert.equal(tokenWithPhasing.counters['+1/+1'], 3, 'Counters remain on phased-out permanent');
		assert.equal(state.stack.length, 0, 'No LTB/dies triggers fire on phase-out');
		assert.equal(p1.life, lifeBefore);

		// P1 untap #2: token phases back in
		advanceFromEndStepToNextPlayerUpkeep(state, 0); // P2 turn
		advanceFromEndStepToNextPlayerUpkeep(state, 1); // P1 turn
		assert.equal(tokenWithPhasing.phasedOut, false);
		assert.equal(tokenWithPhasing.objectVersion, versionBefore, 'objectVersion preserved on phase-in');
		assert.equal(tokenWithPhasing.counters['+1/+1'], 3, '+1/+1 counters preserved on phase-in');
		assert.equal(evaluatePermanent(state, tokenWithPhasing).power, 5);
		assert.equal(state.stack.length, 0, 'No ETB triggers fire on phase-in');
		assert.equal(p1.life, lifeBefore);
	});

	it('handles indirect attachment phasing, simultaneous direct+indirect phase-out (CR 702.26g, 702.26h), and direct Aura SBA on phase-in (CR 702.26i)', () => {
		const { state, p1, p2 } = makeGame();

		// 1. Host with Phasing + Swiftfoot Boots + synthetic Equipment that ALSO has Phasing, equipped via applyGameAction!
		const host = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Breezekeeper',
				oracleText: 'Flying\nPhasing',
				power: '4',
				toughness: '4'
			}),
			'battlefield'
		);
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		const phasingMantle = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Chronoshift Mantle',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Phasing\nEquipped creature gets +2/+2.\nEquip {1}'
			}),
			'battlefield'
		);

		const bootsEquipId = getEffectiveActivatedAbilities(state, p1, boots).find(
			(a) => !a.isManaAbility
		)!.id;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: bootsEquipId,
				targets: [{ kind: 'permanent', id: host.instanceId, label: 'Breezekeeper' }]
			}).ok,
			true
		);
		passBothPlayers(state);

		const mantleEquipId = getEffectiveActivatedAbilities(state, p1, phasingMantle).find(
			(a) => !a.isManaAbility
		)!.id;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: phasingMantle.instanceId,
				abilityId: mantleEquipId,
				targets: [{ kind: 'permanent', id: host.instanceId, label: 'Breezekeeper' }]
			}).ok,
			true
		);
		passBothPlayers(state);

		// 2. Cast a direct Aura with Phasing onto P2's non-Phasing creature via applyGameAction (CR 702.26i)
		const p2Bear = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Silvercoat Cub',
				oracleText: '',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const phasingAura = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Flickering Chains',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nPhasing\nEnchanted creature gets +0/+3.'
			}),
			'hand'
		);
		p1.manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: phasingAura.instanceId,
				targets: [{ kind: 'permanent', id: p2Bear.instanceId, label: 'Silvercoat Cub' }]
			}).ok,
			true
		);
		passBothPlayers(state);
		const auraOnBoard = p1.battlefield.find((c) => c.card.name === 'Flickering Chains')!;
		assert.ok(auraOnBoard);
		assert.equal(evaluatePermanent(state, p2Bear).toughness, 5);

		// P1 untap: host phases out directly; BOTH boots and Chronoshift Mantle (which also has Phasing!)
		// phase out INDIRECTLY per CR 702.26g & CR 702.26h; Flickering Chains phases out DIRECTLY while p2Bear stays!
		advanceFromEndStepToNextPlayerUpkeep(state, 1);

		assert.equal(host.phasedOut, true);
		assert.equal(host.phasedOutIndirectly, false);
		assert.equal(boots.phasedOut, true);
		assert.equal(boots.phasedOutIndirectly, true);
		assert.equal(phasingMantle.phasedOut, true);
		assert.equal(
			phasingMantle.phasedOutIndirectly,
			true,
			'CR 702.26h: attachment with Phasing on a phasing-out host must phase out indirectly, not directly'
		);

		assert.equal(p2Bear.phasedOut, false);
		assert.equal(auraOnBoard.phasedOut, true);
		assert.equal(
			auraOnBoard.phasedOutIndirectly,
			false,
			'Aura with Phasing on a non-phasing host phases out directly'
		);
		assert.equal(
			evaluatePermanent(state, p2Bear).toughness,
			2,
			'Phased-out Aura does not modify its host while phased out (CR 702.26b)'
		);

		// Exile p2Bear with Swords to Plowshares via applyGameAction while Flickering Chains is phased out (CR 702.26i)
		const swords = putInZone(state, p1, staple('Swords to Plowshares'), 'hand');
		p1.manaPool.W = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: swords.instanceId,
				targets: [{ kind: 'permanent', id: p2Bear.instanceId, label: 'Silvercoat Cub' }]
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.equal(p2.exile.some((c) => c.instanceId === p2Bear.instanceId), true);

		// P2 untap -> P1 next untap
		advanceFromEndStepToNextPlayerUpkeep(state, 0);
		advanceFromEndStepToNextPlayerUpkeep(state, 1);

		// Host, Boots, and Chronoshift Mantle all phase back in still attached!
		assert.equal(host.phasedOut, false);
		assert.equal(boots.phasedOut, false);
		assert.equal(boots.attachedToId, host.instanceId);
		assert.equal(phasingMantle.phasedOut, false);
		assert.equal(phasingMantle.attachedToId, host.instanceId);
		assert.equal(evaluatePermanent(state, host).power, 6);

		// Flickering Chains phased in without its host and was placed in P1's graveyard as an SBA (CR 702.26i, 704.5m)
		assert.equal(
			p1.graveyard.some((c) => c.instanceId === auraOnBoard.instanceId),
			true,
			'CR 702.26i: directly phased-out Aura whose host left the battlefield goes to graveyard via SBA on phase-in'
		);

		// Also verify CR 702.26h on Teferi's Protection ("All permanents you control phase out"):
		// Equipment attached to a controlled creature phases out indirectly, not directly!
		passBothPlayers(state); // upkeep -> draw
		passBothPlayers(state); // draw -> main1
		const teferi = putInZone(state, p1, staple("Teferi's Protection"), 'hand');
		p1.manaPool.W = 3;
		const castTef = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: teferi.instanceId
		});
		assert.equal(castTef.ok, true, castTef.error ?? '');
		passBothPlayers(state);

		assert.equal(host.phasedOut, true);
		assert.equal(host.phasedOutIndirectly, false);
		assert.equal(boots.phasedOut, true);
		assert.equal(
			boots.phasedOutIndirectly,
			true,
			"CR 702.26h: Equipment attached to a permanent simultaneously phased out by Teferi's Protection phases out indirectly"
		);
	});

	it('respects gain and loss of Phasing in Layer 6, while ability-loss never prevents an already phased-out permanent from phasing in (CR 702.26a)', () => {
		const { state, p1 } = makeGame();

		// 1. Static grant ("Creatures you control have phasing") makes a vanilla creature phase out on untap
		const bear = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Plain Tide Bear', oracleText: '' }),
			'battlefield'
		);
		const lattice = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Aether-Phase Lattice',
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control have phasing.'
			}),
			'battlefield'
		);
		assert.equal(evaluatePermanent(state, bear).activeKeywords.includes('Phasing'), true);

		advanceFromEndStepToNextPlayerUpkeep(state, 1);
		assert.equal(bear.phasedOut, true, 'Creature granted Phasing phases out on untap');

		// Advance to main1 and destroy Aether-Phase Lattice via applyGameAction
		passBothPlayers(state); // upkeep -> draw
		passBothPlayers(state); // draw -> main1
		const disenchant = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Shatter Weave',
				manaCost: '{1}{W}',
				cmc: 2,
				colors: ['W'],
				colorIdentity: ['W'],
				typeLine: 'Instant',
				oracleText: 'Destroy target enchantment.'
			}),
			'hand'
		);
		p1.manaPool.W = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: disenchant.instanceId,
				targets: [{ kind: 'permanent', id: lattice.instanceId, label: 'Aether-Phase Lattice' }]
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.equal(p1.graveyard.some((c) => c.instanceId === lattice.instanceId), true);

		// 2. Put a printed-Phasing creature on P1's battlefield, then cast an ability-removing enchantment
		// ("Creatures lose all abilities.") before P1's next untap:
		// - `bear` (already phased out) MUST STILL phase in (phasing in does not require having Phasing, CR 702.26a)!
		// - `djinn` (phased in, lost Phasing in Layer 6) MUST NOT phase out!
		const djinn = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mistveil Tidewalker',
				oracleText: 'Phasing'
			}),
			'battlefield'
		);
		const nullMist = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Nullifying Mist',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Enchantment',
				oracleText: 'Creatures lose all abilities.'
			}),
			'hand'
		);
		p1.manaPool.U = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: nullMist.instanceId
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.equal(evaluatePermanent(state, djinn).activeKeywords.includes('Phasing'), false);

		advanceFromEndStepToNextPlayerUpkeep(state, 0); // P2 turn
		advanceFromEndStepToNextPlayerUpkeep(state, 1); // P1 turn

		assert.equal(
			bear.phasedOut,
			false,
			'Already phased-out creature still phases in even under "Creatures lose all abilities" (CR 702.26a)'
		);
		assert.equal(
			djinn.phasedOut,
			false,
			'Creature that lost Phasing in Layer 6 does not phase out during untap'
		);
	});
});
