/**
 * Runtime helpers, combat hooks, state-based / immediate designations, and resolution handlers
 * for Wave 6 — Track P18a (13 Remaining Paper CR 702 Registry Keywords):
 *
 * 1. Mutate [cost] (CR 702.140a–f + Merged Permanents CR 731.1–3)
 * 2. Fortify [cost] (CR 702.67a–c, CR 301.6)
 * 3. Soulbond (CR 702.95a–e)
 * 4. Banding (CR 702.22a–m)
 * 5. Teamwork [N] (CR 702.194a–c)
 * 6. Storied (CR 702.195a–c)
 * 7. Hideaway [N] (CR 702.75a–b)
 * 8. Tribute N (CR 702.104a–b)
 * 9. Haunt (CR 702.55a–c)
 * 10. Epic (CR 702.50a–b)
 * 11. Poisonous N (CR 702.70a–b)
 * 12. Absorb N (CR 702.64a–c)
 * 13. Frenzy N (CR 702.68a–b)
 *
 * Pure IR and GameState metadata only — zero card-name literal comparisons, zero runtime
 * rules-text reads, zero direct zone array mutations, and strictly bounded loops.
 */
import { compileCard } from '../compiler/index.ts';
import { staticallyInterpretable } from '../compiler/interpretable.ts';
import type { RuntimeTrigger } from '../compiler/triggers.ts';
import type {
	AbilityDef,
	Condition,
	EffectStep,
	EventKind,
	ModalDef,
	Span,
	TargetSpec
} from '../ir.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import { withStackItemText } from '../oracle.ts';
import type {
	CardInstance,
	CombatAttacker,
	CombatState,
	GameState,
	PlayerGameState,
	ScryfallCard,
	StackItem
} from '../types.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import type { emitEvent, LeftBattlefieldInfo } from './events.ts';
import {
	activeAbilityDefs,
	effectiveManaValue,
	instanceFaceOptions,
	resolveObjectFaces,
	stackItemFaceOptions
} from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	evaluatePermanent,
	inspectCardContinuousBreakdown,
	type EvaluatedPermanent
} from './layers.ts';
import { nextRandom, uid } from './random.ts';
import { enqueuePendingTrigger } from './triggers.ts';
import { moveObject } from './zones.ts';

const ZERO_SPAN: Span = { start: 0, end: 0 };

export interface Wave6RuntimeTrigger extends RuntimeTrigger {
	wave6Tag?: string;
	wave6N?: number;
	wave6Card?: ScryfallCard;
	wave6FaceIndex?: number;
}

export interface Wave6Host {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
	emitEvent: typeof emitEvent;
	flushTriggers: (state: GameState) => void;
	allocateTimestamp: (state: GameState) => number;
	resumeStackItem: (state: GameState, stackItemId: string) => void;
	hasKeyword: (perm: CardInstance, keyword: string, state?: GameState) => boolean;
	executeSpellCardEffectOnStack?: (
		state: GameState,
		item: StackItem,
		controller: PlayerGameState,
		spellCard: ScryfallCard
	) => 'done' | 'paused';
}

let host: Wave6Host | null = null;

export function registerWave6Host(h: Wave6Host): void {
	host = h;
}

function findPermOnBattlefield(
	state: GameState,
	instanceId: string
): { inst: CardInstance; controller: PlayerGameState } | null {
	for (let pIdx = 0; pIdx < state.players.length; pIdx++) {
		const p = state.players[pIdx]!;
		if (p.lost) continue;
		for (let bIdx = 0; bIdx < p.battlefield.length; bIdx++) {
			const perm = p.battlefield[bIdx]!;
			if (perm.instanceId === instanceId) {
				return { inst: perm, controller: p };
			}
		}
	}
	return null;
}

// ============================================================================
// Prompt Continuation Handlers (Mutate Order & Wave 6 Trigger Resumption)
// ============================================================================

registerPromptHandler('p18a_mutate_order', (state, prompt, answer) => {
	const rawData = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const data = (rawData ?? {}) as { stackItemId?: string };
	if (!data.stackItemId) return;
	const item = state.stack.find((s) => s.id === data.stackItemId);
	if (!item) return;
	const chosenIdx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	item.spellMods = {
		...(item.spellMods ?? {}),
		mutating: true,
		mutateUnder: chosenIdx === 1
	};
	host?.resumeStackItem(state, item.id);
});

registerPromptHandler('p18a_wave6_resume', (state, prompt, answer) => {
	const rawData = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const data = (rawData ?? {}) as { stackItemId?: string; step?: string };
	if (!data.stackItemId) return;
	const item = state.stack.find((s) => s.id === data.stackItemId);
	if (!item) return;
	const step = data.step ?? 'done';
	if (answer.kind === 'chooseObjects') {
		item.wave6Resume = {
			step,
			chosenObjectIds: [...answer.objectIds]
		};
	} else if (answer.kind === 'yesNo') {
		item.wave6Resume = {
			step,
			yes: answer.yes
		};
	}
	host?.resumeStackItem(state, item.id);
});

// ============================================================================
// 1. Mutate (CR 702.140a–f) & Merged Permanents (CR 731.1–3)
// ============================================================================

/**
 * CR 702.140a: A mutating creature spell targets a non-Human creature with the same owner as this spell.
 */
export function mutateTargetSpec(): TargetSpec {
	return {
		kind: 'object',
		filter: {
			zone: 'battlefield',
			types: ['Creature'],
			notSubtypes: ['Human'],
			sameOwnerAsSource: true
		},
		min: 1,
		max: 1
	};
}

/**
 * CR 702.140a–b: Checks whether `targetPerm` is still a legal non-Human creature on the battlefield
 * with the same owner as `item`.
 */
export function isMutateTargetStillLegal(
	state: GameState,
	item: StackItem,
	targetPerm: CardInstance | undefined
): boolean {
	if (!targetPerm || targetPerm.zone !== 'battlefield' || targetPerm.phasedOut) return false;
	const spellOwnerId = item.ownerId || item.controllerId;
	if (targetPerm.ownerId !== spellOwnerId) return false;
	const ev = evaluatePermanent(state, targetPerm);
	if (!ev.isCreature) return false;
	if (ev.hasSubType('Human')) return false;
	return true;
}

/**
 * CR 702.140b–d, CR 731.2a–e: Resolves a mutating creature spell on the stack.
 * - If the target became illegal, returns `'resolve_as_creature'` (CR 702.140b).
 * - If `mutateUnder` has not been chosen yet, prompts a human controller (`chooseMode`) or chooses
 *   heuristically for a bot.
 * - Merges the spell card onto `targetPerm` on top (`!mutateUnder`) or underneath (`mutateUnder`)
 *   without causing `targetPerm` to enter the battlefield (no ETB triggers! CR 731.2c), assigns a
 *   new timestamp (`CR 731.2e`), increments `mutateCount`, and emits `Mutated` (`CR 702.140d`).
 */
export function resolveMutatingSpellOnStack(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): 'not_mutating' | 'paused' | 'merged' | 'resolve_as_creature' {
	if (item.kind !== 'spell' || !item.spellMods?.mutating) {
		return 'not_mutating';
	}
	const targetId = item.targets[0]?.id ?? item.spellMods.mutateTargetId;
	const foundTarget = targetId ? findPermOnBattlefield(state, targetId) : null;
	const targetPerm = foundTarget?.inst;
	if (!targetPerm || !isMutateTargetStillLegal(state, item, targetPerm)) {
		item.spellMods = {
			...item.spellMods,
			mutating: false,
			mutateTargetId: undefined,
			mutateUnder: undefined
		};
		item.targets = [];
		item.targetsBySpec = undefined;
		host?.addLog(
			state,
			'rule',
			`${item.title}'s mutate target is illegal; it ceases to be a mutating creature spell and resolves as a creature spell (CR 702.140b).`,
			controller.playerId
		);
		return 'resolve_as_creature';
	}

	let mutateUnder = item.spellMods.mutateUnder;
	if (mutateUnder === undefined) {
		const targetEval = evaluatePermanent(state, targetPerm);
		const spellView = resolveObjectFaces(item.card, stackItemFaceOptions(item));
		if (controller.isBot) {
			const spellStats = (Number(spellView.power) || 0) + (Number(spellView.toughness) || 0);
			const targetBaseStats =
				(Number(targetPerm.card.power) || 0) + (Number(targetPerm.card.toughness) || 0);
			mutateUnder = targetBaseStats > spellStats;
			item.spellMods = { ...item.spellMods, mutateUnder };
		} else {
			const description = `Place ${spellView.name} on top of or underneath ${targetEval.effectiveName} (Mutate, CR 702.140c)?`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseMode',
				purpose: 'generic',
				title: `Mutate — ${spellView.name}`,
				description,
				continuation: {
					kind: 'handler',
					name: 'p18a_mutate_order',
					data: { stackItemId: item.id }
				},
				choice: {
					kind: 'chooseMode',
					modes: [
						`Put ${spellView.name} on top (use ${spellView.name}'s characteristics)`,
						`Put ${spellView.name} underneath (keep ${targetEval.effectiveName}'s characteristics)`
					],
					min: 1,
					max: 1,
					defaultIndices: [0]
				}
			});
			return 'paused';
		}
	}

	// CR 702.140c & CR 731.2a–e: Merge the resolving mutating spell with `targetPerm` in place.
	const existingCards: ScryfallCard[] =
		targetPerm.mergedComponents && targetPerm.mergedComponents.length > 0
			? [...targetPerm.mergedComponents]
			: [targetPerm.printedCard ?? targetPerm.card];
	const existingTokens: boolean[] =
		targetPerm.mergedComponentIsToken &&
		targetPerm.mergedComponentIsToken.length === existingCards.length
			? [...targetPerm.mergedComponentIsToken]
			: existingCards.map((_, idx) => (idx === 0 ? Boolean(targetPerm.isToken) : false));

	const incomingCard = item.card;
	const incomingIsToken = Boolean(item.isCopy);

	const nextCards = mutateUnder
		? [...existingCards, incomingCard]
		: [incomingCard, ...existingCards];
	const nextTokens = mutateUnder
		? [...existingTokens, incomingIsToken]
		: [incomingIsToken, ...existingTokens];

	targetPerm.mergedComponents = nextCards;
	targetPerm.mergedComponentIsToken = nextTokens;
	targetPerm.card = nextCards[0]!;
	targetPerm.printedCard = nextCards[0]!;
	targetPerm.isToken = Boolean(nextTokens[0]);
	if (!mutateUnder) {
		targetPerm.activeFaceIndex = item.faceIndex ?? 0;
		targetPerm.transformed = false;
	}
	// CR 731.2e: When a permanent mutates, it gets a new timestamp.
	if (host) {
		targetPerm.enteredTimestamp = host.allocateTimestamp(state);
	}
	targetPerm.mutateCount = (targetPerm.mutateCount ?? 0) + 1;
	noteLayerInputsChanged(state);

	const mergedEval = evaluatePermanent(state, targetPerm);
	host?.addLog(
		state,
		'cast',
		`${incomingCard.name} mutated ${mutateUnder ? 'underneath' : 'on top of'} ${mergedEval.effectiveName} (mutate #${targetPerm.mutateCount}, CR 702.140c).`,
		controller.playerId
	);
	host?.emitEvent(state, {
		kind: 'Mutated',
		playerId: foundTarget!.controller.playerId,
		objectId: targetPerm.instanceId,
		object: targetPerm,
		mutateCount: targetPerm.mutateCount
	});
	return 'merged';
}

// ============================================================================
// 2. Fortify (CR 702.67a–c, CR 301.6, CR 704.5n)
// ============================================================================

/**
 * CR 301.6 / CR 704.5n: A Fortification attached to an illegal permanent (anything other than a
 * Land, or a permanent with protection from it, or when the Fortification itself is a creature)
 * becomes unattached as a state-based action.
 */
export function isFortificationIllegalAttachment(
	evalPerm: EvaluatedPermanent,
	permInstanceId: string,
	attachedToId: string,
	targetFound: { inst: CardInstance; controller: PlayerGameState } | null,
	targetEval: EvaluatedPermanent | null,
	hasProtFromFortification: boolean
): boolean {
	if (evalPerm.isCreature) return true;
	if (permInstanceId === attachedToId) return true;
	if (!targetFound || !targetEval) return true;
	if (!targetEval.typeLine.includes('Land')) return true;
	if (hasProtFromFortification) return true;
	return false;
}

// ============================================================================
// 3. Soulbond (CR 702.95a–e)
// ============================================================================

/**
 * CR 702.95e: A paired creature becomes unpaired if any of the following occur:
 * - another player gains control of it or the creature it's paired with;
 * - it or the creature it's paired with stops being a creature; or
 * - it or the creature it's paired with leaves the battlefield (or phases out).
 */
export function enforceSoulbondPairs(state: GameState): boolean {
	let changed = false;
	for (let pIdx = 0; pIdx < state.players.length; pIdx++) {
		const p = state.players[pIdx]!;
		for (let bIdx = 0; bIdx < p.battlefield.length; bIdx++) {
			const perm = p.battlefield[bIdx]!;
			const partnerId = perm.pairedWithId;
			if (!partnerId) continue;
			if (p.lost || perm.phasedOut || partnerId === perm.instanceId) {
				delete perm.pairedWithId;
				changed = true;
				continue;
			}
			const partner = p.battlefield.find(
				(other) => !other.phasedOut && other.instanceId === partnerId
			);
			if (!partner || partner.pairedWithId !== perm.instanceId) {
				delete perm.pairedWithId;
				changed = true;
				continue;
			}
			const permEval = evaluatePermanent(state, perm);
			const partnerEval = evaluatePermanent(state, partner);
			if (!permEval.isCreature || !partnerEval.isCreature) {
				delete perm.pairedWithId;
				delete partner.pairedWithId;
				changed = true;
			}
		}
	}
	if (changed) {
		noteLayerInputsChanged(state);
	}
	return changed;
}

// ============================================================================
// 4. Banding (CR 702.22a–m)
// ============================================================================

/**
 * CR 702.22c: As a player declares attackers, they may declare that one or more attacking
 * creatures with banding and up to one attacking creature without banding (even if it has
 * "bands with other") are all in a "band." They may also declare that one or more attacking
 * [quality] creatures with "bands with other [quality]" and any number of other attacking
 * [quality] creatures are all in a band. A player may declare as many attacking bands as they
 * want, so long as each creature is a member of no more than one band. Bands must attack the
 * same player, planeswalker, or battle.
 */
export function validateAndBuildAttackingBands(
	state: GameState,
	actor: PlayerGameState,
	validAttackers: CombatAttacker[],
	rawBands?: string[][]
): { ok: boolean; error?: string; bands?: NonNullable<CombatState['bands']> } {
	if (!rawBands || rawBands.length === 0) {
		return { ok: true, bands: undefined };
	}
	const attackerById = new Map<string, CombatAttacker>();
	for (let i = 0; i < validAttackers.length; i++) {
		const a = validAttackers[i]!;
		attackerById.set(a.attackerInstanceId, a);
	}
	const seenMemberIds = new Set<string>();
	const builtBands: NonNullable<CombatState['bands']> = [];

	for (let bIdx = 0; bIdx < rawBands.length; bIdx++) {
		const group = rawBands[bIdx]!;
		if (!group || group.length === 0) continue;
		if (group.length < 2) {
			return {
				ok: false,
				error: 'Strict Rules Violation: An attacking band must contain at least two creatures (CR 702.22c).'
			};
		}
		let firstEntry: CombatAttacker | null = null;
		let nonBandingCount = 0;
		const cleanIds: string[] = [];

		for (let mIdx = 0; mIdx < group.length; mIdx++) {
			const memberId = group[mIdx]!;
			if (seenMemberIds.has(memberId)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: A creature cannot be a member of more than one attacking band (CR 702.22c).'
				};
			}
			const atkEntry = attackerById.get(memberId);
			if (!atkEntry) {
				return {
					ok: false,
					error: 'Strict Rules Violation: Every member of an attacking band must be declared as an attacker (CR 702.22c).'
				};
			}
			const perm = actor.battlefield.find((c) => !c.phasedOut && c.instanceId === memberId);
			if (!perm) {
				return {
					ok: false,
					error: 'Strict Rules Violation: Invalid creature in attacking band.'
				};
			}
			if (!firstEntry) {
				firstEntry = atkEntry;
			} else if (
				atkEntry.defenderPlayerId !== firstEntry.defenderPlayerId ||
				(atkEntry.defenderPlaneswalkerId ?? null) !==
					(firstEntry.defenderPlaneswalkerId ?? null) ||
				(atkEntry.defenderBattleId ?? null) !== (firstEntry.defenderBattleId ?? null)
			) {
				return {
					ok: false,
					error: 'Strict Rules Violation: All members of an attacking band must attack the same player, planeswalker, or battle (CR 702.22c).'
				};
			}
			const hasBanding = host
				? host.hasKeyword(perm, 'Banding', state)
				: evaluatePermanent(state, perm).activeKeywords.some(
						(k) => k.toLowerCase() === 'banding'
					);
			if (!hasBanding) {
				nonBandingCount += 1;
			}
			seenMemberIds.add(memberId);
			cleanIds.push(memberId);
		}

		if (nonBandingCount > 1) {
			return {
				ok: false,
				error: 'Strict Rules Violation: An attacking band may contain at most one attacking creature without banding (CR 702.22c).'
			};
		}

		builtBands.push({
			id: uid('band', state),
			defenderPlayerId: firstEntry!.defenderPlayerId,
			defenderPlaneswalkerId: firstEntry!.defenderPlaneswalkerId ?? null,
			...(firstEntry!.defenderBattleId
				? { defenderBattleId: firstEntry!.defenderBattleId }
				: {}),
			memberIds: cleanIds
		});
	}

	return { ok: true, bands: builtBands.length > 0 ? builtBands : undefined };
}

/**
 * CR 702.22h: If an attacking creature becomes blocked by a creature, each other creature in the
 * same band as the attacking creature becomes blocked by that same blocking creature.
 */
export function propagateBandingBlockers(state: GameState): void {
	const bands = state.combat.bands;
	if (!bands || bands.length === 0) return;
	for (let bIdx = 0; bIdx < bands.length; bIdx++) {
		const band = bands[bIdx]!;
		const activeEntries: CombatAttacker[] = [];
		const unionBlockers: string[] = [];
		let anyWasBlocked = false;

		for (let mIdx = 0; mIdx < band.memberIds.length; mIdx++) {
			const mId = band.memberIds[mIdx]!;
			const entry = state.combat.attackers.find((a) => a.attackerInstanceId === mId);
			if (!entry) continue;
			const found = findPermOnBattlefield(state, mId);
			if (!found || found.inst.phasedOut || !evaluatePermanent(state, found.inst).isCreature) {
				continue;
			}
			activeEntries.push(entry);
			if (entry.wasBlocked) anyWasBlocked = true;
			for (let k = 0; k < entry.blockerInstanceIds.length; k++) {
				const blkId = entry.blockerInstanceIds[k]!;
				if (!unionBlockers.includes(blkId)) {
					unionBlockers.push(blkId);
				}
			}
		}

		if (unionBlockers.length > 0 || anyWasBlocked) {
			for (let i = 0; i < activeEntries.length; i++) {
				const entry = activeEntries[i]!;
				entry.blockerInstanceIds = [...unionBlockers];
				entry.wasBlocked = true;
			}
		}
	}
}

/**
 * CR 702.22j: Heuristic for a bot defending player dividing an attacking creature's combat damage
 * among its blockers when at least one blocker controlled by the defender has banding.
 * Picks a single blocker to absorb all of the attacker's combat damage (preventing trample and
 * saving all other blockers).
 */
export function chooseBotBandingAttackerDamageTarget(
	state: GameState,
	blockers: readonly CardInstance[],
	totalDamage: number,
	atkDeathtouch: boolean
): string | null {
	if (blockers.length === 0) return null;
	// 1. Prefer an indestructible blocker (survives any amount of combat damage).
	for (let i = 0; i < blockers.length; i++) {
		const b = blockers[i]!;
		const ev = evaluatePermanent(state, b);
		if (ev.activeKeywords.some((k) => k.toLowerCase() === 'indestructible')) {
			return b.instanceId;
		}
	}
	// 2. Prefer a blocker that survives all `totalDamage` without dying.
	if (!atkDeathtouch) {
		for (let i = 0; i < blockers.length; i++) {
			const b = blockers[i]!;
			const ev = evaluatePermanent(state, b);
			const remTough = ev.toughness - b.damageMarked;
			if (remTough > totalDamage) {
				return b.instanceId;
			}
		}
	}
	// 3. Otherwise sacrifice the lowest-stats chump blocker to absorb 100% of the damage.
	let weakest = blockers[0]!;
	let weakestScore = Infinity;
	for (let i = 0; i < blockers.length; i++) {
		const b = blockers[i]!;
		const ev = evaluatePermanent(state, b);
		const score = ev.power * 2 + ev.toughness + (b.isToken ? -0.5 : 0);
		if (score < weakestScore) {
			weakestScore = score;
			weakest = b;
		}
	}
	return weakest.instanceId;
}

/**
 * CR 702.22k: Heuristic for a bot attacking player dividing a blocker's combat damage among the
 * attacking creatures it blocks when at least one blocked attacker has banding.
 */
export function chooseBotBandingBlockerDamageTarget(
	state: GameState,
	blockedAttackers: readonly CardInstance[],
	blockerDamage: number,
	blkDeathtouch: boolean
): string | null {
	return chooseBotBandingAttackerDamageTarget(
		state,
		blockedAttackers,
		blockerDamage,
		blkDeathtouch
	);
}

// ============================================================================
// 6. Storied (CR 702.195a–c)
// ============================================================================

/**
 * CR 702.195a–c: Storied is a static ability. If a player doesn't have an enduring story, controls
 * a permanent with storied, and controls three or more permanents that are artifacts, legendaries,
 * and/or Sagas, that player gets an enduring story for the rest of the game.
 */
export function checkStoriedDesignations(state: GameState): boolean {
	let grantedAny = false;
	for (let pIdx = 0; pIdx < state.players.length; pIdx++) {
		const p = state.players[pIdx]!;
		if (p.lost) continue;
		if (p.hasEnduringStory) {
			for (let bIdx = 0; bIdx < p.battlefield.length; bIdx++) {
				const perm = p.battlefield[bIdx]!;
				if (!perm.hasEnduringStory) {
					perm.hasEnduringStory = true;
					grantedAny = true;
				}
			}
			continue;
		}
		let hasStoriedPerm = false;
		let qualifyingHistoricCount = 0;

		for (let bIdx = 0; bIdx < p.battlefield.length; bIdx++) {
			const perm = p.battlefield[bIdx]!;
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (
				!hasStoriedPerm &&
				ev.activeKeywords.some((k) => k.toLowerCase() === 'storied')
			) {
				hasStoriedPerm = true;
			}
			if (ev.isArtifact || ev.isLegendary || ev.hasSubType('Saga')) {
				qualifyingHistoricCount += 1;
			}
		}

		if (hasStoriedPerm && qualifyingHistoricCount >= 3) {
			p.hasEnduringStory = true;
			for (let bIdx = 0; bIdx < p.battlefield.length; bIdx++) {
				p.battlefield[bIdx]!.hasEnduringStory = true;
			}
			grantedAny = true;
			host?.addLog(
				state,
				'rule',
				`${p.username} got an enduring story for the rest of the game (Storied, CR 702.195b).`,
				p.playerId
			);
		}
	}
	if (grantedAny) {
		noteLayerInputsChanged(state);
	}
	return grantedAny;
}

// ============================================================================
// 7. Hideaway (CR 702.75a–b) — Linked Face-Down Exile Peek Sync
// ============================================================================

/**
 * CR 702.75a: Any player who has controlled the permanent that exiled a Hideaway card may look at
 * that card in the exile zone.
 */
export function syncHideawayExilePeekPermissions(state: GameState): void {
	for (let pIdx = 0; pIdx < state.players.length; pIdx++) {
		const p = state.players[pIdx]!;
		if (p.lost) continue;
		for (let bIdx = 0; bIdx < p.battlefield.length; bIdx++) {
			const perm = p.battlefield[bIdx]!;
			if (perm.phasedOut) continue;
			const permVer = perm.objectVersion ?? 1;
			for (let oIdx = 0; oIdx < state.players.length; oIdx++) {
				const owner = state.players[oIdx]!;
				for (let eIdx = 0; eIdx < owner.exile.length; eIdx++) {
					const ex = owner.exile[eIdx]!;
					if (
						ex.isFaceDown &&
						ex.exiledBy?.sourceInstanceId === perm.instanceId &&
						ex.exiledBy.sourceObjectVersion === permVer
					) {
						const known = (ex.knownToPlayerIds ??= []);
						if (!known.includes(p.playerId)) {
							known.push(p.playerId);
						}
					}
				}
			}
		}
	}
}

// ============================================================================
// 8. Tribute N (CR 702.104a–b)
// ============================================================================

/**
 * CR 702.104a: Returns the total Tribute `N` on `obj` as it enters the battlefield (`0` if none
 * or face-down).
 */
export function getTributeTotalN(obj: CardInstance): number {
	if (obj.isFaceDown) return 0;
	const abilities = activeAbilityDefs(
		effectiveCardForObject(obj),
		instanceFaceOptions(obj, 'battlefield')
	);
	let total = 0;
	for (let i = 0; i < abilities.length; i++) {
		const ab = abilities[i]!;
		if (ab.kind === 'keyword') {
			const { name: kwName, n } = ab.keyword;
			if (kwName.toLowerCase() === 'tribute' && n !== undefined && n > 0) {
				total += n;
			}
		}
	}
	return total;
}

function conditionChecksTributeNotPaid(cond: Condition | undefined): boolean {
	if (!cond) return false;
	if (cond.k === 'not' && cond.of.k === 'tributePaid') return true;
	if (cond.k === 'and' || cond.k === 'or') {
		return cond.of.some((c) => conditionChecksTributeNotPaid(c));
	}
	return false;
}

/**
 * Heuristic for a bot opponent asked whether to place `tributeN` +1/+1 counters on `enteringObj`.
 * If `enteringObj` has an ability conditioned on `"if tribute wasn't paid"`, evaluate whether
 * denying that ability is worth giving `tributeN` counters; otherwise decline (`false`).
 */
export function chooseBotTributeDecision(
	_state: GameState,
	opp: PlayerGameState,
	enteringObj: CardInstance,
	tributeN: number
): boolean {
	if (tributeN <= 0) return true;
	const abilities = activeAbilityDefs(
		effectiveCardForObject(enteringObj),
		instanceFaceOptions(enteringObj, 'battlefield')
	);
	const hasPunisherIfUnpaid = abilities.some(
		(ab) =>
			(ab.kind === 'triggered' && conditionChecksTributeNotPaid(ab.condition)) ||
			(ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				conditionChecksTributeNotPaid(ab.static.condition))
	);
	if (!hasPunisherIfUnpaid) return false;
	return opp.life <= tributeN * 2;
}

// ============================================================================
// 9. Haunt (CR 702.55a–c)
// ============================================================================

export function cardHasHaunt(card: ScryfallCard, faceIndex = 0): boolean {
	const abilities = activeAbilityDefs(card, { zone: 'stack', faceIndex });
	for (let i = 0; i < abilities.length; i++) {
		const ab = abilities[i]!;
		if (ab.kind === 'keyword') {
			const { name: kwName } = ab.keyword;
			if (kwName.toLowerCase() === 'haunt') return true;
		}
	}
	return false;
}

/**
 * CR 702.55a: "Haunt" on an instant or sorcery spell means "When this spell is put into a
 * graveyard during its resolution, exile it haunting target creature."
 */
export function maybeEnqueueSpellHauntTrigger(
	state: GameState,
	item: StackItem,
	cardOwner: PlayerGameState,
	controller: PlayerGameState
): void {
	if (item.isCopy) return;
	const faceIdx = item.faceIndex ?? 0;
	if (!cardHasHaunt(item.card, faceIdx)) return;
	const gyCard = cardOwner.graveyard.find((c) => c.instanceId === item.sourceInstanceId);
	if (!gyCard) return;

	const syntheticRt: Wave6RuntimeTrigger = {
		abilityIndex: -1801,
		trigger: {
			event: 'zoneChange',
			filter: { to: 'graveyard', object: 'self' }
		},
		effectSupported: true,
		text: 'Haunt',
		wave6Tag: 'haunt_exile'
	};
	enqueuePendingTrigger(state, {
		ability: syntheticRt,
		source: gyCard,
		sourceCard: item.card,
		faceIndex: faceIdx,
		controllerId: controller.playerId,
		mode: 'stack',
		label: 'Haunt',
		wave6Tag: 'haunt_exile'
	});
}

/**
 * CR 702.55b–c: When a creature on the battlefield dies, any cards in exile haunting that exact
 * permanent (`(instanceId, objectVersion)`) trigger their haunted-creature-dies abilities from the
 * exile zone.
 */
export function handleHauntedCreatureDies(
	state: GameState,
	dyingObj: CardInstance,
	leavingVersion: number,
	lki?: LeftBattlefieldInfo
): void {
	for (let pIdx = 0; pIdx < state.players.length; pIdx++) {
		const p = state.players[pIdx]!;
		for (let eIdx = 0; eIdx < p.exile.length; eIdx++) {
			const ex = p.exile[eIdx]!;
			if (ex.hauntingTargetId !== dyingObj.instanceId) continue;
			if (
				ex.hauntingTargetVersion !== undefined &&
				ex.hauntingTargetVersion !== leavingVersion
			) {
				continue;
			}
			host?.emitEvent(state, {
				kind: 'HauntedCreatureDied',
				haunterId: ex.instanceId,
				haunter: ex,
				hauntedId: dyingObj.instanceId,
				hauntedObject: dyingObj,
				...(lki ? { lki } : {})
			});

			// Fallback for synthetic Haunt instants/sorceries whose Oracle text relies on their spell
			// effect when no separate `hauntedCreatureDies` TriggerDef is present on the card.
			const def = compileCard(ex.card);
			const face = def.faces[0];
			const hasExplicitHauntDiesTrigger = Boolean(
				face?.abilities.some(
					(a) =>
						a.kind === 'triggered' &&
						(a.trigger.event === 'hauntedCreatureDies' ||
							Boolean(a.trigger.or?.some((o) => o.event === 'hauntedCreatureDies')))
				)
			);
			if (
				!hasExplicitHauntDiesTrigger &&
				face &&
				(face.characteristics.types.includes('Instant') ||
					face.characteristics.types.includes('Sorcery'))
			) {
				const spellAb = face.abilities.find((a) => a.kind === 'spell');
				if (spellAb && spellAb.kind === 'spell' && spellAb.effect.length > 0) {
					const syntheticRt: Wave6RuntimeTrigger = {
						abilityIndex: -1802,
						trigger: { event: 'hauntedCreatureDies', filter: {}, fromZone: 'exile' },
						effectSupported: true,
						text: `${ex.card.name} — Haunt`,
						wave6Tag: 'haunt_spell_effect',
						wave6Card: ex.card
					};
					enqueuePendingTrigger(state, {
						ability: syntheticRt,
						source: ex,
						sourceCard: ex.card,
						faceIndex: 0,
						controllerId: ex.ownerId,
						mode: 'stack',
						label: `${ex.card.name} — Haunt`,
						eventObject: dyingObj,
						wave6Tag: 'haunt_spell_effect',
						wave6Card: ex.card
					});
				}
			}
		}
	}
}

// ============================================================================
// 10. Epic (CR 702.50a–b)
// ============================================================================

export function stackSpellHasEpic(item: StackItem): boolean {
	if (item.kind !== 'spell' || item.isFaceDown) return false;
	const abilities = activeAbilityDefs(item.card, stackItemFaceOptions(item));
	for (let i = 0; i < abilities.length; i++) {
		const ab = abilities[i]!;
		if (ab.kind === 'keyword') {
			const { name: kwName } = ab.keyword;
			if (kwName.toLowerCase() === 'epic') return true;
		}
	}
	return false;
}

/**
 * CR 702.50a: When a non-copy spell with Epic resolves, for the rest of the game its controller
 * can't cast spells, and at the beginning of each of that player's upkeeps for the rest of the
 * game, a copy of the spell (except for its epic ability) is created.
 */
export function registerResolvedEpicSpell(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): void {
	if (item.kind !== 'spell' || item.isCopy) return;
	if (!stackSpellHasEpic(item)) return;

	controller.cannotCastSpellsForRestOfGame = true;
	const snapshotItem: StackItem = {
		...(JSON.parse(JSON.stringify(item)) as StackItem),
		isCopy: true,
		resolutionStarted: false,
		effectResume: undefined
	};
	(controller.epicSpells ??= []).push({
		card: item.card,
		...(item.faceIndex !== undefined ? { faceIndex: item.faceIndex } : {}),
		triggerEventStackItem: snapshotItem
	});
	host?.addLog(
		state,
		'rule',
		`${controller.username} resolved ${item.title} (Epic, CR 702.50a): ${controller.username} can't cast spells for the rest of the game and will copy ${item.title} at the beginning of each of their upkeeps.`,
		controller.playerId
	);
}

/**
 * CR 702.50a: At the beginning of each of a player's upkeeps, put an Epic delayed triggered
 * ability onto the stack for each Epic spell that resolved under their control.
 */
export function enqueueEpicUpkeepTriggers(
	state: GameState,
	activePlayer: PlayerGameState
): void {
	const list = activePlayer.epicSpells;
	if (!list || list.length === 0 || activePlayer.lost) return;

	for (let i = 0; i < list.length; i++) {
		const entry = list[i]!;
		const faceIdx = entry.faceIndex ?? 0;
		const syntheticSource: CardInstance = {
			instanceId: uid('epic_src', state),
			objectVersion: 1,
			enteredTimestamp: 0,
			card: entry.card,
			ownerId: activePlayer.playerId,
			controllerId: activePlayer.playerId,
			zone: 'command',
			tapped: false,
			summoningSick: false,
			damageMarked: 0,
			deathtouchDamageMarked: false,
			tempPowerMod: 0,
			tempToughnessMod: 0,
			grantedKeywords: [],
			attachedToId: null,
			isCommander: false,
			isToken: false,
			commanderCastCount: 0,
			usedLoyaltyThisTurn: false,
			transformed: false,
			counters: {} as CardInstance['counters']
		};
		const templateItem: StackItem = entry.triggerEventStackItem
			? {
					...(JSON.parse(JSON.stringify(entry.triggerEventStackItem)) as StackItem),
					id: uid('epic_orig', state),
					controllerId: activePlayer.playerId,
					isCopy: true
				}
			: withStackItemText(
					{
						id: uid('epic_orig', state),
						sourceInstanceId: syntheticSource.instanceId,
						card: entry.card,
						faceIndex: faceIdx,
						ownerId: activePlayer.playerId,
						controllerId: activePlayer.playerId,
						kind: 'spell',
						isCopy: true,
						title: entry.card.name,
						targets: [],
						xValue: 0,
						requiresGuidedResolution: false,
						createdAt: 0
					},
					entry.card
				);
		const syntheticRt: Wave6RuntimeTrigger = {
			abilityIndex: -1803,
			trigger: { event: 'phaseBegin', filter: { phase: 'upkeep' } },
			effectSupported: true,
			text: `Epic — Copy ${entry.card.name}`,
			wave6Tag: 'epic_upkeep',
			wave6Card: entry.card,
			wave6FaceIndex: faceIdx
		};
		enqueuePendingTrigger(state, {
			ability: syntheticRt,
			source: syntheticSource,
			sourceCard: entry.card,
			faceIndex: faceIdx,
			controllerId: activePlayer.playerId,
			mode: 'stack',
			label: `Epic — ${entry.card.name}`,
			triggerEventStackItem: templateItem,
			wave6Tag: 'epic_upkeep',
			wave6Card: entry.card,
			wave6FaceIndex: faceIdx
		});
	}
}

export function epicUpkeepCompiledEffect(): { targets: TargetSpec[]; steps: EffectStep[] } {
	return {
		targets: [],
		steps: [
			{
				verb: 'copySpell',
				subject: { k: 'self' },
				params: { mayChooseNewTargets: true },
				span: ZERO_SPAN
			}
		]
	};
}

// ============================================================================
// 12. Absorb N (CR 702.64a–c)
// ============================================================================

/**
 * CR 702.64a–c: "Absorb N" means "If a source would deal damage to this creature, prevent N of
 * that damage." Each instance of Absorb applies separately (`CR 702.64c`), so multiple instances
 * prevent the sum of their `N` values from any single damage event.
 */
export function getCreatureAbsorbAmount(state: GameState, perm: CardInstance): number {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return 0;
	const ev = evaluatePermanent(state, perm);
	if (!ev.isCreature) return 0;
	const breakdown = inspectCardContinuousBreakdown(perm, state);
	let totalAbsorb = 0;
	for (let i = 0; i < breakdown.items.length; i++) {
		const item = breakdown.items[i]!;
		if (item.removed || item.kind !== 'keyword') continue;
		const keyLow = item.canonicalKey.toLowerCase();
		if (keyLow === 'absorb' || keyLow.startsWith('absorb ')) {
			const m = /^absorb\s+(\d+)$/i.exec(item.name.trim());
			const n = m ? Number.parseInt(m[1]!, 10) : 0;
			if (n > 0) {
				const mult = item.grantCount && item.grantCount > 1 ? item.grantCount : 1;
				totalAbsorb += n * mult;
			}
		}
	}
	return totalAbsorb;
}

export function applyAbsorbDamagePrevention(
	state: GameState,
	targetKind: 'player' | 'permanent',
	targetPerm: CardInstance | undefined,
	remainingDamage: number
): number {
	if (targetKind !== 'permanent' || !targetPerm || remainingDamage <= 0) {
		return remainingDamage;
	}
	const absorbN = getCreatureAbsorbAmount(state, targetPerm);
	if (absorbN <= 0) return remainingDamage;
	const prevented = Math.min(remainingDamage, absorbN);
	if (prevented > 0) {
		const ev = evaluatePermanent(state, targetPerm);
		host?.addLog(
			state,
			'rule',
			`Absorb prevented ${prevented} damage to ${ev.effectiveName} (CR 702.64a).`,
			targetPerm.controllerId
		);
	}
	return Math.max(0, remainingDamage - prevented);
}

// ============================================================================
// Wave 6 Trigger Tagging, Layer-6 Grant Parsing, & Stack Resolution
// ============================================================================

export function attachWave6TagToBaseRuntimeTrigger<T extends RuntimeTrigger>(
	rt: T,
	faceAbs: readonly AbilityDef[]
): T & { wave6Tag?: string; wave6N?: number } {
	if (rt.abilityIndex < 0) return rt;
	const ab = faceAbs[rt.abilityIndex];
	if (!ab || ab.kind !== 'keyword') return rt;
	const { name: kwName, n } = ab.keyword;
	const low = kwName.toLowerCase();
	if (low === 'haunt') {
		return { ...rt, wave6Tag: 'haunt_exile' };
	}
	if (low === 'hideaway') {
		return { ...rt, wave6Tag: 'hideaway', wave6N: n ?? 4 };
	}
	if (low === 'poisonous') {
		return { ...rt, wave6Tag: 'poisonous', wave6N: n ?? 1 };
	}
	if (low === 'soulbond') {
		const tag = rt.trigger.filter.object === 'self' ? 'soulbond_self' : 'soulbond_other';
		return { ...rt, wave6Tag: tag };
	}
	return rt;
}

export function grantedFrenzyCompiledEffect(
	grantedKeyword?: string
): { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef; unparsed: Span[] } | null {
	if (!grantedKeyword) return null;
	const parsed = parseGrantedWave6TriggerKeyword(grantedKeyword);
	if (!parsed || parsed.base !== 'frenzy') return null;
	const n = parsed.n ?? 1;
	return {
		targets: [],
		steps: [
			{
				verb: 'pump',
				subject: { k: 'self' },
				amount: { k: 'const', n },
				params: {
					toughness: { k: 'const', n: 0 },
					duration: 'endOfTurn'
				},
				span: ZERO_SPAN
			}
		],
		unparsed: []
	};
}

export function parseGrantedWave6TriggerKeyword(
	kw: string
): { base: 'poisonous' | 'frenzy' | 'soulbond'; n?: number } | null {
	const trimmed = kw.trim().toLowerCase();
	if (trimmed === 'soulbond') {
		return { base: 'soulbond' };
	}
	const mPoison = /^poisonous\s+(\d+)$/.exec(trimmed);
	if (mPoison) {
		return { base: 'poisonous', n: Number.parseInt(mPoison[1]!, 10) };
	}
	const mFrenzy = /^frenzy\s+(\d+)$/.exec(trimmed);
	if (mFrenzy) {
		return { base: 'frenzy', n: Number.parseInt(mFrenzy[1]!, 10) };
	}
	return null;
}

export function grantedWave6TriggerEvents(kw: string): readonly EventKind[] | null {
	const parsed = parseGrantedWave6TriggerKeyword(kw);
	if (!parsed) return null;
	switch (parsed.base) {
		case 'poisonous':
			return ['dealsDamage'];
		case 'frenzy':
			return ['attackedAndUnblocked'];
		case 'soulbond':
			return ['zoneChange'];
	}
}

export function buildGrantedWave6KeywordTriggers(
	parsed: { base: 'poisonous' | 'frenzy' | 'soulbond'; n?: number },
	grantedKey: string
): Wave6RuntimeTrigger[] {
	if (parsed.base === 'poisonous') {
		const n = parsed.n ?? 1;
		return [
			{
				abilityIndex: -1,
				grantedKeyword: grantedKey,
				trigger: {
					event: 'dealsDamage',
					filter: { object: 'self', combat: true, damageTo: 'player' }
				},
				effectSupported: true,
				text: `Poisonous ${n}`,
				wave6Tag: 'poisonous',
				wave6N: n
			}
		];
	}
	if (parsed.base === 'frenzy') {
		const n = parsed.n ?? 1;
		return [
			{
				abilityIndex: -1,
				grantedKeyword: grantedKey,
				trigger: {
					event: 'attackedAndUnblocked',
					filter: { object: 'self' }
				},
				effect: {
					targets: [],
					steps: [
						{
							verb: 'pump',
							subject: { k: 'self' },
							amount: { k: 'const', n },
							params: {
								toughness: { k: 'const', n: 0 },
								duration: 'endOfTurn'
							},
							span: ZERO_SPAN
						}
					],
					unparsed: []
				},
				effectSupported: true,
				text: `Frenzy ${n}`
			}
		];
	}
	// Soulbond (CR 702.95a): self ETB + other controlled Creature ETB while unpaired
	return [
		{
			abilityIndex: -1,
			grantedKeyword: grantedKey,
			trigger: {
				event: 'zoneChange',
				filter: { to: 'battlefield', object: 'self' }
			},
			effectSupported: true,
			text: 'Soulbond',
			wave6Tag: 'soulbond_self'
		},
		{
			abilityIndex: -1,
			grantedKeyword: grantedKey,
			trigger: {
				event: 'zoneChange',
				filter: {
					to: 'battlefield',
					object: { types: ['Creature'], controller: 'you', other: true }
				}
			},
			condition: { k: 'not', of: { k: 'isPaired' } },
			effectSupported: true,
			text: 'Soulbond',
			wave6Tag: 'soulbond_other'
		}
	];
}

export function wave6TriggerTargetSpecs(item: StackItem): TargetSpec[] {
	if (item.wave6Tag === 'haunt_exile') {
		return [
			{
				kind: 'object',
				filter: { zone: 'battlefield', types: ['Creature'] },
				min: 1,
				max: 1
			}
		];
	}
	if (item.wave6Tag === 'haunt_spell_effect' && item.wave6Card) {
		const def = compileCard(item.wave6Card);
		const spellAb = def.faces[0]?.abilities.find((a) => a.kind === 'spell');
		if (spellAb && spellAb.kind === 'spell') {
			return spellAb.targets;
		}
	}
	return [];
}

export function isWave6StackItem(item: StackItem): boolean {
	const tag = item.wave6Tag;
	return (
		tag === 'soulbond_self' ||
		tag === 'soulbond_other' ||
		tag === 'hideaway' ||
		tag === 'haunt_exile' ||
		tag === 'haunt_spell_effect' ||
		tag === 'poisonous'
	);
}

function pairSoulbondCreatures(
	state: GameState,
	controller: PlayerGameState,
	source: CardInstance,
	partner: CardInstance
): void {
	source.pairedWithId = partner.instanceId;
	partner.pairedWithId = source.instanceId;
	noteLayerInputsChanged(state);
	const srcEval = evaluatePermanent(state, source);
	const partnerEval = evaluatePermanent(state, partner);
	host?.addLog(
		state,
		'trigger',
		`${controller.username} paired ${srcEval.effectiveName} with ${partnerEval.effectiveName} (Soulbond, CR 702.95a).`,
		controller.playerId
	);
	host?.emitEvent(state, {
		kind: 'SoulbondPaired',
		playerId: controller.playerId,
		objectId: source.instanceId,
		object: source,
		partnerId: partner.instanceId,
		partner
	});
}

export function resolveWave6StackItem(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): 'done' | 'paused' {
	const tag = item.wave6Tag;

	// --- 11. Poisonous N (CR 702.70a–b) ---
	if (tag === 'poisonous') {
		const n = item.wave6N ?? 1;
		const targetPid = item.eventPlayerId;
		const damagedPlayer = targetPid
			? state.players.find((p) => p.playerId === targetPid && !p.lost)
			: undefined;
		if (damagedPlayer && n > 0) {
			damagedPlayer.poison = (damagedPlayer.poison || 0) + n;
			host?.addLog(
				state,
				'trigger',
				`${damagedPlayer.username} got ${n} poison counter${n === 1 ? '' : 's'} from ${item.title} (Poisonous ${n}, CR 702.70a).`,
				controller.playerId
			);
		}
		delete item.wave6Resume;
		return 'done';
	}

	// --- 3a. Soulbond self-ETB ("When this creature enters, if you control both this creature and another creature and both are unpaired...") ---
	if (tag === 'soulbond_self') {
		const source = controller.battlefield.find(
			(c) =>
				!c.phasedOut &&
				c.instanceId === item.sourceInstanceId &&
				(item.sourceObjectVersion === undefined ||
					(c.objectVersion ?? 1) === item.sourceObjectVersion)
		);
		if (!source || source.pairedWithId || !evaluatePermanent(state, source).isCreature) {
			delete item.wave6Resume;
			return 'done';
		}
		const unpairedOthers = controller.battlefield.filter(
			(c) =>
				!c.phasedOut &&
				c.instanceId !== source.instanceId &&
				!c.pairedWithId &&
				evaluatePermanent(state, c).isCreature
		);
		if (unpairedOthers.length === 0) {
			delete item.wave6Resume;
			return 'done';
		}

		if (item.wave6Resume?.step === 'soulbond_pick') {
			const chosenId = item.wave6Resume.chosenObjectIds?.[0];
			delete item.wave6Resume;
			if (chosenId) {
				const partner = unpairedOthers.find((c) => c.instanceId === chosenId);
				if (partner) {
					pairSoulbondCreatures(state, controller, source, partner);
				}
			}
			return 'done';
		}

		if (controller.isBot) {
			let best = unpairedOthers[0]!;
			let bestScore = -Infinity;
			for (let i = 0; i < unpairedOthers.length; i++) {
				const cand = unpairedOthers[i]!;
				const ev = evaluatePermanent(state, cand);
				const score = ev.power + ev.toughness;
				if (score > bestScore) {
					bestScore = score;
					best = cand;
				}
			}
			pairSoulbondCreatures(state, controller, source, best);
			return 'done';
		}

		const srcName = evaluatePermanent(state, source).effectiveName;
		const reason = `You may pair ${srcName} with an unpaired creature you control (Soulbond, CR 702.95a).`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: controller.playerId,
			kind: 'chooseObjects',
			purpose: 'generic',
			title: `Soulbond — ${srcName}`,
			description: reason,
			continuation: {
				kind: 'handler',
				name: 'p18a_wave6_resume',
				data: { stackItemId: item.id, step: 'soulbond_pick' }
			},
			choice: {
				kind: 'chooseObjects',
				candidates: unpairedOthers.map((c) => c.instanceId),
				defaultObjectIds: [unpairedOthers[0]!.instanceId],
				min: 0,
				max: 1,
				zone: 'battlefield',
				reason
			}
		});
		return 'paused';
	}

	// --- 3b. Soulbond other-ETB ("Whenever another creature you control enters, if you control both that creature and this one and both are unpaired...") ---
	if (tag === 'soulbond_other') {
		const source = controller.battlefield.find(
			(c) =>
				!c.phasedOut &&
				c.instanceId === item.sourceInstanceId &&
				(item.sourceObjectVersion === undefined ||
					(c.objectVersion ?? 1) === item.sourceObjectVersion)
		);
		const entrant = item.eventObjectId
			? controller.battlefield.find(
					(c) =>
						!c.phasedOut &&
						c.instanceId === item.eventObjectId &&
						(item.eventObjectVersion === undefined ||
							(c.objectVersion ?? 1) === item.eventObjectVersion)
				)
			: undefined;
		if (
			!source ||
			!entrant ||
			source.instanceId === entrant.instanceId ||
			source.pairedWithId ||
			entrant.pairedWithId ||
			!evaluatePermanent(state, source).isCreature ||
			!evaluatePermanent(state, entrant).isCreature
		) {
			delete item.wave6Resume;
			return 'done';
		}

		if (item.wave6Resume?.step === 'soulbond_yn') {
			const accept = Boolean(item.wave6Resume.yes);
			delete item.wave6Resume;
			if (accept) {
				pairSoulbondCreatures(state, controller, source, entrant);
			}
			return 'done';
		}

		if (controller.isBot) {
			pairSoulbondCreatures(state, controller, source, entrant);
			return 'done';
		}

		const srcName = evaluatePermanent(state, source).effectiveName;
		const entName = evaluatePermanent(state, entrant).effectiveName;
		const question = `Pair ${srcName} with ${entName} (Soulbond, CR 702.95a)?`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: controller.playerId,
			kind: 'yesNo',
			purpose: 'generic',
			title: `Soulbond — ${srcName}`,
			description: question,
			continuation: {
				kind: 'handler',
				name: 'p18a_wave6_resume',
				data: { stackItemId: item.id, step: 'soulbond_yn' }
			},
			choice: {
				kind: 'yesNo',
				question
			}
		});
		return 'paused';
	}

	// --- 7. Hideaway [N] (CR 702.75a–b) ---
	if (tag === 'hideaway') {
		const n = Math.max(1, item.wave6N ?? 4);
		const lookCount = Math.min(n, controller.library.length);
		if (lookCount === 0) {
			delete item.wave6Resume;
			return 'done';
		}
		const topSlice = controller.library.slice(0, lookCount);

		let chosen: CardInstance | undefined;
		if (item.wave6Resume?.step === 'hideaway_pick') {
			const chosenId = item.wave6Resume.chosenObjectIds?.[0];
			delete item.wave6Resume;
			chosen = topSlice.find((c) => c.instanceId === chosenId) ?? topSlice[0];
		} else if (lookCount === 1 || controller.isBot) {
			chosen = topSlice[0]!;
			let bestMv = -1;
			for (let i = 0; i < topSlice.length; i++) {
				const cand = topSlice[i]!;
				const mv = effectiveManaValue(cand.card, instanceFaceOptions(cand, 'library'));
				if (mv > bestMv) {
					bestMv = mv;
					chosen = cand;
				}
			}
		} else {
			for (let i = 0; i < topSlice.length; i++) {
				const c = topSlice[i]!;
				const known = (c.knownToPlayerIds ??= []);
				if (!known.includes(controller.playerId)) {
					known.push(controller.playerId);
				}
			}
			const reason = `Hideaway ${n}: Choose one of the top ${lookCount} cards of your library to exile face down; the rest will be put on the bottom of your library in a random order (CR 702.75a).`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				purpose: 'generic',
				targetLibraryOwnerId: controller.playerId,
				title: `Hideaway ${n} — ${item.title}`,
				description: reason,
				continuation: {
					kind: 'handler',
					name: 'p18a_wave6_resume',
					data: { stackItemId: item.id, step: 'hideaway_pick' }
				},
				choice: {
					kind: 'chooseObjects',
					candidates: topSlice.map((c) => c.instanceId),
					defaultObjectIds: [topSlice[0]!.instanceId],
					min: 1,
					max: 1,
					zone: 'library',
					reason
				}
			});
			return 'paused';
		}

		if (!chosen) return 'done';
		const rest = topSlice.filter((c) => c.instanceId !== chosen!.instanceId);
		for (let i = 0; i < rest.length; i++) {
			delete rest[i]!.knownToPlayerIds;
		}

		const cardOwner =
			state.players.find((p) => p.playerId === chosen!.ownerId) ?? controller;
		const srcId = item.sourceInstanceId;
		const srcVer = item.sourceObjectVersion ?? 1;
		moveObject(state, chosen, 'exile', {
			from: { player: controller, zone: 'library' },
			toPlayer: cardOwner,
			newTimestamp: true,
			bumpVersion: true,
			beforeInsert: (moved, dest) => {
				if (dest === 'exile') {
					moved.isFaceDown = true;
					moved.faceDownLabel = 'Exiled Card';
					moved.exiledBy = {
						sourceInstanceId: srcId,
						sourceObjectVersion: srcVer
					};
					moved.knownToPlayerIds = [controller.playerId];
				}
			}
		});
		syncHideawayExilePeekPermissions(state);

		// Put the rest on the bottom of `controller.library` in a seeded random order (CR 702.75a).
		const shuffledRest = [...rest];
		for (let i = shuffledRest.length - 1; i > 0; i--) {
			const j = Math.floor(nextRandom(state) * (i + 1));
			const tmp = shuffledRest[i]!;
			shuffledRest[i] = shuffledRest[j]!;
			shuffledRest[j] = tmp;
		}
		for (let i = 0; i < shuffledRest.length; i++) {
			const rem = shuffledRest[i]!;
			if (controller.library.includes(rem)) {
				moveObject(state, rem, 'library', {
					from: { player: controller, zone: 'library' },
					toPlayer: controller,
					insert: 'end',
					emit: false,
					bumpVersion: false,
					newTimestamp: false
				});
			}
		}
		noteLayerInputsChanged(state);
		host?.addLog(
			state,
			'trigger',
			`${controller.username} exiled a card face down with ${item.title} and put ${shuffledRest.length} card(s) on the bottom of their library in a random order (Hideaway ${n}, CR 702.75a).`,
			controller.playerId
		);
		return 'done';
	}

	// --- 9a. Haunt exile trigger ("exile it haunting target creature", CR 702.55a–b) ---
	if (tag === 'haunt_exile') {
		const targetRef = item.targets[0];
		const targetFound = targetRef ? findPermOnBattlefield(state, targetRef.id) : null;
		const targetPerm = targetFound?.inst;
		if (!targetPerm || targetPerm.phasedOut || !evaluatePermanent(state, targetPerm).isCreature) {
			return 'done';
		}

		let gyCard: CardInstance | undefined;
		let gyOwner: PlayerGameState | undefined;
		for (let pIdx = 0; pIdx < state.players.length; pIdx++) {
			const p = state.players[pIdx]!;
			const found = p.graveyard.find(
				(c) =>
					c.instanceId === item.sourceInstanceId &&
					(item.sourceObjectVersion === undefined ||
						(c.objectVersion ?? 1) === item.sourceObjectVersion)
			);
			if (found) {
				gyCard = found;
				gyOwner = p;
				break;
			}
		}
		if (!gyCard || !gyOwner) {
			// CR 702.55a / CR 400.7: If the card left the graveyard before the Haunt trigger resolved, it cannot be exiled haunting target creature.
			return 'done';
		}

		const targetVer = targetPerm.objectVersion ?? 1;
		moveObject(state, gyCard, 'exile', {
			from: { player: gyOwner, zone: 'graveyard' },
			toPlayer: gyOwner,
			newTimestamp: true,
			bumpVersion: true
		});
		if (gyCard.zone === 'exile') {
			gyCard.hauntingTargetId = targetPerm.instanceId;
			gyCard.hauntingTargetVersion = targetVer;
			(targetPerm.hauntedByCards ??= []).push(gyCard.card);
			noteLayerInputsChanged(state);
			const targetName = evaluatePermanent(state, targetPerm).effectiveName;
			host?.addLog(
				state,
				'trigger',
				`${gyCard.card.name} was exiled haunting ${targetName} (Haunt, CR 702.55a).`,
				controller.playerId
			);
		}
		return 'done';
	}

	// --- 9b. Haunt synthetic spell fallback trigger from exile (CR 702.55c) ---
	if (tag === 'haunt_spell_effect' && item.wave6Card && host?.executeSpellCardEffectOnStack) {
		const def = compileCard(item.wave6Card);
		const spellAb = def.faces[0]?.abilities.find((a) => a.kind === 'spell');
		if (
			spellAb &&
			spellAb.kind === 'spell' &&
			staticallyInterpretable(
				{ targets: spellAb.targets, steps: spellAb.effect, unparsed: [] },
				true
			)
		) {
			return host.executeSpellCardEffectOnStack(state, item, controller, item.wave6Card);
		}
		return 'done';
	}

	return 'done';
}
