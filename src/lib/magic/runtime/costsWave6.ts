/**
 * Wave 6 — Track P17b runtime support for generalized cost modifiers (CR 601.2f, CR 118.7),
 * additional & self-pitch alternative costs (CR 118.8, CR 118.9), open-ended counter removal
 * costs (CR 122.1), spelled-out untap costs (CR 302.6, CR 602.2), graveyard/exile/library/stack
 * cost actions (CR 701.59a, CR 701.61a), and modified/shared-characteristic filters (CR 700.9).
 */
import type { Amount, Condition, CostDef, ObjectFilter, StaticDef } from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type SerializedPlannedCost,
	type StackItem,
	type TargetRef
} from '../types.ts';
import { recordLifeGainedThisTurn } from './copyPreventionAndEffects.ts';
import type { CostContext, CostQuestion, PaidCosts } from './costs.ts';
import { emitEvent } from './events.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { onPlayerLostLifeCheckSpeedTrigger } from './framesBattlesAndKeywordsWave5.ts';
import { getObjectKickerInfo } from './kicker.ts';
import { recordPlayerLifeLossWave4 } from './keywordsWave4.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import { splitSubtypes } from './layers.ts';
import {
	evaluateAmount,
	evaluateCondition,
	objectManaValue,
	objectPower,
	type FilterContext
} from './objectFilter.ts';
import { hasRestriction, playerLifeTotalCantChange } from './replace.ts';
import { addCountersForCostOnPermanent } from './staticsAndCostsWave5.ts';
import {
	applyStaticLifeGainModifiers,
	boardMayGrantStaticAbility,
	collectActiveGrantedStaticDefs,
	playerCantGainLife
} from './staticsDynamicAndCosts.ts';
import { markHandCardRevealedToAll } from './staticsLayersAndRestrictions.ts';
// --- Track P20b ---
import { evaluateP20bAmount, evaluateP20bCondition } from './costsWave7.ts';
// --- End Track P20b ---
import { allocateTimestamp, moveObject, type MoveResult, type PlayerZone } from './zones.ts';

const P17B_NON_CREATURE_SUBTYPES = new Set([
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Gate',
	'Locus',
	'Cave',
	'Desert',
	'Sphere',
	'Tower',
	'Mine',
	'Power-Plant',
	"Urza's",
	'Equipment',
	'Treasure',
	'Clue',
	'Food',
	'Blood',
	'Map',
	'Powerstone',
	'Gold',
	'Shard',
	'Lander',
	'Mutagen',
	'Heartwood',
	'Junk',
	'Vibranium',
	'Vehicle',
	'Fortification',
	'Contraption',
	'Attraction',
	'Aura',
	'Saga',
	'Class',
	'Case',
	'Room',
	'Background',
	'Shrine',
	'Role',
	'Cartouche',
	'Curse',
	'Rune',
	'Arcane',
	'Adventure',
	'Lesson',
	'Trap',
	'Chorus',
	'Omen',
	'Siege',
	'Town'
]);

const CARD_TYPES_SET = new Set([
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Instant',
	'Kindred',
	'Land',
	'Planeswalker',
	'Sorcery'
]);

export type MatchesFilterFn = (
	obj: CardInstance,
	filter: ObjectFilter,
	ctx: FilterContext
) => boolean;

function findBattlefieldPerm(state: GameState, id: string): CardInstance | undefined {
	for (const p of state.players) {
		if (p.lost) continue;
		const found = p.battlefield.find((c) => !c.phasedOut && c.instanceId === id);
		if (found) return found;
	}
	return undefined;
}

function getCardTypesOfObject(state: GameState, obj: CardInstance): string[] {
	if (obj.isFaceDown) {
		return obj.zone === 'battlefield' ? ['Creature'] : [];
	}
	if (obj.zone === 'battlefield' && !obj.phasedOut) {
		const ev = evaluatePermanent(state, obj);
		const out: string[] = [];
		if (ev.isArtifact) out.push('Artifact');
		if (ev.isCreature) out.push('Creature');
		if (ev.isEnchantment) out.push('Enchantment');
		if (ev.isLand) out.push('Land');
		if (ev.isPlaneswalker) out.push('Planeswalker');
		if (/\bBattle\b/.test(ev.effectiveTypeLine)) out.push('Battle');
		if (/\bKindred\b|\bTribal\b/.test(ev.effectiveTypeLine)) out.push('Kindred');
		return out;
	}
	const card = effectiveCardForObject(obj);
	const view = resolveObjectFaces(card, instanceFaceOptions(obj, obj.zone));
	return view.types.filter((t) => CARD_TYPES_SET.has(t));
}

function creatureSubtypesOfPerm(
	state: GameState,
	perm: CardInstance
): { hasAll: boolean; subtypes: string[] } {
	const ev = evaluatePermanent(state, perm);
	if (!ev.isCreature) return { hasAll: false, subtypes: [] };
	const subs = splitSubtypes(ev.effectiveTypeLine).filter(
		(s) => !P17B_NON_CREATURE_SUBTYPES.has(s)
	);
	return {
		hasAll: Boolean(ev.hasAllCreatureTypes),
		subtypes: subs
	};
}

// ---- 1. ObjectFilter, Amount & Condition Evaluation -----------------------------------------

export function matchesP17bObjectFilter(
	filter: ObjectFilter,
	obj: CardInstance,
	ctx: FilterContext,
	matchesFilter: MatchesFilterFn
): boolean {
	const { state } = ctx;

	if (filter.allSubtypes?.length) {
		if (obj.zone === 'battlefield' && !obj.phasedOut) {
			const ev = evaluatePermanent(state, obj);
			if (!filter.allSubtypes.every((s) => ev.hasSubType(s))) return false;
		} else {
			const card = effectiveCardForObject(obj);
			const view = resolveObjectFaces(card, instanceFaceOptions(obj, obj.zone));
			const hasChangeling =
				(view.types.includes('Creature') ||
					view.types.includes('Kindred') ||
					view.types.includes('Tribal')) &&
				(view.keywords ?? []).some((k) => k.toLowerCase() === 'changeling');
			const subsLow = new Set(view.subtypes.map((s) => s.toLowerCase()));
			for (const want of filter.allSubtypes) {
				if (subsLow.has(want.toLowerCase())) continue;
				if (hasChangeling && !P17B_NON_CREATURE_SUBTYPES.has(want)) continue;
				return false;
			}
		}
	}

	// CR 700.9: A creature is modified if it is equipped, enchanted by an Aura you control, or has a counter on it.
	if (filter.modified !== undefined) {
		let isMod = false;
		if (obj.zone === 'battlefield' && !obj.phasedOut) {
			const ev = evaluatePermanent(state, obj);
			if (ev.isCreature) {
				const hasCtr = Object.values(obj.counters).some((v) => v > 0);
				let isEq = false;
				let isControlledAura = false;
				if (!hasCtr) {
					for (const p of state.players) {
						if (p.lost) continue;
						for (const w of p.battlefield) {
							if (w.phasedOut || w.attachedToId !== obj.instanceId) continue;
							const wEv = evaluatePermanent(state, w);
							if (wEv.isArtifact && splitSubtypes(wEv.effectiveTypeLine).includes('Equipment')) {
								isEq = true;
								break;
							}
							if (
								wEv.controllerId === ctx.controllerId &&
								wEv.isEnchantment &&
								splitSubtypes(wEv.effectiveTypeLine).includes('Aura')
							) {
								isControlledAura = true;
								break;
							}
						}
						if (isEq || isControlledAura) break;
					}
				}
				isMod = hasCtr || isEq || isControlledAura;
			}
		}
		if (isMod !== filter.modified) return false;
	}

	if (filter.bargainedSpell !== undefined) {
		const tags =
			(obj as CardInstance & { kickedTags?: string[] }).kickedTags ??
			getObjectKickerInfo(state, obj.card, obj.instanceId, undefined, obj).tags;
		const bargained = tags.includes('bargain');
		if (bargained !== filter.bargainedSpell) return false;
	}

	if (filter.targetsAttached !== undefined) {
		const hostId = ctx.source?.attachedToId ?? null;
		const targets = (obj as CardInstance & { targets?: TargetRef[] }).targets ?? [];
		const hitsHost =
			Boolean(hostId) &&
			targets.some((t) => t.kind === 'permanent' && t.id === hostId);
		if (hitsHost !== filter.targetsAttached) return false;
	}

	if (filter.targetsYouOrFilter) {
		const targets = (obj as CardInstance & { targets?: TargetRef[] }).targets ?? [];
		let matched = false;
		for (const t of targets) {
			if (t.kind === 'player' && t.id === ctx.controllerId) {
				matched = true;
				break;
			}
			if (t.kind === 'permanent') {
				const perm = findBattlefieldPerm(state, t.id);
				if (perm && matchesFilter(perm, filter.targetsYouOrFilter, ctx)) {
					matched = true;
					break;
				}
			}
		}
		if (!matched) return false;
	}

	if (filter.sharesCardTypeWithExiled) {
		if (!ctx.source) return false;
		const srcVer = ctx.source.objectVersion ?? 1;
		const objTypes = getCardTypesOfObject(state, obj);
		if (objTypes.length === 0) return false;
		const exiledTypes = new Set<string>();
		for (const p of state.players) {
			for (const ex of p.exile) {
				if (
					ex.exiledBy?.sourceInstanceId === ctx.source.instanceId &&
					ex.exiledBy?.sourceObjectVersion === srcVer
				) {
					for (const t of getCardTypesOfObject(state, ex)) exiledTypes.add(t);
				}
			}
		}
		if (!objTypes.some((t) => exiledTypes.has(t))) return false;
	}

	if (filter.sharesColorWithSpell) {
		const spellColors =
			(ctx as FilterContext & { spellColors?: ManaColor[] }).spellColors ??
			(ctx.source
				? resolveObjectFaces(
						effectiveCardForObject(ctx.source),
						instanceFaceOptions(ctx.source, 'stack')
					).colors
				: []);
		if (spellColors.length === 0 || obj.isFaceDown) return false;
		const objColors =
			obj.zone === 'battlefield' && !obj.phasedOut
				? evaluatePermanent(state, obj).colors
				: resolveObjectFaces(effectiveCardForObject(obj), instanceFaceOptions(obj, obj.zone))
						.colors;
		if (!objColors.some((c) => spellColors.includes(c))) return false;
	}

	return true;
}

function permanentCanProduceColorless(state: GameState, perm: CardInstance): boolean {
	const ev = evaluatePermanent(state, perm);
	if (ev.losesAllAbilities) return false;
	const card = effectiveCardForObject(perm);
	for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
		if (ab.kind !== 'activated' || !ab.isMana) continue;
		for (const step of ab.effect) {
			if (step.verb !== 'addMana') continue;
			if (step.params?.mana?.includes('C')) return true;
			if (step.params?.manaBundles?.some((b) => b.includes('C'))) return true;
			if (
				Array.isArray(step.params?.manaCombinationColors) &&
				step.params.manaCombinationColors.includes('C')
			) {
				return true;
			}
			if (Array.isArray(step.params?.manaChoice) && step.params.manaChoice.includes('C')) {
				return true;
			}
		}
	}
	return false;
}

export function evaluateP17bAmount(
	amount: Extract<Amount, { k: 'p17bMetric' }>,
	ctx: FilterContext,
	matchesFilter: MatchesFilterFn
): number {
	const { state } = ctx;
	const you = state.players.find((p) => p.playerId === ctx.controllerId);
	switch (amount.metric) {
		case 'distinctManaValuesInGraveyard': {
			if (!you) return 0;
			const mvs = new Set<number>();
			for (const c of you.graveyard) {
				if (ctx.source && ctx.source.zone === 'stack' && c.instanceId === ctx.source.instanceId) {
					continue;
				}
				if (amount.filter && !matchesFilter(c, amount.filter, ctx)) continue;
				mvs.add(objectManaValue(state, c));
			}
			return mvs.size;
		}
		case 'distinctCreatureTypesControlled': {
			if (!you) return 0;
			const subs = new Set<string>();
			for (const perm of you.battlefield) {
				if (perm.phasedOut) continue;
				if (amount.filter && !matchesFilter(perm, amount.filter, ctx)) continue;
				const info = creatureSubtypesOfPerm(state, perm);
				if (info.hasAll) return 300;
				for (const s of info.subtypes) subs.add(s.toLowerCase());
			}
			return subs.size;
		}
		case 'distinctLandNamesControlled': {
			if (!you) return 0;
			const names = new Set<string>();
			for (const perm of you.battlefield) {
				if (perm.phasedOut || perm.isFaceDown) continue;
				const ev = evaluatePermanent(state, perm);
				if (!ev.isLand) continue;
				if (amount.filter && !matchesFilter(perm, amount.filter, ctx)) continue;
				names.add(ev.effectiveName.toLowerCase());
			}
			return names.size;
		}
		case 'distinctNamesControlled': {
			if (!you) return 0;
			const names = new Set<string>();
			for (const perm of you.battlefield) {
				if (perm.phasedOut || perm.isFaceDown) continue;
				if (amount.filter && !matchesFilter(perm, amount.filter, ctx)) continue;
				names.add(evaluatePermanent(state, perm).effectiveName.toLowerCase());
			}
			return names.size;
		}
		case 'countersAmongPlayersAndPermanents': {
			let total = 0;
			for (const p of state.players) {
				if (p.lost) continue;
				total +=
					Math.max(0, p.poison || 0) +
					Math.max(0, p.experienceCounters || 0) +
					Math.max(0, p.energyCounters || 0);
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					for (const n of Object.values(perm.counters)) {
						if (n > 0) total += n;
					}
				}
			}
			return total;
		}
		case 'lifeGainedThisTurn':
			return Math.max(0, you?.lifeGainedThisTurn ?? 0);
		case 'startingLifeDifference': {
			if (!you) return 0;
			return Math.max(0, state.rules.startingLife - you.life);
		}
		case 'creaturesAttackedWithThisTurn': {
			const activeId = state.players[state.activePlayerIndex]?.playerId;
			if (activeId !== ctx.controllerId) return 0;
			return Math.max(0, state.creaturesAttackedCountThisTurn ?? 0);
		}
		case 'creaturesAttackedTotalThisTurn':
			return Math.max(0, state.creaturesAttackedCountThisTurn ?? 0);
		case 'opponentsDealtDamageThisTurn': {
			let count = 0;
			for (const opp of state.players) {
				if (opp.lost || opp.playerId === ctx.controllerId) continue;
				if ((opp.damageDealtToThisTurn ?? 0) > 0) count += 1;
			}
			return count;
		}
		case 'commanderColorIdentityCount': {
			if (!you) return 0;
			const cols = new Set<string>();
			for (const c of you.commanderColorIdentity ?? []) {
				if (c === 'W' || c === 'U' || c === 'B' || c === 'R' || c === 'G') cols.add(c);
			}
			return cols.size;
		}
		case 'landsOpponentControlsProducingColorless': {
			let count = 0;
			for (const opp of state.players) {
				if (opp.lost || opp.playerId === ctx.controllerId) continue;
				for (const perm of opp.battlefield) {
					if (perm.phasedOut) continue;
					const ev = evaluatePermanent(state, perm);
					if (ev.isLand && permanentCanProduceColorless(state, perm)) count += 1;
				}
			}
			return count;
		}
		case 'sameNameInGraveyardAsSpell': {
			if (!you || !ctx.source) return 0;
			const spellName = resolveObjectFaces(
				effectiveCardForObject(ctx.source),
				instanceFaceOptions(ctx.source, 'stack')
			).name.toLowerCase();
			let count = 0;
			for (const g of you.graveyard) {
				if (g.instanceId === ctx.source.instanceId || g.isFaceDown) continue;
				const gName = resolveObjectFaces(
					effectiveCardForObject(g),
					instanceFaceOptions(g, 'graveyard')
				).name.toLowerCase();
				if (gName === spellName) count += 1;
			}
			return count;
		}
		case 'targetsCount': {
			const targets =
				(ctx as FilterContext & { spellTargets?: TargetRef[] }).spellTargets ??
				(ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)?.targets ??
				ctx.stackItem?.targets ??
				[];
			return targets.length;
		}
		case 'targetsMatchingCount': {
			const targets =
				(ctx as FilterContext & { spellTargets?: TargetRef[] }).spellTargets ??
				(ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)?.targets ??
				ctx.stackItem?.targets ??
				[];
			if (!amount.filter) return targets.length;
			let count = 0;
			for (const t of targets) {
				if (t.kind === 'permanent') {
					const perm = findBattlefieldPerm(state, t.id);
					if (perm && matchesFilter(perm, amount.filter, ctx)) count += 1;
				}
			}
			return count;
		}
		case 'targetColorsCount': {
			const targets =
				(ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)?.targets ??
				ctx.stackItem?.targets ??
				[];
			const cols = new Set<ManaColor>();
			for (const t of targets) {
				if (t.kind === 'permanent') {
					const perm = findBattlefieldPerm(state, t.id);
					if (perm) {
						for (const c of evaluatePermanent(state, perm).colors) cols.add(c);
					}
				}
			}
			return cols.size;
		}
		case 'targetCounterCount': {
			const targets =
				(ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)?.targets ??
				ctx.stackItem?.targets ??
				[];
			let total = 0;
			for (const t of targets) {
				if (t.kind === 'permanent') {
					const perm = findBattlefieldPerm(state, t.id);
					if (perm) {
						total += totalMatchingCountersWave6(perm, amount.counter ?? 'any');
					}
				}
			}
			return total;
		}
		case 'targetPower': {
			const targets =
				(ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)?.targets ??
				ctx.stackItem?.targets ??
				[];
			let sum = 0;
			for (const t of targets) {
				if (t.kind === 'permanent') {
					const perm = findBattlefieldPerm(state, t.id);
					if (perm) sum += Math.max(0, objectPower(state, perm) ?? 0);
				}
			}
			return sum;
		}
		// --- Track P20b ---
		case 'exiledCostCardCount':
			return evaluateP20bAmount({ k: 'p20bCostPaidCount', kind: 'exiled' }, ctx);
		case 'sacrificedCostPermCount':
			return evaluateP20bAmount({ k: 'p20bCostPaidCount', kind: 'sacrificed' }, ctx);
		case 'removedCostCounterCount':
			return evaluateP20bAmount({ k: 'p20bCostPaidCount', kind: 'removedCounters' }, ctx);
		// --- End Track P20b ---
	}
}

function compareOp(val: number, op: '>=' | '==' | '<=' | undefined, target: number): boolean {
	switch (op ?? '>=') {
		case '>=':
			return val >= target;
		case '==':
			return val === target;
		case '<=':
			return val <= target;
	}
}

export function evaluateP17bCondition(
	cond: Extract<Condition, { k: 'p17bCondition' }>,
	ctx: FilterContext,
	matchesFilter: MatchesFilterFn
): boolean {
	const { state } = ctx;
	const you = state.players.find((p) => p.playerId === ctx.controllerId);
	switch (cond.kind) {
		case 'notStartingPlayer': {
			const starter = state.startingPlayerId ?? state.players[0]?.playerId;
			return Boolean(starter && starter !== ctx.controllerId);
		}
		case 'notYourTurn':
		case 'notSpellControllerTurn': {
			const activeId = state.players[state.activePlayerIndex]?.playerId;
			return activeId !== ctx.controllerId;
		}
		case 'opponentGainedLifeThisTurn': {
			const min = cond.n ?? 1;
			return state.players.some(
				(p) => !p.lost && p.playerId !== ctx.controllerId && (p.lifeGainedThisTurn ?? 0) >= min
			);
		}
		case 'opponentCastSpellsAtLeast': {
			const min = cond.n ?? 1;
			return state.players.some(
				(p) => !p.lost && p.playerId !== ctx.controllerId && (p.spellsCastThisTurn ?? 0) >= min
			);
		}
		case 'opponentControlsAtLeastNMore': {
			if (!you) return false;
			const f = cond.filter ?? {};
			const delta = cond.n ?? 1;
			const yours = you.battlefield.filter(
				(perm) => !perm.phasedOut && matchesFilter(perm, { ...f, controller: 'you' }, ctx)
			).length;
			for (const opp of state.players) {
				if (opp.lost || opp.playerId === ctx.controllerId) continue;
				const oppCtx: FilterContext = { ...ctx, controllerId: opp.playerId };
				const theirs = opp.battlefield.filter(
					(perm) => !perm.phasedOut && matchesFilter(perm, { ...f, controller: 'you' }, oppCtx)
				).length;
				if (theirs >= yours + delta) return true;
			}
			return false;
		}
		case 'attackingCount': {
			let count = 0;
			for (const atk of state.combat.attackers) {
				const perm = findBattlefieldPerm(state, atk.attackerInstanceId);
				if (!perm) continue;
				if (cond.filter && !matchesFilter(perm, cond.filter, ctx)) continue;
				count += 1;
			}
			return compareOp(count, cond.op, cond.n ?? 1);
		}
		case 'attackingYouCount': {
			let count = 0;
			for (const atk of state.combat.attackers) {
				if (atk.defenderPlayerId !== ctx.controllerId) continue;
				const perm = findBattlefieldPerm(state, atk.attackerInstanceId);
				if (!perm) continue;
				if (cond.filter && !matchesFilter(perm, cond.filter, ctx)) continue;
				count += 1;
			}
			return compareOp(count, cond.op, cond.n ?? 1);
		}
		case 'noMatchingCardsInHand': {
			if (!you) return false;
			const excludeId = ctx.source?.zone === 'stack' ? ctx.source.instanceId : undefined;
			return !you.hand.some(
				(c) =>
					c.instanceId !== excludeId && (!cond.filter || matchesFilter(c, cond.filter, ctx))
			);
		}
		case 'onlyNamedOrNoMatchingInHand': {
			if (!you) return false;
			const excludeId = ctx.source?.zone === 'stack' ? ctx.source.instanceId : undefined;
			const allowedName = ctx.source
				? resolveObjectFaces(
						effectiveCardForObject(ctx.source),
						instanceFaceOptions(ctx.source, 'stack')
					).name.toLowerCase()
				: '';
			for (const c of you.hand) {
				if (c.instanceId === excludeId) continue;
				if (cond.filter && !matchesFilter(c, cond.filter, ctx)) continue;
				const cName = resolveObjectFaces(
					effectiveCardForObject(c),
					instanceFaceOptions(c, 'hand')
				).name.toLowerCase();
				if (!allowedName || cName !== allowedName) return false;
			}
			return true;
		}
		case 'spellWasBargained': {
			if (!ctx.source) return false;
			const tags =
				(ctx.source as CardInstance & { kickedTags?: string[] }).kickedTags ??
				getObjectKickerInfo(state, ctx.source.card, ctx.source.instanceId, undefined, ctx.source)
					.tags;
			return tags.includes('bargain');
		}
		case 'abilityTargetsFilter': {
			const targets =
				(ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)?.targets ??
				ctx.stackItem?.targets ??
				[];
			if (!cond.filter) return targets.length > 0;
			for (const t of targets) {
				if (t.kind === 'permanent') {
					const perm = findBattlefieldPerm(state, t.id);
					if (perm && matchesFilter(perm, cond.filter, ctx)) return true;
				}
			}
			return false;
		}
		case 'targetsStackSpell': {
			const explicitTargets = (ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)
				?.targets;
			const matchStackItem = (item: StackItem): boolean => {
				if (item.kind !== 'spell' || !item.card) return false;
				if (!cond.filter) return true;
				const kickerInfo = getObjectKickerInfo(state, item.card, item.id, item);
				const proxy = {
					instanceId: item.id,
					card: item.card,
					ownerId: item.controllerId,
					controllerId: item.controllerId,
					zone: 'stack' as const,
					tapped: false,
					summoningSick: false,
					counters: {},
					damageMarked: 0,
					attachedToId: null,
					isToken: false,
					kickedCount: kickerInfo.count,
					kickedTags: kickerInfo.tags,
					xValue: item.xValue,
					castFromZone: item.castFromZone
				} as unknown as CardInstance;
				return matchesFilter(proxy, cond.filter, ctx);
			};
			if (explicitTargets !== undefined) {
				for (const t of explicitTargets) {
					if (t.kind !== 'stack') continue;
					const item = state.stack.find((s) => s.id === t.id);
					if (item && matchStackItem(item)) return true;
				}
				return false;
			}
			// Pre-target speculative affordability check: true iff a matching spell is currently on the stack.
			return state.stack.some(matchStackItem);
		}
		// --- Track P20b ---
		case 'altCostPaid':
			return evaluateP20bCondition(
				{ k: 'p20bCondition', kind: 'altCostPaid', manaCost: cond.manaCost },
				ctx,
				matchesFilter
			);
		case 'additionalCostPaid':
			return evaluateP20bCondition(
				{ k: 'p20bCondition', kind: 'additionalCostPaid' },
				ctx,
				matchesFilter
			);
		// --- End Track P20b ---
	}
}

// ---- 2. Open-Ended Counter Counting & Deduction (CR 122.1) ----------------------------------

export function totalMatchingCountersWave6(
	perm: CardInstance,
	counter: CounterType | 'any'
): number {
	if (counter !== 'any') return perm.counters[counter] || 0;
	let sum = 0;
	for (const val of Object.values(perm.counters)) {
		if (val > 0) sum += val;
	}
	return sum;
}

export function deductMatchingCountersWave6(
	state: GameState,
	perm: CardInstance,
	counter: CounterType | 'any',
	toRemove: number
): number {
	if (toRemove <= 0) return 0;
	let removedTotal = 0;
	const keys: CounterType[] =
		counter === 'any' ? (Object.keys(perm.counters).sort() as CounterType[]) : [counter];
	for (const key of keys) {
		if (removedTotal >= toRemove) break;
		const prev = perm.counters[key] || 0;
		if (prev <= 0) continue;
		const take = Math.min(prev, toRemove - removedTotal);
		const next = prev - take;
		perm.counters[key] = next;
		removedTotal += take;
		if (perm.zone === 'battlefield' && !perm.phasedOut) {
			emitEvent(state, {
				kind: 'CounterRemoved',
				objectId: perm.instanceId,
				object: perm,
				counterType: key,
				amount: take,
				previousCount: prev,
				newCount: next
			});
		}
	}
	if (removedTotal > 0) {
		noteLayerInputsChanged(state);
	}
	return removedTotal;
}

// ---- 3. Wave 6 Cost Descriptions, Legality, Planning & Execution ----------------------------

function amtShort(a: Amount): string {
	return a.k === 'const'
		? String(a.n)
		: a.k === 'x'
			? 'X'
			: a.k === 'anyNumber'
				? 'any number of'
				: 'N';
}

export function describeP17bCost(def: CostDef): string | null {
	switch (def.k) {
		case 'untapSelf':
			return def.viaSymbol === false ? 'Untap this' : null;
		case 'sacrifice':
			if (def.attachedCreature) return 'Sacrifice attached creature';
			if (def.sacrificeAll) return 'Sacrifice all matching permanents you control';
			if (def.halfRoundedUp) return 'Sacrifice half the matching permanents you control, rounded up';
			return null;
		case 'payLife':
			return def.halfLifeRoundedUp ? 'Pay half your life, rounded up' : null;
		case 'exileFrom':
			if (def.collectEvidence && def.minTotalManaValue !== undefined) {
				return `Collect evidence ${def.minTotalManaValue}`;
			}
			if (def.minTotalManaValue !== undefined) {
				return `Exile cards from your graveyard with total mana value ${def.minTotalManaValue} or greater`;
			}
			if (def.fromTop) {
				return `Exile top ${amtShort(def.count)} card(s) of your ${def.zone}`;
			}
			if (def.singleGraveyard) {
				return `Exile ${amtShort(def.count)} card(s) from a single graveyard`;
			}
			if (def.anyGraveyard) {
				return `Exile ${amtShort(def.count)} card(s) from a graveyard`;
			}
			if (def.zone === 'stack') {
				return `Exile ${amtShort(def.count)} spell(s) you control`;
			}
			return null;
		case 'choice':
			return def.forage ? 'Forage' : null;
		case 'untapOthers':
			return `Untap ${amtShort(def.count)} tapped permanent(s) you control`;
		case 'revealHand':
			return 'Reveal your hand';
		case 'opponentGainsLife':
			return def.eachOtherPlayer
				? `Each other player gains ${amtShort(def.amount)} life`
				: `An opponent gains ${amtShort(def.amount)} life`;
		case 'putOnBottomOfLibrary':
			return def.filter === 'self'
				? "Put this on the bottom of its owner's library"
				: `Put ${amtShort(def.count)} card(s) from your ${def.from} on the bottom of your library`;
		case 'processOpponentExile':
			return `Put ${amtShort(def.count)} card(s) an opponent owns from exile into their graveyard`;
		case 'putExiledWithSelfToGraveyard':
			return `Put ${amtShort(def.count)} card(s) exiled with this into their owner's graveyard`;
		default:
			return null;
	}
}

function evalAmt(amount: Amount, ctx: CostContext): number {
	return Math.max(
		0,
		evaluateAmount(amount, {
			state: ctx.state,
			controllerId: ctx.player.playerId,
			source: ctx.source,
			xValue: ctx.xValue
		})
	);
}

function makeStackSpellProxy(item: StackItem): CardInstance {
	return {
		instanceId: item.id,
		card: item.card,
		ownerId: item.ownerId ?? item.controllerId,
		controllerId: item.controllerId,
		zone: 'stack',
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters: createEmptyCounterMap(),
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: false,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		activeFaceIndex: item.faceIndex,
		...(item.fused
			? { copiableState: { card: item.card, faceIndex: item.faceIndex ?? 0, fused: true } }
			: {})
	};
}

function selectFromTopOfZone(
	ctx: CostContext,
	def: Extract<CostDef, { k: 'exileFrom' }>,
	matchesFilter: MatchesFilterFn
): CardInstance[] | null {
	const need = evalAmt(def.count, ctx);
	if (need === 0) return [];
	const filter = typeof def.filter === 'object' ? def.filter : undefined;
	const fctx: FilterContext = {
		state: ctx.state,
		controllerId: ctx.player.playerId,
		source: ctx.source,
		xValue: ctx.xValue
	};
	if (def.zone === 'library') {
		if (ctx.player.library.length < need) return null;
		if (!filter) return ctx.player.library.slice(0, need);
		const picked: CardInstance[] = [];
		for (const c of ctx.player.library) {
			if (matchesFilter(c, filter, fctx)) {
				picked.push(c);
				if (picked.length === need) return picked;
			}
		}
		return null;
	}
	if (def.zone === 'graveyard') {
		const gy = ctx.player.graveyard;
		const picked: CardInstance[] = [];
		for (let i = gy.length - 1; i >= 0; i--) {
			const c = gy[i];
			if (ctx.isSpell && c.instanceId === ctx.source.instanceId) continue;
			if (ctx.source.zone === 'graveyard' && c.instanceId === ctx.source.instanceId) continue;
			if (filter && !matchesFilter(c, filter, fctx)) continue;
			picked.push(c);
			if (picked.length === need) return picked;
		}
		return picked.length === need ? picked : null;
	}
	return null;
}

export function checkSimpleP17bCost(
	def: CostDef,
	ctx: CostContext,
	matchesFilter: MatchesFilterFn
): { handled: boolean; error: string | null } {
	const src = ctx.source;
	const name = src.isFaceDown ? (src.faceDownLabel || 'Face-Down Permanent') : src.card.name;

	if (def.k === 'payLife' && def.halfLifeRoundedUp) {
		const amount = Math.ceil(Math.max(0, ctx.player.life) / 2);
		if (amount === 0) return { handled: true, error: null };
		if (playerLifeTotalCantChange(ctx.state, ctx.player)) {
			return {
				handled: true,
				error: `Your life total can't change, so you can't pay ${amount} life.`
			};
		}
		if (ctx.player.life < amount) {
			return { handled: true, error: `Not enough life to pay ${amount} life.` };
		}
		return { handled: true, error: null };
	}

	if (def.k === 'sacrifice') {
		if (def.attachedCreature) {
			if (!src.attachedToId) {
				return { handled: true, error: `${name} is not attached to a creature.` };
			}
			const host = ctx.player.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === src.attachedToId
			);
			if (!host || !evaluatePermanent(ctx.state, host).isCreature) {
				return {
					handled: true,
					error: `${name} is not attached to a creature you control.`
				};
			}
			return { handled: true, error: null };
		}
		if (def.sacrificeAll) {
			return { handled: true, error: null };
		}
	}

	if (def.k === 'exileFrom' && def.fromTop) {
		const topCards = selectFromTopOfZone(ctx, def, matchesFilter);
		if (!topCards) {
			return {
				handled: true,
				error: `Not enough matching cards in your ${def.zone} to exile.`
			};
		}
		return { handled: true, error: null };
	}

	if (def.k === 'revealHand') {
		return { handled: true, error: null };
	}

	if (def.k === 'opponentGainsLife') {
		const amt = evalAmt(def.amount, ctx);
		const opps = ctx.state.players.filter(
			(p) => !p.lost && p.playerId !== ctx.player.playerId
		);
		if (def.eachOtherPlayer) {
			if (amt > 0 && opps.some((opp) => playerCantGainLife(ctx.state, opp.playerId))) {
				return {
					handled: true,
					error: "Another player can't gain life, so you can't pay that cost."
				};
			}
			return { handled: true, error: null };
		}
		if (opps.length === 0) {
			return { handled: true, error: 'No opponent available to gain life.' };
		}
		if (amt > 0 && !opps.some((opp) => !playerCantGainLife(ctx.state, opp.playerId))) {
			return { handled: true, error: "Opponents can't gain life, so you can't pay that cost." };
		}
		return { handled: true, error: null };
	}

	if (def.k === 'putOnBottomOfLibrary') {
		if (def.filter === 'self') {
			if (def.from === 'battlefield') {
				const onBoard =
					!ctx.isSpell &&
					ctx.player.battlefield.some((c) => !c.phasedOut && c.instanceId === src.instanceId);
				return {
					handled: true,
					error: onBoard ? null : `${name} must be on the battlefield.`
				};
			}
			const inZone = ctx.player[def.from].some((c) => c.instanceId === src.instanceId);
			return {
				handled: true,
				error: inZone ? null : `${name} must be in your ${def.from}.`
			};
		}
		return { handled: true, error: null };
	}

	return { handled: false, error: null };
}

export function isP17bObjectCostDef(def: CostDef): boolean {
	return (
		def.k === 'untapOthers' ||
		def.k === 'putOnBottomOfLibrary' ||
		def.k === 'processOpponentExile' ||
		def.k === 'putExiledWithSelfToGraveyard'
	);
}

function candidatesShareCreatureType(
	state: GameState,
	candidates: CardInstance[],
	need: number
): CardInstance[] {
	if (need <= 1) return candidates;
	const infos = new Map<string, { hasAll: boolean; subtypes: string[] }>();
	for (const c of candidates) {
		infos.set(c.instanceId, creatureSubtypesOfPerm(state, c));
	}
	const anyTypeCreatures = candidates.filter((c) => {
		const info = infos.get(c.instanceId)!;
		return info.hasAll || info.subtypes.length > 0;
	});
	const allTypeCount = anyTypeCreatures.filter((c) => infos.get(c.instanceId)!.hasAll).length;
	if (allTypeCount >= need) return anyTypeCreatures;
	if (allTypeCount === need - 1 && anyTypeCreatures.length >= need) return anyTypeCreatures;

	const allSubtypes = new Set<string>();
	for (const c of anyTypeCreatures) {
		for (const s of infos.get(c.instanceId)!.subtypes) {
			allSubtypes.add(s.toLowerCase());
		}
	}
	const validIds = new Set<string>();
	for (const sub of allSubtypes) {
		const group = anyTypeCreatures.filter((c) => {
			const info = infos.get(c.instanceId)!;
			return info.hasAll || info.subtypes.some((s) => s.toLowerCase() === sub);
		});
		if (group.length >= need) {
			for (const g of group) validIds.add(g.instanceId);
		}
	}
	return candidates.filter((c) => validIds.has(c.instanceId));
}

export function chosenShareCreatureType(state: GameState, chosen: CardInstance[]): boolean {
	if (chosen.length <= 1) return true;
	const infos = chosen.map((c) => creatureSubtypesOfPerm(state, c));
	if (infos.some((i) => !i.hasAll && i.subtypes.length === 0)) return false;
	const nonAll = infos.filter((i) => !i.hasAll);
	if (nonAll.length <= 1) return true;
	const firstSubs = nonAll[0].subtypes.map((s) => s.toLowerCase());
	return firstSubs.some((sub) =>
		nonAll.every((i) => i.subtypes.some((s) => s.toLowerCase() === sub))
	);
}

export function p17bObjectCandidates(
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
	const free = (c: CardInstance) =>
		!used.has(c.instanceId) && !(ctx.isSpell && c.instanceId === ctx.source.instanceId);

	if (def.k === 'tapOthers' && def.shareCreatureType) {
		const base = ctx.player.battlefield.filter(
			(c) => free(c) && !c.phasedOut && !c.tapped && matchesFilter(c, def.filter, fctx)
		);
		return {
			handled: true,
			candidates: candidatesShareCreatureType(ctx.state, base, evalAmt(def.count, ctx))
		};
	}

	if (def.k === 'sacrifice') {
		if (def.attachedCreature || def.sacrificeAll) {
			return { handled: true, candidates: null };
		}
	}

	if (def.k === 'discard' && def.filter !== 'self') {
		if (def.sameNamePair) {
			const filter = def.filter;
			const base = ctx.player.hand.filter(
				(c) => free(c) && !c.isFaceDown && (!filter || matchesFilter(c, filter, fctx))
			);
			const byName = new Map<string, CardInstance[]>();
			for (const c of base) {
				const key = resolveObjectFaces(
					effectiveCardForObject(c),
					instanceFaceOptions(c, 'hand')
				).name.toLowerCase();
				const arr = byName.get(key) ?? [];
				arr.push(c);
				byName.set(key, arr);
			}
			return {
				handled: true,
				candidates: base.filter((c) => {
					const key = resolveObjectFaces(
						effectiveCardForObject(c),
						instanceFaceOptions(c, 'hand')
					).name.toLowerCase();
					return (byName.get(key)?.length ?? 0) >= 2;
				})
			};
		}
		if (def.sameNameAsControlledFilter) {
			const ctrlFilter = def.sameNameAsControlledFilter;
			const controlledNames = new Set<string>();
			for (const perm of ctx.player.battlefield) {
				if (perm.phasedOut || perm.isFaceDown) continue;
				if (!matchesFilter(perm, { ...ctrlFilter, controller: 'you' }, fctx)) continue;
				controlledNames.add(evaluatePermanent(ctx.state, perm).effectiveName.toLowerCase());
			}
			const filter = def.filter;
			return {
				handled: true,
				candidates: ctx.player.hand.filter((c) => {
					if (!free(c) || c.isFaceDown) return false;
					if (filter && !matchesFilter(c, filter, fctx)) return false;
					const cName = resolveObjectFaces(
						effectiveCardForObject(c),
						instanceFaceOptions(c, 'hand')
					).name.toLowerCase();
					return controlledNames.has(cName);
				})
			};
		}
	}

	if (def.k === 'exileFrom') {
		if (def.fromTop) {
			return { handled: true, candidates: null };
		}
		if (def.zone === 'stack') {
			const filter = typeof def.filter === 'object' ? def.filter : undefined;
			const out: CardInstance[] = [];
			for (const item of ctx.state.stack) {
				if (item.kind !== 'spell' || item.controllerId !== ctx.player.playerId) continue;
				if (item.sourceInstanceId === ctx.source.instanceId) continue;
				if (used.has(item.id) || used.has(item.sourceInstanceId)) continue;
				const proxy = makeStackSpellProxy(item);
				if (filter && !matchesFilter(proxy, filter, fctx)) continue;
				out.push(proxy);
			}
			return { handled: true, candidates: out };
		}
		if (def.anyGraveyard || def.singleGraveyard) {
			const filter = typeof def.filter === 'object' ? def.filter : undefined;
			const need = evalAmt(def.count, ctx);
			const out: CardInstance[] = [];
			for (const p of ctx.state.players) {
				if (p.lost) continue;
				const pMatches = p.graveyard.filter(
					(c) =>
						free(c) &&
						!(ctx.source.zone === 'graveyard' && c.instanceId === ctx.source.instanceId) &&
						(!filter || matchesFilter(c, filter, fctx))
				);
				if (def.singleGraveyard && pMatches.length < need) continue;
				out.push(...pMatches);
			}
			return { handled: true, candidates: out };
		}
	}

	if (def.k === 'untapOthers') {
		return {
			handled: true,
			candidates: ctx.player.battlefield.filter(
				(c) =>
					free(c) &&
					!c.phasedOut &&
					c.tapped &&
					matchesFilter(c, { ...def.filter, controller: 'you' }, fctx)
			)
		};
	}

	if (def.k === 'putOnBottomOfLibrary') {
		if (def.filter === 'self') return { handled: true, candidates: null };
		const filter = def.filter;
		const zoneArr = ctx.player[def.from];
		return {
			handled: true,
			candidates: zoneArr.filter(
				(c) =>
					free(c) &&
					(def.from !== 'battlefield' || !c.phasedOut) &&
					!(def.from === 'graveyard' && ctx.source.zone === 'graveyard' && c.instanceId === ctx.source.instanceId) &&
					(!filter ||
						matchesFilter(
							c,
							def.from === 'battlefield' ? { ...filter, controller: 'you' } : filter,
							fctx
						))
			)
		};
	}

	if (def.k === 'processOpponentExile') {
		const oppIds = new Set(
			ctx.state.players
				.filter((p) => !p.lost && p.playerId !== ctx.player.playerId)
				.map((p) => p.playerId)
		);
		const out: CardInstance[] = [];
		for (const p of ctx.state.players) {
			for (const c of p.exile) {
				if (!free(c) || !oppIds.has(c.ownerId)) continue;
				if (def.filter && !matchesFilter(c, def.filter, fctx)) continue;
				out.push(c);
			}
		}
		return { handled: true, candidates: out };
	}

	if (def.k === 'putExiledWithSelfToGraveyard') {
		const srcVer = ctx.source.objectVersion ?? 1;
		const out: CardInstance[] = [];
		for (const p of ctx.state.players) {
			for (const c of p.exile) {
				if (!free(c)) continue;
				if (
					c.exiledBy?.sourceInstanceId !== ctx.source.instanceId ||
					c.exiledBy?.sourceObjectVersion !== srcVer
				) {
					continue;
				}
				if (def.filter && !matchesFilter(c, def.filter, fctx)) continue;
				out.push(c);
			}
		}
		return { handled: true, candidates: out };
	}

	return { handled: false, candidates: null };
}

export function planP17bSpecialCostPart(
	def: CostDef,
	candidates: CardInstance[],
	ctx: CostContext,
	used: Set<string>,
	objects: string[][] | undefined,
	objectIndex: number,
	describeOne: (d: CostDef) => string
):
	| {
			handled: true;
			result:
				| { ok: false; error: string }
				| { ok: true; question: CostQuestion }
				| { ok: true; chosen: CardInstance[]; nextObjectIndex: number };
	  }
	| { handled: false } {
	// 1. Collect evidence N / exile graveyard subset with total mana value >= minTotalManaValue
	if (def.k === 'exileFrom' && def.minTotalManaValue !== undefined) {
		const minTotal = def.minTotalManaValue;
		const candidateWeights = withStableLayerInputs(ctx.state, () => {
			const weights: Record<string, number> = {};
			for (const c of candidates) {
				weights[c.instanceId] = Math.max(0, objectManaValue(ctx.state, c));
			}
			return weights;
		});
		const maxAchievable = candidates.reduce(
			(sum, c) => sum + (candidateWeights[c.instanceId] ?? 0),
			0
		);
		if (maxAchievable < minTotal) {
			return {
				handled: true,
				result: {
					ok: false,
					error: `Can't pay the cost: ${describeOne(def)} (insufficient total mana value).`
				}
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		if (chosenIds !== undefined) {
			if (new Set(chosenIds).size !== chosenIds.length) {
				return {
					handled: true,
					result: { ok: false, error: `Duplicate choice for: ${describeOne(def)}.` }
				};
			}
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			if (chosenIds.some((id) => !byId.has(id))) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeOne(def)}.` }
				};
			}
			const sum = chosenIds.reduce((acc, id) => acc + (candidateWeights[id] ?? 0), 0);
			if (sum < minTotal) {
				return {
					handled: true,
					result: {
						ok: false,
						error: `Selected total mana value is ${sum}; need at least ${minTotal}.`
					}
				};
			}
			const chosen = chosenIds.map((id) => byId.get(id)!);
			for (const c of chosen) used.add(c.instanceId);
			return {
				handled: true,
				result: { ok: true, chosen, nextObjectIndex: objectIndex + 1 }
			};
		}
		if (minTotal <= 0) {
			return {
				handled: true,
				result: { ok: true, chosen: [], nextObjectIndex: objectIndex + 1 }
			};
		}
		return {
			handled: true,
			result: {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeOne(def),
					count: 1,
					candidateIds: candidates.map((c) => c.instanceId),
					minTotal,
					metric: 'manaValue',
					candidateWeights
				}
			}
		};
	}

	// 2. Sacrifice half the <filter> you control, rounded up
	if (def.k === 'sacrifice' && def.halfRoundedUp) {
		const count = Math.ceil(candidates.length / 2);
		if (count === 0) {
			return {
				handled: true,
				result: { ok: true, chosen: [], nextObjectIndex: objectIndex }
			};
		}
		const index = objectIndex;
		const chosenIds = objects?.[index];
		if (chosenIds !== undefined) {
			if (new Set(chosenIds).size !== chosenIds.length || chosenIds.length !== count) {
				return {
					handled: true,
					result: { ok: false, error: `Choose exactly ${count} for: ${describeOne(def)}.` }
				};
			}
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			if (chosenIds.some((id) => !byId.has(id))) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeOne(def)}.` }
				};
			}
			const chosen = chosenIds.map((id) => byId.get(id)!);
			for (const c of chosen) used.add(c.instanceId);
			return {
				handled: true,
				result: { ok: true, chosen, nextObjectIndex: objectIndex + 1 }
			};
		}
		if (candidates.length === count) {
			for (const c of candidates) used.add(c.instanceId);
			return {
				handled: true,
				result: { ok: true, chosen: candidates, nextObjectIndex: objectIndex + 1 }
			};
		}
		return {
			handled: true,
			result: {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeOne(def),
					count,
					candidateIds: candidates.map((c) => c.instanceId),
					costDef: def
				}
			}
		};
	}

	// 3. Constrained N-object selections: shareCreatureType, sameNamePair, singleGraveyard
	const isShareType = def.k === 'tapOthers' && Boolean(def.shareCreatureType);
	const isSameNamePair = def.k === 'discard' && Boolean(def.sameNamePair);
	const isSingleGy = def.k === 'exileFrom' && Boolean(def.singleGraveyard);
	if (isShareType || isSameNamePair || isSingleGy) {
		const count = evalAmt(def.count, ctx);
		if (candidates.length < count) {
			return {
				handled: true,
				result: {
					ok: false,
					error: `Can't pay the cost: ${describeOne(def)} (not enough to choose from).`
				}
			};
		}
		const validateGroup = (chosen: CardInstance[]): string | null => {
			if (isShareType && !chosenShareCreatureType(ctx.state, chosen)) {
				return 'Chosen creatures must share a creature type.';
			}
			if (isSameNamePair && chosen.length >= 2) {
				const first = resolveObjectFaces(
					effectiveCardForObject(chosen[0]),
					instanceFaceOptions(chosen[0], 'hand')
				).name.toLowerCase();
				if (
					!chosen.every(
						(c) =>
							resolveObjectFaces(
								effectiveCardForObject(c),
								instanceFaceOptions(c, 'hand')
							).name.toLowerCase() === first
					)
				) {
					return 'Chosen cards must have the same name.';
				}
			}
			if (isSingleGy && chosen.length >= 2) {
				const firstOwner = ctx.state.players.find((p) =>
					p.graveyard.some((g) => g.instanceId === chosen[0].instanceId)
				)?.playerId;
				if (
					!firstOwner ||
					!chosen.every((c) =>
						ctx.state.players
							.find((p) => p.playerId === firstOwner)
							?.graveyard.some((g) => g.instanceId === c.instanceId)
					)
				) {
					return 'Chosen cards must be from a single graveyard.';
				}
			}
			return null;
		};
		const index = objectIndex;
		const chosenIds = objects?.[index];
		if (chosenIds !== undefined) {
			if (new Set(chosenIds).size !== chosenIds.length || chosenIds.length !== count) {
				return {
					handled: true,
					result: { ok: false, error: `Choose exactly ${count} for: ${describeOne(def)}.` }
				};
			}
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			if (chosenIds.some((id) => !byId.has(id))) {
				return {
					handled: true,
					result: { ok: false, error: `Illegal choice for: ${describeOne(def)}.` }
				};
			}
			const chosen = chosenIds.map((id) => byId.get(id)!);
			const groupErr = validateGroup(chosen);
			if (groupErr) return { handled: true, result: { ok: false, error: groupErr } };
			for (const c of chosen) used.add(c.instanceId);
			return {
				handled: true,
				result: { ok: true, chosen, nextObjectIndex: objectIndex + 1 }
			};
		}
		if (candidates.length === count && !validateGroup(candidates)) {
			for (const c of candidates) used.add(c.instanceId);
			return {
				handled: true,
				result: { ok: true, chosen: candidates, nextObjectIndex: objectIndex + 1 }
			};
		}
		return {
			handled: true,
			result: {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeOne(def),
					count,
					candidateIds: candidates.map((c) => c.instanceId),
					costDef: def
				}
			}
		};
	}

	return { handled: false };
}

export function pickGreedyP17bObjects(
	def: CostDef,
	candidates: CardInstance[],
	count: number,
	ctx: CostContext
): string[] | null {
	const sortCheap = (arr: CardInstance[]) =>
		[...arr].sort((a, b) =>
			a.isToken !== b.isToken ? (a.isToken ? -1 : 1) : (a.card.cmc ?? 0) - (b.card.cmc ?? 0)
		);

	if (def.k === 'tapOthers' && def.shareCreatureType) {
		if (count <= 1) return sortCheap(candidates).slice(0, count).map((c) => c.instanceId);
		const sorted = sortCheap(candidates);
		const infos = new Map(sorted.map((c) => [c.instanceId, creatureSubtypesOfPerm(ctx.state, c)]));
		const allCreatures = sorted.filter((c) => infos.get(c.instanceId)!.hasAll);
		const typed = sorted.filter((c) => {
			const i = infos.get(c.instanceId)!;
			return i.hasAll || i.subtypes.length > 0;
		});
		if (allCreatures.length >= count) return allCreatures.slice(0, count).map((c) => c.instanceId);
		if (allCreatures.length === count - 1 && typed.length >= count) {
			const extra = typed.find((c) => !infos.get(c.instanceId)!.hasAll);
			if (extra) return [...allCreatures, extra].map((c) => c.instanceId);
		}
		const subs = new Set<string>();
		for (const c of typed) {
			for (const s of infos.get(c.instanceId)!.subtypes) subs.add(s.toLowerCase());
		}
		for (const sub of subs) {
			const group = typed.filter((c) => {
				const i = infos.get(c.instanceId)!;
				return i.hasAll || i.subtypes.some((s) => s.toLowerCase() === sub);
			});
			if (group.length >= count) return group.slice(0, count).map((c) => c.instanceId);
		}
		return null;
	}

	if (def.k === 'discard' && def.sameNamePair) {
		const byName = new Map<string, CardInstance[]>();
		for (const c of sortCheap(candidates)) {
			const key = resolveObjectFaces(
				effectiveCardForObject(c),
				instanceFaceOptions(c, 'hand')
			).name.toLowerCase();
			const arr = byName.get(key) ?? [];
			arr.push(c);
			byName.set(key, arr);
			if (arr.length >= count) return arr.slice(0, count).map((x) => x.instanceId);
		}
		return null;
	}

	if (def.k === 'exileFrom' && def.singleGraveyard) {
		for (const p of ctx.state.players) {
			if (p.lost) continue;
			const gySet = new Set(p.graveyard.map((g) => g.instanceId));
			const group = sortCheap(candidates.filter((c) => gySet.has(c.instanceId)));
			if (group.length >= count) return group.slice(0, count).map((c) => c.instanceId);
		}
		return null;
	}

	return null;
}

export function findCostCandidateByIdWave6(
	state: GameState,
	player: PlayerGameState,
	id: string
): CardInstance | undefined {
	for (const z of ['battlefield', 'hand', 'graveyard', 'exile', 'library'] as const) {
		const c = player[z].find((x) => x.instanceId === id);
		if (c) return c;
	}
	for (const p of state.players) {
		if (p.playerId === player.playerId) continue;
		for (const z of ['graveyard', 'exile', 'battlefield'] as const) {
			const c = p[z].find((x) => x.instanceId === id);
			if (c) return c;
		}
	}
	const stackItem = state.stack.find((s) => s.id === id || s.sourceInstanceId === id);
	if (stackItem && stackItem.kind === 'spell') {
		return makeStackSpellProxy(stackItem);
	}
	return undefined;
}

export function serializeP17bCostPart(
	def: CostDef,
	partObjects: CardInstance[] | undefined,
	ctx: CostContext,
	matchesFilter: MatchesFilterFn,
	emitForaged?: boolean
): SerializedPlannedCost | null {
	const extra = emitForaged ? { emitForaged: true } : {};
	const fctx: FilterContext = {
		state: ctx.state,
		controllerId: ctx.player.playerId,
		source: ctx.source,
		xValue: ctx.xValue
	};

	if (def.k === 'sacrifice') {
		if (def.attachedCreature) {
			const host = ctx.source.attachedToId
				? ctx.player.battlefield.find(
						(c) => !c.phasedOut && c.instanceId === ctx.source.attachedToId
					)
				: undefined;
			return {
				def,
				objectIds: host ? [host.instanceId] : [],
				objectNames: host ? [host.card.name] : [],
				...extra
			};
		}
		if (def.sacrificeAll) {
			const filter = typeof def.filter === 'object' ? def.filter : {};
			const all = ctx.player.battlefield.filter(
				(c) =>
					!c.phasedOut &&
					!(ctx.isSpell && c.instanceId === ctx.source.instanceId) &&
					matchesFilter(c, { ...filter, controller: 'you' }, fctx)
			);
			return {
				def,
				objectIds: all.map((c) => c.instanceId),
				objectNames: all.map((c) => c.card.name),
				...extra
			};
		}
	}

	if (def.k === 'exileFrom' && def.fromTop) {
		const picked = selectFromTopOfZone(ctx, def, matchesFilter) ?? [];
		return {
			def,
			objectIds: picked.map((c) => c.instanceId),
			objectNames: picked.map((c) => c.card.name),
			...extra
		};
	}

	if (
		def.k === 'untapOthers' ||
		def.k === 'putOnBottomOfLibrary' ||
		def.k === 'processOpponentExile' ||
		def.k === 'putExiledWithSelfToGraveyard'
	) {
		const objs =
			def.k === 'putOnBottomOfLibrary' && def.filter === 'self'
				? [ctx.source]
				: (partObjects ?? []);
		return {
			def,
			objectIds: objs.map((c) => c.instanceId),
			objectNames: objs.map((c) => c.card.name),
			...extra
		};
	}

	return null;
}

export function payP17bUntapOthers(
	ctx: CostContext,
	part: SerializedPlannedCost,
	descriptions: string[],
	aidDescriptions?: string[]
): void {
	if (part.def.k !== 'untapOthers') return;
	const ids = part.objectIds ?? [];
	const names: string[] = [];
	for (const id of ids) {
		const perm = ctx.player.battlefield.find((c) => c.instanceId === id);
		if (perm && perm.tapped) {
			perm.tapped = false;
			noteLayerInputsChanged(ctx.state);
			if (perm.zone === 'battlefield' && !perm.phasedOut) {
				emitEvent(ctx.state, {
					kind: 'BecomesUntapped',
					objectId: perm.instanceId,
					object: perm
				});
			}
			names.push(perm.card.name);
		}
	}
	const labelNames = part.objectNames && part.objectNames.length > 0 ? part.objectNames : names;
	if (labelNames.length > 0) {
		const targetLog = part.isCostAid && aidDescriptions ? aidDescriptions : descriptions;
		targetLog.push(`untapped ${labelNames.join(', ')}`);
	}
}

function moveCrossPlayerZone(
	state: GameState,
	card: CardInstance,
	fromPlayer: PlayerGameState,
	fromZone: PlayerZone,
	to: 'graveyard' | 'exile' | 'library',
	toBottom = false,
	suppressGraveyardLeaveBatch = false
): MoveResult {
	const owner = state.players.find((p) => p.playerId === card.ownerId) ?? fromPlayer;
	if (fromZone === 'battlefield') {
		return moveObject(state, card, to, {
			from: 'anyBattlefield',
			toPlayer: owner,
			detachAttachments: true,
			graveyardReplacement: to === 'graveyard' || to === 'exile',
			commanderRedirect: true,
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true,
			ceaseToExist: 'tokens',
			...(to === 'library' ? { insert: () => (toBottom ? 'end' : 'start') } : {})
		});
	}
	return moveObject(state, card, to, {
		from: { player: fromPlayer, zone: fromZone },
		toPlayer: owner,
		graveyardReplacement: to === 'graveyard' || to === 'exile',
		commanderRedirect: true,
		newTimestamp: true,
		bumpVersion: true,
		...(to === 'library' ? { insert: () => (toBottom ? 'end' : 'start') } : {}),
		...(suppressGraveyardLeaveBatch ? { suppressGraveyardLeaveBatch: true } : {})
	});
}

export function executeP17bCostPart(
	ctx: CostContext,
	part: SerializedPlannedCost,
	partIdx: number,
	objStart: number,
	descriptions: string[],
	targetLog: string[]
): { handled: boolean; pausedResult?: PaidCosts } {
	const { player, source, state } = ctx;
	const def = part.def;

	if (def.k === 'untapOthers') {
		return { handled: true };
	}

	if (def.k === 'payLife' && def.halfLifeRoundedUp) {
		if (objStart === 0) {
			const amount = Math.ceil(Math.max(0, player.life) / 2);
			if (amount > 0) {
				player.life -= amount;
				player.lostLifeThisTurn = true;
				noteLayerInputsChanged(state);
				recordPlayerLifeLossWave4(player, amount);
				onPlayerLostLifeCheckSpeedTrigger(state, player.playerId, amount);
				targetLog.push(`paid ${amount} life`);
			}
		}
		return { handled: true };
	}

	if (
		def.k === 'exileFrom' &&
		(def.zone === 'stack' ||
			def.anyGraveyard ||
			def.singleGraveyard ||
			def.fromTop ||
			def.collectEvidence)
	) {
		const ids = part.objectIds ?? [];
		const names = part.objectNames ?? [];
		if (def.zone === 'stack') {
			for (let j = objStart; j < ids.length; j++) {
				const idx = state.stack.findIndex(
					(s) => s.id === ids[j] || s.sourceInstanceId === ids[j]
				);
				if (idx < 0) continue;
				const [stackItem] = state.stack.splice(idx, 1);
				if (stackItem.isCopy) continue;
				const owner =
					state.players.find(
						(p) => p.playerId === (stackItem.ownerId ?? stackItem.controllerId)
					) ?? player;
				const cardInst: CardInstance = {
					instanceId: stackItem.sourceInstanceId,
					card: stackItem.card,
					ownerId: owner.playerId,
					controllerId: owner.playerId,
					zone: 'exile',
					tapped: false,
					summoningSick: false,
					damageMarked: 0,
					deathtouchDamageMarked: false,
					counters: createEmptyCounterMap(),
					tempPowerMod: 0,
					tempToughnessMod: 0,
					grantedKeywords: [],
					attachedToId: null,
					isToken: false,
					isCommander: Boolean(owner.commanderNames[stackItem.sourceInstanceId]),
					commanderCastCount: owner.commanderCastCounts[stackItem.sourceInstanceId] ?? 0,
					usedLoyaltyThisTurn: false,
					transformed: false,
					enteredTimestamp: allocateTimestamp(state),
					objectVersion: (stackItem.sourceObjectVersion ?? 1) + 1
				};
				if (
					moveObject(state, cardInst, 'exile', {
						from: 'stack',
						toPlayer: owner,
						commanderRedirect: true,
						newTimestamp: true
					}) === 'pending'
				) {
					return {
						handled: true,
						pausedResult: {
							descriptions,
							paused: true,
							nextPartIndex: partIdx,
							nextObjectIndex: j + 1
						}
					};
				}
			}
			if (names.length > 0) targetLog.push(`exiled ${names.join(', ')} from stack`);
			return { handled: true };
		}

		const fromZone = def.zone as PlayerZone;
		const movedByOwner = new Map<string, CardInstance[]>();
		const batchGy = fromZone === 'graveyard' && ids.length > 1;
		for (let j = objStart; j < ids.length; j++) {
			let card: CardInstance | undefined;
			let holder: PlayerGameState = player;
			for (const p of state.players) {
				const found = p[fromZone].find((c) => c.instanceId === ids[j]);
				if (found) {
					card = found;
					holder = p;
					break;
				}
			}
			if (!card) continue;
			const res = moveCrossPlayerZone(state, card, holder, fromZone, 'exile', false, batchGy);
			if (res === 'pending') {
				for (const [ownerId, objs] of movedByOwner) {
					if (objs.length > 0) {
						emitEvent(state, { kind: 'GraveyardLeaveBatch', ownerId, objects: objs });
					}
				}
				return {
					handled: true,
					pausedResult: {
						descriptions,
						paused: true,
						nextPartIndex: partIdx,
						nextObjectIndex: j + 1
					}
				};
			}
			if (batchGy && res !== 'graveyard') {
				const arr = movedByOwner.get(holder.playerId) ?? [];
				arr.push(card);
				movedByOwner.set(holder.playerId, arr);
			}
		}
		for (const [ownerId, objs] of movedByOwner) {
			if (objs.length > 0) {
				emitEvent(state, { kind: 'GraveyardLeaveBatch', ownerId, objects: objs });
			}
		}
		if (names.length > 0) {
			targetLog.push(
				def.collectEvidence
					? `collected evidence (${names.join(', ')})`
					: `exiled ${names.join(', ')} from ${def.zone}`
			);
		}
		return { handled: true };
	}

	if (def.k === 'revealHand') {
		if (objStart === 0) {
			for (const c of player.hand) {
				if (ctx.isSpell && c.instanceId === source.instanceId) continue;
				markHandCardRevealedToAll(state, c);
			}
			targetLog.push('revealed hand');
		}
		return { handled: true };
	}

	if (def.k === 'opponentGainsLife') {
		if (objStart === 0) {
			const baseAmt = evalAmt(def.amount, ctx);
			const opps = state.players.filter((p) => !p.lost && p.playerId !== player.playerId);
			const recipients = def.eachOtherPlayer
				? opps
				: opps.filter((opp) => !playerCantGainLife(state, opp.playerId)).slice(0, 1);
			for (const opp of recipients) {
				if (baseAmt <= 0 || playerCantGainLife(state, opp.playerId)) continue;
				const effAmt = applyStaticLifeGainModifiers(state, opp.playerId, baseAmt);
				if (effAmt <= 0) continue;
				opp.life += effAmt;
				recordLifeGainedThisTurn(state, opp, effAmt);
				emitEvent(state, {
					kind: 'GainLife',
					playerId: opp.playerId,
					amount: effAmt
				});
				targetLog.push(`${opp.username} gained ${effAmt} life`);
			}
		}
		return { handled: true };
	}

	if (def.k === 'putOnBottomOfLibrary') {
		const ids = part.objectIds ?? (def.filter === 'self' ? [source.instanceId] : []);
		const names = part.objectNames ?? (def.filter === 'self' ? [source.card.name] : []);
		for (let j = objStart; j < ids.length; j++) {
			const card =
				player[def.from].find((c) => c.instanceId === ids[j]) ??
				(def.filter === 'self' && source.zone === def.from ? source : undefined);
			if (!card) continue;
			if (moveCrossPlayerZone(state, card, player, def.from, 'library', true) === 'pending') {
				return {
					handled: true,
					pausedResult: {
						descriptions,
						paused: true,
						nextPartIndex: partIdx,
						nextObjectIndex: j + 1
					}
				};
			}
		}
		if (names.length > 0) targetLog.push(`put ${names.join(', ')} on bottom of library`);
		return { handled: true };
	}

	if (def.k === 'processOpponentExile' || def.k === 'putExiledWithSelfToGraveyard') {
		const ids = part.objectIds ?? [];
		const names = part.objectNames ?? [];
		for (let j = objStart; j < ids.length; j++) {
			let card: CardInstance | undefined;
			let holder: PlayerGameState = player;
			for (const p of state.players) {
				const found = p.exile.find((c) => c.instanceId === ids[j]);
				if (found) {
					card = found;
					holder = p;
					break;
				}
			}
			if (!card) continue;
			if (moveCrossPlayerZone(state, card, holder, 'exile', 'graveyard') === 'pending') {
				return {
					handled: true,
					pausedResult: {
						descriptions,
						paused: true,
						nextPartIndex: partIdx,
						nextObjectIndex: j + 1
					}
				};
			}
		}
		if (names.length > 0) targetLog.push(`put ${names.join(', ')} from exile into graveyard`);
		return { handled: true };
	}

	return { handled: false };
}

// ---- 4. Generalized Spell & Ability Cost Modifier Matching (CR 601.2f, CR 602.2b) ------------

export interface P17bSpellCastMeta {
	optionId?: string;
	kickedTags?: string[];
}

export function matchesP17bSpellCostMod(
	mod: Extract<StaticDef, { k: 'costModifier' }>,
	stackProxy: CardInstance & { targets?: TargetRef[] },
	sourceInst: CardInstance,
	fctx: FilterContext,
	chosenTargets: TargetRef[] | undefined,
	castMeta: P17bSpellCastMeta | undefined,
	matchesFilter: MatchesFilterFn
): boolean | null {
	if (mod.affects.k !== 'spell') return false;
	if (mod.affects.altCostKeyword) {
		const wantId = `alt:${mod.affects.altCostKeyword}`;
		if (castMeta?.optionId !== wantId) return false;
	}
	if (sourceInst.zone === 'stack' && mod.affects.filter.targetsSelf) {
		if (!chosenTargets?.some((t) => t.kind === 'stack' && t.id === sourceInst.instanceId)) {
			return false;
		}
		const rest: ObjectFilter = { ...mod.affects.filter };
		delete rest.targetsSelf;
		return matchesFilter(stackProxy, rest, fctx);
	}
	// Pre-target optimistic check for targeting reductions (CR 601.2c -> 601.2f)
	if (chosenTargets === undefined && mod.delta.mode === 'reduce') {
		if (mod.affects.filter.targetsAttached && sourceInst.attachedToId) {
			const host = findBattlefieldPerm(fctx.state, sourceInst.attachedToId);
			if (host) {
				const rest: ObjectFilter = { ...mod.affects.filter };
				delete rest.targetsAttached;
				return matchesFilter(stackProxy, rest, fctx);
			}
		}
		if (mod.affects.filter.targetsFilter) {
			const tf = mod.affects.filter.targetsFilter;
			const hasTargetable = fctx.state.players.some(
				(pl) =>
					!pl.lost &&
					pl.battlefield.some((b) => !b.phasedOut && matchesFilter(b, tf, fctx))
			);
			if (hasTargetable) {
				const rest: ObjectFilter = { ...mod.affects.filter };
				delete rest.targetsFilter;
				return matchesFilter(stackProxy, rest, fctx);
			}
		}
	}
	return null;
}

export function matchesP17bAbilityCostMod(
	mod: Extract<StaticDef, { k: 'costModifier' }>,
	actorId: string,
	abilityId: string,
	kw: string | undefined,
	sourcePerm: CardInstance | undefined,
	isManaAb: boolean,
	isLoyaltyAb: boolean,
	modControllerId: string,
	modSource: CardInstance,
	ctx: FilterContext,
	chosenTargets: TargetRef[] | undefined,
	matchesFilter: MatchesFilterFn
): boolean {
	if (mod.affects.k !== 'ability') return false;
	const aff = mod.affects;

	if (mod.who.relation === 'you' && modControllerId !== actorId) return false;
	if (
		(mod.who.relation === 'opponent' || mod.who.relation === 'each_opponent') &&
		modControllerId === actorId
	) {
		return false;
	}

	if (aff.keyword) {
		if (aff.keyword !== kw) return false;
		if (aff.selfSourceOnly && (!sourcePerm || sourcePerm.instanceId !== modSource.instanceId)) {
			return false;
		}
		if (aff.sourceZone && (!sourcePerm || sourcePerm.zone !== aff.sourceZone)) {
			return false;
		}
		if (sourcePerm && aff.filter && !matchesFilter(sourcePerm, aff.filter, ctx)) {
			return false;
		}
	} else {
		if (isManaAb) return false;
		if (aff.loyaltyOnly && !isLoyaltyAb) return false;
		const requiresBattlefieldSource = Boolean(
			aff.filter || aff.loyaltyOnly || aff.selfSourceOnly || aff.attachedSourceOnly || aff.sourceZone
		);
		if (requiresBattlefieldSource) {
			if (!sourcePerm) return false;
			if (aff.sourceZone && sourcePerm.zone !== aff.sourceZone) return false;
			if (!aff.sourceZone && sourcePerm.zone !== 'battlefield') return false;
			if (aff.selfSourceOnly && sourcePerm.instanceId !== modSource.instanceId) return false;
			if (aff.attachedSourceOnly && modSource.attachedToId !== sourcePerm.instanceId) {
				return false;
			}
			if (aff.filter && !matchesFilter(sourcePerm, aff.filter, ctx)) return false;
		}
	}

	if (aff.targetsSelf) {
		if (chosenTargets === undefined) {
			if (mod.delta.mode !== 'reduce') return false;
		} else if (
			!chosenTargets.some((t) => t.kind === 'permanent' && t.id === modSource.instanceId)
		) {
			return false;
		}
	}

	if (aff.targetsAttached) {
		const hostId = modSource.attachedToId;
		if (!hostId) return false;
		if (chosenTargets === undefined) {
			if (mod.delta.mode !== 'reduce') return false;
		} else if (!chosenTargets.some((t) => t.kind === 'permanent' && t.id === hostId)) {
			return false;
		}
	}

	if (aff.targetsFilter) {
		if (chosenTargets === undefined) {
			if (mod.delta.mode !== 'reduce') return false;
		} else {
			let hit = false;
			for (const t of chosenTargets) {
				if (t.kind === 'permanent') {
					const perm = findBattlefieldPerm(ctx.state, t.id);
					if (perm && matchesFilter(perm, aff.targetsFilter, ctx)) {
						hit = true;
						break;
					}
				}
			}
			if (!hit) return false;
		}
	}

	const condCtx: FilterContext =
		chosenTargets !== undefined && sourcePerm
			? {
					...ctx,
					source: {
						...modSource,
						...(modSource.instanceId === sourcePerm.instanceId ? { targets: chosenTargets } : {})
					} as CardInstance
				}
			: ctx;
	if (mod.condition && !evaluateCondition(mod.condition, condCtx)) return false;

	return true;
}

export function collectActiveAbilityAdditionalCostsWave6(
	state: GameState,
	actorId: string,
	abilityId: string,
	kw: string | undefined,
	sourcePerm: CardInstance | undefined,
	isManaAb: boolean,
	isLoyaltyAb: boolean,
	chosenTargets: TargetRef[] | undefined,
	matchesFilter: MatchesFilterFn,
	costModifiersOfFn: (
		card: CardInstance['card'],
		faceOpts?: ReturnType<typeof instanceFaceOptions>
	) => Array<Extract<StaticDef, { k: 'costModifier' }>>
): CostDef[] {
	const out: CostDef[] = [];
	const mayGrant = boardMayGrantStaticAbility(state, 'costModifier');
	for (const p of state.players) {
		if (p.lost) continue;
		for (const b of p.battlefield) {
			if (b.phasedOut) continue;
			const ctx: FilterContext = { state, controllerId: p.playerId, source: b };
			const bCard = effectiveCardForObject(b);
			const mods = costModifiersOfFn(bCard, instanceFaceOptions(b, 'battlefield'));
			if (mods.length > 0 && !evaluatePermanent(state, b).losesAllAbilities) {
				for (const mod of mods) {
					const zones = mod.activeZones ?? ['battlefield'];
					if (!zones.includes('battlefield')) continue;
					if (!mod.delta.additionalCosts?.length) continue;
					if (
						matchesP17bAbilityCostMod(
							mod,
							actorId,
							abilityId,
							kw,
							sourcePerm,
							isManaAb,
							isLoyaltyAb,
							p.playerId,
							b,
							ctx,
							chosenTargets,
							matchesFilter
						)
					) {
						out.push(...mod.delta.additionalCosts);
					}
				}
			}
			if (mayGrant) {
				for (const gDef of collectActiveGrantedStaticDefs(state, b)) {
					if (gDef.k !== 'costModifier' || !gDef.delta.additionalCosts?.length) continue;
					const zones = gDef.activeZones ?? ['battlefield'];
					if (!zones.includes('battlefield')) continue;
					if (
						matchesP17bAbilityCostMod(
							gDef,
							actorId,
							abilityId,
							kw,
							sourcePerm,
							isManaAb,
							isLoyaltyAb,
							p.playerId,
							b,
							ctx,
							chosenTargets,
							matchesFilter
						)
					) {
						out.push(...gDef.delta.additionalCosts);
					}
				}
			}
		}
	}
	return out;
}

export function collectSpellPerTargetLifeCostsWave6(
	inst: CardInstance,
	faceIndex: number,
	fused: boolean,
	targets: TargetRef[],
	costModifiersOfFn: (
		card: CardInstance['card'],
		faceOpts?: ReturnType<typeof instanceFaceOptions>
	) => Array<Extract<StaticDef, { k: 'costModifier' }>>
): CostDef[] {
	if (targets.length === 0) return [];
	const card = effectiveCardForObject(inst);
	const out: CostDef[] = [];
	for (const mod of costModifiersOfFn(card, { zone: 'stack', faceIndex, fused })) {
		if (mod.affects.k !== 'self' || !mod.delta.perTargetLife) continue;
		const lifeTotal = mod.delta.perTargetLife * targets.length;
		if (lifeTotal > 0) {
			out.push({ k: 'payLife', amount: { k: 'const', n: lifeTotal } });
		}
	}
	return out;
}

export function applyAltCastEnterCountersWave6(
	state: GameState,
	perm: CardInstance,
	spec: { counter: CounterType; count: number } | undefined
): void {
	if (!spec || spec.count <= 0) return;
	if (hasRestriction(state, perm, 'cantHaveCounters')) return;
	addCountersForCostOnPermanent(state, perm, spec.counter, spec.count);
}
