/**
 * Runtime interpreter for Wave 3 Track P8:
 * - CR 300.1: Distinct card types in zones (*Tarmogoyf* / *Delirium*)
 * - CR 604.3, 613.1: Conditional static helpers (`objectState`, `opponentCount`, `anyPlayerLife`, `distinctControlledCreaturePowers`)
 * - CR 508.1c, 509.1a–c: Static attack/block restrictions, multi-block capacity, evasion, and maximum-requirement solver
 * - CR 602.5a, 606.2: Activated-ability locks (*Collector Ouphe*, *Null Rod*, *Arrest*, *Faith's Fetters*)
 * - CR 614.12, 119.4, 119.8, 707.5, 707.9: Shocklands, Reveal lands, and Generalized *Clone* copy modifications
 * - CR 401.5, 305.1: Top-of-library visibility (with mid-cast lock) and library/graveyard land & spell play permissions
 *
 * Never reads rules text or card names at runtime (`architecture.test.ts` invariant).
 */
import type {
	Amount,
	CombatRuleSpec,
	Condition,
	CopyModificationSpec,
	ObjectFilter,
	StaticDef
} from '../ir.ts';
import { effectiveCardForObject, scrubFaceDownCard } from '../scryfall.ts';
import type {
	CardInstance,
	CopiableState,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	ZoneType
} from '../types.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	effectiveManaValue,
	instanceFaceOptions,
	resolveObjectFaces,
	type ResolveObjectFacesOptions
} from './faces.ts';
import { activeTimedLayer1aForPermanent, withStableLayerInputs } from './layerCache.ts';
import {
	getTimedCantBeBlockedReason,
	getTimedMinBlockersRequired,
	isCantBlockThisTurn
} from './copyPreventionAndEffects.ts';
import { abilityActivePermanents, evaluatePermanent } from './layers.ts';
import {
	evaluateCondition,
	matchesObjectFilter,
	objectPower,
	type FilterContext
} from './objectFilter.ts';
import { hasRestriction, playerLifeTotalCantChange } from './replace.ts';

// ---- 1. CR 300.1: Distinct Card Types in Zone (*Tarmogoyf* / Delirium) ----------------------

const CANONICAL_CARD_TYPES: Readonly<Record<string, string>> = {
	artifact: 'Artifact',
	battle: 'Battle',
	creature: 'Creature',
	enchantment: 'Enchantment',
	instant: 'Instant',
	kindred: 'Kindred',
	tribal: 'Kindred',
	land: 'Land',
	planeswalker: 'Planeswalker',
	sorcery: 'Sorcery'
};

type PlayerZoneKey = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command';

const PLAYER_ZONES: ReadonlySet<string> = new Set([
	'library',
	'hand',
	'battlefield',
	'graveyard',
	'exile',
	'command'
]);

/**
 * CR 300.1, 308.1: Counts distinct MTG card types among cards in `zone` belonging to `whose`
 * relative to `controllerId` (`Artifact`, `Battle`, `Creature`, `Enchantment`, `Instant`,
 * `Kindred` [including legacy `Tribal`], `Land`, `Planeswalker`, `Sorcery`). Never counts
 * supertypes (`Legendary`, `Basic`, `Snow`) or subtypes.
 */
export function countDistinctCardTypesInZone(
	state: GameState,
	controllerId: string,
	zone: ZoneType,
	whose: 'you' | 'opponents' | 'all'
): number {
	const seen = new Set<string>();
	if (zone === 'stack') {
		for (const item of state.stack) {
			if (whose === 'you' && item.controllerId !== controllerId) continue;
			if (whose === 'opponents' && item.controllerId === controllerId) continue;
			if (item.isFaceDown) {
				seen.add('Creature');
				continue;
			}
			const chars = activeCharacteristics(item.card, {
				zone: 'stack',
				faceIndex: item.faceIndex,
				fused: item.fused
			});
			for (const rawType of chars.types) {
				const canon = CANONICAL_CARD_TYPES[rawType.toLowerCase()];
				if (canon) seen.add(canon);
			}
		}
		return seen.size;
	}
	if (!PLAYER_ZONES.has(zone)) return 0;
	const zKey = zone as PlayerZoneKey;

	for (const p of state.players) {
		if (p.lost) continue;
		if (whose === 'you' && p.playerId !== controllerId) continue;
		if (whose === 'opponents' && p.playerId === controllerId) continue;

		for (const obj of p[zKey]) {
			if (zone === 'battlefield') {
				if (obj.phasedOut) continue;
				const ev = evaluatePermanent(state, obj);
				const [left = ''] = ev.typeLine.split(/\s+[—-]\s+/);
				for (const word of left.split(/\s+/)) {
					const canon = CANONICAL_CARD_TYPES[word.toLowerCase()];
					if (canon) seen.add(canon);
				}
			} else {
				if (obj.isFaceDown) continue;
				const chars = activeCharacteristics(
					effectiveCardForObject(obj),
					instanceFaceOptions(obj, zone)
				);
				for (const rawType of chars.types) {
					const canon = CANONICAL_CARD_TYPES[rawType.toLowerCase()];
					if (canon) seen.add(canon);
				}
			}
		}
	}
	return seen.size;
}

// ---- 2. Off-Layer P8 Condition Helpers ------------------------------------------------------

export function compareNumbers(
	actual: number,
	op: '>=' | '<=' | '=' | '>' | '<',
	expected: number
): boolean {
	switch (op) {
		case '>=':
			return actual >= expected;
		case '<=':
			return actual <= expected;
		case '>':
			return actual > expected;
		case '<':
			return actual < expected;
		default:
			return actual === expected;
	}
}

export function isPermanentEquippedOffLayer(state: GameState, targetInstanceId: string): boolean {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const att of p.battlefield) {
			if (att.phasedOut || att.attachedToId !== targetInstanceId) continue;
			if (evaluatePermanent(state, att).hasSubType('Equipment')) return true;
		}
	}
	return false;
}

export function isPermanentEnchantedOffLayer(state: GameState, targetInstanceId: string): boolean {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const att of p.battlefield) {
			if (att.phasedOut || att.attachedToId !== targetInstanceId) continue;
			if (evaluatePermanent(state, att).hasSubType('Aura')) return true;
		}
	}
	return false;
}

export function evaluateP8Condition(
	cond: Extract<
		Condition,
		{ k: 'objectState' | 'opponentCount' | 'anyPlayerLife' | 'distinctControlledCreaturePowers' }
	>,
	ctx: FilterContext
): boolean {
	const { state, controllerId, source } = ctx;
	switch (cond.k) {
		case 'opponentCount': {
			const oppCount = state.players.filter(
				(p) => !p.lost && p.playerId !== controllerId
			).length;
			return compareNumbers(oppCount, cond.op, cond.count);
		}
		case 'anyPlayerLife': {
			return state.players.some(
				(p) => !p.lost && compareNumbers(p.life, cond.op, cond.count)
			);
		}
		case 'distinctControlledCreaturePowers': {
			const ctrl = state.players.find((p) => p.playerId === controllerId);
			if (!ctrl) return false;
			const powers = new Set<number>();
			for (const perm of ctrl.battlefield) {
				if (perm.phasedOut) continue;
				const p = objectPower(state, perm);
				if (p !== null) powers.add(p);
			}
			return powers.size >= cond.count;
		}
		case 'objectState': {
			let subject: CardInstance | undefined;
			if (cond.of === 'self') {
				if (!source || source.zone !== 'battlefield' || source.phasedOut) return false;
				subject = source;
			} else {
				const hostId = source?.attachedToId;
				if (!hostId) return false;
				for (const p of state.players) {
					if (p.lost) continue;
					const found = p.battlefield.find((b) => !b.phasedOut && b.instanceId === hostId);
					if (found) {
						subject = found;
						break;
					}
				}
				if (!subject) return false;
			}
			if (cond.tapped !== undefined && Boolean(subject.tapped) !== cond.tapped) return false;
			if (cond.attacking !== undefined) {
				const atk = state.combat.attackers.some(
					(a) => a.attackerInstanceId === subject!.instanceId
				);
				if (atk !== cond.attacking) return false;
			}
			if (cond.blocking !== undefined) {
				const blk = state.combat.attackers.some((a) =>
					a.blockerInstanceIds.includes(subject!.instanceId)
				);
				if (blk !== cond.blocking) return false;
			}
			if (cond.monstrous !== undefined && Boolean(subject.isMonstrous) !== cond.monstrous) {
				return false;
			}
			if (cond.saddled !== undefined && Boolean(subject.saddledThisTurn) !== cond.saddled) {
				return false;
			}
			if (
				cond.equipped !== undefined &&
				isPermanentEquippedOffLayer(state, subject.instanceId) !== cond.equipped
			) {
				return false;
			}
			if (
				cond.enchanted !== undefined &&
				isPermanentEnchantedOffLayer(state, subject.instanceId) !== cond.enchanted
			) {
				return false;
			}
			if (cond.filter && !matchesObjectFilter(subject, cond.filter, ctx)) {
				return false;
			}
			return true;
		}
	}
}

// ---- 3. Active Combat Rules & CR 508.1c / CR 509.1a–c Enforcement ---------------------------

export interface ActiveCombatRuleEntry {
	rule: CombatRuleSpec;
	sourcePerm: CardInstance;
	sourceControllerId: string;
	sourceName: string;
}

/**
 * Collects all active `k: 'combatRule'` static rules currently affecting battlefield permanent
 * `targetPerm` (from itself, attached Auras/Equipment, or global `ObjectFilter` statics),
 * respecting Layer 6 ability loss and `condition` predicates.
 */
export function getActiveCombatRulesForPermanent(
	state: GameState,
	targetPerm: CardInstance
): ActiveCombatRuleEntry[] {
	if (targetPerm.zone !== 'battlefield' || targetPerm.phasedOut) return [];
	const out: ActiveCombatRuleEntry[] = [];
	for (const { perm: srcPerm, card: srcCard, controllerId: srcCtrlId } of abilityActivePermanents(
		state
	)) {
		const abilities = activeAbilityDefs(srcCard, instanceFaceOptions(srcPerm, 'battlefield'));
		for (const ab of abilities) {
			if (ab.kind !== 'static' || ab.static.k !== 'combatRule') continue;
			const st = ab.static;
			if (st.affected === 'self') {
				if (srcPerm.instanceId !== targetPerm.instanceId) continue;
			} else if (st.affected === 'attachedTo') {
				if (srcPerm.attachedToId !== targetPerm.instanceId) continue;
			} else {
				if (
					!matchesObjectFilter(targetPerm, st.affected, {
						state,
						controllerId: srcCtrlId,
						source: srcPerm
					})
				) {
					continue;
				}
			}
			if (
				st.condition &&
				!evaluateCondition(st.condition, {
					state,
					controllerId: srcCtrlId,
					source: srcPerm
				})
			) {
				continue;
			}
			out.push({
				rule: st.rule,
				sourcePerm: srcPerm,
				sourceControllerId: srcCtrlId,
				sourceName: srcCard.name
			});
		}
	}
	return out;
}

/**
 * CR 508.1c: Checks static attack restrictions on `attacker` against `defenderPlayerId`,
 * including `"~ can't attack unless defending player controls ..."` and `"~ can't attack alone"`.
 * Pass `proposedAttackerCount` when validating a complete declaration; omit (or pass >= 2) when
 * checking per-defender eligibility in isolation.
 */
export function getStaticAttackRestrictionReason(
	state: GameState,
	attacker: CardInstance,
	defenderPlayerId: string,
	proposedAttackerCount?: number
): string | null {
	const defender = state.players.find((p) => p.playerId === defenderPlayerId && !p.lost);
	if (!defender) return 'Invalid defending player.';

	const rules = getActiveCombatRulesForPermanent(state, attacker);
	for (const entry of rules) {
		if (entry.rule.kind === 'cantAttackAlone') {
			if (proposedAttackerCount !== undefined && proposedAttackerCount < 2) {
				return `Strict Rules Violation: ${attacker.card.name} cannot attack alone (CR 508.1c).`;
			}
			continue;
		}
		if (entry.rule.kind !== 'cantAttackUnlessDefenderControls') continue;
		const filterWithoutCtrl: ObjectFilter = {
			...entry.rule.filter,
			controller: undefined
		};
		const controlsMatching = defender.battlefield.some(
			(perm) =>
				!perm.phasedOut &&
				matchesObjectFilter(perm, filterWithoutCtrl, {
					state,
					controllerId: entry.sourceControllerId,
					source: entry.sourcePerm
				})
		);
		if (!controlsMatching) {
			return `Strict Rules Violation: ${attacker.card.name} cannot attack ${defender.username} unless they control a required permanent (CR 508.1c).`;
		}
	}
	return null;
}

/** Whether `attacker` currently has an active `"can't attack alone"` combat restriction (CR 508.1c). */
export function permanentCantAttackAlone(state: GameState, attacker: CardInstance): boolean {
	return getActiveCombatRulesForPermanent(state, attacker).some(
		(e) => e.rule.kind === 'cantAttackAlone'
	);
}

/**
 * CR 508.1c: Checks global attacker-count caps (*Silent Arbiter*, *Dueling Grounds*, *Crawlspace*).
 */
export function getGlobalAttackCapError(
	state: GameState,
	assignments: ReadonlyArray<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string | null;
	}>
): string | null {
	if (assignments.length === 0) return null;
	for (const { perm: srcPerm, card: srcCard, controllerId: srcCtrlId } of abilityActivePermanents(
		state
	)) {
		for (const ab of activeAbilityDefs(srcCard, instanceFaceOptions(srcPerm, 'battlefield'))) {
			if (ab.kind !== 'static' || ab.static.k !== 'combatRule') continue;
			const st = ab.static;
			if (st.rule.kind !== 'globalMaxAttackers') continue;
			if (
				st.condition &&
				!evaluateCondition(st.condition, { state, controllerId: srcCtrlId, source: srcPerm })
			) {
				continue;
			}
			if (st.rule.againstYouOnly) {
				const countAgainstSourceCtrl = assignments.filter(
					(a) => a.defenderPlayerId === srcCtrlId && !a.defenderPlaneswalkerId
				).length;
				if (countAgainstSourceCtrl > st.rule.max) {
					return `Strict Rules Violation: ${srcCard.name} prevents more than ${st.rule.max} creature(s) from attacking its controller each combat (CR 508.1c).`;
				}
			} else if (assignments.length > st.rule.max) {
				return `Strict Rules Violation: ${srcCard.name} prevents more than ${st.rule.max} creature(s) from attacking each combat (CR 508.1c).`;
			}
		}
	}
	return null;
}

function getGlobalMaxTotalBlockers(state: GameState): { max: number; sourceName?: string } {
	let max = Infinity;
	let sourceName: string | undefined;
	for (const { perm: srcPerm, card: srcCard, controllerId: srcCtrlId } of abilityActivePermanents(
		state
	)) {
		for (const ab of activeAbilityDefs(srcCard, instanceFaceOptions(srcPerm, 'battlefield'))) {
			if (ab.kind !== 'static' || ab.static.k !== 'combatRule') continue;
			const st = ab.static;
			if (st.rule.kind !== 'globalMaxBlockers') continue;
			if (
				st.condition &&
				!evaluateCondition(st.condition, { state, controllerId: srcCtrlId, source: srcPerm })
			) {
				continue;
			}
			if (st.rule.max < max) {
				max = st.rule.max;
				sourceName = srcCard.name;
			}
		}
	}
	return { max, sourceName };
}

/**
 * CR 509.1a: Maximum number of attacking creatures that `blocker` can block simultaneously
 * (`1` by default, plus any `additionalBlockCount` bonuses, or `Infinity` for `'unlimited'`).
 */
export function getMaxAttackersBlockedByBlocker(state: GameState, blocker: CardInstance): number {
	let cap = 1;
	for (const entry of getActiveCombatRulesForPermanent(state, blocker)) {
		if (entry.rule.kind === 'additionalBlockCount') {
			if (entry.rule.count === 'unlimited') return Infinity;
			cap += entry.rule.count;
		}
	}
	return cap;
}

/**
 * CR 509.1b: Checks static per-(blocker, attacker) evasion and blocking restrictions
 * (`cantBlockExcept`, `cantBeBlockedBy`, `cantBeBlockedByPowerLessThanSelf`, `cantBeBlockedExceptBy`,
 * and `Skulk` CR 702.118b).
 */
export function getStaticBlockerPairRestrictionReason(
	state: GameState,
	blocker: CardInstance,
	attacker: CardInstance
): string | null {
	// 1. Blocker's own blocking restrictions (e.g. "can block only creatures with flying")
	for (const entry of getActiveCombatRulesForPermanent(state, blocker)) {
		if (entry.rule.kind === 'cantBlockExcept') {
			if (
				!matchesObjectFilter(attacker, entry.rule.filter, {
					state,
					controllerId: entry.sourceControllerId,
					source: entry.sourcePerm
				})
			) {
				return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (${entry.sourceName} restriction, CR 509.1b).`;
			}
		}
		// --- Track P14 ---
		if (entry.rule.kind === 'cantBlockFilter') {
			if (
				matchesObjectFilter(attacker, entry.rule.filter, {
					state,
					controllerId: entry.sourceControllerId,
					source: entry.sourcePerm
				})
			) {
				return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (${entry.sourceName} restriction, CR 509.1b).`;
			}
		} else if (entry.rule.kind === 'cantBlockPowerGreaterThanSelf') {
			const blkP = objectPower(state, blocker) ?? 0;
			const atkP = objectPower(state, attacker) ?? 0;
			if (atkP > blkP) {
				return `Strict Rules Violation: ${blocker.card.name} (power ${blkP}) cannot block ${attacker.card.name} (power ${atkP}, CR 509.1b).`;
			}
		} else if (entry.rule.kind === 'cantBlockPowerLessThanSelf') {
			const blkP = objectPower(state, blocker) ?? 0;
			const atkP = objectPower(state, attacker) ?? 0;
			if (atkP < blkP) {
				return `Strict Rules Violation: ${blocker.card.name} (power ${blkP}) cannot block ${attacker.card.name} (power ${atkP}, CR 509.1b).`;
			}
		}
		// --- End Track P14 ---
	}

	// 2. Attacker's evasion abilities
	for (const entry of getActiveCombatRulesForPermanent(state, attacker)) {
		const ctx: FilterContext = {
			state,
			controllerId: entry.sourceControllerId,
			source: entry.sourcePerm
		};
		switch (entry.rule.kind) {
			case 'cantBeBlockedBy': {
				if (matchesObjectFilter(blocker, entry.rule.filter, ctx)) {
					return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (${entry.sourceName} evasion, CR 509.1b).`;
				}
				break;
			}
			case 'cantBeBlockedByPowerLessThanSelf': {
				const blkP = objectPower(state, blocker) ?? 0;
				const refP = objectPower(state, entry.sourcePerm) ?? 0;
				if (blkP < refP) {
					return `Strict Rules Violation: ${blocker.card.name} (power ${blkP}) cannot block ${attacker.card.name} (requires power ${refP} or greater, CR 509.1b).`;
				}
				break;
			}
			case 'cantBeBlockedExceptBy': {
				const matchesPrimary = matchesObjectFilter(blocker, entry.rule.filter, ctx);
				const matchesSecondary =
					entry.rule.orFilter !== undefined &&
					matchesObjectFilter(blocker, entry.rule.orFilter, ctx);
				if (!matchesPrimary && !matchesSecondary) {
					return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (${entry.sourceName} evasion, CR 509.1b).`;
				}
				break;
			}
			// --- Track P14 ---
			case 'cantBeBlockedIfDefenderControls': {
				const atkEntry = state.combat.attackers.find(
					(a) => a.attackerInstanceId === attacker.instanceId
				);
				const defPlayerId =
					atkEntry?.defenderPlayerId ?? evaluatePermanent(state, blocker).controllerId;
				const defPlayer = state.players.find((p) => p.playerId === defPlayerId && !p.lost);
				const filterWithoutCtrl: ObjectFilter = {
					...entry.rule.filter,
					controller: undefined
				};
				if (
					defPlayer?.battlefield.some(
						(perm) => !perm.phasedOut && matchesObjectFilter(perm, filterWithoutCtrl, ctx)
					)
				) {
					return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (${entry.sourceName} evasion, CR 509.1b).`;
				}
				break;
			}
			case 'cantBeBlockedByPowerGreaterThanSelf': {
				const blkP = objectPower(state, blocker) ?? 0;
				const refP = objectPower(state, attacker) ?? 0;
				if (blkP > refP) {
					return `Strict Rules Violation: ${blocker.card.name} (power ${blkP}) cannot block ${attacker.card.name} (power ${refP}, CR 509.1b).`;
				}
				break;
			}
			// --- End Track P14 ---
		}
	}

	// 3. Skulk (CR 702.118b): can't be blocked by creatures with greater power
	const evalAtk = evaluatePermanent(state, attacker);
	if (evalAtk.activeKeywords.some((kw) => kw.toLowerCase() === 'skulk')) {
		const blkP = objectPower(state, blocker) ?? 0;
		const atkP = objectPower(state, attacker) ?? 0;
		if (blkP > atkP) {
			return `Strict Rules Violation: ${blocker.card.name} (power ${blkP}) cannot block ${attacker.card.name} (power ${atkP}) due to Skulk (CR 702.118b).`;
		}
	}

	return null;
}

/**
 * CR 509.1b: Per-attacker blocker-count bounds when blocked by >= 1 creature (`minBlockers` from
 * Menace / `"can't be blocked except by N or more creatures"`, `maxBlockers` from *Alpha Authority* /
 * *Bristling Boar* `"can't be blocked by more than N creature(s)"`).
 */
export function getAttackerGroupRestrictionBounds(
	state: GameState,
	attacker: CardInstance
): { minBlockers: number; maxBlockers: number; minSource?: string; maxSource?: string } {
	const evalAtk = evaluatePermanent(state, attacker);
	const hasMenace = evalAtk.activeKeywords.some((kw) => kw.toLowerCase() === 'menace');
	let minBlockers = hasMenace ? 2 : 1;
	let maxBlockers = Infinity;
	let minSource: string | undefined = hasMenace ? 'Menace' : undefined;
	let maxSource: string | undefined;

	for (const entry of getActiveCombatRulesForPermanent(state, attacker)) {
		if (entry.rule.kind === 'minBlockers' && entry.rule.min > minBlockers) {
			minBlockers = entry.rule.min;
			minSource = entry.sourceName;
		} else if (entry.rule.kind === 'maxBlockers' && entry.rule.max < maxBlockers) {
			maxBlockers = entry.rule.max;
			maxSource = entry.sourceName;
		}
	}

	const timedMin = getTimedMinBlockersRequired(state, attacker);
	if (timedMin > minBlockers) {
		minBlockers = timedMin;
		minSource = 'Timed evasion';
	}

	return { minBlockers, maxBlockers, minSource, maxSource };
}

function countAttackerBlockingRequirementWeights(
	state: GameState,
	attacker: CardInstance
): { mustBeBlockedWeight: number; allAbleWeight: number } {
	let mustBeBlockedWeight = 0;
	let allAbleWeight = 0;
	for (const entry of getActiveCombatRulesForPermanent(state, attacker)) {
		if (entry.rule.kind === 'mustBeBlockedIfAble') {
			mustBeBlockedWeight += 1;
		} else if (entry.rule.kind === 'allAbleBlockers') {
			allAbleWeight += 1;
		}
	}
	return { mustBeBlockedWeight, allAbleWeight };
}

export interface BlockerPairAssignment {
	blockerInstanceId: string;
	attackerInstanceId: string;
}

/**
 * CR 509.1a–c: Full blocker declaration validator and maximum-requirement solver for `defender`.
 * Validates:
 * 1. Duplicate `(blocker, attacker)` pairs & per-blocker capacity (`getMaxAttackersBlockedByBlocker`).
 * 2. Per-pair legality (`canPairBlockFn`, which includes keyword + static evasion).
 * 3. Per-attacker group restrictions (`minBlockers` / Menace and `maxBlockers`).
 * 4. Maximum-requirement satisfaction (`CR 509.1c`): rejects iff `desiredSatisfied < maxSatisfied`
 *    across all active `blocksEachCombat`, `mustBeBlockedIfAble`, and `allAbleBlockers` (*Lure*)
 *    requirements!
 */
export function validateAndSolveDefenderBlockersP8(
	state: GameState,
	defender: PlayerGameState,
	assignments: ReadonlyArray<BlockerPairAssignment>,
	getPairErrorFn: (state: GameState, blocker: CardInstance, attacker: CardInstance) => string | null
):
	| {
			ok: true;
			blockerCountsByAttacker: Map<string, string[]>;
			satisfiedRequirements: number;
			maxRequirements: number;
	  }
	| {
			ok: false;
			error: string;
			bestLegalAssignment: BlockerPairAssignment[];
			maxRequirements: number;
	  } {
	const defenderId = defender.playerId;
	const blockerCountsByAttacker = new Map<string, string[]>();
	const attackersByBlocker = new Map<string, Set<string>>();

	for (const assign of assignments) {
		const blocker = defender.battlefield.find((c) => c.instanceId === assign.blockerInstanceId);
		if (!blocker || blocker.phasedOut || !evaluatePermanent(state, blocker).isCreature) {
			return {
				ok: false,
				error: 'Invalid blocking creature.',
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
		if (blocker.tapped) {
			return {
				ok: false,
				error: `${blocker.card.name} is tapped and cannot block.`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
		if (hasRestriction(state, blocker, 'cantBlock')) {
			return {
				ok: false,
				error: `${blocker.card.name} cannot block.`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
		if (isCantBlockThisTurn(state, blocker)) {
			return {
				ok: false,
				error: `${blocker.card.name} cannot block this turn (CR 509.1b).`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}

		const atkEntry = state.combat.attackers.find(
			(a) => a.attackerInstanceId === assign.attackerInstanceId
		);
		if (!atkEntry) {
			return {
				ok: false,
				error: 'Target attacker is not attacking.',
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
		if (atkEntry.defenderPlayerId !== defenderId) {
			return {
				ok: false,
				error: `${blocker.card.name} can only block creatures attacking you.`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}

		const existingForBlocker = attackersByBlocker.get(blocker.instanceId) ?? new Set<string>();
		if (existingForBlocker.has(atkEntry.attackerInstanceId)) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${blocker.card.name} cannot be assigned to block the same attacker twice (CR 509.1a).`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
		const maxCap = getMaxAttackersBlockedByBlocker(state, blocker);
		if (existingForBlocker.size + 1 > maxCap) {
			return {
				ok: false,
				error:
					maxCap === 1
						? 'Strict Rules Violation: A creature cannot block more than one attacking creature (CR 509.1a).'
						: `Strict Rules Violation: ${blocker.card.name} can block at most ${maxCap} attacking creatures (CR 509.1a).`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}

		const atkOwner = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const atkCard = atkOwner?.battlefield.find(
			(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
		);
		if (atkCard) {
			const pairErr = getPairErrorFn(state, blocker, atkCard);
			if (pairErr) {
				return {
					ok: false,
					error: pairErr,
					bestLegalAssignment: [],
					maxRequirements: 0
				};
			}
		}

		existingForBlocker.add(atkEntry.attackerInstanceId);
		attackersByBlocker.set(blocker.instanceId, existingForBlocker);

		const list = blockerCountsByAttacker.get(atkEntry.attackerInstanceId) || [];
		list.push(blocker.instanceId);
		blockerCountsByAttacker.set(atkEntry.attackerInstanceId, list);
	}

	// Check group restrictions (Menace / minBlockers / maxBlockers) on every blocked attacker
	for (const [atkId, bIds] of blockerCountsByAttacker.entries()) {
		if (bIds.length === 0) continue;
		const atkEntry = state.combat.attackers.find((a) => a.attackerInstanceId === atkId);
		const atkOwner = state.players.find((p) => p.playerId === atkEntry?.controllerId);
		const atkCard = atkOwner?.battlefield.find((c) => !c.phasedOut && c.instanceId === atkId);
		if (!atkCard) continue;
		const bounds = getAttackerGroupRestrictionBounds(state, atkCard);
		if (bIds.length < bounds.minBlockers) {
			return {
				ok: false,
				error:
					bounds.minSource === 'Menace' && bounds.minBlockers === 2
						? `Strict Rules Violation: ${atkCard.card.name} has Menace and cannot be blocked by only 1 creature (requires 2 or more blockers).`
						: `Strict Rules Violation: ${atkCard.card.name} cannot be blocked by fewer than ${bounds.minBlockers} creatures (CR 509.1b).`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
		if (bIds.length > bounds.maxBlockers) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${atkCard.card.name} cannot be blocked by more than ${bounds.maxBlockers} creature(s) (CR 509.1b).`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
		const assignedBlockers = bIds
			.map((bId) => defender.battlefield.find((c) => c.instanceId === bId))
			.filter((c): c is CardInstance => Boolean(c));
		const timedErr = getTimedCantBeBlockedReason(state, atkCard, assignedBlockers);
		if (timedErr) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${timedErr}`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
	}

	// Check global max blockers (Silent Arbiter / Dueling Grounds) and cantBlockAlone (CR 509.1b)
	const globalMaxBlk = getGlobalMaxTotalBlockers(state);
	const priorDistinctBlockerIds = new Set<string>();
	for (const atkEntry of state.combat.attackers) {
		if (atkEntry.defenderPlayerId === defenderId) continue;
		for (const bid of atkEntry.blockerInstanceIds) priorDistinctBlockerIds.add(bid);
	}
	if (
		attackersByBlocker.size > 0 &&
		priorDistinctBlockerIds.size + attackersByBlocker.size > globalMaxBlk.max
	) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${globalMaxBlk.sourceName || 'Continuous effect'} prevents more than ${globalMaxBlk.max} creature(s) from blocking each combat (CR 509.1b).`,
			bestLegalAssignment: [],
			maxRequirements: 0
		};
	}
	if (priorDistinctBlockerIds.size + attackersByBlocker.size === 1 && attackersByBlocker.size === 1) {
		const [soleBlockerId] = attackersByBlocker.keys();
		const soleBlocker = defender.battlefield.find((c) => c.instanceId === soleBlockerId);
		if (
			soleBlocker &&
			getActiveCombatRulesForPermanent(state, soleBlocker).some(
				(e) => e.rule.kind === 'cantBlockAlone'
			)
		) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${soleBlocker.card.name} cannot block alone (CR 509.1b).`,
				bestLegalAssignment: [],
				maxRequirements: 0
			};
		}
	}

	// Collect attackers against defender and eligible untapped blockers controlled by defender
	const attackerCards: CardInstance[] = [];
	for (const atkEntry of state.combat.attackers) {
		if (atkEntry.defenderPlayerId !== defenderId) continue;
		const owner = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const card = owner?.battlefield.find(
			(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
		);
		if (card) attackerCards.push(card);
	}
	if (attackerCards.length === 0) {
		return {
			ok: true,
			blockerCountsByAttacker,
			satisfiedRequirements: 0,
			maxRequirements: 0
		};
	}

	const eligibleBlockers: CardInstance[] = [];
	for (const perm of defender.battlefield) {
		if (perm.phasedOut || perm.tapped || !evaluatePermanent(state, perm).isCreature) continue;
		if (hasRestriction(state, perm, 'cantBlock')) continue;
		if (isCantBlockThisTurn(state, perm)) continue;
		eligibleBlockers.push(perm);
	}
	if (eligibleBlockers.length === 0) {
		return {
			ok: true,
			blockerCountsByAttacker,
			satisfiedRequirements: 0,
			maxRequirements: 0
		};
	}

	const blockerMustBlock: boolean[] = eligibleBlockers.map((b) =>
		hasRestriction(state, b, 'blocksEachCombat')
	);
	const attackerReqWeights = attackerCards.map((a) =>
		countAttackerBlockingRequirementWeights(state, a)
	);

	const anyBlockerReq = blockerMustBlock.some(Boolean);
	const anyAttackerReq = attackerReqWeights.some(
		(w) => w.mustBeBlockedWeight > 0 || w.allAbleWeight > 0
	);

	// O(1) fast path: zero blocking requirements on the battlefield
	if (!anyBlockerReq && !anyAttackerReq) {
		return {
			ok: true,
			blockerCountsByAttacker,
			satisfiedRequirements: 0,
			maxRequirements: 0
		};
	}

	// Score the submitted assignment
	const scoreAssignment = (
		byBlocker: ReadonlyMap<string, ReadonlySet<string>>,
		byAttacker: ReadonlyMap<string, ReadonlyArray<string>>
	): number => {
		let score = 0;
		for (let bi = 0; bi < eligibleBlockers.length; bi++) {
			if (
				blockerMustBlock[bi] &&
				(byBlocker.get(eligibleBlockers[bi].instanceId)?.size ?? 0) > 0
			) {
				score += 1;
			}
		}
		for (let ai = 0; ai < attackerCards.length; ai++) {
			const count = byAttacker.get(attackerCards[ai].instanceId)?.length ?? 0;
			if (count > 0) {
				score += attackerReqWeights[ai].mustBeBlockedWeight;
				score += count * attackerReqWeights[ai].allAbleWeight;
			}
		}
		return score;
	};

	const desiredSatisfied = scoreAssignment(attackersByBlocker, blockerCountsByAttacker);

	// Upper bound on total possible requirements across all eligible blockers & attackers
	let theoreticalMax = 0;
	for (let bi = 0; bi < eligibleBlockers.length; bi++) {
		if (blockerMustBlock[bi]) theoreticalMax += 1;
	}
	for (let ai = 0; ai < attackerCards.length; ai++) {
		theoreticalMax += attackerReqWeights[ai].mustBeBlockedWeight;
		theoreticalMax += eligibleBlockers.length * attackerReqWeights[ai].allAbleWeight;
	}

	// O(1) fast path when the player's legal assignment already satisfies every requirement!
	if (desiredSatisfied >= theoreticalMax) {
		return {
			ok: true,
			blockerCountsByAttacker,
			satisfiedRequirements: desiredSatisfied,
			maxRequirements: desiredSatisfied
		};
	}

	const blockerCantBlockAlone: boolean[] = eligibleBlockers.map((b) =>
		getActiveCombatRulesForPermanent(state, b).some((e) => e.rule.kind === 'cantBlockAlone')
	);
	const maxRemainingDistinctBlockers = Math.max(
		0,
		globalMaxBlk.max - priorDistinctBlockerIds.size
	);

	// Solve exact maximum achievable requirements via bounded branch-and-bound (CR 509.1c)
	const optimal = solveMaximumBlockingRequirements(
		state,
		eligibleBlockers,
		blockerMustBlock,
		blockerCantBlockAlone,
		priorDistinctBlockerIds.size,
		maxRemainingDistinctBlockers,
		attackerCards,
		attackerReqWeights,
		getPairErrorFn
	);

	if (desiredSatisfied < optimal.maxScore) {
		return {
			ok: false,
			error: `Strict Rules Violation: Block declaration satisfies ${desiredSatisfied} blocking requirement(s), but ${optimal.maxScore} can be satisfied without violating any restrictions (CR 509.1c).`,
			bestLegalAssignment: optimal.bestAssignment,
			maxRequirements: optimal.maxScore
		};
	}

	return {
		ok: true,
		blockerCountsByAttacker,
		satisfiedRequirements: desiredSatisfied,
		maxRequirements: optimal.maxScore
	};
}

function solveMaximumBlockingRequirements(
	state: GameState,
	eligibleBlockers: CardInstance[],
	blockerMustBlock: boolean[],
	blockerCantBlockAlone: boolean[],
	priorDistinctBlockerCount: number,
	maxRemainingDistinctBlockers: number,
	attackerCards: CardInstance[],
	attackerReqWeights: Array<{ mustBeBlockedWeight: number; allAbleWeight: number }>,
	getPairErrorFn: (state: GameState, blocker: CardInstance, attacker: CardInstance) => string | null
): { maxScore: number; bestAssignment: BlockerPairAssignment[] } {
	const numB = eligibleBlockers.length;
	const numA = attackerCards.length;
	if (maxRemainingDistinctBlockers <= 0) {
		return { maxScore: 0, bestAssignment: [] };
	}

	const atkBounds = attackerCards.map((a) => getAttackerGroupRestrictionBounds(state, a));
	const blockerCaps = eligibleBlockers.map((b) =>
		Math.min(numA, getMaxAttackersBlockedByBlocker(state, b))
	);

	// Precompute legal (bi, ai) adjacency; ignore attackers where minBlockers > maxBlockers
	const legalTargetsForBlocker: number[][] = Array.from({ length: numB }, () => []);
	const maxPossibleForAttacker = new Int32Array(numA);
	for (let bi = 0; bi < numB; bi++) {
		for (let ai = 0; ai < numA; ai++) {
			if (atkBounds[ai].minBlockers > atkBounds[ai].maxBlockers) continue;
			if (getPairErrorFn(state, eligibleBlockers[bi], attackerCards[ai]) === null) {
				legalTargetsForBlocker[bi].push(ai);
				maxPossibleForAttacker[ai] += 1;
			}
		}
	}

	// Prune attackers where total eligible blockers < minBlockers (impossible to block legally)
	for (let bi = 0; bi < numB; bi++) {
		legalTargetsForBlocker[bi] = legalTargetsForBlocker[bi].filter(
			(ai) => maxPossibleForAttacker[ai] >= atkBounds[ai].minBlockers
		);
		// Order high-requirement attackers first so branch-and-bound finds optima immediately
		legalTargetsForBlocker[bi].sort((a1, a2) => {
			const w1 = attackerReqWeights[a1].allAbleWeight * 2 + attackerReqWeights[a1].mustBeBlockedWeight;
			const w2 = attackerReqWeights[a2].allAbleWeight * 2 + attackerReqWeights[a2].mustBeBlockedWeight;
			return w2 - w1;
		});
	}

	// Order blockers with requirements or scarce options first
	const blockerOrder = Array.from({ length: numB }, (_, i) => i).sort((b1, b2) => {
		const r1 = blockerMustBlock[b1] ? 1 : 0;
		const r2 = blockerMustBlock[b2] ? 1 : 0;
		if (r1 !== r2) return r2 - r1;
		return legalTargetsForBlocker[b1].length - legalTargetsForBlocker[b2].length;
	});

	// Suffix upper bound of additional score achievable from blockerOrder[pos..numB-1]
	const suffixMaxGain = new Int32Array(numB + 1);
	for (let pos = numB - 1; pos >= 0; pos--) {
		const bi = blockerOrder[pos];
		const targets = legalTargetsForBlocker[bi];
		let gain = 0;
		if (targets.length > 0) {
			if (blockerMustBlock[bi]) gain += 1;
			const cap = Math.min(blockerCaps[bi], targets.length);
			// Each chosen attacker can contribute at most mustBeBlockedWeight + allAbleWeight
			const sortedGains = targets
				.map((ai) => attackerReqWeights[ai].mustBeBlockedWeight + attackerReqWeights[ai].allAbleWeight)
				.sort((x, y) => y - x);
			for (let k = 0; k < cap; k++) gain += sortedGains[k];
		}
		suffixMaxGain[pos] = suffixMaxGain[pos + 1] + gain;
	}

	// Remaining blockers after `pos` that CAN block attacker `ai` (to prune impossible minBlockers early)
	const remainingCanBlock: Int32Array[] = Array.from(
		{ length: numB + 1 },
		() => new Int32Array(numA)
	);
	for (let pos = numB - 1; pos >= 0; pos--) {
		remainingCanBlock[pos].set(remainingCanBlock[pos + 1]);
		for (const ai of legalTargetsForBlocker[blockerOrder[pos]]) {
			remainingCanBlock[pos][ai] += 1;
		}
	}

	const countOnAttacker = new Int32Array(numA);
	const currentPairs: Array<{ bi: number; ai: number }> = [];
	const chosenBlockerIndices: number[] = [];
	let bestScore = 0;
	let bestPairs: Array<{ bi: number; ai: number }> = [];
	let steps = 0;
	const MAX_STEPS = 5000;

	const dfsBlocker = (pos: number, runningScore: number): void => {
		if (steps >= MAX_STEPS) return;
		steps += 1;

		if (runningScore + suffixMaxGain[pos] <= bestScore) return;

		// Prune if any partially-blocked attacker can no longer reach its minBlockers
		for (let ai = 0; ai < numA; ai++) {
			const c = countOnAttacker[ai];
			if (c > 0 && c < atkBounds[ai].minBlockers) {
				if (c + remainingCanBlock[pos][ai] < atkBounds[ai].minBlockers) {
					return;
				}
			}
		}

		if (pos === numB) {
			// Verify all minBlockers are satisfied
			for (let ai = 0; ai < numA; ai++) {
				const c = countOnAttacker[ai];
				if (c > 0 && c < atkBounds[ai].minBlockers) return;
			}
			// Verify cantBlockAlone
			if (
				priorDistinctBlockerCount + chosenBlockerIndices.length === 1 &&
				chosenBlockerIndices.length === 1 &&
				blockerCantBlockAlone[chosenBlockerIndices[0]]
			) {
				return;
			}
			if (runningScore > bestScore) {
				bestScore = runningScore;
				bestPairs = [...currentPairs];
			}
			return;
		}

		const bi = blockerOrder[pos];
		const targets = legalTargetsForBlocker[bi];
		const cap =
			chosenBlockerIndices.length >= maxRemainingDistinctBlockers
				? 0
				: Math.min(blockerCaps[bi], targets.length);

		if (cap === 0) {
			dfsBlocker(pos + 1, runningScore);
			return;
		}

		// Enumerate non-empty subsets of `targets` of size 1..cap first (greedy-first), then empty subset
		const chooseTargetsForBlocker = (
			tIdx: number,
			chosenForB: number,
			scoreWithB: number
		): void => {
			if (steps >= MAX_STEPS) return;
			if (chosenForB > 0) {
				// Option: stop adding more attackers for this blocker and advance to pos + 1
				dfsBlocker(pos + 1, scoreWithB);
			}
			if (chosenForB >= cap || tIdx >= targets.length) return;

			for (let k = tIdx; k < targets.length; k++) {
				const ai = targets[k];
				if (countOnAttacker[ai] + 1 > atkBounds[ai].maxBlockers) continue;
				const prevCount = countOnAttacker[ai];
				countOnAttacker[ai] = prevCount + 1;
				currentPairs.push({ bi, ai });
				if (chosenForB === 0) chosenBlockerIndices.push(bi);

				let delta = attackerReqWeights[ai].allAbleWeight;
				if (prevCount === 0) delta += attackerReqWeights[ai].mustBeBlockedWeight;
				if (chosenForB === 0 && blockerMustBlock[bi]) delta += 1;

				chooseTargetsForBlocker(k + 1, chosenForB + 1, scoreWithB + delta);

				if (chosenForB === 0) chosenBlockerIndices.pop();
				currentPairs.pop();
				countOnAttacker[ai] = prevCount;
				if (steps >= MAX_STEPS) return;
			}
		};

		chooseTargetsForBlocker(0, 0, runningScore);
		// Also try not blocking with `bi` at all
		dfsBlocker(pos + 1, runningScore);
	};

	dfsBlocker(0, 0);

	return {
		maxScore: bestScore,
		bestAssignment: bestPairs.map(({ bi, ai }) => ({
			blockerInstanceId: eligibleBlockers[bi].instanceId,
			attackerInstanceId: attackerCards[ai].instanceId
		}))
	};
}

// ---- 4. CR 602.5a, 606.2: Activated-Ability Locks ------------------------------------------

/**
 * CR 602.5a, 606.2, 109.2: Checks active `k: 'cantActivateAbilities'` static locks on the
 * battlefield (*Collector Ouphe*, *Null Rod*, *Stony Silence*, *Arrest*, *Faith's Fetters*,
 * *Planar Disruption*, *Linvala, Keeper of Silence*).
 */
export function checkStaticActivatedAbilityLocks(
	state: GameState,
	_actorId: string,
	perm: CardInstance,
	isManaAbility: boolean
): { ok: boolean; error?: string } {
	if (perm.zone === 'battlefield' && perm.phasedOut) return { ok: true };

	for (const { perm: srcPerm, card: srcCard, controllerId: srcCtrlId } of abilityActivePermanents(
		state
	)) {
		const abilities = activeAbilityDefs(srcCard, instanceFaceOptions(srcPerm, 'battlefield'));
		for (const ab of abilities) {
			if (ab.kind !== 'static' || ab.static.k !== 'cantActivateAbilities') continue;
			const st = ab.static;
			if (st.allowManaAbilities && isManaAbility) continue;
			if (
				st.condition &&
				!evaluateCondition(st.condition, {
					state,
					controllerId: srcCtrlId,
					source: srcPerm
				})
			) {
				continue;
			}

			let matches = false;
			if (st.affected === 'self') {
				matches = perm.zone === 'battlefield' && srcPerm.instanceId === perm.instanceId;
			} else if (st.affected === 'attachedTo') {
				matches = perm.zone === 'battlefield' && srcPerm.attachedToId === perm.instanceId;
			} else {
				// CR 109.2: Type/object words without an explicit zone apply only to permanents on the battlefield.
				if (perm.zone !== 'battlefield' && st.affected.zone === undefined) {
					matches = false;
				} else {
					matches = matchesObjectFilter(perm, st.affected, {
						state,
						controllerId: srcCtrlId,
						source: srcPerm
					});
				}
			}

			if (matches) {
				return {
					ok: false,
					error: `Illegal Activation: ${srcCard.name} prevents activated abilities of ${perm.card.name} from being activated (CR 602.5a).`
				};
			}
		}
	}
	return { ok: true };
}

// ---- 5. P8.4: Shocklands, Reveal Lands, & Generalized *Clone* -------------------------------

/**
 * CR 119.4, 119.8: A player cannot pay `amount` life if their life total is less than `amount`
 * or if an effect states their life total can't change (*Platinum Emperion*).
 */
export function playerCantPayLifeForEtb(
	state: GameState,
	player: PlayerGameState,
	amount: number
): boolean {
	if (amount <= 0) return false;
	if (player.life < amount) return true;
	if (playerLifeTotalCantChange(state, player)) return true;
	return false;
}

/**
 * Smart bot Shockland heuristic: only pay `lifeAmount` life when `bot.life > 6` AND having +1
 * untapped mana source right now unlocks casting a card in hand/command/graveyard/library or
 * activating an ability on the battlefield!
 */
export function botShouldPayShocklandLife(
	state: GameState,
	bot: PlayerGameState,
	_landObj: CardInstance,
	lifeAmount: number
): boolean {
	if (bot.life <= 6 || bot.life <= lifeAmount) return false;
	if (playerCantPayLifeForEtb(state, bot, lifeAmount)) return false;

	const poolMana =
		bot.manaPool.W +
		bot.manaPool.U +
		bot.manaPool.B +
		bot.manaPool.R +
		bot.manaPool.G +
		bot.manaPool.C;
	let untappedSources = 0;
	for (const perm of bot.battlefield) {
		if (perm.phasedOut || perm.tapped) continue;
		const ev = evaluatePermanent(state, perm);
		if (
			ev.isLand ||
			ev.breakdown.items.some((it) => !it.removed && it.canonicalKey.startsWith('mana_')) ||
			activeAbilityDefs(
				effectiveCardForObject(perm),
				instanceFaceOptions(perm, 'battlefield')
			).some((a) => a.kind === 'activated' && a.isMana && (!ev.isCreature || !perm.summoningSick))
		) {
			untappedSources += 1;
		}
	}
	const currentAvailableMana = poolMana + untappedSources;
	const withShocklandMana = currentAvailableMana + 1;

function manaCostSymbolTotal(costStr: string): number {
	let total = 0;
	for (const m of costStr.matchAll(/\{([^}]+)\}/g)) {
		const sym = m[1].trim().toUpperCase();
		if (/^\d+$/.test(sym)) {
			total += parseInt(sym, 10);
		} else if (sym === 'X' || sym === 'Y' || sym === 'Z') {
			continue;
		} else if (/^\d+\/[WUBRGC]$/.test(sym)) {
			total += 1;
		} else {
			total += 1;
		}
	}
	return total;
}

	// Check if any spell in hand or command zone costs `withShocklandMana` (becomes affordable with +1 mana)
	const candidateCards = [...bot.hand, ...bot.command];
	for (const c of candidateCards) {
		const def = activeCharacteristics(effectiveCardForObject(c), instanceFaceOptions(c));
		if (def.types.includes('Land') && !def.types.includes('Creature')) continue;
		const totalNeeded = manaCostSymbolTotal(def.manaCost || '');
		if (totalNeeded > 0 && totalNeeded > currentAvailableMana && totalNeeded <= withShocklandMana) {
			return true;
		}
	}

	// Also check activated abilities on bot's battlefield permanents
	for (const perm of bot.battlefield) {
		if (perm.phasedOut) continue;
		for (const ab of activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		)) {
			if (ab.kind !== 'activated' || ab.isMana) continue;
			const manaPart = ab.cost.find((d) => d.k === 'mana');
			if (!manaPart || manaPart.k !== 'mana') continue;
			const totalNeeded = manaCostSymbolTotal(manaPart.cost);
			if (
				totalNeeded > 0 &&
				totalNeeded > currentAvailableMana &&
				totalNeeded <= withShocklandMana
			) {
				return true;
			}
		}
	}

	return false;
}

/**
 * CR 701.20a: Stamps `knownToPlayerIds` on a card in `hand` with all living player IDs so
 * `sanitizeGameStateForViewer` exposes it until it leaves the hand (`zones.ts:473`).
 */
export function markHandCardRevealedToAll(state: GameState, cardInst: CardInstance): void {
	const viewerIds = state.players.filter((p) => !p.lost).map((p) => p.playerId);
	const merged = new Set<string>([...(cardInst.knownToPlayerIds ?? []), ...viewerIds]);
	cardInst.knownToPlayerIds = [...merged];
}

export interface SelfCloneReplacementSpec {
	copyOf: ObjectFilter;
	copyOptional: boolean;
	copyModifications?: CopyModificationSpec;
	tapped?: boolean;
}

/**
 * Inspects `card`'s active replacement definitions for a Generalized *Clone* self-ETB replacement
 * (`[You may have ]~ enter[s] [tapped ]as a copy of <filter>[, except ...]`).
 */
export function findSelfCloneReplacementSpec(
	card: ScryfallCard,
	faceOpts?: ResolveObjectFacesOptions
): SelfCloneReplacementSpec | null {
	for (const ab of activeAbilityDefs(card, faceOpts)) {
		if (ab.kind !== 'replacement') continue;
		const rep = ab.replacement;
		if (rep.replaces.event !== 'zoneChange') continue;
		if (rep.replaces.filter?.object !== 'self' || rep.replaces.filter?.to !== 'battlefield') {
			continue;
		}
		if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.copyOf) continue;
		return {
			copyOf: rep.with.copyOf,
			copyOptional: rep.with.copyOptional !== false,
			...(rep.with.copyModifications ? { copyModifications: rep.with.copyModifications } : {}),
			...(rep.with.tapped ? { tapped: true } : {})
		};
	}
	return null;
}

/**
 * Finds all legal permanents on the battlefield that `sourceObj` (controlled by `controllerId`)
 * can enter as a copy of for `copyFilter`, sorted descending by mana value for smart defaults/bots.
 */
export function findLegalCloneCandidates(
	state: GameState,
	controllerId: string,
	sourceObj: CardInstance | undefined,
	copyFilter: ObjectFilter
): CardInstance[] {
	const effectiveFilter: ObjectFilter = { ...copyFilter, other: true };
	const out: CardInstance[] = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const b of p.battlefield) {
			if (b.phasedOut) continue;
			if (sourceObj && b.instanceId === sourceObj.instanceId) continue;
			if (
				matchesObjectFilter(b, effectiveFilter, {
					state,
					controllerId,
					source: sourceObj
				})
			) {
				out.push(b);
			}
		}
	}
	out.sort(
		(a, b) =>
			effectiveManaValue(effectiveCardForObject(b), instanceFaceOptions(b, 'battlefield')) -
			effectiveManaValue(effectiveCardForObject(a), instanceFaceOptions(a, 'battlefield'))
	);
	return out;
}

function mergeUniqueStrings(
	existing: readonly string[] | undefined,
	added: readonly string[]
): string[] {
	const out = [...(existing ?? [])];
	for (const item of added) {
		if (!out.some((e) => e.toLowerCase() === item.toLowerCase())) {
			out.push(item);
		}
	}
	return out;
}

function mergeUniqueColors(
	existing: readonly ManaColor[] | undefined,
	added: readonly ManaColor[]
): ManaColor[] {
	const out = [...(existing ?? [])];
	for (const c of added) {
		if (!out.includes(c)) out.push(c);
	}
	return out;
}

/**
 * CR 707.9a–d: Applies `CopyModificationSpec` exceptions onto `copiableState` (Layer 1a copiable
 * values), preserving prior copy exceptions from the copied permanent (`CR 707.3`) unless
 * overwritten by the new copy effect.
 */
export function applyCopyModificationSpecToState(
	copiableState: CopiableState,
	baseCardToCopy: ScryfallCard,
	mods: CopyModificationSpec | undefined,
	selfOriginalName?: string
): void {
	if (!mods) return;
	const except: NonNullable<CopiableState['except']> = {
		...(copiableState.except ?? {})
	};

	if (mods.keepSelfName && selfOriginalName) {
		except.names = [selfOriginalName];
	} else if (mods.overrideName !== undefined) {
		except.names = [mods.overrideName];
	} else if (mods.name !== undefined) {
		except.names = [mods.name];
	}
	if (mods.power !== undefined) {
		except.power = mods.power;
	}
	if (mods.toughness !== undefined) {
		except.toughness = mods.toughness;
	}
	if (mods.setColors !== undefined) {
		except.colors = [...mods.setColors];
		delete except.addColors;
	}
	if (mods.addColors?.length) {
		if (except.colors) {
			except.colors = mergeUniqueColors(except.colors, mods.addColors);
		} else {
			except.addColors = mergeUniqueColors(except.addColors, mods.addColors);
		}
	}
	if (mods.setTypes !== undefined) {
		except.types = [...mods.setTypes];
		delete except.addTypes;
	}
	if (mods.addTypes?.length) {
		if (except.types) {
			except.types = mergeUniqueStrings(except.types, mods.addTypes);
		} else {
			except.addTypes = mergeUniqueStrings(except.addTypes, mods.addTypes);
		}
	}
	if (mods.setSubtypes !== undefined) {
		except.subtypes = [...mods.setSubtypes];
		delete except.addSubtypes;
	}
	if (mods.addSubtypes?.length) {
		if (except.subtypes) {
			except.subtypes = mergeUniqueStrings(except.subtypes, mods.addSubtypes);
		} else {
			except.addSubtypes = mergeUniqueStrings(except.addSubtypes, mods.addSubtypes);
		}
	}
	if (mods.removeSupertypes?.length) {
		except.removeSupertypes = mergeUniqueStrings(
			except.removeSupertypes,
			mods.removeSupertypes
		);
		if (mods.removeSupertypes.some((s) => s.toLowerCase() === 'legendary')) {
			baseCardToCopy.typeLine = baseCardToCopy.typeLine.replace(/\bLegendary\s+/g, '');
			for (const f of baseCardToCopy.faces ?? []) {
				if (f.typeLine) f.typeLine = f.typeLine.replace(/\bLegendary\s+/g, '');
			}
		}
	}
	if (mods.addKeywords?.length) {
		except.addKeywords = mergeUniqueStrings(except.addKeywords, mods.addKeywords);
	}
	if (mods.noManaCost) {
		except.noManaCost = true;
	}

	copiableState.except = except;
}

/**
 * CR 707.2, 707.5, 707.9, 708.2, 712.6d: Copies `targetPerm`'s Layer 1 copiable values (and any
 * `CopyModificationSpec` exceptions) onto `destPerm`, returning the copied object's display name.
 */
export function applyCopiedPermanentToInstance(
	destPerm: CardInstance,
	targetPerm: CardInstance,
	mods?: CopyModificationSpec,
	selfOriginalCard?: ScryfallCard,
	state?: GameState
): string {
	const originalCard = selfOriginalCard ?? destPerm.printedCard ?? destPerm.card;
	if (targetPerm.isFaceDown) {
		const strippedSpec = targetPerm.faceDownSpec ? { ...targetPerm.faceDownSpec } : undefined;
		if (strippedSpec) {
			delete strippedSpec.turnUpCost;
			delete strippedSpec.knownToPlayerIds;
		}
		const label = targetPerm.faceDownLabel || 'Face-Down Creature';
		const baseCardToCopy = scrubFaceDownCard(label, 'battlefield', strippedSpec);
		const copiableState: CopiableState = { card: baseCardToCopy };
		applyCopyModificationSpecToState(copiableState, baseCardToCopy, mods, originalCard.name);
		destPerm.printedCard = originalCard;
		destPerm.copiableState = copiableState;
		destPerm.copiableCard = baseCardToCopy;
		destPerm.card = baseCardToCopy;
		destPerm.isFaceDown = false;
		destPerm.transformed = false;
		destPerm.activeFaceIndex = undefined;
		destPerm.unlockedFaces = undefined;
		return resolveObjectFaces(baseCardToCopy, instanceFaceOptions(destPerm, 'battlefield')).name;
	}

	const priorCopy = state
		? (activeTimedLayer1aForPermanent(state, targetPerm) ?? targetPerm.copiableState)
		: targetPerm.copiableState;
	const sourceCard = priorCopy?.card ?? effectiveCardForObject(targetPerm);
	const baseCardToCopy = JSON.parse(JSON.stringify(sourceCard)) as ScryfallCard;
	const targetOpts = instanceFaceOptions(targetPerm, 'battlefield');
	const faceIdx = priorCopy?.faceIndex !== undefined ? priorCopy.faceIndex : (targetOpts.faceIndex ?? 0);
	const isSingleFaceCopy =
		faceIdx > 0 ||
		Boolean(!priorCopy && targetPerm.transformed) ||
		Boolean(priorCopy?.isSingleFaceCopy) ||
		((baseCardToCopy.layout === 'transform' || baseCardToCopy.layout === 'modal_dfc') &&
			(baseCardToCopy.faces?.length ?? 0) > 1);
	const isPrototyped = Boolean((!priorCopy && targetPerm.prototyped) || priorCopy?.prototyped);
	const copiableState: CopiableState = {
		card: baseCardToCopy,
		...(faceIdx > 0 || isSingleFaceCopy ? { faceIndex: faceIdx, isSingleFaceCopy: true } : {}),
		...(isPrototyped ? { prototyped: true } : {}),
		...(priorCopy?.except
			? { except: { ...priorCopy.except } }
			: {})
	};
	applyCopyModificationSpecToState(copiableState, baseCardToCopy, mods, originalCard.name);

	destPerm.printedCard = originalCard;
	destPerm.copiableState = copiableState;
	destPerm.copiableCard = baseCardToCopy;
	destPerm.card = baseCardToCopy;
	destPerm.isFaceDown = false;
	destPerm.transformed = false;
	destPerm.activeFaceIndex = undefined;
	destPerm.unlockedFaces = undefined;
	return resolveObjectFaces(baseCardToCopy, instanceFaceOptions(destPerm, 'battlefield')).name;
}

// ---- 6. P8.4: Top-of-Library Visibility & Non-Hand Play Permissions -------------------------

/**
 * CR 401.5: Evaluates active `k: 'topOfLibraryVisibility'` static abilities controlled by
 * `playerId` (*Courser of Kruphix*, *Future Sight*, *Mystic Forge*, *Vizier of the Menagerie*,
 * *Augur of Autumn*, *Realmwalker*).
 */
export function getPlayerTopOfLibraryVisibility(
	state: GameState,
	playerId: string
): { revealToAll: boolean; lookByController: boolean } {
	return withStableLayerInputs(state, () => {
		let revealToAll = false;
		let lookByController = false;
		for (const { perm, card, controllerId } of abilityActivePermanents(state)) {
			if (controllerId !== playerId) continue;
			for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'static' || ab.static.k !== 'topOfLibraryVisibility') continue;
				const st = ab.static;
				if (
					st.condition &&
					!evaluateCondition(st.condition, {
						state,
						controllerId,
						source: perm
					})
				) {
					continue;
				}
				if (st.mode === 'reveal') {
					revealToAll = true;
				} else {
					lookByController = true;
				}
			}
		}
		return { revealToAll, lookByController };
	});
}

/**
 * CR 305.1, 401.5: Checks whether `playerId` currently has an active `k: 'zonePlayPermission'`
 * allowing them to play `landInst` as a land from `zone` (`'library'` = top card only, or
 * `'graveyard'` = owner's graveyard, e.g. *Crucible of Worlds* / *Ramunap Excavator* /
 * *Courser of Kruphix* / *Augur of Autumn*).
 */
export function getActiveZoneLandPlayPermissionSource(
	state: GameState,
	playerId: string,
	zone: 'library' | 'graveyard',
	landInst: CardInstance
): string | null {
	const player = state.players.find((p) => p.playerId === playerId && !p.lost);
	if (!player) return null;
	if (zone === 'library') {
		if (player.library[0]?.instanceId !== landInst.instanceId) return null;
	} else {
		if (!player.graveyard.some((c) => c.instanceId === landInst.instanceId)) return null;
	}

	return withStableLayerInputs(state, () => {
		for (const { perm, card, controllerId } of abilityActivePermanents(state)) {
			if (controllerId !== playerId) continue;
			for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'static' || ab.static.k !== 'zonePlayPermission') continue;
				const st = ab.static;
				if (st.zone !== zone || !st.allowLands) continue;
				// --- Track P14: slotted & self-only permissions are resolved via Wave 5 slot helpers ---
				if (st.affects === 'self' || (st.slotMode && st.slotMode !== 'unlimited')) continue;
				if (st.duringYourTurnOnly && state.players[state.activePlayerIndex]?.playerId !== playerId) {
					continue;
				}
				// --- End Track P14 ---
				if (
					st.condition &&
					!evaluateCondition(st.condition, {
						state,
						controllerId,
						source: perm
					})
				) {
					continue;
				}
				return card.name;
			}
		}
		return null;
	});
}

/**
 * CR 601.1a, 401.5: Checks whether `playerId` currently has an active `k: 'zonePlayPermission'`
 * (`zone: 'library', allowSpells: true`) allowing them to cast face `faceIndex` of `cardInst`
 * from the top of their library (*Future Sight*, *Mystic Forge*, *Vizier of the Menagerie*,
 * *Augur of Autumn*, *Realmwalker*).
 *
 * Evaluates `spellFilter` against the spell face characteristics as it would exist on the stack!
 */
export function getActiveTopOfLibrarySpellPermissionSource(
	state: GameState,
	playerId: string,
	cardInst: CardInstance,
	faceIndex = 0,
	fused = false
): string | null {
	const player = state.players.find((p) => p.playerId === playerId && !p.lost);
	if (!player || player.library[0]?.instanceId !== cardInst.instanceId) return null;

	return withStableLayerInputs(state, () => {
		const spellCard = effectiveCardForObject(cardInst);
		const stackFaceView = resolveObjectFaces(spellCard, {
			zone: 'stack',
			faceIndex,
			fused
		});
		if (stackFaceView.types.includes('Land') && !stackFaceView.types.includes('Creature')) {
			return null;
		}
		// Build a synthetic face-specific CardInstance view so multi-face cards (MDFCs / Adventures)
		// check `spellFilter` against the face actually being cast (CR 601.3e, 712.8)!
		const spellFaceObj: CardInstance = {
			...cardInst,
			zone: 'stack',
			controllerId: playerId,
			ownerId: cardInst.ownerId || playerId,
			activeFaceIndex: faceIndex
		};

		for (const { perm, card, controllerId } of abilityActivePermanents(state)) {
			if (controllerId !== playerId) continue;
			for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'static' || ab.static.k !== 'zonePlayPermission') continue;
				const st = ab.static;
				if (st.zone !== 'library' || !st.allowSpells) continue;
				// --- Track P14 ---
				if (st.affects === 'self' || (st.slotMode && st.slotMode !== 'unlimited')) continue;
				if (st.duringYourTurnOnly && state.players[state.activePlayerIndex]?.playerId !== playerId) {
					continue;
				}
				// --- End Track P14 ---
				if (
					st.condition &&
					!evaluateCondition(st.condition, {
						state,
						controllerId,
						source: perm
					})
				) {
					continue;
				}
				if (st.spellFilter) {
					const filterWithoutZone: ObjectFilter = {
						...st.spellFilter,
						zone: undefined
					};
					if (
						!matchesObjectFilter(spellFaceObj, filterWithoutZone, {
							state,
							controllerId,
							source: perm
						})
					) {
						continue;
					}
				}
				return card.name;
			}
		}
		return null;
	});
}
