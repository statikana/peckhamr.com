/**
 * Interprets IR ObjectFilters, Amounts and Conditions against the game state (Phase 4).
 *
 * Costs, mana abilities and cost modifiers need these; the Phase 3 effect interpreter needs the
 * same queries, so they live in one small module rather than inside runtime/costs.ts. Never reads
 * rules text or card names: an object's characteristics come from its type line (evaluated through
 * the layer system on the battlefield) and its counters/flags.
 */
import { effectiveCardForObject } from '../scryfall.ts';
import type { Amount, Compare, Condition, ObjectFilter } from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type { CardInstance, GameState, PlayerGameState, StackItem, ZoneType } from '../types.ts';
import {
	activeAbilityDefs,
	effectiveManaValue,
	instanceFaceOptions,
	matchesColorFilter,
	resolveObjectFaces
} from './faces.ts';
import {
	evaluateKickedCountAmount,
	evaluateKickerCondition,
	getObjectKickerInfo,
	isObjectBlitzed,
	isObjectEscaped,
	isObjectEvoked,
	isObjectForetold
} from './kicker.ts';
import { splitSubtypes, hasAllOffBattlefieldAndSpellsColorless } from './layers.ts';
// --- Track P7 ---
import { evaluateP7Condition } from './copyPreventionAndEffects.ts';
// --- Track P8 ---
import {
	countDistinctCardTypesInZone,
	evaluateP8Condition
} from './staticsLayersAndRestrictions.ts';
// --- Track P9 ---
import {
	cameUnderControlSinceLastUpkeep,
	isNinjutsuWindowOpen,
	isUnblockedAttackerForPlayer
} from './keywordsWave3.ts';
// --- Track P10 ---
import { evaluateP10Condition } from './reflexiveManaAndActions.ts';
// --- End Track P10 ---
// --- Track P12 ---
import {
	evaluateP12Amount,
	evaluateP12Condition,
	matchesP12ObjectFilter
} from './keywordsWave4.ts';
// --- End Track P12 ---
// --- Track P11 ---
import {
	computeAttachmentsOnCount,
	computeDomainCount,
	computePartyCount
} from './staticsDynamicAndCosts.ts';
// --- End Track P11 ---
// --- Track P13 ---
import {
	computeColorsAmongPermanents,
	computeDevotionTo,
	computeStatAggregateAmong,
	computeUnlockedDoorsCount,
	evaluateP13Condition,
	matchesP13ObjectFilterFields
} from './effectsWave5.ts';
// --- End Track P13 ---
// --- Track P14 ---
import {
	evaluateWave5Amount,
	evaluateWave5Condition,
	matchesWave5ObjectFilter
} from './staticsAndCostsWave5.ts';
// --- End Track P14 ---
// --- Track P15 ---
import {
	evaluateP15Amount,
	evaluateP15Condition,
	matchesP15ObjectFilter
} from './framesBattlesAndKeywordsWave5.ts';
// --- End Track P15 ---

export interface FilterContext {
	state: GameState;
	/** The player "you" refers to (the controller of the source). */
	controllerId: string;
	/** The source object; `other` excludes it and `{k:'self'}` refers to it. */
	source?: CardInstance;
	stackItem?: StackItem;
	xValue?: number;
	// --- Track P8 ---
	zone?: ZoneType | 'stack';
	// --- Track P10 ---
	lastRollResult?: number;
	// --- End Track P10 ---
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
	'Lander',
	'Mutagen',
	'Heartwood',
	'Vibranium',
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
	'Trap',
	// --- Track P12 ---
	'Spacecraft',
	'Planet'
	// --- End Track P12 ---
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
	const card = effectiveCardForObject(obj);
	const faceOpts = instanceFaceOptions(obj);
	const view = resolveObjectFaces(card, faceOpts);
	const { types } = splitTypeLine(view.typeLine || '');
	if (!types.some((t) => t.toLowerCase() === 'creature') && view.power === undefined) {
		return null;
	}
	const raw = view.power;
	let base = raw ?? 0;
	// --- Track P8 (CR 604.3, 208.2a, 707.9d) ---
	if (obj.copiableState?.except?.power === undefined) {
		for (const ab of activeAbilityDefs(card, faceOpts)) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				ab.static.layer === '7a' &&
				ab.static.affected === 'self'
			) {
				if (ab.static.mod.k === 'setBasePT' || ab.static.mod.k === 'setBasePower') {
					base = evaluateAmount(ab.static.mod.power, {
						state,
						controllerId: obj.ownerId || obj.controllerId,
						source: obj
					});
				}
			}
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
	const card = effectiveCardForObject(obj);
	const faceOpts = instanceFaceOptions(obj);
	const view = resolveObjectFaces(card, faceOpts);
	const { types } = splitTypeLine(view.typeLine || '');
	if (!types.some((t) => t.toLowerCase() === 'creature') && view.toughness === undefined) {
		return null;
	}
	const raw = view.toughness;
	let base = raw ?? 0;
	// --- Track P8 (CR 604.3, 208.2a, 707.9d) ---
	if (obj.copiableState?.except?.toughness === undefined) {
		for (const ab of activeAbilityDefs(card, faceOpts)) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				ab.static.layer === '7a' &&
				ab.static.affected === 'self'
			) {
				if (ab.static.mod.k === 'setBasePT' || ab.static.mod.k === 'setBaseToughness') {
					base = evaluateAmount(ab.static.mod.toughness, {
						state,
						controllerId: obj.ownerId || obj.controllerId,
						source: obj
					});
				}
			}
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
	obj: CardInstance | StackItem
): number {
	if ('isFaceDown' in obj && obj.isFaceDown) return 0;
	const isStackItem = 'kind' in obj;
	const card = !isStackItem ? effectiveCardForObject(obj) : obj.card;
	const stk = isStackItem
		? obj
		: state?.stack.find(
				(s) => s.kind === 'spell' && (s.sourceInstanceId === obj.instanceId || s.id === obj.instanceId)
			);
	const onStack = isStackItem || obj.zone === 'stack' || Boolean(stk);
	const faceOpts = isStackItem
		? {
				zone: 'stack' as const,
				faceIndex: obj.faceIndex,
				fused: obj.fused,
				isFaceDown: obj.isFaceDown,
				...(obj.spellMods?.prototyped || obj.copiableState?.prototyped ? { prototyped: true } : {})
			}
		: stk
			? {
					zone: 'stack' as const,
					faceIndex: stk.faceIndex,
					fused: stk.fused,
					isFaceDown: stk.isFaceDown,
					...(stk.spellMods?.prototyped || stk.copiableState?.prototyped ? { prototyped: true } : {})
				}
			: instanceFaceOptions(obj);
	const view = resolveObjectFaces(card, faceOpts);
	const base = effectiveManaValue(card, faceOpts);
	const itemX = isStackItem ? obj.xValue : (stk?.xValue ?? (obj as { xValue?: number }).xValue);
	if (onStack && itemX !== undefined && itemX > 0) {
		const xSymbols = (view.manaCost || '').match(/\{X\}/gi)?.length ?? 0;
		return base + itemX * xSymbols;
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

function sharesCreatureTypeWithCommander(
	state: GameState,
	controllerId: string,
	obj: CardInstance,
	evaluated: ReturnType<typeof evaluatePermanent> | null,
	card: ReturnType<typeof effectiveCardForObject>,
	faceOpts: ReturnType<typeof instanceFaceOptions>,
	types: string[],
	subtypes: string[],
	hasSubType: (s: string) => boolean
): boolean {
	const player = state.players.find((p) => p.playerId === controllerId);
	if (!player) return false;
	const commanderCards: CardInstance[] = [
		...player.command.filter((c) => c.isCommander),
		...player.battlefield.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.graveyard.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.exile.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.hand.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.library.filter((c) => c.isCommander && c.ownerId === player.playerId)
	];
	if (commanderCards.length === 0) return false;

	const objIsCreatureOrKindred = types.some((t) => {
		const tl = t.toLowerCase();
		return tl === 'creature' || tl === 'kindred' || tl === 'tribal';
	});
	const objHasChangeling =
		objIsCreatureOrKindred &&
		!obj.isFaceDown &&
		activeAbilityDefs(card, faceOpts).some(
			(ab) =>
				(ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'changeling') ||
				(ab.kind === 'static' && ab.static.k === 'continuous' && ab.static.mod.k === 'allCreatureTypes')
		);

	const objCreatureSubtypes = (evaluated ? splitTypeLine(evaluated.typeLine).subtypes : subtypes).filter(
		(s: string) => !NON_CREATURE_SUBTYPES.has(s)
	);

	for (const cmd of commanderCards) {
		const cmdEvaluated = cmd.zone === 'battlefield' ? evaluatePermanent(state, cmd) : null;
		const cmdCard = effectiveCardForObject(cmd);
		const cmdFaceOpts = instanceFaceOptions(cmd);
		const cmdTypeLine = cmdEvaluated
			? cmdEvaluated.typeLine
			: resolveObjectFaces(cmdCard, cmdFaceOpts).typeLine;
		const cmdParsed = splitTypeLine(cmdTypeLine);
		const cmdIsCreatureOrKindred = cmdParsed.types.some((t) => {
			const tl = t.toLowerCase();
			return tl === 'creature' || tl === 'kindred' || tl === 'tribal';
		});
		const cmdHasChangeling =
			cmdIsCreatureOrKindred &&
			!cmd.isFaceDown &&
			activeAbilityDefs(cmdCard, cmdFaceOpts).some(
				(ab) =>
					(ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'changeling') ||
					(ab.kind === 'static' && ab.static.k === 'continuous' && ab.static.mod.k === 'allCreatureTypes')
			);

		const cmdCreatureSubtypes = cmdParsed.subtypes.filter(
			(s: string) => !NON_CREATURE_SUBTYPES.has(s)
		);

		if (cmdHasChangeling && (objCreatureSubtypes.length > 0 || objHasChangeling)) return true;
		if (objHasChangeling && (cmdCreatureSubtypes.length > 0 || cmdHasChangeling)) return true;

		for (const sub of cmdCreatureSubtypes) {
			if (hasSubType(sub)) return true;
		}
	}
	return false;
}

/** Does `obj` match `filter`? Zone is checked only if the filter names one. */
export function matchesObjectFilter(obj: CardInstance, filter: ObjectFilter, ctx: FilterContext): boolean {
	const { state } = ctx;
	const objZone = ctx.zone ?? obj.zone;
	if (filter.zone) {
		const zones = Array.isArray(filter.zone) ? filter.zone : [filter.zone];
		if (!zones.includes(objZone as ZoneType)) return false;
	}
	if (objZone === 'battlefield' && obj.phasedOut) return false;

	const onBattlefield = objZone === 'battlefield';
	const evaluated = onBattlefield ? evaluatePermanent(state, obj) : null;
	const card = effectiveCardForObject(obj);
	const faceOpts = instanceFaceOptions(obj, objZone === 'stack' ? 'stack' : objZone);
	const typeLine = evaluated ? evaluated.typeLine : resolveObjectFaces(card, faceOpts).typeLine;
	const { types, subtypes } = splitTypeLine(typeLine);
	const isPermanentType = (t: string) => types.some((pt) => pt.toLowerCase() === t.toLowerCase());

	if (filter.types && !filter.types.some(isPermanentType)) return false;
	// --- Track P8 + Track P9 ---
	if (filter.allTypes && !filter.allTypes.every(isPermanentType)) return false;
	if (filter.notTypes && filter.notTypes.some(isPermanentType)) return false;
	if (filter.supertypes && !filter.supertypes.some(isPermanentType)) return false;
	if (filter.notSupertypes && filter.notSupertypes.some(isPermanentType)) return false;

	const hasSubType = (s: string): boolean => {
		if (evaluated) return evaluated.hasSubType(s);
		if (subtypes.some((sub) => sub.toLowerCase() === s.toLowerCase())) return true;
		// CR 702.73a: Changeling is a characteristic-defining ability that functions in all zones.
		if (
			types.some((t) => {
				const tl = t.toLowerCase();
				return tl === 'creature' || tl === 'kindred' || tl === 'tribal';
			}) &&
			!NON_CREATURE_SUBTYPES.has(s) &&
			!obj.isFaceDown
		) {
			const hasChangeling = activeAbilityDefs(card, faceOpts).some(
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
	if (filter.ofChosenType) {
		const chosenType = ctx.source?.chosenSubType ?? ctx.stackItem?.sourceChosenSubType;
		if (!chosenType || !hasSubType(chosenType)) return false;
	}
	if (filter.ofChosenColor) {
		const chosenColor = ctx.source?.chosenColor ?? ctx.stackItem?.sourceChosenColor;
		if (!chosenColor) return false;
		const colors = onBattlefield
			? (obj.isFaceDown ? [] : evaluated!.colors)
			: hasAllOffBattlefieldAndSpellsColorless(state)
				? []
				: resolveObjectFaces(card, faceOpts).colors;
		if (!colors.includes(chosenColor)) return false;
	}
	// --- Track P11 ---
	if (filter.ofChosenName) {
		const chosenName = ctx.source?.chosenCardName ?? ctx.stackItem?.sourceChosenCardName;
		if (!chosenName || obj.isFaceDown) return false;
		const effName = evaluated ? evaluated.effectiveName : resolveObjectFaces(card, faceOpts).name;
		if (effName.toLowerCase() !== chosenName.toLowerCase()) return false;
	}
	if (filter.attachedToRef !== undefined) {
		const wantHostId =
			filter.attachedToRef === 'self' ? ctx.source?.instanceId : ctx.source?.attachedToId;
		if (!wantHostId || obj.attachedToId !== wantHostId) return false;
	}
	if (filter.historic !== undefined) {
		const isHist =
			!obj.isFaceDown &&
			(isPermanentType('Legendary') || isPermanentType('Artifact') || hasSubType('Saga'));
		if (isHist !== filter.historic) return false;
	}
	// --- End Track P11 ---

	const controllerId = onBattlefield ? obj.controllerId : obj.ownerId;
	if (filter.controller === 'you' && controllerId !== ctx.controllerId) return false;
	if (filter.controller === 'opponent' && controllerId === ctx.controllerId) return false;
	// --- Track P13 ---
	if (filter.controllerRef) {
		let wantPid: string | undefined = ctx.controllerId;
		if (filter.controllerRef.k === 'activePlayer') {
			wantPid = state.players[state.activePlayerIndex]?.playerId ?? ctx.controllerId;
		} else if (filter.controllerRef.k === 'ownerOf') {
			wantPid = ctx.source?.ownerId ?? ctx.controllerId;
		} else if (filter.controllerRef.k === 'controllerOf') {
			wantPid = ctx.source?.controllerId ?? ctx.controllerId;
		} else if (filter.controllerRef.k === 'target') {
			const tRef = ctx.stackItem?.targets?.[filter.controllerRef.index];
			wantPid = tRef?.kind === 'player' ? tRef.id : undefined;
		} else if (filter.controllerRef.k === 'eventPlayer') {
			wantPid = ctx.stackItem?.eventPlayerId;
		} else if (filter.controllerRef.k === 'defendingPlayer') {
			wantPid =
				ctx.stackItem?.defendingPlayerId ??
				(ctx.source
					? state.combat?.attackers.find((a) => a.attackerInstanceId === ctx.source!.instanceId)
							?.defenderPlayerId
					: undefined);
			if (!wantPid) return false;
		}
		if (wantPid !== undefined && controllerId !== wantPid) return false;
	}
	// --- End Track P13 ---
	if (filter.owner === 'you' && obj.ownerId !== ctx.controllerId) return false;
	if (filter.owner === 'opponent' && obj.ownerId === ctx.controllerId) return false;
	// --- Track P18a ---
	if (filter.sameOwnerAsSource) {
		const srcOwnerId = ctx.source?.ownerId ?? ctx.stackItem?.ownerId ?? ctx.controllerId;
		if (obj.ownerId !== srcOwnerId) return false;
	}
	// --- End Track P18a ---

	if (filter.tapped !== undefined && obj.tapped !== filter.tapped) return false;
	if (filter.saddled !== undefined && Boolean(obj.saddledThisTurn) !== filter.saddled) return false;
	if (filter.monstrous !== undefined && Boolean(obj.isMonstrous) !== filter.monstrous) return false;
	// --- Track P10 ---
	if (filter.suspected !== undefined && Boolean(obj.isSuspected) !== filter.suspected) return false;
	// --- End Track P10 ---
	if (filter.token !== undefined && obj.isToken !== filter.token) return false;
	if (filter.isCommander !== undefined && Boolean(obj.isCommander) !== filter.isCommander) return false;
	if (filter.exiledWithSelf) {
		if (obj.zone !== 'exile' || !ctx.source || !obj.exiledBy) return false;
		const srcVer = ctx.source.objectVersion ?? 1;
		if (
			obj.exiledBy.sourceInstanceId !== ctx.source.instanceId ||
			obj.exiledBy.sourceObjectVersion !== srcVer
		) {
			return false;
		}
	}
	if (filter.other && ctx.source && obj.instanceId === ctx.source.instanceId) return false;
	if (filter.named !== undefined) {
		const name = obj.isFaceDown ? '' : evaluated ? evaluated.effectiveName : card.name;
		if (name.toLowerCase() !== filter.named.toLowerCase()) return false;
	}
	if (filter.colors) {
		const colors = onBattlefield
			? (obj.isFaceDown ? [] : evaluated!.colors)
			: hasAllOffBattlefieldAndSpellsColorless(state)
				? []
				: resolveObjectFaces(card, faceOpts).colors;
		if (!matchesColorFilter(colors, filter.colors)) return false;
	}
	// --- Track P8 ---
	if (filter.notColors?.length || filter.multicolored !== undefined || filter.monocolored !== undefined) {
		const colors = onBattlefield
			? (obj.isFaceDown ? [] : evaluated!.colors)
			: resolveObjectFaces(card, faceOpts).colors;
		if (filter.notColors?.length && matchesColorFilter(colors, filter.notColors)) return false;
		if (filter.multicolored !== undefined && (colors.length >= 2) !== filter.multicolored) return false;
		if (filter.monocolored !== undefined && (colors.length === 1) !== filter.monocolored) return false;
	}
	if (filter.hasKeywords?.length || filter.lacksKeywords?.length) {
		const hasKw = (wanted: string): boolean => {
			const wLow = wanted.toLowerCase();
			if (evaluated) {
				return evaluated.activeKeywords.some((k) => k.toLowerCase() === wLow);
			}
			if (obj.isFaceDown) return false;
			const view = resolveObjectFaces(card, faceOpts);
			if (view.keywords.some((k) => k.toLowerCase() === wLow)) return true;
			if (obj.grantedKeywords?.some((k) => k.toLowerCase() === wLow)) return true;
			return activeAbilityDefs(card, faceOpts).some(
				(ab) => ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === wLow
			);
		};
		if (filter.hasKeywords?.length && !filter.hasKeywords.some(hasKw)) return false;
		if (filter.lacksKeywords?.length && filter.lacksKeywords.some(hasKw)) return false;
	}
	if (filter.hasCounters !== undefined) {
		if (filter.hasCounters === 'any') {
			if (!Object.values(obj.counters).some((n) => n > 0)) return false;
		} else {
			if (((obj.counters as Record<string, number>)[filter.hasCounters] ?? 0) <= 0) return false;
		}
	}
	if (
		filter.sharesTypeWithCommander &&
		!sharesCreatureTypeWithCommander(
			state,
			ctx.controllerId,
			obj,
			evaluated,
			card,
			faceOpts,
			types,
			subtypes,
			hasSubType
		)
	) {
		return false;
	}
	if (filter.targetsSelf) {
		if (!ctx.source) return false;
		const targets = (obj as { targets?: Array<{ kind: string; id: string }> }).targets ?? [];
		if (!targets.some((t) => (t.kind === 'permanent' || t.kind === 'card') && t.id === ctx.source?.instanceId)) return false;
	}
	// --- Track P11 ---
	if (filter.targetsFilter) {
		const targets = (obj as { targets?: Array<{ kind: string; id: string }> }).targets ?? [];
		let matchedTarget = false;
		for (const t of targets) {
			if (
				t.kind !== 'permanent' &&
				t.kind !== 'card' &&
				t.kind !== 'graveyard_card' &&
				t.kind !== 'exile_card'
			) {
				continue;
			}
			for (const p of state.players) {
				if (p.lost) continue;
				if (t.kind === 'permanent' || !filter.targetsFilter.zone || filter.targetsFilter.zone === 'battlefield') {
					const targetPerm = p.battlefield.find(
						(perm) => !perm.phasedOut && perm.instanceId === t.id
					);
					if (targetPerm && matchesObjectFilter(targetPerm, filter.targetsFilter, ctx)) {
						matchedTarget = true;
						break;
					}
				}
				if (
					(t.kind === 'card' || t.kind === 'graveyard_card' || t.kind === 'exile_card') &&
					(t.kind !== 'card' || (filter.targetsFilter.zone && filter.targetsFilter.zone !== 'battlefield'))
				) {
					const zName: PlayerZoneName =
						t.kind === 'graveyard_card'
							? 'graveyard'
							: t.kind === 'exile_card'
								? 'exile'
								: (filter.targetsFilter.zone as PlayerZoneName);
					const targetCard = p[zName]?.find((c) => c.instanceId === t.id);
					if (targetCard && matchesObjectFilter(targetCard, filter.targetsFilter, ctx)) {
						matchedTarget = true;
						break;
					}
				}
			}
			if (matchedTarget) break;
		}
		if (!matchedTarget) return false;
	}
	// --- End Track P11 ---
	if (
		filter.manaValue &&
		!compare(
			objectManaValue(state, obj),
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
	// --- Track P9 ---
	if (filter.unblockedAttacker !== undefined) {
		const isUnblocked = isUnblockedAttackerForPlayer(state, obj, ctx.controllerId);
		if (isUnblocked !== filter.unblockedAttacker) return false;
	}
	// --- Track P12 ---
	if (!matchesP12ObjectFilter(obj, filter, ctx, matchesObjectFilter)) return false;
	// --- End Track P12 ---
	// --- Track P13 ---
	if (
		!matchesP13ObjectFilterFields(obj, filter, {
			state,
			zone: objZone,
			stackItem: ctx.stackItem
		})
	) {
		return false;
	}
	// --- End Track P13 ---
	// --- Track P14 ---
	if (!matchesWave5ObjectFilter(obj, filter, ctx)) return false;
	// --- End Track P14 ---
	// --- Track P15 ---
	if (!matchesP15ObjectFilter(filter, obj, ctx)) return false;
	// --- End Track P15 ---
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
 * game, reading `player.commanderCastCounts`.
 */
export function playerCommanderCastCount(state: GameState, playerId: string): number {
	const player = state.players.find((p) => p.playerId === playerId);
	if (!player || !player.commanderCastCounts) return 0;
	let total = 0;
	for (const count of Object.values(player.commanderCastCounts)) {
		if (count > 0) total += count;
	}
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
		case 'stormCount':
			return 0;
		case 'colorsOfManaSpentToCast':
			return ctx.source?.manaColorsSpent?.length ?? 0;
		case 'tappedCostPower':
			return 0;
		case 'countersOn': {
			if (amount.of.k !== 'self' || !ctx.source) return 0;
			// --- Track P8 ---
			if (amount.counter === 'any') {
				return Object.values(ctx.source.counters).reduce((acc, n) => acc + (n > 0 ? n : 0), 0);
			}
			return ctx.source.counters[amount.counter] ?? 0;
		}
		// --- Track P9 ---
		case 'lkiCounterCount':
			return ctx.stackItem?.eventLki?.counters?.[amount.counter] ?? ctx.source?.lastKnownCounters?.[amount.counter] ?? 0;
		case 'kickedCount': {
			const info = ctx.source
				? getObjectKickerInfo(ctx.state, ctx.source.card, ctx.source.instanceId, undefined, ctx.source)
				: { count: 0, tags: [] };
			return evaluateKickedCountAmount(amount, info);
		}
		case 'stat': {
			if (amount.of.k !== 'self' || !ctx.source) return 0;
			if (amount.stat === 'power') return objectPower(ctx.state, ctx.source) ?? 0;
			if (amount.stat === 'toughness') return objectToughness(ctx.state, ctx.source) ?? 0;
			if (amount.stat === 'manaValue') return objectManaValue(ctx.state, ctx.source);
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
		case 'energyCount': {
			if (amount.player.k === 'you') {
				return ctx.state.players.find((p) => p.playerId === ctx.controllerId)?.energyCounters ?? 0;
			}
			if (amount.player.k === 'activePlayer') {
				return ctx.state.players[ctx.state.activePlayerIndex]?.energyCounters ?? 0;
			}
			return 0;
		}
		case 'negate':
			return -evaluateAmount(amount.of, ctx);
		case 'sum':
			return amount.args.reduce((acc, a) => acc + evaluateAmount(a, ctx), 0);
		case 'min':
			return Math.min(...amount.args.map((a) => evaluateAmount(a, ctx)));
		case 'max':
			return Math.max(...amount.args.map((a) => evaluateAmount(a, ctx)));
		// --- Track P8 ---
		case 'distinctCardTypesInZone':
			return countDistinctCardTypesInZone(ctx.state, ctx.controllerId, amount.zone, amount.whose);
		// --- Track P10 ---
		case 'lastRollResult':
			return ctx.lastRollResult ?? ctx.stackItem?.lastRollResult ?? 0;
		// --- End Track P10 ---
		// --- Track P12 ---
		case 'devouredCount':
		case 'opponentCount':
			return evaluateP12Amount(amount, ctx) ?? 0;
		// --- End Track P12 ---
		// --- Track P11 ---
		case 'mul':
			return amount.factor * evaluateAmount(amount.of, ctx);
		case 'domain': {
			const pid =
				amount.player.k === 'you'
					? ctx.controllerId
					: (ctx.state.players[ctx.state.activePlayerIndex]?.playerId ?? ctx.controllerId);
			return computeDomainCount(ctx.state, pid);
		}
		case 'partyCount': {
			const pid =
				amount.player.k === 'you'
					? ctx.controllerId
					: (ctx.state.players[ctx.state.activePlayerIndex]?.playerId ?? ctx.controllerId);
			return computePartyCount(ctx.state, pid);
		}
		case 'attachmentsOn': {
			const hostId =
				amount.target === 'self'
					? ctx.source?.instanceId
					: (ctx.source?.attachedToId ?? undefined);
			if (!hostId) return 0;
			return computeAttachmentsOnCount(
				ctx.state,
				hostId,
				amount.filter,
				ctx.controllerId,
				ctx.source
			);
		}
		// --- End Track P11 ---
		// --- Track P13 + Track P14 ---
		case 'devotion':
			return amount.player
				? (evaluateWave5Amount(amount, ctx) ?? 0)
				: computeDevotionTo(ctx.state, ctx.controllerId, amount.colors);
		case 'unlockedDoorsCount': {
			const pid =
				amount.player.k === 'activePlayer'
					? (ctx.state.players[ctx.state.activePlayerIndex]?.playerId ?? ctx.controllerId)
					: ctx.controllerId;
			return computeUnlockedDoorsCount(ctx.state, pid);
		}
		case 'excessDamage':
			return ctx.stackItem?.lastExcessDamage ?? 0;
		case 'lastEffectAmount':
			return ctx.stackItem?.lastEffectAmount ?? 0;
		case 'colorsAmongPermanents': {
			const pid =
				amount.player.k === 'activePlayer'
					? (ctx.state.players[ctx.state.activePlayerIndex]?.playerId ?? ctx.controllerId)
					: ctx.controllerId;
			return computeColorsAmongPermanents(
				ctx.state,
				pid,
				amount.filter,
				(perm, f) => matchesObjectFilter(perm, f, ctx)
			);
		}
		case 'half': {
			const inner = evaluateAmount(amount.of, ctx);
			return amount.round === 'up' ? Math.ceil(inner / 2) : Math.floor(inner / 2);
		}
		case 'dungeonsCompleted': {
			const pid =
				amount.player.k === 'activePlayer'
					? (ctx.state.players[ctx.state.activePlayerIndex]?.playerId ?? ctx.controllerId)
					: ctx.controllerId;
			const pl = ctx.state.players.find((p) => p.playerId === pid);
			return pl?.dungeonsCompletedCount ?? 0;
		}
		case 'greatestStatAmong': {
			if (amount.filter.zone && amount.filter.zone !== 'battlefield') {
				return evaluateWave5Amount(amount, ctx) ?? 0;
			}
			return computeStatAggregateAmong(
				ctx.state,
				amount.filter,
				amount.stat,
				'greatest',
				(perm, f) => matchesObjectFilter(perm, f, ctx)
			);
		}
		case 'totalStatAmong':
			return computeStatAggregateAmong(
				ctx.state,
				amount.filter,
				amount.stat,
				'total',
				(perm, f) => matchesObjectFilter(perm, f, ctx)
			);
		case 'targetsBeyondFirst':
		case 'colorsOfObject':
		case 'totalStatOf':
		case 'anyNumber':
			return evaluateWave5Amount(amount, ctx) ?? 0;
		// --- End Track P13 + Track P14 ---
		// --- Track P15 ---
		case 'playerSpeed':
		case 'gravestormCount':
			return evaluateP15Amount(amount, ctx.state, ctx.controllerId) ?? 0;
		// --- End Track P15 ---
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
		case 'kicked': {
			const info = ctx.source
				? getObjectKickerInfo(ctx.state, ctx.source.card, ctx.source.instanceId, undefined, ctx.source)
				: { count: 0, tags: [] };
			return evaluateKickerCondition(cond, info);
		}
		case 'evoked':
			return ctx.source
				? isObjectEvoked(ctx.state, ctx.source.instanceId, undefined, ctx.source)
				: false;
		case 'escaped':
			return ctx.source
				? isObjectEscaped(ctx.state, ctx.source.instanceId, undefined, ctx.source)
				: false;
		case 'isMonarch': {
			const monarchId = ctx.state.monarchPlayerId ?? null;
			if (!monarchId) return false;
			if (cond.player) {
				if (cond.player.k === 'you') return monarchId === ctx.controllerId;
				if (cond.player.k === 'activePlayer') {
					return monarchId === ctx.state.players[ctx.state.activePlayerIndex]?.playerId;
				}
				return false;
			}
			const rel = cond.relation ?? 'you';
			if (rel === 'you') return monarchId === ctx.controllerId;
			if (rel === 'opponent') return monarchId !== ctx.controllerId;
			return true;
		}
		case 'foretold':
			return ctx.source
				? isObjectForetold(ctx.state, ctx.source.instanceId, undefined, ctx.source)
				: false;
		case 'blitzed':
			return ctx.source
				? isObjectBlitzed(ctx.state, ctx.source.instanceId, undefined, ctx.source)
				: false;
		case 'saddled':
			return Boolean(ctx.source?.saddledThisTurn);
		case 'exertedThisTurn':
			return Boolean(ctx.source?.exertedThisTurn || ctx.stackItem?.sourceExertedThisTurn);
		case 'monstrous':
			return Boolean(ctx.source?.isMonstrous);
		case 'matchesFilter':
			return ctx.source ? matchesObjectFilter(ctx.source, cond.filter, ctx) : false;
		// --- Track P7 ---
		case 'creatureDiedThisTurn':
		case 'attackedThisTurn':
		case 'permanentLeftBattlefieldThisTurn':
		case 'gainedLifeThisTurn':
		case 'wasCast': {
			const minLife =
				cond.k === 'gainedLifeThisTurn' && cond.min ? evaluateAmount(cond.min, ctx) : undefined;
			return evaluateP7Condition(ctx.state, cond, ctx.controllerId, {
				sourceObj: ctx.source,
				stackItem: ctx.stackItem,
				minLife
			});
		}
		// --- Track P8 ---
		case 'objectState':
		case 'opponentCount':
		case 'anyPlayerLife':
		case 'distinctControlledCreaturePowers':
			return evaluateP8Condition(cond, ctx);
		// --- Track P9 ---
		case 'cameUnderControlSinceLastUpkeep':
			return ctx.source
				? cameUnderControlSinceLastUpkeep(ctx.state, ctx.controllerId, ctx.source)
				: false;
		case 'ninjutsuWindow':
			return isNinjutsuWindowOpen(ctx.state);
		case 'lkiHasNoCounter': {
			const c =
				ctx.stackItem?.eventLki?.counters?.[cond.counter] ??
				ctx.source?.lastKnownCounters?.[cond.counter] ??
				ctx.source?.counters[cond.counter] ??
				0;
			return c <= 0;
		}
		// --- Track P10 ---
		case 'opponentLostLifeThisTurn':
		case 'descendedThisTurn':
		case 'hadCounterOnIt':
		case 'manaColorSpentToCast':
		case 'opponentComparison':
			return evaluateP10Condition(cond, ctx);
		// --- End Track P10 ---
		// --- Track P12 ---
		case 'classLevelIs':
		case 'classLevelAtLeast':
		case 'caseSolved':
		case 'caseUnsolved':
		case 'isRenowned':
		case 'boastAttackedThisTurn':
		case 'exhaustUnused':
		case 'dethroneMostLife':
		case 'trainingGreaterAttacker':
		case 'creaturesAttackedCountThisTurn':
		case 'totalPowerControlled':
		case 'colorsAmongControlledPermanents':
		case 'sourcesDealtDamageThisTurn':
		case 'cardsPutIntoGraveyardFromAnywhereThisTurn':
		case 'spellsCastThisTurnCount':
			return evaluateP12Condition(cond, ctx, matchesObjectFilter) ?? false;
		// --- End Track P12 ---
		// --- Track P13 ---
		case 'selfInZone':
		case 'spellsCastLastTurn':
		case 'hasCompletedDungeon':
		case 'hasInitiative':
		case 'hasCitysBlessing':
		case 'hasMaxSpeed':
		case 'opponentPoisonAtLeast':
		case 'nonlandEnteredThisTurn':
		case 'voidThisTurn':
		case 'sameColorManaSpentAtLeast':
			return (
				evaluateP13Condition(cond, {
					state: ctx.state,
					controllerId: ctx.controllerId,
					source: ctx.source,
					stackItem: ctx.stackItem,
					zone: ctx.zone
				}) ?? false
			);
		// --- End Track P13 ---
		// --- Track P14 ---
		case 'anyOpponentMetric':
		case 'cardsDrawnThisTurnAtLeast':
		case 'nthMatchingSpellThisTurn':
			return evaluateWave5Condition(cond, ctx) ?? false;
		// --- End Track P14 ---
		// --- Track P15 ---
		case 'maxSpeed':
		case 'citysBlessing':
		case 'giftPromised':
		case 'isDay':
		case 'isNight':
		case 'isYourTurn':
		case 'selfPrepared':
		case 'isImpending':
		case 'enteredWithXAtLeast':
			return (
				evaluateP15Condition(cond, ctx.state, ctx.controllerId, {
					source: ctx.source,
					giftPromised: Boolean(
						ctx.source?.giftPromised ||
							ctx.stackItem?.giftKind ||
							ctx.stackItem?.sourceGiftPromised
					)
				}) ?? false
			);
		// --- End Track P15 ---
		// --- Wave 6 Shared ---
		case 'isPaired':
			return Boolean(ctx.source?.pairedWithId);
		case 'tributePaid':
			// --- Track P18a ---
			return Boolean(ctx.source?.tributePaid || ctx.stackItem?.sourceTributePaid);
		// --- End Track P18a ---
		case 'hasEnduringStory':
			// --- Track P18a ---
			return Boolean(
				ctx.source?.hasEnduringStory ||
					ctx.state.players.find((pl) => pl.playerId === ctx.controllerId)?.hasEnduringStory
			);
		// --- End Track P18a ---
		case 'isHarnessed':
			return Boolean(ctx.source?.isHarnessed);
		// --- End Wave 6 Shared ---
		default:
			return false;
	}
}
