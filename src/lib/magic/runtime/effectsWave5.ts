/**
 * Wave 5 Track P13 runtime module:
 * - Slice P13.1: Relational/disjunctive ObjectFilter fields, Devotion (`CR 700.5`), Unlocked Room
 *   door count (`CR 709.5`), dynamic Amounts, cross-turn `TimedContinuousEffect` durations
 *   (`untilYourNextTurn` & `untilEndOfYourNextTurn`, `CR 611.2b`, `CR 800.4m`).
 * - Slice P13.2: Emblems (`CR 114`), Predefined Role Aura tokens (`CR 111.10k–r`) + SBA `CR 704.5z`,
 *   Double/Triple (`CR 701.10–11`), Exchange (`CR 701.12`), Turn Face Up/Down (`CR 708`),
 *   Choose Designation, Temporary Graveyard Cast Grant.
 * - Slice P13.3: Dungeons (`CR 309, 701.49, 704.5t`), The Initiative (`CR 727`),
 *   The Ring Tempts You (`CR 701.54`).
 * - Slice P13.4: Earthbend (`CR 701.66`), Airbend (`CR 701.65`), Learn (`CR 701.48`),
 *   Villainous Choice (`CR 701.55`), Council Vote (`CR 701.38`), and P13 trigger conditions.
 *
 * Strictly adheres to ENGINE_INVARIANTS.md:
 * - Zero rules-text reads at runtime (synthesized ScryfallCard builders live in oracle.ts).
 * - Zero card-name comparisons at runtime (uses structured boolean designations).
 * - Zero direct zone array mutations (all zone moves route through zones.ts).
 * - Zero unbounded loops; 100% plain-JSON state & continuations.
 */

import type {
	Condition,
	DoubleOrTripleSpec,
	DungeonId,
	Duration,
	EffectStep,
	ExchangeSpec,
	GraveyardCastGrantSpec,
	ObjectFilter,
	RoleTokenKind,
	VoteSpec
} from '../ir.ts';
import {
	DUNGEON_SPECS,
	ROLE_TOKEN_SPECS,
	buildTokenScryfallCard,
	withStackItemText
} from '../oracle.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CastOption,
	type ChoiceAnswer,
	type ChoiceRequest,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type TargetRef,
	type TimedContinuousEffect,
	type ZoneType
} from '../types.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import { emitEvent } from './events.ts';
import { instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { objectManaValue, objectPower, objectToughness } from './objectFilter.ts';
import { uid } from './random.ts';
import { placeRegisteredCounters, tokenMultiplier } from './replace.ts';
import {
	buildCardNameChoiceOptions,
	chooseBotBestCardName,
	playerCantGainLife
} from './staticsDynamicAndCosts.ts';
import {
	COLOR_CODE_BY_LABEL,
	buildColorChoiceOptions,
	buildCreatureSubtypeOptions,
	chooseBotBestColor,
	chooseBotBestCreatureSubtype
} from './tuckFreezeChosen.ts';
import {
	allocateTimestamp,
	attachObject,
	moveObject,
	putIntoCommandZone,
	removeFromGame,
	syncBattlefieldControllers
} from './zones.ts';

const FIVE_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

function buildEmblemScryfallCard(
	id: string,
	name: string,
	abilities: readonly string[]
): ScryfallCard {
	return buildTokenScryfallCard(id, {
		name,
		power: 0,
		toughness: 0,
		colors: [],
		typeLine: 'Emblem',
		keywords: [],
		emblemAbilities: abilities
	});
}

function buildRoleTokenScryfallCard(id: string, roleKind: RoleTokenKind): ScryfallCard {
	return buildTokenScryfallCard(id, {
		name: ROLE_TOKEN_SPECS[roleKind].name,
		power: 0,
		toughness: 0,
		colors: [],
		typeLine: 'Token Enchantment — Aura Role',
		keywords: ['Enchant'],
		roleKind
	});
}

function buildRingEmblemScryfallCard(id: string, ringLevel: number): ScryfallCard {
	return buildTokenScryfallCard(id, {
		name: 'The Ring',
		power: 0,
		toughness: 0,
		colors: [],
		typeLine: 'Emblem',
		keywords: [],
		ringLevel
	});
}

function buildDungeonScryfallCard(id: string, dungeonId: DungeonId): ScryfallCard {
	return buildTokenScryfallCard(id, {
		name: DUNGEON_SPECS[dungeonId].name,
		power: 0,
		toughness: 0,
		colors: [],
		typeLine: 'Dungeon',
		keywords: [],
		dungeonId
	});
}

function buildDungeonRoomTriggerCard(
	id: string,
	dungeonId: DungeonId,
	roomIndex: number
): ScryfallCard {
	return buildTokenScryfallCard(id, {
		name: DUNGEON_SPECS[dungeonId].name,
		power: 0,
		toughness: 0,
		colors: [],
		typeLine: 'Dungeon',
		keywords: [],
		dungeonId,
		dungeonRoomIndex: roomIndex
	});
}

// ---- 1. Devotion (CR 700.5), Unlocked Doors (CR 709.5), & Dynamic Amounts -------------------

/**
 * CR 700.5: Counts mana symbols in the mana costs of non-phased-out permanents `playerId` controls
 * that have at least one of `colors`.
 * - Hybrid `{W/U}`, `{2/W}`, `{W/P}`, `{W/U/P}`, `{C/W}` count as 1 if any of their color parts
 *   is in `colors` (CR 700.5: each mana symbol is counted at most once, even for multi-color devotion).
 * - Face-down permanents have no mana cost (CR 708.2a -> 0).
 * - Room permanents contribute only the mana costs of their unlocked halves (CR 709.5).
 */
export function countDevotionInManaCost(
	manaCost: string | undefined,
	colors: ReadonlySet<ManaColor> | readonly ManaColor[]
): number {
	const colorSet = colors instanceof Set ? colors : new Set<ManaColor>(colors);
	if (!manaCost || colorSet.size === 0) return 0;
	let total = 0;
	const symRe = /\{([^}]+)\}/g;
	for (let guard = 0; guard < 64; guard++) {
		const m = symRe.exec(manaCost);
		if (!m) break;
		const parts = m[1].toUpperCase().split('/');
		let matched = false;
		for (const part of parts) {
			if (
				(part === 'W' || part === 'U' || part === 'B' || part === 'R' || part === 'G') &&
				colorSet.has(part)
			) {
				matched = true;
				break;
			}
		}
		if (matched) total += 1;
	}
	return total;
}

export function computeDevotionTo(
	state: GameState,
	playerId: string,
	colors: readonly ManaColor[]
): number {
	if (colors.length === 0) return 0;
	const colorSet = new Set<ManaColor>(colors);
	let total = 0;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.isFaceDown) continue;
			const ev = evaluatePermanent(state, perm);
			if (ev.controllerId !== playerId) continue;
			if (perm.copiableState?.except?.noManaCost) continue;
			const effCard = effectiveCardForObject(perm);
			const bfView = resolveObjectFaces(effCard, instanceFaceOptions(perm, 'battlefield'));
			total += countDevotionInManaCost(bfView.manaCost, colorSet);
		}
	}
	return total;
}

/**
 * CR 709.5: Total number of unlocked doors among Room permanents `playerId` controls.
 */
export function computeUnlockedDoorsCount(state: GameState, playerId: string): number {
	let count = 0;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.isFaceDown) continue;
			const ev = evaluatePermanent(state, perm);
			if (ev.controllerId !== playerId) continue;
			if (!ev.hasSubType('Room') && !perm.unlockedFaces?.length) continue;
			count += perm.unlockedFaces?.length ?? 0;
		}
	}
	return count;
}

/**
 * Number of distinct colors (`0..5`) among non-phased-out permanents matching `filter`
 * (or all permanents `playerId` controls when `filter` is omitted).
 */
export function computeColorsAmongPermanents(
	state: GameState,
	playerId: string,
	filter: ObjectFilter | undefined,
	matchesFn: (perm: CardInstance, f: ObjectFilter) => boolean
): number {
	let mask = 0;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (!filter) {
				if (ev.controllerId !== playerId) continue;
			} else if (!matchesFn(perm, filter)) {
				continue;
			}
			for (let i = 0; i < FIVE_COLORS.length; i++) {
				if (ev.colors.includes(FIVE_COLORS[i])) {
					mask |= 1 << i;
				}
			}
			if (mask === 0x1f) return 5;
		}
	}
	let count = 0;
	for (let i = 0; i < 5; i++) {
		if (mask & (1 << i)) count++;
	}
	return count;
}

/**
 * Greatest or total `power` / `toughness` / `manaValue` across non-phased-out battlefield
 * permanents matching `filter`.
 */
export function computeStatAggregateAmong(
	state: GameState,
	filter: ObjectFilter,
	stat: 'power' | 'toughness' | 'manaValue',
	mode: 'greatest' | 'total',
	matchesFn: (perm: CardInstance, f: ObjectFilter) => boolean
): number {
	let result = 0;
	let anyMatched = false;
	const zones: Array<Exclude<ZoneType, 'stack'>> =
		filter.zone === undefined
			? ['battlefield']
			: Array.isArray(filter.zone)
				? filter.zone.filter((z): z is Exclude<ZoneType, 'stack'> => z !== 'stack')
				: filter.zone === 'stack'
					? []
					: [filter.zone];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const z of zones) {
			for (const perm of p[z]) {
				if (z === 'battlefield' && perm.phasedOut) continue;
				if (!matchesFn(perm, filter)) continue;
				let val: number;
				if (z === 'battlefield') {
					const ev = evaluatePermanent(state, perm);
					val =
						stat === 'power'
							? ev.power
							: stat === 'toughness'
								? ev.toughness
								: objectManaValue(state, perm);
				} else {
					val =
						stat === 'power'
							? (objectPower(state, perm) ?? 0)
							: stat === 'toughness'
								? (objectToughness(state, perm) ?? 0)
								: objectManaValue(state, perm);
				}
				if (mode === 'greatest') {
					if (!anyMatched || val > result) {
						result = Math.max(0, val);
						anyMatched = true;
					}
				} else {
					result += Math.max(0, val);
				}
			}
		}
	}
	return result;
}

// ---- 2. P13 ObjectFilter & Condition Evaluators ---------------------------------------------

export interface P13ObjectFilterOptions {
	state: GameState;
	zone: ZoneType | 'stack';
	stackItem?: StackItem;
}

export function matchesP13ObjectFilterFields(
	inst: CardInstance,
	filter: ObjectFilter,
	opts: P13ObjectFilterOptions
): boolean {
	const { state, zone, stackItem } = opts;
	if (filter.attackingOrBlocking !== undefined) {
		if (zone !== 'battlefield') return false;
		const isAtt = state.combat.attackers.some((a) => a.attackerInstanceId === inst.instanceId);
		const isBlk = state.combat.attackers.some((a) =>
			a.blockerInstanceIds.includes(inst.instanceId)
		);
		if ((isAtt || isBlk) !== filter.attackingOrBlocking) return false;
	}
	if (filter.dealtDamageThisTurn !== undefined) {
		if (zone !== 'battlefield') return false;
		const wasDamaged =
			Boolean(inst.dealtDamageThisTurn) ||
			inst.damageMarked > 0 ||
			Boolean(inst.damagedByThisTurn?.length);
		if (wasDamaged !== filter.dealtDamageThisTurn) return false;
	}
	if (filter.enteredThisTurn !== undefined) {
		if (zone !== 'battlefield') return false;
		if (Boolean(inst.enteredThisTurn) !== filter.enteredThisTurn) return false;
	}
	const objStackItem =
		zone === 'stack'
			? stackItem &&
				(stackItem.sourceInstanceId === inst.instanceId || stackItem.id === inst.instanceId)
				? stackItem
				: state.stack.find(
						(s) =>
							s.kind === 'spell' &&
							(s.sourceInstanceId === inst.instanceId || s.id === inst.instanceId)
					)
			: undefined;
	if (filter.faceDown !== undefined) {
		const isFd = objStackItem ? Boolean(objStackItem.isFaceDown) : Boolean(inst.isFaceDown);
		if (isFd !== filter.faceDown) return false;
	}
	if (filter.kickedSpell !== undefined) {
		const kickedCount = objStackItem
			? Object.values(objStackItem.optionalCostCounts ?? {}).reduce((a, b) => a + b, 0)
			: (inst.kickedCount ?? 0);
		if ((kickedCount > 0) !== filter.kickedSpell) return false;
	}
	if (filter.castNotFromHand !== undefined) {
		const fromZone = objStackItem?.castFromZone ?? inst.castFromZone ?? 'hand';
		const notHand = fromZone !== 'hand';
		if (notHand !== filter.castNotFromHand) return false;
	}
	if (filter.castFromZoneFilter !== undefined) {
		const fromZone = objStackItem?.castFromZone ?? inst.castFromZone ?? 'hand';
		if (fromZone !== filter.castFromZoneFilter) return false;
	}
	return true;
}

export interface P13ConditionContext {
	state: GameState;
	controllerId: string;
	source?: CardInstance | null;
	sourceId?: string;
	stackItem?: StackItem;
	zone?: ZoneType | 'stack';
	manaColorsAllSpent?: readonly ManaColor[];
	manaColorsSpent?: readonly ManaColor[];
}

export function evaluateP13Condition(
	cond: Condition,
	ctx: P13ConditionContext
): boolean | undefined {
	const { state, controllerId } = ctx;
	const you = state.players.find((p) => p.playerId === controllerId);
	switch (cond.k) {
		case 'selfInZone': {
			if (ctx.source) {
				return ctx.source.zone === cond.zone;
			}
			if (ctx.sourceId && cond.zone !== 'stack') {
				const z = cond.zone;
				for (const p of state.players) {
					if (p[z].some((c) => c.instanceId === ctx.sourceId)) {
						return true;
					}
				}
			}
			if (ctx.zone !== undefined) {
				return ctx.zone === cond.zone;
			}
			return false;
		}
		case 'spellsCastLastTurn': {
			if (cond.mode === 'none') {
				return (state.spellsCastLastTurnTotal ?? 0) === 0;
			}
			return (state.maxSpellsCastBySinglePlayerLastTurn ?? 0) >= cond.count;
		}
		case 'hasCompletedDungeon':
			return (you?.dungeonsCompletedCount ?? 0) >= 1 || (you?.completedDungeonNames?.length ?? 0) >= 1;
		case 'hasInitiative':
			return Boolean(state.initiativePlayerId && state.initiativePlayerId === controllerId);
		case 'hasCitysBlessing':
			return Boolean(you?.hasCitysBlessing);
		case 'hasMaxSpeed':
			return (you?.speed ?? 0) >= 4;
		case 'opponentPoisonAtLeast':
			return state.players.some(
				(p) => !p.lost && p.playerId !== controllerId && (p.poison ?? 0) >= cond.min
			);
		case 'nonlandEnteredThisTurn':
			return (you?.nonlandPermanentsEnteredThisTurn ?? 0) >= cond.min;
		case 'voidThisTurn':
			return state.players.some(
				(p) => Boolean(p.nonlandPermanentLeftThisTurn) || Boolean(p.spellWarpedThisTurn)
			);
		case 'sameColorManaSpentAtLeast': {
			const allSpent =
				ctx.manaColorsAllSpent ??
				ctx.stackItem?.manaColorsAllSpent ??
				ctx.source?.manaColorsAllSpent;
			if (allSpent && allSpent.length > 0) {
				const counts: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
				for (const c of allSpent) counts[c] = (counts[c] ?? 0) + 1;
				if (cond.color) return (counts[cond.color] ?? 0) >= cond.min;
				return FIVE_COLORS.some((c) => counts[c] >= cond.min);
			}
			const distinct =
				ctx.manaColorsSpent ?? ctx.stackItem?.manaColorsSpent ?? ctx.source?.manaColorsSpent ?? [];
			if (cond.color) return cond.min <= 1 && distinct.includes(cond.color);
			return cond.min <= 1 && distinct.some((c) => c !== 'C');
		}
		default:
			return undefined;
	}
}

// ---- 3. Cross-Turn Duration Helpers (CR 611.2b, CR 800.4m) ----------------------------------

export function buildDurationExpiryFields(
	state: GameState,
	duration: Duration | undefined,
	actorPlayerId: string
): Pick<
	TimedContinuousEffect,
	'expires' | 'expiresOnTurnStartOfPlayerId' | 'expiresOnCleanupOfPlayerId' | 'grantedOnTurnSerial'
> {
	const turnSerial = state.turnSerial ?? state.turnNumber;
	if (duration === 'permanent') {
		return { expires: 'never' };
	}
	if (duration === 'untilSourceLeaves') {
		return { expires: 'untilSourceLeaves' };
	}
	if (duration === 'untilYourNextTurn') {
		return {
			expires: 'untilYourNextTurn',
			expiresOnTurnStartOfPlayerId: actorPlayerId,
			grantedOnTurnSerial: turnSerial
		};
	}
	if (duration === 'untilEndOfYourNextTurn') {
		return {
			expires: 'untilEndOfYourNextTurn',
			expiresOnCleanupOfPlayerId: actorPlayerId,
			grantedOnTurnSerial: turnSerial
		};
	}
	return { expires: 'endOfTurn' };
}

/**
 * CR 611.2b / CR 800.4m: Called at the beginning of `startingPlayerId`'s turn (and when a lost
 * player's turn would have begun) to expire `'untilYourNextTurn'` continuous effects and clear
 * `enteredThisTurn` on permanents from prior turns.
 */
export function expireP13UntilNextTurnEffects(state: GameState, startingPlayerId: string): void {
	if (state.timedContinuousEffects?.length) {
		const before = state.timedContinuousEffects.length;
		const remaining = state.timedContinuousEffects.filter((eff) => {
			if (eff.expires === 'untilYourNextTurn' && eff.expiresOnTurnStartOfPlayerId === startingPlayerId) {
				return false;
			}
			return true;
		});
		if (remaining.length !== before) {
			if (remaining.length > 0) state.timedContinuousEffects = remaining;
			else delete state.timedContinuousEffects;
			noteLayerInputsChanged(state);
		}
	}
	const startingPlayer = state.players.find((p) => p.playerId === startingPlayerId);
	if (startingPlayer?.hexproofUntilNextTurn) {
		delete startingPlayer.hexproofUntilNextTurn;
	}
	// --- Precon Bragos Spirit: expire "until your next turn" spell-name cast locks (CR 611.2b) ---
	for (const pl of state.players) {
		if (!pl.castNameLocks?.length) continue;
		const remaining = pl.castNameLocks.filter((l) => l.untilTurnStartOf !== startingPlayerId);
		if (remaining.length > 0) pl.castNameLocks = remaining;
		else delete pl.castNameLocks;
	}
	// --- End Precon Bragos Spirit ---
}

/**
 * Called at cleanup step of the active player's turn to:
 * 1. Record `spellsCastLastTurnTotal` and `maxSpellsCastBySinglePlayerLastTurn` before per-turn
 *    spell counters reset.
 * 2. Expire `'untilEndOfYourNextTurn'` TimedContinuousEffects and `playableFromGraveyardBy`
 *    permissions whose `grantedOnTurnSerial < currentTurnSerial` and whose player matches `activePlayerId`.
 * 3. Clear per-turn P13 flags (`enteredThisTurn`, `dealtDamageThisTurn`, `targetedByControllerIdsThisTurn`,
 *    `canAttackAsThoughNoDefenderThisTurn`, `extraLandPlaysThisTurn`, `nonlandPermanentsEnteredThisTurn`,
 *    `nonlandPermanentLeftThisTurn`, `spellWarpedThisTurn`).
 */
export function cleanupP13TurnState(state: GameState, activePlayerId: string): void {
	const currentTurnSerial = state.turnSerial ?? state.turnNumber;
	let totalSpells = 0;
	let maxSingle = 0;
	for (const p of state.players) {
		const c = p.spellsCastThisTurn ?? 0;
		totalSpells += c;
		if (c > maxSingle) maxSingle = c;
	}
	state.spellsCastLastTurnTotal = totalSpells;
	state.maxSpellsCastBySinglePlayerLastTurn = maxSingle;

	if (state.timedContinuousEffects?.length) {
		const before = state.timedContinuousEffects.length;
		const remaining = state.timedContinuousEffects.filter((eff) => {
			if (
				eff.expires === 'untilEndOfYourNextTurn' &&
				eff.expiresOnCleanupOfPlayerId === activePlayerId &&
				(eff.grantedOnTurnSerial ?? 0) < currentTurnSerial
			) {
				return false;
			}
			return true;
		});
		if (remaining.length !== before) {
			if (remaining.length > 0) state.timedContinuousEffects = remaining;
			else delete state.timedContinuousEffects;
		}
	}

	for (const p of state.players) {
		delete p.extraLandPlaysThisTurn;
		delete p.hexproofThisTurn;
		delete p.nonlandPermanentsEnteredThisTurn;
		delete p.nonlandPermanentLeftThisTurn;
		delete p.spellWarpedThisTurn;
		for (const perm of p.battlefield) {
			delete perm.enteredThisTurn;
			delete perm.dealtDamageThisTurn;
			delete perm.targetedByControllerIdsThisTurn;
			delete perm.canAttackAsThoughNoDefenderThisTurn;
			delete perm.ringBlockedForPlayerIds;
		}
		for (const card of p.graveyard) {
			const perm = card.playableFromGraveyardBy;
			if (!perm) continue;
			if (perm.expiresAtEndOfTurn) {
				delete card.playableFromGraveyardBy;
			} else if (
				perm.expiresOnCleanupOfPlayerId === activePlayerId &&
				(perm.grantedOnTurnSerial ?? 0) < currentTurnSerial
			) {
				delete card.playableFromGraveyardBy;
			}
		}
	}
	noteLayerInputsChanged(state);
}

// ---- 4. Emblems (CR 114.1–114.5) ------------------------------------------------------------

export function executeCreateEmblem(
	state: GameState,
	recipients: readonly PlayerGameState[],
	sourceName: string,
	emblemAbilities: readonly string[]
): void {
	if (emblemAbilities.length === 0 || recipients.length === 0) return;
	for (const player of recipients) {
		if (player.lost) continue;
		const emblemId = uid('emb', state);
		const normalizedAbilities = emblemAbilities.map((ab) =>
			ab.replace(/~/g, `Emblem — ${sourceName}`)
		);
		const card = buildEmblemScryfallCard(
			emblemId,
			`Emblem — ${sourceName}`,
			normalizedAbilities
		);
		const inst: CardInstance = {
			instanceId: emblemId,
			card,
			ownerId: player.playerId,
			controllerId: player.playerId,
			zone: 'command',
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
			transformed: false,
			enteredTimestamp: allocateTimestamp(state),
			objectVersion: 1,
			isEmblem: true
		};
		putIntoCommandZone(state, player, inst);
		pushP13Log(
			state,
			player.playerId,
			'rule',
			`${player.username} gets an emblem (${sourceName}, CR 114.2).`
		);
	}
}

// ---- 5. Predefined Role Aura Tokens (CR 111.10k–r) & Role SBA (CR 704.5z) -------------------

export function executeCreateRoleToken(
	state: GameState,
	actor: PlayerGameState,
	targets: readonly CardInstance[],
	roleKind: RoleTokenKind
): CardInstance[] {
	if (actor.lost || targets.length === 0) return [];
	const created: CardInstance[] = [];
	const spec = ROLE_TOKEN_SPECS[roleKind];
	if (!spec) return [];

	for (const host of targets) {
		if (host.zone !== 'battlefield' || host.phasedOut) continue;
		const evHost = evaluatePermanent(state, host);
		if (!evHost.isCreature) continue;

		const count = Math.max(0, tokenMultiplier(state, actor.playerId));
		for (let i = 0; i < count; i++) {
			const tokId = uid('tok', state);
			const card = buildRoleTokenScryfallCard(tokId, roleKind);
			const inst: CardInstance = {
				instanceId: tokId,
				card,
				ownerId: actor.playerId,
				controllerId: actor.playerId,
				defaultControllerId: actor.playerId,
				zone: 'battlefield',
				tapped: false,
				summoningSick: false,
				damageMarked: 0,
				deathtouchDamageMarked: false,
				counters: createEmptyCounterMap(),
				tempPowerMod: 0,
				tempToughnessMod: 0,
				grantedKeywords: [],
				attachedToId: host.instanceId,
				isToken: true,
				isCommander: false,
				commanderCastCount: 0,
				usedLoyaltyThisTurn: false,
				transformed: false,
				enteredTimestamp: allocateTimestamp(state),
				objectVersion: 1
			};
			const dest = moveObject(state, inst, 'battlefield', {
				from: 'none',
				toPlayer: actor,
				controllerId: actor.playerId,
				newTimestamp: true
			});
			if (dest === 'battlefield') {
				emitEvent(state, {
					kind: 'Attached',
					attachmentId: inst.instanceId,
					attachment: inst,
					hostId: host.instanceId,
					host
				});
				created.push(inst);
			}
		}
	}
	return created;
}

/**
 * CR 704.5z: If two or more Role Auras controlled by the same player are attached to the same
 * permanent, all of them except the one with the most recent timestamp are put into their owners'
 * graveyards simultaneously. Role Auras controlled by different players on the same permanent both stay.
 */
export function applyRoleTokenSba(state: GameState): boolean {
	const byHostAndCtrl = new Map<string, Array<{ perm: CardInstance; holder: PlayerGameState }>>();
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || !perm.attachedToId) continue;
			const ev = evaluatePermanent(state, perm);
			if (!ev.hasSubType('Role') || !ev.hasSubType('Aura')) continue;
			const key = `${perm.attachedToId}::${ev.controllerId}`;
			let group = byHostAndCtrl.get(key);
			if (!group) {
				group = [];
				byHostAndCtrl.set(key, group);
			}
			group.push({ perm, holder: p });
		}
	}

	const toGraveyard: Array<{ perm: CardInstance; holder: PlayerGameState }> = [];
	for (const group of byHostAndCtrl.values()) {
		if (group.length < 2) continue;
		let newest = group[0];
		for (let i = 1; i < group.length; i++) {
			if ((group[i].perm.enteredTimestamp ?? 0) >= (newest.perm.enteredTimestamp ?? 0)) {
				newest = group[i];
			}
		}
		for (const entry of group) {
			if (entry.perm.instanceId !== newest.perm.instanceId) {
				toGraveyard.push(entry);
			}
		}
	}

	if (toGraveyard.length === 0) return false;
	for (const { perm, holder } of toGraveyard) {
		moveObject(state, perm, 'graveyard', {
			from: { player: holder, zone: 'battlefield' },
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true,
			graveyardReplacement: true,
			ceaseToExist: 'tokens'
		});
		pushP13Log(
			state,
			holder.playerId,
			'sba',
			`Role SBA (CR 704.5z): Older Role ${perm.card.name} was put into graveyard.`
		);
	}
	return true;
}

// ---- 6. Double / Triple (CR 701.10–11), Exchange (CR 701.12), Turn Face (CR 708) ------------

export interface P13LifeFunnels {
	gainLife: (state: GameState, player: PlayerGameState, amount: number) => number;
	loseLife: (state: GameState, player: PlayerGameState, amount: number) => number;
	lifeCantChange: (state: GameState, player: PlayerGameState) => boolean;
}

export function executeDoubleOrTriple(
	state: GameState,
	actor: PlayerGameState,
	sourceName: string,
	targets: readonly CardInstance[],
	targetPlayers: readonly PlayerGameState[],
	spec: DoubleOrTripleSpec,
	lifeFunnels: P13LifeFunnels
): number {
	const mult = spec.factor - 1; // ×2 adds 1× current; ×3 adds 2× current
	let totalDelta = 0;

	if (spec.target === 'life') {
		const players = targetPlayers.length > 0 ? targetPlayers : [actor];
		for (const pl of players) {
			if (pl.lost) continue;
			const delta = pl.life * mult;
			if (delta > 0) {
				totalDelta += lifeFunnels.gainLife(state, pl, delta);
			} else if (delta < 0) {
				totalDelta += lifeFunnels.loseLife(state, pl, -delta);
			}
		}
		return totalDelta;
	}

	if (spec.target === 'counters') {
		for (const perm of targets) {
			if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
			if (!spec.counter || spec.counter === 'each') {
				const entries = Object.entries(perm.counters) as Array<[CounterType, number]>;
				for (const [cType, count] of entries) {
					if (count > 0) {
						const addCount = count * mult;
						placeRegisteredCounters(state, perm, cType, addCount);
						totalDelta += addCount;
					}
				}
			} else {
				const count = perm.counters[spec.counter] ?? 0;
				if (count > 0) {
					const addCount = count * mult;
					placeRegisteredCounters(state, perm, spec.counter, addCount);
					totalDelta += addCount;
				}
			}
		}
		return totalDelta;
	}

	// CR 701.10b–d / CR 701.11b: Double or triple power, toughness, or both.
	const duration = spec.duration ?? 'endOfTurn';
	for (const perm of targets) {
		if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		const pDelta = spec.target === 'power' || spec.target === 'pt' ? ev.power * mult : 0;
		const tDelta = spec.target === 'toughness' || spec.target === 'pt' ? ev.toughness * mult : 0;
		totalDelta += Math.abs(pDelta) + Math.abs(tDelta);
		if (pDelta === 0 && tDelta === 0) continue;

		if (duration === 'endOfTurn') {
			perm.tempPowerMod += pDelta;
			perm.tempToughnessMod += tDelta;
			noteLayerInputsChanged(state);
		} else {
			const eff: TimedContinuousEffect = {
				timestamp: allocateTimestamp(state),
				sourceName,
				controllerId: actor.playerId,
				affected: [{ instanceId: perm.instanceId, objectVersion: perm.objectVersion ?? 1 }],
				...buildDurationExpiryFields(state, duration, actor.playerId),
				layer7c: { power: pDelta, toughness: tDelta }
			};
			(state.timedContinuousEffects ??= []).push(eff);
			noteLayerInputsChanged(state);
		}
	}
	return totalDelta;
}

/**
 * CR 701.12: Exchanges control of two permanents, two players' life totals, or a player's life
 * total with a creature's power/toughness. Under CR 701.12a, if the entire exchange can't be
 * completed, no part of the exchange occurs.
 */
export function executeExchange(
	state: GameState,
	actor: PlayerGameState,
	sourceName: string,
	firstObjects: readonly CardInstance[],
	secondObjects: readonly CardInstance[],
	targetPlayers: readonly PlayerGameState[],
	spec: ExchangeSpec,
	lifeFunnels: P13LifeFunnels
): boolean {
	if (spec.kind === 'control') {
		let permA: CardInstance | undefined;
		let permB: CardInstance | undefined;
		if (firstObjects.length >= 2 && secondObjects.length === 0) {
			permA = firstObjects[0];
			permB = firstObjects[1];
		} else {
			permA = firstObjects[0];
			permB = secondObjects[0];
		}
		if (
			!permA ||
			!permB ||
			permA.instanceId === permB.instanceId ||
			permA.zone !== 'battlefield' ||
			permB.zone !== 'battlefield' ||
			permA.phasedOut ||
			permB.phasedOut
		) {
			return false;
		}
		const ctrlA = evaluatePermanent(state, permA).controllerId;
		const ctrlB = evaluatePermanent(state, permB).controllerId;
		if (ctrlA === ctrlB) return false; // CR 701.12b: same controller -> nothing happens
		const tsA = allocateTimestamp(state);
		const tsB = allocateTimestamp(state);
		(state.timedContinuousEffects ??= []).push(
			{
				timestamp: tsA,
				sourceName,
				controllerId: actor.playerId,
				affected: [{ instanceId: permA.instanceId, objectVersion: permA.objectVersion ?? 1 }],
				expires: 'never',
				layer2: { controllerId: ctrlB }
			},
			{
				timestamp: tsB,
				sourceName,
				controllerId: actor.playerId,
				affected: [{ instanceId: permB.instanceId, objectVersion: permB.objectVersion ?? 1 }],
				expires: 'never',
				layer2: { controllerId: ctrlA }
			}
		);
		noteLayerInputsChanged(state);
		syncBattlefieldControllers(state);
		return true;
	}

	if (spec.kind === 'lifeTotals') {
		let pA: PlayerGameState | undefined;
		let pB: PlayerGameState | undefined;
		if (targetPlayers.length >= 2) {
			pA = targetPlayers[0];
			pB = targetPlayers[1];
		} else if (targetPlayers.length === 1) {
			pA = actor;
			pB = targetPlayers[0];
		}
		if (!pA || !pB || pA.lost || pB.lost || pA.playerId === pB.playerId) return false;
		const lifeA = pA.life;
		const lifeB = pB.life;
		if (lifeA === lifeB) return true;
		// CR 701.12a / CR 119.5: check neither player's life change is prohibited before applying either
		if (lifeFunnels.lifeCantChange(state, pA) || lifeFunnels.lifeCantChange(state, pB)) {
			return false;
		}
		if (lifeB > lifeA && playerCantGainLife(state, pA.playerId)) return false;
		if (lifeA > lifeB && playerCantGainLife(state, pB.playerId)) return false;

		if (lifeB > lifeA) lifeFunnels.gainLife(state, pA, lifeB - lifeA);
		else lifeFunnels.loseLife(state, pA, lifeA - lifeB);

		if (lifeA > lifeB) lifeFunnels.gainLife(state, pB, lifeA - lifeB);
		else lifeFunnels.loseLife(state, pB, lifeB - lifeA);
		return true;
	}

	// lifeAndPower / lifeAndToughness (CR 701.12f)
	const perm = firstObjects[0] ?? secondObjects[0];
	const pl = targetPlayers[0] ?? actor;
	if (!perm || perm.zone !== 'battlefield' || perm.phasedOut || pl.lost) return false;
	const ev = evaluatePermanent(state, perm);
	const statVal = spec.kind === 'lifeAndPower' ? ev.power : ev.toughness;
	const oldLife = pl.life;
	if (oldLife !== statVal) {
		if (lifeFunnels.lifeCantChange(state, pl)) return false;
		if (statVal > oldLife && playerCantGainLife(state, pl.playerId)) return false;
		if (statVal > oldLife) lifeFunnels.gainLife(state, pl, statVal - oldLife);
		else lifeFunnels.loseLife(state, pl, oldLife - statVal);
	}
	(state.timedContinuousEffects ??= []).push({
		timestamp: allocateTimestamp(state),
		sourceName,
		controllerId: actor.playerId,
		affected: [{ instanceId: perm.instanceId, objectVersion: perm.objectVersion ?? 1 }],
		expires: 'never',
		layer7b: {
			setPower: spec.kind === 'lifeAndPower' ? oldLife : ev.power,
			setToughness: spec.kind === 'lifeAndToughness' ? oldLife : ev.toughness
		}
	});
	noteLayerInputsChanged(state);
	return true;
}

/**
 * CR 708.2 / CR 708.8 / CR 701.40g: Turns battlefield permanent(s) face up or face down.
 */
export function executeTurnFace(
	state: GameState,
	targets: readonly CardInstance[],
	direction: 'up' | 'down'
): void {
	for (const perm of targets) {
		if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
		if (direction === 'down') {
			if (perm.isFaceDown || perm.isToken) continue;
			perm.isFaceDown = true;
			perm.faceDownSpec = {
				kind: 'other',
				types: ['Creature'],
				power: 2,
				toughness: 2,
				colors: []
			};
			noteLayerInputsChanged(state);
		} else {
			if (!perm.isFaceDown) continue;
			const trueCard = perm.printedCard ?? perm.card;
			const trueView = resolveObjectFaces(trueCard, { zone: 'hand' });
			const isInstantOrSorceryOnly =
				(trueView.types.includes('Instant') || trueView.types.includes('Sorcery')) &&
				!trueView.types.some((t) =>
					['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(t)
				);
			if (isInstantOrSorceryOnly) {
				// CR 701.40g: Reveal manifested instant/sorcery card and leave it face down.
				pushP13Log(
					state,
					perm.controllerId,
					'rule',
					`CR 701.40g: Face-down ${trueCard.name} is an instant or sorcery and remains face down.`
				);
				continue;
			}
			perm.isFaceDown = false;
			delete perm.faceDownSpec;
			delete perm.faceDownLabel;
			noteLayerInputsChanged(state);
			emitEvent(state, {
				kind: 'TurnedFaceUp',
				playerId: perm.controllerId,
				objectId: perm.instanceId,
				object: perm
			});
		}
	}
}

// ---- 7. Choose Designation & Temporary Graveyard Cast Grant ---------------------------------

export type P13StepAskFn = (
	player: PlayerGameState,
	answerKey: string,
	choice: ChoiceRequest,
	title: string,
	description: string
) => ChoiceAnswer | 'PAUSED';

export function executeChooseDesignation(
	state: GameState,
	actor: PlayerGameState,
	sourcePerm: CardInstance | null,
	chooseKind: 'color' | 'creatureType' | 'cardName' | 'nonlandCardName',
	answerKey: string,
	ask: P13StepAskFn,
	// --- Precon Bragos Spirit ---
	resolvingSpell?: StackItem
	// --- End Precon Bragos Spirit ---
): 'DONE' | 'PAUSED' {
	// --- Precon Bragos Spirit: CR 608.2c a resolving spell's "Choose a creature type / color" is recorded on the spell ---
	if ((!sourcePerm || sourcePerm.zone !== 'battlefield') && resolvingSpell?.kind === 'spell') {
		if (chooseKind === 'creatureType') {
			let sub: string;
			if (actor.isBot) {
				sub = chooseBotBestCreatureSubtype(state, actor);
			} else {
				const options = buildCreatureSubtypeOptions(state, actor);
				const ans = ask(
					actor,
					answerKey,
					{ kind: 'chooseMode', modes: options, min: 1, max: 1 },
					'Choose a Creature Type',
					`Choose a creature type for ${resolvingSpell.card.name}.`
				);
				if (ans === 'PAUSED') return 'PAUSED';
				const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
				sub = options[idx] ?? options[0] ?? 'Human';
			}
			resolvingSpell.sourceChosenSubType = sub;
			return 'DONE';
		}
		if (chooseKind === 'color') {
			let color: ManaColor;
			if (actor.isBot) {
				color = chooseBotBestColor(state, actor);
			} else {
				const { labels } = buildColorChoiceOptions();
				const ans = ask(
					actor,
					answerKey,
					{ kind: 'chooseMode', modes: labels, min: 1, max: 1 },
					'Choose a Color',
					`Choose a color for ${resolvingSpell.card.name}.`
				);
				if (ans === 'PAUSED') return 'PAUSED';
				const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
				color = COLOR_CODE_BY_LABEL[(labels[idx] ?? labels[0] ?? 'White').toLowerCase()] ?? 'W';
			}
			resolvingSpell.sourceChosenColor = color;
			return 'DONE';
		}
	}
	// --- End Precon Bragos Spirit ---
	if (!sourcePerm || sourcePerm.zone !== 'battlefield') return 'DONE';
	if (chooseKind === 'color') {
		if (actor.isBot) {
			sourcePerm.chosenColor = chooseBotBestColor(state, actor, undefined, sourcePerm);
			noteLayerInputsChanged(state);
			return 'DONE';
		}
		const { labels } = buildColorChoiceOptions();
		const ans = ask(
			actor,
			answerKey,
			{ kind: 'chooseMode', modes: labels, min: 1, max: 1 },
			'Choose a Color',
			`Choose a color for ${sourcePerm.card.name}.`
		);
		if (ans === 'PAUSED') return 'PAUSED';
		const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
		const label = labels[idx] ?? labels[0] ?? 'White';
		sourcePerm.chosenColor = COLOR_CODE_BY_LABEL[label.toLowerCase()] ?? 'W';
		noteLayerInputsChanged(state);
		return 'DONE';
	}
	if (chooseKind === 'creatureType') {
		if (actor.isBot) {
			sourcePerm.chosenSubType = chooseBotBestCreatureSubtype(state, actor, sourcePerm);
			noteLayerInputsChanged(state);
			return 'DONE';
		}
		const options = buildCreatureSubtypeOptions(state, actor, sourcePerm);
		const ans = ask(
			actor,
			answerKey,
			{ kind: 'chooseMode', modes: options, min: 1, max: 1 },
			'Choose a Creature Type',
			`Choose a creature type for ${sourcePerm.card.name}.`
		);
		if (ans === 'PAUSED') return 'PAUSED';
		const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
		sourcePerm.chosenSubType = options[idx] ?? options[0] ?? 'Human';
		noteLayerInputsChanged(state);
		return 'DONE';
	}
	const nonlandOnly = chooseKind === 'nonlandCardName';
	if (actor.isBot) {
		sourcePerm.chosenCardName = chooseBotBestCardName(state, actor, sourcePerm, nonlandOnly);
		noteLayerInputsChanged(state);
		return 'DONE';
	}
	const options = buildCardNameChoiceOptions(state, actor, sourcePerm, nonlandOnly);
	const ans = ask(
		actor,
		answerKey,
		{ kind: 'chooseMode', modes: options, min: 1, max: 1 },
		nonlandOnly ? 'Choose a Nonland Card Name' : 'Choose a Card Name',
		`Choose a ${nonlandOnly ? 'nonland ' : ''}card name for ${sourcePerm.card.name}.`
	);
	if (ans === 'PAUSED') return 'PAUSED';
	const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
	sourcePerm.chosenCardName = options[idx] ?? options[0] ?? 'Construct';
	noteLayerInputsChanged(state);
	return 'DONE';
}

export function executeGrantGraveyardCast(
	state: GameState,
	actor: PlayerGameState,
	sourceName: string,
	targets: readonly CardInstance[],
	spec: GraveyardCastGrantSpec
): void {
	const turnSerial = state.turnSerial ?? state.turnNumber;
	for (const card of targets) {
		if (card.zone !== 'graveyard') continue;
		const view = resolveObjectFaces(effectiveCardForObject(card), { zone: 'graveyard' });
		if (view.types.includes('Land') && view.types.length === 1) continue;
		card.playableFromGraveyardBy = {
			playerId: actor.playerId,
			sourceName,
			...(spec.duration === 'thisTurn'
				? { expiresAtEndOfTurn: true }
				: {
						expiresOnCleanupOfPlayerId: actor.playerId,
						grantedOnTurnSerial: turnSerial
					}),
			...(spec.flashbackEqualManaCost ? { flashbackEqualManaCost: true } : {}),
			...(spec.alternativeManaCost !== undefined
				? { alternativeManaCost: spec.alternativeManaCost }
				: {}),
			...(spec.withoutPayingManaCost ? { withoutPayingManaCost: true } : {}),
			...(spec.exileIfWouldEnterGraveyard !== false || spec.flashbackEqualManaCost
				? { exileIfWouldEnterGraveyard: true }
				: {})
		};
	}
}

export function collectP13GraveyardAndAirbendCastOptions(
	actor: PlayerGameState,
	inst: CardInstance,
	fromZone: CastOption['fromZone'],
	faceIndex: number | undefined,
	manaCost: string,
	requiresTarget: boolean
): CastOption[] {
	const out: CastOption[] = [];
	if (fromZone === 'graveyard' && inst.playableFromGraveyardBy?.playerId === actor.playerId) {
		const perm = inst.playableFromGraveyardBy;
		if (perm.withoutPayingManaCost) {
			out.push({
				id: `gy_grant_${inst.instanceId}`,
				label: `Cast from graveyard without paying mana cost (${perm.sourceName})`,
				costDisplay: '{0}',
				fromZone: 'graveyard',
				permission: 'graveyard_permission',
				...(faceIndex !== undefined ? { faceIndex } : {}),
				baseCost: { kind: 'free' },
				timing: 'default',
				spellMods: {
					...(perm.exileIfWouldEnterGraveyard ? { exileOnLeaveStack: true } : {})
				},
				choosesX: false,
				requiresTarget
			});
		} else {
			const costStr = perm.alternativeManaCost ?? manaCost;
			if (costStr || !perm.flashbackEqualManaCost || manaCost !== '') {
				const choosesX = /\{X\}/i.test(costStr);
				out.push({
					id: `gy_grant_${inst.instanceId}`,
					label: perm.flashbackEqualManaCost
						? `Flashback ${costStr || '{0}'} (${perm.sourceName})`
						: `Cast from graveyard (${perm.sourceName})`,
					costDisplay: costStr || '{0}',
					fromZone: 'graveyard',
					permission: 'graveyard_permission',
					...(faceIndex !== undefined ? { faceIndex } : {}),
					baseCost: perm.flashbackEqualManaCost || perm.alternativeManaCost !== undefined
						? { kind: 'alternative', manaCost: costStr }
						: { kind: 'printed' },
					timing: 'default',
					spellMods: {
						...(perm.exileIfWouldEnterGraveyard ? { exileOnLeaveStack: true } : {})
					},
					choosesX,
					requiresTarget
				});
			}
		}
	}
	if (fromZone === 'exile' && inst.airbentCastPermission?.playerId === actor.playerId) {
		out.push({
			id: `airbend_cast_${inst.instanceId}`,
			label: 'Cast via Airbend ({2})',
			costDisplay: '{2}',
			fromZone: 'exile',
			permission: 'exile_permission',
			...(faceIndex !== undefined ? { faceIndex } : {}),
			baseCost: { kind: 'alternative', manaCost: '{2}' },
			timing: 'default',
			spellMods: {},
			choosesX: false,
			requiresTarget
		});
	}
	return out;
}

// ---- 8. Dungeons (CR 309, 701.49, 704.5t) & The Initiative (CR 727) -------------------------

const STANDARD_DUNGEON_IDS: readonly DungeonId[] = ['lost_mine', 'mad_mage', 'tomb'];

function pickAutoTargetForDungeonRoom(
	state: GameState,
	actor: PlayerGameState,
	dungeonId: DungeonId,
	roomIndex: number
): TargetRef[] {
	// Rooms with targets:
	// - lost_mine 3 (Storeroom): Put a +1/+1 counter on target creature.
	// - lost_mine 5 (Fungi Cavern): Target creature gets -4/-0 until your next turn.
	// - mad_mage 3 (Twisted Caverns): Target creature can't attack until your next turn.
	// - undercity 1 (Forge): Put two +1/+1 counters on target creature.
	// - undercity 3 (Trap!): Target player loses 5 life.
	// - undercity 4 (Arena): Goad target creature.
	if (
		(dungeonId === 'lost_mine' && roomIndex === 3) ||
		(dungeonId === 'undercity' && roomIndex === 1)
	) {
		// Prefer own creature, else any creature
		const own = actor.battlefield.find(
			(p) => !p.phasedOut && evaluatePermanent(state, p).isCreature
		);
		if (own) return [{ kind: 'permanent', id: own.instanceId, label: own.card.name }];
		for (const pl of state.players) {
			if (pl.lost) continue;
			const anyC = pl.battlefield.find(
				(p) => !p.phasedOut && evaluatePermanent(state, p).isCreature
			);
			if (anyC) return [{ kind: 'permanent', id: anyC.instanceId, label: anyC.card.name }];
		}
		return [];
	}
	if (
		(dungeonId === 'lost_mine' && roomIndex === 5) ||
		(dungeonId === 'mad_mage' && roomIndex === 3) ||
		(dungeonId === 'undercity' && roomIndex === 4)
	) {
		// Prefer opponent creature, else own creature
		for (const pl of state.players) {
			if (pl.lost || pl.playerId === actor.playerId) continue;
			const oppC = pl.battlefield.find(
				(p) => !p.phasedOut && evaluatePermanent(state, p).isCreature
			);
			if (oppC) return [{ kind: 'permanent', id: oppC.instanceId, label: oppC.card.name }];
		}
		const own = actor.battlefield.find(
			(p) => !p.phasedOut && evaluatePermanent(state, p).isCreature
		);
		if (own) return [{ kind: 'permanent', id: own.instanceId, label: own.card.name }];
		return [];
	}
	if (dungeonId === 'undercity' && roomIndex === 3) {
		// Target opponent, else self
		const opp = state.players.find((pl) => !pl.lost && pl.playerId !== actor.playerId);
		const tgt = opp ?? actor;
		return [{ kind: 'player', id: tgt.playerId, label: tgt.username }];
	}
	return [];
}

function enterDungeonRoom(
	state: GameState,
	player: PlayerGameState,
	dungeonId: DungeonId,
	roomIndex: number,
	ensureCommandCard: boolean
): void {
	const spec = DUNGEON_SPECS[dungeonId];
	const room = spec.rooms[roomIndex] ?? spec.rooms[0];
	if (ensureCommandCard) {
		removeFromGame(player, 'command', (c) => Boolean(c.isDungeon));
		const dngCardId = uid('dng', state);
		const dngInst: CardInstance = {
			instanceId: dngCardId,
			card: buildDungeonScryfallCard(dngCardId, dungeonId),
			ownerId: player.playerId,
			controllerId: player.playerId,
			zone: 'command',
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
			transformed: false,
			enteredTimestamp: allocateTimestamp(state),
			objectVersion: 1,
			isDungeon: true
		};
		putIntoCommandZone(state, player, dngInst);
	}
	const isBottom = room.nextRooms.length === 0;
	player.activeDungeon = {
		dungeonId,
		roomIndex,
		...(isBottom ? { pendingCompletion: true } : {})
	};
	noteLayerInputsChanged(state);

	emitEvent(state, {
		kind: 'DungeonRoomEntered',
		playerId: player.playerId,
		dungeonId,
		roomIndex,
		roomName: room.name
	});

	const roomTargets = pickAutoTargetForDungeonRoom(state, player, dungeonId, roomIndex);
	// Check if room requires target and none exists on board (CR 603.3d: removed from stack immediately)
	const requiresCreatureTarget =
		(dungeonId === 'lost_mine' && (roomIndex === 3 || roomIndex === 5)) ||
		(dungeonId === 'mad_mage' && roomIndex === 3) ||
		(dungeonId === 'undercity' && (roomIndex === 1 || roomIndex === 4));
	if (requiresCreatureTarget && roomTargets.length === 0) {
		pushP13Log(
			state,
			player.playerId,
			'trigger',
			`${player.username} ventured into ${spec.name} — ${room.name} (no legal target; room trigger removed per CR 603.3d).`
		);
		applyDungeonCompletionSba(state);
		return;
	}

	const trigCardId = uid('dtr', state);
	const trigCard = buildDungeonRoomTriggerCard(trigCardId, dungeonId, roomIndex);
	const dungeonCmd = player.command.find((c) => c.isDungeon);
	state.stack.push(
		withStackItemText(
			{
				id: uid('stk', state),
				sourceInstanceId: dungeonCmd?.instanceId ?? trigCardId,
				card: trigCard,
				ownerId: player.playerId,
				controllerId: player.playerId,
				kind: 'triggered',
				title: `${spec.name} — ${room.name}`,
				targets: roomTargets,
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: Date.now(),
				inherentTrigger: {
					kind: 'dungeonRoomAbility',
					playerId: player.playerId,
					dungeonId,
					roomIndex
				}
			},
			room.effectText
		)
	);
	pushP13Log(
		state,
		player.playerId,
		'trigger',
		`${player.username} ventured into ${spec.name} — ${room.name}.`
	);
}

/**
 * CR 701.49a–d: Ventures into the dungeon (`dungeonKind === 'dungeon'`) or into Undercity
 * (`dungeonKind === 'undercity'`). When called inside `Run`, uses `ask` for human dungeon/room
 * selection; when `ask` is omitted (e.g. inherent upkeep trigger), queues `'p13_venture_choice'`.
 */
export function executeVentureIntoDungeon(
	state: GameState,
	player: PlayerGameState,
	dungeonKind: 'dungeon' | 'undercity',
	answerKey = 'p13_venture',
	ask?: P13StepAskFn
): 'DONE' | 'PAUSED' {
	if (player.lost) return 'DONE';

	// Complete any already-finished dungeon sitting at bottommost room with no stack item first
	if (player.activeDungeon) {
		const curSpec = DUNGEON_SPECS[player.activeDungeon.dungeonId];
		const curRoom = curSpec.rooms[player.activeDungeon.roomIndex];
		if (!curRoom || curRoom.nextRooms.length === 0) {
			completePlayerDungeonImmediate(state, player);
		}
	}

	if (!player.activeDungeon) {
		if (dungeonKind === 'undercity') {
			enterDungeonRoom(state, player, 'undercity', 0, true);
			return 'DONE';
		}
		if (player.isBot) {
			enterDungeonRoom(state, player, 'lost_mine', 0, true);
			return 'DONE';
		}
		const labels = STANDARD_DUNGEON_IDS.map((id) => DUNGEON_SPECS[id].name);
		if (ask) {
			const ans = ask(
				player,
				answerKey,
				{ kind: 'chooseMode', modes: labels, min: 1, max: 1 },
				'Venture into the Dungeon (CR 701.49a)',
				'Choose a dungeon to enter:'
			);
			if (ans === 'PAUSED') return 'PAUSED';
			const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
			const chosenId = STANDARD_DUNGEON_IDS[idx] ?? 'lost_mine';
			enterDungeonRoom(state, player, chosenId, 0, true);
			return 'DONE';
		}
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: player.playerId,
			kind: 'chooseMode',
			purpose: 'generic',
			title: 'Venture into the Dungeon (CR 701.49a)',
			description: 'Choose a dungeon to enter:',
			continuation: {
				kind: 'handler',
				name: 'p13_venture_choice',
				data: { playerId: player.playerId, phase: 'chooseDungeon' }
			},
			choice: { kind: 'chooseMode', modes: labels, min: 1, max: 1 }
		});
		return 'PAUSED';
	}

	// Already in a dungeon: advance along room graph (CR 701.49b / 701.49d)
	const active = player.activeDungeon;
	const spec = DUNGEON_SPECS[active.dungeonId];
	const curRoom = spec.rooms[active.roomIndex];
	if (curRoom.nextRooms.length === 1) {
		enterDungeonRoom(state, player, active.dungeonId, curRoom.nextRooms[0], false);
		return 'DONE';
	}
	if (player.isBot) {
		enterDungeonRoom(state, player, active.dungeonId, curRoom.nextRooms[0], false);
		return 'DONE';
	}
	const nextLabels = curRoom.nextRooms.map(
		(ri) => `${spec.rooms[ri].name} — ${spec.rooms[ri].effectText}`
	);
	if (ask) {
		const ans = ask(
			player,
			answerKey,
			{ kind: 'chooseMode', modes: nextLabels, min: 1, max: 1 },
			`${spec.name} — Choose Next Room`,
			`Choose the next room to venture into from ${curRoom.name}:`
		);
		if (ans === 'PAUSED') return 'PAUSED';
		const idx = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
		const nextRoomIdx = curRoom.nextRooms[idx] ?? curRoom.nextRooms[0];
		enterDungeonRoom(state, player, active.dungeonId, nextRoomIdx, false);
		return 'DONE';
	}
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId: player.playerId,
		kind: 'chooseMode',
		purpose: 'generic',
		title: `${spec.name} — Choose Next Room`,
		description: `Choose the next room to venture into from ${curRoom.name}:`,
		continuation: {
			kind: 'handler',
			name: 'p13_venture_choice',
			data: {
				playerId: player.playerId,
				phase: 'chooseRoom',
				dungeonId: active.dungeonId,
				fromRoomIndex: active.roomIndex
			}
		},
		choice: { kind: 'chooseMode', modes: nextLabels, min: 1, max: 1 }
	});
	return 'PAUSED';
}

registerPromptHandler('p13_venture_choice', (state, prompt, answer) => {
	if (answer.kind !== 'chooseMode') return;
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data || typeof data.playerId !== 'string') return;
	const player = state.players.find((p) => p.playerId === data.playerId);
	if (!player || player.lost) return;
	const idx = answer.indices[0] ?? 0;
	if (data.phase === 'chooseDungeon') {
		const chosenId = STANDARD_DUNGEON_IDS[idx] ?? 'lost_mine';
		enterDungeonRoom(state, player, chosenId, 0, true);
	} else if (data.phase === 'chooseRoom' && typeof data.dungeonId === 'string') {
		const dId = data.dungeonId as DungeonId;
		const fromIdx = typeof data.fromRoomIndex === 'number' ? data.fromRoomIndex : 0;
		const nextRooms = DUNGEON_SPECS[dId]?.rooms[fromIdx]?.nextRooms ?? [];
		const nextRoomIdx = nextRooms[idx] ?? nextRooms[0];
		if (nextRoomIdx !== undefined) {
			enterDungeonRoom(state, player, dId, nextRoomIdx, false);
		}
	}
});

function completePlayerDungeonImmediate(state: GameState, player: PlayerGameState): void {
	const active = player.activeDungeon;
	if (!active) return;
	const spec = DUNGEON_SPECS[active.dungeonId];
	removeFromGame(player, 'command', (c) => Boolean(c.isDungeon));
	delete player.activeDungeon;
	player.dungeonsCompletedCount = (player.dungeonsCompletedCount ?? 0) + 1;
	const names = (player.completedDungeonNames ??= []);
	if (!names.includes(spec.name)) names.push(spec.name);
	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'DungeonCompleted',
		playerId: player.playerId,
		dungeonId: active.dungeonId,
		dungeonName: spec.name
	});
	pushP13Log(
		state,
		player.playerId,
		'sba',
		`${player.username} completed ${spec.name} (CR 309.7, 704.5t).`
	);
}

/**
 * CR 309.6 / CR 704.5t: A dungeon in the command zone on its bottommost room whose room ability is
 * no longer on the stack is removed from the game and completed as a state-based action.
 */
export function applyDungeonCompletionSba(state: GameState): boolean {
	let anyCompleted = false;
	for (const p of state.players) {
		if (p.lost || !p.activeDungeon) continue;
		const active = p.activeDungeon;
		const spec = DUNGEON_SPECS[active.dungeonId];
		const room = spec.rooms[active.roomIndex];
		if (!room || room.nextRooms.length > 0) continue;
		const roomStillOnStack = state.stack.some(
			(s) =>
				s.inherentTrigger?.kind === 'dungeonRoomAbility' &&
				s.inherentTrigger.playerId === p.playerId &&
				s.inherentTrigger.dungeonId === active.dungeonId &&
				s.inherentTrigger.roomIndex === active.roomIndex
		);
		if (!roomStillOnStack) {
			completePlayerDungeonImmediate(state, p);
			anyCompleted = true;
		}
	}
	return anyCompleted;
}

/**
 * CR 727.1–727.5: Gives `player` the initiative and immediately ventures into Undercity.
 */
export function executeTakeInitiative(
	state: GameState,
	player: PlayerGameState,
	answerKey = 'p13_initiative',
	ask?: P13StepAskFn
): 'DONE' | 'PAUSED' {
	if (player.lost) return 'DONE';
	const alreadyInitialized = state.initiativePlayerId === player.playerId && answerKey !== 'p13_initiative_fresh';
	state.initiativePlayerId = player.playerId;
	noteLayerInputsChanged(state);
	if (!alreadyInitialized || !state.pendingPrompts.length) {
		emitEvent(state, {
			kind: 'TookInitiative',
			playerId: player.playerId
		});
		pushP13Log(
			state,
			player.playerId,
			'rule',
			`${player.username} takes the initiative (CR 727.2)!`
		);
	}
	return executeVentureIntoDungeon(state, player, 'undercity', `${answerKey}:venture`, ask);
}

/**
 * CR 727.2: Inherent trigger at the beginning of the upkeep of the player who has the initiative.
 */
export function pushInitiativeUpkeepTrigger(state: GameState, activePlayer: PlayerGameState): boolean {
	if (!state.initiativePlayerId || state.initiativePlayerId !== activePlayer.playerId || activePlayer.lost) {
		return false;
	}
	const card = buildEmblemScryfallCard(
		`init_upkeep_${state.turnNumber}`,
		'The Initiative',
		['At the beginning of your upkeep, venture into Undercity.']
	);
	state.stack.push(
		withStackItemText(
			{
				id: uid('stk', state),
				sourceInstanceId: `initiative_${activePlayer.playerId}`,
				card,
				ownerId: activePlayer.playerId,
				controllerId: activePlayer.playerId,
				kind: 'triggered',
				title: 'The Initiative — Venture into Undercity',
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: Date.now(),
				inherentTrigger: {
					kind: 'initiativeUpkeepVenture',
					playerId: activePlayer.playerId
				}
			},
			'Venture into Undercity.'
		)
	);
	return true;
}

/**
 * CR 727.2: Inherent trigger when one or more creatures deal combat damage to the player who has
 * the initiative.
 */
export function pushInitiativeCombatDamageTrigger(
	state: GameState,
	damagedPlayerId: string,
	attackerControllerId: string
): boolean {
	if (
		!state.initiativePlayerId ||
		state.initiativePlayerId !== damagedPlayerId ||
		attackerControllerId === damagedPlayerId
	) {
		return false;
	}
	const newHolder = state.players.find((p) => p.playerId === attackerControllerId && !p.lost);
	if (!newHolder) return false;
	const card = buildEmblemScryfallCard(
		`init_combat_${state.turnNumber}`,
		'The Initiative',
		['Whenever one or more creatures a player controls deal combat damage to you, that player takes the initiative.']
	);
	state.stack.push(
		withStackItemText(
			{
				id: uid('stk', state),
				sourceInstanceId: `initiative_combat_${newHolder.playerId}`,
				card,
				ownerId: newHolder.playerId,
				controllerId: newHolder.playerId,
				kind: 'triggered',
				title: 'The Initiative — Take the Initiative',
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: Date.now(),
				inherentTrigger: {
					kind: 'initiativeCombatDamage',
					newInitiativePlayerId: newHolder.playerId
				}
			},
			'Take the initiative.'
		)
	);
	return true;
}

/**
 * CR 727.4: If the player who has the initiative leaves the game, the active player takes the
 * initiative (or if the active player is also leaving, the next player in turn order).
 */
export function handleInitiativePlayerEliminated(
	state: GameState,
	eliminatedPlayerId: string
): void {
	if (state.initiativePlayerId !== eliminatedPlayerId) return;
	const active = state.players[state.activePlayerIndex];
	if (active && !active.lost && active.playerId !== eliminatedPlayerId) {
		executeTakeInitiative(state, active, 'p13_initiative_fresh');
		return;
	}
	const n = state.players.length;
	for (let step = 1; step <= n; step++) {
		const cand = state.players[(state.activePlayerIndex + step) % n];
		if (cand && !cand.lost && cand.playerId !== eliminatedPlayerId) {
			executeTakeInitiative(state, cand, 'p13_initiative_fresh');
			return;
		}
	}
	state.initiativePlayerId = null;
	noteLayerInputsChanged(state);
}

// ---- 9. The Ring Tempts You (CR 701.54) -----------------------------------------------------

export function executeTemptWithRing(
	state: GameState,
	actor: PlayerGameState,
	answerKey = 'p13_ring',
	ask?: P13StepAskFn
): 'DONE' | 'PAUSED' {
	if (actor.lost) return 'DONE';
	const creatures = actor.battlefield.filter(
		(p) => !p.phasedOut && evaluatePermanent(state, p).isCreature
	);

	// Check if waiting on human Ring-bearer choice after already bumping ringLevel?
	// Only bump ringLevel on the initial entry (before answer exists in `ask`)!
	if (!actor.isBot && creatures.length >= 2 && ask) {
		const ans = ask(
			actor,
			answerKey,
			{
				kind: 'chooseObjects',
				candidates: creatures.map((c) => c.instanceId),
				defaultObjectIds: [creatures[0].instanceId],
				min: 1,
				max: 1,
				zone: 'battlefield',
				reason: 'The Ring tempts you — choose a creature you control to become your Ring-bearer (CR 701.54a).'
			},
			'Choose Your Ring-bearer',
			'Choose a creature you control to become your Ring-bearer:'
		);
		if (ans === 'PAUSED') return 'PAUSED';
		const chosenId = ans.kind === 'chooseObjects' ? ans.objectIds[0] : undefined;
		const chosen = creatures.find((c) => c.instanceId === chosenId) ?? creatures[0];
		finalizeRingTemptation(state, actor, chosen.instanceId);
		return 'DONE';
	}

	let chosenBearerId: string | null = null;
	if (creatures.length === 1) {
		chosenBearerId = creatures[0].instanceId;
	} else if (creatures.length >= 2) {
		// Bot heuristic (CR 701.54c): lowest power maximizes Level 1 skulk-style evasion
		let best = creatures[0];
		let bestPow = evaluatePermanent(state, best).power;
		for (let i = 1; i < creatures.length; i++) {
			const pow = evaluatePermanent(state, creatures[i]).power;
			if (pow < bestPow) {
				best = creatures[i];
				bestPow = pow;
			}
		}
		chosenBearerId = best.instanceId;
	}
	finalizeRingTemptation(state, actor, chosenBearerId);
	return 'DONE';
}

function finalizeRingTemptation(
	state: GameState,
	actor: PlayerGameState,
	chosenBearerId: string | null
): void {
	const nextLevel = Math.min(4, (actor.ringLevel ?? 0) + 1);
	actor.ringLevel = nextLevel;
	if (chosenBearerId) {
		actor.ringBearerId = chosenBearerId;
	} else if (
		actor.ringBearerId &&
		!actor.battlefield.some(
			(p) =>
				!p.phasedOut &&
				p.instanceId === actor.ringBearerId &&
				evaluatePermanent(state, p).isCreature
		)
	) {
		actor.ringBearerId = null;
	}

	const existingRing = actor.command.find((c) => c.isRingEmblem);
	if (existingRing) {
		existingRing.card = buildRingEmblemScryfallCard(existingRing.instanceId, nextLevel);
	} else {
		const ringId = uid('ring', state);
		const ringInst: CardInstance = {
			instanceId: ringId,
			card: buildRingEmblemScryfallCard(ringId, nextLevel),
			ownerId: actor.playerId,
			controllerId: actor.playerId,
			zone: 'command',
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
			transformed: false,
			enteredTimestamp: allocateTimestamp(state),
			objectVersion: 1,
			isEmblem: true,
			isRingEmblem: true
		};
		putIntoCommandZone(state, actor, ringInst);
	}

	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'RingTempted',
		playerId: actor.playerId,
		ringLevel: nextLevel,
		ringBearerId: actor.ringBearerId ?? null
	});
	pushP13Log(
		state,
		actor.playerId,
		'rule',
		`The Ring tempts ${actor.username} (level ${nextLevel}${actor.ringBearerId ? `, Ring-bearer chosen` : ''}, CR 701.54).`
	);
}

/**
 * CR 701.54c Level 1: Your Ring-bearer can't be blocked by creatures with greater power.
 * Returns a restriction reason string if `blocker` cannot block `attacker` due to Ring Level 1.
 */
export function getRingBearerBlockRestriction(
	state: GameState,
	blocker: CardInstance,
	attacker: CardInstance
): string | null {
	const evAtt = evaluatePermanent(state, attacker);
	const attCtrl = state.players.find((p) => p.playerId === evAtt.controllerId && !p.lost);
	if (!attCtrl || (attCtrl.ringLevel ?? 0) < 1 || attCtrl.ringBearerId !== attacker.instanceId) {
		return null;
	}
	const evBlk = evaluatePermanent(state, blocker);
	if (evBlk.power > evAtt.power) {
		return `${evAtt.effectiveName} is a Ring-bearer and can't be blocked by creatures with greater power (CR 701.54c).`;
	}
	return null;
}

export function pushRingAttackTriggers(
	state: GameState,
	attackingPlayer: PlayerGameState,
	attackerIds: readonly string[]
): void {
	if ((attackingPlayer.ringLevel ?? 0) < 2 || !attackingPlayer.ringBearerId) return;
	if (!attackerIds.includes(attackingPlayer.ringBearerId)) return;
	const ringEmblem = attackingPlayer.command.find((c) => c.isRingEmblem);
	const card =
		ringEmblem?.card ?? buildRingEmblemScryfallCard(`ring_${attackingPlayer.playerId}`, attackingPlayer.ringLevel ?? 2);
	state.stack.push(
		withStackItemText(
			{
				id: uid('stk', state),
				sourceInstanceId: ringEmblem?.instanceId ?? `ring_${attackingPlayer.playerId}`,
				card,
				ownerId: attackingPlayer.playerId,
				controllerId: attackingPlayer.playerId,
				kind: 'triggered',
				title: 'The Ring (Level 2) — Draw, then Discard',
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: Date.now(),
				inherentTrigger: {
					kind: 'ringLevel2AttackLoot',
					playerId: attackingPlayer.playerId
				}
			},
			'Draw a card, then discard a card.'
		)
	);
}

export function registerRingBlockedEndOfCombatSacrifice(
	state: GameState,
	assignments: ReadonlyArray<{ blockerInstanceId: string; attackerInstanceId: string }>
): void {
	for (const { blockerInstanceId, attackerInstanceId } of assignments) {
		let attacker: CardInstance | undefined;
		let blocker: CardInstance | undefined;
		for (const p of state.players) {
			if (p.lost) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				if (perm.instanceId === attackerInstanceId) attacker = perm;
				if (perm.instanceId === blockerInstanceId) blocker = perm;
			}
		}
		if (!attacker || !blocker) continue;
		const attCtrlId = evaluatePermanent(state, attacker).controllerId;
		const attCtrl = state.players.find((p) => p.playerId === attCtrlId && !p.lost);
		if (!attCtrl || (attCtrl.ringLevel ?? 0) < 3 || attCtrl.ringBearerId !== attacker.instanceId) {
			continue;
		}
		const list = (blocker.ringBlockedForPlayerIds ??= []);
		if (!list.includes(attCtrl.playerId)) {
			list.push(attCtrl.playerId);
		}
	}
}

export function pushRingEndOfCombatTriggers(state: GameState): boolean {
	let pushed = false;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const blocker of p.battlefield) {
			if (blocker.phasedOut || !blocker.ringBlockedForPlayerIds?.length) continue;
			const ringOwnerIds = [...blocker.ringBlockedForPlayerIds];
			delete blocker.ringBlockedForPlayerIds;
			const blkCtrlId = evaluatePermanent(state, blocker).controllerId;
			for (const ringOwnerId of ringOwnerIds) {
				const ringOwner = state.players.find((pl) => pl.playerId === ringOwnerId && !pl.lost);
				if (!ringOwner) continue;
				const ringEmblem = ringOwner.command.find((c) => c.isRingEmblem);
				const card =
					ringEmblem?.card ??
					buildRingEmblemScryfallCard(`ring_${ringOwner.playerId}`, ringOwner.ringLevel ?? 3);
				state.stack.push(
					withStackItemText(
						{
							id: uid('stk', state),
							sourceInstanceId: ringEmblem?.instanceId ?? `ring_${ringOwner.playerId}`,
							card,
							ownerId: ringOwner.playerId,
							controllerId: ringOwner.playerId,
							kind: 'triggered',
							title: 'The Ring (Level 3) — Sacrifice Blocker',
							targets: [],
							xValue: 0,
							requiresGuidedResolution: false,
							createdAt: Date.now(),
							inherentTrigger: {
								kind: 'ringLevel3BlockedSacrifice',
								blockerId: blocker.instanceId,
								blockerObjectVersion: blocker.objectVersion ?? 1,
								blockerControllerId: blkCtrlId
							}
						},
						"That creature's controller sacrifices it."
					)
				);
				pushed = true;
			}
		}
	}
	return pushed;
}

export function pushRingCombatDamageTriggers(
	state: GameState,
	sourcePerm: CardInstance
): boolean {
	const ev = evaluatePermanent(state, sourcePerm);
	const ctrl = state.players.find((p) => p.playerId === ev.controllerId && !p.lost);
	if (!ctrl || (ctrl.ringLevel ?? 0) < 4 || ctrl.ringBearerId !== sourcePerm.instanceId) {
		return false;
	}
	const ringEmblem = ctrl.command.find((c) => c.isRingEmblem);
	const card =
		ringEmblem?.card ?? buildRingEmblemScryfallCard(`ring_${ctrl.playerId}`, 4);
	state.stack.push(
		withStackItemText(
			{
				id: uid('stk', state),
				sourceInstanceId: ringEmblem?.instanceId ?? `ring_${ctrl.playerId}`,
				card,
				ownerId: ctrl.playerId,
				controllerId: ctrl.playerId,
				kind: 'triggered',
				title: 'The Ring (Level 4) — Opponents Lose 3 Life',
				targets: [],
				xValue: 0,
				requiresGuidedResolution: false,
				createdAt: Date.now(),
				inherentTrigger: {
					kind: 'ringLevel4DamageLifeLoss',
					playerId: ctrl.playerId
				}
			},
			'Each opponent loses 3 life.'
		)
	);
	return true;
}

// ---- 10. Earthbend (CR 701.66), Airbend (CR 701.65), Learn (CR 701.48), Villainous, Vote ----

export function executeEarthbend(
	state: GameState,
	actor: PlayerGameState,
	sourceName: string,
	targets: readonly CardInstance[],
	n: number
): void {
	const countersCount = Math.max(0, Math.trunc(n));
	for (const land of targets) {
		if (land.zone !== 'battlefield' || land.phasedOut) continue;
		const eff: TimedContinuousEffect = {
			timestamp: allocateTimestamp(state),
			sourceName,
			controllerId: actor.playerId,
			affected: [{ instanceId: land.instanceId, objectVersion: land.objectVersion ?? 1 }],
			expires: 'never',
			layer4: { addTypes: ['Creature'] },
			layer6: { addKeywords: ['Haste'] },
			layer7b: { setPower: 0, setToughness: 0 }
		};
		(state.timedContinuousEffects ??= []).push(eff);
		land.earthbentReturn = true;
		if (countersCount > 0) {
			placeRegisteredCounters(state, land, '+1/+1', countersCount);
		}
		noteLayerInputsChanged(state);
		pushP13Log(
			state,
			actor.playerId,
			'rule',
			`${actor.username} earthbent ${land.card.name} (${countersCount} +1/+1 counter(s), CR 701.66a).`
		);
	}
}

export function executeAirbend(
	state: GameState,
	actor: PlayerGameState,
	targetPermOrNull: CardInstance | null,
	targetStackSpellOrNull: StackItem | null
): void {
	if (targetPermOrNull && targetPermOrNull.zone === 'battlefield' && !targetPermOrNull.phasedOut) {
		let holder: PlayerGameState | undefined;
		for (const p of state.players) {
			if (p.battlefield.some((b) => b.instanceId === targetPermOrNull.instanceId)) {
				holder = p;
				break;
			}
		}
		if (!holder) return;
		const dest = moveObject(state, targetPermOrNull, 'exile', {
			from: { player: holder, zone: 'battlefield' },
			detachAttachments: true,
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true,
			ceaseToExist: 'tokens'
		});
		if (dest === 'exile' && !targetPermOrNull.isToken) {
			targetPermOrNull.airbentCastPermission = { playerId: targetPermOrNull.ownerId };
		}
		pushP13Log(
			state,
			actor.playerId,
			'rule',
			`${actor.username} airbent ${targetPermOrNull.card.name} (CR 701.65a).`
		);
		return;
	}

	if (targetStackSpellOrNull && targetStackSpellOrNull.kind === 'spell') {
		const idx = state.stack.findIndex((s) => s.id === targetStackSpellOrNull.id);
		if (idx < 0) return;
		state.stack.splice(idx, 1);
		if (targetStackSpellOrNull.isCopy) return;
		const owner = state.players.find((p) => p.playerId === (targetStackSpellOrNull.ownerId ?? targetStackSpellOrNull.controllerId));
		if (!owner) return;
		const cardInst: CardInstance = {
			instanceId: targetStackSpellOrNull.sourceInstanceId,
			card: targetStackSpellOrNull.card,
			ownerId: owner.playerId,
			controllerId: owner.playerId,
			zone: 'exile',
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
			isCommander: Boolean(owner.commanderNames[targetStackSpellOrNull.sourceInstanceId]),
			commanderCastCount: owner.commanderCastCounts[targetStackSpellOrNull.sourceInstanceId] ?? 0,
			usedLoyaltyThisTurn: false,
			transformed: false,
			enteredTimestamp: allocateTimestamp(state),
			objectVersion: (targetStackSpellOrNull.sourceObjectVersion ?? 1) + 1
		};
		const dest = moveObject(state, cardInst, 'exile', {
			from: 'stack',
			toPlayer: owner,
			newTimestamp: true
		});
		if (dest === 'exile') {
			cardInst.airbentCastPermission = { playerId: owner.playerId };
		}
		pushP13Log(
			state,
			actor.playerId,
			'rule',
			`${actor.username} airbent spell ${targetStackSpellOrNull.card.name} (CR 701.65a).`
		);
	}
}

export function executeLearn(
	state: GameState,
	actor: PlayerGameState,
	answerKey: string,
	ask: P13StepAskFn,
	drawCardsFn: (player: PlayerGameState, count: number) => void
): 'DONE' | 'PAUSED' {
	if (actor.lost || actor.hand.length === 0) return 'DONE';
	if (actor.isBot) {
		if (actor.hand.length >= 4) {
			const toDiscard = actor.hand[actor.hand.length - 1];
			moveObject(state, toDiscard, 'graveyard', {
				from: { player: actor, zone: 'hand' },
				bumpVersion: true,
				newTimestamp: true,
				graveyardReplacement: true,
				discardReason: 'discard',
				discardPlayerId: actor.playerId
			});
			drawCardsFn(actor, 1);
		}
		return 'DONE';
	}
	const ans = ask(
		actor,
		answerKey,
		{
			kind: 'chooseObjects',
			candidates: actor.hand.map((c) => c.instanceId),
			min: 0,
			max: 1,
			zone: 'hand',
			reason: 'Learn (CR 701.48a): You may discard a card. If you do, draw a card.'
		},
		'Learn — Discard to Draw?',
		'Choose up to one card from your hand to discard and draw a card (or submit 0 to skip):'
	);
	if (ans === 'PAUSED') return 'PAUSED';
	const chosenId = ans.kind === 'chooseObjects' ? ans.objectIds[0] : undefined;
	const card = chosenId ? actor.hand.find((c) => c.instanceId === chosenId) : undefined;
	if (card) {
		moveObject(state, card, 'graveyard', {
			from: { player: actor, zone: 'hand' },
			bumpVersion: true,
			newTimestamp: true,
			graveyardReplacement: true,
			discardReason: 'discard',
			discardPlayerId: actor.playerId
		});
		drawCardsFn(actor, 1);
	}
	return 'DONE';
}

export function executeVillainousChoice(
	opponents: readonly PlayerGameState[],
	labels: [string, string],
	options: [EffectStep[], EffectStep[]],
	baseAnswerKey: string,
	ask: P13StepAskFn,
	runInlineSteps: (steps: EffectStep[], facingOpponent: PlayerGameState) => boolean
): 'DONE' | 'PAUSED' {
	for (let i = 0; i < opponents.length; i++) {
		const opp = opponents[i];
		if (opp.lost) continue;
		let chosenBranch = 0;
		if (opp.isBot) {
			// Deterministic bot heuristic: avoid branch that draws cards or creates tokens for actor if other branch loses life (when life > 10)
			const b0Harm = scoreVillainousBranchHarm(options[0], opp);
			const b1Harm = scoreVillainousBranchHarm(options[1], opp);
			chosenBranch = b1Harm < b0Harm ? 1 : 0;
		} else {
			const ans = ask(
				opp,
				`${baseAnswerKey}:${opp.playerId}:${i}`,
				{ kind: 'chooseMode', modes: labels, min: 1, max: 1 },
				'Face a Villainous Choice (CR 701.55)',
				`${opp.username} faces a villainous choice:`
			);
			if (ans === 'PAUSED') return 'PAUSED';
			chosenBranch = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
		}
		const steps = options[chosenBranch === 1 ? 1 : 0];
		if (!runInlineSteps(steps, opp)) {
			return 'PAUSED';
		}
	}
	return 'DONE';
}

function scoreVillainousBranchHarm(steps: readonly EffectStep[], opp: PlayerGameState): number {
	let score = 0;
	for (const st of steps) {
		if (st.verb === 'draw') score += 30;
		else if (st.verb === 'createToken') score += 25;
		else if (st.verb === 'sacrifice' || st.verb === 'destroy' || st.verb === 'exile') score += 35;
		else if (st.verb === 'loseLife' || st.verb === 'damage') {
			score += opp.life <= 10 ? 50 : 15;
		} else {
			score += 20;
		}
	}
	return score;
}

export function executeCouncilVote(
	state: GameState,
	actor: PlayerGameState,
	spec: VoteSpec,
	baseAnswerKey: string,
	ask: P13StepAskFn,
	runInlineSteps: (steps: EffectStep[]) => boolean
): 'DONE' | 'PAUSED' {
	if (spec.options.length === 0) return 'DONE';
	const n = state.players.length;
	const actorIdx = state.players.findIndex((p) => p.playerId === actor.playerId);
	const startIdx = actorIdx >= 0 ? actorIdx : state.activePlayerIndex;
	const orderedVoters: PlayerGameState[] = [];
	for (let step = 0; step < n; step++) {
		const pl = state.players[(startIdx + step) % n];
		if (pl && !pl.lost) orderedVoters.push(pl);
	}

	const tallies = spec.options.map(() => 0);
	for (const voter of orderedVoters) {
		const voteCount =
			voter.playerId === actor.playerId ? 1 + Math.max(0, spec.extraVotesForActor ?? 0) : 1;
		for (let v = 0; v < voteCount; v++) {
			let pick = 0;
			if (voter.isBot) {
				pick = voter.playerId === actor.playerId ? 0 : Math.min(1, spec.options.length - 1);
			} else {
				const ans = ask(
					voter,
					`${baseAnswerKey}:${voter.playerId}:${v}`,
					{ kind: 'chooseMode', modes: spec.options, min: 1, max: 1 },
					`Vote (${v + 1} of ${voteCount})`,
					`${voter.username}, choose a vote option (CR 701.38):`
				);
				if (ans === 'PAUSED') return 'PAUSED';
				pick = ans.kind === 'chooseMode' ? (ans.indices[0] ?? 0) : 0;
			}
			const clamped = Math.max(0, Math.min(spec.options.length - 1, pick));
			tallies[clamped] += 1;
		}
	}

	const summary = spec.options.map((opt, idx) => `${opt}: ${tallies[idx]}`).join(', ');
	pushP13Log(state, actor.playerId, 'rule', `Vote results (CR 701.38): ${summary}.`);
	// --- Track P22b ---
	emitEvent(state, { kind: 'PlayersFinishedVoting', controllerId: actor.playerId });
	// --- End Track P22b ---

	if (spec.perOptionEffect) {
		for (let optIdx = 0; optIdx < spec.options.length; optIdx++) {
			const steps = spec.perOptionEffect[optIdx];
			if (!steps?.length) continue;
			for (let k = 0; k < tallies[optIdx]; k++) {
				if (!runInlineSteps(steps)) return 'PAUSED';
			}
		}
	}

	if (spec.perWinningEffect) {
		const maxVotes = Math.max(...tallies);
		if (maxVotes > 0) {
			for (let optIdx = 0; optIdx < spec.options.length; optIdx++) {
				const steps = spec.perWinningEffect[optIdx];
				if (tallies[optIdx] === maxVotes && steps?.length) {
					if (!runInlineSteps(steps)) return 'PAUSED';
				}
			}
		}
	}

	return 'DONE';
}

// ---- 11. Inherent Trigger Resolution Helper -------------------------------------------------

export interface P13InherentResolutionHelpers {
	drawCards: (player: PlayerGameState, count: number) => void;
	gainLife: (state: GameState, player: PlayerGameState, amount: number) => number;
	loseLife: (state: GameState, player: PlayerGameState, amount: number) => number;
	scry: (player: PlayerGameState, count: number, sourceTitle: string) => void;
	goadPermanent: (perm: CardInstance, goaderId: string) => void;
	createSimpleToken: (
		player: PlayerGameState,
		spec: {
			name: string;
			power: number;
			toughness: number;
			colors: ManaColor[];
			typeLine: string;
			keywords: string[];
		},
		count?: number
	) => void;
	searchBasicLandToHand: (player: PlayerGameState) => void;
}

export function resolveP13InherentTrigger(
	state: GameState,
	item: StackItem,
	helpers: P13InherentResolutionHelpers
): boolean {
	const inh = item.inherentTrigger;
	if (!inh) return false;

	switch (inh.kind) {
		case 'initiativeUpkeepVenture': {
			const pl = state.players.find((p) => p.playerId === inh.playerId && !p.lost);
			if (pl) executeVentureIntoDungeon(state, pl, 'undercity');
			return true;
		}
		case 'initiativeCombatDamage': {
			const pl = state.players.find((p) => p.playerId === inh.newInitiativePlayerId && !p.lost);
			if (pl) executeTakeInitiative(state, pl);
			return true;
		}
		case 'ringLevel2AttackLoot': {
			const pl = state.players.find((p) => p.playerId === inh.playerId && !p.lost);
			if (!pl) return true;
			helpers.drawCards(pl, 1);
			if (pl.hand.length > 0) {
				if (pl.isBot) {
					const disc = pl.hand[pl.hand.length - 1];
					moveObject(state, disc, 'graveyard', {
						from: { player: pl, zone: 'hand' },
						bumpVersion: true,
						newTimestamp: true,
						graveyardReplacement: true,
						discardReason: 'discard',
						discardPlayerId: pl.playerId
					});
				} else {
					enqueueChoicePrompt(state, {
						id: uid('prm', state),
						playerId: pl.playerId,
						kind: 'chooseObjects',
						purpose: 'generic',
						title: 'The Ring (Level 2) — Discard a Card',
						description: 'Choose a card in your hand to discard:',
						continuation: {
							kind: 'handler',
							name: 'p13_ring_loot_discard',
							data: { playerId: pl.playerId }
						},
						choice: {
							kind: 'chooseObjects',
							candidates: pl.hand.map((c) => c.instanceId),
							defaultObjectIds: [pl.hand[0].instanceId],
							min: 1,
							max: 1,
							zone: 'hand',
							reason: 'Discard a card for The Ring (Level 2).'
						}
					});
				}
			}
			return true;
		}
		case 'ringLevel3BlockedSacrifice': {
			const ctrl = state.players.find((p) => p.playerId === inh.blockerControllerId && !p.lost);
			if (!ctrl) return true;
			const blocker = ctrl.battlefield.find(
				(b) =>
					!b.phasedOut &&
					b.instanceId === inh.blockerId &&
					(b.objectVersion ?? 1) === inh.blockerObjectVersion
			);
			if (blocker) {
				moveObject(state, blocker, 'graveyard', {
					from: { player: ctrl, zone: 'battlefield' },
					detachAttachments: true,
					leaveBattlefieldReset: true,
					bumpVersion: true,
					newTimestamp: true,
					graveyardReplacement: true,
					ceaseToExist: 'tokens',
					sacrificedByPlayerId: ctrl.playerId
				});
			}
			return true;
		}
		case 'ringLevel4DamageLifeLoss': {
			for (const opp of state.players) {
				if (opp.lost || opp.playerId === inh.playerId) continue;
				helpers.loseLife(state, opp, 3);
			}
			return true;
		}
		case 'earthbendDelayedReturn': {
			const owner = state.players.find((p) => p.playerId === inh.ownerId && !p.lost);
			const ctrl = state.players.find((p) => p.playerId === item.controllerId && !p.lost);
			if (!owner || !ctrl) return true;
			const zoneArr = owner[inh.fromZone];
			const card = zoneArr.find(
				(c) => c.instanceId === inh.cardId && (c.objectVersion ?? 1) === inh.cardObjectVersion
			);
			if (card && !card.isToken) {
				moveObject(state, card, 'battlefield', {
					from: { player: owner, zone: inh.fromZone },
					toPlayer: ctrl,
					controllerId: ctrl.playerId,
					bumpVersion: true,
					newTimestamp: true,
					beforeInsert: (returned, d) => {
						if (d === 'battlefield') {
							returned.tapped = true;
							returned.summoningSick = true;
						}
					}
				});
			}
			return true;
		}
		case 'dungeonRoomAbility': {
			const pl = state.players.find((p) => p.playerId === inh.playerId && !p.lost);
			if (!pl) return true;
			resolveDungeonRoomEffect(state, pl, inh.dungeonId, inh.roomIndex, item.targets, helpers);
			return true;
		}
		default:
			return false;
	}
}

registerPromptHandler('p13_ring_loot_discard', (state, prompt, answer) => {
	if (answer.kind !== 'chooseObjects') return;
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data || typeof data.playerId !== 'string') return;
	const pl = state.players.find((p) => p.playerId === data.playerId && !p.lost);
	if (!pl || pl.hand.length === 0) return;
	const chosenId = answer.objectIds[0];
	const card = (chosenId ? pl.hand.find((c) => c.instanceId === chosenId) : undefined) ?? pl.hand[0];
	moveObject(state, card, 'graveyard', {
		from: { player: pl, zone: 'hand' },
		bumpVersion: true,
		newTimestamp: true,
		graveyardReplacement: true,
		discardReason: 'discard',
		discardPlayerId: pl.playerId
	});
});

function findTargetPermOnBattlefield(state: GameState, targets: readonly TargetRef[]): CardInstance | undefined {
	const id = targets[0]?.id;
	if (!id) return undefined;
	for (const p of state.players) {
		if (p.lost) continue;
		const perm = p.battlefield.find((b) => !b.phasedOut && b.instanceId === id);
		if (perm) return perm;
	}
	return undefined;
}

function resolveDungeonRoomEffect(
	state: GameState,
	pl: PlayerGameState,
	dungeonId: DungeonId,
	roomIndex: number,
	targets: readonly TargetRef[],
	helpers: P13InherentResolutionHelpers
): void {
	const spec = DUNGEON_SPECS[dungeonId];
	const room = spec.rooms[roomIndex];
	if (!room) return;

	if (dungeonId === 'lost_mine') {
		switch (roomIndex) {
			case 0: // Cave Entrance: Scry 1.
				helpers.scry(pl, 1, `${spec.name} — ${room.name}`);
				return;
			case 1: // Goblin Lair: Create a 1/1 red Goblin creature token.
				helpers.createSimpleToken(pl, {
					name: 'Goblin',
					power: 1,
					toughness: 1,
					colors: ['R'],
					typeLine: 'Token Creature — Goblin',
					keywords: []
				});
				return;
			case 2: // Mine Tunnels: Create a Treasure token.
				helpers.createSimpleToken(pl, {
					name: 'Treasure',
					power: 0,
					toughness: 0,
					colors: [],
					typeLine: 'Token Artifact — Treasure',
					keywords: []
				});
				return;
			case 3: { // Storeroom: Put a +1/+1 counter on target creature.
				const perm = findTargetPermOnBattlefield(state, targets);
				if (perm) placeRegisteredCounters(state, perm, '+1/+1', 1);
				return;
			}
			case 4: { // Dark Pool: Each opponent loses 1 life and you gain 1 life.
				for (const opp of state.players) {
					if (!opp.lost && opp.playerId !== pl.playerId) helpers.loseLife(state, opp, 1);
				}
				helpers.gainLife(state, pl, 1);
				return;
			}
			case 5: { // Fungi Cavern: Target creature gets -4/-0 until your next turn.
				const perm = findTargetPermOnBattlefield(state, targets);
				if (perm) {
					(state.timedContinuousEffects ??= []).push({
						timestamp: allocateTimestamp(state),
						sourceName: `${spec.name} — ${room.name}`,
						controllerId: pl.playerId,
						affected: [{ instanceId: perm.instanceId, objectVersion: perm.objectVersion ?? 1 }],
						...buildDurationExpiryFields(state, 'untilYourNextTurn', pl.playerId),
						layer7c: { power: -4, toughness: 0 }
					});
					noteLayerInputsChanged(state);
				}
				return;
			}
			case 6: // Temple of Dumathoin: Draw a card.
				helpers.drawCards(pl, 1);
				return;
		}
	} else if (dungeonId === 'mad_mage') {
		switch (roomIndex) {
			case 0: // Yawning Portal: You gain 1 life.
				helpers.gainLife(state, pl, 1);
				return;
			case 1: // Dungeon Level: Scry 1.
				helpers.scry(pl, 1, `${spec.name} — ${room.name}`);
				return;
			case 2: // Goblin Bazaar: Create a Treasure token.
				helpers.createSimpleToken(pl, {
					name: 'Treasure',
					power: 0,
					toughness: 0,
					colors: [],
					typeLine: 'Token Artifact — Treasure',
					keywords: []
				});
				return;
			case 3: { // Twisted Caverns: Target creature can't attack until your next turn.
				const perm = findTargetPermOnBattlefield(state, targets);
				if (perm) {
					(perm.detainedByPlayerIds ??= []).push(pl.playerId);
					noteLayerInputsChanged(state);
				}
				return;
			}
			case 4: // Lost Level: Scry 2.
				helpers.scry(pl, 2, `${spec.name} — ${room.name}`);
				return;
			case 5: { // Runestone Caverns: Exile top 2 cards of library. You may play them this turn.
				const topTwo = pl.library.slice(0, 2);
				for (const card of topTwo) {
					const dest = moveObject(state, card, 'exile', {
						from: { player: pl, zone: 'library' },
						toPlayer: pl,
						bumpVersion: true,
						newTimestamp: true
					});
					if (dest === 'exile') {
						card.playableFromExileBy = {
							playerId: pl.playerId,
							spendManaAsAnyColor: false,
							sourceName: `${spec.name} — ${room.name}`,
							expiresAtEndOfTurn: true,
							duration: 'thisTurn'
						};
					}
				}
				return;
			}
			case 6: // Muiral's Graveyard: Create two 1/1 black Skeleton creature tokens.
				helpers.createSimpleToken(
					pl,
					{
						name: 'Skeleton',
						power: 1,
						toughness: 1,
						colors: ['B'],
						typeLine: 'Token Creature — Skeleton',
						keywords: []
					},
					2
				);
				return;
			case 7: // Deep Mines: Scry 3.
				helpers.scry(pl, 3, `${spec.name} — ${room.name}`);
				return;
			case 8: // Mad Wizard's Lair: Draw three cards.
				helpers.drawCards(pl, 3);
				return;
		}
	} else if (dungeonId === 'tomb') {
		switch (roomIndex) {
			case 0: // Trapped Entry: Each player loses 1 life.
				for (const p of state.players) {
					if (!p.lost) helpers.loseLife(state, p, 1);
				}
				return;
			case 1: // Veils of Fear: Each player loses 2 life unless they discard a card.
				for (const p of state.players) {
					if (p.lost) continue;
					if (p.hand.length > 0 && p.life <= 6) {
						const disc = p.hand[p.hand.length - 1];
						moveObject(state, disc, 'graveyard', {
							from: { player: p, zone: 'hand' },
							bumpVersion: true,
							newTimestamp: true,
							graveyardReplacement: true,
							discardReason: 'discard',
							discardPlayerId: p.playerId
						});
					} else {
						helpers.loseLife(state, p, 2);
					}
				}
				return;
			case 2: { // Oubliette: Discard a card and sacrifice a creature, an artifact, and a land.
				if (pl.hand.length > 0) {
					moveObject(state, pl.hand[pl.hand.length - 1], 'graveyard', {
						from: { player: pl, zone: 'hand' },
						bumpVersion: true,
						newTimestamp: true,
						graveyardReplacement: true,
						discardReason: 'discard',
						discardPlayerId: pl.playerId
					});
				}
				for (const reqType of ['Creature', 'Artifact', 'Land'] as const) {
					const cand = pl.battlefield.find((b) => {
						if (b.phasedOut) return false;
						const ev = evaluatePermanent(state, b);
						return reqType === 'Creature'
							? ev.isCreature
							: reqType === 'Artifact'
								? ev.isArtifact
								: ev.isLand;
					});
					if (cand) {
						moveObject(state, cand, 'graveyard', {
							from: { player: pl, zone: 'battlefield' },
							detachAttachments: true,
							leaveBattlefieldReset: true,
							bumpVersion: true,
							newTimestamp: true,
							graveyardReplacement: true,
							ceaseToExist: 'tokens',
							sacrificedByPlayerId: pl.playerId
						});
					}
				}
				return;
			}
			case 3: // Sandfall Cell: Each player loses 2 life unless they sacrifice a creature, artifact, or land.
				for (const p of state.players) {
					if (p.lost) continue;
					const tokSac = p.battlefield.find((b) => {
						if (b.phasedOut || !b.isToken) return false;
						const ev = evaluatePermanent(state, b);
						return ev.isCreature || ev.isArtifact || ev.isLand;
					});
					if (tokSac && p.life <= 8) {
						moveObject(state, tokSac, 'graveyard', {
							from: { player: p, zone: 'battlefield' },
							detachAttachments: true,
							leaveBattlefieldReset: true,
							bumpVersion: true,
							newTimestamp: true,
							graveyardReplacement: true,
							ceaseToExist: 'tokens',
							sacrificedByPlayerId: p.playerId
						});
					} else {
						helpers.loseLife(state, p, 2);
					}
				}
				return;
			case 4: // Cradle of the Death God: Create The Atropal, a legendary 4/4 black God Horror token with deathtouch.
				helpers.createSimpleToken(pl, {
					name: 'The Atropal',
					power: 4,
					toughness: 4,
					colors: ['B'],
					typeLine: 'Token Legendary Creature — God Horror',
					keywords: ['Deathtouch']
				});
				return;
		}
	} else if (dungeonId === 'undercity') {
		switch (roomIndex) {
			case 0: // Secret Entrance: Search library for a basic land card, reveal it, put into hand, shuffle.
				helpers.searchBasicLandToHand(pl);
				return;
			case 1: { // Forge: Put two +1/+1 counters on target creature.
				const perm = findTargetPermOnBattlefield(state, targets);
				if (perm) placeRegisteredCounters(state, perm, '+1/+1', 2);
				return;
			}
			case 2: // Lost Well: Scry 2.
				helpers.scry(pl, 2, `${spec.name} — ${room.name}`);
				return;
			case 3: { // Trap!: Target player loses 5 life.
				const tgtId = targets[0]?.id;
				const tgt = state.players.find((p) => !p.lost && p.playerId === tgtId);
				if (tgt) helpers.loseLife(state, tgt, 5);
				return;
			}
			case 4: { // Arena: Goad target creature.
				const perm = findTargetPermOnBattlefield(state, targets);
				if (perm) helpers.goadPermanent(perm, pl.playerId);
				return;
			}
			case 5: // Stash: Create a Treasure token.
				helpers.createSimpleToken(pl, {
					name: 'Treasure',
					power: 0,
					toughness: 0,
					colors: [],
					typeLine: 'Token Artifact — Treasure',
					keywords: []
				});
				return;
			case 6: // Archives: Draw a card.
				helpers.drawCards(pl, 1);
				return;
			case 7: // Catacombs: Create a 4/1 black Skeleton creature token with menace.
				helpers.createSimpleToken(pl, {
					name: 'Skeleton',
					power: 4,
					toughness: 1,
					colors: ['B'],
					typeLine: 'Token Creature — Skeleton',
					keywords: ['Menace']
				});
				return;
			case 8: // Throne of the Dead Three: Draw a card.
				helpers.drawCards(pl, 1);
				return;
		}
	}
}

function pushP13Log(
	state: GameState,
	actorId: string,
	kind: 'rule' | 'trigger' | 'sba',
	text: string
): void {
	state.log.push({
		id: uid('log', state),
		timestamp: Date.now(),
		turn: state.turnNumber,
		phase: state.phase,
		actorId,
		kind,
		text
	});
	if (state.log.length > 160) {
		state.log.shift();
	}
}
