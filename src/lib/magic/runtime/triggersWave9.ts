/**
 * Wave 9: Runtime trigger dispatch, delayed trigger reconstruction, and intervening-if
 * condition evaluation (CR 603.2c, 603.4, 603.7, 508.1g).
 *
 * Pure data / IR evaluation only: zero rules-text reads, zero card-name branches.
 */
import { compileCard } from '../compiler/index.ts';
import type { RuntimeTrigger } from '../compiler/triggers.ts';
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
	PlayerGameState,
	ScryfallCard,
	SerializedPendingTrigger,
	StackItem,
	Wave7SpellDelayedTrigger,
	ZoneType
} from '../types.ts';
import type { DamageDealtEvent, GameEvent } from './events.ts';
import { instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import type { FilterContext } from './objectFilter.ts';

function readObjectPower(state: GameState, obj: CardInstance): number | null {
	if (obj.zone === 'battlefield') {
		const ev = evaluatePermanent(state, obj);
		return ev.isCreature ? ev.power : null;
	}
	const view = resolveObjectFaces(effectiveCardForObject(obj), instanceFaceOptions(obj));
	if (!view.types.includes('Creature')) return null;
	const n = Number(view.power);
	return Number.isFinite(n) ? n : 0;
}

function readObjectToughness(state: GameState, obj: CardInstance): number | null {
	if (obj.zone === 'battlefield') {
		const ev = evaluatePermanent(state, obj);
		return ev.isCreature ? ev.toughness : null;
	}
	const view = resolveObjectFaces(effectiveCardForObject(obj), instanceFaceOptions(obj));
	if (!view.types.includes('Creature')) return null;
	const n = Number(view.toughness);
	return Number.isFinite(n) ? n : 0;
}

export interface Wave9Source {
	obj: CardInstance;
	card: ScryfallCard;
	faceIndex?: number;
	controllerId: string;
	zone: ZoneType;
	wave7SpellDelayed?: { entry: Wave7SpellDelayedTrigger; runtimeTrigger: RuntimeTrigger };
}

export interface Wave9MatchExtras {
	label: string;
	eventObject?: CardInstance;
	eventPlayerId?: string;
	eventPlayer?: string;
	triggerEventStackItem?: StackItem;
}

export interface Wave9TriggerDispatcher {
	sources(state: GameState, kind: EventKind): Wave9Source[];
	abilitiesFor(
		state: GameState,
		source: Wave9Source,
		kind: EventKind
	): Array<{ ability: RuntimeTrigger; alts: TriggerDef[] }>;
	filterMatches(f: ObjectFilter, subject: unknown, viewer: unknown): boolean;
	objectMatches(f: EventFilter, subject: unknown, source: Wave9Source): boolean;
	viewerOf(source: Wave9Source): unknown;
	battlefieldSubject(state: GameState, obj: CardInstance, controllerId: string): unknown;
	printedSubject(obj: CardInstance, card: ScryfallCard, controllerId: string): unknown;
	record(
		state: GameState,
		source: Wave9Source,
		ability: RuntimeTrigger,
		kind: EventKind,
		extras: Wave9MatchExtras
	): void;
}

export interface Wave9ConditionCtx {
	state: GameState;
	controllerId: string;
	sourceInstanceId: string;
	source?: CardInstance;
	stackItem?: StackItem;
	triggerEventStackItem?: StackItem;
	eventObject?: CardInstance;
	eventLki?: SerializedPendingTrigger['eventLki'];
	eventPlayerId?: string;
}

function findBattlefieldPerm(
	state: GameState,
	instanceId: string
): { obj: CardInstance; controllerId: string } | null {
	for (const p of state.players) {
		if (p.lost) continue;
		const perm = p.battlefield.find((c) => c.instanceId === instanceId && !c.phasedOut);
		if (perm) return { obj: perm, controllerId: p.playerId };
	}
	return null;
}

function liveCountersTotal(counters: Record<string, number | undefined> | undefined): number {
	if (!counters) return 0;
	let total = 0;
	for (const v of Object.values(counters)) {
		if (typeof v === 'number' && v > 0) total += v;
	}
	return total;
}

export function evaluateWave9Condition(
	cond: Condition,
	ctx: Wave9ConditionCtx,
	matchesObjFilter: (obj: CardInstance, f: ObjectFilter, fCtx: FilterContext) => boolean
): boolean | undefined {
	const { state, controllerId, source, stackItem, eventObject, eventLki } = ctx;
	switch (cond.k) {
		case 'isYourMainPhase': {
			const activeId = state.players[state.activePlayerIndex]?.playerId;
			return (
				activeId === controllerId &&
				(state.phase === 'main1' || state.phase === 'main2')
			);
		}
		case 'counterPutOnSelfThisTurn': {
			if (source && source.zone === 'battlefield' && source.counterPutOnThisTurn) {
				return true;
			}
			if (stackItem?.sourceCounterPutOnThisTurn) return true;
			const live = ctx.sourceInstanceId ? findBattlefieldPerm(state, ctx.sourceInstanceId) : null;
			return Boolean(live?.obj.counterPutOnThisTurn);
		}
		case 'playerHadAnotherLandEnterThisTurn': {
			const targetPid =
				ctx.eventPlayerId ??
				stackItem?.eventPlayerId ??
				state.players[state.activePlayerIndex]?.playerId ??
				controllerId;
			const pl = state.players.find((p) => p.playerId === targetPid);
			if (!pl) return false;
			const enteredLands =
				pl.enteredBattlefieldThisTurnCards?.filter((e) => /\bLand\b/i.test(e.typeLine)).length ?? 0;
			return enteredLands >= 2;
		}
		case 'eventEnteredOrCastFromGraveyardAny': {
			const evObj =
				eventObject ??
				(stackItem?.eventObjectId ? findBattlefieldPerm(state, stackItem.eventObjectId)?.obj : undefined);
			const evStk = ctx.triggerEventStackItem ?? stackItem?.triggerEventStackItem;
			if (evObj?.castFromZone === 'graveyard' || evObj?.enteredFromZone === 'graveyard') {
				return true;
			}
			if (evStk?.castFromZone === 'graveyard') return true;
			if (stackItem?.castFromZone === 'graveyard') return true;
			return false;
		}
		case 'hasCardsExiledWithSelf': {
			const srcId = source?.instanceId ?? ctx.sourceInstanceId;
			const srcVer = source?.objectVersion ?? stackItem?.sourceObjectVersion ?? 1;
			if (!srcId) return false;
			for (const p of state.players) {
				for (const ex of p.exile) {
					if (
						ex.exiledBy?.sourceInstanceId === srcId &&
						(ex.exiledBy.sourceObjectVersion ?? 1) === srcVer
					) {
						return true;
					}
				}
			}
			return false;
		}
		case 'noSameNameControlledOrInGraveyard': {
			const subj =
				eventObject ??
				(stackItem?.eventObjectId ? findBattlefieldPerm(state, stackItem.eventObjectId)?.obj : undefined) ??
				source;
			if (!subj) return false;
			if (subj.isFaceDown) return true; // CR 708.2: face-down permanent has no name
			const subjEval = subj.zone === 'battlefield' ? evaluatePermanent(state, subj) : null;
			const subjName = (
				subjEval
					? subjEval.effectiveName
					: resolveObjectFaces(effectiveCardForObject(subj), instanceFaceOptions(subj)).name
			).trim();
			if (!subjName) return true;
			const lowerName = subjName.toLowerCase();
			const ctrl = state.players.find((p) => p.playerId === controllerId);
			if (!ctrl) return true;
			for (const perm of ctrl.battlefield) {
				if (perm.phasedOut || perm.instanceId === subj.instanceId || perm.isFaceDown) continue;
				const ev = evaluatePermanent(state, perm);
				if (ev.isCreature && ev.effectiveName.toLowerCase() === lowerName) return false;
			}
			for (const gy of ctrl.graveyard) {
				if (gy.isFaceDown) continue;
				const view = resolveObjectFaces(effectiveCardForObject(gy), instanceFaceOptions(gy, 'graveyard'));
				if (view.types.includes('Creature') && view.name.toLowerCase() === lowerName) return false;
			}
			return true;
		}
		case 'lkiToughnessLessThan': {
			if (eventLki?.toughness !== undefined) {
				return eventLki.toughness < cond.max;
			}
			const obj =
				eventObject ??
				(stackItem?.eventObjectId ? findBattlefieldPerm(state, stackItem.eventObjectId)?.obj : undefined);
			if (!obj) return false;
			const t = readObjectToughness(state, obj);
			return t !== null && t < cond.max;
		}
		case 'manaSpentGreaterThanSelfPower': {
			const selfPerm = source?.zone === 'battlefield'
				? source
				: ctx.sourceInstanceId
					? findBattlefieldPerm(state, ctx.sourceInstanceId)?.obj
					: undefined;
			const selfPower = selfPerm ? (readObjectPower(state, selfPerm) ?? 0) : 0;
			const evStk = ctx.triggerEventStackItem ?? stackItem?.triggerEventStackItem;
			const spent =
				evStk?.manaSpentCount ??
				eventObject?.manaSpentCount ??
				stackItem?.manaSpentCount ??
				0;
			return spent > selfPower;
		}
		case 'countersAmongFilterAtLeast': {
			let total = 0;
			for (const p of state.players) {
				if (p.lost) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (
						matchesObjFilter(perm, cond.filter, {
							state,
							controllerId,
							source,
							stackItem
						})
					) {
						total += liveCountersTotal(perm.counters);
					}
				}
			}
			return total >= cond.min;
		}
		case 'didntActivateLoyaltyThisTurn': {
			const ctrl = state.players.find((p) => p.playerId === controllerId);
			return !ctrl?.activatedLoyaltyAbilityThisTurn;
		}
		case 'notPutOntoBattlefieldByThisAbility': {
			const srcId = source?.instanceId ?? ctx.sourceInstanceId;
			const srcVer = source?.objectVersion ?? stackItem?.sourceObjectVersion ?? 1;
			const abIdx = stackItem?.kind === 'triggered' ? stackItem.triggeredAbilityIndex : undefined;
			const evObj =
				eventObject ??
				(stackItem?.eventObjectId ? findBattlefieldPerm(state, stackItem.eventObjectId)?.obj : undefined);
			if (!evObj?.putOntoBattlefieldByAbilityKey || !srcId || abIdx === undefined) return true;
			const key = `${srcId}:${srcVer}:${abIdx}`;
			return evObj.putOntoBattlefieldByAbilityKey !== key;
		}
		case 'anyAttackedPlayerWithMostLife': {
			const living = state.players.filter((p) => !p.lost);
			if (living.length === 0) return false;
			const maxLife = Math.max(...living.map((p) => p.life));
			const atks = state.combat.attackers;
			if (atks.length === 0) return false;
			return atks.some((atk) => {
				if (atk.defenderPlaneswalkerId || atk.defenderBattleId) return false;
				const defPl = living.find((p) => p.playerId === atk.defenderPlayerId);
				return defPl !== undefined && defPl.life >= maxLife;
			});
		}
		case 'additionalCostPaidThisSpell': {
			if (
				stackItem?.additionalCostPaid ||
				stackItem?.spellMods?.additionalCostPaid ||
				stackItem?.additionalCostPaidOnCast ||
				source?.additionalCostPaidOnCast
			) {
				return true;
			}
			if (stackItem?.kind === 'triggered' && (stackItem.sourceKickedCount ?? 0) > 0) {
				return true;
			}
			if (
				stackItem?.optionalCostCounts &&
				Object.values(stackItem.optionalCostCounts).some((n) => (n ?? 0) > 0)
			) {
				return true;
			}
			return false;
		}
		default:
			return undefined;
	}
}

export function lkiCounterTotal(
	state: GameState,
	counter: import('../types.ts').CounterType | 'any',
	eventObject?: CardInstance,
	eventLki?: StackItem['eventLki']
): number {
	const bag = eventLki?.counters ?? (eventObject ? findBattlefieldPerm(state, eventObject.instanceId)?.obj.counters : undefined) ?? eventObject?.counters;
	if (!bag) return 0;
	if (counter === 'any') return liveCountersTotal(bag);
	return bag[counter] ?? 0;
}

export function isEnchantedPlayerId(source: Wave9Source, playerId: string): boolean {
	return Boolean(source.obj.attachedToId && source.obj.attachedToId === playerId);
}

export function matchesWave9AttacksFilter(
	state: GameState,
	f: EventFilter,
	source: Wave9Source,
	attackingPlayerId: string,
	attackerIds: string[]
): boolean {
	if (f.attackingTotalPowerMin !== undefined) {
		let totalPower = 0;
		for (const id of attackerIds) {
			const perm = findBattlefieldPerm(state, id);
			if (perm) totalPower += readObjectPower(state, perm.obj) ?? 0;
		}
		if (totalPower < f.attackingTotalPowerMin) return false;
	}
	if (f.attackEnchantedOrAttackedByEnchanted) {
		const enchId = source.obj.attachedToId;
		if (!enchId) return false;
		const isEnchAttacking = attackingPlayerId === enchId;
		const isAttackingEnch = state.combat.attackers.some(
			(a) => !a.defenderPlaneswalkerId && !a.defenderBattleId && a.defenderPlayerId === enchId
		);
		if (!isEnchAttacking && !isAttackingEnch) return false;
	}
	return true;
}

export function matchesWave9DamagedTargetMin(
	state: GameState,
	ev: DamageDealtEvent,
	min: number
): boolean {
	if (ev.amount >= min) return true;
	return false;
}

export function reconstructWave9DelayedRuntimeTrigger(
	dt: Wave7SpellDelayedTrigger
): RuntimeTrigger | null {
	if (dt.subTriggerStepIndex === undefined) return null;
	const compiled = compileCard(dt.sourceCard);
	const face = compiled.faces[dt.faceIndex ?? 0];
	if (!face) return null;
	const ab = face.abilities[dt.abilityIndex];
	if (!ab) return null;
	const steps: EffectStep[] | undefined =
		ab.kind === 'spell' || ab.kind === 'activated' || ab.kind === 'triggered'
			? ab.effect
			: undefined;
	const step = steps?.[dt.subTriggerStepIndex];
	if (!step?.delayed) return null;
	return {
		abilityIndex: dt.abilityIndex,
		trigger: step.delayed.trigger,
		effect: {
			steps: step.delayed.effect,
			targets: step.delayed.targets ?? [],
			unparsed: []
		},
		effectSupported: true,
		text: `${dt.sourceCard.name} delayed trigger`
	};
}

export function dispatchWave9TriggerEvent(
	state: GameState,
	ev: GameEvent,
	d: Wave9TriggerDispatcher
): boolean {
	if (ev.kind === 'TokenCreated') {
		const perm = findBattlefieldPerm(state, ev.objectId);
		const subj = perm
			? d.battlefieldSubject(state, perm.obj, perm.controllerId)
			: d.printedSubject(ev.object, ev.object.card, ev.playerId);
		for (const source of d.sources(state, 'tokenCreated')) {
			for (const { ability, alts } of d.abilitiesFor(state, source, 'tokenCreated')) {
				const alt = alts.find((a) => {
					const rel = a.filter.player?.relation ?? 'any';
					if (rel === 'you' && ev.playerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
					if (a.filter.object && !d.objectMatches(a.filter, subj, source)) return false;
					return true;
				});
				if (!alt) continue;
				d.record(state, source, ability, 'tokenCreated', {
					label: 'Token Created Trigger',
					eventObject: perm?.obj ?? ev.object,
					eventPlayerId: ev.playerId,
					eventPlayer: ev.playerId
				});
			}
		}
		return true;
	}
	if (ev.kind === 'GiftGiven') {
		for (const source of d.sources(state, 'giftGiven')) {
			for (const { ability, alts } of d.abilitiesFor(state, source, 'giftGiven')) {
				const alt = alts.find((a) => {
					const rel = a.filter.player?.relation ?? 'any';
					if (rel === 'you' && ev.playerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
					return true;
				});
				if (!alt) continue;
				d.record(state, source, ability, 'giftGiven', {
					label: 'Gift Trigger',
					eventPlayerId: ev.playerId,
					eventPlayer: ev.playerId
				});
			}
		}
		return true;
	}
	if (ev.kind === 'AttackTriggered') {
		for (const source of d.sources(state, 'attackTriggered')) {
			for (const { ability, alts } of d.abilitiesFor(state, source, 'attackTriggered')) {
				const alt = alts.find((a) => {
					const rel = a.filter.player?.relation ?? 'any';
					if (rel === 'you' && ev.controllerId !== source.controllerId) return false;
					if (rel === 'opponent' && ev.controllerId === source.controllerId) return false;
					return true;
				});
				if (!alt) continue;
				const stkItem =
					ev.triggerStackItemIndex !== undefined
						? state.stack[ev.triggerStackItemIndex]
						: undefined;
				d.record(state, source, ability, 'attackTriggered', {
					label: 'Attack Ability Trigger',
					eventObject: ev.source,
					eventPlayerId: ev.controllerId,
					eventPlayer: ev.controllerId,
					...(stkItem ? { triggerEventStackItem: stkItem } : {})
				});
			}
		}
		return true;
	}
	return false;
}

export function runWave9NextCombatDelayedTriggers(
	state: GameState,
	slotId?: string,
	discardOnly = false
): void {
	if (!state.wave7SpellDelayedTriggers?.length) return;
	const list = state.wave7SpellDelayedTriggers;
	const hasPairedForSlot =
		slotId !== undefined &&
		list.some((dt) => dt.waitForNextCombatThisTurn && dt.extraCombatSlotId === slotId);
	let fallbackUnpairedIdx = -1;
	if (!hasPairedForSlot) {
		for (let i = list.length - 1; i >= 0; i--) {
			const dt = list[i]!;
			if (dt.waitForNextCombatThisTurn && !dt.extraCombatSlotId) {
				fallbackUnpairedIdx = i;
				break;
			}
		}
	}
	const remaining: Wave7SpellDelayedTrigger[] = [];
	for (let i = 0; i < list.length; i++) {
		const dt = list[i]!;
		if (!dt.waitForNextCombatThisTurn) {
			remaining.push(dt);
			continue;
		}
		const matchesPaired =
			slotId !== undefined && dt.extraCombatSlotId !== undefined && dt.extraCombatSlotId === slotId;
		const matchesFallback = !hasPairedForSlot && i === fallbackUnpairedIdx;
		if (!matchesPaired && !matchesFallback) {
			remaining.push(dt);
			continue;
		}
		if (!discardOnly) {
			// *Moraug, Fury of Akoum*: "At the beginning of that combat, untap all creatures you control."
			const ctrl = state.players.find((p) => p.playerId === dt.controllerId && !p.lost);
			if (ctrl) {
				for (const perm of ctrl.battlefield) {
					if (perm.phasedOut || !perm.tapped) continue;
					if (evaluatePermanent(state, perm).isCreature) {
						perm.tapped = false;
					}
				}
			}
		}
	}
	if (remaining.length > 0) state.wave7SpellDelayedTriggers = remaining;
	else delete state.wave7SpellDelayedTriggers;
}

export function clearWave9TurnStartState(state: GameState, activePlayerId: string): void {
	delete state.activatedLoyaltyAbilityThisTurn;
	delete state.extraCombatSlotIds;
	const curTurnSerial = state.turnSerial ?? state.turnNumber;
	for (const p of state.players) {
		delete p.lifeLossEventsOnOwnTurn;
		delete p.activatedLoyaltyAbilityThisTurn;
		for (const perm of p.battlefield) {
			delete perm.counterPutOnThisTurn;
		}
	}
	if (state.wave7SpellDelayedTriggers?.length) {
		const keep = state.wave7SpellDelayedTriggers.filter((dt) => {
			if (dt.waitForNextCombatThisTurn) return false;
			if (
				dt.untilYourNextTurnOfPlayerId === activePlayerId &&
				curTurnSerial > (dt.createdOnTurnSerial ?? 0)
			) {
				return false;
			}
			return true;
		});
		if (keep.length > 0) state.wave7SpellDelayedTriggers = keep;
		else delete state.wave7SpellDelayedTriggers;
	}
}
