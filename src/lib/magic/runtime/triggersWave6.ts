/**
 * Wave 6 — Track P16b trigger runtime helpers:
 * - CR 603.8 state-triggered abilities (with stack + pending anti-loop guard)
 * - CR 603.2h "Do this only once each turn" suppression and resolution tracking
 * - CR 700.9 Modified, CR 700.12 Outlaw, and P16b ObjectFilter / Condition evaluators
 * - Ordinal filtered spell matching and Wave 6 trigger event helpers
 */
import type { RuntimeTrigger } from '../compiler/triggers.ts';
import { runtimeTriggers } from '../compiler/triggers.ts';
import { compileCard } from '../compiler/index.ts';
import type { Compare, Condition, ObjectFilter } from '../ir.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from '../ruleTree.ts';
import { getCardFaces } from '../scryfall.ts';
import type {
	CardInstance,
	CounterType,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	ZoneType
} from '../types.ts';
import {
	instanceFaceOptions,
	resolveObjectFaces,
	stackItemFaceOptions
} from './faces.ts';
import { activeTimedLayer1aForPermanent } from './layerCache.ts';

/** CR 700.12: Outlaw creature subtypes. */
export const OUTLAW_SUBTYPES = [
	'Assassin',
	'Mercenary',
	'Pirate',
	'Rogue',
	'Warlock'
] as const;

const OUTLAW_SUBTYPE_SET: ReadonlySet<string> = new Set(OUTLAW_SUBTYPES);

/**
 * CR 700.12: True iff `obj` has the Assassin, Mercenary, Pirate, Rogue, and/or Warlock subtype
 * (including via Changeling / allCreatureTypes).
 */
export function isObjectOutlaw(
	state: GameState,
	obj: CardInstance,
	zone?: ZoneType | 'stack',
	stackItem?: StackItem
): boolean {
	const effectiveZone = zone ?? obj.zone;
	if (effectiveZone === 'battlefield' && !obj.phasedOut) {
		const ev = evaluatePermanent(state, obj);
		if (ev.hasAllCreatureTypes) return true;
		return OUTLAW_SUBTYPES.some((st) => ev.hasSubType(st));
	}
	const faceOpts = stackItem
		? stackItemFaceOptions(stackItem)
		: instanceFaceOptions(obj, effectiveZone === 'stack' ? 'stack' : effectiveZone);
	const view = resolveObjectFaces(obj.card, faceOpts);
	if (view.subtypes.some((st) => OUTLAW_SUBTYPE_SET.has(st))) return true;
	if (!obj.isFaceDown) {
		const compiled = compileCard(obj.card);
		for (const fi of view.activeFaceIndices) {
			const defs = compiled.faces[fi]?.abilities ?? [];
			if (
				defs.some(
					(ab) =>
						(ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'changeling') ||
						(ab.kind === 'static' &&
							ab.static.k === 'continuous' &&
							ab.static.mod.k === 'allCreatureTypes')
				)
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * CR 700.9: A permanent is modified if it has one or more counters on it, if it is equipped, or
 * if it is enchanted by an Aura controlled by that permanent's controller.
 */
export function isPermanentModified(
	state: GameState,
	perm: CardInstance,
	perspectiveControllerId?: string
): boolean {
	if (perm.phasedOut) return false;
	let permControllerId: string | undefined;
	for (const p of state.players) {
		if (p.lost) continue;
		if (p.battlefield.some((b) => b.instanceId === perm.instanceId && !b.phasedOut)) {
			permControllerId = p.playerId;
			break;
		}
	}
	if (!permControllerId) return false;
	const auraControllerId = perspectiveControllerId ?? permControllerId;

	if (perm.counters) {
		for (const val of Object.values(perm.counters)) {
			if ((val ?? 0) > 0) return true;
		}
	}

	for (const p of state.players) {
		if (p.lost) continue;
		for (const att of p.battlefield) {
			if (att.phasedOut || att.attachedToId !== perm.instanceId) continue;
			const attEval = evaluatePermanent(state, att);
			if (attEval.hasSubType('Equipment')) return true;
			if (attEval.hasSubType('Aura') && p.playerId === auraControllerId) {
				return true;
			}
		}
	}
	return false;
}

/** CR 715: True iff `card` has an Adventure face. */
export function cardHasAdventure(card: ScryfallCard): boolean {
	if (card.layout === 'adventure') return true;
	const faces = getCardFaces(card);
	if (faces.length >= 2) {
		return faces.some((_, idx) =>
			resolveObjectFaces(card, { zone: 'stack', faceIndex: idx }).subtypes.includes('Adventure')
		);
	}
	return false;
}

/** True iff `obj` has `{X}` in its active face's mana cost. */
export function objectHasXInManaCost(
	obj: CardInstance,
	zone?: ZoneType | 'stack',
	stackItem?: StackItem
): boolean {
	if (obj.isFaceDown) return false;
	const effectiveZone = zone ?? obj.zone;
	const faceOpts = stackItem
		? stackItemFaceOptions(stackItem)
		: instanceFaceOptions(obj, effectiveZone === 'stack' ? 'stack' : effectiveZone);
	const view = resolveObjectFaces(obj.card, faceOpts);
	return /\{X\}/i.test(view.manaCost ?? '');
}

/** True iff battlefield creature `perm` currently has effective power > base power. */
export function isPermanentPowerGreaterThanBase(state: GameState, perm: CardInstance): boolean {
	if (perm.phasedOut) return false;
	const ev = evaluatePermanent(state, perm);
	if (!ev.isCreature) return false;
	const base = ev.breakdown.basePower ?? 0;
	return ev.power > base;
}

export interface P16bObjectFilterContext {
	state: GameState;
	controllerId: string;
	source?: CardInstance;
	zone?: ZoneType | 'stack';
	stackItem?: StackItem;
	powerOverride?: number;
	toughnessOverride?: number;
	manaValueOverride?: number;
}

/**
 * Evaluates Track P16b `ObjectFilter` fields. Returns `true` when all specified P16b fields match.
 */
export function matchesP16bObjectFilter(
	obj: CardInstance,
	filter: ObjectFilter,
	ctx: P16bObjectFilterContext
): boolean {
	const { state } = ctx;
	const effectiveZone = ctx.zone ?? obj.zone;

	if (filter.modified !== undefined) {
		const isMod =
			effectiveZone === 'battlefield' &&
			evaluatePermanent(state, obj).isCreature &&
			isPermanentModified(state, obj, ctx.controllerId);
		if (isMod !== filter.modified) return false;
	}
	if (filter.outlaw !== undefined) {
		const isOut = isObjectOutlaw(state, obj, effectiveZone, ctx.stackItem);
		if (isOut !== filter.outlaw) return false;
	}
	if (filter.hasAdventure !== undefined) {
		const hasAdv = !obj.isFaceDown && cardHasAdventure(obj.copiableCard ?? obj.card);
		if (hasAdv !== filter.hasAdventure) return false;
	}
	if (filter.hasXInManaCost !== undefined) {
		const hasX = objectHasXInManaCost(obj, effectiveZone, ctx.stackItem);
		if (hasX !== filter.hasXInManaCost) return false;
	}
	if (filter.powerGreaterThanBase !== undefined) {
		const gt =
			effectiveZone === 'battlefield' && isPermanentPowerGreaterThanBase(state, obj);
		if (gt !== filter.powerGreaterThanBase) return false;
	}
	if (filter.powerEqualsToughness !== undefined) {
		let p: number | undefined = ctx.powerOverride;
		let t: number | undefined = ctx.toughnessOverride;
		if (p === undefined || t === undefined) {
			if (effectiveZone === 'battlefield' && !obj.phasedOut) {
				const ev = evaluatePermanent(state, obj);
				if (ev.isCreature) {
					p = ev.power;
					t = ev.toughness;
				}
			} else {
				const faceOpts = ctx.stackItem
					? stackItemFaceOptions(ctx.stackItem)
					: instanceFaceOptions(obj, effectiveZone === 'stack' ? 'stack' : effectiveZone);
				const view = resolveObjectFaces(obj.card, faceOpts);
				p = view.power;
				t = view.toughness;
			}
		}
		const eq = p !== undefined && t !== undefined && p === t;
		if (eq !== filter.powerEqualsToughness) return false;
	}
	if (filter.manaValueEqualsSourcePower !== undefined) {
		const src = ctx.source;
		if (!src || src.zone !== 'battlefield' || src.phasedOut) return false;
		const srcEv = evaluatePermanent(state, src);
		if (!srcEv.isCreature) return false;
		let mv = ctx.manaValueOverride;
		if (mv === undefined) {
			const faceOpts = ctx.stackItem
				? stackItemFaceOptions(ctx.stackItem)
				: instanceFaceOptions(obj, effectiveZone === 'stack' ? 'stack' : effectiveZone);
			mv = resolveObjectFaces(obj.card, faceOpts).manaValue;
		}
		const eq = mv === srcEv.power;
		if (eq !== filter.manaValueEqualsSourcePower) return false;
	}
	if (filter.controlledByEnchantedPlayer !== undefined) {
		const enchantedPid = ctx.source?.attachedToId ?? null;
		const objControllerId = findObjectControllerId(state, obj);
		const matches = Boolean(enchantedPid && objControllerId === enchantedPid);
		if (matches !== filter.controlledByEnchantedPlayer) return false;
	}
	if (filter.renowned !== undefined) {
		const isRen = Boolean(obj.isRenowned);
		if (isRen !== filter.renowned) return false;
	}
	if (filter.goaded !== undefined) {
		const isGoaded = (obj.goadedByPlayerIds?.length ?? 0) > 0;
		if (isGoaded !== filter.goaded) return false;
	}
	return true;
}

function findObjectControllerId(state: GameState, obj: CardInstance): string {
	for (const p of state.players) {
		if (p.battlefield.some((b) => b.instanceId === obj.instanceId)) {
			return p.playerId;
		}
	}
	return obj.controllerId || obj.ownerId;
}

function compareOp(
	left: number,
	op: '>=' | '<=' | '=' | '>' | '<',
	right: number
): boolean {
	switch (op) {
		case '>=':
			return left >= right;
		case '<=':
			return left <= right;
		case '=':
			return left === right;
		case '>':
			return left > right;
		case '<':
			return left < right;
	}
}

export interface P16bConditionContext {
	state: GameState;
	controllerId: string;
	source?: CardInstance;
	stackItem?: StackItem;
	eventPlayerId?: string;
	eventObject?: CardInstance;
	eventLki?: {
		controllerId: string;
		power?: number;
		toughness?: number;
		counters?: Partial<Record<CounterType, number>>;
	};
}

/**
 * Evaluates Track P16b `Condition` variants. Returns `null` when `cond` is not a P16b variant.
 */
export function evaluateP16bCondition(
	cond: Condition,
	ctx: P16bConditionContext,
	matchesFilterFn?: (
		obj: CardInstance,
		filter: ObjectFilter,
		fCtx: { state: GameState; controllerId: string; source?: CardInstance; stackItem?: StackItem }
	) => boolean
): boolean | null {
	const { state, controllerId } = ctx;
	const you = state.players.find((p) => p.playerId === controllerId);
	if (!you) return false;

	switch (cond.k) {
		case 'attackingTotalPowerAtLeast': {
			let total = 0;
			const attackingIds = new Set(state.combat.attackers.map((a) => a.attackerInstanceId));
			for (const perm of you.battlefield) {
				if (perm.phasedOut || !attackingIds.has(perm.instanceId)) continue;
				const ev = evaluatePermanent(state, perm);
				if (ev.isCreature) total += Math.max(0, ev.power);
			}
			return total >= cond.min;
		}
		case 'firstCombatPhaseOfTurn': {
			const count = state.combatPhasesCountThisTurn ?? 1;
			return count === 1;
		}
		case 'eventPlayerHandCount': {
			const pid =
				ctx.eventPlayerId ??
				ctx.stackItem?.eventPlayerId ??
				state.players[state.activePlayerIndex]?.playerId;
			if (!pid) return false;
			const pl = state.players.find((p) => p.playerId === pid);
			if (!pl) return false;
			return compareOp(pl.hand.length, cond.op, cond.count);
		}
		case 'notEventPlayerTurn': {
			const pid =
				ctx.eventPlayerId ??
				ctx.stackItem?.eventPlayerId ??
				ctx.stackItem?.triggerEventStackItem?.controllerId;
			if (!pid) return false;
			const activeId = state.players[state.activePlayerIndex]?.playerId;
			return activeId !== pid;
		}
		case 'cardLeftYourGraveyardThisTurn':
			return Boolean(you.cardLeftGraveyardThisTurn);
		case 'committedCrimeThisTurn':
			return Boolean(you.committedCrimeThisTurn);
		case 'controlledByOtherThanOwner': {
			const src = ctx.source;
			if (!src) return false;
			const curControllerId = findObjectControllerId(state, src);
			return Boolean(src.ownerId && curControllerId !== src.ownerId);
		}
		case 'youLostLifeThisTurn':
			return Boolean(you.lostLifeThisTurn || (you.lifeLostThisTurn ?? 0) > 0);
		case 'playerLostLifeAtLeastThisTurn': {
			for (const p of state.players) {
				if (p.lost) continue;
				if (cond.opponentOnly && p.playerId === controllerId) continue;
				if ((p.lifeLostThisTurn ?? 0) >= cond.min) return true;
			}
			return false;
		}
		case 'moreCardsInHandThanEachOpponent': {
			const opps = state.players.filter((p) => !p.lost && p.playerId !== controllerId);
			if (opps.length === 0) return false;
			return opps.every((opp) => you.hand.length > opp.hand.length);
		}
		case 'eventObjectMatchedLki': {
			const obj =
				ctx.eventObject ??
				(ctx.stackItem?.eventObjectId
					? findCardAnywhere(state, ctx.stackItem.eventObjectId)
					: undefined);
			if (!obj) return false;
			if (matchesFilterFn) {
				return matchesFilterFn(obj, cond.filter, {
					state,
					controllerId,
					source: ctx.source,
					stackItem: ctx.stackItem
				});
			}
			const view = resolveObjectFaces(obj.copiableCard ?? obj.card, instanceFaceOptions(obj, obj.zone));
			if (cond.filter.subtypes && !cond.filter.subtypes.some((st) => view.subtypes.includes(st))) {
				return false;
			}
			if (cond.filter.types && !cond.filter.types.some((t) => view.types.includes(t))) {
				return false;
			}
			return true;
		}
		default:
			return null;
	}
}

function findCardAnywhere(state: GameState, instanceId: string): CardInstance | undefined {
	for (const p of state.players) {
		for (const zone of [p.battlefield, p.graveyard, p.exile, p.hand, p.command, p.library]) {
			const found = zone.find((c) => c.instanceId === instanceId);
			if (found) return found;
		}
	}
	return undefined;
}

// ---- CR 603.2h: "Do this only once each turn" ------------------------------------------------

export function doThisOnceKey(
	instanceId: string,
	objectVersion: number | undefined,
	faceIndex: number | undefined,
	abilityIndex: number | undefined
): string {
	return `${instanceId}:${objectVersion ?? 1}:${faceIndex ?? 0}:${abilityIndex ?? 0}`;
}

export function abilityHasDoThisOncePerTurn(ability: RuntimeTrigger): boolean {
	if (ability.trigger.doThisOncePerTurn) return true;
	if (ability.effect?.steps.some((st) => Boolean(st.doThisOncePerTurn))) return true;
	return false;
}

export function isStackItemTriggerDoThisOnce(item: StackItem, sourceCard: ScryfallCard): boolean {
	if (item.kind !== 'triggered') return false;
	const idx = item.triggeredAbilityIndex;
	if (idx === undefined || idx < 0) return false;
	const compiled = compileCard(sourceCard);
	const face = compiled.faces[item.faceIndex ?? 0];
	const ab = face?.abilities[idx];
	return ab?.kind === 'triggered' && Boolean(ab.trigger.doThisOncePerTurn);
}

export function isDoThisOnceTakenThisTurn(state: GameState, key: string): boolean {
	return Boolean(state.doThisOnceTakenThisTurn?.includes(key));
}

export function markDoThisOnceTakenThisTurn(state: GameState, key: string): void {
	const arr = (state.doThisOnceTakenThisTurn ??= []);
	if (!arr.includes(key)) arr.push(key);
}

export function clearDoThisOnceKeysForObject(state: GameState, instanceId: string): void {
	if (!state.doThisOnceTakenThisTurn?.length) return;
	const prefix = `${instanceId}:`;
	state.doThisOnceTakenThisTurn = state.doThisOnceTakenThisTurn.filter(
		(k) => !k.startsWith(prefix)
	);
}

// ---- CR 603.8: State-triggered abilities -----------------------------------------------------

export interface StateTriggerPendingSnapshot {
	source: CardInstance;
	faceIndex?: number;
	ability: RuntimeTrigger;
}

/**
 * CR 603.8: True iff an instance of this state-triggered ability from the same permanent
 * `(instanceId, objectVersion, faceIndex, abilityIndex)` is already on the stack or waiting to be
 * put onto the stack.
 */
export function hasActiveStateTriggerInstance(
	state: GameState,
	perm: CardInstance,
	faceIndex: number,
	abilityIndex: number,
	pendingList: readonly StateTriggerPendingSnapshot[]
): boolean {
	const ver = perm.objectVersion ?? 1;
	for (const s of state.stack) {
		if (
			s.kind === 'triggered' &&
			s.sourceInstanceId === perm.instanceId &&
			(s.sourceObjectVersion ?? 1) === ver &&
			(s.faceIndex ?? 0) === faceIndex &&
			s.triggeredAbilityIndex === abilityIndex
		) {
			return true;
		}
	}
	for (const pt of pendingList) {
		if (
			pt.source.instanceId === perm.instanceId &&
			(pt.source.objectVersion ?? 1) === ver &&
			(pt.faceIndex ?? 0) === faceIndex &&
			pt.ability.abilityIndex === abilityIndex
		) {
			return true;
		}
	}
	return false;
}

export interface StateTriggerCandidate {
	perm: CardInstance;
	card: ScryfallCard;
	faceIndex: number;
	controllerId: string;
	ability: RuntimeTrigger;
}

/**
 * CR 603.8: Scans battlefield permanents in APNAP seat order and returns state-triggered abilities
 * whose state condition currently holds and that do not already have an instance on the stack or
 * pending.
 */
export function collectReadyStateTriggers(
	state: GameState,
	pendingList: readonly StateTriggerPendingSnapshot[],
	evalConditionFn: (
		state: GameState,
		cond: Condition,
		controllerId: string,
		sourceInstanceId: string
	) => boolean,
	canExecuteFn?: (ability: RuntimeTrigger) => boolean
): StateTriggerCandidate[] {
	if (state.status !== 'active') return [];
	const out: StateTriggerCandidate[] = [];
	const n = state.players.length;
	for (let k = 0; k < n; k++) {
		const p: PlayerGameState | undefined = state.players[(state.activePlayerIndex + k) % n];
		if (!p || p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const timedL1a = activeTimedLayer1aForPermanent(state, perm);
			const card = timedL1a?.card ?? perm.copiableCard ?? perm.card;
			const compiled = compileCard(card);
			const faceOpts = instanceFaceOptions(perm, 'battlefield');
			if (timedL1a) {
				faceOpts.copiableState = timedL1a;
				faceOpts.faceIndex = timedL1a.faceIndex ?? 0;
				faceOpts.isSingleFaceCopy = timedL1a.isSingleFaceCopy;
				faceOpts.prototyped = Boolean(timedL1a.prototyped);
			}
			const faces = perm.isFaceDown ? [] : resolveObjectFaces(card, faceOpts).activeFaceIndices;
			let checkedLoss = false;
			let lostAbilities = false;
			for (const faceIndex of faces) {
				const rts = runtimeTriggers(compiled, faceIndex);
				for (const rt of rts) {
					if (!rt.trigger.isStateTrigger || rt.trigger.event !== 'stateTriggered') continue;
					const stateCond = rt.trigger.filter.stateCondition;
					if (!stateCond) continue;
					if (canExecuteFn && !canExecuteFn(rt)) continue;
					if (hasActiveStateTriggerInstance(state, perm, faceIndex, rt.abilityIndex, pendingList)) {
						continue;
					}
					if (!checkedLoss) {
						lostAbilities = permanentHasLostAllAbilities(perm, state).lost;
						checkedLoss = true;
					}
					if (lostAbilities) break;
					if (abilityHasDoThisOncePerTurn(rt)) {
						const onceKey = doThisOnceKey(
							perm.instanceId,
							perm.objectVersion,
							faceIndex,
							rt.abilityIndex
						);
						if (isDoThisOnceTakenThisTurn(state, onceKey)) continue;
					}
					if (!evalConditionFn(state, stateCond, p.playerId, perm.instanceId)) continue;
					if (rt.condition && !evalConditionFn(state, rt.condition, p.playerId, perm.instanceId)) {
						continue;
					}
					out.push({
						perm,
						card,
						faceIndex,
						controllerId: p.playerId,
						ability: rt
					});
				}
			}
		}
	}
	return out;
}

// ---- Ordinal spell cast helper ---------------------------------------------------------------

/**
 * Checks whether the currently cast spell (already recorded at the end of `caster.spellsCastThisTurnCards`)
 * is the `ordinal`-th (`1`, `2`, `3`, or `-1` for "other than first") spell matching `filter` cast
 * by `caster` this turn.
 */
export function matchesSpellCastOrdinal(
	state: GameState,
	caster: PlayerGameState | undefined,
	ordinal: 1 | 2 | 3 | -1,
	filter: ObjectFilter | 'self' | 'attachedTo' | undefined,
	sourceControllerId: string,
	sourcePerm: CardInstance | undefined,
	matchesFilterFn: (
		obj: CardInstance,
		f: ObjectFilter,
		ctx: { state: GameState; controllerId: string; source?: CardInstance; zone?: ZoneType | 'stack' }
	) => boolean
): boolean {
	if (!caster) return false;
	const cards = caster.spellsCastThisTurnCards ?? [];
	// The spell being cast was just pushed onto `spellsCastThisTurnCards` right before `Cast` emitted.
	const priorCount = Math.max(0, cards.length - 1);
	let priorMatching = 0;
	const objFilter: ObjectFilter | null =
		filter && typeof filter === 'object' ? stripRuntimeCastOnlyFilterFields(filter) : null;

	for (let i = 0; i < priorCount; i++) {
		const snapCard = cards[i];
		if (!objFilter) {
			priorMatching++;
			continue;
		}
		const synthInst = makeSynthCardInstance(`__prior_spell_${i}`, snapCard, caster.playerId, 'stack');
		if (
			matchesFilterFn(synthInst, objFilter, {
				state,
				controllerId: sourceControllerId,
				source: sourcePerm,
				zone: 'stack'
			})
		) {
			priorMatching++;
		}
	}

	if (ordinal === -1) return priorMatching >= 1;
	return priorMatching === ordinal - 1;
}

function stripRuntimeCastOnlyFilterFields(f: ObjectFilter): ObjectFilter {
	// Fields like `other`, `targetsSelf`, `targetsFilter`, `kickedSpell`, `castNotFromHand`, `castFromZoneFilter`
	// cannot be reconstructed from a plain ScryfallCard snapshot; strip only stack-ephemeral fields.
	const copy: ObjectFilter = { ...f };
	delete copy.other;
	delete copy.targetsSelf;
	delete copy.targetsFilter;
	delete copy.kickedSpell;
	delete copy.castNotFromHand;
	delete copy.castFromOutsideHand;
	delete copy.castFromZoneFilter;
	delete copy.castFromZone;
	return copy;
}

/** Evaluates a timing filter (`duringTurn: 'your' | 'opponent' | 'eventPlayer'`). */
export function matchesDuringTurnFilter(
	state: GameState,
	duringTurn: 'your' | 'opponent' | 'eventPlayer' | undefined,
	sourceControllerId: string,
	eventPlayerId?: string
): boolean {
	if (!duringTurn) return true;
	const activeId = state.players[state.activePlayerIndex]?.playerId;
	if (!activeId) return false;
	if (duringTurn === 'your') return activeId === sourceControllerId;
	if (duringTurn === 'opponent') return activeId !== sourceControllerId;
	if (duringTurn === 'eventPlayer') return Boolean(eventPlayerId && activeId === eventPlayerId);
	return true;
}

/** Matches a `Compare` against a numeric stat using constant right-hand values when needed. */
export function matchesSimpleCompare(val: number, cmp: Compare): boolean {
	if (cmp.value.k !== 'const') return false;
	return compareOp(val, cmp.op, cmp.value.n);
}

/** Normalizes color comparisons for P16b helpers. */
export function hasColorInList(colors: readonly string[], want: readonly ManaColor[]): boolean {
	return want.some((c) => colors.includes(c));
}

/** Builds a minimal transient `CardInstance` for stack/snapshot `ObjectFilter` evaluation. */
export function makeSynthCardInstance(
	instanceId: string,
	card: ScryfallCard,
	controllerId: string,
	zone: ZoneType
): CardInstance {
	return {
		instanceId,
		card,
		ownerId: controllerId,
		controllerId,
		zone,
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters: {} as Record<CounterType, number>,
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
}
