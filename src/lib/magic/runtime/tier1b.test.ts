import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameAction,
	checkStateBasedActions,
	createCardInstance,
	createInitialGameState,
	enterEndStep,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity,
	winTheGame
} from '../engine.ts';
import { manaChoiceColors } from './effects.ts';
import { triggerMultiplier } from './replace.ts';
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
		setName: 'Test',
		setCode: 'TST',
		rarity: 'common'
	};
}

function finishCurrentTurn(state: GameState): void {
	const active = state.players[state.activePlayerIndex];
	active.hand = [];
	enterEndStep(state, active);
	const aliveCount = state.players.filter((p) => !p.lost).length;
	for (let i = 0; i < aliveCount; i++) {
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
				p1.playerId
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
				p2.playerId
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
				p1.playerId
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
				p1.playerId
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

			p1.battlefield.push(createCardInstance(panharmoniconCard, p1.playerId));
			p1.battlefield.push(createCardInstance(panharmoniconCard, p1.playerId));

			const clericCard = synthCard({
				name: 'Soul Cleric',
				manaCost: '{1}{W}',
				cmc: 2,
				typeLine: 'Creature — Human Cleric',
				oracleText: 'When ~ enters the battlefield, you gain 2 life.',
				power: '1',
				toughness: '1'
			});
			const cleric = createCardInstance(clericCard, p1.playerId);
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
});
