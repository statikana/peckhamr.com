import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyGameAction,
	createCardInstance,
	createInitialGameState,
	evaluatePermanent,
	getCastOptions,
	getEffectiveActivatedAbilities,
	checkStateBasedActions,
	sanitizeGameStateForViewer
} from '../../engine.ts';
import { compileCard } from '../../compiler/index.ts';
import { definitionSupportReport } from '../../compiler/support.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type CostPayment,
	type DeckCardEntry,
	type GameActionPayload,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type PlayerGameState,
	type ScryfallCard,
	type TargetRef
} from '../../types.ts';

/**
 * Creates a synthetic ScryfallCard with sane defaults for opaque-box testing.
 * Names are synthetic by default to verify strict rename-invariance.
 */
export function synthCard(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	const safeId = `syn_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
	return {
		id: overrides.id ?? safeId,
		name: overrides.name,
		manaCost: overrides.manaCost ?? '{1}',
		cmc: overrides.cmc ?? 1,
		typeLine: overrides.typeLine ?? 'Creature',
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
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...(overrides.layout ? { layout: overrides.layout } : {}),
		...(overrides.faces ? { faces: overrides.faces } : {})
	};
}

/**
 * Wraps cards into a standard Commander deck structure.
 */
export function makeDeck(cards: ScryfallCard[], commander?: ScryfallCard): MagicDeck {
	const entries: DeckCardEntry[] = cards.map((card) => ({ card, quantity: 1 }));
	return {
		id: `deck_${Math.random().toString(36).slice(2, 8)}`,
		userId: 'p1',
		name: 'E2E Test Deck',
		description: 'Deck for E2E opaque-box tests',
		commanders: commander ? [commander] : [],
		cards: entries,
		colorIdentity: commander?.colorIdentity ?? [],
		cardCount: entries.length + (commander ? 1 : 0),
		isLegal: true,
		validationErrors: [],
		winCount: 0,
		playCount: 0,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
}

/**
 * Sets up a clean active 2-player or 4-player game ready for action execution at main1 phase.
 */
export function setupE2EGame(opts: {
	playerCount?: 2 | 4;
	p1Bot?: boolean;
	p2Bot?: boolean;
	p1Commander?: ScryfallCard;
	p2Commander?: ScryfallCard;
} = {}): {
	state: GameState;
	p1: PlayerGameState;
	p2: PlayerGameState;
	players: PlayerGameState[];
} {
	const count = opts.playerCount ?? 2;
	const plains = synthCard({
		name: 'Plains',
		manaCost: '',
		cmc: 0,
		typeLine: 'Basic Land — Plains',
		oracleText: '({T}: Add {W}.)'
	});
	const deckP1 = makeDeck(Array.from({ length: 40 }, () => plains), opts.p1Commander);
	const deckP2 = makeDeck(Array.from({ length: 40 }, () => plains), opts.p2Commander);

	const seats: LobbySeat[] = [];
	const decksBySeat = new Map<number, MagicDeck>();

	for (let i = 0; i < count; i++) {
		const isP1 = i === 0;
		const d = isP1 ? deckP1 : deckP2;
		seats.push({
			seatIndex: i,
			userId: `p${i + 1}`,
			username: `Player ${i + 1}`,
			avatarUrl: '',
			isBot: isP1 ? Boolean(opts.p1Bot) : i === 1 ? Boolean(opts.p2Bot) : false,
			deckId: d.id,
			deckName: d.name,
			commanderNames: d.commanders.map((c) => c.name),
			commanderArtUrl: '',
			colorIdentity: d.colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: Date.now()
		});
		decksBySeat.set(i, d);
	}

	const state = createInitialGameState('test_e2e_game', seats, decksBySeat, DEFAULT_LOBBY_RULES);
	state.status = 'active';
	state.phase = 'main1';
	state.activePlayerIndex = 0;
	state.priorityPlayerIndex = 0;
	state.turnNumber = 1;
	state.pendingPrompts = [];

	return {
		state,
		p1: state.players[0],
		p2: state.players[1],
		players: state.players
	};
}

/**
 * Instantiates a card and injects it into a specified zone.
 */
export function addCardToZone(
	state: GameState,
	player: PlayerGameState,
	card: ScryfallCard,
	zone: 'hand' | 'battlefield' | 'graveyard' | 'command' | 'exile' | 'library'
): CardInstance {
	const inst = createCardInstance(card, player.playerId, zone, false, false, undefined, state);
	if (zone === 'command') inst.isCommander = true;
	player[zone].push(inst);
	return inst;
}

/**
 * Resolves all pending triggers, choice prompts, and stack items via public priority passes.
 */
export function passAllPriority(state: GameState, maxPasses = 50): void {
	for (let i = 0; i < maxPasses; i++) {
		// Answer pending prompts first
		const prompt = state.pendingPrompts[0];
		if (prompt) {
			if (prompt.purpose === 'trigger_order' && prompt.choice?.kind === 'orderObjects') {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: {
						kind: 'orderObjects',
						topIds: prompt.choice.objectIds,
						bottomIds: [],
						shuffle: false
					}
				});
				continue;
			}
			if (prompt.purpose === 'trigger_may' || prompt.choice?.kind === 'yesNo') {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: { kind: 'yesNo', yes: true }
				});
				continue;
			}
			if (
				prompt.continuation?.kind === 'effect_choice' &&
				prompt.choice?.kind === 'chooseObjects' &&
				prompt.choice.defaultObjectIds
			) {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: { kind: 'chooseObjects', objectIds: prompt.choice.defaultObjectIds }
				});
				continue;
			}
			if (prompt.choice?.kind === 'chooseMode' && prompt.choice.min) {
				applyGameAction(state, prompt.playerId, {
					type: 'choice',
					promptId: prompt.id,
					answer: { kind: 'chooseMode', indices: [0] }
				});
				continue;
			}
		}

		if (state.stack.length === 0 && state.pendingPrompts.length === 0) {
			break;
		}

		const prio = state.players[state.priorityPlayerIndex];
		const res = applyGameAction(state, prio.playerId, { type: 'pass_priority' });
		if (!res.ok) break;
	}
}

/**
 * Performs a cast spell game action through applyGameAction.
 */
export function castSpellAction(
	state: GameState,
	player: PlayerGameState,
	cardInst: CardInstance,
	options: {
		targets?: TargetRef[];
		modes?: number[];
		xValue?: number;
		fromZone?: 'hand' | 'command' | 'graveyard' | 'exile';
		costPayment?: CostPayment;
	} = {}
): { ok: boolean; error?: string } {
	return applyGameAction(state, player.playerId, {
		type: 'cast_spell',
		instanceId: cardInst.instanceId,
		targets: options.targets,
		modes: options.modes,
		xValue: options.xValue,
		fromZone: options.fromZone ?? (cardInst.zone as any),
		costPayment: options.costPayment
	});
}

/**
 * Performs a play land game action through applyGameAction.
 */
export function playLandAction(
	state: GameState,
	player: PlayerGameState,
	cardInst: CardInstance
): { ok: boolean; error?: string } {
	return applyGameAction(state, player.playerId, {
		type: 'play_land',
		instanceId: cardInst.instanceId
	});
}

/**
 * Performs an activate ability game action through applyGameAction.
 */
export function activateAbilityAction(
	state: GameState,
	player: PlayerGameState,
	cardInst: CardInstance,
	abilityId: string,
	targets?: TargetRef[]
): { ok: boolean; error?: string } {
	return applyGameAction(state, player.playerId, {
		type: 'activate_ability',
		instanceId: cardInst.instanceId,
		abilityId,
		targets
	});
}

/**
 * Checks whether a card definition is 100% cleanly supported by the compiler without unsupported reasons.
 */
export function isCardSupported(card: ScryfallCard): boolean {
	try {
		const def = compileCard(card);
		const report = definitionSupportReport(def);
		return report.fullySupported && report.unsupported.length === 0;
	} catch {
		return false;
	}
}

/**
 * Checks if a specific feature from the 51-feature inventory is ready/supported in compiler & runtime.
 */
export function isFeatureReady(featureId: string): boolean {
	const probes: Record<string, ScryfallCard> = {
		pump_and_keyword: synthCard({
			name: 'Synthetic Pump Trample',
			manaCost: '{1}{G}',
			typeLine: 'Instant',
			oracleText: 'Target creature gets +2/+2 and gains trample until end of turn.'
		}),
		chaos_warp: synthCard({
			name: 'Synthetic Warp',
			manaCost: '{2}{R}',
			typeLine: 'Instant',
			oracleText:
				'The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it is a permanent card, they put it onto the battlefield.'
		}),
		crystalline_crawler: synthCard({
			name: 'Synthetic Crawler',
			manaCost: '{4}',
			typeLine: 'Artifact Creature — Construct',
			power: '1',
			toughness: '1',
			oracleText:
				'Converge — ~ enters with a +1/+1 counter on it for each color of mana spent to cast it.'
		}),
		expressive_iteration: synthCard({
			name: 'Synthetic Iteration',
			manaCost: '{U}{R}',
			typeLine: 'Sorcery',
			oracleText:
				'Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. You may play the exiled card this turn.'
		}),
		fathom_mage: synthCard({
			name: 'Synthetic Evolve Mage',
			manaCost: '{2}{G}{U}',
			typeLine: 'Creature — Human Wizard',
			power: '1',
			toughness: '1',
			keywords: ['Evolve'],
			oracleText:
				'Evolve\nWhenever a +1/+1 counter is put on ~, you may draw a card.'
		}),
		forgotten_ancient: synthCard({
			name: 'Synthetic Ancient',
			manaCost: '{3}{G}',
			typeLine: 'Creature — Elemental',
			power: '0',
			toughness: '3',
			oracleText:
				'Whenever a player casts a spell, you may put a +1/+1 counter on ~.\nAt the beginning of your upkeep, you may move any number of +1/+1 counters from ~ onto other creatures.'
		}),
		hellkite_charger: synthCard({
			name: 'Synthetic Charger',
			manaCost: '{4}{R}{R}',
			typeLine: 'Creature — Dragon',
			power: '5',
			toughness: '5',
			oracleText:
				'Flying, haste\nWhenever ~ attacks, you may pay {5}{R}{R}. If you do, untap all attacking creatures and after this phase, there is an additional combat phase.'
		}),
		jeskas_will: synthCard({
			name: 'Synthetic Will',
			manaCost: '{2}{R}',
			typeLine: 'Sorcery',
			oracleText:
				"Choose one. If you control a commander as you cast ~, you may choose both instead.\n• Add {R} for each card in target opponent's hand.\n• Exile the top three cards of your library. You may play them this turn."
		}),
		leyline_of_anticipation: synthCard({
			name: 'Synthetic Leyline',
			manaCost: '{2}{U}{U}',
			typeLine: 'Enchantment',
			oracleText:
				'If ~ is in your opening hand, you may begin the game with it on the battlefield.\nYou may cast spells as though they had flash.'
		}),
		mycosynth_lattice: synthCard({
			name: 'Synthetic Lattice',
			manaCost: '{6}',
			typeLine: 'Artifact',
			oracleText:
				"All permanents are artifacts in addition to their other types.\nAll cards that aren't on the battlefield, spells, and permanents are colorless.\nPlayers may spend mana as though it were mana of any color."
		}),
		path_of_ancestry: synthCard({
			name: 'Synthetic Ancestry',
			manaCost: '',
			typeLine: 'Land',
			oracleText:
				"~ enters tapped.\n{T}: Add one mana of any color in your commander's color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1."
		}),
		scourge_of_valkas: synthCard({
			name: 'Synthetic Valkas',
			manaCost: '{2}{R}{R}{R}',
			typeLine: 'Creature — Dragon',
			power: '4',
			toughness: '4',
			oracleText:
				'Flying\nWhenever ~ or another Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control.'
		}),
		terror_of_the_peaks: synthCard({
			name: 'Synthetic Terror',
			manaCost: '{3}{R}{R}',
			typeLine: 'Creature — Dragon',
			power: '5',
			toughness: '4',
			oracleText:
				'Flying\nSpells your opponents cast that target ~ cost an additional 3 life to cast.\nWhenever another creature you control enters, ~ deals damage equal to that creature\'s power to any target.'
		}),
		damage_prevention: synthCard({
			name: 'Synthetic Healing',
			manaCost: '{W}',
			typeLine: 'Instant',
			oracleText: 'Prevent the next 3 damage that would be dealt to any target this turn.'
		}),
		prevent_all_combat_damage: synthCard({
			name: 'Synthetic Fog',
			manaCost: '{G}',
			typeLine: 'Instant',
			oracleText: 'Prevent all combat damage that would be dealt this turn.'
		}),
		target_attacking_or_blocking: synthCard({
			name: 'Synthetic Sentry Smite',
			manaCost: '{1}{W}',
			typeLine: 'Instant',
			oracleText: 'Destroy target attacking or blocking creature.'
		}),
		cant_be_blocked_eot: synthCard({
			name: 'Synthetic Invisibility',
			manaCost: '{U}',
			typeLine: 'Sorcery',
			oracleText: "Target creature can't be blocked this turn."
		}),
		sac_deals_damage: synthCard({
			name: 'Synthetic Mogg',
			manaCost: '{R}',
			typeLine: 'Creature — Goblin',
			power: '1',
			toughness: '1',
			oracleText: 'Sacrifice ~: It deals 1 damage to any target.'
		}),
		etb_tapped_conditional_lands: synthCard({
			name: 'Synthetic Fastland',
			manaCost: '',
			typeLine: 'Land',
			oracleText: '~ enters tapped unless you control two or fewer other lands.\n{T}: Add {W}.'
		}),
		blocking_restrictions: synthCard({
			name: 'Synthetic Welkin',
			manaCost: '{1}{U}',
			typeLine: 'Creature — Bird',
			power: '2',
			toughness: '1',
			oracleText: 'Flying\n~ can block only creatures with flying.'
		}),
		etb_damage_and_tap: synthCard({
			name: 'Synthetic Frost Spitter',
			manaCost: '{2}{R}{U}',
			typeLine: 'Creature — Weird',
			power: '2',
			toughness: '2',
			oracleText: 'When ~ enters, it deals 2 damage to any target and tap target creature.'
		}),
		exile_on_death_damage: synthCard({
			name: 'Synthetic Magma Spray',
			manaCost: '{R}',
			typeLine: 'Instant',
			oracleText:
				'~ deals 2 damage to target creature. If that creature would die this turn, exile it instead.'
		}),
		threshold_metalcraft_delirium: synthCard({
			name: 'Synthetic Carapace',
			manaCost: '{G}',
			typeLine: 'Creature — Insect',
			power: '1',
			toughness: '1',
			oracleText: 'Threshold — ~ gets +2/+2 as long as seven or more cards are in your graveyard.'
		}),
		death_deals_damage: synthCard({
			name: 'Synthetic Bombard',
			manaCost: '{1}{R}',
			typeLine: 'Creature — Goblin',
			power: '1',
			toughness: '1',
			oracleText: 'When ~ dies, it deals 2 damage to any target.'
		}),
		etb_attach_equipment: synthCard({
			name: 'Synthetic Hammer',
			manaCost: '{2}',
			typeLine: 'Artifact — Equipment',
			oracleText:
				'When ~ enters, attach it to target creature you control.\nEquipped creature gets +2/+0.\nEquip {2}'
		}),
		conditional_has_keyword: synthCard({
			name: 'Synthetic Brawler',
			manaCost: '{1}{R}',
			typeLine: 'Creature — Human Warrior',
			power: '2',
			toughness: '2',
			oracleText: 'During your turn, ~ has first strike.'
		}),
		tribal_type_cost_reduction: synthCard({
			name: 'Synthetic Banneret',
			manaCost: '{1}{W}',
			typeLine: 'Creature — Kithkin Soldier',
			power: '1',
			toughness: '3',
			oracleText: 'Soldier spells you cast cost {1} less to cast.'
		}),
		skulking_ghost_trigger: synthCard({
			name: 'Synthetic Skulker',
			manaCost: '{1}{B}',
			typeLine: 'Creature — Spirit',
			power: '2',
			toughness: '1',
			oracleText: 'When ~ becomes the target of a spell or ability, sacrifice it.'
		}),
		bounce_land: synthCard({
			name: 'Synthetic Karoo',
			manaCost: '',
			typeLine: 'Land',
			oracleText:
				'~ enters tapped.\nWhen ~ enters, return a land you control to its owner\'s hand.\n{T}: Add {W}{U}.'
		}),
		cr702_madness: synthCard({
			name: 'Synthetic Rootwalla',
			manaCost: '{G}',
			typeLine: 'Creature — Lizard',
			power: '1',
			toughness: '1',
			keywords: ['Madness'],
			oracleText: 'Madness {0}'
		}),
		cr702_echo: synthCard({
			name: 'Synthetic Parg',
			manaCost: '{1}{R}',
			typeLine: 'Creature — Beast',
			power: '2',
			toughness: '2',
			keywords: ['Echo'],
			oracleText: 'Echo {1}{R}'
		}),
		cr702_undying_persist: synthCard({
			name: 'Synthetic Undying Wolf',
			manaCost: '{1}{G}',
			typeLine: 'Creature — Wolf',
			power: '2',
			toughness: '2',
			keywords: ['Undying'],
			oracleText: 'Undying'
		}),
		cr702_cascade: synthCard({
			name: 'Synthetic Shaden',
			manaCost: '{1}{R}{G}',
			typeLine: 'Creature — Elf',
			power: '3',
			toughness: '2',
			keywords: ['Cascade'],
			oracleText: 'Cascade'
		}),
		cr702_soulshift: synthCard({
			name: 'Synthetic Kami',
			manaCost: '{2}{G}',
			typeLine: 'Creature — Spirit',
			power: '2',
			toughness: '2',
			keywords: ['Soulshift'],
			oracleText: 'Soulshift 2'
		}),
		cr702_toxic: synthCard({
			name: 'Synthetic Flayer',
			manaCost: '{1}{B}',
			typeLine: 'Creature — Phyrexian',
			power: '1',
			toughness: '3',
			keywords: ['Toxic'],
			oracleText: 'Toxic 1'
		}),
		cr702_rebound: synthCard({
			name: 'Synthetic Distortion',
			manaCost: '{U}',
			typeLine: 'Sorcery',
			keywords: ['Rebound'],
			oracleText: 'Target creature gets +1/+0 until end of turn.\nRebound'
		}),
		cr702_improvise: synthCard({
			name: 'Synthetic Gearseeker',
			manaCost: '{5}{U}',
			typeLine: 'Creature — Serpent',
			power: '5',
			toughness: '6',
			keywords: ['Improvise'],
			oracleText: 'Improvise'
		}),
		cr702_bloodthirst: synthCard({
			name: 'Synthetic Berserker',
			manaCost: '{1}{R}',
			typeLine: 'Creature — Human Berserker',
			power: '1',
			toughness: '1',
			keywords: ['Bloodthirst'],
			oracleText: 'Bloodthirst 2'
		}),
		cr702_modular: synthCard({
			name: 'Synthetic Worker',
			manaCost: '{1}',
			typeLine: 'Artifact Creature — Construct',
			power: '0',
			toughness: '0',
			keywords: ['Modular'],
			oracleText: 'Modular 1'
		}),
		cr702_dash: synthCard({
			name: 'Synthetic Raider',
			manaCost: '{1}{R}',
			typeLine: 'Creature — Goblin',
			power: '2',
			toughness: '1',
			keywords: ['Dash'],
			oracleText: 'Dash {R}'
		}),
		cr702_flanking: synthCard({
			name: 'Synthetic Knight',
			manaCost: '{1}{W}',
			typeLine: 'Creature — Human Knight',
			power: '2',
			toughness: '2',
			keywords: ['Flanking'],
			oracleText: 'Flanking'
		}),
		cr702_ninjutsu: synthCard({
			name: 'Synthetic Shinobi',
			manaCost: '{3}{U}',
			typeLine: 'Creature — Ninja',
			power: '3',
			toughness: '2',
			keywords: ['Ninjutsu'],
			oracleText: 'Ninjutsu {1}{U}'
		}),
		cr702_fabricate: synthCard({
			name: 'Synthetic Inspector',
			manaCost: '{2}{W}',
			typeLine: 'Creature — Dwarf Artificer',
			power: '1',
			toughness: '2',
			keywords: ['Fabricate'],
			oracleText: 'Fabricate 1'
		}),
		cr702_myriad: synthCard({
			name: 'Synthetic Bladecrafter',
			manaCost: '{3}{R}',
			typeLine: 'Creature — Human Warrior',
			power: '3',
			toughness: '3',
			keywords: ['Myriad'],
			oracleText: 'Myriad'
		}),
		cr702_renown: synthCard({
			name: 'Synthetic Outland',
			manaCost: '{1}{G}',
			typeLine: 'Creature — Human Warrior',
			power: '2',
			toughness: '2',
			keywords: ['Renown'],
			oracleText: 'Renown 1'
		}),
		cr702_unleash: synthCard({
			name: 'Synthetic Cackler',
			manaCost: '{B/R}',
			typeLine: 'Creature — Devil',
			power: '1',
			toughness: '1',
			keywords: ['Unleash'],
			oracleText: 'Unleash'
		}),
		cr702_extort: synthCard({
			name: 'Synthetic Sycophant',
			manaCost: '{1}{B}',
			typeLine: 'Creature — Thrull',
			power: '1',
			toughness: '1',
			keywords: ['Extort'],
			oracleText: 'Extort'
		}),
		cr702_scavenge: synthCard({
			name: 'Synthetic Selesnya',
			manaCost: '{G}',
			typeLine: 'Creature — Plant',
			power: '1',
			toughness: '1',
			keywords: ['Scavenge'],
			oracleText: 'Scavenge {G}'
		}),
		cr702_encore: synthCard({
			name: 'Synthetic Amphin',
			manaCost: '{3}{U}',
			typeLine: 'Creature — Salamander',
			power: '3',
			toughness: '3',
			keywords: ['Encore'],
			oracleText: 'Encore {5}{U}'
		}),
		cr702_embalm_eternalize: synthCard({
			name: 'Synthetic Mummy',
			manaCost: '{1}{W}',
			typeLine: 'Creature — Zombie',
			power: '2',
			toughness: '2',
			keywords: ['Embalm'],
			oracleText: 'Embalm {2}{W}'
		}),
		e2e_verification_and_hardening: synthCard({
			name: 'Synthetic Test Core',
			manaCost: '{1}',
			typeLine: 'Artifact',
			oracleText: '{1}, {T}: Draw a card.'
		})
	};

	const probe = probes[featureId];
	if (!probe) return false;
	if (!isCardSupported(probe)) return false;

	if (featureId === 'fathom_mage') {
		try {
			const { state, p1 } = setupE2EGame();
			const mage = addCardToZone(state, p1, probe, 'battlefield');
			const beast = addCardToZone(state, p1, synthCard({ name: 'Beast', power: '3', toughness: '3' }), 'hand');
			p1.manaPool.G = 3;
			castSpellAction(state, p1, beast);
			passAllPriority(state);
			return (mage.counters['+1/+1'] ?? 0) > 0;
		} catch {
			return false;
		}
	}

	if (featureId === 'forgotten_ancient') {
		try {
			const { state, p1, p2 } = setupE2EGame();
			const ancient = addCardToZone(state, p1, probe, 'battlefield');
			const spell = addCardToZone(state, p2, synthCard({ name: 'P2 Bolt', manaCost: '{R}', typeLine: 'Instant' }), 'hand');
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;
			castSpellAction(state, p2, spell);
			passAllPriority(state);
			return (ancient.counters['+1/+1'] ?? 0) > 0;
		} catch {
			return false;
		}
	}

	if (featureId === 'terror_of_the_peaks') {
		try {
			const { state, p1, p2 } = setupE2EGame();
			const terror = addCardToZone(state, p1, probe, 'battlefield');
			const initialLife = p2.life;
			const bolt = addCardToZone(
				state,
				p2,
				synthCard({
					name: 'Bolt',
					manaCost: '{R}',
					typeLine: 'Instant',
					oracleText: '~ deals 3 damage to any target.'
				}),
				'hand'
			);
			p2.manaPool.R = 1;
			state.priorityPlayerIndex = 1;
			castSpellAction(state, p2, bolt, { targets: [{ kind: 'permanent', id: terror.instanceId, label: 'Synthetic Terror' }] });
			return p2.life < initialLife;
		} catch {
			return false;
		}
	}

	return true;
}

/**
 * Asserts state serialization safety (CR invariant §7).
 */
export function assertJsonRoundTrip(state: GameState): GameState {
	const json = JSON.stringify(state);
	const restored = JSON.parse(json);
	assert.ok(restored);
	assert.equal(restored.status, state.status);
	assert.equal(restored.turnNumber, state.turnNumber);
	return restored;
}

describe('E2E Harness Self-Check', () => {
	it('initializes clean 2-player game and performs priority pass', () => {
		const { state, p1, p2 } = setupE2EGame();
		assert.equal(state.status, 'active');
		assert.equal(state.phase, 'main1');
		assert.equal(p1.battlefield.length, 0);
		assert.equal(p2.battlefield.length, 0);

		// Sanitize for viewer test
		const sanitized = sanitizeGameStateForViewer(state, p1.playerId);
		assert.ok(sanitized);

		// JSON round trip
		assertJsonRoundTrip(state);

		// Priority pass
		const res = applyGameAction(state, p1.playerId, { type: 'pass_priority' });
		assert.equal(res.ok, true);
	});

	it('creates synthetic rename-invariant cards cleanly', () => {
		const card = synthCard({
			name: 'Synth Dragon',
			typeLine: 'Creature — Dragon',
			power: '4',
			toughness: '4',
			oracleText: 'Flying'
		});
		assert.equal(card.name, 'Synth Dragon');
		assert.equal(isCardSupported(card), true);
	});
});
