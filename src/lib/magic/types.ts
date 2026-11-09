export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

export type ManaPool = Record<ManaColor, number>;

export type ZoneType =
	| 'library'
	| 'hand'
	| 'battlefield'
	| 'graveyard'
	| 'exile'
	| 'command'
	| 'stack';

export type GamePhase =
	| 'untap'
	| 'upkeep'
	| 'draw'
	| 'main1'
	| 'begin_combat'
	| 'declare_attackers'
	| 'declare_blockers'
	| 'first_strike_damage'
	| 'combat_damage'
	| 'end_combat'
	| 'main2'
	| 'end_step'
	| 'cleanup';

export const PHASE_ORDER: GamePhase[] = [
	'untap',
	'upkeep',
	'draw',
	'main1',
	'begin_combat',
	'declare_attackers',
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat',
	'main2',
	'end_step',
	'cleanup'
];

export const PHASE_LABELS: Record<GamePhase, string> = {
	untap: 'Untap',
	upkeep: 'Upkeep',
	draw: 'Draw',
	main1: 'Main 1',
	begin_combat: 'Begin Combat',
	declare_attackers: 'Attackers',
	declare_blockers: 'Blockers',
	first_strike_damage: 'First Strike',
	combat_damage: 'Combat Damage',
	end_combat: 'End Combat',
	main2: 'Main 2',
	end_step: 'End Step',
	cleanup: 'Cleanup'
};

export interface ScryfallCard {
	id: string;
	oracleId?: string;
	name: string;
	manaCost: string;
	cmc: number;
	typeLine: string;
	oracleText: string;
	colors: ManaColor[];
	colorIdentity: ManaColor[];
	keywords: string[];
	power?: string;
	toughness?: string;
	loyalty?: string;
	imageUrl: string;
	artCropUrl: string;
	rarity?: string;
	setCode?: string;
	collectorNumber?: string;
	legalCommander: boolean;
	canBeCommander: boolean;
	hasPartner: boolean;
	hasChooseBackground: boolean;
	isBackground: boolean;
	backFace?: {
		name: string;
		manaCost: string;
		typeLine: string;
		oracleText: string;
		power?: string;
		toughness?: string;
		loyalty?: string;
		imageUrl: string;
	};
}

export interface DeckCardEntry {
	quantity: number;
	card: ScryfallCard;
	isCommander?: boolean;
}

export interface MagicDeck {
	id: string;
	userId: string;
	name: string;
	description: string;
	commanders: ScryfallCard[];
	cards: DeckCardEntry[];
	colorIdentity: ManaColor[];
	cardCount: number;
	isLegal: boolean;
	validationErrors: string[];
	winCount: number;
	playCount: number;
	isPrecon?: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface MagicUser {
	id: string;
	provider: 'google' | 'github' | 'guest' | 'dev';
	providerId: string;
	email: string;
	username: string;
	avatarUrl: string;
	isGuest?: boolean;
	stats: {
		gamesPlayed: number;
		wins: number;
		favoriteCommander?: string;
	};
	createdAt: number;
	lastLoginAt: number;
}

export interface LobbyRulesConfig {
	startingLife: number; // default: 40
	commanderDamageLethal: number; // default: 21 (0 = disabled)
	commanderTaxIncrement: number; // default: 2
	poisonLethal: number; // default: 10 (0 = disabled)
	mulliganRule: 'london_1free' | 'london_standard' | 'friendly_unlimited' | 'strict_london' | 'free_all';
	deckValidationMode: 'strict_commander' | 'rule0_relaxed';
	turnTimerSeconds: number; // default: 90 (0 = untimed)
	firstTurnDraw: boolean; // default: true in multiplayer Commander
	maxHandSize: number; // default: 7 (99 = unlimited)
	maxPlayers: 2 | 3 | 4; // default: 4
}

export const DEFAULT_LOBBY_RULES: LobbyRulesConfig = {
	startingLife: 40,
	commanderDamageLethal: 21,
	commanderTaxIncrement: 2,
	poisonLethal: 10,
	mulliganRule: 'london_1free',
	deckValidationMode: 'strict_commander',
	turnTimerSeconds: 90,
	firstTurnDraw: true,
	maxHandSize: 7,
	maxPlayers: 4
};

export interface LobbySeat {
	seatIndex: number;
	userId: string | null;
	username: string;
	avatarUrl: string;
	isBot: boolean;
	isGuest?: boolean;
	botDifficulty?: 'casual' | 'focused' | 'competitive';
	deckId: string | null;
	deckName: string;
	commanderNames: string[];
	commanderArtUrl: string;
	colorIdentity: ManaColor[];
	isDeckLegal: boolean;
	ready: boolean;
	lastHeartbeat: number;
}

export type CounterType =
	| '+1/+1'
	| '-1/-1'
	| 'loyalty'
	| 'charge'
	| 'shield'
	| 'stun'
	| 'lore'
	| 'time';

export type TargetKind =
	| 'any'
	| 'creature'
	| 'controlled_creature'
	| 'player'
	| 'permanent'
	| 'nonland_permanent'
	| 'artifact_or_enchantment'
	| 'spell'
	| 'graveyard_card'
	| 'none';

export interface TargetRequirementInfo {
	requiresTarget: boolean;
	targetKind: TargetKind;
	minTargets: number;
	maxTargets: number;
	zone: 'battlefield' | 'stack' | 'graveyard' | 'player' | 'any' | 'none';
	sameGraveyard: boolean;
	controllerFilter: 'any' | 'you' | 'opponent';
	cardTypeFilter?: string;
	isModal?: boolean;
	modalBranches?: TargetRequirementInfo[];
}

export interface ParsedActivatedAbility {
	id: string;
	label: string;
	costText: string;
	manaCost: string;
	requiresTap: boolean;
	requiresSacrificeSelf: boolean;
	lifeCost: number;
	loyaltyCost: number | null; // e.g., +1, -2, -7 for planeswalkers
	isManaAbility: boolean;
	sorcerySpeedOnly?: boolean;
	producesMana: ManaColor[];
	producesAmount: number;
	effectText: string;
	requiresTarget: boolean;
	targetKind: TargetKind;
}

export interface LibrarySearchDestination {
	zone: 'battlefield' | 'hand' | 'library';
	tapped?: boolean;
	onTop?: boolean;
}

export interface LibrarySearchSpec {
	statedQuality: boolean; // false only for unrestricted "a card" / "N cards" tutors (must find if library non-empty per CR 701.19b)
	upTo: boolean;
	count: number;
	requireBasic?: boolean;
	requireLegendary?: boolean;
	allowedTypes: string[]; // e.g. ['Land'], ['Creature'], ['Instant', 'Sorcery'], ['Artifact', 'Enchantment']
	allowedSubtypes: string[]; // e.g. ['Plains', 'Island', 'Swamp', 'Mountain'], ['Forest'], ['Equipment']
	disallowedTypes: string[]; // e.g. ['Basic'] for nonbasic, ['Land'] for nonland
	allowedColors?: ManaColor[];
	maxCmc?: number;
	exactCmc?: number;
	destinations: LibrarySearchDestination[];
	rawCriteriaText: string;
}

export interface PlayableFromExilePermission {
	playerId: string;
	spendManaAsAnyColor: boolean;
	sourceName: string;
}

export interface LibrarySearchInterceptorInfo {
	controllerId: string;
	sourceInstanceId: string;
	sourceName: string;
	exilesFoundCards: boolean;
	grantPlayFromExile: boolean;
	spendManaAsAnyColor: boolean;
}

export interface ParsedEffect {
	kind:
		| 'draw'
		| 'scry'
		| 'rearrange_top'
		| 'mill'
		| 'gain_life'
		| 'lose_life_opponents'
		| 'damage_target'
		| 'damage_each_opponent'
		| 'damage_all_creatures'
		| 'destroy_target'
		| 'destroy_all_creatures'
		| 'exile_target'
		| 'counter_target_spell'
		| 'bounce_target'
		| 'search_land_to_battlefield'
		| 'search_library_to_hand'
		| 'create_token'
		| 'add_counters_self'
		| 'add_counters_target'
		| 'add_counters_team'
		| 'pump_self_eot'
		| 'pump_target_eot'
		| 'pump_team_eot'
		| 'grant_keyword_target_eot'
		| 'proliferate'
		| 'add_mana'
		| 'reanimate_target'
		| 'return_from_graveyard_to_hand'
		| 'exile_all_graveyards'
		| 'equip_target'
		| 'end_the_turn'
		| 'may_end_the_turn'
		| 'extra_turn'
		| 'phase_out_target'
		| 'phase_out_team'
		| 'switch_pt_target'
		| 'suspend_tick_down'
		| 'suspend_cast_free'
		| 'win_the_game'
		| 'lose_the_game_self'
		| 'sacrifice_self'
		| 'copy_target_permanent'
		| 'copy_target_spell'
		| 'return_self_from_graveyard'
		| 'ward_trigger';
	amount: number;
	toughnessAmount?: number;
	manaColors?: ManaColor[];
	tokenSpec?: {
		name: string;
		power: number;
		toughness: number;
		colors: ManaColor[];
		typeLine: string;
		keywords: string[];
	};
	counterType?: CounterType;
	tapped?: boolean;
	dynamicFormula?: string;
	mayShuffle?: boolean;
	searchSpec?: LibrarySearchSpec;
	recipient?: 'self' | 'target_controller';
	grantedKeyword?: string;
	wardCost?: string;
}

export interface CardInstance {
	instanceId: string;
	card: ScryfallCard;
	ownerId: string;
	controllerId: string;
	zone: ZoneType;
	tapped: boolean;
	summoningSick: boolean;
	damageMarked: number;
	deathtouchDamageMarked: boolean;
	counters: Record<CounterType, number>;
	tempPowerMod: number;
	tempToughnessMod: number;
	grantedKeywords: string[];
	attachedToId: string | null;
	isToken: boolean;
	isCommander: boolean;
	commanderCastCount: number;
	usedLoyaltyThisTurn: boolean;
	transformed: boolean;
	enteredTimestamp?: number;
	objectVersion?: number;
	copiableCard?: ScryfallCard;
	printedCard?: ScryfallCard;
	enteredWithX?: number;
	phasedOut?: boolean;
	phasedOutIndirectly?: boolean;
	isSuspended?: boolean;
	castViaSuspend?: boolean;
	switchedPTCount?: number;
	isFaceDown?: boolean;
	goadedByPlayerIds?: string[];
	playableFromExileBy?: PlayableFromExilePermission;
	commanderSbaDeclinedVersion?: number;
	lastKnownCounters?: Record<CounterType, number>;
	lastKnownPower?: number;
	lastKnownToughness?: number;
	damagePreventionShield?: number;
}

export interface TargetRef {
	kind: 'permanent' | 'player' | 'stack' | 'graveyard_card' | 'card_in_graveyard';
	id: string; // instanceId, playerId, or stackItemId
	label: string;
}

export type TriggerScope = 'controller_turn' | 'each_turn' | 'opponent_turn';

export type TriggerCondition =
	| { kind: 'life_at_least'; amount: number }
	| { kind: 'controls_count_at_least'; count: number; cardType: string }
	| { kind: 'graveyard_creatures_above_at_least'; count: number }
	| { kind: 'unrecognized'; raw: string };

export interface StructuredTriggeredAbility {
	scope: TriggerScope;
	condition?: TriggerCondition;
	effects: ParsedEffect[];
	clause: string;
}

export interface StackItem {
	id: string;
	sourceInstanceId: string;
	card: ScryfallCard;
	ownerId?: string;
	controllerId: string;
	kind: 'spell' | 'activated' | 'triggered';
	title: string;
	oracleText: string;
	targets: TargetRef[];
	xValue: number;
	castMode?: 'normal' | 'overload';
	commanderCastCount?: number;
	parsedEffects: ParsedEffect[];
	requiresGuidedResolution: boolean;
	createdAt: number;
	isCopy?: boolean;
	sourceObjectVersion?: number;
	interveningIfCondition?: TriggerCondition;
	lkiPower?: number;
	lkiToughness?: number;
	lkiTypeLine?: string;
	lkiControllerId?: string;
	sourceLkiPower?: number;
	sourceLkiToughness?: number;
	declineWard?: boolean;
	/**
	 * Phase 5: for a triggered ability put on the stack by runtime/triggers.ts, the index of the
	 * ability in its source card's compiled abilities (compileCard(card).faces[0].abilities). Used to
	 * re-check the intervening-if condition on resolution (CR 603.4) without storing IR in state.
	 */
	triggeredAbilityIndex?: number;
	targetObjectVersions?: Record<string, number>;
	/**
	 * Steps C+D: the trigger event a triggered ability refers to ("that creature", "that player",
	 * "that many"). Not targets: they are never checked for legality (CR 603.7c, 608.2b).
	 * `eventObjectId` is the object the event was about (the source itself for "When ~ enters");
	 * `eventLki` is how it last existed on the battlefield (CR 603.10a, 608.2h).
	 */
	eventObjectId?: string;
	eventObjectVersion?: number;
	eventPlayerId?: string;
	eventAmount?: number;
	/** The spell or ability that targeted the source (Ward). */
	eventStackItemId?: string;
	eventLki?: TriggerEventLki;
	/**
	 * Transitional (step F deletes it): the event ref the pre-IR engine passed to a triggered
	 * ability's legacy ParsedEffects as `targets[0]`. Used only by the legacy fallback.
	 */
	legacyEventTarget?: TargetRef;
	/** "You may" triggered abilities: the controller's answer, once asked on resolution. */
	optionalAccepted?: boolean;
}

/** Last known information of a trigger's event object (plain data, JSON-serialisable). */
export interface TriggerEventLki {
	controllerId: string;
	ownerId: string;
	power: number;
	toughness: number;
	manaValue: number;
}

export interface DelayedTrigger {
	id: string;
	controllerId: string;
	sourceInstanceId?: string;
	sourceCard: ScryfallCard;
	triggerPhase: GamePhase;
	onlyOnPlayerTurnId?: string;
	targetPlayerId?: string;
	targetInstanceId?: string;
	targetObjectVersion?: number;
	waitUntilAfterTurn?: number;
	title?: string;
	oracleText?: string;
	description?: string;
	effects: ParsedEffect[];
	createdAtTurn?: number;
}

export interface CombatAttacker {
	attackerInstanceId: string;
	controllerId: string;
	defenderPlayerId: string;
	defenderPlaneswalkerId?: string | null;
	blockerInstanceIds: string[];
	wasBlocked?: boolean;
}

export interface CombatState {
	active: boolean;
	attackers: CombatAttacker[];
	declaredBlockersPlayerIds: string[];
	damageDealtFirstStrike: boolean;
	damageDealtNormal: boolean;
	dealtFirstStrikeDamageIds?: string[];
	blockersDeclared?: boolean;
}

export const ENGINE_VERSION = 1;

export type ChoiceKind =
	| 'yesNo'
	| 'chooseObjects'
	| 'chooseMode'
	| 'chooseNumber'
	| 'orderObjects'
	| 'chooseReplacement';

export type ChoiceRequest =
	| { kind: 'yesNo'; question: string }
	| {
			kind: 'chooseObjects';
			candidates: string[];
			min: number;
			max: number;
			zone: ZoneType;
			reason: string;
	  }
	| { kind: 'chooseMode'; modes: string[]; min: number; max: number }
	| { kind: 'chooseNumber'; min: number; max: number; reason: string }
	| {
			kind: 'orderObjects';
			objectIds: string[];
			allowSplitBottom?: boolean;
			allowShuffle?: boolean;
			reason: string;
	  }
	| { kind: 'chooseReplacement'; options: Array<{ id: string; label: string }> };

export type ChoiceAnswer =
	| { kind: 'yesNo'; yes: boolean }
	| { kind: 'chooseObjects'; objectIds: string[] }
	| { kind: 'chooseMode'; indices: number[] }
	| { kind: 'chooseNumber'; n: number }
	| {
			kind: 'orderObjects';
			topIds: string[];
			bottomIds?: string[];
			shuffle?: boolean;
	  }
	| { kind: 'chooseReplacement'; id: string };

export interface GuidedOperation {
	op:
		| 'move_zone'
		| 'modify_life'
		| 'add_counter'
		| 'draw_cards'
		| 'create_token'
		| 'deal_damage';
	targetId?: string;
	destinationZone?: ZoneType;
	amount?: number;
	counterType?: CounterType;
	tokenName?: string;
	tokenPower?: number;
	tokenToughness?: number;
}

export type PendingPromptKind =
	| ChoiceKind
	| 'mulligan'
	| 'london_bottom'
	| 'discard_to_hand_size'
	| 'commander_zone_choice'
	| 'search_library'
	| 'scry_choice'
	| 'guided_resolution'
	| 'legend_rule'
	| 'cost_choice';

export type PromptPurpose =
	| 'mulligan'
	| 'london_bottom'
	| 'discard_to_hand_size'
	| 'commander_zone_choice'
	| 'end_turn'
	| 'search_library'
	| 'scry_choice'
	| 'guided_resolution'
	| 'legend_rule'
	| 'cost_choice'
	/** Steps C+D: choosing a triggered ability's targets as it's put on the stack (CR 603.3d). */
	| 'trigger_targets'
	/** Steps C+D: ordering a player's simultaneous triggered abilities (CR 603.3b). */
	| 'trigger_order'
	/** Steps C+D: "you may" in a resolving triggered ability. */
	| 'trigger_may'
	| 'generic';

export interface PendingPrompt {
	id: string;
	playerId: string;
	kind: PendingPromptKind;
	title: string;
	description: string;
	choice?: ChoiceRequest;
	purpose?: PromptPurpose;
	yesLabel?: string;
	noLabel?: string;
	cancellable?: boolean;
	countRequired?: number;
	candidateInstanceIds?: string[];
	allowBottom?: boolean;
	allowShuffle?: boolean;
	stackItem?: StackItem;
	continuationEffects?: ParsedEffect[];
	commanderInstanceId?: string;
	destinationZone?: ZoneType;
	enterTapped?: boolean;
	putOnTop?: boolean;
	secondLandToHand?: boolean;
	secondLandToBattlefield?: boolean;
	searchSpec?: LibrarySearchSpec;
	remainingDestinations?: LibrarySearchDestination[];
	targetLibraryOwnerId?: string;
	canFailToFind?: boolean;
	interceptedBy?: LibrarySearchInterceptorInfo;
	/**
	 * cost_choice (Phase 4/8): the cast/activate/tap action waiting for a cost choice. Answering
	 * merges the choice into its `costPayment` and runs it again from scratch.
	 */
	pendingAction?: GameActionPayload;
	costQuestion?: { kind: 'option' | 'objects'; index: number };
	costOptionLabels?: string[];
	/** trigger_targets / trigger_may: the triggered ability's stack item (by id; state stays plain data). */
	triggerStackItemId?: string;
	/** trigger_targets: which of the ability's target specs this prompt chooses for. */
	triggerTargetSpecIndex?: number;
}

/**
 * The player's choices for paying a cost (CR 601.2b/h, 602.2b), validated by the server. Indices
 * follow the order of the costs: `options[i]` answers the i-th choice between costs (an optional
 * cost is the choice [pay, don't pay]); `objects[j]` lists the objects chosen for the j-th cost that
 * needs objects (sacrifice, discard, tap untapped ..., exile from a zone), counted after choices.
 */
export interface CostPayment {
	options?: number[];
	objects?: string[][];
}

export interface VfxEvent {
	id: string;
	timestamp: number;
	kind:
		| 'spell_cast'
		| 'stack_resolve'
		| 'damage'
		| 'heal'
		| 'destroy'
		| 'exile'
		| 'counter_spell'
		| 'commander_cast'
		| 'attack_declare'
		| 'block_declare'
		| 'token_create'
		| 'proliferate'
		| 'phase_change'
		| 'victory';
	sourceId?: string;
	targetId?: string;
	color?: string;
	amount?: number;
	label?: string;
}

export interface GameLogEntry {
	id: string;
	timestamp: number;
	turn: number;
	phase: GamePhase;
	actorId?: string;
	kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system';
	text: string;
}

export interface PlayerGameState {
	playerId: string;
	seatIndex: number;
	username: string;
	avatarUrl: string;
	isBot: boolean;
	life: number;
	poison: number;
	experienceCounters: number;
	energyCounters: number;
	manaPool: ManaPool;
	landsPlayedThisTurn: number;
	maxLandsPerTurn: number;
	mulliganCount: number;
	hasKeptHand: boolean;
	lost: boolean;
	lossReason?: string;
	commanderDamageTaken: Record<string, number>; // commanderInstanceId -> combat damage taken
	commanderNames: Record<string, string>; // commanderInstanceId -> card name
	commanderCastCounts: Record<string, number>; // commanderInstanceId -> times cast from Command Zone
	autoPassEmptyStack: boolean;
	fullControl: boolean;
	stopPhases: GamePhase[];
	library: CardInstance[];
	hand: CardInstance[];
	battlefield: CardInstance[];
	graveyard: CardInstance[];
	exile: CardInstance[];
	command: CardInstance[];
	handCount?: number;
	libraryCount?: number;
	spellsCastThisTurn?: number;
	cannotLoseGameThisTurn?: boolean;
	lifeTotalCannotChangeThisTurn?: boolean;
	protectionFromEverythingThisTurn?: boolean;
	damagePreventionShield?: number;
	preventAllCombatDamageThisTurn?: boolean;
	attemptedEmptyLibraryDraw?: boolean;
	commanderColorIdentity?: ManaColor[];
}

export interface GameState {
	engineVersion: number;
	gameId: string;
	lobbyCode: string;
	status: 'mulligan' | 'active' | 'finished';
	winnerPlayerId: string | null;
	winnerId?: string;
	rules: LobbyRulesConfig;
	turnNumber: number;
	activePlayerIndex: number;
	priorityPlayerIndex: number;
	passedPriorityPlayerIds: string[];
	phase: GamePhase;
	players: PlayerGameState[];
	stack: StackItem[];
	combat: CombatState;
	pendingPrompts: PendingPrompt[];
	recentVfxEvents: VfxEvent[];
	log: GameLogEntry[];
	turnStartedAt: number;
	priorityUpdatedAt: number;
	nextTimestamp?: number;
	delayedTriggers?: DelayedTrigger[];
	/**
	 * Steps C+D: how many triggered abilities were put on the stack this turn (runaway-loop cap; a
	 * trigger that retriggers itself keeps the stack shallow but never ends).
	 */
	triggersPlacedThisTurn?: { turn: number; count: number };
	extraTurnQueue?: string[];
	stackTriggersEnabled?: boolean;
	rngState?: number;
}

export interface MagicLobby {
	code: string;
	name: string;
	hostUserId: string;
	status: 'waiting' | 'active' | 'finished';
	isPrivate: boolean;
	rules: LobbyRulesConfig;
	seats: LobbySeat[];
	gameState: GameState | null;
	version: number;
	createdAt: number;
	updatedAt: number;
}

export interface MagicChatMessage {
	id: string;
	lobbyCode: string;
	userId: string;
	username: string;
	avatarUrl: string;
	seatIdx: number;
	kind: 'chat' | 'system' | 'game_log' | 'emote';
	message: string;
	createdAt: number;
}

export type GameActionPayload =
	| {
			type: 'choice';
			promptId: string;
			answer?: ChoiceAnswer;
			cancel?: boolean;
			operations?: GuidedOperation[];
	  }
	| { type: 'mulligan_keep' }
	| { type: 'mulligan_take' }
	| { type: 'london_bottom'; instanceIds: string[] }
	| { type: 'pass_priority' }
	| { type: 'end_turn' }
	| { type: 'play_land'; instanceId: string; fromZone?: 'hand' | 'exile' }
	| { type: 'tap_mana'; instanceId: string; preferredColor?: ManaColor; costPayment?: CostPayment }
	| {
			type: 'cast_spell';
			instanceId: string;
			targets?: TargetRef[];
			xValue?: number;
			castMode?: 'normal' | 'overload';
			fromZone?: 'hand' | 'command' | 'graveyard' | 'exile';
			costPayment?: CostPayment;
	  }
	| {
			type: 'activate_ability';
			instanceId: string;
			abilityId: string;
			targets?: TargetRef[];
			costPayment?: CostPayment;
	  }
	/** Compatibility alias for answering a `cost_choice` prompt. */
	| { type: 'cost_choice'; promptId: string; option?: number; instanceIds?: string[]; cancel?: boolean }
	| { type: 'suspend_card'; instanceId: string }
	| { type: 'reorder_graveyard'; instanceIds: string[] }
	| {
			type: 'declare_attackers';
			assignments: Array<{
				attackerInstanceId: string;
				defenderPlayerId: string;
				defenderPlaneswalkerId?: string | null;
			}>;
	  }
	| {
			type: 'declare_blockers';
			assignments: Array<{
				blockerInstanceId: string;
				attackerInstanceId: string;
			}>;
	  }
	| { type: 'discard_cards'; instanceIds: string[] }
	| { type: 'discard_hand_size'; instanceIds: string[] }
	| { type: 'commander_zone_choice'; commanderInstanceId: string; sendToCommandZone: boolean }
	| { type: 'commander_zone_decision'; commanderInstanceId?: string; sendToCommandZone: boolean }
	| { type: 'search_library_pick'; instanceId: string | null }
	| {
			type: 'scry_resolve';
			topInstanceIds: string[];
			bottomInstanceIds: string[];
			shuffleAfter?: boolean;
	  }
	| {
			type: 'scry_decision';
			topInstanceIds: string[];
			bottomInstanceIds: string[];
			shuffleAfter?: boolean;
	  }
	| { type: 'legend_rule_keep'; keepInstanceId: string }
	| { type: 'legend_rule_choice'; keepInstanceId: string }
	| {
			type: 'guided_resolve';
			operations: GuidedOperation[];
	  }
	| {
			type: 'guided_resolution_finish';
			operations?: GuidedOperation[];
	  }
	| { type: 'toggle_full_control'; enabled: boolean }
	| { type: 'toggle_stop_phase'; phase: GamePhase }
	| { type: 'concede' };
