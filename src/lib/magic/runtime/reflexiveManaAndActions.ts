/**
 * Track P10 — Reflexive Triggers (CR 603.12, 603.2d), CR 701 Keyword Actions, Coin Flips (CR 705),
 * Die-Roll Result Tables (CR 706), Multi-Zone Search (CR 701.23b), Generalized Attach (CR 701.3),
 * and P10 Event / Condition Helpers.
 *
 * Pure IR and GameState metadata only — zero card-name comparisons and zero runtime rules-text reads.
 */
import {
	abilityById,
	compiledTriggerEffect,
	compileSpellEffects,
	describeModalModes,
	effectOf,
	expandModalEffects,
	grantedAbilityById
} from '../compiler/index.ts';
import { compileQuotedAbilityString } from '../compiler/effects.ts';
import type {
	AbilityDef,
	Amount,
	Condition,
	CostDef,
	EffectStep,
	ModalDef,
	ObjectFilter,
	PlayerRef,
	ReflexiveTriggerSpec,
	SearchSpec,
	Span,
	TargetSpec
} from '../ir.ts';
import { withStackItemText, type ManaCostRequirement } from '../oracle.ts';
import { effectiveCardForObject, getCardFaces } from '../scryfall.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	CompiledReflexiveTrigger,
	CounterType,
	GameState,
	ManaColor,
	PendingReflexiveTrigger,
	PlayerGameState,
	ScryfallCard,
	SerializedBoundRef,
	StackItem,
	TargetRef,
	TriggerEventLki,
	ZoneType
} from '../types.ts';
import {
	chooseCostPayment,
	effectiveSpellManaCost,
	executeCostPaymentParts,
	payTapAndManaCostParts,
	planCosts,
	serializeCostPlanParts,
	spellAdditionalCost,
	spellCastRestrictions,
	type CostContext
} from './costs.ts';
import { emitEvent } from './events.ts';
import {
	activeAbilityDefs,
	effectiveManaValue,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import type { KeywordActionHost } from './keywordActions.ts';
import type { Wave3FinalizeCastOptions } from './keywordsWave3.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { evaluatePermanent } from './layers.ts';
import { matchesObjectFilter, objectManaValue } from './objectFilter.ts';
import { nextRandom } from './random.ts';
import { checkGlobalCastPermissionsAndRestrictions } from './replace.ts';
import { flushTriggers } from './triggers.ts';
import { attachObject, moveObject, rearrangeLibrary, shuffleLibrary } from './zones.ts';

// ---- Host Interfaces ------------------------------------------------------------------------

export interface P10RuntimeHost {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
	canPayOrAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState
	) => boolean;
	payManaWithAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState
	) => boolean;
	costContext: (
		state: GameState,
		player: PlayerGameState,
		source: CardInstance,
		xValue: number,
		isSpell: boolean,
		baseMana: ManaCostRequirement | null
	) => CostContext;
	specTargetCandidates: (
		state: GameState,
		actorId: string,
		sourceCard: ScryfallCard,
		sourceInst: CardInstance | undefined,
		spec: TargetSpec
	) => TargetRef[];
	finalizeCastSpell: (
		state: GameState,
		actor: PlayerGameState,
		inst: CardInstance,
		sourcePlayer: PlayerGameState,
		sourceZone: 'hand' | 'command' | 'exile' | 'graveyard',
		opts: Wave3FinalizeCastOptions
	) => void;
	assignOrPromptTriggerTargets: (
		state: GameState,
		item: StackItem,
		specs: TargetSpec[]
	) => 'ready' | 'prompted' | 'removed';
}

let p10Host: P10RuntimeHost | null = null;

export function registerP10RuntimeHost(host: P10RuntimeHost): void {
	p10Host = host;
}

function requireP10Host(): P10RuntimeHost {
	if (!p10Host) {
		throw new Error('runtime/reflexiveManaAndActions: P10RuntimeHost not registered');
	}
	return p10Host;
}

export interface P10EffectHost extends KeywordActionHost {
	readonly item: StackItem;
	readonly stepPathPrefix?: number[];
	setStepDecision(accepted: boolean): void;
	getStepDecision(idx?: number): boolean | undefined;
	setLastRollResult(n: number): void;
	getLastRollResult(): number | undefined;
	pauseForYesNo(
		chooser: PlayerGameState,
		title: string,
		question: string,
		answerKey: string,
		labels?: { yesLabel: string; noLabel: string }
	): void;
	pauseForMode(
		chooser: PlayerGameState,
		title: string,
		description: string,
		modes: string[],
		min: number,
		max: number,
		answerKey: string,
		defaultIndices?: number[]
	): void;
	pauseForWeightedChoice(
		chooser: PlayerGameState,
		title: string,
		description: string,
		candidates: string[],
		min: number,
		max: number,
		zone: ZoneType,
		weightsById: Record<string, number>,
		minWeightSum: number,
		weightLabel: string,
		defaultObjectIds: string[],
		answerKey: string
	): void;
	pauseForSplitOrder(
		chooser: PlayerGameState,
		title: string,
		description: string,
		objectIds: string[],
		allowSplitBottom: boolean,
		answerKey: string
	): void;
	runInlineSteps(steps: EffectStep[], subPathTag: number): boolean;
	captureBoundRefs(): SerializedBoundRef[];
}

// ---- Shared Helpers -------------------------------------------------------------------------

function resolveActors(host: P10EffectHost, step: EffectStep): PlayerGameState[] {
	if (step.subject.k === 'player' || step.subject.k === 'playerRef') {
		return host.players(step.subject).filter((pl) => !pl.lost);
	}
	if (step.actor) {
		const pl = host.playerRef(step.actor);
		return pl && !pl.lost ? [pl] : [];
	}
	return host.you.lost ? [] : [host.you];
}

function apnapPlayersFromState(state: GameState): PlayerGameState[] {
	const n = state.players.length;
	if (n === 0) return [];
	const start = (((state.activePlayerIndex ?? 0) % n) + n) % n;
	const out: PlayerGameState[] = [];
	for (let i = 0; i < n; i++) {
		const pl = state.players[(start + i) % n];
		if (pl && !pl.lost) out.push(pl);
	}
	return out;
}

function shuffleDeterministic<T>(state: GameState, items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom(state) * (i + 1));
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

// ---- Quoted Ability Resolution Helpers ------------------------------------------------------

export function resolveQuotedActivatedOrTriggeredSteps(
	abilityText: string,
	cardName: string,
	kind: 'activated' | 'triggered',
	chosenModes?: number[]
): { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef; unparsed: Span[] } | null {
	const defs = compileQuotedAbilityString(abilityText, cardName);
	for (const ab of defs) {
		if (kind === 'activated' && ab.kind === 'activated') {
			const base = effectOf(ab);
			if (!base) return null;
			const resolved = base.modal && chosenModes ? expandModalEffects(base.modal, chosenModes) : base;
			if (!resolved) return null;
			return {
				steps: resolved.steps,
				targets: resolved.targets,
				...(base.modal ? { modal: base.modal } : {}),
				unparsed: []
			};
		}
		if (kind === 'triggered' && ab.kind === 'triggered') {
			const base = effectOf(ab);
			if (!base) return null;
			const resolved = base.modal && chosenModes ? expandModalEffects(base.modal, chosenModes) : base;
			if (!resolved) return null;
			return {
				steps: resolved.steps,
				targets: resolved.targets,
				...(base.modal ? { modal: base.modal } : {}),
				unparsed: []
			};
		}
	}
	return null;
}

export function resolveQuotedAbilityDefs(abilityText: string, cardName: string): AbilityDef[] {
	return compileQuotedAbilityString(abilityText, cardName);
}

// ---- Reflexive Triggers (CR 603.12, CR 603.2d) ----------------------------------------------

/**
 * Dynamically recompiles the parent ability and traverses `ref.stepPath` to recover the
 * `ReflexiveTriggerSpec` without storing IR (`EffectStep[]` / `TargetSpec[]`) in `GameState`.
 *
 * Negative sub-path tags encode nested inline branches:
 * - `-1`: `winFlipEffect`
 * - `-2`: `loseFlipEffect`
 * - `-(10 + branchIdx)`: `dieRollTable[branchIdx].effect`
 */
export function resolveReflexiveSpecFromCompiled(
	ref: CompiledReflexiveTrigger
): ReflexiveTriggerSpec | null {
	const faceIdx = ref.faceIndex ?? 0;
	let steps: EffectStep[] | null = null;

	if (ref.grantedAbilityText) {
		const quoted = resolveQuotedActivatedOrTriggeredSteps(
			ref.grantedAbilityText,
			ref.sourceCard.name,
			ref.abilityKind === 'activated' ? 'activated' : 'triggered',
			ref.chosenModes
		);
		steps = quoted?.steps ?? null;
	} else if (ref.abilityKind === 'spell') {
		const spell = compileSpellEffects(ref.sourceCard, faceIdx, ref.fused ?? false);
		const expanded =
			spell?.modal && ref.chosenModes ? expandModalEffects(spell.modal, ref.chosenModes) : spell;
		steps = expanded?.steps ?? null;
	} else if (ref.abilityKind === 'activated') {
		if (ref.abilityId) {
			const base =
				ref.grantSourceCard && ref.abilityId.startsWith('granted:')
					? effectOf(
							grantedAbilityById(
								ref.grantSourceCard,
								ref.abilityId.slice(ref.abilityId.lastIndexOf(':') + 1)
							)
						)
					: effectOf(abilityById(ref.sourceCard, ref.abilityId, faceIdx));
			const expanded =
				base?.modal && ref.chosenModes ? expandModalEffects(base.modal, ref.chosenModes) : base;
			steps = expanded?.steps ?? null;
		}
	} else if (ref.abilityKind === 'triggered') {
		if (ref.grantedKeyword || ref.abilityIndex !== undefined) {
			const trig = compiledTriggerEffect(
				ref.sourceCard,
				ref.abilityIndex ?? -1,
				ref.grantedKeyword,
				faceIdx,
				ref.chosenModes
			);
			steps = trig?.steps ?? null;
		}
	}

	if (!steps || ref.stepPath.length === 0) return null;

	let curStep: EffectStep | undefined;
	for (let i = 0; i < ref.stepPath.length; i++) {
		const idx = ref.stepPath[i];
		if (idx < 0) {
			if (!curStep) return null;
			if (idx === -1) {
				steps = curStep.params?.winFlipEffect ?? null;
			} else if (idx === -2) {
				steps = curStep.params?.loseFlipEffect ?? null;
			} else if (idx <= -10) {
				const branchIdx = -(idx + 10);
				steps = curStep.params?.dieRollTable?.[branchIdx]?.effect ?? null;
			} else {
				return null;
			}
			if (!steps) return null;
			curStep = undefined;
			continue;
		}
		curStep = steps[idx];
		if (!curStep) return null;
		if (i + 1 < ref.stepPath.length && ref.stepPath[i + 1] >= 0) {
			if (curStep.params?.reflexiveTrigger) {
				steps = curStep.params.reflexiveTrigger.effect;
				curStep = undefined;
			} else if (curStep.delayed) {
				steps = curStep.delayed.effect;
				curStep = undefined;
			} else {
				return null;
			}
		}
	}
	return curStep?.params?.reflexiveTrigger ?? null;
}

const OBJECT_ACTING_REFLEXIVE_VERBS = new Set<string>([
	'sacrifice',
	'discard',
	'exile',
	'tap',
	'untap',
	'tapOrUntap',
	'removeCounters',
	'returnToHand',
	'returnFromGraveyard',
	'putFromHand',
	'destroy'
]);

const DECISION_ACTING_REFLEXIVE_VERBS = new Set<string>([
	'forage',
	'collectEvidence',
	'blight',
	'clash',
	'discover'
]);

/**
 * CR 603.12: Evaluates whether `step`'s reflexive trigger condition occurred after `step` finished
 * executing, and if so appends a plain-JSON `PendingReflexiveTrigger` to `state.pendingReflexiveTriggers`.
 */
export function enqueueReflexiveTriggerForStep(
	host: P10EffectHost,
	step: EffectStep,
	actedObjects: CardInstance[],
	opts?: { diedObjectIds?: ReadonlySet<string>; preSnapshots?: ReadonlyMap<string, TriggerEventLki> }
): void {
	const rt = step.params?.reflexiveTrigger;
	if (!rt) return;

	const decision = host.getStepDecision(host.stepIndex);
	if (step.optional && decision === false) return;

	const filterMode = rt.eventFilter ?? 'whenYouDo';
	let matchingObjects = actedObjects;

	if (filterMode === 'diedThisWay') {
		matchingObjects = actedObjects.filter(
			(o) => opts?.diedObjectIds?.has(o.instanceId) || o.zone === 'graveyard'
		);
		if (rt.objectFilter) {
			matchingObjects = matchingObjects.filter((o) =>
				matchesObjectFilter(o, rt.objectFilter!, {
					state: host.state,
					controllerId: host.you.playerId,
					zone: 'graveyard'
				})
			);
		}
		if (matchingObjects.length === 0) return;
	} else if (
		filterMode === 'sacrificedThisWay' ||
		filterMode === 'discardedThisWay' ||
		filterMode === 'exiledThisWay' ||
		filterMode === 'removedCounterThisWay'
	) {
		if (rt.objectFilter) {
			matchingObjects = matchingObjects.filter((o) => {
				const z =
					o.zone === 'battlefield' ||
					o.zone === 'graveyard' ||
					o.zone === 'hand' ||
					o.zone === 'library'
						? o.zone
						: 'exile';
				return matchesObjectFilter(o, rt.objectFilter!, {
					state: host.state,
					controllerId: host.you.playerId,
					zone: z
				});
			});
		}
		if (matchingObjects.length === 0) return;
	} else {
		// 'whenYouDo'
		if (step.optional?.cost && step.optional.cost.length > 0) {
			if (decision !== true) return;
		} else if (DECISION_ACTING_REFLEXIVE_VERBS.has(step.verb)) {
			if (decision === false) return;
			if (decision === undefined && actedObjects.length === 0 && step.verb !== 'discover') return;
		} else if (OBJECT_ACTING_REFLEXIVE_VERBS.has(step.verb)) {
			if (actedObjects.length === 0) return;
		} else if (step.optional && decision !== true) {
			return;
		}
	}

	const item = host.item;
	const parentReflexive = item.reflexiveTrigger;
	const abilityKind: CompiledReflexiveTrigger['abilityKind'] = parentReflexive
		? parentReflexive.abilityKind
		: item.kind === 'spell'
			? 'spell'
			: item.kind === 'activated'
				? 'activated'
				: 'triggered';

	const stepPath = [...(host.stepPathPrefix ?? parentReflexive?.stepPath ?? []), host.stepIndex];
	const boundRefs = host.captureBoundRefs();

	const firstObj = matchingObjects[0];
	let eventLki: TriggerEventLki | undefined;
	if (firstObj) {
		const snap = opts?.preSnapshots?.get(firstObj.instanceId);
		if (snap) {
			eventLki = { ...snap };
		} else {
			eventLki = {
				controllerId: firstObj.controllerId,
				ownerId: firstObj.ownerId,
				power: firstObj.lastKnownPower ?? 0,
				toughness: firstObj.lastKnownToughness ?? 0,
				manaValue: objectManaValue(host.state, firstObj),
				...(firstObj.lastKnownCounters ? { counters: { ...firstObj.lastKnownCounters } } : {})
			};
		}
	}

	const srcPerm = host.locate(host.sourceId)?.inst;
	const sourceLkiPower =
		srcPerm && srcPerm.zone === 'battlefield' && !srcPerm.phasedOut
			? evaluatePermanent(host.state, srcPerm).power
			: item.sourceLkiPower ?? item.lkiPower;
	const sourceLkiToughness =
		srcPerm && srcPerm.zone === 'battlefield' && !srcPerm.phasedOut
			? evaluatePermanent(host.state, srcPerm).toughness
			: item.sourceLkiToughness ?? item.lkiToughness;

	const compiled: CompiledReflexiveTrigger = {
		sourceCard: parentReflexive ? parentReflexive.sourceCard : host.sourceCard,
		...(parentReflexive?.faceIndex !== undefined
			? { faceIndex: parentReflexive.faceIndex }
			: item.faceIndex !== undefined
				? { faceIndex: item.faceIndex }
				: {}),
		...(parentReflexive?.fused ?? item.fused ? { fused: true } : {}),
		abilityKind,
		...(parentReflexive?.abilityId ?? item.abilityId
			? { abilityId: parentReflexive?.abilityId ?? item.abilityId }
			: {}),
		...(parentReflexive?.abilityIndex !== undefined
			? { abilityIndex: parentReflexive.abilityIndex }
			: item.triggeredAbilityIndex !== undefined
				? { abilityIndex: item.triggeredAbilityIndex }
				: {}),
		...(parentReflexive?.grantSourceCard ?? item.grantSourceCard
			? { grantSourceCard: parentReflexive?.grantSourceCard ?? item.grantSourceCard }
			: {}),
		...(parentReflexive?.grantedKeyword ?? item.grantedKeyword
			? { grantedKeyword: parentReflexive?.grantedKeyword ?? item.grantedKeyword }
			: {}),
		...(parentReflexive?.grantedAbilityText ?? item.grantedAbilityText
			? { grantedAbilityText: parentReflexive?.grantedAbilityText ?? item.grantedAbilityText }
			: {}),
		...(parentReflexive?.chosenModes ?? item.chosenModes
			? { chosenModes: [...(parentReflexive?.chosenModes ?? item.chosenModes)!] }
			: {}),
		stepPath,
		boundRefs,
		...(item.xValue ? { xValue: item.xValue } : {}),
		...(firstObj ? { eventObjectId: firstObj.instanceId, eventObjectVersion: firstObj.objectVersion } : {}),
		...(eventLki ? { eventLki } : {}),
		...(item.eventPlayerId ? { eventPlayerId: item.eventPlayerId } : {}),
		...(item.defendingPlayerId ? { defendingPlayerId: item.defendingPlayerId } : {}),
		...(item.eventAmount !== undefined ? { eventAmount: item.eventAmount } : {}),
		...(item.sourceKickedCount !== undefined ? { kickedCount: item.sourceKickedCount } : {}),
		...(item.sourceKickedTags?.length ? { kickedTags: [...item.sourceKickedTags] } : {}),
		...(item.sourceKickedTagCounts ? { kickedTagCounts: { ...item.sourceKickedTagCounts } } : {})
	};

	const pending: PendingReflexiveTrigger = {
		id: host.ports.uid('rtrig', host.state),
		controllerId: host.you.playerId,
		sourceInstanceId: host.sourceId,
		...(host.sourceObjectVersion !== undefined
			? { sourceObjectVersion: host.sourceObjectVersion }
			: {}),
		...(sourceLkiPower !== undefined ? { sourceLkiPower } : {}),
		...(sourceLkiToughness !== undefined ? { sourceLkiToughness } : {}),
		...(srcPerm?.chosenSubType ?? item.sourceChosenSubType
			? { sourceChosenSubType: srcPerm?.chosenSubType ?? item.sourceChosenSubType }
			: {}),
		...(srcPerm?.chosenColor ?? item.sourceChosenColor
			? { sourceChosenColor: srcPerm?.chosenColor ?? item.sourceChosenColor }
			: {}),
		displayText: rt.text ?? `${host.sourceCard.name} — Reflexive Trigger`,
		reflexive: compiled
	};

	(host.state.pendingReflexiveTriggers ??= []).push(pending);
}

/**
 * CR 603.12 / 603.3b / 603.2d: Puts queued reflexive triggers onto `state.stack` in APNAP order
 * without applying trigger-doubling multipliers (Panharmonicon / Roaming Throne do not double
 * reflexive triggers because they trigger from the player's action during resolution, not a permanent
 * entering or an independent game event).
 */
export function flushPendingReflexiveTriggers(state: GameState): void {
	const list = state.pendingReflexiveTriggers;
	if (!list || list.length === 0) return;
	if (!p10Host) return;
	const host = p10Host;

	state.pendingReflexiveTriggers = undefined;

	const apnap = apnapPlayersFromState(state);
	const ordered: PendingReflexiveTrigger[] = [];
	for (const pl of apnap) {
		for (const entry of list) {
			if (entry.controllerId === pl.playerId) ordered.push(entry);
		}
	}
	for (const entry of list) {
		if (!ordered.includes(entry)) ordered.push(entry);
	}

	for (const entry of ordered) {
		const spec = resolveReflexiveSpecFromCompiled(entry.reflexive);
		if (!spec) continue;
		const controller = state.players.find((p) => p.playerId === entry.controllerId);
		if (!controller || controller.lost) continue;

		const stackItem: StackItem = withStackItemText(
			{
				id: host.uid('stk', state),
				sourceInstanceId: entry.sourceInstanceId,
				...(entry.sourceObjectVersion !== undefined
					? { sourceObjectVersion: entry.sourceObjectVersion }
					: {}),
				card: entry.reflexive.sourceCard,
				...(entry.reflexive.faceIndex !== undefined
					? { faceIndex: entry.reflexive.faceIndex }
					: {}),
				controllerId: entry.controllerId,
				kind: 'triggered',
				title: `${entry.reflexive.sourceCard.name} (Reflexive Trigger)`,
				targets: [],
				xValue: entry.reflexive.xValue ?? 0,
				requiresGuidedResolution: false,
				createdAt: Date.now(),
				reflexiveTrigger: entry.reflexive,
				...(entry.sourceLkiPower !== undefined ? { sourceLkiPower: entry.sourceLkiPower } : {}),
				...(entry.sourceLkiToughness !== undefined
					? { sourceLkiToughness: entry.sourceLkiToughness }
					: {}),
				...(entry.sourceChosenSubType ? { sourceChosenSubType: entry.sourceChosenSubType } : {}),
				...(entry.sourceChosenColor ? { sourceChosenColor: entry.sourceChosenColor } : {}),
				...(entry.reflexive.eventObjectId
					? { eventObjectId: entry.reflexive.eventObjectId }
					: {}),
				...(entry.reflexive.eventObjectVersion !== undefined
					? { eventObjectVersion: entry.reflexive.eventObjectVersion }
					: {}),
				...(entry.reflexive.eventLki ? { eventLki: { ...entry.reflexive.eventLki } } : {}),
				...(entry.reflexive.eventPlayerId
					? { eventPlayerId: entry.reflexive.eventPlayerId }
					: {}),
				...(entry.reflexive.defendingPlayerId
					? { defendingPlayerId: entry.reflexive.defendingPlayerId }
					: {}),
				...(entry.reflexive.eventAmount !== undefined
					? { eventAmount: entry.reflexive.eventAmount }
					: {}),
				...(entry.reflexive.kickedCount !== undefined
					? { sourceKickedCount: entry.reflexive.kickedCount }
					: {}),
				...(entry.reflexive.kickedTags ? { sourceKickedTags: [...entry.reflexive.kickedTags] } : {}),
				...(entry.reflexive.kickedTagCounts
					? { sourceKickedTagCounts: { ...entry.reflexive.kickedTagCounts } }
					: {})
			},
			entry.displayText
		);

		state.stack.push(stackItem);
		const status = host.assignOrPromptTriggerTargets(state, stackItem, spec.targets);
		if (status !== 'removed') {
			host.addLog(
				state,
				'trigger',
				`${entry.reflexive.sourceCard.name}'s reflexive triggered ability went on the stack.`,
				entry.controllerId
			);
		}
	}
}

// ---- Detain & Suspect State Queries (CR 701.35, CR 701.60) ----------------------------------

export function isPermanentDetained(perm: CardInstance): boolean {
	return Boolean(
		perm.zone === 'battlefield' &&
			!perm.phasedOut &&
			perm.detainedByPlayerIds &&
			perm.detainedByPlayerIds.length > 0
	);
}

export function expireDetainedEffectsForPlayer(state: GameState, activePlayerId: string): void {
	let changed = false;
	for (const pl of state.players) {
		for (const perm of pl.battlefield) {
			if (!perm.detainedByPlayerIds || perm.detainedByPlayerIds.length === 0) continue;
			const next = perm.detainedByPlayerIds.filter((id) => id !== activePlayerId);
			if (next.length !== perm.detainedByPlayerIds.length) {
				perm.detainedByPlayerIds = next.length > 0 ? next : undefined;
				changed = true;
			}
		}
	}
	if (changed) noteLayerInputsChanged(state);
}

// ---- Discover N (CR 701.57a–b) --------------------------------------------------------------

interface DiscoverFaceSetup {
	faceIndex: number;
	faceName: string;
	costDefs: CostDef[];
	modal?: ModalDef;
	nonModalSpecs: TargetSpec[];
	additionalIncomplete: boolean;
}

function getDiscoverFaceModalAndTargets(
	card: ScryfallCard,
	faceIndex: number
): { modal?: ModalDef; nonModalSpecs: TargetSpec[] } {
	const faceOpts = { zone: 'stack' as const, faceIndex };
	const abilities = activeAbilityDefs(card, faceOpts);
	const view = resolveObjectFaces(card, faceOpts);
	if (view.subtypes.includes('Aura')) {
		const specs: TargetSpec[] = [];
		for (const ab of abilities) {
			if (ab.kind !== 'keyword') continue;
			const { name: kwName } = ab.keyword;
			if (kwName !== 'enchant') continue;
			if (ab.keyword.enchantPlayer) {
				return {
					nonModalSpecs: [
						{ kind: 'player', filter: {}, player: ab.keyword.enchantPlayer, min: 1, max: 1 }
					]
				};
			}
			specs.push({
				kind: 'object',
				filter: { zone: 'battlefield', ...(ab.keyword.enchantFilter ?? {}) },
				min: specs.length === 0 ? 1 : 0,
				max: specs.length === 0 ? 1 : 0
			});
		}
		if (specs.length === 0) {
			specs.push({ kind: 'object', filter: { zone: 'battlefield' }, min: 1, max: 1 });
		}
		return { nonModalSpecs: specs };
	}
	if (!view.types.includes('Instant') && !view.types.includes('Sorcery')) {
		return { nonModalSpecs: [] };
	}
	const nonModalSpecs: TargetSpec[] = [];
	for (const ab of abilities) {
		if (ab.kind === 'spell') {
			if (ab.modal) return { modal: ab.modal, nonModalSpecs: [] };
			nonModalSpecs.push(...ab.targets);
		} else if (ab.kind === 'unsupported' && ab.id === 'cast' && ab.targets) {
			nonModalSpecs.push(...ab.targets);
		}
	}
	return { nonModalSpecs };
}

function buildDiscoverFaceSetups(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	discoverN: number
): DiscoverFaceSetup[] {
	const rHost = requireP10Host();
	const card = effectiveCardForObject(inst);
	const faceCount = Math.max(1, getCardFaces(card).length);
	const setups: DiscoverFaceSetup[] = [];

	const globalPerm = checkGlobalCastPermissionsAndRestrictions(state, actor, inst, 'exile');
	if (globalPerm.blocked || !globalPerm.ok) return [];

	const activePlayer = state.players[state.activePlayerIndex];

	for (let fi = 0; fi < faceCount; fi++) {
		const view = resolveObjectFaces(card, { zone: 'stack', faceIndex: fi });
		if (view.types.includes('Land')) continue;
		const spellMv = effectiveManaValue(card, { zone: 'stack', faceIndex: fi });
		// CR 701.57a: The resulting spell's mana value must also be <= discoverN.
		if (spellMv > discoverN) continue;

		let timingOk = true;
		for (const r of spellCastRestrictions(card, fi, false)) {
			if (r === 'duringCombat' && !state.combat.active) timingOk = false;
			if (r === 'duringYourTurn' && activePlayer?.playerId !== actor.playerId) timingOk = false;
			if (r === 'beforeAttackers' && (!state.combat.active || state.phase !== 'begin_combat')) {
				timingOk = false;
			}
		}
		if (!timingOk) continue;

		const additional = spellAdditionalCost(card, fi, false);
		const costDefs = [...(additional?.defs ?? [])];
		const reqAtZero = effectiveSpellManaCost(state, actor, inst, 0, { kind: 'free' }, undefined, fi);
		if (costDefs.length > 0) {
			const ctx = rHost.costContext(state, actor, inst, 0, true, reqAtZero);
			if (!chooseCostPayment(ctx, costDefs)) continue;
		} else if (!rHost.canPayOrAutoTap(actor, reqAtZero, state)) {
			continue;
		}

		const { modal, nonModalSpecs } = getDiscoverFaceModalAndTargets(card, fi);
		if (modal) {
			const legalModes: number[] = [];
			for (let m = 0; m < modal.modes.length; m++) {
				const ok = modal.modes[m].targets.every(
					(sp) =>
						sp.min <= 0 ||
						rHost.specTargetCandidates(state, actor.playerId, card, inst, sp).length >= sp.min
				);
				if (ok) legalModes.push(m);
			}
			const enough =
				modal.min === 0 || modal.upTo
					? true
					: modal.allowRepeat && !modal.oncePerTurnUnique
						? legalModes.length > 0
						: legalModes.length >= modal.min;
			if (!enough) continue;
		} else {
			let targetsOk = true;
			for (const sp of nonModalSpecs) {
				if (
					sp.min > 0 &&
					rHost.specTargetCandidates(state, actor.playerId, card, inst, sp).length < sp.min
				) {
					targetsOk = false;
					break;
				}
			}
			if (!targetsOk) continue;
		}

		setups.push({
			faceIndex: fi,
			faceName: view.name,
			costDefs,
			modal,
			nonModalSpecs,
			additionalIncomplete: Boolean(additional && !additional.complete)
		});
	}
	return setups;
}

function finishDiscoverBottomExiled(
	state: GameState,
	actor: PlayerGameState,
	exiledIds: readonly string[],
	excludeId?: string
): void {
	const rest: CardInstance[] = [];
	for (const id of exiledIds) {
		if (id === excludeId) continue;
		for (const pl of state.players) {
			const found = pl.exile.find((c) => c.instanceId === id);
			if (found) {
				rest.push(found);
				break;
			}
		}
	}
	if (rest.length === 0) return;
	const randomized = shuffleDeterministic(state, rest);
	for (const c of randomized) {
		const owner = state.players.find((p) => p.playerId === c.ownerId) ?? actor;
		moveObject(state, c, 'library', {
			from: { player: owner, zone: 'exile' },
			toPlayer: owner,
			insert: 'end',
			bumpVersion: true,
			newTimestamp: true
		});
	}
}

export function executeDiscover(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const rHost = requireP10Host();
	const n = Math.max(0, host.amount(step.amount, 0));
	const actors = resolveActors(host, step);
	if (actors.length === 0) return;
	const actor = actors[0];

	const exiledKey = `discover:exiled:${host.stepIndex}`;
	const hitKey = `discover:hit:${host.stepIndex}`;

	let exiledIds: string[];
	let hitId: string | undefined;

	if (!host.answers[exiledKey]) {
		exiledIds = [];
		let hitCard: CardInstance | undefined;
		const maxExile = Math.min(250, actor.library.length);
		for (let guard = 0; guard < maxExile && actor.library.length > 0; guard++) {
			const topCard = actor.library[0];
			const owner = state.players.find((p) => p.playerId === topCard.ownerId) ?? actor;
			moveObject(state, topCard, 'exile', {
				from: { player: actor, zone: 'library' },
				toPlayer: owner,
				bumpVersion: true,
				newTimestamp: true
			});
			if (topCard.zone === 'exile') {
				exiledIds.push(topCard.instanceId);
				const view = resolveObjectFaces(effectiveCardForObject(topCard), { zone: 'exile' });
				const isLand = view.types.includes('Land');
				const mv = objectManaValue(state, topCard);
				if (!isLand && mv <= n) {
					hitCard = topCard;
					break;
				}
			}
		}
		hitId = hitCard?.instanceId;
		host.answers[exiledKey] = { kind: 'chooseObjects', objectIds: exiledIds };
		host.answers[hitKey] = { kind: 'chooseObjects', objectIds: hitId ? [hitId] : [] };
	} else {
		const exAns = host.answers[exiledKey];
		const hAns = host.answers[hitKey];
		exiledIds = exAns?.kind === 'chooseObjects' ? exAns.objectIds : [];
		hitId = hAns?.kind === 'chooseObjects' ? hAns.objectIds[0] : undefined;
	}

	const hitFound = hitId ? host.locate(hitId) : null;
	const hitCard = hitFound && hitFound.zone === 'exile' ? hitFound.inst : undefined;

	let wasCast = false;
	if (hitCard) {
		const hitOwner = state.players.find((p) => p.playerId === hitCard.ownerId) ?? actor;
		const setups = buildDiscoverFaceSetups(state, actor, hitCard, n);

		if (setups.length > 0) {
			const castAskKey = `discover:cast:${host.stepIndex}`;
			let wantsCast = true;
			if (!actor.isBot && host.canPause) {
				const ans = host.answers[castAskKey];
				if (!ans) {
					host.pauseForYesNo(
						actor,
						`${host.title} — Discover ${n}`,
						`Cast ${hitCard.card.name} from exile without paying its mana cost? (Choose No to put it into your hand.)`,
						castAskKey,
						{ yesLabel: 'Cast Without Paying', noLabel: 'Put Into Hand' }
					);
					return;
				}
				wantsCast = ans.kind === 'yesNo' && ans.yes;
			}

			if (wantsCast) {
				let pickedSetup = setups[0];
				if (setups.length > 1) {
					if (actor.isBot || !host.canPause) {
						const sorted = [...setups].sort(
							(a, b) =>
								effectiveManaValue(hitCard.card, { zone: 'stack', faceIndex: b.faceIndex }) -
								effectiveManaValue(hitCard.card, { zone: 'stack', faceIndex: a.faceIndex })
						);
						pickedSetup = sorted[0];
					} else {
						const faceKey = `discover:face:${host.stepIndex}`;
						const faceAns = host.answers[faceKey];
						if (!faceAns) {
							host.pauseForMode(
								actor,
								`${host.title} — Choose Face to Cast`,
								`Choose which face of ${hitCard.card.name} to cast without paying its mana cost.`,
								setups.map((s) => s.faceName),
								1,
								1,
								faceKey,
								[0]
							);
							return;
						}
						const idx = faceAns.kind === 'chooseMode' ? (faceAns.indices[0] ?? 0) : 0;
						pickedSetup = setups[Math.max(0, Math.min(setups.length - 1, idx))];
					}
				}

				let chosenModes: number[] | undefined;
				if (pickedSetup.modal) {
					const modal = pickedSetup.modal;
					const legalModeIndices: number[] = [];
					for (let m = 0; m < modal.modes.length; m++) {
						const ok = modal.modes[m].targets.every(
							(sp) =>
								sp.min <= 0 ||
								rHost.specTargetCandidates(state, actor.playerId, hitCard.card, hitCard, sp).length >=
									sp.min
						);
						if (ok) legalModeIndices.push(m);
					}
					if (actor.isBot || !host.canPause) {
						chosenModes = legalModeIndices.slice(0, Math.max(modal.min, 1));
					} else {
						const modeKey = `discover:modes:${host.stepIndex}`;
						const modeAns = host.answers[modeKey];
						if (!modeAns) {
							host.pauseForMode(
								actor,
								`${host.title} — Choose Mode(s) for ${pickedSetup.faceName}`,
								`Choose mode(s) for ${pickedSetup.faceName}.`,
								describeModalModes(hitCard.card, modal, pickedSetup.faceIndex),
								modal.min,
								modal.max,
								modeKey,
								legalModeIndices.slice(0, Math.max(modal.min, 1))
							);
							return;
						}
						chosenModes = modeAns.kind === 'chooseMode' ? modeAns.indices : [0];
					}
				}

				const activeSpecs: TargetSpec[] = pickedSetup.modal
					? (chosenModes ?? []).flatMap((m) => pickedSetup.modal!.modes[m]?.targets ?? [])
					: pickedSetup.nonModalSpecs;

				const targets: TargetRef[] = [];
				const targetsBySpec: TargetRef[][] = [];
				const usedAcrossOtherTarget = new Set<string>();
				let allTargetsLegal = true;

				for (let sIdx = 0; sIdx < activeSpecs.length; sIdx++) {
					const sp = activeSpecs[sIdx];
					const cands = rHost
						.specTargetCandidates(state, actor.playerId, hitCard.card, hitCard, sp)
						.filter((c) => !sp.otherTarget || !usedAcrossOtherTarget.has(`${c.kind}:${c.id}`));
					if (cands.length < sp.min) {
						allTargetsLegal = false;
						break;
					}
					if (cands.length === 0) {
						targetsBySpec.push([]);
						continue;
					}
					let pickedRefs: TargetRef[];
					if (actor.isBot || !host.canPause) {
						const want = sp.min > 0 ? sp.min : 1;
						pickedRefs = cands.slice(0, Math.min(sp.max, want));
					} else {
						const tgtKey = `discover:tgt:${host.stepIndex}:${sIdx}`;
						const tgtAns = host.answers[tgtKey];
						if (!tgtAns) {
							host.pauseForMode(
								actor,
								`${host.title} — Choose Target for ${pickedSetup.faceName}`,
								`Select target(s) for ${pickedSetup.faceName}.`,
								cands.map((c) => c.label),
								sp.min,
								Math.min(sp.max, cands.length),
								tgtKey,
								cands.slice(0, Math.max(1, sp.min)).map((_, idx) => idx)
							);
							return;
						}
						const indices = tgtAns.kind === 'chooseMode' ? tgtAns.indices : [0];
						pickedRefs = indices
							.map((i) => cands[i])
							.filter((r): r is TargetRef => Boolean(r));
						if (pickedRefs.length < sp.min) {
							pickedRefs = cands.slice(0, sp.min);
						}
					}
					for (const pr of pickedRefs) usedAcrossOtherTarget.add(`${pr.kind}:${pr.id}`);
					targets.push(...pickedRefs);
					targetsBySpec.push(pickedRefs);
				}

				if (allTargetsLegal) {
					const req = effectiveSpellManaCost(
						state,
						actor,
						hitCard,
						0,
						{ kind: 'free' },
						undefined,
						pickedSetup.faceIndex
					);
					let paidOk = true;
					let descriptions: string[] = [];
					if (pickedSetup.costDefs.length > 0) {
						const ctx = rHost.costContext(state, actor, hitCard, 0, true, req);
						const payment = chooseCostPayment(ctx, pickedSetup.costDefs);
						if (!payment) {
							paidOk = false;
						} else {
							const plan = planCosts(ctx, pickedSetup.costDefs, payment);
							if (!plan.ok || plan.question) {
								paidOk = false;
							} else {
								const parts = serializeCostPlanParts(ctx, plan);
								payTapAndManaCostParts(ctx, parts, plan.mana, descriptions);
								const paid = executeCostPaymentParts(ctx, parts, 0, 0, descriptions);
								descriptions = paid.descriptions;
							}
						}
					} else if (!rHost.payManaWithAutoTap(actor, req, state)) {
						paidOk = false;
					}

					if (paidOk) {
						rHost.finalizeCastSpell(state, actor, hitCard, hitOwner, 'exile', {
							targets,
							...(activeSpecs.length > 0 ? { targetsBySpec } : {}),
							...(chosenModes ? { chosenModes } : {}),
							xValue: 0,
							castOptionId: 'exile:discover',
							faceIndex: pickedSetup.faceIndex,
							spellMods: { castSummarySuffix: ` (Discover ${n})` },
							exSourceName: `Discover ${n}`,
							descriptions,
							additionalIncomplete: pickedSetup.additionalIncomplete
						});
						wasCast = true;
					}
				}
			}
		}

		if (!wasCast && hitCard.zone === 'exile') {
			moveObject(state, hitCard, 'hand', {
				from: { player: hitOwner, zone: 'exile' },
				toPlayer: hitOwner,
				bumpVersion: true,
				newTimestamp: true
			});
			host.ports.addLog(
				state,
				'rule',
				`${actor.username} put ${hitCard.card.name} into hand via Discover ${n} (CR 701.57a).`,
				actor.playerId
			);
		}
		host.bind(step, [hitCard]);
	} else {
		host.bind(step, []);
	}

	finishDiscoverBottomExiled(state, actor, exiledIds, hitCard?.instanceId);
	host.setStepDecision(Boolean(hitCard));
	emitEvent(state, {
		kind: 'Discovered',
		playerId: actor.playerId,
		n,
		...(hitCard ? { hitCard } : {}),
		wasCast
	});
	flushTriggers(state);
}

// ---- Clash (CR 701.30a–d) -------------------------------------------------------------------

export function executeClash(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	if (you.lost) {
		host.setStepDecision(false);
		return;
	}

	const opponents = apnapPlayersFromState(state).filter((p) => p.playerId !== you.playerId);
	let opponent: PlayerGameState | undefined = opponents[0];
	if (opponents.length > 1) {
		const oppKey = `clash:opp:${host.stepIndex}`;
		if (!you.isBot && host.canPause) {
			const ans = host.answers[oppKey];
			if (!ans) {
				host.pauseForMode(
					you,
					`${host.title} — Choose Opponent to Clash With`,
					'Choose an opponent to clash with (CR 701.30a).',
					opponents.map((o) => o.username),
					1,
					1,
					oppKey,
					[0]
				);
				return;
			}
			const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
			opponent = opponents[Math.max(0, Math.min(opponents.length - 1, idx))];
		}
	}

	const clashers = opponent ? [you, opponent] : [you];
	const apnapOrder = apnapPlayersFromState(state).filter((p) =>
		clashers.some((c) => c.playerId === p.playerId)
	);

	// Reveal top cards simultaneously and record their MVs before moving any cards (CR 701.30c–d).
	const mvKey = `clash:mvs:${host.stepIndex}`;
	let yourMv = 0;
	let oppMv = 0;
	if (!host.answers[mvKey]) {
		const yourTop = you.library[0];
		const oppTop = opponent?.library[0];
		yourMv = yourTop ? objectManaValue(state, yourTop) : 0;
		oppMv = oppTop ? objectManaValue(state, oppTop) : 0;
		for (const cl of clashers) {
			const top = cl.library[0];
			if (top) {
				top.knownToPlayerIds = state.players.filter((p) => !p.lost).map((p) => p.playerId);
				host.ports.addLog(
					state,
					'rule',
					`${cl.username} revealed ${top.card.name} (mana value ${objectManaValue(state, top)}) in a clash.`,
					cl.playerId
				);
			} else {
				host.ports.addLog(state, 'rule', `${cl.username} revealed no card in a clash (empty library).`, cl.playerId);
			}
		}
		host.answers[mvKey] = {
			kind: 'chooseObjects',
			objectIds: [`${yourMv}`, `${oppMv}`]
		};
	} else {
		const saved = host.answers[mvKey];
		const vals = saved?.kind === 'chooseObjects' ? saved.objectIds : ['0', '0'];
		yourMv = Number(vals[0]) || 0;
		oppMv = Number(vals[1]) || 0;
	}

	// Each clasher in APNAP order chooses top or bottom for their revealed card (CR 701.30c).
	for (const cl of apnapOrder) {
		const top = cl.library[0];
		if (!top) continue;
		const placeKey = `clash:place:${host.stepIndex}:${cl.playerId}`;
		if (!cl.isBot && host.canPause && !host.answers[placeKey]) {
			host.pauseForYesNo(
				cl,
				`${host.title} — Clash (${top.card.name})`,
				`Put revealed ${top.card.name} on the bottom of your library? (Choose No to leave it on top.)`,
				placeKey,
				{ yesLabel: 'Put on Bottom', noLabel: 'Keep on Top' }
			);
			return;
		}
	}

	const doneKey = `clash:placed:${host.stepIndex}`;
	if (!host.answers[doneKey]) {
		for (const cl of apnapOrder) {
			const top = cl.library[0];
			if (!top) continue;
			const placeKey = `clash:place:${host.stepIndex}:${cl.playerId}`;
			const ans = host.answers[placeKey];
			let putBottom: boolean;
			if (ans?.kind === 'yesNo') {
				putBottom = ans.yes;
			} else {
				// Bot heuristic: bottom lands when >4 lands on board, else keep spells on top.
				const view = resolveObjectFaces(effectiveCardForObject(top), { zone: 'library' });
				const landCount = cl.battlefield.filter((p) => !p.phasedOut && evaluatePermanent(state, p).isLand).length;
				putBottom = view.types.includes('Land') && landCount >= 4;
			}
			if (putBottom && cl.library.length > 1) {
				rearrangeLibrary(cl, [top], [], [top]);
				host.ports.addLog(
					state,
					'rule',
					`${cl.username} put ${top.card.name} on the bottom of their library.`,
					cl.playerId
				);
			}
		}
		host.answers[doneKey] = { kind: 'yesNo', yes: true };
	}

	const won = opponent ? yourMv > oppMv : yourMv > 0;
	host.setStepDecision(won);
	host.ports.addLog(
		state,
		'rule',
		won ? `${you.username} won the clash (${yourMv} vs ${oppMv})!` : `${you.username} did not win the clash (${yourMv} vs ${oppMv}).`,
		you.playerId
	);
}

// ---- Detain (CR 701.35a) --------------------------------------------------------------------

export function executeDetain(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const objs = host.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	host.bind(step, objs);
	let changed = false;
	for (const perm of objs) {
		perm.detainedByPlayerIds ??= [];
		if (!perm.detainedByPlayerIds.includes(you.playerId)) {
			perm.detainedByPlayerIds.push(you.playerId);
			changed = true;
		}
		host.ports.addLog(
			state,
			'rule',
			`${you.username} detained ${perm.card.name} until ${you.username}'s next turn (CR 701.35a).`,
			you.playerId
		);
	}
	if (changed) noteLayerInputsChanged(state);
}

// ---- Suspect (CR 701.60a–c) -----------------------------------------------------------------

export function executeSuspect(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const clear = Boolean(step.params?.unsuspect);
	const objs = host
		.objects(step.subject)
		.filter((o) => o.zone === 'battlefield' && !o.phasedOut && evaluatePermanent(state, o).isCreature);
	host.bind(step, objs);
	let changed = false;
	for (const perm of objs) {
		if (clear) {
			if (perm.isSuspected) {
				perm.isSuspected = undefined;
				changed = true;
				host.ports.addLog(state, 'rule', `${perm.card.name} is no longer suspected.`, you.playerId);
			}
		} else if (!perm.isSuspected) {
			perm.isSuspected = true;
			changed = true;
			host.ports.addLog(
				state,
				'rule',
				`${perm.card.name} became suspected (menace and can't block, CR 701.60).`,
				you.playerId
			);
		}
	}
	if (changed) noteLayerInputsChanged(state);
}

// ---- Collect Evidence N (CR 701.59a–b) ------------------------------------------------------

export function executeCollectEvidence(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const actors = resolveActors(host, step);
	if (actors.length === 0) {
		host.setStepDecision(false);
		return;
	}
	const actor = actors[0];
	const n = Math.max(0, host.amount(step.amount, 0));
	if (n <= 0) {
		host.bind(step, []);
		host.setStepDecision(true);
		return;
	}

	const gyCards = [...actor.graveyard];
	const weightsById: Record<string, number> = {};
	let totalMv = 0;
	for (const c of gyCards) {
		const mv = Math.max(0, objectManaValue(state, c));
		weightsById[c.instanceId] = mv;
		totalMv += mv;
	}
	if (totalMv < n) {
		host.bind(step, []);
		host.setStepDecision(false);
		host.ports.addLog(
			state,
			'rule',
			`${actor.username} could not collect evidence ${n} (total graveyard mana value ${totalMv}).`,
			actor.playerId
		);
		return;
	}

	// Greedy minimal-card / ascending-MV cover for default & bot selection.
	const sortedDesc = [...gyCards].sort(
		(a, b) => (weightsById[b.instanceId] ?? 0) - (weightsById[a.instanceId] ?? 0)
	);
	const defaultIds: string[] = [];
	let acc = 0;
	for (const c of sortedDesc) {
		if (acc >= n) break;
		defaultIds.push(c.instanceId);
		acc += weightsById[c.instanceId] ?? 0;
	}

	const ansKey = `evidence:${host.stepIndex}`;
	let chosenIds: string[];
	if (!actor.isBot && host.canPause) {
		const ans = host.answers[ansKey];
		if (!ans) {
			host.pauseForWeightedChoice(
				actor,
				`${host.title} — Collect Evidence ${n}`,
				`Exile cards from your graveyard with total mana value ${n} or greater (CR 701.59a).`,
				gyCards.map((c) => c.instanceId),
				1,
				gyCards.length,
				'graveyard',
				weightsById,
				n,
				'mana value',
				defaultIds,
				ansKey
			);
			return;
		}
		chosenIds = ans.kind === 'chooseObjects' ? ans.objectIds : defaultIds;
	} else {
		chosenIds = defaultIds;
	}

	const sumChosen = chosenIds.reduce((s, id) => s + (weightsById[id] ?? 0), 0);
	if (sumChosen < n) {
		chosenIds = defaultIds;
	}

	const exiled: CardInstance[] = [];
	for (const id of chosenIds) {
		const card = actor.graveyard.find((c) => c.instanceId === id);
		if (!card) continue;
		moveObject(state, card, 'exile', {
			from: { player: actor, zone: 'graveyard' },
			toPlayer: actor,
			bumpVersion: true,
			newTimestamp: true,
			suppressGraveyardLeaveBatch: true
		});
		exiled.push(card);
	}
	if (exiled.length > 0) {
		emitEvent(state, {
			kind: 'GraveyardLeaveBatch',
			ownerId: actor.playerId,
			objects: exiled
		});
	}
	host.bind(step, exiled);
	host.setStepDecision(exiled.length > 0);
	host.ports.addLog(
		state,
		'rule',
		`${actor.username} collected evidence ${n}, exiling ${exiled.length} card(s) from their graveyard.`,
		actor.playerId
	);
	flushTriggers(state);
}

// ---- Forage (CR 701.61a) --------------------------------------------------------------------

export function executeForage(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const actors = resolveActors(host, step);
	if (actors.length === 0) {
		host.setStepDecision(false);
		return;
	}
	const actor = actors[0];

	const foods = actor.battlefield.filter((p) => !p.phasedOut && evaluatePermanent(state, p).hasSubType('Food'));
	const canExile3 = actor.graveyard.length >= 3;
	const canSacFood = foods.length > 0;

	if (!canExile3 && !canSacFood) {
		host.bind(step, []);
		host.setStepDecision(false);
		return;
	}

	const modeKey = `forage:mode:${host.stepIndex}`;
	let useFood = canSacFood && !canExile3;
	if (canSacFood && canExile3) {
		if (actor.isBot || !host.canPause) {
			useFood = false; // Bots prefer exiling 3 graveyard cards over sacrificing a Food on board
		} else {
			const mAns = host.answers[modeKey];
			if (!mAns) {
				host.pauseForMode(
					actor,
					`${host.title} — Forage`,
					'Choose how to forage (CR 701.61a):',
					['Exile three cards from your graveyard', 'Sacrifice a Food'],
					1,
					1,
					modeKey,
					[0]
				);
				return;
			}
			useFood = mAns.kind === 'chooseMode' && mAns.indices[0] === 1;
		}
	}

	if (useFood) {
		const foodKey = `forage:food:${host.stepIndex}`;
		let chosenFood = foods[0];
		if (foods.length > 1 && !actor.isBot && host.canPause) {
			const fAns = host.answers[foodKey];
			if (!fAns) {
				host.pauseForChoice(
					actor,
					`${host.title} — Choose Food to Sacrifice`,
					'Choose a Food you control to sacrifice for Forage.',
					foods.map((f) => f.instanceId),
					1,
					1,
					'battlefield',
					[foods[0].instanceId],
					foodKey
				);
				return;
			}
			const pickedId = fAns.kind === 'chooseObjects' ? fAns.objectIds[0] : foods[0].instanceId;
			chosenFood = foods.find((f) => f.instanceId === pickedId) ?? foods[0];
		}
		const owner = state.players.find((p) => p.playerId === chosenFood.ownerId) ?? actor;
		moveObject(state, chosenFood, 'graveyard', {
			from: { player: actor, zone: 'battlefield' },
			toPlayer: owner,
			detachAttachments: true,
			graveyardReplacement: true,
			commanderRedirect: true,
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true,
			ceaseToExist: 'tokens',
			sacrificedByPlayerId: actor.playerId
		});
		host.bind(step, [chosenFood]);
		host.setStepDecision(true);
		host.ports.addLog(state, 'rule', `${actor.username} sacrificed ${chosenFood.card.name} to forage.`, actor.playerId);
	} else {
		const gyKey = `forage:gy:${host.stepIndex}`;
		let chosenGyIds = actor.graveyard.slice(0, 3).map((c) => c.instanceId);
		if (actor.graveyard.length > 3 && !actor.isBot && host.canPause) {
			const gAns = host.answers[gyKey];
			if (!gAns) {
				host.pauseForChoice(
					actor,
					`${host.title} — Choose 3 Cards to Exile for Forage`,
					'Exile three cards from your graveyard to forage (CR 701.61a).',
					actor.graveyard.map((c) => c.instanceId),
					3,
					3,
					'graveyard',
					chosenGyIds,
					gyKey
				);
				return;
			}
			if (gAns.kind === 'chooseObjects' && gAns.objectIds.length === 3) {
				chosenGyIds = gAns.objectIds;
			}
		}
		const exiled: CardInstance[] = [];
		for (const id of chosenGyIds) {
			const c = actor.graveyard.find((x) => x.instanceId === id);
			if (!c) continue;
			moveObject(state, c, 'exile', {
				from: { player: actor, zone: 'graveyard' },
				toPlayer: actor,
				bumpVersion: true,
				newTimestamp: true,
				suppressGraveyardLeaveBatch: true
			});
			exiled.push(c);
		}
		if (exiled.length > 0) {
			emitEvent(state, {
				kind: 'GraveyardLeaveBatch',
				ownerId: actor.playerId,
				objects: exiled
			});
		}
		host.bind(step, exiled);
		host.setStepDecision(exiled.length === 3);
		host.ports.addLog(state, 'rule', `${actor.username} exiled 3 cards from their graveyard to forage.`, actor.playerId);
	}

	emitEvent(state, { kind: 'Foraged', playerId: actor.playerId });
	flushTriggers(state);
}

// ---- Endure N (CR 701.63a–b) ----------------------------------------------------------------

export function executeEndure(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const n = Math.max(0, host.amount(step.amount, 0));
	// CR 701.63b: If N <= 0, endure does nothing.
	if (n <= 0) {
		host.bind(step, []);
		return;
	}

	let livePerm: CardInstance | undefined;
	if (
		step.subject.k === 'self' ||
		step.subject.k === 'none' ||
		(step.subject.k === 'eventObject' && !host.item.eventObjectId)
	) {
		const found = host.locate(host.sourceId);
		if (
			found &&
			found.zone === 'battlefield' &&
			!found.inst.phasedOut &&
			(host.sourceObjectVersion === undefined ||
				(found.inst.objectVersion ?? 1) === host.sourceObjectVersion)
		) {
			livePerm = found.inst;
		}
	} else {
		livePerm = host
			.objects(step.subject)
			.find((o) => o.zone === 'battlefield' && !o.phasedOut);
	}

	const spiritSpec = {
		name: 'Spirit',
		power: n,
		toughness: n,
		colors: ['W'] as ManaColor[],
		typeLine: 'Token Creature — Spirit',
		keywords: [] as string[]
	};

	// CR 701.63b: If the enduring permanent is no longer on the battlefield, no choice is made — create the N/N Spirit token!
	if (!livePerm) {
		const tok = host.ports.createToken(state, you, spiritSpec);
		host.bind(step, [tok]);
		host.ports.addLog(
			state,
			'rule',
			`${you.username} created a ${n}/${n} white Spirit creature token via Endure ${n} (permanent no longer on battlefield, CR 701.63b).`,
			you.playerId
		);
		flushTriggers(state);
		return;
	}

	const choiceKey = `endure:${host.stepIndex}`;
	let putCounters = true;
	if (!you.isBot && host.canPause) {
		const ans = host.answers[choiceKey];
		if (!ans) {
			host.pauseForMode(
				you,
				`${host.title} — Endure ${n}`,
				`Choose how ${livePerm.card.name} endures ${n} (CR 701.63a):`,
				[
					`Put ${n} +1/+1 counter(s) on ${livePerm.card.name}`,
					`Create a ${n}/${n} white Spirit creature token`
				],
				1,
				1,
				choiceKey,
				[0]
			);
			return;
		}
		putCounters = ans.kind === 'chooseMode' ? ans.indices[0] !== 1 : true;
	}

	if (putCounters) {
		host.ports.addCounters(state, livePerm, '+1/+1', n);
		host.bind(step, [livePerm]);
		host.ports.addLog(
			state,
			'rule',
			`${you.username} put ${n} +1/+1 counter(s) on ${livePerm.card.name} (Endure ${n}).`,
			you.playerId
		);
	} else {
		const tok = host.ports.createToken(state, you, spiritSpec);
		host.bind(step, [tok]);
		host.ports.addLog(
			state,
			'rule',
			`${you.username} created a ${n}/${n} white Spirit creature token (Endure ${n}).`,
			you.playerId
		);
	}
	flushTriggers(state);
}

// ---- Time Travel (CR 701.56a) ---------------------------------------------------------------

export function executeTimeTravel(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const repeats = Math.max(1, host.amount(step.amount, 1));

	for (let r = 0; r < repeats; r++) {
		const candidates: Array<{ inst: CardInstance; label: string; isSuspendExile: boolean }> = [];
		for (const perm of you.battlefield) {
			if (perm.phasedOut) continue;
			if ((perm.counters.time || 0) > 0) {
				candidates.push({
					inst: perm,
					label: `${perm.card.name} (battlefield, ${perm.counters.time} time)`,
					isSuspendExile: false
				});
			}
		}
		for (const pl of state.players) {
			for (const ex of pl.exile) {
				if (ex.ownerId === you.playerId && (ex.counters.time || 0) > 0) {
					candidates.push({
						inst: ex,
						label: `${ex.card.name} (exile, ${ex.counters.time} time)`,
						isSuspendExile: Boolean(ex.isSuspended)
					});
				}
			}
		}

		for (const cand of candidates) {
			const key = `timetravel:${host.stepIndex}:${r}:${cand.inst.instanceId}`;
			if (!you.isBot && host.canPause && !host.answers[key]) {
				const defaultIdx = cand.isSuspendExile ? 1 : 0;
				host.pauseForMode(
					you,
					`${host.title} — Time Travel (${cand.label})`,
					`Choose whether to add or remove a time counter on ${cand.label} (CR 701.56a):`,
					['Add a time counter', 'Remove a time counter', 'Leave unchanged'],
					1,
					1,
					key,
					[defaultIdx]
				);
				return;
			}
		}

		const appliedKey = `timetravel:done:${host.stepIndex}:${r}`;
		if (host.answers[appliedKey]) continue;

		for (const cand of candidates) {
			const key = `timetravel:${host.stepIndex}:${r}:${cand.inst.instanceId}`;
			const ans = host.answers[key];
			let actionIdx: number;
			if (ans?.kind === 'chooseMode') {
				actionIdx = ans.indices[0] ?? 2;
			} else {
				// Bot heuristic: remove time counter from suspended exiled cards to cast sooner; add to Vanishing/battlefield permanents.
				actionIdx = cand.isSuspendExile ? 1 : 0;
			}
			if (actionIdx === 0) {
				if (cand.inst.zone === 'battlefield') {
					host.ports.addCounters(state, cand.inst, 'time', 1);
				} else {
					cand.inst.counters.time = (cand.inst.counters.time || 0) + 1;
				}
			} else if (actionIdx === 1) {
				const prev = cand.inst.counters.time || 0;
				if (prev > 0) {
					const next = prev - 1;
					cand.inst.counters.time = next;
					noteLayerInputsChanged(state);
					if (cand.inst.zone === 'battlefield' && !cand.inst.phasedOut) {
						emitEvent(state, {
							kind: 'CounterRemoved',
							objectId: cand.inst.instanceId,
							object: cand.inst,
							counterType: 'time',
							amount: 1,
							previousCount: prev,
							newCount: next
						});
					}
				}
			}
		}
		host.answers[appliedKey] = { kind: 'yesNo', yes: true };
		flushTriggers(state);
	}
	host.bind(step, []);
}

// ---- Blight N (CR 701.68a–b) ----------------------------------------------------------------

export function executeBlight(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const actors = resolveActors(host, step);
	if (actors.length === 0) {
		host.setStepDecision(false);
		return;
	}
	const actor = actors[0];
	const n = Math.max(0, host.amount(step.amount, 1));
	if (n <= 0) {
		host.bind(step, []);
		host.setStepDecision(false);
		return;
	}

	const creatures = actor.battlefield.filter(
		(p) => !p.phasedOut && evaluatePermanent(state, p).isCreature
	);
	if (creatures.length === 0) {
		host.bind(step, []);
		host.setStepDecision(false);
		return;
	}

	// Bot prefers highest-toughness creature so it survives the -1/-1 counters when possible.
	const sorted = [...creatures].sort(
		(a, b) => evaluatePermanent(state, b).toughness - evaluatePermanent(state, a).toughness
	);
	let chosen = sorted[0];
	if (creatures.length > 1 && !actor.isBot && host.canPause) {
		const key = `blight:${host.stepIndex}`;
		const ans = host.answers[key];
		if (!ans) {
			host.pauseForChoice(
				actor,
				`${host.title} — Blight ${n}`,
				`Choose a creature you control to put ${n} -1/-1 counter(s) on (CR 701.68a).`,
				creatures.map((c) => c.instanceId),
				1,
				1,
				'battlefield',
				[sorted[0].instanceId],
				key
			);
			return;
		}
		const pickedId = ans.kind === 'chooseObjects' ? ans.objectIds[0] : sorted[0].instanceId;
		chosen = creatures.find((c) => c.instanceId === pickedId) ?? sorted[0];
	}

	host.ports.addCounters(state, chosen, '-1/-1', n);
	host.bind(step, [chosen]);
	host.setStepDecision(true);
	host.ports.addLog(
		state,
		'rule',
		`${actor.username} blighted ${n} on ${chosen.card.name} (CR 701.68a).`,
		actor.playerId
	);
	flushTriggers(state);
}

// ---- Fateseal N (CR 701.29a) ----------------------------------------------------------------

export function executeFateseal(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const n = Math.max(0, host.amount(step.amount, 1));
	if (n <= 0) return;

	let targets = host.players(step.subject).filter((p) => p.playerId !== you.playerId && !p.lost);
	if (targets.length === 0) {
		const opps = apnapPlayersFromState(state).filter((p) => p.playerId !== you.playerId);
		if (opps.length === 0) return;
		if (opps.length > 1 && !you.isBot && host.canPause) {
			const oppKey = `fateseal:opp:${host.stepIndex}`;
			const ans = host.answers[oppKey];
			if (!ans) {
				host.pauseForMode(
					you,
					`${host.title} — Choose Opponent for Fateseal ${n}`,
					`Choose an opponent whose library to fateseal ${n} (CR 701.29a).`,
					opps.map((o) => o.username),
					1,
					1,
					oppKey,
					[0]
				);
				return;
			}
			const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
			targets = [opps[Math.max(0, Math.min(opps.length - 1, idx))]];
		} else {
			targets = [opps[0]];
		}
	}

	const opp = targets[0];
	const topCards = opp.library.slice(0, n);
	if (topCards.length === 0) return;
	for (const c of topCards) {
		c.knownToPlayerIds = Array.from(new Set([...(c.knownToPlayerIds ?? []), you.playerId]));
	}

	if (!you.isBot && host.canPause) {
		const orderKey = `fateseal:order:${host.stepIndex}`;
		const ans = host.answers[orderKey];
		if (!ans) {
			host.pauseForSplitOrder(
				you,
				`${host.title} — Fateseal ${n} (${opp.username})`,
				`Look at the top ${topCards.length} card(s) of ${opp.username}'s library; put any number on the bottom and the rest on top in any order (CR 701.29a).`,
				topCards.map((c) => c.instanceId),
				true,
				orderKey
			);
			return;
		}
		if (ans.kind === 'orderObjects') {
			const byId = new Map(topCards.map((c) => [c.instanceId, c]));
			const keepTop = ans.topIds.map((id) => byId.get(id)).filter((c): c is CardInstance => Boolean(c));
			const moveBottom = (ans.bottomIds ?? [])
				.map((id) => byId.get(id))
				.filter((c): c is CardInstance => Boolean(c));
			rearrangeLibrary(opp, topCards, keepTop, moveBottom);
			host.ports.addLog(
				state,
				'rule',
				`${you.username} fatesealed ${topCards.length} on ${opp.username}'s library.`,
				you.playerId
			);
			return;
		}
	}

	// Bot heuristic: leave basic lands on top of opponent's library, bottom high-impact nonlands.
	const keepTop: CardInstance[] = [];
	const moveBottom: CardInstance[] = [];
	for (const c of topCards) {
		const view = resolveObjectFaces(effectiveCardForObject(c), { zone: 'library' });
		if (view.types.includes('Land')) keepTop.push(c);
		else moveBottom.push(c);
	}
	rearrangeLibrary(opp, topCards, keepTop, moveBottom);
	host.ports.addLog(
		state,
		'rule',
		`${you.username} fatesealed ${topCards.length} on ${opp.username}'s library.`,
		you.playerId
	);
}

// ---- Coin Flip & Die Roll (CR 705, CR 706) --------------------------------------------------

export function executeFlipCoin(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const resKey = `coin:${host.stepIndex}`;

	if (step.params?.coinFlipUntilLose) {
		let wins: number;
		const saved = host.answers[resKey];
		if (!saved) {
			wins = 0;
			// Bounded at 64 consecutive heads (< 2^-64 probability) per ENGINE_INVARIANTS anti-hang rule.
			for (let guard = 0; guard < 64; guard++) {
				if (nextRandom(state) < 0.5) {
					wins += 1;
				} else {
					break;
				}
			}
			host.answers[resKey] = { kind: 'chooseNumber', n: wins };
			host.setLastRollResult(wins);
			host.setStepDecision(wins > 0);
			host.ports.addLog(
				state,
				'rule',
				`${you.username} flipped coins until losing a flip and won ${wins} flip(s) (CR 705).`,
				you.playerId
			);
		} else {
			wins = saved.kind === 'chooseNumber' ? saved.n : 0;
			host.setLastRollResult(wins);
			host.setStepDecision(wins > 0);
		}
		if (wins > 0 && step.params.winFlipEffect) {
			host.runInlineSteps(step.params.winFlipEffect, -1);
		}
		return;
	}

	const flipCount = Math.max(1, host.amount(step.amount, 1));
	let wins = 0;
	const saved = host.answers[resKey];
	if (!saved) {
		for (let i = 0; i < flipCount; i++) {
			if (nextRandom(state) < 0.5) wins += 1;
		}
		host.answers[resKey] = { kind: 'chooseNumber', n: wins };
		host.setLastRollResult(wins);
		host.setStepDecision(wins > 0);
		host.ports.addLog(
			state,
			'rule',
			flipCount === 1
				? `${you.username} flipped a coin and ${wins > 0 ? 'won' : 'lost'} the flip (CR 705).`
				: `${you.username} flipped ${flipCount} coins and won ${wins} flip(s) (CR 705).`,
			you.playerId
		);
	} else {
		wins = saved.kind === 'chooseNumber' ? saved.n : 0;
		host.setLastRollResult(wins);
		host.setStepDecision(wins > 0);
	}

	if (wins > 0 && step.params?.winFlipEffect) {
		if (host.runInlineSteps(step.params.winFlipEffect, -1)) return;
	} else if (wins === 0 && step.params?.loseFlipEffect) {
		if (host.runInlineSteps(step.params.loseFlipEffect, -2)) return;
	}
}

export function executeRollDie(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const sides = Math.max(2, step.params?.dieSides ?? 20);
	const resKey = `dieroll:${host.stepIndex}`;

	let total: number;
	const saved = host.answers[resKey];
	if (!saved) {
		const natural = 1 + Math.floor(nextRandom(state) * sides);
		const bonus = step.params?.dieBonus ? host.amount(step.params.dieBonus, 0) : 0;
		total = natural + bonus;
		host.answers[resKey] = { kind: 'chooseNumber', n: total };
		host.setLastRollResult(total);
		host.ports.addLog(
			state,
			'rule',
			bonus !== 0
				? `${you.username} rolled a d${sides} (${natural} + ${bonus} = ${total}) (CR 706).`
				: `${you.username} rolled a d${sides}: ${total} (CR 706).`,
			you.playerId
		);
	} else {
		total = saved.kind === 'chooseNumber' ? saved.n : 1;
		host.setLastRollResult(total);
	}

	const table = step.params?.dieRollTable;
	if (table && table.length > 0) {
		for (let bIdx = 0; bIdx < table.length; bIdx++) {
			const branch = table[bIdx];
			if (total >= branch.min && total <= branch.max) {
				host.runInlineSteps(branch.effect, -(10 + bIdx));
				break;
			}
		}
	}
}

// ---- Generalized Attach (CR 701.3a–d, CR 613.7e) --------------------------------------------

export function executeAttachP10(host: P10EffectHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const attachSel = step.params?.attachObject ?? { k: 'self' as const };
	const attachments = host.objects(attachSel).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	const targets = host.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	const to = targets[0];
	if (attachments.length === 0 || !to) return;

	for (const att of attachments) {
		if (att.instanceId === to.instanceId) continue;
		const ev = evaluatePermanent(state, att);
		const isEquipment = ev.hasSubType('Equipment');
		const isAura = ev.hasSubType('Aura');
		const isFortification = ev.hasSubType('Fortification');
		if (!isEquipment && !isAura && !isFortification) continue;
		if (isEquipment && !evaluatePermanent(state, to).isCreature) continue;
		if (isFortification && !evaluatePermanent(state, to).isLand) continue;

		// CR 701.3b / 613.7e: No-op when already attached to this host; otherwise attach and allocate a fresh timestamp.
		if (!attachObject(state, att, to.instanceId)) continue;
		const attLabel = att.isFaceDown ? (att.faceDownLabel || 'Face-Down Creature') : att.card.name;
		const hostLabel = to.isFaceDown ? (to.faceDownLabel || 'Face-Down Creature') : to.card.name;
		host.ports.addLog(
			state,
			'cast',
			`${you.username} attached ${attLabel} to ${hostLabel}.`,
			you.playerId
		);
		host.ports.triggerOnAttach(state, you, att, to);
	}
}

// ---- Multi-Zone & Different-Names Search (CR 701.23b) ---------------------------------------

export function isP10ExtendedSearch(spec: SearchSpec): boolean {
	return Boolean(
		(spec.zones && spec.zones.some((z) => z !== 'library')) ||
			spec.differentNames ||
			spec.shuffleOnlyIfLibrary ||
			spec.searchedPlayer ||
			spec.destinations.some((d) => d.zone === 'exile' || d.zone === 'graveyard')
	);
}

export function executeMultiZoneSearchP10(host: P10EffectHost, step: EffectStep): void {
	const spec = step.params?.search;
	if (!spec) return;
	const state = host.state;
	const searcher = step.actor ? (host.playerRef(step.actor) ?? host.you) : host.you;
	if (searcher.lost) return;

	const searchedOwner = spec.searchedPlayer
		? (host.playerRef(spec.searchedPlayer) ?? searcher)
		: searcher;
	if (searchedOwner.lost) return;

	const zones = spec.zones && spec.zones.length > 0 ? spec.zones : (['library'] as const);
	const searchedLibrary = zones.includes('library');

	const candidates: Array<{ inst: CardInstance; zone: 'library' | 'graveyard' | 'hand' }> = [];
	for (const z of zones) {
		for (const c of searchedOwner[z]) {
			if (host.matches(c, spec.filter, z)) {
				candidates.push({ inst: c, zone: z });
			}
		}
	}

	const maxPick = Math.max(1, spec.count);
	const minPick = spec.upTo || spec.statedQuality ? 0 : Math.min(maxPick, candidates.length);

	// Build default valid selection honoring `differentNames` when set.
	const defaultIds: string[] = [];
	const seenNames = new Set<string>();
	for (const cand of candidates) {
		if (defaultIds.length >= maxPick) break;
		if (spec.differentNames) {
			const nm = cand.inst.card.name.toLowerCase();
			if (seenNames.has(nm)) continue;
			seenNames.add(nm);
		}
		defaultIds.push(cand.inst.instanceId);
	}

	let pickedIds = defaultIds;
	if (candidates.length > 0 && !searcher.isBot && host.canPause) {
		const searchKey = `p10search:${host.stepIndex}`;
		const ans = host.answers[searchKey];
		if (!ans) {
			host.pauseForChoice(
				searcher,
				`${host.title} — Search (${spec.description ?? 'cards'})`,
				`Choose ${spec.upTo || minPick === 0 ? `up to ${maxPick}` : maxPick} card(s)${spec.differentNames ? ' with different names' : ''} (${zones.join(', ')}).`,
				candidates.map((c) => c.inst.instanceId),
				minPick,
				Math.min(maxPick, candidates.length),
				zones[0],
				defaultIds,
				searchKey
			);
			return;
		}
		pickedIds = ans.kind === 'chooseObjects' ? ans.objectIds : defaultIds;
	}

	// Enforce `differentNames` and candidate membership.
	const chosenEntries: Array<{ inst: CardInstance; zone: 'library' | 'graveyard' | 'hand' }> = [];
	const usedNames = new Set<string>();
	for (const id of pickedIds) {
		if (chosenEntries.length >= maxPick) break;
		const entry = candidates.find((c) => c.inst.instanceId === id);
		if (!entry) continue;
		if (spec.differentNames) {
			const nm = entry.inst.card.name.toLowerCase();
			if (usedNames.has(nm)) continue;
			usedNames.add(nm);
		}
		chosenEntries.push(entry);
	}

	const movedCards: CardInstance[] = [];
	let tookFromLibrary = false;
	for (let i = 0; i < chosenEntries.length; i++) {
		const { inst, zone } = chosenEntries[i];
		if (zone === 'library') tookFromLibrary = true;
		const dest = spec.destinations[Math.min(i, spec.destinations.length - 1)] ?? { zone: 'hand' as const };
		const owner = state.players.find((p) => p.playerId === inst.ownerId) ?? searchedOwner;

		if (dest.zone === 'battlefield') {
			const view = resolveObjectFaces(effectiveCardForObject(inst), { zone: 'battlefield' });
			inst.tapped = Boolean(dest.tapped);
			inst.summoningSick = !view.keywords.includes('Haste');
			inst.defaultControllerId = searcher.playerId;
			moveObject(state, inst, 'battlefield', {
				from: { player: searchedOwner, zone },
				toPlayer: searcher,
				controllerId: searcher.playerId,
				bumpVersion: true,
				newTimestamp: true
			});
			if (inst.zone === 'battlefield') {
				host.ports.triggerOnEtb(state, searcher, inst);
			}
		} else if (dest.zone === 'library') {
			moveObject(state, inst, 'library', {
				from: { player: searchedOwner, zone },
				toPlayer: owner,
				insert: dest.onTop ? 'start' : 'end',
				bumpVersion: true,
				newTimestamp: true
			});
		} else if (dest.zone === 'exile') {
			moveObject(state, inst, 'exile', {
				from: { player: searchedOwner, zone },
				toPlayer: owner,
				bumpVersion: true,
				newTimestamp: true
			});
		} else if (dest.zone === 'graveyard') {
			moveObject(state, inst, 'graveyard', {
				from: { player: searchedOwner, zone },
				toPlayer: owner,
				graveyardReplacement: true,
				bumpVersion: true,
				newTimestamp: true
			});
		} else {
			moveObject(state, inst, 'hand', {
				from: { player: searchedOwner, zone },
				toPlayer: searcher,
				bumpVersion: true,
				newTimestamp: true
			});
		}
		movedCards.push(inst);
	}

	host.bind(step, movedCards);

	const shouldShuffle = spec.shuffleOnlyIfLibrary
		? searchedLibrary && (tookFromLibrary || zones.length === 1)
		: searchedLibrary;
	if (shouldShuffle) {
		// Preserve `onTop` cards if destination put a card on top of the shuffled library!
		const onTopCards = movedCards.filter(
			( idxCard, i) =>
				(spec.destinations[Math.min(i, spec.destinations.length - 1)]?.zone === 'library' &&
					spec.destinations[Math.min(i, spec.destinations.length - 1)]?.onTop) &&
				searchedOwner.library.includes(idxCard)
		);
		shuffleLibrary(state, searchedOwner);
		if (onTopCards.length > 0) {
			rearrangeLibrary(searchedOwner, onTopCards, onTopCards, []);
		}
	}
	flushTriggers(state);
}

// ---- Exploit, Crime, Expend, Descend & P10 Condition Helpers --------------------------------

export function isExploitTriggerStackItem(item: StackItem | undefined): boolean {
	if (!item || item.kind !== 'triggered') return false;
	if (item.grantedKeyword === 'exploit') return true;
	if (item.triggeredAbilityIndex === undefined || item.triggeredAbilityIndex < 0) return false;
	const defs = activeAbilityDefs(item.card, { zone: 'battlefield', faceIndex: item.faceIndex });
	const ab = defs[item.triggeredAbilityIndex];
	if (!ab || ab.kind !== 'keyword') return false;
	const { name: kwName } = ab.keyword;
	return kwName === 'exploit';
}

/**
 * CR 700.13: Checks whether `targets` target at least one opponent, permanent/spell/ability an opponent
 * controls, or card in an opponent's graveyard. If so, emits a single `CrimeCommitted` event!
 */
export function checkAndEmitCrimeCommitted(
	state: GameState,
	actorId: string,
	targets: readonly TargetRef[]
): void {
	if (!targets || targets.length === 0) return;
	let committed = false;
	for (const t of targets) {
		if (t.kind === 'player') {
			if (t.id !== actorId) {
				const pl = state.players.find((p) => p.playerId === t.id);
				if (pl && !pl.lost) {
					committed = true;
					break;
				}
			}
		} else if (t.kind === 'stack') {
			const stk = state.stack.find((s) => s.id === t.id);
			if (stk && stk.controllerId !== actorId) {
				committed = true;
				break;
			}
		} else if (t.kind === 'permanent') {
			for (const pl of state.players) {
				const perm = pl.battlefield.find((c) => c.instanceId === t.id && !c.phasedOut);
				if (perm && perm.controllerId !== actorId) {
					committed = true;
					break;
				}
			}
			if (committed) break;
		} else if (t.kind === 'graveyard_card' || t.kind === 'card_in_graveyard') {
			for (const pl of state.players) {
				if (pl.playerId === actorId) continue;
				if (pl.graveyard.some((c) => c.instanceId === t.id)) {
					committed = true;
					break;
				}
			}
			if (committed) break;
		}
	}
	if (committed) {
		emitEvent(state, { kind: 'CrimeCommitted', playerId: actorId });
	}
}

/**
 * CR 700.14: Updates cumulative mana spent on spells this turn for `player` and emits `ManaExpended`
 * when crossing a threshold (e.g. the 4th or 8th mana spent to cast spells this turn).
 */
export function recordSpellManaExpended(
	state: GameState,
	player: PlayerGameState,
	manaSpentNow: number
): void {
	if (manaSpentNow <= 0) return;
	const previousTotal = player.manaSpentOnSpellsThisTurn ?? 0;
	const newTotal = previousTotal + manaSpentNow;
	player.manaSpentOnSpellsThisTurn = newTotal;
	emitEvent(state, {
		kind: 'ManaExpended',
		playerId: player.playerId,
		previousTotal,
		newTotal,
		amountSpent: manaSpentNow
	});
}

const PERMANENT_TYPES_FOR_DESCEND = new Set([
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Land',
	'Planeswalker'
]);

/**
 * CR 700.11: A player has "descended this turn" if a permanent card (never a token!) was put into
 * their graveyard from anywhere this turn.
 */
export function recordDescendedOnZoneChange(
	state: GameState,
	movedObject: CardInstance,
	toZone: ZoneType
): void {
	if (toZone !== 'graveyard' || movedObject.isToken) return;
	const view = resolveObjectFaces(movedObject.printedCard ?? movedObject.card, { zone: 'graveyard' });
	if (!view.types.some((t) => PERMANENT_TYPES_FOR_DESCEND.has(t))) return;
	const owner = state.players.find((p) => p.playerId === movedObject.ownerId);
	if (owner && !owner.descendedThisTurn) {
		owner.descendedThisTurn = true;
		noteLayerInputsChanged(state);
	}
}

export function evaluateP10Condition(
	cond: Condition,
	ctx: {
		state: GameState;
		controllerId: string;
		source?: CardInstance;
		stackItem?: StackItem;
		eventLkiCounters?: Partial<Record<CounterType, number>>;
	}
): boolean {
	const { state, controllerId } = ctx;
	const you = state.players.find((p) => p.playerId === controllerId);
	if (!you) return false;

	switch (cond.k) {
		case 'opponentLostLifeThisTurn':
			return state.players.some(
				(p) => p.playerId !== controllerId && !p.lost && Boolean(p.lostLifeThisTurn)
			);
		case 'descendedThisTurn':
			return Boolean(you.descendedThisTurn);
		case 'hadCounterOnIt': {
			const ctrs =
				ctx.eventLkiCounters ??
				ctx.stackItem?.eventLki?.counters ??
				ctx.source?.lastKnownCounters ??
				ctx.source?.counters;
			if (!ctrs) return false;
			if (!cond.counter || cond.counter === 'any') {
				return Object.values(ctrs).some((v) => (v ?? 0) > 0);
			}
			return (ctrs[cond.counter] ?? 0) > 0;
		}
		case 'manaColorSpentToCast': {
			if (cond.color) {
				const colors = ctx.source?.manaColorsSpent ?? ctx.stackItem?.manaColorsSpent ?? [];
				if (!colors.includes(cond.color)) return false;
			}
			if (cond.minTotal !== undefined) {
				const spent = ctx.source?.manaSpentCount ?? ctx.stackItem?.manaSpentCount ?? 0;
				if (spent < cond.minTotal) return false;
			}
			return Boolean(cond.color || cond.minTotal !== undefined);
		}
		case 'opponentComparison': {
			const opps = state.players.filter((p) => p.playerId !== controllerId && !p.lost);
			if (opps.length === 0) return false;
			const metricFor = (pl: PlayerGameState): number => {
				switch (cond.metric) {
					case 'lands':
						return pl.battlefield.filter((c) => !c.phasedOut && evaluatePermanent(state, c).isLand)
							.length;
					case 'creatures':
						return pl.battlefield.filter(
							(c) => !c.phasedOut && evaluatePermanent(state, c).isCreature
						).length;
					case 'life':
						return pl.life;
					case 'hand':
						return pl.hand.length;
				}
			};
			const myVal = metricFor(you);
			return opps.some((opp) => metricFor(opp) > myVal);
		}
		default:
			return false;
	}
}
