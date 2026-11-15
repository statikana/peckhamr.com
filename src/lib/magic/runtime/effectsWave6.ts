/**
 * Wave 6 Track P16a runtime module:
 * - Slice P16.1: Expanded continuous durations (`untilEndOfCombat`, `forAsLongAsYouControlSelf`,
 *   `forAsLongAsSelfRemainsTapped`, CR 511.2, CR 611.2b), once-per-turn instruction cap (`CR 603.2h`),
 *   P16a conditions, amounts, and turn/next-spell cast rules.
 * - Slice P16.2: Universal counter helpers (`CR 122.1a–b`, `CR 613.4c`), player counters
 *   (`poison`, `experience`, `energy`, `rad`, `ticket`), generalized `moveCounters` (`CR 122.5`),
 *   `copyCountersFrom` (`CR 122.8–9`), and multi-target backtracking partitioner.
 * - Slice P16.3: Fact-or-Fiction / Steam-Augury `pileSplit` (`CR 700.3`), copy-card & free-cast
 *   `castFree` (`CR 707.12`), `removeFromCombat` (`CR 506.4`), and remaining `CR 701` keyword
 *   actions (`Harness 701.64`, `Convert 701.28`, `Empower Jace 701.71`, `Assimilate 701.72`,
 *   `Recruit 701.70`, `Heal 701.69`).
 *
 * Strictly adheres to ENGINE_INVARIANTS.md:
 * - Zero rules-text reads at runtime.
 * - Zero card-name comparisons at runtime.
 * - Zero direct zone mutations (all zone moves route through zones.ts).
 * - Zero unbounded loops; 100% plain-JSON state & continuations.
 */

import { compileSpellEffects, describeModalModes } from '../compiler/index.ts';
import type {
	Amount,
	Condition,
	CostDef,
	Duration,
	EffectStep,
	ModalDef,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	TargetSpec,
	TokenSpec
} from '../ir.ts';
import type { ManaCostRequirement } from '../oracle.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject, getCardFaces } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type ChoiceAnswer,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type TargetRef,
	type TimedContinuousEffect,
	type TriggerEventLki,
	type ZoneType
} from '../types.ts';
import {
	chooseCostPayment,
	effectiveSpellManaCost,
	executeCostPaymentParts,
	payTapAndManaCostParts,
	planCosts,
	serializeCostPlanParts,
	spellAdditionalCost,
	spellCastRestrictions,
	type CostContext
} from './costs.ts';
import { activeAbilityDefs, effectiveManaValue, resolveObjectFaces } from './faces.ts';
import type { Wave3FinalizeCastOptions } from './keywordsWave3.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { matchesObjectFilter, objectManaValue, type FilterContext } from './objectFilter.ts';
import { nextRandom, uid } from './random.ts';
import { checkGlobalCastPermissionsAndRestrictions } from './replace.ts';
import {
	COLOR_CODE_BY_LABEL,
	buildColorChoiceOptions,
	buildCreatureSubtypeOptions,
	chooseBotBestColor,
	chooseBotBestCreatureSubtype
} from './tuckFreezeChosen.ts';
import {
	allocateTimestamp,
	moveObject,
	removeFromGame,
	syncBattlefieldControllers
} from './zones.ts';

// ---- Runtime Host Registration --------------------------------------------------------------

export interface P16aRuntimeHost {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
	canPayOrAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState
	) => boolean;
	payManaWithAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState
	) => boolean;
	costContext: (
		state: GameState,
		player: PlayerGameState,
		source: CardInstance,
		xValue: number,
		isSpell: boolean,
		baseMana: ManaCostRequirement | null
	) => CostContext;
	specTargetCandidates: (
		state: GameState,
		actorId: string,
		sourceCard: ScryfallCard,
		sourceInst: CardInstance | undefined,
		spec: TargetSpec
	) => TargetRef[];
	finalizeCastSpell: (
		state: GameState,
		actor: PlayerGameState,
		inst: CardInstance,
		sourcePlayer: PlayerGameState,
		sourceZone: 'hand' | 'command' | 'exile' | 'graveyard',
		opts: Wave3FinalizeCastOptions
	) => void;
}

let p16aHost: P16aRuntimeHost | null = null;

export function registerP16aRuntimeHost(host: P16aRuntimeHost): void {
	p16aHost = host;
}

function requireP16aHost(): P16aRuntimeHost | null {
	return p16aHost;
}

export interface P16aStepHost {
	readonly state: GameState;
	readonly you: PlayerGameState;
	readonly title: string;
	readonly sourceCard: ScryfallCard;
	readonly sourceId: string;
	readonly sourceObjectVersion?: number;
	readonly stepIndex: number;
	readonly canPause: boolean;
	readonly answers: Record<string, ChoiceAnswer>;
	readonly item: StackItem;
	readonly eventLki?: TriggerEventLki;
	amount: (a?: Amount, fallback?: number) => number;
	objects: (sel: Selector) => CardInstance[];
	players: (sel: Selector) => PlayerGameState[];
	playerRef: (ref: PlayerRef) => PlayerGameState | null;
	refObjects: (ref: Ref) => CardInstance[];
	refLkiCounters: (ref: Ref) => Partial<Record<CounterType, number>> | undefined;
	matches: (
		card: CardInstance,
		filter: ObjectFilter,
		zone: 'battlefield' | 'graveyard' | 'hand' | 'library' | 'exile'
	) => boolean;
	locate: (
		id: string
	) => { inst: CardInstance; holder: PlayerGameState; zone: ZoneType } | null;
	bind: (step: EffectStep, objs: CardInstance[]) => void;
	answered: (
		key: string,
		candidates: CardInstance[],
		min: number,
		max?: number
	) => CardInstance[] | null;
	pauseForChoice: (
		chooser: PlayerGameState,
		title: string,
		description: string,
		candidates: string[],
		min: number,
		max: number,
		zone: ZoneType,
		defaultIds?: string[],
		answerKey?: string
	) => void;
	pauseForYesNo: (
		chooser: PlayerGameState,
		title: string,
		question: string,
		answerKey: string,
		labels?: { yesLabel: string; noLabel: string }
	) => void;
	pauseForMode: (
		chooser: PlayerGameState,
		title: string,
		description: string,
		modes: string[],
		min: number,
		max: number,
		answerKey: string,
		defaultIndices?: number[]
	) => void;
	setStepDecision: (accepted: boolean) => void;
	recordCountersRemoved: (n: number) => void;
	didObjectDieInPrecedingStep: (id: string) => boolean;
	didAnyActedObjectDieInPrecedingStep: () => boolean;
	createTokens: (controller: PlayerGameState, spec: TokenSpec, count: number) => CardInstance[];
	addCounters: (perm: CardInstance, counter: CounterType, count: number) => void;
	removeCounters: (perm: CardInstance, counter: CounterType, count: number) => number;
	transformPermanent: (perm: CardInstance) => boolean;
	drawCards: (player: PlayerGameState, count: number) => void;
	flushTriggers: () => void;
	addLog: (
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
}

// ---- 1. Expanded Continuous Durations (CR 511.2, CR 611.2b) & Turn State --------------------

export function isP16aSourceConditionCurrentlyMet(
	state: GameState,
	sourceInstanceId: string,
	sourceObjectVersion: number,
	kind: 'controlledByPlayer' | 'remainsTapped',
	controllerId: string
): boolean {
	for (const pl of state.players) {
		if (pl.lost) continue;
		const perm = pl.battlefield.find((c) => c.instanceId === sourceInstanceId);
		if (!perm) continue;
		if (perm.phasedOut) return false;
		if ((perm.objectVersion ?? 1) !== sourceObjectVersion) return false;
		if (kind === 'controlledByPlayer') {
			return perm.controllerId === controllerId;
		}
		return Boolean(perm.tapped);
	}
	return false;
}

/**
 * CR 611.2b: Evaluates whether a source-conditioned duration can start at resolution time, and
 * returns the plain-JSON `TimedContinuousEffect` fields. If the condition is already false when the
 * effect would begin, returns `{ ok: false }` so the continuous effect never starts.
 */
export function buildP16aDurationExpiryFields(
	state: GameState,
	duration: Duration | undefined,
	sourceInstanceId: string,
	sourceObjectVersion: number,
	actorPlayerId: string
): {
	ok: boolean;
	fields?: Pick<TimedContinuousEffect, 'expires' | 'sourceCondition'>;
} {
	if (duration === 'untilEndOfCombat') {
		return { ok: true, fields: { expires: 'untilEndOfCombat' } };
	}
	if (duration === 'forAsLongAsYouControlSelf') {
		const met = isP16aSourceConditionCurrentlyMet(
			state,
			sourceInstanceId,
			sourceObjectVersion,
			'controlledByPlayer',
			actorPlayerId
		);
		if (!met) return { ok: false };
		return {
			ok: true,
			fields: {
				expires: 'forAsLongAsYouControlSelf',
				sourceCondition: {
					sourceInstanceId,
					sourceObjectVersion,
					kind: 'controlledByPlayer',
					controllerId: actorPlayerId
				}
			}
		};
	}
	if (duration === 'forAsLongAsSelfRemainsTapped') {
		const met = isP16aSourceConditionCurrentlyMet(
			state,
			sourceInstanceId,
			sourceObjectVersion,
			'remainsTapped',
			actorPlayerId
		);
		if (!met) return { ok: false };
		return {
			ok: true,
			fields: {
				expires: 'forAsLongAsSelfRemainsTapped',
				sourceCondition: {
					sourceInstanceId,
					sourceObjectVersion,
					kind: 'remainsTapped',
					controllerId: actorPlayerId
				}
			}
		};
	}
	return { ok: true };
}

/**
 * Pure check called inside `layers.ts` (`isTimedContinuousEffectActive`) for P16a durations.
 */
export function isP16aTimedEffectActive(
	state: GameState,
	eff: TimedContinuousEffect
): boolean {
	if (
		eff.expires !== 'forAsLongAsYouControlSelf' &&
		eff.expires !== 'forAsLongAsSelfRemainsTapped'
	) {
		return true;
	}
	const cond = eff.sourceCondition;
	if (!cond || cond.broken) return false;
	return isP16aSourceConditionCurrentlyMet(
		state,
		cond.sourceInstanceId,
		cond.sourceObjectVersion,
		cond.kind,
		cond.controllerId
	);
}

/**
 * CR 611.2b: Latches & prunes source-conditioned effects whose duration condition ceased to hold
 * (so re-tapping or regaining control later never revives an already-ended one-shot duration!).
 */
export function latchBrokenP16aSourceConditions(state: GameState): void {
	let changed = false;
	if (state.timedContinuousEffects?.length) {
		const kept: TimedContinuousEffect[] = [];
		for (const eff of state.timedContinuousEffects) {
			if (
				eff.expires === 'forAsLongAsYouControlSelf' ||
				eff.expires === 'forAsLongAsSelfRemainsTapped'
			) {
				const cond = eff.sourceCondition;
				if (
					!cond ||
					cond.broken ||
					!isP16aSourceConditionCurrentlyMet(
						state,
						cond.sourceInstanceId,
						cond.sourceObjectVersion,
						cond.kind,
						cond.controllerId
					)
				) {
					if (cond) cond.broken = true;
					changed = true;
					continue;
				}
			}
			kept.push(eff);
		}
		if (changed) {
			state.timedContinuousEffects = kept.length > 0 ? kept : undefined;
		}
	}
	for (const pl of state.players) {
		for (const perm of pl.battlefield) {
			if (!perm.doesntUntapWhileSource?.length) continue;
			const nextLocks = perm.doesntUntapWhileSource.filter(
				(cond) =>
					!cond.broken &&
					isP16aSourceConditionCurrentlyMet(
						state,
						cond.sourceInstanceId,
						cond.sourceObjectVersion,
						cond.kind,
						cond.controllerId
					)
			);
			if (nextLocks.length !== perm.doesntUntapWhileSource.length) {
				perm.doesntUntapWhileSource = nextLocks.length > 0 ? nextLocks : undefined;
			}
		}
	}
	if (changed) {
		noteLayerInputsChanged(state);
		syncBattlefieldControllers(state);
	}
}

/**
 * CR 511.2: Expires `'untilEndOfCombat'` continuous effects as the combat phase ends.
 */
export function expireP16aEndOfCombatEffects(state: GameState): void {
	if (!state.timedContinuousEffects?.length) return;
	const before = state.timedContinuousEffects.length;
	const remaining = state.timedContinuousEffects.filter(
		(eff) => eff.expires !== 'untilEndOfCombat'
	);
	if (remaining.length !== before) {
		state.timedContinuousEffects = remaining.length > 0 ? remaining : undefined;
		noteLayerInputsChanged(state);
		syncBattlefieldControllers(state);
	}
}

/**
 * Checks whether `perm` is kept tapped during its controller's untap step by an unbroken
 * `forAsLongAsSelfRemainsTapped` / `forAsLongAsYouControlSelf` freeze effect (CR 611.2b).
 */
export function isPermanentFrozenByP16aSourceCondition(
	state: GameState,
	perm: CardInstance
): boolean {
	if (!perm.doesntUntapWhileSource?.length) return false;
	const active = perm.doesntUntapWhileSource.filter(
		(cond) =>
			!cond.broken &&
			isP16aSourceConditionCurrentlyMet(
				state,
				cond.sourceInstanceId,
				cond.sourceObjectVersion,
				cond.kind,
				cond.controllerId
			)
	);
	perm.doesntUntapWhileSource = active.length > 0 ? active : undefined;
	return active.length > 0;
}

/**
 * Clears P16a turn-scoped flags at cleanup / turn rollover.
 */
export function cleanupP16aTurnState(state: GameState): void {
	delete state.doneOnceThisTurnKeys;
	for (const pl of state.players) {
		delete pl.cantCastSpellsThisTurn;
		delete pl.spellsCantBeCounteredThisTurn;
		delete pl.castAsThoughFlashThisTurn;
		delete pl.nextSpellFlashGrants;
		delete pl.nextSpellCantBeCounteredGrants;
		for (const perm of pl.battlefield) {
			delete perm.assignsNoCombatDamageThisTurn;
			delete perm.mustAttackThisTurn;
			delete perm.mustBeBlockedThisTurn;
			delete perm.mustBlockThisTurn;
			delete perm.cantBlockAttackerIdsThisTurn;
		}
	}
}

// ---- 2. CR 603.2h "Do this only once each turn" Helpers -------------------------------------

export function buildDoOnceThisTurnKey(
	sourceInstanceId: string,
	sourceObjectVersion: number | undefined,
	abilityTag: string
): string {
	return `${sourceInstanceId}:${sourceObjectVersion ?? 1}:${abilityTag}`;
}

export function canDoOnceThisTurn(state: GameState, key: string): boolean {
	return !(state.doneOnceThisTurnKeys ?? []).includes(key);
}

export function markDoneOnceThisTurn(state: GameState, key: string): void {
	const arr = (state.doneOnceThisTurnKeys ??= []);
	if (!arr.includes(key)) arr.push(key);
}

// ---- 3. Turn & Next-Spell Cast Permissions / Restrictions -----------------------------------

function matchesPlainTypeGrant(
	types: readonly string[],
	grant: { types?: string[]; notTypes?: string[] }
): boolean {
	if (grant.types?.length) {
		const hit = grant.types.some((wt) =>
			types.some((t) => t.toLowerCase() === wt.toLowerCase())
		);
		if (!hit) return false;
	}
	if (grant.notTypes?.length) {
		const blocked = grant.notTypes.some((nt) =>
			types.some((t) => t.toLowerCase() === nt.toLowerCase())
		);
		if (blocked) return false;
	}
	return true;
}

export function playerHasP16aFlashGrantForTypes(
	player: PlayerGameState,
	castTypes: readonly string[]
): boolean {
	if (player.castAsThoughFlashThisTurn) return true;
	if (!player.nextSpellFlashGrants?.length) return false;
	return player.nextSpellFlashGrants.some((g) => matchesPlainTypeGrant(castTypes, g));
}

export function consumeP16aOnSpellCast(
	player: PlayerGameState,
	castTypes: readonly string[],
	stackItem: StackItem
): void {
	if (player.spellsCantBeCounteredThisTurn) {
		stackItem.cantBeCounteredByEffect = true;
	}
	if (player.nextSpellFlashGrants?.length) {
		const idx = player.nextSpellFlashGrants.findIndex((g) => matchesPlainTypeGrant(castTypes, g));
		if (idx >= 0) {
			player.nextSpellFlashGrants.splice(idx, 1);
			if (player.nextSpellFlashGrants.length === 0) delete player.nextSpellFlashGrants;
		}
	}
	if (player.nextSpellCantBeCounteredGrants?.length) {
		const idx = player.nextSpellCantBeCounteredGrants.findIndex((g) =>
			matchesPlainTypeGrant(castTypes, g)
		);
		if (idx >= 0) {
			stackItem.cantBeCounteredByEffect = true;
			player.nextSpellCantBeCounteredGrants.splice(idx, 1);
			if (player.nextSpellCantBeCounteredGrants.length === 0) {
				delete player.nextSpellCantBeCounteredGrants;
			}
		}
	}
}

export function isSpellUncounterableByP16a(state: GameState, item: StackItem): boolean {
	if (item.kind !== 'spell') return false;
	if (item.cantBeCounteredByEffect) return true;
	const ctrl = state.players.find((p) => p.playerId === item.controllerId);
	return Boolean(ctrl?.spellsCantBeCounteredThisTurn);
}

// ---- 4. P16a ObjectFilter, Amount, and Condition Helpers ------------------------------------

export function matchesP16aObjectFilter(
	obj: CardInstance,
	filter: ObjectFilter,
	ctx: FilterContext
): boolean {
	if (filter.assimilatedWithSelf) {
		if (!ctx.source || !obj.assimilatedBy) return false;
		const srcVer = ctx.source.objectVersion ?? 1;
		if (
			obj.assimilatedBy.sourceInstanceId !== ctx.source.instanceId ||
			obj.assimilatedBy.sourceObjectVersion !== srcVer
		) {
			return false;
		}
	}
	return true;
}

export function getPlayerCounterCount(
	player: PlayerGameState | undefined | null,
	counter: 'poison' | 'experience' | 'energy' | 'rad' | 'ticket'
): number {
	if (!player) return 0;
	switch (counter) {
		case 'poison':
			return player.poison ?? 0;
		case 'experience':
			return player.experienceCounters ?? 0;
		case 'energy':
			return player.energyCounters ?? 0;
		case 'rad':
			return player.radCounters ?? 0;
		case 'ticket':
			return player.ticketCounters ?? 0;
	}
}

export function evaluateP16aAmount(amount: Amount, ctx: FilterContext): number | null {
	if (amount.k === 'countersRemovedThisWay') {
		return ctx.stackItem?.lastCountersRemoved ?? 0;
	}
	if (amount.k === 'playerCounters') {
		let pl: PlayerGameState | undefined;
		if (amount.player.k === 'you') {
			pl = ctx.state.players.find((p) => p.playerId === ctx.controllerId);
		} else if (amount.player.k === 'activePlayer') {
			pl = ctx.state.players[ctx.state.activePlayerIndex];
		} else if (amount.player.k === 'eventPlayer' && ctx.stackItem?.eventPlayerId) {
			pl = ctx.state.players.find((p) => p.playerId === ctx.stackItem!.eventPlayerId);
		} else if (amount.player.k === 'defendingPlayer' && ctx.stackItem?.defendingPlayerId) {
			pl = ctx.state.players.find((p) => p.playerId === ctx.stackItem!.defendingPlayerId);
		} else if (amount.player.k === 'target') {
			const tRef = ctx.stackItem?.targets?.[amount.player.index];
			if (tRef?.kind === 'player') {
				pl = ctx.state.players.find((p) => p.playerId === tRef.id);
			}
		}
		return getPlayerCounterCount(pl, amount.counter);
	}
	return null;
}

export function evaluateP16aStepCondition(host: P16aStepHost, cond: Condition): boolean | null {
	if (cond.k === 'diedThisWay') {
		if (!cond.ref) {
			return host.didAnyActedObjectDieInPrecedingStep();
		}
		const objs = host.refObjects(cond.ref);
		if (objs.length === 0) return host.didAnyActedObjectDieInPrecedingStep();
		return objs.some(
			(o) => o.zone === 'graveyard' || host.didObjectDieInPrecedingStep(o.instanceId)
		);
	}
	return null;
}

// ---- 5. Universal Counters (CR 122.1a–b, CR 613.4c) -----------------------------------------

export const P16A_EXTRA_KEYWORD_COUNTERS: readonly string[] = ['shadow', 'exalted', 'decayed'];

const ARBITRARY_PT_COUNTER_RE = /^([+-]\d+)\/([+-]\d+)$/;

/**
 * CR 122.1a / CR 613.4c: Sums arbitrary `±M/±N` counters other than `'+1/+1'` and `'-1/-1'`
 * (such as `+2/+2`, `+1/+0`, `+0/+1`, `-0/-1`, `-2/-1`).
 */
export function sumArbitraryPtCounters(
	counters: Record<string, number>
): { power: number; toughness: number; entries: Array<{ counter: string; count: number; dp: number; dt: number }> } {
	let power = 0;
	let toughness = 0;
	const entries: Array<{ counter: string; count: number; dp: number; dt: number }> = [];
	for (const [key, rawCount] of Object.entries(counters)) {
		if (!rawCount || rawCount <= 0) continue;
		if (key === '+1/+1' || key === '-1/-1') continue;
		const m = ARBITRARY_PT_COUNTER_RE.exec(key);
		if (!m) continue;
		const dp = Number(m[1]);
		const dt = Number(m[2]);
		if (!Number.isFinite(dp) || !Number.isFinite(dt)) continue;
		power += rawCount * dp;
		toughness += rawCount * dt;
		entries.push({ counter: key, count: rawCount, dp, dt });
	}
	return { power, toughness, entries };
}

export function isNegativeArbitraryCounter(counter: string): boolean {
	if (counter === '-1/-1' || counter === 'stun' || counter === 'finality' || counter === 'plague' || counter === 'blight') {
		return true;
	}
	const m = ARBITRARY_PT_COUNTER_RE.exec(counter);
	if (!m) return false;
	return Number(m[1]) < 0 || Number(m[2]) < 0 || Number(m[1]) + Number(m[2]) < 0;
}

export function executePutPlayerCounters(host: P16aStepHost, step: EffectStep): void {
	const counter = step.params?.playerCounter;
	if (!counter) return;
	const count = Math.max(0, host.amount(step.amount, 1));
	if (count <= 0) return;
	const players = host.players(step.subject);
	for (const pl of players) {
		if (pl.lost) continue;
		switch (counter) {
			case 'poison':
				pl.poison = (pl.poison ?? 0) + count;
				break;
			case 'experience':
				pl.experienceCounters = (pl.experienceCounters ?? 0) + count;
				break;
			case 'energy':
				pl.energyCounters = (pl.energyCounters ?? 0) + count;
				break;
			case 'rad':
				pl.radCounters = (pl.radCounters ?? 0) + count;
				break;
			case 'ticket':
				pl.ticketCounters = (pl.ticketCounters ?? 0) + count;
				break;
		}
		host.addLog('rule', `${pl.username} got ${count} ${counter} counter(s) (${host.title}).`, pl.playerId);
	}
	noteLayerInputsChanged(host.state);
}

/**
 * CR 122.5: Generalized `moveCounters` ("Move a/N/all/up to N [<counter>] counter(s) from [src] onto [dst]").
 */
export function executeGeneralizedMoveCounters(host: P16aStepHost, step: EffectStep): void {
	const spec = step.params?.moveCounterSpec;
	if (!spec) return;
	const sources = host.objects(spec.from).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	const dests = host.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	if (sources.length === 0 || dests.length === 0) return;
	const dst = dests[0];
	let totalMoved = 0;

	for (const src of sources) {
		// CR 122.5: If the first and second objects are the same object, nothing happens.
		if (src.instanceId === dst.instanceId) continue;

		if (spec.counter === 'any') {
			let budget = spec.all ? Number.MAX_SAFE_INTEGER : Math.max(0, host.amount(step.amount, 1));
			for (const [cKey, have] of Object.entries(src.counters)) {
				if (!have || have <= 0 || budget <= 0) continue;
				const take = Math.min(have, budget);
				const removed = host.removeCounters(src, cKey as CounterType, take);
				if (removed > 0) {
					host.addCounters(dst, cKey as CounterType, removed);
					totalMoved += removed;
					budget -= removed;
				}
			}
		} else {
			const have = src.counters[spec.counter] ?? 0;
			if (have <= 0) continue;
			const want = spec.all ? have : Math.min(have, Math.max(0, host.amount(step.amount, 1)));
			if (want <= 0) continue;
			const removed = host.removeCounters(src, spec.counter, want);
			if (removed > 0) {
				host.addCounters(dst, spec.counter, removed);
				totalMoved += removed;
			}
		}
	}

	if (totalMoved > 0) {
		host.recordCountersRemoved(totalMoved);
		host.setStepDecision(true);
		host.addLog(
			'rule',
			`${host.title} moved ${totalMoved} counter(s) onto ${dst.card.name}.`,
			host.you.playerId
		);
	} else if (spec.upTo) {
		host.setStepDecision(false);
	}
}

/**
 * CR 122.8–9: "Put its counters on [subject]" — copies live or LKI counters from `copyCountersFrom`
 * onto each battlefield permanent in `step.subject`.
 */
export function executeCopyCountersFrom(host: P16aStepHost, step: EffectStep): void {
	const srcSel = step.params?.copyCountersFrom;
	if (!srcSel) return;
	const recipients = host.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	if (recipients.length === 0) return;

	let counterMap: Partial<Record<CounterType, number>> | undefined;
	const liveSrc = host.objects(srcSel)[0];
	if (liveSrc && liveSrc.zone === 'battlefield') {
		counterMap = liveSrc.counters;
	} else if (srcSel.k === 'self') {
		counterMap = host.eventLki?.counters ?? liveSrc?.lastKnownCounters;
	} else if (srcSel.k === 'eventObject') {
		counterMap = host.eventLki?.counters ?? liveSrc?.lastKnownCounters;
	} else if (srcSel.k === 'binding') {
		counterMap = host.refLkiCounters({ k: 'binding', name: srcSel.name }) ?? liveSrc?.lastKnownCounters;
	} else if (srcSel.k === 'target') {
		counterMap = host.refLkiCounters({ k: 'target', index: srcSel.index }) ?? liveSrc?.lastKnownCounters;
	}

	if (!counterMap) return;
	for (const rec of recipients) {
		for (const [cType, count] of Object.entries(counterMap)) {
			if (count && count > 0) {
				host.addCounters(rec, cType as CounterType, count);
			}
		}
	}
}

// ---- 6. Multi-Target Backtracking Partitioner -----------------------------------------------

/**
 * Partitions a flat `chosen` target list across `specs` using bounded backtracking over `min..max`
 * counts and optional per-spec candidate legality checks (`canMatch`).
 */
export function partitionMultiTargetsBacktracking(
	specs: readonly TargetSpec[],
	chosen: readonly TargetRef[],
	canMatch?: (specIndex: number, target: TargetRef) => boolean
): TargetRef[][] | null {
	const kLen = specs.length;
	if (kLen === 0) return chosen.length === 0 ? [] : null;

	const buckets: TargetRef[][] = [];

	function dfs(specIdx: number, offset: number): boolean {
		if (specIdx === kLen) {
			return offset === chosen.length;
		}
		const sp = specs[specIdx];
		let remMin = 0;
		let remMax = 0;
		for (let j = specIdx + 1; j < kLen; j++) {
			remMin += specs[j].min;
			remMax += specs[j].max;
		}
		const remaining = chosen.length - offset;
		const minTake = Math.max(sp.min, remaining - remMax);
		const maxTake = Math.min(sp.max, remaining - remMin);
		if (minTake > maxTake) return false;

		// Prefer greedy higher counts on earlier optional specs when legal (matches left-to-right convention).
		for (let take = maxTake; take >= minTake; take--) {
			const slice = chosen.slice(offset, offset + take);
			let legal = true;
			if (canMatch) {
				for (const t of slice) {
					if (!canMatch(specIdx, t)) {
						legal = false;
						break;
					}
				}
			}
			if (!legal) continue;
			buckets.push(slice);
			if (dfs(specIdx + 1, offset + take)) return true;
			buckets.pop();
		}
		return false;
	}

	return dfs(0, 0) ? buckets : null;
}

// ---- 7. Fact-or-Fiction / Steam-Augury Pile Split (CR 700.3) --------------------------------

function shuffleDeterministic<T>(state: GameState, items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom(state) * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

export function executePileSplit(host: P16aStepHost, step: EffectStep): void {
	const spec = step.params?.pileSplit;
	if (!spec) return;
	const state = host.state;
	const you = host.you;
	const opponent =
		state.players.find((p) => !p.lost && p.playerId !== you.playerId) ?? you;

	const topKey = `pile_top:${host.stepIndex}`;
	const pile1Key = `pile_make:${host.stepIndex}`;
	const chooseKey = `pile_choose:${host.stepIndex}`;

	let topIds: string[];
	const savedTop = host.answers[topKey];
	if (savedTop?.kind === 'chooseObjects') {
		topIds = savedTop.objectIds;
	} else {
		const n = Math.min(you.library.length, Math.max(0, host.amount(step.amount, 5)));
		if (n <= 0) return;
		const topCards = you.library.slice(0, n);
		topIds = topCards.map((c) => c.instanceId);
		host.answers[topKey] = { kind: 'chooseObjects', objectIds: topIds };
		if (spec.reveal) {
			const aliveIds = state.players.filter((p) => !p.lost).map((p) => p.playerId);
			for (const c of topCards) c.knownToPlayerIds = [...aliveIds];
			host.addLog(
				'rule',
				`${you.username} revealed ${topCards.map((c) => c.card.name).join(', ')} from the top of their library (${host.title}).`,
				you.playerId
			);
		}
	}

	const cards = topIds
		.map((id) => you.library.find((c) => c.instanceId === id))
		.filter((c): c is CardInstance => Boolean(c));
	if (cards.length === 0) return;

	const maker = spec.pileMaker === 'opponent' ? opponent : you;
	const chooser = spec.pileChooser === 'opponent' ? opponent : you;

	let pile1Ids: string[];
	const savedPile1 = host.answers[pile1Key];
	if (savedPile1?.kind === 'chooseObjects') {
		pile1Ids = savedPile1.objectIds;
	} else if (!maker.isBot && host.canPause) {
		const halfDefault = cards.slice(0, Math.ceil(cards.length / 2)).map((c) => c.instanceId);
		host.pauseForChoice(
			maker,
			`${host.title} — Separate into Two Piles`,
			`Select cards for Pile 1 (any unselected cards form Pile 2).`,
			cards.map((c) => c.instanceId),
			0,
			cards.length,
			'library',
			halfDefault,
			pile1Key
		);
		return;
	} else {
		// Bot splits alternating sorted by mana value so piles are balanced (CR 700.3: piles can be empty).
		const sorted = [...cards].sort((a, b) => objectManaValue(state, b) - objectManaValue(state, a));
		pile1Ids = sorted.filter((_, idx) => idx % 2 === 0).map((c) => c.instanceId);
		host.answers[pile1Key] = { kind: 'chooseObjects', objectIds: pile1Ids };
	}

	const pile1Set = new Set(pile1Ids);
	const pile1 = cards.filter((c) => pile1Set.has(c.instanceId));
	const pile2 = cards.filter((c) => !pile1Set.has(c.instanceId));

	const pileLabel = (p: CardInstance[], idx: number) =>
		p.length === 0 ? `Pile ${idx} (empty)` : `Pile ${idx}: ${p.map((c) => c.card.name).join(', ')}`;

	let chosenIdx: 0 | 1;
	const savedChoose = host.answers[chooseKey];
	if (savedChoose?.kind === 'chooseMode') {
		chosenIdx = (savedChoose.indices[0] ?? 0) === 1 ? 1 : 0;
	} else if (!chooser.isBot && host.canPause) {
		host.pauseForMode(
			chooser,
			`${host.title} — Choose a Pile`,
			chooser.playerId === you.playerId
				? `Choose which pile to put into your ${spec.chosenTo}.`
				: `Choose which pile ${you.username} puts into their ${spec.chosenTo}.`,
			[pileLabel(pile1, 1), pileLabel(pile2, 2)],
			1,
			1,
			chooseKey,
			[0]
		);
		return;
	} else {
		const scorePile = (p: CardInstance[]) =>
			p.reduce((acc, c) => acc + 2 + objectManaValue(state, c), 0);
		const s1 = scorePile(pile1);
		const s2 = scorePile(pile2);
		// If `you` chooses, pick higher-value pile; if opponent chooses what `you` gets, pick lower-value pile!
		chosenIdx = chooser.playerId === you.playerId ? (s1 >= s2 ? 0 : 1) : s1 <= s2 ? 0 : 1;
		host.answers[chooseKey] = { kind: 'chooseMode', indices: [chosenIdx] };
	}

	const chosenPile = chosenIdx === 0 ? pile1 : pile2;
	const otherPile = chosenIdx === 0 ? pile2 : pile1;

	for (const c of chosenPile) {
		if (spec.chosenTo === 'hand') {
			moveObject(state, c, 'hand', {
				from: { player: you, zone: 'library' },
				toPlayer: you,
				bumpVersion: true,
				newTimestamp: true
			});
		} else {
			const view = resolveObjectFaces(effectiveCardForObject(c), { zone: 'battlefield' });
			if (!view.types.includes('Instant') && !view.types.includes('Sorcery')) {
				c.summoningSick = !view.keywords.includes('Haste');
				c.tapped = false;
				c.defaultControllerId = you.playerId;
				moveObject(state, c, 'battlefield', {
					from: { player: you, zone: 'library' },
					toPlayer: you,
					controllerId: you.playerId,
					bumpVersion: true,
					newTimestamp: true
				});
			}
		}
	}

	const orderedOther =
		spec.otherTo === 'libraryBottom' && spec.otherRandomOrder
			? shuffleDeterministic(state, otherPile)
			: otherPile;
	for (const c of orderedOther) {
		if (spec.otherTo === 'graveyard') {
			moveObject(state, c, 'graveyard', {
				from: { player: you, zone: 'library' },
				toPlayer: you,
				graveyardReplacement: true,
				bumpVersion: true,
				newTimestamp: true
			});
		} else if (spec.otherTo === 'exile') {
			moveObject(state, c, 'exile', {
				from: { player: you, zone: 'library' },
				toPlayer: you,
				bumpVersion: true,
				newTimestamp: true
			});
		} else {
			moveObject(state, c, 'library', {
				from: { player: you, zone: 'library' },
				toPlayer: you,
				insert: 'end',
				bumpVersion: true,
				newTimestamp: true
			});
		}
	}

	host.bind(step, chosenPile);
	host.addLog(
		'rule',
		`${chooser.username} chose Pile ${chosenIdx + 1} (${chosenPile.length} card(s) to ${spec.chosenTo}, ${otherPile.length} to ${spec.otherTo}).`,
		you.playerId
	);
	host.flushTriggers();
}

// ---- 8. Free-Cast & Copy-Card Free-Cast (CR 707.12) -----------------------------------------

interface FreeCastFaceSetup {
	faceIndex: number;
	faceName: string;
	costDefs: CostDef[];
	modal?: ModalDef;
	nonModalSpecs: TargetSpec[];
	additionalIncomplete: boolean;
}

function getSpellFaceModalAndTargets(
	card: ScryfallCard,
	faceIndex: number
): { modal?: ModalDef; nonModalSpecs: TargetSpec[] } {
	const compiled = compileSpellEffects(card, faceIndex);
	if (!compiled) return { nonModalSpecs: [] };
	if (compiled.modal) return { modal: compiled.modal, nonModalSpecs: [] };
	return { nonModalSpecs: compiled.targets };
}

function buildFreeCastFaceSetups(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	fromZone: 'hand' | 'exile' | 'graveyard',
	filter?: ObjectFilter
): FreeCastFaceSetup[] {
	const rHost = requireP16aHost();
	if (!rHost) return [];
	const card = effectiveCardForObject(inst);
	const faceCount = Math.max(1, getCardFaces(card).length);
	const setups: FreeCastFaceSetup[] = [];

	const globalPerm = checkGlobalCastPermissionsAndRestrictions(state, actor, inst, fromZone);
	if (globalPerm.blocked || !globalPerm.ok) return [];

	const activePlayer = state.players[state.activePlayerIndex];
	const fCtx: FilterContext = {
		state,
		controllerId: actor.playerId
	};

	for (let fi = 0; fi < faceCount; fi++) {
		const view = resolveObjectFaces(card, { zone: 'stack', faceIndex: fi });
		if (view.types.includes('Land')) continue;
		if (filter) {
			const faceProbe: CardInstance =
				fi !== inst.activeFaceIndex ? { ...inst, activeFaceIndex: fi } : inst;
			if (!matchesObjectFilter(faceProbe, filter, { ...fCtx, zone: 'stack' })) continue;
		}

		let timingOk = true;
		for (const r of spellCastRestrictions(card, fi, false)) {
			if (r === 'duringCombat' && !state.combat.active) timingOk = false;
			if (r === 'duringYourTurn' && activePlayer?.playerId !== actor.playerId) timingOk = false;
			if (r === 'beforeAttackers' && (!state.combat.active || state.phase !== 'begin_combat')) {
				timingOk = false;
			}
		}
		if (!timingOk) continue;

		const additional = spellAdditionalCost(card, fi, false);
		const costDefs = [...(additional?.defs ?? [])];
		const reqAtZero = effectiveSpellManaCost(state, actor, inst, 0, { kind: 'free' }, undefined, fi);
		if (costDefs.length > 0) {
			const ctx = rHost.costContext(state, actor, inst, 0, true, reqAtZero);
			if (!chooseCostPayment(ctx, costDefs)) continue;
		} else if (!rHost.canPayOrAutoTap(actor, reqAtZero, state)) {
			continue;
		}

		const { modal, nonModalSpecs } = getSpellFaceModalAndTargets(card, fi);
		if (modal) {
			const legalModes: number[] = [];
			for (let m = 0; m < modal.modes.length; m++) {
				const ok = modal.modes[m].targets.every(
					(sp) =>
						sp.min <= 0 ||
						rHost.specTargetCandidates(state, actor.playerId, card, inst, sp).length >= sp.min
				);
				if (ok) legalModes.push(m);
			}
			const enough =
				modal.min === 0 || modal.upTo
					? true
					: modal.allowRepeat && !modal.oncePerTurnUnique
						? legalModes.length > 0
						: legalModes.length >= modal.min;
			if (!enough) continue;
		} else {
			let targetsOk = true;
			for (const sp of nonModalSpecs) {
				if (
					sp.min > 0 &&
					rHost.specTargetCandidates(state, actor.playerId, card, inst, sp).length < sp.min
				) {
					targetsOk = false;
					break;
				}
			}
			if (!targetsOk) continue;
		}

		setups.push({
			faceIndex: fi,
			faceName: view.name,
			costDefs,
			modal,
			nonModalSpecs,
			additionalIncomplete: Boolean(additional && !additional.complete)
		});
	}
	return setups;
}

export function executeCastFree(host: P16aStepHost, step: EffectStep): void {
	const rHost = requireP16aHost();
	if (!rHost) return;
	const state = host.state;
	const spec = step.params?.castFreeSpec ?? { withoutPayingManaCost: true };
	const actor = (step.actor ? host.playerRef(step.actor) : null) ?? host.you;
	if (!actor || actor.lost) return;

	const listKey = `castfree:list:${host.stepIndex}`;
	let candIds: string[];
	const savedList = host.answers[listKey];
	if (savedList?.kind === 'chooseObjects') {
		candIds = savedList.objectIds;
	} else {
		const rawObjs = host.objects(step.subject).filter(
			(o) => o.zone === 'exile' || o.zone === 'graveyard' || o.zone === 'hand'
		);
		const maxPick = spec.upToCount !== undefined ? spec.upToCount : rawObjs.length;
		candIds = rawObjs.slice(0, maxPick).map((o) => o.instanceId);
		host.answers[listKey] = { kind: 'chooseObjects', objectIds: candIds };
	}

	let anyCast = false;
	for (let i = 0; i < candIds.length; i++) {
		const doneItemKey = `castfree:done:${host.stepIndex}:${i}`;
		if (host.answers[doneItemKey]?.kind === 'yesNo') {
			if (host.answers[doneItemKey].yes) anyCast = true;
			continue;
		}

		const origFound = host.locate(candIds[i]);
		if (
			!origFound ||
			(origFound.zone !== 'exile' && origFound.zone !== 'graveyard' && origFound.zone !== 'hand')
		) {
			host.answers[doneItemKey] = { kind: 'yesNo', yes: false };
			continue;
		}
		const fromZone = origFound.zone as 'exile' | 'graveyard' | 'hand';
		const sourceHolder = origFound.holder;
		const baseInst = origFound.inst;

		const setups = buildFreeCastFaceSetups(state, actor, baseInst, fromZone, spec.filter);
		if (setups.length === 0) {
			host.answers[doneItemKey] = { kind: 'yesNo', yes: false };
			continue;
		}

		const askKey = `castfree:ask:${host.stepIndex}:${i}`;
		let wantsCast = true;
		if (!actor.isBot && host.canPause) {
			const ans = host.answers[askKey];
			if (!ans) {
				host.pauseForYesNo(
					actor,
					`${host.title} — Cast Without Paying Mana Cost`,
					spec.copyCardFirst
						? `Cast a copy of ${baseInst.card.name} without paying its mana cost?`
						: `Cast ${baseInst.card.name} without paying its mana cost?`,
					askKey,
					{ yesLabel: 'Cast', noLabel: 'Decline' }
				);
				return;
			}
			wantsCast = ans.kind === 'yesNo' && ans.yes;
		}

		if (!wantsCast) {
			host.answers[doneItemKey] = { kind: 'yesNo', yes: false };
			continue;
		}

		let pickedSetup = setups[0];
		if (setups.length > 1) {
			if (actor.isBot || !host.canPause) {
				pickedSetup = [...setups].sort(
					(a, b) =>
						effectiveManaValue(baseInst.card, { zone: 'stack', faceIndex: b.faceIndex }) -
						effectiveManaValue(baseInst.card, { zone: 'stack', faceIndex: a.faceIndex })
				)[0];
			} else {
				const faceKey = `castfree:face:${host.stepIndex}:${i}`;
				const faceAns = host.answers[faceKey];
				if (!faceAns) {
					host.pauseForMode(
						actor,
						`${host.title} — Choose Face`,
						`Choose which face of ${baseInst.card.name} to cast.`,
						setups.map((s) => s.faceName),
						1,
						1,
						faceKey,
						[0]
					);
					return;
				}
				const idx = faceAns.kind === 'chooseMode' ? (faceAns.indices[0] ?? 0) : 0;
				pickedSetup = setups[Math.max(0, Math.min(setups.length - 1, idx))];
			}
		}

		let chosenModes: number[] | undefined;
		if (pickedSetup.modal) {
			const modal = pickedSetup.modal;
			const legalModeIndices: number[] = [];
			for (let m = 0; m < modal.modes.length; m++) {
				const ok = modal.modes[m].targets.every(
					(sp) =>
						sp.min <= 0 ||
						rHost.specTargetCandidates(state, actor.playerId, baseInst.card, baseInst, sp).length >=
							sp.min
				);
				if (ok) legalModeIndices.push(m);
			}
			if (actor.isBot || !host.canPause) {
				chosenModes = legalModeIndices.slice(0, Math.max(modal.min, 1));
			} else {
				const modeKey = `castfree:modes:${host.stepIndex}:${i}`;
				const modeAns = host.answers[modeKey];
				if (!modeAns) {
					host.pauseForMode(
						actor,
						`${host.title} — Choose Mode(s)`,
						`Choose mode(s) for ${pickedSetup.faceName}.`,
						describeModalModes(baseInst.card, modal, pickedSetup.faceIndex),
						modal.min,
						modal.max,
						modeKey,
						legalModeIndices.slice(0, Math.max(modal.min, 1))
					);
					return;
				}
				chosenModes = modeAns.kind === 'chooseMode' ? modeAns.indices : [0];
			}
		}

		const activeSpecs: TargetSpec[] = pickedSetup.modal
			? (chosenModes ?? []).flatMap((m) => pickedSetup.modal!.modes[m]?.targets ?? [])
			: pickedSetup.nonModalSpecs;

		const targets: TargetRef[] = [];
		const targetsBySpec: TargetRef[][] = [];
		const usedAcrossOtherTarget = new Set<string>();
		let allTargetsLegal = true;

		for (let sIdx = 0; sIdx < activeSpecs.length; sIdx++) {
			const sp = activeSpecs[sIdx];
			const cands = rHost
				.specTargetCandidates(state, actor.playerId, baseInst.card, baseInst, sp)
				.filter((c) => !sp.otherTarget || !usedAcrossOtherTarget.has(`${c.kind}:${c.id}`));
			if (cands.length < sp.min) {
				allTargetsLegal = false;
				break;
			}
			if (cands.length === 0) {
				targetsBySpec.push([]);
				continue;
			}
			let pickedRefs: TargetRef[];
			if (actor.isBot || !host.canPause) {
				const want = sp.min > 0 ? sp.min : 1;
				pickedRefs = cands.slice(0, Math.min(sp.max, want));
			} else {
				const tgtKey = `castfree:tgt:${host.stepIndex}:${i}:${sIdx}`;
				const tgtAns = host.answers[tgtKey];
				if (!tgtAns) {
					host.pauseForMode(
						actor,
						`${host.title} — Choose Target for ${pickedSetup.faceName}`,
						`Select target(s) for ${pickedSetup.faceName}.`,
						cands.map((c) => c.label),
						sp.min,
						Math.min(sp.max, cands.length),
						tgtKey,
						cands.slice(0, Math.max(1, sp.min)).map((_, idx) => idx)
					);
					return;
				}
				const indices = tgtAns.kind === 'chooseMode' ? tgtAns.indices : [0];
				pickedRefs = indices
					.map((idx) => cands[idx])
					.filter((r): r is TargetRef => Boolean(r));
				if (pickedRefs.length < sp.min) pickedRefs = cands.slice(0, sp.min);
			}
			for (const pr of pickedRefs) usedAcrossOtherTarget.add(`${pr.kind}:${pr.id}`);
			targets.push(...pickedRefs);
			targetsBySpec.push(pickedRefs);
		}

		if (!allTargetsLegal) {
			host.answers[doneItemKey] = { kind: 'yesNo', yes: false };
			continue;
		}

		// CR 707.12: When casting a copy of a card in exile/graveyard/hand, create the card copy in
		// that zone right before casting so the original card remains untouched in its zone!
		let castInst = baseInst;
		let castHolder = sourceHolder;
		if (spec.copyCardFirst) {
			castHolder = actor;
			const copyInst: CardInstance = {
				instanceId: uid('cardcopy', state),
				card: effectiveCardForObject(baseInst),
				ownerId: actor.playerId,
				controllerId: actor.playerId,
				zone: fromZone,
				tapped: false,
				summoningSick: false,
				damageMarked: 0,
				deathtouchDamageMarked: false,
				counters: createEmptyCounterMap(),
				tempPowerMod: 0,
				tempToughnessMod: 0,
				grantedKeywords: [],
				attachedToId: null,
				isToken: true,
				isCommander: false,
				commanderCastCount: 0,
				usedLoyaltyThisTurn: false,
				transformed: false,
				objectVersion: 1
			};
			moveObject(state, copyInst, fromZone, {
				from: 'none',
				toPlayer: actor,
				newTimestamp: true
			});
			castInst = copyInst;
		}

		const req = effectiveSpellManaCost(
			state,
			actor,
			castInst,
			0,
			{ kind: 'free' },
			undefined,
			pickedSetup.faceIndex
		);
		let paidOk = true;
		let descriptions: string[] = [];
		if (pickedSetup.costDefs.length > 0) {
			const ctx = rHost.costContext(state, actor, castInst, 0, true, req);
			const payment = chooseCostPayment(ctx, pickedSetup.costDefs);
			if (!payment) {
				paidOk = false;
			} else {
				const plan = planCosts(ctx, pickedSetup.costDefs, payment);
				if (!plan.ok || plan.question) {
					paidOk = false;
				} else {
					const parts = serializeCostPlanParts(ctx, plan);
					payTapAndManaCostParts(ctx, parts, plan.mana, descriptions);
					const paid = executeCostPaymentParts(ctx, parts, 0, 0, descriptions);
					descriptions = paid.descriptions;
				}
			}
		} else if (!rHost.payManaWithAutoTap(actor, req, state)) {
			paidOk = false;
		}

		if (paidOk) {
			rHost.finalizeCastSpell(state, actor, castInst, castHolder, fromZone, {
				targets,
				...(activeSpecs.length > 0 ? { targetsBySpec } : {}),
				...(chosenModes ? { chosenModes } : {}),
				xValue: 0,
				castOptionId: `${fromZone}:free_cast`,
				faceIndex: pickedSetup.faceIndex,
				spellMods: {
					castSummarySuffix: spec.copyCardFirst ? ' (copied card, free)' : ' (without paying mana cost)',
					...(spec.exileIfPutIntoGraveyard ? { exileIfPutIntoGraveyard: true } : {}),
					...(spec.copyCardFirst ? { exileOnLeaveStack: true } : {})
				},
				exSourceName: host.title,
				descriptions,
				additionalIncomplete: pickedSetup.additionalIncomplete
			});
			// Mark copy on top stack item if `copyCardFirst` (`CR 707.12`).
			if (spec.copyCardFirst && state.stack.length > 0) {
				const topStk = state.stack[state.stack.length - 1];
				if (topStk.sourceInstanceId === castInst.instanceId) {
					topStk.isCopy = true;
				}
			}
			anyCast = true;
			host.answers[doneItemKey] = { kind: 'yesNo', yes: true };
		} else {
			if (spec.copyCardFirst) {
				removeFromGame(castHolder, fromZone, (c) => c.instanceId === castInst.instanceId);
			}
			host.answers[doneItemKey] = { kind: 'yesNo', yes: false };
		}
	}

	host.setStepDecision(anyCast);
}

// ---- 9. Choice-Based Grants & Type Animations -----------------------------------------------

export const BASIC_LAND_TYPE_OPTIONS: ReadonlyArray<{ subtype: string; mana: ManaColor }> = [
	{ subtype: 'Plains', mana: 'W' },
	{ subtype: 'Island', mana: 'U' },
	{ subtype: 'Swamp', mana: 'B' },
	{ subtype: 'Mountain', mana: 'R' },
	{ subtype: 'Forest', mana: 'G' }
];

export function resolveChosenKeywordFromOptions(
	host: P16aStepHost,
	options: readonly string[]
): string | null {
	if (options.length === 0) return null;
	if (options.length === 1) return options[0];
	const key = `choose_kw:${host.stepIndex}`;
	const saved = host.answers[key];
	if (saved?.kind === 'chooseMode') {
		const idx = Math.max(0, Math.min(options.length - 1, saved.indices[0] ?? 0));
		return options[idx];
	}
	if (!host.you.isBot && host.canPause) {
		host.pauseForMode(
			host.you,
			`${host.title} — Choose Keyword`,
			`Choose a keyword ability to grant.`,
			[...options],
			1,
			1,
			key,
			[0]
		);
		return null;
	}
	return options[0];
}

export function resolveChosenProtectionKeyword(host: P16aStepHost): string | null {
	const { labels, colors } = buildColorChoiceOptions();
	const key = `choose_prot_color:${host.stepIndex}`;
	let chosenCode: ManaColor;
	const saved = host.answers[key];
	if (saved?.kind === 'chooseMode') {
		chosenCode = colors[Math.max(0, Math.min(colors.length - 1, saved.indices[0] ?? 0))] ?? 'W';
	} else if (!host.you.isBot && host.canPause) {
		host.pauseForMode(
			host.you,
			`${host.title} — Choose Protection Color`,
			`Choose a color for protection.`,
			labels,
			1,
			1,
			key,
			[0]
		);
		return null;
	} else {
		// Pick color most common on opponents' battlefields, else best color.
		chosenCode = chooseBotBestColor(host.state, host.you);
	}
	const colorWord =
		chosenCode === 'W'
			? 'white'
			: chosenCode === 'U'
				? 'blue'
				: chosenCode === 'B'
					? 'black'
					: chosenCode === 'R'
						? 'red'
						: 'green';
	return `protection from ${colorWord}`;
}

export function resolveChosenCreatureSubtypeForAnimate(host: P16aStepHost): string | null {
	const options = buildCreatureSubtypeOptions(host.state, host.you);
	const key = `choose_ctype:${host.stepIndex}`;
	const saved = host.answers[key];
	if (saved?.kind === 'chooseMode') {
		return options[Math.max(0, Math.min(options.length - 1, saved.indices[0] ?? 0))] ?? 'Human';
	}
	if (!host.you.isBot && host.canPause) {
		host.pauseForMode(
			host.you,
			`${host.title} — Choose Creature Type`,
			`Choose a creature type.`,
			options,
			1,
			1,
			key,
			[0]
		);
		return null;
	}
	return chooseBotBestCreatureSubtype(host.state, host.you);
}

export function resolveChosenBasicLandSubtypeForAnimate(host: P16aStepHost): string | null {
	const options = BASIC_LAND_TYPE_OPTIONS.map((x) => x.subtype);
	const key = `choose_bltype:${host.stepIndex}`;
	const saved = host.answers[key];
	if (saved?.kind === 'chooseMode') {
		return options[Math.max(0, Math.min(options.length - 1, saved.indices[0] ?? 0))] ?? 'Island';
	}
	if (!host.you.isBot && host.canPause) {
		host.pauseForMode(
			host.you,
			`${host.title} — Choose Basic Land Type`,
			`Choose a basic land type.`,
			options,
			1,
			1,
			key,
			[0]
		);
		return null;
	}
	return options[0];
}

// ---- 10. Remove From Combat & Remaining CR 701 Keyword Actions ------------------------------

export function executeRemoveFromCombat(host: P16aStepHost, step: EffectStep): void {
	const state = host.state;
	const objs = host.objects(step.subject).filter((o) => o.zone === 'battlefield');
	if (objs.length === 0) return;
	const ids = new Set(objs.map((o) => o.instanceId));
	state.combat.attackers = state.combat.attackers.filter((a) => !ids.has(a.attackerInstanceId));
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((bId) => !ids.has(bId));
	}
	noteLayerInputsChanged(state);
	host.bind(step, objs);
	for (const o of objs) {
		host.addLog('combat', `${o.card.name} was removed from combat (${host.title}).`, host.you.playerId);
	}
}

/**
 * CR 701.64: Harness — sets `perm.isHarnessed = true` on battlefield permanent(s).
 * Per CR 701.64b, remains harnessed until it leaves the battlefield (cleared in `zones.ts`).
 * Per CR 701.64c, harnessing an already-harnessed permanent does nothing.
 */
export function executeHarness(host: P16aStepHost, step: EffectStep): void {
	const objs = host.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	let changed = false;
	for (const perm of objs) {
		if (perm.isHarnessed) continue;
		perm.isHarnessed = true;
		changed = true;
		host.addLog('rule', `${perm.card.name} became harnessed (CR 701.64a).`, host.you.playerId);
	}
	if (changed) {
		noteLayerInputsChanged(host.state);
	}
	host.bind(step, objs);
}

/**
 * CR 701.28: Convert — turns a transforming double-faced permanent or double-faced token so its
 * other face is up, following transform rules (`CR 701.28a–d`).
 */
export function executeConvert(host: P16aStepHost, step: EffectStep): void {
	const objs = host.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	for (const perm of objs) {
		host.transformPermanent(perm);
	}
	host.bind(step, objs);
}

/**
 * CR 701.71: Empower Jace N —
 * "If you don't control a Jace planeswalker token, create a blue Jace planeswalker token with
 * '[-1]: Surveil 1' and '[-3]: Draw a card' and no loyalty counters on it. Then choose a Jace
 * planeswalker token you control and put N loyalty counters on it."
 */
export function executeEmpowerJace(host: P16aStepHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const n = Math.max(0, host.amount(step.amount, 1));

	const findControlledJaceTokens = (): CardInstance[] =>
		you.battlefield.filter((perm) => {
			if (perm.phasedOut || !perm.isToken) return false;
			const ev = evaluatePermanent(state, perm);
			return ev.typeLine.includes('Planeswalker') && ev.hasSubType('Jace');
		});

	const createdKey = `empjace:init:${host.stepIndex}`;
	if (!host.answers[createdKey]) {
		const existing = findControlledJaceTokens();
		if (existing.length === 0) {
			host.createTokens(
				you,
				{
					name: 'Jace',
					power: 0,
					toughness: 0,
					colors: ['U'],
					typeLine: 'Token Planeswalker — Jace',
					keywords: [],
					quotedAbilities: ['-1: Surveil 1.', '-3: Draw a card.']
				},
				1
			);
		}
		host.answers[createdKey] = { kind: 'yesNo', yes: true };
	}

	const jaceTokens = findControlledJaceTokens();
	if (jaceTokens.length === 0) return;

	let chosenToken = jaceTokens[0];
	if (jaceTokens.length > 1) {
		const pickKey = `empjace:pick:${host.stepIndex}`;
		const savedPick = host.answers[pickKey];
		if (savedPick?.kind === 'chooseObjects') {
			chosenToken =
				jaceTokens.find((t) => t.instanceId === savedPick.objectIds[0]) ?? jaceTokens[0];
		} else if (!you.isBot && host.canPause) {
			host.pauseForChoice(
				you,
				`${host.title} — Empower Jace ${n}`,
				`Choose a Jace planeswalker token you control to put ${n} loyalty counter(s) on (CR 701.71a).`,
				jaceTokens.map((t) => t.instanceId),
				1,
				1,
				'battlefield',
				[jaceTokens[0].instanceId],
				pickKey
			);
			return;
		}
	}

	if (n > 0) {
		host.addCounters(chosenToken, 'loyalty', n);
	}
	host.bind(step, [chosenToken]);
	host.addLog(
		'rule',
		`${you.username} empowered Jace ${n} (CR 701.71a).`,
		you.playerId
	);
}

/**
 * CR 701.72: Assimilate —
 * - Permanent on battlefield: gain control of it, put a +1/+1 counter on it, and it becomes a Borg
 *   artifact creature in addition to its other types.
 * - Permanent card off battlefield: put it onto the battlefield under your control with a +1/+1
 *   counter on it, and it becomes a Borg artifact creature in addition to its other types.
 */
export function executeAssimilate(host: P16aStepHost, step: EffectStep): void {
	const state = host.state;
	const you = host.you;
	const srcFound = host.locate(host.sourceId);
	const sourceVer = host.sourceObjectVersion ?? srcFound?.inst.objectVersion ?? 1;
	const objs = host.objects(step.subject);
	const assimilated: CardInstance[] = [];

	for (const o of objs) {
		const found = host.locate(o.instanceId);
		if (!found) continue;
		if (found.zone === 'battlefield') {
			const perm = found.inst;
			if (perm.phasedOut) continue;
			const ts = allocateTimestamp(state);
			(state.timedContinuousEffects ??= []).push({
				timestamp: ts,
				sourceName: host.sourceCard.name,
				controllerId: you.playerId,
				affected: [{ instanceId: perm.instanceId, objectVersion: perm.objectVersion ?? 1 }],
				expires: 'never',
				layer2: { controllerId: you.playerId },
				layer4: { addTypes: ['Artifact', 'Creature'], addSubtypes: ['Borg'] }
			});
			noteLayerInputsChanged(state);
			syncBattlefieldControllers(state);
			host.addCounters(perm, '+1/+1', 1);
			perm.assimilatedBy = { sourceInstanceId: host.sourceId, sourceObjectVersion: sourceVer };
			assimilated.push(perm);
			host.addLog(
				'rule',
				`${you.username} assimilated ${perm.card.name} (CR 701.72a).`,
				you.playerId
			);
		} else if (
			found.zone === 'graveyard' ||
			found.zone === 'exile' ||
			found.zone === 'hand' ||
			found.zone === 'library'
		) {
			const cardInst = found.inst;
			if (cardInst.isToken) continue;
			const view = resolveObjectFaces(effectiveCardForObject(cardInst), { zone: 'battlefield' });
			const isPermCard = view.types.some((t) =>
				['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(t)
			);
			if (!isPermCard) continue;

			cardInst.isFaceDown = false;
			cardInst.faceDownSpec = undefined;
			cardInst.faceDownLabel = undefined;
			cardInst.summoningSick = !view.keywords.includes('Haste');
			cardInst.tapped = false;
			cardInst.defaultControllerId = you.playerId;

			moveObject(state, cardInst, 'battlefield', {
				from: { player: found.holder, zone: found.zone },
				toPlayer: you,
				controllerId: you.playerId,
				newTimestamp: true,
				bumpVersion: true,
				withCounters: { counter: '+1/+1', count: 1 }
			});

			if (cardInst.zone === 'battlefield') {
				const ts = allocateTimestamp(state);
				(state.timedContinuousEffects ??= []).push({
					timestamp: ts,
					sourceName: host.sourceCard.name,
					controllerId: you.playerId,
					affected: [{ instanceId: cardInst.instanceId, objectVersion: cardInst.objectVersion ?? 1 }],
					expires: 'never',
					layer4: { addTypes: ['Artifact', 'Creature'], addSubtypes: ['Borg'] }
				});
				cardInst.assimilatedBy = { sourceInstanceId: host.sourceId, sourceObjectVersion: sourceVer };
				noteLayerInputsChanged(state);
				assimilated.push(cardInst);
				host.addLog(
					'rule',
					`${you.username} assimilated ${cardInst.card.name} onto the battlefield (CR 701.72b).`,
					you.playerId
				);
			}
		}
	}

	host.bind(step, assimilated);
	host.flushTriggers();
}

/**
 * CR 701.70: Recruit —
 * "Draw a card, then discard a card. If you discard a nonland card this way, create a 1/1 white
 * Human Soldier creature token."
 */
export function executeRecruit(host: P16aStepHost, step: EffectStep): void {
	const state = host.state;
	const actor = (step.actor ? host.playerRef(step.actor) : null) ?? host.you;
	if (!actor || actor.lost) return;

	const stageKey = `recruit:stage:${host.stepIndex}`;
	const discKey = `recruit:disc:${host.stepIndex}`;
	const stageAns = host.answers[stageKey];
	let stage = stageAns?.kind === 'chooseObjects' ? stageAns.objectIds[0] : 'start';

	if (stage === 'start') {
		host.drawCards(actor, 1);
		stage = 'discard';
		host.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['discard'] };
	}

	if (stage === 'discard') {
		if (actor.hand.length === 0) {
			host.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['done'] };
			return;
		}
		let chosenCard: CardInstance | undefined;
		const savedDisc = host.answers[discKey];
		if (savedDisc?.kind === 'chooseObjects') {
			chosenCard = actor.hand.find((c) => c.instanceId === savedDisc.objectIds[0]) ?? actor.hand[0];
		} else if (!actor.isBot && host.canPause && actor.hand.length > 1) {
			host.pauseForChoice(
				actor,
				`${host.title} — Recruit (Discard a Card)`,
				`Choose 1 card to discard. If it's a nonland card, create a 1/1 white Human Soldier creature token (CR 701.70a).`,
				actor.hand.map((c) => c.instanceId),
				1,
				1,
				'hand',
				[actor.hand[0].instanceId],
				discKey
			);
			return;
		} else {
			// Bot prefers discarding a nonland card if it wants the 1/1 Human Soldier token.
			chosenCard =
				actor.hand.find(
					(c) => !resolveObjectFaces(effectiveCardForObject(c), { zone: 'hand' }).types.includes('Land')
				) ?? actor.hand[0];
		}

		if (chosenCard) {
			const wasNonland = !resolveObjectFaces(effectiveCardForObject(chosenCard), {
				zone: 'hand'
			}).types.includes('Land');
			moveObject(state, chosenCard, 'graveyard', {
				from: { player: actor, zone: 'hand' },
				toPlayer: actor,
				graveyardReplacement: true,
				bumpVersion: true,
				newTimestamp: true,
				discardReason: 'discard',
				discardPlayerId: actor.playerId
			});
			host.addLog('rule', `${actor.username} discarded ${chosenCard.card.name} (Recruit).`, actor.playerId);
			if (wasNonland) {
				const created = host.createTokens(
					actor,
					{
						name: 'Human Soldier',
						power: 1,
						toughness: 1,
						colors: ['W'],
						typeLine: 'Token Creature — Human Soldier',
						keywords: []
					},
					1
				);
				host.bind(step, created);
			}
			host.flushTriggers();
		}
		host.answers[stageKey] = { kind: 'chooseObjects', objectIds: ['done'] };
	}
}

/**
 * CR 701.69: Heal — removes all marked damage from permanent(s) on the battlefield.
 */
export function executeHeal(host: P16aStepHost, step: EffectStep): void {
	const objs = host.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	for (const perm of objs) {
		if (perm.damageMarked > 0 || perm.deathtouchDamageMarked) {
			perm.damageMarked = 0;
			perm.deathtouchDamageMarked = false;
			host.addLog('rule', `${perm.card.name} was healed (CR 701.69a).`, host.you.playerId);
		}
	}
	host.bind(step, objs);
}
