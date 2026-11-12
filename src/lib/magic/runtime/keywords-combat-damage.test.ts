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
	const state = createInitialGameState('KEYWORDS_COMBAT_DAMAGE_TEST', seats, decks, {
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

function passBothPlayers(state: GameState): void {
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

function declareCombat(
	state: GameState,
	p1: PlayerGameState,
	p2: PlayerGameState,
	atkAssignments: Array<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string;
	}>,
	blkAssignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }>
): void {
	state.combat = {
		active: false,
		attackers: [],
		declaredBlockersPlayerIds: [],
		damageDealtFirstStrike: false,
		damageDealtNormal: false
	};
	state.phase = 'declare_attackers';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	assert.equal(
		applyGameAction(state, p1.playerId, {
			type: 'declare_attackers',
			assignments: atkAssignments
		}).ok,
		true
	);
	passBothPlayers(state);
	assert.equal(state.phase, 'declare_blockers');
	assert.equal(
		applyGameAction(state, p2.playerId, {
			type: 'declare_blockers',
			assignments: blkAssignments
		}).ok,
		true
	);
}

let trickSeq = 0;
function castInstantOnCreature(
	state: GameState,
	caster: PlayerGameState,
	target: CardInstance,
	oracleText: string
): void {
	const savedPrio = state.priorityPlayerIndex;
	state.priorityPlayerIndex = state.players.findIndex((p) => p.playerId === caster.playerId);
	const isStrip = oracleText.includes('loses all abilities');
	const trick = putInZone(
		state,
		caster,
		syntheticCard({
			name: `Combat Trick ${++trickSeq}`,
			manaCost: '{0}',
			cmc: 0,
			typeLine: isStrip ? 'Enchantment — Aura' : 'Instant',
			oracleText: isStrip
				? 'Flash\nEnchant creature\nEnchanted creature loses all abilities.'
				: oracleText,
			keywords: isStrip ? ['Flash', 'Enchant'] : []
		}),
		'hand'
	);
	assert.equal(
		applyGameAction(state, caster.playerId, {
			type: 'cast_spell',
			instanceId: trick.instanceId,
			targets: [{ kind: 'permanent', id: target.instanceId, label: target.card.name }]
		}).ok,
		true,
		`Failed to cast instant: ${oracleText}`
	);
	passBothPlayers(state);
	state.priorityPlayerIndex = savedPrio;
	state.passedPriorityPlayerIds = [];
}

function resolveCombatDamagePrompts(
	state: GameState,
	expectedMinByBlockerId?: Record<string, number>
): void {
	let guard = 0;
	while (state.pendingPrompts.length > 0 && guard++ < 20) {
		const prm = state.pendingPrompts[0];
		assert.ok(prm?.choice?.kind === 'chooseNumber');
		const numChoice = prm.choice;
		if (expectedMinByBlockerId && prm.continuation?.kind === 'handler') {
			const key = String(prm.continuation.data?.key ?? '');
			const blockerId = key.split(':')[1];
			if (blockerId && expectedMinByBlockerId[blockerId] !== undefined) {
				assert.equal(
					numChoice.min,
					expectedMinByBlockerId[blockerId],
					`Expected minimum lethal assignment on ${blockerId}`
				);
			}
		}
		assert.equal(
			applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'chooseNumber', n: numChoice.defaultNumber ?? numChoice.min }
			}).ok,
			true
		);
	}
}

describe('Keywords: First strike (CR 702.7) & Double strike (CR 702.4)', () => {
	it('compiles First strike, Double strike, and comma-separated combat lines into keyword abilities', () => {
		const fsIr = compileCard(
			syntheticCard({ name: 'Blade Initiate', oracleText: 'First strike' })
		).faces[0];
		assert.ok(
			fsIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'first strike')
		);
		assert.equal(
			fsIr.abilities.some((a) => a.kind === 'unsupported'),
			false
		);

		const dsIr = compileCard(
			syntheticCard({ name: 'Fencing Ace', oracleText: 'Double strike' })
		).faces[0];
		assert.ok(
			dsIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'double strike')
		);

		const comboIr = compileCard(
			syntheticCard({
				name: 'Swift Assassin',
				oracleText: 'First strike, deathtouch\nDouble strike, lifelink'
			})
		).faces[0];
		for (const kw of ['first strike', 'deathtouch', 'double strike', 'lifelink']) {
			assert.ok(
				comboIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === kw),
				`Expected compiled keyword ${kw}`
			);
		}
	});

	it('creates two combat damage steps only when FS/DS is present, and kills normal creatures in step 1 before they deal damage (CR 510.4, 702.7b)', () => {
		// 1. Normal combat: NO first_strike_damage step
		{
			const { state, p1, p2 } = makeGame();
			const bear1 = putInZone(state, p1, syntheticCard({ name: 'Grizzly Bears' }), 'battlefield');
			const bear2 = putInZone(state, p2, syntheticCard({ name: 'Runeclaw Bear' }), 'battlefield');
			declareCombat(
				state,
				p1,
				p2,
				[{ attackerInstanceId: bear1.instanceId, defenderPlayerId: p2.playerId }],
				[{ blockerInstanceId: bear2.instanceId, attackerInstanceId: bear1.instanceId }]
			);
			passBothPlayers(state);
			assert.equal(state.phase, 'combat_damage', 'Normal combat skips first_strike_damage');
			assert.equal(Boolean(state.combat.damageDealtFirstStrike), false);
		}

		// 2. 2/1 First strike attacker kills 3/2 normal blocker in step 1 and survives; 2/1 FS blocker also kills 3/2 normal attacker!
		{
			const { state, p1, p2 } = makeGame();
			const fsAtk = putInZone(
				state,
				p1,
				syntheticCard({
					name: 'Youthful Knight',
					power: '2',
					toughness: '1',
					oracleText: 'First strike',
					keywords: ['First strike']
				}),
				'battlefield'
			);
			const normAtk = putInZone(
				state,
				p1,
				syntheticCard({ name: 'Hulking Ogre', power: '3', toughness: '2' }),
				'battlefield'
			);
			const normBlk = putInZone(
				state,
				p2,
				syntheticCard({ name: 'Canyon Minotaur', power: '3', toughness: '2' }),
				'battlefield'
			);
			const fsBlk = putInZone(
				state,
				p2,
				syntheticCard({
					name: ' Tundra Wolf',
					power: '2',
					toughness: '1',
					oracleText: 'First strike',
					keywords: ['First strike']
				}),
				'battlefield'
			);

			declareCombat(
				state,
				p1,
				p2,
				[
					{ attackerInstanceId: fsAtk.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: normAtk.instanceId, defenderPlayerId: p2.playerId }
				],
				[
					{ blockerInstanceId: normBlk.instanceId, attackerInstanceId: fsAtk.instanceId },
					{ blockerInstanceId: fsBlk.instanceId, attackerInstanceId: normAtk.instanceId }
				]
			);
			passBothPlayers(state);

			assert.equal(state.phase, 'first_strike_damage');
			assert.ok(p2.graveyard.some((c) => c.instanceId === normBlk.instanceId));
			assert.ok(p1.graveyard.some((c) => c.instanceId === normAtk.instanceId));
			assert.equal(fsAtk.damageMarked, 0);
			assert.equal(fsBlk.damageMarked, 0);

			// Advance to regular combat_damage -> surviving FS creatures do NOT deal damage a second time!
			passBothPlayers(state);
			assert.equal(state.phase, 'combat_damage');
			assert.ok(p1.battlefield.some((c) => c.instanceId === fsAtk.instanceId));
			assert.ok(p2.battlefield.some((c) => c.instanceId === fsBlk.instanceId));
			assert.equal(p2.life, 40);
		}
	});

	it('Double strike hits in both steps, obeys blocked-without-Trample vs Trample, and interacts with Lifelink and Deathtouch (CR 702.4b)', () => {
		const { state, p1, p2 } = makeGame();
		const dsUnblocked = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Twinblade Paladin',
				power: '3',
				toughness: '3',
				oracleText: 'Double strike, lifelink',
				keywords: ['Double strike', 'Lifelink']
			}),
			'battlefield'
		);
		const dsBlockedNoTrample = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Markov Blademaster',
				power: '3',
				toughness: '3',
				oracleText: 'Double strike',
				keywords: ['Double strike']
			}),
			'battlefield'
		);
		const dsDtTrample = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Apex Dreadmaw',
				power: '4',
				toughness: '4',
				oracleText: 'Double strike, deathtouch, trample',
				keywords: ['Double strike', 'Deathtouch', 'Trample']
			}),
			'battlefield'
		);

		const chumpBear = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Chump Bear', power: '2', toughness: '2' }),
			'battlefield'
		);
		const bigWall = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Stone Golem', power: '4', toughness: '5' }),
			'battlefield'
		);

		declareCombat(
			state,
			p1,
			p2,
			[
				{ attackerInstanceId: dsUnblocked.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: dsBlockedNoTrample.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: dsDtTrample.instanceId, defenderPlayerId: p2.playerId }
			],
			[
				{ blockerInstanceId: chumpBear.instanceId, attackerInstanceId: dsBlockedNoTrample.instanceId },
				{ blockerInstanceId: bigWall.instanceId, attackerInstanceId: dsDtTrample.instanceId }
			]
		);

		passBothPlayers(state);
		resolveCombatDamagePrompts(state, { [bigWall.instanceId]: 1 });

		// Step 1 (first_strike_damage):
		// - dsUnblocked (3/3 DS+Lifelink): 3 to P2, +3 life to P1 (43)
		// - dsBlockedNoTrample (3/3 DS): kills 2/2 chumpBear, 0 to P2
		// - dsDtTrample (4/4 DS+DT+Trample): 1 lethal to 4/5 bigWall, 3 tramples to P2!
		assert.equal(state.phase, 'first_strike_damage');
		assert.equal(p2.life, 34, 'P2 took 3 unblocked + 3 trample in first-strike step');
		assert.equal(p1.life, 43, 'P1 gained 3 life from Lifelink in first-strike step');
		assert.ok(p2.graveyard.some((c) => c.instanceId === chumpBear.instanceId));
		assert.ok(p2.graveyard.some((c) => c.instanceId === bigWall.instanceId));

		// Step 2 (combat_damage):
		// - dsUnblocked: another 3 to P2, +3 life to P1 (46)
		// - dsBlockedNoTrample: remains blocked with no Trample -> deals 0 damage!
		// - dsDtTrample: blocker died in step 1 + has Trample -> deals all 4 to P2!
		passBothPlayers(state);
		assert.equal(state.phase, 'combat_damage');
		assert.equal(p2.life, 27, 'P2 took 3 unblocked + 0 blocked-no-trample + 4 trample in regular step');
		assert.equal(p1.life, 46, 'P1 gained another 3 life from Lifelink in regular step');
	});

	it('handles gaining and losing First strike or Double strike between combat damage steps (CR 702.4c–d, 702.7c)', () => {
		const { state, p1, p2 } = makeGame();

		// 1. FS creature losing FS between steps still does NOT deal damage twice (CR 702.7c)
		const fsLose = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Losing Striker',
				power: '2',
				toughness: '2',
				oracleText: 'First strike',
				keywords: ['First strike']
			}),
			'battlefield'
		);
		// 2. FS creature gaining DS between steps DOES deal regular combat damage too (CR 702.4c)
		const fsGainDs = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Upgraded Striker',
				power: '2',
				toughness: '2',
				oracleText: 'First strike',
				keywords: ['First strike']
			}),
			'battlefield'
		);
		// 3. DS creature losing DS between steps stops dealing second-step damage (CR 702.4d)
		const dsLose = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Humbled Duellist',
				power: '3',
				toughness: '3',
				oracleText: 'Double strike',
				keywords: ['Double strike']
			}),
			'battlefield'
		);
		// 4. Normal creature gaining FS after first-strike damage dealt STILL deals regular damage (CR 702.7c)
		const normGainFs = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Late Learner', power: '4', toughness: '4' }),
			'battlefield'
		);

		declareCombat(
			state,
			p1,
			p2,
			[
				{ attackerInstanceId: fsLose.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: fsGainDs.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: dsLose.instanceId, defenderPlayerId: p2.playerId },
				{ attackerInstanceId: normGainFs.instanceId, defenderPlayerId: p2.playerId }
			],
			[]
		);
		passBothPlayers(state);

		// First-strike damage step dealt: 2 (fsLose) + 2 (fsGainDs) + 3 (dsLose) + 0 (normGainFs) = 7
		assert.equal(state.phase, 'first_strike_damage');
		assert.equal(p2.life, 33);

		// Now during priority in first_strike_damage, cast Instant combat tricks for mid-combat gain/loss!
		castInstantOnCreature(
			state,
			p2,
			fsLose,
			'Target creature loses all abilities until end of turn.'
		);
		castInstantOnCreature(
			state,
			p2,
			dsLose,
			'Target creature loses all abilities until end of turn.'
		);
		castInstantOnCreature(
			state,
			p1,
			fsGainDs,
			'Target creature gains double strike until end of turn.'
		);
		castInstantOnCreature(
			state,
			p1,
			normGainFs,
			'Target creature gains first strike until end of turn.'
		);

		passBothPlayers(state);
		// Second combat damage step:
		// - fsLose: 0 (already dealt FS, no DS)
		// - fsGainDs: 2 (gained DS -> deals regular damage per CR 702.4c!)
		// - dsLose: 0 (lost DS -> does NOT deal regular damage per CR 702.4d!)
		// - normGainFs: 4 (did NOT deal FS, so gaining FS does not stop regular damage per CR 702.7c!)
		assert.equal(state.phase, 'combat_damage');
		assert.equal(p2.life, 27, 'Expected exactly 2 + 4 = 6 damage in regular combat damage step');
	});
});

describe('Keyword: Deathtouch (CR 702.2)', () => {
	it('compiles Atraxa & standalone Deathtouch, makes 1 non-combat damage lethal, ignores 0/prevented damage, respects Indestructible, and handles gain/loss (CR 702.2b–c, 704.5h)', () => {
		const atraxaIr = compileCard(staple("Atraxa, Praetors' Voice")).faces[0];
		assert.ok(
			atraxaIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'deathtouch')
		);

		const pingerCard = syntheticCard({
			name: 'Venom Archer',
			typeLine: 'Creature — Elf Archer',
			colors: ['B'],
			power: '1',
			toughness: '1',
			oracleText: 'Deathtouch\n{T}: This creature deals 1 damage to any target.',
			keywords: ['Deathtouch']
		});
		const { state, p1, p2 } = makeGame();

		// 1. 1 non-combat ping damage from a Deathtouch source kills a 0/8 Wall on SBA!
		const pinger = putInZone(state, p1, pingerCard, 'battlefield');
		const wall = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Glacial Wall', power: '0', toughness: '8' }),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: pinger.instanceId,
				abilityId: 'act_1',
				targets: [{ kind: 'permanent', id: wall.instanceId, label: wall.card.name }]
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.ok(
			p2.graveyard.some((c) => c.instanceId === wall.instanceId),
			'1 non-combat Deathtouch damage destroys 0/8 creature via SBA'
		);

		// 2. Indestructible survives Deathtouch ping and clears deathtouchDamageMarked (CR 704.5h)
		pinger.tapped = false;
		const indest = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Darksteel Gargoyle',
				power: '3',
				toughness: '3',
				oracleText: 'Indestructible',
				keywords: ['Indestructible']
			}),
			'battlefield'
		);
		applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: pinger.instanceId,
			abilityId: 'act_1',
			targets: [{ kind: 'permanent', id: indest.instanceId, label: indest.card.name }]
		});
		passBothPlayers(state);
		assert.ok(p2.battlefield.some((c) => c.instanceId === indest.instanceId));
		assert.equal(indest.damageMarked, 1);
		assert.equal(indest.deathtouchDamageMarked, false);

		// 3. Zero-power Deathtouch combatant deals 0 damage -> NOT lethal!
		const zeroDt = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Harmless Viper',
				power: '0',
				toughness: '3',
				oracleText: 'Deathtouch',
				keywords: ['Deathtouch']
			}),
			'battlefield'
		);
		const bear = putInZone(state, p2, syntheticCard({ name: 'Healthy Bear' }), 'battlefield');
		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: zeroDt.instanceId, defenderPlayerId: p2.playerId }],
			[{ blockerInstanceId: bear.instanceId, attackerInstanceId: zeroDt.instanceId }]
		);
		passBothPlayers(state);
		assert.ok(
			p2.battlefield.some((c) => c.instanceId === bear.instanceId),
			'0-power Deathtouch creature deals 0 damage and does not destroy blocker'
		);

		// 4. Gain & Loss: non-Deathtouch pinger granted Deathtouch kills 5/5; pinger that lost abilities does NOT kill 5/5!
		state.combat = {
		active: false,
		attackers: [],
		declaredBlockersPlayerIds: [],
		damageDealtFirstStrike: false,
		damageDealtNormal: false
	};
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		const plainPinger = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Prodigal Sorcerer',
				oracleText: '{T}: This creature deals 1 damage to any target.'
			}),
			'battlefield'
		);
		const giant1 = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Hill Giant A', power: '3', toughness: '5' }),
			'battlefield'
		);
		castInstantOnCreature(
			state,
			p1,
			plainPinger,
			'Target creature gains deathtouch until end of turn.'
		);
		applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: plainPinger.instanceId,
			abilityId: 'act_0',
			targets: [{ kind: 'permanent', id: giant1.instanceId, label: giant1.card.name }]
		});
		passBothPlayers(state);
		assert.ok(
			p2.graveyard.some((c) => c.instanceId === giant1.instanceId),
			'Granted Deathtouch makes 1 ping damage lethal'
		);

		// Now strip Deathtouch from pinger via Darksteel Mutation / ability-loss instant BEFORE activation -> 1 damage is non-lethal!
		const pinger2 = putInZone(state, p1, pingerCard, 'battlefield');
		const giant2 = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Hill Giant B', power: '3', toughness: '5' }),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: pinger2.instanceId,
				abilityId: 'act_1',
				targets: [{ kind: 'permanent', id: giant2.instanceId, label: giant2.card.name }]
			}).ok,
			true
		);
		// Strip Deathtouch BEFORE the ping ability resolves? Note: CR 113.7a / LKI vs combat!
		// Test combat Deathtouch loss directly: a Deathtouch creature that loses all abilities deals non-lethal combat damage!
		passBothPlayers(state);
		assert.ok(p2.graveyard.some((c) => c.instanceId === giant2.instanceId));

		const humbledViper = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Humbled Viper',
				power: '1',
				toughness: '1',
				oracleText: 'Deathtouch',
				keywords: ['Deathtouch']
			}),
			'battlefield'
		);
		const giant3 = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Hill Giant C', power: '1', toughness: '5' }),
			'battlefield'
		);
		castInstantOnCreature(
			state,
			p2,
			humbledViper,
			'Target creature loses all abilities until end of turn.'
		);
		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: humbledViper.instanceId, defenderPlayerId: p2.playerId }],
			[{ blockerInstanceId: giant3.instanceId, attackerInstanceId: humbledViper.instanceId }]
		);
		passBothPlayers(state);
		assert.ok(
			p2.battlefield.some((c) => c.instanceId === giant3.instanceId),
			'Creature that lost Deathtouch deals normal non-lethal 1 damage'
		);
		assert.equal(giant3.damageMarked, 1);
	});
});

describe('Keyword: Trample (CR 702.19)', () => {
	it('compiles Trample and covers multi-blocker excess, already-lethal Indestructible blocker, removed blocker, prevention/protection on blocker, Planeswalker attack, negative checks, and gain/loss (CR 702.19a–d)', () => {
		const atarkaIr = compileCard(staple('Atarka, World Render')).faces[0];
		assert.ok(atarkaIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'trample'));

		// 1. Multi-blocker excess + Prevention shield on blocker + Removed blocker + Planeswalker trample
		{
			const { state, p1, p2 } = makeGame();
			const multiTrampler = putInZone(
				state,
				p1,
				syntheticCard({
					name: 'Colossal Dreadmaw',
					power: '7',
					toughness: '7',
					oracleText: 'Trample',
					keywords: ['Trample']
				}),
				'battlefield'
			);
			const removedBlkTrampler = putInZone(
				state,
				p1,
				syntheticCard({
					name: 'Charging Rhino',
					power: '5',
					toughness: '5',
					oracleText: 'Trample',
					keywords: ['Trample']
				}),
				'battlefield'
			);
			const shieldedBlkTrampler = putInZone(
				state,
				p1,
				syntheticCard({
					name: 'Siege Wurm',
					power: '5',
					toughness: '5',
					oracleText: 'Trample',
					keywords: ['Trample']
				}),
				'battlefield'
			);
			const pwTrampler = putInZone(
				state,
				p1,
				syntheticCard({
					name: 'PW Crusher',
					power: '5',
					toughness: '5',
					oracleText: 'Trample',
					keywords: ['Trample']
				}),
				'battlefield'
			);

			const b1 = putInZone(
				state,
				p2,
				syntheticCard({ name: 'Blocker A', power: '2', toughness: '3' }),
				'battlefield'
			);
			const b2 = putInZone(
				state,
				p2,
				syntheticCard({ name: 'Blocker B', power: '3', toughness: '2' }),
				'battlefield'
			);
			const doomedBlocker = putInZone(
				state,
				p2,
				syntheticCard({ name: 'Doomed Blocker', power: '2', toughness: '2' }),
				'battlefield'
			);
			const shieldedBlocker = putInZone(
				state,
				p2,
				syntheticCard({ name: 'Shielded Blocker', power: '2', toughness: '2' }),
				'battlefield'
			);
			(shieldedBlocker as CardInstance & { damagePreventionShield?: number }).damagePreventionShield = 10;

			const pw = putInZone(
				state,
				p2,
				syntheticCard({
					name: 'Test Jace',
					typeLine: 'Legendary Planeswalker — Jace',
					loyalty: '4',
					power: undefined,
					toughness: undefined
				}),
				'battlefield'
			);
			pw.counters.loyalty = 4;
			const pwGuard = putInZone(
				state,
				p2,
				syntheticCard({ name: 'Jace Guard', power: '1', toughness: '2' }),
				'battlefield'
			);

			const plow = putInZone(state, p1, staple('Swords to Plowshares'), 'hand');
			p1.manaPool.W = 1;

			declareCombat(
				state,
				p1,
				p2,
				[
					{ attackerInstanceId: multiTrampler.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: removedBlkTrampler.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: shieldedBlkTrampler.instanceId, defenderPlayerId: p2.playerId },
					{
						attackerInstanceId: pwTrampler.instanceId,
						defenderPlayerId: p2.playerId,
						defenderPlaneswalkerId: pw.instanceId
					}
				],
				[
					{ blockerInstanceId: b1.instanceId, attackerInstanceId: multiTrampler.instanceId },
					{ blockerInstanceId: b2.instanceId, attackerInstanceId: multiTrampler.instanceId },
					{
						blockerInstanceId: doomedBlocker.instanceId,
						attackerInstanceId: removedBlkTrampler.instanceId
					},
					{
						blockerInstanceId: shieldedBlocker.instanceId,
						attackerInstanceId: shieldedBlkTrampler.instanceId
					},
					{ blockerInstanceId: pwGuard.instanceId, attackerInstanceId: pwTrampler.instanceId }
				]
			);

			// Exile doomedBlocker before combat damage (CR 702.19d)! (Swords to Plowshares gives P2 +2 life -> 42)
			p1.manaPool.W = 1;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: plow.instanceId,
					targets: [{ kind: 'permanent', id: doomedBlocker.instanceId, label: doomedBlocker.card.name }]
				}).ok,
				true
			);
			passBothPlayers(state);
			assert.equal(p2.life, 42);
			assert.ok(p2.exile.some((c) => c.instanceId === doomedBlocker.instanceId));

			// Advance to combat_damage!
			passBothPlayers(state);
			resolveCombatDamagePrompts(state, {
				[b2.instanceId]: 2,
				[shieldedBlocker.instanceId]: 2, // CR 702.19b: ignores 10-point prevention shield!
				[pwGuard.instanceId]: 2
			});

			// P2 started at 42 after Swords:
			// - multiTrampler (7): 3 to b1 + 2 to b2 -> 2 tramples to P2
			// - removedBlkTrampler (5): blocker exiled -> all 5 tramples to P2 (CR 702.19d)!
			// - shieldedBlkTrampler (5): 2 assigned to shieldedBlocker (prevented!), 3 tramples to P2 (CR 702.19b)!
			// - pwTrampler (5): 2 to pwGuard, 3 tramples onto Test Jace (4 -> 1 loyalty)!
			assert.equal(p2.life, 32, 'Expected 42 - (2 + 5 + 3) = 32 life on P2');
			assert.ok(
				p2.battlefield.some((c) => c.instanceId === shieldedBlocker.instanceId),
				'Shielded blocker prevented its 2 damage and survived while 3 trampled over'
			);
			assert.equal(pw.counters.loyalty, 1, 'Planeswalker took 3 excess trample damage (4 -> 1)');
		}

		// 2. Already-lethally-marked Indestructible blocker (CR 702.19b): Double strike + Trample 5/5 vs 3/3 Indestructible
		// deals 2 trample in step 1 (3 marked on blocker) and ALL 5 trample in step 2 (0 needed since 3 >= 3 already marked)!
		{
			const { state, p1, p2 } = makeGame();
			const dsTrample = putInZone(
				state,
				p1,
				syntheticCard({
					name: 'Berserk Behemoth',
					power: '5',
					toughness: '5',
					oracleText: 'Double strike, trample',
					keywords: ['Double strike', 'Trample']
				}),
				'battlefield'
			);
			const indestBlk = putInZone(
				state,
				p2,
				syntheticCard({
					name: 'Darksteel Myr',
					power: '1',
					toughness: '3',
					oracleText: 'Indestructible',
					keywords: ['Indestructible']
				}),
				'battlefield'
			);
			declareCombat(
				state,
				p1,
				p2,
				[{ attackerInstanceId: dsTrample.instanceId, defenderPlayerId: p2.playerId }],
				[{ blockerInstanceId: indestBlk.instanceId, attackerInstanceId: dsTrample.instanceId }]
			);
			passBothPlayers(state);
			resolveCombatDamagePrompts(state, { [indestBlk.instanceId]: 3 });
			assert.equal(p2.life, 38, 'Step 1: 3 marked on 3/3 Indestructible, 2 trampled over');

			passBothPlayers(state);
			resolveCombatDamagePrompts(state, { [indestBlk.instanceId]: 0 });
			assert.equal(
				p2.life,
				33,
				'Step 2 (CR 702.19b): 3 lethal already marked on 3/3 Indestructible, so all 5 trampled over!'
			);
		}

		// 3. Negative (blocking does NOT trample to active player) + Gain/Loss via Shadowspear & losesAllAbilities
		{
			const { state, p1, p2 } = makeGame();
			const tinyAtk = putInZone(
				state,
				p1,
				syntheticCard({ name: 'Eager Cadet', power: '1', toughness: '1' }),
				'battlefield'
			);
			const trampleBlocker = putInZone(
				state,
				p2,
				syntheticCard({
					name: 'Blocking Wurm',
					power: '6',
					toughness: '6',
					oracleText: 'Trample',
					keywords: ['Trample']
				}),
				'battlefield'
			);
			declareCombat(
				state,
				p1,
				p2,
				[{ attackerInstanceId: tinyAtk.instanceId, defenderPlayerId: p2.playerId }],
				[{ blockerInstanceId: trampleBlocker.instanceId, attackerInstanceId: tinyAtk.instanceId }]
			);
			passBothPlayers(state);
			assert.equal(p1.life, 40, 'Trample never assigns excess combat damage when blocking');

			// Gain via Shadowspear, then lose via losesAllAbilities
			state.combat = {
		active: false,
		attackers: [],
		declaredBlockersPlayerIds: [],
		damageDealtFirstStrike: false,
		damageDealtNormal: false
	};
			state.phase = 'main2';
			state.priorityPlayerIndex = 0;
			const brute = putInZone(
				state,
				p1,
				syntheticCard({ name: 'Vanilla Brute', power: '4', toughness: '4' }),
				'battlefield'
			);
			const spear = putInZone(state, p1, staple('Shadowspear'), 'battlefield');
			p1.manaPool.C = 2;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: spear.instanceId,
					abilityId: 'equip_2',
					targets: [{ kind: 'permanent', id: brute.instanceId, label: brute.card.name }]
				}).ok,
				true
			);
			passBothPlayers(state);
			assert.ok(
				evaluatePermanent(state, brute).keywords.some((k) => k.toLowerCase() === 'trample')
			);

			castInstantOnCreature(
				state,
				p2,
				brute,
				'Target creature loses all abilities until end of turn.'
			);
			assert.equal(
				evaluatePermanent(state, brute).keywords.some((k) => k.toLowerCase() === 'trample'),
				false
			);
		}
	});
});

describe('Keyword: Lifelink (CR 702.15)', () => {
	it('compiles Lifelink, heals controller on combat & non-combat damage, does NOT stack multiple instances, and saves player at <=0 life before SBA (CR 702.15b–c, 704.3)', () => {
		const sovIr = compileCard(staple('Felidar Sovereign')).faces[0];
		assert.ok(sovIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'lifelink'));

		const { state, p1, p2 } = makeGame();

		// 1. Non-combat damage to creature after control change heals the CURRENT controller (P2), NOT the owner (P1)!
		const lifelinkPinger = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Soul Siphon Mage',
				power: '2',
				toughness: '2',
				oracleText: 'Lifelink\n{T}: This creature deals 2 damage to any target.',
				keywords: ['Lifelink']
			}),
			'battlefield'
		);
		transferBattlefieldControl(lifelinkPinger, p1, p2, state);
		lifelinkPinger.summoningSick = false;
		const targetDummy = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Training Dummy', power: '0', toughness: '5' }),
			'battlefield'
		);

		state.priorityPlayerIndex = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'activate_ability',
				instanceId: lifelinkPinger.instanceId,
				abilityId: 'act_1',
				targets: [{ kind: 'permanent', id: targetDummy.instanceId, label: targetDummy.card.name }]
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.equal(p2.life, 42, 'Current controller (P2) gains life from Lifelink');
		assert.equal(p1.life, 40, 'Original owner (P1) does NOT gain life');

		// 2. Multiple instances of Lifelink do NOT stack (CR 702.15c): innate Lifelink + Shadowspear Lifelink
		state.priorityPlayerIndex = 0;
		const paladin = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'SilverbladeHealer',
				power: '3',
				toughness: '3',
				oracleText: 'Lifelink',
				keywords: ['Lifelink']
			}),
			'battlefield'
		);
		const spear = putInZone(state, p1, staple('Shadowspear'), 'battlefield');
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: spear.instanceId,
				abilityId: 'equip_2',
				targets: [{ kind: 'permanent', id: paladin.instanceId, label: paladin.card.name }]
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.equal(spear.attachedToId, paladin.instanceId);

		// Paladin is now 4/4 (+1/+1 from Shadowspear) with TWO Lifelink grants -> deals 4, heals 4 (NOT 8)!
		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: paladin.instanceId, defenderPlayerId: p2.playerId }],
			[]
		);
		passBothPlayers(state);
		assert.equal(p1.life, 44, 'Multiple Lifelink instances heal 4, not 8 (CR 702.15c)');

		// 3. Simultaneous combat damage + Lifelink saves defending player from <= 0 life before SBAs check (CR 704.3)!
		const { state: s2, p1: a1, p2: a2 } = makeGame();
		a2.life = 2; // P2 is at 2 life!
		const unblocked4 = putInZone(
			s2,
			a1,
			syntheticCard({ name: 'Raging Baloth', power: '4', toughness: '4' }),
			'battlefield'
		);
		const blocked2 = putInZone(
			s2,
			a1,
			syntheticCard({ name: 'Goblin Piker', power: '2', toughness: '2' }),
			'battlefield'
		);
		const lifelinkBlocker = putInZone(
			s2,
			a2,
			syntheticCard({
				name: 'Vampire Nighthawk',
				power: '3',
				toughness: '3',
				oracleText: 'Lifelink',
				keywords: ['Lifelink']
			}),
			'battlefield'
		);

		declareCombat(
			s2,
			a1,
			a2,
			[
				{ attackerInstanceId: unblocked4.instanceId, defenderPlayerId: a2.playerId },
				{ attackerInstanceId: blocked2.instanceId, defenderPlayerId: a2.playerId }
			],
			[{ blockerInstanceId: lifelinkBlocker.instanceId, attackerInstanceId: blocked2.instanceId }]
		);
		passBothPlayers(s2);
		assert.equal(a2.lost, false, 'Simultaneous Lifelink combat heal saved P2 before SBA check');
		assert.equal(a2.life, 1, '2 - 4 + 3 = 1 life');

		// 4. Ability loss stops Lifelink
		s2.combat = {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		};
		s2.phase = 'main2';
		s2.priorityPlayerIndex = 1;
		castInstantOnCreature(
			s2,
			a1,
			lifelinkBlocker,
			'Target creature loses all abilities until end of turn.'
		);
		assert.equal(evaluatePermanent(s2, lifelinkBlocker).keywords.includes('lifelink'), false);
	});
});

describe('Keyword: Infect (CR 702.90)', () => {
	it('compiles Infect, deals -1/-1 counters to creatures (killing Indestructible & cancelling +1/+1) and poison counters to players, handles Infect+Trample & Infect+Lifelink, loses at 10 poison, and handles gain/loss (CR 702.90b–c, 704.5c)', () => {
		const infIr = compileCard(
			syntheticCard({ name: 'Plague Stinger', oracleText: 'Flying, infect' })
		).faces[0];
		assert.ok(infIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'flying'));
		assert.ok(infIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'infect'));

		const { state, p1, p2 } = makeGame();

		// 1. Non-combat Infect damage: deals -1/-1 counters to an Indestructible creature (annihilating +1/+1 and killing at 0 toughness) and poison to player!
		const infectMage = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Blightcaster',
				power: '2',
				toughness: '2',
				oracleText: 'Infect\n{T}: This creature deals 3 damage to any target.',
				keywords: ['Infect']
			}),
			'battlefield'
		);
		const indest2 = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Darksteel Cadet',
				power: '1',
				toughness: '2',
				oracleText: 'Indestructible',
				keywords: ['Indestructible']
			}),
			'battlefield'
		);
		indest2.counters['+1/+1'] = 1; // Currently 2/3! 3 Infect damage -> 1 +1/+1 cancels 1 -1/-1 -> 2 -1/-1 remain -> 0/0 -> dies!

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: infectMage.instanceId,
				abilityId: 'act_1',
				targets: [{ kind: 'permanent', id: indest2.instanceId, label: indest2.card.name }]
			}).ok,
			true
		);
		passBothPlayers(state);
		assert.ok(
			p2.graveyard.some((c) => c.instanceId === indest2.instanceId),
			'Infect -1/-1 counters annihilate +1/+1 counter and kill Indestructible creature at 0 toughness (CR 704.5f, 704.5q)'
		);

		// Non-combat Infect ping to player -> +3 poison, 0 life lost!
		infectMage.tapped = false;
		applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: infectMage.instanceId,
			abilityId: 'act_1',
			targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
		});
		passBothPlayers(state);
		assert.equal(p2.poison, 3);
		assert.equal(p2.life, 40, 'Infect damage never causes life loss');

		// 2. Combat: Infect + Trample + Lifelink -> assigns lethal to blocker as -1/-1 counters, tramples poison to P2, and heals P1!
		const blightTrampler = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Phyrexian Juggernaut',
				power: '6',
				toughness: '6',
				oracleText: 'Infect, trample, lifelink',
				keywords: ['Infect', 'Trample', 'Lifelink']
			}),
			'battlefield'
		);
		const blocker = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Mire Bear', power: '2', toughness: '2' }),
			'battlefield'
		);

		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: blightTrampler.instanceId, defenderPlayerId: p2.playerId }],
			[{ blockerInstanceId: blocker.instanceId, attackerInstanceId: blightTrampler.instanceId }]
		);
		passBothPlayers(state);
		resolveCombatDamagePrompts(state, { [blocker.instanceId]: 2 });

		// Blocker took 2 -1/-1 counters and died; P2 took 4 trample poison -> 3 + 4 = 7 poison (< 10, still alive); P1 healed +6 -> 46!
		assert.ok(p2.graveyard.some((c) => c.instanceId === blocker.instanceId));
		assert.equal(p2.poison, 7);
		assert.equal(p2.life, 40);
		assert.equal(p2.lost, false);
		assert.equal(p1.life, 46, 'Infect + Lifelink still heals controller');

		// 3. Gain & Loss: losing Infect reverts combat damage to normal life loss; granted Infect deals remaining 3 poison -> 10 poison SBA loss (CR 704.5c)!
		state.combat = {
		active: false,
		attackers: [],
		declaredBlockersPlayerIds: [],
		damageDealtFirstStrike: false,
		damageDealtNormal: false
	};
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		const humbledCarrier = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Plague Rusher',
				power: '3',
				toughness: '3',
				oracleText: 'Infect',
				keywords: ['Infect']
			}),
			'battlefield'
		);
		castInstantOnCreature(
			state,
			p2,
			humbledCarrier,
			'Target creature loses all abilities until end of turn.'
		);
		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: humbledCarrier.instanceId, defenderPlayerId: p2.playerId }],
			[]
		);
		passBothPlayers(state);
		assert.equal(p2.poison, 7, 'Creature that lost Infect deals normal damage, not poison');
		assert.equal(p2.life, 37);

		// Grant Infect to a normal pinger to deal 3 more poison -> 10 poison -> P2 loses game via SBA!
		state.combat = {
		active: false,
		attackers: [],
		declaredBlockersPlayerIds: [],
		damageDealtFirstStrike: false,
		damageDealtNormal: false
	};
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		const normalBoltMage = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Pyromancer',
				oracleText: '{T}: This creature deals 3 damage to any target.'
			}),
			'battlefield'
		);
		castInstantOnCreature(
			state,
			p1,
			normalBoltMage,
			'Target creature gains infect until end of turn.'
		);
		applyGameAction(state, p1.playerId, {
			type: 'activate_ability',
			instanceId: normalBoltMage.instanceId,
			abilityId: 'act_0',
			targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
		});
		passBothPlayers(state);
		assert.equal(p2.poison, 10);
		assert.equal(p2.lost, true, 'Player with 10+ poison counters loses via SBA (CR 704.5c)');
		assert.equal(state.status, 'finished');
	});
});

describe('Keyword: Wither (CR 702.80)', () => {
	it('compiles printed Wither, deals combat damage to creatures as -1/-1 counters (killing an Indestructible blocker) and to players as life loss, and handles gain/loss (CR 702.80a–c, 704.5f)', () => {
		// No Scryfall `keywords` entry: wither must come from the compiled keyword ability.
		const witherCard = syntheticCard({ name: 'Cinderbane Stalker', power: '3', toughness: '3', oracleText: 'Wither' });
		const def = compileCard(witherCard);
		assert.ok(def.faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'wither'));
		assert.equal(def.fullySupported, true);

		const { state, p1, p2 } = makeGame();

		// 1. Blocked: damage to the blocker is -1/-1 counters, not marked damage, so Indestructible doesn't save it.
		const stalker = putInZone(state, p1, witherCard, 'battlefield');
		const wall = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Ironbark Warden', power: '1', toughness: '3', oracleText: 'Indestructible' }),
			'battlefield'
		);
		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: stalker.instanceId, defenderPlayerId: p2.playerId }],
			[{ blockerInstanceId: wall.instanceId, attackerInstanceId: stalker.instanceId }]
		);
		passBothPlayers(state);
		resolveCombatDamagePrompts(state);
		assert.ok(
			p2.graveyard.some((c) => c.instanceId === wall.instanceId),
			'3 -1/-1 counters reduce a 1/3 Indestructible blocker to toughness 0 (CR 704.5f)'
		);
		assert.equal(stalker.damageMarked, 1, 'the non-wither blocker marks ordinary damage on the attacker');
		assert.equal(stalker.counters['-1/-1'] || 0, 0);

		// 2. Unblocked: damage to a player is ordinary life loss, never poison.
		stalker.tapped = false;
		stalker.damageMarked = 0;
		state.phase = 'main2';
		declareCombat(state, p1, p2, [{ attackerInstanceId: stalker.instanceId, defenderPlayerId: p2.playerId }], []);
		passBothPlayers(state);
		assert.equal(p2.life, 37);
		assert.equal(p2.poison || 0, 0);

		// 3. Loss: a creature that loses all abilities deals marked damage instead of counters.
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		const silenced = putInZone(state, p1, syntheticCard({ name: 'Ashen Lurker', power: '2', toughness: '2', oracleText: 'Wither' }), 'battlefield');
		const bear1 = putInZone(state, p2, syntheticCard({ name: 'Moss Bear', power: '0', toughness: '4' }), 'battlefield');
		castInstantOnCreature(state, p2, silenced, 'Target creature loses all abilities until end of turn.');
		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: silenced.instanceId, defenderPlayerId: p2.playerId }],
			[{ blockerInstanceId: bear1.instanceId, attackerInstanceId: silenced.instanceId }]
		);
		passBothPlayers(state);
		resolveCombatDamagePrompts(state);
		assert.equal(bear1.damageMarked, 2, 'without wither the damage is marked');
		assert.equal(bear1.counters['-1/-1'] || 0, 0);

		// 4. Gain: wither granted until end of turn makes a vanilla creature's damage -1/-1 counters.
		state.combat = { active: false, attackers: [], declaredBlockersPlayerIds: [], damageDealtFirstStrike: false, damageDealtNormal: false };
		state.phase = 'main2';
		state.priorityPlayerIndex = 0;
		const grunt = putInZone(state, p1, syntheticCard({ name: 'Bog Grunt', power: '2', toughness: '2' }), 'battlefield');
		const bear2 = putInZone(state, p2, syntheticCard({ name: 'Fern Bear', power: '0', toughness: '4' }), 'battlefield');
		castInstantOnCreature(state, p1, grunt, 'Target creature gains wither until end of turn.');
		declareCombat(
			state,
			p1,
			p2,
			[{ attackerInstanceId: grunt.instanceId, defenderPlayerId: p2.playerId }],
			[{ blockerInstanceId: bear2.instanceId, attackerInstanceId: grunt.instanceId }]
		);
		passBothPlayers(state);
		resolveCombatDamagePrompts(state);
		assert.equal(bear2.counters['-1/-1'], 2, 'granted wither deals damage as -1/-1 counters');
		assert.equal(bear2.damageMarked, 0);
		assert.equal(evaluatePermanent(state, bear2).toughness, 2);
	});
});
