import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../types.ts';

function card(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `test_${overrides.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Instant',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		power: overrides.power,
		toughness: overrides.toughness,
		loyalty: overrides.loyalty,
		keywords: overrides.keywords ?? [],
		imageUrl: '',
		artCropUrl: '',
		rarity: 'common',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};
}

function creature(name: string, oracleText: string, power = '2', toughness = '2', subtype = 'Human'): ScryfallCard {
	return card({ name, manaCost: '{2}', cmc: 2, typeLine: `Creature — ${subtype}`, oracleText, power, toughness });
}

function seat(i: number, id: string, username: string, isBot: boolean): LobbySeat {
	const deck = PRECON_DECKS[i % PRECON_DECKS.length];
	return {
		seatIndex: i,
		userId: id,
		username,
		avatarUrl: '',
		isBot,
		deckId: deck.id,
		deckName: deck.name,
		commanderNames: deck.commanders.map((c) => c.name),
		commanderArtUrl: '',
		colorIdentity: deck.colorIdentity,
		isDeckLegal: true,
		ready: true,
		lastHeartbeat: 0
	};
}

function game(players = 2, bots: boolean[] = []): { state: GameState; p: PlayerGameState[] } {
	const names = ['Alice', 'Bob', 'Carol', 'Dave'];
	const seats = Array.from({ length: players }, (_, i) => seat(i, `player_${i + 1}`, names[i], Boolean(bots[i])));
	const state = createInitialGameState(
		'LOBBY_E2',
		seats,
		new Map(seats.map((_, i) => [i, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const s of seats) {
		const pl = state.players.find((x) => x.playerId === s.userId)!;
		const wasBot = pl.isBot;
		pl.isBot = false;
		if (state.status === 'mulligan') assert.equal(applyGameAction(state, s.userId!, { type: 'mulligan_keep' }).ok, true);
		pl.isBot = wasBot;
	}
	assert.equal(state.phase, 'main1');
	for (const pl of state.players) pl.manaPool = { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 };
	return { state, p: state.players };
}

function put(
	state: GameState,
	player: PlayerGameState,
	c: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'command',
	isCommander = false
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp || 0) + 1;
	const inst = createCardInstance(c, player.playerId, zone, isCommander, false, state.nextTimestamp, state);
	if (zone === 'battlefield') inst.summoningSick = false;
	if (zone === 'library') player.library.unshift(inst);
	else player[zone].push(inst);
	return inst;
}

function roundTrip(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function cast(state: GameState, player: PlayerGameState, inst: CardInstance, targets: TargetRef[] = []): void {
	const res = applyGameAction(state, player.playerId, { type: 'cast_spell', instanceId: inst.instanceId, targets });
	assert.equal(res.ok, true, res.error ?? '');
}

function pass(state: GameState): void {
	const prio = state.players[state.priorityPlayerIndex];
	assert.equal(applyGameAction(state, prio.playerId, { type: 'pass_priority' }).ok, true);
}

function resolveTop(state: GameState): void {
	const top = state.stack[state.stack.length - 1];
	for (let i = 0; i < 8 && state.stack.includes(top) && state.pendingPrompts.length === 0; i++) pass(state);
}

function settle(state: GameState, max = 40): void {
	for (let i = 0; i < max && state.stack.length > 0 && state.pendingPrompts.length === 0; i++) pass(state);
}

function passUntil(state: GameState, phase: GameState['phase'], max = 40): void {
	for (let i = 0; i < max && state.phase !== phase; i++) {
		if (state.pendingPrompts.length > 0) assert.fail(`unexpected prompt: ${state.pendingPrompts[0].title}`);
		pass(state);
	}
	assert.equal(state.phase, phase);
}

const ref = (c: CardInstance): TargetRef => ({ kind: 'permanent', id: c.instanceId, label: c.card.name });
const exileRef = (c: CardInstance): TargetRef => ({ kind: 'exile_card', id: c.instanceId, label: c.card.name });
const gyRef = (c: CardInstance): TargetRef => ({ kind: 'graveyard_card', id: c.instanceId, label: c.card.name });

describe('Track E Slice 2 — Part A: IR-safe delayed triggers (CR 603.7)', () => {
	it('stores plain JSON compiledDelayed locator (zero EffectStep[] in GameState), survives JSON round-trip, and works identically under a renamed card', () => {
		for (const copyCardName of ['Heat Reflection', 'Mirrored Echo']) {
			const { state: s0, p } = game();
			const original = put(s0, p[0], creature('Sunforge Bear', '', '3', '3', 'Bear'), 'battlefield');
			const copySpell = put(
				s0,
				p[0],
				card({
					name: copyCardName,
					manaCost: '{1}{R}',
					cmc: 2,
					typeLine: 'Sorcery',
					oracleText: `Create a token that's a copy of target creature you control. Sacrifice it at the beginning of the next end step.`
				}),
				'hand'
			);
			cast(s0, p[0], copySpell, [ref(original)]);
			settle(s0);

			assert.equal(p[0].battlefield.filter((c) => c.isToken).length, 1, 'copy token created');
			assert.equal(s0.delayedTriggers?.length, 1);
			assert.equal(s0.delayedTriggers?.[0]?.delayedEffect?.kind, 'compiledDelayed');
			const serializedDelayed = JSON.stringify(s0.delayedTriggers);
			assert.equal(serializedDelayed.includes('"verb"'), false, 'zero IR EffectStep serialized in GameState');

			const state = roundTrip(s0);
			passUntil(state, 'end_step');
			assert.equal(state.stack.length, 1, 'delayed trigger placed on stack at end step');
			settle(state);
			assert.equal(state.players[0].battlefield.filter((c) => c.isToken).length, 0, 'copy token sacrificed at end step');
			assert.equal(state.delayedTriggers?.length, 0);
		}
	});

	it('triggers compiledDelayed at end_combat (CR 511 / CR 603.7)', () => {
		const { state: s0, p } = game();
		const attacker = put(s0, p[0], creature('Vanguard Bear', '', '2', '2'), 'battlefield');
		const combatTokenSpell = put(
			s0,
			p[0],
			card({
				name: 'Warpath Summon',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Create a 1/1 white Soldier creature token. Sacrifice it at end of combat.'
			}),
			'hand'
		);
		cast(s0, p[0], combatTokenSpell);
		settle(s0);
		assert.equal(p[0].battlefield.filter((c) => c.isToken).length, 1);

		let state = roundTrip(s0);
		passUntil(state, 'declare_attackers');
		assert.equal(
			applyGameAction(state, state.players[0].playerId, {
				type: 'declare_attackers',
				assignments: [
					{
						attackerInstanceId: attacker.instanceId,
						defenderPlayerId: state.players[1].playerId,
						defenderPlaneswalkerId: null
					}
				]
			}).ok,
			true
		);
		passUntil(state, 'declare_blockers');
		assert.equal(
			applyGameAction(state, state.players[1].playerId, { type: 'declare_blockers', assignments: [] }).ok,
			true
		);
		passUntil(state, 'end_combat');
		assert.equal(state.stack.length, 1, 'end-of-combat delayed trigger is on the stack');
		settle(state);
		assert.equal(state.players[0].battlefield.filter((c) => c.isToken).length, 0, 'token sacrificed at end of combat');
	});

	it('enforces CR 603.7c partial survival, blink objectVersion mismatch, and CR 702.26d phasing', () => {
		// 1. Two bound tokens: destroying one before end step still exiles the surviving second token (does not fizzle).
		const { state: s1, p: p1 } = game();
		const twinSpell = put(
			s1,
			p1[0],
			card({
				name: 'Twin Wisps',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Create two 1/1 white Spirit creature tokens. Exile those tokens at the beginning of the next end step.'
			}),
			'hand'
		);
		cast(s1, p1[0], twinSpell);
		settle(s1);
		const tokens = p1[0].battlefield.filter((c) => c.isToken);
		assert.equal(tokens.length, 2);

		const zap = put(
			s1,
			p1[0],
			card({ name: 'Spark Dart', manaCost: '{R}', typeLine: 'Instant', oracleText: 'Spark Dart deals 2 damage to target creature.' }),
			'hand'
		);
		cast(s1, p1[0], zap, [ref(tokens[0])]);
		settle(s1);
		assert.equal(p1[0].battlefield.filter((c) => c.isToken).length, 1, 'one token died early');

		passUntil(s1, 'end_step');
		settle(s1);
		assert.equal(p1[0].battlefield.filter((c) => c.isToken).length, 0, 'surviving token was exiled cleanly without fizzling');

		// 2. Blink immunity (CR 400.7 / CR 603.7c) + phasing (CR 702.26d).
		const { state: s2, p: p2 } = game();
		const blinkTarget = put(s2, p2[0], creature('Chrono Elk', '', '2', '2'), 'battlefield');
		const tempCopyAndSac = put(
			s2,
			p2[0],
			card({
				name: 'Delayed Exile Order',
				manaCost: '{1}{W}',
				typeLine: 'Instant',
				oracleText: 'Exile target creature. Return that card to the battlefield under its owner\'s control at the beginning of the next end step.'
			}),
			'hand'
		);
		cast(s2, p2[0], tempCopyAndSac, [ref(blinkTarget)]);
		settle(s2);
		assert.equal(p2[0].exile.length, 1, 'Chrono Elk exiled');
		const exiledId = p2[0].exile[0].instanceId;

		// Simulate moving the exiled card back early via another effect by putting a phased-out check on a second test,
		// and here bump objectVersion by moving out of exile? Better: return-from-exile delayed + check objectVersion mismatch on sacrifice!
		assert.ok(exiledId);

		const { state: s3, p: p3 } = game();
		const targetBear = put(s3, p3[0], creature('Timber Bear', '', '2', '2'), 'battlefield');
		const sacAfterSpell = put(
			s3,
			p3[0],
			card({
				name: 'Fleeting Replica',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: "Create a token that's a copy of target creature you control. Sacrifice it at the beginning of the next end step."
			}),
			'hand'
		);
		cast(s3, p3[0], sacAfterSpell, [ref(targetBear)]);
		settle(s3);
		const copyTok = p3[0].battlefield.find((c) => c.isToken)!;
		assert.ok(copyTok);
		// Phased out at end step (CR 702.26d): delayed trigger ignores phased-out object.
		copyTok.phasedOut = true;
		passUntil(s3, 'end_step');
		settle(s3);
		assert.equal(p3[0].battlefield.filter((c) => c.isToken).length, 1, 'phased-out token was NOT sacrificed (CR 702.26d)');

		// Blink objectVersion mismatch (CR 400.7): a card returned from exile and re-entered as a new objectVersion is ignored.
		const { state: s4, p: p4 } = game();
		const bear4 = put(s4, p4[0], creature('Flicker Bear', '', '2', '2'), 'battlefield');
		const sacSpell4 = put(
			s4,
			p4[0],
			card({
				name: 'Ephemeral Copy',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: "Create a token that's a copy of target creature you control. Sacrifice it at the beginning of the next end step."
			}),
			'hand'
		);
		cast(s4, p4[0], sacSpell4, [ref(bear4)]);
		settle(s4);
		const delayed4 = s4.delayedTriggers![0];
		assert.equal(delayed4.delayedEffect?.kind, 'compiledDelayed');
		const token4 = p4[0].battlefield.find((c) => c.isToken)!;
		token4.objectVersion = (token4.objectVersion ?? 1) + 1; // represents a new object identity (CR 400.7)
		passUntil(s4, 'end_step');
		settle(s4);
		assert.equal(p4[0].battlefield.filter((c) => c.isToken).length, 1, 'new objectVersion was NOT sacrificed (CR 400.7)');
	});

	it('pauses for a human choice inside compiledDelayed resolution and resumes cleanly after JSON round-trip', () => {
		const { state: s0, p } = game();
		const alpha = put(s0, p[0], creature('Alpha Bear', '', '2', '2'), 'battlefield');
		const beta = put(s0, p[0], creature('Beta Bear', '', '2', '2'), 'battlefield');
		const omen = put(
			s0,
			p[0],
			card({
				name: 'Delayed Tribute',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'At the beginning of the next end step, sacrifice a creature.'
			}),
			'hand'
		);
		cast(s0, p[0], omen);
		settle(s0);

		let state = roundTrip(s0);
		passUntil(state, 'end_step');
		// Both players pass priority on the delayed trigger so it begins resolving and prompts Alice to choose a creature.
		pass(state);
		pass(state);
		assert.equal(state.pendingPrompts.length, 1, 'compiledDelayed paused for human creature choice');
		assert.equal(state.stack.length, 1, 'delayed stack item stays on stack with effectResume (CR 608.2n)');
		assert.ok(state.stack[0].effectResume);

		state = roundTrip(state);
		const prompt = state.pendingPrompts[0];
		const res = applyGameAction(state, state.players[0].playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseObjects', objectIds: [beta.instanceId] }
		});
		assert.equal(res.ok, true, res.error ?? '');
		assert.equal(state.stack.length, 0, 'delayed trigger finished resolving');
		assert.ok(state.players[0].battlefield.some((c) => c.instanceId === alpha.instanceId));
		assert.ok(state.players[0].graveyard.some((c) => c.instanceId === beta.instanceId), 'chosen creature sacrificed');
	});

	it('executes multi-clause compiledDelayed effects (sacrifice + lose life)', () => {
		const { state: s0, p } = game();
		const pact = put(
			s0,
			p[0],
			card({
				name: 'Pyre Bargain',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Create a 2/2 black Zombie creature token. At the beginning of the next end step, sacrifice it and lose 2 life.'
			}),
			'hand'
		);
		const startLife = p[0].life;
		cast(s0, p[0], pact);
		settle(s0);
		assert.equal(p[0].battlefield.filter((c) => c.isToken).length, 1);

		const state = roundTrip(s0);
		passUntil(state, 'end_step');
		settle(state);
		assert.equal(state.players[0].battlefield.filter((c) => c.isToken).length, 0);
		assert.equal(state.players[0].life, startLife - 2);
	});
});

describe('Track E Slice 2 — Part B: Linked Exile (CR 607.2a, CR 610.3a–d)', () => {
	it('exiles target permanent until source leaves the battlefield and returns it immediately under owner control when destroyed', () => {
		for (const jailerName of ['Banishing Sentinel', 'Crystalline Warden']) {
			const { state: s0, p } = game();
			const victim = put(s0, p[1], creature('Gilded Stag', '', '3', '3', 'Elk'), 'battlefield');
			victim.tapped = true;
			const startVer = victim.objectVersion ?? 1;
			const jailerCard = creature(
				jailerName,
				`When ${jailerName} enters the battlefield, exile target creature an opponent controls until ${jailerName} leaves the battlefield.`,
				'2',
				'2'
			);
			const jailerHand = put(s0, p[0], jailerCard, 'hand');
			cast(s0, p[0], jailerHand);
			resolveTop(s0); // creature enters -> ETB goes on stack (auto-picks only legal target or check prompt)
			if (s0.pendingPrompts.length === 1) {
				const pr = s0.pendingPrompts[0];
				assert.equal(
					applyGameAction(s0, p[0].playerId, {
						type: 'choice',
						promptId: pr.id,
						answer: { kind: 'chooseObjects', objectIds: [victim.instanceId] }
					}).ok,
					true
				);
			}
			settle(s0);

			const jailerBf = s0.players[0].battlefield.find((c) => c.card.name === jailerName)!;
			assert.ok(jailerBf);
			assert.equal(p[1].battlefield.some((c) => c.instanceId === victim.instanceId), false, 'victim exiled');
			assert.equal(p[1].exile.length, 1);
			assert.deepEqual(p[1].exile[0].exiledBy, {
				sourceInstanceId: jailerBf.instanceId,
				sourceObjectVersion: jailerBf.objectVersion
			});
			assert.deepEqual(p[1].exile[0].untilSourceLeavesReturn, {
				sourceInstanceId: jailerBf.instanceId,
				sourceObjectVersion: jailerBf.objectVersion,
				returnZone: 'battlefield'
			});

			const state = roundTrip(s0);
			const murder = put(
				state,
				state.players[0],
				card({ name: 'Doom Blade Test', manaCost: '{1}{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
				'hand'
			);
			cast(state, state.players[0], murder, [ref(jailerBf)]);
			settle(state);

			assert.equal(state.players[0].battlefield.some((c) => c.instanceId === jailerBf.instanceId), false);
			const returned = state.players[1].battlefield.find((c) => c.instanceId === victim.instanceId);
			assert.ok(returned, 'victim returned immediately when jailer left the battlefield (CR 610.3)');
			assert.equal(returned.controllerId, state.players[1].playerId, 'returned under owner control (CR 610.3c)');
			assert.equal(returned.tapped, false, 'returned untapped');
			assert.equal(returned.summoningSick, true, 'returned with summoning sickness');
			assert.ok((returned.objectVersion ?? 1) > startVer, 'fresh objectVersion across zone transitions (CR 400.7)');
			assert.equal(returned.exiledBy, undefined, 'exiledBy cleared on exit from exile (CR 400.7)');
			assert.equal(returned.untilSourceLeavesReturn, undefined, 'untilSourceLeavesReturn cleared on exit');
		}
	});

	it('CR 610.3a–b: never exiles target if source leaves battlefield or blinks before until-source-leaves trigger resolves', () => {
		// (a) Source is destroyed in response to its own ETB trigger -> target is never exiled.
		const { state: s0, p } = game();
		const target = put(s0, p[1], creature('Steadfast Ox', '', '2', '4'), 'battlefield');
		const priest = put(
			s0,
			p[0],
			creature(
				'Sunplate Jailer',
				'When ~ enters the battlefield, exile target creature an opponent controls until ~ leaves the battlefield.',
				'2',
				'2'
			),
			'hand'
		);
		cast(s0, p[0], priest);
		resolveTop(s0);
		if (s0.pendingPrompts.length === 1) {
			assert.equal(
				applyGameAction(s0, p[0].playerId, {
					type: 'choice',
					promptId: s0.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [target.instanceId] }
				}).ok,
				true
			);
		}
		assert.equal(s0.stack.length, 1, 'ETB exile trigger waiting on stack');
		const priestBf = s0.players[0].battlefield.find((c) => c.card.name === 'Sunplate Jailer')!;
		const bolt = put(
			s0,
			p[0],
			card({ name: 'Shock Test', manaCost: '{R}', typeLine: 'Instant', oracleText: 'Shock Test deals 3 damage to target creature.' }),
			'hand'
		);
		cast(s0, p[0], bolt, [ref(priestBf)]);
		resolveTop(s0); // Bolt kills priest via SBA before ETB resolves
		assert.equal(p[0].battlefield.some((c) => c.instanceId === priestBf.instanceId), false);
		settle(s0); // Now ETB resolves
		assert.equal(p[1].battlefield.some((c) => c.instanceId === target.instanceId), true, 'CR 610.3a: target was never exiled');
		assert.equal(p[1].exile.length, 0);

		// (b) Source's objectVersion changed before its ETB resolves (blinked) -> old ETB does NOT exile target.
		const { state: s1, p: p1 } = game();
		const target1 = put(s1, p1[1], creature('Vault Stag', '', '2', '2'), 'battlefield');
		const priest1 = put(
			s1,
			p1[0],
			creature(
				'Glass Warden',
				'When ~ enters the battlefield, exile target creature an opponent controls until ~ leaves the battlefield.',
				'2',
				'2'
			),
			'hand'
		);
		cast(s1, p1[0], priest1);
		resolveTop(s1);
		if (s1.pendingPrompts.length === 1) {
			assert.equal(
				applyGameAction(s1, p1[0].playerId, {
					type: 'choice',
					promptId: s1.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [target1.instanceId] }
				}).ok,
				true
			);
		}
		const priest1Bf = p1[0].battlefield.find((c) => c.card.name === 'Glass Warden')!;
		priest1Bf.objectVersion = (priest1Bf.objectVersion ?? 1) + 1; // blinked to a new object identity while still on battlefield
		settle(s1);
		assert.equal(p1[1].battlefield.some((c) => c.instanceId === target1.instanceId), true, 'CR 610.3b: objectVersion mismatch prevented exile');
		assert.equal(p1[1].exile.length, 0);
	});

	it('CR 610.3d + SBA batch: simultaneous returns happen after multi-permanent SBA deaths settle and returned ETBs see each other', () => {
		const { state: s1, p: q } = game();
		const retA = put(
			s1,
			q[1],
			creature('Echo Squire', 'When ~ enters the battlefield, draw a card.', '2', '2'),
			'battlefield'
		);
		const retB = put(
			s1,
			q[1],
			creature('Echo Knight', 'When ~ enters the battlefield, draw a card.', '2', '2'),
			'battlefield'
		);
		const warden1 = put(
			s1,
			q[0],
			creature(
				'Warden Alpha',
				'When ~ enters the battlefield, exile target creature an opponent controls until ~ leaves the battlefield.',
				'2',
				'2'
			),
			'hand'
		);
		cast(s1, q[0], warden1);
		resolveTop(s1);
		if (s1.pendingPrompts.length === 1) {
			assert.equal(
				applyGameAction(s1, q[0].playerId, {
					type: 'choice',
					promptId: s1.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [retA.instanceId] }
				}).ok,
				true
			);
		}
		settle(s1);

		const warden2 = put(
			s1,
			q[0],
			creature(
				'Warden Beta',
				'When ~ enters the battlefield, exile target creature an opponent controls until ~ leaves the battlefield.',
				'2',
				'2'
			),
			'hand'
		);
		cast(s1, q[0], warden2);
		resolveTop(s1);
		if (s1.pendingPrompts.length === 1) {
			assert.equal(
				applyGameAction(s1, q[0].playerId, {
					type: 'choice',
					promptId: s1.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [retB.instanceId] }
				}).ok,
				true
			);
		}
		settle(s1);
		assert.equal(q[1].exile.length, 2, 'both opponent creatures exiled under separate jailers');

		const handBefore = q[1].hand.length;
		// Deal lethal damage simultaneously via global -2/-2 or SBA damage on both Wardens so both die in one SBA batch!
		const wrath = put(
			s1,
			q[0],
			card({
				name: 'Pyroclasmic Sweep',
				manaCost: '{1}{R}',
				typeLine: 'Sorcery',
				oracleText: 'Pyroclasmic Sweep deals 2 damage to each creature.'
			}),
			'hand'
		);
		cast(s1, q[0], wrath);
		resolveTop(s1);
		// Both Warden Alpha & Warden Beta die in the same multi-item SBA batch; both Echo Squire & Echo Knight return simultaneously!
		assert.equal(q[0].battlefield.length, 0);
		assert.equal(q[1].battlefield.some((c) => c.instanceId === retA.instanceId), true, 'retA returned after multi-SBA batch');
		assert.equal(q[1].battlefield.some((c) => c.instanceId === retB.instanceId), true, 'retB returned after multi-SBA batch');
		const ord = s1.pendingPrompts.find((pr) => pr.purpose === 'trigger_order');
		if (ord && ord.choice?.kind === 'orderObjects') {
			assert.equal(
				applyGameAction(s1, ord.playerId, {
					type: 'choice',
					promptId: ord.id,
					answer: { kind: 'orderObjects', topIds: [...ord.choice.objectIds], bottomIds: [], shuffle: false }
				}).ok,
				true
			);
		}
		settle(s1);
		assert.equal(q[1].hand.length, handBefore + 2, 'both returned creatures triggered ETB card draw');
	});

	it('CR 607.2a & CR 400.7: links "cards exiled with ~" to exact source instanceId + objectVersion across static +1/+1, layerCache, and activated abilities', () => {
		const { state, p } = game();
		const gyCard1 = put(state, p[1], creature('Fallen Hound', '', '2', '2'), 'graveyard');
		const gyCard2 = put(state, p[1], creature('Fallen Crow', '', '1', '1'), 'graveyard');
		const outsider = put(state, p[1], creature('Unrelated Exile', '', '2', '2'), 'battlefield');

		const vaultCard = creature(
			'Relic Devourer',
			"When ~ enters the battlefield, exile target card from a graveyard.\n~ gets +1/+1 for each card exiled with ~.\n{T}: Return target card exiled with ~ to its owner's hand.",
			'2',
			'2'
		);
		const vaultHand = put(state, p[0], vaultCard, 'hand');
		cast(state, p[0], vaultHand);
		resolveTop(state);
		if (state.pendingPrompts.length === 1) {
			assert.equal(
				applyGameAction(state, p[0].playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [gyCard1.instanceId] }
				}).ok,
				true
			);
		}
		settle(state);

		const vaultBf = p[0].battlefield.find((c) => c.card.name === 'Relic Devourer')!;
		vaultBf.summoningSick = false;
		assert.equal(evaluatePermanent(state, vaultBf).power, 3, '2/2 + 1/1 for 1 linked exiled card');
		assert.equal(evaluatePermanent(state, vaultBf).toughness, 3);

		// Exile an unrelated creature via Swords to Plowshares: MUST NOT affect Relic Devourer's linked count or targetability.
		const swords = put(
			state,
			p[0],
			card({
				name: 'Banish Ray',
				manaCost: '{W}',
				typeLine: 'Instant',
				oracleText: 'Exile target creature.'
			}),
			'hand'
		);
		cast(state, p[0], swords, [ref(outsider)]);
		settle(state);
		assert.equal(evaluatePermanent(state, vaultBf).power, 3, 'unrelated exile does NOT boost ~');

		// Activate "{T}: Return target card exiled with ~ to its owner's hand." with gyCard1 (linked) succeeds;
		// trying to target outsider (unrelated exile) is rejected!
		const abilities = getEffectiveActivatedAbilities(state, p[0], vaultBf);
		const retAb = abilities.find((a) => !a.isManaAbility);
		assert.ok(retAb);
		const badAct = applyGameAction(state, p[0].playerId, {
			type: 'activate_ability',
			instanceId: vaultBf.instanceId,
			abilityId: retAb.id,
			targets: [exileRef(outsider)]
		});
		assert.equal(badAct.ok, false, 'cannot target card in exile not exiled with ~');

		const goodAct = applyGameAction(state, p[0].playerId, {
			type: 'activate_ability',
			instanceId: vaultBf.instanceId,
			abilityId: retAb.id,
			targets: [exileRef(gyCard1)]
		});
		assert.equal(goodAct.ok, true, goodAct.error ?? '');
		settle(state);
		assert.equal(p[1].hand.some((c) => c.instanceId === gyCard1.instanceId), true, 'linked exiled card returned to owner hand');
		assert.equal(gyCard1.exiledBy, undefined, 'CR 400.7: exiledBy cleared after leaving exile');
		assert.equal(evaluatePermanent(state, vaultBf).power, 2, 'READ_EXILE invalidated layerCache when exiled card left exile');
		void gyCard2;
	});

	it('CR 400.7 & CR 903.9a: blink breaks linked exile bond and Commander/Token redirects do not leak into untilSourceLeaves', () => {
		// 1. Blink breaks "cards exiled with ~" on a static counter.
		const { state: s0, p: p0 } = game();
		const gy = put(s0, p0[1], creature('Soul Relic', '', '1', '1'), 'graveyard');
		const holderHand = put(
			s0,
			p0[0],
			creature(
				'Soul Collector',
				'When ~ enters the battlefield, exile target card from a graveyard.\n~ gets +1/+1 for each card exiled with ~.',
				'2',
				'2'
			),
			'hand'
		);
		cast(s0, p0[0], holderHand);
		resolveTop(s0);
		if (s0.pendingPrompts.length === 1) {
			assert.equal(
				applyGameAction(s0, p0[0].playerId, {
					type: 'choice',
					promptId: s0.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [gy.instanceId] }
				}).ok,
				true
			);
		}
		settle(s0);
		const holderBf = p0[0].battlefield.find((c) => c.card.name === 'Soul Collector')!;
		assert.equal(evaluatePermanent(s0, holderBf).power, 3);
		// Blink Soul Collector (objectVersion increments -> new permanent has no relation to previously exiled cards, CR 400.7).
		holderBf.objectVersion = (holderBf.objectVersion ?? 1) + 1;
		assert.equal(evaluatePermanent(s0, holderBf).power, 2, 'CR 400.7: new objectVersion sees 0 cards exiled with old existence');

		// 2. Human Commander exiled until ~ leaves -> chooses Yes to move to Command Zone -> leaving ~ does NOT pull Commander back.
		const { state: s1, p: p1 } = game();
		const cmdCard = card({
			name: 'Test Commander Hero',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Legendary Creature — Knight',
			power: '3',
			toughness: '3',
			canBeCommander: true,
			oracleText: ''
		});
		const cmdBf = put(s1, p1[1], cmdCard, 'battlefield', true);
		const priest = put(
			s1,
			p1[0],
			creature(
				'Oathbound Jailer',
				'When ~ enters the battlefield, exile target creature an opponent controls until ~ leaves the battlefield.',
				'2',
				'2'
			),
			'hand'
		);
		cast(s1, p1[0], priest);
		resolveTop(s1);
		if (s1.pendingPrompts.length === 1 && s1.pendingPrompts[0].purpose !== 'commander_zone_choice') {
			assert.equal(
				applyGameAction(s1, p1[0].playerId, {
					type: 'choice',
					promptId: s1.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [cmdBf.instanceId] }
				}).ok,
				true
			);
		}
		settle(s1);
		// Commander SBA (CR 903.9a) prompts p1[1] to move Commander from exile -> command zone!
		const cmdPrompt = s1.pendingPrompts.find((pr) => pr.purpose === 'commander_zone_choice');
		assert.ok(cmdPrompt, 'Commander SBA prompt queued for human owner');
		assert.equal(
			applyGameAction(s1, p1[1].playerId, {
				type: 'choice',
				promptId: cmdPrompt.id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1[1].command.some((c) => c.instanceId === cmdBf.instanceId), true, 'Commander moved to Command Zone');
		assert.equal(cmdBf.untilSourceLeavesReturn, undefined, 'CR 400.7: leaving exile cleared untilSourceLeavesReturn');

		// Destroy Oathbound Jailer -> Commander remains in Command Zone.
		const priestBf = p1[0].battlefield.find((c) => c.card.name === 'Oathbound Jailer')!;
		const murder = put(
			s1,
			p1[0],
			card({ name: 'Fell Test', manaCost: '{1}{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		cast(s1, p1[0], murder, [ref(priestBf)]);
		settle(s1);
		assert.equal(p1[1].command.some((c) => c.instanceId === cmdBf.instanceId), true, 'Commander stayed in Command Zone');
		assert.equal(p1[1].battlefield.some((c) => c.instanceId === cmdBf.instanceId), false);
	});
});
