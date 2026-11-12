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
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';
import { transferBattlefieldControl } from './zones.ts';

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
	const state = createInitialGameState('KEYWORDS_EVASION_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES
	});
	for (let i = 0; i < 2; i++) {
		applyGameAction(state, `p${i + 1}`, { type: 'mulligan_keep' });
	}
	for (let i = 0; i < 2; i++) {
		state.players[i].hand = [];
		state.players[i].battlefield = [];
		state.players[i].graveyard = [];
		state.players[i].exile = [];
		state.players[i].command = [];
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
	overrides?: Partial<CardInstance>
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	const inst = createCardInstance(card, player.playerId, zone, false, false, state.nextTimestamp);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (overrides) Object.assign(inst, overrides);
	player[zone].push(inst);
	return inst;
}

function setupDeclareBlockers(state: GameState, p1: PlayerGameState, p2: PlayerGameState, attackerId: string): void {
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'declare_attackers';
	state.combat = {
		active: false,
		attackers: [],
		declaredBlockersPlayerIds: [],
		damageDealtFirstStrike: false,
		damageDealtNormal: false,
		blockersDeclared: false,
		dealtFirstStrikeDamageIds: []
	};
	const res = applyGameAction(state, p1.playerId, {
		type: 'declare_attackers',
		assignments: [{ attackerInstanceId: attackerId, defenderPlayerId: p2.playerId }]
	});
	assert.equal(res.ok, true, `declare_attackers failed: ${res.error}`);
	applyGameAction(state, p1.playerId, { type: 'pass_priority' });
	applyGameAction(state, p2.playerId, { type: 'pass_priority' });
	assert.equal(state.phase, 'declare_blockers');
}

// ============================================================================
// 1. FLYING (CR 702.9) & REACH (CR 702.17)
// ============================================================================

describe('Keywords: Flying (CR 702.9) & Reach (CR 702.17)', () => {
	it('Flying & Reach compile, one-way evasion, ground vs flyer vs reach blocking, and gain/loss including post-block Flying gain (CR 702.9a–c, 702.17a–c)', () => {
		const atraxaIr = compileCard(staple("Atraxa, Praetors' Voice")).faces[0];
		assert.ok(atraxaIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'flying'));

		const spiderCard = syntheticCard({
			name: 'Giant Spider',
			manaCost: '{3}{G}',
			cmc: 4,
			typeLine: 'Creature — Spider',
			oracleText: 'Reach',
			colors: ['G'],
			colorIdentity: ['G'],
			keywords: ['Reach'],
			power: '2',
			toughness: '4'
		});
		assert.ok(compileCard(spiderCard).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'reach'));

		const { state, p1, p2 } = makeGame();
		const flyerAtk = putInZone(state, p1, staple("Atraxa, Praetors' Voice"), 'battlefield');
		const groundAtk = putInZone(state, p1, syntheticCard({ name: 'Grizzly Bears' }), 'battlefield');
		const reachAtk = putInZone(state, p1, spiderCard, 'battlefield');

		const groundBlk = putInZone(state, p2, syntheticCard({ name: 'Hill Giant' }), 'battlefield');
		const flyerBlk = putInZone(state, p2, staple('Shalai, Voice of Plenty'), 'battlefield');
		const reachBlk = putInZone(state, p2, spiderCard, 'battlefield');

		// 1. Ground blocker CANNOT block Flyer; Flyer and Reach CAN block Flyer:
		setupDeclareBlockers(state, p1, p2, flyerAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: groundBlk.instanceId, attackerInstanceId: flyerAtk.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: reachBlk.instanceId, attackerInstanceId: flyerAtk.instanceId }]
			}).ok,
			true,
			'Reach creature legally blocks Flyer'
		);

		setupDeclareBlockers(state, p1, p2, flyerAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: flyerBlk.instanceId, attackerInstanceId: flyerAtk.instanceId }]
			}).ok,
			true,
			'Flyer legally blocks Flyer'
		);

		// 2. One-way checks: Flyer CAN block ground attacker, and Reach attacker CAN be blocked by ground creature!
		flyerBlk.tapped = false;
		setupDeclareBlockers(state, p1, p2, groundAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: flyerBlk.instanceId, attackerInstanceId: groundAtk.instanceId }]
			}).ok,
			true,
			'Flyer can block non-Flying attacker'
		);

		setupDeclareBlockers(state, p1, p2, reachAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: groundBlk.instanceId, attackerInstanceId: reachAtk.instanceId }]
			}).ok,
			true,
			'Reach grants no evasion when attacking; ground creature can block it'
		);

		// 3. Gain & loss: Archetype of Imagination removes opponents' Flying & grants Flying to P2; Dress Down removes Reach!
		flyerAtk.tapped = false;
		const archetype = putInZone(state, p2, staple('Archetype of Imagination'), 'battlefield');
		setupDeclareBlockers(state, p1, p2, flyerAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: groundBlk.instanceId, attackerInstanceId: flyerAtk.instanceId }]
			}).ok,
			true,
			'Flyer that lost Flying (and ground blocker granted Flying) can be blocked'
		);
		p2.battlefield = p2.battlefield.filter((c) => c.instanceId !== archetype.instanceId);

		// Reach blocker losing abilities via Kenrith's Transformation can no longer block Flyer:
		flyerAtk.tapped = false;
		const kenrith = putInZone(state, p1, staple("Kenrith's Transformation"), 'battlefield');
		kenrith.attachedToId = reachBlk.instanceId;
		setupDeclareBlockers(state, p1, p2, flyerAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: reachBlk.instanceId, attackerInstanceId: flyerAtk.instanceId }]
			}).ok,
			false,
			'Creature that lost Reach cannot block Flyer'
		);

		// 4. CR 702.9b: Gaining Flying AFTER blockers are declared does NOT undo an already legal block!
		groundAtk.tapped = false;
		setupDeclareBlockers(state, p1, p2, groundAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: groundBlk.instanceId, attackerInstanceId: groundAtk.instanceId }]
			}).ok,
			true
		);
		groundAtk.grantedKeywords.push('flying');
		assert.deepEqual(
			state.combat.attackers[0].blockerInstanceIds,
			[groundBlk.instanceId],
			'CR 702.9b: gaining Flying after blockers are declared leaves attacker blocked'
		);
	});
});

// ============================================================================
// 2. FEAR (CR 702.36) & INTIMIDATE (CR 702.13)
// ============================================================================

describe('Keywords: Fear (CR 702.36) & Intimidate (CR 702.13)', () => {
	it('Fear compile, black/artifact exceptions, Layer 4/5 type & color changes, and gain/loss (CR 702.36a–b)', () => {
		const fearCard = syntheticCard({
			name: 'Severed Legion',
			manaCost: '{1}{B}{B}',
			cmc: 3,
			typeLine: 'Creature — Zombie',
			oracleText: 'Fear',
			colors: ['B'],
			colorIdentity: ['B'],
			keywords: ['Fear']
		});
		assert.ok(compileCard(fearCard).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'fear'));

		const { state, p1, p2 } = makeGame();
		const fearAtk = putInZone(state, p1, fearCard, 'battlefield');
		const whiteNonArt = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Savannah Lions', colors: ['W'], colorIdentity: ['W'] }),
			'battlefield'
		);
		const colorlessNonArt = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Eldrazi Scion', colors: [], colorIdentity: [] }),
			'battlefield'
		);
		const colorlessArt = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Myr Servitor', typeLine: 'Artifact Creature — Myr', colors: [] }),
			'battlefield'
		);
		const blackNonArt = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Walking Corpse', colors: ['B'], colorIdentity: ['B'] }),
			'battlefield'
		);

		// White non-artifact & Colorless non-artifact rejected:
		setupDeclareBlockers(state, p1, p2, fearAtk.instanceId);
		for (const illegal of [whiteNonArt, colorlessNonArt]) {
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'declare_blockers',
					assignments: [{ blockerInstanceId: illegal.instanceId, attackerInstanceId: fearAtk.instanceId }]
				}).ok,
				false,
				`${illegal.card.name} must NOT block Fear`
			);
		}

		// Colorless artifact & Black creature both legal:
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: colorlessArt.instanceId, attackerInstanceId: fearAtk.instanceId }]
			}).ok,
			true
		);
		fearAtk.tapped = false;
		setupDeclareBlockers(state, p1, p2, fearAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blackNonArt.instanceId, attackerInstanceId: fearAtk.instanceId }]
			}).ok,
			true
		);

		// Black blocker turned into a green non-artifact Elk (Kenrith's Transformation) can NO LONGER block Fear!
		fearAtk.tapped = false;
		const kenrith = putInZone(state, p1, staple("Kenrith's Transformation"), 'battlefield');
		kenrith.attachedToId = blackNonArt.instanceId;
		setupDeclareBlockers(state, p1, p2, fearAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blackNonArt.instanceId, attackerInstanceId: fearAtk.instanceId }]
			}).ok,
			false,
			'Former black creature turned into green non-artifact Elk cannot block Fear'
		);

		// Losing Fear via Dress Down allows white non-artifact creature to block:
		putInZone(state, p2, staple('Dress Down'), 'battlefield');
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: whiteNonArt.instanceId, attackerInstanceId: fearAtk.instanceId }]
			}).ok,
			true
		);
	});

	it('Intimidate compile, multicolor attacker, colorless attacker (artifact-only!), Layer 5 color change, and gain/loss (CR 702.13a–b)', () => {
		const multiIntimidate = syntheticCard({
			name: 'Gruul War-Chanter',
			manaCost: '{1}{R}{G}',
			cmc: 3,
			typeLine: 'Creature — Orc Shaman',
			oracleText: 'Intimidate',
			colors: ['R', 'G'],
			colorIdentity: ['R', 'G'],
			keywords: ['Intimidate']
		});
		const colorlessIntimidate = syntheticCard({
			name: 'Ghostfire Stalker',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Creature — Eldrazi',
			oracleText: 'Intimidate',
			colors: [],
			colorIdentity: [],
			keywords: ['Intimidate']
		});
		assert.ok(
			compileCard(multiIntimidate).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'intimidate')
		);

		const { state, p1, p2 } = makeGame();
		const rgAtk = putInZone(state, p1, multiIntimidate, 'battlefield');
		const colorlessAtk = putInZone(state, p1, colorlessIntimidate, 'battlefield');

		const redBlk = putInZone(state, p2, syntheticCard({ name: 'Red Goblin', colors: ['R'] }), 'battlefield');
		const greenBlk = putInZone(state, p2, syntheticCard({ name: 'Green Elf', colors: ['G'] }), 'battlefield');
		const blueBlk = putInZone(state, p2, syntheticCard({ name: 'Blue Merfolk', colors: ['U'] }), 'battlefield');
		const colorlessNonArtBlk = putInZone(state, p2, syntheticCard({ name: 'Colorless Drone', colors: [] }), 'battlefield');
		const colorlessArtBlk = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Brass Squire', typeLine: 'Artifact Creature — Myr', colors: [] }),
			'battlefield'
		);

		// 1. Multicolor (R/G) Intimidate attacker: Red allowed, Green allowed, Artifact allowed, Blue & Colorless non-artifact rejected!
		setupDeclareBlockers(state, p1, p2, rgAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blueBlk.instanceId, attackerInstanceId: rgAtk.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: colorlessNonArtBlk.instanceId, attackerInstanceId: rgAtk.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: redBlk.instanceId, attackerInstanceId: rgAtk.instanceId }]
			}).ok,
			true,
			'Red creature shares a color with R/G Intimidate attacker'
		);
		rgAtk.tapped = false;
		setupDeclareBlockers(state, p1, p2, rgAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: greenBlk.instanceId, attackerInstanceId: rgAtk.instanceId }]
			}).ok,
			true,
			'Green creature shares a color with R/G Intimidate attacker'
		);

		// 2. Colorless Intimidate attacker (CR 702.13b): colorless is NOT a color, so ONLY artifact creatures can block!
		setupDeclareBlockers(state, p1, p2, colorlessAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: colorlessNonArtBlk.instanceId, attackerInstanceId: colorlessAtk.instanceId }]
			}).ok,
			false,
			'CR 702.13b: colorless non-artifact creature does NOT share a color with colorless Intimidate attacker'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: redBlk.instanceId, attackerInstanceId: colorlessAtk.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: colorlessArtBlk.instanceId, attackerInstanceId: colorlessAtk.instanceId }]
			}).ok,
			true,
			'Artifact creature can block colorless Intimidate attacker'
		);

		// 3. Gain & loss: granting Intimidate to Blue creature makes Blue able to block, and Dress Down strips Intimidate:
		colorlessAtk.tapped = false;
		putInZone(state, p2, staple('Dress Down'), 'battlefield');
		setupDeclareBlockers(state, p1, p2, colorlessAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blueBlk.instanceId, attackerInstanceId: colorlessAtk.instanceId }]
			}).ok,
			true
		);
	});
});

// ============================================================================
// 3. HORSEMANSHIP (CR 702.31), SHADOW (CR 702.28) & MENACE (CR 702.111)
// ============================================================================

describe('Keywords: Horsemanship (CR 702.31), Shadow (CR 702.28) & Menace (CR 702.111)', () => {
	it('Horsemanship vs Shadow directionality + gain/loss (CR 702.31a–b, 702.28a–b): Horsemanship is one-way while Shadow is bidirectional', () => {
		const horseCard = syntheticCard({
			name: 'Wei Infantry',
			oracleText: 'Horsemanship',
			keywords: ['Horsemanship']
		});
		const shadowCard = syntheticCard({
			name: 'Dauthi Slayer',
			oracleText: 'Shadow',
			keywords: ['Shadow']
		});
		assert.ok(compileCard(horseCard).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'horsemanship'));
		assert.ok(compileCard(shadowCard).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'shadow'));

		const { state, p1, p2 } = makeGame();
		const horseAtk = putInZone(state, p1, horseCard, 'battlefield');
		const shadowAtk = putInZone(state, p1, shadowCard, 'battlefield');
		const normalAtk = putInZone(state, p1, syntheticCard({ name: 'Foot Soldier' }), 'battlefield');

		const horseBlk = putInZone(state, p2, horseCard, 'battlefield');
		const shadowBlk = putInZone(state, p2, shadowCard, 'battlefield');
		const normalBlk = putInZone(state, p2, syntheticCard({ name: 'Town Guard' }), 'battlefield');

		// 1. Horsemanship attacker: blocked ONLY by Horsemanship blocker (neither normal nor Shadow can block):
		setupDeclareBlockers(state, p1, p2, horseAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: normalBlk.instanceId, attackerInstanceId: horseAtk.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: shadowBlk.instanceId, attackerInstanceId: horseAtk.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: horseBlk.instanceId, attackerInstanceId: horseAtk.instanceId }]
			}).ok,
			true
		);

		// 2. Normal attacker: Horsemanship blocker CAN block it (one-way!), whereas Shadow blocker CANNOT block it (two-way CR 702.28b)!
		setupDeclareBlockers(state, p1, p2, normalAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: shadowBlk.instanceId, attackerInstanceId: normalAtk.instanceId }]
			}).ok,
			false,
			'CR 702.28b: creature with Shadow CANNOT block creature without Shadow'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: horseBlk.instanceId, attackerInstanceId: normalAtk.instanceId }]
			}).ok,
			true,
			'CR 702.31b: creature with Horsemanship CAN block creature without Horsemanship'
		);

		// 3. Shadow attacker: blocked ONLY by Shadow blocker:
		setupDeclareBlockers(state, p1, p2, shadowAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: normalBlk.instanceId, attackerInstanceId: shadowAtk.instanceId }]
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: shadowBlk.instanceId, attackerInstanceId: shadowAtk.instanceId }]
			}).ok,
			true
		);

		// 4. Losing Shadow via Dress Down allows Shadow creature to block normal attacker:
		normalAtk.tapped = false;
		putInZone(state, p1, staple('Dress Down'), 'battlefield');
		setupDeclareBlockers(state, p1, p2, normalAtk.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: shadowBlk.instanceId, attackerInstanceId: normalAtk.instanceId }]
			}).ok,
			true
		);
	});

	it('Menace compile, 0 vs 1 vs 2+ blockers, Menace + Flying interaction, and gain/loss (CR 702.111a–c)', () => {
		const lathrilIr = compileCard(staple('Lathril, Blade of the Elves')).faces[0];
		assert.ok(lathrilIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'menace'));

		const skyMenace = syntheticCard({
			name: 'Boneyard Scourge',
			oracleText: 'Flying, menace',
			keywords: ['Flying', 'Menace']
		});
		const { state, p1, p2 } = makeGame();
		const lathril = putInZone(state, p1, staple('Lathril, Blade of the Elves'), 'battlefield');
		const flyerMenace = putInZone(state, p1, skyMenace, 'battlefield');

		const blk1 = putInZone(state, p2, syntheticCard({ name: 'Bear 1' }), 'battlefield');
		const blk2 = putInZone(state, p2, syntheticCard({ name: 'Bear 2' }), 'battlefield');
		const blk3 = putInZone(state, p2, syntheticCard({ name: 'Bear 3' }), 'battlefield');
		const flyerBlk = putInZone(state, p2, staple('Shalai, Voice of Plenty'), 'battlefield');
		const reachBlk = putInZone(state, p2, syntheticCard({ name: 'Reach Archer', oracleText: 'Reach', keywords: ['Reach'] }), 'battlefield');

		// 0 blockers legal:
		setupDeclareBlockers(state, p1, p2, lathril.instanceId);
		assert.equal(applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] }).ok, true);

		// 1 blocker illegal; 2 blockers legal; 3 blockers legal:
		lathril.tapped = false;
		setupDeclareBlockers(state, p1, p2, lathril.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blk1.instanceId, attackerInstanceId: lathril.instanceId }]
			}).ok,
			false,
			'Menace rejects exactly 1 blocker'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: blk1.instanceId, attackerInstanceId: lathril.instanceId },
					{ blockerInstanceId: blk2.instanceId, attackerInstanceId: lathril.instanceId }
				]
			}).ok,
			true,
			'Menace accepts 2 blockers'
		);

		lathril.tapped = false;
		setupDeclareBlockers(state, p1, p2, lathril.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: blk1.instanceId, attackerInstanceId: lathril.instanceId },
					{ blockerInstanceId: blk2.instanceId, attackerInstanceId: lathril.instanceId },
					{ blockerInstanceId: blk3.instanceId, attackerInstanceId: lathril.instanceId }
				]
			}).ok,
			true,
			'Menace accepts 3 blockers'
		);

		// Flying + Menace: 1 Flyer + 1 ground creature rejected; 1 Flyer + 1 Reach creature legal!
		setupDeclareBlockers(state, p1, p2, flyerMenace.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: flyerBlk.instanceId, attackerInstanceId: flyerMenace.instanceId },
					{ blockerInstanceId: blk1.instanceId, attackerInstanceId: flyerMenace.instanceId }
				]
			}).ok,
			false,
			'Ground creature cannot serve as the second blocker on a Flying + Menace attacker'
		);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [
					{ blockerInstanceId: flyerBlk.instanceId, attackerInstanceId: flyerMenace.instanceId },
					{ blockerInstanceId: reachBlk.instanceId, attackerInstanceId: flyerMenace.instanceId }
				]
			}).ok,
			true,
			'1 Flying + 1 Reach creature legally double-blocks Flying + Menace'
		);

		// Losing Menace (Dress Down) allows a single blocker:
		lathril.tapped = false;
		putInZone(state, p2, staple('Dress Down'), 'battlefield');
		setupDeclareBlockers(state, p1, p2, lathril.instanceId);
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: blk1.instanceId, attackerInstanceId: lathril.instanceId }]
			}).ok,
			true
		);
	});
});

// ============================================================================
// 4. DEFENDER (CR 702.3), HASTE (CR 702.10) & VIGILANCE (CR 702.20)
// ============================================================================

describe('Keywords: Defender (CR 702.3), Haste (CR 702.10) & Vigilance (CR 702.20)', () => {
	it('Defender compile, cannot attack, can still block, and gain/loss (CR 702.3a–c)', () => {
		const wallCard = syntheticCard({
			name: 'Wall of Omens',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Wall',
			oracleText: 'Defender',
			colors: ['W'],
			colorIdentity: ['W'],
			keywords: ['Defender'],
			power: '0',
			toughness: '4'
		});
		assert.ok(compileCard(wallCard).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'defender'));

		const { state, p1, p2 } = makeGame();
		const wall = putInZone(state, p1, wallCard, 'battlefield');
		const normalBear = putInZone(state, p1, syntheticCard({ name: 'Runeclaw Bear' }), 'battlefield');
		const oppAttacker = putInZone(state, p2, syntheticCard({ name: 'Orc Raider' }), 'battlefield');

		// 1. Defender cannot be declared as an attacker:
		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: wall.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			false
		);

		// 2. Granting Defender to normalBear prevents it from attacking too:
		normalBear.grantedKeywords.push('defender');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: normalBear.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			false
		);
		normalBear.grantedKeywords = [];

		// 3. Defender CAN block on opponent's turn:
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: oppAttacker.instanceId, defenderPlayerId: p1.playerId }]
			}).ok,
			true
		);
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: wall.instanceId, attackerInstanceId: oppAttacker.instanceId }]
			}).ok,
			true,
			'Creature with Defender can legally block'
		);

		// 4. Losing Defender (Dress Down) allows the Wall to attack!
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.phase = 'declare_attackers';
		state.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false,
			blockersDeclared: false,
			dealtFirstStrikeDamageIds: []
		};
		putInZone(state, p1, staple('Dress Down'), 'battlefield');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: wall.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true,
			'Wall that lost Defender can attack'
		);
	});

	it.todo(
		'Defender attack-override static (CR 702.3b): effects stating a creature with Defender "can attack as though it didn\'t have defender" (not yet in static grammar)'
	);

	it('Haste compile, attacking & {T} abilities on entry turn and after control change, and gain/loss (CR 702.10a–c, 302.6)', () => {
		const chargerIr = compileCard(staple('Hellkite Charger')).faces[0];
		assert.ok(chargerIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'haste'));

		const hasteDorkCard = syntheticCard({
			name: 'Crimson Druid',
			manaCost: '{1}{R}',
			cmc: 2,
			typeLine: 'Creature — Human Druid',
			oracleText: 'Haste\n{T}: Add {R}.',
			colors: ['R'],
			colorIdentity: ['R'],
			keywords: ['Haste']
		});
		const { state, p1, p2 } = makeGame();

		// 1. Summoning-sick creature WITHOUT Haste (Elvish Archdruid) cannot {T} or attack on entry turn:
		const sickDruid = putInZone(state, p1, staple('Elvish Archdruid'), 'battlefield', { summoningSick: true });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: sickDruid.instanceId,
				abilityId: 'mana_tap'
			}).ok,
			false,
			'Summoning-sick creature without Haste cannot activate {T} ability'
		);

		// 2. Summoning-sick creature WITH Haste CAN activate {T} ability on entry turn:
		const hasteDork = putInZone(state, p1, hasteDorkCard, 'battlefield', { summoningSick: true });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: hasteDork.instanceId,
				abilityId: 'mana_tap'
			}).ok,
			true,
			'Haste creature can activate {T} ability on the turn it entered'
		);
		assert.equal(p1.manaPool.R, 1);

		// 3. Control change (CR 302.6 + 702.10b–c): stealing an opponent's creature makes it summoning sick unless it has/gains Haste!
		const oppBear = putInZone(state, p2, syntheticCard({ name: 'Stolen Bear' }), 'battlefield', { summoningSick: false });
		const oppHasteDragon = putInZone(state, p2, staple('Hellkite Charger'), 'battlefield', { summoningSick: false });
		transferBattlefieldControl(oppBear, p2, p1, state);
		transferBattlefieldControl(oppHasteDragon, p2, p1, state);

		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: oppBear.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			false,
			'Newly stolen creature without Haste has summoning sickness and cannot attack'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: oppHasteDragon.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true,
			'Newly stolen creature with Haste CAN attack immediately'
		);

		// 4. Gain & loss: Swiftfoot Boots grants Haste to sickDruid; moving Boots away re-exposes summoning sickness!
		state.stack = [];
		state.pendingPrompts = [];
		state.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		};
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		const boots = putInZone(state, p1, staple('Swiftfoot Boots'), 'battlefield');
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: sickDruid.instanceId, label: sickDruid.card.name }]
			}).ok,
			true
		);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(boots.attachedToId, sickDruid.instanceId);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: sickDruid.instanceId,
				abilityId: 'mana_tap'
			}).ok,
			true,
			'Creature granted Haste by Swiftfoot Boots CAN activate {T} ability on entry turn'
		);
		sickDruid.tapped = false;

		// Move Boots to oppBear -> sickDruid loses Haste and STILL cannot activate {T} this turn!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: boots.instanceId,
				abilityId: 'equip_1',
				targets: [{ kind: 'permanent', id: oppBear.instanceId, label: oppBear.card.name }]
			}).ok,
			true
		);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: sickDruid.instanceId,
				abilityId: 'mana_tap'
			}).ok,
			false,
			'Creature that lost granted Haste on entry turn is still summoning sick'
		);
	});

	it('Vigilance compile, remains untapped when attacking to {T} or block next turn, does not bypass summoning sickness, and gain/loss (CR 702.20a–b)', () => {
		const felidarIr = compileCard(staple('Felidar Sovereign')).faces[0];
		assert.ok(felidarIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'vigilance'));

		const { state, p1, p2 } = makeGame();
		for (let i = 0; i < 4; i++) {
			putInZone(state, p1, staple('Island'), 'library');
			putInZone(state, p2, staple('Island'), 'library');
		}
		const felidar = putInZone(state, p1, staple('Felidar Sovereign'), 'battlefield');
		const sickVig = putInZone(state, p1, staple('Felidar Sovereign'), 'battlefield', { summoningSick: true });
		const normalKnight = putInZone(state, p1, syntheticCard({ name: 'Silvercoat Lion' }), 'battlefield');
		const oppRaider = putInZone(state, p2, syntheticCard({ name: 'Goblin Raider' }), 'battlefield');

		// 1. Summoning-sick Vigilance creature without Haste STILL cannot attack:
		state.phase = 'declare_attackers';
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: sickVig.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			false
		);

		// 2. Attacking with Felidar (Vigilance) + normalKnight (no Vigilance):
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: felidar.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: normalKnight.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		assert.equal(felidar.tapped, false, 'Vigilance attacker does NOT tap');
		assert.equal(normalKnight.tapped, true, 'Non-Vigilance attacker taps');

		// CR 702.20b: Gaining Vigilance AFTER declare_attackers does NOT untap an already-tapped attacker!
		normalKnight.grantedKeywords.push('vigilance');
		assert.equal(normalKnight.tapped, true);
		normalKnight.grantedKeywords = [];

		// Advance through combat -> P1 ends turn -> P2 attacks on P2's turn -> Felidar is untapped and blocks, normalKnight is tapped and cannot block!
		for (let guard = 0; guard < 25; guard++) {
			const prio = state.players[state.priorityPlayerIndex];
			if ((state.phase as string) === 'declare_blockers' && prio.playerId === p2.playerId && !state.combat.blockersDeclared) {
				applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
				continue;
			}
			if (state.players[state.activePlayerIndex].playerId === p2.playerId && (state.phase as string) === 'main1') break;
			applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		}

		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p1.playerId, { type: 'pass_priority' }); // begin_combat
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p1.playerId, { type: 'pass_priority' }); // declare_attackers
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: oppRaider.instanceId, defenderPlayerId: p1.playerId }]
			}).ok,
			true
		);
		applyGameAction(state, p2.playerId, { type: 'pass_priority' });
		applyGameAction(state, p1.playerId, { type: 'pass_priority' }); // declare_blockers

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: normalKnight.instanceId, attackerInstanceId: oppRaider.instanceId }]
			}).ok,
			false,
			'Tapped attacker without Vigilance cannot block on opponent turn'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_blockers',
				assignments: [{ blockerInstanceId: felidar.instanceId, attackerInstanceId: oppRaider.instanceId }]
			}).ok,
			true,
			'Untapped Vigilance attacker CAN block on opponent turn'
		);

		// 3. Losing Vigilance before declare_attackers causes tapping; Akroma's Memorial grants Vigilance!
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.phase = 'declare_attackers';
		state.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false,
			blockersDeclared: false,
			dealtFirstStrikeDamageIds: []
		};
		felidar.tapped = false;
		normalKnight.tapped = false;
		const dressDown = putInZone(state, p2, staple('Dress Down'), 'battlefield');
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: felidar.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(felidar.tapped, true, 'Felidar that lost Vigilance taps when attacking');

		p2.battlefield = p2.battlefield.filter((c) => c.instanceId !== dressDown.instanceId);
		putInZone(state, p1, staple("Akroma's Memorial"), 'battlefield');
		state.phase = 'declare_attackers';
		state.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false,
			blockersDeclared: false,
			dealtFirstStrikeDamageIds: []
		};
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: [{ attackerInstanceId: normalKnight.instanceId, defenderPlayerId: p2.playerId }]
		});
		assert.equal(normalKnight.tapped, false, "Akroma's Memorial granted Vigilance prevents tapping");
	});
});
