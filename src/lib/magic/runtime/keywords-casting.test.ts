import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { executeBotStep, hasAnyLegalInstantResponse } from '../ai.ts';
import { compileCard } from '../compiler/index.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getPlayerCommanderIdentity,
	getSpellCostRequirement
} from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { validateCommanderDeck } from '../scryfall.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard,
	type ZoneType
} from '../types.ts';
import { matchesObjectFilter, objectManaValue } from './objectFilter.ts';
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
		typeLine: overrides.typeLine ?? 'Instant',
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
		canBeCommander: overrides.canBeCommander ?? false,
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false
	};
}

function makeGame(opts?: {
	p1Bot?: boolean;
	p2Bot?: boolean;
	p1Commanders?: ScryfallCard[];
	p2Commanders?: ScryfallCard[];
}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	for (let i = 0; i < 2; i++) {
		const base = PRECON_DECKS[i % PRECON_DECKS.length];
		const customCmds = i === 0 ? opts?.p1Commanders : opts?.p2Commanders;
		const d: MagicDeck = customCmds
			? {
					...base,
					id: `custom_deck_${i}`,
					commanders: customCmds,
					colorIdentity: [...new Set(customCmds.flatMap((c) => c.colorIdentity))]
				}
			: base;
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: i === 0 ? Boolean(opts?.p1Bot) : Boolean(opts?.p2Bot),
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
	const state = createInitialGameState('KEYWORDS_CASTING_TEST', seats, decks, {
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
		if (!(i === 0 ? opts?.p1Commanders : opts?.p2Commanders)) {
			state.players[i].command = [];
		}
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

function resolveAllStack(state: GameState, maxSteps = 50): void {
	for (let i = 0; i < maxSteps && state.stack.length > 0; i++) {
		const prompt = state.pendingPrompts[0];
		if (prompt?.purpose === 'trigger_order' && prompt.choice?.kind === 'orderObjects') {
			applyGameAction(state, prompt.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'orderObjects', topIds: prompt.choice.objectIds, bottomIds: [], shuffle: false }
			});
			continue;
		}
		if (prompt?.purpose === 'trigger_may') {
			applyGameAction(state, prompt.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'yesNo', yes: true }
			});
			continue;
		}
		if (prompt) return;
		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		if (!res.ok) return;
	}
}

// ============================================================================
// 1. OVERLOAD (CR 702.96)
// ============================================================================

describe('Keyword: Overload (CR 702.96)', () => {
	it('Overload compile (CR 702.96a): compiles Cyclonic Rift and {X} overload costs into keyword abilities', () => {
		const riftIr = compileCard(staple('Cyclonic Rift')).faces[0];
		const riftKw = riftIr.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'overload');
		assert.ok(riftKw && riftKw.kind === 'keyword');
		assert.equal(riftKw.keyword.cost, '{6}{U}');
		assert.equal(
			riftIr.abilities.some((a) => a.kind === 'unsupported'),
			false
		);

		const xOverload = syntheticCard({
			name: 'Street Spasm Variant',
			manaCost: '{X}{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText:
				'Street Spasm Variant deals X damage to target creature without flying you don\'t control.\nOverload {X}{X}{R}{R}',
			colors: ['R'],
			colorIdentity: ['R'],
			keywords: ['Overload']
		});
		const xIr = compileCard(xOverload).faces[0];
		const xKw = xIr.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'overload');
		assert.ok(xKw && xKw.kind === 'keyword');
		assert.equal(xKw.keyword.cost, '{X}{X}{R}{R}');
	});

	it('Overload normal vs overload cast (CR 702.96a–b): enforces printed vs overload cost, target requirement, "you don\'t control", and rejects legacy xValue fallback', () => {
		const { state, p1, p2 } = makeGame();
		const ownRing = putInZone(state, p1, staple('Sol Ring'), 'battlefield');
		const oppRing = putInZone(state, p2, staple('Sol Ring'), 'battlefield');
		const oppSignet = putInZone(state, p2, staple('Arcane Signet'), 'battlefield');
		const oppIsland = putInZone(state, p2, staple('Island'), 'battlefield');

		// 1. Normal cast requires a legal target, pays {1}{U}, and bounces only that target.
		const rift1 = putInZone(state, p1, staple('Cyclonic Rift'), 'hand');
		p1.manaPool.U = 1;
		p1.manaPool.C = 1;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rift1.instanceId,
				optionId: 'normal',
				targets: []
			}).ok,
			false,
			'normal cast without target must be rejected'
		);

		// Legacy xValue >= 1 without optionId: "alt:overload" must NOT overload (must still require target and pay {1}{U}).
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rift1.instanceId,
				xValue: 1,
				targets: []
			}).ok,
			false,
			'xValue >= 1 fallback must be gone'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rift1.instanceId,
				optionId: 'normal',
				targets: [{ kind: 'permanent', id: oppRing.instanceId, label: 'Sol Ring' }]
			}).ok,
			true
		);
		assert.equal(p1.manaPool.U, 0);
		assert.equal(p1.manaPool.C, 0);
		resolveAllStack(state);

		assert.equal(p2.battlefield.some((c) => c.instanceId === oppRing.instanceId), false);
		assert.equal(p2.battlefield.some((c) => c.instanceId === oppSignet.instanceId), true);

		// 2. Overload cast rejects non-empty targets, requires {6}{U}, bounces every opponent nonland permanent, and leaves own nonlands & opponent lands untouched.
		const oppRingAgain = putInZone(state, p2, staple('Sol Ring'), 'battlefield');
		const rift2 = putInZone(state, p1, staple('Cyclonic Rift'), 'hand');
		p1.manaPool.U = 1;
		p1.manaPool.C = 6;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rift2.instanceId,
				optionId: 'alt:overload',
				targets: [{ kind: 'permanent', id: oppRingAgain.instanceId, label: 'Sol Ring' }]
			}).ok,
			false,
			'CR 702.96b: overloaded spell has no target instruction and must reject chosen targets'
		);

		const nonOverloadSpell = putInZone(state, p1, staple('Counterspell'), 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: nonOverloadSpell.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			false,
			'non-overload card cannot be cast with optionId: alt:overload'
		);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rift2.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true
		);
		assert.equal(p1.manaPool.U, 0);
		assert.equal(p1.manaPool.C, 0);
		resolveAllStack(state);

		assert.equal(p2.battlefield.some((c) => c.instanceId === oppRingAgain.instanceId), false);
		assert.equal(p2.battlefield.some((c) => c.instanceId === oppSignet.instanceId), false);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === oppIsland.instanceId),
			true,
			'opponent land must remain'
		);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === ownRing.instanceId),
			true,
			'controller own Sol Ring ("you don\'t control") must remain'
		);
	});

	it('Overload zero targets, Hexproof, Shroud, Protection, and Ward (CR 702.96b, 702.11b, 702.16b, 702.18a, 702.21a): casts with 0 legal targets, affects untargetable permanents, and does not trigger Ward', () => {
		const { state, p1, p2 } = makeGame();

		// Legal with 0 nonland permanents on the board at all:
		const emptyBoardRift = putInZone(state, p1, staple('Cyclonic Rift'), 'hand');
		p1.manaPool.U = 1;
		p1.manaPool.C = 6;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: emptyBoardRift.instanceId,
				optionId: 'normal',
				targets: []
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: emptyBoardRift.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true,
			'Overload cast is legal with 0 legal targets'
		);
		resolveAllStack(state);

		// Opponent controls Hexproof, Shroud, Protection from blue, and Ward {2} (Miirym, Sentinel Wyrm):
		const hexCreature = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Gladecover Scout',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Elf Scout',
				oracleText: 'Hexproof',
				colors: ['G'],
				colorIdentity: ['G'],
				keywords: ['Hexproof'],
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		const shroudCreature = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Calcite Snapper',
				manaCost: '{1}{U}{U}',
				cmc: 3,
				typeLine: 'Creature — Turtle',
				oracleText: 'Shroud',
				colors: ['U'],
				colorIdentity: ['U'],
				keywords: ['Shroud'],
				power: '1',
				toughness: '4'
			}),
			'battlefield'
		);
		const proBlueCreature = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Skylasher',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Insect',
				oracleText: 'Protection from blue',
				colors: ['G'],
				colorIdentity: ['G'],
				keywords: ['Protection'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const wardDragon = putInZone(state, p2, staple('Miirym, Sentinel Wyrm'), 'battlefield');

		const rift = putInZone(state, p1, staple('Cyclonic Rift'), 'hand');
		p1.manaPool.U = 1;
		p1.manaPool.C = 6; // Exactly {6}{U} -> 0 mana left to pay Ward {2} if Ward mistakenly triggered!

		// Normal cast cannot target Hexproof, Shroud, or Protection from blue:
		for (const protectedPerm of [hexCreature, shroudCreature, proBlueCreature]) {
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: rift.instanceId,
					optionId: 'normal',
					targets: [{ kind: 'permanent', id: protectedPerm.instanceId, label: protectedPerm.card.name }]
				}).ok,
				false
			);
		}

		// Overload cast succeeds, triggers NO Ward trigger on the stack, and bounces all 4 creatures!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: rift.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true
		);
		assert.equal(state.stack.length, 1, 'Ward {2} must NOT trigger on an overloaded spell');
		assert.equal(state.stack[0].card.name, 'Cyclonic Rift');

		resolveAllStack(state);
		assert.equal(p2.battlefield.length, 0, 'Hexproof, Shroud, Protection-from-blue, and Ward creatures all bounced');
		assert.equal(p2.hand.length, 4);
	});

	it('Overload cost modifiers, commander tax, and printed mana value (CR 702.96a, 118.9c–d, 202.3): applies reductions/taxes + commander tax on overload cost while keeping printed MV', () => {
		const overloadCommander = syntheticCard({
			name: 'Mizzix Surge',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Legendary Instant',
			oracleText: 'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {4}{U}',
			colors: ['U'],
			colorIdentity: ['U'],
			keywords: ['Overload'],
			canBeCommander: true
		});
		const { state, p1, p2 } = makeGame({ p1Commanders: [overloadCommander] });
		const cmdInst = p1.command[0];
		assert.ok(cmdInst);
		putInZone(state, p2, staple('Sol Ring'), 'battlefield');

		// Prior cast count = 1 (+{2} commander tax), cost reducer (-{1}), cost increaser (+{1}) => net +{2} on {4}{U} = {6}{U}.
		p1.commanderCastCounts[cmdInst.instanceId] = 1;
		cmdInst.commanderCastCount = 1;

		putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Goblin Electromancer',
				manaCost: '{U}{R}',
				cmc: 2,
				typeLine: 'Creature — Goblin Wizard',
				oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.',
				colors: ['U', 'R'],
				colorIdentity: ['U', 'R'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Sphere of Resistance',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Spells cost {1} more to cast.'
			}),
			'battlefield'
		);

		// With only {4}{U} (5 mana), commander tax +{2} makes it unaffordable:
		p1.manaPool.U = 1;
		p1.manaPool.C = 4;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cmdInst.instanceId,
				fromZone: 'command',
				optionId: 'alt:overload',
				targets: []
			}).ok,
			false
		);

		// With {6}{U} (7 mana), Overload + Commander Tax (+{2}) - {1} + {1} = {6}{U} succeeds!
		p1.manaPool.C = 6;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cmdInst.instanceId,
				fromZone: 'command',
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true
		);
		assert.equal(p1.manaPool.C, 0);
		assert.equal(p1.manaPool.U, 0);

		// CR 118.9c / 202.3: An overloaded spell's mana value on the stack is still its printed mana cost ({1}{U} -> 2), NOT 5 or 7!
		const spellCardOnStack = createCardInstance(state.stack[0].card, p1.playerId, 'stack');
		assert.equal(objectManaValue(state, spellCardOnStack), 2);
	});

	it('Overload timing restrictions (CR 702.96a, 601.3): sorcery overload obeys sorcery/Flash timing and combat-only cast restrictions', () => {
		const { state, p1, p2 } = makeGame();
		const sorceryOverload = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Vandalblast',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Destroy target artifact you don\'t control.\nOverload {4}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Overload']
			}),
			'hand'
		);
		const combatOnlyOverload = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Battle Flare',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText:
					'Cast this spell only during combat.\nBattle Flare deals 2 damage to target creature you don\'t control.\nOverload {2}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Overload']
			}),
			'hand'
		);
		p1.manaPool.R = 10;
		p1.manaPool.C = 20;

		// Combat-only instant overload rejected in main1 even with Flash/Instant speed:
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: combatOnlyOverload.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			false,
			'CR 601.3: "Cast this spell only during combat" still applies when overloaded'
		);

		// Sorcery overload rejected on opponent's turn unless granted Flash:
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorceryOverload.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			false
		);

		putInZone(state, p1, staple('Leyline of Anticipation'), 'battlefield');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorceryOverload.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true,
			'Granted Flash allows overloading sorcery on opponent turn'
		);
		resolveAllStack(state);

		// Advance to combat (declare_attackers) -> combat-only overload is now legal!
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;
		putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Goblin Piker',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Creature — Goblin Warrior',
				power: '2',
				toughness: '1'
			}),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: combatOnlyOverload.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.battlefield.length, 0);
	});

	it('Overload damage & destroy effects + AI bot support (CR 702.96b): covers damage (Protection prevents) and destroy (Indestructible survives, Protection destroyed) plus bot overload choice', () => {
		const { state, p1, p2 } = makeGame({ p1Bot: true });
		const ownArtifact = putInZone(state, p1, staple('Sol Ring'), 'battlefield');
		const oppNormalArt = putInZone(state, p2, staple('Arcane Signet'), 'battlefield');
		const oppProRedArt = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Ruby Ward Idol',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact Creature — Golem',
				oracleText: 'Protection from red',
				keywords: ['Protection'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const oppIndestArt = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Darksteel Ingot',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Artifact',
				oracleText: 'Indestructible',
				keywords: ['Indestructible']
			}),
			'battlefield'
		);

		// 1. Overloaded Damage (Mizzium Mortars): deals 4 to each creature you don't control; Protection from red PREVENTS damage (CR 702.16e)!
		const mortars = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Mizzium Mortars',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Mizzium Mortars deals 4 damage to target creature you don\'t control.\nOverload {3}{R}{R}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Overload']
			}),
			'hand'
		);
		const oppBear = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				colors: ['G'],
				colorIdentity: ['G'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		p1.manaPool.R = 3;
		p1.manaPool.C = 3;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: mortars.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.battlefield.some((c) => c.instanceId === oppBear.instanceId), false, 'Grizzly Bears killed by 4 damage');
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === oppProRedArt.instanceId),
			true,
			'Protection from red prevented overloaded red damage (CR 702.16e)'
		);

		// 2. Overloaded Destroy (Vandalblast): destroys Pro-Red artifact (no target, no damage), spares Indestructible & own Sol Ring!
		const vandalblast = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Vandalblast',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Destroy target artifact you don\'t control.\nOverload {4}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Overload']
			}),
			'hand'
		);
		p1.manaPool.R = 1;
		p1.manaPool.C = 4;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: vandalblast.instanceId,
				optionId: 'alt:overload',
				targets: []
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p2.battlefield.some((c) => c.instanceId === oppNormalArt.instanceId), false);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === oppProRedArt.instanceId),
			false,
			'Protection from red does NOT stop untargeted overloaded destroy'
		);
		assert.equal(
			p2.battlefield.some((c) => c.instanceId === oppIndestArt.instanceId),
			true,
			'Indestructible artifact survives overloaded destroy'
		);
		assert.equal(p1.battlefield.some((c) => c.instanceId === ownArtifact.instanceId), true);

		// 3. Bot Overload decision + hasAnyLegalInstantResponse with 0 targets:
		p2.battlefield = [];
		const botRift = putInZone(state, p1, staple('Cyclonic Rift'), 'hand');
		p1.manaPool.U = 1;
		p1.manaPool.C = 6;
		assert.equal(
			hasAnyLegalInstantResponse(state, p1),
			true,
			'Player holding Cyclonic Rift + {6}{U} has legal overload response even with 0 targets'
		);

		putInZone(state, p2, staple('Sol Ring'), 'battlefield');
		putInZone(state, p2, staple('Arcane Signet'), 'battlefield');
		executeBotStep(state, p1, p1);
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].sourceInstanceId, botRift.instanceId);
		assert.equal(state.stack[0].castOptionId, 'alt:overload', 'Bot chose alt:overload against >= 2 opponent nonland permanents');
		assert.equal(state.stack[0].spellMods?.targetsBecomeEach, true);
	});

	it('getCastOptions enumerates legal options across normal, dual-option, X, exile-permission, and CR 118.9a Suspend cards', () => {
		const { state, p1, p2 } = makeGame();

		// 1. Normal-only card (Counterspell): 0 options when stack empty, 1 option ('normal') when opponent spell on stack.
		const cs = putInZone(state, p1, staple('Counterspell'), 'hand');
		p1.manaPool.U = 2;
		assert.deepEqual(
			getCastOptions(state, p1.playerId, cs, 'hand').map((o) => o.id),
			[],
			'Counterspell has no legal cast options when stack is empty'
		);
		state.stack.push({
			id: 'stk_dummy',
			sourceInstanceId: 'src_dummy',
			card: staple('Sol Ring'),
			ownerId: p2.playerId,
			controllerId: p2.playerId,
			kind: 'spell',
			title: 'Sol Ring',
			oracleText: '',
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: 0
		});
		const csOpts = getCastOptions(state, p1.playerId, cs, 'hand');
		assert.deepEqual(csOpts.map((o) => o.id), ['normal']);
		assert.equal(csOpts[0].requiresTarget, true);
		assert.equal(csOpts[0].choosesX, false);
		state.stack = [];

		// 2. Dual normal + overload cards (Cyclonic Rift + synthetic Storm Surge + synthetic X+overload card).
		const oppRing = putInZone(state, p2, staple('Sol Ring'), 'battlefield');
		const rift = putInZone(state, p1, staple('Cyclonic Rift'), 'hand');
		p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 };
		assert.deepEqual(
			getCastOptions(state, p1.playerId, rift, 'hand').map((o) => o.id),
			['normal'],
			'With only {1}{U}, only normal option is legal'
		);

		p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 6 };
		const dualRiftOpts = getCastOptions(state, p1.playerId, rift, 'hand');
		assert.deepEqual(dualRiftOpts.map((o) => o.id), ['normal', 'alt:overload']);
		assert.equal(dualRiftOpts[0].requiresTarget, true);
		assert.equal(dualRiftOpts[1].requiresTarget, false);
		assert.equal(dualRiftOpts[1].spellMods.targetsBecomeEach, true);
		assert.equal(dualRiftOpts[1].costDisplay, '{6}{U}');

		const synthDual = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Gale Wash',
				manaCost: '{1}{U}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: "Return target nonland permanent you don't control to its owner's hand.\nOverload {5}{U}",
				colors: ['U'],
				colorIdentity: ['U'],
				keywords: ['Overload']
			}),
			'hand'
		);
		assert.deepEqual(
			getCastOptions(state, p1.playerId, synthDual, 'hand').map((o) => o.id),
			['normal', 'alt:overload']
		);

		const xOverload = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Arcane Flare',
				manaCost: '{X}{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: "Arcane Flare deals X damage to target creature you don't control.\nOverload {X}{X}{R}{R}",
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Overload']
			}),
			'hand'
		);
		const oppBear = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Grizzly Bears',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
		const xOnlyNormal = getCastOptions(state, p1.playerId, xOverload, 'hand');
		assert.deepEqual(xOnlyNormal.map((o) => o.id), ['normal']);
		assert.equal(xOnlyNormal[0].choosesX, true);

		p1.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 2 };
		const xBoth = getCastOptions(state, p1.playerId, xOverload, 'hand');
		assert.deepEqual(xBoth.map((o) => o.id), ['normal', 'alt:overload']);
		assert.equal(xBoth[1].choosesX, true);

		// 3. Exile-permission card vs castViaSuspend (CR 118.9a).
		const exiledRift = putInZone(state, p2, staple('Cyclonic Rift'), 'exile');
		assert.deepEqual(
			getCastOptions(state, p1.playerId, exiledRift, 'exile'),
			[],
			'Exiled card without permission offers 0 options'
		);
		exiledRift.playableFromExileBy = {
			playerId: p1.playerId,
			sourceName: 'Opposition Agent',
			spendManaAsAnyColor: true
		};
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 7 };
		const exOpts = getCastOptions(state, p1.playerId, exiledRift, 'exile');
		assert.deepEqual(exOpts.map((o) => o.id), ['exile:permission', 'alt:overload']);
		assert.equal(exOpts[0].permission, 'exile_permission');

		// When castViaSuspend is set, CR 118.9a forbids combining another alt cost.
		exiledRift.castViaSuspend = true;
		const suspOpts = getCastOptions(state, p1.playerId, exiledRift, 'exile');
		assert.deepEqual(suspOpts.map((o) => o.id), ['exile:suspend']);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: exiledRift.instanceId,
				fromZone: 'exile',
				optionId: 'alt:overload',
				targets: []
			}).ok,
			false,
			'CR 118.9a: cannot apply alt:overload to a card being cast via Suspend'
		);

		// Clean up unused local warnings
		assert.ok(oppRing && oppBear);
	});

	it('UI-equivalence via getCastOptions order + invalid optionId rejection + keyword-blind UI/AI check', () => {
		const { state, p1, p2 } = makeGame();
		const opp1 = putInZone(state, p2, staple('Sol Ring'), 'battlefield');
		const opp2 = putInZone(state, p2, staple('Arcane Signet'), 'battlefield');
		const card = putInZone(state, p1, staple('Cyclonic Rift'), 'hand');
		p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 6 };

		// UI-equivalence: client picks solely by getCastOptions index without referencing keyword names
		const options = getCastOptions(state, p1.playerId, card, 'hand');
		assert.equal(options.length, 2);
		const secondOption = options[1];
		assert.equal(secondOption.choosesX, false);
		assert.equal(secondOption.requiresTarget, false);

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: card.instanceId,
			fromZone: secondOption.fromZone as 'hand',
			xValue: 0,
			optionId: secondOption.id,
			targets: []
		});
		assert.equal(castRes.ok, true, castRes.error ?? 'expected ok');
		assert.equal(state.stack[0].castOptionId, secondOption.id);
		assert.equal(state.stack[0].spellMods?.castSummarySuffix, ' (Overloaded)');
		resolveAllStack(state);
		assert.equal(p2.battlefield.length, 0);
		assert.ok(opp1 && opp2);

		// Unknown optionId rejection
		const optSpell = putInZone(state, p1, staple('Opt'), 'hand');
		p1.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 };
		const bogusRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: optSpell.instanceId,
			optionId: 'alt:bogus',
			targets: []
		});
		assert.equal(bogusRes.ok, false, 'Unknown optionId must be rejected');

		// Verify ArenaTable.svelte and ai.ts contain zero overload or legacy cast-mode literals
		const arenaSrc = fs.readFileSync(
			path.resolve('src/lib/magic/ArenaTable.svelte'),
			'utf8'
		);
		const aiSrc = fs.readFileSync(path.resolve('src/lib/magic/ai.ts'), 'utf8');
		const legacyCastModeRe = new RegExp('cast' + 'Mode');
		assert.equal(/overload/i.test(arenaSrc), false, 'ArenaTable.svelte must not mention overload');
		assert.equal(/overload/i.test(aiSrc), false, 'ai.ts must not mention overload');
		assert.equal(legacyCastModeRe.test(arenaSrc), false, 'ArenaTable.svelte must not use legacy cast mode');
		assert.equal(legacyCastModeRe.test(aiSrc), false, 'ai.ts must not use legacy cast mode');
	});
});

// ============================================================================
// 2. FLASH (CR 702.8)
// ============================================================================

describe('Keyword: Flash (CR 702.8)', () => {
	it('Flash compile, instant-speed casting, non-flash rejection, gain/loss, and Can\'t-Beats-Can restriction (CR 702.8a, 101.2)', () => {
		const oppAgentIr = compileCard(staple('Opposition Agent')).faces[0];
		assert.ok(oppAgentIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'flash'));

		const comboCard = syntheticCard({
			name: 'Sky Hussar',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Merfolk Rogue',
			oracleText: 'Flash, flying',
			colors: ['U'],
			colorIdentity: ['U'],
			keywords: ['Flash', 'Flying'],
			power: '2',
			toughness: '1'
		});
		const comboIr = compileCard(comboCard).faces[0];
		assert.equal(
			comboIr.abilities.filter((a) => a.kind === 'keyword').length,
			2,
			'comma-separated Flash, flying compiles to two keyword abilities'
		);

		const { state, p1, p2 } = makeGame();
		const flashCreature = putInZone(state, p1, staple('Opposition Agent'), 'hand');
		const nonFlashCreature = putInZone(state, p1, staple('Elvish Archdruid'), 'hand');
		p1.manaPool = { W: 5, U: 5, B: 5, R: 5, G: 5, C: 10 };

		// Opponent's turn during combat with a spell on the stack:
		state.activePlayerIndex = 1;
		state.phase = 'declare_attackers';
		state.priorityPlayerIndex = 0;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: nonFlashCreature.instanceId
			}).ok,
			false,
			'Creature without Flash cannot be cast on opponent turn / combat'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: flashCreature.instanceId
			}).ok,
			true,
			'Creature with Flash CAN be cast on opponent turn during combat'
		);

		// Granting Flash via Vedalken Orrery lets non-Flash creature be cast in response to stack; losing abilities removes it!
		const orrery = putInZone(state, p1, staple('Vedalken Orrery'), 'battlefield');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: nonFlashCreature.instanceId
			}).ok,
			true,
			'Vedalken Orrery grants Flash in response to non-empty stack'
		);
		resolveAllStack(state);

		// Strip Orrery's abilities with Song of the Dryads -> another non-Flash sorcery is rejected again!
		const song = putInZone(state, p2, staple('Song of the Dryads'), 'battlefield');
		song.attachedToId = orrery.instanceId;
		const cultivate = putInZone(state, p1, staple('Cultivate'), 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cultivate.instanceId
			}).ok,
			false,
			'Orrery that lost abilities no longer grants Flash'
		);

		// CR 101.2: "Opponents can't cast spells during your turn" overrides innate Flash!
		putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Grand Abolisher',
				manaCost: '{W}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Cleric',
				oracleText: 'During your turn, your opponents can\'t cast spells or activate abilities of artifacts, creatures, or enchantments.',
				colors: ['W'],
				colorIdentity: ['W'],
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const dressDown = putInZone(state, p1, staple('Dress Down'), 'hand');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: dressDown.instanceId
			}).ok,
			false,
			'CR 101.2: restriction beats Flash permission'
		);
	});
});

// ============================================================================
// 3. SUSPEND (CR 702.62)
// ============================================================================

describe('Keyword: Suspend (CR 702.62)', () => {
	it('Suspend compile, timing/stax legality, upkeep counter tick-down, free cast, creature haste, and control-change haste loss (CR 702.62a, 118.6)', () => {
		const visionIr = compileCard(staple('Ancestral Vision')).faces[0];
		const suspKw = visionIr.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'suspend');
		assert.ok(suspKw && suspKw.kind === 'keyword');
		assert.equal(suspKw.keyword.n, 4);
		assert.equal(suspKw.keyword.cost, '{U}');

		const { state, p1, p2 } = makeGame();
		const vision = putInZone(state, p1, staple('Ancestral Vision'), 'hand');
		const suspBeast = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Durkwood Baloth',
				manaCost: '{4}{G}{G}',
				cmc: 6,
				typeLine: 'Creature — Beast',
				oracleText: 'Suspend 1—{G}',
				colors: ['G'],
				colorIdentity: ['G'],
				keywords: ['Suspend'],
				power: '5',
				toughness: '5'
			}),
			'hand'
		);
		for (let i = 0; i < 5; i++) {
			putInZone(state, p1, staple('Island'), 'library');
			putInZone(state, p2, staple('Island'), 'library');
		}
		p1.manaPool.U = 2;
		p1.manaPool.G = 2;

		// CR 118.6: Card with no mana cost (Ancestral Vision, manaCost: '') cannot be cast normally from hand:
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: vision.instanceId
			}).ok,
			false
		);

		// Sorcery-speed card cannot be suspended on opponent's turn unless it has Flash:
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'suspend_card',
				instanceId: suspBeast.instanceId
			}).ok,
			false
		);

		// Back on P1's main1: Rule of Law after 1 spell cast this turn blocks suspend_card ("any time you could begin to cast"):
		state.activePlayerIndex = 0;
		state.phase = 'main1';
		state.priorityPlayerIndex = 0;
		const ruleOfLaw = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Rule of Law',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: 'Each player can\'t cast more than one spell each turn.',
				colors: ['W'],
				colorIdentity: ['W']
			}),
			'battlefield'
		);
		p1.spellsCastThisTurn = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'suspend_card',
				instanceId: suspBeast.instanceId
			}).ok,
			false,
			'CR 702.62a: cannot suspend if Rule of Law prevents beginning to cast a spell'
		);

		// Clear Rule of Law and suspend Durkwood Baloth (Suspend 1—{G}):
		p2.battlefield = p2.battlefield.filter((c) => c.instanceId !== ruleOfLaw.instanceId);
		p1.spellsCastThisTurn = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'suspend_card',
				instanceId: suspBeast.instanceId
			}).ok,
			true
		);
		assert.equal(p1.manaPool.G, 1);
		assert.equal(p1.exile.some((c) => c.instanceId === suspBeast.instanceId), true);
		assert.equal(suspBeast.counters.time, 1);

		// Advance through P1's turn -> P2's upkeep (must NOT remove P1's time counter!) -> P1's next upkeep!
		for (let guard = 0; guard < 20; guard++) {
			const active = state.players[state.activePlayerIndex];
			if (active.playerId === p2.playerId && state.phase === 'main1') break;
			const prio = state.players[state.priorityPlayerIndex];
			applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		}
		assert.equal(suspBeast.counters.time, 1, 'Opponent upkeep must NOT remove time counter');

		for (let guard = 0; guard < 20; guard++) {
			const active = state.players[state.activePlayerIndex];
			if (active.playerId === p1.playerId && state.phase === 'main1') break;
			const prio = state.players[state.priorityPlayerIndex];
			applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		}

		// Durkwood Baloth entered on P1's upkeep without paying mana and has Haste via Suspend!
		const balothOnBoard = p1.battlefield.find((c) => c.instanceId === suspBeast.instanceId);
		assert.ok(balothOnBoard, 'Suspended creature entered battlefield when last time counter was removed');
		assert.equal(evaluatePermanent(state, balothOnBoard).activeKeywords.includes('Haste'), true);

		// Verify Baloth can legally attack this turn!
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' }); // begin_combat
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' }); // declare_attackers
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [{ attackerInstanceId: balothOnBoard.instanceId, defenderPlayerId: p2.playerId }]
			}).ok,
			true,
			'Creature cast via Suspend has Haste and attacks immediately'
		);

		// Finish combat to main2; if P2 gains control of Baloth, CR 702.62a says Haste only lasts "until you lose control of it"!
		for (let guard = 0; guard < 20 && (state.phase as string) !== 'main2'; guard++) {
			const prio = state.players[state.priorityPlayerIndex];
			if ((state.phase as string) === 'declare_blockers' && prio.playerId === p2.playerId && state.combat.blockersDeclared === false) {
				applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
				continue;
			}
			applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		}
		transferBattlefieldControl(balothOnBoard, p1, p2, state);
		assert.equal(balothOnBoard.controllerId, p2.playerId);
		assert.equal(
			evaluatePermanent(state, balothOnBoard).activeKeywords.includes('Haste'),
			false,
			'CR 702.62a: Suspend-granted Haste ends when control of the creature is lost'
		);
	});

	it.todo(
		'Suspend stack triggers & optional play choice (CR 702.62a): upkeep counter removal and last-counter play trigger use the stack with priority responses and optional "you may play it" prompt (currently resolved inline during upkeep)'
	);
});

// ============================================================================
// 4. PROWESS (CR 702.108)
// ============================================================================

describe('Keyword: Prowess (CR 702.108)', () => {
	it('Prowess compile, noncreature-only trigger, multi-instance stacking, cleanup wear-off, and ability loss (CR 702.108a–b)', () => {
		const monkCard = syntheticCard({
			name: 'Monastery Swiftspear',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Creature — Human Monk',
			oracleText: 'Haste\nProwess',
			colors: ['R'],
			colorIdentity: ['R'],
			keywords: ['Haste', 'Prowess'],
			power: '1',
			toughness: '2'
		});
		const doubleProwessCard = syntheticCard({
			name: 'Gitaxian Spellblade',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Creature — Vedalken Monk',
			oracleText: 'Prowess\nProwess',
			colors: ['U'],
			colorIdentity: ['U'],
			keywords: ['Prowess'],
			power: '2',
			toughness: '2'
		});
		assert.equal(
			compileCard(doubleProwessCard).faces[0].abilities.filter(
				(a) => a.kind === 'keyword' && a.keyword.name === 'prowess'
			).length,
			2
		);

		const { state, p1, p2 } = makeGame();
		for (let i = 0; i < 5; i++) {
			putInZone(state, p1, staple('Island'), 'library');
			putInZone(state, p2, staple('Island'), 'library');
		}
		const monk = putInZone(state, p1, monkCard, 'battlefield');
		const doubleMonk = putInZone(state, p1, doubleProwessCard, 'battlefield');
		p1.manaPool = { W: 5, U: 5, B: 5, R: 5, G: 5, C: 10 };
		p2.manaPool = { W: 5, U: 5, B: 5, R: 5, G: 5, C: 10 };

		// 1. Land play does NOT trigger Prowess:
		const island = putInZone(state, p1, staple('Island'), 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: island.instanceId }).ok, true);
		assert.equal(state.stack.length, 0);
		assert.equal(evaluatePermanent(state, monk).power, 1);

		// 2. Creature spell (including Artifact Creature) does NOT trigger Prowess:
		const artCreature = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Memnite',
				manaCost: '{0}',
				cmc: 0,
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1'
			}),
			'hand'
		);
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: artCreature.instanceId }).ok, true);
		assert.equal(state.stack.length, 1, 'Artifact Creature spell must NOT trigger Prowess');
		resolveAllStack(state);
		assert.equal(evaluatePermanent(state, monk).power, 1);

		// 3. Noncreature spell (Sol Ring) triggers Prowess ONCE on monk (+1/+1) and TWICE on doubleMonk (+2/+2):
		const solRing = putInZone(state, p1, staple('Sol Ring'), 'hand');
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: solRing.instanceId }).ok, true);
		assert.equal(state.stack.filter((s) => s.kind === 'triggered').length, 3);
		resolveAllStack(state);
		assert.equal(evaluatePermanent(state, monk).power, 2);
		assert.equal(evaluatePermanent(state, monk).toughness, 3);
		assert.equal(evaluatePermanent(state, doubleMonk).power, 4);
		assert.equal(evaluatePermanent(state, doubleMonk).toughness, 4);

		// 4. Opponent's noncreature spell does NOT trigger P1's Prowess:
		const oppInstant = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Opt Lite',
				manaCost: '{U}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Draw a card.',
				colors: ['U'],
				colorIdentity: ['U']
			}),
			'hand'
		);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		assert.equal(applyGameAction(state, p2.playerId, { type: 'cast_spell', instanceId: oppInstant.instanceId }).ok, true);
		assert.equal(state.stack.filter((s) => s.kind === 'triggered').length, 0);
		resolveAllStack(state);

		// 5. Losing abilities (Dress Down) stops Prowess from triggering:
		// Advance back to P1 priority in main2 or cast instant after P2 passes
		for (let guard = 0; guard < 10 && state.players[state.priorityPlayerIndex].playerId !== p1.playerId; guard++) {
			applyGameAction(state, state.players[state.priorityPlayerIndex].playerId, { type: 'pass_priority' });
		}
		const dressDown = putInZone(state, p2, staple('Dress Down'), 'battlefield');
		assert.ok(dressDown);
		const arcaneSignet = putInZone(state, p1, staple('Arcane Signet'), 'hand');
		if (state.phase !== 'main1' && state.phase !== 'main2') {
			state.phase = 'main2';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
		}
		assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: arcaneSignet.instanceId }).ok, true);
		assert.equal(state.stack.filter((s) => s.kind === 'triggered').length, 0, 'Creatures under Dress Down lost Prowess');
		resolveAllStack(state);

		// 6. Wears off at end of turn (cleanup step):
		p2.battlefield = [];
		for (let guard = 0; guard < 25; guard++) {
			if (state.players[state.activePlayerIndex].playerId === p2.playerId && state.phase === 'main1') break;
			applyGameAction(state, state.players[state.priorityPlayerIndex].playerId, { type: 'pass_priority' });
		}
		assert.equal(evaluatePermanent(state, monk).power, 1, 'Prowess +1/+1 wore off in cleanup');
		assert.equal(evaluatePermanent(state, monk).toughness, 2);
		assert.equal(evaluatePermanent(state, doubleMonk).power, 2);
	});
});

// ============================================================================
// 5. CHANGELING (CR 702.73)
// ============================================================================

describe('Keyword: Changeling (CR 702.73)', () => {
	it('Changeling compile, all-zone creature subtypes, tribal lord & graveyard effects, non-creature subtype exclusion, and Layer 4 vs Layer 6 ability loss (CR 702.73a, 613.1d, 613.5)', () => {
		const outcast = syntheticCard({
			name: 'Changeling Outcast',
			manaCost: '{B}',
			cmc: 1,
			typeLine: 'Creature — Shapeshifter',
			oracleText: 'Changeling',
			colors: ['B'],
			colorIdentity: ['B'],
			keywords: ['Changeling'],
			power: '1',
			toughness: '1'
		});
		const cribSwap = syntheticCard({
			name: 'Crib Swap',
			manaCost: '{2}{W}',
			cmc: 3,
			typeLine: 'Kindred Instant — Shapeshifter',
			oracleText: 'Changeling\nExile target creature.',
			colors: ['W'],
			colorIdentity: ['W'],
			keywords: ['Changeling']
		});
		assert.ok(compileCard(outcast).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'changeling'));
		assert.ok(compileCard(cribSwap).faces[0].abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'changeling'));

		const { state, p1, p2 } = makeGame();

		// 1. Every zone check (battlefield, hand, library, graveyard, exile, command) + Kindred card:
		for (const zone of ['battlefield', 'hand', 'library', 'graveyard', 'exile', 'command'] as const) {
			const inst = putInZone(state, p1, outcast, zone);
			assert.equal(
				matchesObjectFilter(inst, { subtypes: ['Elf'] }, { state, controllerId: p1.playerId }),
				true,
				`Changeling has Elf subtype in ${zone}`
			);
			assert.equal(
				matchesObjectFilter(inst, { subtypes: ['Dragon'] }, { state, controllerId: p1.playerId }),
				true,
				`Changeling has Dragon subtype in ${zone}`
			);
			assert.equal(
				matchesObjectFilter(inst, { subtypes: ['Shrine'] }, { state, controllerId: p1.playerId }),
				false,
				`Changeling must NOT have non-creature subtype Shrine in ${zone}`
			);
			assert.equal(
				matchesObjectFilter(inst, { subtypes: ['Equipment'] }, { state, controllerId: p1.playerId }),
				false
			);
		}
		const kindredInHand = putInZone(state, p1, cribSwap, 'hand');
		assert.equal(
			matchesObjectFilter(kindredInHand, { subtypes: ['Goblin'] }, { state, controllerId: p1.playerId }),
			true,
			'Kindred Changeling spell has Goblin subtype in hand'
		);

		// Reset zones for engine gameplay checks:
		p1.battlefield = [];
		p1.hand = [];
		p1.graveyard = [];
		p1.exile = [];
		p1.command = [];

		// 2. Tribal lord on battlefield (Elvish Archdruid buffs "Other Elf creatures you control get +1/+1"):
		const changelingPerm = putInZone(state, p1, outcast, 'battlefield');
		putInZone(state, p1, staple('Elvish Archdruid'), 'battlefield');
		assert.equal(evaluatePermanent(state, changelingPerm).power, 2, 'Changeling buffed by Elvish Archdruid');
		assert.equal(evaluatePermanent(state, changelingPerm).toughness, 2);

		// 3. Tribal graveyard target & hand put-onto-battlefield via applyGameAction:
		const gyChangeling = putInZone(state, p1, outcast, 'graveyard');
		const handChangeling = putInZone(state, p1, outcast, 'hand');
		const elfReanimate = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Elvish Resurrection',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Return target Elf creature card from your graveyard to the battlefield.',
				colors: ['B'],
				colorIdentity: ['B']
			}),
			'hand'
		);
		const elfPiper = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Elvish Ambush',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText: 'Put an Elf creature card from your hand onto the battlefield.',
				colors: ['G'],
				colorIdentity: ['G']
			}),
			'hand'
		);
		p1.manaPool.B = 1;
		p1.manaPool.G = 1;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: elfReanimate.instanceId,
				targets: [{ kind: 'graveyard_card', id: gyChangeling.instanceId, label: gyChangeling.card.name }]
			}).ok,
			true,
			'Changeling in graveyard is a legal target Elf creature card'
		);
		resolveAllStack(state);
		assert.equal(p1.battlefield.some((c) => c.instanceId === gyChangeling.instanceId), true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: elfPiper.instanceId
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === handChangeling.instanceId),
			true,
			'Run.matches put Changeling from hand onto the battlefield as an Elf creature card'
		);

		// 4. CR 613.1d / 613.5: Layer 6 "loses all abilities" (Dress Down) does NOT strip Changeling's creature types (still gets +1/+1 if Archdruid entered? Wait: Archdruid also loses abilities under Dress Down, so test single-target ability removal or evaluatePermanent.hasSubType!):
		const dressDown = putInZone(state, p2, staple('Dress Down'), 'battlefield');
		assert.equal(evaluatePermanent(state, changelingPerm).losesAllAbilities, true);
		assert.equal(
			evaluatePermanent(state, changelingPerm).hasSubType('Elf'),
			true,
			'CR 613.1d / 613.5: Changeling applied in Layer 4 before Dress Down removed abilities in Layer 6'
		);
		p2.battlefield = p2.battlefield.filter((c) => c.instanceId !== dressDown.instanceId);

		// Whereas Darksteel Mutation sets types/subtypes in Layer 4 ("Artifact Creature — Insect"), overwriting Changeling subtypes!
		const mutation = putInZone(state, p2, staple('Darksteel Mutation'), 'battlefield');
		mutation.attachedToId = changelingPerm.instanceId;
		assert.equal(evaluatePermanent(state, changelingPerm).hasSubType('Insect'), true);
		assert.equal(
			evaluatePermanent(state, changelingPerm).hasSubType('Elf'),
			false,
			'CR 205.1a: non-CDA Layer 4 type-setting Aura overwrites Changeling subtypes to Insect'
		);

		// And Maskwood Nexus (Layer 4 additive allCreatureTypes) grants all creature types back!
		putInZone(state, p1, staple('Maskwood Nexus'), 'battlefield');
		assert.equal(evaluatePermanent(state, changelingPerm).hasSubType('Elf'), true);
	});
});

// ============================================================================
// 6. PARTNER (CR 702.124)
// ============================================================================

describe('Keyword: Partner (CR 702.124)', () => {
	it('Partner compile & deck validation (CR 702.124a–m): validates generic Partner, Partner with [Name], combined color identity, 100-card total, duplicate commander rejection, and regex false-positive guards', () => {
		const tymna = syntheticCard({
			name: 'Tymna the Weaver',
			manaCost: '{1}{W}{B}',
			cmc: 3,
			typeLine: 'Legendary Creature — Human Cleric',
			oracleText: 'Lifelink\nPartner',
			colors: ['W', 'B'],
			colorIdentity: ['W', 'B'],
			keywords: ['Lifelink', 'Partner'],
			canBeCommander: true,
			hasPartner: true,
			power: '2',
			toughness: '2'
		});
		const thrasios = syntheticCard({
			name: 'Thrasios, Triton Hero',
			manaCost: '{G}{U}',
			cmc: 2,
			typeLine: 'Legendary Creature — Merfolk Wizard',
			oracleText: 'Partner',
			colors: ['G', 'U'],
			colorIdentity: ['G', 'U'],
			keywords: ['Partner'],
			canBeCommander: true,
			hasPartner: true,
			power: '1',
			toughness: '3'
		});
		const pir = syntheticCard({
			name: 'Pir, Imaginative Rascal',
			manaCost: '{2}{G}',
			cmc: 3,
			typeLine: 'Legendary Creature — Human',
			oracleText: 'Partner with Toothy, Imaginary Friend',
			colors: ['G'],
			colorIdentity: ['G'],
			keywords: ['Partner with', 'Partner'],
			canBeCommander: true,
			hasPartner: true,
			power: '1',
			toughness: '1'
		});
		const toothy = syntheticCard({
			name: 'Toothy, Imaginary Friend',
			manaCost: '{3}{U}',
			cmc: 4,
			typeLine: 'Legendary Creature — Illusion',
			oracleText: 'Partner with Pir, Imaginative Rascal',
			colors: ['U'],
			colorIdentity: ['U'],
			keywords: ['Partner with', 'Partner'],
			canBeCommander: true,
			hasPartner: true,
			power: '1',
			toughness: '1'
		});
		const fakePartnerProse = syntheticCard({
			name: 'Lone Wolf Tactician',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Legendary Creature — Human Warrior',
			oracleText: 'Whenever ~ attacks, target creature becomes its partner in battle until end of turn.',
			colors: ['R'],
			colorIdentity: ['R'],
			canBeCommander: true,
			power: '3',
			toughness: '3'
		});
		const changelingDoctor = syntheticCard({
			name: 'Impostor Doctor',
			manaCost: '{2}{U}',
			cmc: 3,
			typeLine: 'Legendary Creature — Time Lord Doctor',
			oracleText: 'Changeling',
			colors: ['U'],
			colorIdentity: ['U'],
			keywords: ['Changeling'],
			canBeCommander: true,
			power: '2',
			toughness: '2'
		});
		const companion = syntheticCard({
			name: 'Sarah Jane Smith',
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Legendary Creature — Human Detective',
			oracleText: "Doctor's companion",
			colors: ['W'],
			colorIdentity: ['W'],
			keywords: ["Doctor's companion"],
			canBeCommander: true,
			power: '2',
			toughness: '2'
		});

		// Compile checks:
		const tymnaIr = compileCard(tymna).faces[0];
		assert.ok(tymnaIr.abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'partner' && !a.keyword.param));
		const pirIr = compileCard(pir).faces[0];
		assert.ok(
			pirIr.abilities.some(
				(a) =>
					a.kind === 'keyword' &&
					a.keyword.name === 'partner' &&
					a.keyword.param === 'with Toothy, Imaginary Friend'
			)
		);

		const lands98: DeckCardEntry[] = [{ card: staple('Command Tower'), quantity: 1 }, { card: staple('Island'), quantity: 97 }];
		const lands99: DeckCardEntry[] = [{ card: staple('Island'), quantity: 99 }];

		const validRes = validateCommanderDeck([tymna, thrasios], lands98);
		assert.equal(validRes.isLegal, true);
		assert.deepEqual(validRes.colorIdentity, ['W', 'U', 'B', 'G']);
		assert.equal(validRes.totalCards, 100);

		// Red card fails WUBG combined color identity:
		const redMain: DeckCardEntry[] = [{ card: staple('Rift Bolt'), quantity: 1 }, { card: staple('Island'), quantity: 97 }];
		assert.equal(validateCommanderDeck([tymna, thrasios], redMain).isLegal, false);

		// 99 mainboard + 2 partners = 101 cards rejected:
		assert.equal(validateCommanderDeck([tymna, thrasios], lands99).isLegal, false);

		// Duplicate identical Partner commander rejected:
		assert.equal(validateCommanderDeck([thrasios, thrasios], lands98).isLegal, false);

		// Partner with [Name] exact pair valid; mismatched with generic Partner rejected:
		assert.equal(validateCommanderDeck([pir, toothy], lands98).isLegal, true);
		assert.equal(validateCommanderDeck([pir, thrasios], lands98).isLegal, false);

		// Prose mentioning the word "partner" must NOT validate as Partner:
		assert.equal(validateCommanderDeck([tymna, fakePartnerProse], lands98).isLegal, false);

		// Changeling Time Lord Doctor has extra creature types -> cannot pair with Doctor's companion (CR 702.124m):
		assert.equal(validateCommanderDeck([changelingDoctor, companion], lands98).isLegal, false);
	});

	it('Partner runtime gameplay (CR 702.124d–e, 903.8, 903.10a): combines color identity for Arcane Signet, tracks Commander Tax separately per Partner, and tracks 21 Commander combat damage separately per Partner', () => {
		const partnerA = syntheticCard({
			name: 'Akiri, Line-Slinger',
			manaCost: '{R}{W}',
			cmc: 2,
			typeLine: 'Legendary Creature — Kor Soldier',
			oracleText: 'First strike, vigilance\nPartner',
			colors: ['R', 'W'],
			colorIdentity: ['R', 'W'],
			keywords: ['First strike', 'Vigilance', 'Partner'],
			canBeCommander: true,
			hasPartner: true,
			power: '15',
			toughness: '3'
		});
		const partnerB = syntheticCard({
			name: 'Silas Renn, Seeker Adept',
			manaCost: '{1}{U}{B}',
			cmc: 3,
			typeLine: 'Legendary Artifact Creature — Human',
			oracleText: 'Deathtouch\nPartner',
			colors: ['U', 'B'],
			colorIdentity: ['U', 'B'],
			keywords: ['Deathtouch', 'Partner'],
			canBeCommander: true,
			hasPartner: true,
			power: '10',
			toughness: '2'
		});

		const { state, p1, p2 } = makeGame({ p1Commanders: [partnerA, partnerB] });
		assert.equal(p1.command.length, 2, 'Both Partner commanders start in the command zone');
		const cmdA = p1.command.find((c) => c.card.name === 'Akiri, Line-Slinger')!;
		const cmdB = p1.command.find((c) => c.card.name === 'Silas Renn, Seeker Adept')!;

		// 1. Combined color identity across both Partners = W, U, B, R (not G):
		assert.deepEqual(new Set(getPlayerCommanderIdentity(p1)), new Set(['W', 'U', 'B', 'R']));
		const signet = putInZone(state, p1, staple('Arcane Signet'), 'battlefield');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: signet.instanceId,
				abilityId: 'mana_tap'
			}).ok,
			true
		);
		const colorPrompt = state.pendingPrompts[0];
		assert.ok(colorPrompt && colorPrompt.choice?.kind === 'chooseMode');
		const colorChoice = colorPrompt.choice;
		assert.deepEqual(
			new Set(colorChoice.modes),
			new Set(['W', 'U', 'B', 'R']),
			'Arcane Signet offers all 4 colors from both Partner commanders'
		);
		applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: colorPrompt.id,
			answer: { kind: 'chooseMode', indices: [colorChoice.modes.indexOf('R')] }
		});
		assert.equal(p1.manaPool.R, 1);

		// 2. Casting Partner A increments ONLY Partner A's tax (+{2}), leaving Partner B at {0} tax!
		p1.manaPool.W = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cmdA.instanceId,
				fromZone: 'command'
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.commanderCastCounts[cmdA.instanceId], 1);
		assert.equal(p1.commanderCastCounts[cmdB.instanceId], 0);

		// Cast Partner B for its exact printed cost {1}{U}{B} (0 tax!):
		p1.manaPool = { W: 0, U: 1, B: 1, R: 0, G: 0, C: 1 };
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: cmdB.instanceId,
				fromZone: 'command'
			}).ok,
			true,
			'Partner B has 0 commander tax even though Partner A was already cast once'
		);
		resolveAllStack(state);

		// 3. Separate 21 Commander combat damage tracking (CR 903.10a):
		// Partner A (15 power) + Partner B (10 power) = 25 total combat damage, neither >= 21 -> P2 survives at 15 life!
		const akiriOnBoard = p1.battlefield.find((c) => c.instanceId === cmdA.instanceId)!;
		const silasOnBoard = p1.battlefield.find((c) => c.instanceId === cmdB.instanceId)!;
		akiriOnBoard.summoningSick = false;
		silasOnBoard.summoningSick = false;

		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' }); // begin_combat
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' }); // declare_attackers
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'declare_attackers',
				assignments: [
					{ attackerInstanceId: akiriOnBoard.instanceId, defenderPlayerId: p2.playerId },
					{ attackerInstanceId: silasOnBoard.instanceId, defenderPlayerId: p2.playerId }
				]
			}).ok,
			true
		);
		applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		applyGameAction(state, p2.playerId, { type: 'pass_priority' }); // declare_blockers
		applyGameAction(state, p2.playerId, { type: 'declare_blockers', assignments: [] });
		// Pass through first_strike_damage (Akiri has First strike = 15) and combat_damage (Silas = 10):
		for (let guard = 0; guard < 12 && state.phase !== 'main2'; guard++) {
			applyGameAction(state, state.players[state.priorityPlayerIndex].playerId, { type: 'pass_priority' });
		}
		assert.equal(p2.commanderDamageTaken[akiriOnBoard.instanceId], 15);
		assert.equal(p2.commanderDamageTaken[silasOnBoard.instanceId], 10);
		assert.equal(p2.life, 15);
		assert.equal(p2.lost, false, 'CR 903.10a: 15 + 10 across two different Partner commanders does NOT trigger 21-damage loss');
	});

	it('Partner with [Name] compiles its ETB search trigger directly to IR and claims full support (CR 702.124j)', () => {
		const card = syntheticCard({
			name: 'Velk Ardent',
			typeLine: 'Legendary Creature — Elf Druid',
			oracleText: 'Partner with Mira Coilbright',
			canBeCommander: true,
			hasPartner: true,
			power: '2',
			toughness: '2'
		});
		const def = compileCard(card);
		const abilities = def.faces[0].abilities;
		assert.ok(
			abilities.some((a) => a.kind === 'keyword' && a.keyword.name === 'partner' && a.keyword.param === 'with Mira Coilbright'),
			'the pairing half stays a partner keyword for deck construction'
		);
		const triggered = abilities.find((a) => a.kind === 'triggered');
		assert.ok(triggered && triggered.kind === 'triggered', 'the search half compiles to a triggered ability');
		assert.deepEqual(triggered.trigger, { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } });
		assert.equal(triggered.targets?.[0]?.kind, 'player');
		assert.equal(triggered.effect[0]?.verb, 'search');
		assert.equal(triggered.effect[0]?.params?.search?.filter.named, 'Mira Coilbright');
		assert.deepEqual(triggered.effect[0]?.optional, { chooser: { k: 'target', index: 0 } });
		assert.equal(def.fullySupported, true);
		assert.equal(abilities.some((a) => a.kind === 'unsupported'), false);
		// Generic Partner is a single ability and stays fully supported.
		assert.equal(compileCard(syntheticCard({ name: 'Orla Vantry', typeLine: 'Legendary Creature — Human', oracleText: 'Partner', canBeCommander: true, hasPartner: true, power: '1', toughness: '1' })).fullySupported, true);
	});

	it('Partner—[text] pairs only with the same partner—[text] ability (CR 702.124f, 702.124i)', () => {
		const partnerCard = (name: string, oracleText: string) =>
			syntheticCard({ name, typeLine: 'Legendary Creature — Human', oracleText, canBeCommander: true, hasPartner: true, keywords: ['Partner'], power: '1', toughness: '1' });
		const survivorA = partnerCard('Ilsa Grent', 'Partner—Survivors (You can have two commanders if both have this ability.)');
		const survivorB = partnerCard('Doran Vesk', 'Partner—Survivors (You can have two commanders if both have this ability.)');
		const fatherSon = partnerCard('Kael Ostrow', 'Partner—Father & son (You can have two commanders if both have this ability.)');
		const generic = partnerCard('Tamsin Rook', 'Partner');
		const pairingError = (a: ScryfallCard, b: ScryfallCard) =>
			validateCommanderDeck([a, b], []).errors.some((e) => /pairing/i.test(e));
		assert.equal(pairingError(survivorA, survivorB), false, 'the same partner—[text] ability pairs');
		assert.equal(pairingError(survivorA, generic), true, 'partner—[text] does not combine with generic partner');
		assert.equal(pairingError(survivorA, fatherSon), true, 'different partner—[text] abilities do not combine');
	});

	it('Partner with [Name] ETB trigger (CR 702.124j): when a "Partner with [Name]" permanent enters, target player may search their library for [Name], reveal it, put it into their hand, then shuffle', () => {
		const velkCard = syntheticCard({
			name: 'Velk Ardent',
			typeLine: 'Legendary Creature — Elf Druid',
			oracleText: 'Partner with Mira Coilbright',
			canBeCommander: true,
			hasPartner: true,
			manaCost: '{0}',
			cmc: 0,
			power: '2',
			toughness: '2'
		});
		const miraCard = syntheticCard({
			name: 'Mira Coilbright',
			typeLine: 'Legendary Creature — Human Artificer',
			oracleText: 'Partner with Velk Ardent',
			canBeCommander: true,
			hasPartner: true,
			manaCost: '{0}',
			cmc: 0,
			power: '2',
			toughness: '2'
		});

		const resolveSpellAndTarget = (state: GameState, p1Id: string, p2Id: string, targetId: string) => {
			assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
			const tgtPrompt = state.pendingPrompts.find((pr) => pr.purpose === 'trigger_targets');
			assert.ok(tgtPrompt, 'controller is prompted to choose target player for Partner with');
			assert.equal(
				applyGameAction(state, p1Id, {
					type: 'choice',
					promptId: tgtPrompt!.id,
					answer: { kind: 'chooseObjects', objectIds: [targetId] }
				}).ok,
				true
			);
			assert.equal(applyGameAction(state, p1Id, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2Id, { type: 'pass_priority' }).ok, true);
		};

		// 1. Accept targeting self, survive JSON round-trip, find named partner into hand.
		{
			let { state, p1, p2 } = makeGame();
			const velk = putInZone(state, p1, velkCard, 'hand');
			const miraInLib = putInZone(state, p1, miraCard, 'library');
			const handBefore = p1.hand.length - 1;
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: velk.instanceId }).ok, true);
			resolveSpellAndTarget(state, p1.playerId, p2.playerId, p1.playerId);

			const mayPrompt = state.pendingPrompts[0];
			assert.ok(mayPrompt && mayPrompt.choice?.kind === 'yesNo', 'asks target player yes/no before searching');
			assert.equal(mayPrompt.playerId, p1.playerId);
			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			const searchPrompt = state.pendingPrompts.find((pr) => pr.kind === 'search_library');
			assert.ok(searchPrompt, 'opens search_library prompt after accepting');
			assert.deepEqual(searchPrompt!.candidateInstanceIds, [miraInLib.instanceId]);
			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [miraInLib.instanceId] }
				}).ok,
				true
			);
			assert.equal(state.stack.length, 0);
			assert.equal(state.players[0].hand.length, handBefore + 1);
			assert.ok(state.players[0].hand.some((c) => c.instanceId === miraInLib.instanceId));
		}

		// 2. Target opponent: prompt goes to opponent; declining skips search AND does NOT shuffle!
		{
			let { state, p1, p2 } = makeGame();
			const velk = putInZone(state, p1, velkCard, 'hand');
			putInZone(state, p2, miraCard, 'library');
			const libOrderBefore = p2.library.map((c) => c.instanceId);
			const rngBefore = state.rngState;
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: velk.instanceId }).ok, true);
			resolveSpellAndTarget(state, p1.playerId, p2.playerId, p2.playerId);

			const mayPrompt = state.pendingPrompts[0];
			assert.ok(mayPrompt && mayPrompt.choice?.kind === 'yesNo');
			assert.equal(mayPrompt.playerId, p2.playerId, 'target opponent decides whether to search');
			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'yesNo', yes: false }
				}).ok,
				true
			);
			assert.equal(state.pendingPrompts.length, 0, 'declining ends immediately without opening search_library');
			assert.equal(state.stack.length, 0);
			assert.deepEqual(state.players[1].library.map((c) => c.instanceId), libOrderBefore, 'declining does NOT shuffle library');
			assert.equal(state.rngState, rngBefore, 'rngState untouched when library not shuffled');
		}
	});
});

// ============================================================================
// 5. FLASHBACK (CR 702.34)
// ============================================================================

describe('Keyword: Flashback (CR 702.34)', () => {
	const thinkTwiceCard = syntheticCard({
		name: 'Think Twice',
		manaCost: '{1}{U}',
		cmc: 2,
		typeLine: 'Instant',
		oracleText:
			'Draw a card.\nFlashback {2}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
		colors: ['U'],
		colorIdentity: ['U'],
		keywords: ['Flashback']
	});

	const faithlessLootingCard = syntheticCard({
		name: 'Faithless Looting',
		manaCost: '{R}',
		cmc: 1,
		typeLine: 'Sorcery',
		oracleText:
			'Draw two cards, then discard two cards.\nFlashback {2}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
		colors: ['R'],
		colorIdentity: ['R'],
		keywords: ['Flashback']
	});

	const deepAnalysisCard = syntheticCard({
		name: 'Deep Analysis',
		manaCost: '{3}{U}',
		cmc: 4,
		typeLine: 'Sorcery',
		oracleText:
			'Target player draws two cards.\nFlashback—{1}{U}, Pay 3 life. (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
		colors: ['U'],
		colorIdentity: ['U'],
		keywords: ['Flashback']
	});

	const dreadReturnVariant = syntheticCard({
		name: 'Glimmerfen Reckoning',
		manaCost: '{2}{B}',
		cmc: 3,
		typeLine: 'Sorcery',
		oracleText:
			'Draw a card.\nFlashback—Pay 3 life.\n',
		colors: ['B'],
		colorIdentity: ['B'],
		keywords: ['Flashback']
	});

	const compositeSacCard = syntheticCard({
		name: 'Glimmerfen Offering',
		manaCost: '{3}{B}',
		cmc: 4,
		typeLine: 'Sorcery',
		oracleText:
			'Draw two cards.\nFlashback—{1}{B}, Sacrifice a creature.',
		colors: ['B'],
		colorIdentity: ['B'],
		keywords: ['Flashback']
	});

	it('Flashback compile: parses mana, non-mana, composite dash costs, emits unsupported for unparsed costs, and satisfies rename invariance', () => {
		const ttIr = compileCard(thinkTwiceCard).faces[0];
		const ttKw = ttIr.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'flashback');
		assert.ok(ttKw && ttKw.kind === 'keyword');
		assert.equal(ttKw.keyword.cost, '{2}{U}');
		assert.deepEqual(ttKw.keyword.costDefs, [{ k: 'mana', cost: '{2}{U}' }]);
		assert.equal(ttIr.abilities.some((a) => a.kind === 'unsupported'), false);

		const daIr = compileCard(deepAnalysisCard).faces[0];
		const daKw = daIr.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'flashback');
		assert.ok(daKw && daKw.kind === 'keyword');
		assert.deepEqual(daKw.keyword.costDefs, [
			{ k: 'mana', cost: '{1}{U}' },
			{ k: 'payLife', amount: { k: 'const', n: 3 } }
		]);
		assert.equal(daIr.abilities.some((a) => a.kind === 'unsupported'), false);

		const lifeIr = compileCard(dreadReturnVariant).faces[0];
		const lifeKw = lifeIr.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'flashback');
		assert.ok(lifeKw && lifeKw.kind === 'keyword');
		assert.equal(lifeKw.keyword.cost, undefined);
		assert.deepEqual(lifeKw.keyword.costDefs, [{ k: 'payLife', amount: { k: 'const', n: 3 } }]);
		assert.equal(lifeIr.abilities.some((a) => a.kind === 'unsupported'), false);

		const sacIr = compileCard(compositeSacCard).faces[0];
		const sacKw = sacIr.abilities.find((a) => a.kind === 'keyword' && a.keyword.name === 'flashback');
		assert.ok(sacKw && sacKw.kind === 'keyword');
		assert.deepEqual(sacKw.keyword.costDefs, [
			{ k: 'mana', cost: '{1}{B}' },
			{ k: 'sacrifice', count: { k: 'const', n: 1 }, filter: { controller: 'you', types: ['Creature'] } }
		]);
		assert.equal(sacIr.abilities.some((a) => a.kind === 'unsupported'), false);

		// Unparseable Flashback cost must emit unsupported('unparsed'), not silently drop.
		const unparseable = syntheticCard({
			name: 'Kindle Variant',
			manaCost: '{2}{R}',
			cmc: 3,
			typeLine: 'Sorcery',
			oracleText: 'Draw a card.\nFlashback—{1}{R}, Behold three Elementals.',
			colors: ['R'],
			colorIdentity: ['R'],
			keywords: ['Flashback']
		});
		const unpIr = compileCard(unparseable).faces[0];
		assert.ok(
			unpIr.abilities.some((a) => a.kind === 'unsupported' && a.reason === 'unparsed'),
			'unparseable Flashback cost must compile to unsupported(unparsed)'
		);

		// Rename invariance: synthetic name compiles to identical abilities.
		const renamed = syntheticCard({
			...thinkTwiceCard,
			name: 'Glimmerfen Study',
			id: 'syn_glimmerfen_study'
		});
		assert.deepEqual(compileCard(renamed).faces[0].abilities, ttIr.abilities);
	});

	it('getCastOptions (CR 702.34a): returns alt:flashback in own graveyard for Instant/Sorcery only, never in hand or opponent graveyard', () => {
		const { state, p1, p2 } = makeGame();
		p1.manaPool.U = 5;
		p1.manaPool.C = 5;

		const gyInstant = putInZone(state, p1, thinkTwiceCard, 'graveyard');
		const handInstant = putInZone(state, p1, thinkTwiceCard, 'hand');
		const oppGyInstant = putInZone(state, p2, thinkTwiceCard, 'graveyard');
		const gyCreature = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Glimmerfen Shade',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Shade',
				oracleText: 'Flashback {2}{B}',
				power: '2',
				toughness: '2'
			}),
			'graveyard'
		);

		const gyOpts = getCastOptions(state, p1.playerId, gyInstant, 'graveyard');
		assert.equal(gyOpts.length, 1);
		assert.equal(gyOpts[0].id, 'alt:flashback');
		assert.equal(gyOpts[0].fromZone, 'graveyard');
		assert.equal(gyOpts[0].spellMods.exileOnLeaveStack, true);
		assert.equal(gyOpts[0].costDisplay, '{2}{U}');

		const handOpts = getCastOptions(state, p1.playerId, handInstant, 'hand');
		assert.deepEqual(
			handOpts.map((o) => o.id),
			['normal']
		);

		assert.deepEqual(getCastOptions(state, p1.playerId, oppGyInstant, 'graveyard'), []);
		assert.deepEqual(getCastOptions(state, p1.playerId, gyCreature, 'graveyard'), []);
	});

	it('Flashback runtime (CR 702.34a): casts from graveyard, resolves to exile, and works identically with synthetic renamed card', () => {
		for (const cardDef of [
			thinkTwiceCard,
			syntheticCard({ ...thinkTwiceCard, name: 'Glimmerfen Recall', id: 'syn_glimmerfen_recall' })
		]) {
			const { state, p1 } = makeGame();
			p1.library = [];
			const libCard = putInZone(state, p1, staple('Island'), 'library');
			const fbSpell = putInZone(state, p1, cardDef, 'graveyard');
			p1.manaPool.U = 1;
			p1.manaPool.C = 2;

			const res = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fbSpell.instanceId,
				fromZone: 'graveyard',
				optionId: 'alt:flashback'
			});
			assert.equal(res.ok, true);
			assert.equal(p1.manaPool.U, 0);
			assert.equal(p1.manaPool.C, 0);
			assert.equal(p1.graveyard.length, 0);
			assert.equal(state.stack.length, 1);
			assert.equal(state.stack[0].castOptionId, 'alt:flashback');
			assert.equal(state.stack[0].spellMods?.exileOnLeaveStack, true);

			resolveAllStack(state);
			assert.equal(state.stack.length, 0);
			assert.ok(p1.hand.some((c) => c.instanceId === libCard.instanceId), 'spell effect drew a card');
			assert.equal(p1.graveyard.length, 0, 'Flashback spell must NOT return to graveyard');
			assert.ok(
				p1.exile.some((c) => c.instanceId === fbSpell.instanceId),
				'Flashback spell must be exiled on resolution (CR 702.34a)'
			);
		}
	});

	it('Flashback stack-exit exile (CR 702.34a): exiles instead of graveyard when countered, fizzled (CR 608.2b), or Ward-countered', () => {
		// 1. Countered by Counterspell
		{
			const { state, p1, p2 } = makeGame();
			const fb = putInZone(state, p1, thinkTwiceCard, 'graveyard');
			const cs = putInZone(state, p2, staple('Counterspell'), 'hand');
			p1.manaPool.U = 1;
			p1.manaPool.C = 2;
			p2.manaPool.U = 2;

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: fb.instanceId,
					optionId: 'alt:flashback'
				}).ok,
				true
			);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: cs.instanceId,
					targets: [{ kind: 'stack', id: state.stack[0].id, label: fb.card.name }]
				}).ok,
				true
			);
			resolveAllStack(state);
			assert.equal(state.stack.length, 0);
			assert.equal(p1.graveyard.some((c) => c.instanceId === fb.instanceId), false);
			assert.equal(p1.exile.some((c) => c.instanceId === fb.instanceId), true);
		}

		// 2. Fizzled on resolution (CR 608.2b: all targets illegal)
		{
			const { state, p1, p2 } = makeGame();
			const boltFb = syntheticCard({
				name: 'Glimmerfen Spark',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Glimmerfen Spark deals 3 damage to target creature.\nFlashback {1}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Flashback']
			});
			const targetBear = putInZone(
				state,
				p2,
				syntheticCard({
					name: 'Grizzly Bears',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const fb = putInZone(state, p1, boltFb, 'graveyard');
			p1.manaPool.R = 1;
			p1.manaPool.C = 1;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: fb.instanceId,
					optionId: 'alt:flashback',
					targets: [{ kind: 'permanent', id: targetBear.instanceId, label: 'Grizzly Bears' }]
				}).ok,
				true
			);
			// Remove target before resolution so CR 608.2b counters it on resolution.
			p2.battlefield = p2.battlefield.filter((c) => c.instanceId !== targetBear.instanceId);
			resolveAllStack(state);
			assert.equal(state.stack.length, 0);
			assert.equal(p1.graveyard.some((c) => c.instanceId === fb.instanceId), false);
			assert.equal(p1.exile.some((c) => c.instanceId === fb.instanceId), true);
		}

		// 3. Countered by Ward (CR 702.21a)
		{
			const { state, p1, p2 } = makeGame();
			const targetedFb = syntheticCard({
				name: 'Glimmerfen Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Glimmerfen Bolt deals 2 damage to target creature.\nFlashback {1}{R}',
				colors: ['R'],
				colorIdentity: ['R'],
				keywords: ['Flashback']
			});
			const wardDrake = putInZone(
				state,
				p2,
				syntheticCard({
					name: 'Ward Drake',
					manaCost: '{2}{U}',
					cmc: 3,
					typeLine: 'Creature — Drake',
					oracleText: 'Ward {3}',
					power: '2',
					toughness: '2',
					keywords: ['Ward']
				}),
				'battlefield'
			);
			const fb = putInZone(state, p1, targetedFb, 'graveyard');
			p1.manaPool.R = 1;
			p1.manaPool.C = 1;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: fb.instanceId,
					optionId: 'alt:flashback',
					targets: [{ kind: 'permanent', id: wardDrake.instanceId, label: 'Ward Drake' }]
				}).ok,
				true
			);
			// Ward trigger goes on stack; p1 cannot pay {3}, so resolve Ward trigger and decline/fail payment.
			resolveAllStack(state);
			assert.equal(state.stack.length, 0);
			assert.equal(p1.graveyard.some((c) => c.instanceId === fb.instanceId), false);
			assert.equal(p1.exile.some((c) => c.instanceId === fb.instanceId), true);
		}
	});

	it('Flashback non-mana and composite costs (CR 118.9): pays life / sacrifices creature (including mid-payment replacement pause) and exiles on resolution', () => {
		// 1. Pure non-mana Flashback—Pay 3 life.
		{
			const { state, p1 } = makeGame();
			p1.library = [];
			const drawn = putInZone(state, p1, staple('Swamp'), 'library');
			const fb = putInZone(state, p1, dreadReturnVariant, 'graveyard');
			const startLife = p1.life;

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: fb.instanceId,
					optionId: 'alt:flashback'
				}).ok,
				true
			);
			assert.equal(p1.life, startLife - 3);
			resolveAllStack(state);
			assert.ok(p1.hand.some((c) => c.instanceId === drawn.instanceId));
			assert.ok(p1.exile.some((c) => c.instanceId === fb.instanceId));
		}

		// 2. Composite Flashback—{1}{B}, Sacrifice a creature. with competing CR 616.1 replacement pause mid-payment
		{
			let { state, p1 } = makeGame();
			p1.library = [];
			putInZone(state, p1, staple('Swamp'), 'library');
			putInZone(state, p1, staple('Island'), 'library');
			const bear = putInZone(
				state,
				p1,
				syntheticCard({
					name: 'Wandering Bear',
					manaCost: '{1}{G}',
					cmc: 2,
					typeLine: 'Creature — Bear',
					oracleText:
						"If ~ would be put into a graveyard from anywhere, exile it instead.\nIf ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead.",
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const fb = putInZone(state, p1, compositeSacCard, 'graveyard');
			p1.manaPool.B = 1;
			p1.manaPool.C = 1;

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: fb.instanceId,
					optionId: 'alt:flashback'
				}).ok,
				true
			);
			assert.ok(state.pendingCostPayment, 'pauses mid-payment on replacement choice');
			assert.equal(p1.manaPool.B, 0);
			assert.equal(p1.manaPool.C, 0);
			const replPrompt = state.pendingPrompts.find((pr) => pr.kind === 'chooseReplacement');
			assert.ok(replPrompt && replPrompt.choice?.kind === 'chooseReplacement');
			const exileOpt = replPrompt!.choice.options.find((o) => /exile/i.test(o.label));
			assert.ok(exileOpt);
			state = JSON.parse(JSON.stringify(state)) as GameState;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseReplacement', id: exileOpt!.id }
				}).ok,
				true
			);
			p1 = state.players[0];
			assert.equal(state.pendingCostPayment, undefined);
			assert.equal(p1.battlefield.some((c) => c.instanceId === bear.instanceId), false);
			assert.equal(p1.exile.some((c) => c.instanceId === bear.instanceId), true);
			assert.equal(state.stack.length, 1);

			resolveAllStack(state);
			assert.equal(p1.hand.length, 2);
			assert.ok(p1.exile.some((c) => c.instanceId === fb.instanceId));
		}
	});

	it('Flashback cost modifiers & printed MV (CR 118.9c–d): reductions/increases apply to Flashback cost while stack MV stays printed', () => {
		const { state, p1, p2 } = makeGame();
		putInZone(state, p1, staple('Island'), 'library');
		putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Goblin Electromancer',
				manaCost: '{U}{R}',
				cmc: 2,
				typeLine: 'Creature — Goblin Wizard',
				oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Thalia, Guardian of Thraben',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Legendary Creature — Human Soldier',
				oracleText: 'First strike\nNoncreature spells cost {1} more to cast.',
				power: '2',
				toughness: '1',
				keywords: ['First strike']
			}),
			'battlefield'
		);

		// 1. Mana Flashback {2}{U} - {1} + {1} = {2}{U}, stack MV remains printed (2).
		const fb1 = putInZone(state, p1, thinkTwiceCard, 'graveyard');
		p1.manaPool.U = 1;
		p1.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fb1.instanceId,
				optionId: 'alt:flashback'
			}).ok,
			true
		);
		assert.equal(p1.manaPool.U, 0);
		assert.equal(p1.manaPool.C, 0);
		assert.equal(state.stack[0].card.cmc, 2, 'CR 118.9c: printed MV unchanged');
		assert.equal(objectManaValue(state, fb1), 2, 'CR 118.9c: objectManaValue unchanged');
		resolveAllStack(state);

		// 2. Non-mana Flashback—Pay 3 life. with Electromancer (-1) + Thalia (+1) -> net {0} mana,
		//    and with only Thalia (+1) -> requires {1} mana + 3 life!
		p1.battlefield = []; // remove Electromancer; Thalia stays on p2's board
		const fb2 = putInZone(state, p1, dreadReturnVariant, 'graveyard');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fb2.instanceId,
				optionId: 'alt:flashback'
			}).ok,
			false,
			'Thalia {1} tax applies to non-mana Flashback cost (CR 118.9d)'
		);
		p1.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fb2.instanceId,
				optionId: 'alt:flashback'
			}).ok,
			true
		);
		assert.equal(p1.manaPool.C, 0);
		assert.equal(state.stack[0].card.cmc, 3, 'CR 118.9c: printed MV remains 3');
		assert.equal(objectManaValue(state, fb2), 3, 'CR 118.9c: objectManaValue remains 3');
	});

	it('Flashback timing (CR 601.3): Sorcery Flashback requires main phase + empty stack unless granted Flash; Instant Flashback works at instant speed', () => {
		const { state, p1, p2 } = makeGame();
		const sorcFb = putInZone(state, p1, faithlessLootingCard, 'graveyard');
		const instFb = putInZone(state, p1, thinkTwiceCard, 'graveyard');
		p1.manaPool.R = 1;
		p1.manaPool.U = 1;
		p1.manaPool.C = 4;

		// Opponent's turn: Sorcery Flashback illegal, Instant Flashback legal!
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorcFb.instanceId,
				optionId: 'alt:flashback'
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: instFb.instanceId,
				optionId: 'alt:flashback'
			}).ok,
			true
		);

		// With another spell on the stack, Sorcery Flashback is still illegal without Flash,
		// but becomes legal once Vedalken Orrery grants Flash!
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorcFb.instanceId,
				optionId: 'alt:flashback'
			}).ok,
			false
		);
		putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Vedalken Orrery',
				manaCost: '{4}',
				cmc: 4,
				typeLine: 'Artifact',
				oracleText: 'You may cast spells as though they had flash.'
			}),
			'battlefield'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: sorcFb.instanceId,
				optionId: 'alt:flashback'
			}).ok,
			true
		);
	});

	it('Bot AI (ai.ts): casts playable Flashback card from graveyard and detects instant-speed graveyard responses', () => {
		const { state, p1, p2 } = makeGame({ p1Bot: true });
		putInZone(state, p1, staple('Island'), 'library');
		const instFb = putInZone(state, p1, thinkTwiceCard, 'graveyard');
		p1.manaPool.U = 1;
		p1.manaPool.C = 2;

		assert.equal(hasAnyLegalInstantResponse(state, p1), true);
		const step = executeBotStep(state, p1, p1);
		assert.equal(step, 'visible');
		assert.equal(state.stack.length, 1);
		assert.equal(state.stack[0].sourceInstanceId, instFb.instanceId);
		assert.equal(state.stack[0].castOptionId, 'alt:flashback');

		resolveAllStack(state);
		assert.equal(p1.exile.some((c) => c.instanceId === instFb.instanceId), true);
		assert.equal(hasAnyLegalInstantResponse(state, p1), false);
	});

	it('Keyword-blind UI and AI: zero overload/flashback string literals in ArenaTable.svelte and ai.ts', () => {
		const magicDir = path.resolve(process.cwd(), 'src/lib/magic');
		for (const file of ['ArenaTable.svelte', 'ai.ts']) {
			const src = fs.readFileSync(path.join(magicDir, file), 'utf8');
			assert.equal(
				/\b(overload|flashback)\b/i.test(src),
				false,
				`${file} must contain zero overload/flashback literals`
			);
		}
	});
});

// ============================================================================
// 4. AFFINITY (CR 702.41)
// ============================================================================

describe('Keyword: Affinity (CR 702.41)', () => {
	it('reduces generic cost by matching permanents you control for artifacts, Plains, and outlaws (CR 702.41a)', () => {
		const { state, p1, p2 } = makeGame();

		// 1. Affinity for artifacts: {4}{U} with 3 artifacts controlled by p1 (and 1 opponent artifact ignored) -> costs {1}{U}
		const affSpell = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Thoughtcast Probe',
				manaCost: '{4}{U}',
				cmc: 5,
				typeLine: 'Sorcery',
				oracleText: 'Affinity for artifacts\nDraw two cards.'
			}),
			'hand'
		);
		// Make 3 distinct artifacts under p1's control and 1 under p2's control
		p1.battlefield = [];
		for (let i = 0; i < 3; i++) {
			putInZone(
				state,
				p1,
				syntheticCard({ name: `Artifact ${i}`, typeLine: 'Artifact', manaCost: '{0}', cmc: 0 }),
				'battlefield'
			);
		}
		putInZone(
			state,
			p2,
			syntheticCard({ name: 'Opponent Artifact', typeLine: 'Artifact', manaCost: '{0}', cmc: 0 }),
			'battlefield'
		);
		putInZone(state, p1, staple('Island'), 'library');
		putInZone(state, p1, staple('Island'), 'library');

		const req1 = getSpellCostRequirement(p1, affSpell, state, 0, 'normal');
		assert.equal(req1.generic, 1);
		assert.equal(req1.colored.U, 1);

		// Cannot pay if only {U} available
		p1.manaPool.U = 1;
		p1.manaPool.C = 0;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: affSpell.instanceId, optionId: 'normal' }).ok,
			false
		);

		// Can pay {1}{U}
		p1.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: affSpell.instanceId, optionId: 'normal' }).ok,
			true
		);
		assert.equal(p1.manaPool.U, 0);
		assert.equal(p1.manaPool.C, 0);
		resolveAllStack(state);

		// 2. Affinity for Plains & outlaws: check cost reduction and non-matching exclusion
		const affPlains = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Sunlit Golem',
				manaCost: '{5}{W}',
				cmc: 6,
				typeLine: 'Creature — Golem',
				power: '3',
				toughness: '3',
				oracleText: 'Affinity for Plains'
			}),
			'hand'
		);
		putInZone(state, p1, staple('Plains'), 'battlefield');
		putInZone(state, p1, staple('Plains'), 'battlefield');
		putInZone(state, p1, staple('Island'), 'battlefield');
		const reqPlains = getSpellCostRequirement(p1, affPlains, state, 0, 'normal');
		assert.equal(reqPlains.generic, 3);
		assert.equal(reqPlains.colored.W, 1);

		const affOutlaws = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Outlaw Ambush',
				manaCost: '{4}{B}',
				cmc: 5,
				typeLine: 'Creature — Rogue',
				power: '2',
				toughness: '2',
				oracleText: 'Affinity for outlaws'
			}),
			'hand'
		);
		putInZone(
			state,
			p1,
			syntheticCard({ name: 'Dockside Pirate', typeLine: 'Creature — Goblin Pirate', power: '1', toughness: '2' }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			syntheticCard({ name: 'City Assassin', typeLine: 'Creature — Human Assassin', power: '2', toughness: '1' }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			syntheticCard({ name: 'Non-Outlaw Soldier', typeLine: 'Creature — Human Soldier', power: '2', toughness: '2' }),
			'battlefield'
		);
		const reqOutlaws = getSpellCostRequirement(p1, affOutlaws, state, 0, 'normal');
		assert.equal(reqOutlaws.generic, 2);
		assert.equal(reqOutlaws.colored.B, 1);
	});

	it('stacks multiple affinity instances and preserves synthetic rename invariance (CR 702.41b)', () => {
		const { state, p1 } = makeGame();
		putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Artifact Creature Counted Twice',
				typeLine: 'Artifact Creature — Construct',
				power: '1',
				toughness: '1'
			}),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			syntheticCard({ name: 'Spare Artifact', typeLine: 'Artifact', manaCost: '{0}', cmc: 0 }),
			'battlefield'
		);

		const text = 'Affinity for artifacts\nAffinity for creatures';
		const cardA = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Double Affinity Alpha', manaCost: '{6}', cmc: 6, typeLine: 'Artifact', oracleText: text }),
			'hand'
		);
		const cardB = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Double Affinity Beta', manaCost: '{6}', cmc: 6, typeLine: 'Artifact', oracleText: text }),
			'hand'
		);

		// 2 artifacts + 1 creature = 3 generic reduction -> {3}
		assert.equal(getSpellCostRequirement(p1, cardA, state, 0, 'normal').generic, 3);
		assert.equal(getSpellCostRequirement(p1, cardB, state, 0, 'normal').generic, 3);
		p1.manaPool.C = 3;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: cardA.instanceId, optionId: 'normal' }).ok,
			true
		);
		assert.equal(p1.manaPool.C, 0);
	});
});

// ============================================================================
// 5. AFTERLIFE (CR 702.135)
// ============================================================================

describe('Keyword: Afterlife (CR 702.135)', () => {
	it('creates N 1/1 white and black Spirit tokens with flying when dying, stacks multiple instances, and skips exile (CR 702.135a–b)', () => {
		const { state, p1, p2 } = makeGame();

		// 1. Single Afterlife 2 creature dies to a destroy spell
		const cleric = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Syndicate Cleric',
				manaCost: '{2}{W}{B}',
				cmc: 4,
				typeLine: 'Creature — Human Cleric',
				power: '2',
				toughness: '2',
				oracleText: 'Afterlife 2'
			}),
			'battlefield'
		);
		const murder = putInZone(
			state,
			p2,
			syntheticCard({
				name: 'Murder Probe',
				manaCost: '{1}{B}{B}',
				cmc: 3,
				typeLine: 'Instant',
				oracleText: 'Destroy target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		p2.manaPool.B = 2;
		p2.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: murder.instanceId,
				optionId: 'normal',
				targets: [{ kind: 'permanent', id: cleric.instanceId, label: cleric.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);

		assert.equal(p1.graveyard.some((c) => c.instanceId === cleric.instanceId), true);
		const spirits = p1.battlefield.filter((c) => c.card.typeLine.includes('Spirit'));
		assert.equal(spirits.length, 2);
		for (const sp of spirits) {
			assert.deepEqual(sp.card.colors, ['W', 'B']);
			const ev = evaluatePermanent(state, sp);
			assert.equal(ev.power, 1);
			assert.equal(ev.toughness, 1);
			assert.equal(ev.activeKeywords.includes('Flying'), true);
		}

		// 2. Multiple instances stack (Afterlife 1 + Afterlife 2 = 3 tokens) and synthetic rename invariance
		p1.battlefield = [];
		const stacked = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Twice-Blessed Thrull',
				typeLine: 'Creature — Thrull',
				power: '1',
				toughness: '1',
				oracleText: 'Afterlife 1\nAfterlife 2'
			}),
			'battlefield'
		);
		const bolt = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Bolt Probe',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Bolt Probe deals 3 damage to target creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 0;
		p1.manaPool.R = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: bolt.instanceId,
				optionId: 'normal',
				targets: [{ kind: 'permanent', id: stacked.instanceId, label: stacked.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.battlefield.filter((c) => c.card.typeLine.includes('Spirit')).length, 3);

		// 3. Exiling instead of dying does NOT trigger Afterlife
		p1.battlefield = [];
		const exiledTarget = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Renamed Spirit Bearer',
				typeLine: 'Creature — Human Cleric',
				power: '2',
				toughness: '2',
				oracleText: 'Afterlife 2'
			}),
			'battlefield'
		);
		const exileSpell = putInZone(
			state,
			p1,
			syntheticCard({
				name: 'Exile Probe',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Sorcery',
				oracleText: 'Exile target creature.'
			}),
			'hand'
		);
		p1.manaPool.W = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: exileSpell.instanceId,
				optionId: 'normal',
				targets: [{ kind: 'permanent', id: exiledTarget.instanceId, label: exiledTarget.card.name }]
			}).ok,
			true
		);
		resolveAllStack(state);
		assert.equal(p1.exile.some((c) => c.instanceId === exiledTarget.instanceId), true);
		assert.equal(p1.battlefield.length, 0);
	});
});

// ============================================================================
// 6. EXPLOIT (CR 702.110)
// ============================================================================

describe('Keyword: Exploit (CR 702.110)', () => {
	function passUntilPrompt(st: GameState, maxSteps = 20): void {
		for (let i = 0; i < maxSteps && st.stack.length > 0 && st.pendingPrompts.length === 0; i++) {
			const prio = st.players[st.priorityPlayerIndex];
			assert.equal(applyGameAction(st, prio.playerId, { type: 'pass_priority' }).ok, true);
		}
	}

	it('prompts on ETB to optionally sacrifice a creature: accept with 1, choose among 2+, decline, and bot decline (CR 702.110a)', () => {
		// 1. Human accepts with 2 creatures -> chooses other creature to sacrifice
		const { state, p1 } = makeGame();
		const fodder = putInZone(
			state,
			p1,
			syntheticCard({ name: 'Dutiful Attendant', typeLine: 'Creature — Human', power: '1', toughness: '2' }),
			'battlefield'
		);
		const exploiterCard = syntheticCard({
			name: 'Sidisi Probe',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Creature — Zombie Wizard',
			power: '3',
			toughness: '3',
			oracleText: 'Exploit'
		});
		const exploiterHand = putInZone(state, p1, exploiterCard, 'hand');
		p1.manaPool.C = 1;
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: exploiterHand.instanceId, optionId: 'normal' }).ok,
			true
		);
		// Resolve spell -> ETB Exploit trigger on stack -> resolve trigger up to trigger_may prompt
		passUntilPrompt(state);
		assert.equal(state.pendingPrompts[0]?.purpose, 'trigger_may');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(state.pendingPrompts[0]?.choice?.kind, 'chooseObjects');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: state.pendingPrompts[0].id,
				answer: { kind: 'chooseObjects', objectIds: [fodder.instanceId] }
			}).ok,
			true
		);
		assert.equal(p1.graveyard.some((c) => c.instanceId === fodder.instanceId), true);
		assert.equal(p1.battlefield.some((c) => c.instanceId === exploiterHand.instanceId), true);

		// 2. Human declines optional sacrifice (also using a synthetic renamed Exploit card)
		const { state: s2, p1: p1b } = makeGame();
		const renamedExploit = putInZone(
			s2,
			p1b,
			syntheticCard({ ...exploiterCard, name: 'Mirrored Exploiter' }),
			'hand'
		);
		p1b.manaPool.C = 1;
		assert.equal(
			applyGameAction(s2, p1b.playerId, { type: 'cast_spell', instanceId: renamedExploit.instanceId, optionId: 'normal' }).ok,
			true
		);
		passUntilPrompt(s2);
		assert.equal(s2.pendingPrompts[0]?.purpose, 'trigger_may');
		assert.equal(
			applyGameAction(s2, p1b.playerId, {
				type: 'choice',
				promptId: s2.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: false }
			}).ok,
			true
		);
		assert.equal(p1b.battlefield.some((c) => c.instanceId === renamedExploit.instanceId), true);
		assert.equal(p1b.graveyard.length, 0);

		// 3. Human accepts with only the exploiter itself -> auto-sacrifices itself
		const { state: s3, p1: p1c } = makeGame();
		const solo = putInZone(s3, p1c, exploiterCard, 'hand');
		p1c.manaPool.C = 1;
		assert.equal(
			applyGameAction(s3, p1c.playerId, { type: 'cast_spell', instanceId: solo.instanceId, optionId: 'normal' }).ok,
			true
		);
		passUntilPrompt(s3);
		assert.equal(s3.pendingPrompts[0]?.purpose, 'trigger_may');
		assert.equal(
			applyGameAction(s3, p1c.playerId, {
				type: 'choice',
				promptId: s3.pendingPrompts[0].id,
				answer: { kind: 'yesNo', yes: true }
			}).ok,
			true
		);
		assert.equal(p1c.graveyard.some((c) => c.instanceId === solo.instanceId), true);
		assert.equal(p1c.battlefield.length, 0);

		// 4. Bot controller auto-declines optional sacrifice
		const { state: s4, p1: p1Bot } = makeGame({ p1Bot: true });
		const botSolo = putInZone(s4, p1Bot, exploiterCard, 'hand');
		p1Bot.manaPool.C = 1;
		assert.equal(
			applyGameAction(s4, p1Bot.playerId, { type: 'cast_spell', instanceId: botSolo.instanceId, optionId: 'normal' }).ok,
			true
		);
		passUntilPrompt(s4);
		assert.equal(s4.pendingPrompts.length, 0);
		assert.equal(p1Bot.battlefield.some((c) => c.instanceId === botSolo.instanceId), true);
	});

	it('Kicker and Multikicker: validates optionalCostCounts, unifies mana reductions, enforces CR 702.33g targets, triggers intervening-if, and resets on CR 400.7 zone leave', () => {
		const { state, p1, p2 } = makeGame();

		// 1. Spell with conditional target + mana reduction applied once to combined cost (CR 601.2f, 702.33g)
		const reducer = syntheticCard({
			name: 'Prism Discounter',
			typeLine: 'Creature — Wizard',
			power: '1',
			toughness: '1',
			oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.'
		});
		putInZone(state, p1, reducer, 'battlefield');

		const kickedShatter = syntheticCard({
			name: 'Arcane Surge',
			manaCost: '{1}{U}',
			cmc: 2,
			typeLine: 'Instant',
			oracleText: 'Kicker {2}{R}\nDraw a card.\nIf Arcane Surge was kicked, destroy target artifact.'
		});
		const oppSolRing = putInZone(
			state,
			p2,
			syntheticCard({ name: 'Opp Relic', manaCost: '{1}', typeLine: 'Artifact' }),
			'battlefield'
		);
		const surge = putInZone(state, p1, kickedShatter, 'hand');

		// Options list optionalAdditionalCosts with enablesTarget (with base cost mana {U} after Prism Discounter)
		p1.manaPool.U = 1;
		const opts = getCastOptions(state, p1.playerId, surge, 'hand');
		assert.equal(opts.length, 1);
		assert.equal(opts[0].optionalAdditionalCosts?.length, 1);
		assert.equal(opts[0].optionalAdditionalCosts?.[0]?.maxCount, 1);
		assert.equal(opts[0].optionalAdditionalCosts?.[0]?.enablesTarget, true);

		// Validation rejects bad counts
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: surge.instanceId,
				optionalCostCounts: { unknown: 1 }
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: surge.instanceId,
				optionalCostCounts: { 'kicker:0': -1 }
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: surge.instanceId,
				optionalCostCounts: { 'kicker:0': 1.5 }
			}).ok,
			false
		);
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: surge.instanceId,
				optionalCostCounts: { 'kicker:0': 2 }
			}).ok,
			false
		);

		// Rejects passing a target when unkicked (CR 702.33g)
		p1.manaPool.U = 1;
		p1.manaPool.R = 1;
		p1.manaPool.C = 2; // {1}{U} + {2}{R} = {3}{U}{R} minus {1} = {2}{U}{R} (exact!)
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: surge.instanceId,
				targets: [{ kind: 'permanent', id: oppSolRing.instanceId, label: oppSolRing.card.name }]
			}).ok,
			false
		);

		// Requires target when kicked
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: surge.instanceId,
				optionalCostCounts: { 'kicker:0': 1 },
				targets: []
			}).ok,
			false
		);

		// Kicked with legal target succeeds and pays exact combined reduced mana {2}{U}{R}
		const handBefore = p1.hand.length;
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: surge.instanceId,
				optionalCostCounts: { 'kicker:0': 1 },
				targets: [{ kind: 'permanent', id: oppSolRing.instanceId, label: oppSolRing.card.name }]
			}).ok,
			true
		);
		assert.equal(p1.manaPool.U + p1.manaPool.R + p1.manaPool.C, 0);
		passUntilPrompt(state);
		// Drew 1 card and destroyed opponent's artifact
		assert.equal(p1.hand.length, handBefore); // -1 cast + 1 draw
		assert.equal(p2.graveyard.some((c) => c.instanceId === oppSolRing.instanceId), true);

		// 2. Permanent ETB replacement + intervening-if surviving permanent destruction + CR 400.7 reset + synthetic rename
		const kickerCreatureBase = {
			manaCost: '{1}{W}',
			cmc: 2,
			typeLine: 'Creature — Knight',
			power: '2',
			toughness: '2',
			oracleText:
				'Kicker—Pay 3 life.\nIf ~ was kicked, it enters with two +1/+1 counters on it.\nWhen ~ enters, if it was kicked, draw a card.\nAs long as ~ was kicked, it has flying.'
		};
		const { state: s2, p1: p1b, p2: p2b } = makeGame();
		const knightA = putInZone(
			s2,
			p1b,
			syntheticCard({
				name: 'Skyward Aspirant',
				...kickerCreatureBase,
				oracleText: kickerCreatureBase.oracleText.replace(/~/g, 'Skyward Aspirant')
			}),
			'hand'
		);
		const knightRenamed = putInZone(
			s2,
			p1b,
			syntheticCard({
				name: 'Astral Crusader',
				...kickerCreatureBase,
				oracleText: kickerCreatureBase.oracleText.replace(/~/g, 'Astral Crusader')
			}),
			'hand'
		);
		p1b.manaPool.W = 1;
		p1b.manaPool.C = 1;
		const lifeBefore = p1b.life;
		assert.equal(
			applyGameAction(s2, p1b.playerId, {
				type: 'cast_spell',
				instanceId: knightA.instanceId,
				optionalCostCounts: { 'kicker:0': 1 }
			}).ok,
			true
		);
		assert.equal(p1b.life, lifeBefore - 3);
		// Resolve creature spell -> enters with 2 +1/+1 counters & flying, ETB trigger on stack
		applyGameAction(s2, p1b.playerId, { type: 'pass_priority' });
		applyGameAction(s2, p2b.playerId, { type: 'pass_priority' });
		const knightAPerm = p1b.battlefield.find((c) => c.instanceId === knightA.instanceId);
		assert.ok(knightAPerm, 'Skyward Aspirant entered battlefield');
		assert.equal(knightAPerm.counters['+1/+1'], 2);
		assert.equal(knightAPerm.kickedCount, 1);
		assert.ok(evaluatePermanent(s2, knightAPerm).keywords.some((k) => k.toLowerCase() === 'flying'));
		assert.equal(s2.stack.length, 1); // ETB trigger on stack

		// Destroy knightA BEFORE its ETB trigger resolves: CR 603.4 intervening-if still holds via LKI!
		const destroySpell = putInZone(
			s2,
			p2b,
			syntheticCard({ name: 'Doom Blade', manaCost: '{1}', typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
			'hand'
		);
		p2b.manaPool.C = 1;
		// P2 casts instant on knightA
		applyGameAction(s2, p1b.playerId, { type: 'pass_priority' });
		assert.equal(
			applyGameAction(s2, p2b.playerId, {
				type: 'cast_spell',
				instanceId: destroySpell.instanceId,
				targets: [{ kind: 'permanent', id: knightAPerm.instanceId, label: knightAPerm.card.name }]
			}).ok,
			true
		);
		const handBeforeTrigger = p1b.hand.length;
		passUntilPrompt(s2);
		const knightAGy = p1b.graveyard.find((c) => c.instanceId === knightA.instanceId);
		assert.ok(knightAGy, 'Skyward Aspirant died to graveyard');
		assert.equal(knightAGy.kickedCount, undefined); // CR 400.7 cleared on leave battlefield
		assert.equal(knightAGy.kickedTags, undefined);
		assert.equal(p1b.hand.length, handBeforeTrigger + 1); // ETB draw still resolved!

		// Unkicked renamed copy gets no counters, no flying, and intervening-if trigger doesn't draw
		p1b.manaPool.W = 1;
		p1b.manaPool.C = 1;
		const handBeforeUnkicked = p1b.hand.length - 1;
		assert.equal(
			applyGameAction(s2, p1b.playerId, {
				type: 'cast_spell',
				instanceId: knightRenamed.instanceId
			}).ok,
			true
		);
		passUntilPrompt(s2);
		const knightRenamedPerm = p1b.battlefield.find((c) => c.instanceId === knightRenamed.instanceId);
		assert.ok(knightRenamedPerm);
		assert.equal(knightRenamedPerm.counters['+1/+1'], 0);
		assert.equal(knightRenamedPerm.kickedCount, undefined);
		assert.equal(evaluatePermanent(s2, knightRenamedPerm).keywords.some((k) => k.toLowerCase() === 'flying'), false);
		assert.equal(p1b.hand.length, handBeforeUnkicked);

		// 3. Multikicker 3 times
		const { state: s3, p1: p1c } = makeGame();
		const multiWolf = putInZone(
			s3,
			p1c,
			syntheticCard({
				name: 'Multi Wolf',
				manaCost: '{G}',
				cmc: 1,
				typeLine: 'Creature — Wolf',
				power: '1',
				toughness: '1',
				oracleText: 'Multikicker {1}\nMulti Wolf enters with a +1/+1 counter on it for each time it was kicked.'
			}),
			'hand'
		);
		p1c.manaPool.G = 1;
		p1c.manaPool.C = 3;
		assert.equal(
			applyGameAction(s3, p1c.playerId, {
				type: 'cast_spell',
				instanceId: multiWolf.instanceId,
				optionalCostCounts: { 'kicker:0': 3 }
			}).ok,
			true
		);
		passUntilPrompt(s3);
		const multiWolfPerm = p1c.battlefield.find((c) => c.instanceId === multiWolf.instanceId);
		assert.ok(multiWolfPerm);
		assert.equal(multiWolfPerm.counters['+1/+1'], 3);
		assert.equal(multiWolfPerm.kickedCount, 3);

		// 4. Dual "and/or" kicker tags
		const { state: s4, p1: p1d, p2: p2d } = makeGame();
		const battlemage = putInZone(
			s4,
			p1d,
			syntheticCard({
				name: 'Sun-Moon Battlemage',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Wizard',
				power: '2',
				toughness: '2',
				oracleText:
					'Kicker {W} and/or {B}\nWhen Sun-Moon Battlemage enters, if it was kicked with its {W} kicker, you gain 3 life.\nWhen Sun-Moon Battlemage enters, if it was kicked with its {B} kicker, target opponent loses 2 life.'
			}),
			'hand'
		);
		p1d.manaPool.C = 2;
		p1d.manaPool.W = 1; // Only pay white kicker, not black
		const lifeStartP1 = p1d.life;
		const lifeStartP2 = p2d.life;
		assert.equal(
			applyGameAction(s4, p1d.playerId, {
				type: 'cast_spell',
				instanceId: battlemage.instanceId,
				optionalCostCounts: { 'kicker:0': 1 }
			}).ok,
			true
		);
		passUntilPrompt(s4);
		assert.equal(p1d.life, lifeStartP1 + 3);
		assert.equal(p2d.life, lifeStartP2);
	});
});
