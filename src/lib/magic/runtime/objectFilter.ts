/**
 * Interprets IR ObjectFilters, Amounts and Conditions against the game state (Phase 4).
 *
 * Costs, mana abilities and cost modifiers need these; the Phase 3 effect interpreter needs the
 * same queries, so they live in one small module rather than inside runtime/costs.ts. Never reads
 * rules text or card names: an object's characteristics come from its type line (evaluated through
 * the layer system on the battlefield) and its counters/flags.
 */
import { compileCard } from '../compiler/index.ts';
import type { Amount, Compare, Condition, ObjectFilter } from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type { CardInstance, GameState, PlayerGameState, StackItem, ZoneType } from '../types.ts';
import { splitSubtypes } from './layers.ts';

export interface FilterContext {
	state: GameState;
	/** The player "you" refers to (the controller of the source). */
	controllerId: string;
	/** The source object; `other` excludes it and `{k:'self'}` refers to it. */
	source?: CardInstance;
	xValue?: number;
}

const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'] as const;
type PlayerZoneName = (typeof ZONES)[number];

const NON_CREATURE_SUBTYPES = new Set([
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Gate',
	'Locus',
	'Cave',
	'Desert',
	'Sphere',
	'Tower',
	'Mine',
	'Power-Plant',
	"Urza's",
	'Equipment',
	'Treasure',
	'Clue',
	'Food',
	'Blood',
	'Powerstone',
	'Map',
	'Junk',
	'Gold',
	'Fortification',
	'Vehicle',
	'Aura',
	'Saga',
	'Shrine',
	'Cartouche',
	'Curse',
	'Rune',
	'Shard',
	'Background',
	'Case',
	'Class',
	'Room',
	'Role',
	'Arcane',
	'Adventure',
	'Lesson',
	'Trap'
]);

/** Card types are the words before the dash; subtypes after it (preserving multi-word subtypes like "Time Lord", CR 205.3m). */
export function splitTypeLine(typeLine: string): { types: string[]; subtypes: string[] } {
	const [left, right = ''] = typeLine.split(/\s+[—-]\s+/);
	return {
		types: left.split(/\s+/).filter(Boolean),
		subtypes: splitSubtypes(right)
	};
}

/**
 * Power of an object (CR 107.1b, 208.2a, 208.3):
 * - On the battlefield: evaluated through the layer system; returns `null` for non-creatures (CR 208.3)
 *   and preserves negative values without clamping (CR 107.1b).
 * - In other zones: returns `null` for non-creature cards, evaluates Layer 7a CDAs in all zones (CR 208.2a),
 *   and adds counters/tempPowerMod without clamping.
 */
export function objectPower(state: GameState, obj: CardInstance): number | null {
	if (obj.zone === 'battlefield') {
		const ev = evaluatePermanent(state, obj);
		if (!ev.isCreature) return null;
		return ev.breakdown.effectivePower;
	}
	const card = obj.copiableCard ?? obj.card;
	const { types } = splitTypeLine(card.typeLine || '');
	if (!types.some((t) => t.toLowerCase() === 'creature') && card.power === undefined) {
		return null;
	}
	const raw = parseInt(card.power || '0', 10);
	let base = isNaN(raw) ? 0 : raw;
	const face = compileCard(card).faces[0];
	for (const ab of face.abilities) {
		if (
			ab.kind === 'static' &&
			ab.static.k === 'continuous' &&
			ab.static.layer === '7a' &&
			ab.static.mod.k === 'setBasePT'
		) {
			base = evaluateAmount(ab.static.mod.power, {
				state,
				controllerId: obj.ownerId || obj.controllerId,
				source: obj
			});
		}
	}
	return base + (obj.counters['+1/+1'] || 0) - (obj.counters['-1/-1'] || 0) + (obj.tempPowerMod || 0);
}

/** Toughness of an object (CR 107.1b, 208.2a, 208.3). */
export function objectToughness(state: GameState, obj: CardInstance): number | null {
	if (obj.zone === 'battlefield') {
		const ev = evaluatePermanent(state, obj);
		if (!ev.isCreature) return null;
		return ev.unclampedToughness ?? ev.breakdown.effectiveToughness;
	}
	const card = obj.copiableCard ?? obj.card;
	const { types } = splitTypeLine(card.typeLine || '');
	if (!types.some((t) => t.toLowerCase() === 'creature') && card.toughness === undefined) {
		return null;
	}
	const raw = parseInt(card.toughness || '0', 10);
	let base = isNaN(raw) ? 0 : raw;
	const face = compileCard(card).faces[0];
	for (const ab of face.abilities) {
		if (
			ab.kind === 'static' &&
			ab.static.k === 'continuous' &&
			ab.static.layer === '7a' &&
			ab.static.mod.k === 'setBasePT'
		) {
			base = evaluateAmount(ab.static.mod.toughness, {
				state,
				controllerId: obj.ownerId || obj.controllerId,
				source: obj
			});
		}
	}
	return base + (obj.counters['+1/+1'] || 0) - (obj.counters['-1/-1'] || 0) + (obj.tempToughnessMod || 0);
}

/**
 * Mana value of an object in any zone (CR 202.3a, 202.3e, 708.2a):
 * - Face-down objects have no mana cost, so their mana value is 0 (CR 708.2a, 202.3a).
 * - On the stack, each {X} in the mana cost uses the chosen value for X (CR 202.3e).
 * - In all other zones, {X} is treated as 0 (CR 202.3e).
 */
export function objectManaValue(
	state: GameState | undefined,
	obj: CardInstance | StackItem,
	xValue?: number
): number {
	if ('isFaceDown' in obj && obj.isFaceDown) return 0;
	const card = 'copiableCard' in obj && obj.copiableCard ? obj.copiableCard : obj.card;
	const base = card.cmc ?? 0;
	let onStack = false;
	let itemX: number | undefined;
	if ('kind' in obj) {
		onStack = true;
		itemX = obj.xValue;
	} else {
		const stk = state?.stack.find(
			(s) => s.kind === 'spell' && (s.sourceInstanceId === obj.instanceId || s.id === obj.instanceId)
		);
		onStack = obj.zone === 'stack' || Boolean(stk);
		itemX =
			stk?.xValue ??
			(obj as { xValue?: number }).xValue ??
			(obj.zone === 'stack' ? xValue : undefined);
	}
	if (onStack && itemX !== undefined && itemX > 0) {
		const xSymbols = (card.manaCost || '').match(/\{X\}/gi)?.length ?? 0;
		return base + itemX * (xSymbols > 0 ? xSymbols : 1);
	}
	return base;
}

function compare(actual: number, cmp: Compare, ctx: FilterContext): boolean {
	const value = evaluateAmount(cmp.value, ctx);
	switch (cmp.op) {
		case '>=':
			return actual >= value;
		case '<=':
			return actual <= value;
		case '>':
			return actual > value;
		case '<':
			return actual < value;
		default:
			return actual === value;
	}
}

/** Does `obj` match `filter`? Zone is checked only if the filter names one. */
export function matchesObjectFilter(obj: CardInstance, filter: ObjectFilter, ctx: FilterContext): boolean {
	const { state } = ctx;
	if (filter.zone) {
		const zones = Array.isArray(filter.zone) ? filter.zone : [filter.zone];
		if (!zones.includes(obj.zone as ZoneType)) return false;
	}
	if (obj.zone === 'battlefield' && obj.phasedOut) return false;

	const onBattlefield = obj.zone === 'battlefield';
	const evaluated = onBattlefield ? evaluatePermanent(state, obj) : null;
	const card = obj.copiableCard ?? obj.card;
	const typeLine = evaluated ? evaluated.typeLine : card.typeLine;
	const { types, subtypes } = splitTypeLine(typeLine);
	const isPermanentType = (t: string) => types.some((pt) => pt.toLowerCase() === t.toLowerCase());

	if (filter.types && !filter.types.some(isPermanentType)) return false;
	if (filter.notTypes && filter.notTypes.some(isPermanentType)) return false;
	if (filter.supertypes && !filter.supertypes.some(isPermanentType)) return false;
	if (filter.notSupertypes && filter.notSupertypes.some(isPermanentType)) return false;

	const hasSubType = (s: string): boolean => {
		if (evaluated) return evaluated.hasSubType(s);
		if (subtypes.some((sub) => sub.toLowerCase() === s.toLowerCase())) return true;
		// CR 702.73a: Changeling is a characteristic-defining ability that functions in all zones.
		if (
			types.some((t) => t.toLowerCase() === 'creature') &&
			!NON_CREATURE_SUBTYPES.has(s) &&
			!obj.isFaceDown
		) {
			const face = compileCard(card).faces[0];
			const hasChangeling = face.abilities.some(
				(ab) =>
					(ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'changeling') ||
					(ab.kind === 'static' &&
						ab.static.k === 'continuous' &&
						ab.static.mod.k === 'allCreatureTypes')
			);
			if (hasChangeling) return true;
		}
		return false;
	};

	if (filter.subtypes && !filter.subtypes.some(hasSubType)) return false;
	if (filter.notSubtypes && filter.notSubtypes.some(hasSubType)) return false;

	const controllerId = onBattlefield ? obj.controllerId : obj.ownerId;
	if (filter.controller === 'you' && controllerId !== ctx.controllerId) return false;
	if (filter.controller === 'opponent' && controllerId === ctx.controllerId) return false;
	if (filter.owner === 'you' && obj.ownerId !== ctx.controllerId) return false;
	if (filter.owner === 'opponent' && obj.ownerId === ctx.controllerId) return false;

	if (filter.tapped !== undefined && obj.tapped !== filter.tapped) return false;
	if (filter.token !== undefined && obj.isToken !== filter.token) return false;
	if (filter.isCommander !== undefined && Boolean(obj.isCommander) !== filter.isCommander) return false;
	if (filter.other && ctx.source && obj.instanceId === ctx.source.instanceId) return false;
	if (filter.colors) {
		const colors = onBattlefield ? (obj.isFaceDown ? [] : evaluated!.colors) : (card.colors ?? []);
		if (!filter.colors.some((c) => colors.includes(c))) return false;
	}
	if (
		filter.manaValue &&
		!compare(
			objectManaValue(state, obj, filter.manaValue.value.k !== 'x' ? ctx.xValue : undefined),
			filter.manaValue,
			ctx
		)
	) {
		return false;
	}
	if (filter.power) {
		const p = objectPower(state, obj);
		if (p === null || !compare(p, filter.power, ctx)) return false;
	}
	if (filter.toughness) {
		const t = objectToughness(state, obj);
		if (t === null || !compare(t, filter.toughness, ctx)) return false;
	}
	if (filter.attacking !== undefined) {
		const attacking = state.combat.attackers.some((a) => a.attackerInstanceId === obj.instanceId);
		if (attacking !== filter.attacking) return false;
	}
	if (filter.blocking !== undefined) {
		const blocking = state.combat.attackers.some((a) => a.blockerInstanceIds.includes(obj.instanceId));
		if (blocking !== filter.blocking) return false;
	}
	return true;
}

/** All objects in the filter's zones (default: battlefield) that match it. */
export function findObjects(filter: ObjectFilter, ctx: FilterContext, players?: PlayerGameState[]): CardInstance[] {
	const zones = filter.zone ? (Array.isArray(filter.zone) ? filter.zone : [filter.zone]) : ['battlefield'];
	const out: CardInstance[] = [];
	for (const p of players ?? ctx.state.players) {
		if (p.lost) continue;
		for (const z of zones) {
			if (!(ZONES as readonly string[]).includes(z)) continue;
			for (const obj of p[z as PlayerZoneName]) {
				if (matchesObjectFilter(obj, filter, ctx)) out.push(obj);
			}
		}
	}
	return out;
}

/**
 * CR 903.8: Total number of times `playerId` has cast their commander(s) from the command zone this
 * game, reading the existing `player.commanderCastCounts` / `CardInstance.commanderCastCount` state.
 */
export function playerCommanderCastCount(state: GameState, playerId: string): number {
	const player = state.players.find((p) => p.playerId === playerId);
	if (!player) return 0;
	const byId = new Map<string, number>();
	if (player.commanderCastCounts) {
		for (const [id, count] of Object.entries(player.commanderCastCounts)) {
			if (count > 0) byId.set(id, count);
		}
	}
	for (const p of state.players) {
		for (const z of ZONES) {
			for (const c of p[z]) {
				if (c.ownerId === playerId && c.isCommander && (c.commanderCastCount ?? 0) > (byId.get(c.instanceId) ?? 0)) {
					byId.set(c.instanceId, c.commanderCastCount);
				}
			}
		}
	}
	for (const item of state.stack) {
		if ((item.ownerId ?? item.controllerId) === playerId && (item.commanderCastCount ?? 0) > (byId.get(item.sourceInstanceId) ?? 0)) {
			byId.set(item.sourceInstanceId, item.commanderCastCount!);
		}
	}
	let total = 0;
	for (const v of byId.values()) total += v;
	return total;
}

/** Evaluates an Amount. Kinds that need effect bindings or a trigger event evaluate to 0 here. */
export function evaluateAmount(amount: Amount, ctx: FilterContext): number {
	switch (amount.k) {
		case 'const':
			return amount.n;
		case 'x':
			return Math.max(0, ctx.xValue ?? 0);
		case 'count':
			return findObjects(amount.of, ctx).length;
		case 'commanderCastCount':
			return playerCommanderCastCount(ctx.state, ctx.controllerId);
		case 'stat': {
			if (amount.of.k !== 'self' || !ctx.source) return 0;
			if (amount.stat === 'power') return objectPower(ctx.state, ctx.source) ?? 0;
			if (amount.stat === 'toughness') return objectToughness(ctx.state, ctx.source) ?? 0;
			if (amount.stat === 'manaValue') return objectManaValue(ctx.state, ctx.source, ctx.xValue);
			return 0;
		}
		case 'cardsIn': {
			if (amount.of.k !== 'you') return 0;
			const p = ctx.state.players.find((pl) => pl.playerId === ctx.controllerId);
			if (!p) return 0;
			if (amount.zone === 'stack') return ctx.state.stack.length;
			return p[amount.zone as PlayerZoneName]?.length ?? 0;
		}
		case 'life': {
			if (amount.of.k !== 'you') return 0;
			return ctx.state.players.find((p) => p.playerId === ctx.controllerId)?.life ?? 0;
		}
		case 'negate':
			return -evaluateAmount(amount.of, ctx);
		case 'sum':
			return amount.args.reduce((acc, a) => acc + evaluateAmount(a, ctx), 0);
		case 'min':
			return Math.min(...amount.args.map((a) => evaluateAmount(a, ctx)));
		case 'max':
			return Math.max(...amount.args.map((a) => evaluateAmount(a, ctx)));
		default:
			return 0;
	}
}

/** Evaluates a Condition; kinds this module can't decide are false. */
export function evaluateCondition(cond: Condition, ctx: FilterContext): boolean {
	switch (cond.k) {
		case 'compare':
			return compare(evaluateAmount(cond.left, ctx), { op: cond.op, value: cond.right }, ctx);
		case 'and':
			return cond.of.every((c) => evaluateCondition(c, ctx));
		case 'or':
			return cond.of.some((c) => evaluateCondition(c, ctx));
		case 'not':
			return !evaluateCondition(cond.of, ctx);
		case 'isTurnOf':
			return cond.player.k === 'you' && ctx.state.players[ctx.state.activePlayerIndex]?.playerId === ctx.controllerId;
		case 'controlCommander': {
			const p = ctx.state.players.find((pl) => pl.playerId === ctx.controllerId);
			return Boolean(p?.battlefield.some((perm) => !perm.phasedOut && perm.isCommander));
		}
		default:
			return false;
	}
}
