/**
 * Card IR (ENGINE_ARCHITECTURE_PLAN.md section 2.1).
 *
 * A card is compiled once from its rules text into a CardDefinition. The runtime interprets this
 * structure and never reads card names or rules text. The IR is derived data: it is never stored in
 * GameState, only cached by the compiler.
 *
 * Changes to this file must be additive while parallel phases are running (plan section 4).
 */
import type { CounterType, GamePhase, ManaColor, TriggerScope, ZoneType } from './types.ts';

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
	faces: FaceDefinition[];
	/** True iff no face has an `unsupported` ability. */
	fullySupported: boolean;
}

export interface FaceDefinition {
	name: string;
	characteristics: Characteristics;
	abilities: AbilityDef[];
}

export interface Characteristics {
	manaCost: string;
	types: string[];
	subtypes: string[];
	supertypes: string[];
	colors: ManaColor[];
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
	span: Span;
}

export interface SpellAbility {
	kind: 'spell';
	additionalCosts: CostDef[];
	targets: TargetSpec[];
	effect: EffectStep[];
	modal?: ModalDef;
	span: Span;
}

export interface ActivatedAbility {
	kind: 'activated';
	cost: CostDef[];
	targets: TargetSpec[];
	effect: EffectStep[];
	timing: Timing;
	isMana: boolean;
	/**
	 * CR 305.6: a basic land type grants "{T}: Add [mana]" without any printed text. Intrinsic
	 * abilities have an empty span.
	 */
	intrinsic?: boolean;
	span: Span;
}

export interface TriggeredAbility {
	kind: 'triggered';
	trigger: TriggerDef;
	/** CR 603.4 intervening-if condition, checked when the trigger event occurs and on resolution. */
	condition?: Condition;
	targets: TargetSpec[];
	effect: EffectStep[];
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
	| 'multiface';

export interface UnsupportedAbility {
	kind: 'unsupported';
	reason: UnsupportedReason;
	/** The ability's normalised text. */
	text: string;
	span: Span;
	/** The parts of `text` nothing claimed, if narrower than the whole ability. */
	unparsed: Span[];
}

export type Timing = 'instant' | 'sorcery' | 'mana';

export interface ModalDef {
	min: number;
	max: number;
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
}

// ---- Filters --------------------------------------------------------------------------------

/**
 * One selector language for targets, costs, counts, triggers and statics. List fields match if any
 * entry matches ("artifact or enchantment" is `types: ['Artifact', 'Enchantment']`); different
 * fields must all match.
 */
export interface ObjectFilter {
	zone?: ZoneType | ZoneType[] | 'stack';
	types?: string[];
	subtypes?: string[];
	supertypes?: string[];
	notTypes?: string[];
	/** "nonbasic": none of these supertypes. */
	notSupertypes?: string[];
	controller?: 'you' | 'opponent' | 'any';
	owner?: 'you' | 'opponent' | 'any';
	tapped?: boolean;
	token?: boolean;
	/** "another" / "other": not the source object. */
	other?: boolean;
	colors?: ManaColor[];
	manaValue?: Compare;
	power?: Compare;
	attacking?: boolean;
	blocking?: boolean;
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
}

// ---- Amounts (replaces dynamicFormula strings) ----------------------------------------------

export type BindingName = string;

export type Ref =
	| { k: 'self' }
	| { k: 'target'; index: number }
	| { k: 'binding'; name: BindingName }
	| { k: 'eventObject' };

export type PlayerRef =
	| { k: 'you' }
	| { k: 'controllerOf'; of: Ref }
	| { k: 'ownerOf'; of: Ref }
	| { k: 'target'; index: number }
	| { k: 'activePlayer' };

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
	| { k: 'negate'; of: Amount }
	| { k: 'sum' | 'min' | 'max'; args: Amount[] };

// ---- Costs ----------------------------------------------------------------------------------

export type CostDef =
	| { k: 'mana'; cost: string }
	| { k: 'tapSelf' }
	| { k: 'untapSelf' }
	| { k: 'tapOthers'; count: Amount; filter: ObjectFilter }
	| { k: 'sacrifice'; count: Amount; filter: ObjectFilter | 'self' }
	| { k: 'discard'; count: Amount; filter?: ObjectFilter; random?: boolean }
	| { k: 'payLife'; amount: Amount }
	| { k: 'loyalty'; delta: number }
	| { k: 'removeCounters'; counter: CounterType; count: Amount; from: 'self' | ObjectFilter }
	| { k: 'exileFrom'; zone: ZoneType; count: Amount; filter?: ObjectFilter | 'self' };

// ---- Effects --------------------------------------------------------------------------------

export type Verb =
	| 'destroy'
	| 'exile'
	| 'bounce'
	| 'move'
	| 'draw'
	| 'scry'
	| 'lookAndReorder'
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
	| 'grantPlayer';

export type Duration = 'endOfTurn' | 'permanent' | 'untilYourNextTurn';

/** An ordered list of verb steps whose results later steps can refer to (`bindAs`). */
export interface EffectStep {
	verb: Verb;
	subject: Selector;
	/** Who performs the step ("its controller creates ...", "target player draws ..."). Default: you. */
	actor?: PlayerRef;
	amount?: Amount;
	params?: EffectParams;
	optional?: { chooser: PlayerRef };
	bindAs?: BindingName;
	delayed?: { trigger: TriggerDef; effect: EffectStep[] };
	span: Span;
}

export interface EffectParams {
	toughness?: Amount;
	keywords?: string[];
	duration?: Duration;
	counter?: CounterType;
	token?: TokenSpec;
	tapped?: boolean;
	mayShuffle?: boolean;
	/** addMana: the exact symbols produced, e.g. ['C', 'C'] for "Add {C}{C}". */
	mana?: ManaColor[];
	/** addMana: `amount` mana of one colour chosen from this set ("Add {W} or {U}", "any color"). */
	manaChoice?: ManaColor[] | 'any' | 'commanderIdentity' | 'opponentLandColors';
	/** grantPlayer: the rules the player gets. */
	playerRules?: Array<'lifeTotalCantChange' | 'protectionFromEverything'>;
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
}

export interface TokenSpec {
	name: string;
	power: number;
	toughness: number;
	colors: ManaColor[];
	typeLine: string;
	keywords: string[];
}

export interface SearchSpec {
	filter: ObjectFilter;
	count: number;
	upTo: boolean;
	/** False only for unrestricted "a card" tutors (CR 701.19b: must find one if possible). */
	statedQuality: boolean;
	destinations: Array<{ zone: 'battlefield' | 'hand' | 'library'; tapped?: boolean; onTop?: boolean }>;
	/** The searched-for phrase as printed ("a basic land card"), for prompts. */
	description?: string;
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
	| 'gainLife';

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
}

export interface TriggerDef {
	event: EventKind;
	filter: EventFilter;
	scope?: TriggerScope;
	/** The trigger functions while its source is in this zone (Nether Shadow: graveyard). */
	fromZone?: ZoneType;
	/** "Whenever ~ enters or attacks": the ability also triggers on each of these events. */
	or?: TriggerDef[];
}

export type Condition =
	| { k: 'compare'; left: Amount; op: '>=' | '<=' | '=' | '>' | '<'; right: Amount }
	| { k: 'and' | 'or'; of: Condition[] }
	| { k: 'not'; of: Condition }
	/** CR 404.2: the graveyard's order matters. */
	| { k: 'graveyardAbove'; filter: ObjectFilter; count: number }
	| { k: 'isTurnOf'; player: PlayerRef };

// ---- Statics and replacements ---------------------------------------------------------------

export type Layer = '1' | '2' | '3' | '4' | '5' | '6' | '7a' | '7b' | '7c' | '7d';

export type LayerMod =
	| { k: 'pt'; power: Amount; toughness: Amount }
	| { k: 'setBasePT'; power: Amount; toughness: Amount }
	| { k: 'addKeywords'; keywords: string[] }
	| { k: 'removeAllAbilities' }
	| { k: 'addTypes'; types: string[]; subtypes?: string[] }
	| { k: 'setTypes'; types: string[]; subtypes?: string[] }
	| { k: 'switchPT' };

export interface CostDelta {
	/** 'setZero' makes the cost {0}; 'reduce'/'increase' change the generic component. */
	mode: 'setZero' | 'reduce' | 'increase';
	generic: number;
}

export type SpellOrAbilityFilter =
	| { k: 'spell'; filter: ObjectFilter }
	| { k: 'ability'; keyword: string };

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
	| 'searchControl';

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
	| { k: 'ruleModifier'; rule: RuleModKind; who: PlayerFilter; params?: Record<string, unknown> }
	| {
			k: 'multiplier';
			what: 'counters' | 'tokens' | 'triggers';
			factor: number;
			filter?: ObjectFilter;
	  };

export interface EventPattern {
	event: EventKind | 'draw' | 'damage' | 'lifeGain';
	filter: EventFilter;
}

export interface ReplacementDef {
	replaces: EventPattern;
	with: EffectStep[] | { k: 'skip' } | { k: 'modify'; to?: ZoneType; amount?: Amount };
	who?: PlayerFilter;
}
