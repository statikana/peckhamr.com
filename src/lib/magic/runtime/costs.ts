/**
 * Cost legality and payment from IR CostDefs (ENGINE_ARCHITECTURE_PLAN.md section 2, Phase 4).
 *
 * Costs come from the compiled card (compiler/costs.ts via compileCard); this module never reads
 * rules text or card names. Paying works in two steps so nothing is paid unless everything can be:
 *
 * 1. `planCosts` resolves choices between costs and the objects each cost needs. A choice the player
 *    hasn't made yet is returned as a `question` (the engine turns it into a `cost_choice` prompt for
 *    humans; bots answer in ai.ts). A choice with exactly one legal answer is made automatically.
 * 2. `payPlannedCosts` pays a complete plan: tap/untap costs first (so auto-tapping for mana can't
 *    use the same permanents), then mana, then the rest (CR 601.2h: random costs last).
 *
 * Zone changes go through runtime/zones.ts `moveObject`.
 */
import { nextRandom } from './random.ts';
import { grantedAbilityById } from '../compiler/index.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import type {
	AbilityDef,
	Amount,
	CostDef,
	KeywordDef,
	ObjectFilter,
	// --- Track P18b ---
	SpellCastRestrictionKind,
	// --- End Track P18b ---
	StaticDef
} from '../ir.ts';
import {
	ALTERNATIVE_COST_KEYWORDS,
	getKeywordSpec,
	type AlternativeCostKeywordMeta
} from '../keywords.ts';
import { parseManaCost, type ManaCostRequirement } from '../oracle.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type {
	CardInstance,
	CastOption,
	CostPayment,
	CounterType,
	EffectiveActivatedAbility,
	FaceDownSpec,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	SerializedPlannedCost,
	// --- Track P19a ---
	SacrificedCostLkiEntry,
	// --- End Track P19a ---
	// --- Track P11 ---
	TargetRef
	// --- End Track P11 ---
} from '../types.ts';
import { evaluateAmount, evaluateCondition, matchesObjectFilter, type FilterContext } from './objectFilter.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
// --- Track P18b ---
import { getPermanentMaxLoyaltyActivationsPerTurn } from './framesModalsWave6.ts';
// --- End Track P18b ---
import {
	computeKickerTracking,
	evaluateKickedCountAmount,
	evaluateKickerCondition,
	expandOptionalAdditionalCosts,
	getObjectKickerInfo,
	hasReturnToHandOptionalCost,
	isCastConditionMet,
	isObjectEscaped,
	isObjectEvoked,
	spellOptionalAdditionalCosts,
	validateOptionalCostCounts
} from './kicker.ts';
import { emitEvent } from './events.ts';
import { hasRestriction, playerLifeTotalCantChange } from './replace.ts';
// --- Track P8 ---
import { markHandCardRevealedToAll } from './staticsLayersAndRestrictions.ts';
// --- Track P11 ---
import {
	boardMayGrantStaticAbility,
	cardMayHaveCostModifier,
	collectActiveGrantedStaticDefs
} from './staticsDynamicAndCosts.ts';
// --- End Track P11 ---
import { exertPermanent } from './tuckFreezeChosen.ts';
import { moveObject, tapPermanent, type MoveResult, type PlayerZone } from './zones.ts';
// --- Track P10 ---
import { resolveQuotedAbilityDefs } from './reflexiveManaAndActions.ts';
// --- End Track P10 ---
import { effectiveCardForObject } from '../scryfall.ts';
// --- Track P12 ---
import { recordPlayerLifeLossWave4 } from './keywordsWave4.ts';
// --- End Track P12 ---
// --- Track P20a ---
import { canActivateAsThoughHaste } from './staticsWave7.ts';
// --- End Track P20a ---
// --- Track P14 ---
import {
	addCountersForCostOnPermanent,
	findBeholdCandidates,
	findWaterbendTapCandidates
} from './staticsAndCostsWave5.ts';
// --- End Track P14 ---
// --- Track P15 ---
import { onPlayerLostLifeCheckSpeedTrigger } from './framesBattlesAndKeywordsWave5.ts';
// --- End Track P15 ---
// --- Track P17b ---
import {
	checkSimpleP17bCost,
	deductMatchingCountersWave6,
	describeP17bCost,
	executeP17bCostPart,
	findCostCandidateByIdWave6,
	isP17bObjectCostDef,
	matchesP17bAbilityCostMod,
	matchesP17bSpellCostMod,
	p17bObjectCandidates,
	payP17bUntapOthers,
	pickGreedyP17bObjects,
	planP17bSpecialCostPart,
	serializeP17bCostPart,
	totalMatchingCountersWave6,
	type P17bSpellCastMeta
} from './costsWave6.ts';
// --- End Track P17b ---
// --- Track P20b ---
import {
	checkSimpleP20bCost,
	computeDefilerColoredReduction,
	describeP20bCost,
	executeP20bCostPart,
	getCommanderTaxLifeCostP20b,
	hasActiveFirstActivationZeroCost,
	p20bObjectCandidates,
	pickGreedyP20bObjects,
	planP20bSelfCounterPart,
	planP20bSpecialCostPart,
	serializeP20bCostPart,
	type P20bPitchCounts
} from './costsWave7.ts';
// --- End Track P20b ---
// --- Track P19a ---
import { captureP19aSacrificedCostLki } from './effectsWave7.ts';
// --- End Track P19a ---
// --- Track P22b ---
import {
	checkSimpleP22bCost,
	describeP22bCost,
	executeP22bCostPart,
	matchesP22bCostModifierWho,
	p22bObjectCandidates,
	pickGreedyP22bObjects,
	planP22bSpecialCostPart
} from './triggersWave8.ts';
// --- End Track P22b ---

export type { SerializedPlannedCost };
export {
	computeKickerTracking,
	evaluateKickedCountAmount,
	evaluateKickerCondition,
	expandOptionalAdditionalCosts,
	getObjectKickerInfo,
	hasReturnToHandOptionalCost,
	isCastConditionMet,
	isObjectEscaped,
	isObjectEvoked,
	spellOptionalAdditionalCosts,
	validateOptionalCostCounts
};

// ---- Where costs come from ------------------------------------------------------------------

export interface CostSource {
	defs: CostDef[];
	/** False if part of the cost is unparsed. The parsed parts are still paid; the rest isn't enforced. */
	complete: boolean;
}

function abilitiesOf(card: ScryfallCard, faceIndex = 0, fused = false): AbilityDef[] {
	return activeAbilityDefs(card, { zone: 'stack', faceIndex, fused });
}

/**
 * The cost of an activated ability, by its id. Abilities with an explicit `cost` array on
 * `EffectiveActivatedAbility` use that directly; otherwise look up on the compiled card.
 */
export function activatedAbilityCost(
	card: ScryfallCard,
	ab: Pick<EffectiveActivatedAbility, 'id' | 'loyaltyCost' | 'manaCost' | 'requiresTap' | 'lifeCost' | 'requiresSacrificeSelf'> &
		Partial<Pick<EffectiveActivatedAbility, 'cost' | 'costComplete' | 'faceIndex'>>
): CostSource {
	if (ab.cost) return { defs: ab.cost, complete: ab.costComplete ?? true };
	const rawMatch = ab.id.match(/^f(\d+):(.+)$/);
	const faceIndex = rawMatch ? Number(rawMatch[1]) : (ab.faceIndex ?? 0);
	const baseId = rawMatch ? rawMatch[2] : ab.id;
	const ir = abilitiesOf(card, faceIndex).find(
		(a) => (a.kind === 'activated' || a.kind === 'unsupported') && a.id === baseId
	);
	if (ir?.kind === 'activated') return { defs: ir.cost, complete: true };
	if (ir?.kind === 'unsupported' && ir.cost) return { defs: ir.cost, complete: ir.costComplete ?? false };
	return { defs: legacyCostDefs(ab), complete: true };
}

/** The keyword table: costs that come from a keyword ("Equip {2}", "Overload {6}{U}"). */
export function legacyCostDefs(
	ab: Pick<EffectiveActivatedAbility, 'loyaltyCost' | 'manaCost' | 'requiresTap' | 'lifeCost' | 'requiresSacrificeSelf'>
): CostDef[] {
	const defs: CostDef[] = [];
	if (ab.loyaltyCost !== null) defs.push({ k: 'loyalty', delta: ab.loyaltyCost });
	if (ab.manaCost && ab.manaCost !== '{0}') defs.push({ k: 'mana', cost: ab.manaCost });
	if (ab.requiresTap) defs.push({ k: 'tapSelf' });
	if (ab.lifeCost > 0) defs.push({ k: 'payLife', amount: { k: 'const', n: ab.lifeCost } });
	if (ab.requiresSacrificeSelf) defs.push({ k: 'sacrifice', count: { k: 'const', n: 1 }, filter: 'self' });
	return defs;
}

/** The additional cost of casting a spell ("As an additional cost to cast ~, ..."), if it has one. */
export function spellAdditionalCost(card: ScryfallCard, faceIndex = 0, fused = false): CostSource | null {
	const defs: CostDef[] = [];
	let complete = true;
	let matched = false;
	for (const a of abilitiesOf(card, faceIndex, fused)) {
		if (a.kind === 'spell' && a.additionalCosts.length > 0) {
			defs.push(...a.additionalCosts);
			matched = true;
		// --- Track P12 ---
		} else if (
			a.kind === 'static' &&
			a.static.k === 'additionalCastCost' &&
			a.static.costs.length > 0
		) {
			defs.push(...a.static.costs);
			matched = true;
		// --- End Track P12 ---
		} else if (
			// --- Track P11: Permanent spell self-additional costs ---
			a.kind === 'static' &&
			a.static.k === 'costModifier' &&
			a.static.affects.k === 'self' &&
			a.static.delta.additionalCosts &&
			a.static.delta.additionalCosts.length > 0
		) {
			defs.push(...a.static.delta.additionalCosts);
			matched = true;
			// --- End Track P11 ---
		} else if (a.kind === 'unsupported' && a.id === 'cast') {
			defs.push(...(a.cost ?? []));
			if (!a.costComplete) complete = false;
			matched = true;
		}
	}
	return matched ? { defs, complete } : null;
}

/** Cast timing restrictions on a spell from the compiled IR (CR 601.3). */
export function spellCastRestrictions(
	card: ScryfallCard,
	faceIndex = 0,
	fused = false
): SpellCastRestrictionKind[] {
	const out: SpellCastRestrictionKind[] = [];
	for (const a of abilitiesOf(card, faceIndex, fused)) {
		if ((a.kind === 'spell' || (a.kind === 'unsupported' && a.id === 'cast')) && a.castRestrictions) {
			for (const r of a.castRestrictions) {
				if (!out.includes(r)) out.push(r);
			}
		}
	}
	return out;
}

/** Suspend keyword parameters from the compiled card (CR 702.62). */
export function getSuspendSpec(
	card: ScryfallCard
): { timeCounters: number; cost: string; suspendCost: string } | null {
	for (const { name: kwName, n, cost } of keywordsOf(card)) {
		if (kwName === 'suspend' && n !== undefined && cost) {
			return { timeCounters: n, cost, suspendCost: cost };
		}
	}
	return null;
}

/** A keyword's cost from the compiled card, e.g. `keywordCost(card, 'overload')` → '{6}{U}'. */
export function keywordCost(card: ScryfallCard, name: string): string | null {
	for (const a of abilitiesOf(card)) {
		if (a.kind === 'keyword' && a.keyword.name === name && a.keyword.cost) return a.keyword.cost;
	}
	return null;
}

/**
 * Extracts a keyword alternative cost (mana cost, non-mana `CostDef[]`, and display summary) from
 * a compiled card's `KeywordDef`. Supports mana-only, pure non-mana, and composite costs.
 */
export function keywordAltCost(
	card: ScryfallCard,
	kwName: string,
	faceIndex = 0
): { manaCost?: string; costDefs: CostDef[]; display: string } | null {
	for (const a of abilitiesOf(card, faceIndex)) {
		if (a.kind !== 'keyword' || a.keyword.name !== kwName) continue;
		const kw = a.keyword;
		const defs = kw.costDefs;
		if (defs && defs.length > 0) {
			const manaParts = defs.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana');
			const nonManaDefs = defs.filter((d) => d.k !== 'mana');
			const manaCost =
				kw.cost ??
				(manaParts.length > 0 ? manaParts.map((m) => m.cost).join('') : undefined);
			const displayParts: string[] = [];
			if (manaCost) displayParts.push(manaCost);
			if (nonManaDefs.length > 0) displayParts.push(describeCost(nonManaDefs));
			return {
				...(manaCost !== undefined ? { manaCost } : {}),
				costDefs: nonManaDefs,
				display: displayParts.join(', ') || '{0}'
			};
		}
		if (kw.cost) {
			return {
				manaCost: kw.cost,
				costDefs: [],
				display: kw.cost
			};
		}
	}
	return null;
}

/**
 * Whether casting the card means choosing X (CR 601.2b): {X} in the paid mana cost (printed mana
 * cost normally, or the selected alternative mana cost), or X in an additional cost / alternative
 * cost definition such as Toxic Deluge's "pay X life".
 */
export function spellChoosesX(
	card: ScryfallCard,
	baseCost?: CastOption['baseCost'] | string,
	extraManaCosts?: string[],
	faceIndex = 0,
	fused = false,
	isFaceDown = false
): boolean {
	let costStr = isFaceDown ? '' : resolveObjectFaces(card, { zone: 'stack', faceIndex, fused }).manaCost;
	let altCostDefs: CostDef[] | undefined;
	if (typeof baseCost === 'string') {
		costStr = baseCost;
	} else if (baseCost?.kind === 'alternative') {
		costStr = baseCost.manaCost ?? '';
		altCostDefs = baseCost.costDefs;
	} else if (baseCost?.kind === 'free') {
		costStr = '';
	}
	if (/\{X\}/i.test(costStr)) return true;
	if (extraManaCosts?.some((c) => /\{X\}/i.test(c))) return true;
	// --- Track P14 ---
	const mentionsX = (defs: CostDef[] | undefined): boolean => {
		if (!defs || defs.length === 0) return false;
		const serialized = JSON.stringify(defs);
		return serialized.includes('"k":"x"') || /\{X\}/i.test(serialized);
	};
	// --- End Track P14 ---
	if (mentionsX(altCostDefs)) return true;
	if (isFaceDown) return false;
	return abilitiesOf(card, faceIndex, fused).some(
		(a) =>
			(a.kind === 'spell' && mentionsX(a.additionalCosts)) ||
			// --- Track P12 ---
			(a.kind === 'static' && a.static.k === 'additionalCastCost' && mentionsX(a.static.costs)) ||
			// --- End Track P12 ---
			// --- Track P11 ---
			(a.kind === 'static' &&
				a.static.k === 'costModifier' &&
				a.static.affects.k === 'self' &&
				mentionsX(a.static.delta.additionalCosts)) ||
			// --- End Track P11 ---
			(a.kind === 'unsupported' && a.id === 'cast' && mentionsX(a.cost))
	);
}

export { ALTERNATIVE_COST_KEYWORDS, type AlternativeCostKeywordMeta };

/** Look up an alternative-cost keyword entry by CastOption `id` (e.g. `'alt:overload'`). */
export function alternativeCostMetaById(
	optionId: string
): { keyword: string; meta: AlternativeCostKeywordMeta } | null {
	for (const [keyword, meta] of Object.entries(ALTERNATIVE_COST_KEYWORDS)) {
		if (meta.id === optionId) return { keyword, meta };
	}
	return null;
}

export function keywordsOf(card: ScryfallCard): KeywordDef[] {
	return abilitiesOf(card).flatMap((a) => (a.kind === 'keyword' ? [a.keyword] : []));
}

const EMPTY_COST_MODS: Array<Extract<StaticDef, { k: 'costModifier' }>> = [];

/** The cost-modifying statics of a card (CR 601.2f), including registry `'static'` keywords (e.g. Affinity). */
export function costModifiersOf(
	card: ScryfallCard,
	faceOpts?: Parameters<typeof activeAbilityDefs>[1]
): Array<Extract<StaticDef, { k: 'costModifier' }>> {
	// --- Track P11: O(1) skip when no face of `card` compiles any costModifier ---
	if (!faceOpts?.copiableState?.card && !cardMayHaveCostModifier(card)) {
		return EMPTY_COST_MODS;
	}
	// --- End Track P11 ---
	const out: Array<Extract<StaticDef, { k: 'costModifier' }>> = [];
	for (const a of activeAbilityDefs(card, faceOpts)) {
		if (a.kind === 'static' && a.static.k === 'costModifier') {
			out.push(a.static);
		} else if (a.kind === 'keyword') {
			const spec = getKeywordSpec(a.keyword.name);
			if (spec?.status === 'implemented' && spec.implementation?.kind === 'static') {
				for (const st of spec.implementation.buildStatics(a.keyword)) {
					if (st.k === 'costModifier') out.push(st);
				}
			}
		}
	}
	return out;
}

/**
 * Computes the effective mana cost requirement for casting `inst` (CR 601.2f): base mana cost (or
 * alternative/free base cost from `CastOption`), plus Commander Tax from the command zone, plus
 * active `StaticDef{k:'costModifier'}` reductions/increases from the spell itself, the battlefield,
 * and the command zone (Eminence).
 */
export function effectiveSpellManaCost(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	xValue = 0,
	baseCost?: CastOption['baseCost'] | string,
	extraManaCosts?: string[],
	faceIndex = 0,
	fused = false,
	faceDownSpec?: FaceDownSpec,
	prototyped?: boolean,
	// --- Track P11 ---
	chosenTargets?: TargetRef[],
	// --- End Track P11 ---
	// --- Track P17b & P20b ---
	castMeta?: P17bSpellCastMeta & {
		optionalCostCounts?: Record<string, number>;
		p20bPitchCounts?: P20bPitchCounts;
	}
	// --- End Track P17b & P20b ---
): ManaCostRequirement {
	// Read-only: one layer-cache validation for the battlefield scan (Phase 6d).
	return withStableLayerInputs(state, () =>
		effectiveSpellManaCostInner(
			state,
			player,
			inst,
			xValue,
			baseCost,
			extraManaCosts,
			faceIndex,
			fused,
			faceDownSpec,
			prototyped,
			chosenTargets,
			castMeta
		)
	);
}

function effectiveSpellManaCostInner(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	xValue: number,
	baseCost?: CastOption['baseCost'] | string,
	extraManaCosts?: string[],
	faceIndex = 0,
	fused = false,
	faceDownSpec?: FaceDownSpec,
	prototyped?: boolean,
	// --- Track P11 ---
	chosenTargets?: TargetRef[],
	// --- End Track P11 ---
	// --- Track P17b & P20b ---
	castMeta?: P17bSpellCastMeta & {
		optionalCostCounts?: Record<string, number>;
		p20bPitchCounts?: P20bPitchCounts;
	}
	// --- End Track P17b & P20b ---
): ManaCostRequirement {
	const card = inst.copiableCard ?? inst.card;
	const stackFaceOpts = {
		zone: 'stack' as const,
		faceIndex,
		fused,
		...(prototyped ? { prototyped: true } : {}),
		...(faceDownSpec ? { isFaceDown: true, faceDownSpec } : {})
	};
	let baseCostStr = resolveObjectFaces(card, stackFaceOpts).manaCost;
	if (typeof baseCost === 'string') {
		baseCostStr = baseCost;
	} else if (baseCost?.kind === 'alternative') {
		baseCostStr = baseCost.manaCost ?? '';
	} else if (baseCost?.kind === 'free') {
		baseCostStr = '';
	}
	const effectiveX = spellChoosesX(card, baseCost, extraManaCosts, faceIndex, fused, Boolean(faceDownSpec)) ? xValue : 0;

	let forceZeroCost = false;
	let genericReduction = 0;
	let genericIncrease = 0;
	// --- Track P11 ---
	const coloredReduction: Partial<Record<ManaColor, number>> = {};
	const hybridColoredReduction: Array<[ManaColor, ManaColor]> = [];
	let hasColoredReduction = false;
	let coloredOnly = false;
	let minTotalMana = 0;
	let extraColoredIncreaseStr = '';
	// --- End Track P11 ---

	const applyDelta = (mod: Extract<StaticDef, { k: 'costModifier' }>, ctx: FilterContext) => {
		const perAmount = mod.delta.per ?? mod.delta.times;
		const factor = perAmount ? Math.max(0, evaluateAmount(perAmount, ctx)) : 1;
		if (factor === 0 && perAmount) return;
		if (mod.delta.mode === 'setZero') {
			forceZeroCost = true;
		} else if (mod.delta.mode === 'reduce') {
			// --- Track P17b ---
			if (mod.delta.generic) {
				let genRed = mod.delta.generic * factor;
				if (mod.delta.maxReduction !== undefined && genRed > mod.delta.maxReduction) {
					genRed = mod.delta.maxReduction;
				}
				genericReduction += genRed;
			}
			// --- End Track P17b ---
			// --- Track P11 ---
			if (mod.delta.colored) {
				for (const [col, amt] of Object.entries(mod.delta.colored) as Array<[ManaColor, number]>) {
					if (amt > 0) {
						coloredReduction[col] = (coloredReduction[col] ?? 0) + amt * factor;
						hasColoredReduction = true;
					}
				}
			}
			if (mod.delta.hybridColored) {
				for (let f = 0; f < factor; f++) {
					for (const pair of mod.delta.hybridColored) {
						hybridColoredReduction.push(pair);
						hasColoredReduction = true;
					}
				}
			}
			if (mod.delta.coloredOnly) coloredOnly = true;
			if (mod.delta.minTotalMana && mod.delta.minTotalMana > minTotalMana) {
				minTotalMana = mod.delta.minTotalMana;
			}
			// --- End Track P11 ---
		} else if (mod.delta.mode === 'increase') {
			if (mod.delta.generic) genericIncrease += mod.delta.generic * factor;
			// --- Track P11 ---
			if (mod.delta.colored) {
				for (const [col, amt] of Object.entries(mod.delta.colored) as Array<[ManaColor, number]>) {
					if (amt > 0) extraColoredIncreaseStr += `{${col}}`.repeat(amt * factor);
				}
			}
			if (mod.delta.hybridColored) {
				for (let f = 0; f < factor; f++) {
					for (const [c1, c2] of mod.delta.hybridColored) {
						extraColoredIncreaseStr += `{${c1}/${c2}}`;
					}
				}
			}
			// --- End Track P11 ---
		}
	};

	const matchesWho = (mod: Extract<StaticDef, { k: 'costModifier' }>, sourceControllerId: string): boolean => {
		if (mod.who.relation === 'you') return sourceControllerId === player.playerId;
		if (mod.who.relation === 'opponent' || mod.who.relation === 'each_opponent') {
			return sourceControllerId !== player.playerId;
		}
		return true;
	};

	const stackProxy: CardInstance & {
		targets?: TargetRef[];
		castSourceZone?: CardInstance['zone'];
	} = {
		...inst,
		zone: 'stack',
		activeFaceIndex: faceIndex,
		...(prototyped ? { prototyped: true } : {}),
		...(faceDownSpec ? { isFaceDown: true, faceDownSpec } : {}),
		...(fused ? { copiableState: { ...(inst.copiableState ?? { card }), faceIndex, fused: true } } : {}),
		// --- Track P11 ---
		...(chosenTargets !== undefined ? { targets: chosenTargets } : {}),
		// --- End Track P11 ---
		// --- Track P14 ---
		castSourceZone: inst.zone,
		// --- End Track P14 ---
		// --- Track P17b ---
		...(castMeta?.kickedTags ? { kickedTags: castMeta.kickedTags } : {})
		// --- End Track P17b ---
	};
	const matchesSpell = (
		mod: Extract<StaticDef, { k: 'costModifier' }>,
		sourceControllerId: string,
		sourceInst: CardInstance
	): boolean => {
		if (mod.affects.k !== 'spell') return false;
		if (mod.affects.filter.other && sourceInst.instanceId === inst.instanceId) {
			return false;
		}
		const fctx: FilterContext = {
			state,
			controllerId: sourceControllerId,
			source: sourceInst,
			xValue: effectiveX
		};
		// --- Track P17b ---
		const p17bMatch = matchesP17bSpellCostMod(
			mod,
			stackProxy,
			sourceInst,
			fctx,
			chosenTargets,
			castMeta,
			matchesObjectFilter
		);
		if (p17bMatch !== null) return p17bMatch;
		// --- End Track P17b ---
		// --- Track P11 (CR 601.2c -> 601.2f): pre-target optimistic check for targeting reductions ---
		if (
			chosenTargets === undefined &&
			mod.delta.mode === 'reduce' &&
			mod.affects.filter.targetsSelf &&
			sourceInst.zone === 'battlefield' &&
			!sourceInst.phasedOut
		) {
			const withoutTargetsSelf: ObjectFilter = { ...mod.affects.filter };
			delete withoutTargetsSelf.targetsSelf;
			return matchesObjectFilter(stackProxy, withoutTargetsSelf, fctx);
		}
		// --- End Track P11 ---
		return matchesObjectFilter(stackProxy, mod.affects.filter, fctx);
	};

	// 1. Self cost modifiers on the spell itself ("This spell costs {1} less to cast for each ...").
	// Face-down spells have no abilities (CR 708.2a), so hidden self-modifiers never apply (CR 708.4).
	if (!faceDownSpec) {
		const selfCtx: FilterContext = {
			state,
			controllerId: player.playerId,
			source: stackProxy,
			xValue: effectiveX,
			// --- Track P20b ---
			...(chosenTargets ? { spellTargets: chosenTargets } : {}),
			...(castMeta?.p20bPitchCounts
				? {
						stackItem: {
							spellMods: castMeta.p20bPitchCounts,
							removedCounterCount: castMeta.p20bPitchCounts.removedCostCounterCount
						} as FilterContext['stackItem']
					}
				: {})
			// --- End Track P20b ---
		};
		for (const mod of costModifiersOf(card, stackFaceOpts)) {
			if (mod.affects.k !== 'self') continue;
			if (mod.condition) {
				// --- Track P11: pre-target optimistic check for "if it targets a <filter>" self-reductions ---
				if (
					chosenTargets === undefined &&
					mod.delta.mode === 'reduce' &&
					mod.condition.k === 'matchesFilter' &&
					(!mod.condition.target || mod.condition.target.k === 'self') &&
					mod.condition.filter.targetsFilter
				) {
					const tf = mod.condition.filter.targetsFilter;
					const hasMatchingPerm = state.players.some(
						(pl) =>
							!pl.lost &&
							pl.battlefield.some(
								(b) => !b.phasedOut && matchesObjectFilter(b, tf, selfCtx)
							)
					);
					if (!hasMatchingPerm) continue;
				} else if (!evaluateCondition(mod.condition, selfCtx)) {
					continue;
				}
				// --- End Track P11 ---
			}
			applyDelta(mod, selfCtx);
		}
	}

	// 2. Active cost modifiers on the battlefield and in the command zone (Eminence).
	// --- Track P11 ---
	const mayGrantSpellCostMod = boardMayGrantStaticAbility(state, 'costModifier');
	// --- End Track P11 ---
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			// --- Track P17b: Include spellTargets on FilterContext for per-target battlefield cost modifiers ---
			const ctx = {
				state,
				controllerId: p.playerId,
				source: perm,
				xValue: effectiveX,
				...(chosenTargets ? { spellTargets: chosenTargets } : {})
			} as FilterContext;
			// --- End Track P17b ---
			const pCard = perm.copiableCard ?? perm.card;
			const mods = costModifiersOf(pCard, instanceFaceOptions(perm, 'battlefield'));
			if (mods.length > 0 && !evaluatePermanent(state, perm).losesAllAbilities) {
				for (const mod of mods) {
					const zones = mod.activeZones ?? ['battlefield'];
					if (!zones.includes('battlefield')) continue;
					if (!matchesWho(mod, p.playerId)) continue;
					// --- Track P22b ---
					if (!matchesP22bCostModifierWho(mod, perm, player.playerId)) continue;
					// --- End Track P22b ---
					if (mod.condition && !evaluateCondition(mod.condition, ctx)) continue;
					if (!matchesSpell(mod, p.playerId, perm)) continue;
					applyDelta(mod, ctx);
				}
			}
			// --- Track P11: Layer 6 granted costModifier statics ---
			if (mayGrantSpellCostMod) {
				for (const gDef of collectActiveGrantedStaticDefs(state, perm)) {
					if (gDef.k !== 'costModifier') continue;
					const zones = gDef.activeZones ?? ['battlefield'];
					if (!zones.includes('battlefield')) continue;
					if (!matchesWho(gDef, p.playerId)) continue;
					// --- Track P22b ---
					if (!matchesP22bCostModifierWho(gDef, perm, player.playerId)) continue;
					// --- End Track P22b ---
					if (gDef.condition && !evaluateCondition(gDef.condition, ctx)) continue;
					if (!matchesSpell(gDef, p.playerId, perm)) continue;
					applyDelta(gDef, ctx);
				}
			}
			// --- End Track P11 ---
		}
		for (const cmd of p.command) {
			// --- Track P13: Ring emblem does not carry cost modifiers; custom emblems function in command zone (CR 114.4) ---
			if (cmd.isRingEmblem) continue;
			const cCard = cmd.copiableCard ?? cmd.card;
			const ctx = {
				state,
				controllerId: p.playerId,
				source: cmd,
				xValue: effectiveX,
				...(chosenTargets ? { spellTargets: chosenTargets } : {})
			} as FilterContext;
			for (const mod of costModifiersOf(cCard, instanceFaceOptions(cmd, cmd.zone))) {
				if (!cmd.isEmblem && !mod.activeZones?.includes('command')) continue;
				if (!matchesWho(mod, p.playerId)) continue;
				if (mod.condition && !evaluateCondition(mod.condition, ctx)) continue;
				if (!matchesSpell(mod, p.playerId, cmd)) continue;
				applyDelta(mod, ctx);
			}
			// --- End Track P13 ---
		}
	}
	// --- Track P17b: Stack-active spell cost modifiers ("As long as ~ is on the stack, spells that target it cost {2} more to cast") ---
	for (const stk of state.stack) {
		if (stk.kind !== 'spell' || !stk.card || stk.sourceInstanceId === inst.instanceId) continue;
		const mods = costModifiersOf(stk.card, { zone: 'stack', faceIndex: stk.faceIndex });
		if (mods.length === 0) continue;
		const stkSource: CardInstance = {
			...inst,
			instanceId: stk.id,
			card: stk.card,
			ownerId: stk.controllerId,
			controllerId: stk.controllerId,
			zone: 'stack',
			tapped: false,
			summoningSick: false,
			counters: {} as CardInstance['counters'],
			damageMarked: 0,
			attachedToId: null,
			isToken: false
		};
		const stkCtx: FilterContext = {
			state,
			controllerId: stk.controllerId,
			source: stkSource,
			xValue: effectiveX
		};
		for (const mod of mods) {
			if (!mod.activeZones?.includes('stack')) continue;
			if (!matchesWho(mod, stk.controllerId)) continue;
			if (mod.condition && !evaluateCondition(mod.condition, stkCtx)) continue;
			if (!matchesSpell(mod, stk.controllerId, stkSource)) continue;
			applyDelta(mod, stkCtx);
		}
	}
	// --- End Track P17b ---

	// --- Track P20b: Defiler optional life-for-colored-mana pip reductions (CR 118.7c) ---
	const defilerRed = computeDefilerColoredReduction(
		state,
		player,
		castMeta?.optionalCostCounts,
		baseCostStr
	);
	if (defilerRed) {
		for (const [col, amt] of Object.entries(defilerRed) as Array<[ManaColor, number]>) {
			if (amt > 0) {
				coloredReduction[col] = (coloredReduction[col] ?? 0) + amt;
				hasColoredReduction = true;
			}
		}
	}
	// --- End Track P20b ---

	// 3. Commander Tax from the command zone (CR 903.8).
	// --- Track P20b: Suppress generic {2} tax when commanderTaxAsLife applies ---
	const cmdLifeTax = getCommanderTaxLifeCostP20b(
		state,
		player,
		inst,
		faceIndex,
		fused,
		faceDownSpec
	);
	if (inst.isCommander && inst.zone === 'command' && !cmdLifeTax.applies) {
	// --- End Track P20b ---
		const castCount = player.commanderCastCounts?.[inst.instanceId] ?? inst.commanderCastCount ?? 0;
		if (castCount > 0) {
			genericIncrease += castCount * state.rules.commanderTaxIncrement;
		}
	}

	const parseOpts =
		hasColoredReduction || coloredOnly || minTotalMana > 0
			? {
					...(hasColoredReduction ? { coloredReduction } : {}),
					...(hybridColoredReduction.length > 0 ? { hybridColoredReduction } : {}),
					...(coloredOnly ? { coloredOnly: true } : {}),
					...(minTotalMana > 0 ? { minTotalMana } : {})
				}
			: undefined;

	const extraManaStr = `${extraManaCosts?.join('') ?? ''}${extraColoredIncreaseStr}`;
	if (forceZeroCost) {
		return parseManaCost(
			extraManaStr,
			extraManaStr.includes('{X}') ? effectiveX : 0,
			genericIncrease,
			genericReduction,
			parseOpts
		);
	}
	return parseManaCost(
		`${baseCostStr}${extraManaStr}`,
		effectiveX,
		genericIncrease,
		genericReduction,
		parseOpts
	);
}

/**
 * Computes the effective mana cost requirement for an activated ability (e.g. Equip cost modifiers
 * like Puresteel Paladin's Metalcraft or Nahiri, Storm of Stone).
 */
export function effectiveAbilityManaCost(
	state: GameState,
	actorId: string,
	abilityId: string,
	baseManaCost: string,
	abilityKeyword?: string,
	xValue = 0,
	// --- Track P11 ---
	sourcePerm?: CardInstance,
	isManaAbility = false,
	// --- End Track P11 ---
	// --- Track P15 ---
	powerUpReduction = false,
	// --- End Track P15 ---
	// --- Track P17b ---
	chosenTargets?: TargetRef[],
	isLoyaltyAbility = false
	// --- End Track P17b ---
): { manaCost: string; requirement: ManaCostRequirement } {
	// Read-only: one layer-cache validation for the battlefield scan (Phase 6d).
	return withStableLayerInputs(state, () =>
		effectiveAbilityManaCostInner(
			state,
			actorId,
			abilityId,
			baseManaCost,
			abilityKeyword,
			xValue,
			sourcePerm,
			isManaAbility,
			powerUpReduction,
			chosenTargets,
			isLoyaltyAbility
		)
	);
}

function effectiveAbilityManaCostInner(
	state: GameState,
	actorId: string,
	abilityId: string,
	baseManaCost: string,
	abilityKeyword?: string,
	xValue = 0,
	// --- Track P11 ---
	sourcePerm?: CardInstance,
	isManaAbility = false,
	// --- End Track P11 ---
	// --- Track P15 ---
	powerUpReduction = false,
	// --- End Track P15 ---
	// --- Track P17b ---
	chosenTargets?: TargetRef[],
	isLoyaltyAbility = false
	// --- End Track P17b ---
): { manaCost: string; requirement: ManaCostRequirement } {
	const kw =
		abilityKeyword ??
		(abilityId.startsWith('equip_')
			? 'equip'
			: abilityId.startsWith('cycling_')
				? 'cycling'
				: abilityId.startsWith('unearth_')
					? 'unearth'
					: abilityId.startsWith('ninjutsu_')
						? 'ninjutsu'
						: abilityId.startsWith('commander_ninjutsu_')
							? 'commander ninjutsu'
							: abilityId.startsWith('scavenge_')
								? 'scavenge'
								// --- Track P17b ---
								: abilityId.startsWith('boast_')
									? 'boast'
									: abilityId.startsWith('exhaust_')
										? 'exhaust'
										: abilityId.startsWith('powerup_')
											? 'power-up'
											// --- End Track P17b ---
											: undefined);
	let forceZeroCost = false;
	let genericReduction = 0;
	let genericIncrease = 0;
	// --- Track P11 ---
	const coloredReduction: Partial<Record<ManaColor, number>> = {};
	const hybridColoredReduction: Array<[ManaColor, ManaColor]> = [];
	let hasColoredReduction = false;
	let coloredOnly = false;
	let minTotalMana = 0;
	let extraColoredIncreaseStr = '';
	let anyModifierApplied = false;
	const isManaAb = isManaAbility || abilityId === 'mana_tap';
	// --- Track P17b ---
	const isLoyaltyAb = isLoyaltyAbility || abilityId.startsWith('loy_') || abilityId.includes(':loy_');
	// --- End Track P17b ---

	const visitAbilityMod = (
		mod: Extract<StaticDef, { k: 'costModifier' }>,
		modControllerId: string,
		ctx: FilterContext
	) => {
		if (mod.affects.k !== 'ability') return;
		// --- Track P17b & P18b ---
		if (
			!ctx.source ||
			!matchesP17bAbilityCostMod(
				mod,
				actorId,
				abilityId,
				kw,
				sourcePerm,
				isManaAb,
				isLoyaltyAb,
				modControllerId,
				ctx.source,
				ctx,
				chosenTargets,
				matchesObjectFilter
			)
		) {
			return;
		}
		// --- End Track P17b ---
		const perAmount = mod.delta.per ?? mod.delta.times;
		const factor = perAmount ? Math.max(0, evaluateAmount(perAmount, ctx)) : 1;
		if (factor === 0 && perAmount) return;
		anyModifierApplied = true;
		if (mod.delta.mode === 'setZero') {
			forceZeroCost = true;
		} else if (mod.delta.mode === 'reduce') {
			// --- Track P17b ---
			if (mod.delta.generic) {
				let genRed = mod.delta.generic * factor;
				if (mod.delta.maxReduction !== undefined && genRed > mod.delta.maxReduction) {
					genRed = mod.delta.maxReduction;
				}
				genericReduction += genRed;
			}
			// --- End Track P17b ---
			if (mod.delta.colored) {
				for (const [col, amt] of Object.entries(mod.delta.colored) as Array<[ManaColor, number]>) {
					if (amt > 0) {
						coloredReduction[col] = (coloredReduction[col] ?? 0) + amt * factor;
						hasColoredReduction = true;
					}
				}
			}
			if (mod.delta.hybridColored) {
				for (let f = 0; f < factor; f++) {
					for (const pair of mod.delta.hybridColored) {
						hybridColoredReduction.push(pair);
						hasColoredReduction = true;
					}
				}
			}
			if (mod.delta.coloredOnly) coloredOnly = true;
			if (mod.delta.minTotalMana && mod.delta.minTotalMana > minTotalMana) {
				minTotalMana = mod.delta.minTotalMana;
			}
		} else if (mod.delta.mode === 'increase') {
			if (mod.delta.generic) genericIncrease += mod.delta.generic * factor;
			if (mod.delta.colored) {
				for (const [col, amt] of Object.entries(mod.delta.colored) as Array<[ManaColor, number]>) {
					if (amt > 0) extraColoredIncreaseStr += `{${col}}`.repeat(amt * factor);
				}
			}
		}
	};

	// --- Track P17b: Self-cost modifiers on off-battlefield ability sources (e.g. graveyard abilities) ---
	if (sourcePerm && sourcePerm.zone !== 'battlefield') {
		const sCard = sourcePerm.copiableCard ?? sourcePerm.card;
		const sCtx: FilterContext = {
			state,
			controllerId: actorId,
			source: sourcePerm,
			xValue
		};
		for (const mod of costModifiersOf(sCard, instanceFaceOptions(sourcePerm, sourcePerm.zone))) {
			if (mod.activeZones && !mod.activeZones.includes(sourcePerm.zone)) continue;
			visitAbilityMod(mod, actorId, sCtx);
		}
	}
	// --- End Track P17b ---
	const mayGrantAbilityCostMod = boardMayGrantStaticAbility(state, 'costModifier');
	for (const p of state.players) {
		if (p.lost) continue;
		for (const b of p.battlefield) {
			if (b.phasedOut) continue;
			const ctx: FilterContext = { state, controllerId: p.playerId, source: b, xValue };
			const bCard = b.copiableCard ?? b.card;
			const mods = costModifiersOf(bCard, instanceFaceOptions(b, 'battlefield'));
			if (mods.length > 0 && !evaluatePermanent(state, b).losesAllAbilities) {
				for (const mod of mods) {
					const zones = mod.activeZones ?? ['battlefield'];
					if (!zones.includes('battlefield')) continue;
					visitAbilityMod(mod, p.playerId, ctx);
				}
			}
			if (mayGrantAbilityCostMod) {
				for (const gDef of collectActiveGrantedStaticDefs(state, b)) {
					if (gDef.k !== 'costModifier') continue;
					const zones = gDef.activeZones ?? ['battlefield'];
					if (!zones.includes('battlefield')) continue;
					visitAbilityMod(gDef, p.playerId, ctx);
				}
			}
		}
		// --- Track P13: Command-zone emblem ability cost modifiers (CR 114.4) ---
		for (const cmd of p.command) {
			if (cmd.isRingEmblem) continue;
			const cCard = cmd.copiableCard ?? cmd.card;
			const ctx: FilterContext = { state, controllerId: p.playerId, source: cmd, xValue };
			for (const mod of costModifiersOf(cCard, instanceFaceOptions(cmd, cmd.zone))) {
				if (!cmd.isEmblem && !mod.activeZones?.includes('command')) continue;
				visitAbilityMod(mod, p.playerId, ctx);
			}
		}
		// --- End Track P13 ---
	}
	// --- End Track P11 ---
	// --- Track P18b: Self-referential "This ability costs {N} less to activate ..." rider ---
	if (!isManaAb && sourcePerm) {
		const selfCard = sourcePerm.copiableCard ?? sourcePerm.card;
		const selfDefs = activeAbilityDefs(selfCard, instanceFaceOptions(sourcePerm, sourcePerm.zone));
		const matchedAb = selfDefs.find((d) => 'id' in d && d.id === abilityId);
		if (
			matchedAb &&
			(matchedAb.kind === 'activated' || matchedAb.kind === 'unsupported') &&
			matchedAb.activationCostReduction
		) {
			const selfCtx: FilterContext = {
				state,
				controllerId: actorId,
				source: sourcePerm,
				xValue
			};
			visitAbilityMod(
				{
					k: 'costModifier',
					affects: { k: 'ability' },
					delta: matchedAb.activationCostReduction.delta,
					who: { relation: 'you' },
					...(matchedAb.activationCostReduction.condition
						? { condition: matchedAb.activationCostReduction.condition }
						: {})
				},
				actorId,
				selfCtx
			);
		}
	}
	// --- End Track P18b ---
	// --- Track P15: CR 702.193a–b Power-up reduces activation mana cost by permanent's mana cost if it entered this turn ---
	if (
		powerUpReduction &&
		sourcePerm &&
		sourcePerm.zone === 'battlefield' &&
		sourcePerm.enteredTurnSerial !== undefined &&
		sourcePerm.enteredTurnSerial === (state.turnSerial ?? state.turnNumber)
	) {
		const permCard = sourcePerm.copiableCard ?? sourcePerm.card;
		const permManaCost = resolveObjectFaces(
			permCard,
			instanceFaceOptions(sourcePerm, 'battlefield')
		).manaCost;
		if (permManaCost) {
			const permReq = parseManaCost(permManaCost, 0);
			const abReq = parseManaCost(baseManaCost === '{0}' ? '' : baseManaCost, xValue);
			genericReduction += permReq.generic;
			const manaCols: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
			for (const col of manaCols) {
				const pAmt = permReq.colored[col] ?? 0;
				if (pAmt <= 0) continue;
				const aAmt = abReq.colored[col] ?? 0;
				const curColRed = coloredReduction[col] ?? 0;
				const remCol = Math.max(0, aAmt - curColRed);
				const reduceSame = Math.min(pAmt, remCol);
				const excess = pAmt - reduceSame;
				if (reduceSame > 0) {
					coloredReduction[col] = curColRed + reduceSame;
					hasColoredReduction = true;
				}
				if (excess > 0) {
					genericReduction += excess;
				}
			}
			anyModifierApplied = true;
		}
	}
	// --- End Track P15 ---
	// --- Track P20b: First equip / power-up / cycling activation costs {0} ---
	if (hasActiveFirstActivationZeroCost(state, actorId, kw)) {
		forceZeroCost = true;
		anyModifierApplied = true;
	}
	// --- End Track P20b ---

	const parseOpts =
		hasColoredReduction || coloredOnly || minTotalMana > 0
			? {
					...(hasColoredReduction ? { coloredReduction } : {}),
					...(hybridColoredReduction.length > 0 ? { hybridColoredReduction } : {}),
					...(coloredOnly ? { coloredOnly: true } : {}),
					...(minTotalMana > 0 ? { minTotalMana } : {})
				}
			: undefined;

	if (forceZeroCost) {
		return {
			manaCost: '{0}',
			requirement: parseManaCost(extraColoredIncreaseStr, 0, genericIncrease, genericReduction, parseOpts)
		};
	}
	const req = parseManaCost(
		`${baseManaCost === '{0}' ? '' : baseManaCost}${extraColoredIncreaseStr}`,
		xValue,
		genericIncrease,
		genericReduction,
		parseOpts
	);
	let effectiveManaCost = baseManaCost;
	if (anyModifierApplied) {
		const formatted = formatManaRequirement(req, xValue === 0 && req.hasX);
		effectiveManaCost = formatted === '{0}' && !baseManaCost ? '' : formatted;
	}
	return { manaCost: effectiveManaCost, requirement: req };
}

/**
 * The amount of mana a mana ability adds, if the IR says it's dynamic ("for each Elf you control",
 * "equal to ~'s power"). Null if the IR has no amount for it.
 */
export function manaAbilityAmount(
	card: ScryfallCard,
	ab: Pick<EffectiveActivatedAbility, 'id'> &
		Partial<
			Pick<
				EffectiveActivatedAbility,
				'manaAmount' | 'grantSourceCard' | 'faceIndex' | 'grantedAbilityText'
			>
		>
): Amount | null {
	if (ab.manaAmount) return ab.manaAmount;
	// --- Track P10 ---
	if (ab.grantedAbilityText) {
		const quoted = resolveQuotedAbilityDefs(ab.grantedAbilityText, card.name).find(
			(d) => d.kind === 'activated'
		);
		const step = quoted?.kind === 'activated' ? quoted.effect.find((e) => e.verb === 'addMana') : undefined;
		return step?.amount && step.amount.k !== 'const' ? step.amount : null;
	}
	// --- End Track P10 ---
	if (
		ab.grantSourceCard &&
		(ab.id.startsWith('granted:') ||
			// --- Track P12 ---
			ab.id.startsWith('backup_act:'))
		// --- End Track P12 ---
	) {
		const localId = ab.id.slice(ab.id.lastIndexOf(':') + 1);
		const granted =
			grantedAbilityById(ab.grantSourceCard, localId) ??
			// --- Track P12 ---
			activeAbilityDefs(ab.grantSourceCard, { zone: 'battlefield', faceIndex: ab.faceIndex ?? 0 }).find(
				(a) => a.kind === 'activated' && a.id === localId
			);
			// --- End Track P12 ---
		if (granted?.kind !== 'activated') return null;
		const step = granted.effect.find((e) => e.verb === 'addMana');
		return step?.amount && step.amount.k !== 'const' ? step.amount : null;
	}
	const prefixed = /^f(\d+):(.+)$/.exec(ab.id);
	const faceIndex = prefixed ? Number(prefixed[1]) : (ab.faceIndex ?? 0);
	const rawId = prefixed ? prefixed[2] : ab.id;
	const abilities = activeAbilityDefs(card, { zone: 'battlefield', faceIndex });
	const ir =
		abilities.find((a) => a.kind === 'activated' && a.id === rawId) ??
		(rawId === 'mana_tap' ? abilities.find((a) => a.kind === 'activated' && a.isMana && !a.intrinsic) : undefined);
	if (ir?.kind !== 'activated') return null;
	const step = ir.effect.find((e) => e.verb === 'addMana');
	return step?.amount && step.amount.k !== 'const' ? step.amount : null;
}

// ---- Describing costs (display only) ---------------------------------------------------------

function amountText(a: Amount): string {
	return a.k === 'const'
		? String(a.n)
		: a.k === 'x'
			? 'X'
			: a.k === 'anyNumber'
				? 'any number of'
				: 'N';
}

function filterText(f: ObjectFilter, n: Amount): string {
	const plural = !(n.k === 'const' && n.n === 1);
	const words: string[] = [];
	if (f.other) words.push('another');
	if (f.tapped === false) words.push('untapped');
	// --- Track P9 ---
	if (f.unblockedAttacker) words.push('unblocked attacking');
	if (f.token === false) words.push('nontoken');
	if (f.supertypes) words.push(...f.supertypes.map((s) => s.toLowerCase()));
	if (f.notTypes) words.push(...f.notTypes.map((t) => `non${t.toLowerCase()}`));
	const nouns = [
		...(f.subtypes ?? []),
		...(f.allTypes ?? []).map((t) => t.toLowerCase()),
		...(f.types ?? []).map((t) => t.toLowerCase())
	];
	words.push(nouns.length > 0 ? nouns.join(f.allTypes?.length ? ' ' : ' or ') : 'permanent');
	let text = words.join(' ');
	if (f.power) text += ` with power ${f.power.op} ${amountText(f.power.value)}`;
	if (f.manaValue) text += ` with mana value ${f.manaValue.op} ${amountText(f.manaValue.value)}`;
	return plural ? `${amountText(n)} × ${text}` : text;
}

/** A short English description of a cost, for prompts and logs. */
export function describeCost(defs: CostDef[]): string {
	if (defs.length === 0) return "Don't pay";
	return defs
		.map((d): string => {
			// --- Track P20b ---
			const p20bDesc = describeP20bCost(d);
			if (p20bDesc !== null) return p20bDesc;
			// --- End Track P20b ---
			// --- Track P22b ---
			const p22bDesc = describeP22bCost(d);
			if (p22bDesc !== null) return p22bDesc;
			// --- End Track P22b ---
			// --- Track P17b ---
			const p17bDesc = describeP17bCost(d);
			if (p17bDesc !== null) return p17bDesc;
			// --- End Track P17b ---
			switch (d.k) {
				case 'mana':
					return `Pay ${d.cost}`;
				case 'tapSelf':
					return '{T}';
				case 'untapSelf':
					return '{Q}';
				case 'exertSelf':
					return 'Exert this';
				case 'tapOthers':
					return `Tap ${filterText(d.filter, d.count)}`;
				case 'tapSubsetSum':
					return `Tap any number of ${filterText(d.filter, { k: 'const', n: 1 })}s with total ${d.metric} ${amountText(d.minTotal)} or more`;
				case 'sacrifice':
					return d.filter === 'self' ? 'Sacrifice this' : `Sacrifice ${filterText(d.filter, d.count)}`;
				case 'discard':
					return d.filter === 'self'
						? 'Discard this card'
						: `Discard ${amountText(d.count)} card(s)${d.filter ? ` (${filterText(d.filter, d.count)})` : ''}${d.random ? ' at random' : ''}`;
				case 'payLife':
					return `Pay ${amountText(d.amount)} life`;
				case 'payEnergy':
					return `Pay ${amountText(d.count)} {E}`;
				case 'loyalty':
					// --- Track P15 ---
					if (d.isX) return `${d.sign ?? '+'}X`;
					// --- End Track P15 ---
					return d.delta >= 0 ? `+${d.delta}` : `${d.delta}`;
				case 'removeCounters': {
					// --- Track P11 ---
					const amtStr = d.removeAll ? 'all' : amountText(d.count);
					const ctrStr = d.counter === 'any' ? '' : ` ${d.counter}`;
					const fromStr =
						d.from === 'self'
							? ''
							: d.among
								? ` from among ${filterText(d.from, { k: 'const', n: 2 })} you control`
								: ` from ${filterText(d.from, { k: 'const', n: 1 })} you control`;
					return `Remove ${amtStr}${ctrStr} counter(s)${fromStr}`;
					// --- End Track P11 ---
				}
				case 'exileFrom':
					return d.filter === 'self'
						? `Exile this from ${d.zone}`
						: `Exile ${amountText(d.count)} card(s) from your ${d.zone}`;
				case 'revealFromHand':
					// --- Track P9 ---
					return d.filter === 'self'
						? 'Reveal this card'
						: `Reveal ${filterText(d.filter ?? {}, d.count)} in your hand`;
				case 'returnToHand':
					return d.filter === 'self'
						? "Return this to its owner's hand"
						: `Return ${filterText(d.filter, d.count)} you control to its owner's hand`;
				case 'choice':
					return d.options.map((o) => describeCost(o)).join(' or ');
				case 'optional':
					return `You may: ${describeCost(d.cost)}`;
				// --- Track P14 ---
				case 'waterbend':
					return `Waterbend ${d.cost}`;
				case 'behold':
					return `Behold ${filterText(d.filter, d.count)}`;
				case 'putCounters': {
					const onStr =
						d.on === 'self'
							? 'on this'
							: `on ${filterText(d.on, { k: 'const', n: 1 })} you control`;
					return `Put ${amountText(d.count)} ${d.counter} counter(s) ${onStr}`;
				}
				case 'discardHand':
					return 'Discard your hand';
				case 'putFromHandOnTopOfLibrary':
					return `Put ${filterText(d.filter ?? {}, d.count)} from your hand on top of your library`;
				case 'tapAttached':
					return 'Tap attached permanent';
				// --- End Track P14 ---
				default: {
					const extra = d as { k: string; count?: Amount };
					if (extra.k === 'mill' && extra.count) {
						return `Mill ${amountText(extra.count)} card(s)`;
					}
					return '';
				}
			}
		})
		.join(', ');
}

// ---- Planning --------------------------------------------------------------------------------

export interface CostContext {
	state: GameState;
	player: PlayerGameState;
	/** The spell being cast or the permanent whose ability is activated. */
	source: CardInstance;
	xValue: number;
	/** The source is a spell being cast: it can't pay its own discard/exile costs. */
	isSpell: boolean;
	/**
	 * The effective requirement of the top-level mana costs (after cost modifiers), computed by the
	 * caller; top-level `mana` defs are not added again. Mana inside a chosen option is added.
	 */
	baseMana: ManaCostRequirement | null;
	/** Object IDs already committed to another payment (e.g. CastCostAid) that cannot be reused (CR 118.10). */
	reservedObjectIds?: ReadonlySet<string>;
	// --- Track P22b ---
	targets?: TargetRef[];
	// --- End Track P22b ---
	// --- Track P10 ---
	spendCtx?: {
		capturedColorsSpent?: ManaColor[];
		capturedManaSpentCount?: number;
		// --- Track P13 ---
		capturedColorsAllSpent?: ManaColor[];
		// --- End Track P13 ---
		// --- Track P15 ---
		capturedPhyrexianLifePaidCount?: number;
		// --- End Track P15 ---
	};
	// --- End Track P10 ---
	// --- Track P17b ---
	spellColors?: ManaColor[];
	// --- End Track P17b ---
	// --- Track P19a ---
	sacrificedLkiOut?: SacrificedCostLkiEntry[];
	// --- End Track P19a ---
	canPayMana: (req: ManaCostRequirement, reservedIds?: ReadonlySet<string>) => boolean;
	payMana: (req: ManaCostRequirement) => boolean;
}

export type CostQuestion =
	| { kind: 'option'; index: number; labels: string[]; optional: boolean }
	| {
			kind: 'objects';
			index: number;
			label: string;
			count: number;
			// --- Track P14 ---
			maxCount?: number;
			// --- End Track P14 ---
			candidateIds: string[];
			minTotal?: number;
			// --- Track P17b ---
			metric?: 'power' | 'manaValue';
			costDef?: CostDef;
			// --- End Track P17b ---
			candidateWeights?: Record<string, number>;
	  };

type ObjectCostDef = Extract<
	CostDef,
	{
		k:
			| 'tapOthers'
			| 'tapSubsetSum'
			| 'sacrifice'
			| 'discard'
			| 'exileFrom'
			| 'revealFromHand'
			// --- Track P9 ---
			| 'returnToHand'
			// --- Track P11 ---
			| 'removeCounters'
			// --- Track P14 ---
			| 'behold'
			| 'putCounters'
			| 'putFromHandOnTopOfLibrary'
			// --- End Track P14 ---
			// --- Track P17b ---
			| 'untapOthers'
			| 'putOnBottomOfLibrary'
			| 'processOpponentExile'
			| 'putExiledWithSelfToGraveyard'
			// --- End Track P17b ---
			// --- Track P20b ---
			| 'unattachOther'
			// --- End Track P20b ---
			// --- Track P22b ---
			| 'beholdOrChoose'
			| 'exileFromGraveyardAndPayManaCost'
			| 'exileFaceDownPermanentFaceUp';
			// --- End Track P22b ---
	}
>;

/** One cost part of a complete plan, with the objects it uses. */
export type PlannedCost =
	| {
			def: CostDef;
			objects?: CardInstance[];
			random?: { candidates: CardInstance[]; count: number };
			// --- Track P17b ---
			emitForaged?: boolean;
			// --- End Track P17b ---
			// --- Track P20b ---
			counterCount?: number;
			counterDistribution?: Record<string, number>;
			// --- End Track P20b ---
			// --- Track P22b ---
			chosenSubTypeCost?: string;
			chosenNumberCost?: number;
			chosenKeywordCost?: string;
			repeatableManaPaidCount?: number;
			// --- End Track P22b ---
	  };

export type CostPlan =
	| { ok: false; error: string }
	| { ok: true; question: CostQuestion; parts?: undefined; mana?: undefined }
	| { ok: true; question?: undefined; parts: PlannedCost[]; mana: ManaCostRequirement | null };

function n(amount: Amount, ctx: CostContext): number {
	return Math.max(0, evaluateAmount(amount, filterCtx(ctx)));
}

function filterCtx(ctx: CostContext): FilterContext {
	return {
		state: ctx.state,
		controllerId: ctx.player.playerId,
		source: ctx.source,
		xValue: ctx.xValue,
		// --- Track P17b ---
		...(ctx.spellColors ? { spellColors: ctx.spellColors } : {})
		// --- End Track P17b ---
	} as FilterContext;
}

function zoneOf(player: PlayerGameState, zone: PlayerZone): CardInstance[] {
	return player[zone];
}

function hasHaste(state: GameState, perm: CardInstance): boolean {
	return evaluatePermanent(state, perm).activeKeywords.some((k) => k.toLowerCase() === 'haste');
}

function sourceOnBattlefield(ctx: CostContext): boolean {
	return !ctx.isSpell && ctx.player.battlefield.some((c) => c.instanceId === ctx.source.instanceId);
}

// --- Track P11 + Track P17b: Counter counting & deduction helpers for removeCounters ---
function totalMatchingCountersOn(perm: CardInstance, counter: CounterType | 'any'): number {
	return totalMatchingCountersWave6(perm, counter);
}

function deductMatchingCountersFrom(
	state: GameState,
	perm: CardInstance,
	counter: CounterType | 'any',
	toRemove: number
): number {
	return deductMatchingCountersWave6(state, perm, counter, toRemove);
}
// --- End Track P11 + Track P17b ---

/** Does this cost need the player to choose objects, and which objects could pay it? */
function objectCandidates(def: ObjectCostDef, ctx: CostContext, used: Set<string>): CardInstance[] | null {
	const fctx = filterCtx(ctx);
	const free = (c: CardInstance) => !used.has(c.instanceId) && !(ctx.isSpell && c.instanceId === ctx.source.instanceId);
	// --- Track P22b ---
	const p22bCand = p22bObjectCandidates(def, ctx, free, matchesObjectFilter);
	if (p22bCand !== null) return p22bCand;
	// --- End Track P22b ---
	// --- Track P20b ---
	const p20bCand = p20bObjectCandidates(def, ctx, used, matchesObjectFilter);
	if (p20bCand.handled) return p20bCand.candidates;
	// --- End Track P20b ---
	// --- Track P17b ---
	const p17bCand = p17bObjectCandidates(def, ctx, used, matchesObjectFilter);
	if (p17bCand.handled) return p17bCand.candidates;
	// --- End Track P17b ---
	switch (def.k) {
		case 'tapOthers':
			return ctx.player.battlefield.filter(
				(c) => free(c) && !c.phasedOut && !c.tapped && matchesObjectFilter(c, def.filter, fctx)
			);
		case 'tapSubsetSum':
			return ctx.player.battlefield.filter((c) => {
				if (!free(c) || c.phasedOut || c.tapped) return false;
				if (def.excludeSelf && c.instanceId === ctx.source.instanceId) return false;
				if (def.restrictionTag === 'crew' && hasRestriction(ctx.state, c, 'cantCrewVehicles')) {
					return false;
				}
				return matchesObjectFilter(c, def.filter, fctx);
			});
		case 'sacrifice':
			if (def.filter === 'self') return null;
			return ctx.player.battlefield.filter(
				(c) => free(c) && matchesObjectFilter(c, { ...(def.filter as ObjectFilter), controller: 'you' }, fctx)
			);
		case 'discard': {
			if (def.filter === 'self') return null;
			const filter = def.filter as ObjectFilter | undefined;
			return ctx.player.hand.filter((c) => free(c) && (!filter || matchesObjectFilter(c, filter, fctx)));
		}
		case 'exileFrom': {
			if (def.filter === 'self') return null;
			if (def.zone !== 'graveyard' && def.zone !== 'hand' && def.zone !== 'battlefield') return [];
			const filter = def.filter as ObjectFilter | undefined;
			const excludeSelf =
				Boolean(filter?.other) || (def.zone === 'graveyard' && ctx.source.zone === 'graveyard');
			return zoneOf(ctx.player, def.zone).filter(
				(c) =>
					free(c) &&
					(def.zone !== 'battlefield' || !c.phasedOut) &&
					(!excludeSelf || c.instanceId !== ctx.source.instanceId) &&
					(!filter ||
						matchesObjectFilter(
							c,
							def.zone === 'battlefield' ? { ...filter, controller: 'you' } : filter,
							fctx
						))
			);
		}
		case 'revealFromHand': {
			// --- Track P9 ---
			if (def.filter === 'self') return null;
			const filter = def.filter as ObjectFilter | undefined;
			return ctx.player.hand.filter((c) => free(c) && (!filter || matchesObjectFilter(c, filter, fctx)));
		}
		// --- Track P9 ---
		case 'returnToHand': {
			if (def.filter === 'self') return null;
			return ctx.player.battlefield.filter(
				(c) =>
					free(c) &&
					!c.phasedOut &&
					matchesObjectFilter(c, { ...(def.filter as ObjectFilter), controller: 'you' }, fctx)
			);
		}
		// --- Track P11 ---
		case 'removeCounters': {
			if (def.from === 'self' || def.among || def.removeAll) return null;
			const fromFilter = typeof def.from === 'object' ? def.from : {};
			const needed = n(def.count, ctx);
			return ctx.player.battlefield.filter(
				(c) =>
					!(ctx.isSpell && c.instanceId === ctx.source.instanceId) &&
					!c.phasedOut &&
					matchesObjectFilter(c, { ...fromFilter, controller: 'you' }, fctx) &&
					totalMatchingCountersOn(c, def.counter) >= needed
			);
		}
		// --- Track P14 ---
		case 'behold':
			return findBeholdCandidates(
				ctx.state,
				ctx.player,
				ctx.source,
				ctx.isSpell,
				def.filter,
				used
			);
		case 'putCounters': {
			if (def.on === 'self') return null;
			const onFilter = def.on;
			return ctx.player.battlefield.filter(
				(c) =>
					!(ctx.isSpell && c.instanceId === ctx.source.instanceId) &&
					!c.phasedOut &&
					!hasRestriction(ctx.state, c, 'cantHaveCounters') &&
					matchesObjectFilter(c, { ...onFilter, controller: 'you' }, fctx)
			);
		}
		case 'putFromHandOnTopOfLibrary': {
			const filter = def.filter;
			return ctx.player.hand.filter(
				(c) => free(c) && (!filter || matchesObjectFilter(c, filter, fctx))
			);
		}
		// --- End Track P14 ---
		// --- Track P17b ---
		case 'untapOthers':
		case 'putOnBottomOfLibrary':
		case 'processOpponentExile':
		case 'putExiledWithSelfToGraveyard':
		// --- Track P20b ---
		case 'unattachOther':
		// --- End Track P20b ---
		// --- Track P22b ---
		case 'beholdOrChoose':
		case 'exileFromGraveyardAndPayManaCost':
		case 'exileFaceDownPermanentFaceUp':
		// --- End Track P22b ---
			return null;
		// --- End Track P17b ---
	}
}

/** Checks a cost part that doesn't involve choosing objects. Returns an error or null. */
function checkSimple(def: CostDef, ctx: CostContext): string | null {
	// --- Track P22b ---
	const p22bSimple = checkSimpleP22bCost(def, ctx, matchesObjectFilter);
	if (p22bSimple.handled) return p22bSimple.error;
	// --- End Track P22b ---
	// --- Track P20b ---
	const p20bSimple = checkSimpleP20bCost(def, ctx, matchesObjectFilter);
	if (p20bSimple.handled) return p20bSimple.error;
	// --- End Track P20b ---
	// --- Track P17b ---
	const p17bSimple = checkSimpleP17bCost(def, ctx, matchesObjectFilter);
	if (p17bSimple.handled) return p17bSimple.error;
	// --- End Track P17b ---
	const src = ctx.source;
	const name = src.isFaceDown ? (src.faceDownLabel || 'Face-Down Permanent') : src.card.name;
	switch (def.k) {
		case 'tapSelf':
		case 'untapSelf': {
			if (!sourceOnBattlefield(ctx)) return `${name} must be on the battlefield.`;
			if (def.k === 'tapSelf' && src.tapped) return `${name} is already tapped.`;
			if (def.k === 'untapSelf' && !src.tapped) return `${name} is already untapped.`;
			// CR 302.6: {T}/{Q} abilities of a creature need it to have been under your control since your
			// most recent turn began (or haste). Spelled-out "Untap ~" (viaSymbol === false) does not!
			if (
				!(def.k === 'untapSelf' && def.viaSymbol === false) &&
				evaluatePermanent(ctx.state, src).isCreature &&
				src.summoningSick &&
				!hasHaste(ctx.state, src) &&
				// --- Track P20a (CR 602.5a): "activate abilities of [filter] as though those creatures had haste" ---
				!canActivateAsThoughHaste(ctx.state, ctx.player.playerId, src)
				// --- End Track P20a ---
			) {
				return `${name} has summoning sickness and cannot use {${def.k === 'tapSelf' ? 'T' : 'Q'}} abilities yet.`;
			}
			return null;
		}
		case 'exertSelf': {
			if (!sourceOnBattlefield(ctx)) return `${name} must be on the battlefield to be exerted.`;
			return null;
		}
		case 'payLife': {
			const amount = n(def.amount, ctx);
			if (amount === 0) return null; // CR 119.4b
			// CR 119.8: a player who can't lose life can't pay life.
			if (playerLifeTotalCantChange(ctx.state, ctx.player)) {
				return `Your life total can't change, so you can't pay ${amount} life.`;
			}
			// CR 119.4: life total >= payment.
			if (ctx.player.life < amount) return `Not enough life to pay ${amount} life.`;
			return null;
		}
		case 'payEnergy': {
			const amount = n(def.count, ctx);
			if (amount === 0) return null;
			if ((ctx.player.energyCounters || 0) < amount) {
				return `Not enough energy counters to pay ${amount} {E}.`;
			}
			return null;
		}
		case 'loyalty': {
			// --- Track P15: CR 606.4 +X / -X loyalty ---
			if (def.isX) {
				const xVal = Math.max(0, ctx.xValue || 0);
				if (def.sign === '-' && (src.counters.loyalty || 0) < xVal) {
					return 'Not enough loyalty counters.';
				}
				return null;
			}
			// --- End Track P15 ---
			if (def.delta < 0 && src.counters.loyalty < -def.delta) return 'Not enough loyalty counters.';
			return null;
		}
		case 'removeCounters': {
			// --- Track P11 ---
			const amount = def.removeAll ? 0 : n(def.count, ctx);
			if (def.from === 'self') {
				if (totalMatchingCountersOn(src, def.counter) < amount) {
					const label = def.counter === 'any' ? 'counter(s)' : `${def.counter} counter(s)`;
					return `${name} doesn't have ${amount} ${label}.`;
				}
				return null;
			}
			const fromFilter = typeof def.from === 'object' ? def.from : {};
			const fctx = filterCtx(ctx);
			const matching = ctx.player.battlefield.filter(
				(c) => !c.phasedOut && matchesObjectFilter(c, { ...fromFilter, controller: 'you' }, fctx)
			);
			if (def.among) {
				const totalAvail = matching.reduce(
					(acc, c) => acc + totalMatchingCountersOn(c, def.counter),
					0
				);
				if (totalAvail < amount) {
					return `Not enough counters among matching permanents to remove ${amount}.`;
				}
				return null;
			}
			if (!matching.some((c) => totalMatchingCountersOn(c, def.counter) >= amount)) {
				return `No matching permanent has ${amount} counter(s) to remove.`;
			}
			return null;
			// --- End Track P11 ---
		}
		case 'sacrifice':
			if (def.filter === 'self' && !sourceOnBattlefield(ctx)) return `${name} must be on the battlefield to be sacrificed.`;
			return null;
		case 'discard':
			if (def.filter === 'self') {
				if (
					ctx.isSpell ||
					src.zone !== 'hand' ||
					!ctx.player.hand.some((c) => c.instanceId === src.instanceId)
				) {
					return `${name} must be in your hand to be discarded.`;
				}
			}
			return null;
		case 'exileFrom':
			if (def.filter === 'self') {
				const zone = def.zone as PlayerZone;
				if (
					!zoneOf(ctx.player, zone)?.some(
						(c) => c.instanceId === src.instanceId && (zone !== 'battlefield' || !c.phasedOut)
					)
				) {
					return `${name} must be in your ${def.zone} to be exiled.`;
				}
			}
			return null;
		// --- Track P9 ---
		case 'revealFromHand':
			if (def.filter === 'self') {
				const inHand = ctx.player.hand.some((c) => c.instanceId === src.instanceId);
				const inCommand = ctx.player.command.some((c) => c.instanceId === src.instanceId);
				if (!inHand && !inCommand) {
					return `${name} must be in your hand or command zone to be revealed.`;
				}
			}
			return null;
		case 'returnToHand':
			if (def.filter === 'self' && !sourceOnBattlefield(ctx)) {
				return `${name} must be on the battlefield to be returned to hand.`;
			}
			return null;
		// --- Track P14 ---
		case 'putCounters': {
			const count = n(def.count, ctx);
			if (def.on === 'self') {
				if (!sourceOnBattlefield(ctx)) {
					return `${name} must be on the battlefield.`;
				}
				if (count > 0 && hasRestriction(ctx.state, src, 'cantHaveCounters')) {
					return `${name} cannot have counters put on it.`;
				}
				return null;
			}
			const onFilter: ObjectFilter = def.on;
			const fctx = filterCtx(ctx);
			const hasEligible = ctx.player.battlefield.some(
				(c) =>
					!(ctx.isSpell && c.instanceId === src.instanceId) &&
					!c.phasedOut &&
					!hasRestriction(ctx.state, c, 'cantHaveCounters') &&
					matchesObjectFilter(c, { ...onFilter, controller: 'you' }, fctx)
			);
			if (!hasEligible) {
				return 'No eligible permanent you control to put counters on.';
			}
			return null;
		}
		case 'tapAttached': {
			if (!src.attachedToId) {
				return `${name} is not attached to a permanent.`;
			}
			const host = ctx.state.players
				.flatMap((pl) => pl.battlefield)
				.find((c) => !c.phasedOut && c.instanceId === src.attachedToId);
			if (!host) {
				return `${name} is not attached to a permanent on the battlefield.`;
			}
			if (host.tapped) {
				return `${host.card.name} is already tapped.`;
			}
			return null;
		}
		case 'discardHand':
			return null;
		// --- End Track P14 ---
		default: {
			const extra = def as { k: string; count?: Amount };
			if (extra.k === 'mill' && extra.count) {
				const amount = n(extra.count, ctx);
				if (ctx.player.library.length < amount) {
					return `Not enough cards in library to mill ${amount}.`;
				}
			}
			return null;
		}
	}
}

function addRequirements(a: ManaCostRequirement | null, b: ManaCostRequirement): ManaCostRequirement {
	if (!a) return b;
	const colored = { ...a.colored };
	for (const c of Object.keys(colored) as Array<keyof typeof colored>) colored[c] += b.colored[c];
	// --- Track P11 ---
	const snow = (a.snow ?? 0) + (b.snow ?? 0);
	const flexibleSymbols =
		a.flexibleSymbols || b.flexibleSymbols
			? [...(a.flexibleSymbols ?? []), ...(b.flexibleSymbols ?? [])]
			: undefined;
	// --- End Track P11 ---
	return {
		colored,
		generic: a.generic + b.generic,
		hasX: a.hasX || b.hasX,
		xCount: a.xCount + b.xCount,
		totalCmc: a.totalCmc + b.totalCmc,
		// --- Track P11 ---
		...(snow > 0 ? { snow } : {}),
		...(flexibleSymbols ? { flexibleSymbols } : {})
		// --- End Track P11 ---
	};
}

interface Flat {
	def: CostDef;
	/** A `mana` def from the ability's own cost (covered by ctx.baseMana). */
	topLevel: boolean;
	// --- Track P17b ---
	emitForaged?: boolean;
	// --- End Track P17b ---
}

/**
 * Resolves choices with the given answers. Returns the flattened costs, or the first open
 * question. `decide` is called for a choice without an answer and returns the option index if it can
 * be decided automatically.
 */
function flatten(
	defs: CostDef[],
	options: number[] | undefined,
	decide: (
		prefix: Flat[],
		rest: Array<{ def: CostDef; topLevel: boolean }>,
		choice: Extract<CostDef, { k: 'choice' | 'optional' }>,
		index: number
	) => { option: number } | { error: string } | { question: CostQuestion },
	// --- Track P17b: Preserve topLevel=false on branch mana costs across nested canPayCosts checks ---
	nonTopLevelDefs?: ReadonlySet<CostDef>
	// --- End Track P17b ---
): { flat: Flat[]; nextChoiceIndex: number } | { error: string } | { question: CostQuestion } {
	const flat: Flat[] = [];
	const work: Array<{ def: CostDef; topLevel: boolean; emitForaged?: boolean }> = defs.map((def) => ({
		def,
		topLevel: !nonTopLevelDefs?.has(def)
	}));
	let choiceIndex = 0;
	for (let guard = 0; guard < 128 && work.length > 0; guard++) {
		const { def, topLevel, emitForaged } = work.shift()!;
		if (def.k !== 'choice' && def.k !== 'optional') {
			flat.push({ def, topLevel, ...(emitForaged ? { emitForaged: true } : {}) });
			continue;
		}
		const opts = def.k === 'choice' ? def.options : [def.cost, []];
		const index = choiceIndex++;
		let chosen = options?.[index];
		if (chosen === undefined) {
			const d = decide(flat, work, def, index);
			if ('error' in d || 'question' in d) return d;
			chosen = d.option;
		}
		if (!Number.isInteger(chosen) || chosen < 0 || chosen >= opts.length) {
			return { error: 'Invalid cost choice.' };
		}
		// --- Track P17b: Propagate Forage event flag onto the chosen option's final step ---
		const chosenBranch = opts[chosen];
		const isForage = Boolean((def.k === 'choice' && def.forage) || emitForaged);
		work.unshift(
			...chosenBranch.map((d, bi) => ({
				def: d,
				topLevel: false,
				...(isForage && bi === chosenBranch.length - 1 ? { emitForaged: true } : {})
			}))
		);
		// --- End Track P17b ---
	}
	return { flat, nextChoiceIndex: choiceIndex };
}

/**
 * Plans paying `defs`. With no `payment`, every choice must be forced (one legal answer); otherwise
 * the first open choice is returned as `question`.
 */
export function planCosts(ctx: CostContext, defs: CostDef[], payment?: CostPayment): CostPlan {
	const flattened = flatten(defs, payment?.options, (prefix, rest, choice, index) => {
		const opts = choice.k === 'choice' ? choice.options : [choice.cost, []];
		// An option is legal if the whole cost can be paid with it (later choices still open).
		const legal = opts
			.map((o, i) => {
				// --- Track P17b ---
				const nonTop = new Set<CostDef>();
				for (const f of prefix) if (!f.topLevel) nonTop.add(f.def);
				for (const d of o) nonTop.add(d);
				for (const r of rest) if (!r.topLevel) nonTop.add(r.def);
				return {
					i,
					ok: canPayCosts(
						ctx,
						[...prefix.map((f) => f.def), ...o, ...rest.map((r) => r.def)],
						nonTop
					)
				};
				// --- End Track P17b ---
			})
			.filter((o) => o.ok)
			.map((o) => o.i);
		if (legal.length === 0) return { error: `Can't pay the cost: ${describeCost([choice])}.` };
		// "You may" is the player's decision whenever paying is possible; otherwise it isn't paid.
		if (legal.length === 1 && !(choice.k === 'optional' && legal[0] === 0)) return { option: legal[0] };
		return {
			question: {
				kind: 'option',
				index,
				labels: opts.map((o) => describeCost(o)),
				optional: choice.k === 'optional'
			}
		};
	});
	if ('error' in flattened) return { ok: false, error: flattened.error };
	if ('question' in flattened) return { ok: true, question: flattened.question };
	return planFlat(ctx, flattened.flat, payment?.objects, payment, flattened.nextChoiceIndex, false);
}

function planFlat(
	ctx: CostContext,
	flat: Flat[],
	objects: string[][] | undefined,
	// --- Track P20b ---
	payment?: CostPayment,
	initialOptionIndex = 0,
	autoPickGreedy = false
	// --- End Track P20b ---
): CostPlan {
	const parts: PlannedCost[] = [];
	const used = new Set<string>(ctx.reservedObjectIds);
	let mana: ManaCostRequirement | null = ctx.baseMana;
	let objectIndex = 0;
	// --- Track P20b ---
	let optionIndex = initialOptionIndex;
	// --- End Track P20b ---
	// CR 118.3: with {T} in the cost, the source can't also be tapped for "Tap an untapped ...".
	// Similarly, a discard-self cost can't use the source card to pay another discard/exile-from-hand cost.
	const tapsSelf = flat.some((f) => f.def.k === 'tapSelf');
	// --- Track P17b ---
	const untapsSelf = flat.some((f) => f.def.k === 'untapSelf');
	// --- End Track P17b ---
	const discardsSelf = flat.some((f) => f.def.k === 'discard' && f.def.filter === 'self');
	const exilesSelfFromGraveyard = flat.some(
		(f) => f.def.k === 'exileFrom' && f.def.zone === 'graveyard' && f.def.filter === 'self'
	);

	let totalEnergyNeeded = 0;
	for (const { def } of flat) {
		if (def.k === 'payEnergy') totalEnergyNeeded += n(def.count, ctx);
	}
	if (totalEnergyNeeded > 0 && (ctx.player.energyCounters || 0) < totalEnergyNeeded) {
		return { ok: false, error: `Not enough energy counters to pay ${totalEnergyNeeded} {E}.` };
	}

	for (const { def, topLevel, emitForaged } of flat) {
		const err = checkSimple(def, ctx);
		if (err) return { ok: false, error: err };
		if (def.k === 'mana') {
			if (!topLevel || !ctx.baseMana) mana = addRequirements(mana, parseManaCost(def.cost, ctx.xValue));
			parts.push({ def, ...(emitForaged ? { emitForaged: true } : {}) });
			continue;
		}
		// --- Track P14 (CR 701.67a–b): Waterbend [cost] ---
		if (def.k === 'waterbend') {
			const wbReq = parseManaCost(def.cost, ctx.xValue);
			const nonGenWb: ManaCostRequirement = {
				...wbReq,
				generic: 0,
				totalCmc: Math.max(0, wbReq.totalCmc - wbReq.generic)
			};
			if (
				nonGenWb.totalCmc > 0 ||
				(nonGenWb.snow ?? 0) > 0 ||
				(nonGenWb.flexibleSymbols?.length ?? 0) > 0
			) {
				mana = addRequirements(mana, nonGenWb);
			}
			const wbExclude = tapsSelf ? new Set([...used, ctx.source.instanceId]) : used;
			const rawCandidates = findWaterbendTapCandidates(
				ctx.state,
				ctx.player,
				ctx.source,
				ctx.isSpell,
				wbExclude
			);
			const candidates = [...rawCandidates].sort((a, b) => {
				const aMana = activeAbilityDefs(
					effectiveCardForObject(a),
					instanceFaceOptions(a, 'battlefield')
				).some((ab) => ab.kind === 'activated' && ab.isMana);
				const bMana = activeAbilityDefs(
					effectiveCardForObject(b),
					instanceFaceOptions(b, 'battlefield')
				).some((ab) => ab.kind === 'activated' && ab.isMana);
				if (aMana !== bMana) return aMana ? 1 : -1;
				if (a.isToken !== b.isToken) return a.isToken ? -1 : 1;
				return (a.card.cmc ?? 0) - (b.card.cmc ?? 0);
			});
			const maxTap = Math.min(wbReq.generic, candidates.length);
			if (maxTap <= 0) {
				if (wbReq.generic > 0) {
					mana = addRequirements(mana, {
						colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
						generic: wbReq.generic,
						hasX: false,
						xCount: 0,
						totalCmc: wbReq.generic
					});
				}
				parts.push({ def, objects: [] });
				continue;
			}
			const index = objectIndex++;
			const chosenIds = objects?.[index];
			if (chosenIds !== undefined) {
				if (new Set(chosenIds).size !== chosenIds.length) {
					return { ok: false, error: `Duplicate choice for: ${describeCost([def])}.` };
				}
				if (chosenIds.length > wbReq.generic) {
					return {
						ok: false,
						error: `Cannot tap more than ${wbReq.generic} permanent(s) for ${describeCost([def])} (CR 701.67b).`
					};
				}
				const byId = new Map(candidates.map((c) => [c.instanceId, c]));
				if (chosenIds.some((id) => !byId.has(id))) {
					return { ok: false, error: `Illegal choice for: ${describeCost([def])}.` };
				}
				const chosen = chosenIds.map((id) => byId.get(id)!);
				const remGen = Math.max(0, wbReq.generic - chosen.length);
				if (remGen > 0) {
					mana = addRequirements(mana, {
						colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
						generic: remGen,
						hasX: false,
						xCount: 0,
						totalCmc: remGen
					});
				}
				for (const c of chosen) used.add(c.instanceId);
				parts.push({ def, objects: chosen });
				continue;
			}
			let minTap = maxTap + 1;
			for (let k = 0; k <= maxTap; k++) {
				const picked = candidates.slice(0, k);
				const remGen = Math.max(0, wbReq.generic - k);
				const testMana =
					remGen > 0
						? addRequirements(mana, {
								colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
								generic: remGen,
								hasX: false,
								xCount: 0,
								totalCmc: remGen
							})
						: mana;
				const testUsed = new Set(used);
				for (const p of picked) testUsed.add(p.instanceId);
				const testParts = [...parts, { def, objects: picked }];
				if (!testMana || canPayManaAfterTaps(ctx, testParts, testMana, testUsed)) {
					minTap = k;
					break;
				}
			}
			if (minTap > maxTap) {
				return { ok: false, error: `Insufficient mana to pay ${describeCost([def])}.` };
			}
			return {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeCost([def]),
					count: minTap,
					maxCount: maxTap,
					candidateIds: candidates.map((c) => c.instanceId)
				}
			};
		}
		// --- End Track P14 ---
		// --- Track P20b: Self variable/exact counter removal tracking ---
		const p20bSelfCtr = planP20bSelfCounterPart(def, ctx, payment, optionIndex, autoPickGreedy);
		if (p20bSelfCtr.handled) {
			const cRes = p20bSelfCtr.result;
			if (!cRes.ok) return cRes;
			if ('question' in cRes) return { ok: true, question: cRes.question };
			optionIndex = cRes.nextOptionIndex;
			parts.push({
				def,
				counterCount: cRes.counterCount,
				...(emitForaged ? { emitForaged: true } : {})
			});
			continue;
		}
		// --- End Track P20b ---
		// --- Track P22b: non-object special costs (choice/mana-per-counter/repeatable) before object gate ---
		if (def.k === 'payManaPerCounter') {
			const cnt = ctx.source.counters[def.counter] ?? 0;
			for (let k = 0; k < cnt; k++) {
				mana = addRequirements(mana, parseManaCost(def.perMana, ctx.xValue));
			}
			parts.push({ def, ...(emitForaged ? { emitForaged: true } : {}) });
			continue;
		}
		if (
			def.k === 'chooseCreatureType' ||
			def.k === 'chooseNumberBetween' ||
			def.k === 'chooseFromKeywordList' ||
			def.k === 'repeatableOptionalMana'
		) {
			const p22bNonObj = planP22bSpecialCostPart(
				def,
				null,
				ctx,
				used,
				objects ?? [],
				objectIndex,
				payment ?? {},
				(d) => describeCost([d])
			);
			if (p22bNonObj.handled) {
				const spRes = p22bNonObj.result;
				if (!spRes.ok) return spRes;
				if ('question' in spRes) {
					return { ok: true, question: spRes.question };
				}
				objectIndex = spRes.nextObjectIndex;
				parts.push({
					def,
					...(spRes.extra ?? {}),
					...(emitForaged ? { emitForaged: true } : {})
				});
				continue;
			}
		}
		// --- End Track P22b ---
		if (
			def.k !== 'tapOthers' &&
			def.k !== 'tapSubsetSum' &&
			def.k !== 'sacrifice' &&
			def.k !== 'discard' &&
			def.k !== 'exileFrom' &&
			def.k !== 'revealFromHand' &&
			// --- Track P9 ---
			def.k !== 'returnToHand' &&
			// --- Track P11 ---
			def.k !== 'removeCounters' &&
			// --- Track P14 ---
			def.k !== 'behold' &&
			def.k !== 'putCounters' &&
			def.k !== 'putFromHandOnTopOfLibrary' &&
			// --- End Track P14 ---
			// --- Track P17b ---
			def.k !== 'untapOthers' &&
			def.k !== 'putOnBottomOfLibrary' &&
			def.k !== 'processOpponentExile' &&
			def.k !== 'putExiledWithSelfToGraveyard' &&
			// --- End Track P17b ---
			// --- Track P20b ---
			def.k !== 'unattachOther' &&
			// --- End Track P20b ---
			// --- Track P22b ---
			def.k !== 'beholdOrChoose' &&
			def.k !== 'exileFromGraveyardAndPayManaCost' &&
			def.k !== 'exileFaceDownPermanentFaceUp'
			// --- End Track P22b ---
		) {
			parts.push({ def, ...(emitForaged ? { emitForaged: true } : {}) });
			continue;
		}
		const reserveSelf =
			((def.k === 'tapOthers' || def.k === 'tapSubsetSum') && tapsSelf) ||
			// --- Track P17b ---
			(def.k === 'untapOthers' && untapsSelf) ||
			// --- End Track P17b ---
			(discardsSelf &&
				(def.k === 'revealFromHand' ||
					// --- Track P14 ---
					def.k === 'behold' ||
					def.k === 'putFromHandOnTopOfLibrary' ||
					// --- End Track P14 ---
					((def.k === 'discard' || (def.k === 'exileFrom' && def.zone === 'hand')) &&
						def.filter !== 'self'))) ||
			(exilesSelfFromGraveyard &&
				def.k === 'exileFrom' &&
				def.zone === 'graveyard' &&
				def.filter !== 'self');
		const exclude = reserveSelf ? new Set([...used, ctx.source.instanceId]) : used;
		const candidates = objectCandidates(def, ctx, exclude);
		if (!candidates) {
			parts.push({ def, ...(emitForaged ? { emitForaged: true } : {}) });
			if ('filter' in def && def.filter === 'self') used.add(ctx.source.instanceId);
			continue;
		}
		// --- Track P22b ---
		const p22bSpecial = planP22bSpecialCostPart(
			def,
			candidates,
			ctx,
			used,
			objects ?? [],
			objectIndex,
			payment ?? {},
			(d) => describeCost([d])
		);
		if (p22bSpecial.handled) {
			const spRes = p22bSpecial.result;
			if (!spRes.ok) return spRes;
			if ('question' in spRes) {
				return {
					ok: true,
					question:
						spRes.question.kind === 'objects'
							? { ...spRes.question, costDef: def }
							: spRes.question
				};
			}
			objectIndex = spRes.nextObjectIndex;
			parts.push({
				def,
				objects: spRes.chosen,
				...(spRes.extra ?? {}),
				...(emitForaged ? { emitForaged: true } : {})
			});
			continue;
		}
		// --- End Track P22b ---
		// --- Track P20b: Multi-permanent counter removal, unattachOther, beholdExile, & multi-object constraints ---
		const p20bSpecial = planP20bSpecialCostPart(
			def,
			candidates,
			ctx,
			used,
			objects,
			objectIndex,
			payment,
			(d) => describeCost([d])
		);
		if (p20bSpecial.handled) {
			const spRes = p20bSpecial.result;
			if (!spRes.ok) return spRes;
			if ('question' in spRes) {
				return {
					ok: true,
					question:
						spRes.question.kind === 'objects'
							? { ...spRes.question, costDef: def }
							: spRes.question
				};
			}
			objectIndex = spRes.nextObjectIndex;
			parts.push({
				def,
				objects: spRes.chosen,
				...(spRes.counterCount !== undefined ? { counterCount: spRes.counterCount } : {}),
				...(spRes.counterDistribution !== undefined
					? { counterDistribution: spRes.counterDistribution }
					: {}),
				...(emitForaged ? { emitForaged: true } : {})
			});
			continue;
		}
		// --- End Track P20b ---
		// --- Track P17b: Special subset/group cost planning (Collect evidence, halfRoundedUp, shareCreatureType, etc.) ---
		const p17bSpecial = planP17bSpecialCostPart(
			def,
			candidates,
			ctx,
			used,
			objects,
			objectIndex,
			(d) => describeCost([d])
		);
		if (p17bSpecial.handled) {
			const spRes = p17bSpecial.result;
			if (!spRes.ok) return spRes;
			if ('question' in spRes) {
				return {
					ok: true,
					question:
						spRes.question.kind === 'objects'
							? { ...spRes.question, costDef: def }
							: spRes.question
				};
			}
			objectIndex = spRes.nextObjectIndex;
			parts.push({
				def,
				objects: spRes.chosen,
				...(emitForaged ? { emitForaged: true } : {})
			});
			continue;
		}
		// --- End Track P17b ---
		if (def.k === 'tapSubsetSum') {
			const minTotal = n(def.minTotal, ctx);
			const candidateWeights = withStableLayerInputs(ctx.state, () => {
				const weights: Record<string, number> = {};
				for (const c of candidates) {
					const ev = evaluatePermanent(ctx.state, c);
					weights[c.instanceId] = def.metric === 'power' ? (ev.power ?? 0) : 0;
				}
				return weights;
			});
			const maxAchievable = candidates.reduce(
				(sum, c) => sum + Math.max(0, candidateWeights[c.instanceId] ?? 0),
				0
			);
			if (maxAchievable < minTotal) {
				return {
					ok: false,
					error: `Can't pay the cost: ${describeCost([def])} (insufficient total ${def.metric}).`
				};
			}
			const index = objectIndex++;
			const chosenIds = objects?.[index];
			let chosen: CardInstance[];
			if (chosenIds) {
				if (new Set(chosenIds).size !== chosenIds.length) {
					return { ok: false, error: `Duplicate choice for: ${describeCost([def])}.` };
				}
				const byId = new Map(candidates.map((c) => [c.instanceId, c]));
				if (chosenIds.some((id) => !byId.has(id))) {
					return { ok: false, error: `Illegal choice for: ${describeCost([def])}.` };
				}
				const sum = chosenIds.reduce((acc, id) => acc + (candidateWeights[id] ?? 0), 0);
				if (sum < minTotal) {
					return {
						ok: false,
						error: `Selected total ${def.metric} is ${sum}; need at least ${minTotal}.`
					};
				}
				chosen = chosenIds.map((id) => byId.get(id)!);
			} else if (minTotal <= 0) {
				chosen = [];
			} else {
				return {
					ok: true,
					question: {
						kind: 'objects',
						index,
						label: describeCost([def]),
						count: 1,
						candidateIds: candidates.map((c) => c.instanceId),
						minTotal,
						metric: def.metric,
						candidateWeights
					}
				};
			}
			for (const c of chosen) used.add(c.instanceId);
			parts.push({ def, objects: chosen });
			continue;
		}
		// --- Track P14: anyNumber variable-count object selection & putCounters single-permanent choice ---
		const isAnyNumber = 'count' in def && def.count.k === 'anyNumber';
		if (isAnyNumber) {
			if (candidates.length === 0) {
				parts.push({ def, objects: [] });
				continue;
			}
			const index = objectIndex++;
			const chosenIds = objects?.[index];
			if (chosenIds !== undefined) {
				if (new Set(chosenIds).size !== chosenIds.length) {
					return { ok: false, error: `Duplicate choice for: ${describeCost([def])}.` };
				}
				const byId = new Map(candidates.map((c) => [c.instanceId, c]));
				if (chosenIds.some((id) => !byId.has(id))) {
					return { ok: false, error: `Illegal choice for: ${describeCost([def])}.` };
				}
				const chosen = chosenIds.map((id) => byId.get(id)!);
				if (def.k !== 'removeCounters' && def.k !== 'putCounters' && def.k !== 'behold') {
					for (const c of chosen) used.add(c.instanceId);
				}
				parts.push({ def, objects: chosen });
				continue;
			}
			return {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeCost([def]),
					count: 0,
					maxCount: candidates.length,
					candidateIds: candidates.map((c) => c.instanceId)
				}
			};
		}
		// --- End Track P14 ---
		// --- Track P11 + Track P14: removeCounters / putCounters from/on a single permanent chooses 1 object ---
		const count =
			def.k === 'removeCounters' ||
			def.k === 'putCounters' ||
			def.k === 'beholdOrChoose' ||
			def.k === 'exileFromGraveyardAndPayManaCost' ||
			def.k === 'exileFaceDownPermanentFaceUp'
				? 1
				: n(def.count, ctx);
		// --- End Track P11 + Track P14 ---
		if (candidates.length < count) {
			return { ok: false, error: `Can't pay the cost: ${describeCost([def])} (not enough to choose from).` };
		}
		if (def.k === 'discard' && def.random) {
			// Random isn't a choice; the cards are picked when the cost is paid.
			parts.push({
				def,
				random: { candidates, count },
				...(emitForaged ? { emitForaged: true } : {})
			});
			for (const c of candidates) used.add(c.instanceId); // conservatively reserved
			continue;
		}
		const index = objectIndex++;
		const chosenIds = objects?.[index];
		let chosen: CardInstance[];
		if (chosenIds) {
			if (new Set(chosenIds).size !== chosenIds.length || chosenIds.length !== count) {
				return { ok: false, error: `Choose exactly ${count} for: ${describeCost([def])}.` };
			}
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			if (chosenIds.some((id) => !byId.has(id))) {
				return { ok: false, error: `Illegal choice for: ${describeCost([def])}.` };
			}
			chosen = chosenIds.map((id) => byId.get(id)!);
		} else if (candidates.length === count) {
			chosen = candidates;
		} else {
			return {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeCost([def]),
					count,
					candidateIds: candidates.map((c) => c.instanceId),
					// --- Track P17b ---
					costDef: def
					// --- End Track P17b ---
				}
			};
		}
		if (def.k !== 'removeCounters' && def.k !== 'putCounters' && def.k !== 'behold') {
			for (const c of chosen) used.add(c.instanceId);
		}
		parts.push({
			def,
			objects: chosen,
			...(emitForaged ? { emitForaged: true } : {})
		});
	}

	if (mana && !canPayManaAfterTaps(ctx, parts, mana, used)) {
		return { ok: false, error: 'Insufficient mana to pay the cost.' };
	}
	return { ok: true, parts, mana };
}

/** Mana is paid after tap costs, so permanents tapped for the cost can't also tap for mana. */
function canPayManaAfterTaps(
	ctx: CostContext,
	parts: PlannedCost[],
	mana: ManaCostRequirement,
	reservedIds?: ReadonlySet<string>
): boolean {
	const toTap = tapTargets(ctx, parts).filter((c) => !c.tapped);
	const energyReserved = parts.reduce(
		(sum, p) => sum + (p.def.k === 'payEnergy' ? n(p.def.count, ctx) : 0),
		0
	);
	if (toTap.length === 0 && energyReserved === 0) return ctx.canPayMana(mana, reservedIds);
	const prevEnergy = ctx.player.energyCounters || 0;
	// The hypothetical taps/energy reservations change layer inputs: an enclosing
	// `withStableLayerInputs` scope revalidates after reserving and again after restoring (Phase 6d).
	for (const c of toTap) c.tapped = true;
	if (energyReserved > 0) ctx.player.energyCounters = Math.max(0, prevEnergy - energyReserved);
	noteLayerInputsChanged(ctx.state);
	try {
		return ctx.canPayMana(mana, reservedIds);
	} finally {
		for (const c of toTap) c.tapped = false;
		if (energyReserved > 0) ctx.player.energyCounters = prevEnergy;
		noteLayerInputsChanged(ctx.state);
	}
}

function tapTargets(ctx: CostContext, parts: PlannedCost[]): CardInstance[] {
	const out: CardInstance[] = [];
	for (const p of parts) {
		if (p.def.k === 'tapSelf') out.push(ctx.source);
		if (
			p.def.k === 'tapOthers' ||
			p.def.k === 'tapSubsetSum' ||
			// --- Track P14 ---
			p.def.k === 'waterbend'
			// --- End Track P14 ---
		) {
			out.push(...(p.objects ?? []));
		}
		// --- Track P14 ---
		if (p.def.k === 'tapAttached' && ctx.source.attachedToId) {
			const host = ctx.state.players
				.flatMap((pl) => pl.battlefield)
				.find((c) => !c.phasedOut && c.instanceId === ctx.source.attachedToId);
			if (host) out.push(host);
		}
		// --- End Track P14 ---
	}
	return out;
}

function subsetKeepScore(c: CardInstance): number {
	return (c.summoningSick ? 0 : 2) + (c.isToken ? 0 : 1) + (c.card.cmc ?? 0) * 0.01;
}

function selectSubsetForMinSum(
	candidates: CardInstance[],
	minTotal: number,
	weights: Record<string, number>
): string[] {
	if (minTotal <= 0) return [];
	const pos = candidates.filter((c) => (weights[c.instanceId] ?? 0) > 0);
	const totalPossible = pos.reduce((s, c) => s + (weights[c.instanceId] ?? 0), 0);
	if (totalPossible < minTotal) return [];

	const ordered = [...pos].sort((a, b) => {
		const diff = subsetKeepScore(a) - subsetKeepScore(b);
		if (diff !== 0) return diff;
		return (weights[a.instanceId] ?? 0) - (weights[b.instanceId] ?? 0);
	});

	if (ordered.length <= 16) {
		const nLen = ordered.length;
		const suffixSum = new Array<number>(nLen + 1).fill(0);
		for (let i = nLen - 1; i >= 0; i--) {
			suffixSum[i] = suffixSum[i + 1] + (weights[ordered[i].instanceId] ?? 0);
		}
		let bestIds: string[] | null = null;
		let bestSurplus = Infinity;
		let bestCount = Infinity;
		let bestScore = Infinity;
		let nodes = 0;
		const picked: string[] = [];

		const dfs = (idx: number, sum: number, score: number): void => {
			if (nodes++ > 4096) return;
			if (sum >= minTotal) {
				const surplus = sum - minTotal;
				if (
					surplus < bestSurplus ||
					(surplus === bestSurplus &&
						(picked.length < bestCount ||
							(picked.length === bestCount && score < bestScore)))
				) {
					bestSurplus = surplus;
					bestCount = picked.length;
					bestScore = score;
					bestIds = [...picked];
				}
				return;
			}
			if (idx >= nLen || sum + suffixSum[idx] < minTotal) return;
			const c = ordered[idx];
			const w = weights[c.instanceId] ?? 0;
			picked.push(c.instanceId);
			dfs(idx + 1, sum + w, score + subsetKeepScore(c));
			picked.pop();
			dfs(idx + 1, sum, score);
		};
		dfs(0, 0, 0);
		if (bestIds) return bestIds;
	}

	const chosen: CardInstance[] = [];
	let sum = 0;
	for (const c of ordered) {
		if (sum >= minTotal) break;
		chosen.push(c);
		sum += weights[c.instanceId] ?? 0;
	}
	for (let i = chosen.length - 1; i >= 0; i--) {
		const w = weights[chosen[i].instanceId] ?? 0;
		if (sum - w >= minTotal) {
			sum -= w;
			chosen.splice(i, 1);
		}
	}
	return chosen.map((c) => c.instanceId);
}

/**
 * Picks a legal `CostPayment` greedily (for bots and legality checks): first legal option for
 * choices (declining optional costs), and tokens-first then lowest-CMC for objects. Returns null if
 * the cost can't be paid.
 */
export function chooseCostPayment(
	ctx: CostContext,
	defs: CostDef[],
	// --- Track P17b ---
	nonTopLevelDefs?: ReadonlySet<CostDef>
	// --- End Track P17b ---
): CostPayment | null {
	const options: number[] = [];
	const result = flatten(
		defs,
		undefined,
		(prefix, rest, choice, index) => {
			const opts = choice.k === 'choice' ? choice.options : [choice.cost, []];
			const order = choice.k === 'optional' ? [1, 0] : opts.map((_, i) => i);
			for (const i of order) {
				// --- Track P17b ---
				const nonTop = new Set<CostDef>();
				for (const f of prefix) if (!f.topLevel) nonTop.add(f.def);
				for (const d of opts[i]) nonTop.add(d);
				for (const r of rest) if (!r.topLevel) nonTop.add(r.def);
				if (
					canPayCosts(
						ctx,
						[...prefix.map((f) => f.def), ...opts[i], ...rest.map((r) => r.def)],
						nonTop
					)
				) {
					options[index] = i;
					return { option: i };
				}
				// --- End Track P17b ---
			}
			return { error: 'unpayable' };
		},
		nonTopLevelDefs
	);
	if (!('flat' in result)) return null;
	// Choose objects greedily: tokens first, then cheapest (any legal choice proves payability).
	const greedy = (ids: CardInstance[], count: number) =>
		[...ids]
			.sort((a, b) => (a.isToken !== b.isToken ? (a.isToken ? -1 : 1) : a.card.cmc - b.card.cmc))
			.slice(0, count)
			.map((c) => c.instanceId);
	const objects: string[][] = [];
	for (let guard = 0; guard < 32; guard++) {
		// --- Track P20b ---
		const plan = planFlat(
			ctx,
			result.flat,
			objects,
			{ options, objects },
			result.nextChoiceIndex,
			true
		);
		// --- End Track P20b ---
		if (!plan.ok) return null;
		if (!plan.question) {
			// --- Track P20b: Include greedy counterCount if a variable self-counter cost was auto-picked ---
			const autoCtr = plan.parts.find(
				(p) =>
					p.def.k === 'removeCounters' &&
					p.def.from === 'self' &&
					(p.def.oneOrMore || p.def.count.k === 'anyNumber') &&
					p.counterCount !== undefined
			)?.counterCount;
			// --- End Track P20b ---
			return {
				...(options.length > 0 ? { options } : {}),
				...(objects.length > 0 ? { objects } : {}),
				// --- Track P20b ---
				...(autoCtr !== undefined ? { counterCount: autoCtr } : {})
				// --- End Track P20b ---
			};
		}
		if (plan.question.kind !== 'objects') return null;
		const q = plan.question;
		const candidates = q.candidateIds
			.map((id) => findById(ctx, id))
			.filter((c): c is CardInstance => c !== undefined);
		// --- Track P22b ---
		if (q.costDef) {
			const p22bPick = pickGreedyP22bObjects(q.costDef, candidates, q.count, ctx);
			if (p22bPick) {
				objects[q.index] = p22bPick;
				continue;
			}
		}
		// --- End Track P22b ---
		// --- Track P20b ---
		if (q.costDef) {
			const p20bPick = pickGreedyP20bObjects(q.costDef, candidates, q.count, ctx);
			if (p20bPick) {
				objects[q.index] = p20bPick;
				continue;
			}
		}
		// --- End Track P20b ---
		// --- Track P14: For waterbend, tap non-mana artifacts/creatures first (saving mana sources) ---
		if (q.maxCount !== undefined) {
			let pickCount = q.count;
			if (q.label.startsWith('Waterbend ')) {
				let nonManaPrefix = 0;
				for (let ci = 0; ci < candidates.length && ci < q.maxCount; ci++) {
					const hasMana = activeAbilityDefs(
						effectiveCardForObject(candidates[ci]),
						instanceFaceOptions(candidates[ci], 'battlefield')
					).some((ab) => ab.kind === 'activated' && ab.isMana);
					if (hasMana) break;
					nonManaPrefix += 1;
				}
				if (nonManaPrefix > pickCount) pickCount = nonManaPrefix;
			}
			objects[q.index] = candidates.slice(0, pickCount).map((c) => c.instanceId);
			continue;
		}
		// --- End Track P14 ---
		// --- Track P17b ---
		if (q.costDef) {
			const p17bPick = pickGreedyP17bObjects(q.costDef, candidates, q.count, ctx);
			if (p17bPick) {
				objects[q.index] = p17bPick;
				continue;
			}
		}
		// --- End Track P17b ---
		objects[q.index] =
			q.minTotal !== undefined && q.candidateWeights
				? selectSubsetForMinSum(candidates, q.minTotal, q.candidateWeights)
				: greedy(candidates, q.count);
	}
	return null;
}

/** Can `defs` be paid in some way? Object choices are made greedily (tokens first, then cheapest). */
export function canPayCosts(
	ctx: CostContext,
	defs: CostDef[],
	// --- Track P17b ---
	nonTopLevelDefs?: ReadonlySet<CostDef>
	// --- End Track P17b ---
): boolean {
	return chooseCostPayment(ctx, defs, nonTopLevelDefs) !== null;
}

function findById(ctx: CostContext, id: string): CardInstance | undefined {
	// --- Track P17b ---
	return findCostCandidateByIdWave6(ctx.state, ctx.player, id);
	// --- End Track P17b ---
}

// ---- Paying ----------------------------------------------------------------------------------

export interface PaidCosts {
	/** What was paid, for the caller's log ("sacrificed Llanowar Elves", "paid 3 life"). */
	descriptions: string[];
	/** Set when a zone change mid-payment paused on a replacement choice (`CR 616.1`). */
	paused?: boolean;
	nextPartIndex?: number;
	nextObjectIndex?: number;
	// --- Track P22b ---
	lifePaidCount?: number;
	chosenSubTypeCost?: string;
	chosenNumberCost?: number;
	chosenKeywordCost?: string;
	beheldOrChosenPower?: number;
	beheldOrChosenCard?: ScryfallCard;
	repeatableManaPaidCount?: number;
	exiledCostCards?: ScryfallCard[];
	// --- End Track P22b ---
}

function sacrifice(ctx: CostContext, perm: CardInstance): MoveResult {
	// CR 701.21a: to its owner's graveyard. Same bookkeeping as movePermanentToZone.
	return moveObject(ctx.state, perm, 'graveyard', {
		from: 'anyBattlefield',
		detachAttachments: true,
		graveyardReplacement: true,
		commanderRedirect: true,
		leaveBattlefieldReset: true,
		bumpVersion: true,
		newTimestamp: true,
		insert: (actual) => (actual === 'library' ? 'start' : 'end'),
		ceaseToExist: 'tokens',
		// --- Track P10 ---
		sacrificedByPlayerId: ctx.player.playerId
		// --- End Track P10 ---
	});
}

function moveFromZone(
	ctx: CostContext,
	card: CardInstance,
	zone: PlayerZone,
	to: 'graveyard' | 'exile',
	discardReason?: 'discard' | 'cycle',
	// --- Track P10 ---
	suppressGraveyardLeaveBatch?: boolean
	// --- End Track P10 ---
): MoveResult {
	if (zone === 'battlefield') {
		return moveObject(ctx.state, card, to, {
			from: 'anyBattlefield',
			detachAttachments: true,
			graveyardReplacement: true,
			commanderRedirect: true,
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true,
			ceaseToExist: 'tokens'
		});
	}
	return moveObject(ctx.state, card, to, {
		from: { player: ctx.player, zone },
		graveyardReplacement: to === 'graveyard' || to === 'exile',
		commanderRedirect: true,
		newTimestamp: true,
		bumpVersion: true,
		...(discardReason ? { discardReason, discardPlayerId: ctx.player.playerId } : {}),
		// --- Track P10 ---
		...(suppressGraveyardLeaveBatch ? { suppressGraveyardLeaveBatch: true } : {})
		// --- End Track P10 ---
	});
}

/**
 * Converts a complete `CostPlan` into plain-JSON `SerializedPlannedCost` steps in `CR 601.2h`
 * execution order (non-random first, random last), resolving any `random` discards once up front
 * so pausing mid-payment never re-rolls randomness.
 */
export function serializeCostPlanParts(
	ctx: CostContext,
	plan: Extract<CostPlan, { parts: PlannedCost[] }>
): SerializedPlannedCost[] {
	const ordered = [...plan.parts.filter((p) => !p.random), ...plan.parts.filter((p) => p.random)];
	return ordered.map((part): SerializedPlannedCost => {
		const def = part.def;
		// --- Track P17b & P20b ---
		const forageExtra = part.emitForaged ? { emitForaged: true } : {};
		if (!part.random) {
			const p20bSer = serializeP20bCostPart(
				def,
				ctx,
				part.objects,
				part.counterCount,
				part.counterDistribution,
				part.emitForaged
			);
			if (p20bSer) return p20bSer;
			const p17bSer = serializeP17bCostPart(
				def,
				part.objects,
				ctx,
				matchesObjectFilter,
				part.emitForaged
			);
			if (p17bSer) return p17bSer;
		}
		// --- End Track P17b & P20b ---
		if (part.random) {
			const pool = [...part.random.candidates];
			const picked: CardInstance[] = [];
			for (let i = 0; i < part.random.count && pool.length > 0; i++) {
				picked.push(pool.splice(Math.floor(nextRandom(ctx.state) * pool.length), 1)[0]);
			}
			return {
				def,
				objectIds: picked.map((c) => c.instanceId),
				objectNames: picked.map((c) => c.card.name),
				isRandom: true,
				// --- Track P17b ---
				...forageExtra
				// --- End Track P17b ---
			};
		}
		if (
			def.k === 'tapOthers' ||
			def.k === 'tapSubsetSum' ||
			def.k === 'sacrifice' ||
			def.k === 'discard' ||
			def.k === 'exileFrom' ||
			def.k === 'revealFromHand' ||
			// --- Track P9 ---
			def.k === 'returnToHand' ||
			// --- Track P11 ---
			(def.k === 'removeCounters' && part.objects !== undefined) ||
			// --- Track P14 ---
			def.k === 'waterbend' ||
			def.k === 'behold' ||
			(def.k === 'putCounters' && part.objects !== undefined) ||
			def.k === 'putFromHandOnTopOfLibrary' ||
			// --- End Track P14 ---
			// --- Track P22b ---
			def.k === 'beholdOrChoose' ||
			def.k === 'exileFromGraveyardAndPayManaCost' ||
			def.k === 'exileFaceDownPermanentFaceUp'
			// --- End Track P22b ---
		) {
			const objs = 'filter' in def && def.filter === 'self' ? [ctx.source] : (part.objects ?? []);
			return {
				def,
				objectIds: objs.map((c) => c.instanceId),
				objectNames: objs.map((c) => c.card.name),
				// --- Track P17b ---
				...forageExtra
				// --- End Track P17b ---
			};
		}
		// --- Track P14 ---
		if (def.k === 'discardHand') {
			const handCards = ctx.player.hand.filter(
				(c) => !(ctx.isSpell && c.instanceId === ctx.source.instanceId)
			);
			return {
				def,
				objectIds: handCards.map((c) => c.instanceId),
				objectNames: handCards.map((c) => c.card.name),
				// --- Track P17b ---
				...forageExtra
				// --- End Track P17b ---
			};
		}
		// --- End Track P14 ---
		if ((def as { k: string }).k === 'mill') {
			const extra = def as { k: string; count?: Amount };
			const millTotal = extra.count ? n(extra.count, ctx) : 0;
			return { def, millTotal, objectNames: [], ...forageExtra };
		}
		// --- Track P22b ---
		const p22bExtras = {
			...(part.chosenSubTypeCost !== undefined ? { chosenSubTypeCost: part.chosenSubTypeCost } : {}),
			...(part.chosenNumberCost !== undefined ? { chosenNumberCost: part.chosenNumberCost } : {}),
			...(part.chosenKeywordCost !== undefined ? { chosenKeywordCost: part.chosenKeywordCost } : {}),
			...(part.repeatableManaPaidCount !== undefined
				? { repeatableManaPaidCount: part.repeatableManaPaidCount }
				: {})
		};
		return { def, ...forageExtra, ...p22bExtras };
		// --- End Track P22b ---
	});
}

/** Executes step 1 (tap/untap costs) and step 2 (mana payment) once before ordered cost parts run. */
export function payTapAndManaCostParts(
	ctx: CostContext,
	parts: SerializedPlannedCost[],
	mana: ManaCostRequirement | null,
	descriptions: string[],
	aidDescriptions?: string[]
): void {
	const { player, source } = ctx;
	for (const part of parts) {
		if (part.def.k === 'tapSelf') tapPermanent(ctx.state, source);
		// --- Track P10: Emit BecomesUntapped when {Q} untaps a tapped permanent (CR 603.2e) ---
		if (part.def.k === 'untapSelf' && source.tapped) {
			source.tapped = false;
			noteLayerInputsChanged(ctx.state);
			if (source.zone === 'battlefield' && !source.phasedOut) {
				emitEvent(ctx.state, {
					kind: 'BecomesUntapped',
					objectId: source.instanceId,
					object: source
				});
			}
		}
		// --- End Track P10 ---
		if (
			part.def.k === 'tapOthers' ||
			part.def.k === 'tapSubsetSum' ||
			// --- Track P14 ---
			part.def.k === 'waterbend'
			// --- End Track P14 ---
		) {
			const ids = part.objectIds ?? [];
			const names: string[] = [];
			for (const id of ids) {
				const perm = player.battlefield.find((c) => c.instanceId === id);
				if (perm) {
					tapPermanent(ctx.state, perm);
					names.push(perm.card.name);
				}
			}
			const labelNames = part.objectNames && part.objectNames.length > 0 ? part.objectNames : names;
			if (labelNames.length > 0) {
				const targetLog = part.isCostAid && aidDescriptions ? aidDescriptions : descriptions;
				targetLog.push(
					part.def.k === 'waterbend'
						? `tapped ${labelNames.join(', ')} to waterbend`
						: `tapped ${labelNames.join(', ')}`
				);
			}
		}
		// --- Track P14 ---
		if (part.def.k === 'tapAttached' && source.attachedToId) {
			const host = ctx.state.players
				.flatMap((pl) => pl.battlefield)
				.find((c) => !c.phasedOut && c.instanceId === source.attachedToId);
			if (host) {
				tapPermanent(ctx.state, host);
				descriptions.push(`tapped ${host.card.name}`);
			}
		}
		// --- End Track P14 ---
		// --- Track P17b ---
		payP17bUntapOthers(ctx, part, descriptions, aidDescriptions);
		// --- End Track P17b ---
	}
	if (mana) {
		const energyReserved = parts.reduce(
			(sum, p) => sum + (p.def.k === 'payEnergy' ? n(p.def.count, ctx) : 0),
			0
		);
		if (energyReserved > 0) {
			const prevEnergy = player.energyCounters || 0;
			player.energyCounters = Math.max(0, prevEnergy - energyReserved);
			noteLayerInputsChanged(ctx.state);
			try {
				ctx.payMana(mana);
			} finally {
				const spentByMana = Math.max(0, prevEnergy - energyReserved - (player.energyCounters || 0));
				player.energyCounters = Math.max(0, prevEnergy - spentByMana);
				noteLayerInputsChanged(ctx.state);
			}
		} else {
			ctx.payMana(mana);
		}
	}
}

/**
 * Executes ordered non-tap/non-mana cost parts starting at `(startPartIndex, startObjectIndex)`.
 * Stops immediately if any zone change returns `'pending'` (e.g. `zone_replacement_choice`) so
 * later objects and parts are not paid until the replacement finishes.
 */
export function executeCostPaymentParts(
	ctx: CostContext,
	parts: SerializedPlannedCost[],
	startPartIndex = 0,
	startObjectIndex = 0,
	descriptions: string[] = [],
	costKeyword?: string,
	aidDescriptions?: string[]
): PaidCosts {
	const { player, source } = ctx;
	// --- Track P22b ---
	const p22bPaidExtras: Partial<PaidCosts> = {};
	// --- End Track P22b ---
	for (let partIdx = startPartIndex; partIdx < parts.length; partIdx++) {
		const part = parts[partIdx];
		const def = part.def;
		const objStart = partIdx === startPartIndex ? startObjectIndex : 0;
		const targetLog = part.isCostAid && aidDescriptions ? aidDescriptions : descriptions;
		// --- Track P22b ---
		const p22bExec = executeP22bCostPart(
			ctx,
			part,
			partIdx,
			objStart,
			descriptions,
			targetLog,
			(id) => findById(ctx, id),
			p22bPaidExtras
		);
		if (p22bExec.handled) {
			if (p22bExec.pausedResult) return { ...p22bExec.pausedResult, ...p22bPaidExtras };
			if (part.emitForaged) {
				emitEvent(ctx.state, { kind: 'Foraged', playerId: player.playerId });
			}
			continue;
		}
		// --- End Track P22b ---
		// --- Track P20b ---
		const p20bExec = executeP20bCostPart(ctx, part, partIdx, objStart, descriptions, targetLog, (id) =>
			findById(ctx, id)
		);
		if (p20bExec.handled) {
			if (p20bExec.pausedResult) return p20bExec.pausedResult;
			if (part.emitForaged) {
				emitEvent(ctx.state, { kind: 'Foraged', playerId: player.playerId });
			}
			continue;
		}
		// --- End Track P20b ---
		// --- Track P17b ---
		const p17bExec = executeP17bCostPart(ctx, part, partIdx, objStart, descriptions, targetLog);
		if (p17bExec.handled) {
			if (p17bExec.pausedResult) return p17bExec.pausedResult;
			if (part.emitForaged) {
				emitEvent(ctx.state, { kind: 'Foraged', playerId: player.playerId });
			}
			continue;
		}
		// --- End Track P17b ---
		switch (def.k) {
			case 'payLife': {
				if (objStart === 0) {
					const amount = n(def.amount, ctx);
					if (amount > 0) {
						player.life -= amount;
						// --- Track P10 (CR 119.4): Paying life causes life loss ---
						player.lostLifeThisTurn = true;
						noteLayerInputsChanged(ctx.state);
						// --- End Track P10 ---
						// --- Track P12 ---
						recordPlayerLifeLossWave4(player, amount);
						// --- End Track P12 ---
						// --- Track P15: CR 702.179d Start your engines! opponent life-loss check ---
						onPlayerLostLifeCheckSpeedTrigger(ctx.state, player.playerId, amount);
						// --- End Track P15 ---
						// --- Track P22b ---
						p22bPaidExtras.lifePaidCount = (p22bPaidExtras.lifePaidCount ?? 0) + amount;
						// --- End Track P22b ---
						targetLog.push(`paid ${amount} life`);
					}
				}
				break;
			}
			case 'payEnergy': {
				if (objStart === 0) {
					const amount = n(def.count, ctx);
					if (amount > 0) {
						player.energyCounters = Math.max(0, (player.energyCounters || 0) - amount);
						noteLayerInputsChanged(ctx.state);
						targetLog.push(`paid ${amount} {E}`);
					}
				}
				break;
			}
			case 'loyalty':
				if (objStart === 0) {
					// --- Track P15: CR 606.4 +X / -X loyalty ---
					const delta = def.isX
						? (def.sign === '-' ? -1 : 1) * Math.max(0, ctx.xValue || 0)
						: def.delta;
					source.counters.loyalty = (source.counters.loyalty || 0) + delta;
					noteLayerInputsChanged(ctx.state);
					// --- End Track P15 ---
					// --- Track P18b (CR 606.3 / Urza, Planeswalker) ---
					source.loyaltyActivationsThisTurn = (source.loyaltyActivationsThisTurn ?? 0) + 1;
					const losesAll =
						source.zone === 'battlefield' && !source.phasedOut
							? evaluatePermanent(ctx.state, source).losesAllAbilities
							: false;
					const maxLoy = getPermanentMaxLoyaltyActivationsPerTurn(ctx.state, source, losesAll);
					source.usedLoyaltyThisTurn = source.loyaltyActivationsThisTurn >= maxLoy;
					// --- End Track P18b ---
				}
				break;
			case 'exertSelf':
				if (objStart === 0 && source.zone === 'battlefield' && !source.phasedOut) {
					exertPermanent(ctx.state, source, player.playerId);
					targetLog.push(`exerted ${source.card.name}`);
				}
				break;
			case 'removeCounters': {
				if (objStart === 0) {
					// --- Track P11 ---
					const amount = def.removeAll
						? totalMatchingCountersOn(source, def.counter)
						: n(def.count, ctx);
					const ctrLabel = def.counter === 'any' ? 'counter(s)' : `${def.counter} counter(s)`;
					if (def.from === 'self') {
						const removed = deductMatchingCountersFrom(ctx.state, source, def.counter, amount);
						targetLog.push(`removed ${removed} ${ctrLabel}`);
					} else if (def.among) {
						const fromFilter = typeof def.from === 'object' ? def.from : {};
						const fctx = filterCtx(ctx);
						const eligible = player.battlefield.filter(
							(c) =>
								!c.phasedOut &&
								matchesObjectFilter(c, { ...fromFilter, controller: 'you' }, fctx) &&
								totalMatchingCountersOn(c, def.counter) > 0
						);
						let remaining = amount;
						let totalRemoved = 0;
						for (const perm of eligible) {
							if (remaining <= 0) break;
							const took = deductMatchingCountersFrom(ctx.state, perm, def.counter, remaining);
							remaining -= took;
							totalRemoved += took;
						}
						targetLog.push(`removed ${totalRemoved} ${ctrLabel}`);
					} else {
						const fromFilter = typeof def.from === 'object' ? def.from : {};
						const chosenId = part.objectIds?.[0];
						const fctx = filterCtx(ctx);
						const targetPerm =
							(chosenId ? player.battlefield.find((c) => c.instanceId === chosenId) : undefined) ??
							player.battlefield.find(
								(c) =>
									!c.phasedOut &&
									matchesObjectFilter(c, { ...fromFilter, controller: 'you' }, fctx) &&
									totalMatchingCountersOn(c, def.counter) >= amount
							);
						if (targetPerm) {
							const removed = deductMatchingCountersFrom(
								ctx.state,
								targetPerm,
								def.counter,
								amount
							);
							targetLog.push(`removed ${removed} ${ctrLabel} from ${targetPerm.card.name}`);
						}
					}
					// --- End Track P11 ---
				}
				break;
			}
			case 'sacrifice': {
				const ids = part.objectIds ?? (def.filter === 'self' ? [source.instanceId] : []);
				const names = part.objectNames ?? [];
				for (let j = objStart; j < ids.length; j++) {
					const perm =
						player.battlefield.find((c) => c.instanceId === ids[j]) ??
						ctx.state.players.flatMap((pl) => pl.battlefield).find((c) => c.instanceId === ids[j]) ??
						(def.filter === 'self' && source.zone === 'battlefield' ? source : undefined);
					if (!perm) continue;
					// --- Track P19a (CR 608.2h / CR 707.10): Snapshot sacrificed-cost LKI before battlefield departure ---
					if (ctx.sacrificedLkiOut && perm.zone === 'battlefield') {
						ctx.sacrificedLkiOut.push(captureP19aSacrificedCostLki(ctx.state, perm));
					}
					// --- End Track P19a ---
					if (sacrifice(ctx, perm) === 'pending') {
						return { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: j + 1 };
					}
				}
				if (def.filter !== 'self') targetLog.push(`sacrificed ${names.join(', ')}`);
				break;
			}
			case 'discard': {
				const ids = part.objectIds ?? (def.filter === 'self' ? [source.instanceId] : []);
				const names = part.objectNames ?? [];
				const discardReason: 'discard' | 'cycle' =
					def.filter === 'self' && costKeyword === 'cycling' ? 'cycle' : 'discard';
				for (let j = objStart; j < ids.length; j++) {
					const card =
						player.hand.find((c) => c.instanceId === ids[j]) ??
						(def.filter === 'self' && source.zone === 'hand' ? source : undefined);
					if (!card) continue;
					if (moveFromZone(ctx, card, 'hand', 'graveyard', discardReason) === 'pending') {
						return { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: j + 1 };
					}
				}
				targetLog.push(
					def.filter === 'self'
						? `discarded ${names[0] ?? source.card.name}`
						: `discarded ${names.join(', ')}${part.isRandom ? ' at random' : ''}`
				);
				break;
			}
			case 'exileFrom': {
				const zone = def.zone as PlayerZone;
				const ids = part.objectIds ?? (def.filter === 'self' ? [source.instanceId] : []);
				const names = part.objectNames ?? [];
				// --- Track P10: Batch GraveyardLeaveBatch when exiling graveyard cards as a cost ---
				const batchGy = zone === 'graveyard' && ids.length > 1;
				const movedFromGy: CardInstance[] = [];
				// --- End Track P10 ---
				for (let j = objStart; j < ids.length; j++) {
					const card =
						zoneOf(player, zone).find((c) => c.instanceId === ids[j]) ??
						(def.filter === 'self' && source.zone === zone ? source : undefined);
					if (!card) continue;
					const res = moveFromZone(ctx, card, zone, 'exile', undefined, batchGy);
					if (res === 'pending') {
						if (batchGy && movedFromGy.length > 0) {
							emitEvent(ctx.state, {
								kind: 'GraveyardLeaveBatch',
								ownerId: player.playerId,
								objects: movedFromGy
							});
						}
						return { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: j + 1 };
					}
					if (batchGy && res !== 'graveyard') {
						movedFromGy.push(card);
					}
				}
				if (batchGy && movedFromGy.length > 0) {
					emitEvent(ctx.state, {
						kind: 'GraveyardLeaveBatch',
						ownerId: player.playerId,
						objects: movedFromGy
					});
				}
				targetLog.push(`exiled ${names.join(', ')} from ${def.zone}`);
				break;
			}
			case 'revealFromHand': {
				// --- Track P8 + Track P9: CR 701.20a stamp revealed hand/command cards as known to all living players ---
				const ids = part.objectIds ?? (def.filter === 'self' ? [source.instanceId] : []);
				const names = part.objectNames ?? (def.filter === 'self' ? [source.card.name] : []);
				for (const id of ids) {
					const card =
						player.hand.find((c) => c.instanceId === id) ??
						player.command.find((c) => c.instanceId === id);
					if (card) {
						markHandCardRevealedToAll(ctx.state, card);
					}
				}
				if (names.length > 0) targetLog.push(`revealed ${names.join(', ')}`);
				break;
			}
			// --- Track P9 ---
			case 'returnToHand': {
				const ids = part.objectIds ?? (def.filter === 'self' ? [source.instanceId] : []);
				const names = part.objectNames ?? [];
				for (let j = objStart; j < ids.length; j++) {
					const perm =
						player.battlefield.find((c) => c.instanceId === ids[j]) ??
						ctx.state.players.flatMap((pl) => pl.battlefield).find((c) => c.instanceId === ids[j]) ??
						(def.filter === 'self' && source.zone === 'battlefield' ? source : undefined);
					if (!perm) continue;
					const owner = ctx.state.players.find((pl) => pl.playerId === perm.ownerId) ?? player;
					if (
						moveObject(ctx.state, perm, 'hand', {
							from: 'anyBattlefield',
							toPlayer: owner,
							detachAttachments: true,
							commanderRedirect: true,
							leaveBattlefieldReset: true,
							bumpVersion: true,
							newTimestamp: true,
							ceaseToExist: 'tokens'
						}) === 'pending'
					) {
						return { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: j + 1 };
					}
				}
				targetLog.push(
					def.filter === 'self'
						? `returned ${names[0] ?? source.card.name} to hand`
						: `returned ${names.join(', ')} to hand`
				);
				break;
			}
			// --- Track P14 ---
			case 'behold': {
				if (objStart === 0) {
					const ids = part.objectIds ?? [];
					for (const id of ids) {
						const handCard =
							player.hand.find((c) => c.instanceId === id) ??
							player.command.find((c) => c.instanceId === id);
						if (handCard) {
							markHandCardRevealedToAll(ctx.state, handCard);
							targetLog.push(`revealed ${handCard.card.name} to behold`);
							continue;
						}
						const perm = player.battlefield.find((c) => c.instanceId === id);
						if (perm) {
							targetLog.push(`beheld ${perm.card.name}`);
						}
					}
				}
				break;
			}
			case 'putCounters': {
				if (objStart === 0) {
					const amount = n(def.count, ctx);
					if (amount > 0) {
						if (def.on === 'self') {
							if (source.zone === 'battlefield' && !source.phasedOut) {
								addCountersForCostOnPermanent(ctx.state, source, def.counter, amount);
								targetLog.push(
									`put ${amount} ${def.counter} counter(s) on ${source.card.name}`
								);
							}
						} else {
							const onFilter: ObjectFilter = def.on;
							const chosenId = part.objectIds?.[0];
							const fctx = filterCtx(ctx);
							const targetPerm =
								(chosenId
									? player.battlefield.find((c) => c.instanceId === chosenId)
									: undefined) ??
								player.battlefield.find(
									(c) =>
										!c.phasedOut &&
										!hasRestriction(ctx.state, c, 'cantHaveCounters') &&
										matchesObjectFilter(c, { ...onFilter, controller: 'you' }, fctx)
								);
							if (targetPerm) {
								addCountersForCostOnPermanent(ctx.state, targetPerm, def.counter, amount);
								targetLog.push(
									`put ${amount} ${def.counter} counter(s) on ${targetPerm.card.name}`
								);
							}
						}
					}
				}
				break;
			}
			case 'discardHand': {
				const ids = part.objectIds ?? [];
				const names = part.objectNames ?? [];
				for (let j = objStart; j < ids.length; j++) {
					const card = player.hand.find((c) => c.instanceId === ids[j]);
					if (!card) continue;
					if (moveFromZone(ctx, card, 'hand', 'graveyard', 'discard') === 'pending') {
						return { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: j + 1 };
					}
				}
				targetLog.push(names.length > 0 ? `discarded hand (${names.join(', ')})` : 'discarded hand');
				break;
			}
			case 'putFromHandOnTopOfLibrary': {
				const ids = part.objectIds ?? [];
				const names = part.objectNames ?? [];
				for (let j = objStart; j < ids.length; j++) {
					const card = player.hand.find((c) => c.instanceId === ids[j]);
					if (!card) continue;
					if (
						moveObject(ctx.state, card, 'library', {
							from: { player, zone: 'hand' },
							toPlayer: player,
							insert: () => 'start',
							newTimestamp: true,
							bumpVersion: true
						}) === 'pending'
					) {
						return { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: j + 1 };
					}
				}
				if (names.length > 0) {
					targetLog.push(`put ${names.join(', ')} on top of library`);
				}
				break;
			}
			// --- End Track P14 ---
			default: {
				const extra = def as { k: string; count?: Amount };
				if (extra.k === 'mill' && extra.count) {
					const total = part.millTotal ?? n(extra.count, ctx);
					const milledNames = part.objectNames ?? (part.objectNames = []);
					for (let j = objStart; j < total && player.library.length > 0; j++) {
						const top = player.library[0];
						milledNames.push(top.card.name);
						if (moveFromZone(ctx, top, 'library', 'graveyard') === 'pending') {
							return { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: j + 1 };
						}
					}
					if (milledNames.length > 0) {
						targetLog.push(`milled ${milledNames.join(', ')}`);
					}
				}
				break;
			}
		}
		// --- Track P17b ---
		if (part.emitForaged) {
			emitEvent(ctx.state, { kind: 'Foraged', playerId: player.playerId });
		}
		// --- End Track P17b ---
	}
	return { descriptions, paused: false, ...p22bPaidExtras };
}

/** Pays a complete plan from `planCosts`. */
export function payPlannedCosts(ctx: CostContext, plan: Extract<CostPlan, { parts: PlannedCost[] }>): PaidCosts {
	const parts = serializeCostPlanParts(ctx, plan);
	const descriptions: string[] = [];
	payTapAndManaCostParts(ctx, parts, plan.mana, descriptions);
	return executeCostPaymentParts(ctx, parts, 0, 0, descriptions);
}

// ---- Generic CastCostAid Application (CR 601.2f-h, 702.51, 702.66) -------------------------

const AID_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

export type ApplyCastCostAidsResult =
	| {
			ok: true;
			remainingReq: ManaCostRequirement;
			tapIds: string[];
			exileIds: string[];
			// --- Track P15 ---
			assistPlayerId?: string;
			assistGenericPaid?: number;
			// --- End Track P15 ---
			summaryParts: string[];
			paidByCandidate: Record<string, ManaColor | 'generic'>;
	  }
	| { ok: false; error: string };

/** Formats a `ManaCostRequirement` back into canonical `{N}{W}{U}...` notation. */
export function formatManaRequirement(req: ManaCostRequirement, showUnsetX = false): string {
	let out = '';
	if (showUnsetX && req.hasX && req.xCount > 0) {
		out += '{X}'.repeat(req.xCount);
	}
	if (req.generic > 0) {
		out += `{${req.generic}}`;
	}
	// --- Track P11 ---
	if (req.snow && req.snow > 0) {
		out += '{S}'.repeat(req.snow);
	}
	const remColored: Record<ManaColor, number> = { ...req.colored };
	let flexOut = '';
	if (req.flexibleSymbols && req.flexibleSymbols.length > 0) {
		for (const f of req.flexibleSymbols) {
			if ((remColored[f.primaryColor] ?? 0) > 0) {
				remColored[f.primaryColor] -= 1;
				if (f.altColor && f.altLife) {
					flexOut += `{${f.primaryColor}/${f.altColor}/P}`;
				} else if (f.altColor) {
					flexOut += `{${f.primaryColor}/${f.altColor}}`;
				} else if (f.altGeneric !== undefined && f.altLife) {
					flexOut += `{${f.altGeneric}/${f.primaryColor}/P}`;
				} else if (f.altGeneric !== undefined) {
					flexOut += `{${f.altGeneric}/${f.primaryColor}}`;
				} else if (f.altLife) {
					flexOut += `{${f.primaryColor}/P}`;
				} else {
					flexOut += `{${f.primaryColor}}`;
				}
			}
		}
	}
	for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
		const count = remColored[c] ?? 0;
		if (count > 0) out += `{${c}}`.repeat(count);
	}
	out += flexOut;
	// --- End Track P11 ---
	return out || '{0}';
}

function cloneManaRequirement(req: ManaCostRequirement): ManaCostRequirement {
	return {
		...req,
		colored: { ...req.colored },
		...(req.flexibleSymbols ? { flexibleSymbols: req.flexibleSymbols.map((s) => ({ ...s })) } : {})
	};
}

/**
 * Validates and applies post-determination `CastCostAid` selections (`CR 601.2f–h`, `CR 118.10`)
 * against the spell's already-determined total mana requirement `costReq`.
 */
export function applyCastCostAids(
	costReq: ManaCostRequirement,
	option: CastOption,
	costAidIds?: Record<string, string[]>,
	costAidColorChoices?: Record<string, ManaColor | 'generic'>
): ApplyCastCostAidsResult {
	if (!costAidIds || Object.keys(costAidIds).length === 0) {
		return {
			ok: true,
			remainingReq: cloneManaRequirement(costReq),
			tapIds: [],
			exileIds: [],
			summaryParts: [],
			paidByCandidate: {}
		};
	}

	const aidById = new Map((option.paymentAids ?? []).map((a) => [a.id, a]));
	const seenIds = new Set<string>();
	const tapEntries: Array<{ id: string; colors: ManaColor[]; paysGeneric: number }> = [];
	const exileEntries: Array<{ id: string; paysGeneric: number }> = [];
	// --- Track P15 ---
	const assistEntries: Array<{ id: string; paysGeneric: number }> = [];
	// --- End Track P15 ---

	for (const [aidId, rawIds] of Object.entries(costAidIds)) {
		if (!rawIds || rawIds.length === 0) continue;
		const aid = aidById.get(aidId);
		if (!aid) {
			return { ok: false, error: `Unknown payment aid "${aidId}".` };
		}
		const eligible = new Set(aid.candidateIds);
		// --- Track P14 & P15 ---
		if (
			aid.maxGenericReduction !== undefined &&
			rawIds.length * aid.paysGeneric > aid.maxGenericReduction
		) {
			// --- End Track P14 & P15 ---
			return {
				ok: false,
				error: `Selected ${rawIds.length} entry(s) for ${aid.label}, exceeding max reduction ${aid.maxGenericReduction}.`
			};
		}
		// --- Track P15: CR 702.132a Assist allows one player to pay multiple generic mana ---
		if (aid.kind === 'assistPlayer') {
			const distinctPlayers = new Set(rawIds);
			if (distinctPlayers.size > 1) {
				return { ok: false, error: 'Assist allows only one other player to pay generic mana.' };
			}
			for (const id of rawIds) {
				if (!eligible.has(id)) {
					return { ok: false, error: `Ineligible player "${id}" for ${aid.label}.` };
				}
				assistEntries.push({ id, paysGeneric: aid.paysGeneric });
			}
			continue;
		}
		// --- End Track P15 ---
		for (const id of rawIds) {
			if (seenIds.has(id)) {
				return { ok: false, error: `Duplicate payment aid candidate "${id}" (CR 118.10).` };
			}
			if (!eligible.has(id)) {
				return { ok: false, error: `Ineligible candidate "${id}" for ${aid.label}.` };
			}
			seenIds.add(id);
			if (aid.kind === 'tapPermanent') {
				const rawColors = aid.colorsByCandidate?.[id] ?? [];
				const colors = rawColors.filter((c): c is ManaColor => AID_COLORS.includes(c));
				tapEntries.push({ id, colors, paysGeneric: aid.paysGeneric });
			} else {
				exileEntries.push({ id, paysGeneric: aid.paysGeneric });
			}
		}
	}

	const colored = { ...costReq.colored };
	let generic = costReq.generic;
	const paidByCandidate: Record<string, ManaColor | 'generic'> = {};
	const flexibleTaps: Array<{ id: string; colors: ManaColor[]; paysGeneric: number }> = [];

	for (const entry of tapEntries) {
		const choice = costAidColorChoices?.[entry.id];
		if (choice === undefined) {
			flexibleTaps.push(entry);
			continue;
		}
		if (choice === 'generic') {
			if (generic < entry.paysGeneric) {
				return {
					ok: false,
					error: 'Cannot pay generic mana with payment aid: no generic mana remaining.'
				};
			}
			generic -= entry.paysGeneric;
			paidByCandidate[entry.id] = 'generic';
			continue;
		}
		if (!entry.colors.includes(choice)) {
			return { ok: false, error: `Selected permanent cannot pay {${choice}}.` };
		}
		if ((colored[choice] ?? 0) <= 0) {
			return { ok: false, error: `No {${choice}} mana remaining in total cost.` };
		}
		colored[choice] -= 1;
		paidByCandidate[entry.id] = choice;
	}

	const exileGenericTotal = exileEntries.reduce((sum, e) => sum + e.paysGeneric, 0);
	if (exileGenericTotal > generic) {
		return {
			ok: false,
			error: `Cannot exile ${exileEntries.length} card(s): only ${generic} generic mana remaining in total cost.`
		};
	}
	generic -= exileGenericTotal;
	for (const e of exileEntries) {
		paidByCandidate[e.id] = 'generic';
	}
	// --- Track P15 ---
	const assistGenericTotal = assistEntries.reduce((sum, e) => sum + e.paysGeneric, 0);
	if (assistGenericTotal > generic) {
		return {
			ok: false,
			error: `Cannot pay ${assistGenericTotal} generic mana with Assist: only ${generic} generic mana remaining in total cost.`
		};
	}
	generic -= assistGenericTotal;
	for (const e of assistEntries) {
		paidByCandidate[e.id] = 'generic';
	}
	// --- End Track P15 ---

	// Sort flexible taps with fewer eligible needed colors first so mono-color taps get priority.
	const sortedFlex = [...flexibleTaps].sort((a, b) => {
		const aNeed = a.colors.filter((c) => colored[c] > 0).length;
		const bNeed = b.colors.filter((c) => colored[c] > 0).length;
		return aNeed - bNeed;
	});

	const colorSlots: ManaColor[] = [];
	for (const c of AID_COLORS) {
		for (let i = 0; i < (colored[c] ?? 0); i++) colorSlots.push(c);
	}
	const matchSlotToTap = new Array<number>(colorSlots.length).fill(-1);
	const matchTapToSlot = new Array<number>(sortedFlex.length).fill(-1);

	const tryAugment = (tapIdx: number, visitedSlots: boolean[]): boolean => {
		const tap = sortedFlex[tapIdx];
		for (let slotIdx = 0; slotIdx < colorSlots.length; slotIdx++) {
			if (visitedSlots[slotIdx]) continue;
			if (!tap.colors.includes(colorSlots[slotIdx])) continue;
			visitedSlots[slotIdx] = true;
			if (matchSlotToTap[slotIdx] === -1 || tryAugment(matchSlotToTap[slotIdx], visitedSlots)) {
				matchSlotToTap[slotIdx] = tapIdx;
				matchTapToSlot[tapIdx] = slotIdx;
				return true;
			}
		}
		return false;
	};

	for (let i = 0; i < sortedFlex.length; i++) {
		tryAugment(i, new Array<boolean>(colorSlots.length).fill(false));
	}

	for (let i = 0; i < sortedFlex.length; i++) {
		const tap = sortedFlex[i];
		const slotIdx = matchTapToSlot[i];
		if (slotIdx !== -1) {
			const c = colorSlots[slotIdx];
			colored[c] -= 1;
			paidByCandidate[tap.id] = c;
		} else {
			if (generic < tap.paysGeneric) {
				return {
					ok: false,
					error: `Too many permanents tapped for payment aid: exceeds remaining payable mana.`
				};
			}
			generic -= tap.paysGeneric;
			paidByCandidate[tap.id] = 'generic';
		}
	}

	const summaryParts: string[] = [];
	if (tapEntries.length > 0) summaryParts.push(`tapped ${tapEntries.length} creature(s)`);
	if (exileEntries.length > 0) summaryParts.push(`exiled ${exileEntries.length} card(s) from graveyard`);
	// --- Track P15 ---
	if (assistGenericTotal > 0) summaryParts.push(`assisted for {${assistGenericTotal}}`);
	// --- End Track P15 ---

	return {
		ok: true,
		remainingReq: {
			...costReq,
			colored,
			generic
		},
		tapIds: tapEntries.map((e) => e.id),
		exileIds: exileEntries.map((e) => e.id),
		// --- Track P15 ---
		...(assistEntries.length > 0
			? { assistPlayerId: assistEntries[0].id, assistGenericPaid: assistGenericTotal }
			: {}),
		// --- End Track P15 ---
		summaryParts,
		paidByCandidate
	};
}
