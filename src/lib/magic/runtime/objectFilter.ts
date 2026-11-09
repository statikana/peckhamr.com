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
import type { CardInstance, GameState, PlayerGameState, ZoneType } from '../types.ts';
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
	if (filter.other && ctx.source && obj.instanceId === ctx.source.instanceId) return false;
	if (filter.colors) {
		const colors = onBattlefield ? (obj.isFaceDown ? [] : evaluated!.colors) : (card.colors ?? []);
		if (!filter.colors.some((c) => colors.includes(c))) return false;
	}
	if (filter.manaValue && !compare(card.cmc, filter.manaValue, ctx)) return false;
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

/** Evaluates an Amount. Kinds that need effect bindings or a trigger event evaluate to 0 here. */
export function evaluateAmount(amount: Amount, ctx: FilterContext): number {
	switch (amount.k) {
		case 'const':
			return amount.n;
		case 'x':
			return Math.max(0, ctx.xValue ?? 0);
		case 'count':
			return findObjects(amount.of, ctx).length;
		case 'stat': {
			if (amount.of.k !== 'self' || !ctx.source) return 0;
			if (amount.stat === 'power') return objectPower(ctx.state, ctx.source) ?? 0;
			if (amount.stat === 'toughness') return objectToughness(ctx.state, ctx.source) ?? 0;
			if (amount.stat === 'manaValue') return (ctx.source.copiableCard ?? ctx.source.card).cmc;
			return 0;
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
		default:
			return false;
	}
}
