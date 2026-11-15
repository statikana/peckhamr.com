/**
 * Mana pool arithmetic and spending restrictions (CR 106.6).
 * Pure runtime helpers operating on ManaPool, ManaRestriction, and ManaSpendContext with no rules-text reads.
 */
import type { ManaRestriction } from '../ir.ts';
// --- Track P10 ---
import { compileCard } from '../compiler/index.ts';
import {
	createEmptyManaPool,
	deductManaFromPool,
	getTotalManaInPool,
	parseManaCost,
	resolveFlexibleManaRequirement,
	type ManaCostRequirement
} from '../oracle.ts';
import type {
	ManaColor,
	ManaPool,
	ManaSpendContext,
	ManaSpendingRestrictionSpec,
	PlainManaObjectFilter,
	PlayerGameState
} from '../types.ts';
// --- End Track P10 ---

const ALL_MANA_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/** Whether mana with `restriction` can be spent for `spendCtx` (CR 106.6). */
export function canSpendRestrictedMana(
	restriction: ManaRestriction,
	spendCtx?: ManaSpendContext
): boolean {
	if (restriction === 'artifactSpellOrNonSpell') {
		return !spendCtx?.isSpell || Boolean(spendCtx.isArtifactSpell);
	}
	return true;
}

// --- Track P10 ---
export interface AddManaOptions {
	restrictionSpec?: ManaSpendingRestrictionSpec;
	retainUntilEndOfTurn?: boolean;
}

interface ManaFilterTargetChars {
	types: string[];
	subtypes: string[];
	supertypes: string[];
	colors: ManaColor[];
	cmc: number;
	hasX: boolean;
	keywords: string[];
	zone?: string;
}

function equalsIgnoreCase(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function matchesPlainManaFilter(
	filter: PlainManaObjectFilter | undefined,
	chars: ManaFilterTargetChars,
	chosenSubType?: string
): boolean {
	if (!filter) return true;
	if (filter.types && filter.types.length > 0) {
		if (!filter.types.some((t) => chars.types.some((ct) => equalsIgnoreCase(ct, t)))) return false;
	}
	if (filter.allTypes && filter.allTypes.length > 0) {
		if (!filter.allTypes.every((t) => chars.types.some((ct) => equalsIgnoreCase(ct, t)))) return false;
	}
	if (filter.notTypes && filter.notTypes.length > 0) {
		if (filter.notTypes.some((t) => chars.types.some((ct) => equalsIgnoreCase(ct, t)))) return false;
	}
	if (filter.supertypes && filter.supertypes.length > 0) {
		if (!filter.supertypes.some((s) => chars.supertypes.some((cs) => equalsIgnoreCase(cs, s)))) return false;
	}
	if (filter.notSupertypes && filter.notSupertypes.length > 0) {
		if (filter.notSupertypes.some((s) => chars.supertypes.some((cs) => equalsIgnoreCase(cs, s)))) return false;
	}
	const hasChangeling = chars.keywords.some((k) => equalsIgnoreCase(k, 'changeling'));
	if (filter.subtypes && filter.subtypes.length > 0) {
		const matched = filter.subtypes.some((s) => chars.subtypes.some((cs) => equalsIgnoreCase(cs, s)));
		if (!matched && !(hasChangeling && chars.types.some((t) => equalsIgnoreCase(t, 'Creature') || equalsIgnoreCase(t, 'Kindred')))) {
			return false;
		}
	}
	if (filter.ofChosenType) {
		if (!chosenSubType) return false;
		const matched = chars.subtypes.some((cs) => equalsIgnoreCase(cs, chosenSubType));
		if (!matched && !hasChangeling) return false;
	}
	if (filter.colors && filter.colors.length > 0) {
		const wantsColorless = filter.colors.includes('C');
		const ok =
			(wantsColorless && chars.colors.length === 0) ||
			filter.colors.some((c) => c !== 'C' && chars.colors.includes(c));
		if (!ok) return false;
	}
	if (filter.notColors && filter.notColors.length > 0) {
		if (filter.notColors.some((c) => chars.colors.includes(c))) return false;
	}
	if (filter.multicolored && chars.colors.length < 2) return false;
	if (filter.monocolored && chars.colors.length !== 1) return false;
	if (filter.colorless && chars.colors.length > 0) return false;
	if (filter.minManaValue !== undefined && chars.cmc < filter.minManaValue) return false;
	if (filter.maxManaValue !== undefined && chars.cmc > filter.maxManaValue) return false;
	if (filter.hasKeywords && filter.hasKeywords.length > 0) {
		if (!filter.hasKeywords.some((kw) => chars.keywords.some((ck) => equalsIgnoreCase(ck, kw)))) {
			return false;
		}
	}
	if (filter.castFromZone && chars.zone !== filter.castFromZone) return false;
	return true;
}

function extractSpellChars(spendCtx: ManaSpendContext): ManaFilterTargetChars {
	if (!spendCtx.spellCard) {
		return {
			types: spendCtx.isArtifactSpell ? ['Artifact'] : [],
			subtypes: [],
			supertypes: [],
			colors: [],
			cmc: 0,
			hasX: Boolean(spendCtx.spellHasXInCost),
			keywords: [],
			zone: spendCtx.spellSourceZone
		};
	}
	const def = compileCard(spendCtx.spellCard);
	const faceIndices = spendCtx.spellFused ? [0, 1] : [spendCtx.spellFaceIndex ?? 0];
	const types = new Set<string>();
	const subtypes = new Set<string>();
	const supertypes = new Set<string>();
	const colors = new Set<ManaColor>();
	const keywords = new Set<string>(spendCtx.spellCard.keywords ?? []);
	let cmc = 0;
	let hasX = Boolean(spendCtx.spellHasXInCost);
	for (const fi of faceIndices) {
		const face = def.faces[fi];
		if (!face) continue;
		for (const t of face.characteristics.types) types.add(t);
		for (const st of face.characteristics.subtypes) subtypes.add(st);
		for (const sp of face.characteristics.supertypes) supertypes.add(sp);
		for (const c of face.characteristics.colors) colors.add(c);
		const parsedCost = parseManaCost(face.characteristics.manaCost ?? '');
		cmc += parsedCost.totalCmc;
		if (parsedCost.hasX) hasX = true;
		for (const ab of face.abilities) {
			if (ab.kind === 'keyword') keywords.add(ab.keyword.name);
		}
	}
	return {
		types: [...types],
		subtypes: [...subtypes],
		supertypes: [...supertypes],
		colors: [...colors],
		cmc,
		hasX,
		keywords: [...keywords],
		zone: spendCtx.spellSourceZone
	};
}

function extractAbilitySourceChars(spendCtx: ManaSpendContext): ManaFilterTargetChars {
	if (!spendCtx.abilitySourceCard) {
		return {
			types: spendCtx.abilitySourceTypes ?? [],
			subtypes: spendCtx.abilitySourceSubtypes ?? [],
			supertypes: [],
			colors: spendCtx.abilitySourceColors ?? [],
			cmc: 0,
			hasX: false,
			keywords: []
		};
	}
	const def = compileCard(spendCtx.abilitySourceCard);
	const face = def.faces[spendCtx.abilitySourceFaceIndex ?? 0] ?? def.faces[0];
	const parsedCost = parseManaCost(face?.characteristics.manaCost ?? '');
	const keywords = new Set<string>(spendCtx.abilitySourceCard.keywords ?? []);
	for (const ab of face?.abilities ?? []) {
		if (ab.kind === 'keyword') keywords.add(ab.keyword.name);
	}
	return {
		types: spendCtx.abilitySourceTypes ?? face?.characteristics.types ?? [],
		subtypes: spendCtx.abilitySourceSubtypes ?? face?.characteristics.subtypes ?? [],
		supertypes: face?.characteristics.supertypes ?? [],
		colors: spendCtx.abilitySourceColors ?? face?.characteristics.colors ?? [],
		cmc: parsedCost.totalCmc,
		hasX: parsedCost.hasX,
		keywords: [...keywords]
	};
}

/** Generalized spending restriction check (CR 106.6). */
export function canSpendManaRestrictionSpec(
	spec: ManaSpendingRestrictionSpec,
	spendCtx?: ManaSpendContext
): boolean {
	if (!spendCtx) return false;
	const chosenSubType = spec.sourceChosenSubType ?? spendCtx.sourceChosenSubType;
	if (spendCtx.isSpell) {
		const allow = spec.allowSpells;
		if (!allow) return false;
		const chars = extractSpellChars(spendCtx);
		const primaryMatch =
			matchesPlainManaFilter(allow.filter, chars, chosenSubType) &&
			(!allow.hasXInCost || chars.hasX) &&
			(!allow.withoutXInCost || !chars.hasX) &&
			(!allow.isCommander || Boolean(spendCtx.isCommanderSpell));
		if (primaryMatch) return true;
		if (allow.altFilter !== undefined || allow.altHasXInCost !== undefined) {
			return (
				matchesPlainManaFilter(allow.altFilter, chars, chosenSubType) &&
				(!allow.altHasXInCost || chars.hasX)
			);
		}
		return false;
	}
	if (spendCtx.isActivatedAbility) {
		const allow = spec.allowAbilities;
		if (!allow) return false;
		if (allow.anyAbility) return true;
		if (!allow.sourceFilter) return false;
		const chars = extractAbilitySourceChars(spendCtx);
		return matchesPlainManaFilter(allow.sourceFilter, chars, chosenSubType);
	}
	if (spendCtx.isForetellAction) {
		return Boolean(spec.allowAbilities?.foretell);
	}
	return false;
}
// --- End Track P10 ---

/** Adds `amount` of `color` mana to `player`, routing restricted mana to its restriction bucket. */
export function addManaToPlayerPool(
	player: PlayerGameState,
	color: ManaColor,
	amount: number,
	restriction?: ManaRestriction,
	// --- Track P10 ---
	opts?: AddManaOptions
	// --- End Track P10 ---
): void {
	if (amount <= 0) return;
	// --- Track P10 ---
	if (opts?.restrictionSpec) {
		const retain = Boolean(opts.retainUntilEndOfTurn);
		const key = JSON.stringify({ spec: opts.restrictionSpec, retain });
		player.restrictedManaBuckets ??= [];
		let bucket = player.restrictedManaBuckets.find((b) => b.key === key);
		if (!bucket) {
			bucket = {
				key,
				spec: opts.restrictionSpec,
				pool: createEmptyManaPool(),
				...(retain ? { retainUntilEndOfTurn: true } : {})
			};
			player.restrictedManaBuckets.push(bucket);
		}
		bucket.pool[color] += amount;
		return;
	}
	// --- End Track P10 ---
	if (!restriction) {
		player.manaPool[color] += amount;
		// --- Track P10 ---
		if (opts?.retainUntilEndOfTurn) {
			player.retainedManaCounts ??= {};
			player.retainedManaCounts[color] = (player.retainedManaCounts[color] ?? 0) + amount;
		}
		// --- End Track P10 ---
		return;
	}
	player.restrictedMana ??= {};
	const bucket = (player.restrictedMana[restriction] ??= createEmptyManaPool());
	bucket[color] += amount;
}

/** Combined pool of unrestricted mana plus all restricted mana eligible for `spendCtx`. */
export function combinedManaPoolForSpend(
	player: PlayerGameState,
	spendCtx?: ManaSpendContext
): ManaPool {
	const total: ManaPool = { ...player.manaPool };
	if (player.restrictedMana) {
		for (const [key, pool] of Object.entries(player.restrictedMana) as Array<[ManaRestriction, ManaPool | undefined]>) {
			if (!pool || !canSpendRestrictedMana(key, spendCtx)) continue;
			for (const c of ALL_MANA_COLORS) total[c] += pool[c];
		}
	}
	// --- Track P10 ---
	if (player.restrictedManaBuckets) {
		for (const bucket of player.restrictedManaBuckets) {
			if (!canSpendManaRestrictionSpec(bucket.spec, spendCtx)) continue;
			for (const c of ALL_MANA_COLORS) total[c] += bucket.pool[c];
		}
	}
	// --- End Track P10 ---
	return total;
}

/** Total pooled mana (unrestricted + eligible restricted) usable for `spendCtx`. */
export function getTotalPooledManaForContext(
	player: PlayerGameState,
	spendCtx?: ManaSpendContext
): number {
	return getTotalManaInPool(combinedManaPoolForSpend(player, spendCtx));
}

function spendGenericFromRestrictedPool(pool: ManaPool, remGeneric: number): number {
	if (remGeneric > 0 && pool.C > 0) {
		const take = Math.min(pool.C, remGeneric);
		pool.C -= take;
		remGeneric -= take;
	}
	const colorOrder: ManaColor[] = ['G', 'R', 'B', 'U', 'W'];
	while (remGeneric > 0) {
		let bestColor: ManaColor | null = null;
		let bestAmt = 0;
		for (const c of colorOrder) {
			if (pool[c] > bestAmt) {
				bestAmt = pool[c];
				bestColor = c;
			}
		}
		if (!bestColor || bestAmt <= 0) break;
		pool[bestColor] -= 1;
		remGeneric -= 1;
	}
	return remGeneric;
}

const FIVE_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * Deducts `req` from `player`, preferring eligible restricted mana first so unrestricted mana
 * remains available for nonartifact spells. Returns the distinct colors of mana spent (CR 105.4).
 */
export function deductManaForSpendContext(
	player: PlayerGameState,
	req: ManaCostRequirement,
	spendCtx?: ManaSpendContext,
	onPayLife?: (life: number) => void
): ManaColor[] {
	const beforePool = { ...player.manaPool };
	const beforeRestricted: Record<string, ManaPool> = {};
	if (player.restrictedMana) {
		for (const [key, pool] of Object.entries(player.restrictedMana) as Array<[ManaRestriction, ManaPool | undefined]>) {
			if (pool) beforeRestricted[key] = { ...pool };
		}
	}
	// --- Track P10 ---
	const beforeBuckets: Record<string, ManaPool> = {};
	if (player.restrictedManaBuckets) {
		for (const bucket of player.restrictedManaBuckets) {
			beforeBuckets[bucket.key] = { ...bucket.pool };
		}
	}
	// --- End Track P10 ---
	const combined = combinedManaPoolForSpend(player, spendCtx);
	const resolved = resolveFlexibleManaRequirement(combined, req);
	if (resolved.lifePaid > 0 && onPayLife) {
		onPayLife(resolved.lifePaid);
	}
	const eligiblePools: ManaPool[] = [];
	if (player.restrictedMana) {
		for (const [key, pool] of Object.entries(player.restrictedMana) as Array<[ManaRestriction, ManaPool | undefined]>) {
			if (pool && canSpendRestrictedMana(key, spendCtx)) eligiblePools.push(pool);
		}
	}
	// --- Track P10 ---
	if (player.restrictedManaBuckets) {
		for (const bucket of player.restrictedManaBuckets) {
			if (canSpendManaRestrictionSpec(bucket.spec, spendCtx)) eligiblePools.push(bucket.pool);
		}
	}
	// --- End Track P10 ---
	for (const c of ALL_MANA_COLORS) {
		let need = resolved.colored[c];
		for (const rp of eligiblePools) {
			if (need <= 0) break;
			const take = Math.min(rp[c], need);
			rp[c] -= take;
			need -= take;
		}
		if (need > 0) {
			player.manaPool[c] = Math.max(0, player.manaPool[c] - need);
		}
	}
	let remGeneric = resolved.generic;
	for (const rp of eligiblePools) {
		if (remGeneric <= 0) break;
		remGeneric = spendGenericFromRestrictedPool(rp, remGeneric);
	}
	if (remGeneric > 0) {
		player.manaPool = deductManaFromPool(player.manaPool, {
			colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
			generic: remGeneric,
			hasX: false,
			xCount: 0,
			totalCmc: remGeneric
		});
	}
	// --- Track P10 ---
	if (player.retainedManaCounts) {
		for (const c of ALL_MANA_COLORS) {
			const prev = player.retainedManaCounts[c];
			if (prev !== undefined) {
				player.retainedManaCounts[c] = Math.min(player.manaPool[c], prev);
			}
		}
	}
	if (player.restrictedManaBuckets) {
		player.restrictedManaBuckets = player.restrictedManaBuckets.filter(
			(b) => getTotalManaInPool(b.pool) > 0
		);
		if (player.restrictedManaBuckets.length === 0) {
			delete player.restrictedManaBuckets;
		}
	}
	// --- End Track P10 ---

	const spentColors: ManaColor[] = [];
	// --- Track P13 ---
	const spentColorsAll: ManaColor[] = [];
	// --- End Track P13 ---
	// --- Track P10 ---
	let totalManaSpent = 0;
	for (const c of ALL_MANA_COLORS) {
		let spent = Math.max(0, beforePool[c] - player.manaPool[c]);
		if (player.restrictedMana) {
			for (const [key, pool] of Object.entries(player.restrictedMana) as Array<[ManaRestriction, ManaPool | undefined]>) {
				if (pool && beforeRestricted[key]) {
					spent += Math.max(0, beforeRestricted[key][c] - pool[c]);
				}
			}
		}
		for (const [key, bBefore] of Object.entries(beforeBuckets)) {
			const cur = player.restrictedManaBuckets?.find((b) => b.key === key)?.pool;
			spent += Math.max(0, bBefore[c] - (cur ? cur[c] : 0));
		}
		totalManaSpent += spent;
		if (FIVE_COLORS.includes(c) && spent > 0) {
			spentColors.push(c);
			// --- Track P13 ---
			for (let k = 0; k < spent; k++) spentColorsAll.push(c);
			// --- End Track P13 ---
		}
	}
	// --- End Track P10 ---
	if (spendCtx) {
		spendCtx.capturedColorsSpent = spentColors;
		// --- Track P13 ---
		spendCtx.capturedColorsAllSpent = spentColorsAll;
		// --- End Track P13 ---
		// --- Track P10 ---
		spendCtx.capturedManaSpentCount = totalManaSpent;
		// --- End Track P10 ---
	}
	return spentColors;
}

// --- Track P10 ---
/**
 * CR 106.4: Empties unspent mana as a step or phase ends, preserving mana whose loss is prevented
 * until end of turn (`retainedManaCounts`, `unemptiedManaColorsThisTurn`, `retainUntilEndOfTurn`).
 */
export function emptyPlayerManaPoolForStepEnd(player: PlayerGameState): void {
	const unemptied = new Set<ManaColor>(
		player.unemptiedManaColorsThisTurn === 'all'
			? ALL_MANA_COLORS
			: (player.unemptiedManaColorsThisTurn ?? [])
	);
	for (const c of ALL_MANA_COLORS) {
		if (unemptied.has(c)) continue;
		const retained = Math.min(player.manaPool[c], player.retainedManaCounts?.[c] ?? 0);
		player.manaPool[c] = retained;
		if (player.retainedManaCounts && player.retainedManaCounts[c] !== undefined) {
			player.retainedManaCounts[c] = retained;
		}
	}
	if (player.restrictedMana) {
		if (unemptied.size === 0) {
			delete player.restrictedMana;
		} else {
			for (const pool of Object.values(player.restrictedMana)) {
				if (!pool) continue;
				for (const c of ALL_MANA_COLORS) {
					if (!unemptied.has(c)) pool[c] = 0;
				}
			}
		}
	}
	if (player.restrictedManaBuckets) {
		for (const b of player.restrictedManaBuckets) {
			if (b.retainUntilEndOfTurn) continue;
			for (const c of ALL_MANA_COLORS) {
				if (!unemptied.has(c)) b.pool[c] = 0;
			}
		}
		player.restrictedManaBuckets = player.restrictedManaBuckets.filter(
			(b) => getTotalManaInPool(b.pool) > 0
		);
		if (player.restrictedManaBuckets.length === 0) {
			delete player.restrictedManaBuckets;
		}
	}
}

/** CR 514.2: Clears all mana, retained counts, and turn-duration unemptied mana effects at cleanup. */
export function clearPlayerManaPoolAtCleanup(player: PlayerGameState): void {
	player.manaPool = createEmptyManaPool();
	delete player.restrictedMana;
	delete player.restrictedManaBuckets;
	delete player.retainedManaCounts;
	delete player.unemptiedManaColorsThisTurn;
}
// --- End Track P10 ---
