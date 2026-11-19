import { getKeywordSpec } from '../keywords.ts';
import { parseManaCost } from '../oracle.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { objectManaValue } from './objectFilter.ts';
import type {
	CardInstance,
	CombatAttacker,
	CombatState,
	GameState,
	PlayerGameState
} from '../types.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import {
	canBlockerSatisfyTimedEvasion,
	getTimedMinBlockersRequired,
	isCantAttackThisTurn,
	isCantBlockThisTurn,
	isDamageUnpreventable,
	recordAttackersDeclaredThisTurn
} from './copyPreventionAndEffects.ts';
import {
	applyLifelinkGain,
	dealDamageToPermanent,
	dealDamageToPlayer,
	sourceDamageInfo,
	type SourceDamageInfo
} from './effects.ts';
import {
	getRingBearerBlockRestriction,
	pushInitiativeCombatDamageTrigger,
	pushRingAttackTriggers,
	pushRingCombatDamageTriggers,
	registerRingBlockedEndOfCombatSacrifice
} from './effectsWave5.ts';
import {
	addLog,
	emitVfx,
	findPermanentOnBoard,
	getAttackedDefenderIdsInTurnOrder,
	getCreaturePower,
	getCreatureToughness,
	givePriorityToActiveOrNextPlayer,
	H,
	hasBlockingReplacementOrCommanderPrompt,
	hasKeyword,
	resetTriggerLoopTracking
} from './engineHost.ts';
import { emitEvent } from './events.ts';
import { enqueueProvokeAttackTriggers, isPermanentBattle, recordCombatDamagePlayerWave5 } from './framesBattlesAndKeywordsWave5.ts';
import {
	getWave10AttackRestrictionReason,
	getWave10EffectiveGoaderIds,
	hasWave10MustAttackDirective,
	recordCombatAttackersWave10,
	recordCombatDamageToPlayerWave10,
	validateWave10AttackerAssignments
} from './combatWave10.ts';
import {
	computePlaneswalkerTrampleSplit,
	getTrampleCapabilities,
	isSpaceSectorBlockIllegal
} from './framesWave7.ts';
import { sumPermanentToxic } from './keywordsWave3.ts';
import { recordDeclaredAttackersWave4 } from './keywordsWave4.ts';
import {
	chooseBotBandingAttackerDamageTarget,
	chooseBotBandingBlockerDamageTarget,
	propagateBandingBlockers,
	validateAndBuildAttackingBands
} from './keywordsWave6.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import { matchesObjectFilter } from './objectFilter.ts';
import { uid } from './random.ts';
import { getAttackTaxGeneric, getAttackTaxSources, hasRestriction } from './replace.ts';
import {
	creatureCanAttackDespiteDefender,
	creatureMayAssignCombatDamageAsThoughUnblocked,
	getEffectiveGoaderPlayerIds
} from './staticsAndCostsWave5.ts';
import { creatureAssignsCombatDamageByToughness } from './staticsDynamicAndCosts.ts';
import {
	getGlobalAttackCapError,
	getStaticAttackRestrictionReason,
	getStaticBlockerPairRestrictionReason,
	permanentCantAttackAlone,
	validateAndSolveDefenderBlockersP8
} from './staticsLayersAndRestrictions.ts';
import {
	canBlockAttackerAsThoughReach,
	checkDefenderScopedAttackRestriction,
	computeDeclareAttackersTaxSummary,
	isLandwalkIgnoredForAttacker,
	validateDefenderBlockersWithWave6
} from './staticsWave6.ts';
import {
	canAttackIgnoringSummoningSicknessWave9,
	getMustAttackAttachedControllerWave9
} from './staticsWave9.ts';
import { flushTriggers, withTriggersDeferred } from './triggers.ts';
import { tapPermanent } from './zones.ts';

function chooseBotRequiredAttackAssignments(
	state: GameState,
	bot: PlayerGameState
): Array<{ attackerInstanceId: string; defenderPlayerId: string; defenderPlaneswalkerId?: string | null }> {
	const opponents = state.players
		.filter((p) => p.playerId !== bot.playerId && !p.lost)
		.sort((a, b) => b.life - a.life);
	if (opponents.length === 0) return [];
	const taxFreeOpponents = opponents.filter((p) => getAttackTaxGeneric(state, p) === 0);
	if (taxFreeOpponents.length === 0) return [];

	return withStableLayerInputs(state, () => {
		const assignments: Array<{
			attackerInstanceId: string;
			defenderPlayerId: string;
			defenderPlaneswalkerId?: string | null;
		}> = [];
		for (const c of bot.battlefield) {
			if (
				c.phasedOut ||
				!evaluatePermanent(state, c).isCreature ||
				c.tapped ||
				(c.summoningSick && !hasKeyword(c, 'Haste', state) && !canAttackIgnoringSummoningSicknessWave9(state, c)) ||
				// --- Track P13 + Track P14 ---
				(hasKeyword(c, 'Defender', state) &&
					!c.canAttackAsThoughNoDefenderThisTurn &&
					!creatureCanAttackDespiteDefender(state, c)) ||
				// --- End Track P13 + Track P14 ---
				// --- Track P22d ---
				hasRestriction(state, c, 'cantAttack') ||
				isCantAttackThisTurn(state, c)
				// --- End Track P22d ---
			) {
				continue;
			}
			// --- Track P14 + Track P16a ---
			const goaderIds = Array.from(
				new Set([...getEffectiveGoaderPlayerIds(state, c), ...getWave10EffectiveGoaderIds(state, c)])
			);
			const isGoaded = goaderIds.length > 0;
			const mustAttack =
				isGoaded ||
				hasWave10MustAttackDirective(state, c) ||
				Boolean(c.mustAttackThisTurn) ||
				hasRestriction(state, c, 'attacksEachCombat');
			// --- End Track P14 + Track P16a ---
			if (!mustAttack) continue;

			let candidateDefenders = taxFreeOpponents.filter(
				(p) =>
					getStaticAttackRestrictionReason(state, c, p.playerId) === null &&
					getWave10AttackRestrictionReason(state, c, p.playerId) === null &&
					// --- Track P17a ---
					!checkDefenderScopedAttackRestriction(state, c, p.playerId).restricted &&
					!computeDeclareAttackersTaxSummary(state, bot.playerId, [
						{ attackerId: c.instanceId, defenderPlayerId: p.playerId }
					]).hasTax
					// --- End Track P17a ---
			);
			if (candidateDefenders.length === 0) continue;
			if (c.mustAttackPlayerIdThisTurn) {
				const requiredOpp = candidateDefenders.filter(
					(p) => p.playerId === c.mustAttackPlayerIdThisTurn
				);
				if (requiredOpp.length > 0) {
					candidateDefenders = requiredOpp;
				}
			}
			if (isGoaded) {
				const nonGoaders = candidateDefenders.filter(
					// --- Track P14 ---
					(p) => !goaderIds.includes(p.playerId)
					// --- End Track P14 ---
				);
				if (nonGoaders.length > 0) {
					candidateDefenders = nonGoaders;
				}
			}
			const idx = assignments.length;
			const nextCandidate = [
				...assignments,
				{
					attackerInstanceId: c.instanceId,
					defenderPlayerId: candidateDefenders[idx % candidateDefenders.length]!.playerId
				}
			];
			if (getGlobalAttackCapError(state, nextCandidate) !== null) continue;
			assignments.push(nextCandidate[nextCandidate.length - 1]!);
		}
		// CR 508.1c–d: If a single required creature has cantAttackAlone, join another legal creature if possible; else return [].
		if (assignments.length === 1) {
			const solePerm = bot.battlefield.find(
				(c) => c.instanceId === assignments[0]!.attackerInstanceId
			);
			if (solePerm && permanentCantAttackAlone(state, solePerm)) {
				let partnerAdded = false;
				for (const other of bot.battlefield) {
					if (
						other.instanceId === solePerm.instanceId ||
						other.phasedOut ||
						!evaluatePermanent(state, other).isCreature ||
						other.tapped ||
						(other.summoningSick && !hasKeyword(other, 'Haste', state) && !canAttackIgnoringSummoningSicknessWave9(state, other)) ||
						// --- Track P13 + Track P14 ---
						(hasKeyword(other, 'Defender', state) &&
							!other.canAttackAsThoughNoDefenderThisTurn &&
							!creatureCanAttackDespiteDefender(state, other)) ||
						// --- End Track P13 + Track P14 ---
						// --- Track P22d ---
						hasRestriction(state, other, 'cantAttack') ||
						isCantAttackThisTurn(state, other)
						// --- End Track P22d ---
					) {
						continue;
					}
					const partnerDef = taxFreeOpponents.find(
						(p) => getStaticAttackRestrictionReason(state, other, p.playerId, 2) === null
					);
					if (!partnerDef) continue;
					const pair = [
						assignments[0]!,
						{ attackerInstanceId: other.instanceId, defenderPlayerId: partnerDef.playerId }
					];
					if (getGlobalAttackCapError(state, pair) === null) {
						assignments.push(pair[1]!);
						partnerAdded = true;
						break;
					}
				}
				if (!partnerAdded) return [];
			}
		}
		return assignments;
	});
}

export function chooseBotAttackAssignments(
	state: GameState,
	bot: PlayerGameState
): Array<{ attackerInstanceId: string; defenderPlayerId: string; defenderPlaneswalkerId?: string | null }> {
	const opponents = state.players
		.filter((p) => p.playerId !== bot.playerId && !p.lost)
		.sort((a, b) => b.life - a.life);
	if (opponents.length === 0) return [];

	const requiredAssignments = chooseBotRequiredAttackAssignments(state, bot);
	const requiredIds = new Set(requiredAssignments.map((a) => a.attackerInstanceId));

	const optionalAttackers = withStableLayerInputs(state, () =>
		bot.battlefield.filter(
			(c) =>
				!requiredIds.has(c.instanceId) &&
				!c.phasedOut &&
				evaluatePermanent(state, c).isCreature &&
				!c.tapped &&
				(!c.summoningSick || hasKeyword(c, 'Haste', state) || canAttackIgnoringSummoningSicknessWave9(state, c)) &&
				// --- Track P13 + Track P14 ---
				(!hasKeyword(c, 'Defender', state) ||
					Boolean(c.canAttackAsThoughNoDefenderThisTurn) ||
					creatureCanAttackDespiteDefender(state, c)) &&
				// --- End Track P13 + Track P14 ---
				// --- Track P22d ---
				!hasRestriction(state, c, 'cantAttack') &&
				!isCantAttackThisTurn(state, c) &&
				// --- End Track P22d ---
				getCreaturePower(c, state) >= 2
		)
	);

	const assignments = [...requiredAssignments];
	for (const atk of optionalAttackers) {
		const legalOpponents = opponents.filter(
			(p) =>
				getStaticAttackRestrictionReason(state, atk, p.playerId) === null &&
				// --- Track P17a ---
				!checkDefenderScopedAttackRestriction(state, atk, p.playerId).restricted &&
				!computeDeclareAttackersTaxSummary(state, bot.playerId, [
					{ attackerId: atk.instanceId, defenderPlayerId: p.playerId }
				]).hasTax
				// --- End Track P17a ---
		);
		if (legalOpponents.length === 0) continue;
		const idx = assignments.length;
		const nextCandidate = [
			...assignments,
			{
				attackerInstanceId: atk.instanceId,
				defenderPlayerId: legalOpponents[idx % legalOpponents.length]!.playerId
			}
		];
		if (getGlobalAttackCapError(state, nextCandidate) !== null) continue;
		assignments.push(nextCandidate[nextCandidate.length - 1]!);
	}
	if (assignments.length === 1) {
		const solePerm = bot.battlefield.find(
			(c) => c.instanceId === assignments[0]!.attackerInstanceId
		);
		if (solePerm && permanentCantAttackAlone(state, solePerm)) {
			return requiredAssignments;
		}
	}
	return assignments;
}

export function executeBotDeclareAttackersTurnBasedAction(
	state: GameState,
	bot: PlayerGameState
): void {
	const assignments = chooseBotAttackAssignments(state, bot);
	let res = performDeclareAttackers(state, bot, assignments, true);
	if (!res.ok) {
		const requiredOnly = chooseBotRequiredAttackAssignments(state, bot);
		res = performDeclareAttackers(state, bot, requiredOnly, true);
	}
	if (!res.ok) {
		addLog(
			state,
			'rule',
			res.error ?? `${bot.username} could not satisfy attack requirements; declaring no attackers.`,
			bot.playerId
		);
		// Last resort: declare no attackers through the normal path so combat state is reset the same way.
		performDeclareAttackers(state, bot, [], true, true);
	}
}

export function performDeclareAttackers(
	state: GameState,
	actor: PlayerGameState,
	assignments: Array<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string | null;
		// --- Track P15 ---
		defenderBattleId?: string | null;
		// --- End Track P15 ---
	}>,
	fromPhaseEntry: boolean,
	/** Only for the bot's last-resort empty declaration, after a 'rule' line has been logged. */
	ignoreAttackRequirements = false,
	// --- Track P18a: Banding (CR 702.22c) ---
	rawBands?: string[][]
	// --- End Track P18a ---
): { ok: boolean; error?: string } {
	const actorId = actor.playerId;
	const validAttackers = [];
	let totalPropagandaTaxGeneric = 0;
	const seenAttackerIds = new Set<string>();

	for (const assign of assignments) {
		if (seenAttackerIds.has(assign.attackerInstanceId)) {
			return { ok: false, error: 'Duplicate attacking creature assignment.' };
		}
		seenAttackerIds.add(assign.attackerInstanceId);

		const creature = actor.battlefield.find(
			(c) => c.instanceId === assign.attackerInstanceId
		);
		if (!creature || creature.phasedOut || !evaluatePermanent(state, creature).isCreature) {
			return { ok: false, error: 'Invalid attacking creature.' };
		}
		if (creature.tapped) {
			return { ok: false, error: `${creature.card.name} is tapped and cannot attack.` };
		}
		if (creature.summoningSick && !hasKeyword(creature, 'Haste', state) && !canAttackIgnoringSummoningSicknessWave9(state, creature)) {
			return {
				ok: false,
				error: `${creature.card.name} has summoning sickness and cannot attack this turn.`
			};
		}
		// --- Track P13 + Track P14 ---
		if (
			hasKeyword(creature, 'Defender', state) &&
			!creature.canAttackAsThoughNoDefenderThisTurn &&
			!creatureCanAttackDespiteDefender(state, creature)
		) {
			return { ok: false, error: `${creature.card.name} has Defender and cannot attack.` };
		}
		// --- End Track P13 + Track P14 ---
		// --- Track P22d ---
		if (hasRestriction(state, creature, 'cantAttack') || isCantAttackThisTurn(state, creature)) {
			return { ok: false, error: `${creature.card.name} cannot attack.` };
		}
		// --- End Track P22d ---

		// --- Track P15: CR 310.8–9 Attacking a Battle ---
		if (assign.defenderPlaneswalkerId && assign.defenderBattleId) {
			return {
				ok: false,
				error: 'A creature cannot attack both a planeswalker and a battle (CR 508.1b).'
			};
		}
		let resolvedDefenderPlayerId = assign.defenderPlayerId;
		if (assign.defenderBattleId) {
			const targetBattleFound = findPermanentOnBoard(state, assign.defenderBattleId);
			if (
				!targetBattleFound ||
				targetBattleFound.inst.phasedOut ||
				!isPermanentBattle(state, targetBattleFound.inst)
			) {
				return { ok: false, error: 'Invalid defending battle (CR 310.8a, 508.1b).' };
			}
			const protectorId = targetBattleFound.inst.protectorId;
			if (!protectorId) {
				return { ok: false, error: 'That battle currently has no protector (CR 310.8a).' };
			}
			if (protectorId === actorId) {
				return {
					ok: false,
					error: `Strict Rules Violation: You cannot attack ${targetBattleFound.inst.card.name} because you are its protector (CR 310.8b, 310.9b).`
				};
			}
			resolvedDefenderPlayerId = protectorId;
		}
		// --- End Track P15 ---

		const defender = state.players.find(
			(p) => p.playerId === resolvedDefenderPlayerId && !p.lost
		);
		if (!defender || defender.playerId === actorId) {
			return { ok: false, error: 'Invalid defending player.' };
		}

		// --- Track P8 (CR 508.1c) ---
		const staticAtkErr = getStaticAttackRestrictionReason(
			state,
			creature,
			defender.playerId,
			assignments.length
		);
		if (staticAtkErr) {
			return { ok: false, error: staticAtkErr };
		}
		const w10AtkErr = getWave10AttackRestrictionReason(state, creature, defender.playerId);
		if (w10AtkErr) {
			return { ok: false, error: w10AtkErr };
		}
		// --- Track P17a: CR 508.1c defender-scoped attack restrictions ("can't attack you [or planeswalkers you control]") ---
		const defScopedRestr = checkDefenderScopedAttackRestriction(
			state,
			creature,
			defender.playerId,
			assign.defenderPlaneswalkerId ?? undefined,
			assign.defenderBattleId ?? undefined
		);
		if (defScopedRestr.restricted) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${creature.card.name} cannot attack ${defender.username}${assign.defenderPlaneswalkerId ? "'s planeswalker" : ''} (${defScopedRestr.sourceName ?? 'static restriction'}, CR 508.1c).`
			};
		}
		// --- End Track P17a ---

		// CR 508.1b: Validate defenderPlaneswalkerId if provided
		if (assign.defenderPlaneswalkerId) {
			const targetPw = defender.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === assign.defenderPlaneswalkerId
			);
			if (!targetPw || !evaluatePermanent(state, targetPw).isPlaneswalker) {
				return {
					ok: false,
					error: 'Invalid defending planeswalker (CR 508.1b).'
				};
			}
		}

		// CR 701.15b: Goad requires attacking a player other than the goader if able
		// --- Track P14 ---
		const effectiveGoaders = Array.from(
			new Set([
				...getEffectiveGoaderPlayerIds(state, creature),
				...getWave10EffectiveGoaderIds(state, creature)
			])
		);
		if (effectiveGoaders.length > 0) {
			const nonGoaderAvailable = state.players.some(
				(p) =>
					p.playerId !== actorId &&
					!p.lost &&
					!effectiveGoaders.includes(p.playerId) &&
					getAttackTaxGeneric(state, p) === 0 &&
					getStaticAttackRestrictionReason(
						state,
						creature,
						p.playerId,
						Math.max(assignments.length, 1)
					) === null &&
					getWave10AttackRestrictionReason(state, creature, p.playerId) === null
			);
			if (
				nonGoaderAvailable &&
				(effectiveGoaders.includes(defender.playerId) ||
					Boolean(assign.defenderPlaneswalkerId) ||
					Boolean(assign.defenderBattleId))
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${creature.card.name} is Goaded and must attack a player other than its goader if able (CR 701.15b).`
				};
			}
		}
		// --- End Track P14 ---

		// --- Track P12: Encore mandatory opponent attack (CR 702.141a) ---
		if (creature.encoreMustAttackPlayerId) {
			const reqOpp = state.players.find(
				(p) => p.playerId === creature.encoreMustAttackPlayerId && !p.lost
			);
			const canAttackReqOpp =
				Boolean(reqOpp) &&
				getAttackTaxGeneric(state, reqOpp!) === 0 &&
				getStaticAttackRestrictionReason(
					state,
					creature,
					reqOpp!.playerId,
					Math.max(assignments.length, 1)
				) === null;
			if (
				canAttackReqOpp &&
				(defender.playerId !== creature.encoreMustAttackPlayerId ||
					Boolean(assign.defenderPlaneswalkerId) ||
					Boolean(assign.defenderBattleId))
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${creature.card.name} was created by Encore and must attack ${reqOpp!.username} this turn if able (CR 702.141a).`
				};
			}
		}
		// --- End Track P12 ---
		// --- Wave 12: Attached creature must attack Enchantment controller if able (Public Enemy) ---
		const mustAttackCtrlId = getMustAttackAttachedControllerWave9(state, creature);
		if (mustAttackCtrlId) {
			const reqCtrl = state.players.find((p) => p.playerId === mustAttackCtrlId && !p.lost);
			const canAttackReqCtrl =
				Boolean(reqCtrl) &&
				getAttackTaxGeneric(state, reqCtrl!) === 0 &&
				getStaticAttackRestrictionReason(
					state,
					creature,
					reqCtrl!.playerId,
					Math.max(assignments.length, 1)
				) === null &&
				getWave10AttackRestrictionReason(state, creature, reqCtrl!.playerId) === null &&
				!checkDefenderScopedAttackRestriction(state, creature, reqCtrl!.playerId).restricted;
			if (
				canAttackReqCtrl &&
				(defender.playerId !== mustAttackCtrlId ||
					Boolean(assign.defenderPlaneswalkerId) ||
					Boolean(assign.defenderBattleId))
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${creature.card.name} must attack ${reqCtrl!.username} if able (CR 508.1d).`
				};
			}
		}
		// --- End Wave 12 ---

		// Check attack tax on defending player (CR 508.1d)
		if (!assign.defenderPlaneswalkerId && !assign.defenderBattleId) {
			totalPropagandaTaxGeneric += getAttackTaxGeneric(state, defender);
		}
	}

	// --- Track P8 (CR 508.1c): Global attacker caps (Silent Arbiter / Dueling Grounds / Crawlspace) ---
	const globalAtkCapErr = getGlobalAttackCapError(state, assignments);
	if (globalAtkCapErr) {
		return { ok: false, error: globalAtkCapErr };
	}

	// Enforce Goad / Attack requirements (CR 508.1d: must satisfy as many requirements as possible without violating restrictions)
	const assignedIds = new Set(assignments.map((a) => a.attackerInstanceId));
	const mandatoryViolation = ignoreAttackRequirements
		? null
		: findMandatoryAttackerViolation(state, actor, assignedIds, assignments);
	if (mandatoryViolation) {
		return { ok: false, error: mandatoryViolation };
	}
	if (!ignoreAttackRequirements) {
		const w10AssignErr = validateWave10AttackerAssignments(
			state,
			actor,
			assignments,
			(perm, pid) => {
				const opp = state.players.find((pl) => pl.playerId === pid && !pl.lost);
				return (
					Boolean(opp) &&
					getAttackTaxGeneric(state, opp!) === 0 &&
					getStaticAttackRestrictionReason(state, perm, pid, Math.max(assignments.length, 1)) === null &&
					getWave10AttackRestrictionReason(state, perm, pid) === null &&
					!checkDefenderScopedAttackRestriction(state, perm, pid).restricted
				);
			}
		);
		if (w10AssignErr) {
			return { ok: false, error: w10AssignErr };
		}
	}

	// --- Track P18a: Validate Banding formations before paying taxes / tapping (CR 702.22c) ---
	let validatedBands: CombatState['bands'];
	if (rawBands && rawBands.length > 0) {
		const previewAttackers: CombatAttacker[] = assignments.map((assign) => {
			const defBattleProtectorId = assign.defenderBattleId
				? findPermanentOnBoard(state, assign.defenderBattleId)?.inst.protectorId
				: undefined;
			const effectiveDefId = defBattleProtectorId ?? assign.defenderPlayerId;
			return {
				attackerInstanceId: assign.attackerInstanceId,
				controllerId: actorId,
				defenderPlayerId: effectiveDefId,
				defenderPlaneswalkerId: assign.defenderPlaneswalkerId || null,
				...(assign.defenderBattleId ? { defenderBattleId: assign.defenderBattleId } : {}),
				blockerInstanceIds: [],
				wasBlocked: false
			};
		});
		const bandRes = validateAndBuildAttackingBands(state, actor, previewAttackers, rawBands);
		if (!bandRes.ok) {
			return { ok: false, error: bandRes.error };
		}
		validatedBands = bandRes.bands;
	}
	// --- End Track P18a ---

	// --- Track P17a: CR 508.1d Pay declare-attackers tax (player, planeswalker, dynamic Amount, colored/Phyrexian) ---
	const atkTaxSummary = computeDeclareAttackersTaxSummary(
		state,
		actorId,
		assignments.map((a) => ({
			attackerId: a.attackerInstanceId,
			defenderPlayerId: a.defenderPlayerId,
			defenderPlaneswalkerId: a.defenderPlaneswalkerId ?? undefined,
			defenderBattleId: a.defenderBattleId ?? undefined
		}))
	);
	if (atkTaxSummary.hasTax) {
		const taxReq = parseManaCost(atkTaxSummary.combinedManaCost);
		if (!H().payManaWithAutoTap(actor, taxReq, state)) {
			const taxSources = Array.from(
				new Set(
					assignments
						.filter((a) => !a.defenderPlaneswalkerId)
						.flatMap((a) => getAttackTaxSources(state, a.defenderPlayerId))
				)
			);
			return {
				ok: false,
				error: `Strict Rules Violation: Attacking requires paying ${atkTaxSummary.combinedManaCost} for ${taxSources.join(' / ') || 'attack tax'}, and you have insufficient mana.`
			};
		}
	} else if (totalPropagandaTaxGeneric > 0) {
		const taxReq = parseManaCost(`{${totalPropagandaTaxGeneric}}`);
		if (!H().payManaWithAutoTap(actor, taxReq, state)) {
			return {
				ok: false,
				error: `Strict Rules Violation: Attacking requires paying {${totalPropagandaTaxGeneric}}, and you have insufficient mana.`
			};
		}
	}
	// --- End Track P17a ---

	// CR 508.1f: attackers tap as they're declared, all at once, so vigilance is read from the
	// board before any of them taps (tapping one between checks invalidated the layer cache
	// for the next; Phase 6d).
	const vigilantIds = withStableLayerInputs(state, () => {
		const ids = new Set<string>();
		for (const assign of assignments) {
			const creature = actor.battlefield.find(
				(c) => c.instanceId === assign.attackerInstanceId
			)!;
			if (hasKeyword(creature, 'Vigilance', state)) ids.add(creature.instanceId);
		}
		return ids;
	});
	for (const assign of assignments) {
		const creature = actor.battlefield.find(
			(c) => c.instanceId === assign.attackerInstanceId
		)!;
		// --- Track P15 ---
		const defBattleProtectorId = assign.defenderBattleId
			? findPermanentOnBoard(state, assign.defenderBattleId)?.inst.protectorId
			: undefined;
		const effectiveDefId = defBattleProtectorId ?? assign.defenderPlayerId;
		// --- End Track P15 ---
		const defender = state.players.find(
			(p) => p.playerId === effectiveDefId && !p.lost
		)!;
		// --- Track P22a: Record attacked player for cantAttackSamePlayerTwiceInTurn ---
		const attackedList = (creature.attackedPlayerIdsThisTurn ??= []);
		if (!attackedList.includes(defender.playerId)) {
			attackedList.push(defender.playerId);
		}
		// --- End Track P22a ---
		if (!vigilantIds.has(creature.instanceId)) {
			// --- Track P19b: CR 508.1f "if it isn't being declared as an attacker" ---
			state.declaringAttackersNow = true;
			try {
				tapPermanent(state, creature);
			} finally {
				delete state.declaringAttackersNow;
			}
			// --- End Track P19b ---
		}
		validAttackers.push({
			attackerInstanceId: creature.instanceId,
			controllerId: actorId,
			defenderPlayerId: defender.playerId,
			defenderPlaneswalkerId: assign.defenderPlaneswalkerId || null,
			// --- Track P15 ---
			...(assign.defenderBattleId ? { defenderBattleId: assign.defenderBattleId } : {}),
			// --- End Track P15 ---
			blockerInstanceIds: [],
			wasBlocked: false
		});
	}

	const wasAwaiting = Boolean(state.combat.awaitingAttackersDeclaration);
	state.combat.active = true;
	state.combat.awaitingAttackersDeclaration = false;
	state.combat.attackers = validAttackers;
	// --- Track P18a ---
	state.combat.bands = validatedBands;
	// --- End Track P18a ---
	state.combat.declaredBlockersPlayerIds = [];
	state.combat.blockersDeclared = false;
	state.combat.damageDealtFirstStrike = false;
	state.combat.damageDealtNormal = false;
	state.combat.dealtFirstStrikeDamageIds = [];
	noteLayerInputsChanged(state);

	resetTriggerLoopTracking(state);
	if (validAttackers.length > 0) {
		// --- Track P7 ---
		recordAttackersDeclaredThisTurn(state, actor);
		// --- End Track P7 ---
		// --- Track P12 ---
		recordDeclaredAttackersWave4(
			state,
			validAttackers
				.map((v) => actor.battlefield.find((c) => c.instanceId === v.attackerInstanceId))
				.filter((c): c is CardInstance => Boolean(c))
		);
		recordCombatAttackersWave10(state, validAttackers);
		if (
			validAttackers.some((v) =>
				actor.battlefield.some((c) => c.instanceId === v.attackerInstanceId && c.isCommander)
			)
		) {
			actor.attackedWithCommanderThisTurn = true;
		}
		// --- End Track P12 ---
		addLog(
			state,
			'combat',
			`${actor.username} declared ${validAttackers.length} attacker(s)!`,
			actorId
		);
		emitVfx(state, {
			kind: 'attack_declare',
			sourceId: actorId,
			amount: validAttackers.length,
			label: `${validAttackers.length} Attacker(s)`
		});
		emitEvent(state, {
			kind: 'AttackDeclared',
			playerId: actor.playerId,
			attackerIds: validAttackers.map((a) => a.attackerInstanceId)
		});
		// --- Track P13 (CR 701.54c): Ring Level 2 attack loot trigger ---
		pushRingAttackTriggers(
			state,
			actor,
			validAttackers.map((a) => a.attackerInstanceId)
		);
		// --- End Track P13 ---
		// --- Track P15: Provoke attack triggers (CR 702.39a) ---
		for (const va of validAttackers) {
			const atkInst = actor.battlefield.find((c) => c.instanceId === va.attackerInstanceId);
			if (atkInst) {
				enqueueProvokeAttackTriggers(state, atkInst, va.defenderPlayerId);
			}
		}
		// --- End Track P15 ---
	} else {
		addLog(state, 'combat', `${actor.username} declared no attackers.`, actorId);
	}

	if (!fromPhaseEntry) {
		if (wasAwaiting) {
			emitEvent(state, {
				kind: 'PhaseBegin',
				phase: 'declare_attackers',
				activePlayerId: actor.playerId
			});
		}
		flushTriggers(state);
		// CR 508.2: Active player receives priority in declare_attackers after attackers are declared
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		state.priorityUpdatedAt = Date.now();
		H().checkStateBasedActions(state);
	}
	return { ok: true };
}

export function getPendingCombatDeclarationError(state: GameState): string | null {
	if (state.phase === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
		return 'Attackers must be declared before players receive priority in the Declare Attackers step (CR 508.1, 508.2).';
	}
	if (
		state.phase === 'declare_blockers' &&
		state.combat.active &&
		state.combat.attackers.length > 0 &&
		!state.combat.blockersDeclared
	) {
		return 'Blockers must be declared before players receive priority in the Declare Blockers step (CR 509.1, 509.2).';
	}
	return null;
}

export function isCombatDeclarationPending(state: GameState): boolean {
	return getPendingCombatDeclarationError(state) !== null;
}

export function isUnconfirmedAttackersStep(state: GameState): boolean {
	return state.phase === 'declare_attackers' && !state.combat.active;
}

export function completeUnconfirmedZeroAttackersDeclaration(
	state: GameState,
	activePlayer: PlayerGameState,
	logActor?: PlayerGameState
): { ok: true; triggeredOrPrompted: boolean } | { ok: false; error: string } {
	const violation = findMandatoryAttackerViolation(state, activePlayer);
	if (violation) {
		return { ok: false, error: violation };
	}
	const wasAwaiting = Boolean(state.combat.awaitingAttackersDeclaration);
	state.combat.active = true;
	state.combat.awaitingAttackersDeclaration = false;
	state.combat.attackers = [];
	state.combat.declaredBlockersPlayerIds = [];
	state.combat.blockersDeclared = false;
	noteLayerInputsChanged(state);
	if (logActor) {
		addLog(state, 'combat', `${logActor.username} declared no attackers.`, logActor.playerId);
	}
	if (wasAwaiting) {
		emitEvent(state, {
			kind: 'PhaseBegin',
			phase: 'declare_attackers',
			activePlayerId: activePlayer.playerId
		});
		flushTriggers(state);
		if (state.stack.length > 0 || state.pendingPrompts.length > 0) {
			givePriorityToActiveOrNextPlayer(state);
			state.passedPriorityPlayerIds = [];
			return { ok: true, triggeredOrPrompted: true };
		}
	}
	return { ok: true, triggeredOrPrompted: false };
}

function getBlockerRestrictionReason(
	state: GameState,
	blocker: CardInstance,
	attacker: CardInstance
): string | null {
	// --- Track P12: Decayed creatures cannot block (CR 702.147a) ---
	if (hasKeyword(blocker, 'Decayed', state)) {
		return `Strict Rules Violation: ${blocker.card.name} has Decayed and cannot block (CR 702.147a).`;
	}
	// --- End Track P12 ---
	if (
		hasKeyword(attacker, 'Flying', state) &&
		!hasKeyword(blocker, 'Flying', state) &&
		!hasKeyword(blocker, 'Reach', state) &&
		// --- Track P17a ---
		!canBlockAttackerAsThoughReach(state, blocker, attacker)
		// --- End Track P17a ---
	) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Flying; blocker needs Flying or Reach).`;
	}
	if (hasRestriction(state, attacker, 'cantBeBlocked')) {
		return `Strict Rules Violation: ${attacker.card.name} cannot be blocked.`;
	}
	// --- Track P7 ---
	if (!canBlockerSatisfyTimedEvasion(state, attacker, blocker)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} this turn (CR 509.1b).`;
	}
	// --- End Track P7 ---
	// --- Track P16a ---
	if (blocker.cantBlockAttackerIdsThisTurn?.includes(attacker.instanceId)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} this turn (CR 509.1b).`;
	}
	// --- End Track P16a ---
	if (attacker.cantBeBlockedByOpponentsThisTurn) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} this turn.`;
	}
	if (state.cantBlockManaValueParityThisTurn) {
		const mv = objectManaValue(state, blocker);
		const isOdd = mv % 2 === 1;
		if (
			(state.cantBlockManaValueParityThisTurn === 'odd' && isOdd) ||
			(state.cantBlockManaValueParityThisTurn === 'even' && !isOdd)
		) {
			return `Strict Rules Violation: ${blocker.card.name} (mana value ${mv}) cannot block this turn.`;
		}
	}
	// --- Track P21: Space Beleren sector combat lock ---
	if (isSpaceSectorBlockIllegal(state, attacker, blocker)) {
		return `Strict Rules Violation: ${blocker.card.name} (${blocker.spaceSector ?? 'unassigned'} sector) cannot block ${attacker.card.name} (${attacker.spaceSector} sector) this turn.`;
	}
	// --- End Track P21 ---
	if (H().hasProtectionFrom(attacker, blocker.copiableCard ?? blocker.card, state, blocker)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} due to Protection (CR 702.16e).`;
	}
	if (hasKeyword(attacker, 'Fear', state)) {
		const evalBlocker = evaluatePermanent(state, blocker);
		if (!evalBlocker.isArtifact && !evalBlocker.colors.includes('B')) {
			return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Fear; blocker must be an artifact creature and/or black creature, CR 702.36b).`;
		}
	}
	if (hasKeyword(attacker, 'Intimidate', state)) {
		const evalAtk = evaluatePermanent(state, attacker);
		const evalBlocker = evaluatePermanent(state, blocker);
		if (
			!evalBlocker.isArtifact &&
			!evalAtk.colors.some((c) => evalBlocker.colors.includes(c))
		) {
			return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Intimidate; blocker must be an artifact creature and/or share a color with it, CR 702.13b).`;
		}
	}
	if (hasKeyword(attacker, 'Shadow', state) !== hasKeyword(blocker, 'Shadow', state)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} due to Shadow (CR 702.28b).`;
	}
	if (hasKeyword(attacker, 'Horsemanship', state) && !hasKeyword(blocker, 'Horsemanship', state)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Horsemanship, CR 702.31b).`;
	}
	const evalAttackerLandwalk = evaluatePermanent(state, attacker);
	const defendingPlayer = state.players.find((p) => p.playerId === blocker.controllerId);
	if (defendingPlayer) {
		const defPermanents = defendingPlayer.battlefield.filter((perm) => !perm.phasedOut);
		for (const kw of evalAttackerLandwalk.activeKeywords) {
			// --- Track P17a: CR 702.14c landwalk neutralization ---
			if (isLandwalkIgnoredForAttacker(state, attacker, kw)) continue;
			// --- End Track P17a ---
			const spec = getKeywordSpec(kw);
			if (
				spec?.status === 'implemented' &&
				spec.implementation?.kind === 'primitive' &&
				spec.implementation.landwalkFilter
			) {
				const landFilter = spec.implementation.landwalkFilter;
				if (
					defPermanents.some((perm) =>
						matchesObjectFilter(perm, landFilter, { state, controllerId: defendingPlayer.playerId })
					)
				) {
					return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has ${spec.displayLabel ?? kw}, CR 702.14c).`;
				}
			}
		}
	}
	// --- Track P13 (CR 701.54c): Ring Level 1 greater-power block restriction ---
	const ringBlockErr = getRingBearerBlockRestriction(state, blocker, attacker);
	if (ringBlockErr) return ringBlockErr;
	// --- End Track P13 ---
	// --- Track P8 (CR 509.1b, 702.118b) ---
	return getStaticBlockerPairRestrictionReason(state, blocker, attacker);
}

export function canBlock(
	state: GameState,
	blocker: CardInstance,
	attacker: CardInstance
): boolean {
	return getBlockerRestrictionReason(state, blocker, attacker) === null;
}

export function chooseBotBlockAssignments(
	state: GameState,
	bot: PlayerGameState
): Array<{ blockerInstanceId: string; attackerInstanceId: string }> {
	const attacksAgainstBot = state.combat.attackers.filter(
		(a) => a.defenderPlayerId === bot.playerId
	);
	if (attacksAgainstBot.length === 0) return [];
	return withStableLayerInputs(state, () => {
		const assignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }> = [];
		const usedBlockers = new Set<string>();

		for (const atk of attacksAgainstBot) {
			if (atk.blockerInstanceIds.length > 0) continue;
			const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
			const atkCard = atkOwner?.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
			);
			if (!atkCard) continue;
			if (hasRestriction(state, atkCard, 'cantBeBlocked')) continue;
			if (hasKeyword(atkCard, 'Menace', state)) continue;
			// --- Track P7 ---
			if (getTimedMinBlockersRequired(state, atkCard) > 1) continue;
			// --- End Track P7 ---

			const candidate = bot.battlefield.find((b) => {
				if (b.phasedOut || usedBlockers.has(b.instanceId) || b.tapped) return false;
				const evalBlocker = evaluatePermanent(state, b);
				if (!evalBlocker.isCreature) return false;
				if (hasRestriction(state, b, 'cantBlock')) return false;
				// --- Track P7 ---
				if (isCantBlockThisTurn(state, b)) return false;
				// --- End Track P7 ---
				if (!canBlock(state, b, atkCard)) return false;
				const bTough = getCreatureToughness(b, state);
				const aPwr = getCreaturePower(atkCard, state);
				return bTough > aPwr || aPwr >= 4 || bot.life <= aPwr;
			});

			if (candidate) {
				usedBlockers.add(candidate.instanceId);
				assignments.push({
					blockerInstanceId: candidate.instanceId,
					attackerInstanceId: atk.attackerInstanceId
				});
			}
		}

		// CR 509.1c: Include any remaining untapped creatures that must block each combat if able.
		for (const b of bot.battlefield) {
			if (b.phasedOut || usedBlockers.has(b.instanceId) || b.tapped) continue;
			const evalBlocker = evaluatePermanent(state, b);
			if (!evalBlocker.isCreature) continue;
			if (hasRestriction(state, b, 'cantBlock')) continue;
			// --- Track P7 ---
			if (isCantBlockThisTurn(state, b)) continue;
			// --- End Track P7 ---
			// --- Track P15: Provoke requirement (CR 702.39a) + Track P16a mustBeBlockedThisTurn ---
			const lureAtkIds = new Set(
				attacksAgainstBot
					.filter((atk) => {
						const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
						const atkCard = atkOwner?.battlefield.find(
							(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
						);
						return Boolean(atkCard?.mustBeBlockedThisTurn);
					})
					.map((atk) => atk.attackerInstanceId)
			);
			if (
				!hasRestriction(state, b, 'blocksEachCombat') &&
				!b.mustBlockThisTurn &&
				!b.provokeMustBlockId &&
				lureAtkIds.size === 0
			) {
				continue;
			}

			const legalAtks = attacksAgainstBot.filter((atk) => {
				if (b.provokeMustBlockId && atk.attackerInstanceId !== b.provokeMustBlockId) return false;
				if (
					!b.provokeMustBlockId &&
					!hasRestriction(state, b, 'blocksEachCombat') &&
					!b.mustBlockThisTurn &&
					lureAtkIds.size > 0 &&
					!lureAtkIds.has(atk.attackerInstanceId)
				) {
					return false;
				}
				// --- End Track P15 + Track P16a ---
				const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
				const atkCard = atkOwner?.battlefield.find(
					(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
				);
				if (!atkCard) return false;
				if (!canBlock(state, b, atkCard)) return false;
				// --- Track P7 ---
				if (hasKeyword(atkCard, 'Menace', state) || getTimedMinBlockersRequired(state, atkCard) > 1) {
				// --- End Track P7 ---
					const alreadyAssigned = assignments.some(
						(a) => a.attackerInstanceId === atk.attackerInstanceId
					);
					if (!alreadyAssigned) return false;
				}
				return true;
			});
			if (legalAtks.length > 0) {
				const chosenAtk =
					legalAtks.find(
						(atk) => !assignments.some((a) => a.attackerInstanceId === atk.attackerInstanceId)
					) ?? legalAtks[0]!;
				usedBlockers.add(b.instanceId);
				assignments.push({
					blockerInstanceId: b.instanceId,
					attackerInstanceId: chosenAtk.attackerInstanceId
				});
			}
		}

		return assignments;
	});
}

export function validateDefenderBlockerAssignments(
	state: GameState,
	actor: PlayerGameState,
	assignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }>
):
	| { ok: true; blockerCountsByAttacker: Map<string, string[]>; combinedBlockTaxManaCost?: string }
	| { ok: false; error: string } {
	// --- Track P8 + Track P17a (CR 509.1a–d) ---
	const res = validateDefenderBlockersWithWave6(
		state,
		actor,
		assignments,
		getBlockerRestrictionReason,
		(combinedCost) => H().canPayOrAutoTap(actor, parseManaCost(combinedCost), state)
	);
	if (!res.ok) return { ok: false, error: res.error };
	// --- Track P16a (CR 509.1c): Enforce mustBeBlockedThisTurn (Lure) ---
	const lureAttackers = state.combat.attackers
		.filter((atk) => atk.defenderPlayerId === actor.playerId)
		.map((atk) => {
			const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
			const atkCard = atkOwner?.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
			);
			return atkCard?.mustBeBlockedThisTurn ? atkCard : undefined;
		})
		.filter((c): c is CardInstance => Boolean(c));
	if (lureAttackers.length > 0) {
		const assignedByBlocker = new Map<string, string>();
		for (const a of assignments) {
			assignedByBlocker.set(a.blockerInstanceId, a.attackerInstanceId);
		}
		for (const b of actor.battlefield) {
			if (b.phasedOut || b.tapped || !evaluatePermanent(state, b).isCreature) continue;
			if (hasRestriction(state, b, 'cantBlock') || isCantBlockThisTurn(state, b)) continue;
			const curTargetId = assignedByBlocker.get(b.instanceId);
			if (curTargetId && lureAttackers.some((la) => la.instanceId === curTargetId)) continue;
			if (b.provokeMustBlockId && curTargetId === b.provokeMustBlockId) continue;
			const blockableLure = lureAttackers.find(
				(la) =>
					canBlock(state, b, la) &&
					getBlockerRestrictionReason(state, b, la) === null &&
					(!(hasKeyword(la, 'Menace', state) || getTimedMinBlockersRequired(state, la) > 1) ||
						(res.blockerCountsByAttacker.get(la.instanceId)?.length ?? 0) >= 1)
			);
			if (blockableLure) {
				return {
					ok: false,
					error: `Blocking Requirement: ${b.card.name} must block ${blockableLure.card.name} if able (CR 509.1c).`
				};
			}
		}
	}
	const defenderAttackers = state.combat.attackers
		.filter((atk) => atk.defenderPlayerId === actor.playerId)
		.map((atk) => {
			const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
			return atkOwner?.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
			);
		})
		.filter((c): c is CardInstance => Boolean(c));
	if (defenderAttackers.length > 0) {
		const assignedBlockers = new Set(assignments.map((a) => a.blockerInstanceId));
		for (const b of actor.battlefield) {
			if (!b.mustBlockThisTurn || assignedBlockers.has(b.instanceId)) continue;
			if (b.phasedOut || b.tapped || !evaluatePermanent(state, b).isCreature) continue;
			if (hasRestriction(state, b, 'cantBlock') || isCantBlockThisTurn(state, b)) continue;
			const canBlockAny = defenderAttackers.some(
				(atk) =>
					canBlock(state, b, atk) &&
					(!(hasKeyword(atk, 'Menace', state) || getTimedMinBlockersRequired(state, atk) > 1) ||
						(res.blockerCountsByAttacker.get(atk.instanceId)?.length ?? 0) >= 1)
			);
			if (canBlockAny) {
				return {
					ok: false,
					error: `Blocking Requirement: ${b.card.name} must block this turn if able (CR 509.1c).`
				};
			}
		}
	}
	// --- End Track P16a ---
	return {
		ok: true,
		blockerCountsByAttacker: res.blockerCountsByAttacker,
		...(res.combinedBlockTaxManaCost
			? { combinedBlockTaxManaCost: res.combinedBlockTaxManaCost }
			: {})
	};
	// --- End Track P8 + Track P17a ---
}

export function applyValidatedDefenderBlockers(
	state: GameState,
	actor: PlayerGameState,
	assignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }>,
	blockerCountsByAttacker: Map<string, string[]>
): void {
	const actorId = actor.playerId;
	for (const atkEntry of state.combat.attackers) {
		if (atkEntry.defenderPlayerId === actorId) {
			atkEntry.blockerInstanceIds =
				blockerCountsByAttacker.get(atkEntry.attackerInstanceId) || [];
			if (atkEntry.blockerInstanceIds.length > 0) {
				atkEntry.wasBlocked = true;
			}
		}
	}
	// --- Track P18a: CR 702.22h Propagate blockers across Banding bands ---
	propagateBandingBlockers(state);
	// --- End Track P18a ---
	noteLayerInputsChanged(state);

	if (!state.combat.declaredBlockersPlayerIds) {
		state.combat.declaredBlockersPlayerIds = [];
	}
	if (!state.combat.declaredBlockersPlayerIds.includes(actorId)) {
		state.combat.declaredBlockersPlayerIds.push(actorId);
	}

	resetTriggerLoopTracking(state);
	if (assignments.length > 0) {
		addLog(
			state,
			'combat',
			`${actor.username} declared ${assignments.length} blocker(s).`,
			actorId
		);
		emitVfx(state, {
			kind: 'block_declare',
			sourceId: actorId,
			amount: assignments.length
		});
		emitEvent(state, {
			kind: 'BlockersDeclared',
			playerId: actorId,
			blocks: assignments.map((a) => ({
				blockerId: a.blockerInstanceId,
				attackerId: a.attackerInstanceId
			}))
		});
		// --- Track P13 (CR 701.54c): Ring Level 3 end-of-combat blocker sacrifice registration ---
		registerRingBlockedEndOfCombatSacrifice(state, assignments);
		// --- End Track P13 ---
	} else {
		addLog(state, 'combat', `${actor.username} declared no blockers.`, actorId);
	}
}

/**
 * Advances through any consecutive bot defenders in turn order during the declare_blockers
 * turn-based action (CR 509.1, 703.4j). Returns true if all attacked defenders have now
 * declared blockers, or false if an undecided human defender must declare blockers next.
 */
export function advanceBotBlockerDeclarations(state: GameState): boolean {
	if (!state.combat.declaredBlockersPlayerIds) {
		state.combat.declaredBlockersPlayerIds = [];
	}
	const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
	for (const defId of defendersInOrder) {
		if (state.combat.declaredBlockersPlayerIds.includes(defId)) continue;
		const defPlayer = state.players.find((p) => p.playerId === defId && !p.lost);
		if (!defPlayer) {
			state.combat.declaredBlockersPlayerIds.push(defId);
			continue;
		}
		if (!defPlayer.isBot) {
			state.combat.blockersDeclared = false;
			return false;
		}
		let assignments = chooseBotBlockAssignments(state, defPlayer);
		let validated = validateDefenderBlockerAssignments(state, defPlayer, assignments);
		while (!validated.ok && assignments.length > 0) {
			let removedIndex = -1;
			for (let i = assignments.length - 1; i >= 0; i--) {
				const candidate = assignments.filter((_, idx) => idx !== i);
				const check = validateDefenderBlockerAssignments(state, defPlayer, candidate);
				if (check.ok) {
					assignments = candidate;
					validated = check;
					removedIndex = i;
					break;
				}
			}
			if (validated.ok) break;
			for (let i = assignments.length - 1; i >= 0; i--) {
				const single = [assignments[i]!];
				const blocker = defPlayer.battlefield.find(
					(c) => c.instanceId === single[0]!.blockerInstanceId
				);
				const atkEntry = state.combat.attackers.find(
					(a) => a.attackerInstanceId === single[0]!.attackerInstanceId
				);
				const atkOwner = state.players.find((p) => p.playerId === atkEntry?.controllerId);
				const atkCard = atkOwner?.battlefield.find(
					(c) => c.instanceId === atkEntry?.attackerInstanceId
				);
				if (
					!blocker ||
					blocker.phasedOut ||
					blocker.tapped ||
					!evaluatePermanent(state, blocker).isCreature ||
					hasRestriction(state, blocker, 'cantBlock') ||
					!atkEntry ||
					atkEntry.defenderPlayerId !== defPlayer.playerId ||
					(atkCard && !canBlock(state, blocker, atkCard))
				) {
					removedIndex = i;
					break;
				}
			}
			if (removedIndex < 0) {
				removedIndex = assignments.length - 1;
			}
			assignments = assignments.filter((_, idx) => idx !== removedIndex);
			validated = validateDefenderBlockerAssignments(state, defPlayer, assignments);
		}
		if (!validated.ok) {
			// --- Track P8 (CR 509.1c): Use exact maximum-requirement solver assignment ---
			const solved = validateAndSolveDefenderBlockersP8(
				state,
				defPlayer,
				[],
				getBlockerRestrictionReason
			);
			if (solved.ok) {
				applyValidatedDefenderBlockers(
					state,
					defPlayer,
					[],
					solved.blockerCountsByAttacker
				);
			} else {
				const optValidated = validateDefenderBlockerAssignments(
					state,
					defPlayer,
					solved.bestLegalAssignment
				);
				if (optValidated.ok) {
					// --- Track P17a ---
					if (optValidated.combinedBlockTaxManaCost) {
						H().payManaWithAutoTap(defPlayer, parseManaCost(optValidated.combinedBlockTaxManaCost), state);
					}
					// --- End Track P17a ---
					applyValidatedDefenderBlockers(
						state,
						defPlayer,
						solved.bestLegalAssignment,
						optValidated.blockerCountsByAttacker
					);
				} else {
					addLog(state, 'rule', validated.error, defPlayer.playerId);
					applyValidatedDefenderBlockers(state, defPlayer, [], new Map());
				}
			}
		} else {
			// --- Track P17a ---
			if (validated.combinedBlockTaxManaCost) {
				H().payManaWithAutoTap(defPlayer, parseManaCost(validated.combinedBlockTaxManaCost), state);
			}
			// --- End Track P17a ---
			applyValidatedDefenderBlockers(
				state,
				defPlayer,
				assignments,
				validated.blockerCountsByAttacker
			);
		}
	}
	state.combat.blockersDeclared = true;
	return true;
}

export function findMandatoryAttackerViolation(
	state: GameState,
	actor: PlayerGameState,
	assignedIds: Set<string> = new Set(),
	currentAssignments: ReadonlyArray<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string | null;
		defenderBattleId?: string | null;
	}> = []
): string | null {
	return withStableLayerInputs(state, () => {
		const taxFreeOpponents = state.players.filter(
			(p) => p.playerId !== actor.playerId && !p.lost && getAttackTaxGeneric(state, p) === 0
		);
		if (taxFreeOpponents.length === 0) return null;

		for (const perm of actor.battlefield) {
			if (perm.phasedOut || !evaluatePermanent(state, perm).isCreature) continue;
			// --- Track P14 ---
			const isGoaded =
				getEffectiveGoaderPlayerIds(state, perm).length > 0 ||
				getWave10EffectiveGoaderIds(state, perm).length > 0;
			// --- End Track P14 ---
			// --- Track P12 ---
			const isEncoreObligated = Boolean(perm.encoreMustAttackPlayerId);
			// --- End Track P12 ---
			const mustAttackCtrlWave9 = getMustAttackAttachedControllerWave9(state, perm);
			const mustAttack =
				isGoaded ||
				isEncoreObligated ||
				Boolean(mustAttackCtrlWave9) ||
				hasWave10MustAttackDirective(state, perm) ||
				// --- Track P16a ---
				Boolean(perm.mustAttackThisTurn) ||
				// --- End Track P16a ---
				hasRestriction(state, perm, 'attacksEachCombat');
			if (mustAttack && mustAttackCtrlWave9 && assignedIds.has(perm.instanceId)) {
				const badAssign = currentAssignments.find(
					(a) =>
						a.attackerInstanceId === perm.instanceId &&
						(a.defenderPlayerId !== mustAttackCtrlWave9 ||
							Boolean(a.defenderPlaneswalkerId) ||
							Boolean(a.defenderBattleId))
				);
				const reqCtrl = state.players.find((p) => p.playerId === mustAttackCtrlWave9 && !p.lost);
				if (
					badAssign &&
					reqCtrl &&
					getAttackTaxGeneric(state, reqCtrl) === 0 &&
					getStaticAttackRestrictionReason(state, perm, reqCtrl.playerId) === null &&
					getWave10AttackRestrictionReason(state, perm, reqCtrl.playerId) === null &&
					!checkDefenderScopedAttackRestriction(state, perm, reqCtrl.playerId).restricted &&
					!computeDeclareAttackersTaxSummary(state, actor.playerId, [
						{ attackerId: perm.instanceId, defenderPlayerId: reqCtrl.playerId }
					]).hasTax
				) {
					return `${perm.card.name} must attack ${reqCtrl.username} this combat if able (CR 508.1d).`;
				}
			}
			if (mustAttack && !assignedIds.has(perm.instanceId)) {
				const canAttack =
					!perm.tapped &&
					(!perm.summoningSick || hasKeyword(perm, 'Haste', state) || canAttackIgnoringSummoningSicknessWave9(state, perm)) &&
					// --- Track P13 + Track P14 ---
					(!hasKeyword(perm, 'Defender', state) ||
						Boolean(perm.canAttackAsThoughNoDefenderThisTurn) ||
						creatureCanAttackDespiteDefender(state, perm)) &&
					// --- End Track P13 + Track P14 ---
					// --- Track P22d ---
					!hasRestriction(state, perm, 'cantAttack') &&
					!isCantAttackThisTurn(state, perm);
					// --- End Track P22d ---
				if (!canAttack) continue;

				// --- Track P8 (CR 508.1c–d): Check defender-specific restrictions, cantAttackAlone, and global caps ---
				const legalDefender = taxFreeOpponents.find((p) => {
					if (getStaticAttackRestrictionReason(state, perm, p.playerId) !== null) return false;
					if (getWave10AttackRestrictionReason(state, perm, p.playerId) !== null) return false;
					// --- Track P17a ---
					if (checkDefenderScopedAttackRestriction(state, perm, p.playerId).restricted) return false;
					if (
						computeDeclareAttackersTaxSummary(state, actor.playerId, [
							{ attackerId: perm.instanceId, defenderPlayerId: p.playerId }
						]).hasTax
					) {
						return false;
					}
					// --- End Track P17a ---
					if (currentAssignments.length > 0) {
						return (
							getGlobalAttackCapError(state, [
								...currentAssignments,
								{ attackerInstanceId: perm.instanceId, defenderPlayerId: p.playerId }
							]) === null
						);
					}
					return (
						getGlobalAttackCapError(state, [
							{ attackerInstanceId: perm.instanceId, defenderPlayerId: p.playerId }
						]) === null
					);
				});
				if (!legalDefender) continue;

				if (assignedIds.size === 0 && permanentCantAttackAlone(state, perm)) {
					const hasLegalPartner = actor.battlefield.some((other) => {
						if (
							other.instanceId === perm.instanceId ||
							other.phasedOut ||
							!evaluatePermanent(state, other).isCreature ||
							other.tapped ||
							(other.summoningSick && !hasKeyword(other, 'Haste', state) && !canAttackIgnoringSummoningSicknessWave9(state, other)) ||
							// --- Track P13 + Track P14 ---
							(hasKeyword(other, 'Defender', state) &&
								!other.canAttackAsThoughNoDefenderThisTurn &&
								!creatureCanAttackDespiteDefender(state, other)) ||
							// --- End Track P13 + Track P14 ---
							// --- Track P22d ---
							hasRestriction(state, other, 'cantAttack') ||
							isCantAttackThisTurn(state, other)
							// --- End Track P22d ---
						) {
							return false;
						}
						return taxFreeOpponents.some(
							(p) =>
								getStaticAttackRestrictionReason(state, other, p.playerId, 2) === null &&
								getWave10AttackRestrictionReason(state, other, p.playerId) === null &&
								getGlobalAttackCapError(state, [
									{
										attackerInstanceId: perm.instanceId,
										defenderPlayerId: legalDefender.playerId
									},
									{ attackerInstanceId: other.instanceId, defenderPlayerId: p.playerId }
								]) === null
						);
					});
					if (!hasLegalPartner) continue;
				}

				return `Strict Rules Violation: ${perm.card.name} ${isGoaded ? 'is Goaded and ' : ''}must attack this combat if able.`;
			}
		}
		return null;
	});
}

export function checkAnyCombatantHasFirstStrike(state: GameState): boolean {
	for (const atk of state.combat.attackers) {
		const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
		const atkCard = atkOwner?.battlefield.find((c) => c.instanceId === atk.attackerInstanceId);
		if (
			atkCard &&
			(hasKeyword(atkCard, 'First strike', state) || hasKeyword(atkCard, 'Double strike', state))
		) {
			return true;
		}
		const defPlayer = state.players.find((p) => p.playerId === atk.defenderPlayerId);
		for (const bId of atk.blockerInstanceIds) {
			const bCard = defPlayer?.battlefield.find((c) => c.instanceId === bId);
			if (
				bCard &&
				(hasKeyword(bCard, 'First strike', state) || hasKeyword(bCard, 'Double strike', state))
			) {
				return true;
			}
		}
	}
	return false;
}

const COMBAT_DAMAGE_ASSIGNMENT_HANDLER = 'combat_damage_assignment';

export function executeCombatDamageStep(
	state: GameState,
	isFirstStrikeStep: boolean,
	chosenDamage: Record<string, number> = {}
): boolean {
	if (!state.combat.dealtFirstStrikeDamageIds) {
		state.combat.dealtFirstStrikeDamageIds = [];
	}

	// CR 510.2: All combat damage in a step is assigned and dealt simultaneously.
	// Snapshot combatant characteristics BEFORE any Infect/Wither -1/-1 counters or damageMarked mutations apply!
	interface CombatantSnapshot {
		power: number;
		toughness: number;
		damageMarkedBefore: number;
		hasFS: boolean;
		hasDS: boolean;
		hasTrample: boolean;
		// --- Track P21 ---
		hasTrampleOverPlaneswalkers: boolean;
		// --- End Track P21 ---
		dealsNow: boolean;
		srcInfo: SourceDamageInfo;
	}
	const snapshots = new Map<string, CombatantSnapshot>();
	const recordSnapshot = (perm: CardInstance) => {
		if (snapshots.has(perm.instanceId)) return;
		const hasFS = hasKeyword(perm, 'First strike', state);
		const hasDS = hasKeyword(perm, 'Double strike', state);
		const alreadyDealtFS = state.combat.dealtFirstStrikeDamageIds!.includes(perm.instanceId);
		// CR 702.7c: In regular combat damage step, creatures that did NOT deal first-strike damage deal combat damage,
		// as do creatures that currently have Double strike.
		const dealsNow = isFirstStrikeStep ? hasFS || hasDS : hasDS || !alreadyDealtFS;
		const srcInfo = sourceDamageInfo(state, perm, perm.copiableCard ?? perm.card);
		// --- Track P11: CR 510.1a assign combat damage equal to toughness rather than power ---
		const toughnessVal = getCreatureToughness(perm, state);
		const rawStrikeAmount = creatureAssignsCombatDamageByToughness(state, perm)
			? Math.max(0, toughnessVal)
			: getCreaturePower(perm, state);
		// --- Track P16a: "assigns no combat damage this turn" ---
		const combatStrikeAmount = perm.assignsNoCombatDamageThisTurn ? 0 : rawStrikeAmount;
		// --- End Track P16a ---
		// --- End Track P11 ---
		// --- Track P21 (CR 702.19c–f): Trample & Trample over planeswalkers ---
		const trampleCaps = getTrampleCapabilities(perm, state, hasKeyword);
		// --- End Track P21 ---
		snapshots.set(perm.instanceId, {
			power: combatStrikeAmount,
			toughness: toughnessVal,
			damageMarkedBefore: perm.damageMarked,
			hasFS,
			hasDS,
			hasTrample: trampleCaps.hasTrample,
			hasTrampleOverPlaneswalkers: trampleCaps.hasTrampleOverPlaneswalkers,
			dealsNow: perm.assignsNoCombatDamageThisTurn ? false : dealsNow,
			srcInfo
		});
	};

	withStableLayerInputs(state, () => {
		for (const atkEntry of state.combat.attackers) {
			const atkPlayer = state.players.find((p) => p.playerId === atkEntry.controllerId);
			const defPlayer = state.players.find((p) => p.playerId === atkEntry.defenderPlayerId);
			if (!atkPlayer || !defPlayer) continue;
			const attacker = atkPlayer.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
			);
			if (attacker) recordSnapshot(attacker);
			for (const id of atkEntry.blockerInstanceIds) {
				const b = defPlayer.battlefield.find((c) => !c.phasedOut && c.instanceId === id);
				if (b) recordSnapshot(b);
			}
		}
	});

	type AttackerDamageAssignment =
		| { kind: 'none_pw_left' }
		| { kind: 'none_battle_left' }
		| { kind: 'none_blocked_left' }
		| { kind: 'planeswalker'; target: CardInstance; amount: number; mode: 'unblocked' | 'trample' }
		| { kind: 'battle'; target: CardInstance; amount: number; mode: 'unblocked' | 'trample' }
		| { kind: 'player'; target: PlayerGameState; amount: number; mode: 'unblocked' | 'trample' }
		| { kind: 'blocker'; target: CardInstance; amount: number };

	interface ScheduledCombatEntry {
		attacker: CardInstance;
		atkPlayer: PlayerGameState;
		defPlayer: PlayerGameState;
		atkSnap: CombatantSnapshot;
		blockers: CardInstance[];
		attackerAssignments: AttackerDamageAssignment[];
		blockerAssignments: Array<{
			blocker: CardInstance;
			bSnap: CombatantSnapshot;
			amount: number;
		}>;
	}

	// CR 510.1: First compute all combat damage assignments before dealing any damage (CR 510.2).
	const assignedDamageOnPerm = new Map<string, number>();
	// --- Track P21 (CR 702.19c): Cumulative loyalty damage assigned across attackers on each planeswalker ---
	const assignedDamageOnPlaneswalker = new Map<string, number>();
	// --- End Track P21 ---
	const assignedDeathtouchOnPerm = new Set<string>();
	const scheduledCombats: ScheduledCombatEntry[] = [];
	// --- Track P18a: Precompute multi-attacker blocking map for Banding / CR 510.1d & CR 702.22k ---
	const blockedAttackersByBlockerId = new Map<string, CardInstance[]>();
	const blockerRemainingDmg = new Map<string, number>();
	const blockerVisitIndex = new Map<string, number>();
	for (const atkEntry of state.combat.attackers) {
		const atkOwner = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const defOwner = state.players.find((p) => p.playerId === atkEntry.defenderPlayerId);
		if (!atkOwner || !defOwner) continue;
		const atkPerm = atkOwner.battlefield.find(
			(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
		);
		if (!atkPerm) continue;
		for (const blkId of atkEntry.blockerInstanceIds) {
			const blkPerm = defOwner.battlefield.find((c) => !c.phasedOut && c.instanceId === blkId);
			if (!blkPerm) continue;
			let list = blockedAttackersByBlockerId.get(blkId);
			if (!list) {
				list = [];
				blockedAttackersByBlockerId.set(blkId, list);
			}
			if (!list.includes(atkPerm)) {
				list.push(atkPerm);
			}
		}
	}
	// --- End Track P18a ---

	for (const atkEntry of state.combat.attackers) {
		const atkPlayer = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const defPlayer = state.players.find((p) => p.playerId === atkEntry.defenderPlayerId);
		if (!atkPlayer || !defPlayer) continue;

		const attacker = atkPlayer.battlefield.find(
			(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
		);
		if (!attacker) continue;

		const atkSnap = snapshots.get(attacker.instanceId)!;
		const attackerDealsNow = atkSnap.dealsNow;
		const atkPower = atkSnap.power;
		const atkDeathtouch = atkSnap.srcInfo.hasDeathtouch;
		const atkTrample = atkSnap.hasTrample;
		// --- Track P21 ---
		const atkTrampleOverPlaneswalkers = atkSnap.hasTrampleOverPlaneswalkers;
		// --- End Track P21 ---

		const blockers = atkEntry.blockerInstanceIds
			.map((id) => defPlayer.battlefield.find((c) => !c.phasedOut && c.instanceId === id))
			.filter((b): b is CardInstance => Boolean(b));

		// Check if all combat damage is prevented this turn (e.g., Fog)
		// --- Track P7 ---
		const combatDamagePrevented =
			!isDamageUnpreventable(state, true) &&
			(atkPlayer.preventAllCombatDamageThisTurn || defPlayer.preventAllCombatDamageThisTurn);
		// --- End Track P7 ---

		const attackerAssignments: AttackerDamageAssignment[] = [];
		if (attackerDealsNow && atkPower > 0 && !combatDamagePrevented) {
			let remainingDamage = atkPower;
			const attackingPlaneswalker = Boolean(atkEntry.defenderPlaneswalkerId);
			const defWalker =
				atkEntry.defenderPlaneswalkerId && atkEntry.defenderPlaneswalkerId !== 'removed'
					? defPlayer.battlefield.find(
							(c) =>
								!c.phasedOut &&
								c.instanceId === atkEntry.defenderPlaneswalkerId &&
								evaluatePermanent(state, c).isPlaneswalker
						)
					: undefined;
			// --- Track P15: CR 310.6 / CR 310.10 Battle combat damage assignment ---
			const attackingBattle = Boolean(atkEntry.defenderBattleId);
			const defBattleFound =
				atkEntry.defenderBattleId && atkEntry.defenderBattleId !== 'removed'
					? findPermanentOnBoard(state, atkEntry.defenderBattleId)
					: null;
			const defBattle =
				defBattleFound &&
				!defBattleFound.inst.phasedOut &&
				isPermanentBattle(state, defBattleFound.inst) &&
				defBattleFound.inst.protectorId === defPlayer.playerId
					? defBattleFound.inst
					: undefined;
			// --- End Track P15 ---

			// --- Track P14: CR 510.1c–d "assign its combat damage as though it weren't blocked" ---
			const atkSuperTrample =
				creatureMayAssignCombatDamageAsThoughUnblocked(state, attacker) &&
				(!attackingPlaneswalker || Boolean(defWalker) || atkTrampleOverPlaneswalkers);
			let assignAsThoughUnblocked = false;
			if (atkSuperTrample && (atkEntry.wasBlocked || blockers.length > 0)) {
				if (atkPlayer.isBot) {
					assignAsThoughUnblocked = true;
				} else {
					const unblockedKey = `${attacker.instanceId}:__unblocked`;
					const chosenFlag = chosenDamage[unblockedKey];
					if (chosenFlag === undefined) {
						const question = `Assign combat damage from ${attacker.card.name} (${remainingDamage}) as though it weren't blocked?`;
						enqueueChoicePrompt(state, {
							id: uid('prm', state),
							playerId: atkPlayer.playerId,
							kind: 'yesNo',
							purpose: 'generic',
							title: `Combat Damage — ${attacker.card.name}`,
							description: question,
							continuation: {
								kind: 'handler',
								name: COMBAT_DAMAGE_ASSIGNMENT_HANDLER,
								data: {
									isFirstStrikeStep,
									chosenDamage,
									key: unblockedKey
								}
							},
							choice: {
								kind: 'yesNo',
								question
							}
						});
						return true;
					}
					assignAsThoughUnblocked = chosenFlag === 1;
				}
			}
			// --- End Track P14 ---

			if ((!atkEntry.wasBlocked && blockers.length === 0) || assignAsThoughUnblocked) {
				// --- Track P21 (CR 702.19c–e): Trample over planeswalkers unblocked / PW-left split ---
				const pwSplit = attackingPlaneswalker
					? computePlaneswalkerTrampleSplit({
							remainingDamage,
							defWalker,
							attackingPlaneswalker,
							hasTrampleOverPlaneswalkers: atkTrampleOverPlaneswalkers,
							assignedDamageOnPlaneswalker
						})
					: null;
				if (pwSplit) {
					if (pwSplit.pwDamage > 0 && defWalker) {
						attackerAssignments.push({
							kind: 'planeswalker',
							target: defWalker,
							amount: pwSplit.pwDamage,
							mode: 'unblocked'
						});
					}
					if (pwSplit.playerDamage > 0) {
						attackerAssignments.push({
							kind: 'player',
							target: defPlayer,
							amount: pwSplit.playerDamage,
							mode: 'trample'
						});
					}
				} else if (defBattle) {
				// --- End Track P21 ---
					attackerAssignments.push({
						kind: 'battle',
						target: defBattle,
						amount: remainingDamage,
						mode: 'unblocked'
					});
				} else if (!attackingPlaneswalker && !attackingBattle) {
					attackerAssignments.push({
						kind: 'player',
						target: defPlayer,
						amount: remainingDamage,
						mode: 'unblocked'
					});
				} else if (attackingBattle) {
					attackerAssignments.push({ kind: 'none_battle_left' });
				} else {
					attackerAssignments.push({ kind: 'none_pw_left' });
				}
			} else if (atkEntry.wasBlocked && blockers.length === 0 && !atkTrample) {
				attackerAssignments.push({ kind: 'none_blocked_left' });
			} else {
				// CR 702.19f: A creature with Trample attacking a planeswalker/battle that left combat cannot assign excess
				// damage to the defending player; all damage must be assigned to its blockers (or 0 if none remain).
				// CR 702.19e: A creature with Trample over planeswalkers CAN assign damage to the defending player if the PW left combat.
				const canTrampleOver =
					atkTrample &&
					(!attackingPlaneswalker || Boolean(defWalker) || atkTrampleOverPlaneswalkers) &&
					(!attackingBattle || Boolean(defBattle));
				// --- Track P18a: CR 702.22j Defender divides attacker's combat damage if any blocker has Banding ---
				const defenderAssignsViaBanding =
					blockers.length > 0 &&
					blockers.some(
						(blk) => blk.controllerId === defPlayer.playerId && hasKeyword(blk, 'Banding', state)
					);
				const bandingPreferredBlockerId = defenderAssignsViaBanding
					? chooseBotBandingAttackerDamageTarget(state, blockers, remainingDamage, atkDeathtouch)
					: null;
				const atkDamageAssigner = defenderAssignsViaBanding ? defPlayer : atkPlayer;
				// --- End Track P18a ---
				let allPriorBlockersLethal = true;
				for (let i = 0; i < blockers.length; i++) {
					const b = blockers[i];
					const bSnap = snapshots.get(b.instanceId)!;
					const bTough = bSnap.toughness;
					const alreadyAssignedOrMarked =
						assignedDamageOnPerm.get(b.instanceId) ?? bSnap.damageMarkedBefore;
					const remTough = Math.max(0, bTough - alreadyAssignedOrMarked);
					const lethalNeeded =
						remTough === 0 || assignedDeathtouchOnPerm.has(b.instanceId)
							? 0
							: atkDeathtouch
								? 1
								: remTough;

					const isLastBlocker = i === blockers.length - 1;
					// --- Track P18a: CR 702.22j Defender-assigned combat damage absorbs trample & concentrates damage ---
					const autoDmg = defenderAssignsViaBanding
						? isLastBlocker
							? remainingDamage
							: b.instanceId === bandingPreferredBlockerId
								? remainingDamage
								: 0
						: isLastBlocker && (!canTrampleOver || !allPriorBlockersLethal)
							? remainingDamage
							: Math.min(remainingDamage, lethalNeeded);
					// --- End Track P18a ---

					let dmgToBlocker = autoDmg;
					// CR 702.19b / CR 702.22j: Human assigner divides combat damage among blockers.
					if (
						!atkDamageAssigner.isBot &&
						(blockers.length >= 2 || canTrampleOver) &&
						remainingDamage > 0
					) {
						const minDmg = isLastBlocker
							? canTrampleOver && allPriorBlockersLethal && remainingDamage > lethalNeeded
								? lethalNeeded
								: remainingDamage
							: 0;
						const maxDmg = remainingDamage;
						if (minDmg < maxDmg) {
							const key = `${attacker.instanceId}:${b.instanceId}`;
							const chosen = chosenDamage[key];
							if (chosen === undefined) {
								const reason = `Assign combat damage from ${attacker.card.name} (${remainingDamage} remaining) to blocker ${b.card.name} (${minDmg}–${maxDmg}; lethal is ${lethalNeeded}).`;
								enqueueChoicePrompt(state, {
									id: uid('prm', state),
									playerId: atkDamageAssigner.playerId,
									kind: 'chooseNumber',
									purpose: 'generic',
									title: `Combat Damage — ${attacker.card.name} → ${b.card.name}`,
									description: reason,
									continuation: {
										kind: 'handler',
										name: COMBAT_DAMAGE_ASSIGNMENT_HANDLER,
										data: {
											isFirstStrikeStep,
											chosenDamage,
											key
										}
									},
									choice: {
										kind: 'chooseNumber',
										min: minDmg,
										max: maxDmg,
										defaultNumber: Math.max(minDmg, Math.min(maxDmg, autoDmg)),
										reason
									}
								});
								return true;
							}
							dmgToBlocker = Math.max(minDmg, Math.min(maxDmg, chosen));
						}
					}

					if (dmgToBlocker < lethalNeeded) {
						allPriorBlockersLethal = false;
					}

					if (dmgToBlocker > 0) {
						assignedDamageOnPerm.set(b.instanceId, alreadyAssignedOrMarked + dmgToBlocker);
						if (atkDeathtouch) assignedDeathtouchOnPerm.add(b.instanceId);
						attackerAssignments.push({
							kind: 'blocker',
							target: b,
							amount: dmgToBlocker
						});
						remainingDamage -= dmgToBlocker;
					}
				}

				if (canTrampleOver && allPriorBlockersLethal && remainingDamage > 0) {
					// --- Track P21 (CR 702.19c–e): Trample over planeswalkers blocked carry-over ---
					const pwSplit = attackingPlaneswalker
						? computePlaneswalkerTrampleSplit({
								remainingDamage,
								defWalker,
								attackingPlaneswalker,
								hasTrampleOverPlaneswalkers: atkTrampleOverPlaneswalkers,
								assignedDamageOnPlaneswalker
							})
						: null;
					if (pwSplit) {
						if (pwSplit.pwDamage > 0 && defWalker) {
							attackerAssignments.push({
								kind: 'planeswalker',
								target: defWalker,
								amount: pwSplit.pwDamage,
								mode: 'trample'
							});
						}
						if (pwSplit.playerDamage > 0) {
							attackerAssignments.push({
								kind: 'player',
								target: defPlayer,
								amount: pwSplit.playerDamage,
								mode: 'trample'
							});
						}
					} else if (defBattle) {
					// --- End Track P21 ---
						attackerAssignments.push({
							kind: 'battle',
							target: defBattle,
							amount: remainingDamage,
							mode: 'trample'
						});
					} else if (!attackingPlaneswalker && !attackingBattle) {
						attackerAssignments.push({
							kind: 'player',
							target: defPlayer,
							amount: remainingDamage,
							mode: 'trample'
						});
					}
				}
			}
		}

		const blockerAssignments: ScheduledCombatEntry['blockerAssignments'] = [];
		if (!combatDamagePrevented) {
			for (const b of blockers) {
				const bSnap = snapshots.get(b.instanceId)!;
				const blockerDealsNow = bSnap.dealsNow;
				if (blockerDealsNow && bSnap.power > 0) {
					// --- Track P18a: CR 510.1d & CR 702.22k Divide blocker damage across multiple blocked attackers ---
					const blockedAtks = blockedAttackersByBlockerId.get(b.instanceId) ?? [attacker];
					if (blockedAtks.length <= 1) {
						blockerAssignments.push({ blocker: b, bSnap, amount: bSnap.power });
					} else {
						const remBlk = blockerRemainingDmg.get(b.instanceId) ?? bSnap.power;
						const visitIdx = blockerVisitIndex.get(b.instanceId) ?? 0;
						const isLastAtk = visitIdx >= blockedAtks.length - 1;
						const attackerAssignsViaBanding = blockedAtks.some(
							(a) => a.controllerId === atkPlayer.playerId && hasKeyword(a, 'Banding', state)
						);
						const blkAssigner = attackerAssignsViaBanding ? atkPlayer : defPlayer;
						let autoBlkDmg = 0;
						if (remBlk > 0) {
							if (isLastAtk) {
								autoBlkDmg = remBlk;
							} else if (attackerAssignsViaBanding) {
								const preferredAtkId = chooseBotBandingBlockerDamageTarget(
									state,
									blockedAtks,
									bSnap.power,
									bSnap.srcInfo.hasDeathtouch
								);
								autoBlkDmg = attacker.instanceId === preferredAtkId ? remBlk : 0;
							} else {
								const alreadyOnAtk =
									assignedDamageOnPerm.get(attacker.instanceId) ?? atkSnap.damageMarkedBefore;
								const remAtkTough = Math.max(0, atkSnap.toughness - alreadyOnAtk);
								const atkLethal =
									remAtkTough === 0 || assignedDeathtouchOnPerm.has(attacker.instanceId)
										? 0
										: bSnap.srcInfo.hasDeathtouch
											? 1
											: remAtkTough;
								autoBlkDmg = Math.min(remBlk, atkLethal);
							}
						}
						let dmgFromBlocker = autoBlkDmg;
						if (!blkAssigner.isBot && !isLastAtk && remBlk > 0) {
							const blkKey = `blk:${b.instanceId}:${attacker.instanceId}`;
							const chosenBlk = chosenDamage[blkKey];
							if (chosenBlk === undefined) {
								const reason = `Assign combat damage from blocker ${b.card.name} (${remBlk} remaining) to attacker ${attacker.card.name} (0–${remBlk}).`;
								enqueueChoicePrompt(state, {
									id: uid('prm', state),
									playerId: blkAssigner.playerId,
									kind: 'chooseNumber',
									purpose: 'generic',
									title: `Combat Damage — ${b.card.name} → ${attacker.card.name}`,
									description: reason,
									continuation: {
										kind: 'handler',
										name: COMBAT_DAMAGE_ASSIGNMENT_HANDLER,
										data: {
											isFirstStrikeStep,
											chosenDamage,
											key: blkKey
										}
									},
									choice: {
										kind: 'chooseNumber',
										min: 0,
										max: remBlk,
										defaultNumber: Math.max(0, Math.min(remBlk, autoBlkDmg)),
										reason
									}
								});
								return true;
							}
							dmgFromBlocker = Math.max(0, Math.min(remBlk, chosenBlk));
						}
						blockerRemainingDmg.set(b.instanceId, Math.max(0, remBlk - dmgFromBlocker));
						blockerVisitIndex.set(b.instanceId, visitIdx + 1);
						if (dmgFromBlocker > 0) {
							const alreadyOnAtk =
								assignedDamageOnPerm.get(attacker.instanceId) ?? atkSnap.damageMarkedBefore;
							assignedDamageOnPerm.set(attacker.instanceId, alreadyOnAtk + dmgFromBlocker);
							if (bSnap.srcInfo.hasDeathtouch) assignedDeathtouchOnPerm.add(attacker.instanceId);
							blockerAssignments.push({ blocker: b, bSnap, amount: dmgFromBlocker });
						}
					}
					// --- End Track P18a ---
				}
			}
		}

		scheduledCombats.push({
			attacker,
			atkPlayer,
			defPlayer,
			atkSnap,
			blockers,
			attackerAssignments,
			blockerAssignments
		});
	}

	// CR 510.2: Deal all assigned combat damage simultaneously through the unified damage pipeline.
	const combatDamagedPlayers = new Map<string, CardInstance[]>();
	for (const sched of scheduledCombats) {
		const { attacker, atkPlayer, defPlayer, atkSnap, blockers, attackerAssignments, blockerAssignments } =
			sched;
		if (isFirstStrikeStep) {
			if (atkSnap.dealsNow && !state.combat.dealtFirstStrikeDamageIds.includes(attacker.instanceId)) {
				state.combat.dealtFirstStrikeDamageIds.push(attacker.instanceId);
			}
			for (const b of blockers) {
				const bSnap = snapshots.get(b.instanceId);
				if (bSnap?.dealsNow && !state.combat.dealtFirstStrikeDamageIds.includes(b.instanceId)) {
					state.combat.dealtFirstStrikeDamageIds.push(b.instanceId);
				}
			}
		}
		const atkInfect = atkSnap.srcInfo.hasInfect;
		const atkLifelink = atkSnap.srcInfo.hasLifelink;
		let totalDealtByAttacker = 0;

		for (const asgn of attackerAssignments) {
			if (asgn.kind === 'none_pw_left') {
				// CR 506.4c / 510.1b / 702.19f: An unblocked creature whose attacked planeswalker left combat deals no combat damage.
				addLog(
					state,
					'combat',
					`${attacker.card.name} was attacking a planeswalker that left combat, so it deals no combat damage (CR 506.4c, 510.1b).`,
					atkPlayer.playerId
				);
			} else if (asgn.kind === 'none_battle_left') {
				// CR 506.4c / 510.1b: An unblocked creature whose attacked battle left combat deals no combat damage.
				addLog(
					state,
					'combat',
					`${attacker.card.name} was attacking a battle that left combat, so it deals no combat damage (CR 506.4c, 510.1b).`,
					atkPlayer.playerId
				);
			} else if (asgn.kind === 'none_blocked_left') {
				// CR 509.1h / 510.1c: An attacking creature that became blocked remains blocked even if all blockers
				// left the battlefield before combat damage. Without Trample, it assigns 0 combat damage!
				addLog(
					state,
					'combat',
					`${attacker.card.name} was blocked (its blocker left combat) and does not have Trample, so it deals no combat damage (CR 510.1c).`,
					atkPlayer.playerId
				);
			} else if (asgn.kind === 'planeswalker' || asgn.kind === 'battle') {
				const isBattleTarget = asgn.kind === 'battle';
				const counterLabel = isBattleTarget ? 'Defense' : 'Loyalty';
				const dealt = dealDamageToPermanent(
					state,
					asgn.target,
					asgn.amount,
					attacker.instanceId,
					atkSnap.srcInfo,
					{
						combat: true,
						actorId: atkPlayer.playerId,
						vfxLabel:
							asgn.mode === 'trample'
								? `Trample -${asgn.amount} ${counterLabel}`
								: `-${asgn.amount} ${counterLabel}`
					}
				);
				totalDealtByAttacker += dealt;
				if (dealt > 0) {
					addLog(
						state,
						'combat',
						asgn.mode === 'trample'
							? `${attacker.card.name} trampled over for ${dealt} combat damage to ${asgn.target.card.name}!`
							: `${attacker.card.name} dealt ${dealt} unblocked combat damage to ${asgn.target.card.name}.`,
						atkPlayer.playerId
					);
				}
			} else if (asgn.kind === 'blocker') {
				const dealt = dealDamageToPermanent(
					state,
					asgn.target,
					asgn.amount,
					attacker.instanceId,
					atkSnap.srcInfo,
					{
						combat: true,
						actorId: atkPlayer.playerId
					}
				);
				totalDealtByAttacker += dealt;
			} else if (asgn.kind === 'player') {
				const dealt = dealDamageToPlayer(
					state,
					asgn.target,
					asgn.amount,
					attacker.instanceId,
					atkSnap.srcInfo,
					{
						combat: true,
						vfxSourceId: attacker.instanceId,
						vfxLabel:
							asgn.mode === 'trample'
								? atkInfect
									? `Trample +${asgn.amount} Poison`
									: `Trample -${asgn.amount}`
								: atkInfect
									? `+${asgn.amount} Poison`
									: `-${asgn.amount}`
					}
				);
				totalDealtByAttacker += dealt;
				if (dealt > 0) {
					// --- Track P15: Record combat damage for Prowl, Freerunning, Ingest, & Cipher ---
					recordCombatDamagePlayerWave5(state, attacker, asgn.target);
					recordCombatDamageToPlayerWave10(state, attacker, asgn.target, dealt);
					// --- End Track P15 ---
					const damagedAttackers = combatDamagedPlayers.get(asgn.target.playerId);
					if (!damagedAttackers) {
						combatDamagedPlayers.set(asgn.target.playerId, [attacker]);
					} else if (!damagedAttackers.some((c) => c.instanceId === attacker.instanceId)) {
						damagedAttackers.push(attacker);
					}
					// Track Commander Combat Damage (CR 903.10a)
					if (attacker.isCommander) {
						defPlayer.commanderDamageTaken[attacker.instanceId] =
							(defPlayer.commanderDamageTaken[attacker.instanceId] || 0) + dealt;
					}
					if (asgn.mode === 'trample') {
						addLog(
							state,
							'combat',
							`${attacker.card.name} trampled over for ${dealt} ${atkInfect ? 'Infect (Poison) ' : ''}combat damage to ${defPlayer.username}!`,
							atkPlayer.playerId
						);
					} else if (attacker.isCommander) {
						addLog(
							state,
							'combat',
							`Commander ${attacker.card.name} dealt ${dealt} combat damage to ${defPlayer.username} (Total: ${defPlayer.commanderDamageTaken[attacker.instanceId]}/${state.rules.commanderDamageLethal || '∞'}).`,
							atkPlayer.playerId
						);
					} else {
						addLog(
							state,
							'combat',
							`${attacker.card.name} dealt ${dealt} unblocked ${atkInfect ? 'Infect (Poison) ' : ''}combat damage to ${defPlayer.username}.`,
							atkPlayer.playerId
						);
					}
				}
			}
		}

		if (atkLifelink && totalDealtByAttacker > 0) {
			const lifeBefore = atkPlayer.life;
			applyLifelinkGain(state, atkPlayer, totalDealtByAttacker);
			if (atkPlayer.life > lifeBefore) {
				emitVfx(state, {
					kind: 'heal',
					targetId: atkPlayer.playerId,
					amount: totalDealtByAttacker,
					label: `+${totalDealtByAttacker} Lifelink`
				});
			}
		}

		for (const bAsgn of blockerAssignments) {
			const dealtByBlocker = dealDamageToPermanent(
				state,
				attacker,
				bAsgn.amount,
				bAsgn.blocker.instanceId,
				bAsgn.bSnap.srcInfo,
				{
					combat: true,
					actorId: defPlayer.playerId
				}
			);
			if (bAsgn.bSnap.srcInfo.hasLifelink && dealtByBlocker > 0) {
				applyLifelinkGain(state, defPlayer, dealtByBlocker);
			}
		}
	}

	// CR 603.2c: Emit one batch event per player dealt combat damage in this step, before SBAs run.
	for (const [damagedPlayerId, attackers] of combatDamagedPlayers) {
		emitEvent(state, {
			kind: 'CombatDamageBatchPlayer',
			damagedPlayerId,
			attackers
		});
		// CR 726.2: Inherent triggered ability controlled by the monarch at trigger time:
		// "Whenever a creature deals combat damage to the monarch, its controller becomes the monarch."
		if (state.monarchPlayerId === damagedPlayerId) {
			const monarchPlayer = state.players.find((p) => p.playerId === damagedPlayerId && !p.lost);
			if (monarchPlayer) {
				for (const atk of attackers) {
					const newMonarchPlayerId = atk.controllerId || atk.ownerId;
					H().pushMonarchInherentTrigger(
						state,
						monarchPlayer,
						{ kind: 'monarchCombatDamage', newMonarchPlayerId },
						'The Monarch (Combat Damage)',
						'Whenever a creature deals combat damage to the monarch, its controller becomes the monarch.'
					);
				}
			}
		}
		// --- Track P13 (CR 701.54c Level 4 & CR 725.2): Ring-bearer combat damage & Initiative steal ---
		for (const atk of attackers) {
			pushRingCombatDamageTriggers(state, atk);
		}
		if (state.initiativePlayerId === damagedPlayerId) {
			const seenControllerIds = new Set<string>();
			for (const atk of attackers) {
				const atkCtrlId = atk.controllerId || atk.ownerId;
				if (seenControllerIds.has(atkCtrlId)) continue;
				seenControllerIds.add(atkCtrlId);
				pushInitiativeCombatDamageTrigger(state, damagedPlayerId, atkCtrlId);
			}
		}
		// --- End Track P13 ---
	}

	if (isFirstStrikeStep) {
		state.combat.damageDealtFirstStrike = true;
	} else {
		state.combat.damageDealtNormal = true;
	}
	return false;
}

registerPromptHandler(COMBAT_DAMAGE_ASSIGNMENT_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const isFirstStrikeStep = Boolean(data?.isFirstStrikeStep);
	const prevChosen =
		data?.chosenDamage && typeof data.chosenDamage === 'object'
			? (data.chosenDamage as Record<string, number>)
			: {};
	const key = typeof data?.key === 'string' ? data.key : '';
	// --- Track P14: support yesNo answer for super-trample choice ---
	const n =
		answer.kind === 'chooseNumber'
			? answer.n
			: answer.kind === 'yesNo'
				? answer.yes
					? 1
					: 0
				: 0;
	// --- End Track P14 ---
	const nextChosen: Record<string, number> = key ? { ...prevChosen, [key]: n } : { ...prevChosen };

	let paused = false;
	withTriggersDeferred(state, () => {
		paused = executeCombatDamageStep(state, isFirstStrikeStep, nextChosen);
		if (!paused && !hasBlockingReplacementOrCommanderPrompt(state)) {
			H().checkStateBasedActions(state);
		}
	});
	if (paused || state.status === 'finished') return;
	if (hasBlockingReplacementOrCommanderPrompt(state)) {
		state.pendingProcedure = {
			kind: 'combat_damage_step',
			phase: 'after_damage',
			isFirstStrikeStep
		};
		return;
	}
	H().finishCombatDamagePhase(state);
});

export interface CombatAttackerForecast {
	attackerInstanceId: string;
	attackerName: string;
	controllerId: string;
	defenderPlayerId: string;
	defenderName: string;
	defenderPlaneswalkerId: string | null;
	defenderPlaneswalkerName: string | null;
	power: number;
	toughness: number;
	isBlocked: boolean;
	blockerIds: string[];
	blockerNames: string[];
	damageToDefender: number;
	poisonToDefender: number;
	commanderDamageToDefender: number;
	attackerDies: boolean;
}

export interface CombatBlockerForecast {
	blockerInstanceId: string;
	blockerName: string;
	blockingAttackerId: string;
	blockingAttackerName: string;
	blockerDies: boolean;
}

export interface PlayerIncomingForecast {
	playerId: string;
	username: string;
	totalLifeLoss: number;
	projectedLife: number;
	totalPoisonGain: number;
	projectedPoison: number;
	commanderDamageById: Record<string, number>;
	unblockedCount: number;
	blockedCount: number;
	trampleThroughDamage: number;
	isLethal: boolean;
	lethalReason: string | null;
}

export interface PlaneswalkerIncomingForecast {
	instanceId: string;
	name: string;
	controllerId: string;
	loyaltyLoss: number;
	currentLoyalty: number;
	projectedLoyalty: number;
	willDie: boolean;
}

export interface CombatDamageForecast {
	active: boolean;
	attackerSummaries: Record<string, CombatAttackerForecast>;
	blockerSummaries: Record<string, CombatBlockerForecast>;
	playerIncoming: Record<string, PlayerIncomingForecast>;
	planeswalkerIncoming: Record<string, PlaneswalkerIncomingForecast>;
	totalLifeGainByPlayer: Record<string, number>;
}

export function computeCombatDamageForecast(
	state: GameState,
	draftAttackers: Record<string, string | { defenderPlayerId: string; defenderPlaneswalkerId?: string | null }> = {},
	draftBlockers: Record<string, string> = {}
): CombatDamageForecast {
	const attackerSummaries: Record<string, CombatAttackerForecast> = {};
	const blockerSummaries: Record<string, CombatBlockerForecast> = {};
	const playerIncoming: Record<string, PlayerIncomingForecast> = {};
	const planeswalkerIncoming: Record<string, PlaneswalkerIncomingForecast> = {};
	const totalLifeGainByPlayer: Record<string, number> = {};

	for (const p of state.players) {
		playerIncoming[p.playerId] = {
			playerId: p.playerId,
			username: p.username,
			totalLifeLoss: 0,
			projectedLife: p.life,
			totalPoisonGain: 0,
			projectedPoison: p.poison,
			commanderDamageById: { ...p.commanderDamageTaken },
			unblockedCount: 0,
			blockedCount: 0,
			trampleThroughDamage: 0,
			isLethal: false,
			lethalReason: null
		};
		totalLifeGainByPlayer[p.playerId] = 0;
	}

	// Build unified attacker entries from committed state.combat.attackers or draftAttackers
	const rawAttackers: Array<{
		attackerInstanceId: string;
		controllerId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId: string | null;
		defenderBattleId: string | null;
		blockerInstanceIds: string[];
		wasBlocked: boolean;
	}> = [];

	if (state.combat.active && state.combat.attackers.length > 0) {
		for (const a of state.combat.attackers) {
			const mergedBlockers = [...a.blockerInstanceIds];
			for (const [blkId, atkId] of Object.entries(draftBlockers)) {
				if (atkId === a.attackerInstanceId && !mergedBlockers.includes(blkId)) {
					mergedBlockers.push(blkId);
				}
			}
			rawAttackers.push({
				attackerInstanceId: a.attackerInstanceId,
				controllerId: a.controllerId,
				defenderPlayerId: a.defenderPlayerId,
				defenderPlaneswalkerId: a.defenderPlaneswalkerId || null,
				defenderBattleId: a.defenderBattleId || null,
				blockerInstanceIds: mergedBlockers,
				wasBlocked: Boolean(a.wasBlocked) || mergedBlockers.length > 0
			});
		}
	} else if (state.phase === 'declare_attackers') {
		const activePlayer = state.players[state.activePlayerIndex];
		for (const [atkId, targetSpec] of Object.entries(draftAttackers)) {
			const defPlayerId =
				typeof targetSpec === 'string' ? targetSpec : targetSpec.defenderPlayerId;
			const defWalkerId =
				typeof targetSpec === 'string' ? null : targetSpec.defenderPlaneswalkerId || null;
			rawAttackers.push({
				attackerInstanceId: atkId,
				controllerId: activePlayer?.playerId || '',
				defenderPlayerId: defPlayerId,
				defenderPlaneswalkerId: defWalkerId,
				defenderBattleId: null,
				blockerInstanceIds: [],
				wasBlocked: false
			});
		}
	}

	if (rawAttackers.length === 0) {
		return {
			active: false,
			attackerSummaries,
			blockerSummaries,
			playerIncoming,
			planeswalkerIncoming,
			totalLifeGainByPlayer
		};
	}

	for (const atk of rawAttackers) {
		const atkFound = findPermanentOnBoard(state, atk.attackerInstanceId);
		if (!atkFound) continue;
		const atkCard = atkFound.inst;
		const defPlayer = state.players.find((p) => p.playerId === atk.defenderPlayerId);
		const attackingPlaneswalker = Boolean(atk.defenderPlaneswalkerId);
		const attackingBattle = Boolean(atk.defenderBattleId);
		const defBattleFound =
			atk.defenderBattleId && atk.defenderBattleId !== 'removed'
				? findPermanentOnBoard(state, atk.defenderBattleId)
				: null;
		const defBattle =
			defBattleFound &&
			!defBattleFound.inst.phasedOut &&
			isPermanentBattle(state, defBattleFound.inst) &&
			defBattleFound.inst.protectorId === atk.defenderPlayerId
				? defBattleFound.inst
				: null;
		const defWalkerFound =
			atk.defenderPlaneswalkerId && atk.defenderPlaneswalkerId !== 'removed'
				? findPermanentOnBoard(state, atk.defenderPlaneswalkerId)
				: null;
		const defWalker =
			defWalkerFound &&
			defWalkerFound.controller.playerId === atk.defenderPlayerId &&
			!defWalkerFound.inst.phasedOut &&
			evaluatePermanent(state, defWalkerFound.inst).isPlaneswalker
				? defWalkerFound.inst
				: null;

		const atkPower = Math.max(0, getCreaturePower(atkCard, state));
		const atkMaxTough = getCreatureToughness(atkCard, state);
		const atkRemTough = Math.max(0, atkMaxTough - atkCard.damageMarked);
		const atkFirstStrike = hasKeyword(atkCard, 'First strike', state);
		const atkDoubleStrike = hasKeyword(atkCard, 'Double strike', state);
		const atkDeathtouch = hasKeyword(atkCard, 'Deathtouch', state);
		// --- Track P21 (CR 702.19c–f): Trample & Trample over planeswalkers forecast ---
		const atkTrampleCaps = getTrampleCapabilities(atkCard, state, hasKeyword);
		const atkTrample = atkTrampleCaps.hasTrample;
		const atkTrampleOverPw = atkTrampleCaps.hasTrampleOverPlaneswalkers;
		// --- End Track P21 ---
		const atkInfect = hasKeyword(atkCard, 'Infect', state);
		// --- Track P9 ---
		const atkToxic = sumPermanentToxic(state, atkCard);
		// --- End Track P9 ---
		const atkLifelink = hasKeyword(atkCard, 'Lifelink', state);
		const atkIndestructible = hasKeyword(atkCard, 'Indestructible', state);

		const blockers: CardInstance[] = [];
		for (const bId of atk.blockerInstanceIds) {
			const bFound = findPermanentOnBoard(state, bId);
			if (bFound) blockers.push(bFound.inst);
		}

		const isBlocked = atk.wasBlocked || blockers.length > 0;
		const strikesRemaining = state.combat.damageDealtNormal
			? 0
			: atkDoubleStrike
				? state.combat.damageDealtFirstStrike
					? 1
					: 2
				: state.combat.damageDealtFirstStrike && atkFirstStrike && !atkDoubleStrike
					? 0
					: 1;

		let damageToDefender = 0;
		let poisonToDefender = 0;
		let commanderDamageToDefender = 0;
		let attackerDies = false;

		if (!isBlocked) {
			const rawDmg = atkPower * strikesRemaining;
			if (defWalker) {
				if (!planeswalkerIncoming[defWalker.instanceId]) {
					planeswalkerIncoming[defWalker.instanceId] = {
						instanceId: defWalker.instanceId,
						name: defWalker.card.name,
						controllerId: defWalker.controllerId,
						loyaltyLoss: 0,
						currentLoyalty: defWalker.counters.loyalty,
						projectedLoyalty: defWalker.counters.loyalty,
						willDie: false
					};
				}
				const pw = planeswalkerIncoming[defWalker.instanceId];
				const pwDmg = atkTrampleOverPw
					? Math.min(rawDmg, Math.max(0, pw.currentLoyalty - pw.loyaltyLoss))
					: rawDmg;
				const carryToPlayer = atkTrampleOverPw ? Math.max(0, rawDmg - pwDmg) : 0;
				damageToDefender = rawDmg;
				pw.loyaltyLoss += pwDmg;
				pw.projectedLoyalty = Math.max(0, pw.currentLoyalty - pw.loyaltyLoss);
				pw.willDie = pw.projectedLoyalty <= 0;
				if (carryToPlayer > 0 && defPlayer && !defPlayer.lifeTotalCannotChangeThisTurn) {
					const inc = playerIncoming[defPlayer.playerId];
					inc.trampleThroughDamage += carryToPlayer;
					inc.totalLifeLoss += carryToPlayer;
				}
			} else if (defBattle) {
				damageToDefender = rawDmg;
			} else if (defPlayer && !attackingPlaneswalker && !attackingBattle) {
				const inc = playerIncoming[defPlayer.playerId];
				inc.unblockedCount += 1;
				if (atkInfect) {
					poisonToDefender = rawDmg;
					inc.totalPoisonGain += rawDmg;
				} else if (!defPlayer.lifeTotalCannotChangeThisTurn) {
					damageToDefender = rawDmg;
					inc.totalLifeLoss += rawDmg;
					if (atkCard.isCommander) {
						commanderDamageToDefender = rawDmg;
						inc.commanderDamageById[atkCard.instanceId] =
							(inc.commanderDamageById[atkCard.instanceId] || 0) + rawDmg;
					}
				}
				// --- Track P9 ---
				if (atkToxic > 0 && rawDmg > 0) {
					const toxicPoison = atkToxic * strikesRemaining;
					poisonToDefender += toxicPoison;
					inc.totalPoisonGain += toxicPoison;
				}
				// --- End Track P9 ---
			}
			if (atkLifelink && rawDmg > 0) {
				totalLifeGainByPlayer[atk.controllerId] =
					(totalLifeGainByPlayer[atk.controllerId] || 0) + rawDmg;
			}
		} else {
			// Blocked attacker (CR 509.1h / 510.1c)
			if (defPlayer && !defWalker && !defBattle) {
				playerIncoming[defPlayer.playerId].blockedCount += 1;
			}
			let totalAtkDmgPool = atkPower * strikesRemaining;
			let totalBlkDmgToAtk = 0;
			let anyBlockerDeathtouch = false;

			for (const blk of blockers) {
				const blkPower = Math.max(0, getCreaturePower(blk, state));
				const blkRemTough = Math.max(0, getCreatureToughness(blk, state) - blk.damageMarked);
				const blkIndestructible = hasKeyword(blk, 'Indestructible', state);
				const blkDeathtouch = hasKeyword(blk, 'Deathtouch', state);
				const blkFirstStrike =
					hasKeyword(blk, 'First strike', state) || hasKeyword(blk, 'Double strike', state);
				const blkDoubleStrike = hasKeyword(blk, 'Double strike', state);
				const blkLifelink = hasKeyword(blk, 'Lifelink', state);

				const lethalNeeded =
					atkDeathtouch && !blkIndestructible ? Math.min(1, blkRemTough) : blkRemTough;
				const assignedToBlk = Math.min(totalAtkDmgPool, Math.max(0, lethalNeeded));
				totalAtkDmgPool -= assignedToBlk;

				const killedInFirstStrike =
					(atkFirstStrike || atkDoubleStrike) &&
					!blkFirstStrike &&
					atkPower >= lethalNeeded &&
					(!blkIndestructible || atkInfect);
				const blkDies =
					assignedToBlk >= lethalNeeded && (!blkIndestructible || atkInfect) && lethalNeeded > 0;

				blockerSummaries[blk.instanceId] = {
					blockerInstanceId: blk.instanceId,
					blockerName: blk.card.name,
					blockingAttackerId: atkCard.instanceId,
					blockingAttackerName: atkCard.card.name,
					blockerDies: blkDies
				};

				if (!killedInFirstStrike) {
					const blkStrikes = blkDoubleStrike ? 2 : 1;
					const dmgDealtByBlk = blkPower * blkStrikes;
					totalBlkDmgToAtk += dmgDealtByBlk;
					if (blkDeathtouch && dmgDealtByBlk > 0) anyBlockerDeathtouch = true;
					if (blkLifelink && dmgDealtByBlk > 0) {
						totalLifeGainByPlayer[blk.controllerId] =
							(totalLifeGainByPlayer[blk.controllerId] || 0) + dmgDealtByBlk;
					}
				}
			}

			attackerDies =
				!atkIndestructible &&
				(totalBlkDmgToAtk >= atkRemTough || (anyBlockerDeathtouch && totalBlkDmgToAtk > 0));

			// Trample excess damage over to defending player / planeswalker!
			if (atkTrample && totalAtkDmgPool > 0) {
				const trampleDmg = totalAtkDmgPool;
				if (defWalker) {
					if (!planeswalkerIncoming[defWalker.instanceId]) {
						planeswalkerIncoming[defWalker.instanceId] = {
							instanceId: defWalker.instanceId,
							name: defWalker.card.name,
							controllerId: defWalker.controllerId,
							loyaltyLoss: 0,
							currentLoyalty: defWalker.counters.loyalty,
							projectedLoyalty: defWalker.counters.loyalty,
							willDie: false
						};
					}
					const pw = planeswalkerIncoming[defWalker.instanceId];
					const pwDmg = atkTrampleOverPw
						? Math.min(trampleDmg, Math.max(0, pw.currentLoyalty - pw.loyaltyLoss))
						: trampleDmg;
					const carryToPlayer = atkTrampleOverPw ? Math.max(0, trampleDmg - pwDmg) : 0;
					damageToDefender = trampleDmg;
					pw.loyaltyLoss += pwDmg;
					pw.projectedLoyalty = Math.max(0, pw.currentLoyalty - pw.loyaltyLoss);
					pw.willDie = pw.projectedLoyalty <= 0;
					if (carryToPlayer > 0 && defPlayer && !defPlayer.lifeTotalCannotChangeThisTurn) {
						const inc = playerIncoming[defPlayer.playerId];
						inc.trampleThroughDamage += carryToPlayer;
						inc.totalLifeLoss += carryToPlayer;
					}
				} else if (defBattle) {
					damageToDefender = trampleDmg;
				} else if (defPlayer && !attackingPlaneswalker && !attackingBattle) {
					const inc = playerIncoming[defPlayer.playerId];
					inc.trampleThroughDamage += trampleDmg;
					if (atkInfect) {
						poisonToDefender = trampleDmg;
						inc.totalPoisonGain += trampleDmg;
					} else if (!defPlayer.lifeTotalCannotChangeThisTurn) {
						damageToDefender = trampleDmg;
						inc.totalLifeLoss += trampleDmg;
						if (atkCard.isCommander) {
							commanderDamageToDefender = trampleDmg;
							inc.commanderDamageById[atkCard.instanceId] =
								(inc.commanderDamageById[atkCard.instanceId] || 0) + trampleDmg;
						}
					}
					// --- Track P9 ---
					if (atkToxic > 0 && trampleDmg > 0) {
						const strikesReachingPlayer =
							strikesRemaining === 2 && atkPower > atkPower * strikesRemaining - trampleDmg ? 2 : 1;
						const toxicPoison = atkToxic * strikesReachingPlayer;
						poisonToDefender += toxicPoison;
						inc.totalPoisonGain += toxicPoison;
					}
					// --- End Track P9 ---
				}
			}

			if (atkLifelink && atkPower * strikesRemaining > 0 && blockers.length > 0) {
				totalLifeGainByPlayer[atk.controllerId] =
					(totalLifeGainByPlayer[atk.controllerId] || 0) + atkPower * strikesRemaining;
			}
		}

		attackerSummaries[atkCard.instanceId] = {
			attackerInstanceId: atkCard.instanceId,
			attackerName: atkCard.card.name,
			controllerId: atk.controllerId,
			defenderPlayerId: atk.defenderPlayerId,
			defenderName: defPlayer?.username || 'Opponent',
			defenderPlaneswalkerId: defWalker?.instanceId || null,
			defenderPlaneswalkerName: defWalker?.card.name || null,
			power: atkPower,
			toughness: atkRemTough,
			isBlocked,
			blockerIds: blockers.map((b) => b.instanceId),
			blockerNames: blockers.map((b) => b.card.name),
			damageToDefender,
			poisonToDefender,
			commanderDamageToDefender,
			attackerDies
		};
	}

	// Finalize player projections & lethal checks
	for (const p of state.players) {
		const inc = playerIncoming[p.playerId];
		const netGain = totalLifeGainByPlayer[p.playerId] || 0;
		inc.projectedLife = p.life - inc.totalLifeLoss + netGain;
		inc.projectedPoison = p.poison + inc.totalPoisonGain;

		const cmdLethalThreshold = state.rules.commanderDamageLethal || 21;
		const lethalCmdEntry = Object.entries(inc.commanderDamageById).find(
			([, dmg]) => cmdLethalThreshold > 0 && dmg >= cmdLethalThreshold
		);

		if (inc.projectedPoison >= 10) {
			inc.isLethal = true;
			inc.lethalReason = `${inc.projectedPoison} Poison (Lethal at 10)`;
		} else if (lethalCmdEntry) {
			inc.isLethal = true;
			inc.lethalReason = `${lethalCmdEntry[1]} Commander Damage (Lethal at ${cmdLethalThreshold})`;
		} else if (inc.projectedLife <= 0 && inc.totalLifeLoss > 0) {
			inc.isLethal = true;
			inc.lethalReason = `Life drops to ${inc.projectedLife}`;
		}
	}

	return {
		active: true,
		attackerSummaries,
		blockerSummaries,
		playerIncoming,
		planeswalkerIncoming,
		totalLifeGainByPlayer
	};
}
