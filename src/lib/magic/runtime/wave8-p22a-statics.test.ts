import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities
} from '../engine.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { attachObject, createEmptyCounters, moveObject } from './zones.ts';
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

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p22a_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p22a_${synthSeq}`,
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
		id: 'deck_p22a',
		userId: 'p1',
		name: 'Track P22a Deck',
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
		startingLife?: number;
		p1Commander?: ScryfallCard;
	} = {}
): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'P22a Wastes Filler',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Wastes',
		oracleText: '{T}: Add {C}.'
	});
	const d1 = makeDeck(
		Array.from({ length: 30 }, () => filler),
		opts.p1Commander
	);
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
			commanderNames: opts.p1Commander ? [opts.p1Commander.name] : [],
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
	const startLife = opts.startingLife ?? 20;
	const state = createInitialGameState('P22A_TEST', seats, decks, {
		...DEFAULT_LOBBY_RULES,
		startingLife: startLife
	});
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	if (!opts.p1Commander) {
		state.status = 'active';
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		state.passedPriorityPlayerIds = [];
		state.phase = 'main1';
		state.turnNumber = 2;
		for (const p of state.players) {
			p.life = startLife;
			p.hand = [];
			p.battlefield = [];
			p.graveyard = [];
			p.exile = [];
			p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		}
		noteLayerInputsChanged(state);
	}
	return {
		state,
		p1: state.players[0],
		p2: state.players[1]
	};
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'
): CardInstance {
	const rep = definitionSupportReport(compileCard(card));
	assert.equal(
		rep.fullySupported,
		true,
		`Expected synthetic card "${card.name}" to compile cleanly, got unsupported: ${JSON.stringify(rep.unsupported)}`
	);
	const inst: CardInstance = {
		instanceId: `inst_${++synthSeq}`,
		card,
		ownerId: player.playerId,
		controllerId: player.playerId,
		defaultControllerId: player.playerId,
		zone: 'exile',
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters: {
			...createEmptyCounters(),
			loyalty: card.loyalty ? parseInt(card.loyalty, 10) : 0
		},
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: false,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		objectVersion: 1
	};
	moveObject(state, inst, zone, {
		from: 'none',
		toPlayer: player,
		newTimestamp: true,
		emit: false
	});
	noteLayerInputsChanged(state);
	return inst;
}

function drainStack(state: GameState): void {
	for (
		let guard = 0;
		guard < 16 && state.stack.length > 0 && state.pendingPrompts.length === 0;
		guard++
	) {
		const pid = state.players[state.priorityPlayerIndex]?.playerId ?? state.players[0].playerId;
		applyGameAction(state, pid, { type: 'pass_priority' });
	}
}

describe('Wave 8 Track P22a — Statics, ETB Choices, Redirection, Counter Locks, Scaling & Grants', () => {
	it('CR 614.12 / 702.16: chooseCardType ETB prompt grants player + creature protection from chosen card type', () => {
		const { state, p1, p2 } = setupGame();
		const guardian = synthCard({
			name: 'Synth CardType Emissary',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Creature — Angel',
			power: '4',
			toughness: '4',
			oracleText:
				'As ~ enters, choose a card type.\nYou and creatures you control have protection from the chosen card type.'
		});
		const inst = putInZone(state, p1, guardian, 'hand');
		p1.manaPool.C = 2;

		const castRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: inst.instanceId
		});
		assert.equal(castRes.ok, true, castRes.error ?? '');
		drainStack(state);

		assert.equal(state.pendingPrompts.length, 1);
		const prompt = state.pendingPrompts[0];
		assert.equal(prompt.purpose, 'etb_choice');
		assert.ok(prompt.choice && prompt.choice.kind === 'chooseMode');
		const instantIdx = prompt.choice.modes.indexOf('Instant');
		assert.equal(instantIdx >= 0, true);

		const ansRes = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prompt.id,
			answer: { kind: 'chooseMode', indices: [instantIdx] }
		});
		assert.equal(ansRes.ok, true, ansRes.error ?? '');

		const onBf = p1.battlefield.find((c) => c.instanceId === inst.instanceId);
		assert.ok(onBf);
		assert.equal(onBf.chosenCardType, 'Instant');

		const ev = evaluatePermanent(state, onBf);
		assert.equal(
			ev.activeKeywords.some((k) => k.toLowerCase() === 'protection from instants'),
			true
		);

		// Opponent instant targeting p1 or onBf is illegal due to protection from instants!
		const bolt = synthCard({
			name: 'Synth Zap Instant',
			manaCost: '{R}',
			cmc: 1,
			typeLine: 'Instant',
			oracleText: '~ deals 3 damage to any target.'
		});
		const boltInst = putInZone(state, p2, bolt, 'hand');
		state.priorityPlayerIndex = 1;
		p2.manaPool.R = 2;

		const legPlayer = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: boltInst.instanceId,
			targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
		});
		assert.equal(legPlayer.ok, false);

		const legCreature = applyGameAction(state, p2.playerId, {
			type: 'cast_spell',
			instanceId: boltInst.instanceId,
			targets: [{ kind: 'permanent', id: onBf.instanceId, label: onBf.card.name }]
		});
		assert.equal(legCreature.ok, false);
	});

	it('CR 614.12: chooseNumber ETB prompt locks casting noncreature spells with mana value equal to chosen number', () => {
		const { state, p1, p2 } = setupGame();
		const prelate = synthCard({
			name: 'Synth Number Arbiter',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Creature — Cleric',
			power: '2',
			toughness: '2',
			oracleText:
				"As ~ enters, choose a number.\nNoncreature spells with mana value equal to the chosen number can't be cast."
		});
		const prelateInst = putInZone(state, p1, prelate, 'hand');
		p1.manaPool.C = 2;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: prelateInst.instanceId
			}).ok,
			true
		);
		drainStack(state);

		assert.equal(state.pendingPrompts.length, 1);
		const prompt = state.pendingPrompts[0];
		assert.ok(prompt.choice && prompt.choice.kind === 'chooseNumber');
		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseNumber', n: 2 }
			}).ok,
			true
		);

		const onBf = p1.battlefield.find((c) => c.instanceId === prelateInst.instanceId);
		assert.ok(onBf);
		assert.equal(onBf.chosenNumber, 2);

		const mv2Artifact = synthCard({
			name: 'Synth Relic Two',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Artifact',
			oracleText: ''
		});
		const mv3Artifact = synthCard({
			name: 'Synth Relic Three',
			manaCost: '{3}',
			cmc: 3,
			typeLine: 'Artifact',
			oracleText: ''
		});
		const mv2Creature = synthCard({
			name: 'Synth Bear Two',
			manaCost: '{2}',
			cmc: 2,
			typeLine: 'Creature — Bear',
			power: '2',
			toughness: '2',
			oracleText: ''
		});
		const a2 = putInZone(state, p2, mv2Artifact, 'hand');
		const a3 = putInZone(state, p2, mv3Artifact, 'hand');
		const c2 = putInZone(state, p2, mv2Creature, 'hand');
		state.activePlayerIndex = 1;
		state.priorityPlayerIndex = 1;
		p2.manaPool.C = 10;

		assert.equal(checkSpellCastLegality(state, p2.playerId, a2).ok, false);
		assert.equal(checkSpellCastLegality(state, p2.playerId, a3).ok, true);
		assert.equal(checkSpellCastLegality(state, p2.playerId, c2).ok, true);
	});

	it('CR 614.12: look at opponent hand before choosing card name reveals opponent hand & locks activated abilities', () => {
		const { state, p1, p2 } = setupGame();
		const oppCard = synthCard({
			name: 'Synth Mana Rod',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Artifact',
			oracleText: '{1}: Gain 1 life.'
		});
		const oppHandInst = putInZone(state, p2, oppCard, 'hand');
		const oppRodBf = putInZone(state, p2, oppCard, 'battlefield');

		const keeper = synthCard({
			name: 'Synth Hand Inspector',
			manaCost: '{1}',
			cmc: 1,
			typeLine: 'Creature — Cleric',
			power: '3',
			toughness: '3',
			oracleText:
				"As ~ enters, look at an opponent's hand, then choose any card name.\nActivated abilities of sources with the chosen name can't be activated unless they're mana abilities."
		});
		const keeperInst = putInZone(state, p1, keeper, 'hand');
		p1.manaPool.C = 2;

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: keeperInst.instanceId
			}).ok,
			true
		);
		drainStack(state);

		assert.equal(state.pendingPrompts.length, 1);
		assert.equal(Boolean(oppHandInst.knownToPlayerIds?.includes(p1.playerId)), true);

		const prompt = state.pendingPrompts[0];
		assert.ok(prompt.choice && prompt.choice.kind === 'chooseMode');
		const rodIdx = prompt.choice.modes.indexOf('Synth Mana Rod');
		assert.equal(rodIdx >= 0, true);

		assert.equal(
			applyGameAction(state, p1.playerId, {
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseMode', indices: [rodIdx] }
			}).ok,
			true
		);

		p2.manaPool.C = 3;
		state.priorityPlayerIndex = 1;
		const abs = getEffectiveActivatedAbilities(state, p2, oppRodBf);
		assert.equal(abs.length, 1);
		const actLeg = checkAbilityActivationLegality(state, p2.playerId, oppRodBf, abs[0]);
		assert.equal(actLeg.ok, false);
	});

	it('CR 903.4: commanderPreGameColorChoice prompts before game start and sets Layer 5 chosen color', () => {
		const cmdr = synthCard({
			name: 'Synth Prismatic Piper',
			manaCost: '{4}',
			cmc: 4,
			typeLine: 'Legendary Creature — Shapeshifter',
			power: '3',
			toughness: '3',
			oracleText:
				'If ~ is your commander, choose a color before the game begins. ~ is the chosen color.'
		});
		assert.equal(definitionSupportReport(compileCard(cmdr)).fullySupported, true);

		const { state, p1 } = setupGame({ p1Commander: cmdr });
		const prePrompt = state.pendingPrompts.find(
			(pr) => pr.continuation?.kind === 'handler' && pr.continuation.name === 'commander_pregame_color'
		);
		assert.ok(prePrompt);

		// Choose Blue (index 1 in ['W','U','B','R','G'])
		const res = applyGameAction(state, p1.playerId, {
			type: 'choice',
			promptId: prePrompt.id,
			answer: { kind: 'chooseMode', indices: [1] }
		});
		assert.equal(res.ok, true, res.error ?? '');
		const cmdInst = p1.command[0];
		assert.ok(cmdInst);
		assert.equal(cmdInst.chosenColor, 'U');
		assert.equal(cmdInst.preGameChosenColor, 'U');

		moveObject(state, cmdInst, 'battlefield', {
			from: { player: p1, zone: 'command' },
			toPlayer: p1,
			newTimestamp: true
		});
		noteLayerInputsChanged(state);
		const ev = evaluatePermanent(state, cmdInst);
		assert.deepEqual(ev.colors, ['U']);
	});

	it('CR 614.9 & CR 615.12: staticDamageRedirection redirects player damage once (loop-safe) & unpreventableDamage bypasses shields', () => {
		const { state, p1, p2 } = setupGame();
		const host = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Sturdy Ox',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Ox',
				power: '2',
				toughness: '6'
			}),
			'battlefield'
		);
		const pariahAura = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Scapegoat Aura',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Enchantment — Aura',
				oracleText:
					'Enchant creature\nAll damage that would be dealt to you is dealt to enchanted creature instead.'
			}),
			'battlefield'
		);
		attachObject(state, pariahAura, host.instanceId);
		noteLayerInputsChanged(state);

		const ping = putInZone(
			state,
			p2,
			synthCard({
				name: 'Synth Flame Bolt',
				manaCost: '{R}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: '~ deals 4 damage to target player.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		p2.manaPool.R = 2;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: ping.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		drainStack(state);

		assert.equal(p1.life, 20);
		assert.equal(host.damageMarked, 4);

		// Source-scoped unpreventableDamage bypasses staticDamagePrevention
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Fog Totem',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Artifact',
				oracleText: 'Prevent all damage that would be dealt to you.'
			}),
			'battlefield'
		);
		putInZone(
			state,
			p2,
			synthCard({
				name: 'Synth Sunspine Lynx',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Cat',
				power: '3',
				toughness: '3',
				oracleText: "Damage dealt by red sources can't be prevented."
			}),
			'battlefield'
		);
		moveObject(state, pariahAura, 'graveyard', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1
		});
		noteLayerInputsChanged(state);

		const redShot = putInZone(
			state,
			p2,
			synthCard({
				name: 'Synth Red Spear',
				manaCost: '{R}',
				cmc: 1,
				colors: ['R'],
				typeLine: 'Instant',
				oracleText: '~ deals 3 damage to target player.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		p2.manaPool.R = 2;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: redShot.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(p1.life, 17);
	});

	it('CR 122.6 & CR 122.2: player/permanent counter locks & zone-persistent counters (Skullbriar rule)', () => {
		const { state, p1, p2 } = setupGame();
		const walker = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Grave Crawler',
				manaCost: '{B}{G}',
				cmc: 2,
				typeLine: 'Legendary Creature — Zombie',
				power: '1',
				toughness: '1',
				oracleText:
					"Counters remain on ~ as it moves to any zone other than a player's hand or library."
			}),
			'battlefield'
		);
		walker.counters['+1/+1'] = 3;
		noteLayerInputsChanged(state);
		assert.equal(getCreaturePower(walker, state), 4);

		// Move battlefield -> graveyard -> exile -> battlefield: counters remain even with leaveBattlefieldReset!
		moveObject(state, walker, 'graveyard', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			leaveBattlefieldReset: true
		});
		assert.equal(walker.counters['+1/+1'], 3);
		moveObject(state, walker, 'exile', {
			from: { player: p1, zone: 'graveyard' },
			toPlayer: p1
		});
		assert.equal(walker.counters['+1/+1'], 3);
		moveObject(state, walker, 'battlefield', {
			from: { player: p1, zone: 'exile' },
			toPlayer: p1
		});
		assert.equal(walker.counters['+1/+1'], 3);

		// Move battlefield -> hand: counters clear per CR 122.2 exception!
		moveObject(state, walker, 'hand', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1,
			leaveBattlefieldReset: true
		});
		assert.equal(walker.counters['+1/+1'], 0);

		// Solemnity / Melira counter locks
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Purity Shrine',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText:
					"Players can't get counters.\nCreatures you control can't have -1/-1 counters put on them."
			}),
			'battlefield'
		);
		const bear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Protected Bear',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'battlefield'
		);
		const blightSpell = putInZone(
			state,
			p2,
			synthCard({
				name: 'Synth Minus Touch',
				manaCost: '{B}',
				cmc: 1,
				typeLine: 'Instant',
				oracleText: 'Put a -1/-1 counter on target creature. Each player gets a poison counter.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		p2.manaPool.B = 2;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: blightSpell.instanceId,
				targets: [{ kind: 'permanent', id: bear.instanceId, label: bear.card.name }]
			}).ok,
			true
		);
		drainStack(state);

		assert.equal(bear.counters['-1/-1'], 0);
		assert.equal(p1.poison, 0);
		assert.equal(p2.poison, 0);
	});

	it('Layer 7a/7c & Conditions: playerCounters scaling, distinctNamesCount CDA, & lifeAtLeastAboveStarting', () => {
		const { state, p1, p2 } = setupGame({ startingLife: 20 });
		const valkyrie = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Righteous Herald',
				manaCost: '{2}{W}',
				cmc: 3,
				typeLine: 'Creature — Angel',
				power: '2',
				toughness: '4',
				oracleText:
					'As long as you have at least 7 life more than your starting life total, creatures you control get +2/+2.'
			}),
			'battlefield'
		);
		const expLord = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Experience Hunter',
				manaCost: '{2}',
				cmc: 2,
				typeLine: 'Creature — Assassin',
				power: '2',
				toughness: '2',
				oracleText:
					'~ gets +1/+1 for each experience counter you have.\n~ gets +1/+1 for each poison counter your opponents have.'
			}),
			'battlefield'
		);
		const landAvatar = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Distinct Land Avatar',
				manaCost: '{3}',
				cmc: 3,
				typeLine: 'Creature — Elemental',
				power: '*',
				toughness: '*',
				oracleText:
					"~'s power and toughness are each equal to the number of differently named lands you control."
			}),
			'battlefield'
		);

		putInZone(
			state,
			p1,
			synthCard({ name: 'Synth Alpha Land', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			synthCard({ name: 'Synth Alpha Land', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'battlefield'
		);
		putInZone(
			state,
			p1,
			synthCard({ name: 'Synth Beta Land', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'battlefield'
		);

		assert.equal(getCreaturePower(landAvatar, state), 2);
		assert.equal(getCreatureToughness(landAvatar, state), 2);
		assert.equal(getCreaturePower(valkyrie, state), 2);

		p1.experienceCounters = 3;
		p2.poison = 2;
		p1.life = 27;
		noteLayerInputsChanged(state);

		assert.equal(getCreaturePower(valkyrie, state), 4);
		assert.equal(getCreaturePower(expLord, state), 2 + 3 + 2 + 2);
		assert.equal(getCreaturePower(landAvatar, state), 2 + 2);
	});

	it('Symmetrical extraLandPlays, immuneToOpponentForcedSacrifice, grantGraveyardEscape & grantHandForetell', () => {
		const { state, p1, p2 } = setupGame();

		// 1. Symmetrical extraLandPlays does not double-count for controller!
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Rites of Flourishing',
				manaCost: '{2}{G}',
				cmc: 3,
				typeLine: 'Enchantment',
				oracleText: 'Each player may play an additional land on each of their turns.'
			}),
			'battlefield'
		);
		const l1 = putInZone(
			state,
			p1,
			synthCard({ name: 'Synth Plains 1', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'hand'
		);
		const l2 = putInZone(
			state,
			p1,
			synthCard({ name: 'Synth Plains 2', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'hand'
		);
		const l3 = putInZone(
			state,
			p1,
			synthCard({ name: 'Synth Plains 3', manaCost: '', cmc: 0, typeLine: 'Land' }),
			'hand'
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: l1.instanceId }).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: l2.instanceId }).ok,
			true
		);
		assert.equal(
			applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: l3.instanceId }).ok,
			false
		);

		// 2. Sigarda opponent-forced sacrifice immunity
		const sigarda = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Host of Herons',
				manaCost: '{2}{G}{W}{W}',
				cmc: 5,
				typeLine: 'Legendary Creature — Angel',
				power: '5',
				toughness: '5',
				oracleText:
					"Spells and abilities your opponents control can't cause you to sacrifice permanents."
			}),
			'battlefield'
		);
		const edict = putInZone(
			state,
			p2,
			synthCard({
				name: 'Synth Cruel Edict',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Instant',
				oracleText: 'Target player sacrifices a creature.'
			}),
			'hand'
		);
		state.priorityPlayerIndex = 1;
		p2.manaPool.B = 2;
		p2.manaPool.C = 2;
		assert.equal(
			applyGameAction(state, p2.playerId, {
				type: 'cast_spell',
				instanceId: edict.instanceId,
				targets: [{ kind: 'player', id: p1.playerId, label: p1.username }]
			}).ok,
			true
		);
		drainStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === sigarda.instanceId),
			true
		);

		// 3. Underworld Breach grantGraveyardEscape
		putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Breach Portal',
				manaCost: '{1}{R}',
				cmc: 2,
				typeLine: 'Enchantment',
				oracleText:
					"Each nonland card in your graveyard has escape. The escape cost is equal to the card's mana cost plus exile three other cards from your graveyard."
			}),
			'battlefield'
		);
		const gyBear = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Escaping Bear',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Creature — Bear',
				power: '2',
				toughness: '2'
			}),
			'graveyard'
		);
		const fodder1 = putInZone(
			state,
			p1,
			synthCard({ name: 'Fodder A', manaCost: '{1}', cmc: 1 }),
			'graveyard'
		);
		const fodder2 = putInZone(
			state,
			p1,
			synthCard({ name: 'Fodder B', manaCost: '{1}', cmc: 1 }),
			'graveyard'
		);
		const fodder3 = putInZone(
			state,
			p1,
			synthCard({ name: 'Fodder C', manaCost: '{1}', cmc: 1 }),
			'graveyard'
		);
		state.priorityPlayerIndex = 0;
		p1.manaPool.G = 2;
		p1.manaPool.C = 2;

		const gyOpts = getCastOptions(state, p1.playerId, gyBear, 'graveyard');
		const escapeOpt = gyOpts.find((o) => o.id.startsWith('wave8_escape:'));
		assert.ok(escapeOpt, `Expected granted escape CastOption, got ${JSON.stringify(gyOpts)}`);

		const escRes = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: gyBear.instanceId,
			fromZone: 'graveyard',
			optionId: escapeOpt.id,
			costPayment: {
				objects: [[fodder1.instanceId, fodder2.instanceId, fodder3.instanceId]]
			}
		});
		assert.equal(escRes.ok, true, escRes.error ?? '');
		drainStack(state);
		assert.equal(
			p1.battlefield.some((c) => c.instanceId === gyBear.instanceId),
			true
		);
		assert.equal(p1.exile.length >= 3, true);

		// 4. Dream Devourer grantHandForetell + cast on later turn even after granter leaves
		const devourer = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Dream Weaver',
				manaCost: '{1}{B}',
				cmc: 2,
				typeLine: 'Creature — Demon',
				power: '0',
				toughness: '3',
				oracleText:
					'Each nonland card in your hand without foretell has foretell. Its foretell cost is equal to its mana cost reduced by {2}.'
			}),
			'battlefield'
		);
		const bigWurm = putInZone(
			state,
			p1,
			synthCard({
				name: 'Synth Dusk Wurm',
				manaCost: '{3}{G}',
				cmc: 4,
				typeLine: 'Creature — Wurm',
				power: '4',
				toughness: '4'
			}),
			'hand'
		);
		p1.manaPool.C = 2;
		const ftRes = applyGameAction(state, p1.playerId, {
			type: 'hand_special_action',
			instanceId: bigWurm.instanceId,
			actionId: 'special:foretell'
		});
		assert.equal(ftRes.ok, true, ftRes.error ?? '');
		assert.equal(bigWurm.zone, 'exile');
		assert.equal(bigWurm.isFaceDown, true);
		assert.equal(bigWurm.foretoldByPlayerId, p1.playerId);
		assert.equal(bigWurm.grantedForetellCost, '{1}{G}');

		// Remove Dream Devourer & advance turnNumber; foretold card retains locked-in cost {1}{G} (CR 702.143f)!
		moveObject(state, devourer, 'graveyard', {
			from: { player: p1, zone: 'battlefield' },
			toPlayer: p1
		});
		state.turnNumber += 1;
		noteLayerInputsChanged(state);
		p1.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 1, C: 1 };

		const exileOpts = getCastOptions(state, p1.playerId, bigWurm, 'exile');
		assert.equal(exileOpts.length >= 1, true, `Expected foretell exile CastOption, got ${JSON.stringify(exileOpts)}`);

		const castFt = applyGameAction(state, p1.playerId, {
			type: 'cast_spell',
			instanceId: bigWurm.instanceId,
			fromZone: 'exile',
			optionId: exileOpts[0].id
		});
		assert.equal(castFt.ok, true, castFt.error ?? '');
		drainStack(state);
		const wurmBf = p1.battlefield.find((c) => c.instanceId === bigWurm.instanceId);
		assert.ok(wurmBf);
		assert.equal(wurmBf.foretold, true);

		// 5. JSON round-trip & rename invariance check (ENGINE_INVARIANTS.md §1.2, §1.3)
		const roundTripped: GameState = JSON.parse(JSON.stringify(state));
		assert.equal(
			roundTripped.players[0].battlefield.some((c) => c.instanceId === bigWurm.instanceId),
			true
		);
		const renamed = synthCard({
			...devourer.card,
			name: 'Completely Different Arbitrary Name Zeta'
		});
		assert.equal(definitionSupportReport(compileCard(renamed)).fullySupported, true);
	});
});
