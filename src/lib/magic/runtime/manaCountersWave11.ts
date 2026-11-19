/**
 * Wave 11 runtime helpers for:
 * - Conditional & restricted mana buckets (`disallowGeneric`, Cavern uncounterable, Opal bonus, anyOf filters)
 * - Dynamic mana (`Nykthos`, `Faeburrow Elder`, `Incubation Druid`, `Chrome Mox`, `Pit of Offerings`, delayed main-phase mana, retained mana)
 * - Counter movement/doubling/transfer/copy (`Goldberry`, `Nesting Grounds`, `Resourceful Defense`, `Slippery Bogbonder`, `Ichormoon Gauntlet`, `Elspeth Conquers Death` III, `Dark Intimations`)
 * - P/T doubling (`Exponential Growth`), life-total/toughness exchange (`Tree of Perdition`), hand-size difference, Wave 11 `Amount` & `Condition` evaluation.
 */
import type { Amount, Condition, EffectStep } from '../ir.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CounterType,
	type GameState,
	type ManaColor,
	type ManaPool,
	type ManaSpendContext,
	type PlainManaObjectFilter,
	type PlayerGameState
} from '../types.ts';
import { getCardFaces } from '../scryfall.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import {
	ALL_MANA_COLORS,
	addManaToPlayerPool,
	canSpendManaRestrictionSpec,
	matchesPlainManaFilter
} from './mana.ts';
import { parseManaCost } from '../oracle.ts';
import { computeDevotionToColors } from './staticsAndCostsWave5.ts';
import { effectPorts, type EffectRunAccess } from './effectsDamageAndMana.ts';
import { instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';

const FIVE_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

// ---- 1. Mana Filter & Restriction Enforcement (CR 106.6) ------------------------------------

export function matchesPlainManaAnyOfFilter(
	filter: PlainManaObjectFilter,
	chars: Parameters<typeof matchesPlainManaFilter>[1],
	chosenSubType?: string
): boolean {
	if (!filter.anyOf || filter.anyOf.length === 0) return true;
	return filter.anyOf.some((sub) => matchesPlainManaFilter(sub, chars, chosenSubType));
}

/**
 * Computes generic mana available to spend from `player` in `spendCtx`, excluding buckets whose
 * `spec.disallowGeneric` forbids paying generic mana costs (CR 106.6).
 */
export function hasEligibleGenericManaForDisallowCheck(
	player: PlayerGameState,
	req: ReturnType<typeof parseManaCost>,
	spendCtx?: ManaSpendContext
): boolean | null {
	if (!player.restrictedManaBuckets?.some((b) => b.spec.disallowGeneric)) {
		return null;
	}
	const genericOnlyPool: ManaPool = { ...player.manaPool };
	if (player.restrictedManaBuckets) {
		for (const bucket of player.restrictedManaBuckets) {
			if (bucket.spec.disallowGeneric) continue;
			if (!canSpendManaRestrictionSpec(bucket.spec, spendCtx)) continue;
			for (const c of ALL_MANA_COLORS) genericOnlyPool[c] += bucket.pool[c];
		}
	}
	const disallowedColored: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	for (const bucket of player.restrictedManaBuckets) {
		if (!bucket.spec.disallowGeneric) continue;
		if (!canSpendManaRestrictionSpec(bucket.spec, spendCtx)) continue;
		for (const c of ALL_MANA_COLORS) disallowedColored[c] += bucket.pool[c];
	}
	// First check if colored requirements can be met using disallowedColored + genericOnlyPool
	const remGenericPool: ManaPool = { ...genericOnlyPool };
	for (const c of ALL_MANA_COLORS) {
		let need = req.colored[c] ?? 0;
		const takeRestricted = Math.min(disallowedColored[c], need);
		need -= takeRestricted;
		if (need > 0) {
			if (remGenericPool[c] < need) return false;
			remGenericPool[c] -= need;
		}
	}
	const availGeneric = ALL_MANA_COLORS.reduce((sum, c) => sum + remGenericPool[c], 0);
	return availGeneric >= req.generic;
}

export function applyWave11SpentBucketEffects(
	player: PlayerGameState,
	beforeBuckets: Record<string, ManaPool>,
	bucketSpecs: Record<string, NonNullable<PlayerGameState['restrictedManaBuckets']>[number]['spec']>,
	spendCtx?: ManaSpendContext
): void {
	if (!spendCtx) return;
	for (const [key, bBefore] of Object.entries(beforeBuckets)) {
		const bucket = player.restrictedManaBuckets?.find((b) => b.key === key);
		let spentAny = false;
		for (const c of ALL_MANA_COLORS) {
			const before = bBefore[c] ?? 0;
			const after = bucket ? (bucket.pool[c] ?? 0) : 0;
			if (before > after) {
				spentAny = true;
				break;
			}
		}
		if (!spentAny) continue;
		const spec = bucket?.spec ?? bucketSpecs[key];
		if (!spec) continue;
		if (spec.onSpendCantBeCountered && spendCtx.isSpell) {
			spendCtx.spentManaGrantsUncounterable = true;
		}
		if (spec.onSpendCommanderBonusCounters && spendCtx.isSpell && spendCtx.isCommanderSpell) {
			spendCtx.spentManaCommanderBonusCounters =
				(spendCtx.spentManaCommanderBonusCounters ?? 0) + 1;
		}
	}
}

// ---- 2. Wave 11 Dynamic Mana Resolution ------------------------------------------------------

export function colorsOfExiledLinkedCards(
	state: GameState,
	sourceInstanceId: string,
	sourceObjectVersion: number
): ManaColor[] {
	const out = new Set<ManaColor>();
	for (const p of state.players) {
		for (const ex of p.exile) {
			if (
				ex.exiledBy?.sourceInstanceId !== sourceInstanceId ||
				(ex.exiledBy.sourceObjectVersion ?? 1) !== sourceObjectVersion
			) {
				continue;
			}
			const faces = getCardFaces(ex.card);
			const f0 = faces[0];
			const cols =
				f0?.colors && f0.colors.length > 0 ? f0.colors : (ex.card.colors ?? []);
			for (const c of cols) {
				if (FIVE_COLORS.includes(c)) out.add(c);
			}
		}
	}
	return FIVE_COLORS.filter((c) => out.has(c));
}

export function distinctColorsControlled(
	state: GameState,
	controllerId: string
): ManaColor[] {
	const out = new Set<ManaColor>();
	const player = state.players.find((p) => p.playerId === controllerId);
	if (!player) return [];
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		for (const c of ev.colors) {
			if (FIVE_COLORS.includes(c)) out.add(c);
		}
	}
	return FIVE_COLORS.filter((c) => out.has(c));
}

export function executeWave11AddManaStep(run: EffectRunAccess, step: EffectStep): boolean {
	const params = step.params;
	if (!params) return false;
	const addOpts = {
		restrictionSpec: params.manaRestrictionSpec,
		retainUntilEndOfTurn: Boolean(params.retainManaUntilEndOfTurn)
	};

	// *Faeburrow Elder*: "For each color among permanents you control, add one mana of that color."
	if (params.addManaPerColorControlled) {
		const cols = distinctColorsControlled(run.state, run.you.playerId);
		if (cols.length > 0) {
			for (const c of cols) {
				addManaToPlayerPool(run.you, c, 1, undefined, addOpts);
			}
			effectPorts().addLog(
				run.state,
				'cast',
				`${run.you.username} adds ${cols.map((c) => `{${c}}`).join('')}.`,
				run.you.playerId
			);
		}
		return true;
	}

	// *Chrome Mox* / *Pit of Offerings*: "Add one mana of any of the exiled card's/cards' colors."
	if (params.addManaFromExiledColors) {
		const srcId = run.sourcePerm?.instanceId ?? run.ctx.sourceId;
		const srcVer =
			run.ctx.item.sourceObjectVersion ??
			(run.sourcePerm
				? run.sourcePerm.zone === 'battlefield'
					? (run.sourcePerm.objectVersion ?? 1)
					: (run.sourcePerm.lastBattlefieldVersion ?? run.sourcePerm.objectVersion ?? 1)
				: 1);
		const cols = srcId ? colorsOfExiledLinkedCards(run.state, srcId, srcVer) : [];
		if (cols.length === 0) return true;
		const chosen: ManaColor =
			run.ctx.preferredColor && cols.includes(run.ctx.preferredColor)
				? run.ctx.preferredColor
				: cols[0];
		const nAmt = Math.max(1, run.amount(step.amount, 1));
		addManaToPlayerPool(run.you, chosen, nAmt, undefined, addOpts);
		effectPorts().addLog(run.state, 'cast', `${run.you.username} adds {${chosen}}.`, run.you.playerId);
		return true;
	}

	// *Nykthos* / *Astral Cornucopia*: "Add <amount> mana of the chosen color"
	if (params.addManaChosenColorAmount !== undefined) {
		const chosen = run.sourceChosenColor();
		if (!chosen) return true;
		let amtVal = 0;
		const a = params.addManaChosenColorAmount;
		if (a.k === 'devotion') {
			amtVal = computeDevotionToColors(run.state, run.you.playerId, [chosen]);
		} else {
			amtVal = run.amount(a, 0);
		}
		if (amtVal > 0) {
			addManaToPlayerPool(run.you, chosen, amtVal, undefined, addOpts);
			effectPorts().addLog(
				run.state,
				'cast',
				`${run.you.username} adds ${amtVal} {${chosen}}.`,
				run.you.playerId
			);
		}
		return true;
	}

	// *Mana Drain*: "At the beginning of your next main phase, add an amount of {C} equal to that spell's mana value."
	if (params.nextMainPhaseAddMana) {
		const col = params.nextMainPhaseAddMana.color ?? 'C';
		const mv = Math.max(0, run.amount(params.nextMainPhaseAddMana.amount, 0));
		if (mv > 0) {
			const pending = (run.you.pendingNextMainPhaseMana ??= {});
			pending[col] = (pending[col] ?? 0) + mv;
			effectPorts().addLog(
				run.state,
				'rule',
				`${run.you.username} will add ${mv} {${col}} at the beginning of their next main phase.`,
				run.you.playerId
			);
		}
		return true;
	}

	return false;
}

export function flushPendingNextMainPhaseMana(_state: GameState, player: PlayerGameState): void {
	if (!player.pendingNextMainPhaseMana) return;
	const pending = player.pendingNextMainPhaseMana;
	delete player.pendingNextMainPhaseMana;
	for (const c of ALL_MANA_COLORS) {
		const n = pending[c] ?? 0;
		if (n > 0) addManaToPlayerPool(player, c, n);
	}
}

// ---- 3. Wave 11 Amount Evaluator -------------------------------------------------------------

export function evaluateWave11Amount(run: EffectRunAccess, a: Amount): number | null {
	switch (a.k) {
		case 'handSizeDifference': {
			const youCount = run.you.hand.length;
			const targetP = a.targetPlayer ? run.playerRef(a.targetPlayer) : null;
			const otherCount = targetP
				? targetP.hand.length
				: Math.min(a.cap ?? 7, a.cap ?? 7);
			if (targetP) {
				return Math.max(0, otherCount - youCount);
			}
			return Math.max(0, (a.cap ?? 7) - youCount);
		}
		case 'coinHeadsCount': {
			return run.lastCountedByKind?.coinHeadsCount ?? 0;
		}
		case 'playerCounterDifference': {
			const targetP = run.playerRef(a.player);
			if (!targetP) return 0;
			const cur =
				a.counter === 'poison'
					? targetP.poison
					: a.counter === 'energy'
						? targetP.energyCounters
						: a.counter === 'experience'
							? targetP.experienceCounters
							: a.counter === 'rad'
								? (targetP.radCounters ?? 0)
								: (targetP.ticketCounters ?? 0);
			return Math.max(0, a.target - cur);
		}
		case 'distinctColorsAmongControlled': {
			return distinctColorsControlled(run.state, run.you.playerId).length;
		}
		case 'tokensCreatedThisTurn': {
			return run.you.tokensCreatedCountThisTurn ?? 0;
		}
		case 'nontokenCreaturesDiedThisTurn': {
			let count = 0;
			for (const p of run.state.players) {
				for (const g of p.graveyard) {
					if (g.isToken) continue;
					if (g.enteredGraveyardFromBattlefieldTurn !== run.state.turnNumber) continue;
					if (a.controller === 'you' && g.controllerId !== run.you.playerId) continue;
					if (resolveObjectFaces(g.card, instanceFaceOptions(g, 'graveyard')).types.includes('Creature')) count++;
				}
			}
			return count;
		}
		case 'cardsPutIntoGraveyardFromHandOrLibraryThisTurn': {
			return run.you.cardsPutIntoGraveyardFromHandOrLibraryThisTurn ?? 0;
		}
		case 'damageDealtToOpponentsThisTurn': {
			let total = 0;
			for (const p of run.state.players) {
				if (p.playerId === run.you.playerId || p.lost) continue;
				total += p.damageDealtToThisTurn ?? 0;
			}
			return total;
		}
		case 'damageDealtToSelfByPlayerThisTurn': {
			const src = run.sourcePerm;
			if (!src) return 0;
			return src.damageMarked ?? 0;
		}
		case 'playersLostLifeThisTurnCount': {
			return run.state.players.filter((p) => !p.lost && p.lostLifeThisTurn).length;
		}
		case 'greatestStatAmongControlledAsCast': {
			const stackSnap = run.ctx.item?.castGreatestControlledPower;
			if (stackSnap !== undefined) return stackSnap;
			let best = 0;
			for (const perm of run.you.battlefield) {
				if (perm.phasedOut) continue;
				if (!run.matches(perm, a.filter, 'battlefield')) continue;
				const ev = evaluatePermanent(run.state, perm);
				const val = a.stat === 'power' ? ev.power : ev.toughness;
				if (val > best) best = val;
			}
			return best;
		}
		case 'colorsOfManaSpentToCast': {
			return run.ctx.item?.manaColorsSpent?.length ?? run.sourcePerm?.manaColorsSpent?.length ?? 0;
		}
		case 'lkiTotalCounters': {
			const snap = run.refSnapshot(a.of, true);
			if (!snap?.counters) return 0;
			return Object.values(snap.counters).reduce<number>((sum, v) => sum + (v ?? 0), 0);
		}
		case 'revealedCostStat': {
			const rc = run.ctx.item?.revealedCostCard;
			if (!rc) return 0;
			if (a.stat === 'manaValue') return rc.cmc ?? 0;
			if (a.stat === 'power') return parseInt(rc.power ?? '0', 10) || 0;
			return parseInt(rc.toughness ?? '0', 10) || 0;
		}
		case 'opponentsControllingFilterCount': {
			let count = 0;
			for (const opp of run.state.players) {
				if (opp.playerId === run.you.playerId || opp.lost) continue;
				if (
					opp.battlefield.some(
						(perm) => !perm.phasedOut && run.matches(perm, a.filter, 'battlefield')
					)
				) {
					count++;
				}
			}
			return count;
		}
		case 'distinctCounterKindsOn': {
			const id = run.refId(a.of);
			if (!id) return 0;
			const loc = run.locate(id);
			if (!loc) return 0;
			return Object.values(loc.inst.counters).filter((v) => (v ?? 0) > 0).length;
		}
		case 'totalCountersAmong': {
			let total = 0;
			for (const p of run.state.players) {
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (!run.matches(perm, a.filter, 'battlefield')) continue;
					for (const v of Object.values(perm.counters)) total += v ?? 0;
				}
			}
			return total;
		}
		case 'ringBearerPower': {
			const rbId = run.you.ringBearerId;
			if (!rbId) return 0;
			const loc = run.locate(rbId);
			if (!loc || loc.zone !== 'battlefield' || loc.inst.phasedOut) return 0;
			return evaluatePermanent(run.state, loc.inst).power;
		}
		case 'distinctPowersControlled': {
			const powers = new Set<number>();
			for (const perm of run.you.battlefield) {
				if (perm.phasedOut) continue;
				const ev = evaluatePermanent(run.state, perm);
				if (ev.isCreature) powers.add(ev.power);
			}
			return powers.size;
		}
		case 'sacrificedPermsThisTurn': {
			return run.you.sacrificedCardsThisTurn?.length ?? 0;
		}
		case 'countedThisWay': {
			if (a.kind === 'revealedThisWay') {
				return run.lastCountedByKind?.revealedThisWay ?? 0;
			}
			return null;
		}
		default:
			return null;
	}
}

// ---- 4. Wave 11 Condition Evaluator ----------------------------------------------------------

export function evaluateWave11Condition(run: EffectRunAccess, c: Condition): boolean | null {
	switch (c.k) {
		case 'createdTokenThisTurn': {
			return (run.you.tokensCreatedCountThisTurn ?? 0) > 0;
		}
		case 'sameNameLandsControlledAtLeast': {
			const counts = new Map<string, number>();
			for (const perm of run.you.battlefield) {
				if (perm.phasedOut || perm.isFaceDown) continue;
				const ev = evaluatePermanent(run.state, perm);
				if (!ev.isLand) continue;
				const n = ev.effectiveName;
				const next = (counts.get(n) ?? 0) + 1;
				if (next >= c.min) return true;
				counts.set(n, next);
			}
			return false;
		}
		case 'attachedPermanentMatches': {
			const attachedId = run.sourcePerm?.attachedToId;
			if (!attachedId) return false;
			const loc = run.locate(attachedId);
			if (!loc || loc.zone !== 'battlefield' || loc.inst.phasedOut) return false;
			if (c.untapped && loc.inst.tapped) return false;
			if (c.colors?.length) {
				const ev = evaluatePermanent(run.state, loc.inst);
				if (!c.colors.some((col) => ev.colors.includes(col))) return false;
			}
			return true;
		}
		case 'playedLandThisTurn': {
			return Boolean(run.you.playedLandThisTurn || (run.you.landsPlayedThisTurn ?? 0) > 0);
		}
		case 'sourceHasCounter': {
			const src = run.sourcePerm;
			if (!src) return false;
			return (src.counters[c.counter] ?? 0) >= (c.min ?? 1);
		}
		case 'distinctCardTypesAmongSacrificedAtLeast': {
			const types = new Set<string>();
			for (const lki of run.ctx.item?.sacrificedCostLki ?? []) {
				for (const ct of lki.types) types.add(ct);
			}
			return types.size >= c.min;
		}
		case 'creatureCardMilledThisWay': {
			return (run.lastCountedByKind?.creatureCardsMilledThisWay ?? 0) > 0;
		}
		case 'landCardMilledThisWay': {
			return (run.lastCountedByKind?.landCardsMilledThisWay ?? 0) > 0;
		}
		case 'returnedFilterToHandThisWay': {
			for (const list of run.bindings.values()) {
				for (const ref of list) {
					const loc = run.locate(ref.id);
					if (loc && run.matches(loc.inst, c.filter, 'hand')) return true;
				}
			}
			return false;
		}
		case 'discardedNonlandThisWay': {
			return (run.lastCountedByKind?.discardedNonlandThisWay ?? 0) > 0;
		}
		case 'discardedCreatureThisWay': {
			return (run.lastCountedByKind?.discardedCreatureThisWay ?? 0) > 0;
		}
		case 'discardedNoncreatureThisWay': {
			return (run.lastCountedByKind?.discardedNoncreatureThisWay ?? 0) > 0;
		}
		case 'playerHasFewerHandThan': {
			const pl = c.targetPlayer ? run.playerRef(c.targetPlayer) : run.you;
			return Boolean(pl && pl.hand.length < (c.max ?? 7));
		}
		case 'playerHasFewerCountersThan': {
			const cur =
				c.counter === 'poison'
					? run.you.poison
					: c.counter === 'energy'
						? run.you.energyCounters
						: c.counter === 'experience'
							? run.you.experienceCounters
							: c.counter === 'rad'
								? (run.you.radCounters ?? 0)
								: (run.you.ticketCounters ?? 0);
			return cur < c.max;
		}
		case 'targetHasFewerCountersThan': {
			const tId = run.ctx.targets[0]?.id;
			const targetP = run.player(tId ?? '');
			if (!targetP) return false;
			const cur =
				c.counter === 'poison'
					? targetP.poison
					: c.counter === 'energy'
						? targetP.energyCounters
						: c.counter === 'experience'
							? targetP.experienceCounters
							: c.counter === 'rad'
								? (targetP.radCounters ?? 0)
								: (targetP.ticketCounters ?? 0);
			return cur < c.max;
		}
		case 'spellCastFromHand': {
			return run.ctx.item?.castFromZone === 'hand';
		}
		case 'spellCastFromGraveyard': {
			return run.ctx.item?.castFromZone === 'graveyard';
		}
		case 'spellCastFromExile': {
			return run.ctx.item?.castFromZone === 'exile';
		}
		case 'noSpellCastThisTurn': {
			return (run.you.spellsCastThisTurn ?? 0) === 0;
		}
		case 'notDrawnCardsThisWay': {
			return (run.lastCountedByKind?.drawnThisWay ?? 0) === 0;
		}
		case 'exiledCountAtLeast': {
			const ids = run.bindings.get('exiled') ?? [];
			return ids.length >= c.min;
		}
		case 'didRevealThisWay': {
			return (run.lastCountedByKind?.revealedThisWay ?? 0) > 0;
		}
		case 'ringBearerAndTemptedAtLeast': {
			const src = run.sourcePerm;
			if (!src) return false;
			return run.you.ringBearerId === src.instanceId && (run.you.ringLevel ?? 0) >= c.min;
		}
		case 'eventObjectGreatestPowerAmongAll': {
			const evId = run.ctx.eventObjectId;
			if (!evId) return false;
			const loc = run.locate(evId);
			if (!loc || loc.zone !== 'battlefield' || loc.inst.phasedOut) return false;
			const evPower = evaluatePermanent(run.state, loc.inst).power;
			for (const p of run.state.players) {
				for (const perm of p.battlefield) {
					if (perm.phasedOut || perm.instanceId === evId) continue;
					const pe = evaluatePermanent(run.state, perm);
					if (pe.isCreature && pe.power >= evPower) return false;
				}
			}
			return true;
		}
		case 'wonClashThisWay': {
			if (run.lastInlineStepDecision !== undefined) return run.lastInlineStepDecision;
			if ((run.lastCountedByKind?.wonClash ?? 0) > 0) return true;
			for (let k = run.stepIndex - 1; k >= 0; k--) {
				if (k in run.stepDecisions) return Boolean(run.stepDecisions[k]);
			}
			return false;
		}
		case 'sacrificedNonlandThisWay': {
			return (run.lastCountedByKind?.sacrificedNonlandThisWay ?? 0) > 0;
		}
		case 'didntPutOntoBattlefieldThisWay': {
			return (run.lastCountedByKind?.putOntoBattlefieldThisWay ?? 0) === 0;
		}
		case 'castTriggerCreatureSpell': {
			return (run.lastCountedByKind?.castTriggerCreatureSpell ?? 0) > 0;
		}
		case 'controlAttackingLegendary': {
			const combatIds = new Set(
				run.state.combat?.attackers.map((a) => a.attackerInstanceId) ?? []
			);
			return run.you.battlefield.some((perm) => {
				if (perm.phasedOut || !combatIds.has(perm.instanceId)) return false;
				const ev = evaluatePermanent(run.state, perm);
				return ev.isCreature && ev.effectiveTypeLine.includes('Legendary');
			});
		}
		case 'allPlayersCantCastCheck': {
			return Boolean(run.state.allPlayersCantCastSpellsThisTurn);
		}
		case 'selfRemovedFromCombatOrAttached': {
			const src = run.sourcePerm;
			if (!src || src.zone !== 'battlefield' || src.phasedOut) return false;
			return Boolean(src.attachedToId);
		}
		case 'eventSpellMatchesFilter': {
			const evId = run.ctx.eventObjectId;
			if (!evId) return false;
			const stk = run.state.stack.find((s) => s.id === evId || s.sourceInstanceId === evId);
			if (!stk?.card) return false;
			const proxy: CardInstance = {
				instanceId: stk.sourceInstanceId,
				card: stk.card,
				ownerId: stk.ownerId ?? stk.controllerId,
				controllerId: stk.controllerId,
				zone: 'stack',
				tapped: false,
				summoningSick: false,
				counters: createEmptyCounterMap(),
				tempPowerMod: 0,
				tempToughnessMod: 0,
				grantedKeywords: [],
				attachedToId: null,
				isToken: Boolean(stk.isCopy),
				damageMarked: 0,
				deathtouchDamageMarked: false,
				usedLoyaltyThisTurn: false,
				isCommander: false,
				commanderCastCount: stk.commanderCastCount ?? 0,
				transformed: false
			};
			return run.matches(proxy, c.filter, 'battlefield');
		}
		case 'eventObjectMatchesOrSubtype': {
			const evId = run.ctx.eventObjectId;
			if (!evId) return false;
			const loc = run.locate(evId);
			if (!loc) return false;
			return run.matches(loc.inst, c.filter, loc.zone === 'command' ? 'exile' : loc.zone);
		}
		case 'didLastOptionalStep': {
			if (run.lastInlineStepDecision !== undefined) return run.lastInlineStepDecision;
			for (let k = run.stepIndex - 1; k >= 0; k--) {
				if (k in run.stepDecisions) return Boolean(run.stepDecisions[k]);
			}
			return false;
		}
		case 'sourceExiledThisWay': {
			const srcId = run.sourcePerm?.instanceId;
			if (!srcId) return false;
			const loc = run.locate(srcId);
			return Boolean(loc && loc.zone === 'exile' && (run.lastCountedByKind?.exiledThisWay ?? 0) > 0);
		}
		case 'attackedWithCommanderThisTurn': {
			return run.state.players.some((p) => p.attackedWithCommanderThisTurn);
		}
		case 'controlsFilter': {
			return run.you.battlefield.some(
				(perm) => !perm.phasedOut && run.matches(perm, c.filter, 'battlefield')
			);
		}
		default:
			return null;
	}
}

// ---- 5. Counter Movement, Copying, Doubling, & Toughness/Life Exchange -----------------------

export function executeWave11PutCountersExtras(
	run: EffectRunAccess,
	step: EffectStep,
	placeCounter: (perm: CardInstance, counter: CounterType, count: number) => void
): boolean {
	const params = step.params;
	if (!params) return false;

	// *Ichormoon Gauntlet* / *Clockspinning*
	if (params.chooseCounterOnSubjectAndAddOne) {
		const objs = run.objects(step.subject);
		for (const obj of objs) {
			const kinds = Object.entries(obj.counters)
				.filter(([, v]) => (v ?? 0) > 0)
				.map(([k]) => k as CounterType);
			if (kinds.length === 0) continue;
			const chosenKind = kinds[0];
			const delta = params.removeInsteadOfAdd ? -1 : 1;
			if (delta < 0) {
				obj.counters[chosenKind] = Math.max(0, (obj.counters[chosenKind] ?? 0) - 1);
				if ((obj.counters[chosenKind] ?? 0) === 0) delete obj.counters[chosenKind];
				noteLayerInputsChanged(run.state);
			} else {
				placeCounter(obj, chosenKind, 1);
			}
		}
		return true;
	}

	// *Elspeth Conquers Death* III / *Forge of Heroes*
	if (params.conditionalCounterOnType) {
		const spec = params.conditionalCounterOnType;
		const objs = run.objects(step.subject);
		for (const obj of objs) {
			const ev = obj.zone === 'battlefield' ? evaluatePermanent(run.state, obj) : null;
			const isCreature = Boolean(ev?.isCreature);
			const isPw = Boolean(ev?.isPlaneswalker);
			let chosen: CounterType | null = null;
			if (isCreature && !isPw) chosen = spec.creatureCounter;
			else if (isPw && !isCreature) chosen = spec.planeswalkerCounter;
			else if (isCreature && isPw) chosen = spec.creatureCounter;
			if (chosen) placeCounter(obj, chosen, Math.max(1, run.amount(step.amount, 1)));
		}
		return true;
	}

	// *Dark Intimations*: "That planeswalker enters with an additional loyalty counter on it"
	if (params.castBolasBonusLoyalty) {
		const evId = run.ctx.eventObjectId;
		if (evId) {
			const stk = run.state.stack.find((s) => s.id === evId || s.sourceInstanceId === evId);
			if (stk) {
				stk.bonusLoyaltyCounters = (stk.bonusLoyaltyCounters ?? 0) + 1;
			} else {
				const loc = run.locate(evId);
				if (loc?.zone === 'battlefield') {
					placeCounter(loc.inst, 'loyalty', 1);
				}
			}
		}
		return true;
	}

	return false;
}

export function executeWave11MoveCounters(
	run: EffectRunAccess,
	step: EffectStep,
	placeCounter: (perm: CardInstance, counter: CounterType, count: number) => void
): boolean {
	const spec = step.params?.moveCounterSpec;
	if (!spec) return false;
	const hasWave11Flag =
		spec.eachKindNotOnDest ||
		spec.oneOrMore ||
		spec.chooseKindOnPermanent ||
		spec.fromAnyPermanents ||
		spec.anyNumber;
	if (!hasWave11Flag) return false;

	const dests = run.objects(step.subject).filter((p) => p.zone === 'battlefield' && !p.phasedOut);
	const dest = dests[0];
	if (!dest) return true;

	const sources = run
		.objects(spec.from)
		.filter((p) => p.zone === 'battlefield' && !p.phasedOut && p.instanceId !== dest.instanceId);

	if (spec.eachKindNotOnDest) {
		const src = sources[0];
		if (!src) return true;
		for (const [kind, cnt] of Object.entries(src.counters)) {
			if ((cnt ?? 0) <= 0) continue;
			if ((dest.counters[kind] ?? 0) > 0) continue;
			src.counters[kind] = (src.counters[kind] ?? 0) - 1;
			if ((src.counters[kind] ?? 0) <= 0) delete src.counters[kind];
			placeCounter(dest, kind as CounterType, 1);
		}
		noteLayerInputsChanged(run.state);
		return true;
	}

	if (spec.fromAnyPermanents) {
		for (const src of sources) {
			for (const [kind, cnt] of Object.entries(src.counters)) {
				if ((cnt ?? 0) <= 0) continue;
				const moveN = cnt ?? 0;
				delete src.counters[kind];
				placeCounter(dest, kind as CounterType, moveN);
			}
		}
		noteLayerInputsChanged(run.state);
		return true;
	}

	const src = sources[0];
	if (!src) return true;
	const availKinds = Object.entries(src.counters)
		.filter(([, v]) => (v ?? 0) > 0)
		.map(([k]) => k as CounterType);
	if (availKinds.length === 0) return true;

	if (spec.chooseKindOnPermanent) {
		const kind = availKinds[0];
		const take = Math.min(src.counters[kind] ?? 0, 1);
		if (take > 0) {
			src.counters[kind] = (src.counters[kind] ?? 0) - take;
			if ((src.counters[kind] ?? 0) <= 0) delete src.counters[kind];
			placeCounter(dest, kind, take);
			noteLayerInputsChanged(run.state);
		}
		return true;
	}

	// `anyNumber` / `oneOrMore` (Goldberry / Tidus / Resourceful Defense): move all selected or 1
	const moveAll = Boolean(spec.anyNumber || spec.all);
	for (const kind of availKinds) {
		const cur = src.counters[kind] ?? 0;
		if (cur <= 0) continue;
		const amt = moveAll ? cur : 1;
		src.counters[kind] = cur - amt;
		if ((src.counters[kind] ?? 0) <= 0) delete src.counters[kind];
		placeCounter(dest, kind, amt);
		if (!moveAll) break;
	}
	noteLayerInputsChanged(run.state);
	return true;
}

export function executeWave11DoubleOrTriple(run: EffectRunAccess, step: EffectStep): boolean {
	const ds = step.params?.doubleSpec;
	const repAmt = step.params?.repeatFactorCount;
	if (!ds || !repAmt) return false;
	const reps = Math.max(0, run.amount(repAmt, 0));
	if (reps === 0) return true;
	const mult = Math.pow(ds.factor, Math.min(reps, 30));
	const objs = run.objects(step.subject).filter((p) => p.zone === 'battlefield' && !p.phasedOut);
	for (const perm of objs) {
		const curPower = evaluatePermanent(run.state, perm).power;
		const delta = curPower * (mult - 1);
		if (ds.duration === 'endOfTurn') {
			perm.tempPowerMod += delta;
		} else {
			const contList = (run.state.timedContinuousEffects ??= []);
			run.state.nextTimestamp = (run.state.nextTimestamp ?? 1) + 1;
			contList.push({
				timestamp: run.state.nextTimestamp,
				sourceName: run.sourcePerm?.card.name ?? 'Power Doubling',
				controllerId: run.you.playerId,
				expires: ds.duration === 'untilYourNextTurn' ? 'untilYourNextTurn' : 'endOfTurn',
				expiresOnTurnStartOfPlayerId: run.you.playerId,
				affected: [{ instanceId: perm.instanceId, objectVersion: perm.objectVersion }],
				layer7c: { power: delta, toughness: 0 }
			});
		}
	}
	noteLayerInputsChanged(run.state);
	return true;
}
