/**
 * Effect interpreter (ENGINE_ARCHITECTURE_PLAN.md section 2.1 and Phase 3).
 *
 * Executes an ordered list of IR EffectSteps against GameState. Steps can refer to the results of
 * earlier steps through bindings ("it", "its controller", "that many"); a binding records the objects
 * a step acted on and a last-known-information snapshot of each taken just before the step ran
 * (CR 608.2h), so a later step reads the object as it last existed even after it changed zones.
 *
 * Rules for this file (the architecture ratchet enforces the first two):
 * - It never reads rules text or compares card names. Everything it knows about an ability comes from
 *   the IR; card names are used for log lines only.
 * - Every zone change goes through runtime/zones.ts moveObject (directly or via an engine port).
 * - Engine primitives (damage, destroy with dies triggers, search prompts, ...) are reached through
 *   `EffectPorts`, registered by engine.ts at load, so there is no import cycle with the engine.
 *
 * Entry points: `executeEffectSteps(state, ctx, steps)` runs steps; `staticallyInterpretable` and
 * `interpretableNow` decide whether an ability can resolve here or must use the legacy
 * executeParsedEffect path (Phase 3 switches verbs over one at a time; see INTERPRETED_VERBS).
 * Phase 5 can call executeEffectSteps for triggered abilities with `eventObjectId`/`eventAmount`.
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
import { cardManaSteps } from '../compiler/index.ts';
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
import { evaluatePermanent, inspectCardContinuousBreakdown } from '../ruleTree.ts';
import { enqueueChoicePrompt } from './choices.ts';
import { emitEvent } from './events.ts';
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
import { noteLayerInputsChanged } from './layerCache.ts';
import {
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
import { activeRuleModifiers, applySelfEtbReplacements, tokenMultiplier } from './replace.ts';
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
			candidateIds: string[];
	  }
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
}

function P(): EffectPorts {
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
}

export interface EffectResult {
	/** An "end the turn" step ran; the caller must stop resolving (CR 723). */
	turnEnded: boolean;
	/** The spell exiles itself as it resolves ("Exile ~."). */
	exileSelf: boolean;
	/** The spell puts itself into its owner's library as it resolves (CR 401.2, 401.7, 608.2m). */
	librarySelf?: { position: 'top' | 'bottom'; fromTop?: number };
	/**
	 * Step E2: a human must choose before the steps can go on. The prompt is queued and the resume
	 * frame is stored on the stack item (`item.effectResume`); the caller leaves the item on the stack
	 * (CR 608.2n) and resolves it again, by id, once the prompt is answered.
	 */
	paused?: boolean;
}

/** Plain data (JSON-safe): bindings are serialised into the stack item when resolution pauses. */
type Snapshot = EffectBindingSnapshot['lki'];
type Bound = EffectBindingSnapshot;

type Bindings = Map<string, Bound[]>;

// ---- Gating (compiler/interpretable.ts) ------------------------------------------------------

export { INTERPRETED_VERBS, optionalPrefix, staticallyInterpretable, withoutOptional } from '../compiler/interpretable.ts';

function targetRefMatchesSpec(t: TargetRef, spec: TargetSpec): boolean {
	if (spec.kind === 'player') return t.kind === 'player';
	if (spec.kind === 'objectOrPlayer') return t.kind === 'player' || t.kind === 'permanent';
	const zone = spec.filter.zone;
	if (zone === 'stack') return t.kind === 'stack';
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
function playerFromRefStatic(state: GameState, ref: PlayerRef, item: StackItem, controller: PlayerGameState): PlayerGameState | null {
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
		const found = P().findPermanent(state, t.id);
		if (!found) return null;
		return ref.k === 'controllerOf' ? found.controller : found.owner;
	}
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
	if (sourcePerm && sourcePerm.zone === 'battlefield') {
		const ev = evaluatePermanent(state, sourcePerm);
		const kws = ev.activeKeywords.map((k) => k.toLowerCase());
		return {
			hasDeathtouch: kws.includes('deathtouch'),
			hasLifelink: kws.includes('lifelink'),
			hasInfect: kws.includes('infect'),
			hasWither: kws.includes('wither'),
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
		hasWither: kws.has('wither'),
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
		sorcery: 'Sorcery'
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
	opts?: { combat?: boolean; actorId?: string; vfxLabel?: string }
): number {
	const p = P();
	const combat = opts?.combat ?? false;
	let dmg = rawAmount;
	if (dmg <= 0 || target.zone !== 'battlefield' || target.phasedOut) return 0;

	const evTarget = evaluatePermanent(state, target);
	// --- Track P7 ---
	const unpreventable = isDamageUnpreventable(state, combat);
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
	{
		const srcPerm = p.findPermanent(state, sourceId)?.inst;
		const stackSrc = !srcPerm
			? state.stack.find((s) => s.id === sourceId || s.sourceInstanceId === sourceId)
			: undefined;
		dmg = applyStaticDamageModifiers(state, dmg, {
			source: srcPerm,
			sourceCard: srcInfo.sourceCard ?? stackSrc?.card,
			sourceControllerId:
				srcInfo.sourceControllerId ?? stackSrc?.controllerId ?? opts?.actorId,
			isCombat: combat,
			targetKind: 'permanent',
			targetPermanent: target
		});
		if (dmg <= 0) return 0;
	}
	// --- End Track P11 ---

	if (evTarget.isPlaneswalker) {
		// CR 120.3c / 306.8: Damage dealt to a planeswalker removes that many loyalty counters.
		target.counters.loyalty = Math.max(0, (target.counters.loyalty || 0) - dmg);
	}
	if (evTarget.isCreature) {
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
					...(srcVer !== undefined ? { sourceVersion: srcVer } : {})
				});
			}
		}
		// --- End Track P10 ---
	} else if (!evTarget.isPlaneswalker) {
		target.damageMarked += dmg;
	}
	// --- Track P13 ---
	if (dmg > 0 && !target.dealtDamageThisTurn) {
		target.dealtDamageThisTurn = true;
		noteLayerInputsChanged(state);
	}
	// --- End Track P13 ---

	emitEvent(state, {
		kind: 'DamageDealt',
		sourceId,
		targetId: target.instanceId,
		targetKind: 'permanent',
		amount: dmg,
		combat
	});
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
	opts?: { combat?: boolean; vfxSourceId?: string; vfxLabel?: string }
): number {
	const p = P();
	const combat = opts?.combat ?? false;
	let dmg = rawAmount;
	if (dmg <= 0 || pl.lost) return 0;
	// --- Track P7 ---
	const unpreventable = isDamageUnpreventable(state, combat);
	if (!unpreventable) {
		if (pl.protectionFromEverythingThisTurn) return 0;

		if ((pl.damagePreventionShield ?? 0) > 0) {
			const prevented = Math.min(dmg, pl.damagePreventionShield!);
			pl.damagePreventionShield! -= prevented;
			dmg -= prevented;
			if (dmg <= 0) return 0;
		}
	}

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
		if (dmg <= 0) return 0;
	}
	// --- End Track P11 ---

	if (srcInfo.hasInfect) {
		// CR 702.90b: Damage dealt to a player by a source with infect is dealt in the form of poison counters.
		pl.poison = (pl.poison || 0) + dmg;
	} else {
		const cantChange =
			Boolean(pl.lifeTotalCannotChangeThisTurn) ||
			activeRuleModifiers(state, 'lifeTotalCantChange', pl.playerId).length > 0;
		if (!cantChange) {
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
		}
	}
	// --- Track P9 ---
	pl.damageDealtToThisTurn = (pl.damageDealtToThisTurn ?? 0) + dmg;
	if (combat && (srcInfo.toxicTotal ?? 0) > 0) {
		pl.poison = (pl.poison || 0) + srcInfo.toxicTotal!;
	}

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
	// --- Track P11 ---
	const allCounterTypes = ALL_COUNTER_TYPES;
	const controllerPositiveTypes = ALL_COUNTER_TYPES.filter(
		(c) => !NEGATIVE_COUNTER_TYPES.has(c) && c !== 'age'
	);
	const opponentNegativeTypes = ALL_COUNTER_TYPES.filter(
		(c) => NEGATIVE_COUNTER_TYPES.has(c) || c === 'age'
	);
	// --- End Track P11 ---
	const candidates: string[] = [];
	const defaultIds: string[] = [];
	for (const pl of state.players) {
		if (pl.lost) continue;
		const isSelf = pl.playerId === controller.playerId;
		for (const perm of pl.battlefield) {
			if (perm.phasedOut) continue;
			if (allCounterTypes.some((cType) => (perm.counters[cType] || 0) > 0)) {
				candidates.push(perm.instanceId);
				const wantTypes = isSelf ? controllerPositiveTypes : opponentNegativeTypes;
				if (wantTypes.some((cType) => (perm.counters[cType] || 0) > 0)) {
					defaultIds.push(perm.instanceId);
				}
			}
		}
		if (
			pl.poison > 0 ||
			(pl.experienceCounters || 0) > 0 ||
			(pl.energyCounters || 0) > 0
		) {
			candidates.push(pl.playerId);
			if (isSelf) {
				if (
					((pl.experienceCounters || 0) > 0 || (pl.energyCounters || 0) > 0) &&
					pl.poison === 0
				) {
					defaultIds.push(pl.playerId);
				}
			} else if (pl.poison > 0) {
				defaultIds.push(pl.playerId);
			}
		}
	}
	return { candidates, defaultIds };
}

class Run {
	readonly state: GameState;
	readonly ctx: EffectContext;
	readonly bindings: Bindings = new Map();
	readonly result: EffectResult = { turnEnded: false, exileSelf: false };
	/** Index of the step being executed. */
	stepIndex = 0;
	/** Sub-step cursor within a step when pausing across multiple actors/items. */
	subStepIndex = 0;
	/** Current phase within `stepIndex` when resuming. */
	phase: 'optional' | 'step' | 'afterStep' = 'optional';
	/** Choices made by humans for the current step while it was paused (slot key -> ChoiceAnswer). */
	answers: Record<string, ChoiceAnswer> = {};
	/** Decisions recorded for optional steps (`stepIndex -> accepted`) for "If you do, ...". */
	stepDecisions: Record<number, boolean> = {};
	/** Serialized in-progress optional cost payment when paused on replacement choice. */
	pendingOptionalCost?: EffectResumeFrame['pendingOptionalCost'];
	/** Can this run pause for a human (the item is on the stack, so it can be resumed by id)? */
	readonly canPause: boolean;
	readonly initialSnapshots = new Map<string, Snapshot>();
	// --- Track P10 ---
	lastRollResult?: number;
	// --- Track P13 ---
	lastExcessDamage?: number;
	lastEffectAmount?: number;
	// --- End Track P13 ---
	currentSteps: EffectStep[] = [];
	subPathPrefix?: number[];
	private stepActedIds: string[] = [];
	private stepDiedIds = new Set<string>();
	private stepPreSnapshots = new Map<string, TriggerEventLki>();
	private saveFrameOverride?: (
		stepIndex: number,
		answers: Record<string, ChoiceAnswer>,
		phase: 'optional' | 'step' | 'afterStep',
		subStepIndex: number
	) => StackItem;
	// --- End Track P10 ---

	constructor(state: GameState, ctx: EffectContext, resume?: EffectResumeFrame) {
		this.state = state;
		this.ctx = ctx;
		this.canPause = state.stack.some((s) => s.id === ctx.item.id);
		// --- Track P10 ---
		this.subPathPrefix = ctx.stepPathPrefix ? [...ctx.stepPathPrefix] : undefined;
		this.lastRollResult = resume?.lastRollResult ?? ctx.item.lastRollResult;
		// --- End Track P10 ---
		// --- Track P13 ---
		this.lastExcessDamage = resume?.lastExcessDamage ?? ctx.item.lastExcessDamage;
		this.lastEffectAmount = resume?.lastEffectAmount ?? ctx.item.lastEffectAmount;
		// --- End Track P13 ---
		for (const t of ctx.targets) {
			const f = this.locate(t.id);
			if (f) this.initialSnapshots.set(t.id, this.snapshot(f.inst));
		}
		if (ctx.sourceId) {
			const f = this.locate(ctx.sourceId);
			if (f) this.initialSnapshots.set(ctx.sourceId, this.snapshot(f.inst));
		}
		if (ctx.eventObjectId) {
			const f = this.locate(ctx.eventObjectId);
			if (f) this.initialSnapshots.set(ctx.eventObjectId, this.snapshot(f.inst));
		}
		if (resume) {
			this.stepIndex = resume.stepIndex;
			this.subStepIndex = resume.subStepIndex ?? 0;
			this.phase = resume.phase ?? 'step';
			for (const [name, bound] of resume.bindings) this.bindings.set(name, bound.map((b) => ({ id: b.id, lki: { ...b.lki } })));
			this.result.exileSelf = Boolean(resume.exileSelf);
			if (resume.librarySelf) this.result.librarySelf = { ...resume.librarySelf };
			this.answers = { ...resume.answers };
			this.stepDecisions = { ...(resume.stepDecisions ?? {}) };
			this.pendingOptionalCost = resume.pendingOptionalCost
				? {
						...resume.pendingOptionalCost,
						parts: resume.pendingOptionalCost.parts.map((part) => ({ ...part })),
						descriptions: [...resume.pendingOptionalCost.descriptions]
					}
				: undefined;
		} else if (ctx.initialBindings) {
			for (const [name, bound] of Object.entries(ctx.initialBindings)) {
				this.bindings.set(name, bound.map((b) => ({ id: b.id, lki: { ...b.lki } })));
			}
		}
	}

	/**
	 * A human must choose objects for the current step. Queues a chooseObjects prompt whose
	 * continuation names this stack item and step, saves the resume frame on the stack item, and
	 * stops the run. Nothing of the step has happened yet (the step runs again from its start on
	 * resume, with `answers` filled in), so simultaneous choices stay simultaneous (CR 101.4).
	 */
	pauseForChoice(
		chooser: PlayerGameState,
		title: string,
		description: string,
		candidates: string[],
		min: number,
		max: number,
		zone: ZoneType,
		defaultObjectIds?: string[],
		answerKey?: string,
		phase: 'optional' | 'step' | 'afterStep' = 'step'
	): void {
		const item = this.saveFrame(this.stepIndex, this.answers, phase, this.subStepIndex);
		enqueueChoicePrompt(this.state, {
			id: P().uid('prompt', this.state),
			kind: 'chooseObjects',
			playerId: chooser.playerId,
			title,
			description,
			candidateInstanceIds: candidates,
			countRequired: min,
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: this.stepIndex,
				...(answerKey ? { answerKey } : {})
			},
			choice: {
				kind: 'chooseObjects',
				candidates,
				min,
				max,
				zone,
				reason: title,
				...(defaultObjectIds ? { defaultObjectIds } : {})
			}
		});
		this.result.paused = true;
	}

	pauseForOrder(
		chooser: PlayerGameState,
		title: string,
		description: string,
		objectIds: string[],
		answerKey: string
	): void {
		const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
		enqueueChoicePrompt(this.state, {
			id: P().uid('prompt', this.state),
			kind: 'orderObjects',
			playerId: chooser.playerId,
			title,
			description,
			candidateInstanceIds: objectIds,
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: this.stepIndex,
				answerKey
			},
			choice: {
				kind: 'orderObjects',
				objectIds,
				allowSplitBottom: false,
				allowShuffle: false,
				reason: description
			}
		});
		this.result.paused = true;
	}

	/** Queues a `yesNo` prompt within the current step (`phase = 'step'`) and pauses execution. */
	pauseForYesNo(
		chooser: PlayerGameState,
		title: string,
		question: string,
		answerKey: string,
		labels?: { yesLabel: string; noLabel: string }
	): void {
		const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
		enqueueChoicePrompt(this.state, {
			id: P().uid('prompt', this.state),
			kind: 'yesNo',
			purpose: 'generic',
			playerId: chooser.playerId,
			title,
			description: question,
			yesLabel: labels?.yesLabel ?? 'Yes',
			noLabel: labels?.noLabel ?? 'No',
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: this.stepIndex,
				answerKey
			},
			choice: { kind: 'yesNo', question }
		});
		this.result.paused = true;
	}

	/** Queues a `chooseNumber` prompt within the current step (`phase = 'step'`) and pauses execution. */
	pauseForNumber(
		chooser: PlayerGameState,
		title: string,
		reason: string,
		min: number,
		max: number,
		defaultNumber: number,
		answerKey: string
	): void {
		const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
		enqueueChoicePrompt(this.state, {
			id: P().uid('prompt', this.state),
			kind: 'chooseNumber',
			purpose: 'generic',
			playerId: chooser.playerId,
			title,
			description: reason,
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: this.stepIndex,
				answerKey
			},
			choice: {
				kind: 'chooseNumber',
				min,
				max,
				defaultNumber,
				reason
			}
		});
		this.result.paused = true;
	}

	/** Queues a `yesNo` prompt for an optional step (`step.optional`) and pauses execution. */
	pauseForOptional(
		chooser: PlayerGameState,
		question: string,
		answerKey: string,
		labels?: { yesLabel: string; noLabel: string }
	): void {
		const item = this.saveFrame(this.stepIndex, this.answers, 'optional', this.subStepIndex);
		const isTriggered = this.ctx.item.kind === 'triggered';
		enqueueChoicePrompt(this.state, {
			id: P().uid('prompt', this.state),
			kind: 'yesNo',
			purpose: isTriggered ? 'trigger_may' : 'generic',
			playerId: chooser.playerId,
			title: isTriggered ? `Optional Ability (${this.ctx.sourceCard.name})` : `${this.ctx.title} — Optional Effect`,
			description: question,
			...(isTriggered ? { triggerStackItemId: item.id } : {}),
			yesLabel: labels?.yesLabel ?? 'Yes',
			noLabel: labels?.noLabel ?? 'No',
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: this.stepIndex,
				answerKey
			},
			choice: { kind: 'yesNo', question }
		});
		this.result.paused = true;
	}

	botAcceptsOptional(step: EffectStep, chooser: PlayerGameState): boolean {
		if (step.verb === 'draw' && chooser.library.length <= 3) return false;
		// --- Track P10 ---
		if (step.verb === 'sacrifice' || step.verb === 'loseLife' || step.verb === 'discard') {
			const hasPayoff =
				Boolean(step.params?.reflexiveTrigger) ||
				this.currentSteps.some((st) => st.ifPrecedingAccepted === this.stepIndex);
			if (!hasPayoff || chooser.playerId !== this.you.playerId) return false;
			if (step.verb === 'loseLife' && this.amount(step.amount, 0) >= chooser.life) return false;
			return true;
		}
		// --- End Track P10 ---
		if (step.verb === 'search' && chooser.library.length === 0) return false;
		return true;
	}

	// --- Track P10 ---
	/** CR 118.12: An optional action cannot be accepted if the chooser cannot legally perform it. */
	private canPerformOptionalActionStep(step: EffectStep, chooser: PlayerGameState): boolean {
		const sel = step.subject;
		if (step.verb === 'sacrifice') {
			const actor = step.actor ? (this.playerRef(step.actor) ?? chooser) : chooser;
			if (sel.k === 'self' || sel.k === 'binding' || sel.k === 'target' || sel.k === 'eventObject') {
				const objs = this.objects(sel).filter(
					(o) =>
						o.zone === 'battlefield' &&
						o.controllerId === actor.playerId &&
						(sel.k !== 'self' ||
							this.ctx.item.sourceObjectVersion === undefined ||
							(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
				);
				return objs.length > 0;
			}
			const required = sel.k === 'all' && !step.amount ? 1 : Math.max(1, this.amount(step.amount, 1));
			const filter: ObjectFilter = sel.k === 'all' ? { ...sel.filter, controller: undefined } : {};
			const cands = actor.battlefield.filter(
				(c) => !c.phasedOut && c.controllerId === actor.playerId && this.matches(c, filter, 'battlefield')
			);
			return cands.length >= required;
		}
		if (step.verb === 'discard') {
			const actor = step.actor ? (this.playerRef(step.actor) ?? chooser) : chooser;
			if (sel.k === 'self' || sel.k === 'binding') {
				return this.objects(sel).some((o) => o.zone === 'hand');
			}
			const required = sel.k === 'all' && !step.amount ? 1 : Math.max(1, this.amount(step.amount, 1));
			const filter: ObjectFilter | null =
				sel.k === 'all' ? { ...sel.filter, controller: undefined, owner: undefined } : null;
			const cands = filter
				? actor.hand.filter((c) => this.matches(c, filter, 'hand'))
				: actor.hand;
			return cands.length >= required;
		}
		if (step.verb === 'removeCounters') {
			const counter = step.params?.counter ?? '+1/+1';
			const want = Math.max(1, this.amount(step.amount, 1));
			return this.objects(sel).some(
				(o) => o.zone === 'battlefield' && !o.phasedOut && (o.counters[counter] || 0) >= want
			);
		}
		if (step.verb === 'forage') {
			const actor = step.actor ? (this.playerRef(step.actor) ?? chooser) : chooser;
			const hasFood = actor.battlefield.some(
				(c) => !c.phasedOut && evaluatePermanent(this.state, c).hasSubType('Food')
			);
			return hasFood || actor.graveyard.length >= 3;
		}
		if (step.verb === 'collectEvidence') {
			const actor = step.actor ? (this.playerRef(step.actor) ?? chooser) : chooser;
			const need = Math.max(0, this.amount(step.amount, 1));
			if (need <= 0) return true;
			let totalMv = 0;
			for (const c of actor.graveyard) totalMv += Math.max(0, objectManaValue(this.state, c));
			return totalMv >= need;
		}
		if (step.verb === 'blight') {
			const actor = step.actor ? (this.playerRef(step.actor) ?? chooser) : chooser;
			return actor.battlefield.some((c) => !c.phasedOut && evaluatePermanent(this.state, c).isCreature);
		}
		return true;
	}
	// --- End Track P10 ---

	botAcceptsOptionalCost(
		_step: EffectStep,
		chooser: PlayerGameState,
		cost: CostDef[],
		mode: 'doIfPaid' | 'doUnlessPaid'
	): boolean {
		for (const c of cost) {
			if (c.k === 'payLife' && this.amount(c.amount, 0) >= chooser.life) return false;
		}
		if (mode === 'doUnlessPaid') return true;
		if (chooser.playerId !== this.you.playerId) {
			return !cost.some((c) => c.k === 'sacrifice' || c.k === 'discard' || c.k === 'exileFrom');
		}
		return true;
	}

	private executeOptionalCostPayment(
		chooser: PlayerGameState,
		cost: CostDef[],
		executeIfPaid: (paid: boolean) => boolean
	): boolean {
		const res = P().payOptionalCost(
			this.state,
			chooser,
			this.ctx.item,
			this.stepIndex,
			cost,
			this.answers,
			this.pendingOptionalCost
		);
		if (res.status === 'needChoice') {
			if (!this.canPause) {
				this.pendingOptionalCost = undefined;
				this.stepDecisions[this.stepIndex] = false;
				return executeIfPaid(false);
			}
			this.pauseForChoice(
				chooser,
				`${this.ctx.title} — Pay Optional Cost`,
				`Choose ${res.count}: ${res.label}.`,
				res.candidateIds,
				res.count,
				res.count,
				res.zone,
				undefined,
				res.answerKey,
				'optional'
			);
			return false;
		}
		if (res.status === 'paused') {
			this.pendingOptionalCost = res.pending;
			this.saveFrame(this.stepIndex, this.answers, 'optional', this.subStepIndex);
			this.linkPromptsToStackStep(res.queued, this.stepIndex);
			this.result.paused = true;
			return false;
		}
		this.pendingOptionalCost = undefined;
		if (res.status === 'failed') {
			this.stepDecisions[this.stepIndex] = false;
			P().addLog(
				this.state,
				this.ctx.item.kind === 'triggered' ? 'trigger' : 'rule',
				`${chooser.username} did not pay ${describeCost(cost)} for ${this.ctx.title}.`,
				chooser.playerId
			);
			return executeIfPaid(false);
		}
		this.stepDecisions[this.stepIndex] = true;
		return executeIfPaid(true);
	}

	resolveOptional(step: EffectStep): boolean {
		const opt = step.optional!;
		const mode = opt.mode ?? 'doIfPaid';
		const executeIfPaid = (paid: boolean) => (mode === 'doUnlessPaid' ? !paid : paid);
		const prior = this.stepDecisions[this.stepIndex];
		if (prior !== undefined) return executeIfPaid(prior);

		const cost = opt.cost;
		const hasCost = Boolean(cost && cost.length > 0);
		const chooser = this.playerRef(opt.chooser) ?? this.you;
		if (!chooser || chooser.lost) {
			this.stepDecisions[this.stepIndex] = false;
			return executeIfPaid(false);
		}
		// --- Track P10 ---
		if (!hasCost && !this.canPerformOptionalActionStep(step, chooser)) {
			this.stepDecisions[this.stepIndex] = false;
			return executeIfPaid(false);
		}
		// --- End Track P10 ---
		if (!hasCost && this.ctx.item.optionalAccepted !== undefined && opt.chooser.k === 'you') {
			const yes = this.ctx.item.optionalAccepted;
			this.stepDecisions[this.stepIndex] = yes;
			return executeIfPaid(yes);
		}

		if (hasCost && this.pendingOptionalCost && this.pendingOptionalCost.stepIndex === this.stepIndex) {
			return this.executeOptionalCostPayment(chooser, cost!, executeIfPaid);
		}

		const optKey = `opt:${this.stepIndex}`;
		const ans = this.answers[optKey];
		if (ans?.kind === 'yesNo') {
			if (!ans.yes) {
				this.stepDecisions[this.stepIndex] = false;
				P().addLog(
					this.state,
					this.ctx.item.kind === 'triggered' ? 'trigger' : 'rule',
					hasCost
						? `${chooser.username} declined to pay ${describeCost(cost!)} for ${this.ctx.title}.`
						: `${chooser.username} declined to use ${this.ctx.title}'s optional effect.`,
					chooser.playerId
				);
				return executeIfPaid(false);
			}
			if (!hasCost) {
				this.stepDecisions[this.stepIndex] = true;
				P().addLog(
					this.state,
					this.ctx.item.kind === 'triggered' ? 'trigger' : 'rule',
					`${chooser.username} chose to use ${this.ctx.title}'s optional effect.`,
					chooser.playerId
				);
				return executeIfPaid(true);
			}
			return this.executeOptionalCostPayment(chooser, cost!, executeIfPaid);
		}

		if (hasCost && !P().canPayOptionalCost(this.state, chooser, this.ctx.item, cost!)) {
			this.stepDecisions[this.stepIndex] = false;
			P().addLog(
				this.state,
				this.ctx.item.kind === 'triggered' ? 'trigger' : 'rule',
				`${chooser.username} could not pay ${describeCost(cost!)} for ${this.ctx.title}.`,
				chooser.playerId
			);
			return executeIfPaid(false);
		}

		if (chooser.isBot) {
			const yes = hasCost
				? this.botAcceptsOptionalCost(step, chooser, cost!, mode)
				: this.botAcceptsOptional(step, chooser);
			if (!yes) {
				this.stepDecisions[this.stepIndex] = false;
				P().addLog(
					this.state,
					this.ctx.item.kind === 'triggered' ? 'trigger' : 'rule',
					hasCost
						? `${chooser.username} declined to pay ${describeCost(cost!)} for ${this.ctx.title}.`
						: `${chooser.username} declined to use ${this.ctx.title}'s optional effect.`,
					chooser.playerId
				);
				return executeIfPaid(false);
			}
			if (!hasCost) {
				this.stepDecisions[this.stepIndex] = true;
				P().addLog(
					this.state,
					this.ctx.item.kind === 'triggered' ? 'trigger' : 'rule',
					`${chooser.username} chose to use ${this.ctx.title}'s optional effect.`,
					chooser.playerId
				);
				return executeIfPaid(true);
			}
			return this.executeOptionalCostPayment(chooser, cost!, executeIfPaid);
		}

		if (!this.canPause) {
			if (!hasCost) {
				this.stepDecisions[this.stepIndex] = true;
				return executeIfPaid(true);
			}
			return this.executeOptionalCostPayment(chooser, cost!, executeIfPaid);
		}

		let question: string;
		if (hasCost) {
			const costDesc = describeCost(cost!);
			question =
				mode === 'doUnlessPaid'
					? `${this.ctx.title}: ${chooser.username} may pay ${costDesc} to prevent this effect. Pay ${costDesc}?`
					: `${this.ctx.title}: May ${chooser.username} pay ${costDesc}?`;
		} else {
			question =
				step.verb === 'search'
					? `${this.ctx.title}: May ${chooser.username} search their library${step.params?.search?.description ? ` for ${step.params.search.description}` : ''}?`
					: `Use the optional effect of ${this.ctx.title}?`;
		}
		this.pauseForOptional(
			chooser,
			question,
			optKey,
			hasCost ? { yesLabel: 'Pay', noLabel: "Don't Pay" } : undefined
		);
		return false;
	}

	/** Stores the resume frame (plain data) on the stack item and returns the item. */
	saveFrame(
		stepIndex: number,
		answers: Record<string, ChoiceAnswer>,
		phase: 'optional' | 'step' | 'afterStep' = this.phase,
		subStepIndex = this.subStepIndex
	): StackItem {
		// --- Track P10 ---
		if (this.saveFrameOverride) {
			return this.saveFrameOverride(stepIndex, answers, phase, subStepIndex);
		}
		// --- End Track P10 ---
		const item = this.state.stack.find((s) => s.id === this.ctx.item.id)!;
		item.effectResume = {
			stepIndex,
			...(subStepIndex > 0 ? { subStepIndex } : {}),
			phase,
			bindings: [...this.bindings.entries()].map(([name, bound]) => [name, bound.map((b) => ({ id: b.id, lki: { ...b.lki } }))]),
			exileSelf: this.result.exileSelf || undefined,
			...(this.result.librarySelf ? { librarySelf: { ...this.result.librarySelf } } : {}),
			answers: { ...answers },
			...(Object.keys(this.stepDecisions).length > 0
				? { stepDecisions: { ...this.stepDecisions } }
				: {}),
			...(this.pendingOptionalCost ? { pendingOptionalCost: this.pendingOptionalCost } : {}),
			// --- Track P10 ---
			...(this.lastRollResult !== undefined ? { lastRollResult: this.lastRollResult } : {}),
			// --- End Track P10 ---
			// --- Track P13 ---
			...(this.lastExcessDamage !== undefined ? { lastExcessDamage: this.lastExcessDamage } : {}),
			...(this.lastEffectAmount !== undefined ? { lastEffectAmount: this.lastEffectAmount } : {})
			// --- End Track P13 ---
		};
		return item;
	}

	private isNestedBlockingPrompt(pr: PendingPrompt): boolean {
		return (
			pr.choice?.kind === 'chooseReplacement' ||
			pr.kind === 'chooseReplacement' ||
			pr.kind === 'commander_zone_choice' ||
			pr.purpose === 'end_turn' ||
			pr.purpose === 'etb_choice' ||
			(pr.continuation?.kind === 'procedure' &&
				(pr.continuation.procedure.kind === 'commander_zone_choice' ||
					pr.continuation.procedure.kind === 'end_turn' ||
					pr.continuation.procedure.kind === 'zone_replacement_choice' ||
					pr.continuation.procedure.kind === 'counter_replacement_choice'))
		);
	}

	private linkPromptsToStackStep(queued: PendingPrompt[], resumeStepIndex: number): void {
		const item = this.state.stack.find((s) => s.id === this.ctx.item.id);
		if (!item) return;
		for (const pr of queued) {
			if (pr.continuation?.kind === 'handler') {
				const data = (pr.continuation.data ??= {});
				data.resumeStackItemId = item.id;
				data.resumeStepIndex = resumeStepIndex;
			} else if (pr.continuation?.kind === 'procedure') {
				const proc = pr.continuation.procedure;
				if (
					proc.kind === 'zone_replacement_choice' ||
					proc.kind === 'counter_replacement_choice' ||
					proc.kind === 'aura_library_attach_choice' ||
					proc.kind === 'commander_zone_choice' ||
					proc.kind === 'end_turn'
				) {
					proc.resumeStackItemId = item.id;
					proc.resumeStepIndex = resumeStepIndex;
				}
			} else if (pr.kind === 'commander_zone_choice') {
				pr.continuation = {
					kind: 'procedure',
					procedure: {
						kind: 'commander_zone_choice',
						commanderInstanceId: pr.commanderInstanceId ?? '',
						destinationZone: pr.destinationZone ?? 'graveyard',
						resumeStackItemId: item.id,
						resumeStepIndex
					}
				};
			} else if (!pr.continuation && pr.kind === 'scry_choice') {
				pr.continuation = {
					kind: 'effect_resume',
					stackItemId: item.id,
					stepIndex: resumeStepIndex
				};
			}
		}
		if (
			this.state.pendingProcedure?.kind === 'surveil_graveyard' &&
			!this.state.pendingProcedure.resumeStackItemId
		) {
			this.state.pendingProcedure.resumeStackItemId = item.id;
			this.state.pendingProcedure.resumeStepIndex = resumeStepIndex;
		}
	}

	private pauseForNestedPrompts(queued: PendingPrompt[], nextSubStepIndex: number): void {
		this.saveFrame(this.stepIndex, this.answers, 'step', nextSubStepIndex);
		this.linkPromptsToStackStep(queued, this.stepIndex);
		this.result.paused = true;
	}

	/**
	 * Captures a batch of ids once (`batchKey`) and executes `applyAt` from `this.subStepIndex`.
	 * Stops immediately if any entry queues a replacement/procedure prompt so later entries wait
	 * until resume.
	 */
	runIndexedBatch(
		batchKey: string,
		captureIds: () => string[],
		applyAt: (id: string, index: number) => MoveResult | string | void
	): { total: number; paused: boolean } {
		let ids: string[];
		if (this.answers[batchKey]?.kind === 'chooseObjects') {
			ids = this.answers[batchKey].objectIds;
		} else {
			ids = captureIds();
			if (ids.length > 0 && this.canPause) {
				this.answers[batchKey] = { kind: 'chooseObjects', objectIds: ids };
			}
		}
		for (let i = this.subStepIndex; i < ids.length; i++) {
			this.subStepIndex = i;
			const promptsBefore = this.state.pendingPrompts.length;
			const res = applyAt(ids[i], i);
			if (this.result.paused) {
				return { total: ids.length, paused: true };
			}
			const queued = this.state.pendingPrompts.slice(promptsBefore);
			if (this.canPause && (res === 'pending' || queued.some((pr) => this.isNestedBlockingPrompt(pr)))) {
				this.pauseForNestedPrompts(queued, i + 1);
				return { total: ids.length, paused: true };
			}
		}
		this.subStepIndex = 0;
		return { total: ids.length, paused: false };
	}

	/**
	 * The objects `chooser` (or slot key) picks for the current step: a human's stored answer, or
	 * null when the human hasn't answered yet (the caller pauses). Answers naming objects that are
	 * no longer candidates are dropped, and missing picks are filled from the remaining candidates.
	 */
	answered(chooserOrKey: PlayerGameState | string, candidates: CardInstance[], min: number, max = min): CardInstance[] | null {
		const key = typeof chooserOrKey === 'string' ? chooserOrKey : chooserOrKey.playerId;
		const ans = this.answers[key];
		if (!ans || ans.kind !== 'chooseObjects') return null;
		const ids = ans.objectIds;
		const picked = ids.map((id) => candidates.find((c) => c.instanceId === id)).filter((c): c is CardInstance => Boolean(c));
		for (const c of candidates) if (picked.length < min && !picked.includes(c)) picked.push(c);
		return picked.slice(0, max);
	}

	get you(): PlayerGameState {
		return this.ctx.controller;
	}

	get sourcePerm(): CardInstance | null {
		return this.locate(this.ctx.sourceId)?.inst ?? null;
	}

	player(id: string): PlayerGameState | undefined {
		return this.state.players.find((p) => p.playerId === id);
	}

	snapshot(inst: CardInstance): Snapshot {
		const onBattlefield = inst.zone === 'battlefield';
		return {
			controllerId: inst.controllerId,
			ownerId: inst.ownerId,
			power: onBattlefield ? P().power(this.state, inst) : parseInt(inst.card.power ?? '0', 10) || 0,
			toughness: onBattlefield ? P().toughness(this.state, inst) : parseInt(inst.card.toughness ?? '0', 10) || 0,
			manaValue: objectManaValue(this.state, inst)
		};
	}

	/** Finds an object by id in any zone (battlefield first). */
	locate(id: string): { inst: CardInstance; holder: PlayerGameState; zone: 'battlefield' | 'graveyard' | 'exile' | 'hand' | 'library' | 'command' } | null {
		for (const zone of ['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command'] as const) {
			for (const p of this.state.players) {
				const inst = p[zone].find((c) => c.instanceId === id);
				if (inst) return { inst, holder: p, zone };
			}
		}
		return null;
	}

	// ---- Amounts

	amount(a: Amount | undefined, fallback = 0): number {
		if (!a) return fallback;
		switch (a.k) {
			case 'const':
				return a.n;
			case 'x':
				return this.ctx.xValue;
			case 'negate':
				return -this.amount(a.of);
			case 'sum':
				return a.args.reduce((s, x) => s + this.amount(x), 0);
			case 'min':
				return Math.min(...a.args.map((x) => this.amount(x)));
			case 'max':
				return Math.max(...a.args.map((x) => this.amount(x)));
			case 'count':
				return this.objects({ k: 'all', filter: a.of }).length;
			case 'resultCount':
				return this.bindings.get(a.of)?.length ?? 0;
			case 'eventAmount':
				return this.ctx.eventAmount ?? 0;
			case 'life': {
				const p = this.playerRef(a.of);
				return p ? p.life : 0;
			}
			case 'energyCount': {
				const p = this.playerRef(a.player);
				return p ? (p.energyCounters ?? 0) : 0;
			}
			case 'cardsIn': {
				const p = this.playerRef(a.of);
				return p ? p[a.zone === 'stack' ? 'hand' : (a.zone as 'hand')].length : 0;
			}
			case 'devotion': {
				// --- Track P13 + Track P14 ---
				if (a.player) {
					const p = this.playerRef(a.player);
					return p ? computeDevotionToColors(this.state, p.playerId, a.colors) : 0;
				}
				return computeDevotionTo(this.state, this.you.playerId, a.colors);
				// --- End Track P13 + Track P14 ---
			}
			case 'commanderCastCount':
				return playerCommanderCastCount(this.state, this.you.playerId);
			case 'stormCount':
				return this.ctx.item.stormCount ?? 0;
			case 'colorsOfManaSpentToCast':
				return this.sourcePerm?.manaColorsSpent?.length ?? this.ctx.item.manaColorsSpent?.length ?? 0;
			case 'kickedCount':
				return evaluateKickedCountAmount(a, this.kickerInfo());
			case 'tappedCostPower': {
				const tappedId = this.ctx.item.stationTappedId;
				if (tappedId) {
					const found = this.locate(tappedId);
					if (
						found &&
						found.zone === 'battlefield' &&
						!found.inst.phasedOut &&
						(this.ctx.item.stationTappedVersion === undefined ||
							(found.inst.objectVersion ?? 1) === this.ctx.item.stationTappedVersion)
					) {
						return Math.max(0, P().power(this.state, found.inst));
					}
				}
				return Math.max(0, this.ctx.item.tappedCostPower ?? 0);
			}
			case 'countersOn': {
				const id = this.refId(a.of);
				const found = id ? this.locate(id) : null;
				if (!found || found.zone !== 'battlefield' || found.inst.phasedOut) return 0;
				if (
					a.of.k === 'self' &&
					this.ctx.item.sourceObjectVersion !== undefined &&
					(found.inst.objectVersion ?? 1) !== this.ctx.item.sourceObjectVersion
				) {
					return 0;
				}
				// --- Track P8 ---
				if (a.counter === 'any') {
					return Object.values(found.inst.counters).reduce((acc, n) => acc + (n > 0 ? n : 0), 0);
				}
				return found.inst.counters[a.counter] ?? 0;
			}
			case 'stat': {
				const snap = this.refSnapshot(a.of, Boolean(a.lki));
				if (!snap) return 0;
				return a.stat === 'power' ? snap.power : a.stat === 'toughness' ? snap.toughness : snap.manaValue;
			}
			// --- Track P8 ---
			case 'distinctCardTypesInZone':
				return countDistinctCardTypesInZone(this.state, this.you.playerId, a.zone, a.whose);
			// --- Track P9 ---
			case 'lkiCounterCount':
				return this.ctx.eventLki?.counters?.[a.counter] ?? 0;
			// --- Track P10 ---
			case 'lastRollResult':
				return this.lastRollResult ?? this.ctx.item.lastRollResult ?? 0;
			// --- End Track P10 ---
			// --- Track P12 ---
			case 'devouredCount':
				return this.ctx.item?.sourceDevouredCount ?? this.sourcePerm?.devouredCount ?? 0;
			case 'opponentCount':
				return this.state.players.filter((p) => !p.lost && p.playerId !== this.you.playerId).length;
			// --- End Track P12 ---
			// --- Track P11 ---
			case 'mul':
				return a.factor * this.amount(a.of);
			case 'domain': {
				const p = this.playerRef(a.player);
				return p ? computeDomainCount(this.state, p.playerId) : 0;
			}
			case 'partyCount': {
				const p = this.playerRef(a.player);
				return p ? computePartyCount(this.state, p.playerId) : 0;
			}
			case 'attachmentsOn': {
				const src = this.sourcePerm ?? undefined;
				const hostId =
					a.target === 'self'
						? (src?.instanceId ?? this.ctx.sourceId)
						: src?.attachedToId;
				return computeAttachmentsOnCount(
					this.state,
					hostId,
					a.filter,
					this.you.playerId,
					src
				);
			}
			// --- End Track P11 ---
			// --- Track P13 ---
			case 'unlockedDoorsCount': {
				const p = this.playerRef(a.player);
				return p ? computeUnlockedDoorsCount(this.state, p.playerId) : 0;
			}
			case 'excessDamage':
				return this.lastExcessDamage ?? this.ctx.item.lastExcessDamage ?? 0;
			case 'lastEffectAmount':
				return this.lastEffectAmount ?? this.ctx.item.lastEffectAmount ?? 0;
			case 'colorsAmongPermanents': {
				const p = this.playerRef(a.player);
				const pid = p ? p.playerId : this.you.playerId;
				return computeColorsAmongPermanents(this.state, pid, a.filter, (inst, f) =>
					this.matches(inst, f, 'battlefield')
				);
			}
			case 'half': {
				const v = this.amount(a.of);
				return a.round === 'up' ? Math.ceil(v / 2) : Math.floor(v / 2);
			}
			case 'dungeonsCompleted': {
				const p = this.playerRef(a.player);
				return p ? (p.dungeonsCompletedCount ?? 0) : 0;
			}
			case 'greatestStatAmong': {
				const z = (Array.isArray(a.filter.zone) ? a.filter.zone[0] : (a.filter.zone ?? 'battlefield')) as
					| 'battlefield'
					| 'graveyard'
					| 'hand'
					| 'library'
					| 'exile';
				return computeStatAggregateAmong(this.state, a.filter, a.stat, 'greatest', (inst, f) =>
					this.matches(inst, f, z)
				);
			}
			case 'totalStatAmong': {
				const z = (Array.isArray(a.filter.zone) ? a.filter.zone[0] : (a.filter.zone ?? 'battlefield')) as
					| 'battlefield'
					| 'graveyard'
					| 'hand'
					| 'library'
					| 'exile';
				return computeStatAggregateAmong(this.state, a.filter, a.stat, 'total', (inst, f) =>
					this.matches(inst, f, z)
				);
			}
			// --- End Track P13 ---
			// --- Track P14 ---
			case 'targetsBeyondFirst':
			case 'colorsOfObject':
			case 'totalStatOf':
			case 'anyNumber': {
				const srcFound = this.locate(this.ctx.sourceId);
				return (
					evaluateWave5Amount(a, {
						state: this.state,
						controllerId: this.you.playerId,
						source: srcFound?.inst,
						stackItem: this.ctx.item,
						xValue: this.ctx.xValue
					}) ?? 0
				);
			}
			// --- End Track P14 ---
		}
	}

	refSnapshot(ref: Ref, lki: boolean): Snapshot | null {
		if (ref.k === 'binding') {
			const b = this.bindings.get(ref.name)?.[0];
			if (!b) return null;
			if (lki) return b.lki;
			const now = this.locate(b.id);
			return now ? this.snapshot(now.inst) : b.lki;
		}
		const id = this.refId(ref);
		const found = id ? this.locate(id) : null;
		if (ref.k === 'eventObject') {
			// CR 608.2h / 400.7: the event object as it is now if it's still the same object on the
			// battlefield; otherwise (it died, or a "dies" trigger) as it last existed there.
			const same =
				found &&
				found.zone === 'battlefield' &&
				(this.ctx.eventObjectVersion === undefined || found.inst.objectVersion === this.ctx.eventObjectVersion);
			if (same) return this.snapshot(found.inst);
			if (this.ctx.eventLki) return { ...this.ctx.eventLki };
			if (found) return this.snapshot(found.inst);
			// CR 603.2 / 701.47 / 701.53: for 'cast' triggers ("Whenever you cast a noncreature spell,
			// amass Orcs X, where X is that spell's mana value"), fall back to the triggering stack item.
			const trigSpell =
				this.ctx.item?.triggerEventStackItem ??
				(id
					? this.state.stack.find(
							(st) => st.id !== this.ctx.item?.id && (st.id === id || st.sourceInstanceId === id)
						)
					: undefined);
			if (trigSpell) {
				return {
					controllerId: trigSpell.controllerId,
					ownerId: trigSpell.ownerId ?? trigSpell.controllerId,
					power: 0,
					toughness: 0,
					manaValue: objectManaValue(this.state, trigSpell)
				};
			}
			return null;
		}
		if (ref.k === 'self') {
			const expectedVer = this.ctx.item?.sourceObjectVersion;
			const stillOnBattlefield =
				found &&
				found.zone === 'battlefield' &&
				(expectedVer === undefined || found.inst.objectVersion === expectedVer);
			if (stillOnBattlefield) {
				return this.snapshot(found.inst);
			}
			const lkiPower =
				this.ctx.item?.sourceLkiPower ??
				found?.inst.lastKnownPower ??
				this.ctx.item?.lkiPower ??
				(parseInt(this.ctx.sourceCard.power ?? '0', 10) || 0);
			const lkiToughness =
				this.ctx.item?.sourceLkiToughness ??
				found?.inst.lastKnownToughness ??
				this.ctx.item?.lkiToughness ??
				(parseInt(this.ctx.sourceCard.toughness ?? '0', 10) || 0);
			return {
				controllerId: this.ctx.controller.playerId,
				ownerId: found?.inst.ownerId ?? this.ctx.controller.playerId,
				power: lkiPower,
				toughness: lkiToughness,
				manaValue: found
					? objectManaValue(this.state, found.inst)
					: this.ctx.item
						? objectManaValue(this.state, this.ctx.item)
						: this.ctx.sourceCard.cmc
			};
		}
		if (found) return this.snapshot(found.inst);
		if (id) {
			const stackTarget = this.state.stack.find((x) => x.id === id || x.sourceInstanceId === id);
			if (stackTarget) {
				return {
					controllerId: stackTarget.controllerId,
					ownerId: stackTarget.ownerId ?? stackTarget.controllerId,
					power: 0,
					toughness: 0,
					manaValue: objectManaValue(this.state, stackTarget)
				};
			}
			for (const [_, bList] of this.bindings) {
				const b = bList.find((x) => x.id === id);
				if (b) return { ...b.lki };
			}
			const initSnap = this.initialSnapshots.get(id);
			if (initSnap) return { ...initSnap };
		}
		return null;
	}

	kickerInfo(): KickerTrackingInfo {
		return getObjectKickerInfo(this.state, this.ctx.item.card, this.ctx.sourceId, this.ctx.item);
	}

	activeTargetSpecs(): Array<{ spec: TargetSpec; specIndex: number }> {
		const out: Array<{ spec: TargetSpec; specIndex: number }> = [];
		for (let i = 0; i < this.ctx.targetSpecs.length; i++) {
			const spec = this.ctx.targetSpecs[i];
			if (!spec.condition || this.condition(spec.condition)) {
				out.push({ spec, specIndex: i });
			}
		}
		return out;
	}

	targetsForSpecIndex(specIndex: number): TargetRef[] {
		if (this.ctx.item?.targetsBySpec && specIndex < this.ctx.item.targetsBySpec.length) {
			return this.ctx.item.targetsBySpec[specIndex] ?? [];
		}
		if (this.ctx.targetSpecs.length === 0) {
			return specIndex === 0 ? this.ctx.targets : [];
		}
		const active = this.activeTargetSpecs();
		const pos = active.findIndex((entry) => entry.specIndex === specIndex);
		if (pos < 0) return [];
		if (active.length <= 1) return this.ctx.targets;
		if (this.ctx.targets.length === active.length) {
			const ref = this.ctx.targets[pos];
			return ref ? [ref] : [];
		}
		const spec = active[pos].spec;
		return this.ctx.targets.filter((t) => targetRefMatchesSpec(t, spec));
	}

	refId(ref: Ref): string | null {
		switch (ref.k) {
			case 'self':
				return this.ctx.sourceId;
			case 'target':
				return this.targetsForSpecIndex(ref.index)[0]?.id ?? null;
			case 'binding':
				return this.bindings.get(ref.name)?.[0]?.id ?? null;
			case 'eventObject':
				return this.ctx.eventObjectId ?? null;
			case 'attachedTo': {
				const src = this.locate(this.ctx.sourceId)?.inst;
				return src && src.zone === 'battlefield' && !src.phasedOut ? (src.attachedToId ?? null) : null;
			}
			case 'affected':
				return null;
		}
	}

	playerRef(ref: PlayerRef): PlayerGameState | null {
		switch (ref.k) {
			case 'you':
				return this.you;
			case 'activePlayer':
				return this.state.players[this.state.activePlayerIndex] ?? null;
			case 'eventPlayer':
				return this.ctx.eventPlayerId ? (this.player(this.ctx.eventPlayerId) ?? null) : null;
			case 'defendingPlayer': {
				const pl = this.ctx.defendingPlayerId ? (this.player(this.ctx.defendingPlayerId) ?? null) : null;
				return pl && !pl.lost ? pl : null;
			}
			case 'target': {
				const t = this.targetsForSpecIndex(ref.index)[0];
				return t?.kind === 'player' ? (this.player(t.id) ?? null) : null;
			}
			case 'controllerOf':
			case 'ownerOf': {
				const snap = this.refSnapshot(ref.of, true);
				if (!snap) return null;
				return this.player(ref.k === 'controllerOf' ? snap.controllerId : snap.ownerId) ?? null;
			}
		}
	}

	// ---- Selectors

	/** CR 101.4: Active Player, Non-Active Player (APNAP) turn order starting from `state.activePlayerIndex`. */
	apnapPlayers(): PlayerGameState[] {
		const n = this.state.players.length;
		if (n === 0) return [];
		const start = (((this.state.activePlayerIndex ?? 0) % n) + n) % n;
		const out: PlayerGameState[] = [];
		for (let i = 0; i < n; i++) {
			const pl = this.state.players[(start + i) % n];
			if (pl && !pl.lost) out.push(pl);
		}
		return out;
	}

	players(sel: Selector): PlayerGameState[] {
		if (sel.k === 'playerRef') {
			const p = this.playerRef(sel.ref);
			return p && !p.lost ? [p] : [];
		}
		if (sel.k === 'target') {
			const refs = this.targetsForSpecIndex(sel.index);
			return refs
				.filter((t): t is TargetRef => Boolean(t && t.kind === 'player'))
				.map((t) => this.player(t.id))
				.filter((p): p is PlayerGameState => Boolean(p && !p.lost));
		}
		if (sel.k !== 'player') return [];
		switch (sel.filter.relation) {
			case 'you':
				return [this.you];
			case 'each_opponent':
			case 'opponent':
				return this.apnapPlayers().filter((p) => p.playerId !== this.you.playerId);
			case 'each_player':
			case 'any':
				return this.apnapPlayers();
			case 'target':
				return this.players({ k: 'target', index: 0 });
		}
	}

	/** Objects a selector refers to, in their current zones. */
	objects(sel: Selector): CardInstance[] {
		switch (sel.k) {
			case 'self': {
				const f = this.locate(this.ctx.sourceId);
				return f ? [f.inst] : [];
			}
			case 'binding':
				return (this.bindings.get(sel.name) ?? [])
					.map((b) => this.locate(b.id)?.inst)
					.filter((c): c is CardInstance => Boolean(c && !(c.zone === 'battlefield' && c.phasedOut)));
			case 'target': {
				if (this.ctx.targetsBecomeEach ?? this.ctx.item.spellMods?.targetsBecomeEach) {
					const spec = this.ctx.targetSpecs[sel.index];
					if (spec?.condition && !this.condition(spec.condition)) return [];
					return spec ? this.objects({ k: 'all', filter: spec.filter }) : [];
				}
				const refs = this.targetsForSpecIndex(sel.index);
				return refs
					.filter((t) => t.kind !== 'player' && t.kind !== 'stack')
					.map((t) => this.locate(t.id)?.inst)
					.filter((c): c is CardInstance => Boolean(c && !c.phasedOut));
			}
			case 'eventObject': {
				// CR 400.7: once the event object changes zones again it's a new object.
				const f = this.ctx.eventObjectId ? this.locate(this.ctx.eventObjectId) : null;
				if (!f || f.inst.phasedOut) return [];
				if (this.ctx.eventObjectVersion !== undefined && f.inst.objectVersion !== this.ctx.eventObjectVersion) return [];
				return [f.inst];
			}
			case 'attachedTo': {
				const src = this.locate(this.ctx.sourceId)?.inst;
				if (!src || src.zone !== 'battlefield' || src.phasedOut || !src.attachedToId) return [];
				const host = this.locate(src.attachedToId)?.inst;
				return host && host.zone === 'battlefield' && !host.phasedOut ? [host] : [];
			}
			case 'all': {
				const zone = sel.filter.zone ?? 'battlefield';
				const out: CardInstance[] = [];
				for (const p of this.apnapPlayers()) {
					if (zone === 'battlefield') {
						for (const c of p.battlefield) if (!c.phasedOut && this.matches(c, sel.filter, 'battlefield')) out.push(c);
					} else if (zone === 'graveyard') {
						for (const c of p.graveyard) if (this.matches(c, sel.filter, 'graveyard')) out.push(c);
					} else if (zone === 'hand') {
						for (const c of p.hand) if (this.matches(c, sel.filter, 'hand')) out.push(c);
					} else if (zone === 'exile') {
						for (const c of p.exile) if (this.matches(c, sel.filter, 'exile')) out.push(c);
					}
				}
				return out;
			}
			case 'libraryTop': {
				const pl = (sel.player ? this.playerRef(sel.player) : null) ?? this.you;
				return pl && pl.library.length > 0 ? [pl.library[0]] : [];
			}
			default:
				return [];
		}
	}

	private sourceChosenSubType(): string | undefined {
		const src = this.locate(this.ctx.sourceId)?.inst;
		return src?.chosenSubType ?? this.ctx.item.sourceChosenSubType;
	}

	private sourceChosenColor(): ManaColor | undefined {
		const src = this.locate(this.ctx.sourceId)?.inst;
		return src?.chosenColor ?? this.ctx.item.sourceChosenColor;
	}

	matches(c: CardInstance, f: ObjectFilter, zone: 'battlefield' | 'graveyard' | 'hand' | 'library' | 'exile'): boolean {
		// --- Track P13 ---
		if (f.anyOf && !f.anyOf.some((branch) => this.matches(c, branch, zone))) return false;
		// --- End Track P13 ---
		const ev = zone === 'battlefield' ? evaluatePermanent(this.state, c) : null;
		const card = c.copiableCard ?? c.card;
		const typeLine = ev ? ev.typeLine : card.typeLine;
		const hasSub = (s: string) =>
			ev ? ev.hasSubType(s) : matchesObjectFilter(c, { subtypes: [s] }, { state: this.state, controllerId: this.you.playerId });
		if (f.types && !f.types.some((t) => typeLine.includes(t))) return false;
		// --- Track P8 + Track P9 ---
		if (f.allTypes && !f.allTypes.every((t) => typeLine.includes(t))) return false;
		if (
			f.unblockedAttacker !== undefined &&
			isUnblockedAttackerForPlayer(this.state, c, this.you.playerId) !== f.unblockedAttacker
		) {
			return false;
		}
		if (f.subtypes && !f.subtypes.some(hasSub)) return false;
		if (f.notSubtypes && f.notSubtypes.some(hasSub)) return false;
		if (f.ofChosenType) {
			const chosenSub = this.sourceChosenSubType();
			if (!chosenSub || !hasSub(chosenSub)) return false;
		}
		if (f.notTypes && f.notTypes.some((t) => typeLine.includes(t))) return false;
		if (f.supertypes && !f.supertypes.every((t) => typeLine.includes(t))) return false;
		if (f.notSupertypes && f.notSupertypes.some((t) => typeLine.includes(t))) return false;
		const you = this.you.playerId;
		const controllerId = zone === 'battlefield' ? c.controllerId : c.ownerId;
		if (f.controller === 'you' && controllerId !== you) return false;
		if (f.controller === 'opponent' && controllerId === you) return false;
		if (f.controllerRef) {
			const refPlayer = this.playerRef(f.controllerRef);
			if (!refPlayer || controllerId !== refPlayer.playerId) return false;
		}
		if (f.owner === 'you' && c.ownerId !== you) return false;
		if (f.owner === 'opponent' && c.ownerId === you) return false;
		if (f.tapped !== undefined && c.tapped !== f.tapped) return false;
		if (f.saddled !== undefined && Boolean(c.saddledThisTurn) !== f.saddled) return false;
		if (f.monstrous !== undefined && Boolean(c.isMonstrous) !== f.monstrous) return false;
		// --- Track P10 ---
		if (f.suspected !== undefined && Boolean(c.isSuspected) !== f.suspected) return false;
		// --- End Track P10 ---
		if (f.token !== undefined && c.isToken !== f.token) return false;
		if (f.isCommander !== undefined && Boolean(c.isCommander) !== f.isCommander) return false;
		if (f.exiledWithSelf) {
			if (zone !== 'exile' || !c.exiledBy) return false;
			const srcInst = this.locate(this.ctx.sourceId)?.inst;
			const expectedVer = this.ctx.item.sourceObjectVersion ?? srcInst?.objectVersion ?? 1;
			if (
				c.exiledBy.sourceInstanceId !== this.ctx.sourceId ||
				c.exiledBy.sourceObjectVersion !== expectedVer
			) {
				return false;
			}
		}
		if (f.other && c.instanceId === this.ctx.sourceId) return false;
		if (f.named !== undefined) {
			const name = c.isFaceDown ? '' : ev ? ev.effectiveName : card.name;
			if (name.toLowerCase() !== f.named.toLowerCase()) return false;
		}
		const cols = ev ? (c.isFaceDown ? [] : ev.colors) : (card.colors ?? []);
		if (f.colors && !f.colors.some((col) => (col === 'C' ? cols.length === 0 : cols.includes(col)))) return false;
		// --- Track P8 ---
		if (f.notColors?.length && f.notColors.some((col) => (col === 'C' ? cols.length === 0 : cols.includes(col)))) {
			return false;
		}
		if (f.multicolored !== undefined && (cols.length >= 2) !== f.multicolored) return false;
		if (f.monocolored !== undefined && (cols.length === 1) !== f.monocolored) return false;
		if (f.hasKeywords?.length || f.lacksKeywords?.length) {
			if (
				!matchesObjectFilter(
					c,
					{
						...(f.hasKeywords ? { hasKeywords: f.hasKeywords } : {}),
						...(f.lacksKeywords ? { lacksKeywords: f.lacksKeywords } : {})
					},
					{ state: this.state, controllerId: you }
				)
			) {
				return false;
			}
		}
		if (f.hasCounters !== undefined) {
			if (f.hasCounters === 'any') {
				if (!Object.values(c.counters).some((n) => n > 0)) return false;
			} else if (((c.counters as Record<string, number>)[f.hasCounters] ?? 0) <= 0) {
				return false;
			}
		}
		if (f.power) {
			const p = objectPower(this.state, c);
			if (p === null || !compare(p, f.power.op, this.amount(f.power.value))) return false;
		}
		if (f.toughness) {
			const t = objectToughness(this.state, c);
			if (t === null || !compare(t, f.toughness.op, this.amount(f.toughness.value))) return false;
		}
		if (f.blocking !== undefined) {
			const blocking = this.state.combat.attackers.some((a) => a.blockerInstanceIds.includes(c.instanceId));
			if (blocking !== f.blocking) return false;
		}
		if (f.ofChosenColor) {
			const chosenCol = this.sourceChosenColor();
			if (!chosenCol || !cols.includes(chosenCol)) return false;
		}
		if (
			f.manaValue &&
			!compare(
				objectManaValue(this.state, c),
				f.manaValue.op,
				this.amount(f.manaValue.value)
			)
		) {
			return false;
		}
		if (f.attacking !== undefined) {
			const attacking = this.state.combat.attackers.some((a) => a.attackerInstanceId === c.instanceId);
			if (attacking !== f.attacking) return false;
		}
		// --- Track P13 ---
		if (
			f.historic !== undefined ||
			f.artifactEnchantmentOrToken !== undefined ||
			f.powerLessThanSource !== undefined ||
			f.untappedNonattackingSummoningReady !== undefined ||
			f.ofChosenName !== undefined ||
			f.attachedToRef !== undefined
		) {
			const srcInst = this.locate(this.ctx.sourceId)?.inst;
			if (
				!matchesObjectFilter(
					c,
					{
						...(f.historic !== undefined ? { historic: f.historic } : {}),
						...(f.artifactEnchantmentOrToken !== undefined
							? { artifactEnchantmentOrToken: f.artifactEnchantmentOrToken }
							: {}),
						...(f.powerLessThanSource !== undefined
							? { powerLessThanSource: f.powerLessThanSource }
							: {}),
						...(f.untappedNonattackingSummoningReady !== undefined
							? { untappedNonattackingSummoningReady: f.untappedNonattackingSummoningReady }
							: {}),
						...(f.ofChosenName !== undefined ? { ofChosenName: f.ofChosenName } : {}),
						...(f.attachedToRef !== undefined ? { attachedToRef: f.attachedToRef } : {})
					},
					{ state: this.state, controllerId: you, source: srcInst }
				)
			) {
				return false;
			}
		}
		if (!matchesP13ObjectFilterFields(c, f, { state: this.state, zone, stackItem: this.ctx.item })) {
			return false;
		}
		// --- End Track P13 ---
		return true;
	}

	bind(step: EffectStep, objs: CardInstance[]): void {
		if (!step.bindAs) return;
		this.bindings.set(
			step.bindAs,
			objs.map((o) => ({ id: o.instanceId, lki: this.snapshot(o) }))
		);
	}

	// ---- Steps

	// --- Track P10 ---
	private captureTriggerEventLki(inst: CardInstance): TriggerEventLki {
		const snap = this.snapshot(inst);
		const ctrs: Partial<Record<CounterType, number>> = {};
		let hasCtrs = false;
		for (const [k, v] of Object.entries(inst.counters) as Array<[CounterType, number]>) {
			if (v > 0) {
				ctrs[k] = v;
				hasCtrs = true;
			}
		}
		return {
			...snap,
			...(hasCtrs ? { counters: ctrs } : {})
		};
	}

	private resetStepReflexiveTracking(step: EffectStep): void {
		this.stepActedIds = [];
		this.stepDiedIds.clear();
		this.stepPreSnapshots.clear();
		if (!step.params?.reflexiveTrigger) return;
		const actedAns = this.answers[`__p10_acted:${this.stepIndex}`];
		if (actedAns?.kind === 'chooseObjects') {
			this.stepActedIds = [...actedAns.objectIds];
		}
		const diedAns = this.answers[`__p10_died:${this.stepIndex}`];
		if (diedAns?.kind === 'chooseObjects') {
			for (const id of diedAns.objectIds) this.stepDiedIds.add(id);
		}
	}

	private recordStepActedObject(
		inst: CardInstance,
		preSnap?: TriggerEventLki,
		died = false
	): void {
		if (!this.stepActedIds.includes(inst.instanceId)) {
			this.stepActedIds.push(inst.instanceId);
		}
		if (preSnap && !this.stepPreSnapshots.has(inst.instanceId)) {
			this.stepPreSnapshots.set(inst.instanceId, preSnap);
		}
		if (died) {
			this.stepDiedIds.add(inst.instanceId);
		}
		const curStep = this.currentSteps[this.stepIndex];
		if (this.canPause && curStep?.params?.reflexiveTrigger) {
			this.answers[`__p10_acted:${this.stepIndex}`] = {
				kind: 'chooseObjects',
				objectIds: [...this.stepActedIds]
			};
			if (this.stepDiedIds.size > 0) {
				this.answers[`__p10_died:${this.stepIndex}`] = {
					kind: 'chooseObjects',
					objectIds: [...this.stepDiedIds]
				};
			}
		}
	}

	private finishStepReflexive(step: EffectStep): void {
		if (!step.params?.reflexiveTrigger) return;
		const actedObjects: CardInstance[] = [];
		for (const id of this.stepActedIds) {
			const found = this.locate(id);
			if (found) {
				actedObjects.push(found.inst);
			} else {
				const pre = this.stepPreSnapshots.get(id);
				actedObjects.push(this.syntheticLkiObject(id, pre?.controllerId ?? this.you.playerId));
			}
		}
		if (actedObjects.length === 0 && step.bindAs) {
			for (const b of this.bindings.get(step.bindAs) ?? []) {
				const found = this.locate(b.id);
				actedObjects.push(
					found ? found.inst : this.syntheticLkiObject(b.id, b.lki.controllerId)
				);
				if (!this.stepPreSnapshots.has(b.id)) {
					this.stepPreSnapshots.set(b.id, { ...b.lki });
				}
			}
		}
		enqueueReflexiveTriggerForStep(this.p10Host(), step, actedObjects, {
			diedObjectIds: this.stepDiedIds,
			preSnapshots: this.stepPreSnapshots
		});
	}
	// --- End Track P10 ---

	run(steps: EffectStep[]): void {
		// --- Track P10 ---
		this.currentSteps = steps;
		// --- End Track P10 ---
		for (; this.stepIndex < steps.length; this.stepIndex++) {
			if (this.result.turnEnded) return;
			const step = steps[this.stepIndex];
			// --- Track P10 ---
			this.resetStepReflexiveTracking(step);
			// --- End Track P10 ---
			if (
				step.ifPrecedingAccepted !== undefined &&
				!this.stepDecisions[step.ifPrecedingAccepted]
			) {
				this.subStepIndex = 0;
				this.phase = 'optional';
				this.answers = {};
				continue;
			}
			if (
				step.ifPrecedingDeclined !== undefined &&
				this.stepDecisions[step.ifPrecedingDeclined] !== false
			) {
				this.subStepIndex = 0;
				this.phase = 'optional';
				this.answers = {};
				continue;
			}
			if (step.condition && this.phase !== 'afterStep' && !this.condition(step.condition)) {
				this.subStepIndex = 0;
				this.phase = 'optional';
				this.answers = {};
				continue;
			}
			if (step.optional && this.phase !== 'afterStep') {
				const accepted = this.resolveOptional(step);
				if (this.result.paused) return;
				if (!accepted) {
					this.subStepIndex = 0;
					this.phase = 'optional';
					this.answers = {};
					continue;
				}
			}
			if (this.phase !== 'afterStep') {
				this.phase = 'step';
				const promptsBefore = this.state.pendingPrompts.length;
				this.step(step);
				if (this.result.turnEnded || this.result.paused) return;
				if (this.canPause && !this.state.stack.some((s) => s.id === this.ctx.item.id)) return;
				// A scry, search, or replacement/procedure prompt queued by this step: pause until answered,
				// even on the final step so the resolving item stays on the stack (CR 608.2n).
				const queued = this.state.pendingPrompts.slice(promptsBefore);
				if (this.canPause && queued.length > 0) {
					const hasNestedPrompt = queued.some((pr) => this.isNestedBlockingPrompt(pr));
					if (PROMPTING_VERBS.has(step.verb) || hasNestedPrompt) {
						// --- Track P10 ---
						const hasReflexive = Boolean(step.params?.reflexiveTrigger);
						const resumeIdx = hasReflexive ? this.stepIndex : this.stepIndex + 1;
						const resumePhase = hasReflexive ? 'afterStep' : 'optional';
						const resumeAnswers = hasReflexive ? this.answers : {};
						const item = this.saveFrame(resumeIdx, resumeAnswers, resumePhase, 0);
						this.linkPromptsToStackStep(queued, resumeIdx);
						// --- End Track P10 ---
						for (const pr of queued) {
							if (
								PROMPTING_VERBS.has(step.verb) &&
								pr.continuation?.kind !== 'handler' &&
								pr.continuation?.kind !== 'procedure'
							) {
								pr.continuation = {
									kind: 'effect_resume',
									stackItemId: item.id,
									stepIndex: resumeIdx
								};
							}
						}
						this.result.paused = true;
						return;
					}
				}
			}
			// --- Track P10 ---
			this.finishStepReflexive(step);
			// --- End Track P10 ---
			this.subStepIndex = 0;
			this.phase = 'optional';
			this.answers = {};
		}
	}

	step(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const title = this.ctx.title;
		switch (step.verb) {
			case 'draw': {
				// --- Track P13 ---
				let totalDrawn = 0;
				// --- End Track P13 ---
				for (const pl of this.players(step.subject)) {
					const n = this.amount(step.amount, 1);
					if (n <= 0) continue;
					p.drawCards(s, pl, n);
					// --- Track P13 ---
					totalDrawn += n;
					// --- End Track P13 ---
					p.addLog(s, 'rule', `${pl.username} drew ${n} card(s).`, you.playerId);
				}
				// --- Track P13 ---
				this.recordEffectAmount(totalDrawn);
				// --- End Track P13 ---
				return;
			}
			case 'gainLife':
			case 'loseLife': {
				const n = Math.max(0, this.amount(step.amount));
				const targets =
					step.subject.k === 'none' && step.actor
						? this.players({ k: 'playerRef', ref: step.actor })
						: this.players(step.subject);
				// --- Track P13 ---
				let totalLifeChanged = 0;
				// --- End Track P13 ---
				for (const pl of targets) {
					const delta = step.verb === 'gainLife' ? n : -n;
					if (step.verb === 'gainLife') {
						totalLifeChanged += gainPlayerLife(s, pl, n);
					} else {
						const cantChange =
							Boolean(pl.lifeTotalCannotChangeThisTurn) ||
							activeRuleModifiers(s, 'lifeTotalCantChange', pl.playerId).length > 0;
						if (!cantChange) {
							pl.life += delta;
							totalLifeChanged += n;
							// --- Track P10 ---
							if (n > 0 && !pl.lostLifeThisTurn) {
								pl.lostLifeThisTurn = true;
								noteLayerInputsChanged(s);
							}
							// --- End Track P10 ---
							// --- Track P12 ---
							recordPlayerLifeLossWave4(pl, n);
							// --- End Track P12 ---
						}
					}
					p.emitVfx(s, {
						kind: delta >= 0 ? 'heal' : 'damage',
						sourceId: you.playerId,
						targetId: pl.playerId,
						amount: n,
						label: `${delta >= 0 ? '+' : '-'}${n} Life`
					});
				}
				// --- Track P13 ---
				this.recordEffectAmount(totalLifeChanged);
				// --- End Track P13 ---
				if (targets.length > 0) {
					const who = targets.length === 1 ? targets[0].username : `${targets.length} players`;
					p.addLog(s, 'life', `${who} ${step.verb === 'gainLife' ? 'gained' : 'lost'} ${n} life from ${title}.`, you.playerId);
				}
				return;
			}
			case 'damage':
				return this.damage(step);
			case 'fight':
				return this.fight(step);
			case 'destroy': {
				const cantRegen = Boolean(step.params?.cantBeRegenerated);
				const batchKey = `batch:${this.stepIndex}`;
				let ids: string[];
				if (this.answers[batchKey]?.kind === 'chooseObjects') {
					ids = this.answers[batchKey].objectIds;
				} else {
					const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
					this.bind(step, objs);
					const toDestroy: CardInstance[] = [];
					for (const o of objs) {
						const ev = evaluatePermanent(s, o);
						if (ev.activeKeywords.some((k) => k.toLowerCase() === 'indestructible')) {
							p.addLog(s, 'rule', `${o.card.name} is Indestructible and was not destroyed.`);
							continue;
						}
						if (p.tryRegenerateInsteadOfDestroy(s, o, !cantRegen)) {
							continue;
						}
						// CR 122.1c: If a permanent with a shield counter on it would be destroyed,
						// instead remove a shield counter from it.
						if ((o.counters.shield || 0) > 0) {
							o.counters.shield = Math.max(0, (o.counters.shield || 0) - 1);
							p.addLog(
								s,
								'rule',
								`A shield counter was removed from ${o.card.name} instead of destroying it (CR 122.1c).`,
								you.playerId
							);
							continue;
						}
						toDestroy.push(o);
					}
					ids = toDestroy.map((o) => o.instanceId);
					if (ids.length > 0 && this.canPause) {
						this.answers[batchKey] = { kind: 'chooseObjects', objectIds: ids };
					}
				}
				let paused = false;
				if (ids.length > 0) {
					const remaining = ids
						.slice(this.subStepIndex)
						.map((id) => this.locate(id))
						.filter((f): f is NonNullable<typeof f> => Boolean(f && f.zone === 'battlefield'))
						.map((f) => f.inst);
					withSimultaneousDestroyLki(s, remaining, () => {
						paused = this.runIndexedBatch(
							batchKey,
							() => ids,
							(id) => {
								const f = this.locate(id);
								if (f && f.zone === 'battlefield') {
									// --- Track P10 ---
									const preSnap = this.captureTriggerEventLki(f.inst);
									const res = p.destroy(s, f.inst, title, you.playerId, !cantRegen);
									if (f.inst.zone !== 'battlefield') {
										this.recordStepActedObject(f.inst, preSnap, f.inst.zone === 'graveyard');
									}
									return res;
									// --- End Track P10 ---
								}
							}
						).paused;
					});
				}
				if (!paused && step.subject.k === 'all') {
					p.addLog(s, 'cast', `${title} destroyed ${ids.length} permanent(s).`, you.playerId);
				}
				return;
			}
			case 'exile':
				return this.exile(step);
			case 'grantPlayFromExile': {
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				const playSpec = step.params?.playFromExile;
				const dur = playSpec?.duration ?? 'thisTurn';
				const expiresAtEndOfTurn = dur === 'thisTurn';
				const objs = this.objects(step.subject).filter((o) => o.zone === 'exile');
				for (const o of objs) {
					o.playableFromExileBy = {
						playerId: actor.playerId,
						spendManaAsAnyColor: Boolean(playSpec?.spendManaAsAnyColor),
						sourceName: this.ctx.sourceCard.name || title,
						duration: dur,
						...(expiresAtEndOfTurn ? { expiresAtEndOfTurn: true } : {}),
						...(dur === 'untilEndOfYourNextTurn'
							? {
									expiresOnCleanupOfPlayerId: actor.playerId,
									grantedOnTurnSerial: s.turnSerial ?? s.turnNumber
								}
							: {}),
						...(dur === 'untilYourNextEndStep'
							? { expiresAtNextEndStepOfPlayerId: actor.playerId }
							: {}),
						...(playSpec?.spellsOnly ? { spellsOnly: true } : {}),
						...(playSpec?.withoutPayingManaCost ? { withoutPayingManaCost: true } : {})
					};
					const verbDesc = playSpec?.spellsOnly ? 'cast' : 'play';
					const durDesc =
						dur === 'untilEndOfYourNextTurn'
							? 'until the end of their next turn'
							: dur === 'untilYourNextEndStep'
								? 'until their next end step'
								: dur === 'asLongAsExiled'
									? 'for as long as it remains exiled'
									: 'this turn';
					p.addLog(
						s,
						'cast',
						`${actor.username} may ${verbDesc} ${o.card.name} from exile ${durDesc}${playSpec?.withoutPayingManaCost ? ' without paying its mana cost' : ''} (${title}).`,
						actor.playerId
					);
				}
				return;
			}
			case 'bounce': {
				this.runIndexedBatch(
					`batch:${this.stepIndex}`,
					() => {
						const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
						this.bind(step, objs);
						return objs.map((o) => o.instanceId);
					},
					(id) => {
						const f = this.locate(id);
						if (!f || f.zone !== 'battlefield') return;
						const objLabel = f.inst.isFaceDown ? (f.inst.faceDownLabel || 'Face-Down Permanent') : f.inst.card.name;
						// --- Track P10 ---
						const preSnap = this.captureTriggerEventLki(f.inst);
						const res = p.moveFromBattlefield(s, f.inst, 'hand');
						if (f.inst.zone !== 'battlefield') {
							this.recordStepActedObject(f.inst, preSnap, false);
						}
						// --- End Track P10 ---
						p.addLog(s, 'cast', `${title} returned ${objLabel} to its owner's hand.`, you.playerId);
						return res as MoveResult;
					}
				);
				return;
			}
			case 'move':
				return this.move(step);
			case 'counterSpell': {
				const ids =
					step.subject.k === 'eventObject' && this.ctx.eventObjectId
						? [this.ctx.eventObjectId]
						: this.ctx.targets.filter((t) => t.kind === 'stack').map((t) => t.id);
				const countered: Bound[] = [];
				for (const id of ids) {
					const target = s.stack.find((x) => x.id === id || x.sourceInstanceId === id);
					if (!target) continue;
					countered.push({
						id: target.sourceInstanceId,
						lki: {
							controllerId: target.controllerId,
							ownerId: target.ownerId ?? target.controllerId,
							power: 0,
							toughness: 0,
							manaValue: objectManaValue(s, target)
						}
					});
					// --- Track P10 ---
					p.counterSpell(s, this.ctx.item, target, you, step.params?.counterReplacementZone);
					// --- End Track P10 ---
				}
				if (step.bindAs) this.bindings.set(step.bindAs, countered);
				return;
			}
			case 'createToken': {
				const actor = step.actor ? this.playerRef(step.actor) : you;
				const baseSpec = step.params?.token;
				if (!actor || !baseSpec) return;
				const spec = step.params?.tapped && !baseSpec.tapped ? { ...baseSpec, tapped: true } : baseSpec;
				const n = Math.max(0, this.amount(step.amount, 1)) * tokenMultiplier(s, actor.playerId);
				const made: CardInstance[] = [];
				// --- Track P13 (CR 603.2c): Simultaneous multi-token batch for "one or more" triggers ---
				withSimultaneousZoneBatch(s, () => {
					for (let i = 0; i < n; i++) made.push(p.createToken(s, actor, spec));
				});
				this.recordEffectAmount(made.length);
				// --- End Track P13 ---
				if (n > 0) p.addLog(s, 'cast', `${actor.username} created ${n}x ${spec.name}.`, actor.playerId);
				this.bind(step, made);
				return;
			}
			case 'copyPermanent': {
				const actor = step.actor ? this.playerRef(step.actor) : you;
				if (!actor) return;
				// --- Track P7 ---
				const allowOffBattlefieldCopy =
					step.subject.k === 'binding' ||
					step.subject.k === 'eventObject' ||
					(step.subject.k === 'target' &&
						this.ctx.targetSpecs[step.subject.index]?.filter.zone !== undefined &&
						this.ctx.targetSpecs[step.subject.index]?.filter.zone !== 'battlefield');
				let objs = this.objects(step.subject).filter((o) => {
					if (!allowOffBattlefieldCopy && o.zone !== 'battlefield') return false;
					if (
						step.subject.k === 'self' &&
						this.ctx.item.sourceObjectVersion !== undefined &&
						(o.objectVersion ?? 1) !== this.ctx.item.sourceObjectVersion
					) {
						return false;
					}
					return true;
				});
				// --- End Track P7 ---
				// CR 707.11: If the source of an effect creating a token copy of itself (e.g. Offspring, Squad)
				// left the battlefield before resolution, use its last known copiable characteristics.
				if (objs.length === 0 && step.subject.k === 'self' && this.ctx.item.sourceInstanceId) {
					const lkiSelf = this.syntheticLkiObject(this.ctx.item.sourceInstanceId, actor.playerId);
					if (this.ctx.item.faceIndex !== undefined) {
						lkiSelf.activeFaceIndex = this.ctx.item.faceIndex;
					}
					if (this.ctx.item.sourcePrototyped) {
						lkiSelf.prototyped = true;
					}
					objs = [lkiSelf];
				}
				const copiesPerObj =
					Math.max(0, this.amount(step.amount, 1)) * tokenMultiplier(s, actor.playerId);
				if (copiesPerObj <= 0) return;
				const notLegendary = Boolean(step.params?.notLegendary);
				const exceptPT = step.params?.exceptPT;
				// --- Track P7 ---
				const copyMod = step.params?.copyMod;
				const copyOpts =
					step.params?.tapped || step.params?.tappedAndAttacking
						? {
								tapped: Boolean(step.params?.tapped || step.params?.tappedAndAttacking),
								tappedAndAttacking: Boolean(step.params?.tappedAndAttacking)
							}
						: undefined;
				// --- End Track P7 ---
				const made: CardInstance[] = [];
				// --- Track P13 (CR 603.2c): Simultaneous multi-token batch for "one or more" triggers ---
				withSimultaneousZoneBatch(s, () => {
					for (const o of objs) {
						for (let i = 0; i < copiesPerObj; i++) {
							made.push(p.copyPermanentAsToken(s, actor, o, title, notLegendary, exceptPT, copyMod, copyOpts));
						}
					}
				});
				this.recordEffectAmount(made.length);
				// --- End Track P13 ---
				this.bind(step, made);
				return;
			}
			case 'putCounters': {
				const counter = step.params?.counter ?? '+1/+1';
				const n = this.amount(step.amount, 1);
				// --- Track P7 ---
				const isDivided = Boolean(step.params?.divided);
				// --- End Track P7 ---
				const { total, paused } = this.runIndexedBatch(
					`batch:${this.stepIndex}`,
					() => {
						const objs = this.objects(step.subject).filter(
							(o) =>
								o.zone === 'battlefield' &&
								(step.subject.k !== 'self' ||
									this.ctx.item.sourceObjectVersion === undefined ||
									(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
						);
						this.bind(step, objs);
						return objs.map((o) => o.instanceId);
					},
					(id, idx) => {
						const f = this.locate(id);
						if (!f || f.zone !== 'battlefield') return;
						// --- Track P7 ---
						const amt = isDivided
							? getLockedTargetDivisionAmount(this.ctx.item, id, n, idx, Math.max(1, this.ctx.targets.length))
							: n;
						if (amt > 0) p.addCounters(s, f.inst, counter, amt);
						// --- End Track P7 ---
					}
				);
				if (!paused && step.subject.k === 'all') {
					p.addLog(s, 'cast', `${you.username} put ${n} ${counter} counter(s) on ${total} permanent(s).`, you.playerId);
				}
				return;
			}
			case 'removeCounters': {
				const counter = step.params?.counter ?? '+1/+1';
				const want = Math.max(0, this.amount(step.amount, 1));
				const sacrificeIfUnable = Boolean(step.params?.ifUnableSacrificeSelf);
				this.runIndexedBatch(
					`batch:${this.stepIndex}`,
					() => {
						const objs = this.objects(step.subject).filter(
							(o) =>
								o.zone === 'battlefield' &&
								(step.subject.k !== 'self' ||
									this.ctx.item.sourceObjectVersion === undefined ||
									(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
						);
						this.bind(step, objs);
						return objs.map((o) => o.instanceId);
					},
					(id) => {
						const f = this.locate(id);
						if (!f || f.zone !== 'battlefield') return;
						const inst = f.inst;
						// --- Track P10 ---
						const preSnap = this.captureTriggerEventLki(inst);
						// --- End Track P10 ---
						const prev = inst.counters[counter] || 0;
						const next = Math.max(0, prev - want);
						const removed = prev - next;
						if (removed > 0) {
							inst.counters[counter] = next;
							noteLayerInputsChanged(s);
							// --- Track P10 ---
							this.recordStepActedObject(inst, preSnap, false);
							// --- End Track P10 ---
							p.addLog(
								s,
								'cast',
								`Removed ${removed} ${counter} counter(s) from ${inst.card.name} (${next} remaining).`,
								you.playerId
							);
							if (!inst.phasedOut) {
								emitEvent(s, {
									kind: 'CounterRemoved',
									objectId: inst.instanceId,
									object: inst,
									counterType: counter,
									amount: removed,
									previousCount: prev,
									newCount: next
								});
								flushTriggers(s);
							}
						}
						if (sacrificeIfUnable && removed < want && inst.zone === 'battlefield') {
							// --- Track P10 ---
							const res = p.moveFromBattlefield(s, inst, 'graveyard', {
								sacrificedByPlayerId: you.playerId
							});
							// --- End Track P10 ---
							p.addLog(s, 'cast', `${you.username} sacrificed ${inst.card.name} (${title}).`, you.playerId);
							return res as MoveResult;
						}
					}
				);
				return;
			}
			case 'moveCounters': {
				const counter = step.params?.counter ?? '+1/+1';
				const src = this.sourcePerm;
				if (!src || src.zone !== 'battlefield') return;
				const initialAvailable = src.counters?.[counter] ?? 0;
				if (initialAvailable <= 0) return;
				const filter = step.params?.toFilter ?? { other: true, types: ['Creature'] };
				const cands = this.objects({ k: 'all', filter }).filter(
					(c: CardInstance) => c.instanceId !== src.instanceId && c.zone === 'battlefield'
				);
				if (cands.length === 0) return;

				// Bot AI or non-pausing environment: move all available counters to first candidate
				if (you.isBot || !this.canPause) {
					const dest = cands[0];
					if (dest && dest.zone === 'battlefield') {
						src.counters[counter] -= initialAvailable;
						noteLayerInputsChanged(s);
						p.addCounters(s, dest, counter, initialAvailable);
						p.addLog(
							s,
							'rule',
							`${you.username} moved ${initialAvailable} ${counter} counter(s) from ${src.card.name} to ${dest.card.name}.`,
							you.playerId
						);
					}
					return;
				}

				// Interactive human flow: iterative counter distribution across eligible creatures
				let remaining = initialAvailable;
				let iter = 0;
				for (; ; iter++) {
					const destKey = `move_counters_dest:${this.stepIndex}:${iter}`;
					const countKey = `move_counters_count:${this.stepIndex}:${iter}`;
					const destAns = this.answers[destKey];

					if (destAns?.kind === 'chooseObjects') {
						const pickedIds = destAns.objectIds;
						if (pickedIds.length === 0) {
							break;
						}
						const destId = pickedIds[0];
						const countAns = this.answers[countKey];
						if (countAns?.kind === 'chooseNumber') {
							const chosenCount = Math.max(1, Math.min(remaining, countAns.n));
							remaining -= chosenCount;
							if (remaining <= 0) {
								break;
							}
							continue;
						} else {
							const destPerm = this.locate(destId)?.inst;
							const destName = destPerm?.card?.name ?? 'chosen creature';
							this.pauseForNumber(
								you,
								`${title} — Move ${counter} counters`,
								`Choose how many ${counter} counters to move onto ${destName} (1–${remaining}).`,
								1,
								remaining,
								remaining,
								countKey
							);
							return;
						}
					} else {
						if (remaining <= 0) break;
						const promptReason =
							iter === 0
								? `Choose a creature to move ${counter} counters onto.`
								: `Choose another creature to move remaining ${remaining} ${counter} counter(s) onto (or choose none to finish).`;
						this.pauseForChoice(
							you,
							`${title} — Move ${counter} counters`,
							promptReason,
							cands.map((c: CardInstance) => c.instanceId),
							0,
							1,
							'battlefield',
							undefined,
							destKey
						);
						return;
					}
				}

				// All choices completed: execute counter movements atomically
				for (let i = 0; i <= iter; i++) {
					const dKey = `move_counters_dest:${this.stepIndex}:${i}`;
					const cKey = `move_counters_count:${this.stepIndex}:${i}`;
					const dAns = this.answers[dKey];
					const cAns = this.answers[cKey];
					const destIds = dAns?.kind === 'chooseObjects' ? dAns.objectIds : undefined;
					if (!destIds || destIds.length === 0) continue;
					const destId = destIds[0];
					const moveN = cAns?.kind === 'chooseNumber' ? cAns.n : 0;
					if (moveN <= 0) continue;
					const dest = this.locate(destId)?.inst;
					if (!dest || dest.zone !== 'battlefield') continue;
					// CR 122.5: verify source still has sufficient counters
					const actual = Math.min(moveN, src.counters?.[counter] ?? 0);
					if (actual <= 0) continue;
					src.counters[counter] -= actual;
					noteLayerInputsChanged(s);
					p.addCounters(s, dest, counter, actual);
					p.addLog(
						s,
						'rule',
						`${you.username} moved ${actual} ${counter} counter(s) from ${src.card.name} to ${dest.card.name}.`,
						you.playerId
					);
				}
				return;
			}
			case 'reveal': {
				const objs = this.objects(step.subject);
				this.bind(step, objs);
				if (objs.length > 0) {
					// --- Track P13 ---
					if (step.params?.lookOnly) {
						for (const o of objs) {
							const known = (o.knownToPlayerIds ??= []);
							if (!known.includes(you.playerId)) known.push(you.playerId);
						}
						p.addLog(
							s,
							'rule',
							`${you.username} looked at ${objs.length} card(s) (${title}).`,
							you.playerId
						);
						return;
					}
					// --- End Track P13 ---
					p.addLog(
						s,
						'rule',
						`${you.username} revealed ${objs.map((o) => o.card.name).join(', ')} (${title}).`,
						you.playerId
					);
				}
				return;
			}
			case 'extraCombatPhase': {
				s.additionalCombatPhases = (s.additionalCombatPhases ?? 0) + 1;
				p.addLog(
					s,
					'rule',
					`There will be an additional combat phase after this phase (${this.ctx.title}).`,
					you.playerId
				);
				return;
			}
			case 'proliferate': {
				const { candidates, defaultIds } = proliferateCandidates(s, you);
				const ans = this.answers[you.playerId];
				if (
					!you.isBot &&
					this.canPause &&
					candidates.length > 0 &&
					!ans
				) {
					this.pauseForChoice(
						you,
						`${title} — Proliferate`,
						'Choose any number of permanents and/or players with counters to proliferate (CR 701.34a).',
						candidates,
						0,
						candidates.length,
						'battlefield',
						defaultIds
					);
					return;
				}
				const chosenIds = ans?.kind === 'chooseObjects' ? ans.objectIds : undefined;
				p.proliferate(s, you, chosenIds);
				return;
			}
			case 'pump': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const pw = this.amount(step.amount);
				const tg = this.amount(step.params?.toughness);
				// --- Track P13 (CR 611.2b): Cross-turn / permanent P/T modifiers ---
				const dur = step.params?.duration;
				if (
					objs.length > 0 &&
					(pw !== 0 || tg !== 0) &&
					(dur === 'untilYourNextTurn' || dur === 'untilEndOfYourNextTurn' || dur === 'permanent')
				) {
					const ts = allocateTimestamp(s);
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: you.playerId,
						affected: objs.map((o) => ({
							instanceId: o.instanceId,
							objectVersion: o.objectVersion ?? 1
						})),
						...buildDurationExpiryFields(s, dur, you.playerId),
						layer7c: { power: pw, toughness: tg }
					});
					noteLayerInputsChanged(s);
					return;
				}
				// --- End Track P13 ---
				for (const o of objs) {
					o.tempPowerMod += pw;
					o.tempToughnessMod += tg;
				}
				if (objs.length > 0 && (pw !== 0 || tg !== 0)) noteLayerInputsChanged(s);
				return;
			}
			case 'grant': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const addKws = step.params?.keywords;
				const removeKws = step.params?.removeKeywords;
				const grantedTexts = step.params?.grantedAbilityTexts;
				// --- Track P13 ---
				if (step.params?.canAttackNoDefender) {
					for (const o of objs) {
						o.canAttackAsThoughNoDefenderThisTurn = true;
					}
					if (objs.length > 0) noteLayerInputsChanged(s);
				}
				const dur = step.params?.duration;
				if (
					objs.length > 0 &&
					(dur === 'untilYourNextTurn' || dur === 'untilEndOfYourNextTurn' || dur === 'permanent') &&
					(addKws?.length || removeKws?.length || step.params?.cantHaveOrGain || grantedTexts?.length)
				) {
					const ts = allocateTimestamp(s);
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: you.playerId,
						affected: objs.map((o) => ({
							instanceId: o.instanceId,
							objectVersion: o.objectVersion ?? 1
						})),
						...buildDurationExpiryFields(s, dur, you.playerId),
						layer6: {
							...(addKws?.length ? { addKeywords: [...addKws] } : {}),
							...(removeKws?.length ? { removeKeywords: [...removeKws] } : {}),
							...(step.params?.cantHaveOrGain ? { cantHaveOrGain: true } : {}),
							...(grantedTexts?.length ? { grantedAbilityTexts: [...grantedTexts] } : {})
						}
					});
					noteLayerInputsChanged(s);
					return;
				}
				// --- End Track P13 ---
				for (const o of objs) {
					for (const kw of addKws ?? []) {
						const isStackingTriggerKw = getKeywordSpec(kw)?.implementation?.kind === 'trigger';
						if (isStackingTriggerKw || !o.grantedKeywords.includes(kw)) {
							o.grantedKeywords.push(kw);
						}
					}
				}
				if (objs.length > 0 && (addKws?.length || removeKws?.length)) {
					const ts = allocateTimestamp(s);
					(s.timedKeywordEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: you.playerId,
						affected: objs.map((o) => ({
							instanceId: o.instanceId,
							objectVersion: o.objectVersion ?? 1
						})),
						...(addKws?.length ? { addKeywords: [...addKws] } : {}),
						...(removeKws?.length ? { removeKeywords: [...removeKws] } : {}),
						...(step.params?.cantHaveOrGain ? { cantHaveOrGain: true } : {})
					});
					noteLayerInputsChanged(s);
				}
				// --- Track P10 ---
				if (objs.length > 0 && grantedTexts?.length) {
					const ts = allocateTimestamp(s);
					const expires: 'endOfTurn' | 'never' =
						step.params?.duration === 'permanent' ? 'never' : 'endOfTurn';
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: you.playerId,
						affected: objs.map((o) => ({
							instanceId: o.instanceId,
							objectVersion: o.objectVersion ?? 1
						})),
						expires,
						layer6: { grantedAbilityTexts: [...grantedTexts] }
					});
					noteLayerInputsChanged(s);
				}
				// --- End Track P10 ---
				return;
			}
			case 'grantPlayer': {
				const rules = step.params?.playerRules ?? [];
				// --- Track P7 ---
				if (rules.includes('damageCantBePrevented')) {
					s.damageCantBePreventedThisTurn = true;
					p.addLog(s, 'rule', `${title}: Damage can't be prevented this turn (CR 615.12).`, you.playerId);
				}
				if (rules.includes('combatDamageCantBePrevented')) {
					s.combatDamageCantBePreventedThisTurn = true;
					p.addLog(s, 'rule', `${title}: Combat damage can't be prevented this turn (CR 615.12).`, you.playerId);
				}
				// --- End Track P7 ---
				for (const pl of this.players(step.subject)) {
					if (rules.includes('lifeTotalCantChange')) pl.lifeTotalCannotChangeThisTurn = true;
					if (rules.includes('protectionFromEverything')) pl.protectionFromEverythingThisTurn = true;
					// --- Track P13 ---
					if (rules.includes('extraLandPlay')) {
						const addLands = Math.max(1, step.params?.extraLandPlays ?? 1);
						pl.extraLandPlaysThisTurn = (pl.extraLandPlaysThisTurn ?? 0) + addLands;
						p.addLog(
							s,
							'rule',
							`${pl.username} may play ${addLands} additional land(s) this turn (${title}).`,
							you.playerId
						);
					}
					if (rules.includes('cannotLoseGame')) {
						pl.cannotLoseGameThisTurn = true;
						p.addLog(
							s,
							'rule',
							`${pl.username} can't lose the game this turn (${title}).`,
							you.playerId
						);
					}
					if (rules.includes('hexproof')) {
						if (step.params?.duration === 'untilYourNextTurn') {
							pl.hexproofUntilNextTurn = true;
						} else {
							pl.hexproofThisTurn = true;
						}
						p.addLog(
							s,
							'rule',
							`${pl.username} gains hexproof (${title}).`,
							you.playerId
						);
					}
					// --- End Track P13 ---
					if (rules.includes('lifeTotalCantChange') || rules.includes('protectionFromEverything')) {
						p.addLog(s, 'rule', `${pl.username}'s life total can't change and they have protection from everything until their next turn.`, you.playerId);
					}
				}
				return;
			}
			// --- Track P7 ---
			case 'preventDamage':
				return this.preventDamageStep(step);
			case 'exileInsteadOfDying': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					registerExileInsteadOfDying(s, o);
				}
				return;
			}
			case 'combatRestriction': {
				const spec = step.params?.combatRestriction;
				if (!spec) return;
				const objs = this.objects(step.subject).filter((o) => {
					if (o.zone !== 'battlefield' || o.phasedOut) return false;
					if (
						step.subject.k === 'self' &&
						this.ctx.item.sourceObjectVersion !== undefined &&
						(o.objectVersion ?? 1) !== this.ctx.item.sourceObjectVersion
					) {
						return false;
					}
					return true;
				});
				this.bind(step, objs);
				for (const o of objs) {
					registerTimedCombatRestriction(s, o, spec);
				}
				return;
			}
			case 'becomeCopy': {
				const copySrcSel = step.params?.copySource;
				if (!copySrcSel) return;
				const affected = this.objects(step.subject).filter((o) => {
					if (o.zone !== 'battlefield' || o.phasedOut) return false;
					if (
						step.subject.k === 'self' &&
						this.ctx.item.sourceObjectVersion !== undefined &&
						(o.objectVersion ?? 1) !== this.ctx.item.sourceObjectVersion
					) {
						return false;
					}
					return true;
				});
				const copySrc = this.objects(copySrcSel)[0];
				if (!copySrc || copySrc.zone !== 'battlefield' || copySrc.phasedOut) {
					this.bind(step, []);
					return;
				}
				const updated = applyBecomeCopyEffect(
					s,
					affected,
					copySrc,
					step.params?.copyMod,
					step.params?.duration,
					you.playerId,
					this.ctx.sourceCard.name || title,
					allocateTimestamp
				);
				this.bind(step, updated);
				if (updated.length > 0) {
					p.addLog(
						s,
						'cast',
						`${updated.length === 1 ? updated[0].card.name : `${updated.length} permanents`} became a copy of ${copySrc.card.name}${step.params?.duration === 'permanent' ? '' : ' until end of turn'}.`,
						you.playerId
					);
				}
				return;
			}
			case 'discardHand':
				return this.discardHandStep(step);
			// --- End Track P7 ---
			case 'addMana': {
				const times = Math.max(0, this.amount(step.amount, 1));
				const restriction = step.params?.manaRestriction;
				// --- Track P10 ---
				const rawRestrSpec = step.params?.manaRestrictionSpec;
				const chosenSub = this.sourceChosenSubType();
				const boundRestrSpec: ManaSpendingRestrictionSpec | undefined = rawRestrSpec
					? {
							...rawRestrSpec,
							...(chosenSub && !rawRestrSpec.sourceChosenSubType
								? { sourceChosenSubType: chosenSub }
								: {})
						}
					: undefined;
				const addOpts: AddManaOptions | undefined =
					boundRestrSpec || step.params?.retainManaUntilEndOfTurn
						? {
								...(boundRestrSpec ? { restrictionSpec: boundRestrSpec } : {}),
								...(step.params?.retainManaUntilEndOfTurn ? { retainUntilEndOfTurn: true } : {})
							}
						: undefined;
				// --- End Track P10 ---
				if (step.params?.manaWithChosenColor) {
					for (const c of step.params.manaWithChosenColor) {
						addManaToPlayerPool(you, c, 1, restriction, addOpts);
					}
					const chosenCol = this.sourceChosenColor();
					if (chosenCol) {
						addManaToPlayerPool(you, chosenCol, 1, restriction, addOpts);
					}
					return;
				}
				if (step.params?.manaBundles && step.params.manaBundles.length > 0) {
					const bundles = step.params.manaBundles;
					let chosenBundle =
						bundles.length === 1
							? bundles[0]
							: pickBestBundleForRequirement(bundles, you.manaPool, null, this.ctx.preferredColor);
					if (!you.isBot && bundles.length > 1 && this.canPause) {
						const manaKey = `manabundle:${this.stepIndex}`;
						const ans = this.answers[manaKey] ?? this.answers[you.playerId];
						if (!ans) {
							const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
							const modes = bundles.map((b) => formatManaBundle(b));
							enqueueChoicePrompt(s, {
								id: p.uid('prompt', s),
								kind: 'chooseMode',
								playerId: you.playerId,
								title: `${title} — Choose Mana Combination`,
								description: `Choose mana to add (${modes.join(', ')}).`,
								continuation: {
									kind: 'effect_choice',
									stackItemId: item.id,
									stepIndex: this.stepIndex,
									answerKey: manaKey
								},
								choice: {
									kind: 'chooseMode',
									modes,
									min: 1,
									max: 1,
									defaultIndices: [0]
								}
							});
							this.result.paused = true;
							return;
						}
						if (ans.kind === 'chooseMode' && bundles[ans.indices[0] ?? -1]) {
							chosenBundle = bundles[ans.indices[0]];
						}
					}
					for (const c of chosenBundle) {
						addManaToPlayerPool(you, c, 1, restriction, addOpts);
					}
					return;
				}
				if (step.params?.manaCombinationColors) {
					if (times <= 0) return;
					const allowedCols: ManaColor[] =
						step.params.manaCombinationColors === 'any'
							? ['W', 'U', 'B', 'R', 'G']
							: step.params.manaCombinationColors;
					if (allowedCols.length === 0) return;
					let chosenBundle = pickCombinationForRequirement(
						allowedCols,
						times,
						you.manaPool,
						null,
						this.ctx.preferredColor,
						you
					);
					if (!you.isBot && allowedCols.length > 1 && this.canPause) {
						const bundles = times <= 5 ? expandCombinationBundles(allowedCols, times) : [];
						if (bundles.length > 1) {
							const manaKey = `manacomb:${this.stepIndex}`;
							const ans = this.answers[manaKey] ?? this.answers[you.playerId];
							if (!ans) {
								const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
								const modes = bundles.map((b) => formatManaBundle(b));
								enqueueChoicePrompt(s, {
									id: p.uid('prompt', s),
									kind: 'chooseMode',
									playerId: you.playerId,
									title: `${title} — Choose Mana Combination`,
									description: `Choose ${times} mana in any combination (${allowedCols.map((c) => `{${c}}`).join(', ')}).`,
									continuation: {
										kind: 'effect_choice',
										stackItemId: item.id,
										stepIndex: this.stepIndex,
										answerKey: manaKey
									},
									choice: {
										kind: 'chooseMode',
										modes,
										min: 1,
										max: 1,
										defaultIndices: [0]
									}
								});
								this.result.paused = true;
								return;
							}
							if (ans.kind === 'chooseMode' && bundles[ans.indices[0] ?? -1]) {
								chosenBundle = bundles[ans.indices[0]];
							}
						}
					}
					for (const c of chosenBundle) {
						addManaToPlayerPool(you, c, 1, restriction, addOpts);
					}
					return;
				}
				if (step.params?.mana) {
					const mana = step.params.mana;
					const loops = mana.length > 1 ? 1 : times;
					for (let i = 0; i < loops; i++) {
						for (const c of mana) {
							addManaToPlayerPool(you, c, 1, restriction, addOpts);
							if (step.delayed) {
								(you.manaRiders ??= []).push({
									id: p.uid('rider', s),
									color: c,
									sourceInstanceId: this.ctx.sourceId,
									sourceCard: this.ctx.sourceCard,
									condition: { sharesCreatureTypeWithCommander: true },
									scryAmount: 1
								});
							}
						}
					}
					return;
				}
				if (step.params?.manaChoice) {
					const allowed = manaChoiceColors(s, you, step.params.manaChoice, this.sourceChosenColor());
					if (allowed.length === 0 || times <= 0) return;
					const defaultColor =
						this.ctx.preferredColor && allowed.includes(this.ctx.preferredColor)
							? this.ctx.preferredColor
							: allowed[0];
					let chosen = defaultColor;
					if (!you.isBot && !this.ctx.preferredColor && allowed.length > 1 && this.canPause) {
						const manaKey = `mana:${this.stepIndex}`;
						const ans = this.answers[manaKey] ?? this.answers[you.playerId];
						if (!ans) {
							const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
							const defaultIdx = Math.max(0, allowed.indexOf(defaultColor));
							enqueueChoicePrompt(s, {
								id: p.uid('prompt', s),
								kind: 'chooseMode',
								playerId: you.playerId,
								title: `${title} — Choose Mana Color`,
								description: `Choose a color of mana to add (${allowed.join(', ')}).`,
								continuation: {
									kind: 'effect_choice',
									stackItemId: item.id,
									stepIndex: this.stepIndex,
									answerKey: manaKey
								},
								choice: {
									kind: 'chooseMode',
									modes: allowed,
									min: 1,
									max: 1,
									defaultIndices: [defaultIdx]
								}
							});
							this.result.paused = true;
							return;
						}
						const picked =
							ans.kind === 'chooseMode'
								? allowed[ans.indices[0] ?? -1]
								: ans.kind === 'chooseObjects'
									? (ans.objectIds[0] as ManaColor)
									: undefined;
						if (picked && allowed.includes(picked)) chosen = picked;
					}
					addManaToPlayerPool(you, chosen, times, restriction, addOpts);
					if (step.delayed) {
						for (let i = 0; i < times; i++) {
							(you.manaRiders ??= []).push({
								id: p.uid('rider', s),
								color: chosen,
								sourceInstanceId: this.ctx.sourceId,
								sourceCard: this.ctx.sourceCard,
								condition: { sharesCreatureTypeWithCommander: true },
								scryAmount: 1
							});
						}
					}
				}
				return;
			}
			// --- Track P10 ---
			case 'retainMana': {
				const colors: ManaColor[] =
					step.params?.unemptiedColors === 'all' || !step.params?.unemptiedColors
						? ['W', 'U', 'B', 'R', 'G', 'C']
						: step.params.unemptiedColors;
				const targets =
					step.subject.k === 'player' || step.subject.k === 'playerRef'
						? this.players(step.subject)
						: [you];
				for (const pl of targets) {
					if (pl.lost) continue;
					if (pl.unemptiedManaColorsThisTurn === 'all') continue;
					if (step.params?.unemptiedColors === 'all' || !step.params?.unemptiedColors) {
						pl.unemptiedManaColorsThisTurn = 'all';
						continue;
					}
					const list: ManaColor[] = Array.isArray(pl.unemptiedManaColorsThisTurn)
						? pl.unemptiedManaColorsThisTurn
						: [];
					pl.unemptiedManaColorsThisTurn = list;
					for (const c of colors) {
						if (!list.includes(c)) list.push(c);
					}
				}
				return;
			}
			// --- End Track P10 ---
			case 'attach': {
				// --- Track P10 ---
				return executeAttachP10(this.p10Host(), step);
				// --- End Track P10 ---
			}
			case 'phaseOut': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
				// CR 702.26h: If an attachment and its host are both instructed to phase out simultaneously
				// (e.g. "All permanents you control phase out"), the attachment phases out indirectly via its host.
				const batchIds = new Set(objs.map((o) => o.instanceId));
				const hasHostPhasingOut = (obj: CardInstance): boolean => {
					const seen = new Set<string>();
					let cur = obj.attachedToId;
					while (cur && !seen.has(cur)) {
						if (batchIds.has(cur)) return true;
						seen.add(cur);
						const host = p.findPermanent(s, cur);
						if (!host || host.inst.phasedOut) return false;
						cur = host.inst.attachedToId;
					}
					return false;
				};
				for (const o of objs) {
					if (!hasHostPhasingOut(o)) p.phaseOut(s, o);
				}
				if (objs.length > 0) p.addLog(s, 'rule', `${title} phased out ${objs.length} permanent(s) (CR 702.26).`, you.playerId);
				return;
			}
			case 'switchPT': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					o.switchedPTCount = (o.switchedPTCount || 0) + 1;
					p.addLog(s, 'cast', `${title} switched ${o.card.name}'s power and toughness until end of turn (Layer 7d).`, you.playerId);
				}
				return;
			}
			case 'extraTurn':
				for (const pl of this.players(step.subject)) {
					if (!s.extraTurnQueue) s.extraTurnQueue = [];
					// CR 500.7: the most recently created extra turn is taken first.
					s.extraTurnQueue.push(pl.playerId);
					p.addLog(s, 'rule', `${pl.username} will take an extra turn after this one (CR 500.7)!`, you.playerId);
				}
				return;
			case 'endTurn':
				if (step.params?.activePlayerMay) {
					p.activePlayerMayEndTurn(s, you, this.ctx.sourceCard.name);
					if (!s.stack.some((st) => st.id === this.ctx.item.id)) {
						this.result.turnEnded = true;
					}
					return;
				}
				p.endTurn(s, you.playerId);
				this.result.turnEnded = true;
				return;
			case 'win':
			case 'lose': {
				if (step.params?.condition && !this.condition(step.params.condition)) return;
				for (const pl of this.players(step.subject)) {
					if (step.verb === 'win') p.win(s, pl, `${title} win condition`);
					else p.lose(s, pl, `${title} ("you lose the game")`);
				}
				return;
			}
			case 'sacrifice':
				return this.sacrifice(step);
			case 'discard':
				return this.discard(step);
			case 'revealAndDiscard':
				return this.revealAndDiscard(step);
			case 'tap':
			case 'untap':
			case 'tapOrUntap' as Verb: {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const explicitTap = (step.params as { tap?: boolean } | undefined)?.tap;
				for (const o of objs) {
					const shouldTap =
						step.verb === 'tap'
							? true
							: step.verb === 'untap'
								? false
								: explicitTap !== undefined
									? Boolean(explicitTap)
									: !o.tapped;
					if (shouldTap) {
						// --- Track P10 ---
						const preSnap = this.captureTriggerEventLki(o);
						const wasTapped = o.tapped;
						tapPermanent(s, o);
						if (!wasTapped && o.tapped) {
							this.recordStepActedObject(o, preSnap, false);
						}
						// --- End Track P10 ---
					} else if (o.tapped) {
						// CR 122.1d: If a permanent with a stun counter on it would become untapped,
						// instead remove a stun counter from it.
						if ((o.counters.stun || 0) > 0) {
							const prevStun = o.counters.stun || 0;
							const nextStun = Math.max(0, prevStun - 1);
							o.counters.stun = nextStun;
							noteLayerInputsChanged(s);
							p.addLog(
								s,
								'rule',
								`A stun counter was removed from ${o.card.name} instead of untapping it (CR 122.1d).`,
								you.playerId
							);
							if (!o.phasedOut) {
								emitEvent(s, {
									kind: 'CounterRemoved',
									objectId: o.instanceId,
									object: o,
									counterType: 'stun',
									amount: 1,
									previousCount: prevStun,
									newCount: nextStun
								});
								flushTriggers(s);
							}
						} else {
							// --- Track P10 ---
							const preSnap = this.captureTriggerEventLki(o);
							o.tapped = false;
							noteLayerInputsChanged(s);
							this.recordStepActedObject(o, preSnap, false);
							if (!o.phasedOut) {
								emitEvent(s, {
									kind: 'BecomesUntapped',
									objectId: o.instanceId,
									object: o
								});
								flushTriggers(s);
							}
							// --- End Track P10 ---
						}
					}
				}
				return;
			}
			case 'freezeUntap': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					if (applyNextUntapFreeze(o)) {
						const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
						p.addLog(
							s,
							'rule',
							`${objLabel} won't untap during its controller's next untap step (${title}).`,
							you.playerId
						);
					}
				}
				return;
			}
			case 'exert': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					if (exertPermanent(s, o, you.playerId)) {
						const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
						p.addLog(
							s,
							'rule',
							`${you.username} exerted ${objLabel} (${title}).`,
							you.playerId
						);
					}
				}
				flushTriggers(s);
				return;
			}
			case 'transform': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) p.transformPermanent(s, o);
				return;
			}
			case 'flip': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) p.flipPermanent(s, o);
				return;
			}
			case 'copySpell': {
				const sel = step.subject;
				let orig: StackItem | undefined;
				if (sel.k === 'target') {
					const t = this.targetsForSpecIndex(sel.index)[0];
					orig =
						t?.kind === 'stack'
							? s.stack.find((item) => item.id === t.id || item.sourceInstanceId === t.id)
							: undefined;
				} else if (sel.k === 'eventObject') {
					orig =
						(this.ctx.eventObjectId
							? s.stack.find(
									(item) =>
										item.id !== this.ctx.item.id &&
										(item.sourceInstanceId === this.ctx.eventObjectId ||
											item.id === this.ctx.eventObjectId)
								)
							: undefined) ?? this.ctx.item.triggerEventStackItem;
				} else if (sel.k === 'self') {
					orig =
						s.stack.find(
							(item) =>
								item.id !== this.ctx.item.id &&
								item.kind === 'spell' &&
								(item.sourceInstanceId === this.ctx.sourceId || item.id === this.ctx.sourceId)
						) ?? this.ctx.item.triggerEventStackItem;
				} else if (sel.k === 'binding') {
					const bId = this.bindings.get(sel.name)?.[0]?.id;
					orig = bId
						? s.stack.find(
								(item) =>
									item.id !== this.ctx.item.id &&
									(item.id === bId || item.sourceInstanceId === bId)
							)
						: undefined;
				}
				if (!orig) return;

				const count = step.params?.count ? Math.max(0, this.amount(step.params.count)) : 1;
				if (count <= 0) return;

				const sameRefList = (a: TargetRef[], b: TargetRef[]) =>
					a.length === b.length &&
					a.every((x, idx) => x.kind === b[idx]?.kind && x.id === b[idx]?.id);

				const { paused } = this.runIndexedBatch(
					`copy_batch:${this.stepIndex}`,
					() => Array.from({ length: count }, (_, idx) => String(idx)),
					(_batchEntry, k) => {
						let chosenTargets: TargetRef[] = orig.targets.map((trg) => ({ ...trg }));
						let chosenTargetsBySpec: TargetRef[][] | undefined = orig.targetsBySpec
							? orig.targetsBySpec.map((bucket) => bucket.map((trg) => ({ ...trg })))
							: undefined;

						if (step.params?.mayChooseNewTargets && orig.targets.length > 0) {
							const slots = p.getStackItemRetargetSlots(s, orig, you.playerId);
							const hasLegalAlternative =
								slots.length > 0 &&
								slots.some((sl) => {
									if (sl.spec.min === 0 && sl.originalTargets.length > 0) return true;
									if (sl.legalCandidates.length < sl.spec.min) return false;
									if (sl.legalCandidates.length > sl.originalTargets.length) return true;
									return !sameRefList(sl.legalCandidates, sl.originalTargets);
								});

							if (hasLegalAlternative) {
								if (you.isBot || !this.canPause) {
									const botChoice = p.chooseBotStackItemRetarget(s, you, orig, slots, k);
									chosenTargets = botChoice.targets;
									chosenTargetsBySpec = botChoice.targetsBySpec;
								} else {
									const ynKey = `retarget_yn:${this.stepIndex}:${k}`;
									const ynAns = this.answers[ynKey];
									if (!ynAns || ynAns.kind !== 'yesNo') {
										const copyLabel =
											count > 1
												? `copy #${k + 1} of ${orig.card.name}`
												: `the copy of ${orig.card.name}`;
										const curDesc = orig.targets.map((trg) => trg.label).join(', ');
										this.pauseForYesNo(
											you,
											`${this.ctx.title} — Retarget Copy`,
											`Choose new targets for ${copyLabel}? (Current target${orig.targets.length === 1 ? '' : 's'}: ${curDesc})`,
											ynKey,
											{ yesLabel: 'Choose new targets', noLabel: 'Keep current targets' }
										);
										return;
									}

									if (ynAns.yes) {
										const nextBySpec: TargetRef[][] = [];
										for (let sIdx = 0; sIdx < slots.length; sIdx++) {
											const sl = slots[sIdx];
											if (sl.spec.min > 0 && sl.legalCandidates.length < sl.spec.min) {
												nextBySpec.push(sl.originalTargets.map((trg) => ({ ...trg })));
												continue;
											}
											const pool: TargetRef[] = [...sl.legalCandidates];
											if (slots.length > 1) {
												for (const origT of sl.originalTargets) {
													if (!pool.some((c) => c.kind === origT.kind && c.id === origT.id)) {
														pool.push({ ...origT });
													}
												}
											}
											if (pool.length === 0) {
												nextBySpec.push([]);
												continue;
											}
											const maxPick = Math.min(sl.spec.max, pool.length);
											const slotKey = `retarget_slot:${this.stepIndex}:${k}:${sIdx}`;
											const slotAns = this.answers[slotKey];
											if (!slotAns || slotAns.kind !== 'chooseObjects') {
												const altCands = sl.legalCandidates.filter(
													(c) => !sl.originalTargets.some((o) => o.kind === c.kind && o.id === c.id)
												);
												const defaultRefs =
													altCands.length >= sl.spec.min
														? altCands.slice(0, Math.max(1, sl.spec.min))
														: sl.legalCandidates.slice(0, sl.spec.min);
												const copyTitle =
													count > 1
														? `Copy #${k + 1} of ${orig.card.name}`
														: `Copy of ${orig.card.name}`;
												const countDesc =
													sl.spec.min === maxPick ? `${maxPick}` : `${sl.spec.min}–${maxPick}`;
												this.pauseForChoice(
													you,
													`${copyTitle} — Choose New Target`,
													`Choose ${countDesc} target(s) for ${copyTitle}.`,
													pool.map((c) => c.id),
													sl.spec.min,
													maxPick,
													sl.zone === 'player' ? 'battlefield' : sl.zone,
													defaultRefs.map((r) => r.id),
													slotKey,
													'step'
												);
												return;
											}
											const picked = slotAns.objectIds
												.map((id) => pool.find((c) => c.id === id))
												.filter((c): c is TargetRef => Boolean(c));
											for (const c of sl.legalCandidates) {
												if (picked.length >= sl.spec.min) break;
												if (!picked.some((x) => x.kind === c.kind && x.id === c.id)) {
													picked.push(c);
												}
											}
											nextBySpec.push(picked.slice(0, maxPick));
										}
										if (p.validateStackItemRetarget(s, orig, you.playerId, nextBySpec)) {
											chosenTargetsBySpec = nextBySpec;
											chosenTargets = nextBySpec.flat();
										}
									}
								}
							}
						}

						p.pushCopiedStackItem(s, you, orig, chosenTargets, chosenTargetsBySpec, {
							exceptColors: step.params?.exceptColors,
							nonLegendary: step.params?.nonLegendary
						});
					}
				);
				if (paused) return;
				return;
			}
			case 'mill': {
				const batchKey = `batch:${this.stepIndex}:mill`;
				const { paused } = this.runIndexedBatch(
					batchKey,
					() => {
						const slots: string[] = [];
						for (const pl of this.players(step.subject)) {
							const n = Math.min(this.amount(step.amount), pl.library.length);
							for (let i = 0; i < n; i++) slots.push(pl.playerId);
							if (n > 0) p.addLog(s, 'rule', `${pl.username} milled ${n} card(s).`, you.playerId);
						}
						return slots;
					},
					(playerId) => {
						const pl = this.player(playerId);
						if (!pl || pl.library.length === 0) return;
						return moveObject(s, pl.library[0], 'graveyard', {
							from: { player: pl, zone: 'library' },
							toPlayer: pl,
							graveyardReplacement: true,
							bumpVersion: true,
							newTimestamp: true
						});
					}
				);
				if (paused) return;
				return;
			}
			case 'scry':
			case 'lookAndReorder': {
				const n = this.amount(step.amount);
				for (const pl of this.players(step.subject)) {
					p.scry(s, pl, this.ctx.item, n, step.verb === 'scry' ? 'scry' : 'rearrange', Boolean(step.params?.mayShuffle));
				}
				return;
			}
			case 'surveil': {
				const n = this.amount(step.amount);
				const { paused } = this.runIndexedBatch(
					`surveil:${this.stepIndex}`,
					() => this.players(step.subject).map((pl) => pl.playerId),
					(pid) => {
						const pl = this.player(pid);
						if (!pl || pl.lost) return;
						const promptsBefore = s.pendingPrompts.length;
						p.scry(s, pl, this.ctx.item, n, 'surveil', false);
						if (
							s.pendingPrompts.length > promptsBefore ||
							s.pendingProcedure?.kind === 'surveil_graveyard'
						) {
							return 'pending';
						}
					}
				);
				if (paused) return;
				return;
			}
			case 'investigate': {
				const actor = step.actor ? this.playerRef(step.actor) : you;
				if (!actor || actor.lost) return;
				const n = Math.max(0, this.amount(step.amount, 1));
				const clueSpec = predefinedTokenToSpec(PREDEFINED_TOKEN_DEFS.clue);
				const made: CardInstance[] = [];
				for (let i = 0; i < n; i++) {
					const mult = tokenMultiplier(s, actor.playerId);
					for (let j = 0; j < mult; j++) made.push(p.createToken(s, actor, clueSpec));
					p.addLog(s, 'rule', `${actor.username} investigated.`, actor.playerId);
					emitEvent(s, {
						kind: 'Investigated',
						playerId: actor.playerId,
						count: 1
					});
					flushTriggers(s);
				}
				this.bind(step, made);
				return;
			}
			case 'search': {
				const actor = step.actor ? this.playerRef(step.actor) : you;
				if (!actor || actor.lost) return;
				const search = step.params?.search;
				if (!search) return;
				// --- Track P10 ---
				if (isP10ExtendedSearch(search)) {
					return executeMultiZoneSearchP10(this.p10Host(), step);
				}
				// --- End Track P10 ---
				p.search(s, actor, legacySearchSpec(search), this.ctx.item);
				return;
			}
			case 'delayedTrigger':
				return this.delayed(step);
			case 'dig':
				return this.dig(step);
			case 'goad':
				return this.goad(step);
			case 'explore':
				return this.explore(step);
			case 'connive':
				return this.connive(step);
			case 'regenerate': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					o.regenerationShields = (o.regenerationShields ?? 0) + 1;
					p.addLog(
						s,
						'rule',
						`${title}: created a regeneration shield on ${o.card.name} (CR 701.19a).`,
						you.playerId
					);
				}
				return;
			}
			case 'cantRegenerate': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					o.cantBeRegeneratedThisTurn = true;
					p.addLog(
						s,
						'rule',
						`${title}: ${o.card.name} can't be regenerated this turn.`,
						you.playerId
					);
				}
				return;
			}
			case 'payCost':
				return;
			case 'animate': {
				const objs = this.objects(step.subject).filter((o) => {
					if (o.zone !== 'battlefield' || o.phasedOut) return false;
					if (
						step.subject.k === 'self' &&
						this.ctx.item.sourceObjectVersion !== undefined &&
						o.objectVersion !== this.ctx.item.sourceObjectVersion
					) {
						return false;
					}
					return true;
				});
				this.bind(step, objs);
				if (objs.length === 0) return;
				const pParams = step.params ?? {};
				const setTypes = pParams.setTypes?.length ? [...pParams.setTypes] : undefined;
				const addTypes = !setTypes
					? pParams.addTypes?.length
						? [...pParams.addTypes]
						: ['Creature']
					: undefined;
				const setSubtypes =
					pParams.setSubtypes !== undefined ? [...pParams.setSubtypes] : undefined;
				const addSubtypes = pParams.addSubtypes?.length ? [...pParams.addSubtypes] : undefined;
				const layer4 = {
					...(addTypes ? { addTypes } : {}),
					...(setTypes ? { setTypes } : {}),
					...(addSubtypes ? { addSubtypes } : {}),
					...(setSubtypes !== undefined ? { setSubtypes } : {})
				};
				const layer5 =
					pParams.setColors !== undefined || pParams.addColors?.length
						? {
								...(pParams.setColors !== undefined ? { setColors: [...pParams.setColors] } : {}),
								...(pParams.addColors?.length ? { addColors: [...pParams.addColors] } : {})
							}
						: undefined;
				const layer6 =
					pParams.addKeywords?.length || pParams.grantedAbilityTexts?.length
						? {
								...(pParams.addKeywords?.length ? { addKeywords: [...pParams.addKeywords] } : {}),
								...(pParams.grantedAbilityTexts?.length
									? { grantedAbilityTexts: [...pParams.grantedAbilityTexts] }
									: {})
							}
						: undefined;
				const layer7b =
					pParams.setPower !== undefined && pParams.setToughness !== undefined
						? {
								setPower: this.amount(pParams.setPower),
								setToughness: this.amount(pParams.setToughness)
							}
						: undefined;
				// --- Track P13 ---
				const expiryFields = buildDurationExpiryFields(s, pParams.duration ?? 'endOfTurn', you.playerId);
				// --- End Track P13 ---
				for (const o of objs) {
					const ts = allocateTimestamp(s);
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: you.playerId,
						affected: [{ instanceId: o.instanceId, objectVersion: o.objectVersion ?? 1 }],
						...expiryFields,
						layer4,
						...(layer5 ? { layer5 } : {}),
						...(layer6 ? { layer6 } : {}),
						...(layer7b ? { layer7b } : {})
					});
					noteLayerInputsChanged(s);
					if (this.ctx.item.crewedByIds !== undefined) {
						const prev = o.crewedThisTurnByIds ?? [];
						const merged = [...prev];
						for (const cid of this.ctx.item.crewedByIds) {
							if (!merged.includes(cid)) merged.push(cid);
						}
						o.crewedThisTurnByIds = merged;
						emitEvent(s, {
							kind: 'BecomesCrewed',
							playerId: you.playerId,
							objectId: o.instanceId,
							object: o,
							crewedByIds: [...this.ctx.item.crewedByIds]
						});
					}
				}
				return;
			}
			case 'saddle': {
				const objs = this.objects(step.subject).filter(
					(o) =>
						o.zone === 'battlefield' &&
						!o.phasedOut &&
						(step.subject.k !== 'self' ||
							this.ctx.item.sourceObjectVersion === undefined ||
							(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
				);
				this.bind(step, objs);
				for (const o of objs) {
					o.saddledThisTurn = true;
					const saddledBy = this.ctx.item.saddledByIds ?? [];
					const prev = o.saddledThisTurnByIds ?? [];
					const merged = [...prev];
					for (const cid of saddledBy) {
						if (!merged.includes(cid)) merged.push(cid);
					}
					o.saddledThisTurnByIds = merged;
					noteLayerInputsChanged(s);
					p.addLog(
						s,
						'rule',
						`${o.card.name} became saddled until end of turn (CR 702.171a).`,
						you.playerId
					);
					emitEvent(s, {
						kind: 'BecomesSaddled',
						playerId: you.playerId,
						objectId: o.instanceId,
						object: o,
						saddledByIds: [...saddledBy]
					});
				}
				return;
			}
			case 'cumulativeUpkeep': {
				const f = this.locate(this.ctx.sourceId);
				const onBf = Boolean(
					f &&
						f.zone === 'battlefield' &&
						!f.inst.phasedOut &&
						(this.ctx.item.sourceObjectVersion === undefined ||
							(f.inst.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
				);
				const resumingOptionalCost =
					Boolean(this.pendingOptionalCost && this.pendingOptionalCost.stepIndex === this.stepIndex) ||
					this.stepDecisions[this.stepIndex] !== undefined;
				if (!onBf && !resumingOptionalCost) return;
				const ageCounters = onBf && f ? (f.inst.counters.age ?? 0) : 0;
				const scaledCost = scaleCumulativeUpkeepCost(
					step.params?.cumulativeUpkeepCost ?? [],
					ageCounters
				);
				const ephemeralStep: EffectStep = {
					...step,
					verb: 'sacrifice',
					optional: {
						chooser: { k: 'you' },
						cost: scaledCost,
						mode: 'doUnlessPaid'
					}
				};
				const shouldSacrifice = this.resolveOptional(ephemeralStep);
				if (this.result.paused || !shouldSacrifice) return;
				return this.sacrifice(step);
			}
			case 'gainControl': {
				const objs = this.objects(step.subject).filter(
					(o) => o.zone === 'battlefield' && !o.phasedOut
				);
				this.bind(step, objs);
				if (objs.length === 0) return;
				const actorPlayer = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				if (actorPlayer.lost) return;
				const duration = step.params?.duration ?? 'permanent';
				// --- Track P13 ---
				const expiryFields = buildDurationExpiryFields(s, duration, actorPlayer.playerId);
				const expires = expiryFields.expires;
				// --- End Track P13 ---

				let untilSourceLeavesMeta: { sourceInstanceId: string; sourceObjectVersion: number } | undefined;
				if (expires === 'untilSourceLeaves') {
					const srcFound = this.ctx.sourceId ? p.findPermanent(s, this.ctx.sourceId) : null;
					const expectedVer = this.ctx.item.sourceObjectVersion;
					if (
						!srcFound ||
						(expectedVer !== undefined && (srcFound.inst.objectVersion ?? 1) !== expectedVer)
					) {
						return;
					}
					untilSourceLeavesMeta = {
						sourceInstanceId: srcFound.inst.instanceId,
						sourceObjectVersion: srcFound.inst.objectVersion ?? 1
					};
				}

				for (const o of objs) {
					if (!o.defaultControllerId) {
						o.defaultControllerId = o.controllerId;
					}
					const ts = allocateTimestamp(s);
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: actorPlayer.playerId,
						...expiryFields,
						affected: [{ instanceId: o.instanceId, objectVersion: o.objectVersion ?? 1 }],
						layer2: {
							controllerId: actorPlayer.playerId,
							...(untilSourceLeavesMeta ? { untilSourceLeaves: untilSourceLeavesMeta } : {})
						},
						...(step.params?.keywords?.length
							? { layer6: { addKeywords: [...step.params.keywords] } }
							: {})
					});
					if (step.params?.untap && o.tapped) {
						if ((o.counters.stun || 0) > 0) {
							o.counters.stun = Math.max(0, (o.counters.stun || 0) - 1);
						} else {
							o.tapped = false;
							// --- Track P10 ---
							if (!o.phasedOut) {
								emitEvent(s, {
									kind: 'BecomesUntapped',
									objectId: o.instanceId,
									object: o
								});
							}
							// --- End Track P10 ---
						}
					}
					const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
					p.addLog(
						s,
						'rule',
						`${actorPlayer.username} gains control of ${objLabel}${expires === 'endOfTurn' ? ' until end of turn' : ''}.`,
						actorPlayer.playerId
					);
				}
				noteLayerInputsChanged(s);
				syncBattlefieldControllers(s);
				return;
			}
			case 'gainEnergy': {
				const n = Math.max(0, this.amount(step.amount, 0));
				if (n <= 0) return;
				const targets =
					step.subject.k === 'none' && step.actor
						? this.players({ k: 'playerRef', ref: step.actor })
						: this.players(step.subject);
				for (const pl of targets) {
					if (pl.lost) continue;
					pl.energyCounters = (pl.energyCounters || 0) + n;
					noteLayerInputsChanged(s);
					p.addLog(
						s,
						'rule',
						`${title}: ${pl.username} gets ${n} {E} (now ${pl.energyCounters} {E}).`,
						you.playerId
					);
				}
				return;
			}
			case 'becomeMonarch': {
				const targets =
					step.subject.k === 'none' && step.actor
						? this.players({ k: 'playerRef', ref: step.actor })
						: this.players(step.subject);
				const chosen = targets.find((pl) => !pl.lost);
				if (chosen) {
					p.setMonarch(s, chosen.playerId);
				}
				return;
			}
			// --- Track P5 ---
			case 'amass':
				return executeAmass(this.keywordHost(), step);
			case 'incubate':
				return executeIncubate(this.keywordHost(), step);
			case 'populate':
				return executePopulate(this.keywordHost(), step);
			case 'manifest':
				return executeManifestOrCloak(this.keywordHost(), step, 'manifest');
			case 'cloak':
				return executeManifestOrCloak(this.keywordHost(), step, 'cloak');
			case 'manifestDread':
				return executeManifestDread(this.keywordHost(), step);
			case 'monstrosity':
				return executeMonstrosity(this.keywordHost(), step);
			case 'bolster':
				return executeBolster(this.keywordHost(), step);
			case 'adapt':
				return executeAdapt(this.keywordHost(), step);
			// --- Track P10 ---
			case 'discover':
				return executeDiscover(this.p10Host(), step);
			case 'clash':
				return executeClash(this.p10Host(), step);
			case 'detain':
				return executeDetain(this.p10Host(), step);
			case 'suspect':
				return executeSuspect(this.p10Host(), step);
			case 'collectEvidence':
				return executeCollectEvidence(this.p10Host(), step);
			case 'forage':
				return executeForage(this.p10Host(), step);
			case 'endure':
				return executeEndure(this.p10Host(), step);
			case 'timeTravel':
				return executeTimeTravel(this.p10Host(), step);
			case 'blight':
				return executeBlight(this.p10Host(), step);
			case 'fateseal':
				return executeFateseal(this.p10Host(), step);
			case 'flipCoin':
				return executeFlipCoin(this.p10Host(), step);
			case 'rollDie':
				return executeRollDie(this.p10Host(), step);
			// --- End Track P10 ---
			// --- Track P13 ---
			case 'createEmblem': {
				const recipients =
					step.subject.k === 'none'
						? step.actor
							? this.players({ k: 'playerRef', ref: step.actor })
							: [you]
						: this.players(step.subject);
				executeCreateEmblem(
					s,
					recipients,
					this.ctx.sourceCard.name || title,
					step.params?.emblemAbilities ?? []
				);
				return;
			}
			case 'createRoleToken': {
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				const roleKind = step.params?.roleKind;
				if (!roleKind) return;
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				const created: CardInstance[] = [];
				withSimultaneousZoneBatch(s, () => {
					created.push(...executeCreateRoleToken(s, actor, objs, roleKind));
				});
				this.bind(step, created);
				this.recordEffectAmount(created.length);
				return;
			}
			case 'doubleOrTriple': {
				const spec = step.params?.doubleSpec;
				if (!spec) return;
				const objs =
					spec.target === 'life'
						? []
						: this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				const pls =
					spec.target === 'life'
						? step.subject.k === 'none'
							? [you]
							: this.players(step.subject)
						: [];
				if (objs.length > 0) this.bind(step, objs);
				const delta = executeDoubleOrTriple(
					s,
					you,
					this.ctx.sourceCard.name || title,
					objs,
					pls,
					spec,
					this.p13LifeFunnels()
				);
				this.recordEffectAmount(delta);
				return;
			}
			case 'exchange': {
				const spec = step.params?.exchangeSpec;
				if (!spec) return;
				const firstObjs =
					step.subject.k === 'none'
						? []
						: this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				const secondObjs = spec.second
					? this.objects(spec.second).filter((o) => o.zone === 'battlefield')
					: [];
				let pls: PlayerGameState[] = [];
				if (spec.kind === 'lifeTotals' || spec.kind === 'lifeAndPower' || spec.kind === 'lifeAndToughness') {
					pls = this.players(step.subject);
					if (spec.second) {
						for (const extra of this.players(spec.second)) {
							if (!pls.some((pl) => pl.playerId === extra.playerId)) pls.push(extra);
						}
					}
				}
				executeExchange(
					s,
					you,
					this.ctx.sourceCard.name || title,
					firstObjs,
					secondObjs,
					pls,
					spec,
					this.p13LifeFunnels()
				);
				return;
			}
			case 'turnFace': {
				const dir = step.params?.faceDirection ?? 'up';
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				executeTurnFace(s, objs, dir);
				return;
			}
			case 'chooseDesignation': {
				const chooseKind = step.params?.chooseKind;
				if (!chooseKind) return;
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				executeChooseDesignation(
					s,
					actor,
					this.sourcePerm,
					chooseKind,
					`p13_desig:${this.stepIndex}`,
					this.p13AskFn()
				);
				return;
			}
			case 'grantGraveyardCast': {
				const spec = step.params?.graveyardCastSpec;
				if (!spec) return;
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				const objs = this.objects(step.subject).filter((o) => o.zone === 'graveyard');
				this.bind(step, objs);
				executeGrantGraveyardCast(s, actor, this.ctx.sourceCard.name || title, objs, spec);
				return;
			}
			case 'ventureIntoDungeon': {
				const dungeonKind = step.params?.dungeonKind ?? 'dungeon';
				const players =
					step.subject.k === 'none'
						? step.actor
							? this.players({ k: 'playerRef', ref: step.actor })
							: [you]
						: this.players(step.subject);
				for (let idx = 0; idx < players.length; idx++) {
					const pl = players[idx];
					const doneKey = `p13_vent_done:${this.stepIndex}:${pl.playerId}:${idx}`;
					if (this.answers[doneKey]?.kind === 'yesNo' && this.answers[doneKey].yes) continue;
					const st = executeVentureIntoDungeon(
						s,
						pl,
						dungeonKind,
						`p13_venture:${this.stepIndex}:${pl.playerId}:${idx}`,
						this.p13AskFn()
					);
					if (st === 'PAUSED') return;
					this.answers[doneKey] = { kind: 'yesNo', yes: true };
				}
				return;
			}
			case 'takeInitiative': {
				const players =
					step.subject.k === 'none'
						? step.actor
							? this.players({ k: 'playerRef', ref: step.actor })
							: [you]
						: this.players(step.subject);
				const chosen = players.find((pl) => !pl.lost);
				if (chosen) {
					executeTakeInitiative(
						s,
						chosen,
						`p13_init:${this.stepIndex}`,
						this.p13AskFn()
					);
				}
				return;
			}
			case 'temptWithRing': {
				const players =
					step.subject.k === 'none'
						? step.actor
							? this.players({ k: 'playerRef', ref: step.actor })
							: [you]
						: this.players(step.subject);
				for (let idx = 0; idx < players.length; idx++) {
					const pl = players[idx];
					const doneKey = `p13_ring_done:${this.stepIndex}:${pl.playerId}:${idx}`;
					if (this.answers[doneKey]?.kind === 'yesNo' && this.answers[doneKey].yes) continue;
					const st = executeTemptWithRing(
						s,
						pl,
						`p13_ring:${this.stepIndex}:${pl.playerId}:${idx}`,
						this.p13AskFn()
					);
					if (st === 'PAUSED') return;
					this.answers[doneKey] = { kind: 'yesNo', yes: true };
				}
				return;
			}
			case 'earthbend': {
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const n = Math.max(0, this.amount(step.amount, 0));
				executeEarthbend(s, actor, this.ctx.sourceCard.name || title, objs, n);
				return;
			}
			case 'airbend': {
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				if (step.subject.k === 'target') {
					const refs = this.targetsForSpecIndex(step.subject.index);
					for (const ref of refs) {
						if (ref.kind === 'stack') {
							const stItem =
								s.stack.find((x) => x.id === ref.id || x.sourceInstanceId === ref.id) ?? null;
							executeAirbend(s, actor, null, stItem);
						} else if (ref.kind === 'permanent') {
							const perm = this.locate(ref.id)?.inst ?? null;
							executeAirbend(s, actor, perm, null);
						}
					}
				} else {
					const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
					this.bind(step, objs);
					for (const o of objs) {
						executeAirbend(s, actor, o, null);
					}
				}
				return;
			}
			case 'learn': {
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				executeLearn(
					s,
					actor,
					`p13_learn:${this.stepIndex}`,
					this.p13AskFn(),
					(pl, cnt) => p.drawCards(s, pl, cnt)
				);
				return;
			}
			case 'villainousChoice': {
				const opts = step.params?.villainousOptions;
				const labels = step.params?.villainousOptionLabels ?? ['Option 1', 'Option 2'];
				if (!opts) return;
				const opponents =
					step.subject.k === 'none'
						? this.apnapPlayers().filter((pl) => pl.playerId !== you.playerId)
						: this.players(step.subject);
				let inlineCursor = 0;
				executeVillainousChoice(
					opponents,
					labels,
					opts,
					`p13_vil:${this.stepIndex}`,
					this.p13AskFn(),
					(branchSteps, facingOpp) => {
						const tag = inlineCursor++;
						return this.runTrackedP13InlineSteps(branchSteps, tag, facingOpp.playerId);
					}
				);
				return;
			}
			case 'vote': {
				const spec = step.params?.voteSpec;
				if (!spec) return;
				const actor = (step.actor ? this.playerRef(step.actor) : null) ?? you;
				let inlineCursor = 0;
				executeCouncilVote(
					s,
					actor,
					spec,
					`p13_vote:${this.stepIndex}`,
					this.p13AskFn(),
					(branchSteps) => {
						const tag = inlineCursor++;
						return this.runTrackedP13InlineSteps(branchSteps, tag);
					}
				);
				return;
			}
			// --- End Track P13 ---
			default:
				// Not reachable: staticallyInterpretable rejects every other verb.
				p.addLog(s, 'rule', `${title}: the "${step.verb}" step isn't supported yet and did nothing.`, you.playerId);
		}
	}

	sourceDamageInfo(
		sourcePerm: CardInstance | null,
		sourceCard: ScryfallCard
	): SourceDamageInfo {
		return sourceDamageInfo(this.state, sourcePerm, sourceCard);
	}

	permanentProtectedFromSource(
		target: CardInstance,
		srcInfo: SourceDamageInfo
	): boolean {
		return permanentProtectedFromSource(this.state, target, srcInfo);
	}

	dealDamageToPermanent(
		target: CardInstance,
		rawAmount: number,
		sourceId: string,
		srcInfo: SourceDamageInfo
	): number {
		// --- Track P13 (CR 120.10): Compute lethal threshold before marking damage ---
		const evBefore = evaluatePermanent(this.state, target);
		const lethalBefore = evBefore.isPlaneswalker
			? Math.max(0, target.counters.loyalty || 0)
			: evBefore.isCreature
				? srcInfo.hasDeathtouch
					? target.deathtouchDamageMarked
						? 0
						: 1
					: Math.max(0, evBefore.toughness - target.damageMarked)
				: rawAmount;
		// --- End Track P13 ---
		const dealt = dealDamageToPermanent(this.state, target, rawAmount, sourceId, srcInfo, {
			combat: false,
			actorId: this.you.playerId
		});
		// --- Track P13 (CR 120.10) ---
		const excess = dealt > 0 ? Math.max(0, dealt - lethalBefore) : 0;
		this.lastExcessDamage = excess;
		this.ctx.item.lastExcessDamage = excess;
		// --- End Track P13 ---
		return dealt;
	}

	dealDamageToPlayer(
		pl: PlayerGameState,
		rawAmount: number,
		sourceId: string,
		srcInfo: SourceDamageInfo
	): number {
		return dealDamageToPlayer(this.state, pl, rawAmount, sourceId, srcInfo, {
			combat: false,
			vfxSourceId: this.you.playerId
		});
	}

	applyLifelinkGain(controller: PlayerGameState, totalDealt: number): void {
		applyLifelinkGain(this.state, controller, totalDealt);
	}

	resolveDamageSource(
		dmgSrc: Selector | undefined
	): { srcPerm: CardInstance | null; srcId: string; srcCard: ScryfallCard; srcController: PlayerGameState } | null {
		const you = this.you;
		if (!dmgSrc || dmgSrc.k === 'self') {
			const found = this.locate(this.ctx.sourceId);
			const expectedVer = this.ctx.item?.sourceObjectVersion;
			const livePerm =
				found &&
				found.zone === 'battlefield' &&
				!found.inst.phasedOut &&
				(expectedVer === undefined || found.inst.objectVersion === expectedVer)
					? found.inst
					: null;
			const srcCard = livePerm ? (livePerm.copiableCard ?? livePerm.card) : this.ctx.sourceCard;
			const srcController = livePerm ? (this.player(livePerm.controllerId) ?? you) : you;
			return { srcPerm: livePerm, srcId: this.ctx.sourceId, srcCard, srcController };
		}
		if (dmgSrc.k === 'eventObject') {
			const found = this.ctx.eventObjectId ? this.locate(this.ctx.eventObjectId) : null;
			const sameOnBf =
				found &&
				found.zone === 'battlefield' &&
				!found.inst.phasedOut &&
				(this.ctx.eventObjectVersion === undefined || found.inst.objectVersion === this.ctx.eventObjectVersion);
			const livePerm = sameOnBf ? found.inst : null;
			const srcId = this.ctx.eventObjectId ?? this.ctx.sourceId;
			const srcCard = found ? (found.inst.copiableCard ?? found.inst.card) : this.ctx.sourceCard;
			const ctrlId = livePerm ? livePerm.controllerId : (this.ctx.eventLki?.controllerId ?? you.playerId);
			const srcController = this.player(ctrlId) ?? you;
			return { srcPerm: livePerm, srcId, srcCard, srcController };
		}
		if (dmgSrc.k === 'target') {
			// CR 608.2b: if the targeted creature dealing damage is illegal or no longer on the battlefield, it deals 0 damage.
			const t = this.targetsForSpecIndex(dmgSrc.index)[0];
			if (!t || t.kind !== 'permanent') return null;
			const found = this.locate(t.id);
			if (!found || found.zone !== 'battlefield' || found.inst.phasedOut) return null;
			const inst = found.inst;
			return {
				srcPerm: inst,
				srcId: inst.instanceId,
				srcCard: inst.copiableCard ?? inst.card,
				srcController: this.player(inst.controllerId) ?? you
			};
		}
		const inst = this.objects(dmgSrc).find((o) => o.zone === 'battlefield' && !o.phasedOut) ?? null;
		if (!inst) return null;
		return {
			srcPerm: inst,
			srcId: inst.instanceId,
			srcCard: inst.copiableCard ?? inst.card,
			srcController: this.player(inst.controllerId) ?? you
		};
	}

	// --- Track P7 ---
	preventDamageStep(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const spec = step.params?.preventSpec;
		if (!spec) return;
		const remaining: number | 'infinite' =
			spec.mode === 'all' ? 'infinite' : Math.max(0, this.amount(step.amount, 1));
		if (remaining !== 'infinite' && remaining <= 0) return;

		let fromSourceInstanceId: string | undefined;
		let fromSourceObjectVersion: number | undefined;
		let fromSourceTypes: string[] | undefined;
		let fromAttackingOnly: boolean | undefined;

		if (spec.fromSource) {
			if (spec.fromSource.k === 'all') {
				if (spec.fromSource.filter.types?.length) {
					fromSourceTypes = [...spec.fromSource.filter.types];
				}
				if (spec.fromSource.filter.attacking) {
					fromAttackingOnly = true;
				}
			} else {
				const srcObj = this.objects(spec.fromSource)[0];
				if (!srcObj) return;
				fromSourceInstanceId = srcObj.instanceId;
				if (srcObj.zone === 'battlefield') {
					fromSourceObjectVersion = srcObj.objectVersion ?? 1;
				}
			}
		}

		const baseFields = {
			controllerId: you.playerId,
			sourceName: this.ctx.sourceCard.name || this.ctx.title,
			combatOnly: spec.combatOnly,
			remaining,
			...(fromSourceInstanceId !== undefined ? { fromSourceInstanceId } : {}),
			...(fromSourceObjectVersion !== undefined ? { fromSourceObjectVersion } : {}),
			...(fromSourceTypes ? { fromSourceTypes } : {}),
			...(fromAttackingOnly ? { fromAttackingOnly: true } : {})
		};

		if (spec.scope === 'any') {
			addDamagePreventionShield(s, {
				...baseFields,
				id: p.uid('pshield', s),
				targetKind: 'any'
			});
			return;
		}

		if (spec.scope === 'youAndCreaturesYouControl') {
			if (remaining === 'infinite') {
				addDamagePreventionShield(s, {
					...baseFields,
					id: p.uid('pshield', s),
					targetKind: 'playerAndPermanentsControlledBy',
					targetId: you.playerId,
					targetTypes: ['Creature']
				});
			} else {
				addDamagePreventionShield(s, {
					...baseFields,
					id: p.uid('pshield', s),
					targetKind: 'player',
					targetId: you.playerId
				});
				for (const perm of you.battlefield) {
					if (perm.phasedOut || !this.matches(perm, { types: ['Creature'] }, 'battlefield')) continue;
					addDamagePreventionShield(s, {
						...baseFields,
						id: p.uid('pshield', s),
						targetKind: 'permanent',
						targetId: perm.instanceId,
						targetObjectVersion: perm.objectVersion ?? 1
					});
				}
			}
			return;
		}

		const sel = step.subject;
		if (sel.k === 'target' && !(this.ctx.targetsBecomeEach ?? this.ctx.item.spellMods?.targetsBecomeEach)) {
			const refs = this.targetsForSpecIndex(sel.index);
			const boundPerms: CardInstance[] = [];
			for (const t of refs) {
				if (t.kind === 'player') {
					const pl = this.player(t.id);
					if (pl && !pl.lost) {
						addDamagePreventionShield(s, {
							...baseFields,
							id: p.uid('pshield', s),
							targetKind: 'player',
							targetId: pl.playerId
						});
					}
				} else if (t.kind === 'permanent') {
					const perm = this.locate(t.id)?.inst;
					if (perm && perm.zone === 'battlefield' && !perm.phasedOut) {
						boundPerms.push(perm);
						addDamagePreventionShield(s, {
							...baseFields,
							id: p.uid('pshield', s),
							targetKind: 'permanent',
							targetId: perm.instanceId,
							targetObjectVersion: perm.objectVersion ?? 1,
							...(spec.alsoPreventDealtBySubject ? { alsoPreventDealtByTarget: true } : {})
						});
					}
				}
			}
			this.bind(step, boundPerms);
			return;
		}

		if (sel.k === 'player' || sel.k === 'playerRef') {
			for (const pl of this.players(sel)) {
				addDamagePreventionShield(s, {
					...baseFields,
					id: p.uid('pshield', s),
					targetKind: 'player',
					targetId: pl.playerId
				});
			}
			return;
		}

		if (
			sel.k === 'all' &&
			remaining === 'infinite' &&
			!spec.alsoPreventDealtBySubject &&
			sel.filter.controller === 'you' &&
			Object.keys(sel.filter).every((k) => k === 'controller' || k === 'types' || k === 'zone')
		) {
			addDamagePreventionShield(s, {
				...baseFields,
				id: p.uid('pshield', s),
				targetKind: 'permanentsControlledBy',
				targetId: you.playerId,
				...(sel.filter.types?.length ? { targetTypes: [...sel.filter.types] } : {})
			});
			return;
		}

		const objs = this.objects(sel).filter((o) => {
			if (o.zone !== 'battlefield' || o.phasedOut) return false;
			if (
				sel.k === 'self' &&
				this.ctx.item.sourceObjectVersion !== undefined &&
				(o.objectVersion ?? 1) !== this.ctx.item.sourceObjectVersion
			) {
				return false;
			}
			return true;
		});
		this.bind(step, objs);
		for (const o of objs) {
			addDamagePreventionShield(s, {
				...baseFields,
				id: p.uid('pshield', s),
				targetKind: 'permanent',
				targetId: o.instanceId,
				targetObjectVersion: o.objectVersion ?? 1,
				...(spec.alsoPreventDealtBySubject ? { alsoPreventDealtByTarget: true } : {})
			});
		}
	}

	discardHandStep(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const batchKey = `batch:${this.stepIndex}:discardHand`;
		const countsKey = `discardHandCounts:${this.stepIndex}`;

		if (!this.answers[countsKey]) {
			const actors = step.actor
				? this.players({ k: 'playerRef', ref: step.actor })
				: step.subject.k === 'none'
					? [you]
					: this.players(step.subject);
			const encodedCounts: string[] = [];
			const cardIds: string[] = [];
			const allCards: CardInstance[] = [];
			for (const pl of actors) {
				encodedCounts.push(`${pl.playerId}|${pl.hand.length}`);
				for (const c of pl.hand) {
					cardIds.push(c.instanceId);
					allCards.push(c);
				}
				p.addLog(
					s,
					'rule',
					`${pl.username} discarded their hand (${pl.hand.length} card(s)).`,
					pl.playerId
				);
			}
			this.bind(step, allCards);
			this.answers[countsKey] = { kind: 'chooseObjects', objectIds: encodedCounts };
			this.answers[batchKey] = { kind: 'chooseObjects', objectIds: cardIds };
		}

		const { paused } = this.runIndexedBatch(
			batchKey,
			() => [],
			(id) => {
				const f = this.locate(id);
				if (!f || f.zone !== 'hand') return;
				return moveObject(s, f.inst, 'graveyard', {
					from: { player: f.holder, zone: 'hand' },
					toPlayer: f.holder,
					graveyardReplacement: true,
					bumpVersion: true,
					newTimestamp: true,
					discardReason: 'discard',
					discardPlayerId: f.holder.playerId
				});
			}
		);
		if (paused) return;

		const drawAfter = step.params?.drawAfterDiscardHand;
		if (drawAfter !== undefined) {
			const encoded =
				this.answers[countsKey]?.kind === 'chooseObjects' ? this.answers[countsKey].objectIds : [];
			for (const entry of encoded) {
				const [pid, rawCount] = entry.split('|');
				const pl = this.player(pid);
				if (!pl || pl.lost) continue;
				const prevCount = Number(rawCount) || 0;
				const drawN =
					drawAfter === 'thatMany' ? prevCount : Math.max(0, this.amount(drawAfter, 0));
				if (drawN > 0) {
					p.drawCards(s, pl, drawN);
					p.addLog(s, 'rule', `${pl.username} drew ${drawN} card(s).`, you.playerId);
				}
			}
		}
	}
	// --- End Track P7 ---

	damage(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const resolvedSrc = this.resolveDamageSource(step.params?.damageSource);
		if (!resolvedSrc) {
			// --- Track P7 ---
			this.bind(step, []);
			// --- End Track P7 ---
			return;
		}
		const n = this.amount(step.amount);
		if (n <= 0) {
			// --- Track P7 ---
			this.bind(step, []);
			// --- End Track P7 ---
			return;
		}
		const sel = step.subject;
		const { srcPerm, srcId, srcCard, srcController } = resolvedSrc;
		const srcInfo = this.sourceDamageInfo(srcPerm, srcCard);
		let totalDealt = 0;
		// --- Track P7 ---
		const damagedPerms: CardInstance[] = [];
		const isDivided = Boolean(step.params?.divided);
		// --- End Track P7 ---

		if (sel.k === 'target' && !(this.ctx.targetsBecomeEach ?? this.ctx.item.spellMods?.targetsBecomeEach)) {
			const targetRefs = this.targetsForSpecIndex(sel.index);
			for (let idx = 0; idx < targetRefs.length; idx++) {
				const t = targetRefs[idx];
				// --- Track P7 ---
				const amt = isDivided
					? getLockedTargetDivisionAmount(this.ctx.item, t.id, n, idx, targetRefs.length)
					: n;
				if (amt <= 0) continue;
				// --- End Track P7 ---
				if (t.kind === 'player') {
					const pl = this.player(t.id);
					if (pl) totalDealt += this.dealDamageToPlayer(pl, amt, srcId, srcInfo);
				} else if (t.kind === 'permanent') {
					const perm = this.locate(t.id)?.inst;
					if (perm && perm.zone === 'battlefield') {
						const dealt = this.dealDamageToPermanent(perm, amt, srcId, srcInfo);
						totalDealt += dealt;
						// --- Track P7 ---
						if (dealt > 0) damagedPerms.push(perm);
						// --- End Track P7 ---
					}
				}
			}
			// --- Track P7 ---
			this.bind(step, damagedPerms);
			// --- End Track P7 ---
			// --- Track P13 ---
			this.recordEffectAmount(totalDealt);
			// --- End Track P13 ---
			if (srcInfo.hasLifelink) this.applyLifelinkGain(srcController, totalDealt);
			return;
		}
		if (sel.k === 'player' || sel.k === 'playerRef') {
			for (const pl of this.players(sel)) {
				totalDealt += this.dealDamageToPlayer(pl, n, srcId, srcInfo);
			}
			// --- Track P7 ---
			this.bind(step, []);
			// --- End Track P7 ---
			// --- Track P13 ---
			this.recordEffectAmount(totalDealt);
			// --- End Track P13 ---
			if (srcInfo.hasLifelink) this.applyLifelinkGain(srcController, totalDealt);
			return;
		}
		const objs = this.objects(sel).filter((o) => o.zone === 'battlefield');
		for (const o of objs) {
			const dealt = this.dealDamageToPermanent(o, n, srcId, srcInfo);
			totalDealt += dealt;
			// --- Track P7 ---
			if (dealt > 0) damagedPerms.push(o);
			// --- End Track P7 ---
		}
		// --- Track P7 ---
		this.bind(step, damagedPerms);
		// --- End Track P7 ---
		const extraPlayers = step.params?.alsoDamagePlayers
			? this.players({ k: 'player', filter: step.params.alsoDamagePlayers })
			: [];
		for (const pl of extraPlayers) {
			totalDealt += this.dealDamageToPlayer(pl, n, srcId, srcInfo);
		}
		// --- Track P13 ---
		this.recordEffectAmount(totalDealt);
		// --- End Track P13 ---
		if (srcInfo.hasLifelink) this.applyLifelinkGain(srcController, totalDealt);
		if (sel.k === 'all') {
			p.addLog(s, 'combat', `${this.ctx.title} dealt ${n} damage to ${objs.length} permanent(s)!`, you.playerId);
		}
	}

	resolveSingleFighter(sel: Selector): CardInstance | null {
		if (sel.k === 'target') {
			const active = this.activeTargetSpecs();
			if (
				!this.ctx.item?.targetsBySpec &&
				active.length > 1 &&
				this.ctx.targets.length < active.filter((entry) => entry.spec.min > 0).length
			) {
				return null;
			}
			const t = this.targetsForSpecIndex(sel.index)[0];
			if (!t || t.kind === 'player' || t.kind === 'stack') return null;
			const inst = this.locate(t.id)?.inst ?? null;
			return inst && !inst.phasedOut ? inst : null;
		}
		if (sel.k === 'self') {
			const inst = this.locate(this.ctx.sourceId)?.inst ?? null;
			if (!inst || inst.phasedOut) return null;
			if (
				this.ctx.item?.sourceObjectVersion !== undefined &&
				inst.objectVersion !== this.ctx.item.sourceObjectVersion
			) {
				return null;
			}
			return inst;
		}
		return this.objects(sel)[0] ?? null;
	}

	fight(step: EffectStep): void {
		const s = this.state;
		const withSel = step.params?.with;
		let fighterA: CardInstance | null = null;
		let fighterB: CardInstance | null = null;
		if (withSel) {
			fighterA = this.resolveSingleFighter(step.subject);
			fighterB = this.resolveSingleFighter(withSel);
		} else if (step.subject.k === 'target' && this.ctx.targets.length >= 2) {
			fighterA = this.resolveSingleFighter({ k: 'target', index: 0 });
			fighterB = this.resolveSingleFighter({ k: 'target', index: 1 });
		}
		// CR 701.14b: If one or both creatures are no longer on the battlefield or no longer creatures,
		// neither of them deals or is dealt damage.
		if (!fighterA || !fighterB) return;
		if (fighterA.zone !== 'battlefield' || fighterB.zone !== 'battlefield') return;
		if (fighterA.phasedOut || fighterB.phasedOut) return;
		const evA = evaluatePermanent(s, fighterA);
		const evB = evaluatePermanent(s, fighterB);
		if (!evA.isCreature || !evB.isCreature) return;

		const powerA = Math.max(0, evA.breakdown.effectivePower ?? 0);
		const powerB = Math.max(0, evB.breakdown.effectivePower ?? 0);
		const infoA = this.sourceDamageInfo(fighterA, fighterA.copiableCard ?? fighterA.card);
		const infoB = this.sourceDamageInfo(fighterB, fighterB.copiableCard ?? fighterB.card);
		const ctrlA = this.player(fighterA.controllerId) ?? this.you;
		const ctrlB = this.player(fighterB.controllerId) ?? this.you;

		// CR 701.14c: If a creature fights itself, it deals damage to itself equal to twice its power.
		if (fighterA.instanceId === fighterB.instanceId) {
			const dealt = this.dealDamageToPermanent(fighterA, powerA * 2, fighterA.instanceId, infoA);
			if (infoA.hasLifelink) this.applyLifelinkGain(ctrlA, dealt);
			return;
		}

		// Simultaneous fight damage (power and source keywords snapshotted before either deals damage)
		const dealtByA = this.dealDamageToPermanent(fighterB, powerA, fighterA.instanceId, infoA);
		const dealtByB = this.dealDamageToPermanent(fighterA, powerB, fighterB.instanceId, infoB);
		if (infoA.hasLifelink) this.applyLifelinkGain(ctrlA, dealtByA);
		if (infoB.hasLifelink) this.applyLifelinkGain(ctrlB, dealtByB);
	}

	sacrifice(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const sel = step.subject;
		const batchKey = `batch:${this.stepIndex}`;

		// --- Track P10 ---
		const isExploit = isExploitTriggerStackItem(this.ctx.item);
		const sacrificePermanent = (actor: PlayerGameState, perm: CardInstance): MoveResult => {
			const preSnap = this.captureTriggerEventLki(perm);
			const exploitedLki = isExploit ? captureLki(s, perm) : undefined;
			const res = p.moveFromBattlefield(s, perm, 'graveyard', {
				sacrificedByPlayerId: actor.playerId
			});
			p.addLog(s, 'rule', `${actor.username} sacrificed ${perm.card.name}.`, actor.playerId);
			if (perm.zone !== 'battlefield') {
				this.recordStepActedObject(perm, preSnap, perm.zone === 'graveyard');
				if (isExploit) {
					emitEvent(s, {
						kind: 'Exploited',
						playerId: actor.playerId,
						exploiterId: this.ctx.sourceId,
						...(this.ctx.item.sourceObjectVersion !== undefined
							? { exploiterVersion: this.ctx.item.sourceObjectVersion }
							: {}),
						exploitedId: perm.instanceId,
						exploited: perm,
						...(exploitedLki ? { exploitedLki } : {})
					});
					flushTriggers(s);
				}
			}
			return res as MoveResult;
		};
		// --- End Track P10 ---

		// Specific object(s) (e.g. "sacrifice ~", "sacrifice it", or "sacrifice that creature")
		if (sel.k === 'self' || sel.k === 'binding' || sel.k === 'target' || sel.k === 'eventObject') {
			const actor = step.actor ? (this.playerRef(step.actor) ?? you) : you;
			this.runIndexedBatch(
				batchKey,
				() => {
					const objs = this.objects(sel).filter(
						(o) =>
							o.zone === 'battlefield' &&
							o.controllerId === actor.playerId &&
							(sel.k !== 'self' ||
								this.ctx.item.sourceObjectVersion === undefined ||
								(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
					);
					this.bind(step, objs);
					return objs.map((o) => o.instanceId);
				},
				(id) => {
					const f = this.locate(id);
					if (!f || f.zone !== 'battlefield') return;
					return sacrificePermanent(actor, f.inst);
				}
			);
			return;
		}

		// CR 701.21a / 101.4: each player chooses (in turn order), then all are sacrificed at once.
		// Once choices are gathered and captured in `batchKey`, process them via `runIndexedBatch`.
		if (!this.answers[batchKey]) {
			const actors = step.actor
				? this.players({ k: 'playerRef', ref: step.actor })
				: sel.k === 'player' || sel.k === 'playerRef'
					? this.players(sel)
					: sel.k === 'all' && sel.filter.controller === 'opponent'
						? this.players({ k: 'player', filter: { relation: 'each_opponent' } })
						// --- Track P7 ---
						: sel.k === 'all' && sel.filter.controller === 'any'
							? this.players({ k: 'player', filter: { relation: 'each_player' } })
							// --- End Track P7 ---
							: [you];

			const filter: ObjectFilter =
				sel.k === 'all' ? { ...sel.filter, controller: undefined } : {};

			const choices: Array<{ actor: PlayerGameState; candidates: CardInstance[]; count: number }> = [];
			for (const actor of actors) {
				const candidates = actor.battlefield.filter(
					(c) => !c.phasedOut && c.controllerId === actor.playerId && this.matches(c, filter, 'battlefield')
				);
				if (candidates.length === 0) continue;
				const count =
					sel.k === 'all' && !step.amount
						? candidates.length
						: Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
				if (count <= 0) continue;
				choices.push({ actor, candidates, count });
			}
			const atRandom = Boolean((step.params as { atRandom?: boolean } | undefined)?.atRandom);
			if (!atRandom && this.canPause) {
				for (const { actor, candidates, count } of choices) {
					const actorKey = `actor:${this.stepIndex}:${actor.playerId}`;
					if (actor.isBot || candidates.length <= count || this.answers[actorKey] || this.answers[actor.playerId]) continue;
					const title = `${this.ctx.title} — Sacrifice ${count} permanent(s)`;
					// --- Track P7 ---
					const defaultIds = candidates.slice(0, count).map((c) => c.instanceId);
					this.pauseForChoice(actor, title, `Choose ${count} permanent(s) to sacrifice.`, candidates.map((c) => c.instanceId), count, count, 'battlefield', defaultIds, actorKey);
					// --- End Track P7 ---
					return;
				}
			}
			const sacrificed: CardInstance[] = [];
			for (const { actor, candidates, count } of choices) {
				let chosen: CardInstance[];
				if (atRandom) {
					const pool = [...candidates];
					chosen = [];
					for (let i = 0; i < count && pool.length > 0; i++) {
						const idx = Math.floor(nextRandom(s) * pool.length);
						chosen.push(pool.splice(idx, 1)[0]);
					}
				} else {
					const actorKey = `actor:${this.stepIndex}:${actor.playerId}`;
					chosen = this.answered(actorKey, candidates, count) ?? this.answered(actor, candidates, count) ?? candidates.slice(0, count);
				}
				sacrificed.push(...chosen);
			}
			this.bind(step, sacrificed);
			this.answers[batchKey] = {
				kind: 'chooseObjects',
				objectIds: sacrificed.map((o) => o.instanceId)
			};
		}

		this.runIndexedBatch(
			batchKey,
			() => [],
			(id) => {
				const f = this.locate(id);
				if (!f || f.zone !== 'battlefield') return;
				const actor = f.holder;
				// --- Track P10 ---
				return sacrificePermanent(actor, f.inst);
				// --- End Track P10 ---
			}
		);
	}

	discard(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const sel = step.subject;
		const batchKey = `batch:${this.stepIndex}`;

		const discardCard = (pl: PlayerGameState, cardInst: CardInstance): MoveResult | void => {
			if (!pl.hand.includes(cardInst)) return;
			// --- Track P10 ---
			const preSnap = this.captureTriggerEventLki(cardInst);
			// --- End Track P10 ---
			const res = moveObject(s, cardInst, 'graveyard', {
				from: { player: pl, zone: 'hand' },
				toPlayer: pl,
				graveyardReplacement: true,
				bumpVersion: true,
				newTimestamp: true,
				discardReason: 'discard',
				discardPlayerId: pl.playerId
			});
			// --- Track P10 ---
			if (!pl.hand.includes(cardInst)) {
				this.recordStepActedObject(cardInst, preSnap, false);
			}
			// --- End Track P10 ---
			return res;
		};

		if (sel.k === 'self' || sel.k === 'binding') {
			this.runIndexedBatch(
				batchKey,
				() => {
					const objs = this.objects(sel).filter((o) => o.zone === 'hand');
					this.bind(step, objs);
					return objs.map((o) => o.instanceId);
				},
				(id) => {
					const f = this.locate(id);
					if (!f || f.zone !== 'hand') return;
					const res = discardCard(f.holder, f.inst);
					p.addLog(s, 'rule', `${f.holder.username} discarded ${f.inst.card.name}.`, f.holder.playerId);
					return res;
				}
			);
			return;
		}

		if (!this.answers[batchKey]) {
			const actors = step.actor
				? this.players({ k: 'playerRef', ref: step.actor })
				: sel.k === 'player' || sel.k === 'playerRef' || sel.k === 'target'
					? this.players(sel)
					: sel.k === 'all' && sel.filter.controller === 'opponent'
						? this.players({ k: 'player', filter: { relation: 'each_opponent' } })
						: [you];

			const filter: ObjectFilter | null =
				sel.k === 'all' ? { ...sel.filter, controller: undefined, owner: undefined } : null;

			// CR 701.8: each player chooses (in turn order), then all discard at once. A human with a real
			// choice gets a prompt; resolution pauses until every such human answered.
			const choices: Array<{ pl: PlayerGameState; candidates: CardInstance[]; count: number }> = [];
			for (const pl of actors) {
				const candidates = filter
					? pl.hand.filter((c) => this.matches(c, filter, 'hand'))
					: [...pl.hand];
				if (candidates.length === 0) continue;
				const count =
					sel.k === 'all' && !step.amount
						? candidates.length
						: Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
				if (count <= 0) continue;
				choices.push({ pl, candidates, count });
			}
			const atRandom = Boolean(step.params?.atRandom);
			if (!atRandom && this.canPause) {
				for (const { pl, candidates, count } of choices) {
					const actorKey = `actor:${this.stepIndex}:${pl.playerId}`;
					if (pl.isBot || candidates.length <= count || this.answers[actorKey] || this.answers[pl.playerId]) continue;
					const title = `${this.ctx.title} — Discard ${count} card(s)`;
					this.pauseForChoice(pl, title, `Choose ${count} card(s) to discard.`, candidates.map((c) => c.instanceId), count, count, 'hand', undefined, actorKey);
					return;
				}
			}
			const discarded: Array<{ pl: PlayerGameState; cards: CardInstance[] }> = [];
			for (const { pl, candidates, count } of choices) {
				let chosen: CardInstance[];
				if (atRandom) {
					const pool = [...candidates];
					chosen = [];
					for (let i = 0; i < count && pool.length > 0; i++) {
						const idx = Math.floor(nextRandom(s) * pool.length);
						chosen.push(pool.splice(idx, 1)[0]);
					}
				} else {
					const actorKey = `actor:${this.stepIndex}:${pl.playerId}`;
					chosen = this.answered(actorKey, candidates, count) ?? this.answered(pl, candidates, count) ?? candidates.slice(0, count);
				}
				discarded.push({ pl, cards: chosen });
			}
			const flatCards = discarded.flatMap((x) => x.cards);
			this.bind(step, flatCards);
			for (const { pl, cards } of discarded) {
				p.addLog(s, 'rule', `${pl.username} discarded ${cards.length} card(s)${atRandom ? ' at random' : ''}.`, pl.playerId);
			}
			this.answers[batchKey] = {
				kind: 'chooseObjects',
				objectIds: flatCards.map((c) => c.instanceId)
			};
		}

		this.runIndexedBatch(
			batchKey,
			() => [],
			(id) => {
				const f = this.locate(id);
				if (!f || f.zone !== 'hand') return;
				return discardCard(f.holder, f.inst);
			}
		);
	}

	revealAndDiscard(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const spec = step.params?.coerciveDiscard;
		if (!spec) return;
		const targetPlayer = this.players(step.subject)[0];
		if (!targetPlayer || targetPlayer.lost) return;
		const chooser = this.playerRef(spec.chooser) ?? this.you;
		if (!chooser || chooser.lost) return;

		const batchKey = `batch:${this.stepIndex}`;
		const choiceKey = `coercive:${this.stepIndex}`;
		const revealKey = `revealed:${this.stepIndex}`;

		if (!this.answers[batchKey]) {
			if (!this.answers[revealKey]) {
				const activeViewerIds = s.players.filter((pl) => !pl.lost).map((pl) => pl.playerId);
				for (const cardInst of targetPlayer.hand) {
					const known = new Set(cardInst.knownToPlayerIds ?? []);
					for (const vid of activeViewerIds) known.add(vid);
					cardInst.knownToPlayerIds = [...known];
				}
				const revealedNames =
					targetPlayer.hand.length > 0
						? targetPlayer.hand.map((c) => c.card.name).join(', ')
						: 'an empty hand';
				p.addLog(
					s,
					'rule',
					`${targetPlayer.username} revealed their hand (${revealedNames}).`,
					targetPlayer.playerId
				);
				this.answers[revealKey] = { kind: 'yesNo', yes: true };
			}

			const filterCtx = {
				state: s,
				controllerId: this.you.playerId,
				source: this.locate(this.ctx.sourceId)?.inst,
				xValue: this.ctx.xValue
			};
			const matching = spec.filter
				? targetPlayer.hand.filter((c) => matchesObjectFilter(c, spec.filter!, filterCtx))
				: [...targetPlayer.hand];

			if (matching.length === 0) {
				this.stepDecisions[this.stepIndex] = false;
				this.bind(step, []);
				this.answers[batchKey] = { kind: 'chooseObjects', objectIds: [] };
				return;
			}

			const minPick = spec.optionalChoice ? 0 : 1;
			const maxPick = 1;
			if (!chooser.isBot && this.canPause && !this.answers[choiceKey]) {
				const destVerb = spec.destination === 'exile' ? 'exile' : 'have them discard';
				const desc = spec.optionalChoice
					? `You may choose a card from ${targetPlayer.username}'s revealed hand to ${destVerb}.`
					: `Choose a card from ${targetPlayer.username}'s revealed hand to ${destVerb}.`;
				this.pauseForChoice(
					chooser,
					`${this.ctx.title} — Choose Card from ${targetPlayer.username}'s Hand`,
					desc,
					matching.map((c) => c.instanceId),
					minPick,
					maxPick,
					'hand',
					undefined,
					choiceKey
				);
				return;
			}

			let chosen: CardInstance[];
			if (this.answers[choiceKey]) {
				chosen = this.answered(choiceKey, matching, minPick, maxPick) ?? [];
			} else if (targetPlayer.playerId !== chooser.playerId) {
				const isLandCard = (c: CardInstance): boolean => {
					const card = c.copiableCard ?? c.card;
					const view = resolveObjectFaces(card, instanceFaceOptions(c, 'hand'));
					return view.types.includes('Land');
				};
				const sorted = [...matching].sort((a, b) => {
					const aLand = isLandCard(a);
					const bLand = isLandCard(b);
					if (aLand !== bLand) return aLand ? 1 : -1;
					return objectManaValue(s, b) - objectManaValue(s, a);
				});
				chosen = sorted.slice(0, 1);
			} else if (spec.optionalChoice) {
				chosen = [];
			} else {
				const sorted = [...matching].sort((a, b) => objectManaValue(s, a) - objectManaValue(s, b));
				chosen = sorted.slice(0, 1);
			}

			this.stepDecisions[this.stepIndex] = chosen.length > 0;
			this.bind(step, chosen);
			this.answers[batchKey] = {
				kind: 'chooseObjects',
				objectIds: chosen.map((c) => c.instanceId)
			};
		}

		const sourceVer =
			this.ctx.item.sourceObjectVersion ??
			this.locate(this.ctx.sourceId)?.inst.objectVersion ??
			1;

		this.runIndexedBatch(
			batchKey,
			() => [],
			(id) => {
				const f = this.locate(id);
				if (!f || f.zone !== 'hand') return;
				if (spec.destination === 'exile') {
					const res = moveObject(s, f.inst, 'exile', {
						from: { player: f.holder, zone: 'hand' },
						toPlayer: f.holder,
						graveyardReplacement: true,
						bumpVersion: true,
						newTimestamp: true
					});
					if (res === 'exile') {
						f.inst.exiledBy = {
							sourceInstanceId: this.ctx.sourceId,
							sourceObjectVersion: sourceVer
						};
					}
					p.addLog(
						s,
						'rule',
						`${chooser.username} chose ${f.inst.card.name} from ${f.holder.username}'s hand and exiled it.`,
						chooser.playerId
					);
					return res;
				}
				const res = moveObject(s, f.inst, 'graveyard', {
					from: { player: f.holder, zone: 'hand' },
					toPlayer: f.holder,
					graveyardReplacement: true,
					bumpVersion: true,
					newTimestamp: true,
					discardReason: 'discard',
					discardPlayerId: f.holder.playerId
				});
				p.addLog(
					s,
					'rule',
					`${chooser.username} chose ${f.inst.card.name}; ${f.holder.username} discarded it.`,
					f.holder.playerId
				);
				return res;
			}
		);
	}

	exile(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const sel = step.subject;
		const untilSourceLeaves = Boolean(step.params?.untilSourceLeaves);
		const srcFound = this.locate(this.ctx.sourceId);
		const sourceVer = this.ctx.item.sourceObjectVersion ?? srcFound?.inst.objectVersion ?? 1;
		// CR 610.3a–b: If the source permanent has already left the battlefield (or changed objects),
		// an "until ~ leaves the battlefield" one-shot effect never exiles the target/subject.
		if (
			untilSourceLeaves &&
			(!srcFound ||
				srcFound.zone !== 'battlefield' ||
				(srcFound.inst.objectVersion ?? 1) !== sourceVer)
		) {
			p.addLog(
				s,
				'rule',
				`${this.ctx.title} did not exile anything because ${this.ctx.sourceCard.name} is no longer on the battlefield (CR 610.3a).`,
				you.playerId
			);
			return;
		}
		const stampExiledMetadata = (inst: CardInstance, returnZone?: ZoneType): void => {
			if (!s.players.some((pl) => pl.exile.some((x) => x.instanceId === inst.instanceId))) return;
			inst.exiledBy = { sourceInstanceId: this.ctx.sourceId, sourceObjectVersion: sourceVer };
			if (untilSourceLeaves && returnZone && returnZone !== 'exile' && returnZone !== 'stack') {
				inst.untilSourceLeavesReturn = {
					sourceInstanceId: this.ctx.sourceId,
					sourceObjectVersion: sourceVer,
					returnZone
				};
			}
		};
		if (sel.k === 'libraryTop') {
			const targetPlayer = (sel.player ? this.playerRef(sel.player) : null) ?? you;
			const count = Math.max(0, this.amount(step.amount, 1));
			const moved: CardInstance[] = [];
			for (let i = 0; i < count && targetPlayer.library.length > 0; i++) {
				const top = targetPlayer.library[0];
				const res = moveObject(s, top, 'exile', {
					from: { player: targetPlayer, zone: 'library' },
					toPlayer: targetPlayer,
					bumpVersion: true,
					newTimestamp: true
				});
				if (res === 'exile') {
					stampExiledMetadata(top, 'library');
					moved.push(top);
				}
			}
			this.bind(step, moved);
			if (moved.length > 0) {
				const names = moved.map((c) => c.card.name).join(', ');
				p.addLog(
					s,
					'rule',
					`${this.ctx.title} exiled ${names} from the top of ${targetPlayer.username}'s library.`,
					you.playerId
				);
			} else {
				p.addLog(
					s,
					'rule',
					`${targetPlayer.username}'s library is empty; nothing was exiled.`,
					you.playerId
				);
			}
			return;
		}
		if (sel.k === 'self' && this.ctx.item.kind === 'spell') {
			// The spell itself, as it finishes resolving (CR 608.2n).
			this.result.exileSelf = true;
			return;
		}
		// --- Track P10 ---
		if (sel.k === 'all' && sel.filter.zone === 'hand' && step.amount !== undefined) {
			const batchKey = `batch:${this.stepIndex}`;
			if (!this.answers[batchKey]) {
				const actors = step.actor
					? this.players({ k: 'playerRef', ref: step.actor })
					: sel.filter.controller === 'opponent' || sel.filter.owner === 'opponent'
						? this.players({ k: 'player', filter: { relation: 'each_opponent' } })
						: [you];
				const itemFilter: ObjectFilter = {
					...sel.filter,
					controller: undefined,
					owner: undefined
				};
				const choices: Array<{ pl: PlayerGameState; candidates: CardInstance[]; count: number }> = [];
				for (const pl of actors) {
					const candidates = pl.hand.filter((c) => this.matches(c, itemFilter, 'hand'));
					if (candidates.length === 0) continue;
					const count = Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
					if (count <= 0) continue;
					choices.push({ pl, candidates, count });
				}
				if (this.canPause) {
					for (const { pl, candidates, count } of choices) {
						const actorKey = `exile_hand:${this.stepIndex}:${pl.playerId}`;
						const minPick = step.params?.upTo ? 0 : count;
						if (pl.isBot || (!step.params?.upTo && candidates.length <= count) || this.answers[actorKey]) {
							continue;
						}
						this.pauseForChoice(
							pl,
							`${this.ctx.title} — Exile ${minPick === count ? count : `up to ${count}`} card(s) from hand`,
							`Choose ${minPick === count ? count : `up to ${count}`} card(s) from your hand to exile.`,
							candidates.map((c) => c.instanceId),
							minPick,
							count,
							'hand',
							candidates.slice(0, count).map((c) => c.instanceId),
							actorKey
						);
						return;
					}
				}
				const pickedAll: CardInstance[] = [];
				for (const { pl, candidates, count } of choices) {
					const actorKey = `exile_hand:${this.stepIndex}:${pl.playerId}`;
					const minPick = step.params?.upTo ? 0 : count;
					const chosen =
						this.answered(actorKey, candidates, minPick, count) ?? candidates.slice(0, count);
					pickedAll.push(...chosen);
				}
				if (step.params?.upTo) {
					this.stepDecisions[this.stepIndex] = pickedAll.length > 0;
				}
				this.bind(step, pickedAll);
				this.answers[batchKey] = {
					kind: 'chooseObjects',
					objectIds: pickedAll.map((c) => c.instanceId)
				};
			}
			this.runIndexedBatch(
				batchKey,
				() => [],
				(id) => {
					const f = this.locate(id);
					if (!f || f.zone !== 'hand') return;
					const preSnap = this.captureTriggerEventLki(f.inst);
					const res = moveObject(s, f.inst, 'exile', {
						from: { player: f.holder, zone: 'hand' },
						toPlayer: f.holder,
						bumpVersion: true,
						newTimestamp: true
					});
					if (res === 'exile') {
						stampExiledMetadata(f.inst, 'hand');
						this.recordStepActedObject(f.inst, preSnap, false);
					}
					p.addLog(
						s,
						'cast',
						`${f.holder.username} exiled ${f.inst.card.name} from their hand (${this.ctx.title}).`,
						f.holder.playerId
					);
					return res;
				}
			);
			return;
		}
		// --- End Track P10 ---
		if (sel.k === 'all' && sel.filter.zone === 'graveyard') {
			// --- Track P10 ---
			const gyLeftByOwner = new Map<string, CardInstance[]>();
			const { total, paused } = this.runIndexedBatch(
				`batch:${this.stepIndex}`,
				() => {
					const matching = this.objects(sel);
					this.bind(step, matching);
					const matchingIds = new Set(matching.map((c) => c.instanceId));
					return s.players.flatMap((pl) =>
						[...pl.graveyard]
							.reverse()
							.filter((c) => matchingIds.has(c.instanceId))
							.map((c) => c.instanceId)
					);
				},
				(id) => {
					const f = this.locate(id);
					if (!f || f.zone !== 'graveyard') return;
					const preSnap = this.captureTriggerEventLki(f.inst);
					const ownerId = f.holder.playerId;
					const res = moveObject(s, f.inst, 'exile', {
						from: { player: f.holder, zone: 'graveyard' },
						toPlayer: f.holder,
						bumpVersion: true,
						suppressGraveyardLeaveBatch: true
					});
					if (res === 'exile') {
						stampExiledMetadata(f.inst, 'graveyard');
						this.recordStepActedObject(f.inst, preSnap, false);
					}
					if (f.inst.zone !== 'graveyard') {
						let arr = gyLeftByOwner.get(ownerId);
						if (!arr) {
							arr = [];
							gyLeftByOwner.set(ownerId, arr);
						}
						arr.push(f.inst);
					}
					return res;
				}
			);
			for (const [ownerId, objects] of gyLeftByOwner) {
				if (objects.length > 0) {
					emitEvent(s, { kind: 'GraveyardLeaveBatch', ownerId, objects });
				}
			}
			if (gyLeftByOwner.size > 0) flushTriggers(s);
			// --- End Track P10 ---
			if (!paused) {
				p.addLog(s, 'trigger', `${this.ctx.title} exiled all ${total} card(s) from all graveyards!`, you.playerId);
			}
			return;
		}
		// --- Track P10 ---
		const gyLeftGeneral = new Map<string, CardInstance[]>();
		// --- End Track P10 ---
		this.runIndexedBatch(
			`batch:${this.stepIndex}`,
			() => {
				const objs = this.objects(sel);
				this.bind(step, objs);
				return objs.map((o) => o.instanceId);
			},
			(id) => {
				const f = this.locate(id);
				if (!f) return;
				const o = f.inst;
				const prevZone = f.zone;
				// --- Track P10 ---
				const preSnap = this.captureTriggerEventLki(o);
				const holderOwnerId = f.holder.playerId;
				// --- End Track P10 ---
				const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
				let res: MoveResult | string | void;
				if (o.zone === 'battlefield') {
					p.emitVfx(s, { kind: 'exile', targetId: o.instanceId, label: objLabel });
					res = p.moveFromBattlefield(s, o, 'exile');
				} else if (o.zone === 'graveyard') {
					res = moveObject(s, o, 'exile', {
						from: { player: f.holder, zone: 'graveyard' },
						toPlayer: f.holder,
						bumpVersion: true,
						newTimestamp: true,
						suppressGraveyardLeaveBatch: true
					});
					if (o.zone !== 'graveyard') {
						let arr = gyLeftGeneral.get(holderOwnerId);
						if (!arr) {
							arr = [];
							gyLeftGeneral.set(holderOwnerId, arr);
						}
						arr.push(o);
					}
				} else {
					return;
				}
				if (res === 'exile') {
					stampExiledMetadata(o, prevZone);
					this.recordStepActedObject(o, preSnap, false);
				}
				p.addLog(s, 'cast', `${this.ctx.title} exiled ${objLabel}.`, you.playerId);
				return res;
			}
		);
		// --- Track P10 ---
		for (const [ownerId, objects] of gyLeftGeneral) {
			if (objects.length > 0) {
				emitEvent(s, { kind: 'GraveyardLeaveBatch', ownerId, objects });
			}
		}
		if (gyLeftGeneral.size > 0) flushTriggers(s);
		// --- End Track P10 ---
	}

	private resolveLibraryPlacementChoice(
		chooser: PlayerGameState,
		owner: PlayerGameState,
		card: CardInstance,
		rawPos: 'top' | 'bottom' | 'topOrBottom' | 'secondOrBottom',
		rawFromTop: number | undefined,
		answerKey: string,
		cardLabel: string
	): { position: 'top' | 'bottom'; fromTop?: number } | null {
		if (rawPos === 'topOrBottom' || rawPos === 'secondOrBottom') {
			const modes =
				rawPos === 'secondOrBottom'
					? ['Put second from top of library', 'Put on bottom of library']
					: ['Put on top of library', 'Put on bottom of library'];
			let choiceIdx: 0 | 1;
			const ans = this.answers[answerKey];
			if (ans?.kind === 'chooseMode') {
				choiceIdx = (ans.indices[0] ?? 0) === 1 ? 1 : 0;
			} else if (!chooser.isBot && this.canPause) {
				const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
				enqueueChoicePrompt(this.state, {
					id: P().uid('prompt', this.state),
					kind: 'chooseMode',
					playerId: chooser.playerId,
					title: `${this.ctx.title} — Choose Library Placement (${cardLabel})`,
					description: `Choose where to put ${cardLabel} in ${owner.username}'s library.`,
					continuation: {
						kind: 'effect_choice',
						stackItemId: item.id,
						stepIndex: this.stepIndex,
						answerKey
					},
					choice: {
						kind: 'chooseMode',
						modes,
						min: 1,
						max: 1,
						defaultIndices: [0]
					}
				});
				this.result.paused = true;
				return null;
			} else {
				choiceIdx = chooseBotLibraryPlacement(chooser, owner, card);
			}
			if (rawPos === 'secondOrBottom') {
				return choiceIdx === 0 ? { position: 'top', fromTop: 2 } : { position: 'bottom' };
			}
			return { position: choiceIdx === 0 ? 'top' : 'bottom' };
		}
		return {
			position: rawPos === 'bottom' ? 'bottom' : 'top',
			...(rawFromTop !== undefined ? { fromTop: rawFromTop } : {})
		};
	}

	move(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const params = step.params ?? {};
		const batchKey = `batch:${this.stepIndex}`;
		const rawPos = params.position ?? 'top';
		const rawFromTop = params.fromTop;
		const choiceBy = params.libraryChoiceBy ?? 'controller';

		if (params.to === 'library' && step.subject.k === 'self' && this.ctx.item.kind === 'spell') {
			const owner = this.player(this.ctx.item.ownerId ?? you.playerId) ?? you;
			const chooser = choiceBy === 'owner' ? owner : you;
			const synth = this.syntheticLkiObject(this.ctx.sourceId, you.playerId);
			synth.card = this.ctx.item.card;
			synth.ownerId = owner.playerId;
			const resolved = this.resolveLibraryPlacementChoice(
				chooser,
				owner,
				synth,
				rawPos,
				rawFromTop,
				`libpos:self:${this.stepIndex}`,
				this.ctx.item.card.name
			);
			if (!resolved) return;
			this.result.librarySelf = resolved;
			return;
		}

		if (params.from === 'hand') {
			if (params.to === 'library') {
				if (!this.answers[batchKey]) {
					const chosen = this.resolveHandMoveChosen(step);
					if (!chosen) return;
					if (chosen.length === 0) {
						this.answers[batchKey] = { kind: 'chooseObjects', objectIds: [] };
					} else {
						const resolvedFirst = this.resolveLibraryPlacementChoice(
							choiceBy === 'owner' ? you : you,
							you,
							chosen[0],
							rawPos,
							rawFromTop,
							`libpos:hand:${this.stepIndex}`,
							chosen.length === 1 ? chosen[0].card.name : `${chosen.length} card(s)`
						);
						if (!resolvedFirst) return;
						this.answers[`libeff:hand:${this.stepIndex}`] = {
							kind: 'chooseObjects',
							objectIds: [
								resolvedFirst.position,
								resolvedFirst.fromTop !== undefined ? String(resolvedFirst.fromTop) : ''
							]
						};
						this.bind(step, chosen);
						let ordered = chosen;
						if (chosen.length > 1 && resolvedFirst.fromTop === undefined && you.isBot) {
							ordered = orderBotSimultaneousLibraryCards(you, chosen, resolvedFirst.position);
						}
						const seq =
							resolvedFirst.position === 'top' && resolvedFirst.fromTop === undefined
								? [...ordered].reverse()
								: ordered;
						const placeDesc =
							resolvedFirst.fromTop !== undefined
								? `${resolvedFirst.fromTop} from top`
								: resolvedFirst.position === 'bottom'
									? 'the bottom'
									: 'top';
						p.addLog(
							s,
							'rule',
							`${you.username} put ${chosen.length} card(s) from hand on ${placeDesc} of their library (${this.ctx.title}).`,
							you.playerId
						);
						this.answers[batchKey] = { kind: 'chooseObjects', objectIds: seq.map((c) => c.instanceId) };
					}
				}
				const effAns = this.answers[`libeff:hand:${this.stepIndex}`];
				const effPos: 'top' | 'bottom' =
					effAns?.kind === 'chooseObjects' && effAns.objectIds[0] === 'bottom'
						? 'bottom'
						: rawPos === 'bottom'
							? 'bottom'
							: 'top';
				const effFromTop =
					effAns?.kind === 'chooseObjects' && effAns.objectIds[1]
						? Number(effAns.objectIds[1])
						: rawFromTop;
				this.runIndexedBatch(
					batchKey,
					() => [],
					(id) => {
						const f = this.locate(id);
						if (!f || f.zone !== 'hand') return;
						return moveObject(s, f.inst, 'library', {
							from: { player: f.holder, zone: 'hand' },
							toPlayer: f.holder,
							insert: (dest) =>
								dest === 'library'
									? computeLibraryInsertIndex(effFromTop, effPos, f.holder.library.length)
									: 'end',
							commanderRedirect: true,
							bumpVersion: true,
							newTimestamp: true
						});
					}
				);
				return;
			}
			if (!this.answers[batchKey]) {
				const chosen = this.resolveHandMoveChosen(step);
				if (!chosen) return;
				// --- Track P10 ---
				if (params.upTo) {
					this.stepDecisions[this.stepIndex] = chosen.length > 0;
				}
				// --- End Track P10 ---
				this.bind(step, chosen);
				if (this.canPause && !you.isBot) {
					for (const o of chosen) {
						if (!(o.copiableCard ?? o.card).typeLine.includes('Aura')) continue;
						const attachCands = p.legalAuraAttachCandidates(s, o, you);
						const auraKey = `aura:${o.instanceId}`;
						if (attachCands.length > 0 && !this.answers[auraKey]) {
							this.pauseForChoice(
								you,
								`${this.ctx.title} — Choose what Aura will enchant`,
								`Choose a legal object or player for ${o.card.name} to enchant as it enters the battlefield (CR 303.4f).`,
								attachCands,
								1,
								1,
								'battlefield',
								[attachCands[0]],
								auraKey
							);
							return;
						}
					}
				}
				this.answers[batchKey] = { kind: 'chooseObjects', objectIds: chosen.map((c) => c.instanceId) };
			}
			this.runIndexedBatch(
				batchKey,
				() => [],
				(id) => {
					const f = this.locate(id);
					if (!f || f.zone !== 'hand') return;
					const o = f.inst;
					// --- Track P10 ---
					const preSnap = this.captureTriggerEventLki(o);
					// --- End Track P10 ---
					const isAura = (o.copiableCard ?? o.card).typeLine.includes('Aura');
					if (isAura) {
						const attachCands = p.legalAuraAttachCandidates(s, o, you);
						if (attachCands.length === 0) {
							p.addLog(
								s,
								'rule',
								`${o.card.name} remained in ${you.username}'s hand because there is no legal object or player for it to enchant (CR 303.4g).`,
								you.playerId
							);
							return;
						}
						const auraAns = this.answers[`aura:${o.instanceId}`];
						const pickedId = auraAns?.kind === 'chooseObjects' ? auraAns.objectIds[0] : undefined;
						attachObject(s, o, pickedId && attachCands.includes(pickedId) ? pickedId : attachCands[0]);
					}
					o.summoningSick = true;
					o.tapped = Boolean(params.tapped);
					o.defaultControllerId = you.playerId;
					const res = moveObject(s, o, 'battlefield', {
						from: { player: you, zone: 'hand' },
						toPlayer: you,
						controllerId: you.playerId,
						newTimestamp: !isAura,
						bumpVersion: true
					});
					p.addLog(s, 'cast', `${you.username} put ${o.card.name} from their hand onto the battlefield (${this.ctx.title}).`, you.playerId);
					if (o.zone === 'battlefield') {
						// --- Track P10 ---
						this.recordStepActedObject(o, preSnap, false);
						// --- End Track P10 ---
						if (isAura && o.attachedToId) {
							const host = p.findPermanent(s, o.attachedToId);
							if (host) p.triggerOnAttach(s, you, o, host.inst);
						}
						p.triggerOnEtb(s, you, o);
					}
					return res;
				}
			);
			return;
		}

		if (params.to === 'library') {
			if (params.mayShuffle) {
				const objs = this.objects(step.subject);
				this.bind(step, objs);
				if (!step.bindAs && objs.length > 0) {
					this.bindings.set(
						`__lki_${this.stepIndex}`,
						objs.map((o) => ({ id: o.instanceId, lki: this.snapshot(o) }))
					);
				}
				const shuffledOwners = new Set<string>();
				for (const o of objs) {
					const f = this.locate(o.instanceId);
					if (!f) continue;
					const owner = this.player(o.ownerId) ?? f.holder;
					const top = params.position !== 'bottom';
					moveObject(s, o, 'library', {
						from: { player: f.holder, zone: f.zone },
						toPlayer: owner,
						insert: top ? 'start' : 'end',
						commanderRedirect: true,
						leaveBattlefieldReset: f.zone === 'battlefield',
						detachAttachments: f.zone === 'battlefield',
						bumpVersion: true,
						newTimestamp: true,
						ceaseToExist: 'tokens'
					});
					if (!shuffledOwners.has(owner.playerId)) {
						shuffledOwners.add(owner.playerId);
						shuffleLibrary(s, owner);
						p.addLog(s, 'rule', `${owner.username} shuffled their library (${this.ctx.title}).`, owner.playerId);
					}
				}
				return;
			}
			const trigAbLib =
				this.ctx.item.kind === 'triggered' && this.ctx.item.triggeredAbilityIndex !== undefined
					? activeAbilityDefs(this.ctx.sourceCard, { faceIndex: this.ctx.item.faceIndex ?? 0 })[
							this.ctx.item.triggeredAbilityIndex
						]
					: undefined;
			const allowPostSbaAuraVersionLib =
				trigAbLib?.kind === 'triggered' && trigAbLib.trigger.filter.object === 'attachedTo';
			const checkSelfGyVersionLib =
				this.stepIndex === 0 &&
				step.subject.k === 'self' &&
				this.ctx.item.sourceObjectVersion !== undefined;
			const matchesSelfVersionLib = (inst: CardInstance): boolean => {
				if (!checkSelfGyVersionLib || inst.zone !== 'graveyard') return true;
				const sv = this.ctx.item.sourceObjectVersion!;
				const cur = inst.objectVersion ?? 1;
				return cur === sv || (allowPostSbaAuraVersionLib && cur === sv + 1);
			};

			// 1. Check stack spell targets (e.g. Commit, Memory Lapse, Aether Gust targeting a spell)
			const stackTargets: StackItem[] = [];
			if (step.subject.k === 'target') {
				for (const t of this.targetsForSpecIndex(step.subject.index)) {
					if (t.kind === 'stack') {
						const foundStk = s.stack.find((x) => x.id === t.id || x.sourceInstanceId === t.id);
						if (foundStk && foundStk.id !== this.ctx.item.id && foundStk.kind === 'spell') {
							stackTargets.push(foundStk);
						}
					}
				}
			} else if (step.subject.k === 'eventObject' && this.ctx.eventObjectId) {
				const foundStk = s.stack.find(
					(x) =>
						x.id !== this.ctx.item.id &&
						x.kind === 'spell' &&
						(x.id === this.ctx.eventObjectId || x.sourceInstanceId === this.ctx.eventObjectId)
				);
				if (foundStk) stackTargets.push(foundStk);
			}
			if (stackTargets.length > 0 && !this.answers[batchKey]) {
				const stkPlacements = new Map<string, { position: 'top' | 'bottom'; fromTop?: number }>();
				for (const stk of stackTargets) {
					const owner = this.player(stk.ownerId ?? stk.controllerId) ?? you;
					const chooser = choiceBy === 'owner' ? owner : you;
					const synth = this.syntheticLkiObject(stk.sourceInstanceId, stk.controllerId);
					synth.card = stk.card;
					synth.ownerId = owner.playerId;
					const resolved = this.resolveLibraryPlacementChoice(
						chooser,
						owner,
						synth,
						rawPos,
						rawFromTop,
						`libpos:stk:${stk.id}`,
						stk.title
					);
					if (!resolved) return;
					stkPlacements.set(stk.id, resolved);
				}
				const boundStk: Bound[] = [];
				for (const stk of stackTargets) {
					const owner = this.player(stk.ownerId ?? stk.controllerId) ?? you;
					const resolved = stkPlacements.get(stk.id)!;
					boundStk.push({
						id: stk.sourceInstanceId,
						lki: {
							controllerId: stk.controllerId,
							ownerId: owner.playerId,
							power: 0,
							toughness: 0,
							manaValue: objectManaValue(s, stk)
						}
					});
					p.moveStackSpellToLibrary(s, stk, resolved);
					const placeDesc =
						resolved.fromTop !== undefined
							? `${resolved.fromTop} from top of`
							: resolved.position === 'bottom'
								? 'on the bottom of'
								: 'on top of';
					p.addLog(
						s,
						'cast',
						`${this.ctx.title} put ${stk.title} ${placeDesc} ${owner.username}'s library.`,
						you.playerId
					);
				}
				if (step.bindAs) this.bindings.set(step.bindAs, boundStk);
			}

			// 2. Non-stack objects moving from battlefield, graveyard, or exile into owner's library
			const allowedLibZones: ReadonlyArray<'battlefield' | 'graveyard' | 'exile'> =
				params.from === 'battlefield'
					? ['battlefield']
					: params.from === 'graveyard'
						? ['graveyard']
						: params.from === 'exile'
							? ['exile']
							: ['battlefield', 'graveyard', 'exile'];
			if (!this.answers[batchKey]) {
				let objs = this.objects(step.subject).filter(
					(o) =>
						allowedLibZones.includes(o.zone as 'battlefield' | 'graveyard' | 'exile') &&
						matchesSelfVersionLib(o)
				);
				if (params.topmostOnly && params.from === 'graveyard') {
					objs = objs.length > 0 ? [objs[objs.length - 1]] : [];
				}
				if (objs.length === 0) return;

				const perObjResolved = new Map<string, { position: 'top' | 'bottom'; fromTop?: number }>();
				for (const o of objs) {
					const owner = this.player(o.ownerId) ?? you;
					const chooser = choiceBy === 'owner' ? owner : you;
					const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
					const resolved = this.resolveLibraryPlacementChoice(
						chooser,
						owner,
						o,
						rawPos,
						rawFromTop,
						`libpos:${o.instanceId}`,
						objLabel
					);
					if (!resolved) return;
					perObjResolved.set(o.instanceId, resolved);
					this.answers[`libeff:${o.instanceId}`] = {
						kind: 'chooseObjects',
						objectIds: [
							resolved.position,
							resolved.fromTop !== undefined ? String(resolved.fromTop) : ''
						]
					};
				}

				// CR 401.4: When multiple cards are put on top or bottom of a single library simultaneously,
				// that library's owner puts them there in any order.
				const groups = new Map<string, CardInstance[]>();
				for (const o of objs) {
					const r = perObjResolved.get(o.instanceId)!;
					const gKey =
						r.fromTop !== undefined
							? `nth:${o.instanceId}`
							: `${o.ownerId}:${r.position}`;
					let arr = groups.get(gKey);
					if (!arr) {
						arr = [];
						groups.set(gKey, arr);
					}
					arr.push(o);
				}

				const finalSeqIds: string[] = [];
				for (const [gKey, group] of groups.entries()) {
					if (group.length <= 1 || gKey.startsWith('nth:')) {
						for (const o of group) finalSeqIds.push(o.instanceId);
						continue;
					}
					const owner = this.player(group[0].ownerId) ?? you;
					const gPos = perObjResolved.get(group[0].instanceId)!.position;
					const orderKey = `liborder:${this.stepIndex}:${gKey}`;
					let orderedGroup: CardInstance[];
					const ordAns = this.answers[orderKey];
					// --- Track P13 ---
					if (step.params?.randomOrder) {
						orderedGroup = [...group];
						for (let i = orderedGroup.length - 1; i > 0; i--) {
							const j = Math.floor(nextRandom(s) * (i + 1));
							const tmp = orderedGroup[i];
							orderedGroup[i] = orderedGroup[j];
							orderedGroup[j] = tmp;
						}
					} else if (ordAns?.kind === 'orderObjects') {
					// --- End Track P13 ---
						const byId = new Map(group.map((c) => [c.instanceId, c]));
						orderedGroup = [];
						for (const oid of ordAns.topIds) {
							const foundCard = byId.get(oid);
							if (foundCard) {
								orderedGroup.push(foundCard);
								byId.delete(oid);
							}
						}
						for (const rem of byId.values()) orderedGroup.push(rem);
					} else if (!owner.isBot && this.canPause) {
						this.pauseForOrder(
							owner,
							`${this.ctx.title} — Order Cards (${gPos === 'top' ? 'Top' : 'Bottom'} of Library)`,
							`Choose the order to put ${group.length} cards on the ${gPos} of your library (first = ${gPos === 'top' ? 'topmost card' : 'above the rest'}).`,
							group.map((c) => c.instanceId),
							orderKey
						);
						return;
					} else {
						orderedGroup = orderBotSimultaneousLibraryCards(owner, group, gPos);
					}
					const insertSeq = gPos === 'top' ? [...orderedGroup].reverse() : orderedGroup;
					for (const o of insertSeq) finalSeqIds.push(o.instanceId);
				}

				this.bind(step, objs);
				this.answers[batchKey] = { kind: 'chooseObjects', objectIds: finalSeqIds };
			}

			this.runIndexedBatch(
				batchKey,
				() => [],
				(id) => {
					const f = this.locate(id);
					if (
						!f ||
						!allowedLibZones.includes(f.zone as 'battlefield' | 'graveyard' | 'exile') ||
						!matchesSelfVersionLib(f.inst)
					) {
						return;
					}
					const o = f.inst;
					const owner = this.player(o.ownerId) ?? f.holder;
					const effAns = this.answers[`libeff:${o.instanceId}`];
					const effPos: 'top' | 'bottom' =
						effAns?.kind === 'chooseObjects' && effAns.objectIds[0] === 'bottom'
							? 'bottom'
							: 'top';
					const effFromTop =
						effAns?.kind === 'chooseObjects' && effAns.objectIds[1]
							? Number(effAns.objectIds[1])
							: undefined;
					const objLabel = o.isFaceDown ? (o.faceDownLabel || 'Face-Down Permanent') : o.card.name;
					const placeDesc =
						effFromTop !== undefined
							? `${effFromTop} from top of`
							: effPos === 'bottom'
								? 'on the bottom of'
								: 'on top of';
					if (f.zone === 'battlefield') {
						const res = p.moveFromBattlefield(s, o, 'library', {
							position: effPos,
							...(effFromTop !== undefined ? { fromTop: effFromTop } : {})
						});
						p.addLog(
							s,
							'cast',
							`${this.ctx.title} put ${objLabel} ${placeDesc} ${owner.username}'s library.`,
							you.playerId
						);
						return res as MoveResult;
					}
					const actualFrom = f.zone as 'graveyard' | 'exile';
					const res = moveObject(s, o, 'library', {
						from: { player: f.holder, zone: actualFrom },
						toPlayer: owner,
						commanderRedirect: true,
						bumpVersion: true,
						newTimestamp: true,
						insert: (dest) =>
							dest === 'library'
								? computeLibraryInsertIndex(effFromTop, effPos, owner.library.length)
								: 'end'
					});
					p.addLog(
						s,
						'cast',
						`${this.ctx.title} put ${objLabel} from ${f.holder.username}'s ${actualFrom} ${placeDesc} ${owner.username}'s library.`,
						you.playerId
					);
					return res;
				}
			);
			return;
		}
		const allowedFromZones: ReadonlyArray<'exile' | 'graveyard' | 'library'> =
			params.from === 'library'
				? ['library']
				: params.from === 'exile'
					? ['exile']
					: params.from === 'graveyard'
						? ['graveyard']
						: step.subject.k === 'eventObject' ||
							  step.subject.k === 'binding' ||
							  step.subject.k === 'libraryTop'
							? ['graveyard', 'exile', 'library']
							: ['graveyard'];
		const canEnterTransformed = (inst: CardInstance): boolean => {
			if (!params.enteredTransformed) return true;
			const baseCard = inst.copiableCard ?? inst.card;
			const faces = getCardFaces(baseCard);
			const isTransformingDfc = baseCard.layout === 'transform' || Boolean(baseCard.backFace);
			const backTypes = faces[1]?.typeLine ?? '';
			return isTransformingDfc && faces.length >= 2 && !/\b(?:Instant|Sorcery)\b/.test(backTypes);
		};
		const trigAb =
			this.ctx.item.kind === 'triggered' && this.ctx.item.triggeredAbilityIndex !== undefined
				? activeAbilityDefs(this.ctx.sourceCard, { faceIndex: this.ctx.item.faceIndex ?? 0 })[
						this.ctx.item.triggeredAbilityIndex
					]
				: undefined;
		const allowPostSbaAuraVersion =
			trigAb?.kind === 'triggered' && trigAb.trigger.filter.object === 'attachedTo';
		const checkSelfGyVersion =
			this.stepIndex === 0 &&
			allowedFromZones.includes('graveyard') &&
			step.subject.k === 'self' &&
			this.ctx.item.sourceObjectVersion !== undefined;
		const matchesSelfVersion = (inst: CardInstance): boolean => {
			if (!checkSelfGyVersion || inst.zone !== 'graveyard') return true;
			const sv = this.ctx.item.sourceObjectVersion!;
			const cur = inst.objectVersion ?? 1;
			// CR 400.7f: an Aura put into a graveyard via SBA CR 704.5m after its enchanted permanent died
			// incremented objectVersion once since the trigger fired on the battlefield.
			return cur === sv || (allowPostSbaAuraVersion && cur === sv + 1);
		};
		if (!this.answers[batchKey]) {
			let objs = this.objects(step.subject).filter(
				(o) =>
					allowedFromZones.includes(o.zone as 'exile' | 'graveyard' | 'library') &&
					matchesSelfVersion(o)
			);
			if (params.topmostOnly) {
				// CR 404.2: the graveyard's order matters; the top card is the last one in the array.
				objs = objs.length > 0 ? [objs[objs.length - 1]] : [];
			}
			if (params.to !== 'hand' && this.canPause) {
				for (const o of objs) {
					if (!canEnterTransformed(o)) continue;
					const holder = this.locate(o.instanceId)?.holder;
					if (!holder) continue;
					const actorPlayer = step.actor ? this.playerRef(step.actor) : null;
					const controller = params.underYourControl ? you : (actorPlayer ?? this.player(o.ownerId) ?? holder);
					const view = resolveObjectFaces(o.copiableCard ?? o.card, {
						zone: 'battlefield',
						faceIndex: params.enteredTransformed ? 1 : o.activeFaceIndex
					});
					if (!view.subtypes.includes('Aura') && !view.typeLine.includes('Aura')) continue;
					const attachCands = p.legalAuraAttachCandidates(s, o, controller);
					const auraKey = `aura:${o.instanceId}`;
					if (attachCands.length > 0 && !controller.isBot && !this.answers[auraKey]) {
						this.pauseForChoice(
							controller,
							`${this.ctx.title} — Choose what ${view.name} will enchant`,
							`Choose a legal object or player for ${view.name} to enchant as it enters the battlefield (CR 303.4f).`,
							attachCands,
							1,
							1,
							'battlefield',
							[attachCands[0]],
							auraKey
						);
						return;
					}
				}
			}
			this.bind(step, objs);
			this.answers[batchKey] = { kind: 'chooseObjects', objectIds: objs.map((o) => o.instanceId) };
		}
		// --- Track P10 ---
		const gyLeftMove = new Map<string, CardInstance[]>();
		// --- End Track P10 ---
		this.runIndexedBatch(
			batchKey,
			() => [],
			(id) => {
				const f = this.locate(id);
				if (
					!f ||
					!allowedFromZones.includes(f.zone as 'exile' | 'graveyard' | 'library') ||
					!matchesSelfVersion(f.inst)
				) {
					return;
				}
				const actualFrom = f.zone as 'exile' | 'graveyard' | 'library';
				const o = f.inst;
				// --- Track P10 ---
				const preSnap = this.captureTriggerEventLki(o);
				const holderOwnerId = f.holder.playerId;
				// --- End Track P10 ---
				// --- Track P9: CR 111.8 tokens that left the battlefield cannot move to another zone ---
				if (o.isToken) return;
				const holder = f.holder;
				if (params.to === 'hand') {
					const res = moveObject(s, o, 'hand', {
						from: { player: holder, zone: actualFrom },
						toPlayer: holder,
						commanderRedirect: true,
						bumpVersion: true,
						newTimestamp: true,
						// --- Track P10 ---
						...(actualFrom === 'graveyard' ? { suppressGraveyardLeaveBatch: true } : {})
						// --- End Track P10 ---
					});
					// --- Track P10 ---
					if (actualFrom === 'graveyard' && o.zone !== 'graveyard') {
						let arr = gyLeftMove.get(holderOwnerId);
						if (!arr) {
							arr = [];
							gyLeftMove.set(holderOwnerId, arr);
						}
						arr.push(o);
					}
					if (o.zone === 'hand') {
						this.recordStepActedObject(o, preSnap, false);
					}
					// --- End Track P10 ---
					p.addLog(s, 'cast', `${this.ctx.title} returned ${o.card.name} from ${holder.username}'s ${actualFrom} to hand.`, you.playerId);
					return res;
				}
				if (!canEnterTransformed(o)) {
					p.addLog(
						s,
						'rule',
						`${o.card.name} remained in ${holder.username}'s ${actualFrom} because it can't enter transformed (CR 712.11).`,
						you.playerId
					);
					return;
				}
				const actorPlayer = step.actor ? this.playerRef(step.actor) : null;
				const controller = params.underYourControl ? you : (actorPlayer ?? this.player(o.ownerId) ?? holder);
				if (params.enteredTransformed) {
					o.transformed = true;
					o.activeFaceIndex = 1;
				}
				o.isFaceDown = false;
				o.faceDownSpec = undefined;
				o.faceDownLabel = undefined;
				const enteringView = resolveObjectFaces(o.copiableCard ?? o.card, {
					zone: 'battlefield',
					faceIndex: o.transformed ? 1 : o.activeFaceIndex
				});
				const isAura = enteringView.subtypes.includes('Aura') || enteringView.typeLine.includes('Aura');
				if (isAura) {
					const attachCands = p.legalAuraAttachCandidates(s, o, controller);
					if (attachCands.length === 0) {
						p.addLog(
							s,
							'rule',
							`${enteringView.name} remained in ${holder.username}'s ${actualFrom} because there is no legal object or player for it to enchant (CR 303.4g).`,
							controller.playerId
						);
						return;
					}
					const auraAns = this.answers[`aura:${o.instanceId}`];
					const pickedId = auraAns?.kind === 'chooseObjects' ? auraAns.objectIds[0] : undefined;
					attachObject(s, o, pickedId && attachCands.includes(pickedId) ? pickedId : attachCands[0]);
				}
				o.summoningSick = params.unearth ? false : !enteringView.keywords.includes('Haste');
				o.tapped = Boolean(params.tapped);
				o.defaultControllerId = controller.playerId;
				const res = moveObject(s, o, 'battlefield', {
					from: { player: holder, zone: actualFrom },
					toPlayer: controller,
					controllerId: controller.playerId,
					newTimestamp: !isAura,
					bumpVersion: true,
					beforeInsert: (returned, d) => {
						if (d === 'battlefield') {
							applySelfEtbReplacements(s, returned);
						}
					},
					// --- Track P9 ---
					...(params.withCounters ? { withCounters: params.withCounters } : {}),
					// --- Track P10 ---
					...(actualFrom === 'graveyard' ? { suppressGraveyardLeaveBatch: true } : {})
					// --- End Track P10 ---
				});
				// --- Track P10 ---
				if (actualFrom === 'graveyard' && o.zone !== 'graveyard') {
					let arr = gyLeftMove.get(holderOwnerId);
					if (!arr) {
						arr = [];
						gyLeftMove.set(holderOwnerId, arr);
					}
					arr.push(o);
				}
				if (o.zone === 'battlefield') {
					this.recordStepActedObject(o, preSnap, false);
				}
				// --- End Track P10 ---
				if (params.unearth && o.zone === 'battlefield') {
					// CR 702.84a: permanent Haste, leave-battlefield exile replacement, and next-end-step exile delayed trigger.
					o.unearthLeaveExile = true;
					const ts = allocateTimestamp(s);
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: controller.playerId,
						affected: [{ instanceId: o.instanceId, objectVersion: o.objectVersion ?? 1 }],
						expires: 'never',
						layer6: { addKeywords: ['haste'] }
					});
					noteLayerInputsChanged(s);
					(s.delayedTriggers ??= []).push({
						id: p.uid('dtrig', s),
						controllerId: controller.playerId,
						sourceInstanceId: o.instanceId,
						sourceCard: this.ctx.sourceCard,
						triggerPhase: 'end_step',
						createdAtTurn: s.turnNumber,
						targetInstanceId: o.instanceId,
						targetObjectVersion: o.objectVersion,
						title: `${this.ctx.title} — Unearth Delayed Exile Trigger`,
						description: `At the beginning of the next end step, exile ${enteringView.name}.`,
						delayedEffect: {
							kind: 'exile',
							targetInstanceId: o.instanceId,
							targetObjectVersion: o.objectVersion
						}
					});
				}
				p.addLog(
					s,
					'cast',
					`${controller.username} put ${enteringView.name} onto the battlefield${params.enteredTransformed ? ' transformed' : ''} from ${holder.username}'s ${actualFrom} (${this.ctx.title}).`,
					you.playerId
				);
				if (o.zone === 'battlefield') {
					if (isAura && o.attachedToId) {
						const host = p.findPermanent(s, o.attachedToId);
						if (host) p.triggerOnAttach(s, controller, o, host.inst);
					}
					p.triggerOnEtb(s, controller, o);
				}
				return res;
			}
		);
		// --- Track P10 ---
		for (const [ownerId, objects] of gyLeftMove) {
			if (objects.length > 0) {
				emitEvent(s, { kind: 'GraveyardLeaveBatch', ownerId, objects });
			}
		}
		if (gyLeftMove.size > 0) flushTriggers(s);
		// --- End Track P10 ---
	}

	private resolveHandMoveChosen(step: EffectStep): CardInstance[] | null {
		const you = this.you;
		const params = step.params ?? {};
		const filter: ObjectFilter = step.subject.k === 'all' ? step.subject.filter : {};
		const candidates = you.hand.filter((c) => this.matches(c, filter, 'hand'));
		const max = Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
		const min = params.upTo ? 0 : max;
		// --- Track P10 ---
		if (max <= 0) {
			if (params.upTo) {
				this.stepDecisions[this.stepIndex] = false;
			}
			return null;
		}
		// --- End Track P10 ---
		if (
			!you.isBot &&
			this.canPause &&
			!this.answers[you.playerId] &&
			(min < max || candidates.length > max || (params.to === 'library' && max > 1))
		) {
			const title = `${this.ctx.title} — Choose card(s) from hand`;
			this.pauseForChoice(
				you,
				title,
				`Choose ${min === max ? max : `up to ${max}`} card(s) from your hand.`,
				candidates.map((c) => c.instanceId),
				min,
				max,
				'hand'
			);
			return null;
		}
		if (this.answers[you.playerId]) {
			return this.answered(you, candidates, min, max) ?? [];
		}
		if (params.to === 'battlefield') {
			return [...candidates].sort((a, b) => b.card.cmc - a.card.cmc).slice(0, max);
		}
		return candidates.slice(0, max);
	}

	private moveDigCardToBattlefield(o: CardInstance, pl: PlayerGameState, tapped: boolean): MoveResult | void {
		const s = this.state;
		const p = P();
		o.isFaceDown = false;
		o.faceDownSpec = undefined;
		o.faceDownLabel = undefined;
		const enteringView = resolveObjectFaces(o.copiableCard ?? o.card, {
			zone: 'battlefield',
			faceIndex: o.activeFaceIndex
		});
		if (enteringView.types.includes('Instant') || enteringView.types.includes('Sorcery')) {
			p.addLog(
				s,
				'rule',
				`${enteringView.name} remained in ${pl.username}'s library because an instant or sorcery card can't enter the battlefield (CR 304.4 / 307.4).`,
				pl.playerId
			);
			return;
		}
		const isAura = enteringView.subtypes.includes('Aura') || enteringView.typeLine.includes('Aura');
		if (isAura) {
			const attachCands = p.legalAuraAttachCandidates(s, o, pl);
			if (attachCands.length === 0) {
				p.addLog(
					s,
					'rule',
					`${enteringView.name} remained in ${pl.username}'s library because there is no legal object or player for it to enchant (CR 303.4g).`,
					pl.playerId
				);
				return;
			}
			const auraAns = this.answers[`aura:${o.instanceId}`];
			const pickedId = auraAns?.kind === 'chooseObjects' ? auraAns.objectIds[0] : undefined;
			attachObject(s, o, pickedId && attachCands.includes(pickedId) ? pickedId : attachCands[0]);
		}
		o.summoningSick = !enteringView.keywords.includes('Haste');
		o.tapped = tapped;
		o.defaultControllerId = pl.playerId;
		const res = moveObject(s, o, 'battlefield', {
			from: { player: pl, zone: 'library' },
			toPlayer: pl,
			controllerId: pl.playerId,
			newTimestamp: !isAura,
			bumpVersion: true
		});
		if (o.zone === 'battlefield') {
			p.addLog(
				s,
				'cast',
				`${pl.username} put ${enteringView.name} onto the battlefield (${this.ctx.title}).`,
				pl.playerId
			);
			if (isAura && o.attachedToId) {
				const host = p.findPermanent(s, o.attachedToId);
				if (host) p.triggerOnAttach(s, pl, o, host.inst);
			}
			p.triggerOnEtb(s, pl, o);
		}
		return res;
	}

	dig(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const dig = step.params?.dig;
		if (!dig) return;
		const pl = this.players(step.subject)[0] ?? this.you;

		const topKey = `dig_top:${this.stepIndex}`;
		const keepAnsKey = `dig_keep:${this.stepIndex}`;
		const keptFrozenKey = `dig_kept_ids:${this.stepIndex}`;
		const restFrozenKey = `dig_rest_ids:${this.stepIndex}`;
		const orderAnsKey = `dig_order:${this.stepIndex}`;
		const keepDoneKey = `dig_keep_done:${this.stepIndex}`;

		let topIds: string[];
		const savedTop = this.answers[topKey];
		if (savedTop?.kind === 'chooseObjects') {
			topIds = savedTop.objectIds;
		} else if (dig.untilFilter) {
			// --- Track P10: CR 701.20 reveal cards from top of library until a matching card is revealed ---
			if (pl.library.length === 0) return;
			const revealed: CardInstance[] = [];
			let matchedCard: CardInstance | undefined;
			for (let i = 0; i < pl.library.length; i++) {
				const c = pl.library[i];
				revealed.push(c);
				c.knownToPlayerIds = s.players.filter((x) => !x.lost).map((x) => x.playerId);
				if (this.matches(c, dig.untilFilter, 'library')) {
					matchedCard = c;
					break;
				}
			}
			topIds = revealed.map((c) => c.instanceId);
			this.answers[topKey] = { kind: 'chooseObjects', objectIds: topIds };
			const keptList = dig.restToHand ? revealed : matchedCard ? [matchedCard] : [];
			const restList = dig.restToHand
				? []
				: revealed.filter((c) => c.instanceId !== matchedCard?.instanceId);
			this.answers[keptFrozenKey] = {
				kind: 'chooseObjects',
				objectIds: keptList.map((c) => c.instanceId)
			};
			this.answers[restFrozenKey] = {
				kind: 'chooseObjects',
				objectIds: restList.map((c) => c.instanceId)
			};
			this.bind(step, keptList);
			p.addLog(
				s,
				'rule',
				`${pl.username} revealed ${revealed.map((c) => c.card.name).join(', ')} from their library.`,
				pl.playerId
			);
			// --- End Track P10 ---
		} else {
			const count = Math.min(Math.max(0, this.amount(step.amount)), pl.library.length);
			if (count <= 0) return;
			const topCards = pl.library.slice(0, count);
			topIds = topCards.map((c) => c.instanceId);
			this.answers[topKey] = { kind: 'chooseObjects', objectIds: topIds };
			if (dig.revealAll) {
				p.addLog(
					s,
					'rule',
					`${pl.username} revealed ${topCards.map((c) => c.card.name).join(', ')} from the top of their library.`,
					pl.playerId
				);
			}
		}

		if (dig.partitions && dig.partitions.length > 0) {
			const topCards = topIds
				.map((id) => pl.library.find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			if (topCards.length === 0) return;

			const partHandKey = `dig_part_hand:${this.stepIndex}`;
			const partExileKey = `dig_part_exile:${this.stepIndex}`;

			let handCard: CardInstance | undefined;
			let exileCard: CardInstance | undefined;
			let bottomCards: CardInstance[] = [];

			if (topCards.length === 1) {
				handCard = topCards[0];
			} else if (topCards.length === 2) {
				if (!pl.isBot && this.canPause && !this.answers[partHandKey]) {
					this.pauseForChoice(
						pl,
						`${this.ctx.title} — Choose card for hand`,
						`Choose 1 card to put into your hand; the other card will be exiled (playable this turn).`,
						topCards.map((c) => c.instanceId),
						1,
						1,
						'library',
						[topCards[0].instanceId],
						partHandKey
					);
					return;
				}
				const handId =
					this.answers[partHandKey]?.kind === 'chooseObjects'
						? this.answers[partHandKey].objectIds[0]
						: topCards[0].instanceId;
				handCard = topCards.find((c) => c.instanceId === handId) ?? topCards[0];
				exileCard = topCards.find((c) => c.instanceId !== handCard!.instanceId);
			} else {
				if (!pl.isBot && this.canPause && !this.answers[partHandKey]) {
					this.pauseForChoice(
						pl,
						`${this.ctx.title} — Choose card for hand`,
						`Choose 1 card to put into your hand.`,
						topCards.map((c) => c.instanceId),
						1,
						1,
						'library',
						[topCards[0].instanceId],
						partHandKey
					);
					return;
				}
				const handId =
					this.answers[partHandKey]?.kind === 'chooseObjects'
						? this.answers[partHandKey].objectIds[0]
						: topCards[0].instanceId;
				handCard = topCards.find((c) => c.instanceId === handId) ?? topCards[0];
				const remCards = topCards.filter((c) => c.instanceId !== handCard!.instanceId);

				if (!pl.isBot && this.canPause && !this.answers[partExileKey]) {
					this.pauseForChoice(
						pl,
						`${this.ctx.title} — Choose card to exile`,
						`Choose 1 card to exile (you may play it this turn); the remaining card goes on the bottom of your library.`,
						remCards.map((c) => c.instanceId),
						1,
						1,
						'library',
						[remCards[0].instanceId],
						partExileKey
					);
					return;
				}
				const exileId =
					this.answers[partExileKey]?.kind === 'chooseObjects'
						? this.answers[partExileKey].objectIds[0]
						: remCards[0].instanceId;
				exileCard = remCards.find((c) => c.instanceId === exileId) ?? remCards[0];
				bottomCards = remCards.filter((c) => c.instanceId !== exileCard!.instanceId);
			}

			if (handCard) {
				moveObject(s, handCard, 'hand', {
					from: { player: pl, zone: 'library' },
					toPlayer: pl,
					newTimestamp: true,
					bumpVersion: true
				});
			}
			if (exileCard) {
				moveObject(s, exileCard, 'exile', {
					from: { player: pl, zone: 'library' },
					toPlayer: pl,
					newTimestamp: true,
					bumpVersion: true
				});
				exileCard.playableFromExileBy = {
					playerId: pl.playerId,
					expiresAtEndOfTurn: true,
					sourceName: this.ctx.title,
					spendManaAsAnyColor: false
				};
			}
			for (const bCard of bottomCards) {
				moveObject(s, bCard, 'library', {
					from: { player: pl, zone: 'library' },
					toPlayer: pl,
					insert: 'end',
					newTimestamp: true,
					bumpVersion: true
				});
			}

			p.addLog(
				s,
				'rule',
				`${pl.username} put ${handCard ? handCard.card.name : 'nothing'} into hand, exiled ${exileCard ? exileCard.card.name : 'nothing'}, and put ${bottomCards.length} card(s) on the bottom of their library (${this.ctx.title}).`,
				pl.playerId
			);
			return;
		}

		let keptIds: string[];
		let restIds: string[];
		const savedKept = this.answers[keptFrozenKey];
		const savedRest = this.answers[restFrozenKey];
		if (savedKept?.kind === 'chooseObjects' && savedRest?.kind === 'chooseObjects') {
			keptIds = savedKept.objectIds;
			restIds = savedRest.objectIds;
		} else {
			const topCards = topIds
				.map((id) => pl.library.find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			const eligible = dig.keepFilter
				? topCards.filter((c) => this.matches(c, dig.keepFilter!, 'library'))
				: topCards;

			let kept: CardInstance[];
			if (dig.keepAllMatching) {
				kept = eligible;
			} else {
				const max = Math.min(dig.keep, eligible.length);
				const min = dig.upTo ? 0 : max;
				const needsPrompt = max > 0 && (dig.upTo || eligible.length > min);
				if (needsPrompt && !pl.isBot && this.canPause && !this.answers[keepAnsKey]) {
					const title = `${this.ctx.title} — Look at top ${topIds.length} card(s)`;
					const labelDesc = dig.keepLabel ? `${dig.keepLabel} ` : '';
					const destDesc =
						dig.keepTo === 'hand'
							? 'into your hand'
							: dig.keepTo === 'battlefield'
								? dig.keepTapped
									? 'onto the battlefield tapped'
									: 'onto the battlefield'
								: dig.keepTo === 'graveyard'
									? 'into your graveyard'
									: 'on top of your library';
					const restDesc =
						dig.rest === 'graveyard' ? 'the rest go into your graveyard.' : 'the rest go on the bottom.';
					this.pauseForChoice(
						pl,
						title,
						`Choose ${min === max ? max : `up to ${max}`} ${labelDesc}card(s) to put ${destDesc}; ${restDesc}`,
						eligible.map((c) => c.instanceId),
						min,
						max,
						'library',
						undefined,
						keepAnsKey
					);
					return;
				}
				if (max <= 0) {
					kept = [];
				} else if (this.answers[keepAnsKey]?.kind === 'chooseObjects') {
					kept = this.answered(keepAnsKey, eligible, min, max) ?? [];
				} else if (pl.isBot && dig.keepTo === 'battlefield') {
					kept = [...eligible].sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a)).slice(0, max);
				} else {
					kept = eligible.slice(0, max);
				}
			}

			keptIds = kept.map((c) => c.instanceId);
			const keptSet = new Set(keptIds);
			restIds = topCards.filter((c) => !keptSet.has(c.instanceId)).map((c) => c.instanceId);
			this.answers[keptFrozenKey] = { kind: 'chooseObjects', objectIds: keptIds };
			this.answers[restFrozenKey] = { kind: 'chooseObjects', objectIds: restIds };
			if (dig.revealKept && !dig.revealAll && kept.length > 0) {
				p.addLog(
					s,
					'rule',
					`${pl.username} revealed ${kept.map((c) => c.card.name).join(', ')}.`,
					pl.playerId
				);
			}
		}

		let orderedRestIds = [...restIds];
		if (dig.rest === 'libraryBottom' && restIds.length > 1) {
			const savedOrder = this.answers[orderAnsKey];
			if (savedOrder?.kind === 'orderObjects') {
				orderedRestIds = savedOrder.topIds.filter((id) => restIds.includes(id));
			} else if (dig.restRandom) {
				for (let i = orderedRestIds.length - 1; i > 0; i--) {
					const j = Math.floor(nextRandom(s) * (i + 1));
					[orderedRestIds[i], orderedRestIds[j]] = [orderedRestIds[j], orderedRestIds[i]];
				}
				this.answers[orderAnsKey] = { kind: 'orderObjects', topIds: orderedRestIds };
			} else if (dig.restOrder === 'any' && !pl.isBot && this.canPause) {
				this.pauseForOrder(
					pl,
					`${this.ctx.title} — Order cards on bottom`,
					`Put the remaining ${restIds.length} card(s) on the bottom of your library in any order.`,
					restIds,
					orderAnsKey
				);
				return;
			}
		}

		if (dig.keepTo !== 'libraryTop' && !this.answers[keepDoneKey]) {
			const batch = this.runIndexedBatch(
				`dig_keep_batch:${this.stepIndex}`,
				() => keptIds,
				(id) => {
					const o = pl.library.find((c) => c.instanceId === id);
					if (!o) return;
					if (dig.keepTo === 'hand') {
						return moveObject(s, o, 'hand', {
							from: { player: pl, zone: 'library' },
							toPlayer: pl,
							newTimestamp: true,
							bumpVersion: true
						});
					}
					if (dig.keepTo === 'graveyard') {
						return moveObject(s, o, 'graveyard', {
							from: { player: pl, zone: 'library' },
							toPlayer: pl,
							newTimestamp: true,
							bumpVersion: true
						});
					}
					if (dig.keepTo === 'battlefield') {
						return this.moveDigCardToBattlefield(o, pl, Boolean(dig.keepTapped));
					}
				}
			);
			if (batch.paused) return;
			this.answers[keepDoneKey] = { kind: 'yesNo', yes: true };
			this.subStepIndex = 0;
		}

		if (dig.rest === 'graveyard') {
			const batch = this.runIndexedBatch(
				`dig_rest_batch:${this.stepIndex}`,
				() => orderedRestIds,
				(id) => {
					const o = pl.library.find((c) => c.instanceId === id);
					if (!o) return;
					return moveObject(s, o, 'graveyard', {
						from: { player: pl, zone: 'library' },
						toPlayer: pl,
						newTimestamp: true,
						bumpVersion: true
					});
				}
			);
			if (batch.paused) return;
		} else {
			const keptInLib =
				dig.keepTo === 'libraryTop'
					? keptIds
							.map((id) => pl.library.find((c) => c.instanceId === id))
							.filter((c): c is CardInstance => Boolean(c))
					: [];
			const restInLib = orderedRestIds
				.map((id) => pl.library.find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			rearrangeLibrary(pl, [...keptInLib, ...restInLib], keptInLib, restInLib);
		}

		const keptSummary =
			dig.keepTo === 'libraryTop'
				? 'on top'
				: dig.keepTo === 'hand'
					? 'to hand'
					: dig.keepTo === 'battlefield'
						? 'to battlefield'
						: 'to graveyard';
		const restSummary = dig.rest === 'graveyard' ? 'to graveyard' : 'on bottom';
		p.addLog(
			s,
			'rule',
			`${pl.username} looked at the top ${topIds.length} card(s) of their library (${keptIds.length} ${keptSummary}, ${restIds.length} ${restSummary}).`,
			pl.playerId
		);
	}

	delayed(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const d = step.delayed!;
		const e = d.effect[0];
		const thatTurn = d.trigger.scope === 'controller_turn';
		const phase = d.trigger.filter.phase ?? 'end_step';
		const waitAfter = thatTurn ? s.turnNumber : undefined;
		const base = {
			controllerId: this.you.playerId,
			sourceInstanceId: this.ctx.sourceId,
			sourceCard: this.ctx.sourceCard,
			triggerPhase: phase,
			createdAtTurn: s.turnNumber,
			// "That turn's end step" (after an extra turn): the controller's next turn, not this one.
			targetPlayerId: thatTurn ? this.you.playerId : undefined,
			waitUntilAfterTurn: waitAfter,
			// "The next turn's upkeep": not this turn's (turnNumber counts rounds, so name the turn).
			...(d.nextTurn ? { notDuringTurn: `${s.turnNumber}:${s.activePlayerIndex}` } : {})
		};
		if (!s.delayedTriggers) s.delayedTriggers = [];
		const singlePlain = d.effect.length === 1 && !e?.condition && !e?.optional;
		if (singlePlain && phase === 'end_step' && e.verb === 'exile' && e.subject.k === 'binding') {
			for (const b of this.bindings.get(e.subject.name) ?? []) {
				const found = this.locate(b.id);
				const label = found ? found.inst.card.name : 'it';
				const dt: DelayedTrigger = {
					id: p.uid('dtrig', s),
					...base,
					targetInstanceId: b.id,
					title: `${this.ctx.title} — Delayed Exile Trigger`,
					description: `At the beginning of the next end step, exile ${label}.`,
					// CR 400.7: "it" is the object as it is now; if it changes zones again it's a new object.
					delayedEffect: {
						kind: 'exile',
						targetInstanceId: b.id,
						...(found?.zone === 'battlefield' ? { targetObjectVersion: found.inst.objectVersion } : {})
					}
				};
				s.delayedTriggers.push(dt);
			}
			return;
		}
		if (
			singlePlain &&
			phase === 'end_step' &&
			e.verb === 'lose' &&
			e.subject.k === 'player' &&
			e.subject.filter.relation === 'you'
		) {
			s.delayedTriggers.push({
				id: p.uid('dtrig', s),
				...base,
				title: `${this.ctx.title} — Delayed End Step Trigger`,
				description: 'At the beginning of the end step, you lose the game.',
				delayedEffect: { kind: 'lose' }
			});
			return;
		}
		if (d.effect.length === 1 && phase === 'upkeep' && e.verb === 'draw' && !e.condition) {
			const amount = Math.max(0, this.amount(e.amount, 1));
			const upTo = Boolean(e.params?.upTo);
			for (const pl of this.players(e.subject)) {
				s.delayedTriggers.push({
					id: p.uid('dtrig', s),
					...base,
					title: `${this.ctx.title} — Delayed Upkeep Trigger`,
					description: `At the beginning of the next turn's upkeep, ${pl.username} draws ${upTo ? `up to ${amount}` : amount} card(s).`,
					delayedEffect: { kind: 'draw', playerId: pl.playerId, amount, upTo }
				});
			}
			return;
		}

		// CR 603.7: General IR-safe delayed trigger — store only a plain-JSON ability locator and
		// versioned binding/target snapshots, never EffectStep[].
		const item = this.ctx.item;
		const existingLocator =
			item.delayedEffect?.kind === 'compiledDelayed' ? item.delayedEffect : undefined;
		const boundRefs: SerializedBoundRef[] = [];
		for (const [key, list] of this.bindings.entries()) {
			for (const b of list) {
				const found = this.locate(b.id);
				if (!found) continue;
				boundRefs.push({
					key,
					id: b.id,
					expectedZone: found.zone,
					objectVersion: found.inst.objectVersion ?? 1,
					lki: { ...b.lki }
				});
			}
		}
		const targetObjectVersions: Record<string, number> = {};
		for (const t of this.ctx.targets) {
			if (t.kind === 'player' || t.kind === 'stack') continue;
			const found = this.locate(t.id);
			if (found) targetObjectVersions[t.id] = found.inst.objectVersion ?? 1;
			else if (item.targetObjectVersions?.[t.id] !== undefined) {
				targetObjectVersions[t.id] = item.targetObjectVersions[t.id];
			}
		}
		const abilityKind: CompiledDelayedEffect['abilityKind'] = existingLocator
			? existingLocator.abilityKind
			: item.kind === 'spell'
				? 'spell'
				: item.kind === 'activated'
					? 'activated'
					: 'triggered';
		const compiledDelayed: CompiledDelayedEffect = {
			kind: 'compiledDelayed',
			sourceCard: existingLocator ? existingLocator.sourceCard : this.ctx.sourceCard,
			...(existingLocator?.faceIndex !== undefined
				? { faceIndex: existingLocator.faceIndex }
				: item.faceIndex !== undefined
					? { faceIndex: item.faceIndex }
					: {}),
			...(existingLocator?.fused ?? item.fused ? { fused: true } : {}),
			abilityKind,
			...(existingLocator?.abilityId ?? item.abilityId
				? { abilityId: existingLocator?.abilityId ?? item.abilityId }
				: {}),
			...(existingLocator?.abilityIndex !== undefined
				? { abilityIndex: existingLocator.abilityIndex }
				: item.triggeredAbilityIndex !== undefined
					? { abilityIndex: item.triggeredAbilityIndex }
					: {}),
			...(existingLocator?.grantSourceCard ?? item.grantSourceCard
				? { grantSourceCard: existingLocator?.grantSourceCard ?? item.grantSourceCard }
				: {}),
			...(existingLocator?.grantedKeyword ?? item.grantedKeyword
				? { grantedKeyword: existingLocator?.grantedKeyword ?? item.grantedKeyword }
				: {}),
			...(existingLocator?.chosenModes ?? item.chosenModes
				? { chosenModes: [...(existingLocator?.chosenModes ?? item.chosenModes)!] }
				: {}),
			stepPath: [...(this.ctx.stepPathPrefix ?? []), this.stepIndex],
			boundRefs,
			targets: this.ctx.targets.map((t) => ({ ...t })),
			...(Object.keys(targetObjectVersions).length > 0 ? { targetObjectVersions } : {}),
			...(this.ctx.eventObjectId ? { eventObjectId: this.ctx.eventObjectId } : {}),
			...(this.ctx.eventObjectVersion !== undefined
				? { eventObjectVersion: this.ctx.eventObjectVersion }
				: {}),
			...(this.ctx.eventPlayerId ? { eventPlayerId: this.ctx.eventPlayerId } : {}),
			...(this.ctx.defendingPlayerId ? { defendingPlayerId: this.ctx.defendingPlayerId } : {}),
			...(this.ctx.eventLki ? { eventLki: { ...this.ctx.eventLki } } : {}),
			...(this.ctx.xValue ? { xValue: this.ctx.xValue } : {}),
			...(item.sourceKickedCount !== undefined ? { kickedCount: item.sourceKickedCount } : {}),
			...(item.sourceKickedTags?.length ? { kickedTags: [...item.sourceKickedTags] } : {}),
			...(item.sourceKickedTagCounts ? { kickedTagCounts: { ...item.sourceKickedTagCounts } } : {})
		};
		const phaseTitle =
			phase === 'end_combat'
				? 'Delayed End of Combat Trigger'
				: phase === 'upkeep'
					? 'Delayed Upkeep Trigger'
					: 'Delayed End Step Trigger';
		const phaseDesc =
			phase === 'end_combat'
				? 'At end of combat, resolve delayed trigger.'
				: phase === 'upkeep'
					? "At the beginning of the next turn's upkeep, resolve delayed trigger."
					: 'At the beginning of the next end step, resolve delayed trigger.';
		s.delayedTriggers.push({
			id: p.uid('dtrig', s),
			...base,
			title: `${this.ctx.title} — ${phaseTitle}`,
			description: phaseDesc,
			delayedEffect: compiledDelayed
		});
	}

	condition(c: Condition): boolean {
		switch (c.k) {
			case 'compare':
				return compare(this.amount(c.left), c.op, this.amount(c.right));
			case 'and':
				return c.of.every((x) => this.condition(x));
			case 'or':
				return c.of.some((x) => this.condition(x));
			case 'not':
				return !this.condition(c.of);
			case 'isTurnOf': {
				const p = this.playerRef(c.player);
				return Boolean(p && this.state.players[this.state.activePlayerIndex]?.playerId === p.playerId);
			}
			case 'graveyardAbove':
				return false;
			case 'controlCommander':
				return this.you.battlefield.some((perm) => !perm.phasedOut && Boolean(perm.isCommander));
			case 'kicked':
				return evaluateKickerCondition(c, this.kickerInfo());
			case 'evoked':
				return isObjectEvoked(this.state, this.ctx.sourceId, this.ctx.item);
			case 'escaped':
				return isObjectEscaped(this.state, this.ctx.sourceId, this.ctx.item);
			case 'isMonarch': {
				const monarchId = this.state.monarchPlayerId ?? null;
				if (!monarchId) return false;
				if (c.player) {
					const pl = this.playerRef(c.player);
					return Boolean(pl && monarchId === pl.playerId);
				}
				const rel = c.relation ?? 'you';
				if (rel === 'you') return monarchId === this.you.playerId;
				if (rel === 'opponent') return monarchId !== this.you.playerId;
				return true;
			}
			case 'foretold':
				return isObjectForetold(this.state, this.ctx.sourceId, this.ctx.item);
			case 'blitzed':
				return isObjectBlitzed(this.state, this.ctx.sourceId, this.ctx.item);
			case 'saddled': {
				const f = this.locate(this.ctx.sourceId);
				return Boolean(f && f.zone === 'battlefield' && !f.inst.phasedOut && f.inst.saddledThisTurn);
			}
			// --- Track P4 ---
			case 'exertedThisTurn': {
				if (this.ctx.item.sourceExertedThisTurn) return true;
				const f = this.locate(this.ctx.sourceId);
				return Boolean(f && f.zone === 'battlefield' && !f.inst.phasedOut && f.inst.exertedThisTurn);
			}
			// --- Track P5 ---
			case 'monstrous': {
				const f = this.locate(this.ctx.sourceId);
				if (
					f &&
					f.zone === 'battlefield' &&
					!f.inst.phasedOut &&
					(this.ctx.item.sourceObjectVersion === undefined ||
						(f.inst.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
				) {
					return Boolean(f.inst.isMonstrous);
				}
				return Boolean(this.ctx.item.sourceMonstrous);
			}
			case 'matchesFilter': {
				const targetRef = c.target ?? { k: 'self' };
				const objs = this.objects(targetRef as Selector);
				if (objs.length === 0) return false;
				return objs.every((o) =>
					this.matches(
						o,
						c.filter,
						(o.zone === 'command' ? 'exile' : o.zone) as
							| 'battlefield'
							| 'graveyard'
							| 'hand'
							| 'library'
							| 'exile'
					)
				);
			}
			case 'evolveCompare': {
				const src = this.sourcePerm;
				if (!src || src.zone !== 'battlefield') return false;
				const srcEval = evaluatePermanent(this.state, src);
				if (!srcEval.isCreature) return false;
				let enterPower: number | undefined;
				let enterToughness: number | undefined;
				if (this.ctx.eventObjectId) {
					const enterPerm = this.locate(this.ctx.eventObjectId)?.inst;
					if (enterPerm && enterPerm.zone === 'battlefield') {
						const enterEval = evaluatePermanent(this.state, enterPerm);
						enterPower = enterEval.power;
						enterToughness = enterEval.toughness;
					} else if (this.ctx.eventLki) {
						enterPower = this.ctx.eventLki.power;
						enterToughness = this.ctx.eventLki.toughness;
					}
				}
				if (enterPower === undefined || enterToughness === undefined) return false;
				return enterPower > srcEval.power || enterToughness > srcEval.toughness;
			}
			// --- Track P7 ---
			case 'creatureDiedThisTurn':
			case 'attackedThisTurn':
			case 'permanentLeftBattlefieldThisTurn':
			case 'gainedLifeThisTurn':
			case 'wasCast': {
				const f = this.locate(this.ctx.sourceId);
				const liveObj =
					f &&
					f.zone === 'battlefield' &&
					!f.inst.phasedOut &&
					(this.ctx.item.sourceObjectVersion === undefined ||
						(f.inst.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
						? f.inst
						: undefined;
				const minLife =
					c.k === 'gainedLifeThisTurn' && c.min ? this.amount(c.min, 1) : undefined;
				return evaluateP7Condition(this.state, c, this.you.playerId, {
					minLife,
					sourceObj: liveObj,
					stackItem: this.ctx.item
				});
			}
			// --- Track P8 ---
			case 'objectState':
			case 'opponentCount':
			case 'anyPlayerLife':
			case 'distinctControlledCreaturePowers': {
				const srcFound = this.locate(this.ctx.sourceId);
				return evaluateP8Condition(c, {
					state: this.state,
					controllerId: this.you.playerId,
					source: srcFound?.inst,
					stackItem: this.ctx.item,
					xValue: this.ctx.xValue
				});
			}
			// --- Track P9 ---
			case 'cameUnderControlSinceLastUpkeep': {
				const f = this.locate(this.ctx.sourceId);
				return cameUnderControlSinceLastUpkeep(
					this.state,
					this.you.playerId,
					f && f.zone === 'battlefield' ? f.inst : undefined
				);
			}
			case 'ninjutsuWindow':
				return isNinjutsuWindowOpen(this.state);
			case 'lkiHasNoCounter':
				return (this.ctx.eventLki?.counters?.[c.counter] ?? 0) <= 0;
			// --- Track P10 ---
			case 'opponentLostLifeThisTurn':
			case 'descendedThisTurn':
			case 'hadCounterOnIt':
			case 'manaColorSpentToCast':
			case 'opponentComparison': {
				const f = this.locate(this.ctx.sourceId);
				const liveObj =
					f &&
					f.zone === 'battlefield' &&
					!f.inst.phasedOut &&
					(this.ctx.item.sourceObjectVersion === undefined ||
						(f.inst.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
						? f.inst
						: undefined;
				return evaluateP10Condition(c, {
					state: this.state,
					controllerId: this.you.playerId,
					source: liveObj,
					stackItem: this.ctx.item,
					eventLkiCounters: this.ctx.eventLki?.counters
				});
			}
			// --- End Track P10 ---
			// --- Track P12 ---
			case 'classLevelIs':
			case 'classLevelAtLeast':
			case 'caseSolved':
			case 'caseUnsolved':
			case 'isRenowned':
			case 'boastAttackedThisTurn':
			case 'exhaustUnused':
			case 'dethroneMostLife':
			case 'trainingGreaterAttacker':
			case 'creaturesAttackedCountThisTurn':
			case 'totalPowerControlled':
			case 'colorsAmongControlledPermanents':
			case 'sourcesDealtDamageThisTurn':
			case 'cardsPutIntoGraveyardFromAnywhereThisTurn':
			case 'spellsCastThisTurnCount': {
				const srcFound = this.locate(this.ctx.sourceId);
				return (
					evaluateP12Condition(
						c,
						{
							state: this.state,
							controllerId: this.you.playerId,
							source: srcFound?.inst,
							stackItem: this.ctx.item,
							xValue: this.ctx.xValue
						},
						matchesObjectFilter
					) ?? false
				);
			}
			// --- End Track P12 ---
			// --- Track P13 ---
			case 'selfInZone':
			case 'spellsCastLastTurn':
			case 'hasCompletedDungeon':
			case 'hasInitiative':
			case 'hasCitysBlessing':
			case 'hasMaxSpeed':
			case 'opponentPoisonAtLeast':
			case 'nonlandEnteredThisTurn':
			case 'voidThisTurn':
			case 'sameColorManaSpentAtLeast': {
				const srcFound = this.locate(this.ctx.sourceId);
				return (
					evaluateP13Condition(c, {
						state: this.state,
						controllerId: this.you.playerId,
						sourceId: this.ctx.sourceId,
						source: srcFound?.inst ?? null,
						stackItem: this.ctx.item
					}) ?? false
				);
			}
			// --- End Track P13 ---
			// --- Track P14 ---
			case 'anyOpponentMetric':
			case 'cardsDrawnThisTurnAtLeast':
			case 'nthMatchingSpellThisTurn': {
				const srcFound = this.locate(this.ctx.sourceId);
				return (
					evaluateWave5Condition(c, {
						state: this.state,
						controllerId: this.you.playerId,
						source: srcFound?.inst,
						stackItem: this.ctx.item,
						xValue: this.ctx.xValue
					}) ?? false
				);
			}
			// --- End Track P14 ---
		}
	}

	// --- Track P10 ---
	private runInlineBranchSteps(inlineSteps: EffectStep[], subPathTag: number): boolean {
		if (inlineSteps.length === 0) return false;
		const parentStepIndex = this.stepIndex;
		const parentPrefix = this.subPathPrefix ?? this.ctx.stepPathPrefix ?? [];
		const ns = `inl:${parentStepIndex}:${subPathTag}:`;

		const idxAns = this.answers[`${ns}__idx`];
		const startIdx = idxAns?.kind === 'chooseNumber' ? idxAns.n : 0;
		const subAns = this.answers[`${ns}__sub`];
		const startSub = subAns?.kind === 'chooseNumber' ? subAns.n : 0;
		const phaseAns = this.answers[`${ns}__phase`];
		const startPhase: 'optional' | 'step' | 'afterStep' =
			phaseAns?.kind === 'chooseObjects' &&
			(phaseAns.objectIds[0] === 'optional' ||
				phaseAns.objectIds[0] === 'step' ||
				phaseAns.objectIds[0] === 'afterStep')
				? phaseAns.objectIds[0]
				: 'optional';

		const childAnswers: Record<string, ChoiceAnswer> = {};
		const childDecisions: Record<number, boolean> = {};
		for (const [k, v] of Object.entries(this.answers)) {
			if (!k.startsWith(ns)) continue;
			const subKey = k.slice(ns.length);
			if (subKey === '__idx' || subKey === '__sub' || subKey === '__phase') continue;
			if (subKey.startsWith('__dec:')) {
				const dIdx = Number(subKey.slice(6));
				if (Number.isFinite(dIdx) && v.kind === 'yesNo') {
					childDecisions[dIdx] = v.yes;
				}
				continue;
			}
			childAnswers[subKey] = v;
		}

		const childCtx: EffectContext = {
			...this.ctx,
			stepPathPrefix: [...parentPrefix, parentStepIndex, subPathTag]
		};
		const childRun = new Run(this.state, childCtx);
		childRun.stepIndex = startIdx;
		childRun.subStepIndex = startSub;
		childRun.phase = startPhase;
		childRun.answers = childAnswers;
		childRun.stepDecisions = childDecisions;
		childRun.lastRollResult = this.lastRollResult;
		// --- Track P13 ---
		childRun.lastExcessDamage = this.lastExcessDamage;
		childRun.lastEffectAmount = this.lastEffectAmount;
		// --- End Track P13 ---
		for (const [name, bound] of this.bindings.entries()) {
			childRun.bindings.set(
				name,
				bound.map((b) => ({ id: b.id, lki: { ...b.lki } }))
			);
		}
		childRun.result.exileSelf = this.result.exileSelf;
		if (this.result.librarySelf) childRun.result.librarySelf = { ...this.result.librarySelf };

		const syncParentFromChild = () => {
			this.lastRollResult = childRun.lastRollResult;
			if (this.lastRollResult !== undefined) {
				this.ctx.item.lastRollResult = this.lastRollResult;
			}
			// --- Track P13 ---
			this.lastExcessDamage = childRun.lastExcessDamage;
			if (this.lastExcessDamage !== undefined) {
				this.ctx.item.lastExcessDamage = this.lastExcessDamage;
			}
			this.lastEffectAmount = childRun.lastEffectAmount;
			if (this.lastEffectAmount !== undefined) {
				this.ctx.item.lastEffectAmount = this.lastEffectAmount;
			}
			// --- End Track P13 ---
			this.bindings.clear();
			for (const [name, bound] of childRun.bindings.entries()) {
				this.bindings.set(name, bound);
			}
			if (childRun.result.exileSelf) this.result.exileSelf = true;
			if (childRun.result.librarySelf) this.result.librarySelf = { ...childRun.result.librarySelf };
			if (childRun.result.turnEnded) this.result.turnEnded = true;
		};

		childRun.saveFrameOverride = (cStepIdx, cAnswers, cPhase, cSubIdx) => {
			syncParentFromChild();
			const merged: Record<string, ChoiceAnswer> = {};
			for (const [k, v] of Object.entries(this.answers)) {
				if (!k.startsWith(ns)) merged[k] = v;
			}
			merged[`${ns}__idx`] = { kind: 'chooseNumber', n: cStepIdx };
			merged[`${ns}__sub`] = { kind: 'chooseNumber', n: cSubIdx };
			merged[`${ns}__phase`] = { kind: 'chooseObjects', objectIds: [cPhase] };
			for (const [dIdx, dVal] of Object.entries(childRun.stepDecisions)) {
				merged[`${ns}__dec:${dIdx}`] = { kind: 'yesNo', yes: Boolean(dVal) };
			}
			for (const [ck, cv] of Object.entries(cAnswers)) {
				merged[`${ns}${ck}`] = cv;
			}
			this.answers = merged;
			return this.saveFrame(parentStepIndex, merged, 'step', this.subStepIndex);
		};

		const promptsBefore = this.state.pendingPrompts.length;
		childRun.run(inlineSteps);
		syncParentFromChild();

		if (childRun.result.paused) {
			const queued = this.state.pendingPrompts.slice(promptsBefore);
			for (const pr of queued) {
				if (pr.continuation?.kind === 'effect_choice') {
					pr.continuation.stepIndex = parentStepIndex;
					pr.continuation.answerKey = `${ns}${pr.continuation.answerKey ?? pr.playerId}`;
				} else if (pr.continuation?.kind === 'effect_resume') {
					pr.continuation.stepIndex = parentStepIndex;
				} else if (pr.continuation?.kind === 'handler' && pr.continuation.data) {
					pr.continuation.data.resumeStepIndex = parentStepIndex;
				} else if (pr.continuation?.kind === 'procedure') {
					const proc = pr.continuation.procedure;
					if ('resumeStepIndex' in proc && proc.resumeStepIndex !== undefined) {
						proc.resumeStepIndex = parentStepIndex;
					}
				}
			}
			if (
				this.state.pendingProcedure?.kind === 'surveil_graveyard' &&
				this.state.pendingProcedure.resumeStackItemId === this.ctx.item.id
			) {
				this.state.pendingProcedure.resumeStepIndex = parentStepIndex;
			}
			this.result.paused = true;
			return true;
		}
		return false;
	}

	private p10Host(): P10EffectHost {
		const self = this;
		const base = this.keywordHost();
		return {
			...base,
			get state() {
				return self.state;
			},
			get ports() {
				return P();
			},
			get you() {
				return self.you;
			},
			get title() {
				return self.ctx.title;
			},
			get sourceCard() {
				return self.ctx.sourceCard;
			},
			get sourceId() {
				return self.ctx.sourceId;
			},
			get sourceObjectVersion() {
				return self.ctx.item.sourceObjectVersion;
			},
			get stepIndex() {
				return self.stepIndex;
			},
			get canPause() {
				return self.canPause;
			},
			get answers() {
				return self.answers;
			},
			get item() {
				return self.ctx.item;
			},
			get stepPathPrefix() {
				return self.subPathPrefix ?? self.ctx.stepPathPrefix;
			},
			setStepDecision: (accepted: boolean) => {
				self.stepDecisions[self.stepIndex] = accepted;
			},
			getStepDecision: (idx?: number) => self.stepDecisions[idx ?? self.stepIndex],
			setLastRollResult: (n: number) => {
				self.lastRollResult = n;
				self.ctx.item.lastRollResult = n;
			},
			getLastRollResult: () => self.lastRollResult ?? self.ctx.item.lastRollResult,
			pauseForYesNo: (chooser, title, question, answerKey, labels) =>
				self.pauseForYesNo(chooser, title, question, answerKey, labels),
			pauseForMode: (chooser, title, description, modes, min, max, answerKey, defaultIndices) => {
				const item = self.saveFrame(self.stepIndex, self.answers, 'step', self.subStepIndex);
				enqueueChoicePrompt(self.state, {
					id: P().uid('prompt', self.state),
					kind: 'chooseMode',
					playerId: chooser.playerId,
					title,
					description,
					continuation: {
						kind: 'effect_choice',
						stackItemId: item.id,
						stepIndex: self.stepIndex,
						answerKey
					},
					choice: {
						kind: 'chooseMode',
						modes,
						min,
						max,
						...(defaultIndices ? { defaultIndices } : {})
					}
				});
				self.result.paused = true;
			},
			pauseForWeightedChoice: (
				chooser,
				title,
				description,
				candidates,
				min,
				max,
				zone,
				weightsById,
				minWeightSum,
				weightLabel,
				defaultObjectIds,
				answerKey
			) => {
				const item = self.saveFrame(self.stepIndex, self.answers, 'step', self.subStepIndex);
				enqueueChoicePrompt(self.state, {
					id: P().uid('prompt', self.state),
					kind: 'chooseObjects',
					playerId: chooser.playerId,
					title,
					description,
					candidateInstanceIds: candidates,
					countRequired: min,
					continuation: {
						kind: 'effect_choice',
						stackItemId: item.id,
						stepIndex: self.stepIndex,
						answerKey
					},
					choice: {
						kind: 'chooseObjects',
						candidates,
						min,
						max,
						zone,
						reason: title,
						defaultObjectIds,
						minWeightSum,
						weightsById,
						weightLabel
					}
				});
				self.result.paused = true;
			},
			pauseForSplitOrder: (chooser, title, description, objectIds, allowSplitBottom, answerKey) => {
				const item = self.saveFrame(self.stepIndex, self.answers, 'step', self.subStepIndex);
				enqueueChoicePrompt(self.state, {
					id: P().uid('prompt', self.state),
					kind: 'orderObjects',
					playerId: chooser.playerId,
					title,
					description,
					candidateInstanceIds: objectIds,
					allowBottom: allowSplitBottom,
					continuation: {
						kind: 'effect_choice',
						stackItemId: item.id,
						stepIndex: self.stepIndex,
						answerKey
					},
					choice: {
						kind: 'orderObjects',
						objectIds,
						allowSplitBottom,
						allowShuffle: false,
						splitLabel: 'bottom',
						reason: description
					}
				});
				self.result.paused = true;
			},
			runInlineSteps: (steps, subPathTag) => self.runInlineBranchSteps(steps, subPathTag),
			captureBoundRefs: () => {
				const boundRefs: SerializedBoundRef[] = [];
				for (const [key, list] of self.bindings.entries()) {
					for (const b of list) {
						const found = self.locate(b.id);
						boundRefs.push({
							key,
							id: b.id,
							expectedZone: found ? found.zone : 'graveyard',
							objectVersion: found ? (found.inst.objectVersion ?? 1) : 1,
							lki: { ...b.lki }
						});
					}
				}
				return boundRefs;
			}
		};
	}
	// --- End Track P10 ---

	// --- Track P13 ---
	private recordEffectAmount(n: number): void {
		this.lastEffectAmount = n;
		this.ctx.item.lastEffectAmount = n;
	}

	private p13AskFn(): P13StepAskFn {
		return (player, answerKey, choice, title, description) => {
			const existing = this.answers[answerKey];
			if (existing) return existing;
			if (player.isBot || !this.canPause) {
				if (choice.kind === 'chooseMode') {
					return { kind: 'chooseMode', indices: choice.defaultIndices ?? [0] };
				}
				if (choice.kind === 'chooseObjects') {
					const defs = choice.defaultObjectIds ?? choice.candidates.slice(0, choice.min);
					return { kind: 'chooseObjects', objectIds: defs };
				}
				if (choice.kind === 'yesNo') {
					return { kind: 'yesNo', yes: true };
				}
				return { kind: 'chooseNumber', n: 0 };
			}
			const item = this.saveFrame(this.stepIndex, this.answers, 'step', this.subStepIndex);
			const promptKind =
				choice.kind === 'chooseMode'
					? 'chooseMode'
					: choice.kind === 'chooseObjects'
						? 'chooseObjects'
						: choice.kind === 'yesNo'
							? 'yesNo'
							: 'chooseNumber';
			enqueueChoicePrompt(this.state, {
				id: P().uid('prompt', this.state),
				kind: promptKind,
				playerId: player.playerId,
				title,
				description,
				...(choice.kind === 'chooseObjects'
					? {
							candidateInstanceIds: choice.candidates,
							countRequired: choice.min
						}
					: {}),
				continuation: {
					kind: 'effect_choice',
					stackItemId: item.id,
					stepIndex: this.stepIndex,
					answerKey
				},
				choice
			});
			this.result.paused = true;
			return 'PAUSED';
		};
	}

	private p13LifeFunnels(): P13LifeFunnels {
		return {
			gainLife: (state, player, amount) => gainPlayerLife(state, player, amount),
			loseLife: (state, player, amount) => {
				if (amount <= 0 || player.lost) return 0;
				const cantChange =
					Boolean(player.lifeTotalCannotChangeThisTurn) ||
					activeRuleModifiers(state, 'lifeTotalCantChange', player.playerId).length > 0;
				if (cantChange) return 0;
				player.life -= amount;
				if (!player.lostLifeThisTurn) {
					player.lostLifeThisTurn = true;
					noteLayerInputsChanged(state);
				}
				recordPlayerLifeLossWave4(player, amount);
				return amount;
			},
			lifeCantChange: (state, player) =>
				Boolean(player.lifeTotalCannotChangeThisTurn) ||
				activeRuleModifiers(state, 'lifeTotalCantChange', player.playerId).length > 0
		};
	}

	private runTrackedP13InlineSteps(
		inlineSteps: EffectStep[],
		tag: number,
		eventPlayerId?: string
	): boolean {
		const doneKey = `p13_inl_done:${this.stepIndex}:${tag}`;
		if (this.answers[doneKey]?.kind === 'yesNo' && this.answers[doneKey].yes) {
			return true;
		}
		const prevEventPlayerId = this.ctx.eventPlayerId;
		if (eventPlayerId !== undefined) this.ctx.eventPlayerId = eventPlayerId;
		const paused = this.runInlineBranchSteps(inlineSteps, tag);
		this.ctx.eventPlayerId = prevEventPlayerId;
		if (!paused) {
			this.answers[doneKey] = { kind: 'yesNo', yes: true };
			return true;
		}
		return false;
	}
	// --- End Track P13 ---

	private keywordHost(): KeywordActionHost {
		const self = this;
		return {
			get state() {
				return self.state;
			},
			get ports() {
				return P();
			},
			get you() {
				return self.you;
			},
			get title() {
				return self.ctx.title;
			},
			get sourceCard() {
				return self.ctx.sourceCard;
			},
			get sourceId() {
				return self.ctx.sourceId;
			},
			get sourceObjectVersion() {
				return self.ctx.item.sourceObjectVersion;
			},
			get stepIndex() {
				return self.stepIndex;
			},
			get canPause() {
				return self.canPause;
			},
			get answers() {
				return self.answers;
			},
			amount: (a, fb) => self.amount(a, fb),
			objects: (sel) => self.objects(sel),
			players: (sel) => self.players(sel),
			playerRef: (ref) => self.playerRef(ref),
			matches: (c, f, z) => self.matches(c, f, z),
			locate: (id) => self.locate(id),
			bind: (st, objs) => self.bind(st, objs),
			answered: (key, cands, min, max) => self.answered(key, cands, min, max),
			pauseForChoice: (chooser, title, desc, cands, min, max, zone, defaults, ansKey) =>
				self.pauseForChoice(chooser, title, desc, cands, min, max, zone, defaults, ansKey),
			runIndexedBatch: (batchKey, captureIds, applyAt) =>
				self.runIndexedBatch(batchKey, captureIds, applyAt)
		};
	}

	/** Synthetic LKI CardInstance fallback when an acting object ceased to exist before resolution. */
	private syntheticLkiObject(instanceId: string, controllerId: string): CardInstance {
		const lki = this.ctx.eventLki;
		return {
			instanceId,
			card: this.ctx.sourceCard,
			ownerId: lki?.ownerId ?? controllerId,
			controllerId,
			zone: 'graveyard',
			tapped: false,
			summoningSick: false,
			damageMarked: 0,
			deathtouchDamageMarked: false,
			counters: createEmptyCounters(),
			tempPowerMod: 0,
			tempToughnessMod: 0,
			grantedKeywords: [],
			attachedToId: null,
			isToken: true,
			isCommander: false,
			commanderCastCount: 0,
			usedLoyaltyThisTurn: false,
			transformed: false
		};
	}

	/** Resolves action subjects for explore/connive in APNAP order with LKI fallback (CR 701.44c–d, 701.50b–c). */
	private resolveActionObjects(
		subject: Selector
	): Array<{ id: string; controllerId: string; initialVersion: string; obj: CardInstance }> {
		const out: Array<{ id: string; controllerId: string; initialVersion: string; obj: CardInstance }> = [];
		switch (subject.k) {
			case 'self': {
				const f = this.locate(this.ctx.sourceId);
				if (f && f.zone === 'battlefield' && !f.inst.phasedOut) {
					out.push({
						id: f.inst.instanceId,
						controllerId: f.inst.controllerId,
						initialVersion: String(f.inst.objectVersion ?? 0),
						obj: f.inst
					});
				} else {
					const controllerId = this.ctx.eventLki?.controllerId ?? this.you.playerId;
					const obj = f?.inst ?? this.syntheticLkiObject(this.ctx.sourceId, controllerId);
					out.push({ id: this.ctx.sourceId, controllerId, initialVersion: 'off', obj });
				}
				break;
			}
			case 'eventObject': {
				const live = this.objects(subject);
				if (live.length > 0) {
					for (const o of live) {
						out.push({
							id: o.instanceId,
							controllerId: o.zone === 'battlefield' ? o.controllerId : (this.ctx.eventLki?.controllerId ?? o.controllerId),
							initialVersion: o.zone === 'battlefield' ? String(o.objectVersion ?? 0) : 'off',
							obj: o
						});
					}
				} else if (this.ctx.eventObjectId) {
					const f = this.locate(this.ctx.eventObjectId);
					const controllerId = this.ctx.eventLki?.controllerId ?? f?.inst.controllerId ?? this.you.playerId;
					const obj = f?.inst ?? this.syntheticLkiObject(this.ctx.eventObjectId, controllerId);
					out.push({ id: this.ctx.eventObjectId, controllerId, initialVersion: 'off', obj });
				}
				break;
			}
			case 'binding': {
				for (const b of this.bindings.get(subject.name) ?? []) {
					const f = this.locate(b.id);
					if (f && f.zone === 'battlefield' && !f.inst.phasedOut) {
						out.push({
							id: f.inst.instanceId,
							controllerId: f.inst.controllerId,
							initialVersion: String(f.inst.objectVersion ?? 0),
							obj: f.inst
						});
					} else {
						const controllerId = b.lki.controllerId;
						const obj = f?.inst ?? this.syntheticLkiObject(b.id, controllerId);
						out.push({ id: b.id, controllerId, initialVersion: 'off', obj });
					}
				}
				break;
			}
			default: {
				for (const o of this.objects(subject)) {
					if (o.zone !== 'battlefield') continue;
					out.push({
						id: o.instanceId,
						controllerId: o.controllerId,
						initialVersion: String(o.objectVersion ?? 0),
						obj: o
					});
				}
				break;
			}
		}
		const apnapOrder = new Map(this.apnapPlayers().map((pl, idx) => [pl.playerId, idx]));
		out.sort((a, b) => (apnapOrder.get(a.controllerId) ?? 999) - (apnapOrder.get(b.controllerId) ?? 999));
		return out;
	}

	private decodeBatchEntries(
		batchKey: string,
		subject: Selector
	): Array<{ id: string; controllerId: string; initialVersion: string }> {
		if (!this.answers[batchKey]) {
			const entries = this.resolveActionObjects(subject);
			this.bind(
				{ verb: 'explore', subject, span: { start: 0, end: 0 } },
				entries.map((e) => e.obj)
			);
			const encoded = entries.map((e) => `${e.id}|${e.controllerId}|${e.initialVersion}`);
			if (this.canPause) {
				this.answers[batchKey] = { kind: 'chooseObjects', objectIds: encoded };
			}
			return entries.map(({ id, controllerId, initialVersion }) => ({ id, controllerId, initialVersion }));
		}
		const ans = this.answers[batchKey];
		if (ans.kind !== 'chooseObjects') return [];
		return ans.objectIds.map((raw) => {
			const [id, controllerId, initialVersion] = raw.split('|');
			return { id, controllerId, initialVersion };
		});
	}

	goad(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const goader = step.actor ? this.playerRef(step.actor) : this.you;
		if (!goader || goader.lost) return;
		const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
		this.bind(step, objs);
		const duration: 'endOfTurn' | 'untilYourNextTurn' =
			step.params?.duration === 'endOfTurn' ? 'endOfTurn' : 'untilYourNextTurn';
		for (const o of objs) {
			const list = (o.goadedByPlayerIds ??= []);
			// CR 701.15d: a player goading an already-goaded creature by that player creates a redundant requirement.
			if (!list.includes(goader.playerId)) list.push(goader.playerId);
			const exp = (o.goadExpirations ??= {});
			if (exp[goader.playerId] !== 'untilYourNextTurn') {
				exp[goader.playerId] = duration;
			}
			p.addLog(
				s,
				'rule',
				`${o.card.name} is goaded by ${goader.username} (${duration === 'endOfTurn' ? 'until end of turn' : 'until their next turn'}).`,
				goader.playerId
			);
		}
	}

	explore(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const entries = this.decodeBatchEntries(`exploreBatch:${this.stepIndex}`, step.subject);

		for (let i = Math.max(0, this.subStepIndex); i < entries.length; i++) {
			const { id: objId, controllerId, initialVersion } = entries[i];
			const controller = this.player(controllerId);
			if (!controller || controller.lost) continue;
			const found = this.locate(objId);
			const stillOnBattlefield = Boolean(
				found &&
					found.zone === 'battlefield' &&
					initialVersion !== 'off' &&
					String(found.inst.objectVersion ?? 0) === initialVersion
			);
			const eventObj = found?.inst ?? this.syntheticLkiObject(objId, controllerId);
			const stageKey = `explore:${this.stepIndex}:${i}:stage`;
			const stageAns = this.answers[stageKey];
			let stage = stageAns?.kind === 'chooseObjects' ? stageAns.objectIds[0] : 'start';
			let revealedId = stageAns?.kind === 'chooseObjects' ? stageAns.objectIds[1] ?? '' : '';

			if (stage === 'start') {
				if (controller.library.length === 0) {
					// CR 701.44b: still explores even with an empty library (no reveal, no counter).
					p.addLog(s, 'rule', `${eventObj.card.name} explored (library is empty).`, controller.playerId);
					emitEvent(s, {
						kind: 'Explored',
						playerId: controller.playerId,
						objectId: objId,
						object: eventObj,
						revealedLand: false
					});
					flushTriggers(s);
					this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['done', ''] };
					continue;
				}
				const top = controller.library[0];
				const isLand = this.matches(top, { types: ['Land'] }, 'library');
				if (isLand) {
					p.addLog(
						s,
						'rule',
						`${controller.username} revealed land ${top.card.name} while ${eventObj.card.name} explored and put it into hand.`,
						controller.playerId
					);
					this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['moving_hand', top.instanceId] };
					const promptsBefore = s.pendingPrompts.length;
					const res = moveObject(s, top, 'hand', {
						from: { player: controller, zone: 'library' },
						toPlayer: controller,
						bumpVersion: true,
						newTimestamp: true
					});
					if (res === 'pending' || s.pendingPrompts.length > promptsBefore) {
						this.pauseForNestedPrompts(s.pendingPrompts.slice(promptsBefore), i);
						return;
					}
					stage = 'moving_hand';
				} else {
					p.addLog(
						s,
						'rule',
						`${controller.username} revealed nonland ${top.card.name} while ${eventObj.card.name} explored.`,
						controller.playerId
					);
					if (stillOnBattlefield && found) {
						p.addCounters(s, found.inst, '+1/+1', 1);
					}
					revealedId = top.instanceId;
					stage = 'revealed_nonland';
					this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['revealed_nonland', revealedId] };
				}
			}

			if (stage === 'moving_hand') {
				emitEvent(s, {
					kind: 'Explored',
					playerId: controller.playerId,
					objectId: objId,
					object: eventObj,
					revealedLand: true
				});
				flushTriggers(s);
				this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['done', ''] };
				continue;
			}

			if (stage === 'revealed_nonland') {
				const revealedInst =
					controller.library[0]?.instanceId === revealedId ? controller.library[0] : undefined;
				const choiceKey = `explore:${this.stepIndex}:${i}:gy`;
				const ans = this.answers[choiceKey];
				let putIntoGraveyard: boolean;
				if (ans?.kind === 'yesNo') {
					putIntoGraveyard = ans.yes;
				} else if (!controller.isBot && this.canPause && revealedInst) {
					this.subStepIndex = i;
					const item = this.saveFrame(this.stepIndex, this.answers, 'step', i);
					const q = `Put revealed nonland card ${revealedInst.card.name} into your graveyard? (No keeps it on top of your library.)`;
					enqueueChoicePrompt(s, {
						id: p.uid('prompt', s),
						kind: 'yesNo',
						purpose: 'generic',
						playerId: controller.playerId,
						title: `${this.ctx.title} — Explore (${eventObj.card.name})`,
						description: q,
						yesLabel: 'Put into graveyard',
						noLabel: 'Keep on top',
						continuation: {
							kind: 'effect_choice',
							stackItemId: item.id,
							stepIndex: this.stepIndex,
							answerKey: choiceKey
						},
						choice: { kind: 'yesNo', question: q }
					});
					this.result.paused = true;
					return;
				} else if (revealedInst) {
					const handLands = controller.hand.filter((c) => this.matches(c, { types: ['Land'] }, 'hand')).length;
					const mv = objectManaValue(s, revealedInst);
					putIntoGraveyard = handLands <= 1 && mv >= 5;
				} else {
					putIntoGraveyard = false;
				}

				if (putIntoGraveyard && revealedInst) {
					this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['moving_gy', revealedId] };
					const promptsBefore = s.pendingPrompts.length;
					const res = moveObject(s, revealedInst, 'graveyard', {
						from: { player: controller, zone: 'library' },
						toPlayer: controller,
						graveyardReplacement: true,
						bumpVersion: true,
						newTimestamp: true
					});
					if (res === 'pending' || s.pendingPrompts.length > promptsBefore) {
						this.pauseForNestedPrompts(s.pendingPrompts.slice(promptsBefore), i);
						return;
					}
					p.addLog(
						s,
						'rule',
						`${controller.username} put ${revealedInst.card.name} into their graveyard.`,
						controller.playerId
					);
				} else if (revealedInst) {
					p.addLog(
						s,
						'rule',
						`${controller.username} left ${revealedInst.card.name} on top of their library.`,
						controller.playerId
					);
				}
				stage = 'moving_gy';
			}

			if (stage === 'moving_gy') {
				emitEvent(s, {
					kind: 'Explored',
					playerId: controller.playerId,
					objectId: objId,
					object: eventObj,
					revealedLand: false
				});
				flushTriggers(s);
				this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['done', ''] };
			}
		}
	}

	connive(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const n = this.amount(step.amount, 1);
		// CR 701.50e: if N <= 0, the permanent doesn't connive at all.
		if (n <= 0) return;

		const entries = this.decodeBatchEntries(`conniveBatch:${this.stepIndex}`, step.subject);

		for (let i = Math.max(0, this.subStepIndex); i < entries.length; i++) {
			const { id: objId, controllerId, initialVersion } = entries[i];
			const controller = this.player(controllerId);
			if (!controller || controller.lost) continue;
			const stageKey = `connive:${this.stepIndex}:${i}:stage`;
			const moveIdxKey = `connive:${this.stepIndex}:${i}:idx`;
			const stageAns = this.answers[stageKey];
			let stage = stageAns?.kind === 'chooseObjects' ? stageAns.objectIds[0] : 'start';
			let nonlandCount = stageAns?.kind === 'chooseObjects' ? Number(stageAns.objectIds[1] ?? '0') : 0;
			let chosenIds = stageAns?.kind === 'chooseObjects' ? stageAns.objectIds.slice(2) : [];

			const found0 = this.locate(objId);
			const eventObj0 = found0?.inst ?? this.syntheticLkiObject(objId, controllerId);

			if (stage === 'start') {
				p.drawCards(s, controller, n);
				p.addLog(
					s,
					'rule',
					`${eventObj0.card.name} connived ${n}: ${controller.username} drew ${n} card(s).`,
					controller.playerId
				);
				stage = 'choose_discard';
				this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['choose_discard', '0'] };
			}

			if (stage === 'choose_discard') {
				const discardCount = Math.min(n, controller.hand.length);
				if (discardCount === 0) {
					nonlandCount = 0;
					chosenIds = [];
					stage = 'finishing';
					this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['finishing', '0'] };
				} else {
					const discKey = `connive:${this.stepIndex}:${i}:disc`;
					const ans = this.answers[discKey];
					let chosen: CardInstance[];
					if (ans?.kind === 'chooseObjects') {
						chosen = this.answered(discKey, controller.hand, discardCount) ?? controller.hand.slice(0, discardCount);
					} else if (!controller.isBot && this.canPause && controller.hand.length > discardCount) {
						this.subStepIndex = i;
						this.pauseForChoice(
							controller,
							`${this.ctx.title} — Connive ${n} (${eventObj0.card.name})`,
							`Choose ${discardCount} card(s) to discard.`,
							controller.hand.map((c) => c.instanceId),
							discardCount,
							discardCount,
							'hand',
							undefined,
							discKey
						);
						return;
					} else {
						chosen = controller.hand.slice(0, discardCount);
					}
					nonlandCount = chosen.filter((c) => !this.matches(c, { types: ['Land'] }, 'hand')).length;
					chosenIds = chosen.map((c) => c.instanceId);
					stage = 'moving_discard';
					this.answers[stageKey] = {
						kind: 'chooseObjects',
						objectIds: ['moving_discard', String(nonlandCount), ...chosenIds]
					};
					this.answers[moveIdxKey] = { kind: 'chooseNumber', n: 0 };
				}
			}

			if (stage === 'moving_discard') {
				const startK = this.answers[moveIdxKey]?.kind === 'chooseNumber' ? this.answers[moveIdxKey].n : 0;
				for (let k = startK; k < chosenIds.length; k++) {
					this.answers[moveIdxKey] = { kind: 'chooseNumber', n: k + 1 };
					const cardInst = controller.hand.find((c) => c.instanceId === chosenIds[k]);
					if (!cardInst) continue;
					const promptsBefore = s.pendingPrompts.length;
					const res = moveObject(s, cardInst, 'graveyard', {
						from: { player: controller, zone: 'hand' },
						toPlayer: controller,
						graveyardReplacement: true,
						bumpVersion: true,
						newTimestamp: true,
						discardReason: 'discard',
						discardPlayerId: controller.playerId
					});
					if (res === 'pending' || s.pendingPrompts.length > promptsBefore) {
						this.pauseForNestedPrompts(s.pendingPrompts.slice(promptsBefore), i);
						return;
					}
					p.addLog(s, 'rule', `${controller.username} discarded ${cardInst.card.name}.`, controller.playerId);
				}
				stage = 'finishing';
				this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['finishing', String(nonlandCount)] };
			}

			if (stage === 'finishing') {
				const found = this.locate(objId);
				const stillOnBattlefield = Boolean(
					found &&
						found.zone === 'battlefield' &&
						initialVersion !== 'off' &&
						String(found.inst.objectVersion ?? 0) === initialVersion
				);
				const eventObj = found?.inst ?? eventObj0;
				if (nonlandCount > 0 && stillOnBattlefield && found) {
					p.addCounters(s, found.inst, '+1/+1', nonlandCount);
				}
				p.addLog(
					s,
					'rule',
					`${eventObj.card.name} finished conniving (${nonlandCount} nonland discarded).`,
					controller.playerId
				);
				emitEvent(s, {
					kind: 'Connived',
					playerId: controller.playerId,
					objectId: objId,
					object: eventObj,
					nonlandDiscardedCount: nonlandCount
				});
				flushTriggers(s);
				this.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['done', String(nonlandCount)] };
			}
		}
	}
}

function compare(a: number, op: '>=' | '<=' | '=' | '>' | '<', b: number): boolean {
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
const BASIC_LAND_COLORS: Array<[string, ManaColor]> = [
	['Plains', 'W'],
	['Island', 'U'],
	['Swamp', 'B'],
	['Mountain', 'R'],
	['Forest', 'G']
];

function commanderColors(player: PlayerGameState): ManaColor[] {
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

function playerLandColors(
	state: GameState,
	player: PlayerGameState
): { direct: Set<ManaColor>; hasOrchard: boolean } {
	const direct = new Set<ManaColor>();
	let hasOrchard = false;
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		if (!ev.typeLine.includes('Land')) continue;
		for (const [sub, col] of BASIC_LAND_COLORS) {
			if (ev.hasSubType(sub) || ev.typeLine.includes(sub)) direct.add(col);
		}
		const bd = inspectCardContinuousBreakdown(perm, state);
		if (bd.items.some((i) => !i.removed && i.canonicalKey === 'mana_any')) {
			for (const c of FIVE_COLORS) direct.add(c);
		}
		if (ev.losesAllAbilities) continue;
		for (const step of cardManaSteps(perm.card)) {
			const mana = step.params?.mana;
			if (mana) {
				for (const c of mana) if (c !== 'C') direct.add(c);
			}
			if (step.params?.manaWithChosenColor) {
				for (const c of step.params.manaWithChosenColor) if (c !== 'C') direct.add(c);
				if (perm.chosenColor && perm.chosenColor !== 'C') direct.add(perm.chosenColor);
			}
			if (step.params?.manaBundles) {
				for (const b of step.params.manaBundles) {
					for (const c of b) if (c !== 'C') direct.add(c);
				}
			}
			if (step.params?.manaCombinationColors) {
				const combCols =
					step.params.manaCombinationColors === 'any'
						? FIVE_COLORS
						: step.params.manaCombinationColors;
				for (const c of combCols) if (c !== 'C') direct.add(c);
			}
			const choice = step.params?.manaChoice;
			if (!choice) continue;
			if (Array.isArray(choice)) {
				for (const c of choice) if (c !== 'C') direct.add(c);
			} else if (choice === 'any') {
				for (const c of FIVE_COLORS) direct.add(c);
			} else if (choice === 'commanderIdentity') {
				for (const c of commanderColors(player)) direct.add(c);
			} else if (choice === 'chosenColor') {
				if (perm.chosenColor && perm.chosenColor !== 'C') direct.add(perm.chosenColor);
			} else if (choice === 'opponentLandColors') {
				hasOrchard = true;
			}
		}
	}
	return { direct, hasOrchard };
}

/**
 * CR 106.7: colours (`W | U | B | R | G`, never `C`) that any land an opponent of `controller`
 * controls could produce right now, accounting for continuous effects and opponent Exotic Orchards.
 */
export function opponentLandColors(state: GameState, controller: PlayerGameState): ManaColor[] {
	const active = state.players.filter((p) => !p.lost);
	const byPlayer = new Map(active.map((p) => [p.playerId, playerLandColors(state, p)]));
	const out = new Set<ManaColor>();
	for (const opp of active) {
		if (opp.playerId === controller.playerId) continue;
		const info = byPlayer.get(opp.playerId)!;
		for (const c of info.direct) out.add(c);
		if (info.hasOrchard) {
			for (const other of active) {
				if (other.playerId === opp.playerId) continue;
				for (const c of byPlayer.get(other.playerId)!.direct) out.add(c);
			}
		}
	}
	return FIVE_COLORS.filter((c) => out.has(c));
}

export function manaChoiceColors(
	state: GameState,
	controller: PlayerGameState,
	choice: NonNullable<NonNullable<EffectStep['params']>['manaChoice']>,
	chosenColor?: ManaColor
): ManaColor[] {
	if (Array.isArray(choice)) return choice;
	if (choice === 'any') return [...FIVE_COLORS];
	if (choice === 'commanderIdentity') {
		return commanderColors(controller);
	}
	if (choice === 'chosenColor') {
		return chosenColor ? [chosenColor] : [];
	}
	return opponentLandColors(state, controller);
}

/**
 * Runs `steps` in order against `state`. With `resume` (a stack item's `effectResume`), continues a
 * paused resolution at the step that asked for a choice, with the stored bindings and answers.
 */
export function executeEffectSteps(state: GameState, ctx: EffectContext, steps: EffectStep[], resume?: EffectResumeFrame): EffectResult {
	const run = new Run(state, ctx, resume);
	run.run(steps);
	return run.result;
}
