/**
 * Track P7 runtime primitives:
 * - Slice P7.1: Damage prevention shields (CR 615.1–12), exile-instead-of-dying riders (CR 614.1a),
 *   and timed combat block/evasion restrictions (CR 509.1b).
 * - Slice P7.2: Modified copiable state builder (CR 707.2, 707.8a, 707.9a–d), temporary Layer 1a
 *   copy effects, and tapped-and-attacking token entry (CR 508.4).
 * - Slice P7.3: CR 601.2d / 608.2b divided target validation & locked resolution amounts, plus
 *   APNAP wheel / discard-hand execution.
 * - Slice P7.4: Turn-history state trackers & condition evaluation (CR 603.4, CR 508.1k).
 *
 * Pure structured data: never reads rules text or branches on card names, and never stores IR in GameState.
 */
import type {
	Condition,
	CopyModificationSpec,
	Duration,
	TimedCombatRestrictionSpec
} from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import {
	activeFaceIndexForObject,
	effectiveCardForObject,
	scrubFaceDownCard
} from '../scryfall.ts';
// --- Track P14 ---
import { applyStaticDamagePreventionWave5 } from './staticsAndCostsWave5.ts';
// --- End Track P14 ---
// --- Track P18a ---
import { applyAbsorbDamagePrevention } from './keywordsWave6.ts';
// --- End Track P18a ---
import type {
	CardInstance,
	CopiableState,
	DamagePreventionShieldEntry,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	TargetRef,
	ZoneType
} from '../types.ts';
import { matchesColorFilter, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
// --- Track P10 ---
import { recordDescendedOnZoneChange } from './reflexiveManaAndActions.ts';
// --- End Track P10 ---
import { activeRuleModifiers } from './replace.ts';
// --- Track P22a ---
import {
	isDamageUnpreventableWave8,
	type UnpreventableDamageSourceContext
} from './staticsWave8.ts';
// --- End Track P22a ---
// --- Wave 10 ---
import { shieldMatchesWave10Source } from './combatWave10.ts';
// --- End Wave 10 ---

// ---- Subtype classification for CR 205.1a type-overwriting copy exceptions ------------------

const LAND_SUBTYPES = new Set([
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
	"Urza's"
]);

const ARTIFACT_SUBTYPES = new Set([
	'Equipment',
	'Treasure',
	'Clue',
	'Food',
	'Blood',
	'Powerstone',
	'Map',
	'Junk',
	'Gold',
	'Lander',
	'Mutagen',
	'Heartwood',
	'Vibranium',
	'Fortification',
	'Vehicle',
	'Spacecraft'
]);

const ENCHANTMENT_SUBTYPES = new Set([
	'Aura',
	'Saga',
	'Shrine',
	'Cartouche',
	'Curse',
	'Rune',
	'Shard',
	'Background',
	'Case',
	'Class',
	'Room',
	'Role'
]);

const SPELL_SUBTYPES = new Set(['Arcane', 'Adventure', 'Lesson', 'Trap']);

function dedupeStrings<T extends string>(items: readonly T[]): T[] {
	const seen = new Set<T>();
	const out: T[] = [];
	for (const item of items) {
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
}

function filterSubtypesForRetainedTypes(
	subtypes: readonly string[],
	retainedTypes: readonly string[]
): string[] {
	const hasCreature = retainedTypes.includes('Creature') || retainedTypes.includes('Kindred');
	const hasLand = retainedTypes.includes('Land');
	const hasArtifact = retainedTypes.includes('Artifact');
	const hasEnchantment = retainedTypes.includes('Enchantment');
	const hasSpell = retainedTypes.includes('Instant') || retainedTypes.includes('Sorcery');
	const hasPlaneswalker = retainedTypes.includes('Planeswalker');
	return subtypes.filter((sub) => {
		if (LAND_SUBTYPES.has(sub)) return hasLand;
		if (ARTIFACT_SUBTYPES.has(sub)) return hasArtifact;
		if (ENCHANTMENT_SUBTYPES.has(sub)) return hasEnchantment;
		if (SPELL_SUBTYPES.has(sub)) return hasSpell;
		// Creature/planeswalker subtypes: retain if Creature/Kindred or Planeswalker is retained.
		return hasCreature || hasPlaneswalker;
	});
}

// ---- Slice P7.1: Damage Prevention Shields (CR 615.1–12) ------------------------------------

/**
 * CR 615.12: Checks whether damage currently cannot be prevented (either via a resolving turn-wide
 * effect or an active static `damageCantBePrevented` rule modifier).
 */
export function isDamageUnpreventable(
	state: GameState,
	isCombat = false,
	// --- Track P22a ---
	sourceCtx?: UnpreventableDamageSourceContext
	// --- End Track P22a ---
): boolean {
	if (state.damageCantBePreventedThisTurn) return true;
	if (isCombat && state.combatDamageCantBePreventedThisTurn) return true;
	if (activeRuleModifiers(state, 'damageCantBePrevented').length > 0) return true;
	// --- Track P22a ---
	if (isDamageUnpreventableWave8(state, isCombat, sourceCtx)) return true;
	// --- End Track P22a ---
	return false;
}

export function addDamagePreventionShield(
	state: GameState,
	entry: DamagePreventionShieldEntry
): void {
	if (typeof entry.remaining === 'number' && entry.remaining <= 0) return;
	(state.damagePreventionShields ??= []).push(entry);
}

function findBattlefieldPermanent(
	state: GameState,
	instanceId: string
): { perm: CardInstance; controllerId: string } | null {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (perm.instanceId === instanceId && !perm.phasedOut) {
				return { perm, controllerId: p.playerId };
			}
		}
	}
	return null;
}

function shieldProtectsTarget(
	state: GameState,
	shield: DamagePreventionShieldEntry,
	targetKind: 'permanent' | 'player',
	targetId: string,
	targetPerm: CardInstance | undefined,
	targetControllerId: string | undefined,
	sourceInst: CardInstance | undefined
): boolean {
	// CR 615 / "dealt to and dealt by": if `alsoPreventDealtByTarget` is set on a permanent shield,
	// also match damage dealt BY that permanent (while its objectVersion still matches, CR 400.7).
	if (
		shield.alsoPreventDealtByTarget &&
		shield.targetKind === 'permanent' &&
		shield.targetId &&
		sourceInst &&
		sourceInst.instanceId === shield.targetId
	) {
		const liveSource = findBattlefieldPermanent(state, shield.targetId);
		const verMatches =
			shield.targetObjectVersion === undefined ||
			(liveSource
				? (liveSource.perm.objectVersion ?? 1) === shield.targetObjectVersion
				: (sourceInst.objectVersion ?? 1) === shield.targetObjectVersion);
		if (verMatches) return true;
	}

	switch (shield.targetKind) {
		case 'any':
			return true;
		case 'player':
			return targetKind === 'player' && shield.targetId === targetId;
		case 'permanent': {
			if (targetKind !== 'permanent' || shield.targetId !== targetId || !targetPerm) return false;
			if (
				shield.targetObjectVersion !== undefined &&
				(targetPerm.objectVersion ?? 1) !== shield.targetObjectVersion
			) {
				return false;
			}
			return true;
		}
		case 'permanentsControlledBy': {
			if (targetKind !== 'permanent' || !targetPerm) return false;
			if (targetControllerId !== shield.targetId) return false;
			if (shield.targetTypes && shield.targetTypes.length > 0) {
				const ev = evaluatePermanent(state, targetPerm);
				const words = ev.typeLine.split(/[\s—]+/);
				if (!shield.targetTypes.some((t) => words.includes(t))) return false;
			}
			return true;
		}
		case 'playerAndPermanentsControlledBy': {
			if (targetKind === 'player') return targetId === shield.targetId;
			if (!targetPerm) return false;
			if (targetControllerId !== shield.targetId) return false;
			if (shield.targetTypes && shield.targetTypes.length > 0) {
				const ev = evaluatePermanent(state, targetPerm);
				const words = ev.typeLine.split(/[\s—]+/);
				if (!shield.targetTypes.some((t) => words.includes(t))) return false;
			}
			return true;
		}
	}
}

// --- Track P22d ---
export type DamagePreventedHandler = (
	state: GameState,
	shield: DamagePreventionShieldEntry,
	preventedAmount: number,
	opts: {
		sourceId?: string;
		sourceInst?: CardInstance;
		sourceCard?: ScryfallCard;
		sourceControllerId?: string;
	}
) => void;

let onDamagePreventedHook: DamagePreventedHandler | null = null;

export function registerDamagePreventedHandler(fn: DamagePreventedHandler): void {
	onDamagePreventedHook = fn;
}
// --- End Track P22d ---

function shieldMatchesDamageSource(
	state: GameState,
	shield: DamagePreventionShieldEntry,
	sourceInst: CardInstance | undefined,
	sourceId?: string,
	sourceTypes?: readonly string[],
	sourceCard?: ScryfallCard,
	sourceControllerId?: string
): boolean {
	// --- Track P22d ---
	if (shield.fromSourceStackItemId !== undefined) {
		const actualId = sourceInst?.instanceId ?? sourceId;
		if (
			!actualId ||
			(actualId !== shield.fromSourceStackItemId && actualId !== shield.fromSourceInstanceId)
		) {
			return false;
		}
	} else if (shield.fromSourceInstanceId !== undefined) {
	// --- End Track P22d ---
		const actualId = sourceInst?.instanceId ?? sourceId;
		if (!actualId || actualId !== shield.fromSourceInstanceId) return false;
		if (shield.fromSourceObjectVersion !== undefined) {
			const live = findBattlefieldPermanent(state, actualId);
			if (live) {
				if ((live.perm.objectVersion ?? 1) !== shield.fromSourceObjectVersion) return false;
			} else if (sourceInst && (sourceInst.objectVersion ?? 1) !== shield.fromSourceObjectVersion) {
				return false;
			}
		}
	}
	if (shield.fromAttackingOnly) {
		const actualId = sourceInst?.instanceId ?? sourceId;
		if (!actualId || !state.combat.active) return false;
		if (!state.combat.attackers.some((a) => a.attackerInstanceId === actualId)) {
			return false;
		}
	}
	if (shield.fromSourceTypes && shield.fromSourceTypes.length > 0) {
		if (sourceInst) {
			const live = findBattlefieldPermanent(state, sourceInst.instanceId);
			if (live) {
				const ev = evaluatePermanent(state, live.perm);
				const typeWords = ev.typeLine.split(/[\s—]+/);
				if (!shield.fromSourceTypes.some((t) => typeWords.includes(t))) return false;
			} else {
				const view = resolveObjectFaces(effectiveCardForObject(sourceInst), {
					zone: sourceInst.zone
				});
				if (!shield.fromSourceTypes.some((t) => view.types.includes(t))) return false;
			}
		} else if (sourceTypes && sourceTypes.length > 0) {
			if (!shield.fromSourceTypes.some((t) => sourceTypes.includes(t))) return false;
		} else {
			return false;
		}
	}
	return shieldMatchesWave10Source(state, shield, {
		sourceInst,
		sourceId,
		sourceCard,
		sourceControllerId
	});
}

/**
 * CR 615.1, 615.6, 615.7, 615.12: Applies active `DamagePreventionShieldEntry` shields to incoming
 * damage, returning the post-prevention damage amount (`>= 0`).
 *
 * - CR 615.12: If damage cannot be prevented, returns `amount` unchanged and does NOT deplete any
 *   shield's `remaining` count.
 * - CR 615.7: Depletes numeric `remaining` by 1 per point prevented and removes exhausted shields.
 */
export function applyDamagePreventionShields(
	state: GameState,
	opts: {
		amount: number;
		isCombat: boolean;
		targetKind: 'permanent' | 'player';
		targetId: string;
		targetPerm?: CardInstance;
		targetControllerId?: string;
		sourceInst?: CardInstance;
		sourceId?: string;
		sourceTypes?: readonly string[];
		// --- Track P14 ---
		sourceCard?: ScryfallCard;
		sourceControllerId?: string;
		// --- End Track P14 ---
	}
): number {
	if (opts.amount <= 0) return 0;
	// --- Track P14 (CR 615.1, 615.5–6, 615.10, 615.12): Static damage prevention & Phantom counter removal ---
	const unpreventable = isDamageUnpreventable(
		state,
		opts.isCombat,
		// --- Track P22a ---
		{
			sourcePerm: opts.sourceInst,
			sourceCard: opts.sourceCard,
			sourceControllerId: opts.sourceControllerId
		}
		// --- End Track P22a ---
	);
	let remainingDamage = applyStaticDamagePreventionWave5(
		state,
		{
			amount: opts.amount,
			isCombat: opts.isCombat,
			targetKind: opts.targetKind,
			targetPerm: opts.targetPerm,
			targetPlayerId: opts.targetKind === 'player' ? opts.targetId : undefined,
			sourceInstanceId: opts.sourceInst?.instanceId ?? opts.sourceId,
			sourceInfo:
				opts.sourceCard || opts.sourceControllerId
					? { card: opts.sourceCard, controllerId: opts.sourceControllerId }
					: undefined
		},
		unpreventable
	);
	if (remainingDamage <= 0) return 0;
	if (unpreventable) return remainingDamage;
	// --- End Track P14 ---

	// --- Track P18a: Absorb N (CR 702.64a–c) ---
	remainingDamage = applyAbsorbDamagePrevention(
		state,
		opts.targetKind,
		opts.targetPerm,
		remainingDamage
	);
	if (remainingDamage <= 0) return 0;
	// --- End Track P18a ---

	const shields = state.damagePreventionShields;
	if (!shields || shields.length === 0) return remainingDamage;

	// First check infinite shields (e.g. "Prevent all [combat] damage ...") so finite "next N" shields
	// aren't needlessly consumed when an infinite shield already prevents all of this event's damage.
	for (let sIdx = 0; sIdx < shields.length; sIdx++) {
		const shield = shields[sIdx];
		if (shield.redirectTo !== undefined || shield.minLifeFloor !== undefined) continue;
		if (shield.remaining !== 'infinite') continue;
		if (shield.combatOnly && !opts.isCombat) continue;
		if (
			!shieldProtectsTarget(
				state,
				shield,
				opts.targetKind,
				opts.targetId,
				opts.targetPerm,
				opts.targetControllerId,
				opts.sourceInst
			)
		) {
			continue;
		}
		if (
			!shieldMatchesDamageSource(
				state,
				shield,
				opts.sourceInst,
				opts.sourceId,
				opts.sourceTypes,
				opts.sourceCard,
				opts.sourceControllerId
			)
		) {
			continue;
		}
		// --- Track P22d ---
		if (shield.nextEventOnly) {
			state.damagePreventionShields = shields.filter((_, idx) => idx !== sIdx);
		}
		const hasRider = Boolean(
			shield.onPrevented ||
				shield.onPreventedToDamageSourceController ||
				shield.onPreventedCreature ||
				shield.onPreventedNoncreature
		);
		if (hasRider && onDamagePreventedHook) {
			onDamagePreventedHook(state, shield, remainingDamage, {
				sourceId: opts.sourceId,
				sourceInst: opts.sourceInst,
				sourceCard: opts.sourceCard,
				sourceControllerId: opts.sourceControllerId
			});
		}
		// --- End Track P22d ---
		return 0;
	}

	// Apply finite "Prevent the next N damage" shields in creation order (CR 615.7).
	const kept: DamagePreventionShieldEntry[] = [];
	// --- Track P22d ---
	const preventedRiders: Array<{ shield: DamagePreventionShieldEntry; prevented: number }> = [];
	// --- End Track P22d ---
	for (const shield of shields) {
		// Prune shields on permanents whose objectVersion changed (CR 400.7).
		if (shield.targetKind === 'permanent' && shield.targetId) {
			const live = findBattlefieldPermanent(state, shield.targetId);
			if (
				!live ||
				(shield.targetObjectVersion !== undefined &&
					(live.perm.objectVersion ?? 1) !== shield.targetObjectVersion)
			) {
				continue;
			}
		}
		if (
			remainingDamage <= 0 ||
			shield.remaining === 'infinite' ||
			shield.redirectTo !== undefined ||
			shield.minLifeFloor !== undefined
		) {
			kept.push(shield);
			continue;
		}
		if (
			(shield.combatOnly && !opts.isCombat) ||
			!shieldProtectsTarget(
				state,
				shield,
				opts.targetKind,
				opts.targetId,
				opts.targetPerm,
				opts.targetControllerId,
				opts.sourceInst
			) ||
			!shieldMatchesDamageSource(
				state,
				shield,
				opts.sourceInst,
				opts.sourceId,
				opts.sourceTypes,
				opts.sourceCard,
				opts.sourceControllerId
			)
		) {
			kept.push(shield);
			continue;
		}
		const prevented = Math.min(remainingDamage, shield.remaining);
		remainingDamage -= prevented;
		// --- Track P22d ---
		const hasRider = Boolean(
			shield.onPrevented ||
				shield.onPreventedToDamageSourceController ||
				shield.onPreventedCreature ||
				shield.onPreventedNoncreature
		);
		if (prevented > 0 && hasRider) {
			preventedRiders.push({ shield, prevented });
		}
		const left = shield.nextEventOnly ? 0 : shield.remaining - prevented;
		// --- End Track P22d ---
		if (left > 0) {
			kept.push({ ...shield, remaining: left });
		}
	}
	state.damagePreventionShields = kept;
	// --- Track P22d ---
	if (preventedRiders.length > 0 && onDamagePreventedHook) {
		for (const entry of preventedRiders) {
			onDamagePreventedHook(state, entry.shield, entry.prevented, {
				sourceId: opts.sourceId,
				sourceInst: opts.sourceInst,
				sourceCard: opts.sourceCard,
				sourceControllerId: opts.sourceControllerId
			});
		}
	}
	// --- End Track P22d ---
	return remainingDamage;
}

// ---- Slice P7.1: Exile-Instead-of-Dying Riders (CR 614.1a, CR 400.7) ------------------------

export function registerExileInsteadOfDying(state: GameState, perm: CardInstance): void {
	if (perm.zone !== 'battlefield') return;
	const ver = perm.objectVersion ?? 1;
	const list = (state.exileInsteadOfDyingThisTurn ??= []);
	if (!list.some((e) => e.instanceId === perm.instanceId && e.objectVersion === ver)) {
		list.push({ instanceId: perm.instanceId, objectVersion: ver });
	}
}

export function shouldExileInsteadOfDying(state: GameState, perm: CardInstance): boolean {
	const list = state.exileInsteadOfDyingThisTurn;
	if (!list || list.length === 0) return false;
	const ver = perm.objectVersion ?? 1;
	return list.some((e) => e.instanceId === perm.instanceId && e.objectVersion === ver);
}

export function pruneExileInsteadOfDyingOnLtb(state: GameState, instanceId: string): void {
	if (!state.exileInsteadOfDyingThisTurn?.length) return;
	state.exileInsteadOfDyingThisTurn = state.exileInsteadOfDyingThisTurn.filter(
		(e) => e.instanceId !== instanceId
	);
}

// ---- Slice P7.1: Timed Combat Restrictions (CR 509.1b, CR 400.7) ----------------------------

export function registerTimedCombatRestriction(
	state: GameState,
	perm: CardInstance,
	spec: TimedCombatRestrictionSpec
): void {
	if (perm.zone !== 'battlefield') return;
	const ver = perm.objectVersion ?? 1;
	(state.timedCombatRestrictions ??= []).push({
		instanceId: perm.instanceId,
		objectVersion: ver,
		kind: spec.kind,
		...(spec.exceptBy
			? {
					exceptBy: {
						...(spec.exceptBy.types ? { types: [...spec.exceptBy.types] } : {}),
						...(spec.exceptBy.subtypes ? { subtypes: [...spec.exceptBy.subtypes] } : {}),
						...(spec.exceptBy.colors ? { colors: [...spec.exceptBy.colors] } : {}),
						...(spec.exceptBy.notColors ? { notColors: [...spec.exceptBy.notColors] } : {}),
						...(spec.exceptBy.artifactOrColors
							? { artifactOrColors: [...spec.exceptBy.artifactOrColors] }
							: {}),
						...(spec.exceptBy.keywords ? { keywords: [...spec.exceptBy.keywords] } : {}),
						...(spec.exceptBy.minBlockers !== undefined
							? { minBlockers: spec.exceptBy.minBlockers }
							: {}),
						...(spec.exceptBy.maxPower !== undefined ? { maxPower: spec.exceptBy.maxPower } : {})
					}
				}
			: {})
	});
}

export function isCantBlockThisTurn(state: GameState, blocker: CardInstance): boolean {
	const list = state.timedCombatRestrictions;
	if (!list || list.length === 0) return false;
	const ver = blocker.objectVersion ?? 1;
	return list.some(
		(r) =>
			// --- Track P22d ---
			(r.kind === 'cantBlock' || r.kind === 'cantAttackOrBlock') &&
			// --- End Track P22d ---
			r.instanceId === blocker.instanceId &&
			r.objectVersion === ver
	);
}

// --- Track P22d ---
export function isCantAttackThisTurn(state: GameState, attacker: CardInstance): boolean {
	const list = state.timedCombatRestrictions;
	if (!list || list.length === 0) return false;
	const ver = attacker.objectVersion ?? 1;
	return list.some(
		(r) =>
			(r.kind === 'cantAttack' || r.kind === 'cantAttackOrBlock') &&
			r.instanceId === attacker.instanceId &&
			r.objectVersion === ver
	);
}
// --- End Track P22d ---

function blockerMatchesExceptBy(
	state: GameState,
	blocker: CardInstance,
	exceptBy: NonNullable<TimedCombatRestrictionSpec['exceptBy']>
): boolean {
	const ev = evaluatePermanent(state, blocker);
	const typeWords = ev.typeLine.split(/[\s—]+/);
	const blockerColors = blocker.isFaceDown ? [] : ev.colors;

	if (exceptBy.artifactOrColors && exceptBy.artifactOrColors.length > 0) {
		const isArtifact = ev.isArtifact;
		const matchesColor = matchesColorFilter(blockerColors, exceptBy.artifactOrColors);
		if (!isArtifact && !matchesColor) return false;
	}
	if (exceptBy.types && exceptBy.types.length > 0) {
		if (!exceptBy.types.some((t) => typeWords.includes(t))) return false;
	}
	if (exceptBy.subtypes && exceptBy.subtypes.length > 0) {
		if (!exceptBy.subtypes.some((s) => ev.hasSubType(s))) return false;
	}
	if (exceptBy.colors && exceptBy.colors.length > 0) {
		if (!matchesColorFilter(blockerColors, exceptBy.colors)) return false;
	}
	if (exceptBy.notColors && exceptBy.notColors.length > 0) {
		if (matchesColorFilter(blockerColors, exceptBy.notColors)) return false;
	}
	if (exceptBy.keywords && exceptBy.keywords.length > 0) {
		const matchesKw = exceptBy.keywords.some((kw) => {
			const kwLow = kw.toLowerCase();
			return ev.breakdown.items.some(
				(it) => !it.removed && (it.canonicalKey === kwLow || it.name.toLowerCase() === kwLow)
			);
		});
		if (!matchesKw) return false;
	}
	if (exceptBy.maxPower !== undefined && ev.power > exceptBy.maxPower) {
		return false;
	}
	return true;
}

/**
 * Checks whether `blocker` is individually permitted to block `attacker` under timed `cantBeBlocked`
 * restrictions (ignoring multi-blocker `minBlockers` count, which requires group validation).
 */
export function canBlockerSatisfyTimedEvasion(
	state: GameState,
	attacker: CardInstance,
	blocker: CardInstance
): boolean {
	const list = state.timedCombatRestrictions;
	if (!list || list.length === 0) return true;
	const ver = attacker.objectVersion ?? 1;
	for (const r of list) {
		if (
			r.kind !== 'cantBeBlocked' ||
			r.instanceId !== attacker.instanceId ||
			r.objectVersion !== ver
		) {
			continue;
		}
		if (!r.exceptBy) return false;
		if (!blockerMatchesExceptBy(state, blocker, r.exceptBy)) return false;
	}
	return true;
}

/**
 * Returns the minimum number of blockers required on `attacker` by timed `cantBeBlocked` effects
 * (`1` normally, `2` for `"can't be blocked except by two or more creatures"`, etc.), or `Infinity`
 * if `attacker` cannot be blocked at all this turn.
 */
export function getTimedMinBlockersRequired(state: GameState, attacker: CardInstance): number {
	const list = state.timedCombatRestrictions;
	if (!list || list.length === 0) return 1;
	const ver = attacker.objectVersion ?? 1;
	let minReq = 1;
	for (const r of list) {
		if (
			r.kind !== 'cantBeBlocked' ||
			r.instanceId !== attacker.instanceId ||
			r.objectVersion !== ver
		) {
			continue;
		}
		if (!r.exceptBy) return Infinity;
		if (r.exceptBy.minBlockers !== undefined && r.exceptBy.minBlockers > minReq) {
			minReq = r.exceptBy.minBlockers;
		}
	}
	return minReq;
}

/**
 * CR 509.1b: Validates `assignedBlockers` against all active timed `cantBeBlocked` restrictions on
 * `attacker`, returning an illegal-block error message or `null` if legal.
 */
export function getTimedCantBeBlockedReason(
	state: GameState,
	attacker: CardInstance,
	assignedBlockers: readonly CardInstance[]
): string | null {
	if (assignedBlockers.length === 0) return null;
	const list = state.timedCombatRestrictions;
	if (!list || list.length === 0) return null;
	const ver = attacker.objectVersion ?? 1;
	for (const r of list) {
		if (
			r.kind !== 'cantBeBlocked' ||
			r.instanceId !== attacker.instanceId ||
			r.objectVersion !== ver
		) {
			continue;
		}
		if (!r.exceptBy) {
			return `${attacker.card.name} can't be blocked this turn.`;
		}
		if (r.exceptBy.minBlockers !== undefined && assignedBlockers.length < r.exceptBy.minBlockers) {
			return `${attacker.card.name} can't be blocked this turn except by ${r.exceptBy.minBlockers} or more creatures.`;
		}
		for (const b of assignedBlockers) {
			if (!blockerMatchesExceptBy(state, b, r.exceptBy)) {
				return `${b.card.name} cannot block ${attacker.card.name} this turn.`;
			}
		}
	}
	return null;
}

// ---- Slice P7.2: Layer 1a Copy Modifications & Temporary Copies (CR 707.2, 707.8a, 707.9a–d)

/**
 * Returns the latest-timestamp active temporary Layer 1a `CopiableState` affecting `inst` from
 * `state.timedContinuousEffects` (`"becomes a copy of ... until end of turn"`), or `undefined`.
 */
export function getActiveLayer1aForPermanent(
	state: GameState,
	inst: CardInstance
): CopiableState | undefined {
	const effects = state.timedContinuousEffects;
	if (!effects || effects.length === 0) return undefined;
	const ver = inst.objectVersion ?? 1;
	let best: CopiableState | undefined;
	let bestTs = -Infinity;
	for (const eff of effects) {
		if (!eff.layer1a) continue;
		if (!eff.affected.some((a) => a.instanceId === inst.instanceId && (a.objectVersion ?? 1) === ver)) {
			continue;
		}
		if (eff.timestamp >= bestTs) {
			bestTs = eff.timestamp;
			best = eff.layer1a;
		}
	}
	return best;
}

export function getEffectiveCopiableState(
	state: GameState,
	inst: CardInstance
): CopiableState | undefined {
	return getActiveLayer1aForPermanent(state, inst) ?? inst.copiableState;
}

export function getEffectiveCardForPermanent(
	state: GameState,
	inst: CardInstance
): ScryfallCard {
	return getEffectiveCopiableState(state, inst)?.card ?? effectiveCardForObject(inst);
}

/**
 * CR 707.2, 707.8a, 707.9a–d: Builds the Layer 1a `CopiableState` and cloned `ScryfallCard` for a
 * token copy (`isTokenCopy = true`) or continuous copy effect (`isTokenCopy = false`), reading ONLY
 * `target`'s Layer 1 copiable values (never counters, damage, tapped state, or Layer 4–7 buffs) and
 * merging `mod` into the copy's own copiable values.
 */
export function buildModifiedCopiableState(
	state: GameState | undefined,
	target: CardInstance,
	mod: CopyModificationSpec | undefined,
	isTokenCopy: boolean
): { baseCardToCopy: ScryfallCard; copiableState: CopiableState; displayName: string } {
	// CR 707.2 / CR 708.2: Copying a face-down permanent copies its face-down 2/2 characteristics.
	if (target.isFaceDown) {
		const strippedSpec = target.faceDownSpec ? { ...target.faceDownSpec } : undefined;
		if (strippedSpec) {
			delete strippedSpec.turnUpCost;
			delete strippedSpec.turnUpManaCost;
			delete strippedSpec.turnUpCostDefs;
			delete strippedSpec.castManaCost;
			delete strippedSpec.knownToPlayerIds;
		}
		const label = mod?.name ?? target.faceDownLabel ?? 'Face-Down Creature';
		const baseCardToCopy = scrubFaceDownCard(label, 'battlefield', strippedSpec);
		if (mod?.noManaCost) {
			baseCardToCopy.manaCost = '';
			baseCardToCopy.cmc = 0;
		}
		const faceView = resolveObjectFaces(baseCardToCopy, { zone: 'battlefield' });
		const except: NonNullable<CopiableState['except']> = {};
		if (mod?.name !== undefined) except.names = [mod.name];
		if (mod?.removeSupertypes?.length) except.removeSupertypes = [...mod.removeSupertypes];
		if (mod?.setTypes?.length) {
			except.types = [...mod.setTypes];
			const retainedSubs = filterSubtypesForRetainedTypes(faceView.subtypes, mod.setTypes);
			except.subtypes =
				mod.setSubtypes !== undefined
					? [...mod.setSubtypes]
					: mod.addSubtypes?.length
						? dedupeStrings([...retainedSubs, ...mod.addSubtypes])
						: retainedSubs;
		} else {
			if (mod?.addTypes?.length) {
				except.types = dedupeStrings([...faceView.types, ...mod.addTypes]);
			}
			if (mod?.setSubtypes !== undefined) {
				except.subtypes = [...mod.setSubtypes];
			} else if (mod?.addSubtypes?.length) {
				except.subtypes = dedupeStrings([...faceView.subtypes, ...mod.addSubtypes]);
			}
		}
		if (mod?.setColors !== undefined) {
			except.colors = [...mod.setColors];
		} else if (mod?.addColors?.length) {
			except.colors = dedupeStrings([...faceView.colors, ...mod.addColors]);
		}
		if (mod?.power !== undefined) except.power = mod.power;
		if (mod?.toughness !== undefined) except.toughness = mod.toughness;
		if (mod?.addKeywords?.length) except.addKeywords = dedupeStrings(mod.addKeywords);
		if (mod?.noManaCost) except.noManaCost = true;
		const hasExcept = Object.keys(except).length > 0;
		const copiableState: CopiableState = {
			card: baseCardToCopy,
			...(hasExcept ? { except } : {})
		};
		return { baseCardToCopy, copiableState, displayName: label };
	}

	const priorCopy = state ? getEffectiveCopiableState(state, target) : target.copiableState;
	const sourceCard = priorCopy?.card ?? effectiveCardForObject(target);
	const baseCardToCopy = JSON.parse(JSON.stringify(sourceCard)) as ScryfallCard;

	const removeSupertypes = dedupeStrings([
		...(priorCopy?.except?.removeSupertypes ?? []),
		...(mod?.removeSupertypes ?? [])
	]);
	if (removeSupertypes.some((s) => s.toLowerCase() === 'legendary')) {
		baseCardToCopy.typeLine = baseCardToCopy.typeLine.replace(/\bLegendary\s+/g, '');
		for (const f of baseCardToCopy.faces ?? []) {
			if (f.typeLine) f.typeLine = f.typeLine.replace(/\bLegendary\s+/g, '');
		}
	}

	const noManaCost = Boolean(mod?.noManaCost || priorCopy?.except?.noManaCost);
	if (noManaCost) {
		baseCardToCopy.manaCost = '';
		baseCardToCopy.cmc = 0;
		for (const f of baseCardToCopy.faces ?? []) {
			f.manaCost = '';
			f.cmc = 0;
		}
	}

	const faceIdx =
		priorCopy?.faceIndex !== undefined ? priorCopy.faceIndex : activeFaceIndexForObject(target);

	// CR 707.8a: A token created as a copy of a transforming permanent is a transforming token with
	// both faces (unless the copied permanent was itself a single-face copy).
	const isTransformingTokenCopy =
		isTokenCopy &&
		baseCardToCopy.layout === 'transform' &&
		!priorCopy?.isSingleFaceCopy &&
		(baseCardToCopy.faces?.length ?? 0) > 1;
	const isSingleFaceCopy = isTransformingTokenCopy
		? false
		: faceIdx > 0 ||
			Boolean(!priorCopy && target.transformed) ||
			Boolean(priorCopy?.isSingleFaceCopy) ||
			((baseCardToCopy.layout === 'transform' || baseCardToCopy.layout === 'modal_dfc') &&
				(baseCardToCopy.faces?.length ?? 0) > 1);
	const isPrototyped = Boolean((!priorCopy && target.prototyped) || priorCopy?.prototyped);

	const priorView = resolveObjectFaces(baseCardToCopy, {
		zone: 'battlefield',
		faceIndex: faceIdx,
		isSingleFaceCopy,
		prototyped: isPrototyped,
		copiableState: priorCopy
	});

	const except: NonNullable<CopiableState['except']> = {};
	const explicitName = mod?.overrideName ?? mod?.name;
	if (explicitName !== undefined) {
		except.names = [explicitName];
		if (isTokenCopy) baseCardToCopy.name = explicitName;
	} else if (priorCopy?.except?.names) {
		except.names = [...priorCopy.except.names];
	}

	if (removeSupertypes.length > 0) {
		except.removeSupertypes = removeSupertypes;
	}
	if (priorCopy?.except?.supertypes) {
		except.supertypes = [...priorCopy.except.supertypes];
	}

	if (mod?.setTypes?.length) {
		except.types = [...mod.setTypes];
		const retainedSubs = filterSubtypesForRetainedTypes(priorView.subtypes, mod.setTypes);
		except.subtypes =
			mod.setSubtypes !== undefined
				? [...mod.setSubtypes]
				: mod.addSubtypes?.length
					? dedupeStrings([...retainedSubs, ...mod.addSubtypes])
					: retainedSubs;
	} else {
		if (mod?.addTypes?.length) {
			except.types = dedupeStrings([...priorView.types, ...mod.addTypes]);
		} else if (priorCopy?.except?.types) {
			except.types = [...priorCopy.except.types];
		}

		if (mod?.setSubtypes !== undefined) {
			const nonCreatureSubs = filterSubtypesForRetainedTypes(
				priorView.subtypes,
				priorView.types.filter((t) => t !== 'Creature' && t !== 'Kindred')
			);
			except.subtypes = dedupeStrings([...nonCreatureSubs, ...mod.setSubtypes]);
		} else if (mod?.addSubtypes?.length) {
			except.subtypes = dedupeStrings([...priorView.subtypes, ...mod.addSubtypes]);
		} else if (priorCopy?.except?.subtypes) {
			except.subtypes = [...priorCopy.except.subtypes];
		}
	}

	if (mod?.setColors !== undefined) {
		except.colors = [...mod.setColors];
	} else if (mod?.addColors?.length) {
		except.colors = dedupeStrings<ManaColor>([...priorView.colors, ...mod.addColors]);
	} else if (priorCopy?.except?.colors !== undefined) {
		except.colors = [...priorCopy.except.colors];
	}

	let power = mod?.power !== undefined ? mod.power : priorCopy?.except?.power;
	let toughness = mod?.toughness !== undefined ? mod.toughness : priorCopy?.except?.toughness;
	if (mod?.halvePT && (power === undefined || toughness === undefined)) {
		const ev = target.zone === 'battlefield' && state ? evaluatePermanent(state, target) : null;
		const baseP = ev ? ev.power : (parseInt(String(priorView.power ?? '0'), 10) || 0);
		const baseT = ev ? ev.toughness : (parseInt(String(priorView.toughness ?? '0'), 10) || 0);
		if (power === undefined) power = Math.ceil(baseP / 2);
		if (toughness === undefined) toughness = Math.ceil(baseT / 2);
	}
	if (power !== undefined) except.power = power;
	if (toughness !== undefined) except.toughness = toughness;

	const addKeywords = dedupeStrings([
		...(priorCopy?.except?.addKeywords ?? []),
		...(mod?.addKeywords ?? [])
	]);
	if (addKeywords.length > 0) except.addKeywords = addKeywords;
	if (noManaCost) except.noManaCost = true;

	// --- Track P18a (CR 707.2 / CR 731.2a): Copy effects on a merged permanent copy its merged abilities ---
	const rawMergedToCopy =
		priorCopy?.mergedComponents ?? (!priorCopy ? target.mergedComponents : undefined);
	const copiedMerged =
		rawMergedToCopy && rawMergedToCopy.length > 1
			? rawMergedToCopy.map((mc) => JSON.parse(JSON.stringify(mc)) as ScryfallCard)
			: undefined;
	// --- End Track P18a ---

	const hasExcept = Object.keys(except).length > 0;
	const copiableState: CopiableState = {
		card: baseCardToCopy,
		...(!isTransformingTokenCopy && (faceIdx > 0 || isSingleFaceCopy)
			? { faceIndex: faceIdx, isSingleFaceCopy: true }
			: {}),
		...(isPrototyped ? { prototyped: true } : {}),
		// --- Track P18a ---
		...(copiedMerged ? { mergedComponents: copiedMerged } : {}),
		// --- End Track P18a ---
		...(hasExcept ? { except } : {})
	};

	const finalView = resolveObjectFaces(baseCardToCopy, {
		zone: 'battlefield',
		faceIndex: faceIdx,
		isSingleFaceCopy,
		prototyped: isPrototyped,
		copiableState
	});

	return {
		baseCardToCopy,
		copiableState,
		displayName: finalView.name || baseCardToCopy.name
	};
}

/**
 * CR 707.2 / 613.1a: Applies a `"becomes a copy of ... [until end of turn]"` continuous effect via
 * `TimedContinuousEffect.layer1a`, never mutating `perm.card`.
 */
export function applyBecomeCopyEffect(
	state: GameState,
	affected: readonly CardInstance[],
	copySource: CardInstance,
	mod: CopyModificationSpec | undefined,
	duration: Duration | undefined,
	controllerId: string,
	sourceName: string,
	allocateTimestampFn: (s: GameState) => number
): CardInstance[] {
	const liveAffected = affected.filter((p) => p.zone === 'battlefield' && !p.phasedOut);
	if (liveAffected.length === 0) return [];
	const { copiableState } = buildModifiedCopiableState(state, copySource, mod, false);
	if (mod?.keepSelfName || mod?.keepThisAbility) {
		for (const p of liveAffected) {
			const customState: CopiableState = {
				...copiableState,
				except: {
					...(copiableState.except ?? {}),
					...(mod.keepSelfName ? { names: [p.card.name] } : {})
				},
				...(mod.keepThisAbility
					? {
							mergedComponents: [
								...(copiableState.mergedComponents ?? [copiableState.card]),
								p.card
							]
						}
					: {})
			};
			(state.timedContinuousEffects ??= []).push({
				timestamp: allocateTimestampFn(state),
				sourceName,
				controllerId,
				expires: duration === 'permanent' ? 'never' : 'endOfTurn',
				affected: [{ instanceId: p.instanceId, objectVersion: p.objectVersion ?? 1 }],
				layer1a: customState
			});
		}
		noteLayerInputsChanged(state);
		return [...liveAffected];
	}
	(state.timedContinuousEffects ??= []).push({
		timestamp: allocateTimestampFn(state),
		sourceName,
		controllerId,
		expires: duration === 'permanent' ? 'never' : 'endOfTurn',
		affected: liveAffected.map((p) => ({
			instanceId: p.instanceId,
			objectVersion: p.objectVersion ?? 1
		})),
		layer1a: copiableState
	});
	noteLayerInputsChanged(state);
	return [...liveAffected];
}

/**
 * CR 508.4: Enters a newly created token as attacking during an active combat phase WITHOUT
 * triggering `"Whenever ~ attacks"` or setting `player.attackedThisTurn` (CR 508.1k).
 */
export function registerEnteredAttackingCombatant(
	state: GameState,
	controller: PlayerGameState,
	tokenInst: CardInstance
): void {
	if (!state.combat.active) return;
	if (
		state.combat.attackers.some((a) => a.attackerInstanceId === tokenInst.instanceId)
	) {
		return;
	}
	const existingDefender = state.combat.attackers.find(
		(a) => a.controllerId === controller.playerId
	)?.defenderPlayerId;
	const fallbackOpponent = state.players.find(
		(p) => !p.lost && p.playerId !== controller.playerId
	)?.playerId;
	const defenderPlayerId = existingDefender ?? fallbackOpponent;
	if (!defenderPlayerId) return;
	state.combat.attackers.push({
		attackerInstanceId: tokenInst.instanceId,
		controllerId: controller.playerId,
		defenderPlayerId,
		defenderPlaneswalkerId: null,
		blockerInstanceIds: []
	});
}

// ---- Slice P7.3: Divided Targets (CR 601.2d, CR 608.2b) -------------------------------------

/**
 * CR 601.2d: Validates (or deterministically defaults when omitted) `targetDivisions` for a single
 * divided-damage / distribute-counters `TargetSpec`.
 * - Every chosen target must receive an integer amount `>= 1`.
 * - Effective `maxTargets = Math.min(specMax, totalAmount)`.
 * - If `totalAmount <= 0`: illegal when `specMin > 0`, otherwise requires `0` targets.
 */
export function validateAndNormalizeTargetDivisions(
	targets: readonly TargetRef[],
	totalAmount: number,
	providedDivisions: Record<string, number> | undefined,
	specMin: number,
	specMax: number,
	sourceName: string
): { ok: true; divisions: Record<string, number> } | { ok: false; error: string } {
	const total = Math.max(0, Math.floor(totalAmount));
	if (total <= 0) {
		if (specMin > 0) {
			return {
				ok: false,
				error: `${sourceName} has 0 to divide, which cannot satisfy ${specMin} required target(s) receiving at least 1 each (CR 601.2d).`
			};
		}
		if (targets.length > 0) {
			return {
				ok: false,
				error: `${sourceName} has 0 to divide, so 0 targets must be chosen (CR 601.2d).`
			};
		}
		return { ok: true, divisions: {} };
	}

	const effectiveMax = Math.min(specMax, total);
	if (targets.length < specMin || targets.length > effectiveMax) {
		return {
			ok: false,
			error: `${sourceName} can target ${specMin === effectiveMax ? `${effectiveMax}` : `${specMin}–${effectiveMax}`} target(s) when dividing ${total} (each target must receive at least 1, CR 601.2d).`
		};
	}

	if (targets.length === 0) {
		return { ok: true, divisions: {} };
	}

	const uniqueIds = new Set(targets.map((t) => t.id));
	if (uniqueIds.size !== targets.length) {
		return {
			ok: false,
			error: `Strict Rules Violation: The same target cannot be chosen more than once (CR 115.3).`
		};
	}

	if (providedDivisions !== undefined) {
		const providedKeys = Object.keys(providedDivisions);
		if (providedKeys.some((k) => !uniqueIds.has(k))) {
			return {
				ok: false,
				error: `Invalid targetDivisions for ${sourceName}: division includes a non-targeted ID (CR 601.2d).`
			};
		}
		const divisions: Record<string, number> = {};
		let sum = 0;
		for (const t of targets) {
			const val = providedDivisions[t.id];
			if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
				return {
					ok: false,
					error: `Invalid targetDivisions for ${sourceName}: each target must be assigned an integer amount >= 1 (CR 601.2d).`
				};
			}
			divisions[t.id] = val;
			sum += val;
		}
		if (sum !== total) {
			return {
				ok: false,
				error: `Invalid targetDivisions for ${sourceName}: assigned amounts sum to ${sum}, expected ${total} (CR 601.2d).`
			};
		}
		return { ok: true, divisions };
	}

	// Deterministic default division when caller (e.g. bot or 1-target shorthand) omits `targetDivisions`:
	const divisions: Record<string, number> = {};
	const k = targets.length;
	const base = Math.floor(total / k);
	const rem = total % k;
	for (let i = 0; i < k; i++) {
		divisions[targets[i].id] = base + (i < rem ? 1 : 0);
	}
	return { ok: true, divisions };
}

/**
 * CR 608.2b: Returns the locked-in divided amount for `targetId` on resolution. Never redistributes
 * amounts from targets that became illegal!
 */
export function getLockedTargetDivisionAmount(
	item: StackItem | undefined,
	targetId: string,
	fallbackTotal: number,
	targetIndex = 0,
	targetCount = 1
): number {
	const locked = item?.targetDivisions?.[targetId];
	if (typeof locked === 'number' && locked >= 0) {
		return locked;
	}
	if (targetCount <= 0 || fallbackTotal <= 0) return 0;
	const base = Math.floor(fallbackTotal / targetCount);
	const rem = fallbackTotal % targetCount;
	return base + (targetIndex < rem ? 1 : 0);
}

// ---- Slice P7.4: Turn-History State & Conditions (CR 603.4, CR 508.1k, CR 400.7) ------------

export function resetTurnHistoryAtTurnStart(state: GameState): void {
	delete state.creatureDiedThisTurn;
	for (const p of state.players) {
		delete p.attackedThisTurn;
		delete p.permanentLeftBattlefieldThisTurn;
		delete p.lifeGainedThisTurn;
		// --- Track P10 ---
		delete p.descendedThisTurn;
		delete p.lostLifeThisTurn;
		delete p.manaSpentOnSpellsThisTurn;
		delete p.unemptiedManaColorsThisTurn;
		// --- End Track P10 ---
	}
	noteLayerInputsChanged(state);
}

export function clearP7EndOfTurnEffects(state: GameState): void {
	delete state.damagePreventionShields;
	delete state.damageCantBePreventedThisTurn;
	delete state.combatDamageCantBePreventedThisTurn;
	delete state.exileInsteadOfDyingThisTurn;
	delete state.timedCombatRestrictions;
	// --- Track P10 ---
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			delete perm.damagedByThisTurn;
		}
	}
	// --- End Track P10 ---
}

export function recordZoneChangeTurnHistory(
	state: GameState,
	fromZone: ZoneType | 'none',
	toZone: ZoneType,
	lkiControllerId: string | undefined,
	wasCreatureOnBattlefield: boolean,
	movedObject: CardInstance
): void {
	// --- Track P10: CR 700.11 Descended ---
	recordDescendedOnZoneChange(state, movedObject, toZone);
	// --- End Track P10 ---
	if (fromZone === 'battlefield' && toZone !== 'battlefield') {
		pruneExileInsteadOfDyingOnLtb(state, movedObject.instanceId);
		delete movedObject.wasCast;
		delete movedObject.castFromZone;
		if (lkiControllerId) {
			const ctrl = state.players.find((p) => p.playerId === lkiControllerId);
			if (ctrl && !ctrl.permanentLeftBattlefieldThisTurn) {
				ctrl.permanentLeftBattlefieldThisTurn = true;
				noteLayerInputsChanged(state);
			}
		}
		if (toZone === 'graveyard' && wasCreatureOnBattlefield && !state.creatureDiedThisTurn) {
			state.creatureDiedThisTurn = true;
			noteLayerInputsChanged(state);
		}
	} else if (toZone === 'battlefield' && fromZone !== 'stack') {
		// Entering the battlefield without resolving from a spell on the stack was not cast (CR 603.4).
		delete movedObject.wasCast;
		delete movedObject.castFromZone;
	}
}

export function recordAttackersDeclaredThisTurn(state: GameState, player: PlayerGameState): void {
	if (!player.attackedThisTurn) {
		player.attackedThisTurn = true;
		noteLayerInputsChanged(state);
	}
}

export function recordLifeGainedThisTurn(
	state: GameState,
	player: PlayerGameState,
	gained: number
): void {
	if (gained <= 0) return;
	player.lifeGainedThisTurn = (player.lifeGainedThisTurn ?? 0) + gained;
	noteLayerInputsChanged(state);
}

export function evaluateP7Condition(
	state: GameState,
	cond: Extract<
		Condition,
		{
			k:
				| 'creatureDiedThisTurn'
				| 'attackedThisTurn'
				| 'permanentLeftBattlefieldThisTurn'
				| 'gainedLifeThisTurn'
				| 'wasCast';
		}
	>,
	controllerId: string,
	opts?: {
		minLife?: number;
		sourceObj?: CardInstance;
		stackItem?: StackItem;
		sourceWasCast?: boolean;
		sourceCastFromZone?: ZoneType;
	}
): boolean {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return false;
	switch (cond.k) {
		case 'creatureDiedThisTurn':
			return Boolean(state.creatureDiedThisTurn);
		case 'attackedThisTurn':
			return Boolean(controller.attackedThisTurn);
		case 'permanentLeftBattlefieldThisTurn':
			return Boolean(controller.permanentLeftBattlefieldThisTurn);
		case 'gainedLifeThisTurn': {
			const threshold = opts?.minLife ?? (cond.min?.k === 'const' ? cond.min.n : 1);
			return (controller.lifeGainedThisTurn ?? 0) >= threshold;
		}
		case 'wasCast': {
			const wasCast =
				opts?.sourceWasCast ??
				opts?.stackItem?.sourceWasCast ??
				opts?.sourceObj?.wasCast ??
				false;
			if (!wasCast) return false;
			if (cond.fromHand) {
				const fromZone =
					opts?.sourceCastFromZone ??
					opts?.stackItem?.sourceCastFromZone ??
					opts?.sourceObj?.castFromZone;
				return fromZone === 'hand';
			}
			return true;
		}
	}
}
