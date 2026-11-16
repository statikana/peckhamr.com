/**
 * Wave 7 (Track P19b): Runtime support for remaining CR 605.1b / 605.4a stackless triggered mana
 * abilities, CR 508.3e per-defending-player attack batching, spell-created event delayed triggers
 * (CR 603.7a–b), turn-scoped state tracking, and Wave 7 intervening-if conditions (CR 603.4).
 *
 * Pure data / IR evaluation only: zero raw text reads, zero card-name branches, zero unbounded loops.
 */
import { compileCard } from '../compiler/index.ts';
import type {
	Condition,
	EffectStep,
	EventFilter,
	EventKind,
	ObjectFilter,
	TriggerDef
} from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	GameState,
	ManaColor,
	PlayerGameState,
	StackItem,
	Wave7SpellDelayedTrigger,
	ZoneType
} from '../types.ts';
import { emitEvent, type DamageDealtEvent, type ZoneChangeEvent } from './events.ts';
import { instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import type { FilterContext } from './objectFilter.ts';
import { nextRandom } from './random.ts';

// ---- Active Tap Actor Tracking (CR 603.2, e.g. Hylda of the Icy Crown) ----------------------

let activeTapActorId: string | undefined;

export function withActiveTapActorId<T>(actorId: string | undefined, fn: () => T): T {
	const prev = activeTapActorId;
	activeTapActorId = actorId;
	try {
		return fn();
	} finally {
		activeTapActorId = prev;
	}
}

export function resolveTapActorId(_state: GameState, explicitActorId?: string): string | undefined {
	if (explicitActorId) return explicitActorId;
	if (activeTapActorId) return activeTapActorId;
	return undefined;
}

// ---- CR 605.1b, 605.4a Stackless Triggered Mana Abilities -----------------------------------

const MAX_INLINE_MANA_DEPTH = 8;
let currentInlineManaDepth = 0;

export function isP19bInlineManaEvent(kind: EventKind): boolean {
	return kind === 'tappedForMana' || kind === 'manaAddedByLandAbility';
}

export function canEnterInlineManaResolution(): boolean {
	return currentInlineManaDepth < MAX_INLINE_MANA_DEPTH;
}

export function withInlineManaResolutionGuard<T>(fn: () => T): T | undefined {
	if (currentInlineManaDepth >= MAX_INLINE_MANA_DEPTH) return undefined;
	currentInlineManaDepth += 1;
	try {
		return fn();
	} finally {
		currentInlineManaDepth -= 1;
	}
}

export function matchesManaColorEventFilterP19b(
	filter: EventFilter,
	producedColors: readonly ManaColor[] | undefined,
	sourceChosenColor: ManaColor | undefined
): boolean {
	if (filter.tappedManaColor !== undefined) {
		if (!producedColors || !producedColors.includes(filter.tappedManaColor)) return false;
	}
	if (filter.tappedManaChosenColor) {
		if (!sourceChosenColor || !producedColors || !producedColors.includes(sourceChosenColor)) {
			return false;
		}
	}
	return true;
}

/**
 * Resolves the player who adds mana for an inline CR 605.1b triggered mana ability.
 * Handles "its controller adds ..." (`actor: { k: 'controllerOf', of: { k: 'eventObject' } }`)
 * and "that player adds ..." (`actor: { k: 'eventPlayer' }`).
 */
export function resolveInlineManaRecipientPlayer(
	state: GameState,
	defaultController: PlayerGameState,
	steps: readonly EffectStep[] | undefined,
	eventObject?: CardInstance,
	eventPlayerId?: string
): PlayerGameState {
	const firstActor = steps?.[0]?.actor;
	if (!firstActor) return defaultController;
	if (
		firstActor.k === 'controllerOf' &&
		(firstActor.of.k === 'eventObject' || firstActor.of.k === 'attachedTo')
	) {
		const targetPid = eventObject?.controllerId ?? eventPlayerId;
		if (targetPid) {
			const found = state.players.find((p) => p.playerId === targetPid && !p.lost);
			if (found) return found;
		}
	}
	if (firstActor.k === 'eventPlayer' && eventPlayerId) {
		const found = state.players.find((p) => p.playerId === eventPlayerId && !p.lost);
		if (found) return found;
	}
	return defaultController;
}

export function rewriteInlineManaStepsP19b(
	steps: readonly EffectStep[],
	lastTappedManaColors: readonly ManaColor[] | undefined
): EffectStep[] {
	if (!steps.some((s) => s.verb === 'addMana' && s.params?.manaFromProducedEvent)) {
		return [...steps];
	}
	const out: EffectStep[] = [];
	for (const step of steps) {
		if (step.verb === 'addMana' && step.params?.manaFromProducedEvent) {
			if (!lastTappedManaColors || lastTappedManaColors.length === 0) continue;
			if (lastTappedManaColors.length === 1) {
				out.push({
					...step,
					params: {
						...step.params,
						manaChoice: undefined,
						manaFromProducedEvent: undefined,
						mana: [lastTappedManaColors[0]!]
					}
				});
			} else {
				out.push({
					...step,
					params: {
						...step.params,
						manaFromProducedEvent: undefined,
						manaChoice: [...lastTappedManaColors]
					}
				});
			}
		} else {
			out.push(step);
		}
	}
	return out;
}

// ---- ObjectFilter Parity Helper for runtime/triggers.ts -------------------------------------

export function hasDelegatedObjectFilterFieldsP19b(f: ObjectFilter): boolean {
	return (
		f.sameNameAsLinkedExile !== undefined ||
		f.exiledWithSelf !== undefined ||
		f.sharesTypeWithCommander !== undefined ||
		f.unblockedAttacker !== undefined ||
		f.wasNotCast !== undefined ||
		f.abilitySourceFilter !== undefined ||
		f.artifactEnchantmentOrToken !== undefined ||
		f.powerLessThanSource !== undefined ||
		f.untappedNonattackingSummoningReady !== undefined ||
		f.attackingOrBlocking !== undefined ||
		f.dealtDamageThisTurn !== undefined ||
		f.kickedSpell !== undefined ||
		f.castNotFromHand !== undefined ||
		f.castFromZoneFilter !== undefined ||
		f.castFromZone !== undefined ||
		f.castFromOutsideHand !== undefined ||
		f.sameOwnerAsSource !== undefined ||
		f.bargainedSpell !== undefined ||
		f.targetsAttached !== undefined ||
		f.targetsYouOrFilter !== undefined ||
		f.sharesCardTypeWithExiled !== undefined ||
		f.allSubtypes !== undefined
	);
}

export function buildDelegatedSubFilterP19b(f: ObjectFilter): ObjectFilter {
	return {
		...(f.sameNameAsLinkedExile !== undefined
			? { sameNameAsLinkedExile: f.sameNameAsLinkedExile }
			: {}),
		...(f.exiledWithSelf !== undefined ? { exiledWithSelf: f.exiledWithSelf } : {}),
		...(f.sharesTypeWithCommander !== undefined
			? { sharesTypeWithCommander: f.sharesTypeWithCommander }
			: {}),
		...(f.unblockedAttacker !== undefined ? { unblockedAttacker: f.unblockedAttacker } : {}),
		...(f.wasNotCast !== undefined ? { wasNotCast: f.wasNotCast } : {}),
		...(f.abilitySourceFilter !== undefined ? { abilitySourceFilter: f.abilitySourceFilter } : {}),
		...(f.artifactEnchantmentOrToken !== undefined
			? { artifactEnchantmentOrToken: f.artifactEnchantmentOrToken }
			: {}),
		...(f.powerLessThanSource !== undefined ? { powerLessThanSource: f.powerLessThanSource } : {}),
		...(f.untappedNonattackingSummoningReady !== undefined
			? { untappedNonattackingSummoningReady: f.untappedNonattackingSummoningReady }
			: {}),
		...(f.attackingOrBlocking !== undefined ? { attackingOrBlocking: f.attackingOrBlocking } : {}),
		...(f.dealtDamageThisTurn !== undefined ? { dealtDamageThisTurn: f.dealtDamageThisTurn } : {}),
		...(f.kickedSpell !== undefined ? { kickedSpell: f.kickedSpell } : {}),
		...(f.castNotFromHand !== undefined ? { castNotFromHand: f.castNotFromHand } : {}),
		...(f.castFromZoneFilter !== undefined ? { castFromZoneFilter: f.castFromZoneFilter } : {}),
		...(f.castFromZone !== undefined ? { castFromZone: f.castFromZone } : {}),
		...(f.castFromOutsideHand !== undefined ? { castFromOutsideHand: f.castFromOutsideHand } : {}),
		...(f.sameOwnerAsSource !== undefined ? { sameOwnerAsSource: f.sameOwnerAsSource } : {}),
		...(f.bargainedSpell !== undefined ? { bargainedSpell: f.bargainedSpell } : {}),
		...(f.targetsAttached !== undefined ? { targetsAttached: f.targetsAttached } : {}),
		...(f.targetsYouOrFilter !== undefined ? { targetsYouOrFilter: f.targetsYouOrFilter } : {}),
		...(f.sharesCardTypeWithExiled !== undefined
			? { sharesCardTypeWithExiled: f.sharesCardTypeWithExiled }
			: {}),
		...(f.allSubtypes !== undefined ? { allSubtypes: f.allSubtypes } : {})
	};
}

// ---- Turn-Scoped State Tracking & Cleanup ---------------------------------------------------

export function recordP19bZoneChangeState(state: GameState, ev: ZoneChangeEvent): void {
	if (ev.from === 'battlefield' && ev.to === 'graveyard') {
		const controllerId = ev.lki?.controllerId ?? ev.fromPlayerId ?? ev.object.controllerId;
		const typeLine =
			ev.lki?.typeLine ??
			resolveObjectFaces(effectiveCardForObject(ev.object), instanceFaceOptions(ev.object))
				.typeLine;
		if (controllerId && /\bCreature\b/.test(typeLine)) {
			const controller = state.players.find((p) => p.playerId === controllerId);
			if (controller) {
				controller.creatureDiedUnderControlThisTurn = true;
			}
		}
	}
	if (ev.to === 'battlefield' && !ev.object.phasedOut) {
		const controllerId = ev.toPlayerId ?? ev.object.controllerId;
		const controller = state.players.find((p) => p.playerId === controllerId);
		if (controller) {
			const evaluated = evaluatePermanent(state, ev.object);
			(controller.enteredBattlefieldThisTurnCards ??= []).push({
				card: effectiveCardForObject(ev.object),
				instanceId: ev.object.instanceId,
				isToken: Boolean(ev.object.isToken),
				typeLine: evaluated.typeLine
			});
		}
	}
}

export function recordP19bDamageState(state: GameState, ev: DamageDealtEvent): void {
	if (ev.amount <= 0) return;
	if (ev.targetKind === 'permanent') {
		for (const pl of state.players) {
			const perm = pl.battlefield.find((c) => c.instanceId === ev.targetId);
			if (perm) {
				perm.damageTakenThisTurn = (perm.damageTakenThisTurn ?? 0) + ev.amount;
				break;
			}
		}
	} else if (ev.targetKind === 'player') {
		for (const pl of state.players) {
			const dealer = pl.battlefield.find((c) => c.instanceId === ev.sourceId);
			if (dealer) {
				if (pl.playerId !== ev.targetId) {
					dealer.dealtDamageToOpponentThisTurn = true;
				}
				break;
			}
		}
	}
}

export function isPermanentLandForManaP19b(state: GameState, perm: CardInstance): boolean {
	if (perm.zone === 'battlefield' && !perm.phasedOut) {
		return evaluatePermanent(state, perm).isLand;
	}
	const view = resolveObjectFaces(effectiveCardForObject(perm), instanceFaceOptions(perm));
	return view.types.includes('Land');
}

export function isPermanentTreasureForManaP19b(state: GameState, perm: CardInstance): boolean {
	if (perm.zone === 'battlefield' && !perm.phasedOut) {
		return evaluatePermanent(state, perm).hasSubType('Treasure');
	}
	const view = resolveObjectFaces(effectiveCardForObject(perm), instanceFaceOptions(perm));
	return view.subtypes.includes('Treasure');
}

export function recordP19bTreasureManaAdded(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	amountAdded: number
): void {
	if (amountAdded <= 0) return;
	if (isPermanentTreasureForManaP19b(state, perm)) {
		player.treasureManaInPool = (player.treasureManaInPool ?? 0) + amountAdded;
	}
}

export function totalUnrestrictedAndRestrictedPoolCount(player: PlayerGameState): number {
	const base =
		player.manaPool.W +
		player.manaPool.U +
		player.manaPool.B +
		player.manaPool.R +
		player.manaPool.G +
		player.manaPool.C;
	let restricted = 0;
	if (player.restrictedMana) {
		for (const pool of Object.values(player.restrictedMana)) {
			if (!pool) continue;
			restricted += pool.W + pool.U + pool.B + pool.R + pool.G + pool.C;
		}
	}
	if (player.restrictedManaBuckets) {
		for (const b of player.restrictedManaBuckets) {
			restricted += b.pool.W + b.pool.U + b.pool.B + b.pool.R + b.pool.G + b.pool.C;
		}
	}
	return base + restricted;
}

export function recordP19bManaDeduction(
	player: PlayerGameState,
	poolBefore: number,
	poolAfter: number,
	isSpell: boolean
): void {
	const spent = Math.max(0, poolBefore - poolAfter);
	if (spent <= 0 || !player.treasureManaInPool || player.treasureManaInPool <= 0) return;
	const usedTreasure = Math.min(player.treasureManaInPool, spent);
	if (player.treasureManaInPool - usedTreasure > 0) {
		player.treasureManaInPool = player.treasureManaInPool - usedTreasure;
	} else {
		delete player.treasureManaInPool;
	}
	if (isSpell && usedTreasure > 0) {
		player.spentTreasureManaOnCurrentSpell = true;
	}
}

export function clearP19bPlayerManaPoolTracking(player: PlayerGameState): void {
	delete player.treasureManaInPool;
	delete player.spentTreasureManaOnCurrentSpell;
}

export function clearP19bEndOfTurnState(state: GameState): void {
	delete state.declaringAttackersNow;
	if (state.wave7SpellDelayedTriggers) {
		const remaining = state.wave7SpellDelayedTriggers.filter((d) => !d.expiresEndOfTurn);
		if (remaining.length > 0) state.wave7SpellDelayedTriggers = remaining;
		else delete state.wave7SpellDelayedTriggers;
	}
	for (const p of state.players) {
		delete p.creatureDiedUnderControlThisTurn;
		delete p.spellsCastFromHandThisTurn;
		delete p.treasureManaInPool;
		delete p.spentTreasureManaOnCurrentSpell;
		delete p.lifeGainEventsThisTurn;
		delete p.lifeLossEventsThisTurn;
		delete p.enteredBattlefieldThisTurnCards;
		for (const perm of p.battlefield) {
			delete perm.attacksCountThisTurn;
			delete perm.targetedCountThisTurn;
			delete perm.crewedCountThisTurn;
			delete perm.damageTakenThisTurn;
			delete perm.dealtDamageToOpponentThisTurn;
		}
	}
}

// ---- Spell-Created Event-Driven Delayed Triggers (CR 603.7a–b) ------------------------------

export function isPureSpellDelayedInstantSorceryP19b(item: StackItem): boolean {
	if (item.kind !== 'spell') return false;
	const faceIndex = item.faceIndex ?? 0;
	const compiled = compileCard(item.card);
	const face = compiled.faces[faceIndex];
	if (!face) return false;
	if (face.abilities.some((ab) => ab.kind === 'unsupported' || ab.kind === 'spell')) {
		return false;
	}
	return face.abilities.some((ab) => ab.kind === 'triggered' && ab.trigger.spellDelayed !== undefined);
}

export function registerP19bSpellDelayedTriggers(
	state: GameState,
	item: StackItem,
	controllerId: string,
	allocId: () => string
): void {
	if (item.kind !== 'spell') return;
	const faceIndex = item.faceIndex ?? 0;
	const compiled = compileCard(item.card);
	const face = compiled.faces[faceIndex];
	if (!face) return;
	for (let abilityIndex = 0; abilityIndex < face.abilities.length; abilityIndex++) {
		const ab = face.abilities[abilityIndex]!;
		const trig: TriggerDef | undefined =
			ab.kind === 'triggered'
				? ab.trigger
				: ab.kind === 'unsupported'
					? ab.trigger
					: undefined;
		if (!trig?.spellDelayed) continue;
		const mode = trig.spellDelayed;
		const entry: Wave7SpellDelayedTrigger = {
			id: allocId(),
			controllerId,
			sourceInstanceId: item.sourceInstanceId,
			sourceCard: item.card,
			faceIndex,
			abilityIndex,
			oneShot: mode === 'nextThisTurn' || mode === 'nextUpkeep',
			expiresEndOfTurn: mode === 'nextThisTurn' || mode === 'thisTurn',
			...(mode === 'nextUpkeep' ? { waitForNextUpkeepOfPlayerId: controllerId } : {})
		};
		(state.wave7SpellDelayedTriggers ??= []).push(entry);
	}
}

export function consumeP19bSpellDelayedTrigger(state: GameState, delayedId: string): void {
	if (!state.wave7SpellDelayedTriggers) return;
	const entry = state.wave7SpellDelayedTriggers.find((d) => d.id === delayedId);
	if (!entry || !entry.oneShot) return;
	const next = state.wave7SpellDelayedTriggers.filter((d) => d.id !== delayedId);
	if (next.length > 0) state.wave7SpellDelayedTriggers = next;
	else delete state.wave7SpellDelayedTriggers;
}

// ---- Deterministic Resolution Event Hooks (Coin, Die, Energy, Evolve) -----------------------

export function capturePlayerEnergySnapshot(state: GameState): Map<string, number> {
	const snap = new Map<string, number>();
	for (const p of state.players) {
		snap.set(p.playerId, p.energyCounters || 0);
	}
	return snap;
}

export function emitEnergyDiffEvents(
	state: GameState,
	before: ReadonlyMap<string, number>
): void {
	for (const p of state.players) {
		const prev = before.get(p.playerId) ?? 0;
		const curr = p.energyCounters || 0;
		if (curr > prev) {
			emitEvent(state, {
				kind: 'EnergyGained',
				playerId: p.playerId,
				amount: curr - prev
			});
		}
	}
}

export function emitP19bPostEffectStepEvents(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	steps: readonly EffectStep[],
	preRngState: number | undefined,
	preEnergy: ReadonlyMap<string, number>,
	preSourcePlusOneCounters: number | undefined
): void {
	emitEnergyDiffEvents(state, preEnergy);

	// Deterministic replay of top-level rollDie / flipCoin PRNG draw if RNG advanced cleanly.
	if (preRngState !== undefined && state.rngState !== preRngState && steps.length > 0) {
		const first = steps[0]!;
		if (first.verb === 'rollDie') {
			const sim = { rngState: preRngState } as GameState;
			const sides = Math.max(2, first.params?.dieSides ?? 20);
			const natural = 1 + Math.floor(nextRandom(sim) * sides);
			const total = item.lastRollResult ?? natural;
			emitEvent(state, {
				kind: 'DieRolled',
				playerId: controller.playerId,
				result: total,
				naturalResult: natural,
				sides,
				count: 1
			});
		} else if (first.verb === 'flipCoin') {
			const sim = { rngState: preRngState } as GameState;
			if (first.params?.coinFlipUntilLose) {
				let wins = 0;
				for (let guard = 0; guard < 64; guard++) {
					if (nextRandom(sim) < 0.5) wins += 1;
					else break;
				}
				emitEvent(state, {
					kind: 'CoinFlipped',
					playerId: controller.playerId,
					won: wins > 0,
					wins,
					flips: wins + 1
				});
			} else {
				const count =
					first.amount && first.amount.k === 'const' ? Math.max(1, first.amount.n) : 1;
				let wins = 0;
				for (let i = 0; i < count; i++) {
					if (nextRandom(sim) < 0.5) wins += 1;
				}
				emitEvent(state, {
					kind: 'CoinFlipped',
					playerId: controller.playerId,
					won: wins > 0,
					wins,
					flips: count
				});
			}
		}
	}

	// CR 702.100: Emit `Evolved` when an Evolve triggered ability puts a +1/+1 counter on its source.
	if (
		item.kind === 'triggered' &&
		preSourcePlusOneCounters !== undefined &&
		item.triggeredAbilityIndex !== undefined
	) {
		for (const pl of state.players) {
			const srcPerm = pl.battlefield.find((c) => c.instanceId === item.sourceInstanceId);
			if (srcPerm) {
				const afterPlusOne = srcPerm.counters['+1/+1'] || 0;
				if (afterPlusOne > preSourcePlusOneCounters) {
					const compiled = compileCard(item.card);
					const ab = compiled.faces[item.faceIndex ?? 0]?.abilities[item.triggeredAbilityIndex];
					const isEvolveAbility =
						item.grantedKeyword === 'evolve' ||
						(ab?.kind === 'triggered' && ab.condition?.k === 'evolveCompare');
					if (isEvolveAbility) {
						emitEvent(state, {
							kind: 'Evolved',
							objectId: srcPerm.instanceId,
							object: srcPerm,
							playerId: pl.playerId
						});
					}
				}
				break;
			}
		}
	}
}

// ---- Wave 7 Intervening-If Condition Evaluation (CR 603.4) ----------------------------------

export interface P19bConditionContext {
	state: GameState;
	controllerId: string;
	sourceInstanceId: string;
	source?: CardInstance;
	stackItem?: StackItem;
	triggerEventStackItem?: StackItem;
	eventObject?: CardInstance;
	zone?: ZoneType;
}

function findObjectByIdAcrossZones(state: GameState, instanceId: string): CardInstance | undefined {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (perm.instanceId === instanceId) return perm;
		}
		for (const ex of p.exile) {
			if (ex.instanceId === instanceId) return ex;
		}
		for (const g of p.graveyard) {
			if (g.instanceId === instanceId) return g;
		}
		for (const cmd of p.command) {
			if (cmd.instanceId === instanceId) return cmd;
		}
	}
	return undefined;
}

export function evaluateP19bCondition(
	cond: Condition,
	ctx: P19bConditionContext,
	matchObjFilter: (obj: CardInstance, filter: ObjectFilter, fCtx: FilterContext) => boolean
): boolean | undefined {
	const { state, controllerId, sourceInstanceId } = ctx;
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return false;
	const srcObj = ctx.source ?? findObjectByIdAcrossZones(state, sourceInstanceId);

	switch (cond.k) {
		case 'creatureDiedUnderYourControlThisTurn':
			return Boolean(controller.creatureDiedUnderControlThisTurn);

		case 'treasureManaSpentToCast': {
			const spellItem = ctx.triggerEventStackItem ?? ctx.stackItem;
			if (spellItem?.treasureManaSpent) return true;
			if (ctx.eventObject?.treasureManaSpent) return true;
			if (srcObj?.treasureManaSpent) return true;
			return false;
		}

		case 'noSpellCastFromHandThisTurn':
			return (controller.spellsCastFromHandThisTurn ?? 0) === 0;

		case 'isSuspended':
			return Boolean(srcObj && srcObj.zone === 'exile' && srcObj.isSuspended);

		case 'choseOtherRingBearer': {
			const bearerId = ctx.eventObject?.instanceId ?? controller.ringBearerId;
			return Boolean(bearerId && bearerId !== sourceInstanceId);
		}

		case 'enteredUnderYourControlThisTurn': {
			const need = cond.min ?? 1;
			const records = controller.enteredBattlefieldThisTurnCards ?? [];
			let count = 0;
			for (const rec of records) {
				if (cond.filter.other && rec.instanceId === sourceInstanceId) continue;
				const livePerm = controller.battlefield.find((b) => b.instanceId === rec.instanceId);
				if (livePerm) {
					if (
						matchObjFilter(livePerm, cond.filter, {
							state,
							controllerId,
							source: srcObj,
							zone: 'battlefield'
						})
					) {
						count += 1;
					}
				} else {
					const synthetic: CardInstance = {
						instanceId: rec.instanceId,
						card: rec.card,
						ownerId: controllerId,
						controllerId,
						zone: 'graveyard',
						tapped: false,
						summoningSick: false,
						damageMarked: 0,
						deathtouchDamageMarked: false,
						counters: {} as CardInstance['counters'],
						tempPowerMod: 0,
						tempToughnessMod: 0,
						grantedKeywords: [],
						attachedToId: null,
						isToken: rec.isToken,
						isCommander: false,
						commanderCastCount: 0,
						usedLoyaltyThisTurn: false,
						transformed: false
					};
					if (
						matchObjFilter(synthetic, cond.filter, {
							state,
							controllerId,
							source: srcObj,
							zone: 'graveyard'
						})
					) {
						count += 1;
					}
				}
			}
			return count >= need;
		}

		case 'paidAltCost': {
			const spellItem = ctx.triggerEventStackItem ?? ctx.stackItem;
			const mods = spellItem?.spellMods;
			const optId = spellItem?.castOptionId ?? '';
			if (cond.kind === 'prowl') {
				return Boolean(mods?.prowled || optId.includes('prowl'));
			}
			if (cond.kind === 'surge') {
				return Boolean(mods?.surged || optId.includes('surge'));
			}
			if (cond.kind === 'spectacle') {
				return Boolean(mods?.spectacled || optId.includes('spectacle'));
			}
			return false;
		}

		case 'notBeingDeclaredAsAttacker':
			return !state.declaringAttackersNow;

		case 'selfDealtDamageToOpponentThisTurn':
			return Boolean(srcObj?.dealtDamageToOpponentThisTurn);

		case 'damageDealtToSelfThisTurnAtLeast':
			return (srcObj?.damageTakenThisTurn ?? 0) >= cond.min;

		case 'eventObjectEnteredThisTurn': {
			if (!ctx.eventObject) return false;
			if (ctx.eventObject.enteredThisTurn) return true;
			const currSerial = state.turnSerial ?? state.turnNumber;
			return ctx.eventObject.enteredTurnSerial === currSerial;
		}

		case 'selfEnteredThisTurn': {
			if (!srcObj) return false;
			if (srcObj.enteredThisTurn) return true;
			const currSerial = state.turnSerial ?? state.turnNumber;
			return srcObj.enteredTurnSerial === currSerial;
		}

		case 'distinctManaValuesInGraveyardAtLeast': {
			const mvs = new Set<number>();
			for (const c of controller.graveyard) {
				const view = resolveObjectFaces(effectiveCardForObject(c), instanceFaceOptions(c));
				mvs.add(Math.max(0, Math.floor(view.manaValue ?? c.card.cmc ?? 0)));
			}
			return mvs.size >= cond.min;
		}

		default:
			return undefined;
	}
}
