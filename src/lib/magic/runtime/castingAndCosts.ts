import {
	compileCard,
	compileSpellEffects,
	expandModalEffects,
	getAbilityModal
} from '../compiler/index.ts';
import type { ActivationRestriction, Condition, ObjectFilter, TargetSpec } from '../ir.ts';
import { type ManaCostRequirement, parseManaCost, withStackItemText } from '../oracle.ts';
import {
	effectiveBattlefieldCardAndFaceOpts,
	evaluatePermanent,
	getSpellTargetRequirement
} from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CastCostAid,
	CastOption,
	CostPayment,
	EffectiveActivatedAbility,
	FaceDownSpec,
	GameActionPayload,
	GamePhase,
	GameState,
	ManaColor,
	ManaRider,
	ManaSpendContext,
	PendingCostPayment,
	PlayerGameState,
	SacrificedCostLkiEntry,
	ScryfallCard,
	SpellModifications,
	StackItem,
	TargetRef,
	ZoneType
} from '../types.ts';
import { buildCostChoiceRequest, inferObjectsZone } from './choices.ts';
import {
	evaluateP7Condition,
	getEffectiveCardForPermanent,
	validateAndNormalizeTargetDivisions
} from './copyPreventionAndEffects.ts';
import {
	activatedAbilityCost,
	ALTERNATIVE_COST_KEYWORDS,
	alternativeCostMetaById,
	chooseCostPayment,
	computeKickerTracking,
	type CostContext,
	costModifiersOf,
	type CostQuestion,
	effectiveAbilityManaCost,
	effectiveSpellManaCost,
	executeCostPaymentParts,
	expandOptionalAdditionalCosts,
	keywordAltCost,
	manaAbilityAmount,
	payTapAndManaCostParts,
	spellAdditionalCost,
	spellChoosesX,
	spellOptionalAdditionalCosts
} from './costs.ts';
import { collectActiveAbilityAdditionalCostsWave6 } from './costsWave6.ts';
import {
	collectAbilityManaSpendRestrictionsP20b,
	collectDefilerOptionalCosts,
	collectSpellManaSpendRestrictionsP20b,
	getCommanderTaxLifeCostP20b,
	type P20bPitchCounts,
	recordP20bKeywordActivation,
	syncCastExiledByVersionP20b
} from './costsWave7.ts';
import { collectP13GraveyardAndAirbendCastOptions } from './effectsWave5.ts';
import { consumeP16aOnSpellCast } from './effectsWave6.ts';
import { consumeP19aDelayedSpellCopyOnCast } from './effectsWave7.ts';
import {
	addLog,
	allocateFaceDownLabel,
	cardHasSupportedMultiFace,
	type CastableSourceZone,
	createCardInstance,
	describeTurnUpCost,
	emitVfx,
	findCardAnywhere,
	findPermanentOnBoard,
	getPlayerCommanderIdentity,
	H,
	resetTriggerLoopTracking,
	withModalPrefixAndSuffixEffects
} from './engineHost.ts';
import { emitEvent } from './events.ts';
import { activeAbilityDefs, effectiveManaValue, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import {
	buildAssistCostAid,
	buildWave5OptionalCastCosts,
	checkWave5AbilityActivation,
	collectWave5CastOptionsForCard,
	collectWave5CastTriggers,
	evaluateP15Condition,
	findFaceGiftKeyword,
	payCraftMaterialsOnActivate,
	splicedSpellAbilitiesForOptionalCounts
} from './framesBattlesAndKeywordsWave5.ts';
import { checkTimingRestrictionKind, collectOfferingCastOptionsForCard } from './framesModalsWave6.ts';
import {
	collectWave7LibrarySearchCastOptions,
	pruneCastCardFromActiveLibrarySearchPrompts,
	selectCraftShareCardTypeMaterials
} from './framesWave7.ts';
import { captureNinjutsuAttackTargetFromParts } from './keywordsWave3.ts';
import {
	cardFaceHasAftermath,
	collectWave4CastOptionsForCard,
	computeModalModeAdditionalCosts,
	recordSpellCastWave4
} from './keywordsWave4.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import { permanentRetainsInnateManaAbilities, splitSubtypes } from './layers.ts';
import type { AddManaOptions } from './mana.ts';
import { evaluateAmount, evaluateCondition, matchesObjectFilter } from './objectFilter.ts';
import { buildTrackP3CastOptions, hasExileKeywordPermission } from './orthogonalKeywords.ts';
import { uid } from './random.ts';
import {
	checkAndEmitCrimeCommitted,
	recordSpellManaExpended,
	resolveQuotedActivatedOrTriggeredSteps
} from './reflexiveManaAndActions.ts';
import { activeRuleModifiers, matchesPlayerFilter } from './replace.ts';
import {
	collectWave5ZoneCastOptions,
	consumeWave5StaticPlaySlot,
	hasWave5ExilePlayPermission
} from './staticsAndCostsWave5.ts';
import { collectStaticAltCastOptions } from './staticsDynamicAndCosts.ts';
import { getActiveTopOfLibrarySpellPermissionSource, markHandCardRevealedToAll } from './staticsLayersAndRestrictions.ts';
import {
	adjustCostDefsForCrewSaddleVirtualPower,
	checkWave6CostPaymentLocks,
	collectWave6StaticAltCastOptions,
	getGrantedSpellKeywordsForSpell
} from './staticsWave6.ts';
import { spellReliesOnCleanupSacrificeFlash } from './staticsWave7.ts';
import {
	cardKeepsCountersAcrossZonesWave8,
	collectWave8GraveyardEscapeCastOptions,
	hasSelfGraveyardKeywordCastWave8
} from './staticsWave8.ts';
import {
	collectWave9GrantedEvokeOptions,
	collectWave9ZoneCastOptions,
	getWave9GrantedReplicateOptionalCosts,
	hasFirstMatchingSpellFlashWave9,
	noteAbilityTargetedOwnCreatureWave9
} from './staticsWave9.ts';
import { buildTrackP6CastOptions } from './striatedFrames.ts';
import { enqueuePendingTrigger, flushTriggers } from './triggers.ts';
import { formatManaBundle } from './tuckFreezeChosen.ts';
import { moveObject } from './zones.ts';

function buildCastPaymentAids(
	state: GameState,
	actor: PlayerGameState | undefined,
	inst: CardInstance,
	fromZone: CastableSourceZone,
	faceIndex: number,
	fused: boolean,
	isFaceDown: boolean
): CastCostAid[] | undefined {
	if (!actor || isFaceDown) return undefined;
	const effectiveCard = effectiveCardForObject(inst);
	const abilities = activeAbilityDefs(effectiveCard, { zone: 'stack', faceIndex, fused });
	// --- Track P17a ---
	const staticGrantedSpellKws = getGrantedSpellKeywordsForSpell(
		state,
		actor.playerId,
		inst,
		faceIndex,
		fused
	);
	// --- End Track P17a ---
	const hasKw = (kw: string): boolean =>
		abilities.some((a) => a.kind === 'keyword' && a.keyword.name === kw) ||
		Boolean(inst.grantedKeywords?.some((k) => k.toLowerCase() === kw)) ||
		staticGrantedSpellKws.includes(kw);

	const aids: CastCostAid[] = [];
	if (hasKw('convoke')) {
		const candidateIds: string[] = [];
		const colorsByCandidate: Record<string, ManaColor[]> = {};
		for (const perm of actor.battlefield) {
			if (perm.tapped || perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (!ev.isCreature) continue;
			candidateIds.push(perm.instanceId);
			colorsByCandidate[perm.instanceId] = [...ev.colors];
		}
		if (candidateIds.length > 0) {
			aids.push({
				id: 'aid:convoke',
				label: 'Convoke — Tap creatures to pay mana',
				kind: 'tapPermanent',
				candidateIds,
				colorsByCandidate,
				paysGeneric: 1
			});
		}
	}
	// --- Track P9 ---
	if (hasKw('improvise')) {
		const candidateIds: string[] = [];
		for (const perm of actor.battlefield) {
			if (perm.tapped || perm.phasedOut) continue;
			if (!evaluatePermanent(state, perm).isArtifact) continue;
			candidateIds.push(perm.instanceId);
		}
		if (candidateIds.length > 0) {
			aids.push({
				id: 'aid:improvise',
				label: 'Improvise — Tap artifacts to pay generic mana',
				kind: 'tapPermanent',
				candidateIds,
				paysGeneric: 1
			});
		}
	}
	// --- End Track P9 ---
	if (hasKw('delve')) {
		const candidateIds = actor.graveyard
			.filter((c) => !(fromZone === 'graveyard' && c.instanceId === inst.instanceId))
			.map((c) => c.instanceId);
		if (candidateIds.length > 0) {
			aids.push({
				id: 'aid:delve',
				label: 'Delve — Exile graveyard cards for generic mana',
				kind: 'exileCard',
				candidateIds,
				paysGeneric: 1
			});
		}
	}
	// --- Track P15: CR 702.132a Assist ---
	if (hasKw('assist')) {
		const baseReq = parseManaCost(
			resolveObjectFaces(effectiveCard, { zone: 'stack', faceIndex, fused }).manaCost
		);
		const assistAid = buildAssistCostAid(state, actor, effectiveCard, faceIndex, baseReq.generic);
		if (assistAid) aids.push(assistAid);
	}
	// --- End Track P15 ---
	return aids.length > 0 ? aids : undefined;
}

function enumerateCandidateCastOptions(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone
): CastOption[] {
	// --- Track P15: Preparation spell copy cast from battlefield (CR 723.3c) ---
	if (fromZone === 'battlefield') {
		const bfActor = state.players.find((p) => p.playerId === actorId);
		return bfActor ? collectWave5CastOptionsForCard(state, bfActor, inst, 'battlefield', true) : [];
	}
	// --- End Track P15 ---
	const card = inst.copiableCard ?? inst.card;
	if (fromZone === 'graveyard' && inst.ownerId !== actorId) {
		return [];
	}

	const def = compileCard(card);
	const layout =
		card.layout ?? (card.backFace ? 'transform' : card.faces && card.faces.length >= 2 ? 'split' : 'normal');
	const isMultiFace = cardHasSupportedMultiFace(card);
	const exileAllowed = fromZone === 'exile' ? inst.playableFromExileBy?.allowedFaceIndices : undefined;
	const hasFaceDownKw = (fi: number) =>
		Object.keys(ALTERNATIVE_COST_KEYWORDS).some(
			(kw) => Boolean(ALTERNATIVE_COST_KEYWORDS[kw]?.faceDown) && keywordAltCost(card, kw, fi) !== null
		);

	const candidateFaceIndices: number[] = isMultiFace
		? def.faces
				.map((_, fi) => fi)
				.filter((fi) => {
					const types = def.faces[fi]?.characteristics.types ?? [];
					const isLandOnly = types.includes('Land') && !types.includes('Creature');
					if (isLandOnly && !(fi === 0 && hasFaceDownKw(fi))) return false;
					if (exileAllowed && !exileAllowed.includes(fi)) return false;
					return true;
				})
		: (() => {
				const types = def.faces[0]?.characteristics.types ?? [];
				const isLandOnly = types.includes('Land') && !types.includes('Creature');
				if (isLandOnly && !hasFaceDownKw(0)) return [];
				if (exileAllowed && !exileAllowed.includes(0)) return [];
				return [0];
			})();

	if (candidateFaceIndices.length === 0) {
		return [];
	}

	const actor = state.players.find((p) => p.playerId === actorId);
	const castCount =
		inst.isCommander && fromZone === 'command' && actor
			? (actor.commanderCastCounts?.[inst.instanceId] ?? inst.commanderCastCount ?? 0)
			: 0;
	// --- Track P20b ---
	const cmdLifeTaxPreview =
		castCount > 0 && actor ? getCommanderTaxLifeCostP20b(state, actor, inst, 0, false) : null;
	const taxSuffix =
		castCount > 0
			? cmdLifeTaxPreview?.applies
				? ` + Pay ${cmdLifeTaxPreview.totalLife} life`
				: ` + {${castCount * state.rules.commanderTaxIncrement}}`
			: '';
	// --- End Track P20b ---

	const options: CastOption[] = [];

	for (const fi of candidateFaceIndices) {
		const faceDef = def.faces[fi];
		if (!faceDef) continue;
		const faceChars = faceDef.characteristics;
		const faceTypes = faceChars.types;
		const faceManaCost = faceChars.manaCost;
		const faceName = faceDef.name;
		// --- Track P15: Omen Face 1 shuffles into library on resolution (CR 721.3d) ---
		const isOmenFace =
			isMultiFace &&
			fi === 1 &&
			(layout === 'omen' || (layout === 'adventure' && faceChars.subtypes.includes('Omen')));
		const isAdventureFace = isMultiFace && layout === 'adventure' && fi === 1 && !isOmenFace;
		// --- End Track P15 ---
		const faceIndexProp = isMultiFace ? { faceIndex: fi } : {};
		const idFor = (baseId: string) => (fi === 0 ? baseId : `face:${fi}:${baseId}`);

		const additional = spellAdditionalCost(card, fi, false);
		const mandatoryAdditionalCosts =
			additional && additional.defs.length > 0 ? additional.defs : undefined;
		const optionalAdditionalCosts = [
			...spellOptionalAdditionalCosts(card, fi, false),
			// --- Track P15: Gift (CR 702.174) & Splice (CR 702.47) optional costs ---
			...(actor ? buildWave5OptionalCastCosts(state, actor, inst, fi) : []),
			// --- End Track P15 ---
			// --- Track P20b ---
			...(actor
				? collectDefilerOptionalCosts(
						state,
						actor,
						inst,
						fi,
						false,
						faceManaCost,
						matchesObjectFilter
					)
				: []),
			// --- End Track P20b ---
			...(actor
				? getWave9GrantedReplicateOptionalCosts(
						state,
						actorId,
						inst,
						fi,
						false,
						faceManaCost || '{0}'
					)
				: [])
		];
		const optionalProp =
			optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {};
		const facePaymentAids = buildCastPaymentAids(state, actor, inst, fromZone, fi, false, false);
		const paymentAidsProp = facePaymentAids ? { paymentAids: facePaymentAids } : {};
		const targetInfo = getSpellTargetRequirement(card, { faceIndex: fi } as CastOption);
		const adventureMods: Partial<SpellModifications> = isOmenFace
			? { shuffleOmenOnResolve: true }
			: isAdventureFace
				? { exileAdventureOnResolve: true }
				: {};

		let hasZonePermission = false;
		const isLandOnlyFace = faceTypes.includes('Land') && !faceTypes.includes('Creature');

		if (fromZone === 'hand' || fromZone === 'command') {
			hasZonePermission = true;
			// --- Track P12: CR 702.127a Aftermath half can only be cast from graveyard ---
			const blockedByAftermath = fromZone === 'hand' && fi === 1 && cardFaceHasAftermath(card, 1);
			// --- End Track P12 ---
			if (!isLandOnlyFace && !blockedByAftermath) {
				const baseCost: CastOption['baseCost'] = { kind: 'printed' };
				const label = isAdventureFace
					? `Cast Adventure: ${faceName}`
					: isMultiFace
						? `Cast ${faceName}`
						: 'Cast Normally';
				options.push({
					id: idFor('normal'),
					label,
					costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
					fromZone,
					permission: 'zone_default',
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: 'default',
					spellMods: { ...adventureMods },
					choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: targetInfo.requiresTarget
				});
			}
		} else if (fromZone === 'exile') {
			if (inst.castViaSuspend && fi === 0 && !isLandOnlyFace) {
				const baseCost: CastOption['baseCost'] = { kind: 'free' };
				options.push({
					id: 'exile:suspend',
					label: 'Cast via Suspend',
					costDisplay: '{0}',
					fromZone: 'exile',
					permission: 'exile_permission',
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: 'default',
					spellMods: {},
					choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: targetInfo.requiresTarget
				});
			} else if (inst.playableFromExileBy?.playerId === actorId) {
				const permEx = inst.playableFromExileBy;
				const curSerial = state.turnSerial ?? state.turnNumber;
				// CR 702.170d (Plot): only castable on a later turn as a sorcery without paying its mana cost.
				if (permEx.isPlotted && curSerial <= (permEx.grantedOnTurnSerial ?? 0)) {
					continue;
				}
				hasZonePermission = true;
				if (!isLandOnlyFace) {
					const freeExile = Boolean(permEx.withoutPayingManaCost || permEx.isPlotted);
					const mv = effectiveManaValue(card, { zone: 'stack', faceIndex: fi });
					const baseCost: CastOption['baseCost'] = freeExile
						? { kind: 'free' }
						: permEx.payLifeEqualManaValue
							? { kind: 'alternative', manaCost: '{0}', costDefs: [{ k: 'payLife', amount: { k: 'const', n: mv } }] }
							: permEx.alternativeManaCost !== undefined
								? { kind: 'alternative', manaCost: permEx.alternativeManaCost }
								: { kind: 'printed' };
					const src = permEx.sourceName;
					const freeSuffix = freeExile
						? permEx.isPlotted
							? ' — Plotted'
							: ' — Free'
						: permEx.payLifeEqualManaValue
							? ` — Pay ${mv} Life`
							: '';
					const label = isAdventureFace
						? src
							? `Cast Adventure: ${faceName} from Exile${freeSuffix} (${src})`
							: `Cast Adventure: ${faceName} from Exile${freeSuffix}`
						: isMultiFace
							? src
								? `Cast ${faceName} from Exile${freeSuffix} (${src})`
								: `Cast ${faceName} from Exile${freeSuffix}`
							: src
								? `Cast from Exile${freeSuffix} (${src})`
								: `Cast from Exile${freeSuffix}`;
					const costShown = freeExile
						? '{0}'
						: permEx.payLifeEqualManaValue
							? `Pay ${mv} life`
							: (permEx.alternativeManaCost ?? (faceManaCost || '{0}'));
					options.push({
						id: idFor('exile:permission'),
						label,
						costDisplay: `${costShown}${taxSuffix}`,
						fromZone: 'exile',
						permission: 'exile_permission',
						...faceIndexProp,
						baseCost,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...paymentAidsProp,
						timing: permEx.isPlotted ? 'sorcery_only' : 'default',
						spellMods: { ...adventureMods },
						choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
						requiresTarget: targetInfo.requiresTarget
					});
				}
			}
			// --- Track P13: Airbend {2} cast permission from exile (CR 701.65a) ---
			if (actor && !isLandOnlyFace && inst.airbentCastPermission?.playerId === actorId) {
				hasZonePermission = true;
				const airOpts = collectP13GraveyardAndAirbendCastOptions(
					actor,
					inst,
					'exile',
					isMultiFace ? fi : undefined,
					faceManaCost || '{0}',
					targetInfo.requiresTarget
				);
				for (const aOpt of airOpts) {
					options.push({
						...aOpt,
						costDisplay: `${aOpt.costDisplay}${taxSuffix}`,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...paymentAidsProp,
						spellMods: { ...adventureMods, ...aOpt.spellMods },
						choosesX: spellChoosesX(card, aOpt.baseCost, undefined, fi, false)
					});
				}
			}
			// --- End Track P13 ---
		// --- Track P8 ---
		} else if (fromZone === 'graveyard') {
			// --- Track P13: Temporary graveyard cast permission (e.g. Snapcaster Mage / Yawgmoth's Will) ---
			if (actor && !isLandOnlyFace && inst.playableFromGraveyardBy?.playerId === actorId) {
				hasZonePermission = true;
				const gyOpts = collectP13GraveyardAndAirbendCastOptions(
					actor,
					inst,
					'graveyard',
					isMultiFace ? fi : undefined,
					faceManaCost || '{0}',
					targetInfo.requiresTarget
				);
				for (const gOpt of gyOpts) {
					const isFreeGy = gOpt.baseCost.kind === 'free';
					options.push({
						...gOpt,
						costDisplay: `${gOpt.costDisplay}${taxSuffix}`,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...(isFreeGy ? {} : paymentAidsProp),
						spellMods: { ...adventureMods, ...gOpt.spellMods },
						choosesX: spellChoosesX(card, gOpt.baseCost, undefined, fi, false)
					});
				}
			}
			// --- End Track P13 ---
		} else if (fromZone === 'library') {
			if (actor?.library[0]?.instanceId === inst.instanceId) {
				const srcName = getActiveTopOfLibrarySpellPermissionSource(
					state,
					actorId,
					inst,
					fi,
					false
				);
				if (srcName !== null && !isLandOnlyFace) {
					hasZonePermission = true;
					const baseCost: CastOption['baseCost'] = { kind: 'printed' };
					const label = isAdventureFace
						? `Cast Adventure: ${faceName} from Library (${srcName})`
						: isMultiFace
							? `Cast ${faceName} from Library (${srcName})`
							: `Cast from Top of Library (${srcName})`;
					options.push({
						id: idFor('library:top'),
						label,
						costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
						fromZone: 'library',
						permission: 'library_top_permission',
						...faceIndexProp,
						baseCost,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...paymentAidsProp,
						timing: 'default',
						spellMods: { ...adventureMods },
						choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
						requiresTarget: targetInfo.requiresTarget
					});
				}
			}
		}

		// --- Track P14 ---
		const wave5ZoneOpts = collectWave5ZoneCastOptions({
			state,
			actor,
			actorId,
			inst,
			fromZone,
			faceIndex: fi,
			isMultiFace,
			isAdventureFace,
			faceName,
			faceManaCost,
			faceTypes,
			taxSuffix,
			mandatoryAdditionalCosts,
			optionalAdditionalCosts,
			paymentAids: facePaymentAids,
			adventureMods,
			requiresTarget: targetInfo.requiresTarget,
			choosesX: spellChoosesX(card, { kind: 'printed' }, undefined, fi, false)
		});
		const wave9ZoneOpts = actor
			? collectWave9ZoneCastOptions({
					state,
					actor,
					actorId,
					inst,
					fromZone,
					faceIndex: fi,
					isMultiFace,
					isAdventureFace,
					faceName,
					faceManaCost,
					faceTypes,
					taxSuffix,
					mandatoryAdditionalCosts,
					optionalAdditionalCosts,
					paymentAids: facePaymentAids,
					adventureMods,
					requiresTarget: targetInfo.requiresTarget,
					choosesX: spellChoosesX(card, { kind: 'printed' }, undefined, fi, false)
				})
			: [];
		const combinedZoneOpts = [...wave5ZoneOpts, ...wave9ZoneOpts];
		if (combinedZoneOpts.length > 0) {
			options.push(...combinedZoneOpts);
		}
		const wave5ZoneOpt = combinedZoneOpts[0];
		const hadBaseZonePermission = hasZonePermission;
		if (wave5ZoneOpt) {
			hasZonePermission = true;
		}
		// --- End Track P14 ---
		// --- Track P21: Cast from library while searching (CR 601.3e, Panglacial Wurm) ---
		if (fromZone === 'library') {
			const w7LibOpts = collectWave7LibrarySearchCastOptions({
				state,
				actorId,
				inst,
				faceIndex: fi,
				isMultiFace,
				faceName,
				faceManaCost,
				taxSuffix,
				mandatoryAdditionalCosts,
				optionalAdditionalCosts,
				paymentAids: facePaymentAids,
				adventureMods,
				requiresTarget: targetInfo.requiresTarget,
				choosesX: spellChoosesX(card, { kind: 'printed' }, undefined, fi, false)
			});
			if (w7LibOpts.length > 0) {
				options.push(...w7LibOpts);
				hasZonePermission = true;
			}
		}
		// --- End Track P21 ---

		if (
			!inst.castViaSuspend &&
			!(fromZone === 'exile' && inst.playableFromExileBy?.withoutPayingManaCost)
		) {
			for (const [kwName, meta] of Object.entries(ALTERNATIVE_COST_KEYWORDS)) {
				if (meta.castTransformedBackFace) continue;
				const altCost = keywordAltCost(card, kwName, fi);
				if (!altCost) continue;
				// --- Track P22a: Self graveyard keyword cast ("You may cast ~ from your graveyard using its <kw> ability") ---
				const isSelfGyKw =
					fromZone === 'graveyard' &&
					inst.ownerId === actorId &&
					hasSelfGraveyardKeywordCastWave8(card, fi, kwName, state, actorId, inst);
				if (!isSelfGyKw) {
					if (!(meta.zones as readonly string[]).includes(fromZone)) continue;
					if (meta.requiresZonePermission && !hasZonePermission) continue;
				}
				// --- End Track P22a ---
				// --- Track P14 ---
				const viaWave5Slot =
					meta.requiresZonePermission && !hadBaseZonePermission && wave5ZoneOpt ? wave5ZoneOpt : undefined;
				// --- End Track P14 ---
				if (meta.faceDown) {
					if (isMultiFace && layout !== 'modal_dfc' && fi > 0) continue;
					const baseCost: CastOption['baseCost'] = {
						kind: 'alternative',
						manaCost: meta.faceDown.castManaCost
					};
					const turnUpSummary = describeTurnUpCost(altCost.manaCost, altCost.costDefs);
					const faceDownSpec: FaceDownSpec = {
						kind: meta.faceDown.kind,
						castManaCost: meta.faceDown.castManaCost,
						...(meta.faceDown.wardCost ? { wardCost: meta.faceDown.wardCost } : {}),
						...(altCost.manaCost !== undefined ? { turnUpManaCost: altCost.manaCost } : {}),
						...(altCost.costDefs.length > 0 ? { turnUpCostDefs: altCost.costDefs } : {}),
						...(turnUpSummary ? { turnUpCost: turnUpSummary } : {})
					};
					const spellMods: SpellModifications = {
						castFaceDown: faceDownSpec,
						...(meta.castSummarySuffix ? { castSummarySuffix: meta.castSummarySuffix } : {}),
						...(meta.stackBadgeLabel ? { label: meta.stackBadgeLabel } : {}),
						// --- Track P14 ---
						...(viaWave5Slot?.spellMods?.exileIfPutIntoGraveyard
							? { exileIfPutIntoGraveyard: true }
							: {})
						// --- End Track P14 ---
					};
					options.push({
						id: idFor(meta.id),
						label: meta.label,
						costDisplay: `${meta.faceDown.castManaCost}${taxSuffix}`,
						fromZone,
						permission: fromZone === 'exile' ? 'exile_permission' : 'zone_default',
						...faceIndexProp,
						baseCost,
						timing: meta.timing ?? 'default',
						spellMods,
						choosesX: false,
						requiresTarget: false,
						// --- Track P14 ---
						...(viaWave5Slot?.staticPlaySlotKey
							? { staticPlaySlotKey: viaWave5Slot.staticPlaySlotKey }
							: {})
						// --- End Track P14 ---
					});
					continue;
				}
				if (isLandOnlyFace) continue;
				if (meta.disallowLand && faceTypes.includes('Land')) continue;
				if (meta.spellTypes && meta.spellTypes.length > 0) {
					if (!meta.spellTypes.some((t) => faceTypes.includes(t))) continue;
				}
				const baseCost: CastOption['baseCost'] = {
					kind: 'alternative',
					...(altCost.manaCost !== undefined ? { manaCost: altCost.manaCost } : {}),
					...(altCost.costDefs.length > 0 ? { costDefs: altCost.costDefs } : {})
				};
				const spellMods: SpellModifications = {
					...adventureMods,
					...(meta.targetsBecomeEach ? { targetsBecomeEach: true } : {}),
					...(meta.exileOnLeaveStack ? { exileOnLeaveStack: true } : {}),
					...(meta.evoked ? { evoked: true } : {}),
					...(meta.escaped ? { escaped: true } : {}),
					...(meta.blitzed ? { blitzed: true } : {}),
					...(meta.warped ? { warped: true } : {}),
					// --- Track P9 ---
					...(meta.dashed ? { dashed: true } : {}),
					// --- End Track P9 ---
					// --- Track P18a ---
					...(meta.mutating ? { mutating: true } : {}),
					// --- End Track P18a ---
					// --- Track P14 ---
					...(viaWave5Slot?.spellMods?.exileIfPutIntoGraveyard
						? { exileIfPutIntoGraveyard: true }
						: {}),
					// --- End Track P14 ---
					...(meta.castSummarySuffix ? { castSummarySuffix: meta.castSummarySuffix } : {}),
					...(meta.stackBadgeLabel ? { label: meta.stackBadgeLabel } : {})
				};
				options.push({
					id: idFor(meta.id),
					label: isMultiFace ? `${meta.label} (${faceName})` : meta.label,
					costDisplay: `${altCost.display}${taxSuffix}`,
					fromZone,
					permission: 'keyword_alt',
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: meta.timing ?? 'default',
					spellMods,
					choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: meta.mutating
						? true
						: meta.targetsBecomeEach
							? false
							: targetInfo.requiresTarget,
					// --- Track P18a ---
					...(meta.mutating ? { mutate: true } : {}),
					// --- End Track P18a ---
					// --- Track P14 ---
					...(viaWave5Slot?.staticPlaySlotKey
						? { staticPlaySlotKey: viaWave5Slot.staticPlaySlotKey }
						: {})
					// --- End Track P14 ---
				});
			}
			// --- Track P11: Self & external static alternative cast permissions (CR 118.9) ---
			// --- Track P14: Allow allowedZones static alt-casts & propagate Wave 5 zone slots ---
			if (actor && !isLandOnlyFace) {
				const staticAltOpts = [
					...collectStaticAltCastOptions(
						state,
						actor,
						inst,
						fromZone,
						isMultiFace ? fi : undefined,
						targetInfo.requiresTarget,
						hasZonePermission
					),
					// --- Track P17a ---
					...collectWave6StaticAltCastOptions(
						state,
						actor,
						inst,
						fi,
						false,
						true,
						targetInfo.requiresTarget,
						spellChoosesX(card, { kind: 'printed' }, undefined, fi, false),
						hasZonePermission
					),
					// --- End Track P17a ---
					// --- Track P22a ---
					...(fromZone === 'graveyard'
						? collectWave8GraveyardEscapeCastOptions(
								state,
								actorId,
								inst,
								fi,
								isMultiFace,
								targetInfo.requiresTarget
							)
						: []),
					// --- End Track P22a ---
					...collectWave9GrantedEvokeOptions({
						state,
						actorId,
						inst,
						fromZone,
						faceIndex: fi,
						isMultiFace,
						faceName,
						faceTypes,
						requiresTarget: targetInfo.requiresTarget,
						adventureMods,
						choosesX: spellChoosesX(card, { kind: 'printed' }, undefined, fi, false),
						timing: 'default'
					})
				];
				for (const sOpt of staticAltOpts) {
					const isFreeAlt =
						sOpt.baseCost.kind === 'free' ||
						(sOpt.baseCost.kind === 'alternative' && sOpt.baseCost.manaCost === '{0}');
					const altCostSummary =
						sOpt.baseCost.kind === 'alternative' && sOpt.baseCost.costDefs?.length
							? describeTurnUpCost(
									sOpt.baseCost.manaCost === '{0}' ? undefined : sOpt.baseCost.manaCost,
									sOpt.baseCost.costDefs
								) || sOpt.costDisplay
							: sOpt.costDisplay;
					const viaSlot = !hadBaseZonePermission && wave5ZoneOpt ? wave5ZoneOpt : undefined;
					options.push({
						...sOpt,
						costDisplay: `${altCostSummary}${taxSuffix}`,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...(isFreeAlt ? {} : paymentAidsProp),
						spellMods: {
							...adventureMods,
							...sOpt.spellMods,
							...(viaSlot?.spellMods?.exileIfPutIntoGraveyard
								? { exileIfPutIntoGraveyard: true }
								: {})
						},
						choosesX: spellChoosesX(card, sOpt.baseCost, undefined, fi, false),
						...(viaSlot?.staticPlaySlotKey && !sOpt.staticPlaySlotKey
							? { staticPlaySlotKey: viaSlot.staticPlaySlotKey }
							: {})
					});
				}
			}
			// --- End Track P14 ---
			// --- End Track P11 ---
		}
	}

	if (fromZone !== 'library') {
		options.push(
			...buildTrackP3CastOptions({
				state,
				actorId,
				inst,
				card,
				def,
				fromZone,
				taxSuffix,
				keywordAltCost,
				spellAdditionalCost,
				spellOptionalAdditionalCosts,
				buildPaymentAids: (zone, faceIdx, isFused, isFree) =>
					buildCastPaymentAids(state, actor, inst, zone, faceIdx, isFused, isFree),
				getSpellTargetRequirement,
				spellChoosesX
			}),
			...buildTrackP6CastOptions({
				state,
				actorId,
				inst,
				card,
				def,
				fromZone,
				isMultiFace,
				layout,
				candidateFaceIndices,
				taxSuffix,
				spellAdditionalCost,
				spellOptionalAdditionalCosts,
				buildPaymentAids: (zone, faceIdx, isFused, isFree) =>
					buildCastPaymentAids(state, actor, inst, zone, faceIdx, isFused, isFree),
				getSpellTargetRequirement,
				spellChoosesX
			}),
			// --- Track P12 ---
			...collectWave4CastOptionsForCard({
				state,
				actor,
				actorId,
				inst,
				fromZone,
				taxSuffix,
				matchesFilterFn: matchesObjectFilter,
				buildPaymentAids: (zone, faceIdx, isFused, isFree) =>
					buildCastPaymentAids(state, actor, inst, zone, faceIdx, isFused, isFree),
				getSpellTargetRequirement
			}),
			// --- End Track P12 ---
			// --- Track P15: Cleave, Freerunning, Impending, Prowl, More Than Meets the Eye ---
			...(actor
				? collectWave5CastOptionsForCard(state, actor, inst, fromZone, true).map((o) => {
						const pa = buildCastPaymentAids(
							state,
							actor,
							inst,
							fromZone,
							o.faceIndex ?? 0,
							Boolean(o.fused),
							o.baseCost.kind === 'free'
						);
						return pa ? { ...o, paymentAids: pa } : o;
					})
				: []),
			// --- End Track P15 ---
			// --- Track P18b: Offering (`CR 702.48a–c`) ---
			...collectOfferingCastOptionsForCard({
				state,
				actor,
				actorId,
				inst,
				fromZone,
				taxSuffix,
				mandatoryAdditionalCosts: spellAdditionalCost(card, 0, false)?.defs ?? [],
				optionalAdditionalCosts: spellOptionalAdditionalCosts(card, 0, false),
				buildPaymentAids: (zone, faceIdx, isFused, isFree) =>
					buildCastPaymentAids(state, actor, inst, zone, faceIdx, isFused, isFree),
				getSpellTargetRequirement: (c, fi, fu) =>
					getSpellTargetRequirement(c, { faceIndex: fi, fused: fu }),
				choosesX: spellChoosesX(card, { kind: 'printed' }, undefined, 0, false),
				matchesFilterFn: matchesObjectFilter
			})
			// --- End Track P18b ---
		);
	}

	// CR 702.102: Split card with Fuse cast from hand as both halves (left then right).
	if (
		isMultiFace &&
		layout === 'split' &&
		fromZone === 'hand' &&
		!inst.castViaSuspend &&
		def.faces.length >= 2 &&
		!def.faces[0].characteristics.types.includes('Land') &&
		!def.faces[1].characteristics.types.includes('Land')
	) {
		const hasFuse = def.faces.some((f) =>
			f.abilities.some((a) => {
				if (a.kind !== 'keyword') return false;
				const { name: kwName } = a.keyword;
				return kwName === 'fuse';
			})
		);
		if (hasFuse) {
			const baseCost: CastOption['baseCost'] = { kind: 'printed' };
			const combinedMana = `${def.faces[0].characteristics.manaCost || ''}${def.faces[1].characteristics.manaCost || ''}`;
			const fusedAdditional = spellAdditionalCost(card, 0, true);
			const fusedOptional = spellOptionalAdditionalCosts(card, 0, true);
			const fusedPaymentAids = buildCastPaymentAids(state, actor, inst, 'hand', 0, true, false);
			const fusedTargetInfo = getSpellTargetRequirement(card, {
				faceIndex: 0,
				fused: true
			} as CastOption);
			options.push({
				id: 'fuse',
				label: `Fuse: ${def.faces[0].name} // ${def.faces[1].name}`,
				costDisplay: `${combinedMana || '{0}'}${taxSuffix}`,
				fromZone: 'hand',
				permission: 'zone_default',
				faceIndex: 0,
				fused: true,
				baseCost,
				...(fusedAdditional && fusedAdditional.defs.length > 0
					? { mandatoryAdditionalCosts: fusedAdditional.defs }
					: {}),
				...(fusedOptional.length > 0 ? { optionalAdditionalCosts: fusedOptional } : {}),
				...(fusedPaymentAids ? { paymentAids: fusedPaymentAids } : {}),
				timing: 'default',
				spellMods: { castSummarySuffix: ' (Fused)', label: 'Fused' },
				choosesX: spellChoosesX(card, baseCost, undefined, 0, true),
				requiresTarget: fusedTargetInfo.requiresTarget
			});
		}
	}

	return options;
}

export function resolveCastOptionForAction(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType,
	optionId?: string,
	faceIndex?: number,
	fused?: boolean
): { ok: true; option: CastOption } | { ok: false; error: string } {
	const card = inst.copiableCard ?? inst.card;
	const def = compileCard(card);
	const allLandFaces =
		def.faces.length > 0 &&
		def.faces.every(
			(f) => f.characteristics.types.includes('Land') && !f.characteristics.types.includes('Creature')
		);
	if (
		fromZone !== 'hand' &&
		fromZone !== 'command' &&
		fromZone !== 'exile' &&
		fromZone !== 'graveyard' &&
		fromZone !== 'library' &&
		// --- Track P15 ---
		fromZone !== 'battlefield'
		// --- End Track P15 ---
	) {
		return { ok: false, error: 'Spells can only be cast from your Hand, Command Zone, or Exile.' };
	}
	if (
		fromZone === 'exile' &&
		inst.playableFromExileBy?.playerId !== actorId &&
		// --- Track P13 ---
		inst.airbentCastPermission?.playerId !== actorId &&
		// --- End Track P13 ---
		!inst.castViaSuspend &&
		!hasExileKeywordPermission(inst, actorId) &&
		// --- Track P14 ---
		!hasWave5ExilePlayPermission(state, actorId, inst)
		// --- End Track P14 ---
	) {
		return {
			ok: false,
			error: `You do not have permission to cast ${inst.card.name} from Exile.`
		};
	}

	const candidates = enumerateCandidateCastOptions(state, actorId, inst, fromZone);

	if (optionId !== undefined) {
		const match = candidates.find((o) => o.id === optionId);
		if (match) {
			if (allLandFaces && !match.spellMods?.castFaceDown) {
				return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
			}
			return { ok: true, option: match };
		}

		const altMeta = alternativeCostMetaById(optionId);
		if (altMeta) {
			if (
				inst.castViaSuspend ||
				(fromZone === 'exile' && inst.playableFromExileBy?.withoutPayingManaCost)
			) {
				return {
					ok: false,
					error: 'Only one alternative cost can be applied to a spell (CR 118.9a).'
				};
			}
			const hasAltOnAnyFace = def.faces.some((_, fi) => keywordAltCost(card, altMeta.keyword, fi) !== null);
			if (!hasAltOnAnyFace) {
				const kwLabel = `${altMeta.keyword[0].toUpperCase()}${altMeta.keyword.slice(1)}`;
				return { ok: false, error: `${inst.card.name} does not have ${kwLabel}.` };
			}
		}
		if (fromZone === 'graveyard') {
			return { ok: false, error: 'Spells can only be cast from your Hand, Command Zone, or Exile.' };
		}
		if (allLandFaces && !altMeta?.meta.faceDown) {
			return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
		}
		return {
			ok: false,
			error: `Cast option '${optionId}' is not valid for ${inst.card.name} from ${fromZone}.`
		};
	}

	if (allLandFaces) {
		return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
	}

	if (fused) {
		const fusedOpt = candidates.find((o) => o.fused);
		if (fusedOpt) return { ok: true, option: fusedOpt };
		return {
			ok: false,
			error: `${inst.card.name} cannot be cast fused from ${fromZone}.`
		};
	}

	if (faceIndex !== undefined) {
		const requestedFace = def.faces[faceIndex];
		if (
			requestedFace &&
			requestedFace.characteristics.types.includes('Land') &&
			!requestedFace.characteristics.types.includes('Creature')
		) {
			return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
		}
		const faceOpt = candidates.find((o) => (o.faceIndex ?? 0) === faceIndex && !o.fused);
		if (faceOpt) return { ok: true, option: faceOpt };
		return {
			ok: false,
			error: `Face ${faceIndex} of ${inst.card.name} cannot be cast from ${fromZone}.`
		};
	}

	if (candidates.length === 0) {
		return {
			ok: false,
			error:
				fromZone === 'graveyard'
					? 'Spells can only be cast from your Hand, Command Zone, or Exile.'
					: `No cast option is available for ${inst.card.name} from ${fromZone}.`
		};
	}

	const defaultOpt =
		candidates.find((o) => o.id === 'normal') ??
		candidates.find((o) => o.id === 'library:top') ??
		// --- Track P15 ---
		candidates.find((o) => o.id === 'battlefield:prepare_copy') ??
		// --- End Track P15 ---
		candidates.find((o) => o.id === 'exile:suspend') ??
		candidates.find((o) => o.id === 'exile:permission') ??
		candidates.find((o) => o.id === 'exile:foretell') ??
		candidates.find((o) => o.id === 'exile:plot') ??
		candidates.find((o) => o.id === 'exile:warp') ??
		(candidates.length === 1 ? candidates[0] : undefined);
	if (!defaultOpt) {
		return { ok: false, error: 'Choose how to cast this spell (optionId is required).' };
	}
	return { ok: true, option: defaultOpt };
}

export interface PlannedCastCostAids {
	costAidIds: Record<string, string[]>;
	costAidColorChoices: Record<string, ManaColor | 'generic'>;
	remainingReq: ManaCostRequirement;
	reservedTapIds: Set<string>;
	reservedExileIds: Set<string>;
}

/**
 * Greedily selects eligible `CastCostAid` candidates (`tapPermanent` / `exileCard`) to satisfy or
 * reduce `costReq` when casting a spell, stopping early unless `preferUseAids` is true.
 */
export function planCastCostAids(
	state: GameState,
	actor: PlayerGameState,
	option: CastOption,
	costReq: ManaCostRequirement,
	spendCtx: ManaSpendContext = { isSpell: false },
	phyrexianLifeCount?: number,
	reservedIds?: ReadonlySet<string>,
	preferUseAids = false
): PlannedCastCostAids {
	const emptyResult: PlannedCastCostAids = {
		costAidIds: {},
		costAidColorChoices: {},
		remainingReq: costReq,
		reservedTapIds: new Set<string>(),
		reservedExileIds: new Set<string>()
	};
	const aids = option.paymentAids;
	if (!aids || aids.length === 0) return emptyResult;
	if (!preferUseAids && H().canPayOrAutoTap(actor, costReq, state, phyrexianLifeCount, spendCtx, reservedIds)) {
		return emptyResult;
	}

	const remaining: ManaCostRequirement = {
		...costReq,
		colored: { ...costReq.colored }
	};
	const costAidIds: Record<string, string[]> = {};
	const costAidColorChoices: Record<string, ManaColor | 'generic'> = {};
	const used = new Set<string>(reservedIds);
	const reservedTapIds = new Set<string>();
	const reservedExileIds = new Set<string>();
	const currentReserved = (): ReadonlySet<string> | undefined => (used.size > 0 ? used : undefined);
	const canCurrentlyPay = (): boolean =>
		H().canPayOrAutoTap(actor, remaining, state, phyrexianLifeCount, spendCtx, currentReserved());

	const aidColors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	const hasGraveyardCastKeyword = (c: CardInstance): boolean =>
		compileCard(c.card).faces.some((f) =>
			f.abilities.some(
				(a) =>
					a.kind === 'keyword' &&
					Boolean(ALTERNATIVE_COST_KEYWORDS[a.keyword.name]?.zones.includes('graveyard'))
			)
		);

	for (const aid of aids) {
		if (aid.kind !== 'exileCard') continue;
		const eligible = aid.candidateIds
			.filter((id) => !used.has(id))
			.map((id) => actor.graveyard.find((c) => c.instanceId === id))
			.filter((c): c is CardInstance => Boolean(c))
			.sort((a, b) => {
				const aGy = hasGraveyardCastKeyword(a) ? 1 : 0;
				const bGy = hasGraveyardCastKeyword(b) ? 1 : 0;
				if (aGy !== bGy) return aGy - bGy;
				return (a.card.cmc ?? 0) - (b.card.cmc ?? 0);
			});
		const maxRed = aid.maxGenericReduction ?? remaining.generic;
		let reduced = 0;
		for (const c of eligible) {
			if (!preferUseAids && canCurrentlyPay()) break;
			if (remaining.generic < aid.paysGeneric || reduced + aid.paysGeneric > maxRed) break;
			used.add(c.instanceId);
			reservedExileIds.add(c.instanceId);
			(costAidIds[aid.id] ??= []).push(c.instanceId);
			costAidColorChoices[c.instanceId] = 'generic';
			remaining.generic -= aid.paysGeneric;
			reduced += aid.paysGeneric;
		}
	}

	const cmdIdentity = getPlayerCommanderIdentity(actor);
	// --- Track P14 ---
	const genericReducedByAid = new Map<string, number>();
	// --- End Track P14 ---
	const pickTapFromPool = (
		aid: CastCostAid,
		pool: Array<{ perm: CardInstance; colors: ManaColor[] }>,
		keepGoingWhenPayable: boolean
	): void => {
		const remainingPool = [...pool];
		const maxTapSteps = remainingPool.length;
		for (let step = 0; step < maxTapSteps; step++) {
			if (remainingPool.length === 0 || (!keepGoingWhenPayable && canCurrentlyPay())) break;
			const neededColors = aidColors.filter((c) => remaining.colored[c] > 0);
			// --- Track P14 ---
			const prevGenRed = genericReducedByAid.get(aid.id) ?? 0;
			const withinCap =
				aid.maxGenericReduction === undefined ||
				prevGenRed + aid.paysGeneric <= aid.maxGenericReduction;
			const canPayGeneric = withinCap && remaining.generic >= aid.paysGeneric;
			// --- End Track P14 ---
			if (neededColors.length === 0 && !canPayGeneric) break;

			let bestIdx = -1;
			let bestChoice: ManaColor | 'generic' | null = null;
			let bestRank = Number.POSITIVE_INFINITY;

			for (let i = 0; i < remainingPool.length; i++) {
				const { perm, colors } = remainingPool[i];
				const matchingNeeded = colors.filter((c) => remaining.colored[c] > 0);
				if (matchingNeeded.length === 0 && !canPayGeneric) continue;
				const pow = evaluatePermanent(state, perm).power;
				if (matchingNeeded.length > 0) {
					// Most-constrained color-matching permanent first, then lower power.
					const rank = matchingNeeded.length * 1000 + colors.length * 100 + pow;
					if (rank < bestRank) {
						bestRank = rank;
						bestIdx = i;
						bestChoice = matchingNeeded[0];
					}
				} else if (canPayGeneric) {
					const rank = 100_000 + colors.length * 100 + pow;
					if (rank < bestRank) {
						bestRank = rank;
						bestIdx = i;
						bestChoice = 'generic';
					}
				}
			}

			if (bestIdx < 0 || !bestChoice) break;
			const [{ perm }] = remainingPool.splice(bestIdx, 1);
			used.add(perm.instanceId);
			reservedTapIds.add(perm.instanceId);
			(costAidIds[aid.id] ??= []).push(perm.instanceId);
			costAidColorChoices[perm.instanceId] = bestChoice;
			if (bestChoice === 'generic') {
				remaining.generic -= aid.paysGeneric;
				// --- Track P14 ---
				genericReducedByAid.set(aid.id, prevGenRed + aid.paysGeneric);
				// --- End Track P14 ---
			} else {
				remaining.colored[bestChoice] -= 1;
			}
		}
	};

	for (const aid of aids) {
		if (aid.kind !== 'tapPermanent') continue;
		const nonMana: Array<{ perm: CardInstance; colors: ManaColor[] }> = [];
		const manaDorks: Array<{ perm: CardInstance; colors: ManaColor[] }> = [];
		for (const id of aid.candidateIds) {
			if (used.has(id)) continue;
			const perm = actor.battlefield.find((c) => c.instanceId === id);
			if (!perm || perm.tapped || perm.phasedOut) continue;
			const colors = aid.colorsByCandidate?.[id] ?? [];
			const hasManaAb = H().autoTapManaAbilities(state, actor, perm, cmdIdentity, spendCtx).length > 0;
			if (hasManaAb) manaDorks.push({ perm, colors });
			else nonMana.push({ perm, colors });
		}
		pickTapFromPool(aid, nonMana, preferUseAids);
		if (!canCurrentlyPay()) {
			pickTapFromPool(aid, manaDorks, false);
		}
	}

	// --- Track P15: CR 702.132a Assist generic mana payment from another player ---
	for (const aid of aids) {
		if (aid.kind !== 'assistPlayer') continue;
		if (!preferUseAids && canCurrentlyPay()) continue;
		const maxRed = Math.min(aid.maxGenericReduction ?? remaining.generic, remaining.generic);
		if (maxRed <= 0) continue;
		for (const candPlayerId of aid.candidateIds) {
			const candPlayer = state.players.find((p) => p.playerId === candPlayerId && !p.lost);
			if (!candPlayer) continue;
			let maxAssist = 0;
			for (let g = maxRed; g >= 1; g--) {
				if (H().canPayOrAutoTap(candPlayer, parseManaCost(`{${g}}`), state)) {
					maxAssist = g;
					break;
				}
			}
			if (maxAssist <= 0) continue;
			costAidIds[aid.id] = Array.from({ length: maxAssist }, () => candPlayerId);
			remaining.generic -= maxAssist;
			if (canCurrentlyPay()) break;
			delete costAidIds[aid.id];
			remaining.generic += maxAssist;
		}
	}
	// --- End Track P15 ---

	return { costAidIds, costAidColorChoices, remainingReq: remaining, reservedTapIds, reservedExileIds };
}

export function canPayManaWithPaymentAids(
	state: GameState,
	actor: PlayerGameState,
	option: CastOption,
	costReq: ManaCostRequirement,
	spendCtx: ManaSpendContext,
	phyrexianLifeCount?: number,
	reservedIds?: ReadonlySet<string>
): { ok: boolean; reservedAidIds: Set<string> } {
	if (H().canPayOrAutoTap(actor, costReq, state, phyrexianLifeCount, spendCtx, reservedIds)) {
		return { ok: true, reservedAidIds: new Set<string>() };
	}
	if (!option.paymentAids || option.paymentAids.length === 0) {
		return { ok: false, reservedAidIds: new Set<string>() };
	}
	const planned = planCastCostAids(
		state,
		actor,
		option,
		costReq,
		spendCtx,
		phyrexianLifeCount,
		reservedIds,
		false
	);
	const reserved = new Set<string>(reservedIds);
	for (const id of planned.reservedTapIds) reserved.add(id);
	for (const id of planned.reservedExileIds) reserved.add(id);
	const ok = H().canPayOrAutoTap(actor, planned.remainingReq, state, phyrexianLifeCount, spendCtx, reserved);
	return { ok, reservedAidIds: reserved };
}

export function getSpellOptionCostRequirement(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	option: CastOption,
	xValue = 0,
	optionalCostCounts?: Record<string, number>,
	// --- Track P20b ---
	chosenTargets?: TargetRef[]
	// --- End Track P20b ---
): ManaCostRequirement | null {
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor) return null;
	return withStableLayerInputs(state, () =>
		getSpellCostRequirementForOption(
			actor,
			inst,
			state,
			xValue,
			option,
			optionalCostCounts,
			undefined,
			chosenTargets
		)
	);
}

/**
 * Enumerates all currently legal ways `actorId` can cast `inst` from `fromZone` (CR 601.2, 118.9).
 * Read-only: shares one layer-cache validation across all option checks.
 */
export function getCastOptions(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone
): CastOption[] {
	return withStableLayerInputs(state, () => getCastOptionsInner(state, actorId, inst, fromZone));
}

function getCastOptionsInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone
): CastOption[] {
	const candidates = enumerateCandidateCastOptions(state, actorId, inst, fromZone);
	return candidates.filter((opt) => {
		if (H().checkSpellCastOptionLegalityInner(state, actorId, inst, fromZone, 0, opt).ok) {
			return true;
		}
		if (opt.choosesX && H().checkSpellCastOptionLegalityInner(state, actorId, inst, fromZone, 1, opt).ok) {
			return true;
		}
		// --- Track P20b ---
		if (opt.optionalAdditionalCosts?.some((o) => o.id.startsWith('defiler:'))) {
			const defilerCounts: Record<string, number> = {};
			for (const o of opt.optionalAdditionalCosts) {
				if (o.id.startsWith('defiler:')) defilerCounts[o.id] = o.maxCount;
			}
			if (H().checkSpellCastOptionLegalityInner(state, actorId, inst, fromZone, 0, opt, defilerCounts).ok) {
				return true;
			}
		}
		for (const o of opt.optionalAdditionalCosts ?? []) {
			if (
				o.enablesTarget &&
				H().checkSpellCastOptionLegalityInner(state, actorId, inst, fromZone, 0, opt, { [o.id]: 1 }).ok
			) {
				return true;
			}
		}
		if (opt.choosesX) {
			for (let probeX = 2; probeX <= 16; probeX++) {
				const probeRes = H().checkSpellCastOptionLegalityInner(
					state,
					actorId,
					inst,
					fromZone,
					probeX,
					opt
				);
				if (probeRes.ok) return true;
				if (probeRes.error?.startsWith('Insufficient mana')) break;
			}
		}
		// --- End Track P20b ---
		return false;
	});
}

function hasGlobalSpendManaAsAnyColor(state: GameState, player: PlayerGameState): boolean {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (perm.phasedOut || evaluatePermanent(state, perm).losesAllAbilities) continue;
			for (const ab of activeAbilityDefs(
				effectiveCardForObject(perm),
				instanceFaceOptions(perm, 'battlefield')
			)) {
				if (
					ab.kind === 'static' &&
					ab.static.k === 'ruleModifier' &&
					ab.static.rule === 'spendManaAsAnyColor'
				) {
					if (matchesPlayerFilter(ab.static.who, perm.controllerId, player.playerId, state)) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

// --- Track P15: Cleave (CR 702.148), Gift-promised (CR 702.174b), & Splice (CR 702.47c) spell IR helpers ---
export function compileOptionSpellEffects(
	card: ScryfallCard,
	faceIndex = 0,
	fused = false,
	cleaved = false,
	giftPromised = false,
	chosenModes?: number[]
) {
	if (!fused && (cleaved || giftPromised)) {
		const face = compileCard(card).faces[faceIndex];
		const altSpec = cleaved
			? face?.cleavedSpellSpec
			: giftPromised
				? face?.giftPromisedSpellSpec
				: undefined;
		if (altSpec) {
			if (altSpec.modal && chosenModes) {
				const expanded = expandModalEffects(altSpec.modal, chosenModes);
				if (expanded) {
					// --- Track P18b ---
					return withModalPrefixAndSuffixEffects(
						{
							steps: expanded.steps,
							targets: expanded.targets,
							modal: altSpec.modal,
							unparsed: [] as string[]
						},
						chosenModes
					);
					// --- End Track P18b ---
				}
			}
			return {
				steps: [...altSpec.effect],
				targets: [...altSpec.targets],
				...(altSpec.modal ? { modal: altSpec.modal } : {}),
				unparsed: [] as string[]
			};
		}
	}
	const base = compileSpellEffects(card, faceIndex, fused);
	if (base && chosenModes && base.modal) {
		const expanded = expandModalEffects(base.modal, chosenModes);
		if (expanded) {
			// --- Track P18b ---
			return withModalPrefixAndSuffixEffects(
				{
					steps: expanded.steps,
					targets: expanded.targets,
					modal: base.modal,
					unparsed: base.unparsed
				},
				chosenModes
			);
			// --- End Track P18b ---
		}
	}
	return base;
}
// --- End Track P15 ---

export function getSpellCostRequirementForOption(
	player: PlayerGameState,
	inst: CardInstance,
	state: GameState,
	xValue: number,
	option: CastOption,
	optionalCostCounts?: Record<string, number>,
	// --- Track P12 ---
	chosenModes?: number[],
	// --- End Track P12 ---
	// --- Track P11 ---
	chosenTargets?: TargetRef[],
	// --- End Track P11 ---
	// --- Track P20b ---
	p20bPitchCounts?: P20bPitchCounts
	// --- End Track P20b ---
): ManaCostRequirement {
	const applyAnyColorPermission = (req: ManaCostRequirement): ManaCostRequirement => {
		const fromExile =
			inst.zone === 'exile' &&
			inst.playableFromExileBy?.playerId === player.playerId &&
			inst.playableFromExileBy.spendManaAsAnyColor;
		const fromGlobal = hasGlobalSpendManaAsAnyColor(state, player);
		// --- Track P19a ---
		const fromLibrary =
			inst.zone === 'library' && Boolean(player.spendManaAsAnyColorFromTopOfLibraryThisTurn);
		if (fromExile || fromGlobal || fromLibrary || option.spendManaAsAnyColor) {
		// --- End Track P19a ---
			const coloredTotal =
				req.colored.W + req.colored.U + req.colored.B + req.colored.R + req.colored.G;
			if (coloredTotal > 0) {
				return {
					...req,
					colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: req.colored.C },
					generic: req.generic + coloredTotal
				};
			}
		}
		return req;
	};

	const { manaCosts: extraManaCosts } = expandOptionalAdditionalCosts(option, optionalCostCounts);
	// --- Track P12 + P15: Spree / Tiered / Escalate + Cleave / Gift modal per-mode mana costs ---
	const compiledModal = option.spellMods?.castFaceDown
		? undefined
		: compileOptionSpellEffects(
				inst.card,
				option.faceIndex ?? 0,
				Boolean(option.fused),
				Boolean(option.spellMods?.cleaved),
				Boolean(option.spellMods?.giftPromised || (optionalCostCounts?.['opt:gift'] ?? 0) > 0)
			)?.modal;
	const modalExtra = computeModalModeAdditionalCosts(
		inst.card,
		option.faceIndex ?? 0,
		compiledModal,
		chosenModes
	);
	const allExtraManaCosts =
		modalExtra.manaCosts.length > 0
			? [...extraManaCosts, ...modalExtra.manaCosts]
			: extraManaCosts;
	// --- End Track P12 ---
	// --- Track P17b ---
	const p17bKickerTags = optionalCostCounts
		? computeKickerTracking(
				inst.card,
				optionalCostCounts,
				{ spellMods: option.spellMods },
				option.faceIndex ?? 0,
				Boolean(option.fused)
			).tags
		: undefined;
	const finalExtraManaCosts = option.spellMods?.additionalManaCost
		? [...allExtraManaCosts, option.spellMods.additionalManaCost]
		: allExtraManaCosts;
	// --- End Track P17b ---
	return applyAnyColorPermission(
		effectiveSpellManaCost(
			state,
			player,
			inst,
			xValue,
			option.baseCost,
			finalExtraManaCosts,
			option.faceIndex ?? 0,
			option.fused ?? false,
			option.spellMods?.castFaceDown,
			option.spellMods?.prototyped,
			// --- Track P11 ---
			chosenTargets,
			// --- End Track P11 ---
			// --- Track P17b & P20b ---
			{
				optionId: option.id,
				kickedTags: p17bKickerTags,
				optionalCostCounts,
				p20bPitchCounts
			}
			// --- End Track P17b & P20b ---
		)
	);
}

export function getSpellCostRequirement(
	player: PlayerGameState,
	inst: CardInstance,
	state: GameState,
	xValue = 0,
	optionId?: string,
	optionalCostCounts?: Record<string, number>,
	// --- Track P20b ---
	chosenTargets?: TargetRef[]
	// --- End Track P20b ---
): ManaCostRequirement {
	const fromZone: CastableSourceZone =
		inst.zone === 'command' ||
		inst.zone === 'exile' ||
		inst.zone === 'graveyard' ||
		inst.zone === 'library'
			? inst.zone
			: 'hand';
	const resolved = resolveCastOptionForAction(state, player.playerId, inst, fromZone, optionId);
	if (resolved.ok) {
		return getSpellCostRequirementForOption(
			player,
			inst,
			state,
			xValue,
			resolved.option,
			optionalCostCounts,
			undefined,
			chosenTargets
		);
	}
	const altMeta = optionId ? alternativeCostMetaById(optionId) : null;
	const altCost = altMeta ? keywordAltCost(inst.copiableCard ?? inst.card, altMeta.keyword) : null;
	const fallbackBase: CastOption['baseCost'] =
		altCost !== null
			? {
					kind: 'alternative',
					...(altCost.manaCost !== undefined ? { manaCost: altCost.manaCost } : {}),
					...(altCost.costDefs.length > 0 ? { costDefs: altCost.costDefs } : {})
				}
			: { kind: 'printed' };
	return effectiveSpellManaCost(state, player, inst, xValue, fallbackBase);
}

export function chooseBotSpellCostPayment(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	xValue = 0,
	optionId?: string,
	optionalCostCounts?: Record<string, number>
): CostPayment | undefined {
	const fromZone: CastableSourceZone =
		inst.zone === 'command' ||
		inst.zone === 'exile' ||
		inst.zone === 'graveyard' ||
		inst.zone === 'library'
			? inst.zone
			: 'hand';
	const resolved = resolveCastOptionForAction(state, player.playerId, inst, fromZone, optionId);
	const altDefs =
		resolved.ok && resolved.option.baseCost.kind === 'alternative'
			? (resolved.option.baseCost.costDefs ?? [])
			: [];
	const { nonManaDefs: extraNonManaDefs } = resolved.ok
		? expandOptionalAdditionalCosts(resolved.option, optionalCostCounts)
		: { nonManaDefs: [] };
	const optFace = resolved.ok ? (resolved.option.faceIndex ?? 0) : 0;
	const optFused = resolved.ok ? Boolean(resolved.option.fused) : false;
	const additional =
		resolved.ok && resolved.option.spellMods?.castFaceDown
			? null
			: spellAdditionalCost(inst.card, optFace, optFused);
	const mandatoryDefs = resolved.ok
		? (resolved.option.mandatoryAdditionalCosts ?? [])
		: (additional?.defs ?? []);
	const defs = [...altDefs, ...mandatoryDefs, ...extraNonManaDefs];
	if (defs.length === 0) return undefined;
	const costReq = getSpellCostRequirement(
		player,
		inst,
		state,
		xValue,
		optionId,
		optionalCostCounts
	);
	const spendCtx = spellSpendContext(inst, {
		faceIndex: optFace,
		fused: optFused,
		isFaceDown: Boolean(resolved.ok && resolved.option.spellMods?.castFaceDown),
		// --- Track P20b ---
		state,
		xValue,
		manaCostOverride:
			resolved.ok && resolved.option.baseCost.kind === 'alternative'
				? resolved.option.baseCost.manaCost
				: undefined
		// --- End Track P20b ---
	});
	return chooseCostPayment(costContext(state, player, inst, xValue, true, costReq, undefined, spendCtx), defs) ?? undefined;
}

/** Picks a legal `CostPayment` for activating `ab` on `perm` (used by bots before calling `activate_ability`). */
export function chooseBotAbilityCostPayment(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	ab: EffectiveActivatedAbility
): CostPayment | undefined {
	const abilityCost = activatedAbilityCost(perm.card, ab);
	const isLoyaltyAb = ab.loyaltyCost !== null || Boolean(ab.loyaltySign);
	const abilityMana = effectiveAbilityManaCost(
		state,
		player.playerId,
		ab.id,
		// --- Track P17b ---
		ab.baseManaCost ?? ab.manaCost,
		// --- End Track P17b ---
		ab.costKeyword,
		// --- Track P11 & P15 ---
		0,
		perm,
		ab.isManaAbility,
		ab.powerUpReduction,
		// --- End Track P11 & P15 ---
		// --- Track P17b ---
		undefined,
		isLoyaltyAb
		// --- End Track P17b ---
	).requirement;
	// --- Track P17b ---
	const extraAbDefs = collectActiveAbilityAdditionalCostsWave6(
		state,
		player.playerId,
		ab.id,
		ab.costKeyword,
		perm,
		ab.isManaAbility,
		isLoyaltyAb,
		undefined,
		matchesObjectFilter,
		costModifiersOf
	);
	const allAbDefs =
		extraAbDefs.length > 0 ? [...abilityCost.defs, ...extraAbDefs] : abilityCost.defs;
	// --- End Track P17b ---
	// --- Track P17a: CR 118.3, 702.122a, 702.171a cost locks & Crew/Saddle virtual power ---
	const lockRes = checkWave6CostPaymentLocks(
		state,
		player.playerId,
		allAbDefs,
		undefined,
		ab.isManaAbility,
		perm
	);
	if (!lockRes.ok) return undefined;
	const crewAdjusted = adjustCostDefsForCrewSaddleVirtualPower(
		state,
		player,
		perm,
		allAbDefs
	);
	const chosen = chooseCostPayment(
		costContext(state, player, perm, 0, false, abilityMana),
		crewAdjusted.defs
	);
	if (!chosen) return undefined;
	if (crewAdjusted.chosenObjects && !chosen.objects) {
		return { ...chosen, objects: crewAdjusted.chosenObjects };
	}
	return chosen;
	// --- End Track P17a ---
}

/** Builds a ManaSpendContext for casting `inst` with the selected face/fuse/face-down mode. */
export function spellSpendContext(
	inst: CardInstance,
	opts?: {
		faceIndex?: number;
		fused?: boolean;
		isFaceDown?: boolean;
		// --- Track P20b ---
		state?: GameState;
		xValue?: number;
		manaCostOverride?: string;
		// --- End Track P20b ---
	}
): ManaSpendContext {
	if (opts?.isFaceDown) {
		return {
			isSpell: true,
			isArtifactSpell: false,
			// --- Track P10 ---
			spellSourceZone: inst.zone,
			isCommanderSpell: Boolean(inst.isCommander)
			// --- End Track P10 ---
		};
	}
	const effCard = effectiveCardForObject(inst);
	const resolved = resolveObjectFaces(effCard, {
		zone: 'stack',
		faceIndex: opts?.faceIndex,
		fused: opts?.fused
	});
	return {
		isSpell: true,
		isArtifactSpell: /\bArtifact\b/i.test(resolved.typeLine),
		// --- Track P10 ---
		spellCard: effCard,
		spellFaceIndex: opts?.faceIndex ?? 0,
		spellFused: opts?.fused,
		spellSourceZone: inst.zone,
		isCommanderSpell: Boolean(inst.isCommander),
		// --- End Track P10 ---
		// --- Track P20b ---
		...collectSpellManaSpendRestrictionsP20b(opts?.state, inst, opts)
		// --- End Track P20b ---
	};
}

// --- Track P10 ---
export function activatedAbilitySpendContext(
	state: GameState,
	perm: CardInstance,
	ab?: Partial<EffectiveActivatedAbility>,
	// --- Track P20b ---
	xValue = 0
	// --- End Track P20b ---
): ManaSpendContext {
	const effCard =
		perm.zone === 'battlefield' ? getEffectiveCardForPermanent(state, perm) : effectiveCardForObject(perm);
	const evalPerm = perm.zone === 'battlefield' ? evaluatePermanent(state, perm) : null;
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
		if (/\bKindred\b|\bTribal\b/.test(evalPerm.effectiveTypeLine)) abilitySourceTypes.push('Kindred');
		abilitySourceSubtypes = splitSubtypes(evalPerm.effectiveTypeLine);
	}
	return {
		isSpell: false,
		isActivatedAbility: true,
		abilitySourceCard: effCard,
		abilitySourceFaceIndex: ab?.faceIndex ?? 0,
		...(evalPerm
			? {
					abilitySourceTypes,
					abilitySourceSubtypes,
					abilitySourceColors: evalPerm.colors
				}
			: {}),
		// --- Track P20b ---
		...collectAbilityManaSpendRestrictionsP20b(
			state,
			perm,
			(ab ?? { id: '', baseManaCost: '', manaCost: '' }) as EffectiveActivatedAbility,
			xValue
		)
		// --- End Track P20b ---
	};
}

export function p10AddManaOptions(ab?: EffectiveActivatedAbility): AddManaOptions | undefined {
	if (!ab?.manaRestrictionSpec && !ab?.retainManaUntilEndOfTurn) return undefined;
	return {
		...(ab.manaRestrictionSpec ? { restrictionSpec: ab.manaRestrictionSpec } : {}),
		...(ab.retainManaUntilEndOfTurn ? { retainUntilEndOfTurn: true } : {})
	};
}
// --- End Track P10 ---

/**
 * The amount a mana ability adds. Dynamic amounts ("for each Elf you control", "equal to ~'s power")
 * come from the IR (Phase 4); otherwise the legacy amount. A count of zero adds no mana.
 */
export function getDynamicManaProducedAmount(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	baseAmount: number,
	ab?: EffectiveActivatedAbility,
	// --- Track P17b ---
	xValue = 0,
	// --- End Track P17b ---
	// --- Track P20b ---
	removedCounterCount?: number
	// --- End Track P20b ---
): number {
	const evalPerm = evaluatePermanent(state, perm);
	const retainsInnateMana =
		evalPerm.losesAllAbilities &&
		!perm.isFaceDown &&
		permanentRetainsInnateManaAbilities(perm, state);
	if (
		evalPerm.losesAllAbilities &&
		!retainsInnateMana &&
		(!ab || (!ab.manaAmount && !ab.grantSourceCard && !ab.grantedAbilityText))
	) {
		return baseAmount;
	}
	const { effectiveCard: pCard, effectiveFaceOpts } =
		perm.zone === 'battlefield'
			? effectiveBattlefieldCardAndFaceOpts(state, perm)
			: {
					effectiveCard: effectiveCardForObject(perm),
					effectiveFaceOpts: instanceFaceOptions(perm, perm.zone)
				};
	const fallback = { id: 'mana_tap' } as EffectiveActivatedAbility;
	const condCtx = { state, controllerId: player.playerId, source: perm };
	const amount = manaAbilityAmount(pCard, ab ?? fallback, condCtx, effectiveFaceOpts);
	if (!amount) return baseAmount;
	return Math.max(
		0,
		evaluateAmount(amount, {
			state,
			controllerId: player.playerId,
			source: perm,
			xValue: xValue > 0 ? xValue : (removedCounterCount ?? 0),
			// --- Track P20b ---
			...(removedCounterCount !== undefined
				? {
						stackItem: {
							removedCounterCount,
							lastCountersRemoved: removedCounterCount
						} as StackItem
					}
				: {})
			// --- End Track P20b ---
		})
	);
}

/** Builds the context runtime/costs.ts pays costs in. */
export function costContext(
	state: GameState,
	player: PlayerGameState,
	source: CardInstance,
	xValue: number,
	isSpell: boolean,
	baseMana: ManaCostRequirement | null,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedObjectIds?: ReadonlySet<string>,
	canPayManaOverride?: (req: ManaCostRequirement, reservedIds?: ReadonlySet<string>) => boolean,
	// --- Track P22b ---
	targets?: TargetRef[]
	// --- End Track P22b ---
): CostContext {
	const combineReserved = (reservedIds?: ReadonlySet<string>): ReadonlySet<string> | undefined => {
		if (!reservedObjectIds?.size) return reservedIds;
		if (!reservedIds?.size) return reservedObjectIds;
		const merged = new Set<string>(reservedObjectIds);
		for (const id of reservedIds) merged.add(id);
		return merged;
	};
	// --- Track P17b ---
	const spellColors =
		isSpell && spendCtx.spellCard
			? resolveObjectFaces(spendCtx.spellCard, {
					zone: 'stack',
					faceIndex: spendCtx.spellFaceIndex ?? 0,
					fused: spendCtx.spellFused
				}).colors
			: isSpell && !source.isFaceDown
				? resolveObjectFaces(effectiveCardForObject(source), { zone: 'stack' }).colors
				: undefined;
	// --- End Track P17b ---
	return {
		state,
		player,
		source,
		xValue,
		isSpell,
		baseMana,
		reservedObjectIds,
		spendCtx,
		// --- Track P22b ---
		...(targets ? { targets } : {}),
		// --- End Track P22b ---
		// --- Track P17b ---
		...(spellColors ? { spellColors } : {}),
		// --- End Track P17b ---
		canPayMana: canPayManaOverride
			? (req, reservedIds) => canPayManaOverride(req, combineReserved(reservedIds))
			: (req, reservedIds) =>
					H().canPayOrAutoTap(player, req, state, phyrexianLifeCount, spendCtx, combineReserved(reservedIds)),
		payMana: (req) => H().payManaWithAutoTap(player, req, state, phyrexianLifeCount, spendCtx, reservedObjectIds)
	};
}

function resolveCostSourceCard(state: GameState, pcp: PendingCostPayment): CardInstance {
	if (pcp.kind === 'cast_spell') {
		const sp = state.players.find((p) => p.playerId === pcp.sourcePlayerId);
		const zone = pcp.sourceZone ?? 'hand';
		const inst = sp?.[zone].find((c) => c.instanceId === pcp.sourceInstanceId);
		if (inst) return inst;
	} else if (pcp.kind === 'hand_special_action') {
		const sp = state.players.find((p) => p.playerId === pcp.actorId);
		const inst = sp?.hand.find((c) => c.instanceId === pcp.sourceInstanceId);
		if (inst) return inst;
	}
	const found =
		findCardAnywhere(state, pcp.sourceInstanceId)?.inst ??
		state.pendingZoneMoves?.find((c) => c.instanceId === pcp.sourceInstanceId);
	if (found) return found;
	const fallbackCard =
		pcp.sourceCard ??
		({
			id: pcp.sourceInstanceId,
			name: 'Unknown Card',
			manaCost: '',
			cmc: 0,
			typeLine: '',
			colors: [],
			colorIdentity: [],
			imageUrl: ''
		} as unknown as ScryfallCard);
	const inst = createCardInstance(
		fallbackCard,
		pcp.actorId,
		'graveyard',
		false,
		false,
		undefined,
		state
	);
	inst.instanceId = pcp.sourceInstanceId;
	if (pcp.sourceObjectVersion !== undefined) inst.objectVersion = pcp.sourceObjectVersion;
	return inst;
}

export function finalizeCastSpell(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	sourcePlayer: PlayerGameState,
	// --- Track P15: Preparation copy casts from battlefield (CR 723.3c) ---
	sourceZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library' | 'battlefield',
	// --- End Track P15 ---
	opts: {
		targets: TargetRef[];
		targetsBySpec?: TargetRef[][];
		// --- Track P7 ---
		targetDivisions?: Record<string, number>;
		// --- End Track P7 ---
		chosenModes?: number[];
		xValue: number;
		castOptionId?: string;
		faceIndex?: number;
		fused?: boolean;
		spellMods?: SpellModifications;
		optionalCostCounts?: Record<string, number>;
		exSourceName?: string;
		descriptions?: string[];
		aidDescriptions?: string[];
		additionalIncomplete?: boolean;
		manaColorsSpent?: ManaColor[];
		// --- Track P13 ---
		manaColorsAllSpent?: ManaColor[];
		// --- End Track P13 ---
		cantBeCounteredByMana?: boolean;
		opalPalaceBonusCounters?: number;
		// --- Track P10 ---
		manaSpentCount?: number;
		// --- End Track P10 ---
		// --- Track P14 ---
		staticPlaySlotKey?: string;
		// --- End Track P14 ---
		// --- Track P15 ---
		phyrexianLifePaidCount?: number;
		giftRecipientId?: string;
		// --- End Track P15 ---
		// --- Track P19a ---
		sacrificedCostLki?: SacrificedCostLkiEntry[];
		// --- End Track P19a ---
		// --- Track P20b ---
		removedCounterCount?: number;
		// --- End Track P20b ---
		// --- Track P22b ---
		chosenSubTypeCost?: string;
		chosenNumberCost?: number;
		chosenKeywordCost?: string;
		beheldOrChosenPower?: number;
		beheldOrChosenCard?: ScryfallCard;
		repeatableManaPaidCount?: number;
		exiledCostCards?: ScryfallCard[];
		// --- End Track P22b ---
	}
): void {
	const actorId = actor.playerId;
	// --- Track P14 ---
	consumeWave5StaticPlaySlot(actor, opts.staticPlaySlotKey);
	// --- End Track P14 ---
	const stackFaceIdx = opts.faceIndex ?? 0;
	const stackFused = Boolean(opts.fused);
	const castFaceDownSpec = opts.spellMods?.castFaceDown;
	const faceDownLabel = castFaceDownSpec ? allocateFaceDownLabel(state) : undefined;
	const spellSourceCard = effectiveCardForObject(inst);
	const stackView = resolveObjectFaces(spellSourceCard, {
		zone: 'stack',
		faceIndex: stackFaceIdx,
		fused: stackFused,
		...(opts.spellMods?.prototyped ? { prototyped: true } : {}),
		...(castFaceDownSpec ? { isFaceDown: true, faceDownSpec: castFaceDownSpec } : {})
	});
	const spellDisplayName = faceDownLabel ?? stackView.name;
	if (opts.aidDescriptions && opts.aidDescriptions.length > 0) {
		addLog(
			state,
			'rule',
			`${actor.username} ${opts.aidDescriptions.join('; ')} while casting ${spellDisplayName}.`,
			actorId
		);
	}
	if (opts.descriptions && opts.descriptions.length > 0) {
		addLog(state, 'rule', `${actor.username} ${opts.descriptions.join('; ')} as an additional cost.`, actorId);
	}
	if (opts.additionalIncomplete) {
		addLog(state, 'rule', `The additional cost of ${spellDisplayName} isn't automated; pay it manually.`, actorId);
	}

	const wasForetoldCard = sourceZone === 'exile' && Boolean(inst.foretoldByPlayerId);
	// --- Track P15: Gift promised tracking (CR 702.174a–b) & Preparation copy (CR 723.3c) ---
	const isGiftPaid = Boolean(opts.spellMods?.giftPromised || (opts.optionalCostCounts?.['opt:gift'] ?? 0) > 0);
	const giftInfo = isGiftPaid ? findFaceGiftKeyword(spellSourceCard, stackFaceIdx) : null;
	const resolvedGiftRecipientId = isGiftPaid
		? (opts.giftRecipientId ??
			state.players.find((p) => p.playerId !== actorId && !p.lost)?.playerId)
		: undefined;
	const splicedEntries = splicedSpellAbilitiesForOptionalCounts(
		actor,
		opts.optionalCostCounts
	);
	for (const sp of splicedEntries) {
		markHandCardRevealedToAll(state, sp.handInst);
	}
	const isPreparationCopy =
		sourceZone === 'battlefield' || Boolean(opts.spellMods?.preparationCopy);
	// --- End Track P15 ---
	const baseSpellMods: SpellModifications | undefined =
		wasForetoldCard && !opts.spellMods?.foretold
			? { ...opts.spellMods, foretold: true }
			: opts.spellMods;
	// --- Track P19b ---
	const surgeAdjustedMods: SpellModifications | undefined =
		opts.castOptionId?.includes('surge') && !baseSpellMods?.surged
			? { ...baseSpellMods, surged: true }
			: baseSpellMods;
	// --- End Track P19b ---
	const effectiveSpellMods: SpellModifications | undefined = isGiftPaid && !surgeAdjustedMods?.giftPromised
		? { ...surgeAdjustedMods, giftPromised: true }
		: surgeAdjustedMods;
	const exSourceName =
		opts.exSourceName ??
		inst.playableFromExileBy?.sourceName ??
		(effectiveSpellMods?.foretold
			? 'Foretell'
			: opts.castOptionId === 'exile:plot'
				? 'Plot'
				: opts.castOptionId === 'exile:warp' || inst.warpedByOwnerId
					? 'Warp'
					: undefined);
	if (isPreparationCopy) {
		// CR 723.3c: Casting a copy of a prepared permanent's preparation spell unprepares the permanent
		// while leaving the permanent itself on the battlefield!
		inst.isPrepared = false;
		noteLayerInputsChanged(state);
	} else {
		if (castFaceDownSpec) {
			inst.isFaceDown = true;
			inst.faceDownSpec = { ...castFaceDownSpec };
			inst.faceDownLabel = faceDownLabel;
		} else if (inst.isFaceDown) {
			// CR 702.143a / CR 601.2a: Casting a face-down card in exile for a face-up option turns it face up on the stack.
			inst.isFaceDown = false;
			inst.faceDownSpec = undefined;
			inst.faceDownLabel = undefined;
		}
		inst.prototyped = effectiveSpellMods?.prototyped ? true : undefined;
		inst.manaColorsSpent = opts.manaColorsSpent ? [...opts.manaColorsSpent] : undefined;
		// --- Track P13 ---
		if (opts.manaColorsAllSpent) inst.manaColorsAllSpent = [...opts.manaColorsAllSpent];
		else delete inst.manaColorsAllSpent;
		// --- End Track P13 ---
		// --- Track P10 ---
		inst.manaSpentCount = opts.manaSpentCount;
		// --- End Track P10 ---
		// --- Track P9 ---
		inst.dashed = effectiveSpellMods?.dashed ? true : undefined;
		// --- End Track P9 ---
		// --- Track P15 ---
		inst.compleatedLifePaidCount = opts.phyrexianLifePaidCount;
		inst.castWithImpending = effectiveSpellMods?.impendingN ? true : undefined;
		inst.giftPromised = isGiftPaid ? true : undefined;
		inst.giftRecipientId = resolvedGiftRecipientId;
		// --- End Track P15 ---
		// --- Track P20b ---
		const preStackVersion = inst.objectVersion ?? 1;
		// --- End Track P20b ---
		// --- Track P21: Record non-sorcery timing & prune cast card from active library search prompts ---
		const castAtSorceryWindow =
			state.players[state.activePlayerIndex]?.playerId === actorId &&
			(state.phase === 'main1' || state.phase === 'main2') &&
			state.stack.length === 0 &&
			state.pendingPrompts.length === 0;
		inst.castAtNonSorceryTiming = !castAtSorceryWindow ? true : undefined;
		// --- End Track P21 ---
		moveObject(state, inst, 'stack', {
			from: { player: sourcePlayer, zone: sourceZone },
			newTimestamp: true,
			bumpVersion: true
		});
		// --- Track P20b ---
		syncCastExiledByVersionP20b(state, inst.instanceId, preStackVersion, inst.objectVersion ?? 1);
		// --- End Track P20b ---
		// --- Track P21 ---
		if (sourceZone === 'library') {
			pruneCastCardFromActiveLibrarySearchPrompts(state, inst.instanceId);
		}
		// --- End Track P21 ---
		inst.playableFromExileBy = undefined;
		// --- Track P13 ---
		delete inst.playableFromGraveyardBy;
		delete inst.airbentCastPermission;
		// --- End Track P13 ---
	}
	// --- Track P13 ---
	if (effectiveSpellMods?.warped) {
		actor.spellWarpedThisTurn = true;
	}
	// --- End Track P13 ---

	if (!actor.commanderCastCounts) {
		actor.commanderCastCounts = {};
	}
	if (sourceZone === 'command' && inst.isCommander) {
		const prevCastCount = actor.commanderCastCounts[inst.instanceId] ?? inst.commanderCastCount ?? 0;
		inst.commanderCastCount = prevCastCount + 1;
		actor.commanderCastCounts[inst.instanceId] = inst.commanderCastCount;
	}
	// --- Track P17a: Snapshot static spell keyword grants BEFORE incrementing spellsCastThisTurn ---
	const castGrantedSpellKws = isPreparationCopy
		? []
		: getGrantedSpellKeywordsForSpell(state, actorId, inst, stackFaceIdx, stackFused);
	// --- End Track P17a ---
	// --- Track P20a: Cleanup-step sacrifice when relying solely on self flash ("If you cast it any time a sorcery couldn't have been cast...") ---
	let effectiveSpellModsFinal = effectiveSpellMods;
	if (!isPreparationCopy && !castFaceDownSpec) {
		const activePl = state.players[state.activePlayerIndex];
		const atSorceryTiming =
			activePl?.playerId === actorId &&
			(state.phase === 'main1' || state.phase === 'main2') &&
			state.stack.length === 0;
		if (!atSorceryTiming) {
			const castDefs = activeAbilityDefs(spellSourceCard, {
				zone: 'stack',
				faceIndex: stackFaceIdx,
				fused: stackFused
			});
			const hasInnateOrGrantedFlash =
				(stackView.types.includes('Instant') && !stackView.types.includes('Sorcery')) ||
				castDefs.some((a) => a.kind === 'keyword' && a.keyword.name.toLowerCase() === 'flash') ||
				Boolean(inst.grantedKeywords?.some((k) => k.toLowerCase() === 'flash')) ||
				castGrantedSpellKws.some((k) => k.toLowerCase() === 'flash') ||
				activeRuleModifiers(state, 'castAsThoughFlash', actorId).some((mod) => {
					const sf = mod.def.params?.spells as ObjectFilter | undefined;
					if (!sf) return true;
					const viewInst = inst.controllerId === actorId ? inst : { ...inst, controllerId: actorId };
					return matchesObjectFilter(viewInst, sf, {
						state,
						controllerId: mod.controllerId,
						source: mod.source
					});
				});
			if (
				spellReliesOnCleanupSacrificeFlash(
					state,
					actorId,
					inst,
					atSorceryTiming,
					hasInnateOrGrantedFlash
				)
			) {
				effectiveSpellModsFinal = { ...effectiveSpellModsFinal, sacrificeAtCleanupStep: true };
			}
		}
	}
	// --- End Track P20a ---
	actor.spellsCastThisTurn = (actor.spellsCastThisTurn || 0) + 1;
	// --- Track P19b ---
	if (!isPreparationCopy && sourceZone === 'hand') {
		actor.spellsCastFromHandThisTurn = (actor.spellsCastFromHandThisTurn ?? 0) + 1;
	}
	const treasureManaSpentOnSpell = Boolean(actor.spentTreasureManaOnCurrentSpell);
	delete actor.spentTreasureManaOnCurrentSpell;
	const artifactManaSpentOnSpell = actor.spentArtifactManaOnCurrentSpellCount ?? 0;
	delete actor.spentArtifactManaOnCurrentSpellCount;
	delete actor.nextSpellCascadeCount;
	if (!isPreparationCopy) {
		if (treasureManaSpentOnSpell) {
			inst.treasureManaSpent = true;
			actor.spellsCastWithTreasureManaThisTurn = (actor.spellsCastWithTreasureManaThisTurn ?? 0) + 1;
		} else {
			delete inst.treasureManaSpent;
		}
		if (artifactManaSpentOnSpell > 0) inst.artifactManaSpentCount = artifactManaSpentOnSpell;
		else delete inst.artifactManaSpentCount;
	}
	// --- End Track P19b ---
	// --- Track P15: Day/Night active-player spell count (CR 732.5) ---
	if (state.players[state.activePlayerIndex]?.playerId === actorId) {
		state.spellsCastByActivePlayerThisTurn = (state.spellsCastByActivePlayerThisTurn ?? 0) + 1;
	}
	// --- End Track P15 ---
	// --- Track P12 ---
	recordSpellCastWave4(state, actor, spellSourceCard, stackFaceIdx);
	// --- End Track P12 ---

	const { targets, targetsBySpec, chosenModes, xValue: xVal, castOptionId, optionalCostCounts } = opts;
	const spellMods = effectiveSpellModsFinal;
	const hasSpellMods = Boolean(spellMods && Object.keys(spellMods).length > 0);
	// --- Track P12: Awaken target capture (CR 702.113a) ---
	const awakenLandRef =
		(spellMods?.awakenCounters ?? 0) > 0 && targets.length > 0
			? targets[targets.length - 1]
			: undefined;
	const awakenLandPerm =
		awakenLandRef?.kind === 'permanent'
			? findPermanentOnBoard(state, awakenLandRef.id)?.inst
			: undefined;
	// --- End Track P12 ---
	const copySourceId = isPreparationCopy ? uid('prep_copy', state) : inst.instanceId;
	const stackItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: copySourceId,
			sourceObjectVersion: isPreparationCopy ? 1 : inst.objectVersion,
			card: spellSourceCard,
			ownerId: isPreparationCopy ? actorId : inst.ownerId,
			controllerId: actorId,
			kind: 'spell',
			title: spellDisplayName,
			...(isPreparationCopy ? { isCopy: true } : {}),
			...(opts.manaColorsSpent ? { manaColorsSpent: [...opts.manaColorsSpent] } : {}),
			// --- Track P13 ---
			...(opts.manaColorsAllSpent ? { manaColorsAllSpent: [...opts.manaColorsAllSpent] } : {}),
			// --- End Track P13 ---
			...(opts.cantBeCounteredByMana ? { cantBeCounteredByMana: true } : {}),
			...(opts.opalPalaceBonusCounters ? { opalPalaceBonusCounters: opts.opalPalaceBonusCounters } : {}),
			// --- Track P10 ---
			...(opts.manaSpentCount !== undefined ? { manaSpentCount: opts.manaSpentCount } : {}),
			// --- End Track P10 ---
			// --- Track P22b ---
			...(opts.manaSpentCount !== undefined ? { manaSpentToCastCount: opts.manaSpentCount } : {}),
			...(opts.manaColorsAllSpent !== undefined || opts.manaColorsSpent !== undefined
				? {
						coloredManaSpentToCast: (opts.manaColorsAllSpent ?? opts.manaColorsSpent ?? []).filter(
							(c) => c !== 'C'
						).length
					}
				: {}),
			...(opts.chosenSubTypeCost !== undefined ? { chosenSubTypeCost: opts.chosenSubTypeCost } : {}),
			...(opts.chosenNumberCost !== undefined ? { chosenNumberCost: opts.chosenNumberCost } : {}),
			...(opts.chosenKeywordCost !== undefined ? { chosenKeywordCost: opts.chosenKeywordCost } : {}),
			...(opts.beheldOrChosenPower !== undefined ? { beheldOrChosenPower: opts.beheldOrChosenPower } : {}),
			...(opts.beheldOrChosenCard !== undefined ? { beheldOrChosenCard: opts.beheldOrChosenCard } : {}),
			...(opts.repeatableManaPaidCount !== undefined
				? { repeatableManaPaidCount: opts.repeatableManaPaidCount }
				: {}),
			...(opts.exiledCostCards?.length ? { exiledCostCards: opts.exiledCostCards } : {}),
			// --- End Track P22b ---
			...(opts.faceIndex !== undefined ? { faceIndex: opts.faceIndex } : {}),
			...(opts.fused ? { fused: true } : {}),
			...(castFaceDownSpec
				? { isFaceDown: true, faceDownSpec: { ...castFaceDownSpec }, faceDownLabel }
				: {}),
			targets,
			...(targetsBySpec ? { targetsBySpec } : {}),
			// --- Track P7 ---
			...(opts.targetDivisions ? { targetDivisions: { ...opts.targetDivisions } } : {}),
			castFromZone: sourceZone,
			// --- End Track P7 ---
			...(chosenModes ? { chosenModes: [...chosenModes] } : {}),
			targetObjectVersions: H().captureTargetObjectVersions(state, targets),
			xValue: xVal,
			...(castOptionId ? { castOptionId } : {}),
			...(hasSpellMods ? { spellMods } : {}),
			// --- Track P20b ---
			...(spellMods?.altCostManaPaid ? { altCostManaPaid: spellMods.altCostManaPaid } : {}),
			...(spellMods?.additionalCostPaid ? { additionalCostPaid: true } : {}),
			...(opts.removedCounterCount !== undefined
				? { removedCounterCount: opts.removedCounterCount }
				: {}),
			// --- End Track P20b ---
			// --- Track P12 ---
			...(awakenLandRef ? { awakenTargetId: awakenLandRef.id } : {}),
			...(awakenLandPerm?.objectVersion !== undefined
				? { awakenTargetVersion: awakenLandPerm.objectVersion }
				: {}),
			// --- End Track P12 ---
			// --- Track P15 ---
			...(opts.phyrexianLifePaidCount ? { phyrexianLifePaidCount: opts.phyrexianLifePaidCount } : {}),
			gravestormCount: state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0,
			...(giftInfo ? { giftKind: giftInfo.giftKind } : {}),
			...(resolvedGiftRecipientId ? { giftRecipientId: resolvedGiftRecipientId } : {}),
			...(splicedEntries.length > 0 ? { splicedCards: splicedEntries.map((e) => e.card) } : {}),
			// --- End Track P15 ---
			// --- Track P17a ---
			...(castGrantedSpellKws.length > 0 ? { grantedSpellKeywords: castGrantedSpellKws } : {}),
			// --- End Track P17a ---
			// --- Track P19b ---
			...(treasureManaSpentOnSpell ? { treasureManaSpent: true } : {}),
			// --- End Track P19b ---
			// --- Wave 12 ---
			...(artifactManaSpentOnSpell > 0 ? { artifactManaSpentCount: artifactManaSpentOnSpell } : {}),
			...(spellMods?.entersTapped ? { entersTappedFromZonePermission: true } : {}),
			...(spellMods?.grantHasteUntilEndOfTurn ? { grantHasteUntilEndOfTurn: true } : {}),
			// --- End Wave 12 ---
			// --- Track P19a ---
			...(opts.sacrificedCostLki?.length ? { sacrificedCostLki: opts.sacrificedCostLki } : {}),
			// --- End Track P19a ---
			// --- Track P22a: CR 122.2 carry zone-persistent counters onto stack ---
			...(!isPreparationCopy &&
			cardKeepsCountersAcrossZonesWave8(inst, state) &&
			Object.values(inst.counters).some((n) => (n ?? 0) > 0)
				? { carriedCounters: { ...inst.counters } }
				: {}),
			// --- End Track P22a ---
			...(optionalCostCounts ? { optionalCostCounts } : {}),
			commanderCastCount: isPreparationCopy ? 0 : inst.commanderCastCount,
			// --- Track P21 ---
			...(inst.castAtNonSorceryTiming ? { castAtNonSorceryTiming: true } : {}),
			// --- End Track P21 ---
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		castFaceDownSpec ? '' : spellSourceCard
	);

	state.stack.push(stackItem);
	// --- Track P16a: Consume next-spell flash / uncounterable grants on cast ---
	consumeP16aOnSpellCast(actor, stackView.types, stackItem);
	// --- End Track P16a ---
	// --- Track P19a (CR 603.7, CR 707.10): Trigger delayed next-spell copy ---
	consumeP19aDelayedSpellCopyOnCast(state, actor, stackView.types, stackView.colors, stackItem);
	// --- End Track P19a ---

	if (actor.manaRiders && actor.manaRiders.length > 0) {
		const matchingRiders: ManaRider[] = [];
		const remainingRiders: ManaRider[] = [];
		for (const rider of actor.manaRiders) {
			const matches = rider.condition?.sharesCreatureTypeWithCommander
				? matchesObjectFilter(
						inst,
						{ types: ['Creature'], sharesTypeWithCommander: true },
						{
							state,
							controllerId: actorId
						}
					)
				: false;
			if (matches) {
				matchingRiders.push(rider);
			} else {
				remainingRiders.push(rider);
			}
		}
		actor.manaRiders = remainingRiders;
		for (const rider of matchingRiders) {
			const scryAmount = rider.scryAmount ?? 1;
			const riderCard = rider.sourceCard ?? inst.card;
			const riderStackItem: StackItem = withStackItemText(
				{
					id: uid('stk', state),
					sourceInstanceId: rider.sourceInstanceId ?? inst.instanceId,
					card: riderCard,
					ownerId: actorId,
					controllerId: actorId,
					kind: 'triggered',
					title: `${riderCard.name} (Scry ${scryAmount})`,
					targets: [],
					requiresGuidedResolution: false,
					createdAt: Date.now(),
					xValue: 0,
					delayedEffect: { kind: 'scry', amount: scryAmount }
				},
				riderCard
			);
			state.stack.push(riderStackItem);
			addLog(
				state,
				'trigger',
				`${riderCard.name} triggered: Scry ${scryAmount}.`,
				actorId
			);
		}
	}
	state.passedPriorityPlayerIds = [];
	state.priorityUpdatedAt = Date.now();

	const targetDesc =
		targets.length > 0 ? ` targeting ${targets.map((t) => t.label).join(', ')}` : '';
	const kickerInfo = optionalCostCounts
		? computeKickerTracking(
				inst.card,
				optionalCostCounts,
				{ spellMods },
				stackFaceIdx,
				stackFused
			)
		: { count: 0, tags: [] };
	const kickedSuffix = kickerInfo.count > 0 ? ' (kicked)' : '';
	const summarySuffix = `${spellMods?.castSummarySuffix ?? ''}${kickedSuffix}`;
	addLog(
		state,
		'cast',
		`${actor.username} cast ${spellDisplayName}${summarySuffix}${sourceZone === 'command' ? ` from Command Zone (Cast #${inst.commanderCastCount})` : sourceZone === 'graveyard' ? ' from Graveyard' : sourceZone === 'library' ? ' from Top of Library' : sourceZone === 'exile' ? ` from Exile (${exSourceName || 'Exile Permission'})` : ''}${targetDesc}.`,
		actorId
	);

	emitVfx(state, {
		kind: sourceZone === 'command' ? 'commander_cast' : 'spell_cast',
		sourceId: actorId,
		targetId: targets[0]?.id,
		label: spellDisplayName
	});

	emitEvent(state, {
		kind: 'Cast',
		playerId: actor.playerId,
		objectId: inst.instanceId,
		object: inst,
		// --- Track P22b ---
		targets: [...targets],
		manaSpentCount: opts.manaSpentCount,
		coloredManaSpent: stackItem.coloredManaSpentToCast,
		kicked: kickerInfo.count > 0,
		stackItemId: stackItem.id
		// --- End Track P22b ---
	});
	// --- Track P16b ---
	if (chosenModes && chosenModes.length > 0) {
		emitEvent(state, {
			kind: 'FacedDilemma',
			playerId: actor.playerId,
			stackItemId: stackItem.id
		});
	}
	// --- End Track P16b ---
	for (const t of targets) {
		const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
		if (targeted) {
			emitEvent(state, {
				kind: 'BecameTarget',
				objectId: t.id,
				object: targeted.inst,
				by: 'spell',
				controllerId: actor.playerId,
				stackItemId: stackItem.id
			});
		}
		// --- Track P16b ---
		if (t.kind === 'player') {
			emitEvent(state, {
				kind: 'PlayerTargeted',
				targetPlayerId: t.id,
				by: 'spell',
				controllerId: actor.playerId,
				stackItemId: stackItem.id
			});
		}
		// --- End Track P16b ---
	}
	// --- Track P10 ---
	checkAndEmitCrimeCommitted(state, actor.playerId, targets);
	if ((opts.manaSpentCount ?? 0) > 0) {
		recordSpellManaExpended(state, actor, opts.manaSpentCount!);
	}
	// --- End Track P10 ---
	// --- Track P15: Increment, Ripple, Ravenous, Demonstrate, Gravestorm cast triggers ---
	for (const pt of collectWave5CastTriggers(state, stackItem, inst, actor)) {
		enqueuePendingTrigger(state, { ...pt, mode: 'stack' });
	}
	// --- End Track P15 ---
	resetTriggerLoopTracking(state);
	flushTriggers(state);
	H().checkStateBasedActions(state);
}

function finalizeActivateAbility(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const actorId = actor.playerId;
	const perm =
		findPermanentOnBoard(state, pcp.sourceInstanceId)?.inst ??
		resolveCostSourceCard(state, pcp);
	const card = pcp.sourceCard ?? perm.card;
	const targets = pcp.targets ?? [];
	const effectText = pcp.effectText ?? '';
	if (
		pcp.onceEachTurn &&
		(perm.zone === 'battlefield' ||
			perm.zone === 'hand' ||
			perm.zone === 'graveyard' ||
			perm.zone === 'command') &&
		perm.objectVersion === pcp.sourceObjectVersion &&
		pcp.abilityId
	) {
		perm.activatedAbilityIdsThisTurn = [
			...(perm.activatedAbilityIdsThisTurn ?? []),
			pcp.abilityId
		];
		// --- Track P19a ---
		perm.abilityActivationCountsThisTurn = {
			...(perm.abilityActivationCountsThisTurn ?? {}),
			[pcp.abilityId]: (perm.abilityActivationCountsThisTurn?.[pcp.abilityId] ?? 0) + 1
		};
		// --- End Track P19a ---
	}
	// --- Track P12: Exhaust (CR 702.177a), Boast (CR 702.142a), Forecast (CR 702.57a) ---
	if (pcp.abilityId && perm.objectVersion === pcp.sourceObjectVersion) {
		if (pcp.costKeyword === 'exhaust' && perm.zone === 'battlefield') {
			if (!perm.exhaustedAbilityIds?.includes(pcp.abilityId)) {
				perm.exhaustedAbilityIds = [...(perm.exhaustedAbilityIds ?? []), pcp.abilityId];
			}
		} else if (
			(pcp.costKeyword === 'boast' && perm.zone === 'battlefield') ||
			(pcp.costKeyword === 'forecast' && perm.zone === 'hand')
		) {
			if (!perm.activatedAbilityIdsThisTurn?.includes(pcp.abilityId)) {
				perm.activatedAbilityIdsThisTurn = [
					...(perm.activatedAbilityIdsThisTurn ?? []),
					pcp.abilityId
				];
			}
			if (pcp.costKeyword === 'forecast' && perm.zone === 'hand') {
				markHandCardRevealedToAll(state, perm);
			}
		}
	}
	// --- End Track P12 ---
	// --- Track P15: oncePerGame & Craft (CR 702.167a) material payment ---
	if (pcp.oncePerGame && pcp.abilityId && perm.objectVersion === pcp.sourceObjectVersion) {
		if (!perm.usedOncePerGameAbilityIds?.includes(pcp.abilityId)) {
			perm.usedOncePerGameAbilityIds = [
				...(perm.usedOncePerGameAbilityIds ?? []),
				pcp.abilityId
			];
		}
	}
	let craftedMaterialCards: ScryfallCard[] | undefined;
	if (pcp.costKeyword === 'craft') {
		// --- Track P21: "Craft with two that share a card type" material selection ---
		const sharedPair = selectCraftShareCardTypeMaterials(
			state,
			actor,
			perm,
			pcp.craftMaterialIds
		);
		const effectiveCraftIds =
			sharedPair !== 'not_applicable' && sharedPair !== null ? sharedPair : pcp.craftMaterialIds;
		// --- End Track P21 ---
		const craftCards = payCraftMaterialsOnActivate(
			state,
			actor,
			pcp.sourceInstanceId,
			card,
			effectiveCraftIds
		);
		if (craftCards.length > 0) {
			craftedMaterialCards = craftCards;
		}
	}
	// --- End Track P15 ---
	// --- Track P20b ---
	recordP20bKeywordActivation(actor, pcp.costKeyword, pcp.abilityId);
	// --- End Track P20b ---
	const abModal =
		// --- Track P10 ---
		pcp.grantedAbilityText
			? resolveQuotedActivatedOrTriggeredSteps(pcp.grantedAbilityText, card.name, 'activated')?.modal
			: // --- End Track P10 ---
				pcp.abilityId
				? getAbilityModal(
						card,
						pcp.abilityId,
						pcp.faceIndex ?? 0,
						pcp.grantSourceCard,
						pcp.grantFaceIndex
					)
				: undefined;
	H().recordUsedModalModes(perm, pcp.sourceObjectVersion, abModal, pcp.chosenModes);
	if (pcp.descriptions.length > 0) {
		addLog(state, 'rule', `${actor.username} ${pcp.descriptions.join('; ')} to activate ${card.name}.`, actorId);
	}
	if (pcp.abilityCostIncomplete) {
		addLog(state, 'rule', `Part of the cost of ${card.name}'s ability isn't automated; pay it manually.`, actorId);
	}

	const isCrewCost =
		pcp.costKeyword === 'crew' ||
		pcp.parts.some((pt) => pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'crew');
	const crewedByIds = isCrewCost
		? pcp.parts.flatMap((pt) =>
				pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'crew'
					? (pt.objectIds ?? [])
					: []
			)
		: undefined;
	const isSaddleCost =
		pcp.costKeyword === 'saddle' ||
		pcp.parts.some((pt) => pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'saddle');
	const saddledByIds = isSaddleCost
		? pcp.parts.flatMap((pt) =>
				pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'saddle'
					? (pt.objectIds ?? [])
					: []
			)
		: undefined;

	const sourceExertedThisTurn = Boolean(pcp.sourceExertedThisTurn || perm.exertedThisTurn);
	const sourceChosenSubType = pcp.sourceChosenSubType ?? perm.chosenSubType;
	const sourceChosenColor = pcp.sourceChosenColor ?? perm.chosenColor;
	// --- Track P11 ---
	const sourceChosenCardName = perm.chosenCardName;
	// --- End Track P11 ---
	// --- Track P22a ---
	const sourceChosenCardType = perm.chosenCardType;
	const sourceChosenNumber = perm.chosenNumber;
	// --- End Track P22a ---

	const stackItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: pcp.sourceInstanceId,
			sourceObjectVersion: pcp.sourceObjectVersion ?? perm.objectVersion,
			sourceLkiPower: pcp.sourceLkiPower ?? 0,
			sourceLkiToughness: pcp.sourceLkiToughness ?? 0,
			...(pcp.sourceEvoked ? { sourceEvoked: true } : {}),
			...(pcp.sourceEscaped ? { sourceEscaped: true } : {}),
			...(pcp.sourceForetold ? { sourceForetold: true } : {}),
			...(pcp.sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(sourceChosenSubType ? { sourceChosenSubType } : {}),
			...(sourceChosenColor ? { sourceChosenColor } : {}),
			// --- Track P11 ---
			...(sourceChosenCardName ? { sourceChosenCardName } : {}),
			// --- End Track P11 ---
			// --- Track P22a ---
			...(sourceChosenCardType ? { sourceChosenCardType } : {}),
			...(sourceChosenNumber !== undefined ? { sourceChosenNumber } : {}),
			// --- End Track P22a ---
			...(perm.isMonstrous ? { sourceMonstrous: true } : {}),
			// --- Track P12 ---
			...(perm.isRenowned ? { sourceIsRenowned: true } : {}),
			...(perm.devouredCount !== undefined ? { sourceDevouredCount: perm.devouredCount } : {}),
			// --- End Track P12 ---
			card,
			...(pcp.grantSourceCard ? { grantSourceCard: pcp.grantSourceCard } : {}),
			...(pcp.grantFaceIndex !== undefined ? { grantFaceIndex: pcp.grantFaceIndex } : {}),
			...(pcp.faceIndex !== undefined ? { faceIndex: pcp.faceIndex } : {}),
			...(crewedByIds !== undefined ? { crewedByIds } : {}),
			...(saddledByIds !== undefined ? { saddledByIds } : {}),
			...(pcp.tappedCostPower !== undefined ? { tappedCostPower: pcp.tappedCostPower } : {}),
			...(pcp.stationTappedId ? { stationTappedId: pcp.stationTappedId } : {}),
			...(pcp.stationTappedVersion !== undefined ? { stationTappedVersion: pcp.stationTappedVersion } : {}),
			// --- Track P9 ---
			...(pcp.ninjutsuAttackTarget ? { ninjutsuAttackTarget: pcp.ninjutsuAttackTarget } : {}),
			// --- End Track P9 ---
			// --- Track P10 ---
			...(pcp.grantedAbilityText ? { grantedAbilityText: pcp.grantedAbilityText } : {}),
			// --- End Track P10 ---
			// --- Track P15 ---
			...(craftedMaterialCards ? { splicedCards: craftedMaterialCards } : {}),
			// --- End Track P15 ---
			// --- Track P20b ---
			...(pcp.removedCounterCount !== undefined
				? { removedCounterCount: pcp.removedCounterCount }
				: {}),
			// --- End Track P20b ---
			// --- Track P19a ---
			...(pcp.sacrificedCostLki?.length ? { sacrificedCostLki: pcp.sacrificedCostLki } : {}),
			// --- End Track P19a ---
			// --- Track P22b ---
			...(pcp.lifePaidCount !== undefined ? { abilityLifePaidCount: pcp.lifePaidCount } : {}),
			...(pcp.chosenSubTypeCost !== undefined ? { chosenSubTypeCost: pcp.chosenSubTypeCost } : {}),
			...(pcp.chosenNumberCost !== undefined ? { chosenNumberCost: pcp.chosenNumberCost } : {}),
			...(pcp.chosenKeywordCost !== undefined ? { chosenKeywordCost: pcp.chosenKeywordCost } : {}),
			...(pcp.beheldOrChosenPower !== undefined ? { beheldOrChosenPower: pcp.beheldOrChosenPower } : {}),
			...(pcp.beheldOrChosenCard !== undefined ? { beheldOrChosenCard: pcp.beheldOrChosenCard } : {}),
			...(pcp.repeatableManaPaidCount !== undefined
				? { repeatableManaPaidCount: pcp.repeatableManaPaidCount }
				: {}),
			...(pcp.exiledCostCards?.length ? { exiledCostCards: pcp.exiledCostCards } : {}),
			// --- End Track P22b ---
			controllerId: actorId,
			kind: 'activated',
			abilityId: pcp.abilityId,
			title: `${resolveObjectFaces(card, { zone: perm.zone, faceIndex: pcp.faceIndex ?? 0 }).name} Ability`,
			targets,
			...(pcp.targetsBySpec ? { targetsBySpec: pcp.targetsBySpec } : {}),
			// --- Track P7 ---
			...(pcp.targetDivisions ? { targetDivisions: { ...pcp.targetDivisions } } : {}),
			// --- End Track P7 ---
			...(pcp.chosenModes ? { chosenModes: [...pcp.chosenModes] } : {}),
			targetObjectVersions: H().captureTargetObjectVersions(state, targets),
			xValue: pcp.xValue ?? 0,
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		effectText
	);

	state.stack.push(stackItem);
	state.passedPriorityPlayerIds = [];
	noteAbilityTargetedOwnCreatureWave9(
		state,
		actorId,
		targets.map((t) => t.id)
	);
	addLog(state, 'cast', `${actor.username} activated ${card.name}: "${effectText}".`, actorId);
	// --- Track P16b ---
	if (
		pcp.costKeyword === 'exhaust' &&
		pcp.abilityId &&
		perm.zone === 'battlefield' &&
		perm.objectVersion === pcp.sourceObjectVersion
	) {
		emitEvent(state, {
			kind: 'ExhaustActivated',
			playerId: actor.playerId,
			objectId: perm.instanceId,
			object: perm,
			abilityId: pcp.abilityId
		});
	}
	if (pcp.chosenModes && pcp.chosenModes.length > 0) {
		emitEvent(state, {
			kind: 'FacedDilemma',
			playerId: actor.playerId,
			stackItemId: stackItem.id
		});
	}
	// --- End Track P16b ---
	// --- Track P19b: CR 702.122b "Whenever ~ crews a Vehicle" ---
	if (crewedByIds && crewedByIds.length > 0) {
		for (const crewId of crewedByIds) {
			const crewFound = findPermanentOnBoard(state, crewId);
			if (crewFound) {
				emitEvent(state, {
					kind: 'CrewedVehicle',
					creatureId: crewFound.inst.instanceId,
					creature: crewFound.inst,
					vehicleId: perm.instanceId,
					vehicle: perm,
					playerId: actor.playerId
				});
			}
		}
	}
	// --- End Track P19b ---
	// --- Track P22b ---
	if (saddledByIds && saddledByIds.length > 0) {
		for (const saddleId of saddledByIds) {
			const saddleFound = findPermanentOnBoard(state, saddleId);
			if (saddleFound) {
				emitEvent(state, {
					kind: 'SaddledMount',
					creatureId: saddleFound.inst.instanceId,
					creature: saddleFound.inst,
					mountId: perm.instanceId,
					mount: perm,
					playerId: actor.playerId
				});
			}
		}
	}
	const isLoyalty = pcp.parts.some((pt) => pt.def.k === 'loyalty');
	if (isLoyalty) {
		state.activatedLoyaltyAbilityThisTurn = true;
		actor.activatedLoyaltyAbilityThisTurn = true;
	}
	emitEvent(state, {
		kind: 'AbilityActivated',
		playerId: actor.playerId,
		sourceId: perm.instanceId,
		source: perm,
		abilityId: pcp.abilityId,
		isManaAbility: false,
		isLoyaltyAbility: isLoyalty,
		...(pcp.lifePaidCount !== undefined ? { lifePaid: pcp.lifePaidCount } : {}),
		stackItemId: stackItem.id
	});
	// --- End Track P22b ---
	for (const t of targets) {
		const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
		if (targeted) {
			emitEvent(state, {
				kind: 'BecameTarget',
				objectId: t.id,
				object: targeted.inst,
				by: 'ability',
				controllerId: actor.playerId,
				stackItemId: stackItem.id
			});
		}
		// --- Track P16b ---
		if (t.kind === 'player') {
			emitEvent(state, {
				kind: 'PlayerTargeted',
				targetPlayerId: t.id,
				by: 'ability',
				controllerId: actor.playerId,
				stackItemId: stackItem.id
			});
		}
		// --- End Track P16b ---
	}
	// --- Track P10 ---
	checkAndEmitCrimeCommitted(state, actor.playerId, targets);
	// --- End Track P10 ---
	resetTriggerLoopTracking(state);
	flushTriggers(state);
	H().checkStateBasedActions(state);
}

function finalizeTapMana(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const actorId = actor.playerId;
	const perm =
		findPermanentOnBoard(state, pcp.sourceInstanceId)?.inst ??
		resolveCostSourceCard(state, pcp);
	const card = pcp.sourceCard ?? perm.card;
	const stubRestrictions: ActivationRestriction[] = [];
	if (pcp.onceEachTurn) stubRestrictions.push('onceEachTurn');
	if (pcp.oncePerGame) stubRestrictions.push('oncePerGame');
	const abStub =
		pcp.abilityId ||
		pcp.grantSourceCard ||
		pcp.manaRestriction ||
		pcp.freezesSelfUntap ||
		// --- Track P10 ---
		pcp.manaRestrictionSpec ||
		pcp.retainManaUntilEndOfTurn ||
		pcp.grantedAbilityText ||
		// --- End Track P10 ---
		stubRestrictions.length > 0
			? ({
					...(pcp.abilityId ? { id: pcp.abilityId } : {}),
					...(pcp.faceIndex !== undefined ? { faceIndex: pcp.faceIndex } : {}),
					...(pcp.grantSourceCard ? { grantSourceCard: pcp.grantSourceCard } : {}),
					...(pcp.grantFaceIndex !== undefined ? { grantFaceIndex: pcp.grantFaceIndex } : {}),
					...(pcp.manaRestriction ? { manaRestriction: pcp.manaRestriction } : {}),
					// --- Track P10 ---
					...(pcp.manaRestrictionSpec ? { manaRestrictionSpec: pcp.manaRestrictionSpec } : {}),
					...(pcp.retainManaUntilEndOfTurn ? { retainManaUntilEndOfTurn: true } : {}),
					...(pcp.grantedAbilityText ? { grantedAbilityText: pcp.grantedAbilityText } : {}),
					// --- End Track P10 ---
					...(stubRestrictions.length > 0 ? { activationRestrictions: stubRestrictions } : {}),
					...(pcp.freezesSelfUntap ? { freezesSelfUntap: true } : {})
				} as EffectiveActivatedAbility)
			: undefined;
	const chosenColor = pcp.chosenColor;
	const chosenBundle = pcp.chosenBundle;
	const amount = pcp.amount ?? 0;
	const tappedSource = pcp.parts.some((part) => part.def.k === 'tapSelf');
	resetTriggerLoopTracking(state);
	H().resolveActivatedManaAbility(
		state,
		actor,
		perm,
		abStub,
		chosenColor,
		amount,
		tappedSource,
		chosenBundle
	);
	// --- Track P22b ---
	emitEvent(state, {
		kind: 'AbilityActivated',
		playerId: actor.playerId,
		sourceId: perm.instanceId,
		source: perm,
		abilityId: pcp.abilityId,
		isManaAbility: true,
		isLoyaltyAbility: false,
		...(pcp.lifePaidCount !== undefined ? { lifePaid: pcp.lifePaidCount } : {})
	});
	// --- End Track P22b ---
	flushTriggers(state);
	if (pcp.descriptions.length > 0 || pcp.sacrificeSelfInCost) {
		const manaSummary =
			chosenBundle && chosenBundle.length > 0
				? formatManaBundle(chosenBundle)
				: chosenColor && amount > 0
					? `${amount > 1 ? `${amount}x ` : ''}{${chosenColor}}`
					: null;
		addLog(
			state,
			'rule',
			manaSummary
				? `${actor.username} activated ${card.name} for ${manaSummary}${pcp.descriptions.length > 0 ? ` (${pcp.descriptions.join('; ')})` : ''}.`
				: `${actor.username} activated ${card.name} for no mana (CR 106.5)${pcp.descriptions.length > 0 ? ` (${pcp.descriptions.join('; ')})` : ''}.`,
			actorId
		);
	}
	H().checkStateBasedActions(state);
}

export function executeOrResumePendingCostPayment(
	state: GameState,
	pcp: PendingCostPayment,
	ctx: CostContext
): { ok: true } {
	pcp.aidDescriptions ??= [];
	if (!pcp.tapsAndManaDone) {
		if (pcp.costKeyword === 'station') {
			const tapPart = pcp.parts.find(
				(pt) => !pt.isCostAid && pt.def.k === 'tapOthers' && (pt.objectIds?.length ?? 0) > 0
			);
			const tappedId = tapPart?.objectIds?.[0];
			if (tappedId) {
				const foundTapped = findPermanentOnBoard(state, tappedId);
				pcp.stationTappedId = tappedId;
				if (foundTapped) {
					pcp.stationTappedVersion = foundTapped.inst.objectVersion ?? 1;
					pcp.tappedCostPower = Math.max(0, evaluatePermanent(state, foundTapped.inst).power);
				}
			}
		}
		// --- Track P9 ---
		if (pcp.kind === 'activate_ability' && !pcp.ninjutsuAttackTarget) {
			pcp.ninjutsuAttackTarget = captureNinjutsuAttackTargetFromParts(state, pcp.parts);
		}
		// --- End Track P9 ---
		// --- Track P12 ---
		if (pcp.kind === 'cast_spell' && pcp.spellMods?.sneaked && !pcp.sneakAttackTarget) {
			pcp.sneakAttackTarget = captureNinjutsuAttackTargetFromParts(state, pcp.parts);
		}
		// --- End Track P12 ---
		payTapAndManaCostParts(ctx, pcp.parts, pcp.manaPaid ?? null, pcp.descriptions, pcp.aidDescriptions);
		pcp.tapsAndManaDone = true;
		if (ctx.spendCtx?.capturedColorsSpent) {
			pcp.manaColorsSpent = ctx.spendCtx.capturedColorsSpent;
		}
		// --- Track P13 ---
		if (ctx.spendCtx?.capturedColorsAllSpent) {
			pcp.manaColorsAllSpent = ctx.spendCtx.capturedColorsAllSpent;
		}
		// --- End Track P13 ---
		if (ctx.spendCtx?.spentManaGrantsUncounterable) {
			pcp.cantBeCounteredByMana = true;
		}
		if (ctx.spendCtx?.spentManaCommanderBonusCounters) {
			pcp.opalPalaceBonusCounters =
				(pcp.opalPalaceBonusCounters ?? 0) + ctx.spendCtx.spentManaCommanderBonusCounters;
		}
		// --- Track P10 ---
		if (ctx.spendCtx?.capturedManaSpentCount) {
			pcp.manaSpentCount = ctx.spendCtx.capturedManaSpentCount;
		}
		// --- End Track P10 ---
		// --- Track P15 ---
		if (ctx.spendCtx?.capturedPhyrexianLifePaidCount) {
			pcp.phyrexianLifePaidCount = ctx.spendCtx.capturedPhyrexianLifePaidCount;
		}
		// --- End Track P15 ---
	}
	// --- Track P19a (CR 707.10, CR 608.2h): Capture sacrificed-cost LKI across payment & resume ---
	ctx.sacrificedLkiOut = (pcp.sacrificedCostLki ??= []);
	// --- End Track P19a ---
	const paid = executeCostPaymentParts(
		ctx,
		pcp.parts,
		pcp.nextPartIndex,
		pcp.nextObjectIndex,
		pcp.descriptions,
		pcp.costKeyword,
		pcp.aidDescriptions
	);
	if (paid.paused) {
		pcp.nextPartIndex = paid.nextPartIndex ?? pcp.nextPartIndex;
		pcp.nextObjectIndex = paid.nextObjectIndex ?? pcp.nextObjectIndex;
		state.pendingCostPayment = pcp;
		flushTriggers(state);
		return { ok: true };
	}
	// --- Track P22b ---
	const paidExtra = paid as typeof paid & {
		lifePaidCount?: number;
		chosenSubTypeCost?: string;
		chosenNumberCost?: number;
		chosenKeywordCost?: string;
		beheldOrChosenPower?: number;
		beheldOrChosenCard?: ScryfallCard;
		repeatableManaPaidCount?: number;
		exiledCostCards?: ScryfallCard[];
	};
	if (paidExtra.lifePaidCount !== undefined) {
		pcp.lifePaidCount = (pcp.lifePaidCount ?? 0) + paidExtra.lifePaidCount;
	}
	if (paidExtra.chosenSubTypeCost !== undefined) pcp.chosenSubTypeCost = paidExtra.chosenSubTypeCost;
	if (paidExtra.chosenNumberCost !== undefined) pcp.chosenNumberCost = paidExtra.chosenNumberCost;
	if (paidExtra.chosenKeywordCost !== undefined) pcp.chosenKeywordCost = paidExtra.chosenKeywordCost;
	if (paidExtra.beheldOrChosenPower !== undefined) pcp.beheldOrChosenPower = paidExtra.beheldOrChosenPower;
	if (paidExtra.beheldOrChosenCard !== undefined) pcp.beheldOrChosenCard = paidExtra.beheldOrChosenCard;
	if (paidExtra.repeatableManaPaidCount !== undefined) {
		pcp.repeatableManaPaidCount = paidExtra.repeatableManaPaidCount;
	}
	if (paidExtra.exiledCostCards?.length) pcp.exiledCostCards = paidExtra.exiledCostCards;
	// --- End Track P22b ---
	delete state.pendingCostPayment;
	const actor = ctx.player;
	if (pcp.kind === 'cast_spell') {
		const sourcePlayer =
			state.players.find((p) => p.playerId === pcp.sourcePlayerId) ?? actor;
		const sourceZone = pcp.sourceZone ?? 'hand';
		const inst = sourcePlayer[sourceZone].find(
			(c) => c.instanceId === pcp.sourceInstanceId
		);
		if (inst) {
			finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, {
				targets: pcp.targets ?? [],
				targetsBySpec: pcp.targetsBySpec,
				// --- Track P7 ---
				targetDivisions: pcp.targetDivisions,
				// --- End Track P7 ---
				chosenModes: pcp.chosenModes,
				xValue: pcp.xValue ?? 0,
				castOptionId: pcp.castOptionId,
				faceIndex: pcp.faceIndex,
				fused: pcp.fused,
				// --- Track P12 ---
				spellMods:
					pcp.sneakAttackTarget && pcp.spellMods
						? { ...pcp.spellMods, sneakAttackTarget: pcp.sneakAttackTarget }
						: pcp.spellMods,
				// --- End Track P12 ---
				optionalCostCounts: pcp.optionalCostCounts,
				exSourceName: pcp.exSourceName,
				descriptions: pcp.descriptions,
				aidDescriptions: pcp.aidDescriptions,
				additionalIncomplete: pcp.additionalIncomplete,
				manaColorsSpent: pcp.manaColorsSpent,
				// --- Track P13 ---
				manaColorsAllSpent: pcp.manaColorsAllSpent,
				// --- End Track P13 ---
				cantBeCounteredByMana: pcp.cantBeCounteredByMana,
				opalPalaceBonusCounters: pcp.opalPalaceBonusCounters,
				// --- Track P10 ---
				manaSpentCount: pcp.manaSpentCount,
				// --- End Track P10 ---
				// --- Track P14 ---
				staticPlaySlotKey: pcp.staticPlaySlotKey,
				// --- End Track P14 ---
				// --- Track P15 ---
				phyrexianLifePaidCount: pcp.phyrexianLifePaidCount,
				giftRecipientId: pcp.giftRecipientId,
				// --- End Track P15 ---
				// --- Track P19a ---
				sacrificedCostLki: pcp.sacrificedCostLki,
				// --- End Track P19a ---
				// --- Track P20b ---
				...(pcp.removedCounterCount !== undefined
					? { removedCounterCount: pcp.removedCounterCount }
					: {}),
				// --- End Track P20b ---
				// --- Track P22b ---
				chosenSubTypeCost: pcp.chosenSubTypeCost,
				chosenNumberCost: pcp.chosenNumberCost,
				chosenKeywordCost: pcp.chosenKeywordCost,
				beheldOrChosenPower: pcp.beheldOrChosenPower,
				beheldOrChosenCard: pcp.beheldOrChosenCard,
				repeatableManaPaidCount: pcp.repeatableManaPaidCount,
				exiledCostCards: pcp.exiledCostCards
				// --- End Track P22b ---
			});
		}
	} else if (pcp.kind === 'activate_ability') {
		finalizeActivateAbility(state, actor, pcp);
	} else if (pcp.kind === 'turn_face_up') {
		H().finalizeTurnFaceUp(state, actor, pcp);
	} else if (pcp.kind === 'hand_special_action') {
		H().finalizeHandSpecialAction(state, actor, pcp);
	} else {
		finalizeTapMana(state, actor, pcp);
	}
	return { ok: true };
}

export function resumePendingCostPayment(state: GameState): void {
	const pcp = state.pendingCostPayment;
	if (!pcp) return;
	const actor = state.players.find((p) => p.playerId === pcp.actorId);
	if (!actor) {
		delete state.pendingCostPayment;
		return;
	}
	const source = resolveCostSourceCard(state, pcp);
	const spendCtx: ManaSpendContext =
		pcp.kind === 'cast_spell'
			? spellSpendContext(source, {
					faceIndex: pcp.faceIndex,
					fused: pcp.fused,
					isFaceDown: Boolean(pcp.spellMods?.castFaceDown),
					// --- Track P20b ---
					state,
					xValue: pcp.xValue ?? 0
					// --- End Track P20b ---
				})
			: // --- Track P10 & P20b ---
				pcp.kind === 'activate_ability'
				? activatedAbilitySpendContext(
						state,
						source,
						{ id: pcp.abilityId, faceIndex: pcp.faceIndex },
						pcp.xValue ?? 0
					)
				: pcp.kind === 'hand_special_action' && pcp.specialActionId === 'special:foretell'
					? { isSpell: false, isForetellAction: true }
					: // --- End Track P10 & P20b ---
						{ isSpell: false };
	const reservedIds =
		pcp.kind === 'hand_special_action' ? new Set<string>([pcp.sourceInstanceId]) : undefined;
	const ctx = costContext(
		state,
		actor,
		source,
		pcp.xValue ?? 0,
		pcp.kind === 'cast_spell',
		pcp.manaPaid ?? null,
		undefined,
		spendCtx,
		reservedIds
	);
	executeOrResumePendingCostPayment(state, pcp, ctx);
}

/**
 * A cost needs the player's choice. Humans get a `cost_choice` prompt holding the action, which is
 * run again with the answer; bots must send their choices (ai.ts), so for them it's an error.
 */
export function askCostChoice(
	state: GameState,
	actor: PlayerGameState,
	action: GameActionPayload,
	question: CostQuestion,
	sourceName: string
): { ok: boolean; error?: string } {
	if (actor.isBot) {
		return { ok: false, error: `A cost choice is required to pay for ${sourceName}.` };
	}
	const zone =
		question.kind === 'objects'
			? inferObjectsZone(actor, question.candidateIds, state)
			: 'battlefield';
	const choice = buildCostChoiceRequest(question, zone);
	state.pendingPrompts.push({
		id: uid('prm', state),
		playerId: actor.playerId,
		kind: 'cost_choice',
		purpose: 'cost_choice',
		title: `Pay the cost of ${sourceName}`,
		description:
			question.kind === 'option'
				? question.optional
					? 'This cost is optional. Pay it?'
					: 'Choose which cost to pay.'
				: question.minTotal !== undefined
					? `Choose any number with total ${question.metric ?? 'power'} ${question.minTotal}+: ${question.label}.`
					: `Choose ${question.count}: ${question.label}.`,
		choice,
		cancellable: true,
		yesLabel:
			question.kind === 'option' && question.optional
				? question.labels[0] || 'Pay Cost'
				: undefined,
		noLabel: question.kind === 'option' && question.optional ? "Don't Pay" : undefined,
		countRequired: question.kind === 'objects' ? question.count : undefined,
		candidateInstanceIds: question.kind === 'objects' ? question.candidateIds : undefined,
		costQuestion: { kind: question.kind, index: question.index },
		costOptionLabels: question.kind === 'option' ? question.labels : undefined,
		pendingAction: action
	});
	return { ok: true };
}

// --- Track P7 ---
export function isAbilityActivationConditionMet(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	cond: Condition
): boolean {
	// --- Track P15 ---
	const p15Res = evaluateP15Condition(cond, state, actorId, { source: perm });
	if (p15Res !== null) return p15Res;
	// --- End Track P15 ---
	if (
		cond.k === 'creatureDiedThisTurn' ||
		cond.k === 'attackedThisTurn' ||
		cond.k === 'permanentLeftBattlefieldThisTurn' ||
		cond.k === 'gainedLifeThisTurn' ||
		cond.k === 'wasCast'
	) {
		return evaluateP7Condition(state, cond, actorId, { sourceObj: perm });
	}
	return evaluateCondition(cond, { state, controllerId: actorId, source: perm });
}

export function evaluateSpecDivideTotal(
	state: GameState,
	actorId: string,
	spec: TargetSpec,
	sourceInst: CardInstance | undefined,
	xValue: number
): number | undefined {
	if (!spec.divideTotal) return undefined;
	if (spec.divideTotal.k === 'const') return spec.divideTotal.n;
	if (spec.divideTotal.k === 'x') return Math.max(0, Math.floor(xValue));
	return Math.max(
		0,
		evaluateAmount(spec.divideTotal, {
			state,
			controllerId: actorId,
			source: sourceInst,
			xValue
		})
	);
}

export function resolveTargetDivisionsForSpecs(
	state: GameState,
	actorId: string,
	specs: readonly TargetSpec[] | undefined,
	targets: readonly TargetRef[],
	targetsBySpec: readonly (readonly TargetRef[])[] | undefined,
	sourceCard: ScryfallCard | undefined,
	sourceInstanceId: string | undefined,
	xValue: number,
	providedDivisions: Record<string, number> | undefined
): { ok: true; targetDivisions?: Record<string, number> } | { ok: false; error: string } {
	if (!specs || !specs.some((sp) => Boolean(sp.divideTotal))) {
		return { ok: true };
	}
	const sourceInst = sourceInstanceId ? findCardAnywhere(state, sourceInstanceId)?.inst : undefined;
	const dividedSpecsCount = specs.filter((sp) => Boolean(sp.divideTotal)).length;
	const combined: Record<string, number> = {};
	for (let k = 0; k < specs.length; k++) {
		const spec = specs[k];
		if (!spec.divideTotal) continue;
		const total = evaluateSpecDivideTotal(state, actorId, spec, sourceInst, xValue) ?? 0;
		const specTargets = targetsBySpec ? (targetsBySpec[k] ?? []) : targets;
		const specIds = specTargets.map((t) => t.id);
		let providedForSpec: Record<string, number> | undefined;
		if (providedDivisions !== undefined) {
			if (dividedSpecsCount === 1) {
				providedForSpec = providedDivisions;
			} else {
				providedForSpec = {};
				const specIdSet = new Set(specIds);
				for (const [id, amt] of Object.entries(providedDivisions)) {
					if (specIdSet.has(id)) providedForSpec[id] = amt;
				}
			}
		}
		const res = validateAndNormalizeTargetDivisions(
			specTargets,
			total,
			providedForSpec,
			spec.min,
			spec.max,
			sourceCard?.name || 'Spell or ability'
		);
		if (!res.ok) return res;
		Object.assign(combined, res.divisions);
	}
	return {
		ok: true,
		...(Object.keys(combined).length > 0 ? { targetDivisions: combined } : {})
	};
}
// --- End Track P7 ---

export function checkActivationRestrictionsOnly(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	ab: EffectiveActivatedAbility
): { ok: boolean; error?: string } {
	if (
		ab.activationCondition &&
		// --- Track P7 ---
		!isAbilityActivationConditionMet(state, actorId, perm, ab.activationCondition)
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
	// --- Track P15: Power-up, Craft, Reconfigure, Transfigure, Aura swap, activatorWho ---
	if (ab.activatorWho === 'opponent' && actorId === perm.controllerId) {
		return {
			ok: false,
			error: `${perm.card.name}: Only an opponent may activate this ability (CR 602.2).`
		};
	}
	const actorObj = state.players.find((p) => p.playerId === actorId);
	if (
		actorObj &&
		(ab.costKeyword === 'power-up' ||
			ab.costKeyword === 'craft' ||
			ab.costKeyword === 'reconfigure' ||
			ab.costKeyword === 'transfigure' ||
			ab.costKeyword === 'aura swap')
	) {
		const w5Err = checkWave5AbilityActivation(state, actorObj, perm, ab.id, ab.costKeyword);
		if (w5Err) return { ok: false, error: w5Err };
		// --- Track P21: Craft with two that share a card type (CR 702.167) ---
		if (
			ab.costKeyword === 'craft' &&
			selectCraftShareCardTypeMaterials(state, actorObj, perm) === null
		) {
			return {
				ok: false,
				error: `${perm.card.name}: Requires two other permanents you control and/or cards in your graveyard that share a card type to Craft (CR 702.167).`
			};
		}
		// --- End Track P21 ---
	}
	// --- End Track P15 ---
	const restrictions = ab.activationRestrictions;
	if (!restrictions?.length) return { ok: true };
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
	const activePlayer = state.players[state.activePlayerIndex];
	if (restrictions.includes('onceEachTurn') && perm.activatedAbilityIdsThisTurn?.includes(ab.id)) {
		return {
			ok: false,
			error: `${perm.card.name}: This ability can only be activated once each turn.`
		};
	}
	// --- Track P15 ---
	if (restrictions.includes('oncePerGame') && perm.usedOncePerGameAbilityIds?.includes(ab.id)) {
		return {
			ok: false,
			error: `${perm.card.name}: This ability can only be activated once per game.`
		};
	}
	if (restrictions.includes('beforeAttackers')) {
		const preAtkPhases: GamePhase[] = ['upkeep', 'draw', 'main1', 'begin_combat'];
		if (!preAtkPhases.includes(state.phase)) {
			return {
				ok: false,
				error: `${perm.card.name}: Activate only before attackers are declared.`
			};
		}
	}
	// --- End Track P15 ---
	if (restrictions.includes('duringYourTurn') && activePlayer?.playerId !== actorId) {
		return {
			ok: false,
			error: `${perm.card.name}: This ability can only be activated during your turn.`
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
	for (const r of restrictions) {
		if (
			r === 'duringOpponentsTurn' ||
			r === 'afterAttackers' ||
			r === 'beforeBlockers' ||
			r === 'duringBlockers' ||
			r === 'afterBlockers' ||
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
	return { ok: true };
}
