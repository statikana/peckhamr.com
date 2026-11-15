import type {
	ActivationRestriction,
	Amount,
	Condition,
	CostDef,
	ManaRestriction,
	ModalDef,
	StackTargetKind,
	TargetSpec
} from './ir.ts';
import type { RuntimeTrigger } from './compiler/triggers.ts';
import type { ManaCostRequirement } from './oracle.ts';

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

export type CardLayout =
	| 'normal'
	| 'split'
	| 'flip'
	| 'transform'
	| 'modal_dfc'
	| 'adventure'
	| 'meld'
	| 'reversible_card';

export interface ScryfallCardFace {
	name: string;
	manaCost: string;
	cmc?: number;
	typeLine: string;
	oracleText: string;
	colors: ManaColor[];
	colorIndicator?: ManaColor[];
	keywords?: string[];
	power?: string;
	toughness?: string;
	loyalty?: string;
	defense?: string;
	imageUrl: string;
	artCropUrl?: string;
}

export interface FaceDownSpec {
	kind: 'morph' | 'megamorph' | 'disguise' | 'manifest' | 'cloak' | 'cyberman' | 'other';
	castManaCost?: string;
	turnUpCost?: string;
	turnUpManaCost?: string;
	turnUpCostDefs?: CostDef[];
	wardCost?: string;
	supertypes?: string[];
	types?: string[];
	subtypes?: string[];
	power?: number;
	toughness?: number;
	colors?: ManaColor[];
	knownToPlayerIds?: string[];
}

export interface CopiableState {
	card: ScryfallCard;
	faceIndex?: number;
	fused?: boolean;
	isSingleFaceCopy?: boolean;
	// --- Track P6 ---
	/** CR 719.3d: preserved on copies of a prototyped spell or permanent. */
	prototyped?: boolean;
	except?: {
		power?: number;
		toughness?: number;
		types?: string[];
		subtypes?: string[];
		supertypes?: string[];
		colors?: ManaColor[];
		names?: string[];
		removeSupertypes?: string[];
		// --- Track P7 & P8 ---
		addColors?: ManaColor[];
		addTypes?: string[];
		addSubtypes?: string[];
		addKeywords?: string[];
		noManaCost?: boolean;
	};
}

export interface ScryfallCard {
	id: string;
	oracleId?: string;
	layout?: CardLayout;
	name: string;
	manaCost: string;
	cmc: number;
	typeLine: string;
	oracleText: string;
	colors: ManaColor[];
	colorIndicator?: ManaColor[];
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
	faces?: ScryfallCardFace[];
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

export type BotSpeed = 'instant' | 'fast' | 'normal' | 'slow';

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
	/** AI bot pacing speed between visible bot actions. Absent (older lobbies) means 'normal'. */
	botSpeed?: BotSpeed;
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
	allowUnsupportedCards: true,
	botSpeed: 'normal'
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
	| 'time'
	// --- Track P3 ---
	| 'age'
	// --- Track P6 ---
	| 'level'
	| 'fade'
	// --- Track P11 ---
	| 'flying'
	| 'first strike'
	| 'double strike'
	| 'deathtouch'
	| 'haste'
	| 'hexproof'
	| 'indestructible'
	| 'lifelink'
	| 'menace'
	| 'reach'
	| 'trample'
	| 'vigilance'
	| 'finality'
	| 'oil'
	| 'ki'
	| 'quest'
	| 'storage'
	| 'verse'
	| 'spore'
	| 'divinity'
	| 'feather'
	| 'gold'
	| 'plague'
	| 'blight'
	| 'stash'
	| 'vitality';

export function createEmptyCounterMap(): Record<CounterType, number> {
	return {
		'+1/+1': 0,
		'-1/-1': 0,
		loyalty: 0,
		charge: 0,
		shield: 0,
		stun: 0,
		lore: 0,
		time: 0,
		age: 0,
		level: 0,
		fade: 0,
		flying: 0,
		'first strike': 0,
		'double strike': 0,
		deathtouch: 0,
		haste: 0,
		hexproof: 0,
		indestructible: 0,
		lifelink: 0,
		menace: 0,
		reach: 0,
		trample: 0,
		vigilance: 0,
		finality: 0,
		oil: 0,
		ki: 0,
		quest: 0,
		storage: 0,
		verse: 0,
		spore: 0,
		divinity: 0,
		feather: 0,
		gold: 0,
		plague: 0,
		blight: 0,
		stash: 0,
		vitality: 0
	};
}
	// --- End Track P11 ---

export interface TargetRequirementInfo {
	requiresTarget: boolean;
	targetKind: string;
	minTargets: number;
	maxTargets: number;
	zone: 'battlefield' | 'stack' | 'graveyard' | 'exile' | 'player' | 'any' | 'none';
	sameGraveyard: boolean;
	controllerFilter: 'any' | 'you' | 'opponent';
	cardTypeFilter?: string;
	stackKind?: StackTargetKind;
	isModal?: boolean;
	modalBranches?: TargetRequirementInfo[];
	targetSpecs?: TargetSpec[];
}

export interface ManaSpendContext {
	isSpell: boolean;
	isArtifactSpell?: boolean;
	capturedColorsSpent?: ManaColor[];
}

export interface EffectiveActivatedAbility {
	id: string;
	faceIndex?: number;
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
	activationRestrictions?: ActivationRestriction[];
	/** Zones from which this ability can be activated; omitted defaults to `['battlefield']`. */
	activationZones?: ZoneType[];
	/** Canonical keyword tag for ability cost modifiers (`'equip'`, `'cycling'`, etc.). */
	costKeyword?: string;
	producesMana: ManaColor[];
	producesAmount: number;
	/** Dynamic non-constant mana amount from IR, if any (transient, never serialized in GameState). */
	manaAmount?: Amount;
	/** Spending restriction on produced mana (CR 106.6). */
	manaRestriction?: ManaRestriction;
	/** Card that granted this ability via Layer 6 `grantAbility`, if granted (transient / plain card data). */
	grantSourceCard?: ScryfallCard;
	// --- Track P6 ---
	/** Existence condition for striated frames (CR 711.5 Leveler, CR 722.2 Station); transient / never serialized in GameState. */
	grantCondition?: import('./ir.ts').Condition;
	effectText: string;
	modal?: ModalDef;
	requiresTarget: boolean;
	targetKind: string;
	targetInfo: TargetRequirementInfo;
	// --- Track P4 ---
	/** CR 602.5b: conditional activation restriction ("Activate only if ..."). */
	activationCondition?: Condition;
	/** Exact multi-mana bundle options ("Add {W}{W}, {W}{B}, or {B}{B}"). */
	manaBundles?: ManaColor[][];
	/** Multi-mana combination color domain ("in any combination of colors" / "{R} and/or {G}"). */
	manaCombinationColors?: ManaColor[] | 'any';
	/** Depletion-land rider ("~ doesn't untap during your next untap step") on a mana ability (CR 605.1a). */
	freezesSelfUntap?: boolean;
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
	/** Exact card name match ("for a card named <name>", e.g. Partner with). */
	named?: string;
	destinations: LibrarySearchDestination[];
	reveal?: boolean;
	rawCriteriaText: string;
}

export interface PlayableFromExilePermission {
	playerId: string;
	spendManaAsAnyColor: boolean;
	sourceName: string;
	allowedFaceIndices?: number[];
	onAdventure?: boolean;
	expiresAtEndOfTurn?: boolean;
	// --- Track P2 ---
	duration?: 'thisTurn' | 'untilEndOfYourNextTurn' | 'untilYourNextEndStep' | 'asLongAsExiled';
	/** Player whose cleanup step expires an `'untilEndOfYourNextTurn'` permission once `turnSerial > grantedOnTurnSerial`. */
	expiresOnCleanupOfPlayerId?: string;
	/** `state.turnSerial ?? state.turnNumber` when the permission was granted. */
	grantedOnTurnSerial?: number;
	/** Player whose next `end_step` expires an `'untilYourNextEndStep'` permission (CR 611.2b). */
	expiresAtNextEndStepOfPlayerId?: string;
	/** `"may cast"`: only nonland spells may be cast; lands cannot be played (CR 601.1a). */
	spellsOnly?: boolean;
	/** `"without paying its mana cost"`: free alternative cost `{0}` with `X = 0` (CR 118.9, 107.3b). */
	withoutPayingManaCost?: boolean;
	// --- End Track P2 ---
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
	tapped?: boolean;
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
	/** CR 602.5b / 602.5c: IDs of activated abilities on this permanent already activated this turn. */
	activatedAbilityIdsThisTurn?: string[];
	/** Mode indices already chosen this turn for `"that hasn't been chosen this turn"` abilities on this permanent. */
	usedModalModesThisTurn?: number[];
	transformed: boolean;
	activeFaceIndex?: number;
	unlockedFaces?: number[];
	enteredTimestamp?: number;
	objectVersion?: number;
	copiableCard?: ScryfallCard;
	copiableState?: CopiableState;
	printedCard?: ScryfallCard;
	enteredWithX?: number;
	/** CR 702.33d / 400.7d: total optional kicker/multikicker count paid when cast. */
	kickedCount?: number;
	/** CR 702.33f / 400.7d: optional kicker tags paid when cast. */
	kickedTags?: string[];
	/** CR 702.74a / 400.7d: true when this permanent entered from a spell whose evoke cost was paid. */
	evoked?: boolean;
	/** CR 702.138b / 400.7d: true when this permanent entered from a spell whose escape cost was paid. */
	escaped?: boolean;
	/** CR 601.2h / 400.7d / CR 105: distinct colors of mana spent to cast this spell / permanent (Converge). */
	manaColorsSpent?: ManaColor[];
	/** CR 702.84a: true while on the battlefield via Unearth ("If it would leave the battlefield, exile it instead of putting it anywhere else"). */
	unearthLeaveExile?: boolean;
	phasedOut?: boolean;
	phasedOutIndirectly?: boolean;
	isSuspended?: boolean;
	castViaSuspend?: boolean;
	switchedPTCount?: number;
	isFaceDown?: boolean;
	faceDownSpec?: FaceDownSpec;
	faceDownLabel?: string;
	goadedByPlayerIds?: string[];
	/** Per-goader expiration timing (`'untilYourNextTurn'` default per CR 701.15a; `'endOfTurn'` if explicit). */
	goadExpirations?: Record<string, 'endOfTurn' | 'untilYourNextTurn'>;
	playableFromExileBy?: PlayableFromExilePermission;
	commanderSbaDeclinedVersion?: number;
	lastKnownCounters?: Record<CounterType, number>;
	lastKnownPower?: number;
	lastKnownToughness?: number;
	damagePreventionShield?: number;
	regenerationShields?: number;
	cantBeRegeneratedThisTurn?: boolean;
	/** CR 702.122c: instanceIds of creatures that crewed this Vehicle this turn. */
	crewedThisTurnByIds?: string[];
	/** CR 701.20 / 400.7: Player IDs to whom this hidden-zone card has been revealed; cleared on zone change. */
	knownToPlayerIds?: string[];
	/**
	 * CR 607.2a: source permanent instanceId + objectVersion that exiled this card
	 * (valid only while this card remains in exile; cleared on zone exit per CR 400.7).
	 */
	exiledBy?: { sourceInstanceId: string; sourceObjectVersion: number };
	/**
	 * CR 610.3: if set, this exiled card returns to `returnZone` (owner's control on battlefield)
	 * as a one-shot effect immediately after the source permanent leaves the battlefield.
	 */
	untilSourceLeavesReturn?: {
		sourceInstanceId: string;
		sourceObjectVersion: number;
		returnZone: ZoneType;
	};
	// --- Track P3 ---
	/** CR 702.143a / 116.2h: playerId who exiled this card face down via Foretell. */
	foretoldByPlayerId?: string;
	/** CR 702.143a / 116.2h: turnNumber on which this card was exiled face down via Foretell. */
	foretoldTurnNumber?: number;
	/** CR 702.143d / 400.7d: true when this permanent entered from a spell whose foretell cost was paid. */
	foretold?: boolean;
	/** CR 702.170a / 116.2k: playerId who exiled this card face up via Plot. */
	plottedByPlayerId?: string;
	/** CR 702.170a / 116.2k: turnNumber on which this card was plotted. */
	plottedTurnNumber?: number;
	/** CR 702.171b: true when this Mount permanent became saddled this turn. */
	saddledThisTurn?: boolean;
	/** CR 702.171b: instanceIds of creatures that saddled this Mount this turn. */
	saddledThisTurnByIds?: string[];
	/** CR 702.152a / 400.7d: true when this permanent entered from a spell whose blitz cost was paid. */
	blitzed?: boolean;
	// --- Track P4 ---
	/** CR 502.3 / 611.2b / 701.43a: skip untapping at controller's next untap step, then clear. */
	doesntUntapNextUntapStep?: boolean;
	/** CR 701.43: true when this permanent has been exerted this turn; cleared at cleanup / zone exit. */
	exertedThisTurn?: boolean;
	/** CR 614.1c / 614.12 / 205.3m: creature subtype chosen as this permanent entered; not copiable (CR 707.2). */
	chosenSubType?: string;
	/** CR 614.1c / 614.12 / 105.4: color chosen as this permanent entered; not copiable (CR 707.2). */
	chosenColor?: ManaColor;
	// --- Track P5 ---
	/** CR 701.37b: true once this permanent's monstrosity ability has resolved while on the battlefield. */
	isMonstrous?: boolean;
	/** CR 701.37c: the N (or X) value from when this permanent became monstrous. */
	monstrosityX?: number;
	// --- Track P6 ---
	/** Per-tag optional additional cost counts (e.g. `squad`, `offspring`, `kicker`) paid when cast (CR 400.7d). */
	kickedTagCounts?: Record<string, number>;
	/** CR 719.3b / 719.4: true while on the stack/battlefield after being cast prototyped. */
	prototyped?: boolean;
	/** CR 702.185a: owner playerId permitted to cast this card from exile after `warpedTurnSerial` ends. */
	warpedByOwnerId?: string;
	/** CR 702.185a: `state.turnSerial ?? state.turnNumber` of the turn this card was exiled by Warp's delayed trigger. */
	warpedTurnSerial?: number;
	// --- Track P7 ---
	/** CR 400.7d / 603.4: true when this permanent entered the battlefield by resolving from a cast spell. */
	wasCast?: boolean;
	/** Zone from which the spell that became this permanent was cast ("if you cast it from your hand"). */
	castFromZone?: ZoneType;
	// --- Track P9 ---
	/** CR 702.30a Echo: monotonic timestamp when this permanent entered or last changed controllers. */
	cameUnderControlAt?: number;
	/** CR 702.35a Madness: owner playerId when exiled from hand via Madness replacement; cleared on leaving exile. */
	madnessOwnerId?: string;
	/** CR 702.109a Dash: true while on the stack/battlefield after being cast for its dash cost. */
	dashed?: boolean;
	/** CR 702.136a Riot: true when a Riot ETB choice selected permanent haste on this permanent. */
	riotHaste?: boolean;
	/** CR 702.136b Riot: count of Riot ETB choices already completed as this permanent enters. */
	riotChoicesDone?: number;
	/** CR 702.98a Unleash: true once the Unleash ETB choice has been completed as this permanent enters. */
	unleashChoiceDone?: boolean;
	// --- Track P11 ---
	/** CR 614.1c / 614.12 / 201.2a: card name chosen as this permanent entered; not copiable (CR 707.2). */
	chosenCardName?: string;
	/** CR 614.1c / 614.12: true once an ETB counter-choice replacement on this permanent has completed. */
	etbCounterChoiceDone?: boolean;
	/** CR 613.7c: per-counter-type timestamp allocated when counters of that kind are placed on this permanent. */
	counterTimestamps?: Partial<Record<CounterType, number>>;
	// --- End Track P11 ---
}

export interface TargetRef {
	kind: 'permanent' | 'player' | 'stack' | 'graveyard_card' | 'card_in_graveyard' | 'exile_card';
	id: string; // instanceId, playerId, or stackItemId
	label: string;
}

export type TriggerScope = 'controller_turn' | 'each_turn' | 'opponent_turn';

export interface SpellModifications {
	targetsBecomeEach?: boolean;
	exileOnLeaveStack?: boolean;
	exileAdventureOnResolve?: boolean;
	entersWithCounters?: Record<string, number>;
	sacrificeAtEndStep?: boolean;
	castSummarySuffix?: string;
	label?: string;
	castFaceDown?: FaceDownSpec;
	/** CR 702.27a: Buyback — put this resolving spell into its owner's hand instead of graveyard as it resolves. */
	returnToHandOnResolve?: boolean;
	/** CR 702.74a: cast by paying its evoke cost. */
	evoked?: boolean;
	/** CR 702.138a–b: cast by paying its escape cost. */
	escaped?: boolean;
	// --- Track P3 ---
	/** CR 702.143d: cast by paying its foretell cost. */
	foretold?: boolean;
	/** CR 702.152a: cast by paying its blitz cost. */
	blitzed?: boolean;
	/** CR 702.146b / 712.8c: cast transformed with its back face up (Disturb). */
	castTransformed?: boolean;
	// --- Track P6 ---
	/** CR 719.3a–b: cast prototyped using its inset prototype mana cost, color, and P/T. */
	prototyped?: boolean;
	/** CR 702.185a: cast from hand by paying its warp cost. */
	warped?: boolean;
	// --- Track P9 ---
	/** CR 702.109a: cast by paying its dash alternative cost. */
	dashed?: boolean;
}

export interface CastOptionOptionalCost {
	id: string;
	label: string;
	costDisplay: string;
	costDefs: CostDef[];
	maxCount: number;
	kickedTag?: string;
	kickedTags?: string[];
	/** CR 702.33g: true when paying this optional cost activates a conditional target requirement. */
	enablesTarget?: boolean;
	/** CR 702.27a: true when paying this optional additional cost puts the resolving spell into its owner's hand. */
	returnToHandOnResolve?: boolean;
	// --- Track P3 ---
	/** CR 702.42a–b: true when paying this optional additional cost chooses all modes of a modal spell (Entwine). */
	chooseAllModes?: boolean;
}

export interface LandPlayOption {
	faceIndex: number;
	label: string;
	typeLine: string;
	// --- Track P8: widened fromZone for top-of-library & graveyard land play ---
	fromZone: 'hand' | 'exile' | 'library' | 'graveyard';
}

export interface CastCostAid {
	id: string;
	label: string;
	kind: 'tapPermanent' | 'exileCard';
	candidateIds: string[];
	/** Optional colored mana types payable per candidate (1 mana total per candidate); absent/empty means generic only. */
	colorsByCandidate?: Record<string, ManaColor[]>;
	paysGeneric: number;
	/** Max total generic mana reduction allowed by this aid. */
	maxGenericReduction?: number;
}

export interface CastOption {
	id: string;
	label: string;
	costDisplay: string;
	// --- Track P8: widened fromZone & permission for top-of-library spell casting ---
	fromZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library';
	// --- Track P11: added 'static_alt' for static alternative cast permissions ---
	permission: 'zone_default' | 'keyword_alt' | 'exile_permission' | 'library_top_permission' | 'static_alt';
	faceIndex?: number;
	fused?: boolean;
	baseCost:
		| { kind: 'printed' }
		| { kind: 'alternative'; manaCost?: string; costDefs?: CostDef[] }
		| { kind: 'free' };
	mandatoryAdditionalCosts?: CostDef[];
	optionalAdditionalCosts?: CastOptionOptionalCost[];
	paymentAids?: CastCostAid[];
	// --- Track P3: added 'sorcery_only' for Plot (CR 702.170d) ---
	timing: 'default' | 'instant_only' | 'sorcery_only';
	spellMods: SpellModifications;
	choosesX: boolean;
	requiresTarget: boolean;
}

// --- Track P3 ---
export interface HandSpecialActionOption {
	id: string;
	label: string;
	costDisplay: string;
	costDefs: CostDef[];
	sorcerySpeedOnly: boolean;
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
	castOptionId?: string;
	spellMods?: SpellModifications;
	optionalCostCounts?: Record<string, number>;
	commanderCastCount?: number;
	requiresGuidedResolution: boolean;
	createdAt: number;
	isCopy?: boolean;
	/** Layer 1a copy state/exceptions on copied spells (e.g. "except the copy isn't legendary"). */
	copiableState?: CopiableState;
	/** CR 707.10, 702.40a: plain-JSON snapshot of the triggering spell StackItem on 'cast' triggers so copies still work if the original left the stack. */
	triggerEventStackItem?: StackItem;
	/** CR 702.40a: number of other spells cast before this spell this turn, snapshotted when the cast trigger fired. */
	stormCount?: number;
	sourceObjectVersion?: number;
	/** CR 601.2h / CR 105: distinct colors of mana spent to cast this spell. */
	manaColorsSpent?: ManaColor[];
	lkiPower?: number;
	lkiToughness?: number;
	lkiTypeLine?: string;
	lkiControllerId?: string;
	sourceLkiPower?: number;
	sourceLkiToughness?: number;
	declineWard?: boolean;
	wardCost?: string;
	/**
	 * Phase 5: for a triggered ability put on the stack by runtime/triggers.ts, the index of the
	 * ability in its source card's compiled abilities (compileCard(card).faces[0].abilities). Used to
	 * re-check the intervening-if condition on resolution (CR 603.4) without storing IR in state.
	 */
	triggeredAbilityIndex?: number;
	/** Canonical granted keyword name when this stack trigger came from a Layer 6 keyword grant. */
	grantedKeyword?: string;
	/** Step F: id of an activated ability on its source card (`act_0`, `loyalty_1`, `equip_2`, or `granted:...`). */
	abilityId?: string;
	/**
	 * Track A1: for a granted activated ability, the granting permanent's `ScryfallCard` so
	 * `compiledStackItemEffects` can recompile its `grantAbility` static on resolution without
	 * storing IR in `GameState` (even if the granter leaves the battlefield, CR 113.7a).
	 */
	grantSourceCard?: ScryfallCard;
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
	/** The defending player for an attack trigger (CR 702.86a). */
	defendingPlayerId?: string;
	eventAmount?: number;
	/** The spell or ability that targeted the source (Ward). */
	eventStackItemId?: string;
	eventLki?: TriggerEventLki;
	/** "You may" triggered abilities: the controller's answer, once asked on resolution. */
	optionalAccepted?: boolean;
	/** Triggered abilities: targets grouped by TargetSpec index so prompted and forced specs flatten in spec order. */
	targetsBySpec?: TargetRef[][];
	/** LKI kicked tracking on triggered abilities whose source left the battlefield before resolution (CR 603.4). */
	sourceKickedCount?: number;
	sourceKickedTags?: string[];
	/** LKI evoked/escaped tracking on triggered abilities whose source left the battlefield before resolution (CR 603.4). */
	sourceEvoked?: boolean;
	sourceEscaped?: boolean;
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
	/**
	 * CR 707.5: for a resolving Clone-style permanent spell ("You may have ~ enter as a copy of any
	 * creature on the battlefield"), the human controller's chosen creature instanceId (or `null` if
	 * they chose 0 objects to enter as itself).
	 */
	cloneCopyChoice?: string | null;
	faceIndex?: number;
	fused?: boolean;
	isFaceDown?: boolean;
	faceDownSpec?: FaceDownSpec;
	faceDownLabel?: string;
	/** InstanceIds of creatures tapped to pay a subset-sum cost (e.g. Crew) for this ability. */
	crewedByIds?: string[];
	// --- Track P1 ---
	isChapterAbility?: boolean;
	inherentTrigger?:
		| { kind: 'monarchEndStepDraw'; drawPlayerId: string }
		| { kind: 'monarchCombatDamage'; newMonarchPlayerId: string };
	// --- Track P3 ---
	/** LKI foretold tracking on triggered abilities whose source left the battlefield before resolution (CR 603.4). */
	sourceForetold?: boolean;
	/** LKI blitzed tracking on triggered abilities whose source left the battlefield before resolution (CR 603.4). */
	sourceBlitzed?: boolean;
	/** InstanceIds of creatures tapped to pay a Saddle cost for this ability (CR 702.171a). */
	saddledByIds?: string[];
	// --- Track P4 ---
	/** LKI exertedThisTurn tracking on triggered abilities whose source left the battlefield before resolution (CR 603.4). */
	sourceExertedThisTurn?: boolean;
	/** LKI chosen creature subtype / color when the source left the battlefield before resolution (CR 608.2h). */
	sourceChosenSubType?: string;
	sourceChosenColor?: ManaColor;
	// --- Track P5 ---
	/** LKI monstrous tracking on triggered abilities whose source left the battlefield before resolution (CR 603.4). */
	sourceMonstrous?: boolean;
	// --- Track P6 ---
	/** Per-tag optional additional cost counts carried onto triggered abilities (e.g. Squad, Replicate). */
	sourceKickedTagCounts?: Record<string, number>;
	/** LKI prototyped tracking on triggered abilities whose source left the battlefield before resolution (CR 707.11, CR 719.3d). */
	sourcePrototyped?: boolean;
	/** CR 702.184a: evaluated power (and tapped creature locator for CR 608.2h resolution check) of the creature tapped to pay a Station cost. */
	tappedCostPower?: number;
	stationTappedId?: string;
	stationTappedVersion?: number;
	// --- Track P7 & P9 ---
	/** CR 601.2d / 608.2b: locked-in damage or counter division per target ID (`>= 1` each). */
	targetDivisions?: Record<string, number>;
	/** Zone from which this spell was cast (`'hand'`, `'graveyard'`, `'exile'`, `'command'`). */
	castFromZone?: ZoneType;
	/** LKI `wasCast` / `castFromZone` carried onto ETB triggered abilities (CR 603.4). */
	sourceWasCast?: boolean;
	sourceCastFromZone?: ZoneType;
	/** CR 702.49c / 508.4 Ninjutsu: defender player / planeswalker the returned unblocked attacker was attacking. */
	ninjutsuAttackTarget?: { defenderPlayerId: string; defenderPlaneswalkerId?: string | null };
	/** Plain-JSON continuation frame for Wave 3 keyword resolution prompts (Madness, Cascade, Rebound, Fabricate, Extort). */
	wave3Resume?: {
		step: string;
		cardId?: string;
		cardVersion?: number;
		exiledIds?: string[];
		chosenFaceIndex?: number;
		xValue?: number;
		chosenModes?: number[];
		chosenTargetIds?: string[];
		targetKinds?: string[];
		costOptions?: number[];
		costObjects?: string[][];
		extortColor?: ManaColor;
	};
	// --- Track P11 ---
	/** CR 113.7a, 613.1f: face index and ability index on `grantSourceCard` for a Layer 6 granted triggered ability. */
	grantFaceIndex?: number;
	grantAbilityIndex?: number;
	/** LKI chosenCardName carried onto triggered abilities. */
	sourceChosenCardName?: string;
	// --- End Track P11 ---
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
	subStepIndex?: number;
	phase?: 'optional' | 'step' | 'afterStep';
	bindings: Array<[string, EffectBindingSnapshot[]]>;
	exileSelf?: boolean;
	// --- Track P4 ---
	/** CR 608.2m / 401.2 / 401.7: resolving spell puts itself into its owner's library instead of graveyard. */
	librarySelf?: { position: 'top' | 'bottom'; fromTop?: number };
	answers: Record<string, ChoiceAnswer>;
	stepDecisions?: Record<number, boolean>;
	pendingOptionalCost?: {
		stepIndex: number;
		parts: SerializedPlannedCost[];
		nextPartIndex: number;
		nextObjectIndex: number;
		descriptions: string[];
		tapsAndManaDone: boolean;
	};
}

/** Last known information of a trigger's event object (plain data, JSON-serialisable). */
export interface TriggerEventLki {
	controllerId: string;
	ownerId: string;
	power: number;
	toughness: number;
	manaValue: number;
	// --- Track P9 ---
	/** CR 704.8: pre-SBA counter counts on the object as it last existed on the battlefield. */
	counters?: Partial<Record<CounterType, number>>;
}

export interface SerializedPendingTrigger {
	ability: RuntimeTrigger;
	source: CardInstance;
	sourceCard: ScryfallCard;
	faceIndex?: number;
	controllerId: string;
	mode: 'stack' | 'inline';
	label: string;
	eventObject?: CardInstance;
	eventPlayerId?: string;
	eventPlayer?: string;
	defendingPlayerId?: string;
	targetStackItemId?: string;
	amount?: number;
	eventLki?: {
		controllerId: string;
		power?: number;
		toughness?: number;
		// --- Track P9 ---
		counters?: Partial<Record<CounterType, number>>;
	};
	triggerEventStackItem?: StackItem;
	stormCount?: number;
	// --- Track P3 ---
	sourceForetold?: boolean;
	sourceBlitzed?: boolean;
	// --- Track P4 ---
	sourceExertedThisTurn?: boolean;
	sourceChosenSubType?: string;
	sourceChosenColor?: ManaColor;
	// --- Track P5 ---
	sourceMonstrous?: boolean;
	isBecameMonstrous?: boolean;
	// --- Track P7 ---
	sourceWasCast?: boolean;
	sourceCastFromZone?: ZoneType;
	// --- End Track P7 ---
	order: number;
	// --- Track P1 ---
	isChapterAbility?: boolean;
	// --- Track P11 ---
	grantSourceCard?: ScryfallCard;
	grantFaceIndex?: number;
	grantAbilityIndex?: number;
	sourceChosenCardName?: string;
	// --- End Track P11 ---
}

/** Snapshot of an IR effect binding carried into a delayed trigger (CR 603.7c). */
export interface SerializedBoundRef {
	key: string;
	id: string;
	expectedZone: ZoneType;
	objectVersion: number;
	lki: TriggerEventLki;
}

/**
 * Plain-JSON locator for a general delayed trigger (CR 603.7).
 * Never stores `EffectStep[]` in `GameState`; steps are dynamically recompiled on resolution.
 */
export interface CompiledDelayedEffect {
	kind: 'compiledDelayed';
	sourceCard: ScryfallCard;
	faceIndex?: number;
	fused?: boolean;
	abilityKind: 'spell' | 'activated' | 'triggered';
	abilityId?: string;
	abilityIndex?: number;
	grantSourceCard?: ScryfallCard;
	// --- Track P11 ---
	grantFaceIndex?: number;
	grantAbilityIndex?: number;
	// --- End Track P11 ---
	grantedKeyword?: string;
	chosenModes?: number[];
	/** Index path to the `delayedTrigger` step from the originating compiled effect's root steps. */
	stepPath: number[];
	/** Bound objects ("it", "that creature", created tokens, etc.) captured at creation time. */
	boundRefs: SerializedBoundRef[];
	/** Targets of the originating spell/ability (for `k: 'target'` references inside the delayed effect). */
	targets: TargetRef[];
	/** Expected objectVersion per target id at creation time (CR 603.7c). */
	targetObjectVersions?: Record<string, number>;
	eventObjectId?: string;
	eventObjectVersion?: number;
	eventPlayerId?: string;
	defendingPlayerId?: string;
	eventLki?: TriggerEventLki;
	xValue?: number;
	kickedCount?: number;
	kickedTags?: string[];
	// --- Track P6 ---
	kickedTagCounts?: Record<string, number>;
}

export type DelayedTriggerEffect =
	| { kind: 'exile'; targetInstanceId: string; targetObjectVersion?: number }
	| { kind: 'lose' }
	| { kind: 'draw'; playerId: string; amount: number; upTo?: boolean }
	| { kind: 'scry'; amount: number }
	| CompiledDelayedEffect
	// --- Track P3 ---
	| { kind: 'sacrifice'; targetInstanceId: string; targetObjectVersion?: number }
	// --- Track P6 ---
	| { kind: 'warpExile'; targetInstanceId: string; targetObjectVersion?: number }
	// --- Track P9 ---
	| { kind: 'dashBounce'; targetInstanceId: string; targetObjectVersion?: number }
	| { kind: 'reboundCast'; targetInstanceId: string; targetObjectVersion?: number };

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
	awaitingAttackersDeclaration?: boolean;
}

/**
 * Saved-game compatibility version; games saved with a different value are ended on load
 * (enforceEngineVersion). 2: default stopPhases became [] (Tier 3 item 7), plus
 * CombatState.awaitingAttackersDeclaration and GameState.pendingZoneMoves.
 */
export const ENGINE_VERSION = 2;

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
			defaultObjectIds?: string[];
			/** When set, selected objects must have sum of weightsById[id] >= minWeightSum. */
			minWeightSum?: number;
			weightsById?: Record<string, number>;
			weightLabel?: string;
	  }
	| {
			kind: 'chooseMode';
			modes: string[];
			min: number;
			max: number;
			defaultIndices?: number[];
			allowRepeat?: boolean;
			disabledIndices?: number[];
	  }
	| { kind: 'chooseNumber'; min: number; max: number; reason: string; defaultNumber?: number }
	| {
			kind: 'orderObjects';
			objectIds: string[];
			allowSplitBottom?: boolean;
			allowShuffle?: boolean;
			splitLabel?: 'bottom' | 'graveyard';
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
	/** Steps C+D / CR 700.2b: choosing a modal triggered ability's modes as it's put on the stack. */
	| 'trigger_modes'
	/** Steps C+D: choosing a triggered ability's targets as it's put on the stack (CR 603.3d). */
	| 'trigger_targets'
	/** Steps C+D: ordering a player's simultaneous triggered abilities (CR 603.3b). */
	| 'trigger_order'
	/** Steps C+D: "you may" in a resolving triggered ability. */
	| 'trigger_may'
	/** Track P4: choosing a color or creature type as a permanent enters (CR 614.1c, 614.12). */
	| 'etb_choice'
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
	splitMode?: 'bottom' | 'graveyard';
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
	costQuestion?: { kind: 'option' | 'objects' | 'phyrexian' | 'hybrid'; index: number };
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
/**
 * Track B1 Slice 3: plain-JSON continuation for an in-progress rules procedure paused on a
 * player choice or nested replacement/commander prompt.
 */
export type ProcedureContinuation =
	| {
			kind: 'legend_rule';
			actorId: string;
			keepInstanceId: string;
			remainingInstanceIds: string[];
			nextIndex: number;
	  }
	| {
			kind: 'discard_to_hand_size';
			actorId: string;
			chosenIds: string[];
			nextIndex: number;
			discardCount: number;
	  }
	| {
			kind: 'combat_damage_step';
			phase: 'after_damage';
			isFirstStrikeStep: boolean;
	  }
	| {
			kind: 'combat_damage_assignment';
			isFirstStrikeStep: boolean;
			chosenDamage: Record<string, number>;
			key: string;
	  }
	| {
			kind: 'zone_replacement_choice';
			objectId: string;
			resumeStackItemId?: string;
			resumeStepIndex?: number;
	  }
	| {
			kind: 'counter_replacement_choice';
			permId: string;
			resumeStackItemId?: string;
			resumeStepIndex?: number;
	  }
	| {
			kind: 'clone_copy_choice';
			stackItemId: string;
	  }
	| {
			kind: 'aura_library_attach_choice';
			auraId: string;
			libraryOwnerId: string;
			enterTapped: boolean;
			resumeStackItemId?: string;
			resumeStepIndex?: number;
	  }
	| {
			kind: 'ward_payment_choice';
			wardStackItemId: string;
			targetStackItemId: string;
	  }
	| {
			kind: 'commander_zone_choice';
			commanderInstanceId: string;
			destinationZone: ZoneType;
			resumeStackItemId?: string;
			resumeStepIndex?: number;
	  }
	| {
			kind: 'end_turn';
			actorId: string;
			sourceName: string;
			resumeStackItemId?: string;
			resumeStepIndex?: number;
	  }
	| {
			kind: 'surveil_graveyard';
			actorId: string;
			remainingIds: string[];
			nextIndex: number;
			surveilCount: number;
			topCount: number;
			graveyardCount: number;
			resumeStackItemId?: string;
			resumeStepIndex?: number;
	  };

export type PromptContinuation =
	| { kind: 'effect_choice'; stackItemId: string; stepIndex: number; answerKey?: string }
	| { kind: 'effect_resume'; stackItemId: string; stepIndex: number }
	| { kind: 'manual_resolution'; stackItemId: string }
	| { kind: 'manual_ability'; sourceInstanceId: string }
	| { kind: 'procedure'; procedure: ProcedureContinuation }
	| {
			kind: 'handler';
			name: string;
			data?: Record<string, string | number | boolean | null | string[] | Record<string, number>>;
	  };

/**
 * The player's choices for paying a cost (CR 601.2b/h, 602.2b), validated by the server. Indices
 * follow the order of the costs: `options[i]` answers the i-th choice between costs (an optional
 * cost is the choice [pay, don't pay]); `objects[j]` lists the objects chosen for the j-th cost that
 * needs objects (sacrifice, discard, tap untapped ..., exile from a zone), counted after choices.
 */
export interface CostPayment {
	options?: number[];
	objects?: string[][];
	phyrexianLifeCount?: number;
	hybridChoices?: number[];
	// --- Track P11 ---
	/** Per-Phyrexian-symbol payment choice ('life' | 'primary' | 'alt') for mixed/hybrid Phyrexian costs. */
	phyrexianChoices?: Array<'life' | 'primary' | 'alt'>;
	// --- End Track P11 ---
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
	/** Pooled mana with spending restrictions (CR 106.6), keyed by restriction tag. */
	restrictedMana?: Partial<Record<ManaRestriction, ManaPool>>;
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
	cardsDrawnThisTurn?: number;
	cannotLoseGameThisTurn?: boolean;
	lifeTotalCannotChangeThisTurn?: boolean;
	protectionFromEverythingThisTurn?: boolean;
	damagePreventionShield?: number;
	preventAllCombatDamageThisTurn?: boolean;
	attemptedEmptyLibraryDraw?: boolean;
	commanderColorIdentity?: ManaColor[];
	/** CR 106.6 / 603.7: Delayed riders attached to mana in the pool (e.g. Path of Ancestry). */
	manaRiders?: ManaRider[];
	// --- Track P7 ---
	/** Raid (CR 508.1k / 508.4): true iff this player declared >= 1 attacker during declare attackers this turn. */
	attackedThisTurn?: boolean;
	/** Revolt: true iff a permanent controlled by this player left the battlefield this turn. */
	permanentLeftBattlefieldThisTurn?: boolean;
	/** Total life gained by this player so far this turn. */
	lifeGainedThisTurn?: number;
	// --- Track P9 ---
	/** CR 702.30a Echo: monotonic timestamp of the beginning of this player's previous upkeep step. */
	previousUpkeepBeganAt?: number;
	/** CR 702.30a Echo: monotonic timestamp of the beginning of this player's most recent upkeep step. */
	currentUpkeepBeganAt?: number;
	/** CR 702.54a–b Bloodthirst: total damage dealt to this player so far this turn (reset at turn start). */
	damageDealtToThisTurn?: number;
	// --- Track P11 ---
	/** CR 107.4h: count of mana in `manaPool` per color produced by a Snow source. */
	snowManaByColor?: Partial<Record<ManaColor, number>>;
	/** CR 502.3: instanceIds already prompted/decided for 'You may choose not to untap ~' during this untap step. */
	untapChoiceEvaluatedIds?: string[];
	// --- End Track P11 ---
}

export interface ManaRider {
	id?: string;
	color?: ManaColor;
	sourceInstanceId?: string;
	sourceCard?: ScryfallCard;
	condition?: { sharesCreatureTypeWithCommander: true };
	scryAmount?: number;
}

export interface TriggerLoopEntry {
	cycles: number;
	lastResolutionSerial: number;
	lastExactFp: string;
	lastNormFp: string;
	cycled: boolean;
	limit?: number;
}

/**
 * CR 611.2c / 613.1f / 613.7b / 113.11: Until-end-of-turn Layer 6 keyword grant or removal created
 * by a resolving spell or ability, locking in the affected `(instanceId, objectVersion)` set on
 * resolution with a monotonic timestamp.
 */
export interface TimedKeywordEffect {
	timestamp: number;
	sourceName: string;
	controllerId: string;
	affected: Array<{ instanceId: string; objectVersion?: number }>;
	addKeywords?: string[];
	removeKeywords?: string[];
	cantHaveOrGain?: boolean;
}

/**
 * Generalized Layer 4 / Layer 6 / Layer 7b continuous effect ("until end of turn") stored as plain
 * JSON on GameState. Evaluated in timestamp order alongside other continuous effects in runtime/layers.ts.
 */
export interface TimedContinuousEffect {
	timestamp: number;
	sourceName: string;
	controllerId: string;
	affected: Array<{ instanceId: string; objectVersion?: number }>;
	/** Omitted defaults to `'endOfTurn'` for backward compatibility with Crew etc. */
	expires?: 'endOfTurn' | 'never' | 'untilSourceLeaves';
	layer2?: {
		controllerId: string;
		/** When set, this Layer 2 effect expires as soon as the source permanent is no longer on the battlefield with matching objectVersion. */
		untilSourceLeaves?: { sourceInstanceId: string; sourceObjectVersion: number };
	};
	layer4?: {
		addTypes?: string[];
		setTypes?: string[];
		addSubtypes?: string[];
		setSubtypes?: string[];
	};
	layer5?: {
		setColors?: ManaColor[];
		addColors?: ManaColor[];
	};
	layer6?: {
		addKeywords?: string[];
		removeKeywords?: string[];
		cantHaveOrGain?: boolean;
	};
	layer7b?: {
		setPower: number;
		setToughness: number;
	};
	// --- Track P7 ---
	/** CR 707.2 / 613.1a: Layer 1a copiable-value override ("becomes a copy of ... until end of turn"). */
	layer1a?: CopiableState;
	// --- End Track P7 ---
}

/**
 * Serialized step in an in-progress `PendingCostPayment` (Track B1 Slice 2).
 * Random discards are resolved up front into concrete `objectIds` before execution starts so
 * pausing mid-cost never re-rolls randomness.
 */
export interface SerializedPlannedCost {
	def: CostDef;
	objectIds?: string[];
	objectNames?: string[];
	isRandom?: boolean;
	millTotal?: number;
	isCostAid?: boolean;
}

/**
 * CR 601.2 / 602.2 (Track B1 Slice 2): Plain-JSON frame holding an interrupted cost payment
 * (for example when sacrificing, discarding, exiling, or milling a cost triggers a
 * `zone_replacement_choice` prompt mid-payment).
 */
export interface PendingCostPayment {
	// --- Track P3: added 'hand_special_action' ---
	kind: 'cast_spell' | 'activate_ability' | 'tap_mana' | 'turn_face_up' | 'hand_special_action';
	actorId: string;
	sourceInstanceId: string;
	// --- Track P3 ---
	specialActionId?: string;
	sourcePlayerId?: string;
	// --- Track P8: widened sourceZone for top-of-library casting ---
	sourceZone?: 'hand' | 'command' | 'exile' | 'graveyard' | 'library';
	targets?: TargetRef[];
	targetsBySpec?: TargetRef[][];
	// --- Track P7 ---
	targetDivisions?: Record<string, number>;
	// --- End Track P7 ---
	chosenModes?: number[];
	xValue?: number;
	castOptionId?: string;
	faceIndex?: number;
	fused?: boolean;
	spellMods?: SpellModifications;
	optionalCostCounts?: Record<string, number>;
	manaColorsSpent?: ManaColor[];
	exSourceName?: string;
	sourceCard?: ScryfallCard;
	additionalIncomplete?: boolean;
	abilityId?: string;
	costKeyword?: string;
	sourceObjectVersion?: number;
	sourceLkiPower?: number;
	sourceLkiToughness?: number;
	sourceEvoked?: boolean;
	sourceEscaped?: boolean;
	// --- Track P3 ---
	sourceForetold?: boolean;
	sourceBlitzed?: boolean;
	// --- Track P6 ---
	tappedCostPower?: number;
	stationTappedId?: string;
	stationTappedVersion?: number;
	// --- Track P9 ---
	ninjutsuAttackTarget?: { defenderPlayerId: string; defenderPlaneswalkerId?: string | null };
	onceEachTurn?: boolean;
	effectText?: string;
	abilityCostIncomplete?: boolean;
	grantSourceCard?: ScryfallCard;
	chosenColor?: ManaColor;
	// --- Track P4 ---
	chosenBundle?: ManaColor[];
	freezesSelfUntap?: boolean;
	sourceExertedThisTurn?: boolean;
	sourceChosenSubType?: string;
	sourceChosenColor?: ManaColor;
	amount?: number;
	manaRestriction?: ManaRestriction;
	sacrificeSelfInCost?: boolean;
	parts: SerializedPlannedCost[];
	manaPaid?: ManaCostRequirement | null;
	tapsAndManaDone: boolean;
	nextPartIndex: number;
	nextObjectIndex: number;
	descriptions: string[];
	aidDescriptions?: string[];
}

// --- Track P7 ---
export interface DamagePreventionShieldEntry {
	id: string;
	controllerId: string;
	sourceName: string;
	targetKind: 'any' | 'permanent' | 'player' | 'permanentsControlledBy' | 'playerAndPermanentsControlledBy';
	targetId?: string;
	targetObjectVersion?: number;
	targetTypes?: string[];
	fromSourceInstanceId?: string;
	fromSourceObjectVersion?: number;
	fromSourceTypes?: string[];
	fromAttackingOnly?: boolean;
	alsoPreventDealtByTarget?: boolean;
	combatOnly: boolean;
	remaining: number | 'infinite';
}

export interface TimedCombatRestrictionEntry {
	instanceId: string;
	objectVersion: number;
	kind: 'cantBlock' | 'cantBeBlocked';
	exceptBy?: {
		types?: string[];
		subtypes?: string[];
		colors?: ManaColor[];
		notColors?: ManaColor[];
		artifactOrColors?: ManaColor[];
		keywords?: string[];
		minBlockers?: number;
		maxPower?: number;
	};
}
// --- End Track P7 ---

export interface GameState {
	engineVersion: number;
	gameId: string;
	lobbyCode: string;
	status: 'mulligan' | 'active' | 'finished';
	winnerPlayerId: string | null;
	winnerId?: string;
	rules: LobbyRulesConfig;
	turnNumber: number;
	turnSerial?: number;
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
	timedKeywordEffects?: TimedKeywordEffect[];
	timedContinuousEffects?: TimedContinuousEffect[];
	delayedTriggers?: DelayedTrigger[];
	/**
	 * Steps C+D + Phase 4 (CR 104.4b, CR 731): how many triggered abilities were put on the stack
	 * this turn and per-(sourceInstanceId, abilityIndex) loop-detection state across trigger
	 * resolution cycles since the last voluntary player action.
	 */
	triggersPlacedThisTurn?: {
		turn: number;
		count: number;
		resolutionSerial?: number;
		byAbility?: Record<string, TriggerLoopEntry>;
	};
	extraTurnQueue?: string[];
	/**
	 * CR 500.7: Seat index of the player whose normal turn most recently ran before a chain of one or
	 * more extra turns began, so normal turn order resumes from the next seat after extra turns finish.
	 */
	lastNormalTurnPlayerIndex?: number;
	playersDrawnThisTurn?: string[];
	/** CR 603.2i: Keys (`${instanceId}:${objectVersion}:${abilityTag}`) of once-per-turn triggers that have triggered this turn. */
	triggeredOnceThisTurn?: string[];
	/**
	 * CR 616.1: Holding list for objects whose zone change is currently paused awaiting a human's
	 * `chooseReplacement` choice, so the object does not exist in any destination zone before the
	 * replacement order is chosen.
	 */
	pendingZoneMoves?: CardInstance[];
	/**
	 * CR 603.3: Pending triggers deferred while a stack item is mid-resolution (paused for a prompt)
	 * so they are never placed onto the stack above the still-resolving item; flushed once it leaves.
	 */
	pendingTriggers?: SerializedPendingTrigger[];
	/**
	 * CR 601.2 / 602.2: Interrupted cost payment paused mid-execution awaiting a replacement choice.
	 */
	pendingCostPayment?: PendingCostPayment;
	/**
	 * Track B1 Slice 3: Interrupted rules procedure (`legend_rule`, `discard_to_hand_size`,
	 * `combat_damage_step`) paused mid-execution awaiting a nested replacement or commander choice.
	 */
	pendingProcedure?: ProcedureContinuation;
	stackTriggersEnabled?: boolean;
	rngState?: number;
	nextUid?: number;
	idSalt?: number;
	faceDownLabelAllocCounter?: number;
	// --- Track P1 ---
	monarchPlayerId?: string | null;
	/** CR 500.8: number of additional combat phases to begin after the current combat phase ends. */
	additionalCombatPhases?: number;
	// --- Track P7 ---
	damagePreventionShields?: DamagePreventionShieldEntry[];
	damageCantBePreventedThisTurn?: boolean;
	combatDamageCantBePreventedThisTurn?: boolean;
	exileInsteadOfDyingThisTurn?: Array<{ instanceId: string; objectVersion: number }>;
	timedCombatRestrictions?: TimedCombatRestrictionEntry[];
	creatureDiedThisTurn?: boolean;
	// --- Track P9 ---
	/** CR 702.30a Echo: monotonic clock for upkeep & control-gain ordering (independent of CR 613 `nextTimestamp`). */
	echoClock?: number;
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
	botResumeAt?: number | null;
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
	// --- Track P8: widened play_land & cast_spell fromZone ---
	| {
			type: 'play_land';
			instanceId: string;
			fromZone?: 'hand' | 'exile' | 'library' | 'graveyard';
			faceIndex?: number;
	  }
	| {
			type: 'tap_mana';
			instanceId: string;
			abilityId?: string;
			preferredColor?: ManaColor;
			chosenBundle?: ManaColor[];
			costPayment?: CostPayment;
	  }
	| {
			type: 'cast_spell';
			instanceId: string;
			targets?: TargetRef[];
			// --- Track P7 ---
			targetDivisions?: Record<string, number>;
			// --- End Track P7 ---
			modes?: number[];
			xValue?: number;
			optionId?: string;
			faceIndex?: number;
			fused?: boolean;
			optionalCostCounts?: Record<string, number>;
			costAidIds?: Record<string, string[]>;
			costAidColorChoices?: Record<string, ManaColor | 'generic'>;
			fromZone?: 'hand' | 'command' | 'graveyard' | 'exile' | 'library';
			costPayment?: CostPayment;
	  }
	| {
			type: 'unlock_room_door';
			instanceId: string;
			faceIndex: number;
			costPayment?: CostPayment;
	  }
	| {
			type: 'turn_face_up';
			instanceId: string;
			xValue?: number;
			costPayment?: CostPayment;
	  }
	| {
			type: 'activate_ability';
			instanceId: string;
			abilityId: string;
			targets?: TargetRef[];
			// --- Track P7 ---
			targetDivisions?: Record<string, number>;
			// --- End Track P7 ---
			chosenModes?: number[];
			xValue?: number;
			costPayment?: CostPayment;
	  }
	/** Compatibility alias for answering a `cost_choice` prompt. */
	| { type: 'cost_choice'; promptId: string; option?: number; instanceIds?: string[]; cancel?: boolean }
	| { type: 'suspend_card'; instanceId: string }
	// --- Track P3 ---
	| {
			type: 'hand_special_action';
			instanceId: string;
			actionId: string;
			costPayment?: CostPayment;
	  }
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
