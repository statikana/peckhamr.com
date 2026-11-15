/**
 * Mana pool arithmetic and spending restrictions (CR 106.6).
 * Pure runtime helpers operating on ManaPool, ManaRestriction, and ManaSpendContext with no rules-text reads.
 */
import type { ManaRestriction } from '../ir.ts';
import {
	createEmptyManaPool,
	deductManaFromPool,
	getTotalManaInPool,
	resolveFlexibleManaRequirement,
	type ManaCostRequirement
} from '../oracle.ts';
import type { ManaColor, ManaPool, ManaSpendContext, PlayerGameState } from '../types.ts';

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

/** Adds `amount` of `color` mana to `player`, routing restricted mana to its restriction bucket. */
export function addManaToPlayerPool(
	player: PlayerGameState,
	color: ManaColor,
	amount: number,
	restriction?: ManaRestriction
): void {
	if (amount <= 0) return;
	if (!restriction) {
		player.manaPool[color] += amount;
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
	if (!player.restrictedMana) return total;
	for (const [key, pool] of Object.entries(player.restrictedMana) as Array<[ManaRestriction, ManaPool | undefined]>) {
		if (!pool || !canSpendRestrictedMana(key, spendCtx)) continue;
		for (const c of ALL_MANA_COLORS) total[c] += pool[c];
	}
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

	const spentColors: ManaColor[] = [];
	for (const c of FIVE_COLORS) {
		let spent = beforePool[c] - player.manaPool[c];
		if (player.restrictedMana) {
			for (const [key, pool] of Object.entries(player.restrictedMana) as Array<[ManaRestriction, ManaPool | undefined]>) {
				if (pool && beforeRestricted[key]) {
					spent += beforeRestricted[key][c] - pool[c];
				}
			}
		}
		if (spent > 0) {
			spentColors.push(c);
		}
	}
	if (spendCtx) {
		spendCtx.capturedColorsSpent = spentColors;
	}
	return spentColors;
}
