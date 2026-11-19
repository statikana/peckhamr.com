/**
 * Wave 7 — Track P20b runtime support for variable & multi-permanent counter removal costs
 * (`CR 122.1`), unattach/die-roll/coin-flip activated costs (`CR 701.3d`, `CR 706`), Strive &
 * multi-object sacrifice/discard/exile/reveal costs (`CR 601.2f`, `CR 118.8`), `X` & mana-source
 * spending restrictions (`CR 107.3i`, `CR 106.6`), life-for-colored-mana static optional reductions,
 * Mastery/Trap/pitch-count conditions & amounts (`CR 118.9`), first-activation `{0}` modifiers,
 * and commander tax paid as life (`CR 903.8`).
 */
import type { Amount, Condition, CostDef, ObjectFilter, StaticDef } from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type { ManaCostRequirement } from '../oracle.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CastOptionOptionalCost,
	type CostPayment,
	type CounterType,
	type EffectiveActivatedAbility,
	type FaceDownSpec,
	type GameState,
	type ManaColor,
	type ManaPool,
	type ManaSpendContext,
	type PlayerGameState,
	type SerializedPlannedCost
} from '../types.ts';
import type { CostContext, CostQuestion, PaidCosts } from './costs.ts';
import { deductMatchingCountersWave6, type MatchesFilterFn } from './costsWave6.ts';
import { emitEvent } from './events.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { splitSubtypes } from './layers.ts';
import {
	evaluateAmount,
	evaluateCondition,
	objectManaValue,
	type FilterContext
} from './objectFilter.ts';
import { nextRandom } from './random.ts';
import { playerLifeTotalCantChange } from './replace.ts';
import {
	boardMayGrantStaticAbility,
	collectActiveGrantedStaticDefs
} from './staticsDynamicAndCosts.ts';
import { markHandCardRevealedToAll } from './staticsLayersAndRestrictions.ts';
import { moveObject, type MoveResult, type PlayerZone } from './zones.ts';

const P20B_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
const P20B_FIVE_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

function findBattlefieldPerm(state: GameState, id: string): CardInstance | undefined {
	for (const p of state.players) {
		for (const b of p.battlefield) {
			if (!b.phasedOut && b.instanceId === id) return b;
		}
	}
	return undefined;
}

export function totalMatchingCountersP20b(
	perm: CardInstance,
	counter?: CounterType | 'any'
): number {
	const map = perm.counters ?? ({} as Record<string, number>);
	if (counter && counter !== 'any') return map[counter] ?? 0;
	let total = 0;
	for (const v of Object.values(map)) {
		if (v > 0) total += v;
	}
	return total;
}

function effectiveObjectName(state: GameState, obj: CardInstance): string {
	if (obj.zone === 'battlefield') {
		return evaluatePermanent(state, obj).effectiveName;
	}
	if (obj.isFaceDown) return '';
	const card = effectiveCardForObject(obj);
	return resolveObjectFaces(card, instanceFaceOptions(obj, obj.zone)).name;
}

function effectiveObjectColors(state: GameState, obj: CardInstance): ManaColor[] {
	if (obj.zone === 'battlefield') {
		return evaluatePermanent(state, obj).colors;
	}
	if (obj.isFaceDown) return [];
	const card = effectiveCardForObject(obj);
	return resolveObjectFaces(card, instanceFaceOptions(obj, obj.zone)).colors;
}

function filterSummary(filter: ObjectFilter | 'self'): string {
	if (filter === 'self') return 'this';
	if (filter.subtypes?.length) return filter.subtypes.join(' or ');
	if (filter.types?.length) return filter.types.join(' or ').toLowerCase();
	return 'permanent';
}

export function describeP20bCost(d: CostDef): string | null {
	switch (d.k) {
		case 'unattachSelf':
			return 'Unattach this';
		case 'unattachOther':
			return `Unattach ${d.fromSelf ? `an attached ${filterSummary(d.filter)} from this` : `a ${filterSummary(d.filter)}`}`;
		case 'rollDie':
			return `Roll a d${d.sides}`;
		case 'flipCoin':
			return 'Flip a coin';
		case 'behold':
			if (d.exile) {
				const sub = d.filter.subtypes?.[0] ?? d.filter.types?.[0] ?? 'card';
				return `Behold a ${sub} and exile it`;
			}
			return null;
		case 'removeCounters':
			if (d.among && !d.removeAll) {
				const cLabel = d.counter && d.counter !== 'any' ? `${d.counter} ` : '';
				if (d.count.k === 'anyNumber') {
					return `Remove any number of ${cLabel}counters`;
				}
				const num = d.count.k === 'const' ? d.count.n : d.oneOrMore ? 'one or more' : 'X';
				return `Remove ${num} ${cLabel}counter${num === 1 ? '' : 's'} from among permanents`;
			}
			if (d.from === 'self' && (d.oneOrMore || d.count.k === 'anyNumber')) {
				const cLabel = d.counter && d.counter !== 'any' ? `${d.counter} ` : '';
				return d.oneOrMore
					? `Remove one or more ${cLabel}counters`
					: `Remove any number of ${cLabel}counters`;
			}
			return null;
		default:
			return null;
	}
}

export function checkSimpleP20bCost(
	def: CostDef,
	ctx: CostContext,
	matchesFilter: MatchesFilterFn
): { handled: boolean; error: string | null } {
	const src = ctx.source;
	switch (def.k) {
		case 'unattachSelf': {
			if (ctx.isSpell || src.zone !== 'battlefield' || src.phasedOut) {
				return { handled: true, error: 'Source must be on the battlefield to unattach.' };
			}
			const host = src.attachedToId ? findBattlefieldPerm(ctx.state, src.attachedToId) : undefined;
			if (!host) {
				return { handled: true, error: 'Source is not currently attached to a permanent (CR 701.3d).' };
			}
			return { handled: true, error: null };
		}
		case 'unattachOther': {
			const fctx: FilterContext = {
				state: ctx.state,
				controllerId: ctx.player.playerId,
				source: src,
				xValue: ctx.xValue
			};
			const needed = def.count.k === 'const' ? def.count.n : 1;
			let count = 0;
			for (const p of ctx.state.players) {
				for (const b of p.battlefield) {
					if (b.phasedOut || !b.attachedToId) continue;
					if (def.fromSelf && b.attachedToId !== src.instanceId) continue;
					if (!findBattlefieldPerm(ctx.state, b.attachedToId)) continue;
					if (matchesFilter(b, def.filter, fctx)) count += 1;
				}
			}
			return {
				handled: true,
				error: count >= needed ? null : 'Not enough attached permanents to unattach.'
			};
		}
		case 'rollDie':
		case 'flipCoin':
			return { handled: true, error: null };
		case 'removeCounters': {
			if (def.removeAll) return { handled: false, error: null };
			if (def.from === 'self' && (def.oneOrMore || def.count.k === 'anyNumber')) {
				if (!ctx.isSpell && src.zone !== 'battlefield') {
					return { handled: true, error: 'Source must be on the battlefield to remove counters.' };
				}
				const avail = totalMatchingCountersP20b(src, def.counter);
				if (def.oneOrMore && avail < 1) {
					return { handled: true, error: 'Source needs at least 1 matching counter.' };
				}
				return { handled: true, error: null };
			}
			if (def.among && def.from !== 'self') {
				const fctx: FilterContext = {
					state: ctx.state,
					controllerId: ctx.player.playerId,
					source: src,
					xValue: ctx.xValue
				};
				const minNeeded =
					def.count.k === 'anyNumber'
						? 0
						: def.oneOrMore
							? 1
							: def.count.k === 'const'
								? def.count.n
								: def.count.k === 'x'
									? ctx.xValue
									: 1;
				let totalAvail = 0;
				for (const b of ctx.player.battlefield) {
					if (b.phasedOut) continue;
					if (!matchesFilter(b, def.from, fctx)) continue;
					totalAvail += totalMatchingCountersP20b(b, def.counter);
				}
				return {
					handled: true,
					error: totalAvail >= minNeeded ? null : 'Not enough counters among permanents.'
				};
			}
			return { handled: false, error: null };
		}
		case 'exileFrom': {
			if (def.andOtherSameNameCount !== undefined) {
				if (src.zone !== def.zone) {
					return { handled: true, error: `Source is not in ${def.zone}.` };
				}
				const zoneArr =
					def.zone === 'hand'
						? ctx.player.hand
						: def.zone === 'graveyard'
							? ctx.player.graveyard
							: def.zone === 'library'
								? ctx.player.library
								: ctx.player.battlefield;
				const selfName = effectiveObjectName(ctx.state, src);
				const others = zoneArr.filter(
					(c) => c.instanceId !== src.instanceId && effectiveObjectName(ctx.state, c) === selfName
				);
				return {
					handled: true,
					error:
						others.length >= def.andOtherSameNameCount
							? null
							: 'Not enough other cards with the same name.'
				};
			}
			return { handled: false, error: null };
		}
		default:
			return { handled: false, error: null };
	}
}

export function p20bObjectCandidates(
	def: CostDef,
	ctx: CostContext,
	used: Set<string>,
	matchesFilter: MatchesFilterFn
): { handled: boolean; candidates: CardInstance[] | null } {
	const fctx: FilterContext = {
		state: ctx.state,
		controllerId: ctx.player.playerId,
		source: ctx.source,
		xValue: ctx.xValue
	};
	switch (def.k) {
		case 'unattachOther': {
			const out: CardInstance[] = [];
			for (const p of ctx.state.players) {
				for (const b of p.battlefield) {
					if (b.phasedOut || used.has(b.instanceId) || !b.attachedToId) continue;
					if (def.fromSelf && b.attachedToId !== ctx.source.instanceId) continue;
					if (!findBattlefieldPerm(ctx.state, b.attachedToId)) continue;
					if (matchesFilter(b, def.filter, fctx)) out.push(b);
				}
			}
			return { handled: true, candidates: out };
		}
		case 'removeCounters': {
			if (def.removeAll) return { handled: false, candidates: null };
			if (def.from === 'self') return { handled: false, candidates: null };
			const fromFilter = def.from;
			if (def.among || def.oneOrMore || def.count.k === 'anyNumber') {
				const out = ctx.player.battlefield.filter(
					(c) =>
						!c.phasedOut &&
						matchesFilter(c, fromFilter, fctx) &&
						totalMatchingCountersP20b(c, def.counter) > 0
				);
				return { handled: true, candidates: out };
			}
			return { handled: false, candidates: null };
		}
		case 'exileFrom': {
			if (def.andOtherSameNameCount !== undefined) {
				const zoneArr =
					def.zone === 'hand'
						? ctx.player.hand
						: def.zone === 'graveyard'
							? ctx.player.graveyard
							: def.zone === 'library'
								? ctx.player.library
								: ctx.player.battlefield;
				const selfName = effectiveObjectName(ctx.state, ctx.source);
				const out = zoneArr.filter(
					(c) =>
						c.instanceId !== ctx.source.instanceId &&
						!used.has(c.instanceId) &&
						effectiveObjectName(ctx.state, c) === selfName
				);
				return { handled: true, candidates: out };
			}
			return { handled: false, candidates: null };
		}
		default:
			return { handled: false, candidates: null };
	}
}

export type P20bSelfCounterPlanResult =
	| { handled: false }
	| {
			handled: true;
			result:
				| { ok: false; error: string }
				| { ok: true; question: CostQuestion }
				| { ok: true; counterCount: number; nextOptionIndex: number };
	  };

export function planP20bSelfCounterPart(
	def: CostDef,
	ctx: CostContext,
	payment: CostPayment | undefined,
	optionIndex: number,
	autoPickGreedy: boolean
): P20bSelfCounterPlanResult {
	if (def.k !== 'removeCounters' || def.from !== 'self' || def.removeAll) {
		return { handled: false };
	}
	const isVar = Boolean(def.oneOrMore) || def.count.k === 'anyNumber';
	if (!isVar) {
		const exact =
			def.count.k === 'const' ? def.count.n : def.count.k === 'x' ? ctx.xValue : undefined;
		if (exact !== undefined) {
			return {
				handled: true,
				result: { ok: true, counterCount: Math.max(0, exact), nextOptionIndex: optionIndex }
			};
		}
		return { handled: false };
	}

	const min = def.oneOrMore ? 1 : 0;
	const avail = totalMatchingCountersP20b(ctx.source, def.counter);
	if (avail < min) {
		return {
			handled: true,
			result: { ok: false, error: 'Not enough counters on source to pay cost.' }
		};
	}

	if (payment?.counterCount !== undefined) {
		const nVal = payment.counterCount;
		if (!Number.isInteger(nVal) || nVal < min || nVal > avail) {
			return {
				handled: true,
				result: {
					ok: false,
					error: `Invalid counter removal count (${nVal}); expected ${min}..${avail}.`
				}
			};
		}
		return {
			handled: true,
			result: { ok: true, counterCount: nVal, nextOptionIndex: optionIndex }
		};
	}

	const answeredOpt = payment?.options?.[optionIndex];
	if (answeredOpt !== undefined) {
		const nVal = min + answeredOpt;
		if (!Number.isInteger(nVal) || nVal < min || nVal > avail) {
			return {
				handled: true,
				result: { ok: false, error: 'Invalid counter removal option.' }
			};
		}
		return {
			handled: true,
			result: { ok: true, counterCount: nVal, nextOptionIndex: optionIndex + 1 }
		};
	}

	if (avail === min) {
		return {
			handled: true,
			result: { ok: true, counterCount: min, nextOptionIndex: optionIndex }
		};
	}

	if (autoPickGreedy) {
		const picked = def.oneOrMore ? 1 : avail;
		return {
			handled: true,
			result: { ok: true, counterCount: picked, nextOptionIndex: optionIndex }
		};
	}

	const cLabel = def.counter && def.counter !== 'any' ? `${def.counter} ` : '';
	const labels: string[] = [];
	for (let k = min; k <= avail; k++) {
		labels.push(`Remove ${k} ${cLabel}counter${k === 1 ? '' : 's'}`);
	}
	return {
		handled: true,
		result: {
			ok: true,
			question: {
				kind: 'option',
				index: optionIndex,
				labels,
				optional: false
			}
		}
	};
}

function hasExactMvSubset(
	candidates: CardInstance[],
	weights: Record<string, number>,
	targetSum: number,
	minCount: number
): string[] | null {
	if (targetSum === 0 && minCount === 0) return [];
	const n = candidates.length;
	let found: string[] | null = null;
	let nodes = 0;
	const cur: string[] = [];
	const dfs = (idx: number, sum: number): void => {
		if (found || nodes++ > 4096) return;
		if (sum === targetSum && cur.length >= minCount) {
			found = [...cur];
			return;
		}
		if (idx >= n || sum > targetSum) return;
		const c = candidates[idx];
		const w = Math.max(0, weights[c.instanceId] ?? 0);
		cur.push(c.instanceId);
		dfs(idx + 1, sum + w);
		cur.pop();
		dfs(idx + 1, sum);
	};
	dfs(0, 0);
	return found;
}

function allDistinctNames(state: GameState, objs: CardInstance[]): boolean {
	const seen = new Set<string>();
	for (const o of objs) {
		const nm = effectiveObjectName(state, o);
		if (!nm || seen.has(nm)) return false;
		seen.add(nm);
	}
	return true;
}

function allShareAtLeastOneColor(state: GameState, objs: CardInstance[]): boolean {
	if (objs.length <= 1) {
		return objs.every((o) => effectiveObjectColors(state, o).some((c) => c !== 'C'));
	}
	for (const col of P20B_FIVE_COLORS) {
		if (objs.every((o) => effectiveObjectColors(state, o).includes(col))) return true;
	}
	return false;
}

export type P20bSpecialPlanResult =
	| { handled: false }
	| {
			handled: true;
			result:
				| { ok: false; error: string }
				| { ok: true; question: CostQuestion }
				| {
						ok: true;
						chosen: CardInstance[];
						nextObjectIndex: number;
						counterCount?: number;
						counterDistribution?: Record<string, number>;
				  };
	  };

export function planP20bSpecialCostPart(
	def: CostDef,
	candidates: CardInstance[],
	ctx: CostContext,
	used: Set<string>,
	objects: string[][] | undefined,
	objectIndex: number,
	payment: CostPayment | undefined,
	describeFn: (d: CostDef) => string
): P20bSpecialPlanResult {
	// 1. Multi-permanent counter removal ("Remove N counters from among ...")
	if (def.k === 'removeCounters' && def.from !== 'self' && !def.removeAll && def.among) {
		const isAny = def.count.k === 'anyNumber';
		const isOneOrMore = Boolean(def.oneOrMore);
		const exactNeeded = isAny
			? undefined
			: isOneOrMore
				? undefined
				: def.count.k === 'const'
					? def.count.n
					: def.count.k === 'x'
						? ctx.xValue
						: 1;
		const minNeeded = isAny ? 0 : isOneOrMore ? 1 : (exactNeeded ?? 1);
		const weights: Record<string, number> = {};
		let totalAvail = 0;
		for (const c of candidates) {
			const w = totalMatchingCountersP20b(c, def.counter);
			weights[c.instanceId] = w;
			totalAvail += w;
		}
		if (totalAvail < minNeeded) {
			return {
				handled: true,
				result: { ok: false, error: `Can't pay the cost: ${describeFn(def)}.` }
			};
		}
		const byId = new Map(candidates.map((c) => [c.instanceId, c]));
		if (payment?.counterDistribution) {
			const dist: Record<string, number> = {};
			const chosen: CardInstance[] = [];
			let sum = 0;
			for (const [id, amt] of Object.entries(payment.counterDistribution)) {
				if (amt <= 0) continue;
				const perm = byId.get(id);
				if (!perm || !Number.isInteger(amt) || amt > (weights[id] ?? 0)) {
					return {
						handled: true,
						result: { ok: false, error: `Illegal counter distribution for: ${describeFn(def)}.` }
					};
				}
				dist[id] = amt;
				chosen.push(perm);
				sum += amt;
			}
			if (sum < minNeeded || (exactNeeded !== undefined && sum !== exactNeeded)) {
				return {
					handled: true,
					result: {
						ok: false,
						error: `Selected ${sum} counters; required ${exactNeeded ?? `at least ${minNeeded}`}.`
					}
				};
			}
			return {
				handled: true,
				result: {
					ok: true,
					chosen,
					nextObjectIndex: objectIndex,
					counterCount: sum,
					counterDistribution: dist
				}
			};
		}

		if (minNeeded === 0 && exactNeeded === 0) {
			return {
				handled: true,
				result: {
					ok: true,
					chosen: [],
					nextObjectIndex: objectIndex,
					counterCount: 0,
					counterDistribution: {}
				}
			};
		}

		const index = objectIndex;
		const chosenIds = objects?.[index];
		let chosen: CardInstance[] | undefined;
		if (chosenIds !== undefined) {
			if (new Set(chosenIds).size !== chosenIds.length || chosenIds.some((id) => !byId.has(id))) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			const chosenAvail = chosenIds.reduce((s, id) => s + (weights[id] ?? 0), 0);
			if (chosenAvail < minNeeded) {
				return {
					handled: true,
					result: { ok: false, error: `Selected permanents do not have enough counters.` }
				};
			}
			chosen = chosenIds.map((id) => byId.get(id)!);
		} else if (exactNeeded !== undefined && (totalAvail === exactNeeded || candidates.length === 1)) {
			chosen = candidates;
		} else {
			return {
				handled: true,
				result: {
					ok: true,
					question: {
						kind: 'objects',
						index,
						label: describeFn(def),
						count: minNeeded > 0 ? 1 : 0,
						...(minNeeded === 0 ? { maxCount: Math.max(1, candidates.length) } : {}),
						candidateIds: candidates.map((c) => c.instanceId),
						...(minNeeded > 0 ? { minTotal: minNeeded, candidateWeights: weights } : {}),
						costDef: def
					}
				}
			};
		}

		const targetTotal =
			exactNeeded !== undefined
				? exactNeeded
				: isOneOrMore
					? Math.max(1, chosen.length)
					: chosen.reduce((s, c) => s + (weights[c.instanceId] ?? 0), 0);
		const dist: Record<string, number> = {};
		let rem = targetTotal;
		// First give 1 counter from each explicitly selected permanent if possible, then fill remainder.
		for (const c of chosen) {
			if (rem <= 0) break;
			const avail = weights[c.instanceId] ?? 0;
			if (avail > 0) {
				dist[c.instanceId] = 1;
				rem -= 1;
			}
		}
		for (const c of chosen) {
			if (rem <= 0) break;
			const already = dist[c.instanceId] ?? 0;
			const extraAvail = Math.max(0, (weights[c.instanceId] ?? 0) - already);
			if (extraAvail > 0) {
				const take = Math.min(extraAvail, rem);
				dist[c.instanceId] = already + take;
				rem -= take;
			}
		}
		const actualPaid = Object.values(dist).reduce((a, b) => a + b, 0);
		return {
			handled: true,
			result: {
				ok: true,
				chosen,
				nextObjectIndex: chosenIds !== undefined ? objectIndex + 1 : objectIndex,
				counterCount: actualPaid,
				counterDistribution: dist
			}
		};
	}

	// 2. Variable / oneOrMore single-permanent counter removal (`def.from !== 'self' && !def.among`)
	if (
		def.k === 'removeCounters' &&
		def.from !== 'self' &&
		!def.removeAll &&
		(def.oneOrMore || def.count.k === 'anyNumber')
	) {
		const min = def.oneOrMore ? 1 : 0;
		if (min > 0 && candidates.length === 0) {
			return {
				handled: true,
				result: { ok: false, error: `Can't pay the cost: ${describeFn(def)}.` }
			};
		}
		if (candidates.length === 0) {
			return {
				handled: true,
				result: { ok: true, chosen: [], nextObjectIndex: objectIndex, counterCount: 0 }
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		const byId = new Map(candidates.map((c) => [c.instanceId, c]));
		let chosen: CardInstance[];
		if (chosenIds !== undefined) {
			if (
				chosenIds.length > 1 ||
				(min > 0 && chosenIds.length === 0) ||
				chosenIds.some((id) => !byId.has(id))
			) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			chosen = chosenIds.map((id) => byId.get(id)!);
		} else if (min > 0 && candidates.length === 1 && payment?.counterCount !== undefined) {
			chosen = candidates;
		} else {
			return {
				handled: true,
				result: {
					ok: true,
					question: {
						kind: 'objects',
						index,
						label: describeFn(def),
						count: min,
						maxCount: 1,
						candidateIds: candidates.map((c) => c.instanceId)
					}
				}
			};
		}
		if (chosen.length === 0) {
			return {
				handled: true,
				result: { ok: true, chosen: [], nextObjectIndex: index + 1, counterCount: 0 }
			};
		}
		const avail = totalMatchingCountersP20b(chosen[0], def.counter);
		const cCnt =
			payment?.counterCount !== undefined
				? payment.counterCount
				: def.oneOrMore
					? 1
					: avail;
		if (!Number.isInteger(cCnt) || cCnt < min || cCnt > avail) {
			return {
				handled: true,
				result: { ok: false, error: `Invalid counter count for: ${describeFn(def)}.` }
			};
		}
		return {
			handled: true,
			result: {
				ok: true,
				chosen,
				nextObjectIndex: chosenIds !== undefined ? index + 1 : index,
				counterCount: cCnt
			}
		};
	}

	// 3. `unattachOther`
	if (def.k === 'unattachOther') {
		const count = def.count.k === 'const' ? def.count.n : 1;
		if (candidates.length < count) {
			return {
				handled: true,
				result: { ok: false, error: `Can't pay the cost: ${describeFn(def)}.` }
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		let chosen: CardInstance[];
		if (chosenIds !== undefined) {
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			if (
				new Set(chosenIds).size !== chosenIds.length ||
				chosenIds.length !== count ||
				chosenIds.some((id) => !byId.has(id))
			) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			chosen = chosenIds.map((id) => byId.get(id)!);
		} else if (candidates.length === count) {
			chosen = candidates;
		} else {
			return {
				handled: true,
				result: {
					ok: true,
					question: {
						kind: 'objects',
						index,
						label: describeFn(def),
						count,
						candidateIds: candidates.map((c) => c.instanceId),
						costDef: def
					}
				}
			};
		}
		for (const c of chosen) used.add(c.instanceId);
		return {
			handled: true,
			result: {
				ok: true,
				chosen,
				nextObjectIndex: chosenIds !== undefined || candidates.length !== count ? index + 1 : index + 1
			}
		};
	}

	// 4. `sacrifice` with `oneOrMore`, `upTo`, or `differentNames`
	if (def.k === 'sacrifice' && (def.oneOrMore || def.upTo !== undefined || def.differentNames)) {
		const min = def.oneOrMore
			? 1
			: def.upTo !== undefined
				? 0
				: def.count.k === 'const'
					? def.count.n
					: 1;
		const max =
			def.upTo !== undefined
				? Math.min(def.upTo, candidates.length)
				: def.oneOrMore
					? candidates.length
					: min;
		if (candidates.length < min) {
			return {
				handled: true,
				result: { ok: false, error: `Can't pay the cost: ${describeFn(def)}.` }
			};
		}
		if (def.differentNames && min > 1) {
			const distinctNames = new Set(candidates.map((c) => effectiveObjectName(ctx.state, c)).filter(Boolean));
			if (distinctNames.size < min) {
				return {
					handled: true,
					result: { ok: false, error: `Need ${min} permanents with different names.` }
				};
			}
		}
		if (max === 0) {
			return { handled: true, result: { ok: true, chosen: [], nextObjectIndex: objectIndex } };
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		const byId = new Map(candidates.map((c) => [c.instanceId, c]));
		if (chosenIds !== undefined) {
			if (
				new Set(chosenIds).size !== chosenIds.length ||
				chosenIds.length < min ||
				chosenIds.length > max ||
				chosenIds.some((id) => !byId.has(id))
			) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			const chosen = chosenIds.map((id) => byId.get(id)!);
			if (def.differentNames && !allDistinctNames(ctx.state, chosen)) {
				return {
					handled: true,
					result: { ok: false, error: 'Chosen permanents must have different names.' }
				};
			}
			for (const c of chosen) used.add(c.instanceId);
			return { handled: true, result: { ok: true, chosen, nextObjectIndex: index + 1 } };
		}
		if (min === max && candidates.length === min) {
			if (def.differentNames && !allDistinctNames(ctx.state, candidates)) {
				return {
					handled: true,
					result: { ok: false, error: 'Chosen permanents must have different names.' }
				};
			}
			for (const c of candidates) used.add(c.instanceId);
			return { handled: true, result: { ok: true, chosen: candidates, nextObjectIndex: index + 1 } };
		}
		return {
			handled: true,
			result: {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeFn(def),
					count: min,
					...(max !== min ? { maxCount: max } : {}),
					candidateIds: candidates.map((c) => c.instanceId),
					costDef: def
				}
			}
		};
	}

	// 5. `discard` with `differentNames`
	if (def.k === 'discard' && def.differentNames) {
		const count = def.count.k === 'const' ? def.count.n : 2;
		const distinctNames = new Set(
			candidates.map((c) => effectiveObjectName(ctx.state, c)).filter(Boolean)
		);
		if (candidates.length < count || distinctNames.size < count) {
			return {
				handled: true,
				result: { ok: false, error: `Need ${count} cards with different names to discard.` }
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		const byId = new Map(candidates.map((c) => [c.instanceId, c]));
		if (chosenIds !== undefined) {
			if (
				new Set(chosenIds).size !== chosenIds.length ||
				chosenIds.length !== count ||
				chosenIds.some((id) => !byId.has(id))
			) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			const chosen = chosenIds.map((id) => byId.get(id)!);
			if (!allDistinctNames(ctx.state, chosen)) {
				return {
					handled: true,
					result: { ok: false, error: 'Discarded cards must have different names.' }
				};
			}
			for (const c of chosen) used.add(c.instanceId);
			return { handled: true, result: { ok: true, chosen, nextObjectIndex: index + 1 } };
		}
		if (candidates.length === count) {
			for (const c of candidates) used.add(c.instanceId);
			return { handled: true, result: { ok: true, chosen: candidates, nextObjectIndex: index + 1 } };
		}
		return {
			handled: true,
			result: {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeFn(def),
					count,
					candidateIds: candidates.map((c) => c.instanceId),
					costDef: def
				}
			}
		};
	}

	// 6. `revealFromHand` with `shareColor`
	if (def.k === 'revealFromHand' && def.shareColor) {
		const count = def.count.k === 'const' ? def.count.n : 2;
		const validColorExists = P20B_FIVE_COLORS.some(
			(col) => candidates.filter((c) => effectiveObjectColors(ctx.state, c).includes(col)).length >= count
		);
		if (!validColorExists) {
			return {
				handled: true,
				result: { ok: false, error: `Need ${count} cards that share a color in hand.` }
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		const byId = new Map(candidates.map((c) => [c.instanceId, c]));
		if (chosenIds !== undefined) {
			if (
				new Set(chosenIds).size !== chosenIds.length ||
				chosenIds.length !== count ||
				chosenIds.some((id) => !byId.has(id))
			) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			const chosen = chosenIds.map((id) => byId.get(id)!);
			if (!allShareAtLeastOneColor(ctx.state, chosen)) {
				return {
					handled: true,
					result: { ok: false, error: 'Revealed cards must share a color.' }
				};
			}
			return { handled: true, result: { ok: true, chosen, nextObjectIndex: index + 1 } };
		}
		if (candidates.length === count && allShareAtLeastOneColor(ctx.state, candidates)) {
			return { handled: true, result: { ok: true, chosen: candidates, nextObjectIndex: index + 1 } };
		}
		return {
			handled: true,
			result: {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeFn(def),
					count,
					candidateIds: candidates.map((c) => c.instanceId),
					costDef: def
				}
			}
		};
	}

	// 7. `exileFrom` with `andOtherSameNameCount`, `totalManaValueEqualsX`, or `oneOrMore`
	if (
		def.k === 'exileFrom' &&
		(def.andOtherSameNameCount !== undefined || def.totalManaValueEqualsX || def.oneOrMore)
	) {
		if (def.andOtherSameNameCount !== undefined) {
			const otherCount = def.andOtherSameNameCount;
			if (candidates.length < otherCount) {
				return {
					handled: true,
					result: { ok: false, error: `Need ${otherCount} other cards with the same name.` }
				};
			}
			const index = objectIndex;
			const chosenIds = objects?.[index];
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			let chosenOthers: CardInstance[];
			if (chosenIds !== undefined) {
				if (
					new Set(chosenIds).size !== chosenIds.length ||
					chosenIds.length !== otherCount ||
					chosenIds.some((id) => !byId.has(id))
				) {
					return {
						handled: true,
						result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
					};
				}
				chosenOthers = chosenIds.map((id) => byId.get(id)!);
			} else if (candidates.length === otherCount) {
				chosenOthers = candidates;
			} else {
				return {
					handled: true,
					result: {
						ok: true,
						question: {
							kind: 'objects',
							index,
							label: describeFn(def),
							count: otherCount,
							candidateIds: candidates.map((c) => c.instanceId),
							costDef: def
						}
					}
				};
			}
			const allChosen = [ctx.source, ...chosenOthers];
			for (const c of allChosen) used.add(c.instanceId);
			return {
				handled: true,
				result: { ok: true, chosen: allChosen, nextObjectIndex: index + 1 }
			};
		}

		if (def.totalManaValueEqualsX) {
			const minCount = def.oneOrMore ? 1 : 0;
			const weights: Record<string, number> = {};
			for (const c of candidates) {
				weights[c.instanceId] = objectManaValue(ctx.state, c);
			}
			const witness = hasExactMvSubset(candidates, weights, ctx.xValue, minCount);
			if (!witness) {
				return {
					handled: true,
					result: {
						ok: false,
						error: `No combination of cards has total mana value ${ctx.xValue}.`
					}
				};
			}
			const index = objectIndex;
			const chosenIds = objects?.[index];
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			if (chosenIds !== undefined) {
				if (
					new Set(chosenIds).size !== chosenIds.length ||
					chosenIds.length < minCount ||
					chosenIds.some((id) => !byId.has(id))
				) {
					return {
						handled: true,
						result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
					};
				}
				const sum = chosenIds.reduce((s, id) => s + (weights[id] ?? 0), 0);
				if (sum !== ctx.xValue) {
					return {
						handled: true,
						result: {
							ok: false,
							error: `Selected cards have total mana value ${sum}; expected ${ctx.xValue}.`
						}
					};
				}
				const chosen = chosenIds.map((id) => byId.get(id)!);
				for (const c of chosen) used.add(c.instanceId);
				return { handled: true, result: { ok: true, chosen, nextObjectIndex: index + 1 } };
			}
			return {
				handled: true,
				result: {
					ok: true,
					question: {
						kind: 'objects',
						index,
						label: describeFn(def),
						count: minCount,
						maxCount: candidates.length,
						candidateIds: candidates.map((c) => c.instanceId),
						candidateWeights: weights,
						costDef: def
					}
				}
			};
		}

		// `exileFrom` with `oneOrMore` (without `totalManaValueEqualsX`)
		if (candidates.length < 1) {
			return {
				handled: true,
				result: { ok: false, error: `Can't pay the cost: ${describeFn(def)}.` }
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		const byId = new Map(candidates.map((c) => [c.instanceId, c]));
		if (chosenIds !== undefined) {
			if (
				new Set(chosenIds).size !== chosenIds.length ||
				chosenIds.length < 1 ||
				chosenIds.some((id) => !byId.has(id))
			) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			const chosen = chosenIds.map((id) => byId.get(id)!);
			for (const c of chosen) used.add(c.instanceId);
			return { handled: true, result: { ok: true, chosen, nextObjectIndex: index + 1 } };
		}
		return {
			handled: true,
			result: {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeFn(def),
					count: 1,
					maxCount: candidates.length,
					candidateIds: candidates.map((c) => c.instanceId),
					costDef: def
				}
			}
		};
	}

	// 8. `behold` with `exile: true`: mark chosen object in `used` so another cost cannot consume it
	if (def.k === 'behold' && def.exile) {
		const count = def.count.k === 'const' ? def.count.n : 1;
		if (candidates.length < count) {
			return {
				handled: true,
				result: { ok: false, error: `Can't pay the cost: ${describeFn(def)}.` }
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		const byId = new Map(candidates.map((c) => [c.instanceId, c]));
		let chosen: CardInstance[];
		if (chosenIds !== undefined) {
			if (
				new Set(chosenIds).size !== chosenIds.length ||
				chosenIds.length !== count ||
				chosenIds.some((id) => !byId.has(id))
			) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeFn(def)}.` }
				};
			}
			chosen = chosenIds.map((id) => byId.get(id)!);
		} else if (candidates.length === count) {
			chosen = candidates;
		} else {
			return {
				handled: true,
				result: {
					ok: true,
					question: {
						kind: 'objects',
						index,
						label: describeFn(def),
						count,
						candidateIds: candidates.map((c) => c.instanceId),
						costDef: def
					}
				}
			};
		}
		for (const c of chosen) used.add(c.instanceId);
		return {
			handled: true,
			result: { ok: true, chosen, nextObjectIndex: index + 1 }
		};
	}

	return { handled: false };
}

export function pickGreedyP20bObjects(
	def: CostDef,
	candidates: CardInstance[],
	count: number,
	ctx: CostContext
): string[] | null {
	if (def.k === 'sacrifice' && def.differentNames) {
		const out: string[] = [];
		const seen = new Set<string>();
		for (const c of candidates) {
			const nm = effectiveObjectName(ctx.state, c);
			if (!nm || seen.has(nm)) continue;
			seen.add(nm);
			out.push(c.instanceId);
			if (out.length >= count) return out;
		}
		return null;
	}
	if (def.k === 'discard' && def.differentNames) {
		const out: string[] = [];
		const seen = new Set<string>();
		for (const c of candidates) {
			const nm = effectiveObjectName(ctx.state, c);
			if (!nm || seen.has(nm)) continue;
			seen.add(nm);
			out.push(c.instanceId);
			if (out.length >= count) return out;
		}
		return null;
	}
	if (def.k === 'revealFromHand' && def.shareColor) {
		for (const col of P20B_FIVE_COLORS) {
			const matching = candidates.filter((c) => effectiveObjectColors(ctx.state, c).includes(col));
			if (matching.length >= count) {
				return matching.slice(0, count).map((c) => c.instanceId);
			}
		}
		return null;
	}
	if (def.k === 'exileFrom' && def.totalManaValueEqualsX) {
		const weights: Record<string, number> = {};
		for (const c of candidates) {
			weights[c.instanceId] = objectManaValue(ctx.state, c);
		}
		return hasExactMvSubset(candidates, weights, ctx.xValue, def.oneOrMore ? 1 : 0);
	}
	return null;
}

export function serializeP20bCostPart(
	def: CostDef,
	ctx: CostContext,
	objects: CardInstance[] | undefined,
	counterCount?: number,
	counterDistribution?: Record<string, number>,
	emitForaged?: boolean
): SerializedPlannedCost | null {
	const forageExtra = emitForaged ? { emitForaged: true } : {};
	switch (def.k) {
		case 'unattachSelf':
			return { def, ...forageExtra };
		case 'unattachOther':
			return {
				def,
				objectIds: (objects ?? []).map((o) => o.instanceId),
				objectNames: (objects ?? []).map((o) => o.card.name),
				...forageExtra
			};
		case 'rollDie': {
			const sides = Math.max(2, def.sides);
			const rollResult = Math.floor(nextRandom(ctx.state) * sides) + 1;
			return { def, rollResult, ...forageExtra };
		}
		case 'flipCoin': {
			const rollResult = nextRandom(ctx.state) < 0.5 ? 1 : 0;
			return { def, rollResult, ...forageExtra };
		}
		case 'behold':
			if (def.exile) {
				return {
					def,
					objectIds: (objects ?? []).map((o) => o.instanceId),
					objectNames: (objects ?? []).map((o) => o.card.name),
					...forageExtra
				};
			}
			return null;
		case 'removeCounters': {
			if (counterDistribution !== undefined) {
				const sum = Object.values(counterDistribution).reduce((a, b) => a + b, 0);
				return {
					def,
					objectIds: (objects ?? []).map((o) => o.instanceId),
					objectNames: (objects ?? []).map((o) => o.card.name),
					counterCount: counterCount ?? sum,
					counterDistribution,
					...forageExtra
				};
			}
			const computedCount =
				counterCount !== undefined
					? counterCount
					: def.removeAll
						? (def.from === 'self' ? [ctx.source] : (objects ?? [])).reduce(
								(sum, o) => sum + totalMatchingCountersP20b(o, def.counter),
								0
							)
						: Math.max(
								0,
								evaluateAmount(def.count, {
									state: ctx.state,
									controllerId: ctx.player.playerId,
									source: ctx.source,
									xValue: ctx.xValue
								})
							);
			return {
				def,
				counterCount: computedCount,
				...(def.from !== 'self' && objects
					? {
							objectIds: objects.map((o) => o.instanceId),
							objectNames: objects.map((o) => o.card.name)
						}
					: {}),
				...forageExtra
			};
		}
		default:
			return null;
	}
}

export function hasCounterRemovalSerializedPart(parts: SerializedPlannedCost[]): boolean {
	return parts.some(
		(pt) =>
			pt.def.k === 'removeCounters' ||
			pt.counterCount !== undefined ||
			pt.counterDistribution !== undefined
	);
}

export function totalRemovedCountersFromSerializedParts(parts: SerializedPlannedCost[]): number {
	let total = 0;
	for (const p of parts) {
		if (p.counterCount !== undefined) {
			total += p.counterCount;
		}
	}
	return total;
}

export function lastRollResultFromSerializedParts(
	parts: SerializedPlannedCost[]
): number | undefined {
	let last: number | undefined;
	for (const p of parts) {
		if (p.rollResult !== undefined) last = p.rollResult;
	}
	return last;
}

export function executeP20bCostPart(
	ctx: CostContext,
	part: SerializedPlannedCost,
	partIdx: number,
	startObjIdx: number,
	descriptions: string[],
	targetLog: string[],
	findCard: (id: string) => CardInstance | undefined
): { handled: boolean; pausedResult?: PaidCosts } {
	const def = part.def;
	switch (def.k) {
		case 'unattachSelf': {
			if (startObjIdx === 0) {
				const src = ctx.source;
				const hostId = src.attachedToId;
				if (hostId) {
					const host = findBattlefieldPerm(ctx.state, hostId);
					src.attachedToId = null;
					noteLayerInputsChanged(ctx.state);
					emitEvent(ctx.state, {
						kind: 'Unattached',
						attachmentId: src.instanceId,
						attachment: src,
						hostId,
						...(host ? { host } : {})
					});
					targetLog.push(`unattached ${src.card.name}`);
				}
			}
			return { handled: true };
		}
		case 'unattachOther': {
			const ids = part.objectIds ?? [];
			for (let oi = startObjIdx; oi < ids.length; oi++) {
				const att = findBattlefieldPerm(ctx.state, ids[oi]);
				if (!att || !att.attachedToId) continue;
				const hostId = att.attachedToId;
				const host = findBattlefieldPerm(ctx.state, hostId);
				att.attachedToId = null;
				noteLayerInputsChanged(ctx.state);
				emitEvent(ctx.state, {
					kind: 'Unattached',
					attachmentId: att.instanceId,
					attachment: att,
					hostId,
					...(host ? { host } : {})
				});
				targetLog.push(`unattached ${att.card.name}`);
			}
			return { handled: true };
		}
		case 'rollDie': {
			if (startObjIdx === 0) {
				const sides = def.sides;
				const res = part.rollResult ?? 1;
				targetLog.push(`rolled ${res} on d${sides}`);
			}
			return { handled: true };
		}
		case 'flipCoin': {
			if (startObjIdx === 0) {
				const won = (part.rollResult ?? 0) === 1;
				targetLog.push(won ? 'flipped heads' : 'flipped tails');
			}
			return { handled: true };
		}
		case 'removeCounters': {
			if (part.counterDistribution !== undefined) {
				if (startObjIdx === 0) {
					const dist = part.counterDistribution;
					let totalRemoved = 0;
					const names: string[] = [];
					for (const [id, amt] of Object.entries(dist)) {
						if (amt <= 0) continue;
						const perm = findBattlefieldPerm(ctx.state, id);
						if (!perm) continue;
						const took = deductMatchingCountersWave6(
							ctx.state,
							perm,
							def.counter ?? 'any',
							amt
						);
						totalRemoved += took;
						if (took > 0) names.push(perm.card.name);
					}
					const cLabel = def.counter && def.counter !== 'any' ? `${def.counter} ` : '';
					targetLog.push(
						`removed ${totalRemoved} ${cLabel}counter${totalRemoved === 1 ? '' : 's'}${names.length > 0 ? ` from ${names.join(', ')}` : ''}`
					);
				}
				return { handled: true };
			}
			if (part.counterCount !== undefined) {
				if (startObjIdx === 0) {
					const amount = part.counterCount;
					const cLabel = def.counter && def.counter !== 'any' ? `${def.counter} ` : '';
					if (def.from === 'self') {
						const removed =
							amount > 0
								? deductMatchingCountersWave6(
										ctx.state,
										ctx.source,
										def.counter ?? 'any',
										amount
									)
								: 0;
						targetLog.push(`removed ${removed} ${cLabel}counter${removed === 1 ? '' : 's'}`);
					} else {
						const chosenId = part.objectIds?.[0];
						const perm = chosenId ? findBattlefieldPerm(ctx.state, chosenId) : undefined;
						if (perm && amount > 0) {
							const removed = deductMatchingCountersWave6(
								ctx.state,
								perm,
								def.counter ?? 'any',
								amount
							);
							targetLog.push(
								`removed ${removed} ${cLabel}counter${removed === 1 ? '' : 's'} from ${perm.card.name}`
							);
						} else {
							targetLog.push(`removed 0 ${cLabel}counters`);
						}
					}
				}
				return { handled: true };
			}
			return { handled: false };
		}
		case 'behold': {
			if (!def.exile) return { handled: false };
			const ids = part.objectIds ?? [];
			for (let oi = startObjIdx; oi < ids.length; oi++) {
				const target = findCard(ids[oi]);
				if (!target) continue;
				if (target.zone === 'hand') {
					markHandCardRevealedToAll(ctx.state, target);
				}
				const owner =
					ctx.state.players.find((pl) => pl.playerId === target.ownerId) ?? ctx.player;
				const fromSpec =
					target.zone === 'battlefield'
						? 'anyBattlefield'
						: { player: owner, zone: target.zone as PlayerZone };
				const mr: MoveResult = moveObject(ctx.state, target, 'exile', {
					from: fromSpec,
					toPlayer: owner,
					detachAttachments: target.zone === 'battlefield',
					leaveBattlefieldReset: target.zone === 'battlefield',
					commanderRedirect: true,
					bumpVersion: true,
					newTimestamp: true,
					ceaseToExist: 'tokens'
				});
				if (mr === 'exile' && target.zone === 'exile') {
					target.exiledBy = {
						sourceInstanceId: ctx.source.instanceId,
						sourceObjectVersion: ctx.source.objectVersion ?? 1
					};
				}
				targetLog.push(`beheld and exiled ${target.card.name}`);
				if (mr === 'pending') {
					return {
						handled: true,
						pausedResult: {
							descriptions,
							paused: true,
							nextPartIndex: oi + 1 < ids.length ? partIdx : partIdx + 1,
							nextObjectIndex: oi + 1 < ids.length ? oi + 1 : 0
						}
					};
				}
			}
			return { handled: true };
		}
		default:
			return { handled: false };
	}
}

/**
 * Syncs `exiledBy.sourceObjectVersion` on exiled cards when a spell transitions across zones
 * (`hand` -> `stack` -> `battlefield`) so linked LTB triggers (`CR 607.2a`, `CR 400.7b`) find cards
 * exiled as part of casting that spell.
 */
export function syncCastExiledByVersionP20b(
	state: GameState,
	sourceInstanceId: string,
	fromVersion: number,
	toVersion: number
): void {
	if (fromVersion === toVersion) return;
	for (const p of state.players) {
		for (const ex of p.exile) {
			if (
				ex.exiledBy &&
				ex.exiledBy.sourceInstanceId === sourceInstanceId &&
				ex.exiledBy.sourceObjectVersion === fromVersion
			) {
				ex.exiledBy = {
					sourceInstanceId,
					sourceObjectVersion: toVersion
				};
			}
		}
	}
}

// ---- Mana-source tracking & `ManaSpendContext` restrictions (`CR 106.6`, `CR 107.3i`) ----------

export function recordP20bSourceManaAdded(
	state: GameState,
	player: PlayerGameState,
	sourcePerm: CardInstance | undefined,
	color: ManaColor,
	amount: number
): void {
	if (!sourcePerm || amount <= 0 || sourcePerm.zone !== 'battlefield' || sourcePerm.phasedOut) {
		return;
	}
	const ev = evaluatePermanent(state, sourcePerm);
	const poolAmt = player.manaPool[color] ?? 0;
	if (ev.isCreature) {
		const map = (player.creatureManaByColor ??= {});
		map[color] = Math.min(poolAmt, (map[color] ?? 0) + amount);
	}
	if (ev.isLand && /\bBasic\b/.test(ev.effectiveTypeLine)) {
		const map = (player.basicLandManaByColor ??= {});
		map[color] = Math.min(poolAmt, (map[color] ?? 0) + amount);
	}
	if (ev.hasSubType('Treasure')) {
		const map = (player.treasureManaByColor ??= {});
		map[color] = Math.min(poolAmt, (map[color] ?? 0) + amount);
	}
}

export function clearP20bSourceManaPool(player: PlayerGameState): void {
	delete player.creatureManaByColor;
	delete player.basicLandManaByColor;
	delete player.treasureManaByColor;
}

export function clampP20bSourceManaToPool(player: PlayerGameState): void {
	const clampMap = (map: Partial<Record<ManaColor, number>> | undefined): boolean => {
		if (!map) return false;
		let anyPositive = false;
		for (const c of P20B_COLORS) {
			const cur = map[c] ?? 0;
			if (cur <= 0) {
				delete map[c];
				continue;
			}
			const clamped = Math.min(cur, player.manaPool[c] ?? 0);
			if (clamped > 0) {
				map[c] = clamped;
				anyPositive = true;
			} else {
				delete map[c];
			}
		}
		return anyPositive;
	};
	if (!clampMap(player.creatureManaByColor)) delete player.creatureManaByColor;
	if (!clampMap(player.basicLandManaByColor)) delete player.basicLandManaByColor;
	if (!clampMap(player.treasureManaByColor)) delete player.treasureManaByColor;
}

export function permanentManaSourceFlagsP20b(
	state: GameState,
	perm: CardInstance
): { isCreature: boolean; isBasicLand: boolean; isTreasure: boolean } {
	if (perm.zone !== 'battlefield' || perm.phasedOut) {
		return { isCreature: false, isBasicLand: false, isTreasure: false };
	}
	const ev = evaluatePermanent(state, perm);
	return {
		isCreature: ev.isCreature,
		isBasicLand: ev.isLand && /\bBasic\b/.test(ev.effectiveTypeLine),
		isTreasure: ev.hasSubType('Treasure')
	};
}

function countXSymbolsInCostStr(costStr: string | undefined): number {
	if (!costStr) return 0;
	const matches = costStr.match(/\{X\}/gi);
	return matches ? matches.length : 0;
}

export function collectSpellManaSpendRestrictionsP20b(
	state: GameState | undefined,
	inst: CardInstance,
	opts?: {
		faceIndex?: number;
		fused?: boolean;
		isFaceDown?: boolean;
		xValue?: number;
		manaCostOverride?: string;
	}
): Partial<ManaSpendContext> {
	if (opts?.isFaceDown) return {};
	const card = effectiveCardForObject(inst);
	const faceOpts = {
		zone: 'stack' as const,
		faceIndex: opts?.faceIndex ?? 0,
		fused: opts?.fused ?? false
	};
	const view = resolveObjectFaces(card, faceOpts);
	const costStr = opts?.manaCostOverride ?? view.manaCost;
	const xSymCount = countXSymbolsInCostStr(costStr);
	const xVal = Math.max(0, opts?.xValue ?? 0);

	const out: Partial<ManaSpendContext> = {};
	const fctx: FilterContext | undefined = state
		? { state, controllerId: inst.controllerId, source: inst, xValue: xVal }
		: undefined;

	for (const ab of activeAbilityDefs(card, faceOpts)) {
		if (ab.kind === 'static' && ab.static.k === 'manaSpendRestriction') {
			const st = ab.static;
			if (st.scope !== 'selfSpell' && st.scope !== 'selfBoth') continue;
			if (st.condition && fctx && !evaluateCondition(st.condition, fctx)) continue;
			if (st.sourceKind) {
				out.manaSourceSpendKind = st.sourceKind;
				if (st.sourceKind === 'chosenColor' && inst.chosenColor) {
					out.manaSourceChosenColor = inst.chosenColor;
				}
			}
			if (st.xColors || st.xColoredOnly || st.xMaxOnePerColor) {
				if (st.xColors) out.xSpendColors = [...st.xColors];
				if (st.xColoredOnly) out.xColoredOnly = true;
				if (st.xMaxOnePerColor) out.xMaxOnePerColor = true;
				out.xManaCount = xVal * Math.max(1, xSymCount);
			}
		} else if (ab.kind === 'spell') {
			for (const cd of ab.additionalCosts) {
				if (cd.k === 'mana' && (cd.xSpendColors || cd.xColoredOnly || cd.xMaxOnePerColor)) {
					if (cd.xSpendColors) out.xSpendColors = [...cd.xSpendColors];
					if (cd.xColoredOnly) out.xColoredOnly = true;
					if (cd.xMaxOnePerColor) out.xMaxOnePerColor = true;
					out.xManaCount = xVal * Math.max(1, countXSymbolsInCostStr(cd.cost));
				}
			}
		}
	}
	return out;
}

export function collectAbilityManaSpendRestrictionsP20b(
	state: GameState | undefined,
	perm: CardInstance,
	ab: EffectiveActivatedAbility,
	xValue = 0
): Partial<ManaSpendContext> {
	const out: Partial<ManaSpendContext> = {};
	const costStr = ab.baseManaCost ?? ab.manaCost;
	const xSymCount = Math.max(1, countXSymbolsInCostStr(costStr));
	const xVal = Math.max(0, xValue);

	if (ab.xSpendColors || ab.xColoredOnly || ab.xMaxOnePerColor) {
		if (ab.xSpendColors) out.xSpendColors = [...ab.xSpendColors];
		if (ab.xColoredOnly) out.xColoredOnly = true;
		if (ab.xMaxOnePerColor) out.xMaxOnePerColor = true;
		out.xManaCount = xVal * xSymCount;
	}
	if (ab.manaSourceSpendKind) {
		out.manaSourceSpendKind = ab.manaSourceSpendKind;
		if (ab.manaSourceSpendKind === 'chosenColor' && perm.chosenColor) {
			out.manaSourceChosenColor = perm.chosenColor;
		}
	}

	const card = effectiveCardForObject(perm);
	const fctx: FilterContext | undefined = state
		? { state, controllerId: perm.controllerId, source: perm, xValue: xVal }
		: undefined;
	for (const defAb of activeAbilityDefs(card, instanceFaceOptions(perm, perm.zone))) {
		if (defAb.kind === 'activated' && defAb.id === ab.id) {
			if (defAb.xSpendColors) out.xSpendColors = [...defAb.xSpendColors];
			if (defAb.xColoredOnly) out.xColoredOnly = true;
			if (defAb.xMaxOnePerColor) out.xMaxOnePerColor = true;
			if (defAb.xSpendColors || defAb.xColoredOnly || defAb.xMaxOnePerColor) {
				out.xManaCount = xVal * xSymCount;
			}
		} else if (defAb.kind === 'static' && defAb.static.k === 'manaSpendRestriction') {
			const st = defAb.static;
			if (st.scope !== 'selfAbility' && st.scope !== 'selfBoth') continue;
			if (st.condition && fctx && !evaluateCondition(st.condition, fctx)) continue;
			if (st.sourceKind) {
				out.manaSourceSpendKind = st.sourceKind;
				if (st.sourceKind === 'chosenColor' && perm.chosenColor) {
					out.manaSourceChosenColor = perm.chosenColor;
				}
			}
			if (st.xColors || st.xColoredOnly || st.xMaxOnePerColor) {
				if (st.xColors) out.xSpendColors = [...st.xColors];
				if (st.xColoredOnly) out.xColoredOnly = true;
				if (st.xMaxOnePerColor) out.xMaxOnePerColor = true;
				out.xManaCount = xVal * xSymCount;
			}
		}
	}
	return out;
}

export interface P20bSimSourcePools {
	creature: Partial<Record<ManaColor, number>>;
	basicLand: Partial<Record<ManaColor, number>>;
	snow: Partial<Record<ManaColor, number>>;
	treasure: Partial<Record<ManaColor, number>>;
}

export function initP20bSimSourcePools(player: PlayerGameState): P20bSimSourcePools {
	return {
		creature: { ...(player.creatureManaByColor ?? {}) },
		basicLand: { ...(player.basicLandManaByColor ?? {}) },
		snow: { ...(player.snowManaByColor ?? {}) },
		treasure: { ...(player.treasureManaByColor ?? {}) }
	};
}

export function canSatisfyP20bManaSpendRestrictions(
	pool: ManaPool,
	manaReq: ManaCostRequirement,
	spendCtx: ManaSpendContext | undefined,
	sourcePools: P20bSimSourcePools,
	canPayPoolFn: (subPool: ManaPool, req: ManaCostRequirement) => boolean
): boolean {
	if (!spendCtx) return true;

	let effectivePool: ManaPool = { ...pool };

	// 1. Source-kind spend restriction ("Spend only mana produced by creatures / basic lands / snow / Treasures / chosen color")
	if (spendCtx.manaSourceSpendKind) {
		const subPool: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		if (spendCtx.manaSourceSpendKind === 'chosenColor') {
			const chosen = spendCtx.manaSourceChosenColor;
			if (!chosen) return false;
			subPool[chosen] = pool[chosen] ?? 0;
		} else {
			const map =
				spendCtx.manaSourceSpendKind === 'creature'
					? sourcePools.creature
					: spendCtx.manaSourceSpendKind === 'basicLand'
						? sourcePools.basicLand
						: spendCtx.manaSourceSpendKind === 'snow'
							? sourcePools.snow
							: sourcePools.treasure;
			for (const col of P20B_COLORS) {
				subPool[col] = Math.min(pool[col] ?? 0, map[col] ?? 0);
			}
		}
		if (!canPayPoolFn(subPool, manaReq)) return false;
		effectivePool = subPool;
	}

	// 2. X-mana color / converge spend restriction ("Spend only black mana on X", "Spend only colored mana on X. No more than one mana of each color...")
	const xManaCount = Math.min(spendCtx.xManaCount ?? 0, manaReq.generic);
	if (
		xManaCount > 0 &&
		(spendCtx.xSpendColors || spendCtx.xColoredOnly || spendCtx.xMaxOnePerColor)
	) {
		const rem: ManaPool = { ...effectivePool };
		for (const col of P20B_COLORS) {
			const needed = manaReq.colored[col] ?? 0;
			if ((rem[col] ?? 0) < needed) return false;
			rem[col] -= needed;
		}
		const nonXGeneric = Math.max(0, manaReq.generic - xManaCount);
		const allowedSet = new Set<ManaColor>(
			spendCtx.xSpendColors ??
				(spendCtx.xColoredOnly ? P20B_FIVE_COLORS : P20B_COLORS)
		);
		// Pay non-X generic mana from non-allowed colors first so allowed mana is preserved for X!
		let nonXLeft = nonXGeneric;
		for (const col of P20B_COLORS) {
			if (nonXLeft <= 0) break;
			if (allowedSet.has(col)) continue;
			const take = Math.min(rem[col], nonXLeft);
			rem[col] -= take;
			nonXLeft -= take;
		}
		if (nonXLeft > 0) {
			// Take excess from allowed colors with highest surplus first (preserving distinct colors when xMaxOnePerColor).
			for (let step = 0; step < nonXLeft; step++) {
				let bestCol: ManaColor | null = null;
				let bestAmt = 0;
				for (const col of allowedSet) {
					if (rem[col] > bestAmt) {
						bestAmt = rem[col];
						bestCol = col;
					}
				}
				if (!bestCol || bestAmt <= 0) return false;
				rem[bestCol] -= 1;
			}
		}

		if (spendCtx.xMaxOnePerColor) {
			let distinctAllowed = 0;
			for (const col of allowedSet) {
				if ((rem[col] ?? 0) > 0) distinctAllowed += 1;
			}
			if (distinctAllowed < xManaCount) return false;
		} else {
			let totalAllowed = 0;
			for (const col of allowedSet) {
				totalAllowed += rem[col] ?? 0;
			}
			if (totalAllowed < xManaCount) return false;
		}
	}

	return true;
}

export function pickP20bPreferredColorForPass2(
	pool: ManaPool,
	manaReq: ManaCostRequirement,
	spendCtx: ManaSpendContext | undefined,
	ab: EffectiveActivatedAbility | undefined
): ManaColor | undefined {
	if (!spendCtx || !ab || ab.producesMana.length === 0) return undefined;
	if (spendCtx.manaSourceSpendKind === 'chosenColor' && spendCtx.manaSourceChosenColor) {
		if (ab.producesMana.includes(spendCtx.manaSourceChosenColor)) {
			return spendCtx.manaSourceChosenColor;
		}
	}
	if (
		(spendCtx.xManaCount ?? 0) > 0 &&
		(spendCtx.xSpendColors || spendCtx.xColoredOnly || spendCtx.xMaxOnePerColor)
	) {
		const allowed = new Set<ManaColor>(
			spendCtx.xSpendColors ?? (spendCtx.xColoredOnly ? P20B_FIVE_COLORS : P20B_COLORS)
		);
		if (spendCtx.xMaxOnePerColor) {
			for (const col of ab.producesMana) {
				if (allowed.has(col) && (pool[col] ?? 0) <= (manaReq.colored[col] ?? 0)) {
					return col;
				}
			}
		}
		for (const col of ab.producesMana) {
			if (allowed.has(col)) return col;
		}
	}
	return undefined;
}

export function rewriteAndDeductP20bSourceMana(
	combinedPool: ManaPool,
	manaReq: ManaCostRequirement,
	spendCtx: ManaSpendContext | undefined,
	player: PlayerGameState
): ManaCostRequirement {
	if (
		!spendCtx ||
		(!spendCtx.manaSourceSpendKind &&
			!spendCtx.xSpendColors &&
			!spendCtx.xColoredOnly &&
			!spendCtx.xMaxOnePerColor)
	) {
		return manaReq;
	}

	const sourceMap: Partial<Record<ManaColor, number>> | undefined =
		spendCtx.manaSourceSpendKind === 'creature'
			? player.creatureManaByColor
			: spendCtx.manaSourceSpendKind === 'basicLand'
				? player.basicLandManaByColor
				: spendCtx.manaSourceSpendKind === 'snow'
					? player.snowManaByColor
					: spendCtx.manaSourceSpendKind === 'treasure'
						? player.treasureManaByColor
						: undefined;

	const avail: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	if (spendCtx.manaSourceSpendKind === 'chosenColor') {
		const ch = spendCtx.manaSourceChosenColor;
		if (ch) avail[ch] = combinedPool[ch] ?? 0;
	} else if (spendCtx.manaSourceSpendKind) {
		for (const col of P20B_COLORS) {
			avail[col] = Math.min(combinedPool[col] ?? 0, sourceMap?.[col] ?? 0);
		}
	} else {
		for (const col of P20B_COLORS) {
			avail[col] = combinedPool[col] ?? 0;
		}
	}

	const nextColored: Record<ManaColor, number> = { ...manaReq.colored };
	for (const col of P20B_COLORS) {
		avail[col] = Math.max(0, avail[col] - nextColored[col]);
	}

	const xManaCount = Math.min(spendCtx.xManaCount ?? 0, manaReq.generic);
	const nonXGeneric = Math.max(0, manaReq.generic - xManaCount);
	const hasXRestr =
		xManaCount > 0 &&
		Boolean(spendCtx.xSpendColors || spendCtx.xColoredOnly || spendCtx.xMaxOnePerColor);
	const allowedXSet = new Set<ManaColor>(
		spendCtx.xSpendColors ?? (spendCtx.xColoredOnly ? P20B_FIVE_COLORS : P20B_COLORS)
	);

	// Reserve non-X generic from non-X-allowed colors first so allowed colors stay open for X.
	const nonXAllocated: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	let nonXLeft = nonXGeneric;
	const spendOrder: readonly ManaColor[] = ['C', 'W', 'U', 'B', 'R', 'G'];
	if (hasXRestr) {
		for (const col of spendOrder) {
			if (nonXLeft <= 0) break;
			if (allowedXSet.has(col)) continue;
			const take = Math.min(avail[col], nonXLeft);
			avail[col] -= take;
			nonXAllocated[col] += take;
			nonXLeft -= take;
		}
		for (let step = 0; step < nonXLeft; step++) {
			let bestCol: ManaColor | null = null;
			let bestAmt = 0;
			for (const col of spendOrder) {
				if (avail[col] > bestAmt) {
					bestAmt = avail[col];
					bestCol = col;
				}
			}
			if (!bestCol || bestAmt <= 0) break;
			avail[bestCol] -= 1;
			nonXAllocated[bestCol] += 1;
		}
	} else if (spendCtx.manaSourceSpendKind) {
		for (const col of spendOrder) {
			if (nonXLeft <= 0) break;
			const take = Math.min(avail[col], nonXLeft);
			avail[col] -= take;
			nonXAllocated[col] += take;
			nonXLeft -= take;
		}
	}

	if (spendCtx.manaSourceSpendKind) {
		for (const col of P20B_COLORS) {
			nextColored[col] += nonXAllocated[col];
		}
	}

	if (hasXRestr) {
		let xLeft = xManaCount;
		if (spendCtx.xMaxOnePerColor) {
			for (const col of spendOrder) {
				if (xLeft <= 0) break;
				if (!allowedXSet.has(col) || avail[col] <= 0) continue;
				avail[col] -= 1;
				nextColored[col] += 1;
				xLeft -= 1;
			}
		} else {
			for (const col of spendOrder) {
				if (xLeft <= 0) break;
				if (!allowedXSet.has(col) || avail[col] <= 0) continue;
				const take = Math.min(avail[col], xLeft);
				avail[col] -= take;
				nextColored[col] += take;
				xLeft -= take;
			}
		}
	} else if (spendCtx.manaSourceSpendKind && xManaCount > 0) {
		let xLeft = xManaCount;
		for (const col of spendOrder) {
			if (xLeft <= 0) break;
			const take = Math.min(avail[col], xLeft);
			avail[col] -= take;
			nextColored[col] += take;
			xLeft -= take;
		}
	}

	const nextGeneric = spendCtx.manaSourceSpendKind
		? 0
		: hasXRestr
			? nonXGeneric
			: manaReq.generic;

	if (sourceMap) {
		for (const col of P20B_COLORS) {
			const spent = nextColored[col] ?? 0;
			if (spent <= 0) continue;
			const rem = Math.max(0, (sourceMap[col] ?? 0) - spent);
			if (rem > 0) sourceMap[col] = rem;
			else delete sourceMap[col];
		}
	}

	return {
		...manaReq,
		colored: nextColored,
		generic: nextGeneric
	};
}

// ---- Defiler cycle, pitch counts, Trap/Mastery conditions, & commander life tax -----------------

function countColorPipsInManaCost(costStr: string, color: ManaColor): number {
	const symbols = costStr.match(/\{[^}]+\}/g);
	if (!symbols) return 0;
	let count = 0;
	for (const sym of symbols) {
		if (sym.slice(1, -1).toUpperCase() === color) count += 1;
	}
	return count;
}

function buildSpellStackProxy(
	inst: CardInstance,
	controllerId: string,
	faceIndex: number,
	fused: boolean,
	castFaceDown?: FaceDownSpec,
	prototyped?: boolean
): CardInstance {
	return {
		...inst,
		controllerId,
		zone: 'stack',
		activeFaceIndex: fused ? 0 : faceIndex,
		...(prototyped ? { prototyped: true } : {}),
		...(castFaceDown
			? { isFaceDown: true, faceDownSpec: castFaceDown }
			: { isFaceDown: false })
	};
}

export function collectDefilerOptionalCosts(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	faceIndex: number,
	fused: boolean,
	baseManaCost: string,
	matchesFilter: MatchesFilterFn
): CastOptionOptionalCost[] {
	if (!baseManaCost) return [];
	if (playerLifeTotalCantChange(state, actor.playerId)) return [];

	const stackProxy = buildSpellStackProxy(inst, actor.playerId, faceIndex, fused);
	const out: CastOptionOptionalCost[] = [];
	const mayGrantDefiler = boardMayGrantStaticAbility(state, 'defilerCostReduction');

	for (const perm of actor.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		if (ev.losesAllAbilities) continue;
		const fctx: FilterContext = {
			state,
			controllerId: actor.playerId,
			source: perm
		};
		const statics: StaticDef[] = [];
		for (const ab of activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		)) {
			if (ab.kind === 'static' && ab.static.k === 'defilerCostReduction') {
				statics.push(ab.static);
			}
		}
		if (mayGrantDefiler) {
			for (const g of collectActiveGrantedStaticDefs(state, perm)) {
				if (g.k === 'defilerCostReduction') statics.push(g);
			}
		}
		for (let si = 0; si < statics.length; si++) {
			const st = statics[si];
			if (st.k !== 'defilerCostReduction') continue;
			if (actor.life < st.lifeAmount) continue;
			if (countColorPipsInManaCost(baseManaCost, st.color) <= 0) continue;
			if (st.condition && !evaluateCondition(st.condition, fctx)) continue;
			if (!matchesFilter(stackProxy, st.filter, fctx)) continue;
			const idSuffix = si === 0 ? perm.instanceId : `${perm.instanceId}:${si}`;
			out.push({
				id: `defiler:${idSuffix}`,
				label: `Pay ${st.lifeAmount} life (${ev.effectiveName} — reduce {${st.color}})`,
				costDisplay: `Pay ${st.lifeAmount} life`,
				costDefs: [{ k: 'payLife', amount: { k: 'const', n: st.lifeAmount } }],
				maxCount: 1
			});
		}
	}
	return out;
}

export function computeDefilerColoredReduction(
	state: GameState,
	actor: PlayerGameState,
	optionalCostCounts: Record<string, number> | undefined,
	baseCostStr: string
): Partial<Record<ManaColor, number>> | undefined {
	if (!optionalCostCounts) return undefined;
	const rawReductions: Partial<Record<ManaColor, number>> = {};
	let any = false;
	const mayGrantDefiler = boardMayGrantStaticAbility(state, 'defilerCostReduction');

	for (const [key, count] of Object.entries(optionalCostCounts)) {
		if (!key.startsWith('defiler:') || count <= 0) continue;
		const rest = key.slice('defiler:'.length);
		const [permId, idxStr] = rest.split(':');
		const targetIdx = idxStr ? parseInt(idxStr, 10) : 0;
		const perm = actor.battlefield.find((b) => !b.phasedOut && b.instanceId === permId);
		if (!perm || evaluatePermanent(state, perm).losesAllAbilities) continue;
		const statics: StaticDef[] = [];
		for (const ab of activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		)) {
			if (ab.kind === 'static' && ab.static.k === 'defilerCostReduction') statics.push(ab.static);
		}
		if (mayGrantDefiler) {
			for (const g of collectActiveGrantedStaticDefs(state, perm)) {
				if (g.k === 'defilerCostReduction') statics.push(g);
			}
		}
		const st = statics[targetIdx];
		if (!st || st.k !== 'defilerCostReduction') continue;
		rawReductions[st.color] = (rawReductions[st.color] ?? 0) + count;
		any = true;
	}
	if (!any) return undefined;

	// Defiler abilities reduce ONLY colored pips of that color (`CR 118.7c`), never generic mana.
	const clamped: Partial<Record<ManaColor, number>> = {};
	let anyClamped = false;
	for (const [colKey, amt] of Object.entries(rawReductions) as Array<[ManaColor, number]>) {
		const maxPips = countColorPipsInManaCost(baseCostStr, colKey);
		const eff = Math.min(amt, maxPips);
		if (eff > 0) {
			clamped[colKey] = eff;
			anyClamped = true;
		}
	}
	return anyClamped ? clamped : undefined;
}

export interface P20bPitchCounts {
	exiledCostCardCount: number;
	sacrificedCostPermCount: number;
	removedCostCounterCount: number;
}

export function cardUsesP20bCostPaidCount(
	inst: CardInstance,
	faceIndex = 0,
	fused = false
): boolean {
	const card = effectiveCardForObject(inst);
	for (const ab of activeAbilityDefs(card, { zone: 'stack', faceIndex, fused })) {
		if (
			ab.kind === 'static' &&
			ab.static.k === 'costModifier' &&
			ab.static.delta.per?.k === 'p20bCostPaidCount'
		) {
			return true;
		}
	}
	return false;
}

function flattenChosenCostDefsP20b(
	defs: CostDef[],
	options: number[] | undefined
): { flat: CostDef[]; pendingChoice: boolean } {
	const flat: CostDef[] = [];
	const work: CostDef[] = [...defs];
	let choiceIdx = 0;
	let pendingChoice = false;
	for (let guard = 0; guard < 128 && work.length > 0; guard++) {
		const def = work.shift()!;
		if (def.k !== 'choice' && def.k !== 'optional') {
			flat.push(def);
			continue;
		}
		const branches = def.k === 'choice' ? def.options : [def.cost, []];
		const chosen = options?.[choiceIdx++];
		if (chosen === undefined) {
			pendingChoice = true;
			continue;
		}
		if (chosen >= 0 && chosen < branches.length) {
			work.unshift(...branches[chosen]);
		}
	}
	return { flat, pendingChoice };
}

function flattenAllPossiblePitchDefsP20b(defs: CostDef[]): CostDef[] {
	const flat: CostDef[] = [];
	const work: CostDef[] = [...defs];
	for (let guard = 0; guard < 128 && work.length > 0; guard++) {
		const def = work.shift()!;
		if (def.k === 'optional') {
			work.unshift(...def.cost);
		} else if (def.k === 'choice') {
			for (const branch of def.options) work.push(...branch);
		} else {
			flat.push(def);
		}
	}
	return flat;
}

function consumesObjectSlotP20b(d: CostDef, payment?: CostPayment): boolean {
	switch (d.k) {
		case 'sacrifice':
		case 'discard':
		case 'tapOthers':
		case 'untapOthers':
		case 'tapSubsetSum':
		case 'exileFrom':
		case 'revealFromHand':
		case 'returnToHand':
		case 'behold':
		case 'putFromHandOnTopOfLibrary':
		case 'putOnBottomOfLibrary':
		case 'processOpponentExile':
		case 'putExiledWithSelfToGraveyard':
		case 'unattachOther':
			return !('filter' in d && d.filter === 'self');
		case 'removeCounters':
			return d.from !== 'self' && !d.removeAll && !payment?.counterDistribution;
		case 'putCounters':
			return d.on !== 'self';
		default:
			return false;
	}
}

export function isPitchPaymentSettledP20b(
	defs: CostDef[],
	payment: CostPayment | undefined
): boolean {
	if (!payment) return false;
	const { flat, pendingChoice } = flattenChosenCostDefsP20b(defs, payment.options);
	if (pendingChoice) return false;
	let objSlotsNeeded = 0;
	for (const d of flat) {
		if (consumesObjectSlotP20b(d, payment)) objSlotsNeeded += 1;
		if (
			d.k === 'removeCounters' &&
			d.from === 'self' &&
			(d.count.k === 'anyNumber' || d.oneOrMore) &&
			payment.counterCount === undefined
		) {
			return false;
		}
		if (
			d.k === 'removeCounters' &&
			d.from !== 'self' &&
			d.among &&
			payment.counterDistribution === undefined
		) {
			return false;
		}
	}
	if (objSlotsNeeded > 0) {
		if (!payment.objects || payment.objects.length < objSlotsNeeded) return false;
	}
	return true;
}

export function wasAnyAdditionalCostPaidP20b(
	mandatoryAdditionalCosts: CostDef[] | undefined,
	payment: CostPayment | undefined,
	optionalCostCounts: Record<string, number> | undefined
): boolean {
	if (optionalCostCounts && Object.values(optionalCostCounts).some((v) => v > 0)) {
		return true;
	}
	if (!mandatoryAdditionalCosts || mandatoryAdditionalCosts.length === 0) {
		return false;
	}
	const { flat } = flattenChosenCostDefsP20b(mandatoryAdditionalCosts, payment?.options);
	return flat.length > 0;
}

export function computeP20bPitchCountsFromPayment(
	defs: CostDef[],
	payment: CostPayment | undefined
): P20bPitchCounts | undefined {
	if (!payment) return undefined;
	const { flat } = flattenChosenCostDefsP20b(defs, payment.options);
	let objIdx = 0;
	let exiledCostCardCount = 0;
	let sacrificedCostPermCount = 0;
	let removedCostCounterCount = payment.counterCount ?? 0;
	if (payment.counterDistribution) {
		removedCostCounterCount = Object.values(payment.counterDistribution).reduce(
			(a, b) => a + b,
			0
		);
	}

	for (const d of flat) {
		if (!consumesObjectSlotP20b(d, payment)) continue;
		const chosen = payment.objects?.[objIdx];
		objIdx += 1;
		if (!chosen) continue;
		if (d.k === 'exileFrom') {
			exiledCostCardCount += chosen.length;
		} else if (d.k === 'sacrifice') {
			sacrificedCostPermCount += chosen.length;
		} else if (d.k === 'removeCounters' && payment.counterCount === undefined) {
			const c = d.count.k === 'const' ? d.count.n * chosen.length : chosen.length;
			removedCostCounterCount += c;
		}
	}

	return {
		exiledCostCardCount,
		sacrificedCostPermCount,
		removedCostCounterCount
	};
}

export function computeMaxAvailableP20bPitchCounts(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	defs: CostDef[],
	matchesFilter: MatchesFilterFn
): P20bPitchCounts {
	const fctx: FilterContext = {
		state,
		controllerId: actor.playerId,
		source: inst
	};
	const flat = flattenAllPossiblePitchDefsP20b(defs);
	let exiledCostCardCount = 0;
	let sacrificedCostPermCount = 0;
	let removedCostCounterCount = 0;

	for (const d of flat) {
		if (d.k === 'exileFrom' && d.filter !== 'self') {
			const zoneArr =
				d.zone === 'hand'
					? actor.hand
					: d.zone === 'graveyard'
						? actor.graveyard
						: d.zone === 'library'
							? actor.library
							: actor.battlefield;
			const matching = zoneArr.filter(
				(c) => c.instanceId !== inst.instanceId && matchesFilter(c, d.filter as ObjectFilter, fctx)
			);
			const cap = d.count.k === 'const' && !d.oneOrMore ? Math.min(d.count.n, matching.length) : matching.length;
			exiledCostCardCount += cap;
		} else if (d.k === 'sacrifice' && d.filter !== 'self') {
			const matching = actor.battlefield.filter(
				(c) => !c.phasedOut && matchesFilter(c, d.filter as ObjectFilter, fctx)
			);
			const cap =
				d.upTo !== undefined
					? Math.min(d.upTo, matching.length)
					: d.count.k === 'const' && !d.oneOrMore
						? Math.min(d.count.n, matching.length)
						: matching.length;
			sacrificedCostPermCount += cap;
		} else if (d.k === 'removeCounters' && d.from !== 'self') {
			let avail = 0;
			for (const b of actor.battlefield) {
				if (b.phasedOut || !matchesFilter(b, d.from, fctx)) continue;
				avail += totalMatchingCountersP20b(b, d.counter);
			}
			removedCostCounterCount += avail;
		}
	}

	return {
		exiledCostCardCount,
		sacrificedCostPermCount,
		removedCostCounterCount
	};
}

export function evaluateP20bAmount(
	amount: Extract<Amount, { k: 'p20bCostPaidCount' }>,
	ctx: FilterContext
): number {
	const mods = ctx.stackItem?.spellMods;
	switch (amount.kind) {
		case 'exiled':
			return mods?.exiledCostCardCount ?? 0;
		case 'sacrificed':
			return mods?.sacrificedCostPermCount ?? 0;
		case 'removedCounters':
			return ctx.stackItem?.removedCounterCount ?? mods?.removedCostCounterCount ?? 0;
	}
}

function summaryMatchesPermFilter(
	entry: { types: string[]; subtypes: string[]; colors: ManaColor[] },
	filter: ObjectFilter | undefined
): boolean {
	if (!filter) return true;
	if (filter.allTypes && filter.allTypes.length > 0) {
		if (!filter.allTypes.every((t) => entry.types.includes(t))) return false;
	}
	if (filter.types && filter.types.length > 0) {
		if (!filter.types.some((t) => entry.types.includes(t))) return false;
	}
	if (filter.notTypes?.some((t) => entry.types.includes(t))) return false;
	if (filter.subtypes && filter.subtypes.length > 0) {
		if (!filter.subtypes.some((st) => entry.subtypes.includes(st))) return false;
	}
	if (filter.allColors && filter.allColors.length > 0) {
		if (!filter.allColors.every((c) => entry.colors.includes(c))) return false;
	}
	if (filter.colors && filter.colors.length > 0) {
		if (!filter.colors.some((c) => entry.colors.includes(c))) return false;
	}
	if (filter.notColors?.some((c) => entry.colors.includes(c))) return false;
	return true;
}

function cardSnapshotMatchesSpellFilter(
	card: CardInstance['card'],
	filter: ObjectFilter | undefined,
	ctx: FilterContext,
	matchesFilter: MatchesFilterFn
): boolean {
	if (!filter) return true;
	const proxy: CardInstance = {
		instanceId: '__spell_hist__',
		card,
		ownerId: ctx.controllerId,
		controllerId: ctx.controllerId,
		zone: 'stack',
		tapped: false,
		summoningSick: false,
		counters: createEmptyCounterMap(),
		damageMarked: 0,
		deathtouchDamageMarked: false,
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: false,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false
	};
	return matchesFilter(proxy, filter, ctx);
}

export function evaluateP20bCondition(
	cond: Extract<Condition, { k: 'p20bCondition' }>,
	ctx: FilterContext,
	matchesFilter: MatchesFilterFn
): boolean {
	const opponents = ctx.state.players.filter(
		(p) => !p.lost && p.playerId !== ctx.controllerId
	);
	const you = ctx.state.players.find((p) => p.playerId === ctx.controllerId);
	const min = cond.min ?? 1;

	switch (cond.kind) {
		case 'opponentHadPermEnteredThisTurn': {
			return opponents.some((opp) => {
				const list = opp.permanentsEnteredSummaryThisTurn ?? [];
				const count = list.filter((e) => summaryMatchesPermFilter(e, cond.filter)).length;
				return count >= min;
			});
		}
		case 'opponentCastSpellThisTurn': {
			return opponents.some((opp) => {
				if (!cond.filter) return (opp.spellsCastThisTurn ?? 0) >= min;
				const cards = opp.spellsCastThisTurnCards ?? [];
				const count = cards.filter((c) =>
					cardSnapshotMatchesSpellFilter(c, cond.filter, ctx, matchesFilter)
				).length;
				return count >= min;
			});
		}
		case 'opponentDrewCardsAtLeastThisTurn':
			return opponents.some((opp) => (opp.cardsDrawnThisTurn ?? 0) >= min);
		case 'opponentCardsPutIntoGraveyardAtLeastThisTurn':
			return opponents.some((opp) => (opp.cardsPutIntoGraveyardCountThisTurn ?? 0) >= min);
		case 'opponentSearchedLibraryThisTurn':
			return opponents.some((opp) => Boolean(opp.searchedLibraryThisTurn));
		case 'yourCreatureSpellCounteredByOpponentThisTurn':
			return Boolean(you?.creatureSpellCounteredByOpponentThisTurn);
		case 'yourNoncreatureDestroyedByOpponentThisTurn':
			return Boolean(you?.noncreatureDestroyedByOpponentThisTurn);
		case 'dealtDamageByCreaturesAtLeastThisTurn':
			return (you?.creatureDamageSourceIdsThisTurn?.length ?? 0) >= min;
		case 'altCostPaid': {
			const paid = ctx.stackItem?.altCostManaPaid ?? ctx.stackItem?.spellMods?.altCostManaPaid;
			if (!paid) return false;
			if (!cond.manaCost) return true;
			return paid.toUpperCase() === cond.manaCost.toUpperCase();
		}
		case 'additionalCostPaid':
			return Boolean(
				ctx.stackItem?.additionalCostPaid ?? ctx.stackItem?.spellMods?.additionalCostPaid
			);
	}
}

export function hasActiveFirstActivationZeroCost(
	state: GameState,
	actorId: string,
	abilityKeyword: string | undefined
): boolean {
	if (
		abilityKeyword !== 'equip' &&
		abilityKeyword !== 'power-up' &&
		abilityKeyword !== 'cycling'
	) {
		return false;
	}
	const actor = state.players.find((p) => p.playerId === actorId && !p.lost);
	if (!actor) return false;
	const alreadyCount =
		abilityKeyword === 'equip'
			? (actor.equipActivatedCountThisTurn ?? 0)
			: abilityKeyword === 'power-up'
				? (actor.powerUpActivatedCountThisTurn ?? 0)
				: (actor.cycledCardCountThisTurn ?? 0);
	if (alreadyCount > 0) return false;

	const activePlayer = state.players[state.activePlayerIndex];
	const mayGrant = boardMayGrantStaticAbility(state, 'firstActivationZeroCost');

	for (const perm of actor.battlefield) {
		if (perm.phasedOut || evaluatePermanent(state, perm).losesAllAbilities) continue;
		const fctx: FilterContext = { state, controllerId: actorId, source: perm };
		const statics: StaticDef[] = [];
		for (const ab of activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		)) {
			if (ab.kind === 'static' && ab.static.k === 'firstActivationZeroCost') {
				statics.push(ab.static);
			}
		}
		if (mayGrant) {
			for (const g of collectActiveGrantedStaticDefs(state, perm)) {
				if (g.k === 'firstActivationZeroCost') statics.push(g);
			}
		}
		for (const st of statics) {
			if (st.k !== 'firstActivationZeroCost' || st.abilityKeyword !== abilityKeyword) continue;
			if (st.duringYourTurnOnly && activePlayer?.playerId !== actorId) continue;
			if (st.condition && !evaluateCondition(st.condition, fctx)) continue;
			return true;
		}
	}
	return false;
}

export function recordP20bKeywordActivation(
	actor: PlayerGameState,
	abilityKeyword: string | undefined,
	abilityId?: string
): void {
	const kw =
		abilityKeyword ??
		(abilityId?.startsWith('equip_')
			? 'equip'
			: abilityId?.startsWith('cycling_')
				? 'cycling'
				: undefined);
	if (kw === 'equip') {
		actor.equipActivatedCountThisTurn = (actor.equipActivatedCountThisTurn ?? 0) + 1;
	} else if (kw === 'power-up') {
		actor.powerUpActivatedCountThisTurn = (actor.powerUpActivatedCountThisTurn ?? 0) + 1;
	} else if (kw === 'cycling') {
		actor.cycledCardCountThisTurn = (actor.cycledCardCountThisTurn ?? 0) + 1;
	}
}

export function getCommanderTaxLifeCostP20b(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	faceIndex = 0,
	fused = false,
	castFaceDown?: FaceDownSpec
): { applies: boolean; totalLife: number } {
	if (!inst.isCommander || inst.zone !== 'command' || castFaceDown) {
		return { applies: false, totalLife: 0 };
	}
	const card = effectiveCardForObject(inst);
	const fctx: FilterContext = {
		state,
		controllerId: player.playerId,
		source: inst
	};
	for (const ab of activeAbilityDefs(card, { zone: 'stack', faceIndex, fused })) {
		if (ab.kind === 'static' && ab.static.k === 'commanderTaxAsLife') {
			if (ab.static.condition && !evaluateCondition(ab.static.condition, fctx)) continue;
			const castCount =
				player.commanderCastCounts?.[inst.instanceId] ?? inst.commanderCastCount ?? 0;
			return {
				applies: true,
				totalLife: Math.max(0, castCount * ab.static.lifePerCast)
			};
		}
	}
	return { applies: false, totalLife: 0 };
}

export function resetP20bPlayerTurnState(player: PlayerGameState): void {
	delete player.permanentsEnteredSummaryThisTurn;
	delete player.cardsPutIntoGraveyardCountThisTurn;
	delete player.searchedLibraryThisTurn;
	delete player.creatureSpellCounteredByOpponentThisTurn;
	delete player.noncreatureDestroyedByOpponentThisTurn;
	delete player.creatureDamageSourceIdsThisTurn;
	delete player.equipActivatedCountThisTurn;
	delete player.powerUpActivatedCountThisTurn;
	delete player.cycledCardCountThisTurn;
}

export function recordP20bPermanentEnteredBattlefield(
	state: GameState,
	perm: CardInstance
): void {
	const controller = state.players.find((p) => p.playerId === perm.controllerId && !p.lost);
	if (!controller) return;
	const ev = evaluatePermanent(state, perm);
	const types: string[] = [];
	if (ev.isArtifact) types.push('Artifact');
	if (/\bBattle\b/.test(ev.effectiveTypeLine)) types.push('Battle');
	if (ev.isCreature) types.push('Creature');
	if (ev.isEnchantment) types.push('Enchantment');
	if (ev.isLand) types.push('Land');
	if (ev.isPlaneswalker) types.push('Planeswalker');
	if (/\bKindred\b/.test(ev.effectiveTypeLine)) types.push('Kindred');
	const dashIdx = ev.effectiveTypeLine.indexOf('—');
	const subtypes =
		dashIdx >= 0 ? splitSubtypes(ev.effectiveTypeLine.slice(dashIdx + 1).trim()) : [];
	const colors = [...ev.colors];
	(controller.permanentsEnteredSummaryThisTurn ??= []).push({
		types,
		subtypes,
		colors
	});
}

export function recordP20bCardPutIntoGraveyard(
	state: GameState,
	obj: CardInstance
): void {
	const owner = state.players.find((p) => p.playerId === obj.ownerId);
	if (!owner) return;
	owner.cardsPutIntoGraveyardCountThisTurn =
		(owner.cardsPutIntoGraveyardCountThisTurn ?? 0) + 1;
}

export function recordP20bCreatureDamageToPlayer(
	state: GameState,
	targetPlayerId: string,
	sourceId: string,
	amount: number,
	sourceWasCreatureHint?: boolean
): void {
	if (amount <= 0 || !sourceId) return;
	const tp = state.players.find((p) => p.playerId === targetPlayerId && !p.lost);
	if (!tp) return;
	let isCreature = Boolean(sourceWasCreatureHint);
	if (!isCreature) {
		const perm = findBattlefieldPerm(state, sourceId);
		if (perm && evaluatePermanent(state, perm).isCreature) {
			isCreature = true;
		}
	}
	if (!isCreature) return;
	const list = (tp.creatureDamageSourceIdsThisTurn ??= []);
	if (!list.includes(sourceId)) list.push(sourceId);
}
