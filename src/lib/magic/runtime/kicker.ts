/**
 * Generic optional-additional-cost and kicker-tracking helpers (CR 702.33, 601.2f, 400.7).
 *
 * Shared cleanly between ruleTree, runtime/costs, runtime/objectFilter, runtime/layers,
 * runtime/triggers, runtime/effects, and engine without introducing module cycles.
 */
import { activeAbilityDefs } from './faces.ts';
import type { Amount, Condition, CostDef, TargetSpec } from '../ir.ts';
import type {
	CardInstance,
	CastOption,
	CastOptionOptionalCost,
	GameState,
	ScryfallCard,
	StackItem
} from '../types.ts';

const KICKER_KEYWORDS: Record<string, boolean> = {
	kicker: false,
	multikicker: true
};

const RETURN_TO_HAND_OPTIONAL_KEYWORDS: ReadonlySet<string> = new Set(['buyback']);
const CHOOSE_ALL_MODES_OPTIONAL_KEYWORDS: ReadonlySet<string> = new Set(['entwine']);

function rawOptionalEntriesForCard(
	card: ScryfallCard,
	faceIndex = 0,
	fused = false
): CastOptionOptionalCost[] {
	const abilities = activeAbilityDefs(card, { zone: 'stack', faceIndex, fused });
	const out: CastOptionOptionalCost[] = [];
	let idx = 0;
	let buybackIdx = 0;
	let entwineIdx = 0;
	for (const ab of abilities) {
		if (ab.kind !== 'keyword') continue;
		if (
			CHOOSE_ALL_MODES_OPTIONAL_KEYWORDS.has(ab.keyword.name) &&
			ab.keyword.costDefs &&
			ab.keyword.costDefs.length > 0
		) {
			const rawCost = (ab.keyword.cost ?? ab.keyword.param ?? '').trim();
			const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
			out.push({
				id: `entwine:${entwineIdx++}`,
				label: rawCost ? (isManaOnly ? `Entwine (${rawCost})` : `Entwine—${rawCost}`) : 'Entwine',
				costDisplay: rawCost,
				costDefs: ab.keyword.costDefs,
				maxCount: 1,
				chooseAllModes: true
			});
			continue;
		}
		if (
			RETURN_TO_HAND_OPTIONAL_KEYWORDS.has(ab.keyword.name) &&
			ab.keyword.costDefs &&
			ab.keyword.costDefs.length > 0
		) {
			const rawCost = (ab.keyword.cost ?? ab.keyword.param ?? '').trim();
			out.push({
				id: `buyback:${buybackIdx++}`,
				label: `Buyback (${rawCost})`,
				costDisplay: rawCost,
				costDefs: ab.keyword.costDefs,
				maxCount: 1,
				returnToHandOnResolve: true
			});
			continue;
		}
		const isMulti = KICKER_KEYWORDS[ab.keyword.name];
		if (isMulti === undefined) continue;
		for (const entry of ab.keyword.kickerCosts ?? []) {
			out.push({
				id: `kicker:${idx++}`,
				label: `${isMulti ? 'Multikicker' : 'Kicker'} (${entry.cost})`,
				costDisplay: entry.cost,
				costDefs: entry.costDefs,
				maxCount: isMulti ? 99 : 1,
				...(entry.tags[0] ? { kickedTag: entry.tags[0] } : {}),
				kickedTags: [...entry.tags]
			});
		}
	}
	return out;
}

export interface KickerTrackingInfo {
	count: number;
	tags: string[];
	tagCounts?: Record<string, number>;
	foretold?: boolean;
	blitzed?: boolean;
}

export type CastOptionLike = Partial<
	Pick<CastOption, 'faceIndex' | 'fused' | 'optionalAdditionalCosts' | 'spellMods'>
>;

export function computeKickerTracking(
	card: ScryfallCard,
	optionalCostCounts?: Record<string, number>,
	option?: CastOptionLike,
	faceIndex = 0,
	fused = false
): KickerTrackingInfo {
	const resolvedFace = option?.faceIndex ?? faceIndex;
	const resolvedFused = option?.fused ?? fused;
	const entries = option?.optionalAdditionalCosts ?? rawOptionalEntriesForCard(card, resolvedFace, resolvedFused);
	let count = 0;
	const tags: string[] = [];
	const tagCounts: Record<string, number> = {};
	for (const entry of entries) {
		if (!entry.id.startsWith('kicker:')) continue;
		const n = optionalCostCounts?.[entry.id] ?? 0;
		if (n <= 0) continue;
		count += n;
		const entryTags = entry.kickedTags ?? (entry.kickedTag ? [entry.kickedTag] : []);
		for (const tag of entryTags) {
			if (!tags.includes(tag)) tags.push(tag);
			tagCounts[tag] = (tagCounts[tag] ?? 0) + n;
		}
	}
	return {
		count,
		tags,
		tagCounts,
		...(option?.spellMods?.foretold ? { foretold: true } : {}),
		...(option?.spellMods?.blitzed ? { blitzed: true } : {})
	};
}

export function evaluateKickerCondition(
	cond: Extract<Condition, { k: 'kicked' }>,
	info: KickerTrackingInfo
): boolean {
	const min = cond.minCount ?? 1;
	if (!cond.tag) return info.count >= min;
	if (info.tagCounts) return (info.tagCounts[cond.tag] ?? 0) >= min;
	return info.tags.includes(cond.tag) && info.count >= min;
}

export function evaluateKickedCountAmount(
	amount: Extract<Amount, { k: 'kickedCount' }>,
	info: KickerTrackingInfo
): number {
	const base = amount.tag
		? info.tagCounts
			? (info.tagCounts[amount.tag] ?? 0)
			: info.tags.includes(amount.tag)
				? info.count
				: 0
		: info.count;
	return base * (amount.multiplier ?? 1);
}

export function isConditionMetWithKicker(cond: Condition, info: KickerTrackingInfo): boolean {
	if (cond.k === 'kicked') return evaluateKickerCondition(cond, info);
	if (cond.k === 'foretold') return Boolean(info.foretold);
	if (cond.k === 'blitzed') return Boolean(info.blitzed);
	if (cond.k === 'not') return !isConditionMetWithKicker(cond.of, info);
	if (cond.k === 'and') return cond.of.every((c) => isConditionMetWithKicker(c, info));
	if (cond.k === 'or') return cond.of.some((c) => isConditionMetWithKicker(c, info));
	return false;
}

/**
 * Evaluates a cast-time Condition (such as conditional target requirements under CR 702.33g)
 * from the spell card and selected `optionalCostCounts`.
 */
export function isCastConditionMet(
	cond: Condition,
	card: ScryfallCard,
	optionalCostCounts?: Record<string, number>,
	option?: CastOptionLike,
	faceIndex = 0,
	fused = false
): boolean {
	return isConditionMetWithKicker(
		cond,
		computeKickerTracking(card, optionalCostCounts, option, faceIndex, fused)
	);
}

export function spellOptionalAdditionalCosts(
	card: ScryfallCard,
	faceIndex = 0,
	fused = false
): CastOptionOptionalCost[] {
	const entries = rawOptionalEntriesForCard(card, faceIndex, fused);
	if (entries.length === 0) return [];
	const abilities = activeAbilityDefs(card, { zone: 'stack', faceIndex, fused });
	const conditionalSpecs: TargetSpec[] = [];
	for (const ab of abilities) {
		if (ab.kind === 'spell') {
			for (const sp of ab.targets) if (sp.condition) conditionalSpecs.push(sp);
			for (const m of ab.modal?.modes ?? []) {
				for (const sp of m.targets) if (sp.condition) conditionalSpecs.push(sp);
			}
		} else if (ab.kind === 'triggered') {
			for (const sp of ab.targets) if (sp.condition) conditionalSpecs.push(sp);
		}
	}
	for (const entry of entries) {
		const enables = conditionalSpecs.some(
			(sp) =>
				sp.condition &&
				!isCastConditionMet(sp.condition, card, undefined, undefined, faceIndex, fused) &&
				isCastConditionMet(sp.condition, card, { [entry.id]: 1 }, undefined, faceIndex, fused)
		);
		if (enables) entry.enablesTarget = true;
	}
	return entries;
}

export function validateOptionalCostCounts(
	option: CastOption | undefined,
	optionalCostCounts?: Record<string, number>
): { ok: boolean; error?: string; normalized: Record<string, number> } {
	if (optionalCostCounts === undefined) {
		return { ok: true, normalized: {} };
	}
	if (!optionalCostCounts || typeof optionalCostCounts !== 'object' || Array.isArray(optionalCostCounts)) {
		return { ok: false, error: 'Invalid optionalCostCounts payload', normalized: {} };
	}
	const optMap = new Map<string, CastOptionOptionalCost>();
	for (const opt of option?.optionalAdditionalCosts ?? []) {
		optMap.set(opt.id, opt);
	}
	const normalized: Record<string, number> = {};
	for (const [id, rawCount] of Object.entries(optionalCostCounts)) {
		const opt = optMap.get(id);
		if (!opt) {
			return { ok: false, error: `Unknown optional cost id: ${id}`, normalized: {} };
		}
		if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 0) {
			return { ok: false, error: `Invalid optional cost count for ${id}`, normalized: {} };
		}
		if (rawCount > opt.maxCount) {
			return { ok: false, error: `Optional cost ${id} exceeds max count (${opt.maxCount})`, normalized: {} };
		}
		if (rawCount > 0) normalized[id] = rawCount;
	}
	return { ok: true, normalized };
}

export function expandOptionalAdditionalCosts(
	option: CastOption | undefined,
	optionalCostCounts?: Record<string, number>
): { manaCosts: string[]; nonManaDefs: CostDef[] } {
	const manaCosts: string[] = [];
	const nonManaDefs: CostDef[] = [];
	for (const opt of option?.optionalAdditionalCosts ?? []) {
		const count = optionalCostCounts?.[opt.id] ?? 0;
		for (let i = 0; i < count; i++) {
			for (const def of opt.costDefs) {
				if (def.k === 'mana') manaCosts.push(def.cost);
				else nonManaDefs.push(def);
			}
		}
	}
	return { manaCosts, nonManaDefs };
}

export function getObjectKickerInfo(
	state: GameState,
	card: ScryfallCard,
	instanceId?: string,
	stackItem?: StackItem,
	source?: CardInstance
): KickerTrackingInfo {
	if (stackItem) {
		if (stackItem.kind === 'spell') {
			return computeKickerTracking(
				stackItem.card,
				stackItem.optionalCostCounts,
				{ spellMods: stackItem.spellMods },
				stackItem.faceIndex ?? 0,
				stackItem.fused ?? false
			);
		}
		if (
			stackItem.sourceKickedCount !== undefined ||
			stackItem.sourceForetold !== undefined ||
			stackItem.sourceBlitzed !== undefined
		) {
			return {
				count: stackItem.sourceKickedCount ?? 0,
				tags: stackItem.sourceKickedTags ?? [],
				...(stackItem.sourceForetold ? { foretold: true } : {}),
				...(stackItem.sourceBlitzed ? { blitzed: true } : {})
			};
		}
	}
	if (instanceId) {
		for (const p of state.players) {
			const perm: CardInstance | undefined = p.battlefield.find((c) => c.instanceId === instanceId);
			if (perm) {
				return {
					count: perm.kickedCount ?? 0,
					tags: perm.kickedTags ?? [],
					...(perm.foretold ? { foretold: true } : {}),
					...(perm.blitzed ? { blitzed: true } : {})
				};
			}
		}
		const stackSpell = state.stack.find((s) => s.sourceInstanceId === instanceId);
		if (stackSpell) {
			if (stackSpell.kind === 'spell') {
				return computeKickerTracking(
					stackSpell.card,
					stackSpell.optionalCostCounts,
					{ spellMods: stackSpell.spellMods },
					stackSpell.faceIndex ?? 0,
					stackSpell.fused ?? false
				);
			}
			if (
				stackSpell.sourceKickedCount !== undefined ||
				stackSpell.sourceForetold !== undefined ||
				stackSpell.sourceBlitzed !== undefined
			) {
				return {
					count: stackSpell.sourceKickedCount ?? 0,
					tags: stackSpell.sourceKickedTags ?? [],
					...(stackSpell.sourceForetold ? { foretold: true } : {}),
					...(stackSpell.sourceBlitzed ? { blitzed: true } : {})
				};
			}
		}
	}
	if (
		source &&
		(source.kickedCount !== undefined ||
			(source.kickedTags && source.kickedTags.length > 0) ||
			source.foretold ||
			source.blitzed)
	) {
		return {
			count: source.kickedCount ?? 0,
			tags: source.kickedTags ?? [],
			...(source.foretold ? { foretold: true } : {}),
			...(source.blitzed ? { blitzed: true } : {})
		};
	}
	// Fallback: unused card-level helper when source instance is unavailable
	void card;
	return { count: 0, tags: [] };
}

export function hasReturnToHandOptionalCost(
	option: CastOption | undefined,
	optionalCostCounts?: Record<string, number>
): boolean {
	if (!option?.optionalAdditionalCosts || !optionalCostCounts) return false;
	return option.optionalAdditionalCosts.some(
		(opt) => Boolean(opt.returnToHandOnResolve) && (optionalCostCounts[opt.id] ?? 0) > 0
	);
}

export function isObjectEvoked(
	state: GameState,
	instanceId?: string,
	stackItem?: StackItem,
	source?: CardInstance
): boolean {
	if (stackItem) {
		if (stackItem.kind === 'spell') return Boolean(stackItem.spellMods?.evoked);
		if (stackItem.sourceEvoked !== undefined) return stackItem.sourceEvoked;
	}
	if (source?.evoked !== undefined) return Boolean(source.evoked);
	if (instanceId) {
		for (const p of state.players) {
			const perm = p.battlefield.find((c) => c.instanceId === instanceId);
			if (perm) return Boolean(perm.evoked);
		}
		const stackSpell = state.stack.find((s) => s.sourceInstanceId === instanceId);
		if (stackSpell) {
			if (stackSpell.kind === 'spell') return Boolean(stackSpell.spellMods?.evoked);
			if (stackSpell.sourceEvoked !== undefined) return stackSpell.sourceEvoked;
		}
	}
	return false;
}

export function isObjectEscaped(
	state: GameState,
	instanceId?: string,
	stackItem?: StackItem,
	source?: CardInstance
): boolean {
	if (stackItem) {
		if (stackItem.kind === 'spell') return Boolean(stackItem.spellMods?.escaped);
		if (stackItem.sourceEscaped !== undefined) return stackItem.sourceEscaped;
	}
	if (source?.escaped !== undefined) return Boolean(source.escaped);
	if (instanceId) {
		for (const p of state.players) {
			const perm = p.battlefield.find((c) => c.instanceId === instanceId);
			if (perm) return Boolean(perm.escaped);
		}
		const stackSpell = state.stack.find((s) => s.sourceInstanceId === instanceId);
		if (stackSpell) {
			if (stackSpell.kind === 'spell') return Boolean(stackSpell.spellMods?.escaped);
			if (stackSpell.sourceEscaped !== undefined) return stackSpell.sourceEscaped;
		}
	}
	return false;
}

// --- Track P3 ---
export function hasChooseAllModesOptionalCost(
	option: Partial<Pick<CastOption, 'optionalAdditionalCosts'>> | undefined,
	optionalCostCounts?: Record<string, number>
): boolean {
	if (!option?.optionalAdditionalCosts || !optionalCostCounts) return false;
	return option.optionalAdditionalCosts.some(
		(opt) => Boolean(opt.chooseAllModes) && (optionalCostCounts[opt.id] ?? 0) > 0
	);
}

export function isObjectForetold(
	state: GameState,
	instanceId?: string,
	stackItem?: StackItem,
	source?: CardInstance
): boolean {
	if (stackItem) {
		if (stackItem.kind === 'spell') return Boolean(stackItem.spellMods?.foretold);
		if (stackItem.sourceForetold !== undefined) return stackItem.sourceForetold;
	}
	if (source?.foretold !== undefined) return Boolean(source.foretold);
	if (instanceId) {
		for (const p of state.players) {
			const perm = p.battlefield.find((c) => c.instanceId === instanceId);
			if (perm) return Boolean(perm.foretold);
		}
		const stackSpell = state.stack.find((s) => s.sourceInstanceId === instanceId);
		if (stackSpell) {
			if (stackSpell.kind === 'spell') return Boolean(stackSpell.spellMods?.foretold);
			if (stackSpell.sourceForetold !== undefined) return stackSpell.sourceForetold;
		}
	}
	return false;
}

export function isObjectBlitzed(
	state: GameState,
	instanceId?: string,
	stackItem?: StackItem,
	source?: CardInstance
): boolean {
	if (stackItem) {
		if (stackItem.kind === 'spell') return Boolean(stackItem.spellMods?.blitzed);
		if (stackItem.sourceBlitzed !== undefined) return stackItem.sourceBlitzed;
	}
	if (source?.blitzed !== undefined) return Boolean(source.blitzed);
	if (instanceId) {
		for (const p of state.players) {
			const perm = p.battlefield.find((c) => c.instanceId === instanceId);
			if (perm) return Boolean(perm.blitzed);
		}
		const stackSpell = state.stack.find((s) => s.sourceInstanceId === instanceId);
		if (stackSpell) {
			if (stackSpell.kind === 'spell') return Boolean(stackSpell.spellMods?.blitzed);
			if (stackSpell.sourceBlitzed !== undefined) return stackSpell.sourceBlitzed;
		}
	}
	return false;
}
