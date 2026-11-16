/**
 * Wave 6 Track P17a — Statics, Combat Taxes, Replacements, Mana Retention & Rule Locks Runtime Module.
 *
 * Implements pure IR-driven runtime evaluation for:
 * 1. Top-of-library global reveal & opponent/all-player hand visibility (`CR 401.5, 400.2`).
 * 2. Slotted & life-for-mana-value static alternative cast permissions, conditional self-flash, & spell keyword grants (`CR 601.3, 118.9, 613.1f`).
 * 3. Declare-attackers / declare-blockers taxes (dynamic `Amount`, planeswalker-inclusive, colored/Phyrexian symbols), target-player attack locks, landwalk neutralization, virtual reach, dynamic extra block counts, virtual Crew/Saddle power boosts, and Flagbearer targeting (`CR 508.1, 509.1, 115.1`).
 * 4. Counter/player-counter multipliers & opponent halving, filtered/additive/companion token replacements, exile-with-counter replacements, draw replacements & caps, unspent mana retention/conversion, and `±M/±N` non-standard P/T counters (`CR 122.1a, 614.1, 106.4`).
 * 5. Off-battlefield creature subtype & color continuous grants (`CR 613.1d–e, 113.6`) and rule locks (untap-step caps, untap-during-other-untap-steps, filtered spell caps, library search locks/caps, cost-payment locks, and legend-rule exemptions `CR 704.5j`).
 *
 * Upholds ENGINE_INVARIANTS.md: zero rules-text reads, zero card-name comparisons, zero direct zone mutations, zero IR in GameState, and bounded loops only.
 */
import { compileCard } from '../compiler/index.ts';
import type {
	Amount,
	Condition,
	CostDef,
	ObjectFilter,
	PlayerFilter,
	ReplacementDef,
	StaticDef,
	TargetSpec,
	TokenSpec
} from '../ir.ts';
import {
	buildTokenScryfallCard,
	createEmptyManaPool,
	parseManaCost
} from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
// --- Track P22a ---
import { filterPlayerCountersGrantedWave8 } from './staticsWave8.ts';
// --- End Track P22a ---
import {
	createEmptyCounterMap,
	type CardInstance,
	type CastOption,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type SpellModifications,
	type TargetRef,
	type ZoneType
} from '../types.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { withStableLayerInputs } from './layerCache.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from './layers.ts';
import { emptyPlayerManaPoolForStepEnd } from './mana.ts';
import {
	evaluateAmount,
	evaluateCondition,
	matchesObjectFilter,
	objectManaValue
} from './objectFilter.ts';
import { tokenMultiplier } from './replace.ts';
import { forEachActiveStaticOnBattlefield } from './staticsDynamicAndCosts.ts';
import {
	getActiveCombatRulesForPermanent,
	getMaxAttackersBlockedByBlocker,
	validateAndSolveDefenderBlockersP8,
	type BlockerPairAssignment
} from './staticsLayersAndRestrictions.ts';
import { getActiveSimultaneousZoneBatchToken, withSimultaneousZoneBatch } from './triggers.ts';

const ALL_MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

// ---- 1. Hand & Global Top-of-Library Visibility (CR 401.5, CR 400.2) ------------------------

function evalStaticCond(
	cond: Condition | undefined,
	state: GameState,
	controllerId: string,
	source: CardInstance
): boolean {
	if (!cond) return true;
	return evaluateCondition(cond, { state, controllerId, source });
}

function matchesStaticPlayerScope(
	who: PlayerFilter,
	controllerId: string,
	candidateId: string,
	_state: GameState
): boolean {
	if (who.relation === 'you') return candidateId === controllerId;
	if (who.relation === 'opponent' || who.relation === 'each_opponent') {
		return candidateId !== controllerId;
	}
	return true;
}

/**
 * CR 400.2, 402: Returns true when `targetPlayerId` plays with their hand revealed to `viewerId`
 * (either via `players: 'all'` or via an opponent's `players: 'opponents'`).
 */
export function isPlayerHandRevealedToViewer(
	state: GameState,
	targetPlayerId: string,
	viewerId: string | null
): boolean {
	if (viewerId === targetPlayerId) return true;
	return withStableLayerInputs(state, () => {
		let revealed = false;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (revealed || def.k !== 'handVisibility') return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				if (def.players === 'all') {
					revealed = true;
				} else if (def.players === 'opponents' && targetPlayerId !== controllerId) {
					revealed = true;
				} else if (def.players === 'you' && targetPlayerId === controllerId) {
					revealed = true;
				}
			},
			'handVisibility'
		);
		return revealed;
	});
}

/**
 * CR 401.5: Returns true when `targetPlayerId`'s top library card is publicly revealed by a
 * global `players: 'all'` `topOfLibraryVisibility` static on the battlefield.
 */
export function isPlayerTopLibraryRevealedByGlobalStatic(
	state: GameState,
	targetPlayerId: string
): boolean {
	return withStableLayerInputs(state, () => {
		let revealed = false;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (revealed || def.k !== 'topOfLibraryVisibility' || def.mode !== 'reveal') return;
				if (def.players !== 'all' && controllerId !== targetPlayerId) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				revealed = true;
			},
			'topOfLibraryVisibility'
		);
		return revealed;
	});
}

// ---- 2. Static Cast Permissions, Conditional Self-Flash & Spell Keyword Grants --------------

function buildSpellViewForCast(
	cardInst: CardInstance,
	casterId: string,
	faceIndex: number,
	fused: boolean
): CardInstance {
	const resolved = resolveObjectFaces(cardInst.card, {
		zone: 'stack',
		faceIndex,
		fused
	});
	const stackCard: ScryfallCard =
		resolved.name === cardInst.card.name && resolved.typeLine === cardInst.card.typeLine
			? cardInst.card
			: {
					...cardInst.card,
					name: resolved.name,
					manaCost: resolved.manaCost,
					typeLine: resolved.typeLine,
					colors: resolved.colors
				};
	return {
		...cardInst,
		card: stackCard,
		controllerId: casterId,
		zone: 'stack'
	};
}

/**
 * CR 118.9, 601.3e: Collects Wave 6 static alternative cast options (`payLifeEqualToManaValue`,
 * `slotMode: 'oncePerTurn'`, `duringYourTurnOnly`, `entersWithCounters`) not handled by base
 * `collectStaticAltCastOptions`.
 */
export function isP17aWave6AltCastVariant(
	st: Extract<StaticDef, { k: 'altCastPermission' }>
): boolean {
	if (
		st.onceEachTurn ||
		st.grantFlash ||
		st.anyPlayer ||
		st.dynamicManaCostFromMV ||
		st.maxManaValueBySelfCounters ||
		st.maxManaValueByControlledCount ||
		st.enterCounters ||
		st.additionalOnly ||
		st.additionalPerMetric ||
		st.requireZonePermission ||
		st.payLifeEqualToSpellMV
	) {
		return false;
	}
	return (
		st.manaCost === '__PRINTED__' ||
		Boolean(st.payLifeEqualToManaValue) ||
		Boolean(st.slotMode && st.slotMode !== 'unlimited') ||
		Boolean(st.duringYourTurnOnly) ||
		Boolean(st.entersWithCounters)
	);
}

export function collectWave6StaticAltCastOptions(
	state: GameState,
	player: PlayerGameState,
	cardInst: CardInstance,
	faceIndex: number,
	fused: boolean,
	isLegalTiming: boolean,
	requiresTarget: boolean,
	choosesX: boolean,
	hasZonePermission = true
): CastOption[] {
	if (!isLegalTiming) return [];
	const resolved = resolveObjectFaces(cardInst.card, { zone: 'stack', faceIndex, fused });
	if (/\bLand\b/i.test(resolved.typeLine) && !/\b(Creature|Spell|Instant|Sorcery|Artifact|Enchantment|Planeswalker|Battle)\b/i.test(resolved.typeLine)) {
		return [];
	}
	const fromZone = cardInst.zone;
	if (fromZone === 'library' && player.library[0]?.instanceId !== cardInst.instanceId) {
		return [];
	}

	const spellView = buildSpellViewForCast(cardInst, player.playerId, faceIndex, fused);
	const mv = Math.max(0, objectManaValue(state, spellView));
	const isYourTurn = state.players[state.activePlayerIndex]?.playerId === player.playerId;
	const usedSlots = new Set(player.usedStaticPlaySlotsThisTurn ?? []);
	const out: CastOption[] = [];

	withStableLayerInputs(state, () => {
		let idx = 0;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, sourceName, def) => {
				if (controllerId !== player.playerId) return;
				if (def.k !== 'altCastPermission') return;
				if (!isP17aWave6AltCastVariant(def)) return;
				const myIdx = idx++;
				if (def.duringYourTurnOnly && !isYourTurn) return;
				const slotKey =
					def.slotMode === 'oncePerTurn' ? `${perm.instanceId}:w6alt:${myIdx}` : undefined;
				if (slotKey && usedSlots.has(slotKey)) return;

				if (def.allowedZones) {
					if (!def.allowedZones.includes(fromZone)) return;
				} else if (!hasZonePermission) {
					return;
				}
				if (def.affects === 'self') {
					if (perm.instanceId !== cardInst.instanceId) return;
				} else if (
					!matchesObjectFilter(spellView, def.affects.filter, {
						state,
						controllerId,
						source: perm
					})
				) {
					return;
				}
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;

				const lifeDefs: CostDef[] =
					def.payLifeEqualToManaValue && mv > 0
						? [{ k: 'payLife', amount: { k: 'const', n: mv } }]
						: [];
				const extraDefs = [...(def.costDefs ?? []), ...lifeDefs];
				const manaCost = def.payLifeEqualToManaValue ? '{0}' : def.manaCost;
				const spellMods: SpellModifications = {};
				if (def.entersWithCounters) {
					const map: Record<string, number> = {};
					for (const [ck, cv] of Object.entries(def.entersWithCounters)) {
						if (typeof cv === 'number' && cv > 0) map[ck] = cv;
					}
					if (Object.keys(map).length > 0) spellMods.entersWithCounters = map;
				}
				const isFree = (manaCost === '{0}' || manaCost === '') && extraDefs.length === 0;
				const costDisplay = def.payLifeEqualToManaValue
					? `Pay ${mv} life`
					: isFree
						? 'Without paying mana cost'
						: manaCost;

				out.push({
					id: `static_w6_alt:${perm.instanceId}:${myIdx}:${faceIndex}${fused ? ':fused' : ''}`,
					label: `${sourceName} (${costDisplay})`,
					costDisplay,
					fromZone: fromZone as CastOption['fromZone'],
					permission: 'static_alt',
					...(faceIndex > 0 ? { faceIndex } : {}),
					...(fused ? { fused: true } : {}),
					baseCost: isFree
						? { kind: 'free' }
						: {
								kind: 'alternative',
								manaCost,
								...(extraDefs.length > 0 ? { costDefs: extraDefs } : {})
							},
					timing: 'default',
					spellMods,
					choosesX: isFree || def.payLifeEqualToManaValue ? false : choosesX,
					requiresTarget,
					...(slotKey ? { staticPlaySlotKey: slotKey } : {}),
					...(def.payLifeEqualToManaValue ? { payLifeEqualToManaValue: true } : {})
				});
			},
			'altCastPermission'
		);
	});

	// Self-scoped altCastPermission on cardInst in graveyard/hand/exile with Wave 6 riders
	if (fromZone === 'graveyard' || fromZone === 'hand' || fromZone === 'exile') {
		const defs = activeAbilityDefs(effectiveCardForObject(cardInst), {
			zone: fromZone,
			faceIndex,
			fused
		});
		for (let i = 0; i < defs.length; i++) {
			const ab = defs[i];
			if (ab.kind !== 'static' || ab.static.k !== 'altCastPermission') continue;
			const st = ab.static;
			if (st.affects !== 'self') continue;
			const isPrintedWithRiders = st.manaCost === '__PRINTED__';
			if (!isP17aWave6AltCastVariant(st)) continue;
			if (st.duringYourTurnOnly && !isYourTurn) continue;
			const allowedZones = st.allowedZones ?? ['hand'];
			if (!allowedZones.includes(fromZone)) continue;
			if (!evalStaticCond(st.condition, state, player.playerId, cardInst)) continue;

			const lifeDefs: CostDef[] =
				st.payLifeEqualToManaValue && mv > 0
					? [{ k: 'payLife', amount: { k: 'const', n: mv } }]
					: [];
			const extraDefs = [...(st.costDefs ?? []), ...lifeDefs];
			const manaCost = st.payLifeEqualToManaValue
				? '{0}'
				: isPrintedWithRiders
					? resolved.manaCost || '{0}'
					: st.manaCost;
			const spellMods: SpellModifications = {};
			if (st.entersWithCounters) {
				const map: Record<string, number> = {};
				for (const [ck, cv] of Object.entries(st.entersWithCounters)) {
					if (typeof cv === 'number' && cv > 0) map[ck] = cv;
				}
				if (Object.keys(map).length > 0) spellMods.entersWithCounters = map;
			}
			const isFree =
				!isPrintedWithRiders && (manaCost === '{0}' || manaCost === '') && extraDefs.length === 0;
			out.push({
				id: `self_w6_alt:${cardInst.instanceId}:${i}:${faceIndex}`,
				label: isPrintedWithRiders ? `Cast from ${fromZone}` : `Alternative cost (${manaCost})`,
				costDisplay: manaCost,
				fromZone: fromZone as CastOption['fromZone'],
				permission: 'static_alt',
				...(faceIndex > 0 ? { faceIndex } : {}),
				baseCost: isPrintedWithRiders
					? { kind: 'printed' }
					: isFree
						? { kind: 'free' }
						: {
								kind: 'alternative',
								manaCost,
								...(extraDefs.length > 0 ? { costDefs: extraDefs } : {})
							},
				...(isPrintedWithRiders && extraDefs.length > 0
					? { mandatoryAdditionalCosts: extraDefs }
					: {}),
				timing: 'default',
				spellMods,
				choosesX: isFree ? false : choosesX,
				requiresTarget,
				...(st.payLifeEqualToManaValue ? { payLifeEqualToManaValue: true } : {})
			});
		}
	}

	return out;
}

/**
 * CR 601.3b: Checks self-scoped `"You may cast ~ as though it had flash [if <condition>]"` on a
 * card in a non-battlefield zone.
 */
export function hasSelfConditionalFlashGrant(
	state: GameState,
	actorId: string,
	spellInst: CardInstance | undefined
): boolean {
	if (!spellInst) return false;
	const defs = activeAbilityDefs(effectiveCardForObject(spellInst), instanceFaceOptions(spellInst));
	for (const ab of defs) {
		if (
			ab.kind !== 'static' ||
			ab.static.k !== 'ruleModifier' ||
			ab.static.rule !== 'castAsThoughFlash'
		) {
			continue;
		}
		if (!ab.static.params?.selfOnly) continue;
		if (evalStaticCond(ab.static.condition, state, actorId, spellInst)) {
			return true;
		}
	}
	return false;
}

/**
 * CR 613.1f / 113.6: Returns spell keywords (e.g. `'convoke'`, `'delve'`, `'improvise'`,
 * `'rebound'`, `'cascade'`) granted to `spellInst` when cast by `casterId`.
 */
export function getGrantedSpellKeywordsForSpell(
	state: GameState,
	casterId: string,
	spellInst: CardInstance,
	faceIndex = 0,
	fused = false
): string[] {
	const spellView = buildSpellViewForCast(spellInst, casterId, faceIndex, fused);
	const out: string[] = [];
	const seenSingle = new Set<string>();
	const cumulativeSpellKws = new Set(['cascade', 'storm', 'gravestorm']);
	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (controllerId !== casterId || def.k !== 'spellGrantKeyword') return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				if (
					!matchesObjectFilter(spellView, def.filter, {
						state,
						controllerId,
						source: perm
					})
				) {
					return;
				}
				for (const rawKw of def.keywords) {
					const kw = rawKw.toLowerCase();
					if (cumulativeSpellKws.has(kw)) {
						out.push(kw);
					} else if (!seenSingle.has(kw)) {
						seenSingle.add(kw);
						out.push(kw);
					}
				}
			},
			'spellGrantKeyword'
		);
	});
	return out;
}

// ---- 3. Combat Taxes, Restrictions, Crew/Saddle Virtual Power & Flagbearer ------------------

export interface CombatTaxSummary {
	genericTotal: number;
	manaSymbols: string[];
	combinedManaCost: string;
	hasTax: boolean;
}

function buildCombinedTaxCostString(genericTotal: number, manaSymbols: string[]): string {
	const parts: string[] = [];
	if (genericTotal > 0) parts.push(`{${genericTotal}}`);
	for (const sym of manaSymbols) {
		parts.push(sym.startsWith('{') ? sym : `{${sym}}`);
	}
	return parts.join('');
}

function evaluateTaxUnitCount(
	params: Record<string, unknown> | undefined,
	state: GameState,
	controllerId: string,
	source: CardInstance
): number {
	const base = typeof params?.generic === 'number' ? params.generic : 0;
	const dyn = params?.dynamicAmount as Amount | undefined;
	if (!dyn) return Math.max(0, base);
	const mult = Math.max(
		0,
		evaluateAmount(dyn, {
			state,
			controllerId,
			source
		})
	);
	return base > 0 ? base * mult : mult;
}

function matchesAffectedCombatant(
	affected: unknown,
	combatant: CardInstance,
	source: CardInstance,
	controllerId: string,
	state: GameState
): boolean {
	if (!affected) return true;
	if (affected === 'self') return combatant.instanceId === source.instanceId;
	if (affected === 'attachedTo') return source.attachedToId === combatant.instanceId;
	if (typeof affected === 'object') {
		return matchesObjectFilter(combatant, affected as ObjectFilter, {
			state,
			controllerId,
			source
		});
	}
	return true;
}

/**
 * CR 508.1d,h–j: Computes total attack tax across all declared `assignments`, including:
 * - defending player only (`defending: 'you'`, default)
 * - defending planeswalkers only (`defending: 'planeswalkersYouControl'`)
 * - defending player OR planeswalkers (`defending: 'youOrPlaneswalkersYouControl'`)
 * - self / enchanted creature attack taxes (`params.affected`)
 * - dynamic `Amount` scaling (`params.dynamicAmount`) and colored/Phyrexian symbols (`params.manaSymbol`).
 */
export function computeDeclareAttackersTaxSummary(
	state: GameState,
	attackerPlayerId: string,
	assignments: ReadonlyArray<{
		attackerId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string;
		defenderBattleId?: string;
	}>
): CombatTaxSummary {
	let genericTotal = 0;
	const manaSymbols: string[] = [];
	if (assignments.length === 0) {
		return { genericTotal: 0, manaSymbols, combinedManaCost: '', hasTax: false };
	}

	const attackerPlayer = state.players.find((p) => p.playerId === attackerPlayerId);
	const attackerMap = new Map<string, CardInstance>();
	if (attackerPlayer) {
		for (const c of attackerPlayer.battlefield) {
			attackerMap.set(c.instanceId, c);
		}
	}

	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'ruleModifier' || def.rule !== 'attackTax') return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				const params = def.params;
				const hasExplicitAffected = Boolean(params?.affected);
				if (!hasExplicitAffected && !matchesStaticPlayerScope(def.who, controllerId, attackerPlayerId, state)) {
					return;
				}
				const defendingMode =
					(params?.defending as
						| 'you'
						| 'planeswalkersYouControl'
						| 'youOrPlaneswalkersYouControl'
						| undefined) ?? (hasExplicitAffected ? undefined : 'you');

				let matchingAttackers = 0;
				for (const assign of assignments) {
					if (assign.defenderBattleId) continue;
					const atk = attackerMap.get(assign.attackerId);
					if (!atk) continue;
					if (!matchesAffectedCombatant(params?.affected, atk, perm, controllerId, state)) {
						continue;
					}
					if (defendingMode === 'you') {
						if (assign.defenderPlayerId !== controllerId || assign.defenderPlaneswalkerId) continue;
					} else if (defendingMode === 'planeswalkersYouControl') {
						if (assign.defenderPlayerId !== controllerId || !assign.defenderPlaneswalkerId) continue;
					} else if (defendingMode === 'youOrPlaneswalkersYouControl') {
						if (assign.defenderPlayerId !== controllerId) continue;
					}
					matchingAttackers++;
				}
				if (matchingAttackers <= 0) return;

				const sym = typeof params?.manaSymbol === 'string' ? params.manaSymbol : undefined;
				if (sym) {
					const perUnit = params?.dynamicAmount
						? Math.max(0, evaluateAmount(params.dynamicAmount as Amount, { state, controllerId, source: perm }))
						: 1;
					const totalCount = matchingAttackers * perUnit;
					for (let k = 0; k < totalCount; k++) {
						manaSymbols.push(sym);
					}
				} else {
					const unitGeneric = evaluateTaxUnitCount(params, state, controllerId, perm);
					genericTotal += matchingAttackers * unitGeneric;
				}
			},
			'ruleModifier',
			['attackTax']
		);
	});

	const combinedManaCost = buildCombinedTaxCostString(genericTotal, manaSymbols);
	return {
		genericTotal,
		manaSymbols,
		combinedManaCost,
		hasTax: genericTotal > 0 || manaSymbols.length > 0
	};
}

/**
 * CR 509.1c,f: Computes total block tax across declared `assignments` (`rule: 'blockTax'`).
 */
export function computeDeclareBlockersTaxSummary(
	state: GameState,
	blockerPlayerId: string,
	assignments: ReadonlyArray<{ blockerId: string; attackerIds: string[] }>
): CombatTaxSummary {
	let genericTotal = 0;
	const manaSymbols: string[] = [];
	const activeBlocks = assignments.filter((a) => a.attackerIds.length > 0);
	if (activeBlocks.length === 0) {
		return { genericTotal: 0, manaSymbols, combinedManaCost: '', hasTax: false };
	}

	const blockerPlayer = state.players.find((p) => p.playerId === blockerPlayerId);
	const blockerMap = new Map<string, CardInstance>();
	if (blockerPlayer) {
		for (const c of blockerPlayer.battlefield) {
			blockerMap.set(c.instanceId, c);
		}
	}
	const allBattlefieldMap = new Map<string, CardInstance>();
	for (const pl of state.players) {
		for (const c of pl.battlefield) {
			allBattlefieldMap.set(c.instanceId, c);
		}
	}

	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'ruleModifier' || def.rule !== 'blockTax') return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				const params = def.params;
				const hasExplicitAffected = Boolean(params?.affected);
				if (!hasExplicitAffected && !matchesStaticPlayerScope(def.who, controllerId, blockerPlayerId, state)) {
					return;
				}
				const attackerFilter = params?.attackerFilter as ObjectFilter | undefined;

				let matchingBlockers = 0;
				for (const b of activeBlocks) {
					const blk = blockerMap.get(b.blockerId);
					if (!blk) continue;
					if (!matchesAffectedCombatant(params?.affected, blk, perm, controllerId, state)) continue;
					if (attackerFilter) {
						const matchesAnyAtk = b.attackerIds.some((aid) => {
							const atk = allBattlefieldMap.get(aid);
							return Boolean(
								atk && matchesObjectFilter(atk, attackerFilter, { state, controllerId, source: perm })
							);
						});
						if (!matchesAnyAtk) continue;
					}
					matchingBlockers++;
				}
				if (matchingBlockers <= 0) return;

				const sym = typeof params?.manaSymbol === 'string' ? params.manaSymbol : undefined;
				if (sym) {
					for (let k = 0; k < matchingBlockers; k++) manaSymbols.push(sym);
				} else {
					const unitGeneric = evaluateTaxUnitCount(params, state, controllerId, perm);
					genericTotal += matchingBlockers * unitGeneric;
				}
			},
			'ruleModifier',
			['blockTax']
		);
	});

	const combinedManaCost = buildCombinedTaxCostString(genericTotal, manaSymbols);
	return {
		genericTotal,
		manaSymbols,
		combinedManaCost,
		hasTax: genericTotal > 0 || manaSymbols.length > 0
	};
}

/**
 * CR 508.1c: Checks defender-scoped attack restrictions (`cantAttackYou`,
 * `cantAttackYouOrPlaneswalkers`).
 */
export function checkDefenderScopedAttackRestriction(
	state: GameState,
	attacker: CardInstance,
	defenderPlayerId: string,
	defenderPlaneswalkerId?: string,
	defenderBattleId?: string
): { restricted: boolean; sourceName?: string } {
	if (defenderBattleId) return { restricted: false };
	return withStableLayerInputs(state, () => {
		let result: { restricted: boolean; sourceName?: string } = { restricted: false };
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, sourceName, def) => {
				if (result.restricted || def.k !== 'restriction') return;
				if (
					def.restriction !== 'cantAttackYou' &&
					def.restriction !== 'cantAttackYouOrPlaneswalkers'
				) {
					return;
				}
				if (defenderPlayerId !== controllerId) return;
				if (def.restriction === 'cantAttackYou' && defenderPlaneswalkerId) return;
				if (!matchesAffectedCombatant(def.affected, attacker, perm, controllerId, state)) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				result = { restricted: true, sourceName };
			},
			'restriction'
		);
		return result;
	});
}

/**
 * CR 509.1b / 702.14c: Returns true if an active `ignoreLandwalk` combatRule allows `attacker`'s
 * `landwalkKeyword` (e.g. `'swampwalk'`, `'islandwalk'`) to be ignored during declare blockers.
 */
export function isLandwalkIgnoredForAttacker(
	state: GameState,
	attacker: CardInstance,
	landwalkKeyword: string
): boolean {
	const kwLower = landwalkKeyword.toLowerCase();
	const rules = getActiveCombatRulesForPermanent(state, attacker);
	return rules.some(
		(r) => r.rule.kind === 'ignoreLandwalk' && r.rule.keyword.toLowerCase() === kwLower
	);
}

/**
 * CR 509.1b / 702.17b: Returns true if `blocker` has an active `canBlockAsThoughReach` combatRule
 * that applies against `attacker`.
 */
export function canBlockAttackerAsThoughReach(
	state: GameState,
	blocker: CardInstance,
	attacker: CardInstance
): boolean {
	const rules = getActiveCombatRulesForPermanent(state, blocker);
	for (const r of rules) {
		if (r.rule.kind !== 'canBlockAsThoughReach') continue;
		if (
			!r.rule.filter ||
			matchesObjectFilter(attacker, r.rule.filter, {
				state,
				controllerId: r.sourceControllerId,
				source: r.sourcePerm
			})
		) {
			return true;
		}
	}
	return false;
}

/**
 * CR 509.1b: Evaluates dynamic additional block capacity (`additionalBlockCountDynamic`) for `blocker`.
 */
export function getDynamicAdditionalBlockCapacity(state: GameState, blocker: CardInstance): number {
	let extra = 0;
	for (const r of getActiveCombatRulesForPermanent(state, blocker)) {
		if (r.rule.kind !== 'additionalBlockCountDynamic') continue;
		extra += Math.max(
			0,
			evaluateAmount(r.rule.amount, {
				state,
				controllerId: r.sourceControllerId,
				source: r.sourcePerm
			})
		);
	}
	return extra;
}

/**
 * CR 509.1a–d: Wraps `validateAndSolveDefenderBlockersP8` with Wave 6 dynamic multi-block capacity
 * (`additionalBlockCountDynamic`) and `blockTax` affordability checks.
 */
export function validateDefenderBlockersWithWave6(
	state: GameState,
	defender: PlayerGameState,
	assignments: ReadonlyArray<BlockerPairAssignment>,
	getPairErrorFn: (state: GameState, blocker: CardInstance, attacker: CardInstance) => string | null,
	canPayBlockTaxCost: (combinedManaCost: string) => boolean
):
	| { ok: true; blockerCountsByAttacker: Map<string, string[]>; combinedBlockTaxManaCost: string }
	| { ok: false; error: string } {
	const byBlocker = new Map<string, BlockerPairAssignment[]>();
	for (const a of assignments) {
		const list = byBlocker.get(a.blockerInstanceId) ?? [];
		list.push(a);
		byBlocker.set(a.blockerInstanceId, list);
	}

	const baseAssignments: BlockerPairAssignment[] = [];
	const surplusAssignments: BlockerPairAssignment[] = [];
	for (const [bId, list] of byBlocker.entries()) {
		const blocker = defender.battlefield.find((c) => !c.phasedOut && c.instanceId === bId);
		const staticCap = blocker ? getMaxAttackersBlockedByBlocker(state, blocker) : 1;
		const dynExtra =
			blocker && Number.isFinite(staticCap)
				? getDynamicAdditionalBlockCapacity(state, blocker)
				: 0;
		const totalCap = staticCap + dynExtra;
		if (list.length > totalCap) {
			return {
				ok: false,
				error:
					totalCap === 1
						? 'Strict Rules Violation: A creature cannot block more than one attacking creature (CR 509.1a).'
						: `Strict Rules Violation: ${blocker?.card.name ?? 'Blocker'} can block at most ${totalCap} attacking creatures (CR 509.1a).`
			};
		}
		const seenAtk = new Set<string>();
		for (let i = 0; i < list.length; i++) {
			const item = list[i]!;
			if (seenAtk.has(item.attackerInstanceId)) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${blocker?.card.name ?? 'Blocker'} cannot be assigned to block the same attacker twice (CR 509.1a).`
				};
			}
			seenAtk.add(item.attackerInstanceId);
			if (i < staticCap) baseAssignments.push(item);
			else surplusAssignments.push(item);
		}
	}

	for (const surp of surplusAssignments) {
		const blocker = defender.battlefield.find((c) => !c.phasedOut && c.instanceId === surp.blockerInstanceId);
		const atkEntry = state.combat.attackers.find((a) => a.attackerInstanceId === surp.attackerInstanceId);
		if (!blocker || !atkEntry || atkEntry.defenderPlayerId !== defender.playerId) {
			return { ok: false, error: 'Invalid blocking assignment.' };
		}
		const atkOwner = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const atkCard = atkOwner?.battlefield.find((c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId);
		if (atkCard) {
			const pairErr = getPairErrorFn(state, blocker, atkCard);
			if (pairErr) return { ok: false, error: pairErr };
		}
	}

	const baseRes = validateAndSolveDefenderBlockersP8(state, defender, baseAssignments, getPairErrorFn);
	if (!baseRes.ok) {
		return { ok: false, error: baseRes.error };
	}

	const mergedCounts = new Map<string, string[]>();
	for (const [k, v] of baseRes.blockerCountsByAttacker.entries()) {
		mergedCounts.set(k, [...v]);
	}
	for (const surp of surplusAssignments) {
		const cur = mergedCounts.get(surp.attackerInstanceId) ?? [];
		cur.push(surp.blockerInstanceId);
		mergedCounts.set(surp.attackerInstanceId, cur);
	}

	const taxBlocks: Array<{ blockerId: string; attackerIds: string[] }> = [];
	for (const [bId, list] of byBlocker.entries()) {
		taxBlocks.push({ blockerId: bId, attackerIds: list.map((x) => x.attackerInstanceId) });
	}
	const taxSummary = computeDeclareBlockersTaxSummary(state, defender.playerId, taxBlocks);
	if (taxSummary.hasTax && !canPayBlockTaxCost(taxSummary.combinedManaCost)) {
		return {
			ok: false,
			error: `Strict Rules Violation: Blocking requires paying ${taxSummary.combinedManaCost}, and you have insufficient mana (CR 509.1d).`
		};
	}

	return {
		ok: true,
		blockerCountsByAttacker: mergedCounts,
		combinedBlockTaxManaCost: taxSummary.combinedManaCost
	};
}

/**
 * CR 702.122a / 702.171a: Computes the effective power weight of `creature` when crewing a Vehicle
 * (`tag === 'crew'`) or saddling a Mount (`tag === 'saddle'`), accounting for `crewSaddlePowerMod`
 * (`"as though its power were N greater"` and `"using its toughness rather than its power"`).
 */
export function getEffectiveCrewOrSaddlePower(
	state: GameState,
	creature: CardInstance,
	tag: 'crew' | 'saddle'
): number {
	const ev = evaluatePermanent(state, creature);
	let base = ev.power ?? 0;
	let delta = 0;
	let useToughness = false;
	for (const r of getActiveCombatRulesForPermanent(state, creature)) {
		if (r.rule.kind !== 'crewSaddlePowerMod') continue;
		if (r.rule.appliesTo !== 'both' && r.rule.appliesTo !== tag) continue;
		if (r.rule.useToughness) useToughness = true;
		if (typeof r.rule.delta === 'number') delta += r.rule.delta;
	}
	if (useToughness) base = ev.toughness ?? 0;
	return base + delta;
}

/**
 * Adjusts `tapSubsetSum` cost definitions (and auto-selects optimal candidates when `chosenObjects`
 * is omitted) so `runtime/costs.ts` honors `crewSaddlePowerMod` virtual power without mutating state.
 */
export function adjustCostDefsForCrewSaddleVirtualPower(
	state: GameState,
	actor: PlayerGameState,
	source: CardInstance,
	defs: CostDef[],
	chosenObjects?: string[][]
): { defs: CostDef[]; chosenObjects?: string[][] } {
	const hasCrewOrSaddle = defs.some(
		(d) =>
			d.k === 'tapSubsetSum' &&
			d.metric === 'power' &&
			(d.restrictionTag === 'crew' || d.restrictionTag === 'saddle')
	);
	if (!hasCrewOrSaddle) return { defs, chosenObjects };

	// Fast check: do any untapped creatures controlled by actor have non-zero virtual bonus?
	let anyBonus = false;
	const realPowers = new Map<string, number>();
	const virtPowers = new Map<string, { crew: number; saddle: number }>();
	withStableLayerInputs(state, () => {
		for (const c of actor.battlefield) {
			if (c.phasedOut || c.tapped) continue;
			const ev = evaluatePermanent(state, c);
			const rp = ev.power ?? 0;
			const cp = getEffectiveCrewOrSaddlePower(state, c, 'crew');
			const sp = getEffectiveCrewOrSaddlePower(state, c, 'saddle');
			realPowers.set(c.instanceId, rp);
			virtPowers.set(c.instanceId, { crew: cp, saddle: sp });
			if (cp !== rp || sp !== rp) anyBonus = true;
		}
	});
	if (!anyBonus) return { defs, chosenObjects };

	let objIdx = 0;
	const nextChosen: string[][] | undefined = chosenObjects ? [...chosenObjects] : [];
	let wroteAutoChoice = false;
	const nextDefs = defs.map((def) => {
		const consumesObjectSlot =
			def.k === 'tapOthers' ||
			def.k === 'tapSubsetSum' ||
			(def.k === 'sacrifice' && def.filter !== 'self') ||
			(def.k === 'discard' && def.filter !== 'self') ||
			(def.k === 'exileFrom' && def.filter !== 'self') ||
			(def.k === 'revealFromHand' && def.filter !== 'self') ||
			(def.k === 'removeCounters' && def.from !== 'self') ||
			(def.k === 'returnToHand' && def.filter !== 'self');
		if (!consumesObjectSlot) return def;
		const mySlot = objIdx++;
		if (
			def.k !== 'tapSubsetSum' ||
			def.metric !== 'power' ||
			(def.restrictionTag !== 'crew' && def.restrictionTag !== 'saddle')
		) {
			return def;
		}
		const tag = def.restrictionTag;
		const origMin = Math.max(
			0,
			evaluateAmount(def.minTotal, { state, controllerId: actor.playerId, source })
		);
		const candidates = actor.battlefield.filter((c) => {
			if (c.phasedOut || c.tapped) return false;
			if (def.excludeSelf && c.instanceId === source.instanceId) return false;
			return matchesObjectFilter(c, def.filter, {
				state,
				controllerId: actor.playerId,
				source
			});
		});

		const explicitIds = chosenObjects?.[mySlot];
		if (explicitIds) {
			const candSet = new Set(candidates.map((c) => c.instanceId));
			let bonusSum = 0;
			for (const id of explicitIds) {
				if (!candSet.has(id)) continue;
				const rp = Math.max(0, realPowers.get(id) ?? 0);
				const vp = Math.max(0, virtPowers.get(id)?.[tag] ?? rp);
				bonusSum += vp - rp;
			}
			if (bonusSum <= 0) return def;
			return {
				...def,
				minTotal: { k: 'const' as const, n: Math.max(0, origMin - bonusSum) }
			};
		}

		// Auto-select / legality probe when explicitIds not provided
		const totalVirt = candidates.reduce(
			(acc, c) => acc + Math.max(0, virtPowers.get(c.instanceId)?.[tag] ?? 0),
			0
		);
		if (totalVirt < origMin) return def;

		const sorted = [...candidates].sort(
			(a, b) =>
				(virtPowers.get(b.instanceId)?.[tag] ?? 0) - (virtPowers.get(a.instanceId)?.[tag] ?? 0)
		);
		const picked: CardInstance[] = [];
		let accVirt = 0;
		for (const c of sorted) {
			const w = Math.max(0, virtPowers.get(c.instanceId)?.[tag] ?? 0);
			if (w <= 0) continue;
			picked.push(c);
			accVirt += w;
			if (accVirt >= origMin) break;
		}
		// Trim redundant high-weight picks if smaller subset suffices
		for (let i = picked.length - 1; i >= 0; i--) {
			const w = Math.max(0, virtPowers.get(picked[i].instanceId)?.[tag] ?? 0);
			if (accVirt - w >= origMin && picked.length > 1) {
				accVirt -= w;
				picked.splice(i, 1);
			}
		}
		const bonusSum = picked.reduce((acc, c) => {
			const rp = Math.max(0, realPowers.get(c.instanceId) ?? 0);
			const vp = Math.max(0, virtPowers.get(c.instanceId)?.[tag] ?? rp);
			return acc + (vp - rp);
		}, 0);
		if (nextChosen) {
			nextChosen[mySlot] = picked.map((c) => c.instanceId);
			wroteAutoChoice = true;
		}
		if (bonusSum <= 0) return def;
		return {
			...def,
			minTotal: { k: 'const' as const, n: Math.max(0, origMin - bonusSum) }
		};
	});

	return {
		defs: nextDefs,
		chosenObjects: chosenObjects ?? (wroteAutoChoice ? nextChosen : undefined)
	};
}

/**
 * CR 115.1 (Flagbearer): Collects `instanceId`s of battlefield Flagbearer permanents when an
 * opponent of `actorId` controls an active `rule: 'flagbearer'` static ability.
 */
export function getRequiredFlagbearerIdsForActor(state: GameState, actorId: string): Set<string> {
	const flagbearerIds = new Set<string>();
	withStableLayerInputs(state, () => {
		let activeOpponentFlagbearerRule = false;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (activeOpponentFlagbearerRule) return;
				if (def.k !== 'ruleModifier' || def.rule !== 'flagbearer') return;
				if (controllerId === actorId) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				activeOpponentFlagbearerRule = true;
			},
			'ruleModifier',
			['flagbearer']
		);
		if (!activeOpponentFlagbearerRule) return;
		for (const pl of state.players) {
			if (pl.lost) continue;
			for (const perm of pl.battlefield) {
				if (perm.phasedOut) continue;
				if (evaluatePermanent(state, perm).hasSubType('Flagbearer')) {
					flagbearerIds.add(perm.instanceId);
				}
			}
		}
	});
	return flagbearerIds;
}

/**
 * CR 115.1: Enforces Flagbearer target selection when `actorId` chooses targets for a spell or ability.
 */
export function validateFlagbearerTargets(
	state: GameState,
	actorId: string,
	activeSpecsWithLegal: ReadonlyArray<{
		spec: TargetSpec;
		chosen: TargetRef[];
		legalCandidates: TargetRef[];
	}>
): { ok: boolean; error?: string } {
	if (activeSpecsWithLegal.length === 0) return { ok: true };
	const fbIds = getRequiredFlagbearerIdsForActor(state, actorId);
	if (fbIds.size === 0) return { ok: true };

	for (const entry of activeSpecsWithLegal) {
		if (entry.chosen.some((t) => t.kind === 'permanent' && fbIds.has(t.id))) {
			return { ok: true };
		}
	}

	const canChooseFlagbearer = activeSpecsWithLegal.some(
		(entry) =>
			(entry.spec.min > 0 || entry.chosen.length > 0) &&
			entry.legalCandidates.some((c) => c.kind === 'permanent' && fbIds.has(c.id))
	);
	if (!canChooseFlagbearer) return { ok: true };

	return {
		ok: false,
		error:
			'Strict Rules Violation: You must choose at least one Flagbearer on the battlefield as a target if able.'
	};
}

// ---- 4. Non-Standard ±M/±N Counters, Player Counters, Tokens, Exile-Counter, Draw & Mana ----

const PT_COUNTER_RE = /^([+-]\d+)\/([+-]\d+)$/;

/**
 * CR 122.1a: Parses a `±M/±N` counter name (excluding standard `+1/+1` and `-1/-1`, which are
 * already handled natively in Layer 7c and SBA `704.5q`).
 */
export function parseNonStandardPtCounter(counterName: string): { p: number; t: number } | null {
	if (counterName === '+1/+1' || counterName === '-1/-1') return null;
	const m = PT_COUNTER_RE.exec(counterName);
	if (!m) return null;
	const p = Number.parseInt(m[1], 10);
	const t = Number.parseInt(m[2], 10);
	if (!Number.isFinite(p) || !Number.isFinite(t)) return null;
	return { p, t };
}

/**
 * CR 122.1a, 613.4c: Sums total power and toughness deltas from non-standard `±M/±N` counters
 * (e.g. `+2/+2`, `+1/+0`, `-0/-1`, `-2/-2`) on `counters`.
 */
export function sumNonStandardPtCounters(counters: Record<string, number> | undefined): {
	power: number;
	toughness: number;
	entries: Array<[string, number]>;
} {
	let power = 0;
	let toughness = 0;
	const entries: Array<[string, number]> = [];
	if (!counters) return { power, toughness, entries };
	for (const key of Object.keys(counters)) {
		const count = counters[key];
		if (!count || count <= 0) continue;
		const parsed = parseNonStandardPtCounter(key);
		if (!parsed) continue;
		power += parsed.p * count;
		toughness += parsed.t * count;
		entries.push([key, count]);
	}
	if (entries.length > 1) entries.sort((a, b) => a[0].localeCompare(b[0]));
	return { power, toughness, entries };
}

/**
 * CR 614.1a: Applies a single counter replacement step with optional rounding (`'down' | 'up'`).
 */
export function applyCounterReplacementStep(
	amount: number,
	factor: number,
	delta: number,
	round?: 'down' | 'up'
): number {
	const raw = (amount + delta) * factor;
	if (round === 'down') return Math.max(0, Math.floor(raw));
	if (round === 'up') return Math.max(0, Math.ceil(raw));
	return Math.max(0, Math.trunc(raw));
}

/**
 * CR 122.1, 614.1a: Scales counters placed on a player (`poison`, `energy`, `experience`, `ticket`)
 * by active `appliesToPlayers` counter multipliers (e.g. doubling your counter placements or
 * halving an opponent's counter placements rounded down).
 */
export function scalePlayerCountersPlaced(
	state: GameState,
	recipientPlayerId: string,
	counterType: CounterType,
	initialAmount: number,
	placerPlayerId?: string
): number {
	if (initialAmount <= 0) return 0;
	// --- Track P22a (CR 122.6): Player counter locks (*Solemnity* / *Melira*) ---
	if (
		counterType === 'poison' ||
		counterType === 'experience' ||
		counterType === 'energy' ||
		counterType === 'rad' ||
		counterType === 'ticket'
	) {
		const pCounter = counterType as 'poison' | 'experience' | 'energy' | 'rad' | 'ticket';
		if (filterPlayerCountersGrantedWave8(state, recipientPlayerId, pCounter, initialAmount) <= 0) {
			return 0;
		}
	}
	// --- End Track P22a ---
	let amount = initialAmount;
	const effectivePlacer = placerPlayerId ?? recipientPlayerId;
	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'multiplier' || def.what !== 'counters' || !def.appliesToPlayers) return;
				if (def.counter !== undefined && def.counter !== counterType) return;
				if (def.whoPlaces === 'you' && effectivePlacer !== controllerId) return;
				if (def.whoPlaces === 'opponents' && effectivePlacer === controllerId) return;
				if (!def.whoPlaces && def.filter?.controller === 'you' && recipientPlayerId !== controllerId) {
					return;
				}
				if (
					!def.whoPlaces &&
					def.filter?.controller === 'opponent' &&
					recipientPlayerId === controllerId
				) {
					return;
				}
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				amount = applyCounterReplacementStep(amount, def.factor, def.delta ?? 0, def.round);
			},
			'multiplier'
		);
	});
	return amount;
}

/**
 * CR 111.1, 614.1a: Evaluates token-creation multipliers, filtered multipliers (e.g. creature-only
 * `×3` or Treasure-only `+1`), and companion token replacements (`extraToken`, e.g. `+1 Food` or
 * `+1 Squirrel`) for `baseCount` tokens of `spec` created under `recipientPlayerId`'s control.
 */
export function resolveWave6TokenCreation(
	state: GameState,
	recipientPlayerId: string,
	baseCount: number,
	spec: TokenSpec
): { totalCount: number; companionTokens: Array<{ spec: TokenSpec; count: number }> } {
	if (baseCount <= 0) return { totalCount: 0, companionTokens: [] };
	let count = baseCount;
	const companionTokens: Array<{ spec: TokenSpec; count: number }> = [];

	const tokenCard = buildTokenScryfallCard('preview', spec);
	const previewInst: CardInstance = {
		instanceId: '__token_preview__',
		card: tokenCard,
		ownerId: recipientPlayerId,
		controllerId: recipientPlayerId,
		zone: 'battlefield',
		tapped: Boolean(spec.tapped),
		summoningSick: true,
		counters: createEmptyCounterMap(),
		isToken: true,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		attachedToId: null,
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		usedLoyaltyThisTurn: false,
		isCommander: false,
		commanderCastCount: 0,
		transformed: false
	};

	withStableLayerInputs(state, () => {
		const additiveSteps: StaticDef[] = [];
		const factorSteps: StaticDef[] = [];
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'multiplier' || def.what !== 'tokens') return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				if (def.whoCreates !== 'all') {
					if (def.filter?.controller === 'opponent') {
						if (controllerId === recipientPlayerId) return;
					} else if (controllerId !== recipientPlayerId) {
						return;
					}
				}
				if (def.filter) {
					const filterNoCtrl: ObjectFilter = { ...def.filter };
					delete filterNoCtrl.controller;
					if (
						Object.keys(filterNoCtrl).length > 0 &&
						!matchesObjectFilter(previewInst, filterNoCtrl, {
							state,
							controllerId,
							source: perm
						})
					) {
						return;
					}
				}
				if ((def.delta ?? 0) > 0 || def.extraToken) {
					additiveSteps.push(def);
				} else {
					factorSteps.push(def);
				}
			},
			'multiplier'
		);

		// Apply additive (+N / companion token) before multiplicative (×2 / ×3) to maximize player benefit (CR 616.1)
		for (const def of additiveSteps) {
			if (def.k !== 'multiplier') continue;
			if (def.delta) count += def.delta;
			if (def.extraToken) {
				companionTokens.push({ spec: def.extraToken, count: 1 });
			}
			if (def.factor !== 1) {
				count = Math.max(0, Math.trunc(count * def.factor));
			}
		}
		for (const def of factorSteps) {
			if (def.k !== 'multiplier') continue;
			count = Math.max(0, Math.trunc(count * def.factor));
			for (const comp of companionTokens) {
				const compCard = buildTokenScryfallCard('preview', comp.spec);
				const compInst: CardInstance = { ...previewInst, card: compCard };
				const filterNoCtrl: ObjectFilter = def.filter ? { ...def.filter } : {};
				delete filterNoCtrl.controller;
				if (
					Object.keys(filterNoCtrl).length === 0 ||
					matchesObjectFilter(compInst, filterNoCtrl, {
						state,
						controllerId: recipientPlayerId
					})
				) {
					comp.count = Math.max(0, Math.trunc(comp.count * def.factor));
				}
			}
		}
	});

	return { totalCount: count, companionTokens };
}

const APPLIED_BATCH_TOKEN_EVENTS = new WeakSet<object>();
let inWave6CompanionTokenCreation = false;

function buildPreviewTokenInstance(recipientPlayerId: string, spec: TokenSpec): CardInstance {
	return {
		instanceId: '__token_preview__',
		card: buildTokenScryfallCard('preview', spec),
		ownerId: recipientPlayerId,
		controllerId: recipientPlayerId,
		zone: 'battlefield',
		tapped: Boolean(spec.tapped),
		summoningSick: true,
		counters: createEmptyCounterMap(),
		isToken: true,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		attachedToId: null,
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		usedLoyaltyThisTurn: false,
		isCommander: false,
		commanderCastCount: 0,
		transformed: false
	};
}

function filteredTokenFactorForSpec(
	state: GameState,
	recipientPlayerId: string,
	spec: TokenSpec
): number {
	const previewInst = buildPreviewTokenInstance(recipientPlayerId, spec);
	let factor = 1;
	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'multiplier' || def.what !== 'tokens') return;
				if (def.extraToken || (def.delta ?? 0) !== 0) return;
				if (!def.filter) return;
				const filterNoCtrl: ObjectFilter = { ...def.filter };
				delete filterNoCtrl.controller;
				if (Object.keys(filterNoCtrl).length === 0) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				if (def.whoCreates !== 'all') {
					if (def.filter.controller === 'opponent') {
						if (controllerId === recipientPlayerId) return;
					} else if (controllerId !== recipientPlayerId) {
						return;
					}
				}
				if (!matchesObjectFilter(previewInst, filterNoCtrl, { state, controllerId, source: perm })) {
					return;
				}
				factor = Math.max(0, Math.trunc(factor * def.factor));
			},
			'multiplier'
		);
	});
	return factor;
}

/**
 * CR 111.1, 614.1a, 616.1: Creates a single post-unfiltered-multiplier unit of `spec` via
 * `rawCreateToken` while applying filtered token multipliers (e.g. creature-only `×3`),
 * once-per-batch additive bonuses (`+1 Treasure` / `+1 Food`), and count-matching companion
 * tokens (`+that many 1/1 green Squirrel creature tokens`).
 */
export function createTokenWithWave6Replacements(
	state: GameState,
	controller: PlayerGameState,
	spec: TokenSpec,
	rawCreateToken: (s: GameState, ctrl: PlayerGameState, sp: TokenSpec) => CardInstance
): CardInstance[] {
	if (inWave6CompanionTokenCreation) {
		return [rawCreateToken(state, controller, spec)];
	}
	const recipientId = controller.playerId;
	const previewInst = buildPreviewTokenInstance(recipientId, spec);
	const batchObj = getActiveSimultaneousZoneBatchToken(state);
	const applyPerEventBonuses = !batchObj || !APPLIED_BATCH_TOKEN_EVENTS.has(batchObj);
	if (batchObj && applyPerEventBonuses) {
		APPLIED_BATCH_TOKEN_EVENTS.add(batchObj);
	}

	let perEventDelta = 0;
	const perEventExtraSpecs: TokenSpec[] = [];
	const matchingExtraSpecs: TokenSpec[] = [];

	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'multiplier' || def.what !== 'tokens') return;
				if (!def.extraToken && (def.delta ?? 0) === 0) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				if (def.whoCreates !== 'all') {
					if (def.filter?.controller === 'opponent') {
						if (controllerId === recipientId) return;
					} else if (controllerId !== recipientId) {
						return;
					}
				}
				if (def.filter) {
					const filterNoCtrl: ObjectFilter = { ...def.filter };
					delete filterNoCtrl.controller;
					if (
						Object.keys(filterNoCtrl).length > 0 &&
						!matchesObjectFilter(previewInst, filterNoCtrl, { state, controllerId, source: perm })
					) {
						return;
					}
				}
				if ((def.delta ?? 0) > 0 && applyPerEventBonuses) {
					perEventDelta += def.delta ?? 0;
				}
				if (def.extraToken) {
					if (def.extraTokenCount === 'matching') {
						matchingExtraSpecs.push(def.extraToken);
					} else if (applyPerEventBonuses) {
						perEventExtraSpecs.push(def.extraToken);
					}
				}
			},
			'multiplier'
		);
	});

	const unfilteredMult = tokenMultiplier(state, recipientId);
	const specFilteredMult = filteredTokenFactorForSpec(state, recipientId, spec);
	const primaryCount = (1 + perEventDelta * unfilteredMult) * specFilteredMult;

	const created: CardInstance[] = [];
	const prevGuard = inWave6CompanionTokenCreation;
	inWave6CompanionTokenCreation = true;
	try {
		withSimultaneousZoneBatch(state, () => {
			for (let i = 0; i < primaryCount && i < 256; i++) {
				created.push(rawCreateToken(state, controller, spec));
			}
			for (const extraSpec of perEventExtraSpecs) {
				const extraCount = unfilteredMult * filteredTokenFactorForSpec(state, recipientId, extraSpec);
				for (let i = 0; i < extraCount && i < 256; i++) {
					created.push(rawCreateToken(state, controller, extraSpec));
				}
			}
			for (const matchSpec of matchingExtraSpecs) {
				const extraCount = primaryCount * filteredTokenFactorForSpec(state, recipientId, matchSpec);
				for (let i = 0; i < extraCount && i < 256; i++) {
					created.push(rawCreateToken(state, controller, matchSpec));
				}
			}
		});
	} finally {
		inWave6CompanionTokenCreation = prevGuard;
	}
	return created;
}

const PENDING_EXILE_COUNTERS = new WeakMap<CardInstance, CounterType[]>();

/**
 * Records a counter to be placed on `obj` as it enters `exile` via a zone-change replacement
 * (`"instead exile it with a void counter on it"`).
 */
export function recordPendingExileReplacementCounter(obj: CardInstance, counter: CounterType): void {
	const list = PENDING_EXILE_COUNTERS.get(obj) ?? [];
	list.push(counter);
	PENDING_EXILE_COUNTERS.set(obj, list);
}

/**
 * Consumes and places any pending exile replacement counters onto `obj` once `obj` is in `exile`.
 */
export function applyPendingExileReplacementCounters(obj: CardInstance): void {
	const list = PENDING_EXILE_COUNTERS.get(obj);
	if (!list || list.length === 0) return;
	PENDING_EXILE_COUNTERS.delete(obj);
	if (obj.zone !== 'exile') return;
	for (const c of list) {
		obj.counters[c] = (obj.counters[c] ?? 0) + 1;
	}
}

/**
 * CR 121.2, 614.1a, 101.2: Evaluates draw locks (`cantDrawCards`, `cantDrawExtraCards`) and
 * draw-multiplying replacement effects (`drawMod`, e.g. `"draw two cards instead"` /
 * `"except the first one you draw in each of your draw steps, draw two cards instead"`) for a
 * single card draw event.
 */
export function evaluateSingleDrawWave6(
	state: GameState,
	player: PlayerGameState
): { drawCount: number; markFirstDrawStepDraw: boolean } {
	const isYourTurn = state.players[state.activePlayerIndex]?.playerId === player.playerId;
	const isFirstDrawInYourDrawStep =
		isYourTurn && state.phase === 'draw' && !player.drewFirstCardInDrawStepThisTurn;

	let cantDraw = false;
	let cantDrawExtra = false;
	const drawMods: Array<{ factor: number; delta: number; skipFirstInYourDrawStep?: boolean }> = [];

	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k === 'ruleModifier') {
					if (def.rule !== 'cantDrawCards' && def.rule !== 'cantDrawExtraCards') return;
					if (!matchesStaticPlayerScope(def.who, controllerId, player.playerId, state)) return;
					if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
					if (def.rule === 'cantDrawCards') cantDraw = true;
					else cantDrawExtra = true;
				}
			},
			'ruleModifier',
			['cantDrawCards', 'cantDrawExtraCards']
		);

		// Scan active replacement effects with `replaces.event === 'draw'` and `with.drawMod`
		for (const pl of state.players) {
			if (pl.lost) continue;
			for (const perm of pl.battlefield) {
				if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
				const card = effectiveCardForObject(perm);
				for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
					if (ab.kind !== 'replacement') continue;
					const rep: ReplacementDef = ab.replacement;
					if (rep.replaces.event !== 'draw') continue;
					if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.drawMod) continue;
					const whoFilter = rep.replaces.filter?.player ?? rep.who ?? { relation: 'you' as const };
					if (!matchesStaticPlayerScope(whoFilter, perm.controllerId, player.playerId, state)) {
						continue;
					}
					if (!evalStaticCond(rep.condition, state, perm.controllerId, perm)) continue;
					drawMods.push({
						factor: rep.with.drawMod.factor ?? 1,
						delta: rep.with.drawMod.delta ?? 0,
						skipFirstInYourDrawStep: rep.with.drawMod.skipFirstInYourDrawStep
					});
				}
			}
		}
	});

	if (cantDraw) {
		return { drawCount: 0, markFirstDrawStepDraw: false };
	}
	if (cantDrawExtra && (player.cardsDrawnThisTurn ?? 0) >= 1) {
		return { drawCount: 0, markFirstDrawStepDraw: false };
	}

	let count = 1;
	for (const dm of drawMods) {
		if (dm.skipFirstInYourDrawStep && isFirstDrawInYourDrawStep) continue;
		count = Math.max(0, (count + dm.delta) * dm.factor);
	}
	if (cantDrawExtra && count > 1) {
		count = Math.max(0, 1 - (player.cardsDrawnThisTurn ?? 0));
	}
	return {
		drawCount: count,
		markFirstDrawStepDraw: isFirstDrawInYourDrawStep && count > 0
	};
}

/**
 * CR 106.4 / 500.4: Empties `player`'s mana pool at step/phase end while honoring
 * `unemptiedManaColorsThisTurn`, `firebendingRedMana`, and active `retainUnspentMana` statics
 * (either retaining specified colors or converting otherwise-lost mana to `convertTo`, e.g. `C` or `B`).
 */
export function emptyPlayerManaPoolWave6(
	state: GameState,
	player: PlayerGameState,
	keepFireRed = 0
): void {
	const staticRetainColors = new Set<ManaColor>();
	let staticRetainAll = false;
	let convertLostTo: ManaColor | undefined;

	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'retainUnspentMana') return;
				if (def.players === 'you' && controllerId !== player.playerId) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				if (def.convertTo) {
					convertLostTo = def.convertTo;
				} else if (def.colors === 'all') {
					staticRetainAll = true;
				} else {
					for (const c of def.colors) staticRetainColors.add(c);
				}
			},
			'retainUnspentMana'
		);
	});

	if (!staticRetainAll && staticRetainColors.size === 0 && !convertLostTo) {
		emptyPlayerManaPoolForStepEnd(player);
		return;
	}

	if (staticRetainAll || player.unemptiedManaColorsThisTurn === 'all') {
		return;
	}

	const combinedRetain = new Set<ManaColor>(player.unemptiedManaColorsThisTurn ?? []);
	for (const c of staticRetainColors) combinedRetain.add(c);
	if (convertLostTo) combinedRetain.add(convertLostTo);

	let convertedAmount = 0;
	if (convertLostTo) {
		for (const c of ALL_MANA_COLORS) {
			if (combinedRetain.has(c)) continue;
			const cur = player.manaPool[c] || 0;
			if (cur <= 0) continue;
			const retainedCount = Math.min(cur, player.retainedManaCounts?.[c] ?? 0);
			const fireKeep = c === 'R' ? Math.min(cur - retainedCount, Math.max(0, keepFireRed)) : 0;
			convertedAmount += Math.max(0, cur - retainedCount - fireKeep);
		}
	}

	const prevUnemptied = player.unemptiedManaColorsThisTurn;
	player.unemptiedManaColorsThisTurn = [...combinedRetain];
	try {
		emptyPlayerManaPoolForStepEnd(player);
	} finally {
		player.unemptiedManaColorsThisTurn = prevUnemptied;
	}

	if (convertLostTo && convertedAmount > 0) {
		player.manaPool[convertLostTo] = (player.manaPool[convertLostTo] || 0) + convertedAmount;
	}
}

// ---- 5. Off-Battlefield Characteristics & Rule Locks ----------------------------------------

/**
 * CR 613.1d–e, 113.6: Returns creature subtypes and colors continuously granted to `obj` in a
 * non-battlefield zone (`hand`, `graveyard`, `library`, `exile`, `command`, `stack`).
 */
export function getOffBattlefieldGrantedCharacteristics(
	state: GameState,
	obj: CardInstance
): { allCreatureTypes: boolean; addedTypes: string[]; addedSubtypes: string[]; addedColors: ManaColor[] } {
	if (obj.zone === 'battlefield') {
		return { allCreatureTypes: false, addedTypes: [], addedSubtypes: [], addedColors: [] };
	}
	let allCreatureTypes = false;
	const addedTypes: string[] = [];
	const addedSubtypes: string[] = [];
	const addedColors: ManaColor[] = [];
	const ownerOrCtrl = obj.controllerId || obj.ownerId;

	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'offBattlefieldCharacteristics') return;
				if (!def.zones.includes(obj.zone as 'hand' | 'graveyard' | 'library' | 'exile' | 'command' | 'stack')) {
					return;
				}
				if (def.who === 'you' && ownerOrCtrl !== controllerId) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				if (def.filter) {
					// Evaluate base printed characteristics to avoid recursive off-battlefield lookups
					const chars = activeCharacteristics(effectiveCardForObject(obj), instanceFaceOptions(obj));
					if (
						def.filter.types &&
						!def.filter.types.every((t: string) =>
							chars.types.some((ct) => ct.toLowerCase() === t.toLowerCase())
						)
					) {
						return;
					}
					if (
						def.filter.notTypes &&
						def.filter.notTypes.some((t: string) =>
							chars.types.some((ct) => ct.toLowerCase() === t.toLowerCase())
						)
					) {
						return;
					}
				}
				if (def.addAllCreatureTypes) allCreatureTypes = true;
				if (def.addTypes) {
					for (const t of def.addTypes) addedTypes.push(t);
				}
				if (def.addChosenSubType && perm.chosenSubType) {
					addedSubtypes.push(perm.chosenSubType);
				}
				if (def.addSubtypes) {
					for (const s of def.addSubtypes) addedSubtypes.push(s);
				}
				if (def.addChosenColor && perm.chosenColor) {
					addedColors.push(perm.chosenColor);
				}
				if (def.addColors) {
					for (const c of def.addColors) addedColors.push(c);
				}
			},
			'offBattlefieldCharacteristics'
		);
	});

	return { allCreatureTypes, addedTypes, addedSubtypes, addedColors };
}

/**
 * CR 502.3: Returns active untap-step caps (`rule: 'untapStepCap'`) affecting `playerId`.
 */
export function getActiveUntapStepCaps(
	state: GameState,
	playerId: string
): Array<{ max: number; filter?: ObjectFilter }> {
	const caps: Array<{ max: number; filter?: ObjectFilter }> = [];
	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'ruleModifier' || def.rule !== 'untapStepCap') return;
				if (!matchesStaticPlayerScope(def.who, controllerId, playerId, state)) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				const max = typeof def.params?.max === 'number' ? def.params.max : 0;
				const filter = def.params?.filter as ObjectFilter | undefined;
				caps.push({ max, filter });
			},
			'ruleModifier',
			['untapStepCap']
		);
	});
	return caps;
}

/**
 * CR 502.3: Collects tapped permanents controlled by players OTHER than `activePlayerId` that
 * untap during `activePlayerId`'s untap step via `k: 'untapDuringOtherUntapSteps'`.
 */
export function collectOtherPlayerUntapStepPermanents(
	state: GameState,
	activePlayerId: string
): CardInstance[] {
	const toUntap = new Map<string, CardInstance>();
	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'untapDuringOtherUntapSteps') return;
				if (controllerId === activePlayerId) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;

				if (def.affected === 'self') {
					if (perm.tapped && !perm.phasedOut) toUntap.set(perm.instanceId, perm);
					return;
				}
				if (def.affected === 'attachedTo') {
					if (!perm.attachedToId) return;
					for (const pl of state.players) {
						if (pl.lost || pl.playerId === activePlayerId) continue;
						const host = pl.battlefield.find((c) => c.instanceId === perm.attachedToId);
						if (host && host.tapped && !host.phasedOut) {
							toUntap.set(host.instanceId, host);
						}
					}
					return;
				}
				for (const pl of state.players) {
					if (pl.lost || pl.playerId === activePlayerId) continue;
					for (const cand of pl.battlefield) {
						if (!cand.tapped || cand.phasedOut) continue;
						if (matchesObjectFilter(cand, def.affected, { state, controllerId, source: perm })) {
							toUntap.set(cand.instanceId, cand);
						}
					}
				}
			},
			'untapDuringOtherUntapSteps'
		);
	});
	return [...toUntap.values()];
}

/**
 * CR 101.2, 601.3: Evaluates Wave 6 global spell-cast locks (`filteredSpellCapPerTurn` and
 * `cantCastMatchingSpells`).
 */
export function checkWave6SpellCastLocks(
	state: GameState,
	actor: PlayerGameState,
	spellInst: CardInstance | undefined,
	fromZone: ZoneType
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => {
		let blockedError: string | undefined;
		const spellView: CardInstance | undefined = spellInst
			? spellInst.controllerId === actor.playerId
				? spellInst
				: { ...spellInst, controllerId: actor.playerId }
			: undefined;

		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, sourceName, def) => {
				if (blockedError || def.k !== 'ruleModifier') return;
				if (def.rule !== 'filteredSpellCapPerTurn' && def.rule !== 'cantCastMatchingSpells') {
					return;
				}
				if (!matchesStaticPlayerScope(def.who, controllerId, actor.playerId, state)) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;

				if (def.rule === 'filteredSpellCapPerTurn') {
					if (!spellView) return;
					const max = typeof def.params?.max === 'number' ? def.params.max : 1;
					const filter = (def.params?.filter as ObjectFilter | undefined) ?? {};
					if (!matchesObjectFilter(spellView, filter, { state, controllerId, source: perm })) {
						return;
					}
					const priorCards = actor.spellsCastThisTurnCards ?? [];
					let priorMatches = 0;
					for (const sc of priorCards) {
						const priorInst: CardInstance = {
							...spellView,
							instanceId: '__prior_spell__',
							card: sc,
							zone: 'stack'
						};
						if (matchesObjectFilter(priorInst, filter, { state, controllerId, source: perm })) {
							priorMatches++;
						}
					}
					if (priorMatches >= max) {
						blockedError = `Illegal Cast: ${sourceName} prevents casting additional matching spells this turn.`;
					}
				} else if (def.rule === 'cantCastMatchingSpells') {
					const fromZones = def.params?.fromZones as ZoneType[] | undefined;
					if (fromZones && !fromZones.includes(fromZone)) return;
					const filter = def.params?.filter as ObjectFilter | undefined;
					if (filter) {
						if (!spellView) return;
						if (!matchesObjectFilter(spellView, filter, { state, controllerId, source: perm })) {
							return;
						}
					}
					blockedError = `Illegal Cast: ${sourceName} prevents casting this spell.`;
				}
			},
			'ruleModifier',
			['filteredSpellCapPerTurn', 'cantCastMatchingSpells']
		);

		return blockedError ? { ok: false, error: blockedError } : { ok: true };
	});
}

/**
 * CR 118.3, 601.2h, 602.2b: Evaluates `cantPayLifeOrSacrificeForCosts` locks (e.g. players can't
 * pay life or sacrifice nonland permanents to cast spells or activate abilities).
 */
export function checkWave6CostPaymentLocks(
	state: GameState,
	actorId: string,
	defs: ReadonlyArray<CostDef>,
	phyrexianLifeCount: number | undefined,
	isManaAbility: boolean,
	abilitySourcePerm?: CardInstance
): { ok: boolean; error?: string } {
	const paysLife =
		(phyrexianLifeCount ?? 0) > 0 || defs.some((d) => d.k === 'payLife');
	const sacrificesDefs = defs.filter((d) => d.k === 'sacrifice');
	if (!paysLife && sacrificesDefs.length === 0) return { ok: true };

	return withStableLayerInputs(state, () => {
		let blockedError: string | undefined;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, sourceName, def) => {
				if (blockedError || def.k !== 'ruleModifier' || def.rule !== 'cantPayLifeOrSacrificeForCosts') {
					return;
				}
				if (def.params?.nonManaAbilitiesOnly && isManaAbility) return;
				if (!matchesStaticPlayerScope(def.who, controllerId, actorId, state)) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;

				if (def.params?.cantPayLife && paysLife) {
					blockedError = `Illegal Cost: ${sourceName} prevents paying life to cast spells or activate abilities.`;
					return;
				}
				const sacFilter = def.params?.sacrificeFilter as ObjectFilter | 'any' | undefined;
				if (sacFilter && sacrificesDefs.length > 0) {
					if (sacFilter === 'any') {
						blockedError = `Illegal Cost: ${sourceName} prevents sacrificing permanents to pay costs.`;
						return;
					}
					const actor = state.players.find((p) => p.playerId === actorId);
					for (const sd of sacrificesDefs) {
						if (sd.k !== 'sacrifice') continue;
						if (sd.filter === 'self') {
							const selfTarget = abilitySourcePerm;
							if (
								selfTarget &&
								matchesObjectFilter(selfTarget, sacFilter, { state, controllerId, source: perm })
							) {
								blockedError = `Illegal Cost: ${sourceName} prevents sacrificing matching permanents to pay costs.`;
								return;
							}
						} else if (actor) {
							const allowedNonBanned = actor.battlefield.some(
								(c) =>
									!c.phasedOut &&
									matchesObjectFilter(
										c,
										{ ...(sd.filter as ObjectFilter), controller: 'you' },
										{ state, controllerId: actorId, source: abilitySourcePerm ?? perm }
									) &&
									!matchesObjectFilter(c, sacFilter, { state, controllerId, source: perm })
							);
							if (!allowedNonBanned) {
								blockedError = `Illegal Cost: ${sourceName} prevents sacrificing matching permanents to pay costs.`;
								return;
							}
						}
					}
				}
			},
			'ruleModifier',
			['cantPayLifeOrSacrificeForCosts']
		);
		return blockedError ? { ok: false, error: blockedError } : { ok: true };
	});
}

/**
 * CR 701.23: Evaluates `cantSearchLibraries` rule locks (either completely preventing library
 * searches or restricting searches to the top `topN` cards of that library).
 */
export function evaluateLibrarySearchLock(
	state: GameState,
	searchingPlayerId: string
): { cantSearch: boolean; topN?: number; sourceName?: string } {
	let cantSearch = false;
	let topN: number | undefined;
	let sourceName: string | undefined;

	withStableLayerInputs(state, () => {
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, srcName, def) => {
				if (def.k !== 'ruleModifier' || def.rule !== 'cantSearchLibraries') return;
				if (!matchesStaticPlayerScope(def.who, controllerId, searchingPlayerId, state)) return;
				if (!evalStaticCond(def.condition, state, controllerId, perm)) return;
				const cap = typeof def.params?.topN === 'number' ? def.params.topN : undefined;
				if (cap !== undefined) {
					topN = topN === undefined ? cap : Math.min(topN, cap);
					sourceName ??= srcName;
				} else {
					cantSearch = true;
					sourceName = srcName;
				}
			},
			'ruleModifier',
			['cantSearchLibraries']
		);
	});

	return { cantSearch, topN, sourceName };
}

/**
 * CR 704.5j: Returns true if `perm` is exempt from the `"legend rule"` SBA (`rule: 'legendRuleExempt'`).
 */
export function isPermanentExemptFromLegendRule(state: GameState, perm: CardInstance): boolean {
	return withStableLayerInputs(state, () => {
		let exempt = false;
		forEachActiveStaticOnBattlefield(
			state,
			(src, controllerId, _sourceName, def) => {
				if (exempt || def.k !== 'ruleModifier' || def.rule !== 'legendRuleExempt') return;
				if (!matchesStaticPlayerScope(def.who, controllerId, perm.controllerId, state)) return;
				if (!evalStaticCond(def.condition, state, controllerId, src)) return;
				const filter = def.params?.filter as ObjectFilter | undefined;
				if (filter && !matchesObjectFilter(perm, filter, { state, controllerId, source: src })) {
					return;
				}
				exempt = true;
			},
			'ruleModifier',
			['legendRuleExempt']
		);
		return exempt;
	});
}

// Re-export compileCard usage guard (unused at runtime if activeAbilityDefs already compiled)
void compileCard;
