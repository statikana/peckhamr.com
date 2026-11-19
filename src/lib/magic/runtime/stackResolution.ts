import { parseCost } from '../compiler/costs.ts';
import {
	compileCard,
	compiledStackItemEffects,
	compiledTriggerEffect,
	compileSpellEffects,
	describeModalModes,
	expandModalEffects,
	getAbilityModal,
	resolveCompiledDelayedSteps
} from '../compiler/index.ts';
import { stackItemDisplayText } from '../compiler/support.ts';
import { runtimeTriggers } from '../compiler/triggers.ts';
import type {
	Condition,
	CopyModificationSpec,
	CostDef,
	EffectStep,
	ModalDef,
	TargetSpec
} from '../ir.ts';
import { parseManaCost, withStackItemText } from '../oracle.ts';
import { evaluatePermanent, getSpellTargetRequirement, targetRequirementFromSpecs } from '../ruleTree.ts';
import { activeFaceIndexForObject, effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	CompiledDelayedEffect,
	CopiableState,
	CostPayment,
	CounterType,
	DelayedTriggerEffect,
	EffectBindingSnapshot,
	EffectResumeFrame,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	SerializedBoundRef,
	StackItem,
	TargetRef,
	ZoneType
} from '../types.ts';
import {
	enqueueChoicePrompt,
	inferObjectsZone,
	pickScryOrSurveilSplit,
	registerPromptHandler
} from './choices.ts';
import {
	buildModifiedCopiableState,
	registerEnteredAttackingCombatant,
	validateAndNormalizeTargetDivisions
} from './copyPreventionAndEffects.ts';
import {
	canPayCosts,
	chooseCostPayment,
	computeKickerTracking,
	type CostContext,
	describeCost,
	executeCostPaymentParts,
	getObjectKickerInfo,
	payPlannedCosts,
	payTapAndManaCostParts,
	planCosts,
	serializeCostPlanParts
} from './costs.ts';
import { applyAltCastEnterCountersWave6 } from './costsWave6.ts';
import {
	dealDamageToPermanent,
	dealDamageToPlayer,
	executeEffectSteps,
	gainPlayerLife,
	interpretableNow,
	type PayOptionalCostResult,
	sourceDamageInfo,
	type StackItemRetargetSlot,
	staticallyInterpretable
} from './effects.ts';
import { resolveP13InherentTrigger } from './effectsWave5.ts';
import { isSpellUncounterableByP16a } from './effectsWave6.ts';
import {
	addLog,
	allocateFaceDownLabel,
	createCardInstance,
	emitVfx,
	findCardAnywhere,
	findPermanentOnBoard,
	getCreaturePower,
	getCreatureToughness,
	getSagaFinalChapterNumber,
	givePriorityToActiveOrNextPlayer,
	H,
	hasKeyword,
	movePermanentToZone,
	offsetTargetIndicesInSteps,
	triggerPathCounts,
	withModalPrefixAndSuffixEffects
} from './engineHost.ts';
import { emitEvent } from './events.ts';
import { activeCharacteristics, instanceFaceOptions, resolveObjectFaces, stackItemFaceOptions } from './faces.ts';
import {
	checkSpellAscendOnResolve,
	deliverPromisedGift,
	handleCipherSpellPostResolve,
	handleParadigmSpellPostResolve,
	isWave5StackItem,
	onPlayerLostLifeCheckSpeedTrigger,
	resolveWave5StackItem
} from './framesBattlesAndKeywordsWave5.ts';
import {
	getEffectiveUsedModalModes,
	recordChosenModalModesOnPermanent,
	validatePawprintBudget
} from './framesModalsWave6.ts';
import { resolveWave7Effect } from './framesWave7.ts';
import {
	isModalRandomActive,
	resolveWave8ModalEffectiveBounds,
	validateDifferentPlayerTargetsPerMode
} from './framesWave8.ts';
import {
	buildDashBounceDelayedTrigger,
	buildReboundDelayedTrigger,
	cardHasRebound,
	resolveDashBounceDelayedTrigger,
	resolveReboundDelayedTrigger,
	resolveWave3StackItem
} from './keywordsWave3.ts';
import {
	applyAwakenOnSpellResolution,
	placeSneakedPermanentIntoCombat,
	recordPlayerLifeLossWave4,
	resolveWave4StackItem,
	tryUmbraArmorInsteadOfDestroy
} from './keywordsWave4.ts';
import {
	epicUpkeepCompiledEffect,
	grantedFrenzyCompiledEffect,
	isMutateTargetStillLegal,
	isWave6StackItem,
	maybeEnqueueSpellHauntTrigger,
	mutateTargetSpec,
	registerResolvedEpicSpell,
	resolveMutatingSpellOnStack,
	resolveWave6StackItem
} from './keywordsWave6.ts';
import { isConditionMetWithKicker } from './kicker.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	evaluateAmount,
	evaluateCondition,
	type FilterContext,
	matchesObjectFilter
} from './objectFilter.ts';
import { buildBlitzSacrificeDelayedTrigger } from './orthogonalKeywords.ts';
import { nextRandom, uid } from './random.ts';
import { resolveQuotedActivatedOrTriggeredSteps, resolveReflexiveSpecFromCompiled } from './reflexiveManaAndActions.ts';
import {
	applySelfEtbReplacements,
	hasRestriction,
	playerLifeTotalCantChange,
	registerCounterPlacement,
	resolveCounterReplacements,
	spellCannotBeCountered
} from './replace.ts';
import {
	applyGraveyardCopyEtbWave9,
	applyWave9CopyModificationExtras,
	resolveWave9StackTriggerItem
} from './replaceWave9.ts';
import { KEYWORD_COUNTER_TYPES, resolveGrantedRuntimeTrigger } from './staticsDynamicAndCosts.ts';
import {
	applyCopiedPermanentToInstance,
	findLegalCloneCandidates,
	findSelfCloneReplacementSpec
} from './staticsLayersAndRestrictions.ts';
import {
	getGrantedSpellKeywordsForSpell,
	getRequiredFlagbearerIdsForActor,
	validateFlagbearerTargets
} from './staticsWave6.ts';
import { applyWave7CopyModificationExtras, hasActiveSelfRegenerateOnDestroy } from './staticsWave7.ts';
import { canPutCounterOnPermanentWave8, resolveWave8GrantedActivatedEffects } from './staticsWave8.ts';
import { buildWarpExileDelayedTrigger } from './striatedFrames.ts';
import { flushTriggers, stackTriggerConditionHolds, withTriggersDeferred } from './triggers.ts';
import {
	capturePlayerEnergySnapshot,
	emitEnergyDiffEvents,
	emitP19bPostEffectStepEvents,
	isPureSpellDelayedInstantSorceryP19b,
	registerP19bSpellDelayedTriggers,
	withActiveTapActorId
} from './triggersWave7.ts';
import { reconstructWave9DelayedRuntimeTrigger } from './triggersWave9.ts';
import { computeLibraryInsertIndex } from './tuckFreezeChosen.ts';
import {
	allocateTimestamp,
	attachObject,
	createEmptyCounters,
	moveObject,
	type MoveResult,
	rearrangeLibrary,
	shuffleLibrary,
	syncBattlefieldControllers,
	tapPermanent
} from './zones.ts';

export function moveStackSpellToZone(
	state: GameState,
	stackItem: StackItem,
	dest: 'graveyard' | 'exile' | 'hand' | 'library' = 'graveyard',
	libraryOpts?: { position?: 'top' | 'bottom'; fromTop?: number }
): void {
	if (stackItem.kind !== 'spell' || stackItem.isCopy) return;
	// CR 702.34a (and similar stack-exit replacements): exile instead of putting it anywhere else.
	if (stackItem.spellMods?.exileOnLeaveStack) {
		dest = 'exile';
	}
	// --- Track P14: Kess-style graveyard-only replacement ("If a spell cast this way would be put into your graveyard, exile it instead") ---
	if (dest === 'graveyard' && stackItem.spellMods?.exileIfPutIntoGraveyard) {
		dest = 'exile';
	}
	// --- End Track P14 ---
	const ownerId = stackItem.ownerId || stackItem.controllerId;
	const owner =
		state.players.find((p) => p.playerId === ownerId) ||
		state.players.find((p) => p.playerId === stackItem.controllerId);
	if (!owner) return;

	const isCmd = owner.commanderNames[stackItem.sourceInstanceId] !== undefined;
	const castCount =
		owner.commanderCastCounts?.[stackItem.sourceInstanceId] ??
		stackItem.commanderCastCount ??
		0;
	const cardInst = createCardInstance(
		stackItem.card,
		owner.playerId,
		dest,
		isCmd,
		false,
		0
	);
	cardInst.instanceId = stackItem.sourceInstanceId;
	cardInst.commanderCastCount = castCount;
	cardInst.zone = 'stack' as ZoneType;
	// --- Track P22a: CR 122.2 restore zone-persistent counters from stack spell ---
	if (stackItem.carriedCounters) {
		for (const [ck, cv] of Object.entries(stackItem.carriedCounters)) {
			if ((cv ?? 0) > 0) cardInst.counters[ck as CounterType] = cv;
		}
	}
	// --- End Track P22a ---
	if (stackItem.faceIndex !== undefined) {
		cardInst.activeFaceIndex = stackItem.faceIndex;
	}
	if (stackItem.isFaceDown) {
		addLog(
			state,
			'rule',
			`CR 708.9: ${stackItem.faceDownLabel || 'Face-Down Spell'} left the stack to ${dest} and is revealed as ${stackItem.card.name}.`,
			owner.playerId
		);
	}
	moveObject(state, cardInst, dest, {
		from: 'stack',
		toPlayer: owner,
		graveyardReplacement: dest === 'graveyard',
		commanderRedirect: true,
		insert: (actual) =>
			actual === 'library'
				? computeLibraryInsertIndex(
						libraryOpts?.fromTop,
						libraryOpts?.position ?? 'top',
						owner.library.length
					)
				: 'end'
	});
	// CR 716.3d: Resolving Adventure spell exiles itself with permission for its controller to cast its main face.
	if (
		dest === 'exile' &&
		cardInst.zone === 'exile' &&
		stackItem.spellMods?.exileAdventureOnResolve &&
		!stackItem.spellMods?.exileOnLeaveStack
	) {
		cardInst.playableFromExileBy = {
			playerId: stackItem.controllerId,
			spendManaAsAnyColor: false,
			sourceName: `${stackItem.title} (Adventure)`,
			allowedFaceIndices: [0],
			onAdventure: true
		};
		addLog(
			state,
			'rule',
			`${cardInst.card.name} is exiled on an Adventure and may be cast from Exile (CR 716.3d).`,
			stackItem.controllerId
		);
	}
}

export function addCountersToPermanent(
	state: GameState,
	perm: CardInstance,
	type: CounterType,
	amount: number
): number {
	if (amount <= 0) return 0;
	if (hasRestriction(state, perm, 'cantHaveCounters')) return 0;
	// --- Track P22a: CR 122.6 cantHaveCounterType lock ---
	if (!canPutCounterOnPermanentWave8(state, perm, type)) return 0;
	// --- End Track P22a ---
	const res = resolveCounterReplacements(state, perm, type, amount);
	if (res.pendingOptions && res.pendingOptions.length >= 2) {
		const description = `Multiple replacement effects would modify putting ${res.amount} ${type} counter(s) on ${perm.card.name}. Choose which applies first (CR 616.1):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: res.chooserId,
			kind: 'chooseReplacement',
			purpose: 'generic',
			title: 'Choose Replacement Effect (CR 616.1)',
			description,
			continuation: {
				kind: 'handler',
				name: 'counter_replacement_choice',
				data: {
					permId: perm.instanceId,
					counterType: type,
					currentAmount: res.amount,
					appliedIds: res.appliedIds
				}
			},
			choice: {
				kind: 'chooseReplacement',
				options: res.pendingOptions.map((r) => ({ id: r.id, label: r.label }))
			}
		});
		return 0;
	}
	const effectiveAmount = res.amount;
	if (effectiveAmount <= 0) return 0;
	const previousCount = perm.counters[type] || 0;
	const newCount = previousCount + effectiveAmount;
	perm.counters[type] = newCount;
	// --- Track P11: CR 613.7c stamp timestamp when a keyword counter is placed on a permanent ---
	if ((KEYWORD_COUNTER_TYPES as readonly string[]).includes(type)) {
		(perm.counterTimestamps ??= {})[type] = allocateTimestamp(state);
	}
	// --- End Track P11 ---
	noteLayerInputsChanged(state);
	// --- Track P16b ---
	const actorId =
		state.stack.findLast((s) => Boolean(s.resolutionStarted))?.controllerId ?? perm.controllerId;
	// --- End Track P16b ---
	emitEvent(state, {
		kind: 'CounterPlaced',
		objectId: perm.instanceId,
		object: perm,
		counterType: type,
		amount: effectiveAmount,
		previousCount,
		newCount,
		// --- Track P16b ---
		actorId
		// --- End Track P16b ---
	});
	// "Whenever a +1/+1 counter is put on ~" ran here before Phase 5; keep that timing when already on board.
	if (findPermanentOnBoard(state, perm.instanceId)) {
		flushTriggers(state);
	}
	return effectiveAmount;
}

registerCounterPlacement(addCountersToPermanent);

registerPromptHandler('counter_replacement_choice', (state, prompt, answer) => {
	if (answer.kind !== 'chooseReplacement') return;
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const permId = typeof data.permId === 'string' ? data.permId : '';
	const counterType = (data.counterType as CounterType | undefined) ?? '+1/+1';
	const currentAmount = typeof data.currentAmount === 'number' ? data.currentAmount : 0;
	const appliedIds = Array.isArray(data.appliedIds) ? (data.appliedIds as string[]) : [];
	const resumeStackItemId =
		typeof data.resumeStackItemId === 'string' ? data.resumeStackItemId : undefined;
	const resumeStepIndex =
		typeof data.resumeStepIndex === 'number' ? data.resumeStepIndex : undefined;
	const found = findPermanentOnBoard(state, permId);
	if (!found || currentAmount <= 0) return;
	const perm = found.inst;

	const nextRes = resolveCounterReplacements(
		state,
		perm,
		counterType,
		currentAmount,
		new Set(appliedIds),
		answer.id
	);
	if (nextRes.pendingOptions && nextRes.pendingOptions.length >= 2) {
		const description = `Multiple replacement effects would modify putting ${nextRes.amount} ${counterType} counter(s) on ${perm.card.name}. Choose which applies next (CR 616.1f):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: nextRes.chooserId,
			kind: 'chooseReplacement',
			purpose: 'generic',
			title: 'Choose Replacement Effect (CR 616.1)',
			description,
			continuation: {
				kind: 'handler',
				name: 'counter_replacement_choice',
				data: {
					permId: perm.instanceId,
					counterType,
					currentAmount: nextRes.amount,
					appliedIds: nextRes.appliedIds,
					...(resumeStackItemId !== undefined ? { resumeStackItemId } : {}),
					...(resumeStepIndex !== undefined ? { resumeStepIndex } : {})
				}
			},
			choice: {
				kind: 'chooseReplacement',
				options: nextRes.pendingOptions.map((r) => ({ id: r.id, label: r.label }))
			}
		});
		return;
	}
	const effectiveAmount = nextRes.amount;
	const previousCount = perm.counters[counterType] || 0;
	const newCount = previousCount + effectiveAmount;
	perm.counters[counterType] = newCount;
	// --- Track P11 ---
	if ((KEYWORD_COUNTER_TYPES as readonly string[]).includes(counterType)) {
		(perm.counterTimestamps ??= {})[counterType] = allocateTimestamp(state);
	}
	// --- End Track P11 ---
	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'CounterPlaced',
		objectId: perm.instanceId,
		object: perm,
		counterType,
		amount: effectiveAmount,
		previousCount,
		newCount
	});
	flushTriggers(state);
});
// --- End Track P18b ---

/** The compiled IR effect of a triggered stack item, or null (no compiled effect: legacy only). */
export function triggerItemEffect(item: StackItem) {
	if (item.kind !== 'triggered') return null;
	// --- Track P18b ---
	const raw = triggerItemEffectInner(item);
	return withModalPrefixAndSuffixEffects(raw, item.chosenModes);
}

function triggerItemEffectInner(item: StackItem) {
	// --- End Track P18b ---
	// --- Track P18a: CR 702.50a Epic upkeep copy trigger & CR 702.68 granted Frenzy N ---
	if (item.wave6Tag === 'epic_upkeep') {
		return { ...epicUpkeepCompiledEffect(), unparsed: [] };
	}
	if (item.grantedKeyword) {
		const frenzyEff = grantedFrenzyCompiledEffect(item.grantedKeyword);
		if (frenzyEff) return frenzyEff;
	}
	// --- End Track P18a ---
	// --- Track P10 ---
	if (item.reflexiveTrigger) {
		const spec = resolveReflexiveSpecFromCompiled(item.reflexiveTrigger);
		if (!spec) return null;
		if (spec.modal && item.chosenModes) {
			const expanded = expandModalEffects(spec.modal, item.chosenModes);
			if (expanded) {
				return {
					steps: expanded.steps,
					targets: expanded.targets,
					modal: spec.modal,
					unparsed: []
				};
			}
		}
		return {
			steps: spec.effect,
			targets: spec.targets,
			...(spec.modal ? { modal: spec.modal } : {}),
			unparsed: []
		};
	}
	if (item.grantedAbilityText) {
		return resolveQuotedActivatedOrTriggeredSteps(
			item.grantedAbilityText,
			item.card.name,
			'triggered',
			item.chosenModes
		);
	}
	// --- End Track P10 ---
	// --- Track P11: Layer 6 granted triggered ability ---
	if (item.grantSourceCard && item.grantAbilityIndex !== undefined) {
		const gt = resolveGrantedRuntimeTrigger(
			item.grantSourceCard,
			item.grantFaceIndex ?? 0,
			item.grantAbilityIndex
		);
		if (!gt?.effect) return null;
		if (gt.effect.modal && item.chosenModes) {
			return expandModalEffects(gt.effect.modal, item.chosenModes);
		}
		return gt.effect;
	}
	// --- End Track P11 ---
	if (item.delayedSubStepIndex !== undefined && item.triggeredAbilityIndex !== undefined) {
		const dtRt = reconstructWave9DelayedRuntimeTrigger({
			id: item.wave7SpellDelayedId ?? 'w9_dt',
			controllerId: item.controllerId,
			sourceInstanceId: item.sourceInstanceId,
			sourceCard: item.card,
			faceIndex: item.faceIndex ?? 0,
			abilityIndex: item.triggeredAbilityIndex,
			subTriggerStepIndex: item.delayedSubStepIndex,
			oneShot: false,
			expiresEndOfTurn: false
		});
		if (dtRt?.effect) {
			if (dtRt.effect.modal && item.chosenModes) {
				return expandModalEffects(dtRt.effect.modal, item.chosenModes);
			}
			return dtRt.effect;
		}
	}
	if (item.triggeredAbilityIndex === undefined) return null;
	return compiledTriggerEffect(
		item.card,
		item.triggeredAbilityIndex,
		item.grantedKeyword,
		item.faceIndex ?? 0,
		item.chosenModes
	);
}

/** The ModalDef for a modal triggered stack item, if any. */
export function triggerItemModal(item: StackItem): ModalDef | undefined {
	if (item.kind !== 'triggered') return undefined;
	// --- Track P10 ---
	if (item.reflexiveTrigger) {
		return resolveReflexiveSpecFromCompiled(item.reflexiveTrigger)?.modal;
	}
	if (item.grantedAbilityText) {
		return resolveQuotedActivatedOrTriggeredSteps(
			item.grantedAbilityText,
			item.card.name,
			'triggered'
		)?.modal;
	}
	// --- End Track P10 ---
	// --- Track P11: Layer 6 granted modal triggered ability ---
	if (item.grantSourceCard && item.grantAbilityIndex !== undefined) {
		return resolveGrantedRuntimeTrigger(
			item.grantSourceCard,
			item.grantFaceIndex ?? 0,
			item.grantAbilityIndex
		)?.effect?.modal;
	}
	// --- End Track P11 ---
	if (item.delayedSubStepIndex !== undefined && item.triggeredAbilityIndex !== undefined) {
		return reconstructWave9DelayedRuntimeTrigger({
			id: item.wave7SpellDelayedId ?? 'w9_dt',
			controllerId: item.controllerId,
			sourceInstanceId: item.sourceInstanceId,
			sourceCard: item.card,
			faceIndex: item.faceIndex ?? 0,
			abilityIndex: item.triggeredAbilityIndex,
			subTriggerStepIndex: item.delayedSubStepIndex,
			oneShot: false,
			expiresEndOfTurn: false
		})?.effect?.modal;
	}
	if (item.triggeredAbilityIndex === undefined) return undefined;
	return compiledTriggerEffect(item.card, item.triggeredAbilityIndex, item.grantedKeyword, item.faceIndex ?? 0)?.modal;
}

// --- Track P10 ---
export function resolveStackItemCompiledEffects(item: StackItem) {
	if (
		item.kind === 'triggered' &&
		(item.reflexiveTrigger ||
			item.grantedAbilityText ||
			(item.grantSourceCard && item.grantAbilityIndex !== undefined))
	) {
		return triggerItemEffect(item);
	}
	if (item.kind === 'activated' && item.grantedAbilityText) {
		return resolveQuotedActivatedOrTriggeredSteps(
			item.grantedAbilityText,
			item.card.name,
			'activated',
			item.chosenModes
		);
	}
	// --- Track P22a: Statically granted graveyard Scavenge / Unearth activated abilities ---
	if (item.kind === 'activated' && item.abilityId?.startsWith('wave8_granted:')) {
		return resolveWave8GrantedActivatedEffects(item.abilityId);
	}
	// --- End Track P22a ---
	// --- Track P15: Cleave (CR 702.148), Gift-promised (CR 702.174b), & Splice (CR 702.47c) ---
	if (item.kind === 'spell') {
		const cleaved = Boolean(item.spellMods?.cleaved);
		const giftPromised = Boolean(
			item.spellMods?.giftPromised ||
				item.giftKind ||
				(item.optionalCostCounts?.['opt:gift'] ?? 0) > 0
		);
		const hasSplice = Boolean(item.splicedCards && item.splicedCards.length > 0);
		if (cleaved || giftPromised || hasSplice) {
			const base = H().compileOptionSpellEffects(
				item.card,
				item.faceIndex ?? 0,
				Boolean(item.fused),
				cleaved,
				giftPromised,
				item.chosenModes
			);
			if (!base) return null;
			if (!hasSplice) {
				return {
					steps: base.steps,
					targets: base.targets,
					...(base.modal ? { modal: base.modal } : {}),
					unparsed: [] as []
				};
			}
			const accSteps: EffectStep[] = [...base.steps];
			const accTargets: TargetSpec[] = [...base.targets];
			for (const spCard of item.splicedCards ?? []) {
				const sp = compileSpellEffects(spCard, 0, false);
				if (!sp || sp.unparsed.length > 0) return null;
				accSteps.push(...offsetTargetIndicesInSteps(sp.steps, accTargets.length));
				accTargets.push(...sp.targets);
			}
			return {
				steps: accSteps,
				targets: accTargets,
				...(base.modal ? { modal: base.modal } : {}),
				unparsed: [] as []
			};
		}
	}
	// --- End Track P15 ---
	// --- Track P18b ---
	return withModalPrefixAndSuffixEffects(compiledStackItemEffects(item), item.chosenModes);
	// --- End Track P18b ---
}

export function stackAbilitySourceMatchesFilter(
	state: GameState,
	stk: StackItem,
	actorId: string,
	abilitySourceFilter: NonNullable<TargetSpec['filter']['abilitySourceFilter']>,
	source?: CardInstance,
	stackItem?: StackItem
): boolean {
	if (stk.kind !== 'activated' && stk.kind !== 'triggered') return false;
	const liveFound = findPermanentOnBoard(state, stk.sourceInstanceId);
	let srcObj: CardInstance;
	if (liveFound && !liveFound.inst.phasedOut) {
		srcObj = liveFound.inst;
	} else {
		const foundAny = findCardAnywhere(state, stk.sourceInstanceId);
		if (foundAny) {
			srcObj = foundAny.inst;
		} else {
			srcObj = createCardInstance(
				stk.card,
				stk.controllerId,
				'battlefield',
				false,
				false,
				0
			);
			srcObj.instanceId = stk.sourceInstanceId;
			srcObj.controllerId = stk.controllerId;
			if (stk.faceIndex !== undefined) srcObj.activeFaceIndex = stk.faceIndex;
		}
	}
	return matchesObjectFilter(srcObj, abilitySourceFilter, {
		state,
		controllerId: actorId,
		source,
		stackItem
	});
}
// --- End Track P10 ---

export function recordUsedModalModes(
	perm: CardInstance | undefined,
	expectedVersion: number | undefined,
	modal: ModalDef | undefined,
	chosenModes: number[] | undefined
): void {
	if (
		!perm ||
		// --- Track P18b ---
		(!modal?.oncePerTurnUnique && !modal?.unchosenPermanent) ||
		// --- End Track P18b ---
		!chosenModes?.length ||
		(perm.zone !== 'battlefield' && perm.zone !== 'hand') ||
		(expectedVersion !== undefined && perm.objectVersion !== expectedVersion)
	) {
		return;
	}
	// --- Track P18b ---
	recordChosenModalModesOnPermanent(perm, modal, chosenModes);
	// --- End Track P18b ---
}

export function modalCandidateModeStatus(
	state: GameState,
	controllerId: string,
	sourceCard: ScryfallCard,
	sourceInst: CardInstance | undefined,
	modal: ModalDef,
	usedModes: number[] | undefined,
	activeSpecFilter: (sp: TargetSpec) => boolean = () => true
): { disabledIndices: number[]; legalModes: number[] } {
	const disabledIndices: number[] = [];
	const legalModes: number[] = [];
	for (let i = 0; i < modal.modes.length; i++) {
		// --- Track P18b ---
		if ((modal.oncePerTurnUnique || modal.unchosenPermanent) && usedModes?.includes(i)) {
			disabledIndices.push(i);
			continue;
		}
		// --- End Track P18b ---
		const modeSpecs = modal.modes[i].targets.filter(activeSpecFilter);
		const hasLegal = modeSpecs.every(
			(spec) => spec.min <= 0 || H().specTargetCandidates(state, controllerId, sourceCard, sourceInst, spec).length >= spec.min
		);
		if (hasLegal) legalModes.push(i);
		else disabledIndices.push(i);
	}
	return { disabledIndices, legalModes };
}

export function getModalDisabledIndices(
	state: GameState,
	actorId: string,
	sourceCard: ScryfallCard,
	sourceInst: CardInstance | undefined,
	modal: ModalDef,
	usedModes?: number[]
): number[] {
	return modalCandidateModeStatus(state, actorId, sourceCard, sourceInst, modal, usedModes).disabledIndices;
}

export function hasLegalModalCombination(modal: ModalDef, legalModes: number[]): boolean {
	if (modal.min === 0 || modal.upTo) return true;
	// --- Track P18b ---
	if (modal.pawprintBudget !== undefined && modal.pawprintCosts?.length) {
		return legalModes.some((idx) => (modal.pawprintCosts![idx] ?? 99) <= modal.pawprintBudget!);
	}
	if (modal.allowRepeat && !modal.oncePerTurnUnique && !modal.unchosenPermanent) return legalModes.length > 0;
	// --- End Track P18b ---
	return legalModes.length >= modal.min;
}

// --- Track P18b: Deferred opponent modal legality check & resolution handler (CR 700.2e) ---
const P18B_OPPONENT_MODAL_HANDLER = 'p18b_opponent_modal_choice';

export function validateDeferredOpponentModalChoice(
	state: GameState,
	actorId: string,
	sourceCard: ScryfallCard,
	sourceInst: CardInstance | undefined,
	modal: ModalDef,
	activeSpecFilter: (sp: TargetSpec) => boolean = () => true,
	usedModes?: number[]
): { ok: true } | { ok: false; error: string } {
	const status = modalCandidateModeStatus(
		state,
		actorId,
		sourceCard,
		sourceInst,
		modal,
		usedModes,
		activeSpecFilter
	);
	const targetlessLegal = status.legalModes.filter((idx) =>
		(modal.modes[idx]?.targets ?? []).filter(activeSpecFilter).every((sp) => sp.min <= 0)
	);
	if (!hasLegalModalCombination(modal, targetlessLegal)) {
		return {
			ok: false,
			error: `No legal modes can be chosen for ${sourceCard.name} (CR 700.2b).`
		};
	}
	return { ok: true };
}

registerPromptHandler(P18B_OPPONENT_MODAL_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const stackItemId = typeof data?.stackItemId === 'string' ? data.stackItemId : null;
	if (!stackItemId) return;
	const item = state.stack.find((s) => s.id === stackItemId);
	if (!item) return;
	item.chosenModes = answer.kind === 'chooseMode' ? [...answer.indices] : [];
	if (item.kind === 'activated') {
		const foundPerm = findPermanentOnBoard(state, item.sourceInstanceId);
		const abModal = getAbilityModal(
			item.card,
			item.abilityId ?? '',
			item.faceIndex ?? 0,
			item.grantSourceCard,
			item.grantFaceIndex,
			item.grantedAbilityText
		);
		recordUsedModalModes(foundPerm?.inst, item.sourceObjectVersion, abModal, item.chosenModes);
	}
	if (!stackItemAwaitsPrompt(state, item)) {
		resumeStackItem(state, item);
	}
});
// --- End Track P18b ---

export function validateModalChoice(
	state: GameState,
	actorId: string,
	sourceCard: ScryfallCard,
	sourceInst: CardInstance | undefined,
	modal: ModalDef,
	providedModes: number[] | undefined,
	targets: TargetRef[],
	activeSpecFilter: (sp: TargetSpec) => boolean = () => true,
	usedModes?: number[],
	chooseAllModes = false,
	// --- Track P18b ---
	xValue = 0,
	// --- End Track P18b ---
	// --- Track P22c ---
	castConditionCheck?: (cond: Condition) => boolean
	// --- End Track P22c ---
):
	| { ok: true; chosenModes: number[]; targetsBySpec: TargetRef[][] }
	| { ok: false; error: string } {
	let chosenModes = providedModes;
	const modalInitCtx: FilterContext = {
		state,
		controllerId: actorId,
		source: sourceInst,
		xValue
	};
	// --- Track P18b: Random mode selection ("Choose one at random —") ---
	if (isModalRandomActive(modal, modalInitCtx, evaluateCondition) && !chosenModes) {
		const status = modalCandidateModeStatus(
			state,
			actorId,
			sourceCard,
			sourceInst,
			modal,
			usedModes,
			activeSpecFilter
		);
		if (status.legalModes.length > 0) {
			const rIdx = Math.floor(nextRandom(state) * status.legalModes.length) % status.legalModes.length;
			chosenModes = [status.legalModes[rIdx]];
		}
	}
	// --- End Track P18b ---
	if (chooseAllModes) {
		const allModeIndices = modal.modes.map((_, idx) => idx);
		if (!chosenModes) {
			chosenModes = allModeIndices;
		} else if (
			!Array.isArray(chosenModes) ||
			chosenModes.length !== allModeIndices.length ||
			chosenModes.some((m, idx) => m !== idx)
		) {
			return {
				ok: false,
				error: `Choosing all modes of ${sourceCard.name} requires all ${modal.modes.length} modes in printed order (CR 702.42b).`
			};
		}
	} else if (!chosenModes && modal.max === 1) {
		// "Choose one" call without naming the mode: pick the first unused mode whose targets fit.
		const fit = modal.modes.findIndex((m, idx) => {
			if ((modal.oncePerTurnUnique || modal.unchosenPermanent) && usedModes?.includes(idx)) return false;
			const mTargets = m.targets.filter(activeSpecFilter);
			const minT = mTargets.reduce((s, sp) => s + sp.min, 0);
			const maxT = mTargets.reduce((s, sp) => s + sp.max, 0);
			if (targets.length < minT || targets.length > maxT) return false;
			let cur = 0;
			return mTargets.every((spec) => {
				const count = spec.min === spec.max ? spec.min : Math.min(spec.max, targets.length - cur);
				const slice = targets.slice(cur, cur + count);
				cur += count;
				if (new Set(slice.map((t) => `${t.kind}:${t.id}`)).size !== slice.length) return false;
				const cands = H().specTargetCandidates(state, actorId, sourceCard, sourceInst, spec);
				return slice.every((t) => cands.some((c) => c.kind === t.kind && c.id === t.id));
			});
		});
		if (fit >= 0) chosenModes = [fit];
		else if (modal.min === 0 && targets.length === 0) chosenModes = [];
	}

	// --- Track P18b: Dynamic modal bounds, conditional choose-all, & pawprint budget ---
	const modalEvalCtx: FilterContext = {
		state,
		controllerId: actorId,
		source: sourceInst,
		xValue
	};
	const evalModalCond = (cond: Condition): boolean =>
		castConditionCheck ? castConditionCheck(cond) : evaluateCondition(cond, modalEvalCtx);
	const condChooseAllMet = Boolean(
		modal.conditionalChooseAll && evalModalCond(modal.conditionalChooseAll)
	);
	const condChooseRangeMet = Boolean(
		modal.conditionalChooseRange && evalModalCond(modal.conditionalChooseRange.condition)
	);
	const evaluatedDynMax =
		modal.dynamicMax && modal.dynamicMax.k !== 'x'
			? evaluateAmount(modal.dynamicMax, modalEvalCtx)
			: undefined;
	const bounds = resolveWave8ModalEffectiveBounds(
		modal,
		chooseAllModes,
		xValue,
		evaluatedDynMax,
		condChooseRangeMet
	);
	const effectiveMin = bounds.min;
	const effectiveMax = condChooseAllMet ? Math.max(bounds.max, modal.modes.length) : bounds.max;
	// --- End Track P18b ---

	if (
		!chooseAllModes &&
		(!Array.isArray(chosenModes) ||
			chosenModes.length < effectiveMin ||
			chosenModes.length > effectiveMax ||
			(!modal.allowRepeat && new Set(chosenModes).size !== chosenModes.length) ||
			chosenModes.some((m) => !Number.isInteger(m) || m < 0 || m >= modal.modes.length))
	) {
		return {
			ok: false,
			error: `Choose ${effectiveMin}–${effectiveMax} mode(s) for ${sourceCard.name}.`
		};
	}
	if (!Array.isArray(chosenModes)) {
		return {
			ok: false,
			error: `Choose ${effectiveMin}–${effectiveMax} mode(s) for ${sourceCard.name}.`
		};
	}

	// --- Track P18b (CR 700.2i / CR 607.2d) ---
	const pawCheck = validatePawprintBudget(modal, chosenModes);
	if (!pawCheck.ok) {
		return { ok: false, error: pawCheck.reason ?? `Exceeded pawprint budget for ${sourceCard.name}.` };
	}
	if ((modal.oncePerTurnUnique || modal.unchosenPermanent) && usedModes?.length) {
		const dup = chosenModes.find((m) => usedModes.includes(m));
		if (dup !== undefined) {
			return {
				ok: false,
				error: modal.unchosenPermanent
					? `Mode ${dup + 1} of ${sourceCard.name} has already been chosen.`
					: `Mode ${dup + 1} of ${sourceCard.name} has already been chosen this turn.`
			};
		}
	}
	// --- End Track P18b ---

	const allSpecs: { modeIndex: number; spec: TargetSpec; active: boolean }[] = [];
	for (let modeIndex = 0; modeIndex < chosenModes.length; modeIndex++) {
		const m = chosenModes[modeIndex];
		for (const spec of modal.modes[m].targets) {
			allSpecs.push({ modeIndex, spec, active: activeSpecFilter(spec) });
		}
	}

	const activeEntries = allSpecs.filter((e) => e.active);
	const minRequired = activeEntries.reduce((sum, r) => sum + r.spec.min, 0);
	const maxAllowed = activeEntries.reduce((sum, r) => sum + r.spec.max, 0);
	if (targets.length < minRequired || targets.length > maxAllowed) {
		return {
			ok: false,
			error: `${sourceCard.name} requires ${minRequired === maxAllowed ? minRequired : `${minRequired}–${maxAllowed}`} target(s) for the chosen mode(s).`
		};
	}

	const counts = activeEntries.map((r) => r.spec.min);
	let extra = targets.length - minRequired;
	for (let k = 0; k < activeEntries.length && extra > 0; k++) {
		const add = Math.min(extra, activeEntries[k].spec.max - counts[k]);
		if (add > 0) {
			counts[k] += add;
			extra -= add;
		}
	}

	const targetsBySpec: TargetRef[][] = [];
	let activeCursor = 0;
	let targetCursor = 0;
	for (const entry of allSpecs) {
		if (!entry.active) {
			targetsBySpec.push([]);
			continue;
		}
		const count = counts[activeCursor++];
		const slice = targets.slice(targetCursor, targetCursor + count);
		targetCursor += count;
		const uniqueInSpec = new Set(slice.map((t) => `${t.kind}:${t.id}`));
		if (uniqueInSpec.size !== slice.length) {
			return {
				ok: false,
				error: 'Strict Rules Violation: The same object cannot be chosen multiple times for the same target requirement (CR 115.3).'
			};
		}
		const legal = H().specTargetCandidates(state, actorId, sourceCard, sourceInst, entry.spec);
		for (const t of slice) {
			if (!legal.some((c) => c.kind === t.kind && c.id === t.id)) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${t.label} is not a legal target for mode ${chosenModes[entry.modeIndex] + 1} of ${sourceCard.name}.`
				};
			}
		}
		targetsBySpec.push(slice);
	}
	// --- Track P17a: CR 115.1 Flagbearer targeting requirement on modal choices ---
	if (getRequiredFlagbearerIdsForActor(state, actorId).size > 0) {
		const flagEntries: Array<{ spec: TargetSpec; chosen: TargetRef[]; legalCandidates: TargetRef[] }> = [];
		for (let i = 0; i < allSpecs.length; i++) {
			const entry = allSpecs[i]!;
			if (!entry.active) continue;
			flagEntries.push({
				spec: entry.spec,
				chosen: targetsBySpec[i] ?? [],
				legalCandidates: H().specTargetCandidates(state, actorId, sourceCard, sourceInst, entry.spec)
			});
		}
		const fbCheck = validateFlagbearerTargets(state, actorId, flagEntries);
		if (!fbCheck.ok) return { ok: false, error: fbCheck.error! };
	}
	// --- End Track P17a ---
	// --- Track P22c ---
	const diffPlayersCheck = validateDifferentPlayerTargetsPerMode(modal, allSpecs, targetsBySpec);
	if (!diffPlayersCheck.ok) return { ok: false, error: diffPlayersCheck.error! };
	// --- End Track P22c ---
	return { ok: true, chosenModes, targetsBySpec };
}

// --- Track P10 ---
function rehydrateReflexiveBindings(
	state: GameState,
	boundRefs: SerializedBoundRef[] | undefined
): Record<string, EffectBindingSnapshot[]> | undefined {
	if (!boundRefs || boundRefs.length === 0) return undefined;
	const out: Record<string, EffectBindingSnapshot[]> = {};
	for (const ref of boundRefs) {
		const found = findCardAnywhere(state, ref.id);
		const sameObject =
			found &&
			found.zone === ref.expectedZone &&
			(found.inst.objectVersion ?? 1) === ref.objectVersion;
		// CR 400.7 & CR 608.2h: If the object changed zones/version since the reflexive trigger fired,
		// mask its live id so zone-moving instructions ignore the new object, while keeping `lki`
		// intact for LKI characteristic queries ("damage equal to that creature's power").
		(out[ref.key] ??= []).push({
			id: sameObject || !found ? ref.id : `__expired_${ref.id}`,
			lki: { ...ref.lki }
		});
	}
	return out;
}
// --- End Track P10 ---

/** The interpreter's EffectContext fields for a triggered ability's event (CR 603.7c). */
export function triggerEventContext(item: StackItem, state?: GameState) {
	// --- Track P10 ---
	const initialBindings =
		state && item.reflexiveTrigger?.boundRefs?.length
			? rehydrateReflexiveBindings(state, item.reflexiveTrigger.boundRefs)
			: undefined;
	// --- End Track P10 ---
	return {
		eventObjectId: item.eventObjectId,
		eventObjectVersion: item.eventObjectVersion,
		eventPlayerId: item.eventPlayerId,
		defendingPlayerId: item.defendingPlayerId,
		eventAmount: item.eventAmount,
		eventLki: item.eventLki,
		// --- Track P10 ---
		...(item.reflexiveTrigger?.stepPath.length
			? { stepPathPrefix: item.reflexiveTrigger.stepPath }
			: {}),
		...(initialBindings ? { initialBindings } : {})
		// --- End Track P10 ---
	};
}

function itemWard(item: StackItem): { cost: string; costDefs?: CostDef[] } | undefined {
	if (item.kind !== 'triggered') return undefined;
	if (item.triggeredAbilityIndex !== undefined && !item.grantedAbilityText && !item.grantSourceCard) {
		const compiled = runtimeTriggers(compileCard(item.card), item.faceIndex ?? 0).find(
			(x) => x.abilityIndex === item.triggeredAbilityIndex
		)?.ward;
		if (compiled) return compiled;
	}
	if (item.wardCost !== undefined) {
		const parsed = parseCost(item.wardCost);
		return { cost: item.wardCost, costDefs: parsed.defs };
	}
	return undefined;
}

function resolveWardTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	ward: { cost: string; costDefs?: CostDef[] }
): boolean {
	const srcLabel = item.isFaceDown ? (item.faceDownLabel || 'Face-Down Permanent') : item.card.name;
	const targetItem = state.stack.find((s) => s.id === (item.eventStackItemId ?? item.targets[0]?.id));
	if (!targetItem) return true;
	const opp = state.players.find((p) => p.playerId === targetItem.controllerId);
	const wardCost = (ward.cost || '{1}').trim();
	// --- Track P12: generalized Ward cost support (CR 702.21a) ---
	const singleDef = ward.costDefs && ward.costDefs.length === 1 ? ward.costDefs[0] : undefined;
	const lifeDef = singleDef?.k === 'payLife' ? singleDef : undefined;
	const lifeCost = lifeDef && lifeDef.amount.k === 'const' ? lifeDef.amount.n : undefined;
	const isComplexCost = Boolean(
		ward.costDefs &&
			ward.costDefs.length > 0 &&
			lifeCost === undefined &&
			!(singleDef?.k === 'mana')
	);
	const req = lifeCost === undefined && !isComplexCost ? parseManaCost(wardCost) : undefined;
	const wardSrc =
		isComplexCost && opp
			? (findPermanentOnBoard(state, item.sourceInstanceId)?.inst ??
				({
					instanceId: item.sourceInstanceId,
					card: item.card,
					ownerId: controller.playerId,
					controllerId: controller.playerId,
					zone: 'battlefield'
				} as CardInstance))
			: undefined;
	const wardCtx =
		isComplexCost && opp && wardSrc
			? H().costContext(state, opp, wardSrc, 0, false, null)
			: undefined;
	const canAfford = Boolean(
		opp &&
			!targetItem.declineWard &&
			(isComplexCost
				? Boolean(wardCtx && ward.costDefs && canPayCosts(wardCtx, ward.costDefs))
				: lifeCost !== undefined
					? !playerLifeTotalCantChange(state, opp) && opp.life >= lifeCost
					: req
						? H().canPayOrAutoTap(opp, req, state)
						: false)
	);
	// --- End Track P12 ---
	if (opp && !opp.isBot && canAfford && item.optionalAccepted === undefined) {
		const question = `Pay ward cost ${wardCost}?`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: opp.playerId,
			kind: 'yesNo',
			purpose: 'generic',
			title: `Ward (${srcLabel})`,
			description: question,
			yesLabel: `Pay ${wardCost}`,
			noLabel: 'Decline (counter)',
			continuation: {
				kind: 'procedure',
				procedure: {
					kind: 'ward_payment_choice',
					wardStackItemId: item.id,
					targetStackItemId: targetItem.id
				}
			},
			choice: { kind: 'yesNo', question }
		});
		return false;
	}
	let paid = false;
	if (opp && canAfford && (opp.isBot || item.optionalAccepted === true)) {
		// --- Track P12 ---
		if (isComplexCost && wardCtx && ward.costDefs) {
			const chosen = chooseCostPayment(wardCtx, ward.costDefs);
			const plan = chosen ? planCosts(wardCtx, ward.costDefs, chosen) : null;
			if (plan && plan.ok && !plan.question) {
				payPlannedCosts(wardCtx, plan);
				paid = true;
				addLog(
					state,
					'rule',
					`${opp.username} paid ${wardCost} for ${srcLabel}'s Ward (CR 702.21a).`,
					opp.playerId
				);
			}
		} else if (lifeCost !== undefined) {
			opp.life -= lifeCost;
			recordPlayerLifeLossWave4(opp, lifeCost);
			if (lifeCost > 0) onPlayerLostLifeCheckSpeedTrigger(state, opp.playerId, lifeCost);
			paid = true;
			addLog(
				state,
				'rule',
				`${opp.username} paid ${lifeCost} life for ${srcLabel}'s Ward (CR 702.21a).`,
				opp.playerId
			);
		} else if (req) {
			H().payManaWithAutoTap(opp, req, state);
			paid = true;
			addLog(
				state,
				'rule',
				`${opp.username} paid ${wardCost} for ${srcLabel}'s Ward (CR 702.21a).`,
				opp.playerId
			);
		}
		// --- End Track P12 ---
	}
	if (!paid) {
		if (
			targetItem.kind === 'spell' &&
			(spellCannotBeCountered(state, targetItem) || isSpellUncounterableByP16a(state, targetItem))
		) {
			addLog(
				state,
				'rule',
				`${targetItem.title} could not be countered by ${srcLabel}'s Ward (CR 702.21a)!`,
				controller.playerId
			);
		} else {
			const stkIdx = state.stack.indexOf(targetItem);
			if (stkIdx >= 0) {
				const [countered] = state.stack.splice(stkIdx, 1);
				const counteredFace =
					countered.kind === 'spell'
						? resolveObjectFaces(countered.card, stackItemFaceOptions(countered))
						: null;
				// --- Track P20b ---
				if (countered.kind === 'spell' && countered.controllerId !== controller.playerId) {
					if (countered.isFaceDown || counteredFace?.types.includes('Creature')) {
						const spCtrl = state.players.find((p) => p.playerId === countered.controllerId);
						if (spCtrl) {
							spCtrl.creatureSpellCounteredByOpponentThisTurn = true;
							noteLayerInputsChanged(state);
						}
					}
				}
				// --- End Track P20b ---
				moveStackSpellToZone(state, countered, 'graveyard');
				// --- Track P22b ---
				if (countered.kind === 'spell') {
					emitEvent(state, {
						kind: 'SpellCountered',
						counteredStackItemId: countered.id,
						counteredCard: countered.card,
						...(countered.faceIndex !== undefined ? { faceIndex: countered.faceIndex } : {}),
						...(countered.fused ? { fused: true } : {}),
						...(countered.isFaceDown ? { isFaceDown: true } : {}),
						...(countered.faceDownSpec ? { faceDownSpec: countered.faceDownSpec } : {}),
						...(counteredFace
							? { typeLine: counteredFace.typeLine, colors: [...counteredFace.colors] }
							: {}),
						byControllerId: controller.playerId,
						bySourceId: item.sourceInstanceId,
						bySpellOrAbility: true
					});
				}
				// --- End Track P22b ---
				addLog(
					state,
					'cast',
					`${srcLabel}'s Ward countered ${countered.title} (CR 702.21a)!`,
					controller.playerId
				);
			}
		}
	}
	return true;
}

function resolveDelayedTriggerEffect(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	eff: DelayedTriggerEffect
): 'paused' | 'done' | void {
	// --- Track P9 ---
	if (eff.kind === 'dashBounce') {
		resolveDashBounceDelayedTrigger(
			state,
			controller,
			eff.targetInstanceId,
			eff.targetObjectVersion
		);
		return 'done';
	}
	if (eff.kind === 'reboundCast') {
		return resolveReboundDelayedTrigger(
			state,
			item,
			controller,
			eff.targetInstanceId,
			eff.targetObjectVersion
		);
	}
	// --- End Track P9 ---
	if (eff.kind === 'sacrifice') {
		const found = findPermanentOnBoard(state, eff.targetInstanceId);
		if (
			found &&
			!found.inst.phasedOut &&
			(eff.byCurrentController || found.controller.playerId === controller.playerId) &&
			(eff.targetObjectVersion === undefined || found.inst.objectVersion === eff.targetObjectVersion)
		) {
			const sacPlayer = eff.byCurrentController ? found.controller : controller;
			const permName = found.inst.card.name;
			movePermanentToZone(state, found.inst, 'graveyard');
			addLog(
				state,
				'cast',
				`${sacPlayer.username} sacrificed ${permName} (${item.title}).`,
				sacPlayer.playerId
			);
		}
		return;
	}
	if (eff.kind === 'exile') {
		const found = findPermanentOnBoard(state, eff.targetInstanceId);
		if (
			found &&
			!found.inst.phasedOut &&
			(eff.targetObjectVersion === undefined || found.inst.objectVersion === eff.targetObjectVersion)
		) {
			emitVfx(state, { kind: 'exile', targetId: found.inst.instanceId, label: found.inst.card.name });
			movePermanentToZone(state, found.inst, 'exile');
			addLog(state, 'cast', `${item.title} exiled ${found.inst.card.name}.`, controller.playerId);
		}
		return;
	}
	if (eff.kind === 'warpExile') {
		const found = findPermanentOnBoard(state, eff.targetInstanceId);
		if (
			found &&
			!found.inst.phasedOut &&
			(eff.targetObjectVersion === undefined || found.inst.objectVersion === eff.targetObjectVersion)
		) {
			const targetInst = found.inst;
			emitVfx(state, { kind: 'exile', targetId: targetInst.instanceId, label: targetInst.card.name });
			movePermanentToZone(state, targetInst, 'exile');
			// CR 702.185a / 702.185b: If exiled this way, its owner may cast it after the current turn has ended.
			if (targetInst.zone === 'exile' && !targetInst.isToken) {
				targetInst.warpedByOwnerId = targetInst.ownerId;
				targetInst.warpedTurnSerial = state.turnSerial ?? state.turnNumber;
			}
			addLog(
				state,
				'cast',
				`${item.title} exiled ${targetInst.card.name} (Warp — castable from exile on a later turn).`,
				controller.playerId
			);
		}
		return;
	}
	if (eff.kind === 'lose') {
		H().loseTheGame(state, controller, `${item.title} ("you lose the game")`);
		return;
	}
	if (eff.kind === 'draw') {
		const pl = state.players.find((p) => p.playerId === eff.playerId) ?? controller;
		if (eff.upTo && !pl.isBot && !pl.lost && eff.amount > 0) {
			// "May draw up to N cards": the drawing player chooses how many (no silent default for a human).
			const question = `${item.title}: how many cards do you draw (0–${eff.amount})?`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: pl.playerId,
				kind: 'yesNo',
				title: item.title,
				description: question,
				continuation: { kind: 'handler', name: 'draw_up_to', data: { playerId: pl.playerId, source: item.title } },
				choice: { kind: 'chooseNumber', min: 0, max: eff.amount, reason: question }
			});
			return;
		}
		if (!pl.lost && eff.amount > 0) {
			H().drawCards(state, pl, eff.amount, true);
			addLog(state, 'rule', `${pl.username} drew ${eff.amount} card(s).`, controller.playerId);
		}
		return;
	}
	if (eff.kind === 'scry') {
		initiateLibraryScryOrSurveil(state, controller, item, eff.amount, 'scry', false);
		return;
	}
}

registerPromptHandler('draw_up_to', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const pl = state.players.find((p) => p.playerId === data?.playerId);
	const n = answer.kind === 'chooseNumber' ? answer.n : 0;
	if (!pl || pl.lost) return;
	if (n > 0) H().drawCards(state, pl, n, true);
	addLog(state, 'rule', `${pl.username} drew ${n} card(s) (${String(data?.source ?? '')}).`, pl.playerId);
});

/**
 * Step E2: whether a stack item comes from a card ability the engine would have to automate (an
 * instant or sorcery, an activated ability, a triggered ability of a card), as opposed to an object
 * the engine makes itself (delayed triggers it created, Ward, which is implemented as a keyword) or
 * a permanent spell (it simply enters the battlefield).
 */
function isUnautomatedStackItem(item: StackItem): boolean {
	// --- Track P12 ---
	if (item.wave4Tag) return false;
	if (
		item.abilityId &&
		/^(?:class_level_|embalm_|eternalize_|encore_)/.test(item.abilityId)
	) {
		return false;
	}
	// --- End Track P12 ---
	// --- Track P15 ---
	if (isWave5StackItem(item)) return false;
	// --- End Track P15 ---
	// --- Track P18a ---
	if (isWave6StackItem(item) || item.wave6Tag === 'epic_upkeep') return false;
	// --- End Track P18a ---
	// --- Track P19b ---
	if (isPureSpellDelayedInstantSorceryP19b(item)) return false;
	// --- End Track P19b ---
	// --- Track P22a ---
	if (item.abilityId?.startsWith('wave8_granted:')) return false;
	// --- End Track P22a ---
	// --- Wave 12 ---
	if (item.wave9Tag || item.wave9ReflexiveOnPrevented) return false;
	// --- End Wave 12 ---
	if (item.kind === 'activated') return true;
	if (item.kind === 'spell') {
		const types = resolveObjectFaces(item.card, stackItemFaceOptions(item)).types;
		return types.includes('Instant') || types.includes('Sorcery');
	}
	return (
		item.triggeredAbilityIndex !== undefined &&
		!itemWard(item) &&
		!item.delayedEffect &&
		!item.inherentTrigger &&
		// --- Track P10 ---
		!item.reflexiveTrigger
		// --- End Track P10 ---
	);
}

/**
 * Step E2: opens the guided (manual) resolution of a stack item that isn't automated. The item stays
 * on the stack until its controller is done (CR 608.2n); the prompt names it by id (plain data).
 */
function openManualResolution(state: GameState, item: StackItem, controller: PlayerGameState): void {
	item.manualResolution = 'awaiting';
	const targets = item.targets.map((t) => t.label).join(', ');
	const text = `${stackItemDisplayText(item)}${targets ? `\n\nTargets: ${targets}` : ''}`;
	const question = `${item.title} isn't automated. Apply its effect with the operations below, then finish resolving it.`;
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId: controller.playerId,
		kind: 'guided_resolution',
		purpose: 'guided_resolution',
		title: `Resolve Manually: ${item.title}`,
		description: text,
		yesLabel: 'Done: finish resolving',
		continuation: { kind: 'manual_resolution', stackItemId: item.id },
		choice: { kind: 'yesNo', question }
	});
	addLog(state, 'rule', `${item.title} isn't automated: ${controller.username} resolves it manually.`, controller.playerId);
}


/**
 * Resolves the top object of the stack. Triggered abilities that trigger while it resolves are put
 * on the stack afterwards, once state-based actions have been checked (CR 603.3, 704.3).
 */
export function resolveTopOfStack(state: GameState): void {
	const item = state.stack[state.stack.length - 1];
	if (!item) return;
	resumeStackItem(state, item);
}

/**
 * Resolves (or continues resolving) a specific stack item. A resolution that paused for a prompt
 * stays on the stack (`resolutionStarted: true`) and resumes here by id once answered; any
 * triggers that fired while it was paused stay in `state.pendingTriggers` and flush after it
 * finishes resolving and leaves the stack (CR 603.3, 608.2n).
 */
export function resumeStackItem(state: GameState, item: StackItem): void {
	if (!state.stack.includes(item)) return;
	withTriggersDeferred(state, () => resolveStackItemNow(state, item));
	flushTriggers(state);
}

/** Whether a resolving item still waits for one of its prompts (it must not resolve again meanwhile). */
export function stackItemAwaitsPrompt(state: GameState, item: StackItem): boolean {
	return state.pendingPrompts.some((p) => {
		if (p.triggerStackItemId === item.id) return true;
		const c = p.continuation;
		if (!c) return false;
		if (c.kind === 'effect_choice' || c.kind === 'effect_resume' || c.kind === 'manual_resolution') {
			return c.stackItemId === item.id;
		}
		if (c.kind === 'procedure') {
			const proc = c.procedure;
			if ('stackItemId' in proc && proc.stackItemId === item.id) return true;
			if ('wardStackItemId' in proc && proc.wardStackItemId === item.id) return true;
			if ('resumeStackItemId' in proc && proc.resumeStackItemId === item.id) return true;
			return false;
		}
		if (c.kind === 'handler') {
			return (
				c.data?.wardStackItemId === item.id ||
				c.data?.stackItemId === item.id ||
				c.data?.resumeStackItemId === item.id
			);
		}
		return false;
	});
}

function rehydrateDelayedBindings(
	state: GameState,
	boundRefs: SerializedBoundRef[]
): Record<string, EffectBindingSnapshot[]> {
	const out: Record<string, EffectBindingSnapshot[]> = {};
	for (const ref of boundRefs) {
		const found = findCardAnywhere(state, ref.id);
		// CR 603.7c & CR 400.7: Omit bound objects that changed zones or objectVersion since trigger creation.
		if (!found || found.zone !== ref.expectedZone) continue;
		if ((found.inst.objectVersion ?? 1) !== ref.objectVersion) continue;
		(out[ref.key] ??= []).push({ id: ref.id, lki: { ...ref.lki } });
	}
	return out;
}

function filterDelayedTargets(state: GameState, eff: CompiledDelayedEffect): TargetRef[] {
	return eff.targets.filter((t) => {
		if (t.kind === 'player') {
			const pl = state.players.find((p) => p.playerId === t.id);
			return Boolean(pl && !pl.lost);
		}
		if (t.kind === 'stack') return state.stack.some((s) => s.id === t.id);
		const found = findCardAnywhere(state, t.id);
		if (!found) return false;
		const expectedVer = eff.targetObjectVersions?.[t.id];
		if (expectedVer !== undefined && (found.inst.objectVersion ?? 1) !== expectedVer) return false;
		return true;
	});
}

function resolveStackItemNow(state: GameState, item: StackItem): void {
	if (stackItemAwaitsPrompt(state, item)) return;
	const resuming = Boolean(item.resolutionStarted);
	const removeItemFromStack = () => {
		const idx = state.stack.lastIndexOf(item);
		if (idx >= 0) state.stack.splice(idx, 1);
	};

	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller) {
		removeItemFromStack();
		return;
	}

	// Check intervening-if clause on resolution (CR 603.4)
	if (
		!resuming &&
		item.triggeredAbilityIndex !== undefined &&
		!stackTriggerConditionHolds(
			state,
			item.card,
			item.triggeredAbilityIndex,
			item.controllerId,
			item.sourceInstanceId,
			item
		)
	) {
		removeItemFromStack();
		addLog(
			state,
			'rule',
			`${item.title} did not resolve because its intervening-if condition is no longer met (CR 603.4).`,
			controller.playerId
		);
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}

	// Check if all targets are still legal (Fizzle rule CR 608.2b)
	if (!resuming && item.targets.length > 0) {
		const triggerSpecs = item.kind === 'triggered' ? H().triggerItemTargetSpecs(item) : [];
		const isTargetValid = (t: TargetRef) =>
			H().isTargetStillValid(state, t, item.controllerId, item.card, item) &&
			(triggerSpecs.length === 0 || H().triggerTargetStillLegal(state, item, triggerSpecs, t));
		let validTargets: TargetRef[];
		if (item.targetsBySpec) {
			let bucketSpecs: Array<TargetSpec | undefined> | undefined;
			// --- Track P18a: Mutating creature spell target spec (CR 702.140a–b) ---
			if (item.kind === 'spell' && item.spellMods?.mutating && item.targetsBySpec.length === 1) {
				bucketSpecs = [mutateTargetSpec()];
			} else if (item.kind === 'triggered' && triggerSpecs.length === item.targetsBySpec.length) {
			// --- End Track P18a ---
				bucketSpecs = triggerSpecs;
			} else if (
				!item.chosenModes &&
				!(item.card && resolveObjectFaces(item.card, stackItemFaceOptions(item)).subtypes.includes('Aura'))
			) {
				// --- Track P10 ---
				const comp = resolveStackItemCompiledEffects(item);
				// --- End Track P10 ---
				if (comp && !comp.modal && comp.targets.length > 0) {
					const itemKicker = getObjectKickerInfo(state, item.card, item.sourceInstanceId, item);
					const activeCompSpecs = comp.targets.filter(
						(sp) => !sp.condition || isConditionMetWithKicker(sp.condition, itemKicker)
					);
					if (activeCompSpecs.length === item.targetsBySpec.length) {
						bucketSpecs = activeCompSpecs;
					}
				}
			}
			item.targetsBySpec = item.targetsBySpec.map((bucket, idx) => {
				const bSpec = bucketSpecs?.[idx];
				return bucket.filter((t) => {
					if (!isTargetValid(t)) return false;
					if (!bSpec) return true;
					if (item.kind === 'triggered') {
						return H().triggerTargetCandidates(state, item, bSpec).some(
							(c) => c.kind === t.kind && c.id === t.id
						);
					}
					return H().validateTargetLegality(
						state,
						item.controllerId,
						t,
						targetRequirementFromSpecs([bSpec]),
						item.card,
						item.sourceInstanceId,
						item.kind === 'spell' ? 'spell' : 'ability',
						item.xValue
					).ok;
				});
			});
			validTargets = item.targetsBySpec.flat();
		} else {
			validTargets = item.targets.filter(isTargetValid);
		}
		// --- Track P18a: CR 702.140a–b Re-verify non-Human Creature + same owner on resolution ---
		if (item.kind === 'spell' && item.spellMods?.mutating) {
			validTargets = validTargets.filter((t) => {
				if (t.kind !== 'permanent') return false;
				const found = findPermanentOnBoard(state, t.id);
				return isMutateTargetStillLegal(state, item, found?.inst);
			});
		}
		// --- End Track P18a ---
		if (validTargets.length === 0) {
			// --- Track P18a: CR 702.140b Mutating spell with illegal target resolves as a creature spell ---
			if (item.kind === 'spell' && item.spellMods?.mutating) {
				item.spellMods = {
					...item.spellMods,
					mutating: false,
					mutateTargetId: undefined,
					mutateUnder: undefined
				};
				item.targets = [];
				item.targetsBySpec = undefined;
				addLog(
					state,
					'rule',
					`${item.title}'s mutate target became illegal; it ceases to be a mutating creature spell and resolves as a creature spell (CR 702.140b).`,
					item.controllerId
				);
			} else if (item.kind === 'spell' && item.spellMods?.bestowed) {
				// --- End Track P18a ---
				// --- Track P12: CR 702.103e Bestow ceases to be bestowed instead of being countered ---
				item.spellMods = { ...item.spellMods, bestowed: false };
				item.targets = [];
				item.targetsBySpec = undefined;
				addLog(
					state,
					'rule',
					`${item.title}'s target became illegal; it ceases to be bestowed and resolves as an Enchantment Creature (CR 702.103e).`,
					item.controllerId
				);
			} else {
				// --- End Track P12 ---
				removeItemFromStack();
				addLog(
					state,
					'rule',
					`${item.title} was countered on resolution (all targets became illegal / left the zone).`,
					item.controllerId
				);
				// CR 608.2b: If a spell is countered on resolution because all its targets are illegal,
				// it is put into its owner's graveyard (or Exile if Rest in Peace is active).
				moveStackSpellToZone(state, item, 'graveyard');
				givePriorityToActiveOrNextPlayer(state);
				state.passedPriorityPlayerIds = [];
				H().checkStateBasedActions(state);
				return;
				// --- Track P12 ---
			}
			// --- End Track P12 ---
		} else {
			item.targets = validTargets;

			// Record Last Known Information (LKI) of primary permanent target before effects move it
			if (item.targets[0]?.kind === 'permanent') {
				const foundFirst = findPermanentOnBoard(state, item.targets[0].id);
				if (foundFirst && !foundFirst.inst.phasedOut) {
					item.lkiControllerId = foundFirst.controller.playerId;
					item.lkiPower = getCreaturePower(foundFirst.inst, state);
					item.lkiToughness = getCreatureToughness(foundFirst.inst, state);
					item.lkiTypeLine = evaluatePermanent(state, foundFirst.inst).typeLine;
				}
			}
		}
	}

	if (!resuming) {
		if (item.kind === 'triggered' && state.triggersPlacedThisTurn) {
			state.triggersPlacedThisTurn.resolutionSerial = (state.triggersPlacedThisTurn.resolutionSerial ?? 0) + 1;
		}
		emitVfx(state, {
			kind: 'stack_resolve',
			sourceId: item.controllerId,
			targetId: item.targets[0]?.id,
			label: `Resolved: ${item.title}`
		});
		// From here on, a pause for a prompt resumes without repeating the checks and VFX above.
		item.resolutionStarted = true;
	}

	const ward = itemWard(item);
	if (ward) {
		if (!resolveWardTrigger(state, item, controller, ward)) return;
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	if (item.delayedEffect) {
		if (item.delayedEffect.kind === 'compiledDelayed') {
			const eff = item.delayedEffect;
			const compiled = resolveCompiledDelayedSteps(eff);
			if (compiled && staticallyInterpretable(compiled, true)) {
				const initialBindings = rehydrateDelayedBindings(state, eff.boundRefs);
				const delayedTargets = filterDelayedTargets(state, eff);
				const result = executeEffectSteps(
					state,
					{
						controller,
						sourceId: item.sourceInstanceId,
						sourceCard: eff.sourceCard,
						title: item.title,
						item,
						targets: delayedTargets,
						targetSpecs: compiled.targets,
						xValue: eff.xValue ?? item.xValue,
						...(eff.eventObjectId ? { eventObjectId: eff.eventObjectId } : {}),
						...(eff.eventObjectVersion !== undefined ? { eventObjectVersion: eff.eventObjectVersion } : {}),
						...(eff.eventPlayerId ? { eventPlayerId: eff.eventPlayerId } : {}),
						...(eff.defendingPlayerId ? { defendingPlayerId: eff.defendingPlayerId } : {}),
						...(eff.eventLki ? { eventLki: eff.eventLki } : {}),
						...(eff.stepPath.length > 0 ? { stepPathPrefix: eff.stepPath } : {}),
						initialBindings
					},
					compiled.steps,
					item.effectResume
				);
				if (result.paused) return;
				delete item.effectResume;
				if (result.turnEnded) return;
			}
			syncBattlefieldControllers(state);
			triggerPathCounts.interpreter++;
			removeItemFromStack();
			givePriorityToActiveOrNextPlayer(state);
			state.passedPriorityPlayerIds = [];
			H().checkStateBasedActions(state);
			return;
		}
		if (resolveDelayedTriggerEffect(state, item, controller, item.delayedEffect) === 'paused') {
			return;
		}
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	if (item.inherentTrigger) {
		const inh = item.inherentTrigger;
		if (inh.kind === 'monarchEndStepDraw') {
			const drawPlayer = state.players.find((p) => p.playerId === inh.drawPlayerId && !p.lost);
			if (drawPlayer) {
				H().drawCards(state, drawPlayer, 1, true);
				addLog(
					state,
					'rule',
					`${drawPlayer.username} drew a card from The Monarch (CR 726.2).`,
					drawPlayer.playerId
				);
			}
		} else if (inh.kind === 'monarchCombatDamage') {
			H().setMonarch(state, inh.newMonarchPlayerId);
		// --- Track P13 ---
		} else {
			resolveP13InherentTrigger(state, item, {
				drawCards: (pl, cnt) => {
					H().drawCards(state, pl, cnt, true);
				},
				gainLife: (s, pl, amt) => gainPlayerLife(s, pl, amt),
				loseLife: (s, pl, amt) => {
					if (amt <= 0 || pl.lost) return 0;
					if (pl.lifeTotalCannotChangeThisTurn || playerLifeTotalCantChange(s, pl.playerId)) {
						return 0;
					}
					pl.life -= amt;
					if (!pl.lostLifeThisTurn) {
						pl.lostLifeThisTurn = true;
						noteLayerInputsChanged(s);
					}
					recordPlayerLifeLossWave4(pl, amt);
					emitVfx(s, {
						kind: 'damage',
						sourceId: item.controllerId,
						targetId: pl.playerId,
						amount: amt,
						label: `-${amt} Life`
					});
					return amt;
				},
				scry: (pl, cnt) => {
					initiateLibraryScryOrSurveil(state, pl, item, cnt, 'scry', false);
				},
				goadPermanent: (perm, goaderId) => {
					const list = (perm.goadedByPlayerIds ??= []);
					if (!list.includes(goaderId)) list.push(goaderId);
					const exp = (perm.goadExpirations ??= {});
					exp[goaderId] = 'untilYourNextTurn';
					noteLayerInputsChanged(state);
				},
				createSimpleToken: (pl, spec, count = 1) => {
					for (let k = 0; k < count; k++) {
						H().createTokenOnBoard(state, pl, spec);
					}
				},
				searchBasicLandToHand: (pl) => {
					H().initiateLibrarySearch(
						state,
						pl,
						{
							statedQuality: true,
							upTo: false,
							count: 1,
							requireBasic: true,
							allowedTypes: ['Land'],
							allowedSubtypes: [],
							disallowedTypes: [],
							destinations: [{ zone: 'hand' }],
							reveal: true,
							rawCriteriaText: 'a basic land card'
						},
						item
					);
				}
			});
		}
		// --- End Track P13 ---
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}

	// --- Track P9 ---
	const wave3Res = resolveWave3StackItem(state, item, controller);
	if (wave3Res === 'paused') return;
	if (wave3Res === 'done') {
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	// --- End Track P9 ---

	// --- Track P12 ---
	const wave4Res = resolveWave4StackItem(state, item, controller, matchesObjectFilter);
	if (wave4Res === 'paused') return;
	if (wave4Res === 'done') {
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	// --- End Track P12 ---

	// --- Track P21: Cleanup sacrifice delayed trigger stack item ---
	if (item.wave5Tag === 'p21:sacrificeSelfCleanup') {
		const w7CleanRes = resolveWave7Effect(state, item, controller, 'sacrificeSelfCleanup');
		if (w7CleanRes === 'paused') return;
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		flushTriggers(state);
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	// --- End Track P21 ---

	// --- Track P15 ---
	if (isWave5StackItem(item)) {
		const wave5Res = resolveWave5StackItem(state, item);
		if (wave5Res === 'paused') return;
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	// --- End Track P15 ---

	// --- Wave 12 ---
	if (
		(item.wave9Tag || item.wave9ReflexiveOnPrevented) &&
		resolveWave9StackTriggerItem(state, item, {
			tryPayMana: (s, pl, cost) => H().payManaWithAutoTap(pl, parseManaCost(cost), s),
			createToken: (s, pl, spec) => H().createTokenOnBoard(s, pl, spec),
			dealDamage: (s, target, dmg, src, srcId, ctrlId) => {
				const sInfo = sourceDamageInfo(s, src ?? null, src?.card ?? item.card);
				if (target.kind === 'permanent') {
					const tgtPerm = findPermanentOnBoard(s, target.id)?.inst;
					if (tgtPerm) dealDamageToPermanent(s, tgtPerm, dmg, srcId, sInfo, { actorId: ctrlId });
				} else if (target.kind === 'player') {
					const tgtPl = s.players.find((p) => p.playerId === target.id);
					if (tgtPl) dealDamageToPlayer(s, tgtPl, dmg, srcId, sInfo);
				}
			},
			sacrificePermanent: (s, instanceId, objVer) => {
				const f = findPermanentOnBoard(s, instanceId);
				if (f && (objVer === undefined || f.inst.objectVersion === objVer)) {
					moveObject(s, f.inst, 'graveyard', {
						from: { player: f.controller, zone: 'battlefield' },
						sacrificedByPlayerId: f.controller.playerId
					});
				}
			}
		})
	) {
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	// --- End Wave 12 ---

	// --- Track P18a ---
	if (isWave6StackItem(item)) {
		const wave6Res = resolveWave6StackItem(state, item, controller);
		if (wave6Res === 'paused') return;
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		flushTriggers(state);
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		H().checkStateBasedActions(state);
		return;
	}
	// --- End Track P18a ---

	// A spell or ability the compiler marked supported resolves on the IR interpreter
	// (runtime/effects.ts); anything else isn't automated (below).
	// --- Track P10 & P12 ---
	let compiled =
		item.kind === 'triggered'
			? triggerItemEffect(item)
			: resolveStackItemCompiledEffects(item);
	// --- End Track P10 & P12 ---
	// --- Track P18b: Resolve deferred opponentChooses / randomMode modal choices on stack items ---
	if (compiled?.modal && !item.chosenModes) {
		const modal = compiled.modal;
		const srcPerm = findPermanentOnBoard(state, item.sourceInstanceId)?.inst;
		const usedModes =
			srcPerm && (item.sourceObjectVersion === undefined || srcPerm.objectVersion === item.sourceObjectVersion)
				? getEffectiveUsedModalModes(modal, srcPerm)
				: undefined;
		const status = modalCandidateModeStatus(
			state,
			item.controllerId,
			item.card,
			srcPerm,
			modal,
			usedModes
		);
		const defEvalCtx: FilterContext = {
			state,
			controllerId: item.controllerId,
			source: srcPerm,
			xValue: item.xValue
		};
		if (isModalRandomActive(modal, defEvalCtx, evaluateCondition) && status.legalModes.length > 0) {
			const rIdx = Math.floor(nextRandom(state) * status.legalModes.length) % status.legalModes.length;
			item.chosenModes = [status.legalModes[rIdx]];
			recordUsedModalModes(srcPerm, item.sourceObjectVersion, modal, item.chosenModes);
			compiled = item.kind === 'triggered' ? triggerItemEffect(item) : resolveStackItemCompiledEffects(item);
		} else if (modal.opponentChooses && hasLegalModalCombination(modal, status.legalModes)) {
			const oppChooser =
				state.players.find((p) => !p.lost && p.playerId !== item.controllerId) ?? controller;
			const defDynMax =
				modal.dynamicMax && modal.dynamicMax.k !== 'x'
					? evaluateAmount(modal.dynamicMax, defEvalCtx)
					: undefined;
			const bounds = resolveWave8ModalEffectiveBounds(
				modal,
				false,
				item.xValue,
				defDynMax,
				Boolean(
					modal.conditionalChooseRange &&
						evaluateCondition(modal.conditionalChooseRange.condition, defEvalCtx)
				)
			);
			if (oppChooser.isBot) {
				item.chosenModes = status.legalModes.slice(0, Math.max(1, bounds.min));
				recordUsedModalModes(srcPerm, item.sourceObjectVersion, modal, item.chosenModes);
				compiled = item.kind === 'triggered' ? triggerItemEffect(item) : resolveStackItemCompiledEffects(item);
			} else {
				const modeLabels = item.grantedAbilityText
					? describeModalModes(item.card, modal, item.faceIndex ?? 0, item.grantedAbilityText)
					: describeModalModes(
							item.grantSourceCard ?? item.card,
							modal,
							item.grantSourceCard ? (item.grantFaceIndex ?? 0) : (item.faceIndex ?? 0)
						);
				const reason =
					bounds.min === bounds.max
						? `Choose ${bounds.min} mode(s) for ${item.title}.`
						: `Choose ${bounds.min}–${bounds.max} mode(s) for ${item.title}.`;
				enqueueChoicePrompt(state, {
					id: uid('prm', state),
					playerId: oppChooser.playerId,
					kind: 'chooseMode',
					purpose: 'generic',
					title: `Choose Mode (${item.card.name})`,
					description: reason,
					continuation: {
						kind: 'handler',
						name: P18B_OPPONENT_MODAL_HANDLER,
						data: { stackItemId: item.id }
					},
					choice: {
						kind: 'chooseMode',
						modes: modeLabels,
						min: bounds.min,
						max: bounds.max,
						...(modal.allowRepeat ? { allowRepeat: true } : {}),
						...(status.disabledIndices.length > 0 ? { disabledIndices: status.disabledIndices } : {})
					}
				});
				return;
			}
		}
	}
	// --- End Track P18b ---
	const targetsBecomeEach = Boolean(item.spellMods?.targetsBecomeEach);
	const interpreted =
		!item.manualResolution &&
		compiled !== null &&
		staticallyInterpretable(compiled, item.kind === 'triggered') &&
		(item.effectResume !== undefined ||
			interpretableNow(state, item, compiled, controller, targetsBecomeEach));
	// Step E2 (plan section 2.7): a spell or ability the interpreter can't run isn't automated. A human
	// controller resolves it manually (guided operations); a bot skips it.
	if (!interpreted && isUnautomatedStackItem(item)) {
		if (!controller.isBot) {
			if (item.manualResolution !== 'done') {
				openManualResolution(state, item, controller);
				return;
			}
		} else {
			addLog(state, 'rule', `${controller.username} (bot) skipped unsupported ability ${item.title}: it isn't automated.`, controller.playerId);
		}
	}
	// --- Track P15: CR 702.174b instant/sorcery Gift delivery & CR 702.131b spell Ascend ---
	if (item.kind === 'spell' && !item.effectResume) {
		const preResolveTypes = resolveObjectFaces(item.card, stackItemFaceOptions(item)).types;
		if (preResolveTypes.includes('Instant') || preResolveTypes.includes('Sorcery')) {
			if (item.giftKind) {
				deliverPromisedGift(state, item.giftKind, item.giftRecipientId, item.card.name, controller.playerId);
			}
			checkSpellAscendOnResolve(state, item, controller);
		}
	}
	// --- End Track P15 ---
	let exiledBySelfReference = false;
	// --- Track P16a: added optional `shuffle` on librarySelf & `exileSelfWithCounters` ---
	let exileSelfWithCounters: { counter: CounterType; count: number } | undefined;
	let librarySelf: { position: 'top' | 'bottom'; fromTop?: number; shuffle?: boolean } | undefined;
	// --- End Track P16a ---
	const steps: EffectStep[] = compiled?.steps ?? [];
	// --- Track P21: Wave 7 custom effect step dispatcher ---
	const wave7Tag = steps.length === 1 ? steps[0]?.params?.wave7Effect : undefined;
	if (wave7Tag) {
		const w7Res = resolveWave7Effect(state, item, controller, wave7Tag);
		if (w7Res === 'paused') return;
	} else if (interpreted && compiled) {
		// --- Track P19b ---
		const p19bPreRng = state.rngState;
		const p19bPreEnergy = capturePlayerEnergySnapshot(state);
		const p19bPreSourcePlusOne =
			item.kind === 'triggered'
				? findPermanentOnBoard(state, item.sourceInstanceId)?.inst.counters['+1/+1'] ?? 0
				: undefined;
		const result = withActiveTapActorId(controller.playerId, () =>
			executeEffectSteps(
				state,
				{
					controller,
					sourceId: item.sourceInstanceId,
					sourceCard: item.card,
					title: item.title,
					item,
					targets: item.targets,
					targetSpecs: compiled.targets,
					xValue: item.xValue,
					targetsBecomeEach,
					...triggerEventContext(item, state)
				},
				steps,
				item.effectResume
			)
		);
		// --- End Track P19b ---
		// Step E2: a human must choose first (sacrifice, discard). The item stays on the stack with its
		// resume frame (CR 608.2n) and resolves on, by id, once the prompt is answered.
		if (result.paused) {
			// --- Track P19b ---
			emitEnergyDiffEvents(state, p19bPreEnergy);
			// --- End Track P19b ---
			return;
		}
		// --- Track P19b ---
		emitP19bPostEffectStepEvents(
			state,
			controller,
			item,
			steps,
			p19bPreRng,
			p19bPreEnergy,
			p19bPreSourcePlusOne
		);
		// --- End Track P19b ---
		delete item.effectResume;
		if (state.delayedTriggers) {
			for (const dt of state.delayedTriggers) {
				if (dt.targetInstanceId && dt.targetObjectVersion === undefined) {
					const found = findPermanentOnBoard(state, dt.targetInstanceId);
					if (found) {
						dt.targetObjectVersion = found.inst.objectVersion;
					}
				}
			}
		}
		if (result.turnEnded) return;
		exiledBySelfReference = result.exileSelf;
		// --- Track P16a ---
		exileSelfWithCounters = result.exileSelfWithCounters;
		// --- End Track P16a ---
		librarySelf = result.librarySelf;
	}

	// --- Track P12: CR 702.113a Awaken land animation & counters on resolution ---
	if (
		item.kind === 'spell' &&
		(item.spellMods?.awakenCounters ?? 0) > 0 &&
		item.awakenTargetId
	) {
		applyAwakenOnSpellResolution(state, item, controller);
	}
	// --- End Track P12 ---

	if (item.kind === 'triggered') triggerPathCounts[interpreted ? 'interpreter' : 'manual']++;

	// --- Track P18a: CR 702.140c–d / CR 731.2a–e Resolve mutating creature spell onto target ---
	if (item.kind === 'spell' && item.spellMods?.mutating) {
		const mutRes = resolveMutatingSpellOnStack(state, item, controller);
		if (mutRes === 'paused') return;
		if (mutRes === 'merged') {
			removeItemFromStack();
			registerResolvedEpicSpell(state, item, controller);
			flushTriggers(state);
			givePriorityToActiveOrNextPlayer(state);
			state.passedPriorityPlayerIds = [];
			H().checkStateBasedActions(state);
			return;
		}
	}
	// --- End Track P18a ---

	// CR 707.5: Before a Clone-style permanent spell leaves the stack to enter the battlefield,
	// a human controller chooses which creature on the battlefield (if any) it enters as a copy of.
	if (
		item.kind === 'spell' &&
		!controller.isBot &&
		item.cloneCopyChoice === undefined &&
		item.targets[0]?.kind !== 'permanent'
	) {
		// --- Track P8: Generalized Clone (CR 707.5, 707.9) ---
		const cloneSpec = findSelfCloneReplacementSpec(item.card, stackItemFaceOptions(item));
		if (cloneSpec) {
			const cloneCandidates = findLegalCloneCandidates(
				state,
				controller.playerId,
				undefined,
				cloneSpec.copyOf
			);
			if (cloneCandidates.length > 0) {
				const reasonText = cloneSpec.copyOptional
					? `You may have ${item.card.name} enter the battlefield as a copy of a matching permanent (CR 707.5).`
					: `Choose a matching permanent for ${item.card.name} to enter the battlefield as a copy of (CR 707.5).`;
				enqueueChoicePrompt(state, {
					id: uid('prm', state),
					playerId: controller.playerId,
					kind: 'chooseObjects',
					purpose: 'generic',
					title: `${item.card.name} — Choose a Permanent to Copy`,
					description: reasonText,
					continuation: {
						kind: 'procedure',
						procedure: {
							kind: 'clone_copy_choice',
							stackItemId: item.id
						}
					},
					choice: {
						kind: 'chooseObjects',
						min: cloneSpec.copyOptional ? 0 : 1,
						max: 1,
						candidates: cloneCandidates.map((c) => c.instanceId),
						defaultObjectIds: [cloneCandidates[0].instanceId],
						zone: 'battlefield',
						reason: reasonText
					}
				});
				return;
			}
		}
	}

	// CR 608.2n: As the final part of resolution, the resolving spell or ability leaves the stack.
	removeItemFromStack();
	// --- Track P22b: CR 715.2b Saga chapter resolution ---
	if (item.kind === 'triggered' && item.isChapterAbility) {
		const sagaPerm = findPermanentOnBoard(state, item.sourceInstanceId)?.inst;
		const ab =
			item.triggeredAbilityIndex !== undefined
				? compileCard(item.card).faces[item.faceIndex ?? 0]?.abilities[item.triggeredAbilityIndex]
				: undefined;
		const chapters = ab && ab.kind === 'triggered' ? (ab.trigger.chapterNumbers ?? []) : [];
		const maxCh = sagaPerm ? getSagaFinalChapterNumber(state, sagaPerm) : Math.max(0, ...chapters);
		if (sagaPerm && chapters.length > 0) {
			emitEvent(state, {
				kind: 'SagaChapterResolved',
				objectId: sagaPerm.instanceId,
				object: sagaPerm,
				controllerId: controller.playerId,
				chapterNumbers: [...chapters],
				isFinalChapter: maxCh > 0 && chapters.includes(maxCh)
			});
		}
	}
	// --- End Track P22b ---

	// If this was a spell, move it to Battlefield (for permanents; copies become tokens per CR 111.13 / 608.3f / 707.10f)
	// or Graveyard/Exile (for nontoken Instants/Sorceries).
	if (item.kind === 'spell') {
		// --- Track P18a: CR 702.50a Register Epic rest-of-game cast lock & upkeep copy ---
		registerResolvedEpicSpell(state, item, controller);
		// --- End Track P18a ---
		const stackFaceOpts = stackItemFaceOptions(item);
		const stackView = resolveObjectFaces(item.card, stackFaceOpts);
		const stackTypes = stackView.types;
		const stackSubtypes = stackView.subtypes;
		const isPermanent = stackTypes.some(
			(t) =>
				t === 'Creature' ||
				t === 'Artifact' ||
				t === 'Enchantment' ||
				t === 'Planeswalker' ||
				t === 'Battle'
		);

		const cardOwnerId = item.isCopy ? controller.playerId : item.ownerId || controller.playerId;
		const cardOwner = state.players.find((p) => p.playerId === cardOwnerId) || controller;
		const wasCommander = !item.isCopy && cardOwner.commanderNames[item.sourceInstanceId] !== undefined;
		const castCount = item.isCopy
			? 0
			: (cardOwner.commanderCastCounts?.[item.sourceInstanceId] ??
				item.commanderCastCount ??
				0);

		if (isPermanent) {
			const auraTargetId =
				stackSubtypes.includes('Aura') &&
				(item.targets[0]?.kind === 'permanent' ||
					item.targets[0]?.kind === 'player' ||
					item.targets[0]?.kind === 'graveyard_card')
					? item.targets[0].id
					: null;
			const perm = createCardInstance(
				item.card,
				cardOwnerId,
				'battlefield',
				wasCommander,
				Boolean(item.isCopy),
				0,
				item.isCopy ? state : undefined
			);
			const idTaken =
				Boolean(item.isCopy) &&
				(state.stack.some((s) => s.id !== item.id && s.sourceInstanceId === item.sourceInstanceId) ||
					Boolean(findCardAnywhere(state, item.sourceInstanceId)));
			if (!idTaken && item.sourceInstanceId) {
				perm.instanceId = item.sourceInstanceId;
			}
			perm.controllerId = controller.playerId;
			perm.defaultControllerId = controller.playerId;
			perm.commanderCastCount = castCount;
			perm.summoningSick = true;
			perm.enteredWithX = item.xValue;
			perm.manaColorsSpent = item.manaColorsSpent ? [...item.manaColorsSpent] : undefined;
			// --- Track P10 ---
			perm.manaSpentCount = item.manaSpentCount;
			// --- End Track P10 ---
			// --- Track P13 ---
			if (item.manaColorsAllSpent) perm.manaColorsAllSpent = [...item.manaColorsAllSpent];
			else delete perm.manaColorsAllSpent;
			// --- End Track P13 ---
			// --- Track P19b ---
			if (item.treasureManaSpent) perm.treasureManaSpent = true;
			else delete perm.treasureManaSpent;
			// --- End Track P19b ---
			// --- Track P21 ---
			if (item.castAtNonSorceryTiming) perm.castAtNonSorceryTiming = true;
			// --- End Track P21 ---
			const isPrototypedSpell = Boolean(
				item.spellMods?.prototyped || item.copiableState?.prototyped
			);
			const effectiveModsForKicker = isPrototypedSpell
				? { ...item.spellMods, prototyped: true }
				: item.spellMods;
			const resolvedKicker = computeKickerTracking(
				item.card,
				item.optionalCostCounts,
				{ spellMods: effectiveModsForKicker },
				item.faceIndex ?? 0,
				item.fused ?? false
			);
			perm.kickedCount = resolvedKicker.count > 0 ? resolvedKicker.count : undefined;
			perm.kickedTags = resolvedKicker.tags.length > 0 ? resolvedKicker.tags : undefined;
			perm.kickedTagCounts =
				resolvedKicker.tagCounts && Object.keys(resolvedKicker.tagCounts).length > 0
					? resolvedKicker.tagCounts
					: undefined;
			perm.evoked = item.spellMods?.evoked ? true : undefined;
			perm.escaped = item.spellMods?.escaped ? true : undefined;
			perm.foretold = item.spellMods?.foretold ? true : undefined;
			perm.blitzed = item.spellMods?.blitzed ? true : undefined;
			if (item.artifactManaSpentCount) {
				perm.artifactManaSpentCount = item.artifactManaSpentCount;
			}
			if (item.entersTappedFromZonePermission || item.spellMods?.entersTapped) {
				perm.tapped = true;
			}
			if (item.grantHasteUntilEndOfTurn || item.spellMods?.grantHasteUntilEndOfTurn) {
				(state.timedKeywordEffects ??= []).push({
					timestamp: allocateTimestamp(state),
					sourceName: item.card.name,
					controllerId: perm.controllerId || controller.playerId,
					affected: [{ instanceId: perm.instanceId, objectVersion: perm.objectVersion ?? 1 }],
					addKeywords: ['Haste']
				});
			}
			// --- Track P9 ---
			perm.dashed = item.spellMods?.dashed ? true : undefined;
			// --- End Track P9 ---
			perm.prototyped = isPrototypedSpell ? true : undefined;
			// --- Track P7 ---
			perm.wasCast = !item.isCopy ? true : undefined;
			perm.castFromZone = !item.isCopy ? item.castFromZone : undefined;
			// --- End Track P7 ---
			// --- Track P15 ---
			perm.compleatedLifePaidCount = item.phyrexianLifePaidCount
				? item.phyrexianLifePaidCount
				: undefined;
			perm.castWithImpending = item.spellMods?.impendingN ? true : undefined;
			perm.giftPromised =
				item.giftKind ||
				item.spellMods?.giftPromised ||
				(item.optionalCostCounts?.['opt:gift'] ?? 0) > 0
					? true
					: undefined;
			perm.giftRecipientId = item.giftRecipientId;
			// --- End Track P15 ---
			// Reset pre-filled loyalty so moveObject initializes loyalty with counterMultiplier (CR 306.5b)
			perm.counters.loyalty = 0;
			// --- Track P22a: CR 122.2 restore zone-persistent counters onto resolving permanent ---
			if (item.carriedCounters) {
				for (const [ck, cv] of Object.entries(item.carriedCounters)) {
					if ((cv ?? 0) > 0) perm.counters[ck as CounterType] = (perm.counters[ck as CounterType] ?? 0) + cv;
				}
			}
			// --- End Track P22a ---

			if (item.isFaceDown) {
				perm.isFaceDown = true;
				if (item.faceDownSpec) {
					perm.faceDownSpec = { ...item.faceDownSpec };
				}
				perm.faceDownLabel = item.faceDownLabel ?? allocateFaceDownLabel(state);
			} else if (item.spellMods?.convertedMttm) {
				// --- Track P15: CR 702.162a More Than Meets the Eye enters converted (back face up) ---
				perm.activeFaceIndex = 1;
				perm.transformed = true;
				// --- End Track P15 ---
			} else if (item.faceIndex !== undefined) {
				perm.activeFaceIndex = item.faceIndex;
				// CR 702.146b / CR 712.8c: A transforming DFC cast transformed (e.g. via Disturb) enters transformed.
				if (
					item.faceIndex === 1 &&
					(item.spellMods?.castTransformed ||
						item.card.layout === 'transform' ||
						Boolean(item.card.backFace))
				) {
					perm.transformed = true;
				}
			}
			if (item.copiableState) {
				perm.copiableState = JSON.parse(JSON.stringify(item.copiableState)) as CopiableState;
				perm.copiableCard = item.copiableState.card;
			}
			// CR 709.5d: A Room permanent cast as a spell enters with the chosen half's door unlocked.
			if (stackSubtypes.includes('Room')) {
				perm.unlockedFaces = [item.faceIndex ?? 0];
			}

			// --- Track P8: Generalized Clone (CR 707.2, 707.5, 707.9) ---
			const cloneSpec = findSelfCloneReplacementSpec(item.card, stackFaceOpts);
			if (cloneSpec) {
				const cloneCandidates = findLegalCloneCandidates(
					state,
					controller.playerId,
					perm,
					cloneSpec.copyOf
				);
				let targetPerm: CardInstance | undefined;
				if (item.cloneCopyChoice !== undefined) {
					targetPerm = item.cloneCopyChoice
						? cloneCandidates.find((c) => c.instanceId === item.cloneCopyChoice)
						: undefined;
					if (!targetPerm && !cloneSpec.copyOptional) {
						targetPerm = cloneCandidates[0];
					}
				} else if (item.targets[0]?.kind === 'permanent') {
					targetPerm = findPermanentOnBoard(state, item.targets[0].id)?.inst;
				} else {
					targetPerm = cloneCandidates[0];
				}
				if (targetPerm) {
					const displayName = applyCopiedPermanentToInstance(
						perm,
						targetPerm,
						cloneSpec.copyModifications,
						item.card,
						state
					);
					// --- Track P20a ---
					applyWave7CopyModificationExtras(perm, cloneSpec.copyModifications);
					// --- End Track P20a ---
					applyWave9CopyModificationExtras(perm, cloneSpec.copyModifications, state);
					if (cloneSpec.tapped) {
						perm.tapped = true;
					}
					addLog(
						state,
						'cast',
						`${item.card.name} entered the battlefield as a copy of ${displayName} (CR 707.2).`,
						controller.playerId
					);
				}
			} else {
				applyGraveyardCopyEtbWave9(state, perm, controller.playerId, applyCopiedPermanentToInstance);
			}

			if (auraTargetId) {
				attachObject(state, perm, auraTargetId);
				// --- Track P12: CR 702.103b Bestow Aura designation on battlefield ---
				if (item.spellMods?.bestowed) {
					perm.isBestowed = true;
				}
				// --- End Track P12 ---
			}
			const enteredName = perm.isFaceDown
				? perm.faceDownLabel || 'Face-Down Permanent'
				: resolveObjectFaces(
						effectiveCardForObject(perm),
						instanceFaceOptions(perm, 'battlefield')
					).name;
			applySelfEtbReplacements(state, perm);
			// --- Track P17b: Static alt-cast ETB counters ("enters with an additional <c> counter on it") ---
			if (item.spellMods?.altCastEnterCounters) {
				applyAltCastEnterCountersWave6(state, perm, item.spellMods.altCastEnterCounters);
			}
			// --- End Track P17b ---
			// --- Track P17a: CR 614.1c static alt-cast entersWithCounters ---
			if (item.spellMods?.entersWithCounters) {
				for (const [cKey, cAmt] of Object.entries(item.spellMods.entersWithCounters)) {
					if (cAmt > 0) addCountersToPermanent(state, perm, cKey as CounterType, cAmt);
				}
			}
			// --- End Track P17a ---
			if (item.opalPalaceBonusCounters && item.opalPalaceBonusCounters > 0) {
				addCountersToPermanent(state, perm, '+1/+1', item.opalPalaceBonusCounters);
			}
			if (
				(controller.nextCreatureSpellBonusPlusCounters ?? 0) > 0 &&
				stackView.types.includes('Creature')
			) {
				const bonus = controller.nextCreatureSpellBonusPlusCounters!;
				controller.nextCreatureSpellBonusPlusCounters = 0;
				addCountersToPermanent(state, perm, '+1/+1', bonus);
			}
			if (controller.nextArtifactSpellGainsSunburst && stackView.types.includes('Artifact')) {
				perm.grantedSunburst = true;
				controller.nextArtifactSpellGainsSunburst = false;
			}
			if (state.pendingSunburstSpellIds?.includes(item.sourceInstanceId)) {
				perm.grantedSunburst = true;
				state.pendingSunburstSpellIds = state.pendingSunburstSpellIds.filter(
					(id) => id !== item.sourceInstanceId
				);
			}
			// --- Track P12: CR 702.190b Sneak enters tapped and attacking if in combat ---
			if (item.spellMods?.sneaked && state.combat.active) {
				perm.tapped = true;
			}
			// --- End Track P12 ---
			const moveRes = moveObject(state, perm, 'battlefield', {
				from: 'stack',
				toPlayer: controller
			});
			syncBattlefieldControllers(state);
			if (
				item.bonusLoyaltyCounters &&
				item.bonusLoyaltyCounters > 0 &&
				perm.zone === 'battlefield'
			) {
				addCountersToPermanent(state, perm, 'loyalty', item.bonusLoyaltyCounters);
			}
			// --- Track P12: CR 702.190b Sneak enters attacking the returned attacker's defender ---
			if (item.spellMods?.sneaked && perm.zone === 'battlefield') {
				placeSneakedPermanentIntoCombat(state, controller, perm, item.spellMods.sneakAttackTarget);
			}
			// --- End Track P12 ---
			if (item.spellMods?.blitzed && (perm.zone === 'battlefield' || moveRes === 'pending')) {
				(state.delayedTriggers ??= []).push(
					buildBlitzSacrificeDelayedTrigger(uid('dtrig', state), controller.playerId, perm, item.card)
				);
			}
			if (item.spellMods?.warped && perm.zone === 'battlefield') {
				(state.delayedTriggers ??= []).push(
					buildWarpExileDelayedTrigger(uid('dtrig', state), controller.playerId, perm)
				);
			}
			// --- Track P9 ---
			if (item.spellMods?.dashed && (perm.zone === 'battlefield' || moveRes === 'pending')) {
				(state.delayedTriggers ??= []).push(
					buildDashBounceDelayedTrigger(
						uid('dtrig', state),
						controller.playerId,
						perm,
						item.card,
						state.turnNumber
					)
				);
			}
			// --- End Track P9 ---
			// --- Track P20a: Cleanup-step sacrifice delayed trigger ---
			if (
				item.spellMods?.sacrificeAtCleanupStep &&
				(perm.zone === 'battlefield' || moveRes === 'pending')
			) {
				(state.delayedTriggers ??= []).push({
					id: uid('dtrig', state),
					sourceInstanceId: perm.instanceId,
					sourceCard: item.card,
					controllerId: perm.controllerId || controller.playerId,
					triggerPhase: 'cleanup',
					targetInstanceId: perm.instanceId,
					targetObjectVersion: perm.objectVersion,
					delayedEffect: {
						kind: 'sacrifice',
						targetInstanceId: perm.instanceId,
						targetObjectVersion: perm.objectVersion,
						byCurrentController: true
					},
					description: `Sacrifice ${item.card.name} at the beginning of the next cleanup step.`
				});
			}
			// --- End Track P20a ---
			if (perm.zone === 'battlefield') {
				addLog(
					state,
					'cast',
					`${enteredName} entered the battlefield under ${controller.username}'s control.`,
					controller.playerId
				);
				if (stackSubtypes.includes('Aura') && perm.attachedToId) {
					const attachedTarget = findPermanentOnBoard(state, perm.attachedToId);
					if (attachedTarget) {
						emitEvent(state, {
							kind: 'Attached',
							attachmentId: perm.instanceId,
							attachment: perm,
							hostId: attachedTarget.inst.instanceId,
							host: attachedTarget.inst
						});
					}
				}
				// --- Track P13 & P15: CR 709.5h Room entering with unlocked door(s) triggers "When you unlock this door" ---
				if (stackSubtypes.includes('Room') && perm.unlockedFaces && perm.unlockedFaces.length > 0) {
					for (const doorIdx of perm.unlockedFaces) {
						emitEvent(state, {
							kind: 'DoorUnlocked',
							playerId: controller.playerId,
							objectId: perm.instanceId,
							object: perm,
							faceIndex: doorIdx
						});
					}
					const totalRoomDoors = compileCard(effectiveCardForObject(perm)).faces.filter((f) =>
						f.characteristics.subtypes.includes('Room')
					).length;
					if (totalRoomDoors >= 2 && perm.unlockedFaces.length >= totalRoomDoors) {
						emitEvent(state, {
							kind: 'RoomFullyUnlocked',
							playerId: controller.playerId,
							objectId: perm.instanceId,
							object: perm
						});
					}
				}
				// --- End Track P13 & P15 ---
				if (
					item.spellMods?.evoked &&
					!resolveObjectFaces(item.card, stackFaceOpts).keywords.some((k) => k.toLowerCase() === 'evoke')
				) {
					state.stack.push(
						withStackItemText(
							{
								id: uid('w9_evk', state),
								sourceInstanceId: perm.instanceId,
								sourceObjectVersion: perm.objectVersion,
								card: item.card,
								controllerId: perm.controllerId || controller.playerId,
								kind: 'triggered',
								title: `${enteredName} — Evoke Sacrifice`,
								targets: [],
								xValue: 0,
								requiresGuidedResolution: false,
								createdAt: allocateTimestamp(state),
								wave9Tag: 'evoke_sac'
							},
							`When ${enteredName} enters, sacrifice it unless you didn't pay its evoke cost.`
						)
					);
				}
			}
			flushTriggers(state);
		} else {
			// --- Track P19b: CR 603.7a–b register spell-created event/upkeep delayed triggers ---
			registerP19bSpellDelayedTriggers(state, item, controller.playerId, () => uid('w7dt', state));
			// --- End Track P19b ---
			if (!handleParadigmSpellPostResolve(state, item, controller) && !item.isCopy) {
			// CR 702.27a: If the buyback cost was paid, put the resolving spell into its owner's hand
			// instead of into that player's graveyard (moveStackSpellToZone still overrides with
			// exileOnLeaveStack per CR 702.34a when cast via Flashback).
			if (exiledBySelfReference || item.spellMods?.exileAdventureOnResolve) {
				const exileLenBefore = cardOwner.exile.length;
				moveStackSpellToZone(state, item, 'exile');
				// --- Track P16a: Apply counters when spell exiles itself with counters ---
				if (
					exileSelfWithCounters &&
					exileSelfWithCounters.count > 0 &&
					cardOwner.exile.length > exileLenBefore
				) {
					const exiledCard = cardOwner.exile[cardOwner.exile.length - 1];
					if (exiledCard) {
						exiledCard.counters[exileSelfWithCounters.counter] =
							(exiledCard.counters[exileSelfWithCounters.counter] ?? 0) +
							exileSelfWithCounters.count;
					}
				}
				// --- End Track P16a ---
			} else if (item.spellMods?.shuffleOmenOnResolve && !item.spellMods?.exileOnLeaveStack) {
				// --- Track P15: CR 721.3d Omen spell shuffles into owner's library on resolution ---
				moveStackSpellToZone(state, item, 'library', { position: 'top' });
				shuffleLibrary(state, cardOwner);
				addLog(
					state,
					'rule',
					`${item.title} was shuffled into ${cardOwner.username}'s library (CR 721.3d).`,
					controller.playerId
				);
				// --- End Track P15 ---
			} else if (librarySelf) {
				moveStackSpellToZone(state, item, 'library', librarySelf);
				// --- Track P16a: Shuffle resolving spell into owner's library ---
				if (librarySelf.shuffle) {
					shuffleLibrary(state, cardOwner);
					addLog(
						state,
						'rule',
						`${item.title} was shuffled into ${cardOwner.username}'s library.`,
						controller.playerId
					);
				}
				// --- End Track P16a ---
			} else if (
				!item.spellMods?.returnToHandOnResolve &&
				!item.spellMods?.exileOnLeaveStack &&
				handleCipherSpellPostResolve(state, item, controller)
			) {
				// --- Track P15: CR 702.99a Cipher exiled & encoded onto controlled creature ---
			} else if (
				// --- Track P9 + Track P17a ---
				item.castFromZone === 'hand' &&
				!item.spellMods?.returnToHandOnResolve &&
				!item.spellMods?.exileOnLeaveStack &&
				(cardHasRebound(item.card, item.faceIndex ?? 0) ||
					Boolean(item.grantedSpellKeywords?.includes('rebound')) ||
					getGrantedSpellKeywordsForSpell(
						state,
						controller.playerId,
						{
							instanceId: item.sourceInstanceId,
							card: item.card,
							ownerId: item.ownerId ?? controller.playerId,
							controllerId: controller.playerId,
							zone: 'stack',
							tapped: false,
							summoningSick: false,
							counters: {} as Record<CounterType, number>,
							isToken: false,
							damageMarked: 0,
							deathtouchDamageMarked: false,
							attachedToId: null,
							tempPowerMod: 0,
							tempToughnessMod: 0,
							grantedKeywords: [],
							usedLoyaltyThisTurn: false,
							isCommander: false,
							commanderCastCount: item.commanderCastCount ?? 0,
							transformed: false
						},
						item.faceIndex ?? 0,
						Boolean(item.fused)
					).includes('rebound'))
				// --- End Track P9 + Track P17a ---
			) {
				moveStackSpellToZone(state, item, 'exile');
				const exiledInst = cardOwner.exile.find((c) => c.instanceId === item.sourceInstanceId);
				if (exiledInst && !exiledInst.isToken) {
					(state.delayedTriggers ??= []).push(
						buildReboundDelayedTrigger(
							uid('dtrig', state),
							controller.playerId,
							exiledInst,
							item.card,
							state.turnNumber
						)
					);
				}
			} else {
				let dest: ZoneType = item.spellMods?.returnToHandOnResolve ? 'hand' : 'graveyard';
				let exiledToLink: { sourceInstanceId: string; sourceObjectVersion: number } | undefined;
				if (
					dest === 'graveyard' &&
					!item.isCopy &&
					state.exileResolvingInstantsSorceriesToSource?.length
				) {
					const spellTypes = activeCharacteristics(item.card, { faceIndex: item.faceIndex }).types;
					if (spellTypes.includes('Instant') || spellTypes.includes('Sorcery')) {
						for (const link of state.exileResolvingInstantsSorceriesToSource) {
							const srcFound = findPermanentOnBoard(state, link.sourceInstanceId);
							if (srcFound && (srcFound.inst.objectVersion ?? 1) === link.sourceObjectVersion) {
								dest = 'exile';
								exiledToLink = {
									sourceInstanceId: srcFound.inst.instanceId,
									sourceObjectVersion: link.sourceObjectVersion
								};
								break;
							}
						}
					}
				}
				moveStackSpellToZone(state, item, dest);
				if (dest === 'exile' && exiledToLink) {
					const exiledCard = cardOwner.exile.find((c) => c.instanceId === item.sourceInstanceId);
					if (exiledCard) {
						exiledCard.exiledBy = exiledToLink;
					}
				}
				// --- Track P18a: CR 702.55a Haunt on resolving Instant/Sorcery ---
				if (dest === 'graveyard') {
					maybeEnqueueSpellHauntTrigger(state, item, cardOwner, controller);
				}
				// --- End Track P18a ---
			}
			}
		}
	}

	// --- Track P10 ---
	flushTriggers(state);
	// --- End Track P10 ---
	givePriorityToActiveOrNextPlayer(state);
	state.passedPriorityPlayerIds = [];
	H().checkStateBasedActions(state);
}


// ---- Effect primitives used by the IR interpreter (runtime/effects.ts)

/** "The player whose turn it is may end the turn": ends it now for a bot or the controller. */
export function activePlayerMayEndTurn(
	state: GameState,
	controller: PlayerGameState,
	sourceName = 'Ability'
): void {
	const activePlayer = state.players[state.activePlayerIndex];
	if (!activePlayer) return;
	if (activePlayer.playerId === controller.playerId || activePlayer.isBot) {
		// Active player is controller (or a bot): end the turn immediately!
		H().endTheTurnImmediately(state, activePlayer.playerId);
	} else {
		const description = `${controller.username} activated ${sourceName}. As the player whose turn it is, you may end the turn now (exiling all spells and abilities from the stack).`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: activePlayer.playerId,
			kind: 'yesNo',
			purpose: 'end_turn',
			title: `End the Turn? (${sourceName})`,
			description,
			yesLabel: 'End the Turn Now',
			noLabel: 'Decline (Keep Playing Turn)',
			continuation: {
				kind: 'procedure',
				procedure: {
					kind: 'end_turn',
					actorId: activePlayer.playerId,
					sourceName
				}
			},
			choice: {
				kind: 'yesNo',
				question: description
			}
		});
	}
}

/** Builds Layer 1a copiable card and CopiableState from a target permanent (CR 707.2, 707.8a, 707.9a–d, 708.2, 712.6d, 719.3d). */
function buildCopiedPermanentFields(
	// --- Track P7 ---
	state: GameState,
	// --- End Track P7 ---
	target: CardInstance,
	notLegendary = false,
	exceptPT?: { power: number; toughness: number },
	isTokenCopy = false,
	// --- Track P7 ---
	copyMod?: CopyModificationSpec
	// --- End Track P7 ---
): {
	baseCardToCopy: ScryfallCard;
	copiableState: CopiableState;
	displayName: string;
} {
	// --- Track P7 ---
	const mergedMod: CopyModificationSpec | undefined =
		copyMod || notLegendary || exceptPT
			? {
					...copyMod,
					...(notLegendary
						? {
								removeSupertypes: Array.from(
									new Set([...(copyMod?.removeSupertypes ?? []), 'Legendary'])
								)
							}
						: {}),
					...(exceptPT
						? {
								power: exceptPT.power,
								toughness: exceptPT.toughness
							}
						: {})
				}
			: undefined;
	return buildModifiedCopiableState(state, target, mergedMod, isTokenCopy);
	// --- End Track P7 ---
}

/** "Create a token that's a copy of ..." (CR 707.2, CR 707.8a, CR 707.9a–d: copiable values + transforming DFC token support). */
export function copyPermanentAsToken(
	state: GameState,
	controller: PlayerGameState,
	original: CardInstance,
	sourceName: string,
	notLegendary = false,
	exceptPT?: { power: number; toughness: number },
	// --- Track P7 ---
	copyMod?: CopyModificationSpec,
	copyOpts?: { tapped?: boolean; tappedAndAttacking?: boolean }
	// --- End Track P7 ---
): CardInstance {
	const { baseCardToCopy, copiableState, displayName } = buildCopiedPermanentFields(
		// --- Track P7 ---
		state,
		// --- End Track P7 ---
		original,
		notLegendary,
		exceptPT,
		true,
		// --- Track P7 ---
		copyMod
		// --- End Track P7 ---
	);
	const tokenInst = createCardInstance(
		baseCardToCopy,
		controller.playerId,
		'battlefield',
		false,
		true,
		allocateTimestamp(state),
		state
	);
	tokenInst.copiableState = copiableState;
	tokenInst.copiableCard = baseCardToCopy;
	const origFaceIdx = activeFaceIndexForObject(original);
	if (
		!copiableState.isSingleFaceCopy &&
		baseCardToCopy.layout === 'transform' &&
		(original.transformed || origFaceIdx > 0)
	) {
		tokenInst.transformed = true;
		tokenInst.activeFaceIndex = origFaceIdx > 0 ? origFaceIdx : 1;
	}
	if (copiableState.prototyped) {
		tokenInst.prototyped = true;
	}
	tokenInst.summoningSick = true;
	// --- Track P7 ---
	if (copyOpts?.tapped || copyOpts?.tappedAndAttacking) {
		tokenInst.tapped = true;
	}
	applySelfEtbReplacements(state, tokenInst);
	// --- End Track P7 ---
	moveObject(state, tokenInst, 'battlefield', { from: 'none', toPlayer: controller });
	// --- Track P7 ---
	if (copyOpts?.tappedAndAttacking && tokenInst.zone === 'battlefield') {
		registerEnteredAttackingCombatant(state, controller, tokenInst);
	}
	// --- End Track P7 ---
	addLog(
		state,
		'trigger',
		`${sourceName} created a token copy of ${displayName}!`,
		controller.playerId
	);
	flushTriggers(state);
	return tokenInst;
}

/** Counters `target` unless it can't be countered. Returns true if it was countered. */
export function counterStackItemByEffect(
	state: GameState,
	item: StackItem,
	candidate: StackItem,
	controller: PlayerGameState,
	// --- Track P10 ---
	replacementZone?: 'exile' | 'libraryTop' | 'libraryBottom'
	// --- End Track P10 ---
): boolean {
	if (spellCannotBeCountered(state, candidate) || isSpellUncounterableByP16a(state, candidate)) {
		addLog(
			state,
			'rule',
			`${candidate.title} cannot be countered by ${item.title}!`,
			controller.playerId
		);
		return false;
	}
	const stkIdx = state.stack.indexOf(candidate);
	if (stkIdx < 0) return false;
	const [countered] = state.stack.splice(stkIdx, 1);
	const counteredFace =
		countered.kind === 'spell'
			? resolveObjectFaces(countered.card, stackItemFaceOptions(countered))
			: null;
	// --- Track P20b ---
	if (countered.kind === 'spell' && countered.controllerId !== controller.playerId) {
		if (countered.isFaceDown || counteredFace?.types.includes('Creature')) {
			const spCtrl = state.players.find((p) => p.playerId === countered.controllerId);
			if (spCtrl) {
				spCtrl.creatureSpellCounteredByOpponentThisTurn = true;
				noteLayerInputsChanged(state);
			}
		}
	}
	// --- End Track P20b ---
	// --- Track P10 ---
	if (replacementZone === 'exile') {
		moveStackSpellToZone(state, countered, 'exile');
	} else if (replacementZone === 'libraryTop') {
		moveStackSpellToZone(state, countered, 'library', { position: 'top' });
	} else if (replacementZone === 'libraryBottom') {
		moveStackSpellToZone(state, countered, 'library', { position: 'bottom' });
	} else {
		moveStackSpellToZone(state, countered, 'graveyard');
	}
	// --- End Track P10 ---
	// --- Track P22b ---
	if (countered.kind === 'spell') {
		emitEvent(state, {
			kind: 'SpellCountered',
			counteredStackItemId: countered.id,
			counteredCard: countered.card,
			...(countered.faceIndex !== undefined ? { faceIndex: countered.faceIndex } : {}),
			...(countered.fused ? { fused: true } : {}),
			...(countered.isFaceDown ? { isFaceDown: true } : {}),
			...(countered.faceDownSpec ? { faceDownSpec: countered.faceDownSpec } : {}),
			...(counteredFace
				? { typeLine: counteredFace.typeLine, colors: [...counteredFace.colors] }
				: {}),
			byControllerId: controller.playerId,
			bySourceId: item.sourceInstanceId,
			bySpellOrAbility: true
		});
	}
	// --- End Track P22b ---
	emitVfx(state, {
		kind: 'counter_spell',
		sourceId: controller.playerId,
		targetId: countered.controllerId,
		label: `Countered ${countered.title}!`
	});
	addLog(state, 'cast', `${item.title} countered ${countered.title}!`, controller.playerId);
	return true;
}

/** CR 506.4 / 701.19a: Removes a permanent from combat (as attacker and/or blocker). */
function removePermanentFromCombat(state: GameState, instanceId: string): void {
	if (!state.combat.active) return;
	state.combat.attackers = state.combat.attackers.filter((a) => a.attackerInstanceId !== instanceId);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((id) => id !== instanceId);
	}
	if (state.combat.dealtFirstStrikeDamageIds) {
		state.combat.dealtFirstStrikeDamageIds = state.combat.dealtFirstStrikeDamageIds.filter(
			(id) => id !== instanceId
		);
	}
	noteLayerInputsChanged(state);
}

/**
 * CR 701.19a / CR 614.8: If `perm` has a regeneration shield and can be regenerated this turn,
 * consumes 1 shield, removes all damage marked on it, taps it, and removes it from combat.
 */
export function tryRegenerateInsteadOfDestroy(
	state: GameState,
	perm: CardInstance,
	canBeRegenerated = true
): boolean {
	if (!canBeRegenerated || perm.cantBeRegeneratedThisTurn) return false;
	const shields = perm.regenerationShields ?? 0;
	// --- Track P20a ---
	if (shields <= 0 && !hasActiveSelfRegenerateOnDestroy(state, perm)) return false;
	if (shields > 0) {
		perm.regenerationShields = shields - 1 > 0 ? shields - 1 : undefined;
	}
	// --- End Track P20a ---
	perm.damageMarked = 0;
	perm.deathtouchDamageMarked = false;
	tapPermanent(state, perm);
	removePermanentFromCombat(state, perm.instanceId);
	addLog(state, 'rule', `${perm.card.name} regenerated instead of being destroyed.`);
	return true;
}

/** Destroy (CR 701.7) by a spell or ability: indestructible, regeneration, then dies triggers. */
export function destroyPermanentByEffect(
	state: GameState,
	inst: CardInstance,
	title: string,
	actorId: string,
	canBeRegenerated = true
): MoveResult | 'skipped' {
	if (hasKeyword(inst, 'Indestructible', state)) {
		addLog(state, 'rule', `${inst.card.name} is Indestructible and was not destroyed.`);
		return 'skipped';
	}
	const found = findPermanentOnBoard(state, inst.instanceId);
	if (!found) return 'skipped';
	if (tryRegenerateInsteadOfDestroy(state, inst, canBeRegenerated)) {
		return 'skipped';
	}
	// --- Track P12: CR 702.89a Umbra armor replacement ---
	if (tryUmbraArmorInsteadOfDestroy(state, inst)) {
		return 'skipped';
	}
	// --- End Track P12 ---
	// --- Track P20b ---
	const wasCreatureBeforeDestroy = evaluatePermanent(state, inst).isCreature;
	const destroyedPermControllerId = inst.controllerId;
	// --- End Track P20b ---
	emitVfx(state, { kind: 'destroy', targetId: inst.instanceId, label: inst.card.name });
	const dest = movePermanentToZone(state, inst, 'graveyard');
	// --- Track P20b ---
	if (
		dest !== 'pending' &&
		!wasCreatureBeforeDestroy &&
		actorId &&
		destroyedPermControllerId &&
		actorId !== destroyedPermControllerId
	) {
		const permCtrl = state.players.find((p) => p.playerId === destroyedPermControllerId);
		if (permCtrl) {
			permCtrl.noncreatureDestroyedByOpponentThisTurn = true;
			noteLayerInputsChanged(state);
		}
	}
	// --- End Track P20b ---
	addLog(state, 'cast', `${title} destroyed ${inst.card.name}.`, actorId);
	if (dest !== 'pending') {
		flushTriggers(state);
	}
	return dest;
}

/** Scry N, surveil N, or "look at the top N cards, then put them back in any order": bot decision or prompt. */
export function initiateLibraryScryOrSurveil(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	amount: number,
	mode: 'scry' | 'rearrange' | 'surveil',
	mayShuffle: boolean
): void {
	if (amount <= 0) return;
	const count = Math.min(amount, controller.library.length);
	if (count <= 0) {
		if (mode === 'surveil') {
			addLog(
				state,
				'rule',
				`${controller.username} surveilled ${amount} (library is empty).`,
				controller.playerId
			);
			emitEvent(state, {
				kind: 'Surveilled',
				playerId: controller.playerId,
				count: amount,
				graveyardCount: 0
			});
			flushTriggers(state);
		} else if (mode === 'scry') {
			// --- Track P10 ---
			addLog(
				state,
				'rule',
				`${controller.username} scried ${amount} (library is empty).`,
				controller.playerId
			);
			emitEvent(state, {
				kind: 'Scried',
				playerId: controller.playerId,
				amount
			});
			flushTriggers(state);
			// --- End Track P10 ---
		}
		return;
	}
	if (mode === 'scry' || mode === 'surveil') {
		const isSurveil = mode === 'surveil';
		if (controller.isBot) {
			const topCards = controller.library.slice(0, count);
			const { topIds, bottomIds } = pickScryOrSurveilSplit(controller, topCards, state);
			const byId = new Map(topCards.map((c) => [c.instanceId, c]));
			const keepTop = topIds.map((id) => byId.get(id)!).filter(Boolean);
			const moveOther = bottomIds.map((id) => byId.get(id)!).filter(Boolean);
			if (isSurveil) {
				rearrangeLibrary(controller, keepTop, keepTop, []);
				state.pendingProcedure = {
					kind: 'surveil_graveyard',
					actorId: controller.playerId,
					remainingIds: moveOther.map((c) => c.instanceId),
					nextIndex: 0,
					surveilCount: count,
					topCount: keepTop.length,
					graveyardCount: moveOther.length
				};
				H().advanceSurveilGraveyardProcedure(state);
			} else {
				rearrangeLibrary(controller, topCards, keepTop, moveOther);
				addLog(
					state,
					'rule',
					`${controller.username} scried ${count} (${keepTop.length} on top, ${moveOther.length} on bottom).`,
					controller.playerId
				);
				// --- Track P10 ---
				emitEvent(state, {
					kind: 'Scried',
					playerId: controller.playerId,
					amount: count
				});
				flushTriggers(state);
				// --- End Track P10 ---
			}
		} else {
			const topCards = controller.library.slice(0, count);
			const topIds = topCards.map((c) => c.instanceId);
			const description = isSurveil
				? `Look at the top ${count} card(s) of your library. Put any number into your graveyard and the rest back on top in any order.`
				: `Look at the top ${count} card(s) of your library. Put any number on the bottom in any order and the rest on top in any order.`;
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'scry_choice',
				purpose: 'scry_choice',
				title: isSurveil ? `Surveil ${count} (${item.card.name})` : `Scry ${count} (${item.card.name})`,
				description,
				countRequired: count,
				candidateInstanceIds: topIds,
				allowBottom: true,
				...(isSurveil ? { splitMode: 'graveyard' as const } : {}),
				allowShuffle: false,
				choice: {
					kind: 'orderObjects',
					objectIds: topIds,
					allowSplitBottom: true,
					...(isSurveil ? { splitLabel: 'graveyard' as const } : {}),
					allowShuffle: false,
					reason: description
				}
			});
		}
	} else {
		if (controller.isBot) {
			const topCards = controller.library.slice(0, count);
			const landCount =
				controller.battlefield.filter((b) => evaluatePermanent(state, b).isLand).length +
				controller.hand.filter((h) =>
					resolveObjectFaces(effectiveCardForObject(h), instanceFaceOptions(h, 'hand')).types.includes(
						'Land'
					)
				).length;
			topCards.sort((a, b) => {
				const aLand = resolveObjectFaces(
					effectiveCardForObject(a),
					instanceFaceOptions(a, 'library')
				).types.includes('Land')
					? 1
					: 0;
				const bLand = resolveObjectFaces(
					effectiveCardForObject(b),
					instanceFaceOptions(b, 'library')
				).types.includes('Land')
					? 1
					: 0;
				return landCount < 3 ? bLand - aLand : aLand - bLand;
			});
			rearrangeLibrary(controller, topCards, topCards, []);
			addLog(
				state,
				'rule',
				`${controller.username} rearranged the top ${count} card(s) of their library.`,
				controller.playerId
			);
		} else {
			const topCards = controller.library.slice(0, count);
			const topIds = topCards.map((c) => c.instanceId);
			const description = `Look at the top ${count} card(s) of your library and put them back on top in any order.${mayShuffle ? ' Or you may shuffle your library.' : ''}`;
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'scry_choice',
				purpose: 'scry_choice',
				title: `Rearrange Top ${count} (${item.card.name})`,
				description,
				countRequired: count,
				candidateInstanceIds: topIds,
				allowBottom: false,
				allowShuffle: Boolean(mayShuffle),
				choice: {
					kind: 'orderObjects',
					objectIds: topIds,
					allowSplitBottom: false,
					allowShuffle: Boolean(mayShuffle),
					reason: description
				}
			});
		}
	}
}

function findSourceCardForOptionalCost(state: GameState, item: StackItem): CardInstance {
	for (const zone of ['battlefield', 'graveyard', 'exile', 'hand', 'command', 'library'] as const) {
		for (const pl of state.players) {
			const inst = pl[zone].find((c) => c.instanceId === item.sourceInstanceId);
			if (inst) return inst;
		}
	}
	const base = createCardInstance(item.card, item.controllerId, 'stack', false, false, 0);
	return { ...base, instanceId: item.sourceInstanceId };
}

function buildOptionalCostContext(
	state: GameState,
	player: PlayerGameState,
	item: StackItem
): CostContext {
	const source = findSourceCardForOptionalCost(state, item);
	return H().costContext(state, player, source, item.xValue ?? 0, false, null, undefined, {
		isSpell: false
	});
}

export function canPayOptionalCost(
	state: GameState,
	player: PlayerGameState,
	item: StackItem,
	defs: CostDef[]
): boolean {
	return canPayCosts(buildOptionalCostContext(state, player, item), defs);
}

export function payOptionalCost(
	state: GameState,
	player: PlayerGameState,
	item: StackItem,
	stepIndex: number,
	defs: CostDef[],
	answers: Record<string, ChoiceAnswer>,
	pending?: EffectResumeFrame['pendingOptionalCost']
): PayOptionalCostResult {
	const ctx = buildOptionalCostContext(state, player, item);
	if (pending && pending.stepIndex === stepIndex) {
		if (!pending.tapsAndManaDone) {
			payTapAndManaCostParts(ctx, pending.parts, null, pending.descriptions);
			pending.tapsAndManaDone = true;
		}
		const promptsBefore = state.pendingPrompts.length;
		const paid = executeCostPaymentParts(
			ctx,
			pending.parts,
			pending.nextPartIndex,
			pending.nextObjectIndex,
			pending.descriptions
		);
		if (paid.paused) {
			return {
				status: 'paused',
				pending: {
					...pending,
					nextPartIndex: paid.nextPartIndex ?? pending.nextPartIndex,
					nextObjectIndex: paid.nextObjectIndex ?? pending.nextObjectIndex
				},
				queued: state.pendingPrompts.slice(promptsBefore)
			};
		}
		addLog(
			state,
			'cast',
			`${player.username} paid ${describeCost(defs)} for ${item.card.name}${pending.descriptions.length > 0 ? ` (${pending.descriptions.join('; ')})` : ''}.`,
			player.playerId
		);
		return { status: 'paid' };
	}

	let payment: CostPayment | undefined;
	if (player.isBot) {
		const chosen = chooseCostPayment(ctx, defs);
		if (!chosen) return { status: 'failed' };
		payment = chosen;
	} else {
		const objects: string[][] = [];
		for (let qIdx = 0; qIdx < defs.length + 4; qIdx++) {
			const ans = answers[`__opt_cost_${stepIndex}_obj_${qIdx}`];
			if (ans?.kind === 'chooseObjects') {
				objects[qIdx] = ans.objectIds;
			} else {
				break;
			}
		}
		// --- Track P19a: Support `choice` ("pays {B} or {3}", "sacrifice ... or discard ...") optional costs ---
		const options: number[] = [];
		for (let qIdx = 0; qIdx < defs.length + 4; qIdx++) {
			const optAns = answers[`__opt_cost_${stepIndex}_opt_${qIdx}`];
			if (optAns?.kind === 'chooseMode' && optAns.indices[0] !== undefined) {
				options[qIdx] = optAns.indices[0];
			} else {
				break;
			}
		}
		if (objects.length > 0 || options.length > 0) {
			payment = {
				...(objects.length > 0 ? { objects } : {}),
				...(options.length > 0 ? { options } : {})
			};
		}
		// --- End Track P19a ---
	}

	const plan = planCosts(ctx, defs, payment);
	if (!plan.ok) return { status: 'failed' };
	if (plan.question) {
		if (player.isBot) return { status: 'failed' };
		// --- Track P19a ---
		if (plan.question.kind === 'option') {
			return {
				status: 'needOptionChoice',
				answerKey: `__opt_cost_${stepIndex}_opt_${plan.question.index}`,
				labels: plan.question.labels
			};
		}
		// --- End Track P19a ---
		if (plan.question.kind !== 'objects') return { status: 'failed' };
		return {
			status: 'needChoice',
			answerKey: `__opt_cost_${stepIndex}_obj_${plan.question.index}`,
			zone: inferObjectsZone(player, plan.question.candidateIds),
			label: plan.question.label,
			count: plan.question.count,
			// --- Track P22d ---
			...(plan.question.maxCount !== undefined ? { maxCount: plan.question.maxCount } : {}),
			// --- End Track P22d ---
			candidateIds: plan.question.candidateIds
		};
	}

	const serializedParts = serializeCostPlanParts(ctx, plan);
	const descriptions: string[] = [];
	payTapAndManaCostParts(ctx, serializedParts, plan.mana, descriptions);
	const promptsBefore = state.pendingPrompts.length;
	const paid = executeCostPaymentParts(ctx, serializedParts, 0, 0, descriptions);
	if (paid.paused) {
		return {
			status: 'paused',
			pending: {
				stepIndex,
				parts: serializedParts,
				nextPartIndex: paid.nextPartIndex ?? 0,
				nextObjectIndex: paid.nextObjectIndex ?? 0,
				descriptions,
				tapsAndManaDone: true
			},
			queued: state.pendingPrompts.slice(promptsBefore)
		};
	}
	addLog(
		state,
		'cast',
		`${player.username} paid ${describeCost(defs)} for ${item.card.name}${descriptions.length > 0 ? ` (${descriptions.join('; ')})` : ''}.`,
		player.playerId
	);
	return { status: 'paid' };
}

function stackItemTargetSpecsAndSteps(
	state: GameState,
	orig: StackItem
): { specs: TargetSpec[]; steps: EffectStep[] } {
	if (orig.kind === 'triggered') {
		if (itemWard(orig) || orig.delayedEffect || orig.inherentTrigger) return { specs: [], steps: [] };
		const eff = triggerItemEffect(orig);
		return { specs: eff?.targets ?? [], steps: eff?.steps ?? [] };
	}
	if (orig.kind === 'activated') {
		// --- Track P10 ---
		const eff = resolveStackItemCompiledEffects(orig);
		// --- End Track P10 ---
		return { specs: eff?.targets ?? [], steps: eff?.steps ?? [] };
	}
	if (orig.spellMods?.targetsBecomeEach) return { specs: [], steps: [] };
	// --- Track P10 ---
	const eff = resolveStackItemCompiledEffects(orig);
	// --- End Track P10 ---
	if (eff) {
		const kickerInfo = getObjectKickerInfo(state, orig.card, orig.sourceInstanceId, orig);
		const specs = eff.targets.filter(
			(ts) => !ts.condition || isConditionMetWithKicker(ts.condition, kickerInfo)
		);
		return { specs, steps: eff.steps };
	}
	const req = getSpellTargetRequirement(
		orig.card,
		{
			...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
			...(orig.fused !== undefined ? { fused: orig.fused } : {}),
			...(orig.spellMods ? { spellMods: orig.spellMods } : {})
		},
		orig.optionalCostCounts
	);
	return { specs: req.targetSpecs ?? [], steps: [] };
}

function distributeStackItemTargetsBySpec(orig: StackItem, specs: TargetSpec[]): TargetRef[][] {
	if (specs.length === 0) return [];
	if (orig.targetsBySpec && orig.targetsBySpec.length === specs.length) {
		return orig.targetsBySpec.map((b) => b.map((t) => ({ ...t })));
	}
	const counts = specs.map((s) => s.min);
	const minRequired = counts.reduce((sum, n) => sum + n, 0);
	let extra = Math.max(0, orig.targets.length - minRequired);
	for (let i = 0; i < specs.length && extra > 0; i++) {
		const add = Math.min(extra, Math.max(0, specs[i].max - counts[i]));
		if (add > 0) {
			counts[i] += add;
			extra -= add;
		}
	}
	const out: TargetRef[][] = [];
	let cur = 0;
	for (let i = 0; i < specs.length; i++) {
		const take = Math.min(counts[i], Math.max(0, orig.targets.length - cur));
		out.push(orig.targets.slice(cur, cur + take).map((t) => ({ ...t })));
		cur += take;
	}
	return out;
}

export function getStackItemRetargetSlots(
	state: GameState,
	orig: StackItem,
	copyControllerId: string
): StackItemRetargetSlot[] {
	const { specs } = stackItemTargetSpecsAndSteps(state, orig);
	if (specs.length === 0) return [];
	const bySpec = distributeStackItemTargetsBySpec(orig, specs);
	const sourceObj = orig.kind === 'spell' ? undefined : H().triggerSourceObject(state, orig);
	const sourceCard = orig.copiableState?.card ?? orig.card;
	return specs.map((spec, idx) => {
		const cands = H().specTargetCandidates(state, copyControllerId, sourceCard, sourceObj, spec).filter(
			(c) => !(c.kind === 'stack' && c.id === orig.id)
		);
		const zone: ZoneType | 'player' =
			spec.kind === 'player' ? 'player' : ((spec.filter.zone as ZoneType | undefined) ?? 'battlefield');
		return {
			spec,
			originalTargets: bySpec[idx] ?? [],
			legalCandidates: cands,
			zone
		};
	});
}

export function validateStackItemRetarget(
	state: GameState,
	orig: StackItem,
	copyControllerId: string,
	targetsBySpec: TargetRef[][]
): boolean {
	const slots = getStackItemRetargetSlots(state, orig, copyControllerId);
	if (targetsBySpec.length !== slots.length) return false;
	for (let i = 0; i < slots.length; i++) {
		const sl = slots[i];
		const chosen = targetsBySpec[i] ?? [];
		const uniq = new Set(chosen.map((t) => `${t.kind}:${t.id}`));
		if (uniq.size !== chosen.length) return false;
		const unchangedSlot =
			chosen.length === sl.originalTargets.length &&
			chosen.every((x, idx) => x.kind === sl.originalTargets[idx]?.kind && x.id === sl.originalTargets[idx]?.id);
		if (unchangedSlot) continue;
		if (chosen.length < sl.spec.min || chosen.length > sl.spec.max) return false;
		for (const t of chosen) {
			const keptOriginal = sl.originalTargets.some((o) => o.kind === t.kind && o.id === t.id);
			const isLegalNew = sl.legalCandidates.some((c) => c.kind === t.kind && c.id === t.id);
			if (!keptOriginal && !isLegalNew) return false;
		}
	}
	return true;
}

export function chooseBotStackItemRetarget(
	state: GameState,
	bot: PlayerGameState,
	orig: StackItem,
	slots: StackItemRetargetSlot[],
	copyIndex: number
): { targets: TargetRef[]; targetsBySpec: TargetRef[][] } {
	const { steps } = stackItemTargetSpecsAndSteps(state, orig);
	const targetsBySpec: TargetRef[][] = slots.map((sl, sIdx) => {
		if (sl.spec.min > 0 && sl.legalCandidates.length < sl.spec.min) {
			return sl.originalTargets.map((t) => ({ ...t }));
		}
		const ranked = H().chooseBotTriggerTargets(state, bot, steps, sIdx, sl.spec, sl.legalCandidates);
		if (ranked.length < sl.spec.min) {
			return sl.originalTargets.map((t) => ({ ...t }));
		}
		if (copyIndex > 0 && sl.spec.min === 1 && sl.spec.max === 1 && ranked[0]?.kind === 'permanent') {
			const firstFound = findPermanentOnBoard(state, ranked[0].id);
			if (firstFound && firstFound.controller.playerId !== bot.playerId) {
				const oppPerms = sl.legalCandidates.filter((c) => {
					if (c.kind !== 'permanent') return false;
					const f = findPermanentOnBoard(state, c.id);
					return Boolean(f && f.controller.playerId !== bot.playerId);
				});
				if (oppPerms.length > 1) {
					return [{ ...oppPerms[copyIndex % oppPerms.length] }];
				}
			}
		}
		return ranked.map((t) => ({ ...t }));
	});
	if (validateStackItemRetarget(state, orig, bot.playerId, targetsBySpec)) {
		return { targets: targetsBySpec.flat(), targetsBySpec };
	}
	const fallbackBySpec = slots.map((sl) => sl.originalTargets.map((t) => ({ ...t })));
	return { targets: orig.targets.map((t) => ({ ...t })), targetsBySpec: fallbackBySpec };
}

export function pushCopiedStackItem(
	state: GameState,
	controller: PlayerGameState,
	orig: StackItem,
	targets: TargetRef[],
	targetsBySpec: TargetRef[][] | undefined,
	opts?: { exceptColors?: ManaColor[]; nonLegendary?: boolean }
): StackItem {
	let copiableState: CopiableState | undefined = orig.copiableState
		? (JSON.parse(JSON.stringify(orig.copiableState)) as CopiableState)
		: undefined;
	const origPrototyped = Boolean(orig.spellMods?.prototyped || orig.copiableState?.prototyped);
	if (opts?.exceptColors !== undefined || opts?.nonLegendary || origPrototyped) {
		const base: CopiableState = copiableState ?? {
			card: orig.card,
			...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
			...(orig.fused !== undefined ? { fused: orig.fused } : {}),
			...(origPrototyped ? { prototyped: true } : {})
		};
		if (origPrototyped) {
			base.prototyped = true;
		}
		if (opts?.exceptColors !== undefined || opts?.nonLegendary) {
			base.except = { ...(base.except ?? {}) };
			if (opts.exceptColors !== undefined) {
				base.except.colors = [...opts.exceptColors];
			}
			if (opts.nonLegendary) {
				const rem = new Set(base.except.removeSupertypes ?? []);
				rem.add('Legendary');
				base.except.removeSupertypes = [...rem];
			}
		}
		copiableState = base;
	}

	const copyCard = copiableState?.card ?? orig.card;
	const targetObjectVersions = H().captureTargetObjectVersions(state, targets);
	// --- Track P7 ---
	let copiedTargetDivisions: Record<string, number> | undefined;
	if (orig.targetDivisions && Object.keys(orig.targetDivisions).length > 0) {
		if (
			targets.length === orig.targets.length &&
			targets.every((t, idx) => orig.targets[idx]?.id === t.id)
		) {
			copiedTargetDivisions = { ...orig.targetDivisions };
		} else if (targets.length === orig.targets.length) {
			copiedTargetDivisions = {};
			for (let idx = 0; idx < targets.length; idx++) {
				const origAmt = orig.targetDivisions[orig.targets[idx]?.id ?? ''];
				if (origAmt !== undefined) {
					copiedTargetDivisions[targets[idx].id] = origAmt;
				}
			}
		} else {
			const total = Object.values(orig.targetDivisions).reduce((a, b) => a + b, 0);
			const norm = validateAndNormalizeTargetDivisions(
				targets,
				total,
				undefined,
				0,
				targets.length,
				orig.card.name
			);
			if (norm.ok && Object.keys(norm.divisions).length > 0) {
				copiedTargetDivisions = norm.divisions;
			}
		}
	}
	// --- End Track P7 ---

	if (orig.kind === 'spell') {
		const copyInstanceId = uid('copy', state);
		const copyItem: StackItem = withStackItemText(
			{
				id: uid('stk', state),
				sourceInstanceId: copyInstanceId,
				sourceObjectVersion: 1,
				card: copyCard,
				...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
				...(orig.fused ? { fused: true } : {}),
				...(orig.isFaceDown
					? {
							isFaceDown: true,
							...(orig.faceDownSpec ? { faceDownSpec: { ...orig.faceDownSpec } } : {}),
							...(orig.faceDownLabel ? { faceDownLabel: orig.faceDownLabel } : {})
						}
					: {}),
				...(copiableState ? { copiableState } : {}),
				ownerId: controller.playerId,
				controllerId: controller.playerId,
				kind: 'spell',
				title: `${orig.card.name} (Copy)`,
				targets: targets.map((t) => ({ ...t })),
				...(targetsBySpec
					? { targetsBySpec: targetsBySpec.map((b) => b.map((t) => ({ ...t }))) }
					: {}),
				// --- Track P7 ---
				...(copiedTargetDivisions ? { targetDivisions: { ...copiedTargetDivisions } } : {}),
				// --- End Track P7 ---
				...(targetObjectVersions && Object.keys(targetObjectVersions).length > 0
					? { targetObjectVersions }
					: {}),
				xValue: orig.xValue,
				...(orig.chosenModes ? { chosenModes: [...orig.chosenModes] } : {}),
				...(orig.optionalCostCounts
					? { optionalCostCounts: { ...orig.optionalCostCounts } }
					: {}),
				...(orig.spellMods ? { spellMods: { ...orig.spellMods } } : {}),
				// --- Track P15: CR 702.47c / CR 702.174h copy Splice & Gift decisions ---
				...(orig.splicedCards ? { splicedCards: [...orig.splicedCards] } : {}),
				...(orig.giftKind
					? {
							giftKind: orig.giftKind,
							...(orig.giftRecipientId && orig.giftRecipientId !== controller.playerId
								? { giftRecipientId: orig.giftRecipientId }
								: {
										giftRecipientId: state.players.find(
											(p) => !p.lost && p.playerId !== controller.playerId
										)?.playerId
									})
						}
					: {}),
				// --- End Track P15 ---
				// --- Track P19a (CR 707.10): Copy sacrificed-cost LKI onto copied spell ---
				...(orig.sacrificedCostLki?.length
					? {
							sacrificedCostLki: orig.sacrificedCostLki.map((e) => ({
								...e,
								colors: [...e.colors],
								types: [...e.types],
								subtypes: [...e.subtypes]
							}))
						}
					: {}),
				// --- End Track P19a ---
				...(orig.removedCounterCount !== undefined
					? { removedCounterCount: orig.removedCounterCount }
					: {}),
				requiresGuidedResolution: orig.requiresGuidedResolution,
				isCopy: true,
				createdAt: Date.now()
			},
			stackItemDisplayText(orig)
		);
		state.stack.push(copyItem);
		const dummyObj: CardInstance = {
			instanceId: copyInstanceId,
			objectVersion: 1,
			card: orig.card,
			...(copiableState ? { copiableState, copiableCard: copiableState.card } : {}),
			...(origPrototyped ? { prototyped: true } : {}),
			ownerId: controller.playerId,
			controllerId: controller.playerId,
			defaultControllerId: controller.playerId,
			zone: 'stack',
			tapped: false,
			summoningSick: false,
			damageMarked: 0,
			deathtouchDamageMarked: false,
			tempPowerMod: 0,
			tempToughnessMod: 0,
			grantedKeywords: [],
			attachedToId: null,
			counters: createEmptyCounters(),
			isCommander: false,
			commanderCastCount: 0,
			usedLoyaltyThisTurn: false,
			transformed: false,
			isToken: false,
			enteredTimestamp: allocateTimestamp(state)
		};
		emitEvent(state, {
			kind: 'SpellCopied',
			playerId: controller.playerId,
			objectId: copyInstanceId,
			object: dummyObj
		});
		for (const t of copyItem.targets) {
			const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
			if (targeted && !targeted.inst.phasedOut) {
				emitEvent(state, {
					kind: 'BecameTarget',
					objectId: t.id,
					object: targeted.inst,
					by: 'spell',
					controllerId: controller.playerId,
					stackItemId: copyItem.id
				});
			}
		}
		flushTriggers(state);
		addLog(
			state,
			'cast',
			`${controller.username} copied ${orig.card.name} on the stack${copyItem.targets.length > 0 ? ` targeting ${copyItem.targets.map((t) => t.label).join(', ')}` : ''} (CR 707.10).`,
			controller.playerId
		);
		return copyItem;
	}

	// CR 707.10b: A copy of an activated or triggered ability has the same source as the original ability.
	const copyItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: orig.sourceInstanceId,
			...(orig.sourceObjectVersion !== undefined
				? { sourceObjectVersion: orig.sourceObjectVersion }
				: {}),
			...(orig.sourceLkiPower !== undefined ? { sourceLkiPower: orig.sourceLkiPower } : {}),
			...(orig.sourceLkiToughness !== undefined
				? { sourceLkiToughness: orig.sourceLkiToughness }
				: {}),
			...(orig.sourceKickedCount !== undefined
				? { sourceKickedCount: orig.sourceKickedCount }
				: {}),
			...(orig.sourceKickedTags ? { sourceKickedTags: [...orig.sourceKickedTags] } : {}),
			...(orig.sourceKickedTagCounts
				? { sourceKickedTagCounts: { ...orig.sourceKickedTagCounts } }
				: {}),
			...(orig.sourceEvoked ? { sourceEvoked: true } : {}),
			...(orig.sourceEscaped ? { sourceEscaped: true } : {}),
			...(orig.sourceForetold ? { sourceForetold: true } : {}),
			...(orig.sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(orig.sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(orig.sourceChosenSubType ? { sourceChosenSubType: orig.sourceChosenSubType } : {}),
			...(orig.sourceChosenColor ? { sourceChosenColor: orig.sourceChosenColor } : {}),
			...(orig.sourceMonstrous ? { sourceMonstrous: true } : {}),
			...(orig.sourcePrototyped ? { sourcePrototyped: true } : {}),
			// --- Track P7 ---
			...(orig.sourceWasCast ? { sourceWasCast: true } : {}),
			...(orig.sourceCastFromZone ? { sourceCastFromZone: orig.sourceCastFromZone } : {}),
			// --- End Track P7 ---
			card: orig.card,
			...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
			...(orig.isFaceDown
				? {
						isFaceDown: true,
						...(orig.faceDownSpec ? { faceDownSpec: { ...orig.faceDownSpec } } : {}),
						...(orig.faceDownLabel ? { faceDownLabel: orig.faceDownLabel } : {})
					}
				: {}),
			controllerId: controller.playerId,
			kind: orig.kind,
			title: `${orig.title} (Copy)`,
			targets: targets.map((t) => ({ ...t })),
			...(targetsBySpec
				? { targetsBySpec: targetsBySpec.map((b) => b.map((t) => ({ ...t }))) }
				: {}),
			// --- Track P7 ---
			...(copiedTargetDivisions ? { targetDivisions: { ...copiedTargetDivisions } } : {}),
			// --- End Track P7 ---
			...(targetObjectVersions && Object.keys(targetObjectVersions).length > 0
				? { targetObjectVersions }
				: {}),
			xValue: orig.xValue,
			...(orig.abilityId ? { abilityId: orig.abilityId } : {}),
			...(orig.grantSourceCard ? { grantSourceCard: orig.grantSourceCard } : {}),
			...(orig.grantFaceIndex !== undefined ? { grantFaceIndex: orig.grantFaceIndex } : {}),
			...(orig.grantAbilityIndex !== undefined ? { grantAbilityIndex: orig.grantAbilityIndex } : {}),
			...(orig.crewedByIds ? { crewedByIds: [...orig.crewedByIds] } : {}),
			...(orig.saddledByIds ? { saddledByIds: [...orig.saddledByIds] } : {}),
			...(orig.tappedCostPower !== undefined ? { tappedCostPower: orig.tappedCostPower } : {}),
			...(orig.stationTappedId ? { stationTappedId: orig.stationTappedId } : {}),
			...(orig.stationTappedVersion !== undefined
				? { stationTappedVersion: orig.stationTappedVersion }
				: {}),
			...(orig.triggeredAbilityIndex !== undefined
				? { triggeredAbilityIndex: orig.triggeredAbilityIndex }
				: {}),
			...(orig.grantedKeyword ? { grantedKeyword: orig.grantedKeyword } : {}),
			// --- Track P10 ---
			...(orig.grantedAbilityText ? { grantedAbilityText: orig.grantedAbilityText } : {}),
			...(orig.reflexiveTrigger
				? { reflexiveTrigger: JSON.parse(JSON.stringify(orig.reflexiveTrigger)) }
				: {}),
			// --- End Track P10 ---
			...(orig.delayedEffect ? { delayedEffect: orig.delayedEffect } : {}),
			...(orig.inherentTrigger ? { inherentTrigger: { ...orig.inherentTrigger } } : {}),
			...(orig.wardCost !== undefined ? { wardCost: orig.wardCost } : {}),
			...(orig.chosenModes ? { chosenModes: [...orig.chosenModes] } : {}),
			...(orig.eventObjectId ? { eventObjectId: orig.eventObjectId } : {}),
			...(orig.eventObjectVersion !== undefined
				? { eventObjectVersion: orig.eventObjectVersion }
				: {}),
			...(orig.eventPlayerId ? { eventPlayerId: orig.eventPlayerId } : {}),
			...(orig.defendingPlayerId ? { defendingPlayerId: orig.defendingPlayerId } : {}),
			...(orig.eventAmount !== undefined ? { eventAmount: orig.eventAmount } : {}),
			...(orig.eventStackItemId ? { eventStackItemId: orig.eventStackItemId } : {}),
			...(orig.eventLki ? { eventLki: { ...orig.eventLki } } : {}),
			...(orig.triggerEventStackItem
				? { triggerEventStackItem: JSON.parse(JSON.stringify(orig.triggerEventStackItem)) as StackItem }
				: {}),
			...(orig.stormCount !== undefined ? { stormCount: orig.stormCount } : {}),
			// --- Track P15 ---
			...(orig.gravestormCount !== undefined ? { gravestormCount: orig.gravestormCount } : {}),
			...(orig.giftKind ? { giftKind: orig.giftKind } : {}),
			...(orig.giftRecipientId ? { giftRecipientId: orig.giftRecipientId } : {}),
			...(orig.sourceGiftPromised ? { sourceGiftPromised: true } : {}),
			...(orig.sourceEnteredWithX !== undefined
				? { sourceEnteredWithX: orig.sourceEnteredWithX }
				: {}),
			...(orig.sourceCastWithImpending ? { sourceCastWithImpending: true } : {}),
			...(orig.wave5Tag ? { wave5Tag: orig.wave5Tag } : {}),
			...(orig.wave5N !== undefined ? { wave5N: orig.wave5N } : {}),
			...(orig.wave5CostText !== undefined ? { wave5CostText: orig.wave5CostText } : {}),
			...(orig.wave5Card ? { wave5Card: orig.wave5Card } : {}),
			// --- End Track P15 ---
			// --- Track P19a (CR 707.10b): Copy sacrificed-cost LKI onto copied ability ---
			...(orig.sacrificedCostLki?.length
				? {
						sacrificedCostLki: orig.sacrificedCostLki.map((e) => ({
							...e,
							colors: [...e.colors],
							types: [...e.types],
							subtypes: [...e.subtypes]
						}))
					}
				: {}),
			// --- End Track P19a ---
			...(orig.removedCounterCount !== undefined
				? { removedCounterCount: orig.removedCounterCount }
				: {}),
			requiresGuidedResolution: orig.requiresGuidedResolution,
			isCopy: true,
			createdAt: Date.now()
		},
		stackItemDisplayText(orig)
	);
	state.stack.push(copyItem);
	for (const t of copyItem.targets) {
		const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
		if (targeted && !targeted.inst.phasedOut) {
			emitEvent(state, {
				kind: 'BecameTarget',
				objectId: t.id,
				object: targeted.inst,
				by: 'ability',
				controllerId: controller.playerId,
				stackItemId: copyItem.id
			});
		}
	}
	flushTriggers(state);
	addLog(
		state,
		'cast',
		`${controller.username} copied ability ${orig.title} on the stack${copyItem.targets.length > 0 ? ` targeting ${copyItem.targets.map((t) => t.label).join(', ')}` : ''} (CR 707.10b).`,
		controller.playerId
	);
	return copyItem;
}
