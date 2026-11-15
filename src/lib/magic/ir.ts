/**
 * Card IR (ENGINE_ARCHITECTURE_PLAN.md section 2.1).
 *
 * A card is compiled once from its rules text into a CardDefinition. The runtime interprets this
 * structure and never reads card names or rules text. The IR is derived data: it is never stored in
 * GameState, only cached by the compiler.
 *
 * Changes to this file must be additive while parallel phases are running (plan section 4).
 */
import type {
	CardLayout,
	CounterType,
	GamePhase,
	ManaColor,
	// --- Track P10 ---
	ManaSpendingRestrictionSpec,
	// --- End Track P10 ---
	TriggerScope,
	ZoneType
} from './types.ts';

/** Offsets into the face's normalised text (reminder text stripped, self-references as `~`). */
export interface Span {
	start: number;
	end: number;
}

export interface CardDefinition {
	oracleId: string;
	compilerVersion: number;
	/** Hash of the source text the definition was compiled from (part of the cache key). */
	textHash: string;
	/** For display and diagnostics only. The runtime never branches on it. */
	name: string;
	layout?: CardLayout;
	faces: FaceDefinition[];
	/** True iff no face has an `unsupported` ability. */
	fullySupported: boolean;
}

// --- Track P6 ---
export interface PrototypeSpec {
	manaCost: string;
	power: number;
	toughness: number;
	colors: ManaColor[];
}

// --- Track P7 & P8 ---
export interface CopyModificationSpec {
	name?: string;
	keepSelfName?: boolean;
	overrideName?: string;
	power?: number;
	toughness?: number;
	setColors?: ManaColor[];
	addColors?: ManaColor[];
	addTypes?: string[];
	setTypes?: string[];
	addSubtypes?: string[];
	setSubtypes?: string[];
	removeSupertypes?: string[];
	addKeywords?: string[];
	noManaCost?: boolean;
	// --- Track P20a ---
	/** CR 707.9a: Quoted ability rules-text lines added to the copy's copiable values ("..., except it has '<ability>'"). */
	addedAbilityTexts?: string[];
	/** CR 707.9a: Supertypes added to the copy's copiable values ("..., except it's legendary in addition to its other types"). */
	addSupertypes?: string[];
	// --- End Track P20a ---
}

export interface DamagePreventionSpec {
	/** 'all': Prevent all [combat] damage this turn; 'next': Prevent the next `amount` [combat] damage this turn. */
	mode: 'all' | 'next';
	combatOnly: boolean;
	/** Protected target scope ('any' for global Fog, 'subject' for explicit subject, or 'youAndCreaturesYouControl'). */
	scope: 'any' | 'subject' | 'youAndCreaturesYouControl';
	/** Optional source restriction ("by target/chosen source", "by creatures", "by attacking creatures", etc.). */
	fromSource?: Selector;
	/** Also prevent damage dealt BY `subject` ("dealt to and dealt by ~ this turn", CR 615). */
	alsoPreventDealtBySubject?: boolean;
}

export interface TimedCombatRestrictionSpec {
	kind: 'cantBlock' | 'cantBeBlocked';
	/** Optional blocker exception for `cantBeBlocked` ("except by walls", "except by two or more creatures", etc.). */
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

export interface FaceDefinition {
	name: string;
	characteristics: Characteristics;
	abilities: AbilityDef[];
	// --- Track P1 ---
	hasReadAhead?: boolean;
	// --- Track P6 ---
	/** CR 719.2: inset prototype mana cost, derived colors, and power/toughness. */
	prototypeSpec?: PrototypeSpec;
	// --- Track P15 ---
	/** CR 702.148: compiled spell ability with bracketed `[...]` text removed when cast for its cleave cost. */
	cleavedSpellSpec?: SpellAbility;
	/** CR 702.174: compiled spell ability used when a Gift was promised on cast. */
	giftPromisedSpellSpec?: SpellAbility;
	// --- End Track P15 ---
}

export interface Characteristics {
	manaCost: string;
	types: string[];
	subtypes: string[];
	supertypes: string[];
	colors: ManaColor[];
	colorIndicator?: ManaColor[];
	/** Absent when the card has none or its value is defined by an ability (`*`). */
	power?: number;
	toughness?: number;
	loyalty?: number;
	// --- Track P15 ---
	/** CR 310.4: printed defense value on a Battle card face. */
	defense?: number;
	// --- End Track P15 ---
	/** CR 604.3: power and/or toughness come from a characteristic-defining ability. */
	ptDefinedByAbility?: boolean;
}

// ---- Abilities ------------------------------------------------------------------------------

/**
 * `spell` is the effect of an instant or sorcery resolving (CR 113.3a). It lives in `abilities`
 * rather than a separate `spell` field so that coverage and support are computed uniformly.
 */
export type AbilityDef =
	| KeywordAbility
	| SpellAbility
	| ActivatedAbility
	| TriggeredAbility
	| StaticAbility
	| ReplacementAbility
	| UnsupportedAbility;

export interface KeywordAbility {
	kind: 'keyword';
	keyword: KeywordDef;
	/** Equip (an activated ability, CR 702.6a): the id the runtime activates it by (`equip_<line>`). */
	id?: string;
	span: Span;
}

// --- Track P18b ---
export type SpellCastRestrictionKind =
	| 'duringCombat'
	| 'duringYourTurn'
	| 'beforeAttackers'
	| 'afterAttackers'
	| 'duringBlockers'
	| 'beforeBlockers'
	| 'afterBlockers'
	| 'duringOpponentsTurn'
	| 'duringYourUpkeep'
	| 'afterCombat';
// --- End Track P18b ---

export interface SpellAbility {
	kind: 'spell';
	additionalCosts: CostDef[];
	targets: TargetSpec[];
	effect: EffectStep[];
	modal?: ModalDef;
	/** CR 601.3: "Cast ~ only during combat." and similar timing restrictions. */
	// --- Track P18b ---
	castRestrictions?: SpellCastRestrictionKind[];
	/** CR 601.3: "Cast ~ only if <condition>." */
	castCondition?: Condition;
	/** CR 107.3a: "X can't be 0." on an X-cost spell. */
	xCantBeZero?: boolean;
	// --- End Track P18b ---
	span: Span;
}

export type ActivationRestriction =
	| 'onceEachTurn'
	| 'duringYourTurn'
	| 'duringYourUpkeep'
	| 'duringCombat'
	// --- Track P15 ---
	| 'beforeAttackers'
	| 'oncePerGame'
	// --- End Track P15 ---
	// --- Track P18b ---
	| 'afterAttackers'
	| 'beforeBlockers'
	| 'duringBlockers'
	| 'afterBlockers'
	| 'afterCombat'
	| 'duringOpponentsTurn'
	// --- End Track P18b ---
	// --- Track P21 ---
	/** CR 605.3b / 304.5: "Activate only as an instant." (requires priority; never auto-tapped mid-cast). */
	| 'onlyAsInstant';
	// --- End Track P21 ---

export interface ActivatedAbility {
	kind: 'activated';
	cost: CostDef[];
	targets: TargetSpec[];
	effect: EffectStep[];
	modal?: ModalDef;
	timing: Timing;
	isMana: boolean;
	/** CR 602.5b: activation restrictions recognized on this ability. */
	activationRestrictions?: ActivationRestriction[];
	// --- Track P4 ---
	/** CR 602.5b: conditional activation restriction ("Activate only if you control a Swamp or a Plains."). */
	activationCondition?: Condition;
	// --- Track P15 ---
	/** CR 602.2: who may activate this ability ('any' for "Any player may activate", 'opponent' for "Only any opponent"). */
	activatorWho?: 'you' | 'any' | 'opponent';
	/** CR 702.193a–b Power-up: reduce activation mana cost by this permanent's mana cost if it entered this turn. */
	powerUpReduction?: boolean;
	// --- End Track P15 ---
	// --- Track P18b ---
	/** CR 107.3a: "X can't be 0." on an X-cost activated ability. */
	xCantBeZero?: boolean;
	/** CR 602.2b / 118.7: "This ability costs {N}/{X} less to activate [for each ... / if ...]." */
	activationCostReduction?: { delta: CostDelta; condition?: Condition };
	// --- End Track P18b ---
	/** Zones from which this ability can be activated; omitted defaults to `['battlefield']`. */
	activationZones?: ZoneType[];
	/** Canonical keyword tag for ability cost modifiers (`'equip'`, `'cycling'`), CR 702.6 / 702.29f. */
	costKeyword?: string;
	/**
	 * CR 305.6: a basic land type grants "{T}: Add [mana]" without any printed text. Intrinsic
	 * abilities have an empty span.
	 */
	intrinsic?: boolean;
	/**
	 * The id a player activates the ability by: `mana_tap` (the first "{T}: Add ..." ability),
	 * `loyalty_<line>`, `act_<line>`, where <line> is the index of the line in the printed text.
	 */
	id: string;
	/** The ability's normalised text (`~` for the card's name). Display only. */
	text?: string;
	// --- Track P6 ---
	/** Existence condition for striated frames (CR 711.5 Leveler, CR 722.2 Station). */
	grantCondition?: Condition;
	// --- Track P20b ---
	xSpendColors?: ManaColor[];
	xColoredOnly?: boolean;
	xMaxOnePerColor?: boolean;
	// --- End Track P20b ---
	span: Span;
}

export interface TriggeredAbility {
	kind: 'triggered';
	trigger: TriggerDef;
	/** CR 603.4 intervening-if condition, checked when the trigger event occurs and on resolution. */
	condition?: Condition;
	// --- Track P6 ---
	/** Existence condition for striated frames (CR 711.5 Leveler, CR 722.2 Station). */
	grantCondition?: Condition;
	targets: TargetSpec[];
	effect: EffectStep[];
	modal?: ModalDef;
	/** The ability's normalised text (`~` for the card's name). Display only. */
	text?: string;
	span: Span;
}

export interface StaticAbility {
	kind: 'static';
	static: StaticDef;
	span: Span;
}

export interface ReplacementAbility {
	kind: 'replacement';
	replacement: ReplacementDef;
	span: Span;
}

export type UnsupportedReason =
	/** Text the compiler did not understand. These spans drive the coverage loop. */
	| 'unparsed'
	/** A keyword the compiler recognises but the runtime does not implement. */
	| 'keyword_not_implemented'
	/** A static ability; statics are compiled in Phases 6 and 7. The runtime may still enforce it by
	 * scanning text until then. */
	| 'static_not_compiled'
	/** A layout with several faces (transform, split, adventure, ...). Non-goal for this plan. */
	| 'multiface'
	/**
	 * A triggered ability whose trigger the grammar understands but whose event (or event filter)
	 * the runtime never emits or can't check yet (Phase 5). It never triggers.
	 */
	| 'event_not_implemented';

export interface UnsupportedAbility {
	kind: 'unsupported';
	reason: UnsupportedReason;
	/** The ability's normalised text. */
	text: string;
	span: Span;
	/** The parts of `text` nothing claimed, if narrower than the whole ability. */
	unparsed: Span[];
	/**
	 * Activated-ability lines: the ability's id (see ActivatedAbility.id); `cast` for an additional
	 * cost of a spell whose effect isn't supported.
	 */
	id?: string;
	/**
	 * For an activated ability (or spell) whose effect or part of whose cost is unsupported: the cost
	 * parts the cost grammar did understand. The runtime still pays these, then the ability is
	 * resolved manually. `costComplete` is false if part of the cost itself is unparsed.
	 */
	cost?: CostDef[];
	costComplete?: boolean;
	/** Activated-ability lines: when it may be activated, and whether it is a mana ability. */
	timing?: Timing;
	isMana?: boolean;
	/** Mana abilities whose `addMana` step is understood even if a trailing rider ("When that mana is spent...") isn't. */
	effect?: EffectStep[];
	/** Target specs recognized in an activated ability or spell whose full effect is unsupported. */
	targets?: TargetSpec[];
	/** CR 602.5b: activation restrictions recognized on an unsupported activated ability. */
	activationRestrictions?: ActivationRestriction[];
	// --- Track P4 ---
	/** CR 602.5b: conditional activation restriction recognized on an unsupported activated ability. */
	activationCondition?: Condition;
	// --- Track P15 ---
	/** CR 602.2: who may activate this ability on an unsupported activated ability. */
	activatorWho?: 'you' | 'any' | 'opponent';
	/** CR 702.193a–b Power-up cost reduction flag on an unsupported activated ability. */
	powerUpReduction?: boolean;
	// --- End Track P15 ---
	// --- Track P18b ---
	xCantBeZero?: boolean;
	activationCostReduction?: { delta: CostDelta; condition?: Condition };
	/** CR 601.3: timing restrictions recognized on an unsupported spell. */
	castRestrictions?: SpellCastRestrictionKind[];
	castCondition?: Condition;
	// --- End Track P18b ---
	/**
	 * Phase 5: a triggered ability whose trigger head (and intervening-if) is understood but whose
	 * effect isn't. The runtime still knows when it triggers (section 2.7).
	 */
	trigger?: TriggerDef;
	condition?: Condition;
	// --- Track P6 ---
	/** Existence condition for striated frames (CR 711.5 Leveler, CR 722.2 Station). */
	grantCondition?: Condition;
}

export type Timing = 'instant' | 'sorcery' | 'mana';

export interface ModalDef {
	min: number;
	max: number;
	/** CR 700.2d: "You may choose the same mode more than once." */
	allowRepeat?: boolean;
	/** "that hasn't been chosen this turn" — each mode index may be chosen at most once per turn per permanent instance. */
	oncePerTurnUnique?: boolean;
	/** "Choose up to N" — explicitly marked up-to (min = 0). */
	upTo?: boolean;
	/** "If you control a commander as you cast this spell, you may choose both." (CR 700.2) */
	conditionalChooseAll?: Condition;
	modes: Array<{ targets: TargetSpec[]; effect: EffectStep[]; span: Span }>;
	// --- Track P12 ---
	/** CR 702.172 (Spree) / CR 702.183 (Tiered): per-mode additional cost aligned by mode index. */
	perModeCosts?: CostDef[][];
	// --- End Track P12 ---
	// --- Track P18b ---
	/** CR 607.2d / 700.2: "Choose one that hasn't been chosen —" (across permanent's battlefield lifetime). */
	unchosenPermanent?: boolean;
	/** CR 700.2e: "Target opponent chooses one —" / "An opponent chooses one —". */
	opponentChooses?: 'targetOpponent' | 'opponent';
	/** CR 700.2i: Bloomburrow Season pawprint budget (`{P}` modes). */
	pawprintBudget?: number;
	/** CR 700.2i: Pawprint `{P}` cost per mode index. */
	pawprintCosts?: number[];
	/** Dynamic maximum modes ("Choose X." / "Choose up to X —"). */
	dynamicMax?: Amount;
	/** "Choose one at random —". */
	randomMode?: boolean;
	/** Pre-modal rider steps executed before chosen mode effects on resolution. */
	prefixEffect?: EffectStep[];
	/** Post-modal rider steps executed after chosen mode effects on resolution. */
	suffixEffect?: EffectStep[];
	// --- End Track P18b ---
	// --- Track P22c ---
	/** CR 700.2a: Conditional alternative bounds ("If you control a Wizard as you cast ~, you may choose two instead."). */
	conditionalChooseRange?: { condition: Condition; min: number; max: number };
	/** Condition that overrides `randomMode` and lets controller choose modes normally. */
	conditionalNotRandom?: Condition;
	/** "Each mode must target a different player." */
	differentPlayerTargetsPerMode?: boolean;
	// --- End Track P22c ---
}

// ---- Keywords -------------------------------------------------------------------------------

export interface KeywordDef {
	/** Lower-case keyword name, e.g. 'flying', 'equip', 'protection', 'ward'. */
	name: string;
	/** Keyword cost, e.g. Equip {2}, Overload {6}{U}, Ward {2}. */
	cost?: string;
	/** Keyword parameter, e.g. 'black' for Protection from black, 'creature' for Enchant creature. */
	param?: string;
	/** Suspend N, Annihilator N, ... */
	n?: number;
	/** Ward: the cost the opponent pays ("Ward {2}", "Ward—Pay 3 life"), compiled by the cost grammar. */
	costDefs?: CostDef[];
	/** Kicker / Multikicker (CR 702.33): one entry per distinct kicker option (single, dual "and/or", multi). */
	kickerCosts?: Array<{ cost: string; costDefs: CostDef[]; tags: string[] }>;
	/** Equip [quality] (CR 702.6a): what the creature must be besides "creature you control". */
	equipFilter?: ObjectFilter;
	/** Enchant [quality] (CR 303.4a, 702.5): what the Aura can enchant (and so, as a spell, target). */
	enchantFilter?: ObjectFilter;
	/** Enchant player / opponent / you (CR 303.4a, 702.5a): player filter for player-enchanting Auras. */
	enchantPlayer?: PlayerFilter;
	/** Affinity for [quality] (CR 702.41): the permanents you control that reduce this spell's cost. */
	affinityFilter?: ObjectFilter;
	/** Typecycling (CR 702.29e): the card quality filter to search the library for. */
	cyclingFilter?: ObjectFilter;
	/** Typecycling (CR 702.29e): human-readable quality phrase (e.g. 'basic land', 'Plains', 'Wizard'). */
	cyclingDesc?: string;
	// --- Track P6 ---
	/** Prototype (CR 719, 702.160): inset mana cost, derived colors, and power/toughness. */
	prototypeSpec?: PrototypeSpec;
	// --- Track P12 ---
	/** Awaken N—[cost] (CR 702.113a): number of +1/+1 counters placed on the awakened land. */
	awakenN?: number;
	/** Emerge from [quality] [cost] (CR 702.119b): filter for the sacrificed permanent (default Creature). */
	emergeFilter?: ObjectFilter;
	/** Champion a [quality] (CR 702.72a): filter for the permanent you control exiled on ETB. */
	championFilter?: ObjectFilter;
	/** Devour [quality] N (CR 702.82c): filter for permanents you control sacrificed as ~ enters (default Creature). */
	devourFilter?: ObjectFilter;
	/** Devour X (CR 702.82a): X equals the number of creatures devoured this way (count * count counters). */
	devourX?: boolean;
	/** Equip planeswalker [cost] (CR 702.6e): targets planeswalker you control instead of creature. */
	equipAllowPlaneswalker?: boolean;
	/** Backup N (CR 702.165c): index of the Backup keyword ability so abilities after it are granted to another creature. */
	backupAbilityStartIndex?: number;
	// --- End Track P12 ---
	// --- Track P15 ---
	/** Gift a [thing] (CR 702.174): kind of gift promised to an opponent. */
	giftKind?: 'card' | 'food' | 'treasure' | 'tappedFish' | 'octopus' | 'extraTurn';
	/** Craft with [materials] [cost] (CR 702.167): material slot filters (or single repeatable filter when `craftAnyNumber`). */
	craftMaterials?: ObjectFilter[];
	craftAnyNumber?: boolean;
	/** Splice onto [subtype/type] [cost] (CR 702.47): filter on the spell being spliced onto. */
	spliceFilter?: ObjectFilter;
	/** Impending N—[cost] (CR 702.176): number of time counters placed on ETB when cast for impending. */
	impendingN?: number;
	/** Nonbasic / snow / supertype landwalk filter (CR 702.14). */
	landwalkFilter?: ObjectFilter;
	// --- End Track P15 ---
	// --- Track P21 ---
	/** CR 702.62a: "Suspend X—{cost}. X can't be 0." */
	suspendX?: boolean;
	/** CR 702.167: "Craft with two that share a card type {cost}" (e.g. Eye of Ojer Taq). */
	craftShareCardType?: boolean;
	/** CR 702.6: Inline activation cost reduction on Equip ("Equip {3}. This ability costs {1} less to activate for each ..."). */
	equipCostReduction?: { delta: CostDelta; condition?: Condition };
	// --- End Track P21 ---
}

// ---- Filters --------------------------------------------------------------------------------

export type StackTargetKind =
	| 'spell'
	| 'ability'
	| 'activatedAbility'
	| 'triggeredAbility'
	| 'spellOrAbility';

/**
 * One selector language for targets, costs, counts, triggers and statics. List fields match if any
 * entry matches ("artifact or enchantment" is `types: ['Artifact', 'Enchantment']`); different
 * fields must all match.
 */
export interface ObjectFilter {
	zone?: ZoneType | ZoneType[] | 'stack';
	/** CR 115.1: which kind of stack object a `zone: 'stack'` filter targets (default `'spell'`). */
	stackKind?: StackTargetKind;
	types?: string[];
	subtypes?: string[];
	supertypes?: string[];
	notTypes?: string[];
	/** "nonbasic", "nonlegendary". */
	notSupertypes?: string[];
	/** "non-Aura". */
	notSubtypes?: string[];
	controller?: 'you' | 'opponent' | 'any';
	/** Dynamic controller reference ("creatures target player controls"). */
	controllerRef?: PlayerRef;
	owner?: 'you' | 'opponent' | 'any';
	tapped?: boolean;
	token?: boolean;
	/** "another" / "other": not the source object. */
	other?: boolean;
	colors?: ManaColor[];
	manaValue?: Compare;
	power?: Compare;
	toughness?: Compare;
	attacking?: boolean;
	blocking?: boolean;
	/** CR 903.3: true iff the object is a commander (retains designation across all zones). */
	isCommander?: boolean;
	/** Exact card name match ("named <Name>", e.g. Partner with). */
	named?: string;
	/** CR 607.2a: cards currently in exile whose `exiledBy` links to the source permanent's current objectVersion. */
	exiledWithSelf?: boolean;
	// --- Track P3 ---
	/** CR 702.171b: true iff the permanent became saddled this turn. */
	saddled?: boolean;
	// --- Track P4 ---
	/** CR 205.3m / 614.12: matches the `chosenSubType` recorded on the source permanent. */
	ofChosenType?: boolean;
	/** CR 105.4 / 614.12: matches the `chosenColor` recorded on the source permanent. */
	ofChosenColor?: boolean;
	// --- Track P5 ---
	/** CR 701.37b: true iff the permanent is monstrous. */
	monstrous?: boolean;
	/** CR 903.3 / Path of Ancestry: shares a creature type with a commander you control/own. */
	sharesTypeWithCommander?: boolean;
	/** "Spells your opponents cast that target ~" (Terror of the Peaks). */
	targetsSelf?: boolean;
	// --- Track P8 ---
	/** "nonwhite", "nonblack", etc. */
	notColors?: ManaColor[];
	/** CR 105.2b: true iff the object has two or more colors. */
	multicolored?: boolean;
	/** CR 105.2a: true iff the object has exactly one color (colorless is neither). */
	monocolored?: boolean;
	/** Matches iff the object has ALL listed keywords (Layer 6 on battlefield, activeAbilityDefs off-battlefield). */
	hasKeywords?: string[];
	/** Matches iff the object has NONE of the listed keywords. */
	lacksKeywords?: string[];
	/** Matches iff the object has >= 1 counter of the specified type (or `'any'` for any counter). */
	hasCounters?: CounterType | string | 'any';
	/** CR 205.2b AND-semantics for compound card types ("artifact creature" requires BOTH Artifact and Creature). */
	allTypes?: string[];
	// --- Track P9 ---
	/** CR 702.49a: true iff the creature is an unblocked attacking creature you control. */
	unblockedAttacker?: boolean;
	// --- Track P10 ---
	/** CR 701.60: matches suspected (`true`) or non-suspected (`false`) permanents on the battlefield. */
	suspected?: boolean;
	/** Stack filter: `"that wasn't cast"` (`isCopy || kind !== 'spell'`). */
	wasNotCast?: boolean;
	/** Stack ability filter: `"from a [filter] source"`. */
	abilitySourceFilter?: ObjectFilter;
	// --- End Track P10 ---
	// --- Track P12 ---
	/** CR 702.166a Bargain: matches iff the permanent is an artifact, enchantment, or token. */
	artifactEnchantmentOrToken?: boolean;
	/** CR 702.134a Mentor: matches iff candidate's power is strictly less than source's power. */
	powerLessThanSource?: boolean;
	/** CR 702.154a Enlist: untapped nonattacking creature without summoning sickness (or with haste). */
	untappedNonattackingSummoningReady?: boolean;
	/** Disjunction of sub-filters ("creature or Vehicle", "artifact or non-Aura enchantment"). */
	anyOf?: ObjectFilter[];
	// --- End Track P12 ---
	// --- Track P11 ---
	/** CR 201.2a: matches objects whose name equals `source.chosenCardName` ("with the chosen name"). */
	ofChosenName?: boolean;
	/** Matches permanents attached to `'self'` or `'attachedTo'` ("Aura or Equipment attached to ~"), or Track P21 graveyard/reanimation host links. */
	attachedToRef?: 'self' | 'attachedTo' | 'hostOfSelf' | 'reanimatedBySelf';
	/** CR 700.6: matches historic objects (Artifacts, Legendaries, and Sagas). */
	historic?: boolean;
	/** Matches stack spells/abilities that target at least one object matching `targetsFilter`. */
	targetsFilter?: ObjectFilter;
	// --- End Track P11 ---
	// --- Track P13 ---
	/** Matches creatures that are currently attacking OR blocking ("attacking or blocking creature"). */
	attackingOrBlocking?: boolean;
	/** Matches permanents dealt >= 1 damage so far this turn ("creature that was dealt damage this turn"). */
	dealtDamageThisTurn?: boolean;
	/** Matches permanents that entered the battlefield this turn ("creature that entered this turn"). */
	enteredThisTurn?: boolean;
	/** CR 708: matches face-down (`true`) or face-up (`false`) permanents/spells. */
	faceDown?: boolean;
	/** Stack filter: matches spells that were kicked (`kickedCount >= 1`). */
	kickedSpell?: boolean;
	/** Stack filter: matches spells cast from anywhere other than hand (`castFromZone !== 'hand'`). */
	castNotFromHand?: boolean;
	/** Stack filter: matches spells cast from a specific zone (e.g. `'graveyard'`, `'exile'`). */
	castFromZoneFilter?: ZoneType;
	// --- End Track P13 ---
	// --- Track P14 ---
	/** Grandeur / same-name filter ("another card named ~"): matches objects whose evaluated/face name equals source's evaluated/face name. */
	sameNameAsSource?: boolean;
	/** Matches spells cast from anywhere other than a player's hand ("spells you cast from anywhere other than your hand"). */
	castFromOutsideHand?: boolean;
	/** Matches spells cast from a specific zone ("spells you cast from your graveyard", "spells you cast from exile"). */
	castFromZone?: ZoneType;
	/** Matches objects that share at least one color with `source` ("shares a color with ~"). */
	sharesColorWithSelf?: boolean;
	/** Matches permanents that have (`true`) or don't have (`false`) any counters on them. */
	hasAnyCounter?: boolean;
	/** Matches permanents that have (`true`) or don't have (`false`) an Equipment attached to them. */
	equipped?: boolean;
	/** Matches permanents that have (`true`) or don't have (`false`) an Aura attached to them. */
	enchanted?: boolean;
	// --- End Track P14 ---
	// --- Track P15 ---
	/** CR 723: matches prepared (`true`) or unprepared (`false`) permanents on the battlefield. */
	isPrepared?: boolean;
	/** CR 702.38 / 702.76: matches cards/permanents sharing at least one creature subtype with `source`. */
	sharesCreatureTypeWithSelf?: boolean;
	// --- End Track P15 ---
	// --- Track P16b ---
	/** CR 700.9: matches modified creatures (has a counter, is equipped, or is enchanted by an Aura you control). */
	modified?: boolean;
	/** CR 700.12: matches outlaws (Assassin, Mercenary, Pirate, Rogue, or Warlock). */
	outlaw?: boolean;
	/** CR 715: matches spells/cards that have an Adventure side. */
	hasAdventure?: boolean;
	/** Matches spells/cards with {X} in their mana cost. */
	hasXInManaCost?: boolean;
	/** Matches creatures on the battlefield whose effective power is greater than their base power. */
	powerGreaterThanBase?: boolean;
	/** Matches creatures/cards whose power equals their toughness. */
	powerEqualsToughness?: boolean;
	/** Matches spells/cards whose mana value equals the source permanent's power. */
	manaValueEqualsSourcePower?: boolean;
	/** Matches permanents controlled by the player the source Aura enchants. */
	controlledByEnchantedPlayer?: boolean;
	/** CR 702.112b: matches renowned (`true`) or non-renowned (`false`) permanents. */
	renowned?: boolean;
	/** CR 701.58: matches goaded permanents (`true`). */
	goaded?: boolean;
	// --- End Track P16b ---
	// --- Track P18a ---
	/** CR 702.140a Mutate: matches objects whose `ownerId` equals the spell/ability source's `ownerId`. */
	sameOwnerAsSource?: boolean;
	// --- End Track P18a ---
	// --- Track P17b ---
	/** Stack filter: matches spells whose bargain optional cost was paid (`kickedTags.includes('bargain')`). */
	bargainedSpell?: boolean;
	/** Stack filter: matches spells that target `'attachedTo'` ("spells that target enchanted/equipped creature"). */
	targetsAttached?: boolean;
	/** Stack filter: matches spells that target `'you'` OR a permanent matching `targetsYouOrFilter` ("that target you or a permanent you control"). */
	targetsYouOrFilter?: ObjectFilter;
	/** Stack filter: matches spells sharing at least one card type with a card exiled with `source` (CR 607.2a). */
	sharesCardTypeWithExiled?: boolean;
	/** Hand/zone filter: matches cards sharing at least one color with `ctx.spellCard` when paying an alternative cost. */
	sharesColorWithSpell?: boolean;
	/** CR 205.3m: matches objects having ALL listed subtypes simultaneously (e.g. `['Eldrazi', 'Scion']`, `['Eldrazi', 'Spawn']`). */
	allSubtypes?: string[];
	// --- End Track P17b ---
	// --- Track P16a ---
	/** CR 701.72 / CR 607.2: matches permanents currently assimilated by `source` (matching `objectVersion`). */
	assimilatedWithSelf?: boolean;
	// --- End Track P16a ---
	// --- Track P20a ---
	/** CR 702.95a Soulbond: matches `source` itself and the creature `source` is currently paired with (`source.pairedWithId`). */
	pairedWithSource?: boolean;
	/** Matches objects whose toughness is strictly greater than their power (`T > P`). */
	toughnessGreaterThanPower?: boolean;
	/** CR 107.1c: matches objects by mana-value parity (`0` is even), or relative to `source.chosenParity` (`chosenQuality` / `notChosenQuality`). */
	manaValueParity?: 'odd' | 'even' | 'chosenQuality' | 'notChosenQuality';
	/** Matches permanents controlled by `source.chosenPlayerId` ("the chosen player controls"). */
	controlledByChosenPlayer?: boolean;
	// --- End Track P20a ---
	// --- Track P19b ---
	/** CR 607.2a: matches objects with the same name as a face-up card exiled with `source` (e.g. Extraplanar Lens). */
	sameNameAsLinkedExile?: boolean;
	/** CR 105.2: matches objects having ALL listed colors simultaneously ("that's both red and white"). */
	allColors?: ManaColor[];
	// --- End Track P19b ---
	// --- Track P21 ---
	/** CR 303.4 / 702.5a: "Enchant creature with another Aura attached to it" (excludes `source` itself). */
	hasAnotherAuraAttached?: boolean;
	// --- End Track P21 ---
	// --- Track P19a ---
	/** CR 115.9a: Stack filter matching spells/abilities that currently have only a single target (`stk.targets.length === 1`). */
	withSingleTarget?: boolean;
	/** CR 115.9b–c: Stack filter matching spells/abilities that target ONLY a single object/player matching `singleTargetFilter` / `singleTargetPlayer`. */
	singleTargetFilter?: ObjectFilter;
	singleTargetPlayer?: PlayerFilter;
	/** Stack filter matching spells/abilities that target at least one player matching `targetsPlayerFilter`. */
	targetsPlayerFilter?: PlayerFilter;
	// --- End Track P19a ---
	// --- Track P22a ---
	/** CR 614.12 / 107.1c: matches objects whose mana value equals `source.chosenNumber` ("spells with mana value equal to the chosen number"). */
	manaValueEqualsChosenNumber?: boolean;
	/** CR 614.12 / 607.2: matches the object on the battlefield whose `instanceId === source.chosenObjectId` ("the chosen creature"). */
	chosenObject?: boolean;
	/** Matches objects with the same name as any nontoken permanent currently on the battlefield (*Cornered Market*). */
	sameNameAsNontokenPermanent?: boolean;
	// --- End Track P22a ---
}

export interface Compare {
	op: '>=' | '<=' | '=' | '>' | '<';
	value: Amount;
}

export interface PlayerFilter {
	relation: 'you' | 'opponent' | 'each_opponent' | 'each_player' | 'any' | 'target';
}

export interface TargetSpec {
	kind: 'object' | 'player' | 'objectOrPlayer';
	filter: ObjectFilter;
	player?: PlayerFilter;
	min: number;
	max: number;
	/** "two target cards from a single graveyard". */
	sameOwner?: boolean;
	/** CR 702.33g: target exists/is required only when this condition holds on cast. */
	condition?: Condition;
	// --- Track P2 ---
	/** "another target ...": cannot choose the same object as an earlier TargetSpec (CR 115.3). */
	otherTarget?: boolean;
	// --- End Track P2 ---
	// --- Track P7 ---
	/** CR 601.2d: total amount divided as caster/activator chooses among targets (`>= 1` per chosen target). */
	divideTotal?: Amount;
	// --- End Track P7 ---
	// --- Track P19a ---
	/** CR 115.9a: Target stack item must have only a single target (`stk.targets.length === 1`). */
	withSingleTarget?: boolean;
	/** Dynamic target count ("Destroy X target creatures", "Tap X target lands", "up to X target creatures"). */
	dynamicCount?: Amount;
	dynamicUpTo?: boolean;
	/** Maximum total mana value across chosen targets ("up to two target creatures with total mana value 6 or less"). */
	maxTotalManaValue?: number;
	// --- End Track P19a ---
}

// ---- Amounts (replaces dynamicFormula strings) ----------------------------------------------

export type BindingName = string;

export type Ref =
	| { k: 'self' }
	| { k: 'target'; index: number }
	| { k: 'binding'; name: BindingName }
	| { k: 'eventObject' }
	/** Each object a continuous effect applies to ("base P/T equal to its mana value"). */
	| { k: 'affected' }
	// --- Track P2 ---
	/** The permanent this Aura/Equipment is attached to ("Enchanted creature deals damage equal to its power"). */
	| { k: 'attachedTo' };
	// --- End Track P2 ---

export type PlayerRef =
	| { k: 'you' }
	| { k: 'controllerOf'; of: Ref }
	| { k: 'ownerOf'; of: Ref }
	| { k: 'target'; index: number }
	| { k: 'activePlayer' }
	/** The player the trigger event was about ("that player": the player dealt damage, the caster). */
	| { k: 'eventPlayer' }
	/** The defending player an attacking creature is attacking (CR 508.5, 702.86a). */
	| { k: 'defendingPlayer' };

export type Amount =
	| { k: 'const'; n: number }
	| { k: 'x' }
	| { k: 'count'; of: ObjectFilter }
	| { k: 'stat'; of: Ref; stat: 'power' | 'toughness' | 'manaValue'; lki?: boolean }
	// --- Track P14: optional player ref on devotion ---
	| { k: 'devotion'; colors: ManaColor[]; player?: PlayerRef }
	// --- End Track P14 ---
	| { k: 'resultCount'; of: BindingName }
	/** The amount carried by the trigger event, e.g. combat damage dealt ("that many"). */
	| { k: 'eventAmount' }
	| { k: 'cardsIn'; zone: ZoneType; of: PlayerRef }
	| { k: 'life'; of: PlayerRef }
	/** CR 903.8: number of times you've cast your commander from the command zone this game. */
	| { k: 'commanderCastCount' }
	/** CR 702.33d,f: number of times the spell/permanent was kicked (optionally filtered by kicker tag and scaled by multiplier). */
	| { k: 'kickedCount'; tag?: string; multiplier?: number }
	/** CR 702.40a: number of other spells cast before the Storm spell this turn (snapshotted on cast). */
	| { k: 'stormCount' }
	| { k: 'negate'; of: Amount }
	| { k: 'sum' | 'min' | 'max'; args: Amount[] }
	// --- Track P1 ---
	| { k: 'energyCount'; player: PlayerRef }
	// --- Track P6 ---
	| { k: 'countersOn'; counter: CounterType | 'any'; of: Ref }
	| { k: 'tappedCostPower' }
	/** Converge: number of distinct colors of mana spent to cast this spell (CR 608.2b / 400.7d). */
	| { k: 'colorsOfManaSpentToCast' }
	// --- Track P8 ---
	/** CR 300.1: count of distinct MTG card types (of the 9 card types) among cards in `zone` across `whose` players. */
	| { k: 'distinctCardTypesInZone'; zone: ZoneType; whose: 'you' | 'opponents' | 'all' }
	// --- Track P9 ---
	/** CR 702.43a / 704.8: count of `counter` on the event/source object as it last existed on the battlefield. */
	| { k: 'lkiCounterCount'; counter: CounterType }
	// --- Track P10 ---
	/** Result of the most recent die roll or coin-flip streak in the resolving effect ("where X is the result"). */
	| { k: 'lastRollResult' }
	// --- End Track P10 ---
	// --- Track P12 ---
	/** CR 702.82b: number of permanents devoured by this permanent as it entered the battlefield. */
	| { k: 'devouredCount' }
	/** CR 702.125a–b Undaunted: number of opponents you have who haven't left the game. */
	| { k: 'opponentCount' }
	// --- End Track P12 ---
	// --- Track P11 ---
	| { k: 'mul'; factor: number; of: Amount }
	/** CR 305.6 Domain: count of distinct basic land types (0..5) among lands `player` controls. */
	| { k: 'domain'; player: PlayerRef }
	/** CR 700.8a–b Party: maximum bipartite matching (0..4) across Cleric/Rogue/Warrior/Wizard creatures `player` controls. */
	| { k: 'partyCount'; player: PlayerRef }
	/** Count of attachments on `'self'` or `'attachedTo'` matching optional `filter`. */
	| { k: 'attachmentsOn'; target: 'self' | 'attachedTo'; filter?: ObjectFilter }
	// --- End Track P11 ---
	// --- Track P13 ---
	/** CR 709.5: total number of unlocked doors among Rooms `player` controls. */
	| { k: 'unlockedDoorsCount'; player: PlayerRef }
	/** CR 120.10: excess damage dealt to a permanent/planeswalker in the preceding `damage` step. */
	| { k: 'excessDamage' }
	/** Amount dealt / gained / lost / milled / discarded / sacrificed / drawn in the preceding step. */
	| { k: 'lastEffectAmount' }
	/** Number of distinct colors (0..5) among permanents `player` controls matching optional `filter`. */
	| { k: 'colorsAmongPermanents'; filter?: ObjectFilter; player: PlayerRef }
	/** Half of `of`, rounded up (`ceil`) or down (`floor`). */
	| { k: 'half'; of: Amount; round: 'up' | 'down' }
	/** CR 309.7: number of dungeons `player` has completed this game. */
	| { k: 'dungeonsCompleted'; player: PlayerRef }
	/** Greatest power / toughness / mana value among matching objects (0 if none). */
	| { k: 'greatestStatAmong'; filter: ObjectFilter; stat: 'power' | 'toughness' | 'manaValue' }
	/** Total power / toughness / mana value across matching battlefield permanents. */
	| { k: 'totalStatAmong'; filter: ObjectFilter; stat: 'power' | 'toughness' | 'manaValue' }
	// --- End Track P13 ---
	// --- Track P14 ---
	/** Strive: number of chosen targets beyond the first (`Math.max(0, chosenTargets.length - 1)`). */
	| { k: 'targetsBeyondFirst' }
	/** Number of distinct colors of `'self'`, `'attachedTo'`, or `'affected'` ("for each of its colors"). */
	| { k: 'colorsOfObject'; of: 'self' | 'attachedTo' | 'affected' }
	/** Total power / toughness / mana value among matching objects ("total power of creatures you control"). */
	| { k: 'totalStatOf'; stat: 'power' | 'toughness' | 'manaValue'; filter: ObjectFilter }
	/** Any non-negative integer chosen as part of a variable-count cost ("any number of"). */
	| { k: 'anyNumber' }
	// --- End Track P14 ---
	// --- Track P15 ---
	/** CR 702.179f: player's current speed (0 if player has no speed). */
	| { k: 'playerSpeed'; player: PlayerRef }
	/** CR 702.69a: number of permanents put into a graveyard from the battlefield so far this turn. */
	| { k: 'gravestormCount' }
	// --- End Track P15 ---
	// --- Track P17b ---
	| {
			k: 'p17bMetric';
			metric:
				| 'distinctManaValuesInGraveyard'
				| 'distinctCreatureTypesControlled'
				| 'distinctLandNamesControlled'
				| 'distinctNamesControlled'
				| 'countersAmongPlayersAndPermanents'
				| 'lifeGainedThisTurn'
				| 'startingLifeDifference'
				| 'creaturesAttackedWithThisTurn'
				| 'creaturesAttackedTotalThisTurn'
				| 'opponentsDealtDamageThisTurn'
				| 'commanderColorIdentityCount'
				| 'landsOpponentControlsProducingColorless'
				| 'sameNameInGraveyardAsSpell'
				| 'targetsCount'
				| 'targetsMatchingCount'
				| 'targetColorsCount'
				| 'targetCounterCount'
				| 'targetPower'
				// --- Track P20b ---
				| 'exiledCostCardCount'
				| 'sacrificedCostPermCount'
				| 'removedCostCounterCount';
				// --- End Track P20b ---
			filter?: ObjectFilter;
			counter?: CounterType | 'any';
	  }
	// --- End Track P17b ---
	// --- Track P16a ---
	/** Number of counters removed in the preceding `removeCounters` step ("that many", "for each counter removed this way"). */
	| { k: 'countersRemovedThisWay' }
	/** Count of counters of `counter` on `player` ("for each poison/experience/energy/rad/ticket counter you have"). */
	| {
			k: 'playerCounters';
			counter: 'poison' | 'experience' | 'energy' | 'rad' | 'ticket';
			player: PlayerRef;
			// --- Track P22a ---
			/** Multi-player counter sum ('opponents' = sum across non-lost opponents, 'all' = all players, 'defendingPlayer' = defending player in combat). */
			players?: 'you' | 'opponents' | 'all' | 'defendingPlayer';
			// --- End Track P22a ---
	  }
	// --- End Track P16a ---
	// --- Track P20a ---
	/** CR 601.2h / 400.7d: total amount of mana spent to cast this spell / permanent (`manaSpentCount`). */
	| { k: 'manaSpentToCast' }
	/** Count of cards matching optional `filter` in `source.chosenPlayerId`'s `zone` ("cards in the chosen player's hand/graveyard"). */
	| { k: 'chosenPlayerZoneCount'; zone: ZoneType; filter?: ObjectFilter }
	/** Number of non-lost opponents whose life total is strictly less than half their starting life total (*Anya, Merciless Angel*). */
	| { k: 'opponentsWithLifeLessThanHalfStarting' }
	// --- End Track P20a ---
	// --- Track P20b ---
	| { k: 'p20bCostPaidCount'; kind: 'exiled' | 'sacrificed' | 'removedCounters' }
	// --- End Track P20b ---
	// --- Track P19a ---
	/** CR 707.10 / 608.2h: Power, toughness, mana value, or distinct color count of the permanent(s) sacrificed to pay the spell/ability's cost. */
	| { k: 'sacrificedCostStat'; stat: 'power' | 'toughness' | 'manaValue' | 'colorsCount' }
	/** Least power / toughness / mana value among matching objects (0 if none). */
	| { k: 'leastStatAmong'; filter: ObjectFilter; stat: 'power' | 'toughness' | 'manaValue' }
	/** Count recorded in a preceding step by category ("cards exiled from their hand this way", "damage prevented this way", etc.). */
	| {
			k: 'countedThisWay';
			kind:
				| 'exiledFromHand'
				| 'damagePrevented'
				| 'greatestDiscarded'
				| 'manaPaidJoinForces'
				| 'tappedThisWay'
				| 'destroyedThisWay'
				| 'sacrificedThisWay'
				| 'discardedThisWay'
				| 'exiledThisWay';
	  }
	/** Non-negative difference `Math.max(0, left - right)` ("where X is 3 minus the number of cards in their hand", "draw cards equal to the difference"). */
	| { k: 'difference'; left: Amount; right: Amount }
	// --- End Track P19a ---
	// --- Track P22a ---
	/** CR 201.2: number of differently named objects matching `of` (face-down objects without a name have no name and are excluded). */
	| { k: 'distinctNamesCount'; of: ObjectFilter }
	/** Number of creatures that died this turn (optionally scoped to `controller`: `'you'` | `'opponent'` | `'any'`). */
	| { k: 'creaturesDiedThisTurn'; controller?: 'you' | 'opponent' | 'any' }
	/** Number of spells cast this turn by `who` (default `'you'`) matching optional `filter` (*Ral, Monsoon Mage*). */
	| { k: 'spellsCastThisTurnCount'; filter?: ObjectFilter; who?: 'you' | 'activePlayer' }
	// --- End Track P22a ---
	// --- Track P22c ---
	| { k: 'conditional'; condition: Condition; then: Amount; else: Amount };
	// --- End Track P22c ---

// ---- Costs ----------------------------------------------------------------------------------

export type CostDef =
	| {
			k: 'mana';
			cost: string;
			// --- Track P20b ---
			xSpendColors?: ManaColor[];
			xColoredOnly?: boolean;
			xMaxOnePerColor?: boolean;
			// --- End Track P20b ---
	  }
	| { k: 'tapSelf' }
	// --- Track P17b: optional viaSymbol flag (default true for {Q}; false for spelled-out "Untap ~", CR 302.6) ---
	| { k: 'untapSelf'; viaSymbol?: boolean }
	| {
			k: 'tapOthers';
			count: Amount;
			filter: ObjectFilter;
			shareCreatureType?: boolean;
	  }
	| {
			k: 'sacrifice';
			count: Amount;
			filter: ObjectFilter | 'self';
			sacrificeAll?: boolean;
			halfRoundedUp?: boolean;
			attachedCreature?: boolean;
			// --- Track P20b ---
			oneOrMore?: boolean;
			upTo?: number;
			differentNames?: boolean;
			// --- End Track P20b ---
	  }
	| {
			k: 'discard';
			count: Amount;
			filter?: ObjectFilter | 'self';
			random?: boolean;
			sameNamePair?: boolean;
			sameNameAsControlledFilter?: ObjectFilter;
			// --- Track P20b ---
			differentNames?: boolean;
			// --- End Track P20b ---
	  }
	| { k: 'payLife'; amount: Amount; halfLifeRoundedUp?: boolean }
	// --- End Track P17b ---
	// --- Track P15: widened loyalty for +X / -X loyalty abilities (CR 606.4) ---
	| { k: 'loyalty'; delta: number; isX?: boolean; sign?: '+' | '-' }
	// --- End Track P15 ---
	// --- Track P11: widened removeCounters & added mill ---
	| {
			k: 'removeCounters';
			counter: CounterType | 'any';
			count: Amount;
			removeAll?: boolean;
			from: 'self' | ObjectFilter;
			among?: boolean;
			// --- Track P20b ---
			oneOrMore?: boolean;
			// --- End Track P20b ---
	  }
	// --- End Track P11 ---
	// --- Track P17b: widened exileFrom & choice ---
	| {
			k: 'exileFrom';
			zone: ZoneType | 'stack';
			count: Amount;
			filter?: ObjectFilter | 'self';
			fromTop?: boolean;
			anyGraveyard?: boolean;
			singleGraveyard?: boolean;
			minTotalManaValue?: number;
			collectEvidence?: boolean;
			// --- Track P20b ---
			oneOrMore?: boolean;
			totalManaValueEqualsX?: boolean;
			andOtherSameNameCount?: number;
			// --- End Track P20b ---
	  }
	/** Reveal N matching cards in hand as part of a cost ("Morph—Reveal a white card in your hand."). */
	| {
			k: 'revealFromHand';
			count: Amount;
			filter?: ObjectFilter | 'self';
			// --- Track P20b ---
			shareColor?: boolean;
			// --- End Track P20b ---
	  }
	/** Pay exactly one of the options ("discard a card or pay 3 life", "sacrifice a creature or pay {3}{B}"). */
	| { k: 'choice'; options: CostDef[][]; forage?: boolean }
	// --- End Track P17b ---
	/** The player may pay this cost or not ("As an additional cost to cast ~, you may sacrifice an artifact."). */
	| { k: 'optional'; cost: CostDef[] }
	/** Tap any number of matching untapped objects with total metric >= minTotal (e.g. Crew N). */
	| {
			k: 'tapSubsetSum';
			minTotal: Amount;
			metric: 'power';
			filter: ObjectFilter;
			excludeSelf?: boolean;
			restrictionTag?: string;
	  }
	// --- Track P1 ---
	| { k: 'payEnergy'; count: Amount }
	// --- Track P4 ---
	/** CR 701.43a: "Exert ~" activation or additional cost. */
	| { k: 'exertSelf' }
	// --- Track P9 ---
	/** CR 702.49a: "Return an unblocked attacker you control to hand" (or return matching permanent to owner's hand). */
	| { k: 'returnToHand'; count: Amount; filter: ObjectFilter | 'self' }
	// --- Track P11 ---
	/** CR 701.13: "Mill a card" / "Mill N cards" activation or additional cost. */
	| { k: 'mill'; count: Amount }
	// --- End Track P11 ---
	// --- Track P14 ---
	/** CR 701.67a–b: "Waterbend [cost]" — pay [cost]; each {1} in [cost] may be paid by tapping an untapped artifact or creature you control. */
	| { k: 'waterbend'; cost: string }
	/** CR 701.4a–b: "Behold a [quality]" — choose a [quality] permanent you control OR reveal a [quality] card from your hand. */
	| {
			k: 'behold';
			count: Amount;
			filter: ObjectFilter;
			// --- Track P20b ---
			exile?: boolean;
			// --- End Track P20b ---
	  }
	/** "Put N <counter> counter(s) on ~ / a <filter> you control" activation or additional cost. */
	| { k: 'putCounters'; count: Amount; counter: CounterType; on: 'self' | ObjectFilter }
	/** "Discard your hand" activation or additional cost. */
	| { k: 'discardHand' }
	/** "Put a card / N cards from your hand on top of your library" activation or additional cost. */
	| { k: 'putFromHandOnTopOfLibrary'; count: Amount; filter?: ObjectFilter }
	/** "Tap enchanted/equipped creature" activation cost. */
	| { k: 'tapAttached' }
	// --- End Track P14 ---
	// --- Track P17b ---
	/** CR 302.6 / 602.2: Spelled-out "Untap N tapped <filter> you control" activation or additional cost. */
	| { k: 'untapOthers'; count: Amount; filter: ObjectFilter }
	/** CR 701.20a: "Reveal your hand" activation, additional, or alternative cost. */
	| { k: 'revealHand' }
	/** CR 118.12: "Have an opponent / each other player gain N life" alternative or additional cost. */
	| { k: 'opponentGainsLife'; amount: Amount; eachOtherPlayer?: boolean }
	/** "Put ~ / N <filter> card(s) [from your graveyard] on the bottom of your / its owner's library" cost. */
	| {
			k: 'putOnBottomOfLibrary';
			from: 'graveyard' | 'battlefield' | 'hand';
			count: Amount;
			filter?: ObjectFilter | 'self';
	  }
	/** Eldrazi Processor cost: "Put N card(s) an opponent owns from exile into that player's graveyard". */
	| { k: 'processOpponentExile'; count: Amount; filter?: ObjectFilter }
	/** "Put N <filter> card(s) exiled with ~ into its owner's graveyard" cost (CR 607.2a). */
	| { k: 'putExiledWithSelfToGraveyard'; count: Amount; filter?: ObjectFilter }
	// --- End Track P17b ---
	// --- Track P20b ---
	/** CR 701.3d: "Unattach ~" activation cost. */
	| { k: 'unattachSelf' }
	/** CR 701.3d: "Unattach an Equipment from ~" activation cost. */
	| { k: 'unattachOther'; count: Amount; filter: ObjectFilter; fromSelf?: boolean }
	/** CR 706.2: "Roll a dN" activation cost. */
	| { k: 'rollDie'; sides: number }
	/** CR 705.1: "Flip a coin" activation cost. */
	| { k: 'flipCoin' };
	// --- End Track P20b ---

// ---- Effects --------------------------------------------------------------------------------

export type Verb =
	| 'destroy'
	| 'exile'
	| 'bounce'
	| 'move'
	| 'draw'
	| 'scry'
	| 'surveil'
	| 'lookAndReorder'
	| 'investigate'
	| 'mill'
	| 'damage'
	| 'gainLife'
	| 'loseLife'
	| 'createToken'
	| 'copyPermanent'
	| 'copySpell'
	| 'putCounters'
	| 'proliferate'
	| 'search'
	| 'pump'
	| 'grant'
	| 'attach'
	| 'switchPT'
	| 'counterSpell'
	| 'addMana'
	| 'phaseOut'
	| 'extraTurn'
	| 'endTurn'
	| 'sacrifice'
	| 'win'
	| 'lose'
	| 'suspendTick'
	| 'suspendCast'
	/** Registers `delayed` (subject `none`); its effect may refer to this ability's bindings. */
	| 'delayedTrigger'
	/** Gives a player a rule for a duration ("your life total can't change"); see `playerRules`. */
	| 'grantPlayer'
	| 'fight'
	| 'discard'
	| 'tap'
	| 'untap'
	| 'tapOrUntap'
	| 'transform'
	| 'flip'
	/**
	 * Look at the top N cards of your library, then put up to `dig.keep` of them somewhere and the
	 * rest elsewhere ("Put up to one of them on top of your library and the rest on the bottom").
	 */
	| 'dig'
	| 'grantPlayFromExile'
	| 'goad'
	| 'explore'
	| 'connive'
	| 'regenerate'
	| 'cantRegenerate'
	| 'payCost'
	| 'animate'
	| 'gainControl'
	| 'revealAndDiscard'
	// --- Track P1 ---
	| 'gainEnergy'
	| 'becomeMonarch'
	// --- Track P3 ---
	| 'saddle'
	| 'cumulativeUpkeep'
	// --- Track P4 ---
	| 'freezeUntap'
	| 'exert'
	// --- Track P5 ---
	| 'amass'
	| 'incubate'
	| 'populate'
	| 'manifest'
	| 'cloak'
	| 'manifestDread'
	| 'monstrosity'
	| 'bolster'
	| 'adapt'
	// --- Track P6 ---
	| 'removeCounters'
	| 'extraCombatPhase'
	| 'moveCounters'
	| 'reveal'
	// --- Track P7 ---
	| 'preventDamage'
	| 'exileInsteadOfDying'
	| 'combatRestriction'
	| 'becomeCopy'
	| 'discardHand'
	// --- Track P10 ---
	| 'discover'
	| 'clash'
	| 'detain'
	| 'suspect'
	| 'collectEvidence'
	| 'forage'
	| 'endure'
	| 'timeTravel'
	| 'blight'
	| 'fateseal'
	| 'flipCoin'
	| 'rollDie'
	| 'retainMana'
	// --- End Track P10 ---
	// --- Track P13 ---
	| 'createEmblem'
	| 'createRoleToken'
	| 'doubleOrTriple'
	| 'exchange'
	| 'turnFace'
	| 'chooseDesignation'
	| 'grantGraveyardCast'
	| 'ventureIntoDungeon'
	| 'takeInitiative'
	| 'temptWithRing'
	| 'earthbend'
	| 'airbend'
	| 'learn'
	| 'villainousChoice'
	| 'vote'
	// --- End Track P13 ---
	// --- Track P15 ---
	| 'prepare'
	| 'unprepare'
	| 'increaseSpeed'
	// --- End Track P15 ---
	// --- Track P18b & P16a ---
	| 'meld'
	| 'harness'
	// --- End Track P18b ---
	// --- Track P16a ---
	| 'pileSplit'
	| 'castFree'
	| 'putPlayerCounters'
	| 'removeFromCombat'
	| 'convert'
	| 'empowerJace'
	| 'assimilate'
	| 'recruit'
	| 'heal'
	// --- End Track P16a ---
	// --- Track P19a ---
	| 'redirectTargets'
	| 'skipTurn'
	| 'exileUntil'
	| 'delayedTapManaTrigger'
	| 'delayedNextSpellCopy';
	// --- End Track P19a ---

export type ManaRestriction = 'artifactSpellOrNonSpell';

// --- Track P13: added 'untilEndOfYourNextTurn' ---
// --- Track P16a: added 'untilEndOfCombat' | 'forAsLongAsYouControlSelf' | 'forAsLongAsSelfRemainsTapped' ---
export type Duration =
	| 'endOfTurn'
	| 'permanent'
	| 'untilYourNextTurn'
	| 'untilEndOfYourNextTurn'
	| 'untilSourceLeaves'
	| 'untilEndOfCombat'
	| 'forAsLongAsYouControlSelf'
	| 'forAsLongAsSelfRemainsTapped';
// --- End Track P16a ---
// --- End Track P13 ---

export interface OptionalSpec {
	chooser: PlayerRef;
	cost?: CostDef[];
	/**
	 * - 'doIfPaid' (default): prompt `chooser` to pay `cost` (or accept free yes/no if `cost` is absent);
	 *   step executes iff accepted & paid.
	 * - 'doUnlessPaid': prompt `chooser` to pay `cost` (or accept free yes/no);
	 *   step executes iff `chooser` DECLINES or CANNOT pay.
	 */
	mode?: 'doIfPaid' | 'doUnlessPaid';
}

/** An ordered list of verb steps whose results later steps can refer to (`bindAs`). */
export interface EffectStep {
	verb: Verb;
	subject: Selector;
	/** Who performs the step ("its controller creates ...", "target player draws ..."). Default: you. */
	actor?: PlayerRef;
	amount?: Amount;
	params?: EffectParams;
	optional?: OptionalSpec;
	/** Execute only if the preceding optional step at this step index was accepted ("If you do, ..."). */
	ifPrecedingAccepted?: number;
	/** Execute only if the preceding optional step at this step index was declined/unpaid ("If you don't, ..."). */
	ifPrecedingDeclined?: number;
	/** Execute only if this condition holds at resolution time (e.g. "If this spell was kicked, ..."). */
	condition?: Condition;
	bindAs?: BindingName;
	/** `nextTurn`: "at the beginning of the next turn's upkeep" (not this turn's). */
	delayed?: { trigger: TriggerDef; effect: EffectStep[]; nextTurn?: boolean };
	// --- Wave 6 Shared ---
	/** CR 603.2h: "Do this only once each turn." */
	doThisOncePerTurn?: boolean;
	// --- End Wave 6 Shared ---
	span: Span;
}

export interface EffectParams {
	toughness?: Amount;
	keywords?: string[];
	/** grant: keywords removed until `duration` ("lose hexproof and indestructible until end of turn"). */
	removeKeywords?: string[];
	/** grant (with removeKeywords): "and can't have or gain ..." (CR 113.11). */
	cantHaveOrGain?: boolean;
	duration?: Duration;
	counter?: CounterType;
	/** moveCounters: filter for recipient creature(s) ("onto other creatures"). */
	toFilter?: ObjectFilter;
	token?: TokenSpec;
	tapped?: boolean;
	mayShuffle?: boolean;
	/** addMana: the exact symbols produced, e.g. ['C', 'C'] for "Add {C}{C}". */
	mana?: ManaColor[];
	/** addMana: `amount` mana of one colour chosen from this set ("Add {W} or {U}", "any color"). */
	manaChoice?:
		| ManaColor[]
		| 'any'
		| 'commanderIdentity'
		| 'opponentLandColors'
		| 'chosenColor'
		// --- Track P19a ---
		| 'eventProducedTypes'
		| 'eventProducedColors'
		| 'controlledLandProducedTypes'
		| 'controlledLandProducedColors';
	// --- End Track P19a ---
	// --- Track P19b ---
	/** addMana: CR 605.1b / 106.7 mana of any type that the triggering land/permanent produced. */
	manaFromProducedEvent?: boolean;
	// --- End Track P19b ---
	/** addMana: spending restriction attached to the produced mana (CR 106.6). */
	manaRestriction?: ManaRestriction;
	/** grantPlayer: the rules the player gets. */
	playerRules?: Array<
		| 'lifeTotalCantChange'
		| 'protectionFromEverything'
		// --- Track P7 ---
		| 'damageCantBePrevented'
		| 'combatDamageCantBePrevented'
		// --- Track P13 ---
		| 'extraLandPlay'
		| 'cannotLoseGame'
		| 'hexproof'
		// --- End Track P13 ---
		// --- Track P16a ---
		| 'opponentsCantCastThisTurn'
		| 'cantCastSpellsThisTurn'
		| 'spellsCantBeCounteredThisTurn'
		| 'castAsThoughFlashThisTurn'
		| 'nextSpellFlash'
		| 'nextSpellCantBeCountered'
		// --- End Track P16a ---
	>;
	search?: SearchSpec;
	to?: ZoneType;
	from?: ZoneType;
	/** move to the battlefield: "under your control" (otherwise its owner controls it). */
	underYourControl?: boolean;
	/** move: only the topmost matching card of an ordered zone (CR 404.2). */
	topmostOnly?: boolean;
	/** endTurn: "the player whose turn it is may end the turn". */
	activePlayerMay?: boolean;
	/** win: the condition under which the player wins, checked on resolution. */
	condition?: Condition;
	/** fight: the second creature in a fight ("~ fights target creature"). */
	with?: Selector;
	/** discard / sacrifice: "at random". */
	atRandom?: boolean;
	/** move to a library: top, bottom, or top/second-or-bottom choice ("put target creature on top or bottom of its owner's library"). */
	position?: 'top' | 'bottom' | 'topOrBottom' | 'secondOrBottom';
	/** The chooser picks up to `amount` ("draw up to two cards", "you may put a permanent card ..."). */
	upTo?: boolean;
	/** copyPermanent: "except the token isn't legendary". */
	notLegendary?: boolean;
	/** dig: where the kept cards and the rest go. */
	dig?: {
		keep: number;
		upTo: boolean;
		keepFilter?: ObjectFilter;
		keepAllMatching?: boolean;
		keepLabel?: string;
		keepTo: 'libraryTop' | 'hand' | 'battlefield' | 'graveyard';
		keepTapped?: boolean;
		// --- Track P19a ---
		keepAttacking?: boolean;
		// --- End Track P19a ---
		revealAll?: boolean;
		revealKept?: boolean;
		rest: 'libraryBottom' | 'graveyard' | 'libraryTop';
		restRandom?: boolean;
		restOrder?: 'any' | 'random';
		// --- Track P10 ---
		/** Reveal from top of library until a card matches `untilFilter` (CR 701.20). */
		untilFilter?: ObjectFilter;
		/** Put all revealed/remaining cards into hand (e.g. Treasure Hunt-style effects). */
		restToHand?: boolean;
		// --- End Track P10 ---
		// --- Track P16a ---
		/** Shuffle the unkept cards back into the library (e.g. Polymorph / Chaos Warp / Transmogrify). */
		shuffleRest?: boolean;
		// --- End Track P16a ---
		/** Ordered multi-destination partition (e.g. Expressive Iteration: 1 hand, 1 bottom, 1 exile playable this turn). */
		partitions?: Array<{
			count: number;
			to: 'hand' | 'libraryBottom' | 'exile' | 'graveyard';
			playableThisTurn?: boolean;
		}>;
	};
	/** move to battlefield: enters transformed with its back face up (CR 712.14a / 712.11a). */
	enteredTransformed?: boolean;
	/** grantPlayFromExile: permission to play the exiled card(s) from exile ("You may play that card this turn"). */
	playFromExile?: {
		duration:
			| 'thisTurn'
			// --- Track P2 ---
			| 'untilEndOfYourNextTurn'
			| 'untilYourNextEndStep'
			| 'asLongAsExiled';
		spendManaAsAnyColor?: boolean;
		spellsOnly?: boolean;
		withoutPayingManaCost?: boolean;
		// --- End Track P2 ---
	};
	/** destroy: prevents regeneration shields (and "can't be regenerated" clauses) from replacing destruction. */
	cantBeRegenerated?: boolean;
	/** animate: Layer 4 card types to add (e.g. ['Creature']). */
	addTypes?: string[];
	/** animate: Layer 4 card types to set (overwriting existing card types per CR 205.1a). */
	setTypes?: string[];
	/** animate: Layer 4 subtypes to add ("in addition to its other types" / "It's still a land"). */
	addSubtypes?: string[];
	/** animate: Layer 4 subtypes to set. */
	setSubtypes?: string[];
	/** animate: Layer 5 colors to set. */
	setColors?: ManaColor[];
	/** animate: Layer 5 colors to add. */
	addColors?: ManaColor[];
	/** animate: Layer 6 keywords to grant. */
	addKeywords?: string[];
	/** animate: Layer 7b base power to set. */
	setPower?: Amount;
	/** animate: Layer 7b base toughness to set. */
	setToughness?: Amount;
	/** animate: true when existing card types/subtypes are retained ("It's still a land", "in addition to its other types"). */
	keepExistingTypes?: boolean;
	/** copySpell: number of copies to create (default 1). */
	count?: Amount;
	/** copySpell: CR 707.10c "You may choose new targets for the copy / copies." */
	mayChooseNewTargets?: boolean;
	/** copySpell: Layer 1a color exception on the copy. */
	exceptColors?: ManaColor[];
	/** copySpell: Layer 1a "except the copy isn't legendary" exception. */
	nonLegendary?: boolean;
	/**
	 * exile: "until ~ leaves the battlefield" (CR 610.3).
	 * Checks CR 610.3a–b before exiling and records `untilSourceLeavesReturn` on the exiled card.
	 */
	untilSourceLeaves?: boolean;
	/** gainControl: also untap the stolen permanent when the control change applies. */
	untap?: boolean;
	/**
	 * move (CR 702.84a): Unearth return from graveyard to battlefield — grants permanent haste,
	 * registers a next-end-step exile delayed trigger, and sets `unearthLeaveExile` replacement.
	 */
	unearth?: boolean;
	/**
	 * revealAndDiscard (CR 701.9, 701.20): Target player reveals their hand; `chooser` chooses
	 * a matching card from it (`optionalChoice` when "You may choose ..."), moving it to `destination`.
	 */
	coerciveDiscard?: CoerciveDiscardSpec;
	// --- Track P2 ---
	/** damage: creature/permanent source dealing the damage when not `~` ("bite" spells/abilities, CR 608.2b / 608.2h). */
	damageSource?: Selector;
	/** damage: players dealt the same simultaneous damage alongside permanent `subject` ("each creature and each player"). */
	alsoDamagePlayers?: PlayerFilter;
	// --- End Track P2 ---
	// --- Track P3 ---
	/** cumulativeUpkeep (CR 702.24a): per-age-counter cost definitions compiled from the keyword parameter. */
	cumulativeUpkeepCost?: CostDef[];
	/** cumulativeUpkeep (CR 702.24a): human-readable per-age-counter cost string for prompt titles. */
	cumulativeUpkeepText?: string;
	// --- Track P4 ---
	/** move to library (CR 401.7): 1-based ordinal from top (2 = second from top, 3 = third from top). */
	fromTop?: number;
	/** move to library (`topOrBottom` / `secondOrBottom`): whether the spell/ability's controller or the object's owner chooses. */
	libraryChoiceBy?: 'controller' | 'owner';
	/** addMana: fixed color options combined with the permanent's `chosenColor` ("Add {C} or one mana of the chosen color"). */
	manaWithChosenColor?: ManaColor[];
	/** addMana: exact multi-mana bundle options ("Add {W}{W}, {W}{B}, or {B}{B}"). */
	manaBundles?: ManaColor[][];
	/** addMana: `amount` mana in any combination of the given colors or `'any'` ("in any combination of colors"). */
	manaCombinationColors?: ManaColor[] | 'any';
	// --- Track P5 ---
	/** amass (CR 701.47a,d): singular creature subtype amassed (e.g. 'Zombie', 'Orc', 'Army' companion). */
	amassSubtype?: string;
	// --- Track P6 ---
	/** removeCounters (CR 702.32a Fading): if unable to remove the counter, sacrifice the permanent. */
	ifUnableSacrificeSelf?: boolean;
	/** copyPermanent (CR 707.9b, 702.175a Offspring): Layer 1a base P/T exception on the token copy. */
	exceptPT?: { power: number; toughness: number };
	// --- Track P7 ---
	/** preventDamage (CR 615): prevention shield specification. */
	preventSpec?: DamagePreventionSpec;
	/** copyPermanent / becomeCopy (CR 707.9a–d): Layer 1a copy modifications. */
	copyMod?: CopyModificationSpec;
	/** copyPermanent (CR 508.4): token enters tapped and attacking. */
	tappedAndAttacking?: boolean;
	/** becomeCopy: selector for the object whose copiable values are copied (`subject` becomes a copy of `copySource`). */
	copySource?: Selector;
	/** combatRestriction (CR 509.1b): timed block / evasion restriction until end of turn. */
	combatRestriction?: TimedCombatRestrictionSpec;
	/** damage / putCounters (CR 601.2d / 608.2b): each target receives its locked-in `targetDivisions[id]` amount. */
	divided?: boolean;
	/** discardHand: optional follow-up draw per player ("then draws N / that many cards"). */
	drawAfterDiscardHand?: Amount | 'thatMany';
	// --- Track P9 ---
	/** move to battlefield (CR 702.93a Undying, CR 702.79a Persist): enters with counters placed via ETB replacement. */
	withCounters?: { counter: CounterType; count: number };
	// --- Track P10 ---
	/** CR 603.12: reflexive triggered ability placed on the stack when this step's action completes. */
	reflexiveTrigger?: ReflexiveTriggerSpec;
	/** CR 106.6: generalized spending restriction attached to mana produced by `addMana`. */
	manaRestrictionSpec?: ManaSpendingRestrictionSpec;
	/** CR 106.4: "Until end of turn, you don't lose this mana as steps and phases end." */
	retainManaUntilEndOfTurn?: boolean;
	/** retainMana: colors of unspent mana retained across steps/phases until end of turn. */
	unemptiedColors?: ManaColor[] | 'all';
	/** grant / pump / animate: quoted ability strings granted until end of turn. */
	grantedAbilityTexts?: string[];
	/** attach (CR 701.3a–d): explicit selector for the Equipment/Aura being attached when not `self`. */
	attachObject?: Selector;
	/** counterSpell (CR 614.15): if countered this way, exile it (or put on top/bottom of library) instead of owner's graveyard. */
	counterReplacementZone?: 'exile' | 'libraryTop' | 'libraryBottom';
	/** suspect (CR 701.60b): true when removing suspected status ("is no longer suspected"). */
	unsuspect?: boolean;
	/** flipCoin (CR 705): flip repeatedly until losing a flip; stores win count in `lastRollResult`. */
	coinFlipUntilLose?: boolean;
	/** flipCoin (CR 705): inline steps executed on winning / losing the coin flip. */
	winFlipEffect?: EffectStep[];
	loseFlipEffect?: EffectStep[];
	/** rollDie (CR 706): die sides (4, 6, 8, 10, 12, 20) and optional modifier added to the roll. */
	dieSides?: number;
	dieBonus?: Amount;
	/** rollDie (CR 706.2): result table branches (`1—9 | ...`, `10—19 | ...`, `20 | ...`). */
	dieRollTable?: DieRollBranch[];
	// --- End Track P10 ---
	// --- Track P13 ---
	/** createEmblem (CR 114): raw oracle ability strings granted to the created emblem. */
	emblemAbilities?: string[];
	/** createRoleToken (CR 111.10k–r): predefined Role Aura token kind attached to `subject`. */
	roleKind?: RoleTokenKind;
	/** doubleOrTriple (CR 701.10–11): target attribute/counter/life and factor (2 or 3). */
	doubleSpec?: DoubleOrTripleSpec;
	/** exchange (CR 701.12): exchange control of two permanents, life totals, or life total with P/T. */
	exchangeSpec?: ExchangeSpec;
	/** turnFace (CR 708): turn permanent(s) face up or face down. */
	faceDirection?: 'up' | 'down';
	/** chooseDesignation: sets `chosenColor`, `chosenSubType`, or `chosenCardName` on source permanent. */
	chooseKind?: 'color' | 'creatureType' | 'cardName' | 'nonlandCardName';
	/** grantGraveyardCast: grants temporary casting permission (or flashback) to card(s) in graveyard. */
	graveyardCastSpec?: GraveyardCastGrantSpec;
	/** ventureIntoDungeon (CR 701.49): `'dungeon'` (standard 3 dungeons) or `'undercity'` (CR 701.49d). */
	dungeonKind?: 'dungeon' | 'undercity';
	/** villainousChoice (CR 701.55): two opponent-chosen branches and prompt labels. */
	villainousOptions?: [EffectStep[], EffectStep[]];
	villainousOptionLabels?: [string, string];
	/** vote (CR 701.38): council vote options, extra votes for actor, and outcome effects. */
	voteSpec?: VoteSpec;
	/** move to library bottom: shuffle the moved cards into a random order on the bottom. */
	randomOrder?: boolean;
	/** reveal: look at top library cards / target player's hand (visible only to `actor`). */
	lookOnly?: boolean;
	/** grantPlayer: number of additional lands `actor` may play this turn. */
	extraLandPlays?: number;
	/** grant: allows creature(s) to attack this turn as though they didn't have defender. */
	canAttackNoDefender?: boolean;
	// --- End Track P13 ---
	// --- Track P18b ---
	/** meld (CR 701.42 / CR 713): partner front-card name and melded back-face result name. */
	meldPartnerName?: string;
	meldResultName?: string;
	meldTappedAndAttacking?: boolean;
	meldPartnerMustAttack?: boolean;
	/** move to battlefield (CR 710): "return ~ to the battlefield flipped" (e.g. Homura, Human Ascendant). */
	enteredFlipped?: boolean;
	// --- End Track P18b ---
	// --- Track P16a ---
	/** grantPlayer: filter restricting `nextSpellFlash` / `nextSpellCantBeCountered` (types / notTypes). */
	nextSpellFilter?: { types?: string[]; notTypes?: string[] };
	/** putCounters: multiple counter kinds placed together ("a flying counter and a +1/+1 counter"). */
	multiCounters?: Array<{ counter: CounterType; count: Amount }>;
	/** moveCounters (CR 122.5): generalized source/counter/count specification. */
	moveCounterSpec?: {
		from: Selector;
		counter: CounterType | 'any';
		all?: boolean;
		upTo?: boolean;
	};
	/** putCounters (CR 122.8–9): copy all live or LKI counters from `copyCountersFrom` onto `subject`. */
	copyCountersFrom?: Selector;
	/** putPlayerCounters: counter kind placed on player(s). */
	playerCounter?: 'poison' | 'experience' | 'energy' | 'rad' | 'ticket';
	/** pileSplit (CR 700.3): Fact-or-Fiction / Steam-Augury pile-making and pile-choosing spec. */
	pileSplit?: PileSplitSpec;
	/** castFree (CR 707.12): copy-card and/or free-cast spec. */
	castFreeSpec?: CastFreeSpec;
	/** bounce / exile / move: choose `choiceCount` (or up to `choiceCount`) matching objects instead of all. */
	choiceCount?: Amount;
	/** exile / move: filter applied to bound or candidate objects before choosing/moving. */
	moveFilter?: ObjectFilter;
	/** exile: counters placed on each card exiled this way (e.g. time / silver / page counters). */
	exileWithCounters?: { counter: CounterType; count: number };
	/** addMana: choose between one of `manaOrChosenColor` or one mana of `source.chosenColor` (Thriving/Gate lands). */
	manaOrChosenColor?: ManaColor[];
	/** grant: controller chooses one keyword from `chooseKeywordOptions` on resolution. */
	chooseKeywordOptions?: string[];
	/** grant: controller chooses a color on resolution and grants `protection from <color>`. */
	chooseProtectionColor?: boolean;
	/** animate: controller chooses a creature subtype on resolution. */
	chooseCreatureType?: boolean;
	/** animate: controller chooses a basic land subtype on resolution. */
	chooseBasicLandType?: boolean;
	/** combat flags applied until end of turn. */
	mustAttackThisTurn?: boolean;
	mustBeBlockedThisTurn?: boolean;
	mustBlockThisTurn?: boolean;
	mustBlockSelfThisTurn?: boolean;
	cantBlockSelfThisTurn?: boolean;
	assignsNoCombatDamageThisTurn?: boolean;
	/** grant / animate (CR 613.1f): affected permanent(s) lose all abilities in Layer 6 for the duration. */
	removeAllAbilities?: boolean;
	// --- End Track P16a ---
	// --- Track P21 ---
	/** Bespoke Wave 7 / override effect tag executed by `runtime/framesWave7.ts`. */
	wave7Effect?:
		| 'spellweaverVolute'
		| 'spaceSectorLock'
		| 'spaceSectorCounters'
		| 'spaceSectorDestroy'
		| 'necromancyFlashCleanup'
		| 'sacrificeSelfCleanup'
		| 'timetwister';
	// --- End Track P21 ---
	// --- Track P19a ---
	/** CR 115.7: Stack target redirection specification (`changeSingleTarget` vs `chooseNewTargets`). */
	redirectSpec?: RedirectTargetsSpec;
	/** CR 406 / 608.2: Exile cards from top of library until a card matches `filter`. */
	exileUntilSpec?: ExileUntilSpec;
	/** CR 605.1b / 605.4a: Until-end-of-turn delayed tap-for-mana trigger specification (High Tide, Bubbling Muck). */
	delayedTapManaSpec?: {
		who: 'any' | 'you';
		landSubtype?: string;
		mana: ManaColor[];
		recipient: 'tappingPlayer' | 'controller';
	};
	/** CR 603.7 / 707.10: Delayed trigger copying the next matching spell cast this turn. */
	delayedNextSpellCopySpec?: {
		types?: string[];
		notTypes?: string[];
		colors?: ManaColor[];
		copyCount: number;
		mayChooseNewTargets: boolean;
	};
	/** animate / grant: controller chooses 1 color (`'single'`) or 1+ colors (`'oneOrMore'`) on resolution ("becomes the color [or colors] of your choice"). */
	chooseColorForAnimate?: 'single' | 'oneOrMore';
	/** grant: controller chooses one keyword from `chooseLoseKeywordOptions` to remove until `duration` (Walking Sponge). */
	chooseLoseKeywordOptions?: string[];
	/** pump: controller chooses one `(+dp, +dt)` pair on resolution ("~ gets +1/-1 or -1/+1 until end of turn"). */
	pumpChoices?: Array<{ power: number; toughness: number }>;
	/** damage: CR 120.10 excess damage is dealt to that permanent's controller instead ("Excess damage is dealt to that creature's controller instead"). */
	excessDamageToController?: boolean;
	/** revealAndDiscard: discard ALL cards in revealed hand matching sacrificed cost creature's colors. */
	discardAllMatchingSacrificedColors?: boolean;
	/** revealAndDiscard: discard ALL cards in revealed hand matching `chosenCardName` ("discards all cards with that name"). */
	discardAllWithChosenName?: boolean;
	/** revealAndDiscard: number of cards revealed from hand when partial ("reveals N cards from their hand"), or `'randomOne'`. */
	partialRevealCount?: Amount | 'randomOne';
	/** revealAndDiscard: number of cards `chooser` selects from the revealed cards (default 1). */
	coerciveCount?: Amount;
	/** revealAndDiscard: also include target player's graveyard as candidate pool ("from that player's graveyard or hand and exile it"). */
	includeGraveyardInCoercive?: boolean;
	/** move to battlefield: enters as an Enchantment only (loses Creature/other types, e.g. Enduring Vitality "It's an enchantment"). */
	asEnchantmentOnly?: boolean;
	/** move to battlefield: enters tapped and attacking (CR 508.4, e.g. Winota / Squee). */
	entersTappedAndAttacking?: boolean;
	/** createToken: dynamic power and toughness amounts ("Create an X/X green Spirit creature token"). */
	dynamicTokenPT?: { power: Amount; toughness: Amount };
	/** counterSpell: dynamic generic mana tax ("unless its controller pays {1} for each ... / pays {X}"). */
	unlessPaysGenericAmount?: Amount;
	/** grantPlayer: CR 609.4b spend mana as though any color to cast spells from top of library this turn. */
	spendManaAsAnyColorTopOfLibraryThisTurn?: boolean;
	/** setLife: sets player(s)' life total to `amount` (CR 119.5: gains or loses the necessary life, e.g. Magister Sphinx). */
	setLifeTotal?: boolean;
	// --- End Track P19a ---
}

// --- Track P19a ---
export interface RedirectTargetsSpec {
	mode: 'changeSingleTarget' | 'chooseNewTargets';
	forceTargetSelf?: boolean;
}

export interface ExileUntilSpec {
	filter: ObjectFilter;
	libraryOwner?: Selector;
	hitAction:
		| 'playThisTurn'
		| 'playUntilEndOfNextTurn'
		| 'castFree'
		| 'hand'
		| 'battlefield'
		| 'battlefieldOrHand'
		| 'none';
	castFreeCondition?: Condition;
	fallbackToHand?: boolean;
	spendManaAsAnyColor?: boolean;
	spellsOnly?: boolean;
	restDestination: 'libraryBottomRandom' | 'graveyard' | 'stayExiled';
}
// --- End Track P19a ---

// --- Track P16a ---
export interface PileSplitSpec {
	reveal?: boolean;
	pileMaker: 'you' | 'opponent';
	pileChooser: 'you' | 'opponent';
	chosenTo: 'hand' | 'battlefield';
	otherTo: 'graveyard' | 'libraryBottom' | 'exile';
	otherRandomOrder?: boolean;
}

export interface CastFreeSpec {
	copyCardFirst?: boolean;
	withoutPayingManaCost: boolean;
	filter?: ObjectFilter;
	upToCount?: number;
	exileIfPutIntoGraveyard?: boolean;
}
// --- End Track P16a ---

// --- Track P13 ---
export type RoleTokenKind =
	| 'cursed'
	| 'monster'
	| 'royal'
	| 'sorcerer'
	| 'virtuous'
	| 'wicked'
	| 'young_hero';

export type DungeonId = 'lost_mine' | 'mad_mage' | 'tomb' | 'undercity';

export interface DoubleOrTripleSpec {
	factor: 2 | 3;
	target: 'power' | 'toughness' | 'pt' | 'counters' | 'life';
	counter?: CounterType | 'each';
	duration?: Duration;
}

export interface ExchangeSpec {
	kind: 'control' | 'lifeTotals' | 'lifeAndPower' | 'lifeAndToughness';
	second?: Selector;
}

export interface GraveyardCastGrantSpec {
	duration: 'thisTurn' | 'untilEndOfYourNextTurn';
	flashbackEqualManaCost?: boolean;
	alternativeManaCost?: string;
	withoutPayingManaCost?: boolean;
	exileIfWouldEnterGraveyard?: boolean;
}

export interface VoteSpec {
	options: string[];
	extraVotesForActor?: number;
	/** Effects executed once per vote cast for `options[i]`. */
	perOptionEffect?: EffectStep[][];
	/** Effects executed if `options[i]` gets the most votes or is tied for most votes. */
	perWinningEffect?: EffectStep[][];
}
// --- End Track P13 ---

// --- Track P10 ---
export interface ReflexiveTriggerSpec {
	targets: TargetSpec[];
	effect: EffectStep[];
	modal?: ModalDef;
	text?: string;
	eventFilter?:
		| 'whenYouDo'
		| 'sacrificedThisWay'
		| 'diedThisWay'
		| 'discardedThisWay'
		| 'exiledThisWay'
		| 'removedCounterThisWay';
	objectFilter?: ObjectFilter;
}

export interface DieRollBranch {
	min: number;
	max: number;
	effect: EffectStep[];
}
// --- End Track P10 ---

export interface CoerciveDiscardSpec {
	chooser: PlayerRef;
	filter?: ObjectFilter;
	optionalChoice?: boolean;
	destination: 'graveyard' | 'exile';
}

export interface TokenSpec {
	name: string;
	power: number;
	toughness: number;
	colors: ManaColor[];
	typeLine: string;
	keywords: string[];
	tapped?: boolean;
	// --- Track P10 ---
	quotedAbilities?: string[];
	// --- End Track P10 ---
}

export interface SearchSpec {
	filter: ObjectFilter;
	count: number;
	upTo: boolean;
	/** False only for unrestricted "a card" tutors (CR 701.19b: must find one if possible). */
	statedQuality: boolean;
	destinations: Array<{
		zone: 'battlefield' | 'hand' | 'library' | 'exile' | 'graveyard';
		tapped?: boolean;
		onTop?: boolean;
	}>;
	/** True when the searched card must be revealed (CR 702.29e / CR 701.19a). */
	reveal?: boolean;
	/** The searched-for phrase as printed ("a basic land card"), for prompts. */
	description?: string;
	// --- Track P10 ---
	/** Zones searched when broader than library alone ("Search your library and/or graveyard..."). */
	zones?: Array<'library' | 'graveyard' | 'hand'>;
	/** "with different names": found cards must have pairwise distinct names. */
	differentNames?: boolean;
	/** "If you search your library this way, shuffle": only shuffles library when >= 1 card was taken from library or library was searched. */
	shuffleOnlyIfLibrary?: boolean;
	/** Searches target player's / opponent's library instead of `actor`'s library ("Search target opponent's library..."). */
	searchedPlayer?: PlayerRef;
	// --- End Track P10 ---
}

export type Selector =
	| { k: 'self' }
	| { k: 'binding'; name: BindingName }
	| { k: 'target'; index: number }
	| { k: 'all'; filter: ObjectFilter }
	| { k: 'player'; filter: PlayerFilter }
	| { k: 'playerRef'; ref: PlayerRef }
	/** The object the trigger was about ("that creature" in a trigger). */
	| { k: 'eventObject' }
	/** The object this permanent is attached to, or the object an Equipment/Aura attaches to. */
	| { k: 'attachedTo' }
	/** Top N cards (`amount`) of a player's library (default: controller / `you`). */
	| { k: 'libraryTop'; player?: PlayerRef }
	/** Not an object: verbs such as proliferate, extraTurn or win act on the game. */
	| { k: 'none' };

// ---- Triggers -------------------------------------------------------------------------------

export type EventKind =
	| 'zoneChange'
	| 'cast'
	| 'attacks'
	| 'blocks'
	| 'dealsDamage'
	| 'phaseBegin'
	| 'counterPlaced'
	| 'becomesTarget'
	| 'attached'
	| 'becomesBlocked'
	| 'becomesTapped'
	| 'dealtDamage'
	| 'drawCard'
	| 'gainLife'
	/** A permanent was tapped for mana ("Whenever you tap a land for mana"); CR 605.1b. */
	| 'tappedForMana'
	/** A card was discarded to pay a cycling or typecycling activation cost (CR 702.29c, 702.29f). */
	| 'cycle'
	/** A card was discarded from a player's hand, including via cycling (CR 701.9, 702.29d). */
	| 'discard'
	/** A double-faced permanent transformed on the battlefield (CR 701.27). */
	| 'transforms'
	/** A face-down permanent was turned face up on the battlefield (CR 708.8). */
	| 'turnFaceUp'
	| 'investigate'
	| 'surveil'
	| 'explore'
	| 'connive'
	| 'becomesCrewed'
	/** CR 603.2c / 510.2: One or more creatures dealt combat damage to a player simultaneously. */
	| 'combatDamageBatchPlayer'
	// --- Track P1 ---
	| 'becameMonarch'
	// --- Track P3 ---
	| 'foretell'
	| 'plot'
	| 'becomesSaddled'
	// --- Track P4 ---
	| 'exert'
	// --- Track P5 ---
	| 'amass'
	| 'manifestDread'
	| 'becameMonstrous'
	// --- Track P6 ---
	| 'counterRemoved'
	// --- Track P9 ---
	/** CR 702.25a: "Whenever ~ becomes blocked by a creature without flanking" (fires once per blocker; eventObject = blocker). */
	| 'becomesBlockedBy'
	// --- Track P10 ---
	/** CR 509.1h / 509.3g: "Whenever ~ / a creature you control attacks and isn't blocked". */
	| 'attackedAndUnblocked'
	/** CR 603.2e: "Whenever ~ becomes untapped". */
	| 'becomesUntapped'
	/** CR 701.22: "Whenever you scry". */
	| 'scry'
	/** CR 700.13: "Whenever you commit a crime". */
	| 'committedCrime'
	/** CR 702.110b: "When ~ / a creature you control exploits a creature". */
	| 'exploited'
	/** CR 700.14: "Whenever you expend N". */
	| 'expended'
	/** CR 701.21: "Whenever you / a player sacrifices a [filter]". */
	| 'sacrificed'
	/** CR 700.1 / 509.3b,d: "Whenever ~ blocks or becomes blocked by a [filter]". */
	| 'blocksOrBecomesBlocked'
	/** CR 603.10a: "Whenever one or more [filter] cards leave your graveyard". */
	| 'graveyardLeaveBatch'
	/** CR 701.57: "Whenever you discover" / CR 701.61: "Whenever you forage". */
	| 'discover'
	| 'forage'
	// --- End Track P10 ---
	// --- Track P12 ---
	/** CR 717.3b: "When ~ becomes level N" on a Class enchantment. */
	| 'classLevelGained'
	/** CR 720.2b / 702.169c: "Whenever you solve a Case" when a Case becomes solved. */
	| 'caseSolved'
	/** CR 702.112b: "When ~ becomes renowned" when a creature becomes renowned. */
	| 'becameRenowned'
	// --- End Track P12 ---
	// --- Track P13 & P15 ---
	/** CR 709.5h: "When you unlock this door" / "Whenever you unlock a door of a Room you control". */
	| 'doorUnlocked'
	/** CR 709.5i (Eerie): "Whenever you fully unlock a Room". */
	| 'roomFullyUnlocked'
	/** CR 701.54: "Whenever the Ring tempts you". */
	| 'ringTempted'
	/** CR 309.4c / 701.49: "Whenever you venture into the dungeon" (room entered). */
	| 'dungeonRoomEntered'
	/** CR 309.7: "Whenever you complete a dungeon". */
	| 'dungeonCompleted'
	/** CR 727.2: "Whenever you take the initiative". */
	| 'tookInitiative'
	// --- End Track P13 & P15 ---
	// --- Wave 6 Shared ---
	/** CR 702.140d: "Whenever this creature mutates". */
	| 'mutates'
	/** CR 702.95a: Soulbond pairing trigger. */
	| 'soulbondPaired'
	/** CR 702.55c: "When the creature ~ haunts dies". */
	| 'hauntedCreatureDies'
	// --- End Wave 6 Shared ---
	// --- Track P16b ---
	/** CR 603.8: State-triggered ability checked during state-based actions. */
	| 'stateTriggered'
	/** CR 732: Game-wide day/night designation changed. */
	| 'dayNightChanged'
	/** CR 701.55: A player faced a villainous choice / dilemma. */
	| 'facedDilemma'
	/** CR 119.4 / 120.3a: A player lost life. */
	| 'loseLife'
	/** CR 702.177a: A player activated an exhaust ability. */
	| 'exhaustActivated'
	/** CR 701.3d: An Equipment/Aura/Fortification became unattached from a permanent. */
	| 'unattached'
	/** CR 702.26: A phased-out permanent phased in. */
	| 'phasedIn'
	/** CR 701.59: A player collected evidence. */
	| 'collectEvidence'
	/** CR 305.1: A player played a land. */
	| 'landPlayed'
	// --- End Track P16b ---
	// --- Track P19b ---
	/** CR 605.1b: A land's mana ability caused a player to add mana (e.g. Caged Sun). */
	| 'manaAddedByLandAbility'
	/** CR 701.19: A player searched their library (e.g. Archivist of Oghma). */
	| 'librarySearched'
	/** CR 104.3: A player lost the game (e.g. Blood Tyrant, Ramses). */
	| 'playerLostGame'
	/** CR 705: A player flipped one or more coins. */
	| 'coinFlipped'
	/** CR 706: A player rolled one or more dice. */
	| 'dieRolled'
	/** CR 122.1e: A player got one or more {E} (energy counters). */
	| 'energyGained'
	/** CR 701.27: A player proliferated. */
	| 'proliferated'
	/** CR 702.100: A permanent evolved. */
	| 'evolved'
	/** CR 702.122c: A creature crewed a Vehicle. */
	| 'crewedVehicle';
	// --- End Track P19b ---

export interface EventFilter {
	/**
	 * The object the event is about; 'self' is the source of the trigger, 'attachedTo' the object it
	 * is attached to ("Whenever equipped creature attacks").
	 */
	object?: ObjectFilter | 'self' | 'attachedTo';
	/** Also matches the source itself ("Whenever ~ or another Elf enters"). */
	orSelf?: boolean;
	from?: ZoneType;
	to?: ZoneType;
	/** The player who acted (caster, attacking player, ...). */
	player?: PlayerFilter;
	phase?: GamePhase;
	combat?: boolean;
	damageTo?: 'player' | 'playerOrPlaneswalker' | 'creature' | 'any';
	/** cast: also triggers when the spell is copied ("Whenever you cast or copy ..."). */
	orCopy?: boolean;
	counter?: CounterType;
	/** "Whenever one or more ... attack": triggers once per event batch. */
	oneOrMore?: boolean;
	/** becomesTarget: what kind of object targeted it ("of a spell", "of a spell or ability"). */
	targetedBy?: 'spell' | 'ability' | 'spellOrAbility';
	/** attached: what the object became attached to ("becomes attached to a creature you control"). */
	host?: ObjectFilter;
	/** "Whenever a creature you control attacks alone": matches only when 1 attacker is declared (CR 702.83b). */
	alone?: boolean;
	/** transforms: optional filter on the new face after transforming ("transforms into an Eldrazi"). */
	toFaceFilter?: ObjectFilter;
	/** "Whenever you draw your second card each turn" / "cast your second spell each turn": 1-based ordinal. */
	nthThisTurn?: number;
	// --- Track P2 ---
	/** Characteristics required of the permanent `source` is/was attached to ("When enchanted creature dies", CR 603.10a). */
	attachedFilter?: ObjectFilter;
	/** cast: spell on the stack targets `~` ("Whenever you cast a spell that targets ~", CR 603.2, 707.10). */
	targetsSelf?: boolean;
	// --- End Track P2 ---
	// --- Track P3 ---
	/** "Whenever ~ attacks while saddled" (CR 702.171b). */
	saddled?: boolean;
	// --- Track P5 ---
	/** "Whenever you amass Orcs" (CR 701.47b–c): optional singular subtype constraint on amass triggers. */
	amassSubtype?: string;
	// --- Track P6 ---
	/** counterRemoved (CR 702.63a Vanishing): matches only when the last counter of that kind was removed. */
	lastCounter?: boolean;
	// --- Track P9 ---
	/** discard (CR 702.35a Madness): matches when the discarded card was exiled via its madness replacement effect. */
	madnessExiled?: boolean;
	/** becomesBlockedBy (CR 702.25a Flanking): matches only when the blocking creature does not have flanking. */
	withoutFlanking?: boolean;
	// --- Track P10 ---
	/** attacks: "Whenever you attack with N or more [filter]". */
	minAttackers?: number;
	/** zoneChange (dies): "Whenever a creature dealt damage by ~ this turn dies". */
	dealtDamageBySelfThisTurn?: boolean;
	/** phaseBegin: "At the beginning of the upkeep of enchanted [permanent]'s controller". */
	enchantedControllerUpkeep?: boolean;
	/** phaseBegin: "At the beginning of enchanted player's upkeep". */
	enchantedPlayerUpkeep?: boolean;
	/** expended (CR 700.14): mana threshold N ("Whenever you expend 4"). */
	expendThreshold?: number;
	/** dealsDamage: filter on target player ("to an opponent" vs "to a player"). */
	damagePlayerRelation?: 'opponent' | 'you' | 'any';
	// --- End Track P10 ---
	// --- Track P12 ---
	/** classLevelGained (CR 717.3b): target Class level N ("When ~ becomes level 2"). */
	classLevel?: number;
	/** attacks (CR 702.105a Dethrone): matches only when attacking the player with the most life or tied for most life. */
	dethroneMostLife?: boolean;
	/** attacks (CR 702.149a Training): matches only when at least one other attacking creature has greater power than self. */
	trainingGreaterAttacker?: boolean;
	// --- End Track P12 ---
	// --- Track P13 ---
	/** Valiant: "for the first time each turn" when targeted by a spell or ability you control. */
	firstTimeTargetedByYouThisTurn?: boolean;
	/** cast: "Whenever you cast a spell during an opponent's turn". */
	duringOpponentTurn?: boolean;
	/** cast: "Whenever you cast a spell from anywhere other than your hand". */
	castFromNotHand?: boolean;
	/** cast: "Whenever you cast a spell from your graveyard / from exile". */
	castFromZone?: ZoneType;
	/** cast: "Whenever you cast a kicked spell". */
	wasKicked?: boolean;
	/** blocks: optional filter on the blocked attacker ("Whenever ~ blocks a [filter]"). */
	blockedAttackerFilter?: ObjectFilter;
	/** doorUnlocked (CR 709.5h): 0-based Room face index when the ability says "When you unlock this door". */
	thisDoorFaceIndex?: number;
	// --- End Track P13 ---
	// --- Track P16b ---
	/** CR 603.6c: zoneChange to graveyard from any zone (including battlefield). */
	fromAnywhere?: boolean;
	/** zoneChange: excludes moves originating from this zone ("from anywhere other than the battlefield / your hand"). */
	notFromZone?: ZoneType;
	/** zoneChange (ETB): requires the entering permanent to enter untapped. */
	entersUntapped?: boolean;
	/** CR 603.8: condition checked for a state-triggered ability. */
	stateCondition?: Condition;
	/** discard: requires the discard to have been caused by a spell or ability an opponent controls. */
	causedByOpponent?: boolean;
	/** Timing qualifier on event: during controller's turn ('your'), opponent's turn ('opponent'), or the acting event-player's turn ('eventPlayer'). */
	duringTurn?: 'your' | 'opponent' | 'eventPlayer';
	/** Ordinal filter for matching spells cast by that player this turn (1 = first, 2 = second, 3 = third, -1 = other than first). */
	spellOrdinal?: 1 | 2 | 3 | -1;
	/** counterPlaced: optional filter on who put the counter(s) ('you' | 'opponent' | 'any'). */
	putByPlayer?: 'you' | 'opponent' | 'any';
	/** becomesTarget: optional filter on the targeting spell or ability on the stack. */
	targetingSourceFilter?: ObjectFilter;
	/** becomesTarget: matches when a player ('you' | 'opponent' | 'any') becomes the target. */
	targetPlayer?: 'you' | 'opponent' | 'any';
	/** Compound self-or-attached subject ("Whenever ~ or equipped/enchanted creature ..."). */
	orAttachedToSelf?: boolean;
	/** attacks: filter on who is being attacked. */
	attackedTarget?:
		| 'you'
		| 'youOrPlaneswalkerYouControl'
		| 'opponent'
		| 'opponentOrPlaneswalkerOpponentControls'
		| 'enchantedPlayer'
		| 'planeswalker'
		| 'battle';
	/** attacks: requires at least `coAttackerMin` (default 1) other attacking creatures matching `coAttackerFilter`. */
	coAttackerFilter?: ObjectFilter;
	coAttackerMin?: number;
	/** dealsDamage / dealtDamage: requires noncombat damage (`!ev.combat`). */
	noncombatOnly?: boolean;
	/** dealsDamage: widens `damageTo` to include Battles ('playerOrBattle') or Planeswalkers ('planeswalker'). */
	damageTargetKind?: 'any' | 'battle' | 'playerOrBattle' | 'planeswalker' | 'permanent';
	/** dealtDamage: matches when a player ('you' | 'opponent' | 'any') is dealt damage. */
	damagedPlayer?: 'you' | 'opponent' | 'any';
	/** dayNightChanged: transition direction ('any' | 'dayNightFlip' | 'toDay' | 'toNight'). */
	dayNightDirection?: 'any' | 'dayNightFlip' | 'toDay' | 'toNight';
	/** phaseBegin: matches only on first upkeep or monarch's turn. */
	phaseTurnFilter?: 'firstOfGame' | 'yourFirstUpkeep' | 'monarch';
	// --- End Track P16b ---
	// --- Track P19b ---
	/** tappedForMana / manaAddedByLandAbility: specific mana symbol produced ("for {C}"). */
	tappedManaColor?: ManaColor;
	/** tappedForMana / manaAddedByLandAbility: requires mana of `source.chosenColor` ("for mana of the chosen color"). */
	tappedManaChosenColor?: boolean;
	/** attacks (CR 508.3e): fires once per attacked defending player ("Whenever you attack a player"). */
	perAttackedPlayer?: boolean;
	/** counterPlaced: threshold crossing `prev < N && next >= N` on `self` ("When the fourth plan counter is put on ~"). */
	nthCounterOnSelf?: number;
	/** Event ordinal per turn (1 for "for the first time each turn", N for "for the Nth time each turn"). */
	firstTimeEachTurn?: boolean;
	nthEventThisTurn?: number;
	/** zoneChange: step restriction ("When ~ enters during the declare attackers step"). */
	duringStep?: GamePhase;
	/** zoneChange: combat phase restriction ("When ~ dies during combat"). */
	duringCombat?: boolean;
	/** becomesTapped: player whose spell/ability/cost caused the tap ("Whenever you tap an untapped creature an opponent controls"). */
	tappedByPlayer?: 'you' | 'opponent' | 'any';
	/** dieRolled: minimum result threshold ("Whenever you roll a 10 or higher on a die"). */
	dieRollMin?: number;
	/** dieRolled: exact result set ("Whenever you roll a 1 or 2"). */
	dieRollValues?: number[];
	/** coinFlipped: requires winning at least one flip ("Whenever you win a coin flip"). */
	wonCoinFlip?: boolean;
	/** dealsDamage: filter on damaged permanent ("Whenever ~ deals damage to a Dinosaur"). */
	damageTargetFilter?: ObjectFilter;
	/** dealsDamage: requires damaged player to be `source.attachedToId` ("Whenever a creature deals combat damage to enchanted player"). */
	damageTargetEnchantedPlayer?: boolean;
	// --- End Track P19b ---
}

export interface TriggerDef {
	event: EventKind;
	filter: EventFilter;
	scope?: TriggerScope;
	/** The trigger functions while its source is in this zone (Nether Shadow: graveyard; Cycling: any). */
	fromZone?: ZoneType | 'any';
	/** CR 603.2i: "This ability triggers only once each turn." */
	onlyOncePerTurn?: boolean;
	/** "Whenever ~ enters or attacks": the ability also triggers on each of these events. */
	or?: TriggerDef[];
	// --- Track P1 ---
	chapterNumbers?: number[];
	isChapterAbility?: boolean;
	// --- Wave 6 Shared ---
	/** CR 603.2h: "Do this only once each turn." */
	doThisOncePerTurn?: boolean;
	/** CR 603.8: State-triggered ability (won't trigger again while already on the stack). */
	isStateTrigger?: boolean;
	// --- End Wave 6 Shared ---
	// --- Track P19b ---
	/** CR 603.7a: Event-driven delayed trigger created by a resolving Instant or Sorcery spell. */
	spellDelayed?: 'nextThisTurn' | 'thisTurn' | 'nextUpkeep';
	// --- End Track P19b ---
}

export type Condition =
	| { k: 'compare'; left: Amount; op: '>=' | '<=' | '=' | '>' | '<'; right: Amount }
	| { k: 'and' | 'or'; of: Condition[] }
	| { k: 'not'; of: Condition }
	/** CR 404.2: the graveyard's order matters. */
	| { k: 'graveyardAbove'; filter: ObjectFilter; count: number }
	| { k: 'isTurnOf'; player: PlayerRef }
	/** CR 903.3d: "if you control a commander" (a permanent on the battlefield that is a commander). */
	| { k: 'controlCommander' }
	/** CR 702.33d–f: true when kicked at least `minCount` (default 1) times, optionally with `tag`. */
	| { k: 'kicked'; tag?: string; minCount?: number }
	/** CR 702.74a / 400.7d: true when cast by paying its evoke alternative cost. */
	| { k: 'evoked' }
	/** CR 702.138b / 400.7d: true when cast by paying its escape alternative cost. */
	| { k: 'escaped' }
	// --- Track P1 ---
	| { k: 'isMonarch'; player?: PlayerRef; relation?: 'you' | 'opponent' | 'any' }
	// --- Track P3 ---
	/** CR 702.143d / 400.7d: true when cast by paying its foretell alternative cost. */
	| { k: 'foretold' }
	/** CR 702.171b: true when this permanent became saddled this turn. */
	| { k: 'saddled' }
	/** CR 702.152a / 400.7d: true when cast by paying its blitz alternative cost. */
	| { k: 'blitzed' }
	// --- Track P4 ---
	/** CR 701.43: true when this permanent has been exerted this turn. */
	| { k: 'exertedThisTurn' }
	// --- Track P5 ---
	/** CR 701.37b: true when this permanent is monstrous. */
	| { k: 'monstrous' }
	/** CR 702.100a: entering creature's power > self's power OR entering creature's toughness > self's toughness. */
	| { k: 'evolveCompare' }
	/** Checks whether `target` (or event/bound object) matches `filter` (e.g. Chaos Warp "if it's a permanent card"). */
	// --- Track P16a: added optional `any` for multi-card bindings ("if a land card was milled this way") ---
	| { k: 'matchesFilter'; target?: Ref; filter: ObjectFilter; any?: boolean }
	// --- Track P7 ---
	/** Morbid: true when at least one creature died (battlefield -> graveyard) this turn. */
	| { k: 'creatureDiedThisTurn' }
	/** Raid (CR 508.1k / 508.4): true when controller declared at least one attacker this turn. */
	| { k: 'attackedThisTurn' }
	/** Revolt: true when a permanent controlled by controller left the battlefield this turn. */
	| { k: 'permanentLeftBattlefieldThisTurn' }
	/** True when controller gained at least `min` (default 1) life this turn. */
	| { k: 'gainedLifeThisTurn'; min?: Amount }
	/** True on an ETB trigger when the entering permanent resolved from a cast spell (optionally specifically from hand). */
	| { k: 'wasCast'; fromHand?: boolean }
	// --- Track P8 ---
	/** Evaluates whether `'self'` or `'attachedTo'` satisfies state/attachment/filter predicates. */
	| {
			k: 'objectState';
			of: 'self' | 'attachedTo';
			tapped?: boolean;
			attacking?: boolean;
			blocking?: boolean;
			monstrous?: boolean;
			saddled?: boolean;
			equipped?: boolean;
			enchanted?: boolean;
			filter?: ObjectFilter;
	  }
	/** Count of non-lost opponents ("unless you have two or more opponents"). */
	| { k: 'opponentCount'; op: '>=' | '<=' | '=' | '>' | '<'; count: number }
	/** True iff any non-lost player's life satisfies `op count` ("unless a player has 13 or less life"). */
	| { k: 'anyPlayerLife'; op: '>=' | '<=' | '=' | '>' | '<'; count: number }
	/** Coven — true iff you control >= `count` creatures with different powers. */
	| { k: 'distinctControlledCreaturePowers'; count: number }
	// --- Track P9 ---
	/** CR 702.30a Echo: true if this permanent entered or came under your control since your last upkeep began. */
	| { k: 'cameUnderControlSinceLastUpkeep' }
	/** CR 702.49a Ninjutsu: true during combat after blockers have been declared. */
	| { k: 'ninjutsuWindow' }
	/** CR 702.93a / 702.79a / 704.8: true if the dying permanent had zero `counter` counters in pre-SBA LKI. */
	| { k: 'lkiHasNoCounter'; counter: CounterType }
	// --- Track P10 ---
	/** True iff an opponent lost >= 1 life this turn (damage or life loss). */
	| { k: 'opponentLostLifeThisTurn' }
	/** CR 700.11 Descend: true iff a permanent card (nontoken) was put into controller's graveyard this turn. */
	| { k: 'descendedThisTurn' }
	/** LKI check on dying/leaving permanent: true iff it had >= 1 `counter` (or any counter for `'any'`) on it. */
	| { k: 'hadCounterOnIt'; counter: CounterType | 'any' }
	/** True iff mana of `color` (or at least `minTotal` mana if `color` is omitted) was spent to cast the spell/permanent. */
	| { k: 'manaColorSpentToCast'; color?: ManaColor; minTotal?: number }
	/** True iff an opponent controls more lands / creatures / has more life / has more cards in hand than you. */
	| {
			k: 'opponentComparison';
			metric: 'lands' | 'creatures' | 'life' | 'hand';
	  }
	// --- End Track P10 ---
	// --- Track P12 ---
	/** CR 717.3a: true iff this Class permanent's current level equals `level`. */
	| { k: 'classLevelIs'; level: number }
	/** CR 717.3a: true iff this Class permanent's current level is `>= level`. */
	| { k: 'classLevelAtLeast'; level: number }
	/** CR 720.2c: true iff this Case permanent is solved (`isSolved === true`). */
	| { k: 'caseSolved' }
	/** CR 720.2a / 702.169a: true iff this Case permanent is NOT yet solved (`!isSolved`). */
	| { k: 'caseUnsolved' }
	/** CR 702.112b: true iff this permanent has become renowned (`isRenowned === true`). */
	| { k: 'isRenowned' }
	/** CR 702.142a Boast: true iff this specific creature attacked this turn. */
	| { k: 'boastAttackedThisTurn' }
	/** CR 702.177a Exhaust: true iff `abilityId` has not yet been activated on this permanent. */
	| { k: 'exhaustUnused'; abilityId: string }
	/** CR 702.149a Training: true iff at least one other attacking creature has greater power than self. */
	| { k: 'trainingGreaterAttacker' }
	/** CR 702.105a Dethrone: true iff defending player has the most life or is tied for most life. */
	| { k: 'dethroneMostLife' }
	/** Case To-solve: true iff at least `min` creatures attacked this turn. */
	| { k: 'creaturesAttackedCountThisTurn'; min: number }
	/** Case To-solve: true iff creatures you control have total power >= `min`. */
	| { k: 'totalPowerControlled'; min: number }
	/** Case To-solve: true iff there are >= `min` distinct colors among permanents you control. */
	| { k: 'colorsAmongControlledPermanents'; min: number }
	/** Case To-solve: true iff >= `min` sources you controlled dealt damage this turn. */
	| { k: 'sourcesDealtDamageThisTurn'; min: number }
	/** Case To-solve: true iff >= `min` matching cards were put into (your/any) graveyards from anywhere this turn. */
	| {
			k: 'cardsPutIntoGraveyardFromAnywhereThisTurn';
			min: number;
			filter?: ObjectFilter;
			whose?: 'you' | 'any';
	  }
	/** Case To-solve: true iff you have cast >= `min` matching spells this turn. */
	| { k: 'spellsCastThisTurnCount'; min: number; filter?: ObjectFilter }
	// --- End Track P12 ---
	// --- Track P13 ---
	/** True iff the source card is currently in `zone` (e.g. "if ~ is in your graveyard"). */
	| { k: 'selfInZone'; zone: ZoneType }
	/** True iff last turn's spell count satisfies `mode` ("if no spells were cast last turn" / "if a player cast two or more spells last turn"). */
	| { k: 'spellsCastLastTurn'; mode: 'none' | 'singlePlayerAtLeast'; count: number }
	/** CR 309.7: true iff controller has completed at least one dungeon this game. */
	| { k: 'hasCompletedDungeon' }
	/** CR 727: true iff controller currently has the initiative. */
	| { k: 'hasInitiative' }
	/** CR 702.131c Ascend: true iff controller has the city's blessing. */
	| { k: 'hasCitysBlessing' }
	/** CR 702.179 Max speed: true iff controller's speed is >= 4. */
	| { k: 'hasMaxSpeed' }
	/** Corrupted: true iff at least one opponent has >= `min` poison counters. */
	| { k: 'opponentPoisonAtLeast'; min: number }
	/** Celebration: true iff >= `min` nonland permanents entered the battlefield under your control this turn. */
	| { k: 'nonlandEnteredThisTurn'; min: number }
	/** Void: true iff a nonland permanent left the battlefield this turn or a spell was warped this turn. */
	| { k: 'voidThisTurn' }
	/** Adamant: true iff >= `min` mana of `color` (or of any single color when omitted) was spent to cast this spell. */
	| { k: 'sameColorManaSpentAtLeast'; min: number; color?: ManaColor }
	// --- End Track P13 ---
	// --- Track P14 ---
	/** True iff at least one non-lost opponent's life / hand size / graveyard size satisfies `op count`. */
	| {
			k: 'anyOpponentMetric';
			metric: 'life' | 'hand' | 'graveyard';
			op: '>=' | '<=' | '=' | '>' | '<';
			count: number;
	  }
	/** True iff controller has drawn >= `min` cards this turn. */
	| { k: 'cardsDrawnThisTurnAtLeast'; min: number }
	/** True while casting the `ordinal`-th (1st or 2nd) matching spell you cast this turn (`matchingCastCount === ordinal - 1`). */
	| { k: 'nthMatchingSpellThisTurn'; ordinal: 1 | 2; filter?: ObjectFilter }
	// --- End Track P14 ---
	// --- Track P15 ---
	/** CR 702.178a / 702.179e: true iff controller's speed is 4 (max speed). */
	| { k: 'maxSpeed' }
	/** CR 702.131c: true iff controller has the city's blessing. */
	| { k: 'citysBlessing' }
	/** CR 702.174b: true iff a Gift optional cost was promised for this spell/permanent. */
	| { k: 'giftPromised' }
	/** CR 732: true iff it is currently day (`state.dayNight === 'day'`). */
	| { k: 'isDay' }
	/** CR 732: true iff it is currently night (`state.dayNight === 'night'`). */
	| { k: 'isNight' }
	/** CR 702.161 Living metal: true iff it is currently the controller's turn. */
	| { k: 'isYourTurn' }
	/** CR 723: true iff this permanent is currently prepared (`Boolean(self.isPrepared)`). */
	| { k: 'selfPrepared' }
	/** CR 702.176a: true iff this permanent was cast for its impending cost and still has >= 1 time counter. */
	| { k: 'isImpending' }
	/** CR 702.156a Ravenous: true iff this permanent entered from a spell whose chosen X was >= `n`. */
	| { k: 'enteredWithXAtLeast'; n: number }
	// --- End Track P15 ---
	// --- Wave 6 Shared ---
	| { k: 'isPaired' }
	| { k: 'tributePaid' }
	| { k: 'hasEnduringStory' }
	| { k: 'isHarnessed' }
	// --- End Wave 6 Shared ---
	// --- Track P16b ---
	/** True iff attacking creatures you control have total power >= `min`. */
	| { k: 'attackingTotalPowerAtLeast'; min: number }
	/** True iff this is the first combat phase of the current turn. */
	| { k: 'firstCombatPhaseOfTurn' }
	/** True iff the event player's hand size satisfies `op count`. */
	| { k: 'eventPlayerHandCount'; op: '>=' | '<=' | '=' | '>' | '<'; count: number }
	/** True iff it is NOT the event player's turn. */
	| { k: 'notEventPlayerTurn' }
	/** True iff one or more cards left controller's graveyard this turn. */
	| { k: 'cardLeftYourGraveyardThisTurn' }
	/** CR 700.13: true iff controller committed a crime this turn. */
	| { k: 'committedCrimeThisTurn' }
	/** True iff the source permanent's controller is different from its owner. */
	| { k: 'controlledByOtherThanOwner' }
	/** True iff controller lost life this turn. */
	| { k: 'youLostLifeThisTurn' }
	/** True iff any player (or an opponent when `opponentOnly`) lost >= `min` life this turn. */
	| { k: 'playerLostLifeAtLeastThisTurn'; min: number; opponentOnly?: boolean }
	/** True iff controller has strictly more cards in hand than each non-lost opponent. */
	| { k: 'moreCardsInHandThanEachOpponent' }
	/** LKI check on dying/leaving eventObject ("if it was a Human"). */
	| { k: 'eventObjectMatchedLki'; filter: ObjectFilter }
	// --- End Track P16b ---
	// --- Track P17b ---
	| {
			k: 'p17bCondition';
			kind:
				| 'notStartingPlayer'
				| 'notYourTurn'
				| 'notSpellControllerTurn'
				| 'opponentGainedLifeThisTurn'
				| 'opponentCastSpellsAtLeast'
				| 'opponentControlsAtLeastNMore'
				| 'attackingCount'
				| 'attackingYouCount'
				| 'noMatchingCardsInHand'
				| 'onlyNamedOrNoMatchingInHand'
				| 'spellWasBargained'
				| 'abilityTargetsFilter'
				| 'targetsStackSpell'
				// --- Track P20b ---
				| 'altCostPaid'
				| 'additionalCostPaid';
			manaCost?: string;
				// --- End Track P20b ---
			filter?: ObjectFilter;
			n?: number;
			op?: '>=' | '==' | '<=';
	  }
	// --- End Track P17b ---
	// --- Track P18b ---
	/** CR 614.12c: true iff this permanent's chosen ETB anchor word matches `word` (case-insensitive). */
	| { k: 'anchorWordChosen'; word: string }
	/** CR 508.5: true iff at least one creature is currently attacking the controller directly. */
	| { k: 'youWereAttackedThisCombat' }
	// --- End Track P18b ---
	// --- Track P16a ---
	/** True iff `ref` (or the object acted on by the preceding step) moved to a graveyard from the battlefield. */
	| { k: 'diedThisWay'; ref?: Ref }
	// --- End Track P16a ---
	// --- Track P20a ---
	/** Compares `you` or `anyOpponent` life total against half the game's starting life total (`CR 107.1`). */
	| {
			k: 'lifeCompareHalfStarting';
			who: 'you' | 'anyOpponent';
			op: '<=' | '<' | '>=' | '>';
	  }
	/** True iff `color` is the most common color among permanents on the battlefield (or tied for most common when `allowTie`). */
	| {
			k: 'mostCommonColorAmongPermanents';
			color: ManaColor;
			allowTie: boolean;
	  }
	// --- End Track P20a ---
	// --- Track P19b ---
	/** "if a creature died under your control this turn". */
	| { k: 'creatureDiedUnderYourControlThisTurn' }
	/** "if mana from a Treasure was spent to cast it". */
	| { k: 'treasureManaSpentToCast' }
	/** "if you haven't cast a spell from your hand this turn". */
	| { k: 'noSpellCastFromHandThisTurn' }
	/** CR 702.62a: "if ~ is suspended" (in exile with `isSuspended` designation). */
	| { k: 'isSuspended' }
	/** CR 701.54a: "if you chose a creature other than ~ as your Ring-bearer". */
	| { k: 'choseOtherRingBearer' }
	/** "if N or more [filter] entered the battlefield under your control this turn". */
	| { k: 'enteredUnderYourControlThisTurn'; filter: ObjectFilter; min?: number }
	/** "if its surge / prowl / spectacle cost was paid". */
	| { k: 'paidAltCost'; kind: 'surge' | 'prowl' | 'spectacle' }
	/** "if it isn't being declared as an attacker" (e.g. Verity Circle). */
	| { k: 'notBeingDeclaredAsAttacker' }
	/** "if ~ dealt damage to an opponent this turn". */
	| { k: 'selfDealtDamageToOpponentThisTurn' }
	/** "if N or more damage was dealt to it this turn". */
	| { k: 'damageDealtToSelfThisTurnAtLeast'; min: number }
	/** "if that creature / permanent entered this turn". */
	| { k: 'eventObjectEnteredThisTurn' }
	/** "if ~ entered this turn". */
	| { k: 'selfEnteredThisTurn' }
	/** "if there are N or more mana values among cards in your graveyard". */
	| { k: 'distinctManaValuesInGraveyardAtLeast'; min: number }
	// --- End Track P19b ---
	// --- Track P20b ---
	| {
			k: 'p20bCondition';
			kind:
				| 'opponentHadPermEnteredThisTurn'
				| 'opponentCastSpellThisTurn'
				| 'opponentDrewCardsAtLeastThisTurn'
				| 'opponentCardsPutIntoGraveyardAtLeastThisTurn'
				| 'opponentSearchedLibraryThisTurn'
				| 'yourCreatureSpellCounteredByOpponentThisTurn'
				| 'yourNoncreatureDestroyedByOpponentThisTurn'
				| 'dealtDamageByCreaturesAtLeastThisTurn'
				| 'altCostPaid'
				| 'additionalCostPaid';
			filter?: ObjectFilter;
			min?: number;
			manaCost?: string;
	  }
	// --- End Track P20b ---
	// --- Track P19a ---
	/** True iff at least one player's graveyard has >= `min` cards ("If a graveyard has twenty or more cards in it"). */
	| { k: 'anyGraveyardAtLeast'; min: number }
	/** True iff `actor` controlled `targetIndex` when resolution began ("If you controlled that permanent"). */
	| { k: 'controlledTargetAtResolution'; targetIndex: number }
	/** True iff the resolving activated ability has been activated >= `min` times on its source permanent this turn ("If this ability has been activated four or more times this turn"). */
	| { k: 'abilityActivatedCountThisTurn'; min: number }
	// --- End Track P19a ---
	// --- Track P22a ---
	/** True iff `you` have at least `delta` life more than the game's starting life total (*Righteous Valkyrie*: `state.rules.startingLife + delta`). */
	| { k: 'lifeAtLeastAboveStarting'; delta: number }
	/** CR 506.5: true iff `'self'` or `'attachedTo'` is currently attacking alone (`combat.attackers.length === 1`). */
	| { k: 'isAttackingAlone'; of: 'self' | 'attachedTo' }
	/** True iff `'self'` or `'attachedTo'` has not dealt damage since entering the battlefield (*Karakyk Guardian*, *Palladia-Mors, the Ruiner*). */
	| { k: 'hasntDealtDamageYet'; of?: 'self' | 'attachedTo' }
	/** True iff `you` have begun at least `min` turns of your own (or when `onlyDuringYourTurn` is true and it's not your turn, *Serra Avenger*). */
	| { k: 'yourTurnsTakenAtLeast'; min: number; onlyDuringYourTurn?: boolean }
	/** True iff a permanent matching `filter` entered the battlefield under `you`r control this turn (*Mechan Shieldmate*, *Swordsworn Cavalier*). */
	| { k: 'enteredBattlefieldUnderYourControlThisTurn'; filter: ObjectFilter }
	// --- Track P22c ---
	/** True iff controller discarded one or more cards this turn (*Typhoid Mary, Fractured*). */
	| { k: 'youDiscardedThisTurn' };
	// --- End Track P22c ---
	// --- End Track P22a ---

// ---- Statics and replacements ---------------------------------------------------------------

export type Layer = '1' | '2' | '3' | '4' | '5' | '6' | '7a' | '7b' | '7c' | '7d';

export type LayerMod =
	| { k: 'setController'; controller: PlayerRef }
	| { k: 'pt'; power: Amount; toughness: Amount }
	| { k: 'setBasePT'; power: Amount; toughness: Amount }
	| {
			k: 'addKeywords';
			keywords: string[];
			// --- Track P14 ---
			/** CR 702.16n: "This effect doesn't remove ~ / Auras / Auras and Equipment you control". */
			protectionAttachmentExemption?:
				| 'self'
				| 'allAuras'
				| 'controlledAuras'
				| 'controlledAttachments';
			// --- End Track P14 ---
	  }
	| {
			k: 'removeAllAbilities';
			// --- Track P17a ---
			keepManaAbilities?: boolean;
			// --- End Track P17a ---
	  }
	| { k: 'addTypes'; types: string[]; subtypes?: string[] }
	| { k: 'setTypes'; types: string[]; subtypes?: string[] }
	| { k: 'switchPT' }
	/**
	 * Layer 4: replaces the subtypes of the appropriate kind ("Nonbasic lands are Mountains"). Per
	 * CR 305.7, setting a land's subtype to a basic land type also removes the abilities from its
	 * rules text; the layer engine applies that consequence, the IR doesn't spell it out.
	 */
	| { k: 'setSubtypes'; subtypes: string[] }
	/** Layer 4: "is every creature type" (CR 205.3m). */
	| { k: 'allCreatureTypes' }
	/** Layer 5. An empty list is colorless. */
	| { k: 'setColors'; colors: ManaColor[] }
	| { k: 'addColors'; colors: ManaColor[] }
	/** Layer 6: "lose flying"; `cantHaveOrGain` for "and can't have or gain flying". */
	| { k: 'removeKeywords'; keywords: string[]; cantHaveOrGain?: boolean }
	/** Layer 6: a quoted ability granted to the affected objects ('have "{T}: Add {C}."'). */
	| { k: 'grantAbility'; ability: AbilityDef }
	// --- Track P4 ---
	/** Layer 4: adds `source.chosenSubType` ("is the chosen type in addition to its other types", CR 205.3m). */
	| { k: 'addChosenSubtype' }
	/** Layer 5: sets color to `[source.chosenColor]` ("~ is the chosen color", CR 105.4). */
	| { k: 'setChosenColor' }
	/** Layer 6: grants protection from `source.chosenColor` ("has protection from the chosen color", CR 702.16). */
	| {
			k: 'protectionFromChosenColor';
			// --- Track P14 ---
			protectionAttachmentExemption?:
				| 'self'
				| 'allAuras'
				| 'controlledAuras'
				| 'controlledAttachments';
			// --- End Track P14 ---
	  }
	// --- Track P8 ---
	/** Layer 7a/7b single-axis base power setter ("~'s power is equal to ...", CR 208.2a, 613.4a). */
	| { k: 'setBasePower'; power: Amount }
	/** Layer 7a/7b single-axis base toughness setter ("~'s toughness is equal to ...", CR 208.2a, 613.4a). */
	| { k: 'setBaseToughness'; toughness: Amount }
	// --- Track P14 ---
	/** CR 613.1d, 205.1a, 700.5: Layer 4 type removal ("~ isn't a creature", "Enchanted permanent isn't a creature"). */
	| { k: 'removeTypes'; types: string[] }
	// --- End Track P14 ---
	// --- Track P17a ---
	/** CR 613.1e, 105.4: Layer 5 additive color from `source.chosenColor` ("is the chosen color in addition to its other colors"). */
	| { k: 'addChosenColor' }
	// --- End Track P17a ---
	// --- Track P20a ---
	/** CR 702.16j: Layer 6 grants protection from `source.chosenPlayerId` ("has protection from the chosen player"). */
	| { k: 'protectionFromChosenPlayer' }
	/** CR 305.7 / 613.1d: Layer 4 replaces land/creature subtypes with `[source.chosenSubType]` ("is the chosen type"). */
	| { k: 'setChosenSubtype' }
	// --- End Track P20a ---
	// --- Track P22a ---
	/** CR 702.16: Layer 6 grants protection from `source.chosenCardType` ("have protection from the chosen card type", *Serra's Emissary*). */
	| { k: 'protectionFromChosenCardType' };
	// --- End Track P22a ---

export interface CostDelta {
	/** 'setZero' makes the cost {0}; 'reduce'/'increase' change the generic component. */
	mode: 'setZero' | 'reduce' | 'increase';
	generic: number;
	/** The change is `generic` for each of this ("costs {1} less to cast for each creature on the battlefield"). */
	per?: Amount;
	/** Alias used by the static grammar ("costs {1} less for each creature on the battlefield"). */
	times?: Amount;
	/** Non-mana additional costs imposed by a cost-increasing static (e.g. Terror of the Peaks: pay 3 life). */
	additionalCosts?: CostDef[];
	// --- Track P11 ---
	/** CR 118.7b–f: colored/colorless mana reduction or increase per symbol. */
	colored?: Partial<Record<ManaColor, number>>;
	/** CR 118.7e: hybrid mana reduction symbols (e.g. {W/U} less to cast). */
	hybridColored?: Array<[ManaColor, ManaColor]>;
	/** CR 118.7b–c override: "This effect reduces only the amount of colored mana you pay." */
	coloredOnly?: boolean;
	/** Minimum total mana floor ("This effect can't reduce the mana in that cost to less than one mana"). */
	minTotalMana?: number;
	// --- End Track P11 ---
	// --- Track P17b ---
	/** Maximum generic/total mana reduction applied by this single costModifier ("can't reduce ... by more than {5}"). */
	maxReduction?: number;
	/** Per-target life payment added by a spell costModifier ("~ costs 3 life more to cast for each target"). */
	perTargetLife?: number;
	// --- End Track P17b ---
}

export type SpellOrAbilityFilter =
	// --- Track P17b: optional altCostKeyword ('flashback' | 'dash') on spell costModifier ---
	| { k: 'spell'; filter: ObjectFilter; altCostKeyword?: string }
	// --- Track P11 + Track P17b: widened ability filter for general & targeted activated abilities ---
	| {
			k: 'ability';
			keyword?: string;
			filter?: ObjectFilter;
			nonManaOnly?: boolean;
			loyaltyOnly?: boolean;
			sourceZone?: ZoneType;
			selfSourceOnly?: boolean;
			attachedSourceOnly?: boolean;
			targetsSelf?: boolean;
			targetsAttached?: boolean;
			targetsFilter?: ObjectFilter;
	  }
	// --- End Track P11 + Track P17b ---
	/** The spell that has this ability ("This spell costs {1} less to cast ..."); works while it's being cast. */
	| { k: 'self' };

export type RuleModKind =
	| 'noMaxHandSize'
	| 'cantLose'
	| 'opponentsCantWin'
	| 'castOnlySorcerySpeed'
	| 'oneSpellPerTurn'
	| 'castOnlyFromHand'
	| 'castAsThoughFlash'
	| 'attackTax'
	| 'playerHexproof'
	| 'searchControl'
	| 'playerShroud'
	| 'spendManaAsAnyColor'
	/** "During your turn, your opponents can't cast spells". */
	| 'opponentsCantCastDuringYourTurn'
	| 'lifeTotalCantChange'
	| 'extraLandPlays'
	| 'allOffBattlefieldAndSpellsColorless'
	// --- Track P7 ---
	| 'damageCantBePrevented'
	// --- Track P11 ---
	| 'cantGainLife'
	| 'maxHandSizeDelta'
	| 'setMaxHandSize'
	| 'skipDrawStep'
	| 'cantCastChosenName'
	// --- End Track P11 ---
	// --- Track P17a ---
	| 'blockTax'
	| 'filteredSpellCapPerTurn'
	| 'cantCastMatchingSpells'
	| 'cantDrawCards'
	| 'cantDrawExtraCards'
	| 'cantSearchLibraries'
	| 'cantPayLifeOrSacrificeForCosts'
	| 'legendRuleExempt'
	| 'flagbearer'
	| 'untapStepCap'
	// --- End Track P17a ---
	// --- Track P20a ---
	| 'graveyardCantBeTargeted'
	| 'dontLoseAtZeroOrLessLife'
	| 'damageToYouAsInfect'
	| 'allDamageHasWither'
	| 'skipExtraTurns'
	// --- End Track P20a ---
	// --- Track P22a ---
	| 'cantPlayLands'
	| 'cantCastDuringCombat'
	| 'castOnlyDuringOwnTurn'
	| 'activateOnlyDuringOwnTurn'
	| 'cantCastSameNameAsLinkedExile'
	| 'playerCantGetCounters'
	| 'immuneToOpponentForcedSacrifice'
	| 'immuneToOpponentForcedDiscard'
	| 'playerProtectionFromChosenCardType';
	// --- End Track P22a ---

export type RestrictionKind =
	| 'cantAttack'
	| 'cantBlock'
	| 'cantAttackOrBlock'
	| 'cantBeBlocked'
	| 'attacksEachCombat'
	| 'blocksEachCombat'
	| 'cantBeCountered'
	| 'doesntUntap'
	| 'cantCrewVehicles'
	// --- Track P3 ---
	| 'cantHaveCounters'
	// --- Track P17a ---
	| 'attacksOrBlocksEachCombat'
	| 'cantAttackYou'
	| 'cantAttackYouOrPlaneswalkers'
	// --- End Track P17a ---
	// --- Track P22c ---
	| 'cantBeCopied';
	// --- End Track P22c ---

// --- Track P8 ---
export type CombatRuleSpec =
	| { kind: 'cantBlockExcept'; filter: ObjectFilter }
	| { kind: 'additionalBlockCount'; count: number | 'unlimited' }
	| { kind: 'cantBeBlockedBy'; filter: ObjectFilter }
	| { kind: 'cantBeBlockedByPowerLessThanSelf' }
	| { kind: 'cantBeBlockedExceptBy'; filter: ObjectFilter; orFilter?: ObjectFilter }
	| { kind: 'maxBlockers'; max: number }
	| { kind: 'minBlockers'; min: number }
	| { kind: 'mustBeBlockedIfAble' }
	| { kind: 'allAbleBlockers' }
	| { kind: 'cantAttackUnlessDefenderControls'; filter: ObjectFilter }
	| { kind: 'cantAttackAlone' }
	| { kind: 'cantBlockAlone' }
	| { kind: 'globalMaxAttackers'; max: number; againstYouOnly?: boolean }
	| { kind: 'globalMaxBlockers'; max: number }
	// --- Track P14 ---
	/** CR 510.1c–d: "You may have [affected] assign its combat damage as though it weren't blocked." */
	| { kind: 'assignCombatDamageAsThoughUnblocked' }
	/** CR 508.1c, 702.3b: "[affected] can attack as though it didn't have defender." */
	| { kind: 'canAttackDespiteDefender' }
	/** "[affected] can't be blocked as long as defending player controls a [filter]." */
	| { kind: 'cantBeBlockedIfDefenderControls'; filter: ObjectFilter }
	/** "[affected] can't be blocked by creatures with power greater than [affected]'s power." */
	| { kind: 'cantBeBlockedByPowerGreaterThanSelf' }
	/** "[affected] can't block [filter]." */
	| { kind: 'cantBlockFilter'; filter: ObjectFilter }
	/** "[affected] can't block creatures with power greater than [affected]'s power." */
	| { kind: 'cantBlockPowerGreaterThanSelf' }
	/** "[affected] can't block creatures with power less than [affected]'s power." */
	| { kind: 'cantBlockPowerLessThanSelf' }
	/** CR 701.15: "Enchanted creature is goaded." (goaded by the static source's controller). */
	| { kind: 'isGoaded' }
	// --- End Track P14 ---
	// --- Track P17a ---
	| { kind: 'additionalBlockCountDynamic'; amount: Amount }
	| { kind: 'ignoreLandwalk'; keyword: string }
	| { kind: 'canBlockAsThoughReach'; filter?: ObjectFilter }
	| {
			kind: 'crewSaddlePowerMod';
			appliesTo: 'crew' | 'saddle' | 'both';
			delta?: number;
			useToughness?: boolean;
	  }
	// --- End Track P17a ---
	// --- Track P22a ---
	/** CR 508.1c: "~ can't attack a player it has already attacked this turn" (*Port Razer*). */
	| { kind: 'cantAttackAlreadyAttackedPlayerThisTurn' }
	/** CR 508.1c: "~ can't attack if defending player controls a [filter]" (*Veteran Brawlers*). */
	| { kind: 'cantAttackIfDefenderControls'; filter: ObjectFilter }
	/** CR 509.1b: "~ can't block if you control a [filter]" (*Veteran Brawlers*). */
	| { kind: 'cantBlockIfYouControl'; filter: ObjectFilter }
	/** CR 508.1c: "~ can't attack unless you control more creatures than defending player" (*Mogg Toady*). */
	| { kind: 'cantAttackUnlessMoreCreaturesThanDefender' }
	/** CR 509.1b: "~ can't block unless you control more creatures than attacking player" (*Mogg Toady*). */
	| { kind: 'cantBlockUnlessMoreCreaturesThanAttacker' };
	// --- End Track P22a ---

export type StaticDef =
	| {
			k: 'continuous';
			layer: Layer;
			affected: ObjectFilter | 'attachedTo' | 'self';
			mod: LayerMod;
			condition?: Condition;
			// --- Track P14 ---
			/** CR 113.6b: Static ability that functions while this card is in its owner's graveyard (e.g. Wonder, Brawn, Anger, Filth, Valor, Glory). */
			activeInZone?: 'graveyard';
			// --- End Track P14 ---
	  }
	| {
			k: 'costModifier';
			affects: SpellOrAbilityFilter;
			delta: CostDelta;
			who: PlayerFilter;
			/** Functions from these zones (Eminence works from the command zone too). */
			activeZones?: ZoneType[];
			condition?: Condition;
	  }
	| {
			k: 'ruleModifier';
			rule: RuleModKind;
			who: PlayerFilter;
			params?: Record<string, unknown>;
			condition?: Condition;
	  }
	| {
			/** Combat and untap restrictions on objects ("~ can't block", "~ can't be blocked"). */
			k: 'restriction';
			affected: ObjectFilter | 'attachedTo' | 'self';
			restriction: RestrictionKind;
			condition?: Condition;
	  }
	| {
			k: 'multiplier';
			what: 'counters' | 'tokens' | 'triggers';
			factor: number;
			/** Additive adjustment before factor ("that many plus one +1/+1 counters"). */
			delta?: number;
			filter?: ObjectFilter;
			/** counters: only this kind ("twice that many +1/+1 counters"). */
			counter?: CounterType;
			/** triggers: the event that must cause the trigger ("an artifact or creature entering"). */
			cause?: EventPattern;
			// --- Track P17a ---
			round?: 'down' | 'up';
			appliesToPlayers?: boolean;
			whoPlaces?: 'you' | 'opponents' | 'any';
			whoCreates?: 'you' | 'all';
			extraToken?: TokenSpec;
			extraTokenCount?: 'one' | 'matching';
			causeOr?: EventPattern[];
			triggerSourceAttachedTo?: boolean;
			// --- End Track P17a ---
			condition?: Condition;
	  }
	| {
			/** CR 103.6: "If ~ is in your opening hand, you may begin the game with it on the battlefield." */
			k: 'pregameAction';
			action: 'beginOnBattlefield';
			condition?: Condition;
	  }
	// --- Track P8 ---
	| {
			/** CR 508.1c, 509.1a–c: parameterized static combat restrictions, evasions, and requirements. */
			k: 'combatRule';
			affected: ObjectFilter | 'attachedTo' | 'self';
			rule: CombatRuleSpec;
			condition?: Condition;
	  }
	| {
			/** CR 602.5a: "Activated abilities of [affected] can't be activated [unless they're mana abilities]." */
			k: 'cantActivateAbilities';
			affected: ObjectFilter | 'attachedTo' | 'self';
			allowManaAbilities?: boolean;
			condition?: Condition;
	  }
	| {
			/** CR 401.5: "You may look at the top card of your library any time" / "Play with the top card of your library revealed." */
			k: 'topOfLibraryVisibility';
			mode: 'look' | 'reveal';
			// --- Track P17a ---
			players?: 'you' | 'all';
			// --- End Track P17a ---
			condition?: Condition;
	  }
	| {
			/** CR 305.1, 601.3e: play lands or cast spells from non-hand zones (`library`, `graveyard`, or `exile`). */
			k: 'zonePlayPermission';
			// --- Track P14: widened zone & added turn-slotted / self play options ---
			zone: 'library' | 'graveyard' | 'exile';
			allowLands?: boolean;
			allowSpells?: boolean;
			spellFilter?: ObjectFilter;
			affects?: 'self';
			duringYourTurnOnly?: boolean;
			slotMode?: 'unlimited' | 'oncePerTurn' | 'perPermanentType';
			exileIfPutIntoGraveyard?: boolean;
			// --- End Track P14 ---
			condition?: Condition;
	  }
	// --- Track P12 ---
	| {
			/** CR 601.2b,f–h: card-level additional cost to cast this spell ("As an additional cost to cast ~, <cost>."). */
			k: 'additionalCastCost';
			costs: CostDef[];
			condition?: Condition;
	  }
	// --- End Track P12 ---
	// --- Track P11 ---
	| {
			/** CR 118.9: Static alternative casting cost permission (e.g. Fist of Suns, Rooftop Storm, Bringer cycle). */
			k: 'altCastPermission';
			manaCost: string;
			costDefs?: CostDef[];
			affects: 'self' | { filter: ObjectFilter };
			// --- Track P14 ---
			allowedZones?: ZoneType[];
			// --- End Track P14 ---
			// --- Track P17b ---
			onceEachTurn?: boolean;
			duringYourTurnOnly?: boolean;
			grantFlash?: boolean;
			anyPlayer?: boolean;
			dynamicManaCostFromMV?: boolean;
			maxManaValueBySelfCounters?: CounterType;
			maxManaValueByControlledCount?: ObjectFilter;
			enterCounters?: { counter: CounterType; count: number };
			additionalOnly?: boolean;
			additionalPerMetric?: Amount;
			requireZonePermission?: boolean;
			payLifeEqualToSpellMV?: boolean;
			// --- End Track P17b ---
			// --- Track P17a ---
			payLifeEqualToManaValue?: boolean;
			slotMode?: 'unlimited' | 'oncePerTurn';
			entersWithCounters?: Partial<Record<CounterType, number>>;
			// --- End Track P17a ---
			condition?: Condition;
	  }
	| {
			/** CR 502.3: "You may choose not to untap ~ during your untap step." */
			k: 'mayChooseNotToUntap';
			affected: 'self' | 'attachedTo' | ObjectFilter;
			condition?: Condition;
	  }
	| {
			/** CR 510.1a: "Each creature [you control] assigns combat damage equal to its toughness rather than its power." */
			k: 'assignCombatDamageByToughness';
			affected: 'self' | 'attachedTo' | ObjectFilter;
			condition?: Condition;
	  }
	// --- End Track P11 ---
	// --- Track P14 ---
	| {
			/** CR 903.3a: "~ can be your commander." */
			k: 'commanderDesignation';
			condition?: Condition;
	  }
	| {
			/** CR 903.5b / 100.2a: "A deck can have any number of / up to N cards named ~." */
			k: 'deckCopyLimit';
			limit: number | 'any';
			condition?: Condition;
	  }
	| {
			/** CR 615.1, 615.5–6, 615.10, 615.12: Static damage prevention & Phantom counter-removal prevention. */
			k: 'staticDamagePrevention';
			combatOnly?: boolean;
			noncombatOnly?: boolean;
			amount: number | 'all';
			target: 'self' | 'attachedTo' | 'you' | 'youAndControlled' | 'any' | { filter: ObjectFilter };
			alsoPreventDealtBy?: boolean;
			dealtByOnly?: 'self' | 'attachedTo';
			dealtByTargetFilter?: ObjectFilter;
			sourceFilter?:
				| ObjectFilter
				| 'blockingOrBlockedBySelf'
				| 'blockingSelf'
				| 'blockedBySelf';
			phantomCounterRemoval?: {
				counter: CounterType;
				mode: 'one' | 'thatMany';
				requireCounterPresent?: boolean;
			};
			condition?: Condition;
	  }
	// --- End Track P14 ---
	// --- Track P15 ---
	| {
			/** CR 723.3: "~ enters prepared." */
			k: 'entersPrepared';
			condition?: Condition;
	  }
	// --- End Track P15 ---
	// --- Track P18b ---
	| {
			/** CR 702.139: Companion deckbuilding condition. */
			k: 'companionCondition';
			companionId: CompanionDeckConditionId;
			condition?: Condition;
	  }
	| {
			/** CR 702.48: "[Quality] offering" flash + sacrifice cost reduction static ability. */
			k: 'offering';
			filter: ObjectFilter;
			quality: string;
			condition?: Condition;
	  }
	| {
			/** CR 601.3: Self casting restriction on a permanent/nonland card ("Cast ~ only ..."). */
			k: 'selfCastRestriction';
			restrictions?: SpellCastRestrictionKind[];
			castCondition?: Condition;
			xCantBeZero?: boolean;
			condition?: Condition;
	  }
	| {
			/** CR 606.3: "You may activate the loyalty abilities of ~ twice each turn rather than only once." */
			k: 'loyaltyActivationsPerTurn';
			max: number;
			condition?: Condition;
	  }
	// --- End Track P18b ---
	// --- Track P17a ---
	| {
			/** CR 400.2 / 402: "Your opponents play with their hands revealed" / "Players play with their hands revealed." */
			k: 'handVisibility';
			players: 'opponents' | 'all' | 'you';
			condition?: Condition;
	  }
	| {
			/** CR 106.4 / 500.4: Unspent mana retention or color conversion across step/phase transitions. */
			k: 'retainUnspentMana';
			players: 'you' | 'all';
			colors: ManaColor[] | 'all';
			convertTo?: ManaColor;
			condition?: Condition;
	  }
	| {
			/** CR 502.3: "Untap all [affected] you control during each other player's untap step." */
			k: 'untapDuringOtherUntapSteps';
			affected: ObjectFilter | 'attachedTo' | 'self';
			condition?: Condition;
	  }
	| {
			/** CR 613.1d–e / 113.6: Off-battlefield creature subtype or color continuous grants (e.g. Maskwood Nexus, Arcane Adaptation, Painter's Servant). */
			k: 'offBattlefieldCharacteristics';
			zones: Array<'hand' | 'graveyard' | 'library' | 'exile' | 'command' | 'stack'>;
			filter?: ObjectFilter;
			who: 'you' | 'all';
			addAllCreatureTypes?: boolean;
			addChosenSubType?: boolean;
			addTypes?: string[];
			addSubtypes?: string[];
			addChosenColor?: boolean;
			addColors?: ManaColor[];
			condition?: Condition;
	  }
	| {
			/** CR 613.1f / 113.6: Grants spell keywords (e.g. convoke, delve, improvise, cascade, rebound) to matching spells you cast/control. */
			k: 'spellGrantKeyword';
			filter: ObjectFilter;
			keywords: string[];
			condition?: Condition;
	  }
	// --- End Track P17a ---
	// --- Track P20a ---
	| {
			/** CR 602.5a: "You may activate abilities of [filter] as though those creatures had haste." */
			k: 'activateAsThoughHaste';
			filter: ObjectFilter;
			condition?: Condition;
	  }
	| {
			/** CR 115.1 / 702.11 / 702.18: Source-filtered targeting restriction on permanents ("[affected] can't be the target of <sourceFilter> spells/abilities [your opponents control]"). */
			k: 'cantBeTargetedBy';
			affected: ObjectFilter | 'attachedTo' | 'self';
			sourceFilter?: ObjectFilter;
			spellsOnly?: boolean;
			abilitiesOnly?: boolean;
			opponentControllerOnly?: boolean;
			condition?: Condition;
	  }
	| {
			/** CR 106.12: "If you tap a [filter] for mana, it produces twice / three times as much of that mana instead." */
			k: 'tapForManaMultiplier';
			factor: number;
			filter: ObjectFilter;
			who?: 'you' | 'all';
			condition?: Condition;
	  }
	| {
			/** Draft-only rules text that has no effect during constructed/regular gameplay (*Deal Broker*, *Cogwork Librarian*, etc.). */
			k: 'draftNoOp';
			condition?: Condition;
	  }
	// --- End Track P20a ---
	// --- Track P20b ---
	| {
			/** CR 107.3a, 106.6, 601.2h: Mana-spending restriction on `{X}` or mana source kind when casting `~` or activating `~`'s abilities. */
			k: 'manaSpendRestriction';
			scope: 'selfSpell' | 'selfAbility' | 'selfBoth';
			xColors?: ManaColor[];
			xColoredOnly?: boolean;
			xMaxOnePerColor?: boolean;
			sourceKind?: 'creature' | 'basicLand' | 'snow' | 'treasure' | 'chosenColor';
			condition?: Condition;
	  }
	| {
			/** CR 118.8d / 118.7b–c: Defiler cycle optional 2-life additional cost that reduces a colored mana pip by `{<C>}`. */
			k: 'defilerCostReduction';
			color: ManaColor;
			lifeAmount: number;
			filter: ObjectFilter;
			condition?: Condition;
	  }
	| {
			/** CR 602.2b / 118.9: First equip / cycling / power-up activation each turn costs `{0}` rather than its mana cost. */
			k: 'firstActivationZeroCost';
			abilityKeyword: 'equip' | 'power-up' | 'cycling';
			duringYourTurnOnly?: boolean;
			condition?: Condition;
	  }
	| {
			/** CR 903.8: Commander tax replacement ("Rather than pay {2} for each previous time ..., pay 2 life that many times"). */
			k: 'commanderTaxAsLife';
			lifePerCast: number;
			condition?: Condition;
	  }
	// --- End Track P20b ---
	// --- Track P21 ---
	| {
			/** CR 601.2 / Panglacial Wurm: "While you're searching your library, you may cast ~ from your library." */
			k: 'castFromLibraryWhileSearching';
			condition?: Condition;
	  }
	| {
			/** Space Beleren: divides battlefield creatures into alpha, beta, and gamma sectors. */
			k: 'spaceSculptorSectors';
			condition?: Condition;
	  }
	// --- End Track P21 ---
	// --- Track P22a ---
	| {
			/** CR 903.4 / 103: "If ~ is your commander, choose a color before the game begins. ~ is the chosen color." */
			k: 'commanderPreGameColorChoice';
			condition?: Condition;
	  }
	| {
			/** CR 614.9 / 614.5: "All damage that would be dealt to you [and other permanents you control] is dealt to ~ / enchanted|equipped creature instead." */
			k: 'staticDamageRedirection';
			from: 'you' | 'youAndOtherControlled';
			to: 'self' | 'attachedTo';
			condition?: Condition;
	  }
	| {
			/** CR 615.12: "[Combat] damage [that would be dealt by <sourceFilter>] can't be prevented." */
			k: 'unpreventableDamage';
			combatOnly?: boolean;
			sourceFilter?: 'self' | 'attachedTo' | ObjectFilter;
			condition?: Condition;
	  }
	| {
			/** CR 122.6: "[affected] can't have [<counter>] counters put on it/them." */
			k: 'cantHaveCounterType';
			affected: ObjectFilter | 'attachedTo' | 'self';
			counter?: CounterType;
			condition?: Condition;
	  }
	| {
			/** CR 122.2: "Counters remain on ~ as it moves to any zone other than a player's hand or library." (*Skullbriar*, *Me, the Immortal*). */
			k: 'countersRemainInNonHiddenZones';
			condition?: Condition;
	  }
	| {
			/** CR 514.2: "Damage isn't removed from [affected] during cleanup steps." (*Ancient Adamantoise*). */
			k: 'damageNotRemovedInCleanup';
			affected: 'self' | 'attachedTo' | ObjectFilter;
			condition?: Condition;
	  }
	| {
			/** CR 406.3: "You may look at cards exiled with ~." (*Bane Alley Broker*). */
			k: 'mayLookAtExiledWithSelf';
			condition?: Condition;
	  }
	| {
			/** "You may cast ~ from your graveyard using its <keyword> ability." (*Tenacious Underdog*, *Detective's Phoenix*, *Timeline Culler*). */
			k: 'selfGraveyardKeywordCast';
			keyword: 'blitz' | 'dash' | 'bestow' | 'mutate' | 'warp';
			condition?: Condition;
	  }
	| {
			/** CR 702.138: "Each [filter] card in your graveyard has escape. The escape cost is equal to its mana cost plus exile <exileCount> other cards from your graveyard." */
			k: 'grantGraveyardEscape';
			filter: ObjectFilter;
			exileCount: number;
			condition?: Condition;
	  }
	| {
			/** CR 702.97 / 702.84: "Each [filter] card in your graveyard has scavenge / unearth [costOverride or equal to its mana cost]." */
			k: 'grantGraveyardKeywordAbility';
			keyword: 'scavenge' | 'unearth';
			filter: ObjectFilter;
			costOverride?: string;
			condition?: Condition;
	  }
	| {
			/** CR 702.143: "Each [filter] card in your hand without foretell has foretell. Its foretell cost is equal to its mana cost reduced by {<reduceGeneric>}." */
			k: 'grantHandForetell';
			filter: ObjectFilter;
			reduceGeneric: number;
			condition?: Condition;
	  }
	| {
			/** CR 614.17c: "Lands can't enter the battlefield." (*Worms of the Earth*). */
			k: 'landsCantEnterBattlefield';
			condition?: Condition;
	  }
	| {
			/** CR 702.21a: Dynamic mana ward ("~ has ward {X}, where X is ...", *Minthara, Merciless Soul*). */
			k: 'dynamicWardMana';
			affected: 'self' | 'attachedTo' | ObjectFilter;
			generic: Amount;
			condition?: Condition;
	  };
	// --- End Track P22a ---

// --- Track P18b ---
export type CompanionDeckConditionId =
	| 'lurrus'
	| 'yorion'
	| 'kaheera'
	| 'jegantha'
	| 'obosh'
	| 'gyruda'
	| 'zirda'
	| 'umori'
	| 'keruga'
	| 'lutri';
// --- End Track P18b ---

export interface EventPattern {
	event: EventKind | 'draw' | 'damage' | 'lifeGain';
	filter: EventFilter;
}

export interface ReplacementDef {
	replaces: EventPattern;
	with:
		| EffectStep[]
		| { k: 'skip' }
		| {
				k: 'modify';
				to?: ZoneType;
				shuffleIntoLibrary?: boolean;
				amount?: Amount;
				/** "~ enters tapped". */
				tapped?: boolean;
				/** "~ enters with N +1/+1 counters on it". */
				counters?: { counter: CounterType; amount: Amount };
				/** "You may have ~ enter as a copy of any creature on the battlefield" (CR 707). */
				copyOf?: ObjectFilter;
				// --- Track P4 ---
				/** CR 614.1c / 614.12: "As ~ enters, choose a creature / basic land / land type." */
				chooseSubType?: 'creature' | 'basicLand' | 'land';
				/** CR 614.1c / 614.12 / 105.4: "As ~ enters, choose a color [other than <color>]." */
				chooseColor?: { exclude?: ManaColor };
				// --- Track P8 ---
				/** Shocklands / Bolt lands (CR 614.12, 119.4, 119.8): "As ~ enters, you may pay N life. If you don't, it enters tapped." */
				payLifeOrEnterTapped?: number;
				/** Reveal / Snarl lands (CR 614.12): "As ~ enters, you may reveal a [filter] card from your hand. If you don't, ~ enters tapped." */
				revealFromHandOrEnterTapped?: ObjectFilter;
				/** Generalized Clone (CR 707.5): false when mandatory ("~ enters as a copy of ..."), default true ("You may have ~ enter as a copy of ..."). */
				copyOptional?: boolean;
				/** Generalized Clone Layer 1a modifications ("..., except ...", CR 707.9). */
				copyModifications?: CopyModificationSpec;
				// --- Track P11 ---
				/** CR 614.1c / 614.12: "As ~ enters, choose a [nonland] card name." */
				chooseCardName?: { nonlandOnly?: boolean };
				/** CR 614.1c / 614.12: "~ enters with your choice of a <c1> counter or a <c2> counter on it." */
				chooseCounter?: CounterType[];
				/** CR 614.12: External ETB additional counters ("Each other creature you control enters with an additional +1/+1 counter on it"). */
				additionalCounters?: { counter: CounterType; amount: Amount };
				/** CR 614.7a: Static damage scaling/addition ("deals that much damage plus 2 instead", "deals double/triple that damage instead"). */
				damageMod?: {
					mode: 'double' | 'triple' | 'add';
					add?: Amount;
					noncombatOnly?: boolean;
					combatOnly?: boolean;
					sourceFilter?: ObjectFilter | 'self' | 'attachedTo';
					targetFilter?: 'any' | 'opponent' | 'opponentOrOpponentPerm';
				};
				/** CR 119.6 / 614: Static life gain modification ("you gain twice that much life instead", "you gain that much life plus N instead"). */
				lifeGainMod?: {
					mode: 'double' | 'add';
					add?: Amount;
				};
				// --- End Track P11 ---
				// --- Track P14 & P15 ---
				/** CR 723.3a: "~ enters prepared." */
				entersPrepared?: boolean;
				// --- End Track P14 & P15 ---
				// --- Track P18b ---
				/** CR 614.1c / 614.12c: "As ~ enters, choose <wordA> or <wordB>." (Sieges, Mirrodin Besieged, etc.) */
				chooseAnchorWord?: [string, string];
				// --- End Track P18b ---
				// --- Track P17a ---
				/** CR 614.1a: "instead exile it with a <counter> counter on it". */
				exileWithCounter?: CounterType;
				/** CR 121.2 / 614.1a: Draw replacement scaling ("draw two cards instead", optionally skipping first draw in draw step). */
				drawMod?: {
					factor?: number;
					delta?: number;
					skipFirstInYourDrawStep?: boolean;
				};
				// --- End Track P17a ---
				// --- Track P20a ---
				/** CR 730.2: "If it's neither day nor night, it becomes day as ~ enters." */
				becomesDayIfNeither?: boolean;
				/** CR 614.1c / 614.12: "As ~ enters, choose a player / an opponent." */
				choosePlayer?: 'any' | 'opponent';
				/** CR 614.1c / 614.12: "As ~ enters, choose odd or even." */
				chooseParity?: boolean;
				/** CR 614.12: "~ enters under the control of an opponent of your choice." */
				enterUnderOpponentControl?: boolean;
				/** CR 614.12: External ETB untapped override ("Lands you control enter untapped", "Gates you control enter untapped"). */
				untapped?: boolean;
				/** CR 614.1a: Opponent-caused discard puts `~` onto the battlefield instead of graveyard (*Obstinate Baloth*, *Loxodon Smiter*, *Dodecapod*). */
				opponentDiscardToBattlefield?: {
					counters?: { counter: CounterType; count: number };
				};
				/** CR 614.1a: "If a creature dealt damage by ~ / by a source you controlled this turn would die, exile it instead." */
				dealtDamageBySelfExileOnDie?: boolean | 'controlledSource' | 'controlledSourceOpponentCreature';
				/** CR 614.1a: "If a source you control would deal noncombat damage to a creature an opponent controls, put that many -1/-1 counters on that creature instead." (*Soul-Scar Mage*). */
				noncombatDamageToOpponentCreatureAsMinusCounters?: boolean;
				/** CR 701.19: "If ~ would be destroyed, regenerate it." (*Knight of the Holy Nimbus*, *Mossbridge Troll*). */
				regenerateSelfOnDestroy?: boolean;
				/** CR 614.1a: "If ~ would be put into a graveyard from the battlefield, instead exile it and take an extra turn after this one." (*Ugin's Nexus*). */
				exileAndExtraTurnOnBattlefieldToGraveyard?: boolean;
				/** CR 614.7a: Damage scaling targeting `chosenPlayerId` or permanents they control (*True-Name Nemesis* / *Archfiend* / *Obosh*-style chosen-player doublers). */
				chosenPlayerDamageMod?: {
					mode: 'double' | 'triple' | 'add';
					add?: Amount;
					noncombatOnly?: boolean;
					combatOnly?: boolean;
					sourceFilter?: ObjectFilter | 'self' | 'attachedTo';
				};
				// --- End Track P20a ---
				// --- Track P22a ---
				/** CR 614.1c / 614.12 / 300.1: "As ~ enters, [look at an opponent's hand, then] choose a card type [other than ...] / choose X, Y, or Z." */
				chooseCardType?: {
					exclude?: string[];
					options?: string[];
					lookAtOpponentHand?: boolean;
				};
				/** CR 614.1c / 614.12: "As ~ enters, choose a number [between <min> and <max>]." */
				chooseNumber?: { min?: number; max?: number };
				/** CR 614.1c / 614.12: "As ~ enters, choose two colors." (*Tablet of the Guilds*). */
				chooseTwoColors?: boolean;
				/** CR 614.1c / 614.12: "As ~ enters, choose two players." (*Sower of Discord*). */
				chooseTwoPlayers?: boolean;
				/** CR 614.1c / 614.12: "As ~ enters, choose another creature [you control]." (*Dauntless Bodyguard*, *Metamorphic Alteration*). */
				chooseObjectOnBattlefield?: { filter: ObjectFilter; optional?: boolean };
				/** CR 614.1c / 614.12: Disjunctive subtype choice ("As ~ enters, choose A, B, or C", *Dawn-Blessed Pennant*, *Roots of Life*). */
				chooseSubTypeOptions?: string[];
				/** CR 614.1c / 614.12: "As ~ enters, look at an opponent's hand, then choose any card name." (*Anointed Peacekeeper*). */
				lookAtOpponentHandBeforeCardName?: boolean;
				/** CR 614.1a: "If damage would be dealt to ~, put that many <counter> counters on it instead." (*Phytohydra*). */
				damageToSelfAsPlusCounters?: CounterType;
				// --- End Track P22a ---
		  };
	/** CR 614.15 / 616.1a: true when this is a self-replacement effect applied before other replacements. */
	selfReplacement?: boolean;
	who?: PlayerFilter;
	/** Only applies while this holds ("while your library has no cards in it"). */
	condition?: Condition;
}
