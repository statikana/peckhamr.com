/**
 * Effect interpreter (ENGINE_ARCHITECTURE_PLAN.md section 2.1 and Phase 3).
 *
 * Thin Run orchestration class, complex zone/exile/move/dig/goad/explore/connive step methods,
 * executeEffectSteps entry point, and barrel re-exports preserving 100% of public symbols.
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
import { effectiveCardForObject, getCardFaces } from '../scryfall.ts';
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
	hasRestriction,
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

import {
	applyLifelinkGain,
	dealDamageToPermanent,
	dealDamageToPlayer,
	effectPorts,
	gainPlayerLife,
	permanentProtectedFromSource,
	sourceDamageInfo,
	type Bindings,
	type Bound,
	type EffectContext,
	type EffectResult,
	type EffectRunAccess,
	type Snapshot,
	type SourceDamageInfo
} from './effectsDamageAndMana.ts';
import {
	evaluateEffectAmount,
	evaluateEffectCondition,
	runActiveTargetSpecs,
	runApnapPlayers,
	runKickerInfo,
	runMatches,
	runObjects,
	runPlayerRef,
	runPlayers,
	runRefId,
	runRefSnapshot,
	runTargetsForSpecIndex,
	sourceChosenColor,
	sourceChosenSubType
} from './effectsConditionsAndAmounts.ts';
import {
	executeCastNameLockStep,
	executeDamageStep,
	executeDelayedStep,
	executeDiscardHandStep,
	executeFightStep,
	executePreventDamageStep,
	executeRunStep
} from './effectsSteps.ts';
import { executeDigWave9, exileStackTargetsWave9 } from './effectsWave9.ts';

export {
	INTERPRETED_VERBS,
	optionalPrefix,
	withoutOptional
} from '../compiler/interpretable.ts';
export { staticallyInterpretableP15 } from './framesBattlesAndKeywordsWave5.ts';
export { staticallyInterpretableP18b as staticallyInterpretable } from './framesModalsWave6.ts';
export {
	applyLifelinkGain,
	countDevotion,
	dealDamageToPermanent,
	dealDamageToPlayer,
	devotion,
	gainPlayerLife,
	interpretableNow,
	manaChoiceColors,
	nextRandom,
	opponentLandColors,
	permanentProtectedFromSource,
	proliferateCandidates,
	registerEffectPorts,
	sourceDamageInfo,
	type EffectContext,
	type EffectPorts,
	type EffectResult,
	type PayOptionalCostResult,
	type SourceDamageInfo,
	type StackItemRetargetSlot
} from './effectsDamageAndMana.ts';

class Run implements EffectRunAccess {
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
	// --- Track P16a ---
	lastCountersRemoved?: number;
	private prevStepDiedIds = new Set<string>();
	// --- End Track P16a ---
	// --- Track P19a ---
	lastCountedByKind?: Record<string, number>;
	// --- End Track P19a ---
	lastInlineStepDecision?: boolean;
	lastExtraCombatSlotId?: string;
	currentSteps: EffectStep[] = [];
	subPathPrefix?: number[];
	stepActedIds: string[] = [];
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
		// --- Track P16a ---
		this.lastCountersRemoved = ctx.item.lastCountersRemoved;
		// --- End Track P16a ---
		// --- Track P19a ---
		const rawCounted = resume?.lastCountedByKind ?? ctx.item.lastCountedByKind;
		if (rawCounted) this.lastCountedByKind = { ...rawCounted };
		if (!resume && !ctx.item.targetWasControlledByActor && ctx.targets.length > 0) {
			const snapCtrl: Record<number, boolean> = {};
			for (let ti = 0; ti < ctx.targets.length; ti++) {
				const t = ctx.targets[ti];
				if (t.kind === 'permanent') {
					const f = this.locate(t.id);
					if (f && f.zone === 'battlefield') {
						snapCtrl[ti] = f.inst.controllerId === ctx.controller.playerId;
					}
				}
			}
			ctx.item.targetWasControlledByActor = snapCtrl;
		}
		// --- End Track P19a ---
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
			// --- Track P22d ---
			for (const [name, bound] of resume.bindings)
				this.bindings.set(
					name,
					bound.map((b) => ({
						id: b.id,
						lki: { ...b.lki },
						...(b.counteredStackLki ? { counteredStackLki: b.counteredStackLki } : {})
					}))
				);
			// --- End Track P22d ---
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
			// --- Track P22d ---
			for (const [name, bound] of Object.entries(ctx.initialBindings)) {
				this.bindings.set(
					name,
					bound.map((b) => ({
						id: b.id,
						lki: { ...b.lki },
						...(b.counteredStackLki ? { counteredStackLki: b.counteredStackLki } : {})
					}))
				);
			}
			// --- End Track P22d ---
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
			id: effectPorts().uid('prompt', this.state),
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
			id: effectPorts().uid('prompt', this.state),
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
			id: effectPorts().uid('prompt', this.state),
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
			id: effectPorts().uid('prompt', this.state),
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
			id: effectPorts().uid('prompt', this.state),
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
			const payoffSteps = this.currentSteps.filter((st) => st.ifPrecedingAccepted === this.stepIndex);
			const hasOwnPayoff =
				chooser.playerId === this.you.playerId
					? Boolean(step.params?.reflexiveTrigger) || payoffSteps.length > 0
					: payoffSteps.some((st) => st.actor && this.playerRef(st.actor)?.playerId === chooser.playerId);
			if (!hasOwnPayoff) return false;
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
		if (step.verb === 'exert') {
			return this.objects(sel).some(
				(o) =>
					o.zone === 'battlefield' &&
					!o.phasedOut &&
					(sel.k !== 'self' ||
						this.ctx.item.sourceObjectVersion === undefined ||
						(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
			);
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
		const res = effectPorts().payOptionalCost(
			this.state,
			chooser,
			this.ctx.item,
			this.stepIndex,
			cost,
			this.answers,
			this.pendingOptionalCost
		);
		// --- Track P19a: Support `choice` ("pays {B} or {3}") optional cost prompt ---
		if (res.status === 'needOptionChoice') {
			if (!this.canPause) {
				this.pendingOptionalCost = undefined;
				this.stepDecisions[this.stepIndex] = false;
				return executeIfPaid(false);
			}
			const item = this.saveFrame(this.stepIndex, this.answers, 'optional', this.subStepIndex);
			enqueueChoicePrompt(this.state, {
				id: effectPorts().uid('prompt', this.state),
				kind: 'chooseMode',
				playerId: chooser.playerId,
				title: `${this.ctx.title} — Choose Cost Option`,
				description: `Choose how to pay (${res.labels.join(' or ')}).`,
				continuation: {
					kind: 'effect_choice',
					stackItemId: item.id,
					stepIndex: this.stepIndex,
					answerKey: res.answerKey
				},
				choice: {
					kind: 'chooseMode',
					modes: res.labels,
					min: 1,
					max: 1,
					defaultIndices: [0]
				}
			});
			this.result.paused = true;
			return false;
		}
		// --- End Track P19a ---
		if (res.status === 'needChoice') {
			if (!this.canPause) {
				this.pendingOptionalCost = undefined;
				this.stepDecisions[this.stepIndex] = false;
				return executeIfPaid(false);
			}
			// --- Track P22d ---
			const maxChoice = res.maxCount ?? res.count;
			const countLabel =
				maxChoice > res.count ? `${res.count} to ${maxChoice}` : `${res.count}`;
			this.pauseForChoice(
				chooser,
				`${this.ctx.title} — Pay Optional Cost`,
				`Choose ${countLabel}: ${res.label}.`,
				res.candidateIds,
				res.count,
				maxChoice,
				res.zone,
				undefined,
				res.answerKey,
				'optional'
			);
			// --- End Track P22d ---
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
			effectPorts().addLog(
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
				effectPorts().addLog(
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
				effectPorts().addLog(
					this.state,
					this.ctx.item.kind === 'triggered' ? 'trigger' : 'rule',
					`${chooser.username} chose to use ${this.ctx.title}'s optional effect.`,
					chooser.playerId
				);
				return executeIfPaid(true);
			}
			return this.executeOptionalCostPayment(chooser, cost!, executeIfPaid);
		}

		if (hasCost && !effectPorts().canPayOptionalCost(this.state, chooser, this.ctx.item, cost!)) {
			this.stepDecisions[this.stepIndex] = false;
			effectPorts().addLog(
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
				effectPorts().addLog(
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
				effectPorts().addLog(
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
			// --- Track P22d ---
			bindings: [...this.bindings.entries()].map(([name, bound]) => [
				name,
				bound.map((b) => ({
					id: b.id,
					lki: { ...b.lki },
					...(b.counteredStackLki ? { counteredStackLki: b.counteredStackLki } : {})
				}))
			]),
			// --- End Track P22d ---
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
			...(this.lastEffectAmount !== undefined ? { lastEffectAmount: this.lastEffectAmount } : {}),
			// --- End Track P13 ---
			// --- Track P19a ---
			...(this.lastCountedByKind
				? { lastCountedByKind: { ...this.lastCountedByKind } }
				: {})
			// --- End Track P19a ---
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

	pauseForNestedPrompts(queued: PendingPrompt[], nextSubStepIndex: number): void {
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
			power: onBattlefield ? effectPorts().power(this.state, inst) : parseInt(inst.card.power ?? '0', 10) || 0,
			toughness: onBattlefield ? effectPorts().toughness(this.state, inst) : parseInt(inst.card.toughness ?? '0', 10) || 0,
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

	amount(a: Amount | undefined, fallback = 0): number {
		return evaluateEffectAmount(this, a, fallback);
	}
	refSnapshot(ref: Ref, lki: boolean): Snapshot | null {
		return runRefSnapshot(this, ref, lki);
	}
	kickerInfo(): KickerTrackingInfo {
		return runKickerInfo(this);
	}
	activeTargetSpecs(): Array<{ spec: TargetSpec; specIndex: number }> {
		return runActiveTargetSpecs(this);
	}
	targetsForSpecIndex(specIndex: number): TargetRef[] {
		return runTargetsForSpecIndex(this, specIndex);
	}
	refId(ref: Ref): string | null {
		return runRefId(this, ref);
	}
	playerRef(ref: PlayerRef): PlayerGameState | null {
		return runPlayerRef(this, ref);
	}
	apnapPlayers(): PlayerGameState[] {
		return runApnapPlayers(this);
	}
	players(sel: Selector): PlayerGameState[] {
		return runPlayers(this, sel);
	}
	objects(sel: Selector): CardInstance[] {
		return runObjects(this, sel);
	}
	matches(c: CardInstance, f: ObjectFilter, zone: 'battlefield' | 'graveyard' | 'hand' | 'library' | 'exile'): boolean {
		return runMatches(this, c, f, zone);
	}
	sourceChosenSubType(): string | undefined {
		return sourceChosenSubType(this);
	}
	sourceChosenColor(): ManaColor | undefined {
		return sourceChosenColor(this);
	}
	condition(c: Condition): boolean {
		return evaluateEffectCondition(this, c);
	}
	step(step: EffectStep): void {
		executeRunStep(this, step);
	}
	castNameLock(step: EffectStep): void {
		executeCastNameLockStep(this, step);
	}
	preventDamageStep(step: EffectStep): void {
		executePreventDamageStep(this, step);
	}
	discardHandStep(step: EffectStep): void {
		executeDiscardHandStep(this, step);
	}
	damage(step: EffectStep): void {
		executeDamageStep(this, step);
	}
	fight(step: EffectStep): void {
		executeFightStep(this, step);
	}
	delayed(step: EffectStep): void {
		executeDelayedStep(this, step);
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
	captureTriggerEventLki(inst: CardInstance): TriggerEventLki {
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
		// --- Track P16a ---
		if (this.stepDiedIds.size > 0) {
			this.prevStepDiedIds = new Set(this.stepDiedIds);
		}
		// --- End Track P16a ---
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

	recordStepActedObject(
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
			this.lastInlineStepDecision = undefined;
			const step = steps[this.stepIndex];
			// --- Track P16a (CR 603.2h: "Do this only once each turn") ---
			const onceAbilityTag = `${this.ctx.item.triggeredAbilityIndex ?? this.ctx.item.abilityId ?? this.ctx.title}:${this.stepIndex}`;
			const doOnceKey = step.doThisOncePerTurn
				? buildDoOnceThisTurnKey(
						this.ctx.sourceId,
						this.ctx.item.sourceObjectVersion,
						onceAbilityTag
					)
				: null;
			if (
				doOnceKey &&
				this.phase === 'optional' &&
				Object.keys(this.answers).length === 0 &&
				!canDoOnceThisTurn(this.state, doOnceKey)
			) {
				this.stepDecisions[this.stepIndex] = false;
				this.subStepIndex = 0;
				this.phase = 'optional';
				this.answers = {};
				continue;
			}
			// --- End Track P16a ---
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
				// --- Track P16a ---
				if (step.optional) this.stepDecisions[this.stepIndex] = false;
				// --- End Track P16a ---
				this.subStepIndex = 0;
				this.phase = 'optional';
				this.answers = {};
				continue;
			}
			// --- Track P16b: CR 603.2h "Do this only once each turn" gate ---
			const isOnceStep =
				Boolean(step.doThisOncePerTurn) ||
				(this.stepIndex === 0 && isStackItemTriggerDoThisOnce(this.ctx.item, this.ctx.sourceCard));
			const onceKey = isOnceStep
				? doThisOnceKey(
						this.ctx.item.sourceInstanceId,
						this.ctx.item.sourceObjectVersion,
						this.ctx.item.faceIndex,
						this.ctx.item.triggeredAbilityIndex
					)
				: '';
			if (isOnceStep && this.phase !== 'afterStep' && isDoThisOnceTakenThisTurn(this.state, onceKey)) {
				this.stepDecisions[this.stepIndex] = false;
				this.subStepIndex = 0;
				this.phase = 'optional';
				this.answers = {};
				continue;
			}
			// --- End Track P16b ---
			// --- Track P19a: Dynamic generic mana "unless ... pays {X}" ---
			const effectiveStep: EffectStep =
				!step.optional && step.params?.unlessPaysGenericAmount
					? (() => {
							const dynN = Math.max(0, this.amount(step.params.unlessPaysGenericAmount, 0));
							const chooser: NonNullable<EffectStep['optional']>['chooser'] =
								step.subject.k === 'eventObject'
									? { k: 'controllerOf', of: { k: 'eventObject' } }
									: step.subject.k === 'target'
										? this.targetsForSpecIndex(step.subject.index)[0]?.kind === 'player'
											? { k: 'target', index: step.subject.index }
											: { k: 'controllerOf', of: { k: 'target', index: step.subject.index } }
										: step.subject.k === 'playerRef'
											? step.subject.ref
											: (step.actor ?? { k: 'controllerOf', of: { k: 'target', index: 0 } });
							return {
								...step,
								optional: {
									chooser,
									cost: [{ k: 'mana', cost: `{${dynN}}` }],
									mode: 'doUnlessPaid'
								}
							};
						})()
					: step;
			// --- End Track P19a ---
			if (effectiveStep.optional && this.phase !== 'afterStep') {
				const accepted = this.resolveOptional(effectiveStep);
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
						// --- Track P10 + Track P16b ---
						const hasReflexive = Boolean(step.params?.reflexiveTrigger) || isOnceStep;
						const resumeIdx = hasReflexive ? this.stepIndex : this.stepIndex + 1;
						const resumePhase = hasReflexive ? 'afterStep' : 'optional';
						const resumeAnswers = hasReflexive ? this.answers : {};
						const item = this.saveFrame(resumeIdx, resumeAnswers, resumePhase, 0);
						this.linkPromptsToStackStep(queued, resumeIdx);
						// --- End Track P10 + Track P16b ---
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
			// --- Track P16b ---
			if (isOnceStep && this.stepDecisions[this.stepIndex] !== false) {
				markDoThisOnceTakenThisTurn(this.state, onceKey);
			}
			// --- End Track P16b ---
			// --- Track P10 ---
			this.finishStepReflexive(step);
			// --- End Track P10 ---
			// --- Track P16a ---
			if (doOnceKey && this.stepDecisions[this.stepIndex] !== false) {
				markDoneOnceThisTurn(this.state, doOnceKey);
			}
			if (this.stepDiedIds.size > 0) {
				this.stepDecisions[-1000 - this.stepIndex] = true;
			}
			// --- End Track P16a ---
			this.subStepIndex = 0;
			this.phase = 'optional';
			this.answers = {};
		}
	}
	sourceDamageInfo(
		sourcePerm: CardInstance | null,
		sourceCard: ScryfallCard
	): SourceDamageInfo {
		const base = sourceDamageInfo(this.state, sourcePerm, sourceCard);
		// --- Track P20a (CR 702.15d, 702.2): Spell damage keywords granted on the stack ---
		if ((!sourcePerm || sourcePerm.zone !== 'battlefield') && this.ctx.item?.kind === 'spell') {
			const granted = getGrantedSpellDamageKeywordsForStackItem(this.state, this.ctx.item);
			return {
				...base,
				hasLifelink: base.hasLifelink || granted.hasLifelink,
				hasDeathtouch: base.hasDeathtouch || granted.hasDeathtouch,
				hasWither: base.hasWither || granted.hasWither,
				hasInfect: base.hasInfect || granted.hasInfect,
				sourceControllerId: base.sourceControllerId ?? this.ctx.item.controllerId
			};
		}
		// --- End Track P20a ---
		return base;
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
	sacrifice(step: EffectStep): void {
		const s = this.state;
		const p = effectPorts();
		const you = this.you;
		const sel = step.subject;
		const batchKey = `batch:${this.stepIndex}`;

		// --- Track P10 ---
		const isExploit = isExploitTriggerStackItem(this.ctx.item);
		const sacrificePermanent = (actor: PlayerGameState, perm: CardInstance): MoveResult => {
			const wasNonland = !evaluatePermanent(s, perm).isLand;
			const preSnap = this.captureTriggerEventLki(perm);
			const exploitedLki = isExploit ? captureLki(s, perm) : undefined;
			const res = p.moveFromBattlefield(s, perm, 'graveyard', {
				sacrificedByPlayerId: actor.playerId
			});
			p.addLog(s, 'rule', `${actor.username} sacrificed ${perm.card.name}.`, actor.playerId);
			if (perm.zone !== 'battlefield') {
				if (wasNonland) {
					const nextCount = (this.lastCountedByKind?.sacrificedNonlandThisWay ?? 0) + 1;
					const nextMap = { ...(this.lastCountedByKind ?? {}), sacrificedNonlandThisWay: nextCount };
					this.lastCountedByKind = nextMap;
					this.ctx.item.lastCountedByKind = { ...nextMap };
				}
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
			// --- Track P22a ---
			if (playerImmuneToOpponentForcedSacrificeWave8(s, actor.playerId, you.playerId)) {
				this.bind(step, []);
				this.stepDecisions[this.stepIndex] = false;
				return;
			}
			// --- End Track P22a ---
			this.runIndexedBatch(
				batchKey,
				() => {
					const objs = this.objects(sel).filter(
						(o) =>
							o.zone === 'battlefield' &&
							o.controllerId === actor.playerId &&
							!hasRestriction(s, o, 'cantBeSacrificed') &&
							(sel.k !== 'self' ||
								this.ctx.item.sourceObjectVersion === undefined ||
								(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion)
					);
					this.bind(step, objs);
					// --- Track P16a ---
					this.stepDecisions[this.stepIndex] = objs.length > 0;
					// --- End Track P16a ---
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

			const isAnyNumber = step.amount?.k === 'anyNumber';
			const choices: Array<{ actor: PlayerGameState; candidates: CardInstance[]; count: number; minPick: number }> = [];
			for (const actor of actors) {
				// --- Track P22a ---
				if (playerImmuneToOpponentForcedSacrificeWave8(s, actor.playerId, you.playerId)) {
					continue;
				}
				// --- End Track P22a ---
				const candidates = actor.battlefield.filter(
					(c) =>
						!c.phasedOut &&
						c.controllerId === actor.playerId &&
						!hasRestriction(s, c, 'cantBeSacrificed') &&
						this.matches(c, filter, 'battlefield')
				);
				if (candidates.length === 0) continue;
				const count = isAnyNumber
					? candidates.length
					: sel.k === 'all' && !step.amount
						? candidates.length
						: Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
				if (count <= 0) continue;
				const minPick = isAnyNumber ? 0 : count;
				choices.push({ actor, candidates, count, minPick });
			}
			const atRandom = Boolean((step.params as { atRandom?: boolean } | undefined)?.atRandom);
			if (!atRandom && this.canPause) {
				for (const { actor, candidates, count, minPick } of choices) {
					const actorKey = `actor:${this.stepIndex}:${actor.playerId}`;
					if (
						actor.isBot ||
						(!isAnyNumber && candidates.length <= count) ||
						this.answers[actorKey] ||
						this.answers[actor.playerId]
					) {
						continue;
					}
					const title = isAnyNumber
						? `${this.ctx.title} — Sacrifice any number`
						: `${this.ctx.title} — Sacrifice ${count} permanent(s)`;
					// --- Track P7 ---
					const defaultIds = candidates.slice(0, minPick).map((c) => c.instanceId);
					this.pauseForChoice(
						actor,
						title,
						isAnyNumber ? `Choose any number of permanents to sacrifice.` : `Choose ${count} permanent(s) to sacrifice.`,
						candidates.map((c) => c.instanceId),
						minPick,
						count,
						'battlefield',
						defaultIds,
						actorKey
					);
					// --- End Track P7 ---
					return;
				}
			}
			const sacrificed: CardInstance[] = [];
			for (const { actor, candidates, count, minPick } of choices) {
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
					chosen =
						this.answered(actorKey, candidates, minPick, count) ??
						this.answered(actor, candidates, minPick, count) ??
						candidates.slice(0, minPick);
				}
				sacrificed.push(...chosen);
			}
			this.bind(step, sacrificed);
			// --- Track P16a ---
			this.stepDecisions[this.stepIndex] = sacrificed.length > 0;
			// --- End Track P16a ---
			// --- Track P19a ---
			this.recordCountedKind('sacrificedThisWay', sacrificed.length);
			// --- End Track P19a ---
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
		const p = effectPorts();
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
					const objs = this.objects(sel).filter(
						(o) =>
							o.zone === 'hand' &&
							// --- Track P22a ---
							!playerImmuneToOpponentForcedDiscardWave8(s, o.ownerId, you.playerId)
							// --- End Track P22a ---
					);
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
				// --- Track P22a ---
				if (playerImmuneToOpponentForcedDiscardWave8(s, pl.playerId, you.playerId)) {
					continue;
				}
				// --- End Track P22a ---
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
			// --- Track P16a: Support `upTo` discard ("Discard up to N cards") ---
			const upToDiscard = Boolean(step.params?.upTo) && !atRandom;
			if (!atRandom && this.canPause) {
				for (const { pl, candidates, count } of choices) {
					const actorKey = `actor:${this.stepIndex}:${pl.playerId}`;
					const minPick = upToDiscard ? 0 : count;
					if (
						pl.isBot ||
						(!upToDiscard && candidates.length <= count) ||
						this.answers[actorKey] ||
						this.answers[pl.playerId]
					) {
						continue;
					}
					const label = upToDiscard ? `up to ${count}` : `${count}`;
					const title = `${this.ctx.title} — Discard ${label} card(s)`;
					this.pauseForChoice(pl, title, `Choose ${label} card(s) to discard.`, candidates.map((c) => c.instanceId), minPick, count, 'hand', undefined, actorKey);
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
					const minPick = upToDiscard ? 0 : count;
					chosen =
						this.answered(actorKey, candidates, minPick, count) ??
						this.answered(pl, candidates, minPick, count) ??
						candidates.slice(0, count);
				}
				discarded.push({ pl, cards: chosen });
			}
			const flatCards = discarded.flatMap((x) => x.cards);
			this.stepDecisions[this.stepIndex] = flatCards.length > 0;
			// --- End Track P16a ---
			// --- Track P19a ---
			this.recordCountedKind('discardedThisWay', flatCards.length);
			this.recordEffectAmount(flatCards.length);
			// --- End Track P19a ---
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
		// --- Track P19a: Extended reveal-and-discard / exile modes ---
		if (executeP19aExtendedRevealAndDiscard(this.p19aHost(), step)) {
			return;
		}
		// --- End Track P19a ---
		const s = this.state;
		const p = effectPorts();
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
		const p = effectPorts();
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
			// --- Track P16a: Exile with counters (e.g. time / silver / page counters) ---
			if (step.params?.exileWithCounters && step.params.exileWithCounters.count > 0) {
				const { counter, count: cCount } = step.params.exileWithCounters;
				inst.counters[counter] = (inst.counters[counter] ?? 0) + cCount;
			}
			// --- End Track P16a ---
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
			// --- Track P16a ---
			if (step.params?.exileWithCounters && step.params.exileWithCounters.count > 0) {
				this.result.exileSelfWithCounters = { ...step.params.exileWithCounters };
			}
			// --- End Track P16a ---
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
				// --- Track P19a ---
				this.recordCountedKind('exiledFromHand', pickedAll.length);
				this.recordCountedKind('exiledThisWay', pickedAll.length);
				// --- End Track P19a ---
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
		if (sel.k === 'all' && sel.filter.zone === 'graveyard' && !step.params?.choiceCount) {
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
		// --- Track P16a: Non-targeted choice exile (battlefield or graveyard) ---
		const exileBatchKey = `batch:${this.stepIndex}`;
		if (step.params?.choiceCount && !this.answers[exileBatchKey]) {
			const rawCands = this.objects(sel);
			const cands = step.params.moveFilter
				? rawCands.filter((o) =>
						this.matches(
							o,
							step.params!.moveFilter!,
							o.zone as 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile'
						)
					)
				: rawCands;
			const want = Math.max(0, this.amount(step.params.choiceCount, 1));
			const maxPick = Math.min(cands.length, want);
			const minPick = step.params.upTo ? 0 : maxPick;
			if (maxPick <= 0) {
				if (step.params.upTo) this.stepDecisions[this.stepIndex] = false;
				this.bind(step, []);
				return;
			}
			const chooser = (step.actor ? this.playerRef(step.actor) : null) ?? you;
			const chooseKey = `p16_exile_pick:${this.stepIndex}`;
			let chosen: CardInstance[];
			if (this.answers[chooseKey]?.kind === 'chooseObjects') {
				chosen = this.answered(chooseKey, cands, minPick, maxPick) ?? cands.slice(0, maxPick);
			} else if (!chooser.isBot && this.canPause && (minPick < maxPick || cands.length > maxPick)) {
				const rawZone = sel.k === 'all' && sel.filter.zone ? sel.filter.zone : undefined;
				const z: ZoneType = Array.isArray(rawZone)
					? (rawZone[0] ?? 'battlefield')
					: (rawZone ?? cands[0]?.zone ?? 'battlefield');
				this.pauseForChoice(
					chooser,
					`${this.ctx.title} — Choose card(s) to exile`,
					`Choose ${minPick === maxPick ? maxPick : `up to ${maxPick}`} card(s) to exile.`,
					cands.map((c) => c.instanceId),
					minPick,
					maxPick,
					z,
					cands.slice(0, maxPick).map((c) => c.instanceId),
					chooseKey
				);
				return;
			} else {
				chosen = cands.slice(0, maxPick);
			}
			if (step.params.upTo) {
				this.stepDecisions[this.stepIndex] = chosen.length > 0;
			}
			this.bind(step, chosen);
			this.answers[exileBatchKey] = {
				kind: 'chooseObjects',
				objectIds: chosen.map((c) => c.instanceId)
			};
		}
		// --- End Track P16a ---
		// --- Track P10 ---
		if (exileStackTargetsWave9(this, step, stampExiledMetadata)) {
			return;
		}
		const gyLeftGeneral = new Map<string, CardInstance[]>();
		// --- End Track P10 ---
		this.runIndexedBatch(
			`batch:${this.stepIndex}`,
			() => {
				const objs = this.objects(sel).filter(
					(o) =>
						sel.k !== 'self' ||
						this.ctx.item.sourceObjectVersion === undefined ||
						(o.objectVersion ?? 1) === this.ctx.item.sourceObjectVersion
				);
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
		// --- Track P19a ---
		this.recordCountedKind('exiledThisWay', this.stepActedIds.length);
		// --- End Track P19a ---
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
					id: effectPorts().uid('prompt', this.state),
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
		const p = effectPorts();
		const you = this.you;
		const params = step.params ?? {};
		const batchKey = `batch:${this.stepIndex}`;
		const rawPos = params.position ?? 'top';
		const rawFromTop = params.fromTop;
		const choiceBy = params.libraryChoiceBy ?? 'controller';

		if (params.to === 'library' && step.subject.k === 'self' && this.ctx.item.kind === 'spell') {
			// --- Track P16a: "Shuffle ~ into its owner's library" on a resolving spell ---
			if (params.mayShuffle) {
				this.result.librarySelf = { position: 'top', shuffle: true };
				return;
			}
			// --- End Track P16a ---
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
						if (
							!resolveObjectFaces(
								effectiveCardForObject(o),
								instanceFaceOptions(o, 'battlefield')
							).subtypes.includes('Aura')
						) {
							continue;
						}
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
					const isAura = resolveObjectFaces(
						effectiveCardForObject(o),
						instanceFaceOptions(o, 'battlefield')
					).subtypes.includes('Aura');
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
					if (this.ctx.item.kind === 'triggered' && this.ctx.item.triggeredAbilityIndex !== undefined) {
						o.putOntoBattlefieldByAbilityKey = `${this.ctx.sourceId}:${this.ctx.item.sourceObjectVersion ?? 1}:${this.ctx.item.triggeredAbilityIndex}`;
					}
					const res = moveObject(s, o, 'battlefield', {
						from: { player: you, zone: 'hand' },
						toPlayer: you,
						controllerId: you.playerId,
						bumpVersion: true,
						// --- Track P16a ---
						...(params.withCounters ? { withCounters: params.withCounters } : {})
						// --- End Track P16a ---
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
				// --- Track P16a (CR 701.20d): Even if zone was empty, affected players still shuffle ---
				if (shuffledOwners.size === 0 && step.subject.k === 'all') {
					const fallbackShufflers: PlayerGameState[] = step.actor
						? this.players({ k: 'playerRef', ref: step.actor })
						: step.subject.filter.owner === 'you' || step.subject.filter.controller === 'you'
							? [you]
							: step.subject.filter.owner === 'opponent' ||
								  step.subject.filter.controller === 'opponent'
								? this.players({ k: 'player', filter: { relation: 'each_opponent' } })
								: this.apnapPlayers();
					for (const shufPl of fallbackShufflers) {
						if (shufPl.lost || shuffledOwners.has(shufPl.playerId)) continue;
						shuffledOwners.add(shufPl.playerId);
						shuffleLibrary(s, shufPl);
						p.addLog(
							s,
							'rule',
							`${shufPl.username} shuffled their library (${this.ctx.title}).`,
							shufPl.playerId
						);
					}
				}
				// --- End Track P16a ---
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
			// --- Track P16a: Allow moving bound revealed/looked-at libraryTop cards to library top/bottom ---
			const allowedLibZones: ReadonlyArray<'battlefield' | 'graveyard' | 'exile' | 'library'> =
				params.from === 'battlefield'
					? ['battlefield']
					: params.from === 'graveyard'
						? ['graveyard']
						: params.from === 'exile'
							? ['exile']
							: params.from === 'library'
								? ['library']
								: step.subject.k === 'binding' || step.subject.k === 'libraryTop'
									? ['battlefield', 'graveyard', 'exile', 'library']
									: ['battlefield', 'graveyard', 'exile'];
			// --- End Track P16a ---
			if (!this.answers[batchKey]) {
				let objs = this.objects(step.subject).filter(
					(o) =>
						allowedLibZones.includes(o.zone as 'battlefield' | 'graveyard' | 'exile' | 'library') &&
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
						!allowedLibZones.includes(f.zone as 'battlefield' | 'graveyard' | 'exile' | 'library') ||
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
					const actualFrom = f.zone as 'graveyard' | 'exile' | 'library';
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
			if (!isTransformingDfc || faces.length < 2) return false;
			const backView = resolveObjectFaces(baseCard, { zone: 'battlefield', faceIndex: 1 });
			return !backView.types.includes('Instant') && !backView.types.includes('Sorcery');
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
			// --- Track P16a: Optional filter on bound milled/exiled/revealed objects ---
			if (params.moveFilter) {
				objs = objs.filter((o) =>
					this.matches(
						o,
						params.moveFilter!,
						o.zone as 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile'
					)
				);
			}
			// --- End Track P16a ---
			if (params.topmostOnly) {
				// CR 404.2: the graveyard's order matters; the top card is the last one in the array.
				objs = objs.length > 0 ? [objs[objs.length - 1]] : [];
			}
			// --- Track P16a: Non-targeted choice move from graveyard/exile ---
			if (params.choiceCount) {
				const want = Math.max(0, this.amount(params.choiceCount, 1));
				const maxPick = Math.min(objs.length, want);
				const minPick = params.upTo ? 0 : maxPick;
				if (maxPick <= 0) {
					if (params.upTo) this.stepDecisions[this.stepIndex] = false;
					objs = [];
				} else {
					const chooser = (step.actor ? this.playerRef(step.actor) : null) ?? you;
					const chooseKey = `p16_move_pick:${this.stepIndex}`;
					const sortedForBot = [...objs].sort(
						(a, b) => objectManaValue(s, b) - objectManaValue(s, a)
					);
					if (this.answers[chooseKey]?.kind === 'chooseObjects') {
						objs = this.answered(chooseKey, objs, minPick, maxPick) ?? sortedForBot.slice(0, maxPick);
					} else if (!chooser.isBot && this.canPause && (minPick < maxPick || objs.length > maxPick)) {
						const z: ZoneType =
							objs[0]?.zone ??
							(params.from === 'exile'
								? 'exile'
								: params.from === 'library'
									? 'library'
									: 'graveyard');
						this.pauseForChoice(
							chooser,
							`${this.ctx.title} — Choose card(s) to return`,
							`Choose ${minPick === maxPick ? maxPick : `up to ${maxPick}`} card(s) to return.`,
							objs.map((c) => c.instanceId),
							minPick,
							maxPick,
							z,
							sortedForBot.slice(0, maxPick).map((c) => c.instanceId),
							chooseKey
						);
						return;
					} else {
						objs = sortedForBot.slice(0, maxPick);
					}
					if (params.upTo) {
						this.stepDecisions[this.stepIndex] = objs.length > 0;
					}
				}
			}
			// --- End Track P16a ---
			// --- Track P22d: Skip interactive Aura-host prompt when attachedToSelector specifies exact host ---
			if (params.to !== 'hand' && params.to !== 'graveyard' && this.canPause && !params.attachedToSelector) {
			// --- End Track P22d ---
				for (const o of objs) {
					if (!canEnterTransformed(o)) continue;
					const holder = this.locate(o.instanceId)?.holder;
					if (!holder) continue;
					const actorPlayer = step.actor ? this.playerRef(step.actor) : null;
					const controller = params.underYourControl ? you : (actorPlayer ?? this.player(o.ownerId) ?? holder);
					const view = resolveObjectFaces(o.copiableCard ?? o.card, {
						zone: 'battlefield',
						faceIndex: params.enteredTransformed || params.enteredFlipped ? 1 : o.activeFaceIndex
					});
					if (!view.subtypes.includes('Aura')) continue;
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
				// --- Track P16a: Move bound card from library/exile to graveyard ---
				if (params.to === 'graveyard') {
					const owner = this.player(o.ownerId) ?? holder;
					const res = moveObject(s, o, 'graveyard', {
						from: { player: holder, zone: actualFrom },
						toPlayer: owner,
						commanderRedirect: true,
						bumpVersion: true,
						newTimestamp: true
					});
					if (o.zone === 'graveyard') {
						this.recordStepActedObject(o, preSnap, false);
					}
					p.addLog(
						s,
						'cast',
						`${this.ctx.title} put ${o.card.name} from ${holder.username}'s ${actualFrom} into ${owner.username}'s graveyard.`,
						you.playerId
					);
					return res;
				}
				// --- End Track P16a ---
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
				// --- Track P18b ---
				if (params.enteredFlipped) {
					o.isFlipped = true;
					o.activeFaceIndex = 1;
				}
				// --- End Track P18b ---
				o.isFaceDown = false;
				o.faceDownSpec = undefined;
				o.faceDownLabel = undefined;
				const enteringView = resolveObjectFaces(o.copiableCard ?? o.card, {
					zone: 'battlefield',
					faceIndex: o.transformed || o.isFlipped ? 1 : o.activeFaceIndex
				});
				const isAura = enteringView.subtypes.includes('Aura');
				if (isAura) {
					const attachCands = p.legalAuraAttachCandidates(s, o, controller);
					// --- Track P22d: Direct host selector ("return ~ attached to <host>") ---
					let forcedHostId: string | undefined;
					if (params.attachedToSelector) {
						const hostObjs = this.objects(params.attachedToSelector).filter(
							(h) => h.zone === 'battlefield' && !h.phasedOut
						);
						const hostPls = hostObjs.length === 0 ? this.players(params.attachedToSelector) : [];
						const wantedIds = [
							...hostObjs.map((h) => h.instanceId),
							...hostPls.map((pl) => pl.playerId)
						];
						forcedHostId = wantedIds.find((wid) => attachCands.includes(wid));
						if (!forcedHostId) {
							p.addLog(
								s,
								'rule',
								`${enteringView.name} remained in ${holder.username}'s ${actualFrom} because the specified host is not legal to enchant (CR 303.4g).`,
								controller.playerId
							);
							return;
						}
					}
					// --- End Track P22d ---
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
					attachObject(
						s,
						o,
						forcedHostId ?? (pickedId && attachCands.includes(pickedId) ? pickedId : attachCands[0])
					);
				}
				o.summoningSick = params.unearth ? false : !enteringView.keywords.includes('Haste');
				o.tapped = Boolean(params.tapped || params.entersTappedAndAttacking);
				o.defaultControllerId = controller.playerId;
				const res = moveObject(s, o, 'battlefield', {
					from: { player: holder, zone: actualFrom },
					toPlayer: controller,
					controllerId: controller.playerId,
					bumpVersion: true,
					beforeInsert: (returned, d) => {
						if (d === 'battlefield') {
							applySelfEtbReplacements(s, returned);
						}
					},
					// --- Track P9 ---
					...(params.withCounters ? { withCounters: params.withCounters } : {}),
					// --- Track P10 ---
					...(actualFrom === 'graveyard' ? { suppressGraveyardLeaveBatch: true } : {}),
					// --- End Track P10 ---
					// --- Track P18b ---
					...(params.enteredFlipped ? { enteredFlipped: true } : {})
					// --- End Track P18b ---
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
				// --- Track P19a: Enters tapped and attacking (CR 508.4) & Enduring cycle "as an enchantment" (Layer 4) ---
				if (params.entersTappedAndAttacking && o.zone === 'battlefield') {
					registerEnteredAttackingCombatant(s, controller, o);
				}
				if (params.asEnchantmentOnly && o.zone === 'battlefield') {
					const ts = allocateTimestamp(s);
					(s.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: this.ctx.sourceCard.name,
						controllerId: controller.playerId,
						affected: [{ instanceId: o.instanceId, objectVersion: o.objectVersion ?? 1 }],
						expires: 'never',
						layer4: { setTypes: ['Enchantment'], setSubtypes: [] }
					});
					noteLayerInputsChanged(s);
				}
				// --- End Track P19a ---
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

	private moveDigCardToBattlefield(
		o: CardInstance,
		pl: PlayerGameState,
		tapped: boolean,
		// --- Track P19a ---
		attacking = false
		// --- End Track P19a ---
	): MoveResult | void {
		const s = this.state;
		const p = effectPorts();
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
		const isAura = enteringView.subtypes.includes('Aura');
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
			bumpVersion: true
		});
		if (o.zone === 'battlefield') {
			// --- Track P19a ---
			if (attacking) {
				registerEnteredAttackingCombatant(s, pl, o);
			}
			// --- End Track P19a ---
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
		if (
			executeDigWave9(this, step, {
				matches: (inst, filter, zone) => this.matches(inst, filter, zone),
				answered: (key, cands, min, max) => this.answered(key, cands, min, max),
				setStepDecision: (idx, dec) => {
					this.stepDecisions[idx] = dec;
				},
				addLog: (msg, pid) => effectPorts().addLog(this.state, 'rule', msg, pid),
				moveDigCardToBattlefield: (o, pl, tapped, attacking) =>
					this.moveDigCardToBattlefield(o, pl, tapped, attacking),
				pauseForOrder: (chooser, title, desc, ids, key) =>
					this.pauseForOrder(chooser, title, desc, ids, key),
				executeCastFreeStep: (castStep) => executeCastFree(this.p16aHost(), castStep)
			})
		) {
			return;
		}
		// --- Track P22d ---
		if (
			executeDigWave8(this.p19aHost(), step, {
				matches: (inst, filter, zone) =>
					zone === 'command' || zone === 'stack' ? false : this.matches(inst, filter, zone),
				answered: (key, cands, min, max) => this.answered(key, cands, min, max),
				setStepDecision: (idx, dec) => {
					this.stepDecisions[idx] = dec;
				},
				addLog: (msg, pid) => effectPorts().addLog(this.state, 'rule', msg, pid),
				moveDigCardToBattlefield: (o, pl, tapped, attacking) =>
					this.moveDigCardToBattlefield(o, pl, tapped, attacking),
				pauseForOrder: (chooser, title, desc, ids, key) =>
					this.pauseForOrder(chooser, title, desc, ids, key),
				subStepIndex: this.subStepIndex,
				setSubStepIndex: (idx) => {
					this.subStepIndex = idx;
				}
			})
		) {
			return;
		}
		// --- End Track P22d ---
		const s = this.state;
		const p = effectPorts();
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
			if (pl.library.length === 0) {
				// --- Track P16a ---
				if (dig.shuffleRest) shuffleLibrary(s, pl);
				// --- End Track P16a ---
				return;
			}
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
			if (count <= 0) {
				// --- Track P16a ---
				if (dig.upTo) this.stepDecisions[this.stepIndex] = false;
				this.bind(step, []);
				// --- End Track P16a ---
				return;
			}
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
			// --- Track P16a: Bind kept cards and record upTo decision for "If you don't" follow-ups ---
			this.bind(step, kept);
			if (dig.upTo) this.stepDecisions[this.stepIndex] = kept.length > 0;
			// --- End Track P16a ---
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
						return this.moveDigCardToBattlefield(
							o,
							pl,
							Boolean(dig.keepTapped),
							Boolean(dig.keepAttacking)
						);
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
		// --- Track P16a: restToHand support on top-N dig ---
		} else if (dig.restToHand) {
			const batch = this.runIndexedBatch(
				`dig_rest_hand_batch:${this.stepIndex}`,
				() => orderedRestIds,
				(id) => {
					const o = pl.library.find((c) => c.instanceId === id);
					if (!o) return;
					return moveObject(s, o, 'hand', {
						from: { player: pl, zone: 'library' },
						toPlayer: pl,
						newTimestamp: true,
						bumpVersion: true
					});
				}
			);
			if (batch.paused) return;
		// --- End Track P16a ---
		// --- Track P19a: `rest === 'libraryTop'` ("Look at the top two cards... Put one into your graveyard", "Put the rest back on top...") ---
		} else if (dig.rest === 'libraryTop') {
			const keptInLib =
				dig.keepTo === 'libraryTop'
					? keptIds
							.map((id) => pl.library.find((c) => c.instanceId === id))
							.filter((c): c is CardInstance => Boolean(c))
					: [];
			const restInLib = orderedRestIds
				.map((id) => pl.library.find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			rearrangeLibrary(pl, [...keptInLib, ...restInLib], [...keptInLib, ...restInLib], []);
		// --- End Track P19a ---
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
		// --- Track P16a: Polymorph / shuffle-remainder dig ---
		if (dig.shuffleRest) {
			shuffleLibrary(s, pl);
		}
		// --- End Track P16a ---

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
	// --- Track P10 ---
	runInlineBranchSteps(inlineSteps: EffectStep[], subPathTag: number): boolean {
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

		const loopAns = this.answers['__w10_loop_pid'];
		const oppAns = this.answers['__w10_chosen_opp'];
		if (this.answers['__w10_destroyed_ctrls']) {
			childAnswers['__w10_destroyed_ctrls'] = this.answers['__w10_destroyed_ctrls'];
		}
		const childCtx: EffectContext = {
			...this.ctx,
			...(loopAns?.kind === 'chooseObjects' && loopAns.objectIds[0]
				? { w10LoopPlayerId: loopAns.objectIds[0] }
				: {}),
			...(oppAns?.kind === 'chooseObjects' && oppAns.objectIds[0]
				? { w10ChosenOpponentId: oppAns.objectIds[0] }
				: {}),
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
		// --- Track P16a ---
		childRun.lastCountersRemoved = this.lastCountersRemoved;
		for (const did of this.prevStepDiedIds) childRun.prevStepDiedIds.add(did);
		// --- End Track P16a ---
		// --- Track P19a ---
		if (this.lastCountedByKind) {
			childRun.lastCountedByKind = { ...this.lastCountedByKind };
		}
		// --- End Track P19a ---
		for (const [name, bound] of this.bindings.entries()) {
			// --- Track P22d ---
			childRun.bindings.set(
				name,
				bound.map((b) => ({
					id: b.id,
					lki: { ...b.lki },
					...(b.counteredStackLki ? { counteredStackLki: b.counteredStackLki } : {})
				}))
			);
			// --- End Track P22d ---
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
			// --- Track P16a ---
			this.lastCountersRemoved = childRun.lastCountersRemoved;
			if (this.lastCountersRemoved !== undefined) {
				this.ctx.item.lastCountersRemoved = this.lastCountersRemoved;
			}
			// --- End Track P16a ---
			// --- Track P19a ---
			if (childRun.lastCountedByKind) {
				this.lastCountedByKind = { ...childRun.lastCountedByKind };
				this.ctx.item.lastCountedByKind = { ...childRun.lastCountedByKind };
			}
			// --- End Track P19a ---
			this.bindings.clear();
			for (const [name, bound] of childRun.bindings.entries()) {
				this.bindings.set(name, bound);
			}
			if (childRun.result.exileSelf) this.result.exileSelf = true;
			if (childRun.result.exileSelfWithCounters) {
				this.result.exileSelfWithCounters = { ...childRun.result.exileSelfWithCounters };
			}
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
		this.lastInlineStepDecision = undefined;
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
		let lastDecision: boolean | undefined;
		for (let k = inlineSteps.length - 1; k >= 0; k--) {
			if (k in childRun.stepDecisions) {
				lastDecision = Boolean(childRun.stepDecisions[k]);
				break;
			}
		}
		this.lastInlineStepDecision = lastDecision;
		return false;
	}

	p10Host(): P10EffectHost {
		const self = this;
		const base = this.keywordHost();
		return {
			...base,
			get state() {
				return self.state;
			},
			get ports() {
				return effectPorts();
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
					id: effectPorts().uid('prompt', self.state),
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
					id: effectPorts().uid('prompt', self.state),
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
					id: effectPorts().uid('prompt', self.state),
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
	recordEffectAmount(n: number): void {
		this.lastEffectAmount = n;
		this.ctx.item.lastEffectAmount = n;
	}
	// --- Track P19a ---
	recordCountedKind(
		kind: NonNullable<Extract<Amount, { k: 'countedThisWay' }>['kind']>,
		n: number
	): void {
		const next = { ...(this.lastCountedByKind ?? {}), [kind]: n };
		this.lastCountedByKind = next;
		this.ctx.item.lastCountedByKind = { ...next };
	}

	p19aHost(): P19aStepHost {
		const self = this;
		const lifeFunnels = this.p13LifeFunnels();
		return {
			get state() {
				return self.state;
			},
			get you() {
				return self.you;
			},
			get sourceId() {
				return self.ctx.sourceId;
			},
			get sourceCard() {
				return self.ctx.sourceCard;
			},
			get title() {
				return self.ctx.title;
			},
			get item() {
				return self.ctx.item;
			},
			get stepIndex() {
				return self.stepIndex;
			},
			get subStepIndex() {
				return self.subStepIndex;
			},
			get canPause() {
				return self.canPause;
			},
			get answers() {
				return self.answers;
			},
			get targets() {
				return self.ctx.targets;
			},
			get eventObjectId() {
				return self.ctx.eventObjectId;
			},
			get eventPlayerId() {
				return self.ctx.eventPlayerId;
			},
			get sourceChosenCardName() {
				const src = self.locate(self.ctx.sourceId)?.inst;
				return src?.chosenCardName ?? self.ctx.item.sourceChosenCardName;
			},
			amount: (a, fb) => self.amount(a, fb),
			evalCondition: (c) => self.condition(c),
			objects: (sel) => self.objects(sel),
			players: (sel) => self.players(sel),
			targetsForSpecIndex: (idx) => self.targetsForSpecIndex(idx),
			locate: (id) => {
				const f = self.locate(id);
				return f ? { inst: f.inst, player: f.holder, zone: f.zone } : undefined;
			},
			bind: (st, objs) => self.bind(st, objs),
			recordEffectAmount: (n) => self.recordEffectAmount(n),
			recordCountedKind: (kind, n) => self.recordCountedKind(kind, n),
			saveFrame: (stepIndex, answers, phase, subStepIndex) =>
				self.saveFrame(stepIndex, answers, phase, subStepIndex),
			pauseForChoice: (chooser, title, desc, cands, min, max, zone, defaults, ansKey) =>
				self.pauseForChoice(chooser, title, desc, cands, min, max, zone, defaults, ansKey),
			pauseForYesNo: (chooser, title, desc, answerKey, labels) =>
				self.pauseForYesNo(
					chooser,
					title,
					desc,
					answerKey,
					labels?.yesLabel && labels?.noLabel
						? { yesLabel: labels.yesLabel, noLabel: labels.noLabel }
						: undefined
				),
			markPaused: () => {
				self.result.paused = true;
			},
			gainLifeForPlayer: (pl, amt) => {
				lifeFunnels.gainLife(self.state, pl, amt);
			},
			loseLifeForPlayer: (pl, amt) => {
				lifeFunnels.loseLife(self.state, pl, amt);
			},
			p16aHost: () => self.p16aHost()
		};
	}
	// --- End Track P19a ---

	p13AskFn(): P13StepAskFn {
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
				id: effectPorts().uid('prompt', this.state),
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

	p13LifeFunnels(): P13LifeFunnels {
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

	runTrackedP13InlineSteps(
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

	// --- Track P16a ---
	p16aHost(): P16aStepHost {
		const self = this;
		return {
			get state() {
				return self.state;
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
			get eventLki() {
				return self.ctx.eventLki;
			},
			amount: (a, fb) => self.amount(a, fb),
			objects: (sel) => self.objects(sel),
			players: (sel) => self.players(sel),
			playerRef: (ref) => self.playerRef(ref),
			refObjects: (ref) => {
				if (ref.k === 'affected') return [];
				return self.objects(ref as Selector);
			},
			refLkiCounters: (ref) => {
				if (ref.k === 'eventObject' && self.ctx.eventLki?.counters) {
					return { ...self.ctx.eventLki.counters };
				}
				const id = self.refId(ref);
				if (!id) return undefined;
				const loc = self.locate(id);
				if (loc && loc.zone === 'battlefield') {
					return { ...loc.inst.counters };
				}
				if (loc?.inst.lastKnownCounters) {
					return { ...loc.inst.lastKnownCounters };
				}
				if (self.ctx.eventLki?.counters) {
					return { ...self.ctx.eventLki.counters };
				}
				return undefined;
			},
			matches: (c, f, z) => self.matches(c, f, z),
			locate: (id) => self.locate(id),
			bind: (st, objs) => self.bind(st, objs),
			answered: (key, cands, min, max) => self.answered(key, cands, min, max),
			pauseForChoice: (chooser, title, desc, cands, min, max, zone, defaults, ansKey) =>
				self.pauseForChoice(chooser, title, desc, cands, min, max, zone, defaults, ansKey),
			pauseForYesNo: (chooser, title, question, answerKey, labels) =>
				self.pauseForYesNo(chooser, title, question, answerKey, labels),
			pauseForMode: (chooser, title, description, modes, min, max, answerKey, defaultIndices) => {
				const item = self.saveFrame(self.stepIndex, self.answers, 'step', self.subStepIndex);
				enqueueChoicePrompt(self.state, {
					id: effectPorts().uid('prompt', self.state),
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
			setStepDecision: (accepted: boolean) => {
				self.stepDecisions[self.stepIndex] = accepted;
			},
			recordCountersRemoved: (n: number) => {
				self.lastCountersRemoved = n;
				self.ctx.item.lastCountersRemoved = n;
			},
			didObjectDieInPrecedingStep: (id: string) => self.prevStepDiedIds.has(id),
			didAnyActedObjectDieInPrecedingStep: () =>
				self.prevStepDiedIds.size > 0 || Boolean(self.stepDecisions[-1000 - (self.stepIndex - 1)]),
			createTokens: (controller, spec, count) => {
				const total = Math.max(0, count) * tokenMultiplier(self.state, controller.playerId);
				const made: CardInstance[] = [];
				withSimultaneousZoneBatch(self.state, () => {
					for (let i = 0; i < total; i++) {
						made.push(effectPorts().createToken(self.state, controller, spec));
					}
				});
				self.recordEffectAmount(made.length);
				return made;
			},
			addCounters: (perm, counter, count) => {
				if (count > 0) effectPorts().addCounters(self.state, perm, counter, count);
			},
			removeCounters: (perm, counter, count) => {
				const want = Math.max(0, count);
				const prev = perm.counters[counter] || 0;
				const next = Math.max(0, prev - want);
				const removed = prev - next;
				if (removed > 0) {
					perm.counters[counter] = next;
					noteLayerInputsChanged(self.state);
					if (!perm.phasedOut) {
						emitEvent(self.state, {
							kind: 'CounterRemoved',
							objectId: perm.instanceId,
							object: perm,
							counterType: counter,
							amount: removed,
							previousCount: prev,
							newCount: next
						});
						if (counter === 'defense') {
							onBattleDefenseCountersRemoved(self.state, perm, prev, next);
						}
						flushTriggers(self.state);
					}
				}
				return removed;
			},
			transformPermanent: (perm) => effectPorts().transformPermanent(self.state, perm),
			drawCards: (player, count) => effectPorts().drawCards(self.state, player, count),
			flushTriggers: () => flushTriggers(self.state),
			addLog: (kind, text, actorId) => {
				const mappedKind = kind === 'sba' || kind === 'system' ? 'rule' : kind;
				effectPorts().addLog(self.state, mappedKind, text, actorId);
			}
		};
	}
	// --- End Track P16a ---

	keywordHost(): KeywordActionHost {
		const self = this;
		return {
			get state() {
				return self.state;
			},
			get ports() {
				return effectPorts();
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
	syntheticLkiObject(instanceId: string, controllerId: string): CardInstance {
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
		const p = effectPorts();
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
		const p = effectPorts();
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
		const p = effectPorts();
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
/**
 * Runs `steps` in order against `state`. With `resume` (a stack item's `effectResume`), continues a
 * paused resolution at the step that asked for a choice, with the stored bindings and answers.
 */
export function executeEffectSteps(state: GameState, ctx: EffectContext, steps: EffectStep[], resume?: EffectResumeFrame): EffectResult {
	const run = new Run(state, ctx, resume);
	run.run(steps);
	return run.result;
}
