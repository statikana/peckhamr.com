import {
	canPayOrAutoTap,
	checkAbilityActivationLegality,
	getCastOptions,
	getSpellOptionCostRequirement,
	payManaWithAutoTap,
	planCastCostAids,
	spellSpendContext
} from '../engine.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveAbilityManaCost } from '../runtime/costs.ts';
import { collectAbilityManaSpendRestrictionsP20b } from '../runtime/costsWave7.ts';
import { splitSubtypes } from '../runtime/layers.ts';
import { combinedManaPoolForSpend } from '../runtime/mana.ts';
import { evaluateAmount } from '../runtime/objectFilter.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CastOption,
	EffectiveActivatedAbility,
	GameState,
	ManaColor,
	ManaSpendContext,
	PlayerGameState
} from '../types.ts';

export type CastableSourceZone = 'hand' | 'command' | 'exile' | 'graveyard' | 'library';

const ALL_MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

export interface AutoTapPreviewResult {
	canAutoTap: boolean;
	tappedPermanentIds: string[];
	energySpent: number;
	manaPoolSpent: Partial<Record<ManaColor, number>>;
}

export interface SpellAutoTapPreviewExtras {
	xValue?: number;
	optionalCostCounts?: Record<string, number>;
	phyrexianLifeCount?: number;
}

export interface AbilityAutoTapPreviewExtras {
	xValue?: number;
	phyrexianLifeCount?: number;
}

function emptyPreviewResult(): AutoTapPreviewResult {
	return {
		canAutoTap: false,
		tappedPermanentIds: [],
		energySpent: 0,
		manaPoolSpent: {}
	};
}

/**
 * Builds a fast, proxy-safe lightweight `GameState` snapshot for read-only auto-tap simulation.
 * Clones mutable player pools, provenance maps, riders, counters, and active zone `CardInstance`
 * wrappers (plus `library[0]` when present for CR 401.5 top-of-library spells) while sharing
 * immutable `ScryfallCard` definitions (`inst.card`) and `library.slice(1)`, keeping hover
 * simulation well under 0.5 ms with zero mutation of the live `gameState`.
 */
function copyInstanceShell(inst: CardInstance): CardInstance {
	return {
		...inst,
		counters: { ...inst.counters },
		...(inst.grantedKeywords ? { grantedKeywords: [...inst.grantedKeywords] } : {}),
		...(inst.activatedAbilityIdsThisTurn
			? { activatedAbilityIdsThisTurn: [...inst.activatedAbilityIdsThisTurn] }
			: {}),
		...(inst.usedOncePerGameAbilityIds
			? { usedOncePerGameAbilityIds: [...inst.usedOncePerGameAbilityIds] }
			: {})
	};
}

function copyPlayerForPreview(p: PlayerGameState): PlayerGameState {
	let restrictedCopy: PlayerGameState['restrictedMana'];
	if (p.restrictedMana) {
		restrictedCopy = {};
		for (const [rk, pool] of Object.entries(p.restrictedMana)) {
			if (pool) {
				restrictedCopy[rk as keyof NonNullable<PlayerGameState['restrictedMana']>] = { ...pool };
			}
		}
	}
	return {
		...p,
		manaPool: { ...p.manaPool },
		...(p.restrictedMana !== undefined ? { restrictedMana: restrictedCopy } : {}),
		...(p.restrictedManaBuckets
			? {
					restrictedManaBuckets: p.restrictedManaBuckets.map((b) => ({
						...b,
						pool: { ...b.pool }
					}))
				}
			: {}),
		...(p.retainedManaCounts ? { retainedManaCounts: { ...p.retainedManaCounts } } : {}),
		...(p.snowManaByColor ? { snowManaByColor: { ...p.snowManaByColor } } : {}),
		...(p.creatureManaByColor ? { creatureManaByColor: { ...p.creatureManaByColor } } : {}),
		...(p.basicLandManaByColor ? { basicLandManaByColor: { ...p.basicLandManaByColor } } : {}),
		...(p.treasureManaByColor ? { treasureManaByColor: { ...p.treasureManaByColor } } : {}),
		...(p.manaRiders ? { manaRiders: [...p.manaRiders] } : {}),
		library:
			p.library.length > 0 ? [copyInstanceShell(p.library[0]), ...p.library.slice(1)] : p.library,
		battlefield: p.battlefield.map(copyInstanceShell),
		hand: p.hand.map(copyInstanceShell),
		graveyard: p.graveyard.map(copyInstanceShell),
		exile: p.exile.map(copyInstanceShell),
		command: p.command.map(copyInstanceShell)
	};
}

function copyStateForPreview(gameState: GameState): GameState {
	return {
		...gameState,
		players: gameState.players.map(copyPlayerForPreview),
		stack: [...gameState.stack],
		pendingPrompts: [...gameState.pendingPrompts],
		passedPriorityPlayerIds: [...gameState.passedPriorityPlayerIds],
		...(gameState.pendingTriggers ? { pendingTriggers: [...gameState.pendingTriggers] } : {}),
		...(gameState.delayedTriggers ? { delayedTriggers: [...gameState.delayedTriggers] } : {}),
		...(gameState.wave7SpellDelayedTriggers
			? { wave7SpellDelayedTriggers: [...gameState.wave7SpellDelayedTriggers] }
			: {}),
		...(gameState.pendingReflexiveTriggers
			? { pendingReflexiveTriggers: [...gameState.pendingReflexiveTriggers] }
			: {}),
		...(gameState.triggeredOnceThisTurn
			? { triggeredOnceThisTurn: [...gameState.triggeredOnceThisTurn] }
			: {}),
		...(gameState.doneOnceThisTurnKeys
			? { doneOnceThisTurnKeys: [...gameState.doneOnceThisTurnKeys] }
			: {}),
		...(gameState.doThisOnceTakenThisTurn
			? { doThisOnceTakenThisTurn: [...gameState.doThisOnceTakenThisTurn] }
			: {}),
		...(gameState.timedContinuousEffects
			? { timedContinuousEffects: [...gameState.timedContinuousEffects] }
			: {}),
		...(gameState.timedKeywordEffects
			? { timedKeywordEffects: [...gameState.timedKeywordEffects] }
			: {}),
		...(gameState.triggersPlacedThisTurn
			? {
					triggersPlacedThisTurn: {
						...gameState.triggersPlacedThisTurn,
						...(gameState.triggersPlacedThisTurn.byAbility
							? { byAbility: { ...gameState.triggersPlacedThisTurn.byAbility } }
							: {})
					}
				}
			: {}),
		log: [],
		recentVfxEvents: []
	};
}

function locateCastableCardInState(
	state: GameState,
	actor: PlayerGameState,
	cardInstanceId: string
): { inst: CardInstance; fromZone: CastableSourceZone } | null {
	const inHand = actor.hand.find((c) => c.instanceId === cardInstanceId);
	if (inHand) return { inst: inHand, fromZone: 'hand' };

	const inCommand = actor.command.find((c) => c.instanceId === cardInstanceId);
	if (inCommand) return { inst: inCommand, fromZone: 'command' };

	const inGrave = actor.graveyard.find((c) => c.instanceId === cardInstanceId);
	if (inGrave) return { inst: inGrave, fromZone: 'graveyard' };

	if (actor.library[0]?.instanceId === cardInstanceId) {
		return { inst: actor.library[0], fromZone: 'library' };
	}

	for (const player of state.players) {
		const inExile = player.exile.find((c) => c.instanceId === cardInstanceId);
		if (inExile) return { inst: inExile, fromZone: 'exile' };
	}
	return null;
}

function buildActivatedAbilityPreviewSpendContext(
	state: GameState,
	perm: CardInstance,
	ability: EffectiveActivatedAbility,
	xValue = 0
): ManaSpendContext {
	const evalPerm = perm.zone === 'battlefield' ? evaluatePermanent(state, perm) : null;
	const effCard = effectiveCardForObject(perm);
	let abilitySourceTypes: string[] | undefined;
	let abilitySourceSubtypes: string[] | undefined;
	if (evalPerm) {
		abilitySourceTypes = [];
		if (evalPerm.isArtifact) abilitySourceTypes.push('Artifact');
		if (evalPerm.isCreature) abilitySourceTypes.push('Creature');
		if (evalPerm.isEnchantment) abilitySourceTypes.push('Enchantment');
		if (evalPerm.isLand) abilitySourceTypes.push('Land');
		if (evalPerm.isPlaneswalker) abilitySourceTypes.push('Planeswalker');
		if (/\bBattle\b/.test(evalPerm.effectiveTypeLine)) abilitySourceTypes.push('Battle');
		if (/\bKindred\b|\bTribal\b/.test(evalPerm.effectiveTypeLine))
			abilitySourceTypes.push('Kindred');
		abilitySourceSubtypes = splitSubtypes(evalPerm.effectiveTypeLine);
	}
	return {
		isSpell: false,
		isActivatedAbility: true,
		abilitySourceCard: effCard,
		abilitySourceFaceIndex: ability.faceIndex ?? 0,
		...(evalPerm
			? {
					abilitySourceTypes,
					abilitySourceSubtypes,
					abilitySourceColors: evalPerm.colors
				}
			: {}),
		...collectAbilityManaSpendRestrictionsP20b(state, perm, ability, xValue)
	};
}

function computePoolDiff(
	before: Record<ManaColor, number>,
	after: Record<ManaColor, number>
): Partial<Record<ManaColor, number>> {
	const diff: Partial<Record<ManaColor, number>> = {};
	for (const c of ALL_MANA_COLORS) {
		const spent = Math.max(0, (before[c] || 0) - (after[c] || 0));
		if (spent > 0) {
			diff[c] = spent;
		}
	}
	return diff;
}

/**
 * Simulates auto-tapping mana sources (plus any `tapPermanent` payment aids) to cast
 * `cardInstanceId` on an isolated state snapshot, with zero mutation of `gameState`.
 */
export function previewSpellAutoTap(
	gameState: GameState,
	playerId: string,
	cardInstanceId: string,
	castChoice?: CastOption,
	extra?: SpellAutoTapPreviewExtras
): AutoTapPreviewResult {
	const livePlayer = gameState.players.find((p) => p.playerId === playerId);
	if (!livePlayer || livePlayer.lost || gameState.status !== 'active') {
		return emptyPreviewResult();
	}

	const simState = copyStateForPreview(gameState);
	const simPlayer = simState.players.find((p) => p.playerId === playerId);
	if (!simPlayer) return emptyPreviewResult();

	const located = locateCastableCardInState(simState, simPlayer, cardInstanceId);
	if (!located) return emptyPreviewResult();
	const { inst: simInst, fromZone } = located;

	const selectedChoice: CastOption | undefined =
		castChoice ?? getCastOptions(simState, playerId, simInst, fromZone)[0];
	if (!selectedChoice) {
		return emptyPreviewResult();
	}

	const tryXValues =
		extra?.xValue !== undefined
			? [Math.max(0, extra.xValue)]
			: selectedChoice.choosesX
				? [0, 1]
				: [0];

	let chosenReq: ReturnType<typeof getSpellOptionCostRequirement> = null;
	let chosenSpendCtx: ManaSpendContext | null = null;
	let reservedAidSet = new Set<string>();
	let aidTappedIds = new Set<string>();

	for (const candidateX of tryXValues) {
		const candidateSpendCtx = spellSpendContext(simInst, {
			faceIndex: selectedChoice.faceIndex,
			fused: selectedChoice.fused,
			isFaceDown: Boolean(selectedChoice.spellMods?.castFaceDown),
			state: simState,
			xValue: candidateX,
			manaCostOverride:
				selectedChoice.baseCost.kind === 'alternative'
					? selectedChoice.baseCost.manaCost
					: undefined
		});
		const req = getSpellOptionCostRequirement(
			simState,
			playerId,
			simInst,
			selectedChoice,
			candidateX,
			extra?.optionalCostCounts
		);
		if (!req) continue;

		if (
			canPayOrAutoTap(
				simPlayer,
				req,
				simState,
				extra?.phyrexianLifeCount,
				candidateSpendCtx
			)
		) {
			chosenReq = req;
			chosenSpendCtx = candidateSpendCtx;
			reservedAidSet = new Set<string>();
			aidTappedIds = new Set<string>();
			break;
		}

		if (selectedChoice.paymentAids && selectedChoice.paymentAids.length > 0) {
			const planned = planCastCostAids(
				simState,
				simPlayer,
				selectedChoice,
				req,
				candidateSpendCtx,
				extra?.phyrexianLifeCount,
				undefined,
				false
			);
			const combinedReserved = new Set<string>();
			for (const id of planned.reservedTapIds) combinedReserved.add(id);
			for (const id of planned.reservedExileIds) combinedReserved.add(id);
			if (
				canPayOrAutoTap(
					simPlayer,
					planned.remainingReq,
					simState,
					extra?.phyrexianLifeCount,
					candidateSpendCtx,
					combinedReserved
				)
			) {
				chosenReq = planned.remainingReq;
				chosenSpendCtx = candidateSpendCtx;
				reservedAidSet = combinedReserved;
				aidTappedIds = planned.reservedTapIds;
				break;
			}
		}
	}

	if (!chosenReq || !chosenSpendCtx) {
		return emptyPreviewResult();
	}

	const initialCombined = combinedManaPoolForSpend(simPlayer, chosenSpendCtx);
	const initialEnergy = simPlayer.energyCounters || 0;
	const untappedBefore = simPlayer.battlefield.filter((perm) => !perm.tapped && !perm.phasedOut);

	const paid = payManaWithAutoTap(
		simPlayer,
		chosenReq,
		simState,
		extra?.phyrexianLifeCount,
		chosenSpendCtx,
		reservedAidSet.size > 0 ? reservedAidSet : undefined
	);
	if (!paid) {
		return emptyPreviewResult();
	}

	const finalCombined = combinedManaPoolForSpend(simPlayer, chosenSpendCtx);
	const finalEnergy = simPlayer.energyCounters || 0;

	const tappedPermanentIds: string[] = [];
	for (const perm of untappedBefore) {
		if (aidTappedIds.has(perm.instanceId) || perm.tapped || perm.zone !== 'battlefield') {
			tappedPermanentIds.push(perm.instanceId);
		}
	}

	return {
		canAutoTap: true,
		tappedPermanentIds,
		energySpent: Math.max(0, initialEnergy - finalEnergy),
		manaPoolSpent: computePoolDiff(initialCombined, finalCombined)
	};
}

/**
 * Simulates auto-tapping mana sources to activate `ability` on `permId` (battlefield, hand, or
 * graveyard) on an isolated state snapshot, with zero mutation of `gameState`.
 */
export function previewAbilityAutoTap(
	gameState: GameState,
	playerId: string,
	permId: string,
	ability: EffectiveActivatedAbility,
	extra?: AbilityAutoTapPreviewExtras
): AutoTapPreviewResult {
	const livePlayer = gameState.players.find((p) => p.playerId === playerId);
	if (!livePlayer || livePlayer.lost || gameState.status !== 'active') {
		return emptyPreviewResult();
	}

	const simState = copyStateForPreview(gameState);
	const simPlayer = simState.players.find((p) => p.playerId === playerId);
	if (!simPlayer) return emptyPreviewResult();

	const simSource =
		simPlayer.battlefield.find((c) => c.instanceId === permId) ??
		simPlayer.hand.find((c) => c.instanceId === permId) ??
		simPlayer.graveyard.find((c) => c.instanceId === permId);
	if (!simSource) return emptyPreviewResult();

	if (!checkAbilityActivationLegality(simState, playerId, simSource, ability).ok) {
		return emptyPreviewResult();
	}

	const abilityX = Math.max(0, extra?.xValue ?? 0);
	const spendCtx = buildActivatedAbilityPreviewSpendContext(simState, simSource, ability, abilityX);
	const req = effectiveAbilityManaCost(
		simState,
		playerId,
		ability.id,
		ability.baseManaCost ?? ability.manaCost,
		ability.costKeyword,
		abilityX,
		simSource,
		ability.isManaAbility,
		Boolean(ability.powerUpReduction),
		undefined,
		ability.loyaltyCost !== null
	).requirement;

	const reservedTapIds = new Set<string>();
	const selfTapsOrSacrifices =
		ability.requiresTap ||
		ability.requiresSacrificeSelf ||
		ability.cost.some(
			(d) => d.k === 'tapSelf' || (d.k === 'sacrifice' && d.filter === 'self')
		);
	if (simSource.zone === 'battlefield' && selfTapsOrSacrifices) {
		reservedTapIds.add(simSource.instanceId);
	}

	const initialCombined = combinedManaPoolForSpend(simPlayer, spendCtx);
	const initialEnergy = simPlayer.energyCounters || 0;

	// Account for any direct `{E}` cost on the ability itself before auto-tapping `{E}` mana sources.
	let directAbilityEnergy = 0;
	for (const def of ability.cost) {
		if (def.k === 'payEnergy') {
			directAbilityEnergy += Math.max(
				0,
				evaluateAmount(def.count, {
					state: simState,
					controllerId: playerId,
					source: simSource
				})
			);
		}
	}
	if (directAbilityEnergy > 0) {
		if ((simPlayer.energyCounters || 0) < directAbilityEnergy) {
			return emptyPreviewResult();
		}
		simPlayer.energyCounters = (simPlayer.energyCounters || 0) - directAbilityEnergy;
	}

	const untappedBefore = simPlayer.battlefield.filter((perm) => !perm.tapped && !perm.phasedOut);

	const paid = payManaWithAutoTap(
		simPlayer,
		req,
		simState,
		extra?.phyrexianLifeCount,
		spendCtx,
		reservedTapIds.size > 0 ? reservedTapIds : undefined
	);
	if (!paid) {
		return emptyPreviewResult();
	}

	const finalCombined = combinedManaPoolForSpend(simPlayer, spendCtx);
	const finalEnergy = simPlayer.energyCounters || 0;

	const tappedPermanentIds: string[] = [];
	for (const perm of untappedBefore) {
		if (perm.tapped || perm.zone !== 'battlefield') {
			tappedPermanentIds.push(perm.instanceId);
		}
	}

	return {
		canAutoTap: true,
		tappedPermanentIds,
		energySpent: Math.max(0, initialEnergy - finalEnergy),
		manaPoolSpent: computePoolDiff(initialCombined, finalCombined)
	};
}

export const computeSpellAutoTapPreview = previewSpellAutoTap;
export const computeAbilityAutoTapPreview = previewAbilityAutoTap;
