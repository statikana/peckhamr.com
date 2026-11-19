/**
 * Wave 10 runtime execution for:
 * - Multiplayer sequential loops (`forEachPlayerLoop`: eachOpponent, eachPlayer, eachOtherPlayer,
 *   turnOrderStartingWithYou, turnOrderStartingWithNextOpponent, chooseOpponent, chooseRandomOpponent)
 * - Punishers & opponent-choice splits (`punisherChoice`: unlessCost, mayFirst, repeatCount,
 *   Coin of Fate / Deliver Unto Evil / Tasigur splits)
 * - Type-partition sacrifice (`partitionKeepByTypes`: Cataclysmic Gearhulk, Tragic Arrogance,
 *   Liliana -9, Archfiend of Depravity, Planetary Annihilation, Promise of Loyalty)
 * - Wave 10 ObjectFilter predicates (`greatestStatAmongControlled`, `leastStatAmongControlled`,
 *   `sameNameAsTarget`, `isColored`, `notEnteredThisTurn`, `controllerDealtCombatDamageBySelfThisTurn`,
 *   `controllerOfTargetIndex`, `sharesCardTypeWithBinding`, `createdWithSelf`, `basePowerOrToughness`)
 * - Wave 10 Amounts & Conditions (`opponentsControllingMoreCount`, `opponentsWithHandMaxCount`,
 *   `opponentsDealtCombatDamageBySelfOrSubtypeThisTurn`, `attackingCountToPlayer`, `fractionalLifeLoss`,
 *   `totalManaValueOfTargetSpec`, `isFirstCombatPhaseOfTurn`, `opponentHasMoreCardsInHandThan`,
 *   `playerControlsFilter`, `playerLostLifeThisTurn`, `wasDealtCombatDamageBySelfNameThisGame`)
 * - Fight excess mana (*The Last Agni Kai*), trample bite excess (*Ram Through*),
 *   and *Soulfire Eruption* per-target exile-and-damage.
 *
 * Pure IR / structured data: zero rules-text reads, zero card-name branches, zero IR in GameState.
 */
import type { Amount, Condition, CostDef, EffectStep, ObjectFilter } from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type { CardInstance, GameState, PlayerGameState } from '../types.ts';
import { computeLethalThresholdBefore } from './combatWave10.ts';
import { describeCost } from './costs.ts';
import { addLog, hasKeyword } from './engineHost.ts';
import { resolveObjectFaces } from './faces.ts';
import { addManaToPlayerPool } from './mana.ts';
import { objectManaValue } from './objectFilter.ts';
import { nextRandom } from './random.ts';
import { moveObject } from './zones.ts';
import type { EffectRunAccess } from './effectsDamageAndMana.ts';

export function resolveWave10PlayerRef(
	run: EffectRunAccess,
	refKind: 'chosenOpponent' | 'eachLoopPlayer'
): PlayerGameState | null {
	if (refKind === 'eachLoopPlayer') {
		const ans = run.answers['__w10_loop_pid'];
		const pid = run.ctx.w10LoopPlayerId ?? (ans?.kind === 'chooseObjects' ? ans.objectIds[0] : undefined);
		if (!pid) return null;
		const pl = run.player(pid);
		return pl && !pl.lost ? pl : null;
	}
	const ans = run.answers['__w10_chosen_opp'];
	const pid = run.ctx.w10ChosenOpponentId ?? (ans?.kind === 'chooseObjects' ? ans.objectIds[0] : undefined);
	if (!pid) return null;
	const pl = run.player(pid);
	return pl && !pl.lost ? pl : null;
}

export function evaluateWave10Amount(run: EffectRunAccess, a: Amount): number | null {
	const s = run.state;
	switch (a.k) {
		case 'opponentsControllingMoreCount': {
			const youCount = run.you.battlefield.filter(
				(c) => !c.phasedOut && run.matches(c, a.filter, 'battlefield')
			).length;
			let n = 0;
			for (const pl of s.players) {
				if (pl.lost || pl.playerId === run.you.playerId) continue;
				const oppCount = pl.battlefield.filter(
					(c) => !c.phasedOut && run.matches(c, a.filter, 'battlefield')
				).length;
				if (oppCount > youCount) n++;
			}
			return n;
		}
		case 'opponentsWithHandMaxCount': {
			return s.players.filter(
				(pl) => !pl.lost && pl.playerId !== run.you.playerId && pl.hand.length <= a.max
			).length;
		}
		case 'opponentsDealtCombatDamageBySelfOrSubtypeThisTurn': {
			let n = 0;
			for (const pl of s.players) {
				if (pl.lost || pl.playerId === run.you.playerId) continue;
				if (
					pl.combatDamageDealtBySourceIdsThisTurn?.includes(run.ctx.sourceId) ||
					pl.combatDamageDealtBySubtypesThisTurn?.includes(a.subtype)
				) {
					n++;
				}
			}
			return n;
		}
		case 'attackingCountToPlayer': {
			const pl = run.playerRef(a.player);
			if (!pl || !s.combat.active) return 0;
			return s.combat.attackers.filter((atk) => atk.defenderPlayerId === pl.playerId).length;
		}
		case 'fractionalLifeLoss': {
			const pl = run.playerRef(a.player);
			if (!pl || pl.life <= 0) return 0;
			const raw = pl.life / Math.max(1, a.denominator);
			return Math.max(0, a.round === 'up' ? Math.ceil(raw) : Math.floor(raw));
		}
		case 'totalManaValueOfTargetSpec': {
			const refs = run.targetsForSpecIndex(a.index);
			let sum = 0;
			for (const ref of refs) {
				if (ref.kind === 'player') continue;
				const found = run.locate(ref.id);
				if (found) {
					sum += objectManaValue(s, found.inst);
				} else {
					const stk = s.stack.find((x) => x.id === ref.id || x.sourceInstanceId === ref.id);
					if (stk) sum += objectManaValue(s, stk);
					else {
						const snap = run.initialSnapshots.get(ref.id);
						if (snap) sum += snap.manaValue;
					}
				}
			}
			return sum;
		}
		case 'countedThisWay': {
			if (a.kind === 'destroyedControlledByPlayerThisWay') {
				const pid = run.ctx.w10LoopPlayerId ?? run.you.playerId;
				const list = run.ctx.item?.w10DestroyedControllerIds ?? [];
				return list.filter((id) => id === pid).length;
			}
			if (
				a.kind === 'opponentsDidThisWay' ||
				a.kind === 'opponentsDidntThisWay' ||
				a.kind === 'nonlandRevealedThisWay' ||
				a.kind === 'landCardsPutIntoGraveyardThisWay' ||
				a.kind === 'creaturesDealtDamageThisWay' ||
				a.kind === 'opponentsDrewThisWay'
			) {
				return run.lastCountedByKind?.[a.kind] ?? run.ctx.item.lastCountedByKind?.[a.kind] ?? 0;
			}
			return null;
		}
		case 'countersAmongControlled': {
			const pl = run.playerRef(a.player);
			if (!pl || pl.lost) return 0;
			let total = 0;
			for (const perm of pl.battlefield) {
				if (perm.phasedOut) continue;
				if (!run.matches(perm, a.filter, 'battlefield')) continue;
				for (const v of Object.values(perm.counters)) total += v ?? 0;
			}
			return total;
		}
		default:
			return null;
	}
}

export function evaluateWave10Condition(run: EffectRunAccess, c: Condition): boolean | null {
	const s = run.state;
	switch (c.k) {
		case 'isFirstCombatPhaseOfTurn':
			return (s.combatPhasesCountThisTurn ?? 1) === 1;
		case 'opponentHasMoreCardsInHandThan': {
			const opp = run.playerRef(c.who);
			if (!opp) return false;
			return opp.hand.length > run.you.hand.length;
		}
		case 'playerControlsFilter': {
			const pl = run.playerRef(c.player);
			if (!pl || pl.lost) return false;
			return pl.battlefield.some((perm) => !perm.phasedOut && run.matches(perm, c.filter, 'battlefield'));
		}
		case 'playerLostLifeThisTurn': {
			const pl = run.playerRef(c.player);
			return Boolean(pl && !pl.lost && pl.lostLifeThisTurn);
		}
		case 'wasDealtCombatDamageBySelfNameThisGame': {
			const pl = run.playerRef(c.player);
			if (!pl || pl.lost) return false;
			const srcFound = run.locate(run.ctx.sourceId);
			const selfName =
				srcFound && srcFound.zone === 'battlefield'
					? evaluatePermanent(s, srcFound.inst).effectiveName
					: run.ctx.sourceCard.name;
			return Boolean(
				selfName && pl.combatDamageDealtByCardNamesThisGame?.includes(selfName.toLowerCase())
			);
		}
		case 'playerDidntDiscardNonlandThisWay': {
			const pid = run.ctx.w10LoopPlayerId;
			if (!pid) return false;
			const ans = run.answers[`w10_loop_didnt_nonland:${pid}`];
			return ans?.kind === 'yesNo' ? ans.yes : false;
		}
		case 'playerDiscardedHandThisWay': {
			const pid = run.ctx.w10LoopPlayerId;
			if (!pid) return false;
			const ans = run.answers[`w10_discarded_hand:${pid}`];
			return ans?.kind === 'yesNo' ? ans.yes : false;
		}
		default:
			return null;
	}
}

function getPlayersInTurnOrderFrom(state: GameState, startPlayerId: string): PlayerGameState[] {
	const n = state.players.length;
	if (n === 0) return [];
	const idx = Math.max(
		0,
		state.players.findIndex((p) => p.playerId === startPlayerId)
	);
	const out: PlayerGameState[] = [];
	for (let i = 0; i < n; i++) {
		const pl = state.players[(idx + i) % n];
		if (pl && !pl.lost) out.push(pl);
	}
	return out;
}

/**
 * Executes `forEachPlayerLoop` (chooseOpponent, chooseRandomOpponent, and sequential per-player loops).
 */
export function executeForEachPlayerLoopWave10(run: EffectRunAccess, step: EffectStep): void {
	const s = run.state;
	const params = step.params;
	if (!params?.loopPlayers) return;

	if (params.loopPlayers === 'chooseRandomOpponent' || params.loopPlayers === 'chooseOpponent') {
		const chosenKey = `w10_chosen:${run.stepIndex}`;
		const saved = run.answers[chosenKey];
		let chosenPid: string | undefined;
		if (saved?.kind === 'chooseObjects') {
			chosenPid = saved.objectIds[0] || undefined;
		} else {
			let opps = run.apnapPlayers().filter((p) => p.playerId !== run.you.playerId);
			if (params.excludeAttackedLastCombat) {
				const attacked = run.sourcePerm?.attackedLastCombatPlayerIds ?? [];
				opps = opps.filter((p) => !attacked.includes(p.playerId));
			}
			if (opps.length === 0) {
				run.answers[chosenKey] = { kind: 'chooseObjects', objectIds: [] };
				delete run.answers['__w10_chosen_opp'];
				run.ctx.w10ChosenOpponentId = undefined;
				run.stepDecisions[run.stepIndex] = false;
				return;
			}
			if (params.loopPlayers === 'chooseRandomOpponent' || params.chooseRandomOpponent) {
				const idx = Math.floor(nextRandom(s) * opps.length);
				chosenPid = opps[idx]!.playerId;
				run.answers[chosenKey] = { kind: 'chooseObjects', objectIds: [chosenPid] };
			} else if (!run.you.isBot && run.canPause && opps.length > 1) {
				const ans = run.p13AskFn()(
					run.you,
					chosenKey,
					{
						kind: 'chooseMode',
						modes: opps.map((o) => `${o.username} (Life ${o.life}, Hand ${o.hand.length})`),
						min: 1,
						max: 1,
						defaultIndices: [0]
					},
					`${run.ctx.title} — Choose an Opponent`,
					'Choose an opponent.'
				);
				if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseMode') return;
				const picked = opps[ans.indices[0] ?? 0] ?? opps[0]!;
				chosenPid = picked.playerId;
				run.answers[chosenKey] = { kind: 'chooseObjects', objectIds: [chosenPid] };
			} else {
				const sorted = [...opps].sort((a, b) => b.hand.length - a.hand.length || b.life - a.life);
				chosenPid = sorted[0]!.playerId;
				run.answers[chosenKey] = { kind: 'chooseObjects', objectIds: [chosenPid] };
			}
		}

		if (!chosenPid) {
			delete run.answers['__w10_chosen_opp'];
			run.ctx.w10ChosenOpponentId = undefined;
			run.stepDecisions[run.stepIndex] = false;
			return;
		}
		run.answers['__w10_chosen_opp'] = { kind: 'chooseObjects', objectIds: [chosenPid] };
		run.ctx.w10ChosenOpponentId = chosenPid;
		run.stepDecisions[run.stepIndex] = true;
		const chosenPl = run.player(chosenPid);
		if (chosenPl) {
			addLog(s, 'rule', `${run.you.username} chose ${chosenPl.username} (${run.ctx.title}).`, run.you.playerId);
		}
		return;
	}

	const orderKey = `w10_loop_order:${run.stepIndex}`;
	let playerIds: string[];
	const savedOrder = run.answers[orderKey];
	if (savedOrder?.kind === 'chooseObjects') {
		playerIds = savedOrder.objectIds;
	} else {
		let list: PlayerGameState[] = [];
		switch (params.loopPlayers) {
			case 'eachOpponent':
				list = run.apnapPlayers().filter((p) => p.playerId !== run.you.playerId);
				break;
			case 'eachPlayer':
				list = run.apnapPlayers();
				break;
			case 'eachOtherPlayer':
				list = run.apnapPlayers().filter((p) => p.playerId !== run.you.playerId);
				break;
			case 'turnOrderStartingWithYou':
				list = getPlayersInTurnOrderFrom(s, run.you.playerId);
				break;
			case 'turnOrderStartingWithNextOpponent':
				list = getPlayersInTurnOrderFrom(s, run.you.playerId).filter((p) => p.playerId !== run.you.playerId);
				break;
		}
		if (step.params?.excludeEventPlayer && run.ctx.eventPlayerId) {
			list = list.filter((p) => p.playerId !== run.ctx.eventPlayerId);
		}
		playerIds = list.map((p) => p.playerId);
		run.answers[orderKey] = { kind: 'chooseObjects', objectIds: playerIds };
	}

	if (params.chooseObjectToBind) {
		const spec = params.chooseObjectToBind;
		const cands = run.objects({ k: 'all', filter: spec.filter }).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
		const pickedIdsKey = `w10_loop_bind:${run.stepIndex}`;
		const chosenList: CardInstance[] = [];
		const savedBind = run.answers[pickedIdsKey];
		if (savedBind?.kind === 'chooseObjects') {
			for (const id of savedBind.objectIds) {
				const f = run.locate(id)?.inst;
				if (f && f.zone === 'battlefield') chosenList.push(f);
			}
		}
		for (let pi = 0; pi < playerIds.length; pi++) {
			const doneKey = `w10_loop_pick_done:${run.stepIndex}:${pi}`;
			if (run.answers[doneKey]) continue;
			const pid = playerIds[pi]!;
			const pl = run.player(pid);
			if (!pl || pl.lost || cands.length === 0) {
				run.answers[doneKey] = { kind: 'yesNo', yes: true };
				continue;
			}
			const pickKey = `w10_loop_pick:${run.stepIndex}:${pi}`;
			let picked: CardInstance | undefined;
			if (!pl.isBot && run.canPause) {
				const ans = run.p13AskFn()(
					pl,
					pickKey,
					{
						kind: 'chooseObjects',
						candidates: cands.map((x) => x.instanceId),
						min: spec.optional ? 0 : 1,
						max: 1,
						zone: 'battlefield',
						reason: spec.optional ? `Choose up to one permanent (optional).` : `Choose one permanent.`,
						defaultObjectIds: spec.optional ? [] : [cands[0]!.instanceId]
					},
					`${run.ctx.title} — Choose Permanent`,
					`${pl.username}: choose a permanent.`
				);
				if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseObjects') return;
				if (ans.objectIds[0]) picked = cands.find((x) => x.instanceId === ans.objectIds[0]);
			} else {
				const nonSelf = cands.filter((x) => x.controllerId !== pl.playerId);
				const pool = nonSelf.length > 0 ? nonSelf : spec.optional ? [] : cands;
				picked = [...pool].sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a))[0];
			}
			if (picked) {
				chosenList.push(picked);
				run.answers[pickedIdsKey] = { kind: 'chooseObjects', objectIds: chosenList.map((x) => x.instanceId) };
			}
			run.answers[doneKey] = { kind: 'yesNo', yes: true };
		}
		run.bind(step, chosenList);
		return;
	}

	const loopSteps = params.loopSteps ?? [];
	if (loopSteps.length === 0) return;

	const hasDraw = loopSteps.some((st) => st.verb === 'draw');
	const hasDiscard = loopSteps.some((st) => st.verb === 'discard');
	const hasDiscardHand = loopSteps.some((st) => st.verb === 'discardHand');
	const hasSacrifice = loopSteps.some((st) => st.verb === 'sacrifice');
	const oppDrewKey = `w10_loop_opp_drew:${run.stepIndex}`;
	const discAccKey = `w10_loop_disc:${run.stepIndex}`;
	const sacAccKey = `w10_loop_sac:${run.stepIndex}`;
	const didAccKey = `w10_loop_did:${run.stepIndex}`;
	const readNum = (k: string): number => (run.answers[k]?.kind === 'chooseNumber' ? run.answers[k].n : 0);

	for (let pi = 0; pi < playerIds.length; pi++) {
		const doneKey = `w10_loop_done:${run.stepIndex}:${pi}`;
		if (run.answers[doneKey]) continue;
		const pid = playerIds[pi]!;
		const pl = run.player(pid);
		if (!pl || pl.lost) {
			run.answers[doneKey] = { kind: 'yesNo', yes: true };
			continue;
		}
		const handBefore = pl.hand.length;
		const gyBefore = pl.graveyard.length;
		if (hasDiscard && run.lastCountedByKind) delete run.lastCountedByKind['discardedThisWay'];
		if (hasSacrifice && run.lastCountedByKind) delete run.lastCountedByKind['sacrificedThisWay'];
		run.answers['__w10_loop_pid'] = { kind: 'chooseObjects', objectIds: [pid] };
		run.ctx.w10LoopPlayerId = pid;
		const paused = run.runInlineBranchSteps(loopSteps, run.stepIndex * 1000 + pi);
		if (paused || run.result.paused) {
			run.result.paused = true;
			return;
		}
		if (run.result.turnEnded) return;
		if (hasDiscardHand && handBefore > 0 && pl.hand.length === 0) {
			run.answers[`w10_discarded_hand:${pid}`] = { kind: 'yesNo', yes: true };
		}
		if (hasDraw && pid !== run.you.playerId && pl.hand.length > handBefore) {
			run.answers[oppDrewKey] = { kind: 'chooseNumber', n: readNum(oppDrewKey) + 1 };
		}
		if (hasDiscard) {
			const iterDisc = run.lastCountedByKind?.['discardedThisWay'] ?? 0;
			run.answers[discAccKey] = { kind: 'chooseNumber', n: readNum(discAccKey) + iterDisc };
			const newlyAdded = pl.graveyard.slice(gyBefore);
			const discardedNonland = newlyAdded.some((c) => !resolveObjectFaces(c.card, {}).types.includes('Land'));
			run.answers[`w10_loop_didnt_nonland:${pid}`] = { kind: 'yesNo', yes: !discardedNonland };
		}
		if (hasSacrifice) {
			const iterSac = run.lastCountedByKind?.['sacrificedThisWay'] ?? 0;
			run.answers[sacAccKey] = { kind: 'chooseNumber', n: readNum(sacAccKey) + iterSac };
		}
		if (pid !== run.you.playerId) {
			const didIter =
				(hasDraw && pl.hand.length > handBefore) ||
				(hasDiscard && (run.lastCountedByKind?.['discardedThisWay'] ?? 0) > 0) ||
				(hasSacrifice && (run.lastCountedByKind?.['sacrificedThisWay'] ?? 0) > 0);
			if (didIter) {
				run.answers[didAccKey] = { kind: 'chooseNumber', n: readNum(didAccKey) + 1 };
			}
		}
		run.answers[doneKey] = { kind: 'yesNo', yes: true };
	}
	if (hasDraw) {
		const oppDrew = readNum(oppDrewKey);
		run.recordCountedKind('opponentsDrewThisWay', oppDrew);
		run.recordCountedKind('opponentsDidThisWay', oppDrew);
	}
	if (hasDiscard) run.recordCountedKind('discardedThisWay', readNum(discAccKey));
	if (hasSacrifice) run.recordCountedKind('sacrificedThisWay', readNum(sacAccKey));
	if (!hasDraw && (hasDiscard || hasSacrifice)) {
		run.recordCountedKind('opponentsDidThisWay', readNum(didAccKey));
	}
	delete run.answers['__w10_loop_pid'];
	run.ctx.w10LoopPlayerId = undefined;
}

function getCostBranchCandidates(
	run: EffectRunAccess,
	player: PlayerGameState,
	cost: CostDef
): { affordable: boolean; kind: 'sacrifice' | 'discard' | 'discardHand' | 'direct'; candidates: CardInstance[]; count: number } {
	const s = run.state;
	if (cost.k === 'sacrifice') {
		const count = Math.max(1, run.amount(cost.count, 1));
		const f: ObjectFilter =
			typeof cost.filter === 'string' || !cost.filter ? {} : { ...cost.filter, controller: undefined };
		const cands = player.battlefield.filter((c) => !c.phasedOut && run.matches(c, f, 'battlefield'));
		return { affordable: cands.length >= count, kind: 'sacrifice', candidates: cands, count };
	}
	if (cost.k === 'discard') {
		const count = Math.max(1, run.amount(cost.count, 1));
		const f: ObjectFilter = typeof cost.filter === 'string' || !cost.filter ? {} : cost.filter;
		const cands = player.hand.filter((c) => run.matches(c, f, 'hand'));
		return { affordable: cands.length >= count, kind: 'discard', candidates: cands, count };
	}
	if (cost.k === 'discardHand') {
		return { affordable: true, kind: 'discardHand', candidates: [...player.hand], count: player.hand.length };
	}
	if (cost.k === 'payLife') {
		const n = Math.max(0, run.amount(cost.amount, 0));
		return { affordable: player.life >= n && (n === 0 || !player.lifeTotalCannotChangeThisTurn), kind: 'direct', candidates: [], count: n };
	}
	return { affordable: true, kind: 'direct', candidates: [], count: 0 };
}

function expandCostOptions(costs: CostDef[]): CostDef[][] {
	if (costs.length === 1 && costs[0]!.k === 'choice') {
		return costs[0]!.options;
	}
	return [costs];
}

function executePunisherCostBranch(
	run: EffectRunAccess,
	player: PlayerGameState,
	branch: CostDef[],
	prefixKey: string
): 'done' | 'paused' | 'failed' {
	const s = run.state;
	for (let ci = 0; ci < branch.length; ci++) {
		const c = branch[ci]!;
		const info = getCostBranchCandidates(run, player, c);
		if (!info.affordable) return 'failed';
		if (c.k === 'sacrifice') {
			let picked: CardInstance[];
			const pickKey = `${prefixKey}:sac:${ci}`;
			if (info.candidates.length === info.count) {
				picked = info.candidates.slice(0, info.count);
			} else if (!player.isBot && run.canPause) {
				const ans = run.p13AskFn()(
					player,
					pickKey,
					{
						kind: 'chooseObjects',
						candidates: info.candidates.map((x) => x.instanceId),
						min: info.count,
						max: info.count,
						zone: 'battlefield',
						reason: `Choose ${info.count} permanent(s) to sacrifice.`,
						defaultObjectIds: info.candidates.slice(0, info.count).map((x) => x.instanceId)
					},
					`${run.ctx.title} — Sacrifice`,
					`Choose ${info.count} permanent(s) to sacrifice.`
				);
				if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseObjects') {
					return 'paused';
				}
				picked = ans.objectIds
					.map((id: string) => info.candidates.find((x) => x.instanceId === id))
					.filter((x): x is CardInstance => Boolean(x));
				if (picked.length < info.count) {
					for (const x of info.candidates) {
						if (picked.length < info.count && !picked.includes(x)) picked.push(x);
					}
				}
			} else {
				const sorted = [...info.candidates].sort(
					(a, b) => objectManaValue(s, a) - objectManaValue(s, b)
				);
				picked = sorted.slice(0, info.count);
			}
			for (const perm of picked) {
				moveObject(s, perm, 'graveyard', {
					from: { player, zone: 'battlefield' },
					toPlayer: player,
					sacrificedByPlayerId: player.playerId,
					bumpVersion: true,
					newTimestamp: true
				});
				addLog(s, 'rule', `${player.username} sacrificed ${perm.card.name}.`, player.playerId);
			}
		} else if (c.k === 'discard') {
			let picked: CardInstance[];
			const pickKey = `${prefixKey}:disc:${ci}`;
			if (info.candidates.length === info.count) {
				picked = info.candidates.slice(0, info.count);
			} else if (!player.isBot && run.canPause) {
				const ans = run.p13AskFn()(
					player,
					pickKey,
					{
						kind: 'chooseObjects',
						candidates: info.candidates.map((x) => x.instanceId),
						min: info.count,
						max: info.count,
						zone: 'hand',
						reason: `Choose ${info.count} card(s) to discard.`,
						defaultObjectIds: info.candidates.slice(0, info.count).map((x) => x.instanceId)
					},
					`${run.ctx.title} — Discard`,
					`Choose ${info.count} card(s) to discard.`
				);
				if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseObjects') {
					return 'paused';
				}
				picked = ans.objectIds
					.map((id: string) => info.candidates.find((x) => x.instanceId === id))
					.filter((x): x is CardInstance => Boolean(x));
				if (picked.length < info.count) {
					for (const x of info.candidates) {
						if (picked.length < info.count && !picked.includes(x)) picked.push(x);
					}
				}
			} else {
				const sorted = [...info.candidates].sort(
					(a, b) => objectManaValue(s, b) - objectManaValue(s, a)
				);
				picked = sorted.slice(0, info.count);
			}
			for (const card of picked) {
				moveObject(s, card, 'graveyard', {
					from: { player, zone: 'hand' },
					toPlayer: player,
					graveyardReplacement: true,
					discardReason: 'discard',
					discardPlayerId: player.playerId,
					bumpVersion: true,
					newTimestamp: true
				});
				addLog(s, 'rule', `${player.username} discarded ${card.card.name}.`, player.playerId);
			}
		} else if (c.k === 'discardHand') {
			const allHand = [...player.hand];
			for (const card of allHand) {
				moveObject(s, card, 'graveyard', {
					from: { player, zone: 'hand' },
					toPlayer: player,
					graveyardReplacement: true,
					discardReason: 'discard',
					discardPlayerId: player.playerId,
					bumpVersion: true,
					newTimestamp: true
				});
			}
			addLog(s, 'rule', `${player.username} discarded their hand (${allHand.length} card(s)).`, player.playerId);
		} else if (c.k === 'payLife') {
			const n = Math.max(0, run.amount(c.amount, 0));
			if (n > 0) {
				player.life -= n;
				player.lostLifeThisTurn = true;
			}
		}
	}
	return 'done';
}

/**
 * Executes `punisherChoice` (*Torment of Hailfire*, *Braids, Arisen Nightmare*, *Mogis*,
 * *Tergrid*, *Bandit's Talent*, *Combustible Gearhulk*, *Star Athlete*, *Enchanter's Bane*,
 * *Perplex*, *Fandaniel*).
 */
export function executePunisherChoiceWave10(run: EffectRunAccess, step: EffectStep): void {
	const pun = step.params?.punisher;
	if (!pun) return;

	const repeatCount = pun.repeatCount ? Math.max(0, run.amount(pun.repeatCount, 1)) : 1;
	if (repeatCount <= 0) return;

	const orderKey = `w10_pun_players:${run.stepIndex}`;
	let playerIds: string[];
	const savedOrder = run.answers[orderKey];
	if (savedOrder?.kind === 'chooseObjects') {
		playerIds = savedOrder.objectIds;
	} else {
		const list =
			pun.players === 'eachOpponent'
				? run.apnapPlayers().filter((p) => p.playerId !== run.you.playerId)
				: pun.players === 'eachPlayer'
					? run.apnapPlayers()
					: step.subject.k === 'none'
						? run.players({ k: 'playerRef', ref: pun.unlessWho })
						: run.players(step.subject);
		playerIds = list.map((p) => p.playerId);
		run.answers[orderKey] = { kind: 'chooseObjects', objectIds: playerIds };
	}

	let paidTotal = 0;
	let declinedTotal = 0;

	for (let rep = 0; rep < repeatCount; rep++) {
		for (let pi = 0; pi < playerIds.length; pi++) {
			const doneKey = `w10_pun_done:${run.stepIndex}:${rep}:${pi}`;
			if (run.answers[doneKey]) {
				const wasPaid = run.answers[doneKey].kind === 'yesNo' && run.answers[doneKey].yes;
				if (wasPaid) paidTotal++;
				else declinedTotal++;
				continue;
			}
			const pid = playerIds[pi]!;
			const pl = run.player(pid);
			if (!pl || pl.lost) {
				run.answers[doneKey] = { kind: 'yesNo', yes: false };
				continue;
			}

			run.answers['__w10_loop_pid'] = { kind: 'chooseObjects', objectIds: [pid] };
			run.ctx.w10LoopPlayerId = pid;

			const choiceKey = `w10_pun_choice:${run.stepIndex}:${rep}:${pi}`;
			if (pun.unlessEffect && pun.unlessEffect.length > 0) {
				let chooseAccept: boolean;
				const savedChoice = run.answers[choiceKey];
				if (savedChoice?.kind === 'chooseMode') {
					chooseAccept = (savedChoice.indices[0] ?? 1) === 0;
				} else if (!pl.isBot && run.canPause) {
					const ans = run.p13AskFn()(
						pl,
						choiceKey,
						{
							kind: 'chooseMode',
							modes: ['Accept optional effect', 'Decline'],
							min: 1,
							max: 1,
							defaultIndices: [0]
						},
						`${run.ctx.title} — Punisher Choice`,
						`Choose whether to accept or decline.`
					);
					if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseMode') return;
					chooseAccept = (ans.indices[0] ?? 1) === 0;
				} else {
					// Bot heuristic: if life <= 8, avoid taking mill+damage by letting opponent draw
					chooseAccept = pl.life <= 8;
				}
				if (chooseAccept) {
					const paused = run.runInlineBranchSteps(
						pun.unlessEffect,
						run.stepIndex * 10000 + rep * 100 + pi
					);
					if (paused || run.result.paused) {
						run.result.paused = true;
						return;
					}
					paidTotal++;
					run.answers[doneKey] = { kind: 'yesNo', yes: true };
				} else {
					const paused = run.runInlineBranchSteps(
						pun.defaultSteps,
						run.stepIndex * 10000 + rep * 100 + pi + 50
					);
					if (paused || run.result.paused) {
						run.result.paused = true;
						return;
					}
					declinedTotal++;
					run.answers[doneKey] = { kind: 'yesNo', yes: false };
				}
				continue;
			}

			const branches = pun.unlessCost ? expandCostOptions(pun.unlessCost) : [];
			const affordableBranches = branches.filter((br) =>
				br.every((c) => getCostBranchCandidates(run, pl, c).affordable)
			);

			let chosenBranchIdx = -1; // -1 = decline -> defaultSteps
			if (affordableBranches.length > 0) {
				const savedMode = run.answers[choiceKey];
				if (pun.mandatoryIfAble && affordableBranches.length === 1) {
					chosenBranchIdx = 0;
				} else if (savedMode?.kind === 'chooseMode') {
					const idx = savedMode.indices[0] ?? affordableBranches.length;
					chosenBranchIdx = idx < affordableBranches.length ? idx : -1;
				} else if (!pl.isBot && run.canPause) {
					const labels = affordableBranches.map((br) => describeCost(br));
					if (!pun.mandatoryIfAble) labels.push('Decline (take effect)');
					const ans = run.p13AskFn()(
						pl,
						choiceKey,
						{
							kind: 'chooseMode',
							modes: labels,
							min: 1,
							max: 1,
							defaultIndices: [0]
						},
						`${run.ctx.title} — Choose Action`,
						`${pl.username}: choose a cost to pay or decline.`
					);
					if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseMode') return;
					const idx = ans.indices[0] ?? labels.length - 1;
					chosenBranchIdx = idx < affordableBranches.length ? idx : -1;
				} else {
					// Bot heuristic: pay if default is spell counter or lethal/severe life loss, or if plenty of cards
					const defaultHasCounter = pun.defaultSteps.some((st) => st.verb === 'counterSpell');
					const defaultLifeHit = pun.defaultSteps.reduce(
						(acc, st) =>
							st.verb === 'loseLife' || st.verb === 'damage'
								? acc + Math.max(0, run.amount(st.amount, 0))
								: acc,
						0
					);
					if (defaultHasCounter || pl.life <= Math.max(4, defaultLifeHit)) {
						chosenBranchIdx = 0;
					} else if (pl.life <= 10 && affordableBranches[0]!.every((c) => c.k === 'discard' || c.k === 'sacrifice')) {
						chosenBranchIdx = 0;
					} else {
						chosenBranchIdx = -1;
					}
				}
			}

			if (chosenBranchIdx >= 0 && affordableBranches[chosenBranchIdx]) {
				const res = executePunisherCostBranch(
					run,
					pl,
					affordableBranches[chosenBranchIdx]!,
					`w10_pun_br:${run.stepIndex}:${rep}:${pi}`
				);
				if (res === 'paused' || run.result.paused) {
					run.result.paused = true;
					return;
				}
				if (res === 'done') {
					paidTotal++;
					run.answers[doneKey] = { kind: 'yesNo', yes: true };
					continue;
				}
			}

			if (pun.defaultSteps.length > 0) {
				const paused = run.runInlineBranchSteps(
					pun.defaultSteps,
					run.stepIndex * 10000 + rep * 100 + pi + 50
				);
				if (paused || run.result.paused) {
					run.result.paused = true;
					return;
				}
			}
			declinedTotal++;
			run.answers[doneKey] = { kind: 'yesNo', yes: false };
		}
	}

	delete run.answers['__w10_loop_pid'];
	run.ctx.w10LoopPlayerId = undefined;
	run.recordCountedKind('punisherPaidThisWay', paidTotal);
	run.recordCountedKind('punisherDeclinedThisWay', declinedTotal);
	run.stepDecisions[run.stepIndex] = paidTotal > 0;
}

/**
 * Executes `partitionKeepByTypes` (*Cataclysmic Gearhulk*, *Tragic Arrogance*, *Liliana -9*,
 * *Archfiend of Depravity*, *Planetary Annihilation*, *Promise of Loyalty*).
 */
export function executePartitionKeepByTypesWave10(run: EffectRunAccess, step: EffectStep): void {
	const s = run.state;
	const pTypes = step.params?.partitionTypes ?? [];
	if (pTypes.length === 0) return;

	const chooserMode = step.params?.partitionChooser ?? 'eachPlayer';
	const nonlandOnly = Boolean(step.params?.partitionNonlandOnly);
	const keepCount = step.params?.keepCountPerPlayer
		? Math.max(0, run.amount(step.params.keepCountPerPlayer, 1))
		: undefined;
	const putVow = Boolean(step.params?.partitionPutVowCounter);

	const sacBatchKey = `w10_part_sac:${run.stepIndex}`;
	if (!run.answers[sacBatchKey]) {
		const players = step.subject.k === 'none' ? run.apnapPlayers() : run.players(step.subject);
		const keptIdsAll: string[] = [];
		const sacIdsAll: string[] = [];

		for (let pi = 0; pi < players.length; pi++) {
			const pl = players[pi]!;
			const chooser = chooserMode === 'you' ? run.you : pl;
			const eligiblePool = pl.battlefield.filter((c) => {
				if (c.phasedOut) return false;
				const ev = evaluatePermanent(s, c);
				const words = ev.typeLine.split(/[\s—]+/);
				if (nonlandOnly && words.includes('Land')) return false;
				return pTypes.some((t) => words.includes(t));
			});
			if (eligiblePool.length === 0) continue;

			const playerKept = new Set<string>();
			if (keepCount !== undefined) {
				const count = Math.min(keepCount, eligiblePool.length);
				const pickKey = `w10_part_cnt:${run.stepIndex}:${pi}`;
				let chosen: CardInstance[];
				const saved = run.answers[pickKey];
				if (saved?.kind === 'chooseObjects') {
					chosen = saved.objectIds
						.map((id) => eligiblePool.find((c) => c.instanceId === id))
						.filter((c): c is CardInstance => Boolean(c))
						.slice(0, count);
				} else if (eligiblePool.length <= count) {
					chosen = eligiblePool;
				} else if (!chooser.isBot && run.canPause) {
					run.pauseForChoice(
						chooser,
						`${run.ctx.title} — Choose ${count} Permanent(s) to Keep`,
						`Choose up to ${count} permanent(s) for ${pl.username} to keep; the rest will be sacrificed.`,
						eligiblePool.map((c) => c.instanceId),
						count,
						count,
						'battlefield',
						eligiblePool.slice(0, count).map((c) => c.instanceId),
						pickKey
					);
					return;
				} else {
					const dir = chooser.playerId === pl.playerId ? -1 : 1;
					chosen = [...eligiblePool]
						.sort((a, b) => dir * (objectManaValue(s, a) - objectManaValue(s, b)))
						.slice(0, count);
				}
				for (const c of chosen) playerKept.add(c.instanceId);
			} else {
				for (let ti = 0; ti < pTypes.length; ti++) {
					const tName = pTypes[ti]!;
					const cands = eligiblePool.filter((c) =>
						evaluatePermanent(s, c).typeLine.split(/[\s—]+/).includes(tName)
					);
					if (cands.length === 0) continue;
					const pickKey = `w10_part_slot:${run.stepIndex}:${pi}:${ti}`;
					let chosen: CardInstance | undefined;
					const saved = run.answers[pickKey];
					if (saved?.kind === 'chooseObjects' && saved.objectIds[0]) {
						chosen = cands.find((c) => c.instanceId === saved.objectIds[0]) ?? cands[0];
					} else if (cands.length === 1) {
						chosen = cands[0];
					} else if (!chooser.isBot && run.canPause) {
						run.pauseForChoice(
							chooser,
							`${run.ctx.title} — Choose ${tName} (${pl.username})`,
							`Choose a ${tName} controlled by ${pl.username} to keep.`,
							cands.map((c) => c.instanceId),
							1,
							1,
							'battlefield',
							[cands[0]!.instanceId],
							pickKey
						);
						return;
					} else {
						if (chooser.playerId === pl.playerId) {
							const unkept = cands.filter((c) => !playerKept.has(c.instanceId));
							const pool = unkept.length > 0 ? unkept : cands;
							chosen = [...pool].sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a))[0];
						} else {
							const already = cands.filter((c) => playerKept.has(c.instanceId));
							const pool = already.length > 0 ? already : cands;
							chosen = [...pool].sort((a, b) => objectManaValue(s, a) - objectManaValue(s, b))[0];
						}
					}
					if (chosen) playerKept.add(chosen.instanceId);
				}
			}

			for (const id of playerKept) keptIdsAll.push(id);
			for (const c of eligiblePool) {
				if (!playerKept.has(c.instanceId)) sacIdsAll.push(c.instanceId);
			}
		}

		if (putVow) {
			for (const id of keptIdsAll) {
				const f = run.locate(id);
				if (f && f.zone === 'battlefield') {
					f.inst.counters.vow = (f.inst.counters.vow ?? 0) + 1;
					const list = (f.inst.cantAttackPlayerWhileCounter ??= []);
					if (!list.some((e) => e.playerId === run.you.playerId && e.counter === 'vow')) {
						list.push({ playerId: run.you.playerId, counter: 'vow' });
					}
				}
			}
		}

		run.answers[sacBatchKey] = { kind: 'chooseObjects', objectIds: sacIdsAll };
	}

	run.runIndexedBatch(
		sacBatchKey,
		() => [],
		(id) => {
			const f = run.locate(id);
			if (!f || f.zone !== 'battlefield') return;
			const res = moveObject(s, f.inst, 'graveyard', {
				from: { player: f.holder, zone: 'battlefield' },
				toPlayer: f.holder,
				sacrificedByPlayerId: f.holder.playerId,
				bumpVersion: true,
				newTimestamp: true
			});
			addLog(s, 'rule', `${f.holder.username} sacrificed ${f.inst.card.name}.`, f.holder.playerId);
			return res;
		}
	);
}

/**
 * *Ram Through*: if the source creature has trample, deals up to lethal damage to the target
 * creature and excess damage to that creature's controller instead.
 */
export function executeDamageWithExcessToControllerWave10(
	run: EffectRunAccess,
	step: EffectStep
): boolean {
	if (!step.params?.excessDamageToControllerIfTrample) return false;
	const src = run.resolveDamageSource(step.params.damageSource);
	if (!src || !src.srcPerm || !hasKeyword(src.srcPerm, 'Trample', run.state)) {
		return false;
	}
	const targets = run.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	if (targets.length === 0) return true;
	const target = targets[0]!;
	const rawAmount = Math.max(0, run.amount(step.amount, 0));
	if (rawAmount <= 0) return true;

	const srcInfo = run.sourceDamageInfo(src.srcPerm, src.srcCard);
	const lethal = computeLethalThresholdBefore(run.state, target, srcInfo.hasDeathtouch);
	const toCreature = Math.min(rawAmount, lethal);
	const toController = Math.max(0, rawAmount - toCreature);

	let dealtTotal = 0;
	if (toCreature > 0) {
		dealtTotal += run.dealDamageToPermanent(target, toCreature, src.srcId, srcInfo);
	}
	if (toController > 0) {
		const ctrlPl = run.player(target.controllerId);
		if (ctrlPl && !ctrlPl.lost) {
			dealtTotal += run.dealDamageToPlayer(ctrlPl, toController, src.srcId, srcInfo);
		}
	}
	if (srcInfo.hasLifelink && dealtTotal > 0) {
		run.applyLifelinkGain(src.srcController, dealtTotal);
	}
	run.recordEffectAmount(dealtTotal);
	return true;
}

/**
 * *The Last Agni Kai*: after fight damage, if the opponent's creature was dealt excess damage,
 * adds that much mana of `step.params.excessDamageToMana`.
 */
export function recordFightExcessManaWave10(
	run: EffectRunAccess,
	step: EffectStep,
	fighterB: CardInstance,
	lethalBeforeB: number,
	dealtByA: number
): void {
	const manaColor = step.params?.excessDamageToMana;
	if (!manaColor || dealtByA <= 0) return;
	const excess = Math.max(0, dealtByA - lethalBeforeB);
	if (excess > 0) {
		addManaToPlayerPool(run.you, manaColor, excess);
		addLog(
			run.state,
			'rule',
			`${run.you.username} added ${excess} {${manaColor}} from excess fight damage (${run.ctx.title}).`,
			run.you.playerId
		);
	}
}

/**
 * *Vial Smasher* / *Soul of Shandalar*: deals `amount` damage to `player` OR a planeswalker they control.
 */
export function executeDamageWithOrPlaneswalkerWave10(
	run: EffectRunAccess,
	step: EffectStep
): boolean {
	const pRef = step.params?.orPlaneswalkerControlledBy;
	if (!pRef) return false;
	const targetPl = run.playerRef(pRef);
	if (!targetPl || targetPl.lost) return true;
	const src = run.resolveDamageSource(step.params?.damageSource);
	if (!src) return true;
	const dmgAmt = Math.max(0, run.amount(step.amount, 0));
	if (dmgAmt <= 0) return true;
	const srcInfo = run.sourceDamageInfo(src.srcPerm, src.srcCard);

	const pws = targetPl.battlefield.filter((c) => !c.phasedOut && evaluatePermanent(run.state, c).isPlaneswalker);
	let chosenKind: 'player' | 'pw' = 'player';
	let chosenPw: CardInstance | undefined;
	if (pws.length > 0) {
		const options = [`${targetPl.username} (player)`, ...pws.map((pw) => `${pw.card.name} (planeswalker)`)];
		const key = `w10_dmg_pl_pw:${run.stepIndex}`;
		let idx = 0;
		const saved = run.answers[key];
		if (saved?.kind === 'chooseMode') {
			idx = saved.indices[0] ?? 0;
		} else if (!run.you.isBot && run.canPause) {
			const ans = run.p13AskFn()(
				run.you,
				key,
				{ kind: 'chooseMode', modes: options, min: 1, max: 1, defaultIndices: [0] },
				`${run.ctx.title} — Choose Damage Recipient`,
				`Choose ${targetPl.username} or a planeswalker they control.`
			);
			if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseMode') return true;
			idx = ans.indices[0] ?? 0;
		}
		if (idx > 0 && pws[idx - 1]) {
			chosenKind = 'pw';
			chosenPw = pws[idx - 1];
		}
	}

	let dealt = 0;
	if (chosenKind === 'pw' && chosenPw) {
		dealt = run.dealDamageToPermanent(chosenPw, dmgAmt, src.srcId, srcInfo);
	} else {
		dealt = run.dealDamageToPlayer(targetPl, dmgAmt, src.srcId, srcInfo);
	}
	if (srcInfo.hasLifelink && dealt > 0) {
		run.applyLifelinkGain(src.srcController, dealt);
	}
	run.recordEffectAmount(dealt);
	return true;
}

/**
 * *Soulfire Eruption*: for each target in spec 0, exile top card of your library, deal damage equal
 * to that card's MV to that target, and allow playing the exiled card until end of your next turn.
 */
export function executeSoulfireEruptionWave10(run: EffectRunAccess, step: EffectStep): boolean {
	if (step.params?.eachCreatureDealsDamage) {
		const spec = step.params.eachCreatureDealsDamage;
		const s = run.state;
		const matched = run.objects({ k: 'all', filter: { zone: 'battlefield', ...spec.filter } }).filter(
			(o) => o.zone === 'battlefield' && !o.phasedOut
		);
		const snap = matched.map((o) => ({
			perm: o,
			amt:
				spec.amount === 'power'
					? Math.max(0, evaluatePermanent(s, o).breakdown.effectivePower ?? 0)
					: Math.max(0, run.amount(spec.amount, 0)),
			srcInfo: run.sourceDamageInfo(o, o.copiableCard ?? o.card),
			ctrl: run.player(o.controllerId) ?? run.you
		}));
		let total = 0;
		for (const item of snap) {
			if (item.amt <= 0) continue;
			let dealt = 0;
			if (spec.to === 'self') {
				dealt = run.dealDamageToPermanent(item.perm, item.amt, item.perm.instanceId, item.srcInfo);
			} else if (!item.ctrl.lost) {
				dealt = run.dealDamageToPlayer(item.ctrl, item.amt, item.perm.instanceId, item.srcInfo);
			}
			total += dealt;
			if (dealt > 0 && item.srcInfo.hasLifelink) {
				run.applyLifelinkGain(item.ctrl, dealt);
			}
		}
		run.recordEffectAmount(total);
		return true;
	}
	if (step.params?.damageAttackedTargetBySelf) {
		const s = run.state;
		const resolvedSrc = run.resolveDamageSource(step.params.damageSource);
		if (!resolvedSrc) return true;
		const amt = Math.max(0, run.amount(step.amount, 0));
		if (amt <= 0) return true;
		const atk = s.combat.attackers.find((a) => a.attackerInstanceId === resolvedSrc.srcId);
		if (!atk) return true;
		const srcInfo = run.sourceDamageInfo(resolvedSrc.srcPerm, resolvedSrc.srcCard);
		let dealt = 0;
		if (atk.defenderPlaneswalkerId) {
			const pw = run.locate(atk.defenderPlaneswalkerId)?.inst;
			if (pw && pw.zone === 'battlefield' && !pw.phasedOut) {
				dealt = run.dealDamageToPermanent(pw, amt, resolvedSrc.srcId, srcInfo);
			}
		} else {
			const pl = run.player(atk.defenderPlayerId);
			if (pl && !pl.lost) {
				dealt = run.dealDamageToPlayer(pl, amt, resolvedSrc.srcId, srcInfo);
			}
		}
		run.recordEffectAmount(dealt);
		if (dealt > 0 && srcInfo.hasLifelink) run.applyLifelinkGain(resolvedSrc.srcController, dealt);
		return true;
	}
	if (!step.params?.soulfireExileDamagePerTarget) return false;
	const s = run.state;
	const you = run.you;
	const refs = run.targetsForSpecIndex(0);
	const src = run.resolveDamageSource(step.params.damageSource);
	if (!src) return true;
	const srcInfo = run.sourceDamageInfo(src.srcPerm, src.srcCard);

	const doneKey = `w10_soulfire:${run.stepIndex}`;
	if (run.answers[doneKey]) return true;
	run.answers[doneKey] = { kind: 'yesNo', yes: true };

	for (const ref of refs) {
		const top = you.library[0];
		if (!top) break;
		moveObject(s, top, 'exile', {
			from: { player: you, zone: 'library' },
			toPlayer: you,
			bumpVersion: true,
			newTimestamp: true
		});
		top.playableFromExileBy = {
			playerId: you.playerId,
			sourceName: run.ctx.title,
			duration: 'untilEndOfYourNextTurn',
			expiresOnCleanupOfPlayerId: you.playerId,
			grantedOnTurnSerial: s.turnSerial ?? s.turnNumber,
			spendManaAsAnyColor: false
		};
		const mv = objectManaValue(s, top);
		if (mv > 0) {
			if (ref.kind === 'player') {
				const pl = run.player(ref.id);
				if (pl && !pl.lost) run.dealDamageToPlayer(pl, mv, src.srcId, srcInfo);
			} else if (ref.kind === 'permanent') {
				const perm = run.locate(ref.id)?.inst;
				if (perm && perm.zone === 'battlefield' && !perm.phasedOut) {
					run.dealDamageToPermanent(perm, mv, src.srcId, srcInfo);
				}
			}
		}
	}
	return true;
}

/**
 * Opponent-choice graveyard/exile splits (*Tasigur*, *Coin of Fate*, *Deliver Unto Evil*).
 */
export function executeOpponentChoiceMoveWave10(run: EffectRunAccess, step: EffectStep): boolean {
	const s = run.state;
	if (step.params?.splitExiledCostCardsToBottomAndBattlefield) {
		const exiled = run.ctx.item.exiledCostCards ?? [];
		const inExile = run.you.exile.filter((c) =>
			exiled.some((ec) => ec.id === c.card.id || ec.name === c.card.name)
		);
		const pool = inExile.slice(-2);
		if (pool.length === 0) return true;
		const opp = run.apnapPlayers().find((p) => p.playerId !== run.you.playerId);
		let bottomCard = pool[0]!;
		if (opp && pool.length > 1) {
			const key = `w10_coin_fate:${run.stepIndex}`;
			const saved = run.answers[key];
			if (saved?.kind === 'chooseObjects' && saved.objectIds[0]) {
				bottomCard = pool.find((c) => c.instanceId === saved.objectIds[0]) ?? pool[0]!;
			} else if (!opp.isBot && run.canPause) {
				run.pauseForChoice(
					opp,
					`${run.ctx.title} — Choose Card for Bottom of Library`,
					`Choose one of the exiled cards; its owner puts it on the bottom of their library and returns the other to the battlefield tapped.`,
					pool.map((c) => c.instanceId),
					1,
					1,
					'exile',
					[pool[0]!.instanceId],
					key
				);
				return true;
			} else {
				bottomCard = [...pool].sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a))[0]!;
			}
		}
		for (const c of pool) {
			if (c.instanceId === bottomCard.instanceId) {
				moveObject(s, c, 'library', {
					from: { player: run.you, zone: 'exile' },
					toPlayer: run.you,
					insert: 'end',
					bumpVersion: true,
					newTimestamp: true
				});
			} else {
				moveObject(s, c, 'battlefield', {
					from: { player: run.you, zone: 'exile' },
					toPlayer: run.you,
					beforeInsert: (obj) => {
						obj.tapped = true;
					},
					bumpVersion: true,
					newTimestamp: true
				});
			}
		}
		return true;
	}

	if (step.params?.leaveChosenInGraveyardRestToHand) {
		const targets = run.objects({ k: 'target', index: 0 }).filter((c) => c.zone === 'graveyard');
		if (targets.length === 0) return true;
		const leaveCount = Math.min(2, targets.length);
		const opp = run.apnapPlayers().find((p) => p.playerId !== run.you.playerId);
		let chosenToLeave: CardInstance[];
		if (!opp || targets.length <= leaveCount) {
			chosenToLeave = targets.slice(0, leaveCount);
		} else {
			const key = `w10_deliver:${run.stepIndex}`;
			const saved = run.answers[key];
			if (saved?.kind === 'chooseObjects') {
				chosenToLeave = saved.objectIds
					.map((id) => targets.find((c) => c.instanceId === id))
					.filter((c): c is CardInstance => Boolean(c))
					.slice(0, leaveCount);
			} else if (!opp.isBot && run.canPause) {
				run.pauseForChoice(
					opp,
					`${run.ctx.title} — Choose ${leaveCount} Card(s) to Leave in Graveyard`,
					`Choose ${leaveCount} card(s) to leave in ${run.you.username}'s graveyard; the rest go to their hand.`,
					targets.map((c) => c.instanceId),
					leaveCount,
					leaveCount,
					'graveyard',
					targets.slice(0, leaveCount).map((c) => c.instanceId),
					key
				);
				return true;
			} else {
				chosenToLeave = [...targets]
					.sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a))
					.slice(0, leaveCount);
			}
		}
		const leaveSet = new Set(chosenToLeave.map((c) => c.instanceId));
		for (const c of targets) {
			if (!leaveSet.has(c.instanceId)) {
				const holder = run.player(c.ownerId) ?? run.you;
				moveObject(s, c, 'hand', {
					from: { player: holder, zone: 'graveyard' },
					toPlayer: holder,
					bumpVersion: true,
					newTimestamp: true
				});
			}
		}
		return true;
	}

	if (step.params?.chooserOverride === 'opponent' && step.subject.k === 'all') {
		const fromZone = step.params.from ?? step.subject.filter.zone ?? 'graveyard';
		const toZone = step.params.to ?? 'hand';
		const count = Math.max(1, run.amount(step.amount, 1));
		const filter: ObjectFilter = { ...step.subject.filter, zone: undefined };
		const pool =
			fromZone === 'graveyard'
				? run.you.graveyard.filter((c) => run.matches(c, filter, 'graveyard'))
				: fromZone === 'exile'
					? run.you.exile.filter((c) => run.matches(c, filter, 'exile'))
					: [];
		if (pool.length === 0) return true;
		const opps = run.apnapPlayers().filter((p) => p.playerId !== run.you.playerId);
		const opp = opps[0];
		const pickCount = Math.min(count, pool.length);
		let chosen: CardInstance[];
		if (!opp || pool.length <= pickCount) {
			chosen = pool.slice(0, pickCount);
		} else {
			const key = `w10_opp_choice:${run.stepIndex}`;
			const saved = run.answers[key];
			if (saved?.kind === 'chooseObjects') {
				chosen = saved.objectIds
					.map((id) => pool.find((c) => c.instanceId === id))
					.filter((c): c is CardInstance => Boolean(c))
					.slice(0, pickCount);
			} else if (!opp.isBot && run.canPause) {
				run.pauseForChoice(
					opp,
					`${run.ctx.title} — Opponent Chooses Card`,
					`Choose ${pickCount} card(s) from ${run.you.username}'s ${fromZone} to put into ${toZone}.`,
					pool.map((c) => c.instanceId),
					pickCount,
					pickCount,
					fromZone === 'exile' ? 'exile' : 'graveyard',
					pool.slice(0, pickCount).map((c) => c.instanceId),
					key
				);
				return true;
			} else {
				// Opponent bot prefers returning lowest-MV card
				chosen = [...pool]
					.sort((a, b) => objectManaValue(s, a) - objectManaValue(s, b))
					.slice(0, pickCount);
			}
		}
		for (const c of chosen) {
			moveObject(s, c, toZone, {
				from: { player: run.you, zone: fromZone === 'exile' ? 'exile' : 'graveyard' },
				toPlayer: run.you,
				bumpVersion: true,
				newTimestamp: true
			});
			addLog(s, 'rule', `${run.you.username} returned ${c.card.name} to ${toZone} (${run.ctx.title}).`, run.you.playerId);
		}
		return true;
	}
	return false;
}

/**
 * Registers `untilYourNextTurnCombatDirectives` (*Kardur, Doomscourge*, *The Akroan War* II)
 * or `mustAttackPlayerRef` / `mustAttackNextCombat` (*Ruhan*, *Territorial Hellkite*, *Trench Behemoth*).
 */
export function executeCombatDirectivesWave10(run: EffectRunAccess, step: EffectStep): boolean {
	const s = run.state;
	if (step.params?.untilYourNextTurnCombatDirective) {
		const dir = step.params.untilYourNextTurnCombatDirective;
		const list = (s.untilYourNextTurnCombatDirectives ??= []);
		list.push({
			sourcePlayerId: run.you.playerId,
			mustAttack: dir.mustAttack,
			...(dir.avoidYou ? { avoidYou: true } : {})
		});
		addLog(
			s,
			'rule',
			`Until ${run.you.username}'s next turn, creatures opponents control must attack each combat if able${dir.avoidYou ? ` and attack a player other than ${run.you.username} if able` : ''}.`,
			run.you.playerId
		);
		return true;
	}
	if (step.params?.mustAttackPlayerRef) {
		const targetPl = run.playerRef(step.params.mustAttackPlayerRef);
		if (!targetPl || targetPl.lost) return true;
		const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
		for (const o of objs) {
			o.mustAttackThisTurn = true;
			o.mustAttackPlayerIdThisTurn = targetPl.playerId;
		}
		return true;
	}
	if (step.params?.mustAttackNextCombat) {
		const objs = run.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
		for (const o of objs) {
			o.mustAttackNextCombat = true;
		}
		return true;
	}
	return false;
}

