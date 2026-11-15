/**
 * Generic optional-additional-cost and kicker-tracking helpers (CR 702.33, 601.2f, 400.7).
 *
 * Shared cleanly between ruleTree, runtime/costs, runtime/objectFilter, runtime/layers,
 * runtime/triggers, runtime/effects, and engine without introducing module cycles.
 */
import { activeAbilityDefs, activeCharacteristics } from './faces.ts';
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
	fused = false,
	prototyped = false
): CastOptionOptionalCost[] {
	const faceOpts = { zone: 'stack' as const, faceIndex, fused, prototyped };
	const abilities = activeAbilityDefs(card, faceOpts);
	const chars = activeCharacteristics(card, faceOpts);
	const out: CastOptionOptionalCost[] = [];
	let idx = 0;
	let buybackIdx = 0;
	let entwineIdx = 0;
	let offspringIdx = 0;
	let squadIdx = 0;
	let replicateIdx = 0;
	let conspireIdx = 0;
	let casualtyIdx = 0;
	// --- Track P12 ---
	let bargainIdx = 0;
	// --- End Track P12 ---
	// --- Track P18a ---
	let teamworkIdx = 0;
	// --- End Track P18a ---
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
		const { name: kwName } = ab.keyword;
		if (kwName === 'offspring' && ab.keyword.costDefs && ab.keyword.costDefs.length > 0) {
			const rawCost = (ab.keyword.cost ?? ab.keyword.param ?? '').trim();
			const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
			out.push({
				id: `offspring:${offspringIdx++}`,
				label: rawCost ? (isManaOnly ? `Offspring (${rawCost})` : `Offspring—${rawCost}`) : 'Offspring',
				costDisplay: rawCost,
				costDefs: ab.keyword.costDefs,
				maxCount: 1,
				kickedTag: 'offspring',
				kickedTags: ['offspring']
			});
			continue;
		}
		if (kwName === 'squad' && ab.keyword.costDefs && ab.keyword.costDefs.length > 0) {
			const rawCost = (ab.keyword.cost ?? ab.keyword.param ?? '').trim();
			const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
			out.push({
				id: `squad:${squadIdx++}`,
				label: rawCost ? (isManaOnly ? `Squad (${rawCost})` : `Squad—${rawCost}`) : 'Squad',
				costDisplay: rawCost,
				costDefs: ab.keyword.costDefs,
				maxCount: 99,
				kickedTag: 'squad',
				kickedTags: ['squad']
			});
			continue;
		}
		if (kwName === 'replicate' && ab.keyword.costDefs && ab.keyword.costDefs.length > 0) {
			const rawCost = (ab.keyword.cost ?? ab.keyword.param ?? '').trim();
			const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
			out.push({
				id: `replicate:${replicateIdx++}`,
				label: rawCost ? (isManaOnly ? `Replicate (${rawCost})` : `Replicate—${rawCost}`) : 'Replicate',
				costDisplay: rawCost,
				costDefs: ab.keyword.costDefs,
				maxCount: 99,
				kickedTag: 'replicate',
				kickedTags: ['replicate']
			});
			continue;
		}
		if (kwName === 'conspire') {
			const spellColors = chars.colors;
			const conspireCostDef: CostDef =
				spellColors.length > 0
					? {
							k: 'tapOthers',
							count: { k: 'const', n: 2 },
							filter: {
								types: ['Creature'],
								controller: 'you',
								tapped: false,
								colors: [...spellColors]
							}
						}
					: {
							k: 'tapOthers',
							count: { k: 'const', n: 2 },
							filter: {
								types: ['Creature'],
								notTypes: ['Creature'],
								controller: 'you',
								tapped: false
							}
						};
			out.push({
				id: `conspire:${conspireIdx++}`,
				label: 'Conspire (Tap two untapped creatures sharing a color)',
				costDisplay: 'Tap two untapped creatures you control that share a color with this spell',
				costDefs: [conspireCostDef],
				maxCount: 1,
				kickedTag: 'conspire',
				kickedTags: ['conspire']
			});
			continue;
		}
		if (kwName === 'casualty' && ab.keyword.n !== undefined && ab.keyword.n > 0) {
			const n = ab.keyword.n;
			out.push({
				id: `casualty:${casualtyIdx++}`,
				label: `Casualty ${n} (Sacrifice a creature with power ${n}+)`,
				costDisplay: `Sacrifice a creature with power ${n} or greater`,
				costDefs: [
					{
						k: 'sacrifice',
						count: { k: 'const', n: 1 },
						filter: {
							types: ['Creature'],
							controller: 'you',
							power: { op: '>=', value: { k: 'const', n } }
						}
					}
				],
				maxCount: 1,
				kickedTag: 'casualty',
				kickedTags: ['casualty']
			});
			continue;
		}
		// --- Track P12 ---
		if (kwName === 'bargain') {
			out.push({
				id: `bargain:${bargainIdx++}`,
				label: 'Bargain (Sacrifice an artifact, enchantment, or token)',
				costDisplay: 'Sacrifice an artifact, enchantment, or token',
				costDefs: [
					{
						k: 'sacrifice',
						count: { k: 'const', n: 1 },
						filter: {
							controller: 'you',
							artifactEnchantmentOrToken: true
						}
					}
				],
				maxCount: 1,
				kickedTag: 'bargain',
				kickedTags: ['bargain']
			});
			continue;
		}
		// --- End Track P12 ---
		// --- Track P18a: Teamwork [N] (CR 702.194a–c) ---
		if (kwName === 'teamwork') {
			const n = Math.max(1, ab.keyword.n ?? 1);
			out.push({
				id: `teamwork:${teamworkIdx++}`,
				label: `Teamwork ${n} (Tap creatures with total power ${n}+)`,
				costDisplay: `Tap any number of untapped creatures you control with total power ${n} or greater`,
				costDefs: [
					{
						k: 'tapSubsetSum',
						minTotal: { k: 'const', n },
						metric: 'power',
						filter: {
							controller: 'you',
							types: ['Creature'],
							tapped: false
						},
						restrictionTag: 'teamwork'
					}
				],
				maxCount: 1,
				kickedTag: 'teamwork',
				kickedTags: ['teamwork']
			});
			continue;
		}
		// --- End Track P18a ---
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
	const resolvedPrototyped = Boolean(option?.spellMods?.prototyped);
	const entries =
		option?.optionalAdditionalCosts ??
		rawOptionalEntriesForCard(card, resolvedFace, resolvedFused, resolvedPrototyped);
	let count = 0;
	const tags: string[] = [];
	const tagCounts: Record<string, number> = {};
	for (const entry of entries) {
		const n = optionalCostCounts?.[entry.id] ?? 0;
		if (n <= 0) continue;
		const isKicker = entry.id.startsWith('kicker:');
		if (isKicker) count += n;
		const entryTags = entry.kickedTags ?? (entry.kickedTag ? [entry.kickedTag] : []);
		if (!isKicker && entryTags.length === 0) continue;
		for (const tag of entryTags) {
			if (!tags.includes(tag)) tags.push(tag);
			tagCounts[tag] = (tagCounts[tag] ?? 0) + n;
		}
	}
	return {
		count,
		tags:
			// --- Track P15 ---
			(optionalCostCounts?.['opt:gift'] ?? 0) > 0 && !tags.includes('gift')
				? [...tags, 'gift']
				: tags,
		tagCounts:
			(optionalCostCounts?.['opt:gift'] ?? 0) > 0 && tagCounts['gift'] === undefined
				? { ...tagCounts, gift: optionalCostCounts!['opt:gift']! }
				: tagCounts,
		// --- End Track P15 ---
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
	return info.tags.includes(cond.tag) && Math.max(1, info.count) >= min;
}

export function evaluateKickedCountAmount(
	amount: Extract<Amount, { k: 'kickedCount' }>,
	info: KickerTrackingInfo
): number {
	const base = amount.tag
		? info.tagCounts
			? (info.tagCounts[amount.tag] ?? 0)
			: info.tags.includes(amount.tag)
				? Math.max(1, info.count)
				: 0
		: info.count;
	return base * (amount.multiplier ?? 1);
}

export function isConditionMetWithKicker(cond: Condition, info: KickerTrackingInfo): boolean {
	if (cond.k === 'kicked') return evaluateKickerCondition(cond, info);
	if (cond.k === 'foretold') return Boolean(info.foretold);
	if (cond.k === 'blitzed') return Boolean(info.blitzed);
	// --- Track P15 ---
	if (cond.k === 'giftPromised') {
		return info.tags.includes('gift') || (info.tagCounts?.['gift'] ?? 0) > 0;
	}
	// --- End Track P15 ---
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
	fused = false,
	prototyped = false
): CastOptionOptionalCost[] {
	const entries = rawOptionalEntriesForCard(card, faceIndex, fused, prototyped);
	if (entries.length === 0) return [];
	const abilities = activeAbilityDefs(card, { zone: 'stack', faceIndex, fused, prototyped });
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
	const optLike: CastOptionLike | undefined = prototyped ? { spellMods: { prototyped: true } } : undefined;
	for (const entry of entries) {
		const enables = conditionalSpecs.some(
			(sp) =>
				sp.condition &&
				!isCastConditionMet(sp.condition, card, undefined, optLike, faceIndex, fused) &&
				isCastConditionMet(sp.condition, card, { [entry.id]: 1 }, optLike, faceIndex, fused)
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
			const spellMods =
				stackItem.spellMods?.prototyped || stackItem.copiableState?.prototyped
					? { ...stackItem.spellMods, prototyped: true }
					: stackItem.spellMods;
			return computeKickerTracking(
				stackItem.card,
				stackItem.optionalCostCounts,
				{ spellMods },
				stackItem.faceIndex ?? 0,
				stackItem.fused ?? false
			);
		}
		if (
			stackItem.sourceKickedCount !== undefined ||
			(stackItem.sourceKickedTags && stackItem.sourceKickedTags.length > 0) ||
			stackItem.sourceKickedTagCounts !== undefined ||
			stackItem.sourceForetold !== undefined ||
			stackItem.sourceBlitzed !== undefined ||
			// --- Track P15 ---
			stackItem.sourceGiftPromised !== undefined
			// --- End Track P15 ---
		) {
			const baseTags = stackItem.sourceKickedTags ?? [];
			const tags =
				stackItem.sourceGiftPromised && !baseTags.includes('gift')
					? [...baseTags, 'gift']
					: baseTags;
			return {
				count: stackItem.sourceKickedCount ?? 0,
				tags,
				...(stackItem.sourceKickedTagCounts ? { tagCounts: stackItem.sourceKickedTagCounts } : {}),
				...(stackItem.sourceForetold ? { foretold: true } : {}),
				...(stackItem.sourceBlitzed ? { blitzed: true } : {})
			};
		}
	}
	if (instanceId) {
		for (const p of state.players) {
			const perm: CardInstance | undefined = p.battlefield.find((c) => c.instanceId === instanceId);
			if (perm) {
				const baseTags = perm.kickedTags ?? [];
				const tags =
					perm.giftPromised && !baseTags.includes('gift') ? [...baseTags, 'gift'] : baseTags;
				return {
					count: perm.kickedCount ?? 0,
					tags,
					...(perm.kickedTagCounts ? { tagCounts: perm.kickedTagCounts } : {}),
					...(perm.foretold ? { foretold: true } : {}),
					...(perm.blitzed ? { blitzed: true } : {})
				};
			}
		}
		const stackSpell = state.stack.find((s) => s.sourceInstanceId === instanceId);
		if (stackSpell) {
			if (stackSpell.kind === 'spell') {
				const spellMods =
					stackSpell.spellMods?.prototyped || stackSpell.copiableState?.prototyped
						? { ...stackSpell.spellMods, prototyped: true }
						: stackSpell.spellMods;
				return computeKickerTracking(
					stackSpell.card,
					stackSpell.optionalCostCounts,
					{ spellMods },
					stackSpell.faceIndex ?? 0,
					stackSpell.fused ?? false
				);
			}
			if (
				stackSpell.sourceKickedCount !== undefined ||
				(stackSpell.sourceKickedTags && stackSpell.sourceKickedTags.length > 0) ||
				stackSpell.sourceKickedTagCounts !== undefined ||
				stackSpell.sourceForetold !== undefined ||
				stackSpell.sourceBlitzed !== undefined ||
				// --- Track P15 ---
				stackSpell.sourceGiftPromised !== undefined
				// --- End Track P15 ---
			) {
				const baseTags = stackSpell.sourceKickedTags ?? [];
				const tags =
					stackSpell.sourceGiftPromised && !baseTags.includes('gift')
						? [...baseTags, 'gift']
						: baseTags;
				return {
					count: stackSpell.sourceKickedCount ?? 0,
					tags,
					...(stackSpell.sourceKickedTagCounts ? { tagCounts: stackSpell.sourceKickedTagCounts } : {}),
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
			source.kickedTagCounts !== undefined ||
			source.foretold ||
			source.blitzed ||
			// --- Track P15 ---
			source.giftPromised)
			// --- End Track P15 ---
	) {
		const baseTags = source.kickedTags ?? [];
		const tags = source.giftPromised && !baseTags.includes('gift') ? [...baseTags, 'gift'] : baseTags;
		return {
			count: source.kickedCount ?? 0,
			tags,
			...(source.kickedTagCounts ? { tagCounts: source.kickedTagCounts } : {}),
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
