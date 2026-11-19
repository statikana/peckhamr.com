/**
 * Effect interpreter ports, context/result types, unified damage pipeline, life gain,
 * proliferate candidate selection, devotion, and mana-choice color resolution.
 * Extracted from runtime/effects.ts (strictly below effectsConditionsAndAmounts.ts,
 * effectsSteps.ts, and effects.ts in the DAG).
 */
import type {
	Amount,
	Condition,
	// --- Track P7 ---
	CopyModificationSpec,
	// --- End Track P7 ---
	CostDef,
	EffectStep,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	TargetSpec,
	TokenSpec,
	Verb
} from '../ir.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	// --- Track P13 ---
	ChoiceRequest,
	// --- End Track P13 ---
	CompiledDelayedEffect,
	CounterType,
	DelayedTrigger,
	EffectBindingSnapshot,
	EffectResumeFrame,
	GameState,
	LibrarySearchSpec,
	ManaColor,
	PendingPrompt,
	PlayerGameState,
	ScryfallCard,
	SerializedBoundRef,
	StackItem,
	TargetRef,
	TriggerEventLki,
	VfxEvent,
	ZoneType
} from '../types.ts';
import { describeCost } from './costs.ts';
import { addManaToPlayerPool, type AddManaOptions } from './mana.ts';
import { getCardFaces } from '../scryfall.ts';
import {
	activeAbilityDefs,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { legacySearchSpec, predefinedTokenToSpec } from '../compiler/effects.ts';
import { PREDEFINED_TOKEN_DEFS } from '../oracle.ts';
import { getKeywordSpec } from '../keywords.ts';
import {
	evaluatePermanent,
	opponentLandColors as ruleTreeOpponentLandColors,
	playerLandColors as ruleTreePlayerLandColors
} from '../ruleTree.ts';
import { enqueueChoicePrompt } from './choices.ts';
import { emitEvent } from './events.ts';
// --- Track P22b ---
import { recordP22bExcessDamage } from './triggersWave8.ts';
// --- End Track P22b ---
import {
	evaluateKickedCountAmount,
	evaluateKickerCondition,
	getObjectKickerInfo,
	isConditionMetWithKicker,
	isObjectBlitzed,
	isObjectEscaped,
	isObjectEvoked,
	isObjectForetold,
	type KickerTrackingInfo
} from './kicker.ts';
import { scaleCumulativeUpkeepCost } from './orthogonalKeywords.ts';
// --- Track P12 ---
import { evaluateP12Condition, recordPlayerLifeLossWave4 } from './keywordsWave4.ts';
// --- End Track P12 ---
// --- Track P14 ---
import {
	computeDevotionToColors,
	evaluateWave5Amount,
	evaluateWave5Condition
} from './staticsAndCostsWave5.ts';
// --- End Track P14 ---
// --- Track P15 ---
import {
	canExternalEffectTransform,
	evaluateP15Amount,
	evaluateP15Condition,
	increasePlayerSpeed,
	isPermanentBattle,
	onBattleDefenseCountersRemoved,
	onPlayerLostLifeCheckSpeedTrigger,
	setPermanentPrepared,
	staticallyInterpretableP15
} from './framesBattlesAndKeywordsWave5.ts';
// --- End Track P15 ---
// --- Track P16b ---
import {
	doThisOnceKey,
	evaluateP16bCondition,
	isDoThisOnceTakenThisTurn,
	isStackItemTriggerDoThisOnce,
	markDoThisOnceTakenThisTurn,
	matchesP16bObjectFilter
} from './triggersWave6.ts';
// --- End Track P16b ---
// --- Track P17b ---
import { evaluateP17bAmount, evaluateP17bCondition } from './costsWave6.ts';
// --- End Track P17b ---
// --- Track P18b ---
import {
	executeHarnessStep,
	executeMeldStep,
	isMeldedPermanent,
	staticallyInterpretableP18b
} from './framesModalsWave6.ts';
// --- End Track P18b ---
// --- Wave 10 ---
import {
	applyWave10LifeFloor,
	handleDamagePreventedWave10,
	resolveWave10DamageRedirection
} from './combatWave10.ts';
// --- End Wave 10 ---
// --- Track P16a ---
import {
	buildDoOnceThisTurnKey,
	buildP16aDurationExpiryFields,
	canDoOnceThisTurn,
	evaluateP16aStepCondition,
	executeAssimilate,
	executeCastFree,
	executeConvert,
	executeCopyCountersFrom,
	executeEmpowerJace,
	executeGeneralizedMoveCounters,
	executeHeal,
	executePileSplit,
	executePutPlayerCounters,
	executeRecruit,
	executeRemoveFromCombat,
	getPlayerCounterCount,
	isNegativeArbitraryCounter,
	isSpellUncounterableByP16a,
	latchBrokenP16aSourceConditions,
	markDoneOnceThisTurn,
	resolveChosenBasicLandSubtypeForAnimate,
	resolveChosenCreatureSubtypeForAnimate,
	resolveChosenKeywordFromOptions,
	resolveChosenProtectionKeyword,
	type P16aStepHost
} from './effectsWave6.ts';
// --- End Track P16a ---
// --- Track P22a ---
import {
	filterPlayerCountersGrantedWave8,
	playerImmuneToOpponentForcedDiscardWave8,
	playerImmuneToOpponentForcedSacrificeWave8,
	playerProtectedFromSourceWave8,
	resolveStaticDamageRedirection,
	shouldReplaceDamageWithCountersWave8
} from './staticsWave8.ts';
// --- End Track P22a ---
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	evaluateAmount,
	evaluateCondition,
	matchesObjectFilter,
	objectManaValue,
	objectPower,
	objectToughness,
	playerCommanderCastCount
} from './objectFilter.ts';
// --- Track P8 ---
import {
	countDistinctCardTypesInZone,
	evaluateP8Condition
} from './staticsLayersAndRestrictions.ts';
import {
	activeRuleModifiers,
	applySelfEtbReplacements,
	// --- Track P22c ---
	spellCannotBeCopied,
	// --- End Track P22c ---
	tokenMultiplier
} from './replace.ts';
// --- Track P20a ---
import {
	applyChosenPlayerDamageModifiers,
	getGrantedSpellDamageKeywordsForStackItem,
	hasGlobalAllDamageWither,
	shouldDealDamageToPlayerAsInfect,
	shouldReplaceNoncombatDamageWithMinusCounters
} from './staticsWave7.ts';
// --- End Track P20a ---
import {
	flushTriggers,
	withSimultaneousDestroyLki,
	// --- Track P13 ---
	withSimultaneousZoneBatch
	// --- End Track P13 ---
} from './triggers.ts';
import { nextRandom } from './random.ts';
// --- Track P9 ---
import {
	cameUnderControlSinceLastUpkeep,
	isNinjutsuWindowOpen,
	isUnblockedAttackerForPlayer,
	sumEvaluatedToxic
} from './keywordsWave3.ts';
// --- Track P11 ---
import {
	ALL_COUNTER_TYPES,
	applyStaticDamageModifiers,
	applyStaticLifeGainModifiers,
	computeAttachmentsOnCount,
	computeDomainCount,
	computePartyCount,
	NEGATIVE_COUNTER_TYPES,
	playerCantGainLife
} from './staticsDynamicAndCosts.ts';
// --- End Track P11 ---
import {
	applyNextUntapFreeze,
	chooseBotLibraryPlacement,
	computeLibraryInsertIndex,
	exertPermanent,
	expandCombinationBundles,
	formatManaBundle,
	orderBotSimultaneousLibraryCards,
	pickBestBundleForRequirement,
	pickCombinationForRequirement
} from './tuckFreezeChosen.ts';
import {
	allocateTimestamp,
	attachObject,
	// --- Track P10 ---
	captureLki,
	// --- End Track P10 ---
	createEmptyCounters,
	// --- Track P18b ---
	mergeExiledPairOntoBattlefield,
	// --- End Track P18b ---
	moveObject,
	rearrangeLibrary,
	shuffleLibrary,
	syncBattlefieldControllers,
	tapPermanent,
	type MoveResult
} from './zones.ts';
import { PROMPTING_VERBS } from '../compiler/interpretable.ts';
import {
	executeAdapt,
	executeAmass,
	executeBolster,
	executeIncubate,
	executeManifestDread,
	executeManifestOrCloak,
	executeMonstrosity,
	executePopulate,
	type KeywordActionHost
} from './keywordActions.ts';
// --- Track P7 ---
import {
	addDamagePreventionShield,
	applyBecomeCopyEffect,
	applyDamagePreventionShields,
	evaluateP7Condition,
	getEffectiveCardForPermanent,
	getLockedTargetDivisionAmount,
	isDamageUnpreventable,
	recordLifeGainedThisTurn,
	// --- Track P19a ---
	registerEnteredAttackingCombatant,
	// --- End Track P19a ---
	// --- Track P22d ---
	registerDamagePreventedHandler,
	// --- End Track P22d ---
	registerExileInsteadOfDying,
	registerTimedCombatRestriction
} from './copyPreventionAndEffects.ts';
// --- End Track P7 ---
// --- Track P10 ---
import type { ManaSpendingRestrictionSpec } from '../types.ts';
import {
	enqueueReflexiveTriggerForStep,
	evaluateP10Condition,
	executeAttachP10,
	executeBlight,
	executeClash,
	executeCollectEvidence,
	executeDetain,
	executeDiscover,
	executeEndure,
	executeFateseal,
	executeFlipCoin,
	executeForage,
	executeMultiZoneSearchP10,
	executeRollDie,
	executeSuspect,
	executeTimeTravel,
	isExploitTriggerStackItem,
	isP10ExtendedSearch,
	type P10EffectHost
} from './reflexiveManaAndActions.ts';
// --- End Track P10 ---
// --- Track P13 ---
import {
	buildDurationExpiryFields,
	computeColorsAmongPermanents,
	computeDevotionTo,
	computeStatAggregateAmong,
	computeUnlockedDoorsCount,
	evaluateP13Condition,
	executeAirbend,
	executeChooseDesignation,
	executeCouncilVote,
	executeCreateEmblem,
	executeCreateRoleToken,
	executeDoubleOrTriple,
	executeEarthbend,
	executeExchange,
	executeGrantGraveyardCast,
	executeLearn,
	executeTakeInitiative,
	executeTemptWithRing,
	executeTurnFace,
	executeVentureIntoDungeon,
	executeVillainousChoice,
	matchesP13ObjectFilterFields,
	type P13LifeFunnels,
	type P13StepAskFn
} from './effectsWave5.ts';
// --- End Track P13 ---
// --- Track P19a ---
import {
	computeP19aMultiZoneStatAggregate,
	evaluateP19aAmount,
	evaluateP19aCondition,
	executeDelayedNextSpellCopyP19a as executeP19aDelayedNextSpellCopy,
	executeDelayedTapManaTriggerP19a as executeP19aDelayedTapManaTrigger,
	executeExileUntilP19a as executeP19aExileUntil,
	executeP19aExtendedRevealAndDiscard,
	executeRedirectTargetsP19a as executeP19aRedirectTargets,
	executeP19aSetLifeTotal,
	executeSkipTurnP19a as executeP19aSkipTurn,
	executeSkipCombatPhase,
	resolveP19aChosenColorsForAnimate,
	resolveP19aChosenPumpDelta,
	resolveP19aManaChoiceColors,
	type P19aStepHost
} from './effectsWave7.ts';
// --- End Track P19a ---
// --- Track P22d ---
import {
	executeDigWave8,
	executeExileUntilWave8,
	executePreventWave8,
	handleDamagePreventedWave8
} from './effectsWave8.ts';
// --- End Track P22d ---


/** Seeded randomness lives in runtime/random.ts (re-exported here for existing importers). */
export { nextRandom };

// ---- Engine ports ---------------------------------------------------------------------------

/** Engine primitives the interpreter uses. engine.ts registers them once at module load. */
export type PayOptionalCostResult =
	| { status: 'paid' }
	| { status: 'failed' }
	| {
			status: 'needChoice';
			answerKey: string;
			zone: ZoneType;
			label: string;
			count: number;
			// --- Track P22d ---
			maxCount?: number;
			// --- End Track P22d ---
			candidateIds: string[];
	  }
	// --- Track P19a ---
	| {
			status: 'needOptionChoice';
			answerKey: string;
			labels: string[];
	  }
	// --- End Track P19a ---
	| {
			status: 'paused';
			pending: NonNullable<EffectResumeFrame['pendingOptionalCost']>;
			queued: PendingPrompt[];
	  };

export interface EffectPorts {
	uid(prefix: string, state?: GameState): string;
	addLog(state: GameState, kind: 'rule' | 'cast' | 'trigger' | 'life' | 'combat', text: string, actorId?: string): void;
	emitVfx(state: GameState, event: Omit<VfxEvent, 'id' | 'timestamp'>): void;
	findPermanent(state: GameState, id: string): { inst: CardInstance; owner: PlayerGameState; controller: PlayerGameState } | null;
	power(state: GameState, inst: CardInstance): number;
	toughness(state: GameState, inst: CardInstance): number;
	hasKeyword(state: GameState, inst: CardInstance, keyword: string): boolean;
	drawCards(state: GameState, player: PlayerGameState, count: number): void;
	/** Non-combat damage to a target permanent or player (protection, lifelink, events). */
	damageTarget(state: GameState, sourcePlayerId: string, target: TargetRef, amount: number): void;
	/** Destroy (CR 701.7): indestructible, regeneration, dies triggers. */
	destroy(state: GameState, inst: CardInstance, title: string, controllerId: string, canBeRegenerated?: boolean): MoveResult | 'skipped' | void;
	/** CR 701.19a / 614.8: consumes a regeneration shield instead of destroying if permitted. */
	tryRegenerateInsteadOfDestroy(state: GameState, perm: CardInstance, canBeRegenerated?: boolean): boolean;
	/** Checks whether `player` can currently pay `defs` as an optional/unless cost (non-spell mana context). */
	canPayOptionalCost(state: GameState, player: PlayerGameState, item: StackItem, defs: CostDef[]): boolean;
	/** Pays (or prompts for object choices / zone replacements while paying) an optional/unless cost. */
	payOptionalCost(
		state: GameState,
		player: PlayerGameState,
		item: StackItem,
		stepIndex: number,
		defs: CostDef[],
		answers: Record<string, ChoiceAnswer>,
		pending?: EffectResumeFrame['pendingOptionalCost']
	): PayOptionalCostResult;
	/** Moves a permanent off the battlefield (replacement effects, attachments, tokens cease to exist). */
	moveFromBattlefield(
		state: GameState,
		inst: CardInstance,
		to: 'graveyard' | 'exile' | 'hand' | 'library',
		// --- Track P10 ---
		libraryOpts?: {
			position?: 'top' | 'bottom';
			fromTop?: number;
			sacrificedByPlayerId?: string;
			suppressGraveyardLeaveBatch?: boolean;
		}
		// --- End Track P10 ---
	): string;
	// --- Precon Bragos Spirit ---
	/** Returns a spell on the stack to its owner's hand without countering it (a copy ceases to exist, CR 707.10a). */
	moveStackSpellToHand(state: GameState, target: StackItem): void;
	// --- End Precon Bragos Spirit ---
	/** Moves a spell on the stack into its owner's library without countering it (CR 401.2, 401.7). */
	moveStackSpellToLibrary(
		state: GameState,
		target: StackItem,
		libraryOpts?: { position?: 'top' | 'bottom'; fromTop?: number }
	): void;
	/** Counters a spell unless it can't be countered. Returns true if it was countered. */
	// --- Track P10 ---
	counterSpell(
		state: GameState,
		item: StackItem,
		target: StackItem,
		controller: PlayerGameState,
		replacementZone?: 'exile' | 'libraryTop' | 'libraryBottom'
	): boolean;
	// --- End Track P10 ---
	createToken(state: GameState, controller: PlayerGameState, spec: TokenSpec): CardInstance;
	copyPermanentAsToken(
		state: GameState,
		controller: PlayerGameState,
		inst: CardInstance,
		title: string,
		notLegendary?: boolean,
		exceptPT?: { power: number; toughness: number },
		// --- Track P7 ---
		copyMod?: CopyModificationSpec,
		copyOpts?: { tapped?: boolean; tappedAndAttacking?: boolean }
		// --- End Track P7 ---
	): CardInstance;
	triggerOnEtb(state: GameState, controller: PlayerGameState, inst: CardInstance): void;
	triggerOnAttach(state: GameState, controller: PlayerGameState, attached: CardInstance, to: CardInstance): void;
	addCounters(state: GameState, inst: CardInstance, counter: CounterType, amount: number): number;
	proliferate(state: GameState, controller: PlayerGameState, chosenIds?: string[]): void;
	/** Scry or "look at the top N, put them back in any order": bot decision or human prompt. */
	scry(state: GameState, player: PlayerGameState, item: StackItem, count: number, mode: 'scry' | 'rearrange' | 'surveil', mayShuffle: boolean): void;
	search(state: GameState, player: PlayerGameState, spec: LibrarySearchSpec, item: StackItem): void;
	phaseOut(state: GameState, inst: CardInstance): void;
	/** CR 701.27 / 712: Transform a double-faced permanent on the battlefield. */
	transformPermanent(state: GameState, inst: CardInstance): boolean;
	/** CR 710.1: Flip a flip permanent to its flipped state. */
	flipPermanent(state: GameState, inst: CardInstance): boolean;
	endTurn(state: GameState, playerId: string): void;
	/** "The player whose turn it is may end the turn": ends it for a bot/the controller, else prompts. */
	activePlayerMayEndTurn(state: GameState, controller: PlayerGameState, sourceName: string): void;
	win(state: GameState, player: PlayerGameState, reason: string): void;
	lose(state: GameState, player: PlayerGameState, reason: string): void;
	/** CR 303.4f–g: Legal object/player ids an Aura entering without being cast may enchant, ranked by bot heuristic. */
	legalAuraAttachCandidates(state: GameState, aura: CardInstance, controller: PlayerGameState): string[];
	/** CR 707.10c / 115.7d: Computes target slots and currently legal candidates for retargeting a copied stack item. */
	getStackItemRetargetSlots(
		state: GameState,
		orig: StackItem,
		copyControllerId: string
	): StackItemRetargetSlot[];
	/** CR 707.10c / 115.7d: Validates a proposed per-spec retarget assignment for a copied stack item. */
	validateStackItemRetarget(
		state: GameState,
		orig: StackItem,
		copyControllerId: string,
		targetsBySpec: TargetRef[][]
	): boolean;
	/** Heuristic target assignment when a bot chooses new targets for a copied spell or ability. */
	chooseBotStackItemRetarget(
		state: GameState,
		bot: PlayerGameState,
		orig: StackItem,
		slots: StackItemRetargetSlot[],
		copyIndex: number
	): { targets: TargetRef[]; targetsBySpec: TargetRef[][] };
	/** CR 707.10 / 707.10b / 707.10f: Creates a copy of a spell or ability on the stack and emits copy/target events. */
	pushCopiedStackItem(
		state: GameState,
		controller: PlayerGameState,
		orig: StackItem,
		targets: TargetRef[],
		targetsBySpec: TargetRef[][] | undefined,
		opts?: { exceptColors?: ManaColor[]; nonLegendary?: boolean }
	): StackItem;
	/** CR 726.1–3: Makes `playerId` the monarch (no-op if already the monarch). */
	setMonarch(state: GameState, playerId: string): void;
	// --- Track P5 ---
	allocateFaceDownLabel(state: GameState): string;
}

export interface StackItemRetargetSlot {
	spec: TargetSpec;
	originalTargets: TargetRef[];
	legalCandidates: TargetRef[];
	zone: ZoneType | 'player';
}

let ports: EffectPorts | null = null;

export function registerEffectPorts(p: EffectPorts): void {
	ports = p;
	// --- Track P22d ---
	registerDamagePreventedHandler((state, shield, preventedAmount, opts) => {
		handleDamagePreventedWave8(state, shield, preventedAmount, {
			gainLife: gainPlayerLife,
			drawCards: p.drawCards,
			addCounters: p.addCounters,
			damageTarget: p.damageTarget,
			findPermanent: p.findPermanent,
			addLog: p.addLog
		});
		handleDamagePreventedWave10(state, shield, preventedAmount, opts, {
			dealDamageToPermanent: (st, target, amount, sourceId, srcInfo) =>
				dealDamageToPermanent(st, target, amount, sourceId, srcInfo),
			dealDamageToPlayer: (st, target, amount, sourceId, srcInfo) =>
				dealDamageToPlayer(st, target, amount, sourceId, srcInfo),
			addLog: p.addLog
		});
	});
	// --- End Track P22d ---
}

export function effectPorts(): EffectPorts {
	if (!ports) throw new Error('runtime/effects: engine ports not registered (import engine.ts first)');
	return ports;
}

// ---- Context and bindings -------------------------------------------------------------------

export interface EffectContext {
	/** "You": the controller of the resolving spell or ability. */
	controller: PlayerGameState;
	/** The source object (spell card, permanent with the ability). */
	sourceId: string;
	/** For log lines and protection checks only. */
	sourceCard: ScryfallCard;
	title: string;
	/** The resolving stack item (search/scry prompts hold on to it). */
	item: StackItem;
	/** Chosen targets that are still legal, all belonging to target spec 0. */
	targets: TargetRef[];
	targetSpecs: TargetSpec[];
	xValue: number;
	targetsBecomeEach?: boolean;
	/** Preferred colour when resolving an `addMana` step with `manaChoice`. */
	preferredColor?: ManaColor;
	/** Triggered abilities (Phase 5): the object and amount the trigger event was about. */
	eventObjectId?: string;
	eventAmount?: number;
	/** Steps C+D: the event object's version when the event happened (CR 400.7) and its LKI. */
	eventObjectVersion?: number;
	eventLki?: TriggerEventLki;
	/** "That player": the player the trigger event was about. */
	eventPlayerId?: string;
	/** The defending player for an attack trigger (CR 508.5, 702.86a). */
	defendingPlayerId?: string;
	/** Pre-hydrated bindings for a resolving `compiledDelayed` trigger (CR 603.7c). */
	initialBindings?: Record<string, EffectBindingSnapshot[]>;
	/** Step index prefix when resolving a nested `compiledDelayed` trigger. */
	stepPathPrefix?: number[];
	// --- Wave 10 ---
	w10LoopPlayerId?: string;
	w10ChosenOpponentId?: string;
	// --- End Wave 10 ---
}

export interface EffectResult {
	/** An "end the turn" step ran; the caller must stop resolving (CR 723). */
	turnEnded: boolean;
	/** The spell exiles itself as it resolves ("Exile ~."). */
	exileSelf: boolean;
	// --- Track P16a: counters placed on self-exiled resolving spell ("Exile ~ with N time counters on it") ---
	exileSelfWithCounters?: { counter: CounterType; count: number };
	/** The spell puts itself into its owner's library as it resolves (CR 401.2, 401.7, 608.2m). */
	// --- Track P16a: added optional `shuffle` ---
	librarySelf?: { position: 'top' | 'bottom'; fromTop?: number; shuffle?: boolean };
	/**
	 * Step E2: a human must choose before the steps can go on. The prompt is queued and the resume
	 * frame is stored on the stack item (`item.effectResume`); the caller leaves the item on the stack
	 * (CR 608.2n) and resolves it again, by id, once the prompt is answered.
	 */
	paused?: boolean;
}

/** Plain data (JSON-safe): bindings are serialised into the stack item when resolution pauses. */
export type Snapshot = EffectBindingSnapshot['lki'];
export type Bound = EffectBindingSnapshot;

export type Bindings = Map<string, Bound[]>;

// ---- Gating (compiler/interpretable.ts) ------------------------------------------------------

export { INTERPRETED_VERBS, optionalPrefix, withoutOptional } from '../compiler/interpretable.ts';
// --- Track P15 ---
export { staticallyInterpretableP15 };
// --- End Track P15 ---
// --- Track P18b ---
export { staticallyInterpretableP18b as staticallyInterpretable };
// --- End Track P18b ---

export function targetRefMatchesSpec(t: TargetRef, spec: TargetSpec): boolean {
	if (spec.kind === 'player') return t.kind === 'player';
	if (spec.kind === 'objectOrPlayer') return t.kind === 'player' || t.kind === 'permanent';
	const zone = spec.filter.zone;
	if (zone === 'stack') return t.kind === 'stack';
	// --- Precon Bragos Spirit ---
	if (spec.alsoSpells && t.kind === 'stack') return true;
	// --- End Precon Bragos Spirit ---
	if (zone === 'graveyard') return t.kind === 'graveyard_card' || t.kind === 'card_in_graveyard';
	if (zone === 'exile') return t.kind === 'exile_card';
	return t.kind === 'permanent';
}

/**
 * Checks that need the game state: the chosen targets fit the compiled target spec, and a human
 * chooser's prompt (scry, search) only happens at the last step (resuming after a prompt is not
 * implemented yet, so those fall back).
 */
export function interpretableNow(
	state: GameState,
	item: StackItem,
	parse: { steps: EffectStep[]; targets: TargetSpec[] },
	controller: PlayerGameState,
	targetsBecomeEach = Boolean(item.spellMods?.targetsBecomeEach)
): boolean {
	const kickerInfo = getObjectKickerInfo(state, item.card, item.sourceInstanceId, item);
	const activeTargets = parse.targets.filter(
		(sp) => !sp.condition || isConditionMetWithKicker(sp.condition, kickerInfo)
	);
	const spec = activeTargets[0];
	if (!spec) {
		if (item.targets.length > 0) return false;
	} else if (targetsBecomeEach) {
		if (spec.kind !== 'object') return false;
	} else if (activeTargets.length > 1) {
		const maxPossible = activeTargets.reduce((sum, sp) => sum + sp.max, 0);
		if (item.targets.length === 0 && activeTargets.some((sp) => sp.min > 0)) return false;
		if (item.targets.length > maxPossible) return false;
		if (!item.targets.every((t) => activeTargets.some((sp) => targetRefMatchesSpec(t, sp)))) return false;
	} else {
		// CR 608.2b: targets that became illegal were dropped; the spell resolves with the rest.
		if (item.targets.length === 0 && spec.min > 0) return false;
		if (item.targets.length > spec.max) return false;
		if (!item.targets.every((t) => targetRefMatchesSpec(t, spec))) return false;
	}
	// Step E2: an item on the stack can pause for a human's scry or search prompt and resume after
	// it. Anything else (an inline triggered mana ability) can't, so a human prompt must come last.
	if (state.stack.some((s) => s.id === item.id)) return true;
	const last = parse.steps.length - 1;
	for (let i = 0; i < parse.steps.length; i++) {
		const step = parse.steps[i];
		if (!PROMPTING_VERBS.has(step.verb) || i === last) continue;
		const chooser = step.actor ? playerFromRefStatic(state, step.actor, item, controller) : controller;
		if (!chooser || !chooser.isBot) return false;
	}
	return true;
}

/** Player lookup before any step has run (bindings are empty: a binding's controller is the target's). */
export function playerFromRefStatic(state: GameState, ref: PlayerRef, item: StackItem, controller: PlayerGameState): PlayerGameState | null {
	if (ref.k === 'you') return controller;
	if (ref.k === 'activePlayer') return state.players[state.activePlayerIndex] ?? null;
	if (ref.k === 'eventPlayer') return state.players.find((p) => p.playerId === item.eventPlayerId) ?? null;
	if (ref.k === 'defendingPlayer') {
		return item.defendingPlayerId
			? (state.players.find((p) => p.playerId === item.defendingPlayerId && !p.lost) ?? null)
			: null;
	}
	if (ref.k === 'controllerOf' || ref.k === 'ownerOf') {
		const t = item.targets[0];
		if (!t) return null;
		if (t.kind === 'stack') {
			const stackTarget = state.stack.find((x) => x.id === t.id || x.sourceInstanceId === t.id);
			if (!stackTarget) return null;
			const pid = ref.k === 'controllerOf' ? stackTarget.controllerId : (stackTarget.ownerId ?? stackTarget.controllerId);
			return state.players.find((p) => p.playerId === pid) ?? null;
		}
		const found = effectPorts().findPermanent(state, t.id);
		if (!found) return null;
		return ref.k === 'controllerOf' ? found.controller : found.owner;
	}
	if (ref.k !== 'target') return null;
	const t = item.targets[ref.index];
	return t?.kind === 'player' ? state.players.find((p) => p.playerId === t.id) ?? null : null;
}

// ---- Unified Damage Pipeline (CR 120.3–120.4, 122.1c, 702.16e, 702.80a, 702.90b–c) ---------

export interface SourceDamageInfo {
	hasDeathtouch: boolean;
	hasLifelink: boolean;
	hasInfect: boolean;
	hasWither: boolean;
	colors: ManaColor[];
	types: string[];
	// --- Track P9 ---
	toxicTotal?: number;
	// --- Track P11 ---
	sourceCard?: ScryfallCard;
	sourceControllerId?: string;
	// --- End Track P11 ---
}

export function sourceDamageInfo(
	state: GameState,
	sourcePerm: CardInstance | null,
	sourceCard: ScryfallCard
): SourceDamageInfo {
	// --- Track P20a ---
	const globalWither = hasGlobalAllDamageWither(state);
	// --- End Track P20a ---
	if (sourcePerm && sourcePerm.zone === 'battlefield') {
		const ev = evaluatePermanent(state, sourcePerm);
		const kws = ev.activeKeywords.map((k) => k.toLowerCase());
		return {
			hasDeathtouch: kws.includes('deathtouch'),
			hasLifelink: kws.includes('lifelink'),
			hasInfect: kws.includes('infect'),
			hasWither: globalWither || kws.includes('wither'),
			colors: sourcePerm.isFaceDown ? [] : [...ev.colors],
			types: ev.typeLine
				.split(/\s+[—-]\s+/)[0]
				.split(/\s+/)
				.filter(Boolean),
			// --- Track P9 ---
			toxicTotal: sumEvaluatedToxic(ev),
			// --- Track P11 ---
			sourceCard,
			sourceControllerId: ev.controllerId
			// --- End Track P11 ---
		};
	}
	const faceOpts = sourcePerm ? instanceFaceOptions(sourcePerm) : undefined;
	const view = resolveObjectFaces(sourceCard, faceOpts);
	const kws = new Set<string>((view.keywords ?? sourceCard.keywords ?? []).map((k) => k.toLowerCase()));
	for (const ab of activeAbilityDefs(sourceCard, faceOpts)) {
		if (ab.kind === 'keyword') kws.add(ab.keyword.name.toLowerCase());
	}
	return {
		hasDeathtouch: kws.has('deathtouch'),
		hasLifelink: kws.has('lifelink'),
		hasInfect: kws.has('infect'),
		hasWither: globalWither || kws.has('wither'),
		colors: [...view.colors],
		types: [...view.types],
		// --- Track P11 ---
		sourceCard,
		...(sourcePerm?.controllerId ? { sourceControllerId: sourcePerm.controllerId } : {})
		// --- End Track P11 ---
	};
}

export function permanentProtectedFromSource(
	state: GameState,
	target: CardInstance,
	srcInfo: SourceDamageInfo,
	evTarget?: ReturnType<typeof evaluatePermanent>
): boolean {
	const ev = evTarget ?? evaluatePermanent(state, target);
	// --- Track P20a (CR 702.16j): Protection from a player ---
	if (srcInfo.sourceControllerId && ev.protectionFromPlayerIds?.includes(srcInfo.sourceControllerId)) {
		return true;
	}
	// --- End Track P20a ---
	const colorMap: Record<string, ManaColor> = {
		white: 'W',
		blue: 'U',
		black: 'B',
		red: 'R',
		green: 'G'
	};
	const typeMap: Record<string, string> = {
		creatures: 'Creature',
		creature: 'Creature',
		artifacts: 'Artifact',
		artifact: 'Artifact',
		enchantments: 'Enchantment',
		enchantment: 'Enchantment',
		lands: 'Land',
		land: 'Land',
		planeswalkers: 'Planeswalker',
		planeswalker: 'Planeswalker',
		instants: 'Instant',
		instant: 'Instant',
		sorceries: 'Sorcery',
		sorcery: 'Sorcery',
		// --- Track P22a ---
		battles: 'Battle',
		battle: 'Battle',
		kindred: 'Kindred',
		tribal: 'Kindred'
		// --- End Track P22a ---
	};
	for (const kw of ev.activeKeywords) {
		const low = kw.toLowerCase();
		if (!low.startsWith('protection from ')) continue;
		const rawQual = low.slice('protection from '.length).trim();
		const quals = rawQual.split(/\s*(?:,\s*from\s+|\s+and\s+from\s+|\s+and\s+)\s*/i);
		for (const qual of quals) {
			if (qual === 'everything') return true;
			if (qual === 'all colors' && srcInfo.colors.length > 0) return true;
			if (qual === 'multicolored' && srcInfo.colors.length >= 2) return true;
			if (qual === 'monocolored' && srcInfo.colors.length === 1) return true;
			if (qual === 'colorless' && srcInfo.colors.length === 0) return true;
			if (colorMap[qual] && srcInfo.colors.includes(colorMap[qual])) return true;
			if (typeMap[qual] && srcInfo.types.some((t) => t.toLowerCase() === typeMap[qual].toLowerCase())) {
				return true;
			}
		}
	}
	return false;
}

export function dealDamageToPermanent(
	state: GameState,
	target: CardInstance,
	rawAmount: number,
	sourceId: string,
	srcInfo: SourceDamageInfo,
	opts?: { combat?: boolean; actorId?: string; vfxLabel?: string; redirectedByIds?: Set<string> }
): number {
	const p = effectPorts();
	const combat = opts?.combat ?? false;
	let dmg = rawAmount;
	if (dmg <= 0 || target.zone !== 'battlefield' || target.phasedOut) return 0;

	// --- Track P22a (CR 614.9 / 614.5): Static damage redirection ---
	const srcPermInitial = p.findPermanent(state, sourceId)?.inst;
	const stackSrcInitial = !srcPermInitial
		? state.stack.find((s) => s.id === sourceId || s.sourceInstanceId === sourceId)
		: undefined;
	const initialSrcCtrlId = srcInfo.sourceControllerId ?? stackSrcInitial?.controllerId ?? opts?.actorId;
	const initialSrcCard = srcInfo.sourceCard ?? stackSrcInitial?.card;
	{
		const redirectSet = opts?.redirectedByIds ?? new Set<string>();
		const redirectedPerm = resolveStaticDamageRedirection(
			state,
			'permanent',
			undefined,
			target,
			redirectSet
		);
		if (redirectedPerm && redirectedPerm.instanceId !== target.instanceId) {
			return dealDamageToPermanent(state, redirectedPerm, dmg, sourceId, srcInfo, {
				...opts,
				redirectedByIds: redirectSet
			});
		}
		const w10Redir = resolveWave10DamageRedirection(state, {
			isCombat: combat,
			targetKind: 'permanent',
			targetId: target.instanceId,
			targetPerm: target,
			targetControllerId: target.controllerId,
			sourceInst: srcPermInitial,
			sourceId,
			sourceCard: initialSrcCard,
			sourceControllerId: initialSrcCtrlId,
			sourceTypes: srcInfo.types,
			redirectedByIds: redirectSet
		});
		if (w10Redir) {
			if (w10Redir.kind === 'permanent' && w10Redir.perm.instanceId !== target.instanceId) {
				return dealDamageToPermanent(state, w10Redir.perm, dmg, sourceId, srcInfo, {
					...opts,
					redirectedByIds: redirectSet
				});
			}
			if (w10Redir.kind === 'player') {
				return dealDamageToPlayer(state, w10Redir.player, dmg, sourceId, srcInfo, {
					combat,
					vfxLabel: opts?.vfxLabel,
					redirectedByIds: redirectSet
				});
			}
		}
	}
	// --- End Track P22a ---

	const evTarget = evaluatePermanent(state, target);
	// --- Track P7 ---
	const unpreventable = isDamageUnpreventable(
		state,
		combat,
		// --- Track P22a ---
		{
			sourcePerm: srcPermInitial,
			sourceCard: initialSrcCard,
			sourceControllerId: initialSrcCtrlId
		}
		// --- End Track P22a ---
	);
	if (!unpreventable) {
		// CR 702.16b / 702.16e: Protection prevents all damage from sources with the stated quality.
		if (permanentProtectedFromSource(state, target, srcInfo, evTarget)) return 0;

		// CR 120.3 / 615.7: Damage prevention shield on permanent.
		if ((target.damagePreventionShield ?? 0) > 0) {
			const prevented = Math.min(dmg, target.damagePreventionShield!);
			target.damagePreventionShield! -= prevented;
			dmg -= prevented;
			if (dmg <= 0) return 0;
		}
	}

	// CR 122.1c / 615.12: If a permanent with a shield counter on it would be dealt damage,
	// prevent that damage (unless damage can't be prevented) and remove a shield counter from it.
	if ((target.counters.shield || 0) > 0) {
		target.counters.shield = Math.max(0, (target.counters.shield || 0) - 1);
		if (!unpreventable) {
			p.addLog(
				state,
				'rule',
				`A shield counter prevented ${dmg} damage to ${target.card.name} and was removed (CR 122.1c).`,
				opts?.actorId ?? target.controllerId
			);
			return 0;
		}
	}

	dmg = applyDamagePreventionShields(state, {
		amount: dmg,
		isCombat: combat,
		targetKind: 'permanent',
		targetId: target.instanceId,
		targetPerm: target,
		targetControllerId: target.controllerId,
		sourceInst: p.findPermanent(state, sourceId)?.inst,
		sourceId,
		sourceTypes: srcInfo.types,
		// --- Track P14 ---
		sourceCard: srcInfo.sourceCard,
		sourceControllerId: srcInfo.sourceControllerId
		// --- End Track P14 ---
	});
	if (dmg <= 0) return 0;
	// --- End Track P7 ---
	// --- Track P11 (CR 614.7a): Static damage addition/multiplication replacements ---
	let effSrcCtrlId: string | undefined;
	{
		const srcPerm = p.findPermanent(state, sourceId)?.inst;
		const stackSrc = !srcPerm
			? state.stack.find((s) => s.id === sourceId || s.sourceInstanceId === sourceId)
			: undefined;
		effSrcCtrlId = srcInfo.sourceControllerId ?? stackSrc?.controllerId ?? opts?.actorId;
		dmg = applyStaticDamageModifiers(state, dmg, {
			source: srcPerm,
			sourceCard: srcInfo.sourceCard ?? stackSrc?.card,
			sourceControllerId: effSrcCtrlId,
			isCombat: combat,
			targetKind: 'permanent',
			targetPermanent: target
		});
		// --- Track P20a ---
		dmg = applyChosenPlayerDamageModifiers(state, dmg, {
			isCombat: combat,
			targetKind: 'permanent',
			targetPermanent: target
		});
		// --- End Track P20a ---
		if (dmg <= 0) return 0;
	}
	// --- End Track P11 ---
	// --- Track P20a (CR 614.1a): Replace noncombat damage to opponent creature with -1/-1 counters ---
	if (
		shouldReplaceNoncombatDamageWithMinusCounters(
			state,
			target,
			evTarget.isCreature,
			combat,
			effSrcCtrlId
		)
	) {
		p.addCounters(state, target, '-1/-1', dmg);
		return 0;
	}
	// --- End Track P20a ---
	// --- Track P22a (CR 614.1a): Replace damage dealt to self with +1/+1 counters (*Phytohydra*) ---
	{
		const selfPlusCounter = shouldReplaceDamageWithCountersWave8(state, target);
		if (selfPlusCounter) {
			p.addCounters(state, target, selfPlusCounter, dmg);
			return 0;
		}
	}
	// --- End Track P22a ---

	// --- Track P15 (CR 120.3h / CR 310.6 / CR 310.11b): Damage dealt to a battle removes defense counters ---
	const targetIsBattle = isPermanentBattle(state, target);
	let battlePrevDef = 0;
	let battleNextDef = 0;
	let battleRemovedDef = 0;
	if (targetIsBattle) {
		battlePrevDef = target.counters.defense || 0;
		battleNextDef = Math.max(0, battlePrevDef - dmg);
		battleRemovedDef = battlePrevDef - battleNextDef;
		if (battleRemovedDef > 0) {
			target.counters.defense = battleNextDef;
			noteLayerInputsChanged(state);
		}
	}
	// --- End Track P15 ---

	if (evTarget.isPlaneswalker) {
		// CR 120.3c / 306.8: Damage dealt to a planeswalker removes that many loyalty counters.
		target.counters.loyalty = Math.max(0, (target.counters.loyalty || 0) - dmg);
	}
	if (evTarget.isCreature) {
		// --- Track P22b ---
		recordP22bExcessDamage(
			target,
			dmg,
			Boolean(srcInfo.hasDeathtouch),
			evTarget.isCreature,
			evTarget.toughness
		);
		// --- End Track P22b ---
		// CR 702.80 / 702.90b–c: Source with wither or infect deals damage to a creature in the form of -1/-1 counters.
		if (srcInfo.hasInfect || srcInfo.hasWither) {
			p.addCounters(state, target, '-1/-1', dmg);
		} else {
			target.damageMarked += dmg;
		}
		if (srcInfo.hasDeathtouch) {
			target.deathtouchDamageMarked = true;
		}
		// --- Track P10 ---
		if (dmg > 0 && sourceId) {
			const srcPerm = p.findPermanent(state, sourceId)?.inst;
			const srcVer = srcPerm?.objectVersion;
			const dmgList = (target.damagedByThisTurn ??= []);
			if (!dmgList.some((e) => e.sourceId === sourceId && e.sourceVersion === srcVer)) {
				dmgList.push({
					sourceId,
					...(srcVer !== undefined ? { sourceVersion: srcVer } : {}),
					...(effSrcCtrlId ? { sourceControllerId: effSrcCtrlId } : {})
				});
			}
		}
		// --- End Track P10 ---
	} else if (!evTarget.isPlaneswalker && !targetIsBattle) {
		target.damageMarked += dmg;
	}
	// --- Track P13 ---
	if (dmg > 0 && !target.dealtDamageThisTurn) {
		target.dealtDamageThisTurn = true;
		noteLayerInputsChanged(state);
	}
	// --- End Track P13 ---
	// --- Track P22a ---
	if (dmg > 0 && srcPermInitial && !srcPermInitial.dealtDamageEver) {
		srcPermInitial.dealtDamageEver = true;
		noteLayerInputsChanged(state);
	}
	// --- End Track P22a ---

	emitEvent(state, {
		kind: 'DamageDealt',
		sourceId,
		targetId: target.instanceId,
		targetKind: 'permanent',
		amount: dmg,
		combat
	});
	// --- Track P15 ---
	if (targetIsBattle && battleRemovedDef > 0) {
		emitEvent(state, {
			kind: 'CounterRemoved',
			objectId: target.instanceId,
			object: target,
			counterType: 'defense',
			amount: battleRemovedDef,
			previousCount: battlePrevDef,
			newCount: battleNextDef
		});
		onBattleDefenseCountersRemoved(state, target, battlePrevDef, battleNextDef);
	}
	// --- End Track P15 ---
	p.emitVfx(state, {
		kind: 'damage',
		...(combat ? { sourceId } : {}),
		targetId: target.instanceId,
		amount: dmg,
		...(opts?.vfxLabel ? { label: opts.vfxLabel } : {})
	});
	return dmg;
}

export function dealDamageToPlayer(
	state: GameState,
	pl: PlayerGameState,
	rawAmount: number,
	sourceId: string,
	srcInfo: SourceDamageInfo,
	opts?: {
		combat?: boolean;
		vfxSourceId?: string;
		vfxLabel?: string;
		redirectedByIds?: Set<string>;
	}
): number {
	const p = effectPorts();
	const combat = opts?.combat ?? false;
	let dmg = rawAmount;
	if (dmg <= 0 || pl.lost) return 0;
	// --- Track P22a ---
	const srcPermInitial = p.findPermanent(state, sourceId)?.inst;
	const stackSrcInitial = !srcPermInitial
		? state.stack.find((s) => s.id === sourceId || s.sourceInstanceId === sourceId)
		: undefined;
	const initialSrcCtrlId = srcInfo.sourceControllerId ?? stackSrcInitial?.controllerId;
	const initialSrcCard = srcInfo.sourceCard ?? stackSrcInitial?.card;
	// --- End Track P22a ---
	// --- Track P7 ---
	const unpreventable = isDamageUnpreventable(
		state,
		combat,
		// --- Track P22a ---
		{
			sourcePerm: srcPermInitial,
			sourceCard: initialSrcCard,
			sourceControllerId: initialSrcCtrlId
		}
		// --- End Track P22a ---
	);
	if (!unpreventable) {
		if (pl.protectionFromEverythingThisTurn) return 0;
		// --- Track P22a (CR 702.16j): Player protection from chosen card type ---
		if (playerProtectedFromSourceWave8(state, pl.playerId, initialSrcCard, srcPermInitial)) {
			return 0;
		}
		// --- End Track P22a ---

		if ((pl.damagePreventionShield ?? 0) > 0) {
			const prevented = Math.min(dmg, pl.damagePreventionShield!);
			pl.damagePreventionShield! -= prevented;
			dmg -= prevented;
			if (dmg <= 0) return 0;
		}
	}

	// --- Track P22a (CR 614.9 / 614.5): Static damage redirection (*Pariah* / *Palisade Giant*) ---
	{
		const redirectSet = opts?.redirectedByIds ?? new Set<string>();
		const redirectedPerm = resolveStaticDamageRedirection(
			state,
			'player',
			pl.playerId,
			undefined,
			redirectSet
		);
		if (redirectedPerm) {
			return dealDamageToPermanent(state, redirectedPerm, dmg, sourceId, srcInfo, {
				combat,
				actorId: initialSrcCtrlId,
				vfxLabel: opts?.vfxLabel,
				redirectedByIds: redirectSet
			});
		}
		const w10Redir = resolveWave10DamageRedirection(state, {
			isCombat: combat,
			targetKind: 'player',
			targetId: pl.playerId,
			sourceInst: srcPermInitial,
			sourceId,
			sourceCard: initialSrcCard,
			sourceControllerId: initialSrcCtrlId,
			sourceTypes: srcInfo.types,
			redirectedByIds: redirectSet
		});
		if (w10Redir) {
			if (w10Redir.kind === 'permanent') {
				return dealDamageToPermanent(state, w10Redir.perm, dmg, sourceId, srcInfo, {
					combat,
					actorId: initialSrcCtrlId,
					vfxLabel: opts?.vfxLabel,
					redirectedByIds: redirectSet
				});
			}
			if (w10Redir.kind === 'player' && w10Redir.player.playerId !== pl.playerId) {
				return dealDamageToPlayer(state, w10Redir.player, dmg, sourceId, srcInfo, {
					...opts,
					redirectedByIds: redirectSet
				});
			}
		}
	}
	// --- End Track P22a ---

	dmg = applyDamagePreventionShields(state, {
		amount: dmg,
		isCombat: combat,
		targetKind: 'player',
		targetId: pl.playerId,
		sourceInst: p.findPermanent(state, sourceId)?.inst,
		sourceId,
		sourceTypes: srcInfo.types,
		// --- Track P14 ---
		sourceCard: srcInfo.sourceCard,
		sourceControllerId: srcInfo.sourceControllerId
		// --- End Track P14 ---
	});
	if (dmg <= 0) return 0;
	// --- End Track P7 ---
	// --- Track P11 (CR 614.7a): Static damage addition/multiplication replacements ---
	{
		const srcPerm = p.findPermanent(state, sourceId)?.inst;
		const stackSrc = !srcPerm
			? state.stack.find((s) => s.id === sourceId || s.sourceInstanceId === sourceId)
			: undefined;
		dmg = applyStaticDamageModifiers(state, dmg, {
			source: srcPerm,
			sourceCard: srcInfo.sourceCard ?? stackSrc?.card,
			sourceControllerId: srcInfo.sourceControllerId ?? stackSrc?.controllerId,
			isCombat: combat,
			targetKind: 'player',
			targetPlayerId: pl.playerId
		});
		// --- Track P20a ---
		dmg = applyChosenPlayerDamageModifiers(state, dmg, {
			isCombat: combat,
			targetKind: 'player',
			targetPlayerId: pl.playerId
		});
		// --- End Track P20a ---
		if (dmg <= 0) return 0;
	}
	// --- End Track P11 ---

	if (
		srcInfo.hasInfect ||
		// --- Track P20a ---
		shouldDealDamageToPlayerAsInfect(state, pl.playerId)
		// --- End Track P20a ---
	) {
		// CR 702.90b: Damage dealt to a player by a source with infect is dealt in the form of poison counters.
		// --- Track P22a ---
		const poisonAdded = filterPlayerCountersGrantedWave8(state, pl.playerId, 'poison', dmg);
		if (poisonAdded > 0) {
			pl.poison = (pl.poison || 0) + poisonAdded;
		}
		// --- End Track P22a ---
	} else {
		const cantChange =
			Boolean(pl.lifeTotalCannotChangeThisTurn) ||
			activeRuleModifiers(state, 'lifeTotalCantChange', pl.playerId).length > 0;
		if (!cantChange) {
			dmg = applyWave10LifeFloor(state, pl, dmg);
			pl.life -= dmg;
			// --- Track P10 ---
			if (dmg > 0 && !pl.lostLifeThisTurn) {
				pl.lostLifeThisTurn = true;
				noteLayerInputsChanged(state);
			}
			// --- End Track P10 ---
			// --- Track P12 ---
			recordPlayerLifeLossWave4(pl, dmg);
			// --- End Track P12 ---
			// --- Track P15 ---
			if (dmg > 0) onPlayerLostLifeCheckSpeedTrigger(state, pl.playerId, dmg);
			// --- End Track P15 ---
		}
	}
	// --- Track P9 ---
	pl.damageDealtToThisTurn = (pl.damageDealtToThisTurn ?? 0) + dmg;
	if (combat && (srcInfo.toxicTotal ?? 0) > 0) {
		// --- Track P22a ---
		const toxicAdded = filterPlayerCountersGrantedWave8(
			state,
			pl.playerId,
			'poison',
			srcInfo.toxicTotal!
		);
		if (toxicAdded > 0) {
			pl.poison = (pl.poison || 0) + toxicAdded;
		}
		// --- End Track P22a ---
	}
	// --- Track P22a ---
	if (dmg > 0 && srcPermInitial && !srcPermInitial.dealtDamageEver) {
		srcPermInitial.dealtDamageEver = true;
		noteLayerInputsChanged(state);
	}
	// --- End Track P22a ---

	emitEvent(state, {
		kind: 'DamageDealt',
		sourceId,
		targetId: pl.playerId,
		targetKind: 'player',
		amount: dmg,
		combat
	});
	p.emitVfx(state, {
		kind: 'damage',
		sourceId: opts?.vfxSourceId ?? sourceId,
		targetId: pl.playerId,
		amount: dmg,
		...(opts?.vfxLabel ? { label: opts.vfxLabel } : {})
	});
	return dmg;
}

/**
 * CR 119.9–119.10: Single funnel for positive life gain. Gaining 0 life (or attempting to gain life
 * while `lifeTotalCantChange` applies) is not a life-gain event and does not emit `GainLife`.
 */
export function gainPlayerLife(
	state: GameState,
	player: PlayerGameState,
	amount: number
): number {
	if (amount <= 0 || player.lost) return 0;
	const cantChange =
		Boolean(player.lifeTotalCannotChangeThisTurn) ||
		activeRuleModifiers(state, 'lifeTotalCantChange', player.playerId).length > 0 ||
		// --- Track P11 (CR 119.7) ---
		playerCantGainLife(state, player.playerId);
	// --- End Track P11 ---
	if (cantChange) return 0;
	// --- Track P11 (CR 119.6, 119.10): Static life gain +N / ×2 replacements ---
	const finalAmount = applyStaticLifeGainModifiers(state, player.playerId, amount);
	if (finalAmount <= 0) return 0;
	player.life += finalAmount;
	// --- Track P7 ---
	recordLifeGainedThisTurn(state, player, finalAmount);
	// --- End Track P7 ---
	emitEvent(state, { kind: 'GainLife', playerId: player.playerId, amount: finalAmount });
	flushTriggers(state);
	return finalAmount;
	// --- End Track P11 ---
}

export function applyLifelinkGain(
	state: GameState,
	controller: PlayerGameState,
	totalDealt: number
): void {
	gainPlayerLife(state, controller, totalDealt);
}

// ---- Interpreter ----------------------------------------------------------------------------

export function proliferateCandidates(
	state: GameState,
	controller: PlayerGameState
): { candidates: string[]; defaultIds: string[] } {
	// --- Track P11 + Track P16a ---
	void ALL_COUNTER_TYPES;
	// --- End Track P11 + Track P16a ---
	const candidates: string[] = [];
	const defaultIds: string[] = [];
	for (const pl of state.players) {
		if (pl.lost) continue;
		const isSelf = pl.playerId === controller.playerId;
		for (const perm of pl.battlefield) {
			if (perm.phasedOut) continue;
			// --- Track P16a (CR 701.34a): Proliferate supports arbitrary & named counters ---
			const presentTypes = Object.entries(perm.counters)
				.filter(([, cnt]) => (cnt || 0) > 0)
				.map(([k]) => k);
			if (presentTypes.length > 0) {
				candidates.push(perm.instanceId);
				const hasWanted = presentTypes.some((cType) => {
					const isNeg =
						NEGATIVE_COUNTER_TYPES.has(cType as CounterType) ||
						cType === 'age' ||
						isNegativeArbitraryCounter(cType);
					return isSelf ? !isNeg : isNeg;
				});
				if (hasWanted) {
					defaultIds.push(perm.instanceId);
				}
			}
			// --- End Track P16a ---
		}
		if (
			pl.poison > 0 ||
			(pl.experienceCounters || 0) > 0 ||
			(pl.energyCounters || 0) > 0 ||
			// --- Track P16a ---
			(pl.radCounters || 0) > 0 ||
			(pl.ticketCounters || 0) > 0
			// --- End Track P16a ---
		) {
			candidates.push(pl.playerId);
			if (isSelf) {
				if (
					((pl.experienceCounters || 0) > 0 ||
						(pl.energyCounters || 0) > 0 ||
						(pl.ticketCounters || 0) > 0) &&
					pl.poison === 0 &&
					(pl.radCounters || 0) === 0
				) {
					defaultIds.push(pl.playerId);
				}
			} else if (pl.poison > 0 || (pl.radCounters || 0) > 0) {
				defaultIds.push(pl.playerId);
			}
		}
	}
	return { candidates, defaultIds };
}
export function compare(a: number, op: '>=' | '<=' | '=' | '>' | '<', b: number): boolean {
	switch (op) {
		case '>=':
			return a >= b;
		case '<=':
			return a <= b;
		case '=':
			return a === b;
		case '>':
			return a > b;
		case '<':
			return a < b;
	}
}

/** CR 700.5: mana symbols of the colours among the mana costs of permanents the player controls. */
export function devotion(player: PlayerGameState, colors: ManaColor[]): number {
	let total = 0;
	for (const perm of player.battlefield) {
		if (perm.phasedOut || perm.isFaceDown) continue;
		const cost = (perm.copiableCard ?? perm.card).manaCost ?? '';
		for (const sym of cost.match(/\{[^}]+\}/g) ?? []) {
			const upper = sym.toUpperCase();
			if (colors.some((c) => upper.includes(c))) total++;
		}
	}
	return total;
}

export const countDevotion = devotion;

const FIVE_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

export function commanderColors(player: PlayerGameState): ManaColor[] {
	const set = new Set<ManaColor>();
	for (const col of player.commanderColorIdentity ?? []) {
		if (col !== 'C') set.add(col);
	}
	const cards = [
		...player.command,
		...player.battlefield.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.graveyard.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.exile.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.hand.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.library.filter((c) => c.isCommander && c.ownerId === player.playerId)
	];
	for (const c of cards) {
		for (const col of c.card.colorIdentity) {
			if (col !== 'C') set.add(col);
		}
	}
	return FIVE_COLORS.filter((c) => set.has(c));
}

export function playerLandColors(
	state: GameState,
	player: PlayerGameState
): { direct: Set<ManaColor>; hasOrchard: boolean } {
	return ruleTreePlayerLandColors(state, player);
}

/**
 * CR 106.7: colours (`W | U | B | R | G`, never `C`) that any land an opponent of `controller`
 * controls could produce right now, accounting for continuous effects and opponent Exotic Orchards.
 */
export function opponentLandColors(state: GameState, controller: PlayerGameState): ManaColor[] {
	return ruleTreeOpponentLandColors(state, controller);
}

export function manaChoiceColors(
	state: GameState,
	controller: PlayerGameState,
	choice: NonNullable<NonNullable<EffectStep['params']>['manaChoice']>,
	chosenColor?: ManaColor,
	// --- Track P19a ---
	eventObjectId?: string
	// --- End Track P19a ---
): ManaColor[] {
	if (Array.isArray(choice)) return choice;
	// --- Track P19a ---
	if (
		choice === 'eventProducedTypes' ||
		choice === 'eventProducedColors' ||
		choice === 'controlledLandProducedTypes' ||
		choice === 'controlledLandProducedColors'
	) {
		return resolveP19aManaChoiceColors(state, controller, choice, eventObjectId);
	}
	// --- End Track P19a ---
	if (choice === 'any') return [...FIVE_COLORS];
	if (choice === 'commanderIdentity') {
		return commanderColors(controller);
	}
	if (choice === 'chosenColor') {
		return chosenColor ? [chosenColor] : [];
	}
	return opponentLandColors(state, controller);
}

export interface EffectRunAccess {
	readonly state: GameState;
	readonly ctx: EffectContext;
	readonly bindings: Bindings;
	readonly result: EffectResult;
	stepIndex: number;
	subStepIndex: number;
	phase: 'optional' | 'step' | 'afterStep';
	answers: Record<string, ChoiceAnswer>;
	stepDecisions: Record<number, boolean>;
	pendingOptionalCost?: EffectResumeFrame['pendingOptionalCost'];
	stepActedIds: string[];
	readonly canPause: boolean;
	readonly initialSnapshots: Map<string, Snapshot>;
	lastRollResult?: number;
	lastExcessDamage?: number;
	lastEffectAmount?: number;
	lastCountersRemoved?: number;
	lastCountedByKind?: Record<string, number>;
	lastInlineStepDecision?: boolean;
	lastExtraCombatSlotId?: string;
	readonly you: PlayerGameState;
	readonly sourcePerm: CardInstance | null;
	player(id: string): PlayerGameState | undefined;
	snapshot(inst: CardInstance): Snapshot;
	locate(id: string): { inst: CardInstance; holder: PlayerGameState; zone: 'battlefield' | 'graveyard' | 'exile' | 'hand' | 'library' | 'command' } | null;
	amount(a: Amount | undefined, fallback?: number): number;
	refSnapshot(ref: Ref, lki: boolean): Snapshot | null;
	kickerInfo(): KickerTrackingInfo;
	activeTargetSpecs(): Array<{ spec: TargetSpec; specIndex: number }>;
	targetsForSpecIndex(specIndex: number): TargetRef[];
	refId(ref: Ref): string | null;
	playerRef(ref: PlayerRef): PlayerGameState | null;
	apnapPlayers(): PlayerGameState[];
	players(sel: Selector): PlayerGameState[];
	objects(sel: Selector): CardInstance[];
	matches(c: CardInstance, f: ObjectFilter, zone: 'battlefield' | 'graveyard' | 'hand' | 'library' | 'exile'): boolean;
	sourceChosenSubType(): string | undefined;
	sourceChosenColor(): ManaColor | undefined;
	bind(step: EffectStep, objs: CardInstance[]): void;
	condition(c: Condition): boolean;
	resolveOptional(step: EffectStep): boolean;
	answered(chooserOrKey: PlayerGameState | string, candidates: CardInstance[], min: number, max?: number): CardInstance[] | null;
	pauseForChoice(chooser: PlayerGameState, title: string, description: string, candidates: string[], min: number, max: number, zone: ZoneType, defaultObjectIds?: string[], answerKey?: string, phase?: 'optional' | 'step' | 'afterStep'): void;
	pauseForOrder(chooser: PlayerGameState, title: string, description: string, objectIds: string[], answerKey: string): void;
	pauseForYesNo(chooser: PlayerGameState, title: string, question: string, answerKey: string, labels?: { yesLabel: string; noLabel: string }): void;
	pauseForNumber(chooser: PlayerGameState, title: string, reason: string, min: number, max: number, defaultNumber: number, answerKey: string): void;
	saveFrame(stepIndex: number, answers: Record<string, ChoiceAnswer>, phase?: 'optional' | 'step' | 'afterStep', subStepIndex?: number): StackItem;
	pauseForNestedPrompts(queued: PendingPrompt[], nextSubStepIndex: number): void;
	runIndexedBatch(batchKey: string, captureIds: () => string[], applyAt: (id: string, index: number) => MoveResult | string | void): { total: number; paused: boolean };
	syntheticLkiObject(instanceId: string, controllerId: string): CardInstance;
	captureTriggerEventLki(inst: CardInstance): TriggerEventLki;
	recordStepActedObject(inst: CardInstance, preSnap?: TriggerEventLki, died?: boolean): void;
	recordEffectAmount(n: number): void;
	recordCountedKind(kind: NonNullable<Extract<Amount, { k: 'countedThisWay' }>['kind']>, n: number): void;
	runInlineBranchSteps(inlineSteps: EffectStep[], subPathTag: number): boolean;
	p10Host(): P10EffectHost;
	p13AskFn(): P13StepAskFn;
	p13LifeFunnels(): P13LifeFunnels;
	runTrackedP13InlineSteps(inlineSteps: EffectStep[], tag: number, eventPlayerId?: string): boolean;
	p16aHost(): P16aStepHost;
	p19aHost(): P19aStepHost;
	keywordHost(): KeywordActionHost;
	sourceDamageInfo(sourcePerm: CardInstance | null, sourceCard: ScryfallCard): SourceDamageInfo;
	permanentProtectedFromSource(target: CardInstance, srcInfo: SourceDamageInfo): boolean;
	dealDamageToPermanent(target: CardInstance, rawAmount: number, sourceId: string, srcInfo: SourceDamageInfo): number;
	dealDamageToPlayer(pl: PlayerGameState, rawAmount: number, sourceId: string, srcInfo: SourceDamageInfo): number;
	applyLifelinkGain(controller: PlayerGameState, totalDealt: number): void;
	resolveDamageSource(dmgSrc: Selector | undefined): { srcPerm: CardInstance | null; srcId: string; srcCard: ScryfallCard; srcController: PlayerGameState } | null;
	sacrifice(step: EffectStep): void;
	discard(step: EffectStep): void;
	revealAndDiscard(step: EffectStep): void;
	exile(step: EffectStep): void;
	move(step: EffectStep): void;
	dig(step: EffectStep): void;
	goad(step: EffectStep): void;
	explore(step: EffectStep): void;
	connive(step: EffectStep): void;
	castNameLock(step: EffectStep): void;
	preventDamageStep(step: EffectStep): void;
	discardHandStep(step: EffectStep): void;
	damage(step: EffectStep): void;
	fight(step: EffectStep): void;
	delayed(step: EffectStep): void;
}
