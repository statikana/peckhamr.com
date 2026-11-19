import { compileCard, getAbilityModal } from '../compiler/index.ts';
import type { CostDef, TargetSpec } from '../ir.ts';
import { type ManaCostRequirement, parseManaCost } from '../oracle.ts';
import {
	checkGlobalCastPermissionsAndRestrictions,
	evaluatePermanent,
	getCardActivatedAbilities,
	getSpellTargetRequirement,
	permanentHasLostAllAbilities,
	targetRequirementFromSpecs
} from '../ruleTree.ts';
import { activeFaceIndexForObject, effectiveCardForObject, getCardFaces } from '../scryfall.ts';
import type {
	CardInstance,
	CastOption,
	CostPayment,
	EffectiveActivatedAbility,
	GamePhase,
	GameState,
	LandPlayOption,
	ManaColor,
	PendingCostPayment,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	TargetRef,
	TargetRequirementInfo,
	ZoneType
} from '../types.ts';
import { getEffectiveCardForPermanent } from './copyPreventionAndEffects.ts';
import {
	activatedAbilityCost,
	applyCastCostAids,
	canPayCosts,
	chooseCostPayment,
	effectiveAbilityManaCost,
	expandOptionalAdditionalCosts,
	getObjectKickerInfo,
	isCastConditionMet,
	planCosts,
	spellCastRestrictions,
	validateOptionalCostCounts
} from './costs.ts';
import {
	cardUsesP20bCostPaidCount,
	computeMaxAvailableP20bPitchCounts,
	getCommanderTaxLifeCostP20b
} from './costsWave7.ts';
import { partitionMultiTargetsBacktracking, playerHasP16aFlashGrantForTypes } from './effectsWave6.ts';
import { matchesP19aStackTargetSpec } from './effectsWave7.ts';
import {
	addLog,
	type CastableSourceZone,
	describeTurnUpCost,
	findCardAnywhere,
	findPermanentOnBoard,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity,
	H,
	hasKeyword,
	matchesPermanentTypeFilter,
	optionTargetsBecomeEach,
	resetTriggerLoopTracking
} from './engineHost.ts';
import { emitEvent } from './events.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	matchesColorFilter,
	resolveObjectFaces,
	stackItemFaceOptions
} from './faces.ts';
import { checkWave5AbilityActivation } from './framesBattlesAndKeywordsWave5.ts';
import {
	checkTimingRestrictionKind,
	collectSelfCastRestrictions,
	findPayableOfferingCandidates,
	getEffectiveUsedModalModes,
	isMeldedPermanent
} from './framesModalsWave6.ts';
import { findCastWhileSearchingLibraryCard, selectCraftShareCardTypeMaterials } from './framesWave7.ts';
import {
	canPlayGraveyardLandViaMayhem,
	computeModalModeAdditionalCosts,
	findPayableEmergeCandidates,
	findPayableHarmonizeOptions,
	stackSpellWithSplitSecond
} from './keywordsWave4.ts';
import { hasChooseAllModesOptionalCost, isConditionMetWithKicker } from './kicker.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import { evaluateCondition, type FilterContext, matchesObjectFilter } from './objectFilter.ts';
import {
	checkGlobalAbilityActivationRestrictions,
	playerHasHexproofFrom as replacePlayerHasHexproofFrom,
	playerHasShroud as replacePlayerHasShroud
} from './replace.ts';
import {
	doesProtectionQualityMatchSource,
	getWave5SlottedLandPlayPermission,
	isAttachmentExemptFromProtectionGrant
} from './staticsAndCostsWave5.ts';
import { boardHasAnyChosenCardName, isSpellBannedByChosenName } from './staticsDynamicAndCosts.ts';
import { getActiveZoneLandPlayPermissionSource } from './staticsLayersAndRestrictions.ts';
import {
	adjustCostDefsForCrewSaddleVirtualPower,
	checkWave6CostPaymentLocks,
	getRequiredFlagbearerIdsForActor,
	validateFlagbearerTargets
} from './staticsWave6.ts';
import { isGraveyardTargetingBlocked, isPermanentBlockedByCantBeTargetedBy } from './staticsWave7.ts';
import {
	checkLandPlayLocksWave8,
	computeExtraLandPlaysWave8,
	playerProtectedFromSourceWave8
} from './staticsWave8.ts';
import {
	hasFirstMatchingSpellFlashWave9,
	hasWave9ExileLandPlayPermission,
	playerIgnoresOpponentHexproofWave9
} from './staticsWave9.ts';
import { flushTriggers } from './triggers.ts';

function sourceEffectiveQualities(
	state: GameState,
	sCard: ScryfallCard,
	sPerm?: CardInstance
): { colors: ManaColor[]; typeLine: string } {
	const evalSource =
		sPerm && sPerm.zone === 'battlefield' && !sPerm.phasedOut
			? evaluatePermanent(state, sPerm)
			: null;
	if (evalSource) {
		return {
			colors: sPerm!.isFaceDown ? [] : evalSource.colors,
			typeLine: evalSource.typeLine
		};
	}
	const offFace = resolveObjectFaces(sCard, sPerm ? instanceFaceOptions(sPerm) : undefined);
	return { colors: offFace.colors, typeLine: offFace.typeLine };
}

export function hasProtectionFrom(
	targetPerm: CardInstance,
	sourceCard: ScryfallCard | undefined,
	state: GameState,
	sourcePerm?: CardInstance,
	// --- Track P14 ---
	isAttachmentCheck = false,
	// --- End Track P14 ---
	// --- Track P20a ---
	sourceControllerId?: string
	// --- End Track P20a ---
): boolean {
	if (!sourceCard || targetPerm.phasedOut) return false;
	const evalTarget = evaluatePermanent(state, targetPerm);
	const combined = evalTarget.activeKeywords.map((k) => k.toLowerCase()).join('\n');
	// --- Track P20a ---
	const hasPlayerProt = Boolean(evalTarget.protectionFromPlayerIds?.length);
	if (!combined.includes('protection from') && !hasPlayerProt) return false;
	const effSrcCtrl =
		sourceControllerId ??
		(sourcePerm
			? sourcePerm.zone === 'battlefield' && !sourcePerm.phasedOut
				? evaluatePermanent(state, sourcePerm).controllerId
				: sourcePerm.controllerId
			: undefined);
	// --- End Track P20a ---

	const { colors: srcColors, typeLine: srcTypeLine } = sourceEffectiveQualities(
		state,
		sourceCard,
		sourcePerm
	);

	// --- Track P14: CR 702.16n, 702.16p per-grant attachment exemption ---
	if (isAttachmentCheck && sourcePerm) {
		for (let i = 0; i < evalTarget.breakdown.items.length; i++) {
			const it = evalTarget.breakdown.items[i];
			if (it.removed || it.kind !== 'keyword') continue;
			if (isAttachmentExemptFromProtectionGrant(sourcePerm, state, it.protectionExemption)) {
				continue;
			}
			// --- Track P20a: CR 702.16j protection from chosen player ---
			if (it.protectedFromPlayerId && effSrcCtrl && it.protectedFromPlayerId === effSrcCtrl) {
				return true;
			}
			// --- End Track P20a ---
			if (doesProtectionQualityMatchSource(it.name.toLowerCase(), srcColors, srcTypeLine)) {
				return true;
			}
		}
		return false;
	}
	// --- End Track P14 ---

	// --- Track P20a: CR 702.16j protection from chosen player ---
	if (effSrcCtrl && evalTarget.protectionFromPlayerIds?.includes(effSrcCtrl)) {
		return true;
	}
	// --- End Track P20a ---

	if (/protection from everything/i.test(combined)) return true;
	if (/protection from all colors/i.test(combined) && srcColors.length > 0) return true;
	if (/protection from multicolored/i.test(combined) && srcColors.length >= 2) return true;
	if (/protection from monocolored/i.test(combined) && srcColors.length === 1) return true;
	if (/protection from colorless/i.test(combined) && srcColors.length === 0) return true;
	if (/protection from [^.\n]*\bwhite\b/i.test(combined) && srcColors.includes('W')) return true;
	if (/protection from [^.\n]*\bblue\b/i.test(combined) && srcColors.includes('U')) return true;
	if (/protection from [^.\n]*\bblack\b/i.test(combined) && srcColors.includes('B')) return true;
	if (/protection from [^.\n]*\bred\b/i.test(combined) && srcColors.includes('R')) return true;
	if (/protection from [^.\n]*\bgreen\b/i.test(combined) && srcColors.includes('G')) return true;
	if (/protection from creatures/i.test(combined) && srcTypeLine.includes('Creature')) {
		return true;
	}
	if (/protection from instants/i.test(combined) && srcTypeLine.includes('Instant')) {
		return true;
	}
	if (/protection from sorceries/i.test(combined) && srcTypeLine.includes('Sorcery')) {
		return true;
	}
	if (/protection from artifacts/i.test(combined) && srcTypeLine.includes('Artifact')) {
		return true;
	}
	if (/protection from enchantments/i.test(combined) && srcTypeLine.includes('Enchantment')) {
		return true;
	}
	if (/protection from lands/i.test(combined) && srcTypeLine.includes('Land')) {
		return true;
	}
	if (/protection from planeswalkers/i.test(combined) && srcTypeLine.includes('Planeswalker')) {
		return true;
	}
	// --- Track P22a ---
	if (/protection from battles/i.test(combined) && srcTypeLine.includes('Battle')) {
		return true;
	}
	if (
		/protection from (?:kindred|tribal)/i.test(combined) &&
		(srcTypeLine.includes('Kindred') || srcTypeLine.includes('Tribal'))
	) {
		return true;
	}
	// --- End Track P22a ---

	return false;
}

/** CR 702.11d: "Hexproof from [quality]" prevents spells/abilities with that quality controlled by an opponent from targeting this permanent. */
export function hasHexproofFromQuality(
	targetPerm: CardInstance,
	sourceCard: ScryfallCard | undefined,
	state: GameState,
	sourcePerm?: CardInstance
): boolean {
	if (!sourceCard || targetPerm.phasedOut) return false;
	const evalTarget = evaluatePermanent(state, targetPerm);
	const combined = evalTarget.activeKeywords.map((k) => k.toLowerCase()).join('\n');
	if (!combined.includes('hexproof from')) return false;

	const { colors: srcColors, typeLine: srcTypeLine } = sourceEffectiveQualities(
		state,
		sourceCard,
		sourcePerm
	);

	if (/hexproof from everything/i.test(combined)) return true;
	if (/hexproof from all colors/i.test(combined) && srcColors.length > 0) return true;
	if (/hexproof from multicolored/i.test(combined) && srcColors.length >= 2) return true;
	if (/hexproof from monocolored/i.test(combined) && srcColors.length === 1) return true;
	if (/hexproof from colorless/i.test(combined) && srcColors.length === 0) return true;
	if (/hexproof from [^.\n]*\bwhite\b/i.test(combined) && srcColors.includes('W')) return true;
	if (/hexproof from [^.\n]*\bblue\b/i.test(combined) && srcColors.includes('U')) return true;
	if (/hexproof from [^.\n]*\bblack\b/i.test(combined) && srcColors.includes('B')) return true;
	if (/hexproof from [^.\n]*\bred\b/i.test(combined) && srcColors.includes('R')) return true;
	if (/hexproof from [^.\n]*\bgreen\b/i.test(combined) && srcColors.includes('G')) return true;
	if (/hexproof from creatures/i.test(combined) && srcTypeLine.includes('Creature')) {
		return true;
	}
	if (/hexproof from instants/i.test(combined) && srcTypeLine.includes('Instant')) {
		return true;
	}
	if (/hexproof from sorceries/i.test(combined) && srcTypeLine.includes('Sorcery')) {
		return true;
	}
	if (/hexproof from artifacts/i.test(combined) && srcTypeLine.includes('Artifact')) {
		return true;
	}
	if (/hexproof from enchantments/i.test(combined) && srcTypeLine.includes('Enchantment')) {
		return true;
	}
	if (/hexproof from lands/i.test(combined) && srcTypeLine.includes('Land')) {
		return true;
	}
	if (/hexproof from planeswalkers/i.test(combined) && srcTypeLine.includes('Planeswalker')) {
		return true;
	}

	return false;
}

export function playerHasHexproofFrom(
	state: GameState,
	targetPlayer: PlayerGameState,
	actorId: string
): boolean {
	if (targetPlayer.playerId === actorId) return false;
	if (targetPlayer.protectionFromEverythingThisTurn) return true;
	return replacePlayerHasHexproofFrom(state, targetPlayer, actorId);
}

export function playerHasShroud(state: GameState, targetPlayer: PlayerGameState): boolean {
	if (targetPlayer.protectionFromEverythingThisTurn) return true;
	return replacePlayerHasShroud(state, targetPlayer);
}

function normalizeTargetRequirement(
	reqOrKind: TargetRequirementInfo | string
): TargetRequirementInfo {
	if (typeof reqOrKind === 'object' && reqOrKind !== null && 'targetKind' in reqOrKind) {
		return reqOrKind;
	}
	const kind = (reqOrKind || 'none') as TargetRequirementInfo['targetKind'];
	return {
		requiresTarget: kind !== 'none',
		targetKind: kind,
		minTargets: kind !== 'none' ? 1 : 0,
		maxTargets: kind !== 'none' ? 1 : 0,
		zone:
			kind === 'spell'
				? 'stack'
				: kind === 'graveyard_card'
					? 'graveyard'
					: kind === 'exile_card'
						? 'exile'
						: kind === 'any'
							? 'any'
							: 'battlefield',
		sameGraveyard: false,
		controllerFilter: kind === 'controlled_creature' ? 'you' : 'any',
		cardTypeFilter:
			kind === 'creature' || kind === 'controlled_creature'
				? 'Creature'
				: kind === 'artifact_or_enchantment'
					? 'ArtifactOrEnchantment'
					: kind === 'nonland_permanent'
						? 'NonlandPermanent'
						: kind === 'battle'
							? 'Battle'
							: undefined
	};
}

// --- Precon Bragos Spirit ---
/** CR 115.1: the spell-target view of a "target spell or permanent" requirement (null when no spec allows spells). */
function alsoSpellsStackRequirement(info: TargetRequirementInfo): TargetRequirementInfo | null {
	const specs = info.targetSpecs;
	if (!specs?.some((s) => s.alsoSpells)) return null;
	return {
		...info,
		targetKind: 'spell',
		zone: 'stack',
		stackKind: 'spell',
		controllerFilter: 'any',
		cardTypeFilter: undefined,
		targetSpecs: specs.map((s) =>
			s.alsoSpells ? { ...s, alsoSpells: undefined, kind: 'object', filter: { zone: 'stack', stackKind: 'spell' } } : s
		)
	};
}
// --- End Precon Bragos Spirit ---

/** Whether `target` is legal for the requirement. Read-only, one validation (Phase 6d). */
export function validateTargetLegality(
	state: GameState,
	actorId: string,
	target: TargetRef,
	targetRequirementOrKind: TargetRequirementInfo | string,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	// --- Track P20a + Track P20b ---
	sourceKindHintOrXValue?: 'spell' | 'ability' | number,
	xValueArg?: number
	// --- End Track P20a + Track P20b ---
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		validateTargetLegalityInner(
			state,
			actorId,
			target,
			targetRequirementOrKind,
			sourceCard,
			sourceInstanceId,
			sourceKindHintOrXValue,
			xValueArg
		)
	);
}

function validateTargetLegalityInner(
	state: GameState,
	actorId: string,
	target: TargetRef,
	targetRequirementOrKind: TargetRequirementInfo | string,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	// --- Track P20a + Track P20b ---
	sourceKindHintOrXValue?: 'spell' | 'ability' | number,
	xValueArg?: number
	// --- End Track P20a + Track P20b ---
): { ok: boolean; error?: string } {
	const sourceKindHint: 'spell' | 'ability' | undefined =
		typeof sourceKindHintOrXValue === 'string' ? sourceKindHintOrXValue : undefined;
	const xValue: number | undefined =
		typeof sourceKindHintOrXValue === 'number' ? sourceKindHintOrXValue : xValueArg;
	let info = normalizeTargetRequirement(targetRequirementOrKind);
	// --- Precon Bragos Spirit: CR 115.1 "target spell or permanent" validates stack picks as a spell target ---
	if (target.kind === 'stack' && info.zone !== 'stack') {
		const spellInfo = alsoSpellsStackRequirement(info);
		if (spellInfo) info = spellInfo;
	}
	// --- End Precon Bragos Spirit ---
	const targetKind = info.targetKind;

	// 1. Stack spell or ability target validation
	if (
		target.kind === 'stack' ||
		info.zone === 'stack' ||
		targetKind === 'spell' ||
		targetKind === 'stack'
	) {
		if (
			target.kind !== 'stack' &&
			(info.zone === 'stack' || targetKind === 'spell' || targetKind === 'stack')
		) {
			return {
				ok: false,
				error: 'Strict Rules Violation: This spell or ability must target an object on the Stack.'
			};
		}
		const inStack = state.stack.find(
			(s) => s.id === target.id || (s.kind === 'spell' && s.sourceInstanceId === target.id)
		);
		if (!inStack) return { ok: false, error: 'Target spell or ability is not on the Stack.' };
		const stackSpec = info.targetSpecs?.find(
			(s) =>
				s.kind === 'object' &&
				(s.filter.zone === 'stack' || targetKind === 'spell' || targetKind === 'stack')
		);
		const stackKind = info.stackKind ?? stackSpec?.filter.stackKind ?? 'spell';
		if (stackKind === 'spell' && inStack.kind !== 'spell') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack is an ability, not a spell.'
			};
		}
		if (stackKind === 'ability' && inStack.kind !== 'activated' && inStack.kind !== 'triggered') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack must be an activated or triggered ability.'
			};
		}
		if (stackKind === 'activatedAbility' && inStack.kind !== 'activated') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack must be an activated ability.'
			};
		}
		if (stackKind === 'triggeredAbility' && inStack.kind !== 'triggered') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack must be a triggered ability.'
			};
		}
		if (
			sourceInstanceId &&
			(inStack.id === sourceInstanceId ||
				(inStack.kind === 'spell' && inStack.sourceInstanceId === sourceInstanceId))
		) {
			return {
				ok: false,
				error: 'Strict Rules Violation: A spell or ability cannot target itself on the Stack.'
			};
		}
		if (info.controllerFilter === 'opponent' && inStack.controllerId === actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a spell or ability controlled by an opponent.'
			};
		}
		if (info.controllerFilter === 'you' && inStack.controllerId !== actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a spell or ability you control.'
			};
		}
		if (info.cardTypeFilter && inStack.kind === 'spell') {
			const stkTypes = resolveObjectFaces(inStack.card, stackItemFaceOptions(inStack)).types;
			const sType = stkTypes.join(' ');
			if (info.cardTypeFilter === 'Noncreature' && stkTypes.includes('Creature')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is a Creature spell (requires a noncreature spell).`
				};
			}
			if (
				info.cardTypeFilter === 'Permanent' &&
				!stkTypes.some(
					(t) =>
						t === 'Creature' ||
						t === 'Artifact' ||
						t === 'Enchantment' ||
						t === 'Planeswalker' ||
						t === 'Battle'
				)
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a permanent spell.`
				};
			}
			if (info.cardTypeFilter === 'Creature' && !stkTypes.includes('Creature')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a Creature spell.`
				};
			}
			if (
				info.cardTypeFilter === 'InstantOrSorcery' &&
				!stkTypes.includes('Instant') &&
				!stkTypes.includes('Sorcery')
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Instant or Sorcery spell.`
				};
			}
			if (info.cardTypeFilter === 'Instant' && !stkTypes.includes('Instant')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Instant spell.`
				};
			}
			if (info.cardTypeFilter === 'Sorcery' && !stkTypes.includes('Sorcery')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a Sorcery spell.`
				};
			}
			if (info.cardTypeFilter === 'Artifact' && !stkTypes.includes('Artifact')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Artifact spell.`
				};
			}
			if (info.cardTypeFilter === 'Enchantment' && !stkTypes.includes('Enchantment')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Enchantment spell.`
				};
			}
			void sType;
		}
		if (
			inStack.kind === 'spell' &&
			stackSpec?.kind === 'object' &&
			stackSpec.filter.colors?.length
		) {
			const sColors = resolveObjectFaces(inStack.card, stackItemFaceOptions(inStack)).colors;
			if (!matchesColorFilter(sColors, stackSpec.filter.colors)) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} does not match the required spell color.`
				};
			}
		}
		// --- Track P10 ---
		if (stackSpec?.kind === 'object') {
			if (stackSpec.filter.wasNotCast === true && !inStack.isCopy) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} was cast (requires a spell that was not cast).`
				};
			}
			if (stackSpec.filter.wasNotCast === false && inStack.isCopy) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} was not cast.`
				};
			}
			if (stackSpec.filter.abilitySourceFilter) {
				const castingSrc = sourceInstanceId
					? findCardAnywhere(state, sourceInstanceId)?.inst
					: undefined;
				if (
					!H().stackAbilitySourceMatchesFilter(
						state,
						inStack,
						actorId,
						stackSpec.filter.abilitySourceFilter,
						castingSrc
					)
				) {
					return {
						ok: false,
						error: `Strict Rules Violation: Target ability's source does not match the required filter.`
					};
				}
			}
			// --- Track P16a ---
			if (inStack.kind === 'spell') {
				const castingSrc = sourceInstanceId
					? findCardAnywhere(state, sourceInstanceId)?.inst
					: undefined;
				if (
					!H().stackSpellMatchesFilterQualifiers(state, inStack, stackSpec.filter, {
						state,
						controllerId: actorId,
						source: castingSrc
					})
				) {
					return {
						ok: false,
						error: `Strict Rules Violation: ${inStack.card.name} does not match the required spell filter.`
					};
				}
			}
			// --- End Track P16a ---
			// --- Track P19a (CR 115.9) ---
			const castingSrcP19a = sourceInstanceId
				? findCardAnywhere(state, sourceInstanceId)?.inst
				: undefined;
			if (
				!matchesP19aStackTargetSpec(state, inStack, stackSpec, {
					state,
					controllerId: actorId,
					source: castingSrcP19a
				})
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.title} does not satisfy the stack target requirement (CR 115.9).`
				};
			}
			// --- End Track P19a ---
		}
		// --- End Track P10 ---
		return { ok: true };
	}

	// 2. Graveyard card target validation
	if (
		target.kind === 'graveyard_card' ||
		target.kind === 'card_in_graveyard' ||
		info.zone === 'graveyard' ||
		targetKind === 'graveyard_card'
	) {
		if (target.kind !== 'graveyard_card' && target.kind !== 'card_in_graveyard') {
			return {
				ok: false,
				error: 'Strict Rules Violation: This spell or ability must target a card in a graveyard.'
			};
		}
		// --- Track P20a ---
		const gyBlock = isGraveyardTargetingBlocked(state);
		if (gyBlock.blocked) {
			return {
				ok: false,
				error: `Strict Rules Violation: Cards in graveyards can't be targeted (${gyBlock.sourceName ?? 'Rule modifier'}).`
			};
		}
		// --- End Track P20a ---
		let foundOwner: PlayerGameState | undefined;
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.graveyard.find((g) => g.instanceId === target.id);
			if (c) {
				foundOwner = p;
				foundCard = c;
				break;
			}
		}
		if (!foundCard || !foundOwner) {
			return { ok: false, error: 'Target card is not in any graveyard.' };
		}
		if (info.controllerFilter === 'you' && foundOwner.playerId !== actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a card in your graveyard.'
			};
		}
		if (info.controllerFilter === 'opponent' && foundOwner.playerId === actorId) {
			return {
				ok: false,
				error: "Strict Rules Violation: Must target a card in an opponent's graveyard."
			};
		}
		if (info.cardTypeFilter) {
			const gView = resolveObjectFaces(
				effectiveCardForObject(foundCard),
				instanceFaceOptions(foundCard, 'graveyard')
			);
			const gTypes = gView.types;
			if (
				info.cardTypeFilter === 'InstantOrSorcery' &&
				!gTypes.includes('Instant') &&
				!gTypes.includes('Sorcery')
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${foundCard.card.name} is not an Instant or Sorcery card.`
				};
			} else if (info.cardTypeFilter === 'Permanent') {
				const isPerm =
					gTypes.includes('Creature') ||
					gTypes.includes('Artifact') ||
					gTypes.includes('Enchantment') ||
					gTypes.includes('Land') ||
					gTypes.includes('Planeswalker') ||
					gTypes.includes('Battle');
				if (!isPerm) {
					return {
						ok: false,
						error: `Strict Rules Violation: ${foundCard.card.name} is not a permanent card.`
					};
				}
			} else if (info.cardTypeFilter === 'NonlandPermanent') {
				if (gTypes.includes('Land')) {
					return {
						ok: false,
						error: `Strict Rules Violation: ${foundCard.card.name} is a Land card (requires a nonland card).`
					};
				}
			} else if (
				info.cardTypeFilter !== 'InstantOrSorcery' &&
				!gTypes.includes(info.cardTypeFilter) &&
				!gView.subtypes.includes(info.cardTypeFilter) &&
				!gView.supertypes.includes(info.cardTypeFilter)
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${foundCard.card.name} is not a ${info.cardTypeFilter} card.`
				};
			}
		}
		// --- Track P21: Full ObjectFilter check on `graveyard_card` targets ---
		const gySourceInst = sourceInstanceId
			? findCardAnywhere(state, sourceInstanceId)?.inst
			: undefined;
		const gySpec = info.targetSpecs?.[0];
		if (
			gySpec?.kind === 'object' &&
			!matchesObjectFilter(foundCard, gySpec.filter, {
				state,
				controllerId: actorId,
				source: gySourceInst
			})
		) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${foundCard.card.name} does not match the graveyard target filter.`
			};
		}
		// --- End Track P21 ---
		return { ok: true };
	}

	// 2b. Exile card target validation (CR 607.2a linked exile / exile-zone targets)
	if (target.kind === 'exile_card' || info.zone === 'exile' || targetKind === 'exile_card') {
		if (target.kind !== 'exile_card') {
			return {
				ok: false,
				error: 'Strict Rules Violation: This spell or ability must target a card in exile.'
			};
		}
		let foundOwner: PlayerGameState | undefined;
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.exile.find((x) => x.instanceId === target.id);
			if (c) {
				foundOwner = p;
				foundCard = c;
				break;
			}
		}
		if (!foundCard || !foundOwner) {
			return { ok: false, error: 'Target card is not in exile.' };
		}
		if (info.controllerFilter === 'you' && foundOwner.playerId !== actorId) {
			return { ok: false, error: 'Strict Rules Violation: Must target your card in exile.' };
		}
		if (info.controllerFilter === 'opponent' && foundOwner.playerId === actorId) {
			return { ok: false, error: "Strict Rules Violation: Must target an opponent's card in exile." };
		}
		const sourceInst = sourceInstanceId ? findCardAnywhere(state, sourceInstanceId)?.inst : undefined;
		const spec = info.targetSpecs?.[0];
		if (
			spec?.kind === 'object' &&
			!matchesObjectFilter(foundCard, spec.filter, {
				state,
				controllerId: actorId,
				source: sourceInst,
				// --- Track P20b ---
				...(xValue !== undefined ? { xValue } : {})
				// --- End Track P20b ---
			})
		) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${foundCard.card.name} does not match the exile target filter.`
			};
		}
		return { ok: true };
	}

	// 3. Player target validation
	if (targetKind === 'player' && target.kind !== 'player') {
		return { ok: false, error: 'Strict Rules Violation: This spell or ability must target a player.' };
	}

	if (target.kind === 'player') {
		if (targetKind !== 'player' && targetKind !== 'any' && targetKind !== 'none') {
			return {
				ok: false,
				error: `Strict Rules Violation: Requires a target ${targetKind.replace(/_/g, ' ')}, not a player.`
			};
		}
		const p = state.players.find((pl) => pl.playerId === target.id && !pl.lost);
		if (!p) return { ok: false, error: 'Target player is not valid.' };
		const playerSpecs =
			info.targetSpecs?.filter((ts) => ts.kind === 'player' || ts.kind === 'objectOrPlayer') ?? [];
		const specRequiresOpponent =
			playerSpecs.length > 0 &&
			playerSpecs.every(
				(ts) => ts.player?.relation === 'opponent' || ts.player?.relation === 'each_opponent'
			);
		const specRequiresYou =
			playerSpecs.length > 0 && playerSpecs.every((ts) => ts.player?.relation === 'you');
		if ((info.controllerFilter === 'opponent' || specRequiresOpponent) && p.playerId === actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target an opponent.'
			};
		}
		if ((info.controllerFilter === 'you' || specRequiresYou) && p.playerId !== actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target yourself.'
			};
		}
		if (playerHasShroud(state, p)) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${p.username} has Shroud / Protection and cannot be targeted.`
			};
		}
		if (playerHasHexproofFrom(state, p, actorId)) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${p.username} has Hexproof and cannot be targeted by opponents.`
			};
		}
		// --- Track P22a ---
		if (
			playerProtectedFromSourceWave8(
				state,
				p.playerId,
				sourceCard,
				sourceInstanceId ? findPermanentOnBoard(state, sourceInstanceId)?.inst : undefined
			)
		) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${p.username} has Protection from ${sourceCard?.name ?? 'this source'}'s card type and cannot be targeted.`
			};
		}
		// --- End Track P22a ---
		return { ok: true };
	}

	// 4. Battlefield permanent target validation
	const found = findPermanentOnBoard(state, target.id);
	if (!found) {
		return { ok: false, error: 'Target permanent is not on the battlefield (or is phased out).' };
	}

	if (hasKeyword(found.inst, 'Shroud', state)) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} has Shroud and cannot be the target of spells or abilities.`
		};
	}
	if (
		found.controller.playerId !== actorId &&
		!playerIgnoresOpponentHexproofWave9(state, actorId, found.inst) &&
		(hasKeyword(found.inst, 'Hexproof', state) ||
			hasHexproofFromQuality(found.inst, sourceCard, state))
	) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} has Hexproof and cannot be targeted by opponents.`
		};
	}
	// --- Track P20a ---
	const srcStackItem = sourceInstanceId
		? state.stack.find(
				(s) => s.id === sourceInstanceId || (s.kind === 'spell' && s.sourceInstanceId === sourceInstanceId)
			)
		: undefined;
	const srcBoardPerm = sourceInstanceId ? findPermanentOnBoard(state, sourceInstanceId)?.inst : undefined;
	const resolvedSrcKind: 'spell' | 'ability' =
		sourceKindHint ??
		(srcStackItem
			? srcStackItem.kind === 'spell'
				? 'spell'
				: 'ability'
			: srcBoardPerm
				? 'ability'
				: 'spell');
	const srcPermForTarget = resolvedSrcKind === 'ability' ? srcBoardPerm : undefined;
	if (hasProtectionFrom(found.inst, sourceCard, state, srcPermForTarget, false, actorId)) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} has Protection from ${sourceCard?.name || 'this source'} and cannot be targeted.`
		};
	}
	const cantTargetCheck = isPermanentBlockedByCantBeTargetedBy(
		state,
		found.inst,
		actorId,
		sourceCard,
		srcPermForTarget,
		resolvedSrcKind
	);
	if (cantTargetCheck.blocked) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} can't be targeted (${cantTargetCheck.sourceName ?? 'Rule modifier'}).`
		};
	}
	// --- End Track P20a ---

	if (info.controllerFilter === 'you' && found.controller.playerId !== actorId) {
		return {
			ok: false,
			error: `Strict Rules Violation: You must target a permanent you control.`
		};
	}
	if (info.controllerFilter === 'opponent' && found.controller.playerId === actorId) {
		return {
			ok: false,
			error: `Strict Rules Violation: You must target a permanent an opponent controls.`
		};
	}

	const tLine = evaluatePermanent(state, found.inst).typeLine;
	if (targetKind === 'creature' && !tLine.includes('Creature')) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} is not a Creature.`
		};
	}
	if (targetKind === 'controlled_creature') {
		if (!tLine.includes('Creature')) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${found.inst.card.name} is not a Creature.`
			};
		}
		if (found.controller.playerId !== actorId) {
			return {
				ok: false,
				error: `Strict Rules Violation: You must target a creature you control.`
			};
		}
	}
	if (
		targetKind === 'artifact_or_enchantment' &&
		!tLine.includes('Artifact') &&
		!tLine.includes('Enchantment')
	) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} is not an Artifact or Enchantment.`
		};
	}
	if (targetKind === 'nonland_permanent' && tLine.includes('Land')) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} is a Land (requires a nonland permanent).`
		};
	}
	if (targetKind === 'battle' && !tLine.includes('Battle')) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} is not a Battle.`
		};
	}

	if (info.cardTypeFilter && !matchesPermanentTypeFilter(found.inst, info.cardTypeFilter, state)) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} does not match required type (${info.cardTypeFilter}).`
		};
	}

	if (info.targetSpecs && info.targetSpecs.length > 0) {
		const objectSpecs = info.targetSpecs.filter(
			(ts) => ts.kind === 'object' || ts.kind === 'objectOrPlayer'
		);
		if (objectSpecs.length > 0) {
			// --- Track P18a: Resolve off-battlefield / stack source so `sameOwnerAsSource` sees true spell owner ---
			const sourceInst = sourceInstanceId
				? (findPermanentOnBoard(state, sourceInstanceId)?.inst ??
					findCardAnywhere(state, sourceInstanceId)?.inst)
				: undefined;
			const sourceStackItem =
				!sourceInst && sourceInstanceId
					? state.stack.find(
							(s) => s.sourceInstanceId === sourceInstanceId || s.id === sourceInstanceId
						)
					: undefined;
			// --- Track P20b ---
			const resolvedTargetX = xValue ?? sourceStackItem?.xValue;
			// --- End Track P20b ---
			const fctx: FilterContext = {
				state,
				controllerId: actorId,
				source: sourceInst,
				...(sourceStackItem ? { stackItem: sourceStackItem } : {}),
				// --- Track P20b ---
				...(resolvedTargetX !== undefined ? { xValue: resolvedTargetX } : {})
				// --- End Track P20b ---
			};
			// --- End Track P18a ---
			const isAuraSpell = Boolean(
				sourceCard &&
					resolveObjectFaces(
						sourceCard,
						sourceStackItem ? stackItemFaceOptions(sourceStackItem) : { zone: 'stack' }
					).subtypes.includes('Aura')
			);
			const matchesFilter = isAuraSpell
				? objectSpecs.every((ts) => matchesObjectFilter(found.inst, ts.filter, fctx))
				: objectSpecs.some((ts) => matchesObjectFilter(found.inst, ts.filter, fctx));
			if (!matchesFilter) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${found.inst.card.name} is not a legal target.`
				};
			}
		}
	}

	return { ok: true };
}

export function partitionTargetsBySpecs(
	targets: TargetRef[],
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	// --- Track P16a ---
	state?: GameState,
	actorId?: string,
	sourceInstanceId?: string
	// --- End Track P16a ---
): TargetRef[][] | undefined {
	if (sourceCard && resolveObjectFaces(sourceCard, { zone: 'stack' }).subtypes.includes('Aura')) {
		return undefined;
	}
	const specs = info.targetSpecs;
	if (!specs || specs.length === 0) return undefined;
	// --- Track P16a: Exact multi-spec backtracking partitioner when state & actorId are known ---
	if (specs.length > 1 && state && actorId) {
		const normalizedSpecs = specs.map((sp) => (sp.max > 0 ? sp : { ...sp, min: 0, max: 0 }));
		const solved = partitionMultiTargetsBacktracking(normalizedSpecs, targets, (specIdx, t) => {
			const spec = normalizedSpecs[specIdx];
			if (!spec || spec.max <= 0) return false;
			return validateTargetLegality(
				state,
				actorId,
				t,
				targetRequirementFromSpecs([spec]),
				sourceCard,
				sourceInstanceId
			).ok;
		});
		if (solved) return solved;
	}
	// --- End Track P16a ---
	const counts = specs.map((sp) => (sp.max > 0 ? sp.min : 0));
	let extra = targets.length - counts.reduce((a, b) => a + b, 0);
	for (let k = 0; k < specs.length && extra > 0; k++) {
		if (specs[k].max <= 0) continue;
		const add = Math.min(extra, specs[k].max - counts[k]);
		if (add > 0) {
			counts[k] += add;
			extra -= add;
		}
	}
	let cursor = 0;
	return specs.map((_, k) => {
		const slice = targets.slice(cursor, cursor + counts[k]);
		cursor += counts[k];
		return slice;
	});
}

export function validateChosenTargets(
	state: GameState,
	actorId: string,
	targets: TargetRef[],
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	optionOrId?: CastOption | string
): { ok: boolean; error?: string } {
	if (optionTargetsBecomeEach(sourceCard, optionOrId)) {
		if (targets.length > 0) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${sourceCard?.name || 'This spell'} changes 'target' to 'each' and cannot have targets (CR 702.96b).`
			};
		}
		return { ok: true };
	}

	if (info.isModal && info.modalBranches && info.modalBranches.length > 0) {
		let lastErr = 'No modal branch matched the chosen target(s).';
		for (const branch of info.modalBranches) {
			const res = validateChosenTargets(
				state,
				actorId,
				targets,
				branch,
				sourceCard,
				sourceInstanceId,
				xValue,
				optionOrId
			);
			if (res.ok) return { ok: true };
			if (res.error) lastErr = res.error;
		}
		return { ok: false, error: lastErr };
	}

	if (!info.requiresTarget && targets.length === 0) {
		return { ok: true };
	}
	if (!info.requiresTarget && info.maxTargets === 0 && targets.length > 0) {
		const copyFaceOpts =
			optionOrId && typeof optionOrId === 'object'
				? { zone: 'stack' as const, faceIndex: optionOrId.faceIndex ?? 0, fused: optionOrId.fused }
				: undefined;
		const allowsCopyHint =
			sourceCard &&
			activeAbilityDefs(sourceCard, copyFaceOpts).some(
				(ab) =>
					ab.kind === 'replacement' &&
					!Array.isArray(ab.replacement.with) &&
					ab.replacement.with.k === 'modify' &&
					Boolean(ab.replacement.with.copyOf)
			);
		if (!allowsCopyHint) {
			return {
				ok: false,
				error: `${sourceCard?.name || 'Spell or ability'} does not take any targets.`
			};
		}
	}

	if (targets.length < info.minTargets) {
		return {
			ok: false,
			error: `${sourceCard?.name || 'Spell or ability'} requires ${info.minTargets === info.maxTargets ? `exactly ${info.minTargets}` : `at least ${info.minTargets}`} legal target(s).`
		};
	}
	// --- Precon Bragos Spirit: CR 115.1 one target per opponent ---
	for (const sp of info.targetSpecs ?? []) {
		const perOppError = H().perOpponentTargetError(state, sp, targets);
		if (perOppError) return { ok: false, error: perOppError };
	}
	// --- End Precon Bragos Spirit ---
	if (info.maxTargets > 0 && targets.length > info.maxTargets) {
		return {
			ok: false,
			error: `${sourceCard?.name || 'Spell or ability'} allows at most ${info.maxTargets} target(s).`
		};
	}

	const chosenFaceOpts =
		optionOrId && typeof optionOrId === 'object'
			? { zone: 'stack' as const, faceIndex: optionOrId.faceIndex ?? 0, fused: optionOrId.fused }
			: { zone: 'stack' as const };
	const isAuraSource = Boolean(
		sourceCard && resolveObjectFaces(sourceCard, chosenFaceOpts).subtypes.includes('Aura')
	);
	const activeSpecs = !isAuraSource ? info.targetSpecs?.filter((sp) => sp.max > 0) : undefined;
	if (activeSpecs && activeSpecs.length > 1) {
		// --- Track P16a: Backtracking multi-spec partition so optional specs (min=0) assign legally ---
		const backtracked = partitionMultiTargetsBacktracking(activeSpecs, targets, (specIdx, t) =>
			validateTargetLegality(
				state,
				actorId,
				t,
				targetRequirementFromSpecs([activeSpecs[specIdx]]),
				sourceCard,
				sourceInstanceId
			).ok
		);
		// --- End Track P16a ---
		const counts = activeSpecs.map((sp) => sp.min);
		let extra = targets.length - counts.reduce((a, b) => a + b, 0);
		for (let k = 0; k < activeSpecs.length && extra > 0; k++) {
			const add = Math.min(extra, activeSpecs[k].max - counts[k]);
			if (add > 0) {
				counts[k] += add;
				extra -= add;
			}
		}
		let cursor = 0;
		const seenInPriorSpecs = new Set<string>();
		for (let k = 0; k < activeSpecs.length; k++) {
			const spec = activeSpecs[k];
			const specTargets = backtracked
				? backtracked[k]
				: targets.slice(cursor, cursor + counts[k]);
			if (!backtracked) cursor += counts[k];
			const uniqueInSpec = new Set(specTargets.map((t) => `${t.kind}:${t.id}`));
			if (uniqueInSpec.size !== specTargets.length) {
				return {
					ok: false,
					error: 'Strict Rules Violation: The same object cannot be chosen multiple times for the same target requirement (CR 115.3).'
				};
			}
			if (spec.otherTarget) {
				for (const t of specTargets) {
					if (seenInPriorSpecs.has(`${t.kind}:${t.id}`)) {
						return {
							ok: false,
							error: 'Strict Rules Violation: "Another target" must be a different object from earlier target(s) (CR 115.3).'
						};
					}
				}
			}
			const specInfo = targetRequirementFromSpecs([spec]);
			// --- Track P20a ---
			const chosenSrcKindHint: 'spell' | 'ability' | undefined =
				typeof optionOrId === 'string' ? 'ability' : optionOrId ? 'spell' : undefined;
			// --- End Track P20a ---
			for (const t of specTargets) {
				const res = validateTargetLegality(
					state,
					actorId,
					t,
					specInfo,
					sourceCard,
					sourceInstanceId,
					chosenSrcKindHint,
					xValue
				);
				if (!res.ok) return res;
				seenInPriorSpecs.add(`${t.kind}:${t.id}`);
			}
		}
	} else {
		const uniqueIds = new Set(targets.map((t) => `${t.kind}:${t.id}`));
		if (uniqueIds.size !== targets.length) {
			return {
				ok: false,
				error: 'Strict Rules Violation: The same object cannot be chosen multiple times for the same target requirement (CR 115.3).'
			};
		}

		// --- Track P20a ---
		const chosenSrcKindHint: 'spell' | 'ability' | undefined =
			typeof optionOrId === 'string' ? 'ability' : optionOrId ? 'spell' : undefined;
		// --- End Track P20a ---
		for (const t of targets) {
			const res = validateTargetLegality(
				state,
				actorId,
				t,
				info,
				sourceCard,
				sourceInstanceId,
				chosenSrcKindHint,
				xValue
			);
			if (!res.ok) return res;
		}
	}

	// --- Track P17a: CR 115.1 Flagbearer targeting requirement ---
	const flagbearerIds = getRequiredFlagbearerIdsForActor(state, actorId);
	if (flagbearerIds.size > 0 && targets.length > 0) {
		const fbSpecs = activeSpecs ?? info.targetSpecs?.filter((sp) => sp.max > 0);
		const srcInstForFb = sourceInstanceId
			? findPermanentOnBoard(state, sourceInstanceId)?.inst
			: undefined;
		if (fbSpecs && fbSpecs.length > 0 && sourceCard) {
			const partitionedFb = partitionTargetsBySpecs(targets, info, sourceCard);
			const fbEntries = fbSpecs.map((spec, idx) => ({
				spec,
				chosen: partitionedFb?.[idx] ?? [],
				legalCandidates: H().specTargetCandidates(state, actorId, sourceCard, srcInstForFb, spec)
			}));
			const fbRes = validateFlagbearerTargets(state, actorId, fbEntries);
			if (!fbRes.ok) return { ok: false, error: fbRes.error! };
		} else {
			const chosenHasFb = targets.some((t) => t.kind === 'permanent' && flagbearerIds.has(t.id));
			if (!chosenHasFb) {
				for (const fbId of flagbearerIds) {
					const fbPerm = findPermanentOnBoard(state, fbId)?.inst;
					if (!fbPerm) continue;
					const fbCandidate: TargetRef = { kind: 'permanent', id: fbId, label: fbPerm.card.name };
					if (
						validateTargetLegality(
							state,
							actorId,
							fbCandidate,
							info,
							sourceCard,
							sourceInstanceId,
							// --- Track P20b ---
							xValue
							// --- End Track P20b ---
						).ok
					) {
						return {
							ok: false,
							error: `Strict Rules Violation: You must choose at least one Flagbearer on the battlefield as a target if able (CR 115.1).`
						};
					}
				}
			}
		}
	}
	// --- End Track P17a ---

	// --- Track P7 ---
	const dividedCheckSpecs = activeSpecs ?? info.targetSpecs?.filter((sp) => sp.max > 0);
	if (dividedCheckSpecs?.some((sp) => Boolean(sp.divideTotal))) {
		const partitioned = partitionTargetsBySpecs(
			targets,
			info,
			sourceCard,
			state,
			actorId,
			sourceInstanceId
		);
		const divCheck = H().resolveTargetDivisionsForSpecs(
			state,
			actorId,
			dividedCheckSpecs,
			targets,
			partitioned,
			sourceCard,
			sourceInstanceId,
			xValue,
			undefined
		);
		if (!divCheck.ok) return divCheck;
	}
	// --- End Track P7 ---

	// Enforce single-graveyard multi-target restriction ("target two cards in a graveyard")
	if (info.zone === 'graveyard' && info.sameGraveyard && targets.length > 1) {
		const graveyardOwnerIds = new Set<string>();
		for (const t of targets) {
			const owner = state.players.find((p) => p.graveyard.some((c) => c.instanceId === t.id));
			if (owner) {
				graveyardOwnerIds.add(owner.playerId);
			}
		}
		if (graveyardOwnerIds.size > 1) {
			return {
				ok: false,
				error: 'Strict Rules Violation: All targeted cards must be in the same single graveyard.'
			};
		}
	}

	return { ok: true };
}

/** Every legal target for `info`. Read-only: one validation for all candidates (Phase 6d). */
export function getAllLegalTargetsForRequirement(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	// --- Track P20b ---
	xValue?: number
	// --- End Track P20b ---
): TargetRef[] {
	return withStableLayerInputs(state, () =>
		getAllLegalTargetsForRequirementInner(
			state,
			actorId,
			info,
			sourceCard,
			sourceInstanceId,
			// --- Track P20b ---
			xValue
			// --- End Track P20b ---
		)
	);
}

function getAllLegalTargetsForRequirementInner(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	// --- Track P20b ---
	xValue?: number
	// --- End Track P20b ---
): TargetRef[] {
	const results: TargetRef[] = [];

	// --- Precon Bragos Spirit: CR 115.1 "target spell or permanent" also offers spells on the stack ---
	const alsoSpellInfo = info.zone !== 'stack' ? alsoSpellsStackRequirement(info) : null;
	if (alsoSpellInfo) {
		for (const item of state.stack) {
			if (item.kind !== 'spell') continue;
			const ref: TargetRef = { kind: 'stack', id: item.id, label: item.title };
			if (validateTargetLegalityInner(state, actorId, ref, info, sourceCard, sourceInstanceId, xValue).ok) {
				results.push(ref);
			}
		}
	}
	// --- End Precon Bragos Spirit ---

	if (info.zone === 'stack' || info.targetKind === 'spell') {
		for (const item of state.stack) {
			const ref: TargetRef = { kind: 'stack', id: item.id, label: item.title };
			if (
				validateTargetLegalityInner(state, actorId, ref, info, sourceCard, sourceInstanceId, xValue)
					.ok
			) {
				results.push(ref);
			}
		}
		return results;
	}

	if (info.zone === 'graveyard' || info.targetKind === 'graveyard_card') {
		for (const p of state.players) {
			for (const c of p.graveyard) {
				const ref: TargetRef = { kind: 'graveyard_card', id: c.instanceId, label: c.card.name };
				if (
					validateTargetLegalityInner(
						state,
						actorId,
						ref,
						info,
						sourceCard,
						sourceInstanceId,
						xValue
					).ok
				) {
					results.push(ref);
				}
			}
		}
		return results;
	}

	if (info.zone === 'exile' || info.targetKind === 'exile_card') {
		for (const p of state.players) {
			for (const c of p.exile) {
				const ref: TargetRef = { kind: 'exile_card', id: c.instanceId, label: c.card.name };
				if (
					validateTargetLegalityInner(
						state,
						actorId,
						ref,
						info,
						sourceCard,
						sourceInstanceId,
						xValue
					).ok
				) {
					results.push(ref);
				}
			}
		}
		return results;
	}

	if (info.targetKind === 'player' || info.targetKind === 'any') {
		for (const p of state.players) {
			if (p.lost) continue;
			const ref: TargetRef = { kind: 'player', id: p.playerId, label: p.username };
			if (
				validateTargetLegalityInner(state, actorId, ref, info, sourceCard, sourceInstanceId, xValue)
					.ok
			) {
				results.push(ref);
			}
		}
	}

	if (info.targetKind !== 'player') {
		for (const p of state.players) {
			if (p.lost) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				const ref: TargetRef = { kind: 'permanent', id: perm.instanceId, label: perm.card.name };
				if (
					validateTargetLegalityInner(
						state,
						actorId,
						ref,
						info,
						sourceCard,
						sourceInstanceId,
						xValue
					).ok
				) {
					results.push(ref);
				}
			}
		}
	}

	return results;
}

/** Whether enough legal targets exist for `info`. Read-only, one validation (Phase 6d). */
export function hasRequiredLegalTargets(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	optionOrId?: CastOption | string
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		hasRequiredLegalTargetsInner(
			state,
			actorId,
			info,
			sourceCard,
			sourceInstanceId,
			xValue,
			optionOrId
		)
	);
}

function hasRequiredLegalTargetsInner(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	optionOrId?: CastOption | string
): { ok: boolean; error?: string } {
	if (!info.requiresTarget || info.minTargets <= 0) {
		return { ok: true };
	}

	if (optionTargetsBecomeEach(sourceCard, optionOrId)) {
		return { ok: true };
	}

	if (info.isModal && info.modalBranches && info.modalBranches.length > 0) {
		for (const branch of info.modalBranches) {
			if (
				hasRequiredLegalTargets(
					state,
					actorId,
					branch,
					sourceCard,
					sourceInstanceId,
					xValue,
					optionOrId
				).ok
			) {
				return { ok: true };
			}
		}
		return {
			ok: false,
			error: `Illegal Cast: No mode of ${sourceCard?.name || 'this spell'} has valid legal targets.`
		};
	}

	const reqFaceOpts =
		optionOrId && typeof optionOrId === 'object'
			? { zone: 'stack' as const, faceIndex: optionOrId.faceIndex ?? 0, fused: optionOrId.fused }
			: { zone: 'stack' as const };
	const isAuraReq = Boolean(
		sourceCard && resolveObjectFaces(sourceCard, reqFaceOpts).subtypes.includes('Aura')
	);
	const activeSpecs = !isAuraReq ? info.targetSpecs?.filter((sp) => sp.max > 0) : undefined;
	// --- Track P7 ---
	if (activeSpecs?.some((sp) => Boolean(sp.divideTotal))) {
		const srcInst = sourceInstanceId ? findCardAnywhere(state, sourceInstanceId)?.inst : undefined;
		for (const spec of activeSpecs) {
			if (!spec.divideTotal || spec.min <= 0) continue;
			const total = H().evaluateSpecDivideTotal(state, actorId, spec, srcInst, xValue) ?? 0;
			if (total < spec.min) {
				return {
					ok: false,
					error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires a total of at least ${spec.min} to divide among targets (CR 601.2d).`
				};
			}
		}
	}
	// --- End Track P7 ---
	if (activeSpecs && activeSpecs.length > 1) {
		for (const spec of activeSpecs) {
			if (spec.min <= 0) continue;
			const specInfo = targetRequirementFromSpecs([spec]);
			const res = hasRequiredLegalTargetsInner(
				state,
				actorId,
				specInfo,
				sourceCard,
				sourceInstanceId,
				xValue,
				optionOrId
			);
			if (!res.ok) return res;
		}
		return { ok: true };
	}

	if (info.zone === 'graveyard' || info.targetKind === 'graveyard_card') {
		if (info.sameGraveyard) {
			for (const p of state.players) {
				if (info.controllerFilter === 'you' && p.playerId !== actorId) continue;
				if (info.controllerFilter === 'opponent' && p.playerId === actorId) continue;
				let validInThisGraveyard = 0;
				for (const c of p.graveyard) {
					const ref: TargetRef = { kind: 'graveyard_card', id: c.instanceId, label: c.card.name };
					if (
						validateTargetLegality(
							state,
							actorId,
							ref,
							info,
							sourceCard,
							sourceInstanceId,
							// --- Track P20b ---
							xValue
							// --- End Track P20b ---
						).ok
					) {
						validInThisGraveyard += 1;
					}
				}
				if (validInThisGraveyard >= info.minTargets) {
					return { ok: true };
				}
			}
			return {
				ok: false,
				error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target card(s) in a single graveyard.`
			};
		} else {
			const allGraveTargets = getAllLegalTargetsForRequirement(
				state,
				actorId,
				info,
				sourceCard,
				sourceInstanceId,
				// --- Track P20b ---
				xValue
				// --- End Track P20b ---
			);
			if (allGraveTargets.length < info.minTargets) {
				return {
					ok: false,
					error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target card(s) in graveyards.`
				};
			}
			return { ok: true };
		}
	}

	if (info.zone === 'exile' || info.targetKind === 'exile_card') {
		const allExileTargets = getAllLegalTargetsForRequirement(
			state,
			actorId,
			info,
			sourceCard,
			sourceInstanceId,
			// --- Track P20b ---
			xValue
			// --- End Track P20b ---
		);
		if (allExileTargets.length < info.minTargets) {
			return {
				ok: false,
				error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target card(s) in exile.`
			};
		}
		return { ok: true };
	}

	const legalTargets = getAllLegalTargetsForRequirement(
		state,
		actorId,
		info,
		sourceCard,
		sourceInstanceId,
		// --- Track P20b ---
		xValue
		// --- End Track P20b ---
	);
	if (legalTargets.length < info.minTargets) {
		if (info.zone === 'stack' || info.targetKind === 'spell') {
			return {
				ok: false,
				error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires a valid target spell on the Stack.`
			};
		}
		return {
			ok: false,
			error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target(s), and ${legalTargets.length === 0 ? 'none' : `only ${legalTargets.length}`} exist.`
		};
	}

	return { ok: true };
}

/** Whether `actorId` may pass to end of turn (`end_turn`) right now. Read-only. */
export function checkEndTurnLegality(
	state: GameState,
	actorId: string
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	if (state.pendingPrompts.length > 0) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	const activePlayer = state.players[state.activePlayerIndex];
	if (!activePlayer || activePlayer.playerId !== actorId) {
		return { ok: false, error: 'You can only pass to end of turn during your own turn.' };
	}
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (!priorityPlayer || priorityPlayer.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to pass to end of turn.' };
	}
	if (state.stack.length > 0) {
		return { ok: false, error: 'Resolve all spells and abilities on the Stack before ending your turn.' };
	}
	if (state.phase === 'cleanup') {
		return { ok: false, error: 'Already in the Cleanup Step.' };
	}
	const preCombatOrUnconfirmedAttackers =
		state.phase === 'upkeep' ||
		state.phase === 'draw' ||
		state.phase === 'main1' ||
		state.phase === 'begin_combat' ||
		H().isUnconfirmedAttackersStep(state);
	if (preCombatOrUnconfirmedAttackers) {
		const violation = H().findMandatoryAttackerViolation(state, activePlayer);
		if (violation) {
			return { ok: false, error: violation };
		}
	}
	return { ok: true };
}

/** Whether `actorId`'s draft attacker selection satisfies mandatory attack requirements right now. Read-only. */
export function checkMandatoryAttackersSatisfied(
	state: GameState,
	actorId: string,
	assignedAttackerIds: Iterable<string>
): { ok: boolean; error?: string } {
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	const violation = H().findMandatoryAttackerViolation(state, actor, new Set(assignedAttackerIds));
	if (violation) {
		return { ok: false, error: violation };
	}
	return { ok: true };
}

/** Whether `actorId` may play the land `inst` now. Read-only, one validation (Phase 6d). */
export function resolveLandPlayFaceIndex(
	card: ScryfallCard,
	inst: CardInstance,
	fromZone: ZoneType,
	requestedFaceIndex?: number
): { ok: true; faceIndex: number } | { ok: false; error: string } {
	const def = compileCard(card);
	const exileAllowed = fromZone === 'exile' ? inst.playableFromExileBy?.allowedFaceIndices : undefined;
	if (requestedFaceIndex !== undefined) {
		const face = def.faces[requestedFaceIndex];
		if (!face || !face.characteristics.types.includes('Land')) {
			return { ok: false, error: `${card.name} does not have a Land face at index ${requestedFaceIndex}.` };
		}
		if (exileAllowed && !exileAllowed.includes(requestedFaceIndex)) {
			return {
				ok: false,
				error: `You do not have permission to play that face of ${card.name} from Exile.`
			};
		}
		return { ok: true, faceIndex: requestedFaceIndex };
	}
	const fi = def.faces.findIndex(
		(f, i) => f.characteristics.types.includes('Land') && (!exileAllowed || exileAllowed.includes(i))
	);
	if (fi < 0) {
		return { ok: false, error: `${card.name} is not a Land card.` };
	}
	return { ok: true, faceIndex: fi };
}

export function getLandPlayOptions(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: 'hand' | 'exile' | 'library' | 'graveyard' = 'hand'
): LandPlayOption[] {
	return withStableLayerInputs(state, () => {
		const card = effectiveCardForObject(inst);
		const def = compileCard(card);
		const out: LandPlayOption[] = [];
		for (let fi = 0; fi < def.faces.length; fi++) {
			const face = def.faces[fi];
			if (!face.characteristics.types.includes('Land')) continue;
			if (!checkLandPlayLegalityInner(state, actorId, inst, fromZone, fi).ok) continue;
			const view = resolveObjectFaces(card, { zone: fromZone, faceIndex: fi });
			out.push({
				faceIndex: fi,
				label: face.name,
				typeLine: view.typeLine,
				fromZone
			});
		}
		return out;
	});
}

export function checkLandPlayLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	faceIndex?: number
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		checkLandPlayLegalityInner(state, actorId, inst, fromZone, faceIndex)
	);
}

function checkLandPlayLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	faceIndex?: number
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	if (state.pendingPrompts.length > 0) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	if (fromZone === 'exile') {
		// --- Track P14 ---
		const slottedExileLand =
			inst.ownerId === actorId
				? getWave5SlottedLandPlayPermission(state, actorId, 'exile', inst)
				: null;
		const wave9ExileLand = hasWave9ExileLandPlayPermission(state, actorId, inst);
		// --- End Track P14 ---
		if (inst.playableFromExileBy?.playerId !== actorId && !slottedExileLand && !wave9ExileLand) {
			return {
				ok: false,
				error: `You do not have permission to play ${inst.card.name} from Exile.`
			};
		}
		if (inst.playableFromExileBy?.spellsOnly && !slottedExileLand && !wave9ExileLand) {
			return {
				ok: false,
				error: `${inst.card.name} may only be cast as a spell from Exile, not played as a land (CR 601.1a).`
			};
		}
	// --- Track P8 (CR 305.1, 401.5) ---
	} else if (fromZone === 'library') {
		if (actor.library[0]?.instanceId !== inst.instanceId) {
			return { ok: false, error: `${inst.card.name} is not the top card of your library.` };
		}
		if (
			!getActiveZoneLandPlayPermissionSource(state, actorId, 'library', inst) &&
			// --- Track P14 ---
			!getWave5SlottedLandPlayPermission(state, actorId, 'library', inst)
			// --- End Track P14 ---
		) {
			return {
				ok: false,
				error: `You do not have permission to play ${inst.card.name} from the top of your library.`
			};
		}
	} else if (fromZone === 'graveyard') {
		if (!actor.graveyard.some((c) => c.instanceId === inst.instanceId)) {
			return { ok: false, error: `${inst.card.name} is not in your graveyard.` };
		}
		if (
			!getActiveZoneLandPlayPermissionSource(state, actorId, 'graveyard', inst) &&
			// --- Track P14 ---
			!getWave5SlottedLandPlayPermission(state, actorId, 'graveyard', inst) &&
			// --- End Track P14 ---
			// --- Track P12 ---
			!canPlayGraveyardLandViaMayhem(state, actorId, inst, faceIndex)
			// --- End Track P12 ---
		) {
			return {
				ok: false,
				error: `You do not have permission to play ${inst.card.name} from your graveyard.`
			};
		}
	} else if (fromZone !== 'hand') {
		return { ok: false, error: 'Lands can only be played from your hand (or from Exile with an active play permission).' };
	}
	const resolvedFace = resolveLandPlayFaceIndex(effectiveCardForObject(inst), inst, fromZone, faceIndex);
	if (!resolvedFace.ok) {
		return resolvedFace;
	}
	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (activePlayer?.playerId !== actorId) {
		return { ok: false, error: 'You may only play a land on your own turn.' };
	}
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to play a land.' };
	}
	if (state.phase !== 'main1' && state.phase !== 'main2') {
		return { ok: false, error: 'Lands can only be played during your Main Phase.' };
	}
	if (state.stack.length > 0) {
		return { ok: false, error: 'You cannot play a land while the Stack is not empty.' };
	}
	// --- Track P22a ---
	const landLockErr = checkLandPlayLocksWave8(state, actorId);
	if (landLockErr) {
		return { ok: false, error: `Strict Rules Violation: ${landLockErr}` };
	}
	const effectiveMaxLands = actor.maxLandsPerTurn + computeExtraLandPlaysWave8(state, actorId);
	// --- End Track P22a ---
	if (actor.landsPlayedThisTurn >= effectiveMaxLands) {
		return {
			ok: false,
			error: `You have already played your maximum of ${effectiveMaxLands} land(s) this turn.`
		};
	}
	return { ok: true };
}

/**
 * CR 701.27a–f / CR 712.10–12a: Transforms a double-faced permanent on the battlefield.
 */
export function transformPermanent(state: GameState, perm: CardInstance): boolean {
	if (!findPermanentOnBoard(state, perm.instanceId)) return false;
	// CR 712.12a: A double-faced permanent can't transform while it's face down.
	if (perm.isFaceDown) {
		addLog(
			state,
			'rule',
			`${perm.faceDownLabel || 'Face-Down Permanent'} can't transform while it is face down (CR 712.12a).`,
			perm.controllerId
		);
		return false;
	}
	const effCard = effectiveCardForObject(perm);
	// --- Track P18b (CR 713.1c): Melded permanents cannot transform ---
	if (isMeldedPermanent(perm)) return false;
	// --- End Track P18b ---
	const faces = getCardFaces(effCard);
	const effLayout =
		effCard.layout ?? (faces.length > 1 && effCard.backFace ? 'transform' : 'normal');
	// CR 701.27d: Non-DFCs / non-transforming DFCs cannot transform; nothing happens.
	if (effLayout !== 'transform' || faces.length < 2) return false;
	const oldIdx = activeFaceIndexForObject(perm);
	const newTransformed = oldIdx === 0;
	const nextFaceIdx = newTransformed ? 1 : 0;
	// CR 701.27e: If the face the permanent would transform into is an instant or sorcery face, nothing happens.
	const nextFaceView = resolveObjectFaces(effCard, { zone: 'battlefield', faceIndex: nextFaceIdx });
	if (nextFaceView.types.includes('Instant') || nextFaceView.types.includes('Sorcery')) return false;
	const oldName = faces[oldIdx]?.name ?? effCard.name;
	const newName = faces[nextFaceIdx]?.name ?? effCard.name;
	perm.transformed = newTransformed;
	perm.activeFaceIndex = nextFaceIdx;
	noteLayerInputsChanged(state);
	addLog(
		state,
		'rule',
		`${oldName} transformed into ${newName} (CR 701.27a).`,
		perm.controllerId
	);
	emitEvent(state, {
		kind: 'Transformed',
		objectId: perm.instanceId,
		object: perm,
		toFaceIndex: perm.activeFaceIndex
	});
	flushTriggers(state);
	return true;
}

/**
 * CR 710.1–2: Flips a flip permanent on the battlefield to its flipped (second) half.
 * Once flipped, a permanent cannot flip back.
 */
export function flipPermanent(state: GameState, perm: CardInstance): boolean {
	if (!findPermanentOnBoard(state, perm.instanceId)) return false;
	if (perm.isFaceDown) return false;
	// --- Track P18b (CR 710.4 / CR 713): Flipping is irreversible while on the battlefield ---
	if (perm.isFlipped || isMeldedPermanent(perm)) return false;
	// --- End Track P18b ---
	const effCard = effectiveCardForObject(perm);
	const faces = getCardFaces(effCard);
	if (effCard.layout !== 'flip' || faces.length < 2) return false;
	if (activeFaceIndexForObject(perm) !== 0) return false;
	const oldName = faces[0]?.name ?? effCard.name;
	const newName = faces[1]?.name ?? effCard.name;
	// --- Track P18b ---
	perm.isFlipped = true;
	// --- End Track P18b ---
	perm.activeFaceIndex = 1;
	noteLayerInputsChanged(state);
	addLog(
		state,
		'rule',
		`${oldName} flipped into ${newName} (CR 710.1).`,
		perm.controllerId
	);
	return true;
}

export function hasXInTurnUpCost(manaCost?: string, costDefs?: CostDef[]): boolean {
	if (manaCost && /\{X\}/i.test(manaCost)) return true;
	if (!costDefs || costDefs.length === 0) return false;
	// --- Track P14 ---
	if (costDefs.some((d) => d.k === 'waterbend' && /\{X\}/i.test(d.cost))) return true;
	// --- End Track P14 ---
	return JSON.stringify(costDefs).includes('"k":"x"');
}

export function resolveTurnUpManaRequirement(
	manaCost: string | undefined,
	xValue: number
): ManaCostRequirement | null {
	if (manaCost === undefined) return null;
	return parseManaCost(manaCost, Math.max(0, xValue));
}

export interface TurnFaceUpDisplayInfo {
	costDisplay: string;
	choosesX: boolean;
	legal: boolean;
	error?: string;
}

export function getTurnFaceUpDisplay(
	state: GameState,
	actorId: string,
	perm: CardInstance
): TurnFaceUpDisplayInfo | null {
	if (!perm?.isFaceDown || !perm.faceDownSpec) return null;
	const spec = perm.faceDownSpec;
	if (spec.turnUpManaCost === undefined && (spec.turnUpCostDefs?.length ?? 0) === 0) {
		return null;
	}
	const costDisplay =
		describeTurnUpCost(spec.turnUpManaCost, spec.turnUpCostDefs) || spec.turnUpCost || '{0}';
	const choosesX = hasXInTurnUpCost(spec.turnUpManaCost, spec.turnUpCostDefs);
	const firstCheck = checkTurnFaceUpLegality(state, actorId, perm, 0);
	const check =
		!firstCheck.ok && choosesX ? checkTurnFaceUpLegality(state, actorId, perm, 1) : firstCheck;
	return {
		costDisplay,
		choosesX,
		legal: check.ok,
		...(check.error ? { error: check.error } : {})
	};
}

/**
 * Checks whether `actorId` may take the special action to turn `inst` face up (CR 116.2b, 708.7).
 */
export function checkTurnFaceUpLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	xValue = 0,
	costPayment?: CostPayment
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => {
		if (state.status !== 'active') {
			return { ok: false, error: 'Game is not currently active.' };
		}
		if (state.pendingPrompts.length > 0) {
			return { ok: false, error: 'Resolve the active prompt first.' };
		}
		const actor = state.players.find((p) => p.playerId === actorId);
		if (!actor || actor.lost) {
			return { ok: false, error: 'Player is not active in this game.' };
		}
		if (inst.zone !== 'battlefield' || inst.controllerId !== actorId || inst.phasedOut) {
			return { ok: false, error: 'Permanent must be an active permanent you control on the battlefield.' };
		}
		if (!inst.isFaceDown) {
			return { ok: false, error: 'Permanent is already face up.' };
		}
		const spec = inst.faceDownSpec;
		const turnUpManaCost = spec?.turnUpManaCost;
		const turnUpCostDefs = spec?.turnUpCostDefs ?? [];
		if (!spec || (turnUpManaCost === undefined && turnUpCostDefs.length === 0)) {
			return { ok: false, error: 'This face-down permanent cannot be turned face up.' };
		}
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		const pendingCombatErr = H().getPendingCombatDeclarationError(state);
		if (pendingCombatErr) {
			return { ok: false, error: pendingCombatErr };
		}
		if (priorityPlayer?.playerId !== actorId) {
			return { ok: false, error: 'You do not currently hold priority.' };
		}
		const choosesX = hasXInTurnUpCost(turnUpManaCost, turnUpCostDefs);
		const effectiveX = choosesX ? Math.max(0, xValue) : 0;
		const req = resolveTurnUpManaRequirement(turnUpManaCost, effectiveX);
		if (turnUpCostDefs.length > 0) {
			if (
				!canPayCosts(
					H().costContext(state, actor, inst, effectiveX, false, req, costPayment?.phyrexianLifeCount),
					turnUpCostDefs
				)
			) {
				return {
					ok: false,
					error: `You can't pay the turn-face-up cost (${describeTurnUpCost(turnUpManaCost, turnUpCostDefs)}).`
				};
			}
		} else if (req && !H().canPayOrAutoTap(actor, req, state, costPayment?.phyrexianLifeCount)) {
			return {
				ok: false,
				error: `Insufficient mana to turn ${inst.faceDownLabel || 'Face-Down Permanent'} face up (requires ${turnUpManaCost}).`
			};
		}
		return { ok: true };
	});
}

export function chooseBotTurnFaceUpPayment(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	xValue = 0
): CostPayment | undefined {
	const spec = perm.faceDownSpec;
	const defs = spec?.turnUpCostDefs ?? [];
	if (defs.length === 0) return undefined;
	const req = resolveTurnUpManaRequirement(spec?.turnUpManaCost, xValue);
	return chooseCostPayment(H().costContext(state, player, perm, xValue, false, req), defs) ?? undefined;
}

export function completeTurnFaceUp(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	xValue: number,
	descriptions: string[]
): void {
	const wasLabel = perm.faceDownLabel || 'Face-Down Permanent';
	const spec = perm.faceDownSpec;
	perm.isFaceDown = false;
	perm.faceDownSpec = undefined;
	perm.faceDownLabel = undefined;
	// CR 712.12a: Turning a face-down double-faced permanent face up leaves its front face up.
	perm.transformed = false;
	perm.activeFaceIndex = 0;
	noteLayerInputsChanged(state);
	state.passedPriorityPlayerIds = [];
	state.priorityUpdatedAt = Date.now();
	const costSuffix = descriptions.length > 0 ? ` (${descriptions.join(', ')})` : '';
	addLog(
		state,
		'rule',
		`${actor.username} turned ${wasLabel} face up as ${perm.card.name}${costSuffix} (CR 708.7).`,
		actor.playerId
	);
	if (spec?.kind === 'megamorph') {
		H().addCountersToPermanent(state, perm, '+1/+1', 1);
	}
	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'TurnedFaceUp',
		objectId: perm.instanceId,
		object: perm,
		playerId: actor.playerId,
		...(xValue > 0 ? { xValue } : {})
	});
	resetTriggerLoopTracking(state);
	flushTriggers(state);
	H().checkStateBasedActions(state);
}

export function finalizeTurnFaceUp(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const perm = findPermanentOnBoard(state, pcp.sourceInstanceId)?.inst;
	if (!perm || !perm.isFaceDown) return;
	completeTurnFaceUp(state, actor, perm, pcp.xValue ?? 0, pcp.descriptions);
}

/**
 * Whether `actorId` may unlock the Room door at `faceIndex` on `inst` (CR 709.5e).
 */
export function checkUnlockRoomDoorLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	faceIndex: number
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => {
		if (state.status !== 'active') {
			return { ok: false, error: 'Game is not currently active.' };
		}
		if (state.pendingPrompts.length > 0) {
			return { ok: false, error: 'Resolve the active prompt first.' };
		}
		const actor = state.players.find((p) => p.playerId === actorId);
		if (!actor || actor.lost) {
			return { ok: false, error: 'Player is not active in this game.' };
		}
		if (inst.zone !== 'battlefield' || inst.controllerId !== actorId || inst.phasedOut) {
			return { ok: false, error: 'Room must be an active permanent you control on the battlefield.' };
		}
		const activePlayer = state.players[state.activePlayerIndex];
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		if (activePlayer?.playerId !== actorId) {
			return { ok: false, error: 'Room doors can only be unlocked on your turn at Sorcery speed.' };
		}
		if (priorityPlayer?.playerId !== actorId) {
			return { ok: false, error: 'You must hold priority to unlock a Room door.' };
		}
		if (state.phase !== 'main1' && state.phase !== 'main2') {
			return { ok: false, error: 'Room doors can only be unlocked during your Main Phase.' };
		}
		if (state.stack.length > 0) {
			return { ok: false, error: 'Room doors cannot be unlocked while the Stack is not empty.' };
		}
		const card = effectiveCardForObject(inst);
		const def = compileCard(card);
		const face = def.faces[faceIndex];
		if (def.layout !== 'split' || !face || !face.characteristics.subtypes.includes('Room')) {
			return { ok: false, error: `${card.name} does not have a Room door at face ${faceIndex}.` };
		}
		if ((inst.unlockedFaces ?? []).includes(faceIndex)) {
			return { ok: false, error: `${face.name} is already unlocked.` };
		}
		const costStr = face.characteristics.manaCost;
		if (!costStr) {
			return { ok: false, error: `${face.name} has no mana cost to unlock.` };
		}
		const req = parseManaCost(costStr);
		if (!H().canPayOrAutoTap(actor, req, state)) {
			return {
				ok: false,
				error: `Insufficient mana to unlock ${face.name} (requires ${costStr}).`
			};
		}
		return { ok: true };
	});
}

/**
 * Whether `actorId` may cast `inst` now. Read-only: the whole check (cost, auto-tap simulation,
 * targets) shares one layer-cache validation (Phase 6d).
 */
export function checkSpellCastLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	xValue = 0,
	optionId?: string,
	optionalCostCounts?: Record<string, number>,
	faceIndex?: number,
	fused?: boolean,
	costAidIds?: Record<string, string[]>,
	costAidColorChoices?: Record<string, ManaColor | 'generic'>,
	strictCostAids = false
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		checkSpellCastLegalityInner(
			state,
			actorId,
			inst,
			fromZone,
			xValue,
			optionId,
			optionalCostCounts,
			faceIndex,
			fused,
			costAidIds,
			costAidColorChoices,
			strictCostAids
		)
	);
}

function checkSpellCastLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	xValue = 0,
	optionId?: string,
	optionalCostCounts?: Record<string, number>,
	faceIndex?: number,
	fused?: boolean,
	costAidIds?: Record<string, string[]>,
	costAidColorChoices?: Record<string, ManaColor | 'generic'>,
	strictCostAids = false
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	// --- Track P21 (CR 601.3e): Allow `castFromLibraryWhileSearching` while library search prompt is active ---
	const allowWhileSearching =
		fromZone === 'library' && Boolean(findCastWhileSearchingLibraryCard(state, actor, inst.instanceId));
	if (state.pendingPrompts.length > 0 && !allowWhileSearching) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	// --- End Track P21 ---
	const resolved = H().resolveCastOptionForAction(
		state,
		actorId,
		inst,
		fromZone,
		optionId,
		faceIndex,
		fused
	);
	if (!resolved.ok) {
		return { ok: false, error: resolved.error };
	}
	return checkSpellCastOptionLegalityInner(
		state,
		actorId,
		inst,
		resolved.option.fromZone,
		xValue,
		resolved.option,
		optionalCostCounts,
		costAidIds,
		costAidColorChoices,
		strictCostAids
	);
}

export function checkSpellCastOptionLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone,
	xValue: number,
	option: CastOption,
	optionalCostCounts?: Record<string, number>,
	costAidIds?: Record<string, string[]>,
	costAidColorChoices?: Record<string, ManaColor | 'generic'>,
	strictCostAids = false
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	// --- Track P21 (CR 601.3e, 701.23g): Allow `castFromLibraryWhileSearching` mid-search ---
	const isCastWhileSearchingOpt =
		fromZone === 'library' &&
		option.id.startsWith('library:while-searching') &&
		Boolean(findCastWhileSearchingLibraryCard(state, actor, inst.instanceId));
	if (state.pendingPrompts.length > 0 && !isCastWhileSearchingOpt) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	// --- End Track P21 ---

	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	const pendingCombatErr = H().getPendingCombatDeclarationError(state);
	if (pendingCombatErr) {
		return { ok: false, error: pendingCombatErr };
	}
	if (priorityPlayer?.playerId !== actorId && !isCastWhileSearchingOpt) {
		return { ok: false, error: 'You do not currently hold priority.' };
	}

	// --- Track P12: CR 702.61a Split second blocks casting spells ---
	if (stackSpellWithSplitSecond(state) !== null) {
		return {
			ok: false,
			error: 'Cannot cast spells while a spell with split second is on the stack (CR 702.61a).'
		};
	}
	// --- End Track P12 ---

	// --- Track P18a: CR 702.50a Epic blocks casting spells for the rest of the game ---
	if (actor.cannotCastSpellsForRestOfGame) {
		return {
			ok: false,
			error: 'Strict Rules Violation: You cannot cast spells for the rest of the game (Epic, CR 702.50a).'
		};
	}
	// --- End Track P18a ---

	// Check global Rule-Modifying Cast Permissions & Restrictions (CR 101.2: "Can't beats Can")
	// Covers Vedalken Orrery, Leyline of Anticipation, Rule of Law, Drannith Magistrate, Grand Abolisher, Teferi
	// --- Track P14: Evaluate castAsThoughFlash against proposed cast face ---
	const castProposalInst: CardInstance =
		option.faceIndex !== undefined && option.faceIndex !== inst.activeFaceIndex
			? { ...inst, activeFaceIndex: option.faceIndex }
			: inst;
	// --- End Track P14 ---
	// --- Track P16a: Turn-scoped cast ban ("can't cast spells this turn" / Silence) ---
	if (actor.cantCastSpellsThisTurn) {
		return {
			ok: false,
			error: `Illegal Cast: ${actor.username} can't cast spells this turn.`
		};
	}
	// --- End Track P16a ---
	const globalCastCheck = checkGlobalCastPermissionsAndRestrictions(
		state,
		actorId,
		castProposalInst,
		fromZone
	);
	if (!globalCastCheck.ok) {
		return { ok: false, error: globalCastCheck.error };
	}

	const isFaceDownCast = Boolean(option.spellMods?.castFaceDown);
	const castName = isFaceDownCast ? 'Face-Down Spell' : inst.card.name;
	const castFaceOpts = {
		zone: 'stack' as const,
		faceIndex: option.faceIndex ?? 0,
		fused: option.fused,
		...(option.spellMods?.prototyped ? { prototyped: true } : {}),
		...(option.spellMods?.castFaceDown
			? { isFaceDown: true, faceDownSpec: option.spellMods.castFaceDown }
			: {})
	};
	const effectiveCard = effectiveCardForObject(inst);
	// --- Track P11: CR 601.3 / 708.2a "Spells with the chosen name can't be cast" (face-down spells have no name) ---
	if (!isFaceDownCast && boardHasAnyChosenCardName(state)) {
		const castView = resolveObjectFaces(effectiveCard, castFaceOpts);
		const chosenSpellBan = isSpellBannedByChosenName(state, actorId, castView.names);
		if (chosenSpellBan.banned) {
			return {
				ok: false,
				error: `Illegal Cast: ${chosenSpellBan.sourceName ?? 'Restriction'} prevents casting spells with the chosen name.`
			};
		}
	}
	// --- End Track P11 ---
	const castChars = activeCharacteristics(effectiveCard, castFaceOpts);
	const castAbilities = activeAbilityDefs(effectiveCard, castFaceOpts);
	const hasFaceFlash =
		castAbilities.some((a) => {
			if (a.kind !== 'keyword') return false;
			const { name: kwName } = a.keyword;
			return kwName === 'flash';
		}) || Boolean(inst.grantedKeywords?.some((k) => k.toLowerCase() === 'flash'));
	const isInstantSpeed =
		option.timing !== 'sorcery_only' &&
		(option.timing === 'instant_only' ||
			(castChars.types.includes('Instant') && !castChars.types.includes('Sorcery')) ||
			hasFaceFlash ||
			globalCastCheck.grantsFlash ||
			// --- Track P16a: Turn/next-spell flash grant (Quicken, Savage Summoning, etc.) ---
			playerHasP16aFlashGrantForTypes(actor, castChars.types) ||
			// --- End Track P16a ---
			Boolean(option.grantFlash) ||
			hasFirstMatchingSpellFlashWave9(
				state,
				actorId,
				castProposalInst,
				option.faceIndex ?? 0,
				Boolean(option.fused)
			));
	if (!isInstantSpeed) {
		if (activePlayer?.playerId !== actorId) {
			return {
				ok: false,
				error: `${castName} can only be cast on your turn at Sorcery speed.`
			};
		}
		if (state.phase !== 'main1' && state.phase !== 'main2') {
			return {
				ok: false,
				error: `${castName} can only be cast during your Main Phase (1 or 2).`
			};
		}
		if (state.stack.length > 0) {
			return {
				ok: false,
				error: `${castName} cannot be cast while spells/abilities are on the Stack.`
			};
		}
	}

	// Check timing restrictions from the IR
	const castRestrictions = isFaceDownCast
		? []
		: spellCastRestrictions(inst.card, option.faceIndex ?? 0, option.fused ?? false);
	if (castRestrictions.includes('duringYourTurn') && activePlayer?.playerId !== actorId) {
		return {
			ok: false,
			error: `Illegal Cast: ${inst.card.name} can only be cast during your turn.`
		};
	}
	if (castRestrictions.includes('duringCombat')) {
		const combatPhases: GamePhase[] = [
			'begin_combat',
			'declare_attackers',
			'declare_blockers',
			'first_strike_damage',
			'combat_damage',
			'end_combat'
		];
		if (!combatPhases.includes(state.phase)) {
			return {
				ok: false,
				error: `Illegal Cast: ${inst.card.name} can only be cast during combat.`
			};
		}
	}
	if (castRestrictions.includes('beforeAttackers')) {
		const preAttackerPhases: GamePhase[] = ['upkeep', 'draw', 'main1', 'begin_combat'];
		if (!preAttackerPhases.includes(state.phase)) {
			return {
				ok: false,
				error: `Illegal Cast: ${inst.card.name} can only be cast before attackers are declared.`
			};
		}
	}
	// --- Track P18b: Expanded "Cast ~ only ..." timing, conditional, & "X can't be 0" restrictions ---
	const selfCastSpec = isFaceDownCast
		? { restrictions: [], conditions: [], xCantBeZero: false }
		: collectSelfCastRestrictions(effectiveCard, option.faceIndex ?? 0);
	for (const r of [...castRestrictions, ...selfCastSpec.restrictions]) {
		const tCheck = checkTimingRestrictionKind(state, actorId, r);
		if (!tCheck.ok) {
			return {
				ok: false,
				error: `Illegal Cast: ${inst.card.name} — ${tCheck.reason ?? 'Timing restriction not met.'}`
			};
		}
	}
	if (selfCastSpec.conditions.length > 0) {
		const castCondCtx: FilterContext = {
			state,
			controllerId: actorId,
			source: inst
		};
		for (const cond of selfCastSpec.conditions) {
			if (!evaluateCondition(cond, castCondCtx)) {
				return {
					ok: false,
					error: `Illegal Cast: ${inst.card.name} cast condition is not met.`
				};
			}
		}
	}
	if (selfCastSpec.xCantBeZero && option.choosesX && strictCostAids && xValue <= 0) {
		return {
			ok: false,
			error: `Illegal Cast: X can't be 0 for ${inst.card.name}.`
		};
	}
	const effectiveXForCheck =
		selfCastSpec.xCantBeZero && option.choosesX && !strictCostAids ? Math.max(1, xValue) : xValue;
	// --- End Track P18b ---

	// Check mana payment (cards with no mana cost like Ancestral Vision / Sol Talisman cannot be cast normally from hand)
	const castManaCost = resolveObjectFaces(effectiveCard, castFaceOpts).manaCost;
	if (
		option.baseCost.kind === 'printed' &&
		castManaCost === '' &&
		!castChars.types.includes('Land')
	) {
		return {
			ok: false,
			error:
				fromZone === 'hand'
					? `${inst.card.name} has no mana cost and cannot be cast normally from hand (use Suspend instead).`
					: `${inst.card.name} has no mana cost and cannot be cast for its printed cost (CR 118.6).`
		};
	}
	const optCountsValidation = validateOptionalCostCounts(option, optionalCostCounts);
	if (!optCountsValidation.ok) {
		return { ok: false, error: optCountsValidation.error };
	}
	const normalizedOptCounts = optCountsValidation.normalized;
	const hasOptCounts = Object.keys(normalizedOptCounts).length > 0;
	const { nonManaDefs: extraNonManaDefs } = expandOptionalAdditionalCosts(option, normalizedOptCounts);
	// --- Track P20b ---
	const optFaceCheck = option.faceIndex ?? 0;
	const optFusedCheck = Boolean(option.fused);
	const isFaceDownCheck = Boolean(option.spellMods?.castFaceDown);
	const checkCmdLife =
		fromZone === 'command' && !isFaceDownCheck
			? getCommanderTaxLifeCostP20b(state, actor, inst, optFaceCheck, optFusedCheck, undefined)
			: { applies: false, totalLife: 0 };
	if (checkCmdLife.applies && checkCmdLife.totalLife > 0 && actor.life < checkCmdLife.totalLife) {
		return { ok: false, error: `Not enough life to pay commander tax (${checkCmdLife.totalLife} life).` };
	}
	const checkPrePitchDefs = [
		...(option.baseCost.kind === 'alternative' ? (option.baseCost.costDefs ?? []) : []),
		...(option.mandatoryAdditionalCosts ?? []),
		...extraNonManaDefs
	];
	const checkPitchCounts =
		!isFaceDownCheck && cardUsesP20bCostPaidCount(inst, optFaceCheck, optFusedCheck)
			? computeMaxAvailableP20bPitchCounts(
					state,
					actor,
					inst,
					checkPrePitchDefs,
					matchesObjectFilter
				)
			: undefined;
	// --- End Track P20b ---
	const costReq = H().getSpellCostRequirementForOption(
		actor,
		inst,
		state,
		// --- Track P18b ---
		effectiveXForCheck,
		// --- End Track P18b ---
		option,
		hasOptCounts ? normalizedOptCounts : undefined,
		// --- Track P20b ---
		undefined,
		undefined,
		checkPitchCounts
		// --- End Track P20b ---
	);
	const spendCtx = H().spellSpendContext(inst, {
		faceIndex: option.faceIndex,
		fused: option.fused,
		isFaceDown: Boolean(option.spellMods?.castFaceDown),
		// --- Track P20b ---
		state,
		xValue: effectiveXForCheck,
		manaCostOverride: option.baseCost.kind === 'alternative' ? option.baseCost.manaCost : undefined
		// --- End Track P20b ---
	});
	let effectiveManaReq = costReq;
	let reservedAidIds = new Set<string>();
	// --- Track P12: Emerge (CR 702.119a) & Harmonize (CR 702.180a) cast legality ---
	if (option.id === 'alt:emerge') {
		const emergePayable = findPayableEmergeCandidates(
			state,
			actor,
			inst,
			option,
			xValue,
			[],
			matchesObjectFilter
		);
		if (emergePayable.length === 0) {
			return {
				ok: false,
				error: `Insufficient mana or no legal permanent to sacrifice for Emerge on ${castName}.`
			};
		}
		effectiveManaReq = emergePayable[0].req;
		reservedAidIds.add(emergePayable[0].perm.instanceId);
	} else if (option.id === 'graveyard:harmonize') {
		const harmPayable = findPayableHarmonizeOptions(state, actor, inst, option, xValue, []);
		if (!harmPayable.noTapReq && harmPayable.tapCandidates.length === 0) {
			return {
				ok: false,
				error: `Insufficient mana to cast ${castName} via Harmonize.`
			};
		}
		if (harmPayable.noTapReq) {
			effectiveManaReq = harmPayable.noTapReq;
		} else {
			effectiveManaReq = harmPayable.tapCandidates[0].req;
			reservedAidIds.add(harmPayable.tapCandidates[0].perm.instanceId);
		}
	// --- Track P18b: Offering (`CR 702.48a–c`) cast legality ---
	} else if (option.id === 'alt:offering') {
		const offPayable = findPayableOfferingCandidates(
			state,
			actor,
			inst,
			option,
			costReq,
			matchesObjectFilter,
			(candReq, resIds) => H().canPayOrAutoTap(actor, candReq, state, undefined, spendCtx, resIds)
		);
		if (offPayable.length === 0) {
			return {
				ok: false,
				error: `Insufficient mana or no legal ${option.offeringQuality ?? 'permanent'} to sacrifice for Offering on ${castName}.`
			};
		}
		effectiveManaReq = offPayable[0].req;
		reservedAidIds.add(offPayable[0].perm.instanceId);
	// --- End Track P18b ---
	} else if (
	// --- End Track P12 ---
		strictCostAids &&
		!(costReq.flexibleSymbols?.length && costAidIds && Object.keys(costAidIds).length > 0)
	) {
		const aidRes = applyCastCostAids(costReq, option, costAidIds, costAidColorChoices);
		if (!aidRes.ok) {
			return { ok: false, error: aidRes.error };
		}
		effectiveManaReq = aidRes.remainingReq;
		for (const id of aidRes.tapIds) reservedAidIds.add(id);
		for (const id of aidRes.exileIds) reservedAidIds.add(id);
		// --- Track P15: CR 702.132a Assist strict mana payment validation ---
		if (aidRes.assistPlayerId && (aidRes.assistGenericPaid ?? 0) > 0) {
			const assistPl = state.players.find(
				(p) => p.playerId === aidRes.assistPlayerId && !p.lost && p.playerId !== actor.playerId
			);
			if (
				!assistPl ||
				!H().canPayOrAutoTap(assistPl, parseManaCost(`{${aidRes.assistGenericPaid}}`), state)
			) {
				return {
					ok: false,
					error: `Chosen player cannot pay {${aidRes.assistGenericPaid}} for Assist.`
				};
			}
		}
		// --- End Track P15 ---
		if (!H().canPayOrAutoTap(actor, effectiveManaReq, state, undefined, spendCtx, reservedAidIds)) {
			return {
				ok: false,
				error: `Insufficient mana to cast ${castName}.`
			};
		}
	} else {
		const manaAidCheck = H().canPayManaWithPaymentAids(
			state,
			actor,
			option,
			costReq,
			spendCtx
		);
		if (!manaAidCheck.ok) {
			return {
				ok: false,
				error: `Insufficient mana to cast ${castName}.`
			};
		}
		reservedAidIds = manaAidCheck.reservedAidIds;
	}
	// Phase 4: additional costs (plus any non-mana alternative costDefs and optional additional costs)
	// from the IR, together with the mana.
	const altCostDefs =
		option.baseCost.kind === 'alternative' ? (option.baseCost.costDefs ?? []) : [];
	const combinedCostDefs = [
		...altCostDefs,
		...(option.mandatoryAdditionalCosts ?? []),
		...extraNonManaDefs
	];
	// --- Track P17a: CR 118.3, 601.2h static cost-payment locks on spell legality ---
	if (combinedCostDefs.length > 0) {
		const castCostLock = checkWave6CostPaymentLocks(
			state,
			actorId,
			combinedCostDefs,
			undefined,
			false
		);
		if (!castCostLock.ok) {
			return { ok: false, error: castCostLock.error! };
		}
	}
	// --- End Track P17a ---
	if (
		combinedCostDefs.length > 0 &&
		!canPayCosts(
			H().costContext(
				state,
				actor,
				inst,
				xValue,
				true,
				effectiveManaReq,
				undefined,
				spendCtx,
				reservedAidIds.size > 0 ? reservedAidIds : undefined,
				strictCostAids
					? undefined
					: (req, resIds) => H().canPayManaWithPaymentAids(state, actor, option, req, spendCtx, undefined, resIds).ok
			),
			combinedCostDefs
		)
	) {
		return {
			ok: false,
			error: `Illegal Cast: you can't pay the additional cost of ${castName}.`
		};
	}

	// --- Track P15: CR 702.174a Gift requires at least one alive opponent ---
	if (
		((normalizedOptCounts['opt:gift'] ?? 0) > 0 || option.spellMods?.giftPromised) &&
		!state.players.some((p) => !p.lost && p.playerId !== actorId)
	) {
		return {
			ok: false,
			error: `Illegal Cast: You cannot promise a gift when you have no opponent (CR 702.174a).`
		};
	}
	// --- End Track P15 ---

	// Check target legality (including multi-target & single-graveyard constraints)
	const spellCompiled = isFaceDownCast
		? null
		: H().compileOptionSpellEffects(
				inst.card,
				option.faceIndex ?? 0,
				Boolean(option.fused),
				Boolean(option.spellMods?.cleaved),
				Boolean(option.spellMods?.giftPromised || (normalizedOptCounts['opt:gift'] ?? 0) > 0)
			);
	if (spellCompiled?.modal && !option.fused && !isFaceDownCast) {
		const activeSpec = (sp: TargetSpec) =>
			!sp.condition || isCastConditionMet(sp.condition, inst.card, normalizedOptCounts, option);
		const status = H().modalCandidateModeStatus(
			state,
			actorId,
			inst.card,
			inst,
			spellCompiled.modal,
			undefined,
			activeSpec
		);
		if (hasChooseAllModesOptionalCost(option, hasOptCounts ? normalizedOptCounts : undefined)) {
			if (status.legalModes.length < spellCompiled.modal.modes.length) {
				return {
					ok: false,
					error: `Illegal Cast: Choosing all modes of ${castName} requires every mode to have legal targets (CR 702.42b).`
				};
			}
			const spellTargetInfo = getSpellTargetRequirement(
				inst.card,
				option,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const targetCheck = hasRequiredLegalTargets(
				state,
				actorId,
				spellTargetInfo,
				inst.card,
				inst.instanceId,
				xValue,
				option
			);
			if (!targetCheck.ok) {
				return targetCheck;
			}
		} else if (!H().hasLegalModalCombination(spellCompiled.modal, status.legalModes)) {
			return {
				ok: false,
				error: `Illegal Cast: No valid mode combination of ${castName} has legal targets.`
			};
		// --- Track P12: Spree (CR 702.172) & Tiered (CR 702.183) per-mode cost legality ---
		} else if (spellCompiled.modal.perModeCosts) {
			const minModes = Math.max(1, spellCompiled.modal.min);
			const legal = status.legalModes;
			let foundPayableModeCombo = false;
			const canPayCombo = (combo: number[]): boolean => {
				const modeExtra = computeModalModeAdditionalCosts(
					inst.card,
					option.faceIndex ?? 0,
					spellCompiled.modal,
					combo
				);
				const comboManaReq = H().getSpellCostRequirementForOption(
					actor,
					inst,
					state,
					xValue,
					option,
					hasOptCounts ? normalizedOptCounts : undefined,
					combo
				);
				const aidCheck = H().canPayManaWithPaymentAids(state, actor, option, comboManaReq, spendCtx);
				if (!aidCheck.ok) return false;
				const allDefs = [...combinedCostDefs, ...modeExtra.costDefs];
				if (allDefs.length === 0) return true;
				return canPayCosts(
					H().costContext(
						state,
						actor,
						inst,
						xValue,
						true,
						comboManaReq,
						undefined,
						spendCtx,
						aidCheck.reservedAidIds.size > 0 ? aidCheck.reservedAidIds : undefined,
						(req, resIds) =>
							H().canPayManaWithPaymentAids(state, actor, option, req, spendCtx, undefined, resIds).ok
					),
					allDefs
				);
			};
			if (minModes === 1) {
				foundPayableModeCombo = legal.some((m) => canPayCombo([m]));
			} else {
				const searchCombos = (start: number, acc: number[]): boolean => {
					if (acc.length === minModes) return canPayCombo(acc);
					for (let i = start; i <= legal.length - (minModes - acc.length); i++) {
						if (searchCombos(i + 1, [...acc, legal[i]])) return true;
					}
					return false;
				};
				foundPayableModeCombo = searchCombos(0, []);
			}
			if (!foundPayableModeCombo) {
				return {
					ok: false,
					error: `Insufficient mana or unpayable mode costs to cast ${castName}.`
				};
			}
		}
		// --- End Track P12 ---
	} else {
		const spellTargetInfo = getSpellTargetRequirement(
			inst.card,
			option,
			hasOptCounts ? normalizedOptCounts : undefined
		);
		const targetCheck = hasRequiredLegalTargets(
			state,
			actorId,
			spellTargetInfo,
			inst.card,
			inst.instanceId,
			xValue,
			option
		);
		if (!targetCheck.ok) {
			return targetCheck;
		}
	}

	return { ok: true };
}

export function findActivatedAbilityTarget(
	state: GameState,
	actor: PlayerGameState,
	instanceId: string,
	abilityId: string
):
	| { ok: true; source: CardInstance; ability: EffectiveActivatedAbility }
	| { ok: false; error: string } {
	const bfPerm =
		actor.battlefield.find((c) => c.instanceId === instanceId) ??
		findPermanentOnBoard(state, instanceId)?.inst;
	const handCard = bfPerm ? undefined : actor.hand.find((c) => c.instanceId === instanceId);
	const graveCard =
		bfPerm || handCard ? undefined : actor.graveyard.find((c) => c.instanceId === instanceId);
	// --- Track P9 ---
	const cmdCard =
		bfPerm || handCard || graveCard
			? undefined
			: actor.command.find((c) => c.instanceId === instanceId);
	const source = bfPerm ?? handCard ?? graveCard ?? cmdCard;
	// --- End Track P9 ---
	if (!source) {
		return {
			ok: false,
			error: 'Card not found on the battlefield, in your hand, in your graveyard, or in the command zone.'
		};
	}
	if (source.zone === 'battlefield' && source.phasedOut) {
		return { ok: false, error: 'Permanent not found on the battlefield.' };
	}
	const cmdId = getPlayerCommanderIdentity(actor);
	const abilities = getEffectiveActivatedAbilities(state, actor, source, cmdId);
	const ab = abilities.find((a) => a.id === abilityId);
	if (!ab) {
		return {
			ok: false,
			error:
				source.zone === 'hand'
					? 'Ability not found on this card in hand.'
					: source.zone === 'graveyard'
						? 'Ability not found on this card in your graveyard.'
						: 'Ability not found on this permanent.'
		};
	}
	// --- Track P15: CR 602.2 Enforce who may activate this battlefield ability ---
	if (source.zone === 'battlefield') {
		const who = ab.activatorWho ?? 'you';
		if (who === 'you' && source.controllerId !== actor.playerId) {
			return {
				ok: false,
				error: 'Only the controller of this permanent may activate this ability (CR 602.2).'
			};
		}
		if (who === 'opponent' && source.controllerId === actor.playerId) {
			return {
				ok: false,
				error: 'Only an opponent may activate this ability (CR 602.2).'
			};
		}
	}
	// --- End Track P15 ---
	const allowedZones = ab.activationZones ?? ['battlefield'];
	if (!allowedZones.includes(source.zone)) {
		return {
			ok: false,
			error: `${source.card.name}: This ability cannot be activated from ${source.zone}.`
		};
	}
	return { ok: true, source, ability: ab };
}

/** Whether `actorId` may activate `ab` of `perm` now. Read-only, one validation (Phase 6d). */
export function checkAbilityActivationLegality(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	ab: EffectiveActivatedAbility,
	// --- Track P20b ---
	xValue?: number,
	// --- End Track P20b ---
	chosenTargets?: TargetRef[]
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		checkAbilityActivationLegalityInner(state, actorId, perm, ab, xValue, chosenTargets)
	);
}

function checkAbilityActivationLegalityInner(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	ab: EffectiveActivatedAbility,
	// --- Track P20b ---
	xValue?: number,
	// --- End Track P20b ---
	chosenTargets?: TargetRef[]
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	if (state.pendingPrompts.length > 0) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	const allowedZones = ab.activationZones ?? ['battlefield'];
	if (perm.zone === 'battlefield') {
		if (perm.phasedOut) {
			return { ok: false, error: `${perm.card.name} is phased out.` };
		}
		if (!findPermanentOnBoard(state, perm.instanceId)) {
			return { ok: false, error: 'Permanent not found on the battlefield.' };
		}
		// --- Track P15: CR 602.2 activatorWho legality ---
		const who = ab.activatorWho ?? 'you';
		if (who === 'you' && perm.controllerId !== actorId) {
			return { ok: false, error: 'Permanent not found on your battlefield.' };
		}
		if (who === 'opponent' && perm.controllerId === actorId) {
			return { ok: false, error: 'Only an opponent may activate this ability (CR 602.2).' };
		}
		// --- End Track P15 ---
		if (!allowedZones.includes('battlefield')) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability cannot be activated from the battlefield.`
			};
		}
	} else if (perm.zone === 'hand') {
		if (!actor.hand.some((c) => c.instanceId === perm.instanceId)) {
			return { ok: false, error: 'Card not found in your hand.' };
		}
		if (!allowedZones.includes('hand')) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability cannot be activated from your hand.`
			};
		}
	} else if (perm.zone === 'graveyard') {
		if (!actor.graveyard.some((c) => c.instanceId === perm.instanceId)) {
			return { ok: false, error: 'Card not found in your graveyard.' };
		}
		if (!allowedZones.includes('graveyard')) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability cannot be activated from your graveyard.`
			};
		}
	// --- Track P9 ---
	} else if (perm.zone === 'command') {
		if (!actor.command.some((c) => c.instanceId === perm.instanceId)) {
			return { ok: false, error: 'Card not found in your command zone.' };
		}
		if (!allowedZones.includes('command')) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability cannot be activated from the command zone.`
			};
		}
	// --- End Track P9 ---
	} else {
		return {
			ok: false,
			error: `${perm.card.name}: This ability cannot be activated from ${perm.zone}.`
		};
	}

	const effectiveAbs = getEffectiveActivatedAbilities(
		state,
		actor,
		perm,
		getPlayerCommanderIdentity(actor)
	);
	if (!effectiveAbs.some((a) => a.id === ab.id)) {
		if (perm.zone === 'battlefield') {
			const abilityLoss = permanentHasLostAllAbilities(perm, state);
			if (abilityLoss.lost) {
				return {
					ok: false,
					error: `${perm.card.name} has lost all abilities (${abilityLoss.sources[0] || 'continuous effect'}).`
				};
			}
		}
		return { ok: false, error: `Ability not found on ${perm.card.name}.` };
	}

	// CR 101.2, 602.5a–b, 604.1: Global rule-modifying & static ability-activation restrictions.
	// --- Track P12: CR 702.61a–b Split second blocks non-mana activated abilities ---
	if (!ab.isManaAbility && stackSpellWithSplitSecond(state) !== null) {
		return {
			ok: false,
			error: 'Cannot activate non-mana abilities while a spell with split second is on the stack (CR 702.61a).'
		};
	}
	// --- End Track P12 ---
	const globalAbCheck = checkGlobalAbilityActivationRestrictions(
		state,
		actorId,
		perm,
		ab.isManaAbility
	);
	if (!globalAbCheck.ok) {
		return globalAbCheck;
	}

	// Phase 4: the whole cost from the IR ({T}/{Q} with summoning sickness, sacrifices, discards,
	// "tap N untapped ...", life, counters and mana), checked by runtime/costs.ts.
	// --- Track P18b & P20b ---
	const minAbX = ab.xCantBeZero ? 1 : 0;
	const checkAbX = xValue !== undefined ? Math.max(minAbX, xValue) : minAbX;
	const isLoyaltyAb = ab.loyaltyCost !== null || Boolean(ab.loyaltySign);
	const manaReqForAbX = (abX: number): ManaCostRequirement =>
		effectiveAbilityManaCost(
			state,
			actorId,
			ab.id,
			// --- Track P17b ---
			ab.baseManaCost ?? ab.manaCost,
			// --- End Track P17b ---
			ab.costKeyword,
			// --- Track P11 & P15 & P18b ---
			abX,
			perm,
			ab.isManaAbility,
			ab.powerUpReduction,
			// --- End Track P11 & P15 & P18b ---
			// --- Track P17b ---
			chosenTargets,
			isLoyaltyAb
			// --- End Track P17b ---
		).requirement;
	const abilityMana = manaReqForAbX(checkAbX);
	// --- End Track P18b & P20b ---
	// --- Track P7 ---
	const permEffCard =
		perm.zone === 'battlefield' ? getEffectiveCardForPermanent(state, perm) : perm.card;
	const abilityCost = activatedAbilityCost(permEffCard, ab);
	// --- End Track P7 ---
	// --- Track P18b & P20b ---
	const checkAbSpendCtx = H().activatedAbilitySpendContext(state, perm, ab, checkAbX);
	const costCtx = H().costContext(
		state,
		actor,
		perm,
		checkAbX,
		false,
		abilityMana,
		undefined,
		checkAbSpendCtx
	);
	// --- End Track P18b & P20b ---
	const checkCost = (): { ok: boolean; error?: string } => {
		// --- Track P17a: CR 118.3, 702.122a, 702.171a cost locks & Crew/Saddle virtual power ---
		const costLock = checkWave6CostPaymentLocks(
			state,
			actorId,
			abilityCost.defs,
			undefined,
			ab.isManaAbility,
			perm
		);
		if (!costLock.ok) return costLock;
		const crewAdjusted = adjustCostDefsForCrewSaddleVirtualPower(
			state,
			actor,
			perm,
			abilityCost.defs
		);
		if (canPayCosts(costCtx, crewAdjusted.defs)) return { ok: true };
		// --- Track P20b: Probe positive X values when UI/AI checks an X-cost ability without explicit xValue ---
		if (xValue === undefined && ab.choosesX) {
			for (let probeX = Math.max(1, minAbX); probeX <= 16; probeX++) {
				const probeMana = manaReqForAbX(probeX);
				const probeSpendCtx = H().activatedAbilitySpendContext(state, perm, ab, probeX);
				if (!H().canPayOrAutoTap(actor, probeMana, state, undefined, probeSpendCtx)) break;
				const probeCtx = H().costContext(
					state,
					actor,
					perm,
					probeX,
					false,
					probeMana,
					undefined,
					probeSpendCtx
				);
				if (canPayCosts(probeCtx, crewAdjusted.defs)) return { ok: true };
			}
		}
		// --- End Track P20b ---
		const plan = planCosts(costCtx, crewAdjusted.defs);
		// --- End Track P17a ---
		return { ok: false, error: plan.ok ? `You can't pay the cost of ${perm.card.name}'s ability.` : plan.error };
	};

	const activePlayer = state.players[state.activePlayerIndex];

	// CR 602.5b / 602.5c: Enforce activation restrictions ("Activate only ...").
	if (
		ab.activationCondition &&
		// --- Track P7 ---
		!H().isAbilityActivationConditionMet(state, actorId, perm, ab.activationCondition)
		// --- End Track P7 ---
	) {
		return {
			ok: false,
			error: `${perm.card.name}: Activation condition is not met.`
		};
	}
	// --- Track P12: Class level, Exhaust, Boast, Forecast restrictions ---
	const classMatch = /^class_level_(\d+)$/.exec(ab.id);
	if (classMatch) {
		const targetLevel = Number(classMatch[1]);
		if ((perm.classLevel ?? 1) !== targetLevel - 1) {
			return {
				ok: false,
				error: `${perm.card.name}: Must be level ${targetLevel - 1} to gain level ${targetLevel} (CR 717.2a).`
			};
		}
	}
	if (ab.costKeyword === 'exhaust' && perm.exhaustedAbilityIds?.includes(ab.id)) {
		return {
			ok: false,
			error: `${perm.card.name}: An exhaust ability can't be activated if it has already been activated (CR 702.177a).`
		};
	}
	if (ab.costKeyword === 'boast') {
		if (!perm.creatureAttackedThisTurn) {
			return {
				ok: false,
				error: `${perm.card.name}: Activate boast abilities only if this creature attacked this turn (CR 702.142a).`
			};
		}
		if (perm.activatedAbilityIdsThisTurn?.includes(ab.id)) {
			return {
				ok: false,
				error: `${perm.card.name}: A boast ability can only be activated once each turn (CR 702.142a).`
			};
		}
	}
	if (ab.costKeyword === 'forecast') {
		const activePl = state.players[state.activePlayerIndex];
		if (activePl?.playerId !== actorId || state.phase !== 'upkeep') {
			return {
				ok: false,
				error: `${perm.card.name}: Forecast abilities can only be activated during your upkeep (CR 702.57b).`
			};
		}
		if (perm.activatedAbilityIdsThisTurn?.includes(ab.id)) {
			return {
				ok: false,
				error: `${perm.card.name}: A forecast ability can only be activated once each turn (CR 702.57b).`
			};
		}
	}
	// --- End Track P12 ---
	// --- Track P15: Craft, Reconfigure unattach, oncePerGame, beforeAttackers, & ±X loyalty ---
	const w5AbErr = checkWave5AbilityActivation(state, actor, perm, ab.id, ab.costKeyword);
	if (w5AbErr) {
		return { ok: false, error: w5AbErr };
	}
	// --- End Track P15 ---
	// --- Track P21: Craft with two that share a card type (CR 702.167) ---
	if (
		ab.costKeyword === 'craft' &&
		selectCraftShareCardTypeMaterials(state, actor, perm) === null
	) {
		return {
			ok: false,
			error: `${perm.card.name}: Requires two other permanents you control and/or cards in your graveyard that share a card type to Craft (CR 702.167).`
		};
	}
	// --- End Track P21 ---
	const restrictions = ab.activationRestrictions;
	if (restrictions?.length) {
		// --- Track P21 (CR 605.3c): "Activate only as an instant." ---
		if (restrictions.includes('onlyAsInstant')) {
			const priorityPl = state.players[state.priorityPlayerIndex];
			if (
				priorityPl?.playerId !== actorId ||
				Boolean(state.pendingCostPayment) ||
				state.pendingPrompts.length > 0 ||
				H().getPendingCombatDeclarationError(state) !== null
			) {
				return {
					ok: false,
					error: `${perm.card.name}: Activate only as an instant (only while you hold priority, CR 605.3c).`
				};
			}
		}
		// --- End Track P21 ---
		if (restrictions.includes('oncePerGame') && perm.usedOncePerGameAbilityIds?.includes(ab.id)) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated once each game.`
			};
		}
		if (restrictions.includes('onceEachTurn') && perm.activatedAbilityIdsThisTurn?.includes(ab.id)) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated once each turn.`
			};
		}
		if (restrictions.includes('duringYourTurn') && activePlayer?.playerId !== actorId) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during your turn.`
			};
		}
		if (
			restrictions.includes('beforeAttackers') &&
			!(
				state.phase === 'upkeep' ||
				state.phase === 'draw' ||
				state.phase === 'main1' ||
				state.phase === 'begin_combat'
			)
		) {
			return {
				ok: false,
				error: `${perm.card.name}: Activate only before attackers are declared.`
			};
		}
		if (
			restrictions.includes('duringYourUpkeep') &&
			(activePlayer?.playerId !== actorId || state.phase !== 'upkeep')
		) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during your upkeep.`
			};
		}
		if (
			restrictions.includes('duringCombat') &&
			!(
				state.phase === 'begin_combat' ||
				state.phase === 'declare_attackers' ||
				state.phase === 'declare_blockers' ||
				state.phase === 'first_strike_damage' ||
				state.phase === 'combat_damage' ||
				state.phase === 'end_combat'
			)
		) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during combat.`
			};
		}
		// --- Track P18b: Widened ActivationRestriction timing kinds ---
		for (const r of restrictions) {
			if (
				r === 'afterAttackers' ||
				r === 'duringBlockers' ||
				r === 'afterBlockers' ||
				r === 'duringOpponentsTurn' ||
				r === 'beforeBlockers' ||
				r === 'afterCombat'
			) {
				const tCheck = checkTimingRestrictionKind(state, actorId, r);
				if (!tCheck.ok) {
					return {
						ok: false,
						error: `${perm.card.name}: ${tCheck.reason ?? 'Timing restriction is not met.'}`
					};
				}
			}
		}
		// --- End Track P18b ---
	}

	if (ab.isManaAbility) {
		return checkCost();
	}

	const pendingCombatErr = H().getPendingCombatDeclarationError(state);
	if (pendingCombatErr) {
		return { ok: false, error: pendingCombatErr };
	}

	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to activate this ability.' };
	}

	// Check "Activate only during your turn" (e.g., Sundial of the Infinite)
	if (/activate only during your turn/i.test(ab.effectText)) {
		if (activePlayer?.playerId !== actorId) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during your turn.`
			};
		}
	}

	if (ab.sorcerySpeedOnly) {
		if (
			activePlayer?.playerId !== actorId ||
			(state.phase !== 'main1' && state.phase !== 'main2') ||
			state.stack.length > 0
		) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated at Sorcery speed (during your Main Phase while the Stack is empty).`
			};
		}
	}

	if (ab.loyaltyCost !== null || ab.loyaltySign !== undefined) {
		if (
			activePlayer?.playerId !== actorId ||
			(state.phase !== 'main1' && state.phase !== 'main2') ||
			state.stack.length > 0
		) {
			return {
				ok: false,
				error: 'Loyalty abilities can only be activated at Sorcery speed.'
			};
		}
		if (perm.usedLoyaltyThisTurn) {
			return {
				ok: false,
				error: 'This Planeswalker has already activated a loyalty ability this turn.'
			};
		}
	}

	const costCheck = checkCost();
	if (!costCheck.ok) return costCheck;

	const abModal =
		// --- Track P7 ---
		ab.modal ??
		getAbilityModal(
			permEffCard,
			ab.id,
			ab.faceIndex ?? 0,
			ab.grantSourceCard,
			ab.grantFaceIndex,
			ab.grantedAbilityText
		);
	// --- End Track P7 ---
	if (abModal) {
		const status = H().modalCandidateModeStatus(
			state,
			actorId,
			// --- Track P7 ---
			permEffCard,
			// --- End Track P7 ---
			perm,
			abModal,
			// --- Track P18b ---
			getEffectiveUsedModalModes(abModal, perm)
			// --- End Track P18b ---
		);
		if (!H().hasLegalModalCombination(abModal, status.legalModes)) {
			return {
				ok: false,
				error: `${perm.card.name}: No legal mode combination is available.`
			};
		}
	} else if (ab.requiresTarget) {
		const abTargetInfo: TargetRequirementInfo = ab.targetInfo;

		const targetCheck = hasRequiredLegalTargets(
			state,
			actorId,
			abTargetInfo,
			// --- Track P7 ---
			permEffCard,
			// --- End Track P7 ---
			perm.instanceId,
			// --- Track P20b ---
			checkAbX
			// --- End Track P20b ---
		);
		if (!targetCheck.ok) {
			// --- Track P20b ---
			if (xValue === undefined && ab.choosesX) {
				const crewAdjusted = adjustCostDefsForCrewSaddleVirtualPower(
					state,
					actor,
					perm,
					abilityCost.defs
				);
				let foundPlayableX = false;
				for (let probeX = Math.max(1, minAbX); probeX <= 16; probeX++) {
					const probeMana = manaReqForAbX(probeX);
					const probeSpendCtx = H().activatedAbilitySpendContext(state, perm, ab, probeX);
					if (!H().canPayOrAutoTap(actor, probeMana, state, undefined, probeSpendCtx)) break;
					const probeCtx = H().costContext(
						state,
						actor,
						perm,
						probeX,
						false,
						probeMana,
						undefined,
						probeSpendCtx
					);
					if (!canPayCosts(probeCtx, crewAdjusted.defs)) continue;
					if (
						hasRequiredLegalTargets(
							state,
							actorId,
							abTargetInfo,
							permEffCard,
							perm.instanceId,
							probeX
						).ok
					) {
						foundPlayableX = true;
						break;
					}
				}
				if (!foundPlayableX) return targetCheck;
			} else {
				return targetCheck;
			}
			// --- End Track P20b ---
		}
	}

	return { ok: true };
}

export function captureTargetObjectVersions(
	state: GameState,
	targets: TargetRef[]
): Record<string, number> | undefined {
	if (targets.length === 0) return undefined;
	const versions: Record<string, number> = {};
	for (const t of targets) {
		if (t.kind === 'permanent') {
			const found = findPermanentOnBoard(state, t.id);
			if (found) versions[t.id] = found.inst.objectVersion ?? 1;
		} else if (t.kind === 'graveyard_card' || t.kind === 'card_in_graveyard') {
			for (const p of state.players) {
				const found = p.graveyard.find((c) => c.instanceId === t.id);
				if (found) {
					versions[t.id] = found.objectVersion ?? 1;
					break;
				}
			}
		} else if (t.kind === 'exile_card') {
			for (const p of state.players) {
				const found = p.exile.find((c) => c.instanceId === t.id);
				if (found) {
					versions[t.id] = found.objectVersion ?? 1;
					break;
				}
			}
		} else if (t.kind === 'stack') {
			const found = state.stack.find((s) => s.id === t.id || s.sourceInstanceId === t.id);
			if (found?.sourceObjectVersion !== undefined) {
				versions[t.id] = found.sourceObjectVersion;
			}
		}
	}
	return Object.keys(versions).length > 0 ? versions : undefined;
}

export function isTargetStillValid(
	state: GameState,
	target: TargetRef,
	controllerId?: string,
	sourceCard?: ScryfallCard,
	item?: StackItem
): boolean {
	const expectedVersion = item?.targetObjectVersions?.[target.id];
	if (target.kind === 'player') {
		const p = state.players.find((pl) => pl.playerId === target.id && !pl.lost);
		if (!p) return false;
		if (playerHasShroud(state, p)) return false;
		if (controllerId && playerHasHexproofFrom(state, p, controllerId)) return false;
		// --- Track P22a ---
		const pItemSrcPerm =
			item && item.kind !== 'spell' && item.sourceInstanceId
				? findPermanentOnBoard(state, item.sourceInstanceId)?.inst
				: undefined;
		if (playerProtectedFromSourceWave8(state, p.playerId, sourceCard, pItemSrcPerm)) {
			return false;
		}
		// --- End Track P22a ---
		return true;
	}
	if (target.kind === 'stack') {
		const stk = state.stack.find(
			(s) => s.id === target.id || (s.kind === 'spell' && s.sourceInstanceId === target.id)
		);
		if (!stk) return false;
		if (
			expectedVersion !== undefined &&
			stk.kind === 'spell' &&
			stk.sourceObjectVersion !== undefined &&
			stk.sourceObjectVersion !== expectedVersion
		) {
			return false;
		}
		return true;
	}
	if (target.kind === 'graveyard_card' || target.kind === 'card_in_graveyard') {
		// --- Track P20a ---
		if (isGraveyardTargetingBlocked(state).blocked) return false;
		// --- End Track P20a ---
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.graveyard.find((x) => x.instanceId === target.id);
			if (c) {
				foundCard = c;
				break;
			}
		}
		if (!foundCard) return false;
		if (expectedVersion !== undefined && foundCard.objectVersion !== expectedVersion) {
			return false;
		}
		return true;
	}
	if (target.kind === 'exile_card') {
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.exile.find((x) => x.instanceId === target.id);
			if (c) {
				foundCard = c;
				break;
			}
		}
		if (!foundCard) return false;
		if (expectedVersion !== undefined && foundCard.objectVersion !== expectedVersion) {
			return false;
		}
		return true;
	}
	const found = findPermanentOnBoard(state, target.id);
	if (!found) return false;
	if (expectedVersion !== undefined && found.inst.objectVersion !== expectedVersion) {
		return false;
	}
	if (hasKeyword(found.inst, 'Shroud', state)) return false;
	if (
		controllerId &&
		found.controller.playerId !== controllerId &&
		!playerIgnoresOpponentHexproofWave9(state, controllerId, found.inst) &&
		(hasKeyword(found.inst, 'Hexproof', state) ||
			hasHexproofFromQuality(found.inst, sourceCard, state))
	) {
		return false;
	}
	// --- Track P20a ---
	const effCtrlId = controllerId || item?.controllerId;
	const itemSrcKind: 'spell' | 'ability' = item?.kind === 'spell' ? 'spell' : 'ability';
	const itemSrcPerm =
		item && item.kind !== 'spell' && item.sourceInstanceId
			? findPermanentOnBoard(state, item.sourceInstanceId)?.inst
			: undefined;
	if (hasProtectionFrom(found.inst, sourceCard, state, itemSrcPerm, false, effCtrlId)) {
		return false;
	}
	if (
		effCtrlId &&
		isPermanentBlockedByCantBeTargetedBy(
			state,
			found.inst,
			effCtrlId,
			sourceCard,
			itemSrcPerm,
			itemSrcKind
		).blocked
	) {
		return false;
	}
	// --- End Track P20a ---
	// A triggered ability with compiled target specs is checked against them instead (resolveTopOfStack).
	if (item && !(item.kind === 'triggered' && H().triggerItemTargetSpecs(item).length > 0)) {
		let targetInfo: TargetRequirementInfo | undefined;
		if (item.kind === 'spell' && (sourceCard || item.card)) {
			targetInfo = getSpellTargetRequirement(
				(sourceCard ?? item.card)!,
				// --- Track P12 ---
				{ faceIndex: item.faceIndex, fused: item.fused, spellMods: item.spellMods } as CastOption,
				// --- End Track P12 ---
				item.optionalCostCounts
			);
		} else if (item.kind === 'activated' && item.abilityId && (sourceCard || item.card)) {
			const faceOpts =
				item.faceIndex !== undefined
					? { zone: 'battlefield' as const, faceIndex: item.faceIndex }
					: undefined;
			const ab = getCardActivatedAbilities((sourceCard ?? item.card)!, [], undefined, faceOpts).find(
				(a) => a.id === item.abilityId
			);
			targetInfo = ab?.targetInfo;
			if (!targetInfo) {
				// --- Track P10 ---
				const comp = H().resolveStackItemCompiledEffects(item);
				// --- End Track P10 ---
				if (comp) targetInfo = targetRequirementFromSpecs(comp.targets);
			}
		} else {
			// --- Track P10 ---
			const comp = H().resolveStackItemCompiledEffects(item);
			// --- End Track P10 ---
			if (comp) targetInfo = targetRequirementFromSpecs(comp.targets);
		}
		if (targetInfo && targetInfo.requiresTarget) {
			if (targetInfo.isModal && targetInfo.modalBranches && targetInfo.modalBranches.length > 0) {
				const anyBranchValid = targetInfo.modalBranches.some(
					(b) =>
						validateTargetLegality(
							state,
							controllerId || item.controllerId,
							target,
							b,
							sourceCard,
							item.sourceInstanceId,
							itemSrcKind,
							item.xValue
						).ok
				);
				if (!anyBranchValid) return false;
			} else if (
				!validateTargetLegality(
					state,
					controllerId || item.controllerId,
					target,
					targetInfo,
					sourceCard,
					item.sourceInstanceId,
					itemSrcKind,
					item.xValue
				).ok
			) {
				return false;
			}
		}
		// --- Track P10 ---
		const compiled = H().resolveStackItemCompiledEffects(item);
		// --- End Track P10 ---
		if (compiled && compiled.targets.length > 0) {
			const itemKicker = getObjectKickerInfo(state, item.card, item.sourceInstanceId, item);
			const activeCompiledTargets = compiled.targets.filter(
				(ts) => !ts.condition || isConditionMetWithKicker(ts.condition, itemKicker)
			);
			const objectSpecs = activeCompiledTargets.filter(
				(ts) => ts.kind === 'object' || ts.kind === 'objectOrPlayer'
			);
			if (objectSpecs.length > 0) {
				const sourceInst = findPermanentOnBoard(state, item.sourceInstanceId)?.inst;
				const fctx: FilterContext = {
					state,
					controllerId: controllerId || item.controllerId,
					source: sourceInst,
					stackItem: item,
					xValue: item.xValue
				};
				const matchesAnySpec = objectSpecs.some((ts) =>
					matchesObjectFilter(found.inst, ts.filter, fctx)
				);
				if (!matchesAnySpec) return false;
			}
		}
	}
	return true;
}
