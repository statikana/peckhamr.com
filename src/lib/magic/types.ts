import type { CostDef, TargetSpec } from './ir.ts';

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
	/**
	 * Plan section 2.7: whether decks may contain cards with abilities the engine doesn't automate.
	 * Default true. Absent (lobbies saved before this rule) means true.
	 */
	allowUnsupportedCards?: boolean;
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
	maxPlayers: 4,
	allowUnsupportedCards: true
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

export interface TargetRequirementInfo {
	requiresTarget: boolean;
	targetKind: string;
	minTargets: number;
	maxTargets: number;
	zone: 'battlefield' | 'stack' | 'graveyard' | 'player' | 'any' | 'none';
	sameGraveyard: boolean;
	controllerFilter: 'any' | 'you' | 'opponent';
	cardTypeFilter?: string;
	isModal?: boolean;
	modalBranches?: TargetRequirementInfo[];
	targetSpecs?: TargetSpec[];
}

export interface EffectiveActivatedAbility {
	id: string;
	label: string;
	costText: string;
	manaCost: string;
	cost: CostDef[];
	costComplete: boolean;
	requiresTap: boolean;
	requiresSacrificeSelf: boolean;
	lifeCost: number;
	loyaltyCost: number | null;
	isManaAbility: boolean;
	sorcerySpeedOnly?: boolean;
	producesMana: ManaColor[];
	producesAmount: number;
	effectText: string;
	requiresTarget: boolean;
	targetKind: string;
	targetInfo: TargetRequirementInfo;
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

export interface TokenCreationSpec {
	name: string;
	power: number;
	toughness: number;
	colors: ManaColor[];
	typeLine: string;
	keywords: string[];
}

export interface CardInstance {
	instanceId: string;
	card: ScryfallCard;
	ownerId: string;
	controllerId: string;
	/** CR 110.2 / 800.4a / 800.4c: The player under whose control this permanent entered the battlefield. */
	defaultControllerId?: string;
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
	requiresGuidedResolution: boolean;
	createdAt: number;
	isCopy?: boolean;
	sourceObjectVersion?: number;
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
	/** Step F: id of an activated ability on its source card (`act_0`, `loyalty_1`, `equip_2`). */
	abilityId?: string;
	/** Step F: chosen mode indices of a modal spell (CR 700.2, 601.2b). */
	chosenModes?: number[];
	/** Step F: plain-data payload for a delayed trigger created by a resolving effect. */
	delayedEffect?: DelayedTriggerEffect;
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
	/** "You may" triggered abilities: the controller's answer, once asked on resolution. */
	optionalAccepted?: boolean;
	/**
	 * Step E2: resolution has started (targets re-checked, LKI captured, resolve VFX shown). Set
	 * when a resolution pauses for a prompt, so resuming it doesn't repeat those one-time steps.
	 */
	resolutionStarted?: boolean;
	/**
	 * Step E2: where the IR interpreter paused for a human's choice (CR 608.2n: the spell or ability
	 * stays on the stack until it finishes resolving). Plain data, so it survives the server's JSON
	 * round trip; the steps themselves are recompiled from the card on resume, never stored.
	 */
	effectResume?: EffectResumeFrame;
	/**
	 * Step E2 (plan section 2.7): the ability isn't automated and its human controller is applying it
	 * by hand (`'awaiting'`: guided prompt open; `'done'`: finish resolving without effects).
	 */
	manualResolution?: 'awaiting' | 'done';
}

/** One binding of the IR interpreter ("it", "that creature"): the objects and their LKI. */
export interface EffectBindingSnapshot {
	id: string;
	lki: TriggerEventLki;
}

/**
 * Step E2: a paused IR resolution. `stepIndex` is the step that asked for a choice; it runs again
 * from its start on resume, with `answers` (chosen object ids per player) filling in the choices.
 */
export interface EffectResumeFrame {
	stepIndex: number;
	bindings: Array<[string, EffectBindingSnapshot[]]>;
	exileSelf?: boolean;
	answers: Record<string, string[]>;
}

/** Last known information of a trigger's event object (plain data, JSON-serialisable). */
export interface TriggerEventLki {
	controllerId: string;
	ownerId: string;
	power: number;
	toughness: number;
	manaValue: number;
}

export type DelayedTriggerEffect =
	| { kind: 'exile'; targetInstanceId: string; targetObjectVersion?: number }
	| { kind: 'lose' }
	| { kind: 'draw'; playerId: string; amount: number; upTo?: boolean };

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
	/** Step F: `${turnNumber}:${activePlayerIndex}` of a turn in which it must not trigger ("the next turn's upkeep"). */
	notDuringTurn?: string;
	title?: string;
	oracleText?: string;
	description?: string;
	delayedEffect?: DelayedTriggerEffect;
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
		| 'deal_damage'
		/** Step E2: tap / untap a permanent; mill `amount` cards from player `targetId`'s library. */
		| 'tap'
		| 'untap'
		| 'mill';
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
	/**
	 * Step E2: what answering this prompt continues. Plain data (never a callback), so a prompt
	 * answered after the server reloads the state from JSON still continues the game.
	 */
	continuation?: PromptContinuation;
}

/**
 * Step E2: data-only prompt continuations, handled in engine.ts `handlePromptResolution`.
 * - `effect_choice`: a paused IR resolution (sacrifice / discard choice); the answer is stored in
 *   the stack item's `effectResume.answers` and the item resumes resolving.
 * - `effect_resume`: a scry / search prompt queued by an IR step that isn't the ability's last; the
 *   prompt does its own work, then the item resumes at `stepIndex` (the next step).
 * - `manual_resolution`: an unsupported spell or ability being applied by hand (guided operations);
 *   the item then finishes resolving.
 * - `manual_ability`: the "Resolve manually" escape hatch for any ability of a card; never touches
 *   the stack.
 * - `handler`: a named handler registered at module load (runtime/choices.ts
 *   `registerPromptHandler`), for generic prompts that need no engine state.
 */
export type PromptContinuation =
	| { kind: 'effect_choice'; stackItemId: string; stepIndex: number }
	| { kind: 'effect_resume'; stackItemId: string; stepIndex: number }
	| { kind: 'manual_resolution'; stackItemId: string }
	| { kind: 'manual_ability'; sourceInstanceId: string }
	| { kind: 'handler'; name: string; data?: Record<string, string | number | boolean | null> };

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
	/**
	 * CR 500.7: Seat index of the player whose normal turn most recently ran before a chain of one or
	 * more extra turns began, so normal turn order resumes from the next seat after extra turns finish.
	 */
	lastNormalTurnPlayerIndex?: number;
	stackTriggersEnabled?: boolean;
	rngState?: number;
	nextUid?: number;
	idSalt?: number;
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
			modes?: number[];
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
	/**
	 * Step E2 escape hatch: open a guided (manual) resolution for one of a card's abilities while the
	 * player has priority. `abilityIndex` indexes `cardSupportReport(card).unsupported`; without it
	 * the card's whole text is shown. Never uses the stack.
	 */
	| { type: 'resolve_manually'; instanceId: string; abilityIndex?: number }
	| { type: 'toggle_full_control'; enabled: boolean }
	| { type: 'toggle_stop_phase'; phase: GamePhase }
	| { type: 'concede' };
