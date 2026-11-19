/**
 * Phase 6: Continuous-effect layer engine (CR 613) evaluated from compiled IR, with caching.
 *
 * Reads only the compiled `CardDefinition` (`compileCard`) and `CardInstance` state on the board —
 * never raw rules text or card names. Results for all active battlefield permanents are computed in
 * layer order (1, 4, 5, 6, 7a, 7b, 7c, 7d) and memoised on the `BoardSnapshot` from `layerCache.ts`.
 */
import { compileCard } from '../compiler/index.ts';
import { formatGrantedKeywordDef, getKeywordSpec } from '../keywords.ts';
import type {
	ActivatedAbility,
	CardDefinition,
	ObjectFilter,
	PlayerRef,
	ReplacementDef,
	StaticDef,
	TriggeredAbility
} from '../ir.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	GameState,
	ManaColor,
	ManaPool,
	PlayerGameState,
	ScryfallCard,
	TimedContinuousEffect,
	TimedKeywordEffect
} from '../types.ts';
import {
	activeAbilityDefs,
	instanceFaceOptions,
	resolveObjectFaces,
	type ResolveObjectFacesOptions
} from './faces.ts';
import {
	activeTimedLayer1aForPermanent,
	boardSnapshotMatches,
	buildBoardSnapshot,
	crossCheckLayerResult,
	getBoardSnapshot,
	layerCacheCheckEnabled,
	scopeTrust,
	verifyScopeTrust,
	type BoardSnapshot
} from './layerCache.ts';
import { evaluateAmount, matchesObjectFilter, playerCommanderCastCount } from './objectFilter.ts';
import { resolveQuotedAbilityDefs } from './reflexiveManaAndActions.ts';
import { PROTECTION_KEYWORD_BY_COLOR } from './tuckFreezeChosen.ts';
import { collectBackupGrantedAbilityDefs } from './keywordsWave4.ts';
import {
	KEYWORD_COUNTER_TYPES,
	computeKeywordCounterMask
} from './staticsDynamicAndCosts.ts';
import {
	cardHasGraveyardContinuousStatic,
	collectGraveyardContinuousStaticsForPlayer
} from './staticsAndCostsWave5.ts';
import {
	pluralizeCardTypeForProtection
} from './staticsWave8.ts';
import {
	applyLayer3Wave9,
	applyLayer4CopyLastExiledWave9,
	applyLayer6Wave9Mod,
	applyLayer7bCopyLastExiledWave9
} from './staticsWave9.ts';
import {
	BASIC_LAND_MANA_BY_SUBTYPE,
	BASIC_LAND_SUBTYPES,
	LAND_SUBTYPES,
	NON_CREATURE_SUBTYPES,
	P16A_EXTRA_KEYWORD_COUNTERS,
	READ_ACTIVE_PLAYER,
	READ_ALL_COUNTERS,
	READ_CHOSEN_CARD_NAME,
	READ_COMBAT,
	READ_COMMANDER_CAST_COUNT,
	READ_ENERGY,
	READ_EXILE,
	READ_GRAVEYARDS,
	READ_HIDDEN_ZONES,
	READ_KEYWORD_COUNTERS,
	READ_LIFE,
	READ_MONARCH,
	READ_P10_SUSPECT,
	READ_P12,
	READ_P13,
	READ_P14,
	READ_P15,
	READ_P16A,
	READ_P16B,
	READ_P17A,
	READ_P17B,
	READ_P18A,
	READ_P18B,
	READ_P19A,
	READ_P20A,
	READ_P20B,
	READ_P22A,
	READ_P22B,
	READ_P22C,
	READ_TAPPED,
	READ_TURN_HISTORY,
	READ_WAVE9_ATTACKS,
	READ_WAVE9_DYNAMIC,
	READ_WAVE9_MANA,
	READ_ZONE_SIZES,
	addCardTypeToTypeLine,
	addSubtypeToTypeLine,
	applyRemovalsUpTo,
	collectP16aArbitraryPtCounters,
	describeGrantedActivatedAbility,
	evaluateLayerAmount,
	evaluateLayerCondition,
	formatKeywordLabel,
	formatSignedDelta,
	getAttachedAbilityStrippingAuraSources,
	getExtraLayerReadHook,
	getLayerReads,
	grantItem,
	grantKeywordString,
	grantNonActivatedAbility,
	hasSubtypeInWork,
	innateKeywordsAndAbilitiesOf,
	lookupStaticLocator,
	lowerSubtypesOf,
	makeIntrinsicBasicManaAbility,
	matchesLayerFilter,
	normalizeLayerCardType,
	normalizeSubtypes,
	noteLayerRead,
	offBattlefieldFilterNeedsExtendedMatch,
	recordAbilityRemoval,
	removeMatchingKeywordsUpTo,
	resetLayerReads,
	resolveLayerPlayerRef,
	sortGrantedKeywords,
	sumNonStandardPtCountersInLayer,
	workHasActiveKeyword,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent,
	type GrantedAbilityMeta,
	type PermWorkState
} from './layersPredicates.ts';

export {
	KEYWORD_LABELS,
	READ_ACTIVE_PLAYER,
	READ_ALL_COUNTERS,
	READ_CHOSEN_CARD_NAME,
	READ_COMBAT,
	READ_COMMANDER_CAST_COUNT,
	READ_ENERGY,
	READ_EXILE,
	READ_GRAVEYARDS,
	READ_HIDDEN_ZONES,
	READ_KEYWORD_COUNTERS,
	READ_LIFE,
	READ_MONARCH,
	READ_P10_SUSPECT,
	READ_P12,
	READ_P13,
	READ_P14,
	READ_P15,
	READ_P16A,
	READ_P16B,
	READ_P17A,
	READ_P17B,
	READ_P18A,
	READ_P18B,
	READ_P19A,
	READ_P20A,
	READ_P20B,
	READ_P22A,
	READ_P22B,
	READ_P22C,
	READ_TAPPED,
	READ_TURN_HISTORY,
	READ_WAVE9_ATTACKS,
	READ_WAVE9_DYNAMIC,
	READ_WAVE9_MANA,
	READ_ZONE_SIZES,
	getAttachedAbilityStrippingAuraSources,
	getLayerReads,
	noteLayerRead,
	resetLayerReads,
	setExtraLayerReadHookForTest,
	splitSubtypes,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent,
	type ExtraLayerReadHook
} from './layersPredicates.ts';

interface BoardLayerCache {
	dynamicFingerprint: unknown[];
	byInstance: Map<
		CardInstance,
		{
			breakdown: CardContinuousBreakdown;
			lost: {
				lost: boolean;
				sources: string[];
				// --- Track P17a ---
				keepManaAbilities?: boolean;
				// --- End Track P17a ---
				removalEvents?: ReadonlyArray<{
					timestamp: number;
					keepManaAbilities?: boolean;
					fromLayer6?: boolean;
				}>;
			};
			evaluated: EvaluatedPermanent;
		}
	>;
	/** Lazily built by `abilityActivePermanents` (Phase 6c). */
	abilityActive?: readonly AbilityActivePermanent[];
}

const BOARD_CACHE_KEY = 'phase6_board_layer_cache';


export function buildDynamicFingerprint(state: GameState, snap: BoardSnapshot, reads: bigint): unknown[] {
	const fp: unknown[] = [(state as { version?: number }).version, reads];
	const hook = getExtraLayerReadHook();
	if (hook && (reads & hook.flag) !== 0n) {
		fp.push(hook.read(state));
	}
	if ((reads & READ_ACTIVE_PLAYER) !== 0n) fp.push(state.activePlayerIndex);
	if ((reads & READ_MONARCH) !== 0n) fp.push(state.monarchPlayerId ?? null);
	// --- Track P8 ---
	if ((reads & READ_COMBAT) !== 0n) {
		const attackers = state.combat.attackers;
		fp.push(attackers.length);
		for (const atk of attackers) {
			fp.push(
				atk.attackerInstanceId,
				atk.defenderPlayerId,
				Boolean(atk.wasBlocked),
				atk.blockerInstanceIds.length
			);
			for (const bid of atk.blockerInstanceIds) fp.push(bid);
		}
	}
	// --- Track P7 ---
	if ((reads & READ_TURN_HISTORY) !== 0n) fp.push(Boolean(state.creatureDiedThisTurn));
	// --- Track P12 ---
	if ((reads & READ_P12) !== 0n) {
		fp.push(
			state.creaturesAttackedCountThisTurn ?? 0,
			state.cardsPutIntoGraveyardThisTurn ?? 0
		);
		for (const p of state.players) {
			fp.push(
				p.spellsCastThisTurn ?? 0,
				p.spellsCastThisTurnCards?.length ?? 0,
				p.sourcesDealtDamageIdsThisTurn?.length ?? 0
			);
		}
	}
	// --- End Track P12 ---
	// --- Track P13 ---
	if ((reads & READ_P13) !== 0n) {
		fp.push(
			state.initiativePlayerId ?? null,
			state.spellsCastLastTurnTotal ?? 0,
			state.maxSpellsCastBySinglePlayerLastTurn ?? 0
		);
		for (const p of state.players) {
			fp.push(
				p.dungeonsCompletedCount ?? 0,
				p.completedDungeonNames?.length ?? 0,
				Boolean(p.hasCitysBlessing),
				p.speed ?? 0,
				p.poison ?? 0,
				p.nonlandPermanentsEnteredThisTurn ?? 0,
				Boolean(p.nonlandPermanentLeftThisTurn),
				Boolean(p.spellWarpedThisTurn)
			);
		}
	}
	// --- End Track P13 ---
	// --- Track P15 ---
	if ((reads & READ_P15) !== 0n) {
		fp.push(
			state.dayNight ?? null,
			state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0
		);
		for (const p of state.players) {
			fp.push(p.speed ?? 0, Boolean(p.hasCitysBlessing));
		}
	}
	// --- End Track P15 ---
	// --- Track P16a ---
	if ((reads & READ_P16A) !== 0n) {
		for (const p of state.players) {
			fp.push(
				p.poison ?? 0,
				p.experienceCounters ?? 0,
				p.energyCounters ?? 0,
				p.radCounters ?? 0,
				p.ticketCounters ?? 0
			);
		}
		for (const entry of snap.active) {
			const perm = entry.perm;
			fp.push(
				perm.assimilatedBy?.sourceInstanceId ?? null,
				perm.assimilatedBy?.sourceObjectVersion ?? 0
			);
			let extraKwMask = 0;
			if ((perm.counters.shadow || 0) > 0) extraKwMask |= 1;
			if ((perm.counters.exalted || 0) > 0) extraKwMask |= 2;
			if ((perm.counters.decayed || 0) > 0) extraKwMask |= 4;
			fp.push(extraKwMask);
			if (extraKwMask !== 0) {
				for (const kw of P16A_EXTRA_KEYWORD_COUNTERS) {
					if ((perm.counters[kw] || 0) > 0) {
						fp.push(perm.counterTimestamps?.[kw] ?? 0);
					}
				}
			}
			const arb = collectP16aArbitraryPtCounters(perm.counters as Record<string, number>);
			fp.push(arb ? arb.length : 0);
			if (arb) {
				for (const it of arb) fp.push(it.key, it.count);
			}
		}
	}
	// --- End Track P16a ---
	// --- Track P16b ---
	if ((reads & READ_P16B) !== 0n) {
		fp.push(state.combatPhasesCountThisTurn ?? 0);
		for (const p of state.players) {
			fp.push(
				Boolean(p.committedCrimeThisTurn),
				Boolean(p.cardLeftGraveyardThisTurn),
				p.lifeLostThisTurn ?? 0,
				p.hand.length
			);
		}
		for (const entry of snap.active) {
			fp.push(Boolean(entry.perm.isRenowned), entry.perm.goadedByPlayerIds?.length ?? 0);
		}
	}
	// --- End Track P16b ---
	// --- Track P17a ---
	if ((reads & READ_P17A) !== 0n) {
		for (const entry of snap.active) {
			const ns = sumNonStandardPtCountersInLayer(entry.perm.counters);
			fp.push(ns.power, ns.toughness, ns.entries.length);
			for (const [ck, cv] of ns.entries) fp.push(ck, cv);
		}
	}
	// --- End Track P17a ---
	// --- Track P17b ---
	if ((reads & READ_P17B) !== 0n) {
		fp.push(
			state.startingPlayerId ?? '',
			state.creaturesAttackedCountThisTurn ?? 0
		);
		for (const p of state.players) {
			fp.push(
				p.lifeGainedThisTurn ?? 0,
				p.spellsCastThisTurn ?? 0,
				p.poison || 0,
				p.experienceCounters || 0,
				p.energyCounters || 0
			);
		}
	}
	// --- End Track P17b ---
	// --- Track P18a ---
	if ((reads & READ_P18A) !== 0n) {
		fp.push(state.players.length);
		for (const p of state.players) {
			fp.push(Boolean(p.hasEnduringStory));
		}
	}
	// --- End Track P18a ---
	// --- Track P18b ---
	if ((reads & READ_P18B) !== 0n) {
		fp.push(0);
	}
	// --- End Track P18b ---
	// --- Track P19a ---
	if ((reads & READ_P19A) !== 0n) {
		fp.push(0);
	}
	// --- End Track P19a ---
	// --- Track P20a ---
	if ((reads & READ_P20A) !== 0n) {
		fp.push(state.rules?.startingLife ?? 20, state.players.length);
		for (const p of state.players) {
			fp.push(p.life, Boolean(p.lost));
		}
		for (const entry of snap.active) {
			fp.push(
				entry.perm.pairedWithId ?? '',
				entry.perm.chosenPlayerId ?? '',
				entry.perm.chosenParity ?? '',
				entry.perm.manaSpentCount ?? 0
			);
		}
	}
	// --- End Track P20a ---
	// --- Track P20b ---
	if ((reads & READ_P20B) !== 0n) {
		fp.push(state.players.length);
		for (const p of state.players) {
			fp.push(
				p.permanentsEnteredSummaryThisTurn?.length ?? 0,
				p.cardsPutIntoGraveyardCountThisTurn ?? 0,
				Boolean(p.searchedLibraryThisTurn),
				Boolean(p.creatureSpellCounteredByOpponentThisTurn),
				Boolean(p.noncreatureDestroyedByOpponentThisTurn),
				p.creatureDamageSourceIdsThisTurn?.length ?? 0,
				p.spellsCastThisTurn ?? 0,
				p.cardsDrawnThisTurn ?? 0
			);
		}
	}
	// --- End Track P20b ---
	// --- Track P22a ---
	if ((reads & READ_P22A) !== 0n) {
		fp.push(state.rules?.startingLife ?? 20, state.players.length, state.activePlayerIndex);
		for (const p of state.players) {
			const etbCards = p.enteredBattlefieldCardsThisTurn;
			fp.push(
				p.life,
				Boolean(p.lost),
				p.poison ?? 0,
				p.experienceCounters ?? 0,
				p.energyCounters ?? 0,
				p.radCounters ?? 0,
				p.ticketCounters ?? 0,
				p.turnsTakenCount ?? 0,
				p.creaturesDiedCountThisTurn ?? 0,
				p.controlledCreaturesDiedCountThisTurn ?? 0,
				p.opponentCreaturesDiedCountThisTurn ?? 0,
				p.spellsCastThisTurn ?? 0,
				p.spellsCastThisTurnCards?.length ?? 0,
				etbCards?.length ?? 0
			);
			if (etbCards) {
				for (const sc of etbCards) fp.push(sc);
			}
		}
	}
	// --- End Track P22a ---
	// --- Track P22b ---
	if ((reads & READ_P22B) !== 0n) {
		fp.push(0);
	}
	// --- End Track P22b ---
	// --- Track P22c ---
	if ((reads & READ_P22C) !== 0n) {
		fp.push(0);
	}
	// --- End Track P22c ---
	// --- Wave 12 ---
	if ((reads & READ_WAVE9_MANA) !== 0n) {
		for (const p of state.players) {
			fp.push(
				p.manaPool.W,
				p.manaPool.U,
				p.manaPool.B,
				p.manaPool.R,
				p.manaPool.G,
				p.manaPool.C
			);
			const rm = p.restrictedMana as Record<string, ManaPool | undefined> | undefined;
			const rmKeys = rm ? Object.keys(rm).sort() : [];
			fp.push(rmKeys.length);
			for (const rk of rmKeys) {
				const b = rm?.[rk];
				fp.push(rk, b?.W ?? 0, b?.U ?? 0, b?.B ?? 0, b?.R ?? 0, b?.G ?? 0, b?.C ?? 0);
			}
			const rmb = p.restrictedManaBuckets ?? [];
			fp.push(rmb.length);
			for (const b of rmb) {
				fp.push(b.key, b.pool.W, b.pool.U, b.pool.B, b.pool.R, b.pool.G, b.pool.C);
			}
		}
	}
	if ((reads & READ_WAVE9_ATTACKS) !== 0n) {
		for (const entry of snap.active) {
			fp.push(entry.perm.attacksCountThisTurn ?? 0);
		}
	}
	if ((reads & READ_WAVE9_DYNAMIC) !== 0n) {
		for (const p of state.players) {
			fp.push(
				Boolean(p.activatedTargetedOwnCreatureAbilityThisTurn),
				p.spellsCastWithTreasureManaThisTurn ?? 0,
				p.nextSpellCascadeCount ?? 0,
				p.sacrificedCardsThisTurn?.length ?? 0,
				p.cardsDrawnThisTurn ?? 0,
				Boolean(p.playedLandThisTurn)
			);
		}
	}
	// --- End Wave 12 ---
	const readsLife = (reads & READ_LIFE) !== 0n;
	const readsEnergy = (reads & READ_ENERGY) !== 0n;
	const readsTurnHistory = (reads & READ_TURN_HISTORY) !== 0n;
	const readsP10Suspect = (reads & READ_P10_SUSPECT) !== 0n;
	const readsCommanderCastCount = (reads & READ_COMMANDER_CAST_COUNT) !== 0n;
	const readsZoneSizes = (reads & READ_ZONE_SIZES) !== 0n;
	const readsGraveyards = (reads & READ_GRAVEYARDS) !== 0n;
	const readsExile = (reads & READ_EXILE) !== 0n;
	const readsHiddenZones = (reads & READ_HIDDEN_ZONES) !== 0n;
	const readsP14 = (reads & READ_P14) !== 0n;
	for (const p of state.players) {
		if (readsLife) fp.push(p.life);
		if (readsEnergy) fp.push(p.energyCounters || 0);
		// --- Track P7 ---
		if (readsTurnHistory) {
			fp.push(
				Boolean(p.attackedThisTurn),
				Boolean(p.permanentLeftBattlefieldThisTurn),
				p.lifeGainedThisTurn || 0
			);
		}
		// --- End Track P7 ---
		// --- Track P10 ---
		if (readsP10Suspect) {
			fp.push(
				Boolean(p.descendedThisTurn),
				Boolean(p.lostLifeThisTurn),
				p.manaSpentOnSpellsThisTurn || 0,
				p.unemptiedManaColorsThisTurn?.length || 0
			);
		}
		// --- End Track P10 ---
		if (readsCommanderCastCount) fp.push(playerCommanderCastCount(state, p.playerId));
		if (readsZoneSizes) {
			fp.push(p.hand.length, p.graveyard.length, p.library.length, p.exile.length, p.command.length);
		}
		if (readsGraveyards) {
			fp.push(p.graveyard.length);
			for (const g of p.graveyard) {
				fp.push(g.card, g.copiableCard, g.copiableState);
			}
		}
		if (readsExile) {
			fp.push(p.exile.length);
			for (const ex of p.exile) {
				fp.push(
					ex.card,
					ex.copiableCard,
					ex.copiableState,
					ex.exiledBy?.sourceInstanceId,
					ex.exiledBy?.sourceObjectVersion
				);
				const c = ex.counters ?? {};
				const cKeys = Object.keys(c).sort();
				fp.push(cKeys.length);
				for (const ck of cKeys) {
					fp.push(ck, (c as Record<string, number>)[ck] || 0);
				}
				const gk = ex.grantedKeywords ?? [];
				fp.push(gk.length);
				for (const kw of gk) {
					fp.push(kw);
				}
			}
		}
		// --- Track P8 ---
		if (readsHiddenZones) {
			fp.push(p.hand.length, p.library.length, p.command.length);
			for (const c of p.hand) fp.push(c.card, c.copiableCard, c.copiableState);
			for (const c of p.library) fp.push(c.card, c.copiableCard, c.copiableState);
			for (const c of p.command) fp.push(c.card, c.copiableCard, c.copiableState);
		}
		// --- Track P14 ---
		if (readsP14) {
			fp.push(
				p.cardsDrawnThisTurn ?? 0,
				p.spellsCastThisTurn ?? 0,
				p.spellsCastThisTurnCards?.length ?? 0
			);
			let gyStaticCount = 0;
			for (let gi = 0; gi < p.graveyard.length; gi++) {
				if (cardHasGraveyardContinuousStatic(effectiveCardForObject(p.graveyard[gi]))) {
					gyStaticCount += 1;
				}
			}
			fp.push(gyStaticCount);
			if (gyStaticCount > 0) {
				for (let gi = 0; gi < p.graveyard.length; gi++) {
					const g = p.graveyard[gi];
					const gCard = effectiveCardForObject(g);
					if (cardHasGraveyardContinuousStatic(gCard)) {
						fp.push(gCard, g.enteredTimestamp ?? 0);
					}
				}
			}
		}
		// --- End Track P14 ---
	}
	const readsTapped = (reads & READ_TAPPED) !== 0n;
	const readsAllCounters = (reads & READ_ALL_COUNTERS) !== 0n;
	const readsKwCounters = (reads & READ_KEYWORD_COUNTERS) !== 0n;
	const readsChosenName = (reads & READ_CHOSEN_CARD_NAME) !== 0n;
	const readsP13 = (reads & READ_P13) !== 0n;
	for (const entry of snap.active) {
		const perm = entry.perm;
		if (readsTapped) fp.push(perm.tapped);
		// --- Track P8 ---
		if (readsAllCounters) {
			const cKeys = Object.keys(perm.counters).sort();
			fp.push(cKeys.length);
			for (const ck of cKeys) fp.push(ck, (perm.counters as Record<string, number>)[ck] || 0);
		}
		// --- Track P11 ---
		if (readsKwCounters) {
			const kwMask = computeKeywordCounterMask(perm.counters);
			fp.push(kwMask);
			if (kwMask !== 0) {
				for (const kw of KEYWORD_COUNTER_TYPES) {
					if ((perm.counters[kw] || 0) > 0) {
						fp.push(perm.counterTimestamps?.[kw] ?? 0);
					}
				}
			}
		}
		if (readsChosenName) {
			fp.push(perm.chosenCardName ?? '');
		}
		// --- End Track P11 ---
		// --- Track P13 ---
		if (readsP13) {
			fp.push(
				Boolean(perm.enteredThisTurn),
				Boolean(perm.dealtDamageThisTurn),
				perm.manaColorsAllSpent?.length ?? 0
			);
		}
		// --- End Track P13 ---
		fp.push(
			perm.counters['+1/+1'] || 0,
			perm.counters['-1/-1'] || 0,
			perm.counters.charge || 0,
			perm.counters.level || 0,
			perm.tempPowerMod || 0,
			perm.tempToughnessMod || 0,
			perm.switchedPTCount || 0,
			Boolean(perm.castViaSuspend),
			Boolean(perm.evoked),
			Boolean(perm.escaped),
			Boolean(perm.foretold),
			Boolean(perm.blitzed),
			Boolean(perm.dashed),
			Boolean(perm.riotHaste),
			Boolean(perm.saddledThisTurn),
			Boolean(perm.isMonstrous),
			// --- Track P7 ---
			Boolean(perm.wasCast),
			perm.castFromZone ?? '',
			// --- End Track P7 ---
			// --- Track P10 ---
			Boolean(perm.isSuspected),
			// --- End Track P10 ---
			// --- Track P12 ---
			perm.classLevel ?? 1,
			Boolean(perm.isSolved),
			Boolean(perm.isRenowned),
			Boolean(perm.isBestowed),
			Boolean(perm.creatureAttackedThisTurn),
			perm.devouredCount ?? 0,
			perm.exhaustedAbilityIds?.length ?? 0,
			// --- End Track P12 ---
			// --- Track P15 ---
			Boolean(perm.isPrepared),
			Boolean(perm.castWithImpending),
			perm.counters.time || 0,
			perm.enteredWithX ?? 0,
			Boolean(perm.giftPromised),
			// --- End Track P15 ---
			// --- Wave 6 Shared ---
			perm.pairedWithId ?? null,
			Boolean(perm.tributePaid),
			Boolean(perm.hasEnduringStory),
			Boolean(perm.isHarnessed),
			Boolean(perm.isFlipped),
			perm.mergedComponents?.length ?? 0,
			// --- End Wave 6 Shared ---
			// --- Track P18b ---
			perm.chosenAnchorWord ?? '',
			perm.meldedComponents?.length ?? 0,
			// --- End Track P18b ---
			perm.kickedCount || 0,
			perm.kickedTags?.length || 0,
			perm.grantedKeywords?.length || 0
		);
		if (perm.kickedTags?.length) {
			for (const tag of perm.kickedTags) fp.push(tag);
		}
		if (perm.grantedKeywords?.length) {
			for (const kw of perm.grantedKeywords) fp.push(kw);
		}
		// --- Track P18a ---
		if (perm.mergedComponents?.length) {
			for (const mc of perm.mergedComponents) fp.push(mc);
		}
		// --- End Track P18a ---
	}
	const timedKw = state.timedKeywordEffects;
	fp.push(timedKw?.length || 0);
	if (timedKw?.length) {
		for (const eff of timedKw) {
			fp.push(
				eff.timestamp,
				eff.sourceName,
				eff.controllerId,
				Boolean(eff.cantHaveOrGain),
				eff.affected.length,
				eff.addKeywords?.length || 0,
				eff.removeKeywords?.length || 0
			);
			for (const a of eff.affected) fp.push(a.instanceId, a.objectVersion ?? 1);
			if (eff.addKeywords?.length) for (const kw of eff.addKeywords) fp.push(kw);
			if (eff.removeKeywords?.length) for (const kw of eff.removeKeywords) fp.push(kw);
		}
	}
	const timedCont = state.timedContinuousEffects;
	fp.push(timedCont?.length || 0);
	if (timedCont?.length) {
		for (const eff of timedCont) {
			fp.push(
				eff.timestamp,
				eff.sourceName,
				eff.controllerId,
				eff.expires,
				eff.layer2?.controllerId,
				eff.layer2?.untilSourceLeaves?.sourceInstanceId,
				eff.layer2?.untilSourceLeaves?.sourceObjectVersion,
				eff.affected.length,
				eff.layer4?.addTypes?.length || 0,
				eff.layer4?.setTypes?.length || 0,
				eff.layer4?.removeTypes?.length || 0,
				eff.layer4?.addSubtypes?.length || 0,
				eff.layer4?.setSubtypes?.length || 0,
				eff.layer5?.setColors !== undefined ? 1 : 0,
				eff.layer5?.setColors?.length || 0,
				eff.layer5?.addColors?.length || 0,
				Boolean(eff.layer6?.cantHaveOrGain),
				eff.layer6?.addKeywords?.length || 0,
				eff.layer6?.removeKeywords?.length || 0,
				eff.layer7b ? 1 : 0,
				eff.layer7b?.setPower ?? 0,
				eff.layer7b?.setToughness ?? 0,
				// --- Track P7 ---
				eff.layer1a,
				// --- End Track P7 ---
				// --- Track P10 ---
				eff.layer6?.grantedAbilityTexts?.length || 0,
				// --- End Track P10 ---
				// --- Track P12 ---
				eff.backupGrant?.sourceCard,
				eff.backupGrant?.faceIndex ?? 0,
				eff.backupGrant?.startAbilityIndex ?? -1,
				// --- End Track P12 ---
				// --- Track P13 ---
				eff.layer7c ? 1 : 0,
				eff.layer7c?.power ?? 0,
				eff.layer7c?.toughness ?? 0,
				// --- End Track P13 ---
				// --- Track P16a ---
				Boolean(eff.sourceCondition?.broken),
				eff.sourceCondition?.kind ?? '',
				eff.sourceCondition?.sourceInstanceId ?? '',
				eff.sourceCondition?.sourceObjectVersion ?? 0,
				eff.sourceCondition?.controllerId ?? '',
				Boolean(eff.layer6?.removeAllAbilities)
				// --- End Track P16a ---
			);
			for (const a of eff.affected) fp.push(a.instanceId, a.objectVersion ?? 1);
			if (eff.layer4?.addTypes?.length) for (const t of eff.layer4.addTypes) fp.push(t);
			if (eff.layer4?.setTypes?.length) for (const t of eff.layer4.setTypes) fp.push(t);
			if (eff.layer4?.removeTypes?.length) for (const t of eff.layer4.removeTypes) fp.push(t);
			if (eff.layer4?.addSubtypes?.length) for (const s of eff.layer4.addSubtypes) fp.push(s);
			if (eff.layer4?.setSubtypes?.length) for (const s of eff.layer4.setSubtypes) fp.push(s);
			if (eff.layer5?.setColors?.length) for (const c of eff.layer5.setColors) fp.push(c);
			if (eff.layer5?.addColors?.length) for (const c of eff.layer5.addColors) fp.push(c);
			if (eff.layer6?.addKeywords?.length) for (const kw of eff.layer6.addKeywords) fp.push(kw);
			if (eff.layer6?.removeKeywords?.length) for (const kw of eff.layer6.removeKeywords) fp.push(kw);
			// --- Track P10 ---
			if (eff.layer6?.grantedAbilityTexts?.length) {
				for (const gt of eff.layer6.grantedAbilityTexts) fp.push(gt);
			}
			// --- End Track P10 ---
		}
	}
	return fp;
}

/**
 * Compares `fp` (from `buildDynamicFingerprint`) against the current state in place, without
 * allocating, bailing at the first difference. Must read exactly what the builder pushes, in order.
 */
export function dynamicFingerprintMatches(state: GameState, snap: BoardSnapshot, fp: unknown[]): boolean {
	let i = 0;
	if (fp[i++] !== (state as { version?: number }).version) return false;
	const reads = fp[i++] as bigint;
	const hook = getExtraLayerReadHook();
	if (hook && (reads & hook.flag) !== 0n && fp[i++] !== hook.read(state)) {
		return false;
	}
	if ((reads & READ_ACTIVE_PLAYER) !== 0n && fp[i++] !== state.activePlayerIndex) return false;
	if ((reads & READ_MONARCH) !== 0n && fp[i++] !== (state.monarchPlayerId ?? null)) return false;
	// --- Track P8 ---
	if ((reads & READ_COMBAT) !== 0n) {
		const attackers = state.combat.attackers;
		if (fp[i++] !== attackers.length) return false;
		for (const atk of attackers) {
			if (
				fp[i++] !== atk.attackerInstanceId ||
				fp[i++] !== atk.defenderPlayerId ||
				fp[i++] !== Boolean(atk.wasBlocked) ||
				fp[i++] !== atk.blockerInstanceIds.length
			) {
				return false;
			}
			for (const bid of atk.blockerInstanceIds) {
				if (fp[i++] !== bid) return false;
			}
		}
	}
	// --- Track P7 ---
	if ((reads & READ_TURN_HISTORY) !== 0n && fp[i++] !== Boolean(state.creatureDiedThisTurn)) return false;
	// --- Track P12 ---
	if ((reads & READ_P12) !== 0n) {
		if (
			fp[i++] !== (state.creaturesAttackedCountThisTurn ?? 0) ||
			fp[i++] !== (state.cardsPutIntoGraveyardThisTurn ?? 0)
		) {
			return false;
		}
		for (const p of state.players) {
			if (
				fp[i++] !== (p.spellsCastThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurnCards?.length ?? 0) ||
				fp[i++] !== (p.sourcesDealtDamageIdsThisTurn?.length ?? 0)
			) {
				return false;
			}
		}
	}
	// --- End Track P12 ---
	// --- Track P13 ---
	if ((reads & READ_P13) !== 0n) {
		if (
			fp[i++] !== (state.initiativePlayerId ?? null) ||
			fp[i++] !== (state.spellsCastLastTurnTotal ?? 0) ||
			fp[i++] !== (state.maxSpellsCastBySinglePlayerLastTurn ?? 0)
		) {
			return false;
		}
		for (const p of state.players) {
			if (
				fp[i++] !== (p.dungeonsCompletedCount ?? 0) ||
				fp[i++] !== (p.completedDungeonNames?.length ?? 0) ||
				fp[i++] !== Boolean(p.hasCitysBlessing) ||
				fp[i++] !== (p.speed ?? 0) ||
				fp[i++] !== (p.poison ?? 0) ||
				fp[i++] !== (p.nonlandPermanentsEnteredThisTurn ?? 0) ||
				fp[i++] !== Boolean(p.nonlandPermanentLeftThisTurn) ||
				fp[i++] !== Boolean(p.spellWarpedThisTurn)
			) {
				return false;
			}
		}
	}
	// --- End Track P13 ---
	// --- Track P15 ---
	if ((reads & READ_P15) !== 0n) {
		if (
			fp[i++] !== (state.dayNight ?? null) ||
			fp[i++] !== (state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0)
		) {
			return false;
		}
		for (const p of state.players) {
			if (fp[i++] !== (p.speed ?? 0) || fp[i++] !== Boolean(p.hasCitysBlessing)) {
				return false;
			}
		}
	}
	// --- End Track P15 ---
	// --- Track P16a ---
	if ((reads & READ_P16A) !== 0n) {
		for (const p of state.players) {
			if (
				fp[i++] !== (p.poison ?? 0) ||
				fp[i++] !== (p.experienceCounters ?? 0) ||
				fp[i++] !== (p.energyCounters ?? 0) ||
				fp[i++] !== (p.radCounters ?? 0) ||
				fp[i++] !== (p.ticketCounters ?? 0)
			) {
				return false;
			}
		}
		for (const entry of snap.active) {
			const perm = entry.perm;
			if (
				fp[i++] !== (perm.assimilatedBy?.sourceInstanceId ?? null) ||
				fp[i++] !== (perm.assimilatedBy?.sourceObjectVersion ?? 0)
			) {
				return false;
			}
			let extraKwMask = 0;
			if ((perm.counters.shadow || 0) > 0) extraKwMask |= 1;
			if ((perm.counters.exalted || 0) > 0) extraKwMask |= 2;
			if ((perm.counters.decayed || 0) > 0) extraKwMask |= 4;
			if (fp[i++] !== extraKwMask) return false;
			if (extraKwMask !== 0) {
				for (const kw of P16A_EXTRA_KEYWORD_COUNTERS) {
					if ((perm.counters[kw] || 0) > 0) {
						if (fp[i++] !== (perm.counterTimestamps?.[kw] ?? 0)) return false;
					}
				}
			}
			const arb = collectP16aArbitraryPtCounters(perm.counters as Record<string, number>);
			const arbLen = arb ? arb.length : 0;
			if (fp[i++] !== arbLen) return false;
			if (arb) {
				for (const it of arb) {
					if (fp[i++] !== it.key || fp[i++] !== it.count) return false;
				}
			}
		}
	}
	// --- End Track P16a ---
	// --- Track P16b ---
	if ((reads & READ_P16B) !== 0n) {
		if (fp[i++] !== (state.combatPhasesCountThisTurn ?? 0)) return false;
		for (const p of state.players) {
			if (
				fp[i++] !== Boolean(p.committedCrimeThisTurn) ||
				fp[i++] !== Boolean(p.cardLeftGraveyardThisTurn) ||
				fp[i++] !== (p.lifeLostThisTurn ?? 0) ||
				fp[i++] !== p.hand.length
			) {
				return false;
			}
		}
		for (const entry of snap.active) {
			if (
				fp[i++] !== Boolean(entry.perm.isRenowned) ||
				fp[i++] !== (entry.perm.goadedByPlayerIds?.length ?? 0)
			) {
				return false;
			}
		}
	}
	// --- End Track P16b ---
	// --- Track P17a ---
	if ((reads & READ_P17A) !== 0n) {
		for (const entry of snap.active) {
			const ns = sumNonStandardPtCountersInLayer(entry.perm.counters);
			if (fp[i++] !== ns.power || fp[i++] !== ns.toughness || fp[i++] !== ns.entries.length) {
				return false;
			}
			for (const [ck, cv] of ns.entries) {
				if (fp[i++] !== ck || fp[i++] !== cv) return false;
			}
		}
	}
	// --- End Track P17a ---
	// --- Track P17b ---
	if ((reads & READ_P17B) !== 0n) {
		if (
			fp[i++] !== (state.startingPlayerId ?? '') ||
			fp[i++] !== (state.creaturesAttackedCountThisTurn ?? 0)
		) {
			return false;
		}
		for (const p of state.players) {
			if (
				fp[i++] !== (p.lifeGainedThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurn ?? 0) ||
				fp[i++] !== (p.poison || 0) ||
				fp[i++] !== (p.experienceCounters || 0) ||
				fp[i++] !== (p.energyCounters || 0)
			) {
				return false;
			}
		}
	}
	// --- End Track P17b ---
	// --- Track P18a ---
	if ((reads & READ_P18A) !== 0n) {
		if (fp[i++] !== state.players.length) return false;
		for (const p of state.players) {
			if (fp[i++] !== Boolean(p.hasEnduringStory)) return false;
		}
	}
	// --- End Track P18a ---
	// --- Track P18b ---
	if ((reads & READ_P18B) !== 0n) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P18b ---
	// --- Track P19a ---
	if ((reads & READ_P19A) !== 0n) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P19a ---
	// --- Track P20a ---
	if ((reads & READ_P20A) !== 0n) {
		if (
			fp[i++] !== (state.rules?.startingLife ?? 20) ||
			fp[i++] !== state.players.length
		) {
			return false;
		}
		for (const p of state.players) {
			if (fp[i++] !== p.life || fp[i++] !== Boolean(p.lost)) return false;
		}
		for (const entry of snap.active) {
			if (
				fp[i++] !== (entry.perm.pairedWithId ?? '') ||
				fp[i++] !== (entry.perm.chosenPlayerId ?? '') ||
				fp[i++] !== (entry.perm.chosenParity ?? '') ||
				fp[i++] !== (entry.perm.manaSpentCount ?? 0)
			) {
				return false;
			}
		}
	}
	// --- End Track P20a ---
	// --- Track P20b ---
	if ((reads & READ_P20B) !== 0n) {
		if (fp[i++] !== state.players.length) return false;
		for (const p of state.players) {
			if (
				fp[i++] !== (p.permanentsEnteredSummaryThisTurn?.length ?? 0) ||
				fp[i++] !== (p.cardsPutIntoGraveyardCountThisTurn ?? 0) ||
				fp[i++] !== Boolean(p.searchedLibraryThisTurn) ||
				fp[i++] !== Boolean(p.creatureSpellCounteredByOpponentThisTurn) ||
				fp[i++] !== Boolean(p.noncreatureDestroyedByOpponentThisTurn) ||
				fp[i++] !== (p.creatureDamageSourceIdsThisTurn?.length ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurn ?? 0) ||
				fp[i++] !== (p.cardsDrawnThisTurn ?? 0)
			) {
				return false;
			}
		}
	}
	// --- End Track P20b ---
	// --- Track P22a ---
	if ((reads & READ_P22A) !== 0n) {
		if (
			fp[i++] !== (state.rules?.startingLife ?? 20) ||
			fp[i++] !== state.players.length ||
			fp[i++] !== state.activePlayerIndex
		) {
			return false;
		}
		for (const p of state.players) {
			const etbCards = p.enteredBattlefieldCardsThisTurn;
			if (
				fp[i++] !== p.life ||
				fp[i++] !== Boolean(p.lost) ||
				fp[i++] !== (p.poison ?? 0) ||
				fp[i++] !== (p.experienceCounters ?? 0) ||
				fp[i++] !== (p.energyCounters ?? 0) ||
				fp[i++] !== (p.radCounters ?? 0) ||
				fp[i++] !== (p.ticketCounters ?? 0) ||
				fp[i++] !== (p.turnsTakenCount ?? 0) ||
				fp[i++] !== (p.creaturesDiedCountThisTurn ?? 0) ||
				fp[i++] !== (p.controlledCreaturesDiedCountThisTurn ?? 0) ||
				fp[i++] !== (p.opponentCreaturesDiedCountThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurnCards?.length ?? 0) ||
				fp[i++] !== (etbCards?.length ?? 0)
			) {
				return false;
			}
			if (etbCards) {
				for (const sc of etbCards) {
					if (fp[i++] !== sc) return false;
				}
			}
		}
	}
	// --- End Track P22a ---
	// --- Track P22b ---
	if ((reads & READ_P22B) !== 0n) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P22b ---
	// --- Track P22c ---
	if ((reads & READ_P22C) !== 0n) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P22c ---
	// --- Wave 12 ---
	if ((reads & READ_WAVE9_MANA) !== 0n) {
		for (const p of state.players) {
			if (
				fp[i++] !== p.manaPool.W ||
				fp[i++] !== p.manaPool.U ||
				fp[i++] !== p.manaPool.B ||
				fp[i++] !== p.manaPool.R ||
				fp[i++] !== p.manaPool.G ||
				fp[i++] !== p.manaPool.C
			) {
				return false;
			}
			const rm = p.restrictedMana as Record<string, ManaPool | undefined> | undefined;
			const rmKeys = rm ? Object.keys(rm).sort() : [];
			if (fp[i++] !== rmKeys.length) return false;
			for (const rk of rmKeys) {
				const b = rm?.[rk];
				if (
					fp[i++] !== rk ||
					fp[i++] !== (b?.W ?? 0) ||
					fp[i++] !== (b?.U ?? 0) ||
					fp[i++] !== (b?.B ?? 0) ||
					fp[i++] !== (b?.R ?? 0) ||
					fp[i++] !== (b?.G ?? 0) ||
					fp[i++] !== (b?.C ?? 0)
				) {
					return false;
				}
			}
			const rmb = p.restrictedManaBuckets ?? [];
			if (fp[i++] !== rmb.length) return false;
			for (const b of rmb) {
				if (
					fp[i++] !== b.key ||
					fp[i++] !== b.pool.W ||
					fp[i++] !== b.pool.U ||
					fp[i++] !== b.pool.B ||
					fp[i++] !== b.pool.R ||
					fp[i++] !== b.pool.G ||
					fp[i++] !== b.pool.C
				) {
					return false;
				}
			}
		}
	}
	if ((reads & READ_WAVE9_ATTACKS) !== 0n) {
		for (const entry of snap.active) {
			if (fp[i++] !== (entry.perm.attacksCountThisTurn ?? 0)) {
				return false;
			}
		}
	}
	if ((reads & READ_WAVE9_DYNAMIC) !== 0n) {
		for (const p of state.players) {
			if (
				fp[i++] !== Boolean(p.activatedTargetedOwnCreatureAbilityThisTurn) ||
				fp[i++] !== (p.spellsCastWithTreasureManaThisTurn ?? 0) ||
				fp[i++] !== (p.nextSpellCascadeCount ?? 0) ||
				fp[i++] !== (p.sacrificedCardsThisTurn?.length ?? 0) ||
				fp[i++] !== (p.cardsDrawnThisTurn ?? 0) ||
				fp[i++] !== Boolean(p.playedLandThisTurn)
			) {
				return false;
			}
		}
	}
	// --- End Wave 12 ---
	const readsLife = (reads & READ_LIFE) !== 0n;
	const readsEnergy = (reads & READ_ENERGY) !== 0n;
	const readsTurnHistory = (reads & READ_TURN_HISTORY) !== 0n;
	const readsP10Suspect = (reads & READ_P10_SUSPECT) !== 0n;
	const readsCommanderCastCount = (reads & READ_COMMANDER_CAST_COUNT) !== 0n;
	const readsZoneSizes = (reads & READ_ZONE_SIZES) !== 0n;
	const readsGraveyards = (reads & READ_GRAVEYARDS) !== 0n;
	const readsExile = (reads & READ_EXILE) !== 0n;
	const readsHiddenZones = (reads & READ_HIDDEN_ZONES) !== 0n;
	const readsP14 = (reads & READ_P14) !== 0n;
	for (const p of state.players) {
		if (readsLife && fp[i++] !== p.life) return false;
		if (readsEnergy && fp[i++] !== (p.energyCounters || 0)) return false;
		// --- Track P7 ---
		if (
			readsTurnHistory &&
			(fp[i++] !== Boolean(p.attackedThisTurn) ||
				fp[i++] !== Boolean(p.permanentLeftBattlefieldThisTurn) ||
				fp[i++] !== (p.lifeGainedThisTurn || 0))
		) {
			return false;
		}
		// --- End Track P7 ---
		// --- Track P10 ---
		if (
			readsP10Suspect &&
			(fp[i++] !== Boolean(p.descendedThisTurn) ||
				fp[i++] !== Boolean(p.lostLifeThisTurn) ||
				fp[i++] !== (p.manaSpentOnSpellsThisTurn || 0) ||
				fp[i++] !== (p.unemptiedManaColorsThisTurn?.length || 0))
		) {
			return false;
		}
		// --- End Track P10 ---
		if (readsCommanderCastCount && fp[i++] !== playerCommanderCastCount(state, p.playerId)) {
			return false;
		}
		if (
			readsZoneSizes &&
			(fp[i++] !== p.hand.length ||
				fp[i++] !== p.graveyard.length ||
				fp[i++] !== p.library.length ||
				fp[i++] !== p.exile.length ||
				fp[i++] !== p.command.length)
		) {
			return false;
		}
		if (readsGraveyards) {
			if (fp[i++] !== p.graveyard.length) return false;
			for (const g of p.graveyard) {
				if (fp[i++] !== g.card || fp[i++] !== g.copiableCard || fp[i++] !== g.copiableState) {
					return false;
				}
			}
		}
		if (readsExile) {
			if (fp[i++] !== p.exile.length) return false;
			for (const ex of p.exile) {
				if (
					fp[i++] !== ex.card ||
					fp[i++] !== ex.copiableCard ||
					fp[i++] !== ex.copiableState ||
					fp[i++] !== ex.exiledBy?.sourceInstanceId ||
					fp[i++] !== ex.exiledBy?.sourceObjectVersion
				) {
					return false;
				}
				const c = ex.counters ?? {};
				const cKeys = Object.keys(c).sort();
				if (fp[i++] !== cKeys.length) return false;
				for (const ck of cKeys) {
					if (fp[i++] !== ck || fp[i++] !== ((c as Record<string, number>)[ck] || 0)) {
						return false;
					}
				}
				const gk = ex.grantedKeywords ?? [];
				if (fp[i++] !== gk.length) return false;
				for (const kw of gk) {
					if (fp[i++] !== kw) return false;
				}
			}
		}
		// --- Track P8 ---
		if (readsHiddenZones) {
			if (
				fp[i++] !== p.hand.length ||
				fp[i++] !== p.library.length ||
				fp[i++] !== p.command.length
			) {
				return false;
			}
			for (const c of p.hand) {
				if (fp[i++] !== c.card || fp[i++] !== c.copiableCard || fp[i++] !== c.copiableState) {
					return false;
				}
			}
			for (const c of p.library) {
				if (fp[i++] !== c.card || fp[i++] !== c.copiableCard || fp[i++] !== c.copiableState) {
					return false;
				}
			}
			for (const c of p.command) {
				if (fp[i++] !== c.card || fp[i++] !== c.copiableCard || fp[i++] !== c.copiableState) {
					return false;
				}
			}
		}
		// --- Track P14 ---
		if (readsP14) {
			if (
				fp[i++] !== (p.cardsDrawnThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurnCards?.length ?? 0)
			) {
				return false;
			}
			let gyStaticCount = 0;
			for (let gi = 0; gi < p.graveyard.length; gi++) {
				if (cardHasGraveyardContinuousStatic(effectiveCardForObject(p.graveyard[gi]))) {
					gyStaticCount += 1;
				}
			}
			if (fp[i++] !== gyStaticCount) return false;
			if (gyStaticCount > 0) {
				for (let gi = 0; gi < p.graveyard.length; gi++) {
					const g = p.graveyard[gi];
					const gCard = effectiveCardForObject(g);
					if (cardHasGraveyardContinuousStatic(gCard)) {
						if (fp[i++] !== gCard || fp[i++] !== (g.enteredTimestamp ?? 0)) {
							return false;
						}
					}
				}
			}
		}
		// --- End Track P14 ---
	}
	const readsTapped = (reads & READ_TAPPED) !== 0n;
	const readsAllCounters = (reads & READ_ALL_COUNTERS) !== 0n;
	// --- Track P11 ---
	const readsKwCounters = (reads & READ_KEYWORD_COUNTERS) !== 0n;
	const readsChosenName = (reads & READ_CHOSEN_CARD_NAME) !== 0n;
	// --- End Track P11 ---
	// --- Track P13 ---
	const readsP13 = (reads & READ_P13) !== 0n;
	// --- End Track P13 ---
	for (const entry of snap.active) {
		const perm = entry.perm;
		const kickedTags = perm.kickedTags;
		const kickedTagsLen = kickedTags?.length || 0;
		const granted = perm.grantedKeywords;
		const grantedLen = granted?.length || 0;
		if (readsTapped && fp[i++] !== perm.tapped) return false;
		// --- Track P8 ---
		if (readsAllCounters) {
			const cKeys = Object.keys(perm.counters).sort();
			if (fp[i++] !== cKeys.length) return false;
			for (const ck of cKeys) {
				if (fp[i++] !== ck || fp[i++] !== ((perm.counters as Record<string, number>)[ck] || 0)) {
					return false;
				}
			}
		}
		// --- Track P11 ---
		if (readsKwCounters) {
			const kwMask = computeKeywordCounterMask(perm.counters);
			if (fp[i++] !== kwMask) return false;
			if (kwMask !== 0) {
				for (const kw of KEYWORD_COUNTER_TYPES) {
					if ((perm.counters[kw] || 0) > 0) {
						if (fp[i++] !== (perm.counterTimestamps?.[kw] ?? 0)) return false;
					}
				}
			}
		}
		if (readsChosenName && fp[i++] !== (perm.chosenCardName ?? '')) return false;
		// --- End Track P11 ---
		// --- Track P13 ---
		if (
			readsP13 &&
			(fp[i++] !== Boolean(perm.enteredThisTurn) ||
				fp[i++] !== Boolean(perm.dealtDamageThisTurn) ||
				fp[i++] !== (perm.manaColorsAllSpent?.length ?? 0))
		) {
			return false;
		}
		// --- End Track P13 ---
		if (
			fp[i++] !== (perm.counters['+1/+1'] || 0) ||
			fp[i++] !== (perm.counters['-1/-1'] || 0) ||
			fp[i++] !== (perm.counters.charge || 0) ||
			fp[i++] !== (perm.counters.level || 0) ||
			fp[i++] !== (perm.tempPowerMod || 0) ||
			fp[i++] !== (perm.tempToughnessMod || 0) ||
			fp[i++] !== (perm.switchedPTCount || 0) ||
			fp[i++] !== Boolean(perm.castViaSuspend) ||
			fp[i++] !== Boolean(perm.evoked) ||
			fp[i++] !== Boolean(perm.escaped) ||
			fp[i++] !== Boolean(perm.foretold) ||
			fp[i++] !== Boolean(perm.blitzed) ||
			fp[i++] !== Boolean(perm.dashed) ||
			fp[i++] !== Boolean(perm.riotHaste) ||
			fp[i++] !== Boolean(perm.saddledThisTurn) ||
			fp[i++] !== Boolean(perm.isMonstrous) ||
			// --- Track P7 ---
			fp[i++] !== Boolean(perm.wasCast) ||
			fp[i++] !== (perm.castFromZone ?? '') ||
			// --- End Track P7 ---
			// --- Track P10 ---
			fp[i++] !== Boolean(perm.isSuspected) ||
			// --- End Track P10 ---
			// --- Track P12 ---
			fp[i++] !== (perm.classLevel ?? 1) ||
			fp[i++] !== Boolean(perm.isSolved) ||
			fp[i++] !== Boolean(perm.isRenowned) ||
			fp[i++] !== Boolean(perm.isBestowed) ||
			fp[i++] !== Boolean(perm.creatureAttackedThisTurn) ||
			fp[i++] !== (perm.devouredCount ?? 0) ||
			fp[i++] !== (perm.exhaustedAbilityIds?.length ?? 0) ||
			// --- End Track P12 ---
			// --- Track P15 ---
			fp[i++] !== Boolean(perm.isPrepared) ||
			fp[i++] !== Boolean(perm.castWithImpending) ||
			fp[i++] !== (perm.counters.time || 0) ||
			fp[i++] !== (perm.enteredWithX ?? 0) ||
			fp[i++] !== Boolean(perm.giftPromised) ||
			// --- End Track P15 ---
			// --- Wave 6 Shared ---
			fp[i++] !== (perm.pairedWithId ?? null) ||
			fp[i++] !== Boolean(perm.tributePaid) ||
			fp[i++] !== Boolean(perm.hasEnduringStory) ||
			fp[i++] !== Boolean(perm.isHarnessed) ||
			fp[i++] !== Boolean(perm.isFlipped) ||
			fp[i++] !== (perm.mergedComponents?.length ?? 0) ||
			// --- End Wave 6 Shared ---
			// --- Track P18b ---
			fp[i++] !== (perm.chosenAnchorWord ?? '') ||
			fp[i++] !== (perm.meldedComponents?.length ?? 0) ||
			// --- End Track P18b ---
			fp[i++] !== (perm.kickedCount || 0) ||
			fp[i++] !== kickedTagsLen ||
			fp[i++] !== grantedLen
		) {
			return false;
		}
		if (kickedTagsLen) {
			for (const tag of kickedTags!) if (fp[i++] !== tag) return false;
		}
		if (grantedLen) {
			for (const kw of granted) if (fp[i++] !== kw) return false;
		}
		// --- Track P18a ---
		if (perm.mergedComponents?.length) {
			for (const mc of perm.mergedComponents) {
				if (fp[i++] !== mc) return false;
			}
		}
		// --- End Track P18a ---
	}
	const timedKw = state.timedKeywordEffects;
	const timedLen = timedKw?.length || 0;
	if (fp[i++] !== timedLen) return false;
	if (timedLen) {
		for (const eff of timedKw!) {
			const affLen = eff.affected.length;
			const addLen = eff.addKeywords?.length || 0;
			const remLen = eff.removeKeywords?.length || 0;
			if (
				fp[i++] !== eff.timestamp ||
				fp[i++] !== eff.sourceName ||
				fp[i++] !== eff.controllerId ||
				fp[i++] !== Boolean(eff.cantHaveOrGain) ||
				fp[i++] !== affLen ||
				fp[i++] !== addLen ||
				fp[i++] !== remLen
			) {
				return false;
			}
			for (const a of eff.affected) {
				if (fp[i++] !== a.instanceId || fp[i++] !== (a.objectVersion ?? 1)) return false;
			}
			if (addLen) {
				for (const kw of eff.addKeywords!) if (fp[i++] !== kw) return false;
			}
			if (remLen) {
				for (const kw of eff.removeKeywords!) if (fp[i++] !== kw) return false;
			}
		}
	}
	const timedCont = state.timedContinuousEffects;
	const contLen = timedCont?.length || 0;
	if (fp[i++] !== contLen) return false;
	if (contLen) {
		for (const eff of timedCont!) {
			const affLen = eff.affected.length;
			const l4AddTypes = eff.layer4?.addTypes?.length || 0;
			const l4SetTypes = eff.layer4?.setTypes?.length || 0;
			const l4RemTypes = eff.layer4?.removeTypes?.length || 0;
			const l4AddSubs = eff.layer4?.addSubtypes?.length || 0;
			const l4SetSubs = eff.layer4?.setSubtypes?.length || 0;
			const hasL5Set = eff.layer5?.setColors !== undefined ? 1 : 0;
			const l5SetLen = eff.layer5?.setColors?.length || 0;
			const l5AddLen = eff.layer5?.addColors?.length || 0;
			const l6Cant = Boolean(eff.layer6?.cantHaveOrGain);
			const l6Add = eff.layer6?.addKeywords?.length || 0;
			const l6Rem = eff.layer6?.removeKeywords?.length || 0;
			const hasL7b = eff.layer7b ? 1 : 0;
			const l7bP = eff.layer7b?.setPower ?? 0;
			const l7bT = eff.layer7b?.setToughness ?? 0;
			// --- Track P10 ---
			const l6Texts = eff.layer6?.grantedAbilityTexts?.length || 0;
			// --- End Track P10 ---
			if (
				fp[i++] !== eff.timestamp ||
				fp[i++] !== eff.sourceName ||
				fp[i++] !== eff.controllerId ||
				fp[i++] !== eff.expires ||
				fp[i++] !== eff.layer2?.controllerId ||
				fp[i++] !== eff.layer2?.untilSourceLeaves?.sourceInstanceId ||
				fp[i++] !== eff.layer2?.untilSourceLeaves?.sourceObjectVersion ||
				fp[i++] !== affLen ||
				fp[i++] !== l4AddTypes ||
				fp[i++] !== l4SetTypes ||
				fp[i++] !== l4RemTypes ||
				fp[i++] !== l4AddSubs ||
				fp[i++] !== l4SetSubs ||
				fp[i++] !== hasL5Set ||
				fp[i++] !== l5SetLen ||
				fp[i++] !== l5AddLen ||
				fp[i++] !== l6Cant ||
				fp[i++] !== l6Add ||
				fp[i++] !== l6Rem ||
				fp[i++] !== hasL7b ||
				fp[i++] !== l7bP ||
				fp[i++] !== l7bT ||
				// --- Track P7 ---
				fp[i++] !== eff.layer1a ||
				// --- End Track P7 ---
				// --- Track P10 ---
				fp[i++] !== l6Texts ||
				// --- End Track P10 ---
				// --- Track P12 ---
				fp[i++] !== eff.backupGrant?.sourceCard ||
				fp[i++] !== (eff.backupGrant?.faceIndex ?? 0) ||
				fp[i++] !== (eff.backupGrant?.startAbilityIndex ?? -1) ||
				// --- End Track P12 ---
				// --- Track P13 ---
				fp[i++] !== (eff.layer7c ? 1 : 0) ||
				fp[i++] !== (eff.layer7c?.power ?? 0) ||
				fp[i++] !== (eff.layer7c?.toughness ?? 0) ||
				// --- End Track P13 ---
				// --- Track P16a ---
				fp[i++] !== Boolean(eff.sourceCondition?.broken) ||
				fp[i++] !== (eff.sourceCondition?.kind ?? '') ||
				fp[i++] !== (eff.sourceCondition?.sourceInstanceId ?? '') ||
				fp[i++] !== (eff.sourceCondition?.sourceObjectVersion ?? 0) ||
				fp[i++] !== (eff.sourceCondition?.controllerId ?? '') ||
				fp[i++] !== Boolean(eff.layer6?.removeAllAbilities)
				// --- End Track P16a ---
			) {
				return false;
			}
			for (const a of eff.affected) {
				if (fp[i++] !== a.instanceId || fp[i++] !== (a.objectVersion ?? 1)) return false;
			}
			if (l4AddTypes) for (const t of eff.layer4!.addTypes!) if (fp[i++] !== t) return false;
			if (l4SetTypes) for (const t of eff.layer4!.setTypes!) if (fp[i++] !== t) return false;
			if (l4RemTypes) for (const t of eff.layer4!.removeTypes!) if (fp[i++] !== t) return false;
			if (l4AddSubs) for (const s of eff.layer4!.addSubtypes!) if (fp[i++] !== s) return false;
			if (l4SetSubs) for (const s of eff.layer4!.setSubtypes!) if (fp[i++] !== s) return false;
			if (l5SetLen) for (const c of eff.layer5!.setColors!) if (fp[i++] !== c) return false;
			if (l5AddLen) for (const c of eff.layer5!.addColors!) if (fp[i++] !== c) return false;
			if (l6Add) for (const kw of eff.layer6!.addKeywords!) if (fp[i++] !== kw) return false;
			if (l6Rem) for (const kw of eff.layer6!.removeKeywords!) if (fp[i++] !== kw) return false;
			// --- Track P10 ---
			if (l6Texts) for (const gt of eff.layer6!.grantedAbilityTexts!) if (fp[i++] !== gt) return false;
			// --- End Track P10 ---
		}
	}
	return i === fp.length;
}

function computeBoardLayerCache(state: GameState, snap: BoardSnapshot): BoardLayerCache {
	const outer = getLayerReads();
	resetLayerReads(0n);
	try {
		const byInstance = evaluateBoard(state, snap);
		return {
			dynamicFingerprint: buildDynamicFingerprint(state, snap, getLayerReads()),
			byInstance
		};
	} finally {
		noteLayerRead(outer);
	}
}

/** Evaluates layers 1–7d for every active permanent (the uncached computation). */
function evaluateBoard(state: GameState, snap: BoardSnapshot): BoardLayerCache['byInstance'] {
	// Split into one function per pass (Phase 6d): same code, but V8 optimises and re-optimises
	// the passes separately instead of recompiling one ~850-line function after every deopt.
	const hook = getExtraLayerReadHook();
	if (hook) noteLayerRead(hook.flag);
	const workList: PermWorkState[] = [];
	const workMap = new Map<string, PermWorkState>();
	// --- Track P13 (CR 114.3, 114.4): Emblems in the command zone contribute continuous effects
	// without being permanents on the battlefield (so Humility / board filters never touch them). ---
	const emblemWorkList = buildEmblemWorkStates(state);
	// --- End Track P13 ---
	evaluateLayer1(state, snap, workList, workMap);
	evaluateLayer2Control(state, workList, workMap, emblemWorkList);
	applyLayer3Wave9(state, workList, workMap);
	evaluateAttachedTypes(state, snap, workList, workMap);
	evaluateTypeOverwrites(state, snap, workList, workMap, emblemWorkList);
	evaluateAdditiveTypesAndColors(state, snap, workList, workMap, emblemWorkList);
	evaluateLayer5Colors(state, workList, workMap, emblemWorkList);
	evaluateGlobalAbilityLoss(state, snap, workList, workMap, emblemWorkList);
	evaluatePerPermanent(state, snap, workList, workMap, emblemWorkList);
	return buildBoardResults(workList);
}

// --- Track P13 ---
function buildEmblemWorkStates(state: GameState): PermWorkState[] {
	const out: PermWorkState[] = [];
	for (const p of state.players) {
		if (p.lost || p.command.length === 0) continue;
		for (const cmd of p.command) {
			if (!cmd.isEmblem || cmd.isRingEmblem) continue;
			const statics: StaticDef[] = [];
			for (const ab of activeAbilityDefs(cmd.card, {
				zone: 'command',
				faceIndex: 0,
				isFaceDown: false
			})) {
				if (ab.kind === 'static') {
					statics.push(ab.static);
				} else if (ab.kind === 'keyword') {
					const kwSpec = getKeywordSpec(ab.keyword.name);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics(ab.keyword)) {
							statics.push(st);
						}
					}
				}
			}
			if (statics.length === 0) continue;
			statics.sort((a, b) => staticLayerOrder(a) - staticLayerOrder(b));
			out.push({
				inst: cmd,
				controllerId: cmd.controllerId || p.playerId,
				baseCard: cmd.card,
				timestamp: cmd.enteredTimestamp ?? 0,
				name: cmd.card.name,
				manaCost: '',
				manaValue: 0,
				isFaceDown: false,
				baseTypeLine: 'Emblem',
				effectiveTypeLine: 'Emblem',
				supertypes: [],
				types: [],
				subtypes: [],
				colors: [],
				isLegendary: false,
				prefixLegendary: '',
				hasAllCreatureTypes: false,
				basePower: null,
				baseToughness: null,
				workingPower: null,
				workingToughness: null,
				typeModifiedBy: [],
				ptModifiedBy: [],
				allAbilityRemovalSources: [],
				abilityRemovalEvents: [],
				layer7bSetters: [],
				items: [],
				itemTimestamps: new Map(),
				statics,
				grantsKeywordViaAbility: new Set(),
				strippedByAttachment: false
			});
		}
	}
	return out;
}
// --- End Track P13 ---

// --- Track P11: Per-CardDefinition Layer 1 template memo for plain face-up permanents ---
interface PlainLayer1Template {
	cmc: number;
	keywordsRef: ScryfallCard['keywords'];
	keywordsJoin: string;
	name: string;
	// --- Track P14 ---
	manaCost: string;
	// --- End Track P14 ---
	manaValue: number;
	baseTypeLine: string;
	supertypes: readonly string[];
	types: readonly string[];
	subtypes: readonly string[];
	colors: readonly ManaColor[];
	isLegendary: boolean;
	prefixLegendary: string;
	hasAllCreatureTypes: boolean;
	basePower: number | null;
	baseToughness: number | null;
	innateItems: ReadonlyArray<{
		id: string;
		canonicalKey: string;
		name: string;
		kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod';
	}>;
	statics: readonly StaticDef[];
	grantsKeywordViaAbility: readonly string[];
}

const PLAIN_LAYER1_OPTS: ResolveObjectFacesOptions = {
	zone: 'battlefield',
	faceIndex: 0,
	isFaceDown: false
};

const PLAIN_LAYER1_BY_DEF = new WeakMap<CardDefinition, PlainLayer1Template>();

function staticLayerOrder(st: StaticDef): number {
	if (st.k !== 'continuous') return 99;
	switch (st.layer) {
		case '1':
			return 1;
		case '2':
			return 2;
		case '3':
			return 3;
		case '4':
			return 4;
		case '5':
			return 5;
		case '6':
			return 6;
		case '7a':
			return 7.1;
		case '7b':
			return 7.2;
		case '7c':
		default:
			return 7.3;
	}
}

function getPlainLayer1Template(baseCard: ScryfallCard): PlainLayer1Template {
	const def = compileCard(baseCard);
	const cached = PLAIN_LAYER1_BY_DEF.get(def);
	if (
		cached &&
		cached.cmc === baseCard.cmc &&
		(cached.keywordsRef === baseCard.keywords ||
			(baseCard.keywords?.join('\u0001') ?? '') === cached.keywordsJoin)
	) {
		return cached;
	}

	const view = resolveObjectFaces(baseCard, PLAIN_LAYER1_OPTS);
	const baseTypeLine = view.typeLine;
	const supertypes = [...view.supertypes];
	const types = [...view.types];
	const subtypes = normalizeSubtypes(view.subtypes);
	const colors = [...view.colors];
	const isLegendary = supertypes.includes('Legendary');
	const prefixLegendary = isLegendary ? 'Legendary ' : '';
	const basePower = view.power ?? null;
	const baseToughness = view.toughness ?? null;

	const innateList = innateKeywordsAndAbilitiesOf(baseCard, PLAIN_LAYER1_OPTS);
	const innateItems = innateList.map((entryItem, idx) => ({
		id: `innate_${idx}_${entryItem.canonicalKey}`,
		canonicalKey: entryItem.canonicalKey,
		name: entryItem.name,
		kind: entryItem.kind
	}));
	const hasAllCreatureTypes = innateItems.some((it) => it.canonicalKey === 'changeling');

	const statics: StaticDef[] = [];
	const grantsSet = new Set<string>();
	for (const ab of activeAbilityDefs(baseCard, PLAIN_LAYER1_OPTS)) {
		if (ab.kind === 'static') {
			// --- Track P14 (CR 113.6b): Graveyard-only statics do not function on the battlefield ---
			if (ab.static.k === 'continuous' && ab.static.activeInZone === 'graveyard') continue;
			// --- End Track P14 ---
			statics.push(ab.static);
		} else if (ab.kind === 'keyword') {
			const kwSpec = getKeywordSpec(ab.keyword.name);
			if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
				for (const st of kwSpec.implementation.buildStatics(ab.keyword)) {
					statics.push(st);
				}
			}
		} else if (ab.kind === 'activated' || ab.kind === 'triggered') {
			for (const step of ab.effect) {
				if (step.verb === 'grant' && Array.isArray(step.params?.keywords)) {
					for (const kw of step.params.keywords as string[]) {
						grantsSet.add(kw.toLowerCase());
					}
				}
			}
		}
	}
	statics.sort((a, b) => staticLayerOrder(a) - staticLayerOrder(b));

	const tpl: PlainLayer1Template = {
		cmc: baseCard.cmc,
		keywordsRef: baseCard.keywords,
		keywordsJoin: baseCard.keywords?.join('\u0001') ?? '',
		name: view.name,
		// --- Track P14 ---
		manaCost: view.manaCost,
		// --- End Track P14 ---
		manaValue: view.manaValue,
		baseTypeLine,
		supertypes,
		types,
		subtypes,
		colors,
		isLegendary,
		prefixLegendary,
		hasAllCreatureTypes,
		basePower,
		baseToughness,
		innateItems,
		statics,
		grantsKeywordViaAbility: [...grantsSet]
	};
	PLAIN_LAYER1_BY_DEF.set(def, tpl);
	return tpl;
}
// --- End Track P11 ---

function evaluateLayer1(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	for (const entry of snap.sorted) {
		const inst = entry.perm;
		const baseCard = entry.card;

		// Layer 1a (CR 613.2a): printed characteristics, active face, and copy effects/exceptions.
		// --- Track P7 ---
		const timedLayer1a = activeTimedLayer1aForPermanent(state, inst);
		const effectiveCopy = timedLayer1a ?? inst.copiableState;
		// --- End Track P7 ---
		const isFaceDown = Boolean(inst.isFaceDown);

		// --- Track P11: Fast path for plain face-up permanents without copy/transform/prototype ---
		if (
			!isFaceDown &&
			!effectiveCopy &&
			!inst.transformed &&
			!inst.activeFaceIndex &&
			!(inst as { faceIndex?: number }).faceIndex &&
			!inst.unlockedFaces?.length &&
			!inst.prototyped &&
			!inst.isBestowed &&
			// --- Track P18a ---
			!inst.mergedComponents?.length
			// --- End Track P18a ---
		) {
			const tpl = getPlainLayer1Template(baseCard);
			const itemTimestamps = new Map<string, number>();
			const items: AttributedKeywordOrEffect[] = new Array(tpl.innateItems.length);
			for (let i = 0; i < tpl.innateItems.length; i++) {
				const src = tpl.innateItems[i];
				itemTimestamps.set(src.id, -Infinity);
				items[i] = {
					id: src.id,
					canonicalKey: src.canonicalKey,
					name: src.name,
					kind: src.kind,
					isInnate: true,
					sources: ['innate'],
					removed: false,
					removedBy: []
				};
			}
			const strippedByAttachment =
				getAttachedAbilityStrippingAuraSources(snap, inst.instanceId).length > 0;
			const work: PermWorkState = {
				inst,
				controllerId: inst.defaultControllerId ?? inst.controllerId,
				baseCard,
				timestamp: entry.timestamp,
				name: tpl.name,
				// --- Track P14 ---
				manaCost: tpl.manaCost,
				// --- End Track P14 ---
				manaValue: tpl.manaValue,
				isFaceDown: false,
				baseTypeLine: tpl.baseTypeLine,
				effectiveTypeLine: tpl.baseTypeLine,
				supertypes: [...tpl.supertypes],
				types: [...tpl.types],
				subtypes: [...tpl.subtypes],
				colors: [...tpl.colors],
				isLegendary: tpl.isLegendary,
				prefixLegendary: tpl.prefixLegendary,
				hasAllCreatureTypes: tpl.hasAllCreatureTypes,
				basePower: tpl.basePower,
				baseToughness: tpl.baseToughness,
				workingPower: tpl.basePower,
				workingToughness: tpl.baseToughness,
				typeModifiedBy: [],
				ptModifiedBy: [],
				allAbilityRemovalSources: [],
				abilityRemovalEvents: [],
				layer7bSetters: [],
				items,
				itemTimestamps,
				statics: [...tpl.statics],
				grantsKeywordViaAbility: new Set(tpl.grantsKeywordViaAbility),
				strippedByAttachment
			};
			workList.push(work);
			workMap.set(inst.instanceId, work);
			continue;
		}
		// --- End Track P11 ---

		// --- Track P7 ---
		const baseFaceOpts = instanceFaceOptions(inst, 'battlefield');
		const layer1aOpts: ResolveObjectFacesOptions = {
			...baseFaceOpts,
			...(timedLayer1a
				? {
						copiableState: timedLayer1a,
						faceIndex: timedLayer1a.faceIndex ?? 0,
						isSingleFaceCopy: timedLayer1a.isSingleFaceCopy,
						prototyped: Boolean(timedLayer1a.prototyped)
					}
				: {}),
			isFaceDown: false,
			faceDownSpec: undefined,
			faceDownLabel: undefined
		};
		// --- End Track P7 ---
		const layer1aView = resolveObjectFaces(baseCard, layer1aOpts);

		// Layer 1b (CR 613.2b, CR 708.2): face-down status overrides Layer 1a copiable values.
		const view = isFaceDown
			? resolveObjectFaces(baseCard, {
					zone: 'battlefield',
					isFaceDown: true,
					faceDownSpec: inst.faceDownSpec,
					faceDownLabel: inst.faceDownLabel ?? 'Face-Down Creature'
				})
			: layer1aView;

		const baseTypeLine = view.typeLine;
		const supertypes = [...view.supertypes];
		const types = [...view.types];
		const subtypes = normalizeSubtypes(view.subtypes);
		const colors = [...view.colors];
		const isLegendary = supertypes.includes('Legendary');
		const prefixLegendary = isLegendary ? 'Legendary ' : '';

		const basePower = view.power ?? null;
		const baseToughness = view.toughness ?? null;

		const innateList = isFaceDown
			? innateKeywordsAndAbilitiesOf(baseCard, {
					zone: 'battlefield',
					isFaceDown: true,
					faceDownSpec: inst.faceDownSpec,
					faceDownLabel: inst.faceDownLabel ?? 'Face-Down Creature'
				})
			: innateKeywordsAndAbilitiesOf(baseCard, layer1aOpts);
		const itemTimestamps = new Map<string, number>();
		const items: AttributedKeywordOrEffect[] = innateList.map((entryItem, idx) => {
			const id = `innate_${idx}_${entryItem.canonicalKey}`;
			itemTimestamps.set(id, -Infinity);
			return {
				id,
				canonicalKey: entryItem.canonicalKey,
				name: entryItem.name,
				kind: entryItem.kind,
				isInnate: true,
				sources: ['innate'],
				removed: false,
				removedBy: []
			};
		});

		const statics: StaticDef[] = [];
		const grantsKeywordViaAbility = new Set<string>();
		if (!isFaceDown) {
			// --- Track P7 ---
			const hasCopyColorException = effectiveCopy?.except?.colors !== undefined;
			if (effectiveCopy?.except?.addKeywords?.length) {
				for (const rawKw of effectiveCopy.except.addKeywords) {
					const kwLow = rawKw.trim().toLowerCase();
					if (!kwLow) continue;
					if (!items.some((it) => it.canonicalKey === kwLow)) {
						const id = `innate_${items.length}_${kwLow}`;
						itemTimestamps.set(id, -Infinity);
						items.push({
							id,
							canonicalKey: kwLow,
							name: formatKeywordLabel(kwLow),
							kind: 'keyword',
							isInnate: true,
							sources: ['innate'],
							removed: false,
							removedBy: []
						});
					}
					const kwSpec = getKeywordSpec(kwLow);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics({ name: kwLow })) {
							if (hasCopyColorException && st.k === 'continuous' && st.layer === '5' && st.affected === 'self') {
								continue;
							}
							statics.push(st);
						}
					}
				}
			}
			// --- End Track P7 ---
			for (const ab of activeAbilityDefs(baseCard, layer1aOpts)) {
				if (ab.kind === 'static') {
					// --- Track P14 (CR 113.6b): Graveyard-only statics do not function on the battlefield ---
					if (ab.static.k === 'continuous' && ab.static.activeInZone === 'graveyard') continue;
					// --- End Track P14 ---
					statics.push(ab.static);
				} else if (ab.kind === 'keyword') {
					const kwSpec = getKeywordSpec(ab.keyword.name);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics(ab.keyword)) {
							if (hasCopyColorException && st.k === 'continuous' && st.layer === '5' && st.affected === 'self') {
								continue;
							}
							statics.push(st);
						}
					}
				} else if (ab.kind === 'activated' || ab.kind === 'triggered') {
					for (const step of ab.effect) {
						if (step.verb === 'grant' && Array.isArray(step.params?.keywords)) {
							for (const kw of step.params.keywords as string[]) {
								grantsKeywordViaAbility.add(kw.toLowerCase());
							}
						}
					}
				}
			}
			// --- Track P12: Backup-granted statics & static keywords (CR 702.165a–d) ---
			for (const bAb of collectBackupGrantedAbilityDefs(state, inst)) {
				if (bAb.kind === 'static') {
					statics.push(bAb.static);
				} else if (bAb.kind === 'keyword') {
					const kwSpec = getKeywordSpec(bAb.keyword.name);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics(bAb.keyword)) {
							statics.push(st);
						}
					}
				}
			}
			// --- End Track P12 ---
			const layerOrder = (st: StaticDef): number => {
				if (st.k !== 'continuous') return 99;
				switch (st.layer) {
					case '1':
						return 1;
					case '2':
						return 2;
					case '3':
						return 3;
					case '4':
						return 4;
					case '5':
						return 5;
					case '6':
						return 6;
					case '7a':
						return 7.1;
					case '7b':
						return 7.2;
					case '7c':
					default:
						return 7.3;
				}
			};
			statics.sort((a, b) => layerOrder(a) - layerOrder(b));
		}

		const strippedByAttachment =
			getAttachedAbilityStrippingAuraSources(snap, inst.instanceId).length > 0;

		const work: PermWorkState = {
			inst,
			controllerId: inst.defaultControllerId ?? inst.controllerId,
			baseCard,
			timestamp: entry.timestamp,
			name: view.name,
			// --- Track P14 ---
			manaCost:
				isFaceDown || effectiveCopy?.except?.noManaCost
					? ''
					: view.manaCost,
			// --- End Track P14 ---
			// --- Track P7 ---
			manaValue: !isFaceDown && effectiveCopy?.except?.noManaCost ? 0 : view.manaValue,
			// --- End Track P7 ---
			isFaceDown,
			baseTypeLine,
			effectiveTypeLine: baseTypeLine,
			supertypes,
			types,
			subtypes,
			colors,
			isLegendary,
			prefixLegendary,
			hasAllCreatureTypes: !isFaceDown && items.some((it) => it.canonicalKey === 'changeling'),
			basePower,
			baseToughness,
			workingPower: basePower,
			workingToughness: baseToughness,
			typeModifiedBy: [],
			ptModifiedBy: [],
			allAbilityRemovalSources: [],
			abilityRemovalEvents: [],
			layer7bSetters: [],
			items,
			itemTimestamps,
			statics,
			grantsKeywordViaAbility,
			strippedByAttachment
		};
		workList.push(work);
		workMap.set(inst.instanceId, work);
	}

	// --- Track P21: Timed granted quoted statics & static keywords (CR 613.1f / 613.1g) ---
	if (state.timedContinuousEffects?.length) {
		for (const eff of state.timedContinuousEffects) {
			if (!eff.layer6?.grantedAbilityTexts?.length) continue;
			if (!isTimedContinuousEffectActive(eff, workMap)) continue;
			for (const aff of eff.affected) {
				const work = workMap.get(aff.instanceId);
				if (!work) continue;
				if (aff.objectVersion !== undefined && (work.inst.objectVersion ?? 1) !== aff.objectVersion) {
					continue;
				}
				let addedStatic = false;
				for (const gt of eff.layer6.grantedAbilityTexts) {
					for (const qDef of resolveQuotedAbilityDefs(gt, work.baseCard.name)) {
						if (qDef.kind === 'static') {
							work.statics.push(qDef.static);
							addedStatic = true;
						} else if (qDef.kind === 'keyword') {
							const kwSpec = getKeywordSpec(qDef.keyword.name);
							if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
								for (const st of kwSpec.implementation.buildStatics(qDef.keyword)) {
									work.statics.push(st);
									addedStatic = true;
								}
							}
						}
					}
				}
				if (addedStatic) {
					work.statics.sort((a, b) => staticLayerOrder(a) - staticLayerOrder(b));
				}
			}
		}
	}
	// --- End Track P21 ---
}

function isTimedContinuousEffectActive(
	eff: TimedContinuousEffect,
	workMap: Map<string, PermWorkState>
): boolean {
	// --- Track P16a (CR 611.2b) ---
	if (
		eff.expires === 'forAsLongAsYouControlSelf' ||
		eff.expires === 'forAsLongAsSelfRemainsTapped'
	) {
		const cond = eff.sourceCondition;
		if (!cond || cond.broken) return false;
		const src = workMap.get(cond.sourceInstanceId);
		if (!src || (src.inst.objectVersion ?? 1) !== cond.sourceObjectVersion) return false;
		if (cond.kind === 'controlledByPlayer') {
			return src.controllerId === cond.controllerId;
		}
		noteLayerRead(READ_TAPPED);
		return Boolean(src.inst.tapped);
	}
	// --- End Track P16a ---
	const usl = eff.layer2?.untilSourceLeaves;
	if (!usl) return true;
	const src = workMap.get(usl.sourceInstanceId);
	return Boolean(src && (src.inst.objectVersion ?? 1) === usl.sourceObjectVersion);
}

/**
 * Pass 0 — Layer 2 continuous control-changing effects (CR 613.1b, CR 613.6, CR 613.7).
 * Evaluated BEFORE Layers 4–7 so `"creatures you control"` anthems and restrictions immediately
 * reflect the Layer 2 controller, and BEFORE Layer 6 ability removal per CR 613.6.
 */
function evaluateLayer2Control(
	state: GameState,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	type Layer2Op =
		| {
				kind: 'static';
				timestamp: number;
				order: number;
				source: PermWorkState;
				st: StaticDef & { k: 'continuous' };
		  }
		| { kind: 'timed'; timestamp: number; order: number; eff: TimedContinuousEffect };
	const ops: Layer2Op[] = [];
	let order = 0;

	const layer2Sources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of layer2Sources) {
		for (const st of source.statics) {
			if (st.k === 'continuous' && st.layer === '2' && st.mod.k === 'setController') {
				ops.push({ kind: 'static', timestamp: source.timestamp, order: order++, source, st });
			}
		}
	}

	if (state.timedContinuousEffects?.length) {
		for (const eff of state.timedContinuousEffects) {
			if (!eff.layer2) continue;
			if (!isTimedContinuousEffectActive(eff, workMap)) continue;
			const targetPlayer = state.players.find((pl) => pl.playerId === eff.layer2!.controllerId);
			if (!targetPlayer || targetPlayer.lost) continue;
			ops.push({ kind: 'timed', timestamp: eff.timestamp, order: order++, eff });
		}
	}

	if (ops.length === 0) return;
	ops.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);

	for (const op of ops) {
		if (op.kind === 'static') {
			const { source, st } = op;
			if (st.mod.k !== 'setController') continue;
			if (st.affected === 'attachedTo') {
				if (!source.inst.attachedToId) continue;
				const target = workMap.get(source.inst.attachedToId);
				if (!target) continue;
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, target)) {
					continue;
				}
				target.controllerId = resolveLayerPlayerRef(st.mod.controller, state, source, target);
			} else if (st.affected === 'self') {
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, source)) {
					continue;
				}
				source.controllerId = resolveLayerPlayerRef(st.mod.controller, state, source, source);
			} else if (typeof st.affected === 'object') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, target, workMap)) {
						continue;
					}
					target.controllerId = resolveLayerPlayerRef(st.mod.controller, state, source, target);
				}
			}
		} else {
			const { eff } = op;
			const nextControllerId = eff.layer2!.controllerId;
			for (const aff of eff.affected) {
				const target = workMap.get(aff.instanceId);
				if (!target || (target.inst.objectVersion ?? 1) !== (aff.objectVersion ?? 1)) continue;
				target.controllerId = nextControllerId;
			}
		}
	}
}

function evaluateAttachedTypes(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	// --- Track P11: O(1) skip when nothing on the board is attached ---
	if (snap.attachedTo.size === 0) return;
	// --- End Track P11 ---
	// 2. Layer 4 Pass A: Attached type-setting effects, attached ability-removal registration, and attached 7b setters
	for (const target of workList) {
		const attached = workList
			.filter((att) => att.inst.attachedToId === target.inst.instanceId && !att.strippedByAttachment)
			.sort((a, b) => a.timestamp - b.timestamp);
		for (const att of attached) {

			let losesAbilities = false;
			for (const st of att.statics) {
				if (st.k !== 'continuous' || st.affected !== 'attachedTo') continue;
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, att, target)) {
					continue;
				}
				if (st.layer === '4' && st.mod.k === 'setTypes') {
					const wasAlreadyLand = target.types.includes('Land');
					// CR 205.4b: Changing card types or subtypes does not change supertypes.
					target.types = [...st.mod.types];
					target.subtypes = [...(st.mod.subtypes ?? [])];
					target.hasAllCreatureTypes = false;
					const superPrefix =
						target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
					const typeStr = target.types.join(' ');
					const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
					target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
					if (!target.typeModifiedBy.includes(att.name)) target.typeModifiedBy.push(att.name);
					if (wasAlreadyLand && target.types.includes('Land')) {
						target.latestSetLandSubtypesTs = Math.max(
							target.latestSetLandSubtypesTs ?? -Infinity,
							att.timestamp
						);
					}

					// CR 305.7: setting a basic land subtype on a land removes rules-text abilities
					if (
						target.types.includes('Land') &&
						target.subtypes.some((sub) => BASIC_LAND_SUBTYPES.has(sub))
					) {
						losesAbilities = true;
					}
				} else if (st.layer === '7b' && st.mod.k === 'setBasePT') {
					const p = evaluateLayerAmount(st.mod.power, state, workList, att, target);
					const t = evaluateLayerAmount(st.mod.toughness, state, workList, att, target);
					target.layer7bSetters.push({
						sourceName: att.name,
						power: p,
						toughness: t,
						timestamp: att.timestamp
					});
				// --- Track P14 ---
				} else if (st.layer === '7b' && st.mod.k === 'setBasePower') {
					const p = evaluateLayerAmount(st.mod.power, state, workList, att, target);
					target.layer7bSetters.push({
						sourceName: att.name,
						power: p,
						timestamp: att.timestamp
					});
				} else if (st.layer === '7b' && st.mod.k === 'setBaseToughness') {
					const t = evaluateLayerAmount(st.mod.toughness, state, workList, att, target);
					target.layer7bSetters.push({
						sourceName: att.name,
						toughness: t,
						timestamp: att.timestamp
					});
				// --- End Track P14 ---
				}
			}
			if (losesAbilities) {
				recordAbilityRemoval(target, att.name, att.timestamp, false, false, att.inst.instanceId);
			}
		}
	}
}

function reconcilePendingLandSubtypes(target: PermWorkState): void {
	if (!target.pendingLandSubtypes?.length) return;
	if (target.types.includes('Land')) {
		for (const pending of target.pendingLandSubtypes) {
			if (!target.typeModifiedBy.includes(pending.rawSourceName)) {
				target.typeModifiedBy.push(pending.rawSourceName);
			}
			if (pending.hasBasic) {
				recordAbilityRemoval(
					target,
					pending.removalSourceName,
					pending.timestamp,
					false,
					false,
					pending.sourceId
				);
			}
		}
	}
	target.pendingLandSubtypes = undefined;
}

function evaluateTypeOverwrites(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	// 3. Layer 4 Pass B: Global type-overwriting effects ("Nonbasic lands are Mountains." — CR 613.8 before additive land types)
	const overwriteSources =
		emblemWorkList.length > 0
			? [...workList, ...emblemWorkList].sort((a, b) => a.timestamp - b.timestamp)
			: workList;
	const sortedTimed = state.timedContinuousEffects?.length
		? state.timedContinuousEffects
				.map((eff, idx) => ({ eff, timedId: `timed:${idx}` }))
				.filter(
					({ eff }) =>
						isTimedContinuousEffectActive(eff, workMap) &&
						(eff.layer4?.setTypes?.length ||
							eff.layer4?.removeTypes?.length ||
							eff.layer4?.setSubtypes !== undefined)
				)
				.sort((a, b) => a.eff.timestamp - b.eff.timestamp)
		: [];
	let timedIdx = 0;
	const applyTimedOverwrite = ({
		eff,
		timedId
	}: {
		eff: TimedContinuousEffect;
		timedId: string;
	}): void => {
		for (const aff of eff.affected) {
			const target = workMap.get(aff.instanceId);
			if (!target || (target.inst.objectVersion ?? 1) !== (aff.objectVersion ?? 1)) continue;
			const overwrittenByLaterAttached = workList.some(
				(att) =>
					att.inst.attachedToId === target.inst.instanceId &&
					!att.strippedByAttachment &&
					att.abilityRemovalEvents.length === 0 &&
					att.timestamp > eff.timestamp &&
					att.statics.some(
						(st) =>
							st.k === 'continuous' &&
							st.layer === '4' &&
							st.affected === 'attachedTo' &&
							st.mod.k === 'setTypes' &&
							(!st.condition || evaluateLayerCondition(st.condition, state, workList, att, target))
					)
			);
			if (overwrittenByLaterAttached) continue;
			const wasAlreadyLand = target.types.includes('Land');
			if (eff.layer4?.setTypes?.length) {
				target.types = [...eff.layer4.setTypes];
				target.hasAllCreatureTypes = false;
				if (wasAlreadyLand && target.types.includes('Land')) {
					target.latestSetLandSubtypesTs = Math.max(
						target.latestSetLandSubtypesTs ?? -Infinity,
						eff.timestamp
					);
				}
			}
			if (eff.layer4?.removeTypes?.length) {
				target.types = target.types.filter((t) => !eff.layer4!.removeTypes!.includes(t));
				if (eff.layer4.removeTypes.includes('Creature')) {
					target.hasAllCreatureTypes = false;
				}
			}
			const hadLandTypeOrSubtypeRemoved =
				Boolean(eff.layer4?.setTypes?.length) ||
				Boolean(eff.layer4?.removeTypes?.includes('Land'));
			if (
				hadLandTypeOrSubtypeRemoved &&
				!target.types.includes('Land') &&
				eff.layer4?.setSubtypes === undefined
			) {
				target.subtypes = target.subtypes.filter((sub) => !LAND_SUBTYPES.has(sub));
			}
			let deferTypeModifiedBy = false;
			const settingLandSubtypes = Boolean(
				eff.layer4?.setSubtypes?.some((sub) => LAND_SUBTYPES.has(sub))
			);
			if (
				hadLandTypeOrSubtypeRemoved ||
				(eff.layer4?.setSubtypes !== undefined && settingLandSubtypes)
			) {
				target.pendingLandSubtypes = undefined;
			}
			if (eff.layer4?.setSubtypes !== undefined) {
				if (settingLandSubtypes) {
					target.latestSetLandSubtypesTs = Math.max(
						target.latestSetLandSubtypesTs ?? -Infinity,
						eff.timestamp
					);
				}
				let retainedSubtypes: string[] = [];
				if (settingLandSubtypes) {
					retainedSubtypes = target.subtypes.filter((sub) => !LAND_SUBTYPES.has(sub));
				} else if (!eff.layer4.setTypes?.length) {
					// CR 205.1b: Additive card types (e.g. "[subtype] artifact creature") retain subtypes
					// correlated with retained non-creature card types (such as land subtypes).
					// Pass C may still add 'Land' (e.g. Ashaya, Geomancer Rite), so retain land subtypes
					// across Pass B unless Land was removed; Pass C reconciles pendingLandSubtypes
					// and strips land subtypes if target is not a Land.
					retainedSubtypes = target.subtypes.filter(
						(sub) =>
							(!hadLandTypeOrSubtypeRemoved && LAND_SUBTYPES.has(sub)) ||
							((target.types.includes('Artifact') || eff.layer4?.addTypes?.includes('Artifact')) &&
								(sub === 'Equipment' ||
									sub === 'Vehicle' ||
									sub === 'Fortification' ||
									sub === 'Treasure' ||
									sub === 'Clue' ||
									sub === 'Food' ||
									sub === 'Blood' ||
									sub === 'Map' ||
									sub === 'Powerstone' ||
									sub === 'Gold' ||
									sub === 'Junk'))
					);
				}
				target.subtypes = [...eff.layer4.setSubtypes, ...retainedSubtypes];
				if (!settingLandSubtypes) {
					target.hasAllCreatureTypes = false;
				}
				const hasBasic = eff.layer4.setSubtypes.some((sub) => BASIC_LAND_SUBTYPES.has(sub));
				if (settingLandSubtypes) {
					(target.pendingLandSubtypes ??= []).push({
						rawSourceName: eff.sourceName,
						removalSourceName: eff.sourceName || 'Temporary Effect',
						timestamp: eff.timestamp,
						sourceId: timedId,
						hasBasic
					});
					if (
						!eff.layer4.setTypes?.length &&
						!eff.layer4.removeTypes?.length &&
						!eff.layer4.addTypes?.length
					) {
						deferTypeModifiedBy = true;
					}
				}
			}
			const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
			const typeStr = target.types.join(' ');
			const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
			target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
			if (!deferTypeModifiedBy && !target.typeModifiedBy.includes(eff.sourceName)) {
				target.typeModifiedBy.push(eff.sourceName);
			}
		}
	};
	for (const source of overwriteSources) {
		while (timedIdx < sortedTimed.length && sortedTimed[timedIdx].eff.timestamp <= source.timestamp) {
			applyTimedOverwrite(sortedTimed[timedIdx++]);
		}
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) {
			source.skippedLayer4SetSubtypes = true;
			continue;
		}
		for (const st of source.statics) {
			if (
				st.k !== 'continuous' ||
				st.layer !== '4' ||
				(st.mod.k !== 'setSubtypes' && st.mod.k !== 'setChosenSubtype')
			) {
				continue;
			}
			// --- Track P20a ---
			const effectiveSubtypes =
				st.mod.k === 'setChosenSubtype'
					? source.inst.chosenSubType
						? [source.inst.chosenSubType]
						: []
					: st.mod.subtypes;
			if (effectiveSubtypes.length === 0) continue;
			// --- End Track P20a ---
			const candidates =
				st.affected === 'self'
					? [source]
					: st.affected === 'attachedTo'
						? (() => {
								const hostId = source.inst.attachedToId;
								const host = hostId ? workMap.get(hostId) : undefined;
								return host ? [host] : [];
							})()
						: workList;
			for (const target of candidates) {
				if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
					continue;
				}
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, target, workMap)) {
					continue;
				}
				const overwrittenByLaterAttached = workList.some(
					(att) =>
						att.inst.attachedToId === target.inst.instanceId &&
						!att.strippedByAttachment &&
						att.abilityRemovalEvents.length === 0 &&
						att.timestamp > source.timestamp &&
						att.statics.some(
							(attSt) =>
								attSt.k === 'continuous' &&
								attSt.layer === '4' &&
								attSt.affected === 'attachedTo' &&
								attSt.mod.k === 'setTypes' &&
								(!attSt.condition || evaluateLayerCondition(attSt.condition, state, workList, att, target))
						)
				);
				if (overwrittenByLaterAttached) continue;
				// CR 205.1a, 205.4b, 305.7: Setting land subtypes replaces only land subtypes while
				// preserving supertypes, all card types (e.g. Artifact, Creature), and non-land subtypes.
				const settingLandSubtypes = effectiveSubtypes.some((sub) => LAND_SUBTYPES.has(sub));
				// --- Track P17a (CR 613.7): Track latest land-subtype overwrite timestamp per target ---
				if (settingLandSubtypes) {
					target.latestSetLandSubtypesTs = Math.max(
						target.latestSetLandSubtypesTs ?? -Infinity,
						source.timestamp
					);
					target.pendingLandSubtypes = undefined;
				}
				// --- End Track P17a ---
				const retainedSubtypes = settingLandSubtypes
					? target.subtypes.filter((sub) => !LAND_SUBTYPES.has(sub))
					: target.subtypes.filter(
							(sub) =>
								LAND_SUBTYPES.has(sub) ||
								(target.types.includes('Artifact') &&
									(sub === 'Equipment' ||
										sub === 'Vehicle' ||
										sub === 'Fortification' ||
										sub === 'Treasure' ||
										sub === 'Clue' ||
										sub === 'Food' ||
										sub === 'Blood' ||
										sub === 'Map' ||
										sub === 'Powerstone' ||
										sub === 'Gold' ||
										sub === 'Junk'))
						);
				target.subtypes = [...effectiveSubtypes, ...retainedSubtypes];
				const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
				const typeStr = target.types.join(' ');
				const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
				target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
				if (settingLandSubtypes) {
					const hasBasic =
						effectiveSubtypes.some((sub) => BASIC_LAND_SUBTYPES.has(sub)) &&
						target.inst.instanceId !== source.inst.instanceId;
					(target.pendingLandSubtypes ??= []).push({
						rawSourceName: source.name,
						removalSourceName: source.name,
						timestamp: source.timestamp,
						sourceId: source.inst.instanceId,
						hasBasic
					});
				} else if (!target.typeModifiedBy.includes(source.name)) {
					target.typeModifiedBy.push(source.name);
				}
			}
		}
	}
	while (timedIdx < sortedTimed.length) {
		applyTimedOverwrite(sortedTimed[timedIdx++]);
	}
	for (const target of workList) {
		if (target.types.includes('Land') && target.pendingLandSubtypes?.length) {
			reconcilePendingLandSubtypes(target);
		}
	}

	// --- Track P15: CR 702.176a (Impending) & CR 702.151b (Reconfigure) Layer 4 Creature-type removal ---
	for (const target of workList) {
		if (target.strippedByAttachment || target.abilityRemovalEvents.length > 0) continue;
		const losesCreatureViaImpending =
			Boolean(target.inst.castWithImpending) &&
			(target.inst.counters.time || 0) > 0 &&
			workHasActiveKeyword(target, 'impending');
		const losesCreatureViaReconfigure =
			target.inst.attachedToId !== null &&
			workMap.has(target.inst.attachedToId) &&
			workHasActiveKeyword(target, 'reconfigure');
		if ((losesCreatureViaImpending || losesCreatureViaReconfigure) && target.types.includes('Creature')) {
			target.types = target.types.filter((t) => t !== 'Creature');
			const retainsCreatureSubtypes = target.types.some(
				(t) => normalizeLayerCardType(t) === 'kindred'
			);
			if (!retainsCreatureSubtypes) {
				target.subtypes = target.subtypes.filter((sub) => NON_CREATURE_SUBTYPES.has(sub));
				target.hasAllCreatureTypes = false;
			}
			const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
			const typeStr = target.types.join(' ');
			const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
			target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
			const srcReason = losesCreatureViaImpending ? 'Impending' : 'Reconfigure';
			if (!target.typeModifiedBy.includes(srcReason)) {
				target.typeModifiedBy.push(srcReason);
			}
		}
	}
	// --- End Track P15 ---
}

function evaluateAdditiveTypesAndColors(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	const latestSetTypesTimestampOn = (target: PermWorkState): number => {
		let maxTs = -Infinity;
		for (const att of workList) {
			if (
				att.inst.attachedToId !== target.inst.instanceId ||
				att.strippedByAttachment ||
				att.abilityRemovalEvents.length > 0
			) {
				continue;
			}
			for (const st of att.statics) {
				if (
					st.k === 'continuous' &&
					st.layer === '4' &&
					st.affected === 'attachedTo' &&
					st.mod.k === 'setTypes' &&
					(!st.condition || evaluateLayerCondition(st.condition, state, workList, att, target))
				) {
					if (att.timestamp > maxTs) maxTs = att.timestamp;
				}
			}
		}
		if (state.timedContinuousEffects?.length) {
			for (const eff of state.timedContinuousEffects) {
				if (!isTimedContinuousEffectActive(eff, workMap) || !eff.layer4?.setTypes?.length) continue;
				if (
					eff.affected.some(
						(a) =>
							a.instanceId === target.inst.instanceId &&
							(a.objectVersion ?? 1) === (target.inst.objectVersion ?? 1)
					)
				) {
					if (eff.timestamp > maxTs) maxTs = eff.timestamp;
				}
			}
		}
		return maxTs;
	};

	// 4. Layer 4 Pass C: Attached & global additive type effects (Awaken the Ancient, Opalescence, Urborg, Yavimaya, Mycosynth Lattice, Maskwood Nexus)
	// --- Track P14 ---
	const latestRemovedTypeTs = new Map<string, number>();
	// --- End Track P14 ---
	const additiveSources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of additiveSources) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) {
			source.skippedLayer4Additive = true;
			continue;
		}
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '4') continue;
			if (
				st.affected !== 'self' &&
				st.affected !== 'attachedTo' &&
				typeof st.affected !== 'object'
			) {
				continue;
			}
			const candidateTargets: PermWorkState[] =
				st.affected === 'self'
					? [source]
					: st.affected === 'attachedTo'
						? source.inst.attachedToId && workMap.has(source.inst.attachedToId)
							? [workMap.get(source.inst.attachedToId)!]
							: []
						: workList;
			if (st.mod.k === 'addChosenSubtype') {
				const chosenSub = source.inst.chosenSubType;
				if (!chosenSub) continue;
				for (const target of candidateTargets) {
					if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (
						(st.affected === 'attachedTo' || st.affected === 'self') &&
						latestSetTypesTimestampOn(target) > source.timestamp
					) {
						continue;
					}
					if (!target.subtypes.some((s) => s.toLowerCase() === chosenSub.toLowerCase())) {
						target.subtypes.push(chosenSub);
					}
					const nextType = addSubtypeToTypeLine(target.effectiveTypeLine, chosenSub);
					if (nextType !== target.effectiveTypeLine) {
						target.effectiveTypeLine = nextType;
					}
					if (!target.typeModifiedBy.includes(source.name)) {
						target.typeModifiedBy.push(source.name);
					}
				}
			} else if (st.mod.k === 'addTypes') {
				for (const target of candidateTargets) {
					if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (st.affected === 'attachedTo' && latestSetTypesTimestampOn(target) > source.timestamp) {
						continue;
					}
					for (const ct of st.mod.types) {
						if (!target.types.includes(ct)) target.types.push(ct);
						const nextType = addCardTypeToTypeLine(target.effectiveTypeLine, ct);
						if (nextType !== target.effectiveTypeLine) {
							target.effectiveTypeLine = nextType;
							if (!target.typeModifiedBy.includes(source.name)) {
								target.typeModifiedBy.push(source.name);
							}
						}
					}
					for (const sub of st.mod.subtypes ?? []) {
						// --- Track P17a (CR 613.7): Skip additive land subtypes overwritten by a later-timestamp setSubtypes ---
						if (
							LAND_SUBTYPES.has(sub) &&
							(!target.types.includes('Land') ||
								(target.latestSetLandSubtypesTs ?? -Infinity) > source.timestamp)
						) {
							continue;
						}
						// --- End Track P17a ---
						if (!target.subtypes.includes(sub)) target.subtypes.push(sub);
						const nextType = addSubtypeToTypeLine(target.effectiveTypeLine, sub);
						if (nextType !== target.effectiveTypeLine) {
							target.effectiveTypeLine = nextType;
						}
						if (!target.typeModifiedBy.includes(source.name)) {
							target.typeModifiedBy.push(source.name);
						}
					}
				}
			} else if (st.mod.k === 'allCreatureTypes' && typeof st.affected === 'object') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					target.hasAllCreatureTypes = true;
					target.effectiveTypeLine = addSubtypeToTypeLine(target.effectiveTypeLine, 'All-Types');
					if (!target.typeModifiedBy.includes(source.name)) {
						target.typeModifiedBy.push(source.name);
					}
				}
			// --- Track P14 (CR 700.5, CR 613.1d, CR 205.1a): Layer 4 type removal (Theros Gods, etc.) ---
			} else if (st.mod.k === 'removeTypes') {
				for (const target of candidateTargets) {
					if (
						typeof st.affected === 'object' &&
						!matchesLayerFilter(st.affected, target, source, state, workList)
					) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (
						(st.affected === 'attachedTo' || st.affected === 'self') &&
						latestSetTypesTimestampOn(target) > source.timestamp
					) {
						continue;
					}
					let changed = false;
					let removedCreature = false;
					for (const rt of st.mod.types) {
						const rtLow = rt.toLowerCase();
						latestRemovedTypeTs.set(`${target.inst.instanceId}:${rtLow}`, source.timestamp);
						const beforeLen = target.types.length;
						target.types = target.types.filter((t) => t.toLowerCase() !== rtLow);
						if (target.types.length !== beforeLen) {
							changed = true;
							if (rtLow === 'creature') removedCreature = true;
						}
					}
					if (changed) {
						// CR 205.1a: Removing Creature (when neither Creature nor Kindred/Tribal remains)
						// also removes creature subtypes (such as God).
						if (
							removedCreature &&
							!target.types.some((t) => {
								const nl = normalizeLayerCardType(t);
								return nl === 'creature' || nl === 'kindred' || nl === 'planeswalker';
							})
						) {
							target.subtypes = target.subtypes.filter(
								(sub) => LAND_SUBTYPES.has(sub) || NON_CREATURE_SUBTYPES.has(sub)
							);
							target.hasAllCreatureTypes = false;
						}
						const superPrefix =
							target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
						const typeStr = target.types.join(' ');
						const rightParts = [...target.subtypes];
						if (
							target.hasAllCreatureTypes &&
							target.types.some((t) => {
								const nl = normalizeLayerCardType(t);
								return nl === 'creature' || nl === 'kindred';
							}) &&
							!rightParts.includes('All-Types')
						) {
							rightParts.push('All-Types');
						}
						const subStr = rightParts.length > 0 ? ` — ${rightParts.join(' ')}` : '';
						target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`.trim();
						if (!target.typeModifiedBy.includes(source.name)) {
							target.typeModifiedBy.push(source.name);
						}
					}
				}
			} else if (st.mod.k === 'setTypes' && st.affected === 'self') {
				if (
					!st.condition ||
					evaluateLayerCondition(st.condition, state, workList, source, source, workMap)
				) {
					if (latestSetTypesTimestampOn(source) <= source.timestamp) {
						source.types = [...st.mod.types];
						if (st.mod.subtypes?.length) {
							source.subtypes = [...st.mod.subtypes];
						} else if (
							!source.types.some((t) => {
								const nl = normalizeLayerCardType(t);
								return nl === 'creature' || nl === 'kindred' || nl === 'planeswalker';
							})
						) {
							source.subtypes = source.subtypes.filter(
								(sub) => LAND_SUBTYPES.has(sub) || NON_CREATURE_SUBTYPES.has(sub)
							);
							source.hasAllCreatureTypes = false;
						}
						const superPrefix =
							source.supertypes.length > 0 ? `${source.supertypes.join(' ')} ` : '';
						const subStr = source.subtypes.length > 0 ? ` — ${source.subtypes.join(' ')}` : '';
						source.effectiveTypeLine = `${superPrefix}${source.types.join(' ')}${subStr}`.trim();
						if (!source.typeModifiedBy.includes(source.name)) {
							source.typeModifiedBy.push(source.name);
						}
					}
				}
			} else if (st.mod.k === 'copyStatsAndSubtypesFromLastExiled' && st.affected === 'self') {
				if (
					!st.condition ||
					evaluateLayerCondition(st.condition, state, workList, source, source, workMap)
				) {
					applyLayer4CopyLastExiledWave9(state, source, source);
				}
			}
			// --- End Track P14 ---
		}
	}
	if (state.timedContinuousEffects?.length) {
		const sorted = [...state.timedContinuousEffects]
			.filter(
				(e) =>
					isTimedContinuousEffectActive(e, workMap) &&
					(e.layer4?.addTypes?.length || e.layer4?.addSubtypes?.length)
			)
			.sort((a, b) => a.timestamp - b.timestamp);
		for (const eff of sorted) {
			for (const aff of eff.affected) {
				const target = workMap.get(aff.instanceId);
				if (!target || (target.inst.objectVersion ?? 1) !== (aff.objectVersion ?? 1)) continue;
				if (latestSetTypesTimestampOn(target) > eff.timestamp) continue;
				for (const ct of eff.layer4?.addTypes ?? []) {
					// --- Track P14 ---
					const remTs = latestRemovedTypeTs.get(`${target.inst.instanceId}:${ct.toLowerCase()}`);
					if (remTs !== undefined && remTs > eff.timestamp) continue;
					// --- End Track P14 ---
					if (!target.types.includes(ct)) target.types.push(ct);
					const nextType = addCardTypeToTypeLine(target.effectiveTypeLine, ct);
					if (nextType !== target.effectiveTypeLine) {
						target.effectiveTypeLine = nextType;
						if (!target.typeModifiedBy.includes(eff.sourceName)) {
							target.typeModifiedBy.push(eff.sourceName);
						}
					}
				}
				for (const sub of eff.layer4?.addSubtypes ?? []) {
					if (
						LAND_SUBTYPES.has(sub) &&
						(!target.types.includes('Land') ||
							(target.latestSetLandSubtypesTs ?? -Infinity) > eff.timestamp)
					) {
						continue;
					}
					if (!target.subtypes.includes(sub)) target.subtypes.push(sub);
					const nextType = addSubtypeToTypeLine(target.effectiveTypeLine, sub);
					if (nextType !== target.effectiveTypeLine) {
						target.effectiveTypeLine = nextType;
					}
					if (!target.typeModifiedBy.includes(eff.sourceName)) {
						target.typeModifiedBy.push(eff.sourceName);
					}
				}
			}
		}
	}
	for (const target of workList) {
		reconcilePendingLandSubtypes(target);
		const isLand = target.types.includes('Land');
		if (!isLand && target.subtypes.some((sub) => LAND_SUBTYPES.has(sub))) {
			const hadAllTypesLabel = /\bAll-Types\b/.test(target.effectiveTypeLine);
			target.subtypes = target.subtypes.filter((sub) => !LAND_SUBTYPES.has(sub));
			const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
			const typeStr = target.types.join(' ');
			const rightParts = [...target.subtypes];
			if (hadAllTypesLabel && !rightParts.includes('All-Types')) {
				rightParts.push('All-Types');
			}
			const subStr = rightParts.length > 0 ? ` — ${rightParts.join(' ')}` : '';
			target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`.trim();
		}
	}
	// --- Track P13 (CR 701.54c, CR 613.1d): Ring Level >= 1 makes your Ring-bearer Legendary ---
	for (const p of state.players) {
		if (p.lost || (p.ringLevel ?? 0) < 1 || !p.ringBearerId) continue;
		const target = workMap.get(p.ringBearerId);
		if (!target || target.controllerId !== p.playerId || !target.types.includes('Creature')) {
			continue;
		}
		if (!target.supertypes.includes('Legendary')) {
			target.supertypes.unshift('Legendary');
		}
		target.isLegendary = true;
		target.prefixLegendary = 'Legendary ';
		if (!/\bLegendary\b/.test(target.effectiveTypeLine)) {
			target.effectiveTypeLine = `Legendary ${target.effectiveTypeLine}`;
		}
		if (!target.typeModifiedBy.includes('The Ring')) {
			target.typeModifiedBy.push('The Ring');
		}
	}
	// --- End Track P13 ---
}

function evaluateLayer5Colors(
	state: GameState,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	const applyColorMod = (
		target: PermWorkState,
		mod: { setColors?: ManaColor[]; addColors?: ManaColor[] }
	): void => {
		if (mod.setColors !== undefined) {
			target.colors = [...mod.setColors];
		}
		if (mod.addColors) {
			for (const c of mod.addColors) {
				if (!target.colors.includes(c)) target.colors.push(c);
			}
		}
	};

	// 5a. Layer 5 CDAs (CR 613.3: applied first; CR 613.6: unaffected by Layer 6 ability removal).
	for (const source of workList) {
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '5' || st.affected !== 'self') continue;
			if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, source)) {
				continue;
			}
			applyColorMod(source, {
				setColors: st.mod.k === 'setColors' ? st.mod.colors : undefined,
				addColors: st.mod.k === 'addColors' ? st.mod.colors : undefined
			});
		}
	}

	// 5b. Non-CDA Layer 5 effects (attached, global, timed) sorted by timestamp (CR 613.3, 613.7).
	interface Layer5Op {
		timestamp: number;
		target: PermWorkState;
		setColors?: ManaColor[];
		addColors?: ManaColor[];
	}
	const ops: Layer5Op[] = [];
	const layer5Sources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of layer5Sources) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) continue;
		for (const st of source.statics) {
			// --- Track P22a: Pre-game commander color choice (CR 903.4 / 103) ---
			if (st.k === 'commanderPreGameColorChoice') {
				const preCol = source.inst.preGameChosenColor ?? source.inst.chosenColor;
				if (preCol && preCol !== 'C') {
					ops.push({
						timestamp: source.timestamp,
						target: source,
						setColors: [preCol]
					});
				}
				continue;
			}
			// --- End Track P22a ---
			if (st.k !== 'continuous' || st.layer !== '5') continue;
			if (st.affected === 'self' && st.mod.k !== 'setChosenColor') continue;
			if (
				st.mod.k !== 'setColors' &&
				st.mod.k !== 'addColors' &&
				st.mod.k !== 'setChosenColor' &&
				// --- Track P17a ---
				st.mod.k !== 'addChosenColor'
				// --- End Track P17a ---
			) {
				continue;
			}
			const chosenColors =
				st.mod.k === 'setChosenColor' || st.mod.k === 'addChosenColor'
					? source.inst.chosenColor
						? source.inst.chosenColor === 'C'
							? []
							: [source.inst.chosenColor]
						: undefined
					: undefined;
			if ((st.mod.k === 'setChosenColor' || st.mod.k === 'addChosenColor') && chosenColors === undefined) {
				continue;
			}
			let targets: PermWorkState[] = [];
			if (st.affected === 'self') {
				targets = [source];
			} else if (st.affected === 'attachedTo') {
				const hostId = source.inst.attachedToId;
				const host = hostId ? workMap.get(hostId) : undefined;
				if (host) targets = [host];
			} else if (typeof st.affected === 'object') {
				targets = workList.filter((t) =>
					matchesLayerFilter(st.affected as ObjectFilter, t, source, state, workList)
				);
			}
			for (const target of targets) {
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
				) {
					continue;
				}
				ops.push({
					timestamp: source.timestamp,
					target,
					setColors:
						st.mod.k === 'setColors'
							? st.mod.colors
							: st.mod.k === 'setChosenColor'
								? chosenColors
								: undefined,
					addColors:
						st.mod.k === 'addColors'
							? st.mod.colors
							: // --- Track P17a ---
								st.mod.k === 'addChosenColor'
								? chosenColors
								: undefined
					// --- End Track P17a ---
				});
			}
		}
	}
	if (state.timedContinuousEffects?.length) {
		for (const eff of state.timedContinuousEffects) {
			if (!eff.layer5 || !isTimedContinuousEffectActive(eff, workMap)) continue;
			for (const ref of eff.affected) {
				const target = workMap.get(ref.instanceId);
				if (!target) continue;
				if ((target.inst.objectVersion ?? 1) !== (ref.objectVersion ?? 1)) continue;
				ops.push({
					timestamp: eff.timestamp,
					target,
					setColors: eff.layer5.setColors,
					addColors: eff.layer5.addColors
				});
			}
		}
	}
	ops.sort((a, b) => a.timestamp - b.timestamp);
	for (const op of ops) {
		applyColorMod(op.target, op);
	}
}

function evaluateGlobalAbilityLoss(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	// 5. Layer 6 Global "lose all abilities" (Humility, Dress Down)
	const abilityLossSources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of abilityLossSources) {
		if (source.strippedByAttachment || source.statics.length === 0) continue;
		for (const st of source.statics) {
			if (st.k !== 'continuous' || typeof st.affected !== 'object') continue;
			if (st.layer === '6' && st.mod.k === 'removeAllAbilities') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					// --- Track P17a ---
					recordAbilityRemoval(
						target,
						source.name,
						source.timestamp,
						Boolean(st.mod.keepManaAbilities),
						true,
						source.inst.instanceId
					);
					// --- End Track P17a ---
				}
			}
		}
	}
	if (snap.attachedTo.size > 0) {
		for (const att of workList) {
			if (att.strippedByAttachment || !att.inst.attachedToId) continue;
			const target = workMap.get(att.inst.attachedToId);
			if (!target) continue;
			for (const st of att.statics) {
				if (st.k !== 'continuous' || st.layer !== '6' || st.affected !== 'attachedTo') continue;
				if (st.mod.k !== 'removeAllAbilities') continue;
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, att, target, workMap)
				) {
					continue;
				}
				recordAbilityRemoval(
					target,
					att.name,
					att.timestamp,
					Boolean(st.mod.keepManaAbilities),
					true,
					att.inst.instanceId
				);
			}
		}
	}
	// --- Track P16a (CR 613.1f): Timed Layer 6 "loses all abilities" continuous effects ---
	if (state.timedContinuousEffects?.length) {
		for (let ti = 0; ti < state.timedContinuousEffects.length; ti++) {
			const eff = state.timedContinuousEffects[ti];
			if (!eff.layer6?.removeAllAbilities) continue;
			if (!isTimedContinuousEffectActive(eff, workMap)) continue;
			const timedId = `timed:${ti}`;
			for (const a of eff.affected) {
				const target = workMap.get(a.instanceId);
				if (!target || (target.inst.objectVersion ?? 1) !== (a.objectVersion ?? 1)) continue;
				recordAbilityRemoval(target, eff.sourceName || 'Temporary Effect', eff.timestamp, false, true, timedId);
			}
		}
	}
	// --- End Track P16a ---
}

// --- Track P8 ---
function grantStatModItem(
	work: PermWorkState,
	canonicalKey: string,
	name: string,
	sourceName: string,
	grantTimestamp: number
): void {
	const keyLow = canonicalKey.toLowerCase();
	const id = `granted_${work.items.length}_${keyLow}`;
	work.itemTimestamps.set(id, grantTimestamp);
	const item: AttributedKeywordOrEffect = {
		id,
		canonicalKey: keyLow,
		name,
		kind: 'stat_mod',
		isInnate: false,
		sources: [sourceName],
		grantCount: 1,
		removed: false,
		removedBy: []
	};
	let lastInnate = -1;
	let lastFromSource = -1;
	for (let i = 0; i < work.items.length; i++) {
		if (work.items[i].isInnate) lastInnate = i;
		if (work.items[i].sources.includes(sourceName)) {
			lastFromSource = i;
		}
	}
	const insertAfter = Math.max(lastInnate, lastFromSource);
	if (lastFromSource >= 0 && insertAfter < work.items.length - 1) {
		work.items.splice(insertAfter + 1, 0, item);
	} else {
		work.items.push(item);
	}
}

function evaluatePerPermanent(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	// --- Track P8: Strict CR 613.1 layer ordering across all permanents ---
	// 6a. Pre-initialize Layer 6 working P/T (printed / Layer 1 copy values; * = 0 prior to Layer 7a).
	for (const target of workList) {
		if (!target.types.includes('Creature')) {
			target.workingPower = null;
			target.workingToughness = null;
		} else {
			if (target.workingPower === null) target.workingPower = 0;
			if (target.workingToughness === null) target.workingToughness = 0;
		}
	}

	// --- Track P11 + Track P13 ---
	let anyGrantedStaticInBoard = false;
	const staticSources =
		emblemWorkList.length > 0
			? [
					...workList.filter((w) => w.statics.length > 0 && !w.strippedByAttachment),
					...emblemWorkList.filter((e) => e.statics.length > 0)
				].sort((a, b) => a.timestamp - b.timestamp)
			: workList.filter((w) => w.statics.length > 0 && !w.strippedByAttachment);
	// --- End Track P11 + Track P13 ---
	// --- Track P14 (CR 113.6b): Graveyard continuous statics (Wonder, Brawn, Anger, Filth, Valor, Glory) ---
	noteLayerRead(READ_P14);
	const graveyardStaticSources: PermWorkState[] = [];
	for (let pi = 0; pi < state.players.length; pi++) {
		const pl = state.players[pi];
		if (pl.lost || pl.graveyard.length === 0) continue;
		const gyEntries = collectGraveyardContinuousStaticsForPlayer(pl);
		if (gyEntries.length === 0) continue;
		const byInst = new Map<CardInstance, StaticDef[]>();
		for (let gi = 0; gi < gyEntries.length; gi++) {
			const e = gyEntries[gi];
			let list = byInst.get(e.cardInst);
			if (!list) {
				list = [];
				byInst.set(e.cardInst, list);
			}
			list.push(e.staticDef);
		}
		for (const [gyInst, gyStatics] of byInst) {
			const gyCard = effectiveCardForObject(gyInst);
			const gyView = resolveObjectFaces(gyCard, instanceFaceOptions(gyInst, 'graveyard'));
			const gyWork: PermWorkState = {
				inst: gyInst,
				controllerId: pl.playerId,
				baseCard: gyCard,
				timestamp: gyInst.enteredTimestamp ?? 0,
				name: gyView.name,
				manaCost: gyView.manaCost,
				manaValue: gyView.manaValue,
				isFaceDown: false,
				baseTypeLine: gyView.typeLine,
				effectiveTypeLine: gyView.typeLine,
				supertypes: [...gyView.supertypes],
				types: [...gyView.types],
				subtypes: normalizeSubtypes(gyView.subtypes),
				colors: [...gyView.colors],
				isLegendary: gyView.supertypes.includes('Legendary'),
				prefixLegendary: gyView.supertypes.includes('Legendary') ? 'Legendary ' : '',
				hasAllCreatureTypes: false,
				basePower: gyView.power ?? null,
				baseToughness: gyView.toughness ?? null,
				workingPower: gyView.power ?? null,
				workingToughness: gyView.toughness ?? null,
				typeModifiedBy: [],
				ptModifiedBy: [],
				allAbilityRemovalSources: [],
				abilityRemovalEvents: [],
				layer7bSetters: [],
				items: [],
				itemTimestamps: new Map(),
				statics: gyStatics,
				grantsKeywordViaAbility: new Set(),
				strippedByAttachment: false
			};
			graveyardStaticSources.push(gyWork);
			staticSources.push(gyWork);
		}
	}
	if (graveyardStaticSources.length > 0) {
		staticSources.sort((a, b) => a.timestamp - b.timestamp);
	}
	// --- End Track P14 ---
	// 6b. Layer 6 across ALL permanents (CR 613.1f): innate removal, Layer 6 grants/removals, cantHaveLocks, Suspend/Blitz haste.
	for (const target of workList) {
		const targetVersion = target.inst.objectVersion ?? 1;
		const matchingTimedCont: Array<{ eff: TimedContinuousEffect; timedId: string }> = [];
		if (state.timedContinuousEffects?.length) {
			for (let ti = 0; ti < state.timedContinuousEffects.length; ti++) {
				const eff = state.timedContinuousEffects[ti];
				if (!isTimedContinuousEffectActive(eff, workMap)) continue;
				if (
					eff.affected.some(
						(a) => a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					matchingTimedCont.push({ eff, timedId: `timed:${ti}` });
				}
			}
		}
		const isOverwrittenByLaterAttachedSetTypes = (ts: number): boolean =>
			workList.some(
				(att) =>
					att.inst.attachedToId === target.inst.instanceId &&
					!att.strippedByAttachment &&
					!att.abilityRemovalEvents.some((e) => !e.fromLayer6) &&
					att.timestamp > ts &&
					att.statics.some(
						(attSt) =>
							attSt.k === 'continuous' &&
							attSt.layer === '4' &&
							attSt.affected === 'attachedTo' &&
							attSt.mod.k === 'setTypes' &&
							(!attSt.condition || evaluateLayerCondition(attSt.condition, state, workList, att, target))
					)
			);
		const isOverwrittenByLaterAttachedSetTypesNonRemoval = (ts: number): boolean =>
			workList.some(
				(att) =>
					att.inst.attachedToId === target.inst.instanceId &&
					!att.strippedByAttachment &&
					!att.abilityRemovalEvents.some((e) => !e.fromLayer6) &&
					att.timestamp > ts &&
					att.statics.some(
						(attSt) =>
							attSt.k === 'continuous' &&
							attSt.layer === '4' &&
							attSt.affected === 'attachedTo' &&
							attSt.mod.k === 'setTypes' &&
							(!attSt.condition ||
								evaluateLayerCondition(attSt.condition, state, workList, att, target, workMap))
					) &&
					!att.statics.some(
						(attSt) =>
							attSt.k === 'continuous' &&
							attSt.layer === '6' &&
							attSt.affected === 'attachedTo' &&
							attSt.mod.k === 'removeAllAbilities' &&
							!attSt.mod.keepManaAbilities &&
							(!attSt.condition ||
								evaluateLayerCondition(attSt.condition, state, workList, att, target, workMap))
					)
			);
		const isOverwrittenByLaterTimedLandLoss = (ts: number): boolean =>
			matchingTimedCont.some(
				({ eff: e2 }) =>
					e2.timestamp > ts &&
					Boolean(e2.layer4?.setTypes?.length || e2.layer4?.removeTypes?.includes('Land'))
			);

		// Mark innate items as removed if any ability-removal source applies
		if (target.allAbilityRemovalSources.length > 0) {
			for (const item of target.items) {
				if (item.isInnate) {
					item.removed = true;
					for (const src of target.allAbilityRemovalSources) {
						if (!item.removedBy.includes(src)) {
							item.removedBy.push(src);
						}
					}
				}
			}
		}

		const targetTimedEffects: TimedKeywordEffect[] = [];
		const timedGrantedCounts = new Map<string, number>();
		if (state.timedKeywordEffects?.length) {
			for (const eff of state.timedKeywordEffects) {
				if (
					eff.affected.some(
						(a) => a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					targetTimedEffects.push(eff);
					for (const kw of eff.addKeywords ?? []) {
						const gLow = kw.toLowerCase();
						timedGrantedCounts.set(gLow, (timedGrantedCounts.get(gLow) ?? 0) + 1);
					}
				}
			}
		}
		const timedLayer4LandEntries: Array<{
			timestamp: number;
			sourceName: string;
			timedId: string;
			info: { sym: string; subtype: string };
			isAdd: boolean;
		}> = [];
		for (const { eff, timedId } of matchingTimedCont) {
			// --- Track P10 ---
			let extraQuotedKws: string[] | undefined;
			if (eff.layer6?.grantedAbilityTexts?.length) {
				for (const gt of eff.layer6.grantedAbilityTexts) {
					for (const def of resolveQuotedAbilityDefs(gt, target.name)) {
						if (def.kind === 'keyword') {
							(extraQuotedKws ??= []).push(formatGrantedKeywordDef(def.keyword));
						}
					}
				}
			}
			const combinedAddKws = extraQuotedKws
				? [...(eff.layer6?.addKeywords ?? []), ...extraQuotedKws]
				: eff.layer6?.addKeywords;
			// --- End Track P10 ---
			if (eff.layer6 && (combinedAddKws?.length || eff.layer6.removeKeywords?.length)) {
				targetTimedEffects.push({
					timestamp: eff.timestamp,
					sourceName: eff.sourceName,
					controllerId: eff.controllerId,
					affected: eff.affected,
					addKeywords: combinedAddKws,
					removeKeywords: eff.layer6.removeKeywords,
					cantHaveOrGain: eff.layer6.cantHaveOrGain
				});
			}
			// --- Track P12: Backup-granted keywords in Layer 6 (CR 702.165a–d) ---
			if (eff.backupGrant) {
				const bDef = compileCard(eff.backupGrant.sourceCard);
				const faceAbs =
					eff.backupGrant.faceIndex > 0 && bDef.faces?.[eff.backupGrant.faceIndex]
						? bDef.faces[eff.backupGrant.faceIndex].abilities
						: (bDef.faces[0]?.abilities ?? []);
				const grantedKws: string[] = [];
				for (let bi = Math.max(0, eff.backupGrant.startAbilityIndex); bi < faceAbs.length; bi++) {
					const fAb = faceAbs[bi];
					if (fAb.kind === 'keyword') grantedKws.push(formatGrantedKeywordDef(fAb.keyword));
				}
				if (grantedKws.length > 0) {
					targetTimedEffects.push({
						timestamp: eff.timestamp,
						sourceName: eff.sourceName,
						controllerId: eff.controllerId,
						affected: eff.affected,
						addKeywords: grantedKws
					});
				}
			}
			// --- End Track P12 ---
			if (
				eff.layer4?.setSubtypes !== undefined &&
				target.types.includes('Land') &&
				(target.latestSetLandSubtypesTs ?? -Infinity) <= eff.timestamp &&
				!isOverwrittenByLaterAttachedSetTypes(eff.timestamp) &&
				!isOverwrittenByLaterTimedLandLoss(eff.timestamp)
			) {
				for (const sub of eff.layer4.setSubtypes) {
					const info = BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()];
					if (info && hasSubtypeInWork(target, info.subtype)) {
						timedLayer4LandEntries.push({
							timestamp: eff.timestamp,
							sourceName: eff.sourceName || 'Temporary Effect',
							timedId,
							info,
							isAdd: false
						});
					}
				}
			}
			if (
				eff.layer4?.addSubtypes?.length &&
				target.types.includes('Land') &&
				(target.latestSetLandSubtypesTs ?? -Infinity) <= eff.timestamp &&
				!isOverwrittenByLaterAttachedSetTypes(eff.timestamp) &&
				!isOverwrittenByLaterTimedLandLoss(eff.timestamp)
			) {
				for (const sub of eff.layer4.addSubtypes) {
					const info = BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()];
					if (info && hasSubtypeInWork(target, info.subtype)) {
						timedLayer4LandEntries.push({
							timestamp: eff.timestamp,
							sourceName: eff.sourceName || 'Temporary Effect',
							timedId,
							info,
							isAdd: true
						});
					}
				}
			}
		}
		if (timedLayer4LandEntries.length > 1) {
			timedLayer4LandEntries.sort((a, b) => a.timestamp - b.timestamp);
		}
		// --- Track P11 (CR 122.1b, 613.7c): Keyword counters grant their keyword in Layer 6 at counter timestamp ---
		noteLayerRead(READ_KEYWORD_COUNTERS);
		const targetKwCounterMask = computeKeywordCounterMask(target.inst.counters);
		if (targetKwCounterMask !== 0) {
			for (let ki = 0; ki < KEYWORD_COUNTER_TYPES.length; ki++) {
				if (!(targetKwCounterMask & (1 << ki))) continue;
				const kw = KEYWORD_COUNTER_TYPES[ki];
				const kwTs = target.inst.counterTimestamps?.[kw] ?? target.timestamp;
				targetTimedEffects.push({
					timestamp: kwTs,
					sourceName: `${formatKeywordLabel(kw)} counter`,
					controllerId: target.controllerId,
					affected: [
						{ instanceId: target.inst.instanceId, objectVersion: target.inst.objectVersion ?? 1 }
					],
					addKeywords: [kw]
				});
			}
		}
		// --- End Track P11 ---
		// --- Track P16a (CR 122.1b, 613.7c): Extended keyword counters ('shadow', 'exalted', 'decayed') ---
		noteLayerRead(READ_P16A);
		for (const kw of P16A_EXTRA_KEYWORD_COUNTERS) {
			if ((target.inst.counters[kw] || 0) <= 0) continue;
			const kwTs = target.inst.counterTimestamps?.[kw] ?? target.timestamp;
			targetTimedEffects.push({
				timestamp: kwTs,
				sourceName: `${formatKeywordLabel(kw)} counter`,
				controllerId: target.controllerId,
				affected: [
					{ instanceId: target.inst.instanceId, objectVersion: target.inst.objectVersion ?? 1 }
				],
				addKeywords: [kw]
			});
		}
		// --- End Track P16a ---
		if (targetTimedEffects.length > 1) {
			targetTimedEffects.sort((a, b) => a.timestamp - b.timestamp);
		}

		// Direct array mutations on `grantedKeywords` (e.g. unit tests bypassing `executeEffectSteps`)
		// carry no timestamp; apply those not already backed by `timedKeywordEffects` at timestamp 0.
		for (const gKw of target.inst.grantedKeywords || []) {
			const gLow = gKw.toLowerCase();
			const tracked = timedGrantedCounts.get(gLow) ?? 0;
			if (tracked > 0) {
				timedGrantedCounts.set(gLow, tracked - 1);
				continue;
			}
			let sourceLabel = 'Temporary Effect';
			for (const w of workList) {
				if (
					w.controllerId === target.controllerId &&
					w.grantsKeywordViaAbility.has(gLow)
				) {
					sourceLabel = w.baseCard.name;
					break;
				}
			}
			grantKeywordString(target, gKw, sourceLabel, 0);
		}

		const cantHaveLocks: Array<{ keywords: readonly string[]; sourceName: string }> = [];
		const applyTimedEffect = (eff: TimedKeywordEffect): void => {
			if (target.abilityRemovalEvents.length > 0) {
				applyRemovalsUpTo(target, eff.timestamp);
			}
			if (eff.addKeywords?.length) {
				const sourceLabel = eff.sourceName || 'Temporary Effect';
				for (const kw of eff.addKeywords) {
					grantKeywordString(target, kw, sourceLabel, eff.timestamp);
				}
			}
			if (eff.removeKeywords?.length) {
				removeMatchingKeywordsUpTo(target, eff.removeKeywords, eff.sourceName, eff.timestamp);
				if (eff.cantHaveOrGain) {
					cantHaveLocks.push({ keywords: eff.removeKeywords, sourceName: eff.sourceName });
				}
			}
		};

		let timedIdx = 0;
		let timedLandIdx = 0;
		const applyTimedLayer4LandEntry = (entry: (typeof timedLayer4LandEntries)[number]): void => {
			if (target.abilityRemovalEvents.length > 0) {
				applyRemovalsUpTo(target, entry.timestamp);
			}
			grantItem(
				target,
				`mana_${entry.info.sym.toLowerCase()}`,
				`Mana Ability: Add {${entry.info.sym}}`,
				'ability',
				entry.sourceName,
				entry.timestamp,
				{
					grantedAbility: makeIntrinsicBasicManaAbility(entry.info.sym as ManaColor),
					sourceInstanceId: entry.timedId
				}
			);
			grantItem(
				target,
				entry.isAdd && entry.info.subtype === 'Forest'
					? 'type_forest_add'
					: `type_${entry.info.subtype.toLowerCase()}`,
				entry.isAdd ? `Subtype: +${entry.info.subtype}` : `Type: Land — ${entry.info.subtype}`,
				'type_mod',
				entry.sourceName,
				entry.timestamp
			);
		};

		// CR 702.152a: "As long as this permanent's blitz cost was paid, it has haste"
		if (
			target.inst.blitzed &&
			!target.isFaceDown &&
			!target.strippedByAttachment &&
			target.allAbilityRemovalSources.length === 0
		) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Blitz', target.timestamp);
		}
		// --- Track P9 ---
		// CR 702.109a: "As long as this permanent's dash cost was paid, it has haste."
		if (
			target.inst.dashed &&
			!target.isFaceDown &&
			!target.strippedByAttachment &&
			target.allAbilityRemovalSources.length === 0
		) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Dash', target.timestamp);
		}
		// CR 702.136a: Riot haste option ("If you don't, it gains haste").
		if (target.inst.riotHaste) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Riot', target.timestamp);
		}
		// --- Track P10 (CR 701.60c): Suspected permanents have menace ---
		if (target.inst.isSuspected) {
			grantItem(target, 'menace', 'Menace', 'keyword', 'Suspected', target.timestamp);
		}
		// --- End Track P10 ---

		for (const source of staticSources) {
			while (
				timedIdx < targetTimedEffects.length &&
				targetTimedEffects[timedIdx].timestamp <= source.timestamp
			) {
				applyTimedEffect(targetTimedEffects[timedIdx++]);
			}
			while (
				timedLandIdx < timedLayer4LandEntries.length &&
				timedLayer4LandEntries[timedLandIdx].timestamp <= source.timestamp
			) {
				applyTimedLayer4LandEntry(timedLayer4LandEntries[timedLandIdx++]);
			}
			if (target.abilityRemovalEvents.length > 0) {
				applyRemovalsUpTo(target, source.timestamp);
			}

			const sourceLostAbilities = source.allAbilityRemovalSources.length > 0;

			// A. Attached Layer 4/6 effects on `target`
			if (source.inst.attachedToId === target.inst.instanceId) {
				let basePtSuffix = '';
				for (const st of source.statics) {
					if (
						st.k === 'continuous' &&
						st.layer === '7b' &&
						st.affected === 'attachedTo' &&
						st.mod.k === 'setBasePT'
					) {
						const p = evaluateLayerAmount(st.mod.power, state, workList, source, target);
						const t = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
						basePtSuffix = ` (${p}/${t})`;
					}
				}

				for (const st of source.statics) {
					if (st.k !== 'continuous' || st.affected !== 'attachedTo' || st.mod.k === 'pt') continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (st.mod.k === 'setTypes') {
						if (st.mod.types.includes('Creature') && (st.mod.subtypes ?? []).length > 0) {
							const sub = st.mod.subtypes![0];
							const typeLabel = `${st.mod.types.join(' ')} — ${st.mod.subtypes!.join(' ')}${basePtSuffix}`;
							grantItem(
								target,
								`type_${sub.toLowerCase()}`,
								`Type: ${typeLabel}`,
								'type_mod',
								source.name,
								source.timestamp
							);
						} else if (st.mod.types.includes('Land')) {
							const sub = st.mod.subtypes?.[0];
							const info = sub ? BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()] : undefined;
							if (info) {
								if (
									(target.latestSetLandSubtypesTs ?? -Infinity) <= source.timestamp &&
									!isOverwrittenByLaterAttachedSetTypesNonRemoval(source.timestamp) &&
									!isOverwrittenByLaterTimedLandLoss(source.timestamp)
								) {
									grantItem(
										target,
										`mana_${info.sym.toLowerCase()}`,
										`Mana Ability: Add {${info.sym}}`,
										'ability',
										source.name,
										source.timestamp,
										{
											grantedAbility: makeIntrinsicBasicManaAbility(info.sym as ManaColor),
											sourceInstanceId: source.inst.instanceId
										}
									);
									grantItem(
										target,
										`type_${info.subtype.toLowerCase()}`,
										`Type: Land — ${info.subtype}`,
										'type_mod',
										source.name,
										source.timestamp
									);
								}
							} else {
								for (const st2 of source.statics) {
									if (
										st2.k === 'continuous' &&
										st2.affected === 'attachedTo' &&
										st2.mod.k === 'grantAbility' &&
										st2.mod.ability.kind === 'activated'
									) {
										const desc = describeGrantedActivatedAbility(
											st2.mod.ability,
											source.inst.instanceId
										);
										grantItem(
											target,
											desc.key,
											desc.name,
											'ability',
											source.name,
											source.timestamp,
											{
												grantedAbility: st2.mod.ability,
												grantSourceCard: source.baseCard,
												grantSourceId: source.inst.instanceId,
												grantFaceIndex: lookupStaticLocator(source.baseCard, st2)?.faceIndex ?? 0
											}
										);
									}
								}
								if (
									target.types.includes('Land') &&
									(target.latestSetLandSubtypesTs ?? -Infinity) <= source.timestamp &&
									!isOverwrittenByLaterAttachedSetTypes(source.timestamp) &&
									!isOverwrittenByLaterTimedLandLoss(source.timestamp)
								) {
									grantItem(
										target,
										'type_land',
										'Type: Colorless Land',
										'type_mod',
										source.name,
										source.timestamp
									);
								}
							}
						}
					} else if (st.mod.k === 'addTypes' && st.mod.types.includes('Creature')) {
						const sub = st.mod.subtypes?.[0] ?? 'creature';
						const subSuffix = st.mod.subtypes?.length ? ` — ${st.mod.subtypes.join(' ')}` : '';
						const typeLabel = `${st.mod.types.join(' ')}${subSuffix}${basePtSuffix}`;
						grantItem(
							target,
							`type_${sub.toLowerCase()}`,
							`Type: ${typeLabel}`,
							'type_mod',
							source.name,
							source.timestamp
						);
					} else if (st.mod.k === 'grantAbility' && st.mod.ability.kind === 'activated') {
						const alreadyGrantedInLandSet = source.statics.some(
							(s2) =>
								s2.k === 'continuous' &&
								s2.affected === 'attachedTo' &&
								s2.mod.k === 'setTypes' &&
								s2.mod.types.includes('Land') &&
								!(s2.mod.subtypes?.[0] && BASIC_LAND_MANA_BY_SUBTYPE[s2.mod.subtypes[0].toLowerCase()])
						);
						if (!alreadyGrantedInLandSet) {
							const desc = describeGrantedActivatedAbility(st.mod.ability, source.inst.instanceId);
							grantItem(target, desc.key, desc.name, 'ability', source.name, source.timestamp, {
								grantedAbility: st.mod.ability,
								grantSourceCard: source.baseCard,
								grantSourceId: source.inst.instanceId,
								grantFaceIndex: lookupStaticLocator(source.baseCard, st)?.faceIndex ?? 0
							});
						}
					// --- Track P11 ---
					} else if (st.mod.k === 'grantAbility') {
						if (grantNonActivatedAbility(target, source, st, st.mod.ability)) {
							anyGrantedStaticInBoard = true;
						}
					// --- End Track P11 ---
					} else if (st.mod.k === 'addKeywords') {
						// --- Track P14 ---
						const protMeta: GrantedAbilityMeta | undefined = st.mod.protectionAttachmentExemption
							? {
									grantSourceId: source.inst.instanceId,
									protectionExemption: {
										mode: st.mod.protectionAttachmentExemption,
										sourceId: source.inst.instanceId,
										controllerId: source.controllerId
									}
								}
							: undefined;
						// --- End Track P14 ---
						for (const kw of sortGrantedKeywords(st.mod.keywords)) {
							const kwLow = kw.toLowerCase();
							if (kwLow.startsWith('ward')) {
								grantKeywordString(target, kw, source.name, source.timestamp);
								continue;
							}
							const key = kwLow.startsWith('protection from ') ? 'protection' : kwLow;
							grantItem(
								target,
								key,
								formatKeywordLabel(kwLow),
								'keyword',
								source.name,
								source.timestamp,
								// --- Track P14 ---
								key === 'protection' ? protMeta : undefined
								// --- End Track P14 ---
							);
						}
					} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenColor') {
						const chosenCol = source.inst.chosenColor;
						const kw = chosenCol ? PROTECTION_KEYWORD_BY_COLOR[chosenCol] : undefined;
						if (kw) {
							// --- Track P14 ---
							const chosenProtMeta: GrantedAbilityMeta | undefined = st.mod
								.protectionAttachmentExemption
								? {
										grantSourceId: source.inst.instanceId,
										protectionExemption: {
											mode: st.mod.protectionAttachmentExemption,
											sourceId: source.inst.instanceId,
											controllerId: source.controllerId
										}
									}
								: undefined;
							// --- End Track P14 ---
							grantItem(
								target,
								'protection',
								formatKeywordLabel(kw),
								'keyword',
								source.name,
								source.timestamp,
								// --- Track P14 ---
								chosenProtMeta
								// --- End Track P14 ---
							);
						}
					} else if (st.layer === '6' && st.mod.k === 'removeKeywords') {
						removeMatchingKeywordsUpTo(target, st.mod.keywords, source.name, source.timestamp);
						if (st.mod.cantHaveOrGain) {
							cantHaveLocks.push({ keywords: st.mod.keywords, sourceName: source.name });
						}
					// --- Track P20a ---
					} else if (st.layer === '4' && (st.mod.k === 'setSubtypes' || st.mod.k === 'setChosenSubtype')) {
						if (
							!source.skippedLayer4SetSubtypes &&
							target.types.includes('Land') &&
							(target.latestSetLandSubtypesTs ?? -Infinity) <= source.timestamp &&
							!isOverwrittenByLaterAttachedSetTypes(source.timestamp) &&
							!isOverwrittenByLaterTimedLandLoss(source.timestamp)
						) {
							const subs =
								st.mod.k === 'setChosenSubtype'
									? source.inst.chosenSubType
										? [source.inst.chosenSubType]
										: []
									: st.mod.subtypes;
							for (const sub of subs) {
								const info = BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()];
								if (info && hasSubtypeInWork(target, info.subtype)) {
									grantItem(
										target,
										`mana_${info.sym.toLowerCase()}`,
										`Mana Ability: Add {${info.sym}}`,
										'ability',
										source.name,
										source.timestamp,
										{
											grantedAbility: makeIntrinsicBasicManaAbility(info.sym as ManaColor),
											sourceInstanceId: source.inst.instanceId
										}
									);
									grantItem(
										target,
										`type_${info.subtype.toLowerCase()}`,
										`Type: Land — ${info.subtype}`,
										'type_mod',
										source.name,
										source.timestamp
									);
								}
							}
						}
					} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenPlayer') {
						noteLayerRead(READ_P20A);
						const chosenPid = source.inst.chosenPlayerId;
						if (chosenPid) {
							grantItem(
								target,
								'protection',
								'Protection from chosen player',
								'keyword',
								source.name,
								source.timestamp,
								{ protectedFromPlayerId: chosenPid }
							);
						}
					// --- End Track P20a ---
					// --- Track P22a ---
					} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenCardType') {
						noteLayerRead(READ_P22A);
						const chosenCt = source.inst.chosenCardType;
						if (chosenCt) {
							const kw = `protection from ${pluralizeCardTypeForProtection(chosenCt)}`;
							grantItem(
								target,
								'protection',
								formatKeywordLabel(kw),
								'keyword',
								source.name,
								source.timestamp
							);
						}
					// --- End Track P22a ---
					}
				}
			}

			// B. Self & Global Layer 4/6 effects from `source`
			// CR 613.6: Layer 4 type/subtype grants already applied before Layer 6 ability removal, so
			// only gate Layer 4 grants on Layer 4 suppression (skippedLayer4SetSubtypes / skippedLayer4Additive).
			for (const st of source.statics) {
				// --- Track P22a: Dynamic Ward {X} (CR 702.21a) ---
				if (st.k === 'dynamicWardMana') {
					if (sourceLostAbilities) continue;
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
					const wardVal = evaluateLayerAmount(st.generic, state, workList, source, target);
					if (wardVal >= 0) {
						grantKeywordString(target, `Ward {${wardVal}}`, source.name, source.timestamp);
					}
					continue;
				}
				// --- End Track P22a ---
				if (st.k !== 'continuous' || st.affected === 'attachedTo') continue;
				if (st.layer !== '4' && st.layer !== '6') continue;
				if (st.layer === '6' && sourceLostAbilities) continue;
				if (st.affected === 'self') {
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

				if (st.layer === '4' && (st.mod.k === 'setSubtypes' || st.mod.k === 'setChosenSubtype')) {
					if (source.skippedLayer4SetSubtypes) continue;
					if (!target.types.includes('Land')) continue;
					if ((target.latestSetLandSubtypesTs ?? -Infinity) > source.timestamp) continue;
					if (isOverwrittenByLaterAttachedSetTypes(source.timestamp)) continue;
					if (isOverwrittenByLaterTimedLandLoss(source.timestamp)) continue;
					const subs =
						st.mod.k === 'setChosenSubtype'
							? source.inst.chosenSubType
								? [source.inst.chosenSubType]
								: []
							: st.mod.subtypes;
					for (const sub of subs) {
						const info = BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()];
						if (info && hasSubtypeInWork(target, info.subtype)) {
							grantItem(
								target,
								`mana_${info.sym.toLowerCase()}`,
								`Mana Ability: Add {${info.sym}}`,
								'ability',
								source.name,
								source.timestamp,
								{
									grantedAbility: makeIntrinsicBasicManaAbility(info.sym as ManaColor),
									sourceInstanceId: source.inst.instanceId
								}
							);
							grantItem(
								target,
								`type_${info.subtype.toLowerCase()}`,
								`Type: Land — ${info.subtype}`,
								'type_mod',
								source.name,
								source.timestamp
							);
						}
					}
				} else if (st.layer === '4' && st.mod.k === 'addTypes' && st.mod.subtypes?.length) {
					if (source.skippedLayer4Additive) continue;
					for (const sub of st.mod.subtypes) {
						// --- Track P17a (CR 613.7): Skip intrinsic mana grant when overwritten by later setSubtypes ---
						if (
							LAND_SUBTYPES.has(sub) &&
							(!target.types.includes('Land') ||
								(target.latestSetLandSubtypesTs ?? -Infinity) > source.timestamp)
						) {
							continue;
						}
						// --- End Track P17a ---
						const info = BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()];
						if (info) {
							grantItem(
								target,
								`mana_${info.sym.toLowerCase()}`,
								`Mana Ability: Add {${info.sym}}`,
								'ability',
								source.name,
								source.timestamp,
								{
									grantedAbility: makeIntrinsicBasicManaAbility(info.sym as ManaColor),
									sourceInstanceId: source.inst.instanceId
								}
							);
							grantItem(
								target,
								info.subtype === 'Forest'
									? 'type_forest_add'
									: `type_${info.subtype.toLowerCase()}`,
								`Subtype: +${info.subtype}`,
								'type_mod',
								source.name,
								source.timestamp
							);
						}
					}
				} else if (st.layer === '4' && st.mod.k === 'allCreatureTypes') {
					if (source.skippedLayer4Additive) continue;
					grantItem(
						target,
						'changeling',
						'Changeling (All Creature Types)',
						'keyword',
						source.name,
						source.timestamp
					);
				} else if (
					st.layer === '6' &&
					st.mod.k === 'grantAbility' &&
					st.mod.ability.kind === 'activated'
				) {
					const desc = describeGrantedActivatedAbility(st.mod.ability, source.inst.instanceId);
					grantItem(target, desc.key, desc.name, 'ability', source.name, source.timestamp, {
						grantedAbility: st.mod.ability,
						grantSourceCard: source.baseCard,
						grantSourceId: source.inst.instanceId,
						grantFaceIndex: lookupStaticLocator(source.baseCard, st)?.faceIndex ?? 0
					});
				// --- Track P11 ---
				} else if (st.layer === '6' && st.mod.k === 'grantAbility') {
					if (grantNonActivatedAbility(target, source, st, st.mod.ability)) {
						anyGrantedStaticInBoard = true;
					}
				// --- End Track P11 ---
				} else if (st.layer === '6' && st.mod.k === 'addKeywords') {
					if (st.affected === 'self' && !st.condition) continue; // already in innate items
					// --- Track P14 ---
					const protMeta: GrantedAbilityMeta | undefined = st.mod.protectionAttachmentExemption
						? {
								grantSourceId: source.inst.instanceId,
								protectionExemption: {
									mode: st.mod.protectionAttachmentExemption,
									sourceId: source.inst.instanceId,
									controllerId: source.controllerId
								}
							}
						: undefined;
					// --- End Track P14 ---
					for (const kw of sortGrantedKeywords(st.mod.keywords)) {
						const kwLow = kw.toLowerCase();
						if (kwLow.startsWith('ward')) {
							grantKeywordString(target, kw, source.name, source.timestamp);
							continue;
						}
						const key = kwLow.startsWith('protection from ') ? 'protection' : kwLow;
						grantItem(
							target,
							key,
							formatKeywordLabel(kwLow),
							'keyword',
							source.name,
							source.timestamp,
							// --- Track P14 ---
							key === 'protection' ? protMeta : undefined
							// --- End Track P14 ---
						);
					}
				} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenColor') {
					const chosenCol = source.inst.chosenColor;
					const kw = chosenCol ? PROTECTION_KEYWORD_BY_COLOR[chosenCol] : undefined;
					if (kw) {
						// --- Track P14 ---
						const chosenProtMeta: GrantedAbilityMeta | undefined = st.mod
							.protectionAttachmentExemption
							? {
									grantSourceId: source.inst.instanceId,
									protectionExemption: {
										mode: st.mod.protectionAttachmentExemption,
										sourceId: source.inst.instanceId,
										controllerId: source.controllerId
									}
								}
							: undefined;
						// --- End Track P14 ---
						grantItem(
							target,
							'protection',
							formatKeywordLabel(kw),
							'keyword',
							source.name,
							source.timestamp,
							// --- Track P14 ---
							chosenProtMeta
							// --- End Track P14 ---
						);
					}
				} else if (st.layer === '6' && st.mod.k === 'removeKeywords') {
					removeMatchingKeywordsUpTo(target, st.mod.keywords, source.name, source.timestamp);
					if (st.mod.cantHaveOrGain) {
						cantHaveLocks.push({ keywords: st.mod.keywords, sourceName: source.name });
					}
				// --- Track P20a ---
				} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenPlayer') {
					noteLayerRead(READ_P20A);
					const chosenPid = source.inst.chosenPlayerId;
					if (chosenPid) {
						grantItem(
							target,
							'protection',
							'Protection from chosen player',
							'keyword',
							source.name,
							source.timestamp,
							{ protectedFromPlayerId: chosenPid }
						);
					}
				// --- End Track P20a ---
				// --- Track P22a ---
				} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenCardType') {
					noteLayerRead(READ_P22A);
					const chosenCt = source.inst.chosenCardType;
					if (chosenCt) {
						const kw = `protection from ${pluralizeCardTypeForProtection(chosenCt)}`;
						grantItem(
							target,
							'protection',
							formatKeywordLabel(kw),
							'keyword',
							source.name,
							source.timestamp
						);
					}
				// --- End Track P22a ---
				} else if (
					st.layer === '6' &&
					(st.mod.k === 'grantAbilitiesFromObjects' || st.mod.k === 'copyKeywordsFromExiled')
				) {
					applyLayer6Wave9Mod(state, source, target, st.mod, workList);
				}
			}
		}

		while (timedIdx < targetTimedEffects.length) {
			applyTimedEffect(targetTimedEffects[timedIdx++]);
		}
		while (timedLandIdx < timedLayer4LandEntries.length) {
			applyTimedLayer4LandEntry(timedLayer4LandEntries[timedLandIdx++]);
		}

		applyRemovalsUpTo(target, Infinity);

		if (target.inst.castViaSuspend && target.types.includes('Creature')) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Suspend');
		}

		// CR 113.11: "can't have or gain [keyword]" prevents any grant regardless of timestamp.
		for (const lock of cantHaveLocks) {
			removeMatchingKeywordsUpTo(target, lock.keywords, lock.sourceName, Infinity);
		}
	}

	// 7a. Layer 7a across ALL permanents: Characteristic-Defining Abilities (CR 604.3 / 613.4a / 707.9d)
	for (const target of workList) {
		if (!target.types.includes('Creature')) continue;
		if (target.allAbilityRemovalSources.length > 0) continue;
		const effectiveCopy7a = !target.isFaceDown
			? (activeTimedLayer1aForPermanent(state, target.inst) ?? target.inst.copiableState)
			: undefined;
		const exceptPower = effectiveCopy7a?.except?.power;
		const exceptToughness = effectiveCopy7a?.except?.toughness;
		for (const st of target.statics) {
			if (st.k !== 'continuous' || st.layer !== '7a' || st.affected !== 'self') continue;
			if (
				st.condition &&
				!evaluateLayerCondition(st.condition, state, workList, target, target, workMap)
			) {
				continue;
			}
			if (st.mod.k === 'setBasePT') {
				if (exceptPower !== undefined && exceptToughness !== undefined) continue;
				const p = evaluateLayerAmount(st.mod.power, state, workList, target, target);
				const t = evaluateLayerAmount(st.mod.toughness, state, workList, target, target);
				if (exceptPower === undefined) target.workingPower = p;
				if (exceptToughness === undefined) target.workingToughness = t;
				target.ptModifiedBy.push(
					`${target.baseCard.name} CDA (${target.workingPower}/${target.workingToughness})`
				);
			} else if (st.mod.k === 'setBasePower') {
				if (exceptPower !== undefined) continue;
				const p = evaluateLayerAmount(st.mod.power, state, workList, target, target);
				target.workingPower = p;
				target.ptModifiedBy.push(
					`${target.baseCard.name} CDA (${p}/${target.workingToughness ?? 0})`
				);
			} else if (st.mod.k === 'setBaseToughness') {
				if (exceptToughness !== undefined) continue;
				const t = evaluateLayerAmount(st.mod.toughness, state, workList, target, target);
				target.workingToughness = t;
				target.ptModifiedBy.push(
					`${target.baseCard.name} CDA (${target.workingPower ?? 0}/${t})`
				);
			}
		}
	}

	// 7b. Layer 7b across ALL permanents: P/T-setting effects in timestamp order (CR 613.4b & 613.7)
	for (const source of staticSources) {
		const startedEarlier = source.statics.some(
			(s2) =>
				s2.k === 'continuous' &&
				(s2.layer === '4' || s2.layer === '5' || s2.layer === '6')
		);
		if (source.allAbilityRemovalSources.length > 0 && !startedEarlier) continue;
		for (const st of source.statics) {
			if (
				st.k !== 'continuous' ||
				st.layer !== '7b' ||
				(st.mod.k !== 'setBasePT' &&
					st.mod.k !== 'setBasePower' &&
					st.mod.k !== 'setBaseToughness' &&
					st.mod.k !== 'copyStatsAndSubtypesFromLastExiled')
			) {
				continue;
			}
			if (st.affected === 'self') {
				if (!source.types.includes('Creature') || source.allAbilityRemovalSources.length > 0) {
					continue;
				}
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, source, source, workMap)
				) {
					continue;
				}
				if (st.mod.k === 'copyStatsAndSubtypesFromLastExiled') {
					const pt = applyLayer7bCopyLastExiledWave9(state, source, source);
					if (pt) {
						source.layer7bSetters.push({
							sourceName: source.name,
							power: pt.power,
							toughness: pt.toughness,
							timestamp: source.timestamp
						});
					}
					continue;
				}
				const p =
					st.mod.k === 'setBasePT' || st.mod.k === 'setBasePower'
						? evaluateLayerAmount(st.mod.power, state, workList, source, source)
						: undefined;
				const t =
					st.mod.k === 'setBasePT' || st.mod.k === 'setBaseToughness'
						? evaluateLayerAmount(st.mod.toughness, state, workList, source, source)
						: undefined;
				source.layer7bSetters.push({
					sourceName: source.name,
					...(p !== undefined ? { power: p } : {}),
					...(t !== undefined ? { toughness: t } : {}),
					timestamp: source.timestamp
				});
			} else if (typeof st.affected === 'object') {
				for (const target of workList) {
					if (!target.types.includes('Creature')) continue;
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const p =
						st.mod.k === 'setBasePT' || st.mod.k === 'setBasePower'
							? evaluateLayerAmount(st.mod.power, state, workList, source, target)
							: undefined;
					const t =
						st.mod.k === 'setBasePT' || st.mod.k === 'setBaseToughness'
							? evaluateLayerAmount(st.mod.toughness, state, workList, source, target)
							: undefined;
					target.layer7bSetters.push({
						sourceName: source.name,
						...(p !== undefined ? { power: p } : {}),
						...(t !== undefined ? { toughness: t } : {}),
						timestamp: source.timestamp
					});
				}
			}
		}
	}

	for (const target of workList) {
		const isCreature = target.types.includes('Creature');
		const targetVersion = target.inst.objectVersion ?? 1;
		if (isCreature && state.timedContinuousEffects?.length) {
			for (const eff of state.timedContinuousEffects) {
				if (!eff.layer7b || !isTimedContinuousEffectActive(eff, workMap)) continue;
				if (
					eff.affected.some(
						(a) => a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					target.layer7bSetters.push({
						sourceName: eff.sourceName,
						power: eff.layer7b.setPower,
						toughness: eff.layer7b.setToughness,
						timestamp: eff.timestamp
					});
				}
			}
		}
		// --- Track P11: Layer 6 granted Layer 7b base-P/T statics (CR 613.4b, 107.3j) ---
		if (anyGrantedStaticInBoard) {
			for (const item of target.items) {
				if (item.removed || !item.grantedStaticAbility) continue;
				const gst = item.grantedStaticAbility;
				if (gst.k !== 'continuous' || gst.layer !== '7b' || gst.mod.k !== 'setBasePT') continue;
				const itemTs = target.itemTimestamps.get(item.id) ?? target.timestamp;
				const srcName = item.sources[0] ?? target.name;
				if (gst.affected === 'self') {
					if (!isCreature) continue;
					if (
						gst.condition &&
						!evaluateLayerCondition(gst.condition, state, workList, target, target, workMap)
					) {
						continue;
					}
					const p = evaluateLayerAmount(gst.mod.power, state, workList, target, target);
					const t = evaluateLayerAmount(gst.mod.toughness, state, workList, target, target);
					target.layer7bSetters.push({
						sourceName: srcName,
						power: p,
						toughness: t,
						timestamp: itemTs
					});
				}
			}
		}
		// --- End Track P11 ---
		if (isCreature) {
			target.layer7bSetters.sort((a, b) => a.timestamp - b.timestamp);
			for (const setter of target.layer7bSetters) {
				if (setter.power !== undefined) target.workingPower = setter.power;
				if (setter.toughness !== undefined) target.workingToughness = setter.toughness;
				if (
					(setter.power !== undefined && setter.power !== null) ||
					(setter.toughness !== undefined && setter.toughness !== null)
				) {
					const label = `${setter.sourceName} (base ${target.workingPower ?? '*'}/${target.workingToughness ?? '*'})`;
					if (!target.ptModifiedBy.includes(label)) {
						target.ptModifiedBy.push(label);
					}
				}
			}
		}
	}

	// 7c. Layer 7c across ALL permanents: counters, temp P/T, and continuous P/T modifications (CR 613.4c)
	// --- Track P17a ---
	if (workList.length > 0) noteLayerRead(READ_P17A);
	// --- End Track P17a ---
	for (const target of workList) {
		if (target.workingPower === null || target.workingToughness === null) continue;
		const plusOnes = target.inst.counters['+1/+1'] || 0;
		const minusOnes = target.inst.counters['-1/-1'] || 0;
		target.workingPower += plusOnes - minusOnes + target.inst.tempPowerMod;
		target.workingToughness += plusOnes - minusOnes + target.inst.tempToughnessMod;
		// --- Track P17a & P16a (CR 122.1a, 613.4c): Non-standard ±M/±N P/T counters ---
		const nonStdPt = sumNonStandardPtCountersInLayer(target.inst.counters);
		if (nonStdPt.entries.length > 0) {
			target.workingPower += nonStdPt.power;
			target.workingToughness += nonStdPt.toughness;
		}
		// --- End Track P17a & P16a ---
		// --- Track P13 (CR 613.4c): Cross-turn / permanent Layer 7c P/T modifications ---
		if (state.timedContinuousEffects?.length) {
			const targetVersion = target.inst.objectVersion ?? 1;
			for (const eff of state.timedContinuousEffects) {
				if (!eff.layer7c || !isTimedContinuousEffectActive(eff, workMap)) continue;
				if (
					eff.affected.some(
						(a) =>
							a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					target.workingPower += eff.layer7c.power;
					target.workingToughness += eff.layer7c.toughness;
					const deltaStr = formatSignedDelta(eff.layer7c.power, eff.layer7c.toughness);
					grantStatModItem(
						target,
						`pt_timed_${eff.timestamp}`,
						deltaStr,
						eff.sourceName,
						eff.timestamp
					);
					target.ptModifiedBy.push(`${deltaStr} (${eff.sourceName})`);
				}
			}
		}
		// --- End Track P13 ---
	}

	// --- Track P13 + Track P14 ---
	const layer7cSources = anyGrantedStaticInBoard
		? emblemWorkList.length > 0 || graveyardStaticSources.length > 0
			? [...workList, ...emblemWorkList, ...graveyardStaticSources].sort(
					(a, b) => a.timestamp - b.timestamp
				)
			: workList
		: staticSources;
	// --- End Track P13 + Track P14 ---
	for (const source of layer7cSources) {
		if (source.strippedByAttachment) continue;

		// A. Attached Layer 7c `pt` on host
		if (source.inst.attachedToId) {
			const target = workMap.get(source.inst.attachedToId);
			if (target && target.workingPower !== null && target.workingToughness !== null) {
				for (const st of source.statics) {
					if (st.k !== 'continuous' || st.affected !== 'attachedTo' || st.mod.k !== 'pt') continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const dp = evaluateLayerAmount(st.mod.power, state, workList, source, target);
					const dt = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
					target.workingPower += dp;
					target.workingToughness += dt;
					const deltaStr = formatSignedDelta(dp, dt);
					grantStatModItem(target, `pt_${source.name}`, deltaStr, source.name, source.timestamp);
					target.ptModifiedBy.push(`${deltaStr} (${source.name})`);
				}
			}
		}

		// B. Self & Global Layer 7c `pt` from `source`
		if (source.allAbilityRemovalSources.length === 0) {
			for (const st of source.statics) {
				if (
					st.k !== 'continuous' ||
					st.layer !== '7c' ||
					st.mod.k !== 'pt' ||
					st.affected === 'attachedTo'
				) {
					continue;
				}
				const candidates = st.affected === 'self' ? [source] : workList;
				for (const target of candidates) {
					if (target.workingPower === null || target.workingToughness === null) continue;
					if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const dp = evaluateLayerAmount(st.mod.power, state, workList, source, target);
					const dt = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
					target.workingPower += dp;
					target.workingToughness += dt;
					const deltaStr = formatSignedDelta(dp, dt);
					grantStatModItem(
						target,
						`pt_${source.inst.instanceId}`,
						deltaStr,
						source.name,
						source.timestamp
					);
					target.ptModifiedBy.push(`${deltaStr} (${source.name})`);
				}
			}
		}
		// --- Track P11: Layer 6 granted Layer 7c P/T statics (CR 613.4c, 107.3j) ---
		if (anyGrantedStaticInBoard) {
			for (const item of source.items) {
				if (item.removed || !item.grantedStaticAbility) continue;
				const gst = item.grantedStaticAbility;
				if (
					gst.k !== 'continuous' ||
					gst.layer !== '7c' ||
					gst.mod.k !== 'pt' ||
					gst.affected === 'attachedTo'
				) {
					continue;
				}
				const itemTs = source.itemTimestamps.get(item.id) ?? source.timestamp;
				const srcName = item.sources[0] ?? source.name;
				const candidates = gst.affected === 'self' ? [source] : workList;
				for (const target of candidates) {
					if (target.workingPower === null || target.workingToughness === null) continue;
					if (
						typeof gst.affected === 'object' &&
						!matchesLayerFilter(gst.affected, target, source, state, workList)
					) {
						continue;
					}
					if (
						gst.condition &&
						!evaluateLayerCondition(gst.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const dp = evaluateLayerAmount(gst.mod.power, state, workList, source, target);
					const dt = evaluateLayerAmount(gst.mod.toughness, state, workList, source, target);
					target.workingPower += dp;
					target.workingToughness += dt;
					const deltaStr = formatSignedDelta(dp, dt);
					grantStatModItem(target, `pt_grant_${item.id}`, deltaStr, srcName, itemTs);
					target.ptModifiedBy.push(`${deltaStr} (${srcName})`);
				}
			}
		}
		// --- End Track P11 ---
	}

	// Record counter & temporary P/T breakdown items and apply Layer 7d P/T switch (CR 613.4d)
	for (const target of workList) {
		if (target.workingPower === null || target.workingToughness === null) continue;
		const plusOnes = target.inst.counters['+1/+1'] || 0;
		const minusOnes = target.inst.counters['-1/-1'] || 0;
		if (plusOnes > 0) {
			grantItem(target, 'counters_plus', `+${plusOnes}/+${plusOnes}`, 'stat_mod', '+1/+1 Counters');
			target.ptModifiedBy.push(`+${plusOnes}/+${plusOnes} (+1/+1 Counters)`);
		}
		if (minusOnes > 0) {
			grantItem(
				target,
				'counters_minus',
				`-${minusOnes}/-${minusOnes}`,
				'stat_mod',
				'-1/-1 Counters'
			);
			target.ptModifiedBy.push(`-${minusOnes}/-${minusOnes} (-1/-1 Counters)`);
		}
		// --- Track P17a & P16a (CR 122.1a): Arbitrary ±M/±N counter breakdown items ---
		const arbBreakdown = collectP16aArbitraryPtCounters(
			target.inst.counters as Record<string, number>
		);
		if (arbBreakdown) {
			for (const it of arbBreakdown) {
				const deltaStr = formatSignedDelta(it.dp, it.dt);
				grantItem(
					target,
					`counters_${it.key}`,
					deltaStr,
					'stat_mod',
					`${it.key} Counters`
				);
				target.ptModifiedBy.push(`${deltaStr} (${it.key} Counters)`);
			}
		}
		// --- End Track P17a & P16a ---
		if (target.inst.tempPowerMod !== 0 || target.inst.tempToughnessMod !== 0) {
			const deltaStr = formatSignedDelta(target.inst.tempPowerMod, target.inst.tempToughnessMod);
			grantItem(target, 'temp_pt', deltaStr, 'stat_mod', 'Temporary Effect');
			target.ptModifiedBy.push(`${deltaStr} (Temporary Effect)`);
		}

		// Layer 7d: Effects that switch a creature's power and toughness (CR 613.4d)
		if ((target.inst.switchedPTCount || 0) % 2 === 1) {
			const prevP = target.workingPower;
			const prevT = target.workingToughness;
			target.workingPower = prevT;
			target.workingToughness = prevP;
			grantItem(
				target,
				'switched_pt',
				`Switched P/T (${target.workingPower}/${target.workingToughness})`,
				'stat_mod',
				'P/T Switch'
			);
			target.ptModifiedBy.push(`Switched P/T (${target.workingPower}/${target.workingToughness})`);
		}
	}
}

function buildBoardResults(workList: PermWorkState[]): BoardLayerCache['byInstance'] {
	// Build final results map
	const byInstance = new Map<
		CardInstance,
		{
			breakdown: CardContinuousBreakdown;
			lost: {
				lost: boolean;
				sources: string[];
				// --- Track P17a ---
				keepManaAbilities?: boolean;
				// --- End Track P17a ---
				removalEvents?: ReadonlyArray<{
					timestamp: number;
					keepManaAbilities?: boolean;
					fromLayer6?: boolean;
				}>;
			};
			evaluated: EvaluatedPermanent;
		}
	>();

	for (const work of workList) {
		const breakdown: CardContinuousBreakdown = {
			baseTypeLine: work.baseTypeLine,
			effectiveTypeLine: work.effectiveTypeLine,
			typeModified:
				work.effectiveTypeLine !== work.baseTypeLine || work.typeModifiedBy.length > 0,
			typeModifiedBy: work.typeModifiedBy,
			basePower: work.basePower,
			baseToughness: work.baseToughness,
			// CR 107.1b: power can be negative (not clamped to 0).
			effectivePower: work.workingPower,
			effectiveToughness:
				work.workingToughness !== null ? Math.max(0, work.workingToughness) : null,
			ptModifiedBy: work.ptModifiedBy,
			items: work.items
		};

		// --- Track P17a ---
		const keepManaAbilities =
			!work.strippedByAttachment &&
			work.abilityRemovalEvents.length > 0 &&
			work.abilityRemovalEvents.every((e) => Boolean(e.keepManaAbilities));
		// --- End Track P17a ---
		const removalEvents =
			work.abilityRemovalEvents.length > 0
				? work.abilityRemovalEvents.map((e) => ({
						timestamp: e.timestamp,
						...(e.keepManaAbilities ? { keepManaAbilities: true } : {}),
						...(e.fromLayer6 ? { fromLayer6: true } : {})
					}))
				: undefined;
		const lost = {
			lost: work.allAbilityRemovalSources.length > 0,
			sources: work.allAbilityRemovalSources,
			// --- Track P17a ---
			...(keepManaAbilities ? { keepManaAbilities: true } : {}),
			// --- End Track P17a ---
			...(removalEvents ? { removalEvents } : {})
		};

		const tLine = breakdown.effectiveTypeLine;
		// --- Track P14 ---
		const activeKeywords: string[] = [];
		let seenProtLabels: Set<string> | undefined;
		// --- Track P20a ---
		let protectionFromPlayerIds: string[] | undefined;
		// --- End Track P20a ---
		for (let ki = 0; ki < breakdown.items.length; ki++) {
			const it = breakdown.items[ki];
			if (it.kind !== 'keyword' || it.removed) continue;
			// --- Track P20a ---
			if (it.protectedFromPlayerId) {
				if (!protectionFromPlayerIds?.includes(it.protectedFromPlayerId)) {
					(protectionFromPlayerIds ??= []).push(it.protectedFromPlayerId);
				}
			}
			// --- End Track P20a ---
			if (it.canonicalKey === 'protection') {
				const pLow = it.name.toLowerCase();
				if (seenProtLabels?.has(pLow)) continue;
				(seenProtLabels ??= new Set()).add(pLow);
			}
			activeKeywords.push(it.name);
		}
		// --- End Track P14 ---
		// CR 613.1d, 613.5, 702.73a: Changeling applies in Layer 4 before Layer 6 ability removal.
		const hasAllCreatureTypes = work.hasAllCreatureTypes || tLine.includes('All-Types');

		const evaluated: EvaluatedPermanent = {
			instanceId: work.inst.instanceId,
			controllerId: work.controllerId,
			effectiveName: work.name,
			effectiveTypeLine: tLine,
			typeLine: tLine,
			isCreature: tLine.includes('Creature'),
			isArtifact: tLine.includes('Artifact'),
			isEnchantment: tLine.includes('Enchantment'),
			isLand: tLine.includes('Land'),
			isPlaneswalker: tLine.includes('Planeswalker'),
			isLegendary: tLine.includes('Legendary'),
			hasAllCreatureTypes,
			losesAllAbilities: lost.lost,
			hasLostAllAbilities: lost.lost,
			lostAllAbilitiesBy: [...lost.sources],
			power: breakdown.effectivePower ?? 0,
			toughness: breakdown.effectiveToughness ?? 0,
			unclampedToughness: work.workingToughness,
			colors: [...work.colors],
			activeKeywords,
			keywords: activeKeywords,
			breakdown,
			// --- Track P20a ---
			...(protectionFromPlayerIds ? { protectionFromPlayerIds } : {}),
			// --- End Track P20a ---
			hasSubType: (subType: string) => {
				if (
					(tLine.includes('Creature') || tLine.includes('Kindred') || tLine.includes('Tribal')) &&
					hasAllCreatureTypes &&
					!NON_CREATURE_SUBTYPES.has(subType)
				) {
					return true;
				}
				const subs = lowerSubtypesOf(tLine);
				if (subs) return subs.has(subType.toLowerCase());
				return new RegExp(`\\b${subType}\\b`, 'i').test(tLine);
			}
		};

		byInstance.set(work.inst, { breakdown, lost, evaluated });
	}

	return byInstance;
}

function getBoardLayerCache(state: GameState): { snap: BoardSnapshot; cache: BoardLayerCache } {
	// Inside `withStableLayerInputs`, reuse what the first query in the scope validated (Phase 6c).
	const trust = scopeTrust(state);
	const trusted = trust?.layer as { snap: BoardSnapshot; cache: BoardLayerCache } | undefined;
	if (trusted) {
		if (layerCacheCheckEnabled()) {
			verifyScopeTrust(
				'getBoardLayerCache',
				boardSnapshotMatches(state, trusted.snap) &&
					dynamicFingerprintMatches(state, trusted.snap, trusted.cache.dynamicFingerprint)
			);
		}
		return trusted;
	}
	const result = getBoardLayerCacheUntrusted(state);
	if (trust) trust.layer = result;
	return result;
}

function getBoardLayerCacheUntrusted(state: GameState): {
	snap: BoardSnapshot;
	cache: BoardLayerCache;
} {
	const snap = getBoardSnapshot(state);
	const existing = snap.memo.get(BOARD_CACHE_KEY) as BoardLayerCache | undefined;
	if (existing) {
		if (dynamicFingerprintMatches(state, snap, existing.dynamicFingerprint)) {
			return { snap, cache: existing };
		}
	}
	const cache = computeBoardLayerCache(state, snap);
	snap.memo.set(BOARD_CACHE_KEY, cache);
	return { snap, cache };
}

function cloneBreakdown(b: CardContinuousBreakdown): CardContinuousBreakdown {
	return {
		baseTypeLine: b.baseTypeLine,
		effectiveTypeLine: b.effectiveTypeLine,
		typeModified: b.typeModified,
		typeModifiedBy: [...b.typeModifiedBy],
		basePower: b.basePower,
		baseToughness: b.baseToughness,
		effectivePower: b.effectivePower,
		effectiveToughness: b.effectiveToughness,
		ptModifiedBy: [...b.ptModifiedBy],
		items: b.items.map((it) => ({
			...it,
			// --- Track P14 ---
			...(it.protectionExemption ? { protectionExemption: { ...it.protectionExemption } } : {}),
			// --- End Track P14 ---
			sources: [...it.sources],
			removedBy: [...it.removedBy]
		}))
	};
}

function buildOffBattlefieldBreakdown(
	card: ScryfallCard,
	inst: CardInstance | null,
	state?: GameState
): CardContinuousBreakdown {
	const faceOpts = inst ? instanceFaceOptions(inst) : undefined;
	const view = resolveObjectFaces(card, faceOpts);
	const isFaceDown = view.isFaceDown;
	const baseTypeLine = view.typeLine;
	const basePower = view.power ?? null;
	const baseToughness = view.toughness ?? null;
	let effectivePower = basePower;
	let effectiveToughness = baseToughness;
	const ptModifiedBy: string[] = [];
	// CR 604.3, 208.2a: Layer 7a characteristic-defining abilities function in all zones.
	if (!isFaceDown && view.types.includes('Creature')) {
		if (effectivePower === null && view.ptDefinedByAbility) effectivePower = 0;
		if (effectiveToughness === null && view.ptDefinedByAbility) effectiveToughness = 0;
		// --- Track P8: CR 707.9d copy P/T exception & setBasePower / setBaseToughness ---
		const exceptPower = inst?.copiableState?.except?.power;
		const exceptToughness = inst?.copiableState?.except?.toughness;
		for (const ab of activeAbilityDefs(card, faceOpts)) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				ab.static.layer === '7a' &&
				ab.static.affected === 'self' &&
				(ab.static.mod.k === 'setBasePT' ||
					ab.static.mod.k === 'setBasePower' ||
					ab.static.mod.k === 'setBaseToughness')
			) {
				if (state) {
					const controllerId =
						inst?.ownerId ||
						inst?.controllerId ||
						state.players.find(
							(pl) =>
								(inst &&
									(pl.command.includes(inst) ||
										pl.hand.includes(inst) ||
										pl.graveyard.includes(inst) ||
										pl.exile.includes(inst) ||
										pl.library.includes(inst))) ||
								false
						)?.playerId ||
						state.players[0]?.playerId ||
						'';
					if (ab.static.mod.k === 'setBasePT') {
						if (exceptPower !== undefined && exceptToughness !== undefined) continue;
						const p = evaluateAmount(ab.static.mod.power, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						const t = evaluateAmount(ab.static.mod.toughness, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						if (exceptPower === undefined) effectivePower = p;
						if (exceptToughness === undefined) effectiveToughness = Math.max(0, t);
						ptModifiedBy.push(`${view.name} CDA (${effectivePower}/${effectiveToughness})`);
					} else if (ab.static.mod.k === 'setBasePower') {
						if (exceptPower !== undefined) continue;
						const p = evaluateAmount(ab.static.mod.power, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						effectivePower = p;
						ptModifiedBy.push(`${view.name} CDA (${effectivePower}/${effectiveToughness ?? 0})`);
					} else if (ab.static.mod.k === 'setBaseToughness') {
						if (exceptToughness !== undefined) continue;
						const t = evaluateAmount(ab.static.mod.toughness, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						effectiveToughness = Math.max(0, t);
						ptModifiedBy.push(`${view.name} CDA (${effectivePower ?? 0}/${effectiveToughness})`);
					}
				} else {
					if (ab.static.mod.k === 'setBasePT') {
						if (exceptPower !== undefined && exceptToughness !== undefined) continue;
						if (exceptPower === undefined) effectivePower = 0;
						if (exceptToughness === undefined) effectiveToughness = 0;
						ptModifiedBy.push(`${view.name} CDA (${effectivePower}/${effectiveToughness})`);
					} else if (ab.static.mod.k === 'setBasePower') {
						if (exceptPower !== undefined) continue;
						effectivePower = 0;
						ptModifiedBy.push(`${view.name} CDA (0/${effectiveToughness ?? 0})`);
					} else if (ab.static.mod.k === 'setBaseToughness') {
						if (exceptToughness !== undefined) continue;
						effectiveToughness = 0;
						ptModifiedBy.push(`${view.name} CDA (${effectivePower ?? 0}/0)`);
					}
				}
			}
		}
	}
	const innateList = innateKeywordsAndAbilitiesOf(card, faceOpts);
	const items: AttributedKeywordOrEffect[] = innateList.map((entry, idx) => ({
		id: `innate_${idx}_${entry.canonicalKey}`,
		canonicalKey: entry.canonicalKey,
		name: entry.name,
		kind: entry.kind,
		isInnate: true,
		sources: ['innate'],
		removed: false,
		removedBy: []
	}));
	return {
		baseTypeLine,
		effectiveTypeLine: baseTypeLine,
		typeModified: false,
		typeModifiedBy: [],
		basePower,
		baseToughness,
		effectivePower,
		effectiveToughness,
		ptModifiedBy,
		items
	};
}

// ---- Public Entry Points --------------------------------------------------------------------

/**
 * A battlefield permanent whose abilities function: not phased out, on a player who hasn't lost,
 * and not affected by a "loses all abilities" effect (CR 613.1f, 702.26b).
 */
export interface AbilityActivePermanent {
	perm: CardInstance;
	/** Copiable values (`copiableCard ?? card`). */
	card: ScryfallCard;
	/** The player whose battlefield holds the permanent. */
	controllerId: string;
	player: PlayerGameState;
	/** `compileCard(card)`. */
	compiled: CardDefinition;
}

function projectAbilityActive(list: readonly AbilityActivePermanent[]): unknown[] {
	return list.map((a) => [a.perm.instanceId, a.controllerId, a.player.playerId, a.card.id, a.card.name]);
}

/**
 * Every permanent whose abilities function, in board order (players in seat order, then
 * battlefield order). Equivalent to filtering each battlefield with
 * `!perm.phasedOut && !permanentHasLostAllAbilities(perm, state).lost`, but validates the layer
 * cache once instead of once per permanent (Phase 6c). The returned array is shared: don't mutate it.
 */
export function abilityActivePermanents(state: GameState): readonly AbilityActivePermanent[] {
	const { snap, cache } = getBoardLayerCache(state);
	let list = cache.abilityActive;
	if (!list) {
		const built: AbilityActivePermanent[] = [];
		for (const entry of snap.active) {
			if (cache.byInstance.get(entry.perm)?.lost.lost) continue;
			built.push({
				perm: entry.perm,
				card: entry.card,
				controllerId: entry.playerId,
				player: entry.player,
				compiled: compileCard(entry.card)
			});
		}
		list = built;
		cache.abilityActive = list;
	}
	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult('abilityActivePermanents', projectAbilityActive(list), () => {
			// Independent of the cached snapshot: the original per-player scan over one fresh board
			// evaluation.
			const fresh = computeBoardLayerCache(state, buildBoardSnapshot(state));
			const out: AbilityActivePermanent[] = [];
			for (const player of state.players) {
				if (player.lost) continue;
				for (const perm of player.battlefield) {
					if (perm.phasedOut) continue;
					if (fresh.byInstance.get(perm)?.lost.lost) continue;
					// --- Track P7 ---
					const card = activeTimedLayer1aForPermanent(state, perm)?.card ?? effectiveCardForObject(perm);
					// --- End Track P7 ---
					out.push({
						perm,
						card,
						controllerId: player.playerId,
						player,
						compiled: compileCard(card)
					});
				}
			}
			return projectAbilityActive(out);
		});
	}
	return list;
}

export function permanentHasLostAllAbilities(
	perm: CardInstance,
	state: GameState
): { lost: boolean; sources: string[] } {
	const { cache } = getBoardLayerCache(state);
	const entry = cache.byInstance.get(perm);
	const out = entry
		? { lost: entry.lost.lost, sources: [...entry.lost.sources] }
		: { lost: false, sources: [] };
	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'permanentHasLostAllAbilities',
			out,
			() => permanentHasLostAllAbilities(perm, state),
			(ref) => ref.permanentHasLostAllAbilities(perm, state)
		);
	}
	return out;
}

// --- Track P17a ---
export function permanentRetainsInnateManaAbilities(
	perm: CardInstance,
	state: GameState
): boolean {
	const { cache } = getBoardLayerCache(state);
	const entry = cache.byInstance.get(perm);
	return Boolean(entry?.lost.lost && entry?.lost.keepManaAbilities);
}
// --- End Track P17a ---

export function timedLayer6AbilitySurvivesRemoval(
	perm: CardInstance,
	state: GameState,
	grantTimestamp: number,
	isManaAbility: boolean
): boolean {
	const { cache } = getBoardLayerCache(state);
	const entry = cache.byInstance.get(perm);
	let out = true;
	if (entry?.lost.lost && entry.lost.removalEvents?.length) {
		for (const ev of entry.lost.removalEvents) {
			if (!ev.fromLayer6) continue;
			if (grantTimestamp < ev.timestamp && !(isManaAbility && ev.keepManaAbilities)) {
				out = false;
				break;
			}
		}
	}
	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult('timedLayer6AbilitySurvivesRemoval', out, () =>
			timedLayer6AbilitySurvivesRemoval(perm, state, grantTimestamp, isManaAbility)
		);
	}
	return out;
}

export function isTimedContinuousEffectActiveForState(
	state: GameState,
	eff: TimedContinuousEffect
): boolean {
	const findActivePerm = (instanceId: string): CardInstance | undefined => {
		for (const p of state.players) {
			if (p.lost) continue;
			for (const b of p.battlefield) {
				if (!b.phasedOut && b.instanceId === instanceId) return b;
			}
		}
		return undefined;
	};
	if (
		eff.expires === 'forAsLongAsYouControlSelf' ||
		eff.expires === 'forAsLongAsSelfRemainsTapped'
	) {
		const cond = eff.sourceCondition;
		if (!cond || cond.broken) return false;
		const src = findActivePerm(cond.sourceInstanceId);
		if (!src || (src.objectVersion ?? 1) !== cond.sourceObjectVersion) return false;
		if (cond.kind === 'controlledByPlayer') {
			return evaluatePermanent(state, src).controllerId === cond.controllerId;
		}
		return Boolean(src.tapped);
	}
	const usl = eff.layer2?.untilSourceLeaves;
	if (!usl) return true;
	const src = findActivePerm(usl.sourceInstanceId);
	return Boolean(src && (src.objectVersion ?? 1) === usl.sourceObjectVersion);
}

export function hasAllOffBattlefieldAndSpellsColorless(state: GameState): boolean {
	for (const { perm, card } of abilityActivePermanents(state)) {
		for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'ruleModifier' &&
				ab.static.rule === 'allOffBattlefieldAndSpellsColorless'
			) {
				return true;
			}
		}
	}
	return false;
}

export function inspectCardContinuousBreakdown(
	cardOrInst: CardInstance | ScryfallCard,
	state?: GameState
): CardContinuousBreakdown {
	let inst: CardInstance | null = null;
	let card: ScryfallCard;

	if ('instanceId' in cardOrInst) {
		inst = cardOrInst;
		card = effectiveCardForObject(cardOrInst);
	} else {
		card = cardOrInst;
		if (state) {
			for (const p of state.players) {
				const foundBf = p.battlefield.find(
					(c) => c.card.id === card.id || c.card.name === card.name
				);
				if (foundBf) {
					inst = foundBf;
					card = effectiveCardForObject(foundBf);
					break;
				}
			}
			if (!inst) {
				for (const p of state.players) {
					const foundOther =
						p.command.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.hand.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.graveyard.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.exile.find((c) => c.card.id === card.id || c.card.name === card.name);
					if (foundOther) {
						inst = foundOther;
						break;
					}
				}
			}
		}
	}

	let out: CardContinuousBreakdown;
	if (inst && state) {
		const { cache } = getBoardLayerCache(state);
		const hit = cache.byInstance.get(inst);
		out = hit ? cloneBreakdown(hit.breakdown) : buildOffBattlefieldBreakdown(card, inst, state);
	} else {
		out = buildOffBattlefieldBreakdown(card, inst, state);
	}

	if (state && layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'inspectCardContinuousBreakdown',
			out,
			() => inspectCardContinuousBreakdown(cardOrInst, state),
			(ref) => ref.inspectCardContinuousBreakdown(cardOrInst, state)
		);
	}
	return out;
}

export function evaluatePermanent(state: GameState, inst: CardInstance): EvaluatedPermanent {
	const { cache } = getBoardLayerCache(state);
	const hit = cache.byInstance.get(inst);
	let result: EvaluatedPermanent;
	if (hit) {
		result = hit.evaluated;
	} else {
		const baseCard = effectiveCardForObject(inst);
		const breakdown = buildOffBattlefieldBreakdown(baseCard, inst, state);
		const tLine = breakdown.effectiveTypeLine;
		// --- Track P14 ---
		const activeKeywords: string[] = [];
		let seenProtLabels: Set<string> | undefined;
		for (let ki = 0; ki < breakdown.items.length; ki++) {
			const it = breakdown.items[ki];
			if (it.kind !== 'keyword' || it.removed) continue;
			if (it.canonicalKey === 'protection') {
				const pLow = it.name.toLowerCase();
				if (seenProtLabels?.has(pLow)) continue;
				(seenProtLabels ??= new Set()).add(pLow);
			}
			activeKeywords.push(it.name);
		}
		// --- End Track P14 ---
		const hasAllCreatureTypes =
			tLine.includes('All-Types') ||
			breakdown.items.some((it) => it.canonicalKey === 'changeling' && !it.removed);
		const faceView = resolveObjectFaces(baseCard, instanceFaceOptions(inst));
		result = {
			instanceId: inst.instanceId,
			controllerId: inst.controllerId,
			effectiveName: inst.isFaceDown
				? (inst.faceDownLabel ?? 'Face-Down Creature')
				: faceView.name,
			effectiveTypeLine: tLine,
			typeLine: tLine,
			isCreature: tLine.includes('Creature'),
			isArtifact: tLine.includes('Artifact'),
			isEnchantment: tLine.includes('Enchantment'),
			isLand: tLine.includes('Land'),
			isPlaneswalker: tLine.includes('Planeswalker'),
			isLegendary: tLine.includes('Legendary'),
			hasAllCreatureTypes,
			losesAllAbilities: false,
			hasLostAllAbilities: false,
			lostAllAbilitiesBy: [],
			power: breakdown.effectivePower ?? 0,
			toughness: breakdown.effectiveToughness ?? 0,
			unclampedToughness: breakdown.effectiveToughness,
			colors: state && hasAllOffBattlefieldAndSpellsColorless(state) ? [] : [...faceView.colors],
			activeKeywords,
			keywords: activeKeywords,
			breakdown,
			hasSubType: (subType: string) => {
				if (
					(tLine.includes('Creature') || tLine.includes('Kindred') || tLine.includes('Tribal')) &&
					hasAllCreatureTypes &&
					!NON_CREATURE_SUBTYPES.has(subType)
				) {
					return true;
				}
				const subs = lowerSubtypesOf(tLine);
				if (subs) return subs.has(subType.toLowerCase());
				return new RegExp(`\\b${subType}\\b`, 'i').test(tLine);
			}
		};
	}

	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'evaluatePermanent',
			result,
			() => evaluatePermanent(state, inst),
			(ref) => ref.evaluatePermanent(state, inst)
		);
	}
	return result;
}
