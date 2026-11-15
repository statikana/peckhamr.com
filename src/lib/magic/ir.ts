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

export interface SpellAbility {
	kind: 'spell';
	additionalCosts: CostDef[];
	targets: TargetSpec[];
	effect: EffectStep[];
	modal?: ModalDef;
	/** CR 601.3: "Cast ~ only during combat." and similar timing restrictions. */
	castRestrictions?: Array<'duringCombat' | 'duringYourTurn' | 'beforeAttackers'>;
	span: Span;
}

export type ActivationRestriction =
	| 'onceEachTurn'
	| 'duringYourTurn'
	| 'duringYourUpkeep'
	| 'duringCombat';

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
	/** CR 601.3: timing restrictions recognized on an unsupported spell. */
	castRestrictions?: Array<'duringCombat' | 'duringYourTurn' | 'beforeAttackers'>;
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
	| { k: 'devotion'; colors: ManaColor[] }
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
	| { k: 'lastRollResult' };
	// --- End Track P10 ---

// ---- Costs ----------------------------------------------------------------------------------

export type CostDef =
	| { k: 'mana'; cost: string }
	| { k: 'tapSelf' }
	| { k: 'untapSelf' }
	| { k: 'tapOthers'; count: Amount; filter: ObjectFilter }
	| { k: 'sacrifice'; count: Amount; filter: ObjectFilter | 'self' }
	| { k: 'discard'; count: Amount; filter?: ObjectFilter | 'self'; random?: boolean }
	| { k: 'payLife'; amount: Amount }
	| { k: 'loyalty'; delta: number }
	| { k: 'removeCounters'; counter: CounterType; count: Amount; from: 'self' | ObjectFilter }
	| { k: 'exileFrom'; zone: ZoneType; count: Amount; filter?: ObjectFilter | 'self' }
	/** Reveal N matching cards in hand as part of a cost ("Morph—Reveal a white card in your hand."). */
	| { k: 'revealFromHand'; count: Amount; filter?: ObjectFilter | 'self' }
	/** Pay exactly one of the options ("discard a card or pay 3 life", "sacrifice a creature or pay {3}{B}"). */
	| { k: 'choice'; options: CostDef[][] }
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
	| { k: 'returnToHand'; count: Amount; filter: ObjectFilter | 'self' };

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
	| 'retainMana';
	// --- End Track P10 ---

export type ManaRestriction = 'artifactSpellOrNonSpell';

export type Duration = 'endOfTurn' | 'permanent' | 'untilYourNextTurn' | 'untilSourceLeaves';

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
	manaChoice?: ManaColor[] | 'any' | 'commanderIdentity' | 'opponentLandColors' | 'chosenColor';
	/** addMana: spending restriction attached to the produced mana (CR 106.6). */
	manaRestriction?: ManaRestriction;
	/** grantPlayer: the rules the player gets. */
	playerRules?: Array<
		| 'lifeTotalCantChange'
		| 'protectionFromEverything'
		// --- Track P7 ---
		| 'damageCantBePrevented'
		| 'combatDamageCantBePrevented'
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
		revealAll?: boolean;
		revealKept?: boolean;
		rest: 'libraryBottom' | 'graveyard';
		restRandom?: boolean;
		restOrder?: 'any' | 'random';
		// --- Track P10 ---
		/** Reveal from top of library until a card matches `untilFilter` (CR 701.20). */
		untilFilter?: ObjectFilter;
		/** Put all revealed/remaining cards into hand (e.g. Treasure Hunt-style effects). */
		restToHand?: boolean;
		// --- End Track P10 ---
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
}

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
	| 'forage';
	// --- End Track P10 ---

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
	| { k: 'matchesFilter'; target?: Ref; filter: ObjectFilter }
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
	  };
	// --- End Track P10 ---

// ---- Statics and replacements ---------------------------------------------------------------

export type Layer = '1' | '2' | '3' | '4' | '5' | '6' | '7a' | '7b' | '7c' | '7d';

export type LayerMod =
	| { k: 'setController'; controller: PlayerRef }
	| { k: 'pt'; power: Amount; toughness: Amount }
	| { k: 'setBasePT'; power: Amount; toughness: Amount }
	| { k: 'addKeywords'; keywords: string[] }
	| { k: 'removeAllAbilities' }
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
	| { k: 'protectionFromChosenColor' }
	// --- Track P8 ---
	/** Layer 7a/7b single-axis base power setter ("~'s power is equal to ...", CR 208.2a, 613.4a). */
	| { k: 'setBasePower'; power: Amount }
	/** Layer 7a/7b single-axis base toughness setter ("~'s toughness is equal to ...", CR 208.2a, 613.4a). */
	| { k: 'setBaseToughness'; toughness: Amount };

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
}

export type SpellOrAbilityFilter =
	| { k: 'spell'; filter: ObjectFilter }
	| { k: 'ability'; keyword: string }
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
	| 'damageCantBePrevented';

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
	| 'cantHaveCounters';

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
	| { kind: 'globalMaxBlockers'; max: number };

export type StaticDef =
	| {
			k: 'continuous';
			layer: Layer;
			affected: ObjectFilter | 'attachedTo' | 'self';
			mod: LayerMod;
			condition?: Condition;
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
			condition?: Condition;
	  }
	| {
			/** CR 305.1, 601.3e: play lands or cast spells from non-hand zones (`library` top card or `graveyard`). */
			k: 'zonePlayPermission';
			zone: 'library' | 'graveyard';
			allowLands?: boolean;
			allowSpells?: boolean;
			spellFilter?: ObjectFilter;
			condition?: Condition;
	  };

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
				/** CR 614.1c / 614.12: "As ~ enters, choose a creature type." */
				chooseSubType?: 'creature';
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
		  };
	/** CR 614.15 / 616.1a: true when this is a self-replacement effect applied before other replacements. */
	selfReplacement?: boolean;
	who?: PlayerFilter;
	/** Only applies while this holds ("while your library has no cards in it"). */
	condition?: Condition;
}
