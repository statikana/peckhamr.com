import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	evaluatePermanent,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity,
	winTheGame
} from '../engine.ts';
import { manaChoiceColors } from './effects.ts';
import { triggerMultiplier } from './replace.ts';
import { transferBattlefieldControl } from './zones.ts';
import { PRECON_DECKS } from '../precons.ts';
import {
	DEFAULT_LOBBY_RULES,
	type GameState,
	type LobbySeat,
	type ManaPool,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

function createEmptyManaPool(): ManaPool {
	return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

function makeSeat(index: number, isBot = false): LobbySeat {
	const deck = PRECON_DECKS[index % PRECON_DECKS.length];
	return {
		seatIndex: index,
		userId: `p${index + 1}`,
		username: `Player ${index + 1}`,
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

function makeGame(playerCount = 2): {
	state: GameState;
	players: PlayerGameState[];
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const seats = Array.from({ length: playerCount }, (_, i) => makeSeat(i, false));
	const state = createInitialGameState(
		'TIER1B_TEST',
		seats,
		new Map(seats.map((s, i) => [s.seatIndex, PRECON_DECKS[i % PRECON_DECKS.length]])),
		{ ...DEFAULT_LOBBY_RULES }
	);
	for (const p of state.players) {
		assert.equal(applyGameAction(state, p.playerId, { type: 'mulligan_keep' }).ok, true);
	}
	for (const p of state.players) {
		p.battlefield = [];
		p.hand = [];
		p.graveyard = [];
		p.exile = [];
		p.manaPool = createEmptyManaPool();
	}
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.passedPriorityPlayerIds = [];
	return {
		state,
		players: state.players,
		p1: state.players[0],
		p2: state.players[1]
	};
}

let synthCounter = 0;
export function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	synthCounter += 1;
	return {
		id: overrides.id ?? `synth_t1b_${synthCounter}`,
		oracleId: overrides.oracleId ?? `ora_t1b_${synthCounter}`,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature — Bear',
		oracleText: overrides.oracleText ?? '',
		colors: overrides.colors ?? [],
		colorIdentity: overrides.colorIdentity ?? [],
		keywords: overrides.keywords ?? [],
		power: overrides.power ?? '2',
		toughness: overrides.toughness ?? '2',
		loyalty: overrides.loyalty ?? undefined,
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

function finishCurrentTurn(state: GameState): void {
	const active = state.players[state.activePlayerIndex];
	active.hand = [];
	enterEndStep(state, active);
	let guard = 20;
	while ((state.phase === 'end_step' || state.stack.length > 0) && guard-- > 0) {
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		assert.equal(applyGameAction(state, priorityPlayer.playerId, { type: 'pass_priority' }).ok, true);
	}
}

describe('Tier 1b CR fixes', () => {
	describe('Item 4: Extra-turn order resumes normal turn order (CR 500.7)', () => {
		it('resumes normal turn order with the next player after an out-of-order extra turn', () => {
			const { state, players } = makeGame(4);
			const [, p2, p3, p4] = players;

			assert.equal(state.activePlayerIndex, 0, 'Starts on Player 1 normal turn');

			// Player 3 (seat 2) is granted an extra turn after Player 1's turn
			state.extraTurnQueue = [p3.playerId];

			// End Player 1's turn -> Player 3 takes their extra turn
			finishCurrentTurn(state);
			assert.equal(state.activePlayerIndex, 2, 'Player 3 takes the extra turn');

			// During Player 3's extra turn, Player 4 (seat 3) also gets an extra turn
			state.extraTurnQueue.push(p4.playerId);

			// End Player 3's extra turn -> Player 4 takes their extra turn
			finishCurrentTurn(state);
			assert.equal(state.activePlayerIndex, 3, 'Player 4 takes the chained extra turn');

			// End Player 4's extra turn -> Normal turn order must resume at Player 2 (seat 1), not wrap to Player 1!
			finishCurrentTurn(state);
			assert.equal(
				state.activePlayerIndex,
				1,
				'Normal turn order resumes with Player 2 after extra turns finish'
			);
			assert.equal(p2.playerId, state.players[state.activePlayerIndex].playerId);
		});
	});

	describe('Item 6: Colorless / no commander produces no identity mana (CR 903.4f, 106.5) and any-color mana fix', () => {
		it('produces no mana from commanderIdentity abilities when commander is colorless or absent, while staying a mana ability', () => {
			const { state, p1, p2 } = makeGame(2);
			// Give p1 a colorless commander and clear any precon color identity
			p1.commanderColorIdentity = [];
			p1.command = [
				createCardInstance(
					synthCard({
						name: 'Kozilek, Butcher of Truth',
						manaCost: '{10}',
						cmc: 10,
						typeLine: 'Legendary Creature — Eldrazi',
						colorIdentity: [],
						colors: []
					}),
					p1.playerId,
					'command',
					true
				)
			];

			assert.deepEqual(getPlayerCommanderIdentity(p1), []);
			assert.deepEqual(manaChoiceColors(state, p1, 'commanderIdentity'), []);

			const commandTower = createCardInstance(
				synthCard({
					name: 'Command Tower',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: "{T}: Add one mana of any color in your commander's color identity."
				}),
				p1.playerId,
				'battlefield'
			);
			commandTower.summoningSick = false;
			p1.battlefield.push(commandTower);

			const abilities = getEffectiveActivatedAbilities(state, p1, commandTower);
			assert.equal(abilities.length, 1);
			assert.equal(abilities[0].isManaAbility, true, 'Command Tower ability remains a mana ability');
			assert.deepEqual(abilities[0].producesMana, []);

			// Activating Command Tower taps it without using the stack and adds 0 mana (not {C} or WUBRG)
			const res = applyGameAction(state, p1.playerId, {
				type: 'activate_ability',
				instanceId: commandTower.instanceId,
				abilityId: abilities[0].id
			});
			assert.equal(res.ok, true);
			assert.equal(state.stack.length, 0, 'Mana ability does not go on the stack');
			assert.equal(commandTower.tapped, true);
			assert.deepEqual(p1.manaPool, { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

			// Opponent's Exotic Orchard sees 0 colors from p1's Command Tower
			const orchard = createCardInstance(
				synthCard({
					name: 'Exotic Orchard',
					manaCost: '',
					cmc: 0,
					typeLine: 'Land',
					oracleText: '{T}: Add one mana of any color that a land an opponent controls could produce.'
				}),
				p2.playerId,
				'battlefield'
			);
			p2.battlefield.push(orchard);
			assert.deepEqual(manaChoiceColors(state, p2, 'opponentLandColors'), []);
			const orchardAbs = getEffectiveActivatedAbilities(state, p2, orchard, ['W', 'U']);
			assert.equal(orchardAbs.length, 0);
		});

		it('does not restrict "Add one mana of any color" to commander color identity', () => {
			const { state, p1 } = makeGame(2);
			p1.commanderColorIdentity = ['R'];
			p1.command = [];

			const bop = createCardInstance(
				synthCard({
					name: 'Birds of Paradise',
					manaCost: '{G}',
					cmc: 1,
					typeLine: 'Creature — Bird',
					oracleText: 'Flying\n{T}: Add one mana of any color.',
					power: '0',
					toughness: '1'
				}),
				p1.playerId,
				'battlefield'
			);
			bop.summoningSick = false;
			p1.battlefield.push(bop);

			const abilities = getEffectiveActivatedAbilities(state, p1, bop, ['R']);
			const manaAb = abilities.find((a) => a.isManaAbility);
			assert.ok(manaAb);
			assert.deepEqual(manaAb.producesMana, ['W', 'U', 'B', 'R', 'G']);
		});
	});

	describe('Item 7: Last player standing wins regardless of cant-win effects (CR 104.2a)', () => {
		it('overrides effects precluding a player from winning when all opponents have left the game', () => {
			const { state, p1, p2 } = makeGame(2);

			// p1 controls Abyssal Persecutor ("You can't win the game and your opponents can't lose the game.")
			const persecutor = createCardInstance(
				synthCard({
					name: 'Abyssal Persecutor',
					manaCost: '{2}{B}{B}',
					cmc: 4,
					typeLine: 'Creature — Demon',
					oracleText: "Flying, trample\nYou can't win the game and your opponents can't lose the game.",
					power: '6',
					toughness: '6'
				}),
				p1.playerId,
				'battlefield'
			);
			p1.battlefield.push(persecutor);

			// CR 104.2b: Effect-based win ("You win the game") is blocked while p1 controls Abyssal Persecutor
			assert.equal(winTheGame(state, p1, 'Alternate win'), false);
			assert.equal(state.status, 'active');

			//Opponent at 0 life cannot lose to SBA while p1 controls Abyssal Persecutor
			p2.life = 0;
			checkStateBasedActions(state);
			assert.equal(p2.lost, false);
			assert.equal(state.status, 'active');

			// CR 104.3a + CR 104.2a: Opponent concedes and leaves the game; p1 is the last player standing
			// and immediately wins despite controlling "You can't win the game".
			assert.equal(applyGameAction(state, p2.playerId, { type: 'concede' }).ok, true);
			assert.equal(p2.lost, true);
			assert.equal(state.status, 'finished');
			assert.equal(state.winnerPlayerId, p1.playerId);
		});
	});

	describe('Item 8: Trigger multipliers add rather than multiply (CR 603.2d)', () => {
		it('causes two Panharmonicon effects to trigger an ability 3 times (1 + 1 + 1), not 4', () => {
			const { state, p1, p2 } = makeGame(2);
			const panharmoniconCard = synthCard({
				name: 'Panharmonicon',
				manaCost: '{4}',
				cmc: 4,
				typeLine: 'Artifact',
				oracleText:
					'If an artifact or creature entering the battlefield causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.'
			});

			p1.battlefield.push(createCardInstance(panharmoniconCard, p1.playerId, 'battlefield'));
			p1.battlefield.push(createCardInstance(panharmoniconCard, p1.playerId, 'battlefield'));

			const clericCard = synthCard({
				name: 'Soul Cleric',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Cleric',
				oracleText: 'When ~ enters the battlefield, you gain 2 life.',
				power: '1',
				toughness: '1'
			});
			const cleric = createCardInstance(clericCard, p1.playerId, 'hand');
			cleric.zone = 'hand';
			p1.hand.push(cleric);
			p1.manaPool = { W: 1, U: 0, B: 0, R: 0, G: 0, C: 1 };

			assert.equal(
				triggerMultiplier(state, cleric, p1.playerId, {
					event: 'zoneChange',
					to: 'battlefield',
					object: cleric
				}),
				3
			);

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: cleric.instanceId
				}).ok,
				true
			);
			// Resolve the creature spell -> ETB triggers should be put on the stack 3 times
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(state.stack.length, 3, 'ETB trigger triggers 3 times with two Panharmonicons');
		});
	});

	describe('Item 9: Layer 4 type-setting preserves Basic/Snow supertypes and non-land types under Blood Moon (CR 205.1a-b, 205.4b, 305.7)', () => {
		it('preserves Basic and Snow supertypes on setTypes and preserves Artifact/Creature types on lands under Blood Moon', () => {
			const { state, p1 } = makeGame(2);

			// 1. Snow Creature enchanted by Kenrith's Transformation ("Enchanted creature loses all abilities and is a green Elk creature with base power and toughness 3/3.")
			const snowBear = createCardInstance(
				synthCard({
					name: 'Rimefur Bear',
					typeLine: 'Snow Creature — Bear',
					oracleText: 'Vigilance',
					power: '2',
					toughness: '2'
				}),
				p1.playerId,
				'battlefield'
			);
			const transformation = createCardInstance(
				synthCard({
					name: "Kenrith's Transformation",
					typeLine: 'Enchantment — Aura',
					oracleText:
						'Enchant creature\nEnchanted creature loses all abilities and is a green Elk creature with base power and toughness 3/3.'
				}),
				p1.playerId,
				'battlefield'
			);
			transformation.attachedToId = snowBear.instanceId;
			p1.battlefield.push(snowBear, transformation);

			const evalSnowBear = evaluatePermanent(state, snowBear);
			assert.equal(evalSnowBear.effectiveTypeLine, 'Snow Creature — Elk');

			// 2. Basic Snow Land enchanted by Imprisoned in the Moon
			const basicSnowIsland = createCardInstance(
				synthCard({
					name: 'Snow-Covered Island',
					typeLine: 'Basic Snow Land — Island',
					oracleText: '({T}: Add {U}.)'
				}),
				p1.playerId,
				'battlefield'
			);
			const imprisoned = createCardInstance(
				synthCard({
					name: 'Imprisoned in the Moon',
					typeLine: 'Enchantment — Aura',
					oracleText:
						'Enchant creature, land, or planeswalker\nEnchanted permanent is a colorless land with "{T}: Add {C}" and loses all other card types and abilities.'
				}),
				p1.playerId,
				'battlefield'
			);
			imprisoned.attachedToId = basicSnowIsland.instanceId;
			p1.battlefield.push(basicSnowIsland, imprisoned);

			const evalBasicSnow = evaluatePermanent(state, basicSnowIsland);
			assert.equal(evalBasicSnow.effectiveTypeLine, 'Basic Snow Land');

			// 3. Blood Moon with Artifact Land, Snow Land, and Land Creature — Forest Dryad
			const darksteelCitadel = createCardInstance(
				synthCard({
					name: 'Darksteel Citadel',
					typeLine: 'Artifact Land',
					oracleText: 'Indestructible\n{T}: Add {C}.'
				}),
				p1.playerId,
				'battlefield'
			);
			const snowDual = createCardInstance(
				synthCard({
					name: 'Rimewood Falls',
					typeLine: 'Snow Land — Forest Island',
					oracleText: '({T}: Add {G} or {U}.)'
				}),
				p1.playerId,
				'battlefield'
			);
			const dryadArbor = createCardInstance(
				synthCard({
					name: 'Dryad Arbor',
					typeLine: 'Land Creature — Forest Dryad',
					oracleText: '({T}: Add {G}.)',
					power: '1',
					toughness: '1'
				}),
				p1.playerId,
				'battlefield'
			);
			const bloodMoon = createCardInstance(
				synthCard({
					name: 'Blood Moon',
					typeLine: 'Enchantment',
					oracleText: 'Nonbasic lands are Mountains.'
				}),
				p1.playerId,
				'battlefield'
			);
			p1.battlefield.push(darksteelCitadel, snowDual, dryadArbor, bloodMoon);

			const evalCitadel = evaluatePermanent(state, darksteelCitadel);
			assert.equal(evalCitadel.effectiveTypeLine, 'Artifact Land — Mountain');
			assert.equal(evalCitadel.isArtifact, true);
			assert.equal(evalCitadel.isLand, true);

			const evalSnowDual = evaluatePermanent(state, snowDual);
			assert.equal(evalSnowDual.effectiveTypeLine, 'Snow Land — Mountain');

			const evalDryad = evaluatePermanent(state, dryadArbor);
			assert.equal(evalDryad.effectiveTypeLine, 'Land Creature — Mountain Dryad');
			assert.equal(evalDryad.isCreature, true);
			assert.equal(evalDryad.isLand, true);
			assert.equal(evalDryad.hasSubType('Mountain'), true);
			assert.equal(evalDryad.hasSubType('Dryad'), true);
			assert.equal(evalDryad.hasSubType('Forest'), false);
		});
	});

	describe('Item 10: Copies of permanent spells become tokens on resolution (CR 111.13, 608.3f, 707.10f)', () => {
		it('puts a resolving copy of a permanent spell onto the battlefield as a token while instant/sorcery copies cease to exist', () => {
			const { state, p1, p2 } = makeGame(2);

			const bearCard = synthCard({
				name: 'Runeclaw Bear',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			});
			const bear = createCardInstance(bearCard, p1.playerId, 'hand');
			bear.zone = 'hand';
			p1.hand.push(bear);
			p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 1, C: 1 };

			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: bear.instanceId
				}).ok,
				true
			);
			assert.equal(state.stack.length, 1);

			// Push a copy of the permanent spell on top of the stack
			const originalSpell = state.stack[0];
			state.stack.push({
				...originalSpell,
				id: 'stk_copy_bear',
				isCopy: true
			});

			// Resolve the copy on top of the stack
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);

			assert.equal(state.stack.length, 1, 'Original spell still on the stack');
			assert.equal(p1.battlefield.length, 1, 'Copy of permanent spell entered the battlefield');
			const tokenBear = p1.battlefield[0];
			assert.equal(tokenBear.isToken, true, 'Resolved permanent spell copy is a token');
			assert.notEqual(tokenBear.instanceId, bear.instanceId, 'Token copy has a distinct instanceId from original spell');

			// Resolve the original permanent spell
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(state.stack.length, 0);
			assert.equal(p1.battlefield.length, 2);
			assert.equal(p1.battlefield.filter((c) => c.isToken).length, 1);
			assert.equal(p1.battlefield.filter((c) => !c.isToken).length, 1);

			// Also verify an instant spell copy resolves and ceases to exist without entering graveyard
			const boltCard = synthCard({
				name: 'Chain Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'You gain 3 life.'
			});
			state.stack.push({
				id: 'stk_copy_instant',
				sourceInstanceId: 'copy_inst_src',
				card: boltCard,
				controllerId: p1.playerId,
				ownerId: p1.playerId,
				kind: 'spell',
				isCopy: true,
				title: boltCard.name,
				oracleText: boltCard.oracleText,
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: 0
			});
			const lifeBefore = p1.life;
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(p1.life, lifeBefore + 3);
			assert.equal(p1.graveyard.length, 0, 'Copy of instant spell ceases to exist');
		});
	});

	describe('Item 11: Enchant-player Auras attach to players and survive SBAs (CR 303.4, 702.5c-d, 704.5m)', () => {
		it('targets and attaches an Enchant player Aura to a player on resolution, survives SBAs, and dies when that player leaves', () => {
			const { state, players } = makeGame(3);
			const [p1, p2, p3] = players;

			const curseCard = synthCard({
				name: 'Curse of Opulence',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Enchantment — Aura Curse',
				oracleText: 'Enchant player'
			});
			const curse = createCardInstance(curseCard, p1.playerId, 'hand');
			curse.zone = 'hand';
			p1.hand.push(curse);
			p1.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };

			const bear = createCardInstance(
				synthCard({ name: 'Target Bear', typeLine: 'Creature — Bear' }),
				p2.playerId,
				'battlefield'
			);
			p2.battlefield.push(bear);

			// CR 702.5d: Enchant player Aura cannot target a permanent
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: curse.instanceId,
					targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
				}).ok,
				false
			);

			// Cast targeting Player 2
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: curse.instanceId,
					targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
				}).ok,
				true
			);

			// Resolve the Aura spell across all 3 players
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p3.playerId, { type: 'pass_priority' }).ok, true);

			assert.equal(p1.battlefield.length, 1, 'Curse remains on battlefield after resolution and SBA check');
			assert.equal(p1.battlefield[0].attachedToId, p2.playerId, 'Curse is attached to Player 2');
			assert.equal(p1.graveyard.length, 0);

			// When Player 2 leaves the game, the Curse attached to Player 2 goes to p1's graveyard (CR 303.4c / 704.5m)
			assert.equal(applyGameAction(state, p2.playerId, { type: 'concede' }).ok, true);
			assert.equal(p1.battlefield.length, 0, 'Curse is removed from battlefield when enchanted player leaves');
			assert.equal(p1.graveyard.length, 1, 'Curse is put into owner graveyard');
		});

		it('enforces all Enchant abilities when an Aura has multiple instances of enchant (CR 702.5c)', () => {
			const { state, p1 } = makeGame(2);
			const multiAuraCard = synthCard({
				name: 'Mechanized Bond',
				manaCost: '{W}',
				cmc: 1,
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchant artifact'
			});
			const plainBear = createCardInstance(
				synthCard({ name: 'Plain Bear', typeLine: 'Creature — Bear' }),
				p1.playerId,
				'battlefield'
			);
			const multiAura = createCardInstance(multiAuraCard, p1.playerId, 'battlefield');
			multiAura.attachedToId = plainBear.instanceId;
			p1.battlefield.push(plainBear, multiAura);

			checkStateBasedActions(state);
			assert.equal(
				p1.graveyard.some((c) => c.instanceId === multiAura.instanceId),
				true,
				'Aura with Enchant artifact + Enchant creature falls off a non-artifact creature'
			);
		});
	});

	describe('Item 12: Eliminated-player cleanup for stolen vs default-controlled permanents, stack spells, and active-player turn completion (CR 800.4a, 800.4c, 800.4j)', () => {
		it('returns control-changed permanents to their default controller but exiles foreign-owned permanents and stack spells whose default controller is the eliminated player (CR 800.4a, 800.4c)', () => {
			const { state, players } = makeGame(3);
			const [p1, p2, p3] = players;

			// 1. Stolen Bear: entered on p1's battlefield (defaultController = p1), then p2 gained control of it
			const stolenBear = createCardInstance(
				synthCard({ name: 'Stolen Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
				p1.playerId,
				'battlefield'
			);
			p1.battlefield.push(stolenBear);
			transferBattlefieldControl(stolenBear, p1, p2, state);

			// 2. Reanimated Angel: owned by p1 in p1's graveyard, put onto the battlefield under p2's default control via Reanimate
			const angel = createCardInstance(
				synthCard({ name: 'Reanimated Angel', typeLine: 'Creature — Angel', manaCost: '{3}{W}{W}', cmc: 5, power: '4', toughness: '4' }),
				p1.playerId,
				'graveyard'
			);
			p1.graveyard.push(angel);

			// Advance to p2's turn so p2 can cast Reanimate
			finishCurrentTurn(state);
			assert.equal(state.activePlayerIndex, 1);
			state.phase = 'main1';
			state.priorityPlayerIndex = 1;
			state.passedPriorityPlayerIds = [];

			const reanimate = createCardInstance(
				synthCard({
					name: 'Reanimate',
					manaCost: '{B}',
					cmc: 1,
					typeLine: 'Sorcery',
					oracleText: 'Return target creature card from a graveyard to the battlefield under your control. You lose life equal to its mana value.'
				}),
				p2.playerId,
				'hand'
			);
			p2.hand.push(reanimate);
			p2.manaPool = { W: 5, U: 5, B: 5, R: 5, G: 5, C: 5 };
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: reanimate.instanceId,
					targets: [{ kind: 'graveyard_card', id: angel.instanceId, label: angel.card.name }]
				}).ok,
				true
			);
			assert.equal(applyGameAction(state, p2.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p3.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'pass_priority' }).ok, true);
			assert.equal(
				p2.battlefield.some((c) => c.instanceId === angel.instanceId),
				true,
				'Reanimated Angel is on p2 battlefield under p2 default control'
			);

			// 3. Foreign-owned spell on the stack controlled by p2: p1's card in exile with playableFromExileBy p2
			const foreignSpell = createCardInstance(
				synthCard({
					name: 'Stolen Bolt',
					manaCost: '{R}',
					cmc: 1,
					typeLine: 'Instant',
					oracleText: 'Stolen Bolt deals 3 damage to any target.'
				}),
				p1.playerId,
				'exile'
			);
			foreignSpell.playableFromExileBy = {
				playerId: p2.playerId,
				spendManaAsAnyColor: true,
				sourceName: 'Test Impulse'
			};
			p1.exile.push(foreignSpell);
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'cast_spell',
					instanceId: foreignSpell.instanceId,
					fromZone: 'exile',
					targets: [{ kind: 'player', id: p3.playerId, label: p3.username }]
				}).ok,
				true
			);

			// 4. Also put a spell owned by p2 on the stack that is controlled by p3 (CR 800.4a: owned by p2 -> leaves game)
			state.stack.push({
				id: 'stk_p2_owned',
				sourceInstanceId: 'inst_p2_owned',
				card: synthCard({ name: 'P2 Owned Spell', typeLine: 'Instant', oracleText: 'Draw a card.' }),
				ownerId: p2.playerId,
				controllerId: p3.playerId,
				kind: 'spell',
				title: 'P2 Owned Spell',
				oracleText: 'Draw a card.',
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: 0
			});

			// Now p2 leaves the game (concedes)
			assert.equal(applyGameAction(state, p2.playerId, { type: 'concede' }).ok, true);

			// Stolen Bear (default controller p1) returned to p1's battlefield
			assert.equal(
				p1.battlefield.some((c) => c.instanceId === stolenBear.instanceId),
				true,
				'Control-changed permanent reverts to default controller p1'
			);
			// Reanimated Angel (default controller p2, owner p1) was EXILED, not returned to p1's battlefield!
			assert.equal(
				p1.battlefield.some((c) => c.instanceId === angel.instanceId),
				false,
				'Permanent put onto battlefield under p2 default control does not return to p1 battlefield'
			);
			assert.equal(
				p1.exile.some((c) => c.instanceId === angel.instanceId),
				true,
				'Permanent put onto battlefield under p2 default control is exiled (CR 800.4a)'
			);
			// Stolen Bolt (foreign-owned spell on stack controlled by p2) was EXILED to p1's exile zone!
			assert.equal(
				p1.exile.some((c) => c.instanceId === foreignSpell.instanceId),
				true,
				'Foreign-owned spell on stack controlled by p2 is exiled (CR 800.4a)'
			);
			// P2-owned spell on stack controlled by p3 left the game
			assert.equal(state.stack.length, 0, 'Stack is empty after p2 owned/controlled spells are cleaned up');
		});

		it('continues the turn without an active player when the active player leaves the game mid-turn (CR 800.4j)', () => {
			const { state, players } = makeGame(3);
			const [p1, p2] = players;

			// Put an "At the beginning of each end step, you gain 2 life" enchantment on p2's battlefield
			const shrine = createCardInstance(
				synthCard({
					name: 'Twilight Shrine',
					manaCost: '{1}{W}',
					cmc: 2,
					typeLine: 'Enchantment',
					oracleText: 'At the beginning of each end step, you gain 2 life.'
				}),
				p2.playerId,
				'battlefield'
			);
			p2.battlefield.push(shrine);
			const p2LifeBefore = p2.life;

			// During p1's Main Phase 1 (activePlayerIndex = 0), p1 concedes
			assert.equal(state.activePlayerIndex, 0);
			assert.equal(state.phase, 'main1');
			assert.equal(applyGameAction(state, p1.playerId, { type: 'concede' }).ok, true);

			// CR 800.4j: The turn continues to its completion without an active player;
			// priority passes to the next player in turn order (p2, index 1) in main1.
			assert.equal(state.phase, 'main1', 'Turn continues in main1 without aborting');
			assert.equal(state.activePlayerIndex, 0, 'Turn anchor remains on seat 0 (no active player)');
			assert.equal(state.priorityPlayerIndex, 1, 'Next player in turn order (p2) receives priority');

			// Finish the current turn by passing priority for alive players through end_step
			finishCurrentTurn(state);

			// End-step trigger on p2's shrine fired and resolved during the completion of seat 0's turn,
			// and then the next turn began for p2 (activePlayerIndex = 1)!
			assert.equal(p2.life, p2LifeBefore + 2, 'Each-end-step trigger fired before turn ended (CR 800.4j)');
			assert.equal(state.activePlayerIndex, 1, 'Turn advances to p2 after the active-less turn completes');
		});
	});
});
