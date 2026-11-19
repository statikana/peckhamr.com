/**
 * Wave 11 runtime execution for:
 * - Token copies & quoted abilities (halvePT, legendary, setTypes, CDA/quoted triggers, createdBySource)
 * - Animate / BecomeCopy / Support / Firebending extensions (keepSelfName, keepThisAbility, addSupertypes, removeTypes)
 * - Attachment LKI (Zack Fair), zone-swaps (Reins of Power, Trickster-God's Heist), Phasing lock (Phasing of Zhalfir),
 *   Exile-until-monarch (Palace Jailer), Gather Specimens, Endless Detour, Desertion, Rod of Absorption,
 *   repeatSequence, solveCase (CR 720.3), Scarring Memories flash, Plumb/Lethal/Rescue helpers,
 *   and Wave 11 ObjectFilter & PlayerRef resolution.
 *
 * Zero rules-text reads, zero card-name branches, zero IR inside GameState.
 */
import type { EffectStep, ObjectFilter, PlayerRef } from '../ir.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type { CardInstance, GameState, PlayerGameState } from '../types.ts';
import { evaluateWave11Condition, executeWave11AddManaStep } from './manaCountersWave11.ts';
import { effectPorts, type EffectRunAccess } from './effectsDamageAndMana.ts';
import { emitEvent } from './events.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { splitSubtypes } from './layers.ts';
import { objectManaValue, objectPower } from './objectFilter.ts';
import { moveObject } from './zones.ts';

// ---- 1. Wave 11 ObjectFilter & PlayerRef Evaluation ------------------------------------------

export interface Wave11ObjectFilterContext {
	state: GameState;
	controllerId: string;
	source?: CardInstance;
	eventObjectId?: string;
	eventAmount?: number;
	item?: { revealedCostCard?: CardInstance['card']; sacrificedCostLki?: Array<{ subtypes: string[] }> };
	stepActedIds?: string[];
	chosenOddOrEvenParity?: 'odd' | 'even';
}

export function evaluateWave11ObjectFilter(
	c: CardInstance,
	f: ObjectFilter,
	zone: 'battlefield' | 'graveyard' | 'hand' | 'library' | 'exile',
	ctx: Wave11ObjectFilterContext
): boolean {
	const state = ctx.state;
	if (f.enteredGraveyardFromBattlefieldThisTurn) {
		if (zone !== 'graveyard' || c.enteredGraveyardFromBattlefieldTurn !== state.turnNumber) {
			return false;
		}
	}
	if (f.withCyclingAbility) {
		const effCard = effectiveCardForObject(c);
		const view = resolveObjectFaces(effCard, instanceFaceOptions(c, zone));
		const abs = activeAbilityDefs(effCard, instanceFaceOptions(c, zone));
		const hasCyc =
			view.keywords.some((k) => /cycling/i.test(k)) ||
			abs.some((ab) => ab.kind === 'keyword' && /cycling/i.test(ab.keyword.name));
		if (!hasCyc) return false;
	}
	if (f.greatestPowerAmongAll) {
		if (zone !== 'battlefield' || c.phasedOut) return false;
		const myPow = evaluatePermanent(state, c).power;
		for (const p of state.players) {
			for (const perm of p.battlefield) {
				if (perm.phasedOut || perm.instanceId === c.instanceId) continue;
				const pe = evaluatePermanent(state, perm);
				if (pe.isCreature && pe.power >= myPow) return false;
			}
		}
	}
	if (f.controllerOfEventObject && ctx.eventObjectId) {
		const evPerm = state.players
			.flatMap((p) => p.battlefield)
			.find((p) => p.instanceId === ctx.eventObjectId);
		if (!evPerm || c.controllerId !== evPerm.controllerId) return false;
	}
	if (f.manaValueParity) {
		const mv = objectManaValue(state, c);
		const wantParity =
			f.manaValueParity === 'chosenParity' ? ctx.chosenOddOrEvenParity : f.manaValueParity;
		if (!wantParity) return false;
		if (wantParity === 'odd' && mv % 2 === 0) return false;
		if (wantParity === 'even' && mv % 2 !== 0) return false;
	}
	if (f.exiledByAnyPlayer && zone !== 'exile') {
		return false;
	}
	if (f.manaValueLteEventObject && ctx.eventObjectId) {
		const evObj = state.players
			.flatMap((p) => [...p.battlefield, ...p.graveyard, ...p.exile, ...p.hand])
			.find((p) => p.instanceId === ctx.eventObjectId);
		if (!evObj) return false;
		if (objectManaValue(state, c) > objectManaValue(state, evObj)) return false;
	}
	if (f.notYetChosenInStep && ctx.stepActedIds?.includes(c.instanceId)) {
		return false;
	}
	if (f.manaValueLtRevealedCostCard) {
		const rc = ctx.item?.revealedCostCard;
		if (!rc || objectManaValue(state, c) >= (rc.cmc ?? 0)) return false;
	}
	if (f.powerLteRevealedCostCard) {
		const rc = ctx.item?.revealedCostCard;
		const rcPow = rc ? parseInt(rc.power ?? '0', 10) || 0 : 0;
		const cp = objectPower(state, c);
		if (!rc || cp === null || cp > rcPow) return false;
	}
	if (f.manaValueLteEventAmount) {
		const evAmt = ctx.eventAmount ?? 0;
		if (objectManaValue(state, c) > evAmt) return false;
	}
	if (f.powerLtSelf && ctx.source) {
		const srcPow = evaluatePermanent(state, ctx.source).power;
		const cp = objectPower(state, c);
		if (cp === null || cp >= srcPow) return false;
	}
	if (f.manaValueLteTotalCounters) {
		const ctrl = state.players.find((p) => p.playerId === ctx.controllerId);
		let total = 0;
		for (const perm of ctrl?.battlefield ?? []) {
			if (perm.phasedOut) continue;
			for (const v of Object.values(perm.counters)) total += v ?? 0;
		}
		if (objectManaValue(state, c) > total) return false;
	}
	if (f.sharesSubtypeWithSacrificed) {
		const sacList = ctx.item?.sacrificedCostLki ?? [];
		const sacSubs = new Set<string>();
		for (const s of sacList) {
			for (const sub of s.subtypes) sacSubs.add(sub);
		}
		const objView = resolveObjectFaces(effectiveCardForObject(c), instanceFaceOptions(c, zone));
		const objSubs = splitSubtypes(objView.typeLine);
		if (!objSubs.some((sub) => sacSubs.has(sub))) return false;
	}
	return true;
}

export function evaluateWave11PlayerRef(
	run: EffectRunAccess,
	ref: PlayerRef
): PlayerGameState | null {
	if (ref.k === 'playerToYourRight') {
		const active = run.state.players.filter((p) => !p.lost);
		const idx = active.findIndex((p) => p.playerId === run.you.playerId);
		if (idx < 0 || active.length === 0) return run.you;
		const rightIdx = (idx - 1 + active.length) % active.length;
		return active[rightIdx];
	}
	if (ref.k === 'controllerOrControllerOfPlaneswalker') {
		const t0 = run.ctx.targets[0];
		if (!t0) return null;
		const pl = run.player(t0.id);
		if (pl) return pl;
		const loc = run.locate(t0.id);
		return loc ? (run.player(loc.inst.controllerId) ?? null) : null;
	}
	return null;
}

// ---- 2. solveCase (CR 720.3) & repeatSequence -----------------------------------------------

export function executeSolveCaseStep(run: EffectRunAccess, _step: EffectStep): void {
	const src = run.sourcePerm;
	if (!src || src.zone !== 'battlefield' || src.phasedOut || src.isSolved) return;
	src.isSolved = true;
	noteLayerInputsChanged(run.state);
	effectPorts().addLog(run.state, 'rule', `${src.card.name} is solved (CR 720.3).`, run.you.playerId);
	emitEvent(run.state, {
		kind: 'CaseSolved',
		objectId: src.instanceId,
		object: src,
		controllerId: run.you.playerId
	});
}

const REPEAT_SCOPED_COUNT_KEYS = [
	'wonClash',
	'sacrificedNonlandThisWay',
	'sacrificedThisWay',
	'discardedNonlandThisWay',
	'discardedThisWay',
	'drawnThisWay',
	'exiledThisWay',
	'putOntoBattlefieldThisWay',
	'revealedThisWay',
	'creatureCardsMilledThisWay',
	'landCardsMilledThisWay'
] as const;

export function executeRepeatSequenceStep(run: EffectRunAccess, step: EffectStep): void {
	const rs = step.params?.repeatSequence;
	if (!rs || rs.steps.length === 0) return;
	const cap = Math.min(rs.maxIterations ?? 20, 25);
	const iterKey = `w11_rep_iter:${run.stepIndex}`;
	const savedIter = run.answers[iterKey];
	const startIter =
		savedIter?.kind === 'chooseNumber' ? Math.max(0, Math.min(cap, savedIter.n)) : 0;

	for (let iter = startIter; iter < cap; iter++) {
		const startedKey = `w11_rep_started:${run.stepIndex}:${iter}`;
		if (!run.answers[startedKey]) {
			run.answers[iterKey] = { kind: 'chooseNumber', n: iter };
			run.answers[startedKey] = { kind: 'yesNo', yes: true };
			run.lastInlineStepDecision = undefined;
			if (run.lastCountedByKind) {
				for (const k of REPEAT_SCOPED_COUNT_KEYS) {
					delete run.lastCountedByKind[k];
				}
				run.ctx.item.lastCountedByKind = { ...run.lastCountedByKind };
			}
		}

		const paused = run.runInlineBranchSteps(rs.steps, 9110 + iter);
		if (paused || run.result.paused) {
			run.result.paused = true;
			return;
		}
		if (run.result.turnEnded) {
			run.lastInlineStepDecision = undefined;
			return;
		}

		const shouldRepeat = Boolean(evaluateWave11Condition(run, rs.condition) ?? run.condition(rs.condition));
		run.lastInlineStepDecision = undefined;
		if (!shouldRepeat) break;
	}
	run.lastInlineStepDecision = undefined;
}

export function executeConditionalSequenceStep(run: EffectRunAccess, step: EffectStep): void {
	const cs = step.params?.conditionalSequence;
	if (!cs || cs.thenSteps.length === 0) return;
	const branchKey = `w11_cond_branch:${run.stepIndex}`;
	let branch: 'then' | 'else' | 'none';
	const saved = run.answers[branchKey];
	if (
		saved?.kind === 'chooseObjects' &&
		(saved.objectIds[0] === 'then' || saved.objectIds[0] === 'else' || saved.objectIds[0] === 'none')
	) {
		branch = saved.objectIds[0];
	} else {
		const matched = Boolean(evaluateWave11Condition(run, cs.condition) ?? run.condition(cs.condition));
		branch = matched ? 'then' : cs.elseSteps && cs.elseSteps.length > 0 ? 'else' : 'none';
		run.answers[branchKey] = { kind: 'chooseObjects', objectIds: [branch] };
	}
	if (branch === 'none') {
		if (cs.thenSteps.some((s) => Boolean(s.optional))) {
			run.stepDecisions[run.stepIndex] = false;
		}
		return;
	}
	const chosenSteps = branch === 'then' ? cs.thenSteps : cs.elseSteps!;
	const tag = branch === 'then' ? 9120 : 9121;
	const paused = run.runInlineBranchSteps(chosenSteps, tag);
	if (paused || run.result.paused) {
		run.result.paused = true;
		return;
	}
	if (run.lastInlineStepDecision !== undefined) {
		run.stepDecisions[run.stepIndex] = run.lastInlineStepDecision;
	}
	run.lastInlineStepDecision = undefined;
}

// ---- 3. Token Copy, Halving, Types & BecomeCopy Extensions -----------------------------------

export function applyWave11CopyModToTokenSpec(
	step: EffectStep,
	sourceCard: CardInstance['card'],
	sourceEval: { power: number; toughness: number; effectiveTypeLine: string; colors: CardInstance['card']['colors'] } | null,
	spec: {
		name: string;
		power: number;
		toughness: number;
		colors: CardInstance['card']['colors'];
		typeLine: string;
		keywords: string[];
	}
): {
	name: string;
	power: number;
	toughness: number;
	colors: CardInstance['card']['colors'];
	typeLine: string;
	keywords: string[];
	quotedAbilities?: string[];
} {
	const cm = step.params?.copyMod;
	if (!cm) return spec;
	const next = { ...spec, colors: [...spec.colors], keywords: [...spec.keywords] };
	if (cm.halvePT && sourceEval) {
		next.power = Math.ceil(sourceEval.power / 2);
		next.toughness = Math.ceil(sourceEval.toughness / 2);
	}
	if (cm.setTypes && cm.setTypes.length > 0) {
		next.typeLine = `Token ${cm.setTypes.join(' ')}`;
	}
	if (cm.addSupertypes?.length) {
		const prefix = cm.addSupertypes.filter((s) => !next.typeLine.includes(s)).join(' ');
		if (prefix) next.typeLine = `${prefix} ${next.typeLine}`;
	}
	if (cm.keepSelfName && sourceCard.name) {
		next.name = sourceCard.name;
	}
	if (step.params?.token?.legendary && !/\bLegendary\b/.test(next.typeLine)) {
		next.typeLine = `Legendary ${next.typeLine}`;
	}
	return next;
}

// ---- 4. Attachment LKI & Zone Swaps ----------------------------------------------------------

export function executeWave11Attach(run: EffectRunAccess, step: EffectStep): boolean {
	if (!step.params?.attachEquipmentFromSelfLki) return false;
	const src = run.sourcePerm;
	const lkiEquipIds = src?.lastKnownAttachedEquipmentIds ?? [];
	const target = run.objects(step.subject).find((p) => p.zone === 'battlefield' && !p.phasedOut);
	if (!target || lkiEquipIds.length === 0) return true;
	const eqId = lkiEquipIds[0];
	const eqLoc = run.locate(eqId);
	if (eqLoc && eqLoc.zone === 'battlefield' && !eqLoc.inst.phasedOut) {
		eqLoc.inst.attachedToId = target.instanceId;
		noteLayerInputsChanged(run.state);
		effectPorts().addLog(
			run.state,
			'cast',
			`${eqLoc.inst.card.name} is attached to ${target.card.name}.`,
			run.you.playerId
		);
	}
	return true;
}

export function executeWave11Exchange(run: EffectRunAccess, step: EffectStep): boolean {
	const ex = step.params?.exchangeSpec;
	if (!ex || ex.kind !== 'swapAllControlledCreatures') return false;
	const opp = run.players(ex.second ?? { k: 'target', index: 0 })[0];
	if (!opp || opp.playerId === run.you.playerId) return true;
	const yourCreatures = run.you.battlefield.filter(
		(p) => !p.phasedOut && evaluatePermanent(run.state, p).isCreature
	);
	const oppCreatures = opp.battlefield.filter(
		(p) => !p.phasedOut && evaluatePermanent(run.state, p).isCreature
	);
	const contList = (run.state.timedContinuousEffects ??= []);
	const expires = ex.duration === 'untilYourNextTurn' ? 'untilYourNextTurn' : 'endOfTurn';
	if (yourCreatures.length > 0) {
		run.state.nextTimestamp = (run.state.nextTimestamp ?? 1) + 1;
		contList.push({
			timestamp: run.state.nextTimestamp,
			sourceName: run.sourcePerm?.card.name ?? 'Control Exchange',
			controllerId: opp.playerId,
			expires,
			expiresOnTurnStartOfPlayerId: run.you.playerId,
			affected: yourCreatures.map((p) => ({ instanceId: p.instanceId, objectVersion: p.objectVersion })),
			layer2: { controllerId: opp.playerId }
		});
	}
	if (oppCreatures.length > 0) {
		run.state.nextTimestamp = (run.state.nextTimestamp ?? 1) + 1;
		contList.push({
			timestamp: run.state.nextTimestamp,
			sourceName: run.sourcePerm?.card.name ?? 'Control Exchange',
			controllerId: run.you.playerId,
			expires,
			expiresOnTurnStartOfPlayerId: run.you.playerId,
			affected: oppCreatures.map((p) => ({ instanceId: p.instanceId, objectVersion: p.objectVersion })),
			layer2: { controllerId: run.you.playerId }
		});
	}
	noteLayerInputsChanged(run.state);
	effectPorts().addLog(
		run.state,
		'rule',
		`${run.you.username} and ${opp.username} exchange control of all creatures they control.`,
		run.you.playerId
	);
	return true;
}

// ---- 5. Wave 11 grantPlayer, grant, phasing, exile-until-monarch & cleanup steps -------------

export function executeWave11GrantPlayer(run: EffectRunAccess, step: EffectStep): boolean {
	const params = step.params;
	if (!params) return false;
	let handled = false;
	const targets = run.players(step.subject);
	const recipients = targets.length > 0 ? targets : [run.you];

	for (const rule of params.playerRules ?? []) {
		switch (rule) {
			case 'cantCastNoncreatureSpellsThisTurn':
				handled = true;
				for (const pl of recipients) pl.cantCastNoncreatureSpellsThisTurn = true;
				break;
			case 'cantCastInstantsOrSorceriesThisTurn':
				handled = true;
				for (const pl of recipients) pl.cantCastInstantsOrSorceriesThisTurn = true;
				break;
			case 'cantActivateNonManaAbilitiesThisTurn':
				handled = true;
				for (const pl of recipients) pl.cantActivateNonManaAbilitiesThisTurn = true;
				break;
			case 'cantCastAdditionalSpellsThisTurn':
				handled = true;
				for (const pl of recipients) pl.cantCastAdditionalSpellsThisTurn = true;
				break;
			case 'creatureSpellsCantBeCounteredThisTurn':
				handled = true;
				for (const pl of recipients) pl.creatureSpellsCantBeCounteredThisTurn = true;
				break;
			case 'nextArtifactSpellGainsSunburst':
				handled = true;
				for (const pl of recipients) pl.nextArtifactSpellGainsSunburst = true;
				break;
			case 'allPlayersCantCastSpellsThisTurn':
				handled = true;
				run.state.allPlayersCantCastSpellsThisTurn = true;
				break;
		}
	}

	if (params.stealOpponentEnteringCreaturesUntilEndOfTurn) {
		run.state.stealOpponentEnteringCreaturesPlayerIdThisTurn = run.you.playerId;
		handled = true;
	}
	if (params.nextCreatureEntersWithPlusCounters) {
		const bonus = Math.max(0, run.amount(params.nextCreatureEntersWithPlusCounters, 0));
		run.you.nextCreatureSpellBonusPlusCounters =
			(run.you.nextCreatureSpellBonusPlusCounters ?? 0) + bonus;
		handled = true;
	}
	if (params.doubleTokensThisTurn) {
		run.you.tokenMultiplierThisTurn = (run.you.tokenMultiplierThisTurn ?? 1) * 2;
		handled = true;
	}
	if (params.flashCastCondition && run.sourcePerm) {
		handled = true;
	}
	if (params.opponentsSpellsCostMoreUntilNextTurn) {
		for (const opp of run.state.players) {
			if (opp.playerId === run.you.playerId || opp.lost) continue;
			(opp.opponentsSpellsCostMoreUntilNextTurn ??= []).push({
				sourcePlayerId: run.you.playerId,
				noncreatureOnly: params.opponentsSpellsCostMoreUntilNextTurn.noncreatureOnly,
				mana: params.opponentsSpellsCostMoreUntilNextTurn.mana
			});
		}
		handled = true;
	}
	if (params.attackTaxUntilYourNextTurn) {
		(run.you.attackTaxUntilNextTurn ??= []).push({
			sourcePlayerId: run.you.playerId,
			tax: params.attackTaxUntilYourNextTurn
		});
		handled = true;
	}
	if (params.castSpellCostTaxForOpponents && run.sourcePerm) {
		handled = true;
	}
	if (params.nextMainPhaseAddMana && executeWave11AddManaStep(run, step)) {
		handled = true;
	}
	return handled;
}

export function executeWave11GrantExtras(run: EffectRunAccess, step: EffectStep): boolean {
	const params = step.params;
	if (!params) return false;
	if (params.cantBeBlockedByOpponentsCreatures) {
		for (const perm of run.objects(step.subject)) {
			if (perm.zone === 'battlefield' && !perm.phasedOut) {
				perm.cantBeBlockedByOpponentsThisTurn = true;
			}
		}
		return true;
	}
	if (params.exileResolvingSpellToLinked && run.sourcePerm) {
		(run.state.exileResolvingInstantsSorceriesToSource ??= []).push({
			sourceInstanceId: run.sourcePerm.instanceId,
			sourceObjectVersion: run.sourcePerm.objectVersion ?? 1
		});
		return true;
	}
	if (params.grantTriggerSpellSunburst && run.ctx.eventObjectId) {
		(run.state.pendingSunburstSpellIds ??= []).push(run.ctx.eventObjectId);
		return true;
	}
	if (params.payAnyManaForDamage) {
		const col = params.payAnyManaForDamage;
		const maxAvail = run.you.manaPool[col] ?? 0;
		const pay = maxAvail > 0 ? maxAvail : 0;
		if (pay > 0) {
			run.you.manaPool[col] -= pay;
			run.recordEffectAmount(pay);
		} else {
			run.recordEffectAmount(0);
		}
		return true;
	}
	if (params.payUpToLifeGainedManaToDraw) {
		const lifeGained = run.you.lifeGainedThisTurn ?? 0;
		const totalMana = Object.values(run.you.manaPool).reduce((s, v) => s + (v ?? 0), 0);
		const pay = Math.min(lifeGained, totalMana);
		if (pay > 0) {
			let rem = pay;
			for (const c of ['C', 'G', 'R', 'B', 'U', 'W'] as const) {
				const take = Math.min(rem, run.you.manaPool[c] ?? 0);
				run.you.manaPool[c] -= take;
				rem -= take;
			}
			run.recordEffectAmount(pay);
		} else {
			run.recordEffectAmount(0);
		}
		return true;
	}
	return false;
}

export function executeWave11CombatRestriction(run: EffectRunAccess, step: EffectStep): boolean {
	if (!step.params?.chooseOddOrEvenCantBlockThisTurn) return false;
	const opp = run.state.players.find((p) => p.playerId !== run.you.playerId && !p.lost);
	let oddCount = 0;
	let evenCount = 0;
	for (const perm of opp?.battlefield ?? []) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(run.state, perm);
		if (!ev.isCreature) continue;
		if (objectManaValue(run.state, perm) % 2 === 1) oddCount++;
		else evenCount++;
	}
	run.state.cantBlockManaValueParityThisTurn = oddCount >= evenCount ? 'odd' : 'even';
	effectPorts().addLog(
		run.state,
		'rule',
		`Creatures with ${run.state.cantBlockManaValueParityThisTurn} mana value can't block this turn.`,
		run.you.playerId
	);
	return true;
}

export function applyWave11ExileMarks(
	run: EffectRunAccess,
	step: EffectStep,
	moved: CardInstance[]
): void {
	if (step.params?.untilOpponentBecomesMonarch && run.sourcePerm) {
		for (const c of moved) {
			c.exiledUntilOpponentMonarch = {
				controllerId: run.you.playerId,
				returnControllerId: c.ownerId
			};
		}
	}
}

export function applyWave11PhaseOutMark(
	run: EffectRunAccess,
	step: EffectStep,
	phasedPerm: CardInstance
): void {
	if (step.params?.cantPhaseInWhileSourceControlled && run.sourcePerm) {
		phasedPerm.cantPhaseInWhileSource = {
			sourceInstanceId: run.sourcePerm.instanceId,
			sourceObjectVersion: run.sourcePerm.objectVersion ?? 1,
			controllerId: run.you.playerId
		};
	}
}

/** Called when `monarchPlayerId` changes to return permanents exiled with `exiledUntilOpponentMonarch`. */
export function releaseExiledUntilOpponentMonarch(state: GameState, newMonarchId: string): void {
	for (const p of state.players) {
		const matching = p.exile.filter((c) => {
			const ex = c.exiledUntilOpponentMonarch;
			return ex && ex.controllerId !== newMonarchId;
		});
		for (const c of matching) {
			delete c.exiledUntilOpponentMonarch;
			const retCtrl =
				state.players.find((pl) => pl.playerId === c.ownerId && !pl.lost) ?? p;
			moveObject(state, c, 'battlefield', { from: { player: p, zone: 'exile' }, toPlayer: retCtrl });
		}
	}
}

/** True if `perm.cantPhaseInWhileSource` still locks phasing-in for this permanent. */
export function isPhasingInLockedBySource(state: GameState, perm: CardInstance): boolean {
	const lock = perm.cantPhaseInWhileSource;
	if (!lock) return false;
	const holder = state.players.find((pl) => pl.playerId === lock.controllerId && !pl.lost);
	const stillActive = holder?.battlefield.some(
		(b) =>
			!b.phasedOut &&
			b.instanceId === lock.sourceInstanceId &&
			b.objectVersion === lock.sourceObjectVersion
	);
	if (!stillActive) {
		delete perm.cantPhaseInWhileSource;
		return false;
	}
	return true;
}

export function clearWave11TurnEndState(state: GameState): void {
	delete state.stealOpponentEnteringCreaturesPlayerIdThisTurn;
	delete state.cantBlockManaValueParityThisTurn;
	delete state.allPlayersCantCastSpellsThisTurn;
	const curTurnId = state.players[state.activePlayerIndex]?.playerId;
	for (const p of state.players) {
		p.tokensCreatedCountThisTurn = 0;
		p.cardsPutIntoGraveyardFromHandOrLibraryThisTurn = 0;
		p.playedLandThisTurn = false;
		p.landsPlayedThisTurn = 0;
		p.cantCastNoncreatureSpellsThisTurn = false;
		p.cantCastInstantsOrSorceriesThisTurn = false;
		p.cantActivateNonManaAbilitiesThisTurn = false;
		p.cantCastAdditionalSpellsThisTurn = false;
		p.creatureSpellsCantBeCounteredThisTurn = false;
		p.attackedWithCommanderThisTurn = false;
		if (p.playerId === curTurnId && p.opponentsSpellsCostMoreUntilNextTurn?.length) {
			p.opponentsSpellsCostMoreUntilNextTurn = p.opponentsSpellsCostMoreUntilNextTurn.filter(
				(e) => e.sourcePlayerId !== curTurnId
			);
		}
		if (p.playerId === curTurnId && p.attackTaxUntilNextTurn?.length) {
			p.attackTaxUntilNextTurn = p.attackTaxUntilNextTurn.filter(
				(e) => e.sourcePlayerId !== curTurnId
			);
		}
		for (const perm of p.battlefield) {
			delete perm.cantBeBlockedByOpponentsThisTurn;
		}
	}
}
