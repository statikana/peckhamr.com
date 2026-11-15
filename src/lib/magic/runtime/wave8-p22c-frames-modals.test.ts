import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard, clearCompileCache } from '../compiler/index.ts';
import { isAbilityOrFlavorWord, normalizeFace } from '../compiler/normalize.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	hasKeyword
} from '../engine.ts';
import { OVERRIDES_BY_ORACLE_ID } from '../overrides/index.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { moveObject } from './zones.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type DeckCardEntry,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';

let synthSeq = 0;

function synthCard(
	overrides: Partial<ScryfallCard> & { name: string; backFace?: ScryfallCard['backFace'] }
): ScryfallCard {
	synthSeq += 1;
	const id = overrides.id ?? `syn_p22c_${synthSeq}`;
	return {
		id,
		oracleId: overrides.oracleId ?? `ora_p22c_${synthSeq}`,
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
		defense: overrides.defense,
		colorIndicator: overrides.colorIndicator,
		imageUrl: '',
		artCropUrl: '',
		legalCommander: overrides.legalCommander ?? true,
		canBeCommander:
			overrides.canBeCommander ?? Boolean(overrides.typeLine?.includes('Legendary Creature')),
		hasPartner: overrides.hasPartner ?? false,
		hasChooseBackground: overrides.hasChooseBackground ?? false,
		isBackground: overrides.isBackground ?? false,
		...(overrides.setType ? { setType: overrides.setType } : {}),
		layout: overrides.layout ?? 'normal',
		...(overrides.faces ? { faces: overrides.faces } : {}),
		...(overrides.backFace ? { backFace: overrides.backFace } : {})
	};
}

function makeDeck(cards: ScryfallCard[], commanders: ScryfallCard[] = []): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_p22c_${++synthSeq}`,
		userId: 'p1',
		name: 'Track P22c Deck',
		description: '',
		commanders,
		cards: entries,
		colorIdentity: ['W', 'U', 'B', 'R', 'G'],
		cardCount: entries.length + commanders.length,
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
		playerCount?: 2 | 3;
		p1Commanders?: ScryfallCard[];
		p1Bot?: boolean;
		p2Bot?: boolean;
	} = {}
): {
	state: GameState;
	players: PlayerGameState[];
	p1: PlayerGameState;
	p2: PlayerGameState;
} {
	const filler = synthCard({
		name: 'Sunlit Meadow',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const count = opts.playerCount ?? 2;
	const seats: LobbySeat[] = [];
	const decks = new Map<number, MagicDeck>();
	for (let i = 0; i < count; i++) {
		const d = makeDeck(
			Array.from({ length: 25 }, () => filler),
			i === 0 ? (opts.p1Commanders ?? []) : []
		);
		decks.set(i, d);
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `Player${i + 1}`,
			avatarUrl: '',
			isBot: i === 0 ? Boolean(opts.p1Bot) : i === 1 ? Boolean(opts.p2Bot) : false,
			deckId: d.id,
			deckName: d.name,
			commanderNames: d.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		});
	}
	const state = createInitialGameState('P22C', seats, decks, DEFAULT_LOBBY_RULES);
	for (const p of state.players) {
		if (state.status === 'mulligan') {
			applyGameAction(state, p.playerId, { type: 'mulligan_keep' });
		}
	}
	state.status = 'active';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.phase = 'main1';
	state.passedPriorityPlayerIds = [];
	for (const p of state.players) {
		p.hasKeptHand = true;
		p.hand = [];
	}
	return { state, players: state.players, p1: state.players[0], p2: state.players[1] };
}

function putInZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library',
	opts: { isCommander?: boolean; summoningSick?: boolean; counters?: Record<string, number> } = {}
): CardInstance {
	state.nextTimestamp = (state.nextTimestamp ?? 1) + 1;
	const inst = createCardInstance(
		card,
		player.playerId,
		zone,
		Boolean(opts.isCommander),
		false,
		state.nextTimestamp
	);
	if (zone === 'battlefield') {
		inst.summoningSick = opts.summoningSick ?? false;
		inst.enteredTurnSerial = state.turnSerial ?? state.turnNumber;
	}
	if (opts.counters) {
		inst.counters = { ...inst.counters, ...opts.counters };
	}
	if (zone === 'library') {
		player.library.unshift(inst);
	} else {
		player[zone].push(inst);
	}
	noteLayerInputsChanged(state);
	return inst;
}

function giveMana(player: PlayerGameState, pool: Partial<Record<ManaColor | 'C', number>>): void {
	for (const [k, v] of Object.entries(pool)) {
		if (typeof v === 'number') {
			player.manaPool[k as ManaColor | 'C'] = (player.manaPool[k as ManaColor | 'C'] ?? 0) + v;
		}
	}
}

function resolveTopOfStack(state: GameState): void {
	for (let guard = 0; guard < 32; guard++) {
		if (state.pendingPrompts.length > 0 && state.pendingPrompts[0].purpose === 'trigger_order') {
			const prm = state.pendingPrompts[0];
			const res = applyGameAction(state, prm.playerId, {
				type: 'choice',
				promptId: prm.id,
				answer: { kind: 'orderObjects', topIds: prm.candidateInstanceIds ?? [] }
			});
			assert.equal(res.ok, true, res.ok ? '' : (res.error ?? 'failed'));
			continue;
		}
		if (state.pendingPrompts.length > 0) return;
		if (state.stack.length === 0) return;
		const actor = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, actor.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true, res.ok ? '' : (res.error ?? 'failed'));
	}
}

function roundTripState(state: GameState): GameState {
	return JSON.parse(JSON.stringify(state)) as GameState;
}

function assertUsesOverride(card: ScryfallCard): void {
	clearCompileCache();
	const oid = card.oracleId!;
	const entry = OVERRIDES_BY_ORACLE_ID.get(oid);
	assert.ok(entry, `Missing override entry for ${card.name} (${oid})`);
	const def = compileCard(card);
	assert.equal(
		def.textHash,
		entry.expectedTextHash,
		`Text hash mismatch for ${card.name}: got ${def.textHash}, expected ${entry.expectedTextHash}`
	);
	assert.equal(def.fullySupported, true);
	assert.equal(definitionSupportReport(def).fullySupported, true);
}

describe('Wave 8 Track P22c: Short-Name Normalization, Bullet Flavor Words, Modals, & Curated Overrides', () => {
	it('normalizes Unicode, Roman-numeral, epithet, and rank+surname legendary short names safely', () => {
		clearCompileCache();

		// Unicode accented single-word legendary short name + synthetic rename invariance
		const cirdanA = normalizeFace(
			'Círdan the Shipwright',
			'Whenever Círdan attacks, each player votes.\nWhenever Círdan enters, draw a card.',
			true
		);
		assert.equal(cirdanA.text, 'Whenever ~ attacks, each player votes.\nWhenever ~ enters, draw a card.');

		const eomer = normalizeFace(
			'Éomer, King of Rohan',
			'When Éomer enters, target creature gains haste until end of turn.',
			true
		);
		assert.equal(eomer.text, 'When ~ enters, target creature gains haste until end of turn.');

		// Multi-word prefix + comma-separated / epithet names
		const rosie = normalizeFace(
			'Rosie Cotton of South Lane',
			'Whenever you create a token, put a +1/+1 counter on target creature you control other than Rosie Cotton.',
			true
		);
		assert.ok(rosie.text.includes('other than ~.'));

		// Rank + surname fallback ("Ensign Harry Kim" -> "Ensign Kim")
		const ensign = normalizeFace(
			'Ensign Harry Kim',
			'Whenever Ensign Kim attacks, draw a card.',
			true
		);
		assert.equal(ensign.text, 'Whenever ~ attacks, draw a card.');

		// Planeswalker / two-word legendary fallback ("Henrika Domnathi" / "Kaito Shizuki")
		const kaito = normalizeFace(
			'Kaito Shizuki',
			'+1: Draw a card if Kaito attacked this turn.',
			true
		);
		assert.equal(kaito.text, '+1: Draw a card if ~ attacked this turn.');

		// NEGATIVE: Never corrupt "named Ajani's Pridemate" or possessive created token names like "Tamiyo's Notebook"
		const ajani = normalizeFace(
			'Ajani, Nacatl Pariah',
			"Whenever Ajani enters, create a 2/1 white Cat Warrior creature token.\nPut a +1/+1 counter on a creature named Ajani's Pridemate.",
			true
		);
		assert.equal(
			ajani.text,
			"Whenever ~ enters, create a 2/1 white Cat Warrior creature token.\nPut a +1/+1 counter on a creature named Ajani's Pridemate."
		);

		const tamiyo = normalizeFace(
			'Tamiyo, Collector of Tales',
			"When Tamiyo enters, create Tamiyo's Notebook, a legendary colorless Artifact token.",
			true
		);
		assert.equal(
			tamiyo.text,
			"When ~ enters, create Tamiyo's Notebook, a legendary colorless Artifact token."
		);

		// Synthetic rename invariance: compiled IR matches under renamed card
		const origCard = synthCard({
			name: 'Éomer, Marshal of the Mark',
			manaCost: '{2}{R}{R}',
			typeLine: 'Legendary Creature — Human Noble',
			oracleText: 'Haste\nWhenever Éomer enters, draw a card.'
		});
		const renamedCard = synthCard({
			name: 'Velloran, Marshal of the Mark',
			manaCost: '{2}{R}{R}',
			typeLine: 'Legendary Creature — Human Noble',
			oracleText: 'Haste\nWhenever Velloran enters, draw a card.'
		});
		assert.deepEqual(
			compileCard(origCard).faces[0].abilities,
			compileCard(renamedCard).faces[0].abilities
		);
	});

	it('extracts • <Flavor> — <Body> metadata safely while guarding Saga numerals and Tiered lines', () => {
		// Guard against Saga numerals
		assert.equal(isAbilityOrFlavorWord('I'), false);
		assert.equal(isAbilityOrFlavorWord('I, II'), false);
		assert.equal(isAbilityOrFlavorWord('III'), false);
		assert.equal(isAbilityOrFlavorWord("Murdock's Crusade"), true);
		assert.equal(isAbilityOrFlavorWord('Déjà Vu'), true);

		const norm = normalizeFace(
			'Test Modal Hero',
			"Choose one —\n• Murdock's Crusade — Draw a card.\n• Test Modal Hero — You gain 2 life.\n• {1} — Scry 1."
		);
		const bulletLines = norm.lines.filter((l) => l.text.startsWith('•'));
		assert.equal(bulletLines.length, 3);
		assert.equal(bulletLines[0].abilityWord, "Murdock's Crusade");
		assert.equal(bulletLines[0].body, 'Draw a card.');
		assert.equal(bulletLines[0].text, "• Murdock's Crusade — Draw a card.");
		assert.equal(bulletLines[1].abilityWord, '~');
		assert.equal(bulletLines[1].body, 'You gain 2 life.');
		// Costed Tiered bullet ("• {1} — Scry 1.") is NOT treated as a flavor word
		assert.equal(bulletLines[2].abilityWord, undefined);

		// End-to-end compilation of flavor-worded and Unicode modal card
		const flavorModal = synthCard({
			name: 'Heroic Trio',
			manaCost: '{2}{W}',
			typeLine: 'Instant',
			oracleText:
				"Choose one —\n• Murdock's Crusade — Draw a card.\n• Déjà Vu — You gain 3 life."
		});
		const def = compileCard(flavorModal);
		assert.equal(def.fullySupported, true);
	});

	it('supports Wave 8 modal riders: teamwork, additionalCostPaid, conditionalChooseRange, conditionalNotRandom, cantBeCopied, differentPlayerTargetsPerMode, & reflexive modal triggers', () => {
		clearCompileCache();

		// 1) Teamwork ("if ~ was cast using teamwork, choose both instead")
		{
			const { state, p1 } = setupGame();
			const partner = putInZone(
				state,
				p1,
				synthCard({
					name: 'Heroic Ally',
					typeLine: 'Creature — Human',
					oracleText: '',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const teamworkSpell = synthCard({
				name: 'Paired Strike',
				manaCost: '{1}{G}',
				cmc: 2,
				typeLine: 'Sorcery',
				oracleText:
					'Teamwork 2 (As an additional cost to cast this spell, you may tap any number of creatures you control with total power 2 or more.)\nChoose one. If this spell was cast using teamwork, choose both instead.\n• Draw a card.\n• You gain 3 life.',
				colors: ['G'],
				keywords: ['Teamwork']
			});
			assert.equal(compileCard(teamworkSpell).fullySupported, true);
			const inst = putInZone(state, p1, teamworkSpell, 'hand');
			giveMana(p1, { G: 2 });
			const opts = getCastOptions(state, p1.playerId, inst, 'hand');
			const baseOpt = opts.find((o) => o.baseCost.kind === 'printed')!;
			assert.ok(baseOpt);

			// Base cast cannot pick both modes
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: inst.instanceId,
					optionId: baseOpt.id,
					modes: [0, 1]
				}).ok,
				false
			);
			// Teamwork cast CAN pick both modes (paying Teamwork 2 by tapping Heroic Ally)!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: inst.instanceId,
					optionId: baseOpt.id,
					optionalCostCounts: { 'teamwork:0': 1 },
					costPayment: { objects: [[partner.instanceId]] },
					modes: [0, 1]
				}).ok,
				true
			);
			assert.equal(partner.tapped, true);
			const handBefore = p1.hand.length;
			const lifeBefore = p1.life;
			resolveTopOfStack(state);
			assert.equal(p1.hand.length, handBefore + 1);
			assert.equal(p1.life, lifeBefore + 3);
		}

		// 2) Pyrrhic Strike-style optional additionalCostPaid ("If ~'s additional cost was paid, choose both instead")
		{
			const { state, p1, p2 } = setupGame();
			const creature = putInZone(
				state,
				p1,
				synthCard({
					name: 'Blight Host',
					typeLine: 'Creature — Elf',
					oracleText: '',
					power: '3',
					toughness: '3'
				}),
				'battlefield'
			);
			const oppArtifact = putInZone(
				state,
				p2,
				synthCard({
					name: 'Relic',
					typeLine: 'Artifact',
					oracleText: ''
				}),
				'battlefield'
			);
			const oppCreature = putInZone(
				state,
				p2,
				synthCard({
					name: 'Target Bear',
					typeLine: 'Creature — Bear',
					oracleText: '',
					power: '2',
					toughness: '2'
				}),
				'battlefield'
			);
			const pyrrhic = synthCard({
				name: 'Dual Ruin',
				manaCost: '{2}{B}',
				typeLine: 'Instant',
				oracleText:
					"As an additional cost to cast this spell, you may blight 2. (You may put two -1/-1 counters on a creature you control.)\nChoose one. If this spell's additional cost was paid, choose both instead —\n• Destroy target creature.\n• Destroy target artifact.",
				colors: ['B']
			});
			assert.equal(compileCard(pyrrhic).fullySupported, true);
			const inst = putInZone(state, p1, pyrrhic, 'hand');
			giveMana(p1, { B: 3 });

			// Without additional cost (decline optional blight via options: [1]) -> both modes forbidden
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: inst.instanceId,
					modes: [0, 1],
					costPayment: { options: [1] },
					targets: [
						{ kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name },
						{ kind: 'permanent', id: oppArtifact.instanceId, label: oppArtifact.card.name }
					]
				}).ok,
				false
			);
			// With additional cost (accept optional blight 2 via options: [0]) -> both modes succeed
			const castRes = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: inst.instanceId,
				modes: [0, 1],
				costPayment: { options: [0], objects: [[creature.instanceId]] },
				targets: [
					{ kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name },
					{ kind: 'permanent', id: oppArtifact.instanceId, label: oppArtifact.card.name }
				]
			});
			assert.equal(castRes.ok, true, castRes.ok ? '' : (castRes.error ?? 'failed'));
			assert.equal(creature.counters['-1/-1'], 2);
			resolveTopOfStack(state);
			assert.equal(oppCreature.zone, 'graveyard');
			assert.equal(oppArtifact.zone, 'graveyard');
		}

		// 3) Flame of Anor-style conditionalChooseRange ("Choose one. If you control a Wizard..., you may choose two instead")
		{
			const { state, p1, p2 } = setupGame();
			const flame = synthCard({
				name: 'Arcane Flame',
				manaCost: '{1}{U}{R}',
				typeLine: 'Instant',
				oracleText:
					'Choose one. If you control a Wizard as you cast this spell, you may choose two instead.\n• Target player draws two cards.\n• Destroy target artifact.\n• ~ deals 5 damage to target creature.',
				colors: ['U', 'R']
			});
			assert.equal(compileCard(flame).fullySupported, true);
			const fInst = putInZone(state, p1, flame, 'hand');
			const targetBear = putInZone(
				state,
				p2,
				synthCard({ name: 'Target Beast', typeLine: 'Creature — Beast', oracleText: '', power: '4', toughness: '5' }),
				'battlefield'
			);

			giveMana(p1, { U: 1, R: 2 });
			// Without Wizard -> choosing 2 modes fails
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: fInst.instanceId,
					modes: [0, 2],
					targets: [
						{ kind: 'player', id: p1.playerId, label: p1.username },
						{ kind: 'permanent', id: targetBear.instanceId, label: targetBear.card.name }
					]
				}).ok,
				false
			);

			// Add a Wizard -> choosing 2 modes succeeds!
			putInZone(
				state,
				p1,
				synthCard({ name: 'Sage', typeLine: 'Creature — Human Wizard', oracleText: '', power: '1', toughness: '1' }),
				'battlefield'
			);
			const handBefore = p1.hand.length;
			const res = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: fInst.instanceId,
				modes: [0, 2],
				targets: [
					{ kind: 'player', id: p1.playerId, label: p1.username },
					{ kind: 'permanent', id: targetBear.instanceId, label: targetBear.card.name }
				]
			});
			assert.equal(res.ok, true, res.ok ? '' : (res.error ?? 'failed'));
			resolveTopOfStack(state);
			assert.equal(p1.hand.length, handBefore - 1 + 2);
			assert.equal(targetBear.zone, 'graveyard');
		}

		// 4) Typhoid Mary, Fractured ("at random unless you've discarded a card this turn") + Gnostro ("X is spells cast") + cantBeCopied
		{
			const mary = synthCard({
				name: 'Random Unless Discard',
				manaCost: '{2}{B}',
				typeLine: 'Instant',
				oracleText:
					'Choose one at random. If you discarded a card this turn, you choose one instead —\n• Draw a card.\n• Each opponent loses 2 life.',
				colors: ['B']
			});
			const gnostro = synthCard({
				name: 'Spell Scaling',
				manaCost: '{U}',
				typeLine: 'Instant',
				oracleText:
					"Choose one. X is the number of spells you've cast this turn.\n• You gain X life.\n• Scry X.",
				colors: ['U']
			});
			const uncopiable = synthCard({
				name: 'Singular Spell',
				manaCost: '{1}{U}',
				typeLine: 'Instant',
				oracleText: "~ can't be copied.\nDraw a card.",
				colors: ['U']
			});
			assert.equal(compileCard(mary).fullySupported, true);
			assert.equal(compileCard(gnostro).fullySupported, true);
			assert.equal(compileCard(uncopiable).fullySupported, true);

			// Check youDiscardedThisTurn turns off random mode selection
			const { state, p1, p2 } = setupGame();
			const discardedCard = putInZone(
				state,
				p1,
				synthCard({ name: 'Fodder', typeLine: 'Instant', oracleText: '' }),
				'hand'
			);
			discardedCard.discardedByPlayerIdThisTurn = p1.playerId;
			discardedCard.discardedTurnSerial = state.turnSerial ?? state.turnNumber;
			moveObject(state, discardedCard, 'graveyard', {
				from: { player: p1, zone: 'hand' },
				toPlayer: p1
			});
			const mInst = putInZone(state, p1, mary, 'hand');
			giveMana(p1, { B: 3 });
			const mCast = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: mInst.instanceId,
				modes: [1]
			});
			assert.equal(mCast.ok, true, mCast.ok ? '' : (mCast.error ?? 'failed'));
			assert.deepEqual(state.stack[0].chosenModes, [1]);
			resolveTopOfStack(state);
			assert.equal(p2.life, 38);

			// Gnostro runtime X scaling: cast 1 dummy spell then Spell Scaling (spellsCastThisTurn = 1+1 = 2) -> gain 2 life
			const gInst = putInZone(state, p1, gnostro, 'hand');
			const p1LifeBeforeG = p1.life;
			giveMana(p1, { U: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: gInst.instanceId,
					modes: [0]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(p1.life, p1LifeBeforeG + 2, 'Gnostro dynamicXAmount scales with spellsCastThisTurn');

			// Verify cantBeCopied blocks Twincast-style copySpell
			const singInst = putInZone(state, p1, uncopiable, 'hand');
			const copySpellCard = synthCard({
				name: 'Twin Copy',
				manaCost: '{U}{U}',
				typeLine: 'Instant',
				oracleText: 'Copy target instant or sorcery spell.',
				colors: ['U']
			});
			const copyInst = putInZone(state, p1, copySpellCard, 'hand');
			giveMana(p1, { U: 4 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: singInst.instanceId }).ok, true);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: copyInst.instanceId,
					targets: [{ kind: 'stack', id: state.stack[0].id, label: state.stack[0].title }]
				}).ok,
				true
			);
			const handBeforeSing = p1.hand.length;
			// Pass priority once to resolve Twin Copy — Singular Spell must NOT be copied!
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });
			assert.equal(state.stack.length, 1, 'Uncopiable spell must not produce a copy on the stack');
			// Resolve Singular Spell -> draws 1 card (not 2)
			resolveTopOfStack(state);
			assert.equal(p1.hand.length, handBeforeSing + 1);
		}

		// 5) differentPlayerTargetsPerMode ("Each mode must target a different player")
		{
			const { state, players, p1, p2 } = setupGame({ playerCount: 3 });
			const p3 = players[2];
			const lich = synthCard({
				name: 'Three Player Modal',
				manaCost: '{3}{B}',
				typeLine: 'Sorcery',
				oracleText:
					'Choose two. Each mode must target a different player —\n• Target player discards a card.\n• Target player loses 3 life.\n• Target player draws a card.',
				colors: ['B']
			});
			assert.equal(compileCard(lich).fullySupported, true);
			const lInst = putInZone(state, p1, lich, 'hand');
			giveMana(p1, { B: 4 });

			// Picking same player (p2) for both modes must fail!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: lInst.instanceId,
					modes: [1, 2],
					targets: [
						{ kind: 'player', id: p2.playerId, label: p2.username },
						{ kind: 'player', id: p2.playerId, label: p2.username }
					]
				}).ok,
				false
			);

			// Picking distinct players (p2 and p3) succeeds!
			const p3HandBefore = p3.hand.length;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: lInst.instanceId,
					modes: [1, 2],
					targets: [
						{ kind: 'player', id: p2.playerId, label: p2.username },
						{ kind: 'player', id: p3.playerId, label: p3.username }
					]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(p2.life, 37);
			assert.equal(p3.hand.length, p3HandBefore + 1);
		}

		// 6) Reflexive modal trigger ("When you do, choose one — ...")
		{
			const { state, p1, p2 } = setupGame();
			const hyldaCard = synthCard({
				name: 'Frost Crown Queen',
				manaCost: '{2}{W}{U}',
				typeLine: 'Legendary Creature — Human Wizard',
				oracleText:
					"Whenever you tap an untapped creature an opponent controls, you may pay {1}. When you do, choose one —\n• Create a 4/4 white and blue Elemental creature token.\n• Put a +1/+1 counter on each creature you control.\n• Scry 2, then draw a card.",
				power: '3',
				toughness: '4',
				colors: ['W', 'U']
			});
			assert.equal(compileCard(hyldaCard).fullySupported, true);
			const queen = putInZone(state, p1, hyldaCard, 'battlefield');
			const oppCreature = putInZone(
				state,
				p2,
				synthCard({ name: 'Target Soldier', typeLine: 'Creature — Soldier', oracleText: '', power: '2', toughness: '2' }),
				'battlefield'
			);
			const tapper = putInZone(
				state,
				p1,
				synthCard({
					name: 'Icy Tapper',
					manaCost: '{U}',
					typeLine: 'Instant',
					oracleText: 'Tap target creature.',
					colors: ['U']
				}),
				'hand'
			);
			giveMana(p1, { U: 2 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: tapper.instanceId,
					targets: [{ kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name }]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			// Accept optional pay {1} prompt
			assert.equal(state.pendingPrompts.length, 1);
			const payPrm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: payPrm.id,
					answer: { kind: 'yesNo', yes: true }
				}).ok,
				true
			);
			// Reflexive trigger mode selection prompt appears
			assert.equal(state.pendingPrompts.length, 1);
			const modePrm = state.pendingPrompts[0];
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: modePrm.id,
					answer: { kind: 'chooseMode', indices: [1] }
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(queen.counters['+1/+1'], 1);
		}
	});

	it('executes all 19 Wave 8 curated JSON overrides end-to-end with state JSON round-trip', () => {
		clearCompileCache();

		// 1) Victimize
		{
			const { state, p1 } = setupGame();
			const sacFodder = putInZone(
				state,
				p1,
				synthCard({ name: 'Thrull', typeLine: 'Creature — Thrull', oracleText: '', power: '1', toughness: '1' }),
				'battlefield'
			);
			const gy1 = putInZone(
				state,
				p1,
				synthCard({ name: 'Titan A', typeLine: 'Creature — Giant', oracleText: '', power: '6', toughness: '6' }),
				'graveyard'
			);
			const gy2 = putInZone(
				state,
				p1,
				synthCard({ name: 'Titan B', typeLine: 'Creature — Giant', oracleText: '', power: '6', toughness: '6' }),
				'graveyard'
			);
			const victimize = synthCard({
				oracleId: '240e85d3-e495-4877-8609-4b4056c402f7',
				name: 'Victimize',
				manaCost: '{2}{B}',
				typeLine: 'Sorcery',
				oracleText:
					'Choose two target creature cards in your graveyard. Sacrifice a creature. If you do, return the chosen cards to the battlefield tapped.',
				colors: ['B']
			});
			assertUsesOverride(victimize);
			const vInst = putInZone(state, p1, victimize, 'hand');
			giveMana(p1, { B: 3 });
			const res = applyGameAction(state, p1.playerId, {
				type: 'cast_spell',
				instanceId: vInst.instanceId,
				targets: [
					{ kind: 'graveyard_card', id: gy1.instanceId, label: gy1.card.name },
					{ kind: 'graveyard_card', id: gy2.instanceId, label: gy2.card.name }
				]
			});
			assert.equal(res.ok, true, res.ok ? '' : (res.error ?? 'failed'));
			const rt = roundTripState(state);
			resolveTopOfStack(rt);
			assert.equal(rt.players[0].graveyard.some((c) => c.instanceId === sacFodder.instanceId), true);
			const bf1 = rt.players[0].battlefield.find((c) => c.instanceId === gy1.instanceId)!;
			const bf2 = rt.players[0].battlefield.find((c) => c.instanceId === gy2.instanceId)!;
			assert.ok(bf1 && bf2);
			assert.equal(bf1.tapped, true);
			assert.equal(bf2.tapped, true);
		}

		// 2) Windfall
		{
			const { state, p1, p2 } = setupGame();
			for (let i = 0; i < 3; i++) {
				putInZone(state, p1, synthCard({ name: `P1Card${i}`, typeLine: 'Instant', oracleText: '' }), 'hand');
			}
			for (let i = 0; i < 1; i++) {
				putInZone(state, p2, synthCard({ name: `P2Card${i}`, typeLine: 'Instant', oracleText: '' }), 'hand');
			}
			const windfall = synthCard({
				oracleId: '08becc07-28bc-4a2f-a6b0-28a2998d2f50',
				name: 'Windfall',
				manaCost: '{2}{U}',
				typeLine: 'Sorcery',
				oracleText:
					'Each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way.',
				colors: ['U']
			});
			assertUsesOverride(windfall);
			const wInst = putInZone(state, p1, windfall, 'hand');
			giveMana(p1, { U: 3 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wInst.instanceId }).ok, true);
			resolveTopOfStack(state);
			// p1 had 3 cards in hand when Windfall resolved (4 minus Windfall), p2 had 1 -> both draw 3!
			assert.equal(p1.hand.length, 3);
			assert.equal(p2.hand.length, 3);
		}

		// 3) Worldly Tutor
		{
			const { state, p1 } = setupGame();
			const targetCre = putInZone(
				state,
				p1,
				synthCard({ name: 'Craterhoof', typeLine: 'Creature — Beast', oracleText: '', power: '5', toughness: '5' }),
				'library'
			);
			const wt = synthCard({
				oracleId: 'e8863518-0bfa-49c3-8c6e-6c9116a81051',
				name: 'Worldly Tutor',
				manaCost: '{G}',
				typeLine: 'Instant',
				oracleText: 'Search your library for a creature card, reveal it, then shuffle and put the card on top.',
				colors: ['G']
			});
			assertUsesOverride(wt);
			const wtInst = putInZone(state, p1, wt, 'hand');
			giveMana(p1, { G: 1 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: wtInst.instanceId }).ok, true);
			resolveTopOfStack(state);
			assert.equal(state.pendingPrompts[0]?.purpose, 'search_library');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [targetCre.instanceId] }
				}).ok,
				true
			);
			assert.equal(p1.library[0].instanceId, targetCre.instanceId);
		}

		// 4) Akroma's Will (uses P22c conditionalChooseRange when controlling commander)
		{
			const cmdCard = synthCard({
				name: 'Akroma Commander',
				typeLine: 'Legendary Creature — Angel',
				oracleText: '',
				power: '4',
				toughness: '4'
			});
			const { state, p1 } = setupGame({ p1Commanders: [cmdCard] });
			const cmdPerm = putInZone(state, p1, cmdCard, 'battlefield', { isCommander: true });
			const akromasWill = synthCard({
				oracleId: 'fd949f82-fc10-4e37-8aa9-6c7569fe3c55',
				name: "Akroma's Will",
				manaCost: '{3}{W}',
				typeLine: 'Instant',
				oracleText:
					'Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Creatures you control gain flying, vigilance, and double strike until end of turn.\n• Creatures you control gain lifelink, indestructible, and protection from each color until end of turn.',
				colors: ['W']
			});
			assertUsesOverride(akromasWill);
			const awInst = putInZone(state, p1, akromasWill, 'hand');
			giveMana(p1, { W: 4 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: awInst.instanceId,
					modes: [0, 1]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(hasKeyword(cmdPerm, 'Flying', state), true);
			assert.equal(hasKeyword(cmdPerm, 'Double strike', state), true);
			assert.equal(hasKeyword(cmdPerm, 'Indestructible', state), true);
			assert.equal(hasKeyword(cmdPerm, 'Protection from red', state), true);
		}

		// 5) Tireless Provisioner + 6) Mirkwood Bats
		{
			const { state, p1, p2 } = setupGame();
			const prov = synthCard({
				oracleId: 'ab8d5f5c-1976-4f77-8ed2-8d28ee666741',
				name: 'Tireless Provisioner',
				manaCost: '{2}{G}',
				typeLine: 'Creature — Elf Scout',
				oracleText:
					'Landfall — Whenever a land you control enters, create a Food token or a Treasure token. (Food is an artifact with "{2}, {T}, Sacrifice this token: You gain 3 life." Treasure is an artifact with "{T}, Sacrifice this token: Add one mana of any color.")',
				power: '3',
				toughness: '2',
				colors: ['G']
			});
			const bats = synthCard({
				oracleId: '0636b6c3-0662-420a-b30d-f0a14e7c512d',
				name: 'Mirkwood Bats',
				manaCost: '{3}{B}',
				typeLine: 'Creature — Bat',
				oracleText: 'Flying\nWhenever you create or sacrifice a token, each opponent loses 1 life.',
				power: '2',
				toughness: '3',
				colors: ['B']
			});
			assertUsesOverride(prov);
			assertUsesOverride(bats);
			putInZone(state, p1, prov, 'battlefield');
			putInZone(state, p1, bats, 'battlefield');
			const forest = putInZone(
				state,
				p1,
				synthCard({ name: 'Forest', typeLine: 'Basic Land — Forest', oracleText: '({T}: Add {G}.)' }),
				'hand'
			);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: forest.instanceId }).ok, true);
			assert.equal(state.pendingPrompts[0]?.purpose, 'trigger_modes');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseMode', indices: [1] } // Treasure token
				}).ok,
				true
			);
			resolveTopOfStack(state); // resolves Landfall -> creates Treasure -> triggers Mirkwood Bats -> resolves drain!
			const treasure = p1.battlefield.find((c) => c.card.name === 'Treasure');
			assert.ok(treasure, 'Tireless Provisioner created Treasure token');
			assert.equal(p2.life, 39, 'Mirkwood Bats drained opponent on token creation');

			// Sacrificing Treasure for mana triggers Mirkwood Bats again!
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'tap_mana',
					instanceId: treasure.instanceId,
					preferredColor: 'W'
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(p2.life, 38, 'Mirkwood Bats drained opponent on token sacrifice');
		}

		// 7) Gamble + 8) Inspiring Call + 9) Aetherflux Reservoir
		{
			const { state, p1, p2 } = setupGame();
			const bolt = putInZone(
				state,
				p1,
				synthCard({ name: 'Lightning', typeLine: 'Instant', oracleText: '' }),
				'library'
			);
			const gamble = synthCard({
				oracleId: 'a54f0869-94c8-42af-9080-166efb9486a4',
				name: 'Gamble',
				manaCost: '{R}',
				typeLine: 'Sorcery',
				oracleText: 'Search your library for a card, put that card into your hand, discard a card at random, then shuffle.',
				colors: ['R']
			});
			assertUsesOverride(gamble);
			const gInst = putInZone(state, p1, gamble, 'hand');
			giveMana(p1, { R: 1 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: gInst.instanceId }).ok, true);
			resolveTopOfStack(state);
			assert.equal(state.pendingPrompts[0]?.purpose, 'search_library');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [bolt.instanceId] }
				}).ok,
				true
			);
			// Hand was empty except Bolt tutored in, so random discard discards Bolt!
			assert.equal(p1.hand.length, 0);
			assert.equal(p1.graveyard.some((c) => c.instanceId === bolt.instanceId), true);

			// Inspiring Call
			const bearWithCounter = putInZone(
				state,
				p1,
				synthCard({ name: 'Marked Bear', typeLine: 'Creature — Bear', oracleText: '', power: '2', toughness: '2' }),
				'battlefield',
				{ counters: { '+1/+1': 1 } }
			);
			const call = synthCard({
				oracleId: '9b9a10ff-5a5d-4df8-88aa-18d84ff9117c',
				name: 'Inspiring Call',
				manaCost: '{2}{G}',
				typeLine: 'Instant',
				oracleText:
					'Draw a card for each creature you control with a +1/+1 counter on it. Those creatures gain indestructible until end of turn. (Damage and effects that say "destroy" don\'t destroy them.)',
				colors: ['G']
			});
			assertUsesOverride(call);
			const cInst = putInZone(state, p1, call, 'hand');
			giveMana(p1, { G: 3 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: cInst.instanceId }).ok, true);
			resolveTopOfStack(state);
			assert.equal(p1.hand.length, 1);
			assert.equal(hasKeyword(bearWithCounter, 'Indestructible', state), true);

			// Aetherflux Reservoir
			const reservoir = synthCard({
				oracleId: '5f15125e-ae89-471e-b055-226a783bc7c1',
				name: 'Aetherflux Reservoir',
				manaCost: '{4}',
				typeLine: 'Artifact',
				oracleText:
					"Whenever you cast a spell, you gain 1 life for each spell you've cast this turn.\nPay 50 life: This artifact deals 50 damage to any target."
			});
			assertUsesOverride(reservoir);
			const resPerm = putInZone(state, p1, reservoir, 'battlefield');
			const dummySpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Optic', manaCost: '{0}', typeLine: 'Instant', oracleText: 'Draw a card.' }),
				'hand'
			);
			const lifeBefore = p1.life;
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: dummySpell.instanceId }).ok, true);
			// Reservoir triggers on spell cast (3rd spell cast this turn: Gamble, Inspiring Call, Optic -> gains 3!)
			resolveTopOfStack(state);
			assert.equal(p1.life, lifeBefore + 3);
			p1.life = 55;
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'activate_ability',
					instanceId: resPerm.instanceId,
					abilityId: 'act_1',
					targets: [{ kind: 'player', id: p2.playerId, label: p2.username }]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(p1.life, 5);
			assert.equal(p2.life, -10);
		}

		// 10) Field of the Dead + 11) Grave Pact + 12) Champion of Lambholt
		{
			const { state, p1, p2 } = setupGame();
			const fotd = synthCard({
				oracleId: 'aa959340-c869-4caa-92c7-572bd8d23eef',
				name: 'Field of the Dead',
				manaCost: '',
				typeLine: 'Land',
				oracleText:
					'This land enters tapped.\n{T}: Add {C}.\nWhenever this land or another land you control enters, if you control seven or more lands with different names, create a 2/2 black Zombie creature token.'
			});
			assertUsesOverride(fotd);
			for (let i = 1; i <= 5; i++) {
				putInZone(state, p1, synthCard({ name: `Land ${i}`, typeLine: 'Land', oracleText: '' }), 'battlefield');
			}
			const fotdHand = putInZone(state, p1, fotd, 'hand');
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: fotdHand.instanceId }).ok, true);
			assert.equal(fotdHand.tapped, true, 'Field of the Dead enters tapped');
			assert.equal(p1.battlefield.filter((c) => c.card.name === 'Zombie Token').length, 0, 'Only 6 distinct lands so far');

			// Play 7th distinct land via moveObject/land drop on next turn or Spelunking!
			// Use a 7th distinct land via put-into-play or reset landPlayedThisTurn for test
			p1.landsPlayedThisTurn = 0;
			const seventh = putInZone(state, p1, synthCard({ name: 'Land 7', typeLine: 'Land', oracleText: '' }), 'hand');
			assert.equal(applyGameAction(state, p1.playerId, { type: 'play_land', instanceId: seventh.instanceId }).ok, true);
			resolveTopOfStack(state);
			assert.equal(p1.battlefield.filter((c) => c.card.name === 'Zombie Token').length, 1, '7th distinct land creates 2/2 Zombie');

			// Grave Pact + Champion of Lambholt
			const gp = synthCard({
				oracleId: '6f4ac4a4-53ec-4bc9-8f5c-d4b801d867b2',
				name: 'Grave Pact',
				manaCost: '{1}{B}{B}{B}',
				typeLine: 'Enchantment',
				oracleText: 'Whenever a creature you control dies, each other player sacrifices a creature of their choice.',
				colors: ['B']
			});
			const champ = synthCard({
				oracleId: 'c549b0fd-1e08-4873-952e-a14dc45a0fd2',
				name: 'Champion of Lambholt',
				manaCost: '{1}{G}{G}',
				typeLine: 'Creature — Human Warrior',
				oracleText:
					"Creatures with power less than this creature's power can't block creatures you control.\nWhenever another creature you control enters, put a +1/+1 counter on this creature.",
				power: '1',
				toughness: '1',
				colors: ['G']
			});
			assertUsesOverride(gp);
			assertUsesOverride(champ);
			putInZone(state, p1, gp, 'battlefield');
			const champPerm = putInZone(state, p1, champ, 'battlefield');
			const elf = synthCard({ name: 'Llanowar', manaCost: '{G}', typeLine: 'Creature — Elf', oracleText: '', power: '1', toughness: '1', colors: ['G'] });
			const elfHand = putInZone(state, p1, elf, 'hand');
			giveMana(p1, { G: 1 });
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: elfHand.instanceId }).ok, true);
			resolveTopOfStack(state);
			// Champion gets +1/+1 counter -> power 2
			assert.equal(evaluatePermanent(state, champPerm).power, 2);

			// Opponent 1/1 creature can't block Champion (power 2), then dies to Grave Pact when Elf dies!
			const oppChump = putInZone(
				state,
				p2,
				synthCard({ name: 'Chump', typeLine: 'Creature — Goblin', oracleText: '', power: '1', toughness: '1' }),
				'battlefield'
			);
			state.phase = 'declare_attackers';
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'declare_attackers',
					assignments: [{ attackerInstanceId: champPerm.instanceId, defenderPlayerId: p2.playerId }]
				}).ok,
				true
			);
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });
			assert.equal(
				applyGameAction(state, p2.playerId, {
					type: 'declare_blockers',
					assignments: [{ blockerInstanceId: oppChump.instanceId, attackerInstanceId: champPerm.instanceId }]
				}).ok,
				false,
				'Champion of Lambholt blocks 1-power blockers when Champion has power 2'
			);

			// Destroy Elf via spell -> triggers Grave Pact -> opponent sacrifices oppChump!
			state.phase = 'main2';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			const killSpell = putInZone(
				state,
				p1,
				synthCard({ name: 'Snuff', manaCost: '{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.', colors: ['B'] }),
				'hand'
			);
			giveMana(p1, { B: 1 });
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: killSpell.instanceId,
					targets: [{ kind: 'permanent', id: elfHand.instanceId, label: elfHand.card.name }]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			if (state.pendingPrompts[0]?.kind === 'chooseObjects') {
				const sprm = state.pendingPrompts[0];
				assert.equal(
					applyGameAction(state, sprm.playerId, {
						type: 'choice',
						promptId: sprm.id,
						answer: { kind: 'chooseObjects', objectIds: [oppChump.instanceId] }
					}).ok,
					true
				);
			}
			resolveTopOfStack(state);
			assert.equal(oppChump.zone, 'graveyard');
		}

		// 13) Flare of Fortitude + 14) Spelunking + 15) Rite of Replication + 16) Descent into Avernus + 17-19) Tron
		{
			const { state, p1, p2 } = setupGame();
			// Spelunking
			const spelunk = synthCard({
				oracleId: '2962fe4c-bf48-454b-8a6b-0f8253352ae8',
				name: 'Spelunking',
				manaCost: '{2}{G}',
				typeLine: 'Enchantment',
				oracleText:
					'When this enchantment enters, draw a card, then you may put a land card from your hand onto the battlefield. If you put a Cave onto the battlefield this way, you gain 4 life.\nLands you control enter untapped.',
				colors: ['G']
			});
			assertUsesOverride(spelunk);
			const cave = putInZone(
				state,
				p1,
				synthCard({
					name: 'Hidden Cave',
					typeLine: 'Land — Cave',
					oracleText: 'This land enters tapped.\n{T}: Add {C}.'
				}),
				'hand'
			);
			const spHand = putInZone(state, p1, spelunk, 'hand');
			giveMana(p1, { G: 3 });
			const lifeBefore = p1.life;
			assert.equal(applyGameAction(state, p1.playerId, { type: 'cast_spell', instanceId: spHand.instanceId }).ok, true);
			resolveTopOfStack(state); // ETB triggers and prompts to put land from hand
			assert.equal(state.pendingPrompts.length, 1);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'choice',
					promptId: state.pendingPrompts[0].id,
					answer: { kind: 'chooseObjects', objectIds: [cave.instanceId] }
				}).ok,
				true
			);
			assert.equal(cave.zone, 'battlefield');
			assert.equal(cave.tapped, false, 'Spelunking makes Cave enter untapped');
			assert.equal(p1.life, lifeBefore + 4, 'Putting Cave gained 4 life');

			// Flare of Fortitude via sacrifice white creature alt cast
			const whiteGuard = putInZone(
				state,
				p1,
				synthCard({
					name: 'White Knight',
					manaCost: '{W}',
					typeLine: 'Creature — Human Knight',
					oracleText: '',
					power: '2',
					toughness: '2',
					colors: ['W']
				}),
				'battlefield'
			);
			const flare = synthCard({
				oracleId: '4ff07b7c-e97a-4b57-bcf1-2f22c37a8bd6',
				name: 'Flare of Fortitude',
				manaCost: '{2}{W}{W}',
				typeLine: 'Instant',
				oracleText:
					"You may sacrifice a nontoken white creature rather than pay this spell's mana cost.\nUntil end of turn, your life total can't change, and permanents you control gain hexproof and indestructible.",
				colors: ['W']
			});
			assertUsesOverride(flare);
			const flHand = putInZone(state, p1, flare, 'hand');
			const flOpt = getCastOptions(state, p1.playerId, flHand, 'hand').find(
				(o) => o.baseCost.kind === 'alternative'
			)!;
			assert.ok(flOpt, 'Flare altCost option present');
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: flHand.instanceId,
					optionId: flOpt.id,
					costPayment: { objects: [[whiteGuard.instanceId]] }
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(hasKeyword(cave, 'Hexproof', state), true);
			assert.equal(hasKeyword(cave, 'Indestructible', state), true);

			// Rite of Replication (kicked -> 5 token copies)
			const riteTarget = putInZone(
				state,
				p2,
				synthCard({ name: 'Big Golem', typeLine: 'Artifact Creature — Golem', oracleText: '', power: '3', toughness: '3' }),
				'battlefield'
			);
			const rite = synthCard({
				oracleId: 'fb60739e-1dc3-481d-a056-ad72e665c680',
				name: 'Rite of Replication',
				manaCost: '{2}{U}{U}',
				typeLine: 'Sorcery',
				oracleText:
					"Kicker {5} (You may pay an additional {5} as you cast this spell.)\nCreate a token that's a copy of target creature. If this spell was kicked, create five of those tokens instead.",
				colors: ['U']
			});
			assertUsesOverride(rite);
			const rHand = putInZone(state, p1, rite, 'hand');
			giveMana(p1, { U: 9 });
			const rBaseOpt = getCastOptions(state, p1.playerId, rHand, 'hand').find(
				(o) => o.baseCost.kind === 'printed'
			)!;
			const rKickOpt = rBaseOpt?.optionalAdditionalCosts?.find(
				(k) => k.id.startsWith('kicker:') || (k.kickedTags?.length ?? 0) > 0
			)!;
			assert.ok(rBaseOpt && rKickOpt);
			assert.equal(
				applyGameAction(state, p1.playerId, {
					type: 'cast_spell',
					instanceId: rHand.instanceId,
					optionId: rBaseOpt.id,
					optionalCostCounts: { [rKickOpt.id]: 1 },
					targets: [{ kind: 'permanent', id: riteTarget.instanceId, label: riteTarget.card.name }]
				}).ok,
				true
			);
			resolveTopOfStack(state);
			assert.equal(p1.battlefield.filter((c) => c.card.name === 'Big Golem' && c.isToken).length, 5);

			// Descent into Avernus (upkeep puts 2 descent counters -> 2 Treasures + 2 damage)
			const descent = synthCard({
				oracleId: '1313da2f-92bb-4862-9153-373972cc1520',
				name: 'Descent into Avernus',
				manaCost: '{2}{R}',
				typeLine: 'Enchantment',
				oracleText:
					'At the beginning of your upkeep, put two descent counters on this enchantment. Then each player creates X Treasure tokens and this enchantment deals X damage to each player, where X is the number of descent counters on this enchantment.',
				colors: ['R']
			});
			assertUsesOverride(descent);
			const descPerm = putInZone(state, p1, descent, 'battlefield');
			const p1LifeBeforeDesc = p1.life;
			const p2LifeBeforeDesc = p2.life;
			// Advance to next upkeep for p1
			state.phase = 'untap';
			state.activePlayerIndex = 0;
			state.priorityPlayerIndex = 0;
			applyGameAction(state, p1.playerId, { type: 'pass_priority' });
			applyGameAction(state, p2.playerId, { type: 'pass_priority' });
			resolveTopOfStack(state);
			assert.equal(descPerm.counters.descent, 2);
			assert.equal(p1.battlefield.filter((c) => c.card.name === 'Treasure').length, 2);
			assert.equal(p2.battlefield.filter((c) => c.card.name === 'Treasure').length, 2);
			// Note p1 has lifeTotalCantChange from Flare of Fortitude until end of turn! Wait: we advanced only from main1->untap? No, Flare was cast same turn so advancing phase untap->upkeep didn't run cleanup!
			assert.equal(p1.life, p1LifeBeforeDesc, 'Flare of Fortitude kept p1 life unchanged!');
			assert.equal(p2.life, p2LifeBeforeDesc - 2, 'Descent dealt 2 damage to p2');

			// Tron lands (Urza's Tower, Urza's Mine, Urza's Power Plant)
			const towerCard = synthCard({
				oracleId: '32fbb638-ab14-4e8b-a07a-d4c44e3496f2',
				name: "Urza's Tower",
				manaCost: '',
				typeLine: "Land — Urza's Tower",
				oracleText:
					"{T}: Add {C}. If you control an Urza's Mine and an Urza's Power-Plant, add {C}{C}{C} instead."
			});
			const mineCard = synthCard({
				oracleId: '33e85a8a-86df-4cdc-a9cc-8cbabe92c3c0',
				name: "Urza's Mine",
				manaCost: '',
				typeLine: "Land — Urza's Mine",
				oracleText:
					"{T}: Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add {C}{C} instead."
			});
			const plantCard = synthCard({
				oracleId: 'e11966cd-2ee3-4df4-b099-abf42dcdf0db',
				name: "Urza's Power Plant",
				manaCost: '',
				typeLine: "Land — Urza's Power-Plant",
				oracleText:
					"{T}: Add {C}. If you control an Urza's Mine and an Urza's Tower, add {C}{C} instead."
			});
			assertUsesOverride(towerCard);
			assertUsesOverride(mineCard);
			assertUsesOverride(plantCard);

			const towerPerm = putInZone(state, p1, towerCard, 'battlefield');
			p1.manaPool.C = 0;
			// Without Mine + Plant -> taps for 1 {C}
			assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: towerPerm.instanceId }).ok, true);
			assert.equal(p1.manaPool.C, 1);

			// Add Mine + Power Plant and untap Tower -> taps for 3+2+2 = 7 {C}!
			towerPerm.tapped = false;
			p1.manaPool.C = 0;
			const minePerm = putInZone(state, p1, mineCard, 'battlefield');
			const plantPerm = putInZone(state, p1, plantCard, 'battlefield');
			assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: towerPerm.instanceId }).ok, true);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: minePerm.instanceId }).ok, true);
			assert.equal(applyGameAction(state, p1.playerId, { type: 'tap_mana', instanceId: plantPerm.instanceId }).ok, true);
			assert.equal(p1.manaPool.C, 7, 'Assembled Tron taps for 3 + 2 + 2 = 7 colorless mana');
		}
	});

	it('compiles multiframe layouts (flip, meld, modal_dfc, split, prepare) cleanly with Wave 8 face normalization', () => {
		clearCompileCache();
		const mkFace = (
			name: string,
			manaCost: string,
			typeLine: string,
			oracleText: string,
			colors: ManaColor[] = ['U']
		) => ({
			name,
			manaCost,
			typeLine,
			oracleText,
			colors,
			imageUrl: 'https://example.invalid/face.jpg'
		});

		const flipCard = synthCard({
			name: 'Kiro, Flip Scholar',
			layout: 'flip',
			manaCost: '{1}{U}',
			typeLine: 'Creature — Human Wizard',
			oracleText: 'Whenever you draw a card, flip ~.',
			power: '1',
			toughness: '2',
			colors: ['U'],
			faces: [
				mkFace(
					'Kiro, Flip Scholar',
					'{1}{U}',
					'Creature — Human Wizard',
					'Whenever you draw a card, flip ~.'
				),
				mkFace(
					'Kiro, Ascended Sage',
					'',
					'Legendary Creature — Human Wizard',
					'Whenever Kiro deals combat damage to a player, draw a card.'
				)
			]
		});
		const flipCompiled = compileCard(flipCard);
		assert.equal(flipCompiled.faces.length, 2);
		assert.equal(flipCompiled.fullySupported, true);

		const meldCard = synthCard({
			name: 'Veld, Meld Architect',
			layout: 'meld',
			manaCost: '{2}{W}',
			typeLine: 'Legendary Creature — Human Artificer',
			oracleText: 'At the beginning of your end step, if you control Veld and Engine Core, exile them, then meld them into Veld, Supreme Core.',
			power: '2',
			toughness: '3',
			colors: ['W'],
			faces: [
				mkFace(
					'Veld, Meld Architect',
					'{2}{W}',
					'Legendary Creature — Human Artificer',
					'At the beginning of your end step, draw a card.',
					['W']
				),
				mkFace(
					'Veld, Supreme Core',
					'',
					'Legendary Artifact Creature — Construct',
					'Vigilance\nWhenever Veld attacks, gain 3 life.',
					['W']
				)
			]
		});
		const meldCompiled = compileCard(meldCard);
		assert.equal(meldCompiled.faces.length, 2);
		assert.equal(meldCompiled.fullySupported, true);

		const mdfcCard = synthCard({
			name: 'Zara, Modal Seeker // Zara Sanctuary',
			layout: 'modal_dfc',
			manaCost: '{2}{G}',
			typeLine: 'Legendary Creature — Elf Druid // Land',
			oracleText: '',
			colors: ['G'],
			faces: [
				mkFace(
					'Zara, Modal Seeker',
					'{2}{G}',
					'Legendary Creature — Elf Druid',
					'Whenever Zara enters, gain 2 life.',
					['G']
				),
				mkFace('Zara Sanctuary', '', 'Land', '{T}: Add {G}.', [])
			]
		});
		const mdfcCompiled = compileCard(mdfcCard);
		assert.equal(mdfcCompiled.faces.length, 2);
		assert.equal(mdfcCompiled.fullySupported, true);

		const splitCard = synthCard({
			name: 'Spark Burst // Gale Burst',
			layout: 'split',
			manaCost: '{R} // {U}',
			typeLine: 'Instant // Instant',
			oracleText: '',
			colors: ['R', 'U'],
			faces: [
				mkFace('Spark Burst', '{R}', 'Instant', 'Spark Burst deals 2 damage to any target.', ['R']),
				mkFace('Gale Burst', '{U}', 'Instant', 'Draw a card.', ['U'])
			]
		});
		const splitCompiled = compileCard(splitCard);
		assert.equal(splitCompiled.faces.length, 2);
		assert.equal(splitCompiled.fullySupported, true);

		const prepareCard = synthCard({
			name: 'Chrono Scholar // Chrono Strike',
			layout: 'prepare',
			manaCost: '{1}{U}',
			typeLine: 'Creature — Human Wizard // Sorcery',
			oracleText: '',
			colors: ['U'],
			faces: [
				mkFace(
					'Chrono Scholar',
					'{1}{U}',
					'Creature — Human Wizard',
					'When Chrono Scholar enters, scry 1.',
					['U']
				),
				mkFace('Chrono Strike', '{2}{U}', 'Sorcery', 'Draw two cards.', ['U'])
			]
		});
		const prepareCompiled = compileCard(prepareCard);
		assert.equal(prepareCompiled.faces.length, 2);
		assert.equal(prepareCompiled.fullySupported, true);
	});
});
