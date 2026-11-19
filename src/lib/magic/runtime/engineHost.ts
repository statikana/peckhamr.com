import type {
	Condition,
	CostDef,
	EffectStep,
	ModalDef,
	ObjectFilter,
	Span,
	TargetSpec,
	TokenSpec
} from '../ir.ts';
import type { ManaCostRequirement } from '../oracle.ts';
import {
	effectiveBattlefieldCardAndFaceOpts,
	evaluatePermanent,
	getEffectiveActivatedAbilities as getEffectiveActivatedAbilitiesRaw,
	inspectCardContinuousBreakdown
} from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CastOption,
	ChoiceAnswer,
	CounterType,
	EffectBindingSnapshot,
	EffectiveActivatedAbility,
	GameActionPayload,
	GameLogEntry,
	GamePhase,
	GameState,
	LibrarySearchSpec,
	ManaColor,
	ManaSpendContext,
	PendingCostPayment,
	PendingPrompt,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	TargetRef,
	TargetRequirementInfo,
	TriggerEventLki,
	VfxEvent,
	ZoneType
} from '../types.ts';
import { enqueueChoicePrompt } from './choices.ts';
import {
	alternativeCostMetaById,
	type CostContext,
	describeCost,
	keywordAltCost
} from './costs.ts';
import type { P20bPitchCounts } from './costsWave7.ts';
import { resolveP19aManaChoiceColors } from './effectsWave7.ts';
import {
	activeAbilityDefs,
	instanceFaceOptions,
	resolveEffectiveActivatedAbilityDef,
	resolveObjectFaces
} from './faces.ts';
import { buildBoardSnapshot, withStableLayerInputs } from './layerCache.ts';
import type { AddManaOptions } from './mana.ts';
import { distinctColorsControlled } from './manaCountersWave11.ts';
import { evaluateCondition, type FilterContext } from './objectFilter.ts';
import { uid, type UidHolder } from './random.ts';
import { computeLibraryInsertIndex } from './tuckFreezeChosen.ts';
import {
	createEmptyCounters,
	moveObject,
	type MoveResult,
	type SbaMoveLog
} from './zones.ts';


export interface EngineRuntimeHost {
	activatedAbilitySpendContext: (state: GameState, perm: CardInstance, ab?: Partial<EffectiveActivatedAbility>, xValue?: number) => ManaSpendContext;
	addCountersToPermanent: (state: GameState, perm: CardInstance, type: CounterType, amount: number) => number;
	advanceBotBlockerDeclarations: (state: GameState) => boolean;
	advancePhaseOrStep: (state: GameState) => void;
	advanceSurveilGraveyardProcedure: (state: GameState) => void;
	applyDamageToTarget: (state: GameState, sourcePlayerId: string, target: TargetRef, amount: number) => void;
	applyGameAction: (state: GameState, actorId: string, action: GameActionPayload) => { ok: boolean; error?: string };
	applyGameActionInner: (state: GameState, actorId: string, action: GameActionPayload) => { ok: boolean; error?: string };
	autoTapManaAbilities: (state: GameState, player: PlayerGameState, perm: CardInstance, cmdIdentity: ManaColor[], spendCtx?: ManaSpendContext) => EffectiveActivatedAbility[];
	beginPhase: (state: GameState, phase: GamePhase, activePlayer?: PlayerGameState) => void;
	canPayManaWithPaymentAids: (state: GameState, actor: PlayerGameState, option: CastOption, costReq: ManaCostRequirement, spendCtx: ManaSpendContext, phyrexianLifeCount?: number, reservedIds?: ReadonlySet<string>) => { ok: boolean; reservedAidIds: Set<string> };
	canPayOrAutoTap: (player: PlayerGameState, req: ManaCostRequirement, state: GameState, phyrexianLifeCount?: number, spendCtx?: ManaSpendContext, reservedTapIds?: ReadonlySet<string>) => boolean;
	captureTargetObjectVersions: (state: GameState, targets: TargetRef[]) => Record<string, number> | undefined;
	checkActivationRestrictionsOnly: (state: GameState, actorId: string, perm: CardInstance, ab: EffectiveActivatedAbility) => { ok: boolean; error?: string };
	checkAnyCombatantHasFirstStrike: (state: GameState) => boolean;
	checkIfAllKeptMulligan: (state: GameState) => void;
	checkSpellCastOptionLegalityInner: (state: GameState, actorId: string, inst: CardInstance, fromZone: CastableSourceZone, xValue: number, option: CastOption, optionalCostCounts?: Record<string, number>, costAidIds?: Record<string, string[]>, costAidColorChoices?: Record<string, ManaColor | 'generic'>, strictCostAids?: boolean) => { ok: boolean; error?: string };
	checkStateBasedActions: (state: GameState) => void;
	chooseBotModalTriggerModes: (state: GameState, bot: PlayerGameState, item: StackItem, modal: ModalDef, usedModes?: number[]) => number[];
	chooseBotTriggerTargets: (state: GameState, bot: PlayerGameState, steps: EffectStep[], index: number, spec: TargetSpec, legal: TargetRef[]) => TargetRef[];
	cleanupEliminatedPlayer: (state: GameState, eliminated: PlayerGameState) => void;
	clearEndOfTurnAndDamage: (state: GameState) => void;
	compileOptionSpellEffects: (card: ScryfallCard, faceIndex?: number, fused?: boolean, cleaved?: boolean, giftPromised?: boolean, chosenModes?: number[]) => { unparsed: string[]; modal?: ModalDef | undefined; steps: EffectStep[]; targets: TargetSpec[]; } | null;
	costContext: (state: GameState, player: PlayerGameState, source: CardInstance, xValue: number, isSpell: boolean, baseMana: ManaCostRequirement | null, phyrexianLifeCount?: number, spendCtx?: ManaSpendContext, reservedObjectIds?: ReadonlySet<string>, canPayManaOverride?: (req: ManaCostRequirement, reservedIds?: ReadonlySet<string>) => boolean, targets?: TargetRef[]) => CostContext;
	createTokenOnBoard: (state: GameState, controller: PlayerGameState, spec: TokenSpec) => CardInstance;
	drawCards: (state: GameState, player: PlayerGameState, count: number, deferSba?: boolean) => void;
	endTheTurnImmediately: (state: GameState, actorId: string) => void;
	evaluateSpecDivideTotal: (state: GameState, actorId: string, spec: TargetSpec, sourceInst: CardInstance | undefined, xValue: number) => number | undefined;
	executeBotDeclareAttackersTurnBasedAction: (state: GameState, bot: PlayerGameState) => void;
	executeCombatDamageStep: (state: GameState, isFirstStrikeStep: boolean, chosenDamage?: Record<string, number>) => boolean;
	executeDrawTurnBasedAction: (state: GameState, activePlayer: PlayerGameState) => void;
	executeUntapTurnBasedActions: (state: GameState, activePlayer: PlayerGameState) => boolean;
	finalizeHandSpecialAction: (state: GameState, actor: PlayerGameState, pcp: PendingCostPayment) => void;
	finalizeTurnFaceUp: (state: GameState, actor: PlayerGameState, pcp: PendingCostPayment) => void;
	findMandatoryAttackerViolation: (state: GameState, actor: PlayerGameState, assignedIds?: Set<string>, currentAssignments?: ReadonlyArray<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string | null;
	}>) => string | null;
	finishCombatDamagePhase: (state: GameState) => void;
	getDynamicManaProducedAmount: (state: GameState, player: PlayerGameState, perm: CardInstance, baseAmount: number, ab?: EffectiveActivatedAbility, xValue?: number, removedCounterCount?: number) => number;
	getPendingCombatDeclarationError: (state: GameState) => string | null;
	getSpellCostRequirementForOption: (player: PlayerGameState, inst: CardInstance, state: GameState, xValue: number, option: CastOption, optionalCostCounts?: Record<string, number>, chosenModes?: number[], chosenTargets?: TargetRef[], p20bPitchCounts?: P20bPitchCounts) => ManaCostRequirement;
	hasHexproofFromQuality: (targetPerm: CardInstance, sourceCard: ScryfallCard | undefined, state: GameState, sourcePerm?: CardInstance) => boolean;
	hasLegalModalCombination: (modal: ModalDef, legalModes: number[]) => boolean;
	hasProtectionFrom: (targetPerm: CardInstance, sourceCard: ScryfallCard | undefined, state: GameState, sourcePerm?: CardInstance, isAttachmentCheck?: boolean, sourceControllerId?: string) => boolean;
	initiateLibrarySearch: (state: GameState, searchingPlayer: PlayerGameState, searchSpec: LibrarySearchSpec, item: StackItem) => void;
	isAbilityActivationConditionMet: (state: GameState, actorId: string, perm: CardInstance, cond: Condition) => boolean;
	isTargetStillValid: (state: GameState, target: TargetRef, controllerId?: string, sourceCard?: ScryfallCard, item?: StackItem) => boolean;
	isUnconfirmedAttackersStep: (state: GameState) => boolean;
	legalAuraAttachCandidates: (state: GameState, aura: CardInstance, controller: PlayerGameState) => string[];
	loseTheGame: (state: GameState, player: PlayerGameState, reason: string) => boolean;
	modalCandidateModeStatus: (state: GameState, controllerId: string, sourceCard: ScryfallCard, sourceInst: CardInstance | undefined, modal: ModalDef, usedModes: number[] | undefined, activeSpecFilter?: (sp: TargetSpec) => boolean) => { disabledIndices: number[]; legalModes: number[] };
	moveStackSpellToZone: (state: GameState, stackItem: StackItem, dest?: 'graveyard' | 'exile' | 'hand' | 'library', libraryOpts?: { position?: 'top' | 'bottom'; fromTop?: number }) => void;
	p10AddManaOptions: (ab?: EffectiveActivatedAbility) => AddManaOptions | undefined;
	payManaWithAutoTap: (player: PlayerGameState, req: ManaCostRequirement, state: GameState, phyrexianLifeCount?: number, spendCtx?: ManaSpendContext, reservedTapIds?: ReadonlySet<string>) => boolean;
	perOpponentTargetError: (state: GameState, spec: TargetSpec, chosen: readonly TargetRef[]) => string | null;
	playerHasHexproofFrom: (state: GameState, targetPlayer: PlayerGameState, actorId: string) => boolean;
	playerHasShroud: (state: GameState, targetPlayer: PlayerGameState) => boolean;
	pushMonarchInherentTrigger: (state: GameState, monarchPlayer: PlayerGameState, inherentTrigger: NonNullable<StackItem['inherentTrigger']>, title: string, description: string) => void;
	recordUsedModalModes: (perm: CardInstance | undefined, expectedVersion: number | undefined, modal: ModalDef | undefined, chosenModes: number[] | undefined) => void;
	resolveActivatedManaAbility: (state: GameState, player: PlayerGameState, perm: CardInstance, ab: EffectiveActivatedAbility | undefined, chosenColor: ManaColor | undefined, amount: number, tappedForMana?: boolean, chosenBundle?: readonly ManaColor[]) => void;
	resolveCastOptionForAction: (state: GameState, actorId: string, inst: CardInstance, fromZone: ZoneType, optionId?: string, faceIndex?: number, fused?: boolean) => { ok: true; option: CastOption } | { ok: false; error: string };
	resolveStackItemCompiledEffects: (item: StackItem) => { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef | undefined; unparsed: Span[]; } | null;
	resolveTargetDivisionsForSpecs: (state: GameState, actorId: string, specs: readonly TargetSpec[] | undefined, targets: readonly TargetRef[], targetsBySpec: readonly (readonly TargetRef[])[] | undefined, sourceCard: ScryfallCard | undefined, sourceInstanceId: string | undefined, xValue: number, providedDivisions: Record<string, number> | undefined) => { ok: true; targetDivisions?: Record<string, number> } | { ok: false; error: string };
	resolveTopOfStack: (state: GameState) => void;
	resolveTriggerPrompt: (state: GameState, prompt: PendingPrompt, promptIdx: number, answer: ChoiceAnswer | undefined) => { ok: boolean; error?: string };
	resumePendingCostPayment: (state: GameState) => void;
	resumeStackItem: (state: GameState, item: StackItem) => void;
	runSuspendUpkeep: (state: GameState, activePlayer: PlayerGameState) => void;
	setMonarch: (state: GameState, playerId: string) => void;
	specTargetCandidates: (state: GameState, controllerId: string, sourceCard: ScryfallCard, source: CardInstance | undefined, spec: TargetSpec, excludeStackItemId?: string, stackItem?: StackItem) => TargetRef[];
	spellSpendContext: (inst: CardInstance, opts?: {
		faceIndex?: number;
		fused?: boolean;
		isFaceDown?: boolean;
		// --- Track P20b ---
		state?: GameState;
		xValue?: number;
		manaCostOverride?: string;
		// --- End Track P20b ---
	}) => ManaSpendContext;
	stackAbilitySourceMatchesFilter: (state: GameState, stk: StackItem, actorId: string, abilitySourceFilter: NonNullable<TargetSpec['filter']['abilitySourceFilter']>, source?: CardInstance, stackItem?: StackItem) => boolean;
	stackItemAwaitsPrompt: (state: GameState, item: StackItem) => boolean;
	stackSpellMatchesFilterQualifiers: (state: GameState, stk: StackItem, filter: ObjectFilter, ctx: FilterContext) => boolean;
	triggerEventContext: (item: StackItem, state?: GameState) => { initialBindings?: Record<string, EffectBindingSnapshot[]> | undefined; eventObjectId: string | undefined; eventObjectVersion: number | undefined; eventPlayerId: string | undefined; defendingPlayerId: string | undefined; eventAmount: number | undefined; eventLki: TriggerEventLki | undefined; };
	triggerItemEffect: (item: StackItem) => { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef | undefined; unparsed: Span[]; } | null;
	triggerItemModal: (item: StackItem) => ModalDef | undefined;
	triggerItemTargetSpecs: (item: StackItem) => TargetSpec[];
	triggerSourceObject: (state: GameState, item: StackItem) => CardInstance | undefined;
	triggerTargetCandidates: (state: GameState, item: StackItem, spec: TargetSpec) => TargetRef[];
	triggerTargetStillLegal: (state: GameState, item: StackItem, specs: TargetSpec[], t: TargetRef) => boolean;
	tryRegenerateInsteadOfDestroy: (state: GameState, perm: CardInstance, canBeRegenerated?: boolean) => boolean;
	validateTargetLegality: (state: GameState, actorId: string, target: TargetRef, targetRequirementOrKind: TargetRequirementInfo | string, sourceCard?: ScryfallCard, sourceInstanceId?: string, sourceKindHintOrXValue?: 'spell' | 'ability' | number, xValueArg?: number) => { ok: boolean; error?: string };
}

let _engineRuntimeHost: EngineRuntimeHost | null = null;

export function registerEngineRuntimeHost(host: EngineRuntimeHost): void {
	_engineRuntimeHost = host;
}

export function H(): EngineRuntimeHost {
	if (!_engineRuntimeHost) {
		throw new Error("EngineRuntimeHost has not been registered; import src/lib/magic/engine.ts first.");
	}
	return _engineRuntimeHost;
}

export function getEffectiveActivatedAbilities(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	commanderIdentity: ManaColor[] = []
): EffectiveActivatedAbility[] {
	const condCtx: FilterContext = { state, controllerId: actor.playerId, source: perm };
	// Read-only: one layer-cache validation for all of this permanent's ability lookups (Phase 6c).
	const rawAbs = withStableLayerInputs(state, () =>
		getEffectiveActivatedAbilitiesRaw(state, actor, perm, commanderIdentity)
	);
	// --- Track P16a: Include fixed manaOrChosenColor options alongside chosenColor in producesMana ---
	let cardFaceCache: {
		effectiveCard: ScryfallCard;
		effectiveFaceOpts: ReturnType<typeof instanceFaceOptions>;
	} | null = null;
	return rawAbs.map((ab) => {
		let next =
			ab.id.startsWith('equip_') && ab.manaCost === '{0}' && !ab.costText.includes('{0}')
				? { ...ab, costText: 'Equip {0}' }
				: ab;
		if (next.isManaAbility) {
			if (!cardFaceCache) {
				cardFaceCache =
					perm.zone === 'battlefield'
						? effectiveBattlefieldCardAndFaceOpts(state, perm)
						: {
								effectiveCard: effectiveCardForObject(perm),
								effectiveFaceOpts: instanceFaceOptions(perm, perm.zone)
							};
			}
			const def = resolveEffectiveActivatedAbilityDef(
				cardFaceCache.effectiveCard,
				cardFaceCache.effectiveFaceOpts,
				next
			);
			if (def && def.kind === 'activated') {
				let extraCols: ManaColor[] | undefined;
				const addManaStepCount = def.effect.filter((s) => s.verb === 'addMana').length;
				for (const st of def.effect) {
					if (st.verb !== 'addMana') continue;
					if (st.condition && !evaluateCondition(st.condition, condCtx)) continue;
					if (st.params?.manaOrChosenColor?.length) {
						for (const col of st.params.manaOrChosenColor) {
							if (!next.producesMana.includes(col) && !(extraCols ?? []).includes(col)) {
								(extraCols ??= []).push(col);
							}
						}
					}
					// --- Track P19a ---
					if (
						st.params?.manaChoice === 'controlledLandProducedTypes' ||
						st.params?.manaChoice === 'controlledLandProducedColors'
					) {
						const landCols = resolveP19aManaChoiceColors(
							state,
							actor,
							st.params.manaChoice
						);
						for (const col of landCols) {
							if (!next.producesMana.includes(col) && !(extraCols ?? []).includes(col)) {
								(extraCols ??= []).push(col);
							}
						}
					}
					// --- End Track P19a ---
					if (st.params?.addManaPerColorControlled) {
						const perCols = distinctColorsControlled(state, actor.playerId);
						for (const col of perCols) {
							if (!next.producesMana.includes(col) && !(extraCols ?? []).includes(col)) {
								(extraCols ??= []).push(col);
							}
						}
						if (perCols.length > 0 && addManaStepCount === 1) {
							next = {
								...next,
								producesAmount: Math.max(next.producesAmount, perCols.length),
								...(perCols.length > 1 ? { manaBundles: [perCols] } : {})
							};
						}
					}
				}
				if (extraCols?.length) {
					next = {
						...next,
						producesMana: [...new Set([...extraCols, ...next.producesMana])]
					};
				}
			}
		}
		return next;
	});
	// --- End Track P16a ---
}

/**
 * Timestamp for instances created without an explicit one. The engine always passes one
 * (createInitialGameState numbers its cards per game; everything else uses allocateTimestamp), so
 * this process-wide counter only serves external callers such as tests, like uid's fallback counter.
 */
let globalInstanceTimestampSeed = 1;

export function createCardInstance(
	card: ScryfallCard,
	ownerId: string,
	zone: ZoneType,
	isCommander = false,
	isToken = false,
	enteredTimestamp?: number,
	uidHolder?: UidHolder
): CardInstance {
	const counters = createEmptyCounters();
	if (card.loyalty && zone === 'battlefield') {
		counters.loyalty = parseInt(card.loyalty, 10) || 3;
	}
	if (enteredTimestamp === undefined) globalInstanceTimestampSeed += 1;
	return {
		instanceId: uid(isToken ? 'tok' : isCommander ? 'cmd' : 'crd', uidHolder),
		card,
		ownerId,
		controllerId: ownerId,
		zone,
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters,
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken,
		isCommander,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		enteredTimestamp: enteredTimestamp ?? globalInstanceTimestampSeed,
		objectVersion: 1,
		phasedOut: false,
		isSuspended: false,
		castViaSuspend: false,
		switchedPTCount: 0
	};
}

export function addLog(
	state: GameState,
	kind: GameLogEntry['kind'],
	text: string,
	actorId?: string
): void {
	state.log.push({
		id: uid('log', state),
		timestamp: Date.now(),
		turn: state.turnNumber,
		phase: state.phase,
		actorId,
		kind,
		text
	});
	if (state.log.length > 160) {
		state.log.splice(0, state.log.length - 160);
	}
}

export function emitVfx(state: GameState, event: Omit<VfxEvent, 'id' | 'timestamp'>): void {
	state.recentVfxEvents.push({
		id: uid('vfx', state),
		timestamp: Date.now(),
		...event
	});
	if (state.recentVfxEvents.length > 35) {
		state.recentVfxEvents.splice(0, state.recentVfxEvents.length - 35);
	}
}
// --- End Track P22a ---

export function getCreaturePower(inst: CardInstance, state: GameState): number {
	const breakdown = inspectCardContinuousBreakdown(inst, state);
	if (breakdown.effectivePower !== null) {
		return breakdown.effectivePower;
	}
	const rawP = parseInt(inst.card.power || '0', 10);
	let base = isNaN(rawP) ? 0 : rawP;
	base += (inst.counters['+1/+1'] || 0) - (inst.counters['-1/-1'] || 0) + inst.tempPowerMod;
	return Math.max(0, base);
}

export function getCreatureToughness(inst: CardInstance, state: GameState): number {
	const breakdown = inspectCardContinuousBreakdown(inst, state);
	if (breakdown.effectiveToughness !== null) {
		return breakdown.effectiveToughness;
	}
	const rawT = parseInt(inst.card.toughness || '0', 10);
	let base = isNaN(rawT) ? 0 : rawT;
	base += (inst.counters['+1/+1'] || 0) - (inst.counters['-1/-1'] || 0) + inst.tempToughnessMod;
	return Math.max(0, base);
}

export function hasKeyword(inst: CardInstance, keyword: string, state: GameState): boolean {
	const kwLow = keyword.toLowerCase();
	const breakdown = inspectCardContinuousBreakdown(inst, state);
	return breakdown.items.some(
		(it) =>
			!it.removed &&
			(it.canonicalKey === kwLow ||
				it.name.toLowerCase() === kwLow ||
				(kwLow === 'ward' && it.canonicalKey === 'ward'))
	);
}

export function getPlayerCommanderIdentity(player: PlayerGameState): ManaColor[] {
	const set = new Set<ManaColor>(player.commanderColorIdentity ?? []);
	const allCards = [
		...player.command,
		...player.battlefield.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.graveyard.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.exile.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.hand.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.library.filter((c) => c.isCommander && c.ownerId === player.playerId)
	];
	for (const c of allCards) {
		for (const col of c.card.colorIdentity) set.add(col);
	}
	return Array.from(set);
}

// --- Track P15: Preparation copy casts from battlefield (CR 723.3c) ---
export type CastableSourceZone = 'hand' | 'command' | 'exile' | 'graveyard' | 'library' | 'battlefield';
// --- End Track P15 ---

export function optionTargetsBecomeEach(
	sourceCard: ScryfallCard | undefined,
	optionOrId?: CastOption | string
): boolean {
	if (!optionOrId) return false;
	if (typeof optionOrId !== 'string') return Boolean(optionOrId.spellMods.targetsBecomeEach);
	if (!sourceCard) return false;
	const found = alternativeCostMetaById(optionOrId);
	if (!found || !found.meta.targetsBecomeEach) return false;
	return keywordAltCost(sourceCard, found.keyword) !== null;
}

// --- Track P15: Omen Face 1 is castable from hand (CR 721.3); Prepare Face 1 is NOT (CR 723.3) ---
const SUPPORTED_MULTIFACE_LAYOUTS = new Set(['split', 'modal_dfc', 'adventure', 'omen']);
// --- End Track P15 ---

export function cardHasSupportedMultiFace(card: ScryfallCard): boolean {
	const layout =
		card.layout ?? (card.backFace ? 'transform' : card.faces && card.faces.length >= 2 ? 'split' : 'normal');
	return Boolean(card.faces && card.faces.length >= 2 && SUPPORTED_MULTIFACE_LAYOUTS.has(layout));
}

export function offsetTargetIndicesInSteps<T>(val: T, offset: number): T {
	if (offset <= 0 || val === null || typeof val !== 'object') return val;
	if (Array.isArray(val)) {
		return val.map((item) => offsetTargetIndicesInSteps(item, offset)) as unknown as T;
	}
	const obj = val as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = offsetTargetIndicesInSteps(v, offset);
	}
	if ((obj.k === 'target' || obj.k === 'targetPlayer') && typeof obj.index === 'number') {
		out.index = obj.index + offset;
	}
	return out as T;
}

export function isTapOnlyManaCost(defs: CostDef[]): boolean {
	return defs.every((d) => d.k === 'tapSelf' || (d.k === 'mana' && /^(\{0\})*$/.test(d.cost)));
}

export function manaCostPayEnergyAmount(defs: CostDef[]): number | null {
	let energy = 0;
	let hasTap = false;
	for (const d of defs) {
		if (d.k === 'tapSelf') {
			hasTap = true;
		} else if (d.k === 'mana' && /^(\{0\})*$/.test(d.cost)) {
			// zero-mana component
		} else if (d.k === 'payEnergy' && d.count.k === 'const' && d.count.n > 0) {
			energy += d.count.n;
		} else {
			return null;
		}
	}
	return hasTap && energy > 0 ? energy : null;
}

export function isSacrificeSelfNonCreatureManaCost(defs: CostDef[], isCreature: boolean): boolean {
	if (isCreature) return false;
	const hasSacSelf = defs.some(
		(d) => d.k === 'sacrifice' && d.filter === 'self' && d.count.k === 'const' && d.count.n === 1
	);
	if (!hasSacSelf) return false;
	return defs.every(
		(d) =>
			d.k === 'tapSelf' ||
			(d.k === 'mana' && /^(\{0\})*$/.test(d.cost)) ||
			(d.k === 'sacrifice' && d.filter === 'self' && d.count.k === 'const' && d.count.n === 1)
	);
}

export function hasBlockingReplacementOrCommanderPrompt(state: GameState): boolean {
	return (
		Boolean(state.pendingZoneMoves && state.pendingZoneMoves.length > 0) ||
		state.pendingPrompts.some(
			(p) =>
				p.choice?.kind === 'chooseReplacement' ||
				p.kind === 'chooseReplacement' ||
				p.kind === 'commander_zone_choice'
		)
	);
}

// ---- Step E2: guided (manual) operations ------------------------------------------------------

export const GUIDED_MAX_AMOUNT = 100;
export const GUIDED_ZONES: ReadonlySet<ZoneType> = new Set<ZoneType>(['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command']);

/** Any card in any player's zones (not the stack). */
export function findCardAnywhere(state: GameState, id: string): { inst: CardInstance; holder: PlayerGameState; zone: ZoneType } | null {
	for (const zone of ['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command'] as const) {
		for (const p of state.players) {
			const inst = p[zone].find((c) => c.instanceId === id);
			if (inst) return { inst, holder: p, zone };
		}
	}
	return null;
}

export function getAttackedDefenderIdsInTurnOrder(state: GameState): string[] {
	const attackedSet = new Set(state.combat.attackers.map((a) => a.defenderPlayerId));
	const ordered: string[] = [];
	const count = state.players.length;
	for (let step = 1; step <= count; step++) {
		const p = state.players[(state.activePlayerIndex + step) % count];
		if (p && !p.lost && attackedSet.has(p.playerId)) {
			ordered.push(p.playerId);
		}
	}
	return ordered;
}

export function advancePriorityToNextPlayer(state: GameState): void {
	const count = state.players.length;
	for (let step = 1; step <= count; step++) {
		const idx = (state.priorityPlayerIndex + step) % count;
		const candidate = state.players[idx];
		if (!candidate.lost) {
			state.priorityPlayerIndex = idx;
			return;
		}
	}
}

/**
 * CR 800.4j: If the active player has left the game during their turn, the turn continues
 * without an active player and the next player in turn order receives priority instead.
 */
export function givePriorityToActiveOrNextPlayer(state: GameState): void {
	state.priorityPlayerIndex = state.activePlayerIndex;
	if (state.players[state.priorityPlayerIndex]?.lost) {
		advancePriorityToNextPlayer(state);
	}
}

/**
 * CR 715.2d: A Saga's final chapter number is the greatest value among chapter abilities it has.
 * If a Saga somehow has no chapter abilities (e.g. it lost all abilities), its final chapter
 * number is 0.
 */
export function getSagaFinalChapterNumber(state: GameState, perm: CardInstance): number {
	if (perm.phasedOut || perm.isFaceDown) return 0;
	const ev = evaluatePermanent(state, perm);
	if (!ev.hasSubType('Saga') || ev.hasLostAllAbilities) return 0;
	const { effectiveCard, effectiveFaceOpts } =
		perm.zone === 'battlefield'
			? effectiveBattlefieldCardAndFaceOpts(state, perm)
			: {
					effectiveCard: effectiveCardForObject(perm),
					effectiveFaceOpts: instanceFaceOptions(perm, perm.zone)
				};
	const abilities = activeAbilityDefs(effectiveCard, effectiveFaceOpts);
	let maxChapter = 0;
	for (const ab of abilities) {
		const trig =
			ab.kind === 'triggered'
				? ab.trigger
				: ab.kind === 'unsupported'
					? ab.trigger
					: undefined;
		if (trig?.isChapterAbility && trig.chapterNumbers) {
			for (const ch of trig.chapterNumbers) {
				if (ch > maxChapter) maxChapter = ch;
			}
		}
	}
	return maxChapter;
}

/**
 * How many triggered abilities resolved on each path since the last reset (module-level, never in
 * GameState). For tests and diagnostics only.
 */
export const triggerPathCounts = { interpreter: 0, manual: 0 };

export function triggerResolutionCounts(reset = false): { interpreter: number; manual: number } {
	const out = { ...triggerPathCounts };
	if (reset) {
		triggerPathCounts.interpreter = 0;
		triggerPathCounts.manual = 0;
	}
	return out;
}

// --- Track P18b: Prepend/append non-bullet modal prefixEffect & suffixEffect riders ---
export function withModalPrefixAndSuffixEffects<
	T extends { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef; unparsed: unknown[] } | null
>(res: T, chosenModes: readonly number[] | undefined): T {
	if (!res || !res.modal || !chosenModes) return res;
	const pre = res.modal.prefixEffect;
	const suf = res.modal.suffixEffect;
	if ((!pre || pre.length === 0) && (!suf || suf.length === 0)) return res;
	const preLen = pre?.length ?? 0;
	const shiftedBody =
		preLen > 0
			? res.steps.map((st) => ({
					...st,
					...(st.ifPrecedingAccepted !== undefined
						? { ifPrecedingAccepted: st.ifPrecedingAccepted + preLen }
						: {}),
					...(st.ifPrecedingDeclined !== undefined
						? { ifPrecedingDeclined: st.ifPrecedingDeclined + preLen }
						: {})
				}))
			: res.steps;
	return {
		...res,
		steps: [...(pre ?? []), ...shiftedBody, ...(suf ?? [])]
	};
}

/**
 * CR 104.4b / CR 731: number of repeated trigger-resolution cycles for the same
 * `(sourceInstanceId, abilityIndex)` within a turn (since the last voluntary player action)
 * before the engine detects a mandatory or optional loop.
 */
export const LOOP_TRIGGER_THRESHOLD = 30;
/**
 * A runaway safety cap: triggered abilities that keep retriggering each other would otherwise grow
 * the stack (and the bot loop) without end. Past this size new triggers pause for manual resolution.
 */
export const MAX_STACK_FOR_TRIGGERS = 300;
/**
 * Hard backstop ceiling for total triggered abilities put on the stack in a single turn.
 */
export const MAX_TRIGGERS_PER_TURN = 2000;

/**
 * Clears per-ability loop tracking when a player takes a voluntary game action so a player-driven
 * combo or repeated activations in the same turn start a fresh loop-detection window.
 */
export function resetTriggerLoopTracking(state: GameState): void {
	if (state.triggersPlacedThisTurn?.byAbility) {
		delete state.triggersPlacedThisTurn.byAbility;
	}
}

/**
 * Computes both an exact board fingerprint (derived from `buildBoardSnapshot(state).active` over each
 * active permanent's `instanceId@objectVersion`, controller, tapped state, attachment, and `+1/+1`,
 * `-1/-1`, and `loyalty` counters) and a token-normalized board fingerprint (coalescing identical
 * tokens by name, typeLine, controller, and tapped state so mandatory token-creation loops also
 * repeat their normalized fingerprint). Includes per-player life, poison, lost status, library size,
 * hand size, and commander damage taken because under CR 104.4b a sequence that changes a
 * game-ending resource (life, poison, library, commander damage) will eventually end the game and is
 * not an unbreakable infinite loop.
 */
export function computeLoopBoardFingerprints(state: GameState): { exactFp: string; normFp: string } {
	const snap = buildBoardSnapshot(state);
	const playerSegment = state.players
		.map((p) => {
			const cmdDmg = Object.keys(p.commanderDamageTaken)
				.sort()
				.map((k) => `${k}=${p.commanderDamageTaken[k]}`)
				.join('|');
			return `${p.playerId}:${p.life}:${p.poison}:${p.energyCounters || 0}:${p.lost ? 1 : 0}:${p.library.length}:${p.hand.length}:${cmdDmg}`;
		})
		.join(';') + `@monarch:${state.monarchPlayerId ?? ''}`;
	const exactBoard = snap.active
		.map(
			({ perm, playerId }) =>
				`${perm.instanceId}@${perm.objectVersion ?? 0}:${perm.controllerId ?? playerId}:${perm.tapped ? 1 : 0}:${perm.attachedToId ?? ''}:${perm.counters['+1/+1']},${perm.counters['-1/-1']},${perm.counters.loyalty},${perm.counters.lore || 0}`
		)
		.join(',');
	const parts: string[] = [];
	for (const p of state.players) {
		const tokenKinds = new Set<string>();
		const nonTokenEntries: string[] = [];
		for (const c of p.battlefield) {
			if (c.isToken) {
				const ev = evaluatePermanent(state, c);
				tokenKinds.add(`${ev.effectiveName}|${ev.typeLine}|${c.controllerId ?? p.playerId}|${c.tapped ? 1 : 0}`);
			} else {
				nonTokenEntries.push(
					`${c.instanceId}@${c.objectVersion ?? 0}:${c.controllerId ?? p.playerId}:${c.tapped ? 1 : 0}:${c.counters['+1/+1']},${c.counters['-1/-1']},${c.counters.loyalty}`
				);
			}
		}
		parts.push(`${p.playerId}:[${nonTokenEntries.join(',')}]:[${[...tokenKinds].sort().join(',')}]`);
	}
	return {
		exactFp: `${exactBoard}#${playerSegment}`,
		normFp: `${parts.join(';')}#${playerSegment}`
	};
}

/** Enqueues a standalone guided_resolution prompt so a human player can resolve or intervene manually. */
export function enqueueGuidedResolutionPrompt(
	state: GameState,
	playerId: string,
	title: string,
	description: string,
	question: string
): void {
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId,
		kind: 'guided_resolution',
		purpose: 'guided_resolution',
		title,
		description,
		yesLabel: 'Done',
		choice: { kind: 'yesNo', question }
	});
}

/**
 * CR 702.26b: While a permanent is phased out, it's treated as though it does not exist.
 * `findPermanentOnBoard` returns `null` if the permanent is phased out.
 */
export function findPermanentOnBoard(
	state: GameState,
	instanceId: string
): { inst: CardInstance; owner: PlayerGameState; controller: PlayerGameState } | null {
	for (const p of state.players) {
		const inst = p.battlefield.find((c) => !c.phasedOut && c.instanceId === instanceId);
		if (inst) {
			const owner = state.players.find((o) => o.playerId === inst.ownerId) || p;
			return { inst, owner, controller: p };
		}
	}
	return null;
}

/**
 * Moves a permanent from the battlefield to `dest`, applying CR 614 zone-change replacement
 * effects (`Rest in Peace` -> Exile; Commander CR 903.9b -> Command Zone if bounced/tucked for bots)
 * and incrementing `objectVersion` (CR 400.7 new object identity).
 * Returns the actual destination zone the object ended up in.
 */
export function movePermanentToZone(
	state: GameState,
	inst: CardInstance,
	dest: ZoneType,
	sbaLog?: SbaMoveLog,
	moveOpts?: {
		skipLinkedReturn?: boolean;
		position?: 'top' | 'bottom';
		fromTop?: number;
		// --- Track P10 ---
		sacrificedByPlayerId?: string;
		suppressGraveyardLeaveBatch?: boolean;
		// --- End Track P10 ---
	}
): MoveResult {
	inst.defaultControllerId = undefined;
	const owner = state.players.find((p) => p.playerId === inst.ownerId);
	return moveObject(state, inst, dest, {
		from: 'anyBattlefield',
		detachAttachments: true,
		graveyardReplacement: true,
		commanderRedirect: true,
		leaveBattlefieldReset: true,
		bumpVersion: true,
		newTimestamp: true,
		insert: (actual) =>
			actual === 'library'
				? computeLibraryInsertIndex(
						moveOpts?.fromTop,
						moveOpts?.position ?? 'top',
						owner?.library.length ?? 0
					)
				: 'end',
		ceaseToExist: 'tokens',
		sbaLog,
		...(moveOpts?.skipLinkedReturn ? { skipLinkedReturn: true } : {}),
		// --- Track P10 ---
		...(moveOpts?.sacrificedByPlayerId
			? { sacrificedByPlayerId: moveOpts.sacrificedByPlayerId }
			: {}),
		...(moveOpts?.suppressGraveyardLeaveBatch ? { suppressGraveyardLeaveBatch: true } : {})
		// --- End Track P10 ---
	});
}

export function matchesPermanentTypeFilter(
	perm: CardInstance,
	typeFilter: string,
	state?: GameState
): boolean {
	if (perm.phasedOut) return false;
	const evalPerm = state ? evaluatePermanent(state, perm) : undefined;
	const tLine = evalPerm
		? evalPerm.typeLine
		: resolveObjectFaces(effectiveCardForObject(perm), instanceFaceOptions(perm, perm.zone)).typeLine;
	if (typeFilter === 'Permanent') return true;
	if (typeFilter === 'ArtifactOrCreature') {
		return tLine.includes('Artifact') || tLine.includes('Creature');
	}
	if (typeFilter === 'CreatureOrPlaneswalker') {
		return tLine.includes('Creature') || tLine.includes('Planeswalker');
	}
	if (typeFilter === 'ArtifactOrEnchantment') {
		return tLine.includes('Artifact') || tLine.includes('Enchantment');
	}
	if (typeFilter === 'NonlandPermanent') {
		return !tLine.includes('Land');
	}
	if (/^[A-Z][a-z]+(?:Or[A-Z][a-z]+)+$/.test(typeFilter)) {
		return typeFilter.split('Or').some((part) => tLine.includes(part));
	}
	if (typeFilter.includes(' ')) {
		const tLow = tLine.toLowerCase();
		const words = typeFilter.trim().split(/\s+/);
		return words.every((w) => {
			const wLow = w.toLowerCase();
			if (wLow === 'commander') return Boolean(perm.isCommander);
			if (evalPerm?.hasSubType(w)) return true;
			return tLow.includes(wLow);
		});
	}
	return tLine.includes(typeFilter);
}

export function allocateFaceDownLabel(state: GameState): string {
	const next = (state.faceDownLabelAllocCounter ?? 0) + 1;
	state.faceDownLabelAllocCounter = next;
	return `Face-Down #${next}`;
}

export function describeTurnUpCost(manaCost?: string, costDefs?: CostDef[]): string {
	const parts: string[] = [];
	if (manaCost) parts.push(manaCost);
	if (costDefs && costDefs.length > 0) parts.push(describeCost(costDefs));
	return parts.join(', ');
}

/**
 * CR 708.9: Reveals face-down permanents and spells to all players (when a player leaves the
 * game or at the end of a game).
 */
export function revealFaceDownObjects(state: GameState, ownerFilterId?: string): void {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (!perm.isFaceDown) continue;
			if (ownerFilterId && perm.ownerId !== ownerFilterId) continue;
			const label = perm.faceDownLabel || 'Face-Down Permanent';
			perm.isFaceDown = false;
			perm.faceDownSpec = undefined;
			perm.faceDownLabel = undefined;
			addLog(
				state,
				'rule',
				`CR 708.9: ${label} is revealed as ${perm.card.name}.`,
				perm.controllerId
			);
		}
	}
	for (const item of state.stack) {
		if (!item.isFaceDown) continue;
		const itemOwnerId = item.ownerId || item.controllerId;
		if (ownerFilterId && itemOwnerId !== ownerFilterId) continue;
		const label = item.faceDownLabel || 'Face-Down Spell';
		item.isFaceDown = false;
		item.faceDownSpec = undefined;
		item.faceDownLabel = undefined;
		addLog(
			state,
			'rule',
			`CR 708.9: ${label} on the stack is revealed as ${item.card.name}.`,
			item.controllerId
		);
	}
	for (const p of state.players) {
		for (const ex of p.exile) {
			if (!ex.isFaceDown || !ex.foretoldByPlayerId) continue;
			if (ownerFilterId && ex.ownerId !== ownerFilterId) continue;
			const label = ex.faceDownLabel || 'Face-Down Card';
			ex.isFaceDown = false;
			ex.faceDownSpec = undefined;
			ex.faceDownLabel = undefined;
			addLog(
				state,
				'rule',
				`CR 702.143f: ${label} in exile is revealed as ${ex.card.name}.`,
				ex.ownerId
			);
		}
	}
}
