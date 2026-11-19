/**
 * Wave 12 (Wave 9S) — Continuous Layer Extensions, Granted Object Abilities,
 * Zone-Play Permissions, Spell Keyword Grants, Hexproof/Ward Bypass,
 * Combat Rules & First-Matching-Turn Cost/Flash Helpers.
 *
 * Upholds ENGINE_INVARIANTS.md:
 * - Zero rules-text reads
 * - Zero card-name comparisons or precon card names
 * - Zero raw typeLine reads outside exempt files (uses resolveObjectFaces / activeCharacteristics / PermWorkState)
 * - Zero IR stored in GameState
 * - Bounded loops only
 */
import { compileCard, grantedAbilityById } from '../compiler/index.ts';
import type {
	ActivatedAbility,
	Amount,
	Compare,
	CostDef,
	ObjectFilter,
	StaticDef
} from '../ir.ts';
import { getKeywordSpec } from '../keywords.ts';
import { getCardActivatedAbilities } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CastCostAid,
	CastOption,
	CastOptionOptionalCost,
	EffectiveActivatedAbility,
	GameState,
	ManaColor,
	PlayerGameState,
	SpellModifications,
	ZoneType
} from '../types.ts';
import type { CastableSourceZone } from './engineHost.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { withStableLayerInputs } from './layerCache.ts';
import { abilityActivePermanents, evaluatePermanent, permanentHasLostAllAbilities } from './layers.ts';
import {
	READ_ALL_COUNTERS,
	READ_EXILE,
	READ_WAVE9_ATTACKS,
	READ_WAVE9_DYNAMIC,
	READ_WAVE9_MANA,
	describeGrantedActivatedAbility,
	evaluateLayerCondition,
	formatKeywordLabel,
	grantItem,
	matchesLayerFilter,
	noteLayerRead,
	type PermWorkState
} from './layersPredicates.ts';
import {
	evaluateAmount,
	evaluateCondition,
	matchesObjectFilter,
	type FilterContext
} from './objectFilter.ts';
import { activeRuleModifiers } from './replace.ts';
import { forEachActiveStaticOnBattlefield } from './staticsDynamicAndCosts.ts';
import { getActiveCombatRulesForPermanent } from './staticsLayersAndRestrictions.ts';

function compareWave9(actual: number | null, cmp: Compare, workList: PermWorkState[], source: PermWorkState, state: GameState, affected?: PermWorkState): boolean {
	if (actual === null) return false;
	const rhs = evaluateLayerAmountWave9Base(cmp.value, state, workList, source, affected);
	switch (cmp.op) {
		case '=':
			return actual === rhs;
		case '>=':
			return actual >= rhs;
		case '<=':
			return actual <= rhs;
		case '>':
			return actual > rhs;
		case '<':
			return actual < rhs;
	}
}

function evaluateLayerAmountWave9Base(
	amt: Amount,
	state: GameState,
	workList: PermWorkState[],
	source: PermWorkState,
	affected?: PermWorkState
): number {
	switch (amt.k) {
		case 'const':
			return amt.n;
		case 'timesAttackedThisTurn':
			noteLayerRead(READ_WAVE9_ATTACKS);
			return (affected ?? source).inst.attacksCountThisTurn ?? 0;
		default:
			return 0;
	}
}

/**
 * Layer 3 (CR 613.1c): Text- and name-changing continuous effects (`setName`).
 */
export function applyLayer3Wave9(
	state: GameState,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	const nameEvents: Array<{
		source: PermWorkState;
		target: PermWorkState;
		name: string;
	}> = [];
	for (const source of workList) {
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '3' || st.mod.k !== 'setName') continue;
			for (const target of workList) {
				if (st.affected === 'attachedTo') {
					if (source.inst.attachedToId !== target.inst.instanceId) continue;
				} else if (st.affected === 'self') {
					if (source.inst.instanceId !== target.inst.instanceId) continue;
				} else {
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
				}
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
				) {
					continue;
				}
				nameEvents.push({ source, target, name: st.mod.name });
			}
		}
	}
	nameEvents.sort((a, b) => a.source.timestamp - b.source.timestamp);
	for (const ev of nameEvents) {
		ev.target.name = ev.name;
	}
}

/**
 * Finds the last card exiled by `sourcePerm` that is a creature card (for `copyStatsAndSubtypesFromLastExiled`).
 */
function findLastCreatureExiledWithSource(
	state: GameState,
	sourcePerm: CardInstance
): CardInstance | null {
	noteLayerRead(READ_EXILE);
	const ver = sourcePerm.objectVersion ?? 1;
	let best: CardInstance | null = null;
	let bestTs = -1;
	for (const p of state.players) {
		for (const ex of p.exile) {
			if (
				ex.exiledBy?.sourceInstanceId !== sourcePerm.instanceId ||
				(ex.exiledBy.sourceObjectVersion ?? 1) !== ver
			) {
				continue;
			}
			const chars = activeCharacteristics(effectiveCardForObject(ex), instanceFaceOptions(ex, 'exile'));
			if (!chars.types.includes('Creature')) continue;
			const ts = ex.enteredTimestamp ?? 0;
			if (!best || ts >= bestTs) {
				best = ex;
				bestTs = ts;
			}
		}
	}
	return best;
}

/**
 * Layer 4 helper for `copyStatsAndSubtypesFromLastExiled`.
 */
export function applyLayer4CopyLastExiledWave9(
	state: GameState,
	source: PermWorkState,
	target: PermWorkState
): boolean {
	const ex = findLastCreatureExiledWithSource(state, source.inst);
	if (!ex) return false;
	const view = resolveObjectFaces(effectiveCardForObject(ex), instanceFaceOptions(ex, 'exile'));
	const creatureSubtypes = view.subtypes.filter(Boolean);
	target.subtypes = [...creatureSubtypes];
	const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
	const typeStr = target.types.join(' ');
	const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
	target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
	return true;
}

/**
 * Layer 7b helper for `copyStatsAndSubtypesFromLastExiled`.
 */
export function applyLayer7bCopyLastExiledWave9(
	state: GameState,
	source: PermWorkState,
	target: PermWorkState
): { power: number; toughness: number } | null {
	const ex = findLastCreatureExiledWithSource(state, source.inst);
	if (!ex) return null;
	const chars = activeCharacteristics(effectiveCardForObject(ex), instanceFaceOptions(ex, 'exile'));
	if (chars.power === null || chars.power === undefined || chars.toughness === null || chars.toughness === undefined) return null;
	return { power: chars.power, toughness: chars.toughness };
}

/**
 * Layer 6 helper for `grantAbilitiesFromObjects` and `copyKeywordsFromExiled`.
 */
export function applyLayer6Wave9Mod(
	state: GameState,
	source: PermWorkState,
	target: PermWorkState,
	mod: Extract<
		Extract<StaticDef, { k: 'continuous' }>['mod'],
		{ k: 'grantAbilitiesFromObjects' | 'copyKeywordsFromExiled' }
	>,
	workList: PermWorkState[]
): void {
	if (mod.k === 'copyKeywordsFromExiled') {
		noteLayerRead(READ_EXILE);
		const ver = source.inst.objectVersion ?? 1;
		const presentKws = new Set<string>();
		for (const p of state.players) {
			for (const ex of p.exile) {
				if (
					ex.exiledBy?.sourceInstanceId !== source.inst.instanceId ||
					(ex.exiledBy.sourceObjectVersion ?? 1) !== ver
				) {
					continue;
				}
				const exCard = effectiveCardForObject(ex);
				const faceOpts = instanceFaceOptions(ex, 'exile');
				const chars = activeCharacteristics(exCard, faceOpts);
				for (const k of resolveObjectFaces(exCard, faceOpts).keywords) presentKws.add(k.toLowerCase());
				for (const ab of activeAbilityDefs(exCard, faceOpts)) {
					if (ab.kind === 'keyword') presentKws.add(ab.keyword.name.toLowerCase());
				}
				if (ex.grantedKeywords) {
					for (const k of ex.grantedKeywords) presentKws.add(k.toLowerCase());
				}
			}
		}
		for (const kw of mod.keywords) {
			const low = kw.toLowerCase();
			if (presentKws.has(low)) {
				grantItem(target, low, formatKeywordLabel(low), 'keyword', source.name, source.timestamp);
			}
		}
		return;
	}

	// grantAbilitiesFromObjects
	const grantActivatedFromCardObj = (obj: CardInstance, zone: ZoneType) => {
		const card = effectiveCardForObject(obj);
		const faceOpts = instanceFaceOptions(obj, zone);
		const view = resolveObjectFaces(card, faceOpts);
		const def = compileCard(faceOpts?.copiableState?.card ?? card);
		for (const fi of view.activeFaceIndices) {
			const face = def.faces[fi];
			if (!face) continue;
			for (const ab of face.abilities) {
				if (ab.kind !== 'activated') continue;
				if (mod.loyaltyOnly && !ab.cost.some((c) => c.k === 'loyalty')) continue;
				const desc = describeGrantedActivatedAbility(ab, obj.instanceId);
				grantItem(target, desc.key, desc.name, 'ability', source.name, source.timestamp, {
					grantedAbility: ab,
					grantSourceCard: card,
					grantSourceId: obj.instanceId,
					grantFaceIndex: fi
				});
			}
		}
		const effectiveMerged = faceOpts?.copiableState
			? faceOpts.copiableState.mergedComponents
			: faceOpts?.mergedComponents;
		if (!faceOpts?.isFaceDown && effectiveMerged && effectiveMerged.length > 1) {
			for (let i = 1; i < effectiveMerged.length; i++) {
				const mc = effectiveMerged[i]!;
				const mcFace = compileCard(mc).faces[0];
				if (!mcFace) continue;
				for (const ab of mcFace.abilities) {
					if (ab.kind !== 'activated') continue;
					if (mod.loyaltyOnly && !ab.cost.some((c) => c.k === 'loyalty')) continue;
					const desc = describeGrantedActivatedAbility(ab, obj.instanceId);
					grantItem(target, desc.key, desc.name, 'ability', source.name, source.timestamp, {
						grantedAbility: ab,
						grantSourceCard: mc,
						grantSourceId: obj.instanceId,
						grantFaceIndex: 0
					});
				}
			}
		}
	};

	if (mod.from.k === 'exiledWithSelf') {
		noteLayerRead(READ_EXILE);
		const ver = source.inst.objectVersion ?? 1;
		for (const p of state.players) {
			for (const ex of p.exile) {
				if (
					ex.exiledBy?.sourceInstanceId !== source.inst.instanceId ||
					(ex.exiledBy.sourceObjectVersion ?? 1) !== ver
				) {
					continue;
				}
				if (
					!matchesObjectFilter(ex, { ...mod.from.filter, zone: 'exile' }, {
						state,
						controllerId: source.controllerId,
						source: source.inst,
						zone: 'exile'
					})
				) {
					continue;
				}
				grantActivatedFromCardObj(ex, 'exile');
			}
		}
	} else if (mod.from.k === 'battlefield') {
		for (const w of workList) {
			if (!matchesLayerFilter(mod.from.filter, w, source, state, workList)) continue;
			grantActivatedFromCardObj(w.inst, 'battlefield');
		}
	}
}

/**
 * Filter predicates evaluated in `layersPredicates.ts` for Wave 9S ObjectFilter fields.
 */
export function matchesLayerFilterWave9(
	filter: ObjectFilter,
	target: PermWorkState,
	source: PermWorkState,
	compareAgainst: PermWorkState,
	workList: PermWorkState[],
	state: GameState
): boolean {
	if (filter.sameNameAsAffected) {
		if (!target.name || !compareAgainst.name || target.name !== compareAgainst.name) {
			return false;
		}
		if (filter.other && target.inst.instanceId === compareAgainst.inst.instanceId) {
			return false;
		}
	}
	if (filter.notSameNameAsSource) {
		if (target.name && source.name && target.name === source.name) {
			return false;
		}
	}
	if (filter.basePowerOrToughness) {
		if (!target.types.includes('Creature')) return false;
		const pOk = compareWave9(
			target.basePower,
			filter.basePowerOrToughness,
			workList,
			source,
			state,
			compareAgainst
		);
		const tOk = compareWave9(
			target.baseToughness,
			filter.basePowerOrToughness,
			workList,
			source,
			state,
			compareAgainst
		);
		if (!pOk && !tOk) return false;
	}
	return true;
}

/**
 * Amount variants evaluated in `layersPredicates.ts` (`evaluateLayerAmount`).
 */
export function evaluateLayerAmountWave9(
	amount: Amount,
	state: GameState,
	workList: PermWorkState[],
	source: PermWorkState,
	affected?: PermWorkState
): number | null {
	switch (amount.k) {
		case 'timesAttackedThisTurn': {
			noteLayerRead(READ_WAVE9_ATTACKS);
			const obj = (affected ?? source).inst;
			return obj.attacksCountThisTurn ?? 0;
		}
		case 'unspentManaTotal': {
			noteLayerRead(READ_WAVE9_MANA);
			const pl = state.players.find((p) => p.playerId === source.controllerId);
			if (!pl) return 0;
			let total =
				pl.manaPool.W +
				pl.manaPool.U +
				pl.manaPool.B +
				pl.manaPool.R +
				pl.manaPool.G +
				pl.manaPool.C;
			if (pl.restrictedMana) {
				for (const bucket of Object.values(pl.restrictedMana)) {
					if (!bucket) continue;
					total +=
						bucket.W +
						bucket.U +
						bucket.B +
						bucket.R +
						bucket.G +
						bucket.C;
				}
			}
			if (pl.restrictedManaBuckets) {
				for (const b of pl.restrictedManaBuckets) {
					total +=
						b.pool.W +
						b.pool.U +
						b.pool.B +
						b.pool.R +
						b.pool.G +
						b.pool.C;
				}
			}
			return total;
		}
		case 'countersAmong': {
			noteLayerRead(READ_ALL_COUNTERS);
			let sum = 0;
			for (const w of workList) {
				if (!matchesLayerFilter(amount.filter, w, source, state, workList)) continue;
				sum += w.inst.counters[amount.counter] ?? 0;
			}
			return sum;
		}
		case 'greatestControlledCount': {
			const counts = new Map<string, number>();
			for (const w of workList) {
				if (!matchesLayerFilter(amount.filter, w, source, state, workList)) continue;
				counts.set(w.controllerId, (counts.get(w.controllerId) ?? 0) + 1);
			}
			let best = 0;
			for (const c of counts.values()) if (c > best) best = c;
			return best;
		}
		case 'greatestOpponentCardsDrawnThisTurn': {
			noteLayerRead(READ_WAVE9_DYNAMIC);
			let best = 0;
			for (const p of state.players) {
				if (p.lost || p.playerId === source.controllerId) continue;
				const d = p.cardsDrawnThisTurn ?? 0;
				if (d > best) best = d;
			}
			return best;
		}
		default:
			return null;
	}
}

/**
 * Evaluates Wave 9S `Amount` variants inside general effect / trigger `objectFilter.ts`.
 */
export function evaluateObjectFilterAmountWave9(
	amount: Amount,
	ctx: FilterContext
): number | null {
	const { state, controllerId, source } = ctx;
	switch (amount.k) {
		case 'timesAttackedThisTurn':
			return source?.attacksCountThisTurn ?? 0;
		case 'unspentManaTotal': {
			const pl = state.players.find((p) => p.playerId === controllerId);
			if (!pl) return 0;
			let total =
				pl.manaPool.W +
				pl.manaPool.U +
				pl.manaPool.B +
				pl.manaPool.R +
				pl.manaPool.G +
				pl.manaPool.C;
			if (pl.restrictedManaBuckets) {
				for (const b of pl.restrictedManaBuckets) {
					total +=
						b.pool.W +
						b.pool.U +
						b.pool.B +
						b.pool.R +
						b.pool.G +
						b.pool.C;
				}
			}
			return total;
		}
		case 'countersAmong': {
			let sum = 0;
			for (const p of state.players) {
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (!matchesObjectFilter(perm, { ...amount.filter, zone: 'battlefield' }, ctx)) continue;
					sum += perm.counters[amount.counter] ?? 0;
				}
			}
			return sum;
		}
		case 'greatestControlledCount': {
			let best = 0;
			for (const p of state.players) {
				if (p.lost) continue;
				let c = 0;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (matchesObjectFilter(perm, { ...amount.filter, zone: 'battlefield' }, ctx)) c++;
				}
				if (c > best) best = c;
			}
			return best;
		}
		case 'greatestOpponentCardsDrawnThisTurn': {
			let best = 0;
			for (const p of state.players) {
				if (p.lost || p.playerId === controllerId) continue;
				const d = p.cardsDrawnThisTurn ?? 0;
				if (d > best) best = d;
			}
			return best;
		}
		default:
			return null;
	}
}

/**
 * Evaluates Wave 9S `Condition` variants (`firstSpellThisTurnWithManaFrom`).
 */
export function evaluateConditionWave9(
	cond: { k: string; manaSource?: string },
	ctx: FilterContext
): boolean | null {
	if (cond.k === 'firstSpellThisTurnWithManaFrom' && cond.manaSource === 'treasure') {
		const pl = ctx.state.players.find((p) => p.playerId === ctx.controllerId);
		if (!pl) return false;
		// During spell cast evaluation, spentTreasureManaOnCurrentSpell is true AND spellsCastWithTreasureManaThisTurn hasn't passed 1 yet
		return Boolean(pl.spentTreasureManaOnCurrentSpell) && (pl.spellsCastWithTreasureManaThisTurn ?? 0) <= 1;
	}
	return null;
}

/**
 * CR 609.4b / `Agatha's Soul Cauldron` style mana-as-any-color for activated abilities of filtered controlled creatures.
 */
export function canSpendManaAsAnyColorForActivatedAbilityWave9(
	state: GameState,
	actorId: string,
	sourcePerm: CardInstance
): boolean {
	for (const m of activeRuleModifiers(state, 'spendManaAsAnyColor', actorId)) {
		if (!m.def.params?.abilitiesOnly) continue;
		const filter = m.def.params.sourceFilter as ObjectFilter | undefined;
		if (!filter) return true;
		if (
			matchesObjectFilter(sourcePerm, { ...filter, zone: 'battlefield' }, {
				state,
				controllerId: actorId,
				source: sourcePerm
			})
		) {
			return true;
		}
	}
	return false;
}

/**
 * Rule modifiers: `ignoreHexproof` and `suppressWardTriggers` (*Nowhere to Run*).
 */
export function playerIgnoresOpponentHexproofWave9(
	state: GameState,
	actorId: string,
	targetPerm: CardInstance
): boolean {
	const ev = evaluatePermanent(state, targetPerm);
	if (ev.controllerId === actorId) return false;
	return activeRuleModifiers(state, 'ignoreHexproof', actorId).length > 0;
}

export function areOpponentWardTriggersSuppressedWave9(
	state: GameState,
	actorId: string,
	targetPerm: CardInstance
): boolean {
	const ev = evaluatePermanent(state, targetPerm);
	if (ev.controllerId === actorId) return false;
	return activeRuleModifiers(state, 'suppressWardTriggers', actorId).length > 0;
}

/**
 * Combat rules: `canAttackAsThoughHaste` (*Instill Energy*) and `mustAttackAttachedController` (*Public Enemy*).
 */
export function canAttackIgnoringSummoningSicknessWave9(
	state: GameState,
	creature: CardInstance
): boolean {
	const rules = getActiveCombatRulesForPermanent(state, creature);
	return rules.some((r) => r.rule.kind === 'canAttackAsThoughHaste');
}

export function getMustAttackAttachedControllerWave9(
	state: GameState,
	creature: CardInstance
): string | null {
	const rules = getActiveCombatRulesForPermanent(state, creature);
	for (const r of rules) {
		if (r.rule.kind !== 'mustAttackAttachedController') continue;
		const attachedId = r.sourcePerm.attachedToId;
		if (!attachedId) continue;
		for (const p of state.players) {
			if (p.lost) continue;
			const attachedPerm = p.battlefield.find((b) => b.instanceId === attachedId);
			if (attachedPerm) {
				return attachedPerm.controllerId !== creature.controllerId
					? attachedPerm.controllerId
					: null;
			}
		}
	}
	return null;
}

/**
 * Checks whether a spell gets flash from `"You may cast the first <filter> spell you cast each turn as though it had flash"` (*The Blue Spirit*).
 */
export function hasFirstMatchingSpellFlashWave9(
	state: GameState,
	actorId: string,
	cardInst: CardInstance,
	faceIndex = 0,
	fused = false
): boolean {
	const player = state.players.find((p) => p.playerId === actorId);
	if (!player) return false;
	const mods = activeRuleModifiers(state, 'castAsThoughFlash', actorId);
	if (mods.length === 0) return false;
	const spellView: CardInstance = {
		...cardInst,
		zone: 'stack',
		controllerId: actorId,
		activeFaceIndex: faceIndex
	};
	for (const m of mods) {
		if (!m.def.params?.firstMatchingThisTurn) continue;
		const filter = (m.def.params.spells as ObjectFilter | undefined) ?? {};
		if (!matchesObjectFilter(spellView, filter, { state, controllerId: actorId })) continue;
		const priorCards = player.spellsCastThisTurnCards ?? [];
		const alreadyCastMatching = priorCards.some((sc) =>
			matchesObjectFilter(
				{
					...spellView,
					instanceId: '__prior_flash_chk__',
					card: sc,
					activeFaceIndex: undefined
				},
				filter,
				{ state, controllerId: actorId }
			)
		);
		if (!alreadyCastMatching) return true;
	}
	return false;
}

/**
 * Enumerates `CastOption`s for Wave 9S `zonePlayPermission` statics (exiledWithSelf, requireCounter, cardOwner,
 * putIntoGraveyardFromNonBattlefieldThisTurn, library with grantHasteUntilEndOfTurn / unlimited, entersTapped,
 * grantFlash, spendManaAsAnyColor).
 */
export function collectWave9ZoneCastOptions(params: {
	state: GameState;
	actor: PlayerGameState;
	actorId: string;
	inst: CardInstance;
	fromZone: CastableSourceZone;
	faceIndex: number;
	isMultiFace: boolean;
	isAdventureFace: boolean;
	faceName: string;
	faceManaCost: string;
	faceTypes: string[];
	taxSuffix: string;
	mandatoryAdditionalCosts?: CostDef[];
	optionalAdditionalCosts?: CastOptionOptionalCost[];
	paymentAids?: CastCostAid[];
	adventureMods: Partial<SpellModifications>;
	requiresTarget: boolean;
	choosesX: boolean;
}): CastOption[] {
	const {
		state,
		actor,
		actorId,
		inst,
		fromZone,
		faceIndex,
		isMultiFace,
		faceName,
		faceManaCost,
		faceTypes,
		taxSuffix,
		mandatoryAdditionalCosts,
		optionalAdditionalCosts,
		paymentAids,
		adventureMods,
		requiresTarget,
		choosesX
	} = params;
	if (faceTypes.includes('Land') && !faceTypes.includes('Creature')) return [];
	const out: CastOption[] = [];
	const isYourTurn = state.players[state.activePlayerIndex]?.playerId === actorId;
	const stackProxy: CardInstance = {
		...inst,
		zone: 'stack',
		controllerId: actorId,
		activeFaceIndex: faceIndex
	};
	const faceIndexProp = isMultiFace ? { faceIndex } : {};
	const optionalProp =
		optionalAdditionalCosts && optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {};
	const paymentAidsProp = paymentAids && paymentAids.length > 0 ? { paymentAids } : {};
	const idPrefix = isMultiFace ? `f${faceIndex}:` : '';

	for (const perm of actor.battlefield) {
		if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
		const pCard = effectiveCardForObject(perm);
		const abs = activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'));
		for (let ai = 0; ai < abs.length; ai++) {
			const ab = abs[ai];
			if (ab.kind !== 'static' || ab.static.k !== 'zonePlayPermission') continue;
			const st = ab.static;
			const isWave9Feature = Boolean(
				st.exiledWithSelf ||
					st.requireCounter ||
					st.cardOwner ||
					st.putIntoGraveyardFromNonBattlefieldThisTurn ||
					st.grantHasteUntilEndOfTurn ||
					st.grantFlash ||
					st.spendManaAsAnyColor ||
					st.entersTapped
			);
			if (!isWave9Feature) continue;
			if (st.zone !== fromZone || st.allowSpells === false) continue;
			if (st.duringYourTurnOnly && !isYourTurn) continue;
			if (fromZone === 'library' && actor.library[0]?.instanceId !== inst.instanceId) continue;
			if (st.exiledWithSelf) {
				const ver = perm.objectVersion ?? 1;
				if (
					inst.exiledBy?.sourceInstanceId !== perm.instanceId ||
					(inst.exiledBy.sourceObjectVersion ?? 1) !== ver
				) {
					continue;
				}
			}
			if (st.requireCounter && (inst.counters[st.requireCounter] ?? 0) <= 0) continue;
			if (st.cardOwner === 'opponents' && inst.ownerId === actorId) continue;
			if (st.cardOwner === 'you' && inst.ownerId !== actorId) continue;
			if (
				st.putIntoGraveyardFromNonBattlefieldThisTurn &&
				(fromZone !== 'graveyard' || inst.enteredGraveyardFromNonBattlefieldTurn !== state.turnNumber)
			) {
				continue;
			}
			const fctx: FilterContext = { state, controllerId: actorId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, fctx)) continue;
			if (st.spellFilter && !matchesObjectFilter(stackProxy, { ...st.spellFilter, zone: undefined }, fctx)) {
				continue;
			}

			const slotMode = st.slotMode ?? 'unlimited';
			const slotKey = slotMode === 'oncePerTurn' ? `w9:${perm.instanceId}:${ai}:once` : undefined;
			if (slotKey && actor.usedStaticPlaySlotsThisTurn?.includes(slotKey)) continue;

			const permKind: CastOption['permission'] =
				fromZone === 'graveyard'
					? 'graveyard_permission'
					: fromZone === 'library'
						? 'library_top_permission'
						: 'exile_permission';

			out.push({
				id: `${idPrefix}${fromZone}:w9:${perm.instanceId}:${ai}`,
				label: `Cast ${faceName} from ${fromZone} (${pCard.name})`,
				costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
				fromZone,
				permission: permKind,
				...faceIndexProp,
				baseCost: { kind: 'printed' },
				...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
				...optionalProp,
				...paymentAidsProp,
				timing: st.grantFlash ? 'instant_only' : 'default',
				spellMods: {
					...adventureMods,
					...(st.exileIfPutIntoGraveyard ? { exileIfPutIntoGraveyard: true } : {}),
					...(st.entersTapped ? { entersTapped: true } : {}),
					...(st.grantHasteUntilEndOfTurn ? { grantHasteUntilEndOfTurn: true } : {})
				},
				choosesX,
				requiresTarget,
				...(slotKey ? { staticPlaySlotKey: slotKey } : {}),
				...(st.entersTapped ? { entersTapped: true } : {}),
				...(st.grantHasteUntilEndOfTurn ? { grantHasteUntilEndOfTurn: true } : {}),
				...(st.spendManaAsAnyColor ? { spendManaAsAnyColor: true } : {}),
				...(st.grantFlash ? { grantFlash: true } : {})
			});
		}
	}
	return out;
}

/**
 * Checks whether `actorId` can play a land `inst` from `fromZone === 'exile'` via a Wave 9S `zonePlayPermission`
 * (e.g. `exiledWithSelf` or `requireCounter` + `cardOwner`).
 */
export function hasWave9ExileLandPlayPermission(
	state: GameState,
	actorId: string,
	inst: CardInstance
): boolean {
	const actor = state.players.find((p) => p.playerId === actorId && !p.lost);
	if (!actor) return false;
	const isYourTurn = state.players[state.activePlayerIndex]?.playerId === actorId;
	for (const perm of actor.battlefield) {
		if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
		const pCard = effectiveCardForObject(perm);
		for (const ab of activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'))) {
			if (ab.kind !== 'static' || ab.static.k !== 'zonePlayPermission') continue;
			const st = ab.static;
			if (st.zone !== 'exile' || !st.allowLands) continue;
			if (st.duringYourTurnOnly && !isYourTurn) continue;
			if (st.exiledWithSelf) {
				const ver = perm.objectVersion ?? 1;
				if (
					inst.exiledBy?.sourceInstanceId !== perm.instanceId ||
					(inst.exiledBy.sourceObjectVersion ?? 1) !== ver
				) {
					continue;
				}
			}
			if (st.requireCounter && (inst.counters[st.requireCounter] ?? 0) <= 0) continue;
			if (st.cardOwner === 'opponents' && inst.ownerId === actorId) continue;
			if (st.cardOwner === 'you' && inst.ownerId !== actorId) continue;
			if (st.condition && !evaluateCondition(st.condition, { state, controllerId: actorId, source: perm })) {
				continue;
			}
			return true;
		}
	}
	return false;
}

/**
 * Enumerates `alt:evoke` options granted by active `spellGrantKeyword` statics (*Ashling, the Limitless*).
 */
export function collectWave9GrantedEvokeOptions(params: {
	state: GameState;
	actorId: string;
	inst: CardInstance;
	fromZone: CastableSourceZone;
	faceIndex: number;
	isMultiFace: boolean;
	faceName: string;
	faceTypes: string[];
	mandatoryAdditionalCosts?: CostDef[];
	optionalAdditionalCosts?: CastOptionOptionalCost[];
	paymentAids?: CastCostAid[];
	adventureMods: Partial<SpellModifications>;
	requiresTarget: boolean;
	choosesX: boolean;
	timing: CastOption['timing'];
}): CastOption[] {
	const {
		state,
		actorId,
		inst,
		fromZone,
		faceIndex,
		isMultiFace,
		faceName,
		faceTypes,
		mandatoryAdditionalCosts,
		optionalAdditionalCosts,
		paymentAids,
		adventureMods,
		requiresTarget,
		choosesX,
		timing
	} = params;
	if (faceTypes.includes('Instant') || faceTypes.includes('Sorcery') || faceTypes.includes('Land')) return [];
	if (fromZone !== 'hand') return [];
	const out: CastOption[] = [];
	const spellView: CardInstance = {
		...inst,
		zone: 'stack',
		controllerId: actorId,
		activeFaceIndex: faceIndex,
		castFromZone: 'hand'
	};
	forEachActiveStaticOnBattlefield(
		state,
		(perm, controllerId, srcName, def) => {
			if (controllerId !== actorId || def.k !== 'spellGrantKeyword') return;
			if (!def.keywords.includes('evoke') || !def.evokeCost) return;
			if (def.condition && !evaluateCondition(def.condition, { state, controllerId, source: perm })) {
				return;
			}
			if (!matchesObjectFilter(spellView, def.filter, { state, controllerId, source: perm })) {
				return;
			}
			const opt: CastOption = {
				id: isMultiFace ? `f${faceIndex}:alt:evoke` : 'alt:evoke',
				label: `Cast ${faceName} with Evoke ${def.evokeCost} (${srcName})`,
				costDisplay: def.evokeCost,
				fromZone,
				permission: 'zone_default',
				...(isMultiFace ? { faceIndex } : {}),
				baseCost: {
					kind: 'alternative',
					manaCost: def.evokeCost,
					costDefs: [{ k: 'mana', cost: def.evokeCost }]
				},
				...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
				...(optionalAdditionalCosts && optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
				...(paymentAids && paymentAids.length > 0 ? { paymentAids } : {}),
				timing,
				spellMods: {
					...adventureMods,
					evoked: true,
					castSummarySuffix: ' (Evoke)'
				},
				choosesX,
				requiresTarget
			};
			if (!out.some((o) => o.id === opt.id && o.costDisplay === opt.costDisplay)) {
				out.push(opt);
			}
		},
		'spellGrantKeyword'
	);
	return out;
}

/**
 * Returns synthetic `Replicate` optional additional cost entries granted by `spellGrantKeyword` (*Djinn Illuminatus*).
 */
export function getWave9GrantedReplicateOptionalCosts(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	faceIndex: number,
	fused: boolean,
	faceManaCost: string
): CastOptionOptionalCost[] {
	if (!faceManaCost) return [];
	const spellView: CardInstance = {
		...inst,
		zone: 'stack',
		controllerId: actorId,
		activeFaceIndex: faceIndex
	};
	let hasGrantedReplicate = false;
	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _srcName, def) => {
				if (hasGrantedReplicate || controllerId !== actorId || def.k !== 'spellGrantKeyword') return;
				if (!def.keywords.includes('replicate')) return;
				if (def.condition && !evaluateCondition(def.condition, { state, controllerId, source: perm })) {
					return;
				}
				if (!matchesObjectFilter(spellView, def.filter, { state, controllerId, source: perm })) return;
				hasGrantedReplicate = true;
			},
			'spellGrantKeyword'
		);
	});
	if (!hasGrantedReplicate) return [];
	return [
		{
			id: 'replicate:granted',
			label: `Replicate (${faceManaCost})`,
			costDisplay: faceManaCost,
			costDefs: [{ k: 'mana', cost: faceManaCost }],
			maxCount: 99,
			kickedTag: 'replicate',
			kickedTags: ['replicate']
		}
	];
}

/**
 * Returns additional spell keywords granted by Wave 9S features (`cascadeCount`, `paramN` on ripple, `nextSpellCascadeCount`).
 */
export function collectWave9ExtraGrantedSpellKeywords(
	state: GameState,
	casterId: string,
	spellView: CardInstance
): string[] {
	const extra: string[] = [];
	const caster = state.players.find((p) => p.playerId === casterId);
	const oneShotCascade = caster?.nextSpellCascadeCount ?? 0;
	for (let i = 0; i < oneShotCascade; i++) {
		extra.push('cascade');
	}
	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _srcName, def) => {
				if (controllerId !== casterId || def.k !== 'spellGrantKeyword') return;
				if (!def.cascadeCount && def.paramN === undefined) return;
				if (def.condition && !evaluateCondition(def.condition, { state, controllerId, source: perm })) {
					return;
				}
				if (!matchesObjectFilter(spellView, def.filter, { state, controllerId, source: perm })) {
					return;
				}
				if (def.cascadeCount && def.keywords.includes('cascade')) {
					// staticsWave6 pushes 1x 'cascade'; push the remaining (cascadeCount - 1) times!
					for (let i = 1; i < def.cascadeCount; i++) {
						extra.push('cascade');
					}
				}
				if (def.paramN !== undefined && def.keywords.includes('ripple')) {
					extra.push(`ripple ${def.paramN}`);
				}
			},
			'spellGrantKeyword'
		);
	});
	return extra;
}

/**
 * Checks whether an ability activation gets a Wave 9S `firstMatchingThisTurn` generic reduction (*Professor Hojo*).
 */
export function getFirstMatchingTargetedAbilityReductionWave9(
	state: GameState,
	activatorId: string,
	targetIds: string[]
): number {
	const player = state.players.find((p) => p.playerId === activatorId);
	if (!player || player.activatedTargetedOwnCreatureAbilityThisTurn) return 0;
	let reduction = 0;
	for (const { perm, controllerId } of abilityActivePermanents(state)) {
		if (controllerId !== activatorId) continue;
		const abs = activeAbilityDefs(effectiveCardForObject(perm), instanceFaceOptions(perm, 'battlefield'));
		for (const ab of abs) {
			if (ab.kind !== 'static' || ab.static.k !== 'costModifier') continue;
			const cm = ab.static;
			if (cm.affects.k !== 'ability' || !cm.affects.firstMatchingThisTurn) continue;
			if (cm.delta.mode !== 'reduce') continue;
			if (cm.condition && !evaluateCondition(cm.condition, { state, controllerId, source: perm })) {
				continue;
			}
			const tFilter = cm.affects.targetsFilter;
			if (tFilter) {
				const matchesAnyTarget = targetIds.some((tid) => {
					const found = state.players
						.flatMap((pl) => pl.battlefield)
						.find((b) => !b.phasedOut && b.instanceId === tid);
					if (!found) return false;
					return matchesObjectFilter(found, tFilter, { state, controllerId: activatorId, source: perm });
				});
				if (!matchesAnyTarget) continue;
			}
			reduction += cm.delta.generic;
		}
	}
	return reduction;
}

/**
 * Marks `activatedTargetedOwnCreatureAbilityThisTurn` when a player activates an ability targeting a creature they control.
 */
export function noteAbilityTargetedOwnCreatureWave9(
	state: GameState,
	activatorId: string,
	targetIds: string[]
): void {
	const player = state.players.find((p) => p.playerId === activatorId);
	if (!player || player.activatedTargetedOwnCreatureAbilityThisTurn) return;
	for (const tid of targetIds) {
		const perm = player.battlefield.find((b) => !b.phasedOut && b.instanceId === tid);
		if (!perm) continue;
		const ev = evaluatePermanent(state, perm);
		if (ev.isCreature && ev.controllerId === activatorId) {
			player.activatedTargetedOwnCreatureAbilityThisTurn = true;
			return;
		}
	}
}

/**
 * Checks whether `grantAbilitiesFromObjects` granted an ability id (`localId` like `'act_0'` or `'loyalty_0'`)
 * onto `perm` via `grantedAbilityById`.
 */
export function resolveGrantedObjectAbilityDefWave9(
	state: GameState,
	perm: CardInstance,
	abilityId: string
): EffectiveActivatedAbility | null {
	const sep = abilityId.indexOf(':');
	if (sep <= 0) return null;
	const srcPrefix = abilityId.slice(0, sep);
	const localId = abilityId.slice(sep + 1);
	if (srcPrefix === perm.instanceId) return null;
	const srcObj = state.players
		.flatMap((p) => [...p.battlefield, ...p.exile, ...p.graveyard])
		.find((c) => c.instanceId === srcPrefix);
	if (!srcObj) return null;
	const def = grantedAbilityById(effectiveCardForObject(srcObj), localId);
	if (!def || def.kind !== 'activated') return null;
	const abs = getCardActivatedAbilities(
		effectiveCardForObject(srcObj),
		[],
		undefined,
		undefined,
		perm.chosenColor,
		{ state, controllerId: perm.controllerId, source: perm }
	);
	const match = abs.find((a) => a.id === localId);
	return match ? { ...match, id: abilityId, grantSourceCard: srcObj.card } : null;
}

/**
 * Builds runtime `TriggerDef` for granted `'ripple N'` on stack.
 */
export function buildGrantedRippleTriggerWave9(n: number) {
	const spec = getKeywordSpec('ripple');
	if (!spec || spec.status !== 'implemented' || spec.implementation?.kind !== 'trigger') return null;
	return spec.implementation.buildTriggers({ name: 'ripple', n }, -1, { start: 0, end: 0 });
}

export type Wave9StaticExportsMarker = ActivatedAbility;
