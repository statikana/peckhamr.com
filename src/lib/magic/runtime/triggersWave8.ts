/**
 * Wave 8 (Track P22b): Runtime support for trigger-head & intervening-if expansions,
 * loyalty/ability-activation/vote/clash/shuffle/counter/saga/saddle triggers, CR 603.8
 * state-trigger evaluation, and P22b cost / additional-cost / cost-modifier mechanics.
 *
 * Pure data / IR evaluation only: zero raw text reads, zero card-name branches, zero unbounded loops.
 */
import type {
	Amount,
	Condition,
	CostDef,
	EventFilter,
	ObjectFilter,
	StaticDef
} from '../ir.ts';
import { parseManaCost } from '../oracle.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type SerializedPlannedCost,
	type StackItem,
	type ZoneType
} from '../types.ts';
import type { CostContext, CostQuestion, PaidCosts } from './costs.ts';
import type { MatchesFilterFn } from './costsWave6.ts';
import { emitEvent, type GameEvent } from './events.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { splitSubtypes } from './layers.ts';
import {
	objectManaValue,
	evaluateAmount,
	type FilterContext
} from './objectFilter.ts';
import { markHandCardRevealedToAll } from './staticsLayersAndRestrictions.ts';
import {
	moveObject,
	type PlayerZone
} from './zones.ts';

// ---- Helpers ---------------------------------------------------------------------------------

const FIVE_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

function findBattlefieldPerm(
	state: GameState,
	id: string
): { obj: CardInstance; controllerId: string } | undefined {
	for (const p of state.players) {
		for (const b of p.battlefield) {
			if (!b.phasedOut && b.instanceId === id) return { obj: b, controllerId: p.playerId };
		}
	}
	return undefined;
}

function findObjectInAnyZone(state: GameState, id: string): CardInstance | undefined {
	for (const p of state.players) {
		for (const b of p.battlefield) if (b.instanceId === id) return b;
		for (const c of p.hand) if (c.instanceId === id) return c;
		for (const c of p.graveyard) if (c.instanceId === id) return c;
		for (const c of p.exile) if (c.instanceId === id) return c;
		for (const c of p.library) if (c.instanceId === id) return c;
		for (const c of p.command) if (c.instanceId === id) return c;
	}
	return state.stack.find((s) => s.sourceInstanceId === id)
		? undefined
		: undefined;
}

function syntheticInstance(
	card: ScryfallCard,
	ownerId: string,
	zone: ZoneType,
	instanceId = 'synthetic'
): CardInstance {
	return {
		instanceId,
		card,
		ownerId,
		controllerId: ownerId,
		zone,
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters: createEmptyCounterMap(),
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: false,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false
	};
}

function clonePlainCard(card: ScryfallCard): ScryfallCard {
	return JSON.parse(JSON.stringify(card)) as ScryfallCard;
}

function activePlayerTeamIds(state: GameState, playerId: string): string[] {
	// CR 810.2 / 805: Check team metadata if present; otherwise a 1-player team.
	const p = state.players.find((pl) => pl.playerId === playerId) as
		| (PlayerGameState & { teamId?: string | number })
		| undefined;
	if (p?.teamId !== undefined) {
		return state.players
			.filter(
				(pl) =>
					!pl.lost &&
					(pl as PlayerGameState & { teamId?: string | number }).teamId === p.teamId
			)
			.map((pl) => pl.playerId);
	}
	return [playerId];
}

function effectiveCardFacesTypes(obj: CardInstance, lkiCard?: ScryfallCard): string[] {
	const card = lkiCard ?? effectiveCardForObject(obj);
	const resolved = resolveObjectFaces(card, instanceFaceOptions(obj, obj.zone));
	return resolved.types;
}

function totalCountersOnObj(obj: CardInstance, counter?: CounterType | 'any'): number {
	const map = obj.counters ?? ({} as Record<string, number>);
	if (counter && counter !== 'any') return map[counter] ?? 0;
	let sum = 0;
	for (const v of Object.values(map)) {
		if (v > 0) sum += v;
	}
	return sum;
}

// ---- Turn-Scoped State Tracking --------------------------------------------------------------

export function snapshotP22bLifeLostLastTurn(player: PlayerGameState): void {
	player.lifeLostLastTurn = player.lifeLostThisTurn ?? 0;
}

export function clearP22bEndOfTurnState(state: GameState): void {
	delete state.battlefieldToGraveyardThisTurnCards;
	for (const p of state.players) {
		delete p.discardedCardThisTurn;
		delete p.lastDrawnCardIdThisTurn;
		delete p.drawsInYourDrawStepThisTurn;
		delete p.putCounterOnCreatureThisTurn;
		delete p.sacrificedCardsThisTurn;
		delete p.castCreatureSpellThisTurn;
		delete p.castNoncreatureSpellThisTurn;
		for (const perm of p.battlefield) {
			delete perm.dealtExcessDamageThisTurn;
			delete perm.addedManaThisTurn;
		}
	}
}

export function recordP22bTurnEvent(state: GameState, ev: GameEvent): void {
	switch (ev.kind) {
		case 'CardDiscarded': {
			const pl = state.players.find((p) => p.playerId === ev.playerId);
			if (pl) pl.discardedCardThisTurn = true;
			break;
		}
		case 'CounterPlaced': {
			if (ev.amount <= 0) break;
			if (!evaluatePermanent(state, ev.object).isCreature) break;
			const actorId = ev.actorId ?? state.players[state.activePlayerIndex]?.playerId;
			const pl = state.players.find((p) => p.playerId === actorId);
			if (pl) pl.putCounterOnCreatureThisTurn = true;
			break;
		}
		case 'ZoneChange': {
			if (ev.from === 'battlefield' && ev.to === 'graveyard') {
				const card = ev.lki?.card ?? effectiveCardForObject(ev.object);
				(state.battlefieldToGraveyardThisTurnCards ??= []).push(clonePlainCard(card));
			}
			break;
		}
		case 'Sacrificed': {
			const pl = state.players.find((p) => p.playerId === ev.playerId);
			if (pl) {
				const card = ev.lki?.card ?? effectiveCardForObject(ev.object);
				(pl.sacrificedCardsThisTurn ??= []).push(clonePlainCard(card));
			}
			break;
		}
		case 'Cast': {
			const pl = state.players.find((p) => p.playerId === ev.playerId);
			if (pl) {
				const types = effectiveCardFacesTypes(ev.object);
				if (types.includes('Creature')) {
					pl.castCreatureSpellThisTurn = true;
				} else {
					pl.castNoncreatureSpellThisTurn = true;
				}
			}
			break;
		}
	}
}

export function recordP22bExcessDamage(
	target: CardInstance,
	dmg: number,
	hasDeathtouch: boolean,
	targetIsCreature: boolean,
	targetToughness: number
): void {
	if (!targetIsCreature || dmg <= 0) return;
	const dmgBefore = target.damageMarked;
	const lethalRemaining = hasDeathtouch
		? dmgBefore > 0
			? 0
			: 1
		: Math.max(0, targetToughness - dmgBefore);
	const excess = Math.max(0, dmg - lethalRemaining);
	if (excess > 0) {
		target.dealtExcessDamageThisTurn = (target.dealtExcessDamageThisTurn ?? 0) + excess;
	}
}

// ---- ObjectFilter Helpers --------------------------------------------------------------------

export function hasP22bObjectFilterFields(filter: ObjectFilter): boolean {
	return Boolean(
		filter.enchantedOrEquipped ||
			filter.controllerAndNotOwner !== undefined ||
			filter.dealtDamageByAttachedThisTurn
	);
}

export function matchesP22bObjectFilter(
	obj: CardInstance,
	filter: ObjectFilter,
	ctx: FilterContext
): boolean {
	if (filter.enchantedOrEquipped) {
		if (obj.zone !== 'battlefield') return false;
		const attached = ctx.state.players.some((p) =>
			p.battlefield.some((att) => {
				if (att.phasedOut || att.attachedToId !== obj.instanceId) return false;
				const evAtt = evaluatePermanent(ctx.state, att);
				return evAtt.hasSubType('Aura') || evAtt.hasSubType('Equipment');
			})
		);
		if (!attached) return false;
	}
	if (filter.controllerAndNotOwner !== undefined) {
		const ctrlId = obj.controllerId;
		if (ctrlId === obj.ownerId) return false;
		if (filter.controllerAndNotOwner === 'you' && ctrlId !== ctx.controllerId) return false;
		if (filter.controllerAndNotOwner === 'opponent' && ctrlId === ctx.controllerId) return false;
	}
	if (filter.dealtDamageByAttachedThisTurn) {
		const srcHostId = ctx.source?.attachedToId;
		if (!srcHostId) return false;
		const damagedBy =
			obj.damagedByThisTurn ??
			ctx.lki?.damagedByThisTurn ??
			[];
		if (!damagedBy.some((d) => d.sourceId === srcHostId)) return false;
	}
	return true;
}

// ---- Amount Evaluation -----------------------------------------------------------------------

export function evaluateP22bAmount(
	amt: Amount,
	state: GameState,
	controllerId: string,
	stackItem?: StackItem
): number | null {
	switch (amt.k) {
		case 'opponentsLifeLostThisTurn': {
			let sum = 0;
			for (const p of state.players) {
				if (p.playerId !== controllerId && !p.lost) {
					sum += p.lifeLostThisTurn ?? 0;
				}
			}
			return sum;
		}
		case 'targetsTotalManaValue': {
			if (!stackItem?.targets?.length) return 0;
			let total = 0;
			for (const t of stackItem.targets) {
				if (t.kind === 'permanent') {
					const found = findBattlefieldPerm(state, t.id);
					if (found) total += objectManaValue(state, found.obj);
				} else if (t.kind === 'stack') {
					const stk = state.stack.find((s) => s.id === t.id);
					if (stk) total += objectManaValue(state, stk);
				}
			}
			return total;
		}
		default:
			return null;
	}
}

// ---- Intervening-If Condition Evaluation (CR 603.4) ------------------------------------------

export interface P22bConditionContext {
	state: GameState;
	controllerId: string;
	sourceInstanceId: string;
	source?: CardInstance;
	stackItem?: StackItem;
	triggerEventStackItem?: StackItem;
	eventObject?: CardInstance;
	eventLki?: {
		card?: ScryfallCard;
		controllerId?: string;
		typeLine?: string;
		attachedIds?: string[];
		damagedByThisTurn?: Array<{ sourceId: string; sourceVersion?: number }>;
	};
	eventPlayerId?: string;
	eventIsManaAbility?: boolean;
	eventLifePaid?: number;
	eventCrewCount?: number;
	eventDamageSourceSubtypes?: string[];
	eventAttackedTargetPlayerId?: string;
}

export function evaluateP22bCondition(
	cond: Condition,
	ctx: P22bConditionContext,
	matchObjFilter: (obj: CardInstance, filter: ObjectFilter, fCtx: FilterContext) => boolean
): boolean | undefined {
	const { state, controllerId, sourceInstanceId } = ctx;
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return undefined;
	const srcObj = ctx.source ?? findObjectInAnyZone(state, sourceInstanceId);

	switch (cond.k) {
		case 'eventAbilityIsNotMana': {
			if (ctx.eventIsManaAbility !== undefined) return !ctx.eventIsManaAbility;
			const evStk = ctx.triggerEventStackItem;
			if (evStk) return evStk.kind === 'activated';
			return undefined;
		}
		case 'eventAbilityLifePaid': {
			if (ctx.eventLifePaid !== undefined) return ctx.eventLifePaid > 0;
			const life = ctx.triggerEventStackItem?.abilityLifePaidCount ?? 0;
			return life > 0;
		}
		case 'eventSpellWasKicked': {
			const evStk = ctx.triggerEventStackItem;
			if (evStk?.optionalCostCounts && Object.values(evStk.optionalCostCounts).some((v) => v > 0)) {
				return true;
			}
			const evObj = ctx.eventObject;
			return Boolean((evObj?.kickedCount ?? 0) > 0);
		}
		case 'eventSpellHasKeyword': {
			const kwLower = cond.keyword.toLowerCase();
			const evStk = ctx.triggerEventStackItem;
			if (evStk) {
				if (evStk.grantedSpellKeywords?.some((k) => k.toLowerCase() === kwLower)) return true;
				const abs = activeAbilityDefs(evStk.card, {
					zone: 'stack',
					faceIndex: evStk.faceIndex ?? 0,
					fused: evStk.fused
				});
				if (abs.some((ab) => ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === kwLower)) {
					return true;
				}
			}
			const evObj = ctx.eventObject;
			if (evObj) {
				const abs = activeAbilityDefs(
					effectiveCardForObject(evObj),
					instanceFaceOptions(evObj, evObj.zone)
				);
				if (abs.some((ab) => ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === kwLower)) {
					return true;
				}
			}
			return false;
		}
		case 'eventSpellNoColoredManaSpent': {
			const evStk = ctx.triggerEventStackItem;
			if (evStk?.coloredManaSpentToCast !== undefined) {
				return evStk.coloredManaSpentToCast === 0;
			}
			const colors = evStk?.manaColorsSpent ?? ctx.eventObject?.manaColorsSpent ?? [];
			return !colors.some((c) => FIVE_COLORS.includes(c));
		}
		case 'eventSpellManaSpentLessThanMv': {
			const evStk = ctx.triggerEventStackItem;
			if (!evStk) return false;
			const spent = evStk.manaSpentToCastCount ?? evStk.manaSpentCount ?? 0;
			const mv = objectManaValue(state, evStk);
			return spent < mv;
		}
		case 'eventEnteredOrCastFromZone': {
			if (ctx.triggerEventStackItem?.castFromZone === cond.zone) return true;
			if (ctx.eventObject?.enteredFromZone === cond.zone) return true;
			if (ctx.eventObject?.castFromZone === cond.zone) return true;
			if (srcObj?.enteredFromZone === cond.zone) return true;
			if (srcObj?.castFromZone === cond.zone) return true;
			return false;
		}
		case 'eventObjectPowerOrToughnessGreaterThanSelf': {
			if (!srcObj || !ctx.eventObject) return false;
			const selfEv = evaluatePermanent(state, srcObj);
			const otherEv = evaluatePermanent(state, ctx.eventObject);
			return otherEv.power > selfEv.power || otherEv.toughness > selfEv.toughness;
		}
		case 'eventObjectWasNotSubtype': {
			const subLower = cond.subtype.toLowerCase();
			if (ctx.eventLki?.typeLine) {
				const subs = splitSubtypes(ctx.eventLki.typeLine).map((s) => s.toLowerCase());
				return !subs.includes(subLower);
			}
			if (ctx.eventObject) {
				if (ctx.eventObject.zone === 'battlefield') {
					const ev = evaluatePermanent(state, ctx.eventObject);
					return !ev.hasAllCreatureTypes && !ev.hasSubType(cond.subtype);
				}
				const card = effectiveCardForObject(ctx.eventObject);
				const view = resolveObjectFaces(card, instanceFaceOptions(ctx.eventObject, ctx.eventObject.zone));
				return !view.subtypes.some((s) => s.toLowerCase() === subLower);
			}
			return false;
		}
		case 'eventWasAttachedEnchantedOrEquipped': {
			const attachedIds = ctx.eventLki?.attachedIds ?? [];
			if (attachedIds.length > 0) {
				for (const attId of attachedIds) {
					const att = findBattlefieldPerm(state, attId) ?? findObjectInAnyZone(state, attId);
					if (att) {
						const inst = 'obj' in att ? att.obj : att;
						if (inst.zone === 'battlefield') {
							const ev = evaluatePermanent(state, inst);
							if (ev.hasSubType('Aura') || ev.hasSubType('Equipment')) return true;
						} else {
							const view = resolveObjectFaces(
								effectiveCardForObject(inst),
								instanceFaceOptions(inst, inst.zone)
							);
							if (view.subtypes.includes('Aura') || view.subtypes.includes('Equipment')) return true;
						}
					}
				}
			}
			if (ctx.eventObject && ctx.eventObject.zone === 'battlefield') {
				return matchesP22bObjectFilter(
					ctx.eventObject,
					{ enchantedOrEquipped: true },
					{ state, controllerId, source: srcObj }
				);
			}
			return false;
		}
		case 'eventCrewCountEquals': {
			if (ctx.eventCrewCount !== undefined) return ctx.eventCrewCount === cond.count;
			const crewIds = ctx.triggerEventStackItem?.crewedByIds ?? ctx.eventObject?.crewedThisTurnByIds;
			return crewIds ? crewIds.length === cond.count : false;
		}
		case 'eventDamageDealtBySubtype': {
			const subLower = cond.subtype.toLowerCase();
			if (ctx.eventDamageSourceSubtypes) {
				return ctx.eventDamageSourceSubtypes.some((s) => s.toLowerCase() === subLower);
			}
			if (ctx.eventObject) {
				const ev =
					ctx.eventObject.zone === 'battlefield'
						? evaluatePermanent(state, ctx.eventObject)
						: undefined;
				if (ev) {
					return ev.hasAllCreatureTypes || ev.hasSubType(cond.subtype);
				}
				const subs = resolveObjectFaces(
					effectiveCardForObject(ctx.eventObject),
					instanceFaceOptions(ctx.eventObject, ctx.eventObject.zone)
				).subtypes;
				return subs.some((s) => s.toLowerCase() === subLower);
			}
			return false;
		}
		case 'eventDamagedTargetDealtExcessDamageThisTurn': {
			const target = ctx.eventObject;
			return Boolean(target && (target.dealtExcessDamageThisTurn ?? 0) > 0);
		}
		case 'eventAttackingPlayerWithMostLife': {
			const living = state.players.filter((p) => !p.lost);
			if (living.length === 0) return false;
			const maxLife = Math.max(...living.map((p) => p.life));
			const defPid = ctx.eventAttackedTargetPlayerId ?? ctx.eventPlayerId;
			if (!defPid) return false;
			const defPl = living.find((p) => p.playerId === defPid);
			return Boolean(defPl && defPl.life === maxLife);
		}
		case 'eventAttackerHasAnotherUnattackedOpponent': {
			const activeId = state.players[state.activePlayerIndex]?.playerId ?? controllerId;
			const attackedOpponents = new Set<string>();
			for (const a of state.combat.attackers) {
				if (a.defenderPlayerId && a.defenderPlayerId !== activeId) {
					attackedOpponents.add(a.defenderPlayerId);
				}
			}
			const allOpponents = state.players.filter((p) => !p.lost && p.playerId !== activeId);
			return allOpponents.some((op) => !attackedOpponents.has(op.playerId));
		}
		case 'eventMinAttackersToYouOrPlaneswalkers': {
			const count = state.combat.attackers.filter((a) => {
				if (!a.defenderPlaneswalkerId && a.defenderPlayerId === controllerId) return true;
				if (a.defenderPlaneswalkerId) {
					const pw = findBattlefieldPerm(state, a.defenderPlaneswalkerId);
					return Boolean(pw && pw.controllerId === controllerId);
				}
				return false;
			}).length;
			return count >= cond.min;
		}
		case 'eventSharesCardTypeWithLinkedExile': {
			if (!srcObj || !ctx.eventObject) return false;
			const evTypes = effectiveCardFacesTypes(ctx.eventObject, ctx.eventLki?.card);
			const expectedSrcVer = ctx.stackItem?.sourceObjectVersion ?? srcObj.objectVersion ?? 1;
			for (const p of state.players) {
				for (const ex of p.exile) {
					if (
						ex.exiledBy?.sourceInstanceId === srcObj.instanceId &&
						(ex.exiledBy.sourceObjectVersion ?? 1) === expectedSrcVer
					) {
						const exTypes = effectiveCardFacesTypes(ex);
						if (evTypes.some((t) => exTypes.includes(t))) return true;
					}
				}
			}
			return false;
		}
		case 'eventPlayerControlsMoreThanYou': {
			const evPid = ctx.eventPlayerId;
			if (!evPid) return false;
			const fCtx: FilterContext = { state, controllerId, source: srcObj };
			const countFor = (pid: string) => {
				const pl = state.players.find((p) => p.playerId === pid);
				if (!pl) return 0;
				return pl.battlefield.filter((b) => !b.phasedOut && matchObjFilter(b, cond.filter, fCtx)).length;
			};
			return countFor(evPid) > countFor(controllerId);
		}
		case 'eventPlayerControlsMoreThanEachOther': {
			const evPid = ctx.eventPlayerId;
			if (!evPid) return false;
			const fCtx: FilterContext = { state, controllerId, source: srcObj };
			const countFor = (pid: string) => {
				const pl = state.players.find((p) => p.playerId === pid);
				if (!pl) return 0;
				return pl.battlefield.filter((b) => !b.phasedOut && matchObjFilter(b, cond.filter, fCtx)).length;
			};
			const actorCount = countFor(evPid);
			for (const p of state.players) {
				if (p.lost || p.playerId === evPid) continue;
				if (countFor(p.playerId) >= actorCount) return false;
			}
			return true;
		}
		case 'youHaveMostLife': {
			const living = state.players.filter((p) => !p.lost);
			if (living.length === 0) return false;
			const maxLife = Math.max(...living.map((p) => p.life));
			return controller.life === maxLife;
		}
		case 'playerLostLifeLastTurn': {
			const targetPid = ctx.eventPlayerId ?? state.players[state.activePlayerIndex]?.playerId;
			const pl = state.players.find((p) => p.playerId === targetPid);
			return Boolean(pl && (pl.lifeLostLastTurn ?? 0) > 0);
		}
		case 'discardedCardThisTurn': {
			if (cond.who === 'you') return Boolean(controller.discardedCardThisTurn);
			if (cond.who === 'opponent') {
				return state.players.some(
					(p) => !p.lost && p.playerId !== controllerId && p.discardedCardThisTurn
				);
			}
			return state.players.some((p) => !p.lost && p.discardedCardThisTurn);
		}
		case 'putCounterOnCreatureThisTurn': {
			if (cond.who === 'you') return Boolean(controller.putCounterOnCreatureThisTurn);
			return state.players.some((p) => !p.lost && p.putCounterOnCreatureThisTurn);
		}
		case 'sacrificedFilterThisTurn': {
			const fCtx: FilterContext = { state, controllerId, source: srcObj };
			const players =
				cond.who === 'you' ? [controller] : state.players.filter((p) => !p.lost);
			let count = 0;
			for (const pl of players) {
				for (const sc of pl.sacrificedCardsThisTurn ?? []) {
					const syn = syntheticInstance(sc, pl.playerId, 'graveyard');
					if (matchObjFilter(syn, cond.filter, fCtx)) count += 1;
				}
			}
			return count >= cond.min;
		}
		case 'noCreaturesAttackedThisTurn':
			return (state.creaturesAttackedCountThisTurn ?? 0) === 0;
		case 'castCreatureAndNoncreatureThisTurn':
			return Boolean(controller.castCreatureSpellThisTurn && controller.castNoncreatureSpellThisTurn);
		case 'enchantedCreaturePowerAtLeast': {
			const hostId = srcObj?.attachedToId;
			if (!hostId) return false;
			const host = findBattlefieldPerm(state, hostId);
			if (!host) return false;
			const ev = evaluatePermanent(state, host.obj);
			return ev.power >= cond.min;
		}
		case 'allLandsAreSubtype': {
			let anyLand = false;
			for (const p of state.players) {
				for (const b of p.battlefield) {
					if (b.phasedOut) continue;
					const ev = evaluatePermanent(state, b);
					if (!ev.isLand) continue;
					anyLand = true;
					if (!ev.hasSubType(cond.subtype)) return false;
				}
			}
			return anyLand;
		}
		case 'youControlGreatestManaValueFilter': {
			const fCtx: FilterContext = { state, controllerId, source: srcObj };
			let yourMax = -1;
			let globalMax = -1;
			for (const p of state.players) {
				if (p.lost) continue;
				for (const b of p.battlefield) {
					if (b.phasedOut || !matchObjFilter(b, cond.filter, fCtx)) continue;
					const mv = objectManaValue(state, b);
					if (mv > globalMax) globalMax = mv;
					if (p.playerId === controllerId && mv > yourMax) yourMax = mv;
				}
			}
			return yourMax >= 0 && yourMax === globalMax;
		}
		case 'yourTeamGainedLifeThisTurn': {
			const teamIds = activePlayerTeamIds(state, controllerId);
			return state.players.some(
				(p) => !p.lost && teamIds.includes(p.playerId) && (p.lifeGainedThisTurn ?? 0) > 0
			);
		}
		case 'yourTeamControlsOtherFilter': {
			const teamIds = activePlayerTeamIds(state, controllerId);
			const fCtx: FilterContext = { state, controllerId, source: srcObj };
			return state.players.some(
				(p) =>
					!p.lost &&
					teamIds.includes(p.playerId) &&
					p.battlefield.some(
						(b) =>
							!b.phasedOut &&
							b.instanceId !== sourceInstanceId &&
							matchObjFilter(b, cond.filter, fCtx)
					)
			);
		}
		case 'playersLostGameAtLeast': {
			const lostCount = state.players.filter((p) => p.lost).length;
			return lostCount >= cond.min;
		}
		case 'selfAttackedThisCombat': {
			if (!srcObj || srcObj.zone !== 'battlefield') return false;
			return Boolean(
				state.combat.active &&
					state.combat.attackers.some((a) => a.attackerInstanceId === srcObj.instanceId)
			);
		}
		case 'selfDidntAttackThisTurn': {
			if (!srcObj || srcObj.zone !== 'battlefield') return false;
			return !srcObj.creatureAttackedThisTurn;
		}
		case 'selfHaventAddedManaThisTurn': {
			return !srcObj?.addedManaThisTurn;
		}
		case 'zoneChangeFromToThisTurn': {
			const fCtx: FilterContext = { state, controllerId, source: srcObj };
			if ((cond.from === 'battlefield' || cond.from === 'any') && cond.to === 'graveyard') {
				const cards = state.battlefieldToGraveyardThisTurnCards ?? [];
				let count = 0;
				for (const sc of cards) {
					const syn = syntheticInstance(sc, controllerId, 'graveyard');
					if (matchObjFilter(syn, cond.filter, fCtx)) count += 1;
				}
				return count >= cond.min;
			}
			return false;
		}
		case 'enteredUnderYourControlThisTurnCount': {
			const fCtx: FilterContext = { state, controllerId, source: srcObj };
			const records = controller.enteredBattlefieldThisTurnCards ?? [];
			let count = 0;
			for (const rec of records) {
				if (cond.filter.other && rec.instanceId === sourceInstanceId) continue;
				const live = controller.battlefield.find((b) => b.instanceId === rec.instanceId);
				if (live) {
					if (matchObjFilter(live, cond.filter, fCtx)) count += 1;
				} else {
					const syn = syntheticInstance(rec.card, controllerId, 'graveyard', rec.instanceId);
					if (matchObjFilter(syn, cond.filter, fCtx)) count += 1;
				}
			}
			return count >= cond.min;
		}
		case 'yourLifeLessThanStarting': {
			const starting = state.rules?.startingLife ?? 20;
			return controller.life < starting;
		}
		default:
			return undefined;
	}
}

// ---- Trigger Filter & New Event Matching -----------------------------------------------------

export function matchesP22bCastFilter(
	state: GameState,
	filter: EventFilter,
	spell: CardInstance,
	casterId: string,
	isCopy: boolean,
	sourceObj: CardInstance,
	stackSpell?: StackItem
): boolean {
	if (filter.targetsOnlySelf) {
		if (sourceObj.zone !== 'battlefield') return false;
		const targets = stackSpell?.targets ?? [];
		if (
			targets.length !== 1 ||
			targets[0].kind !== 'permanent' ||
			targets[0].id !== sourceObj.instanceId
		) {
			return false;
		}
	}
	if (filter.spellHasKeyword) {
		const kwLower = filter.spellHasKeyword.toLowerCase();
		const faceOpts = stackSpell
			? {
					zone: 'stack' as const,
					faceIndex: stackSpell.faceIndex ?? 0,
					fused: stackSpell.fused,
					...(stackSpell.spellMods?.prototyped || stackSpell.copiableState?.prototyped
						? { prototyped: true }
						: {})
				}
			: instanceFaceOptions(spell, 'stack');
		const abs = activeAbilityDefs(spell.card, faceOpts);
		const hasPrintedKw = abs.some(
			(ab) => ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === kwLower
		);
		const hasGrantedKw = Boolean(
			stackSpell?.grantedSpellKeywords?.some((k) => k.toLowerCase() === kwLower)
		);
		if (!hasPrintedKw && !hasGrantedKw) return false;
	}
	if (filter.enchantedPlayerCasts) {
		if (!sourceObj.attachedToId || casterId !== sourceObj.attachedToId) return false;
	}
	if (filter.object && typeof filter.object === 'object' && filter.object.ofChosenName) {
		const chosen = sourceObj.chosenCardName;
		if (!chosen) return false;
		const spellName = stackSpell
			? resolveObjectFaces(stackSpell.card, {
					zone: 'stack',
					faceIndex: stackSpell.faceIndex ?? 0,
					fused: stackSpell.fused
				}).name
			: spell.card.name;
		if (spellName !== chosen) return false;
	}
	if (isCopy && filter.orCopy === undefined) {
		return false;
	}
	return true;
}

export function matchesP22bAttackedTargetWithMostLife(
	state: GameState,
	defenderPlayerId: string | undefined,
	hasPermTarget: boolean
): boolean {
	if (hasPermTarget || !defenderPlayerId) return false;
	const living = state.players.filter((p) => !p.lost);
	if (living.length === 0) return false;
	const maxLife = Math.max(...living.map((p) => p.life));
	return living.some((p) => p.playerId === defenderPlayerId && p.life === maxLife);
}

export function matchesP22bPhaseFilter(
	state: GameState,
	filter: EventFilter,
	sourceObj: CardInstance,
	activePlayerId: string,
	evPhase: string
): boolean {
	if (filter.anyMainPhase) {
		if (evPhase !== 'main1' && evPhase !== 'main2') return false;
	} else if (filter.phase !== undefined && filter.phase !== evPhase) {
		return false;
	}
	if (filter.phaseChosenPlayer) {
		if (!sourceObj.chosenPlayerId || sourceObj.chosenPlayerId !== activePlayerId) return false;
	}
	return true;
}

export interface P22bTriggerDispatcher {
	sources: (state: GameState, kind: EventFilter['object'] extends never ? never : any) => any[];
	abilitiesFor: (state: GameState, source: any, kind: any) => any[];
	objectMatches: (filter: EventFilter, subject: any, source: any) => boolean;
	filterMatches: (filter: ObjectFilter, subject: any, viewer: any) => boolean;
	battlefieldSubject: (state: GameState, obj: CardInstance, controllerId: string) => any;
	printedSubject: (...args: any[]) => any;
	viewerOf: (source: any) => any;
	record: (state: GameState, source: any, ability: any, kind: any, extras: any) => void;
}

export function dispatchP22bTriggerEvent(
	state: GameState,
	ev: GameEvent,
	d: P22bTriggerDispatcher
): boolean {
	switch (ev.kind) {
		case 'AbilityActivated': {
			const perm = findBattlefieldPerm(state, ev.sourceId);
			const subj = perm
				? d.battlefieldSubject(state, perm.obj, perm.controllerId)
				: d.printedSubject(ev.source, ev.source.card, ev.playerId, false, undefined, undefined, undefined, false, false, { state });
			for (const source of d.sources(state, 'abilityActivated')) {
				for (const { ability, alts } of d.abilitiesFor(state, source, 'abilityActivated')) {
					const alt = alts.find((a: { filter: EventFilter }) => {
						const f = a.filter;
						const rel = f.player?.relation ?? 'any';
						if (rel === 'you' && ev.playerId !== source.controllerId) return false;
						if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
						if (f.isLoyaltyAbility && !ev.isLoyaltyAbility) return false;
						if (f.isNonManaAbility && ev.isManaAbility) return false;
						if (f.abilitySourceFilter) {
							if (f.abilitySourceFilter === 'self') {
								if (ev.sourceId !== source.instanceId) return false;
							} else if (f.abilitySourceFilter === 'attachedTo') {
								if (ev.sourceId !== source.attachedToId) return false;
							} else if (!d.filterMatches(f.abilitySourceFilter, subj, d.viewerOf(source))) {
								return false;
							}
						}
						if (f.abilitySourceControlledByEventPlayer) {
							const srcCtrl = perm ? perm.controllerId : ev.source.controllerId;
							if (srcCtrl !== ev.playerId) return false;
						}
						if (f.object && !d.objectMatches(f, subj, source)) return false;
						return true;
					});
					if (alt) {
						const evStk = ev.stackItemId
							? state.stack.find((s) => s.id === ev.stackItemId)
							: undefined;
						d.record(state, source, ability, 'abilityActivated', {
							label: 'Ability Trigger',
							eventObject: ev.source,
							eventPlayer: ev.playerId,
							eventPlayerId: ev.playerId,
							...(evStk ? { triggerEventStackItem: evStk } : {}),
							p22bEventIsManaAbility: ev.isManaAbility,
							p22bEventLifePaid: ev.lifePaid ?? 0
						});
					}
				}
			}
			return true;
		}
		case 'PlayersFinishedVoting': {
			for (const source of d.sources(state, 'playersFinishedVoting')) {
				for (const { ability } of d.abilitiesFor(state, source, 'playersFinishedVoting')) {
					d.record(state, source, ability, 'playersFinishedVoting', {
						label: 'Vote Trigger',
						eventPlayer: ev.controllerId
					});
				}
			}
			return true;
		}
		case 'Clash': {
			for (const source of d.sources(state, 'clash')) {
				for (const { ability, alts } of d.abilitiesFor(state, source, 'clash')) {
					const alt = alts.find((a: { filter: EventFilter }) => {
						const rel = a.filter.player?.relation ?? 'any';
						if (rel === 'you' && ev.playerId !== source.controllerId) return false;
						if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
						if (a.filter.won !== undefined && ev.won !== a.filter.won) return false;
						return true;
					});
					if (alt) {
						d.record(state, source, ability, 'clash', {
							label: 'Clash Trigger',
							eventPlayer: ev.playerId
						});
					}
				}
			}
			return true;
		}
		case 'LibraryShuffled': {
			for (const source of d.sources(state, 'libraryShuffled')) {
				for (const { ability, alts } of d.abilitiesFor(state, source, 'libraryShuffled')) {
					const alt = alts.find((a: { filter: EventFilter }) => {
						const rel = a.filter.player?.relation ?? 'any';
						if (rel === 'you' && ev.playerId !== source.controllerId) return false;
						if (rel === 'opponent' && ev.playerId === source.controllerId) return false;
						return true;
					});
					if (alt) {
						d.record(state, source, ability, 'libraryShuffled', {
							label: 'Shuffle Trigger',
							eventPlayer: ev.playerId
						});
					}
				}
			}
			return true;
		}
		case 'SpellCountered': {
			const counteredView = resolveObjectFaces(ev.counteredCard, {
				zone: 'stack',
				faceIndex: ev.faceIndex ?? 0,
				fused: ev.fused,
				isFaceDown: ev.isFaceDown,
				faceDownSpec: ev.faceDownSpec
			});
			const counteredInst = syntheticInstance(ev.counteredCard, ev.byControllerId, 'stack');
			if (ev.faceIndex !== undefined) counteredInst.activeFaceIndex = ev.faceIndex;
			if (ev.isFaceDown) counteredInst.isFaceDown = true;
			if (ev.faceDownSpec) counteredInst.faceDownSpec = ev.faceDownSpec;
			const subj = d.printedSubject(
				counteredInst,
				ev.counteredCard,
				ev.byControllerId,
				false,
				ev.typeLine ?? counteredView.typeLine,
				false,
				ev.colors ?? counteredView.colors,
				false,
				false,
				{
					state,
					power: counteredView.power,
					toughness: counteredView.toughness,
					manaValue: counteredView.manaValue
				}
			);
			for (const source of d.sources(state, 'spellCountered')) {
				for (const { ability, alts } of d.abilitiesFor(state, source, 'spellCountered')) {
					const alt = alts.find((a: { filter: EventFilter }) => {
						const rel = a.filter.player?.relation ?? 'any';
						if (rel === 'you' && ev.byControllerId !== source.controllerId) return false;
						if (rel === 'opponent' && ev.byControllerId === source.controllerId) return false;
						return !a.filter.object || d.objectMatches(a.filter, subj, source);
					});
					if (alt) {
						d.record(state, source, ability, 'spellCountered', {
							label: 'Counter Trigger',
							eventPlayer: ev.byControllerId
						});
					}
				}
			}
			return true;
		}
		case 'SagaChapterResolved': {
			const subj = d.battlefieldSubject(state, ev.object, ev.controllerId);
			for (const source of d.sources(state, 'sagaChapterResolved')) {
				for (const { ability, alts } of d.abilitiesFor(state, source, 'sagaChapterResolved')) {
					const alt = alts.find((a: { filter: EventFilter }) => {
						if (a.filter.finalChapter && !ev.isFinalChapter) return false;
						return d.objectMatches(a.filter, subj, source);
					});
					if (alt) {
						d.record(state, source, ability, 'sagaChapterResolved', {
							label: 'Final Chapter Trigger',
							eventObject: ev.object,
							eventPlayer: ev.controllerId
						});
					}
				}
			}
			return true;
		}
		case 'SaddledMount': {
			const creatureSubj = d.battlefieldSubject(state, ev.creature, ev.playerId);
			const activePlayerId = state.players[state.activePlayerIndex]?.playerId;
			for (const source of d.sources(state, 'saddledMount')) {
				for (const { ability, alts } of d.abilitiesFor(state, source, 'saddledMount')) {
					const alt = alts.find((a: { filter: EventFilter }) => {
						if (a.filter.duringPhase === 'main' && state.phase !== 'main1' && state.phase !== 'main2') {
							return false;
						}
						if (a.filter.duringTurn === 'your' && activePlayerId !== source.controllerId) {
							return false;
						}
						return d.objectMatches(a.filter, creatureSubj, source);
					});
					if (alt) {
						d.record(state, source, ability, 'saddledMount', {
							label: 'Saddle Trigger',
							eventObject: ev.mount,
							eventPlayer: ev.playerId
						});
					}
				}
			}
			return true;
		}
		default:
			return false;
	}
}

// ---- Costs & Cost Modifiers ------------------------------------------------------------------

export function coloredManaSymbolCountInCard(card: ScryfallCard, color: ManaColor): number {
	const manaCostStrings: string[] = [];
	if (card.manaCost) manaCostStrings.push(card.manaCost);
	if (card.faces) {
		for (const f of card.faces) {
			if (f.manaCost) manaCostStrings.push(f.manaCost);
		}
	}
	if (manaCostStrings.length === 0) return 0;
	let count = 0;
	const target = color.toUpperCase();
	const tokenRegex = /\{([^}]+)\}/g;
	for (const mc of manaCostStrings) {
		tokenRegex.lastIndex = 0;
		for (let guard = 0; guard < 64; guard++) {
			const m = tokenRegex.exec(mc);
			if (!m) break;
			const parts = m[1].toUpperCase().split('/');
			if (parts.includes(target)) count += 1;
		}
	}
	return count;
}

export function matchesP22bCostModifierWho(
	mod: Extract<StaticDef, { k: 'costModifier' }>,
	sourceInst: CardInstance,
	castingPlayerId: string
): boolean {
	if (mod.whoEnchantedPlayer) {
		return Boolean(sourceInst.attachedToId && sourceInst.attachedToId === castingPlayerId);
	}
	return true;
}

export function describeP22bCost(d: CostDef): string | null {
	switch (d.k) {
		case 'exileFrom':
			if (d.collectEvidence && d.minTotalManaValueAmount) {
				return 'Collect evidence X (total mana value of targeted permanents)';
			}
			if (d.minColoredManaSymbols) {
				return `Exile cards from your graveyard with ${d.minColoredManaSymbols.min} or more {${d.minColoredManaSymbols.color}} mana symbols`;
			}
			return null;
		case 'removeCounters':
			if (d.orSuspendedYouOwn) {
				const cLabel = d.counter && d.counter !== 'any' ? `${d.counter} ` : '';
				return `Remove ${cLabel}counter from a permanent you control or suspended card you own`;
			}
			return null;
		case 'chooseCreatureType':
			return 'Choose a creature type';
		case 'beholdOrChoose': {
			const sub = d.filter.subtypes?.[0] ?? d.filter.types?.[0]?.toLowerCase() ?? 'card';
			return `Choose a ${sub} you control or reveal a ${sub} from your hand`;
		}
		case 'chooseNumberBetween':
			return `Choose a number between ${d.min} and ${d.max}`;
		case 'revealChosenPlayer':
			return 'Reveal the player you chose';
		case 'revealChosenSubType':
			return 'Reveal the creature type you chose';
		case 'discardLastDrawnThisTurn':
			return 'Discard the last card you drew this turn';
		case 'chooseFromKeywordList':
			return `Choose ${d.keywords.join(' or ')}`;
		case 'payAttachedManaCost':
			return "Pay attached creature's mana cost";
		case 'exileFromGraveyardAndPayManaCost':
			return 'Exile a card from your graveyard and pay its mana cost';
		case 'exileFaceDownPermanentFaceUp':
			return 'Exile a face-down permanent you control face up';
		case 'payManaPerCounter':
			return `Pay ${d.perMana} for each ${d.counter} counter on this`;
		case 'repeatableOptionalMana':
			return `Pay ${d.cost} any number of times`;
		case 'revealSelfFromHand':
			return 'Reveal this card from your hand';
		default:
			return null;
	}
}

export function checkSimpleP22bCost(
	def: CostDef,
	ctx: CostContext,
	_matchesFilter: MatchesFilterFn
): { handled: boolean; error: string | null } {
	const src = ctx.source;
	switch (def.k) {
		case 'chooseCreatureType':
		case 'repeatableOptionalMana':
			return { handled: true, error: null };
		case 'chooseNumberBetween':
			return {
				handled: true,
				error: def.min <= def.max ? null : 'Invalid number choice bounds.'
			};
		case 'chooseFromKeywordList':
			return {
				handled: true,
				error: def.keywords.length > 0 ? null : 'No keywords available to choose.'
			};
		case 'revealChosenPlayer':
			return {
				handled: true,
				error: src.secretChosenPlayerId ? null : 'No secret player choice recorded.'
			};
		case 'revealChosenSubType':
			return {
				handled: true,
				error: src.secretChosenSubType ? null : 'No secret creature type choice recorded.'
			};
		case 'discardLastDrawnThisTurn': {
			const drawnId = ctx.player.lastDrawnCardIdThisTurn;
			const inHand = drawnId
				? ctx.player.hand.find(
						(c) => c.instanceId === drawnId && !(ctx.isSpell && c.instanceId === src.instanceId)
					)
				: undefined;
			return {
				handled: true,
				error: inHand ? null : 'You must still hold the last card you drew this turn in hand.'
			};
		}
		case 'payAttachedManaCost': {
			const host = src.attachedToId ? findBattlefieldPerm(ctx.state, src.attachedToId) : undefined;
			if (!host) return { handled: true, error: 'Source is not attached to a permanent.' };
			const mc = effectiveCardForObject(host.obj).manaCost ?? '';
			if (!mc) return { handled: true, error: 'Attached permanent has no mana cost.' };
			const req = parseManaCost(mc);
			return {
				handled: true,
				error: ctx.canPayMana(req)
					? null
					: `Cannot pay attached permanent's mana cost (${mc}).`
			};
		}
		case 'revealSelfFromHand':
			return {
				handled: true,
				error:
					src.zone === 'hand' && ctx.player.hand.some((c) => c.instanceId === src.instanceId)
						? null
						: 'Card must be in your hand to reveal it.'
			};
		case 'removeCounters': {
			if (!def.orSuspendedYouOwn) return { handled: false, error: null };
			const needed = def.count.k === 'const' ? def.count.n : 1;
			const fCtx: FilterContext = {
				state: ctx.state,
				controllerId: ctx.player.playerId,
				source: ctx.source,
				xValue: ctx.xValue
			};
			const hasMatchingPerm = ctx.player.battlefield.some(
				(b) =>
					!b.phasedOut &&
					totalCountersOnObj(b, def.counter) >= needed &&
					(def.from === 'self'
						? b.instanceId === ctx.source.instanceId
						: _matchesFilter(b, def.from, { ...fCtx, zone: 'battlefield' }))
			);
			const hasMatchingSusp = ctx.player.exile.some(
				(ex) => ex.isSuspended && totalCountersOnObj(ex, def.counter) >= needed
			);
			return {
				handled: true,
				error:
					hasMatchingPerm || hasMatchingSusp
						? null
						: `No matching permanent or suspended card has ${needed} ${def.counter} counter(s).`
			};
		}
		default:
			return { handled: false, error: null };
	}
}

export function p22bObjectCandidates(
	def: CostDef,
	ctx: CostContext,
	free: (c: CardInstance) => boolean,
	matchesFilter: MatchesFilterFn
): CardInstance[] | null {
	const fCtx: FilterContext = {
		state: ctx.state,
		controllerId: ctx.player.playerId,
		source: ctx.source,
		xValue: ctx.xValue
	};
	switch (def.k) {
		case 'beholdOrChoose': {
			const out: CardInstance[] = [];
			for (const b of ctx.player.battlefield) {
				if (!b.phasedOut && free(b) && matchesFilter(b, def.filter, { ...fCtx, zone: 'battlefield' })) {
					out.push(b);
				}
			}
			for (const h of ctx.player.hand) {
				if (ctx.isSpell && h.instanceId === ctx.source.instanceId) continue;
				if (free(h) && matchesFilter(h, def.filter, { ...fCtx, zone: 'hand' })) {
					out.push(h);
				}
			}
			return out;
		}
		case 'exileFromGraveyardAndPayManaCost': {
			return ctx.player.graveyard.filter((g) => {
				if (!free(g)) return false;
				if (def.filter && !matchesFilter(g, def.filter, { ...fCtx, zone: 'graveyard' })) {
					return false;
				}
				const mc = effectiveCardForObject(g).manaCost ?? '';
				if (!mc) return false;
				return ctx.canPayMana(parseManaCost(mc));
			});
		}
		case 'exileFaceDownPermanentFaceUp':
			return ctx.player.battlefield.filter((b) => !b.phasedOut && b.isFaceDown && free(b));
		case 'removeCounters':
			if (!def.orSuspendedYouOwn) return null;
			return [
				...ctx.player.battlefield.filter(
					(b) =>
						!b.phasedOut &&
						free(b) &&
						totalCountersOnObj(b, def.counter) > 0 &&
						(def.from === 'self'
							? b.instanceId === ctx.source.instanceId
							: matchesFilter(b, def.from, { ...fCtx, zone: 'battlefield' }))
				),
				...ctx.player.exile.filter(
					(ex) => ex.isSuspended && free(ex) && totalCountersOnObj(ex, def.counter) > 0
				)
			];
		default:
			return null;
	}
}

export function planP22bSpecialCostPart(
	def: CostDef,
	candidates: CardInstance[] | null,
	ctx: CostContext,
	used: Set<string>,
	objects: string[][],
	objectIndex: number,
	payment: {
		chosenSubTypeCost?: string;
		chosenNumberCost?: number;
		chosenKeywordCost?: string;
		repeatableManaPaidCount?: number;
	},
	describeSingle: (d: CostDef) => string
):
	| { handled: false }
	| {
			handled: true;
			result:
				| { ok: true; nextObjectIndex: number; chosen: CardInstance[]; extra?: Record<string, unknown> }
				| { ok: true; question: CostQuestion }
				| { ok: false; error: string };
	  } {
	switch (def.k) {
		case 'chooseCreatureType': {
			const sub = payment.chosenSubTypeCost ?? 'Human';
			return {
				handled: true,
				result: { ok: true, nextObjectIndex: objectIndex, chosen: [], extra: { chosenSubTypeCost: sub } }
			};
		}
		case 'chooseNumberBetween': {
			const num = payment.chosenNumberCost ?? def.max;
			if (num < def.min || num > def.max) {
				return {
					handled: true,
					result: { ok: false, error: `Number must be between ${def.min} and ${def.max}.` }
				};
			}
			return {
				handled: true,
				result: { ok: true, nextObjectIndex: objectIndex, chosen: [], extra: { chosenNumberCost: num } }
			};
		}
		case 'chooseFromKeywordList': {
			const kw = payment.chosenKeywordCost ?? def.keywords[0];
			if (!kw || !def.keywords.some((k) => k.toLowerCase() === kw.toLowerCase())) {
				return {
					handled: true,
					result: { ok: false, error: `Choose one of: ${def.keywords.join(', ')}.` }
				};
			}
			return {
				handled: true,
				result: { ok: true, nextObjectIndex: objectIndex, chosen: [], extra: { chosenKeywordCost: kw } }
			};
		}
		case 'repeatableOptionalMana': {
			const count = Math.max(0, Math.floor(payment.repeatableManaPaidCount ?? 0));
			if (count > 0) {
				const baseReq = parseManaCost(def.cost);
				const scaledReq = {
					...baseReq,
					generic: baseReq.generic * count,
					totalCmc: baseReq.totalCmc * count,
					colored: Object.fromEntries(
						Object.entries(baseReq.colored).map(([k, v]) => [k, v * count])
					) as Record<ManaColor, number>
				};
				if (!ctx.canPayMana(scaledReq)) {
					return {
						handled: true,
						result: { ok: false, error: `Cannot pay ${def.cost} ${count} time(s).` }
					};
				}
			}
			return {
				handled: true,
				result: {
					ok: true,
					nextObjectIndex: objectIndex,
					chosen: [],
					extra: { repeatableManaPaidCount: count }
				}
			};
		}
		case 'beholdOrChoose':
		case 'exileFromGraveyardAndPayManaCost':
		case 'exileFaceDownPermanentFaceUp': {
			const cands = candidates ?? [];
			if (cands.length === 0) {
				return { handled: true, result: { ok: false, error: `No eligible objects for: ${describeSingle(def)}.` } };
			}
			const chosenIds = objects[objectIndex];
			if (!chosenIds || chosenIds.length === 0) {
				return {
					handled: true,
					result: {
						ok: true,
						question: {
							kind: 'objects',
							index: objectIndex,
							label: describeSingle(def),
							count: 1,
							candidateIds: cands.map((c) => c.instanceId),
							costDef: def
						}
					}
				};
			}
			const found = cands.find((c) => c.instanceId === chosenIds[0] && !used.has(c.instanceId));
			if (!found) {
				return { handled: true, result: { ok: false, error: `Invalid choice for: ${describeSingle(def)}.` } };
			}
			used.add(found.instanceId);
			return {
				handled: true,
				result: { ok: true, nextObjectIndex: objectIndex + 1, chosen: [found] }
			};
		}
		case 'exileFrom': {
			if (!candidates) return { handled: false };
			if (def.minTotalManaValueAmount) {
				const cands = candidates;
				const fCtx: FilterContext = {
					state: ctx.state,
					controllerId: ctx.player.playerId,
					source: ctx.source,
					xValue: ctx.xValue,
					...((ctx as CostContext & { targets?: StackItem['targets'] }).targets
						? {
								stackItem: {
									targets: (ctx as CostContext & { targets?: StackItem['targets'] }).targets
								} as StackItem
							}
						: {})
				};
				const minTotal = Math.max(0, evaluateAmount(def.minTotalManaValueAmount, fCtx));
				const totalAvail = cands.reduce((s, c) => s + objectManaValue(ctx.state, c), 0);
				if (totalAvail < minTotal) {
					return {
						handled: true,
						result: {
							ok: false,
							error: `Total mana value in graveyard (${totalAvail}) is less than required (${minTotal}).`
						}
					};
				}
				if (minTotal === 0) {
					return {
						handled: true,
						result: { ok: true, nextObjectIndex: objectIndex, chosen: [] }
					};
				}
				const chosenIds = objects[objectIndex];
				if (!chosenIds || chosenIds.length === 0) {
					return {
						handled: true,
						result: {
							ok: true,
							question: {
								kind: 'objects',
								index: objectIndex,
								label: describeSingle(def),
								count: 1,
								maxCount: cands.length,
								minTotal,
								metric: 'manaValue',
								candidateIds: cands.map((c) => c.instanceId),
								costDef: def
							}
						}
					};
				}
				const chosen: CardInstance[] = [];
				let mvSum = 0;
				for (const id of chosenIds) {
					const found = cands.find((c) => c.instanceId === id && !used.has(id));
					if (!found) return { handled: true, result: { ok: false, error: 'Invalid exile selection.' } };
					used.add(id);
					chosen.push(found);
					mvSum += objectManaValue(ctx.state, found);
				}
				if (mvSum < minTotal) {
					return {
						handled: true,
						result: {
							ok: false,
							error: `Selected cards have total mana value ${mvSum}; need at least ${minTotal}.`
						}
					};
				}
				return {
					handled: true,
					result: { ok: true, nextObjectIndex: objectIndex + 1, chosen }
				};
			}
			if (!def.minColoredManaSymbols) return { handled: false };
			const cands = candidates;
			const { color, min } = def.minColoredManaSymbols;
			const totalAvailable = cands.reduce(
				(s, c) => s + coloredManaSymbolCountInCard(effectiveCardForObject(c), color),
				0
			);
			if (totalAvailable < min) {
				return {
					handled: true,
					result: {
						ok: false,
						error: `Need cards with at least ${min} {${color}} mana symbols to exile.`
					}
				};
			}
			const chosenIds = objects[objectIndex];
			if (!chosenIds || chosenIds.length === 0) {
				return {
					handled: true,
					result: {
						ok: true,
						question: {
							kind: 'objects',
							index: objectIndex,
							label: describeSingle(def),
							count: 1,
							maxCount: cands.length,
							candidateIds: cands.map((c) => c.instanceId),
							costDef: def
						}
					}
				};
			}
			const chosen: CardInstance[] = [];
			let symSum = 0;
			for (const id of chosenIds) {
				const found = cands.find((c) => c.instanceId === id && !used.has(id));
				if (!found) {
					return { handled: true, result: { ok: false, error: 'Invalid exile selection.' } };
				}
				used.add(id);
				chosen.push(found);
				symSum += coloredManaSymbolCountInCard(effectiveCardForObject(found), color);
			}
			if (symSum < min) {
				return {
					handled: true,
					result: {
						ok: false,
						error: `Selected cards have ${symSum} {${color}} symbols; need at least ${min}.`
					}
				};
			}
			return {
				handled: true,
				result: { ok: true, nextObjectIndex: objectIndex + 1, chosen }
			};
		}
		default:
			return { handled: false };
	}
}

export function executeP22bCostPart(
	ctx: CostContext,
	part: SerializedPlannedCost,
	partIdx: number,
	objStart: number,
	descriptions: string[],
	targetLog: string[],
	findById: (id: string) => CardInstance | undefined,
	paidExtras: Partial<PaidCosts> & {
		chosenSubTypeCost?: string;
		chosenNumberCost?: number;
		chosenKeywordCost?: string;
		beheldOrChosenPower?: number;
		beheldOrChosenCard?: ScryfallCard;
		repeatableManaPaidCount?: number;
		exiledCostCards?: ScryfallCard[];
	}
): { handled: boolean; pausedResult?: PaidCosts } {
	const { player, source } = ctx;
	const def = part.def;
	switch (def.k) {
		case 'chooseCreatureType': {
			const sub = (part as { chosenSubTypeCost?: string }).chosenSubTypeCost ?? 'Human';
			paidExtras.chosenSubTypeCost = sub;
			targetLog.push(`chose creature type ${sub}`);
			return { handled: true };
		}
		case 'chooseNumberBetween': {
			const num = (part as { chosenNumberCost?: number }).chosenNumberCost ?? def.max;
			paidExtras.chosenNumberCost = num;
			targetLog.push(`chose ${num}`);
			return { handled: true };
		}
		case 'chooseFromKeywordList': {
			const kw = (part as { chosenKeywordCost?: string }).chosenKeywordCost ?? def.keywords[0] ?? '';
			paidExtras.chosenKeywordCost = kw;
			targetLog.push(`chose ${kw}`);
			return { handled: true };
		}
		case 'beholdOrChoose': {
			const ids = part.objectIds ?? [];
			const obj = ids[0] ? findById(ids[0]) : undefined;
			if (obj) {
				if (obj.zone === 'hand') markHandCardRevealedToAll(ctx.state, obj);
				const pow =
					obj.zone === 'battlefield'
						? evaluatePermanent(ctx.state, obj).power
						: (resolveObjectFaces(effectiveCardForObject(obj), instanceFaceOptions(obj, obj.zone)).power ??
							0);
				paidExtras.beheldOrChosenPower = pow;
				paidExtras.beheldOrChosenCard = clonePlainCard(effectiveCardForObject(obj));
				targetLog.push(
					obj.zone === 'hand' ? `revealed ${obj.card.name}` : `chose ${obj.card.name}`
				);
			}
			return { handled: true };
		}
		case 'revealChosenPlayer': {
			const pid = source.secretChosenPlayerId;
			if (pid) {
				source.chosenPlayerId = pid;
				delete source.secretChosenPlayerId;
				const plName = ctx.state.players.find((p) => p.playerId === pid)?.username ?? pid;
				targetLog.push(`revealed chosen player (${plName})`);
			}
			return { handled: true };
		}
		case 'revealChosenSubType': {
			const sub = source.secretChosenSubType;
			if (sub) {
				source.chosenSubType = sub;
				delete source.secretChosenSubType;
				targetLog.push(`revealed chosen creature type (${sub})`);
			}
			return { handled: true };
		}
		case 'discardLastDrawnThisTurn': {
			const drawnId = player.lastDrawnCardIdThisTurn;
			const card = drawnId ? player.hand.find((c) => c.instanceId === drawnId) : undefined;
			if (card) {
				if (
					moveObject(ctx.state, card, 'graveyard', {
						from: { player, zone: 'hand' },
						toPlayer: ctx.state.players.find((p) => p.playerId === card.ownerId) ?? player,
						discardReason: 'discard',
						discardPlayerId: player.playerId,
						newTimestamp: true,
						bumpVersion: true
					}) === 'pending'
				) {
					return {
						handled: true,
						pausedResult: { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: 0 }
					};
				}
				targetLog.push(`discarded ${card.card.name}`);
			}
			return { handled: true };
		}
		case 'payAttachedManaCost': {
			const host = source.attachedToId ? findBattlefieldPerm(ctx.state, source.attachedToId) : undefined;
			const mc = host ? (effectiveCardForObject(host.obj).manaCost ?? '') : '';
			if (mc) {
				ctx.payMana(parseManaCost(mc));
				targetLog.push(`paid ${mc}`);
			}
			return { handled: true };
		}
		case 'exileFromGraveyardAndPayManaCost': {
			const ids = part.objectIds ?? [];
			const card = ids[0] ? player.graveyard.find((c) => c.instanceId === ids[0]) : undefined;
			if (card) {
				const mc = effectiveCardForObject(card).manaCost ?? '';
				if (mc) ctx.payMana(parseManaCost(mc));
				const owner = ctx.state.players.find((p) => p.playerId === card.ownerId) ?? player;
				(paidExtras.exiledCostCards ??= []).push(clonePlainCard(effectiveCardForObject(card)));
				if (
					moveObject(ctx.state, card, 'exile', {
						from: { player, zone: 'graveyard' },
						toPlayer: owner,
						newTimestamp: true,
						bumpVersion: true
					}) === 'pending'
				) {
					return {
						handled: true,
						pausedResult: { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: 1 }
					};
				}
				targetLog.push(`exiled ${card.card.name} and paid ${mc || 'its mana cost'}`);
			}
			return { handled: true };
		}
		case 'exileFaceDownPermanentFaceUp': {
			const ids = part.objectIds ?? [];
			const perm = ids[0] ? player.battlefield.find((c) => c.instanceId === ids[0]) : undefined;
			if (perm) {
				perm.isFaceDown = false;
				delete perm.faceDownSpec;
				const owner = ctx.state.players.find((p) => p.playerId === perm.ownerId) ?? player;
				if (
					moveObject(ctx.state, perm, 'exile', {
						from: { player, zone: 'battlefield' },
						toPlayer: owner,
						detachAttachments: true,
						commanderRedirect: true,
						leaveBattlefieldReset: true,
						ceaseToExist: 'tokens',
						newTimestamp: true,
						bumpVersion: true
					}) === 'pending'
				) {
					return {
						handled: true,
						pausedResult: { descriptions, paused: true, nextPartIndex: partIdx, nextObjectIndex: 1 }
					};
				}
				targetLog.push(`exiled ${perm.card.name} face up`);
			}
			return { handled: true };
		}
		case 'payManaPerCounter': {
			// Mana was added to plan.mana during planning and paid in payTapAndManaCostParts.
			return { handled: true };
		}
		case 'repeatableOptionalMana': {
			const count = Math.max(0, Math.floor((part as { repeatableManaPaidCount?: number }).repeatableManaPaidCount ?? 0));
			paidExtras.repeatableManaPaidCount = count;
			if (count > 0) {
				const base = parseManaCost(def.cost);
				ctx.payMana({
					...base,
					generic: base.generic * count,
					totalCmc: base.totalCmc * count,
					colored: Object.fromEntries(
						Object.entries(base.colored).map(([k, v]) => [k, v * count])
					) as Record<ManaColor, number>
				});
				targetLog.push(`paid ${def.cost} ${count} time(s)`);
			}
			return { handled: true };
		}
		case 'revealSelfFromHand': {
			markHandCardRevealedToAll(ctx.state, source);
			targetLog.push(`revealed ${source.card.name} from hand`);
			return { handled: true };
		}
		case 'removeCounters': {
			if (!def.orSuspendedYouOwn) return { handled: false };
			const ids = part.objectIds ?? [];
			const needed = def.count.k === 'const' ? def.count.n : 1;
			let rem = needed;
			for (let j = objStart; j < ids.length && rem > 0; j++) {
				const id = ids[j];
				const perm = player.battlefield.find((b) => b.instanceId === id);
				const ex = !perm ? player.exile.find((e) => e.instanceId === id) : undefined;
				const obj = perm ?? ex;
				if (!obj) continue;
				const cType =
					def.counter && def.counter !== 'any'
						? def.counter
						: ((Object.keys(obj.counters).find((k) => (obj.counters[k as CounterType] ?? 0) > 0) ??
								'time') as CounterType);
				const avail = obj.counters[cType] ?? 0;
				const take = Math.min(avail, rem);
				if (take > 0) {
					obj.counters[cType] = avail - take;
					if (obj.counters[cType] === 0) delete obj.counters[cType];
					rem -= take;
					noteLayerInputsChanged(ctx.state);
					if (perm) {
						emitEvent(ctx.state, {
							kind: 'CounterRemoved',
							objectId: perm.instanceId,
							object: perm,
							counterType: cType,
							amount: take,
							previousCount: avail,
							newCount: obj.counters[cType] ?? 0
						});
					}
					targetLog.push(`removed ${take} ${cType} counter(s) from ${obj.card.name}`);
				}
			}
			return { handled: true };
		}
		default:
			return { handled: false };
	}
}

export function pickGreedyP22bObjects(
	def: CostDef,
	candidates: CardInstance[],
	count: number,
	ctx: CostContext
): string[] | null {
	if (
		def.k === 'beholdOrChoose' ||
		def.k === 'exileFromGraveyardAndPayManaCost' ||
		def.k === 'exileFaceDownPermanentFaceUp'
	) {
		return candidates.slice(0, Math.max(1, count)).map((c) => c.instanceId);
	}
	if (def.k === 'exileFrom' && def.minColoredManaSymbols) {
		const { color, min } = def.minColoredManaSymbols;
		const sorted = [...candidates].sort(
			(a, b) =>
				coloredManaSymbolCountInCard(effectiveCardForObject(b), color) -
				coloredManaSymbolCountInCard(effectiveCardForObject(a), color)
		);
		const picked: string[] = [];
		let sum = 0;
		for (const c of sorted) {
			picked.push(c.instanceId);
			sum += coloredManaSymbolCountInCard(effectiveCardForObject(c), color);
			if (sum >= min) break;
		}
		return sum >= min ? picked : null;
	}
	if (def.k === 'exileFrom' && def.minTotalManaValueAmount) {
		const fCtx: FilterContext = {
			state: ctx.state,
			controllerId: ctx.player.playerId,
			source: ctx.source,
			xValue: ctx.xValue,
			...((ctx as CostContext & { targets?: StackItem['targets'] }).targets
				? {
						stackItem: {
							targets: (ctx as CostContext & { targets?: StackItem['targets'] }).targets
						} as StackItem
					}
				: {})
		};
		const minTotal = Math.max(0, evaluateAmount(def.minTotalManaValueAmount, fCtx));
		const sorted = [...candidates].sort(
			(a, b) => objectManaValue(ctx.state, b) - objectManaValue(ctx.state, a)
		);
		const picked: string[] = [];
		let sum = 0;
		for (const c of sorted) {
			picked.push(c.instanceId);
			sum += objectManaValue(ctx.state, c);
			if (sum >= minTotal) break;
		}
		return sum >= minTotal ? picked : null;
	}
	return null;
}

export function unusedZoneRef(_z: PlayerZone): void {
	// Type guard helper for imports if needed.
}
