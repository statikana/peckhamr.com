import { canPayManaCost, type ManaCostRequirement, parseManaCost } from '../oracle.ts';
import { effectiveBattlefieldCardAndFaceOpts, evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CostPayment,
	EffectiveActivatedAbility,
	GameActionPayload,
	GameState,
	ManaColor,
	ManaPool,
	ManaSpendContext,
	PlayerGameState
} from '../types.ts';
import { registerPromptHandler } from './choices.ts';
import {
	activatedAbilityCost,
	canPayCosts,
	payPlannedCosts,
	planCosts
} from './costs.ts';
import {
	canSatisfyP20bManaSpendRestrictions,
	initP20bSimSourcePools,
	permanentManaSourceFlagsP20b,
	pickP20bPreferredColorForPass2,
	recordP20bSourceManaAdded,
	rewriteAndDeductP20bSourceMana
} from './costsWave7.ts';
import { resolveP19aDelayedTappedManaTriggers } from './effectsWave7.ts';
import {
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity,
	H,
	isSacrificeSelfNonCreatureManaCost,
	isTapOnlyManaCost,
	manaCostPayEnergyAmount
} from './engineHost.ts';
import { emitEvent } from './events.ts';
import { instanceFaceOptions, resolveEffectiveActivatedAbilityDef } from './faces.ts';
import { onPlayerLostLifeCheckSpeedTrigger } from './framesBattlesAndKeywordsWave5.ts';
import { recordPlayerLifeLossWave4 } from './keywordsWave4.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import {
	addManaToPlayerPool,
	canSpendManaRestrictionSpec,
	canSpendRestrictedMana,
	combinedManaPoolForSpend,
	deductManaForSpendContext,
	getTotalPooledManaForContext
} from './mana.ts';
import {
	colorsOfExiledLinkedCards,
	distinctColorsControlled,
	hasEligibleGenericManaForDisallowCheck
} from './manaCountersWave11.ts';
import { evaluateCondition, type FilterContext } from './objectFilter.ts';
import { uid } from './random.ts';
import { checkGlobalAbilityActivationRestrictions } from './replace.ts';
import {
	clampSnowManaToPool,
	deductManaConservingSnow,
	isSnowPermanent,
	playerCantPayLifeForCost,
	recordSnowManaAdded,
	totalSnowManaInPool
} from './staticsDynamicAndCosts.ts';
import { getTapForManaMultiplier } from './staticsWave7.ts';
import { flushInlineTriggers } from './triggers.ts';
import {
	isPermanentLandForManaP19b,
	recordP19bManaDeduction,
	recordP19bTreasureManaAdded,
	totalUnrestrictedAndRestrictedPoolCount
} from './triggersWave7.ts';
import {
	applyNextUntapFreeze,
	expandCombinationBundles,
	FIVE_MANA_COLORS,
	pickBestBundleForRequirement,
	pickCombinationForRequirement,
	scoreBundleForRequirement
} from './tuckFreezeChosen.ts';
import { tapPermanent } from './zones.ts';

/**
 * Mana abilities that auto-tapping may use:
 * - Tier 0 (preferred): `{T}`-only mana abilities (lands, mana rocks, mana dorks).
 * - Tier 1 (fallback after `{T}`-only sources): `{T}, Sacrifice ~` mana abilities on non-creature
 *   permanents (such as Treasure tokens).
 * Within each cost tier, higher-output mana abilities (e.g. Goldspan's 2-mana Treasure ability)
 * sort ahead of lower-output ones.
 */
export function autoTapManaAbilities(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	cmdIdentity: ManaColor[],
	spendCtx: ManaSpendContext = { isSpell: false }
): EffectiveActivatedAbility[] {
	if (!checkGlobalAbilityActivationRestrictions(state, player.playerId, perm, true).ok) {
		return [];
	}
	const evalPerm = evaluatePermanent(state, perm);
	const noManaCtx = H().costContext(state, player, perm, 0, false, null);
	const scored: Array<{
		ab: EffectiveActivatedAbility;
		tier: number;
		freezes: number;
		restricted: number;
		amount: number;
	}> = [];
	for (const a of getEffectiveActivatedAbilities(state, player, perm, cmdIdentity)) {
		if (!a.isManaAbility || a.producesMana.length === 0) continue;
		// --- Track P21 (CR 605.3c): Never auto-tap "Activate only as an instant" mana abilities ---
		if (a.activationRestrictions?.includes('onlyAsInstant')) continue;
		// --- End Track P21 ---
		if (a.manaRestriction && !canSpendRestrictedMana(a.manaRestriction, spendCtx)) continue;
		// --- Track P10 ---
		if (a.manaRestrictionSpec && !canSpendManaRestrictionSpec(a.manaRestrictionSpec, spendCtx)) continue;
		// --- End Track P10 ---
		if (!H().checkActivationRestrictionsOnly(state, player.playerId, perm, a).ok) continue;
		const defs = activatedAbilityCost(perm.card, a).defs;
		let tier = -1;
		if (isTapOnlyManaCost(defs)) {
			if (!canPayCosts(noManaCtx, defs)) continue;
			tier = 0;
		} else if (manaCostPayEnergyAmount(defs) !== null) {
			if (!canPayCosts(noManaCtx, defs)) continue;
			tier = 1;
		} else if (isSacrificeSelfNonCreatureManaCost(defs, evalPerm.isCreature)) {
			if (!canPayCosts(noManaCtx, defs)) continue;
			tier = 2;
		}
		if (tier < 0) continue;
		const amount = H().getDynamicManaProducedAmount(
			state,
			player,
			perm,
			Math.max(0, a.producesAmount),
			a
		);
		if (amount <= 0) continue;
		scored.push({
			ab: a,
			tier,
			freezes: a.freezesSelfUntap ? 1 : 0,
			restricted:
				a.manaRestriction ||
				// --- Track P10 ---
				a.manaRestrictionSpec
				// --- End Track P10 ---
					? 0
					: 1,
			amount
		});
	}
	scored.sort(
		(x, y) =>
			x.tier - y.tier ||
			x.freezes - y.freezes ||
			x.restricted - y.restricted ||
			y.amount - x.amount
	);
	return scored.map((s) => s.ab);
}

function hasUntappedManaSources(
	state: GameState,
	player: PlayerGameState,
	spendCtx: ManaSpendContext = { isSpell: false }
): boolean {
	const cmdIdentity = getPlayerCommanderIdentity(player);
	return withStableLayerInputs(state, () =>
		player.battlefield.some((perm) => {
			if (perm.phasedOut) return false;
			return autoTapManaAbilities(state, player, perm, cmdIdentity, spendCtx).length > 0;
		})
	);
}

/**
 * CR 107.4f & CR 601.2f-h: Convert `lifeCount` Phyrexian mana symbols (`{W/P}`, `{U/P}`, etc.)
 * into 2 life each before auto-tapping so Pass 2 only taps lands for the remaining mana cost.
 */
function applyPhyrexianLifeChoice(
	req: ManaCostRequirement,
	lifeCount: number
): { manaReq: ManaCostRequirement; lifeToPay: number } {
	if (!req.flexibleSymbols?.some((s) => s.altLife)) {
		return { manaReq: req, lifeToPay: 0 };
	}
	const nextColored = { ...req.colored };
	const remainingFlex = [...(req.flexibleSymbols ?? [])];
	let lifeToPay = 0;
	let remainingToConvert = Math.max(0, lifeCount);
	for (let i = 0; i < remainingFlex.length && remainingToConvert > 0; ) {
		const sym = remainingFlex[i];
		if (sym.altLife && nextColored[sym.primaryColor] > 0) {
			nextColored[sym.primaryColor] -= 1;
			lifeToPay += sym.altLife;
			remainingFlex.splice(i, 1);
			remainingToConvert -= 1;
		} else {
			i += 1;
		}
	}
	// --- Track P11: CR 107.4g hybrid-Phyrexian symbols ({W/U/P}) not paid with life retain their hybrid alternative ---
	const normalizedFlex = remainingFlex.map((sym) =>
		sym.altLife && (sym.altColor !== undefined || sym.altGeneric !== undefined)
			? {
					primaryColor: sym.primaryColor,
					...(sym.altColor !== undefined ? { altColor: sym.altColor } : {}),
					...(sym.altGeneric !== undefined ? { altGeneric: sym.altGeneric } : {})
				}
			: sym
	);
	// --- End Track P11 ---
	return {
		manaReq: {
			...req,
			colored: nextColored,
			flexibleSymbols: normalizedFlex.length > 0 ? normalizedFlex : undefined
		},
		lifeToPay
	};
}

export function maybeAskPhyrexianCostChoice(
	state: GameState,
	actor: PlayerGameState,
	action: Extract<
		GameActionPayload,
		{
			type:
				| 'cast_spell'
				| 'activate_ability'
				| 'tap_mana'
				| 'unlock_room_door'
				| 'turn_face_up'
				| 'hand_special_action';
		}
	>,
	req: ManaCostRequirement,
	sourceName: string,
	spendCtx: ManaSpendContext = { isSpell: false },
	canPayCheck?: (candidateReq: ManaCostRequirement) => boolean
): { ok: boolean; error?: string } | null {
	if (actor.isBot || action.costPayment?.phyrexianLifeCount !== undefined) return null;
	const phySymbols = req.flexibleSymbols?.filter((s) => s.altLife) ?? [];
	if (phySymbols.length === 0) return null;
	// --- Track P11 ---
	const canPayLife = !playerCantPayLifeForCost(state, actor, 2);
	// --- End Track P11 ---
	const maxLifeCount = canPayLife ? Math.min(phySymbols.length, Math.floor(actor.life / 2)) : 0;
	if (maxLifeCount <= 0) return null;
	// No mana possible: keep today's behavior of paying life without prompting (unless payment aids are available).
	if (
		!canPayCheck &&
		getTotalPooledManaForContext(actor, spendCtx) === 0 &&
		!hasUntappedManaSources(state, actor, spendCtx)
	) {
		return null;
	}
	const canPay =
		canPayCheck ?? ((candidateReq: ManaCostRequirement) => canPayOrAutoTap(actor, candidateReq, state, undefined, spendCtx));
	if (!canPay(req)) return null;
	const labels: string[] = [];
	for (let k = 0; k <= maxLifeCount; k++) {
		const manaSymbols = phySymbols
			.slice(k)
			// --- Track P11 ---
			.map((s) =>
				s.altColor !== undefined
					? `{${s.primaryColor}/${s.altColor}}`
					: `{${s.primaryColor}}`
			)
			// --- End Track P11 ---
			.join('');
		const lifeAmt = 2 * k;
		if (k === 0) {
			labels.push(`Pay ${manaSymbols}`);
		} else if (manaSymbols.length > 0) {
			labels.push(`Pay ${manaSymbols} and ${lifeAmt} life`);
		} else {
			labels.push(`Pay ${lifeAmt} life`);
		}
	}
	state.pendingPrompts.push({
		id: uid('prm', state),
		playerId: actor.playerId,
		kind: 'cost_choice',
		purpose: 'cost_choice',
		title: `Pay the cost of ${sourceName}`,
		description: `Choose how to pay Phyrexian mana for ${sourceName}.`,
		choice: {
			kind: 'chooseMode',
			modes: labels,
			min: 1,
			max: 1
		},
		cancellable: true,
		costQuestion: { kind: 'phyrexian', index: 0 },
		costOptionLabels: labels,
		pendingAction: action
	});
	return { ok: true };
}

function applySingleHybridChoice(
	req: ManaCostRequirement,
	choice: number
): ManaCostRequirement {
	const flex = req.flexibleSymbols ?? [];
	const idx = flex.findIndex((s) => !s.altLife);
	if (idx < 0) return req;
	const sym = flex[idx];
	const nextColored = { ...req.colored };
	let nextGeneric = req.generic;
	if (choice === 1) {
		if (sym.altColor !== undefined) {
			nextColored[sym.primaryColor] = Math.max(0, nextColored[sym.primaryColor] - 1);
			nextColored[sym.altColor] += 1;
		} else if (sym.altGeneric !== undefined) {
			nextColored[sym.primaryColor] = Math.max(0, nextColored[sym.primaryColor] - 1);
			nextGeneric += sym.altGeneric;
		}
	}
	const remainingFlex = flex.filter((_, i) => i !== idx);
	return {
		...req,
		colored: nextColored,
		generic: nextGeneric,
		flexibleSymbols: remainingFlex.length > 0 ? remainingFlex : undefined
	};
}

export function resolveHybridCostChoice(
	state: GameState,
	actor: PlayerGameState,
	action: Extract<
		GameActionPayload,
		{
			type:
				| 'cast_spell'
				| 'activate_ability'
				| 'tap_mana'
				| 'unlock_room_door'
				| 'turn_face_up'
				| 'hand_special_action';
		}
	>,
	req: ManaCostRequirement,
	sourceName: string,
	spendCtx: ManaSpendContext = { isSpell: false },
	canPayCheck?: (candidateReq: ManaCostRequirement) => boolean
): { promptResult?: { ok: boolean; error?: string }; resolvedReq: ManaCostRequirement } {
	let currentReq = req;
	// --- Track P11: Convert hybrid-Phyrexian symbols ({W/U/P}) not paid with life into {W/U} ---
	if (
		currentReq.flexibleSymbols?.some((s) => s.altLife && (s.altColor !== undefined || s.altGeneric !== undefined)) &&
		(action.costPayment?.phyrexianLifeCount !== undefined || playerCantPayLifeForCost(state, actor, 2))
	) {
		const committedLifeCount = playerCantPayLifeForCost(state, actor, 2)
			? 0
			: (action.costPayment?.phyrexianLifeCount ?? 0);
		let skippedPhy = 0;
		currentReq = {
			...currentReq,
			flexibleSymbols: currentReq.flexibleSymbols.map((sym) => {
				if (!sym.altLife) return sym;
				if (skippedPhy < committedLifeCount) {
					skippedPhy += 1;
					return sym;
				}
				if (sym.altColor !== undefined || sym.altGeneric !== undefined) {
					return {
						primaryColor: sym.primaryColor,
						...(sym.altColor !== undefined ? { altColor: sym.altColor } : {}),
						...(sym.altGeneric !== undefined ? { altGeneric: sym.altGeneric } : {})
					};
				}
				return sym;
			})
		};
	}
	// --- End Track P11 ---
	const hybridChoices = action.costPayment?.hybridChoices ?? [];
	let choiceIdx = 0;
	while (choiceIdx < hybridChoices.length && currentReq.flexibleSymbols?.some((s) => !s.altLife)) {
		const c = hybridChoices[choiceIdx];
		if (c === 0 || c === 1) {
			currentReq = applySingleHybridChoice(currentReq, c);
		}
		choiceIdx += 1;
	}
	if (actor.isBot) {
		return { resolvedReq: currentReq };
	}
	const canPay =
		canPayCheck ??
		((candidateReq: ManaCostRequirement) =>
			canPayOrAutoTap(actor, candidateReq, state, action.costPayment?.phyrexianLifeCount, spendCtx));
	while (currentReq.flexibleSymbols?.some((s) => !s.altLife)) {
		const sym = currentReq.flexibleSymbols.find((s) => !s.altLife)!;
		const req0 = applySingleHybridChoice(currentReq, 0);
		const req1 = applySingleHybridChoice(currentReq, 1);
		const canPay0 = canPay(req0);
		const canPay1 = canPay(req1);
		if (canPay0 && !canPay1) {
			currentReq = req0;
			choiceIdx += 1;
			continue;
		}
		if (!canPay0 && canPay1) {
			currentReq = req1;
			choiceIdx += 1;
			continue;
		}
		if (canPay0 && canPay1) {
			const label0 = `Pay {${sym.primaryColor}}`;
			const label1 =
				sym.altColor !== undefined
					? `Pay {${sym.altColor}}`
					: `Pay {${sym.altGeneric ?? 2}}`;
			const labels = [label0, label1];
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: actor.playerId,
				kind: 'cost_choice',
				purpose: 'cost_choice',
				title: `Pay the cost of ${sourceName}`,
				description: `Choose how to pay hybrid mana for ${sourceName} (CR 107.4e).`,
				choice: {
					kind: 'chooseMode',
					modes: labels,
					min: 1,
					max: 1,
					defaultIndices: [0]
				},
				cancellable: true,
				costQuestion: { kind: 'hybrid', index: choiceIdx },
				costOptionLabels: labels,
				pendingAction: action
			});
			return { promptResult: { ok: true }, resolvedReq: currentReq };
		}
		break;
	}
	return { resolvedReq: currentReq };
}

export const TAP_MANA_ABILITY_CHOICE_HANDLER = 'tap_mana_ability_choice';
export const TAP_MANA_COLOR_CHOICE_HANDLER = 'tap_mana_color_choice';
export const TAP_MANA_BUNDLE_CHOICE_HANDLER = 'tap_mana_bundle_choice';

registerPromptHandler(TAP_MANA_ABILITY_CHOICE_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : '';
	const abilityIds =
		typeof data?.abilityIdsCsv === 'string' && data.abilityIdsCsv.length > 0
			? data.abilityIdsCsv.split('\u001f')
			: [];
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const abilityId = abilityIds[idx] ?? abilityIds[0];
	const preferredColor =
		typeof data?.preferredColor === 'string' && data.preferredColor.length > 0
			? (data.preferredColor as ManaColor)
			: undefined;
	const chosenBundle =
		typeof data?.chosenBundleCsv === 'string' && data.chosenBundleCsv.length > 0
			? (data.chosenBundleCsv.split(',') as ManaColor[])
			: undefined;
	const costPayment =
		typeof data?.costPaymentJson === 'string'
			? (JSON.parse(data.costPaymentJson) as CostPayment)
			: undefined;
	// --- Track P17b ---
	const xValue = typeof data?.xValue === 'number' ? data.xValue : undefined;
	// --- End Track P17b ---
	H().applyGameActionInner(state, prompt.playerId, {
		type: 'tap_mana',
		instanceId,
		...(abilityId ? { abilityId } : {}),
		...(preferredColor ? { preferredColor } : {}),
		...(chosenBundle ? { chosenBundle } : {}),
		...(costPayment ? { costPayment } : {}),
		// --- Track P17b ---
		...(xValue !== undefined ? { xValue } : {})
		// --- End Track P17b ---
	});
});

registerPromptHandler(TAP_MANA_COLOR_CHOICE_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : '';
	const abilityId =
		typeof data?.abilityId === 'string' && data.abilityId.length > 0 ? data.abilityId : undefined;
	const colors =
		typeof data?.colorsCsv === 'string' && data.colorsCsv.length > 0
			? (data.colorsCsv.split(',') as ManaColor[])
			: (['W', 'U', 'B', 'R', 'G'] as ManaColor[]);
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const preferredColor = colors[idx] ?? colors[0];
	const costPayment =
		typeof data?.costPaymentJson === 'string'
			? (JSON.parse(data.costPaymentJson) as CostPayment)
			: undefined;
	// --- Track P17b ---
	const xValue = typeof data?.xValue === 'number' ? data.xValue : undefined;
	// --- End Track P17b ---
	H().applyGameActionInner(state, prompt.playerId, {
		type: 'tap_mana',
		instanceId,
		...(abilityId ? { abilityId } : {}),
		preferredColor,
		...(costPayment ? { costPayment } : {}),
		// --- Track P17b ---
		...(xValue !== undefined ? { xValue } : {})
		// --- End Track P17b ---
	});
});

registerPromptHandler(TAP_MANA_BUNDLE_CHOICE_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : '';
	const abilityId =
		typeof data?.abilityId === 'string' && data.abilityId.length > 0 ? data.abilityId : undefined;
	const bundles =
		typeof data?.bundlesCsv === 'string' && data.bundlesCsv.length > 0
			? data.bundlesCsv.split('|').map((s) => s.split(',') as ManaColor[])
			: [];
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const chosenBundle = bundles[idx] ?? bundles[0];
	const costPayment =
		typeof data?.costPaymentJson === 'string'
			? (JSON.parse(data.costPaymentJson) as CostPayment)
			: undefined;
	// --- Track P17b ---
	const xValue = typeof data?.xValue === 'number' ? data.xValue : undefined;
	// --- End Track P17b ---
	H().applyGameActionInner(state, prompt.playerId, {
		type: 'tap_mana',
		instanceId,
		...(abilityId ? { abilityId } : {}),
		...(chosenBundle ? { chosenBundle } : {}),
		...(costPayment ? { costPayment } : {}),
		// --- Track P17b ---
		...(xValue !== undefined ? { xValue } : {})
		// --- End Track P17b ---
	});
});

/**
 * CR 106.12, 605.1b, 605.3b, 605.4a: Single funnel for resolving an activated mana ability of `perm`
 * after its activation costs (such as `{T}`) have been paid. Records `onceEachTurn`, adds the
 * produced mana to `player.manaPool`, emits `TappedForMana`, and resolves triggered mana abilities
 * immediately without using the stack (`flushInlineTriggers`).
 */
export function resolveActivatedManaAbility(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	ab: EffectiveActivatedAbility | undefined,
	chosenColor: ManaColor | undefined,
	amount: number,
	tappedForMana = true,
	chosenBundle?: readonly ManaColor[]
): void {
	if (ab?.id && ab.activationRestrictions?.includes('onceEachTurn')) {
		if (!perm.activatedAbilityIdsThisTurn?.includes(ab.id)) {
			perm.activatedAbilityIdsThisTurn = [...(perm.activatedAbilityIdsThisTurn ?? []), ab.id];
		}
	}
	if (ab?.id && ab.activationRestrictions?.includes('oncePerGame')) {
		if (!perm.usedOncePerGameAbilityIds?.includes(ab.id)) {
			perm.usedOncePerGameAbilityIds = [...(perm.usedOncePerGameAbilityIds ?? []), ab.id];
		}
	}
	if (ab?.freezesSelfUntap) {
		applyNextUntapFreeze(perm);
	}
	// --- Track P10 ---
	const addOpts = H().p10AddManaOptions(ab);
	// --- End Track P10 ---
	// --- Track P11: CR 107.4h track mana produced by a Snow permanent ---
	const producedSnow = !ab?.manaRestriction && !ab?.manaRestrictionSpec && isSnowPermanent(state, perm);
	// --- End Track P11 ---
	// --- Track P20a (CR 106.12): Multiplicative tap-for-mana replacements ---
	const tapMult = tappedForMana ? getTapForManaMultiplier(state, player.playerId, perm) : 1;
	// --- End Track P20a ---
	// --- Track P20b ---
	const producedUnrestrictedPoolMana = !ab?.manaRestriction && !ab?.manaRestrictionSpec;
	// --- End Track P20b ---
	const condCtx: FilterContext = { state, controllerId: player.playerId, source: perm };
	const { effectiveCard: effManaCard, effectiveFaceOpts: effManaFaceOpts } =
		perm.zone === 'battlefield'
			? effectiveBattlefieldCardAndFaceOpts(state, perm)
			: {
					effectiveCard: effectiveCardForObject(perm),
					effectiveFaceOpts: instanceFaceOptions(perm, perm.zone)
				};
	const abilityDef = resolveEffectiveActivatedAbilityDef(effManaCard, effManaFaceOpts, ab);
	if (chosenBundle && chosenBundle.length > 0) {
		for (const col of chosenBundle) {
			addManaToPlayerPool(player, col, tapMult, ab?.manaRestriction, addOpts);
			// --- Track P11 ---
			if (producedSnow) {
				recordSnowManaAdded(player, col, tapMult);
			}
			// --- End Track P11 ---
			// --- Track P20b ---
			if (producedUnrestrictedPoolMana) {
				recordP20bSourceManaAdded(state, player, perm, col, tapMult);
			}
			// --- End Track P20b ---
		}
		if (abilityDef && abilityDef.kind === 'activated') {
			for (const eff of abilityDef.effect) {
				if (eff.condition && !evaluateCondition(eff.condition, condCtx)) continue;
				if (eff.verb === 'addMana' && eff.delayed) {
					for (const col of chosenBundle) {
						for (let m = 0; m < tapMult; m++) {
							(player.manaRiders ??= []).push({
								id: uid('rider', state),
								color: col,
								sourceInstanceId: perm.instanceId,
								sourceCard: effManaCard,
								condition: { sharesCreatureTypeWithCommander: true },
								scryAmount: 1
							});
						}
					}
				}
			}
		}
	} else if (chosenColor && amount > 0) {
		const finalAmount = amount * tapMult;
		addManaToPlayerPool(player, chosenColor, finalAmount, ab?.manaRestriction, addOpts);
		// --- Track P11 ---
		if (producedSnow) {
			recordSnowManaAdded(player, chosenColor, finalAmount);
		}
		// --- End Track P11 ---
		// --- Track P20b ---
		if (producedUnrestrictedPoolMana) {
			recordP20bSourceManaAdded(state, player, perm, chosenColor, finalAmount);
		}
		// --- End Track P20b ---
		if (abilityDef && abilityDef.kind === 'activated') {
			for (const eff of abilityDef.effect) {
				if (eff.condition && !evaluateCondition(eff.condition, condCtx)) continue;
				if (eff.verb === 'addMana' && eff.delayed) {
					for (let i = 0; i < finalAmount; i++) {
						(player.manaRiders ??= []).push({
							id: uid('rider', state),
							color: chosenColor,
							sourceInstanceId: perm.instanceId,
							sourceCard: effManaCard,
							condition: { sharesCreatureTypeWithCommander: true },
							scryAmount: 1
						});
					}
				}
			}
		}
	}
	const wave11AddedColors: ManaColor[] = [];
	let wave11TotalAdded = 0;
	if ((!chosenBundle || chosenBundle.length === 0) && !(chosenColor && amount > 0)) {
		if (abilityDef && abilityDef.kind === 'activated') {
			for (const eff of abilityDef.effect) {
				if (eff.verb !== 'addMana') continue;
				if (eff.condition && !evaluateCondition(eff.condition, condCtx)) continue;
				if (eff.params?.addManaPerColorControlled) {
					const cols = distinctColorsControlled(state, player.playerId);
					for (const col of cols) {
						addManaToPlayerPool(player, col, tapMult, ab?.manaRestriction, addOpts);
						if (producedSnow) recordSnowManaAdded(player, col, tapMult);
						if (producedUnrestrictedPoolMana) recordP20bSourceManaAdded(state, player, perm, col, tapMult);
						if (!wave11AddedColors.includes(col)) wave11AddedColors.push(col);
						wave11TotalAdded += tapMult;
					}
				} else if (eff.params?.addManaFromExiledColors) {
					const srcVer =
						perm.zone === 'battlefield'
							? (perm.objectVersion ?? 1)
							: (perm.lastBattlefieldVersion ?? perm.objectVersion ?? 1);
					const cols = colorsOfExiledLinkedCards(state, perm.instanceId, srcVer);
					if (cols.length > 0) {
						const col = chosenColor && cols.includes(chosenColor) ? chosenColor : cols[0];
						const baseAmt = eff.amount?.k === 'const' ? Math.max(1, eff.amount.n) : 1;
						const finalAmt = baseAmt * tapMult;
						addManaToPlayerPool(player, col, finalAmt, ab?.manaRestriction, addOpts);
						if (producedSnow) recordSnowManaAdded(player, col, finalAmt);
						if (producedUnrestrictedPoolMana) recordP20bSourceManaAdded(state, player, perm, col, finalAmt);
						if (!wave11AddedColors.includes(col)) wave11AddedColors.push(col);
						wave11TotalAdded += finalAmt;
					}
				}
			}
		}
	}
	// --- Track P19b: CR 605.1b, 605.4a track produced colors, Treasure mana, and ManaAddedByLandAbility ---
	const producedColors: ManaColor[] =
		chosenBundle && chosenBundle.length > 0
			? [...new Set(chosenBundle)]
			: chosenColor && amount > 0
				? [chosenColor]
				: wave11AddedColors;
	const totalManaAdded =
		chosenBundle && chosenBundle.length > 0
			? chosenBundle.length
			: chosenColor && amount > 0
				? amount
				: wave11TotalAdded;
	recordP19bTreasureManaAdded(state, player, perm, totalManaAdded);
	// --- End Track P19b ---
	// --- Track P19a (CR 605.1b, CR 605.4a): Record mana types produced & resolve High Tide-style delayed triggers ---
	perm.lastManaProduced = [...producedColors];
	state.lastTappedManaProduced = [...producedColors];
	// --- End Track P19a ---
	if (tappedForMana) {
		// CR 605.1b, 605.4a: triggered mana abilities ("Whenever you tap a land for mana") resolve immediately.
		emitEvent(state, {
			kind: 'TappedForMana',
			playerId: player.playerId,
			objectId: perm.instanceId,
			object: perm,
			// --- Track P19b ---
			...(producedColors.length > 0 ? { producedColors } : {})
			// --- End Track P19b ---
		});
		flushInlineTriggers(state);
		// --- Track P19a ---
		resolveP19aDelayedTappedManaTriggers(state, player, perm);
		// --- End Track P19a ---
	}
	// --- Track P19b: CR 605.1b second prong ("Whenever a land's ability causes you to add ...") ---
	if (producedColors.length > 0 && isPermanentLandForManaP19b(state, perm)) {
		emitEvent(state, {
			kind: 'ManaAddedByLandAbility',
			playerId: player.playerId,
			objectId: perm.instanceId,
			object: perm,
			producedColors,
			amount: totalManaAdded
		});
		flushInlineTriggers(state);
	}
	// --- End Track P19b ---
}

// --- Track P11: Snow-conserving mana pool deduction (CR 107.4h) ---
function deductManaForSpendContextWithSnow(
	player: PlayerGameState,
	manaReq: ManaCostRequirement,
	spendCtx: ManaSpendContext
): void {
	// --- Track P19b ---
	const p19bPoolBefore = totalUnrestrictedAndRestrictedPoolCount(player);
	// --- End Track P19b ---
	// --- Track P20b ---
	const effReq = rewriteAndDeductP20bSourceMana(
		combinedManaPoolForSpend(player, spendCtx),
		manaReq,
		spendCtx,
		player
	);
	// --- End Track P20b ---
	const snowReq = effReq.snow ?? 0;
	const snowPool = totalSnowManaInPool(player);
	if (snowReq === 0 && snowPool === 0) {
		deductManaForSpendContext(player, effReq, spendCtx);
		// --- Track P20b ---
		clampSnowManaToPool(player);
		// --- End Track P20b ---
		// --- Track P19b ---
		recordP19bManaDeduction(
			player,
			p19bPoolBefore,
			totalUnrestrictedAndRestrictedPoolCount(player),
			Boolean(spendCtx.isSpell)
		);
		// --- End Track P19b ---
		return;
	}
	const unrestrictedTotal =
		player.manaPool.W +
		player.manaPool.U +
		player.manaPool.B +
		player.manaPool.R +
		player.manaPool.G +
		player.manaPool.C;
	const hasEligibleRestricted = getTotalPooledManaForContext(player, spendCtx) > unrestrictedTotal;
	if (!hasEligibleRestricted) {
		const beforePool = { ...player.manaPool };
		deductManaConservingSnow(player, effReq);
		// --- Track P20b ---
		clampSnowManaToPool(player);
		// --- End Track P20b ---
		const spentColors: ManaColor[] = [];
		// --- Track P13 ---
		const spentColorsAll: ManaColor[] = [];
		// --- End Track P13 ---
		for (const c of FIVE_MANA_COLORS) {
			const diff = beforePool[c] - player.manaPool[c];
			if (diff > 0) {
				spentColors.push(c);
				// --- Track P13 ---
				for (let k = 0; k < diff; k++) spentColorsAll.push(c);
				// --- End Track P13 ---
			}
		}
		spendCtx.capturedColorsSpent = spentColors;
		// --- Track P13 ---
		spendCtx.capturedColorsAllSpent = spentColorsAll;
		// --- End Track P13 ---
	} else {
		deductManaForSpendContext(player, effReq, spendCtx);
		clampSnowManaToPool(player);
	}
	// --- Track P19b ---
	recordP19bManaDeduction(
		player,
		p19bPoolBefore,
		totalUnrestrictedAndRestrictedPoolCount(player),
		Boolean(spendCtx.isSpell)
	);
	// --- End Track P19b ---
}
// --- End Track P11 ---

function simulateOrExecuteManaOnly(
	player: PlayerGameState,
	manaReq: ManaCostRequirement,
	state: GameState,
	mutate: boolean,
	lifeToPay: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>,
	filterDepth = 0
): boolean {
	// --- Track P11 ---
	if (lifeToPay > 0 && playerCantPayLifeForCost(state, player, lifeToPay)) {
		return false;
	}
	const snowReq = manaReq.snow ?? 0;
	const initialSnow = totalSnowManaInPool(player);
	// --- End Track P11 ---
	const initialPool = combinedManaPoolForSpend(player, spendCtx);
	// --- Track P20b ---
	const initialSourcePools = initP20bSimSourcePools(player);
	// --- End Track P20b ---
	if (
		canPayManaCost(initialPool, manaReq, undefined, snowReq > 0 ? initialSnow : undefined) &&
		hasEligibleGenericManaForDisallowCheck(player, manaReq, spendCtx) !== false &&
		// --- Track P20b ---
		canSatisfyP20bManaSpendRestrictions(
			initialPool,
			manaReq,
			spendCtx,
			initialSourcePools,
			(subPool, req) => canPayManaCost(subPool, req)
		)
		// --- End Track P20b ---
	) {
		if (mutate) {
			// --- Track P11 ---
			deductManaForSpendContextWithSnow(player, manaReq, spendCtx);
			// --- End Track P11 ---
			if (lifeToPay > 0) {
				player.life -= lifeToPay;
				// --- Track P10 ---
				player.lostLifeThisTurn = true;
				noteLayerInputsChanged(state);
				// --- End Track P10 ---
				// --- Track P12 ---
				recordPlayerLifeLossWave4(player, lifeToPay);
				// --- End Track P12 ---
				// --- Track P15: Compleated life-paid tracking (CR 702.150a) & Speed trigger (CR 702.178b) ---
				spendCtx.capturedPhyrexianLifePaidCount =
					(spendCtx.capturedPhyrexianLifePaidCount ?? 0) + Math.floor(lifeToPay / 2);
				onPlayerLostLifeCheckSpeedTrigger(state, player.playerId, lifeToPay);
				// --- End Track P15 ---
			}
		}
		return true;
	}

	const pool: ManaPool = { ...initialPool };
	const disallowedGenericSimPool: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	if (player.restrictedManaBuckets) {
		for (const bucket of player.restrictedManaBuckets) {
			if (!bucket.spec.disallowGeneric) continue;
			if (!canSpendManaRestrictionSpec(bucket.spec, spendCtx)) continue;
			for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
				disallowedGenericSimPool[c] += bucket.pool[c];
			}
		}
	}
	const simCanPayWithDisallow = (simPool: ManaPool, disPool: ManaPool, req: ManaCostRequirement): boolean => {
		let hasAnyDis = false;
		for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
			if (disPool[c] > 0) {
				hasAnyDis = true;
				break;
			}
		}
		if (!hasAnyDis) return true;
		const remGen: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
		for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
			remGen[c] = Math.max(0, simPool[c] - disPool[c]);
		}
		for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
			let need = req.colored[c] ?? 0;
			const takeDis = Math.min(disPool[c], need);
			need -= takeDis;
			if (need > 0) {
				if (remGen[c] < need) return false;
				remGen[c] -= need;
			}
		}
		const availGen = (['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]).reduce((sum, c) => sum + remGen[c], 0);
		return availGen >= req.generic;
	};
	// --- Track P11 ---
	let simSnow = initialSnow;
	const permSnow = new Map<string, number>();
	// --- End Track P11 ---
	// --- Track P20b ---
	const simSourcePools = initP20bSimSourcePools(player);
	const permSourceFlags = new Map<string, ReturnType<typeof permanentManaSourceFlagsP20b>>();
	// --- End Track P20b ---
	const cmdIdentity = getPlayerCommanderIdentity(player);

	const getProducedAmount = (
		perm: CardInstance,
		prodAmount: number,
		ab?: EffectiveActivatedAbility
	): number => H().getDynamicManaProducedAmount(state, player, perm, prodAmount, ab);
	const autoMana = new Map<string, EffectiveActivatedAbility[]>();
	const manaAbilitiesOf = (perm: CardInstance) => {
		let abs = autoMana.get(perm.instanceId);
		if (!abs) {
			abs = autoTapManaAbilities(state, player, perm, cmdIdentity, spendCtx);
			autoMana.set(perm.instanceId, abs);
		}
		return abs;
	};
	// --- Track P20b ---
	const permMatchesP20bSourceKind = (c: CardInstance): boolean => {
		const kind = spendCtx.manaSourceSpendKind;
		if (!kind) return true;
		if (kind === 'chosenColor') {
			const col = spendCtx.manaSourceChosenColor;
			return col ? manaAbilitiesOf(c).some((a) => a.producesMana.includes(col)) : false;
		}
		if (kind === 'snow') return (permSnow.get(c.instanceId) ?? 0) === 1;
		const flags = permSourceFlags.get(c.instanceId);
		if (!flags) return false;
		return kind === 'creature'
			? flags.isCreature
			: kind === 'basicLand'
				? flags.isBasicLand
				: flags.isTreasure;
	};
	// --- End Track P20b ---
	const permCostTier = (perm: CardInstance): number => {
		const abs = manaAbilitiesOf(perm);
		return abs.some((a) => isTapOnlyManaCost(activatedAbilityCost(perm.card, a).defs)) ? 0 : 1;
	};
	const permFreezes = (perm: CardInstance): number =>
		manaAbilitiesOf(perm).every((a) => a.freezesSelfUntap) ? 1 : 0;

	// Sort untapped mana sources: {T}-only before sacrifice-self (and tokens before nontokens when sacrificing),
	// pain-free {T} sources before depletion-freezing {T} sources, restricted sources before unrestricted sources,
	// then most-constrained (fewest colors) first, then non-creatures before creatures.
	// Read-only scan: validate the layer cache once (Phase 6c).
	const candidates = withStableLayerInputs(state, () => {
		const filtered = player.battlefield.filter((perm) => {
			if (perm.phasedOut) return false;
			if (reservedTapIds?.has(perm.instanceId)) return false;
			const ok = manaAbilitiesOf(perm).length > 0;
			// --- Track P11 ---
			if (ok) permSnow.set(perm.instanceId, isSnowPermanent(state, perm) ? 1 : 0);
			// --- End Track P11 ---
			// --- Track P20b ---
			if (ok) permSourceFlags.set(perm.instanceId, permanentManaSourceFlagsP20b(state, perm));
			// --- End Track P20b ---
			return ok;
		});
		return filtered.sort((a, b) => {
			// --- Track P20b ---
			if (spendCtx.manaSourceSpendKind) {
				const ma = permMatchesP20bSourceKind(a) ? 0 : 1;
				const mb = permMatchesP20bSourceKind(b) ? 0 : 1;
				if (ma !== mb) return ma - mb;
			}
			// --- End Track P20b ---
			const ta = permCostTier(a);
			const tb = permCostTier(b);
			if (ta !== tb) return ta - tb;
			if (ta === 0) {
				const fa = permFreezes(a);
				const fb = permFreezes(b);
				if (fa !== fb) return fa - fb;
			}
			if (ta === 1) {
				const aNonToken = a.isToken ? 0 : 1;
				const bNonToken = b.isToken ? 0 : 1;
				if (aNonToken !== bNonToken) return aNonToken - bNonToken;
			}
			const aRestr =
				manaAbilitiesOf(a)[0]?.manaRestriction ||
				// --- Track P10 ---
				manaAbilitiesOf(a)[0]?.manaRestrictionSpec
					? 0
					: 1;
			const bRestr =
				manaAbilitiesOf(b)[0]?.manaRestriction || manaAbilitiesOf(b)[0]?.manaRestrictionSpec
					? 0
					: 1;
			// --- End Track P10 ---
			if (aRestr !== bRestr) return aRestr - bRestr;
			const ca = manaAbilitiesOf(a)[0]?.producesMana ?? [];
			const cb = manaAbilitiesOf(b)[0]?.producesMana ?? [];
			if (ca.length !== cb.length) {
				return ca.length - cb.length;
			}
			// --- Track P11: When {S} is not required, prefer non-snow sources before snow sources ---
			if (snowReq === 0) {
				const sa = permSnow.get(a.instanceId) ?? 0;
				const sb = permSnow.get(b.instanceId) ?? 0;
				if (sa !== sb) return sa - sb;
			}
			// --- End Track P11 ---
			const aIsCreature = evaluatePermanent(state, a).isCreature ? 1 : 0;
			const bIsCreature = evaluatePermanent(state, b).isCreature ? 1 : 0;
			return aIsCreature - bIsCreature;
		});
	});

	const tappedSet = new Set<string>();
	let availableEnergy = player.energyCounters || 0;
	const abilityEnergyCost = (perm: CardInstance, ab: EffectiveActivatedAbility | undefined): number =>
		ab ? (manaCostPayEnergyAmount(activatedAbilityCost(perm.card, ab).defs) ?? 0) : 0;
	const manaChoices = new Map<
		string,
		{
			color: ManaColor;
			amount: number;
			bundle?: ManaColor[];
			ab: EffectiveActivatedAbility | undefined;
		}
	>();

	const applyChosenAbilityToPool = (
		perm: CardInstance,
		ab: EffectiveActivatedAbility | undefined,
		preferredCol?: ManaColor
	) => {
		const baseAmt = ab ? Math.max(0, ab.producesAmount) : 1;
		const amount = getProducedAmount(perm, baseAmt, ab);
		// --- Track P20a ---
		const abDefs = ab ? activatedAbilityCost(perm.card, ab).defs : [{ k: 'tapSelf' as const }];
		const tapMult = abDefs.some((d) => d.k === 'tapSelf')
			? getTapForManaMultiplier(state, player.playerId, perm)
			: 1;
		// --- End Track P20a ---
		availableEnergy -= abilityEnergyCost(perm, ab);
		tappedSet.add(perm.instanceId);
		const disallowsGen = Boolean(ab?.manaRestrictionSpec?.disallowGeneric);
		// --- Track P11 ---
		const addsSnow = !ab?.manaRestriction && permSnow.get(perm.instanceId) === 1;
		// --- End Track P11 ---
		// --- Track P20b ---
		const addsP20bSource = !ab?.manaRestriction && !ab?.manaRestrictionSpec;
		const srcFlags = permSourceFlags.get(perm.instanceId);
		const recordSimSource = (col: ManaColor, amt: number): void => {
			if (!addsP20bSource || amt <= 0) return;
			if (srcFlags?.isCreature) {
				simSourcePools.creature[col] = (simSourcePools.creature[col] ?? 0) + amt;
			}
			if (srcFlags?.isBasicLand) {
				simSourcePools.basicLand[col] = (simSourcePools.basicLand[col] ?? 0) + amt;
			}
			if (addsSnow) {
				simSourcePools.snow[col] = (simSourcePools.snow[col] ?? 0) + amt;
			}
			if (srcFlags?.isTreasure) {
				simSourcePools.treasure[col] = (simSourcePools.treasure[col] ?? 0) + amt;
			}
		};
		// --- End Track P20b ---
		if (ab?.manaBundles && ab.manaBundles.length > 0) {
			const eligibleBundles = preferredCol
				? ab.manaBundles.filter((b) => b.includes(preferredCol))
				: ab.manaBundles;
			const bundle = pickBestBundleForRequirement(
				eligibleBundles.length > 0 ? eligibleBundles : ab.manaBundles,
				pool,
				manaReq,
				preferredCol
			);
			for (const c of bundle) {
				pool[c] += tapMult;
				if (disallowsGen) disallowedGenericSimPool[c] += tapMult;
				// --- Track P20b ---
				recordSimSource(c, tapMult);
				// --- End Track P20b ---
			}
			// --- Track P11 ---
			if (addsSnow) simSnow += bundle.length * tapMult;
			// --- End Track P11 ---
			manaChoices.set(perm.instanceId, {
				color: bundle[0] ?? preferredCol ?? 'C',
				amount: bundle.length,
				bundle,
				ab
			});
			return;
		}
		if (ab?.manaCombinationColors) {
			const allowed =
				ab.manaCombinationColors === 'any' ? FIVE_MANA_COLORS : ab.manaCombinationColors;
			const bundle = pickCombinationForRequirement(
				allowed,
				amount,
				pool,
				manaReq,
				preferredCol,
				player
			);
			for (const c of bundle) {
				pool[c] += tapMult;
				if (disallowsGen) disallowedGenericSimPool[c] += tapMult;
				// --- Track P20b ---
				recordSimSource(c, tapMult);
				// --- End Track P20b ---
			}
			// --- Track P11 ---
			if (addsSnow) simSnow += bundle.length * tapMult;
			// --- End Track P11 ---
			manaChoices.set(perm.instanceId, {
				color: bundle[0] ?? preferredCol ?? 'C',
				amount: bundle.length,
				bundle,
				ab
			});
			return;
		}
		const chosenColor: ManaColor = preferredCol ?? ab?.producesMana[0] ?? 'C';
		pool[chosenColor] += amount * tapMult;
		if (disallowsGen) disallowedGenericSimPool[chosenColor] += amount * tapMult;
		// --- Track P11 ---
		if (addsSnow) simSnow += amount * tapMult;
		// --- End Track P11 ---
		// --- Track P20b ---
		recordSimSource(chosenColor, amount * tapMult);
		// --- End Track P20b ---
		manaChoices.set(perm.instanceId, { color: chosenColor, amount, ab });
	};

	let greedySucceeded = true;

	// Pass 1: Satisfy missing colored mana pips using the most-constrained sources first.
	// Any remaining Phyrexian symbol not already converted to life must be paid with its primaryColor.
	for (const col of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
		const flexCountForCol =
			manaReq.flexibleSymbols?.filter((s) => s.primaryColor === col && !s.altLife).length ?? 0;
		while (pool[col] < manaReq.colored[col]) {
			const perm =
				candidates.find((c) => {
					if (tappedSet.has(c.instanceId) || !permMatchesP20bSourceKind(c)) return false;
					return manaAbilitiesOf(c).some(
						(a) =>
							!a.freezesSelfUntap &&
							a.producesMana.includes(col) &&
							abilityEnergyCost(c, a) <= availableEnergy
					);
				}) ??
				candidates.find((c) => {
					if (tappedSet.has(c.instanceId) || !permMatchesP20bSourceKind(c)) return false;
					return manaAbilitiesOf(c).some(
						(a) => a.producesMana.includes(col) && abilityEnergyCost(c, a) <= availableEnergy
					);
				});
			if (!perm) {
				if (manaReq.colored[col] - pool[col] <= flexCountForCol) {
					break;
				}
				greedySucceeded = false;
				break;
			}
			const matchedAb =
				manaAbilitiesOf(perm).find(
					(a) =>
						!a.freezesSelfUntap &&
						a.producesMana.includes(col) &&
						abilityEnergyCost(perm, a) <= availableEnergy
				) ??
				manaAbilitiesOf(perm).find(
					(a) => a.producesMana.includes(col) && abilityEnergyCost(perm, a) <= availableEnergy
				);
			applyChosenAbilityToPool(perm, matchedAb, col);
		}
		if (!greedySucceeded) break;
	}

	// --- Track P11: Pass 1.5 satisfy {S} snow mana pips using Snow sources (CR 107.4h) ---
	for (let snowGuard = 0; greedySucceeded && snowGuard < 64 && simSnow < snowReq; snowGuard++) {
		const perm =
			candidates.find(
				(c) =>
					!tappedSet.has(c.instanceId) &&
					permSnow.get(c.instanceId) === 1 &&
					manaAbilitiesOf(c).some(
						(a) =>
							!a.manaRestriction &&
							!a.freezesSelfUntap &&
							abilityEnergyCost(c, a) <= availableEnergy
					)
			) ??
			candidates.find(
				(c) =>
					!tappedSet.has(c.instanceId) &&
					permSnow.get(c.instanceId) === 1 &&
					manaAbilitiesOf(c).some(
						(a) => !a.manaRestriction && abilityEnergyCost(c, a) <= availableEnergy
					)
			);
		if (!perm) {
			greedySucceeded = false;
			break;
		}
		const abSnow =
			manaAbilitiesOf(perm).find(
				(a) =>
					!a.manaRestriction &&
					!a.freezesSelfUntap &&
					abilityEnergyCost(perm, a) <= availableEnergy
			) ??
			manaAbilitiesOf(perm).find(
				(a) => !a.manaRestriction && abilityEnergyCost(perm, a) <= availableEnergy
			);
		applyChosenAbilityToPool(perm, abSnow);
	}
	// --- End Track P11 ---

	// Pass 2: Satisfy remaining generic / non-Phyrexian flexible mana cost using remaining untapped sources
	for (
		let pass2Guard = 0;
		greedySucceeded &&
		pass2Guard < 128 &&
		!(
			canPayManaCost(pool, manaReq, undefined, snowReq > 0 ? simSnow : undefined) &&
			simCanPayWithDisallow(pool, disallowedGenericSimPool, manaReq)
		);
		pass2Guard++
	) {
		const perm =
			candidates.find(
				(c) =>
					!tappedSet.has(c.instanceId) &&
					permMatchesP20bSourceKind(c) &&
					manaAbilitiesOf(c).some(
						(a) => !a.freezesSelfUntap && !a.manaRestrictionSpec?.disallowGeneric && abilityEnergyCost(c, a) <= availableEnergy
					)
			) ??
			candidates.find(
				(c) =>
					!tappedSet.has(c.instanceId) &&
					permMatchesP20bSourceKind(c) &&
					manaAbilitiesOf(c).some((a) => !a.manaRestrictionSpec?.disallowGeneric && abilityEnergyCost(c, a) <= availableEnergy)
			);
		if (!perm) {
			greedySucceeded = false;
			break;
		}
		const ab0 =
			manaAbilitiesOf(perm).find(
				(a) => !a.freezesSelfUntap && abilityEnergyCost(perm, a) <= availableEnergy
			) ?? manaAbilitiesOf(perm).find((a) => abilityEnergyCost(perm, a) <= availableEnergy);
		applyChosenAbilityToPool(
			perm,
			ab0,
			pickP20bPreferredColorForPass2(pool, manaReq, spendCtx, ab0)
		);
	}

	// --- Track P20b: Satisfy X-mana color & source-kind spending restrictions (CR 107.3i, CR 106.6) ---
	for (
		let p20bGuard = 0;
		greedySucceeded &&
		p20bGuard < 64 &&
		!canSatisfyP20bManaSpendRestrictions(pool, manaReq, spendCtx, simSourcePools, (subPool, req) =>
			canPayManaCost(subPool, req)
		);
		p20bGuard++
	) {
		const perm = candidates.find((c) => {
			if (tappedSet.has(c.instanceId) || !permMatchesP20bSourceKind(c)) return false;
			return manaAbilitiesOf(c).some(
				(a) =>
					abilityEnergyCost(c, a) <= availableEnergy &&
					(spendCtx.manaSourceSpendKind
						? !a.manaRestriction && !a.manaRestrictionSpec
						: pickP20bPreferredColorForPass2(pool, manaReq, spendCtx, a) !== undefined)
			);
		});
		if (!perm) {
			greedySucceeded = false;
			break;
		}
		const abP20b =
			manaAbilitiesOf(perm).find(
				(a) =>
					!a.freezesSelfUntap &&
					abilityEnergyCost(perm, a) <= availableEnergy &&
					(spendCtx.manaSourceSpendKind
						? !a.manaRestriction && !a.manaRestrictionSpec
						: pickP20bPreferredColorForPass2(pool, manaReq, spendCtx, a) !== undefined)
			) ??
			manaAbilitiesOf(perm).find(
				(a) =>
					abilityEnergyCost(perm, a) <= availableEnergy &&
					(spendCtx.manaSourceSpendKind
						? !a.manaRestriction && !a.manaRestrictionSpec
						: pickP20bPreferredColorForPass2(pool, manaReq, spendCtx, a) !== undefined)
			);
		applyChosenAbilityToPool(
			perm,
			abP20b,
			pickP20bPreferredColorForPass2(pool, manaReq, spendCtx, abP20b)
		);
	}
	// --- End Track P20b ---

	if (greedySucceeded && !simCanPayWithDisallow(pool, disallowedGenericSimPool, manaReq)) {
		greedySucceeded = false;
	}

	if (!greedySucceeded) {
		if (filterDepth >= 2) return false;
		const clonePlayerMana = (p: PlayerGameState): PlayerGameState => ({
			...p,
			manaPool: { ...p.manaPool },
			// --- Track P11 ---
			snowManaByColor: p.snowManaByColor ? { ...p.snowManaByColor } : undefined,
			// --- End Track P11 ---
			// --- Track P20b ---
			creatureManaByColor: p.creatureManaByColor ? { ...p.creatureManaByColor } : undefined,
			basicLandManaByColor: p.basicLandManaByColor ? { ...p.basicLandManaByColor } : undefined,
			treasureManaByColor: p.treasureManaByColor ? { ...p.treasureManaByColor } : undefined,
			// --- End Track P20b ---
			restrictedMana: p.restrictedMana
				? Object.fromEntries(
						Object.entries(p.restrictedMana).map(([k, v]) => [k, v ? { ...v } : v])
					)
				: undefined,
			// --- Track P10 ---
			restrictedManaBuckets: p.restrictedManaBuckets
				? p.restrictedManaBuckets.map((b) => ({ ...b, pool: { ...b.pool } }))
				: undefined,
			retainedManaCounts: p.retainedManaCounts ? { ...p.retainedManaCounts } : undefined
			// --- End Track P10 ---
		});
		const abilitySpendCtx: ManaSpendContext = {
			isSpell: false,
			// --- Track P10 ---
			isActivatedAbility: true
			// --- End Track P10 ---
		};

		for (const fPerm of player.battlefield) {
			if (fPerm.phasedOut || fPerm.tapped || reservedTapIds?.has(fPerm.instanceId)) continue;
			if (!checkGlobalAbilityActivationRestrictions(state, player.playerId, fPerm, true).ok) continue;
			for (const fAb of getEffectiveActivatedAbilities(state, player, fPerm, cmdIdentity)) {
				if (!fAb.isManaAbility || fAb.producesMana.length === 0) continue;
				// --- Track P21 (CR 605.3c): Never auto-tap "Activate only as an instant" mana abilities ---
				if (fAb.activationRestrictions?.includes('onlyAsInstant')) continue;
				// --- End Track P21 ---
				if (fAb.manaRestriction && !canSpendRestrictedMana(fAb.manaRestriction, spendCtx)) {
					continue;
				}
				// --- Track P10 ---
				if (fAb.manaRestrictionSpec && !canSpendManaRestrictionSpec(fAb.manaRestrictionSpec, spendCtx)) {
					continue;
				}
				const fAddOpts = H().p10AddManaOptions(fAb);
				// --- End Track P10 ---
				if (!H().checkActivationRestrictionsOnly(state, player.playerId, fPerm, fAb).ok) continue;
				const fDefs = activatedAbilityCost(fPerm.card, fAb).defs;
				if (isTapOnlyManaCost(fDefs)) continue;
				if (
					!fDefs.some((d) => d.k === 'tapSelf') ||
					!fDefs.every((d) => d.k === 'tapSelf' || d.k === 'mana')
				) {
					continue;
				}
				const inReq = parseManaCost(fAb.manaCost === '{0}' ? '' : fAb.manaCost);
				const inTotal = inReq.totalCmc;
				if (inTotal < 1 || inTotal > 2) continue;
				// --- Track P10 ---
				const filterInputSpendCtx = H().activatedAbilitySpendContext(state, fPerm, fAb);
				// --- End Track P10 ---

				const fAmt = getProducedAmount(fPerm, Math.max(0, fAb.producesAmount), fAb);
				if (fAmt <= 0) continue;
				let outBundles: ManaColor[][];
				if (fAb.manaBundles && fAb.manaBundles.length > 0) {
					outBundles = fAb.manaBundles.map((b) => [...b]);
				} else if (fAb.manaCombinationColors) {
					const allowed =
						fAb.manaCombinationColors === 'any' ? FIVE_MANA_COLORS : fAb.manaCombinationColors;
					outBundles =
						fAmt <= 4
							? expandCombinationBundles(allowed, fAmt)
							: [pickCombinationForRequirement(allowed, fAmt, initialPool, manaReq, undefined, player)];
				} else {
					outBundles = fAb.producesMana.map((c) => Array(fAmt).fill(c) as ManaColor[]);
				}
				outBundles.sort(
					(x, y) =>
						scoreBundleForRequirement(initialPool, y, manaReq) -
						scoreBundleForRequirement(initialPool, x, manaReq)
				);

				// Way A: pay Filter-land input from existing floating mana pool
				if (canPayManaCost(combinedManaPoolForSpend(player, filterInputSpendCtx), inReq)) {
					for (const bundle of outBundles) {
						const sim = clonePlayerMana(player);
						deductManaForSpendContext(sim, inReq, filterInputSpendCtx);
						for (const c of bundle) addManaToPlayerPool(sim, c, 1, fAb.manaRestriction, fAddOpts);
						const nextReserved = new Set<string>([...(reservedTapIds ?? []), fPerm.instanceId]);
						if (
							simulateOrExecuteManaOnly(
								sim,
								manaReq,
								state,
								false,
								lifeToPay,
								spendCtx,
								nextReserved,
								filterDepth + 1
							)
						) {
							if (!mutate) return true;
							deductManaForSpendContext(player, inReq, filterInputSpendCtx);
							tapPermanent(state, fPerm);
							resolveActivatedManaAbility(
								state,
								player,
								fPerm,
								fAb,
								bundle[0],
								bundle.length,
								true,
								bundle
							);
							return simulateOrExecuteManaOnly(
								player,
								manaReq,
								state,
								true,
								lifeToPay,
								spendCtx,
								nextReserved,
								filterDepth + 1
							);
						}
					}
				}

				// Way B: tap one {T}-only feeder source to pay Filter-land input
				for (const feeder of candidates) {
					if (feeder.instanceId === fPerm.instanceId) continue;
					for (const feedAb of manaAbilitiesOf(feeder)) {
						if (
							feedAb.manaRestriction ||
							// --- Track P10 ---
							(feedAb.manaRestrictionSpec &&
								!canSpendManaRestrictionSpec(feedAb.manaRestrictionSpec, filterInputSpendCtx))
							// --- End Track P10 ---
						) {
							continue;
						}
						const feedDefs = activatedAbilityCost(feeder.card, feedAb).defs;
						if (!isTapOnlyManaCost(feedDefs)) continue;
						const feedAmt = getProducedAmount(
							feeder,
							Math.max(0, feedAb.producesAmount),
							feedAb
						);
						if (feedAmt <= 0) continue;
						const feedAddOpts = H().p10AddManaOptions(feedAb);
						const feedOutputs: Array<{ color: ManaColor; amount: number; bundle?: ManaColor[] }> =
							feedAb.manaBundles && feedAb.manaBundles.length > 0
								? feedAb.manaBundles.map((b) => ({
										color: b[0] ?? 'C',
										amount: b.length,
										bundle: [...b]
									}))
								: feedAb.producesMana.map((c) => ({ color: c, amount: feedAmt }));
						for (const fo of feedOutputs) {
							const simAfterFeed = clonePlayerMana(player);
							if (fo.bundle) {
								for (const c of fo.bundle) addManaToPlayerPool(simAfterFeed, c, 1, undefined, feedAddOpts);
							} else {
								addManaToPlayerPool(simAfterFeed, fo.color, fo.amount, undefined, feedAddOpts);
							}
							if (
								!canPayManaCost(
									combinedManaPoolForSpend(simAfterFeed, filterInputSpendCtx),
									inReq
								)
							) {
								continue;
							}
							deductManaForSpendContext(simAfterFeed, inReq, filterInputSpendCtx);
							const nextReserved = new Set<string>([
								...(reservedTapIds ?? []),
								fPerm.instanceId,
								feeder.instanceId
							]);
							for (const bundle of outBundles) {
								const sim2 = clonePlayerMana(simAfterFeed);
								for (const c of bundle) addManaToPlayerPool(sim2, c, 1, fAb.manaRestriction, fAddOpts);
								if (
									simulateOrExecuteManaOnly(
										sim2,
										manaReq,
										state,
										false,
										lifeToPay,
										spendCtx,
										nextReserved,
										filterDepth + 1
									)
								) {
									if (!mutate) return true;
									tapPermanent(state, feeder);
									resolveActivatedManaAbility(
										state,
										player,
										feeder,
										feedAb,
										fo.color,
										fo.amount,
										true,
										fo.bundle
									);
									deductManaForSpendContext(player, inReq, filterInputSpendCtx);
									tapPermanent(state, fPerm);
									resolveActivatedManaAbility(
										state,
										player,
										fPerm,
										fAb,
										bundle[0],
										bundle.length,
										true,
										bundle
									);
									return simulateOrExecuteManaOnly(
										player,
										manaReq,
										state,
										true,
										lifeToPay,
										spendCtx,
										nextReserved,
										filterDepth + 1
									);
								}
							}
						}
					}
				}
			}
		}
		return false;
	}

	if (mutate) {
		for (const perm of candidates) {
			const choice = manaChoices.get(perm.instanceId);
			if (choice) {
				const defs = choice.ab ? activatedAbilityCost(perm.card, choice.ab).defs : [{ k: 'tapSelf' as const }];
				const tappedSource = defs.some((d) => d.k === 'tapSelf');
				if (defs.some((d) => d.k === 'sacrifice' || d.k === 'payEnergy')) {
					const ctx = H().costContext(state, player, perm, 0, false, null);
					const plan = planCosts(ctx, defs);
					if (!plan.ok || plan.question) return false;
					payPlannedCosts(ctx, plan);
				} else {
					tapPermanent(state, perm);
				}
				resolveActivatedManaAbility(
					state,
					player,
					perm,
					choice.ab,
					choice.color,
					choice.amount,
					tappedSource,
					choice.bundle
				);
			}
		}
		// --- Track P11 ---
		deductManaForSpendContextWithSnow(player, manaReq, spendCtx);
		// --- End Track P11 ---
		if (lifeToPay > 0) {
			player.life -= lifeToPay;
			// --- Track P10 ---
			player.lostLifeThisTurn = true;
			noteLayerInputsChanged(state);
			// --- End Track P10 ---
			// --- Track P12 ---
			recordPlayerLifeLossWave4(player, lifeToPay);
			// --- End Track P12 ---
			// --- Track P15: Compleated life-paid tracking (CR 702.150a) & Speed trigger (CR 702.178b) ---
			spendCtx.capturedPhyrexianLifePaidCount =
				(spendCtx.capturedPhyrexianLifePaidCount ?? 0) + Math.floor(lifeToPay / 2);
			onPlayerLostLifeCheckSpeedTrigger(state, player.playerId, lifeToPay);
			// --- End Track P15 ---
		}
	}

	return true;
}

function simulateOrExecuteAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState,
	mutate: boolean,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>
): boolean {
	const phySymbols = req.flexibleSymbols?.filter((s) => s.altLife) ?? [];
	if (phySymbols.length === 0) {
		return simulateOrExecuteManaOnly(player, req, state, mutate, 0, spendCtx, reservedTapIds);
	}

	// --- Track P11 ---
	const canPayLife = !playerCantPayLifeForCost(state, player, 2);
	// --- End Track P11 ---
	const maxLifeCount = canPayLife ? Math.min(phySymbols.length, Math.floor(player.life / 2)) : 0;

	if (phyrexianLifeCount !== undefined) {
		if (phyrexianLifeCount < 0 || phyrexianLifeCount > phySymbols.length) {
			return false;
		}
		const { manaReq, lifeToPay } = applyPhyrexianLifeChoice(req, phyrexianLifeCount);
		return simulateOrExecuteManaOnly(player, manaReq, state, mutate, lifeToPay, spendCtx, reservedTapIds);
	}

	// Bot heuristic: pay Phyrexian symbols with life while life > 10; otherwise prefer mana and only
	// fall back to life when mana cannot cover the colored symbols.
	let preferredK = 0;
	if (player.isBot) {
		while (preferredK < maxLifeCount && player.life - 2 * preferredK > 10) {
			preferredK += 1;
		}
	}
	const kOrder: number[] = [];
	for (let k = preferredK; k >= 0; k--) kOrder.push(k);
	for (let k = preferredK + 1; k <= maxLifeCount; k++) kOrder.push(k);

	for (const k of kOrder) {
		const { manaReq, lifeToPay } = applyPhyrexianLifeChoice(req, k);
		if (simulateOrExecuteManaOnly(player, manaReq, state, false, lifeToPay, spendCtx, reservedTapIds)) {
			return mutate
				? simulateOrExecuteManaOnly(player, manaReq, state, true, lifeToPay, spendCtx, reservedTapIds)
				: true;
		}
	}
	return false;
}

export function canPayOrAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>
): boolean {
	return simulateOrExecuteAutoTap(player, req, state, false, phyrexianLifeCount, spendCtx, reservedTapIds);
}

export function payManaWithAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>
): boolean {
	return simulateOrExecuteAutoTap(player, req, state, true, phyrexianLifeCount, spendCtx, reservedTapIds);
}
